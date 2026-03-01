/**
 * Shared Command Executor — single dispatch for CLI, MCP, and interactive mode.
 *
 * Handles: input validation, exclude normalization, test exclusion, index calls.
 * Does NOT handle: output formatting, expand caching, file I/O commands.
 *
 * Each handler returns { ok: true, result } or { ok: false, error }.
 * Adapters handle formatting and surface-specific concerns.
 */

'use strict';

const { addTestExclusions } = require('./shared');

// Commands handled directly by adapters (not in HANDLERS below).
// fn, class, lines need raw file content / line-range logic.
// expand needs per-session cache state that differs by surface.
const ADAPTER_ONLY_COMMANDS = new Set(['fn', 'class', 'lines', 'expand']);

// ============================================================================
// HELPERS
// ============================================================================

function requireName(name) {
    if (!name || (typeof name === 'string' && !name.trim())) {
        return 'Symbol name is required.';
    }
    return null;
}

function requireFile(file) {
    if (!file || (typeof file === 'string' && !file.trim())) {
        return 'File parameter is required.';
    }
    return null;
}

function requireTerm(term) {
    if (!term || (typeof term === 'string' && !term.trim())) {
        return 'Search term is required.';
    }
    return null;
}

/** Normalize exclude to an array (accepts string CSV, array, or falsy). */
function toExcludeArray(exclude) {
    if (!exclude) return [];
    if (Array.isArray(exclude)) return exclude;
    return exclude.split(',').map(s => s.trim()).filter(Boolean);
}

/** Apply test exclusions unless includeTests is set. */
function applyTestExclusions(exclude, includeTests) {
    const arr = toExcludeArray(exclude);
    return includeTests ? arr : addTestExclusions(arr);
}

/** Check if a file-based result has a file error. */
function checkFileError(result, file) {
    if (!result) return null;
    if (result.error === 'file-not-found') {
        return `File not found in project: ${file}`;
    }
    if (result.error === 'file-ambiguous') {
        const candidates = result.candidates ? result.candidates.map(c => '  ' + c).join('\n') : '';
        return `Ambiguous file "${file}". Candidates:\n${candidates}`;
    }
    return null;
}

