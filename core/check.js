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
 *   review     change exposure or call requirements are not settled:
 *              the reason is named and the sites are listed.
 *   ready      no unresolved exposure remains in the modeled checks.
 *
 * A changed outgoing call is checked too. Positive argument fit preserves
 * a baseline invocation only in an unchanged written context; it is not a
 * compiler proof for arbitrary new calls or surrounding expressions.
 *
 * TRUST is the worst verdict among the items. BLOCKED means a definite
 * break, or that the check itself could not run. It never means "there is
 * something to look at": that is REVIEW_REQUIRED.
 */

'use strict';

const { diffImpact, composeAccount, callNotResolvedEntries } = require('./analysis');
const { providedNames } = require('./change-kinds');
const { outgoingChecker } = require('./outgoing-check');
const fs = require('fs');
const path = require('path');
const { isValueDefinition, isTestPath } = require('./shared');
const { langTraits } = require('../languages');
const { assessDeletion, definiteDependentsOf, REASON_TEXT } = require('./deletion');
const { occurrencesOutsideChange, captureHazards, shapeChangeOf, literalsLackingMember, newOwnerUnreached, HAZARD_TEXT } = require('./capture');
const { reviewItemsOf } = require('./review-items');
const { createTestModel, linkFiles, commandsFor, testSiteKey } = require('./test-units');
// Reasons a file has no command that are about the file, not the runner.
const FILE_WOULD_NOT_RUN = new Set(['declared-indirectly', 'collection-switched-off', 'conditional-tests']);
const { resolveTarget, flaggedPaths } = require('./snapshot');
const { projectKind, submoduleOf } = require('./deletion');

const VERDICT_RANK = { ready: 0, review: 1, blocked: 2 };

// What moved in a callable's contract, in words.
const CHANGE_TEXT = Object.freeze({
    'header': 'its declaration changed (parameters, return type, modifiers or decorators)',
    'callable-kind': 'its body now makes it a different kind of callable',
    'inferred-return-contract': 'its return contract is taken from its body, and what it returns changed',
    'inferred-member-type': 'it assigns to a member of its receiver, and a member\'s type is what the class assigns to it',
    'contract-unreadable': 'its contract before the change could not be read',
    'site-not-checked': 'the sites that no longer fit are under a comment that tells the toolchain not to check them: they are listed, and a build will not show them',
});

