/**
 * core/check.js - Pre-commit check: what can this change break?
 *
 * Every changed declaration gets a verdict from what the change DID, not
 * from the fact that it changed:
 *
 *   modified   a change that leaves the callable's contract alone (header,
 *              kind, inferred return: core/change-kinds.js) is inert: no
 *              caller can observe it through the contract. A contract
 *              change is checked against its call sites.
 *   added      a declaration whose name occurs nowhere outside the lines
 *              the diff added, and that cannot take part in anything that
 *              existed (core/capture.js), is inert.
 *   deleted    the base revision's declaration is assessed with the rule
 *              the dead-code audit uses (core/deletion.js): nothing depends
 *              on it, something does, or a named shield says a zero is not
 *              evidence.
 *
 * The three verdicts:
 *
 *   blocked    a break was observed: a confirmed call site that no longer
 *              fits the signature, an import of a name its module no
 *              longer has, a bare call nothing is left to answer.
 *   review     the change can reach existing code and the engine cannot
 *              settle whether it breaks: the reason is named and the sites
 *              are listed.
 *   ready      nothing that existed before depends on what changed.
 *
 * TRUST is the worst verdict among the items. BLOCKED means a definite
 * break, or that the check itself could not run. It never means "there is
 * something to look at": that is REVIEW_REQUIRED.
 */

'use strict';

const { diffImpact, composeAccount, callNotResolvedEntries } = require('./analysis');
const { isValueDefinition, isTestPath } = require('./shared');
const { langTraits } = require('../languages');
const { assessDeletion, definiteDependentsOf, REASON_TEXT } = require('./deletion');
const { occurrencesOutsideChange, captureHazards, HAZARD_TEXT } = require('./capture');
const { reviewItemsOf } = require('./review-items');
const { resolveTarget } = require('./snapshot');
const { projectKind, submoduleOf } = require('./deletion');

const VERDICT_RANK = { ready: 0, review: 1, blocked: 2 };

// What moved in a callable's contract, in words.
const CHANGE_TEXT = Object.freeze({
    'header': 'its declaration changed (parameters, return type, modifiers or decorators)',
    'callable-kind': 'its body now makes it a different kind of callable',
    'inferred-return-contract': 'its return contract is taken from its body, and what it returns changed',
    'inferred-member-type': 'it assigns to a member of its receiver, and a member\'s type is what the class assigns to it',
    'contract-unreadable': 'its contract before the change could not be read',
});

// What a change did to a module outside its declarations, in words.
const MODULE_TEXT = Object.freeze({
    'no-longer-provided': 'other files import a name from this module that it no longer provides',
    'import-removed-still-used': 'an import was removed and the file still uses the name it bound',
    'imports-removed': 'a module the file imported or included without binding a name is no longer imported',
    'module-level-code': 'code outside any declaration changed; what runs when the module loads is not modeled',
    'name-in-use': 'a new import binds a name the file already used',
    'downstream-exposure': 'a name left the exports of a library: consumers outside the repository may use it',
    'name-still-used': 'a name the module no longer provides is still written in a file that imports the whole module',
    'star-export-removed': 'the module no longer passes on everything another module exports; which names its importers lose is not written in it',
});

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
        // Lines of this name in source UCN reads but does not analyze, and
        // paths nothing could be read from: why an account is incomplete.
        unanalyzedLines: account.unsupported ? account.unsupported.lines || 0 : 0,
        unsearchablePaths: account.opaque ? account.opaque.count || 0 : 0,
        unaccounted: account.unaccounted || 0,
        filtered: account.filtered ? account.filtered.total || 0 : 0,
        beyondTextCallers: account.beyondText ? account.beyondText.count || 0 : 0,
        requiresUsageReview: contract.requiresUsageReview === true,
    };
}

