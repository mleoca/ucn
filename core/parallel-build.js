'use strict';

/**
 * core/parallel-build.js - Worker pool orchestration for parallel indexing
 *
 * Splits files into N chunks, spawns worker threads to parse them in parallel,
 * then merges results into the ProjectIndex. Uses Atomics.wait + MessageChannel
 * to keep the build() API synchronous.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');

// Young-generation cap of a parse worker's heap (see parallelBuild).
const WORKER_YOUNG_GENERATION_MB = 32;

/**
 * Files in scheduling order: largest first (source size drives parse cost),
 * discovery order breaking ties. Workers pull the next file from a shared
 * counter, so a worker that drew an expensive file (a heavily recovered C++
 * header, a generated source) no longer leaves its statically assigned
 * backlog waiting while peers idle (fix #365). The first files in flight are
 * the largest ones, as with the former longest-processing-time split, which
 * keeps peak native-tree memory bounded the same way.
 */
function scheduleFiles(index, files, sizes = null) {
    return files.map((file, order) => {
        let bytes = sizes?.get(file) ?? index.files.get(file)?.size;
        if (!Number.isFinite(bytes)) {
            try { bytes = fs.statSync(file).size; } catch (_) { bytes = 0; }
        }
        return { file, bytes, order };
    }).sort((a, b) => b.bytes - a.bytes || a.order - b.order);
}

/**
 * Build index in parallel using worker threads.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string[]} files - Files to index
 * @param {object} options
 * @param {number} [options.workerCount] - Number of workers (auto-detect if omitted)
 * @param {boolean} [options.quiet] - Suppress output
 * @param {number} [options.retainWorkers] - Parse workers kept for the build's
 *   next phase (fix #388); `options.onParsed(pool)` receives them
 * @returns {number|false} Number of changed files, or false if too few workers
 */
