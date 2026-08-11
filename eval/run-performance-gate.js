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
const {
    REPOS,
    RELEASE_REPOS,
    RELEASE_REPO_NAMES,
    cloneAtCommit,
    resolveTarget,
} = require('./lib/repos');
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
const processSamples = positiveInteger('--samples', releaseOnly ? 3 : 1);
const workerRepoName = readArg('--worker-repo');
const workerResultPath = readArg('--worker-result');
const workerQuiet = args.includes('--worker-quiet');
const requestedWorkerCount = envPositiveInteger('UCN_WORKERS');
const requireColdWallThroughput = releaseOnly ||
    args.includes('--require-wall-throughput');
const legacyMaxRssMb = positiveNumber('--max-rss-mb', DEFAULT_BUDGETS.maxBuildRssMb);
const budgets = {
    minColdLocPerSec: positiveNumber('--min-cold-loc-sec', DEFAULT_BUDGETS.minColdLocPerSec),
    minColdLocPerCpuSec: positiveNumber(
        '--min-cold-loc-cpu-sec', DEFAULT_BUDGETS.minColdLocPerCpuSec),
    requireColdWallThroughput,
    maxCacheLoadMs: positiveNumber('--max-cache-load-ms', DEFAULT_BUDGETS.maxCacheLoadMs),
    maxFirstQueryMs: positiveNumber('--max-first-query-ms', DEFAULT_BUDGETS.maxFirstQueryMs),
    maxWarmColdRatio: positiveNumber('--max-warm-cold-ratio', DEFAULT_BUDGETS.maxWarmColdRatio),
    maxQueryP50Ms: positiveNumber('--max-query-p50-ms', DEFAULT_BUDGETS.maxQueryP50Ms),
    maxQueryP95Ms: positiveNumber('--max-query-p95-ms', DEFAULT_BUDGETS.maxQueryP95Ms),
    maxBuildRssMb: positiveNumber('--max-build-rss-mb', legacyMaxRssMb),
    maxBoardRssMb: positiveNumber('--max-board-rss-mb', legacyMaxRssMb),
};
const REPORTS_DIR = path.resolve(
    process.env.UCN_EVAL_REPORTS_DIR || path.join(__dirname, 'reports'));

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

