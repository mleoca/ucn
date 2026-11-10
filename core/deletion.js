/**
 * core/deletion.js - Can this declaration be deleted?
 *
 * One eligibility rule answers that for every surface: the dead-code
 * pipeline (core/deadcode.js). The audit runs it over every name; an
 * assessment runs the SAME code over one name and reads why a declaration
 * was or was not claimed. A declaration the audit lists is exactly a
 * declaration this module answers `no-static-dependents`.
 *
 * The answer is a statement of static evidence with its basis, never a
 * promise that deletion is safe:
 *
 *   no-static-dependents   the name has no use in project source outside its
 *                          own declarations, and no shield applies: nothing
 *                          the engine can see depends on it;
 *   has-static-dependents  a call or other use of the name exists OUTSIDE
 *                          the declaration. The first such site is given.
 *                          Evidence is by name, as in the audit: with two
 *                          declarations of one name it does not say which
 *                          of them the use reaches;
 *   review                 no use outside the declaration was found, but a
 *                          zero is not evidence here: a shield applies
 *                          (consumers outside the repository, a contract, a
 *                          registration, reflection, source that could not
 *                          be searched) or the name is used inside the
 *                          declaration itself. The reason is named.
 *
 * A use inside the declaration is deleted with it and is never a dependent:
 * `fn len(&self) { self.inner.len() }` and an override that calls `super()`
 * do not depend on themselves.
 *
 * Two things that look alike are kept apart:
 *
 *   downstream exposure  POLICY. An exported symbol may have consumers
 *                        outside the repository. It blocks a claim in a
 *                        library and not in a project its `.ucn.json`
 *                        declares an application (or under
 *                        --include-exported).
 *   external contract    FACT about the declaration: it overrides or
 *                        implements something defined outside the project,
 *                        is registered, reflected or dispatched by name. It
 *                        holds for unexported symbols and in applications.
 */

'use strict';

const path = require('path');

/** The kind a project declares for itself. Only `application` changes
 *  anything; everything else (absent, unknown) is a library. */
function projectKind(index) {
    return index && index.config && index.config.kind === 'application'
        ? 'application' : 'library';
}

/**
 * Does the possibility of consumers outside the repository keep this
 * exported symbol out of a deletion claim? `isExported` is the fact, read
 * from the declaration; this is the policy over it.
 */
function downstreamExposureBlocks(index, isExported, options = {}) {
    return !!isExported && !options.includeExported && projectKind(index) === 'library';
}

/** A use of the name exists: the declaration has dependents. */
const DEPENDENT_REASONS = new Set(['has-callers', 'has-usages', 'member-in-use']);

/** Why the pipeline did or did not claim a declaration, in one sentence. */
const REASON_TEXT = Object.freeze({
    'claimed': 'the name has no use in project source outside its own declarations, and no shield applies',
    'has-callers': 'a call of this name exists outside the declaration',
    'has-usages': 'the name is used outside the declaration',
    'member-in-use': 'a member of this type is called outside the declaration',
    'used-only-within-itself': 'every use found is inside the declaration itself, and the audit does not clear a name that is in use',
    'downstream-exposure': 'exported from a library: consumers outside the repository may use it',
    'external-contract': 'implements or overrides something defined outside the project',
    'required-slot': 'required by a contract of the project: removing it breaks the type that implements it',
    'runtime-contract': 'invoked by the language runtime, the compiler or an assignment, not by name',
    'registered': 'decorated or registered with a framework, which may invoke it without naming it',
    'entry-point': 'an entry point the runtime or a test runner invokes',
    'constructor': 'a constructor: part of its type\'s allocation protocol, assessed with the type',
    'reflection': 'reflection in the project can reach this name',
    'dynamic-dispatch': 'member of a registry that is called through a computed key',
    'macro-reference': 'a macro expansion names it',
    'unanalyzed-occurrence': 'the name occurs in source that is searched as text and not analyzed',
    'unsearchable-source': 'part of the project could not be searched, so no name can be cleared',
    'test-file': 'declared in a test file, which the audit does not cover by default',
    'out-of-scope': 'outside the requested file scope',
    'kind-not-audited': 'this kind of declaration is not audited for deletion',
    'expression-scoped-name': 'a named function expression: its position invokes it, not its name',
    'macro-generated': 'generated by a macro invocation, not a declaration of its own',
    'bundled-file': 'declared in a bundled file',
    'operator-surface': 'invoked by operator or indexer syntax that never contains its name',
    'ambient-declaration': 'an ambient declaration that describes code outside the project',
    'declaration-not-found': 'no declaration matches this handle',
});

