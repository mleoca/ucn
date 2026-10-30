'use strict';

const path = require('path');
const { langTraits } = require('../languages');
const { ownerDefinitionOf } = require('./class-identity');
const { declarationIdentity, identityKey, sameDeclaration, validateConfirmation } = require('./provenance');
const { captureOverload, projectFact, refusedProof } = require('./provenance-overload');
const { codeUnitCompare, NON_CALLABLE_TYPES } = require('./shared');

const isConstructor = (def, index) => !def?.modifiers?.includes('destructor') &&
    (def?.type === 'constructor' && !def.modifiers?.includes('static') || !!(def?.className && index && !NON_CALLABLE_TYPES.has(def.type) &&
        langTraits(index.files.get(def.file)?.language)?.constructorProtocol?.initializer === def.name));
const position = site => site.provenance?.facts?.site || site.callSite || site;
const siteKey = site => `${site.file}\0${site.line}\0${position(site).column ?? ''}`;
const sameSite = (call, site) => {
    if (call.line !== site.line) return false;
    const a = { start: call.callStart ?? call.callSite?.start, column: call.column ?? call.callSite?.column };
    const b = position(site);
    if (a.start != null && b.start != null) return a.start === b.start;
    if (b.start != null && a.column == null) return false;
    return a.column == null || b.column == null || a.column === b.column;
};
const order = (a, b) => codeUnitCompare(a.relativePath || a.file, b.relativePath || b.file) ||
    a.line - b.line || (position(a).column ?? 0) - (position(b).column ?? 0);

// Call records of one line, in record order (fix #418: every projected site
// scanned all of its file's records).
function callsOnLine(index, file, line) {
    const calls = index.getCachedCalls(file) || [];
    const memo = index._opMemo?.('constructionCallsByLine', () => new Map());
    let saved = memo?.get(file);
    if (!saved || saved.calls !== calls) {
        const byLine = new Map();
        for (const call of calls) {
            let list = byLine.get(call.line);
            if (!list) byLine.set(call.line, list = []);
            list.push(call);
        }
        saved = { calls, byLine };
        memo?.set(file, saved);
    }
    return saved.byLine.get(line) || [];
}

function ownMembers(index, owner) {
    // One owner-identity scan of the file per class and operation (fix #418:
    // every construction site of a class rescanned its whole file). A
    // witness view records the scan's reads itself.
    const memo = index.isProvenanceFactIndex ? null : index._opMemo?.('constructorOwnMembers', () => new WeakMap());
    const saved = memo?.get(owner);
    const symbols = index.files.get(owner.file)?.symbols || [];
    if (saved && saved.symbols === symbols) return saved.members;
    // The parts of a C# partial type are one type (fix #430): a part
    // without constructors (`partial class JValue` in JValue.Async.cs) has
    // the constructors the other parts declare.
    const parts = require('./provenance-facts').partialTypeParts(index, owner) || [owner];
    const members = parts.flatMap(part => {
        const identity = declarationIdentity(part);
        return (index.files.get(part.file)?.symbols || []).filter(def =>
            sameDeclaration(declarationIdentity(ownerDefinitionOf(index, def)), identity));
    });
    memo?.set(owner, { symbols, members });
    return members;
}

function ownConstructors(index, owner) { return ownMembers(index, owner).filter(def => isConstructor(def, index)); }

// The constructor a type's header declares without a body declaration of
// its own (fix #419): a C# primary constructor, a Java record's implicit
// canonical constructor (parser `primaryParams`). It is a member of the
// constructor family that overload selection can choose, never a target:
// a construction it receives is a class dependency only. Its identity
// spans the type's declaration; the binding id keeps it apart from a
// declared constructor on the same lines.
const HEADER_CONSTRUCTORS = new WeakMap();
function headerConstructor(owner, declared) {
    if (!Array.isArray(owner?.primaryParams) || !declared?.length) return null;
    const saved = HEADER_CONSTRUCTORS.get(owner);
    if (saved && saved.params === owner.primaryParams && saved.sibling === declared[0]) return saved.definition;
    const sibling = declared[0];
    const definition = {
        name: owner.name, type: 'constructor', className: owner.name, file: owner.file,
        relativePath: owner.relativePath, startLine: owner.startLine, endLine: owner.endLine,
        ...(sibling.namespace && { namespace: sibling.namespace }),
        ...(sibling.enclosingType && { enclosingType: sibling.enclosingType }),
        ...(sibling.lexicalScopeStartLine && { lexicalScopeStartLine: sibling.lexicalScopeStartLine,
            lexicalScopeEndLine: sibling.lexicalScopeEndLine }),
        params: owner.primaryParams.map(param => [param.type, param.name].filter(Boolean).join(' ')).join(', '),
        paramsStructured: owner.primaryParams,
        modifiers: (owner.modifiers || []).filter(modifier => ACCESS_MODIFIERS.has(modifier)),
        isConstructor: true, headerConstructor: true,
        bindingId: `${owner.relativePath}:constructor:${owner.startLine}:header`,
    };
    HEADER_CONSTRUCTORS.set(owner, { params: owner.primaryParams, sibling, definition });
    return definition;
}
const ACCESS_MODIFIERS = new Set(['public', 'protected', 'private', 'internal']);

