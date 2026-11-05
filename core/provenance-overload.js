'use strict';

const { declarationIdentity, identityKey, sameDeclaration } = require('./provenance');
const { langTraits } = require('../languages');
const { UcnError, isInternalError } = require('./errors');

// Modules read lazily (load cycles), each resolved once: a require() per
// call in hot paths was measurable (fix #436).
let lazyCallersModuleCache = null;
const lazyCallersModule = () => lazyCallersModuleCache || (lazyCallersModuleCache = require('./callers'));

/**
 * A witness that cannot prove its answer (fix #421): a fact its view did
 * not record, or a filesystem read that failed when it was captured. A
 * capture or a replay that meets one proves nothing; any other exception is
 * a defect and propagates.
 */
class ProvenanceRefusal extends UcnError {
    constructor(message, code) {
        super(message);
        this.name = 'UcnError';
        this.provenanceRefusal = true;
        if (code !== undefined) this.code = code;
    }
}

/**
 * Null for an expected refusal (a missing witness fact, an unreadable
 * source); rethrows an internal error so it reaches the surface as one
 * instead of becoming a review row (fix #421).
 */
function refusedProof(error, refusal = null) {
    if (error?.provenanceRefusal || !isInternalError(error)) return refusal;
    throw error;
}

const OVERLOAD_FILE_FIELDS = ['language', 'relativePath', 'importBindings',
    'importDetails', 'symbols', 'moduleResolved'];

// Work counters of witness construction (fix #418): a scaling test asserts
// that encoded and decoded facts grow with the sites a query visits, never
// with the project each witness could copy.
const WORK = { encodedNodes: 0, decodedNodes: 0, captures: 0, replays: 0 };
function provenanceWork() { return { ...WORK }; }

// Materialize the declaration/ancestry reads used by overload selection.
// Rechecking a witness runs the same selector over these data, with no live
// index, filesystem, or name-ranking fallback. An unrecorded read abstains.
// `frozen` (inside an operation) records immutable facts; `frozen.plain`
// turns false when the value holds a Map or Set, which cannot be frozen.
function encode(value, frozen = null) {
    WORK.encodedNodes++;
    const seal = out => frozen ? Object.freeze(out) : out;
    if (value === undefined) return seal({ $undefined: true });
    if (value instanceof Set) {
        if (frozen) frozen.plain = false;
        return seal({ $set: seal([...value].map(item => encode(item, frozen))) });
    }
    if (value instanceof Map) {
        if (frozen) frozen.plain = false;
        return seal({ $map: seal([...value].map(([k, v]) => seal([encode(k, frozen), encode(v, frozen)]))) });
    }
    if (Array.isArray(value)) return seal(value.map(item => encode(item, frozen)));
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value)) {
            const item = value[key];
            if (item === undefined || typeof item === 'function') continue;
            const encoded = encode(item, frozen);
            if (key === '__proto__') Object.defineProperty(out, key, {
                value: encoded, enumerable: true, writable: true, configurable: true,
            });
            else out[key] = encoded;
        }
        return seal(out);
    }
    return value;
}
function decode(value, freeze = false) {
    WORK.decodedNodes++;
    const seal = out => freeze ? Object.freeze(out) : out;
    if (value?.$undefined) return undefined;
    if (value?.$set) return new Set(value.$set.map(item => decode(item)));
    if (value?.$map) return new Map(value.$map.map(([k, v]) => [decode(k), decode(v)]));
    if (Array.isArray(value)) return seal(value.map(item => decode(item, freeze)));
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value)) {
            const decoded = decode(value[key], freeze);
            if (key === '__proto__') Object.defineProperty(out, key, {
                value: decoded, enumerable: true, writable: true, configurable: true,
            });
            else out[key] = decoded;
        }
        return seal(out);
    }
    return value;
}

// Recorded facts are immutable. Within one operation each live index value
// is encoded once for every witness that reads it, and a plain recorded
// value has one frozen decoded twin that every view reads (fix #418: a copy
// of a whole symbol table per site and per replay made constructor and
// overload queries quadratic). Writing to a shared fact throws rather than
// leaking into another view; a Map or Set fact is decoded per view.
const PLAIN_FACTS = new WeakSet();
const DECODED_FACTS = new WeakMap();

