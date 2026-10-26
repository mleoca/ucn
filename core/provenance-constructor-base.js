'use strict';

const { langTraits, getLanguageAdapter, getParser } = require('../languages');
const { declarationIdentity, sameDeclaration } = require('./provenance');
const { occurrenceIdentity } = require('./provenance-facts');
const { captureTypeLookup, validateTypeLookup } = require('./provenance-type');
const { SourceMemo } = require('./source-memo');

// Omitted-initializer call syntax of a source, by language.
const sourceCalls = new SourceMemo({ maxEntries: 128, maxWeight: 32 * 1024 * 1024,
    weigh: calls => JSON.stringify(calls).length * 2 });

const implicitRecord = call => ({
    name: call.name, qualifier: call.constructorQualifier || null,
    argCount: call.argCount, site: occurrenceIdentity('', call),
    base: JSON.stringify(call.implicitBase), enclosing: enclosingKey(call.enclosingFunction),
    header: call.implicitBase?.header && { ...call.implicitBase.header },
});
// The constructor an implicit call runs in, by name and extent: the
// attribution a whole-file extraction adds (a class name) is not part of it.
const enclosingKey = enclosing => enclosing ? JSON.stringify([enclosing.name, enclosing.startLine, enclosing.endLine]) : null;

// Cache syntax, never a binding verdict. External macro recovery has an
// additional input and consultation side effects, so keep that path fresh.
const reusableSyntax = language => !langTraits(language)?.textualIncludes ||
    !require('../languages/c-family').hasExternalMacroContext();

function implicitSourceCalls(language, source) {
    const reusable = reusableSyntax(language);
    const saved = reusable ? sourceCalls.get(language, source) : undefined;
    if (saved) return saved;
    const calls = getLanguageAdapter(language).findCallsInCode(source, getParser(language))
        .filter(call => call.constructorSyntax === 'implicit').map(implicitRecord);
    if (reusable) sourceCalls.set(language, source, calls);
    return calls;
}

/**
 * The omitted-initializer calls of the class at `base`'s lines (fix #421:
 * the first replay over a large file extracted every call of the file).
 * The adapter reads them from the same trees as a whole-file extraction.
 */
const ownerCalls = new SourceMemo({ maxEntries: 128, maxWeight: 8 * 1024 * 1024,
    weigh: byOwner => JSON.stringify([...byOwner.values()]).length * 2 });
function implicitOwnerSourceCalls(language, source, base) {
    const adapter = getLanguageAdapter(language);
    if (typeof adapter.implicitBaseCallsOf !== 'function' || !Number.isInteger(base?.ownerLine)) return null;
    const reusable = reusableSyntax(language);
    let byOwner = reusable ? ownerCalls.get(language, source) : undefined;
    if (!byOwner) {
        byOwner = new Map();
        if (reusable) ownerCalls.set(language, source, byOwner);
    }
    const key = `${base.ownerLine}:${base.ownerEndLine}`;
    if (!byOwner.has(key)) {
        byOwner.set(key, adapter.implicitBaseCallsOf(source, getParser(language), base.ownerLine, base.ownerEndLine)
            .filter(call => call.constructorSyntax === 'implicit').map(implicitRecord));
    }
    return byOwner.get(key);
}

function headerSite(call, file) {
    const header = call.implicitBase?.header;
    return header && { file, line: header.line, column: header.column,
        start: header.start, end: header.end };
}

function captureImplicitBase(index, file, call, owner) {
    const entry = index.files.get(file), language = entry?.language;
    if (!langTraits(language)?.implicitBaseConstruction || call.constructorSyntax !== 'implicit') return null;
    const header = headerSite(call, entry.relativePath);
    if (!header) return null;
    const binding = captureTypeLookup(index, { file, relativePath: entry.relativePath,
        line: header.line, column: header.column, name: call.name,
        qualifier: call.constructorQualifier || null, arity: call.implicitBase.arity,
        position: call.implicitBase.header, construction: true }, owner);
    if (!binding) return null;
    const proof = { language, source: index._readFile(file), site: occurrenceIdentity(entry.relativePath, call),
        name: call.name, qualifier: call.constructorQualifier || null,
        base: call.implicitBase, enclosing: call.enclosingFunction, binding };
    seedImplicitReplay(index, file, entry, call, proof);
    return proof;
}

// A capture's first replay (fix #421, the #418 rule for other witnesses):
// the live record was extracted from this same content, so the replay's
// re-derivation finds exactly it when the file holds one such record. A
// copied or changed proof is re-derived in full.
const SEEDED_IMPLICIT = new WeakMap();
const proofKey = proof => JSON.stringify([proof.language, proof.name, proof.qualifier, proof.site, proof.base,
    enclosingKey(proof.enclosing)]);

