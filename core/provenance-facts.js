'use strict';

const path = require('path');
const { langTraits } = require('../languages');
const { NON_CALLABLE_TYPES } = require('./shared');
const { declarationIdentity, identityKey, propertyReadMember } = require('./provenance');
const { captureOverload, overloadMemberGroup } = require('./provenance-overload');
const { splitParentList } = require('./graph-build');
const { distinctOwnerDefinitions } = require('./class-identity');

const TYPE_KINDS = new Set(['class', 'struct', 'interface', 'trait', 'record', 'enum', 'type', 'impl']);
const ownerName = definition => definition.className || (definition.receiver || '').replace(/^\*/, '');

function occurrenceIdentity(file, call, siteId) {
    const position = call.callSite || {};
    const column = call.column ?? position.column;
    const start = call.callStart ?? position.start;
    const end = call.callEnd ?? position.end;
    return {
        file, line: call.line,
        ...(Number.isInteger(column) && { column }),
        ...(Number.isInteger(start) && { start }),
        ...(Number.isInteger(end) && { end }),
        ...(siteId !== undefined && { siteId }),
    };
}

/**
 * Callable same-name definitions owned by a type, in symbol-table order.
 * Within an operation the name's definitions are grouped once (fix #382):
 * an exact HOT ranking resolves every site of a name once per same-name
 * definition, and a filter over thousands of definitions per site made the
 * ranking quadratic.
 */
function callableMembersOwnedBy(index, name, owner) {
    const definitions = index.symbols.get(name) || [];
    const memo = index._opMemo?.('callableMembersByOwner', () => new WeakMap());
    if (!memo) {
        return definitions.filter(d => !NON_CALLABLE_TYPES.has(d.type) && ownerName(d) === owner);
    }
    let byOwner = memo.get(definitions);
    if (!byOwner) {
        byOwner = new Map();
        for (const d of definitions) {
            if (NON_CALLABLE_TYPES.has(d.type)) continue;
            const key = ownerName(d);
            let list = byOwner.get(key);
            if (!list) {
                list = [];
                byOwner.set(key, list);
            }
            list.push(d);
        }
        memo.set(definitions, byOwner);
    }
    return byOwner.get(owner) || [];
}

/** Same-name definitions declared in one file, in symbol-table order. */
function definitionsInFile(index, name, file) {
    const definitions = index.symbols.get(name) || [];
    const memo = index._opMemo?.('definitionsByFile', () => new WeakMap());
    if (!memo) return definitions.filter(d => d.file === file);
    let byFile = memo.get(definitions);
    if (!byFile) {
        byFile = new Map();
        for (const d of definitions) {
            let list = byFile.get(d.file);
            if (!list) {
                list = [];
                byFile.set(d.file, list);
            }
            list.push(d);
        }
        memo.set(definitions, byFile);
    }
    return byFile.get(file) || [];
}

/** The first same-name definition in a file starting at `line`, if any. */
function definitionAt(index, name, file, line) {
    const inFile = definitionsInFile(index, name, file);
    const memo = index._opMemo?.('definitionsByLine', () => new WeakMap());
    if (!memo || inFile.length < 8) return inFile.find(d => d.startLine === line);
    let byLine = memo.get(inFile);
    if (!byLine) {
        byLine = new Map();
        for (const d of inFile) if (!byLine.has(d.startLine)) byLine.set(d.startLine, d);
        memo.set(inFile, byLine);
    }
    return byLine.get(line);
}

