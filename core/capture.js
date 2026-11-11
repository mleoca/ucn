/**
 * core/capture.js - Can an ADDED declaration change what existing code means?
 *
 * Adding code is inert when nothing that existed before can reach it. Two
 * questions decide that:
 *
 *   novelty   does the name occur anywhere outside the lines the diff
 *             added? A name with no earlier occurrence cannot have been
 *             called, imported, shadowed or looked up before, so nothing
 *             that existed binds to the new declaration.
 *   capture   even under a new name, a member added to a type that already
 *             existed can take part in something existing code relies on:
 *             it can override or be overridden, become a requirement every
 *             implementer must now supply, change how the type is
 *             constructed or laid out, be called by the runtime or a
 *             framework without being named.
 *
 * Each hazard is named. None of them is a proven break: they are the
 * reasons an addition is review and not ready.
 */

'use strict';

const { hierarchySlotClosure } = require('./contract-membership');
const { NON_CALLABLE_TYPES, isValueDefinition } = require('./shared');
const { langTraits } = require('../languages');

const HAZARD_TEXT = Object.freeze({
    'name-in-use': 'the name already occurs outside this change: existing code may now bind to the new declaration',
    'novelty-unknown': 'part of the project could not be searched for the name, so it cannot be shown to be new',
    'new-requirement': 'a new requirement of an existing contract: every implementer must now supply it',
    'overrides-inherited': 'overrides a member the type inherited: existing calls on this type now reach it',
    'overridden-by-descendant': 'a descendant already declares this member: it now overrides the new one',
    'constructor-of-existing-type': 'changes how an existing type is constructed',
    'field-of-existing-type': 'a new member of an existing type: construction, positional initialisation and layout can depend on its members',
    'shape-of-existing-type': 'a new member of a type that is compared by shape: values used as that type, or as its constructor, are held to it',
    'literal-lacks-new-member': 'an object literal declared as this type does not have the new member',
    'protocol-member': 'a member the language runtime or the compiler invokes by name',
    'registered': 'decorated or registered with a framework, which may invoke it without naming it',
    'overrides-external': 'implements or overrides something defined outside the project',
    'reflection-reachable': 'reflection in the project can reach this name',
    'registry-member': 'member of a registry that is called through a computed key',
});

// Name-level reasons a deletion assessment withholds a claim, read as a
// property of an addition: what can reach a name can reach a new one.
const HAZARD_OF_SHIELD = Object.freeze({
    'reflection': 'reflection-reachable',
    'dynamic-dispatch': 'registry-member',
});

/**
 * Where an occurrence of a new declaration's name could mean it.
 *
 *   a function-local declaration   the lines of its enclosing scope;
 *   a module-level declaration of  its own file, the files that import the
 *   a module (a file with its own  name from it, and the files that take
 *   scope)                         everything the module has (a namespace
 *                                  or module import, a star import);
 *   anything else (a member, a     the whole project: a receiver, a
 *   name in a shared scope)        package, an inclusion can reach it
 *                                  from anywhere.
 *
 * Returns a predicate over (relative path, line), or null for "anywhere".
 * An occurrence elsewhere is another name that happens to be spelled the
 * same: it could not have meant this declaration before, and cannot now.
 */
function reachOf(index, definition) {
    if (!definition || definition.className) return null;
    const entry = index.files.get(definition.file);
    if (!entry) return null;
    const own = entry.relativePath;
    if (definition.lexicalScopeStartLine != null) {
        return (file, line) => file === own &&
            line >= definition.lexicalScopeStartLine && line <= definition.lexicalScopeEndLine;
    }
    const traits = langTraits(entry.language) || {};
    if (traits.packageScope !== 'file' || traits.textualIncludes) return null;
    // A script without module syntax shares one global scope with the
    // others (trait `scriptGlobalScope`).
    if (traits.scriptGlobalScope && (entry.imports || []).length === 0 && (entry.exports || []).length === 0) return null;
    const files = new Set([own]);
    const exported = new Set(entry.exports || []);
    if (traits.moduleNamesImportable) {
        for (const symbol of entry.symbols || []) if (!symbol.className) exported.add(symbol.name);
    }
    // A name the module does not export stays in the module.
    if (!exported.has(definition.name)) return file => file === own;
    for (const other of index.files.values()) {
        const resolved = other.moduleResolved || {};
        const takesAll = (other.importDetails || []).some(detail =>
            resolved[detail.module] === own && (detail.names || []).includes('*'));
        const reExportsAll = (other.exportDetails || []).some(detail =>
            detail && (detail.name === '*' || detail.type === 're-export-all') && resolved[detail.source] === own);
        // Everything the module exports is passed on: who receives the
        // name is no longer written here.
        if (reExportsAll) return null;
        // A binding of one of the module's exports takes that name only.
        // Any other binding of the module holds the module itself.
        const binds = (other.importBindings || []).some(binding => resolved[binding.module] === own &&
            (binding.name === definition.name || !exported.has(binding.name) ||
                binding.kind === 'namespace' || binding.kind === 'default'));
        if (takesAll || binds) files.add(other.relativePath);
    }
    return file => files.has(file);
}

