/**
 * core/cache.js - Index persistence (save/load/staleness detection)
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { expandGlob, detectProjectPattern, parseGitignore, DEFAULT_IGNORES } = require('./discovery');

// Read UCN version for cache invalidation
const UCN_VERSION = require('../package.json').version;

// Index/calls cache format version — bump when the persisted call-record or
// symbol shape changes (saveCache writes it; loadCache rejects anything else).
// v14: Go qualified composite literals (pkg.Foo{...}) record the package
// qualifier as `receiver` (fix #206).
// v15: Go/Rust/Java calls record assignedTo (+assignedTuple/assignedUnwrap)
// for nominal return-type flow; Java declared-type locals feed receiverType
// (fix #207).
// v16: Rust/Go type-alias symbols record aliasOf (fix #208 — alias-qualified
// receivers are the aliased type); Go `type A = B` aliases now indexed.
// v17: TS type-alias symbols record aliasOf (fix #208 TS parity — alias-
// annotated receivers validate against the aliased type).
// v18: Go callback references carry localShadow (fix #203 Go parity —
// func-literal params and block locals shadow bare-identifier references).
const CACHE_FORMAT_VERSION = 18;

/**
 * Save index to cache file
 * @param {object} index - ProjectIndex instance
 * @param {string} [cachePath] - Optional custom cache path
 * @returns {string} - Path to cache file
 */
