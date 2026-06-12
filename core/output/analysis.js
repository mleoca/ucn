/**
 * core/output/analysis.js - Understanding/analysis formatters
 */
const fs = require('fs');
const path = require('path');
const { langTraits } = require('../../languages');
const { dynamicImportsNote, formatGitLine, unverifiedReasonLabel } = require('./shared');

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

/**
 * Reachability display policy for a section: per-line [unreachable] markers
 * ONLY when reachability is mixed (they distinguish which); when ALL items are
 * unreachable a single aggregate note carries the information without
 * repeating a marker on every line. Suppressed entirely when the project has
 * no detected entry points (hasEntrypoints === false) — "unreachable" would
 * be meaningless for library code.
 *
 * @returns {{ perLine: boolean, note: string|null }}
 */
function reachabilityDisplay(items, hasEntrypoints, label) {
    if (hasEntrypoints === false || !items || items.length === 0) return { perLine: false, note: null };
    const unreachable = items.filter(c => c.reachable === false).length;
    if (unreachable === 0) return { perLine: false, note: null };
    if (unreachable === items.length) {
        return { perLine: false, note: `  Note: all ${unreachable} ${label}${unreachable === 1 ? '' : 's'} unreachable from any entry point` };
    }
    return { perLine: true, note: `  Note: ${unreachable} of ${items.length} ${label}s unreachable from any entry point` };
}

// Display order for resolution labels in evidence aggregates (most → least confident)
const RESOLUTION_ORDER = ['exact-binding', 'same-class', 'receiver-hint', 'scope-match', 'name-only', 'uncertain'];

/**
 * One aggregate evidence line per tier section, replacing per-edge confidence
 * decimals: uniform → "evidence: scope-match (all)"; mixed → counts in
 * RESOLUTION_ORDER. Returns null when no items carry a resolution.
 */
function formatEvidenceLine(items) {
    if (!items || items.length === 0) return null;
    const counts = new Map();
    for (const it of items) {
        if (!it.resolution) continue;
        counts.set(it.resolution, (counts.get(it.resolution) || 0) + 1);
    }
    if (counts.size === 0) return null;
    if (counts.size === 1) {
        return `  evidence: ${counts.keys().next().value} (all)`;
    }
    const parts = [];
    for (const r of RESOLUTION_ORDER) {
        if (counts.has(r)) parts.push(`${counts.get(r)} ${r}`);
    }
    for (const [r, n] of counts) {
        if (!RESOLUTION_ORDER.includes(r)) parts.push(`${n} ${r}`);
    }
    return `  evidence: ${parts.join(', ')}`;
}

/** Classify a caller entry as test or prod by its path. */
function isTestEntry(entry) {
    const { isTestPath } = require('../shared');
    return isTestPath(entry.relativePath || entry.file || '');
}

/**
 * Render the conservation contract lines: ACCOUNT (always), WARNING (unparsed
 * files containing the symbol), FILTERED (display-filter hides). Returns [].
 * when no account is present (e.g. class-type context).
 */
function formatAccountLines(account) {
    if (!account) return [];
    const lines = [];
    const nc = account.nonCall || { imports: 0, definitions: 0, references: 0, unclassifiedText: 0, total: 0 };
    let line = `ACCOUNT: "${account.symbol}" occurs on ${account.groundTotal} line${account.groundTotal === 1 ? '' : 's'}` +
        ` in ${account.fileCount} file${account.fileCount === 1 ? '' : 's'}: ` +
        `${account.confirmed} confirmed, ${account.unverified} unverified, ` +
        `${nc.total} non-call (${nc.imports} import, ${nc.definitions} definition, ${nc.references} reference, ${nc.unclassifiedText} other-text), ` +
        `${account.excluded ? account.excluded.total : 0} other-target, ` +
        `${account.unaccounted} unaccounted`;
    if (account.beyondText && account.beyondText.count > 0) {
        line += ` (+${account.beyondText.count} beyond-text caller${account.beyondText.count === 1 ? '' : 's'} grep would miss)`;
    }
    lines.push(line);
    if (account.unparsed && account.unparsed.fileCount > 0) {
        lines.push(`WARNING: ${account.unparsed.fileCount} unparsed file${account.unparsed.fileCount === 1 ? '' : 's'} ` +
            `contain${account.unparsed.fileCount === 1 ? 's' : ''} "${account.symbol}" ` +
            `(${account.unparsed.lines} line${account.unparsed.lines === 1 ? '' : 's'}, NOT analyzed): ` +
            account.unparsed.files.join(', '));
    }
    if (account.unreadableFiles && account.unreadableFiles.length > 0) {
        lines.push(`WARNING: ${account.unreadableFiles.length} indexed-but-unreadable file(s) skipped: ${account.unreadableFiles.join(', ')}`);
    }
    if (account.filtered && account.filtered.total > 0) {
        const parts = [];
        const f = account.filtered.byFlag || {};
        if (f.exclude) parts.push(`${f.exclude} --exclude`);
        if (f.minConfidence) parts.push(`${f.minConfidence} --min-confidence`);
        if (f.unreachableOnly) parts.push(`${f.unreachableOnly} --unreachable-only`);
        lines.push(`FILTERED: ${account.filtered.total} hidden by flags (${parts.join(', ')})`);
    }
    return lines;
}

