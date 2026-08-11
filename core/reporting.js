/**
 * core/reporting.js — Project statistics and table of contents
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

'use strict';

const fs = require('fs');
const { codeUnitCompare, CALLABLE_SYMBOL_KINDS } = require('./shared');
const { _declaredFieldType, _projectTopLevelNames } = require('./callers');
const path = require('path');
const { isTestFile } = require('./discovery');
const { summarizeCommandTrust } = require('./trust-matrix');
const { projectComputedDispatch } = require('./ast-analysis');
const { langTraits } = require('../languages');

function matchesReportingScope(index, relativePath, options = {}) {
    if (!relativePath) return false;
    if (options.file && !relativePath.includes(options.file)) return false;
    const exclude = Array.isArray(options.exclude)
        ? options.exclude
        : (options.exclude
            ? String(options.exclude).split(',').map(s => s.trim()).filter(Boolean)
            : []);
    return index.matchesFilters(relativePath, {
        ...(exclude.length > 0 && { exclude }),
        ...(options.in && { in: options.in }),
    });
}

/**
 * Get project statistics: file counts, symbol counts, LOC, language breakdown.
 *
 * @param {object} index - ProjectIndex instance
 * @param {object} options - { functions, hot, top }
 * @returns {object}
 */
function getStats(index, options = {}) {
    const scopedFiles = [...index.files].filter(([, fileEntry]) =>
        matchesReportingScope(index, fileEntry.relativePath, options));
    const scopedPaths = new Set(scopedFiles.map(([filePath]) => filePath));
    const totalSymbols = scopedFiles.reduce(
        (sum, [, fileEntry]) => sum + (fileEntry.symbols || []).length, 0);

    const stats = {
        root: index.root,
        files: scopedFiles.length,
        symbols: totalSymbols,  // Total symbol count, not unique names
        buildTime: index.buildTime,
        byLanguage: {},
        byType: {},
        ...(index.truncated && { truncated: index.truncated })
    };

    for (const [, fileEntry] of scopedFiles) {
        const lang = fileEntry.language;
        if (!stats.byLanguage[lang]) {
            stats.byLanguage[lang] = { files: 0, lines: 0, symbols: 0 };
        }
        stats.byLanguage[lang].files++;
        stats.byLanguage[lang].lines += fileEntry.lines;
        stats.byLanguage[lang].symbols += fileEntry.symbols.length;
    }

    for (const [, fileEntry] of scopedFiles) {
        for (const sym of fileEntry.symbols || []) {
            if (!Object.hasOwn(stats.byType, sym.type)) {
                stats.byType[sym.type] = 0;
            }
            stats.byType[sym.type]++;
        }
    }

    // Surface build warnings (parse failures, skipped files)
    if (index.failedFiles && index.failedFiles.size > 0) {
        const failedFiles = [...index.failedFiles]
            .map(f => path.relative(index.root, f))
            .filter(rel => matchesReportingScope(index, rel, options));
        if (failedFiles.length > 0) {
            stats.warnings = {
                failedFiles,
                count: failedFiles.length,
            };
        }
    }

    // Per-function line counts for complexity audits
    if (options.functions) {
        const functions = [];
        for (const [, fileEntry] of scopedFiles) {
            for (const sym of fileEntry.symbols || []) {
                if (CALLABLE_SYMBOL_KINDS.has(sym.type)) {
                    const lineCount = sym.endLine - sym.startLine + 1;
                    const relativePath = sym.relativePath || (sym.file ? path.relative(index.root, sym.file) : '');
                    functions.push({
                        name: sym.className ? `${sym.className}.${sym.name}` : sym.name,
                        file: relativePath,
                        startLine: sym.startLine,
                        lines: lineCount
                    });
                }
            }
        }
        functions.sort((a, b) => b.lines - a.lines);
        stats.functions = functions;
    }

    // Hot list: top N functions by inbound call-site count.
    // "callCount" = number of distinct call-site lines that resolve to this name
    // across the project. Multiple definitions of the same name are listed
    // separately (per file:line) since callers may differ. The count is
    // name-keyed (not per-definition) — same trade-off as `usages` and matches
    // the rest of the codebase's call-graph approximation.
    if (options.hot) {
        // MEDIUM-7: caller (execute.js) validates and passes either a
        // positive integer, 0 (show nothing), or undefined (default 10).
        const top = options.top === 0
            ? 0
            : ((options.top != null && Number(options.top) > 0) ? Number(options.top) : 10);
        const FUNCTION_TYPES = CALLABLE_SYMBOL_KINDS;

        // Ensure the calls cache is fully populated before counting.
        // First-time stats --hot may need to parse files to extract calls;
        // subsequent runs use the persisted calls cache.
        if (typeof index.buildCalleeIndex === 'function' && !index.calleeIndex) {
            index.buildCalleeIndex();
        }

        // BUG-H2: aggregate calls by *resolution kind* so a method call like
        // `dict.get()` doesn't get attributed to a standalone `function get()`.
        //
        // Buckets per name:
        //   bareNameCounts[name]     — calls with !isMethod (e.g. `get()`)
        //   methodByReceiverType[t][name] — calls with isMethod and inferred receiverType
        //   methodByName[name]       — all isMethod calls (fallback denominator)
        //   importedReceiverCounts[name] — method calls whose receiver is an imported
        //                                  module alias in the calling file (e.g.
        //                                  `mod.foo()` where `mod` is a require alias).
        //                                  These resolve like top-level function calls.
        //
        // self/this/cls/super counted under bareNameCounts since they always resolve
        // to the enclosing class's method (handled in attribution below).
        // We dedupe per file by (name, line) so multi-record call sites count once.
        const SELF_RECEIVERS = new Set(['self', 'this', 'cls', 'super']);
        const bareNameCounts = new Map();           // name -> count
        const methodByReceiverType = new Map();      // receiverType -> Map(name -> count)
        const methodByName = new Map();              // name -> count of all method calls
        const selfMethodByName = new Map();          // name -> count of self/this.name() calls
        const importedReceiverCounts = new Map();    // name -> count of `mod.name()` calls
                                                     //          where mod is an import alias

        // Pre-compute import-alias sets per file. Used to distinguish `mod.foo()`
        // (resolves to top-level foo) from `obj.foo()` on a local variable.
        const fileImportAliases = new Map();         // filePath -> Set<string> of alias names
        const fieldHopCache = new Map();             // rootType\0field -> declared type|null
        // Names import-bound to an EXTERNAL module, per file (fix #256,
        // dogfood-measured: 895 node:test `describe(...)` calls in test
        // files were attributed to a project closure named `describe` —
        // the #215 name discipline says an externally-bound bare name
        // cannot reach a project def, so it never counts toward the hot
        // leaderboard). Relative modules, resolved modules, and resolver
        // gaps (first segment names a project path) all stay countable.
        const fileExternalNames = new Map();         // filePath -> Set<string>
        for (const [filePath, fileEntry] of scopedFiles) {
            const aliases = new Set();
            // importNames are the named imports/exports brought into this file.
            // importAliases (when present) carry namespace import aliases (e.g.
            // `import * as mod from "..."` → 'mod').
            for (const n of (fileEntry.importNames || [])) aliases.add(n);
            if (Array.isArray(fileEntry.importAliases)) {
                for (const a of fileEntry.importAliases) {
                    if (a && a.local) aliases.add(a.local);
                }
            }
            fileImportAliases.set(filePath, aliases);
            let ext = null;
            for (const b of (fileEntry.importBindings || [])) {
                const mod = String(b.module || '');
                if (!b.name || !mod || mod.startsWith('.') || mod.startsWith('/')) continue;
                if (fileEntry.moduleResolved && fileEntry.moduleResolved[mod]) continue;
                const firstSeg = mod.split(/[./]/).filter(Boolean)[0];
                if (firstSeg && _projectTopLevelNames(index).has(firstSeg)) continue;
                (ext || (ext = new Set())).add(b.name);
            }
            if (ext) fileExternalNames.set(filePath, ext);
        }

        for (const [filePath, entry] of index.callsCache) {
            if (!scopedPaths.has(filePath)) continue;
            if (!entry || !Array.isArray(entry.calls)) continue;
            const seenInFile = new Set();
            const aliasesForFile = fileImportAliases.get(filePath) || new Set();
            for (const c of entry.calls) {
                if (!c || !c.name) continue;
                const key = `${c.name}::${c.line || 0}`;
                if (seenInFile.has(key)) continue;
                seenInFile.add(key);

                const isSelfMethod = c.isMethod && SELF_RECEIVERS.has(c.receiver);
                if (!c.isMethod) {
                    // Bare-name call: foo() or pkg.Foo() (Go package call has receiver
                    // but isMethod:false — keep counting under bareName since they
                    // resolve like top-level functions in their package).
                    // Externally-bound names are the external library's calls,
                    // never a project def's (fix #256).
                    if (fileExternalNames.get(filePath)?.has(c.name)) continue;
                    bareNameCounts.set(c.name, (bareNameCounts.get(c.name) || 0) + 1);
                } else if (isSelfMethod) {
                    // self/this.foo() — attributed to the enclosing class's foo
                    selfMethodByName.set(c.name, (selfMethodByName.get(c.name) || 0) + 1);
                    methodByName.set(c.name, (methodByName.get(c.name) || 0) + 1);
                } else {
                    methodByName.set(c.name, (methodByName.get(c.name) || 0) + 1);
                    // Module-alias receiver? `mod.foo()` where `mod` was imported here.
                    // Treat the call as resolving to a top-level `foo` (the standalone
                    // function exported from `mod`).
                    if (c.receiver && aliasesForFile.has(c.receiver)) {
                        importedReceiverCounts.set(c.name,
                            (importedReceiverCounts.get(c.name) || 0) + 1);
                    }
                    // Field-access receivers (fix #251): `tm.service.Save()`
                    // carries receiverRootType, not receiverType — the same
                    // #202/#231 declared-field hop the caller/callee engine
                    // uses. Without it, edges `context` confirms were
                    // invisible to the hot leaderboard.
                    let recvType = c.receiverType;
                    if (!recvType && c.receiverField && c.receiverRootType) {
                        const hopKey = `${c.receiverRootType}\u0000${c.receiverField}`;
                        if (!fieldHopCache.has(hopKey)) {
                            const lang = index.files.get(filePath)?.language;
                            fieldHopCache.set(hopKey,
                                lang ? _declaredFieldType(index, c.receiverRootType, c.receiverField, lang) : null);
                        }
                        recvType = fieldHopCache.get(hopKey);
                    }
                    if (recvType) {
                        let inner = methodByReceiverType.get(recvType);
                        if (!inner) {
                            inner = new Map();
                            methodByReceiverType.set(recvType, inner);
                        }
                        inner.set(c.name, (inner.get(c.name) || 0) + 1);
                    }
                }
                // Also account for resolvedName aliases (e.g. `import {foo as bar}; bar()`
                // resolves to `foo`). Treat the resolved form the same way as the original.
                if (c.resolvedName && c.resolvedName !== c.name) {
                    const rkey = `${c.resolvedName}::${c.line || 0}`;
                    if (!seenInFile.has(rkey)) {
                        seenInFile.add(rkey);
                        if (!c.isMethod) {
                            bareNameCounts.set(c.resolvedName,
                                (bareNameCounts.get(c.resolvedName) || 0) + 1);
                        }
                    }
                }
            }
        }

        // For each name, count how many distinct classes/types own a method with
        // that name (used to split method-call counts when receiverType is unknown).
        const classOwnersByName = new Map();         // name -> Set<className>
        for (const [name, symbols] of index.symbols) {
            for (const sym of symbols) {
                if (!FUNCTION_TYPES.has(sym.type)) continue;
                if (!matchesReportingScope(index, sym.relativePath, options)) continue;
                const owner = sym.className || (sym.receiver && sym.receiver.replace(/^\*/, ''));
                if (owner) {
                    let s = classOwnersByName.get(name);
                    if (!s) { s = new Set(); classOwnersByName.set(name, s); }
                    s.add(owner);
                }
            }
        }

        // MEDIUM-6: aggregate by name. Multiple definitions of the same name
        // in different files (e.g. `tmp` in test/helpers/index.js AND
        // test/accuracy.test.js) previously each got the GLOBAL call count,
        // duplicating the row and inflating the leaderboard. We now emit
        // one row per name with a `locations` list, so the user sees both
        // definitions but the count appears exactly once.
        //
        // BUG-H2: with the buckets above, attribute counts per (name, ownerClass):
        //   - standalone function:   bareNameCounts[name]
        //   - class method (Foo.bar): methodByReceiverType[Foo][bar]
        //                              + selfMethodByName[bar] / numOwnerClasses
        //                              + (residual unresolved method calls split evenly)
        //   - falls back to methodByName[name] when no receiverType evidence exists.
        const hotList = [];
        const { findCallers } = require('./callers');
        const scopedCallerQuery = !!(options.file || options.in ||
            (options.exclude && options.exclude.length > 0));
        const seenDefinitions = new Set();
        for (const [name, symbols] of index.symbols) {
            if (!index.calleeIndex?.has(name)) continue;
            const callable = symbols.filter(symbol =>
                FUNCTION_TYPES.has(symbol.type) &&
                matchesReportingScope(index, symbol.relativePath, options));
            for (const symbol of callable) {
                const identity = `${symbol.file}:${symbol.startLine}:${name}:` +
                    `${symbol.className || symbol.receiver || ''}:${symbol.params || ''}`;
                if (seenDefinitions.has(identity)) continue;
                seenDefinitions.add(identity);

                // A linked C/C++ prototype and implementation close to the
                // same compiler identity. Show the implementation once.
                if (symbol.isSignature && callable.some(candidate =>
                    !candidate.isSignature &&
                    (candidate.className || candidate.receiver || null) ===
                        (symbol.className || symbol.receiver || null) &&
                    (index.importGraph.get(candidate.file)?.has(symbol.file) ||
                        index.importGraph.get(symbol.file)?.has(candidate.file)))) {
                    continue;
                }

                const exact = findCallers(index, name, {
                    targetDefinitions: [symbol],
                    includeTests: true,
                    collectAccount: true,
                });
                const count = exact.filter(caller =>
                    caller.tier !== 'unverified' &&
                    (!scopedCallerQuery || scopedPaths.has(caller.file)) &&
                    (!options.productionCallsOnly ||
                        !require('./shared').isTestPath(caller.relativePath || caller.file))).length;
                if (count === 0) continue;
                const owner = symbol.className ||
                    (symbol.receiver || '').replace(/^\*/, '');
                hotList.push({
                    name: owner ? `${owner}.${name}` : name,
                    file: symbol.relativePath,
                    startLine: symbol.startLine,
                    endLine: symbol.endLine,
                    callCount: count,
                    evidence: 'confirmed-callers',
                });
            }
        }

        // Stable order: callCount desc, then (relativePath, startLine) asc.
        hotList.sort((a, b) =>
            (b.callCount - a.callCount) ||
            codeUnitCompare(a.file, b.file) ||
            (a.startLine || 0) - (b.startLine || 0)
        );

        stats.hot = {
            top,
            total: hotList.length,
            items: hotList.slice(0, top),
            note: 'Counts are confirmed caller-engine edges pinned to each displayed definition; unverified dispatch is excluded.',
        };
    }

    return stats;
}

