/**
 * core/output/doctor.js — Project trust report formatter.
 */

'use strict';

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
    if (result.commandTrust) {
        const c = result.commandTrust;
        lines.push(`Command proofs: ${c.classified}/${c.commands} classified, ${c.oracleBacked} external-oracle-backed, ${c.unclassified} unclassified`);
        lines.push('  Classification describes shipped proof coverage, not this repository\'s runtime accuracy.');
    }

    // Evidence profile (if computed). Confidence scores are rule labels, not
    // empirically calibrated probabilities, so never call this accuracy.
    const profile = result.evidenceProfile || result.coverage;
    if (profile && profile.total > 0) {
        lines.push('');
        lines.push('Resolution evidence profile (sampled; not semantic accuracy):');
        const c = profile;
        const total = c.total || 1;
        lines.push(`  Confirmed evidence: ${c.confirmed} (${(c.confirmed / total * 100).toFixed(1)}%)`);
        lines.push(`  Unverified:         ${c.unverified} (${(c.unverified / total * 100).toFixed(1)}%)`);
        lines.push(`  Score bands: high ${c.high}, medium ${c.medium}, low ${c.low}`);
        lines.push(`  Sampled ${c.sampled}/${c.candidateSymbols} pinned definitions → ${c.total} unique edge candidates`);
        lines.push(`  Sample quality: ${c.adequate ? 'adequate' : 'insufficient'}${c.representative ? ', all indexed languages represented' : ''}`);
    } else if (profile) {
        lines.push('');
        lines.push('Resolution evidence profile: no caller edges in the stratified sample.');
    } else {
        lines.push('');
        lines.push('Resolution evidence profile: not computed (use --deep)');
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
        ['Parser recovery', bs.parseRecoveries],
    ];
    const unitFor = {
        'Dynamic imports': 'import', 'Eval/exec calls': 'use', Reflection: 'use',
        'Parse failures': 'failure',
    };
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
            if (label === 'Parser recovery') {
                lines.push(`  ${label}: ${fileCount} recovered file${fileCount === 1 ? '' : 's'} (results may be partial)`);
            } else {
                lines.push(`  ${label}: ${info.count} ${unit}${info.count === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`);
            }
            const shownFiles = info.files.slice(0, 3);
            const sample = shownFiles.map(f => `    - ${f}`).join('\n');
            const moreFiles = fileCount - shownFiles.length;
            const more = moreFiles > 0 ? `\n    ... and ${moreFiles} more file${moreFiles === 1 ? '' : 's'}` : '';
            if (sample) lines.push(sample + more);
        }
    }
    if (!anyBlindSpot) lines.push('  (none detected)');

    // Task-specific readiness. One scalar cannot honestly describe navigation,
    // refactoring, and deletion risk.
    lines.push('');
    if (result.dimensions) {
        lines.push('Readiness:');
        for (const key of ['navigation', 'refactor', 'deletion']) {
            const d = result.dimensions[key];
            if (d) lines.push(`  ${key}: ${d.level} — ${d.reason}`);
        }
        lines.push(`  semantic recall: ${result.dimensions.semanticRecall.level} — ${result.dimensions.semanticRecall.reason}`);
    }
    lines.push(`Overall (${result.trustScope || 'legacy'}): ${result.trust}${result.trustReason ? ' — ' + result.trustReason : ''}`);
    return lines.join('\n');
}

function formatDoctorJson(result) {
    return JSON.stringify(result, null, 2);
}

module.exports = { formatDoctor, formatDoctorJson };
