'use strict';

const path = require('path');
const { langTraits } = require('../languages');
const { NON_CALLABLE_TYPES, isCallableMember } = require('./shared');
const { declarationIdentity, identityKey, propertyReadMember } = require('./provenance');
const { captureOverload, overloadMemberGroup } = require('./provenance-overload');
const { splitParentList } = require('./graph-build');
const { distinctOwnerDefinitions, completeForwardDeclaration } = require('./class-identity');

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
        return definitions.filter(d => isCallableMember(d) && ownerName(d) === owner);
    }
    let byOwner = memo.get(definitions);
    if (!byOwner) {
        byOwner = new Map();
        for (const d of definitions) {
            if (!isCallableMember(d)) continue;
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

/**
 * Every part of a C# `partial` type (one class across declarations, fix
 * #428): same namespace, enclosing type, name and generic arity, each
 * declared `partial`, in (file, line) order; null for any other type.
 */
function partialTypeParts(index, definition) {
    if (!Array.isArray(definition.modifiers) || !definition.modifiers.includes('partial') ||
        index.files.get(definition.file)?.language !== 'csharp') return null;
    const parts = (index.symbols.get(definition.name) || []).filter(d => d.type === definition.type &&
        Array.isArray(d.modifiers) && d.modifiers.includes('partial') &&
        (d.namespace || null) === (definition.namespace || null) &&
        (d.enclosingType || null) === (definition.enclosingType || null) &&
        (d.typeArity || 0) === (definition.typeArity || 0) &&
        index.files.get(d.file)?.language === 'csharp');
    if (parts.length < 2) return null;
    return parts.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.startLine - b.startLine);
}

/**
 * Does the Rust name model (core/rust-names.js) bind a bare name at the call
 * to something other than `declaration` (fix #428)? An undecided model
 * answer keeps the witness.
 */
function rustNameDisagrees(index, file, call, declaration, ns) {
    if (!langTraits(index.files.get(file)?.language)?.itemScopeResolution || call.isMethod || call.receiver) return false;
    const named = require('./rust-names').resolveRustName(index, file, call.line, call.resolvedName || call.name, ns,
        call.scopeBinding || null);
    if (!named?.defs?.length) return !!named?.external;
    return !named.defs.includes(declaration);
}

/**
 * Does a call select its only candidate without reading any fact (fix
 * #428): no type arguments, no spread, no typed argument, exactly the
 * candidate's fixed, non-generic, non-extension parameter list?
 */
function soleMemberFits(call, definition) {
    const params = definition.paramsStructured;
    return !call.methodTypeArgs && !call.argSpread && Number.isInteger(call.argCount) &&
        (!Array.isArray(call.argKinds) || call.argKinds.every(kind => kind === 'expr')) &&
        !definition.generics && !definition.isExtensionMethod && Array.isArray(params) &&
        params.length === call.argCount &&
        params.every(param => param && !param.rest && !param.optional && param.default === undefined);
}

/** The generic arity of each top-level entry of a base list (`A, B<T, U>` -> [0, 2]). */
function writtenArities(clause) {
    const out = [];
    let depth = 0;
    let count = 0;
    for (const ch of `${clause},`) {
        if (ch === '<') { if (depth === 0) count = 1; depth++; }
        else if (ch === '>') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 1) count++;
        else if (ch === ',' && depth === 0) { out.push(count); count = 0; }
    }
    return out;
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
        // Explicit construction looks up a type. Its same-named constructor
        // declarations are members, not competing import bindings.
        const constructsType = (call.isConstructor || langTraits(language)?.classesCallableWithoutNew) && targets.length > 0 &&
            targets.every(target => TYPE_KINDS.has(target.type));
        const result = namedDeclaration(index, file, call.resolvedName || call.name,
            d => constructsType ? TYPE_KINDS.has(d.type)
                : !NON_CALLABLE_TYPES.has(d.type) || call.isConstructor, call.line);
        // Rust binds a bare name by its own item and `use` scopes (fix
        // #422): an import chain naming another item than the language's
        // lookup is no witness of it (fix #428).
        if (result?.chain.length && rustNameDisagrees(index, file, call, result.declaration, constructsType ? 'type' : 'value')) {
            facts.lookupGap = 'rust-name-scope';
        } else if (result?.chain.length) facts.importChain = result.chain;
    }
    let type = facts.receiverType;
    let anonymousQualifier = null;
    if (options.sameClass) {
        const enclosing = index.findEnclosingFunction(file, call.line, true, call);
        type = enclosing?.className || enclosing?.receiver?.replace(/^\*/, '');
        facts.receiverTypeSource = 'same-class';
        facts.receiverOrigin = { source: 'same-class', declaration: declarationIdentity(enclosing) };
        // `super.m()` / `super().m()` / `base.M()` look the member up from
        // the enclosing class's bases, never its own members (fix #428): the
        // witness starts there too. In an anonymous class body `super` names
        // the instantiated base type (fix #394), looked up as written.
        const superReceiver = langTraits(language)?.superReceiver;
        if (superReceiver && call.isMethod && call.receiver === superReceiver && !call.constructorSyntax) {
            if (call.receiverSuperType) type = call.receiverSuperType;
            else facts.receiverOrigin.superLookup = true;
        }
        // A bare call in an anonymous class body (`new Base() { .. m() .. }`,
        // fix #401) looks the member up from the instantiated base (fix #428).
        if (!call.receiver && call.anonymousSuperType) {
            const parts = String(call.anonymousSuperType).replace(/<.*$/s, '').trim().split('.');
            type = parts.pop();
            if (parts.length) anonymousQualifier = parts.join('.');
            facts.receiverOrigin.anonymousSuperType = call.anonymousSuperType;
        }
    }
    // A static member call is also a reference to the type it is written
    // through (`JsonParser.parseString(..)` for a class query, fix #428):
    // its witness is the type the qualifier names, not a member lookup.
    if (call.isTypeReference && call.receiver && options.resolveType) {
        const written = String(call.receiver).split('.').pop();
        const qualified = String(call.receiver).includes('.') ? String(call.receiver).split('.').slice(0, -1).join('.') : null;
        const named = options.resolveType(written, file, call.line, qualified || call.receiverTypeNamespace || undefined);
        if (named) facts.typeReference = { written: call.receiver, declaration: declarationIdentity(named) };
        else facts.lookupGap = 'type-qualifier-unresolved';
        return facts;
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
    // A C# extension invocation binds a static member of another class
    // through the receiver's `this` parameter: no member lookup on the
    // receiver's type describes it, and this collector has no extension
    // witness yet (a rule not yet validated, fix #428).
    if (options.extensionMethod) {
        facts.lookupGap = 'extension-method';
        return facts;
    }
    if (facts.receiverTypeSource === 'unknown') facts.incomplete = ['receiverTypeSource'];
    const originFile = options.originFile || call.receiverTypeFlowFile || file;
    // A written generic arity names one of the same-name types where arity is
    // identity (C# `MemberMap` vs `MemberMap<TClass, TMember>`, fix #428).
    const arityFits = (d, arity) => !Number.isInteger(arity) || !langTraits(language)?.genericArityIsIdentity ||
        (d.typeArity || 0) === arity;
    const resolveType = (name, context, atLine, qualifier, arity) => {
        // A qualified annotation cannot bind to a same-named local type.
        // Apply the qualifier only to the receiver's first lookup: aliases
        // and parent annotations are resolved in their own declaration scope.
        if (qualifier && options.resolveType &&
            langTraits(language)?.typeSystem !== 'structural') {
            const definition = options.resolveType(name, context, atLine, qualifier, arity);
            return definition ? {
                declaration: completeForwardDeclaration(index, definition, file), chain: [] } : null;
        }
        const named = namedDeclaration(index, context, name, d =>
            ((TYPE_KINDS.has(d.type) && d.type !== 'impl') ||
            (['javascript', 'typescript', 'tsx'].includes(language) &&
                d.type === 'function' && !d.className &&
                ['constructor', 'flow'].includes(facts.receiverTypeSource))) && arityFits(d, arity), atLine);
        if (named) return { ...named,
            declaration: completeForwardDeclaration(index, named.declaration, file) };
        // Nominal package/type lookup is delegated to the engine's language
        // rules, then pinned to a unique declaration in the resolved scope.
        if (langTraits(language)?.typeSystem !== 'structural' && options.resolveType) {
            const definition = options.resolveType(name, context, atLine, undefined, arity);
            if (definition) return {
                declaration: completeForwardDeclaration(index, definition, file), chain: [] };
        }
        return null;
    };
    // A Rust path receiver (`crate::m::T::new()`) names the type its module
    // path declares (fix #428).
    const rustPath = langTraits(language)?.itemScopeResolution && facts.receiverTypeSource === 'type-qualified' &&
        String(call.receiver || '').includes('::') && String(call.receiver).split('::').pop() === type
        ? String(call.receiver).split('::').slice(0, -1).join('::') : null;
    const qualifier = anonymousQualifier || rustPath || call.receiverTypeNamespace || call.receiverTypeQualifier;
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
    // A bare (implicit-this) call whose class hierarchy declares no member
    // of the name looks it up in the lexically enclosing type next (JLS
    // 15.12.1, C# member lookup through enclosing type declarations): the
    // innermost declaration of this file enclosing the type that started
    // the current lexical level (fix #428).
    const lexicalOuterOf = chain => {
        if (call.receiver || facts.receiverTypeSource !== 'same-class' || facts.receiverOrigin?.superLookup) return null;
        let start = 0;
        for (let i = chain.length - 1; i > 0; i--) if (chain[i].enclosingOf) { start = i; break; }
        if (chain.slice(start).some(step => step.members.length > 0)) return null;
        const inner = chain[start].owner;
        if (!inner.enclosingType) return null;
        const segments = String(inner.enclosingType).split('.');
        const name = segments.pop();
        const prefix = segments.length ? segments.join('.') : null;
        const outer = (index.files.get(path.resolve(index.root, inner.file))?.symbols || []).filter(d =>
            TYPE_KINDS.has(d.type) && d.type !== 'impl' && d.name === name && (d.enclosingType || null) === prefix &&
            (d.namespace || null) === (inner.namespace || null) &&
            d.startLine <= inner.startLine && (d.endLine ?? d.startLine) >= inner.endLine)
            .sort((a, b) => b.startLine - a.startLine)[0];
        return outer ? { definition: outer, inner } : null;
    };
    // Choices among same-name members the overload replay cannot state yet
    // (report-only, fix #428): Rust probes inherent impls before trait impls
    // and selects among one type's trait impls by argument type (fixes #384,
    // #399); C++ member pairs that differ in `const` or a ref-qualifier are
    // chosen by the object expression (fix #427).
    const memberChoiceGap = members => {
        if (langTraits(language)?.typeQualifiedCallStyle === 'path' &&
            new Set(members.map(member => (member.traitImpl
                ? `trait:${member.traitName || ''}:${member.implSelfRef || ''}` : 'inherent') +
                `:${(member.ownerSelfArgs || []).join(',')}`)).size > 1) return 'impl-selection';
        if (new Set(members.map(member => `${!!member.memberConst}:${member.refQualifier || ''}`)).size > 1) {
            return 'object-qualified-overload';
        }
        return null;
    };
    const walk = (owner, steps, extra = null) => {
        const identity = declarationIdentity(owner);
        const key = identityKey(identity);
        if (visited.has(key) || visited.size >= 16) return null;
        visited.add(key);
        const ownerDefinition = owner.file && TYPE_KINDS.has(owner.type) ? owner : null;
        // The parts of a C# `partial` type are one class (fix #428): members
        // and bases declared in any part belong to it.
        const partialParts = ownerDefinition ? partialTypeParts(index, ownerDefinition) : null;
        const partFiles = partialParts ? new Set(partialParts.map(part => part.file)) : null;
        let members = callableMembersOwnedBy(index, call.name, owner.name).filter(d => {
            // A member of a same-name class declared in another scope of
            // the file is not this owner's member (fix #389).
            if (ownerDefinition && distinctOwnerDefinitions(index, d, ownerDefinition, true)) return false;
            if (language === 'csharp' && d.explicitInterface &&
                (!facts.receiverCastThis || d.explicitInterface !== facts.receiverCastThis.interfaceType)) return false;
            if ((d.namespace || null) !== (owner.namespace || null)) return false;
            if ((d.enclosingType || null) !== (owner.enclosingType || null)) return false;
            return d.file === owner.file || !!partFiles?.has(d.file) || (language === 'go' &&
                path.dirname(d.file) === path.dirname(owner.file)) ||
                // A Rust impl block anywhere in the crate whose self type
                // names this definition declares its members (fix #428).
                // A member of a same-name type declared in its own file (a
                // function-local struct) belongs to that type.
                (!!ownerDefinition && langTraits(language)?.itemScopeResolution &&
                    !require('./class-identity').ownerDefinitionOf(index, d) &&
                    !!require('./rust-names').resolveRustName(index, d.file, d.startLine, owner.name, 'type')
                        ?.defs?.includes(ownerDefinition));
        });
        // A super lookup passes over the enclosing class's own members.
        const superLookup = steps.length === 0 && facts.receiverOrigin?.superLookup === true
            ? { skipped: members.map(declarationIdentity) } : null;
        if (superLookup) members = [];
        // Use the AST spelling before the inheritance graph normalizes aliases
        // and qualifiers. A terminal name alone loses its declaring scope.
        const rawOf = part => index.files.get(part.file)?.symbols.find(d =>
            d.name === part.name && d.startLine === part.startLine && d.type === part.type) || part;
        const rawOwner = rawOf(owner);
        const written = [];
        for (const part of partialParts || [owner]) {
            const raw = part === owner ? rawOwner : rawOf(part);
            const arities = raw.extends ? writtenArities(raw.extends) : [];
            (raw.extends ? splitParentList(raw.extends) : []).forEach((name, i) => written.push({ name, part, arity: arities[i] }));
        }
        const derefTarget = language === 'rust' ? rawOwner.derefTarget : null;
        const resolvedParents = [...written, ...(derefTarget ? [{ name: derefTarget, part: owner }] : [])]
            .map(entry => resolveType(entry.name, entry.part.file, entry.part.startLine, undefined, entry.arity));
        const resolvedCount = resolvedParents.filter(Boolean).length;
        // Two parts may name one base: it is one parent.
        const parentKeys = new Set();
        const parents = resolvedParents.filter(Boolean).map(r => r.declaration).filter(parent => {
            const parentKey = identityKey(declarationIdentity(parent));
            if (parentKeys.has(parentKey)) return false;
            parentKeys.add(parentKey);
            return true;
        });
        // The member may be inherited from an external declaration. This
        // collector has no platform-member lookup; report the coverage gap
        // separately from an ambiguous or inconsistent project lookup.
        if (!members.length && resolvedCount < written.length) {
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
                // A base member brought in is chosen by a lookup this
                // witness cannot state yet: report-only (fix #428).
                if (choice?.match && baseMembers.includes(choice.match)) {
                    facts.lookupGap = 'using-declaration-member';
                    return null;
                }
                if (!choice?.match || members.length !== 1 || choice.match !== members[0]) return null;
            }
        }
        const delegation = call.constructorSyntax === 'delegation' && call.receiver === 'super' &&
            steps.length === 0 && facts.receiverOrigin?.source === 'same-class'
            ? { enclosing: facts.receiverOrigin.declaration, members: members.map(declarationIdentity) } : null;
        if (delegation) members = [];
        const step = { owner: identity, members: members.map(declarationIdentity), parents: parents.map(declarationIdentity),
            ...(delegation && { constructorDelegation: delegation }),
            ...(superLookup && { superLookup }),
            ...(extra?.enclosingOf && { enclosingOf: extra.enclosingOf }),
            ...(partialParts && { partialParts: partialParts.map(declarationIdentity) }),
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
            if (!group?.length) {
                const outer = lexicalOuterOf(chain);
                return outer ? walk(outer.definition, chain, { enclosingOf: outer.inner }) : null;
            }
            // One member of the name in the whole chain, a call of exactly its
            // fixed parameter count with no typed argument and no type
            // arguments: overload selection reads nothing (fix #428), the
            // lookup ends at the declaring step.
            if (group.length === 1 && soleMemberFits(call, group[0])) {
                const declaring = chain.findIndex(chainStep => chainStep.members.length > 0);
                if (declaring >= 0 && chain[declaring].members.length === 1) {
                    return { receiver: declarationIdentity(resolved.declaration), steps: chain.slice(0, declaring + 1),
                        selected: declarationIdentity(group[0]) };
                }
            }
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
            const gap = memberChoiceGap(members);
            if (gap) facts.lookupGap = gap;
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
            if (gap) return null;
        }
        const gap = members.length > 1 ? memberChoiceGap(members) : null;
        if (gap) {
            facts.lookupGap = gap;
            return null;
        }
        // A Rust type also takes the methods of traits it implements, a
        // trait's provided methods included: no member of the name among its
        // impls is a lookup this witness cannot finish (report-only, fix #428).
        if (!members.length && !parents.length && langTraits(language)?.itemScopeResolution && !superLookup &&
            ['struct', 'enum', 'union'].includes(owner.type)) {
            facts.lookupGap = 'trait-method-probe';
            return null;
        }
        if (members.length || parents.length !== 1) return null;
        return walk(parents[0], [...steps, step]);
    };
    const lookup = walk(resolved.declaration, []);
    if (lookup) facts.lookup = lookup;
    return facts;
}

module.exports = { confirmationFacts, namedDeclaration, occurrenceIdentity, definitionsInFile, definitionAt, partialTypeParts };
