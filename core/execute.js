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
const { addTestExclusions, pickBestDefinition, parseSymbolHandle, looksLikeHandle } = require('./shared');
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
 * When p.className is already set, still split the name to extract the method
 * part (explicit --class-name takes precedence over the class from dot notation).
 */
function applyClassMethodSyntax(p) {
    // Run handle normalization first — handles can be passed where a name is expected.
    applyHandleSyntax(p);
    const split = splitClassMethod(p.name);
    if (split) {
        p.name = split.methodName;
        if (!p.className) p.className = split.className;
    }
}

/**
 * If p.name is a stable handle (file:line[:name]), parse it and set p.name,
 * p.file, p.line so downstream resolution targets the exact symbol. Idempotent.
 *
 * Why: lets multi-step workflows roundtrip without name disambiguation. A
 * `find` result emits `lib/api.ts:42:handler`; piping that to `brief`/`impact`
 * pins resolution to that exact definition even if 5 other `handler`s exist.
 */
function applyHandleSyntax(p) {
    if (!p || !p.name) return;
    if (!looksLikeHandle(p.name)) return;
    const h = parseSymbolHandle(p.name);
    if (!h) return;
    // Pull name out of handle. If the handle has no name suffix, we need to
    // recover it from the index — but at this layer we only have params.
    // The downstream resolveSymbol path will look up by file+line if name is empty.
    if (h.name) p.name = h.name;
    // Only override p.file/p.line if they weren't explicitly set by the user
    if (h.file && !p.file) p.file = h.file;
    if (h.line && !p.line) p.line = h.line;
}

/** Normalize exclude to an array (accepts string CSV, array, or falsy). */
function toExcludeArray(exclude) {
    if (!exclude) return [];
    if (Array.isArray(exclude)) return exclude.map(String);
    // Programmatic callers can pass anything — a number here used to
    // surface the raw "exclude.split is not a function" TypeError (fix #245).
    return String(exclude).split(',').map(s => s.trim()).filter(Boolean);
}

/** Apply test exclusions unless includeTests is set. */
function applyTestExclusions(exclude, includeTests) {
    const arr = toExcludeArray(exclude);
    return includeTests ? arr : addTestExclusions(arr);
}

/**
 * Build common caller/callee analysis options from handler params.
 * Used by about, context, blast, reverseTrace, smart, trace, affectedTests.
 */
