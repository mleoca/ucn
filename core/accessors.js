'use strict';

const path = require('path');
const { codeUnitCompare, CALLABLE_SYMBOL_KINDS } = require('./shared');
const { getParser, safeParse } = require('../languages');

function inheritedAccessor(index, enclosing, name, definition) {
    let owner = enclosing?.className;
    let file = enclosing?.file;
    const seen = new Set();
    while (owner && file && !seen.has(`${file}\0${owner}`)) {
        seen.add(`${file}\0${owner}`);
        if (owner === ownerName(definition) && file === definition.file) return true;
        // An override owns this spelling. Multiple inheritance and duplicate
        // declarations need richer lookup evidence, so keep them unverified.
        if ((index.symbols.get(name) || []).some(d => d.className === owner && d.file === file)) return false;
        const definitions = (index.symbols.get(owner) || []).filter(d => d.file === file && ['class', 'struct'].includes(d.type));
        if (definitions.length !== 1) return false;
        const parents = index._getInheritanceParentsAt(owner, file, definitions[0].startLine) || [];
        if (parents.length !== 1) return false;
        const parentName = bareTypeName(parents[0]);
        const candidates = (index.symbols.get(parentName) || []).filter(d => ['class', 'struct'].includes(d.type));
        const local = candidates.filter(d => d.file === file);
        const imported = candidates.filter(d => index.importGraph.get(file)?.has(d.file));
        const targets = local.length ? local : imported;
        if (targets.length !== 1) return false;
        owner = targets[0].name;
        file = targets[0].file;
    }
    return false;
}

function accessKind(tree, usage) {
    if (!tree || !Number.isInteger(usage.column)) return 'access';
    let node = tree.rootNode.descendantForPosition({ row: usage.line - 1, column: usage.column });
    if (['attribute', 'member_expression', 'member_access_expression'].includes(node.parent?.type)) node = node.parent;
    const parent = node.parent;
    if (parent?.type === 'update_expression' || parent?.type === 'delete_statement') return parent.type === 'update_expression' ? 'read/write' : 'delete';
    if (['assignment', 'assignment_expression', 'augmented_assignment', 'augmented_assignment_expression'].includes(parent?.type)) {
        const left = parent.childForFieldName('left');
        if (left && left.startIndex === node.startIndex && left.endIndex === node.endIndex) {
            return parent.type.startsWith('augmented') ? 'read/write' : 'write';
        }
    }
    return 'read';
}

// How an occurrence without a simple receiver touches a property (fix #397):
// 'member' (the property of a longer member chain, `this.ctx.body`),
// { pattern: true, thisSource } (a destructuring key, `const { body } =
// this`, which reads the property from the source), or 'none' (a bare
// variable, an object-literal key: never a property access). null when the
// token cannot be located.
const MEMBER_ACCESS_TYPES = new Set(['attribute', 'member_expression', 'member_access_expression',
    'field_expression', 'selector_expression', 'field_access']);
function receiverlessShape(tree, usage) {
    if (!tree || !Number.isInteger(usage.column)) return null;
    const node = tree.rootNode.descendantForPosition({ row: usage.line - 1, column: usage.column });
    if (!node) return null;
    const parent = node.parent;
    if (MEMBER_ACCESS_TYPES.has(parent?.type) && node.startIndex > parent.startIndex) return 'member';
    let key = null;
    if (node.type === 'shorthand_property_identifier_pattern') key = node;
    else if (parent?.type === 'pair_pattern' && parent.childForFieldName('key')?.startIndex === node.startIndex) key = node;
    if (key) {
        let pattern = key.parent;
        if (pattern?.type === 'pair_pattern' || pattern?.type === 'object_assignment_pattern') pattern = pattern.parent;
        const holder = pattern?.type === 'object_pattern' ? pattern.parent : null;
        const source = holder?.type === 'variable_declarator' ? holder.childForFieldName('value') : null;
        return { pattern: true, thisSource: source?.type === 'this',
            shorthand: key.type === 'shorthand_property_identifier_pattern' };
    }
    return 'none';
}

// Source offset of an occurrence (fix #398F): orders it against same-line
// assignments when its receiver is typed by return-type flow.
function flowSiteOf(tree, usage) {
    if (!tree || !Number.isInteger(usage.column)) return null;
    const node = tree.rootNode.descendantForPosition({ row: usage.line - 1, column: usage.column });
    return node ? node.startIndex : null;
}

// The enclosing callable scopes of a line, outermost first, as the parser's
// call records spell them (`enclosingFunction.scopeChain`): the innermost
// scope any record of the file reports around the line (anonymous callbacks
// included), else the indexed callables containing it.
function scopeChainAt(index, file, line, calls) {
    let best = null;
    for (const call of calls || []) {
        const scope = call.enclosingFunction;
        if (!scope || scope.startLine > line || scope.endLine < line) continue;
        if (!best || scope.startLine > best.startLine ||
            (scope.startLine === best.startLine && scope.endLine < best.endLine)) best = scope;
    }
    if (best && Array.isArray(best.scopeChain)) return best.scopeChain;
    const scopes = (index.files.get(file)?.symbols || []).filter(symbol =>
        CALLABLE_SYMBOL_KINDS.has(symbol.type) && symbol.startLine <= line && line <= symbol.endLine)
        .sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
    return scopes.map(symbol => symbol.startLine);
}

