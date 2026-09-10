'use strict';

const { declarationIdentity, sameDeclaration } = require('./provenance');

// Materialize the declaration/ancestry reads used by overload selection.
// Rechecking a witness runs the same selector over these data, with no live
// index, filesystem, or name-ranking fallback. An unrecorded read abstains.
function encode(value) {
    if (value === undefined) return { $undefined: true };
    if (value instanceof Set) return { $set: [...value].map(encode) };
    if (value instanceof Map) return { $map: [...value].map(([k, v]) => [encode(k), encode(v)]) };
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === 'object') return Object.fromEntries(
        Object.entries(value).filter(([, v]) => typeof v !== 'function').map(([k, v]) => [k, encode(v)]));
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

function factIndex(reads, live) {
    const local = new Map();
    const read = (key, compute) => {
        if (live && !Object.hasOwn(reads, key)) reads[key] = encode(compute());
        if (!Object.hasOwn(reads, key)) throw new Error(`Missing overload fact: ${key}`);
        return decode(reads[key]);
    };
    return new Proxy({}, {
        get(_, property) {
            if (local.has(property)) return local.get(property);
            if (String(property).includes('Cache')) {
                const cache = new Map(); local.set(property, cache); return cache;
            }
            if (['symbols', 'files', 'importGraph', 'extendsGraph', 'extendedByGraph'].includes(property)) {
                return {
                    get(key) {
                        return read(`${property}.get:${JSON.stringify(key)}`, () => {
                            const value = live[property]?.get(key);
                            if (property !== 'files' || !value) return value;
                            return { language: value.language, relativePath: value.relativePath,
                                importBindings: value.importBindings, moduleResolved: value.moduleResolved };
                        });
                    },
                    has(key) { return !!this.get(key); },
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

function captureOverload(index, call, candidates, language, select) {
    const reads = {};
    try {
        const result = select(factIndex(reads, index), call, candidates, language);
        if (!result.match && result.ambiguous) return null;
        return { call: encode(call), candidates: encode(candidates), language, reads,
            selected: declarationIdentity(result.match),
            outcome: result.match ? 'selected' : 'no-fit' };
    } catch { return null; }
}

function validateOverload(witness, members, selected, invalidCall = false) {
    if (!witness || !Array.isArray(witness.candidates)) return false;
    const candidates = decode(witness.candidates);
    if (candidates.length !== members.length || candidates.some(candidate =>
        !members.some(member => sameDeclaration(member, declarationIdentity(candidate))))) return false;
    try {
        // Lazy access avoids an initialization cycle with confidence.js.
        // The selector only sees the data-only replay facade above.
        const select = require('./callers').selectProvenanceOverload;
        const result = select(factIndex(witness.reads), decode(witness.call), candidates, witness.language);
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

module.exports = { captureOverload, validateOverload, overloadMemberGroup };
