/**
 * core/test-name-bindings.js - Test functions bound to a declaration by name
 * (fix #383).
 *
 * Some toolchains bind a test function to a declared identifier through the
 * function's NAME, not through a reference: Go examples
 * `Example<Ident>[_<Member>][_<suffix>]` (the language trait
 * `nameBoundTestFunctions`). go vet's `tests` analyzer, which `go test` runs,
 * rejects an example whose name no longer names a declaration, so a rename of
 * the identifier or member must rename the example with it.
 *
 * Binding follows the checker exactly: the name is split into its parts by
 * the trait's parser, the identifier part is looked up the way vet looks it
 * up (the example's own package scope, then the packages that package
 * imports), and the member part must resolve on that type the way a selector
 * does (own and promoted methods, interface requirements, fields). A name
 * that could resolve to more than one imported package is routed to review,
 * never renamed silently.
 */

'use strict';

const path = require('path');
const { langTraits } = require('../languages');

/** Name-bound test function candidates of one convention, per operation. */
function candidatesFor(index, trait) {
    const memo = index._opMemo?.('nameBoundTestCandidates');
    if (memo?.has(trait.kind)) return memo.get(trait.kind);
    const out = [];
    for (const [name, defs] of index.symbols) {
        if (!name.startsWith(trait.prefix)) continue;
        for (const def of defs) {
            if (def.className || def.type !== 'function' || def.lexicalScopeStartLine) continue;
            const rel = def.relativePath || def.file;
            if (!trait.testFile.test(rel)) continue;
            if (langTraits(index.files.get(def.file)?.language)?.nameBoundTestFunctions !== trait) continue;
            const parsed = trait.parse(name);
            if (parsed) out.push({ def, parsed });
        }
    }
    memo?.set(trait.kind, out);
    return out;
}

// ── Go package scopes (vet lookup semantics) ────────────────────────────

/** The package clause name of a Go file (recorded by the parser). */
function goPackageClause(index, file) {
    return index.files.get(file)?.packageName || null;
}

/** Go files per directory, per operation. */
function goFilesByDir(index) {
    const memo = index._opMemo?.('goFilesByDir', () => ({ map: null }));
    if (memo?.map) return memo.map;
    const map = new Map();
    for (const [file, entry] of index.files) {
        if (entry.language !== 'go') continue;
        const dir = path.dirname(file);
        if (!map.has(dir)) map.set(dir, []);
        map.get(dir).push(file);
    }
    if (memo) memo.map = map;
    return map;
}

/** Files of the Go package `file` belongs to: same directory, same clause. */
function goPackageFiles(index, file) {
    const clause = goPackageClause(index, file);
    const dir = path.dirname(file);
    return (goFilesByDir(index).get(dir) || []).filter(other =>
        goPackageClause(index, other) === clause);
}

function isGoPackageLevel(def) {
    return !def.className && def.type !== 'method' && def.type !== 'field' &&
        !def.lexicalScopeStartLine;
}

/** Directory of the project package a Go import spec resolves to, or null. */
function goImportDir(index, file, spec) {
    const memo = index._opMemo?.('goImportDir');
    const key = `${file}\0${spec}`;
    if (memo?.has(key)) return memo.get(key);
    let dir = null;
    const rel = index.files.get(file)?.moduleResolved?.[spec];
    if (rel) {
        dir = path.dirname(path.isAbsolute(rel) ? rel : path.join(index.root, rel));
    } else {
        try {
            const { resolveImport } = require('./imports');
            const resolved = resolveImport(spec, file, { language: 'go', root: index.root });
            if (resolved) dir = path.dirname(resolved);
        } catch {
            dir = null;
        }
    }
    memo?.set(key, dir);
    return dir;
}

/**
 * What `ident` names in the package of `file`, as go vet looks it up: the
 * package's own declarations, else every imported project package that
 * declares it. Returns { own: defs[] } or { imported: [{ dir, defs }] }.
 */
function goLookupIdent(index, file, ident, testFile) {
    const pkgFiles = goPackageFiles(index, file);
    const pkgSet = new Set(pkgFiles);
    const defs = (index.symbols.get(ident) || []).filter(isGoPackageLevel);
    const own = defs.filter(def => pkgSet.has(def.file));
    if (own.length > 0) return { own };
    const dirs = new Set();
    for (const pkgFile of pkgFiles) {
        for (const binding of index.files.get(pkgFile)?.importBindings || []) {
            if (!binding.module) continue;
            const dir = goImportDir(index, pkgFile, binding.module);
            if (dir) dirs.add(dir);
        }
    }
    const imported = [];
    for (const dir of [...dirs].sort()) {
        // An imported package is its non-test files.
        const found = defs.filter(def => path.dirname(def.file) === dir &&
            !testFile.test(def.relativePath || def.file));
        if (found.length > 0) imported.push({ dir, defs: found });
    }
    return { imported };
}

/**
 * Whether the identifier part of example `example` binds to the package
 * declaration `decl` (a type for member bindings, the renamed declaration
 * otherwise): 'yes', 'no', or 'ambiguous'.
 */