function encodeFact(value, memo) {
    if (!memo || !value || typeof value !== 'object') return encode(value, memo && {});
    let encoded = memo.get(value);
    if (encoded === undefined) {
        const frozen = { plain: true };
        encoded = encode(value, frozen);
        if (frozen.plain) PLAIN_FACTS.add(encoded);
        memo.set(value, encoded);
    }
    return encoded;
}

function decodeFact(value) {
    if (!value || typeof value !== 'object' || !PLAIN_FACTS.has(value)) return decode(value);
    let decoded = DECODED_FACTS.get(value);
    if (decoded === undefined) {
        decoded = decode(value, true);
        DECODED_FACTS.set(value, decoded);
    }
    return decoded;
}

// Shared computations of one operation by key and view kind (fix #418).
const FIELD_SET_TAGS = new WeakMap();
let fieldSetTags = 0;
const fieldSetTag = fields => {
    if (!fields) return 'all';
    if (!FIELD_SET_TAGS.has(fields)) FIELD_SET_TAGS.set(fields, `fields${++fieldSetTags}`);
    return FIELD_SET_TAGS.get(fields);
};

function factIndex(reads, live, fileFields) {
    if (live) WORK.captures++;
    else WORK.replays++;
    // Derived identities must be rebuilt from captured declarations. A live
    // WeakMap is neither a raw input nor a replayable serialization.
    const local = new Map([['_classIdentity', null], ['_typeDenotation', null], ['_cppScope', null]]);
    // Inside an operation of the live index, facts are immutable and an
    // index value is encoded once for every witness of the operation.
    const encoded = live && !live.isProvenanceFactIndex && typeof live._opMemo === 'function'
        ? live._opMemo('provenanceEncodedFacts', () => new WeakMap()) : null;
    let missingFacts = false;
    // `indexed`: the value is an index structure (a file field, a symbol
    // list, a graph entry), the same object for every reader.
    const read = (key, compute, indexed = false) => {
        if (live && !Object.hasOwn(reads, key)) {
            reads[key] = indexed ? encodeFact(compute(), encoded) : encode(compute(), encoded && {});
        }
        if (!Object.hasOwn(reads, key)) {
            missingFacts = true;
            throw new ProvenanceRefusal(`Missing provenance fact: ${key}`);
        }
        return decodeFact(reads[key]);
    };
    // A map-like read answers with one object per key, as the live index's
    // Map.get does (fix #388: decoding the same file entry again for every
    // read dominated warm `find` on Java projects).
    const mapReads = new Map();
    const readMapValue = (key, compute, indexed = false) => {
        if (mapReads.has(key)) return mapReads.get(key);
        const value = read(key, compute, indexed);
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
                }, true),
            set: next => {
                Object.defineProperty(value, field, {
                    value: next, writable: true, enumerable: true, configurable: true,
                });
            },
        });
        mapReads.set(base, value);
        return value;
    };
    const view = new Proxy({}, {
        get(_, property) {
            // Callers skip their per-operation memos on this facade: every
            // read must be recorded for the replay (fix #396).
            if (property === 'isProvenanceFactIndex') return true;
            if (property === 'hasMissingProvenanceFacts') return missingFacts;
            // A hint never changes an answer, only how it is reached: a
            // capture may consult the live index for it, a replay goes without.
            if (property === 'unrecordedHint') {
                return (compute) => live && !live.isProvenanceFactIndex ? compute(live) : undefined;
            }
            // A pure computation over the view, shared by every witness of
            // the operation: a capture runs it once on a view of its own and
            // records that view's reads; a replay recomputes it.
            if (property === 'sharedRead') {
                return (key, compute) => {
                    const memo = live && !live.isProvenanceFactIndex && typeof live._opMemo === 'function'
                        ? live._opMemo('provenanceSharedReads', () => new Map()) : null;
                    if (!memo) return compute(view);
                    const memoKey = `${fieldSetTag(fileFields)}\0${key}`;
                    let saved = memo.get(memoKey);
                    if (!saved) {
                        const childReads = {};
                        const value = compute(factIndex(childReads, live, fileFields));
                        saved = { value, reads: childReads };
                        memo.set(memoKey, saved);
                    }
                    for (const name in saved.reads) {
                        if (!Object.hasOwn(reads, name)) reads[name] = saved.reads[name];
                    }
                    return saved.value;
                };
            }
            if (property === 'projectFact') {
                return (key, compute) => readMapValue(`fact:${key}`, () => projectFact(live, key, compute), true);
            }
            if (property === 'provenanceFs') return Object.fromEntries(
                ['existsSync', 'readdirSync', 'readFileSync'].map(method => [method, (...args) => {
                    const result = read(`fs.${method}:${JSON.stringify(args)}`, () => {
                        try { return { ok: true, value: require('fs')[method](...args) }; }
                        catch (error) { return { ok: false, code: error.code || null }; }
                    });
                    if (!result.ok) throw new ProvenanceRefusal('Captured filesystem read failed', result.code);
                    return result.value;
                }]));
            if (local.has(property)) return local.get(property);
            if (String(property).includes('Cache')) {
                const cache = new Map(); local.set(property, cache); return cache;
            }
            if (['symbols', 'files', 'importGraph', 'extendsGraph', 'extendedByGraph'].includes(property)) {
                // One map facade per view, as on the live index. Reusing
                // the facade does not skip its methods' recorded reads.
                const map = {
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
                        }, property !== 'files');
                    },
                    has(key) { return !!this.get(key); },
                    keys() {
                        return read(`${property}.keys`, () => keyList(live, live[property]), true)[Symbol.iterator]();
                    },
                    *values() { for (const key of this.keys()) yield this.get(key); },
                    *entries() { for (const key of this.keys()) yield [key, this.get(key)]; },
                    [Symbol.iterator]() { return this.entries(); },
                };
                local.set(property, map);
                return map;
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
    return view;
}

