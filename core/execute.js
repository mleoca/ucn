/**
 * Shared Command Executor — single dispatch for CLI, MCP, and interactive mode.
 *
 * Handles: input validation, exclude normalization, test exclusion, index calls,
 * and code extraction (fn, class, lines).
 *
 * Each handler returns { ok: true, result } or { ok: false, error }.
 * Adapters handle formatting, path security (MCP), and surface-specific concerns.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { addTestExclusions, pickBestDefinition } = require('./shared');
const { cleanHtmlScriptTags, detectLanguage } = require('./parser');

// Commands handled directly by adapters (not in HANDLERS below).
// expand needs per-session cache state that differs by surface.
const ADAPTER_ONLY_COMMANDS = new Set(['expand']);

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

/** Read a file and extract lines for a symbol match, applying HTML cleanup. */
function readAndExtract(match) {
    const content = fs.readFileSync(match.file, 'utf-8');
    const lines = content.split('\n');
    const extracted = lines.slice(match.startLine - 1, match.endLine);
    return cleanHtmlScriptTags(extracted, detectLanguage(match.file)).join('\n');
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

    // ── Extracting Code ─────────────────────────────────────────────────

    fn: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };

        const fnNames = p.name.includes(',')
            ? p.name.split(',').map(n => n.trim()).filter(Boolean)
            : [p.name];

        const entries = [];
        const notes = [];

        for (const fnName of fnNames) {
            const matches = index.find(fnName, { file: p.file })
                .filter(m => m.type === 'function' || m.params !== undefined);

            if (matches.length === 0) {
                notes.push(`Function "${fnName}" not found.`);
                continue;
            }

            if (matches.length > 1 && !p.file && p.all) {
                for (const m of matches) {
                    const code = readAndExtract(m);
                    entries.push({ match: m, code });
                }
                continue;
            }

            const match = matches.length > 1 && !p.file
                ? pickBestDefinition(matches)
                : matches[0];

            if (matches.length > 1 && !p.file) {
                const others = matches.filter(m => m !== match)
                    .map(m => `${m.relativePath}:${m.startLine}`).join(', ');
                notes.push(`Found ${matches.length} definitions for "${fnName}". Showing ${match.relativePath}:${match.startLine}. Also in: ${others}. Use --file to disambiguate or --all to show all.`);
            }

            const code = readAndExtract(match);
            entries.push({ match, code });
        }

        if (entries.length === 0 && notes.length > 0) {
            return { ok: false, error: notes.join('\n') };
        }
        return { ok: true, result: { entries, notes } };
    },

    class: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };

        const CLASS_TYPES = ['class', 'interface', 'type', 'enum', 'struct', 'trait'];
        const matches = index.find(p.name, { file: p.file })
            .filter(m => CLASS_TYPES.includes(m.type));

        if (matches.length === 0) {
            return { ok: false, error: `Class "${p.name}" not found.` };
        }

        const entries = [];
        const notes = [];
        const maxLines = num(p.maxLines, null);

        if (matches.length > 1 && !p.file && p.all) {
            for (const m of matches) {
                const code = readAndExtract(m);
                const totalLines = m.endLine - m.startLine + 1;
                entries.push({ match: m, code, totalLines, summaryMode: false, truncated: false });
            }
            return { ok: true, result: { entries, notes } };
        }

        const match = matches.length > 1 && !p.file
            ? pickBestDefinition(matches)
            : matches[0];

        if (matches.length > 1 && !p.file) {
            const others = matches.filter(m => m !== match)
                .map(m => `${m.relativePath}:${m.startLine}`).join(', ');
            notes.push(`Found ${matches.length} definitions for "${p.name}". Showing ${match.relativePath}:${match.startLine}. Also in: ${others}. Use --file to disambiguate or --all to show all.`);
        }

        const totalLines = match.endLine - match.startLine + 1;

        // Large class summary mode (>200 lines, no maxLines)
        if (totalLines > 200 && !maxLines) {
            const methods = index.findMethodsForType(match.name);
            entries.push({ match, code: null, methods, totalLines, summaryMode: true, truncated: false });
            return { ok: true, result: { entries, notes } };
        }

        // Truncated mode (maxLines specified and class exceeds it)
        if (maxLines && totalLines > maxLines) {
            const content = fs.readFileSync(match.file, 'utf-8');
            const fileLines = content.split('\n');
            const truncated = fileLines.slice(match.startLine - 1, match.startLine - 1 + maxLines);
            const code = cleanHtmlScriptTags(truncated, detectLanguage(match.file)).join('\n');
            entries.push({ match, code, totalLines, summaryMode: false, truncated: true, maxLines });
            return { ok: true, result: { entries, notes } };
        }

        // Full extraction
        const code = readAndExtract(match);
        entries.push({ match, code, totalLines, summaryMode: false, truncated: false });
        return { ok: true, result: { entries, notes } };
    },

    lines: (index, p) => {
        const err = requireFile(p.file);
        if (err) return { ok: false, error: err };
        if (!p.range || (typeof p.range === 'string' && !p.range.trim())) {
            return { ok: false, error: 'Line range is required (e.g. "10-20" or "15").' };
        }

        const parts = p.range.split('-');
        const rawStart = parseInt(parts[0], 10);
        const rawEnd = parts.length > 1 ? parseInt(parts[1], 10) : rawStart;

        if (isNaN(rawStart) || isNaN(rawEnd)) {
            return { ok: false, error: `Invalid line range: "${p.range}". Expected format: <start>-<end> or <line>.` };
        }
        if (rawStart < 1 || rawEnd < 1) {
            return { ok: false, error: 'Invalid line range: line numbers must be >= 1.' };
        }

        // Auto-swap reversed ranges
        const startLine = Math.min(rawStart, rawEnd);
        const endLine = Math.max(rawStart, rawEnd);

        const filePath = index.findFile(p.file);
        if (!filePath) {
            return { ok: false, error: `File not found in project: ${p.file}` };
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const fileLines = content.split('\n');

        if (startLine > fileLines.length) {
            return { ok: false, error: `Line ${startLine} is out of bounds. File has ${fileLines.length} lines.` };
        }

        const actualEnd = Math.min(endLine, fileLines.length);
        const extracted = [];
        for (let i = startLine - 1; i < actualEnd; i++) {
            extracted.push(fileLines[i]);
        }

        return {
            ok: true,
            result: {
                filePath,
                relativePath: path.relative(index.root, filePath),
                lines: extracted,
                startLine,
                endLine: actualEnd,
            },
        };
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