// The constructor a `this(...)` delegation runs in: the declared
// constructor of the owner whose source extent holds the site. A
// constructor never delegates to itself (Java JLS 8.8.7, C# CS0516, C++
// [class.base.init]), so it leaves the candidate family (fix #419). A site
// in an out-of-class definition runs in the declaration it defines (fix
// #421): `{ member, definition }` names both.
function delegatingConstructor(index, owner, declared, call, file) {
    const start = call.callStart ?? call.callSite?.start;
    const sameFile = def => !file || def.file === file;
    const holding = declared.filter(def => sameFile(def) && (Number.isFinite(start) && def.sourceSpan
        ? def.sourceSpan.start <= start && start < def.sourceSpan.end
        : def.startLine === call.enclosingFunction?.startLine && def.endLine === call.enclosingFunction?.endLine));
    if (holding.length === 1) return { member: holding[0] };
    if (holding.length || !file) return null;
    const { enclosingDefinition, declarationOf } = require('./out-of-class-members');
    const definition = enclosingDefinition(index, file, call, owner);
    const member = definition && declarationOf(index, definition);
    return member && declared.includes(member) ? { member, definition } : null;
}

// These spellings only select candidates. Every site must replay the
// language's value/type binding before it can reach a class definition.
function constructionAliases(index) {
    const build = () => {
        const aliases = new Map();
        const add = (name, target) => {
            if (!name || !target) return;
            let plain = '', depth = 0;
            for (const char of target) {
                if (char === '<') depth++;
                else if (char === '>') depth--;
                else if (depth === 0) plain += char;
            }
            const terminal = plain.split('::').pop().split('.').pop().trim();
            if (!aliases.has(name)) aliases.set(name, new Set());
            aliases.get(name).add(terminal);
        };
        for (const [, entry] of index.files) {
            for (const alias of entry.moduleValueAliases || []) {
                add(alias.name, alias.target);
                for (const alternative of alias.alternatives || []) add(alias.name, alternative.target || alternative.imported);
            }
            for (const def of entry.symbols || []) if (def.type === 'type') add(def.name, def.aliasOf);
            for (const binding of entry.importBindings || []) {
                if (binding.kind === 'using' && !binding.alias) add(binding.name, binding.module);
                else if (binding.alias) add(binding.alias, binding.name);
            }
        }
        return aliases;
    };
    return !index.isProvenanceFactIndex && index._opMemo?.('constructionAliases', build) || build();
}

// The type names a spelling can reach through the alias dictionary. A
// witness records this closure as one fact rather than every file the
// dictionary scans (fix #418: a scan per witness was quadratic).
function constructionTypeNames(index, name) {
    const aliases = constructionAliases(index);
    const names = new Set([name]);
    for (let round = 0; round < 12; round++) {
        const size = names.size;
        for (const current of [...names]) for (const target of aliases.get(current) || []) names.add(target);
        if (size === names.size) break;
    }
    return [...names];
}

// Every spelling whose alias closure (`constructionTypeNames`) holds one of
// `typeNames`: the closure read backwards, to the same depth.
function constructionSpellingsReaching(index, typeNames) {
    const aliases = constructionAliases(index);
    const reverse = new Map();
    for (const [spelling, targets] of aliases) {
        for (const target of targets) {
            if (!reverse.has(target)) reverse.set(target, []);
            reverse.get(target).push(spelling);
        }
    }
    const reached = new Set(typeNames);
    let frontier = [...reached];
    for (let round = 0; round < 12 && frontier.length; round++) {
        const next = [];
        for (const current of frontier) {
            for (const spelling of reverse.get(current) || []) {
                if (!reached.has(spelling)) { reached.add(spelling); next.push(spelling); }
            }
        }
        frontier = next;
    }
    return reached;
}

function constructionTypeCandidates(index, name) {
    return projectFact(index, `construction-type-names:${name}`, live => constructionTypeNames(live, name))
        .flatMap(current => index.symbols.get(current) || [])
        .filter(def => ['class', 'struct', 'record', 'enum', 'interface'].includes(def.type));
}

function constructionAliasNames(index, targets) {
    const names = new Set(targets.filter(def => ['class', 'struct', 'record', 'enum'].includes(def.type) &&
        langTraits(index.files.get(def.file)?.language)?.hasConstructors).map(def => def.name));
    const aliases = constructionAliases(index), surfaces = new Set();
    for (let round = 0; round < 12; round++) {
        let changed = false;
        for (const [name, spelled] of aliases) {
            if (!surfaces.has(name) && [...spelled].some(target => names.has(target))) {
                names.add(name); surfaces.add(name); changed = true;
            }
        }
        if (!changed) break;
    }
    return surfaces;
}

function constructionAliasPossibilities(index, file, call) {
    const language = index.files.get(file)?.language, traits = langTraits(language);
    if (!traits?.hasConstructors || !isConstruction(call, null, language) || call.localShadow ||
        call.isMethod && !call.receiverIsModule && !call.isConstructor && !(call.isPathCall && traits.functionalTypeConstruction) ||
        !constructionAliases(index).has(call.name)) return [];
    const family = traits.nameReferenceFamily || language;
    const candidates = constructionTypeCandidates(index, call.name).filter(def =>
        (langTraits(index.files.get(def.file)?.language)?.nameReferenceFamily || index.files.get(def.file)?.language) === family);
    if (!candidates.length) return [];
    if (traits.functionalTypeConstruction) {
        const { TypeReferenceResolver } = require('./type-references');
        const { resolveQualifier, includeClosure } = require('./cpp-scope');
        const context = new TypeReferenceResolver(index, candidates[0], candidates[0].name).cppSiteContext(file, call.line);
        const qualifier = call.constructorQualifier || call.receiver;
        const found = resolveQualifier(index, { file, line: call.line, ...context },
            qualifier ? `${qualifier}::${call.name}` : call.name, includeClosure(index, file), 0, { declarations: true });
        if (found.kind === 'namespace' || found.kind === 'type' && !found.visible ||
            found.kind === 'unknown' && ['no-declaration', 'not-visible'].includes(found.why)) return [];
    } else if (traits.classesCallableWithoutNew && !valueAliasInScope(index, file, call.name, call.receiver)) return [];
    return candidates;
}

