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
    // Files: use relativePath as key, strip path and relativePath from entries
    const strippedFiles = [];
    for (const [, entry] of index.files) {
        const { path: _p, relativePath: rp, ...rest } = entry;
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

    const cacheData = {
        version: 6,  // v6: relative paths throughout (saves ~60% cache size)
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
            : []
    };

    fs.writeFileSync(cacheFile, JSON.stringify(cacheData));

    // Save callsCache to a separate file (lazy-loaded on demand)
    if (callsCacheData.length > 0) {
        const callsCacheFile = path.join(path.dirname(cacheFile), 'calls-cache.json');
        fs.writeFileSync(callsCacheFile, JSON.stringify(callsCacheData));
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
        // v6: relative paths throughout (saves ~60% cache size)
        if (cacheData.version !== 6) {
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
        index.files = new Map();
        for (const [relPath, entry] of cacheData.files) {
            const absPath = path.join(root, relPath);
            entry.path = absPath;
            entry.relativePath = relPath;
            index.files.set(absPath, entry);
        }

        // Reconstruct symbols: restore file and bindingId from relativePath
        index.symbols = new Map(cacheData.symbols);
        for (const [, defs] of index.symbols) {
            for (const s of defs) {
                if (!s.file && s.relativePath) s.file = path.join(root, s.relativePath);
                if (!s.bindingId && s.relativePath && s.type && s.startLine) {
                    s.bindingId = `${s.relativePath}:${s.type}:${s.startLine}`;
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

        // Restore failedFiles if present (convert relative paths back to absolute)
        if (Array.isArray(cacheData.failedFiles)) {
            index.failedFiles = new Set(
                cacheData.failedFiles.map(f => path.isAbsolute(f) ? f : path.join(root, f))
            );
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
    // Check for new files added to project
    // Use same ignores as build() — .gitignore + .ucn.json exclude
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

    // Check existing cached files for modifications/deletions
    for (const [filePath, fileEntry] of index.files) {
        // File deleted
        if (!fs.existsSync(filePath)) {
            return true;
        }

        // File modified - check size first, then mtime, then hash
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
            return true;
        }
    }

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

    const callsCacheFile = path.join(index.root, '.ucn-cache', 'calls-cache.json');
    if (!fs.existsSync(callsCacheFile)) return false;

    try {
        const data = JSON.parse(fs.readFileSync(callsCacheFile, 'utf-8'));
        if (Array.isArray(data)) {
            // Convert relative paths back to absolute
            const absData = data.map(([relPath, entry]) => {
                // Handle both relative (v6+) and absolute (legacy) paths
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

module.exports = { saveCache, loadCache, loadCallsCache, isCacheStale };
