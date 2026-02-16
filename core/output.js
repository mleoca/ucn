/**
 * core/output.js - Output formatting utilities
 *
 * KEY PRINCIPLE: Never truncate critical information.
 * Full expressions, full signatures, full context.
 */

const fs = require('fs');
const path = require('path');

/**
 * Normalize parameters for display
 * Collapses multiline params to single line
 * @param {string} params - Raw params string
 * @returns {string} - Normalized params (NO truncation)
 */
function normalizeParams(params) {
    if (!params || params === '...') return params || '...';
    // Collapse whitespace (newlines, tabs, multiple spaces) to single space
    return params.replace(/\s+/g, ' ').trim();
}

/**
 * Format a line number for display
 * @param {number} line - 1-indexed line number
 * @param {number} width - Padding width
 * @returns {string}
 */
function lineNum(line, width = 4) {
    return String(line).padStart(width);
}

/**
 * Format a line range
 * @param {number} start - 1-indexed start line
 * @param {number} end - 1-indexed end line
 * @returns {string}
 */
function lineRange(start, end) {
    return `[${lineNum(start)}-${lineNum(end)}]`;
}

/**
 * Format a single line location
 * @param {number} line - 1-indexed line number
 * @returns {string}
 */
function lineLoc(line) {
    return `[${lineNum(line)}]`;
}

// ============================================================================
// TEXT FORMATTERS
// ============================================================================

/**
 * Format function signature for TOC display
 * @param {object} fn - Function definition
 * @returns {string}
 */
function formatFunctionSignature(fn) {
    const prefix = [];

    // Modifiers
    if (fn.modifiers && fn.modifiers.length > 0) {
        prefix.push(fn.modifiers.join(' '));
    }

    // Generator marker
    if (fn.isGenerator) prefix.push('*');

    // Name + generics + params (concatenated without spaces)
    let sig = fn.name;
    if (fn.generics) sig += fn.generics;
    const params = normalizeParams(fn.params);
    sig += `(${params})`;

    // Return type
    if (fn.returnType) sig += `: ${fn.returnType}`;

    // Arrow indicator
    if (fn.isArrow) sig += ' =>';

    if (prefix.length > 0) {
        return prefix.join(' ') + ' ' + sig;
    }
    return sig;
}

/**
 * Format class/type signature for TOC display
 */
function formatClassSignature(cls) {
    const parts = [cls.type, cls.name];

    if (cls.generics) parts.push(cls.generics);
    if (cls.extends) parts.push(`extends ${cls.extends}`);
    if (cls.implements && cls.implements.length > 0) {
        parts.push(`implements ${cls.implements.join(', ')}`);
    }

    return parts.join(' ');
}

/**
 * Format class member for TOC display
 */