// The project-wide alias dictionary discovers spellings, not bindings. A
// module's own values and imports decide whether this call can use one.
function valueAliasInScope(index, file, name, qualifier, seen = new Set()) {
    const key = `${file}\0${qualifier || ''}\0${name}`;
    if (seen.has(key) || seen.size >= 12) return true;
    const entry = index.files.get(file);
    if (!entry) return true;
    const visited = new Set(seen).add(key);
    if (!qualifier && ((entry.moduleValueAliases || []).some(alias => alias.name === name) ||
        (entry.symbols || []).some(def => def.name === name && !def.className &&
            ['class', 'struct', 'record', 'enum', 'type'].includes(def.type)))) return true;
    const parts = qualifier?.split('.') || [];
    const bound = parts.shift() || name;
    const links = (entry.importBindings || []).filter(binding => (binding.alias || binding.name) === bound);
    if (!links.length) return false;
    return links.some(binding => {
        const relative = entry.moduleResolved?.[`${binding.module}.${binding.name}`] || entry.moduleResolved?.[binding.module];
        if (!relative) return true;
        const target = path.resolve(index.root, relative);
        return valueAliasInScope(index, target, qualifier ? name : binding.name,
            parts.join('.') || null, visited);
    });
}

function constructionAliasBinding(index, file, call, targets) {
    const language = index.files.get(file)?.language;
    // An expansion's argument token can declare a constructor as well as
    // supply a call. Its ordinary source type lookup does not prove which
    // role the expanded record has; retain the expansion's existing path.
    const functional = langTraits(language)?.functionalTypeConstruction && !call.macroExpansion;
    if (!langTraits(language)?.hasConstructors || !isConstruction(call, null, language) || call.localShadow || call.isMethod && !call.receiverIsModule &&
        !call.isConstructor && !(call.isPathCall && langTraits(language)?.functionalTypeConstruction) ||
        !constructionAliases(index).has(call.name) && !call.constructorQualifier && !call.implicitBase &&
        !call.isConstructor && !functional) return null;
    let candidates = targets;
    if (!candidates) {
        candidates = constructionTypeCandidates(index, call.name);
    } else {
        // Only a type the call's spelling can name (its own name, or one an
        // alias of it reaches) can be the construction's class (fix #421: a
        // type query looked every call record of a file up at its site).
        const spelled = projectFact(index, `construction-type-names:${call.name}`, live => constructionTypeNames(live, call.name));
        candidates = candidates.filter(def => spelled.includes(def.name));
    }
    if (!candidates.length) return null;
    if (call.implicitBase) return require('./provenance-constructor-base').implicitBaseBinding(index, file, call, candidates);
    const { occurrenceIdentity } = require('./provenance-facts');
    const site = occurrenceIdentity(index.files.get(file).relativePath, call);
    const query = { file, relativePath: site.file, line: site.line, column: site.column,
        name: call.name, qualifier: call.constructorQualifier || call.receiver || null, localShadow: !!call.localShadow,
        construction: true, functional: !call.isConstructor && !!langTraits(language)?.functionalTypeConstruction };
    if (langTraits(language)?.functionalTypeConstruction) {
        try {
            // The witness replays this same lookup. Other owner identities
            // cannot satisfy it and need no separate capture attempt.
            const bound = require('./provenance-type').cppConstructionClasses(index, query);
            candidates = candidates.filter(owner => bound.length > 0 && bound.every(def =>
                sameDeclaration(declarationIdentity(def), declarationIdentity(owner))));
        } catch (error) {
            // A refused optional lookup leaves the ordinary proof attempts.
            refusedProof(error);
        }
    }
    const family = langTraits(language)?.nameReferenceFamily || language;
    const found = candidates.filter(def => ['class', 'struct', 'record', 'enum'].includes(def.type) &&
        (langTraits(index.files.get(def.file)?.language)?.nameReferenceFamily || index.files.get(def.file)?.language) === family).map(owner => ({
        owner, witness: require('./provenance-type').captureTypeLookup(index, query, owner),
    })).filter(entry => entry.witness);
    if (found.length !== 1) return null;
    const { owner, witness } = found[0];
    const facts = { language, site, targets: [declarationIdentity(owner)], constructionBinding: witness };
    return { owner, provenance: { rule: 'construction-type', rules: ['construction-type'], facts } };
}

const OWN_CLASS_KINDS = new Set(['class', 'struct', 'record']);
const namedAt = (def, line) => def.nameLine === line || def.startLine === line;

/**
 * The class a construction through a method's own receiver builds (fix
 * #434): `cls(..)` in a Python classmethod, `type(self)(..)`,
 * `self.__class__(..)`, JS `new this(..)` in a static method and `new
 * this.constructor(..)`. The site builds the method's class, or a subclass
 * of it when the method runs through one; the witness replays the method's
 * class from the recorded declarations.
 */
function ownClassBinding(index, file, call) {
    const own = call.ownClass;
    const entry = index.files.get(file);
    if (!own || !entry || !langTraits(entry.language)?.ownClassMethod) return null;
    const owner = (entry.symbols || []).find(def => def.name === own.name && OWN_CLASS_KINDS.has(def.type) &&
        namedAt(def, own.line));
    if (!owner) return null;
    const { occurrenceIdentity } = require('./provenance-facts');
    const site = occurrenceIdentity(entry.relativePath, call);
    const witness = require('./provenance-type').captureTypeLookup(index, { file, relativePath: site.file,
        line: site.line, column: site.column, name: call.name, ownClass: own, construction: true }, owner);
    if (!witness) return null;
    return { owner, provenance: { rule: 'construction-type', rules: ['construction-type'],
        facts: { language: entry.language, site, targets: [declarationIdentity(owner)], constructionBinding: witness } } };
}

