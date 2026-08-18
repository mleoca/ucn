#!/usr/bin/env node

/**
 * eval/run-unverified-census.js - Phase 0 census of the unverified tier.
 *
 * Read-only aggregation over the oracle-eval report JSONs already on disk
 * (eval/reports/oracle-eval-<repo>-<oracle>-<date>.json). For each repo the
 * LATEST canonical report (no -seed/-fresh suffix unless --all) is taken, and
 * the unverified bands are classified by engine reason:
 *
 *   - recall opportunities: oracle-TRUE edges UCN shows only as unverified
 *     (hits per reason) — each is a candidate engine family that could move
 *     a true edge into the confirmed tier;
 *   - review noise: oracle-FALSE candidates per reason — each is review
 *     burden a family/ranking UX or a new exclusion could compress;
 *   - concentration: the symbols carrying the largest actionable bands —
 *     where one family fix pays the most.
 *
 * This is measurement only: it never runs the engine and never gates.
 *
 * Usage:
 *   node eval/run-unverified-census.js
 *   node eval/run-unverified-census.js --all          # include seed/fresh reports
 *   node eval/run-unverified-census.js --repo hono,zod
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, 'reports');
const REPORT_RE = /^oracle-eval-(.+)-(\d{4}-\d{2}-\d{2})((?:-[a-z0-9]+)*)\.json$/;

function codeUnitCompare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

function readArgValue(argv, key) {
    const equals = argv.find(arg => arg.startsWith(`${key}=`));
    if (equals) return equals.slice(key.length + 1);
    const index = argv.indexOf(key);
    if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
        return argv[index + 1];
    }
    return null;
}

/** Latest report file per repo-oracle prefix (canonical runs only by default). */
function selectLatestReports(includeVariants) {
    const files = fs.readdirSync(REPORTS_DIR).filter(name => REPORT_RE.test(name));
    const byPrefix = new Map();
    for (const name of files) {
        const match = name.match(REPORT_RE);
        const prefix = match[1];
        const date = match[2];
        const suffix = match[3] || '';
        if (suffix && !includeVariants) continue;
        const current = byPrefix.get(prefix);
        if (!current || codeUnitCompare(current.date, date) < 0) {
            byPrefix.set(prefix, { name, prefix, date, suffix });
        }
    }
    return [...byPrefix.values()].sort((a, b) => codeUnitCompare(a.prefix, b.prefix));
}

function loadReport(entry) {
    try {
        return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, entry.name), 'utf8'));
    } catch (error) {
        process.stderr.write(`skip ${entry.name}: ${error.message}\n`);
        return null;
    }
}

function censusRepo(entry, report) {
    const summary = report.summary || {};
    const reasons = summary.unverifiedReasons || {};
    const burden = summary.reviewBurden || {};
    const perSymbol = Array.isArray(report.perSymbol) ? report.perSymbol : [];

    const reasonRows = Object.entries(reasons).map(([reason, row]) => ({
        reason,
        candidates: row.candidates || 0,
        oracleTrueHits: row.hits || 0,
        falseCandidates: row.falseCandidates || 0,
        unscored: row.unscored || 0,
    })).sort((a, b) => b.candidates - a.candidates ||
        codeUnitCompare(a.reason, b.reason));

    const topSymbols = perSymbol
        .filter(sym => (sym.actionableUnverified || 0) > 0)
        .map(sym => ({
            name: sym.name,
            file: sym.file,
            line: sym.line,
            kind: sym.kind,
            actionableUnverified: sym.actionableUnverified || 0,
            unverifiedHits: sym.unverifiedHits || 0,
            trueEdgesUnverified: (sym.exactPlacement && sym.exactPlacement.unverified) || 0,
            reasons: Object.keys(sym.unverifiedReasons || {}).sort(codeUnitCompare),
        }))
        .sort((a, b) => b.actionableUnverified - a.actionableUnverified ||
            codeUnitCompare(a.name, b.name))
        .slice(0, 10);

    return {
        report: entry.name,
        repo: summary.repo || entry.prefix,
        oracle: summary.oracle || null,
        date: entry.date,
        commit: summary.commit || null,
        oracleCallEdges: summary.oracleCallEdges || 0,
        unverifiedCandidates: summary.unverifiedEdges || 0,
        trueEdgesUnverified: burden.trueEdgesUnverified || 0,
        trueEdgeUnverifiedRate: burden.trueEdgeUnverifiedRate || 0,
        rawFalseUnverifiedCandidates: burden.rawFalseUnverifiedCandidates || 0,
        unverifiedReviewItemsPerOracleEdge: burden.unverifiedReviewItemsPerOracleEdge || 0,
        runtimeDispatchGroups: burden.runtimeDispatchGroups || 0,
        zeroActionableUnverifiedTargetRate: burden.zeroActionableUnverifiedTargetRate ?? null,
        reasons: reasonRows,
        topSymbols,
    };
}

function rollupReasons(repoRows) {
    const byReason = new Map();
    for (const repo of repoRows) {
        for (const row of repo.reasons) {
            const agg = byReason.get(row.reason) || {
                reason: row.reason,
                candidates: 0,
                oracleTrueHits: 0,
                falseCandidates: 0,
                unscored: 0,
                repos: [],
            };
            agg.candidates += row.candidates;
            agg.oracleTrueHits += row.oracleTrueHits;
            agg.falseCandidates += row.falseCandidates;
            agg.unscored += row.unscored;
            agg.repos.push(repo.repo);
            byReason.set(row.reason, agg);
        }
    }
    return [...byReason.values()]
        .map(agg => ({ ...agg, repos: agg.repos.sort(codeUnitCompare) }))
        .sort((a, b) => b.candidates - a.candidates ||
            codeUnitCompare(a.reason, b.reason));
}

