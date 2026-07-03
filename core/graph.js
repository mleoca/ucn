/**
 * core/graph.js — Graph and file-dependency analysis
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

'use strict';

const path = require('path');
const { codeUnitCompare } = require('./shared');
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

        return rawImports.map(imp => {
            // Every parser records the import's AST line; use it directly.
            // (The old substring re-derivation matched 'os' inside 'osmosis',
            // comments, and collapsed repeated modules to the first line.)
            const line = imp.line ?? null;

            // Skip imports with null module (e.g. Rust include! with dynamic path)
            if (!imp.module) {
                return {
                    module: null,
                    names: imp.names,
                    type: imp.type,
                    resolved: null,
                    isExternal: false,
                    isDynamic: true,
                    line
                };
            }

            // Dynamic imports with variable path (e.g. require(varName), import(varExpr)) can't be resolved.
            // Only JS/TS require()/import() with dynamic=true has unresolvable paths.
            // Go side-effect/dot imports and Rust glob uses also set dynamic=true but have valid module paths.
            const isUnresolvableDynamic = imp.dynamic && (imp.type === 'require' || imp.type === 'dynamic');
            if (isUnresolvableDynamic) {
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

            return {
                module: imp.module,
                names: imp.names,
                type: imp.type,
                resolved: resolvedPath ? path.relative(index.root, resolvedPath) : null,
                isExternal: !resolvedPath,
                // A string-literal dynamic import (import('./x'), importlib.import_module("x"))
                // is still mechanically dynamic even when the path resolves —
                // `type: 'dynamic'` with `isDynamic: false` was a contradiction.
                isDynamic: imp.type === 'dynamic',
                line
            };
        });
    } catch (e) {
        return [];
    }
}

/**
 * Decide whether a symbol is exported, using evidence at the right scope:
 * the file-level export list speaks for TOP-LEVEL names only — a struct
 * field or method sharing an exported function's name is not itself exported.
 * Member symbols (className set) are judged by their OWN visibility marker:
 * export/public modifiers, Rust `pub`/`pub(crate)`, or Go capitalization.
 */
function symbolIsExported(symbol, fileEntry, exportedNames) {
    const modifiers = symbol.modifiers || [];
    if (modifiers.includes('export') || modifiers.includes('public')) return true;
    if (modifiers.some(m => typeof m === 'string' && /^pub\b/.test(m))) return true;
    if (langTraits(fileEntry.language)?.exportVisibility === 'capitalization' &&
        /^[A-Z]/.test(symbol.name || '')) return true;
    // Rust trait-impl members cannot carry `pub` (the compiler forbids it) —
    // their visibility IS the implementing type's (fix #251:
    // `impl Default for Config` methods of a pub Config are publicly
    // callable but were listed nowhere).
    if (symbol.traitImpl && symbol.className && fileEntry.language === 'rust') {
        for (const s of fileEntry.symbols || []) {
            if (s.name === symbol.className &&
                ['struct', 'enum', 'class', 'type'].includes(s.type)) {
                return (s.modifiers || []).some(m => typeof m === 'string' && /^pub\b/.test(m));
            }
        }
        return exportedNames.has(symbol.className);
    }
    if (symbol.className) return false;
    return exportedNames.has(symbol.name);
}

/**
 * Signature for export listings: members render as `Class.name(...)` so a
 * Go/Rust/Java method is distinguishable from a free function of the same name.
 */
