'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const {
    PORTABLE_AST_REVIEW_BUDGETS,
    optionalRate,
    optionalNonNegative,
    summarizeReviewBurden,
    evaluateReviewBurden,
    evaluateOracleCoverage,
} = require('../eval/oracle-gate-policy');

describe('oracle gate policy', () => {
    it('validates rate arguments instead of letting NaN disable a release gate', () => {
        assert.equal(optionalRate('0.98', '--min-precision'), 0.98);
        assert.equal(optionalRate(null, '--min-precision'), null);
        assert.throws(() => optionalRate('nope', '--min-precision'), /0 to 1/);
        assert.throws(() => optionalRate('1.01', '--min-precision'), /0 to 1/);
    });

    it('validates count and amplification thresholds', () => {
        assert.equal(optionalNonNegative('5', '--max-unverified-p95', true), 5);
        assert.equal(optionalNonNegative('0.1',
            '--max-unverified-review-items-per-oracle-edge'), 0.1);
        assert.equal(optionalNonNegative(null, '--max-unverified-p95', true), null);
        assert.throws(() => optionalNonNegative('-1', '--max-unverified-p95', true),
            /non-negative integer/);
        assert.throws(() => optionalNonNegative('1.5', '--max-unverified-p95', true),
            /non-negative integer/);
    });

    it('summarizes the review burden an agent sees', () => {
        const metrics = summarizeReviewBurden({
            symbols: [
                { unverified: 0, actionableUnverified: 0 },
                { unverified: 1, actionableUnverified: 1,
                    actionableUnverifiedHits: 1 },
                { unverified: 5, actionableUnverified: 5,
                    actionableUnverifiedHits: 1,
                    actionableUnverifiedUnscored: 1 },
                { unverified: 4, actionableUnverified: 2,
                    actionableUnverifiedHits: 1,
                    runtimeDispatchSites: 2, runtimeDispatchGroups: 1,
                    runtimeDispatchHits: 1 },
                { error: 'not evaluated', unverified: 99,
                    actionableUnverified: 99 },
            ],
            oracleCallEdges: 20,
            placement: { confirmed: 14, unverified: 4, missingExplained: 2 },
            unverifiedEdges: 10,
            unverifiedHits: 4,
            unverifiedUnscored: 1,
        });
        assert.deepEqual(metrics, {
            reviewedSymbols: 4,
            zeroActionableUnverifiedTargets: 1,
            zeroActionableUnverifiedTargetRate: 0.25,
            actionableUnverifiedCandidatesP50: 1,
            actionableUnverifiedCandidatesP95: 5,
            actionableUnverifiedCandidatesMax: 5,
            actionableUnverifiedCandidates: 8,
            actionableUnverifiedScored: 7,
            actionableUnverifiedUnscored: 1,
            actionableUnverifiedHits: 3,
            actionableFalseUnverifiedCandidates: 4,
            runtimeDispatchSites: 2,
            runtimeDispatchGroups: 1,
            runtimeDispatchReviewItems: 1,
            semanticEligibleEdges: 18,
            trueEdgesUnverified: 4,
            trueEdgeUnverifiedRate: 0.2222,
            unverifiedCandidates: 10,
            unverifiedScoredEdges: 9,
            unverifiedUnscored: 1,
            unverifiedHits: 4,
            unverifiedPrecision: 0.4444,
            rawFalseUnverifiedCandidates: 5,
            rawFalseUnverifiedPerOracleEdge: 0.2778,
            unverifiedReviewItems: 5,
            unverifiedReviewItemsPerOracleEdge: 0.2778,
            unverifiedCandidatesPerOracleEdge: 0.5556,
        });
    });

    it('fails each portable-AST review-burden ceiling independently', () => {
        const verdict = evaluateReviewBurden({
            trueEdgeUnverifiedRate: 0.11,
            zeroActionableUnverifiedTargetRate: 0.79,
            actionableUnverifiedCandidatesP95: 6,
            unverifiedReviewItemsPerOracleEdge: 0.11,
        }, PORTABLE_AST_REVIEW_BUDGETS, 'fixture');
        assert.equal(verdict.failures.length, 4);
        assert.match(verdict.failures[0], /true-edge unverified rate/);
        assert.match(verdict.failures[1], /unverified candidates p95/);
        assert.match(verdict.failures[2], /unverified review items/);
        assert.match(verdict.failures[3], /zero-actionable-ambiguity target rate/);
    });

    it('accepts review burden exactly at the portable-AST ceilings', () => {
        const verdict = evaluateReviewBurden({
            trueEdgeUnverifiedRate: 0.10,
            zeroActionableUnverifiedTargetRate: 0.80,
            actionableUnverifiedCandidatesP95: 5,
            unverifiedReviewItemsPerOracleEdge: 0.10,
        }, PORTABLE_AST_REVIEW_BUDGETS);
        assert.deepEqual(verdict.failures, []);
    });

    it('separates named runtime dispatch from actionable ambiguity without hiding raw edges', () => {
        const metrics = summarizeReviewBurden({
            symbols: [
                {
                    unverified: 21,
                    actionableUnverified: 0,
                    runtimeDispatchSites: 21,
                    runtimeDispatchGroups: 1,
                },
            ],
            oracleCallEdges: 100,
            placement: { unverified: 2 },
            unverifiedEdges: 21,
            unverifiedHits: 2,
        });
        assert.strictEqual(metrics.zeroActionableUnverifiedTargetRate, 1);
        assert.strictEqual(metrics.actionableUnverifiedCandidatesP95, 0);
        assert.strictEqual(metrics.runtimeDispatchSites, 21);
        assert.strictEqual(metrics.runtimeDispatchGroups, 1);
        assert.strictEqual(metrics.unverifiedCandidates, 21,
            'raw candidates remain visible and scored');
        assert.strictEqual(metrics.rawFalseUnverifiedCandidates, 19);
        assert.strictEqual(metrics.rawFalseUnverifiedPerOracleEdge, 0.19,
            'raw false-candidate amplification remains visible');
        assert.strictEqual(metrics.unverifiedReviewItems, 1);
        assert.strictEqual(metrics.unverifiedReviewItemsPerOracleEdge, 0.01,
            'one named runtime boundary is one agent-facing review item');
    });

    it('accepts the measured Clap configuration coverage', () => {
        const verdict = evaluateOracleCoverage({
            confirmedEdges: 2032,
            confirmedUnscored: 20,
            unverifiedEdges: 1555,
            unverifiedUnscored: 147,
            calleeSites: 2274,
            calleeUnscoredSites: 2,
        }, 0.10);
        assert.deepEqual(verdict.failures, []);
        assert.ok(verdict.precisionUnscoredRatio < 0.01);
        assert.ok(verdict.unverifiedUnscoredRatio < 0.10);
    });

    it('fails when configuration filtering makes the scored subset unrepresentative', () => {
        const verdict = evaluateOracleCoverage({
            confirmedEdges: 50,
            confirmedUnscored: 25,
            unverifiedEdges: 50,
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
            confirmedUnscored: 1,
        }, null);
        assert.deepEqual(verdict.failures, []);
        assert.equal(verdict.precisionUnscoredRatio, 0.25,
            'report-only runs must still expose the measured coverage');
    });

    it('reports configuration-gated abstentions without weakening confirmed precision coverage', () => {
        const verdict = evaluateOracleCoverage({
            confirmedEdges: 100,
            confirmedUnscored: 0,
            unverifiedEdges: 1000,
            unverifiedUnscored: 800,
        }, 0.10);
        assert.deepEqual(verdict.failures, []);
        assert.equal(verdict.precisionUnscoredRatio, 0);
        assert.equal(verdict.unverifiedUnscoredRatio, 0.8);
    });

    it('rejects a valueless release threshold instead of silently disabling it', () => {
        const script = path.join(__dirname, '..', 'eval', 'run-oracle-eval.js');
        const result = spawnSync(process.execPath, [script, '--max-unscored-ratio'], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /requires a value/);
    });

    it('rejects valueless review-burden thresholds', () => {
        const script = path.join(__dirname, '..', 'eval', 'run-oracle-eval.js');
        for (const flag of [
            '--max-true-edge-unverified-rate',
            '--min-zero-unverified-rate',
            '--max-unverified-p95',
            '--max-unverified-review-items-per-oracle-edge',
        ]) {
            const result = spawnSync(process.execPath, [script, flag], { encoding: 'utf8' });
            assert.notEqual(result.status, 0, flag);
            assert.match(result.stderr, /requires a value/, flag);
        }
    });
});
