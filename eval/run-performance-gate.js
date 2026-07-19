#!/usr/bin/env node

/**
 * Reproducible real-repository performance gate.
 *
 * Measures the path an agent actually pays for:
 *   1. cold AST index build;
 *   2. persisted-index load and first semantic warm-up;
 *   3. a deterministic board of pinned `context` queries;
 *   4. process RSS after the board.
 *
 * Absolute latency budgets catch slow releases. Ratio/throughput budgets make
 * the gate portable across CI hosts. Tiny repositories are excluded from the
 * warm/cold ratio because process and JSON fixed costs dominate there.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const { ProjectIndex } = require('../core/project');
const { execute } = require('../core/execute');
const { REPOS, cloneAtCommit, resolveTarget } = require('./lib/repos');

const args = process.argv.slice(2);
const repoArg = readArg('--repo');
const repoNames = repoArg ? new Set(repoArg.split(',').map(s => s.trim()).filter(Boolean)) : null;
const queryCount = positiveNumber('--queries', 40);
const budgets = {
    minColdLocPerSec: positiveNumber('--min-cold-loc-sec', 10000),
    maxCacheLoadMs: positiveNumber('--max-cache-load-ms', 1500),
    maxFirstQueryMs: positiveNumber('--max-first-query-ms', 500),
    maxWarmColdRatio: positiveNumber('--max-warm-cold-ratio', 0.65),
    maxQueryP50Ms: positiveNumber('--max-query-p50-ms', 75),
    maxQueryP95Ms: positiveNumber('--max-query-p95-ms', 250),
    maxRssMb: positiveNumber('--max-rss-mb', 1536),
};
const REPORTS_DIR = path.join(__dirname, 'reports');

function readArg(flag) {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
}

function positiveNumber(flag, fallback) {
    const raw = readArg(flag);
    if (raw == null) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${flag} must be a positive number (got ${raw})`);
    }
    return value;
}

function elapsed(start) { return Number((performance.now() - start).toFixed(3)); }
function rate(n, d) { return d > 0 ? Number((n / d).toFixed(3)) : 0; }
function percentile(values, fraction) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function indexLineCount(index) {
    let total = 0;
    for (const [, fe] of index.files) total += fe.lines || 0;
    return total;
}

function callableBoard(index, limit) {
    const candidates = [];
    for (const [, defs] of index.symbols) {
        for (const def of defs) {
            if (def.params === undefined && !['class', 'struct'].includes(def.type)) continue;
            candidates.push(def);
        }
    }
    // Deterministic and deliberately mixed: stable path/line order, then take
    // evenly spaced definitions so one hot file cannot dominate the board.
    candidates.sort((a, b) =>
        String(a.relativePath || '').localeCompare(String(b.relativePath || '')) ||
        (a.startLine || 0) - (b.startLine || 0) ||
        String(a.name || '').localeCompare(String(b.name || '')));
    if (candidates.length <= limit) return candidates;
    const result = [];
    const step = candidates.length / limit;
    for (let i = 0; i < limit; i++) result.push(candidates[Math.floor(i * step)]);
    return result;
}

async function evaluateRepo(repo) {
    const clone = cloneAtCommit(repo);
    const target = resolveTarget(clone, repo);
    process.stdout.write(`\n=== ${repo.name} (${repo.language}) @ ${repo.commit.slice(0, 8)} ===\n`);

    if (global.gc) global.gc();
    const cold = new ProjectIndex(target);
    const coldStart = performance.now();
    cold.build(null, { quiet: true });
    const coldMs = elapsed(coldStart);
    const lines = indexLineCount(cold);
    const coldLocPerSec = rate(lines * 1000, coldMs);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ucn-perf-${repo.name}-`));
    const cachePath = path.join(tempDir, 'index.json');
    let cacheSaveMs = 0;
    let cacheLoadMs = 0;
    let firstQueryMs = 0;
    let queryErrors = 0;
    let queryTimes = [];
    try {
        let started = performance.now();
        cold.saveCache(cachePath);
        cacheSaveMs = elapsed(started);

        if (global.gc) global.gc();
        const warm = new ProjectIndex(target);
        started = performance.now();
        const loaded = warm.loadCache(cachePath);
        cacheLoadMs = elapsed(started);
        if (!loaded) throw new Error('cache load returned false');

        const board = callableBoard(warm, queryCount);
        if (board.length === 0) throw new Error('no callable symbols available for query board');

        // First query pays lazy calls-shard materialization. Report it
        // separately so steady-state p95 cannot hide startup work.
        const first = board[0];
        started = performance.now();
        const firstResult = execute(warm, 'context', {
            name: `${first.relativePath}:${first.startLine}:${first.name}`,
            compact: true,
        });
        firstQueryMs = elapsed(started);
        if (!firstResult.ok) queryErrors++;

        for (const def of board) {
            started = performance.now();
            const result = execute(warm, 'context', {
                name: `${def.relativePath}:${def.startLine}:${def.name}`,
                compact: true,
            });
            queryTimes.push(elapsed(started));
            if (!result.ok) queryErrors++;
        }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    const queryP50Ms = Number(percentile(queryTimes, 0.50).toFixed(3));
    const queryP95Ms = Number(percentile(queryTimes, 0.95).toFixed(3));
    const rssMb = Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1));
    const warmColdRatio = rate(cacheLoadMs + firstQueryMs, coldMs);
    const failures = [];

    // Small repos are fixed-cost dominated; apply throughput/ratio only once
    // there is enough work to make the comparison meaningful.
    if (lines >= 5000 && coldLocPerSec < budgets.minColdLocPerSec) {
        failures.push(`cold throughput ${coldLocPerSec} LOC/s < ${budgets.minColdLocPerSec}`);
    }
    if (cacheLoadMs > budgets.maxCacheLoadMs) {
        failures.push(`cache load ${cacheLoadMs}ms > ${budgets.maxCacheLoadMs}ms`);
    }
    if (firstQueryMs > budgets.maxFirstQueryMs) {
        failures.push(`first semantic query ${firstQueryMs}ms > ${budgets.maxFirstQueryMs}ms`);
    }
    if (coldMs >= 500 && warmColdRatio > budgets.maxWarmColdRatio) {
        failures.push(`warm/cold ratio ${warmColdRatio} > ${budgets.maxWarmColdRatio}`);
    }
    if (queryP50Ms > budgets.maxQueryP50Ms) {
        failures.push(`query p50 ${queryP50Ms}ms > ${budgets.maxQueryP50Ms}ms`);
    }
    if (queryP95Ms > budgets.maxQueryP95Ms) {
        failures.push(`query p95 ${queryP95Ms}ms > ${budgets.maxQueryP95Ms}ms`);
    }
    if (rssMb > budgets.maxRssMb) failures.push(`RSS ${rssMb}MB > ${budgets.maxRssMb}MB`);
    if (queryErrors > 0) failures.push(`${queryErrors} semantic query error(s)`);

    process.stdout.write(`  ${cold.files.size} files, ${lines} LOC | cold ${coldMs}ms (${coldLocPerSec} LOC/s) | ` +
        `cache load ${cacheLoadMs}ms + first query ${firstQueryMs}ms (ratio ${warmColdRatio})\n`);
    process.stdout.write(`  context board n=${queryTimes.length} | p50 ${queryP50Ms}ms | p95 ${queryP95Ms}ms | ` +
        `RSS ${rssMb}MB | errors ${queryErrors}${failures.length ? ` | FAIL: ${failures.join('; ')}` : ''}\n`);

    return {
        repo: repo.name,
        language: repo.language,
        commit: repo.commit,
        files: cold.files.size,
        lines,
        coldMs,
        coldLocPerSec,
        cacheSaveMs,
        cacheLoadMs,
        firstQueryMs,
        warmColdRatio,
        queryCount: queryTimes.length,
        queryP50Ms,
        queryP95Ms,
        queryMaxMs: Number(Math.max(...queryTimes).toFixed(3)),
        queryErrors,
        rssMb,
        failures,
    };
}

async function main() {
    const repos = REPOS.filter(repo => !repoNames || repoNames.has(repo.name));
    if (repos.length === 0) throw new Error(`No repositories match --repo ${repoArg || '(all)'}`);
    if (repoNames) {
        const missing = [...repoNames].filter(name => !repos.some(repo => repo.name === name));
        if (missing.length) throw new Error(`Unknown repositories: ${missing.join(', ')}`);
    }

    const results = [];
    let failed = false;
    for (const repo of repos) {
        try {
            const result = await evaluateRepo(repo);
            results.push(result);
            if (result.failures.length) failed = true;
        } catch (error) {
            failed = true;
            process.stderr.write(`  FAILED ${repo.name}: ${error.stack || error.message}\n`);
            results.push({ repo: repo.name, language: repo.language, error: error.message, failures: [error.message] });
        }
    }

    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const report = { date, budgets, results, passed: !failed };
    const jsonPath = path.join(REPORTS_DIR, `performance-gate-${date}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

    const md = [
        `# UCN performance gate — ${date}`,
        '',
        'Real pinned repositories; cold AST build, persisted-index load, first semantic query, and steady-state pinned `context` board.',
        '',
        '| repo | files | LOC | cold | LOC/s | cache load | first query | warm/cold | query p50 | query p95 | RSS | result |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
        ...results.map(r => r.error
            ? `| ${r.repo} | — | — | — | — | — | — | — | — | — | — | **ERROR: ${r.error}** |`
            : `| ${r.repo} | ${r.files} | ${r.lines} | ${r.coldMs}ms | ${r.coldLocPerSec} | ${r.cacheLoadMs}ms | ${r.firstQueryMs}ms | ${r.warmColdRatio} | ${r.queryP50Ms}ms | ${r.queryP95Ms}ms | ${r.rssMb}MB | ${r.failures.length ? `**FAIL:** ${r.failures.join('; ')}` : 'PASS'} |`),
        '',
        `Budgets: ${JSON.stringify(budgets)}.`,
    ];
    const mdPath = path.join(REPORTS_DIR, `performance-gate-${date}.md`);
    fs.writeFileSync(mdPath, md.join('\n'));
    process.stdout.write(`\nwrote ${path.relative(process.cwd(), jsonPath)}\nwrote ${path.relative(process.cwd(), mdPath)}\n`);
    process.exitCode = failed ? 1 : 0;
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { evaluateRepo, percentile, callableBoard };
