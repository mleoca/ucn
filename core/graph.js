/**
 * core/graph.js — Graph and file-dependency analysis
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

'use strict';

const path = require('path');
const { extractImports, resolveImport } = require('./imports');
const { langTraits } = require('../languages');
const { isTestFile } = require('./discovery');

/**
 * Resolve imports in a file
 * @param {object} index - ProjectIndex instance
 * @param {string} filePath - File to analyze
 * @returns {Array} Resolved imports
 */
function imports(index, filePath) {
    const resolved = index.resolveFilePathForQuery(filePath);
    if (typeof resolved !== 'string') return resolved;

    const normalizedPath = resolved;
    const fileEntry = index.files.get(normalizedPath);
    if (!fileEntry) {
        return { error: 'file-not-found', filePath };
    }

    try {
        const content = index._readFile(normalizedPath);
        const { imports: rawImports } = extractImports(content, fileEntry.language);

        const contentLines = content.split('\n');

        return rawImports.map(imp => {
            // Skip imports with null module (e.g. Rust include! with dynamic path)
            if (!imp.module) {
                return {
                    module: null,
                    names: imp.names,
                    type: imp.type,
                    resolved: null,
                    isExternal: false,
                    isDynamic: true,
                    line: null
                };
            }

            // Dynamic imports with variable path (e.g. require(varName), import(varExpr)) can't be resolved.
            // Only JS/TS require()/import() with dynamic=true has unresolvable paths.
            // Go side-effect/dot imports and Rust glob uses also set dynamic=true but have valid module paths.
            const isUnresolvableDynamic = imp.dynamic && (imp.type === 'require' || imp.type === 'dynamic');
            if (isUnresolvableDynamic) {
                let line = null;
                for (let i = 0; i < contentLines.length; i++) {
                    if (contentLines[i].includes(imp.module || 'require')) {
                        line = i + 1;
                        break;
                    }
                }
                return {
                    module: imp.module,
                    names: imp.names,
                    type: imp.type,
                    resolved: null,
                    isExternal: false,
                    isDynamic: true,
                    line
                };
            }

            let resolvedPath = resolveImport(imp.module, normalizedPath, {
                aliases: index.config.aliases,
                language: fileEntry.language,
                root: index.root
            });

            // Java package imports: resolve by progressive suffix matching
            // Handles regular, static (com.pkg.Class.method), and wildcard (com.pkg.Class.*) imports
            if (!resolvedPath && fileEntry.language === 'java' && !imp.module.startsWith('.')) {
                resolvedPath = index._resolveJavaPackageImport(imp.module);
            }

            // Find line number of import
            let line = null;
            for (let i = 0; i < contentLines.length; i++) {
                if (contentLines[i].includes(imp.module)) {
                    line = i + 1;
                    break;
                }
            }

            return {
                module: imp.module,
                names: imp.names,
                type: imp.type,
                resolved: resolvedPath ? path.relative(index.root, resolvedPath) : null,
                isExternal: !resolvedPath,
                isDynamic: false,
                line
            };
        });
    } catch (e) {
        return [];
    }
}

/**
 * Get files that import a given file
 * @param {object} index - ProjectIndex instance
 * @param {string} filePath - File to check
 * @returns {Array} Files that import this file
 */
function exporters(index, filePath) {
    const resolved = index.resolveFilePathForQuery(filePath);
    if (typeof resolved !== 'string') return resolved;

    const targetPath = resolved;

    const importers = index.exportGraph.get(targetPath) || [];

    return importers.map(importerPath => {
        const fileEntry = index.files.get(importerPath);

        // Find the import line
        let importLine = null;
        try {
            const content = index._readFile(importerPath);
            const lines = content.split('\n');
            let targetBasename = path.basename(targetPath, path.extname(targetPath));

            // For __init__.py, search for the package name (parent dir)
            // e.g., "from tools import X" → search for "tools" not "__init__"
            if (targetBasename === '__init__') {
                targetBasename = path.basename(path.dirname(targetPath));
            }

            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(targetBasename) &&
                    (lines[i].includes('import') || lines[i].includes('require') || lines[i].includes('from'))) {
                    importLine = i + 1;
                    break;
                }
            }
        } catch (e) {
            // Skip
        }

        return {
            file: fileEntry ? fileEntry.relativePath : path.relative(index.root, importerPath),
            importLine
        };
    });
}

