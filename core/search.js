/**
 * core/search.js — Symbol search, text search, usages, example, typedef, tests
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

'use strict';

const path = require('path');
const { escapeRegExp } = require('./shared');
const { isTestFile } = require('./discovery');
const { detectLanguage, getParser, getLanguageModule, langTraits } = require('../languages');
const { getCachedCalls } = require('./callers');

/**
 * Build a glob-style matcher: * matches any sequence, ? matches one char.
 * Case-insensitive by default. Returns a function (string) => boolean.
 */
function buildGlobMatcher(pattern, caseSensitive) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    const regex = new RegExp('^' + escaped + '$', caseSensitive ? '' : 'i');
    return (name) => regex.test(name);
}

const STRUCTURAL_TYPES = new Set(['function', 'class', 'call', 'method', 'type']);

/**
 * Substring match. Case-insensitive by default.
 */
function matchesSubstring(text, pattern, caseSensitive) {
    if (!text) return false;
    if (caseSensitive) return text.includes(pattern);
    return text.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * Find symbols by name with fuzzy/glob matching.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Symbol name (supports glob patterns)
 * @param {object} options - { exact, file, className, exclude, in, skipCounts }
 * @returns {Array} Matching symbols with usage counts
 */
function find(index, name, options = {}) {
    index._beginOp();
    try {
    // Glob pattern matching (e.g., _update*, handle*Request, get?ata)
    const isGlob = name.includes('*') || name.includes('?');
    if (isGlob && !options.exact) {
        // Bare wildcard: return all symbols
        const stripped = name.replace(/[*?]/g, '');
        if (stripped.length === 0) {
            const all = [];
            for (const [, symbols] of index.symbols) {
                for (const sym of symbols) {
                    all.push({ ...sym, _fuzzyScore: 800 });
                }
            }
            all.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            return _applyFindFilters(index, all, options);
        }
        const globRegex = new RegExp('^' + name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
        const matches = [];
        for (const [symName, symbols] of index.symbols) {
            if (globRegex.test(symName)) {
                for (const sym of symbols) {
                    matches.push({ ...sym, _fuzzyScore: 800 });
                }
            }
        }
        matches.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        return _applyFindFilters(index, matches, options);
    }

    const matches = index.symbols.get(name) || [];

    if (matches.length === 0 && !options.exact) {
        // Smart fuzzy search with scoring
        const candidates = [];
        for (const [symName, symbols] of index.symbols) {
            const score = index.fuzzyScore(name, symName);
            if (score > 0) {
                for (const sym of symbols) {
                    candidates.push({ ...sym, _fuzzyScore: score });
                }
            }
        }
        // Sort by fuzzy score descending
        candidates.sort((a, b) => b._fuzzyScore - a._fuzzyScore);
        matches.push(...candidates);
    }

    return _applyFindFilters(index, matches, options);
    } finally { index._endOp(); }
}

/**
 * Apply file/exclude/in filters and usage counts to find results
 *
 * @param {object} index - ProjectIndex instance
 * @param {Array} matches - Raw symbol matches
 * @param {object} options - { className, file, exclude, in, skipCounts }
 * @returns {Array} Filtered and sorted results
 */
function _applyFindFilters(index, matches, options) {
    let filtered = matches;

    // Filter by class name (Class.method syntax)
    if (options.className) {
        filtered = filtered.filter(m => m.className === options.className);
    }

    // Filter by file pattern
    if (options.file) {
        filtered = filtered.filter(m =>
            m.relativePath && m.relativePath.includes(options.file)
        );
    }

    // Apply semantic filters (--exclude, --in)
    if (options.exclude || options.in) {
        filtered = filtered.filter(m =>
            index.matchesFilters(m.relativePath, { exclude: options.exclude, in: options.in })
        );
    }

    // Skip expensive usage counting when caller doesn't need it
    if (options.skipCounts) {
        return filtered;
    }

    // Add per-symbol usage counts for disambiguation
    const withCounts = filtered.map(m => {
        const counts = index.countSymbolUsages(m);
        return {
            ...m,
            usageCount: counts.total,
            usageCounts: counts  // { total, calls, definitions, imports, references }
        };
    });

    // Sort by usage count (most-used first)
    withCounts.sort((a, b) => b.usageCount - a.usageCount);

    return withCounts;
}

/**
 * Find all usages of a symbol grouped by type
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Symbol name
 * @param {object} options - { codeOnly, context, exclude, in, file, className }
 * @returns {Array} Usages grouped as definitions, calls, imports, references
 */
function usages(index, name, options = {}) {
    index._beginOp();
    try {
    const usagesList = [];

    // Resolve file pattern for --file filter
    const fileFilterRaw = options.file ? index.resolveFilePathForQuery(options.file) : null;
    // resolveFilePathForQuery may return error objects for ambiguous/not-found — fall back to substring matching
    const fileFilter = typeof fileFilterRaw === 'string' ? fileFilterRaw : null;
    const fileSubstring = options.file || null; // fallback for unresolved patterns

    // Get definitions (filtered)
    let allDefinitions = index.symbols.get(name) || [];
    if (options.className) {
        allDefinitions = allDefinitions.filter(d => d.className === options.className);
    }
    if (fileFilter) {
        allDefinitions = allDefinitions.filter(d => d.file === fileFilter);
    } else if (fileSubstring) {
        allDefinitions = allDefinitions.filter(d => d.relativePath && d.relativePath.includes(fileSubstring));
    }
    const definitions = options.exclude || options.in
        ? allDefinitions.filter(d => index.matchesFilters(d.relativePath, options))
        : allDefinitions;

    for (const def of definitions) {
        usagesList.push({
            ...def,
            isDefinition: true,
            line: def.startLine,
            content: index.getLineContent(def.file, def.startLine),
            signature: index.formatSignature(def)
        });
    }

    // Scan all files for usages
    for (const [filePath, fileEntry] of index.files) {
        // Apply --file filter (exact match if resolved, substring fallback otherwise)
        if (fileFilter && filePath !== fileFilter) {
            continue;
        } else if (!fileFilter && fileSubstring && !fileEntry.relativePath.includes(fileSubstring)) {
            continue;
        }
        // Apply filters
        if (!index.matchesFilters(fileEntry.relativePath, options)) {
            continue;
        }

        try {
            const content = index._readFile(filePath);

            // Fast pre-check: skip if name doesn't appear in file at all
            if (!content.includes(name)) continue;

            const lines = content.split('\n');

            // Try AST-based detection first (with per-operation cache)
            const astUsages = index._getCachedUsages(filePath, name);
            if (astUsages !== null) {
                // Pre-compute: does any imported project file define this name?
                // Used to filter namespace member expressions (e.g., DropdownMenuPrimitive.Separator)
                // while keeping module access patterns (e.g., output.formatExample())
                let _importedHasDef = null;
                const importedFileHasDef = () => {
                    if (_importedHasDef !== null) return _importedHasDef;
                    const importedFiles = index.importGraph.get(filePath);
                    _importedHasDef = false;
                    if (importedFiles) for (const imp of importedFiles) {
                        const impEntry = index.files.get(imp);
                        if (impEntry?.symbols?.some(s => s.name === name)) {
                            _importedHasDef = true;
                            break;
                        }
                    }
                    return _importedHasDef;
                };

                for (const u of astUsages) {
                    // Skip if this is a definition line (already added above)
                    if (definitions.some(d => d.file === filePath && d.startLine === u.line)) {
                        continue;
                    }

                    // Filter member expressions with unrelated receivers in JS/TS/Python.
                    // Keeps: standalone usages, self/this/cls/super, method calls on known types,
                    //        and module access (output.fn()) when the imported file defines the name.
                    // Filters: namespace access to external packages (DropdownMenuPrimitive.Separator).
                    if (u.receiver && !['self', 'this', 'cls', 'super'].includes(u.receiver) &&
                        fileEntry.language !== 'go' && fileEntry.language !== 'java' && fileEntry.language !== 'rust') {
                        const hasMethodDef = definitions.some(d => d.className);
                        if (!hasMethodDef && !importedFileHasDef()) {
                            continue;
                        }
                    }

                    const lineContent = lines[u.line - 1] || '';

                    const usage = {
                        file: filePath,
                        relativePath: fileEntry.relativePath,
                        line: u.line,
                        content: lineContent,
                        usageType: u.usageType,
                        isDefinition: false,
                        ...(u.receiver && { receiver: u.receiver })
                    };

                    // Add context lines if requested
                    if (options.context && options.context > 0) {
                        const idx = u.line - 1;
                        const before = [];
                        const after = [];
                        for (let i = 1; i <= options.context; i++) {
                            if (idx - i >= 0) before.unshift(lines[idx - i]);
                            if (idx + i < lines.length) after.push(lines[idx + i]);
                        }
                        usage.before = before;
                        usage.after = after;
                    }

                    usagesList.push(usage);
                }
                continue; // Skip to next file
            }

            // Fallback to regex-based detection
            const regex = new RegExp('\\b' + escapeRegExp(name) + '\\b');
            lines.forEach((line, idx) => {
                const lineNum = idx + 1;

                // Skip if this is a definition line
                if (definitions.some(d => d.file === filePath && d.startLine === lineNum)) {
                    return;
                }

                if (regex.test(line)) {
                    // Skip if codeOnly and line is comment/string
                    if (options.codeOnly && index.isCommentOrStringAtPosition(content, lineNum, 0, filePath)) {
                        return;
                    }

                    // Skip if the match is inside a string literal
                    if (index.isInsideStringAST(content, lineNum, line, name, filePath)) {
                        return;
                    }

                    // Classify usage type (AST-based, defaults to 'reference' for unsupported languages)
                    const usageType = index.classifyUsageAST(content, lineNum, name, filePath) ?? 'reference';

                    const usage = {
                        file: filePath,
                        relativePath: fileEntry.relativePath,
                        line: lineNum,
                        content: line,
                        usageType,
                        isDefinition: false
                    };

                    // Add context lines if requested
                    if (options.context && options.context > 0) {
                        const before = [];
                        const after = [];
                        for (let i = 1; i <= options.context; i++) {
                            if (idx - i >= 0) before.unshift(lines[idx - i]);
                            if (idx + i < lines.length) after.push(lines[idx + i]);
                        }
                        usage.before = before;
                        usage.after = after;
                    }

                    usagesList.push(usage);
                }
            });
        } catch (e) {
            // Skip unreadable files
        }
    }

    // Deduplicate same-file, same-line, same-usageType entries
    // (e.g., `detectLanguage: parser.detectLanguage` has the name twice on one line)
    const seen = new Set();
    const deduped = [];
    for (const u of usagesList) {
        const key = `${u.file}:${u.line}:${u.usageType}:${u.isDefinition}`;
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(u);
        }
    }
    return deduped;
    } finally { index._endOp(); }
}

/**
 * Text/regex search across all project files
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} term - Search term (string or regex)
 * @param {object} options - { caseSensitive, regex, codeOnly, file, exclude, in, context, top }
 * @returns {Array} Search results with meta
 */
function search(index, term, options = {}) {
    index._beginOp();
    try {
    const results = [];
    let filesScanned = 0;
    let filesSkipped = 0;
    let filesFilteredByFlag = 0;
    const regexFlags = options.caseSensitive ? 'g' : 'gi';
    const useRegex = options.regex !== false; // Default: regex ON
    let regex;
    let regexFallback = false;
    if (useRegex) {
        try {
            regex = new RegExp(term, regexFlags);
        } catch (e) {
            // Invalid regex — fall back to plain text
            regex = new RegExp(escapeRegExp(term), regexFlags);
            regexFallback = e.message;
        }
    } else {
        regex = new RegExp(escapeRegExp(term), regexFlags);
    }

    for (const [filePath, fileEntry] of index.files) {
        // Apply --file filter
        if (options.file) {
            const fp = fileEntry.relativePath;
            if (!fp.includes(options.file) && !fp.endsWith(options.file)) {
                filesFilteredByFlag++;
                continue;
            }
        }
        // Apply exclude/in filters
        if ((options.exclude && options.exclude.length > 0) || options.in) {
            if (!index.matchesFilters(fileEntry.relativePath, { exclude: options.exclude, in: options.in })) {
                filesSkipped++;
                continue;
            }
        }
        filesScanned++;
        try {
            const content = index._readFile(filePath);
            const lines = content.split('\n');
            const matches = [];

            // Use AST-based filtering for codeOnly mode when language is supported
            if (options.codeOnly) {
                const language = detectLanguage(filePath);
                if (language) {
                    try {
                        const parser = getParser(language);
                        const { findMatchesWithASTFilter } = require('../languages/utils');
                        const astMatches = findMatchesWithASTFilter(content, term, parser, { codeOnly: true, regex: useRegex });

                        for (const m of astMatches) {
                            const match = {
                                line: m.line,
                                content: m.content
                            };

                            // Add context lines if requested
                            if (options.context && options.context > 0) {
                                const idx = m.line - 1;
                                const before = [];
                                const after = [];
                                for (let i = 1; i <= options.context; i++) {
                                    if (idx - i >= 0) before.unshift(lines[idx - i]);
                                    if (idx + i < lines.length) after.push(lines[idx + i]);
                                }
                                match.before = before;
                                match.after = after;
                            }

                            matches.push(match);
                        }

                        if (matches.length > 0) {
                            results.push({
                                file: fileEntry.relativePath,
                                matches
                            });
                        }
                        continue; // Skip to next file
                    } catch (e) {
                        // Fall through to regex-based search
                    }
                }
            }

            // Fallback to regex-based search (non-codeOnly or unsupported language)
            lines.forEach((line, idx) => {
                regex.lastIndex = 0; // Reset regex state
                if (regex.test(line)) {
                    const lineNum = idx + 1;
                    // Skip if codeOnly and line is comment/string
                    if (options.codeOnly && index.isCommentOrStringAtPosition(content, lineNum, 0, filePath)) {
                        return;
                    }

                    const match = {
                        line: idx + 1,
                        content: line
                    };

                    // Add context lines if requested
                    if (options.context && options.context > 0) {
                        const before = [];
                        const after = [];
                        for (let i = 1; i <= options.context; i++) {
                            if (idx - i >= 0) before.unshift(lines[idx - i]);
                            if (idx + i < lines.length) after.push(lines[idx + i]);
                        }
                        match.before = before;
                        match.after = after;
                    }

                    matches.push(match);
                }
            });

            if (matches.length > 0) {
                results.push({
                    file: fileEntry.relativePath,
                    matches
                });
            }
        } catch (e) {
            // Expected: binary/minified files fail to read or parse.
            // These are not actionable errors — silently skip.
        }
    }

    // Apply top limit (limits total matches across all files)
    const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
    let truncatedMatches = 0;
    if (options.top && options.top > 0 && totalMatches > options.top) {
        let remaining = options.top;
        const truncated = [];
        for (const r of results) {
            if (remaining <= 0) break;
            if (r.matches.length <= remaining) {
                truncated.push(r);
                remaining -= r.matches.length;
            } else {
                truncated.push({ ...r, matches: r.matches.slice(0, remaining) });
                remaining = 0;
            }
        }
        truncatedMatches = totalMatches - options.top;
        results.length = 0;
        results.push(...truncated);
    }

    results.meta = { filesScanned, filesSkipped, filesFilteredByFlag, totalFiles: index.files.size, regexFallback, totalMatches, truncatedMatches, projectLanguage: index._getPredominantLanguage() };
    return results;
    } finally { index._endOp(); }
}

/**
 * Structural search — query the symbol table and call index, not raw text.
 * Answers questions like "functions taking Request param", "all db.* calls",
 * "exported async functions", "decorated route handlers".
 *
 * @param {object} index - ProjectIndex instance
 * @param {object} options
 * @param {string} [options.term] - Name filter (glob: * and ? supported)
 * @param {string} [options.type] - Symbol kind: function, class, call, method, type
 * @param {string} [options.param] - Parameter name or type substring
 * @param {string} [options.receiver] - Call receiver pattern (for type=call)
 * @param {string} [options.returns] - Return type substring
 * @param {string} [options.decorator] - Decorator/annotation name substring
 * @param {boolean} [options.exported] - Only exported symbols
 * @param {boolean} [options.unused] - Only symbols with zero callers
 * @param {string[]} [options.exclude] - Exclude file patterns
 * @param {string} [options.in] - Restrict to subdirectory
 * @param {string} [options.file] - File pattern filter
 * @param {number} [options.top] - Limit results
 * @returns {{ results: Array, meta: object }}
 */
function structuralSearch(index, options = {}) {
    index._beginOp();
    try {
        const { term, param, receiver, returns: returnType, decorator, exported, unused } = options;
        // Auto-infer type: --receiver implies type=call
        const type = options.type || (receiver ? 'call' : undefined);
        const results = [];

        // Validate type if provided
        if (type && !STRUCTURAL_TYPES.has(type)) {
            return {
                results: [],
                meta: {
                    mode: 'structural',
                    query: { type },
                    totalMatched: 0,
                    shown: 0,
                    error: `Invalid type "${type}". Valid types: ${[...STRUCTURAL_TYPES].join(', ')}`,
                }
            };
        }

        // Build glob-style name matcher from term
        const nameMatcher = term ? buildGlobMatcher(term, options.caseSensitive) : null;

        // Helper: check if file passes filters
        const passesFileFilter = (fileEntry) => {
            if (!fileEntry) return false;
            if (options.file) {
                const rp = fileEntry.relativePath;
                if (!rp.includes(options.file) && !rp.endsWith(options.file)) return false;
            }
            if ((options.exclude && options.exclude.length > 0) || options.in) {
                if (!index.matchesFilters(fileEntry.relativePath, { exclude: options.exclude, in: options.in })) return false;
            }
            return true;
        };

        if (type === 'call') {
            // Search call sites from callee index
            const { getCachedCalls } = require('./callers');
            const seenFiles = new Set();

            // If term is given, only scan files that might contain that call
            if (term && !term.includes('*') && !term.includes('?')) {
                // Exact or substring — use callee index for fast lookup
                index.buildCalleeIndex();
                const files = index.calleeIndex.get(term);
                if (files) for (const f of files) seenFiles.add(f);
            } else {
                // Scan all files
                for (const fp of index.files.keys()) seenFiles.add(fp);
            }

            for (const filePath of seenFiles) {
                const fileEntry = index.files.get(filePath);
                if (!passesFileFilter(fileEntry)) continue;
                const calls = getCachedCalls(index, filePath);
                if (!calls) continue;
                for (const call of calls) {
                    if (nameMatcher && !nameMatcher(call.name)) continue;
                    if (receiver) {
                        if (!call.receiver) continue;
                        if (!matchesSubstring(call.receiver, receiver, options.caseSensitive)) continue;
                    }
                    results.push({
                        kind: 'call',
                        name: call.receiver ? `${call.receiver}.${call.name}` : call.name,
                        file: fileEntry.relativePath,
                        line: call.line,
                        receiver: call.receiver || null,
                        isMethod: call.isMethod || false,
                    });
                }
            }
        } else {
            // Search symbols (functions, classes, methods, types)
            const functionTypes = new Set(['function', 'constructor', 'method', 'arrow', 'static', 'classmethod', 'abstract']);
            const classTypes = new Set(['class', 'struct', 'interface', 'impl', 'trait']);
            const typeTypes = new Set(['type', 'enum', 'interface', 'trait']);
            const methodTypes = new Set(['method', 'constructor']);

            for (const [symbolName, definitions] of index.symbols) {
                if (nameMatcher && !nameMatcher(symbolName)) continue;

                for (const def of definitions) {
                    // Type filter
                    if (type === 'function' && !functionTypes.has(def.type)) continue;
                    if (type === 'class' && !classTypes.has(def.type)) continue;
                    if (type === 'method' && !methodTypes.has(def.type) && !def.isMethod) continue;
                    if (type === 'type' && !typeTypes.has(def.type)) continue;

                    // File filters
                    const fileEntry = index.files.get(def.file);
                    if (!passesFileFilter(fileEntry)) continue;

                    // Param filter: match param name or type
                    if (param) {
                        const cs = options.caseSensitive;
                        const ps = def.paramsStructured || [];
                        const paramStr = def.params || '';
                        const hasMatch = ps.some(p =>
                            matchesSubstring(p.name, param, cs) ||
                            (p.type && matchesSubstring(p.type, param, cs))
                        ) || matchesSubstring(paramStr, param, cs);
                        if (!hasMatch) continue;
                    }

                    // Receiver filter: match className for methods
                    if (receiver) {
                        if (!def.className || !matchesSubstring(def.className, receiver, options.caseSensitive)) continue;
                    }

                    // Return type filter
                    if (returnType) {
                        if (!def.returnType || !matchesSubstring(def.returnType, returnType, options.caseSensitive)) continue;
                    }

                    // Decorator filter: checks decorators (Python), modifiers (Java annotations stored lowercase)
                    if (decorator) {
                        const cs = options.caseSensitive;
                        const hasDecorator = (def.decorators && def.decorators.some(d => matchesSubstring(d, decorator, cs))) ||
                            (def.modifiers && def.modifiers.some(m => matchesSubstring(m, decorator, cs)));
                        if (!hasDecorator) continue;
                    }

                    // Exported filter
                    if (exported) {
                        const mods = def.modifiers || [];
                        const isExp = (fileEntry && fileEntry.exports.includes(symbolName)) ||
                            mods.includes('export') || mods.includes('public') ||
                            mods.some(m => m.startsWith('pub')) ||
                            (fileEntry && langTraits(fileEntry.language)?.exportVisibility === 'capitalization' && /^[A-Z]/.test(symbolName));
                        if (!isExp) continue;
                    }

                    // Unused filter (expensive — last check)
                    if (unused) {
                        index.buildCalleeIndex();
                        if (index.calleeIndex.has(symbolName)) continue;
                    }

                    // Merge decorators from both Python-style decorators and Java-style modifiers
                    const allDecorators = def.decorators || null;

                    results.push({
                        kind: def.type,
                        name: symbolName,
                        file: def.relativePath,
                        line: def.startLine,
                        params: def.params || null,
                        returnType: def.returnType || null,
                        decorators: allDecorators,
                        className: def.className || null,
                        exported: exported ? true : undefined,
                    });
                }
            }
        }

        // Sort by file, then line
        results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

        // Apply top limit
        const total = results.length;
        const top = options.top;
        if (top && top > 0 && results.length > top) {
            results.length = top;
        }

        return {
            results,
            meta: {
                mode: 'structural',
                query: Object.fromEntries(Object.entries({
                    type: type || 'any', term, param, receiver, returns: returnType,
                    decorator, exported: exported || undefined, unused: unused || undefined,
                }).filter(([, v]) => v !== undefined && v !== null)),
                totalMatched: total,
                shown: results.length,
            }
        };
    } finally { index._endOp(); }
}

/**
 * Find the best usage example of a function
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @param {object} options - { className }
 * @returns {object|null} Best example with score
 */
function example(index, name, options = {}) {
    index._beginOp();
    try {
    const usageResults = usages(index, name, {
        codeOnly: true,
        className: options.className,
        exclude: ['test', 'spec', '__tests__', '__mocks__', 'fixture', 'mock'],
        context: 5
    });

    const calls = usageResults.filter(u => u.usageType === 'call' && !u.isDefinition);
    if (calls.length === 0) return null;

    const scored = calls.map(call => {
        let score = 0;
        const reasons = [];
        const line = call.content.trim();

        const astInfo = index._analyzeCallSiteAST(call.file, call.line, name);

        if (astInfo.isTypedAssignment) { score += 15; reasons.push('typed assignment'); }
        if (astInfo.isInReturn) { score += 10; reasons.push('in return'); }
        if (astInfo.isAwait) { score += 10; reasons.push('async usage'); }
        if (astInfo.isDestructured) { score += 8; reasons.push('destructured'); }
        if (astInfo.isStandalone) { score += 5; reasons.push('standalone'); }
        if (astInfo.hasComment) { score += 3; reasons.push('documented'); }
        if (astInfo.isInCatch) { score -= 5; reasons.push('in catch block'); }
        if (astInfo.isInConditional) { score -= 3; reasons.push('in conditional'); }

        if (score === 0) {
            if (/^(const|let|var|return)\s/.test(line) || /^\w+\s*=/.test(line)) {
                score += 10; reasons.push('return value used');
            }
            if (line.startsWith(name + '(') || /^(const|let|var)\s+\w+\s*=\s*\w*$/.test(line.split(name)[0])) {
                score += 5; reasons.push('clear usage');
            }
        }

        if (call.before && call.before.length > 0) score += 3;
        if (call.after && call.after.length > 0) score += 3;
        if (call.before?.length > 0 && call.after?.length > 0) reasons.push('has context');

        const beforeCall = line.split(name + '(')[0];
        if (!beforeCall.includes('(') || /^\s*(const|let|var|return)?\s*\w+\s*=\s*$/.test(beforeCall)) {
            score += 2;
        }
        if (call.line < 100) score += 1;

        return { ...call, score, reasons };
    });

    scored.sort((a, b) => b.score - a.score);
    return { best: scored[0], totalCalls: calls.length };
    } finally { index._endOp(); }
}

/**
 * Find type definitions
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Type name to find
 * @param {object} options - Find options
 * @returns {Array} Matching type definitions
 */
function typedef(index, name, options = {}) {
    const typeKinds = ['type', 'interface', 'enum', 'struct', 'trait', 'class', 'record'];
    const matches = find(index, name, options);

    return matches.filter(m => typeKinds.includes(m.type)).map(m => ({
        ...m,
        code: index.extractCode(m)
    }));
}

/**
 * Find tests for a function or file (AST-based).
 *
 * Uses _getCachedUsages() for AST-based detection of imports, calls, and references.
 * className scoping uses the AST receiver field from findUsagesInCode() instead of
 * regex heuristics. Test-case detection is language-aware via isEntryPoint().
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} nameOrFile - Function name or file path
 * @param {object} options - { callsOnly, className, file, exclude }
 * @returns {Array} Test files and matches
 */
function tests(index, nameOrFile, options = {}) {
    index._beginOp();
    try {
    const results = [];

    // Check if it's a file path
    const isFilePath = nameOrFile.includes('/') || nameOrFile.includes('\\') ||
        nameOrFile.endsWith('.js') || nameOrFile.endsWith('.ts') ||
        nameOrFile.endsWith('.py') || nameOrFile.endsWith('.go') ||
        nameOrFile.endsWith('.java') || nameOrFile.endsWith('.rs');

    // Resolve --file scoping: find the source file that defines this symbol
    // and only include test files that import from it (directly or via re-exports).
    let sourceFileFilter = null;
    if (options.file && !isFilePath) {
        const defs = index.find(nameOrFile, { exact: true, file: options.file, className: options.className });
        if (defs.length > 0) {
            sourceFileFilter = _buildSourceFileImporters(index, defs);
        }
        // If no defs found, sourceFileFilter stays null → no file scoping applied.
        // The execute handler validates before calling, so this path means
        // the file matched but no exact symbol — fall through gracefully.
    }

    // Find all test files
    const testFiles = [];
    for (const [filePath, fileEntry] of index.files) {
        if (isTestFile(fileEntry.relativePath, fileEntry.language)) {
            testFiles.push({ path: filePath, entry: fileEntry });
        } else if (fileEntry.language === 'rust') {
            // Rust idiomatically puts tests in #[cfg(test)] modules inside source files.
            const hasInlineTests = fileEntry.symbols?.some(s =>
                s.modifiers?.includes('test')
            );
            if (hasInlineTests) {
                testFiles.push({ path: filePath, entry: fileEntry });
            }
        }
    }

    const searchTerm = isFilePath
        ? path.basename(nameOrFile, path.extname(nameOrFile))
        : nameOrFile;

    const className = options.className || null;
    // Pre-compile string-ref pattern (only regex left — used on single AST-identified lines)
    const strPattern = new RegExp("['\"`]" + escapeRegExp(searchTerm) + "['\"`]");

    // --exclude filtering
    const excludeArr = options.exclude ? (Array.isArray(options.exclude) ? options.exclude : [options.exclude]) : [];

    for (const { path: testPath, entry } of testFiles) {
        try {
            // Apply exclude filters
            if (excludeArr.length > 0 && !index.matchesFilters(entry.relativePath, { exclude: excludeArr })) continue;

            const content = index._readFile(testPath);

            // Fast pre-check: skip if searchTerm doesn't appear in file
            if (!content.includes(searchTerm)) continue;
            // className scoping: skip test files that don't reference the class at all
            if (className && !content.includes(className)) continue;

            // --file scoping: only include test files that import from the target source
            if (sourceFileFilter && !sourceFileFilter.has(testPath)) {
                continue;
            }

            // AST-based usage detection
            const astUsages = index._getCachedUsages(testPath, searchTerm);
            if (astUsages === null) continue; // no parser available — skip

            if (astUsages.length === 0) continue;

            // Build instance variable → className map from getCachedCalls()
            // for receiver-precise className scoping.
            // e.g., `const svc = new B()` → svc maps to 'B'
            let instanceTypeMap = null; // lazily built
            if (className) {
                instanceTypeMap = _buildInstanceTypeMap(index, testPath, content, className);
            }

            const matches = [];
            const seenLines = new Set(); // deduplicate same-line matches

            for (const usage of astUsages) {
                if (usage.usageType === 'definition') continue; // not relevant in test files

                const lineKey = `${usage.line}:${usage.usageType}`;
                if (seenLines.has(lineKey)) continue;
                seenLines.add(lineKey);

                const lineContent = index.getLineContent(testPath, usage.line);

                let matchType;
                if (usage.usageType === 'import') {
                    matchType = 'import';
                } else if (usage.usageType === 'call') {
                    matchType = 'call';
                } else {
                    // 'reference' — check if inside string literal
                    matchType = strPattern.test(lineContent) ? 'string-ref' : 'reference';
                }

                // className scoping for calls: check receiver
                if (className && matchType === 'call') {
                    if (!_receiverMatchesClass(usage, className, instanceTypeMap, lineContent, searchTerm)) continue;
                }

                // className scoping for references: require class-associated receiver
                if (className && (matchType === 'reference' || matchType === 'string-ref')) {
                    // Bare references (no receiver) like `fn = save` have no class
                    // association — skip them. Only keep member-access references
                    // where the receiver matches the target class.
                    if (!usage.receiver) continue;
                    if (usage.receiver !== className &&
                        !(instanceTypeMap && instanceTypeMap.get(usage.receiver) === className)) {
                        continue;
                    }
                }

                matches.push({
                    line: usage.line,
                    content: lineContent.trim(),
                    matchType
                });
            }

            // Language-aware test-case detection
            _addTestCaseMatches(index, testPath, entry, searchTerm, className, instanceTypeMap, matches);

            // Deduplicate: if a line already has a 'call' or 'import', don't also add 'test-case'
            let finalMatches = _deduplicateMatches(matches);

            // className scoping: only include imports if the file has class-scoped
            // call/reference/test-case matches. An import of the searchTerm alone
            // (e.g., `from app import B, save`) is not evidence of B.save() usage.
            if (className) {
                const hasClassScopedMatch = finalMatches.some(m => m.matchType !== 'import');
                if (!hasClassScopedMatch) {
                    finalMatches = [];
                }
            }

            const filtered = options.callsOnly
                ? finalMatches.filter(m => m.matchType === 'call' || m.matchType === 'test-case')
                : finalMatches;
            if (filtered.length > 0) {
                results.push({
                    file: entry.relativePath,
                    matches: filtered
                });
            }
        } catch (e) {
            // Skip unreadable files
        }
    }

    return results;
    } finally { index._endOp(); }
}

/**
 * Build a map of instance variable names → class names from call objects and AST usages.
 * Language-generic: uses receiverType from getCachedCalls() (already inferred
 * by _buildTypedLocalTypeMap for Go/Java/Rust and binding analysis for JS/TS/Python),
 * plus AST usages of targetClassName for assignment patterns not captured by calls
 * (e.g., Rust `let svc = B;` inside macro bodies).
 *
 * Three sources:
/**
 * Build a set of absolute file paths that import (directly or transitively via
 * re-exports) from the source files where the symbol is defined.
 * Uses the index's resolved importGraph/exportGraph for path-precise matching.
 */
function _buildSourceFileImporters(index, defs) {
    const symbolName = defs[0]?.name;
    const sourceAbsPaths = new Set();
    for (const d of defs) {
        for (const [absPath, fe] of index.files) {
            if (fe.relativePath === d.relativePath) {
                sourceAbsPaths.add(absPath);
                break;
            }
        }
    }

    // BFS through the export graph: walk from source files outward through
    // re-export chains. At each hop, verify the intermediate file actually
    // exports the target symbol (prevents overmatching barrels that import
    // the source file for a different symbol).
    const importers = new Set();
    const queue = [...sourceAbsPaths];
    const visited = new Set(sourceAbsPaths);

    while (queue.length > 0) {
        const current = queue.shift();
        const directImporters = index.exportGraph?.get(current) || new Set();
        for (const imp of directImporters) {
            importers.add(imp);
            // Check if this importer re-exports the symbol (barrel pattern).
            // If so, add it to the queue so its importers are also discovered.
            if (!visited.has(imp)) {
                const fe = index.files.get(imp);
                if (fe && _fileReExportsSymbol(fe, symbolName, current)) {
                    visited.add(imp);
                    queue.push(imp);
                }
            }
        }
    }

    // Language-aware test file discovery: add test files matched by naming
    // convention or same-package membership, which don't use import statements.
    // Go: same directory (package-scoped), Java: *Test.java convention,
    // Rust: inline #[cfg(test)] in the source file itself.
    for (const srcPath of sourceAbsPaths) {
        const srcEntry = index.files.get(srcPath);
        if (!srcEntry) continue;
        const traits = langTraits(srcEntry.language);
        if (!traits?.testFileCandidates) continue;

        const srcBase = path.basename(srcPath, path.extname(srcPath));
        const srcExt = path.extname(srcPath);
        const srcDir = path.dirname(srcPath);
        const candidates = traits.testFileCandidates(srcBase, srcExt);

        // Build set of directories to check for convention-based test files:
        // same directory + configured testDirs (e.g., __tests__, tests/)
        // + Java src/main→src/test mirror convention
        const candidateDirs = new Set([srcDir]);
        for (const td of (traits.testDirs || [])) {
            candidateDirs.add(path.join(srcDir, td));
        }
        // Java convention: src/main/java/com/pkg → src/test/java/com/pkg
        if (srcDir.includes(path.sep + 'main' + path.sep)) {
            candidateDirs.add(srcDir.replace(path.sep + 'main' + path.sep, path.sep + 'test' + path.sep));
        }

        for (const [absPath, fe] of index.files) {
            if (importers.has(absPath)) continue; // already included
            if (!isTestFile(fe.relativePath, fe.language) &&
                !(fe.language === 'rust' && fe.symbols?.some(s => s.modifiers?.includes('test')))) {
                continue; // not a test file
            }

            const testDir = path.dirname(absPath);

            // Check naming convention match — must be in same dir or a test subdir
            if (candidateDirs.has(testDir)) {
                const testBaseName = path.basename(absPath);
                if (candidates.some(c => testBaseName === c)) {
                    importers.add(absPath);
                    continue;
                }
            }

            // Go: same-directory tests (package-scoped, no imports needed)
            if (traits.packageScope === 'directory' && testDir === srcDir) {
                importers.add(absPath);
                continue;
            }

            // Rust: inline tests in the source file itself
            if (srcPath === absPath) {
                importers.add(absPath);
            }
        }
    }

    return importers;
}

/**
 * Check if a file re-exports a symbol from a source file.
 * Handles: named re-exports, `module.exports = require(...)` blanket re-exports,
 * `export * from ...`, and files that both import from source and export the symbol.
 */
function _fileReExportsSymbol(fileEntry, symbolName, sourceAbsPath) {
    if (!fileEntry.exports || fileEntry.exports.length === 0) return false;
    // Check if any export matches the symbol name
    if (symbolName && fileEntry.exports.some(exp => exp.name === symbolName)) return true;
    // Blanket re-exports: module.exports = require(...), export * from ...
    // These have undefined or generic names but re-export everything from the imported module
    const hasBlanketExport = fileEntry.exports.some(exp =>
        !exp.name || exp.type === 'module.exports' || exp.type === 're-export' || exp.type === 'export-all'
    );
    if (hasBlanketExport) return true;
    return false;
}

/**
 * Build a map of instance variable names → class names from call objects and AST usages.
 * Language-generic: uses receiverType from getCachedCalls() (already inferred
 * by _buildTypedLocalTypeMap for Go/Java/Rust and binding analysis for JS/TS/Python),
 * plus AST usages of targetClassName for assignment patterns not captured by calls
 * (e.g., Rust `let svc = B;` inside macro bodies).
 *
 * Three sources:
 * 1. receiverType on method calls: `svc.Save()` with receiverType=B → svc maps to B
 * 2. Constructor calls: `new B()`, `B()`, `&B{}` assigned to a variable
 * 3. AST usages of className on assignment lines: `let svc = B;` or `svc = B{}`
 */
function _buildInstanceTypeMap(index, filePath, content, targetClassName) {
    const typeMap = new Map(); // varName → className

    const calls = getCachedCalls(index, filePath);
    if (calls) {
        for (const call of calls) {
            // Source 1: receiverType from method calls (works across all languages)
            // e.g., svc.Save() where receiverType='B' → svc maps to 'B'
            if (call.isMethod && call.receiver && call.receiverType === targetClassName) {
                typeMap.set(call.receiver, targetClassName);
            }

            // Source 2: Constructor/factory calls assigned to a variable
            // e.g., `const svc = new B()` (JS), `svc = B()` (Python), `svc := &B{}` (Go)
            if (call.name === targetClassName && !call.isMethod) {
                const lineContent = index.getLineContent(filePath, call.line);
                const assignMatch = lineContent.match(/(?:const|let|var|)\s*(\w+)\s*:?=\s/);
                if (assignMatch) {
                    typeMap.set(assignMatch[1], targetClassName);
                }
            }

            // Source 3: Factory methods — ClassName.create(), ClassName.build(), etc.
            if (call.isMethod && call.receiver === targetClassName) {
                const lineContent = index.getLineContent(filePath, call.line);
                const assignMatch = lineContent.match(/(?:const|let|var|)\s*(\w+)\s*:?=\s/);
                if (assignMatch) {
                    typeMap.set(assignMatch[1], targetClassName);
                }
            }
        }
    }

    // Source 4: AST usages of targetClassName on assignment lines.
    // Catches patterns not visible to getCachedCalls (e.g., Rust macro bodies
    // where `let svc = B;` is inside a token_tree, or Go `svc := B{}`).
    const classUsages = index._getCachedUsages(filePath, targetClassName);
    if (classUsages) {
        for (const u of classUsages) {
            if (u.usageType === 'import' || u.usageType === 'definition') continue;
            const lineContent = index.getLineContent(filePath, u.line);
            // Match: `let/const/var varName = ClassName` or `varName := ClassName`
            const assignMatch = lineContent.match(/(?:const|let|var|)\s*(\w+)\s*:?=\s/);
            if (assignMatch && assignMatch[1] !== targetClassName) {
                typeMap.set(assignMatch[1], targetClassName);
            }
        }
    }

    return typeMap;
}

/**
 * Check if a usage's receiver matches the target className.
 * Uses direct receiver check and instance type map for indirect bindings.
 * @param {object} usage - AST usage with optional receiver field
 * @param {string} className - Target class name
 * @param {Map} instanceTypeMap - varName → className map
 * @param {string} [lineContent] - Line content for fallback checks
 */
function _receiverMatchesClass(usage, className, instanceTypeMap, lineContent, searchTerm) {
    // Direct receiver: ClassName.method() or ClassName.staticMethod()
    if (usage.receiver === className) return true;
    // Instance variable: check if receiver is bound to the target class
    if (usage.receiver && instanceTypeMap && instanceTypeMap.get(usage.receiver) === className) return true;
    // Receiver is some other known identifier — doesn't match
    if (usage.receiver) return false;
    // No receiver: bare function call. Only match if className is the direct
    // receiver expression — e.g., `new B().save()`, `B().save()`, `B{}.save()`.
    // Reject cases like `svc = B(); save()` where className is elsewhere on the line.
    if (lineContent && searchTerm) {
        // Check for chained call: ClassName followed by constructor/call then .methodName(
        const pat = new RegExp(
            '\\b' + escapeRegExp(className) + '\\s*(?:(?:\\([^)]*\\)|\\{[^}]*\\})\\s*\\.\\s*' +
            escapeRegExp(searchTerm) + '\\s*\\(|' +
            'new\\s+' + escapeRegExp(className) + '\\s*\\([^)]*\\)\\s*\\.\\s*' +
            escapeRegExp(searchTerm) + '\\s*\\()'
        );
        if (pat.test(lineContent)) return true;
    }
    return false;
}

/**
 * Language-aware test-case detection.
 *
 * JS/TS: describe, it, test, spec calls with searchTerm in the description.
 * Go: TestXxx, BenchmarkXxx, ExampleXxx functions containing a usage of searchTerm.
 * Python: test_ functions or TestCase methods containing a usage of searchTerm.
 * Java: @Test-annotated methods containing a usage of searchTerm.
 * Rust: #[test]-attributed functions containing a usage of searchTerm.
 */
function _addTestCaseMatches(index, filePath, fileEntry, searchTerm, className, instanceTypeMap, matches) {
    const matchLines = new Set(matches.map(m => m.line));
    const lang = fileEntry.language;

    if (lang === 'javascript' || lang === 'typescript' || lang === 'tsx') {
        // JS/TS: find describe/it/test/spec calls from getCachedCalls
        const calls = getCachedCalls(index, filePath);
        if (!calls) return;
        const testFrameworkCalls = new Set(['describe', 'it', 'test', 'spec']);
        for (const call of calls) {
            if (!testFrameworkCalls.has(call.name)) continue;
            const lineContent = index.getLineContent(filePath, call.line);
            // Check if searchTerm appears in the description string on this line
            if (lineContent.includes(searchTerm) && !matchLines.has(call.line)) {
                // className scoping: only add test-case if the test body has a
                // class-scoped match (call or class-receiver reference) — not just
                // any mention of className.
                if (className) {
                    const endLine = _estimateTestBlockEnd(index, filePath, call.line);
                    const hasClassScopedMatch = matches.some(m =>
                        m.line >= call.line && m.line <= endLine &&
                        m.matchType !== 'import'
                    );
                    if (!hasClassScopedMatch) continue;
                }
                matches.push({
                    line: call.line,
                    content: lineContent.trim(),
                    matchType: 'test-case'
                });
                matchLines.add(call.line);
            }
        }
    } else {
        // Go/Python/Java/Rust: check if any AST usage falls within a test function's range
        if (!fileEntry.symbols) return;
        try {
            const langModule = getLanguageModule(lang);
            if (!langModule || !langModule.isEntryPoint) return;

            // Find test symbols
            for (const symbol of fileEntry.symbols) {
                if (!langModule.isEntryPoint(symbol)) continue;
                // Check if any non-import usage of searchTerm falls within this test function
                const usageInRange = matches.some(m =>
                    m.line >= symbol.startLine && m.line <= symbol.endLine &&
                    m.matchType !== 'import'
                );
                if (usageInRange && !matchLines.has(symbol.startLine)) {
                    // className scoping: verify the test body has class-scoped matches
                    if (className) {
                        const hasClassScopedMatch = matches.some(m =>
                            m.line >= symbol.startLine && m.line <= symbol.endLine &&
                            m.matchType !== 'import'
                        );
                        if (!hasClassScopedMatch) continue;
                    }
                    const lineContent = index.getLineContent(filePath, symbol.startLine);
                    matches.push({
                        line: symbol.startLine,
                        content: lineContent.trim(),
                        matchType: 'test-case'
                    });
                    matchLines.add(symbol.startLine);
                }
            }
        } catch (e) {
            // Skip if language module unavailable
        }
    }
}

/**
 * Check if a test body references the target class (directly or via instance variable).
 * Looks at AST usages of className within the test function's line range.
 */
function _testBodyReferencesClass(index, filePath, fileEntry, testLine, className, instanceTypeMap) {
    // Find the enclosing test function to get its line range
    const enclosing = index.findEnclosingFunction(filePath, testLine, true);
    let startLine, endLine;
    if (enclosing) {
        startLine = enclosing.startLine;
        endLine = enclosing.endLine;
    } else {
        // No enclosing function found (common for JS/TS it/test callbacks which
        // aren't in the symbol table). Estimate range from file content.
        startLine = testLine;
        endLine = _estimateTestBlockEnd(index, filePath, testLine);
    }

    // Check if className appears as AST usage in the range
    const classUsages = index._getCachedUsages(filePath, className);
    if (classUsages) {
        for (const u of classUsages) {
            if (u.line >= startLine && u.line <= endLine) return true;
        }
    }

    // Check if any instance variable bound to className is used in the range
    if (instanceTypeMap) {
        for (const [varName, cls] of instanceTypeMap) {
            if (cls !== className) continue;
            const varUsages = index._getCachedUsages(filePath, varName);
            if (varUsages) {
                for (const u of varUsages) {
                    if (u.line >= startLine && u.line <= endLine) return true;
                }
            }
        }
    }

    return false;
}

/**
 * Estimate the end line of a test block (it/test/describe callback) by tracking
 * brace nesting from the start line.
 */
function _estimateTestBlockEnd(index, filePath, startLine) {
    const content = index._readFile(filePath);
    if (!content) return startLine + 5;
    const lines = content.split('\n');
    let depth = 0;
    let started = false;
    for (let i = startLine - 1; i < lines.length; i++) {
        const line = lines[i];
        for (const ch of line) {
            if (ch === '{' || ch === '(') { depth++; started = true; }
            else if (ch === '}' || ch === ')') { depth--; }
        }
        if (started && depth <= 0) return i + 1; // 1-based
    }
    return Math.min(startLine + 10, lines.length);
}

/**
 * Deduplicate matches: prefer more specific matchTypes on the same line.
 * Priority: test-case > call > import > string-ref > reference
 */
function _deduplicateMatches(matches) {
    const byLine = new Map();
    const priority = { 'test-case': 5, 'call': 4, 'import': 3, 'string-ref': 2, 'reference': 1 };
    for (const m of matches) {
        const existing = byLine.get(m.line);
        if (!existing || (priority[m.matchType] || 0) > (priority[existing.matchType] || 0)) {
            byLine.set(m.line, m);
        }
    }
    return [...byLine.values()].sort((a, b) => a.line - b.line);
}

module.exports = { find, _applyFindFilters, usages, search, structuralSearch, example, typedef, tests };
