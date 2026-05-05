/**
 * core/brief.js — Brief: AST-only one-screen summary for a symbol.
 *
 * Returns a compact "before-I-touch-this" snapshot:
 *   - typed signature
 *   - first-sentence docstring
 *   - side-effect classification (fs/network/global mutation/process)
 *   - complexity (branches, maxDepth, lineCount)
 *   - async/generator flags
 *
 * No LLM, no heuristics that pretend to "summarize" intent.
 * Everything here is derivable from the AST and existing symbol fields.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('./parser');
const { detectLanguage, langTraits } = require('../languages');
const { formatSymbolHandle } = require('./shared');

// ============================================================================
// Side-effect signal sets (per-language, conservative)
// ============================================================================

// Module/import names that signal a category.
// Keys are language; values are { fs: Set, network: Set, process: Set }.
const SIDE_EFFECT_IMPORTS = {
    javascript: {
        fs: new Set(['fs', 'fs/promises', 'graceful-fs', 'node:fs', 'node:fs/promises']),
        network: new Set(['http', 'https', 'net', 'tls', 'dgram', 'axios', 'node-fetch', 'got', 'undici', 'ws', 'node:http', 'node:https', 'node:net']),
        process: new Set(['child_process', 'cluster', 'worker_threads', 'os', 'node:child_process', 'node:cluster', 'node:worker_threads', 'node:os']),
    },
    typescript: {
        fs: new Set(['fs', 'fs/promises', 'graceful-fs', 'node:fs', 'node:fs/promises']),
        network: new Set(['http', 'https', 'net', 'tls', 'dgram', 'axios', 'node-fetch', 'got', 'undici', 'ws', 'node:http', 'node:https', 'node:net']),
        process: new Set(['child_process', 'cluster', 'worker_threads', 'os', 'node:child_process', 'node:cluster', 'node:worker_threads', 'node:os']),
    },
    python: {
        fs: new Set(['os', 'os.path', 'pathlib', 'shutil', 'tempfile', 'io']),
        network: new Set(['urllib', 'urllib.request', 'http', 'http.client', 'socket', 'requests', 'httpx', 'aiohttp']),
        process: new Set(['subprocess', 'multiprocessing', 'os', 'signal', 'threading']),
    },
    go: {
        fs: new Set(['os', 'io', 'io/ioutil', 'path/filepath', 'embed']),
        network: new Set(['net', 'net/http', 'net/url', 'net/rpc']),
        process: new Set(['os/exec', 'syscall', 'runtime']),
    },
    java: {
        fs: new Set(['java.io', 'java.nio', 'java.nio.file']),
        network: new Set(['java.net', 'java.net.http']),
        process: new Set(['java.lang.Runtime', 'java.lang.ProcessBuilder']),
    },
    rust: {
        fs: new Set(['std::fs', 'std::path']),
        network: new Set(['std::net', 'reqwest', 'hyper', 'tokio::net']),
        process: new Set(['std::process']),
    },
};

// Identifier names that signal side effects when called or referenced.
// Plain identifier match — not regex. We require the call to be the receiver-less form
// (e.g. `fetch(...)`) OR a member of a recognized object (`fs.readFile`).
const SIDE_EFFECT_CALLS_BY_LANG = {
    javascript: {
        network: new Set(['fetch', 'XMLHttpRequest']),
        // Top-level browser globals that mutate state
        process: new Set(['exit']),
    },
    typescript: {
        network: new Set(['fetch', 'XMLHttpRequest']),
        process: new Set(['exit']),
    },
    python: {
        fs: new Set(['open']),
        process: new Set(['exit', 'system']),
    },
    go: {},
    java: {},
    rust: {},
};

// ============================================================================
// brief()
// ============================================================================

/**
 * Compute a brief AST summary for a symbol.
 *
 * @param {object} index - ProjectIndex
 * @param {string} name - Symbol name (function/method/class)
 * @param {object} options - { file, className }
 * @returns {object|null}
 */