function saveCache(index, cachePath) {
    const cacheDir = cachePath
        ? path.dirname(cachePath)
        : path.join(index.root, '.ucn-cache');

    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    const cacheFile = cachePath || path.join(cacheDir, 'index.json');

    // Prepare callsCache for serialization (exclude content, use relative paths)
    const callsCacheData = [];
    for (const [filePath, entry] of index.callsCache) {
        callsCacheData.push([path.relative(index.root, filePath), {
            mtime: entry.mtime,
            hash: entry.hash,
            calls: entry.calls
            // content is not persisted - will be read on demand
        }]);
    }

    // Hash config to detect when graph rebuild is needed on load
    const configHash = crypto.createHash('md5')
        .update(JSON.stringify(index.config || {})).digest('hex');

    // Strip redundant fields from symbols and file entries to reduce cache size.
    // v6: All paths stored as relative paths (saves ~60% on large codebases).
    // symbol.file = path.join(root, symbol.relativePath) — reconstructable
    // symbol.bindingId = relativePath:type:startLine — reconstructable
    // fileEntry.path = Map key — redundant
    // fileEntry.relativePath = now the Map key — redundant
    const root = index.root;
    const strippedSymbols = [];
    for (const [name, defs] of index.symbols) {
        const stripped = defs.map(s => {
            const { file, bindingId, ...rest } = s;
            return rest;
        });
        strippedSymbols.push([name, stripped]);
    }
    // Files: use relativePath as key, strip path, relativePath, symbols, and bindings from entries.
    // symbols/bindings are already stored in the top-level symbols map — no need to duplicate.
    const strippedFiles = [];
    for (const [, entry] of index.files) {
        const { path: _p, relativePath: rp, symbols: _s, bindings: _b, ...rest } = entry;
        strippedFiles.push([rp, rest]);
    }

    // Convert graph paths from absolute to relative (Sets serialized as arrays)
    const relGraph = (graph) => {
        const result = [];
        for (const [absKey, absValues] of graph) {
            const relKey = path.relative(root, absKey);
            const relValues = [...absValues].map(v => path.relative(root, v));
            result.push([relKey, relValues]);
        }
        return result;
    };

    // calleeIndex is NOT persisted in index.json — it's rebuilt lazily from callsCache
    // on first findCallers/buildCalleeIndex call. Removing it saves ~22MB (14%) on large projects.

    // PERF-1: persist _reachableSymbols if computed. Set keys are
    // "absolutePath:line"; we strip the root prefix on save and re-attach on
    // load so paths stay portable. Sorted for stable output ordering.
    //
    // Also save a fingerprint so we can detect index drift on load: if the
    // saved fingerprint matches the loaded index state, the cached set is
    // still valid. If the index was rebuilt after load (stale cache → build),
    // the fingerprint won't match and computeReachability will recompute.
    let reachableSymbolsRel = undefined;
    let reachableFingerprint = undefined;
    if (index._reachableSymbols && index._reachableSymbols.size > 0) {
        const rels = [];
        for (const k of index._reachableSymbols) {
            const colon = k.lastIndexOf(':');
            if (colon < 0) continue;
            const absFile = k.slice(0, colon);
            const lineStr = k.slice(colon + 1);
            const relFile = path.relative(root, absFile);
            rels.push(`${relFile}:${lineStr}`);
        }
        rels.sort();  // stable ordering — output contract
        reachableSymbolsRel = rels;
        reachableFingerprint = _computeReachabilityFingerprint(index);
    }

    const cacheData = {
        // v10: persist _reachableSymbols set (computed by entrypoints.computeReachability)
        // v11: fix #202 — calls carry receiverRoot/receiverField/receiverRootType,
        //      Java classes emit field members with fieldType (stale shapes would
        //      silently disable declared-field receiver typing)
        // v12: fix #203 — callback references carry localShadow (lexical-scope
        //      shadowing computed parser-side)
        // v13: fix #205 — Python/Go/Rust/Java calls carry argCount (+argSpread
        //      where the language has call-site spread); Java calls carry
        //      argKinds for overload discipline (stale shapes would silently
        //      disable arity pruning)
        version: CACHE_FORMAT_VERSION,
        ucnVersion: UCN_VERSION,  // Invalidate cache when UCN is updated
        configHash,
        root,
        // PERF-2: refresh buildTime on each save so partial rebuilds report
        // accurate stats. Falls back to original on first save.
        buildTime: index.buildTime,
        timestamp: Date.now(),
        files: strippedFiles,
        symbols: strippedSymbols,
        importGraph: relGraph(index.importGraph),
        exportGraph: relGraph(index.exportGraph),
        // extendsGraph/extendedByGraph use class names as keys (not file paths)
        extendsGraph: Array.from(index.extendsGraph.entries()),
        extendedByGraph: Array.from(index.extendedByGraph.entries()),
        failedFiles: index.failedFiles
            ? Array.from(index.failedFiles).map(f => path.relative(root, f))
            : [],
        ...(reachableSymbolsRel !== undefined && {
            reachableSymbols: reachableSymbolsRel,
            reachableFingerprint,
        }),
    };

    // PERF-3: atomic write — tmp file + rename so concurrent readers/writers
    // never see a torn JSON. The calls/ shard write below already does this.
    const tmpFile = cacheFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(cacheData));
    fs.renameSync(tmpFile, cacheFile);

    // MED-1 (Round 5): clear the reachabilityDirty flag now that the set is
    // safely persisted. The cli/index.js cache-save guard checks this flag
    // along with needsCacheSave/callsCacheDirty.
    if (index.reachabilityDirty) {
        index.reachabilityDirty = false;
    }

    // Save callsCache sharded by directory for lazy loading.
    // Write to a temp directory first, then atomic swap to avoid data loss on crash.
    if (callsCacheData.length > 0) {
        const cacheDir = path.dirname(cacheFile);
        const callsDir = path.join(cacheDir, 'calls');
        const callsTmpDir = path.join(cacheDir, 'calls.tmp');

        // Clean up any leftover temp dir from a previous crashed save
        if (fs.existsSync(callsTmpDir)) {
            fs.rmSync(callsTmpDir, { recursive: true, force: true });
        }
        fs.mkdirSync(callsTmpDir, { recursive: true });

        // Group by directory
        const shards = new Map();
        for (const [relPath, entry] of callsCacheData) {
            const dir = path.dirname(relPath) || '.';
            if (!shards.has(dir)) shards.set(dir, []);
            shards.get(dir).push([relPath, entry]);
        }

        // Write all shards to temp directory
        const shardManifest = [];
        for (const [dir, entries] of shards) {
            const hash = crypto.createHash('md5').update(dir).digest('hex').slice(0, 10);
            const shardFile = path.join(callsTmpDir, `${hash}.json`);
            fs.writeFileSync(shardFile, JSON.stringify(entries));
            shardManifest.push([dir, hash, entries.length]);
        }

        // Write manifest to temp directory
        fs.writeFileSync(path.join(callsTmpDir, 'manifest.json'), JSON.stringify(shardManifest));

        // Atomic swap: remove old, rename temp to final
        if (fs.existsSync(callsDir)) {
            fs.rmSync(callsDir, { recursive: true, force: true });
        }
        fs.renameSync(callsTmpDir, callsDir);

        // Clean up legacy monolithic file
        const legacyFile = path.join(cacheDir, 'calls-cache.json');
        if (fs.existsSync(legacyFile)) {
            fs.rmSync(legacyFile, { force: true });
        }
    }

    return cacheFile;
}

/**
 * Load index from cache file
 * @param {object} index - ProjectIndex instance
 * @param {string} [cachePath] - Optional custom cache path
 * @returns {boolean} - True if loaded successfully
 */
