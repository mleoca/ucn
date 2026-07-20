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

function healthyMetrics(overrides = {}) {
    return {
        lines: 80000,
        coldMs: 3000,
        coldLocPerSec: 26666,
        cacheLoadMs: 25,
        firstQueryMs: 450,
        warmColdRatio: 0.158,
        queryP50Ms: 30,
        queryP95Ms: 200,
        peakRssMb: 700,
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

    it('fails steady-state latency even when startup is healthy', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({ queryP95Ms: 251 }));
        assert.ok(verdict.failures.some(failure => failure.includes('query p95')));
    });

    it('fails query errors and isolated peak memory independently', () => {
        const verdict = evaluatePerformanceBudgets(healthyMetrics({
            peakRssMb: DEFAULT_BUDGETS.maxRssMb + 1,
            queryErrors: 2,
        }));
        assert.ok(verdict.failures.some(failure => failure.includes('peak RSS')));
        assert.ok(verdict.failures.some(failure => failure.includes('2 semantic query error')));
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
