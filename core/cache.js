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

    // Convert graph paths from absolute to relative
    const relGraph = (graph) => {
        const result = [];
        for (const [absKey, absValues] of graph) {
            const relKey = path.relative(root, absKey);
            const relValues = absValues.map(v => path.relative(root, v));
            result.push([relKey, relValues]);
        }
        return result;
    };

    // Persist calleeIndex if built (paths must be absolute from this.files keys)
    let calleeIndexData;
    if (index.calleeIndex && index.calleeIndex.size > 0) {
        calleeIndexData = [];
        for (const [name, files] of index.calleeIndex) {
            const relFiles = [...files].map(f =>
                path.isAbsolute(f) ? path.relative(root, f) : f
            );
            calleeIndexData.push([name, relFiles]);
        }
    }

    const cacheData = {
        version: 7,  // v7: strip symbols/bindings from file entries (dedup ~45% cache reduction)
        ucnVersion: UCN_VERSION,  // Invalidate cache when UCN is updated
        configHash,
        root,
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
        ...(calleeIndexData && { calleeIndex: calleeIndexData })
    };

    fs.writeFileSync(cacheFile, JSON.stringify(cacheData));

    // Save callsCache sharded by directory for lazy loading
    if (callsCacheData.length > 0) {
        const callsDir = path.join(path.dirname(cacheFile), 'calls');
        // Clean up old shards and legacy monolithic file
        if (fs.existsSync(callsDir)) {
            fs.rmSync(callsDir, { recursive: true, force: true });
        }
        const legacyFile = path.join(path.dirname(cacheFile), 'calls-cache.json');
        if (fs.existsSync(legacyFile)) {
            fs.rmSync(legacyFile, { force: true });
        }
        fs.mkdirSync(callsDir, { recursive: true });

        // Group by directory
        const shards = new Map();
        for (const [relPath, entry] of callsCacheData) {
            const dir = path.dirname(relPath) || '.';
            if (!shards.has(dir)) shards.set(dir, []);
            shards.get(dir).push([relPath, entry]);
        }

        // Write one shard per directory
        const shardManifest = [];
        for (const [dir, entries] of shards) {
            const hash = crypto.createHash('md5').update(dir).digest('hex').slice(0, 10);
            const shardFile = path.join(callsDir, `${hash}.json`);
            fs.writeFileSync(shardFile, JSON.stringify(entries));
            shardManifest.push([dir, hash, entries.length]);
        }

        // Write manifest for lazy loading
        fs.writeFileSync(path.join(callsDir, 'manifest.json'), JSON.stringify(shardManifest));
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
        if (cacheData.version !== 7) {
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

        // Reconstruct files Map: relative key → absolute key, restore path and relativePath
        // Initialize symbols/bindings arrays (will be populated from top-level symbols)
        index.files = new Map();
        for (const [relPath, entry] of cacheData.files) {
            const absPath = path.join(root, relPath);
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
                if (!s.file && s.relativePath) s.file = path.join(root, s.relativePath);
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

        // Reconstruct graphs: relative paths → absolute paths
        const absGraph = (data) => {
            const m = new Map();
            for (const [relKey, relValues] of data) {
                m.set(path.join(root, relKey), relValues.map(v => path.join(root, v)));
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

        // Eagerly load callsCache from separate file.
        // Prevents 10K cold tree-sitter re-parses (2GB+ peak) when findCallers runs.
        if (index.callsCache.size === 0) {
            loadCallsCache(index);
        }

        // Build directory→files index from loaded data
        if (typeof index._buildDirIndex === 'function') {
            index._buildDirIndex();
        }

        // Restore failedFiles if present (convert relative paths back to absolute)
        if (Array.isArray(cacheData.failedFiles)) {
            index.failedFiles = new Set(
                cacheData.failedFiles.map(f => path.isAbsolute(f) ? f : path.join(root, f))
            );
        }

        // Restore calleeIndex if persisted
        if (Array.isArray(cacheData.calleeIndex)) {
            index.calleeIndex = new Map();
            for (const [name, files] of cacheData.calleeIndex) {
                if (!Array.isArray(files)) continue;
                index.calleeIndex.set(name, new Set(
                    files.map(f => path.isAbsolute(f) ? f : path.join(root, f))
                ));
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
 * Load callsCache from separate file on demand.
 * Only loads if callsCache is empty (not already populated from inline or prior load).
 * @param {object} index - ProjectIndex instance
 * @returns {boolean} - True if loaded successfully
 */
function loadCallsCache(index) {
    if (index.callsCache.size > 0) return true; // Already populated
    if (index._callsCacheLoaded) return false;   // Already attempted, file didn't exist
    index._callsCacheLoaded = true;

    const cacheDir = path.join(index.root, '.ucn-cache');

    // Try sharded format first (calls/manifest.json)
    const manifestFile = path.join(cacheDir, 'calls', 'manifest.json');
    if (fs.existsSync(manifestFile)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
            // Store manifest for lazy loading
            index._callsManifest = new Map();
            for (const [dir, hash, count] of manifest) {
                index._callsManifest.set(dir, { hash, count, loaded: false });
            }
            // Eagerly load all shards (matches previous behavior)
            for (const [, { hash }] of index._callsManifest) {
                _loadCallsShard(index, hash);
            }
            return true;
        } catch (e) {
            // Corrupted manifest — fall through to legacy
        }
    }

    // Legacy format: single calls-cache.json
    const callsCacheFile = path.join(cacheDir, 'calls-cache.json');
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
 * Load a single calls shard by hash.
 * @param {object} index - ProjectIndex instance
 * @param {string} hash - Shard hash from manifest
 */
function _loadCallsShard(index, hash) {
    const shardFile = path.join(index.root, '.ucn-cache', 'calls', `${hash}.json`);
    try {
        const data = JSON.parse(fs.readFileSync(shardFile, 'utf-8'));
        if (!Array.isArray(data)) return;
        for (const [relPath, entry] of data) {
            if (!relPath || !entry) continue;
            const absPath = path.isAbsolute(relPath) ? relPath : path.join(index.root, relPath);
            index.callsCache.set(absPath, entry);
        }
    } catch (e) {
        // Corrupted shard — skip
    }
}

module.exports = { saveCache, loadCache, loadCallsCache, isCacheStale };
