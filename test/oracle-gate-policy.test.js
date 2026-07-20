'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { optionalRate, evaluateOracleCoverage } = require('../eval/oracle-gate-policy');

describe('oracle gate policy', () => {
    it('validates rate arguments instead of letting NaN disable a release gate', () => {
        assert.equal(optionalRate('0.98', '--min-precision'), 0.98);
        assert.equal(optionalRate(null, '--min-precision'), null);
        assert.throws(() => optionalRate('nope', '--min-precision'), /0 to 1/);
        assert.throws(() => optionalRate('1.01', '--min-precision'), /0 to 1/);
    });

    it('accepts the measured Clap configuration coverage', () => {
        const verdict = evaluateOracleCoverage({
            confirmedEdges: 2032,
            unverifiedEdges: 1555,
            configurationGatedUnscored: 167,
            calleeSites: 2274,
            calleeUnscoredSites: 2,
        }, 0.10);
        assert.deepEqual(verdict.failures, []);
        assert.ok(verdict.precisionUnscoredRatio < 0.05);
    });

    it('fails when configuration filtering makes the scored subset unrepresentative', () => {
        const verdict = evaluateOracleCoverage({
            confirmedEdges: 50,
            unverifiedEdges: 50,
            configurationGatedUnscored: 25,
            calleeSites: 90,
            calleeUnscoredSites: 20,
        }, 0.10);
        assert.equal(verdict.failures.length, 2);
        assert.match(verdict.failures[0], /precision configuration-unscored/);
        assert.match(verdict.failures[1], /callee configuration-unscored/);
    });

    it('remains report-only when no coverage ceiling is requested', () => {
        const verdict = evaluateOracleCoverage({
            confirmedEdges: 4,
            configurationGatedUnscored: 1,
        }, null);
        assert.deepEqual(verdict.failures, []);
        assert.equal(verdict.precisionUnscoredRatio, 0.25,
            'report-only runs must still expose the measured coverage');
    });

    it('rejects a valueless release threshold instead of silently disabling it', () => {
        const script = path.join(__dirname, '..', 'eval', 'run-oracle-eval.js');
        const result = spawnSync(process.execPath, [script, '--max-unscored-ratio'], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /requires a value/);
    });
});
