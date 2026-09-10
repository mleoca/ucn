'use strict';

// Full witnesses stay on engine results for validation and oracle reports.
// Public answers carry the facts an agent needs to locate and interpret a site,
// rather than repeating declaration/member inventories for every occurrence.
function compactProvenance(provenance) {
    if (!provenance) return provenance;
    const facts = provenance.facts || {};
    const origin = facts.receiverOrigin;
    return {
        rule: provenance.rule,
        ...(provenance.rules?.length > 1 && { rules: provenance.rules }),
        validation: provenance.validation,
        ...(provenance.diagnostic && provenance.validation !== 'unsupported' &&
            { diagnostic: provenance.diagnostic }),
        ...(facts.receiverTypeSource && { receiverSource: facts.receiverTypeSource }),
        ...(Number.isInteger(origin?.line) && { originLine: origin.line }),
    };
}

function compactExclusions(excluded) {
    if (!Array.isArray(excluded?.evidence)) return excluded;
    const { evidence, ...summary } = excluded;
    const groups = new Map();
    for (const site of evidence) {
        const p = site.provenance || {};
        const row = { rule: p.rule || 'unattributed', validation: p.validation || 'unreported',
            ...(p.diagnostic && p.validation !== 'unsupported' && { diagnostic: p.diagnostic }) };
        const key = JSON.stringify(row);
        if (!groups.has(key)) groups.set(key, { ...row, count: 0 });
        groups.get(key).count++;
    }
    return { ...summary, evidenceSummary: [...groups.values()] };
}

function provenanceReplacer(key, value) {
    if (key === 'provenance') return compactProvenance(value);
    return key === 'excluded' ? compactExclusions(value) : value;
}

module.exports = { compactProvenance, compactExclusions, provenanceReplacer };