/**
 * Get table of contents for all files in the project.
 *
 * @param {object} index - ProjectIndex instance
 * @param {object} options - { file, exclude, in, detailed, topLevel, all, top }
 * @returns {object}
 */
function getToc(index, options = {}) {
    const files = [];
    let totalFunctions = 0;
    let totalClasses = 0;
    let totalState = 0;
    let totalLines = 0;
    let totalDynamic = 0;
    let totalTests = 0;

    // When file= is specified, scope to matching files only
    let fileFilter = null;
    if (options.file) {
        const resolved = index.findFile(options.file);
        if (resolved) {
            fileFilter = new Set([resolved]);
        } else {
            // Try substring match for partial paths
            const matching = [];
            for (const fp of index.files.keys()) {
                const rp = path.relative(index.root, fp);
                if (rp.includes(options.file) || fp.includes(options.file)) {
                    matching.push(fp);
                }
            }
            if (matching.length > 0) {
                fileFilter = new Set(matching);
            } else {
                return {
                    meta: { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0 },
                    totals: { files: 0, lines: 0, functions: 0, classes: 0, state: 0, testFiles: 0 },
                    summary: { topFunctionFiles: [], topLineFiles: [], entryFiles: [] },
                    files: [],
                    hiddenFiles: 0,
                    error: `File not found in project: ${options.file}`
                };
            }
        }
    }

    for (const [filePath, fileEntry] of index.files) {
        if (fileFilter && !fileFilter.has(filePath)) continue;
        if (options.exclude && options.exclude.length > 0) {
            if (!index.matchesFilters(fileEntry.relativePath, { exclude: options.exclude })) continue;
        }
        if (options.in) {
            if (!index.matchesFilters(fileEntry.relativePath, { in: options.in })) continue;
        }
        // Every callable kind, incl. accessors/properties/indexers — a
        // hand-rolled subset here silently dropped C# `this[]` (kind
        // 'property') and Python accessor kinds from the detailed listing.
        let functions = fileEntry.symbols.filter(s => CALLABLE_SYMBOL_KINDS.has(s.type));
        const classes = fileEntry.symbols.filter(s =>
            ['class', 'interface', 'type', 'enum', 'struct', 'trait', 'impl', 'record', 'namespace'].includes(s.type)
        );
        const state = fileEntry.symbols.filter(s => s.type === 'state');

        if (options.topLevel) {
            functions = functions.filter(fn => !fn.isNested && (!fn.indent || fn.indent === 0));
        }

        totalFunctions += functions.length;
        totalClasses += classes.length;
        totalState += state.length;
        totalLines += fileEntry.lines;
        totalDynamic += fileEntry.dynamicImports || 0;
        if (isTestFile(fileEntry.relativePath, fileEntry.language)) totalTests += 1;

        const entry = {
            file: fileEntry.relativePath,
            language: fileEntry.language,
            lines: fileEntry.lines,
            functions: functions.length,
            classes: classes.length,
            state: state.length
        };

        if (options.detailed) {
            entry.symbols = { functions, classes, state };
        }

        files.push(entry);
    }

    // Hints: top files by function count and lines
    const hintLimit = options.all ? Infinity : 3;
    const topFunctionFiles = [...files]
        .sort((a, b) => b.functions - a.functions || b.lines - a.lines)
        .filter(f => f.functions > 0)
        .slice(0, hintLimit)
        .map(f => ({ file: f.file, functions: f.functions }));

    const topLineFiles = [...files]
        .sort((a, b) => b.lines - a.lines)
        .slice(0, hintLimit)
        .map(f => ({ file: f.file, lines: f.lines }));

    // Entry point candidates
    const entryPattern = /(main|index|server|app)\.(js|jsx|ts|tsx|py|go|rs|java)$/i;
    const entryFiles = files
        .filter(f => entryPattern.test(f.file))
        .slice(0, options.all ? Infinity : 5)
        .map(f => f.file);

    // Also detect entry points from package.json main/exports fields
    const pkgJsonPath = path.join(index.root, 'package.json');
    try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        const mainField = pkgJson.main || pkgJson.module;
        if (mainField) {
            const mainFile = path.relative(index.root, path.resolve(index.root, mainField));
            if (files.some(f => f.file === mainFile) && !entryFiles.includes(mainFile)) {
                entryFiles.unshift(mainFile);
            }
        }
    } catch {
        // No package.json or invalid JSON — skip
    }

    // Apply top limit for detailed mode to avoid massive output
    const top = options.top > 0 ? options.top : (options.detailed && !options.all ? 50 : Infinity);
    let hiddenFiles = 0;
    let displayFiles = files;
    if (top < files.length) {
        hiddenFiles = files.length - top;
        displayFiles = files.slice(0, top);
    }

    // Count files with no symbols (generated/empty files)
    const emptyFiles = files.filter(f => f.functions === 0 && f.classes === 0 && f.state === 0).length;

    return {
        meta: {
            // `complete` describes this returned list, while the narrower
            // dynamic-import fact has an unambiguous name of its own.
            complete: hiddenFiles === 0 && totalDynamic === 0,
            noDynamicImports: totalDynamic === 0,
            skipped: 0,
            dynamicImports: totalDynamic,
            uncertain: 0,
            projectLanguage: index._getPredominantLanguage(),
            ...(fileFilter && { filteredBy: options.file, matchedFiles: files.length }),
            ...(options.in && { scopedTo: options.in }),
            ...(emptyFiles > 0 && fileFilter && { emptyFiles })
        },
        totals: {
            files: files.length,
            lines: totalLines,
            functions: totalFunctions,
            classes: totalClasses,
            state: totalState,
            testFiles: totalTests
        },
        summary: {
            topFunctionFiles,
            topLineFiles,
            entryFiles
        },
        files: displayFiles,
        hiddenFiles
    };
}

