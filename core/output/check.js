/**
 * core/output/check.js — Pre-commit check formatter.
 */

'use strict';

function formatCheck(result) {
    if (!result) return 'No check result.';
    if (result.empty) {
        return `Pre-commit Check (${result.base}${result.staged ? ', staged' : ''})\n${'═'.repeat(60)}\nNo changes to analyze${result.reason ? ` (${result.reason})` : ''}.`;
    }

    const lines = [];
    lines.push(`Pre-commit Check vs ${result.base}${result.staged ? ' (staged)' : ''}`);
    lines.push('═'.repeat(60));

    // Changed functions section
    const items = result.changed || [];
    if (result.truncated) {
        lines.push(`Changed: ${items.length} of ${result.totalChanged} functions`);
    } else {
        lines.push(`Changed: ${items.length} function${items.length === 1 ? '' : 's'}`);
    }
    if (items.length === 0) {
        lines.push('  (none — only non-function changes)');
    } else {
        for (const it of items) {
            const tags = [];
            if (it.kind && it.kind !== 'changed') tags.push(it.kind.toUpperCase());
            if (it.signatureMismatches > 0) tags.push(`SIG-DRIFT(${it.signatureMismatches})`);
            if (it.orphan) tags.push('ORPHAN');
            const tagStr = tags.length ? ' [' + tags.join(', ') + ']' : '';
            let callers = it.callerCount != null ? `${it.callerCount} caller${it.callerCount === 1 ? '' : 's'}` : '';
            if (it.unverifiedCallerCount > 0) {
                callers += ` (+${it.unverifiedCallerCount} unverified)`;
            }
            lines.push(`  ${it.name} (${it.file}:${it.line})${tagStr}  ${callers}`);
            if (it.mismatches && it.mismatches.length > 0) {
                for (const m of it.mismatches.slice(0, 3)) {
                    const where = m.file ? ` at ${m.file}:${m.line}` : '';
                    const reason = m.expected
                        ? `expected ${m.expected}, got ${m.actual}`
                        : (m.reason || 'arity mismatch');
                    lines.push(`    ↳ ${reason}${where}`);
                }
            }
        }
    }

    // Tests
    lines.push('');
    if (result.testFiles && result.testFiles.length > 0) {
        lines.push(`Tests potentially affected: ${result.totalTests || result.testFiles.length} in ${result.testFiles.length} file${result.testFiles.length === 1 ? '' : 's'}`);
        for (const tf of result.testFiles.slice(0, 8)) {
            const cnt = tf.testCount ? ` (${tf.testCount})` : '';
            lines.push(`  ${tf.file}${cnt}`);
        }
        if (result.testFiles.length > 8) {
            lines.push(`  ... and ${result.testFiles.length - 8} more`);
        }
    } else {
        lines.push('Tests: none detected for changed functions');
    }

    // Action items
    if (result.actions && result.actions.length > 0) {
        lines.push('');
        lines.push('Action items:');
        for (const a of result.actions) {
            const marker = a.severity === 'warn' ? '⚠' : a.severity === 'error' ? '✖' : '·';
            lines.push(`  ${marker} ${a.message}`);
        }
    }

    return lines.join('\n');
}

function formatCheckJson(result) {
    return JSON.stringify(result, null, 2);
}

module.exports = { formatCheck, formatCheckJson };
