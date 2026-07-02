/**
 * core/output/graph.js - File dependency formatters
 */

const { lineRange, formatFileError } = require('./shared');

/**
 * Format imports command output - text
 */
function formatImports(imports, filePath) {
    if (imports?.error) return formatFileError(imports, filePath);
    const lines = [`Imports in ${filePath}:\n`];

    // A string-literal dynamic import that resolved is a project-internal
    // dependency (isDynamic marks the MECHANISM); only unresolved dynamic
    // imports belong in the DYNAMIC (unresolved) section.
    const internal = imports.filter(i => i.resolved);
    const external = imports.filter(i => !i.resolved && !i.isDynamic);
    const dynamic = imports.filter(i => !i.resolved && i.isDynamic);

    if (internal.length > 0) {
        lines.push('INTERNAL:');
        for (const imp of internal) {
            lines.push(`  ${imp.module}`);
            if (imp.resolved) {
                lines.push(`    -> ${imp.resolved}`);
            }
            if (imp.names && imp.names.length > 0 && imp.names[0] !== '*') {
                lines.push(`    ${imp.names.join(', ')}`);
            }
        }
    }

    if (external.length > 0) {
        if (internal.length > 0) lines.push('');
        lines.push('EXTERNAL:');
        for (const imp of external) {
            lines.push(`  ${imp.module}`);
            if (imp.names && imp.names.length > 0) {
                lines.push(`    ${imp.names.join(', ')}`);
            }
        }
    }

    if (dynamic.length > 0) {
        if (internal.length > 0 || external.length > 0) lines.push('');
        lines.push('DYNAMIC (unresolved):');
        for (const imp of dynamic) {
            lines.push(`  ${imp.module || '(variable)'}`);
            if (imp.names && imp.names.length > 0) {
                lines.push(`    ${imp.names.join(', ')}`);
            }
        }
    }

    if (internal.length === 0 && external.length === 0 && dynamic.length === 0) {
        lines.push('  (none)');
    }

    return lines.join('\n');
}

/**
 * Format imports as JSON
 */
function formatImportsJson(imports, filePath) {
    if (imports?.error) return JSON.stringify({ found: false, error: imports.error, file: imports.filePath || filePath }, null, 2);
    return JSON.stringify({
        file: filePath,
        importCount: imports.length,
        imports: imports.map(i => ({
            module: i.module,
            names: i.names,
            type: i.type,
            resolved: i.resolved || null,
            isDynamic: !!i.isDynamic,
            line: i.line ?? null
        }))
    }, null, 2);
}

/**
 * Format exporters command output - text
 */
function formatExporters(exporters, filePath) {
    if (exporters?.error) return formatFileError(exporters, filePath);
    const lines = [`Files that import ${filePath}:\n`];

    if (exporters.length === 0) {
        lines.push('  (none found)');
    } else {
        for (const exp of exporters) {
            if (exp.importLine) {
                lines.push(`  ${exp.file}:${exp.importLine}`);
            } else {
                lines.push(`  ${exp.file}`);
            }
        }
    }

    return lines.join('\n');
}

/**
 * Format exporters as JSON
 */
function formatExportersJson(exporters, filePath) {
    if (exporters?.error) return JSON.stringify({ found: false, error: exporters.error, file: exporters.filePath || filePath }, null, 2);
    return JSON.stringify({
        file: filePath,
        importerCount: exporters.length,
        importers: exporters
    }, null, 2);
}

/**
 * Dedup exported/api symbols. TypeScript overloads emit one symbol per overload
 * declaration with identical name/signature; collapse them to a single entry.
 * Key is "name|signature" (falls back to name|startLine when no signature).
 */
function dedupExportSymbols(symbols) {
    if (!Array.isArray(symbols)) return symbols;
    const seen = new Map();
    for (const s of symbols) {
        const sig = s.signature || (s.params !== undefined ? `${s.name}(${s.params})` : '');
        const key = sig ? `${s.name}|${sig}` : `${s.name}|${s.startLine}`;
        if (!seen.has(key)) seen.set(key, s);
    }
    return Array.from(seen.values());
}