// One key list per index map and operation: the shared encoding of a key
// read needs the same object for every witness.
function keyList(live, map) {
    const lists = !live.isProvenanceFactIndex && typeof live._opMemo === 'function'
        ? live._opMemo('provenanceKeyLists', () => new WeakMap()) : null;
    let keys = lists?.get(map);
    if (!keys) {
        keys = [...map.keys()];
        lists?.set(map, keys);
    }
    return keys;
}

/**
 * A whole-program projection (every namespace, every alias spelling) that a
 * witness consults. The witness records the projection's answer as one
 * fact, never every file it scans: a per-site copy of the project made each
 * constructor and overload query quadratic in project size (fix #418).
 * `compute(index)` runs on the live index, under its own memo.
 */
function projectFact(index, key, compute) {
    return index?.isProvenanceFactIndex ? index.projectFact(key, compute) : compute(index);
}

/**
 * `compute(index)` for a pure answer (plain data) of the index, once per
 * operation and key; on a witness view, its reads join the witness.
 */
function sharedRead(index, key, compute) {
    if (index?.isProvenanceFactIndex) return index.sharedRead(key, compute);
    const memo = index?._opMemo?.('provenanceSharedReads:live', () => new Map());
    if (!memo) return compute(index);
    if (!memo.has(key)) memo.set(key, compute(index));
    return memo.get(key);
}

/**
 * Is `member` in a whole-program set (`computeSet(liveIndex)`, memoized by
 * the caller)? A witness records the answer for that member only.
 */
function projectHas(index, setKey, member, computeSet) {
    return projectFact(index, `${setKey}\0${member}`, live => computeSet(live).has(member));
}

// A witness captured inside an operation holds only frozen facts. Its
// replays are pure functions of those facts and of the replay's other
// inputs, so each distinct replay runs once (fix #418).
const SEALED_FACTS = new WeakSet();
const REPLAYS = new WeakMap();

function sealFacts(reads) {
    for (const key in reads) {
        const value = reads[key];
        if (value && typeof value === 'object' && !Object.isFrozen(value)) return reads;
    }
    SEALED_FACTS.add(Object.freeze(reads));
    return reads;
}

