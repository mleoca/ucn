'use strict';

const { declarationIdentity, sameDeclaration } = require('./provenance');
const { langTraits } = require('../languages');

const OVERLOAD_FILE_FIELDS = ['language', 'relativePath', 'importBindings',
    'importDetails', 'symbols', 'moduleResolved'];

// Materialize the declaration/ancestry reads used by overload selection.
// Rechecking a witness runs the same selector over these data, with no live
// index, filesystem, or name-ranking fallback. An unrecorded read abstains.
function encode(value) {
    if (value === undefined) return { $undefined: true };
    if (value instanceof Set) return { $set: [...value].map(encode) };
    if (value instanceof Map) return { $map: [...value].map(([k, v]) => [encode(k), encode(v)]) };
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === 'object') return Object.fromEntries(
        Object.entries(value).filter(([, v]) => v !== undefined && typeof v !== 'function')
            .map(([k, v]) => [k, encode(v)]));
    return value;
}
function decode(value) {
    if (value?.$undefined) return undefined;
    if (value?.$set) return new Set(value.$set.map(decode));
    if (value?.$map) return new Map(value.$map.map(([k, v]) => [decode(k), decode(v)]));
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
    return value;
}

function factIndex(reads, live, fileFields) {
    // Derived identities must be rebuilt from captured declarations. A live
    // WeakMap is neither a raw input nor a replayable serialization.
    const local = new Map([['_classIdentity', null], ['_typeDenotation', null], ['_cppScope', null]]);
    let missingFacts = false;
    const read = (key, compute) => {
        if (live && !Object.hasOwn(reads, key)) reads[key] = encode(compute());
        if (!Object.hasOwn(reads, key)) {
            missingFacts = true;
            throw new Error(`Missing provenance fact: ${key}`);
        }
        return decode(reads[key]);
    };
    // A map-like read answers with one object per key, as the live index's
    // Map.get does (fix #388: decoding the same file entry again for every
    // read dominated warm `find` on Java projects).
    const mapReads = new Map();
    const readMapValue = (key, compute) => {
        if (mapReads.has(key)) return mapReads.get(key);
        const value = read(key, compute);
        mapReads.set(key, value);
        return value;
    };
    const readFile = key => {
        const base = `files.get:${JSON.stringify(key)}`;
        if (mapReads.has(base)) return mapReads.get(base);
        if (!read(`${base}.$present`, () => !!live.files.get(key))) {
            mapReads.set(base, undefined);
            return undefined;
        }
        // A language or package read must not copy every declaration in the
        // file. Each observed field is an independent raw input; replaying
        // an unobserved field still refuses for missing facts.
        const value = {};
        for (const field of fileFields) Object.defineProperty(value, field, {
            enumerable: true, configurable: true,
            get: () => readMapValue(`${base}.${JSON.stringify(field)}`,
                () => {
                    const entry = live.files.get(key);
                    if (fileFields === OVERLOAD_FILE_FIELDS && field === 'symbols' &&
                        !langTraits(entry.language)?.overloadFileSymbols) return undefined;
                    return entry[field];
                }),
            set: next => {
                Object.defineProperty(value, field, {
                    value: next, writable: true, enumerable: true, configurable: true,
                });
            },
        });
        mapReads.set(base, value);
        return value;
    };
    return new Proxy({}, {
        get(_, property) {
            // Callers skip their per-operation memos on this facade: every
            // read must be recorded for the replay (fix #396).
            if (property === 'isProvenanceFactIndex') return true;
            if (property === 'hasMissingProvenanceFacts') return missingFacts;
            if (property === 'provenanceFs') return Object.fromEntries(
                ['existsSync', 'readdirSync', 'readFileSync'].map(method => [method, (...args) => {
                    const result = read(`fs.${method}:${JSON.stringify(args)}`, () => {
                        try { return { ok: true, value: require('fs')[method](...args) }; }
                        catch (error) { return { ok: false, code: error.code || null }; }
                    });
                    if (!result.ok) throw Object.assign(new Error('Captured filesystem read failed'), { code: result.code });
                    return result.value;
                }]));
            if (local.has(property)) return local.get(property);
            if (String(property).includes('Cache')) {
                const cache = new Map(); local.set(property, cache); return cache;
            }
            if (['symbols', 'files', 'importGraph', 'extendsGraph', 'extendedByGraph'].includes(property)) {
                return {
                    get(key) {
                        if (property === 'files' && fileFields) return readFile(key);
                        return readMapValue(`${property}.get:${JSON.stringify(key)}`, () => {
                            const value = live[property]?.get(key);
                            if (property !== 'files' || !value) return value;
                            return { language: value.language, relativePath: value.relativePath,
                                importBindings: value.importBindings,
                                ...(value.importDetails !== undefined && { importDetails: value.importDetails }),
                                ...(langTraits(value.language)?.overloadFileSymbols && value.symbols !== undefined && { symbols: value.symbols }),
                                moduleResolved: value.moduleResolved };
                        });
                    },
                    has(key) { return !!this.get(key); },
                    keys() { return read(`${property}.keys`, () => [...live[property].keys()])[Symbol.iterator](); },
                    *values() { for (const key of this.keys()) yield this.get(key); },
                    *entries() { for (const key of this.keys()) yield [key, this.get(key)]; },
                    [Symbol.iterator]() { return this.entries(); },
                };
            }
            const method = live ? typeof live[property] === 'function'
                : reads[`method:${String(property)}`] === true;
            if (method) {
                if (live) reads[`method:${String(property)}`] = true;
                return (...args) => read(`${String(property)}:${JSON.stringify(args)}`,
                    () => live[property](...args));
            }
            return read(`property:${String(property)}`, () => live[property]);
        },
        set(_, property, value) { local.set(property, value); return true; },
    });
}

