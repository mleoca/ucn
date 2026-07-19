/**
 * eval/oracles/rust-analyzer-oracle.js - Rust oracle via rust-analyzer (LSP).
 *
 * Same architecture as the gopls/pyright oracles: symbol enumeration +
 * reference CLASSIFICATION come from an independent ast helper
 * (rust-ast-helper, a tiny syn-based crate — no UCN parser involved),
 * reference RESOLUTION comes from rust-analyzer textDocument/references
 * rooted at the cargo WORKSPACE root (ripgrep is a workspace; r-a needs
 * cargo metadata from the root to resolve cross-crate refs).
 *
 * Readiness camp: unlike gopls (sync on first request) and pyright
 * (didOpen-all), rust-analyzer indexes asynchronously after initialize and
 * answers early requests from an incomplete index. The deterministic barrier
 * is the experimental/serverStatus notification with quiescent=true —
 * requested via the serverStatusNotification client capability.
 *
 * rust-analyzer resolution: $UCN_EVAL_RUST_ANALYZER, else PATH. Requires a
 * cargo toolchain (also builds/runs the syn helper).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { LspClient, pathToUri, uriToPath } = require('./lsp-client');
const { makeHelperHandle } = require('./jsonl-helper');

const HELPER_MANIFEST = path.join(__dirname, 'rust-ast-helper', 'Cargo.toml');
const QUIESCENT_TIMEOUT_MS = 600000; // first run executes build scripts via cargo

const rustAnalyzerOracle = {
    name: 'rust-analyzer',
    languages: ['rust'],

    async prepare(repoDir) {
        const ra = resolveRustAnalyzer();
        const workspaceRoot = findWorkspaceRoot(repoDir);

        // Build the helper up front so compile output never races the banner.
        const build = spawnSync('cargo', ['build', '--quiet', '--manifest-path', HELPER_MANIFEST], { stdio: ['ignore', 'ignore', 'inherit'] });
        if (build.status !== 0) throw new Error('rust-ast-helper build failed (cargo toolchain required)');
        const helperChild = spawn('cargo', ['run', '--quiet', '--manifest-path', HELPER_MANIFEST, '--', repoDir], {
            stdio: ['pipe', 'pipe', 'inherit'],
        });
        const helper = makeHelperHandle(helperChild, { label: 'rust ast helper' });
        const banner = JSON.parse(await helper.expectLine());
        if (!banner.ok) throw new Error(`rust ast helper failed to start: ${banner.error}`);

        let quiesced;
        const quiescent = new Promise((resolve, reject) => {
            quiesced = resolve;
            setTimeout(() => reject(new Error(`rust-analyzer not quiescent after ${QUIESCENT_TIMEOUT_MS}ms`)),
                QUIESCENT_TIMEOUT_MS).unref();
        });
        const lsp = new LspClient(ra, [], {
            capabilities: { experimental: { serverStatusNotification: true } },
            onNotification: (method, params) => {
                if (method === 'experimental/serverStatus' && params?.quiescent) quiesced(params);
            },
        });
        // Evaluate the all-source contract, not only Cargo's default feature
        // projection. Otherwise valid calls under `#[cfg(feature = ...)]`
        // are mislabeled as UCN false positives merely because rust-analyzer
        // marked that source inactive in this one configuration.
        await lsp.initialize(workspaceRoot, {
            checkOnSave: false,
            cargo: { features: 'all', allTargets: true },
        });
        process.stdout.write('  waiting for rust-analyzer to load the workspace (cargo metadata + build scripts)...\n');
        const status = await quiescent;
        if (status.health && status.health !== 'ok') {
            process.stdout.write(`  ⚠ rust-analyzer health: ${status.health} ${status.message || ''}\n`);
        }
        const version = spawnSync(ra, ['--version'], { stdio: 'pipe' }).stdout?.toString().trim() || 'unknown';
        process.stdout.write(`  ${version} (workspace root ${path.relative(repoDir, workspaceRoot) || '.'})\n`);

        return { lsp, helper, root: repoDir, workspaceRoot, opened: new Set() };
    },

    /** syn-enumerated defs (fns, impl methods, structs/enums-as-class). */
    async listSymbols(handle, { kinds, limit } = {}) {
        const resp = await handle.helper.request({ op: 'list_symbols' });
        let symbols = resp.symbols || [];
        if (kinds) {
            const wanted = new Set(kinds);
            symbols = symbols.filter(s => wanted.has(s.kind));
        }
        return limit ? symbols.slice(0, limit) : symbols;
    },

    /** rust-analyzer references at the def-name position, syn-classified. */
    async findReferences(handle, { name, file, line }) {
        const pos = await handle.helper.request({ op: 'name_position', file, line, name });
        const absFile = path.join(handle.root, file);
        if (!handle.opened.has(absFile)) {
            handle.lsp.didOpen(absFile, 'rust', fs.readFileSync(absFile, 'utf-8'));
            handle.opened.add(absFile);
        }
        const locations = await handle.lsp.request('textDocument/references', {
            textDocument: { uri: pathToUri(absFile) },
            position: { line: pos.line - 1, character: pos.utf16Col },
            context: { includeDeclaration: true },
        }) || [];

        const refs = [];
        for (const loc of locations) {
            const refAbs = uriToPath(loc.uri);
            if (!refAbs.startsWith(handle.workspaceRoot + path.sep)) continue;
            const relFile = path.relative(handle.root, refAbs);
            const refLine = loc.range.start.line + 1;
            const cls = await handle.helper.request({
                op: 'classify_ref', file: relFile, line: refLine,
                utf16_col: loc.range.start.character, name,
            });
            refs.push({ file: relFile, line: refLine, kind: cls.kind });
        }
        return refs;
    },

    /** Resolve the compiler-selected declaration(s) for a source-line name.
     *  Reference search can omit inactive/re-exported workspace edges; this
     *  independent definition check prevents those gaps from becoming fake
     *  UCN precision failures. */
    async resolveDefinition(handle, { name, file, line }) {
        const absFile = path.join(handle.root, file);
        if (!handle.opened.has(absFile)) {
            handle.lsp.didOpen(absFile, 'rust', fs.readFileSync(absFile, 'utf-8'));
            handle.opened.add(absFile);
        }
        const sourceLine = fs.readFileSync(absFile, 'utf-8').split('\n')[line - 1] || '';
        const columns = nameColumns(sourceLine, name);
        const defs = new Map();
        for (const character of columns) {
            const locations = await handle.lsp.request('textDocument/definition', {
                textDocument: { uri: pathToUri(absFile) },
                position: { line: line - 1, character },
            }) || [];
            for (const loc of Array.isArray(locations) ? locations : [locations]) {
                const uri = loc.targetUri || loc.uri;
                const range = loc.targetSelectionRange || loc.targetRange || loc.range;
                if (!uri || !range) continue;
                const defAbs = uriToPath(uri);
                if (!defAbs.startsWith(handle.workspaceRoot + path.sep)) continue;
                const entry = { file: path.relative(handle.root, defAbs), line: range.start.line + 1 };
                defs.set(`${entry.file}:${entry.line}`, entry);
            }
        }
        return [...defs.values()];
    },

    /** Whether this source line belongs to an explicitly cfg-gated AST owner.
     *  rust-analyzer evaluates one target/feature/platform projection at a
     *  time; unresolved calls in another valid projection are coverage gaps,
     *  not evidence that UCN invented an edge. */
    async isConfigurationGated(handle, { file, line }) {
        const status = await handle.helper.request({ op: 'source_status', file, line });
        return !!status.configurationGated;
    },

    /** Graceful teardown — without LSP shutdown r-a prints a panic backtrace on exit. */
    async dispose(handle) {
        try { handle.helper.child.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n'); } catch (e) { /* gone */ }
        try {
            await handle.lsp.request('shutdown');
            handle.lsp.notify('exit');
        } catch (e) { /* gone */ }
    },
};

