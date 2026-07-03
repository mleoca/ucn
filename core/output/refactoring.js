/**
 * core/output/refactoring.js - Verify/plan/stacktrace formatters
 */

const { unverifiedReasonLabel, advisoryLine } = require('./shared');
const { formatAccountLines } = require('./analysis');

/**
 * Render the v4 unverified band shared by verify and plan: capped one-liners
 * with reasons. Returns [] when the band is empty.
 */
function _unverifiedBandLines(sites, cap = 10) {
    if (!sites || sites.length === 0) return [];
    const lines = [];
    lines.push('');
    lines.push(`UNVERIFIED CALL SITES (${sites.length}) — call syntax, no binding/receiver evidence; review manually:`);
    for (const u of sites.slice(0, cap)) {
        const caller = u.callerName ? ` [${u.callerName}]` : '';
        const reason = u.reason ? ` (${unverifiedReasonLabel(u)})` : '';
        const expr = u.expression ? `: ${u.expression.replace(/\s+/g, ' ').slice(0, 100)}` : '';
        lines.push(`  ${u.file}:${u.line}${caller}${expr}${reason}`);
    }
    if (sites.length > cap) {
        lines.push(`  (+${sites.length - cap} more unverified)`);
    }
    return lines;
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
        return `Function "${plan.function}" not found.`;
    }
    if (plan.error) {
        // Only show the parameter list when the error result carries one —
        // unrelated errors (multi-op rejection) don't, and "none" would be
        // wrong for functions that have parameters.
        return plan.currentParams
            ? `Error: ${plan.error}\nCurrent parameters: ${plan.currentParams.join(', ') || 'none'}`
            : `Error: ${plan.error}`;
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
    if (plan.scopeWarning) {
        lines.push(`  Note: ${plan.scopeWarning.hint}`);
    }
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

    // v4 tiered contract: candidates without evidence are not planned but
    // stay visible — a rename that misses one of these breaks at runtime.
    lines.push(..._unverifiedBandLines(plan.unverifiedSites));
    const planAccountLines = formatAccountLines(plan.account);
    if (planAccountLines.length > 0) {
        lines.push('');
        lines.push(...planAccountLines);
    }

    return lines.join('\n');
}

/**
 * Format plan command output - JSON
 */
function formatPlanJson(plan) {
    if (!plan) {
        return JSON.stringify({ found: false, error: 'Function not found' }, null, 2);
    }
    if (!plan.found) {
        return JSON.stringify({
            found: false,
            error: plan.error || `Function "${plan.function}" not found.`,
            ...(plan.currentParams && { currentParams: plan.currentParams })
        }, null, 2);
    }
    if (plan.error) {
        return JSON.stringify({
            found: true,
            error: plan.error,
            ...(plan.currentParams && { currentParams: plan.currentParams })
        }, null, 2);
    }

    // Standard {meta, data} envelope (fix #230 — plan was one of three
    // commands still emitting a bare result object).
    return JSON.stringify({
        meta: {
            complete: (plan.unverifiedCount || 0) === 0,
            unverified: plan.unverifiedCount || 0,
            ...(plan.account && { account: plan.account }),
        },
        data: {
            found: true,
            function: plan.function,
            file: plan.file,
            startLine: plan.startLine,
            operation: plan.operation,
            before: { signature: plan.before.signature },
            after: { signature: plan.after.signature },
            totalChanges: plan.totalChanges,
            filesAffected: plan.filesAffected,
            changes: plan.changes.map(c => ({
                file: c.file,
                line: c.line,
                expression: c.expression,
                suggestion: c.suggestion
            })),
            // v4 tiered contract passthrough
            unverifiedCount: plan.unverifiedCount,
            unverifiedSites: plan.unverifiedSites,
        },
    }, null, 2);
}

/**
 * Render the per-site pattern flags as a compact suffix.
 * Returns "" when no flags are set, or " [loop, try, callback, test, awaited]"
 * with only the active flags.
 */
