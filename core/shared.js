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

module.exports = { pickBestDefinition, addTestExclusions, escapeRegExp, NON_CALLABLE_TYPES };