/**
 * Format file-exports command output
 */
function formatFileExports(exports, filePath) {
    if (exports?.error) return formatFileError(exports, filePath);
    if (exports.length === 0) return `No exports found in ${filePath}`;

    const deduped = dedupExportSymbols(exports);
    const lines = [];
    lines.push(`Exports from ${filePath}:\n`);
    for (const exp of deduped) {
        lines.push(`  ${lineRange(exp.startLine, exp.endLine)} ${exp.signature || exp.name}`);
    }
    return lines.join('\n');
}

function formatFileExportsJson(result, filePath) {
    if (!result) return JSON.stringify({ found: false });
    // result is an array of exported symbols from index.fileExports()
    const rawExports = Array.isArray(result) ? result : (result.exports || []);
    const exports = dedupExportSymbols(rawExports);
    return JSON.stringify({
        meta: { command: 'fileExports', file: filePath || (Array.isArray(result) ? result[0]?.file : result.file) },
        data: {
            file: filePath || (Array.isArray(result) ? result[0]?.file : result.file),
            exports,
        },
    }, null, 2);
}

/**
 * Format api command output - text
 */
function formatApi(symbols, filePath) {
    const title = filePath
        ? `Exports from ${filePath}:`
        : 'Project API (exported symbols):';
    const lines = [title + '\n'];

    if (symbols.length === 0) {
        lines.push('  (none found)');
        if (filePath && filePath.endsWith('.py')) {
            lines.push('');
            lines.push('Note: Python requires __all__ for export detection. Use \'toc\' command to see all functions/classes.');
        }
    } else {
        // Group by file, then dedup overloads within each file group.
        const byFile = new Map();
        for (const sym of symbols) {
            if (!byFile.has(sym.file)) {
                byFile.set(sym.file, []);
            }
            byFile.get(sym.file).push(sym);
        }

        for (const [file, syms] of byFile) {
            lines.push(file);
            const dedupedSyms = dedupExportSymbols(syms);
            for (const s of dedupedSyms) {
                const sig = s.signature || `${s.type} ${s.name}`;
                lines.push(`  ${lineRange(s.startLine, s.endLine)} ${sig}`);
            }
            lines.push('');
        }
    }

    return lines.join('\n');
}

/**
 * Format api as JSON
 */
function formatApiJson(symbols, filePath) {
    const { formatSymbolHandle } = require('../shared');
    const deduped = dedupExportSymbols(symbols);
    return JSON.stringify({
        meta: { command: 'api', count: deduped.length },
        ...(filePath && { file: filePath }),
        data: {
            exportCount: deduped.length,
            exports: deduped.map(s => {
                const handleSym = { ...s, relativePath: s.relativePath || s.file };
                const handle = formatSymbolHandle(handleSym);
                return {
                    name: s.name,
                    type: s.type,
                    file: s.file,
                    startLine: s.startLine,
                    endLine: s.endLine,
                    ...(handle && { handle }),
                    ...(s.params && { params: s.params }),
                    ...(s.paramsStructured && { paramsStructured: s.paramsStructured }),
                    ...(s.paramTypes && { paramTypes: s.paramTypes }),
                    ...(s.returnType && { returnType: s.returnType }),
                    ...(s.docstring && { docstring: s.docstring }),
                    ...(s.signature && { signature: s.signature }),
                };
            }),
        },
    }, null, 2);
}

/**
 * Format graph command output
 * @param {object} graph - Graph data
 * @param {object} [options] - Formatting options
 * @param {boolean} [options.showAll] - Show all children (no truncation)
 * @param {number} [options.maxDepth] - Maximum depth for tree traversal
 */