function envPositiveInteger(name) {
    const raw = process.env[name];
    if (raw == null || raw === '') return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer (got ${raw})`);
    }
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
    if (!workerQuiet) {
        process.stdout.write(`\n=== ${repo.name} (${repo.language}) @ ${repo.commit.slice(0, 8)} ===\n`);
    }

    if (global.gc) global.gc();
    let cold = new ProjectIndex(target);
    const coldCpuStart = process.cpuUsage();
    const coldStart = performance.now();
    cold.build(null, { quiet: true });
    const coldMs = elapsed(coldStart);
    const coldCpuUsage = process.cpuUsage(coldCpuStart);
    const coldCpuMs = Number(((coldCpuUsage.user + coldCpuUsage.system) / 1000).toFixed(3));
    const buildPeakRssMb = Number((process.resourceUsage().maxRSS / 1024).toFixed(1));
    const lines = indexLineCount(cold);
    const fileCount = cold.files.size;
    const coldLocPerSec = rate(lines * 1000, coldMs);
    const coldLocPerCpuSec = rate(lines * 1000, coldCpuMs);
    const availableParallelism = typeof os.availableParallelism === 'function'
        ? os.availableParallelism() : os.cpus().length;
    const actualWorkerCount = cold.lastBuildWorkerCount || 1;
    const expectedWorkerCount = requestedWorkerCount == null
        ? null : Math.min(requestedWorkerCount, Math.max(fileCount, 1));
    const workerPinMismatch = expectedWorkerCount != null &&
        actualWorkerCount !== expectedWorkerCount;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ucn-perf-${repo.name}-`));
    const cachePath = path.join(tempDir, 'index.json');
    let cacheSaveMs;
    let cacheLoadMs;
    let firstQueryMs;
    let queryErrors = 0;
    let queryTimes = [];
    const querySamples = [];
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
            const durationMs = elapsed(started);
            queryTimes.push(durationMs);
            querySamples.push({
                name: def.name,
                file: def.relativePath,
                line: def.startLine,
                durationMs,
            });
            if (!result.ok) queryErrors++;
        }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    const queryP50Ms = Number(percentile(queryTimes, 0.50).toFixed(3));
    const queryP95Ms = Number(percentile(queryTimes, 0.95).toFixed(3));
    if (global.gc) global.gc();
    const rssMb = Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1));
    const boardPeakRssMb = Number((process.resourceUsage().maxRSS / 1024).toFixed(1));
    const warmColdRatio = rate(cacheLoadMs + firstQueryMs, coldMs);
    const metrics = {
        repo: repo.name,
        commit: repo.commit,
        files: fileCount,
        lines,
        expectedFiles: repo.performanceWorkload?.files,
        expectedLines: repo.performanceWorkload?.lines,
        coldMs, coldCpuMs, coldLocPerSec, coldLocPerCpuSec,
        cacheLoadMs, firstQueryMs, warmColdRatio,
        queryP50Ms, queryP95Ms, buildPeakRssMb, boardPeakRssMb,
        requestedWorkerCount, actualWorkerCount, workerPinMismatch, queryErrors,
    };
    const { failures, warnings } = evaluatePerformanceBudgets(metrics, budgets);
    const firstSummary = summarizeSamples(firstQuerySamplesMs);
    const slowestQueries = [...querySamples]
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 5);

    if (!workerQuiet) {
        process.stdout.write(`  ${fileCount} files, ${lines} LOC | cold ${coldMs}ms ` +
            `(${coldLocPerSec} LOC/s wall; ${coldCpuMs} CPU-ms, ` +
            `${coldLocPerCpuSec} LOC/CPU-s) | ` +
            `cache load median ${cacheLoadMs}ms + first query median ${firstQueryMs}ms ` +
            `(max ${firstSummary.max}ms, n=${firstSummary.count}, ratio ${warmColdRatio})\n`);
        process.stdout.write(`  context board n=${queryTimes.length} | p50 ${queryP50Ms}ms | p95 ${queryP95Ms}ms | ` +
            `RSS ${rssMb}MB, build/board peak ${buildPeakRssMb}/${boardPeakRssMb}MB | ` +
            `workers ${actualWorkerCount}${requestedWorkerCount == null ? ' auto' : `/${requestedWorkerCount} pinned`} ` +
            `(host ${availableParallelism}) | errors ${queryErrors}` +
            `${failures.length ? ` | FAIL: ${failures.join('; ')}` : ''}` +
            `${warnings.length ? ` | NOTE: ${warnings.join('; ')}` : ''}\n`);
        if (queryP95Ms > budgets.maxQueryP95Ms ||
            slowestQueries[0]?.durationMs > budgets.maxQueryP95Ms) {
            process.stdout.write(`  slowest: ${slowestQueries.map(query =>
                `${query.file}:${query.line}:${query.name} ${query.durationMs}ms`)
                .join(' | ')}\n`);
        }
    }

    return {
        repo: repo.name,
        language: repo.language,
        commit: repo.commit,
        files: fileCount,
        lines,
        expectedFiles: repo.performanceWorkload?.files,
        expectedLines: repo.performanceWorkload?.lines,
        coldMs,
        coldCpuMs,
        coldLocPerSec,
        coldLocPerCpuSec,
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
        slowestQueries,
        queryErrors,
        rssMb,
        buildPeakRssMb,
        boardPeakRssMb,
        // Retained in raw reports as a convenience alias; policy evaluates
        // the two phase-specific values above.
        peakRssMb: boardPeakRssMb,
        availableParallelism,
        requestedWorkerCount,
        actualWorkerCount,
        workerPinMismatch,
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
        '--worker-repo', repo.name, '--worker-result', resultPath,
        '--worker-quiet'];
}