function formatMarkdown(census) {
    const lines = [
        '# Unverified-tier census (Phase 0)',
        '',
        `Generated: ${census.generatedAt}`,
        `Reports: ${census.repos.length} (latest canonical oracle-eval JSON per repo)`,
        '',
        'Read-only aggregation over existing oracle-eval reports. "true edges" are',
        'oracle-verified call edges UCN shows only in the unverified tier (recall',
        'opportunities); "false candidates" are oracle-refuted candidates (review',
        'noise a family fix or grouping UX could compress).',
        '',
        '## Reasons across all repos',
        '',
        '| reason | candidates | oracle-true | oracle-false | unscored | repos |',
        '|---|---:|---:|---:|---:|---|',
    ];
    for (const row of census.reasonRollup) {
        lines.push(`| ${row.reason} | ${row.candidates} | ${row.oracleTrueHits} | ` +
            `${row.falseCandidates} | ${row.unscored} | ${row.repos.join(', ')} |`);
    }
    lines.push('', '## Per repo', '');
    lines.push('| repo | oracle edges | unverified candidates | true-in-unverified | false candidates | review items / oracle edge |');
    lines.push('|---|---:|---:|---:|---:|---:|');
    for (const repo of census.repos) {
        lines.push(`| ${repo.repo} (${repo.date}) | ${repo.oracleCallEdges} | ` +
            `${repo.unverifiedCandidates} | ${repo.trueEdgesUnverified} | ` +
            `${repo.rawFalseUnverifiedCandidates} | ${repo.unverifiedReviewItemsPerOracleEdge} |`);
    }
    lines.push('', '## Largest actionable bands (per-symbol concentration)', '');
    lines.push('| repo | symbol | kind | actionable band | oracle-true in band | reasons |');
    lines.push('|---|---|---|---:|---:|---|');
    const concentrated = census.repos
        .flatMap(repo => repo.topSymbols.map(sym => ({ repo: repo.repo, ...sym })))
        .sort((a, b) => b.actionableUnverified - a.actionableUnverified ||
            codeUnitCompare(`${a.repo}:${a.name}`, `${b.repo}:${b.name}`))
        .slice(0, 25);
    for (const sym of concentrated) {
        lines.push(`| ${sym.repo} | ${sym.name} (${sym.file}:${sym.line}) | ${sym.kind} | ` +
            `${sym.actionableUnverified} | ${sym.unverifiedHits} | ${sym.reasons.join(', ')} |`);
    }
    lines.push('');
    return lines.join('\n');
}

function main() {
    const argv = process.argv.slice(2);
    const includeVariants = argv.includes('--all');
    const repoFilterRaw = readArgValue(argv, '--repo');
    const repoFilter = repoFilterRaw
        ? new Set(repoFilterRaw.split(',').map(value => value.trim()).filter(Boolean))
        : null;

    const entries = selectLatestReports(includeVariants);
    // Older filename formats (repo without oracle, per-oracle variants) create
    // several prefixes per repo — dedup by the report's own summary.repo,
    // preferring the newest date, then the richer schema, then edge count.
    const byRepo = new Map();
    for (const entry of entries) {
        const report = loadReport(entry);
        if (!report || !report.summary) continue;
        const row = censusRepo(entry, report);
        if (repoFilter && !repoFilter.has(row.repo)) continue;
        row.schemaVersion = report.schemaVersion || 0;
        const current = byRepo.get(row.repo);
        const better = !current ||
            codeUnitCompare(current.date, row.date) < 0 ||
            (current.date === row.date && (current.schemaVersion < row.schemaVersion ||
                (current.schemaVersion === row.schemaVersion &&
                    current.oracleCallEdges < row.oracleCallEdges)));
        if (better) byRepo.set(row.repo, row);
    }
    const repos = [...byRepo.values()].sort((a, b) => codeUnitCompare(a.repo, b.repo));
    if (repos.length === 0) {
        process.stderr.write('No oracle-eval reports found under eval/reports/.\n');
        process.exitCode = 1;
        return;
    }

    const census = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        includeVariants,
        repos,
        reasonRollup: rollupReasons(repos),
    };

    const date = census.generatedAt.slice(0, 10);
    const jsonPath = path.join(REPORTS_DIR, `unverified-census-${date}.json`);
    const mdPath = path.join(REPORTS_DIR, `unverified-census-${date}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify(census, null, 2));
    fs.writeFileSync(mdPath, formatMarkdown(census));

    process.stdout.write(`Unverified-tier census over ${repos.length} repos.\n`);
    process.stdout.write(`  JSON: ${jsonPath}\n`);
    process.stdout.write(`  MD:   ${mdPath}\n\n`);
    process.stdout.write('Top reasons (candidates | oracle-true | oracle-false):\n');
    for (const row of census.reasonRollup.slice(0, 12)) {
        process.stdout.write(`  ${row.reason}: ${row.candidates} | ` +
            `${row.oracleTrueHits} | ${row.falseCandidates}\n`);
    }
}

main();