/**
 * Get exports for a specific file
 * @param {object} index - ProjectIndex instance
 * @param {string} filePath - File path
 * @param {Set} [_visited] - Internal visited set for re-export recursion
 * @returns {Array} Exported symbols from that file
 */
function fileExports(index, filePath, _visited) {
    const resolved = index.resolveFilePathForQuery(filePath);
    if (typeof resolved !== 'string') return resolved;

    const absPath = resolved;
    const visited = _visited || new Set();
    if (visited.has(absPath)) return [];
    visited.add(absPath);

    const fileEntry = index.files.get(absPath);
    if (!fileEntry) {
        return [];
    }

    const results = [];
    const exportedNames = new Set(fileEntry.exports);

    for (const symbol of fileEntry.symbols) {
        const isExported = exportedNames.has(symbol.name) ||
            (symbol.modifiers && symbol.modifiers.includes('export')) ||
            (symbol.modifiers && symbol.modifiers.includes('public')) ||
            (langTraits(fileEntry.language)?.exportVisibility === 'capitalization' && /^[A-Z]/.test(symbol.name));

        if (isExported) {
            results.push({
                name: symbol.name,
                type: symbol.type,
                file: fileEntry.relativePath,
                startLine: symbol.startLine,
                endLine: symbol.endLine,
                params: symbol.params,
                returnType: symbol.returnType,
                signature: index.formatSignature(symbol)
            });
        }
    }

    // Add variable exports (export const/let/var) not matched to symbols
    if (fileEntry.exportDetails) {
        const matchedNames = new Set(results.map(r => r.name));
        for (const exp of fileEntry.exportDetails) {
            if (exp.isVariable && !matchedNames.has(exp.name)) {
                const sig = `${exp.declKind} ${exp.name}${exp.typeAnnotation ? ': ' + exp.typeAnnotation : ''}`;
                results.push({
                    name: exp.name,
                    type: 'variable',
                    file: fileEntry.relativePath,
                    startLine: exp.line,
                    endLine: exp.line,
                    params: undefined,
                    returnType: exp.typeAnnotation || null,
                    signature: sig
                });
            }
        }

        // Add re-exports: export { X } from './module'
        // Resolve to the source file and look up the symbol there
        for (const exp of fileEntry.exportDetails) {
            if ((exp.type === 're-export' || exp.type === 're-export-all') && exp.source && !matchedNames.has(exp.name)) {
                const resolvedSrc = resolveImport(exp.source, absPath, {
                    language: fileEntry.language,
                    root: index.root,
                    extensions: index.extensions
                });
                if (resolvedSrc) {
                    const sourceEntry = index.files.get(resolvedSrc);
                    if (sourceEntry) {
                        // For star re-exports, include all exported symbols from source
                        if (exp.type === 're-export-all') {
                            const sourceExportsResult = fileExports(index, resolvedSrc, visited);
                            for (const srcExp of sourceExportsResult) {
                                if (!matchedNames.has(srcExp.name)) {
                                    matchedNames.add(srcExp.name);
                                    results.push({ ...srcExp, file: fileEntry.relativePath, reExportedFrom: srcExp.file });
                                }
                            }
                        } else {
                            // Named re-export: find the specific symbol
                            const srcSymbol = sourceEntry.symbols.find(s => s.name === exp.name);
                            if (srcSymbol) {
                                matchedNames.add(exp.name);
                                results.push({
                                    name: exp.name,
                                    type: srcSymbol.type,
                                    file: fileEntry.relativePath,
                                    startLine: exp.line,
                                    endLine: exp.line,
                                    params: srcSymbol.params,
                                    returnType: srcSymbol.returnType,
                                    signature: index.formatSignature(srcSymbol),
                                    reExportedFrom: sourceEntry.relativePath
                                });
                            } else {
                                // Symbol not found in source — still list it as a re-export
                                matchedNames.add(exp.name);
                                results.push({
                                    name: exp.name,
                                    type: 're-export',
                                    file: fileEntry.relativePath,
                                    startLine: exp.line,
                                    endLine: exp.line,
                                    params: undefined,
                                    returnType: null,
                                    signature: `re-export ${exp.name} from '${exp.source}'`,
                                    reExportedFrom: sourceEntry.relativePath
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // Python __all__ re-exports: names listed in __all__ that come from imports
    // e.g. __init__.py: `from .utils import helper` + `__all__ = ["helper"]`
    // `helper` is in fileEntry.exports but not in fileEntry.symbols
    if (fileEntry.language === 'python' && fileEntry.exports.length > 0) {
        const matchedNames = new Set(results.map(r => r.name));
        const unmatched = fileEntry.exports.filter(name => !matchedNames.has(name));
        if (unmatched.length > 0) {
            // Re-extract raw imports to get name→module mapping (not stored in fileEntry)
            try {
                const content = index._readFile(absPath);
                const { imports: rawImports } = extractImports(content, 'python');
                // Build name→module map from raw imports
                const nameToModule = new Map();
                for (const imp of rawImports) {
                    if (imp.names) {
                        for (const name of imp.names) {
                            if (name !== '*') nameToModule.set(name, imp.module);
                        }
                    }
                }
                for (const name of unmatched) {
                    const sourceModule = nameToModule.get(name);
                    if (!sourceModule) continue;
                    const resolvedSrc = resolveImport(sourceModule, absPath, {
                        language: 'python',
                        root: index.root,
                        extensions: index.extensions
                    });
                    if (!resolvedSrc) continue;
                    const sourceEntry = index.files.get(resolvedSrc);
                    const srcSymbol = sourceEntry && sourceEntry.symbols.find(s => s.name === name);
                    if (srcSymbol) {
                        matchedNames.add(name);
                        results.push({
                            name,
                            type: srcSymbol.type,
                            file: fileEntry.relativePath,
                            startLine: srcSymbol.startLine,
                            endLine: srcSymbol.endLine,
                            params: srcSymbol.params,
                            returnType: srcSymbol.returnType,
                            signature: index.formatSignature(srcSymbol),
                            reExportedFrom: sourceEntry.relativePath
                        });
                    } else {
                        // Source not indexed or symbol not found — still list it
                        matchedNames.add(name);
                        results.push({
                            name,
                            type: 're-export',
                            file: fileEntry.relativePath,
                            startLine: undefined,
                            endLine: undefined,
                            params: undefined,
                            returnType: null,
                            signature: `re-export ${name} from '${sourceModule}'`,
                            reExportedFrom: resolvedSrc
                                ? (sourceEntry ? sourceEntry.relativePath : resolvedSrc)
                                : sourceModule
                        });
                    }
                }
            } catch (_) {
                // File read failure — skip Python re-export resolution
            }
        }
    }

    return results;
}

/**
 * Get all exported/public symbols
 * @param {object} index - ProjectIndex instance
 * @param {string} [filePath] - Optional file to limit to
 * @param {object} [options] - { includeTests }
 * @returns {Array} Exported symbols
 */
function api(index, filePath, options = {}) {
    const results = [];

    let fileIterator;
    if (filePath) {
        // Try exact resolution first
        const resolved = index.resolveFilePathForQuery(filePath);
        if (typeof resolved === 'string') {
            const fileEntry = index.files.get(resolved);
            if (!fileEntry) return { error: 'file-not-found', filePath };
            fileIterator = [[resolved, fileEntry]];
        } else {
            // Fall back to pattern filter (substring match on relative path)
            const matches = [];
            for (const [absPath, fe] of index.files) {
                if (fe.relativePath.includes(filePath)) {
                    matches.push([absPath, fe]);
                }
            }
            if (matches.length === 0) return { error: 'file-not-found', filePath };
            fileIterator = matches;
        }
    } else {
        fileIterator = index.files.entries();
    }

    for (const [, fileEntry] of fileIterator) {
        if (!fileEntry) continue;

        // Skip test files by default (test classes aren't part of public API)
        if (!options.includeTests && isTestFile(fileEntry.relativePath, fileEntry.language)) {
            continue;
        }

        const exportedNames = new Set(fileEntry.exports);

        for (const symbol of fileEntry.symbols) {
            const isExported = exportedNames.has(symbol.name) ||
                (symbol.modifiers && symbol.modifiers.includes('export')) ||
                (symbol.modifiers && symbol.modifiers.includes('public')) ||
                (langTraits(fileEntry.language)?.exportVisibility === 'capitalization' && /^[A-Z]/.test(symbol.name));

            if (isExported) {
                results.push({
                    name: symbol.name,
                    type: symbol.type,
                    file: fileEntry.relativePath,
                    startLine: symbol.startLine,
                    endLine: symbol.endLine,
                    params: symbol.params,
                    returnType: symbol.returnType,
                    signature: index.formatSignature(symbol)
                });
            }
        }

        // Add variable exports (export const/let/var) not matched to symbols
        if (fileEntry.exportDetails) {
            const matchedNames = new Set(results.filter(r => r.file === fileEntry.relativePath).map(r => r.name));
            for (const exp of fileEntry.exportDetails) {
                if (exp.isVariable && !matchedNames.has(exp.name)) {
                    const sig = `${exp.declKind} ${exp.name}${exp.typeAnnotation ? ': ' + exp.typeAnnotation : ''}`;
                    results.push({
                        name: exp.name,
                        type: 'variable',
                        file: fileEntry.relativePath,
                        startLine: exp.line,
                        endLine: exp.line,
                        params: undefined,
                        returnType: exp.typeAnnotation || null,
                        signature: sig
                    });
                }
            }
        }
    }

    return results;
}

/**
 * Get dependency graph for a file
 * @param {object} index - ProjectIndex instance
 * @param {string} filePath - Starting file
 * @param {object} options - { direction: 'imports' | 'importers' | 'both', maxDepth }
 * @returns {object} - Graph structure with root, nodes, edges
 */
function graph(index, filePath, options = {}) {
    const direction = options.direction || 'both';
    // Sanitize depth: use default for null/undefined, clamp negative to 0
    const rawDepth = options.maxDepth ?? 5;
    const maxDepth = Math.max(0, rawDepth);

    const resolved = index.resolveFilePathForQuery(filePath);
    if (typeof resolved !== 'string') return resolved;

    const targetPath = resolved;

    const buildSubgraph = (dir) => {
        const visited = new Set();
        const nodes = [];
        const edges = [];

        const traverse = (file, depth) => {
            if (visited.has(file)) return;
            visited.add(file);

            const fileEntry = index.files.get(file);
            const relPath = fileEntry ? fileEntry.relativePath : path.relative(index.root, file);
            nodes.push({ file, relativePath: relPath, depth });

            // Stop traversal at max depth but still register the node above
            if (depth >= maxDepth) return;

            const neighbors = dir === 'imports'
                ? (index.importGraph.get(file) || [])
                : (index.exportGraph.get(file) || []);

            // Deduplicate neighbors (same file may be imported multiple times, e.g. Java inner classes)
            const uniqueNeighbors = [...new Set(neighbors)];

            for (const neighbor of uniqueNeighbors) {
                edges.push({ from: file, to: neighbor });
                traverse(neighbor, depth + 1);
            }
        };

        traverse(targetPath, 0);
        return { nodes, edges };
    };

    if (direction === 'both') {
        // Build separate sub-graphs for imports and importers
        const importsGraph = buildSubgraph('imports');
        const importersGraph = buildSubgraph('importers');

        return {
            root: targetPath,
            direction: 'both',
            imports: { nodes: importsGraph.nodes, edges: importsGraph.edges },
            importers: { nodes: importersGraph.nodes, edges: importersGraph.edges },
            // Keep combined for backward compat
            nodes: [...importsGraph.nodes, ...importersGraph.nodes.filter(n =>
                !importsGraph.nodes.some(in_ => in_.file === n.file))],
            edges: [...importsGraph.edges, ...importersGraph.edges]
        };
    }

    const subgraph = buildSubgraph(direction);
    return {
        root: targetPath,
        direction,
        nodes: subgraph.nodes,
        edges: subgraph.edges
    };
}

/**
 * Detect circular dependencies in the import graph.
 * Uses DFS with 3-color marking to find all cycles.
 * @param {object} index - ProjectIndex instance
 * @param {object} options - { file, exclude }
 * @returns {object} - { cycles, totalFiles, summary }
 */
function circularDeps(index, options = {}) {
    index._beginOp();
    try {
        const exclude = options.exclude || [];
        const fileFilter = options.file || null;

        const WHITE = 0, GRAY = 1, BLACK = 2;
        const color = new Map();
        const cycles = [];
        const stack = [];

        const shouldSkip = (file) => {
            if (!index.files.has(file)) return true;
            if (exclude.length > 0) {
                const entry = index.files.get(file);
                if (entry && !index.matchesFilters(entry.relativePath, { exclude })) return true;
            }
            return false;
        };

        const dfs = (file) => {
            color.set(file, GRAY);
            stack.push(file);

            const neighbors = [...new Set(index.importGraph.get(file) || [])];

            for (const neighbor of neighbors) {
                if (neighbor === file) continue;  // Skip self-imports (not a cycle)
                if (shouldSkip(neighbor)) continue;
                const nc = color.get(neighbor) || WHITE;
                if (nc === GRAY) {
                    const idx = stack.indexOf(neighbor);
                    cycles.push(stack.slice(idx));
                } else if (nc === WHITE) {
                    dfs(neighbor);
                }
            }

            stack.pop();
            color.set(file, BLACK);
        };

        for (const file of index.files.keys()) {
            if ((color.get(file) || WHITE) === WHITE && !shouldSkip(file)) {
                dfs(file);
            }
        }

        // Convert to relative paths and deduplicate
        const seen = new Set();
        const uniqueCycles = [];
        for (const cycle of cycles) {
            const relCycle = cycle.map(f => index.files.get(f)?.relativePath || path.relative(index.root, f));
            // Normalize: rotate so lexicographically smallest file is first
            const sorted = relCycle.slice().sort();
            const minIdx = relCycle.indexOf(sorted[0]);
            const rotated = [...relCycle.slice(minIdx), ...relCycle.slice(0, minIdx)];
            const key = rotated.join('\0');
            if (!seen.has(key)) {
                seen.add(key);
                uniqueCycles.push({ files: rotated, length: rotated.length });
            }
        }

        // Filter by file pattern
        let result = uniqueCycles;
        if (fileFilter) {
            result = uniqueCycles.filter(c => c.files.some(f => f.includes(fileFilter)));
        }

        result.sort((a, b) => a.length - b.length || a.files[0].localeCompare(b.files[0]));

        // Count files that participate in import graph (have edges)
        let filesWithImports = 0;
        for (const [, targets] of index.importGraph) {
            if (targets && targets.length > 0) filesWithImports++;
        }

        return {
            cycles: result,
            totalFiles: index.files.size,
            filesWithImports,
            fileFilter: fileFilter || undefined,
            summary: {
                totalCycles: result.length,
                filesInCycles: new Set(result.flatMap(c => c.files)).size,
            }
        };
    } finally {
        index._endOp();
    }
}

module.exports = { imports, exporters, fileExports, api, graph, circularDeps };