function aggregateRepoRuns(repo, runs) {
    if (runs.some(run => run.error)) {
        const errors = runs.filter(run => run.error).map(run => run.error);
        return {
            repo: repo.name,
            language: repo.language,
            error: `${errors.length}/${runs.length} isolated sample(s) failed: ${errors.join('; ')}`,
            failures: errors,
        };
    }
    const median = values => summarizeSamples(values).median;
    const coldSamplesMs = runs.map(run => run.coldMs);
    const coldCpuSamplesMs = runs.map(run => run.coldCpuMs);
    const coldMs = median(coldSamplesMs);
    const coldCpuMs = median(coldCpuSamplesMs);
    const lines = runs[0].lines;
    const cacheLoadSamplesMs = runs.flatMap(run => run.cacheLoadSamplesMs || [run.cacheLoadMs]);
    const firstQuerySamplesMs = runs.flatMap(run => run.firstQuerySamplesMs || [run.firstQueryMs]);
    const cacheLoadMs = median(cacheLoadSamplesMs);
    const firstQueryMs = median(firstQuerySamplesMs);
    const firstSummary = summarizeSamples(firstQuerySamplesMs);
    const metrics = {
        repo: repo.name,
        commit: runs[0].commit,
        files: runs[0].files,
        lines,
        expectedFiles: runs[0].expectedFiles,
        expectedLines: runs[0].expectedLines,
        coldMs,
        coldCpuMs,
        coldLocPerSec: rate(lines * 1000, coldMs),
        coldLocPerCpuSec: rate(lines * 1000, coldCpuMs),
        cacheLoadMs,
        firstQueryMs,
        warmColdRatio: rate(cacheLoadMs + firstQueryMs, coldMs),
        queryP50Ms: median(runs.map(run => run.queryP50Ms)),
        queryP95Ms: median(runs.map(run => run.queryP95Ms)),
        // Memory safety is not averaged away: one real over-budget process
        // is enough to fail the release even when the other samples are low.
        buildPeakRssMb: Math.max(...runs.map(run => run.buildPeakRssMb)),
        boardPeakRssMb: Math.max(...runs.map(run => run.boardPeakRssMb)),
        requestedWorkerCount: runs[0].requestedWorkerCount,
        actualWorkerCount: runs[0].actualWorkerCount,
        workerPinMismatch: runs.some(run => run.workerPinMismatch) ||
            runs.some(run => run.actualWorkerCount !== runs[0].actualWorkerCount),
        queryErrors: runs.reduce((sum, run) => sum + run.queryErrors, 0),
    };
    const { failures, warnings } = evaluatePerformanceBudgets(metrics, budgets);
    const slowestQueries = runs.flatMap(run => run.slowestQueries || [])
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 5);
    return {
        ...runs[0],
        ...metrics,
        coldSamplesMs,
        coldCpuSamplesMs,
        processSamples: runs.length,
        cacheSaveMs: median(runs.map(run => run.cacheSaveMs)),
        cacheLoadSamplesMs,
        firstQuerySamplesMs,
        firstQueryMaxMs: firstSummary.max,
        firstQuerySpreadMs: firstSummary.spread,
        queryCount: runs[0].queryCount,
        queryMaxMs: Math.max(...runs.map(run => run.queryMaxMs)),
        slowestQueries,
        rssMb: Math.max(...runs.map(run => run.rssMb)),
        peakRssMb: metrics.boardPeakRssMb,
        availableParallelism: runs[0].availableParallelism,
        failures,
        warnings,
    };
}

function printResult(repo, result) {
    process.stdout.write(`\n=== ${repo.name} (${repo.language}) @ ${repo.commit.slice(0, 8)} ===\n`);
    if (result.error) {
        process.stdout.write(`  FAILED ${result.error}\n`);
        return;
    }
    process.stdout.write(`  ${result.files} files, ${result.lines} LOC | cold median ${result.coldMs}ms ` +
        `(${result.coldLocPerSec} LOC/s wall; ${result.coldLocPerCpuSec} LOC/CPU-s; ` +
        `wall samples ${result.coldSamplesMs.join(', ')}; CPU samples ` +
        `${result.coldCpuSamplesMs.join(', ')}) | ` +
        `cache load median ${result.cacheLoadMs}ms + first query median ${result.firstQueryMs}ms ` +
        `(max ${result.firstQueryMaxMs}ms, ratio ${result.warmColdRatio})\n`);
    process.stdout.write(`  context board n=${result.queryCount} x ${result.processSamples} | ` +
        `p50 ${result.queryP50Ms}ms | p95 ${result.queryP95Ms}ms | ` +
        `RSS ${result.rssMb}MB, worst build/board peak ` +
        `${result.buildPeakRssMb}/${result.boardPeakRssMb}MB | workers ` +
        `${result.actualWorkerCount}${result.requestedWorkerCount == null
            ? ' auto' : `/${result.requestedWorkerCount} pinned`} ` +
        `(host ${result.availableParallelism}) | errors ${result.queryErrors}` +
        `${result.failures.length ? ` | FAIL: ${result.failures.join('; ')}` : ''}` +
        `${result.warnings.length ? ` | NOTE: ${result.warnings.join('; ')}` : ''}\n`);
    if (result.queryP95Ms > budgets.maxQueryP95Ms ||
        result.slowestQueries[0]?.durationMs > budgets.maxQueryP95Ms) {
        process.stdout.write(`  slowest: ${result.slowestQueries.map(query =>
            `${query.file}:${query.line}:${query.name} ${query.durationMs}ms`)
            .join(' | ')}\n`);
    }
}

function performanceScope(isFullRelease, repos) {
    if (isFullRelease) return 'release';
    const names = repos.map(repo => repo.name).sort();
    return `scoped-${names.join('-') || 'none'}`;
}