function _formatPatternFlags(p) {
    if (!p) return '';
    const flags = [];
    if (p.inLoop) flags.push('loop');
    if (p.inTry) flags.push('try');
    if (p.inCallback) flags.push('callback');
    if (p.inTestCase) flags.push('test');
    if (p.awaited) flags.push('awaited');
    return flags.length ? `  [${flags.join(', ')}]` : '';
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

    // Expected args (max null = unbounded rest param)
    const { min, max } = result.expectedArgs;
    const expectedStr = max == null ? `${min}+` : (min === max ? `${min}` : `${min}-${max}`);
    lines.push(`Expected arguments: ${expectedStr}`);
    lines.push('');

    // Summary
    // BUG M1: don't claim "All calls valid" when 0 valid + N uncertain.
    // Status precedence: mismatches > 0 → fail; total === 0 → empty;
    // valid === 0 && uncertain > 0 → all-uncertain; valid > 0 && mismatches === 0 → ok.
    let status;
    if (result.mismatches > 0) {
        status = `✗ ${result.mismatches} mismatch${result.mismatches === 1 ? '' : 'es'}`;
    } else if (result.totalCalls === 0) {
        status = 'ℹ No calls found';
    } else if (result.valid === 0 && result.uncertain > 0) {
        status = '⚠ All calls uncertain (no resolved sites)';
    } else {
        status = '✓ All calls valid';
    }
    lines.push(`STATUS: ${status}`);
    lines.push(`  Total calls: ${result.totalCalls}`);
    lines.push(`  Valid: ${result.valid}`);
    lines.push(`  Mismatches: ${result.mismatches}`);
    lines.push(`  Uncertain: ${result.uncertain}`);
    if (result.unverifiedCount > 0) {
        lines.push(`  Unverified (not arg-checked): ${result.unverifiedCount}`);
    }
    if (result.scopeWarning) {
        lines.push(`  Note: ${result.scopeWarning.hint}`);
    }

    // Feature A/B: show aggregate patterns counts when any are present.
    const p = result.patterns;
    if (p) {
        const parts = [];
        if (p.inLoop > 0) parts.push(`${p.inLoop} in loop`);
        if (p.inTry > 0) parts.push(`${p.inTry} in try`);
        if (p.inCallback > 0) parts.push(`${p.inCallback} in callback`);
        if (p.inTestCase > 0) parts.push(`${p.inTestCase} in test`);
        if (p.awaitedCalls > 0) parts.push(`${p.awaitedCalls} awaited`);
        if (parts.length > 0) {
            lines.push(`  Patterns: ${parts.join(', ')}`);
        }
    }

    // Show mismatches
    if (result.mismatchDetails.length > 0) {
        lines.push('');
        lines.push('MISMATCHES:');
        for (const m of result.mismatchDetails) {
            const flags = _formatPatternFlags(m.patterns);
            lines.push(`  ${m.file}:${m.line}${flags}`);
            lines.push(`    ${m.expression}`);
            lines.push(`    Expected ${m.expected}, got ${m.actual}: [${m.args?.join(', ') || ''}]`);
        }
    }

    // Show uncertain
    if (result.uncertainDetails.length > 0) {
        lines.push('');
        lines.push('UNCERTAIN (manual check needed):');
        for (const u of result.uncertainDetails) {
            const flags = _formatPatternFlags(u.patterns);
            lines.push(`  ${u.file}:${u.line}${flags}`);
            lines.push(`    ${u.expression}`);
            lines.push(`    Reason: ${u.reason}`);
        }
    }

    // v4 tiered contract: unverified band (distinct from UNCERTAIN above,
    // which is arg-parse uncertainty among CONFIRMED sites).
    lines.push(..._unverifiedBandLines(result.unverifiedSites));
    const accountLines = formatAccountLines(result.account);
    if (accountLines.length > 0) {
        lines.push('');
        lines.push(...accountLines);
    }

    return lines.join('\n');
}

/**
 * Format verify command output - JSON
 */
function formatVerifyJson(result) {
    if (!result) {
        return JSON.stringify({ found: false, error: 'Function not found' }, null, 2);
    }
    if (!result.found) {
        return JSON.stringify({ found: false, error: `Function "${result.function}" not found.` }, null, 2);
    }

    // Standard {meta, data} envelope (fix #230 — verify was one of three
    // commands still emitting a bare result object). Completeness signals
    // and the account live in meta, like context/impact/about.
    return JSON.stringify({
        meta: {
            complete: result.uncertain === 0 && (result.unverifiedCount || 0) === 0,
            uncertain: result.uncertain,
            unverified: result.unverifiedCount || 0,
            ...(result.account && { account: result.account }),
        },
        data: {
            found: true,
            function: result.function,
            file: result.file,
            startLine: result.startLine,
            signature: result.signature,
            expectedArgs: result.expectedArgs,
            totalCalls: result.totalCalls,
            valid: result.valid,
            mismatches: result.mismatches,
            uncertain: result.uncertain,
            // Feature A/B: surface aggregate patterns and per-site flags.
            patterns: result.patterns,
            mismatchDetails: result.mismatchDetails.map(m => ({
                file: m.file,
                line: m.line,
                expression: m.expression,
                expected: m.expected,
                actual: m.actual,
                args: m.args || [],
                patterns: m.patterns,
            })),
            uncertainDetails: result.uncertainDetails.map(u => ({
                file: u.file,
                line: u.line,
                expression: u.expression,
                reason: u.reason,
                patterns: u.patterns,
            })),
            // v4 tiered contract passthrough
            unverifiedCount: result.unverifiedCount,
            unverifiedSites: result.unverifiedSites,
        },
    }, null, 2);
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
    lines.push(`Stack trace: ${result.frameCount} frame${result.frameCount === 1 ? '' : 's'}`);
    lines.push('═'.repeat(60));
    const stAdvisory = advisoryLine(result.advisory);
    if (stAdvisory) lines.push(stAdvisory);
    if (result.skippedFrames > 0) {
        lines.push(`(${result.skippedFrames} frame(s) without file:line — Unknown Source, native — skipped)`);
    }

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
                // The engine computed this and both surfaces dropped it —
                // an out-of-range line got an unqualified attribution
                // (fix #251).
                if (frame.functionInfo.lineMismatch) {
                    lines.push(`  ⚠ line ${frame.line} is outside this range — nearest same-name definition shown`);
                }
            }
        } else {
            lines.push(`  ${frame.file}:${frame.line} (file not found in project)`);
            lines.push(`  Raw: ${frame.raw}`);
        }
    }

    return lines.join('\n');
}

