/**
 * core/check.js — Pre-commit summary command.
 *
 * Composes diff-impact + verify + affected-tests into a single output.
 * Tells the caller, in one shot:
 *   - which functions changed
 *   - which call sites might break (signature drift)
 *   - which tests are likely affected
 *   - which new functions look orphaned
 */

'use strict';

const { diffImpact } = require('./analysis');

/**
 * Run the pre-commit check.
 *
 * @param {object} index - ProjectIndex
 * @param {object} options - { base, staged, file, limit }
 * @returns {object}
 */
function check(index, options = {}) {
    let dr;
    try {
        dr = diffImpact(index, {
            base: options.base || 'HEAD',
            staged: !!options.staged,
            file: options.file,
        });
    } catch (e) {
        // Not a git repo, or git command failed — treat as empty
        return {
            base: options.base || 'HEAD',
            staged: !!options.staged,
            empty: true,
            reason: e && e.message ? e.message : 'diff failed',
        };
    }

    // diffImpact returns { base, functions, newFunctions, deletedFunctions }
    const modified = (dr && Array.isArray(dr.functions)) ? dr.functions : [];
    const added    = (dr && Array.isArray(dr.newFunctions)) ? dr.newFunctions : [];
    const deleted  = (dr && Array.isArray(dr.deletedFunctions)) ? dr.deletedFunctions : [];

    const allChanged = [
        ...modified.map(f => ({ ...f, _kind: 'modified' })),
        ...added.map(f => ({ ...f, _kind: 'added' })),
    ];

    if (!dr || (modified.length === 0 && added.length === 0 && deleted.length === 0)) {
        return {
            base: options.base || 'HEAD',
            staged: !!options.staged,
            empty: true,
            reason: dr && dr.error ? dr.error : 'no changes detected',
        };
    }

    const limit = options.limit && options.limit > 0 ? options.limit : null;
    const changed = limit ? allChanged.slice(0, limit) : allChanged;

    const items = [];
    const reachable = computeReachableSet(index);

    // For each changed function, run verify and gather caller summary
    for (const fn of changed) {
        const filePath = fn.relativePath || fn.file || '';
        let verifyResult = null;
        try {
            verifyResult = index.verify(fn.name, { file: filePath });
        } catch (e) {
            verifyResult = null;
        }
        // Note: verify() returns `mismatches` as a COUNT and `mismatchDetails` as the array.
        const mismatches = verifyResult && Array.isArray(verifyResult.mismatchDetails)
            ? verifyResult.mismatchDetails
            : [];

        // For modified functions, the contracted diffImpact result carries both
        // bands already (confirmed `callers` + visible `unverifiedCallers`).
        let callers = Array.isArray(fn.callers) ? fn.callers : [];
        let unverifiedCallers = Array.isArray(fn.unverifiedCallers) ? fn.unverifiedCallers : [];
        if (callers.length === 0 && fn._kind === 'added') {
            try {
                const raw = index.findCallers(fn.name, { includeMethods: true, collectAccount: true }) || [];
                callers = raw.filter(c => c.tier !== 'unverified');
                unverifiedCallers = raw.filter(c => c.tier === 'unverified')
                    .concat(raw.unverifiedEntries || []);
            } catch (e) { /* skip */ }
        }

        const item = {
            name: fn.name,
            file: filePath,
            line: fn.startLine || fn.line,
            kind: fn._kind,
            callerCount: callers.length,
            unverifiedCallerCount: unverifiedCallers.length,
            signatureMismatches: mismatches.length,
            ...(mismatches.length > 0 && { mismatches: mismatches.slice(0, 5) }),
        };

        // Orphan = newly added with zero caller CANDIDATES IN EITHER TIER and
        // not detected as an entry point. Zero confirmed + N unverified is NOT
        // orphan (the #223 reverseTrace entry-point soundness rule — claiming
        // "nobody calls this" after routing candidates to the unverified tier
        // would be the exact silent-drop the contract forbids).
        if (item.kind === 'added' && callers.length === 0 && unverifiedCallers.length === 0) {
            // Check entry points: if the symbol is a known entry-point pattern, not orphan
            let isEntry = false;
            try {
                const ep = require('./entrypoints');
                if (typeof ep.detectEntrypoints === 'function') {
                    const eps = ep.detectEntrypoints(index) || [];
                    isEntry = eps.some(e => e.name === fn.name && (e.file === filePath || e.relativePath === filePath));
                }
            } catch (e) { /* skip */ }
            item.orphan = !isEntry;
        }

        items.push(item);
    }

    // Surface deleted functions inline — they don't have line/file but still matter
    for (const d of deleted) {
        items.push({
            name: d.name || '(unnamed)',
            file: d.relativePath || d.file || '',
            line: d.startLine || 0,
            kind: 'deleted',
            callerCount: 0,
            unverifiedCallerCount: 0,
            signatureMismatches: 0,
        });
    }

    // Affected tests (top-level summary, capped)
    let testFiles = [];
    let testCount = 0;
    for (const fn of changed.slice(0, 10)) {
        try {
            const t = index.affectedTests(fn.name, { depth: 2 });
            if (t && t.testFiles) {
                for (const tf of t.testFiles) {
                    if (!testFiles.find(x => x.file === tf.file)) {
                        testFiles.push(tf);
                        testCount += tf.testCount || 0;
                    }
                }
            }
        } catch (e) { /* skip */ }
    }

    // Action items
    const actions = [];
    for (const it of items) {
        if (it.signatureMismatches > 0) {
            actions.push({
                severity: 'warn',
                kind: 'signature_drift',
                message: `${it.name}: ${it.signatureMismatches} call site(s) need updating`,
            });
        }
        if (it.orphan) {
            actions.push({
                severity: 'warn',
                kind: 'orphan_new',
                message: `${it.name} is new but has no callers (confirmed or unverified) and is not an entry point`,
            });
        }
    }
    if (testFiles.length > 0) {
        const filesList = testFiles.slice(0, 5).map(t => t.file).join(' ');
        actions.push({
            severity: 'info',
            kind: 'tests_to_run',
            message: `Run tests: ${filesList}`,
        });
    }

    return {
        base: options.base || 'HEAD',
        staged: !!options.staged,
        changed: items,
        totalChanged: allChanged.length + deleted.length,
        truncated: !!(limit && allChanged.length > limit),
        testFiles,
        totalTestFiles: testFiles.length,
        totalTests: testCount,
        actions,
    };
}

function symbolKey(file, line) {
    return `${file}:${line}`;
}

function computeReachableSet(index) {
    try {
        const ep = require('./entrypoints');
        if (typeof ep.computeReachability === 'function') {
            return ep.computeReachability(index);
        }
    } catch (e) { /* fall through */ }
    return null;
}

module.exports = { check };