function buildCallerOptions(p) {
    return {
        file: p.file,
        className: p.className,
        ...(p.line && { line: p.line }),
        includeMethods: p.includeMethods,
        includeUncertain: p.includeUncertain || false,
        includeTests: p.includeTests,
        exclude: toExcludeArray(p.exclude),
        minConfidence: num(p.minConfidence, 0),
    };
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

/** Build a truncation warning when index is incomplete */
function truncationNote(index) {
    if (!index.truncated) return null;
    return `Index limited to ${index.truncated.indexed} files (max ${index.truncated.maxFiles}). Results may be incomplete. Use --max-files N to increase.`;
}

/** Build notes for tree-based results (blast, trace, reverseTrace, affectedTests). */
function treeNote(result) {
    const parts = [];
    // result.warnings are NOT copied here — the tree formatters render them
    // in the body (Note: lines under the header); copying them into the
    // handler note printed each warning twice (fix #237).
    if (result?.tree?.truncatedChildren > 0) {
        parts.push(`${result.tree.truncatedChildren} children truncated. Use --depth=N or --all to expand.`);
    }
    if (result?.truncatedCallers > 0) {
        parts.push(`${result.truncatedCallers} callers truncated. Use --all to expand.`);
    }
    return parts.length > 0 ? parts.join('\n') : null;
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

/**
 * Definition-pin validation for commands that analyze ONE symbol: when
 * `file`/`line` are given, some definition of the symbol must actually match
 * them. Without this, resolution silently falls back to the full definition
 * set and the command answers about a DIFFERENT definition than the one the
 * user pinned. Returns an error string, or null when the pin is satisfiable
 * (or when the symbol has no definitions at all — the not-found path
 * downstream owns that case).
 */
function checkDefinitionPin(index, p) {
    if (!p.name || (!p.file && !p.line)) return null;
    const defs = index.symbols.get(p.name) || [];
    if (defs.length === 0) return null;
    let candidates = defs;
    if (p.className) {
        const byClass = candidates.filter(d => d.className === p.className);
        if (byClass.length > 0) candidates = byClass;
    }
    const describe = (list) => {
        const shown = list.slice(0, 10)
            .map(d => `  ${d.relativePath}:${d.startLine}${d.className ? ` (${d.className})` : ''}`)
            .join('\n');
        return list.length > 10 ? `${shown}\n  ... and ${list.length - 10} more` : shown;
    };
    if (p.file) {
        const byFile = candidates.filter(d => d.relativePath && d.relativePath.includes(p.file));
        if (byFile.length === 0) {
            return `Symbol "${p.name}" not found in files matching "${p.file}". Found ${candidates.length} definition(s) elsewhere:\n${describe(candidates)}\nUse file= with a path fragment from the list above to disambiguate.`;
        }
        candidates = byFile;
    }
    const line = Number(p.line);
    if (p.line && Number.isFinite(line)) {
        const atLine = candidates.filter(d => d.startLine === line);
        if (atLine.length === 0) {
            return `No definition of "${p.name}" at line ${line}${p.file ? ` in files matching "${p.file}"` : ''}. Definitions:\n${describe(candidates)}`;
        }
    }
    return null;
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
            ...buildCallerOptions(p),
            withTypes: p.withTypes || false,
            all: p.all,
            maxCallers: num(p.top, undefined),
            maxCallees: num(p.top, undefined),
            unreachableOnly: !!p.unreachableOnly,
            git: !!p.git,
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
        const tNote = truncationNote(index);
        return { ok: true, result, showConfidence: !!p.showConfidence, ...(tNote && { note: tNote }) };
    },

    context: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        const pinErr = checkDefinitionPin(index, p);
        if (pinErr) return { ok: false, error: pinErr };
        const result = index.context(p.name, {
            ...buildCallerOptions(p),
            unreachableOnly: !!p.unreachableOnly,
            all: !!p.all,
        });
        if (!result) return { ok: false, error: `Symbol "${p.name}" not found.` };
        const tNote = truncationNote(index);
        return { ok: true, result, showConfidence: !!p.showConfidence, ...(tNote && { note: tNote }) };
    },

    impact: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        const pinErr = checkDefinitionPin(index, p);
        if (pinErr) return { ok: false, error: pinErr };
        const result = index.impact(p.name, {
            file: p.file,
            className: p.className,
            exclude: toExcludeArray(p.exclude),
            top: num(p.top, undefined),
            unreachableOnly: !!p.unreachableOnly,
            // BUG-H3: pass through user-supplied flags. impact defaults to including
            // method calls because "what breaks if I change this" should include
            // every callable site, not just bare-name calls. User can disable with
            // --no-include-methods.
            ...(p.includeMethods !== undefined && { includeMethods: p.includeMethods }),
            ...(p.includeUncertain !== undefined && { includeUncertain: p.includeUncertain }),
        });
        if (!result) return { ok: false, error: `Function "${p.name}" not found.` };
        const tNote = truncationNote(index);
        return { ok: true, result, ...(tNote && { note: tNote }) };
    },

    blast: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        const pinErr = checkDefinitionPin(index, p);
        if (pinErr) return { ok: false, error: pinErr };
        const depthVal = num(p.depth, undefined);
        const result = index.blast(p.name, {
            ...buildCallerOptions(p),
            depth: depthVal ?? 3,
            all: p.all || depthVal !== undefined,
            expandUnverified: !!p.expandUnverified,
        });
        if (!result) return { ok: false, error: `Function "${p.name}" not found.` };
        const note = treeNote(result);
        const tNote = truncationNote(index);
        const combined = [note, tNote].filter(Boolean).join('\n') || undefined;
        return { ok: true, result, ...(combined && { note: combined }) };
    },

    reverseTrace: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        const pinErr = checkDefinitionPin(index, p);
        if (pinErr) return { ok: false, error: pinErr };
        const depthVal = num(p.depth, undefined);
        const result = index.reverseTrace(p.name, {
            ...buildCallerOptions(p),
            depth: depthVal ?? 5,
            all: p.all || depthVal !== undefined,
            expandUnverified: !!p.expandUnverified,
        });
        if (!result) return { ok: false, error: `Function "${p.name}" not found.` };
        const note = treeNote(result);
        const tNote = truncationNote(index);
        const combined = [note, tNote].filter(Boolean).join('\n') || undefined;
        return { ok: true, result, ...(combined && { note: combined }) };
    },

    smart: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        const pinErr = checkDefinitionPin(index, p);
        if (pinErr) return { ok: false, error: pinErr };
        const result = index.smart(p.name, {
            ...buildCallerOptions(p),
            withTypes: p.withTypes || false,
        });
        if (!result) return { ok: false, error: `Function "${p.name}" not found.` };
        const tNote = truncationNote(index);
        return { ok: true, result, ...(tNote && { note: tNote }) };
    },

    trace: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        const pinErr = checkDefinitionPin(index, p);
        if (pinErr) return { ok: false, error: pinErr };
        const depthVal = num(p.depth, undefined);
        const result = index.trace(p.name, {
            ...buildCallerOptions(p),
            depth: depthVal ?? 3,
            all: p.all || depthVal !== undefined,
            expandUnverified: !!p.expandUnverified,
        });
        if (!result) return { ok: false, error: `Function "${p.name}" not found.` };
        const note = treeNote(result);
        const tNote = truncationNote(index);
        const combined = [note, tNote].filter(Boolean).join('\n') || undefined;
        return { ok: true, result, ...(combined && { note: combined }) };
    },

    example: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        const result = index.example(p.name, {
            file: p.file,
            className: p.className,
            diverse: !!p.diverse,
            top: num(p.top, undefined),
            // MEDIUM-8: thread includeTests so test-file callers are included
            // when the user asks for them.
            includeTests: !!p.includeTests,
        });
        if (!result) return { ok: false, error: `No examples found for "${p.name}".` };
        // MEDIUM-8: when no non-test examples found but test-file usages
        // exist, the formatter surfaces that fact in the body ("No call
        // examples found ... excluded N test-file usages") — no handler
        // note, which printed the same message twice (fix #237).
        return { ok: true, result };
    },

    related: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const pinErr = checkDefinitionPin(index, p);
        if (pinErr) return { ok: false, error: pinErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        const result = index.related(p.name, {
            file: p.file,
            className: p.className,
            top: num(p.top, undefined),
            all: p.all,
        });
        if (!result) return { ok: false, error: `Function "${p.name}" not found.` };
        const parts = [];
        if (result.similarNamesTotal > result.similarNames.length)
            parts.push(`similar names: showing ${result.similarNames.length} of ${result.similarNamesTotal}`);
        if (result.sharedCallersTotal > result.sharedCallers.length)
            parts.push(`shared callers: showing ${result.sharedCallers.length} of ${result.sharedCallersTotal}`);
        if (result.sharedCalleesTotal > result.sharedCallees.length)
            parts.push(`shared callees: showing ${result.sharedCallees.length} of ${result.sharedCalleesTotal}`);
        const relatedNote = parts.length ? `Truncated: ${parts.join(', ')}. Use --all to show all.` : null;
        const tNote = truncationNote(index);
        const combined = [relatedNote, tNote].filter(Boolean).join('\n') || undefined;
        return { ok: true, result, ...(combined && { note: combined }) };
    },

    brief: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        const pinErr = checkDefinitionPin(index, p);
        if (pinErr) return { ok: false, error: pinErr };
        const { brief } = require('./brief');
        const result = brief(index, p.name, { file: p.file, className: p.className, git: !!p.git });
        if (!result) return { ok: false, error: `Symbol "${p.name}" not found.` };
        return { ok: true, result };
    },

    doctor: (index, p) => {
        const { doctor } = require('./reporting');
        const result = doctor(index, {
            in: p.in,
            file: p.file,
            deep: !!p.deep,
            sampleSize: num(p.limit, undefined),
        });
        return { ok: true, result };
    },

    check: (index, p) => {
        const { check } = require('./check');
        try {
            const result = check(index, {
                base: p.base || 'HEAD',
                staged: !!p.staged,
                file: p.file,
                limit: num(p.limit, undefined),
            });
            return { ok: true, result };
        } catch (e) {
            return { ok: false, error: e && e.message ? e.message : String(e) };
        }
    },

    // ── Finding Code ────────────────────────────────────────────────────

    find: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        // Check if --file pattern matches any files
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        if (p.className) {
            const classErr = validateClassName(index, p.name, p.className);
            if (classErr) return { ok: false, error: classErr };
        }
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
        const tNote = truncationNote(index);
        if (tNote) notes.push(tNote);
        return { ok: true, result, note: notes.length ? notes.join('\n') : undefined };
    },

    usages: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const exclude = applyTestExclusions(p.exclude, p.includeTests);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        if (p.className) {
            const classErr = validateClassName(index, p.name, p.className);
            if (classErr) return { ok: false, error: classErr };
        }
        // Scan once WITHOUT the default test exclusion, then filter in the
        // handler — the hidden count must be VISIBLE (fix #234, campaign
        // G2-java: usages silently hid test-file usages while search noted
        // them — a silently incomplete answer from the raw escape hatch).
        // Normalize the user's exclude first (fix #239): MCP delivers a CSV
        // STRING, and matchesFilters iterates its CHARACTERS — exclude=test
        // emptied every TypeScript project ('t' matched the .ts extension).
        const userExclude = toExcludeArray(p.exclude);
        const unfiltered = index.usages(p.name, {
            codeOnly: p.codeOnly || false,
            context: num(p.context, 0),
            className: p.className,
            file: p.file,
            exclude: userExclude,
            in: p.in,
        });
        const notes = [];
        let result = unfiltered;
        if (exclude.length !== userExclude.length && Array.isArray(unfiltered)) {
            result = unfiltered.filter(u => index.matchesFilters(u.relativePath, { exclude }));
            const hidden = unfiltered.length - result.length;
            if (hidden > 0) notes.push(`${hidden} test-file usage(s) hidden by default — pass --include-tests to include them.`);
        }
        // Apply limit to total usages (result is a flat array)
        const limit = num(p.limit, undefined);
        let limited = result;
        if (limit && limit > 0 && Array.isArray(result) && result.length > limit) {
            notes.push(limitNote(limit, result.length));
            limited = result.slice(0, limit);
            // Summary counts describe the FULL result set — the limit applies
            // to listed entries only (fix #237: the header claimed '0 calls'
            // for a called function whenever the definition filled the limit).
            // Non-enumerable so the JSON array shape is unchanged.
            Object.defineProperty(limited, 'summaryCounts', {
                value: {
                    definitions: result.filter(u => u.isDefinition).length,
                    calls: result.filter(u => u.usageType === 'call').length,
                    imports: result.filter(u => u.usageType === 'import').length,
                    // Exhaustive complement (fix #241): every non-definition
                    // record that isn't a call or import is a reference —
                    // same-name definer sites (usageType 'definition' with
                    // isDefinition false) used to render in NO band.
                    references: result.filter(u => !u.isDefinition && u.usageType !== 'call' && u.usageType !== 'import').length,
                },
                enumerable: false, writable: true, configurable: true,
            });
        }
        return { ok: true, result: limited, note: notes.length ? notes.join(' ') : undefined };
    },

    toc: (index, p) => {
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const result = index.getToc({
            detailed: p.detailed,
            topLevel: p.topLevel,
            all: p.all,
            top: num(p.top, undefined),
            file: p.file,
            // Normalized (fix #239) — a raw MCP CSV string iterated
            // per-character emptied whole projects (exclude=test vs .ts).
            exclude: toExcludeArray(p.exclude),
            in: p.in,
        });
        // Apply limit to detailed toc entries (symbols are in f.symbols.functions/classes arrays)
        const limit = num(p.limit, undefined);
        let note;
        if (limit && limit > 0 && !p.detailed) {
            // --limit only bounds the per-symbol listing, which compact mode
            // doesn't render (fix #234 — three campaign cells hit the silent
            // no-op; FLAG_APPLICABILITY lists limit for toc, so no
            // inapplicable-flag warning fires either).
            note = '--limit applies to the symbol listing — combine it with --detailed.';
        }
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
        const tNote = truncationNote(index);
        if (tNote) note = note ? `${note}\n${tNote}` : tNote;
        return { ok: true, result, note };
    },

    search: (index, p) => {
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
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
        const tNote = truncationNote(index);
        return { ok: true, result, ...(tNote && { note: tNote }) };
    },

    tests: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        // tests() accepts a FILE PATH as the target ("tests helper.go" — the
        // engine's isFilePath branch searches the basename). Class.method
        // splitting would shear the filename at the dot into
        // className='helper', name='go' and silently return nothing
        // (fix #239, G3-go-measured). Mirror the engine's file-path test.
        const testsTargetIsFile = typeof p.name === 'string' && (
            p.name.includes('/') || p.name.includes('\\') ||
            /\.(js|ts|py|go|java|rs)$/.test(p.name));
        if (!testsTargetIsFile) applyClassMethodSyntax(p);
        if (p.file) {
            const fileErr = checkFilePatternMatch(index, p.file);
            if (fileErr) return { ok: false, error: fileErr };
            // Validate that the symbol exists in the target file
            const defs = index.find(p.name, { exact: true, file: p.file, className: p.className });
            if (defs.length === 0) {
                const allDefs = index.find(p.name, { exact: true });
                if (allDefs.length > 0) {
                    const files = allDefs.map(d => d.relativePath).join(', ');
                    return { ok: false, error: `Symbol "${p.name}" not found in files matching "${p.file}". Defined in: ${files}` };
                }
                return { ok: false, error: `Symbol "${p.name}" not found.` };
            }
        }
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
        const result = index.tests(p.name, {
            callsOnly: p.callsOnly || false,
            className: p.className,
            file: p.file,
            exclude: toExcludeArray(p.exclude),
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
        const pinErr = checkDefinitionPin(index, p);
        if (pinErr) return { ok: false, error: pinErr };
        const depthVal = num(p.depth, undefined);
        const result = index.affectedTests(p.name, {
            ...buildCallerOptions(p),
            depth: depthVal ?? 3,
        });
        if (!result) return { ok: false, error: `Function "${p.name}" not found.` };
        const note = treeNote(result);
        const tNote = truncationNote(index);
        const combined = [note, tNote].filter(Boolean).join('\n') || undefined;
        return { ok: true, result, ...(combined && { note: combined }) };
    },

    deadcode: (index, p) => {
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        // A typo'd 'in' directory used to yield a clean-sounding 'No dead
        // code found.' (fix #243) — validate it like the file pattern.
        if (p.in) {
            let anyIn = false;
            for (const [, fe] of index.files) {
                if (index.matchesFilters(fe.relativePath, { in: p.in })) { anyIn = true; break; }
            }
            if (!anyIn) return { ok: false, error: `No files matched the 'in' directory filter '${p.in}'.` };
        }
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
            // Preserve custom properties (excludedExported, excludedDecorated, excludedExternalContract) from deadcode()
            if (result.excludedExported != null) sliced.excludedExported = result.excludedExported;
            if (result.excludedDecorated != null) sliced.excludedDecorated = result.excludedDecorated;
            if (result.excludedExternalContract != null) sliced.excludedExternalContract = result.excludedExternalContract;
            // Truncation must be visible IN the JSON payload, not only in the
            // stderr note (fix #242) — the formatter reads this to emit
            // meta.total + truncated.
            Object.defineProperty(sliced, 'limitInfo', {
                value: { total: result.length, shown: limit },
                enumerable: false, writable: true, configurable: true,
            });
            result = sliced;
        }
        const tNote = truncationNote(index);
        if (tNote) note = note ? `${note}\n${tNote}` : tNote;
        return { ok: true, result, note };
    },

    entrypoints: (index, p) => {
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const { detectEntrypoints } = require('./entrypoints');
        // JAVA-2: tests ARE entry points (JUnit @Test, pytest fixtures,
        // Rust #[test], etc.) — show them by default. Previously this command
        // applied addTestExclusions() unconditionally, which stripped Java
        // *Tests.java entries while letting Rust #[test] through (asymmetric).
        // Now consistent: default = include test entries; user opts out via
        // --exclude-tests (or --include-tests=false for back-compat).
        const userExclude = Array.isArray(p.exclude)
            ? p.exclude
            : (p.exclude ? p.exclude.split(',').map(s => s.trim()).filter(Boolean) : []);
        const wantsExcludeTests = p.excludeTests === true || p.includeTests === false;
        const exclude = wantsExcludeTests ? addTestExclusions(userExclude) : userExclude;
        let result = detectEntrypoints(index, {
            type: p.type,
            framework: p.framework,
            file: p.file,
            exclude,
        });
        if (result && result.error) {
            return { ok: false, error: result.message || result.error };
        }
        const limit = num(p.limit, undefined);
        let note;
        if (limit && limit > 0 && Array.isArray(result) && result.length > limit) {
            note = limitNote(limit, result.length);
            result = result.slice(0, limit);
        }
        return { ok: true, result, note };
    },

    endpoints: (index, p) => {
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        // Minor polish: validate --method against known HTTP verbs to catch
        // typos that would otherwise silently filter out everything.
        // 'ALL' / 'USE' are downstream route labels that can be queried explicitly.
        const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'ALL', 'USE']);
        let normMethod = null;
        if (p.method != null && String(p.method).trim() !== '') {
            normMethod = String(p.method).trim().toUpperCase();
            if (!HTTP_METHODS.has(normMethod)) {
                return {
                    ok: false,
                    error: `Invalid --method value: "${p.method}". Expected one of ${[...HTTP_METHODS].join(', ')}.`,
                };
            }
        }
        const { endpoints } = require('./bridge');
        // HIGH-2: --unmatched implies --bridge (we need bridges to know what's
        // unmatched). Without bridges computed, we can't separate matched from
        // unmatched on either side.
        const wantUnmatched = !!p.unmatched;
        const wantBridge = !!p.bridge || wantUnmatched;
        const result = endpoints(index, {
            bridge: wantBridge,
            serverOnly: !!p.serverOnly,
            clientOnly: !!p.clientOnly,
            unmatched: wantUnmatched,
            method: normMethod,
            prefix: p.prefix || null,
            showUncertain: !p.hideUncertain,
        });
        // Apply --file pattern as an additional filter on routes/requests
        if (p.file) {
            const sub = String(p.file);
            result.routes = result.routes.filter(r => r.file.includes(sub));
            result.requests = result.requests.filter(r => r.file.includes(sub));
            result.bridges = result.bridges.filter(b =>
                b.route.file.includes(sub) || b.request.file.includes(sub)
            );
            result.unmatchedRoutes = result.unmatchedRoutes.filter(r => r.file.includes(sub));
            result.unmatchedRequests = result.unmatchedRequests.filter(r => r.file.includes(sub));
        }
        // Apply --exclude patterns to route/request files (deadcode-style boundary matching)
        const exclude = toExcludeArray(p.exclude);
        if (exclude.length > 0) {
            const regexes = exclude.map(pat =>
                new RegExp('(^|[/._-])' + pat + 's?([/._-]|$)', 'i'));
            const matches = (file) => regexes.some(rx => rx.test(file));
            result.routes = result.routes.filter(r => !matches(r.file));
            result.requests = result.requests.filter(r => !matches(r.file));
            result.bridges = result.bridges.filter(b => !matches(b.route.file) && !matches(b.request.file));
            result.unmatchedRoutes = result.unmatchedRoutes.filter(r => !matches(r.file));
            result.unmatchedRequests = result.unmatchedRequests.filter(r => !matches(r.file));
        }
        // Apply --limit
        const limit = num(p.limit, undefined);
        let note;
        if (limit && limit > 0) {
            const totalListed = result.routes.length + result.requests.length;
            if (totalListed > limit) {
                // Limit each list proportionally — but simpler: hard-cap each.
                const halfLim = Math.max(1, Math.floor(limit / 2));
                if (result.routes.length > halfLim) {
                    result.routes = result.routes.slice(0, halfLim);
                }
                if (result.requests.length > halfLim) {
                    result.requests = result.requests.slice(0, halfLim);
                }
                note = limitNote(limit, totalListed);
            }
        }
        // Recompute meta after filtering
        result.meta = {
            totalRoutes: result.routes.length,
            totalRequests: result.requests.length,
            totalBridges: result.bridges.length,
            unmatchedRoutes: result.unmatchedRoutes.length,
            unmatchedRequests: result.unmatchedRequests.length,
            byFramework: result.routes.reduce((acc, r) => {
                acc[r.framework] = (acc[r.framework] || 0) + 1;
                return acc;
            }, {}),
        };
        // Pass display flags through to formatter via result properties.
        // (HIGH-2: --unmatched implies --bridge for computation, but the
        // formatter needs to know which mode the user ASKED for so it can
        // suppress the "Matched" section in unmatched-only mode.)
        result._bridge = wantBridge;
        result._unmatched = wantUnmatched;
        return { ok: true, result, note };
    },

    // ── Extracting Code ─────────────────────────────────────────────────

    fn: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        if (p.className) {
            const classErr = validateClassName(index, p.name, p.className);
            if (classErr) return { ok: false, error: classErr };
        }

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
        return { ok: true, result: { entries }, note: notes.length ? notes.map(n => 'Note: ' + n).join('\n') : undefined };
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
            return { ok: true, result: { entries }, note: notes.length ? notes.map(n => 'Note: ' + n).join('\n') : undefined };
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
            return { ok: true, result: { entries }, note: notes.length ? notes.map(n => 'Note: ' + n).join('\n') : undefined };
        }

        // Truncated mode (maxLines specified and class exceeds it)
        if (maxLines && totalLines > maxLines) {
            const content = fs.readFileSync(match.file, 'utf-8');
            const fileLines = content.split('\n');
            const truncated = fileLines.slice(match.startLine - 1, match.startLine - 1 + maxLines);
            const code = cleanHtmlScriptTags(truncated, detectLanguage(match.file)).join('\n');
            entries.push({ match, code, totalLines, summaryMode: false, truncated: true, maxLines });
            return { ok: true, result: { entries }, note: notes.length ? notes.map(n => 'Note: ' + n).join('\n') : undefined };
        }

        // Full extraction
        const code = readAndExtract(match);
        entries.push({ match, code, totalLines, summaryMode: false, truncated: false });
        return { ok: true, result: { entries }, note: notes.length ? notes.map(n => 'Note: ' + n).join('\n') : undefined };
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
        if (result && result.error === 'invalid-direction') {
            return { ok: false, error: result.message };
        }
        const fileErr = checkFileError(result, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        return { ok: true, result };
    },

    circularDeps: (index, p) => {
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
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
        const pinErr = checkDefinitionPin(index, p);
        if (pinErr) return { ok: false, error: pinErr };
        const result = index.verify(p.name, {
            file: p.file,
            className: p.className,
            // Pin to an exact definition (stable-handle roundtrip: `verify
            // lib.js:4:save`). resolveSymbol filters by startLine — without
            // this passthrough the pin was silently dropped and scoring picked
            // among same-name defs (fix #227).
            ...(p.line && { line: p.line }),
            // BUG-H3: pass through user-supplied flags. Verify defaults to including
            // method calls (current behavior) so call-arity checks reach all forms,
            // including obj.method() invocations. User can disable with
            // --no-include-methods.
            ...(p.includeMethods !== undefined && { includeMethods: p.includeMethods }),
            ...(p.includeUncertain !== undefined && { includeUncertain: p.includeUncertain }),
        });
        if (result && result.found === false) {
            return { ok: false, error: `Function "${p.name}" not found.` };
        }
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
        const pinErr = checkDefinitionPin(index, p);
        if (pinErr) return { ok: false, error: pinErr };
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
            // Exact-definition pin (stable-handle roundtrip) — see verify.
            ...(p.line && { line: p.line }),
        });
        if (result && result.found === false) {
            return { ok: false, error: `Function "${p.name}" not found.` };
        }
        return { ok: true, result };
    },

    diffImpact: (index, p) => {
        let result = index.diffImpact({
            base: p.base || 'HEAD',
            staged: p.staged || false,
            file: p.file,
        });
        const limit = num(p.limit, undefined);
        let note;
        if (limit && limit > 0 && result && result.changed && result.changed.length > limit) {
            note = limitNote(limit, result.changed.length);
            result = { ...result, changed: result.changed.slice(0, limit) };
        }
        return { ok: true, result, note };
    },

    // ── Other ───────────────────────────────────────────────────────────

    typedef: (index, p) => {
        const err = requireName(p.name);
        if (err) return { ok: false, error: err };
        applyClassMethodSyntax(p);
        const fileErr = checkFilePatternMatch(index, p.file);
        if (fileErr) return { ok: false, error: fileErr };
        const classErr = validateClassName(index, p.name, p.className);
        if (classErr) return { ok: false, error: classErr };
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
        if (p.file) {
            const fileErr = checkFilePatternMatch(index, p.file);
            if (fileErr) return { ok: false, error: fileErr };
        }
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
        // MEDIUM-7: validate `--top`. Previously non-numeric, zero, and
        // negative values silently fell back to 10 — confusing when a typo
        // hides a request to show MORE entries.
        // BUG-2: reject 0 and negative explicitly — the rendering ("top 0 of
        // 718 called: (no inbound calls detected)") was misleading because
        // it implied no calls exist when the user simply asked for nothing.
        let top;
        let note;
        if (p.top != null) {
            const raw = String(p.top).trim();
            const n = Number(raw);
            if (raw === '' || isNaN(n) || !isFinite(n)) {
                return {
                    ok: false,
                    error: `Invalid --top value: must be a positive integer (got "${p.top}")`,
                };
            }
            if (!Number.isInteger(n)) {
                return {
                    ok: false,
                    error: `Invalid --top value: must be an integer (got ${n})`,
                };
            }
            if (n <= 0) {
                return {
                    ok: false,
                    error: `Invalid --top value: must be a positive integer (got ${n})`,
                };
            }
            if (n > 10000) {
                top = 10000;
                note = `--top capped at 10000 (requested ${n})`;
            } else {
                top = n;
            }
        }
        const result = index.getStats({
            functions: p.functions || false,
            hot: p.hot || false,
            top,
        });
        return note ? { ok: true, result, note } : { ok: true, result };
    },

    auditAsync: (index, p) => {
        if (p.file) {
            const fileErr = checkFilePatternMatch(index, p.file);
            if (fileErr) return { ok: false, error: fileErr };
        }
        let result = index.auditAsync({
            file: p.file,
            exclude: toExcludeArray(p.exclude),
        });
        // Apply limit to the issues array.
        const limit = num(p.limit, undefined);
        let note;
        if (limit && limit > 0 && result && Array.isArray(result.issues) && result.issues.length > limit) {
            note = limitNote(limit, result.issues.length);
            result = { ...result, issues: result.issues.slice(0, limit) };
        }
        const tNote = truncationNote(index);
        if (tNote) note = note ? `${note}\n${tNote}` : tNote;
        return { ok: true, result, note };
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
        // Resolve name-less handles (e.g. `lib.js:42`) via index lookup before dispatch.
        // Handles WITH a name suffix are handled later by applyClassMethodSyntax.
        if (params && params.name && looksLikeHandle(params.name)) {
            const h = parseSymbolHandle(params.name);
            if (h && !h.name && h.file && h.line) {
                const sym = lookupByLocation(index, h.file, h.line);
                if (sym) {
                    params.name = sym.name;
                    if (!params.file) params.file = h.file;
                    if (!params.line) params.line = h.line;
                }
            }
        }
        return handler(index, params);
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * Look up a symbol record by file path + start line. Used to recover a name
 * from a name-less handle (`relativePath:line`). Returns the first matching
 * symbol or null. Path matching is permissive (substring) so handles emitted
 * with relative paths still resolve when callers pass partial paths.
 */
function lookupByLocation(index, file, line) {
    if (!index || !index.symbols || !file || !line) return null;
    for (const arr of index.symbols.values()) {
        for (const sym of arr) {
            if (sym.startLine !== line) continue;
            const rp = sym.relativePath || '';
            if (rp === file || rp.endsWith('/' + file) || file.endsWith('/' + rp) || rp.includes(file)) {
                return sym;
            }
        }
    }
    return null;
}

module.exports = { execute };
