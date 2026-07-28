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
 *   async findReferences(handle, { name, file, line }) -> [{ file, line, column?, kind }],
 *       // kind: 'call' | 'import' | 'reference' | 'definition'
 *   async resolveDefinition?(handle, { name, file, line, column? }) -> [{ file, line }],
 *       // optional exact static-target adjudication for reference-search gaps
 *   async isConfigurationGated?(handle, { file, line }) -> boolean,
 *       // optional single-configuration coverage marker (Rust cfg, etc.)
 *   async dispose?(handle),            // optional graceful teardown (LSP shutdown)
 * }
 */

'use strict';

const fs = require('fs');
const path = require('path');

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
    if (oracle.resolveDefinition != null && typeof oracle.resolveDefinition !== 'function') {
        throw new Error('Oracle resolveDefinition must be a function when provided');
    }
    if (oracle.isConfigurationGated != null && typeof oracle.isConfigurationGated !== 'function') {
        throw new Error('Oracle isConfigurationGated must be a function when provided');
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

/**
 * Map paths between an oracle's prepared root and UCN's project root.
 *
 * Both roots must be canonicalized before taking a relative path. On macOS,
 * os.tmpdir() commonly returns /var/... while Eclipse/JDT reports the same
 * files under /private/var/.... Comparing those lexical paths made the Java
 * release gate discard its entire symbol universe.
 */
function createOraclePathMapper(indexRoot, oracleRoot) {
    const canonical = root => {
        const absolute = path.resolve(root);
        try {
            return fs.realpathSync.native
                ? fs.realpathSync.native(absolute)
                : fs.realpathSync(absolute);
        } catch (_) {
            return absolute;
        }
    };
    const canonicalIndexRoot = canonical(indexRoot);
    const canonicalOracleRoot = canonical(oracleRoot);

    return {
        toIndex(file) {
            return path.relative(
                canonicalIndexRoot,
                path.resolve(canonicalOracleRoot, file));
        },
        toOracle(file) {
            return path.relative(
                canonicalOracleRoot,
                path.resolve(canonicalIndexRoot, file));
        },
    };
}

module.exports = {
    validateOracle,
    validateReference,
    createOraclePathMapper,
    REFERENCE_KINDS,
};
