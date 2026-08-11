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

function partitionFiles(index, files, workerCount) {
    const chunks = Array.from({ length: workerCount }, () => ({
        files: [], bytes: 0,
    }));
    const weightedFiles = files.map((file, order) => {
        let bytes = index.files.get(file)?.size;
        if (!Number.isFinite(bytes)) {
            try { bytes = fs.statSync(file).size; } catch (_) { bytes = 0; }
        }
        return { file, bytes, order };
    }).sort((a, b) => b.bytes - a.bytes || a.order - b.order);
    for (const weighted of weightedFiles) {
        let target = chunks[0];
        for (let i = 1; i < chunks.length; i++) {
            if (chunks[i].bytes < target.bytes) target = chunks[i];
        }
        target.files.push(weighted.file);
        target.bytes += weighted.bytes;
    }
    return chunks;
}

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
    const workerCap = options.maxWorkers > 0 ? options.maxWorkers : 8;
    const minFilesPerWorker = options.minFilesPerWorker > 0
        ? options.minFilesPerWorker : 100;
    const workerCount = Math.min(
        maxWorkers,
        workerCap,
        Math.ceil(files.length / minFilesPerWorker)
    );

    if (workerCount < 2) return false;

    if (!options.quiet) {
        console.error(`Parallel build: ${workerCount} workers for ${files.length} files`);
    }

    // Parsing cost is driven much more by source size than file count. A
    // round-robin split can put several giant generated/template headers in
    // one worker while peers finish tiny files, making the whole build wait
    // on one straggler and retaining multiple large native ASTs together.
    // Longest-processing-time scheduling by byte size is deterministic and
    // gives a substantially tighter upper bound on both wall time and peak
    // memory. Canonical index ordering after the merge remains unchanged.
    const chunks = partitionFiles(index, files, workerCount);

    // Synchronization: one Int32 per worker in SharedArrayBuffer
    const sab = new SharedArrayBuffer(4 * workerCount);
    const signal = new Int32Array(sab);

    const ports = [];
    const workers = [];

    for (let i = 0; i < workerCount; i++) {
        const { port1, port2 } = new MessageChannel();
        ports.push(port1);

        // Build per-worker hash subset (each worker only needs hashes for its chunk)
        const workerHashes = Object.create(null);
        for (const fp of chunks[i].files) {
            const entry = index.files.get(fp);
            if (entry) {
                workerHashes[fp] = { mtime: entry.mtime, size: entry.size, hash: entry.hash };
            }
        }

        const worker = new Worker(path.join(__dirname, 'build-worker.js'), {
            workerData: {
                files: chunks[i].files,
                rootDir: index.root,
                existingHashes: workerHashes,
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

module.exports = { parallelBuild, partitionFiles };