function parallelBuild(index, files, options = {}) {
    const availableCpus = (typeof os.availableParallelism === 'function')
        ? os.availableParallelism()
        : os.cpus().length;
    const autoWorkers = Math.max(availableCpus - 1, 1);
    const maxWorkers = (options.workerCount > 0) ? options.workerCount : autoWorkers;
    const workerCap = options.maxWorkers > 0 ? options.maxWorkers : 8;
    const minFilesPerWorker = options.minFilesPerWorker > 0
        ? options.minFilesPerWorker : 100;
    const workerCount = Math.min(
        maxWorkers,
        workerCap,
        Math.ceil(files.length / minFilesPerWorker)
    );

    if (workerCount < 2) {
        index.lastBuildWorkerCount = 1;
        return false;
    }
    index.lastBuildWorkerCount = workerCount;

    if (!options.quiet) {
        console.error(`Parallel build: ${workerCount} workers for ${files.length} files`);
    }

    // Parsing cost is driven much more by source size than file count, and
    // per-file cost varies further by language and recovery work; see
    // scheduleFiles. Results merge in discovery order whatever worker parsed
    // them, and canonical index ordering after the merge is unchanged.
    const scheduled = scheduleFiles(index, files, options.sizes);
    const scheduledFiles = scheduled.map(item => item.file);

    // Synchronization: one Int32 per worker in SharedArrayBuffer, plus the
    // shared next-file counter at index workerCount.
    const sab = new SharedArrayBuffer(4 * (workerCount + 1));
    const signal = new Int32Array(sab);
    // Parse workers kept for the next phase wait on a control slot once
    // their queue is empty (fix #388): 2 = a job was posted to their port,
    // anything else = exit.
    const retainCount = Math.min(Math.max(options.retainWorkers | 0, 0), workerCount);
    const control = retainCount > 0 ? new SharedArrayBuffer(4 * workerCount) : null;

    const ports = [];
    const workers = [];
    // A dictionary given as a function (fix #396: the project's C/C++ macro
    // definitions) is computed while the workers parse and posted to them;
    // a worker waits for it only when a file's recovery consults it.
    const lazyDictionary = typeof options.macroDictionary === 'function';
    const dictionarySignal = lazyDictionary ? new SharedArrayBuffer(4) : null;

    const workerHashes = Object.create(null);
    for (const fp of scheduledFiles) {
        const entry = index.files.get(fp);
        if (entry) {
            workerHashes[fp] = { mtime: entry.mtime, size: entry.size, hash: entry.hash };
        }
    }

    for (let i = 0; i < workerCount; i++) {
        const { port1, port2 } = new MessageChannel();
        ports.push(port1);

        const worker = new Worker(path.join(__dirname, 'build-worker.js'), {
            workerData: {
                files: scheduledFiles,
                rootDir: index.root,
                existingHashes: workerHashes,
                signal: sab,
                workerIndex: i,
                queueIndex: workerCount,
                port: port2,
                control,
                macroDictionary: lazyDictionary ? null : (options.macroDictionary || null),
                dictionarySignal,
            },
            transferList: [port2],
            // Parse garbage (the native trees behind it included, which the
            // JS heap does not see) is collected by young-generation
            // scavenges; a bounded young generation collects it sooner
            // (fix #388: build peak RSS -15 to -25% on fmt, tokio, django,
            // ripgrep, clap, at equal CPU and wall within noise).
            resourceLimits: { maxYoungGenerationSizeMb: WORKER_YOUNG_GENERATION_MB },
        });
        workers.push(worker);
    }

    if (lazyDictionary) {
        let dictionary = null;
        try {
            dictionary = options.macroDictionary();
        } finally {
            for (const port of ports) port.postMessage({ macroDictionary: dictionary || null });
            const flag = new Int32Array(dictionarySignal);
            Atomics.store(flag, 0, 1);
            Atomics.notify(flag, 0);
        }
    }

    // Block main thread until all workers finish (with timeout)
    const TIMEOUT_MS = 300_000; // 5 minutes
    const deadline = Date.now() + TIMEOUT_MS;

    for (let i = 0; i < workerCount; i++) {
        while (Atomics.load(signal, i) === 0) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                for (const w of workers) w.terminate();
                throw new Error('Parallel build timed out after 5 minutes');
            }
            Atomics.wait(signal, i, 0, Math.min(remaining, 5000));
        }
    }

    // Collect results from each worker, then merge them in discovery order.
    let changed = 0;
    const discoveryOrder = new Map(files.map((file, order) => [file, order]));
    const collected = [];
    for (let i = 0; i < workerCount; i++) {
        for (let msg = receiveMessageOnPort(ports[i]); msg; msg = receiveMessageOnPort(ports[i])) {
            for (const result of msg.message) collected.push(result);
        }
    }
    // Every result is in hand: the parse workers can go, except those kept
    // for the build's next phase (fix #388: Rust macro expansion runs in
    // parse workers whose parser code is already optimized, instead of in
    // fresh threads that start cold). Only a worker that finished its queue
    // normally (signal 1) is kept.
    const controlArray = control ? new Int32Array(control) : null;
    const kept = [];
    for (let i = 0; i < workerCount; i++) {
        if (kept.length < retainCount && Atomics.load(signal, i) === 1) {
            kept.push(i);
            // A kept worker never holds the process open.
            workers[i].unref();
            continue;
        }
        if (controlArray) {
            Atomics.store(controlArray, i, 1);
            Atomics.notify(controlArray, i);
        }
        ports[i].close();
        workers[i].terminate();
    }
    if (kept.length > 0) {
        const live = new Set(kept);
        const retire = i => {
            if (!live.delete(i)) return;
            Atomics.store(controlArray, i, 1);
            Atomics.notify(controlArray, i);
            ports[i].close();
            workers[i].terminate();
        };
        options.onParsed?.({
            available: [...kept],
            ports,
            post(i, job) {
                ports[i].postMessage(job);
                Atomics.store(controlArray, i, 2);
                Atomics.notify(controlArray, i);
            },
            retire,
            dispose() {
                for (const i of [...live]) retire(i);
            },
        });
    } else {
        options.onParsed?.(null);
    }
    collected.sort((a, b) => discoveryOrder.get(a.filePath) - discoveryOrder.get(b.filePath));

    {
        for (const result of collected) {
            if (result.error) {
                index.failedFiles.add(result.filePath);
                if (!options.quiet) {
                    console.error(`  Warning: Could not index ${result.filePath}: ${result.error}`);
                }
                continue;
            }

            if (result.skipped) {
                // Update mtime/size if content matched but stat changed
                if (result.mtimeUpdate !== undefined) {
                    const existing = index.files.get(result.filePath);
                    if (existing) {
                        existing.mtime = result.mtimeUpdate;
                        existing.size = result.sizeUpdate;
                    }
                }
                index.failedFiles.delete(result.filePath);
                continue;
            }

            // Changed or new file — merge into index
            if (result.hadExisting) {
                index.removeFileSymbols(result.filePath);
            }

            const fe = result.fileEntry;

            // Register symbols in global map
            for (const symbol of fe.symbols) {
                if (!index.symbols.has(symbol.name)) {
                    index.symbols.set(symbol.name, []);
                }
                index.symbols.get(symbol.name).push(symbol);
            }

            index.files.set(result.filePath, fe);

            // Populate callsCache (avoids re-parsing in buildCalleeIndex)
            if (result.calls) {
                index.callsCache.set(result.filePath, {
                    mtime: result.callsMtime,
                    hash: result.callsHash,
                    calls: result.calls,
                });
                index.callsCacheDirty = true;
            }

            index.failedFiles.delete(result.filePath);
            changed++;
        }
    }

    return changed;
}

module.exports = { parallelBuild, scheduleFiles };