function goIdentBinding(index, example, ident, decl, testFile) {
    const lookup = goLookupIdent(index, example.file, ident, testFile);
    if (lookup.own) {
        return lookup.own.some(def => def === decl ||
            (def.file === decl.file && def.startLine === decl.startLine)) ? 'yes' : 'no';
    }
    const declDir = path.dirname(decl.file);
    const hit = lookup.imported.some(item => item.dir === declDir &&
        item.defs.some(def => def === decl || (def.file === decl.file && def.startLine === decl.startLine)));
    if (!hit) return 'no';
    return lookup.imported.length > 1 ? 'ambiguous' : 'yes';
}

/** Whether a call record outside the function's own body names it. */
function referencedElsewhere(index, fn) {
    const files = index.getCalleeFiles?.(fn.name);
    if (!files || files.size === 0) return false;
    const { getCachedCalls } = require('./callers');
    for (const file of files) {
        for (const call of getCachedCalls(index, file) || []) {
            if (call.name !== fn.name) continue;
            const enclosing = call.enclosingFunction;
            // Records inside the function itself (Go's synthetic closure
            // entry markers carry the enclosing name) are not references.
            if (file === fn.file && enclosing?.startLine === fn.startLine) continue;
            return true;
        }
    }
    return false;
}

function sameDef(a, b) {
    return a === b || (a.file === b.file && a.startLine === b.startLine && a.name === b.name);
}

/**
 * Examples (and other name-bound test functions) a rename must carry along.
 * @param {object} index
 * @param {object[]} renamedDefs - declarations the plan renames
 * @param {string} oldName
 * @param {string} newName
 * @returns {Array<{ def, newName, status: 'edit'|'review', reason?, binding }>}
 */
function nameBoundTestFunctions(index, renamedDefs, oldName, newName) {
    const out = [];
    const byTrait = new Map();
    for (const def of renamedDefs) {
        const trait = langTraits(index.files.get(def.file)?.language)?.nameBoundTestFunctions;
        if (!trait) continue;
        if (!byTrait.has(trait)) byTrait.set(trait, []);
        byTrait.get(trait).push(def);
    }
    for (const [trait, defs] of byTrait) {
        if (trait.kind !== 'go-example') continue;
        const candidates = candidatesFor(index, trait).filter(({ parsed }) =>
            parsed.ident === oldName || parsed.member === oldName);
        if (candidates.length === 0) continue;
        // Bindings the renamed declarations own: the identifier itself for a
        // package-level declaration, `Type_<member>` for every type whose
        // selector reaches a renamed member.
        const identDecls = defs.filter(isGoPackageLevel);
        const memberTypes = [];
        if (defs.some(def => def.className)) {
            const { goMemberProviders } = require('./contract-membership');
            for (const provider of goMemberProviders(index, oldName)) {
                if (!provider.defs.some(member => defs.some(def => sameDef(def, member)))) continue;
                const typeDecl = (index.symbols.get(provider.typeName) || []).find(def =>
                    isGoPackageLevel(def) && path.dirname(def.file) === provider.dir &&
                    !trait.testFile.test(def.relativePath || def.file)) ||
                    (index.symbols.get(provider.typeName) || []).find(def =>
                        isGoPackageLevel(def) && path.dirname(def.file) === provider.dir);
                if (typeDecl) memberTypes.push({ typeName: provider.typeName, decl: typeDecl });
            }
        }
        for (const { def: example, parsed } of candidates) {
            let identVerdict = 'no';
            let memberVerdict = 'no';
            if (parsed.ident === oldName) {
                for (const decl of identDecls) {
                    const verdict = goIdentBinding(index, example, oldName, decl, trait.testFile);
                    if (verdict === 'yes') { identVerdict = 'yes'; break; }
                    if (verdict === 'ambiguous') identVerdict = 'ambiguous';
                }
            }
            if (parsed.member === oldName) {
                for (const { typeName, decl } of memberTypes) {
                    if (parsed.ident !== typeName) continue;
                    const verdict = goIdentBinding(index, example, typeName, decl, trait.testFile);
                    if (verdict === 'yes') { memberVerdict = 'yes'; break; }
                    if (verdict === 'ambiguous') memberVerdict = 'ambiguous';
                }
            }
            if (identVerdict === 'no' && memberVerdict === 'no') continue;
            const renamed = parsed.rename({
                ...(identVerdict === 'yes' && { ident: newName }),
                ...(memberVerdict === 'yes' && { member: newName }),
            });
            const binding = memberVerdict !== 'no' ? 'member' : 'identifier';
            if (identVerdict === 'ambiguous' || memberVerdict === 'ambiguous') {
                out.push({ def: example, newName: renamed, status: 'review', reason: 'example-binding-ambiguous', binding });
            } else if (referencedElsewhere(index, example)) {
                // The example is also referenced as a function: its other
                // references are not part of this rename.
                out.push({ def: example, newName: renamed, status: 'review', reason: 'example-referenced', binding });
            } else {
                out.push({ def: example, newName: renamed, status: 'edit', binding });
            }
        }
    }
    return out.sort((a, b) => {
        const fa = a.def.relativePath || a.def.file;
        const fb = b.def.relativePath || b.def.file;
        return fa < fb ? -1 : fa > fb ? 1 : a.def.startLine - b.def.startLine;
    });
}

module.exports = {
    nameBoundTestFunctions,
    goPackageClause,
};
