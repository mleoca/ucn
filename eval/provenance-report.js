'use strict';

const { codeUnitCompare } = require('../core/shared');
const { TYPE_SOURCE_RULES } = require('../core/provenance');

const CONFIRMATION_RULES = [...Object.values(TYPE_SOURCE_RULES),
    'binding', 'import-chain', 'import-supported', 'same-class', 'extension-method',
    'module-owned', 'receiver-binding', 'same-package', 'single-owner'];

// Intentionally separate from the evaluator's line-based placement identity.
function occurrenceKey(edge) {
    const site = edge.provenance?.facts?.site || {};
    return JSON.stringify([edge.file, edge.line, edge.column ?? site.column ?? null,
        site.start ?? null, site.end ?? null, edge.target,
        edge.provenance?.rule || 'unattributed']);
}

function dedupeOccurrences(edges) {
    return [...new Map(edges.map(edge => [occurrenceKey(edge), edge])).values()];
}

function addRuleStat(stats, rule, verdict, provenance) {
    const row = stats[rule || 'unattributed'] ||= { candidates: 0, hits: 0, unscored: 0 };
    row.candidates++;
    if (!verdict.scorable) row.unscored++;
    else if (verdict.hit) row.hits++;
    if (provenance) {
        const validation = provenance.validation || 'unreported';
        row.validation ||= {};
        row.validation[validation] = (row.validation[validation] || 0) + 1;
    }
}

function finishRuleStats(stats) {
    return Object.fromEntries(Object.entries(stats).sort(([a], [b]) => codeUnitCompare(a, b))
        .map(([rule, row]) => {
            const scored = row.candidates - row.unscored;
            return [rule, { ...row, scored, falseCandidates: scored - row.hits,
                precision: scored ? row.hits / scored : null, lowSample: scored < 30 }];
        }));
}

function ruleTable(results, field = 'confirmedRules', heading = 'Confirmed tier') {
    const languages = [...new Set(results.map(r => r.summary.language).filter(Boolean))].sort(codeUnitCompare);
    const rules = [...new Set([...CONFIRMATION_RULES,
        ...results.flatMap(r => Object.keys(r.summary[field] || {}))])].sort(codeUnitCompare);
    const lines = ['', `## ${heading} by rule × language`, '',
        '| rule | language | scored correct | unscored | false confirmations | precision | sample |',
        '|---|---|---|---|---|---|---|'];
    for (const rule of rules) for (const language of languages) {
        const summaries = results.filter(r => r.summary.language === language).map(r => r.summary);
        if (summaries.some(s => !s[field])) {
            lines.push(`| ${rule} | ${language} | n/a | n/a | n/a | n/a | older report |`);
            continue;
        }
        const total = { candidates: 0, hits: 0, unscored: 0 };
        for (const summary of summaries) {
            const row = summary[field][rule];
            for (const key of Object.keys(total)) total[key] += row?.[key] || 0;
        }
        if (!total.candidates) {
            lines.push(`| ${rule} | ${language} | 0/0 | 0 | 0 | unavailable | unmeasured (0 candidates) |`);
            continue;
        }
        const scored = total.candidates - total.unscored;
        lines.push(`| ${rule} | ${language} | ${total.hits}/${scored} | ${total.unscored} | ${scored - total.hits} | ${scored ? (100 * total.hits / scored).toFixed(2) + '%' : 'unavailable'} | ${scored < 30 ? 'low sample' : '≥30 scored'} |`);
    }
    if (results.some(r => !r.summary.language)) lines.push('', 'Older reports without language/provenance: n/a.');
    lines.push('', `### ${heading}: validator coverage`, '',
        'Oracle precision and validator coverage are separate. Unsupported rules retain their existing classification in report-only mode; they are not validated confirmations.', '',
        '| rule | language | validated target | unsupported (report-only) | incomplete / inconsistent |',
        '|---|---|---:|---:|---:|');
    for (const rule of rules) for (const language of languages) {
        const rows = results.filter(r => r.summary.language === language)
            .map(r => r.summary[field]?.[rule]).filter(r => r?.candidates);
        if (!rows.length) continue;
        if (rows.some(r => !r.validation)) {
            lines.push(`| ${rule} | ${language} | n/a | n/a | n/a |`);
            continue;
        }
        const count = key => rows.reduce((n, r) => n + (r.validation[key] || 0), 0);
        lines.push(`| ${rule} | ${language} | ${count('establishes-target')} | ${count('unsupported')} | ${count('incomplete') + count('inconsistent')} |`);
    }
    return lines;
}

module.exports = { occurrenceKey, dedupeOccurrences, addRuleStat, finishRuleStats, ruleTable };
