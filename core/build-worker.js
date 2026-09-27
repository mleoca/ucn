'use strict';

/**
 * core/build-worker.js - Worker thread for parallel index building
 *
 * Claims files from a shared queue, parses each file, extracts symbols and
 * calls, then sends results back to the main thread via MessagePort.
 * Mirrors the indexFile() logic in project.js.
 */

// Reuse V8 code caches across processes (Node >= 22.1; fix #365): compiling
// the engine's modules is a fixed cost of every command. Node validates each
// entry against the source, and NODE_DISABLE_COMPILE_CACHE turns it off.
try { require('module').enableCompileCache?.(); } catch (_) { /* optional */ }

const { workerData, receiveMessageOnPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { detectLanguage, getParser, getLanguageAdapter } = require('../languages');
const { validateFileIR } = require('./ir');
const { createFileEntryFromIR, populateFileEntryFromIR } = require('./index-ir');

const { files, rootDir, existingHashes, signal, workerIndex, queueIndex, port, control, dictionarySignal } = workerData;
const { contextFor } = require('./external-macros');
// The main thread computes the macro dictionary while the workers parse
// (fix #396) and posts it before raising the signal. A file waits for it
// only when its recovery consults it.
let macroDictionary = workerData.macroDictionary || null;
let dictionaryPending = !!dictionarySignal;
function awaitDictionary() {
    if (dictionaryPending) {
        Atomics.wait(new Int32Array(dictionarySignal), 0, 0);
        macroDictionary = receiveMessageOnPort(port)?.message?.macroDictionary || null;
        dictionaryPending = false;
    }
    return macroDictionary;
}
const EMPTY_MACROS = new Map();
function externalMacrosFor(language) {
    if (!dictionaryPending) return macroDictionary ? contextFor(macroDictionary, language) : null;
    if (!getLanguageAdapter(language)?.traits?.textualIncludes) return null;
    let resolved;
    const resolve = () => {
        if (resolved === undefined) {
            const dictionary = awaitDictionary();
            resolved = dictionary ? contextFor(dictionary, language) : null;
        }
        return resolved;
    };
    // Every build's files share one dictionary, so one key serves this
    // worker's tree cache.
    return {
        key: 'build',
        consulted: new Set(),
        get objectBodies() { return resolve()?.objectBodies || EMPTY_MACROS; },
        get functionMacros() { return resolve()?.functionMacros || EMPTY_MACROS; },
    };
}
const signalArray = new Int32Array(signal);

function processFile(filePath) {
    const stat = fs.statSync(filePath);
    const existing = existingHashes[filePath];

    // Fast path: skip when mtime+size both match
    if (existing && existing.mtime === stat.mtimeMs && existing.size === stat.size) {
        return { filePath, skipped: true };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const hash = crypto.createHash('md5').update(content).digest('hex');

    // Content-based skip: mtime changed but content didn't (touch, git checkout)
    if (existing && existing.hash === hash) {
        return { filePath, skipped: true, mtimeUpdate: stat.mtimeMs, sizeUpdate: stat.size };
    }

    const language = detectLanguage(filePath, rootDir);
    if (!language) return { filePath, skipped: true };

    // One adapter analysis produces the complete, validated file IR consumed
    // by both worker and sequential builds.
    const adapter = getLanguageAdapter(language);
    const parser = getParser(language);
    // C/C++: the project macro dictionary (fix #396), as indexFile reads it.
    const externalMacros = externalMacrosFor(language);
    const ir = adapter.analyze(content, parser, filePath, externalMacros ? { externalMacros } : undefined);
    const irFailures = validateFileIR(ir);
    if (irFailures.length > 0) {
        throw new Error(`Invalid ${language} IR: ${irFailures.join('; ')}`);
    }

    // Detect bundled/minified files (same logic as indexFile in project.js)
    let lineCount = 1, longLineCount = 0, lineStart = 0;
    for (let ci = 0; ci < content.length; ci++) {
        if (content.charCodeAt(ci) === 10) {
            if (ci - lineStart > 1000) longLineCount++;
            lineStart = ci + 1;
            lineCount++;
        }
    }
    if (content.length - lineStart > 1000) longLineCount++;
    // A trailing newline TERMINATES the last line rather than opening a new
    // one; an empty file has 0 lines (fix #251 — adjusted in indexFile only,
    // so parallel-built stats reported +1 line per newline-terminated file).
    if (content.length === 0) lineCount = 0;
    else if (content.charCodeAt(content.length - 1) === 10) lineCount--;

    const isBundled = (
        content.includes('__webpack_require__') || content.includes('__webpack_modules__') ||
        (lineCount > 0 && lineCount < 50 && content.length / lineCount > 500) ||
        (lineCount > 0 && longLineCount > 0 && longLineCount / lineCount > 0.3)
    );

    const isGenerated = /^\/\/\s*Code generated\b|^\/\/\s*DO NOT EDIT|^\/\/ @generated|^# Generated by/m.test(
        content.slice(0, 500)
    );

    const relativePath = path.relative(rootDir, filePath);

    const fileEntry = createFileEntryFromIR({
        ir,
        filePath,
        relativePath,
        hash,
        mtime: stat.mtimeMs,
        size: stat.size,
        lineCount,
        isBundled,
        isGenerated,
    });
    populateFileEntryFromIR(fileEntry, ir);

    return {
        filePath,
        fileEntry,
        calls: ir.calls,
        callsMtime: stat.mtimeMs,
        callsHash: hash,
        hadExisting: !!existing,
    };
}

// Process all files
(async () => {
try {
    for (;;) {
        const next = Atomics.add(signalArray, queueIndex, 1);
        if (next >= files.length) break;
        const filePath = files[next];
        let result;
        try {
            result = processFile(filePath);
        } catch (e) {
            result = { filePath, error: e.message };
        }
        port.postMessage([result]);
        // Yield between files so native-tree finalizers of the previous
        // file's garbage run while the build continues (fix #365): a worker
        // that never returns to its event loop keeps every tree it parsed
        // alive until it exits, and with no idle workers the peaks coincide.
        await new Promise(resolve => setImmediate(resolve));
    }
    // The dictionary message is consumed before any later job on the port.
    awaitDictionary();
    Atomics.store(signalArray, workerIndex, 1);
    Atomics.notify(signalArray, workerIndex);
} catch (e) {
    // Worker-level error: signal completion (2 = not reusable).
    try { port.postMessage([]); port.close(); } catch (_) { /* ignore */ }
    Atomics.store(signalArray, workerIndex, 2);
    Atomics.notify(signalArray, workerIndex);
    return;
}
// A worker kept for the build's next phase (fix #388) waits for its job:
// Rust macro expansion, run with this thread's already optimized parser.
if (control) {
    const controlArray = new Int32Array(control);
    Atomics.wait(controlArray, workerIndex, 0);
    if (Atomics.load(controlArray, workerIndex) === 2) {
        const job = receiveMessageOnPort(port)?.message;
        if (job) require('./rust-macro-expansion').runExpansionQueue(job, port);
    }
}
try { port.close(); } catch (_) { /* closed */ }
})();