function brief(index, name, options = {}) {
    index._beginOp();
    try {
        const { def } = index.resolveSymbol(name, { file: options.file, className: options.className, line: options.line });
        if (!def) return null;

        const language = detectLanguage(def.relativePath || def.file);
        const symbol = {
            name: def.name,
            type: def.type,
            file: def.relativePath || def.file,
            startLine: def.startLine,
            endLine: def.endLine,
            handle: formatSymbolHandle(def),
            language,
            ...(def.params != null && { params: def.params }),
            ...(def.paramsStructured && { paramsStructured: def.paramsStructured }),
            ...(def.paramTypes && { paramTypes: def.paramTypes }),
            ...(def.returnType && { returnType: def.returnType }),
            ...(def.modifiers && def.modifiers.length && { modifiers: def.modifiers }),
            ...(def.decorators && def.decorators.length && { decorators: def.decorators }),
            ...(def.docstring && { docstring: firstSentence(def.docstring) }),
            ...(def.className && { className: def.className }),
            ...(def.isAsync && { isAsync: true }),
            ...(def.isGenerator && { isGenerator: true }),
        };

        // For non-callable types (class/struct/interface/type), most fields don't apply
        if (['class', 'struct', 'interface', 'type', 'enum'].includes(def.type)) {
            return {
                symbol,
                kind: 'type',
                lineCount: (def.endLine || def.startLine) - def.startLine + 1,
                memberCount: countMembers(index, def),
            };
        }

        // For callable symbols, scan the body
        const filePath = path.isAbsolute(def.file) ? def.file : path.join(index.root, def.file);
        let bodyText = '';
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            const start = Math.max(0, (def.startLine || 1) - 1);
            const end = Math.min(lines.length, def.endLine || def.startLine || 1);
            bodyText = lines.slice(start, end).join('\n');
        } catch (e) {
            return {
                symbol,
                kind: 'function',
                lineCount: 0,
                sideEffects: [],
                complexity: { branches: 0, maxDepth: 0, lineCount: 0 },
                isAsync: !!def.isAsync,
                error: 'Could not read source',
            };
        }

        const fileEntry = index.files.get(def.file);
        const fileImports = collectImportNames(fileEntry);

        const sideEffects = classifySideEffects(bodyText, language, fileImports);
        const complexity = computeComplexity(bodyText, language);

        return {
            symbol,
            kind: 'function',
            lineCount: complexity.lineCount,
            sideEffects,
            complexity,
            isAsync: !!def.isAsync,
            isGenerator: !!def.isGenerator,
        };
    } finally {
        index._endOp();
    }
}

// ============================================================================
// Helpers
// ============================================================================

function firstSentence(text) {
    if (!text) return null;
    const trimmed = text.trim();
    // Cut on first sentence terminator. Cap at 200 chars to avoid runaway.
    const m = trimmed.match(/^(.+?[.!?])\s/);
    let s = m ? m[1] : trimmed;
    if (s.length > 200) s = s.slice(0, 197) + '...';
    return s;
}

function countMembers(index, def) {
    if (!def || !def.file) return 0;
    let count = 0;
    for (const arr of index.symbols.values()) {
        for (const s of arr) {
            if (s.file === def.file && s.className === def.name && s.isMethod) count++;
        }
    }
    return count;
}

function collectImportNames(fileEntry) {
    if (!fileEntry) return new Set();
    const names = new Set();
    if (fileEntry.exportDetails) {
        // exportDetails are exports — skip
    }
    // imports map: importName → modulePath (or { source, ... })
    if (fileEntry.imports && typeof fileEntry.imports === 'object') {
        for (const v of Object.values(fileEntry.imports)) {
            if (typeof v === 'string') names.add(v);
            else if (v && v.source) names.add(v.source);
            else if (v && v.from) names.add(v.from);
        }
    }
    if (fileEntry.importDetails && Array.isArray(fileEntry.importDetails)) {
        for (const imp of fileEntry.importDetails) {
            if (imp && imp.source) names.add(imp.source);
            if (imp && imp.from) names.add(imp.from);
        }
    }
    return names;
}

/**
 * Classify side-effects from a function body using string scans.
 *
 * Returns: array of categories the function appears to touch:
 *   'fs' — filesystem reads/writes
 *   'network' — outbound network calls
 *   'process' — child processes / OS-level effects
 *   'global_mutation' — assignments to module-level identifiers (heuristic)
 *
 * NOTE: We use textual scanning over the function body — tree-sitter is great
 * for top-level structure but reparsing every function body for the full AST
 * just to detect well-known names is overkill. The signal sets are tight.
 */
