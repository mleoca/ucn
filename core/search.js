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
const { detectLanguage, getParser, langTraits } = require('../languages');

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
    const fileFilter = options.file ? index.resolveFilePathForQuery(options.file) : null;

    // Get definitions (filtered)
    let allDefinitions = index.symbols.get(name) || [];
    if (options.className) {
        allDefinitions = allDefinitions.filter(d => d.className === options.className);
    }
    if (fileFilter) {
        allDefinitions = allDefinitions.filter(d => d.file === fileFilter);
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
        // Apply --file filter
        if (fileFilter && filePath !== fileFilter) {
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
                    const importedFiles = index.importGraph.get(filePath) || [];
                    _importedHasDef = importedFiles.some(imp => {
                        const impEntry = index.files.get(imp);
                        return impEntry?.symbols?.some(s => s.name === name);
                    });
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
 * Find tests for a function or file
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} nameOrFile - Function name or file path
 * @param {object} options - { callsOnly }
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

    // Find all test files
    const testFiles = [];
    for (const [filePath, fileEntry] of index.files) {
        if (isTestFile(fileEntry.relativePath, fileEntry.language)) {
            testFiles.push({ path: filePath, entry: fileEntry });
        } else if (fileEntry.language === 'rust') {
            // Rust idiomatically puts tests in #[cfg(test)] modules inside source files.
            // Check if file has any symbols with 'test' modifier (#[test] attribute).
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

    // Note: no 'g' flag - we only need to test for presence per line
    // The 'i' flag is kept for case-insensitive matching
    const regex = new RegExp('\\b' + escapeRegExp(searchTerm) + '\\b', 'i');
    // Pre-compile patterns used inside per-line loop
    const callPattern = new RegExp(escapeRegExp(searchTerm) + '\\s*\\(');
    const strPattern = new RegExp("['\"`]" + escapeRegExp(searchTerm) + "['\"`]");

    for (const { path: testPath, entry } of testFiles) {
        try {
            const content = index._readFile(testPath);
            const lines = content.split('\n');
            const matches = [];

            lines.forEach((line, idx) => {
                if (regex.test(line)) {
                    let matchType = 'reference';
                    if (/\b(describe|it|test|spec)\s*\(/.test(line)) {
                        matchType = 'test-case';
                    } else if (/\b(import|require|from)\b/.test(line)) {
                        matchType = 'import';
                    } else if (callPattern.test(line)) {
                        matchType = 'call';
                    }
                    // Detect if the match is inside a string literal (e.g., 'parseFile' or "parseFile")
                    if (matchType === 'reference' || matchType === 'call') {
                        if (strPattern.test(line)) {
                            matchType = 'string-ref';
                        }
                    }

                    matches.push({
                        line: idx + 1,
                        content: line.trim(),
                        matchType
                    });
                }
            });

            const filtered = options.callsOnly
                ? matches.filter(m => m.matchType === 'call' || m.matchType === 'test-case')
                : matches;
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

module.exports = { find, _applyFindFilters, usages, search, structuralSearch, example, typedef, tests };
