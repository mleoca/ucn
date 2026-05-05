/**
 * core/output/analysis.js - Understanding/analysis formatters
 */
const fs = require('fs');
const path = require('path');
const { langTraits } = require('../../languages');
const { dynamicImportsNote } = require('./shared');

/**
 * One short sentence (~80 chars) of a docstring, suitable for inline display
 * in caller/callee listings.
 */
function calleeDocstringSnippet(text) {
    if (!text) return null;
    const trimmed = text.trim();
    const m = trimmed.match(/^(.+?[.!?])(?:\s|$)/);
    let s = m ? m[1] : trimmed;
    if (s.length > 80) s = s.slice(0, 77) + '...';
    return s;
}

/**
 * Render a single-line confidence histogram for caller/callee sections.
 * Returns null when there are <= 1 edges (not informative).
 *
 * @param {{high:number, medium:number, low:number, total:number}|null} h
 * @returns {string|null}
 */
function formatHistogramLine(h) {
    if (!h || h.total <= 1) return null;
    return `  confidence: ${h.high} high (>0.8), ${h.medium} medium (0.5-0.8), ${h.low} low (<0.5)`;
}

/**
 * Decide whether the formatter should print reachability markers per item.
 * To reduce noise, markers only appear when at least one item is unreachable.
 *
 * @param {Array} items - Caller or callee objects with `reachable` field
 * @returns {boolean}
 */
