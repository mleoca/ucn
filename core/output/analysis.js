/**
 * core/output/analysis.js - Understanding/analysis formatters
 */
const fs = require('fs');
const path = require('path');
const { langTraits } = require('../../languages');
const { dynamicImportsNote } = require('./shared');

/** Format context (callers + callees) as JSON */
function formatContextJson(context) {
    const meta = context.meta || { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0 };
    // Handle struct/interface types differently
    if (context.type && ['class', 'struct', 'interface', 'type'].includes(context.type)) {
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
                callerName: c.callerName,
                ...(c.confidence != null && { confidence: c.confidence, resolution: c.resolution }),
            })),
            callees: callees.map(c => ({
                name: c.name,
                type: c.type,
                file: c.relativePath || c.file,
                line: c.startLine,
                params: c.params,  // FULL params
                weight: c.weight || 'normal',  // Dependency weight: core, setup, utility
                ...(c.confidence != null && { confidence: c.confidence, resolution: c.resolution }),
            })),
            ...(context.warnings && { warnings: context.warnings })
        }
    });
}

/**
 * Format context command output.
 * Returns { text, expandable } where expandable is an array of items for expand.
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
                file: null,
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
        if (ctx.meta.dynamicImports) { const dn = dynamicImportsNote(ctx.meta.dynamicImports, ctx.meta); if (dn) notes.push(dn); }
        if (ctx.meta.uncertain) notes.push(`${ctx.meta.uncertain} uncertain call(s) skipped`);
        if (ctx.meta.confidenceFiltered) notes.push(`${ctx.meta.confidenceFiltered} edge(s) below confidence threshold hidden`);
        if (notes.length) {
            const uncertainSuffix = ctx.meta.uncertain && options.uncertainHint ? ` — ${options.uncertainHint}` : '';
            lines.push(`  Note: ${notes.join(', ')}${uncertainSuffix}`);
        }
    }

    if (ctx.meta && ctx.meta.includeMethods === false) {
        lines.push(`  ${methodsHint}`);
    }

    if (ctx.warnings && ctx.warnings.length > 0) {
        for (const w of ctx.warnings) {
            lines.push(`  Note: ${w.message}`);
        }
    }

    const showConf = options.showConfidence || false;
    const callers = ctx.callers || [];
    lines.push(`\nCALLERS (${callers.length}):`);
    for (const c of callers) {
        const callerName = c.callerName ? ` [${c.callerName}]` : '';
        lines.push(`  [${itemNum}] ${c.relativePath}:${c.line}${callerName}`);
        lines.push(`    ${c.content.trim()}`);
        if (showConf && c.confidence != null) {
            lines.push(`    confidence: ${c.confidence.toFixed(2)} (${c.resolution})`);
        }
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
        if (showConf && c.confidence != null) {
            lines.push(`    confidence: ${c.confidence.toFixed(2)} (${c.resolution})`);
        }
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

/** Format impact command output - text. Shows what would need updating if a function signature changes. */
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
    if (impact.shownCallSites !== undefined && impact.shownCallSites < impact.totalCallSites) {
        lines.push(`CALL SITES: ${impact.shownCallSites} shown of ${impact.totalCallSites} total`);
    } else {
        lines.push(`CALL SITES: ${impact.totalCallSites}`);
    }
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

    // Scope pollution warning
    if (impact.scopeWarning) {
        lines.push(`  Note: ${impact.scopeWarning.hint}`);
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

/** Format impact command output - JSON */
function formatImpactJson(impact) {
    if (!impact) {
        return JSON.stringify({ found: false, error: 'Function not found' }, null, 2);
    }
    return JSON.stringify(impact, null, 2);
}

/** Format about command output - text. The "tell me everything" output for AI agents. */
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
    if (depth !== null && depth !== undefined && Number(depth) === 0) {
        return `${sym.file}:${sym.startLine}`;
    }

    // Depth=1: location + signature + usage counts
    if (depth !== null && depth !== undefined && Number(depth) === 1) {
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
    if (about.confidenceFiltered) {
        lines.push(`  Note: ${about.confidenceFiltered} edge(s) below confidence threshold hidden`);
    }

    // Usage summary
    lines.push('');
    lines.push(`USAGES: ${about.totalUsages} total`);
    lines.push(`  ${about.usages.calls} calls, ${about.usages.imports} imports, ${about.usages.references} references`);

    // Callers
    const showConf = options.showConfidence || false;
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
            if (showConf && c.confidence != null) {
                lines.push(`    confidence: ${c.confidence.toFixed(2)} (${c.resolution})`);
            }
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
            const weight = c.weight && c.weight !== 'normal' ? ` [${c.weight}]` : '';
            lines.push(`  ${c.name}${weight} - ${c.file}:${c.line} (${c.callCount}x)`);
            if (showConf && c.confidence != null) {
                lines.push(`    confidence: ${c.confidence.toFixed(2)} (${c.resolution})`);
            }

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

    // Completeness warnings (condensed single line)
    if (about.completeness && about.completeness.warnings && about.completeness.warnings.length > 0) {
        const lang = about.completeness?.projectLanguage;
        const parts = about.completeness.warnings.map(w => {
            if (w.type === 'dynamic_imports' && lang && !langTraits(lang)?.hasDynamicImports) return `${w.count} blank/dot import(s)`;
            return `${w.count} ${w.type.replace('_', ' ')}`;
        });
        lines.push('');
        lines.push(`Note: Results may be incomplete (${parts.join(', ')} in project)`);
    }

    // Code
    if (about.code) {
        lines.push('');
        lines.push('─── CODE ───');
        lines.push(about.code);
    }

    if (aboutTruncated) {
        const allHint = options.allHint || 'Use --all to show all.';
        lines.push(`\nSome sections truncated. ${allHint}`);
    }

    if (about.includeMethods === false) {
        const methodsHint = options.methodsHint || 'Note: obj.method() callers/callees excluded — use --include-methods to include them';
        lines.push(`\n${methodsHint}`);
    }

    return lines.join('\n');
}

/** Format about command output - JSON */
function formatAboutJson(about) {
    if (!about) {
        return JSON.stringify({ found: false, error: 'Symbol not found' }, null, 2);
    }
    return JSON.stringify(about, null, 2);
}

module.exports = {
    formatContext,
    formatContextJson,
    formatImpact,
    formatImpactJson,
    formatAbout,
    formatAboutJson,
};
