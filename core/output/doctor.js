/**
 * core/output/doctor.js — Project trust report formatter.
 */

'use strict';

function pad(n, width = 4) {
    return String(n).padStart(width);
}

function formatDoctor(result) {
    if (!result) return 'No project to analyze.';
    const lines = [];
    lines.push(`UCN Trust Report — ${result.root}`);
    lines.push('═'.repeat(60));
    if (result.version) lines.push(`Version: ucn ${result.version}`);
    lines.push(`Index: ${result.files.scanned} file${result.files.scanned === 1 ? '' : 's'}, ${result.symbols} symbol${result.symbols === 1 ? '' : 's'}`);

    if (result.filter) lines.push(`Filter: ${result.filter}`);

    // Languages
    const langEntries = Object.entries(result.languages || {}).sort((a, b) => b[1].files - a[1].files);
    if (langEntries.length) {
        const totalFiles = langEntries.reduce((s, [, v]) => s + v.files, 0) || 1;
        const langStr = langEntries.map(([name, v]) => `${name} (${Math.round(v.files / totalFiles * 100)}%)`).join(', ');
        lines.push(`Languages: ${langStr}`);
    }

    // Cache state
    if (result.cache) {
        const state = result.cache.fresh === true ? 'fresh' : result.cache.fresh === false ? 'stale' : 'unknown';
        const buildHint = result.cache.buildMs ? `, ${result.cache.buildMs}ms build` : '';
        lines.push(`Cache: ${state}${buildHint}`);
    }

    // Coverage (if computed)
    if (result.coverage && result.coverage.total > 0) {
        lines.push('');
        lines.push('Resolution coverage (sampled):');
        const c = result.coverage;
        const total = c.total || 1;
        lines.push(`  High confidence (>0.8): ${c.high} (${(c.high / total * 100).toFixed(1)}%)`);
        lines.push(`  Medium (0.5-0.8):       ${c.medium} (${(c.medium / total * 100).toFixed(1)}%)`);
        lines.push(`  Low (<0.5):             ${c.low} (${(c.low / total * 100).toFixed(1)}%)`);
        lines.push(`  Sampled ${c.sampled} symbols → ${c.total} edges examined`);
    } else if (result.coverage) {
        lines.push('');
        lines.push('Resolution coverage: no edges in sample — likely a small or isolated project.');
    } else {
        lines.push('');
        lines.push('Resolution coverage: not computed (use --deep for sampled analysis)');
    }

    // Blind spots
    lines.push('');
    lines.push('Blind spots:');
    const bs = result.blindSpots || {};
    const bsLines = [
        ['Dynamic imports', bs.dynamicImports],
        ['Eval/exec calls', bs.evalCalls],
        ['Reflection',      bs.reflection],
        ['Parse failures',  bs.parseFailures],
    ];
    const unitFor = { 'Dynamic imports': 'import', 'Eval/exec calls': 'use', 'Reflection': 'use', 'Parse failures': 'failure' };
    let anyBlindSpot = false;
    for (const [label, info] of bsLines) {
        if (info && info.count > 0) {
            anyBlindSpot = true;
            // fileCount is the TRUE (uncapped) number of files; info.files is a
            // capped display sample. Show "N use(s) in M file(s)" and, when the
            // sample is truncated, "... and K more file(s)" against the true M —
            // never present the display cap as the population (field-report #2).
            const fileCount = info.fileCount != null ? info.fileCount : info.files.length;
            const unit = unitFor[label] || 'use';
            lines.push(`  ${label}: ${info.count} ${unit}${info.count === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`);
            const shownFiles = info.files.slice(0, 3);
            const sample = shownFiles.map(f => `    - ${f}`).join('\n');
            const moreFiles = fileCount - shownFiles.length;
            const more = moreFiles > 0 ? `\n    ... and ${moreFiles} more file${moreFiles === 1 ? '' : 's'}` : '';
            if (sample) lines.push(sample + more);
        }
    }
    if (!anyBlindSpot) lines.push('  (none detected)');

    // Verdict
    lines.push('');
    lines.push(`Trust level: ${result.trust}${result.trustReason ? ' — ' + result.trustReason : ''}`);
    return lines.join('\n');
}

function formatDoctorJson(result) {
    return JSON.stringify(result, null, 2);
}

module.exports = { formatDoctor, formatDoctorJson };