/** "NON-CALL OCCURRENCES" summary line from the account. */
function formatNonCallLine(account, hintName) {
    if (!account || !account.nonCall || account.nonCall.total === 0) return null;
    const nc = account.nonCall;
    return `NON-CALL OCCURRENCES: ${nc.total} (${nc.imports} imports, ${nc.definitions} definitions, ` +
        `${nc.references} references, ${nc.unclassifiedText} other-text) — counts only; see: ucn usages ${hintName}`;
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
                    callerName: c.callerName,
                    // Tier parity with the function-path callers list: class
                    // usages are the confirmed-tier answer for type symbols.
                    ...(c.confidence !== undefined && { confidence: c.confidence }),
                    ...(c.resolution && { resolution: c.resolution }),
                    ...(c.tier && { tier: c.tier })
                })),
                unverifiedCallers: (context.unverifiedCallers || []).map(c => ({
                    file: c.relativePath || c.file,
                    line: c.line,
                    expression: c.content,
                    callerName: c.callerName ?? null,
                    tier: 'unverified',
                    ...(c.reason && { reason: c.reason }),
                    ...(c.dispatchVia && { dispatchVia: c.dispatchVia }),
                    ...(c.dispatchCandidates != null && { dispatchCandidates: c.dispatchCandidates }),
                    ...(c.externalContract && { externalContract: true }),
                })),
                ...(context.warnings && { warnings: context.warnings })
            }
        });
    }

    // Standard function/method context
    const callers = context.callers || [];
    const unverifiedCallers = context.unverifiedCallers || [];
    const callees = context.callees || [];
    return JSON.stringify({
        meta,
        data: {
            function: context.function,
            file: context.file,
            callerCount: callers.length,
            unverifiedCount: unverifiedCallers.length,
            calleeCount: callees.length,
            callerHistogram: context.callerHistogram || null,
            calleeHistogram: context.calleeHistogram || null,
            callers: callers.map(c => ({
                file: c.relativePath || c.file,
                line: c.line,
                expression: c.content,  // FULL expression
                callerName: c.callerName,
                ...(c.calledAs && { calledAs: c.calledAs }),
                ...(c.isFunctionReference && { functionReference: true }),
                ...(c.confidence != null && { confidence: c.confidence, resolution: c.resolution }),
                ...(c.tier && { tier: c.tier }),
                ...(c.reachable !== undefined && { reachable: c.reachable }),
            })),
            unverifiedCallers: unverifiedCallers.map(c => ({
                file: c.relativePath || c.file,
                line: c.line,
                expression: c.content,  // FULL expression
                callerName: c.callerName ?? null,
                ...(c.calledAs && { calledAs: c.calledAs }),
                ...(c.isFunctionReference && { functionReference: true }),
                ...(c.confidence != null && { confidence: c.confidence, resolution: c.resolution }),
                tier: 'unverified',
                ...(c.reason && { reason: c.reason }),
                ...(c.dispatchVia && { dispatchVia: c.dispatchVia }),
                ...(c.dispatchCandidates != null && { dispatchCandidates: c.dispatchCandidates }),
                ...(c.externalContract && { externalContract: true }),
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
        lines.push(`\nCALLERS — CONFIRMED (${callers.length}):`);
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

        const typeUnverified = ctx.unverifiedCallers || [];
        if (typeUnverified.length > 0) {
            lines.push(`\nCALLERS — UNVERIFIED (${typeUnverified.length}) — call syntax, no binding/receiver evidence:`);
            const cap = 10;
            let shown = 0;
            for (const u of typeUnverified) {
                if (shown >= cap) break;
                const callerName = u.callerName ? ` [${u.callerName}]` : '';
                const reason = u.reason ? ` (${u.reason})` : '';
                const expr = u.content ? `: ${u.content.trim().replace(/\s+/g, ' ').slice(0, 100)}` : '';
                lines.push(`  [${itemNum}] ${u.relativePath}:${u.line}${callerName}${expr}${reason}`);
                expandable.push({
                    num: itemNum++,
                    type: 'caller',
                    name: u.callerName || '(module level)',
                    file: u.callerFile || u.file,
                    relativePath: u.relativePath,
                    line: u.line,
                    startLine: u.callerStartLine || u.line,
                    endLine: u.callerEndLine || u.line
                });
                shown++;
            }
            if (typeUnverified.length > shown) {
                lines.push(`  (+${typeUnverified.length - shown} more unverified — use --all)`);
            }
        }

        const typeAccountLines = formatAccountLines(ctx.meta && ctx.meta.account);
        if (typeAccountLines.length > 0) {
            lines.push('');
            lines.push(...typeAccountLines);
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
        if (ctx.meta.confidenceFiltered) notes.push(`${ctx.meta.confidenceFiltered} edge(s) below confidence threshold hidden`);
        if (notes.length) {
            lines.push(`  Note: ${notes.join(', ')}`);
        }
    }

    if (ctx.warnings && ctx.warnings.length > 0) {
        for (const w of ctx.warnings) {
            lines.push(`  Note: ${w.message}`);
        }
    }

    // Reachability markers are suppressed when the project has no detected
    // entry points (library code) — "unreachable" would be meaningless noise.
    const hasEntrypoints = !ctx.meta || ctx.meta.hasEntrypoints !== false;

    const callers = ctx.callers || [];
    const prodCallers = callers.filter(c => !isTestEntry(c));
    const testCallers = callers.filter(c => isTestEntry(c));
    const tierHeader = testCallers.length > 0
        ? `CALLERS — CONFIRMED (${callers.length}, ${prodCallers.length} prod + ${testCallers.length} test):`
        : `CALLERS — CONFIRMED (${callers.length}):`;
    lines.push(`${compact ? '' : '\n'}${tierHeader}`);
    const callerEvidence = formatEvidenceLine(callers);
    if (callerEvidence && !compact) lines.push(callerEvidence);
    const callerReach = reachabilityDisplay(callers, hasEntrypoints, 'caller');
    const renderCaller = (c) => {
        const callerName = c.callerName ? ` [${c.callerName}]` : '';
        const unreachableMark = (callerReach.perLine && c.reachable === false) ? ' [unreachable]' : '';
        if (compact) {
            // One line per caller: "[N] file:line [callerName]: expression"
            const expr = c.content ? c.content.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
            lines.push(`  [${itemNum}] ${c.relativePath}:${c.line}${callerName}${unreachableMark}: ${expr}`);
        } else {
            lines.push(`  [${itemNum}] ${c.relativePath}:${c.line}${callerName}${unreachableMark}`);
            lines.push(`    ${c.content.trim()}`);
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
    };
    for (const c of prodCallers) renderCaller(c);
    if (testCallers.length > 0) {
        if (!compact) lines.push('  test callers:');
        for (const c of testCallers) renderCaller(c);
    }
    if (callerReach.note && !compact) lines.push(callerReach.note);

    // Structural hint: class methods may have callers through constructed/injected instances
    // that static analysis can't track. Only show when caller count is low (≤3) to avoid noise.
    if (ctx.meta && (ctx.meta.isMethod || ctx.meta.className || ctx.meta.receiver) && callers.length <= 3) {
        lines.push(`  Note: ${ctx.function} is a class/struct method — additional callers through constructed or injected instances are not tracked by static analysis.`);
    }

    // UNVERIFIED tier: call-syntax matches without binding/receiver evidence.
    // Always visible (the contract: never silently hide an occurrence), capped
    // at 10 one-liners unless --all.
    const unverified = ctx.unverifiedCallers || [];
    if (unverified.length > 0) {
        lines.push(`${compact ? '' : '\n'}CALLERS — UNVERIFIED (${unverified.length}) — call syntax, no binding/receiver evidence:`);
        const cap = (ctx.meta && ctx.meta.all) ? Infinity : 10;
        let shown = 0;
        for (const u of unverified) {
            if (shown >= cap) break;
            const callerName = u.callerName ? ` [${u.callerName}]` : '';
            const reason = u.reason ? ` (${unverifiedReasonLabel(u)})` : '';
            const expr = u.content ? `: ${u.content.trim().replace(/\s+/g, ' ').slice(0, 100)}` : '';
            lines.push(`  [${itemNum}] ${u.relativePath}:${u.line}${callerName}${expr}${reason}`);
            expandable.push({
                num: itemNum++,
                type: 'caller',
                name: u.callerName || '(module level)',
                file: u.callerFile || u.file,
                relativePath: u.relativePath,
                line: u.line,
                startLine: u.callerStartLine || u.line,
                endLine: u.callerEndLine || u.line
            });
            shown++;
        }
        if (unverified.length > shown) {
            lines.push(`  (+${unverified.length - shown} more unverified — use --all)`);
        }
    }

    const callees = ctx.callees || [];
    lines.push(`${compact ? '' : '\n'}CALLEES (${callees.length}):`);
    const calleeEvidence = formatEvidenceLine(callees);
    if (calleeEvidence && !compact) lines.push(calleeEvidence);
    const calleeReach = reachabilityDisplay(callees, hasEntrypoints, 'callee');
    for (const c of callees) {
        const weight = c.weight && c.weight !== 'normal' ? ` [${c.weight}]` : '';
        const returnSuffix = c.returnType ? ` → ${c.returnType}` : '';
        const sideEffects = (c.sideEffects && c.sideEffects.length) ? ` {${c.sideEffects.join(',')}}` : '';
        const unreachableMark = (calleeReach.perLine && c.reachable === false) ? ' [unreachable]' : '';
        if (compact) {
            const snip = c.docstring ? calleeDocstringSnippet(c.docstring) : '';
            const docPart = snip ? `: ${snip}` : '';
            lines.push(`  [${itemNum}] ${c.name}${returnSuffix}${sideEffects} - ${c.relativePath}:${c.startLine}${docPart}${unreachableMark}`);
        } else {
            lines.push(`  [${itemNum}] ${c.name}${weight}${returnSuffix}${sideEffects} - ${c.relativePath}:${c.startLine}${unreachableMark}`);
            if (c.docstring) {
                const snip = calleeDocstringSnippet(c.docstring);
                if (snip) lines.push(`    "${snip}"`);
            }
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
    if (calleeReach.note && !compact) lines.push(calleeReach.note);

    // Conservation contract lines: non-call summary + ACCOUNT/WARNING/FILTERED
    const account = ctx.meta && ctx.meta.account;
    if (account) {
        const nonCallLine = formatNonCallLine(account, ctx.function);
        if (nonCallLine) lines.push(`${compact ? '' : '\n'}${nonCallLine}`);
        const accountLines = formatAccountLines(account);
        if (accountLines.length > 0) {
            if (!compact && !nonCallLine) lines.push('');
            lines.push(...accountLines);
        }
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

    // Summary (confirmed + unverified tiers reported separately)
    const impactUnverified = impact.unverifiedSites || [];
    const unverifiedSuffix = impactUnverified.length > 0 ? ` confirmed + ${impactUnverified.length} unverified` : '';
    if (impact.shownCallSites !== undefined && impact.shownCallSites < impact.totalCallSites) {
        lines.push(`CALL SITES: ${impact.shownCallSites} shown of ${impact.totalCallSites}${unverifiedSuffix ? ` total${unverifiedSuffix}` : ' total'}`);
    } else {
        lines.push(`CALL SITES: ${impact.totalCallSites}${unverifiedSuffix}`);
    }
    lines.push(`  Files affected: ${impact.byFile.length}`);

    // Patterns
    // BUG-1: also surface structural classification counts (inLoop / inTry /
    // inCallback / inTestCase) — they're already in the JSON shape and in
    // verify text, but were dropped from impact text.
    const p = impact.patterns;
    if (p && !compact) {
        const patternParts = [];
        if (p.constantArgs > 0) patternParts.push(`${p.constantArgs} with literals`);
        if (p.variableArgs > 0) patternParts.push(`${p.variableArgs} with variables`);
        if (p.awaitedCalls > 0) patternParts.push(`${p.awaitedCalls} awaited`);
        if (p.chainedCalls > 0) patternParts.push(`${p.chainedCalls} chained`);
        if (p.spreadCalls > 0) patternParts.push(`${p.spreadCalls} with spread`);
        if (p.inLoop > 0) patternParts.push(`${p.inLoop} in loop`);
        if (p.inTry > 0) patternParts.push(`${p.inTry} in try`);
        if (p.inCallback > 0) patternParts.push(`${p.inCallback} in callback`);
        if (p.inTestCase > 0) patternParts.push(`${p.inTestCase} in test`);
        if (patternParts.length > 0) {
            lines.push(`  Patterns: ${patternParts.join(', ')}`);
        }
    }

    // Scope pollution warning
    if (impact.scopeWarning) {
        lines.push(`  Note: ${impact.scopeWarning.hint}`);
    }

    // By file (confirmed tier)
    if (!compact) lines.push('');
    lines.push('BY FILE:');

    // Evidence aggregate over ALL sites (replaces per-edge confidence lines)
    const allSites = impact.byFile.flatMap(g => g.sites);
    const impactEvidence = formatEvidenceLine(allSites);
    if (impactEvidence && !compact) lines.push(impactEvidence);

    // Reachability policy across ALL sites (not per-file); suppressed entirely
    // when the project has no detected entry points.
    const impactReach = reachabilityDisplay(allSites, impact.hasEntrypoints, 'call site');

    for (const fileGroup of impact.byFile) {
        if (compact) {
            // One line per call site, prefixed with file: "file (N) line [caller]: expr"
            for (const site of fileGroup.sites) {
                const caller = site.callerName ? ` [${site.callerName}]` : '';
                const expr = site.expression ? site.expression.replace(/\s+/g, ' ').slice(0, 100) : '';
                const reach = (impactReach.perLine && site.reachable === false) ? ' [unreachable]' : '';
                lines.push(`  ${fileGroup.file}:${site.line}${caller}${reach}: ${expr}`);
            }
        } else {
            lines.push(`\n${fileGroup.file} (${fileGroup.count} calls)`);
            for (const site of fileGroup.sites) {
                const caller = site.callerName ? `[${site.callerName}]` : '';
                const reach = (impactReach.perLine && site.reachable === false) ? ' [unreachable]' : '';
                lines.push(`  :${site.line} ${caller}${reach}`);
                lines.push(`    ${site.expression}`);
                if (site.args && site.args.length > 0) {
                    lines.push(`    args: ${site.args.join(', ')}`);
                }
            }
        }
    }
    if (impactReach.note && !compact) lines.push(impactReach.note);

    // Unverified tier: visible, capped at 10 one-liners
    if (impactUnverified.length > 0) {
        lines.push(`${compact ? '' : '\n'}UNVERIFIED CALL SITES (${impactUnverified.length}) — call syntax, no binding/receiver evidence:`);
        const cap = 10;
        for (const site of impactUnverified.slice(0, cap)) {
            const caller = site.callerName ? ` [${site.callerName}]` : '';
            const reason = site.reason ? ` (${unverifiedReasonLabel(site)})` : '';
            const expr = site.expression ? `: ${site.expression.replace(/\s+/g, ' ').slice(0, 100)}` : '';
            lines.push(`  ${site.file}:${site.line}${caller}${expr}${reason}`);
        }
        if (impactUnverified.length > cap) {
            lines.push(`  (+${impactUnverified.length - cap} more unverified)`);
        }
    }

    // Conservation contract lines
    const impactAccountLines = formatAccountLines(impact.account);
    if (impactAccountLines.length > 0) {
        if (!compact) lines.push('');
        lines.push(...impactAccountLines);
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

    // Git enrichment (opt-in via --git). Only render when available — non-git
    // dirs and untracked files are skipped silently.
    if (about.git && about.git.available) {
        lines.push(formatGitLine(about.git));
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

    // Usage summary (fast-path approximation; ACCOUNT below is the exact
    // text-ground truth — both are labeled to avoid confusion)
    lines.push('');
    lines.push(`USAGES: ${about.totalUsages} total`);
    lines.push(`  ${about.usages.calls} calls, ${about.usages.imports} imports, ${about.usages.references} references`);

    // Callers — CONFIRMED tier, prod before test
    const hasEntrypoints = about.hasEntrypoints !== false;
    let aboutTruncated = false;
    if (about.callers.total > 0) {
        lines.push('');
        const top = about.callers.top;
        const prodTop = top.filter(c => !isTestEntry(c));
        const testTop = top.filter(c => isTestEntry(c));
        const split = testTop.length > 0 ? `, ${prodTop.length} prod + ${testTop.length} test shown` : '';
        if (about.callers.total > top.length) {
            lines.push(`CALLERS — CONFIRMED (showing ${top.length} of ${about.callers.total}${split}):`);
            aboutTruncated = true;
        } else {
            lines.push(`CALLERS — CONFIRMED (${about.callers.total}${testTop.length > 0 ? `, ${prodTop.length} prod + ${testTop.length} test` : ''}):`);
        }
        const callerEvidence = formatEvidenceLine(top);
        if (callerEvidence) lines.push(callerEvidence);
        const aboutCallerReach = reachabilityDisplay(top, hasEntrypoints, 'caller');
        const renderAboutCaller = (c) => {
            const caller = c.callerName ? `[${c.callerName}]` : '';
            const unreachableMark = (aboutCallerReach.perLine && c.reachable === false) ? ' [unreachable]' : '';
            lines.push(`  ${c.file}:${c.line} ${caller}${unreachableMark}`);
            lines.push(`    ${c.expression}`);
        };
        for (const c of prodTop) renderAboutCaller(c);
        if (testTop.length > 0) {
            lines.push('  test callers:');
            for (const c of testTop) renderAboutCaller(c);
        }
        if (aboutCallerReach.note) lines.push(aboutCallerReach.note);
    }

    // Callers — UNVERIFIED tier (always visible; the contract forbids hiding)
    const aboutUnverified = about.callers.unverified;
    if (aboutUnverified && aboutUnverified.total > 0) {
        lines.push('');
        lines.push(`CALLERS — UNVERIFIED (${aboutUnverified.total}) — call syntax, no binding/receiver evidence:`);
        for (const u of aboutUnverified.top) {
            const caller = u.callerName ? ` [${u.callerName}]` : '';
            const reason = u.reason ? ` (${unverifiedReasonLabel(u)})` : '';
            const expr = u.expression ? `: ${u.expression.replace(/\s+/g, ' ').slice(0, 100)}` : '';
            lines.push(`  ${u.file}:${u.line}${caller}${expr}${reason}`);
        }
        if (aboutUnverified.total > aboutUnverified.top.length) {
            lines.push(`  (+${aboutUnverified.total - aboutUnverified.top.length} more unverified — use --all)`);
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
        const calleeEvidence = formatEvidenceLine(about.callees.top);
        if (calleeEvidence) lines.push(calleeEvidence);
        const aboutCalleeReach = reachabilityDisplay(about.callees.top, hasEntrypoints, 'callee');
        for (const c of about.callees.top) {
            const weight = c.weight && c.weight !== 'normal' ? ` [${c.weight}]` : '';
            const returnSuffix = c.returnType ? ` → ${c.returnType}` : '';
            const sideEffects = (c.sideEffects && c.sideEffects.length) ? ` {${c.sideEffects.join(',')}}` : '';
            const unreachableMark = (aboutCalleeReach.perLine && c.reachable === false) ? ' [unreachable]' : '';
            lines.push(`  ${c.name}${weight}${returnSuffix}${sideEffects} - ${c.file}:${c.line} (${c.callCount}x)${unreachableMark}`);
            if (c.docstring) {
                const snip = calleeDocstringSnippet(c.docstring);
                if (snip) lines.push(`    "${snip}"`);
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
        if (aboutCalleeReach.note) lines.push(aboutCalleeReach.note);
    }

    // Conservation contract: exact text-ground reconciliation (ACCOUNT) plus
    // unparsed-file warnings and display-filter notes.
    if (about.account) {
        const accountLines = formatAccountLines(about.account);
        if (accountLines.length > 0) {
            lines.push('');
            lines.push(...accountLines);
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
