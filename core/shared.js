/**
 * core/shared.js - Shared utility functions used by both CLI and MCP server
 */

const { isTestFile } = require('./discovery');
const { detectLanguage } = require('./parser');

/**
 * Code-unit string comparison (rule 11 / fix #227): output ordering is part
 * of the public contract and must be byte-identical across machines —
 * localeCompare depends on the host ICU locale (case-insensitive-ish
 * collation, locale tailoring), so two machines can render the same result
 * in different orders. Every output-path comparator uses this instead.
 */
function codeUnitCompare(a, b) {
    const sa = String(a ?? '');
    const sb = String(b ?? '');
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * Path-based test heuristic — matches the same patterns as `find`'s exclusion
 * logic so that `about` and `find` agree on which files are de-emphasized.
 *
 * Triggers when any of `test|tests|spec|__tests__|__mocks__|fixture|mock`
 * appears as a path segment (with word boundaries on both sides).
 *
 * Complement to `isTestFile` (filename pattern check) — together they catch
 * both `foo.test.js` (filename) AND `test/agent-benchmark.js` (directory).
 */
function isTestPath(rp) {
    if (!rp) return false;
    return /(^|[/._-])(test|tests|spec|__tests__|__mocks__|fixture|mock)s?([/._-]|$)/i.test(rp);
}

/**
 * Pick the best definition from multiple matches.
 * Prefers non-test, src/lib files, larger function bodies.
 *
 * BUG-M4: align with `find`'s exclusion ordering so `about` and `find` pick
 * the same primary. Adds path-based test detection (covers `test/foo.js`
 * which `isTestFile` misses) and prefers files that are imported by others
 * (real source) over test/fixture files.
 */
function pickBestDefinition(matches, opts = {}) {
    const typeOrder = new Set(['class', 'struct', 'interface', 'type', 'impl']);
    const importGraph = opts.importGraph;
    const scored = matches.map(m => {
        let score = 0;
        const rp = m.relativePath || '';
        // Prefer class/struct/interface types (+1000) - same as resolveSymbol
        if (typeOrder.has(m.type)) score += 1000;
        // Test file penalties: -500 for filename pattern OR path segment.
        // Both checks because `isTestFile` only matches `*.test.js`/`__tests__/`,
        // not `test/agent-benchmark.js` which `find` excludes via path regex.
        if (isTestFile(rp, detectLanguage(m.file)) || isTestPath(rp)) score -= 500;
        if (/^(examples?|docs?|vendor|third[_-]?party|benchmarks?|samples?)\//i.test(rp)) score -= 300;
        if (/^(lib|src|core|internal|pkg|crates)\//i.test(rp)) score += 200;
        // Prefer files that are imported by something — real source over scripts/fixtures.
        if (importGraph && m.file) {
            for (const [, importedFiles] of importGraph) {
                if (importedFiles.has(m.file)) { score += 100; break; }
            }
        }
        // Deprioritize type-only overload signatures (TypeScript function_signature)
        if (m.isSignature) score -= 200;
        // Tiebreaker: prefer larger function bodies (more important/complex)
        if (m.startLine && m.endLine) {
            score += Math.min(m.endLine - m.startLine, 100);
        }
        return { match: m, score, rp };
    });
    // Stable sort: by score desc, then alphabetical relativePath (so two equal-score
    // matches always pick the same one across runs).
    scored.sort((a, b) => (b.score - a.score) || codeUnitCompare(a.rp, b.rp));
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
 * Every function-shaped symbol kind across the parsers (fix #251 — stats
 * ranked "longest/hottest functions" from a 7-kind subset, so private
 * methods, accessors, and dunders were invisible to the rankings while the
 * same command's "By Type" counted them). deadcode keeps its own narrower
 * list: dunders ('special') stay out of the audit — protocol dispatch is
 * invisible to the usage scan.
 */
const CALLABLE_SYMBOL_KINDS = new Set([
    'function', 'method', 'static', 'public', 'abstract', 'constructor',
    'private', 'get', 'set', 'property', 'setter', 'deleter', 'classmethod',
    'special', 'override', 'static get', 'static set', 'override get',
    'override set', 'static override', 'static override get', 'static override set',
]);

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

/**
 * Explicit override marker on a method definition (fix #210). Marker fields are
 * language-disjoint and compiler-checked syntax (never inferred): traitImpl is
 * Rust's `impl Trait`, an 'override' modifier is Java's lowercased @Override, an
 * override-bearing memberType is TS's `override` keyword, and an override
 * decorator is Python's typing.@override. Shared by the external-contract
 * reasoning in both the caller dispatch gate and deadcode (out-of-tree override
 * suppression) — one source of truth so a new marker is added once, not in two
 * drifting copies.
 */
function isOverrideMarked(def) {
    if (def.traitImpl) return true;
    const mods = def.modifiers || [];
    if (mods.includes('override')) return true;
    if (def.memberType && /\boverride\b/.test(def.memberType)) return true;
    if (def.decorators && def.decorators.some(d =>
        String(d).replace(/\(.*$/, '').split('.').pop() === 'override')) return true;
    return false;
}

// Per-language text patterns for the "blind spots" UCN's AST can't follow:
// eval/exec-style code execution and reflection (dynamic attribute access /
// dynamic dispatch). ONE source of truth so doctor's trust scan and
// detectCompleteness's about-footer warning count identically (field-report #2:
// they used to diverge — doctor 497 reflection vs footer 194, eval 3 vs 2 —
// because each kept its own regex set). Dynamic imports are NOT here: those are
// structural (fileEntry.dynamicImports), the AST-accurate count both paths share.
// `new Function(...)` is categorized as eval (code execution), not reflection.
const BLINDSPOT_TEXT_PATTERNS = {
    reflection: {
        python:     /\b(getattr|hasattr|setattr|__import__|importlib\.import_module)\s*\(/g,
        javascript: /\bReflect\.\w+\s*\(/g,
        typescript: /\bReflect\.\w+\s*\(/g,
        go:         /\breflect\.\w+\s*\(/g,
        java:       /\.getDeclaredMethod\b|\.getMethod\b|\.getDeclaredField\b|Class\.forName\b/g,
        rust:       /\bAny::downcast/g,
    },
    eval: {
        python:     /\b(eval|exec)\s*\(/g,
        javascript: /\beval\s*\(|\bnew\s+Function\s*\(/g,
        typescript: /\beval\s*\(|\bnew\s+Function\s*\(/g,
    },
};

/** True when a language has any text-blind-spot pattern (so callers can skip the file read otherwise). */
function hasTextBlindspots(language) {
    return !!(BLINDSPOT_TEXT_PATTERNS.reflection[language] || BLINDSPOT_TEXT_PATTERNS.eval[language]);
}

/**
 * Count text-detected blind spots (eval/exec, reflection) in one file's source.
 * Returns { eval, reflection } OCCURRENCE counts (global match). Shared by doctor
 * and detectCompleteness so both report the same numbers (field-report #2).
 */
function countTextBlindspots(content, language) {
    const reRe = BLINDSPOT_TEXT_PATTERNS.reflection[language];
    const evRe = BLINDSPOT_TEXT_PATTERNS.eval[language];
    return {
        eval: evRe ? (content.match(evRe) || []).length : 0,
        reflection: reRe ? (content.match(reRe) || []).length : 0,
    };
}

/**
 * Line ranges of INLINE test symbols in a source file — Rust #[test] fns and
 * #[cfg(test)] module members. A production file promoted to "test file"
 * because it CONTAINS an inline test module is test code only within these
 * ranges; counting its production lines as test matches claimed false
 * coverage (fix #244: `let url = self.build_url(path)` in a production
 * method body was credited as a test of build_url).
 * @returns {Array<[number, number]>}
 */
function inlineTestRanges(fileEntry) {
    const ranges = [];
    for (const s of fileEntry.symbols || []) {
        if (s.modifiers?.includes('test') || s.modifiers?.includes('cfg_test_module')) {
            ranges.push([s.startLine, s.endLine ?? s.startLine]);
        }
    }
    return ranges;
}

/** True when a line number falls inside any of the given [start, end] ranges. */
function lineInRanges(line, ranges) {
    for (const [s, e] of ranges) {
        if (line >= s && line <= e) return true;
    }
    return false;
}

/**
 * Class names whose instances dispatch `methodName` to className's own
 * definition: the class itself plus its transitive NON-overriding
 * descendants (fix #246 — the #198 subtype rule brought to the test-scan
 * className scoping: `c.describe()` on `Circle extends Shape` runs
 * Shape.describe when Circle doesn't override it). Descent stops at an
 * overriding child — its subtree binds the override, not the target.
 * @returns {Set<string>}
 */
function classDispatchNames(index, className, methodName, cap = 256) {
    const out = new Set([className]);
    if (!index?.extendedByGraph || !methodName) return out;
    const methodDefs = index.symbols?.get(methodName) || [];
    const queue = [className];
    while (queue.length > 0 && out.size < cap) {
        const children = index.extendedByGraph.get(queue.pop());
        if (!children) continue;
        for (const child of children) {
            const cName = typeof child === 'string' ? child : child.name;
            if (!cName || out.has(cName)) continue;
            if (methodDefs.some(d => d.className === cName)) continue; // overrides
            out.add(cName);
            queue.push(cName);
        }
    }
    return out;
}

module.exports = {
    pickBestDefinition,
    addTestExclusions,
    escapeRegExp,
    codeUnitCompare,
    inlineTestRanges,
    lineInRanges,
    classDispatchNames,
    NON_CALLABLE_TYPES,
    CALLABLE_SYMBOL_KINDS,
    formatSymbolHandle,
    parseSymbolHandle,
    looksLikeHandle,
    isTestPath,
    isOverrideMarked,
    hasTextBlindspots,
    countTextBlindspots,
};
