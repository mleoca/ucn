'use strict';

const path = require('path');
const { codeUnitCompare, CALLABLE_SYMBOL_KINDS } = require('./shared');
const { getParser, safeParse, langTraits } = require('../languages');

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

function accessKind(tree, usage, token = null) {
    if (!tree || !Number.isInteger(usage.column)) return 'access';
    let node = token || tree.rootNode.descendantForPosition({ row: usage.line - 1, column: usage.column });
    if (!node) return 'access';
    if (node.tree.rootNode.hasError) {
        for (let current = node; current; current = current.parent) {
            if (current.type === 'ERROR') return 'access';
        }
    }
    while (['attribute', 'member_expression', 'member_access_expression', 'member_binding_expression',
        'conditional_access_expression'].includes(node.parent?.type) &&
        node.endIndex === node.parent.endIndex && node.startIndex > node.parent.startIndex) node = node.parent;
    const parent = node.parent;
    if (parent?.type === 'update_expression' || parent?.type === 'delete_statement') return parent.type === 'update_expression' ? 'read/write' : 'delete';
    if (['prefix_unary_expression', 'postfix_unary_expression'].includes(parent?.type) &&
        parent.children.some(child => child.type === '++' || child.type === '--')) return 'read/write';
    if (['assignment', 'assignment_expression', 'augmented_assignment', 'augmented_assignment_expression'].includes(parent?.type)) {
        const left = parent.childForFieldName('left');
        if (left && left.startIndex === node.startIndex && left.endIndex === node.endIndex) {
            const operator = parent.childForFieldName('operator');
            return parent.type.startsWith('augmented') || (operator && operator.text !== '=')
                ? 'read/write' : 'write';
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
function flowSiteOf(tree, usage, token = null) {
    if (!tree || !Number.isInteger(usage.column)) return null;
    const node = token || tree.rootNode.descendantForPosition({ row: usage.line - 1, column: usage.column });
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

// Query-time grammar facts identify an implicit member's lexical type;
// class identities decide which declaration that type actually provides.
function scopeClassRef(index, file, scope, memo) {
    const key = `scope\0${file}\0${scope.name}\0${scope.line}\0${scope.namespace}\0${scope.enclosingType}\0${scope.typeArity}`;
    if (memo.has(key)) return memo.get(key);
    const { classDefsNamed } = require('./class-identity');
    const entries = classDefsNamed(index, scope.name).entries.filter(({ def }) =>
        def.file === file && def.startLine <= scope.line && def.endLine >= scope.line &&
        (def.namespace || '') === scope.namespace &&
        (def.enclosingType || '') === scope.enclosingType && (def.typeArity || 0) === scope.typeArity);
    const ref = new Set(entries.map(entry => entry.key)).size === 1
        ? { name: scope.name, key: entries[0].key, def: entries[0].def } : null;
    memo.set(key, ref);
    return ref;
}

function writtenClassRef(index, file, line, written, memo) {
    if (!written) return null;
    const { classDefsNamed } = require('./class-identity');
    const { TypeReferenceResolver } = require('./type-references');
    const key = `${file}\0${line}\0${written.node.startIndex}\0${written.text || written.node.text}\0${written.namespace}`;
    if (memo.has(key)) return memo.get(key);
    const traits = langTraits(index.files.get(file)?.language);
    const resolve = (name, qualifier, siteNode = written.node) => {
        const entries = classDefsNamed(index, name).entries.filter(entry =>
            index.files.get(entry.def.file)?.language === index.files.get(file)?.language);
        const matches = [];
        let unknown = false;
        for (const entry of entries) {
            const resolver = new TypeReferenceResolver(index, entry.def, name);
            resolver.siteNode = siteNode;
            resolver.siteFile = file;
            const verdict = qualifier
                ? resolver.resolveQualified(file, line, written.qualifier, qualifier, { role: 'type' })
                : resolver.resolveName(file, line, name);
            if (verdict.verdict === 'yes') matches.push(entry);
            else if (verdict.verdict === 'unknown') unknown = true;
        }
        const keys = new Set(matches.map(entry => entry.key));
        return { ref: !unknown && keys.size === 1
            ? { name, key: matches[0].key, def: matches[0].def } : null, unknown };
    };
    let result = resolve(written.name, written.qualifierText);
    if (!result.ref && !result.unknown && !written.qualifierText && traits.typeNameScoping === 'namespace-usings') {
        const { csharpUsings } = require('./type-denotation');
        const scope = csharpUsings(index, file, written.namespace, written.node);
        const target = scope.aliases.get(written.name);
        if (target && !scope.ambiguousAliases.has(written.name)) {
            const text = scope.aliasSyntax.get(written.name) || target;
            const syntaxKey = 'syntax\0' + text;
            if (!memo.has(syntaxKey)) memo.set(syntaxKey, traits.accessorTypeSyntax?.(text) || null);
            const syntax = memo.get(syntaxKey);
            if (syntax) result = resolve(syntax.name,
                'global::' + (syntax.qualifierText || '').replace(/^global::/, ''), syntax.node);
        }
    }
    const ref = result.ref;
    memo.set(key, ref);
    return ref;
}

function certainMemberOwner(index, member, memo) {
    if (memo.has(member)) return memo.get(member);
    const { classDefsNamed } = require('./class-identity');
    if (!member.className) return null;
    const entries = classDefsNamed(index, member.className).entries.filter(({ def }) =>
        def.file === member.file && def.startLine <= member.startLine && def.endLine >= member.startLine &&
        (def.namespace || '') === (member.namespace || '') &&
        (def.typeArity || 0) === (member.ownerTypeArity || 0));
    const keys = new Set(entries.map(entry => entry.key));
    const key = keys.size === 1 ? entries[0].key : null;
    memo.set(member, key);
    return key;
}

function shapedAccessorVerdict(index, name, definition, ref, members, typeMemo) {
    const shape = ref.dependencyShape;
    if (!['implicit', 'initializer'].includes(shape.kind) || shape.uncertainRole) return 'review';
    const { findDeclaringClass, supertypeRefsOf, ownerRefOf, shareDescendant } = require('./class-identity');
    const targetOwner = ownerRefOf(index, definition);
    if (!targetOwner?.key || certainMemberOwner(index, definition, typeMemo) !== targetOwner.key) return 'review';
    const contractOwner = owner => ['interface', 'trait'].includes(owner.def?.type);
    const hierarchyOf = owner => {
        const key = `hierarchy\0${owner.key}`;
        if (typeMemo.has(key)) return typeMemo.get(key);
        const keys = new Set();
        const queue = [owner];
        let open = false;
        while (queue.length) {
            const current = queue.pop();
            if (!current.key || current.external) { open = true; continue; }
            if (keys.has(current.key)) continue;
            keys.add(current.key);
            queue.push(...supertypeRefsOf(index, current, { implements: true }));
        }
        const result = { keys, open };
        typeMemo.set(key, result);
        return result;
    };
    const verdictAt = owner => {
        const declaring = findDeclaringClass(index, owner, members);
        if (!declaring) {
            const hierarchy = hierarchyOf(owner);
            return hierarchy.open || contractOwner(owner) || hierarchy.keys.has(targetOwner.key) ? 'review' : null;
        }
        if (declaring.uncertain || declaring.members.some(member =>
            certainMemberOwner(index, member, typeMemo) !== ownerRefOf(index, member)?.key)) return 'review';
        if (!declaring.members.includes(definition)) {
            // An implicit receiver can dispatch through an ancestor or a
            // shared implementation. A construction names its exact type.
            if (shape.kind === 'implicit') {
                const key = `dispatch\0${owner.key}\0${targetOwner.key}`;
                if (!typeMemo.has(key)) typeMemo.set(key,
                    hierarchyOf(targetOwner).keys.has(owner.key) || hierarchyOf(targetOwner).open ||
                    // An interface receiver and a class member can meet in
                    // an implementation that inherits that member. The
                    // class-only descendant graph cannot disprove this.
                    contractOwner(owner) || contractOwner(targetOwner) ||
                    shareDescendant(index, owner, [definition]));
                if (typeMemo.get(key)) return 'review';
            }
            return 'skip';
        }
        const target = ownerRefOf(index, definition);
        return declaring.members.every(member => isAccessorDefinition(member) &&
            ownerRefOf(index, member)?.key === target?.key) ? 'edit' : 'review';
    };
    if (shape.kind === 'initializer') {
        const owner = writtenClassRef(index, ref.file, ref.line, shape.type, typeMemo);
        return owner ? verdictAt(owner) || 'skip' : 'review';
    }
    for (const scope of shape.scopes) {
        const owner = scopeClassRef(index, ref.file, scope, typeMemo);
        if (!owner) return 'review';
        const verdict = verdictAt(owner);
        if (!verdict) continue;
        if (verdict === 'edit' && shape.inferredName) return 'review';
        return verdict;
    }
    if (langTraits(index.files.get(ref.file)?.language)?.staticImportsDeclaredOnly) {
        const { csharpUsings } = require('./type-denotation');
        const scope = csharpUsings(index, ref.file, shape.namespace, shape.node);
        const traits = langTraits(index.files.get(ref.file)?.language);
        const namespaces = [];
        for (let parts = shape.namespace ? shape.namespace.split('.') : []; parts.length; parts = parts.slice(0, -1)) {
            namespaces.push(parts.join('.'));
        }
        namespaces.push('');
        for (const namespace of namespaces) {
            const hits = [];
            let unknown = false;
            for (const module of scope.statics) {
                if (!scope.staticScopes.get(module)?.has(namespace)) continue;
                const type = traits.accessorTypeSyntax?.(scope.staticSyntax.get(module) || module);
                const owner = type && writtenClassRef(index, ref.file, ref.line, { ...type,
                    qualifierText: 'global::' + (type.qualifierText || '').replace(/^global::/, '') }, typeMemo);
                if (!owner) { unknown = true; continue; }
                hits.push(...members.filter(member => certainMemberOwner(index, member, typeMemo) === owner.key &&
                    member.modifiers?.includes('static')));
            }
            if (unknown) return 'review';
            if (!hits.length) continue;
            if (!hits.includes(definition)) return 'skip';
            return hits.length === 1 && !shape.uncertainRole && !shape.inferredName ? 'edit' : 'review';
        }
    }
    return shape.scopes.length ? 'skip' : 'review';
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
    const typeMemo = new Map();
    const members = (index.symbols.get(name) || []).filter(member => member.className &&
        !member.explicitInterface && !['class', 'struct', 'interface', 'enum', 'record'].includes(member.type));
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
        const grammarShape = langTraits(entry.language)?.accessorReferenceShape;
        const candidates = occurrences.filter(usage => usage.usageType === 'reference' ||
            (grammarShape && usage.usageType === 'call'));
        if (!candidates.length) continue;
        const parser = getParser(entry.language);
        const tree = parser ? index._getParsedTree?.(file, content, entry.language) || safeParse(parser, content) : null;
        const lines = index._getFileLines?.(file) || content.split('\n');
        for (const usage of candidates) {
            const dependencyShape = grammarShape ? grammarShape(tree, usage) : null;
            if (dependencyShape === 'none') continue;
            let shape = null;
            if (!usage.receiver && !dependencyShape) {
                shape = receiverlessShape(tree, usage);
                if (shape === 'none') continue;
            }
            refs.push({
                ...usage,
                ...(shape?.pattern && { patternKey: shape, ...(shape.thisSource && { receiver: 'this' }) }),
                ...(dependencyShape && { dependencyShape }),
                accessKind: dependencyShape?.accessKind || (shape?.pattern ? 'read' : accessKind(tree, usage, dependencyShape?.node)),
                ...(usage.receiver && { flowSite: flowSiteOf(tree, usage, dependencyShape?.node) }),
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

        if (ref.dependencyShape && ref.dependencyShape.kind !== 'member') {
            const verdict = shapedAccessorVerdict(index, name, definition, ref, members, typeMemo);
            if (verdict === 'edit') confirmed.push({ ...shaped,
                callerName: index.findEnclosingFunction(ref.file, ref.line, true)?.name || null,
                resolution: 'member-lookup-accessor', tier: 'confirmed' });
            else if (verdict === 'skip') excluded.push({ ...shaped, reason: 'other-member-owner' });
            else unverified.push({ ...shaped,
                reason: ref.dependencyShape.inferredName ? 'inferred-member-name' : 'member-owner-unresolved',
                tier: 'unverified' });
            continue;
        }

        // A backing-store attribute inside the selected getter/setter body
        // often has the same spelling (`self._local.value`). It is not a
        // consumption of the descriptor being queried.
        if (!ref.dependencyShape && insideSelectedAccessorBody(index, name, definition, ref.file, ref.line) &&
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

    const sort = (a, b) => codeUnitCompare(a.file, b.file) || a.line - b.line || (a.column ?? -1) - (b.column ?? -1);
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
