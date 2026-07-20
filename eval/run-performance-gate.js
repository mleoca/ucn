#!/usr/bin/env node

/**
 * Reproducible real-repository performance gate.
 *
 * Measures the path an agent actually pays for:
 *   1. cold AST index build;
 *   2. repeated persisted-index load and first semantic warm-up;
 *   3. a deterministic board of pinned `context` queries;
 *   4. per-repository process RSS after the board.
 *
 * Absolute latency budgets catch slow releases. Ratio/throughput budgets make
 * the gate portable across CI hosts. Tiny repositories are excluded from the
 * warm/cold ratio because process and JSON fixed costs dominate there.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');

const { ProjectIndex } = require('../core/project');
const { execute } = require('../core/execute');
const { REPOS, RELEASE_REPOS, cloneAtCommit, resolveTarget } = require('./lib/repos');
const {
    DEFAULT_BUDGETS,
    percentile,
    summarizeSamples,
    evaluatePerformanceBudgets,
} = require('./performance-gate-policy');

const args = process.argv.slice(2);
const releaseOnly = args.includes('--release');
const repoArg = readArg('--repo');
const repoNames = repoArg ? new Set(repoArg.split(',').map(s => s.trim()).filter(Boolean)) : null;
const queryCount = positiveInteger('--queries', 40);
const startupSamples = positiveInteger('--startup-samples', 3);
const workerRepoName = readArg('--worker-repo');
const workerResultPath = readArg('--worker-result');
const budgets = {
    minColdLocPerSec: positiveNumber('--min-cold-loc-sec', DEFAULT_BUDGETS.minColdLocPerSec),
    maxCacheLoadMs: positiveNumber('--max-cache-load-ms', DEFAULT_BUDGETS.maxCacheLoadMs),
    maxFirstQueryMs: positiveNumber('--max-first-query-ms', DEFAULT_BUDGETS.maxFirstQueryMs),
    maxWarmColdRatio: positiveNumber('--max-warm-cold-ratio', DEFAULT_BUDGETS.maxWarmColdRatio),
    maxQueryP50Ms: positiveNumber('--max-query-p50-ms', DEFAULT_BUDGETS.maxQueryP50Ms),
    maxQueryP95Ms: positiveNumber('--max-query-p95-ms', DEFAULT_BUDGETS.maxQueryP95Ms),
    maxRssMb: positiveNumber('--max-rss-mb', DEFAULT_BUDGETS.maxRssMb),
};
const REPORTS_DIR = path.join(__dirname, 'reports');

function readArg(flag) {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
}

function positiveNumber(flag, fallback) {
    const raw = readArg(flag);
    if (!args.includes(flag)) return fallback;
    if (raw == null) throw new Error(`${flag} requires a value`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${flag} must be a positive number (got ${raw})`);
    }
    return value;
}

function positiveInteger(flag, fallback) {
    const value = positiveNumber(flag, fallback);
    if (!Number.isInteger(value)) throw new Error(`${flag} must be a positive integer (got ${value})`);
    return value;
}

function elapsed(start) { return Number((performance.now() - start).toFixed(3)); }
function rate(n, d) { return d > 0 ? Number((n / d).toFixed(3)) : 0; }
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
    let cold = new ProjectIndex(target);
    const coldStart = performance.now();
    cold.build(null, { quiet: true });
    const coldMs = elapsed(coldStart);
    const lines = indexLineCount(cold);
    const fileCount = cold.files.size;
    const coldLocPerSec = rate(lines * 1000, coldMs);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ucn-perf-${repo.name}-`));
    const cachePath = path.join(tempDir, 'index.json');
    let cacheSaveMs;
    let cacheLoadMs;
    let firstQueryMs;
    let queryErrors = 0;
    let queryTimes = [];
    const cacheLoadSamplesMs = [];
    const firstQuerySamplesMs = [];
    try {
        let started = performance.now();
        cold.saveCache(cachePath);
        cacheSaveMs = elapsed(started);
        cold = null;

        let warm;
        let board;
        for (let sample = 0; sample < startupSamples; sample++) {
            if (global.gc) global.gc();
            warm = new ProjectIndex(target);
            started = performance.now();
            const loaded = warm.loadCache(cachePath);
            cacheLoadSamplesMs.push(elapsed(started));
            if (!loaded) throw new Error('cache load returned false');

            board = callableBoard(warm, queryCount);
            if (board.length === 0) throw new Error('no callable symbols available for query board');

            // Each sample uses a fresh loaded index, so every timing includes
            // lazy calls-shard materialization and reachability startup.
            const first = board[0];
            started = performance.now();
            const firstResult = execute(warm, 'context', {
                name: `${first.relativePath}:${first.startLine}:${first.name}`,
                compact: true,
            });
            firstQuerySamplesMs.push(elapsed(started));
            if (!firstResult.ok) queryErrors++;
        }

        cacheLoadMs = summarizeSamples(cacheLoadSamplesMs).median;
        firstQueryMs = summarizeSamples(firstQuerySamplesMs).median;

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
    if (global.gc) global.gc();
    const rssMb = Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1));
    const peakRssMb = Number((process.resourceUsage().maxRSS / 1024).toFixed(1));
    const warmColdRatio = rate(cacheLoadMs + firstQueryMs, coldMs);
    const metrics = {
        lines, coldMs, coldLocPerSec, cacheLoadMs, firstQueryMs, warmColdRatio,
        queryP50Ms, queryP95Ms, peakRssMb, queryErrors,
    };
    const { failures, warnings } = evaluatePerformanceBudgets(metrics, budgets);
    const firstSummary = summarizeSamples(firstQuerySamplesMs);

    process.stdout.write(`  ${fileCount} files, ${lines} LOC | cold ${coldMs}ms (${coldLocPerSec} LOC/s) | ` +
        `cache load median ${cacheLoadMs}ms + first query median ${firstQueryMs}ms ` +
        `(max ${firstSummary.max}ms, n=${firstSummary.count}, ratio ${warmColdRatio})\n`);
    process.stdout.write(`  context board n=${queryTimes.length} | p50 ${queryP50Ms}ms | p95 ${queryP95Ms}ms | ` +
        `RSS ${rssMb}MB, peak ${peakRssMb}MB | errors ${queryErrors}` +
        `${failures.length ? ` | FAIL: ${failures.join('; ')}` : ''}` +
        `${warnings.length ? ` | NOTE: ${warnings.join('; ')}` : ''}\n`);

    return {
        repo: repo.name,
        language: repo.language,
        commit: repo.commit,
        files: fileCount,
        lines,
        coldMs,
        coldLocPerSec,
        cacheSaveMs,
        cacheLoadMs,
        cacheLoadSamplesMs,
        firstQueryMs,
        firstQuerySamplesMs,
        firstQueryMaxMs: firstSummary.max,
        firstQuerySpreadMs: firstSummary.spread,
        warmColdRatio,
        queryCount: queryTimes.length,
        queryP50Ms,
        queryP95Ms,
        queryMaxMs: Number(Math.max(...queryTimes).toFixed(3)),
        queryErrors,
        rssMb,
        peakRssMb,
        failures,
        warnings,
    };
}

function workerArgs(repo, resultPath) {
    const passthrough = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--worker-repo' || args[i] === '--worker-result') {
            i++;
            continue;
        }
        passthrough.push(args[i]);
    }
    return [...process.execArgv, __filename, ...passthrough,
        '--worker-repo', repo.name, '--worker-result', resultPath];
}

async function workerMain() {
    if (!workerResultPath) throw new Error('--worker-result is required with --worker-repo');
    const repo = REPOS.find(candidate => candidate.name === workerRepoName);
    if (!repo) throw new Error(`Unknown worker repository: ${workerRepoName}`);
    let result;
    try {
        result = await evaluateRepo(repo);
    } catch (error) {
        process.stderr.write(`  FAILED ${repo.name}: ${error.stack || error.message}\n`);
        result = { repo: repo.name, language: repo.language, error: error.message, failures: [error.message] };
    }
    fs.writeFileSync(workerResultPath, JSON.stringify(result));
}

async function main() {
    const baseRepos = releaseOnly ? RELEASE_REPOS : REPOS;
    const repos = baseRepos.filter(repo => !repoNames || repoNames.has(repo.name));
    if (repos.length === 0) throw new Error(`No repositories match --repo ${repoArg || '(all)'}`);
    if (repoNames) {
        const missing = [...repoNames].filter(name => !repos.some(repo => repo.name === name));
        if (missing.length) throw new Error(`Unknown repositories: ${missing.join(', ')}`);
    }

    const results = [];
    let failed = false;
    const workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-perf-workers-'));
    try {
        for (const repo of repos) {
            const resultPath = path.join(workerDir, `${repo.name}.json`);
            const child = spawnSync(process.execPath, workerArgs(repo, resultPath), {
                cwd: process.cwd(),
                env: process.env,
                stdio: 'inherit',
                timeout: 10 * 60 * 1000,
            });
            if (child.error || child.status !== 0 || !fs.existsSync(resultPath)) {
                const message = child.error?.message || `performance worker exited ${child.status}`;
                results.push({ repo: repo.name, language: repo.language, error: message, failures: [message] });
                failed = true;
                continue;
            }
            const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
            results.push(result);
            if (result.failures.length) failed = true;
        }
    } finally {
        fs.rmSync(workerDir, { recursive: true, force: true });
    }

    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const report = { date, budgets, results, passed: !failed };
    const jsonPath = path.join(REPORTS_DIR, `performance-gate-${date}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

    const md = [
        `# UCN performance gate - ${date}`,
        '',
        `Real pinned repositories; cold AST build, ${startupSamples} isolated persisted-index startup samples, ` +
            'and a steady-state pinned `context` board.',
        '',
        '| repo | files | LOC | cold | LOC/s | cache load median | first query median/max | warm/cold | query p50 | query p95 | peak RSS | result |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
        ...results.map(r => r.error
            ? `| ${r.repo} | - | - | - | - | - | - | - | - | - | - | **ERROR: ${r.error}** |`
            : `| ${r.repo} | ${r.files} | ${r.lines} | ${r.coldMs}ms | ${r.coldLocPerSec} | ${r.cacheLoadMs}ms | ${r.firstQueryMs}/${r.firstQueryMaxMs}ms | ${r.warmColdRatio} | ${r.queryP50Ms}ms | ${r.queryP95Ms}ms | ${r.peakRssMb}MB | ${r.failures.length ? `**FAIL:** ${r.failures.join('; ')}` : r.warnings.length ? `PASS (${r.warnings.join('; ')})` : 'PASS'} |`),
        '',
        `Budgets: ${JSON.stringify(budgets)}.`,
    ];
    const mdPath = path.join(REPORTS_DIR, `performance-gate-${date}.md`);
    fs.writeFileSync(mdPath, md.join('\n'));
    process.stdout.write(`\nwrote ${path.relative(process.cwd(), jsonPath)}\nwrote ${path.relative(process.cwd(), mdPath)}\n`);
    process.exitCode = failed ? 1 : 0;
}

if (require.main === module) {
    const entry = workerRepoName ? workerMain : main;
    entry().catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { evaluateRepo, percentile, callableBoard };