/**
 * Project trust report. Tells the caller how much UCN itself trusts the index
 * for this project: sampled resolution evidence, blind spots (dynamic imports, eval,
 * reflection), parse failures, and a quick verdict.
 *
 * Cheap-by-default: counts + blind-spot scan are O(files). The expensive
 * confidence-coverage computation is deferred unless options.deep is set
 * (then samples a slice of symbols).
 *
 * @param {object} index - ProjectIndex
 * @param {object} options - { deep, sampleSize, in, file }
 */
function doctor(index, options = {}) {
    const projectLanguage = index._getPredominantLanguage();
    const staticSpecialImports = projectLanguage &&
        !langTraits(projectLanguage)?.hasDynamicImports;
    const importBlindspotLabel = staticSpecialImports
        ? (projectLanguage === 'rust' ? 'glob import(s)' : 'blank/dot import(s)')
        : 'dynamic import(s)';
    const normalizedExclude = Array.isArray(options.exclude)
        ? options.exclude.filter(Boolean)
        : (options.exclude
            ? String(options.exclude).split(',').map(s => s.trim()).filter(Boolean)
            : []);
    const hasFilter = !!(options.in || options.file || normalizedExclude.length > 0);
    const matchInFilter = (rel) => matchesReportingScope(index, rel, options);

    const fileCounts = { total: 0, scanned: 0 };
    const langs = {};
    let totalSymbols = 0;  // counted post-filter for accuracy when --in is set
    // Each category tracks: count = total OCCURRENCES (uses), fileCount = TRUE
    // number of files affected (uncapped), files = a capped sample for display.
    // Keeping count and fileCount distinct is what lets the formatter say
    // "481 uses in 121 files" instead of mislabeling a file count as uses or
    // presenting the 10-file display cap as the population (field-report #2).
    const BLINDSPOT_FILE_CAP = 10;
    const blindSpots = {
        dynamicImports: { count: 0, fileCount: 0, files: [] },
        evalCalls:      { count: 0, fileCount: 0, files: [] },
        reflection:     { count: 0, fileCount: 0, files: [] },
        computedDispatch:{ count: 0, fileCount: 0, files: [] },
        parseFailures:  { count: 0, fileCount: 0, files: [] },
        parseRecoveries:{ count: 0, fileCount: 0, files: [] },
        unsupportedSources: {
            count: 0, fileCount: 0, files: [], languages: {}, extensions: {},
        },
        skippedSources: { count: 0, fileCount: 0, files: [], reasons: {} },
    };

    // Reflection/eval signals come from the shared text-blind-spot counter
    // (core/shared.js) — the SAME routine detectCompleteness uses for the about
    // footer, so the two never drift (field-report #2). Occurrence counts.
    const { hasTextBlindspots, countTextBlindspots } = require('./shared');

    const computedDispatch = projectComputedDispatch(index);
    for (const [filePath, fe] of index.files) {
        fileCounts.total++;
        const rel = fe.relativePath || filePath;
        if (!matchInFilter(rel)) continue;
        fileCounts.scanned++;

        const lang = fe.language || 'unknown';
        if (!langs[lang]) langs[lang] = { files: 0, symbols: 0, lines: 0 };
        langs[lang].files++;
        langs[lang].symbols += (fe.symbols || []).length;
        langs[lang].lines += fe.lines || 0;
        totalSymbols += (fe.symbols || []).length;

        const recordBlind = (cat, occurrences) => {
            if (occurrences <= 0) return;
            cat.count += occurrences;
            cat.fileCount++;
            if (cat.files.length < BLINDSPOT_FILE_CAP) cat.files.push(rel);
        };

        if (fe.dynamicImports && fe.dynamicImports > 0) recordBlind(blindSpots.dynamicImports, fe.dynamicImports);
        if (computedDispatch.has(filePath)) {
            recordBlind(blindSpots.computedDispatch,
                computedDispatch.get(filePath).length);
        }
        if (fe.parseError) recordBlind(blindSpots.parseFailures, 1);
        if (fe.parseRecovery) recordBlind(blindSpots.parseRecoveries, 1);

        // Read file once for eval/reflection signals (shared counter).
        if (hasTextBlindspots(lang)) {
            try {
                const bs = countTextBlindspots(fs.readFileSync(filePath, 'utf-8'), lang);
                recordBlind(blindSpots.evalCalls, bs.eval);
                recordBlind(blindSpots.reflection, bs.reflection);
            } catch (e) { /* ignore read errors */ }
        }
    }

    // Files that failed before a fileEntry could be created are absent from
    // index.files, so the loop above can never see them. They are the most
    // important parse failures to surface: otherwise doctor can report a
    // clean index precisely when entire files are missing from it.
    const recordedParseFailureFiles = new Set(blindSpots.parseFailures.files);
    for (const failedPath of index.failedFiles || []) {
        const rel = path.relative(index.root, failedPath);
        if (!matchInFilter(rel) || recordedParseFailureFiles.has(rel)) continue;
        blindSpots.parseFailures.count++;
        blindSpots.parseFailures.fileCount++;
        fileCounts.failed = (fileCounts.failed || 0) + 1;
        if (blindSpots.parseFailures.files.length < BLINDSPOT_FILE_CAP) {
            blindSpots.parseFailures.files.push(rel);
        }
        recordedParseFailureFiles.add(rel);
    }

    // Project-wide discovery also records common source languages for which
    // UCN has no parser. These are not parse failures: they are an explicit
    // engine boundary and a required grep/ripgrep handoff.
    for (const skipped of index.unsupportedFiles || []) {
        const rel = skipped.relativePath;
        if (!matchInFilter(rel)) continue;
        const unsupported = blindSpots.unsupportedSources;
        unsupported.count++;
        unsupported.fileCount++;
        unsupported.languages[skipped.language] =
            (unsupported.languages[skipped.language] || 0) + 1;
        unsupported.extensions[skipped.extension] =
            (unsupported.extensions[skipped.extension] || 0) + 1;
        if (unsupported.files.length < BLINDSPOT_FILE_CAP) unsupported.files.push(rel);
    }
    fileCounts.unsupported = blindSpots.unsupportedSources.fileCount;

    for (const issue of index.discoveryIssues || []) {
        const rel = issue.relativePath || '.';
        if (!matchInFilter(rel)) continue;
        const skipped = blindSpots.skippedSources;
        skipped.count++;
        skipped.fileCount++;
        skipped.reasons[issue.reason || 'unknown'] =
            (skipped.reasons[issue.reason || 'unknown'] || 0) + 1;
        if (skipped.files.length < BLINDSPOT_FILE_CAP) skipped.files.push(rel);
    }
    fileCounts.skipped = blindSpots.skippedSources.fileCount;

    // Evidence profile — sampled only in deep mode. This is deliberately NOT
    // called "accuracy" or "coverage": it describes how UCN classified edges
    // it found. Compiler/LSP oracle evaluation is the accuracy measurement.
    let evidenceProfile = null;
    if (options.deep || options.sampleSize) {
        evidenceProfile = computeEvidenceProfile(index, {
            sampleSize: options.sampleSize || 200,
            matchInFilter,
        });
    }

    // Cache info
    let cache = { fresh: null };
    try {
        cache.fresh = !index.isCacheStale();
        cache.buildMs = index.buildTime || null;
    } catch (e) { /* ignore */ }

    const blindSignals = [];
    if (blindSpots.parseFailures.count > 0) blindSignals.push(`${blindSpots.parseFailures.count} parse failure(s)`);
    if (blindSpots.parseRecoveries.count > 0) blindSignals.push(`${blindSpots.parseRecoveries.count} parse-recovery file(s)`);
    if (blindSpots.evalCalls.count > 0) blindSignals.push(`${blindSpots.evalCalls.count} eval/exec use(s) in ${blindSpots.evalCalls.fileCount} file(s)`);
    if (blindSpots.reflection.count > 0) blindSignals.push(`${blindSpots.reflection.count} reflection use(s) in ${blindSpots.reflection.fileCount} file(s)`);
    if (blindSpots.computedDispatch.count > 0) {
        blindSignals.push(`${blindSpots.computedDispatch.count} computed dispatch call(s) in ${blindSpots.computedDispatch.fileCount} file(s)`);
    }
    if (blindSpots.dynamicImports.count > 0) blindSignals.push(`${blindSpots.dynamicImports.count} ${importBlindspotLabel} in ${blindSpots.dynamicImports.fileCount} file(s)`);
    if (blindSpots.unsupportedSources.count > 0) {
        const mix = Object.entries(blindSpots.unsupportedSources.languages)
            .map(([language, count]) => `${language} ${count}`)
            .join(', ');
        blindSignals.push(`${blindSpots.unsupportedSources.count} unsupported source file(s): ${mix}`);
    }
    if (blindSpots.skippedSources.count > 0) {
        const reasons = Object.entries(blindSpots.skippedSources.reasons)
            .map(([reason, count]) => `${reason} ${count}`).join(', ');
        blindSignals.push(`${blindSpots.skippedSources.count} source discovery gap(s): ${reasons}`);
    }

    // Trust is task-specific. A healthy index can be excellent for navigation
    // while still requiring review before a breaking refactor or deletion.
    // Never infer semantic accuracy from rule-assigned confidence decimals.
    const unsupportedCount = blindSpots.unsupportedSources.count;
    const incompleteIndex = blindSpots.parseFailures.count > 0 ||
        blindSpots.parseRecoveries.count > 0 || cache.fresh === false ||
        !!index.truncated || unsupportedCount > 0 || blindSpots.skippedSources.count > 0;
    const indexLevel = fileCounts.scanned === 0 && unsupportedCount > 0 ? 'UNSUPPORTED'
        : fileCounts.scanned === 0 ? 'UNKNOWN'
            : incompleteIndex ? 'PARTIAL' : 'HIGH';
    const indexReason = fileCounts.scanned === 0 && unsupportedCount > 0
        ? `0 supported files indexed; ${unsupportedCount} unsupported source file(s) require grep/ripgrep`
        : fileCounts.scanned === 0 ? 'empty scope'
        : blindSpots.parseFailures.count > 0
            ? `${blindSpots.parseFailures.count} file(s) failed to parse`
            : blindSpots.parseRecoveries.count > 0
                ? `${blindSpots.parseRecoveries.count} file(s) required parser recovery; indexed results may be partial`
                : cache.fresh === false ? 'index cache is stale'
                    : index.truncated ? `file discovery stopped at maxFiles=${index.truncated.maxFiles}`
                        : blindSpots.skippedSources.count > 0
                            ? `${blindSpots.skippedSources.count} source path(s) were not indexed; inspect discovery reasons`
                        : unsupportedCount > 0
                            ? `${fileCounts.scanned} supported file(s) indexed; ${unsupportedCount} unsupported source file(s) require grep/ripgrep`
                            : 'fresh index; no parse failures';

    let evidenceLevel = 'UNKNOWN';
    let evidenceReason = 'not sampled; run --deep for a stratified evidence profile';
    if (evidenceProfile) {
        if (evidenceProfile.total === 0) {
            evidenceLevel = 'NONE';
            evidenceReason = 'sample contained no caller edges';
        } else {
            const confirmedShare = evidenceProfile.confirmed / evidenceProfile.total;
            // Confirmed share is a classification mix, not accuracy and not a
            // readiness score. A conservative engine can be excellent while
            // intentionally routing many edges to visible unverified bands.
            evidenceLevel = evidenceProfile.adequate ? 'PROFILED' : 'LIMITED';
            evidenceReason = `${(confirmedShare * 100).toFixed(1)}% confirmed-evidence edges across ${evidenceProfile.sampled} pinned definitions`;
            if (!evidenceProfile.adequate) evidenceReason += '; sample too small for a readiness decision';
        }
    }

    const dynamicCount = blindSpots.evalCalls.count + blindSpots.reflection.count +
        blindSpots.dynamicImports.count + blindSpots.computedDispatch.count;
    const semanticLevel = blindSpots.parseFailures.count > 0 || blindSpots.parseRecoveries.count > 0 ? 'LOW'
        : unsupportedCount > 0 ? 'PARTIAL'
            : dynamicCount > 0 ? 'REVIEW' : 'UNKNOWN';
    const semanticReason = blindSignals.length
        ? `semantic recall may miss runtime-resolved edges: ${blindSignals.join(', ')}`
        : 'no known runtime blind spots detected; alias/dynamic completeness is not compiler-verified locally';

    const navigationLevel = indexLevel;
    const hardIndexRisk = blindSpots.parseFailures.count > 0 ||
        blindSpots.parseRecoveries.count > 0 || cache.fresh === false || !!index.truncated;
    const refactorLevel = indexLevel === 'UNKNOWN' ? 'UNKNOWN'
        : indexLevel === 'UNSUPPORTED' ? 'UNSUPPORTED'
            : hardIndexRisk ? 'LOW'
                : unsupportedCount > 0 ? 'PARTIAL' : 'REVIEW';
    const deletionLevel = refactorLevel === 'LOW' ? 'LOW' : 'REVIEW';
    const dimensions = {
        index: { level: indexLevel, reason: indexReason },
        evidence: { level: evidenceLevel, reason: evidenceReason },
        semanticRecall: { level: semanticLevel, reason: semanticReason },
        navigation: { level: navigationLevel, reason: indexReason },
        refactor: {
            level: refactorLevel,
            reason: indexLevel === 'UNKNOWN'
                ? 'no supported source scope was indexed'
                : indexLevel === 'UNSUPPORTED'
                    ? 'UCN cannot analyze this source scope; use grep/ripgrep and a language-native tool'
                    : unsupportedCount > 0
                        ? 'supported files are analyzable, but skipped language files require grep/ripgrep before cross-language changes'
                        : 'text-ground accounting is available; aliases, reflection, and unverified edges still require review',
        },
        deletion: {
            level: deletionLevel,
            reason: 'deletion additionally requires usages/deadcode review and tests; caller accounting alone is insufficient',
        },
    };
    // `repo` is an orientation/navigation command. Its headline must answer
    // that task, while refactor/deletion remain separately visible dimensions.
    const trust = navigationLevel;
    const trustReason = dimensions.navigation.reason;

    return {
        root: index.root,
        projectLanguage,
        version: require('../package.json').version,  // running ucn version — surfaces MCP/CLI drift (field-report #3)
        files: fileCounts,
        symbols: totalSymbols,
        languages: langs,
        blindSpots,
        evidenceProfile,
        cache,
        commandTrust: summarizeCommandTrust(),
        trust,
        trustReason,
        trustScope: 'navigation-readiness',
        dimensions,
        ...(hasFilter && {
            filter: {
                ...(options.file && { file: options.file }),
                ...(options.in && { in: options.in }),
                ...(normalizedExclude.length > 0 && { exclude: normalizedExclude }),
            },
        }),
    };
}