function nameColumns(line, name) {
    const cols = [];
    for (let from = 0; from <= line.length - name.length;) {
        const at = line.indexOf(name, from);
        if (at < 0) break;
        const before = at === 0 ? '' : line[at - 1];
        const after = line[at + name.length] || '';
        if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) cols.push(at);
        from = at + name.length;
    }
    return cols;
}

function resolveRustAnalyzer() {
    const explicit = process.env.UCN_EVAL_RUST_ANALYZER;
    if (explicit) return explicit;
    if (spawnSync('rust-analyzer', ['--version'], { stdio: 'pipe' }).status === 0) return 'rust-analyzer';
    throw new Error('rust-analyzer not found — brew install rust-analyzer / rustup component add rust-analyzer, or set UCN_EVAL_RUST_ANALYZER');
}

/** Nearest ancestor Cargo.toml with [workspace], else the nearest Cargo.toml. */
function findWorkspaceRoot(dir) {
    let nearestManifest = null;
    let current = dir;
    for (let i = 0; i < 8; i++) {
        const manifest = path.join(current, 'Cargo.toml');
        if (fs.existsSync(manifest)) {
            if (!nearestManifest) nearestManifest = current;
            if (/^\s*\[workspace\]/m.test(fs.readFileSync(manifest, 'utf-8'))) return current;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return nearestManifest || dir;
}

module.exports = { rustAnalyzerOracle };