function verdictOf(reason) {
    if (reason === 'claimed') return 'no-static-dependents';
    if (DEPENDENT_REASONS.has(reason)) return 'has-static-dependents';
    return 'review';
}

function sameDeclaration(symbol, declaration) {
    return symbol.name === declaration.name &&
        symbol.file === declaration.file &&
        symbol.startLine === declaration.startLine;
}

function relativeOf(index, file) {
    return path.relative(index.root, file).split(path.sep).join('/');
}

/** Code-unit order, never locale order: the first site must not depend on
 *  the machine that prints it. */
function compareSites(a, b) {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return (a.line || 0) - (b.line || 0);
}

/** Is this site inside the declaration, and so deleted with it? Only a
 *  declaration the index holds has lines in the current text. */
function withinDeclaration(declaration, indexed, file, line) {
    if (!indexed || file !== declaration.file) return false;
    const end = declaration.endLine != null ? declaration.endLine : declaration.startLine;
    return line >= declaration.startLine && line <= end;
}

/**
 * The first call of any of `names` outside the declaration, in
 * (path, line) order, or null. A file whose call records cannot be read
 * counts as a site with no line: an unknown is never read as "inside".
 */
function callSiteOutside(index, declaration, indexed, names) {
    if (!index.calleeIndex) return null;
    const { getCachedCalls } = require('./callers');
    const files = new Map(); // relative path -> absolute path
    for (const name of names) {
        for (const file of index.calleeIndex.get(name) || []) files.set(relativeOf(index, file), file);
    }
    const wanted = new Set(names);
    for (const relativePath of [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
        const file = files.get(relativePath);
        const calls = getCachedCalls(index, file);
        if (!calls) return { file: relativePath };
        let line = null;
        for (const call of calls) {
            if (!wanted.has(call.name) && !wanted.has(call.resolvedName) &&
                !(call.resolvedNames && call.resolvedNames.some(name => wanted.has(name)))) continue;
            if (withinDeclaration(declaration, indexed, file, call.line)) continue;
            if (line === null || call.line < line) line = call.line;
        }
        if (line !== null) return { file: relativePath, line };
    }
    return null;
}

/**
 * The first use of the name outside the declaration, with the pipeline's
 * reason for it, or null.
 *
 * The pipeline stops at the first thing that keeps a declaration out of the
 * audit, which is right for an audit and wrong for a verdict in two ways.
 * A shield hides what lies behind it: an exported symbol is never scanned
 * for uses in a library, and "consumers outside may use it" must not hide
 * that code inside the repository does. And a call of the name anywhere
 * ends the chain, including a call inside the declaration itself.
 *
 * So calls are read from the callee index directly, and other uses come
 * from one more pass with every shield a flag can lift lifted. When no call
 * lies outside the declaration, that pass sends the name through the text
 * scan under the pipeline's recursion carve-out, so the pipeline's own
 * usage rule still decides what a use is.
 */
function useOutsideDeclaration(index, declaration, indexed, deadcode, options) {
    const name = declaration.name;
    const call = callSiteOutside(index, declaration, indexed, [name]);
    if (call) return { reason: 'has-callers', site: call };
    let found = null;
    deadcode(index, {
        names: new Set([name]),
        includeExported: true,
        includeDecorated: true,
        includeTests: true,
        ownBodyOnly: new Set([name]),
        ...(!indexed && {
            declarations: [{ symbol: declaration, fileEntry: options.fileEntry || null }],
        }),
        explain: (symbol, reason, detail) => {
            if (!sameDeclaration(symbol, declaration)) return;
            if (reason === 'member-in-use') {
                const site = callSiteOutside(index, declaration, indexed, (detail && detail.members) || []);
                if (site) found = { reason, site };
            } else if (reason === 'has-usages') {
                const sites = ((detail && detail.usages) || [])
                    .filter(usage => !withinDeclaration(declaration, indexed, usage.file, usage.line))
                    .map(usage => ({ file: relativeOf(index, usage.file), line: usage.line }))
                    .sort(compareSites);
                if (sites.length > 0) found = { reason, site: sites[0] };
            }
        },
    });
    return found;
}

/**
 * Assess one declaration for deletion.
 *
 * @param {object} index - ProjectIndex of the snapshot the declaration's
 *   USES are looked for in
 * @param {object} declaration - a symbol record: { name, file (absolute),
 *   startLine, ... }. One the index holds is assessed in place. One it does
 *   not hold (deleted since, or taken from a base revision) is assessed
 *   from the record itself; pass `fileEntry` with the file facts of the
 *   revision it was declared in when they differ from the index's.
 * @param {object} [options] - { includeExported, includeDecorated,
 *   includeTests, fileEntry }
 */
function assessDeletion(index, declaration, options = {}) {
    const { deadcode } = require('./deadcode');
    const indexed = (index.symbols.get(declaration.name) || [])
        .some(symbol => sameDeclaration(symbol, declaration));
    const outcomes = [];
    const audit = deadcode(index, {
        names: new Set([declaration.name]),
        includeExported: !!options.includeExported,
        includeDecorated: !!options.includeDecorated,
        includeTests: !!options.includeTests,
        ...(!indexed && {
            declarations: [{ symbol: declaration, fileEntry: options.fileEntry || null }],
        }),
        explain: (symbol, reason, row) => outcomes.push({ symbol, reason, row }),
    });
    const outcome = outcomes.find(entry => sameDeclaration(entry.symbol, declaration));
    let reason = outcome ? outcome.reason : 'declaration-not-found';
    // --include-exported LISTS a declaration bound to an external contract,
    // tagged, for review. Listed is not cleared: the contract is a fact
    // about the declaration and no flag removes it.
    if (reason === 'claimed' && outcome.row && outcome.row.externalContract) {
        reason = 'external-contract';
    }
    // A use outside the declaration outranks everything but a claim. A
    // dependent reason with no such use is no dependent: the name is used
    // only inside what would be deleted.
    let site = null;
    if (outcome && reason !== 'claimed') {
        const use = useOutsideDeclaration(index, declaration, indexed, deadcode, options);
        if (use) {
            reason = use.reason;
            site = use.site;
        } else if (DEPENDENT_REASONS.has(reason)) {
            reason = 'used-only-within-itself';
        }
    }
    const relativePath = declaration.relativePath ||
        path.relative(index.root, declaration.file).split(path.sep).join('/');
    return {
        declaration: {
            name: declaration.name,
            file: relativePath,
            startLine: declaration.startLine,
            ...(declaration.endLine != null && { endLine: declaration.endLine }),
            ...(declaration.type && { type: declaration.type }),
            ...(declaration.className && { className: declaration.className }),
        },
        verdict: verdictOf(reason),
        reason,
        basis: REASON_TEXT[reason] || reason,
        ...(site && { site }),
        projectKind: projectKind(index),
        indexed,
        coverage: {
            complete: audit.coverage.complete,
            claimsWithdrawn: audit.coverage.claimsWithdrawn,
        },
        // Static evidence only. Aliases, reflection the engine does not
        // model, generated code and consumers outside the repository are
        // beyond it: the toolchain and the tests decide.
        safeToDelete: false,
        semanticComplete: false,
        requiresCompilerAndTests: true,
    };
}

module.exports = {
    projectKind,
    downstreamExposureBlocks,
    assessDeletion,
    verdictOf,
    REASON_TEXT,
    DEPENDENT_REASONS,
};