function candidateIsStronger(candidate, current) {
    if (!current) return true;
    const candidateRelease = candidate.report.release ? 1 : 0;
    const currentRelease = current.report.release ? 1 : 0;
    if (candidateRelease !== currentRelease) return candidateRelease > currentRelease;
    const candidateSamples = candidate.report.processSamples || 0;
    const currentSamples = current.report.processSamples || 0;
    if (candidateSamples !== currentSamples) return candidateSamples > currentSamples;
    return String(candidate.report.generatedAt || '') >=
        String(current.report.generatedAt || '');
}

/**
 * Merge same-day invocation reports without allowing a scoped smoke run to
 * erase stronger full-board evidence. A rollup is release-complete only when
 * every required row came from a full release invocation; a collection of
 * partial runs remains useful evidence but cannot impersonate that gate.
 */
function collectPerformanceRollup(reportsDir, date, currentReport = null,
    requiredRepos = RELEASE_REPO_NAMES) {
    const reports = [];
    const suffix = `-${date}.json`;
    if (fs.existsSync(reportsDir)) {
        for (const file of fs.readdirSync(reportsDir)) {
            if (!file.startsWith('performance-gate-run-') ||
                !file.endsWith(suffix)) continue;
            try {
                reports.push({
                    source: file,
                    report: JSON.parse(fs.readFileSync(path.join(reportsDir, file), 'utf8')),
                });
            } catch { /* incomplete artifacts never replace valid evidence */ }
        }
    }
    if (currentReport) reports.push({ source: '(current invocation)', report: currentReport });

    const byRepo = new Map();
    for (const candidate of reports) {
        for (const result of candidate.report.results || []) {
            if (!result?.repo) continue;
            const prior = byRepo.get(result.repo);
            const row = { ...candidate, result };
            if (candidateIsStronger(row, prior)) byRepo.set(result.repo, row);
        }
    }

    const requiredOrder = new Map(requiredRepos.map((name, i) => [name, i]));
    const selected = [...byRepo.values()].sort((a, b) => {
        const ai = requiredOrder.has(a.result.repo)
            ? requiredOrder.get(a.result.repo) : Number.MAX_SAFE_INTEGER;
        const bi = requiredOrder.has(b.result.repo)
            ? requiredOrder.get(b.result.repo) : Number.MAX_SAFE_INTEGER;
        return ai - bi || a.result.repo.localeCompare(b.result.repo);
    });
    const releaseRows = new Set(selected
        .filter(candidate => candidate.report.release)
        .map(candidate => candidate.result.repo));
    const completeReleaseBoard = requiredRepos.every(name => releaseRows.has(name));
    const results = selected.map(candidate => ({
        ...candidate.result,
        evidence: {
            source: candidate.source,
            scope: candidate.report.scope,
            release: Boolean(candidate.report.release),
            processSamples: candidate.report.processSamples,
            generatedAt: candidate.report.generatedAt,
        },
    }));
    const passed = completeReleaseBoard && results
        .filter(result => requiredOrder.has(result.repo))
        .every(result => !result.error && (result.failures || []).length === 0);
    return {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        date,
        requiredRepos: [...requiredRepos],
        completeReleaseBoard,
        passed,
        results,
    };
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
            const runs = [];
            for (let sample = 0; sample < processSamples; sample++) {
                const resultPath = path.join(workerDir, `${repo.name}-${sample}.json`);
                const child = spawnSync(process.execPath, workerArgs(repo, resultPath), {
                    cwd: process.cwd(),
                    env: process.env,
                    stdio: 'inherit',
                    timeout: 10 * 60 * 1000,
                });
                if (child.error || child.status !== 0 || !fs.existsSync(resultPath)) {
                    const message = child.error?.message ||
                        `performance worker exited ${child.status}`;
                    runs.push({ error: message });
                    continue;
                }
                runs.push(JSON.parse(fs.readFileSync(resultPath, 'utf8')));
            }
            const result = aggregateRepoRuns(repo, runs);
            results.push(result);
            printResult(repo, result);
            if (result.failures.length || result.error) failed = true;
        }
    } finally {
        fs.rmSync(workerDir, { recursive: true, force: true });
    }

    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const host = {
        platform: process.platform,
        arch: process.arch,
        availableParallelism: typeof os.availableParallelism === 'function'
            ? os.availableParallelism() : os.cpus().length,
        requestedWorkerCount,
    };
    const isFullRelease = releaseOnly && !repoNames &&
        repos.length === RELEASE_REPO_NAMES.length &&
        repos.every(repo => RELEASE_REPO_NAMES.includes(repo.name));
    const scope = performanceScope(isFullRelease, repos);
    const generatedAt = new Date().toISOString();
    const report = {
        schemaVersion: 2,
        generatedAt,
        date,
        scope,
        release: isFullRelease,
        budgets,
        host,
        processSamples,
        results,
        passed: !failed,
    };
    const jsonPath = path.join(REPORTS_DIR,
        `performance-gate-run-${scope}-${date}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

    const md = [
        `# UCN performance gate - ${date}`,
        '',
        `Real pinned repositories; ${processSamples} isolated cold-build process samples, ` +
            `${startupSamples} persisted-index startup samples per process, ` +
            'and a steady-state pinned `context` board.',
        '',
        `Host: ${host.platform}/${host.arch}; available parallelism ${host.availableParallelism}; ` +
            `worker pin ${host.requestedWorkerCount ?? 'auto'}.`,
        '',
        '| repo | files | LOC | cold wall | wall LOC/s | CPU LOC/s | workers | cache load median | first query median/max | warm/cold | query p50 | query p95 | build/board peak RSS | result |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
        ...results.map(r => r.error
            ? `| ${r.repo} | - | - | - | - | - | - | - | - | - | - | - | - | **ERROR: ${r.error}** |`
            : `| ${r.repo} | ${r.files} | ${r.lines} | ${r.coldMs}ms | ${r.coldLocPerSec} | ${r.coldLocPerCpuSec} | ${r.actualWorkerCount}${r.requestedWorkerCount == null ? '' : `/${r.requestedWorkerCount}`} | ${r.cacheLoadMs}ms | ${r.firstQueryMs}/${r.firstQueryMaxMs}ms | ${r.warmColdRatio} | ${r.queryP50Ms}ms | ${r.queryP95Ms}ms | ${r.buildPeakRssMb}/${r.boardPeakRssMb}MB | ${r.failures.length ? `**FAIL:** ${r.failures.join('; ')}` : r.warnings.length ? `PASS (${r.warnings.join('; ')})` : 'PASS'} |`),
        '',
        `Budgets: ${JSON.stringify(budgets)}.`,
    ];
    const mdPath = path.join(REPORTS_DIR,
        `performance-gate-run-${scope}-${date}.md`);
    fs.writeFileSync(mdPath, md.join('\n'));

    // Keep the historical full-board path for consumers, but scoped runs can
    // never overwrite it. The rollup additionally preserves strongest-row
    // provenance across all same-day invocations.
    const written = [jsonPath, mdPath];
    if (isFullRelease) {
        const legacyJsonPath = path.join(REPORTS_DIR, `performance-gate-${date}.json`);
        const legacyMdPath = path.join(REPORTS_DIR, `performance-gate-${date}.md`);
        fs.writeFileSync(legacyJsonPath, JSON.stringify(report, null, 2));
        fs.writeFileSync(legacyMdPath, md.join('\n'));
        written.push(legacyJsonPath, legacyMdPath);
    }

    const rollup = collectPerformanceRollup(REPORTS_DIR, date, report);
    const rollupJsonPath = path.join(REPORTS_DIR,
        `performance-gate-rollup-${date}.json`);
    const rollupMdPath = path.join(REPORTS_DIR,
        `performance-gate-rollup-${date}.md`);
    fs.writeFileSync(rollupJsonPath, JSON.stringify(rollup, null, 2));
    const rollupLines = [
        `# UCN performance rollup - ${date}`,
        '',
        `Full release board: ${rollup.completeReleaseBoard ? 'complete' : 'incomplete'}; ` +
            `result: ${rollup.passed ? 'PASS' : 'NOT RELEASE-QUALIFIED'}.`,
        '',
        '| repo | scope | samples | CPU LOC/s | wall LOC/s | result |',
        '|---|---|---:|---:|---:|---|',
        ...rollup.results.map(result =>
            `| ${result.repo} | ${result.evidence.scope || 'unknown'} | ` +
            `${result.evidence.processSamples || '-'} | ${result.coldLocPerCpuSec ?? '-'} | ` +
            `${result.coldLocPerSec ?? '-'} | ` +
            `${result.error || (result.failures || []).join('; ') || 'PASS'} |`),
    ];
    fs.writeFileSync(rollupMdPath, rollupLines.join('\n'));
    written.push(rollupJsonPath, rollupMdPath);
    process.stdout.write(`\n${written.map(file =>
        `wrote ${path.relative(process.cwd(), file)}`).join('\n')}\n`);
    process.exitCode = failed ? 1 : 0;
}

if (require.main === module) {
    const entry = workerRepoName ? workerMain : main;
    entry().catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    evaluateRepo,
    aggregateRepoRuns,
    collectPerformanceRollup,
    performanceScope,
    percentile,
    callableBoard,
};