/** Follow paired AST import/export names; an arbitrary file import is no hop. */
function namedDeclaration(index, file, name, accepts, line, seen = new Set()) {
    const key = `${file}\0${name}`;
    if (seen.has(key) || seen.size >= 8) return null;
    const visited = new Set(seen).add(key);
    const entry = index.files.get(file);
    if (!entry) return null;
    const separator = name.includes('::') ? '::' : '.';
    const parts = name.split(separator);
    if (parts.length === 2) {
        const binding = (entry.importBindings || []).find(b => (b.alias || b.name) === parts[0]);
        const relative = binding && entry.moduleResolved?.[binding.module];
        if (relative) {
            const result = namedDeclaration(index, path.resolve(index.root, relative), parts[1], accepts, undefined, visited);
            if (result) return { declaration: result.declaration, chain: [{
                fromFile: entry.relativePath, toFile: relative, localName: name,
                importedName: parts[1], module: binding.module,
                ...(!result.chain.length && { declaration: declarationIdentity(result.declaration) }),
            }, ...result.chain] };
        }
    }
    let local = definitionsInFile(index, name, file).filter(d => accepts(d));
    if (line != null) {
        local = local.filter(d => !d.lexicalScopeStartLine ||
            (line >= d.lexicalScopeStartLine && line <= d.lexicalScopeEndLine));
        const scoped = local.filter(d => d.lexicalScopeStartLine);
        if (scoped.length) {
            const nearest = Math.max(...scoped.map(d => d.lexicalScopeStartLine));
            local = scoped.filter(d => d.lexicalScopeStartLine === nearest);
        }
        if (local.length > 1) {
            const enclosing = index.findEnclosingFunction(file, line, true);
            const inScope = enclosing && local.filter(d =>
                d.startLine >= enclosing.startLine && d.endLine <= enclosing.endLine && d.startLine <= line);
            if (inScope?.length === 1) local = inScope;
        }
    }
    if (local.length) return local.length === 1 ? { declaration: local[0], chain: [] } : null;
    const localExports = (entry.exportDetails || []).filter(e =>
        !e.source && (e.alias || e.name) === name && (e.localName || e.name) !== name);
    if (localExports.length === 1) {
        const importedName = localExports[0].localName || localExports[0].name;
        const result = namedDeclaration(index, file, importedName, accepts, line, visited);
        if (result) return { declaration: result.declaration, chain: [{
            fromFile: entry.relativePath, toFile: entry.relativePath,
            localName: name, importedName,
            ...(!result.chain.length && { declaration: declarationIdentity(result.declaration) }),
        }, ...result.chain] };
    }
    const aliases = entry.importAliases || [];
    const alias = aliases.find(a => a.local === name);
    const original = alias?.original || name;
    const links = (entry.importBindings || []).filter(b =>
        b.alias === name || (b.name === original && (!b.alias || b.alias === name)));
    const exports = (entry.exportDetails || []).filter(e =>
        e.type === 're-export' && (e.alias || e.name) === name && e.source);
    const found = [];
    for (const link of [...links, ...exports]) {
        const module = link.module || link.source;
        const relative = entry.moduleResolved?.[module];
        if (!relative) continue;
        const toFile = path.resolve(index.root, relative);
        const importedName = link.originalName || link.imported || link.name;
        if (!importedName || importedName === '*') continue;
        const result = namedDeclaration(index, toFile, importedName, accepts, undefined, visited);
        if (!result) continue;
        const hop = {
            fromFile: entry.relativePath, toFile: relative,
            localName: name, importedName, module, line: link.line,
            ...(!result.chain.length && { declaration: declarationIdentity(result.declaration) }),
        };
        found.push({ declaration: result.declaration, chain: [hop, ...result.chain] });
    }
    const distinct = new Map(found.map(f => [identityKey(declarationIdentity(f.declaration)), f]));
    return distinct.size === 1 ? distinct.values().next().value : null;
}

// Distinct owners of a member name. Depends only on the symbol table, so
// one operation (a findCallers pass visits every call site of the name)
// computes it once per name; the memo dies with the operation's content cache.
const ownerCountMemo = new WeakMap(); // op content cache -> Map<name, count>
function ownerCountOf(index, name) {
    const scope = index._opContentCache;
    let memo = scope ? ownerCountMemo.get(scope) : null;
    if (scope && !memo) { memo = new Map(); ownerCountMemo.set(scope, memo); }
    const cached = memo?.get(name);
    if (cached !== undefined) return cached;
    const count = new Set((index.symbols.get(name) || [])
        .filter(d => !NON_CALLABLE_TYPES.has(d.type) && ownerName(d))
        .map(d => `${d.file}\0${ownerName(d)}\0${d.namespace || ''}`)).size;
    memo?.set(name, count);
    return count;
}