/** `compute()` once per sealed fact set and key; it returns plain data. */
function replayed(reads, key, compute) {
    if (!SEALED_FACTS.has(reads)) return compute();
    let memo = REPLAYS.get(reads);
    if (!memo) REPLAYS.set(reads, memo = new Map());
    if (!memo.has(key)) memo.set(key, compute());
    return memo.get(key);
}

/**
 * A capture runs its selector over exactly the facts it records: every read
 * answers with the recorded value, and the facts it records are the reads
 * it made. Its answer is therefore the first replay of the sealed witness
 * (fix #418); a deserialized or changed copy is replayed in full.
 */
function seedReplay(reads, key, value) {
    if (!SEALED_FACTS.has(reads)) return;
    let memo = REPLAYS.get(reads);
    if (!memo) REPLAYS.set(reads, memo = new Map());
    if (!memo.has(key)) memo.set(key, value);
}

// Reuse the encoding while its signature fields are unchanged. A check
// against a base revision temporarily restores those fields on the indexed
// declaration; that view needs its own witness, even for the same object.
// The encoding is immutable: every witness of the candidate shares it.
const ENCODED_DEFINITIONS = new WeakMap();
function encodeDefinition(definition) {
    if (!definition || typeof definition !== 'object') return encode(definition);
    let saved = ENCODED_DEFINITIONS.get(definition);
    if (!saved || saved.params !== definition.params || saved.paramsStructured !== definition.paramsStructured ||
        saved.generics !== definition.generics) {
        const frozen = { plain: true };
        saved = { value: encode(definition, frozen), params: definition.params,
            paramsStructured: definition.paramsStructured, generics: definition.generics };
        // A plain recorded declaration has one frozen decoded twin every
        // capture selects over (fix #428).
        if (frozen.plain) PLAIN_FACTS.add(saved.value);
        ENCODED_DEFINITIONS.set(definition, saved);
    }
    return saved.value;
}

function captureOverload(index, call, candidates, language, select) {
    const reads = {};
    try {
        // The selector reads the recorded call and candidates, as a replay
        // does, so the capture's answer is the witness's first replay.
        const recordedCall = encode(call, {});
        const recordedCandidates = Object.freeze(candidates.map(encodeDefinition));
        const view = factIndex(reads, index, OVERLOAD_FILE_FIELDS);
        const selectable = recordedCandidates.map(decodeFact);
        const result = select(view, decode(recordedCall), selectable, language);
        const witness = { call: recordedCall, candidates: recordedCandidates, language,
            reads: sealFacts(reads), fileFields: true,
            selected: declarationIdentity(result.match),
            outcome: result.match ? 'selected' : result.ambiguous ? 'ambiguous' : 'no-fit' };
        if (SEALED_FACTS.has(witness.reads)) {
            OVERLOAD_REPLAYS.set(witness, { reads: witness.reads, call: recordedCall,
                candidates: recordedCandidates, language, fileFields: true, replay: {
                    candidates: selectable.map(declarationIdentity), call: decode(recordedCall),
                    result: { missing: view.hasMissingProvenanceFacts, ambiguous: result.ambiguous === true,
                        match: result.match ? declarationIdentity(result.match) : null } } });
        }
        return witness;
    } catch (error) { return refusedProof(error); }
}

// The selector's answer over a witness's recorded facts. A frozen witness
// is replayed once; a changed or deserialized copy is replayed again.
const OVERLOAD_REPLAYS = new WeakMap();
function overloadReplay(witness) {
    const reusable = SEALED_FACTS.has(witness.reads) && Object.isFrozen(witness.call) &&
        Object.isFrozen(witness.candidates);
    const saved = reusable ? OVERLOAD_REPLAYS.get(witness) : null;
    if (saved && saved.reads === witness.reads && saved.call === witness.call &&
        saved.candidates === witness.candidates && saved.language === witness.language &&
        saved.fileFields === witness.fileFields) return saved.replay;
    const candidates = decode(witness.candidates);
    const replay = { candidates: candidates.map(declarationIdentity), call: decode(witness.call), result: null };
    try {
        // Lazy access avoids an initialization cycle with confidence.js.
        // The selector only sees the data-only replay facade above.
        const select = lazyCallersModule().selectProvenanceOverload;
        const index = factIndex(witness.reads, undefined, witness.fileFields ? OVERLOAD_FILE_FIELDS : undefined);
        const result = select(index, decode(witness.call), candidates, witness.language);
        replay.result = { missing: index.hasMissingProvenanceFacts, ambiguous: result.ambiguous === true,
            match: result.match ? declarationIdentity(result.match) : null };
    } catch (error) { refusedProof(error); /* An unreplayable witness proves nothing. */ }
    if (reusable) OVERLOAD_REPLAYS.set(witness, { reads: witness.reads, call: witness.call,
        candidates: witness.candidates, language: witness.language, fileFields: witness.fileFields, replay });
    return replay;
}