/**
 * Occurrences, in code, of a new declaration's name outside the lines the
 * diff added, among the places where the name could mean the declaration.
 *
 * @param {object} index
 * @param {string} name
 * @param {Map<string, Set<number>>} addedLinesByFile - relative path -> lines
 * @param {object} [definition] - the new declaration (its reach narrows
 *   the search; without it every occurrence counts)
 * @returns {{outside: {file, line}[], total: number}}
 */
function occurrencesOutsideChange(index, name, addedLinesByFile, definition = null) {
    const rows = index.usages(name, { includeTests: true, codeOnly: true }) || [];
    const reaches = reachOf(index, definition);
    const outside = [];
    for (const row of rows) {
        const file = row.relativePath || row.file;
        if (addedLinesByFile.get(file)?.has(row.line)) continue;
        if (reaches && !reaches(file, row.line)) continue;
        outside.push({ file, line: row.line });
    }
    outside.sort((a, b) => (a.file === b.file ? a.line - b.line : (a.file < b.file ? -1 : 1)));
    return { outside, total: rows.length };
}

function bareTypeName(spelled) {
    return String(spelled || '').trim().replace(/[<[(].*$/s, '').split('.').pop().trim();
}

/** The type definitions that own a member: same file, containing it. */
function ownersOf(index, definition) {
    return (index.symbols.get(definition.className) || []).filter(type =>
        type.file === definition.file && !type.className &&
        type.startLine <= definition.startLine && (type.endLine || type.startLine) >= definition.startLine);
}

/** One syntax tree per file for the questions below. */
function treeReader(index) {
    const { parseRevision } = require('./change-kinds');
    const roots = new Map();
    return file => {
        if (!roots.has(file)) {
            let root;
            try { root = parseRevision(index._readFile(file), index.files.get(file)?.language); } catch (_) { root = null; }
            roots.set(file, root);
        }
        return roots.get(file);
    };
}

/**
 * What a new member does to the SHAPE of the type that owns it: the member
 * set existing code is held to, whether or not it names the member.
 *
 *   'required'  every value used as the type must now have the member: an
 *               instance member of a class the language compares by shape
 *               (trait `classComparedByShape`);
 *   'shape'     the type is something else to existing code, with no
 *               member a value must have: a static member of such a class
 *               (the constructor is compared by shape too), a virtual
 *               member where that changes what the type is (trait
 *               `virtualMemberChangesShape`), a member whose role cannot
 *               be read;
 *   null        nothing: the class is compared by declaration, or the
 *               member is optional.
 *
 * "Compared by shape" is asked of the class AS IT WAS: members on lines
 * the change added are left out (the first private member of a class is
 * what makes every structural value of it stop being one). It is asked of
 * the class's own syntax and of every project class it extends: one
 * nominal ancestor makes the class nominal; a base that is not a project
 * class is unknown, and unknown is "by shape".
 *
 * @param {Map<string, Set<number>>} [addedLinesByFile] by relative path
 */
function shapeChangeOf(index, definition, addedLinesByFile = null) {
    const entry = index.files.get(definition.file);
    const traits = langTraits(entry && entry.language) || {};
    if (traits.virtualMemberChangesShape && (definition.modifiers || []).includes('virtual')) return 'shape';
    if (typeof traits.classComparedByShape !== 'function') return null;
    const rootOf = treeReader(index);
    const addedIn = type => (addedLinesByFile && addedLinesByFile.get(type.relativePath)) || null;
    const byShape = (type, seen) => {
        if (seen.has(type)) return false;
        seen.add(type);
        if (type.type !== 'class') return false; // an interface member is a requirement, asked about elsewhere
        const root = rootOf(type.file);
        const node = root && classNodeAt(root, type);
        if (!node) return true;
        if (!traits.classComparedByShape(node, addedIn(type))) return false;
        const parents = [].concat(type.extends || []).flatMap(spelled => String(spelled).split(','))
            .map(bareTypeName).filter(Boolean);
        for (const parent of parents) {
            const bases = (index.symbols.get(parent) || []).filter(candidate => candidate.type === 'class');
            if (bases.length === 0) continue; // out of the project: unknown, stays by shape
            if (bases.every(base => !byShape(base, seen))) return false;
        }
        return true;
    };
    let change = null;
    for (const owner of ownersOf(index, definition)) {
        if (!byShape(owner, new Set())) continue;
        const root = rootOf(owner.file);
        const node = root && classNodeAt(root, owner);
        const role = node && typeof traits.classMemberRole === 'function'
            ? traits.classMemberRole(node, definition.name, definition.startLine) : null;
        if (role === 'instance') return 'required';
        if (role !== 'optional') change = 'shape';
    }
    return change;
}

/** The class declaration node a type definition names. */
function classNodeAt(root, type) {
    let found = null;
    const visit = node => {
        const start = node.startPosition.row + 1;
        const end = node.endPosition.row + 1;
        if (end < type.startLine || start > (type.endLine || type.startLine)) return;
        if (node.childForFieldName('body') && node.childForFieldName('name')?.text === type.name &&
            /class/.test(node.type)) {
            if (!found || node.startIndex < found.startIndex) found = node;
            return;
        }
        for (const child of node.namedChildren) visit(child);
    };
    visit(root);
    return found;
}

/**
 * Object literals declared as the type that owns `definition` and that do
 * not have a member of its name: `const box: Box = { size: () => 1 }` once
 * `Box` gains `brandNew()`. Only what can be read is reported: the
 * declared type resolves to this very type, the literal is the declared
 * value itself, and its members are all written as keys (trait
 * `typedLiteralMembers`: a spread, a computed key, an assertion or a call
 * around the literal leave it out). Sorted (file, line) of the literal.
 */
function literalsLackingMember(index, definition) {
    const owners = ownersOf(index, definition);
    if (owners.length === 0) return [];
    const rootOf = treeReader(index);
    const lacking = new Map(); // file\0line -> site
    for (const entry of index.files.values()) {
        const members = langTraits(entry.language)?.typedLiteralMembers;
        if (typeof members !== 'function') continue;
        for (const symbol of entry.symbols || []) {
            if (!symbol.registryContainerType || symbol.className) continue;
            // The annotation is the type's own name (type arguments
            // aside): a qualified name, a union or an array is another type.
            if (String(symbol.registryContainerType).trim().replace(/<.*$/s, '').trim() !== definition.className) continue;
            const line = symbol.objectLiteralLine || symbol.startLine;
            const key = `${entry.relativePath}\0${line}`;
            if (lacking.has(key)) continue;
            lacking.set(key, null);
            // The name the literal is declared as must be this type.
            const declaredIn = index._resolveClassFile ? index._resolveClassFile(definition.className, symbol.file) : null;
            if (declaredIn !== definition.file) continue;
            const root = rootOf(symbol.file);
            const literal = root ? members(root, line) : null;
            if (!literal || literal.open || literal.names.has(definition.name)) continue;
            lacking.set(key, { file: entry.relativePath, line, kind: 'literal' });
        }
    }
    return [...lacking.values()].filter(Boolean)
        .sort((a, b) => (a.file === b.file ? a.line - b.line : (a.file < b.file ? -1 : 1)));
}

/**
 * Hazards of adding `definition`, a declaration the index now holds.
 *
 * @param {object} index
 * @param {object} definition - the indexed symbol record
 * @param {object} facts - { ownerExisted: the owner type predates the change,
 *   contract: what holds the declaration in place whatever names it
 *   (core/deadcode.js contractFactsOf), shield: the reason a deletion
 *   assessment of it names, or null, shape: what the member does to its
 *   type's shape (shapeChangeOf) }
 * @returns {string[]} hazard codes, in a fixed order
 */
function captureHazards(index, definition, facts = {}) {
    const hazards = [];
    if (definition.className && facts.ownerExisted) {
        const type = definition.type || definition.memberType;
        if (definition.requiredMember) hazards.push('new-requirement');
        if (definition.isConstructor || type === 'constructor') hazards.push('constructor-of-existing-type');
        // A value member (a field, a constant, an enum variant) is part of
        // what the type IS, whichever list the diff reported it in.
        else if (facts.nonCallable || isValueDefinition(definition) ||
            (NON_CALLABLE_TYPES.has(type) && !definition.isMethod)) hazards.push('field-of-existing-type');
        else if (!definition.requiredMember && facts.shape) hazards.push('shape-of-existing-type');
        let closure;
        try { closure = hierarchySlotClosure(index, definition); } catch (_) { closure = null; }
        if (closure) {
            if ((closure.ancestors || []).some(ancestor => (ancestor.members || []).length > 0)) {
                hazards.push('overrides-inherited');
            }
            if ((closure.descendants || []).some(descendant => (descendant.members || []).length > 0)) {
                hazards.push('overridden-by-descendant');
            }
        }
    }
    const contract = facts.contract || {};
    if (contract.runtimeContract) hazards.push('protocol-member');
    if (contract.registered) hazards.push('registered');
    if (contract.externalContract) hazards.push('overrides-external');
    const fromShield = HAZARD_OF_SHIELD[facts.shield];
    if (fromShield) hazards.push(fromShield);
    return hazards;
}

module.exports = { occurrencesOutsideChange, captureHazards, shapeChangeOf, literalsLackingMember, HAZARD_TEXT };