// Ancestors of the owners by resolved base identity, same name family, in
// breadth-first order (fix #434).
function resolvedAncestors(index, owners) {
    const { classDefsNamed, parentRefsOf } = require('./class-identity');
    const keyOf = def => classDefsNamed(index, def.name).entries.find(entry => entry.def === def)?.key || null;
    const seen = new Set(owners.map(def => identityKey(declarationIdentity(def))));
    const out = [];
    const queue = owners.map(def => ({ name: def.name, key: keyOf(def), def }));
    while (queue.length && out.length < 64) {
        const ref = queue.shift();
        if (!ref.key) continue;
        for (const parent of parentRefsOf(index, ref)) {
            if (parent.external || !parent.key) continue;
            const def = classDefsNamed(index, parent.name).entries.find(entry => entry.key === parent.key)?.def;
            if (!def || nameFamily(index, def) !== nameFamily(index, ref.def)) continue;
            const id = identityKey(declarationIdentity(def));
            if (seen.has(id)) continue;
            seen.add(id);
            out.push(def);
            queue.push({ name: def.name, key: parent.key, def });
        }
    }
    return out;
}

function isConstruction(call, site, language) {
    return !site?.isFunctionReference && !site?.isTypeReference && !call.isFunctionReference &&
        !call.isPotentialCallback && !call.isTypeReference && (call.isConstructor ||
            langTraits(language)?.classesCallableWithoutNew || langTraits(language)?.functionalTypeConstruction);
}

function constructionTypeParameter(index, file, call) {
    const language = index.files.get(file)?.language;
    if (!langTraits(language)?.hasConstructors || langTraits(language)?.typeSystem !== 'nominal' ||
        !isConstruction(call, null, language) || ['implicit', 'delegation', 'enum'].includes(call.constructorSyntax)) return false;
    if (!call.isConstructor && !constructionTypeCandidates(index, call.name).length) return false;
    const site = require('./provenance-facts').occurrenceIdentity(index.files.get(file).relativePath, call);
    return require('./provenance-type').constructionNameScope(index, { file, line: site.line, column: site.column,
        name: call.name, qualifier: call.constructorQualifier || call.receiver || null }) === false;
}

function protocolFacts(index, owner) {
    const memo = index._opMemo?.('constructorProtocolFacts', () => new WeakMap());
    if (memo?.has(owner)) return memo.get(owner);
    const facts = require('./constructor-protocol').collectConstructorProtocol(index, owner);
    memo?.set(owner, facts);
    return facts;
}

// The construction's target-independent evidence: the constructor family,
// its overload witness and the site's type and name-scope witnesses. A
// query over several constructors of one class reads each site once per
// operation (fix #418); every witness is replayed against each target set.
function constructionEvidence(index, owner, call, classBinding) {
    const memo = classBinding && typeof classBinding === 'object' && call && typeof call === 'object' &&
        !index.isProvenanceFactIndex ? index._opMemo?.('constructionEvidence', () => new WeakMap()) : null;
    let byCall = memo?.get(classBinding);
    if (memo && !byCall) memo.set(classBinding, byCall = new WeakMap());
    let byOwner = byCall?.get(call);
    if (byCall && !byOwner) byCall.set(call, byOwner = new Map());
    const key = byOwner ? identityKey(declarationIdentity(owner)) : null;
    if (key !== null && byOwner.has(key)) return byOwner.get(key);
    const evidence = constructionEvidenceUncached(index, owner, call, classBinding);
    if (key !== null) byOwner.set(key, evidence);
    return evidence;
}

