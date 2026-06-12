/**
 * core/analysis.js — Analysis commands (context, smart, related, impact, about, diffImpact, detectCompleteness)
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parse } = require('./parser');
const { detectLanguage, langTraits } = require('../languages');
const { NON_CALLABLE_TYPES, addTestExclusions } = require('./shared');
const { computeReachability, symbolKey } = require('./entrypoints');
const { getLanguageModule } = require('../languages');

// JS/TS test framework helpers — calls to these bracket a test case.
// Used to flag call sites whose enclosing function is an arrow callback
// passed to one of these (the common pattern in mocha/jest/vitest).
const _JS_TEST_FRAMEWORK_CALLS = new Set(['describe', 'it', 'test', 'spec', 'context', 'suite']);

/**
 * Tag each call site with `inTestCase` based on its enclosing function's
 * entry-point classification. Uses each language's `getEntryPointKind`
 * predicate (kind === 'test') so results match `affectedTests`/etc.
 *
 * For JS/TS/HTML, function-level entry-point classification only covers
 * framework lifecycle methods. Test bodies are framework callbacks
 * (`it('name', () => {...})`), so we additionally tag a site as inTestCase
 * when its file has a `describe`/`it`/`test` framework call that brackets
 * the enclosing function — mirroring `_addAffectedTestCases` in tracing.js.
 *
 * Mutates each site in place (sets `site.inTestCase = boolean`).
 */
function tagInTestCase(index, sites) {
    if (!Array.isArray(sites) || sites.length === 0) return;
    // Per-file cache: language module + JS framework call ranges.
    const fileMeta = new Map();
    function getFileMeta(filePath) {
        if (!filePath) return null;
        if (fileMeta.has(filePath)) return fileMeta.get(filePath);
        const fe = index.files.get(filePath);
        if (!fe) { fileMeta.set(filePath, null); return null; }
        let langModule = null;
        try { langModule = getLanguageModule(fe.language); } catch (_) { /* ignore */ }
        const meta = { fileEntry: fe, langModule, language: fe.language, jsTestRanges: null };
        // For JS-family files, build line ranges of describe/it/test framework calls.
        if (langModule && (fe.language === 'javascript' || fe.language === 'typescript' ||
            fe.language === 'tsx' || fe.language === 'html')) {
            try {
                const calls = index.getCachedCalls ? index.getCachedCalls(filePath) : null;
                if (Array.isArray(calls)) {
                    const ranges = [];
                    for (const call of calls) {
                        if (!_JS_TEST_FRAMEWORK_CALLS.has(call.name)) continue;
                        // Get the enclosing test-block end via existing fn-bound estimate.
                        // Without a proper bracket scan we use the next-fn-boundary or +200 lines.
                        let endLine = call.line + 200;
                        // Try using the enclosing-symbol range as an upper bound when possible.
                        if (fe.symbols) {
                            for (const sym of fe.symbols) {
                                if (sym.startLine <= call.line && (sym.endLine || 0) >= call.line) {
                                    endLine = Math.min(endLine, sym.endLine || endLine);
                                }
                            }
                        }
                        ranges.push({ start: call.line, end: endLine });
                    }
                    meta.jsTestRanges = ranges;
                }
            } catch (_) { /* ignore */ }
        }
        fileMeta.set(filePath, meta);
        return meta;
    }
    for (const site of sites) {
        site.inTestCase = false;
        const meta = getFileMeta(site.callerFile);
        if (!meta || !meta.langModule) continue;
        // First: kinded entry-point predicate (Python/Go/Java/Rust + JS lifecycle).
        const classify = meta.langModule.getEntryPointKind;
        if (classify && site.callerFile && site.callerStartLine != null) {
            const encl = index.findEnclosingFunction
                ? index.findEnclosingFunction(site.callerFile, site.line, true)
                : null;
            if (encl && classify(encl) === 'test') {
                site.inTestCase = true;
                continue;
            }
        }
        // Second: JS/TS framework-call brackets (it/test/describe). The site is
        // inside a test case when its line falls within a describe/it block.
        if (meta.jsTestRanges && meta.jsTestRanges.length > 0 && site.line != null) {
            for (const r of meta.jsTestRanges) {
                if (site.line >= r.start && site.line <= r.end) {
                    site.inTestCase = true;
                    break;
                }
            }
        }
    }
}

// ============================================================================
// TRUST SIGNALS: HISTOGRAM + REACHABILITY
// ============================================================================

/**
 * Bucket a confidence score into 'high' / 'medium' / 'low'.
 * Boundaries are inclusive at the lower end:
 *   confidence > 0.8  → high
 *   0.5 <= c <= 0.8   → medium
 *   c < 0.5           → low
 *
 * @param {number} c - Confidence score (0.0-1.0)
 * @returns {'high'|'medium'|'low'}
 */
function bucketConfidence(c) {
    if (c == null) return 'low';
    if (c > 0.8) return 'high';
    if (c >= 0.5) return 'medium';
    return 'low';
}

/**
 * Build a confidence histogram from an array of edges (callers/callees).
 * Returns null when there are no edges (caller drops the section entirely).
 *
 * @param {Array} edges - Array of objects with `confidence` field
 * @returns {{ high: number, medium: number, low: number, total: number }|null}
 */
function buildHistogram(edges) {
    if (!edges || edges.length === 0) return null;
    const h = { high: 0, medium: 0, low: 0, total: edges.length };
    for (const e of edges) {
        h[bucketConfidence(e.confidence)]++;
    }
    return h;
}

/**
 * Tag a list of caller objects with `reachable: boolean`.
 * Uses (callerFile, callerStartLine) to look up the caller symbol's reachability.
 * Module-level callers (no callerStartLine) are treated as unreachable.
 *
 * @param {Array} callers - Caller objects from findCallers
 * @param {Set<string>} reachableSet - Set of reachable symbol keys
 * @returns {Array} Same callers with `reachable` field added (mutated in place)
 */
function tagCallersReachable(callers, reachableSet) {
    if (!callers) return callers;
    for (const c of callers) {
        if (c.callerFile && c.callerStartLine != null) {
            c.reachable = reachableSet.has(symbolKey(c.callerFile, c.callerStartLine));
        } else {
            // Module-level / unknown caller — treat as unreachable (no enclosing function)
            c.reachable = false;
        }
    }
    return callers;
}

/**
 * Tag a list of callee objects with `reachable: boolean`.
 * Callee objects from findCallees have `file` + `startLine` directly.
 *
 * @param {Array} callees - Callee objects from findCallees
 * @param {Set<string>} reachableSet - Set of reachable symbol keys
 * @returns {Array} Same callees with `reachable` field added (mutated in place)
 */
function tagCalleesReachable(callees, reachableSet) {
    if (!callees) return callees;
    for (const c of callees) {
        if (c.file && c.startLine != null) {
            c.reachable = reachableSet.has(symbolKey(c.file, c.startLine));
        } else {
            c.reachable = false;
        }
    }
    return callees;
}

/**
 * Attach side-effect tags to each callee by AST scan of its body.
 * Tags = ['fs', 'network', 'process', 'global_mutation'] subset.
 * Cached per-symbol on the index so repeat queries are cheap.
 */
function tagCalleesSideEffects(index, callees) {
    if (!callees || callees.length === 0) return callees;
    const { sideEffectsFor } = require('./brief');
    for (const c of callees) {
        const tags = sideEffectsFor(index, c);
        if (tags && tags.length > 0) c.sideEffects = tags;
    }
    return callees;
}


/**
 * Compose the conservation account for a caller query (grep-reliability
 * contract). Claims come from the PRE-display-filter findCallers result —
 * the account reconciles pre-display truth; display filters are reported
 * separately in account.filtered.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Symbol name
 * @param {Array} rawCallers - findCallers result BEFORE display filters
 *   (carries non-enumerable accountRaw/shadowEntries from collectAccount)
 * @param {object} [filtered] - display-level hide counts { total, byFlag }
 * @returns {object} account (see core/account.js)
 */
function composeAccount(index, name, rawCallers, filtered) {
    const { computeGroundSet, buildAccount } = require('./account');
    const groundSet = computeGroundSet(index, name);
    const accountRaw = rawCallers.accountRaw || { unverifiedLines: [], excludedEntries: [] };

    const confirmedEntries = [];
    const unverifiedEntries = [...accountRaw.unverifiedLines];
    const claimByTier = (entry) => {
        if (entry.tier === 'unverified') unverifiedEntries.push({ file: entry.file, line: entry.line });
        else confirmedEntries.push({ file: entry.file, line: entry.line });
    };
    for (const c of rawCallers) claimByTier(c);
    for (const s of (rawCallers.shadowEntries || [])) claimByTier(s);
    // Retained unverified-tier entries (routed drops — Phase 3 engine retention)
    for (const u of (rawCallers.unverifiedEntries || [])) {
        unverifiedEntries.push({ file: u.file, line: u.line });
    }

    return buildAccount(index, name, {
        groundSet,
        confirmedEntries,
        unverifiedEntries,
        excludedEntries: accountRaw.excludedEntries,
        filtered,
    });
}

/**
 * Context: quick caller/callee view for a symbol.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Symbol name
 * @param {object} options - { file, className, includeMethods, includeUncertain, exclude, minConfidence }
 * @returns {object|null}
 */
