/**
 * core/output/doctor.js — Project trust report formatter.
 */

'use strict';

const { langTraits } = require('../../languages');

function formatDoctor(result, options = {}) {
    if (!result) return 'No project to analyze.';
    const lines = [];
    lines.push(`UCN Trust Report — ${result.root}`);
    lines.push('═'.repeat(60));
    if (result.version) lines.push(`Version: ucn ${result.version}`);
    lines.push(`Index: ${result.files.scanned} file${result.files.scanned === 1 ? '' : 's'}, ${result.symbols} symbol${result.symbols === 1 ? '' : 's'}`);

    if (result.filter) {
        const parts = [];
        if (result.filter.file) parts.push(`file=${result.filter.file}`);
        if (result.filter.in) parts.push(`in=${result.filter.in}`);
        if (result.filter.exclude?.length) parts.push(`exclude=${result.filter.exclude.join(',')}`);
        if (parts.length > 0) lines.push(`Filter: ${parts.join(' · ')}`);
    }

    // Languages
    const langEntries = Object.entries(result.languages || {}).sort((a, b) => b[1].files - a[1].files);
    if (langEntries.length) {
        const totalFiles = langEntries.reduce((s, [, v]) => s + v.files, 0) || 1;
        const langStr = langEntries.map(([name, v]) => `${name} (${Math.round(v.files / totalFiles * 100)}%)`).join(', ');
        lines.push(`Languages (by indexed files): ${langStr}`);
    }

    // Cache state
    if (result.cache) {
        const state = result.cache.fresh === true ? 'fresh' : result.cache.fresh === false ? 'stale' : 'unknown';
        const buildHint = result.cache.buildMs ? `, ${result.cache.buildMs}ms last index build (excludes cache I/O and query execution)` : '';
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
        lines.push(`Resolution evidence profile: not computed (${options.deepHint || 'use --deep'})`);
    }

    // Blind spots
    lines.push('');
    lines.push('Blind spots:');
    const bs = result.blindSpots || {};
    const staticSpecialImports = result.projectLanguage &&
        !langTraits(result.projectLanguage)?.hasDynamicImports;
    const importLabel = staticSpecialImports
        ? (result.projectLanguage === 'rust' ? 'Glob imports' : 'Blank/dot imports')
        : 'Dynamic imports';
    const bsLines = [
        [importLabel, bs.dynamicImports],
        ['Eval/exec calls', bs.evalCalls],
        ['Reflection',      bs.reflection],
        ['Computed dispatch', bs.computedDispatch],
        ['Token-pasting macro dispatch', bs.macroPasteDispatch],
        ['Unexpanded macro_rules! invocations', bs.macroRulesExpansion],
        ['Parse failures',  bs.parseFailures],
        ['Parser recovery', bs.parseRecoveries],
        ['Unsupported source', bs.unsupportedSources],
        ['Skipped source', bs.skippedSources],
    ];
    const unitFor = {
        'Dynamic imports': 'import', 'Blank/dot imports': 'import',
        'Glob imports': 'import', 'Eval/exec calls': 'use', Reflection: 'use',
        'Computed dispatch': 'call',
        'Token-pasting macro dispatch': 'invocation',
        'Unexpanded macro_rules! invocations': 'invocation',
        'Parse failures': 'failure',
        'Unsupported source': 'file',
        'Skipped source': 'path',
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
            } else if (label === 'Unsupported source') {
                const languages = Object.entries(info.languages || {})
                    .map(([language, count]) => `${language} ${count}`)
                    .join(', ');
                lines.push(`  ${label}: ${fileCount} file${fileCount === 1 ? '' : 's'} skipped${languages ? ` (${languages})` : ''}`);
                lines.push('    Handoff: use grep/ripgrep and a language-native analyzer for these files.');
            } else if (label === 'Skipped source') {
                const reasons = Object.entries(info.reasons || {})
                    .map(([reason, count]) => `${reason} ${count}`).join(', ');
                lines.push(`  ${label}: ${fileCount} path${fileCount === 1 ? '' : 's'} not indexed${reasons ? ` (${reasons})` : ''}`);
                const unsearchable = info.unsearchable || 0;
                if (unsearchable > 0) {
                    lines.push(`    ${unsearchable} could not be searched: no caller account is complete until ` +
                        'they can be read (fix the path, raise the limit, or declare it in .ucn.json outsideProject).');
                }
                if (fileCount > unsearchable) {
                    lines.push(`    ${unsearchable > 0 ? 'The rest is searched' : 'Searched'} as text for each name: ` +
                        'an occurrence there is listed, not analyzed.');
                }
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

    // What a completeness claim ranges over and what it never means: said
    // here once, so an answer only carries its own state.
    lines.push('');
    lines.push('Contract scope:');
    const scope = result.scope;
    if (scope) {
        const list = reasons => Object.entries(reasons || {})
            .map(([reason, count]) => `${reason} ${count}`).join(', ');
        lines.push(`  Indexed source, plus ${scope.textOnly.count} file${scope.textOnly.count === 1 ? '' : 's'} ` +
            `searched as text for each name${scope.textOnly.count > 0 ? ` (${list(scope.textOnly.reasons)})` : ''}.`);
        if (scope.opaque.count > 0) {
            lines.push(`  Not searchable: ${scope.opaque.count} path${scope.opaque.count === 1 ? '' : 's'} ` +
                `(${list(scope.opaque.reasons)}); every caller account is degraded until they are.`);
        }
        if (scope.outside.count > 0) {
            const sample = scope.outside.sample.slice(0, 3).map(entry => entry.path).join(', ');
            lines.push(`  Outside the project: ${scope.outside.count} path${scope.outside.count === 1 ? '' : 's'} ` +
                `(${list(scope.outside.reasons)}), no part of any claim: ${sample}` +
                `${scope.outside.count > 3 ? ', ...' : ''}`);
        }
    }
    lines.push('  CONTRACT text-complete: every literal-name line in that scope was classified.');
    lines.push('  It is never semantic completeness (aliases, indirect calls, generated code and');
    lines.push('  runtime dispatch may exist), and a zero is never deletion proof.');

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