/** Why an account is not text-complete, in the account's own terms. */
function incompleteReason(account) {
    if (!account || !account.available) {
        return account && account.reason ? ` (${account.reason})` : '';
    }
    const parts = [];
    if (account.unanalyzedLines > 0) parts.push(`${account.unanalyzedLines} line(s) in unanalyzed source`);
    if (account.unparsedFiles > 0) parts.push(`${account.unparsedFiles} unparsed file(s)`);
    if (account.unreadableFiles > 0) parts.push(`${account.unreadableFiles} unreadable file(s)`);
    if (account.unsearchablePaths > 0) parts.push(`${account.unsearchablePaths} unsearchable path(s)`);
    if (account.unaccounted > 0) parts.push(`${account.unaccounted} unaccounted line(s)`);
    return parts.length ? ` (${parts.join(', ')})` : '';
}

/** The indexed definition a diff entry names, or null. */
function definitionOf(index, entry) {
    const file = entry.relativePath || entry.file || '';
    return (index.symbols.get(entry.name) || []).find(definition =>
        (definition.relativePath === file || definition.file === entry.filePath) &&
        (!entry.startLine || definition.startLine === entry.startLine) &&
        (entry.className == null || (definition.className || null) === (entry.className || null))) || null;
}

/** Did the type that owns `definition` exist before the change? */
function ownerExistedBefore(index, definition, addedLinesByFile) {
    if (!definition.className) return false;
    const owners = (index.symbols.get(definition.className) || []).filter(type =>
        type.file === definition.file && !type.className &&
        type.startLine <= definition.startLine && (type.endLine || type.startLine) >= definition.startLine);
    // An owner declared elsewhere (a receiver method, an impl block, an
    // out-of-class definition) is not in the lines this file added.
    if (owners.length === 0) return true;
    const added = addedLinesByFile.get(definition.relativePath);
    return owners.some(owner => !added || !added.has(owner.nameLine || owner.startLine));
}

/** Callers of one declaration, both tiers, with the account over them. */
function callersOf(index, name, definition) {
    const raw = index.findCallers(name, {
        includeMethods: true,
        collectAccount: true,
        targetDefinitions: definition ? [definition] : undefined,
    }) || [];
    const account = composeAccount(index, name, raw);
    return {
        confirmed: raw.filter(caller => caller.tier !== 'unverified'),
        unverified: raw.filter(caller => caller.tier === 'unverified')
            .concat(raw.unverifiedEntries || [])
            .concat(callNotResolvedEntries(index, account)),
        account,
    };
}

/**
 * Verdict of an ADDED declaration.
 * @returns {{verdict, reasons: string[], hazards?: string[], outside?: object[]}}
 */
function assessAddition(index, entry, definition, addedLinesByFile, account) {
    if (!definition) return { verdict: 'review', reasons: ['declaration-not-indexed'] };
    const occurrences = occurrencesOutsideChange(index, entry.name, addedLinesByFile, definition);
    const summary = summarizeAccount(account);
    const reasons = [];
    if (occurrences.outside.length > 0) reasons.push('name-in-use');
    else if (summary.available && (summary.unanalyzedLines > 0 || summary.unsearchablePaths > 0 ||
        summary.unparsedFiles > 0 || summary.unreadableFiles > 0)) reasons.push('novelty-unknown');
    let shield;
    try {
        const assessment = assessDeletion(index, definition);
        shield = assessment.verdict === 'review' ? assessment.reason : null;
    } catch (_) { shield = null; }
    let contract;
    try {
        contract = require('./deadcode').contractFactsOf(index, definition, index.files.get(definition.file)?.language);
    } catch (_) { contract = null; }
    const hazards = captureHazards(index, definition, {
        ownerExisted: ownerExistedBefore(index, definition, addedLinesByFile),
        contract,
        shield,
    });
    reasons.push(...hazards);
    return {
        verdict: reasons.length > 0 ? 'review' : 'ready',
        reasons,
        ...(occurrences.outside.length > 0 && { outside: occurrences.outside }),
    };
}

/**
 * Verdict of a DELETED declaration, from the base revision's record.
 * @returns {{verdict, reasons: string[], sites?: object[], basis?: string}}
 */