function formatExportSignature(index, symbol) {
    if (!symbol.className) return index.formatSignature(symbol);
    return index.formatSignature({ ...symbol, name: `${symbol.className}.${symbol.name}` });
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

    const importers = index.exportGraph.get(targetPath) || new Set();
    const targetRel = path.relative(index.root, targetPath);
    const targetDir = path.dirname(targetRel);

    const results = [...importers].map(importerPath => {
        const fileEntry = index.files.get(importerPath);

        // Locate the import statement via the importer's own parsed import
        // records: fileEntry.moduleResolved (built with the import graph) maps
        // each module string to the project file it resolved to, and the
        // parser records each import's AST line. (The old basename+'import'
        // substring heuristic matched comments, returned null for Rust
        // use/mod, and misfired on prose like 'important'.)
        let importLine = null;
        let importModule = null;
        const mr = (fileEntry && fileEntry.moduleResolved) || {};
        let matchModules = Object.keys(mr).filter(m => mr[m] === targetRel);
        if (matchModules.length === 0) {
            // Directory-level links: a Go package import (or Java wildcard)
            // links every file in the target's directory — the module string
            // resolved to a sibling, but the statement still covers the target.
            matchModules = Object.keys(mr).filter(m => {
                if (path.dirname(mr[m]) !== targetDir) return false;
                const lang = fileEntry.language;
                if (langTraits(lang)?.packageScope === 'directory') return true;
                if (lang === 'java' && m.endsWith('.*')) return true;
                return false;
            });
        }
        if (matchModules.length > 0 && fileEntry) {
            try {
                const content = index._readFile(importerPath);
                const { imports: rawImports } = extractImports(content, fileEntry.language);
                const wanted = new Set(matchModules);
                const submodules = langTraits(fileEntry.language)?.submoduleImports;
                for (const imp of rawImports) {
                    if (!imp.module) continue;
                    let matched = wanted.has(imp.module) ? imp.module : null;
                    // Python from-import submodules resolve under a composed
                    // spec (`from . import jobs` → '.jobs', fix #224) that the
                    // raw record stores as module '.' + name 'jobs'.
                    if (!matched && submodules && imp.names) {
                        for (const n of imp.names) {
                            const spec = imp.module.endsWith('.') ? imp.module + n : imp.module + '.' + n;
                            if (wanted.has(spec)) { matched = spec; break; }
                        }
                    }
                    if (matched && imp.line != null &&
                        (importLine === null || imp.line < importLine)) {
                        importLine = imp.line;
                        importModule = matched;
                    }
                }
            } catch (e) {
                // Skip — file unreadable, leave importLine null
            }
        }

        return {
            file: fileEntry ? fileEntry.relativePath : path.relative(index.root, importerPath),
            importLine,
            ...(importModule !== null && { module: importModule })
        };
    });

    results.sort((a, b) => codeUnitCompare(a.file, b.file));
    return results;
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

    // Names exported ONLY under an alias (`export { foo as myFoo }`, no
    // plain export) are importable only AS the alias — the alias entry is
    // added from exportDetails below; the bare name would be a lie (fix #245).
    const aliasedAway = new Set();
    if (fileEntry.exportDetails) {
        const plainClauseNames = new Set(fileEntry.exportDetails
            .filter(e => e.type === 'named' && !e.source && !e.alias)
            .map(e => e.name));
        for (const e of fileEntry.exportDetails) {
            if (e.type === 'named' && !e.source && e.alias && !plainClauseNames.has(e.name)) {
                aliasedAway.add(e.name);
            }
        }
    }

    // Python convention: when a module declares no `__all__`, every top-level
    // non-`_` name is considered public. We don't want this in the underlying
    // export list (deadcode would think everything is exported), so fileExports
    // applies it locally for display.
    const isPythonImplicit = fileEntry.language === 'python' && exportedNames.size === 0;

    for (const symbol of fileEntry.symbols) {
        // impl blocks group members; the block itself is not an exportable
        // symbol (its name collides with the struct's, which IS listed).
        if (symbol.type === 'impl') continue;
        if (aliasedAway.has(symbol.name) && !(symbol.modifiers || []).includes('export')) continue;
        const isExported = symbolIsExported(symbol, fileEntry, exportedNames) ||
            (isPythonImplicit && symbol.name && !symbol.name.startsWith('_') && !symbol.className && !symbol.isMethod);

        if (isExported) {
            results.push({
                name: symbol.name,
                type: symbol.type,
                file: fileEntry.relativePath,
                startLine: symbol.startLine,
                endLine: symbol.endLine,
                ...(symbol.className && { className: symbol.className }),
                params: symbol.params,
                returnType: symbol.returnType,
                signature: formatExportSignature(index, symbol)
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
                                    // The entry belongs to the BARREL file —
                                    // its line is the `export *` statement,
                                    // never the source's line numbers (fix
                                    // #245: barrel.ts:9-11 on a 1-line file).
                                    results.push({
                                        ...srcExp,
                                        file: fileEntry.relativePath,
                                        startLine: exp.line,
                                        endLine: exp.line,
                                        reExportedFrom: srcExp.file,
                                    });
                                }
                            }
                        } else {
                            // Named re-export: find the specific symbol.
                            // Consumers import the ALIAS when one exists —
                            // `export { foo as myFoo } from './lib'` is
                            // importable only as myFoo (fix #245); the
                            // source-side name stays in sourceName.
                            const displayName = exp.alias || exp.name;
                            const srcSymbol = sourceEntry.symbols.find(s => s.name === exp.name);
                            if (srcSymbol) {
                                matchedNames.add(exp.name);
                                results.push({
                                    name: displayName,
                                    ...(exp.alias && { sourceName: exp.name }),
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
                                    name: displayName,
                                    ...(exp.alias && { sourceName: exp.name }),
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

        // Local export clauses: `export { foo, bar }` / `export { foo as
        // myFoo }`. A clause-exported CONST has no isVariable flag and no
        // symbol entry, and a two-step barrel (`import { foo } from './lib';
        // export { foo };`) matched nothing — both rendered empty (fix
        // #245). Aliased local exports list under the ALIAS.
        for (const exp of fileEntry.exportDetails) {
            if (exp.type !== 'named' || exp.source || exp.isVariable) continue;
            const displayName = exp.alias || exp.name;
            if (matchedNames.has(displayName)) continue;
            if (!exp.alias && matchedNames.has(exp.name)) continue;
            const localSym = fileEntry.symbols.find(s => s.name === exp.name && !s.className);
            if (localSym) {
                matchedNames.add(displayName);
                results.push({
                    name: displayName,
                    ...(exp.alias && { sourceName: exp.name }),
                    type: localSym.type,
                    file: fileEntry.relativePath,
                    startLine: localSym.startLine,
                    endLine: localSym.endLine,
                    params: localSym.params,
                    returnType: localSym.returnType,
                    signature: index.formatSignature(localSym)
                });
                continue;
            }
            // Two-step barrel: the name is an import binding — resolve it
            const binding = (fileEntry.importBindings || []).find(b => b.name === exp.name);
            const resolvedRel = binding && fileEntry.moduleResolved && fileEntry.moduleResolved[binding.module];
            let srcSymbol = null, srcRel = null;
            if (resolvedRel) {
                for (const [, fe2] of index.files) {
                    if (fe2.relativePath === resolvedRel) {
                        srcSymbol = fe2.symbols.find(s => s.name === exp.name && !s.className) || null;
                        srcRel = fe2.relativePath;
                        break;
                    }
                }
            }
            matchedNames.add(displayName);
            results.push({
                name: displayName,
                ...(exp.alias && { sourceName: exp.name }),
                type: srcSymbol ? srcSymbol.type : 'variable',
                file: fileEntry.relativePath,
                startLine: exp.line,
                endLine: exp.line,
                params: srcSymbol ? srcSymbol.params : undefined,
                returnType: srcSymbol ? srcSymbol.returnType : null,
                signature: srcSymbol ? index.formatSignature(srcSymbol)
                    : `export ${exp.name}${exp.alias ? ' as ' + exp.alias : ''}`,
                ...(srcRel && { reExportedFrom: srcRel })
            });
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
            if (symbol.type === 'impl') continue;
            if (symbolIsExported(symbol, fileEntry, exportedNames)) {
                results.push({
                    name: symbol.name,
                    type: symbol.type,
                    file: fileEntry.relativePath,
                    startLine: symbol.startLine,
                    endLine: symbol.endLine,
                    ...(symbol.className && { className: symbol.className }),
                    params: symbol.params,
                    returnType: symbol.returnType,
                    signature: formatExportSignature(index, symbol)
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
                    matchedNames.add(exp.name);
                }
            }
            // The fix #245 fileExports discipline, api side (fix #251 — the
            // two commands diverged on the same file): consumers import the
            // ALIAS, and clause-exported names with no indexed symbol
            // (class/function expressions) are still API surface.
            for (const exp of fileEntry.exportDetails) {
                if (!exp || !exp.name || exp.module) continue;
                if (exp.alias && exp.alias !== exp.name) {
                    const entry = results.find(r =>
                        r.file === fileEntry.relativePath && r.name === exp.name && !r.sourceName);
                    if (entry) {
                        entry.sourceName = exp.name;
                        entry.name = exp.alias;
                        if (entry.signature) {
                            entry.signature = entry.signature.replace(exp.name, exp.alias);
                        }
                        matchedNames.add(exp.alias);
                        continue;
                    }
                }
                const shown = exp.alias || exp.name;
                if (!matchedNames.has(shown) && !matchedNames.has(exp.name) &&
                    exportedNames.has(exp.name)) {
                    results.push({
                        name: shown,
                        ...(exp.alias && exp.alias !== exp.name && { sourceName: exp.name }),
                        type: 'export',
                        file: fileEntry.relativePath,
                        startLine: exp.line || 1,
                        endLine: exp.line || 1,
                        params: undefined,
                        returnType: null,
                        signature: shown,
                    });
                    matchedNames.add(shown);
                }
            }
        }
    }

    // Rule 11: (file, line) ordering regardless of parse order — file mode
    // used to emit symbols in extraction order (fix #251).
    results.sort((a, b) => codeUnitCompare(a.file, b.file) ||
        (a.startLine - b.startLine) || codeUnitCompare(a.name, b.name));
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
    // Normalize direction. Accept aliases (`in` ≡ importers, `out` ≡ imports),
    // reject anything else with an explicit error so users don't get a silent
    // empty-graph answer.
    const rawDirection = options.direction || 'both';
    const DIRECTION_ALIASES = {
        'imports': 'imports', 'out': 'imports', 'outgoing': 'imports', 'downstream': 'imports',
        'importers': 'importers', 'in': 'importers', 'incoming': 'importers', 'upstream': 'importers',
        'both': 'both',
    };
    const direction = DIRECTION_ALIASES[rawDirection];
    if (!direction) {
        return {
            error: 'invalid-direction',
            message: `Unknown direction "${rawDirection}". Valid: imports/out/outgoing/downstream, importers/in/incoming/upstream, both.`,
        };
    }
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
        let truncated = false;

        const cutNodes = [];

        const traverse = (file, depth) => {
            if (visited.has(file)) return;
            visited.add(file);

            const fileEntry = index.files.get(file);
            const relPath = fileEntry ? fileEntry.relativePath : path.relative(index.root, file);
            nodes.push({ file, relativePath: relPath, depth });

            // Stop traversal at max depth but still register the node above.
            // Edges from cut nodes are resolved in a post-pass (below) so the
            // outcome never depends on visit order.
            if (depth >= maxDepth) {
                cutNodes.push(file);
                return;
            }

            const neighbors = dir === 'imports'
                ? (index.importGraph.get(file) || new Set())
                : (index.exportGraph.get(file) || new Set());

            for (const neighbor of neighbors) {
                edges.push({ from: file, to: neighbor });
                traverse(neighbor, depth + 1);
            }
        };

        traverse(targetPath, 0);

        // Deterministic cut-frontier pass (fix #245): a cut node's edge to a
        // node ALREADY in the result needs no deeper traversal — emit it
        // (the diamond b→a edge used to vanish); only neighbors genuinely
        // outside the result mark the graph depth-truncated. The in-traversal
        // peek made both outcomes depend on import order.
        for (const file of cutNodes) {
            const neighbors = dir === 'imports'
                ? (index.importGraph.get(file) || new Set())
                : (index.exportGraph.get(file) || new Set());
            for (const neighbor of neighbors) {
                if (visited.has(neighbor)) {
                    edges.push({ from: file, to: neighbor });
                } else {
                    truncated = true;
                }
            }
        }

        return { nodes, edges, truncated };
    };

    if (direction === 'both') {
        // Build separate sub-graphs for imports and importers
        const importsGraph = buildSubgraph('imports');
        const importersGraph = buildSubgraph('importers');

        return {
            root: targetPath,
            direction: 'both',
            maxDepth,
            depthTruncated: importsGraph.truncated || importersGraph.truncated,
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
        maxDepth,
        depthTruncated: subgraph.truncated,
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

            const neighbors = index.importGraph.get(file) || new Set();

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

        result.sort((a, b) => a.length - b.length || codeUnitCompare(a.files[0], b.files[0]));

        // Count files that participate in import graph (have edges)
        let filesWithImports = 0;
        for (const [, targets] of index.importGraph) {
            if (targets && targets.size > 0) filesWithImports++;
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
