/**
 * core/reporting.js — Project statistics and table of contents
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { isTestFile } = require('./discovery');

/**
 * Get project statistics: file counts, symbol counts, LOC, language breakdown.
 *
 * @param {object} index - ProjectIndex instance
 * @param {object} options - { functions }
 * @returns {object}
 */
function getStats(index, options = {}) {
    // Count total symbols (not just unique names)
    let totalSymbols = 0;
    for (const [name, symbols] of index.symbols) {
        totalSymbols += symbols.length;
    }

    const stats = {
        root: index.root,
        files: index.files.size,
        symbols: totalSymbols,  // Total symbol count, not unique names
        buildTime: index.buildTime,
        byLanguage: {},
        byType: {},
        ...(index.truncated && { truncated: index.truncated })
    };

    for (const [filePath, fileEntry] of index.files) {
        const lang = fileEntry.language;
        if (!stats.byLanguage[lang]) {
            stats.byLanguage[lang] = { files: 0, lines: 0, symbols: 0 };
        }
        stats.byLanguage[lang].files++;
        stats.byLanguage[lang].lines += fileEntry.lines;
        stats.byLanguage[lang].symbols += fileEntry.symbols.length;
    }

    for (const [name, symbols] of index.symbols) {
        for (const sym of symbols) {
            if (!Object.hasOwn(stats.byType, sym.type)) {
                stats.byType[sym.type] = 0;
            }
            stats.byType[sym.type]++;
        }
    }

    // Surface build warnings (parse failures, skipped files)
    if (index.failedFiles && index.failedFiles.size > 0) {
        stats.warnings = {
            failedFiles: [...index.failedFiles].map(f => path.relative(index.root, f)),
            count: index.failedFiles.size
        };
    }

    // Per-function line counts for complexity audits
    if (options.functions) {
        const functions = [];
        for (const [name, symbols] of index.symbols) {
            for (const sym of symbols) {
                if (sym.type === 'function' || sym.type === 'method' || sym.type === 'static' ||
                    sym.type === 'constructor' || sym.type === 'public' || sym.type === 'abstract' ||
                    sym.type === 'classmethod') {
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
        let functions = fileEntry.symbols.filter(s =>
            s.type === 'function' || s.type === 'method' || s.type === 'static' ||
            s.type === 'constructor' || s.type === 'public' || s.type === 'abstract' ||
            s.type === 'classmethod'
        );
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
            complete: totalDynamic === 0,
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
 * for this project: resolution coverage, blind spots (dynamic imports, eval,
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
    const { detectLanguage, langTraits } = require('../languages');
    const path = require('path');

    const inFilter = options.in || options.file || null;
    const matchInFilter = (rel) => {
        if (!inFilter) return true;
        return rel.includes(inFilter);
    };

    const fileCounts = { total: 0, scanned: 0 };
    const langs = {};
    let totalSymbols = 0;  // counted post-filter for accuracy when --in is set
    const blindSpots = {
        dynamicImports: { count: 0, files: [] },
        evalCalls:      { count: 0, files: [] },
        reflection:     { count: 0, files: [] },
        parseFailures:  { count: 0, files: [] },
    };

    // Reflection signals per language. These run textually over the source — fast,
    // and acceptable since UCN already records dynamic-import counts at parse time.
    const REFLECTION_PATTERNS = {
        python:     /\b(getattr|hasattr|setattr|__import__|importlib\.import_module)\s*\(/,
        javascript: /\bnew Function\s*\(|\bReflect\.\w+\s*\(/,
        typescript: /\bnew Function\s*\(|\bReflect\.\w+\s*\(/,
        go:         /"reflect"|reflect\.\w+\s*\(/,
        java:       /\.getDeclaredMethod\b|\.getMethod\b|\.getDeclaredField\b|Class\.forName\b/,
        rust:       /\bAny::downcast/,
    };
    const EVAL_PATTERNS = {
        python:     /\b(eval|exec)\s*\(/,
        javascript: /\beval\s*\(/,
        typescript: /\beval\s*\(/,
    };

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

        if (fe.dynamicImports && fe.dynamicImports > 0) {
            blindSpots.dynamicImports.count += fe.dynamicImports;
            if (blindSpots.dynamicImports.files.length < 10) blindSpots.dynamicImports.files.push(rel);
        }
        if (fe.parseError) {
            blindSpots.parseFailures.count++;
            if (blindSpots.parseFailures.files.length < 10) blindSpots.parseFailures.files.push(rel);
        }

        // Read file once for eval/reflection signals
        const evalRe = EVAL_PATTERNS[lang];
        const reflRe = REFLECTION_PATTERNS[lang];
        if (evalRe || reflRe) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                if (evalRe && evalRe.test(content)) {
                    blindSpots.evalCalls.count++;
                    if (blindSpots.evalCalls.files.length < 10) blindSpots.evalCalls.files.push(rel);
                }
                if (reflRe && reflRe.test(content)) {
                    blindSpots.reflection.count++;
                    if (blindSpots.reflection.files.length < 10) blindSpots.reflection.files.push(rel);
                }
            } catch (e) { /* ignore read errors */ }
        }
    }

    // Resolution coverage — sampled by default to keep doctor fast.
    let coverage = null;
    if (options.deep || options.sampleSize) {
        coverage = computeCoverageSample(index, {
            sampleSize: options.sampleSize || 200,
            inFilter,
            matchInFilter,
        });
    }

    // Cache info
    let cache = { fresh: null };
    try {
        cache.fresh = !index.isCacheStale();
        cache.buildMs = index.buildTime || null;
    } catch (e) { /* ignore */ }

    // Compute trust verdict.
    //
    // 1. If a deep sample produced no edges (empty project, --in matches nothing),
    //    don't pretend that's "0% confident" — return UNKNOWN.
    // 2. Coverage gives the headline %, but blind spots (eval/reflection/dynamic
    //    imports) downgrade the verdict by one tier each — a project that resolves
    //    99% of edges but is full of `getattr` is not actually "HIGH" trust.
    // 3. Parse failures always cap at MEDIUM regardless of coverage.
    let trust = 'UNKNOWN';
    let trustReason = '';
    const reasons = [];

    if (coverage && coverage.total > 0) {
        const safe = coverage.high + coverage.medium;
        const safePct = safe / coverage.total;
        let baseLevel;
        if (safePct >= 0.85) baseLevel = 'HIGH';
        else if (safePct >= 0.6) baseLevel = 'MEDIUM';
        else baseLevel = 'LOW';
        reasons.push(`${(safePct * 100).toFixed(1)}% of edges have confidence ≥ 0.5`);

        // Blind-spot downgrades — each kind drops one tier.
        const tier = ['HIGH', 'MEDIUM', 'LOW'];
        let idx = tier.indexOf(baseLevel);
        const blindSignals = [];
        if (blindSpots.parseFailures.count > 0) { idx = Math.max(idx, 1); blindSignals.push(`${blindSpots.parseFailures.count} parse failure(s)`); }
        if (blindSpots.evalCalls.count > 0) { idx = Math.min(2, idx + 1); blindSignals.push(`${blindSpots.evalCalls.count} eval call(s)`); }
        if (blindSpots.reflection.count > 0) { idx = Math.min(2, idx + 1); blindSignals.push(`${blindSpots.reflection.count} reflection use(s)`); }
        if (blindSpots.dynamicImports.count > 0) { idx = Math.min(2, idx + 1); blindSignals.push(`${blindSpots.dynamicImports.count} dynamic import(s)`); }
        trust = tier[idx];
        if (blindSignals.length) reasons.push(`blind spots: ${blindSignals.join(', ')}`);
        trustReason = reasons.join('; ');
    } else if (coverage) {
        // Sampled but zero edges — can't say anything about confidence.
        trust = 'UNKNOWN';
        trustReason = 'no edges sampled (empty scope or filter matched nothing)';
    } else if (fileCounts.scanned > 0) {
        // Cheap path (no --deep): use blind-spot signals.
        const tier = ['HIGH', 'MEDIUM', 'LOW'];
        let idx = 0;
        const blindSignals = [];
        if (blindSpots.parseFailures.count > 0) { idx = Math.max(idx, 1); blindSignals.push(`${blindSpots.parseFailures.count} parse failure(s)`); }
        if (blindSpots.evalCalls.count > 0) { idx = Math.min(2, idx + 1); blindSignals.push(`${blindSpots.evalCalls.count} eval call(s)`); }
        if (blindSpots.reflection.count > 0) { idx = Math.min(2, idx + 1); blindSignals.push(`${blindSpots.reflection.count} reflection use(s)`); }
        if (blindSpots.dynamicImports.count > 0) { idx = Math.min(2, idx + 1); blindSignals.push(`${blindSpots.dynamicImports.count} dynamic import(s)`); }
        trust = tier[idx];
        trustReason = blindSignals.length
            ? `coverage not deep-checked; blind spots: ${blindSignals.join(', ')}`
            : 'no parse failures; coverage not deep-checked';
    }

    return {
        root: index.root,
        files: fileCounts,
        symbols: totalSymbols,
        languages: langs,
        blindSpots,
        coverage,
        cache,
        trust,
        trustReason,
        ...(inFilter && { filter: inFilter }),
    };
}

/**
 * Sample-based coverage: pick up to N symbols, run findCallers, bucket confidence.
 * Doesn't pretend to be exhaustive — meant for a fast trust signal, not an audit.
 */
function computeCoverageSample(index, { sampleSize, inFilter, matchInFilter }) {
    const buckets = { high: 0, medium: 0, low: 0, total: 0, sampled: 0 };
    const symbolNames = [];
    for (const [name, arr] of index.symbols) {
        for (const sym of arr) {
            if (!sym || !sym.relativePath) continue;
            if (!matchInFilter(sym.relativePath)) continue;
            if (sym.type === 'method' || sym.type === 'function' || sym.type === 'constructor') {
                symbolNames.push(name);
                if (symbolNames.length >= sampleSize * 2) break; // cap collection cost
            }
        }
        if (symbolNames.length >= sampleSize * 2) break;
    }
    // Take a slice (not random — deterministic for tests)
    const slice = symbolNames.slice(0, sampleSize);
    buckets.sampled = slice.length;

    for (const name of slice) {
        const callers = index.findCallers(name, { includeMethods: true, includeUncertain: true });
        for (const c of callers) {
            const conf = (c.confidence != null) ? c.confidence : 1;
            buckets.total++;
            if (conf > 0.8) buckets.high++;
            else if (conf >= 0.5) buckets.medium++;
            else buckets.low++;
        }
    }
    return buckets;
}

module.exports = { getStats, getToc, doctor };
