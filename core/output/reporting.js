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
    if (results.length === 0 && !results.excludedDecorated && !results.excludedExported) {
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
        lines.push(`  ${lineRange(item.startLine, item.endLine)} ${item.name} (${item.type})${exported}${hintStr}`);
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
        const exportedHint = options.exportedHint || `${results.excludedExported} exported symbol(s) excluded (all have callers). Use --include-exported to audit them.`;
        lines.push(`\n${exportedHint}`);
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
    return JSON.stringify({
        count: results.length,
        ...(results.excludedExported > 0 && { excludedExported: results.excludedExported }),
        ...(results.excludedDecorated > 0 && { excludedDecorated: results.excludedDecorated }),
        symbols: results.map(item => ({
            name: item.name,
            type: item.type,
            file: item.file,
            startLine: item.startLine,
            endLine: item.endLine,
            ...(item.isExported && { isExported: true }),
            ...(item.decorators && item.decorators.length > 0 && { decorators: item.decorators }),
            ...(item.annotations && item.annotations.length > 0 && { annotations: item.annotations })
        }))
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
    return JSON.stringify({
        meta: { total: results.length },
        data: {
            entrypoints: results.map(ep => ({
                name: ep.name,
                file: ep.file,
                line: ep.line,
                type: ep.type,
                framework: ep.framework,
                patternId: ep.patternId,
                evidence: ep.evidence,
                confidence: ep.confidence,
            }))
        }
    }, null, 2);
}

module.exports = {
    formatToc,
    formatTocJson,
    formatStats,
    formatStatsJson,
    formatDeadcode,
    formatDeadcodeJson,
    formatEntrypoints,
    formatEntrypointsJson,
};
