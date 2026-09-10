'use strict';

// Phase-A guard: provenance may grow, but the observable classifications on
// fixed, valid receiver fixtures must not change. Deliberately use the public
// execute surface and compare site identities, tiers, reasons and counts.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tmp, rm, idx } = require('../test/helpers');
const { RECEIVER_FIXTURES } = require('../test/helpers/evidence-fixtures');
const { execute } = require('../core/execute');

const CLASSIFICATION_FIELDS = new Set([
    'file', 'relativePath', 'line', 'column', 'startLine', 'endLine', 'name',
    'target', 'tier', 'resolution', 'reason', 'callerName', 'sites', 'siteIds',
    'confirmed', 'unverified', 'excluded', 'filtered', 'external', 'conserved',
    'groundTotal', 'totalSites', 'unaccounted', 'totalCount', 'callCount',
    'dispatchVia', 'dispatchCandidates', 'ownerCount', 'count', 'total',
]);
const SKIP = new Set(['provenance', 'siteProvenance', 'evidence', 'facts']);

function project(value, root, key = '') {
    if (value == null) return value;
    if (typeof value === 'string') return value.split(root).join('<fixture>');
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => project(item, root, key));
    const result = {};
    for (const field of Object.keys(value).sort()) {
        if (SKIP.has(field)) continue;
        const item = value[field];
        if (item && typeof item === 'object') {
            const nested = project(item, root, field);
            if (Array.isArray(nested) || Object.keys(nested).length) result[field] = nested;
        } else if (CLASSIFICATION_FIELDS.has(field)) {
            result[field] = project(item, root, field);
        }
    }
    return result;
}

function capture() {
    const rows = {};
    for (const [language, fixture] of Object.entries(RECEIVER_FIXTURES)) {
        const root = tmp(fixture.files);
        try {
            const index = idx(root);
            const target = (index.symbols.get(fixture.method) || []).find(d =>
                d.relativePath === fixture.file && d.className === fixture.owner && !d.traitImpl);
            if (!target) throw new Error(`Missing ${language} target`);
            const handle = `${target.relativePath}:${target.startLine}:${target.name}`;
            for (const command of ['show', 'impact', 'trace', 'tests', 'find', 'usages']) {
                const answer = execute(index, command, {
                    name: ['find', 'usages'].includes(command) ? fixture.method : handle,
                    ...(command === 'trace' && { direction: 'callees' }),
                });
                if (!answer.ok) throw new Error(`${language}/${command}: ${JSON.stringify(answer)}`);
                rows[`${language}/${command}`] = project(answer.result, root);
            }
        } finally { rm(root); }
    }
    const sha256 = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    return { commands: Object.keys(rows).length, sha256, rows };
}

if (require.main === module) {
    const snapshot = capture();
    const destination = process.argv[2];
    if (destination) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, JSON.stringify(snapshot, null, 2) + '\n');
    }
    const baseline = process.argv[3];
    if (baseline) {
        const prior = JSON.parse(fs.readFileSync(baseline, 'utf8'));
        const differences = Object.keys(snapshot.rows).filter(key =>
            JSON.stringify(snapshot.rows[key]) !== JSON.stringify(prior.rows[key]));
        console.log(JSON.stringify({ commands: snapshot.commands, differences, sha256: snapshot.sha256 }));
        if (differences.length) process.exitCode = 1;
    } else {
        console.log(JSON.stringify({ commands: snapshot.commands, sha256: snapshot.sha256 }));
    }
}

module.exports = { capture, project };