function loadCache(index, cachePath) {
    const cacheFile = cachePath || path.join(index.root, '.ucn-cache', 'index.json');

    if (!fs.existsSync(cacheFile)) {
        return false;
    }

    try {
        const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

        // Check version compatibility
        // v7: symbols/bindings stripped from file entries (dedup)
        // v9: addSymbol propagates isAsync/isGenerator/paramTypes (force rebuild for old)
        // v10: persists _reachableSymbols set
        if (cacheData.version !== CACHE_FORMAT_VERSION) {
            return false;
        }

        // Invalidate cache when UCN version changes (logic may have changed)
        if (cacheData.ucnVersion !== UCN_VERSION) {
            return false;
        }

        // Validate cache structure has required fields
        if (!Array.isArray(cacheData.files) ||
            !Array.isArray(cacheData.symbols) ||
            !Array.isArray(cacheData.importGraph) ||
            !Array.isArray(cacheData.exportGraph)) {
            return false;
        }

        const root = cacheData.root || index.root;
        // Fast path conversion: string concat is ~70x faster than path.join for
        // cache-stored relative paths (no '..' segments). On Windows, path.relative
        // produces backslash paths, so rootPrefix uses the native separator.
        const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
        const toAbs = path.sep === '/'
            ? (relPath) => rootPrefix + relPath
            : (relPath) => rootPrefix + relPath.replace(/\//g, path.sep);

        // Reconstruct files Map: relative key → absolute key, restore path and relativePath
        // Initialize symbols/bindings arrays (will be populated from top-level symbols)
        index.files = new Map();
        for (const [relPath, entry] of cacheData.files) {
            const absPath = toAbs(relPath);
            entry.path = absPath;
            entry.relativePath = relPath;
            if (!entry.symbols) entry.symbols = [];
            if (!entry.bindings) entry.bindings = [];
            index.files.set(absPath, entry);
        }

        // Reconstruct symbols: restore file and bindingId from relativePath
        // Also rebuild fileEntry.symbols and fileEntry.bindings from top-level data
        index.symbols = new Map(cacheData.symbols);
        for (const [, defs] of index.symbols) {
            for (const s of defs) {
                if (!s.file && s.relativePath) s.file = toAbs(s.relativePath);
                if (!s.bindingId && s.relativePath && s.type && s.startLine) {
                    s.bindingId = `${s.relativePath}:${s.type}:${s.startLine}`;
                }
                // Rebuild fileEntry.symbols and bindings from top-level symbols
                const fileEntry = index.files.get(s.file);
                if (fileEntry) {
                    fileEntry.symbols.push(s);
                    fileEntry.bindings.push({
                        id: s.bindingId,
                        name: s.name,
                        type: s.type,
                        startLine: s.startLine
                    });
                }
            }
        }

        // Reconstruct graphs: relative paths → absolute paths (as Sets)
        // Uses string concat (toAbs) instead of path.join — 70x faster on 464K edges
        const absGraph = (data) => {
            const m = new Map();
            for (const [relKey, relValues] of data) {
                const absValues = new Set();
                for (const v of relValues) absValues.add(toAbs(v));
                m.set(toAbs(relKey), absValues);
            }
            return m;
        };
        index.importGraph = absGraph(cacheData.importGraph);
        index.exportGraph = absGraph(cacheData.exportGraph);
        index.buildTime = cacheData.buildTime;

        // Restore optional graphs if present
        // extendsGraph/extendedByGraph use class names as keys (not file paths)
        if (Array.isArray(cacheData.extendsGraph)) {
            index.extendsGraph = new Map(cacheData.extendsGraph);
        }
        if (Array.isArray(cacheData.extendedByGraph)) {
            index.extendedByGraph = new Map(cacheData.extendedByGraph);
        }

        // Prepare lazy calls cache loading — load manifest but defer shard parsing.
        // Shards are loaded on first getCachedCalls access via ensureCallsCacheLoaded().
        if (index.callsCache.size === 0) {
            _prepareCallsCache(index);
        }

        // Build directory→files index from loaded data
        if (typeof index._buildDirIndex === 'function') {
            index._buildDirIndex();
        }

        // Restore failedFiles if present (convert relative paths back to absolute)
        if (Array.isArray(cacheData.failedFiles)) {
            index.failedFiles = new Set(
                cacheData.failedFiles.map(f => path.isAbsolute(f) ? f : toAbs(f))
            );
        }

        // Restore calleeIndex if persisted (v7 caches only; v8+ rebuilds lazily)
        if (Array.isArray(cacheData.calleeIndex)) {
            index.calleeIndex = new Map();
            for (const [name, files] of cacheData.calleeIndex) {
                if (!Array.isArray(files)) continue;
                index.calleeIndex.set(name, new Set(
                    files.map(f => path.isAbsolute(f) ? f : toAbs(f))
                ));
            }
        }

        // PERF-1: restore _reachableSymbols if persisted (v10+).
        // Saved as relative-path keys; rehydrate to absolute keys here so the
        // in-memory set matches what computeReachability would produce fresh.
        // The fingerprint is checked by computeReachability before reuse — if
        // the index drifts (e.g. a rebuild after stale cache), the cached set
        // is dropped and recomputed.
        if (Array.isArray(cacheData.reachableSymbols)) {
            const reachable = new Set();
            for (const k of cacheData.reachableSymbols) {
                if (typeof k !== 'string') continue;
                const colon = k.lastIndexOf(':');
                if (colon < 0) continue;
                const relFile = k.slice(0, colon);
                const lineStr = k.slice(colon + 1);
                const absFile = path.isAbsolute(relFile) ? relFile : toAbs(relFile);
                reachable.add(`${absFile}:${lineStr}`);
            }
            index._reachableSymbols = reachable;
            if (cacheData.reachableFingerprint) {
                index._reachableFingerprint = cacheData.reachableFingerprint;
            }
        }

        // Only rebuild graphs if config changed (e.g., aliases modified)
        const currentConfigHash = crypto.createHash('md5')
            .update(JSON.stringify(index.config || {})).digest('hex');
        if (currentConfigHash !== cacheData.configHash) {
            index.buildImportGraph();
            index.buildInheritanceGraph();
        }

        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Check if cache is stale (any files changed or new files added)
 * @param {object} index - ProjectIndex instance
 * @returns {boolean} - True if cache needs rebuilding
 */
function isCacheStale(index) {
    // Ultra-fast path: skip full check if last confirmed-fresh < 2s ago (covers MCP burst calls).
    // Only uses _lastFreshAt (set at the end of a successful full check), not cache save timestamp.
    if (index._lastFreshAt && Date.now() - index._lastFreshAt < 2000) {
        return false;
    }

    // Fast path: check cached files for modifications/deletions first (stat-only).
    // This returns early without the expensive directory walk when any file changed.
    for (const [filePath, fileEntry] of index.files) {
        try {
            const stat = fs.statSync(filePath);

            // If size changed, file changed
            if (fileEntry.size !== undefined && stat.size !== fileEntry.size) {
                return true;
            }

            // If mtime matches, file hasn't changed
            if (fileEntry.mtime && stat.mtimeMs === fileEntry.mtime) {
                continue;
            }

            // mtime changed or not stored - verify with hash
            const content = fs.readFileSync(filePath, 'utf-8');
            const hash = crypto.createHash('md5').update(content).digest('hex');
            if (hash !== fileEntry.hash) {
                return true;
            }
        } catch (e) {
            return true; // File deleted or inaccessible
        }
    }

    // Slow path: glob the project to detect new files added since last build.
    // Only reached when all cached files are unchanged.
    const pattern = detectProjectPattern(index.root);
    const globOpts = { root: index.root };
    const gitignorePatterns = parseGitignore(index.root);
    const configExclude = index.config.exclude || [];
    if (gitignorePatterns.length > 0 || configExclude.length > 0) {
        globOpts.ignores = [...DEFAULT_IGNORES, ...gitignorePatterns, ...configExclude];
    }
    const currentFiles = expandGlob(pattern, globOpts);
    const cachedPaths = new Set(index.files.keys());

    for (const file of currentFiles) {
        if (!cachedPaths.has(file) && !(index.failedFiles && index.failedFiles.has(file))) {
            return true; // New file found
        }
    }

    // Record when we last confirmed the cache is fresh (enables 2s skip on burst calls)
    index._lastFreshAt = Date.now();
    return false;
}

/**
 * Prepare calls cache for lazy loading — reads manifest but defers shard parsing.
 * Called during loadCache() to set up the manifest without the ~1s shard parse cost.
 * Actual shards are loaded on first ensureCallsCacheLoaded() call.
 * @param {object} index - ProjectIndex instance
 */
function _prepareCallsCache(index) {
    if (index._callsCacheLoaded) return;
    const cacheDir = path.join(index.root, '.ucn-cache');
    const manifestFile = path.join(cacheDir, 'calls', 'manifest.json');
    if (fs.existsSync(manifestFile)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
            index._callsManifest = new Map();
            for (const [dir, hash, count] of manifest) {
                index._callsManifest.set(dir, { hash, count, loaded: false });
            }
            index._callsCachePrepared = true;
            return;
        } catch (e) {
            // Corrupted manifest — fall through
        }
    }
    // Check legacy format
    const legacyFile = path.join(cacheDir, 'calls-cache.json');
    if (fs.existsSync(legacyFile)) {
        index._callsCacheLegacyFile = legacyFile;
        index._callsCachePrepared = true;
    }
}

/**
 * Load callsCache from separate file on demand.
 * Only loads if callsCache is empty (not already populated from inline or prior load).
 * @param {object} index - ProjectIndex instance
 * @returns {boolean} - True if loaded successfully
 */
function loadCallsCache(index) {
    if (index.callsCache.size > 0) return true; // Already populated
    if (index._callsCacheLoaded) return false;   // Already attempted, file didn't exist
    index._callsCacheLoaded = true;

    // If manifest was prepared lazily, load all shards now
    if (index._callsManifest) {
        for (const [, { hash }] of index._callsManifest) {
            _loadCallsShard(index, hash);
        }
        return index.callsCache.size > 0;
    }

    // Legacy format: single calls-cache.json
    const callsCacheFile = index._callsCacheLegacyFile ||
        path.join(index.root, '.ucn-cache', 'calls-cache.json');
    if (!fs.existsSync(callsCacheFile)) return false;

    try {
        const data = JSON.parse(fs.readFileSync(callsCacheFile, 'utf-8'));
        if (Array.isArray(data)) {
            const absData = data.map(([relPath, entry]) => {
                const absPath = path.isAbsolute(relPath) ? relPath : path.join(index.root, relPath);
                return [absPath, entry];
            });
            index.callsCache = new Map(absData);
            return true;
        }
    } catch (e) {
        // Corrupted file — ignore
    }
    return false;
}

/**
 * Ensure calls cache is fully loaded (trigger lazy load if prepared but not loaded).
 * Call this before any operation that needs callsCache (findCallers, buildCalleeIndex, etc.)
 * @param {object} index - ProjectIndex instance
 */
function ensureCallsCacheLoaded(index) {
    if (index._callsCachePrepared && !index._callsCacheLoaded) {
        loadCallsCache(index);
    }
}

/**
 * Load a single calls shard by hash.
 * @param {object} index - ProjectIndex instance
 * @param {string} hash - Shard hash from manifest
 */
function _loadCallsShard(index, hash) {
    const shardFile = path.join(index.root, '.ucn-cache', 'calls', `${hash}.json`);
    try {
        const data = JSON.parse(fs.readFileSync(shardFile, 'utf-8'));
        if (!Array.isArray(data)) return;
        const rootPrefix = index.root.endsWith(path.sep) ? index.root : index.root + path.sep;
        const toAbsShard = path.sep === '/'
            ? (rp) => rootPrefix + rp
            : (rp) => rootPrefix + rp.replace(/\//g, path.sep);
        for (const [relPath, entry] of data) {
            if (!relPath || !entry) continue;
            const absPath = path.isAbsolute(relPath) ? relPath : toAbsShard(relPath);
            index.callsCache.set(absPath, entry);
        }
    } catch (e) {
        // Corrupted shard — skip
    }
}

/**
 * Compute a cheap fingerprint of the index used to detect drift since the
 * last reachability computation. Two states with the same fingerprint are
 * indistinguishable for reachability purposes (file count + symbol count are
 * monotonic with structural changes; an extra `entries[0]` byte detects most
 * incremental rebuilds even when counts happen to match).
 *
 * Used by entrypoints.computeReachability to decide whether the persisted
 * `_reachableSymbols` set is still valid.
 *
 * @param {object} index - ProjectIndex instance
 * @returns {string} compact fingerprint
 */
function _computeReachabilityFingerprint(index) {
    const fileCount = index.files ? index.files.size : 0;
    const symbolCount = index.symbols ? index.symbols.size : 0;
    // Sample a tiny prefix of the symbol map for a cheap structural check.
    // Map iteration order is insertion order, which is stable across an
    // unmodified load (built from cacheData.symbols in the same order).
    let sample = '';
    if (index.symbols && index.symbols.size > 0) {
        let count = 0;
        for (const [name, defs] of index.symbols) {
            sample += name + ':' + (Array.isArray(defs) ? defs.length : 0) + '|';
            if (++count >= 8) break;
        }
    }
    return `${fileCount}:${symbolCount}:${sample}`;
}

module.exports = {
    saveCache, loadCache, loadCallsCache, isCacheStale, ensureCallsCacheLoaded,
    _computeReachabilityFingerprint, CACHE_FORMAT_VERSION,
};