function context(index, name, options = {}) {
    index._beginOp();
    try {
    const resolved = index.resolveSymbol(name, { file: options.file, className: options.className, line: options.line });
    let { def, warnings } = resolved;
    if (!def) {
        return null;
    }

    // Special handling for class/struct/interface types
    if (['class', 'struct', 'interface', 'type'].includes(def.type)) {
        const methods = index.findMethodsForType(name);

        // Pin caller resolution to the resolved class definition — same as the
        // function path below. Without this, same-name classes in other files
        // conflate (their usages attribute to whichever def displays).
        let typeCallers = index.findCallers(name, { includeMethods: options.includeMethods, includeUncertain: options.includeUncertain, collectAccount: true, targetDefinitions: [def] });
        const rawTypeCallers = typeCallers;
        const typeFilteredByFlag = { exclude: 0, minConfidence: 0, unreachableOnly: 0 };
        // Tier partition — same contract as the function path: constructor/usage
        // sites without evidence are visible as unverified, never hidden.
        let typeUnverified = [
            ...typeCallers.filter(c => c.tier === 'unverified'),
            ...(rawTypeCallers.unverifiedEntries || []),
        ];
        typeCallers = typeCallers.filter(c => c.tier !== 'unverified');
        // Apply exclude filter
        if (options.exclude && options.exclude.length > 0) {
            const before = typeCallers.length + typeUnverified.length;
            typeCallers = typeCallers.filter(c => index.matchesFilters(c.relativePath, { exclude: options.exclude }));
            typeUnverified = typeUnverified.filter(c => index.matchesFilters(c.relativePath, { exclude: options.exclude }));
            typeFilteredByFlag.exclude = before - typeCallers.length - typeUnverified.length;
        }
        const byFileLine = (a, b) => {
            const fa = a.relativePath || a.file || '';
            const fb = b.relativePath || b.file || '';
            if (fa !== fb) return fa.localeCompare(fb);
            return (a.line || 0) - (b.line || 0);
        };
        typeCallers = [...typeCallers].sort(byFileLine);
        typeUnverified = [...typeUnverified].sort(byFileLine);

        const typeAccount = composeAccount(index, name, rawTypeCallers,
            typeFilteredByFlag.exclude > 0 ? { total: typeFilteredByFlag.exclude, byFlag: typeFilteredByFlag } : undefined);

        const result = {
            type: def.type,
            name: name,
            file: def.relativePath,
            startLine: def.startLine,
            endLine: def.endLine,
            methods: methods.map(m => ({
                name: m.name,
                file: m.relativePath,
                line: m.startLine,
                params: m.params,
                returnType: m.returnType,
                receiver: m.receiver
            })),
            // Also include places where the type is used in function parameters/returns
            callers: typeCallers,
            unverifiedCallers: typeUnverified,
            meta: { account: typeAccount }
        };

        if (warnings.length > 0) {
            result.warnings = warnings;
        }

        return result;
    }

    const stats = { uncertain: 0 };
    let callers = index.findCallers(name, {
        includeMethods: options.includeMethods,
        includeUncertain: options.includeUncertain,
        stats,
        targetDefinitions: [def],
        collectAccount: true,
        // --all lifts the unverified enrichment cap (content + caller lookup)
        unverifiedEnrichLimit: options.all ? Infinity : undefined,
    });
    let callees = index.findCallees(def, { includeMethods: options.includeMethods, includeUncertain: options.includeUncertain, stats });
    // Pre-display-filter result for the conservation account (filters below
    // build new arrays and would lose the non-enumerable accountRaw).
    const rawCallers = callers;
    const filteredByFlag = { exclude: 0, minConfidence: 0, unreachableOnly: 0 };

    // Tier partition (grep-reliability contract): `callers` = confirmed tier
    // only; unverified-tier entries (name match without binding/receiver
    // evidence) render in their own section — visible, never silently hidden.
    let unverifiedCallers = [
        ...callers.filter(c => c.tier === 'unverified'),
        ...(rawCallers.unverifiedEntries || []),
    ];
    callers = callers.filter(c => c.tier !== 'unverified');

    // Apply exclude filter
    if (options.exclude && options.exclude.length > 0) {
        const before = callers.length;
        callers = callers.filter(c => index.matchesFilters(c.relativePath, { exclude: options.exclude }));
        filteredByFlag.exclude = before - callers.length;
        const beforeUnverified = unverifiedCallers.length;
        unverifiedCallers = unverifiedCallers.filter(c => index.matchesFilters(c.relativePath, { exclude: options.exclude }));
        filteredByFlag.exclude += beforeUnverified - unverifiedCallers.length;
        callees = callees.filter(c => index.matchesFilters(c.relativePath, { exclude: options.exclude }));
    }

    // Apply confidence filtering
    let confidenceFiltered = 0;
    if (options.minConfidence > 0) {
        const { filterByConfidence } = require('./confidence');
        const callerResult = filterByConfidence(callers, options.minConfidence);
        const calleeResult = filterByConfidence(callees, options.minConfidence);
        callers = callerResult.kept;
        callees = calleeResult.kept;
        confidenceFiltered = callerResult.filtered + calleeResult.filtered;
        filteredByFlag.minConfidence = callerResult.filtered;
    }

    // Stable output ordering: callers by (file, line). Callees retain their
    // call-count order from findCallees (most-called first) — that's a value
    // the user expects, not a stability concern, since the secondary sort
    // by line keeps ties deterministic.
    const byFileLine = (a, b) => {
        const fa = a.relativePath || a.file || '';
        const fb = b.relativePath || b.file || '';
        if (fa !== fb) return fa.localeCompare(fb);
        return (a.line || 0) - (b.line || 0);
    };
    callers = [...callers].sort(byFileLine);
    unverifiedCallers = [...unverifiedCallers].sort(byFileLine);
    callees = [...callees].sort((a, b) => {
        // Primary: callCount desc (preserves "most-called first" UX)
        const ca = a.callCount || 0, cb = b.callCount || 0;
        if (ca !== cb) return cb - ca;
        // Tiebreaker: file then line, for determinism
        const fa = a.relativePath || a.file || '';
        const fb = b.relativePath || b.file || '';
        if (fa !== fb) return fa.localeCompare(fb);
        return (a.startLine || 0) - (b.startLine || 0);
    });

    // Trust signals: tag each caller/callee with reachability and build confidence histograms.
    // Reachability is computed once per index and cached (see entrypoints.computeReachability).
    const reachableSet = computeReachability(index);
    tagCallersReachable(callers, reachableSet);
    tagCalleesReachable(callees, reachableSet);

    // Side-effect tags on callees (lazy-cached per symbol on the index)
    tagCalleesSideEffects(index, callees);

    // Optional: filter to unreachable-only (helps surface dead-path callers/callees)
    if (options.unreachableOnly) {
        const before = callers.length;
        callers = callers.filter(c => !c.reachable);
        filteredByFlag.unreachableOnly = before - callers.length;
        callees = callees.filter(c => !c.reachable);
    }

    // Conservation account: reconciles the caller answer against the text
    // ground set (pre-display truth; display-filter hides reported separately).
    const filteredTotal = filteredByFlag.exclude + filteredByFlag.minConfidence + filteredByFlag.unreachableOnly;
    const account = composeAccount(index, name, rawCallers,
        filteredTotal > 0 ? { total: filteredTotal, byFlag: filteredByFlag } : undefined);

    const callerHistogram = buildHistogram(callers);
    const calleeHistogram = buildHistogram(callees);

    const filesInScope = new Set([def.file]);
    callers.forEach(c => filesInScope.add(c.file));
    callees.forEach(c => filesInScope.add(c.file));
    let dynamicImports = 0;
    for (const f of filesInScope) {
        const fe = index.files.get(f);
        if (fe?.dynamicImports) dynamicImports += fe.dynamicImports;
    }

    const result = {
        function: name,
        file: def.relativePath,
        startLine: def.startLine,
        endLine: def.endLine,
        params: def.params,
        returnType: def.returnType,
        callers,
        unverifiedCallers,
        callees,
        callerHistogram,
        calleeHistogram,
        meta: {
            complete: stats.uncertain === 0 && dynamicImports === 0 && confidenceFiltered === 0,
            skipped: 0,
            dynamicImports,
            uncertain: stats.uncertain,
            confidenceFiltered,
            includeMethods: !!options.includeMethods,
            projectLanguage: index._getPredominantLanguage(),
            account,
            // No detected entry points (e.g. library code) — reachability
            // markers are meaningless and suppressed by formatters.
            hasEntrypoints: reachableSet.size > 0,
            ...(options.all && { all: true }),
            // Structural facts for reliability hints
            ...(def.isMethod && { isMethod: true }),
            ...(def.className && { className: def.className }),
            ...(def.receiver && { receiver: def.receiver })
        }
    };

    if (warnings.length > 0) {
        result.warnings = warnings;
    }

    return result;
    } finally { index._endOp(); }
}

/**
 * Smart extraction: function + dependencies inline.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Symbol name
 * @param {object} options - { file, className, includeMethods, includeUncertain, withTypes }
 * @returns {object|null}
 */
function smart(index, name, options = {}) {
    index._beginOp();
    try {
    const { def } = index.resolveSymbol(name, { file: options.file, className: options.className, line: options.line });
    if (!def) {
        return null;
    }
    const code = index.extractCode(def);
    const stats = { uncertain: 0 };
    const callees = index.findCallees(def, { includeMethods: options.includeMethods, includeUncertain: options.includeUncertain, stats });

    const filesInScope = new Set([def.file]);
    callees.forEach(c => filesInScope.add(c.file));
    let dynamicImports = 0;
    for (const f of filesInScope) {
        const fe = index.files.get(f);
        if (fe?.dynamicImports) dynamicImports += fe.dynamicImports;
    }

    // Extract code for each dependency, excluding the exact same function
    // (but keeping same-name overloads, e.g. Java toJson(Object) vs toJson(Object, Class))
    const defBindingId = def.bindingId;
    const dependencies = callees
        .filter(callee => callee.bindingId !== defBindingId)
        .map(callee => ({
            ...callee,
            code: index.extractCode(callee)
        }));

    // Find type definitions if requested
    const types = [];
    if (options.withTypes) {
        // Look for type annotations in params/return type
        const typeNames = index.extractTypeNames(def);
        for (const typeName of typeNames) {
            const typeSymbols = index.symbols.get(typeName);
            if (typeSymbols) {
                for (const sym of typeSymbols) {
                    if (['type', 'interface', 'class', 'struct'].includes(sym.type)) {
                        types.push({
                            ...sym,
                            code: index.extractCode(sym)
                        });
                    }
                }
            }
        }
    }

    return {
        target: {
            ...def,
            code
        },
        dependencies,
        types,
        meta: {
            complete: stats.uncertain === 0 && dynamicImports === 0,
            skipped: 0,
            dynamicImports,
            uncertain: stats.uncertain,
            projectLanguage: index._getPredominantLanguage()
        }
    };
    } finally { index._endOp(); }
}

/**
 * Detect completeness signal metadata for the project.
 *
 * @param {object} index - ProjectIndex instance
 * @returns {object} { complete, warnings, projectLanguage }
 */