// Reuse the encoding while its signature fields are unchanged. A check
// against a base revision temporarily restores those fields on the indexed
// declaration; that view needs its own witness, even for the same object.
const ENCODED_DEFINITIONS = new WeakMap();
function encodeDefinition(definition) {
    if (!definition || typeof definition !== 'object') return encode(definition);
    let saved = ENCODED_DEFINITIONS.get(definition);
    if (!saved || saved.params !== definition.params || saved.paramsStructured !== definition.paramsStructured ||
        saved.generics !== definition.generics) {
        saved = { value: encode(definition), params: definition.params,
            paramsStructured: definition.paramsStructured, generics: definition.generics };
        ENCODED_DEFINITIONS.set(definition, saved);
    }
    return saved.value;
}

function captureOverload(index, call, candidates, language, select) {
    const reads = {};
    try {
        const result = select(factIndex(reads, index, OVERLOAD_FILE_FIELDS), call, candidates, language);
        return { call: encode(call), candidates: candidates.map(encodeDefinition), language, reads, fileFields: true,
            selected: declarationIdentity(result.match),
            outcome: result.match ? 'selected' : result.ambiguous ? 'ambiguous' : 'no-fit' };
    } catch { return null; }
}

function validateOverload(witness, members, selected, invalidCall = false, ambiguous = false, site = null) {
    if (!witness || !Array.isArray(witness.candidates)) return false;
    const candidates = decode(witness.candidates);
    if (candidates.length !== members.length || candidates.some(candidate =>
        !members.some(member => sameDeclaration(member, declarationIdentity(candidate))))) return false;
    try {
        // Lazy access avoids an initialization cycle with confidence.js.
        // The selector only sees the data-only replay facade above.
        const select = require('./callers').selectProvenanceOverload;
        const index = factIndex(witness.reads, undefined, witness.fileFields ? OVERLOAD_FILE_FIELDS : undefined);
        const call = decode(witness.call);
        if (site && call.argumentFile !== undefined && call.argumentFile !== site.file) return false;
        if (site && call.argumentFile !== undefined && call.callSite &&
            (call.line !== site.line || call.callSite.line !== site.line ||
                call.callSite.start !== site.start || call.callSite.column !== site.column)) return false;
        const result = select(index, call, candidates, witness.language);
        if (index.hasMissingProvenanceFacts) return false;
        if (ambiguous) return !result.match && result.ambiguous === true;
        return invalidCall ? !result.match && !result.ambiguous :
            !!result.match && sameDeclaration(declarationIdentity(result.match), selected);
    } catch { return false; }
}

// Reconstruct inherited overload slots from the actual declarations, with
// the nearest declaration of an identical signature hiding the ancestor.
function overloadMemberGroup(steps) {
    const normalize = require('./callers').provenanceParameterIdentity;
    const seen = new Set();
    const group = [];
    for (const step of steps) {
        if (!Array.isArray(step.memberDefinitions) ||
            step.memberDefinitions.length !== step.members.length ||
            step.memberDefinitions.some(d => !step.members.some(m =>
                sameDeclaration(m, declarationIdentity(d))))) return null;
        const sameDepth = [];
        for (const definition of step.memberDefinitions) {
            const signature = Array.isArray(definition.paramsStructured)
                ? definition.paramsStructured.filter(p => !p?.extensionReceiver)
                    .map(p => `${normalize(p?.type || '')}:${p?.rest ? 'rest' : 'fixed'}`).join(',')
                : `${definition.file}:${definition.startLine}`;
            if (!seen.has(signature)) {
                group.push(definition);
                sameDepth.push(signature);
            }
        }
        for (const signature of sameDepth) seen.add(signature);
    }
    return group;
}

module.exports = { captureOverload, validateOverload, overloadMemberGroup, factIndex };
