/**
 * core/output/reporting.js - Stats/TOC/deadcode/entrypoints formatters
 */

const {
    lineRange,
    dynamicImportsNote,
    formatFunctionSignature,
    formatClassSignature,
} = require('./shared');

/**
 * Format toc command output
 * @param {object} toc - TOC data
 * @param {object} [options] - Formatting options
 * @param {string} [options.detailedHint] - Custom hint text for non-detailed mode
 * @param {string} [options.uncertainHint] - Custom hint text for uncertain references
 */
function formatToc(toc, options = {}) {
    const lines = [];
    const t = toc.totals;
    lines.push(`PROJECT: ${t.files} files, ${t.lines} lines`);
    lines.push(`  ${t.functions} functions, ${t.classes} types (classes/interfaces/enums), ${t.state} state objects`);

    const meta = toc.meta || {};
    if (meta.filteredBy) {
        lines.push(`  Filtered by: --file=${meta.filteredBy} (${meta.matchedFiles} files matched)`);
        if (meta.emptyFiles) {
            lines.push(`  Note: ${meta.emptyFiles} file(s) have no detected symbols (may be generated or data files)`);
        }
    }
    const warnings = [];
    if (meta.dynamicImports) { const dn = dynamicImportsNote(meta.dynamicImports, meta); if (dn) warnings.push(dn); }
    if (meta.uncertain) warnings.push(`${meta.uncertain} uncertain reference(s)`);
    if (warnings.length) {
        const uncertainSuffix = meta.uncertain && options.uncertainHint ? ` — ${options.uncertainHint}` : '';
        lines.push(`  Note: ${warnings.join(', ')}${uncertainSuffix}`);
    }

    if (toc.summary) {
        if (toc.summary.topFunctionFiles?.length) {
            const hint = toc.summary.topFunctionFiles.map(f => `${f.file} (${f.functions})`).join(', ');
            lines.push(`  Most functions: ${hint}`);
        }
        if (toc.summary.topLineFiles?.length) {
            const hint = toc.summary.topLineFiles.map(f => `${f.file} (${f.lines})`).join(', ');
            lines.push(`  Largest files: ${hint}`);
        }
        if (toc.summary.entryFiles?.length) {
            lines.push(`  Entry points: ${toc.summary.entryFiles.join(', ')}`);
        }
    }

    lines.push('═'.repeat(60));
    const hasDetail = toc.files.some(f => f.symbols);
    for (const file of toc.files) {
        const parts = [`${file.lines} lines`];
        if (file.functions) parts.push(`${file.functions} fn`);
        if (file.classes) parts.push(`${file.classes} types`);
        if (file.state) parts.push(`${file.state} state`);

        if (hasDetail) {
            lines.push(`\n${file.file} (${parts.join(', ')})`);
            if (file.symbols) {
                for (const fn of file.symbols.functions) {
                    lines.push(`  ${lineRange(fn.startLine, fn.endLine)} ${formatFunctionSignature(fn)}`);
                }
                for (const cls of file.symbols.classes) {
                    lines.push(`  ${lineRange(cls.startLine, cls.endLine)} ${formatClassSignature(cls)}`);
                }
            }
        } else {
            lines.push(`  ${file.file} — ${parts.join(', ')}`);
        }
    }

    if (!hasDetail) {
        const hint = options.detailedHint || 'Use detailed=true to list all functions and classes.';
        lines.push(`\n${hint}`);
    }

    if (toc.hiddenFiles > 0) {
        const topHint = options.topHint || 'Use --top=N or --all to show more.';
        lines.push(`\n... and ${toc.hiddenFiles} more files. ${topHint}`);
    }

    return lines.join('\n');
}

/**
 * Format TOC data as JSON
 */
function formatTocJson(data) {
    const obj = {
        meta: data.meta || { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0 },
        totals: data.totals,
        summary: data.summary,
        files: data.files
    };
    if (data.hiddenFiles > 0) obj.hiddenFiles = data.hiddenFiles;
    return JSON.stringify(obj);
}

/**
 * Format stats command output
 */