function shouldShowReachability(items) {
    if (!items || items.length === 0) return false;
    return items.some(c => c.reachable === false);
}

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
            callerHistogram: context.callerHistogram || null,
            calleeHistogram: context.calleeHistogram || null,
            callers: callers.map(c => ({
                file: c.relativePath || c.file,
                line: c.line,
                expression: c.content,  // FULL expression
                callerName: c.callerName,
                ...(c.confidence != null && { confidence: c.confidence, resolution: c.resolution }),
                ...(c.reachable !== undefined && { reachable: c.reachable }),
            })),
            callees: callees.map(c => ({
                name: c.name,
                type: c.type,
                file: c.relativePath || c.file,
                line: c.startLine,
                params: c.params,  // FULL params
                weight: c.weight || 'normal',  // Dependency weight: core, setup, utility
                ...(c.confidence != null && { confidence: c.confidence, resolution: c.resolution }),
                ...(c.reachable !== undefined && { reachable: c.reachable }),
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

    const expandHint = options.expandHint != null ? options.expandHint : 'Use ucn_expand with item number to see code for any item.';
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
    const compact = !!options.compact;
    if (compact) {
        lines.push(`Context: ${ctx.function}`);
    } else {
        lines.push(`Context for ${ctx.function}:`);
        lines.push('═'.repeat(60));
    }

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
    lines.push(`${compact ? '' : '\n'}CALLERS (${callers.length}):`);
    const callerHistLine = showConf ? formatHistogramLine(ctx.callerHistogram) : null;
    if (callerHistLine) lines.push(callerHistLine);
    const showCallerReach = shouldShowReachability(callers);
    for (const c of callers) {
        const callerName = c.callerName ? ` [${c.callerName}]` : '';
        if (compact) {
            // One line per caller: "[N] file:line [callerName]: expression"
            const expr = c.content ? c.content.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
            lines.push(`  [${itemNum}] ${c.relativePath}:${c.line}${callerName}: ${expr}`);
        } else {
            lines.push(`  [${itemNum}] ${c.relativePath}:${c.line}${callerName}`);
            lines.push(`    ${c.content.trim()}`);
        }
        if (showConf && c.confidence != null && !compact) {
            lines.push(`    confidence: ${c.confidence.toFixed(2)} (${c.resolution})`);
        }
        if (showCallerReach && c.reachable === false && !compact) {
            lines.push('    (unreachable from any entry point)');
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
    lines.push(`${compact ? '' : '\n'}CALLEES (${callees.length}):`);
    const calleeHistLine = showConf ? formatHistogramLine(ctx.calleeHistogram) : null;
    if (calleeHistLine && !compact) lines.push(calleeHistLine);
    const showCalleeReach = shouldShowReachability(callees);
    for (const c of callees) {
        const weight = c.weight && c.weight !== 'normal' ? ` [${c.weight}]` : '';
        const returnSuffix = c.returnType ? ` → ${c.returnType}` : '';
        const sideEffects = (c.sideEffects && c.sideEffects.length) ? ` {${c.sideEffects.join(',')}}` : '';
        if (compact) {
            const snip = c.docstring ? calleeDocstringSnippet(c.docstring) : '';
            const docPart = snip ? `: ${snip}` : '';
            lines.push(`  [${itemNum}] ${c.name}${returnSuffix}${sideEffects} - ${c.relativePath}:${c.startLine}${docPart}`);
        } else {
            lines.push(`  [${itemNum}] ${c.name}${weight}${returnSuffix}${sideEffects} - ${c.relativePath}:${c.startLine}`);
            if (c.docstring) {
                const snip = calleeDocstringSnippet(c.docstring);
                if (snip) lines.push(`    "${snip}"`);
            }
        }
        if (showConf && c.confidence != null && !compact) {
            lines.push(`    confidence: ${c.confidence.toFixed(2)} (${c.resolution})`);
        }
        if (showCalleeReach && c.reachable === false && !compact) {
            lines.push('    (unreachable from any entry point)');
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

    const compact = !!options.compact;
    const lines = [];

    // Header
    lines.push(`Impact analysis for ${impact.function}`);
    if (!compact) lines.push('═'.repeat(60));
    lines.push(`${impact.file}:${impact.startLine}`);
    if (!compact) lines.push(impact.signature);
    if (!compact) lines.push('');

    // Summary
    if (impact.shownCallSites !== undefined && impact.shownCallSites < impact.totalCallSites) {
        lines.push(`CALL SITES: ${impact.shownCallSites} shown of ${impact.totalCallSites} total`);
    } else {
        lines.push(`CALL SITES: ${impact.totalCallSites}`);
    }
    lines.push(`  Files affected: ${impact.byFile.length}`);

    // Patterns
    const p = impact.patterns;
    if (p && !compact) {
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
    if (!compact) lines.push('');
    lines.push('BY FILE:');

    // Histogram (over the trust signals collected before truncation)
    const impactHistLine = formatHistogramLine(impact.callerHistogram);
    if (impactHistLine) lines.push(impactHistLine);

    // Compute reachability marker visibility across ALL sites (not per-file)
    const allSites = impact.byFile.flatMap(g => g.sites);
    const showImpactReach = shouldShowReachability(allSites);

    for (const fileGroup of impact.byFile) {
        if (compact) {
            // One line per call site, prefixed with file: "file (N) line [caller]: expr"
            for (const site of fileGroup.sites) {
                const caller = site.callerName ? ` [${site.callerName}]` : '';
                const expr = site.expression ? site.expression.replace(/\s+/g, ' ').slice(0, 100) : '';
                const reach = (showImpactReach && site.reachable === false) ? ' (unreachable)' : '';
                lines.push(`  ${fileGroup.file}:${site.line}${caller}${reach}: ${expr}`);
            }
        } else {
            lines.push(`\n${fileGroup.file} (${fileGroup.count} calls)`);
            for (const site of fileGroup.sites) {
                const caller = site.callerName ? `[${site.callerName}]` : '';
                lines.push(`  :${site.line} ${caller}`);
                lines.push(`    ${site.expression}`);
                if (site.args && site.args.length > 0) {
                    lines.push(`    args: ${site.args.join(', ')}`);
                }
                if (showImpactReach && site.reachable === false) {
                    lines.push('    (unreachable from any entry point)');
                }
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

    const compact = !!options.compact;

    // Header with signature
    lines.push(`${sym.name} (${sym.type})`);
    if (!compact) lines.push('═'.repeat(60));
    lines.push(`${sym.file}:${sym.startLine}-${sym.endLine}${sym.handle ? '  →  ' + sym.handle : ''}`);
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
        const aboutCallerHist = showConf ? formatHistogramLine(about.callers.histogram) : null;
        if (aboutCallerHist) lines.push(aboutCallerHist);
        const showAboutCallerReach = shouldShowReachability(about.callers.top);
        for (const c of about.callers.top) {
            const caller = c.callerName ? `[${c.callerName}]` : '';
            lines.push(`  ${c.file}:${c.line} ${caller}`);
            lines.push(`    ${c.expression}`);
            if (showConf && c.confidence != null) {
                lines.push(`    confidence: ${c.confidence.toFixed(2)} (${c.resolution})`);
            }
            if (showAboutCallerReach && c.reachable === false) {
                lines.push('    (unreachable from any entry point)');
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
        const aboutCalleeHist = showConf ? formatHistogramLine(about.callees.histogram) : null;
        if (aboutCalleeHist) lines.push(aboutCalleeHist);
        const showAboutCalleeReach = shouldShowReachability(about.callees.top);
        for (const c of about.callees.top) {
            const weight = c.weight && c.weight !== 'normal' ? ` [${c.weight}]` : '';
            const returnSuffix = c.returnType ? ` → ${c.returnType}` : '';
            const sideEffects = (c.sideEffects && c.sideEffects.length) ? ` {${c.sideEffects.join(',')}}` : '';
            lines.push(`  ${c.name}${weight}${returnSuffix}${sideEffects} - ${c.file}:${c.line} (${c.callCount}x)`);
            if (c.docstring) {
                const snip = calleeDocstringSnippet(c.docstring);
                if (snip) lines.push(`    "${snip}"`);
            }
            if (showConf && c.confidence != null) {
                lines.push(`    confidence: ${c.confidence.toFixed(2)} (${c.resolution})`);
            }
            if (showAboutCalleeReach && c.reachable === false) {
                lines.push('    (unreachable from any entry point)');
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