function validateOverload(witness, members, selected, invalidCall = false, ambiguous = false, site = null) {
    if (!witness || !Array.isArray(witness.candidates)) return false;
    let replay;
    try { replay = overloadReplay(witness); } catch (error) { return refusedProof(error, false); }
    // Members usually arrive in the replay's own order: an aligned pass
    // decides those in one comparison each (fix #428).
    if (replay.candidates.length !== members.length || (!replay.candidates.every((candidate, i) =>
        sameDeclaration(members[i], candidate)) && replay.candidates.some(candidate =>
        !members.some(member => sameDeclaration(member, candidate))))) return false;
    const { call, result } = replay;
    if (site && call?.argumentFile !== undefined && call.argumentFile !== site.file) return false;
    if (site && call?.argumentFile !== undefined && call.callSite &&
        (call.line !== site.line || call.callSite.line !== site.line ||
            call.callSite.start !== site.start || call.callSite.column !== site.column)) return false;
    if (!result || result.missing) return false;
    if (ambiguous) return !result.match && result.ambiguous;
    return invalidCall ? !result.match && !result.ambiguous :
        !!result.match && sameDeclaration(result.match, selected);
}

// Reconstruct inherited overload slots from the actual declarations, with
// the nearest declaration of an identical signature hiding the ancestor.
const SLOT_SIGNATURES = new WeakMap();
const STEP_MEMBER_CHECKS = new WeakMap();
function overloadMemberGroup(steps) {
    const normalize = lazyCallersModule().provenanceParameterIdentity;
    const seen = new Set();
    const group = [];
    for (const step of steps) {
        if (!Array.isArray(step.memberDefinitions) ||
            step.memberDefinitions.length !== step.members.length) return null;
        // Every definition is one of the step's members: one key set per
        // pair of lists, never a pairwise comparison per witness (fix #428).
        let byDefinitions = STEP_MEMBER_CHECKS.get(step.members);
        if (!byDefinitions) STEP_MEMBER_CHECKS.set(step.members, byDefinitions = new WeakMap());
        let consistent = byDefinitions.get(step.memberDefinitions);
        if (consistent === undefined) {
            const memberKeys = new Set(step.members.map(member => identityKey(member)));
            consistent = !memberKeys.has(null) &&
                step.memberDefinitions.every(d => memberKeys.has(identityKey(declarationIdentity(d))));
            byDefinitions.set(step.memberDefinitions, consistent);
        }
        if (!consistent) return null;
        const sameDepth = [];
        for (const definition of step.memberDefinitions) {
            // One signature per declaration and parameter list (fix #428).
            let saved = SLOT_SIGNATURES.get(definition);
            if (!saved || saved.params !== definition.paramsStructured) {
                saved = { params: definition.paramsStructured, signature: Array.isArray(definition.paramsStructured)
                    ? definition.paramsStructured.filter(p => !p?.extensionReceiver)
                        .map(p => `${normalize(p?.type || '')}:${p?.rest ? 'rest' : 'fixed'}`).join(',')
                    : `${definition.file}:${definition.startLine}` };
                SLOT_SIGNATURES.set(definition, saved);
            }
            const signature = saved.signature;
            if (!seen.has(signature)) {
                group.push(definition);
                sameDepth.push(signature);
            }
        }
        for (const signature of sameDepth) seen.add(signature);
    }
    return group;
}

module.exports = { captureOverload, validateOverload, overloadMemberGroup, factIndex, projectFact, projectHas, sharedRead,
    sealFacts, replayed, seedReplay, provenanceWork, ProvenanceRefusal, refusedProof };
