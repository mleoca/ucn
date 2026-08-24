'use strict';

const path = require('path');
const { codeUnitCompare } = require('./shared');

// Descriptors/properties are consumed through reads and writes, not only
// call syntax. Keep this vocabulary shared by impact and refactoring so the
// two commands cannot disagree about whether a selected symbol is an accessor.
const ACCESSOR_KINDS = new Set([
    'property', 'setter', 'deleter', 'get', 'set',
    'static get', 'static set', 'override get', 'override set',
    'static override get', 'static override set',
]);

function isAccessorDefinition(definition) {
    return !!definition && (ACCESSOR_KINDS.has(definition.type) ||
        ACCESSOR_KINDS.has(definition.memberType));
}

function ownerName(definition) {
    if (definition.className) return definition.className;
    if (!definition.receiver) return null;
    return String(definition.receiver)
        .replace(/^[*&]\s*/, '')
        .replace(/^mut\s+/, '')
        .replace(/<.*$/, '')
        .trim() || null;
}

function bareTypeName(value) {
    if (!value) return null;
    return String(value)
        .replace(/^(?:typing\.)?(?:Optional|Annotated|Final)\s*\[/, '')
        .replace(/[<[(].*$/s, '')
        .split(/\.|::/).pop()
        .replace(/[?*&\s]/g, '') || null;
}

function typeMatchesOwner(index, typeName, contextFile, owner, ownerFile) {
    const bare = bareTypeName(typeName);
    if (!bare || !owner || bare !== owner) return false;
    const resolved = index._resolveClassFile?.(bare, contextFile);
    if (resolved) return path.resolve(resolved) === path.resolve(ownerFile);
    const ownerDefs = (index.symbols.get(owner) || []).filter(symbol =>
        ['class', 'struct', 'interface', 'trait', 'record'].includes(symbol.type));
    return ownerDefs.length === 1 &&
        path.resolve(ownerDefs[0].file) === path.resolve(ownerFile);
}

function insideSelectedAccessorBody(index, name, definition, file, line) {
    return (index.symbols.get(name) || []).some(candidate =>
        isAccessorDefinition(candidate) &&
        candidate.file === definition.file &&
        candidate.className === definition.className &&
        file === candidate.file &&
        line >= candidate.startLine &&
        line <= (candidate.endLine || candidate.startLine));
}

/**
 * Find reads/writes that may consume a selected accessor. Confirmed entries
 * require receiver identity (`self`/`this` in the owner or a Python instance
 * field whose constructor assignment proves the owner type). Everything else
 * remains visible in the unverified tier; accessor identity is never guessed
 * from the spelling alone.
 */
function findAccessorReferences(index, name, definition, options = {}) {
    if (!isAccessorDefinition(definition)) return null;
    const owner = ownerName(definition);
    if (!owner) return null;

    const confirmed = [];
    const unverified = [];
    const excluded = [];
    // Use the parser's raw occurrence records rather than usages()' public
    // line-oriented inventory. A line can contain two same-spelled member
    // accesses with different receivers; collapsing them by file+line would
    // make a rename edit one token while silently losing the other.
    const refs = [];
    for (const [file, entry] of index.files) {
        if (!index.matchesFilters(entry.relativePath, options)) continue;
        let content;
        let occurrences;
        try {
            content = index._readFile(file);
            if (!content.includes(name)) continue;
            occurrences = index._getCachedUsages(file, name);
        } catch { continue; }
        if (!occurrences) continue;
        const lines = content.split('\n');
        for (const usage of occurrences) {
            if (usage.usageType !== 'reference') continue;
            refs.push({
                ...usage,
                file,
                relativePath: entry.relativePath,
                content: lines[usage.line - 1] || '',
            });
        }
    }

    for (const ref of refs) {
        const rel = ref.relativePath || path.relative(index.root, ref.file);
        const shaped = {
            file: rel,
            absoluteFile: ref.file,
            line: ref.line,
            expression: (ref.content || '').trim(),
            ...(Number.isInteger(ref.column) && { column: ref.column }),
            ...(ref.receiver && { receiver: ref.receiver }),
        };

        // A backing-store attribute inside the selected getter/setter body
        // often has the same spelling (`self._local.value`). It is not a
        // consumption of the descriptor being queried.
        if (insideSelectedAccessorBody(index, name, definition, ref.file, ref.line) &&
            !['self', 'cls', 'this'].includes(ref.receiver)) {
            excluded.push({ ...shaped, reason: 'accessor-definition-body' });
            continue;
        }

        const enclosing = index.findEnclosingFunction(ref.file, ref.line, true);
        const receiver = ref.receiver || null;
        if (receiver && ['self', 'cls', 'this'].includes(receiver) &&
            enclosing?.className === owner && enclosing.file === definition.file) {
            confirmed.push({
                ...shaped,
                callerName: enclosing.name,
                resolution: 'same-class-accessor',
                tier: 'confirmed',
            });
            continue;
        }

        let receiverType = ref.receiverType || null;
        if (!receiverType && receiver && enclosing?.className) {
            receiverType = index.getInstanceAttributeTypes(
                ref.file, enclosing.className)?.get(receiver) || null;
        }
        if (receiverType && typeMatchesOwner(
            index, receiverType, ref.file, owner, definition.file)) {
            confirmed.push({
                ...shaped,
                callerName: enclosing?.name || null,
                receiverType,
                resolution: 'receiver-field-type',
                tier: 'confirmed',
            });
            continue;
        }
        if (receiver && typeMatchesOwner(index, receiver, ref.file, owner, definition.file)) {
            confirmed.push({
                ...shaped,
                callerName: enclosing?.name || null,
                receiverType: receiver,
                resolution: 'type-qualified-accessor',
                tier: 'confirmed',
            });
            continue;
        }

        unverified.push({
            ...shaped,
            callerName: enclosing?.name || null,
            ...(receiverType && { receiverType }),
            reason: receiverType ? 'receiver-type-mismatch' :
                receiver ? 'receiver-type-unresolved' : 'nested-receiver-unresolved',
            tier: 'unverified',
        });
    }

    const sort = (a, b) => codeUnitCompare(a.file, b.file) || a.line - b.line;
    confirmed.sort(sort);
    unverified.sort(sort);
    excluded.sort(sort);
    return { owner, confirmed, unverified, excluded };
}

module.exports = {
    ACCESSOR_KINDS,
    isAccessorDefinition,
    findAccessorReferences,
};
