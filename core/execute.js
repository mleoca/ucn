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
const { renderExpandItem } = require('./expand-cache');

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

/**
 * Split Class.method syntax into className and methodName.
 * Returns { className, methodName } or null if not applicable.
 * Handles: "Class.method" → { className: "Class", methodName: "method" }
 * Skips: ".method", "a.b.c" (multi-dot), names without dots
 */
function splitClassMethod(name) {
    if (!name || typeof name !== 'string') return null;
    const dotIndex = name.indexOf('.');
    if (dotIndex <= 0 || dotIndex === name.length - 1) return null;
    // Only split on first dot, and only if there's exactly one dot
    if (name.indexOf('.', dotIndex + 1) !== -1) return null;
    return {
        className: name.substring(0, dotIndex),
        methodName: name.substring(dotIndex + 1)
    };
}

/**
 * Apply Class.method syntax to params object.
 * If name contains ".", splits it and sets p.name and p.className.
 * Only applies if p.className is not already set.
 */
function applyClassMethodSyntax(p) {
    if (p.className) return; // already set explicitly
    const split = splitClassMethod(p.name);
    if (split) {
        p.name = split.methodName;
        p.className = split.className;
    }
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

/**
 * Validate that className filter actually matches a definition.
 * Returns error string if className is invalid, null if OK.
 */
function validateClassName(index, name, className) {
    if (!className) return null;
    const allDefs = index.symbols.get(name);
    if (!allDefs || allDefs.length === 0) return null; // no defs at all — let the command handle "not found"
    const matching = allDefs.filter(d => d.className === className);
    if (matching.length > 0) return null; // className matched
    // className specified but no definitions match
    const available = [...new Set(allDefs.filter(d => d.className).map(d => d.className))];
    if (available.length > 0) {
        return `Symbol "${name}" not found in class "${className}". Available in: ${available.join(', ')}.`;
    }
    return `Symbol "${name}" is not a method of any class. Defined in: ${allDefs[0].relativePath}:${allDefs[0].startLine}.`;
}

/** Parse a number param (handles string from CLI, number from MCP). */
function num(val, fallback) {
    if (val == null) return fallback;
    const n = Number(val);
    return isNaN(n) ? fallback : n;
}

/**
 * Apply limit to an array result.
 * Returns { items, total, limited } where limited is true if truncated.
 */
function applyLimit(arr, limit) {
    if (!arr || !limit || limit <= 0 || arr.length <= limit) {
        return { items: arr, total: arr ? arr.length : 0, limited: false };
    }
    return { items: arr.slice(0, limit), total: arr.length, limited: true };
}

/** Build a limit note string */
function limitNote(limit, total) {
    return `Showing ${limit} of ${total} results. Use --limit N to see more.`;
}

/**
 * Check if a --file pattern matches any files in the index.
 * Returns error string if no files match, null otherwise.
 */
function checkFilePatternMatch(index, filePattern) {
    if (!filePattern) return null;
    for (const [, fileEntry] of index.files) {
        if (fileEntry.relativePath.includes(filePattern)) return null;
    }
    // Suggest similar directories/files to help user refine
    const patternLower = filePattern.toLowerCase();
    const basename = filePattern.split('/').pop().toLowerCase();
    const suggestions = new Set();
    for (const [, fileEntry] of index.files) {
        const rp = fileEntry.relativePath.toLowerCase();
        // Check if any path component contains the last segment of the pattern
        if (basename && rp.includes(basename)) {
            // Extract the directory containing the match
            const dir = fileEntry.relativePath.split('/').slice(0, -1).join('/');
            if (dir) suggestions.add(dir);
            if (suggestions.size >= 5) break;
        }
    }
    if (suggestions.size > 0) {
        return `No files matched pattern '${filePattern}'. Similar paths:\n${[...suggestions].map(s => '  ' + s).join('\n')}`;
    }
    return `No files matched pattern '${filePattern}'.`;
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
        applyClassMethodSyntax(p);
        const result = index.about(p.name, {
            withTypes: p.withTypes || false,
            file: p.file,
            className: p.className,
            all: p.all,
            includeMethods: p.includeMethods,
            includeUncertain: p.includeUncertain || false,
            exclude: toExcludeArray(p.exclude),
            maxCallers: num(p.top, undefined),
            maxCallees: num(p.top, undefined),
            minConfidence: num(p.minConfidence, 0),
        });
        if (!result) {
            // Give better error if file/className filter is the problem
            if (p.file || p.className) {
                // Show ALL definitions so user can pick the right file= filter
                const allDefs = index.symbols.get(p.name) || [];
                if (allDefs.length > 0) {
                    const filterDesc = p.className ? `class "${p.className}"` : `file "${p.file}"`;
                    const locations = allDefs
                        .slice(0, 10)
                        .map(d => `  ${d.relativePath}:${d.startLine}${d.className ? ` (${d.className})` : ''}`)
                        .join('\n');
                    const more = allDefs.length > 10 ? `\n  ... and ${allDefs.length - 10} more` : '';
                    return { ok: false, error: `Symbol "${p.name}" not found in ${filterDesc}. Found ${allDefs.length} definition(s) elsewhere:\n${locations}${more}\nUse file= with a path fragment from the list above to disambiguate.` };
                }
            }
            return { ok: false, error: `Symbol "${p.name}" not found.` };
        }
        return { ok: true, result, showConfidence: !!p.showConfidence };
    },

    context: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        const result = index.context(p.name, {
            includeMethods: p.includeMethods,
            includeUncertain: p.includeUncertain || false,
            file: p.file,
            className: p.className,
            exclude: toExcludeArray(p.exclude),
            minConfidence: num(p.minConfidence, 0),
        });
        if (!result) return { ok: false, error: `Symbol "${p.name}" not found.` };
        return { ok: true, result, showConfidence: !!p.showConfidence };
    },

    impact: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        const result = index.impact(p.name, {
            file: p.file,
            className: p.className,
            exclude: toExcludeArray(p.exclude),
            top: num(p.top, undefined),
        });
        if (!result) return { ok: false, error: `Function "${p.name}" not found.` };
        return { ok: true, result };
    },

    blast: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        const depthVal = num(p.depth, undefined);
        const result = index.blast(p.name, {
            depth: depthVal ?? 3,
            file: p.file,
            className: p.className,
            all: p.all || depthVal !== undefined,
            exclude: toExcludeArray(p.exclude),
            includeMethods: p.includeMethods,
            includeUncertain: p.includeUncertain || false,
        });
        if (!result) return { ok: false, error: `Function "${p.name}" not found.` };
        return { ok: true, result };
    },

    reverseTrace: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        const depthVal = num(p.depth, undefined);
        const result = index.reverseTrace(p.name, {
            depth: depthVal ?? 5,
            file: p.file,
            className: p.className,
            all: p.all || depthVal !== undefined,
            exclude: toExcludeArray(p.exclude),
            includeMethods: p.includeMethods,
            includeUncertain: p.includeUncertain || false,
        });
        if (!result) return { ok: false, error: `Function "${p.name}" not found.` };
        return { ok: true, result };
    },

    smart: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const result = index.smart(p.name, {
            file: p.file,
            className: p.className,
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
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const depthVal = num(p.depth, undefined);
        const result = index.trace(p.name, {
            depth: depthVal ?? 3,
            file: p.file,
            className: p.className,
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
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const result = index.example(p.name, { file: p.file, className: p.className });
        if (!result) return { ok: false, error: `No examples found for "${p.name}".` };
        return { ok: true, result };
    },

    related: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const result = index.related(p.name, {
            file: p.file,
            className: p.className,
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
        applyClassMethodSyntax(p);
        // Check if --file pattern matches any files
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        // Auto-include tests when pattern clearly targets test functions
        // But only if the user didn't explicitly set include_tests=false
        let includeTests = p.includeTests;
        if (includeTests === undefined && p.name && /^test[_*?A-Z]/i.test(p.name)) {
            includeTests = true;
        }
        const exclude = applyTestExclusions(p.exclude, includeTests);
        let result = index.find(p.name, {
            file: p.file,
            className: p.className,
            exact: p.exact || false,
            exclude,
            in: p.in,
        });
        // Warn if exact mode silently disables glob expansion
        const notes = [];
        if (p.exact && p.name && (p.name.includes('*') || p.name.includes('?'))) {
            notes.push(`Note: exact=true treats "${p.name}" as a literal name (glob expansion disabled).`);
        }
        // Apply limit
        const limit = num(p.limit, undefined);
        if (limit && limit > 0) {
            const { items, total, limited } = applyLimit(result, limit);
            if (limited) notes.push(limitNote(limit, total));
            result = items;
        }
        return { ok: true, result, note: notes.length ? notes.join('\n') : undefined };
    },

    usages: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const exclude = applyTestExclusions(p.exclude, p.includeTests);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const result = index.usages(p.name, {
            codeOnly: p.codeOnly || false,
            context: num(p.context, 0),
            className: p.className,
            file: p.file,
            exclude,
            in: p.in,
        });
        // Apply limit to total usages (result is a flat array)
        const limit = num(p.limit, undefined);
        let note;
        let limited = result;
        if (limit && limit > 0 && Array.isArray(result) && result.length > limit) {
            note = limitNote(limit, result.length);
            limited = result.slice(0, limit);
        }
        return { ok: true, result: limited, note };
    },

    toc: (index, p) => {
        const result = index.getToc({
            detailed: p.detailed,
            topLevel: p.topLevel,
            all: p.all,
            top: num(p.top, undefined),
            file: p.file,
            exclude: p.exclude,
            in: p.in,
        });
        // Apply limit to detailed toc entries (symbols are in f.symbols.functions/classes arrays)
        const limit = num(p.limit, undefined);
        let note;
        if (limit && limit > 0 && p.detailed && result.files) {
            let totalEntries = result.files.reduce((s, f) => {
                const syms = f.symbols || {};
                return s + (syms.functions?.length || 0) + (syms.classes?.length || 0);
            }, 0);
            if (totalEntries > limit) {
                let remaining = limit;
                for (const f of result.files) {
                    const syms = f.symbols || {};
                    if (remaining <= 0) {
                        if (syms.functions) syms.functions = [];
                        if (syms.classes) syms.classes = [];
                        f.functions = 0;
                        f.classes = 0;
                        continue;
                    }
                    const fns = syms.functions?.length || 0;
                    const cls = syms.classes?.length || 0;
                    if (fns + cls <= remaining) {
                        remaining -= fns + cls;
                    } else {
                        if (syms.functions && remaining > 0) {
                            syms.functions = syms.functions.slice(0, remaining);
                            remaining -= syms.functions.length;
                            f.functions = syms.functions.length;
                        }
                        if (syms.classes && remaining > 0) {
                            syms.classes = syms.classes.slice(0, remaining);
                            remaining -= syms.classes.length;
                            f.classes = syms.classes.length;
                        } else if (syms.classes) {
                            syms.classes = [];
                            f.classes = 0;
                        }
                    }
                }
                note = limitNote(limit, totalEntries);
            }
        }
        return { ok: true, result, note };
    },

    search: (index, p) => {
        // Detect structural search mode: any of these flags triggers index-based search
        const isStructural = p.type || p.param || p.receiver || p.returns || p.decorator || p.exported || p.unused;
        if (isStructural) {
            const exclude = applyTestExclusions(p.exclude, p.includeTests);
            const topVal = num(p.top, undefined) || num(p.limit, undefined);
            const result = index.structuralSearch({
                term: p.term || p.name,
                type: p.type,
                param: p.param,
                receiver: p.receiver,
                returns: p.returns,
                decorator: p.decorator,
                exported: p.exported || false,
                unused: p.unused || false,
                caseSensitive: p.caseSensitive || false,
                exclude,
                in: p.in,
                file: p.file,
                top: topVal || 50,
            });
            if (result.meta.error) return { ok: false, error: result.meta.error };
            return { ok: true, result, structural: true };
        }

        const err = requireTerm(p.term);
        if (err) return { ok: false, error: err };
        const testsExcluded = !p.includeTests;
        const exclude = applyTestExclusions(p.exclude, p.includeTests);
        // Use limit as top if top not set
        const topVal = num(p.top, undefined) || num(p.limit, undefined);
        const result = index.search(p.term, {
            codeOnly: p.codeOnly || false,
            context: num(p.context, 0),
            caseSensitive: p.caseSensitive || false,
            exclude,
            in: p.in,
            regex: p.regex,
            top: topVal,
            file: p.file,
        });
        if (result.meta) result.meta.testsExcluded = testsExcluded;
        return { ok: true, result };
    },

    tests: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const result = index.tests(p.name, {
            callsOnly: p.callsOnly || false,
            className: p.className,
        });
        return { ok: true, result };
    },

    affectedTests: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        const depthVal = num(p.depth, undefined);
        const result = index.affectedTests(p.name, {
            depth: depthVal ?? 3,
            file: p.file,
            className: p.className,
            exclude: toExcludeArray(p.exclude),
            includeMethods: p.includeMethods,
            includeUncertain: p.includeUncertain || false,
        });
        if (!result) return { ok: false, error: `Function "${p.name}" not found.` };
        return { ok: true, result };
    },

    deadcode: (index, p) => {
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        let result = index.deadcode({
            includeExported: p.includeExported || false,
            includeDecorated: p.includeDecorated || false,
            includeTests: p.includeTests || false,
            exclude: toExcludeArray(p.exclude),
            in: p.in,
            file: p.file,
        });
        // Apply limit to dead code results (result is an array with custom properties)
        const limit = num(p.limit, undefined);
        let note;
        if (limit && limit > 0 && Array.isArray(result) && result.length > limit) {
            note = limitNote(limit, result.length);
            const sliced = result.slice(0, limit);
            // Preserve custom properties (excludedExported, excludedDecorated) from deadcode()
            if (result.excludedExported != null) sliced.excludedExported = result.excludedExported;
            if (result.excludedDecorated != null) sliced.excludedDecorated = result.excludedDecorated;
            result = sliced;
        }
        return { ok: true, result, note };
    },

    entrypoints: (index, p) => {
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const { detectEntrypoints } = require('./entrypoints');
        const result = detectEntrypoints(index, {
            type: p.type,
            framework: p.framework,
            file: p.file,
            exclude: p.exclude,
        });
        return { ok: true, result };
    },

    // ── Extracting Code ─────────────────────────────────────────────────

    fn: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };

        const fnNames = p.name.includes(',')
            ? p.name.split(',').map(n => n.trim()).filter(Boolean)
            : [p.name];

        const entries = [];
        const notes = [];

        for (const fnName of fnNames) {
            // For comma-separated names, each may have Class.method syntax
            const fnSplit = splitClassMethod(fnName);
            const actualName = fnSplit ? fnSplit.methodName : fnName;
            const fnClassName = fnSplit ? fnSplit.className : p.className;
            const matches = index.find(actualName, { file: p.file, className: fnClassName, skipCounts: true })
                .filter(m => m.type === 'function' || m.params !== undefined);

            if (matches.length === 0) {
                // Check if it's a class — suggest `class` command instead
                const CLASS_TYPES = ['class', 'interface', 'type', 'enum', 'struct', 'trait'];
                const classMatches = index.find(actualName, { file: p.file, className: fnClassName, skipCounts: true })
                    .filter(m => CLASS_TYPES.includes(m.type));
                if (classMatches.length > 0) {
                    notes.push(`"${fnName}" is a ${classMatches[0].type}, not a function. Use \`class ${fnName}\` instead.`);
                } else {
                    notes.push(`Function "${fnName}" not found.`);
                }
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
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };

        const CLASS_TYPES = ['class', 'interface', 'type', 'enum', 'struct', 'trait'];
        const matches = index.find(p.name, { file: p.file, skipCounts: true })
            .filter(m => CLASS_TYPES.includes(m.type));

        if (matches.length === 0) {
            return { ok: false, error: `Class "${p.name}" not found.` };
        }

        const entries = [];
        const notes = [];
        const maxLines = num(p.maxLines, null);

        if (p.maxLines != null && (maxLines === null || !Number.isInteger(maxLines) || maxLines < 1)) {
            return { ok: false, error: '--max-lines must be a positive integer.' };
        }

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

        const rangeStr = String(p.range).trim();
        const rangeMatch = rangeStr.match(/^(\d+)(?:-(\d+))?$/);
        if (!rangeMatch) {
            return { ok: false, error: `Invalid line range: "${p.range}". Expected format: <start>-<end> or <line>.` };
        }

        const rawStart = parseInt(rangeMatch[1], 10);
        const rawEnd = rangeMatch[2] !== undefined ? parseInt(rangeMatch[2], 10) : rawStart;
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

    circularDeps: (index, p) => {
        const result = index.circularDeps({
            file: p.file,
            exclude: toExcludeArray(p.exclude),
        });
        return { ok: true, result };
    },

    // ── Refactoring ─────────────────────────────────────────────────────

    verify: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        const result = index.verify(p.name, { file: p.file, className: p.className });
        return { ok: true, result };
    },

    plan: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        if (!p.addParam && !p.removeParam && !p.renameTo) {
            return { ok: false, error: 'Plan requires an operation: add_param, remove_param, or rename_to.' };
        }
        const result = index.plan(p.name, {
            addParam: p.addParam,
            removeParam: p.removeParam,
            renameTo: p.renameTo,
            defaultValue: p.defaultValue,
            file: p.file,
            className: p.className,
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
        applyClassMethodSyntax(p);
        const result = index.typedef(p.name, { exact: p.exact || false, className: p.className, file: p.file });
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
        let result = index.api(p.file);
        if (p.file) {
            const fileErr = checkFileError(result, p.file);
            if (fileErr) return { ok: false, error: fileErr };
        }
        // Apply limit to api results (api returns an array)
        const limit = num(p.limit, undefined);
        let note;
        if (limit && limit > 0 && Array.isArray(result)) {
            const { items, total, limited } = applyLimit(result, limit);
            if (limited) note = limitNote(limit, total);
            result = items;
        }
        return { ok: true, result, note };
    },

    stats: (index, p) => {
        const result = index.getStats({
            functions: p.functions || false,
        });
        return { ok: true, result };
    },

    // ── Expand (context drill-down) ──────────────────────────────────────

    expand: (index, p) => {
        if (p.itemNum == null || isNaN(p.itemNum)) {
            return { ok: false, error: 'Item number is required.' };
        }
        if (!p.match) {
            if (p.itemCount > 0) {
                const scopeHint = p.symbolName ? ` (from context for "${p.symbolName}")` : '';
                return { ok: false, error: `Item ${p.itemNum} not found${scopeHint}. Available: 1-${p.itemCount}` };
            }
            return { ok: false, error: 'No expandable items. Run context first.' };
        }
        const rendered = renderExpandItem(p.match, index.root, { validateRoot: p.validateRoot || false });
        if (!rendered.ok) return { ok: false, error: rendered.error };
        return { ok: true, result: rendered };
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

module.exports = { execute };