/** Parse a number param (handles string from CLI, number from MCP). */
function num(val, fallback) {
    if (val == null) return fallback;
    const n = Number(val);
    return isNaN(n) ? fallback : n;
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

const HANDLERS = {

    // ── Understanding Code ──────────────────────────────────────────────

    about: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        const result = index.about(p.name, {
            withTypes: p.withTypes || false,
            file: p.file,
            all: p.all,
            includeMethods: p.includeMethods,
            includeUncertain: p.includeUncertain || false,
            exclude: toExcludeArray(p.exclude),
            maxCallers: num(p.top, undefined),
            maxCallees: num(p.top, undefined),
        });
        if (!result) return { ok: false, error: `Symbol "${p.name}" not found.` };
        return { ok: true, result };
    },

    context: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        const result = index.context(p.name, {
            includeMethods: p.includeMethods,
            includeUncertain: p.includeUncertain || false,
            file: p.file,
            exclude: toExcludeArray(p.exclude),
        });
        if (!result) return { ok: false, error: `Symbol "${p.name}" not found.` };
        return { ok: true, result };
    },

    impact: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        const result = index.impact(p.name, {
            file: p.file,
            exclude: toExcludeArray(p.exclude),
        });
        if (!result) return { ok: false, error: `Function "${p.name}" not found.` };
        return { ok: true, result };
    },

    smart: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        const result = index.smart(p.name, {
            file: p.file,
            withTypes: p.withTypes || false,
            includeMethods: p.includeMethods,
            includeUncertain: p.includeUncertain || false,
        });
        if (!result) return { ok: false, error: `Function "${p.name}" not found.` };
        return { ok: true, result };
    },

    trace: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        const depthVal = num(p.depth, undefined);
        const result = index.trace(p.name, {
            depth: depthVal ?? 3,
            file: p.file,
            all: p.all || depthVal !== undefined,
            includeMethods: p.includeMethods,
            includeUncertain: p.includeUncertain || false,
        });
        if (!result) return { ok: false, error: `Function "${p.name}" not found.` };
        return { ok: true, result };
    },

    example: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        const result = index.example(p.name);
        if (!result) return { ok: false, error: `No examples found for "${p.name}".` };
        return { ok: true, result };
    },

    related: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        const result = index.related(p.name, {
            file: p.file,
            top: num(p.top, undefined),
            all: p.all,
        });
        if (!result) return { ok: false, error: `Function "${p.name}" not found.` };
        return { ok: true, result };
    },

    // ── Finding Code ────────────────────────────────────────────────────

    find: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        const exclude = applyTestExclusions(p.exclude, p.includeTests);
        const result = index.find(p.name, {
            file: p.file,
            exact: p.exact || false,
            exclude,
            in: p.in,
        });
        return { ok: true, result };
    },

    usages: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        const exclude = applyTestExclusions(p.exclude, p.includeTests);
        const result = index.usages(p.name, {
            codeOnly: p.codeOnly || false,
            context: num(p.context, 0),
            exclude,
            in: p.in,
        });
        return { ok: true, result };
    },

    toc: (index, p) => {
        const result = index.getToc({
            detailed: p.detailed,
            topLevel: p.topLevel,
            all: p.all,
            top: num(p.top, undefined),
        });
        return { ok: true, result };
    },

    search: (index, p) => {
        const err = requireTerm(p.term);
        if (err) return { ok: false, error: err };
        const exclude = applyTestExclusions(p.exclude, p.includeTests);
        const result = index.search(p.term, {
            codeOnly: p.codeOnly || false,
            context: num(p.context, 0),
            caseSensitive: p.caseSensitive || false,
            exclude,
            in: p.in,
            regex: p.regex,
        });
        return { ok: true, result };
    },

    tests: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        const result = index.tests(p.name, {
            callsOnly: p.callsOnly || false,
        });
        return { ok: true, result };
    },

    deadcode: (index, p) => {
        const result = index.deadcode({
            includeExported: p.includeExported || false,
            includeDecorated: p.includeDecorated || false,
            includeTests: p.includeTests || false,
            exclude: toExcludeArray(p.exclude),
            in: p.in,
        });
        return { ok: true, result };
    },

    // ── File Dependencies ───────────────────────────────────────────────

    imports: (index, p) => {
        const err = requireFile(p.file);
        if (err) return { ok: false, error: err };
        const result = index.imports(p.file);
        const fileErr = checkFileError(result, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        return { ok: true, result };
    },

    exporters: (index, p) => {
        const err = requireFile(p.file);
        if (err) return { ok: false, error: err };
        const result = index.exporters(p.file);
        const fileErr = checkFileError(result, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        return { ok: true, result };
    },

    fileExports: (index, p) => {
        const err = requireFile(p.file);
        if (err) return { ok: false, error: err };
        const result = index.fileExports(p.file);
        const fileErr = checkFileError(result, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        return { ok: true, result };
    },

    graph: (index, p) => {
        const err = requireFile(p.file);
        if (err) return { ok: false, error: err };
        const result = index.graph(p.file, {
            direction: p.direction || 'both',
            maxDepth: num(p.depth, 2),
        });
        const fileErr = checkFileError(result, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        return { ok: true, result };
    },

    // ── Refactoring ─────────────────────────────────────────────────────

    verify: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        const result = index.verify(p.name, { file: p.file });
        return { ok: true, result };
    },

    plan: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        if (!p.addParam && !p.removeParam && !p.renameTo) {
            return { ok: false, error: 'Plan requires an operation: add_param, remove_param, or rename_to.' };
        }
        const result = index.plan(p.name, {
            addParam: p.addParam,
            removeParam: p.removeParam,
            renameTo: p.renameTo,
            defaultValue: p.defaultValue,
            file: p.file,
        });
        return { ok: true, result };
    },

    diffImpact: (index, p) => {
        const result = index.diffImpact({
            base: p.base || 'HEAD',
            staged: p.staged || false,
            file: p.file,
        });
        return { ok: true, result };
    },

    // ── Other ───────────────────────────────────────────────────────────

    typedef: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        const result = index.typedef(p.name, { exact: p.exact || false });
        return { ok: true, result };
    },

    stacktrace: (index, p) => {
        if (!p.stack || (typeof p.stack === 'string' && !p.stack.trim())) {
            return { ok: false, error: 'Stack trace text is required.' };
        }
        const result = index.parseStackTrace(p.stack);
        return { ok: true, result };
    },

    api: (index, p) => {
        const result = index.api(p.file);
        if (p.file) {
            const fileErr = checkFileError(result, p.file);
            if (fileErr) return { ok: false, error: fileErr };
        }
        return { ok: true, result };
    },

    stats: (index, p) => {
        const result = index.getStats({
            functions: p.functions || false,
        });
        return { ok: true, result };
    },
};

// ============================================================================
// MAIN DISPATCH
// ============================================================================

/**
 * Execute a UCN command.
 *
 * @param {object} index - Built ProjectIndex instance
 * @param {string} command - Canonical command name (camelCase)
 * @param {object} params - Normalized parameters
 * @returns {{ ok: boolean, result?: any, error?: string }}
 */
function execute(index, command, params = {}) {
    const handler = HANDLERS[command];
    if (!handler) {
        return { ok: false, error: `Unknown command: ${command}` };
    }
    try {
        return handler(index, params);
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

module.exports = { execute, ADAPTER_ONLY_COMMANDS };
