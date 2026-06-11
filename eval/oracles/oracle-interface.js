/**
 * eval/oracles/oracle-interface.js - Pluggable external-oracle contract.
 *
 * An oracle is a compiler/LSP-backed referee that produces ground-truth
 * references for symbols in a repo. UCN's tiered caller answers are scored
 * against it (eval/run-oracle-eval.js). ts-morph implements this contract for
 * TypeScript; gopls/jedi/rust-analyzer slot in later by implementing the same
 * four members (handle = LSP client or project object — opaque to the runner).
 *
 * Oracle = {
 *   name: string,                      // 'ts-morph'
 *   languages: string[],               // ['typescript', 'javascript']
 *   async prepare(repoDir, opts) -> handle,
 *   async listSymbols(handle, { kinds, limit }) -> [{ name, file, line, kind }],
 *       // file: path RELATIVE to the prepared root; kind: 'function'|'method'|'class'
 *   async findReferences(handle, { name, file, line }) -> [{ file, line, kind }],
 *       // kind: 'call' | 'import' | 'reference' | 'definition'
 * }
 */

'use strict';

const REQUIRED_MEMBERS = ['name', 'languages', 'prepare', 'listSymbols', 'findReferences'];
const REFERENCE_KINDS = new Set(['call', 'import', 'reference', 'definition']);

/** Throw if an oracle object doesn't satisfy the contract. */
function validateOracle(oracle) {
    for (const member of REQUIRED_MEMBERS) {
        if (!(member in oracle)) {
            throw new Error(`Oracle missing required member "${member}"`);
        }
    }
    if (typeof oracle.prepare !== 'function' ||
        typeof oracle.listSymbols !== 'function' ||
        typeof oracle.findReferences !== 'function') {
        throw new Error('Oracle prepare/listSymbols/findReferences must be functions');
    }
    if (!Array.isArray(oracle.languages) || oracle.languages.length === 0) {
        throw new Error('Oracle languages must be a non-empty array');
    }
    return oracle;
}

/** Validate a findReferences result entry (used by the runner in strict mode). */
function validateReference(ref, oracleName) {
    if (!ref || typeof ref.file !== 'string' || typeof ref.line !== 'number') {
        throw new Error(`${oracleName}: reference must have file:string and line:number, got ${JSON.stringify(ref)}`);
    }
    if (!REFERENCE_KINDS.has(ref.kind)) {
        throw new Error(`${oracleName}: reference kind "${ref.kind}" not in ${[...REFERENCE_KINDS].join('|')}`);
    }
    return ref;
}

module.exports = { validateOracle, validateReference, REFERENCE_KINDS };