function constructionEvidenceUncached(index, owner, call, classBinding) {
    let members = ownConstructors(index, owner), declaring = owner, hierarchy = null, delegating = null,
        delegatingDefinition = null;
    if (!members.length) {
        const inherited = require('./constructor-hierarchy').captureHierarchy(index, owner);
        if (!inherited) return { unresolved: true };
        if (inherited.none) {
            // No class of the order declares a constructor. Only an
            // allocation protocol the language checks can still run project
            // code; a construction then depends on its class alone.
            const language = index.files.get(owner.file).language;
            const wrapped = langTraits(language)?.decoratorsWrapCallables && owner.decorators?.length;
            const protocol = langTraits(language)?.constructorProtocol;
            const plain = !wrapped && (!protocol || require('./constructor-protocol').validateConstructorProtocol(
                protocolFacts(index, owner), declarationIdentity(owner), [], language));
            return plain ? { noBody: true } : { unresolved: true };
        }
        members = inherited.members; declaring = inherited.declaring; hierarchy = inherited.witness;
    } else {
        const header = headerConstructor(owner, members);
        if (call.ctorDelegation === 'this') {
            // A same-type delegation runs in one of the owner's own
            // constructors; any other enclosing scope means the site does
            // not belong to this owner's family.
            const siteFile = classBinding?.facts?.site?.file;
            const found = delegatingConstructor(index, owner, members, call,
                siteFile ? path.resolve(index.root, siteFile) : null);
            if (!found) return { unresolved: true, delegation: true };
            delegating = found.member;
            delegatingDefinition = found.definition || null;
            members = members.filter(def => def !== delegating);
        }
        if (header) members = [...members, header];
        if (!members.length) return { unresolved: true, delegation: true, delegating, delegatingDefinition };
    }
    const language = index.files.get(owner.file).language;
    const protocol = protocolFacts(index, owner);
    const { selectProvenanceOverload } = require('./callers');
    const overloadCall = langTraits(language)?.inheritedOverloadSignatures
        ? { ...call, argumentFile: classBinding?.facts?.site?.file } : call;
    const overload = captureOverload(index, overloadCall, members, language, selectProvenanceOverload);
    const selected = overload?.selected;
    const fallback = !selected && members.length === 1 ? declarationIdentity(members[0]) : null;
    const chosen = selected || fallback;
    const site = classBinding?.facts?.site;
    const functional = !call.isConstructor && langTraits(language)?.functionalTypeConstruction;
    const nameScope = langTraits(language)?.typeSystem === 'nominal' &&
        !['implicit', 'delegation', 'enum'].includes(call.constructorSyntax) && site
        ? require('./provenance-type').captureTypeLookup(index, {
            file: path.resolve(index.root, site.file), relativePath: site.file,
            line: site.line, column: site.column, name: call.name,
            qualifier: call.constructorQualifier || call.receiver || null, nameScopeOnly: true,
        }, owner) : null;
    const typeLookup = call.ownClass && site
        ? require('./provenance-type').captureTypeLookup(index, {
            file: path.resolve(index.root, site.file), relativePath: site.file,
            line: site.line, column: site.column, name: call.name, ownClass: call.ownClass, construction: true,
        }, owner)
        : (call.isConstructor || functional || langTraits(language)?.classesCallableWithoutNew) && site &&
        (functional || langTraits(language)?.typeSystem === 'structural' ||
            validateConfirmation(classBinding, declarationIdentity(owner)).verdict !== 'establishes-target')
        ? require('./provenance-type').captureTypeLookup(index, {
            file: path.resolve(index.root, site.file), relativePath: site.file,
            line: site.line, column: site.column, name: call.name,
            qualifier: call.constructorQualifier || call.receiver || null, functional: !!functional, construction: true,
            localShadow: !!call.localShadow,
        }, owner) : null;
    return { members, declaring, hierarchy, delegating, delegatingDefinition, language, protocol, overload, selected,
        chosen, nameScope, typeLookup };
}

// The out-of-class definition a delegation runs in and the signature it
// shares with its in-class declaration (fix #421): the replay checks that
// the site lies in that definition and that the two declare one constructor.
function delegatingDefinitionFacts(evidence) {
    const { _cFamilySignatureKey } = require('./callers');
    return { delegatingDefinition: { ...declarationIdentity(evidence.delegatingDefinition),
        signature: _cFamilySignatureKey(evidence.delegatingDefinition) },
    delegatingSignature: _cFamilySignatureKey(evidence.delegating) };
}

function constructionChoice(index, owner, call, classBinding, targets) {
    const evidence = constructionEvidence(index, owner, call, classBinding);
    if (evidence.noBody) return { noBody: true };
    if (evidence.unresolved) {
        const facts = { language: index.files.get(owner.file)?.language, site: classBinding?.facts?.site,
            targets: (targets || []).map(declarationIdentity) };
        // The delegating constructor is never its own delegation's target,
        // even when no other member of the family remains (fix #419).
        if (evidence.delegating) {
            const parts = require('./provenance-facts').partialTypeParts(index, owner);
            facts.constructorCall = { owner: declarationIdentity(owner), members: [],
                ...(parts && { parts: parts.map(declarationIdentity) }),
                delegating: declarationIdentity(evidence.delegating),
                ...(evidence.delegatingDefinition && delegatingDefinitionFacts(evidence)), classBinding,
                call: { isConstructor: !!call.isConstructor, syntax: call.constructorSyntax || null, delegation: 'this' } };
            const provenance = { rule: 'constructor-call', rules: ['constructor-call'], facts };
            if (targets && validateConfirmation(provenance, targets.map(declarationIdentity)).verdict === 'establishes-other') {
                return { other: true, reason: 'constructor-delegation-self', provenance };
            }
        }
        return { reason: evidence.delegation ? 'constructor-delegation-unresolved' : 'constructor-inheritance-unresolved',
            provenance: { rule: 'constructor-call', rules: ['constructor-call'], facts } };
    }
    const { members, declaring, hierarchy, delegating, delegatingDefinition, language, protocol, overload, selected, chosen,
        nameScope, typeLookup } = evidence;
    targets ||= members;
    const parts = require('./provenance-facts').partialTypeParts(index, declaring);
    const facts = { language, site: classBinding?.facts?.site, targets: targets.map(declarationIdentity),
        constructorCall: { owner: declarationIdentity(declaring), members: members.map(declarationIdentity),
            ...(parts && { parts: parts.map(declarationIdentity) }),
            ...(hierarchy && { constructedOwner: declarationIdentity(owner), hierarchy }),
            ...(delegating && { delegating: declarationIdentity(delegating) }),
            ...(delegatingDefinition && delegatingDefinitionFacts(evidence)),
            classBinding, call: { isConstructor: !!call.isConstructor,
                isFunctionReference: !!call.isFunctionReference, isPotentialCallback: !!call.isPotentialCallback,
                syntax: call.constructorSyntax || null, ...(delegating && { delegation: 'this' }) },
            selected: chosen, overload, protocol, typeLookup, nameScope } };
    const provenance = { rule: 'constructor-call', rules: ['constructor-call'], facts };
    let checked = chosen && validateConfirmation(provenance, targets.map(declarationIdentity));
    if (!chosen && delegating) {
        const self = validateConfirmation(provenance, targets.map(declarationIdentity));
        if (self.diagnostic === 'constructor-delegation-self') checked = self;
    }
    if (checked?.verdict === 'establishes-other') {
        return { other: true, ...(checked.diagnostic === 'constructor-delegation-self' && { reason: checked.diagnostic }), provenance };
    }
    const wrappedClass = langTraits(language)?.decoratorsWrapCallables && owner.decorators?.length;
    const reason = checked?.diagnostic === 'constructor-default-unresolved' ? 'constructor-default-unresolved'
        : checked?.diagnostic === 'unproven-construction-name-scope' ? 'constructor-name-scope-unresolved'
        : wrappedClass || checked?.diagnostic === 'constructor-protocol-unresolved' ? 'constructor-protocol-unresolved'
        : checked?.diagnostic === 'constructor-definition-ambiguous' ? 'constructor-definition-ambiguous'
            : checked?.diagnostic === 'constructor-functional-binding' ? 'constructor-functional-binding'
        : overload?.outcome === 'no-fit' ? 'constructor-overload-no-fit'
            : overload?.outcome === 'ambiguous' ? 'constructor-overload-ambiguous'
                : checked?.verdict !== 'establishes-target' ? 'constructor-proof-incomplete' : null;
    provenance.validation = checked?.verdict || 'incomplete';
    if (checked?.diagnostic) provenance.diagnostic = checked.diagnostic;
    // An undecided overload choice whose arguments no pinned constructor
    // can take by count runs another constructor (fix #430: a one-argument
    // `new JValue(x)` never runs `JValue(object?, JTokenType)`).
    // A C++ braced list may run an initializer-list constructor whatever its
    // element count, so only parenthesized and `new T(..)` arguments count.
    if (reason === 'constructor-overload-ambiguous' && langTraits(language)?.hasArityOverloads &&
        call.constructorSyntax !== 'list' && !langTraits(language)?.packExpansionArguments &&
        Number.isInteger(call.argCount) && !call.argSpread && targets.length > 0 &&
        targets.every(target => isConstructor(target, index) && !target.headerConstructor &&
            !require('./callers')._callArityCompatible(call, [target], language))) {
        return { other: true, reason: 'constructor-overload-other', provenance };
    }
    return { members, definition: selected && members.find(def => sameDeclaration(selected, declarationIdentity(def))),
        provenance, reason };
}