/** Collect independent facts; a failed lookup never manufactures a negative. */
function confirmationFacts(index, file, call, targets, options = {}) {
    const entry = index.files.get(file);
    const language = entry?.language;
    const facts = {
        language,
        site: occurrenceIdentity(entry?.relativePath || file, call),
        targets: targets.map(declarationIdentity),
        receiver: call.receiver || null,
        receiverType: options.receiverType || call.receiverType || null,
        receiverTypeSource: options.receiverTypeSource || call.receiverTypeSource || 'unknown',
        receiverOrigin: options.receiverOrigin || call.receiverTypeEvidence || null,
        ...(call.isFunctionReference && { valueReference: true }),
        ownerCount: ownerCountOf(index, call.name),
        ...((options.originFile || call.receiverTypeFlowFile) && {
            receiverTypeFlowFile: path.relative(index.root, options.originFile || call.receiverTypeFlowFile),
        }),
        ...(call.moduleOwnedPath && { moduleOwnedPath: true }),
    };
    if (facts.receiverTypeSource === 'fixture' || facts.receiverOrigin?.externalFactory) facts.receiverPath = call.receiverRoot
        ? [call.receiverRoot, ...(call.receiverFields || [call.receiverField])]
        : [call.receiver];
    const methodReceiver = call.isMethod && !call.moduleOwnedPath;
    // Method-name bindings cannot establish the identity of a value receiver.
    if (options.bindingId && !methodReceiver) {
        const bound = (index.symbols.get(call.resolvedName || call.name) || [])
            .filter(d => d.bindingId === options.bindingId);
        if (bound.length === 1) facts.binding = {
            referenceId: options.bindingId, declaration: declarationIdentity(bound[0]),
        };
    }
    if (!methodReceiver) {
        const result = namedDeclaration(index, file, call.resolvedName || call.name,
            d => !NON_CALLABLE_TYPES.has(d.type) || call.isConstructor, call.line);
        if (result?.chain.length) facts.importChain = result.chain;
    }
    let type = facts.receiverType;
    if (options.sameClass) {
        const enclosing = index.findEnclosingFunction(file, call.line, true, call);
        type = enclosing?.className || enclosing?.receiver?.replace(/^\*/, '');
        facts.receiverTypeSource = 'same-class';
        facts.receiverOrigin = { source: 'same-class', declaration: declarationIdentity(enclosing) };
    }
    if (language === 'csharp' && call.receiverCastThis) {
        const enclosing = index.findEnclosingFunction(file, call.line, true, call);
        if (enclosing?.className) {
            facts.receiverCastThis = { enclosing: declarationIdentity(enclosing), interfaceType: type };
            type = enclosing.className;
        }
    }
    if (!type) {
        facts.incomplete = ['receiverType'];
        return facts;
    }
    if (facts.receiverTypeSource === 'unknown') facts.incomplete = ['receiverTypeSource'];
    const originFile = options.originFile || call.receiverTypeFlowFile || file;
    const resolveType = (name, context, atLine, qualifier) => {
        // A qualified annotation cannot bind to a same-named local type.
        // Apply the qualifier only to the receiver's first lookup: aliases
        // and parent annotations are resolved in their own declaration scope.
        if (qualifier && options.resolveType &&
            langTraits(language)?.typeSystem !== 'structural') {
            const definition = options.resolveType(name, context, atLine, qualifier);
            return definition ? { declaration: definition, chain: [] } : null;
        }
        const named = namedDeclaration(index, context, name, d =>
            (TYPE_KINDS.has(d.type) && d.type !== 'impl') ||
            (['javascript', 'typescript', 'tsx'].includes(language) &&
                d.type === 'function' && !d.className &&
                ['constructor', 'flow'].includes(facts.receiverTypeSource)), atLine);
        if (named) return named;
        // Nominal package/type lookup is delegated to the engine's language
        // rules, then pinned to a unique declaration in the resolved scope.
        if (langTraits(language)?.typeSystem !== 'structural' && options.resolveType) {
            const definition = options.resolveType(name, context, atLine);
            if (definition) return { declaration: definition, chain: [] };
        }
        return null;
    };
    const qualifier = call.receiverTypeNamespace || call.receiverTypeQualifier;
    if (qualifier) facts.receiverTypeQualifier = qualifier;
    // A parser annotation's qualifier belongs to the consuming file. The
    // already-pinned declaration file may be another crate/module, where
    // replaying `crate::Type` or an import alias would change its meaning.
    const receiverContext = qualifier && facts.receiverTypeSource === 'annotation' ? file : originFile;
    // A type name resolves where it was written: a field typed by
    // `self.x = Local()` names the class visible at that write (fix #381).
    const typeLine = Number.isInteger(options.receiverTypeLine) ? options.receiverTypeLine : call.line;
    let resolved = resolveType(type, receiverContext, receiverContext === file ? typeLine : undefined, qualifier);
    if (resolved && receiverContext !== originFile && resolved.declaration.file !== originFile) resolved = null;
    if (!resolved && language === 'rust') {
        const enclosing = index.findEnclosingFunction(file, call.line, true, call);
        const bounds = enclosing?.genericBounds?.[type];
        const boundTypes = (bounds || []).map(bound => resolveType(bound, file, call.line))
            .filter(bound => bound?.declaration.type === 'trait' &&
                (index.symbols.get(call.name) || []).some(member =>
                    ownerName(member) === bound.declaration.name && member.file === bound.declaration.file));
        if (boundTypes.length === 1) {
            resolved = boundTypes[0];
            facts.receiverGenericBound = { declaration: declarationIdentity(enclosing),
                parameter: type, bounds, selected: declarationIdentity(resolved.declaration) };
        }
    }
    if (!resolved) return facts;
    facts.receiverTypeDeclaration = declarationIdentity(resolved.declaration);
    if (resolved.chain.length) facts.receiverImportChain = resolved.chain;
    const aliases = [];
    while (resolved.declaration.aliasOf && aliases.length < 8) {
        const alias = resolved.declaration;
        const head = options.typeHead?.(alias.aliasOf) || alias.aliasOf;
        const target = resolveType(head, alias.file);
        if (!target || aliases.some(a => a.declaration.file === alias.relativePath && a.declaration.startLine === alias.startLine)) return facts;
        aliases.push({ declaration: declarationIdentity(alias), aliasOf: alias.aliasOf,
            name: head, target: declarationIdentity(target.declaration) });
        resolved = target;
    }
    if (aliases.length) facts.receiverAliases = aliases;
    facts.receiverResolvedIn = declarationIdentity(resolved.declaration);
    const visited = new Set();
    const walk = (owner, steps) => {
        const identity = declarationIdentity(owner);
        const key = identityKey(identity);
        if (visited.has(key) || visited.size >= 16) return null;
        visited.add(key);
        const ownerDefinition = owner.file && TYPE_KINDS.has(owner.type) ? owner : null;
        const members = callableMembersOwnedBy(index, call.name, owner.name).filter(d => {
            // A member of a same-name class declared in another scope of
            // the file is not this owner's member (fix #389).
            if (ownerDefinition && distinctOwnerDefinitions(index, d, ownerDefinition, true)) return false;
            if (language === 'csharp' && d.explicitInterface &&
                (!facts.receiverCastThis || d.explicitInterface !== facts.receiverCastThis.interfaceType)) return false;
            if ((d.namespace || null) !== (owner.namespace || null)) return false;
            if ((d.enclosingType || null) !== (owner.enclosingType || null)) return false;
            return d.file === owner.file || (language === 'go' &&
                path.dirname(d.file) === path.dirname(owner.file));
        });
        // Use the AST spelling before the inheritance graph normalizes aliases
        // and qualifiers. A terminal name alone loses its declaring scope.
        const rawOwner = index.files.get(owner.file)?.symbols.find(d =>
            d.name === owner.name && d.startLine === owner.startLine && d.type === owner.type) || owner;
        const parentNames = rawOwner.extends ? splitParentList(rawOwner.extends) : [];
        const derefTarget = language === 'rust' ? rawOwner.derefTarget : null;
        const parents = [...parentNames, ...(derefTarget ? [derefTarget] : [])]
            .map(name => resolveType(name, owner.file, owner.startLine)).filter(Boolean).map(r => r.declaration);
        // The member may be inherited from an external declaration. This
        // collector has no platform-member lookup; report the coverage gap
        // separately from an ambiguous or inconsistent project lookup.
        if (!members.length && parents.length < parentNames.length) {
            facts.lookupUnsupported = 'external-parent-member';
            return null;
        }
        // A C++ using-declaration in the class body (`using Base::name;`,
        // fix #401) brings the base's members of the name into this lookup
        // set: the arguments choose among both. The witness only states a
        // member of this class, so a choice it cannot express (a base
        // member, or no choice) leaves the lookup unproven.
        if (language === 'cpp' && members.length > 0 && parents.length > 0) {
            const usingBases = require('./callers')._cppMemberUsingBases(index, owner.name, call.name, owner.file);
            const brought = usingBases && usingBases.size > 0 ? parents.filter(parent => usingBases.has('*') ||
                usingBases.has(String(parent.name).replace(/<.*$/s, '').split('::').pop())) : [];
            if (brought.length > 0) {
                const baseMembers = brought.flatMap(parent =>
                    callableMembersOwnedBy(index, call.name, parent.name).filter(d => d.file === parent.file));
                let choice;
                try {
                    choice = options.selectOverload ? options.selectOverload(index, call, [...members, ...baseMembers], language) : null;
                } catch {
                    choice = null;
                }
                if (!choice?.match || members.length !== 1 || choice.match !== members[0]) return null;
            }
        }
        const step = { owner: identity, members: members.map(declarationIdentity), parents: parents.map(declarationIdentity),
            ...(derefTarget && { derefTarget }) };
        const getter = facts.valueReference && propertyReadMember(step.members);
        if (getter) return { receiver: declarationIdentity(resolved.declaration),
            steps: [...steps, { ...step, propertyRead: true }], selected: getter };
        if (language === 'java' || language === 'csharp') {
            step.memberDefinitions = members;
            const chain = [...steps, step];
            if (parents.length === 1) return walk(parents[0], chain);
            if (parents.length > 1) return null;
            const group = overloadMemberGroup(chain);
            if (!group?.length) return null;
            const overload = captureOverload(index, call, group, language, options.selectOverload);
            if (!overload) return null;
            return { receiver: declarationIdentity(resolved.declaration), steps: chain,
                selected: overload.selected || declarationIdentity(group[0]), overload };
        }
        if (members.length === 1) return {
            receiver: declarationIdentity(resolved.declaration),
            steps: [...steps, step], selected: declarationIdentity(members[0]),
        };
        // Configuration alternatives of one member (fix #385: `#ifdef _WIN32
        // bool f() ... #else bool f() ... #endif` in one class body) are the
        // member in each build configuration: the lookup selects the item.
        if (members.length > 1) {
            const { _isConfigurationAlternative } = require('./callers');
            if (members.slice(1).every(member => _isConfigurationAlternative(index, members[0], member))) {
                return {
                    receiver: declarationIdentity(resolved.declaration),
                    steps: [...steps, step], selected: declarationIdentity(members[0]),
                    configurationItem: members.map(declarationIdentity),
                };
            }
        }
        if (members.length > 1 && options.selectOverload) {
            // The choice is made on the index itself first (its memos stay
            // on); only a selected member needs the replayable witness.
            let choice;
            try {
                choice = options.selectOverload(index, call, members, language);
            } catch {
                choice = null;
            }
            const overload = choice?.match
                ? captureOverload(index, call, members, language, options.selectOverload) : null;
            if (overload?.selected) return {
                receiver: declarationIdentity(resolved.declaration),
                steps: [...steps, { ...step, overload }], selected: overload.selected,
            };
            // Every member the lookup found is known but the arguments cannot
            // choose one (fix #396). Name lookup stops at the declaring class,
            // so the callee is one of its members of that name: the witness
            // (`memberSet`) proves that a target outside them is not the
            // callee without replaying the overload choice. The hops before
            // the declaring class declare no member of the name.
            if (!choice?.match && choice?.ambiguous === true && steps.every(prior => prior.members.length === 0)) {
                return {
                    receiver: declarationIdentity(resolved.declaration),
                    steps: [...steps, step],
                    selected: declarationIdentity(members[0]), memberSet: true,
                };
            }
        }
        if (members.length || parents.length !== 1) return null;
        return walk(parents[0], [...steps, step]);
    };
    const lookup = walk(resolved.declaration, []);
    if (lookup) facts.lookup = lookup;
    return facts;
}

module.exports = { confirmationFacts, namedDeclaration, occurrenceIdentity, definitionsInFile, definitionAt };