function formatMemberSignature(member) {
    const parts = [];

    // Member type (static, get, set, private, etc.)
    if (member.memberType && member.memberType !== 'method') {
        parts.push(member.memberType);
    }

    // Async
    if (member.isAsync) parts.push('async');

    // Generator
    if (member.isGenerator) parts.push('*');

    // Name
    parts.push(member.name);

    // Parameters
    if (member.params !== undefined) {
        const params = normalizeParams(member.params);
        parts.push(`(${params})`);
    }

    // Return type
    if (member.returnType) parts.push(`: ${member.returnType}`);

    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Print section header
 */
function header(title, char = '═') {
    console.log(title);
    console.log(char.repeat(60));
}

/**
 * Print subheader
 */
function subheader(title) {
    console.log(title);
    console.log('─'.repeat(40));
}

/**
 * Print a usage/call site - FULL expression, never truncated
 * @param {object} usage - Usage object
 * @param {string} [relativePath] - Relative file path
 */
function printUsage(usage, relativePath) {
    const file = relativePath || usage.file;
    // Context before the match
    if (usage.before && usage.before.length > 0) {
        for (const line of usage.before) {
            console.log(`    ... ${line.trim()}`);
        }
    }
    // FULL content - this is the key improvement
    console.log(`  ${file}:${usage.line}`);
    console.log(`    ${usage.content.trim()}`);
    // Context after the match
    if (usage.after && usage.after.length > 0) {
        for (const line of usage.after) {
            console.log(`    ... ${line.trim()}`);
        }
    }
}

/**
 * Print definition with full signature
 */
function printDefinition(def, relativePath) {
    const file = relativePath || def.file;
    console.log(`  ${file}:${def.line}`);
    if (def.signature) {
        console.log(`    ${def.signature}`);
    }
}

// ============================================================================
// JSON FORMATTERS
// ============================================================================

/**
 * Format TOC data as JSON
 */
function formatTocJson(data) {
    return JSON.stringify({
        meta: data.meta || { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0 },
        totals: data.totals,
        summary: data.summary,
        files: data.files
    });
}

/**
 * Format symbol search results as JSON
 */
function formatSymbolJson(symbols, query) {
    return JSON.stringify({
        meta: { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0 },
        data: {
            query,
            count: symbols.length,
            results: symbols.map(s => ({
                name: s.name,
                type: s.type,
                file: s.relativePath || s.file,
                startLine: s.startLine,
                endLine: s.endLine,
                ...(s.params && { params: s.params }),  // FULL params
                ...(s.paramsStructured && { paramsStructured: s.paramsStructured }),
                ...(s.returnType && { returnType: s.returnType }),
                ...(s.modifiers && { modifiers: s.modifiers }),
                ...(s.usageCount !== undefined && { usageCount: s.usageCount }),
                ...(s.usageCounts !== undefined && { usageCounts: s.usageCounts })
            }))
        }
    });
}

/**
 * Format usages as JSON - FULL expressions, never truncated
 */
function formatUsagesJson(usages, name) {
    const definitions = usages.filter(u => u.isDefinition);
    const refs = usages.filter(u => !u.isDefinition);

    const calls = refs.filter(u => u.usageType === 'call');
    const imports = refs.filter(u => u.usageType === 'import');
    const references = refs.filter(u => u.usageType === 'reference');

    const formatUsage = (u) => ({
        file: u.relativePath || u.file,
        line: u.line,
        expression: u.content,  // FULL expression - key improvement
        ...(u.args && { args: u.args }),  // Parsed arguments
        ...(u.before && u.before.length > 0 && { before: u.before }),
        ...(u.after && u.after.length > 0 && { after: u.after })
    });

    return JSON.stringify({
        meta: { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0 },
        data: {
            symbol: name,
            definitionCount: definitions.length,
            callCount: calls.length,
            importCount: imports.length,
            referenceCount: references.length,
            totalUsages: refs.length,
            definitions: definitions.map(d => ({
                file: d.relativePath || d.file,
                line: d.line,
                signature: d.signature || null,  // FULL signature
                type: d.type || null,
                ...(d.returnType && { returnType: d.returnType }),
                ...(d.before && d.before.length > 0 && { before: d.before }),
                ...(d.after && d.after.length > 0 && { after: d.after })
            })),
            calls: calls.map(formatUsage),
            imports: imports.map(formatUsage),
            references: references.map(formatUsage)
        }
    });
}

/**
 * Format context (callers + callees) as JSON
 */
function formatContextJson(context) {
    const meta = context.meta || { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0 };
    // Handle struct/interface types differently
    if (context.type && ['struct', 'interface', 'type'].includes(context.type)) {
        const callers = context.callers || [];
        const methods = context.methods || [];
        return JSON.stringify({
            meta,
            data: {
                type: context.type,
                name: context.name,
                file: context.file,
                startLine: context.startLine,
                endLine: context.endLine,
                methodCount: methods.length,
                usageCount: callers.length,
                methods: methods.map(m => ({
                    name: m.name,
                    file: m.file,
                    line: m.line,
                    params: m.params,
                    returnType: m.returnType,
                    receiver: m.receiver
                })),
                usages: callers.map(c => ({
                    file: c.relativePath || c.file,
                    line: c.line,
                    expression: c.content,
                    callerName: c.callerName
                })),
                ...(context.warnings && { warnings: context.warnings })
            }
        });
    }

    // Standard function/method context
    const callers = context.callers || [];
    const callees = context.callees || [];
    return JSON.stringify({
        meta,
        data: {
            function: context.function,
            file: context.file,
            callerCount: callers.length,
            calleeCount: callees.length,
            callers: callers.map(c => ({
                file: c.relativePath || c.file,
                line: c.line,
                expression: c.content,  // FULL expression
                callerName: c.callerName
            })),
            callees: callees.map(c => ({
                name: c.name,
                type: c.type,
                file: c.relativePath || c.file,
                line: c.startLine,
                params: c.params,  // FULL params
                weight: c.weight || 'normal'  // Dependency weight: core, setup, utility
            })),
            ...(context.warnings && { warnings: context.warnings })
        }
    });
}

/**
 * Format extracted function as JSON
 */
function formatFunctionJson(fn, code) {
    return JSON.stringify({
        name: fn.name,
        params: fn.params,  // FULL params
        paramsStructured: fn.paramsStructured || [],
        startLine: fn.startLine,
        endLine: fn.endLine,
        modifiers: fn.modifiers || [],
        ...(fn.returnType && { returnType: fn.returnType }),
        ...(fn.generics && { generics: fn.generics }),
        ...(fn.docstring && { docstring: fn.docstring }),
        ...(fn.isArrow && { isArrow: true }),
        ...(fn.isGenerator && { isGenerator: true }),
        code  // FULL code
    }, null, 2);
}

/**
 * Format search results as JSON
 */
function formatSearchJson(results, term) {
    return JSON.stringify({
        term,
        totalMatches: results.reduce((sum, r) => sum + r.matches.length, 0),
        files: results.map(r => ({
            file: r.file,
            matchCount: r.matches.length,
            matches: r.matches.map(m => ({
                line: m.line,
                content: m.content  // FULL content
            }))
        }))
    }, null, 2);
}

/**
 * Format imports as JSON
 */
function formatImportsJson(imports, filePath) {
    return JSON.stringify({
        file: filePath,
        importCount: imports.length,
        imports: imports.map(i => ({
            module: i.module,
            names: i.names,
            type: i.type,
            resolved: i.resolved || null,
            isDynamic: !!i.isDynamic
        }))
    }, null, 2);
}

/**
 * Format project stats as JSON
 */
function formatStatsJson(stats) {
    return JSON.stringify(stats, null, 2);
}

/**
 * Format dependency graph as JSON
 */
function formatGraphJson(graph) {
    return JSON.stringify({
        file: graph.file,
        depth: graph.depth,
        dependencies: graph.dependencies
    }, null, 2);
}

/**
 * Format smart extraction result as JSON
 * Includes function + all dependencies
 */
function formatSmartJson(result) {
    const meta = result.meta || { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0 };
    return JSON.stringify({
        meta,
        data: {
            target: {
                name: result.target.name,
                file: result.target.file,
                startLine: result.target.startLine,
                endLine: result.target.endLine,
                params: result.target.params,
                returnType: result.target.returnType,
                code: result.target.code
            },
            dependencies: result.dependencies.map(d => ({
                name: d.name,
                type: d.type,
                file: d.file,
                startLine: d.startLine,
                endLine: d.endLine,
                params: d.params,
                weight: d.weight,  // core, setup, utility
                callCount: d.callCount,
                code: d.code
            })),
            types: result.types || []
        }
    });
}

// ============================================================================
// NEW FORMATTERS (v2 Migration)
// ============================================================================

/**
 * Format imports command output - text
 */
function formatImports(imports, filePath) {
    const lines = [`Imports in ${filePath}:\n`];

    const internal = imports.filter(i => !i.isExternal && !i.isDynamic);
    const external = imports.filter(i => i.isExternal && !i.isDynamic);
    const dynamic = imports.filter(i => i.isDynamic);

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

    return lines.join('\n');
}

/**
 * Format exporters command output - text
 */
function formatExporters(exporters, filePath) {
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
 * Format typedef command output - text
 */
function formatTypedef(types, name) {
    const lines = [`Type definitions for "${name}":\n`];

    if (types.length === 0) {
        lines.push('  (none found)');
    } else {
        for (const t of types) {
            lines.push(`${t.relativePath}:${t.startLine}  ${t.type} ${t.name}`);
            if (t.usageCount !== undefined) {
                lines.push(`  (${t.usageCount} usages)`);
            }
            if (t.code) {
                lines.push('');
                lines.push('─── CODE ───');
                lines.push(t.code);
                lines.push('');
            }
        }
    }

    return lines.join('\n');
}

/**
 * Format tests command output - text
 */
function formatTests(tests, name) {
    const lines = [`Tests for "${name}":\n`];

    if (tests.length === 0) {
        lines.push('  (no tests found)');
    } else {
        const totalMatches = tests.reduce((sum, t) => sum + t.matches.length, 0);
        lines.push(`Found ${totalMatches} matches in ${tests.length} test file(s):\n`);

        for (const testFile of tests) {
            lines.push(testFile.file);
            for (const match of testFile.matches) {
                const typeLabel = match.matchType === 'test-case' ? '[test]' :
                    match.matchType === 'import' ? '[import]' :
                    match.matchType === 'call' ? '[call]' :
                    match.matchType === 'string-ref' ? '[string]' : '[ref]';
                lines.push(`  ${match.line}: ${typeLabel} ${match.content}`);
            }
            lines.push('');
        }
    }

    return lines.join('\n');
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
    } else {
        // Group by file
        const byFile = new Map();
        for (const sym of symbols) {
            if (!byFile.has(sym.file)) {
                byFile.set(sym.file, []);
            }
            byFile.get(sym.file).push(sym);
        }

        for (const [file, syms] of byFile) {
            lines.push(file);
            for (const s of syms) {
                const sig = s.signature || `${s.type} ${s.name}`;
                lines.push(`  ${lineRange(s.startLine, s.endLine)} ${sig}`);
            }
            lines.push('');
        }
    }

    return lines.join('\n');
}

/**
 * Format disambiguation prompt - text
 */
function formatDisambiguation(matches, name, command) {
    const lines = [`Multiple matches for "${name}":\n`];

    for (const m of matches) {
        const sig = m.params !== undefined
            ? formatFunctionSignature(m)
            : formatClassSignature(m);
        lines.push(`  ${m.relativePath}:${m.startLine}  ${sig}`);
        if (m.usageCount !== undefined) {
            lines.push(`    (${m.usageCount} usages)`);
        }
    }

    lines.push('');
    lines.push(`Use: ucn . ${command} ${name} --file <pattern>`);

    return lines.join('\n');
}

// ============================================================================
// NEW JSON FORMATTERS
// ============================================================================

/**
 * Format exporters as JSON
 */
function formatExportersJson(exporters, filePath) {
    return JSON.stringify({
        file: filePath,
        importerCount: exporters.length,
        importers: exporters
    }, null, 2);
}

/**
 * Format typedef as JSON
 */
function formatTypedefJson(types, name) {
    return JSON.stringify({
        query: name,
        count: types.length,
        types: types.map(t => ({
            name: t.name,
            type: t.type,
            file: t.relativePath || t.file,
            startLine: t.startLine,
            endLine: t.endLine,
            ...(t.usageCount !== undefined && { usageCount: t.usageCount }),
            ...(t.code && { code: t.code })
        }))
    }, null, 2);
}

/**
 * Format tests as JSON
 */
function formatTestsJson(tests, name) {
    return JSON.stringify({
        query: name,
        testFileCount: tests.length,
        totalMatches: tests.reduce((sum, t) => sum + t.matches.length, 0),
        testFiles: tests
    }, null, 2);
}

/**
 * Format api as JSON
 */
function formatApiJson(symbols, filePath) {
    return JSON.stringify({
        ...(filePath && { file: filePath }),
        exportCount: symbols.length,
        exports: symbols.map(s => ({
            name: s.name,
            type: s.type,
            file: s.file,
            startLine: s.startLine,
            endLine: s.endLine,
            ...(s.params && { params: s.params }),
            ...(s.returnType && { returnType: s.returnType }),
            ...(s.signature && { signature: s.signature })
        }))
    }, null, 2);
}

/**
 * Format trace command output - text
 * Shows call tree visualization
 */
function formatTrace(trace) {
    if (!trace) {
        return 'Function not found.';
    }

    const lines = [];

    // Header
    lines.push(`Call tree for ${trace.root}`);
    lines.push('═'.repeat(60));
    lines.push(`${trace.file}:${trace.line}`);
    lines.push(`Direction: ${trace.direction}, Max depth: ${trace.maxDepth}`);
    lines.push('');

    // Render tree
    let hasTruncation = false;
    const renderNode = (node, prefix = '', isLast = true) => {
        const connector = isLast ? '└── ' : '├── ';
        const extension = isLast ? '    ' : '│   ';

        let label = node.name;
        if (node.external) {
            label += ' [external]';
        } else if (node.file) {
            label += ` (${node.file}:${node.line})`;
        }
        if (node.weight && node.weight !== 'normal') {
            label += ` [${node.weight}]`;
        }
        if (node.callCount) {
            label += ` ${node.callCount}x`;
        }

        lines.push(prefix + connector + label);

        if (node.children) {
            const hasMore = node.truncatedChildren > 0;
            for (let i = 0; i < node.children.length; i++) {
                const isChildLast = !hasMore && i === node.children.length - 1;
                renderNode(node.children[i], prefix + extension, isChildLast);
            }
            if (hasMore) {
                hasTruncation = true;
                lines.push(prefix + extension + `└── ... and ${node.truncatedChildren} more callees`);
            }
        }
    };

    // Root node
    lines.push(trace.root);
    if (trace.tree && trace.tree.children) {
        const rootHasMore = trace.tree.truncatedChildren > 0;
        for (let i = 0; i < trace.tree.children.length; i++) {
            const isLast = !rootHasMore && i === trace.tree.children.length - 1;
            renderNode(trace.tree.children[i], '', isLast);
        }
        if (rootHasMore) {
            hasTruncation = true;
            lines.push(`└── ... and ${trace.tree.truncatedChildren} more callees`);
        }
    }

    // Callers section
    if (trace.callers && trace.callers.length > 0) {
        lines.push('');
        lines.push('CALLED BY:');
        for (const c of trace.callers) {
            lines.push(`  ${c.name} - ${c.file}:${c.line}`);
            lines.push(`    ${c.expression}`);
        }
        if (trace.truncatedCallers) {
            hasTruncation = true;
            lines.push(`  ... and ${trace.truncatedCallers} more callers`);
        }
    }

    if (hasTruncation) {
        lines.push(`\nSome results truncated. Use --all to show all.`);
    }

    if (!trace.includeMethods) {
        lines.push(`\nNote: obj.method() calls excluded (--include-methods=false). Remove flag to include them (default).`);
    }

    return lines.join('\n');
}

/**
 * Format trace command output - JSON
 */
function formatTraceJson(trace) {
    if (!trace) {
        return JSON.stringify({ found: false, error: 'Function not found' }, null, 2);
    }
    return JSON.stringify(trace, null, 2);
}

/**
 * Format related command output - text
 */
function formatRelated(related, options = {}) {
    if (!related) {
        return 'Function not found.';
    }

    const lines = [];

    // Header
    lines.push(`Related to ${related.target.name}`);
    lines.push('═'.repeat(60));
    lines.push(`${related.target.file}:${related.target.line}`);
    lines.push('');

    // Same file
    let relatedTruncated = false;
    if (related.sameFile.length > 0) {
        const maxSameFile = options.showAll ? Infinity : 8;
        lines.push(`SAME FILE (${related.sameFile.length}):`);
        for (const f of related.sameFile.slice(0, maxSameFile)) {
            const params = f.params ? `(${f.params})` : '';
            lines.push(`  :${f.line} ${f.name}${params}`);
        }
        if (related.sameFile.length > maxSameFile) {
            relatedTruncated = true;
            lines.push(`  ... and ${related.sameFile.length - maxSameFile} more`);
        }
        lines.push('');
    }

    // Similar names
    if (related.similarNames.length > 0) {
        lines.push(`SIMILAR NAMES (${related.similarNames.length}):`);
        for (const s of related.similarNames) {
            lines.push(`  ${s.name} - ${s.file}:${s.line}`);
            lines.push(`    shared: ${s.sharedParts.join(', ')}`);
        }
        lines.push('');
    }

    // Shared callers
    if (related.sharedCallers.length > 0) {
        lines.push(`CALLED BY SAME FUNCTIONS (${related.sharedCallers.length}):`);
        for (const s of related.sharedCallers) {
            lines.push(`  ${s.name} - ${s.file}:${s.line} (${s.sharedCallerCount} shared callers)`);
        }
        lines.push('');
    }

    // Shared callees
    if (related.sharedCallees.length > 0) {
        lines.push(`CALLS SAME FUNCTIONS (${related.sharedCallees.length}):`);
        for (const s of related.sharedCallees) {
            lines.push(`  ${s.name} - ${s.file}:${s.line} (${s.sharedCalleeCount} shared callees)`);
        }
    }

    if (relatedTruncated) {
        lines.push(`\nSome sections truncated. Use --all to show all.`);
    }

    return lines.join('\n');
}

/**
 * Format related command output - JSON
 */
function formatRelatedJson(related) {
    if (!related) {
        return JSON.stringify({ found: false, error: 'Function not found' }, null, 2);
    }
    return JSON.stringify(related, null, 2);
}

/**
 * Format impact command output - text
 * Shows what would need updating if a function signature changes
 */
function formatImpact(impact, options = {}) {
    if (!impact) {
        return 'Function not found.';
    }

    const lines = [];

    // Header
    lines.push(`Impact analysis for ${impact.function}`);
    lines.push('═'.repeat(60));
    lines.push(`${impact.file}:${impact.startLine}`);
    lines.push(impact.signature);
    lines.push('');

    // Summary
    lines.push(`CALL SITES: ${impact.totalCallSites}`);
    lines.push(`  Files affected: ${impact.byFile.length}`);

    // Patterns
    const p = impact.patterns;
    if (p) {
        const patternParts = [];
        if (p.constantArgs > 0) patternParts.push(`${p.constantArgs} with literals`);
        if (p.variableArgs > 0) patternParts.push(`${p.variableArgs} with variables`);
        if (p.awaitedCalls > 0) patternParts.push(`${p.awaitedCalls} awaited`);
        if (p.chainedCalls > 0) patternParts.push(`${p.chainedCalls} chained`);
        if (p.spreadCalls > 0) patternParts.push(`${p.spreadCalls} with spread`);
        if (patternParts.length > 0) {
            lines.push(`  Patterns: ${patternParts.join(', ')}`);
        }
    }

    // By file
    lines.push('');
    lines.push('BY FILE:');
    for (const fileGroup of impact.byFile) {
        lines.push(`\n${fileGroup.file} (${fileGroup.count} calls)`);
        for (const site of fileGroup.sites) {
            const caller = site.callerName ? `[${site.callerName}]` : '';
            lines.push(`  :${site.line} ${caller}`);
            lines.push(`    ${site.expression}`);
            if (site.args && site.args.length > 0) {
                lines.push(`    args: ${site.args.join(', ')}`);
            }
        }
    }

    return lines.join('\n');
}

/**
 * Format impact command output - JSON
 */
function formatImpactJson(impact) {
    if (!impact) {
        return JSON.stringify({ found: false, error: 'Function not found' }, null, 2);
    }
    return JSON.stringify(impact, null, 2);
}

/**
 * Format plan command output - text
 * Shows before/after signatures and all changes needed
 */
function formatPlan(plan, options = {}) {
    if (!plan) {
        return 'Function not found.';
    }
    if (!plan.found) {
        if (plan.error) {
            return `Error: ${plan.error}\nCurrent parameters: ${plan.currentParams?.join(', ') || 'none'}`;
        }
        return `Function "${plan.function}" not found.`;
    }

    const lines = [];

    // Header
    lines.push(`Refactoring plan: ${plan.operation}`);
    lines.push('═'.repeat(60));
    lines.push(`${plan.file}:${plan.startLine}`);
    lines.push('');

    // Before/After
    lines.push('SIGNATURE CHANGE:');
    lines.push(`  Before: ${plan.before.signature}`);
    lines.push(`  After:  ${plan.after.signature}`);
    lines.push('');

    // Summary
    lines.push(`CHANGES NEEDED: ${plan.totalChanges}`);
    lines.push(`  Files affected: ${plan.filesAffected}`);
    lines.push('');

    // Group by file
    const byFile = new Map();
    for (const change of plan.changes) {
        if (!byFile.has(change.file)) {
            byFile.set(change.file, []);
        }
        byFile.get(change.file).push(change);
    }

    lines.push('BY FILE:');
    for (const [file, changes] of byFile) {
        lines.push(`\n${file} (${changes.length} changes)`);
        for (const change of changes) {
            lines.push(`  :${change.line}`);
            lines.push(`    ${change.expression}`);
            lines.push(`    → ${change.suggestion}`);
        }
    }

    return lines.join('\n');
}

/**
 * Format stack trace command output - text
 * Shows code context for each stack frame
 */
function formatStackTrace(result) {
    if (!result || result.frameCount === 0) {
        return 'No stack frames found in input.';
    }

    const lines = [];
    lines.push(`Stack trace: ${result.frameCount} frames`);
    lines.push('═'.repeat(60));

    for (let i = 0; i < result.frames.length; i++) {
        const frame = result.frames[i];
        lines.push('');
        lines.push(`Frame ${i}: ${frame.function || '(anonymous)'}`);
        lines.push('─'.repeat(40));

        if (frame.found) {
            lines.push(`  ${frame.resolvedFile}:${frame.line}`);

            // Show code context
            if (frame.context) {
                lines.push('');
                for (const ctx of frame.context) {
                    const marker = ctx.isCurrent ? '→ ' : '  ';
                    const lineNum = ctx.line.toString().padStart(4);
                    lines.push(`  ${marker}${lineNum} │ ${ctx.code}`);
                }
            }

            // Show function info if available
            if (frame.functionInfo) {
                lines.push('');
                lines.push(`  In: ${frame.functionInfo.name}(${frame.functionInfo.params || ''})`);
                lines.push(`  Range: ${frame.functionInfo.startLine}-${frame.functionInfo.endLine}`);
            }
        } else {
            lines.push(`  ${frame.file}:${frame.line} (file not found in project)`);
            lines.push(`  Raw: ${frame.raw}`);
        }
    }

    return lines.join('\n');
}

/**
 * Format verify command output - text
 * Shows call site validation results
 */
function formatVerify(result, options = {}) {
    if (!result) {
        return 'Function not found.';
    }
    if (!result.found) {
        return `Function "${result.function}" not found.`;
    }

    const lines = [];

    // Header
    lines.push(`Verification: ${result.function}`);
    lines.push('═'.repeat(60));
    lines.push(`${result.file}:${result.startLine}`);
    lines.push(result.signature);
    lines.push('');

    // Expected args
    const { min, max } = result.expectedArgs;
    const expectedStr = min === max ? `${min}` : `${min}-${max}`;
    lines.push(`Expected arguments: ${expectedStr}`);
    lines.push('');

    // Summary
    const status = result.mismatches === 0 ? '✓ All calls valid' : '✗ Mismatches found';
    lines.push(`STATUS: ${status}`);
    lines.push(`  Total calls: ${result.totalCalls}`);
    lines.push(`  Valid: ${result.valid}`);
    lines.push(`  Mismatches: ${result.mismatches}`);
    lines.push(`  Uncertain: ${result.uncertain}`);

    // Show mismatches
    if (result.mismatchDetails.length > 0) {
        lines.push('');
        lines.push('MISMATCHES:');
        for (const m of result.mismatchDetails) {
            lines.push(`  ${m.file}:${m.line}`);
            lines.push(`    ${m.expression}`);
            lines.push(`    Expected ${m.expected}, got ${m.actual}: [${m.args?.join(', ') || ''}]`);
        }
    }

    // Show uncertain
    if (result.uncertainDetails.length > 0) {
        lines.push('');
        lines.push('UNCERTAIN (manual check needed):');
        for (const u of result.uncertainDetails) {
            lines.push(`  ${u.file}:${u.line}`);
            lines.push(`    ${u.expression}`);
            lines.push(`    Reason: ${u.reason}`);
        }
    }

    return lines.join('\n');
}

/**
 * Format about command output - text
 * The "tell me everything" output for AI agents
 */
function formatAbout(about, options = {}) {
    if (!about) {
        return 'Symbol not found.';
    }
    if (!about.found) {
        const lines = ['Symbol not found.\n'];
        if (about.suggestions && about.suggestions.length > 0) {
            lines.push('Did you mean:');
            for (const s of about.suggestions) {
                lines.push(`  ${s.name} (${s.type}) - ${s.file}:${s.line}`);
                lines.push(`    ${s.usageCount} usages`);
            }
        }
        return lines.join('\n');
    }

    const lines = [];
    const sym = about.symbol;
    const { expand, root, depth } = options;

    // Depth=0: location only
    if (depth === '0') {
        return `${sym.file}:${sym.startLine}`;
    }

    // Depth=1: location + signature + usage counts
    if (depth === '1') {
        lines.push(`${sym.file}:${sym.startLine}`);
        if (sym.signature) {
            lines.push(sym.signature);
        }
        lines.push(`(${about.totalUsages} usages: ${about.usages.calls} calls, ${about.usages.imports} imports, ${about.usages.references} refs)`);
        return lines.join('\n');
    }

    // Header with signature
    lines.push(`${sym.name} (${sym.type})`);
    lines.push('═'.repeat(60));
    lines.push(`${sym.file}:${sym.startLine}-${sym.endLine}`);
    if (sym.signature) {
        lines.push(sym.signature);
    }
    if (sym.docstring) {
        lines.push(`"${sym.docstring}"`);
    }

    // Warnings (show early for visibility)
    if (about.warnings && about.warnings.length > 0) {
        for (const w of about.warnings) {
            lines.push(`  Note: ${w.message}`);
        }
    }

    // Usage summary
    lines.push('');
    lines.push(`USAGES: ${about.totalUsages} total`);
    lines.push(`  ${about.usages.calls} calls, ${about.usages.imports} imports, ${about.usages.references} references`);

    // Callers
    let aboutTruncated = false;
    if (about.callers.total > 0) {
        lines.push('');
        if (about.callers.total > about.callers.top.length) {
            lines.push(`CALLERS (showing ${about.callers.top.length} of ${about.callers.total}):`);
            aboutTruncated = true;
        } else {
            lines.push(`CALLERS (${about.callers.total}):`);
        }
        for (const c of about.callers.top) {
            const caller = c.callerName ? `[${c.callerName}]` : '';
            lines.push(`  ${c.file}:${c.line} ${caller}`);
            lines.push(`    ${c.expression}`);
        }
    }

    // Callees
    if (about.callees.total > 0) {
        lines.push('');
        if (about.callees.total > about.callees.top.length) {
            lines.push(`CALLEES (showing ${about.callees.top.length} of ${about.callees.total}):`);
            aboutTruncated = true;
        } else {
            lines.push(`CALLEES (${about.callees.total}):`);
        }
        for (const c of about.callees.top) {
            const weight = c.weight !== 'normal' ? `[${c.weight}]` : '';
            lines.push(`  ${c.name} ${weight} - ${c.file}:${c.line} (${c.callCount}x)`);

            // Inline expansion: show first 3 lines of callee code
            if (expand && root && c.file && c.startLine) {
                try {
                    const filePath = path.isAbsolute(c.file) ? c.file : path.join(root, c.file);
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const fileLines = content.split('\n');
                    const endLine = c.endLine || c.startLine + 5;
                    const previewLines = Math.min(3, endLine - c.startLine + 1);
                    for (let i = 0; i < previewLines && c.startLine - 1 + i < fileLines.length; i++) {
                        const codeLine = fileLines[c.startLine - 1 + i];
                        lines.push(`      │ ${codeLine}`);
                    }
                    if (endLine - c.startLine + 1 > 3) {
                        lines.push(`      │ ... (${endLine - c.startLine - 2} more lines)`);
                    }
                } catch (e) {
                    // Skip expansion on error
                }
            }
        }
    }

    // Tests
    if (about.tests.totalMatches > 0) {
        lines.push('');
        if (about.tests.fileCount > about.tests.files.length) {
            lines.push(`TESTS: ${about.tests.totalMatches} matches in ${about.tests.fileCount} file(s), showing ${about.tests.files.length}:`);
            aboutTruncated = true;
        } else {
            lines.push(`TESTS: ${about.tests.totalMatches} matches in ${about.tests.fileCount} file(s)`);
        }
        for (const f of about.tests.files) {
            lines.push(`  ${f}`);
        }
    }

    // Other definitions
    if (about.otherDefinitions.length > 0) {
        lines.push('');
        lines.push(`OTHER DEFINITIONS (${about.otherDefinitions.length}):`);
        for (const d of about.otherDefinitions) {
            lines.push(`  ${d.file}:${d.line} (${d.usageCount} usages)`);
        }
    }

    // Types
    if (about.types && about.types.length > 0) {
        lines.push('');
        lines.push('TYPES:');
        for (const t of about.types) {
            lines.push(`  ${t.name} (${t.type}) - ${t.file}:${t.line}`);
        }
    }

    // Completeness warnings
    if (about.completeness && about.completeness.warnings && about.completeness.warnings.length > 0) {
        lines.push('');
        for (const w of about.completeness.warnings) {
            lines.push(`Note: ${w.message}`);
        }
    }

    // Code
    if (about.code) {
        lines.push('');
        lines.push('─── CODE ───');
        lines.push(about.code);
    }

    if (aboutTruncated) {
        lines.push(`\nSome sections truncated. Use --all to show all.`);
    }

    if (about.includeMethods === false) {
        lines.push(`\nNote: obj.method() callers/callees excluded (--include-methods=false). Remove flag to include them (default).`);
    }

    return lines.join('\n');
}

/**
 * Format about command output - JSON
 */
function formatAboutJson(about) {
    if (!about) {
        return JSON.stringify({ found: false, error: 'Symbol not found' }, null, 2);
    }
    return JSON.stringify(about, null, 2);
}

/**
 * Format example result as text
 */
function formatExample(result, name) {
    if (!result) return `No call examples found for "${name}"`;

    const best = result.best;
    const lines = [];
    lines.push(`Best example of "${name}":`);
    lines.push('═'.repeat(60));
    lines.push(`${best.relativePath}:${best.line}`);
    lines.push('');

    if (best.before) {
        for (let i = 0; i < best.before.length; i++) {
            const ln = best.line - best.before.length + i;
            lines.push(`${ln.toString().padStart(4)}| ${best.before[i]}`);
        }
    }

    lines.push(`${best.line.toString().padStart(4)}| ${best.content}  <--`);

    if (best.after) {
        for (let i = 0; i < best.after.length; i++) {
            const ln = best.line + i + 1;
            lines.push(`${ln.toString().padStart(4)}| ${best.after[i]}`);
        }
    }

    lines.push('');
    lines.push(`Score: ${best.score} (${result.totalCalls} total calls)`);
    lines.push(`Why: ${best.reasons.length > 0 ? best.reasons.join(', ') : 'first available call'}`);

    return lines.join('\n');
}

// ============================================================================
// TEXT FORMATTERS (shared between CLI and MCP)
// ============================================================================

/**
 * Format toc command output
 * @param {object} toc - TOC data
 * @param {object} [options] - Formatting options
 * @param {string} [options.detailedHint] - Custom hint text for non-detailed mode
 * @param {string} [options.uncertainHint] - Custom hint text for uncertain references
 */
function formatToc(toc, options = {}) {
    const lines = [];
    const t = toc.totals;
    lines.push(`PROJECT: ${t.files} files, ${t.lines} lines`);
    lines.push(`  ${t.functions} functions, ${t.classes} types (classes/interfaces/enums), ${t.state} state objects`);

    const meta = toc.meta || {};
    const warnings = [];
    if (meta.dynamicImports) warnings.push(`${meta.dynamicImports} dynamic import(s)`);
    if (meta.uncertain) warnings.push(`${meta.uncertain} uncertain reference(s)`);
    if (warnings.length) {
        const uncertainSuffix = meta.uncertain && options.uncertainHint ? ` — ${options.uncertainHint}` : '';
        lines.push(`  Note: ${warnings.join(', ')}${uncertainSuffix}`);
    }

    if (toc.summary) {
        if (toc.summary.topFunctionFiles?.length) {
            const hint = toc.summary.topFunctionFiles.map(f => `${f.file} (${f.functions})`).join(', ');
            lines.push(`  Most functions: ${hint}`);
        }
        if (toc.summary.topLineFiles?.length) {
            const hint = toc.summary.topLineFiles.map(f => `${f.file} (${f.lines})`).join(', ');
            lines.push(`  Largest files: ${hint}`);
        }
        if (toc.summary.entryFiles?.length) {
            lines.push(`  Entry points: ${toc.summary.entryFiles.join(', ')}`);
        }
    }

    lines.push('═'.repeat(60));
    const hasDetail = toc.files.some(f => f.symbols);
    for (const file of toc.files) {
        const parts = [`${file.lines} lines`];
        if (file.functions) parts.push(`${file.functions} fn`);
        if (file.classes) parts.push(`${file.classes} types`);
        if (file.state) parts.push(`${file.state} state`);

        if (hasDetail) {
            lines.push(`\n${file.file} (${parts.join(', ')})`);
            if (file.symbols) {
                for (const fn of file.symbols.functions) {
                    lines.push(`  ${lineRange(fn.startLine, fn.endLine)} ${formatFunctionSignature(fn)}`);
                }
                for (const cls of file.symbols.classes) {
                    lines.push(`  ${lineRange(cls.startLine, cls.endLine)} ${formatClassSignature(cls)}`);
                }
            }
        } else {
            lines.push(`  ${file.file} — ${parts.join(', ')}`);
        }
    }

    if (!hasDetail) {
        const hint = options.detailedHint || 'Use detailed=true to list all functions and classes.';
        lines.push(`\n${hint}`);
    }

    return lines.join('\n');
}

/**
 * Format find command output
 */
function formatFind(symbols, query, top) {
    if (symbols.length === 0) {
        return `No symbols found for "${query}"`;
    }

    const lines = [];
    const limit = (top && top > 0) ? Math.min(symbols.length, top) : Math.min(symbols.length, 10);
    const hidden = symbols.length - limit;

    if (hidden > 0) {
        lines.push(`Found ${symbols.length} match(es) for "${query}" (showing top ${limit}):`);
    } else {
        lines.push(`Found ${symbols.length} match(es) for "${query}":`);
    }
    lines.push('─'.repeat(60));

    for (let i = 0; i < limit; i++) {
        const s = symbols[i];
        const sig = s.params !== undefined
            ? formatFunctionSignature(s)
            : formatClassSignature(s);
        lines.push(`${s.relativePath}:${s.startLine}  ${sig}`);
        if (s.usageCounts !== undefined) {
            const c = s.usageCounts;
            const parts = [];
            if (c.calls > 0) parts.push(`${c.calls} calls`);
            if (c.definitions > 0) parts.push(`${c.definitions} def`);
            if (c.imports > 0) parts.push(`${c.imports} imports`);
            if (c.references > 0) parts.push(`${c.references} refs`);
            lines.push(`  (${c.total} usages: ${parts.join(', ')})`);
        } else if (s.usageCount !== undefined) {
            lines.push(`  (${s.usageCount} usages)`);
        }
    }

    if (hidden > 0) {
        lines.push(`... ${hidden} more result(s).`);
    }

    return lines.join('\n');
}

/**
 * Format usages command output
 */
function formatUsages(usages, name) {
    const defs = usages.filter(u => u.isDefinition);
    const calls = usages.filter(u => u.usageType === 'call');
    const imports = usages.filter(u => u.usageType === 'import');
    const refs = usages.filter(u => !u.isDefinition && u.usageType === 'reference');

    const lines = [];
    lines.push(`Usages of "${name}": ${defs.length} definitions, ${calls.length} calls, ${imports.length} imports, ${refs.length} references`);
    lines.push('═'.repeat(60));

    function renderContextLines(usage) {
        if (usage.before && usage.before.length > 0) {
            for (const line of usage.before) {
                lines.push(`      ${line}`);
            }
        }
    }

    function renderAfterLines(usage) {
        if (usage.after && usage.after.length > 0) {
            for (const line of usage.after) {
                lines.push(`      ${line}`);
            }
        }
    }

    if (defs.length > 0) {
        lines.push('\nDEFINITIONS:');
        for (const d of defs) {
            lines.push(`  ${d.relativePath}:${d.line || d.startLine}`);
            if (d.signature) lines.push(`    ${d.signature}`);
        }
    }

    if (calls.length > 0) {
        lines.push('\nCALLS:');
        for (const c of calls) {
            lines.push(`  ${c.relativePath}:${c.line}`);
            renderContextLines(c);
            lines.push(`    ${c.content.trim()}`);
            renderAfterLines(c);
        }
    }

    if (imports.length > 0) {
        lines.push('\nIMPORTS:');
        for (const i of imports) {
            lines.push(`  ${i.relativePath}:${i.line}`);
            lines.push(`    ${i.content.trim()}`);
        }
    }

    if (refs.length > 0) {
        lines.push('\nREFERENCES:');
        for (const r of refs) {
            lines.push(`  ${r.relativePath}:${r.line}`);
            renderContextLines(r);
            lines.push(`    ${r.content.trim()}`);
            renderAfterLines(r);
        }
    }

    return lines.join('\n');
}

/**
 * Format context command output
 * Returns { text, expandable } where expandable is an array of items for ucn_expand
 * @param {object} ctx - Context data
 * @param {object} [options] - Formatting options
 * @param {string} [options.methodsHint] - Custom hint for excluded method calls
 * @param {string} [options.expandHint] - Custom hint for expand command
 * @param {string} [options.uncertainHint] - Custom hint for uncertain calls
 */
function formatContext(ctx, options = {}) {
    if (!ctx) return { text: 'Symbol not found.', expandable: [] };

    const expandHint = options.expandHint || 'Use ucn_expand with item number to see code for any item.';
    const methodsHint = options.methodsHint || 'Note: obj.method() calls excluded. Use include_methods=true to include them.';

    const lines = [];
    const expandable = [];
    let itemNum = 1;

    // Handle struct/interface types
    if (ctx.type && ['class', 'struct', 'interface', 'type'].includes(ctx.type)) {
        lines.push(`Context for ${ctx.type} ${ctx.name}:`);
        lines.push('═'.repeat(60));

        if (ctx.warnings && ctx.warnings.length > 0) {
            for (const w of ctx.warnings) {
                lines.push(`  Note: ${w.message}`);
            }
        }

        const methods = ctx.methods || [];
        lines.push(`\nMETHODS (${methods.length}):`);
        for (const m of methods) {
            const receiver = m.receiver ? `(${m.receiver}) ` : '';
            const params = m.params || '...';
            const returnType = m.returnType ? `: ${m.returnType}` : '';
            lines.push(`  [${itemNum}] ${receiver}${m.name}(${params})${returnType}`);
            lines.push(`    ${m.file}:${m.line}`);
            expandable.push({
                num: itemNum++,
                type: 'method',
                name: m.name,
                file: m.file,
                relativePath: m.file,
                startLine: m.line,
                endLine: m.endLine || m.line
            });
        }

        const callers = ctx.callers || [];
        lines.push(`\nCALLERS (${callers.length}):`);
        for (const c of callers) {
            const callerName = c.callerName ? ` [${c.callerName}]` : '';
            lines.push(`  [${itemNum}] ${c.relativePath}:${c.line}${callerName}`);
            lines.push(`    ${c.content.trim()}`);
            expandable.push({
                num: itemNum++,
                type: 'caller',
                name: c.callerName || '(module level)',
                file: c.callerFile || c.file,
                relativePath: c.relativePath,
                line: c.line,
                startLine: c.callerStartLine || c.line,
                endLine: c.callerEndLine || c.line
            });
        }

        if (expandable.length > 0) {
            lines.push(`\n${expandHint}`);
        }

        return { text: lines.join('\n'), expandable };
    }

    // Standard function/method context
    lines.push(`Context for ${ctx.function}:`);
    lines.push('═'.repeat(60));

    if (ctx.meta) {
        const notes = [];
        if (ctx.meta.dynamicImports) notes.push(`${ctx.meta.dynamicImports} dynamic import(s)`);
        if (ctx.meta.uncertain) notes.push(`${ctx.meta.uncertain} uncertain call(s) skipped`);
        if (notes.length) {
            const uncertainSuffix = ctx.meta.uncertain && options.uncertainHint ? ` — ${options.uncertainHint}` : '';
            lines.push(`  Note: ${notes.join(', ')}${uncertainSuffix}`);
        }
    }

    if (ctx.meta && !ctx.meta.includeMethods) {
        lines.push(`  ${methodsHint}`);
    }

    if (ctx.warnings && ctx.warnings.length > 0) {
        for (const w of ctx.warnings) {
            lines.push(`  Note: ${w.message}`);
        }
    }

    const callers = ctx.callers || [];
    lines.push(`\nCALLERS (${callers.length}):`);
    for (const c of callers) {
        const callerName = c.callerName ? ` [${c.callerName}]` : '';
        lines.push(`  [${itemNum}] ${c.relativePath}:${c.line}${callerName}`);
        lines.push(`    ${c.content.trim()}`);
        expandable.push({
            num: itemNum++,
            type: 'caller',
            name: c.callerName || '(module level)',
            file: c.callerFile || c.file,
            relativePath: c.relativePath,
            line: c.line,
            startLine: c.callerStartLine || c.line,
            endLine: c.callerEndLine || c.line
        });
    }

    // Structural hint: class methods may have callers through constructed/injected instances
    // that static analysis can't track. Only show when caller count is low (≤3) to avoid noise.
    if (ctx.meta && (ctx.meta.isMethod || ctx.meta.className || ctx.meta.receiver) && callers.length <= 3) {
        lines.push(`  Note: ${ctx.function} is a class/struct method — additional callers through constructed or injected instances are not tracked by static analysis.`);
    }

    const callees = ctx.callees || [];
    lines.push(`\nCALLEES (${callees.length}):`);
    for (const c of callees) {
        const weight = c.weight && c.weight !== 'normal' ? ` [${c.weight}]` : '';
        lines.push(`  [${itemNum}] ${c.name}${weight} - ${c.relativePath}:${c.startLine}`);
        expandable.push({
            num: itemNum++,
            type: 'callee',
            name: c.name,
            file: c.file,
            relativePath: c.relativePath,
            startLine: c.startLine,
            endLine: c.endLine
        });
    }

    if (expandable.length > 0) {
        lines.push(`\n${expandHint}`);
    }

    return { text: lines.join('\n'), expandable };
}

/**
 * Format smart command output
 * @param {object} smart - Smart extraction result
 * @param {object} [options] - Formatting options
 * @param {string} [options.uncertainHint] - Custom hint for uncertain calls
 */
function formatSmart(smart, options = {}) {
    if (!smart) return 'Function not found.';

    const lines = [];
    lines.push(`${smart.target.name} (${smart.target.file}:${smart.target.startLine})`);
    lines.push('═'.repeat(60));

    if (smart.meta) {
        const notes = [];
        if (smart.meta.dynamicImports) notes.push(`${smart.meta.dynamicImports} dynamic import(s)`);
        if (smart.meta.uncertain) notes.push(`${smart.meta.uncertain} uncertain call(s) skipped`);
        if (notes.length) {
            const uncertainSuffix = smart.meta.uncertain && options.uncertainHint ? ` — ${options.uncertainHint}` : '';
            lines.push(`  Note: ${notes.join(', ')}${uncertainSuffix}`);
        }
    }

    lines.push(smart.target.code);

    if (smart.dependencies.length > 0) {
        lines.push('\n─── DEPENDENCIES ───');
        for (const dep of smart.dependencies) {
            const weight = dep.weight && dep.weight !== 'normal' ? ` [${dep.weight}]` : '';
            lines.push(`\n// ${dep.name}${weight} (${dep.relativePath}:${dep.startLine})`);
            lines.push(dep.code);
        }
    }

    if (smart.types && smart.types.length > 0) {
        lines.push('\n─── TYPES ───');
        for (const t of smart.types) {
            lines.push(`\n// ${t.name} (${t.relativePath}:${t.startLine})`);
            lines.push(t.code);
        }
    }

    return lines.join('\n');
}

/**
 * Format deadcode command output
 * @param {Array} results - Dead code results
 * @param {object} [options] - Formatting options
 * @param {string} [options.exportedHint] - Hint about exported symbols exclusion
 */
function formatDeadcode(results, options = {}) {
    if (results.length === 0 && !results.excludedDecorated && !results.excludedExported) {
        return 'No dead code found.';
    }

    const lines = [];
    if (results.length > 0) {
        lines.push(`Dead code: ${results.length} unused symbol(s)\n`);
    }

    let currentFile = null;
    for (const item of results) {
        if (item.file !== currentFile) {
            currentFile = item.file;
            lines.push(item.file);
        }
        const exported = item.isExported ? ' [exported]' : '';
        // Surface decorators/annotations — structural hint that a framework may invoke this
        const hints = [];
        if (item.decorators && item.decorators.length > 0) {
            hints.push(...item.decorators.map(d => `@${d}`));
        }
        if (item.annotations && item.annotations.length > 0) {
            hints.push(...item.annotations.map(a => `@${a}`));
        }
        const hintStr = hints.length > 0 ? ` [has ${hints.join(', ')}]` : '';
        lines.push(`  ${lineRange(item.startLine, item.endLine)} ${item.name} (${item.type})${exported}${hintStr}`);
    }

    // Show counts of excluded items with expansion hints
    if (results.excludedDecorated > 0) {
        const decoratedHint = options.decoratedHint || `${results.excludedDecorated} decorated/annotated symbol(s) hidden (framework-registered). Use --include-decorated to include them.`;
        lines.push(`\n${decoratedHint}`);
    }
    if (results.excludedExported > 0) {
        const exportedHint = options.exportedHint || `${results.excludedExported} exported symbol(s) hidden. Use --include-exported to include them.`;
        lines.push(`\n${exportedHint}`);
    }

    if (results.length === 0 && lines.length === 0) {
        return 'No dead code found.';
    }

    return lines.join('\n');
}

/**
 * Format fn command output
 */
function formatFn(match, fnCode) {
    const lines = [];
    lines.push(`${match.relativePath}:${match.startLine}`);
    lines.push(`${lineRange(match.startLine, match.endLine)} ${formatFunctionSignature(match)}`);
    lines.push('─'.repeat(60));
    lines.push(fnCode);
    return lines.join('\n');
}

/**
 * Format class command output
 */
function formatClass(cls, clsCode) {
    const lines = [];
    lines.push(`${cls.relativePath || cls.file}:${cls.startLine}`);
    lines.push(`${lineRange(cls.startLine, cls.endLine)} ${formatClassSignature(cls)}`);
    lines.push('─'.repeat(60));
    lines.push(clsCode);
    return lines.join('\n');
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
    if (graph.nodes.length === 0) {
        const file = options.file || graph.root || '';
        return file ? `File not found: ${file}` : 'File not found.';
    }

    const rootEntry = graph.nodes.find(n => n.file === graph.root);
    const rootRelPath = rootEntry ? rootEntry.relativePath : graph.root;
    const lines = [];

    const showAll = options.showAll || false;
    const maxChildren = showAll ? Infinity : 8;
    const maxDepth = options.maxDepth !== undefined ? options.maxDepth : Infinity;

    function printTree(nodes, edges, rootFile) {
        const visited = new Set();     // all nodes ever printed (for diamond dep detection)
        const ancestors = new Set();   // current path from root (for true circular detection)
        let truncatedNodes = 0;
        let depthLimited = false;

        function printNode(file, indent = 0) {
            const fileEntry = nodes.find(n => n.file === file);
            const relPath = fileEntry ? fileEntry.relativePath : file;
            const prefix = indent === 0 ? '' : '  '.repeat(indent - 1) + '├── ';

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

            for (const edge of displayEdges) {
                printNode(edge.to, indent + 1);
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

        lines.push(`\nIMPORTS (what this file depends on): ${importCount} files`);
        if (importCount > 0) {
            printTree(graph.imports.nodes, graph.imports.edges, graph.root);
        } else {
            lines.push('  (none)');
        }

        lines.push(`\nIMPORTERS (what depends on this file): ${importerCount} files`);
        if (importerCount > 0) {
            printTree(graph.importers.nodes, graph.importers.edges, graph.root);
        } else {
            lines.push('  (none)');
        }
    } else {
        lines.push(`Dependency graph for ${rootRelPath}`);
        lines.push('═'.repeat(60));

        const { truncatedNodes, depthLimited } = printTree(graph.nodes, graph.edges, graph.root);

        if (depthLimited || truncatedNodes > 0) {
            lines.push('\n' + '─'.repeat(60));
            if (depthLimited) {
                lines.push(`Depth limited to ${maxDepth}. Use --depth=N for deeper graph.`);
            }
            if (truncatedNodes > 0) {
                lines.push(`${truncatedNodes} nodes hidden. Use --all to show all children. Graph has ${graph.nodes.length} total files.`);
            }
        }
    }

    return lines.join('\n');
}

/**
 * Format search command output
 */
function formatSearch(results, term) {
    const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
    if (totalMatches === 0) return `No matches found for "${term}"`;

    const lines = [];
    lines.push(`Found ${totalMatches} matches for "${term}" in ${results.length} files:`);
    lines.push('═'.repeat(60));

    for (const result of results) {
        lines.push(`\n${result.file}`);
        for (const m of result.matches) {
            if (m.before && m.before.length > 0) {
                for (const line of m.before) {
                    lines.push(`      ... ${line.trim()}`);
                }
            }
            lines.push(`  ${m.line}: ${m.content.trim()}`);
            if (m.after && m.after.length > 0) {
                for (const line of m.after) {
                    lines.push(`      ... ${line.trim()}`);
                }
            }
        }
    }

    return lines.join('\n');
}

/**
 * Format file-exports command output
 */
function formatFileExports(exports, filePath) {
    if (exports.length === 0) return `No exports found in ${filePath}`;

    const lines = [];
    lines.push(`Exports from ${filePath}:\n`);
    for (const exp of exports) {
        lines.push(`  ${lineRange(exp.startLine, exp.endLine)} ${exp.signature || exp.name}`);
    }
    return lines.join('\n');
}

/**
 * Format stats command output
 */
function formatStats(stats) {
    const lines = [];
    lines.push('PROJECT STATISTICS');
    lines.push('═'.repeat(60));
    lines.push(`Root: ${stats.root}`);
    lines.push(`Files: ${stats.files}`);
    lines.push(`Symbols: ${stats.symbols}`);
    lines.push(`Build time: ${stats.buildTime}ms`);

    lines.push('\nBy Language:');
    for (const [lang, info] of Object.entries(stats.byLanguage)) {
        lines.push(`  ${lang}: ${info.files} files, ${info.lines} lines, ${info.symbols} symbols`);
    }

    lines.push('\nBy Type:');
    for (const [type, count] of Object.entries(stats.byType)) {
        lines.push(`  ${type}: ${count}`);
    }

    return lines.join('\n');
}

// ============================================================================
// DIFF IMPACT
// ============================================================================

function formatDiffImpact(result) {
    if (!result) return 'No diff data.';

    const lines = [];

    lines.push(`Diff Impact Analysis (vs ${result.base})`);
    lines.push('═'.repeat(60));

    const s = result.summary;
    const parts = [];
    if (s.modifiedFunctions > 0) parts.push(`${s.modifiedFunctions} modified`);
    if (s.deletedFunctions > 0) parts.push(`${s.deletedFunctions} deleted`);
    if (s.newFunctions > 0) parts.push(`${s.newFunctions} new`);
    parts.push(`${s.totalCallSites} call sites across ${s.affectedFiles} files`);
    lines.push(parts.join(', '));
    lines.push('');

    // Modified functions
    if (result.functions.length > 0) {
        lines.push('MODIFIED FUNCTIONS:');
        for (const fn of result.functions) {
            lines.push(`\n  ${fn.name}`);
            lines.push(`  ${fn.relativePath}:${fn.startLine}`);
            lines.push(`  ${fn.signature}`);
            if (fn.addedLines.length > 0) {
                lines.push(`  Lines added: ${formatLineRanges(fn.addedLines)}`);
            }
            if (fn.deletedLines.length > 0) {
                lines.push(`  Lines deleted: ${formatLineRanges(fn.deletedLines)}`);
            }

            if (fn.callers.length > 0) {
                lines.push(`  Callers (${fn.callers.length}):`);
                for (const c of fn.callers) {
                    const caller = c.callerName ? `[${c.callerName}]` : '';
                    lines.push(`    ${c.relativePath}:${c.line} ${caller}`);
                    lines.push(`      ${c.content}`);
                }
            } else {
                lines.push('  Callers: none found');
            }
        }
    }

    // New functions
    if (result.newFunctions.length > 0) {
        lines.push('\nNEW FUNCTIONS:');
        for (const fn of result.newFunctions) {
            lines.push(`  ${fn.name} — ${fn.relativePath}:${fn.startLine}`);
            lines.push(`  ${fn.signature}`);
        }
    }

    // Deleted functions
    if (result.deletedFunctions.length > 0) {
        lines.push('\nDELETED FUNCTIONS:');
        for (const fn of result.deletedFunctions) {
            lines.push(`  ${fn.name} — ${fn.relativePath}:${fn.startLine}`);
        }
    }

    // Module-level changes
    if (result.moduleLevelChanges.length > 0) {
        lines.push('\nMODULE-LEVEL CHANGES:');
        for (const m of result.moduleLevelChanges) {
            const changeParts = [];
            if (m.addedLines.length > 0) changeParts.push(`+${m.addedLines.length} lines`);
            if (m.deletedLines.length > 0) changeParts.push(`-${m.deletedLines.length} lines`);
            lines.push(`  ${m.relativePath}: ${changeParts.join(', ')}`);
        }
    }

    return lines.join('\n');
}

/**
 * Compact display of line numbers, collapsing consecutive ranges
 */
function formatLineRanges(lineNums) {
    if (lineNums.length === 0) return '';
    const sorted = [...lineNums].sort((a, b) => a - b);
    const ranges = [];
    let start = sorted[0], end = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === end + 1) {
            end = sorted[i];
        } else {
            ranges.push(start === end ? `${start}` : `${start}-${end}`);
            start = end = sorted[i];
        }
    }
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
    return ranges.join(', ');
}

function formatDiffImpactJson(result) {
    return JSON.stringify(result, null, 2);
}

module.exports = {
    // Utilities
    normalizeParams,
    lineNum,
    lineRange,
    lineLoc,
    formatFunctionSignature,
    formatClassSignature,
    formatMemberSignature,

    // Text output
    header,
    subheader,
    printUsage,
    printDefinition,

    // JSON formatters
    formatTocJson,
    formatSymbolJson,
    formatUsagesJson,
    formatContextJson,
    formatFunctionJson,
    formatSearchJson,
    formatImportsJson,
    formatStatsJson,
    formatGraphJson,
    formatSmartJson,

    // New formatters (v2 migration)
    formatImports,
    formatExporters,
    formatTypedef,
    formatTests,
    formatApi,
    formatDisambiguation,
    formatExportersJson,
    formatTypedefJson,
    formatTestsJson,
    formatApiJson,

    // About command
    formatAbout,
    formatAboutJson,

    // Impact command
    formatImpact,
    formatImpactJson,

    // Plan command
    formatPlan,

    // Stack trace command
    formatStackTrace,

    // Verify command
    formatVerify,

    // Trace command
    formatTrace,
    formatTraceJson,

    // Related command
    formatRelated,
    formatRelatedJson,

    // Example command
    formatExample,

    // Shared text formatters (CLI + MCP)
    formatToc,
    formatFind,
    formatUsages,
    formatContext,
    formatSmart,
    formatDeadcode,
    formatFn,
    formatClass,
    formatGraph,
    formatSearch,
    formatFileExports,
    formatStats,

    // Diff impact command
    formatDiffImpact,
    formatDiffImpactJson
};
