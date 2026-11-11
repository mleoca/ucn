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
const { NON_CALLABLE_TYPES } = require('./shared');
const { langTraits } = require('../languages');

const HAZARD_TEXT = Object.freeze({
    'name-in-use': 'the name already occurs outside this change: existing code may now bind to the new declaration',
    'novelty-unknown': 'part of the project could not be searched for the name, so it cannot be shown to be new',
    'new-requirement': 'a new requirement of an existing contract: every implementer must now supply it',
    'overrides-inherited': 'overrides a member the type inherited: existing calls on this type now reach it',
    'overridden-by-descendant': 'a descendant already declares this member: it now overrides the new one',
    'constructor-of-existing-type': 'changes how an existing type is constructed',
    'field-of-existing-type': 'a new member of an existing type: construction, positional initialisation and layout can depend on its members',
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

/**
 * Hazards of adding `definition`, a declaration the index now holds.
 *
 * @param {object} index
 * @param {object} definition - the indexed symbol record
 * @param {object} facts - { ownerExisted: the owner type predates the change,
 *   contract: what holds the declaration in place whatever names it
 *   (core/deadcode.js contractFactsOf), shield: the reason a deletion
 *   assessment of it names, or null }
 * @returns {string[]} hazard codes, in a fixed order
 */
function captureHazards(index, definition, facts = {}) {
    const hazards = [];
    if (definition.className && facts.ownerExisted) {
        const type = definition.type || definition.memberType;
        if (definition.requiredMember) hazards.push('new-requirement');
        if (definition.isConstructor || type === 'constructor') hazards.push('constructor-of-existing-type');
        else if (NON_CALLABLE_TYPES.has(type) && !definition.isMethod) hazards.push('field-of-existing-type');
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

module.exports = { occurrencesOutsideChange, captureHazards, HAZARD_TEXT };