// Syntax whose site runs a constructor body without constructing the class
// at a source spelling of its own: a delegation (`this(..)`, `super(..)`,
// a mem-initializer), an omitted base initializer, an enum constant.
const BODY_ONLY_SYNTAX = new Set(['delegation', 'implicit', 'enum']);

const groupOrder = (a, b) => codeUnitCompare(a.definition.relativePath, b.definition.relativePath) ||
    a.definition.startLine - b.definition.startLine ||
    (a.definition.sourceSpan?.start ?? Infinity) - (b.definition.sourceSpan?.start ?? Infinity) ||
    codeUnitCompare(identityKey(declarationIdentity(a.definition)), identityKey(declarationIdentity(b.definition)));

/**
 * The constructor bodies a class callee's sites run (fix #421). A
 * construction (`new C(..)`, `C(..)`) stays a dependency on the class,
 * certain whenever its class binding is: its proven constructor joins as an
 * initializer edge (`initializers`), and an undecided one is a review of the
 * class edge (`initializerReviews`), never a demotion of it. A delegation,
 * an omitted base initializer or an enum constant runs a constructor body
 * only: its sites leave the class edge (`groups`, `unverified`).
 */
function projectConstructorCalleeSites(index, owner, siteIds, readSite) {
    if (!siteIds?.length || !ownConstructors(index, owner).length &&
        !langTraits(index.files.get(owner.file)?.language)?.constructorInheritance) return null;
    const language = index.files.get(owner.file)?.language;
    const remaining = [], unverified = [], groups = new Map(), initializers = new Map(), initializerReviews = [];
    for (const siteId of siteIds) {
        const { call, site } = readSite(siteId);
        if (!isConstruction(call, site, language)) { remaining.push(siteId); continue; }
        const bodyOnly = BODY_ONLY_SYNTAX.has(call.constructorSyntax);
        if (!bodyOnly) remaining.push(siteId);
        const choice = constructionChoice(index, owner, call, site.provenance);
        // The type header's own constructor has no declaration (fix #419),
        // and a class whose whole order declares none runs no project body
        // (fix #421): a construction remains a dependency on the class.
        if (choice.noBody && !bodyOnly) continue;
        if (!choice.reason && choice.definition?.headerConstructor) {
            if (bodyOnly) remaining.push(siteId);
            continue;
        }
        if (choice.reason || !choice.definition) {
            const reason = choice.reason || 'constructor-proof-incomplete';
            if (!bodyOnly) {
                initializerReviews.push({ siteId, call, reason, provenance: choice.provenance });
                continue;
            }
            // A Python class call still depends on its proven class binding
            // when its allocator/decorator protocol cannot select a body.
            // The constructor-handle query retains that uncertainty.
            if (['constructor-protocol-unresolved', 'constructor-inheritance-unresolved'].includes(choice.reason) &&
                validateConfirmation(site.provenance, declarationIdentity(owner)).verdict === 'establishes-target') {
                remaining.push(siteId);
                continue;
            }
            unverified.push({ siteId, call, reason, provenance: choice.provenance });
            continue;
        }
        // The edge names the definition holding the selected constructor's
        // body (an in-class declaration's out-of-class definition, fix
        // #421); its proof establishes the declaration.
        const definition = require('./out-of-class-members').bodyDefinitionOf(index, choice.definition) || choice.definition;
        const key = identityKey(declarationIdentity(definition));
        const target = bodyOnly ? groups : initializers;
        if (!target.has(key)) target.set(key, { definition, sites: [] });
        target.get(key).sites.push({ ...site, targetDef: declarationIdentity(choice.definition),
            provenance: choice.provenance, tier: 'confirmed' });
    }
    if (remaining.length === siteIds.length && !initializers.size && !initializerReviews.length) return null;
    return { remaining, unverified, groups: [...groups.values()].sort(groupOrder),
        initializers: [...initializers.values()].sort(groupOrder), initializerReviews };
}

