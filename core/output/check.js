/**
 * core/output/check.js — Pre-commit check formatter.
 *
 * Items are grouped by verdict, worst first: what broke, what to look at,
 * what nothing depends on. Every site of a break is listed: a reader who
 * has to fix thirteen call sites needs thirteen lines.
 */

'use strict';

const SECTIONS = [
    ['blocked', 'BLOCKED', 'a break was observed'],
    ['review', 'REVIEW', 'can reach existing code; not settled by the engine'],
    ['ready', 'READY', 'nothing that existed depends on the change'],
];
// Occurrences of a name are context, not a worklist: a head is enough.
const NAME_SITE_LIMIT = 10;

function callersText(it) {
    if (it.kind === 'module') return '';
    let callers = it.callerCount != null ? `${it.callerCount} caller${it.callerCount === 1 ? '' : 's'}` : '';
    if (it.unverifiedCallerCount > 0) callers += ` (+${it.unverifiedCallerCount} unverified)`;
    return callers;
}

function itemLines(it) {
    const tags = [];
    if (it.kind && it.kind !== 'changed') tags.push(it.kind.toUpperCase());
    if (it.verdict === 'ready' && it.kind === 'modified') {
        if (it.change === 'inert') tags.push('contract unchanged');
        else if (it.noDependents) tags.push('no static dependents');
    }
    if (it.verdict !== 'ready') {
        for (const reason of it.reasons || []) if (reason !== 'signature-mismatch') tags.push(reason);
    }
    if (it.signatureMismatches > 0) tags.push(`SIG-DRIFT(${it.signatureMismatches})`);
    if (it.orphan) tags.push('ORPHAN');
    if (it.symbolType) tags.push(it.symbolType);
    // Caller evidence matters where the callers do.
    if (it.verdict !== 'ready' && it.kind !== 'deleted' && it.account && !it.account.textComplete) {
        tags.push('ACCOUNT-INCOMPLETE');
    }
    const lines = [`  ${it.name} (${it.file}:${it.line})${tags.length ? ` [${tags.join(', ')}]` : ''}  ${callersText(it)}`.trimEnd()];
    if (it.symbolType) {
        lines.push(`    Dependencies: ${it.dependencyCount || 0} confirmed, ${it.unverifiedDependencyCount || 0} unverified`);
    }
    for (const m of it.mismatches || []) {
        const problem = m.expected ? `expected ${m.expected}, got ${m.actual}` : (m.reason || 'arity mismatch');
        const where = m.file ? `${m.file}:${m.line}` : '';
        const expression = m.expression ? `  ${String(m.expression).trim()}` : '';
        lines.push(`    ↳ ${where}${expression}  ${problem}`);
    }
    const sites = it.sites || [];
    const definite = it.verdict === 'blocked';
    const shown = definite ? sites : sites.slice(0, NAME_SITE_LIMIT);
    for (const site of shown) {
        lines.push(`    ↳ ${site.file}${site.line ? `:${site.line}` : ''}${site.kind ? `  ${site.kind}` : ''}`);
    }
    if (sites.length > shown.length) lines.push(`    (+${sites.length - shown.length} more occurrence(s))`);
    return lines;
}

function formatCheck(result) {
    if (!result) return 'No check result.';
    if (result.ok === false) {
        // The gate could not run — never render this like a clean tree.
        const advice = result.status === 'staged-snapshot-unavailable'
            ? 'This is not a pass, and says nothing about the worktree. Resolve what keeps the git index from being exported (unmerged paths, a missing object) and rerun.'
            : 'This is not a pass. Fix the git context (run inside a git repository with a valid base ref) and rerun.';
        return `Pre-commit Check (${result.base}${result.staged ? ', staged' : ''})\n${'═'.repeat(60)}\nCHECK DID NOT RUN [${result.status || 'diff-failed'}] — ${result.error || 'git diff failed'}\n${advice}`;
    }
    const pathNotes = [];
    if (result.nonSourcePaths > 0) pathNotes.push(`Note: ${result.nonSourcePaths} changed path(s) outside supported source files not analyzed.`);
    if (result.untrackedPaths > 0) pathNotes.push(`Note: ${result.untrackedPaths} untracked source file(s) included as whole-file additions.`);
    if (result.empty) {
        return [`Pre-commit Check (${result.base}${result.staged ? ', staged' : ''})\n${'═'.repeat(60)}\nNo changes to analyze${result.reason ? ` (${result.reason})` : ''}.`, ...pathNotes].join('\n');
    }

    const lines = [];
    lines.push(`Pre-commit Check vs ${result.base}${result.staged ? ' (staged)' : ''}`);
    lines.push('═'.repeat(60));
    lines.push(...pathNotes);
    for (const note of result.notes || []) lines.push(`Note: ${note}`);
    const items = result.changed || [];
    if (result.trust) {
        const trust = result.trust;
        lines.push(`TRUST: ${trust.status} — UCN evidence is not semantic proof; compiler and tests are required`);
        const counts = [];
        if (trust.blocked) counts.push(`${trust.blocked} blocked`);
        if (trust.review) counts.push(`${trust.review} to review`);
        if (trust.ready) counts.push(`${trust.ready} ready`);
        const details = [];
        if (trust.signatureMismatches) details.push(`${trust.signatureMismatches} signature mismatch(es)`);
        if (trust.unverifiedCallSites) details.push(`${trust.unverifiedCallSites} unverified caller(s)`);
        if (trust.incompleteAccounts) details.push(`${trust.incompleteAccounts} incomplete account(s)`);
        if (trust.filteredEdges) details.push(`${trust.filteredEdges} filtered edge(s)`);
        if (trust.usageReviewSymbols) details.push(`${trust.usageReviewSymbols} symbol(s) need usages review`);
        if (trust.unvalidatedDeclarations) details.push(`${trust.unvalidatedDeclarations} declaration change(s) need toolchain validation`);
        if (trust.strict) details.push('strict: review does not pass');
        if (counts.length > 0 || details.length > 0) lines.push(`  ${[...counts, ...details].join(' · ')}`);
    }

    const noun = items.some(it => it.symbolType) ? 'symbol' : 'function';
    if (result.truncated) {
        lines.push(`Changed: ${items.length} of ${result.totalChanged} ${noun}s`);
    } else {
        lines.push(`Changed: ${items.length} ${noun}${items.length === 1 ? '' : 's'}`);
    }
    if (items.length === 0) {
        lines.push('  (none — only non-function changes)');
    } else {
        for (const [verdict, title, meaning] of SECTIONS) {
            const group = items.filter(it => (it.verdict || 'review') === verdict);
            if (group.length === 0) continue;
            lines.push(`${title} (${group.length}) — ${meaning}:`);
            for (const it of group) lines.push(...itemLines(it));
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
