'use strict';

/**
 * core/out-of-class-members.js - constructors defined outside their class
 * body (fix #421): the C++ header + source layout, where `W::W(int)` in
 * w.cpp defines the `W(int)` its class declares in w.h (trait
 * `outOfClassMemberDefinitions`).
 *
 * The constructor family of a class is its in-class declarations; an
 * out-of-class definition holds the body of exactly one of them. Linkage is
 * by the owner's scope path, textual visibility of the class (same file or
 * include closure) and the declaration's parameter signature. Anything less
 * certain links nothing: the caller keeps its review result.
 */

const { langTraits } = require('../languages');

const OWNER_KINDS = new Set(['class', 'struct', 'union']);

const scopePath = def => [def.namespace, def.enclosingType].filter(Boolean).join('::');

const outOfClassLanguage = (index, file) => !!langTraits(index.files.get(file)?.language)?.outOfClassMemberDefinitions;
const applies = (index, def) => !!def?.className && outOfClassLanguage(index, def.file);

function memo(index, name) {
    return index.isProvenanceFactIndex ? null : index._opMemo?.(name, () => new WeakMap());
}

/** A definition outside every class body (its symbol's span lies in no owner). */
function isOutOfClass(index, def) {
    const { ownerDefinitionOf } = require('./class-identity');
    return !def.isSignature && !ownerDefinitionOf(index, def);
}

/**
 * The class an out-of-class constructor definition belongs to: the one
 * class of its name whose scope path equals the definition's qualifier and
 * that the definition's file sees. Null when none or several qualify.
 */
function definitionOwner(index, def) {
    if (!applies(index, def) || !isOutOfClass(index, def)) return null;
    const saved = memo(index, 'outOfClassOwner');
    if (saved?.has(def)) return saved.get(def);
    const visible = require('./cpp-scope').includeClosure(index, def.file);
    const path = scopePath(def);
    const owners = (index.symbols.get(def.className) || []).filter(owner => OWNER_KINDS.has(owner.type) &&
        !owner.forwardDeclaration && scopePath(owner) === path && visible.has(owner.file));
    const owner = owners.length === 1 ? owners[0] : null;
    saved?.set(def, owner);
    return owner;
}

/** The in-class constructor declaration an out-of-class definition defines. */
function declarationOf(index, def) {
    const owner = definitionOwner(index, def);
    if (!owner) return null;
    const { ownConstructors } = require('./constructor-calls');
    const { _cFamilySignatureKey } = require('./callers');
    const key = _cFamilySignatureKey(def);
    const declared = ownConstructors(index, owner).filter(member => member.isSignature &&
        _cFamilySignatureKey(member) === key);
    return declared.length === 1 ? declared[0] : null;
}

/**
 * The definition holding the body of an in-class constructor declaration:
 * the declaration itself when it has a body, else its one linked
 * out-of-class definition (null when there is none or several).
 */
function bodyDefinitionOf(index, declaration) {
    if (!declaration?.isSignature || !applies(index, declaration)) return declaration;
    const saved = memo(index, 'outOfClassBody');
    if (saved?.has(declaration)) return saved.get(declaration);
    const definitions = (index.symbols.get(declaration.name) || []).filter(def => def !== declaration &&
        def.type === declaration.type && def.className === declaration.className && !def.isSignature &&
        declarationOf(index, def) === declaration);
    const body = definitions.length === 1 ? definitions[0] : null;
    saved?.set(declaration, body);
    return body;
}

/** The out-of-class constructor definition enclosing a call record of `file`. */
function enclosingDefinition(index, file, call, owner) {
    const enclosing = call.enclosingFunction;
    if (!enclosing || !outOfClassLanguage(index, file)) return null;
    const matches = (index.files.get(file)?.symbols || []).filter(def => def.name === owner.name &&
        def.className === owner.name && !def.isSignature && def.startLine === enclosing.startLine &&
        def.endLine === enclosing.endLine && require('./constructor-calls').isConstructor(def, index));
    return matches.length === 1 && definitionOwner(index, matches[0]) === owner ? matches[0] : null;
}

/**
 * Does a mem-initializer of an out-of-class constructor definition
 * (parser `memberInitializer`) initialize a data member rather than
 * construct a base (fix #421)? A name that is no project type, or a field
 * of the definition's class, is a member; the record is then no call.
 */