function formatStats(stats, options = {}) {
    const lines = [];
    lines.push('PROJECT STATISTICS');
    lines.push('═'.repeat(60));
    lines.push(`Root: ${stats.root}`);
    if (stats.truncated) {
        lines.push(`Files: ${stats.files} (truncated at ${stats.truncated.maxFiles} — use --max-files to increase)`);
    } else {
        lines.push(`Files: ${stats.files}`);
    }
    lines.push(`Symbols: ${stats.symbols}`);
    lines.push(`Build time: ${stats.buildTime}ms`);

    lines.push('\nBy Language:');
    for (const [lang, info] of Object.entries(stats.byLanguage)) {
        lines.push(`  ${lang}: ${info.files} files, ${info.lines} lines, ${info.symbols} symbols`);
    }

    lines.push('\nBy Type:');
    for (const [type, count] of Object.entries(stats.byType)) {
        lines.push(`  ${type}: ${count}`);
    }

    if (stats.warnings) {
        lines.push(`\nWarnings: ${stats.warnings.count} file(s) failed to parse:`);
        for (const f of stats.warnings.failedFiles.slice(0, 10)) {
            lines.push(`  ${f}`);
        }
        if (stats.warnings.count > 10) {
            lines.push(`  ... and ${stats.warnings.count - 10} more`);
        }
    }

    if (stats.functions) {
        const top = options.top || 30;
        const shown = stats.functions.slice(0, top);
        lines.push(`\nFunctions by line count (top ${shown.length} of ${stats.functions.length}):`);
        for (const fn of shown) {
            const loc = `${fn.file}:${fn.startLine}`;
            lines.push(`  ${String(fn.lines).padStart(5)} lines  ${fn.name}  (${loc})`);
        }
        if (stats.functions.length > top) {
            lines.push(`  ... ${stats.functions.length - top} more (use --top=N to show more)`);
        }
    }

    if (stats.hot) {
        const items = stats.hot.items || [];
        const total = stats.hot.total || items.length;
        lines.push(`\nHottest functions (top ${items.length} of ${total} called):`);
        if (items.length === 0) {
            lines.push('  (no inbound calls detected)');
        } else {
            for (const fn of items) {
                const loc = `${fn.file}:${fn.startLine}`;
                lines.push(`  ${String(fn.callCount).padStart(5)} calls  ${fn.name}  (${loc})`);
                // MEDIUM-6: when the same name has multiple definitions across
                // files (e.g. test helpers vs. test fixtures both named `tmp`),
                // list the additional locations indented so the user knows
                // the count covers ambiguous resolution.
                if (Array.isArray(fn.locations) && fn.locations.length > 1) {
                    for (let i = 1; i < fn.locations.length; i++) {
                        const l = fn.locations[i];
                        lines.push(`         ↳ also defined at ${l.file}:${l.startLine}`);
                    }
                }
            }
            if (total > items.length) {
                lines.push(`  ... ${total - items.length} more (use --top=N to show more)`);
            }
        }
    }

    return lines.join('\n');
}

/**
 * Format project stats as JSON
 */
function formatStatsJson(stats) {
    return JSON.stringify(stats, null, 2);
}

/**
 * Format deadcode command output
 * @param {Array} results - Dead code results
 * @param {object} [options] - Formatting options
 * @param {string} [options.exportedHint] - Hint about exported symbols exclusion
 */
function formatDeadcode(results, options = {}) {
    if (results.length === 0 && !results.excludedDecorated && !results.excludedExported && !results.excludedExternalContract) {
        return 'No dead code found.';
    }

    const lines = [];
    const top = options.top > 0 ? options.top : 0;
    const showing = top > 0 ? results.slice(0, top) : results;
    const hidden = results.length - showing.length;

    if (results.length > 0) {
        if (hidden > 0) {
            lines.push(`Dead code: ${results.length} unused symbol(s) (showing ${showing.length})\n`);
        } else {
            lines.push(`Dead code: ${results.length} unused symbol(s)\n`);
        }
    }

    let currentFile = null;
    for (const item of showing) {
        if (item.file !== currentFile) {
            currentFile = item.file;
            lines.push(item.file);
        }
        const exported = item.isExported ? ' [exported]' : '';
        // Surface decorators/annotations — structural hint that a framework may invoke this
        const hints = [];
        if (item.decorators && item.decorators.length > 0) {
            hints.push(...item.decorators.map(d => `@${d}`));
        }
        if (item.annotations && item.annotations.length > 0) {
            hints.push(...item.annotations.map(a => `@${a}`));
        }
        const hintStr = hints.length > 0 ? ` [has ${hints.join(', ')}]` : '';
        // Interface/trait member declarations: unreferenced is true, but
        // deleting one changes the contract, not dead logic — say so.
        const declStr = item.declaredOn
            ? ` [declared on ${item.declaredOn.kind} ${item.declaredOn.name} — contract surface, not executable code]`
            : '';
        // Revealed under --include-exported: mark as external-reachable, not dead.
        const extStr = item.externalContract
            ? ' [reachable via out-of-tree base — external contract, not dead]'
            : '';
        // The only references are the symbol's own recursion (fix #253c).
        const recStr = item.selfRecursive ? ' [only self-references — recursive]' : '';
        const displayName = item.className ? `${item.className}.${item.name}` : item.name;
        lines.push(`  ${lineRange(item.startLine, item.endLine)} ${displayName} (${item.type})${exported}${hintStr}${declStr}${extStr}${recStr}`);
    }

    if (hidden > 0) {
        lines.push(`\n${hidden} more result(s) not shown. Use --top=${results.length} or --all to see all.`);
    }

    // Show counts of excluded items with expansion hints
    if (results.length === 0) {
        lines.push('No dead code found.');
    }
    if (results.excludedDecorated > 0) {
        const decoratedHint = options.decoratedHint || `${results.excludedDecorated} decorated/annotated symbol(s) hidden (framework-registered). Use --include-decorated to include them.`;
        lines.push(`\n${decoratedHint}`);
    }
    if (results.excludedExported > 0) {
        const exportedHint = options.exportedHint || `${results.excludedExported} exported symbol(s) excluded from the audit (public API may have external callers). Use --include-exported to audit them.`;
        lines.push(`\n${exportedHint}`);
    }
    if (results.excludedExternalContract > 0) {
        const extHint = options.externalContractHint || `${results.excludedExternalContract} symbol(s) hidden (override an out-of-tree base class — reachable via external contract, not dead). Use --include-exported to include them.`;
        lines.push(`\n${extHint}`);
    }

    if (lines.length === 0) {
        return 'No dead code found.';
    }

    return lines.join('\n');
}

