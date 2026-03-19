'use strict';

/**
 * core/parallel-build.js - Worker pool orchestration for parallel indexing
 *
 * Splits files into N chunks, spawns worker threads to parse them in parallel,
 * then merges results into the ProjectIndex. Uses Atomics.wait + MessageChannel
 * to keep the build() API synchronous.
 */

const os = require('os');
const path = require('path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');

/**
 * Build index in parallel using worker threads.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string[]} files - Files to index
 * @param {object} options
 * @param {number} [options.workerCount] - Number of workers (auto-detect if omitted)
 * @param {boolean} [options.quiet] - Suppress output
 * @returns {number|false} Number of changed files, or false if too few workers
 */
function parallelBuild(index, files, options = {}) {
    const availableCpus = (typeof os.availableParallelism === 'function')
        ? os.availableParallelism()
        : os.cpus().length;
    const autoWorkers = Math.max(availableCpus - 1, 1);
    const maxWorkers = (options.workerCount > 0) ? options.workerCount : autoWorkers;
    const workerCount = Math.min(
        maxWorkers,
        8,
        Math.ceil(files.length / 100) // at least 100 files per worker
    );

    if (workerCount < 2) return false;

    if (!options.quiet) {
        console.error(`Parallel build: ${workerCount} workers for ${files.length} files`);
    }

    // Prepare existing hash data for skip-if-unchanged checks in workers
    const existingHashes = Object.create(null);
    for (const [fp, entry] of index.files) {
        existingHashes[fp] = { mtime: entry.mtime, size: entry.size, hash: entry.hash };
    }

    // Partition files round-robin for balanced work distribution
    const chunks = Array.from({ length: workerCount }, () => []);
    for (let i = 0; i < files.length; i++) {
        chunks[i % workerCount].push(files[i]);
    }

    // Synchronization: one Int32 per worker in SharedArrayBuffer
    const sab = new SharedArrayBuffer(4 * workerCount);
    const signal = new Int32Array(sab);

    const ports = [];
    const workers = [];

    for (let i = 0; i < workerCount; i++) {
        const { port1, port2 } = new MessageChannel();
        ports.push(port1);

        const worker = new Worker(path.join(__dirname, 'build-worker.js'), {
            workerData: {
                files: chunks[i],
                rootDir: index.root,
                existingHashes,
                signal: sab,
                workerIndex: i,
                port: port2,
            },
            transferList: [port2],
        });
        workers.push(worker);
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

    // Collect and merge results from each worker
    let changed = 0;

    for (let i = 0; i < workerCount; i++) {
        const msg = receiveMessageOnPort(ports[i]);
        ports[i].close();
        if (!msg) continue;

        for (const result of msg.message) {
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

    // Terminate workers
    for (const w of workers) {
        w.terminate();
    }

    return changed;
}

module.exports = { parallelBuild };