function seedImplicitReplay(index, file, entry, call, proof) {
    if (index.isProvenanceFactIndex || !require('./source-memo').indexedContent(index, file, entry, proof.source)) return;
    const base = JSON.stringify(call.implicitBase), enclosing = enclosingKey(call.enclosingFunction);
    const same = (require('./callers').getCachedCalls(index, file) || []).filter(other =>
        other.constructorSyntax === 'implicit' && other.name === call.name && other.argCount === 0 &&
        (other.constructorQualifier || null) === proof.qualifier &&
        ['line', 'column', 'start', 'end'].every(key => occurrenceIdentity(entry.relativePath, other)[key] === proof.site[key]) &&
        JSON.stringify(other.implicitBase) === base && enclosingKey(other.enclosingFunction) === enclosing);
    if (same.length === 1) SEEDED_IMPLICIT.set(proof, { key: proofKey(proof), source: proof.source,
        header: call.implicitBase.header && { ...call.implicitBase.header } });
}

/** Re-derive the omitted initializer from raw source, then replay its header binding. */
function validateImplicitBase(proof, owner, site) {
    if (!proof || !sameDeclaration(proof.binding?.owner, owner) ||
        typeof proof.source !== 'string' || !langTraits(proof.language)?.implicitBaseConstruction ||
        !site || ['file', 'line', 'column', 'start', 'end'].some(key => proof.site?.[key] !== site[key])) return false;
    try {
        const matching = calls => calls.filter(call => call.name === proof.name &&
            call.qualifier === proof.qualifier && call.argCount === 0 &&
            ['line', 'column', 'start', 'end'].every(key => call.site[key] === site[key]) &&
            call.base === JSON.stringify(proof.base) && call.enclosing === enclosingKey(proof.enclosing));
        const seeded = SEEDED_IMPLICIT.get(proof);
        // The class's own calls decide; a call the whole-file extraction
        // places elsewhere (a macro body) is read the whole-file way.
        let matches = seeded && seeded.source === proof.source && seeded.key === proofKey(proof)
            ? [{ header: seeded.header }]
            : matching(implicitOwnerSourceCalls(proof.language, proof.source, proof.base) || []);
        if (matches.length !== 1) matches = matching(implicitSourceCalls(proof.language, proof.source));
        const header = matches[0]?.header;
        return matches.length === 1 && validateTypeLookup(proof.binding, owner, header && {
            file: site.file, line: header.line, column: header.column, start: header.start, end: header.end,
        });
    } catch (error) { return require('./provenance-overload').refusedProof(error, false); }
}

function implicitBaseBinding(index, file, call, candidates) {
    const config = langTraits(index.files.get(file)?.language)?.implicitBaseConstruction;
    if (!config || !call.implicitBase) return null;
    const found = candidates.map(owner => ({ owner, proof: captureImplicitBase(index, file, call, owner) }))
        .filter(entry => entry.proof);
    if (found.length !== 1) return null;
    const { owner, proof } = found[0];
    return { owner, nonClass: !config.baseKinds.includes(owner.type), provenance: {
        rule: 'implicit-base-binding', rules: ['implicit-base-binding'], facts: {
            language: proof.language, site: proof.site, targets: [declarationIdentity(owner)], implicitBaseBinding: proof,
        },
    } };
}

/** The indexed source body, distinct from the constructor it initializes. */
function implicitSourceDefinition(index, file, call) {
    const base = call.implicitBase, scope = base?.scope;
    if (!base || !scope) return null;
    const { ownConstructors } = require('./constructor-calls');
    const owners = (index.symbols.get(base.owner) || []).filter(def => def.file === file &&
        ['class', 'struct', 'record'].includes(def.type) && def.startLine === base.ownerLine && def.endLine === base.ownerEndLine &&
        (!Object.hasOwn(scope, 'namespace') || (def.namespace || null) === (scope.namespace || null)) &&
        (def.enclosingType || null) === (scope.enclosingType || null) &&
        !!def.anonymousNamespace === !!scope.anonymousNamespace);
    if (owners.length !== 1) return null;
    if (base.generated) return owners[0];
    const members = ownConstructors(index, owners[0]).filter(def => !def.modifiers?.includes('static') &&
        def.startLine === call.enclosingFunction?.startLine && def.endLine === call.enclosingFunction?.endLine &&
        def.params === base.params);
    return members.length === 1 ? members[0] : null;
}

module.exports = { implicitBaseBinding, validateImplicitBase, implicitSourceDefinition };