/**
 * Format deadcode command output - JSON
 */
function formatDeadcodeJson(results) {
    const { formatSymbolHandle } = require('../shared');
    // Under --limit the handler slices the array and attaches the full-set
    // size (fix #242) — the payload itself must say it is truncated.
    const li = results.limitInfo;
    return JSON.stringify({
        meta: {
            command: 'deadcode',
            count: results.length,
            ...(li && { total: li.total, truncated: true }),
        },
        data: {
            count: results.length,
            ...(li && { total: li.total, truncated: true }),
            ...(results.excludedExported > 0 && { excludedExported: results.excludedExported }),
            ...(results.excludedDecorated > 0 && { excludedDecorated: results.excludedDecorated }),
            ...(results.excludedExternalContract > 0 && { excludedExternalContract: results.excludedExternalContract }),
            symbols: results.map(item => {
                const handleSym = { ...item, relativePath: item.relativePath || item.file };
                const handle = formatSymbolHandle(handleSym);
                return {
                    name: item.name,
                    type: item.type,
                    file: item.file,
                    startLine: item.startLine,
                    endLine: item.endLine,
                    ...(item.className && { className: item.className }),
                    ...(handle && { handle }),
                    ...(item.isExported && { isExported: true }),
                    ...(item.decorators && item.decorators.length > 0 && { decorators: item.decorators }),
                    ...(item.annotations && item.annotations.length > 0 && { annotations: item.annotations }),
                    ...(item.declaredOn && { declaredOn: item.declaredOn }),
                    ...(item.externalContract && { externalContract: true }),
                    ...(item.selfRecursive && { selfRecursive: true })
                };
            }),
        },
    }, null, 2);
}

/**
 * Format entrypoints command output (text)
 */
function formatEntrypoints(results, options = {}) {
    if (!results || results.length === 0) {
        return 'No framework entry points detected.';
    }

    const lines = [];
    lines.push(`Framework Entry Points: ${results.length} detected\n`);

    // Group by type
    const byType = new Map();
    for (const ep of results) {
        if (!byType.has(ep.type)) byType.set(ep.type, []);
        byType.get(ep.type).push(ep);
    }

    const typeLabels = {
        http: 'HTTP Routes',
        cli: 'CLI Handlers',
        di: 'Dependency Injection',
        jobs: 'Job Schedulers',
        test: 'Test Fixtures',
        runtime: 'Runtime Entry Points',
        ui: 'UI Handlers',
        events: 'Event Handlers',
    };

    let itemNum = 0;
    for (const [type, entries] of byType) {
        const label = typeLabels[type] || type;
        lines.push(`${label} (${entries.length}):`);

        let currentFile = null;
        for (const ep of entries) {
            if (ep.file !== currentFile) {
                currentFile = ep.file;
                lines.push(`  ${ep.file}`);
            }
            itemNum++;
            const evidence = ep.evidence.join(', ');
            lines.push(`    [${itemNum}] ${ep.name} (${ep.framework}) — ${evidence}${' '.repeat(Math.max(0, 40 - ep.name.length - ep.framework.length - evidence.length))}:${ep.line}`);
        }
        lines.push('');
    }

    return lines.join('\n').trimEnd();
}