// What a change did to a module outside its declarations, in words.
const MODULE_TEXT = Object.freeze({
    'no-longer-provided': 'other files import a name from this module that it no longer provides',
    'import-removed-still-used': 'an import was removed and the file still uses the name it bound',
    'imports-removed': 'a module the file imported or included without binding a name is no longer imported',
    'checking-context-changed': 'checker directives changed; previously unchecked source may now be checked',
    'module-level-code': 'code outside any declaration changed; what runs when the module loads is not modeled',
    'name-in-use': 'a new import binds a name the file already used',
    'downstream-exposure': 'a name left the exports of a library: consumers outside the repository may use it',
    'name-still-used': 'a name the module no longer provides is still written in a file that imports the whole module',
    'star-export-removed': 'the module no longer passes on everything another module exports; which names its importers lose is not written in it',
    'import-rebound': 'a name the file imports now comes from somewhere else: every use of it in the file means something new',
    'module-name-in-use': 'the file is new and imports that existed before can resolve to it: what they meant before, they may not mean now',
    'deleted-still-imported': 'the file was deleted and other files still import it',
    'deleted-still-loaded-unchecked': 'the file was deleted and other files still load it where the toolchain does not look (a call, or an import under a check suppression): it fails when that code runs unless the failure is handled',
    'site-not-checked': 'a name this module no longer provides is still imported, under a comment that tells the toolchain not to check that line',
    'deleted-name-still-imported': 'the file was deleted and other files import a module of its name; a module outside the project may answer',
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
function assessAddition(index, entry, definition, addedLinesByFile, account, judge, nonCallable = false) {
    if (!definition) return { verdict: 'review', reasons: ['declaration-not-indexed'] };
    const ownerExisted = ownerExistedBefore(index, definition, addedLinesByFile);
    const occurrences = !ownerExisted && newOwnerUnreached(index, definition, addedLinesByFile)
        ? { outside: [], total: 0 }
        : occurrencesOutsideChange(index, entry.name, addedLinesByFile, definition);
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
    let shape;
    try { shape = ownerExisted ? shapeChangeOf(index, definition, addedLinesByFile) : null; } catch (_) { shape = 'shape'; }
    const hazards = captureHazards(index, definition, { ownerExisted, contract, shield, nonCallable, shape });
    reasons.push(...hazards);
    // A member every value of the type must now have, and an object
    // literal declared as that type that does not: a break, not a hazard.
    const mustHave = hazards.includes('new-requirement') || shape === 'required';
    const lacking = ownerExisted && mustHave ? literalsLackingMember(index, definition)
        .filter(site => !addedLinesByFile.get(site.file)?.has(site.line) &&
            !judge.suppressed(site, { kind: 'literal' })) : [];
    if (lacking.length > 0) {
        return { verdict: 'blocked', reasons: ['literal-lacks-new-member', ...reasons], outside: lacking };
    }
    return {
        verdict: reasons.length > 0 ? 'review' : 'ready',
        reasons,
        ...(occurrences.outside.length > 0 && { outside: occurrences.outside }),
    };
}

/**
 * What the project's own judge looks at. A break is a claim about what the
 * language's toolchain (or, with no checker, its runtime) will reject, so
 * a site it has been told to skip, or an import written as a call it never
 * resolves, is not what blocks: it is listed as what it is.
 *
 * A reader belongs to ONE check: it reads the files as they are when the
 * check runs, and nothing it reads outlives the check (an index is rebuilt
 * between checks).
 */
function siteReader(index) {
    let absolute = null;
    const at = relativePath => {
        if (!absolute) {
            absolute = new Map();
            for (const [file, entry] of index.files) absolute.set(entry.relativePath, { file, entry, memo: new Map() });
        }
        return absolute.get(relativePath) || null;
    };
    const rootOf = found => {
        if (!found.memo.has('root')) {
            let root;
            try {
                root = require('./change-kinds').parseRevision(index._readFile(found.file), found.entry.language);
            } catch (_) {
                root = null;
            }
            found.memo.set('root', root);
        }
        return found.memo.get('root');
    };
    return {
        /**
         * The checker has been told not to report this break (trait
         * `checkSuppressedAt`).
         * @param {object} site - { file, line }
         * @param {object} diagnostic - { kind, name?, most? }: what kind
         *   of break it is, which decides where and under which rule the
         *   checker reports it
         */
        suppressed(site, diagnostic) {
            const found = site && site.line ? at(site.file) : null;
            const suppressedAt = found && langTraits(found.entry.language)?.checkSuppressedAt;
            if (typeof suppressedAt !== 'function') return false;
            try {
                return !!suppressedAt({
                    ...diagnostic, line: site.line, lines: index._getFileLines(found.file),
                    root: rootOf(found), memo: found.memo,
                });
            } catch (_) {
                return false;
            }
        },
        /** The import on this line is one the judge resolves (trait `checkedImportAt`). */
        resolvesImport(site) {
            const found = site && site.line ? at(site.file) : null;
            const checkedAt = found && langTraits(found.entry.language)?.checkedImportAt;
            if (typeof checkedAt !== 'function') return true;
            const root = rootOf(found);
            try {
                return root ? !!checkedAt(root, site.line, site.module) : false;
            } catch (_) {
                return false;
            }
        },
    };
}

/**
 * Split the sites of a break into the ones the judge sees and the ones it
 * was told to skip. `describe(site)` says what kind of break each is.
 */
function byJudge(judge, sites, describe) {
    const checked = [];
    const unchecked = [];
    for (const site of sites) {
        if (judge.suppressed(site, describe(site))) unchecked.push({ ...site, unchecked: true });
        else checked.push(site);
    }
    return { checked, unchecked };
}

// A site of a name that is gone: an import of it, or a bare call of it.
const goneName = name => site => ({ kind: site.kind === 'call' ? 'undefined-name' : 'import-name', name, module: site.module });

/**
 * Verdict of a DELETED declaration, from the base revision's record.
 * @returns {{verdict, reasons: string[], sites?: object[], basis?: string}}
 */
function assessRemoval(index, deleted, judge) {
    const declaration = deleted.declaration;
    if (!declaration) return { verdict: 'review', reasons: ['base-declaration-unreadable'] };
    let assessment;
    try {
        assessment = assessDeletion(index, declaration, { fileEntry: deleted.baseFileEntry || null });
    } catch (_) {
        return { verdict: 'review', reasons: ['base-declaration-unreadable'] };
    }
    if (assessment.verdict === 'no-static-dependents') return { verdict: 'ready', reasons: [] };
    const definite = byJudge(judge, definiteDependentsOf(index, declaration), goneName(declaration.name));
    if (definite.checked.length > 0) {
        return {
            verdict: 'blocked', reasons: ['still-referenced'],
            sites: [...definite.checked, ...definite.unchecked], basis: assessment.basis,
        };
    }
    if (definite.unchecked.length > 0) {
        return { verdict: 'review', reasons: ['site-not-checked'], sites: definite.unchecked };
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
function assessModuleChange(index, moved, judge) {
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
            sites.push(Object.defineProperty({ file: entry.relativePath, line: binding.line || 0, kind: `import ${taken}` },
                'module', { value: binding.module, enumerable: false }));
        }
    }
    sites.sort(bySite);
    const importing = byJudge(judge, sites, site =>
        ({ kind: 'import-name', name: site.kind.replace(/^import /, ''), module: site.module }));
    if (importing.checked.length > 0) {
        return { verdict: 'blocked', reasons: ['no-longer-provided'], sites: [...importing.checked, ...importing.unchecked] };
    }
    const reasons = [];
    const stillUsed = [];
    if (importing.unchecked.length > 0) reasons.push('site-not-checked');
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
    const held = stillUsed.length;
    for (const name of moved.removedBindings) {
        for (const row of index.usages(name, { includeTests: true, codeOnly: true }) || []) {
            if ((row.relativePath || row.file) !== moved.relativePath) continue;
            if (row.isDefinition || row.usageType === 'import' || row.usageType === 'definition') continue;
            stillUsed.push({ file: moved.relativePath, line: row.line, kind: `uses ${name}` });
        }
    }
    if (stillUsed.length > held) reasons.push('import-removed-still-used');
    // A module that is no longer imported and bound no name was there
    // for what importing it does (a side effect, an inclusion).
    if ((moved.removedBareImports || []).length > 0) reasons.push('imports-removed');
    if (moved.removedExports.length > 0 && projectKind(index) === 'library') reasons.push('downstream-exposure');
    if ((moved.reboundBindings || []).length > 0) reasons.push('import-rebound');
    if (moved.starExportRemoved) reasons.push('star-export-removed');
    // Loose code in a test file is the test: nothing imports it for
    // what it does when it loads.
    if (moved.codeChanged && !isTestPath(moved.relativePath)) reasons.push('module-level-code');
    if (moved.checkingChanged) reasons.push('checking-context-changed');
    if ((moved.shadowed || []).length > 0) reasons.push('name-in-use');
    return {
        verdict: reasons.length > 0 ? 'review' : 'ready', reasons,
        sites: [...importing.unchecked, ...stillUsed].sort(bySite),
    };
}

const SOURCE_EXTENSION = /\.[A-Za-z0-9+]+$/;
// A file that stands for its directory when imported.
const PACKAGE_FILE = /(?:^|\/)(?:__init__|index|mod)$/;

/**
 * Imports that named a file the change deleted, read from how each import
 * is written (nothing resolves to a file that is gone).
 *
 *   definite  a specifier that can only have meant the deleted file: a
 *             relative one that lands exactly on it (`./gone`,
 *             `from .gone import x`), or a name inside a package of the
 *             project that still resolves (`import pkg.gone`,
 *             `from pkg import gone` where the package's own file does not
 *             supply `gone` itself). Never while something else on disk
 *             can answer the same specifier: the name with another
 *             extension (`gone.d.ts`, `gone.pyi`), a directory of that
 *             name, or the directory itself where a package needs no
 *             package file (trait `packageFileOptional`);
 *   possible  an absolute module name whose path form ends at the deleted
 *             file (`import gone`, `#include "gone.h"`): something outside
 *             the project may carry the same name.
 *
 * A definite import the project's judge does not look at (a call it never
 * resolves, a line under a check suppression: traits `checkedImportAt`,
 * `checkSuppressedAt`) is `unchecked`: it fails when that code runs, and
 * no build will say so.
 *
 * @returns {{definite: object[], unchecked: object[], possible: object[]}}
 *   sites (file, line)
 */
function importersOfDeletedFile(index, deleted, judge) {
    const posix = path.posix;
    const stem = deleted.replace(SOURCE_EXTENSION, '');
    // A package's own file stands for its directory.
    const asDirectory = PACKAGE_FILE.test(stem) ? posix.dirname(stem) : null;
    const lands = candidate => candidate === stem || candidate === deleted || (asDirectory !== null && candidate === asDirectory);
    // What is left on disk beside the deleted file: the same name with
    // another extension or as a directory, and the directory it stood for.
    let twin = false;
    let directoryLeft = false;
    try {
        const name = posix.basename(stem);
        const beside = fs.readdirSync(path.join(index.root, posix.dirname(deleted)));
        twin = beside.some(other => other === name || other.startsWith(`${name}.`));
        directoryLeft = asDirectory !== null;
    } catch (_) {
        // The directory went with the file.
    }
    // Is a landing on the deleted file one nothing else can answer?
    const final = (candidate, traits) => !twin &&
        !(directoryLeft && candidate === asDirectory && traits.packageFileOptional);
    // The directory a package's own file stands for, when `file` is one.
    const packageDirectory = file => {
        const own = String(file).replace(SOURCE_EXTENSION, '');
        return PACKAGE_FILE.test(own) ? posix.dirname(own) : null;
    };
    let byRelativePath = null;
    const entryAt = relativePath => {
        if (!byRelativePath) {
            byRelativePath = new Map();
            for (const fileEntry of index.files.values()) byRelativePath.set(fileEntry.relativePath, fileEntry);
        }
        return byRelativePath.get(relativePath) || null;
    };
    // Can the package's own file hand out `name` without a submodule of
    // that name? 'named': it declares or imports it. 'open': it takes
    // everything another module has, computes its names (trait
    // `moduleSupplyHooks`), or cannot be read. 'none': the name was the
    // submodule.
    const supplyOf = (packageFile, name, traits) => {
        const own = packageFile ? entryAt(packageFile) : null;
        if (!own) return packageFile ? 'open' : 'none';
        const provided = providedNames(own, traits);
        if (provided.names.has(name)) return 'named';
        return provided.open ||
            (traits.moduleSupplyHooks || []).some(hook => provided.names.has(hook)) ||
            (own.importDetails || []).some(detail => (detail.names || []).includes('*')) ? 'open' : 'none';
    };
    // A from-import of names that land on the deleted file.
    // What the checker would report each definite site for: a module that
    // cannot be found, or a name its module does not have.
    const missing = new Map();
    const place = (site, named, packageFile, traits) => {
        const supplies = named.map(name => supplyOf(packageFile, name, traits));
        if (supplies.includes('none')) {
            missing.set(site, { kind: 'import-name', name: named[supplies.indexOf('none')], module: site.module });
            (twin ? possible : definite).push(site);
        } else if (supplies.includes('open')) possible.push(site);
    };
    const definite = [];
    const possible = [];
    for (const entry of index.files.values()) {
        const resolved = entry.moduleResolved || {};
        const from = posix.dirname(entry.relativePath);
        const traits = langTraits(entry.language) || {};
        for (const detail of entry.importDetails || []) {
            const spelled = String(detail.module || '');
            if (!spelled) continue;
            const site = Object.defineProperty({ file: entry.relativePath, line: detail.line || 0, kind: 'import' },
                'module', { value: spelled, enumerable: false });
            if (resolved[spelled]) {
                // The module is still there. Where a from-import can bind a
                // submodule file (trait `submoduleImports`), a name the
                // package's own file does not supply was that file.
                const directory = traits.submoduleImports ? packageDirectory(resolved[spelled]) : null;
                if (directory === null) continue;
                const named = (detail.names || []).filter(name => name !== '*' &&
                    !submoduleOf(resolved, spelled, name) && lands(posix.join(directory, name)));
                place(site, named, resolved[spelled], traits);
                continue;
            }
            if (/^\.{1,2}\//.test(spelled)) {
                // A path relative to the importing file.
                const target = posix.normalize(posix.join(from, spelled)).replace(SOURCE_EXTENSION, '');
                if (lands(target)) (final(target, traits) ? definite : possible).push(site);
                continue;
            }
            const dots = /^\.+/.exec(spelled);
            if (dots) {
                // A module relative to the importing package: one dot is
                // the package, each further dot its parent.
                let base = from;
                for (let up = 1; up < dots[0].length; up++) base = posix.dirname(base);
                const rest = spelled.slice(dots[0].length).split('.').filter(Boolean);
                if (rest.length > 0) {
                    const target = posix.normalize(posix.join(base, ...rest));
                    if (lands(target)) (final(target, traits) ? definite : possible).push(site);
                    continue;
                }
                // `from . import name`: the package's own file may be what
                // supplies the name.
                const directory = posix.normalize(base);
                let packageFile = null;
                for (const other of index.files.values()) {
                    if (other.language === entry.language && packageDirectory(other.relativePath) === directory) {
                        packageFile = other.relativePath;
                        break;
                    }
                }
                const named = (detail.names || []).filter(name => lands(posix.normalize(posix.join(base, name))));
                place(site, named, packageFile, traits);
                continue;
            }
            // A dotted name under a package of the project that still
            // resolves: the rest of the path is inside that package.
            const parts = spelled.split('.');
            let inside = false;
            for (let length = parts.length - 1; length > 0 && !inside; length--) {
                const prefix = resolved[parts.slice(0, length).join('.')];
                const directory = prefix ? packageDirectory(prefix) : null;
                if (directory !== null && lands(posix.join(directory, ...parts.slice(length)))) inside = true;
            }
            if (inside) { (twin ? possible : definite).push(site); continue; }
            // An absolute name: its path form, anchored at any directory.
            const forms = [spelled.replace(SOURCE_EXTENSION, ''), spelled.split('.').join('/')];
            for (const name of detail.names || []) forms.push(`${spelled.split('.').join('/')}/${name}`);
            if (forms.some(form => stem === form || stem.endsWith(`/${form}`) ||
                (asDirectory !== null && (asDirectory === form || asDirectory.endsWith(`/${form}`))))) possible.push(site);
        }
    }
    const bySite = (a, b) => (a.file === b.file ? a.line - b.line : (a.file < b.file ? -1 : 1));
    const seen = [];
    const unchecked = [];
    for (const site of definite.sort(bySite)) {
        if (judge.resolvesImport(site) &&
            !judge.suppressed(site, missing.get(site) || { kind: 'import-module', module: site.module })) seen.push(site);
        else unchecked.push({ ...site, unchecked: true });
    }
    return { definite: seen, unchecked, possible: possible.sort(bySite) };
}

/** The path forms an import's specifier can mean, read as it is written. */
function specifierForms(entry, detail) {
    const posix = path.posix;
    const spelled = String(detail.module || '');
    const from = posix.dirname(entry.relativePath);
    // exact: relative to the importing file or its package. loose: a name
    // that is looked up from some root.
    const exact = [];
    const loose = [];
    if (!spelled) return { exact, loose };
    if (/^\.{1,2}\//.test(spelled)) {
        exact.push(posix.normalize(posix.join(from, spelled)).replace(SOURCE_EXTENSION, ''));
        return { exact, loose };
    }
    const names = (detail.names || []).filter(name => name !== '*');
    const dots = /^\.+/.exec(spelled);
    if (dots) {
        let base = from;
        for (let up = 1; up < dots[0].length; up++) base = posix.dirname(base);
        const rest = spelled.slice(dots[0].length).split('.').filter(Boolean);
        const module = posix.normalize(posix.join(base, ...rest));
        if (rest.length > 0) exact.push(module);
        for (const name of names) exact.push(posix.normalize(posix.join(module, name)));
        return { exact, loose };
    }
    const slashed = spelled.split('.').join('/');
    loose.push(spelled.replace(SOURCE_EXTENSION, ''), slashed);
    for (const name of names) loose.push(`${slashed}/${name}`);
    return { exact, loose };
}

/**
 * Imports that existed before the change and that can mean a file the
 * change ADDED: the index now resolves them to it; or their specifier,
 * relative to where it is written, lands on it; or it names a module of
 * the project that the new file now stands beside under the same name
 * (`lib.py` and a new `lib/` package, `lib/index.ts` and a new `lib.ts`).
 * Which of two the language picks is its resolver's order; that the
 * import meant something else before is certain.
 *
 * @returns {object[]} sites (file, line), sorted
 */
function importsThatCanMean(index, added, addedLinesByFile) {
    const posix = path.posix;
    const stem = added.replace(SOURCE_EXTENSION, '');
    const asDirectory = PACKAGE_FILE.test(stem) ? posix.dirname(stem) : null;
    const lands = form => form === stem || form === asDirectory;
    const landsLoosely = form => lands(form) || stem.endsWith(`/${form}`) ||
        (asDirectory !== null && asDirectory.endsWith(`/${form}`));
    const sites = [];
    for (const entry of index.files.values()) {
        if (entry.relativePath === added) continue;
        const resolved = entry.moduleResolved || {};
        const addedLines = addedLinesByFile.get(entry.relativePath);
        for (const detail of entry.importDetails || []) {
            if (!detail.line || (addedLines && addedLines.has(detail.line))) continue;
            const spelled = String(detail.module || '');
            const composed = (detail.names || []).map(name => (spelled.endsWith('.') ? spelled + name : `${spelled}.${name}`));
            const forms = specifierForms(entry, detail);
            const taken = resolved[spelled] === added || composed.some(name => resolved[name] === added);
            const beside = !!resolved[spelled] && resolved[spelled] !== added && forms.loose.some(landsLoosely);
            if (taken || beside || forms.exact.some(lands)) {
                sites.push({ file: entry.relativePath, line: detail.line, kind: 'import' });
            }
        }
    }
    return sites.sort((a, b) => (a.file === b.file ? a.line - b.line : (a.file < b.file ? -1 : 1)));
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
            // Outside a repository there is no index to describe: the
            // ordinary "not a git repository" report is the truthful one.
            if (e.reason === 'not-a-repository') {
                try { diffImpact(live, { base: options.base || 'HEAD', staged: true, file: options.file }); } catch (inner) {
                    const message = inner && inner.message ? inner.message : 'diff failed';
                    return {
                        base: options.base || 'HEAD', staged: true, ok: false,
                        status: /not a git repositor/i.test(message) ? 'not-a-repo' : 'diff-failed',
                        error: message,
                    };
                }
            }
            return {
                base: options.base || 'HEAD', staged: true, ok: false,
                status: 'staged-snapshot-unavailable',
                error: `the staged tree could not be exported and indexed (${e.message}); nothing was checked`,
            };
        }
        throw e;
    }
    target.index._beginOp();
    try {
        const result = checkTarget(target.index, options, target.repoRoot);
        const notes = [...target.notes];
        // A worktree check reads the worktree, but which files CHANGED is
        // git's answer, and git does not look at a path it was told to
        // assume unchanged or to skip.
        if (!options.staged && result && result.ok !== false) {
            let flagged;
            try { flagged = flaggedPaths(live.root); } catch (_) { flagged = []; }
            if (flagged.length > 0) {
                notes.push(`${flagged.length} tracked path(s) are marked assume-unchanged or skip-worktree ` +
                    `(${flagged[0].path}${flagged.length > 1 ? ', ...' : ''}): git does not report their changes, so they are not checked`);
            }
        }
        if (notes.length > 0 && result && result.ok !== false) result.notes = notes;
        return result;
    } finally {
        target.index._endOp();
        target.dispose();
    }
}

