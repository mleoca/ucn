'use strict';

const path = require('path');
const { langTraits } = require('../languages');
const { ownerDefinitionOf } = require('./class-identity');
const { declarationIdentity, identityKey, sameDeclaration, validateConfirmation } = require('./provenance');
const { captureOverload, projectFact } = require('./provenance-overload');
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
    const identity = declarationIdentity(owner);
    const members = symbols.filter(def => sameDeclaration(declarationIdentity(ownerDefinitionOf(index, def)), identity));
    memo?.set(owner, { symbols, members });
    return members;
}

function ownConstructors(index, owner) { return ownMembers(index, owner).filter(def => isConstructor(def, index)); }

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
    }
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
        } catch {
            // A failed optional lookup leaves the ordinary proof attempts.
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
    let members = ownConstructors(index, owner), declaring = owner, hierarchy = null;
    if (!members.length) {
        const inherited = require('./constructor-hierarchy').captureHierarchy(index, owner);
        if (!inherited) return { unresolved: true };
        members = inherited.members; declaring = inherited.declaring; hierarchy = inherited.witness;
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
    const typeLookup = (call.isConstructor || functional || langTraits(language)?.classesCallableWithoutNew) && site &&
        (functional || langTraits(language)?.typeSystem === 'structural' ||
            validateConfirmation(classBinding, declarationIdentity(owner)).verdict !== 'establishes-target')
        ? require('./provenance-type').captureTypeLookup(index, {
            file: path.resolve(index.root, site.file), relativePath: site.file,
            line: site.line, column: site.column, name: call.name,
            qualifier: call.constructorQualifier || call.receiver || null, functional: !!functional, construction: true,
            localShadow: !!call.localShadow,
        }, owner) : null;
    return { members, declaring, hierarchy, language, protocol, overload, selected, chosen, nameScope, typeLookup };
}

function constructionChoice(index, owner, call, classBinding, targets) {
    const evidence = constructionEvidence(index, owner, call, classBinding);
    if (evidence.unresolved) {
        return { reason: 'constructor-inheritance-unresolved', provenance: {
            rule: 'constructor-call', rules: ['constructor-call'], facts: {
                language: index.files.get(owner.file)?.language, site: classBinding?.facts?.site,
                targets: (targets || []).map(declarationIdentity),
            } } };
    }
    const { members, declaring, hierarchy, language, protocol, overload, selected, chosen, nameScope, typeLookup } = evidence;
    targets ||= members;
    const facts = { language, site: classBinding?.facts?.site, targets: targets.map(declarationIdentity),
        constructorCall: { owner: declarationIdentity(declaring), members: members.map(declarationIdentity),
            ...(hierarchy && { constructedOwner: declarationIdentity(owner), hierarchy }),
            classBinding, call: { isConstructor: !!call.isConstructor,
                isFunctionReference: !!call.isFunctionReference, isPotentialCallback: !!call.isPotentialCallback,
                syntax: call.constructorSyntax || null },
            selected: chosen, overload, protocol, typeLookup, nameScope } };
    const provenance = { rule: 'constructor-call', rules: ['constructor-call'], facts };
    const checked = chosen && validateConfirmation(provenance, targets.map(declarationIdentity));
    if (checked?.verdict === 'establishes-other') return { other: true, provenance };
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
    return { members, definition: selected && members.find(def => sameDeclaration(selected, declarationIdentity(def))),
        provenance, reason };
}

function projectConstructorCalleeSites(index, owner, siteIds, readSite) {
    if (!siteIds?.length || !ownConstructors(index, owner).length &&
        !langTraits(index.files.get(owner.file)?.language)?.constructorInheritance) return null;
    const language = index.files.get(owner.file)?.language;
    const remaining = [], unverified = [], groups = new Map();
    for (const siteId of siteIds) {
        const { call, site } = readSite(siteId);
        if (!isConstruction(call, site, language)) { remaining.push(siteId); continue; }
        const choice = constructionChoice(index, owner, call, site.provenance);
        if (choice.reason || !choice.definition) {
            // A Python class call still depends on its proven class binding
            // when its allocator/decorator protocol cannot select a body.
            // The constructor-handle query retains that uncertainty.
            if (['constructor-protocol-unresolved', 'constructor-inheritance-unresolved'].includes(choice.reason) &&
                validateConfirmation(site.provenance, declarationIdentity(owner)).verdict === 'establishes-target') {
                remaining.push(siteId);
                continue;
            }
            unverified.push({ siteId, call, reason: choice.reason || 'constructor-proof-incomplete', provenance: choice.provenance });
            continue;
        }
        const definition = choice.definition;
        const key = identityKey(declarationIdentity(definition));
        if (!groups.has(key)) groups.set(key, { definition, sites: [] });
        groups.get(key).sites.push({ ...site, targetDef: declarationIdentity(definition),
            provenance: choice.provenance, tier: 'confirmed' });
    }
    if (remaining.length === siteIds.length) return null;
    return { remaining, unverified, groups: [...groups.values()].sort((a, b) =>
        codeUnitCompare(a.definition.relativePath, b.definition.relativePath) ||
        a.definition.startLine - b.definition.startLine ||
        (a.definition.sourceSpan?.start ?? Infinity) - (b.definition.sourceSpan?.start ?? Infinity) ||
        codeUnitCompare(identityKey(declarationIdentity(a.definition)), identityKey(declarationIdentity(b.definition)))) };
}

// A class's construction sites, read once per operation for every
// constructor of the class a query projects (fix #418). Options carrying a
// profile, statistics or a callback keep their own read.
function classConstructionCalls(index, owner, options) {
    const read = () => index.findCallers(owner.name, { ...options, profile: undefined,
        constructorProjectionSource: true, targetDefinitions: [owner], collectAccount: true,
        includeMethods: true, needsTotal: true });
    if (options.profile || options.stats) return read();
    let key;
    try {
        key = identityKey(declarationIdentity(owner)) + '\0' + JSON.stringify(Object.keys(options).sort()
            .filter(name => name !== 'targetDefinitions' && name !== 'profile')
            .map(name => [name, options[name]]), (_name, value) => {
                if (typeof value === 'function' || typeof value === 'symbol' || value && typeof value === 'object' &&
                    !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
                    throw new Error('unkeyed option');
                }
                return value;
            });
    } catch { return read(); }
    const memo = index._opMemo?.('classConstructionCalls', () => new Map());
    if (!memo) return read();
    if (!memo.has(key)) memo.set(key, read());
    return memo.get(key);
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
        for (const child of parentNames.flatMap(name => index.extendedByGraph.get(name) || [])) {
            const name = typeof child === 'string' ? child : child.name;
            for (const candidate of index.symbols.get(name) || []) {
                if (candidate.type !== 'class' || child.file && candidate.file !== child.file ||
                    owners.some(other => sameDeclaration(declarationIdentity(candidate), declarationIdentity(other)))) continue;
                owners.push(candidate);
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
            if (records.length !== 1) continue;
            const call = records[0];
            if (!isConstruction(call, site, language)) continue;
            replaced.add(siteKey(site));
            const choice = constructionChoice(index, owner, call, site.provenance, targets);
            if (choice.other) {
                excluded.push({ file: site.file, line: site.line, reason: 'constructor-overload-other', provenance: choice.provenance });
                continue;
            }
            const reason = site.tier === 'unverified' ? site.reason || 'constructor-owner-unresolved' : choice.reason;
            const row = { ...site, calledAs: site.calledAs || owner.name,
                ...(call.implicitBase && { implicitConstruction: true }),
                provenance: choice.provenance, ...(reason ? { tier: 'unverified', reason } : { tier: 'confirmed' }) };
            (reason ? uncertain : promoted).push(row);
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
    result.splice(0, result.length, ...all.slice(0, limit));
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
    projectConstructorCallers, projectConstructorCalleeSites, constructionAliasNames, constructionAliasBinding,
    constructionTypeCandidates, constructionAliasPossibilities, ownMembers };