/**
 * Format entrypoints command output (JSON)
 */
function formatEntrypointsJson(results) {
    // Under --limit the handler slices the array and attaches the full-set
    // size (fix #247, the deadcode #242 shape) — meta.total must describe
    // the FULL set, with `truncated` saying the list below is a prefix.
    const li = results.limitInfo;
    return JSON.stringify({
        meta: {
            count: results.length,
            total: li ? li.total : results.length,
            ...(li && { truncated: true }),
        },
        data: {
            entrypoints: results.map(ep => {
                const handle = ep.line && ep.name ? `${ep.file}:${ep.line}:${ep.name}` : null;
                return {
                    name: ep.name,
                    file: ep.file,
                    line: ep.line,
                    ...(handle && { handle }),
                    type: ep.type,
                    framework: ep.framework,
                    patternId: ep.patternId,
                    evidence: ep.evidence,
                    ...(ep.registeredAt && { registeredAt: ep.registeredAt }),
                    confidence: ep.confidence,
                };
            }),
        }
    }, null, 2);
}

/**
 * formatOrient — one-screen cold-repo orientation.
 */
function formatOrient(result) {
    const lines = [];
    lines.push(`PROJECT ORIENTATION — ${result.root}`);
    lines.push('═'.repeat(60));

    // Size + language mix (percent by symbols, largest first)
    const langs = Object.entries(result.byLanguage || {})
        .map(([lang, v]) => ({ lang, symbols: v.symbols || 0 }))
        .sort((a, b) => b.symbols - a.symbols || (a.lang < b.lang ? -1 : a.lang > b.lang ? 1 : 0));
    const totalSym = result.symbols || 1;
    const langStr = langs
        .map(l => `${l.lang} ${Math.round((l.symbols / totalSym) * 100)}%`)
        .join(', ');
    lines.push(`${result.files} files · ${result.symbols} symbols · ${langStr}`);
    lines.push('');

    if (result.dirs?.length) {
        lines.push('TOP DIRS (by symbols):');
        const width = Math.max(...result.dirs.map(d => d.dir.length));
        for (const d of result.dirs) {
            lines.push(`  ${d.dir.padEnd(width)}  ${d.symbols} symbols · ${d.files} file(s)`);
        }
        lines.push('');
    }

    if (result.hot?.items?.length) {
        const scope = result.hot.production ? 'production functions' : 'functions';
        lines.push(`HOT (most-called ${scope}, top ${result.hot.items.length} of ${result.hot.total}):`);
        for (const h of result.hot.items) {
            const label = h.className ? `${h.className}.${h.name}` : h.name;
            lines.push(`  ${label} — ${h.callCount} call(s) · ${h.file}:${h.line}`);
        }
        lines.push('');
    }

    if (result.entrypoints) {
        const byType = result.entrypoints.byType
            .map(t => `${t.type} ${t.count}`).join(', ');
        lines.push(`ENTRY POINTS: ${result.entrypoints.total} — ${byType}`);
    } else {
        lines.push('ENTRY POINTS: (detection unavailable)');
    }

    const bs = result.trust?.blindSpots || {};
    const bsParts = [];
    if (bs.dynamicImports) bsParts.push(`${bs.dynamicImports} dynamic import(s)`);
    if (bs.evalCalls) bsParts.push(`${bs.evalCalls} eval`);
    if (bs.reflection) bsParts.push(`${bs.reflection} reflection`);
    if (bs.parseFailures) bsParts.push(`${bs.parseFailures} parse failure(s)`);
    lines.push(`TRUST: ${result.trust?.level || 'UNKNOWN'}${bsParts.length ? ' — ' + bsParts.join(', ') : ''}  (ucn doctor for detail)`);
    lines.push('');

    const next = [];
    if (result.suggest) next.push(`ucn about ${result.suggest}`);
    next.push('ucn toc --detailed', 'ucn stats --hot --top=20', 'ucn doctor --deep');
    lines.push(`Next: ${next.join(' · ')}`);

    return lines.join('\n');
}

function formatOrientJson(result) {
    return JSON.stringify({
        meta: {
            command: 'orient',
            files: result.files,
            symbols: result.symbols,
            trust: result.trust?.level ?? null,
        },
        data: result,
    }, null, 2);
}

module.exports = {
    formatToc,
    formatTocJson,
    formatOrient,
    formatOrientJson,
    formatStats,
    formatStatsJson,
    formatDeadcode,
    formatDeadcodeJson,
    formatEntrypoints,
    formatEntrypointsJson,
};