/**
 * Sample-based coverage: pick up to N symbols, run findCallers, bucket confidence.
 * Doesn't pretend to be exhaustive — meant for a fast trust signal, not an audit.
 */
function computeEvidenceProfile(index, { sampleSize, matchInFilter }) {
    const profile = {
        kind: 'evidence-profile-not-accuracy',
        high: 0, medium: 0, low: 0,
        confirmed: 0, unverified: 0, total: 0,
        sampled: 0, candidateSymbols: 0,
        adequate: false, representative: false,
        byLanguage: Object.create(null), byKind: Object.create(null),
    };
    const groups = new Map();
    const seenHandles = new Set();
    for (const [, arr] of index.symbols) {
        for (const sym of arr) {
            if (!sym || !sym.relativePath || !matchInFilter(sym.relativePath)) continue;
            if (sym.type !== 'method' && sym.type !== 'function' && sym.type !== 'constructor') continue;
            const handle = `${sym.relativePath}:${sym.startLine}:${sym.name}`;
            if (seenHandles.has(handle)) continue;
            seenHandles.add(handle);
            const lang = index.files.get(sym.file)?.language || 'unknown';
            const key = `${lang}:${sym.type}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ sym, handle, lang });
        }
    }
    profile.candidateSymbols = seenHandles.size;
    for (const items of groups.values()) {
        items.sort((a, b) => codeUnitCompare(a.handle, b.handle));
    }

    // Round-robin across language+kind buckets so discovery order, duplicate
    // names, and one large language cannot dominate the verdict.
    const orderedGroups = [...groups.entries()].sort((a, b) => codeUnitCompare(a[0], b[0]));
    const sample = [];
    for (let round = 0; sample.length < sampleSize; round++) {
        let added = false;
        for (const [, items] of orderedGroups) {
            if (items[round]) {
                sample.push(items[round]);
                added = true;
                if (sample.length >= sampleSize) break;
            }
        }
        if (!added) break;
    }
    profile.sampled = sample.length;

    for (const { sym, lang } of sample) {
        profile.byLanguage[lang] = (profile.byLanguage[lang] || 0) + 1;
        profile.byKind[sym.type] = (profile.byKind[sym.type] || 0) + 1;
        const callers = index.findCallers(sym.name, {
            includeMethods: true,
            includeUncertain: true,
            targetDefinitions: [sym],
            collectAccount: true,
        });
        const allEdges = [...callers, ...(callers.unverifiedEntries || [])];
        const seenSites = new Set();
        for (const c of allEdges) {
            const rel = c.relativePath ||
                (c.file && path.isAbsolute(c.file) ? path.relative(index.root, c.file) : c.file);
            if (!matchInFilter(rel)) continue;
            const site = `${c.file || c.relativePath}:${c.line}:${c.tier || c.reason || ''}`;
            if (seenSites.has(site)) continue;
            seenSites.add(site);
            const conf = c.confidence != null ? c.confidence : 0;
            profile.total++;
            if (c.tier === 'unverified' || c.reason) profile.unverified++;
            else profile.confirmed++;
            if (conf > 0.8) profile.high++;
            else if (conf >= 0.5) profile.medium++;
            else profile.low++;
        }
    }
    const representedGroups = Object.keys(profile.byLanguage).length;
    profile.representative = representedGroups === new Set(
        [...groups.keys()].map(k => k.split(':')[0])
    ).size;
    const minSymbols = Math.min(30, profile.candidateSymbols);
    profile.adequate = profile.sampled >= minSymbols && profile.total >= 20 && profile.representative;
    return profile;
}

/**
 * orient — one-call cold-repo orientation: size + language mix, densest
 * directories, most-called functions, entry-point counts, and the doctor
 * trust verdict. Composes existing engine reads; counts and pointers only
 * (no caller claims, so no account — the toc/stats category).
 */
function orient(index, options = {}) {
    const top = options.top || 8;
    // Fetch a deeper hot list so production functions survive the filter
    // below even when test helpers dominate raw call counts.
    const scope = {
        file: options.file,
        in: options.in,
        exclude: options.exclude,
    };
    const { isTestPath } = require('./shared');
    const hasProductionFiles = [...index.files.values()].some(fileEntry => {
        const relativePath = fileEntry.relativePath;
        return relativePath &&
            matchesReportingScope(index, relativePath, scope) &&
            !isTestPath(relativePath);
    });
    const stats = getStats(index, {
        ...scope,
        hot: true,
        top: Math.min(top * 5, 200),
        // A production-only call count is useful only when the selected scope
        // actually contains production files. In an all-test repository it
        // would erase the raw ranking that orient promises as its fallback.
        productionCallsOnly: options.includeTests !== true && hasProductionFiles,
    });
    const health = doctor(index, scope);

    // Densest directories (leaf dirname rollup — "where does the code live")
    const dirMap = new Map();
    for (const [, fe] of index.files) {
        const rp = fe.relativePath;
        if (!rp || !matchesReportingScope(index, rp, scope)) continue;
        const slash = rp.lastIndexOf('/');
        const dir = slash === -1 ? '.' : rp.slice(0, slash);
        const e = dirMap.get(dir) || { dir, files: 0, symbols: 0 };
        e.files += 1;
        e.symbols += (fe.symbols || []).length;
        dirMap.set(dir, e);
    }
    const dirs = [...dirMap.values()]
        .sort((a, b) => b.symbols - a.symbols || codeUnitCompare(a.dir, b.dir))
        .slice(0, top);

    // Entry-point counts by type — orientation must not fail on detection
    let entrypoints = null;
    try {
        const { detectEntrypoints } = require('./entrypoints');
        const { addTestExclusions } = require('./shared');
        const orientExclude = Array.isArray(options.exclude)
            ? options.exclude
            : (options.exclude
                ? String(options.exclude).split(',').map(s => s.trim()).filter(Boolean)
                : []);
        // Same default as the entrypoints command: the orientation count
        // describes the project's own entry surface, not test fixtures.
        const detected = detectEntrypoints(index, {
            file: options.file,
            exclude: options.includeTests === true
                ? orientExclude
                : addTestExclusions(orientExclude),
        });
        const eps = Array.isArray(detected)
            ? detected.filter(entry => matchesReportingScope(
                index, entry.relativePath || entry.file, scope))
            : detected;
        if (Array.isArray(eps)) {
            const byType = new Map();
            for (const e of eps) byType.set(e.type, (byType.get(e.type) || 0) + 1);
            entrypoints = {
                total: eps.length,
                byType: [...byType.entries()]
                    .map(([type, count]) => ({ type, count }))
                    .sort((a, b) => b.count - a.count || codeUnitCompare(a.type, b.type)),
            };
        }
    } catch { /* detection error → entrypoints stays null, rendered as unavailable */ }

    // Orientation wants the ENGINE's hot functions, not fixture helpers —
    // prefer production-path entries (labeled as such by the formatter);
    // an all-test project falls back to the raw ranking.
    const allHot = (stats.hot?.items || []).map(i => ({
        name: i.name,
        file: i.file,
        line: i.startLine,
        callCount: i.callCount,
        ...(i.className ? { className: i.className } : {}),
    }));
    const prodHot = allHot.filter(i => i.file && !isTestPath(i.file));
    const production = prodHot.length > 0;
    const hotItems = (production ? prodHot : allHot).slice(0, top);
    const hottestProd = hotItems[0] || null;

    return {
        root: stats.root,
        ...(options.in && { scope: options.in }),
        ...(options.file && !options.in && { scope: options.file }),
        files: stats.files,
        symbols: stats.symbols,
        buildTime: stats.buildTime,
        byLanguage: stats.byLanguage,
        dirs,
        hot: { total: stats.hot?.total ?? 0, top, production, items: hotItems },
        entrypoints,
        trust: {
            level: health.trust,
            projectLanguage: health.projectLanguage,
            blindSpots: {
                dynamicImports: health.blindSpots?.dynamicImports?.count ?? 0,
                evalCalls: health.blindSpots?.evalCalls?.count ?? 0,
                reflection: health.blindSpots?.reflection?.count ?? 0,
                parseFailures: health.blindSpots?.parseFailures?.count ?? 0,
                parseRecoveries: health.blindSpots?.parseRecoveries?.count ?? 0,
                unsupportedSources: health.blindSpots?.unsupportedSources?.count ?? 0,
                skippedSources: health.blindSpots?.skippedSources?.count ?? 0,
            },
        },
        unsupportedSources: health.blindSpots?.unsupportedSources ?? null,
        skippedSources: health.blindSpots?.skippedSources ?? null,
        projectLanguage: health.projectLanguage,
        suggest: hottestProd ? hottestProd.name : null,
    };
}

module.exports = { getStats, getToc, doctor, orient };