function formatGraph(graph, options = {}) {
    // Support legacy signature: formatGraph(graph, showAll)
    if (typeof options === 'boolean') {
        options = { showAll: options };
    }
    if (graph?.error) return formatFileError(graph);
    if (graph.nodes.length === 0) {
        const file = options.file || graph.root || '';
        return file ? `File not found: ${file}` : 'File not found.';
    }

    const rootEntry = graph.nodes.find(n => n.file === graph.root);
    const rootRelPath = rootEntry ? rootEntry.relativePath : graph.root;
    const lines = [];

    const showAll = options.showAll || false;
    const maxChildren = showAll ? Infinity : 8;
    const maxDepth = options.maxDepth !== undefined ? options.maxDepth
        : (graph.maxDepth !== undefined ? graph.maxDepth : Infinity);
    // The engine stops traversal at ITS maxDepth, so the data never reaches
    // the formatter's own depth check — the engine reports the cut instead.
    const engineTruncated = !!graph.depthTruncated;

    function printTree(nodes, edges, rootFile) {
        const visited = new Set();     // all nodes ever printed (for diamond dep detection)
        const ancestors = new Set();   // current path from root (for true circular detection)
        let truncatedNodes = 0;
        let depthLimited = false;

        function printNode(file, indent = 0, isLast = true) {
            const fileEntry = nodes.find(n => n.file === file);
            const relPath = fileEntry ? fileEntry.relativePath : file;
            const connector = isLast ? '└── ' : '├── ';
            const prefix = indent === 0 ? '' : '  '.repeat(indent - 1) + connector;

            if (ancestors.has(file)) {
                lines.push(`${prefix}${relPath} (circular)`);
                return;
            }
            if (visited.has(file)) {
                lines.push(`${prefix}${relPath} (already shown)`);
                return;
            }
            visited.add(file);

            if (indent > maxDepth) {
                depthLimited = true;
                lines.push(`${prefix}${relPath} ...`);
                return;
            }

            lines.push(`${prefix}${relPath}`);

            ancestors.add(file);
            const fileEdges = edges.filter(e => e.from === file);
            const displayEdges = fileEdges.slice(0, maxChildren);
            const hiddenCount = fileEdges.length - displayEdges.length;

            for (let i = 0; i < displayEdges.length; i++) {
                const childIsLast = i === displayEdges.length - 1 && hiddenCount === 0;
                printNode(displayEdges[i].to, indent + 1, childIsLast);
            }
            ancestors.delete(file);

            if (hiddenCount > 0) {
                truncatedNodes += hiddenCount;
                lines.push(`${'  '.repeat(indent)}└── ... and ${hiddenCount} more`);
            }
        }

        printNode(rootFile);
        return { truncatedNodes, depthLimited };
    }

    if (graph.direction === 'both' && graph.imports && graph.importers) {
        const importCount = graph.imports.edges.filter(e => e.from === graph.root).length;
        const importerCount = graph.importers.edges.filter(e => e.from === graph.root).length;

        lines.push(`Dependency graph for ${rootRelPath}`);
        lines.push('═'.repeat(60));

        let totalTruncated = 0;
        let anyDepthLimited = false;

        lines.push(`\nIMPORTS (what this file depends on): ${importCount} file${importCount === 1 ? '' : 's'}`);
        if (importCount > 0) {
            const r = printTree(graph.imports.nodes, graph.imports.edges, graph.root);
            totalTruncated += r.truncatedNodes;
            anyDepthLimited = anyDepthLimited || r.depthLimited;
        } else {
            lines.push('  (none)');
        }

        lines.push(`\nIMPORTERS (what depends on this file): ${importerCount} file${importerCount === 1 ? '' : 's'}`);
        if (importerCount > 0) {
            const r = printTree(graph.importers.nodes, graph.importers.edges, graph.root);
            totalTruncated += r.truncatedNodes;
            anyDepthLimited = anyDepthLimited || r.depthLimited;
        } else {
            lines.push('  (none)');
        }

        anyDepthLimited = anyDepthLimited || engineTruncated;
        if (anyDepthLimited || totalTruncated > 0) {
            lines.push('\n' + '─'.repeat(60));
            if (anyDepthLimited) {
                const depthHint = options.depthHint || `Use --depth=N for deeper graph.`;
                lines.push(`Depth limited to ${maxDepth}. ${depthHint}`);
            }
            if (totalTruncated > 0) {
                const allHint = options.allHint || 'Use --all to show all children.';
                lines.push(`${totalTruncated} nodes hidden. ${allHint}`);
            }
        }
    } else {
        lines.push(`Dependency graph for ${rootRelPath}`);
        lines.push('═'.repeat(60));

        const { truncatedNodes, depthLimited: fmtDepthLimited } = printTree(graph.nodes, graph.edges, graph.root);
        const depthLimited = fmtDepthLimited || engineTruncated;

        if (depthLimited || truncatedNodes > 0) {
            lines.push('\n' + '─'.repeat(60));
            if (depthLimited) {
                const depthHint = options.depthHint || `Use --depth=N for deeper graph.`;
                lines.push(`Depth limited to ${maxDepth}. ${depthHint}`);
            }
            if (truncatedNodes > 0) {
                const allHint = options.allHint || 'Use --all to show all children.';
                lines.push(`${truncatedNodes} nodes hidden. ${allHint} Graph has ${graph.nodes.length} total files.`);
            }
        }
    }

    return lines.join('\n');
}