function classifySideEffects(bodyText, language, fileImports) {
    const out = new Set();
    if (!bodyText) return [];

    const importsBuckets = SIDE_EFFECT_IMPORTS[language] || {};
    const callsBuckets = SIDE_EFFECT_CALLS_BY_LANG[language] || {};

    // Resolve which categories the file's imports touch (file-level signal).
    // E.g. if the file imports `fs`, ANY function in the file *could* use it.
    // We confirm by looking for the import-binding name being used in the body.
    // For now, surface category as a "potential" signal if the body references
    // ANY imported binding from a category.
    const fileImportLower = new Set([...fileImports].map(s => s.toLowerCase()));
    for (const [cat, modSet] of Object.entries(importsBuckets)) {
        for (const m of modSet) {
            if (fileImportLower.has(m.toLowerCase())) {
                // Also confirm the body references the module name as an identifier
                // (very common: `fs.readFile`, `requests.get(`, etc.).
                const baseName = m.split(/[./]/).pop();
                if (baseName && new RegExp(`\\b${escapeRegExp(baseName)}\\b`).test(bodyText)) {
                    out.add(cat);
                    break;
                }
            }
        }
    }

    // Direct-call signals (no import context needed): `fetch(`, `open(`, etc.
    for (const [cat, callSet] of Object.entries(callsBuckets)) {
        for (const fn of callSet) {
            const re = new RegExp(`\\b${escapeRegExp(fn)}\\s*\\(`);
            if (re.test(bodyText)) {
                out.add(cat);
                break;
            }
        }
    }

    // Process category for JS console.* (informational, not flagged)
    // Skip — too noisy for "side effect" semantics.

    // Global-mutation heuristic (cheap):
    //   - JS/TS:    `module.exports.X = ` / `exports.X = ` / global identifier reassignment at top-level of function body
    //   - Python:   `global X`
    //   - Go:       package-level ident on lhs (hard without full AST — skip)
    if (language === 'javascript' || language === 'typescript') {
        if (/\b(module\.exports|exports)\.[A-Za-z_]\w*\s*=/.test(bodyText)) {
            out.add('global_mutation');
        }
    } else if (language === 'python') {
        if (/^\s*global\s+\w/m.test(bodyText)) {
            out.add('global_mutation');
        }
    }

    return [...out].sort();
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compute complexity metrics from a function body.
 * Cheap, AST-free counts on tokenized source.
 */
function computeComplexity(bodyText, language) {
    const lines = bodyText.split('\n');
    const lineCount = lines.length;

    // Branch count: count keywords that introduce a new branching path.
    // We deliberately ignore final `else` (it's just the alternate of an `if`).
    const branchPatterns = [
        /\bif\s*\(/g,        // JS/TS/Java/Rust/Go/C-like
        /\bif\s+/g,          // Python (if x:)
        /\belif\b/g,         // Python
        /\belse\s+if\b/g,    // JS/Java/etc.
        /\bcase\b/g,         // switch case
        /\bwhen\b/g,         // Rust match arms (and Kotlin/Scala but we don't support those)
        /\bfor\s*\(/g,       // C-like for
        /\bfor\s+\w/g,       // Python for x in
        /\bwhile\s*\(/g,     // C-like while
        /\bwhile\s+/g,       // Python while x:
        /\?[^?]/g,           // ternary (rough)
        /\bcatch\s*\(/g,     // catch
        /\bexcept\b/g,       // Python except
    ];
    let branches = 0;
    for (const re of branchPatterns) branches += (bodyText.match(re) || []).length;

    // maxDepth: indent-based proxy. Fast, language-agnostic, off-by-one safe.
    let maxDepth = 0;
    let firstNonBlankIndent = -1;
    for (const line of lines) {
        if (!line.trim()) continue;
        const m = line.match(/^(\s*)/);
        const spaces = m ? expandIndent(m[1]) : 0;
        if (firstNonBlankIndent === -1) firstNonBlankIndent = spaces;
        // depth = (current - first) / unit; we don't know "unit", so just track
        // raw delta and divide by 2 (conservative — most code is 2 or 4 space indented).
        const rawDepth = Math.max(0, spaces - firstNonBlankIndent);
        if (rawDepth > maxDepth) maxDepth = rawDepth;
    }
    // Translate raw spaces to depth levels (assume 2-space indent baseline)
    const depth = Math.round(maxDepth / 2);

    return { branches, maxDepth: depth, lineCount };
}

function expandIndent(s) {
    let n = 0;
    for (const c of s) n += (c === '\t') ? 4 : 1;
    return n;
}

/**
 * Lazy classifier: side-effect tags for an arbitrary symbol record.
 * Used by callee output (`context`, `about`) to surface [fs]/[net]/[proc] tags
 * inline. Cached on the index in `_sideEffectCache` (key: file:startLine).
 *
 * Cheap on cache hit; first hit reads + scans the symbol's body. Returns
 * `null` for non-callable types or unreadable files.
 */
function sideEffectsFor(index, symbol) {
    if (!index || !symbol) return null;
    if (NON_CALLABLE_KIND.has(symbol.type)) return null;
    const key = `${symbol.file || symbol.relativePath}:${symbol.startLine || 0}`;
    if (!index._sideEffectCache) index._sideEffectCache = new Map();
    if (index._sideEffectCache.has(key)) return index._sideEffectCache.get(key);

    const filePath = path.isAbsolute(symbol.file || '') ? symbol.file : path.join(index.root, symbol.file || symbol.relativePath || '');
    let bodyText = '';
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const start = Math.max(0, (symbol.startLine || 1) - 1);
        const end = Math.min(lines.length, symbol.endLine || symbol.startLine || 1);
        bodyText = lines.slice(start, end).join('\n');
    } catch (e) {
        index._sideEffectCache.set(key, null);
        return null;
    }
    const language = detectLanguage(symbol.relativePath || symbol.file);
    const fileEntry = index.files.get(symbol.file);
    const fileImports = collectImportNames(fileEntry);
    const tags = classifySideEffects(bodyText, language, fileImports);
    index._sideEffectCache.set(key, tags);
    return tags;
}

const NON_CALLABLE_KIND = new Set(['class', 'struct', 'interface', 'type', 'enum', 'trait', 'impl', 'state', 'field']);

module.exports = {
    brief,
    sideEffectsFor,
    // exposed for tests
    classifySideEffects,
    computeComplexity,
    firstSentence,
};
