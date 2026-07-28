#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const { ProjectIndex } = require('../core/project');

function readArgValue(args, flag) {
    const equal = args.find(arg => arg.startsWith(`${flag}=`));
    if (equal) return equal.slice(flag.length + 1);
    const index = args.indexOf(flag);
    if (index >= 0 && index + 1 < args.length && !args[index + 1].startsWith('--')) {
        return args[index + 1];
    }
    return null;
}

function nowMs() {
    return Number(process.hrtime.bigint()) / 1e6;
}

function percentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return Number(sorted[Math.min(
        sorted.length - 1,
        Math.ceil(sorted.length * fraction) - 1,
    )].toFixed(3));
}

function addCounts(target, source) {
    for (const [key, value] of Object.entries(source || {})) {
        target[key] = (target[key] || 0) + value;
    }
}

function sortedCounts(counts) {
    return Object.fromEntries(Object.entries(counts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function findDefinition(index, item) {
    const expectedFile = item.file && path.normalize(item.file);
    for (const definitions of index.symbols.values()) {
        const found = definitions.find(definition =>
            (!expectedFile || path.normalize(definition.relativePath) === expectedFile) &&
            (!item.startLine || definition.startLine === item.startLine) &&
            (!item.name || definition.name === item.name ||
                `${definition.className}.${definition.name}` === item.name));
        if (found) return found;
    }
    const resolved = item.name && index.resolveSymbol(item.name);
    return resolved?.def || null;
}

function selectTargets(index, sample, explicitNames) {
    if (explicitNames.length > 0) {
        return explicitNames.map(name => {
            const resolved = index.resolveSymbol(name);
            return resolved?.def || null;
        }).filter(Boolean);
    }
    const hot = index.getStats({ hot: true, top: sample }).hot?.items || [];
    const targets = [];
    const seen = new Set();
    for (const item of hot) {
        const definition = findDefinition(index, item);
        if (!definition) continue;
        const key = `${definition.file}:${definition.startLine}:${definition.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push(definition);
        if (targets.length >= sample) break;
    }
    return targets;
}

function formatMarkdown(report) {
    const s = report.summary;
    const lines = [
        '# Caller resolution profile',
        '',
        `Generated: ${report.generatedAt}`,
        `Project: ${report.projectRoot}`,
        `Targets: ${s.targets}`,
        '',
        'This is an instrumented portable-AST profile. Timings are local-machine',
        'diagnostics, not release performance claims.',
        '',
        '## Stage timings',
        '',
        '| stage | p50 | p95 | total |',
        '|---|---:|---:|---:|',
        `| cache load | ${s.stageMs.cacheLoad.p50} ms | ${s.stageMs.cacheLoad.p95} ms | ${s.stageMs.cacheLoad.total} ms |`,
        `| candidate scan/resolution | ${s.stageMs.candidateScan.p50} ms | ${s.stageMs.candidateScan.p95} ms | ${s.stageMs.candidateScan.total} ms |`,
        `| enrichment | ${s.stageMs.enrichment.p50} ms | ${s.stageMs.enrichment.p95} ms | ${s.stageMs.enrichment.total} ms |`,
        `| complete findCallers | ${s.stageMs.total.p50} ms | ${s.stageMs.total.p95} ms | ${s.stageMs.total.total} ms |`,
        '',
        '## Placement',
        '',
        `- Confirmed: ${s.confirmed}`,
        `- Unverified: ${s.unverified}`,
        `- Excluded: ${s.excluded}`,
        `- Candidates entering resolution: ${s.candidates}`,
        '',
        '### Confirmed resolutions',
        '',
        '| resolution | count |',
        '|---|---:|',
        ...Object.entries(s.confirmedByResolution).map(([reason, count]) =>
            `| ${reason} | ${count} |`),
        '',
        '### Unverified reasons',
        '',
        '| reason | count |',
        '|---|---:|',
        ...(Object.entries(s.unverifiedByReason).length
            ? Object.entries(s.unverifiedByReason).map(([reason, count]) =>
                `| ${reason} | ${count} |`)
            : ['| none | 0 |']),
        '',
        '### Exclusion reasons',
        '',
        '| reason | count |',
        '|---|---:|',
        ...(Object.entries(s.excludedByReason).length
            ? Object.entries(s.excludedByReason).map(([reason, count]) =>
                `| ${reason} | ${count} |`)
            : ['| none | 0 |']),
        '',
        '## Per target',
        '',
        '| handle | total ms | candidates | confirmed | unverified | excluded |',
        '|---|---:|---:|---:|---:|---:|',
        ...report.targets.map(row =>
            `| ${row.handle} | ${row.profile.totalMs} | ${row.profile.candidates} | ${row.profile.confirmed} | ${row.profile.unverified} | ${row.profile.excluded} |`),
        '',
    ];
    return lines.join('\n');
}

function summarize(rows, buildMs) {
    const aggregate = {
        confirmedByResolution: {},
        unverifiedByReason: {},
        excludedByReason: {},
    };
    for (const row of rows) {
        addCounts(aggregate.confirmedByResolution, row.profile.confirmedByResolution);
        addCounts(aggregate.unverifiedByReason, row.profile.unverifiedByReason);
        addCounts(aggregate.excludedByReason, row.profile.excludedByReason);
    }
    const stage = field => {
        const values = rows.map(row => row.profile[field] || 0);
        return {
            p50: percentile(values, 0.50),
            p95: percentile(values, 0.95),
            total: Number(values.reduce((sum, value) => sum + value, 0).toFixed(3)),
        };
    };
    return {
        buildMs: Number(buildMs.toFixed(3)),
        targets: rows.length,
        candidates: rows.reduce((sum, row) => sum + row.profile.candidates, 0),
        confirmed: rows.reduce((sum, row) => sum + row.profile.confirmed, 0),
        unverified: rows.reduce((sum, row) => sum + row.profile.unverified, 0),
        excluded: rows.reduce((sum, row) => sum + row.profile.excluded, 0),
        confirmedByResolution: sortedCounts(aggregate.confirmedByResolution),
        unverifiedByReason: sortedCounts(aggregate.unverifiedByReason),
        excludedByReason: sortedCounts(aggregate.excludedByReason),
        stageMs: {
            cacheLoad: stage('cacheLoadMs'),
            candidateScan: stage('candidateScanMs'),
            enrichment: stage('enrichmentMs'),
            total: stage('totalMs'),
        },
    };
}

function main() {
    const args = process.argv.slice(2);
    const project = path.resolve(readArgValue(args, '--project') || '.');
    const sampleRaw = readArgValue(args, '--sample');
    const sample = sampleRaw == null ? 20 : Number(sampleRaw);
    if (!Number.isInteger(sample) || sample < 1) {
        throw new Error(`--sample must be a positive integer (got ${sampleRaw})`);
    }
    const explicitNames = (readArgValue(args, '--symbols') || '')
        .split(',').map(value => value.trim()).filter(Boolean);
    const date = new Date().toISOString().slice(0, 10);
    const outputDir = path.resolve(
        readArgValue(args, '--output-dir') || path.join(__dirname, 'reports'));

    const buildStarted = nowMs();
    const index = new ProjectIndex(project);
    index.build(null, { quiet: true });
    const buildMs = nowMs() - buildStarted;
    const definitions = selectTargets(index, sample, explicitNames);
    if (definitions.length === 0) throw new Error('No caller-profile targets resolved');

    const rows = [];
    for (const definition of definitions) {
        const profile = {};
        index.findCallers(definition.name, {
            targetDefinitions: [definition],
            includeMethods: true,
            collectAccount: true,
            profile,
        });
        rows.push({
            handle: `${definition.relativePath}:${definition.startLine}:${definition.name}`,
            language: index.files.get(definition.file)?.language || null,
            profile,
        });
    }

    const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        projectRoot: index.root,
        samplePolicy: explicitNames.length > 0
            ? { kind: 'explicit-symbols', symbols: explicitNames }
            : { kind: 'top-static-call-count', sample },
        summary: summarize(rows, buildMs),
        targets: rows,
    };
    fs.mkdirSync(outputDir, { recursive: true });
    const jsonPath = path.join(outputDir, `caller-profile-${date}.json`);
    const mdPath = path.join(outputDir, `caller-profile-${date}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(mdPath, formatMarkdown(report));
    process.stdout.write(`Caller profile complete: ${rows.length} targets\n`);
    process.stdout.write(`  JSON: ${jsonPath}\n`);
    process.stdout.write(`  MD:   ${mdPath}\n`);
    process.stdout.write(`  confirmed=${report.summary.confirmed} ` +
        `unverified=${report.summary.unverified} ` +
        `excluded=${report.summary.excluded}\n`);
    process.stdout.write(`  findCallers p50/p95=${report.summary.stageMs.total.p50}/` +
        `${report.summary.stageMs.total.p95} ms\n`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = { selectTargets, summarize, formatMarkdown };
