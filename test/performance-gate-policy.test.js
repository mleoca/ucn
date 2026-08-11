'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const {
    DEFAULT_BUDGETS,
    summarizeSamples,
    evaluatePerformanceBudgets,
} = require('../eval/performance-gate-policy');
const { aggregateRepoRuns } = require('../eval/run-performance-gate');

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