/**
 * Format stack trace command output - JSON
 */
function formatStackTraceJson(result) {
    if (!result || result.frameCount === 0) {
        return JSON.stringify({
            frameCount: 0,
            frames: [],
            ...(result && result.advisory && { advisory: result.advisory }),
        }, null, 2);
    }

    return JSON.stringify({
        frameCount: result.frameCount,
        // The v4 two-tier surface: advisory commands self-label in JSON too
        // (fix #251 — the result carried this and the text rendered it, but
        // the JSON rebuild dropped it in every language cell).
        ...(result.advisory && { advisory: result.advisory }),
        ...(result.skippedFrames > 0 && { skippedFrames: result.skippedFrames }),
        frames: result.frames.map(f => ({
            function: f.function || null,
            file: f.file,
            line: f.line,
            found: !!f.found,
            ...(f.confidence !== undefined && { confidence: f.confidence }),
            ...(f.resolvedFile && { resolvedFile: f.resolvedFile }),
            ...(f.context && { context: f.context.map(c => ({
                line: c.line,
                code: c.code,
                isCurrent: !!c.isCurrent
            })) }),
            ...(f.functionInfo && { functionInfo: {
                name: f.functionInfo.name,
                params: f.functionInfo.params || null,
                startLine: f.functionInfo.startLine,
                endLine: f.functionInfo.endLine,
                ...(f.functionInfo.lineMismatch && { lineMismatch: true }),
            } }),
            ...(f.raw && { raw: f.raw })
        }))
    }, null, 2);
}

/**
 * Format audit-async command output - text.
 * Lists likely missing-await call sites grouped by file.
 */
function formatAuditAsync(result) {
    if (!result) return 'No async audit data.';
    const issues = Array.isArray(result.issues) ? result.issues : [];
    if (issues.length === 0) {
        return 'Async audit: no missing-await issues found.';
    }
    const lines = [];
    lines.push(`Async audit: ${result.totalIssues} likely missing-await call site(s) across ${result.filesAffected} file(s)`);
    lines.push('═'.repeat(60));

    // Group by file (issues are already sorted by file then line).
    const byFile = new Map();
    for (const issue of issues) {
        if (!byFile.has(issue.file)) byFile.set(issue.file, []);
        byFile.get(issue.file).push(issue);
    }
    for (const [file, fileIssues] of byFile) {
        lines.push('');
        lines.push(`${file} (${fileIssues.length})`);
        for (const issue of fileIssues) {
            const caller = issue.callerName ? ` [${issue.callerName}]` : '';
            lines.push(`  :${issue.line}${caller}  ${issue.calleeName}() — async, not awaited`);
        }
    }
    return lines.join('\n');
}

/**
 * Format audit-async command output - JSON.
 */
function formatAuditAsyncJson(result) {
    if (!result) return JSON.stringify({ issues: [] }, null, 2);
    return JSON.stringify({
        totalIssues: result.totalIssues || 0,
        filesAffected: result.filesAffected || 0,
        issues: (result.issues || []).map(i => ({
            file: i.file,
            line: i.line,
            callerName: i.callerName,
            calleeName: i.calleeName,
        })),
    }, null, 2);
}

module.exports = {
    formatPlan,
    formatPlanJson,
    formatVerify,
    formatVerifyJson,
    formatStackTrace,
    formatStackTraceJson,
    formatAuditAsync,
    formatAuditAsyncJson,
};