function assessRemoval(index, deleted) {
    const declaration = deleted.declaration;
    if (!declaration) return { verdict: 'review', reasons: ['base-declaration-unreadable'] };
    let assessment;
    try {
        assessment = assessDeletion(index, declaration, { fileEntry: deleted.baseFileEntry || null });
    } catch (_) {
        return { verdict: 'review', reasons: ['base-declaration-unreadable'] };
    }
    if (assessment.verdict === 'no-static-dependents') return { verdict: 'ready', reasons: [] };
    const definite = definiteDependentsOf(index, declaration);
    if (definite.length > 0) {
        return { verdict: 'blocked', reasons: ['still-referenced'], sites: definite, basis: assessment.basis };
    }
    return {
        verdict: 'review',
        reasons: [assessment.verdict === 'has-static-dependents' ? 'name-still-used' : assessment.reason],
        basis: assessment.basis,
        ...(assessment.site && { sites: [assessment.site] }),
    };
}

/**
 * Verdict of what a change did to a module outside its declarations.
 *
 *   blocked  another file imports a name from the module that the module
 *            no longer provides (an export keyword or list entry removed,
 *            an import other modules took through it);
 *   review   an explicit export left a library's surface; an import was
 *            dropped whose name the file still uses, or one that binds no
 *            name here (a side effect, an inclusion); loose module code
 *            changed; a new import binds a name the file already used.
 *
 * @returns {{verdict, reasons: string[], sites: object[]}}
 */
function assessModuleChange(index, moved) {
    const sites = [];
    // Files that hold the whole module under a name (`import * as ns`,
    // `import m`): they reach its names as members, not as imports.
    const holders = new Map(); // relative path -> local names of the module
    const bySite = (a, b) => (a.file === b.file ? a.line - b.line : (a.file < b.file ? -1 : 1));
    // What the module still provides: a binding of one of these names, or
    // of a removed one, takes that name. Any other binding of the module
    // is the module itself (`const m = require('./m')`, `import m`).
    const own = index.files.get(moved.filePath);
    const provides = new Set(own?.exports || []);
    if (langTraits(own?.language)?.moduleNamesImportable) {
        for (const symbol of own?.symbols || []) if (!symbol.className) provides.add(symbol.name);
    }
    const named = binding => moved.removedNames.includes(binding.name) || provides.has(binding.name);
    for (const entry of index.files.values()) {
        const resolved = entry.moduleResolved || {};
        for (const binding of entry.importBindings || []) {
            if (binding.dynamic || resolved[binding.module] !== moved.relativePath) continue;
            if (binding.kind === 'namespace' ||
                ((binding.kind === 'import' || binding.kind === 'require') && !named(binding))) {
                if (!holders.has(entry.relativePath)) holders.set(entry.relativePath, new Set());
                holders.get(entry.relativePath).add(binding.alias || binding.name);
                continue;
            }
            const taken = binding.kind === 'default' ? 'default' : binding.name;
            if (!moved.removedNames.includes(taken)) continue;
            if (taken !== 'default' && submoduleOf(resolved, binding.module, taken)) continue;
            sites.push({ file: entry.relativePath, line: binding.line || 0, kind: `import ${taken}` });
        }
    }
    sites.sort(bySite);
    if (sites.length > 0) return { verdict: 'blocked', reasons: ['no-longer-provided'], sites };
    const reasons = [];
    const stillUsed = [];
    // A removed name still written in a file that holds the module: it may
    // be the member that file reaches through it.
    for (const name of moved.removedNames) {
        if (name === 'default' || holders.size === 0) continue;
        for (const row of index.usages(name, { includeTests: true, codeOnly: true }) || []) {
            const file = row.relativePath || row.file;
            if (!holders.has(file) || row.isDefinition) continue;
            stillUsed.push({ file, line: row.line, kind: `uses ${name}` });
        }
    }
    if (stillUsed.length > 0) reasons.push('name-still-used');
    for (const name of moved.removedBindings) {
        for (const row of index.usages(name, { includeTests: true, codeOnly: true }) || []) {
            if ((row.relativePath || row.file) !== moved.relativePath) continue;
            if (row.isDefinition || row.usageType === 'import' || row.usageType === 'definition') continue;
            stillUsed.push({ file: moved.relativePath, line: row.line, kind: `uses ${name}` });
        }
    }
    if (stillUsed.length > 0) reasons.push('import-removed-still-used');
    // A module that is no longer imported and bound no name was there
    // for what importing it does (a side effect, an inclusion).
    if ((moved.removedBareImports || []).length > 0) reasons.push('imports-removed');
    if (moved.removedExports.length > 0 && projectKind(index) === 'library') reasons.push('downstream-exposure');
    if (moved.starExportRemoved) reasons.push('star-export-removed');
    // Loose code in a test file is the test: nothing imports it for
    // what it does when it loads.
    if (moved.codeChanged && !isTestPath(moved.relativePath)) reasons.push('module-level-code');
    if ((moved.shadowed || []).length > 0) reasons.push('name-in-use');
    return { verdict: reasons.length > 0 ? 'review' : 'ready', reasons, sites: stillUsed.sort(bySite) };
}

