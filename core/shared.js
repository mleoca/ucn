/**
 * core/shared.js - Shared utility functions used by both CLI and MCP server
 */

const { isTestFile } = require('./discovery');
const { detectLanguage } = require('./parser');

/**
 * Pick the best definition from multiple matches.
 * Prefers non-test, src/lib files, larger function bodies.
 */
function pickBestDefinition(matches) {
    const typeOrder = new Set(['class', 'struct', 'interface', 'type', 'impl']);
    const scored = matches.map(m => {
        let score = 0;
        const rp = m.relativePath || '';
        // Prefer class/struct/interface types (+1000) - same as resolveSymbol
        if (typeOrder.has(m.type)) score += 1000;
        if (isTestFile(rp, detectLanguage(m.file))) score -= 500;
        if (/^(examples?|docs?|vendor|third[_-]?party|benchmarks?|samples?)\//i.test(rp)) score -= 300;
        if (/^(lib|src|core|internal|pkg|crates)\//i.test(rp)) score += 200;
        // Deprioritize type-only overload signatures (TypeScript function_signature)
        if (m.isSignature) score -= 200;
        // Tiebreaker: prefer larger function bodies (more important/complex)
        if (m.startLine && m.endLine) {
            score += Math.min(m.endLine - m.startLine, 100);
        }
        return { match: m, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].match;
}

/**
 * Add standard test exclusion patterns to an exclude array.
 * Returns a new array with test patterns appended (deduplicating).
 */
function addTestExclusions(exclude) {
    const testPatterns = ['test', 'spec', '__tests__', '__mocks__', 'fixture', 'mock'];
    const existing = new Set((exclude || []).map(e => e.toLowerCase()));
    const additions = testPatterns.filter(p => !existing.has(p));
    return [...(exclude || []), ...additions];
}

/**
 * Escape special regex characters
 */
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Symbol types that are not callable (used to filter class/struct/type declarations from call analysis)
const NON_CALLABLE_TYPES = new Set(['class', 'struct', 'interface', 'type', 'enum', 'trait', 'state', 'impl', 'field']);

/**
 * Stable symbol handle: `relativePath:line` or `relativePath:line:name`.
 *
 * Handles let multi-step workflows roundtrip without name disambiguation —
 * `find` returns handles, `brief`/`impact`/`context` accept them, and the result
 * targets the exact same symbol even when names overlap. Renames break handles
 * (intentionally — that's a real change, not noise).
 *
 * Format chosen because:
 *   - colon is the existing UCN location separator (`file.js:42`)
 *   - line number is the second-most-stable ID (after path); names move within files
 *   - the optional :name disambiguates when multiple symbols share a startLine
 *     (rare but possible: e.g. `class Foo {}` and a same-line method def)
 */
function formatSymbolHandle(symbol) {
    if (!symbol || !symbol.startLine) return null;
    const file = symbol.relativePath || symbol.file;
    if (!file) return null;
    return symbol.name ? `${file}:${symbol.startLine}:${symbol.name}` : `${file}:${symbol.startLine}`;
}

/**
 * Parse a handle string back into its components.
 * Returns { file, line, name? } or null if input doesn't look like a handle.
 *
 * Strategy: scan from the right so paths containing `:` (Windows drive letters
 * if anyone ever uses them as relative paths) survive. The line number is the
 * rightmost run of digits between two colons or at the end.
 */
function parseSymbolHandle(input) {
    if (!input || typeof input !== 'string') return null;
    // Two forms:
    //   path:digits           → file + line
    //   path:digits:name      → file + line + name (name may contain anything)
    // The line is always digits; the path is everything before the line; the
    // optional name is everything after the line.
    const m = input.match(/^(.+):(\d+)(?::(.+))?$/);
    if (!m) return null;
    const file = m[1];
    const line = parseInt(m[2], 10);
    if (!Number.isFinite(line) || line < 1) return null;
    const handle = { file, line };
    if (m[3] != null) handle.name = m[3];
    return handle;
}

/**
 * Quick predicate: does this string look like a handle (vs a plain symbol name)?
 * Used to short-circuit handle resolution before name lookup.
 */
function looksLikeHandle(input) {
    if (!input || typeof input !== 'string') return false;
    return /^.+:\d+(?::.+)?$/.test(input);
}

module.exports = {
    pickBestDefinition,
    addTestExclusions,
    escapeRegExp,
    NON_CALLABLE_TYPES,
    formatSymbolHandle,
    parseSymbolHandle,
    looksLikeHandle,
};