// A class's construction sites, read once per operation for every
// constructor of the class a query projects (fix #418). Options carrying a
// profile, statistics or a callback keep their own read.
function classConstructionCalls(index, owner, options) {
    const read = () => index.findCallers(owner.name, { ...options, profile: undefined,
        constructorProjectionSource: true, targetDefinitions: [owner], collectAccount: true,
        includeMethods: true, needsTotal: true });
    if (options.profile || options.stats) return read();
    const memo = index._opMemo?.('classConstructionCalls', () => new Map());
    if (!memo) return read();
    // An option that is not plain data (the candidate-file Set of a HOT
    // ranking) is keyed by its identity within the operation; a function
    // keeps its own read (fix #435: the key threw for a Set, so every
    // constructor of a ranking re-read its class).
    const identities = index._opMemo('classConstructionOptionIds', () => ({ ids: new WeakMap(), next: 0 }));
    let unkeyed = false;
    const key = identityKey(declarationIdentity(owner)) + '\0' + JSON.stringify(Object.keys(options).sort()
        .filter(name => name !== 'targetDefinitions' && name !== 'profile')
        .map(name => [name, options[name]]), (_name, value) => {
            if (typeof value === 'function' || typeof value === 'symbol') {
                unkeyed = true;
                return null;
            }
            if (value && typeof value === 'object' && !Array.isArray(value) &&
                Object.getPrototypeOf(value) !== Object.prototype) {
                if (!identities.ids.has(value)) identities.ids.set(value, `\0object:${identities.next++}`);
                return identities.ids.get(value);
            }
            return value;
        });
    if (unkeyed) return read();
    if (!memo.has(key)) memo.set(key, read());
    return memo.get(key);
}

const nameFamily = (index, def) => {
    const language = index.files.get(def.file)?.language;
    return langTraits(language)?.nameReferenceFamily || language;
};

// Whether a class the inheritance graph lists under `parentName` derives
// from this owner (fix #434). The graph is keyed by the parent's spelling
// only: a class of another language never derives from the owner, and a
// base that resolves to another definition of the name is another class.
// An unresolved base stays a candidate.
function extendsOwner(index, candidate, parentName, owner) {
    if (nameFamily(index, candidate) !== nameFamily(index, owner)) return false;
    const { classDefsNamed, parentRefsOf } = require('./class-identity');
    const ownerKey = classDefsNamed(index, owner.name).entries.find(entry => entry.def === owner)?.key;
    const childKey = classDefsNamed(index, candidate.name).entries.find(entry => entry.def === candidate)?.key;
    if (!ownerKey || !childKey) return true;
    const spelled = parentRefsOf(index, { name: candidate.name, key: childKey, def: candidate })
        .filter(parent => parent.name === parentName);
    // A base naming no class definition (a value alias of the owner) stays
    // a candidate.
    return !spelled.length || spelled.some(parent => !parent.external && (!parent.key || parent.key === ownerKey ||
        classDefsNamed(index, parent.name).entries.every(entry => entry.key !== parent.key)));
}