/**
 * Run the pre-commit check.
 *
 * @param {object} index - ProjectIndex
 * @param {object} options - { base, staged, file, limit, strict }
 *   strict: REVIEW_REQUIRED does not pass either (`trust.passes`).
 * @returns {object}
 */
function check(live, options = {}) {
    // A staged check describes the git index. Everything below reads the
    // tree the diff's new side lives in (core/snapshot.js).
    let target;
    try {
        target = resolveTarget(live, { staged: !!options.staged, force: !!options.forceStagedSnapshot });
    } catch (e) {
        if (e && e.code === 'staged-snapshot-unavailable') {
            // Did the repository itself answer? Outside one, the ordinary
            // "not a git repository" report is the truthful one.
            try { diffImpact(live, { base: options.base || 'HEAD', staged: true, file: options.file }); } catch (inner) {
                const message = inner && inner.message ? inner.message : 'diff failed';
                return {
                    base: options.base || 'HEAD', staged: true, ok: false,
                    status: /not a git repositor/i.test(message) ? 'not-a-repo' : 'diff-failed',
                    error: message,
                };
            }
            return {
                base: options.base || 'HEAD', staged: true, ok: false,
                status: 'staged-snapshot-unavailable',
                error: `the staged tree could not be exported and indexed (${e.message}); nothing was checked`,
            };
        }
        throw e;
    }
    try {
        const result = checkTarget(target.index, options, target.repoRoot);
        if (target.notes.length > 0 && result && result.ok !== false) result.notes = target.notes;
        return result;
    } finally {
        target.dispose();
    }
}