/**
 * Format dependency graph as JSON
 */
function formatGraphJson(graph) {
    if (graph?.error) return JSON.stringify({ found: false, error: graph.error, file: graph.filePath }, null, 2);
    const result = {
        root: graph.root,
        direction: graph.direction,
        nodes: graph.nodes,
        edges: graph.edges
    };
    if (graph.maxDepth !== undefined) result.maxDepth = graph.maxDepth;
    if (graph.depthTruncated) result.depthTruncated = true;
    if (graph.imports) result.imports = graph.imports;
    if (graph.importers) result.importers = graph.importers;
    return JSON.stringify(result, null, 2);
}

function formatCircularDeps(result) {
    if (!result) return 'No results.';
    const lines = [];

    lines.push('Circular dependencies');
    lines.push('═'.repeat(60));

    if (result.fileFilter) {
        lines.push(`Filtered to cycles involving: ${result.fileFilter}`);
    }

    const scannedCount = result.filesWithImports != null ? result.filesWithImports : result.totalFiles;

    if (result.cycles.length === 0) {
        lines.push('');
        lines.push('No circular dependencies found.');
        lines.push(`Scanned ${scannedCount} files with import relationships.`);
        return lines.join('\n');
    }

    for (let i = 0; i < result.cycles.length; i++) {
        const cycle = result.cycles[i];
        lines.push('');
        lines.push(`Cycle ${i + 1} (${cycle.length} files):`);
        lines.push(`  ${cycle.files.join(' → ')} → ${cycle.files[0]}`);
    }

    lines.push('');
    const { totalCycles, filesInCycles } = result.summary;
    lines.push(`Summary: ${totalCycles} circular dependency chain${totalCycles !== 1 ? 's' : ''} involving ${filesInCycles} file${filesInCycles !== 1 ? 's' : ''} (${scannedCount} files with imports scanned).`);

    return lines.join('\n');
}

function formatCircularDepsJson(result) {
    if (!result) return JSON.stringify({ error: 'No results' }, null, 2);
    return JSON.stringify(result, null, 2);
}

module.exports = {
    formatImports,
    formatImportsJson,
    formatExporters,
    formatExportersJson,
    formatFileExports,
    formatFileExportsJson,
    formatApi,
    formatApiJson,
    formatGraph,
    formatGraphJson,
    formatCircularDeps,
    formatCircularDepsJson,
};