/** Add class constructions to a constructor's ordinary, explicitly named calls. */
function projectConstructorCallers(index, name, options, result) {
    if (options.constructorProjectionSource || options.constructorProjection === false) return result;
    const targets = options.targetDefinitions || index.symbols.get(name) || [];
    if (!targets.length || !targets.every(def => isConstructor(def, index))) return result;
    const owners = [];
    for (const target of targets) {
        const owner = ownerDefinitionOf(index, target);
        if (owner && !owners.some(other => sameDeclaration(declarationIdentity(owner), declarationIdentity(other)))) owners.push(owner);
    }
    for (let at = 0; at < owners.length; at++) {
        const owner = owners[at];
        if (!langTraits(index.files.get(owner.file)?.language)?.constructorInheritance) continue;
        const parentNames = [owner.name, ...constructionAliasNames(index, [owner])];
        for (const parentName of parentNames) {
            for (const child of index.extendedByGraph.get(parentName) || []) {
                const name = typeof child === 'string' ? child : child.name;
                for (const candidate of index.symbols.get(name) || []) {
                    if (candidate.type !== 'class' || child.file && candidate.file !== child.file ||
                        owners.some(other => sameDeclaration(declarationIdentity(candidate), declarationIdentity(other))) ||
                        !extendsOwner(index, candidate, parentName, owner)) continue;
                    owners.push(candidate);
                }
            }
        }
    }
    const promoted = [], uncertain = [], excluded = [], replaced = new Set();
    for (const owner of owners) {
        const language = index.files.get(owner.file).language;
        const classCalls = classConstructionCalls(index, owner, options);
        const rows = [...classCalls, ...(classCalls.shadowEntries || []), ...(classCalls.unverifiedEntries || [])];
        for (const site of rows) {
            let records = callsOnLine(index, site.file, site.line).filter(call => sameSite(call, site));
            if (records.length > 1 && records.some(call => call.implicitBase)) records = records.filter(call => call.implicitBase &&
                call.name === (site.calledAs || owner.name) && constructionAliasBinding(index, site.file, call, [owner]));
            // `type(self)(..)` starts where its inner `type(self)` call does.
            if (records.length > 1 && site.ownClassConstruction) records = records.filter(call => call.ownClass);
            if (records.length !== 1) continue;
            let call = records[0];
            if (!isConstruction(call, site, language)) continue;
            // A target-typed `new(..)` whose slot (an argument, a member it
            // is assigned to) is resolved at query time carries no type name
            // in its record: the class binding named it (fix #426).
            if (call.targetTyped && call.targetSlot) {
                call = { ...call, name: site.calledAs || owner.name };
            }
            replaced.add(siteKey(site));
            const choice = constructionChoice(index, owner, call, site.provenance, targets);
            // No project constructor body runs here, so none of the targets.
            if (choice.noBody) continue;
            if (choice.other) {
                excluded.push({ file: site.file, line: site.line, reason: choice.reason || 'constructor-overload-other',
                    provenance: choice.provenance });
                continue;
            }
            const reason = site.tier === 'unverified' ? site.reason || 'constructor-owner-unresolved' : choice.reason;
            const row = { ...site, calledAs: site.calledAs || owner.name,
                ...(call.implicitBase && { implicitConstruction: true }),
                provenance: choice.provenance, ...(reason ? { tier: 'unverified', reason } : { tier: 'confirmed' }) };
            (reason ? uncertain : promoted).push(row);
        }
    }
    // A construction through an ancestor method's own receiver (`cls(..)`,
    // `type(self)(..)`, `new this(..)`) builds the class the method runs
    // through: possibly an owner below that ancestor (fix #434).
    if (options.collectAccount && owners.some(owner => langTraits(index.files.get(owner.file)?.language)?.ownClassMethod)) {
        for (const ancestor of resolvedAncestors(index, owners)) {
            const entry = index.files.get(ancestor.file);
            for (const call of index.getCachedCalls(ancestor.file) || []) {
                if (call.ownClass?.name !== ancestor.name || !namedAt(ancestor, call.ownClass.line)) continue;
                const binding = ownClassBinding(index, ancestor.file, call);
                if (!binding || !sameDeclaration(declarationIdentity(binding.owner), declarationIdentity(ancestor))) continue;
                const caller = index.findEnclosingFunction(ancestor.file, call.line, true, call);
                uncertain.push({ file: ancestor.file, relativePath: entry.relativePath, line: call.line,
                    ...(Number.isInteger(call.callSite?.column) && { column: call.callSite.column }),
                    content: index._getFileLines(ancestor.file)?.[call.line - 1] ?? '',
                    callerName: caller?.name || null, callerFile: caller ? ancestor.file : null,
                    callerStartLine: caller?.startLine ?? null, callerEndLine: caller?.endLine ?? null,
                    isMethod: false, calledAs: call.ownClass.spelling, ownClassConstruction: true,
                    provenance: binding.provenance, tier: 'unverified', reason: 'possible-dispatch' });
            }
        }
    }
    const confirmed = [];
    for (const site of [...result, ...(result.shadowEntries || [])].filter(site => !replaced.has(siteKey(site)))) {
        const language = index.files.get(site.file)?.language;
        const initializer = langTraits(language)?.constructorProtocol?.initializer;
        const records = callsOnLine(index, site.file, site.line).filter(call => sameSite(call, site));
        if (targets.every(target => target.name === initializer) ||
            records.length === 1 && (records[0].isConstructor || records[0].constructorSyntax === 'delegation') &&
                validateConfirmation(site.provenance, targets.map(declarationIdentity)).verdict === 'establishes-target') {
            confirmed.push(site);
        } else {
            uncertain.push({ ...site, tier: 'unverified', reason: 'constructor-call-unproven' });
        }
    }
    const unverified = (result.unverifiedEntries || []).filter(site => !replaced.has(siteKey(site)));
    const unique = rows => [...new Map(rows.map(row => [siteKey(row), row])).values()].sort(order);
    const all = unique([...confirmed, ...promoted]);
    const limit = options.maxResults || Infinity;
    // A row read beyond the enrichment limit carries no line text; one that
    // moves into the visible slice is enriched like the others (fix #421).
    const visible = all.slice(0, limit).map(row => row.content != null ? row : {
        ...row, content: index._getFileLines(row.file)?.[row.line - 1] ?? '' });
    result.splice(0, result.length, ...visible);
    result.shadowEntries = all.slice(limit);
    result.totalCount = all.length;
    if (options.collectAccount) {
        result.unverifiedEntries = unique([...unverified, ...uncertain]);
        const replacedLines = new Set([...promoted, ...uncertain].map(site => `${site.file}\0${site.line}`));
        result.accountRaw.excludedEntries = [
            ...result.accountRaw.excludedEntries.filter(site => !replacedLines.has(`${site.file}\0${site.line}`)), ...excluded,
        ];
        result.accountRaw.unverifiedLines = result.accountRaw.unverifiedLines.filter(site =>
            !replacedLines.has(`${site.file}\0${site.line}`));
    }
    return result;
}

module.exports = { isConstructor, ownConstructors, isConstruction, constructionChoice, constructionTypeParameter,
    projectConstructorCallers, projectConstructorCalleeSites, constructionAliasNames, constructionAliasBinding, ownClassBinding,
    constructionTypeCandidates, constructionTypeNames, constructionSpellingsReaching, constructionAliasPossibilities, ownMembers };