function detectCompleteness(index) {
    // Return cached result if available
    if (index._completenessCache) {
        return index._completenessCache;
    }

    const warnings = [];
    let dynamicImports = 0;
    let evalUsage = 0;
    let reflectionUsage = 0;

    for (const [filePath, fileEntry] of index.files) {
        // Skip node_modules - we don't care about their patterns
        if (filePath.includes('node_modules')) continue;

        try {
            const content = index._readFile(filePath);

            if (langTraits(fileEntry.language)?.hasDynamicImports) {
                // Dynamic imports: import(), require(variable), __import__
                dynamicImports += (content.match(/import\s*\([^'"]/g) || []).length;
                dynamicImports += (content.match(/require\s*\([^'"]/g) || []).length;
                dynamicImports += (content.match(/__import__\s*\(/g) || []).length;

                // eval, Function constructor
                evalUsage += (content.match(/(^|[^a-zA-Z_])eval\s*\(/gm) || []).length;
                evalUsage += (content.match(/new\s+Function\s*\(/g) || []).length;
            }

            // Reflection: getattr, hasattr, Reflect
            reflectionUsage += (content.match(/\bgetattr\s*\(/g) || []).length;
            reflectionUsage += (content.match(/\bhasattr\s*\(/g) || []).length;
            reflectionUsage += (content.match(/\bReflect\./g) || []).length;
        } catch (e) {
            // Skip unreadable files
        }
    }

    if (dynamicImports > 0) {
        warnings.push({
            type: 'dynamic_imports',
            count: dynamicImports,
            message: `${dynamicImports} dynamic import(s) detected - some dependencies may be missed`
        });
    }

    if (evalUsage > 0) {
        warnings.push({
            type: 'eval',
            count: evalUsage,
            message: `${evalUsage} eval/exec usage(s) detected - dynamically generated code not analyzed`
        });
    }

    if (reflectionUsage > 0) {
        warnings.push({
            type: 'reflection',
            count: reflectionUsage,
            message: `${reflectionUsage} reflection usage(s) detected - dynamic attribute access not tracked`
        });
    }

    index._completenessCache = {
        complete: warnings.length === 0,
        warnings,
        projectLanguage: index._getPredominantLanguage()
    };

    return index._completenessCache;
}

/**
 * Find related functions — same file, similar names, shared dependencies.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @param {object} options - { file, className, top, all }
 * @returns {object|null}
 */
function related(index, name, options = {}) {
    index._beginOp();
    try {
    const { def } = index.resolveSymbol(name, { file: options.file, className: options.className, line: options.line });
    if (!def) {
        return null;
    }
    const related = {
        target: {
            name: def.name,
            file: def.relativePath,
            line: def.startLine,
            type: def.type
        },
        sameFile: [],
        similarNames: [],
        sharedCallers: [],
        sharedCallees: []
    };

    // 1. Same file functions (sorted by proximity to target)
    const fileEntry = index.files.get(def.file);
    if (fileEntry) {
        for (const sym of fileEntry.symbols) {
            if (sym.name !== name && !NON_CALLABLE_TYPES.has(sym.type)) {
                related.sameFile.push({
                    name: sym.name,
                    line: sym.startLine,
                    params: sym.params
                });
            }
        }
        // Sort by distance from target function (nearest first)
        related.sameFile.sort((a, b) =>
            Math.abs(a.line - def.startLine) - Math.abs(b.line - def.startLine)
        );
    }

    // 2. Similar names (shared prefix/suffix, camelCase similarity)
    const nameParts = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split('_');
    for (const [symName, symbols] of index.symbols) {
        if (symName === name) continue;
        const symParts = symName.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split('_');

        // Check for shared parts (require >=50% of the longer name to match)
        const sharedParts = nameParts.filter(p => symParts.includes(p) && p.length > 3);
        const maxParts = Math.max(nameParts.length, symParts.length);
        if (sharedParts.length > 0 && sharedParts.length / maxParts >= 0.5) {
            const sym = symbols[0];
            related.similarNames.push({
                name: symName,
                file: sym.relativePath,
                line: sym.startLine,
                sharedParts,
                type: sym.type
            });
        }
    }
    // Sort by number of shared parts
    related.similarNames.sort((a, b) => b.sharedParts.length - a.sharedParts.length);
    const similarLimit = options.top || (options.all ? Infinity : 10);
    related.similarNamesTotal = related.similarNames.length;
    if (related.similarNames.length > similarLimit) related.similarNames = related.similarNames.slice(0, similarLimit);

    // 3. Shared callers - functions called by the same callers
    // Cap findCallers to avoid O(hundreds × findCallees) on ambiguous names
    const maxSharedCallerScan = options.all ? 50 : 20;
    const myCallersRaw = index.findCallers(name, { maxResults: maxSharedCallerScan * 3 });
    const myCallers = new Set(myCallersRaw.map(c => c.callerName).filter(Boolean));
    if (myCallers.size > 0) {
        const callerCounts = new Map();
        const calleeCache = new Map();
        let scannedCallers = 0;
        for (const callerName of myCallers) {
            if (scannedCallers >= maxSharedCallerScan) break;
            const callerDef = index.symbols.get(callerName)?.[0];
            if (callerDef) {
                let callees = calleeCache.get(callerName);
                if (!callees) {
                    callees = index.findCallees(callerDef);
                    calleeCache.set(callerName, callees);
                }
                scannedCallers++;
                for (const callee of callees) {
                    if (callee.name !== name) {
                        callerCounts.set(callee.name, (callerCounts.get(callee.name) || 0) + 1);
                    }
                }
            }
        }
        // Sort by shared caller count
        const maxShared = options.top || (options.all ? Infinity : 5);
        const allSorted = Array.from(callerCounts.entries())
            .sort((a, b) => b[1] - a[1]);
        related.sharedCallersTotal = allSorted.length;
        const sorted = allSorted.slice(0, maxShared);
        for (const [symName, count] of sorted) {
            const sym = index.symbols.get(symName)?.[0];
            if (sym) {
                related.sharedCallers.push({
                    name: symName,
                    file: sym.relativePath,
                    line: sym.startLine,
                    sharedCallerCount: count
                });
            }
        }
    }

    // 4. Shared callees - functions that call the same things
    // Optimized: instead of computing callees for every symbol (O(N*M)),
    // find who else calls each of our callees (O(K) where K = our callee count)
    if (def.type === 'function' || def.params !== undefined) {
        const myCallees = index.findCallees(def);
        const myCalleeNames = new Set(myCallees.map(c => c.name));
        if (myCalleeNames.size > 0) {
            const calleeCounts = new Map();
            // Cap callee scan to avoid O(callees × findCallers) explosion
            const maxCalleeScan = options.all ? 30 : 15;
            let scannedCallees = 0;
            for (const calleeName of myCalleeNames) {
                if (scannedCallees >= maxCalleeScan) break;
                scannedCallees++;
                // Find other functions that also call this callee
                const callers = index.findCallers(calleeName, { maxResults: 50 });
                for (const caller of callers) {
                    if (caller.callerName && caller.callerName !== name) {
                        calleeCounts.set(caller.callerName, (calleeCounts.get(caller.callerName) || 0) + 1);
                    }
                }
            }
            // Sort by shared callee count
            const allSorted = Array.from(calleeCounts.entries())
                .sort((a, b) => b[1] - a[1]);
            related.sharedCalleesTotal = allSorted.length;
            const sorted = allSorted.slice(0, options.top || (options.all ? Infinity : 5));
            for (const [symName, count] of sorted) {
                const sym = index.symbols.get(symName)?.[0];
                if (sym) {
                    related.sharedCallees.push({
                        name: symName,
                        file: sym.relativePath,
                        line: sym.startLine,
                        sharedCalleeCount: count
                    });
                }
            }
        }
    }

    return related;
    } finally { index._endOp(); }
}

/**
 * Impact analysis — what call sites need updating if a function changes.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @param {object} options - { file, className, exclude, top }
 * @returns {object|null}
 */
function impact(index, name, options = {}) {
    index._beginOp();
    try {
    const { def } = index.resolveSymbol(name, { file: options.file, className: options.className, line: options.line });
    if (!def) {
        return null;
    }
    const defIsMethod = def.isMethod || def.type === 'method' || def.className || def.receiver;
    // RUST-3: type definitions (class/struct/interface/etc.) are callable through
    // constructor invocations (`new ClassName()`) — about() handles them via its
    // CALLABLE_TYPES set since the M3 fix. Route them through the same findCallers
    // path here so `impact ClassName` agrees with `about ClassName` rather than
    // returning 0 because the legacy "function" branch doesn't recognize types.
    const TYPE_DEF_KINDS = new Set(['class', 'struct', 'interface', 'type',
        'enum', 'trait', 'impl', 'record', 'namespace']);
    const defIsTypeDef = TYPE_DEF_KINDS.has(def.type);

    // BUG-H3 + tiered contract: impact always analyzes every callable site —
    // method calls included unconditionally, tiered by receiver evidence.
    // --no-include-methods is a deprecated no-op (evidence-less method sites
    // land in the unverified tier instead of disappearing).
    const impactIncludeMethods = true;
    const impactIncludeUncertain = options.includeUncertain ?? false;

    // Use findCallers for className-scoped or method queries (sophisticated binding resolution)
    // Fall back to usages-based approach for simple function queries (backward compatible)
    let callSites;
    // Conservation accounting: engine-recorded drops + post-engine drops in
    // this function (className filter, binding cross-check, method skips).
    // Claims use ABSOLUTE paths (ground set is keyed by absolute file path).
    let impactAccountRaw = null;
    let impactRoutedUnverified = []; // engine-routed retained drops (unverifiedEntries)
    const impactClaims = [];
    const impactPostHocExcluded = [];
    const impactPostHocUnverified = [];
    if (options.className || defIsMethod || defIsTypeDef) {
        // findCallers has proper method call resolution (self/this, binding IDs, receiver checks)
        let callerResults = index.findCallers(name, {
            includeMethods: impactIncludeMethods,
            includeUncertain: impactIncludeUncertain,
            targetDefinitions: [def],
            collectAccount: true,
        });
        impactAccountRaw = callerResults.accountRaw;
        impactRoutedUnverified = callerResults.unverifiedEntries || [];

        // When the target definition has a className (including Go/Rust methods which
        // now get className from receiver), filter out method calls whose receiver
        // clearly belongs to a different type. This helps with common method names
        // like .close(), .get() etc. where many types have the same method.
        if (def.className) {
            const targetClassName = def.className;
            // Pre-compute how many types share this method name
            const _impMethodDefs = index.symbols.get(name);
            const _impClassNames = new Set();
            if (_impMethodDefs) {
                for (const d of _impMethodDefs) {
                    if (d.className) _impClassNames.add(d.className);
                    else if (d.receiver) _impClassNames.add(d.receiver.replace(/^\*/, ''));
                }
            }
            const keepForTargetClass = (c) => {
                // Keep non-method calls and self/this/cls calls (already resolved by findCallers)
                if (!c.isMethod) return true;
                const r = c.receiver;
                if (r && ['self', 'cls', 'this', 'super'].includes(r)) return true;
                // Use receiverType from findCallers when available (Go/Java/Rust type inference)
                if (c.receiverType) {
                    return c.receiverType === targetClassName ? 'strong' : false;
                }
                // No receiver (chained/complex expression): only include if method is
                // unique or rare across types — otherwise too many false positives
                if (!r) {
                    return _impClassNames.size <= 1;
                }
                // Check if receiver matches the target class name (case-insensitive camelCase convention)
                if (r.toLowerCase().includes(targetClassName.toLowerCase())) return true;
                // Check if receiver is an instance of the target class using local variable type inference
                if (c.callerFile) {
                    const callerDef = c.callerStartLine ? { file: c.callerFile, startLine: c.callerStartLine, endLine: c.callerEndLine } : null;
                    if (callerDef) {
                        const callerCalls = index.getCachedCalls(c.callerFile);
                        if (callerCalls && Array.isArray(callerCalls)) {
                            const localTypes = new Map();
                            for (const call of callerCalls) {
                                if (call.line >= callerDef.startLine && call.line <= callerDef.endLine) {
                                    if (!call.isMethod && !call.receiver) {
                                        const syms = index.symbols.get(call.name);
                                        if (syms && syms.some(s => s.type === 'class')) {
                                            // Found a constructor call — check for assignment pattern
                                            const fileEntry = index.files.get(c.callerFile);
                                            if (fileEntry) {
                                                const content = index._readFile(c.callerFile);
                                                const lines = content.split('\n');
                                                const line = lines[call.line - 1] || '';
                                                // Match "var = ClassName(...)" or "var = new ClassName(...)" or "Type var = new ClassName<>(...)"
                                                const m = line.match(/(\w+)\s*=\s*(?:await\s+)?(?:new\s+)?(\w+)\s*(?:<[^>]*>)?\s*\(/);
                                                if (m && m[2] === call.name) {
                                                    localTypes.set(m[1], call.name);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            const receiverType = localTypes.get(r);
                            if (receiverType) {
                                return receiverType === targetClassName ? 'strong' : false;
                            }
                        }
                    }
                }
                // Check class field declarations for receiver type: private DataService service
                if (c.callerFile) {
                    const callerEnclosing = index.findEnclosingFunction(c.callerFile, c.line, true);
                    if (callerEnclosing?.className) {
                        const classSyms = index.symbols.get(callerEnclosing.className);
                        if (classSyms) {
                            const classDef = classSyms.find(s => s.type === 'class' || s.type === 'struct' || s.type === 'interface');
                            if (classDef) {
                                const content = index._readFile(c.callerFile);
                                const lines = content.split('\n');
                                // Scan class body for field declarations matching the receiver
                                for (let li = classDef.startLine - 1; li < (classDef.endLine || classDef.startLine + 50) && li < lines.length; li++) {
                                    const line = lines[li];
                                    // Match Java/TS field: [modifiers] TypeName<...> receiverName [= ...]
                                    const fieldMatch = line.match(new RegExp(`\\b(\\w+)(?:<[^>]*>)?\\s+${r.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&')}\\s*[;=]`));
                                    if (fieldMatch) {
                                        const fieldType = fieldMatch[1];
                                        if (fieldType === targetClassName) return 'strong';
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                // Check parameter type annotations: def foo(tracker: SourceTracker) → tracker.record()
                if (c.callerFile && c.callerStartLine) {
                    const callerSymbol = index.findEnclosingFunction(c.callerFile, c.line, true);
                    if (callerSymbol && callerSymbol.paramsStructured) {
                        for (const param of callerSymbol.paramsStructured) {
                            if (param.name === r && param.type) {
                                // Check if the type annotation contains the target class name
                                const typeMatches = param.type.match(/\b([A-Za-z_]\w*)\b/g);
                                if (typeMatches && typeMatches.some(t => t === targetClassName)) {
                                    return 'strong';
                                }
                                // Type annotation exists but doesn't match target class — filter out
                                return false;
                            }
                        }
                    }
                }
                // Unique method heuristic: if the called method exists on exactly one class/type
                // and it matches the target, include the call (no other class could match)
                if (_impClassNames.size === 1 && _impClassNames.has(targetClassName)) {
                    return true;
                }
                // Type-scoped query but receiver type unknown — filter it out.
                // Unknown receivers are likely unrelated.
                return false;
            };
            // Conservation: post-hoc rejects are positive type-mismatch evidence —
            // they MOVE into the excluded bucket instead of vanishing. Survivors
            // verified by STRONG evidence (receiverType / local constructor /
            // field declaration / param annotation match) are upgraded to the
            // confirmed tier — the filter just proved the receiver's type.
            callerResults = callerResults.filter(c => {
                const keep = keepForTargetClass(c);
                if (!keep) {
                    impactPostHocExcluded.push({ file: c.file, line: c.line, reason: 'receiver-type-mismatch' });
                    return false;
                }
                if (keep === 'strong' && c.tier === 'unverified') {
                    c.tier = 'confirmed';
                    c.resolution = 'receiver-hint';
                    c.confidence = 0.80;
                }
                return true;
            });
        }

        callSites = [];
        for (const c of callerResults) {
            const analysis = index.analyzeCallSite(
                { file: c.file, relativePath: c.relativePath, line: c.line, content: c.content },
                name
            );
            impactClaims.push({ file: c.file, line: c.line, tier: c.tier });
            callSites.push({
                file: c.relativePath,
                line: c.line,
                expression: c.content.trim(),
                callerName: c.callerName,
                callerFile: c.callerFile,
                callerStartLine: c.callerStartLine,
                confidence: c.confidence,
                resolution: c.resolution,
                ...(c.tier && { tier: c.tier }),
                ...analysis
            });
        }
        index._clearTreeCache();
    } else {
        // Use findCallers (benefits from callee index) instead of usages() for speed
        // BUG-H3: respect user-supplied includeMethods (defaults true above).
        // For standalone functions, method-style calls (e.g. `obj.findCallers()`)
        // resolve to the function when the receiver is a project object.
        const callerResults = index.findCallers(name, {
            includeMethods: impactIncludeMethods,
            includeUncertain: impactIncludeUncertain,
            targetDefinitions: [def],
            collectAccount: true,
        });
        impactAccountRaw = callerResults.accountRaw;
        impactRoutedUnverified = callerResults.unverifiedEntries || [];
        const targetBindingId = def.bindingId;
        // Convert findCallers results to the format expected by analyzeCallSite
        const calls = callerResults.map(c => ({
            file: c.file,
            relativePath: c.relativePath,
            line: c.line,
            content: c.content,
            usageType: 'call',
            callerName: c.callerName,
            callerFile: c.callerFile,
            callerStartLine: c.callerStartLine,
            confidence: c.confidence,
            resolution: c.resolution,
            tier: c.tier,
        }));
        // Keep the same binding filter for backward compat (findCallers already handles this,
        // but cross-check with usages-based binding filter for safety)
        const filteredCalls = calls.filter(u => {
            const fileEntry = index.files.get(u.file);
            if (fileEntry && targetBindingId) {
                let localBindings = (fileEntry.bindings || []).filter(b => b.name === name);
                if (localBindings.length === 0 && langTraits(fileEntry.language)?.packageScope === 'directory') {
                    const dir = path.dirname(u.file);
                    for (const [fp, fe] of index.files) {
                        if (fp !== u.file && path.dirname(fp) === dir) {
                            const sibling = (fe.bindings || []).filter(b => b.name === name);
                            localBindings = localBindings.concat(sibling);
                        }
                    }
                }
                if (localBindings.length > 0 && !localBindings.some(b => b.id === targetBindingId)) {
                    impactPostHocExcluded.push({ file: u.file, line: u.line, reason: 'other-definition' });
                    return false;
                }
            }
            return true;
        });
        // (findCallers already handles binding resolution and scope-aware filtering)

        // Analyze each call site, filtering out method calls for non-method definitions
        callSites = [];
        const defFileEntry = index.files.get(def.file);
        const defLang = defFileEntry?.language;
        const targetDir = defLang === 'go' ? path.basename(path.dirname(def.file)) : null;
        for (const call of filteredCalls) {
            const analysis = index.analyzeCallSite(call, name);
            // BUG-H3: when includeMethods is true, keep method-style calls
            // (e.g. obj.findCallers() resolves to standalone findCallers via the
            // bindingId path — findCallers already filters by targetDefinitions).
            // Skip method calls (obj.parse()) when target is a standalone function (parse())
            // For Go, allow calls where receiver matches the package directory name
            // (e.g., controller.FilterActive() where file is in pkg/controller/)
            if (analysis.isMethodCall && !defIsMethod && !impactIncludeMethods) {
                if (targetDir) {
                    // Get receiver from parsed calls cache
                    const parsedCalls = index.getCachedCalls(call.file);
                    const matchedCall = parsedCalls?.find(c => c.name === name && c.line === call.line);
                    if (matchedCall?.receiver === targetDir) {
                        // Receiver matches package directory — keep it
                    } else {
                        impactPostHocUnverified.push({ file: call.file, line: call.line, reason: 'method-no-evidence' });
                        continue;
                    }
                } else {
                    impactPostHocUnverified.push({ file: call.file, line: call.line, reason: 'method-no-evidence' });
                    continue;
                }
            }
            impactClaims.push({ file: call.file, line: call.line, tier: call.tier });
            callSites.push({
                file: call.relativePath,
                line: call.line,
                expression: call.content.trim(),
                callerName: call.callerName || index.findEnclosingFunction(call.file, call.line),
                callerFile: call.callerFile,
                callerStartLine: call.callerStartLine,
                confidence: call.confidence,
                resolution: call.resolution,
                ...(call.tier && { tier: call.tier }),
                ...analysis
            });
        }
        index._clearTreeCache();
    }

    // Tier partition: confirmed sites stay in callSites; unverified-tier sites
    // (incl. engine-routed retained drops) render in their own section.
    let unverifiedSites = callSites.filter(s => s.tier === 'unverified');
    callSites = callSites.filter(s => s.tier !== 'unverified');
    for (const u of impactRoutedUnverified) {
        unverifiedSites.push({
            file: u.relativePath,
            line: u.line,
            expression: (u.content || '').trim(),
            callerName: u.callerName ?? null,
            confidence: u.confidence,
            resolution: u.resolution,
            tier: 'unverified',
            ...(u.reason && { reason: u.reason }),
            ...(u.dispatchVia && { dispatchVia: u.dispatchVia }),
            ...(u.dispatchCandidates != null && { dispatchCandidates: u.dispatchCandidates }),
        });
    }
    unverifiedSites.sort((a, b) => {
        if (a.file !== b.file) return a.file.localeCompare(b.file);
        return (a.line || 0) - (b.line || 0);
    });

    // Apply exclude filter
    const impactFilteredByFlag = { exclude: 0, unreachableOnly: 0 };
    let filteredSites = callSites;
    if (options.exclude && options.exclude.length > 0) {
        filteredSites = callSites.filter(s => index.matchesFilters(s.file, { exclude: options.exclude }));
        impactFilteredByFlag.exclude = callSites.length - filteredSites.length;
        const beforeUnverified = unverifiedSites.length;
        unverifiedSites = unverifiedSites.filter(s => index.matchesFilters(s.file, { exclude: options.exclude }));
        impactFilteredByFlag.exclude += beforeUnverified - unverifiedSites.length;
    }

    // Trust signals: tag each call site with reachability, build a confidence histogram.
    // Histogram is computed BEFORE top-N truncation so the trust signal reflects the full scope.
    const impactReachable = computeReachability(index);
    for (const site of filteredSites) {
        if (site.callerFile && site.callerStartLine != null) {
            site.reachable = impactReachable.has(symbolKey(site.callerFile, site.callerStartLine));
        } else {
            site.reachable = false;
        }
    }
    if (options.unreachableOnly) {
        const before = filteredSites.length;
        filteredSites = filteredSites.filter(s => !s.reachable);
        impactFilteredByFlag.unreachableOnly = before - filteredSites.length;
    }
    const callerHistogram = buildHistogram(filteredSites);

    // Conservation account: claims from ALL call sites (pre-display filters,
    // pre-top truncation) plus engine-recorded and post-hoc drops.
    const impactAccount = (() => {
        const { computeGroundSet, buildAccount } = require('./account');
        const groundSet = computeGroundSet(index, name);
        const confirmedEntries = [];
        const unverifiedEntries = [...(impactAccountRaw?.unverifiedLines || []), ...impactPostHocUnverified];
        for (const u of impactRoutedUnverified) unverifiedEntries.push({ file: u.file, line: u.line });
        for (const cl of impactClaims) {
            if (cl.tier === 'unverified') unverifiedEntries.push(cl);
            else confirmedEntries.push(cl);
        }
        const excludedEntries = [...(impactAccountRaw?.excludedEntries || []), ...impactPostHocExcluded];
        const filteredTotal = impactFilteredByFlag.exclude + impactFilteredByFlag.unreachableOnly;
        return buildAccount(index, name, {
            groundSet,
            confirmedEntries,
            unverifiedEntries,
            excludedEntries,
            filtered: filteredTotal > 0 ? { total: filteredTotal, byFlag: impactFilteredByFlag } : undefined,
        });
    })();

    // Apply top limit if specified (limits total call sites shown)
    const totalBeforeLimit = filteredSites.length;
    if (options.top && options.top > 0 && filteredSites.length > options.top) {
        filteredSites = filteredSites.slice(0, options.top);
    }

    // Group by file
    const byFile = new Map();
    for (const site of filteredSites) {
        if (!byFile.has(site.file)) {
            byFile.set(site.file, []);
        }
        byFile.get(site.file).push(site);
    }

    // Feature A: tag each call site with `inTestCase` (whether the enclosing
    // function is a test entry per language's getEntryPointKind predicate).
    // Done BEFORE identifyCallPatterns so the aggregate count is correct.
    tagInTestCase(index, filteredSites);

    // Identify patterns
    const patterns = index.identifyCallPatterns(filteredSites, name);

    // Detect scope pollution: multiple class definitions for the same method name
    let scopeWarning = null;
    if (defIsMethod) {
        const allDefs = index.symbols.get(name);
        if (allDefs && allDefs.length > 1) {
            const classNames = [...new Set(allDefs
                .filter(d => d.className && d.className !== def.className)
                .map(d => d.className))];
            if (classNames.length > 0 && !options.className && !options.file) {
                scopeWarning = {
                    targetClass: def.className || '(unknown)',
                    otherClasses: classNames,
                    hint: `Results may include calls to ${classNames.join(', ')}.${name}(). Use file= or className= to narrow scope.`
                };
            }
        }
    }

    return {
        function: name,
        file: def.relativePath,
        startLine: def.startLine,
        signature: index.formatSignature(def),
        params: def.params,
        paramsStructured: def.paramsStructured,
        totalCallSites: totalBeforeLimit,
        shownCallSites: filteredSites.length,
        unverifiedSites,
        account: impactAccount,
        hasEntrypoints: impactReachable.size > 0,
        callerHistogram,
        // Stable ordering: files alphabetical, sites by line ascending. Documented contract.
        byFile: Array.from(byFile.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([file, sites]) => ({
                file,
                count: sites.length,
                sites: [...sites].sort((s1, s2) => (s1.line || 0) - (s2.line || 0))
            })),
        patterns,
        scopeWarning
    };
    } finally { index._endOp(); }
}

/**
 * About: comprehensive symbol metadata — definition, usages, callers, callees, tests, code.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Symbol name
 * @param {object} options - { file, className, all, maxCallers, maxCallees, withCode, withTypes,
 *                             includeMethods, includeUncertain, includeTests, exclude, minConfidence }
 * @returns {object|null}
 */
function about(index, name, options = {}) {
    index._beginOp();
    try {
    const maxCallers = options.all ? Infinity : (options.maxCallers || 10);
    const maxCallees = options.all ? Infinity : (options.maxCallees || 10);

    // Find symbol definition(s) — skip counts since about() computes its own via usages()
    const definitions = index.find(name, { exact: true, file: options.file, className: options.className, skipCounts: true });
    if (definitions.length === 0) {
        // Try fuzzy match (needs counts for suggestion ranking)
        const fuzzy = index.find(name, { file: options.file, className: options.className });
        if (fuzzy.length === 0) {
            return null;
        }
        // Return suggestion
        return {
            found: false,
            suggestions: (options.all ? fuzzy : fuzzy.slice(0, 5)).map(s => ({
                name: s.name,
                file: s.relativePath,
                line: s.startLine,
                type: s.type,
                usageCount: s.usageCount
            }))
        };
    }

    // Use resolveSymbol for consistent primary selection (prefers non-test files)
    const { def: resolved, warnings: resolveWarnings } = index.resolveSymbol(name, { file: options.file, className: options.className, line: options.line });
    const primary = resolved || definitions[0];
    const others = definitions.filter(d =>
        d.relativePath !== primary.relativePath || d.startLine !== primary.startLine
    );

    // BUG-M4: signal when about auto-picked a primary among multiple candidates
    // and the user supplied no --file/--class disambiguator. The resolveSymbol
    // warnings array already includes an "ambiguous" entry — surface it on the
    // result so formatters can render the note.
    //
    // R3-NEW-4: align the displayed count with `find`'s filtered count by
    // dropping test-file definitions when --include-tests is not set.
    // Without this, `find foo` could report 2 matches while `about foo` says
    // "Found 7 definitions" — same query, divergent counts.
    const aboutWarnings = [];
    if (!options.file && !options.className && resolveWarnings && resolveWarnings.length > 0) {
        const { isTestPath } = require('./shared');
        const { isTestFile } = require('./discovery');
        const filterTests = !options.includeTests;
        for (const w of resolveWarnings) {
            if (w.type !== 'ambiguous') continue;
            if (!filterTests) {
                aboutWarnings.push(w);
                continue;
            }
            // Recompute the count using the same test exclusion that find applies.
            // Always include `def` (the picked primary) so the message wording
            // ("Using <def>...") stays consistent with the count.
            const visible = definitions.filter(d => {
                if (d === primary || (d.relativePath === primary.relativePath && d.startLine === primary.startLine)) return true;
                const lang = detectLanguage(d.file);
                if (isTestFile(d.relativePath, lang) || isTestPath(d.relativePath)) return false;
                return true;
            });
            if (visible.length <= 1) {
                // After test filtering, no real ambiguity remained — drop the warning.
                continue;
            }
            const visibleOthers = visible.filter(d => d !== primary && (d.relativePath !== primary.relativePath || d.startLine !== primary.startLine));
            const shown = visibleOthers.slice(0, 5);
            const extra = visibleOthers.length - shown.length;
            const alsoIn = shown.map(d => `${d.relativePath}:${d.startLine}`).join(', ');
            const suffix = extra > 0 ? `, and ${extra} more` : '';
            aboutWarnings.push({
                type: 'ambiguous',
                message: `Found ${visible.length} definitions for "${name}". Using ${primary.relativePath}:${primary.startLine}. Also in: ${alsoIn}${suffix}. Use file= to disambiguate.`,
                alternatives: visibleOthers.map(d => ({ file: d.relativePath, line: d.startLine })),
            });
        }
    }

    // Use the actual symbol name (may differ from query if fuzzy matched)
    const symbolName = primary.name;

    // Default includeMethods: true when target is a class method (method calls are the primary way
    // class methods are invoked), false for standalone functions (reduces noise from unrelated obj.fn() calls)
    const isMethod = !!(primary.isMethod || primary.type === 'method' || primary.className);
    const includeMethods = options.includeMethods ?? isMethod;

    // Get usage counts by type (fast path uses callee index, no file reads)
    // Exclude test files by default (matching usages command behavior)
    const countExclude = !options.includeTests ? addTestExclusions(options.exclude) : options.exclude;
    const usagesByType = index.countSymbolUsages(primary, { exclude: countExclude });

    // Get callers and callees (only for functions)
    let callers = [];
    let callees = [];
    let allCallers = null;
    let allCallees = null;
    let aboutConfFiltered = 0;
    let aboutAccount = null;
    let aboutUnverified = { total: 0, top: [] };
    // BUG-M3: include classes/structs/interfaces — `new Foo()` invocations are
    // tracked as calls in the parser (isConstructor:true) and findCallers resolves
    // them. Without this, `about ClassName` produced "USAGES: 5 calls" but no
    // CALLERS section, hiding the actual constructor sites.
    const CALLABLE_TYPES = new Set(['function', 'method', 'static', 'constructor',
        'public', 'abstract', 'classmethod', 'class', 'struct', 'interface',
        'type', 'enum', 'trait', 'impl', 'record', 'namespace']);
    if (CALLABLE_TYPES.has(primary.type) || primary.params !== undefined) {
        // Use maxResults to limit file iteration (with buffer for exclude filtering)
        // Reduce buffer for highly ambiguous names (many definitions = more noise, less value per caller)
        const callerMultiplier = definitions.length > 5 ? 1.5 : 3;
        const callerCap = maxCallers === Infinity ? undefined : Math.ceil(maxCallers * callerMultiplier);
        // BUG-H1: pass needsTotal:true so the returned array's `totalCount` reflects the
        // true pre-truncation candidate count. Without this, `about` would report the
        // capped count as the total (e.g. "showing 10 of 30" when there are actually 153).
        const rawCallers = index.findCallers(symbolName, { includeMethods, includeUncertain: options.includeUncertain, targetDefinitions: [primary], maxResults: callerCap, needsTotal: true, collectAccount: true });
        const shadowCallers = rawCallers.shadowEntries || [];
        allCallers = rawCallers;
        const aboutFilteredByFlag = { exclude: 0, minConfidence: 0, unreachableOnly: 0 };
        // Tier partition: confirmed callers stay in allCallers; unverified-tier
        // entries (incl. engine-routed retained drops) get their own section.
        let unverifiedPool = [
            ...allCallers.filter(c => c.tier === 'unverified'),
            ...(rawCallers.unverifiedEntries || []),
        ];
        allCallers = allCallers.filter(c => c.tier !== 'unverified');
        // Apply exclude filter before slicing
        if (options.exclude && options.exclude.length > 0) {
            const before = allCallers.length;
            allCallers = allCallers.filter(c => index.matchesFilters(c.relativePath, { exclude: options.exclude }));
            aboutFilteredByFlag.exclude = before - allCallers.length;
            const beforeUnverified = unverifiedPool.length;
            unverifiedPool = unverifiedPool.filter(c => index.matchesFilters(c.relativePath, { exclude: options.exclude }));
            aboutFilteredByFlag.exclude += beforeUnverified - unverifiedPool.length;
        }
        // Apply confidence filtering before slicing
        if (options.minConfidence > 0) {
            const { filterByConfidence } = require('./confidence');
            const callerResult = filterByConfidence(allCallers, options.minConfidence);
            allCallers = callerResult.kept;
            aboutConfFiltered += callerResult.filtered;
            aboutFilteredByFlag.minConfidence = callerResult.filtered;
        }
        // BUG-H1: post-filter total — count the un-enriched shadow candidates that
        // also pass the same filters, so the displayed "showing N of <total>"
        // matches what `context` (which runs unbounded) would have shown.
        // Per-tier: unverified-tier shadows count toward the unverified total,
        // never toward the confirmed total.
        let shadowSurvivors = shadowCallers;
        if (options.exclude && options.exclude.length > 0) {
            shadowSurvivors = shadowSurvivors.filter(c => index.matchesFilters(c.relativePath, { exclude: options.exclude }));
        }
        if (options.minConfidence > 0) {
            shadowSurvivors = shadowSurvivors.filter(c => (c.confidence || 0) >= options.minConfidence);
        }
        const unverifiedShadowCount = shadowSurvivors.filter(s => s.tier === 'unverified').length;
        shadowSurvivors = shadowSurvivors.filter(s => s.tier !== 'unverified');
        // Tag reachability on raw caller objects so we can preserve the field on the projection.
        // Reachability is computed once per index and cached.
        const aboutReachable = computeReachability(index);
        tagCallersReachable(allCallers, aboutReachable);

        // Optional: filter to unreachable-only callers
        if (options.unreachableOnly) {
            const before = allCallers.length;
            allCallers = allCallers.filter(c => !c.reachable);
            aboutFilteredByFlag.unreachableOnly = before - allCallers.length;
            // Apply same filter to shadows using their callerStartLine/file when available.
            // Shadows lack callerStartLine, so they're treated as reachable=false (conservative,
            // matches the historical behavior where un-enriched callers had no reachability info).
            // We exclude all shadows here since unreachableOnly is a niche flag and the cost of
            // building a perfect estimate isn't justified.
            shadowSurvivors = []; // conservative — drop shadows for unreachableOnly mode
        }
        // Conservation account: claims from the PRE-filter rawCallers (+shadows);
        // display-filter hides are explanatory metadata, outside the invariant.
        const aboutFilteredTotal = aboutFilteredByFlag.exclude + aboutFilteredByFlag.minConfidence + aboutFilteredByFlag.unreachableOnly;
        aboutAccount = composeAccount(index, symbolName, rawCallers,
            aboutFilteredTotal > 0 ? { total: aboutFilteredTotal, byFlag: aboutFilteredByFlag } : undefined);
        // Stash the post-filter total on allCallers so the result builder can use it.
        Object.defineProperty(allCallers, '__postFilterTotal', {
            value: allCallers.length + shadowSurvivors.length,
            enumerable: false,
            configurable: true,
        });
        // R3-NEW-1: stash shadow survivors so the histogram can include them.
        // Without this the histogram only reflects the enriched (capped) callers,
        // not the true total reported in `total`.
        Object.defineProperty(allCallers, '__shadowSurvivors', {
            value: shadowSurvivors,
            enumerable: false,
            configurable: true,
        });

        callers = allCallers.slice(0, maxCallers).map(c => ({
            file: c.relativePath,
            line: c.line,
            // Stable handle for the *caller function*, not the call site.
            // Lets the caller copy-paste the handle to drill into who-called-this.
            ...(c.callerStartLine && c.callerName && {
                handle: `${c.relativePath}:${c.callerStartLine}:${c.callerName}`
            }),
            expression: c.content.trim(),
            callerName: c.callerName,
            confidence: c.confidence,
            resolution: c.resolution,
            reachable: c.reachable,
        }));

        // Unverified tier projection: visible, capped, with the drop reason.
        unverifiedPool.sort((a, b) => {
            const fa = a.relativePath || '';
            const fb = b.relativePath || '';
            if (fa !== fb) return fa.localeCompare(fb);
            return (a.line || 0) - (b.line || 0);
        });
        aboutUnverified = {
            total: unverifiedPool.length + unverifiedShadowCount,
            top: unverifiedPool.slice(0, 10).map(c => ({
                file: c.relativePath,
                line: c.line,
                ...(c.callerStartLine && c.callerName && {
                    handle: `${c.relativePath}:${c.callerStartLine}:${c.callerName}`
                }),
                expression: (c.content || '').trim(),
                callerName: c.callerName ?? null,
                confidence: c.confidence,
                resolution: c.resolution,
                ...(c.reason && { reason: c.reason }),
                ...(c.dispatchVia && { dispatchVia: c.dispatchVia }),
                ...(c.dispatchCandidates != null && { dispatchCandidates: c.dispatchCandidates }),
            })),
        };

        // BUG-M3: classes/structs/interfaces don't have meaningful callees
        // (their body is methods, not a sequence of calls). Skip findCallees
        // for type definitions — callers (constructor/instantiation sites)
        // are the useful signal here.
        const TYPE_DEF_KINDS = new Set(['class', 'struct', 'interface', 'type',
            'enum', 'trait', 'impl', 'record', 'namespace']);
        if (TYPE_DEF_KINDS.has(primary.type)) {
            allCallees = [];
        } else {
            allCallees = index.findCallees(primary, { includeMethods, includeUncertain: options.includeUncertain });
        }
        // Apply exclude filter before slicing
        if (options.exclude && options.exclude.length > 0) {
            allCallees = allCallees.filter(c => index.matchesFilters(c.relativePath, { exclude: options.exclude }));
        }
        // Apply confidence filtering before slicing
        if (options.minConfidence > 0) {
            const { filterByConfidence } = require('./confidence');
            const calleeResult = filterByConfidence(allCallees, options.minConfidence);
            allCallees = calleeResult.kept;
            aboutConfFiltered += calleeResult.filtered;
        }

        // Tag callee reachability + optional unreachable-only filter
        tagCalleesReachable(allCallees, aboutReachable);
        if (options.unreachableOnly) {
            allCallees = allCallees.filter(c => !c.reachable);
        }
        tagCalleesSideEffects(index, allCallees);

        callees = allCallees.slice(0, maxCallees).map(c => ({
            name: c.name,
            file: c.relativePath,
            line: c.startLine,
            startLine: c.startLine,
            endLine: c.endLine,
            handle: c.startLine ? `${c.relativePath}:${c.startLine}:${c.name}` : undefined,
            weight: c.weight,
            callCount: c.callCount,
            confidence: c.confidence,
            resolution: c.resolution,
            reachable: c.reachable,
            ...(c.returnType && { returnType: c.returnType }),
            ...(c.paramTypes && { paramTypes: c.paramTypes }),
            ...(c.paramsStructured && { paramsStructured: c.paramsStructured }),
            ...(c.docstring && { docstring: c.docstring }),
            ...(c.sideEffects && c.sideEffects.length && { sideEffects: c.sideEffects }),
        }));
    }

    // Find tests — scope to the same file/class as the primary definition
    // Skip expensive test search for highly ambiguous names (>10 other definitions)
    const tests = (others.length > 10 && !options.all) ? [] : index.tests(symbolName, {
        file: options.file,
        className: options.className || primary.className,
        exclude: options.exclude,
    });
    const testSummary = {
        fileCount: tests.length,
        totalMatches: tests.reduce((sum, t) => sum + t.matches.length, 0),
        files: (options.all ? tests : tests.slice(0, 3)).map(t => t.file)
    };

    // Extract code if requested (default: true)
    let code = null;
    if (options.withCode !== false) {
        code = index.extractCode(primary);
    }

    // Get type definitions if requested
    let types = [];
    if (options.withTypes) {
        const TYPE_KINDS = ['type', 'interface', 'class', 'struct'];
        const seen = new Set();

        const addType = (typeName) => {
            if (seen.has(typeName)) return;
            seen.add(typeName);
            const typeSymbols = index.symbols.get(typeName);
            if (typeSymbols) {
                for (const sym of typeSymbols) {
                    if (TYPE_KINDS.includes(sym.type)) {
                        types.push({
                            name: sym.name,
                            type: sym.type,
                            file: sym.relativePath,
                            line: sym.startLine
                        });
                    }
                }
            }
        };

        // From signature annotations
        const typeNames = index.extractTypeNames(primary);
        for (const typeName of typeNames) addType(typeName);

        // From callee signatures — types used by functions this function calls
        if (allCallees) {
            for (const callee of allCallees) {
                const calleeTypeNames = index.extractTypeNames(callee);
                for (const tn of calleeTypeNames) addType(tn);
            }
        }
    }

    // Optional git enrichment for the primary symbol's file.
    // Attached only when options.git is set; skipped silently if not a git repo.
    // Cheap (single git log invocation, cached per process) and gracefully
    // degrades — formatters check `git.available` before rendering.
    let gitInfo = null;
    if (options.git) {
        const { getGitInfo } = require('./git-enrich');
        gitInfo = getGitInfo(index.root, primary.relativePath);
    }

    const result = {
        found: true,
        symbol: {
            name: primary.name,
            type: primary.type,
            file: primary.relativePath,
            startLine: primary.startLine,
            endLine: primary.endLine,
            handle: require('./shared').formatSymbolHandle(primary),
            params: primary.params,
            ...(primary.paramsStructured && { paramsStructured: primary.paramsStructured }),
            returnType: primary.returnType,
            ...(primary.paramTypes && { paramTypes: primary.paramTypes }),
            ...(primary.isAsync && { isAsync: true }),
            ...(primary.isGenerator && { isGenerator: true }),
            ...(primary.decorators && primary.decorators.length && { decorators: primary.decorators }),
            modifiers: primary.modifiers,
            docstring: primary.docstring,
            signature: index.formatSignature(primary)
        },
        ...(gitInfo && { git: gitInfo }),
        usages: usagesByType,
        totalUsages: usagesByType.calls + usagesByType.imports + usagesByType.references,
        callers: {
            // BUG-H1: prefer post-filter total (computed from enriched + shadow candidates).
            // Falls back to allCallers.length when the post-filter total wasn't computed
            // (e.g., when primary is not a function and findCallers wasn't called).
            // Since the tier partition, this total counts CONFIRMED callers only.
            total: allCallers?.__postFilterTotal ?? allCallers?.length ?? 0,
            top: callers,
            unverified: aboutUnverified,
            // R3-NEW-1: include shadow callers (un-enriched candidates that passed the
            // same filters) so the histogram counts sum to `total`, not maxResults*3.
            histogram: buildHistogram(
                allCallers && allCallers.__shadowSurvivors && allCallers.__shadowSurvivors.length > 0
                    ? [...allCallers, ...allCallers.__shadowSurvivors]
                    : allCallers
            ),
        },
        callees: {
            total: allCallees?.length ?? 0,
            top: callees,
            histogram: buildHistogram(allCallees),
        },
        tests: testSummary,
        otherDefinitions: (options.all ? others : others.slice(0, 3)).map(d => ({
            file: d.relativePath,
            line: d.startLine,
            usageCount: d.usageCount ?? index.countSymbolUsages(d).total
        })),
        types,
        code,
        includeMethods,
        ...(aboutAccount && { account: aboutAccount }),
        ...(allCallers && { hasEntrypoints: computeReachability(index).size > 0 }),
        ...(aboutConfFiltered > 0 && { confidenceFiltered: aboutConfFiltered }),
        // BUG-M4: surface ambiguous-resolution warnings so formatters can render
        // a "auto-selected ... pass --file to choose" note.
        ...(aboutWarnings.length > 0 && { warnings: aboutWarnings }),
        completeness: detectCompleteness(index)
    };

    return result;
    } finally { index._endOp(); }
}

/**
 * Diff-based impact analysis: find which functions changed and who calls them.
 *
 * @param {object} index - ProjectIndex instance
 * @param {object} options - { base, staged, file }
 * @returns {object}
 */
function diffImpact(index, options = {}) {
    index._beginOp();
    try {
    const { base = 'HEAD', staged = false, file } = options;

    // Validate base ref format to prevent argument injection
    if (base && !/^[a-zA-Z0-9._\-~\/^@{}:]+$/.test(base)) {  // eslint-disable-line no-useless-escape
        throw new Error(`Invalid git ref format: ${base}`);
    }

    // Verify git repo
    let gitRoot;
    try {
        gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: index.root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) {
        throw new Error('Not a git repository. diff-impact requires git.', { cause: e });
    }

    // Build git diff command (use execFileSync to avoid shell expansion)
    const diffArgs = ['diff', '--unified=0'];
    if (staged) {
        diffArgs.push('--staged');
    } else {
        diffArgs.push(base);
    }
    if (file) {
        diffArgs.push('--', file);
    }

    let diffText;
    try {
        diffText = execFileSync('git', diffArgs, { cwd: index.root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    } catch (e) {
        // git diff exits non-zero when there are diff errors, but also for invalid refs
        if (e.stdout) {
            diffText = e.stdout;
        } else {
            throw new Error(`git diff failed: ${e.message}`, { cause: e });
        }
    }

    if (!diffText || !diffText.trim()) {
        return {
            base: staged ? '(staged)' : base,
            functions: [],
            moduleLevelChanges: [],
            newFunctions: [],
            deletedFunctions: [],
            summary: { modifiedFunctions: 0, deletedFunctions: 0, newFunctions: 0, totalCallSites: 0, affectedFiles: 0 }
        };
    }

    // Diff paths are git-root-relative. Resolve to index.root for file lookup.
    // Normalize both through realpath to handle macOS /var → /private/var symlinks.
    let realGitRoot, realProjectRoot;
    try { realGitRoot = fs.realpathSync(gitRoot); } catch (_) { realGitRoot = gitRoot; }
    try { realProjectRoot = fs.realpathSync(index.root); } catch (_) { realProjectRoot = index.root; }
    const projectPrefix = realGitRoot === realProjectRoot
        ? ''
        : path.relative(realGitRoot, realProjectRoot);

    const rawChanges = parseDiff(diffText, gitRoot);
    // Filter to files under index.root and remap paths.
    // Preserve gitRelativePath (repo-relative) for git show commands.
    const changes = [];
    for (const c of rawChanges) {
        if (projectPrefix && !c.relativePath.startsWith(projectPrefix + '/')) continue;
        const localRel = projectPrefix ? c.relativePath.slice(projectPrefix.length + 1) : c.relativePath;
        changes.push({ ...c, gitRelativePath: c.relativePath, filePath: path.join(index.root, localRel), relativePath: localRel });
    }

    const functions = [];
    const moduleLevelChanges = [];
    const newFunctions = [];
    const deletedFunctions = [];
    const callerFileSet = new Set();
    let totalCallSites = 0;

    for (const change of changes) {
        const lang = detectLanguage(change.filePath);
        if (!lang) continue;

        const fileEntry = index.files.get(change.filePath);

        // Handle deleted files: entire file was removed, all functions are deleted
        if (!fileEntry) {
            if (change.isDeleted && change.deletedLines.length > 0) {
                const ref = staged ? 'HEAD' : base;
                try {
                    const oldContent = execFileSync(
                        'git', ['show', `${ref}:${change.gitRelativePath}`],
                        { cwd: index.root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
                    );
                    const oldParsed = parse(oldContent, lang);
                    for (const oldFn of extractCallableSymbols(oldParsed)) {
                        deletedFunctions.push({
                            name: oldFn.name,
                            filePath: change.filePath,
                            relativePath: change.relativePath,
                            startLine: oldFn.startLine
                        });
                    }
                } catch (e) {
                    // git show failed — skip
                }
            }
            continue;
        }

        // Track which functions are affected by added/modified lines
        const affectedSymbols = new Map(); // symbolName -> { symbol, addedLines, deletedLines }

        // Pre-compute old file's symbol identities (BUG-F): use the old AST as the
        // authoritative source for "did this function exist before?". Avoids the
        // line-arithmetic guess that was wrong for tightly-packed 1-line functions.
        // The identity key is `name\0className` (matches deletion-detection below).
        let oldSymbolIdentities = null; // null = unknown (file untracked or git failed)
        if (change.deletedLines.length > 0 || change.addedLines.length > 0) {
            const ref = staged ? 'HEAD' : base;
            try {
                const oldContent = execFileSync(
                    'git', ['show', `${ref}:${change.gitRelativePath}`],
                    { cwd: index.root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
                );
                const fileLang = detectLanguage(change.filePath);
                if (fileLang) {
                    const oldParsed = parse(oldContent, fileLang);
                    oldSymbolIdentities = new Set();
                    for (const oldFn of extractCallableSymbols(oldParsed)) {
                        oldSymbolIdentities.add(`${oldFn.name}\0${oldFn.className || ''}`);
                    }
                }
            } catch (e) {
                // File didn't exist in base, or git error — leave null (unknown).
            }
        }

        for (const line of change.addedLines) {
            const symbol = index.findEnclosingFunction(change.filePath, line, true);
            if (symbol) {
                const key = `${symbol.name}:${symbol.startLine}`;
                if (!affectedSymbols.has(key)) {
                    affectedSymbols.set(key, { symbol, addedLines: [], deletedLines: [] });
                }
                affectedSymbols.get(key).addedLines.push(line);
            } else {
                // Module-level change
                const existing = moduleLevelChanges.find(m => m.filePath === change.filePath);
                if (existing) {
                    existing.addedLines.push(line);
                } else {
                    moduleLevelChanges.push({
                        filePath: change.filePath,
                        relativePath: change.relativePath,
                        addedLines: [line],
                        deletedLines: []
                    });
                }
            }
        }

        for (const line of change.deletedLines) {
            // For deleted lines, we can't use findEnclosingFunction on the current file
            // since those lines no longer exist. Track as module-level unless they map
            // to a function that still exists (the function was modified, not deleted).
            // We approximate: if a deleted line is within the range of a known symbol, it's a modification.
            // Pick the MOST-SPECIFIC match: prefer exact-contained over tolerance-contained,
            // and among ties prefer the smallest range (innermost). This avoids an earlier
            // symbol's expanded ±2 range claiming a line that actually belongs to a later
            // 1-line function in tightly-packed files (BUG-F).
            let bestSymbol = null;
            let bestExact = false;
            let bestRange = Infinity;
            for (const symbol of fileEntry.symbols) {
                if (NON_CALLABLE_TYPES.has(symbol.type)) continue;
                const exact = line >= symbol.startLine && line <= symbol.endLine;
                const tolerant = line >= symbol.startLine - 2 && line <= symbol.endLine + 2;
                if (!exact && !tolerant) continue;
                const range = symbol.endLine - symbol.startLine;
                // Prefer exact-contained over tolerance-contained; among same kind, smaller range wins.
                const better = bestSymbol === null
                    || (exact && !bestExact)
                    || (exact === bestExact && range < bestRange);
                if (better) {
                    bestSymbol = symbol;
                    bestExact = exact;
                    bestRange = range;
                }
            }
            let matched = false;
            if (bestSymbol) {
                // Only attribute to a symbol that ALSO existed in the old file. If we
                // know the old identities and this symbol wasn't there, it's a brand-new
                // function — its "deleted line" is really a neighboring line that gets
                // pushed up by the diff hunk header. Treat as module-level so the new
                // symbol stays cleanly in newFunctions[] (BUG-F).
                const identityKey = `${bestSymbol.name}\0${bestSymbol.className || ''}`;
                const existedBefore = oldSymbolIdentities === null
                    ? true
                    : oldSymbolIdentities.has(identityKey);
                if (existedBefore) {
                    const key = `${bestSymbol.name}:${bestSymbol.startLine}`;
                    if (!affectedSymbols.has(key)) {
                        affectedSymbols.set(key, { symbol: bestSymbol, addedLines: [], deletedLines: [] });
                    }
                    affectedSymbols.get(key).deletedLines.push(line);
                    matched = true;
                }
            }
            if (!matched) {
                const existing = moduleLevelChanges.find(m => m.filePath === change.filePath);
                if (existing) {
                    existing.deletedLines.push(line);
                } else {
                    moduleLevelChanges.push({
                        filePath: change.filePath,
                        relativePath: change.relativePath,
                        addedLines: [],
                        deletedLines: [line]
                    });
                }
            }
        }

        // Detect new functions: a function is new if it didn't exist in the old file
        // by identity (name + className). This is authoritative — no more line-count
        // heuristics. Falls back to the old line-arithmetic approximation when the
        // old file is unreachable (e.g. untracked or pre-base).
        for (const [key, data] of affectedSymbols) {
            const { symbol, addedLines } = data;
            const identityKey = `${symbol.name}\0${symbol.className || ''}`;
            let isNew;
            if (oldSymbolIdentities !== null) {
                isNew = !oldSymbolIdentities.has(identityKey);
            } else {
                // Fallback: 80% of body lines added and no deletions hit this symbol.
                const fnLineCount = symbol.endLine - symbol.startLine + 1;
                isNew = addedLines.length >= fnLineCount * 0.8 && data.deletedLines.length === 0;
            }
            if (isNew) {
                newFunctions.push({
                    name: symbol.name,
                    filePath: change.filePath,
                    relativePath: change.relativePath,
                    startLine: symbol.startLine,
                    endLine: symbol.endLine,
                    signature: index.formatSignature(symbol)
                });
                affectedSymbols.delete(key);
            }
        }

        // Detect deleted functions: compare old file symbols with current by identity.
        // Uses name+className counts to handle overloads (e.g. Java method overloading).
        if (change.deletedLines.length > 0) {
            const ref = staged ? 'HEAD' : base;
            try {
                const oldContent = execFileSync(
                    'git', ['show', `${ref}:${change.gitRelativePath}`],
                    { cwd: index.root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
                );
                const fileLang = detectLanguage(change.filePath);
                if (fileLang) {
                    const oldParsed = parse(oldContent, fileLang);
                    // Count current symbols by identity (name + className)
                    const currentCounts = new Map();
                    for (const s of fileEntry.symbols) {
                        if (NON_CALLABLE_TYPES.has(s.type)) continue;
                        const key = `${s.name}\0${s.className || ''}`;
                        currentCounts.set(key, (currentCounts.get(key) || 0) + 1);
                    }
                    // Count old symbols by identity and detect deletions
                    const oldCounts = new Map();
                    const oldSymbols = extractCallableSymbols(oldParsed);
                    for (const oldFn of oldSymbols) {
                        const key = `${oldFn.name}\0${oldFn.className || ''}`;
                        oldCounts.set(key, (oldCounts.get(key) || 0) + 1);
                    }
                    // For each identity, if old count > current count, the difference are deletions
                    for (const [key, oldCount] of oldCounts) {
                        const curCount = currentCounts.get(key) || 0;
                        if (oldCount > curCount) {
                            // Find the specific old symbols with this identity that were deleted
                            const matching = oldSymbols.filter(s => `${s.name}\0${s.className || ''}` === key);
                            // Report the extra ones (by startLine descending — later ones more likely deleted)
                            const toReport = matching.slice(curCount);
                            for (const oldFn of toReport) {
                                deletedFunctions.push({
                                    name: oldFn.name,
                                    filePath: change.filePath,
                                    relativePath: change.relativePath,
                                    startLine: oldFn.startLine
                                });
                            }
                        }
                    }
                }
            } catch (e) {
                // File didn't exist in base, or git error — skip
            }
        }

        // For each affected function, find callers
        for (const [, data] of affectedSymbols) {
            const { symbol, addedLines: aLines, deletedLines: dLines } = data;

            // Get the specific definitions matching this symbol
            const allDefs = index.symbols.get(symbol.name) || [];
            const targetDefs = allDefs.filter(d => d.file === change.filePath && d.startLine === symbol.startLine);

            let callers = index.findCallers(symbol.name, {
                targetDefinitions: targetDefs.length > 0 ? targetDefs : undefined,
                includeMethods: true,
                includeUncertain: false,
            });

            // For Go/Java/Rust methods with a className, filter callers whose
            // receiver clearly belongs to a different type (same logic as impact()).
            const targetDef = targetDefs[0] || symbol;
            if (targetDef.className && langTraits(lang)?.typeSystem === 'nominal') {
                const targetClassName = targetDef.className;
                // Pre-compute how many types share this method name
                const methodDefs = index.symbols.get(symbol.name);
                const classNames = new Set();
                if (methodDefs) {
                    for (const d of methodDefs) {
                        if (d.className) classNames.add(d.className);
                        else if (d.receiver) classNames.add(d.receiver.replace(/^\*/, ''));
                    }
                }
                const isWidelyShared = classNames.size > 3;
                callers = callers.filter(c => {
                    if (!c.isMethod) return true;
                    const r = c.receiver;
                    if (r && ['self', 'cls', 'this', 'super'].includes(r)) return true;
                    // No receiver (chained/complex expression): only include if method is
                    // unique or rare across types — otherwise too many false positives
                    if (!r) {
                        return classNames.size <= 1;
                    }
                    // Use receiverType from findCallers when available
                    if (c.receiverType) {
                        return c.receiverType === targetClassName ||
                               c.receiverType === targetDef.receiver?.replace(/^\*/, '');
                    }
                    // Unique method heuristic: if the method exists on exactly one class/type, include
                    if (classNames.size === 1 && classNames.has(targetClassName)) return true;
                    // For widely shared method names (Get, Set, Run, etc.), require same-package
                    // evidence when receiver type is unknown
                    if (isWidelyShared) {
                        const callerFile = c.file || '';
                        const targetDir = path.dirname(change.filePath);
                        return path.dirname(callerFile) === targetDir;
                    }
                    // Unknown receiver + multiple classes with this method → filter out
                    return false;
                });
            }

            for (const c of callers) {
                callerFileSet.add(c.file);
            }
            totalCallSites += callers.length;

            functions.push({
                name: symbol.name,
                filePath: change.filePath,
                relativePath: change.relativePath,
                startLine: symbol.startLine,
                endLine: symbol.endLine,
                signature: index.formatSignature(symbol),
                addedLines: aLines,
                deletedLines: dLines,
                callers: callers.map(c => ({
                    file: c.file,
                    relativePath: c.relativePath,
                    line: c.line,
                    callerName: c.callerName,
                    content: c.content.trim()
                }))
            });
        }
    }

    return {
        base: staged ? '(staged)' : base,
        functions,
        moduleLevelChanges,
        newFunctions,
        deletedFunctions,
        summary: {
            modifiedFunctions: functions.length,
            deletedFunctions: deletedFunctions.length,
            newFunctions: newFunctions.length,
            totalCallSites,
            affectedFiles: callerFileSet.size
        }
    };
    } finally { index._endOp(); }
}

// ========================================================================
// STANDALONE HELPERS (used by diffImpact and parseDiff)
// ========================================================================

/**
 * Extract all callable symbols (functions + class methods) from a parse result,
 * matching how indexFile builds the symbol list. Methods get className added.
 * @param {object} parsed - Result from parse()
 * @returns {Array<{name, className, startLine}>}
 */
function extractCallableSymbols(parsed) {
    const symbols = [];
    for (const fn of parsed.functions) {
        symbols.push({ name: fn.name, className: fn.className || '', startLine: fn.startLine });
    }
    for (const cls of parsed.classes) {
        if (cls.members) {
            for (const m of cls.members) {
                symbols.push({ name: m.name, className: cls.name, startLine: m.startLine });
            }
        }
    }
    return symbols;
}

/**
 * Unquote a git diff path: unescape C-style backslash sequences and strip tab metadata.
 * Git quotes paths containing special chars as "a/path\"with\"quotes".
 * @param {string} raw - Raw path string (may contain backslash escapes)
 * @returns {string} Unquoted path
 */
function unquoteDiffPath(raw) {
    const ESCAPES = { '\\\\': '\\', '\\"': '"', '\\n': '\n', '\\t': '\t' };
    return raw
        .split('\t')[0]
        .replace(/\\[\\"nt]/g, m => ESCAPES[m]);
}

/**
 * Parse unified diff output into structured change data
 * @param {string} diffText - Output from `git diff --unified=0`
 * @param {string} root - Project root directory
 * @returns {Array<{ filePath, relativePath, addedLines, deletedLines }>}
 */
function parseDiff(diffText, root) {
    const changes = [];
    let currentFile = null;
    let pendingOldPath = null; // Track --- a/ path for deleted files

    for (const line of diffText.split('\n')) {
        // Track old file path from --- header for deleted-file detection
        // Handles both unquoted (--- a/path) and quoted (--- "a/path") formats
        const oldMatch = line.match(/^--- (?:"a\/((?:[^"\\]|\\.)*)"|a\/(.+?))\s*$/);
        if (oldMatch) {
            const raw = oldMatch[1] !== undefined ? oldMatch[1] : oldMatch[2];
            pendingOldPath = unquoteDiffPath(raw);
            continue;
        }

        // Match file header: +++ b/path or +++ "b/path" or +++ /dev/null
        if (line.startsWith('+++ ')) {
            let relativePath;
            const isDevNull = line.startsWith('+++ /dev/null');
            if (isDevNull) {
                // File was deleted — use the --- a/ path
                if (!pendingOldPath) continue;
                relativePath = pendingOldPath;
            } else {
                const newMatch = line.match(/^\+\+\+ (?:"b\/((?:[^"\\]|\\.)*)"|b\/(.+?))\s*$/);
                if (!newMatch) continue;
                const raw = newMatch[1] !== undefined ? newMatch[1] : newMatch[2];
                relativePath = unquoteDiffPath(raw);
            }
            pendingOldPath = null;
            currentFile = {
                filePath: path.join(root, relativePath),
                relativePath,
                addedLines: [],
                deletedLines: [],
                ...(isDevNull && { isDeleted: true })
            };
            changes.push(currentFile);
            continue;
        }

        // Match hunk header: @@ -old,count +new,count @@
        if (line.startsWith('@@') && currentFile) {
            const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (match) {
                const oldStart = parseInt(match[1], 10);
                const oldCount = parseInt(match[2] || '1', 10);
                const newStart = parseInt(match[3], 10);
                const newCount = parseInt(match[4] || '1', 10);

                // Deleted lines (from old file)
                if (oldCount > 0) {
                    for (let i = 0; i < oldCount; i++) {
                        currentFile.deletedLines.push(oldStart + i);
                    }
                }

                // Added lines (in new file)
                if (newCount > 0) {
                    for (let i = 0; i < newCount; i++) {
                        currentFile.addedLines.push(newStart + i);
                    }
                }
            }
        }
    }

    return changes;
}

// ============================================================================
// AUDIT-ASYNC (Feature B)
// ============================================================================

// Languages for which audit-async runs (those with async/await keyword we
// track). Go/Java/Rust have async machinery but audit-async is scoped to
// JS/TS/Python per spec.
const _AUDIT_ASYNC_LANGS = new Set(['javascript', 'typescript', 'tsx', 'python', 'html']);

// Built-in/standard-library callees that return promises and are commonly
// missing-awaited. Conservative starter set (rule #9 — generic, not
// project-specific). The audit only flags when the caller is async, the
// callee is provably async, AND the call isn't awaited; this set covers
// callees we can recognize without project-symbol resolution.
const _KNOWN_ASYNC_CALLEES = new Set([
    // JS/TS
    'fetch',
    // Node.js fs.promises etc. are method calls — `fs.readFile` resolves
    // through the symbol table as a method. We avoid hardcoding receiver
    // names here. setTimeout/setInterval are fire-and-forget by design.
]);

// Fire-and-forget patterns — calls inside these contexts are intentionally
// unawaited. Used to suppress false positives.
//   - Promise.all / Promise.allSettled / Promise.race / Promise.any
//   - void <expr>
//   - <expr>.then() / .catch() (the call provides its own handler)
const _FIRE_AND_FORGET_PROMISE_FNS = new Set(['all', 'allSettled', 'race', 'any']);

/**
 * Run an async/await audit across the project.
 *
 * Finds call sites that are likely missing an `await`. A site is flagged
 * when ALL of:
 *   1. The enclosing function is async (or top-level module code in an
 *      async-context module — JS modules with top-level await).
 *   2. The callee is provably async (its symbol's `isAsync` is true) OR
 *      the callee is a known async standard function (e.g., `fetch`).
 *   3. The call is not wrapped in `await` (or its Python equivalent).
 *   4. The call is not in a known fire-and-forget context (Promise.all
 *      arguments, `void fn()`, `.then(...)`, return statement, assignment
 *      to a variable — these are intentional non-await uses).
 *
 * Detection is AST-based per language; the language must support an
 * `await` keyword (JS/TS/Python). Other languages are skipped.
 *
 * @param {object} index - ProjectIndex instance
 * @param {object} [options] - { file, exclude }
 * @returns {{issues: Array<{file:string,line:number,callerName:string,calleeName:string,reason?:string}>}}
 */
function auditAsync(index, options = {}) {
    index._beginOp();
    try {
        const { detectLanguage, getParser, getLanguageModule, safeParse } = require('../languages');
        const issues = [];

        // Build a "is this name provably async" lookup from the symbol table.
        // We accept a global name only if EVERY callable definition with that
        // name is async — this avoids flagging ambiguous calls like `Map.get()`
        // where the project also has a `DataService.get()` async method.
        //
        // BUT: we ALSO track per-file async-name resolution. JavaScript/Python
        // module scope means a same-file definition shadows globals, so when
        // a caller's file contains an async definition with that name, that
        // definition wins regardless of what other files contain. This is
        // critical to avoid silent false-negatives caused by name collisions
        // across files (HIGH-1 fix).
        const asyncNames = new Set();
        const ambiguousNames = new Set(); // any non-async def exists somewhere
        const callableDefs = (defs) => defs.filter(d => d && (
            d.type === 'function' || d.type === 'method' ||
            d.type === 'constructor' || d.type === 'arrow' ||
            d.params != null || d.paramsStructured != null
        ));
        const isDefAsync = (d) => d.isAsync === true ||
            (Array.isArray(d.modifiers) && d.modifiers.includes('async'));
        for (const [name, defs] of index.symbols) {
            const callable = callableDefs(defs);
            if (callable.length === 0) continue;
            const allAsync = callable.every(isDefAsync);
            if (allAsync) {
                asyncNames.add(name);
            } else if (callable.some(isDefAsync)) {
                ambiguousNames.add(name);
            }
        }

        // Helper: does the call site (callExpr node) sit in a "fire-and-forget"
        // context? Walk up at most a few levels and check for known patterns.
        function isFireAndForget(callNode, language) {
            let p = callNode.parent;
            // 1. Direct `void fn()` (JS/TS only)
            if (p && p.type === 'unary_expression') {
                const op = p.childForFieldName('operator');
                if (op && op.text === 'void') return true;
                // Some grammars expose first child as the operator
                const first = p.namedChild(0);
                if (first && first.type === 'void') return true;
            }
            // 2. Argument of `Promise.all([...])` / `Promise.allSettled` / etc.
            //    Walk up: arguments > call > selector_expression(member) > 'Promise'.<allSettled>.
            //    The call site is somewhere inside the array; check if the
            //    enclosing call is a Promise.all-style helper.
            let cur = callNode.parent;
            let depth = 0;
            while (cur && depth++ < 6) {
                if ((cur.type === 'call_expression' || cur.type === 'call') && cur !== callNode) {
                    const fn = cur.childForFieldName('function');
                    if (fn) {
                        if (fn.type === 'member_expression' || fn.type === 'attribute') {
                            const obj = fn.childForFieldName('object') || fn.namedChild(0);
                            const prop = fn.childForFieldName('property') || fn.namedChild(fn.namedChildCount - 1);
                            if (obj && prop) {
                                const objText = obj.text;
                                const propText = prop.text;
                                if ((objText === 'Promise' || objText === 'asyncio') &&
                                    _FIRE_AND_FORGET_PROMISE_FNS.has(propText)) {
                                    return true;
                                }
                                // .then(...) / .catch(...) — caller is providing a handler;
                                // the inner call is intentional.
                                if (propText === 'then' || propText === 'catch' || propText === 'finally') {
                                    // Only flag when callNode is INSIDE the chain target,
                                    // not just an argument
                                    return true;
                                }
                            }
                        }
                    }
                    // Stop at the first enclosing call — we don't want to leak
                    // analysis past the immediate parent call.
                    break;
                }
                cur = cur.parent;
            }
            // 3. Right-hand side of an assignment / variable_declarator — the
            //    promise is being captured for later use, not lost. NOT
            //    fire-and-forget but also NOT a missing-await; treat as
            //    intentional.
            //    (We keep this distinct so the "captured" call doesn't get
            //    flagged.)
            let q = callNode.parent;
            // Skip await wrappers (already handled by caller)
            if (q && (q.type === 'await_expression' || q.type === 'await')) {
                q = q.parent;
            }
            if (q) {
                if (q.type === 'variable_declarator' || q.type === 'assignment_expression') {
                    return true;
                }
                if (q.type === 'return_statement') {
                    return true;  // returning the promise — caller awaits it
                }
                // Yielded as an expression: `yield fn()` — caller awaits / async iterator
                if (q.type === 'yield_expression' || q.type === 'yield') {
                    return true;
                }
            }
            return false;
        }

        // Process one file: find async functions, then call sites within them.
        function processFile(filePath, fileEntry) {
            if (!fileEntry || !_AUDIT_ASYNC_LANGS.has(fileEntry.language)) return;
            const language = fileEntry.language;

            // Collect async functions from the file's symbol list.
            // Also build a per-file set of names that are async in THIS file —
            // these win over the global "all-or-nothing" check (HIGH-1 fix).
            // JS/Python module scope means a same-file def shadows imports of
            // the same name, so a sync def of `helper` elsewhere in the project
            // shouldn't make `helper()` ambiguous in a file that defines
            // `async function helper()` locally.
            const asyncFns = [];
            const fileAsyncNames = new Set();
            const fileAnyDefNames = new Set();
            if (Array.isArray(fileEntry.symbols)) {
                for (const sym of fileEntry.symbols) {
                    if (!sym || !sym.startLine || !sym.endLine) continue;
                    const isAsync = sym.isAsync === true ||
                                    (Array.isArray(sym.modifiers) && sym.modifiers.includes('async'));
                    if (isAsync) asyncFns.push(sym);
                    if (sym.name && (
                        sym.type === 'function' || sym.type === 'method' ||
                        sym.type === 'constructor' || sym.type === 'arrow' ||
                        sym.params != null || sym.paramsStructured != null
                    )) {
                        fileAnyDefNames.add(sym.name);
                        if (isAsync) fileAsyncNames.add(sym.name);
                    }
                }
            }
            if (asyncFns.length === 0) return;

            // Re-parse file to find awaited-vs-not call sites. We use a fresh
            // parse rather than tree cache because we want to walk every
            // call_expression in the async function ranges.
            let parser, content, tree;
            try {
                if (language === 'html') {
                    const htmlModule = getLanguageModule('html');
                    const htmlParser = getParser('html');
                    const jsParser = getParser('javascript');
                    if (!htmlParser || !jsParser) return;
                    content = index._readFile(filePath);
                    const blocks = htmlModule.extractScriptBlocks(content, htmlParser);
                    if (blocks.length === 0) return;
                    const virtualJS = htmlModule.buildVirtualJSContent(content, blocks);
                    tree = safeParse(jsParser, virtualJS);
                } else {
                    parser = getParser(language);
                    if (!parser) return;
                    content = index._readFile(filePath);
                    tree = safeParse(parser, content);
                }
            } catch (_) { return; }
            if (!tree) return;

            // Walk every call_expression within an async function range.
            const callTypes = new Set(['call_expression', 'call', 'method_invocation', 'object_creation_expression']);

            // Function-boundary nodes per language (used to find the nearest
            // enclosing function and determine if IT is async — not just any
            // outer ancestor).
            const FN_NODE_TYPES = {
                javascript: new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'generator_function', 'generator_function_declaration']),
                typescript: new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'generator_function', 'generator_function_declaration', 'function_signature']),
                tsx:        new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'generator_function', 'generator_function_declaration', 'function_signature']),
                html:       new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'generator_function', 'generator_function_declaration']),
                python:     new Set(['function_definition', 'async_function_definition', 'lambda']),
            }[language] || new Set();

            function isAsyncFnNode(node) {
                if (!node) return false;
                // Python: async_function_definition is the explicit marker.
                if (node.type === 'async_function_definition') return true;
                // JS/TS arrow_function / function_expression / function_declaration:
                // the `async` keyword is a child of the node OR appears as
                // first token in node text.
                const t = node.text || '';
                if (t.trimStart().startsWith('async ')) return true;
                // method_definition: scan first child for 'async' identifier.
                for (let i = 0; i < node.namedChildCount; i++) {
                    const c = node.namedChild(i);
                    if (c.type === 'async') return true;
                }
                return false;
            }

            // Find the nearest enclosing function symbol whose name matches
            // a top-level async fn. Returns the symbol when the call's
            // immediate enclosing fn-node is async (so callbacks inside an
            // async fn aren't misclassified as async themselves).
            function nearestAsyncEnclosing(callNode) {
                let cur = callNode.parent;
                while (cur) {
                    if (FN_NODE_TYPES.has(cur.type)) {
                        if (isAsyncFnNode(cur)) {
                            // Match against asyncFns to get caller name.
                            const startLine = cur.startPosition.row + 1;
                            for (const fn of asyncFns) {
                                if (fn.startLine === startLine) return fn;
                            }
                            // Anonymous async fn — return a synthetic record.
                            return {
                                name: '<anonymous>',
                                startLine,
                                endLine: cur.endPosition.row + 1,
                            };
                        }
                        return null; // Inner non-async fn — stop, don't leak into outer scope.
                    }
                    cur = cur.parent;
                }
                return null;
            }

            function visit(node) {
                if (!node) return;
                if (callTypes.has(node.type)) {
                    const line = node.startPosition.row + 1;
                    const enclosing = nearestAsyncEnclosing(node);
                    if (enclosing) {
                        // Get the callee name + skip if not async.
                        const funcNode = node.childForFieldName('function') ||
                                         node.childForFieldName('name');
                        if (funcNode) {
                            let calleeName;
                            let isMethodCall = false;
                            if (funcNode.type === 'member_expression' || funcNode.type === 'attribute' ||
                                funcNode.type === 'selector_expression' || funcNode.type === 'field_expression') {
                                const prop = funcNode.childForFieldName('property') ||
                                             funcNode.childForFieldName('field') ||
                                             funcNode.childForFieldName('attribute');
                                calleeName = prop ? prop.text : null;
                                isMethodCall = true;
                            } else {
                                calleeName = funcNode.text;
                            }
                            if (calleeName) {
                                // Check whether the callee is provably async.
                                // File-local resolution wins (HIGH-1 fix): if
                                // THIS file defines an async function with that
                                // name, the call resolves to it regardless of
                                // what other files contain. This avoids silent
                                // false-negatives caused by name collisions
                                // (e.g., async helper in bad.js + sync helper
                                // in unrelated.js — bad.js's helper() should
                                // still be flagged).
                                let calleeIsAsync;
                                if (fileAsyncNames.has(calleeName)) {
                                    calleeIsAsync = true;
                                } else if (fileAnyDefNames.has(calleeName)) {
                                    // Same-file def exists and isn't async →
                                    // local def shadows globals → not async.
                                    calleeIsAsync = false;
                                } else {
                                    // No same-file def — fall back to global
                                    // all-or-nothing check.
                                    calleeIsAsync = asyncNames.has(calleeName) ||
                                                    _KNOWN_ASYNC_CALLEES.has(calleeName);
                                }
                                if (calleeIsAsync) {
                                    // Skip method calls in structural type
                                    // systems (JS/TS/Python). Without receiver
                                    // type evidence we can't tell `obj.get()`
                                    // calling `Map.get` (sync) from a project
                                    // class's async `get`. Method-call audits
                                    // need a more sophisticated receiver
                                    // resolution that we don't have here.
                                    if (isMethodCall) {
                                        // (Allow only when callee is in the
                                        // KNOWN_ASYNC_CALLEES list — those are
                                        // standard global functions, not
                                        // methods.)
                                        if (!_KNOWN_ASYNC_CALLEES.has(calleeName)) {
                                            // Continue walking — don't flag.
                                        } else {
                                            // Fall through to common flag logic
                                        }
                                    }
                                    if (!isMethodCall || _KNOWN_ASYNC_CALLEES.has(calleeName)) {
                                        // Check: is the call awaited?
                                        let awaited = false;
                                        const p = node.parent;
                                        if (p && (p.type === 'await_expression' || p.type === 'await')) {
                                            awaited = true;
                                        }
                                        if (!awaited && !isFireAndForget(node, language)) {
                                            issues.push({
                                                file: fileEntry.relativePath || filePath,
                                                line,
                                                callerName: enclosing.name,
                                                calleeName,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                for (let i = 0; i < node.namedChildCount; i++) {
                    visit(node.namedChild(i));
                }
            }
            visit(tree.rootNode);
        }

        // Apply file/exclude filters via index.matchesFilters when available.
        const exclude = Array.isArray(options.exclude) ? options.exclude : [];
        const fileFilter = options.file || null;

        for (const [filePath, fileEntry] of index.files) {
            if (exclude.length > 0 && !index.matchesFilters(filePath, { exclude })) continue;
            if (fileFilter && !(fileEntry.relativePath || '').includes(fileFilter)) continue;
            processFile(filePath, fileEntry);
        }

        // Stable ordering (rule #11): sort by (file, line, callerName, calleeName).
        issues.sort((a, b) => {
            const fc = String(a.file).localeCompare(String(b.file));
            if (fc !== 0) return fc;
            if (a.line !== b.line) return a.line - b.line;
            const cc = String(a.callerName || '').localeCompare(String(b.callerName || ''));
            if (cc !== 0) return cc;
            return String(a.calleeName || '').localeCompare(String(b.calleeName || ''));
        });

        return {
            issues,
            totalIssues: issues.length,
            filesAffected: new Set(issues.map(i => i.file)).size,
        };
    } finally { index._endOp(); }
}

module.exports = {
    context,
    smart,
    detectCompleteness,
    related,
    impact,
    about,
    diffImpact,
    parseDiff,
    extractCallableSymbols,
    unquoteDiffPath,
    auditAsync,
    tagInTestCase,
};