// A plain local receiver typed by return-type flow (`result =
// runner.invoke(..)` with `invoke(..) -> Result`), the evidence the caller
// engine uses for method calls on the same receiver (fix #398F).
function flowReceiverType(index, ref, flowMaps) {
    if (!/^[A-Za-z_$][\w$]*$/.test(ref.receiver || '') || ['self', 'cls', 'this'].includes(ref.receiver)) return null;
    const callers = require('./callers');
    let state = flowMaps.get(ref.file);
    if (state === undefined) {
        const calls = callers.getCachedCalls(index, ref.file);
        state = calls ? { calls, map: callers._buildReturnTypeFlowMap(index, ref.file, calls) } : null;
        flowMaps.set(ref.file, state);
    }
    const map = state?.map;
    if (!map) return null;
    const chain = scopeChainAt(index, ref.file, ref.line, state.calls);
    const entry = callers._lookupReturnTypeFlow(map, {
        receiver: ref.receiver, line: ref.line,
        ...(Number.isInteger(ref.flowSite) && { callStart: ref.flowSite }),
        enclosingFunction: chain.length ? { startLine: chain[chain.length - 1], scopeChain: chain } : null,
    });
    if (!entry?.type || entry.invalidated || !entry.fromFile) return null;
    return { type: entry.type, fromFile: entry.fromFile };
}

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
    // An object-literal accessor's owner is the literal (fix #397).
    if (definition.objectLiteralLine && definition.registryContainer) return definition.registryContainer;
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

// Members of the same object literal (fix #397): `this` in one names the
// object the literal builds (or an object inheriting from it).
function sameObjectLiteral(a, b) {
    return !!a && !!b && !!a.objectLiteralLine && a.objectLiteralLine === b.objectLiteralLine &&
        a.file === b.file;
}

function insideSelectedAccessorBody(index, name, definition, file, line) {
    return (index.symbols.get(name) || []).some(candidate =>
        isAccessorDefinition(candidate) &&
        candidate.file === definition.file &&
        candidate.className === definition.className &&
        (candidate.objectLiteralLine || null) === (definition.objectLiteralLine || null) &&
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
    const flowMaps = new Map();
    // Use the parser's raw occurrence records rather than usages()' public
    // line-oriented inventory. A line can contain two same-spelled member
    // accesses with different receivers; collapsing them by file+line would
    // make a rename edit one token while silently losing the other.
    const refs = [];
    for (const [file, entry] of index.files) {
        // `files` (fix #398F): a caller that needs one file family (tests)
        // never parses the rest of the project.
        if (options.files && !options.files.has(file)) continue;
        if (!index.matchesFilters(entry.relativePath, options)) continue;
        let content;
        let occurrences;
        try {
            content = index._readFile(file);
            if (!content.includes(name)) continue;
            occurrences = index._getCachedUsages(file, name);
        } catch { continue; }
        if (!occurrences) continue;
        const parser = getParser(entry.language);
        const tree = parser ? safeParse(parser, content) : null;
        const lines = content.split('\n');
        for (const usage of occurrences) {
            if (usage.usageType !== 'reference') continue;
            let shape = null;
            if (!usage.receiver) {
                shape = receiverlessShape(tree, usage);
                if (shape === 'none') continue;
            }
            refs.push({
                ...usage,
                ...(shape?.pattern && { patternKey: shape, ...(shape.thisSource && { receiver: 'this' }) }),
                accessKind: shape?.pattern ? 'read' : accessKind(tree, usage),
                ...(usage.receiver && { flowSite: flowSiteOf(tree, usage) }),
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
            accessKind: ref.accessKind,
            ...(Number.isInteger(ref.column) && { column: ref.column }),
            ...(ref.receiver && { receiver: ref.receiver }),
            ...(ref.patternKey && { patternKey: { shorthand: !!ref.patternKey.shorthand } }),
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
            ((definition.className && enclosing?.className === owner &&
                enclosing.file === definition.file) ||
                (!definition.className && sameObjectLiteral(enclosing, definition)) ||
                inheritedAccessor(index, enclosing, name, definition))) {
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
        const flowed = !receiverType && receiver ? flowReceiverType(index, ref, flowMaps) : null;
        if (flowed && bareTypeName(flowed.type) === owner &&
            path.resolve(flowed.fromFile) === path.resolve(definition.file)) {
            confirmed.push({
                ...shaped,
                callerName: enclosing?.name || null,
                receiverType: flowed.type,
                resolution: 'receiver-return-flow',
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
