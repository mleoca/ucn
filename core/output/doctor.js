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
    let anyBlindSpot = false;
    for (const [label, info] of bsLines) {
        if (info && info.count > 0) {
            anyBlindSpot = true;
            const sample = info.files.slice(0, 3).map(f => `    - ${f}`).join('\n');
            const more = info.files.length > 3 ? `\n    ... and ${info.files.length - 3} more` : '';
            lines.push(`  ${label}: ${info.count} in ${info.files.length} file${info.files.length === 1 ? '' : 's'}`);
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
