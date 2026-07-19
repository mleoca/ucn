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

const { diffImpact, composeAccount, callNotResolvedEntries } = require('./analysis');

function summarizeAccount(account) {
    if (!account) {
        return {
            available: false,
            textComplete: false,
            semanticComplete: false,
            safeToDelete: false,
        };
    }
    const contract = account.contract || {};
    return {
        available: true,
        conserved: account.conserved === true,
        textComplete: contract.textComplete === true,
        observedTextZero: contract.observedTextZero === true,
        semanticComplete: false,
        safeToDelete: false,
        unparsedFiles: account.unparsed ? account.unparsed.fileCount || 0 : 0,
        unreadableFiles: Array.isArray(account.unreadableFiles) ? account.unreadableFiles.length : 0,
        unaccounted: account.unaccounted || 0,
        filtered: account.filtered ? account.filtered.total || 0 : 0,
        beyondTextCallers: account.beyondText ? account.beyondText.count || 0 : 0,
        requiresUsageReview: contract.requiresUsageReview === true,
    };
}

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

    // For each changed function, run verify and gather caller summary
    for (const fn of changed) {
        const filePath = fn.relativePath || fn.file || '';
        let verifyResult;
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
        let account = fn.account || null;
        if (callers.length === 0 && fn._kind === 'added') {
            try {
                const definitions = (index.symbols.get(fn.name) || []).filter(d =>
                    (d.relativePath === filePath || d.file === fn.filePath) &&
                    (!fn.startLine || d.startLine === fn.startLine));
                const raw = index.findCallers(fn.name, {
                    includeMethods: true,
                    collectAccount: true,
                    targetDefinitions: definitions.length > 0 ? definitions : undefined,
                }) || [];
                callers = raw.filter(c => c.tier !== 'unverified');
                unverifiedCallers = raw.filter(c => c.tier === 'unverified')
                    .concat(raw.unverifiedEntries || []);
                account = composeAccount(index, fn.name, raw);
                unverifiedCallers = unverifiedCallers.concat(callNotResolvedEntries(index, account));
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
            account: summarizeAccount(account),
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

    // Surface deleted functions inline. remainingCallSites are name-level
    // matches still present in the tree — a deleted function that is still
    // called is a likely break, so they count as unverified callers here.
    for (const d of deleted) {
        items.push({
            name: d.name || '(unnamed)',
            file: d.relativePath || d.file || '',
            line: d.startLine || 0,
            kind: 'deleted',
            callerCount: 0,
            unverifiedCallerCount: (d.remainingCallSites || []).length,
            signatureMismatches: 0,
            account: {
                available: false,
                reason: 'deleted-target-cannot-be-reconciled-against-the-current-index',
                textComplete: false,
                semanticComplete: false,
                safeToDelete: false,
            },
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
        if (!it.account || !it.account.textComplete) {
            actions.push({
                severity: 'error',
                kind: 'incomplete_account',
                message: `${it.name}: caller evidence is not text-complete; inspect warnings and usages manually`,
            });
        }
        if (it.unverifiedCallerCount > 0) {
            actions.push({
                severity: 'warn',
                kind: 'unverified_callers',
                message: `${it.name}: review ${it.unverifiedCallerCount} unverified caller candidate(s)`,
            });
        }
        if (it.account && it.account.filtered > 0) {
            actions.push({
                severity: 'warn',
                kind: 'filtered_evidence',
                message: `${it.name}: ${it.account.filtered} caller edge(s) were hidden by filters`,
            });
        }
        if (it.account && it.account.requiresUsageReview) {
            actions.push({
                severity: 'warn',
                kind: 'non_call_usages',
                message: `${it.name}: non-call references require a usages review`,
            });
        }
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
                message: `${it.name} is new with no observed caller candidates and is not a detected entry point; review usages before treating it as orphaned`,
            });
        }
    }
    if (limit && allChanged.length > limit) {
        actions.push({
            severity: 'error',
            kind: 'truncated_change_set',
            message: `${allChanged.length - limit} changed function(s) were not checked; rerun without --limit`,
        });
    }
    if (testFiles.length > 0) {
        const filesList = testFiles.slice(0, 5).map(t => t.file).join(' ');
        actions.push({
            severity: 'info',
            kind: 'tests_to_run',
            message: `Run tests: ${filesList}`,
        });
    }

    const incompleteAccounts = items.filter(it => !it.account || !it.account.textComplete).length;
    const unverifiedCallSites = items.reduce((sum, it) => sum + (it.unverifiedCallerCount || 0), 0);
    const signatureMismatches = items.reduce((sum, it) => sum + (it.signatureMismatches || 0), 0);
    const filteredEdges = items.reduce((sum, it) => sum + (it.account ? it.account.filtered || 0 : 0), 0);
    const usageReviewSymbols = items.filter(it => it.account && it.account.requiresUsageReview).length;
    const reviewRequired = incompleteAccounts > 0 || unverifiedCallSites > 0 ||
        signatureMismatches > 0 || filteredEdges > 0 || usageReviewSymbols > 0 ||
        actions.some(a => a.kind === 'orphan_new') ||
        !!(limit && allChanged.length > limit);

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
        trust: {
            status: incompleteAccounts > 0 || signatureMismatches > 0
                ? 'BLOCKED'
                : reviewRequired ? 'REVIEW_REQUIRED' : 'READY_FOR_TOOLCHAIN',
            accountsChecked: items.filter(it => it.account && it.account.available).length,
            incompleteAccounts,
            unverifiedCallSites,
            signatureMismatches,
            filteredEdges,
            usageReviewSymbols,
            semanticComplete: false,
            safeToDelete: false,
            requiresCompilerAndTests: true,
        },
    };
}

module.exports = { check };
