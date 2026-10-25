'use strict';

const { langTraits, getLanguageAdapter, getParser } = require('../languages');
const { declarationIdentity, sameDeclaration } = require('./provenance');
const { occurrenceIdentity } = require('./provenance-facts');
const { captureTypeLookup, validateTypeLookup } = require('./provenance-type');

const sourceCalls = new Map();
const SOURCE_CALL_MAX_BYTES = 32 * 1024 * 1024;
const SOURCE_CALL_MAX_ENTRIES = 128;
let sourceCallBytes = 0;

function implicitSourceCalls(language, source) {
    // Cache syntax, never a binding verdict. External macro recovery has an
    // additional input and consultation side effects, so keep that path fresh.
    const reusable = !langTraits(language)?.textualIncludes ||
        !require('../languages/c-family').hasExternalMacroContext();
    const key = `${language}\0${source}`;
    if (reusable && sourceCalls.has(key)) {
        const value = sourceCalls.get(key);
        sourceCalls.delete(key);
        sourceCalls.set(key, value);
        return value.calls;
    }
    const calls = getLanguageAdapter(language).findCallsInCode(source, getParser(language))
        .filter(call => call.constructorSyntax === 'implicit').map(call => ({
            name: call.name, qualifier: call.constructorQualifier || null,
            argCount: call.argCount, site: occurrenceIdentity('', call),
            base: JSON.stringify(call.implicitBase), enclosing: JSON.stringify(call.enclosingFunction),
            header: call.implicitBase?.header && { ...call.implicitBase.header },
        }));
    if (reusable) {
        const bytes = key.length * 2 + JSON.stringify(calls).length * 2;
        if (bytes <= SOURCE_CALL_MAX_BYTES) {
            while (sourceCalls.size >= SOURCE_CALL_MAX_ENTRIES || sourceCallBytes + bytes > SOURCE_CALL_MAX_BYTES) {
                const oldest = sourceCalls.keys().next().value;
                sourceCallBytes -= sourceCalls.get(oldest).bytes;
                sourceCalls.delete(oldest);
            }
            sourceCalls.set(key, { calls, bytes });
            sourceCallBytes += bytes;
        }
    }
    return calls;
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
    return { language, source: index._readFile(file), site: occurrenceIdentity(entry.relativePath, call),
        name: call.name, qualifier: call.constructorQualifier || null,
        base: call.implicitBase, enclosing: call.enclosingFunction, binding };
}

/** Re-derive the omitted initializer from raw source, then replay its header binding. */
function validateImplicitBase(proof, owner, site) {
    if (!proof || !sameDeclaration(proof.binding?.owner, owner) ||
        typeof proof.source !== 'string' || !langTraits(proof.language)?.implicitBaseConstruction ||
        !site || ['file', 'line', 'column', 'start', 'end'].some(key => proof.site?.[key] !== site[key])) return false;
    try {
        const calls = implicitSourceCalls(proof.language, proof.source);
        const matches = calls.filter(call => call.name === proof.name &&
            call.qualifier === proof.qualifier && call.argCount === 0 &&
            ['line', 'column', 'start', 'end'].every(key => call.site[key] === site[key]) &&
            call.base === JSON.stringify(proof.base) && call.enclosing === JSON.stringify(proof.enclosing));
        const header = matches[0]?.header;
        return matches.length === 1 && validateTypeLookup(proof.binding, owner, header && {
            file: site.file, line: header.line, column: header.column, start: header.start, end: header.end,
        });
    } catch { return false; }
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