function checkTarget(index, options, repoRoot) {
    // What this check reads about each site: nothing outlives it.
    const judge = siteReader(index);
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
        const outcome = assessModuleChange(index, moved, judge);
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

    // A file that is gone, and the imports that named it.
    for (const relativePath of dr?.deletedFiles || []) {
        const importers = importersOfDeletedFile(index, relativePath, judge);
        if (importers.definite.length + importers.unchecked.length + importers.possible.length === 0) continue;
        const broken = importers.definite.length > 0;
        const reasons = [];
        if (broken) reasons.push('deleted-still-imported');
        else {
            if (importers.unchecked.length > 0) reasons.push('deleted-still-loaded-unchecked');
            if (importers.possible.length > 0) reasons.push('deleted-name-still-imported');
        }
        moduleItems.push({
            name: '(module)',
            file: relativePath,
            line: 1,
            kind: 'module',
            callerCount: 0,
            unverifiedCallerCount: 0,
            signatureMismatches: 0,
            verdict: broken ? 'blocked' : 'review',
            reasons,
            sites: broken ? [...importers.definite, ...importers.unchecked]
                : [...importers.unchecked, ...importers.possible].sort((a, b) =>
                    (a.file === b.file ? a.line - b.line : (a.file < b.file ? -1 : 1))),
        });
    }

    // A file that is new, and the imports that could already mean it.
    for (const relativePath of dr?.addedFiles || []) {
        const sites = importsThatCanMean(index, relativePath, addedLinesByFile);
        if (sites.length === 0) continue;
        moduleItems.push({
            name: '(module)',
            file: relativePath,
            line: 1,
            kind: 'module',
            callerCount: 0,
            unverifiedCallerCount: 0,
            signatureMismatches: 0,
            verdict: 'review',
            reasons: ['module-name-in-use'],
            sites,
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
    const outgoing = outgoingChecker(index, judge, addedLinesByFile);
    const withOutgoing = (item, fn) => {
        if (fn._kind === 'deleted') return item;
        const result = outgoing(definitionOf(index, fn), fn.change, fn._kind === 'added');
        if (!result.mismatches.length && !result.unsettled.length) return item;
        const blocking = result.mismatches.filter(row => !row.unchecked).length;
        item.signatureMismatches += blocking;
        if (result.mismatches.length) item.mismatches = [...(item.mismatches || []), ...result.mismatches];
        if (result.unsettled.length) item.outgoingReview = result.unsettled;
        if (blocking) {
            item.verdict = 'blocked';
            item.reasons = [...new Set(['outgoing-signature-mismatch', ...item.reasons])];
        } else {
            if (item.verdict === 'ready') item.verdict = 'review';
            item.reasons = [...new Set([...item.reasons,
                ...(result.mismatches.length ? ['site-not-checked'] : []),
                ...(result.unsettled.length ? ['outgoing-call-unverified'] : [])])];
        }
        return item;
    };

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
                const outcome = assessAddition(index, fn, definitionOf(index, fn), addedLinesByFile, fn.impact?.account, judge, true);
                item.verdict = outcome.verdict;
                item.reasons = outcome.reasons;
                if (outcome.outside) item.sites = outcome.outside;
            } else if (fn._kind === 'deleted') {
                // Kinds the dead-code rule does not audit (fields, constants,
                // aliases) are never cleared: what remains is the name's
                // other occurrences, each a candidate.
                const definite = byJudge(judge, definiteDependentsOf(index, {
                    name: fn.name, file: fn.filePath, relativePath: filePath, className: fn.className,
                }), goneName(fn.name));
                item.verdict = definite.checked.length > 0 ? 'blocked' : 'review';
                item.reasons = definite.checked.length > 0 ? ['still-referenced']
                    : definite.unchecked.length > 0 ? ['site-not-checked']
                        : [(fn.remainingReferences || []).length > 0 ? 'name-still-used' : 'declaration-removed'];
                if (definite.checked.length + definite.unchecked.length > 0) {
                    item.sites = [...definite.checked, ...definite.unchecked];
                }
            } else {
                item.verdict = 'review';
                item.reasons = [valueDeclaration ? 'value-change' : 'declaration-change'];
            }
            items.push(withOutgoing(item, fn));
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
                items.push(withOutgoing(item, fn));
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
            // A call site the checker was told to skip is listed and does
            // not block (a deliberately wrong call under `@ts-expect-error`
            // is still one after the signature moves).
            // The checker reports too few arguments at the call and one
            // too many at that argument.
            const most = mismatch => {
                const counts = String(mismatch.expected === undefined ? '' : mismatch.expected).match(/\d+/g);
                return counts ? Number(counts[counts.length - 1]) : undefined;
            };
            const marked = mismatches.map(mismatch =>
                (judge.suppressed(mismatch, {
                    kind: 'arity', name: fn.name, most: most(mismatch), span: mismatch.span,
                    problem: mismatch.problem, indirect: mismatch.indirect,
                }) ? { ...mismatch, unchecked: true } : mismatch));
            item.signatureMismatches = marked.filter(mismatch => !mismatch.unchecked).length;
            if (marked.length > 0) item.mismatches = marked;
            if (item.signatureMismatches > 0) {
                item.verdict = 'blocked';
                item.reasons = ['signature-mismatch', ...change.reasons];
            } else if (marked.length > 0) {
                item.verdict = 'review';
                item.reasons = ['site-not-checked', ...change.reasons];
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
            items.push(withOutgoing(item, fn));
            continue;
        }

        // Added callable.
        const definition = definitionOf(index, fn);
        const found = callersOf(index, fn.name, definition);
        const outcome = assessAddition(index, fn, definition, addedLinesByFile, found.account, judge);
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
        items.push(withOutgoing(item, fn));
    }

    // Deleted callables: the base revision's declaration, assessed against
    // what the snapshot still holds.
    for (const d of deleted) {
        const outcome = assessRemoval(index, d, judge);
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

    // Affected tests: every changed symbol, by its own declaration (a name
    // alone would pick the tests of every namesake). One row per file; the
    // tests are counted once however many symbols reach them.
    // One operation for the whole selection: every symbol's question reads
    // the same test files, and what one read parsed the next reuses.
    index._beginOp();
    let testFiles;
    let supportFiles;
    let testCount;
    let testsOpen = false;
    let testsConditional;
    let testCommands;
    try {
    const model = createTestModel(index);
    const linesByFile = new Map(); // relative test path -> { row, lines }
    const callerCache = new Map();
    for (const fn of changed) {
        let t = null;
        try {
            t = index.affectedTests(fn.name, {
                depth: 2,
                file: fn.relativePath || fn.file || undefined,
                line: fn.startLine || undefined,
                className: fn.className || undefined,
                _callerCache: callerCache,
                _testModel: model,
                _testSitesOnly: true,
            });
        } catch (e) {
            t = null;
        }
        for (const tf of (t && t.testFiles) || []) {
            let held = linesByFile.get(tf.file);
            if (!held) {
                held = { row: tf, lines: new Map(), linked: new Set() };
                linesByFile.set(tf.file, held);
            }
            for (const name of tf.linkedFunctions || []) held.linked.add(name);
            for (const match of tf.matches || []) {
                if (match.matchType === 'call' || match.matchType === 'test-case') {
                    held.lines.set(testSiteKey(match), match);
                }
            }
        }
    }
    const absoluteTest = new Map();
    for (const [file, entry] of index.files) {
        if (linesByFile.has(entry.relativePath)) absoluteTest.set(entry.relativePath, file);
    }
    // The lines each file's links stand on; a test a class inherits is
    // carried to the file of the class that runs it, which may be a file
    // no link stands in.
    const linesOf = new Map();
    for (const [rel, held] of linesByFile) {
        if (absoluteTest.has(rel)) linesOf.set(absoluteTest.get(rel), [...held.lines.values()]);
    }
    testFiles = [];
    supportFiles = [];
    const countedTests = new Set();
    const conditionalTests = new Set();
    const runnable = [];
    for (const [absFile, linked] of linkFiles(model, index, linesOf)) {
        const rel = index.files.get(absFile).relativePath;
        const held = linesByFile.get(rel);
        const names = new Set(held ? held.linked : []);
        for (const from of linked.from || []) {
            for (const name of (linesByFile.get(from) || { linked: [] }).linked) names.add(name);
        }
        const row = {
            file: rel,
            role: linked.role,
            ...(linked.runner && { runner: linked.runner }),
            linkedFunctions: [...names].sort(),
            testCount: linked.tests,
            ...(linked.moreTests && { moreTests: true }),
            ...(linked.conditionalTests && { conditionalTests: linked.conditionalTests }),
            ...(linked.run && { run: linked.run }),
            ...(linked.runWithheld && { runWithheld: linked.runWithheld }),
        };
        if (linked.role === 'support') {
            supportFiles.push(row);
            continue;
        }
        testFiles.push(row);
        runnable.push(absFile);
        for (const key of linked.testKeys) countedTests.add(key);
        for (const key of linked.conditionalKeys) conditionalTests.add(key);
        if (linked.moreTests) testsOpen = true;
    }
    testFiles.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    supportFiles.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    testCount = countedTests.size;
    testsConditional = conditionalTests.size;
    testCommands = commandsFor(model, runnable.sort());
    } finally { index._endOp(); }

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
        if (it.kind === 'added' && it.verdict === 'blocked') {
            actions.push({
                severity: 'error',
                kind: 'addition_breaks',
                message: `${it.name}: ${(it.sites || []).length} object literal(s) declared as its type do not have it`,
            });
        }
        if (it.kind === 'added') {
            for (const code of it.reasons) {
                if (code === 'literal-lacks-new-member') continue;
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
    if (testCommands.length > 0) {
        // The runner's own commands, where a manifest names the runner.
        const shown = testCommands.slice(0, 3);
        actions.push({
            severity: 'info',
            kind: 'tests_to_run',
            message: `Run tests: ${shown.join(' ; ')}` +
                (testCommands.length > shown.length ? ` (+${testCommands.length - shown.length} more command(s))` : ''),
            commands: testCommands,
        });
    } else {
        // No runner is proven: the files are named, without a command.
        // A file whose own answer says running it would not run its tests
        // (declared inside functions, switched off, left out of the
        // build) is not named.
        const named = testFiles.filter(row => !FILE_WOULD_NOT_RUN.has(row.runWithheld));
        if (named.length > 0) {
            actions.push({
                severity: 'info',
                kind: 'tests_to_run',
                message: `Run tests: ${named.slice(0, 5).map(t => t.file).join(' ')}` +
                    (named.length > 5 ? ` (+${named.length - 5} more)` : ''),
            });
        }
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
        ...(supportFiles.length > 0 && { supportFiles }),
        totalTestFiles: testFiles.length,
        totalTests: testCount,
        // A file among them holds tests that are not listed: the total
        // is a lower bound.
        ...(testsOpen && { moreTests: true }),
        ...(testsConditional > 0 && { conditionalTests: testsConditional }),
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
