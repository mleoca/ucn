'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmp, rm } = require('./helpers');
const { RELEASE_REPOS, RELEASE_REPO_NAMES } = require('../eval/lib/repos');

const {
    DEFAULT_BUDGETS,
    summarizeSamples,
    evaluatePerformanceBudgets,
} = require('../eval/performance-gate-policy');
const {
    aggregateRepoRuns,
    collectPerformanceRollup,
} = require('../eval/run-performance-gate');

function healthyMetrics(overrides = {}) {
    return {
        lines: 80000,
        coldMs: 3000,
        coldCpuMs: 9000,
        coldLocPerSec: 26666,
        coldLocPerCpuSec: 8888,
        cacheLoadMs: 25,
        firstQueryMs: 450,
        warmColdRatio: 0.158,
        queryP50Ms: 30,
        queryP95Ms: 200,
        buildPeakRssMb: 650,
        boardPeakRssMb: 700,
        requestedWorkerCount: 4,
        actualWorkerCount: 4,
        workerPinMismatch: false,
        queryErrors: 0,
        ...overrides,
    };
}

describe('performance gate policy', () => {
    it('uses the median so one noisy startup sample cannot fail a release', () => {
        const summary = summarizeSamples([438, 722, 456]);
        assert.equal(summary.median, 456);
        assert.equal(summary.max, 722);
        assert.equal(summary.spread, 284);
    });

    it('aggregates isolated cold processes by median but never averages away peak memory', () => {
        const run = (coldMs, coldCpuMs, buildPeakRssMb, boardPeakRssMb) => ({
            repo: 'fixture', language: 'cpp', commit: 'abc', files: 20,
            lines: 80000, coldMs, coldCpuMs, coldLocPerSec: 0,
            coldLocPerCpuSec: 0, cacheSaveMs: 10,
            cacheLoadMs: 20, cacheLoadSamplesMs: [20, 21, 22],
            firstQueryMs: 30, firstQuerySamplesMs: [29, 30, 31],
            firstQueryMaxMs: 31, firstQuerySpreadMs: 2,
            warmColdRatio: 0.01, queryCount: 40, queryP50Ms: 10,
            queryP95Ms: 20, queryMaxMs: 40, slowestQueries: [],
            queryErrors: 0, rssMb: 500, buildPeakRssMb, boardPeakRssMb,
            peakRssMb: boardPeakRssMb, availableParallelism: 8,
            requestedWorkerCount: 4, actualWorkerCount: 4,
            workerPinMismatch: false,
            failures: [], warnings: [],
        });
        const result = aggregateRepoRuns(
            { name: 'fixture', language: 'cpp' },
            [run(3000, 8000, 700, 750), run(9000, 10000, 800, 900),
                run(4000, 9000, 1600, 1700)],
        );
        assert.equal(result.coldMs, 4000);
        assert.equal(result.coldLocPerSec, 20000);
        assert.equal(result.coldCpuMs, 9000);
        assert.equal(result.coldLocPerCpuSec, 8888.889);
        assert.equal(result.buildPeakRssMb, 1600);
        assert.equal(result.boardPeakRssMb, 1700);
        assert.ok(result.failures.some(failure => failure.includes('build peak RSS')));
        assert.ok(result.failures.some(failure => failure.includes('board peak RSS')));
    });

    it('matches the failed GitHub runner case as a host-normalized warning', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({
            coldMs: 2919.787,
            firstQueryMs: 634.099,
            warmColdRatio: 0.226,
            queryP50Ms: 28.474,
            queryP95Ms: 206.936,
            peakRssMb: 800,
        }));
        assert.deepEqual(verdict.failures, []);
        assert.equal(verdict.warnings.length, 1);
        assert.match(verdict.warnings[0], /host-normalized/);
    });

    it('gates CPU throughput while wall throughput remains diagnostic', () => {
        const slowWall = evaluatePerformanceBudgets(healthyMetrics({
            coldLocPerSec: DEFAULT_BUDGETS.minColdLocPerSec - 1,
        }));
        assert.deepEqual(slowWall.failures, []);
        assert.ok(slowWall.warnings.some(warning => warning.includes('wall throughput')));

        const slowCpu = evaluatePerformanceBudgets(healthyMetrics({
            coldLocPerCpuSec: DEFAULT_BUDGETS.minColdLocPerCpuSec - 1,
        }));
        assert.ok(slowCpu.failures.some(failure => failure.includes('CPU throughput')));
    });

    it('makes the known fmt regression release-blocking through measured wall throughput', () => {
        const metrics = healthyMetrics({
            repo: 'fmt',
            files: 75,
            lines: 69630,
            coldLocPerSec: 8075,
            coldLocPerCpuSec: 4163,
        });
        const exploratory = evaluatePerformanceBudgets(metrics);
        assert.deepEqual(exploratory.failures, []);
        assert.ok(exploratory.warnings.some(warning => warning.includes('wall throughput')));

        const release = evaluatePerformanceBudgets(metrics, {
            ...DEFAULT_BUDGETS,
            requireColdWallThroughput: true,
        });
        assert.ok(release.failures.some(failure => failure.includes('wall throughput')));
    });

    it('fails when a pinned repository workload silently changes', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({
            files: 101,
            lines: 22652,
            expectedFiles: 101,
            expectedLines: 14199,
        }));
        assert.ok(verdict.failures.some(failure => failure.includes('workload LOC')));
    });

    it('fails a real startup regression when absolute and relative budgets both regress', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({
            coldMs: 1000,
            firstQueryMs: 720,
            warmColdRatio: 0.74,
        }));
        assert.equal(verdict.failures.length, 1);
        assert.match(verdict.failures[0], /semantic startup/);
    });

    it('keeps small repositories on the absolute startup ceiling', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({
            lines: 4000,
            coldMs: 300,
            firstQueryMs: 510,
            warmColdRatio: 1.8,
        }));
        assert.equal(verdict.failures.length, 1);
        assert.match(verdict.failures[0], /first semantic query/);
    });

    it('keys startup policy to project size rather than host-dependent cold time', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({
            lines: 6000,
            coldMs: 300,
            firstQueryMs: 700,
            warmColdRatio: 0.1,
        }));
        assert.deepEqual(verdict.failures, []);
        assert.ok(verdict.warnings.some(warning => warning.includes('first semantic query')));
    });

    it('fails steady-state latency even when startup is healthy', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({ queryP95Ms: 251 }));
        assert.ok(verdict.failures.some(failure => failure.includes('query p95')));
    });

    it('fails query errors and isolated peak memory independently', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({
            buildPeakRssMb: DEFAULT_BUDGETS.maxBuildRssMb + 1,
            boardPeakRssMb: DEFAULT_BUDGETS.maxBoardRssMb + 1,
            queryErrors: 2,
        }));
        assert.ok(verdict.failures.some(failure => failure.includes('build peak RSS')));
        assert.ok(verdict.failures.some(failure => failure.includes('board peak RSS')));
        assert.ok(verdict.failures.some(failure => failure.includes('2 semantic query error')));
    });

    it('fails when the measured worker shape disagrees with the release pin', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({
            actualWorkerCount: 3,
            workerPinMismatch: true,
        }));
        assert.ok(verdict.failures.some(failure => failure.includes('worker pin')));
    });

    it('pins an exact file and LOC workload for every release repository', () => {
        assert.deepEqual(RELEASE_REPOS.map(repo => repo.name), RELEASE_REPO_NAMES);
        for (const repo of RELEASE_REPOS) {
            assert.ok(Number.isInteger(repo.performanceWorkload?.files), repo.name);
            assert.ok(Number.isInteger(repo.performanceWorkload?.lines), repo.name);
        }
        const cjson = RELEASE_REPOS.find(repo => repo.name === 'cjson');
        assert.deepEqual(cjson.performanceWorkload, { files: 101, lines: 22652 });
    });

    it('keeps a scoped smoke run from overwriting stronger full-board evidence', () => {
        const date = '2026-08-11';
        const result = (repo, coldLocPerCpuSec) => ({
            repo,
            coldLocPerCpuSec,
            coldLocPerSec: 12000,
            failures: [],
        });
        const release = {
            generatedAt: `${date}T10:00:00.000Z`,
            scope: 'release',
            release: true,
            processSamples: 3,
            results: RELEASE_REPO_NAMES.map(name => result(name, 5000)),
        };
        const scoped = {
            generatedAt: `${date}T11:00:00.000Z`,
            scope: 'scoped-cjson-fmt',
            release: false,
            processSamples: 3,
            results: [result('cjson', 1), result('fmt', 1)],
        };
        const dir = tmp({
            [`performance-gate-run-release-${date}.json`]: JSON.stringify(release),
            [`performance-gate-run-scoped-cjson-fmt-${date}.json`]: JSON.stringify(scoped),
        });
        try {
            const rollup = collectPerformanceRollup(dir, date);
            assert.equal(rollup.completeReleaseBoard, true);
            assert.equal(rollup.passed, true);
            assert.equal(rollup.results.length, RELEASE_REPO_NAMES.length);
            const cjson = rollup.results.find(row => row.repo === 'cjson');
            assert.equal(cjson.coldLocPerCpuSec, 5000);
            assert.equal(cjson.evidence.scope, 'release');
        } finally { rm(dir); }
    });

    it('never calls a collection of scoped reports a complete release board', () => {
        const date = '2026-08-11';
        const scoped = {
            generatedAt: `${date}T11:00:00.000Z`,
            scope: 'scoped-all',
            release: false,
            processSamples: 3,
            results: RELEASE_REPO_NAMES.map(repo => ({ repo, failures: [] })),
        };
        const rollup = collectPerformanceRollup('/does/not/exist', date, scoped);
        assert.equal(rollup.results.length, RELEASE_REPO_NAMES.length);
        assert.equal(rollup.completeReleaseBoard, false);
        assert.equal(rollup.passed, false);
    });

    it('rejects missing and fractional query-count values before repository setup', () => {
        const script = path.join(__dirname, '..', 'eval', 'run-performance-gate.js');
        const missing = spawnSync(process.execPath, [script, '--queries'], { encoding: 'utf8' });
        const fractional = spawnSync(process.execPath, [script, '--queries', '1.5'], { encoding: 'utf8' });
        assert.notEqual(missing.status, 0);
        assert.match(missing.stderr, /requires a value/);
        assert.notEqual(fractional.status, 0);
        assert.match(fractional.stderr, /positive integer/);
    });
});
