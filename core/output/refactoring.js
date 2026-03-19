/**
 * core/output/refactoring.js - Verify/plan/stacktrace formatters
 */

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
        return `Error: ${plan.error}\nCurrent parameters: ${plan.currentParams?.join(', ') || 'none'}`;
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

    return JSON.stringify({
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
        }))
    }, null, 2);
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
    if (result.scopeWarning) {
        lines.push(`  Note: ${result.scopeWarning.hint}`);
    }

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
 * Format verify command output - JSON
 */
function formatVerifyJson(result) {
    if (!result) {
        return JSON.stringify({ found: false, error: 'Function not found' }, null, 2);
    }
    if (!result.found) {
        return JSON.stringify({ found: false, error: `Function "${result.function}" not found.` }, null, 2);
    }

    return JSON.stringify({
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
        mismatchDetails: result.mismatchDetails.map(m => ({
            file: m.file,
            line: m.line,
            expression: m.expression,
            expected: m.expected,
            actual: m.actual,
            args: m.args || []
        })),
        uncertainDetails: result.uncertainDetails.map(u => ({
            file: u.file,
            line: u.line,
            expression: u.expression,
            reason: u.reason
        }))
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
 * Format stack trace command output - JSON
 */
function formatStackTraceJson(result) {
    if (!result || result.frameCount === 0) {
        return JSON.stringify({ frameCount: 0, frames: [] }, null, 2);
    }

    return JSON.stringify({
        frameCount: result.frameCount,
        frames: result.frames.map(f => ({
            function: f.function || null,
            file: f.file,
            line: f.line,
            found: !!f.found,
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
                endLine: f.functionInfo.endLine
            } }),
            ...(f.raw && { raw: f.raw })
        }))
    }, null, 2);
}

module.exports = {
    formatPlan,
    formatPlanJson,
    formatVerify,
    formatVerifyJson,
    formatStackTrace,
    formatStackTraceJson,
};