function initializesMember(index, file, call, namesType) {
    if (!call.memberInitializer) return false;
    if (!namesType(call.name)) return true;
    const enclosing = call.enclosingFunction;
    if (!enclosing) return false;
    const { isConstructor } = require('./constructor-calls');
    const definitions = (index.files.get(file)?.symbols || []).filter(def => !def.isSignature &&
        def.startLine === enclosing.startLine && def.endLine === enclosing.endLine && isConstructor(def, index));
    const owner = definitions.length === 1 ? definitionOwner(index, definitions[0]) : null;
    return !!owner && (index.symbols.get(call.name) || []).some(def => def.className === owner.name &&
        def.file === owner.file && def.startLine >= owner.startLine && def.endLine <= owner.endLine &&
        (def.type === 'field' || def.memberType === 'field'));
}

/**
 * The project bases an out-of-class constructor definition leaves to
 * implicit construction (fix #421): its class's written bases that none of
 * its mem-initializers names, none when it delegates. `isProjectType(name)`
 * keeps the bases the project declares.
 */
function omittedBases(index, def, isProjectType) {
    const owner = definitionOwner(index, def);
    if (!owner?.extends) return [];
    const { getCachedCalls } = require('./callers');
    const { splitParentList } = require('./graph-build');
    const initializers = (getCachedCalls(index, def.file) || []).filter(call => call.constructorSyntax === 'delegation' &&
        call.line >= def.startLine && call.line <= def.endLine &&
        call.enclosingFunction?.startLine === def.startLine && call.enclosingFunction?.endLine === def.endLine);
    if (initializers.some(call => call.ctorDelegation === 'this')) return [];
    const initialized = new Set(initializers.map(call => call.name));
    return splitParentList(owner.extends).map(spelling => {
        const parts = String(spelling).replace(/<.*$/s, '').trim().split('::');
        const name = parts.pop().trim();
        return { name, qualifier: parts.join('::') || null };
    }).filter(base => base.name && !initialized.has(base.name) && isProjectType(base.name));
}

/**
 * Call records for the omitted base initializers of an out-of-class
 * constructor definition (fix #421): the base's default constructor runs
 * there, read from the class declaration in another place, so the site is
 * a visible unverified candidate (`implicitOutOfClass`), never a confirmed
 * edge.
 */
function implicitBaseRecords(index, def, isProjectType) {
    if (!applies(index, def) || def.isSignature || !require('./constructor-calls').isConstructor(def, index)) return [];
    const saved = memo(index, 'outOfClassImplicitBases');
    if (saved?.has(def)) return saved.get(def);
    const records = omittedBases(index, def, isProjectType).map(base => ({
        name: base.name, line: def.startLine, isMethod: false, isConstructor: true,
        constructorSyntax: 'implicit', argCount: 0, argKinds: [],
        ...(base.qualifier && { constructorQualifier: base.qualifier }),
        implicitOutOfClass: { owner: def.className },
        enclosingFunction: { name: def.name, startLine: def.startLine, endLine: def.endLine, className: def.className },
    }));
    saved?.set(def, records);
    return records;
}

/**
 * The out-of-class constructor definitions of classes derived from `base`
 * that construct it implicitly (fix #421), as unverified caller rows.
 */
function implicitBaseCallerRows(index, base, isProjectType) {
    if (!outOfClassLanguage(index, base.file)) return [];
    const rows = [];
    const derived = new Set((index.extendedByGraph?.get(base.name) || [])
        .map(child => typeof child === 'string' ? child : child.name));
    for (const name of [...derived].sort()) {
        for (const def of index.symbols.get(name) || []) {
            if (def.className !== name || def.isSignature || !require('./constructor-calls').isConstructor(def, index)) continue;
            const owner = definitionOwner(index, def);
            if (!owner || !implicitBaseRecords(index, def, isProjectType).some(record => record.name === base.name)) continue;
            // The derived class's written base must be this class.
            const { resolveClassRef } = require('./class-identity');
            const ref = resolveClassRef(index, base.name, owner.file);
            if (ref?.def && ref.def !== base) continue;
            rows.push(def);
        }
    }
    return rows;
}

module.exports = { definitionOwner, declarationOf, bodyDefinitionOf, enclosingDefinition, initializesMember,
    implicitBaseRecords, implicitBaseCallerRows };
