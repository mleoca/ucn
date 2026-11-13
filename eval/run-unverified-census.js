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
 *   node eval/run-unverified-census.js --bands        # write core/evidence-bands.json
 *
 * --bands writes the table the unverified sections label their reasons with:
 * for each reason, how many of its candidates the release board's oracles
 * scored and how many of those were real edges. It reads the release board
 * only and requires pinned commits, primary oracles and every sampled symbol
 * evaluated without errors. A partial or failed run never
 * rewrites the tracked table.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPORTS_DIR = process.env.UCN_EVAL_REPORTS_DIR || path.join(__dirname, 'reports');
const REPORT_RE = /^oracle-eval-(.+)-(\d{4}-\d{2}-\d{2})((?:-[a-z0-9]+)*)\.json$/;
const PRIMARY_ORACLES = Object.freeze({ javascript: 'ts-morph', typescript: 'ts-morph', python: 'pyright',
    go: 'gopls', rust: 'rust-analyzer', java: 'jdtls', csharp: 'roslyn', c: 'clangd', cpp: 'clangd' });

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
    const confirmedRules = summary.confirmedRules || null;
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
        qualification: {
            error: summary.error || report.error || null,
            sampled: summary.sampled, evaluated: summary.evaluated, errors: summary.errors,
            symbols: perSymbol.length,
            symbolErrors: perSymbol.filter(symbol => symbol.error).length,
            sourceErrors: summary.sourceStatusErrors || 0,
            lookupErrors: summary.definitionLookupErrors || 0,
            reasonsPresent: !!summary.unverifiedReasons && typeof summary.unverifiedReasons === 'object' && !Array.isArray(summary.unverifiedReasons),
        },
        oracleCallEdges: summary.oracleCallEdges || 0,
        unverifiedCandidates: summary.unverifiedEdges || 0,
        trueEdgesUnverified: burden.trueEdgesUnverified || 0,
        trueEdgeUnverifiedRate: burden.trueEdgeUnverifiedRate || 0,
        rawFalseUnverifiedCandidates: burden.rawFalseUnverifiedCandidates || 0,
        unverifiedReviewItemsPerOracleEdge: burden.unverifiedReviewItemsPerOracleEdge || 0,
        runtimeDispatchGroups: burden.runtimeDispatchGroups || 0,
        zeroActionableUnverifiedTargetRate: burden.zeroActionableUnverifiedTargetRate ?? null,
        reasons: reasonRows,
        confirmedRules,
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

// A reason is labelled only from a sample this large.
const BAND_MINIMUM_SCORED = 30;
// Share of scored candidates that were real edges: at or above `often`,
// at or above `sometimes`, below it `rarely`.
const BAND_THRESHOLDS = Object.freeze({ often: 0.5, sometimes: 0.15 });

function bandOf(scored, real) {
    if (!(scored >= BAND_MINIMUM_SCORED)) return null;
    const share = real / scored;
    return share >= BAND_THRESHOLDS.often ? 'often' : share >= BAND_THRESHOLDS.sometimes ? 'sometimes' : 'rarely';
}

/**
 * The band table of a census over exactly the release board. Throws when a
 * release repository has no report: its absence would change every share.
 */
function bandTable(census, releaseRepos) {
    const releaseRepoNames = releaseRepos.map(repo => repo.name);
    const have = new Set(census.repos.map(repo => repo.repo));
    const missing = releaseRepoNames.filter(name => !have.has(name));
    if (missing.length > 0) throw new Error(`release board incomplete, no report for: ${missing.join(', ')}`);
    const board = census.repos.filter(repo => releaseRepoNames.includes(repo.repo));
    for (const pin of releaseRepos) {
        const rows = board.filter(repo => repo.repo === pin.name);
        if (rows.length !== 1) throw new Error(`release board has several reports for: ${pin.name}`);
        const row = rows[0];
        const expectedOracle = pin.oracle || PRIMARY_ORACLES[pin.language];
        if (!pin.commit || row.commit !== pin.commit || !expectedOracle || row.oracle !== expectedOracle) {
            throw new Error(`release board report is off pin for: ${pin.name}`);
        }
        const q = row.qualification;
        if (!q || q.error || !Number.isInteger(q.sampled) || q.sampled <= 0 ||
            q.evaluated !== q.sampled || q.symbols !== q.sampled || q.errors !== 0 ||
            q.symbolErrors !== 0 || q.sourceErrors !== 0 || q.lookupErrors !== 0 || q.reasonsPresent !== true) {
            throw new Error(`release board report is incomplete or failed for: ${pin.name}`);
        }
        if (!row.reasons.every(reason => [reason.candidates, reason.oracleTrueHits, reason.falseCandidates, reason.unscored]
            .every(value => Number.isInteger(value) && value >= 0) &&
            reason.candidates === reason.oracleTrueHits + reason.falseCandidates + reason.unscored)) {
            throw new Error(`release board reason counts are invalid for: ${pin.name}`);
        }
    }
    const reasons = {};
    for (const row of rollupReasons(board)) {
        const scored = row.oracleTrueHits + row.falseCandidates;
        const band = bandOf(scored, row.oracleTrueHits);
        if (band) reasons[row.reason] = { scored, real: row.oracleTrueHits, band };
    }
    return {
        schemaVersion: 1,
        source: 'unverified candidates of the release oracle board, scored by each language\'s own tool',
        boardDate: board.map(repo => repo.date).sort(codeUnitCompare).pop(),
        repositories: board.map(repo => repo.repo).sort(codeUnitCompare),
        minimumScored: BAND_MINIMUM_SCORED,
        thresholds: { ...BAND_THRESHOLDS },
        reasons: Object.fromEntries(Object.keys(reasons).sort(codeUnitCompare).map(reason => [reason, reasons[reason]])),
    };
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
    const bands = argv.includes('--bands');
    if (bands && includeVariants) {
        process.stderr.write('Evidence bands require canonical release reports; --all includes variant samples.\n');
        process.exitCode = 1;
        return;
    }
    const repoFilterRaw = readArgValue(argv, '--repo');
    const repoFilter = repoFilterRaw
        ? new Set(repoFilterRaw.split(',').map(value => value.trim()).filter(Boolean))
        : null;

    const releaseRepos = bands ? require('./lib/repos').RELEASE_REPOS : null;
    const releasePrefixes = releaseRepos && new Set(releaseRepos.map(repo => `${repo.name}-${PRIMARY_ORACLES[repo.language]}`));
    const entries = selectLatestReports(includeVariants).filter(entry => !bands || releasePrefixes.has(entry.prefix));
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

    if (bands) {
        let table;
        try {
            table = bandTable(census, releaseRepos);
        } catch (error) {
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
            return;
        }
        const out = readArgValue(argv, '--out') || path.join(__dirname, '..', 'core', 'evidence-bands.json');
        fs.writeFileSync(out, JSON.stringify(table, null, 2) + '\n');
        process.stdout.write(`Evidence bands of ${table.repositories.length} release repositories (${table.boardDate}): ${out}\n`);
        for (const [reason, row] of Object.entries(table.reasons)) {
            process.stdout.write(`  ${reason}: ${row.band} (${row.real} of ${row.scored})\n`);
        }
        return;
    }

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

if (require.main === module) main();

module.exports = { bandOf, bandTable, rollupReasons, BAND_MINIMUM_SCORED, BAND_THRESHOLDS };