function checkTarget(index, options, repoRoot) {
    let dr;
    try {
        dr = diffImpact(index, {
            base: options.base || 'HEAD',
            staged: !!options.staged,
            file: options.file,
            repoRoot,
        });
    } catch (e) {
        // The gate could not run at all. This must stay distinguishable from a
        // clean tree in every machine-readable field (status, ok), not just the
        // free-text reason — CI gating on exit code or `empty` must never read
        // "could not run" as "passed".
        const message = e && e.message ? e.message : 'diff failed';
        return {
            base: options.base || 'HEAD',
            staged: !!options.staged,
            ok: false,
            status: /not a git repositor/i.test(message) ? 'not-a-repo' : 'diff-failed',
            error: message,
        };
    }

    // diffImpact returns { base, functions, newFunctions, deletedFunctions }
    const modified = (dr && Array.isArray(dr.functions)) ? dr.functions : [];
    const added    = (dr && Array.isArray(dr.newFunctions)) ? dr.newFunctions : [];
    const deleted  = (dr && Array.isArray(dr.deletedFunctions)) ? dr.deletedFunctions : [];
    const declarations = [
        ...(dr?.symbols || []).map(s => ({ ...s, _kind: 'modified', _nonCallable: true })),
        ...(dr?.newSymbols || []).map(s => ({ ...s, _kind: 'added', _nonCallable: true })),
        ...(dr?.deletedSymbols || []).map(s => ({ ...s, _kind: 'deleted', _nonCallable: true })),
    ];
    const addedLinesByFile = dr?.addedLinesByFile || new Map();
    const pathCounts = {
        changedPaths: dr?.changedPaths || 0,
        nonSourcePaths: dr?.nonSourcePaths || 0,
        untrackedPaths: dr?.untrackedPaths || 0,
    };

    const allChanged = [
        ...modified.map(f => ({ ...f, _kind: 'modified' })),
        ...added.map(f => ({ ...f, _kind: 'added' })),
        ...declarations,
    ];

    // Outside the declarations: what each changed module still provides to
    // its importers, which imports it dropped, what loose code it runs.
    const moduleItems = [];
    for (const moved of dr?.moduleChanges || []) {
        const outcome = assessModuleChange(index, moved);
        if (outcome.verdict === 'ready') continue;
        moduleItems.push({
            name: '(module)',
            file: moved.relativePath,
            line: 1,
            kind: 'module',
            callerCount: 0,
            unverifiedCallerCount: 0,
            signatureMismatches: 0,
            verdict: outcome.verdict,
            reasons: outcome.reasons,
            ...(outcome.sites.length > 0 && { sites: outcome.sites }),
        });
    }

    if (!dr || (allChanged.length === 0 && deleted.length === 0 && moduleItems.length === 0)) {
        // fix #283: say what the diff actually contained. "no changes
        // detected" with three changed files reads as a false negative in a
        // pre-commit hook — the truth is the changes are outside what the
        // symbol analysis can see.
        const changedPaths = dr?.changedPaths || 0;
        const nonSourcePaths = dr?.nonSourcePaths || 0;
        let reason = 'no changes detected';
        if (changedPaths > 0 && nonSourcePaths === changedPaths) {
            reason = `${changedPaths} changed path(s), all outside supported source files; untracked source files are included`;
        } else if (changedPaths > 0) {
            reason = 'no indexed-symbol changes in the diff or untracked source files';
        }
        return {
            base: options.base || 'HEAD',
            staged: !!options.staged,
            ok: true,
            status: 'clean',
            empty: true,
            reason,
            ...pathCounts,
        };
    }

    const limit = options.limit && options.limit > 0 ? options.limit : null;
    const changed = limit ? allChanged.slice(0, limit) : allChanged;

    const items = [];

    for (const fn of changed) {
        const filePath = fn.relativePath || fn.file || '';
        if (fn._nonCallable) {
            const dependency = fn.impact?.typeReferences || fn.impact?.propertyAccesses || fn.impact?.valueAccesses;
            // A value declaration (field, constant, module variable) is read
            // and written through its value-access sites (fix #420): its
            // change is reviewed there, as a function body change is through
            // its callers. A type's shape and inheritance are not checked.
            const valueDeclaration = isValueDefinition(fn);
            const item = {
                name: fn.name, file: filePath, line: fn.startLine, kind: fn._kind,
                symbolType: fn.type, requiresToolchainValidation: true,
                ...(valueDeclaration && { valueDeclaration: true }),
                callerCount: fn.impact?.totalCallSites || 0,
                unverifiedCallerCount: fn.impact?.unverifiedSites?.length || 0,
                // Non-call sites: a value band also lists its call tokens.
                dependencyCount: valueDeclaration && Number.isInteger(fn.impact?.totalDependencySites)
                    ? Math.max(0, fn.impact.totalDependencySites - (fn.impact.totalCallSites || 0))
                    : dependency?.confirmedCount || 0,
                unverifiedDependencyCount: (dependency?.unverifiedCount || 0) + (fn.remainingReferences?.length || 0),
                signatureMismatches: 0,
                account: summarizeAccount(fn.impact?.account),
            };
            if (fn._kind === 'added') {
                // A new declaration under a new name, in a type that is new
                // too, cannot be reached by anything that existed.
                const outcome = assessAddition(index, fn, definitionOf(index, fn), addedLinesByFile, fn.impact?.account);
                item.verdict = outcome.verdict;
                item.reasons = outcome.reasons;
                if (outcome.outside) item.sites = outcome.outside;
            } else if (fn._kind === 'deleted') {
                // Kinds the dead-code rule does not audit (fields, constants,
                // aliases) are never cleared: what remains is the name's
                // other occurrences, each a candidate.
                const definite = definiteDependentsOf(index, {
                    name: fn.name, file: fn.filePath, relativePath: filePath, className: fn.className,
                });
                item.verdict = definite.length > 0 ? 'blocked' : 'review';
                item.reasons = definite.length > 0 ? ['still-referenced']
                    : [(fn.remainingReferences || []).length > 0 ? 'name-still-used' : 'declaration-removed'];
                if (definite.length > 0) item.sites = definite;
            } else {
                item.verdict = 'review';
                item.reasons = [valueDeclaration ? 'value-change' : 'declaration-change'];
            }
            items.push(item);
            continue;
        }

        if (fn._kind === 'modified') {
            const change = fn.change || { kind: 'unknown', reasons: ['contract-unreadable'] };
            const callers = Array.isArray(fn.callers) ? fn.callers : [];
            const unverifiedCallers = Array.isArray(fn.unverifiedCallers) ? fn.unverifiedCallers : [];
            const item = {
                name: fn.name,
                file: filePath,
                line: fn.startLine || fn.line,
                kind: 'modified',
                change: change.kind,
                callerCount: callers.length,
                unverifiedCallerCount: unverifiedCallers.length,
                signatureMismatches: 0,
                account: summarizeAccount(fn.account || null),
            };
            if (change.kind === 'inert') {
                // The contract every caller relies on is untouched.
                item.verdict = 'ready';
                item.reasons = [];
                items.push(item);
                continue;
            }
            // The base revision decides which call sites the changed
            // declaration bound before (fix #394). An exception inside verify
            // is an internal error, never a silently skipped check.
            const verifyResult = index.verify(fn.name, {
                file: filePath, line: fn.startLine, base: options.staged ? 'HEAD' : (options.base || 'HEAD'),
            });
            // Note: verify() returns `mismatches` as a COUNT and `mismatchDetails` as the array.
            const mismatches = verifyResult && Array.isArray(verifyResult.mismatchDetails)
                ? verifyResult.mismatchDetails
                : [];
            item.signatureMismatches = mismatches.length;
            if (mismatches.length > 0) {
                item.mismatches = mismatches;
                item.verdict = 'blocked';
                item.reasons = ['signature-mismatch', ...change.reasons];
            } else {
                // A changed contract matters only to what depends on it.
                // What a method assigns to a member is the CLASS's
                // contract: its dependents are the member's users, whoever
                // calls the method.
                const definition = definitionOf(index, fn);
                let dependents;
                try { dependents = definition ? assessDeletion(index, definition) : null; } catch (_) { dependents = null; }
                if (dependents && dependents.verdict === 'no-static-dependents' &&
                    !change.reasons.includes('inferred-member-type')) {
                    item.verdict = 'ready';
                    item.reasons = [];
                    item.noDependents = true;
                } else {
                    item.verdict = 'review';
                    item.reasons = [...change.reasons];
                    if (dependents && dependents.verdict === 'review') item.shield = dependents.reason;
                }
            }
            item.reviewItems = reviewItemsOf(unverifiedCallers);
            items.push(item);
            continue;
        }

        // Added callable.
        const definition = definitionOf(index, fn);
        const found = callersOf(index, fn.name, definition);
        const outcome = assessAddition(index, fn, definition, addedLinesByFile, found.account);
        const item = {
            name: fn.name,
            file: filePath,
            line: fn.startLine || fn.line,
            kind: 'added',
            callerCount: found.confirmed.length,
            unverifiedCallerCount: found.unverified.length,
            signatureMismatches: 0,
            account: summarizeAccount(found.account),
            verdict: outcome.verdict,
            reasons: outcome.reasons,
            ...(outcome.outside && { sites: outcome.outside }),
        };
        // Orphan = newly added with zero caller CANDIDATES IN EITHER TIER and
        // not an entry point. Zero confirmed + N unverified is NOT orphan
        // (the #223 reverseTrace entry-point soundness rule). Information
        // about the addition, never a reason to hold the change.
        if (found.confirmed.length === 0 && found.unverified.length === 0 && definition) {
            const language = index.files.get(definition.file)?.language;
            let adapter;
            try { adapter = language ? require('../languages').getLanguageAdapter(language) : null; } catch (_) { adapter = null; }
            let entryKind;
            try { entryKind = adapter?.getEntryPointKind ? adapter.getEntryPointKind(definition) : null; } catch (_) { entryKind = null; }
            let isEntry = !!entryKind;
            try { isEntry = isEntry || !!adapter?.isEntryPoint?.(definition); } catch (_) { /* keep */ }
            item.orphan = !isEntry;
        }
        items.push(item);
    }

    // Deleted callables: the base revision's declaration, assessed against
    // what the snapshot still holds.
    for (const d of deleted) {
        const outcome = assessRemoval(index, d);
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
            verdict: outcome.verdict,
            reasons: outcome.reasons,
            ...(outcome.basis && { basis: outcome.basis }),
            ...(outcome.sites && { sites: outcome.sites }),
        });
    }

    items.push(...moduleItems);

    // Affected tests (top-level summary, capped)
    let testFiles = [];
    let testCount = 0;
    for (const fn of changed.slice(0, 10)) {
        const t = index.affectedTests(fn.name, { depth: 2 });
        if (t && t.testFiles) {
            for (const tf of t.testFiles) {
                if (!testFiles.find(x => x.file === tf.file)) {
                    testFiles.push(tf);
                    testCount += tf.testCount || 0;
                }
            }
        }
    }

    // Action items: one per reason an item is not ready, then what else the
    // evidence about a non-ready item says.
    const actions = [];
    const reasonText = code => CHANGE_TEXT[code] || HAZARD_TEXT[code] || REASON_TEXT[code] || null;
    for (const it of items) {
        if (it.kind !== 'module') continue;
        for (const code of it.reasons) {
            actions.push({
                severity: it.verdict === 'blocked' ? 'error' : 'warn',
                kind: 'module_change',
                message: `${it.file}: ${MODULE_TEXT[code] || code}` +
                    (it.verdict === 'blocked' ? ` (${it.sites.length} site(s))` : ''),
            });
        }
    }
    for (const it of items) {
        if (it.kind === 'module') continue;
        if (it.verdict === 'ready') {
            if (it.orphan) {
                actions.push({
                    severity: 'info',
                    kind: 'orphan_new',
                    message: `${it.name} is new and nothing calls it yet; it is not a detected entry point`,
                });
            }
            continue;
        }
        if (it.signatureMismatches > 0) {
            actions.push({
                severity: 'error',
                kind: 'signature_drift',
                message: `${it.name}: ${it.signatureMismatches} call site(s) no longer fit the signature`,
            });
        }
        if (it.kind === 'deleted' && it.verdict === 'blocked') {
            actions.push({
                severity: 'error',
                kind: 'deleted_still_referenced',
                message: `${it.name}: deleted, and ${it.sites.length} site(s) still import or call it`,
            });
        } else if (it.kind === 'deleted') {
            const why = it.reasons[0] === 'name-still-used'
                ? 'the name is still used; check whether those uses meant this declaration'
                : it.reasons[0] === 'declaration-removed'
                    ? 'a declaration of this kind is not cleared by the engine; run the compiler/type checker and tests'
                    : (it.basis || reasonText(it.reasons[0]) || it.reasons[0]);
            actions.push({ severity: 'warn', kind: 'deleted_review', message: `${it.name}: deleted; ${why}` });
        }
        if (it.requiresToolchainValidation && it.kind === 'modified') {
            actions.push(it.valueDeclaration ? {
                severity: 'warn',
                kind: 'value_change',
                message: `${it.name}: modified ${it.symbolType}; review its ${it.dependencyCount + it.callerCount} value access site(s) and run the compiler/type checker and tests`,
            } : {
                severity: 'warn',
                kind: 'declaration_change',
                message: `${it.name}: modified ${it.symbolType}; shape/inheritance compatibility is not checked by arity analysis — review dependency sites and run the compiler/type checker and tests`,
            });
        }
        if (it.kind === 'modified' && !it.requiresToolchainValidation) {
            const moved = it.reasons.filter(code => CHANGE_TEXT[code]).map(code => CHANGE_TEXT[code]);
            if (moved.length > 0) {
                actions.push({
                    severity: 'warn',
                    kind: 'contract_change',
                    message: `${it.name}: ${moved.join('; ')}; review its ${it.callerCount} caller(s)` +
                        (it.shield ? ` (${reasonText(it.shield) || it.shield})` : ''),
                });
            }
        }
        if (it.kind === 'added') {
            for (const code of it.reasons) {
                actions.push({
                    severity: 'warn',
                    kind: 'addition_hazard',
                    message: `${it.name}: ${reasonText(code) || code}`,
                });
            }
        }
        // Evidence about callers matters where the callers do.
        if (it.kind !== 'deleted') {
            if (!it.account || !it.account.textComplete) {
                actions.push({
                    severity: 'warn',
                    kind: 'incomplete_account',
                    message: `${it.name}: caller evidence is not text-complete` +
                        `${incompleteReason(it.account)}; inspect warnings and usages manually`,
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
        }
    }
    if (limit && allChanged.length > limit) {
        actions.push({
            severity: 'error',
            kind: 'truncated_change_set',
            message: `${allChanged.length - limit} changed symbol(s) were not checked; rerun without --limit`,
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

    // Counts describe the items whose callers matter: an inert change has
    // callers, and none of them is something to look at.
    const open = items.filter(it => it.verdict !== 'ready');
    const blocked = items.filter(it => it.verdict === 'blocked').length;
    const review = items.filter(it => it.verdict === 'review').length;
    const truncated = !!(limit && allChanged.length > limit);
    const worst = items.reduce((rank, it) => Math.max(rank, VERDICT_RANK[it.verdict] || 0), truncated ? 1 : 0);
    const callerItems = open.filter(it => it.kind !== 'deleted' && it.kind !== 'module');

    return {
        base: options.base || 'HEAD',
        staged: !!options.staged,
        ok: true,
        status: 'checked',
        ...pathCounts,
        changed: items,
        totalChanged: allChanged.length + deleted.length + moduleItems.length,
        truncated,
        testFiles,
        totalTestFiles: testFiles.length,
        totalTests: testCount,
        actions,
        trust: {
            status: worst === 2 ? 'BLOCKED' : worst === 1 ? 'REVIEW_REQUIRED' : 'READY_FOR_TOOLCHAIN',
            // The one boolean a gate needs: a break never passes; something
            // to look at passes unless the caller asked for strict.
            passes: worst === 0 || (worst === 1 && !options.strict),
            ...(options.strict && { strict: true }),
            blocked,
            review,
            ready: items.length - blocked - review,
            accountsChecked: items.filter(it => it.account && it.account.available).length,
            incompleteAccounts: callerItems.filter(it => !it.account || !it.account.textComplete).length,
            unverifiedCallSites: callerItems.reduce((sum, it) => sum + (it.unverifiedCallerCount || 0), 0),
            signatureMismatches: items.reduce((sum, it) => sum + (it.signatureMismatches || 0), 0),
            filteredEdges: callerItems.reduce((sum, it) => sum + (it.account ? it.account.filtered || 0 : 0), 0),
            usageReviewSymbols: callerItems.filter(it => it.account && it.account.requiresUsageReview).length,
            unvalidatedDeclarations: open.filter(it => it.requiresToolchainValidation).length,
            // What there is to look at among unverified callers: one per
            // site a reader can settle, one per dispatch family.
            reviewItems: callerItems.reduce((sum, it) => sum + (it.reviewItems ? it.reviewItems.items : 0), 0),
            semanticComplete: false,
            safeToDelete: false,
            requiresCompilerAndTests: true,
        },
    };
}

module.exports = { check };
