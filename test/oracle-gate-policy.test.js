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
    closeJsTsDeclarationIdentity,
} = require('../eval/oracle-gate-policy');

describe('oracle gate policy', () => {
    it('closes TypeScript overloads and declare methods over one implementation', () => {
        const file = '/repo/src/index.ts';
        const overloads = [
            { file, type: 'function', startLine: 10, isSignature: true },
            { file, type: 'function', startLine: 11, isSignature: true },
            { file, type: 'function', startLine: 12 },
            { file, type: 'function', startLine: 30,
                lexicalScopeStartLine: 29, lexicalScopeEndLine: 35 },
        ];
        assert.deepEqual(
            closeJsTsDeclarationIdentity(overloads, overloads[2]),
            overloads.slice(0, 3));

        const declared = { file, type: 'method', startLine: 40,
            className: 'Effect', isSignature: true };
        const installed = { file, type: 'function', startLine: 60,
            className: 'Effect', memberAssigned: true };
        assert.deepEqual(
            closeJsTsDeclarationIdentity([declared, installed], declared),
            [declared, installed]);
    });

    it('never merges duplicate names across owners or lexical scopes', () => {
        const target = { file: '/repo/a.ts', type: 'function', startLine: 10,
            isSignature: true, lexicalScopeStartLine: 1, lexicalScopeEndLine: 20 };
        const otherScope = { file: target.file, type: 'function', startLine: 11,
            lexicalScopeStartLine: 30, lexicalScopeEndLine: 40 };
        const otherOwner = { file: target.file, type: 'method', startLine: 12,
            className: 'Other' };
        assert.deepEqual(closeJsTsDeclarationIdentity(
            [target, otherScope, otherOwner], target), [target]);
    });

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
            compileTimeDispatchSites: 0,
            compileTimeDispatchGroups: 0,
            compileTimeDispatchReviewItems: 0,
            semanticEligibleEdges: 18,
            exactSemanticEligibleEdges: 18,
            nonExactOracleEdges: 0,
            runtimeDependentOracleEdges: 0,
            compilerDependentOracleEdges: 0,
            oracleAbstentionEdges: 0,
            trueEdgesUnverified: 4,
            trueEdgeUnverifiedRate: 0.2222,
            allOracleEdgesUnverified: 4,
            allOracleEdgeUnverifiedRate: 0.2222,
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

    it('separates runtime-polymorphic families from exact target identity', () => {
        const metrics = summarizeReviewBurden({
            symbols: [{
                actionableUnverified: 0,
                runtimeDispatchSites: 21,
                runtimeDispatchGroups: 1,
                runtimeDispatchHits: 20,
            }],
            oracleCallEdges: 100,
            placement: { unverified: 22 },
            exactOracleCallEdges: 80,
            exactPlacement: { unverified: 2 },
            runtimeOracleCallEdges: 20,
            unverifiedEdges: 21,
            unverifiedHits: 20,
        });
        assert.equal(metrics.nonExactOracleEdges, 20);
        assert.equal(metrics.runtimeDependentOracleEdges, 20);
        assert.equal(metrics.compilerDependentOracleEdges, 0);
        assert.equal(metrics.oracleAbstentionEdges, 0);
        assert.equal(metrics.trueEdgeUnverifiedRate, 0.025,
            'strict placement uses only statically exact target identity');
        assert.equal(metrics.allOracleEdgeUnverifiedRate, 0.22,
            'runtime may-dispatch edges remain in the semantic universe');
    });

    it('separates compiler-dependent template families from exact oracle edges', () => {
        const metrics = summarizeReviewBurden({
            symbols: [{
                unverified: 43,
                actionableUnverified: 0,
                compileTimeDispatchSites: 43,
                compileTimeDispatchGroups: 1,
                compileTimeDispatchHits: 20,
            }],
            oracleCallEdges: 100,
            placement: { unverified: 22 },
            exactOracleCallEdges: 80,
            exactPlacement: { unverified: 2 },
            compileTimeOracleCallEdges: 20,
            unverifiedEdges: 43,
            unverifiedHits: 22,
        });
        assert.equal(metrics.nonExactOracleEdges, 20);
        assert.equal(metrics.runtimeDependentOracleEdges, 0);
        assert.equal(metrics.compilerDependentOracleEdges, 20);
        assert.equal(metrics.oracleAbstentionEdges, 0);
        assert.equal(metrics.trueEdgeUnverifiedRate, 0.025,
            'the strict rate contains only statically exact oracle identity');
        assert.equal(metrics.allOracleEdgeUnverifiedRate, 0.22,
            'the raw all-oracle abstention rate remains visible');
        assert.equal(metrics.compileTimeDispatchSites, 43);
        assert.equal(metrics.compileTimeDispatchGroups, 1);
        assert.equal(metrics.actionableUnverifiedCandidatesP95, 0);
        assert.equal(metrics.unverifiedReviewItems, 1,
            'one named compiler handoff is one agent-facing review family');
        assert.equal(metrics.rawFalseUnverifiedCandidates, 21,
            'raw candidates are never removed from the audit');
    });

    it('separates unresolved oracle references from exact target identity', () => {
        const metrics = summarizeReviewBurden({
            symbols: [{ actionableUnverified: 0 }],
            oracleCallEdges: 100,
            placement: { unverified: 22 },
            exactOracleCallEdges: 80,
            exactPlacement: { unverified: 2 },
            unresolvedOracleCallEdges: 20,
        });
        assert.equal(metrics.nonExactOracleEdges, 20);
        assert.equal(metrics.oracleAbstentionEdges, 20);
        assert.equal(metrics.trueEdgeUnverifiedRate, 0.025);
        assert.equal(metrics.allOracleEdgeUnverifiedRate, 0.22);
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

    it('fails when broad reference families cannot be pinned to exact definitions', () => {
        const verdict = evaluateOracleCoverage({
            definitionValidatedOracleCalls: 10,
            oracleBroadReferenceEdges: 5,
            definitionUnresolvedReferenceEdges: 20,
        }, 0.10);
        assert.equal(verdict.failures.length, 1);
        assert.match(verdict.failures[0], /definition-unresolved oracle ratio/);
        assert.equal(verdict.definitionUnresolvedRatio, 20 / 35);
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

describe('fix #286g: coverage gate separates configuration gating from oracle abstention', () => {
    const { evaluateOracleCoverage } = require('../eval/oracle-gate-policy');

    it('definition-unresolved abstentions pass the hard bound up to the 3x ceiling', () => {
        // flask-measured: 27.85% of confirmed edges were pyright abstentions
        // on pytest-fixture receivers — engine-correct confirmations the
        // oracle cannot type. The hard configuration bound must not fire.
        const verdict = evaluateOracleCoverage({
            confirmedEdges: 100,
            confirmedUnscored: 28,
            confirmedAbstentionUnscored: 28,
        }, 0.10);
        assert.deepStrictEqual(verdict.failures, []);
        assert.ok(Math.abs(verdict.precisionAbstentionRatio - 0.28) < 1e-9);
        assert.strictEqual(verdict.precisionConfigGatedRatio, 0);
    });

    it('a runaway abstention band still fails loudly', () => {
        const verdict = evaluateOracleCoverage({
            confirmedEdges: 100,
            confirmedUnscored: 40,
            confirmedAbstentionUnscored: 40,
        }, 0.10);
        assert.ok(verdict.failures.some(f => f.includes('oracle-abstention')));
    });

    it('true configuration gating keeps the hard bound', () => {
        const verdict = evaluateOracleCoverage({
            confirmedEdges: 100,
            confirmedUnscored: 15,
            confirmedAbstentionUnscored: 0,
        }, 0.10);
        assert.ok(verdict.failures.some(f => f.includes('configuration-unscored')));
    });
});

describe('fix #286h: declared-weak definition lookup uses a capability ceiling', () => {
    const { evaluateOracleCoverage } = require('../eval/oracle-gate-policy');

    it('plain-JS oracle mode does not fail the definition-unresolved prong', () => {
        const verdict = evaluateOracleCoverage({
            confirmedEdges: 100,
            definitionAdjudicationUniverse: 100,
            definitionUnresolvedReferenceEdges: 54,
            definitionLookupWeak: true,
            definitionUnresolvedRatioCeiling: 0.60,
        }, 0.10);
        assert.deepStrictEqual(verdict.failures, []);
    });

    it('a declared-weak oracle still fails when definition lookup is totally blind', () => {
        const verdict = evaluateOracleCoverage({
            confirmedEdges: 100,
            definitionAdjudicationUniverse: 100,
            definitionUnresolvedReferenceEdges: 100,
            definitionLookupWeak: true,
            definitionUnresolvedRatioCeiling: 0.60,
        }, 0.10);
        assert.ok(verdict.failures.some(f =>
            f.includes('definition-unresolved oracle ratio 100.00% > 60.00%')));
    });

    it('a full-capability oracle keeps the prong', () => {
        const verdict = evaluateOracleCoverage({
            confirmedEdges: 100,
            definitionAdjudicationUniverse: 100,
            definitionUnresolvedReferenceEdges: 54,
        }, 0.10);
        assert.ok(verdict.failures.some(f => f.includes('definition-unresolved')));
    });
});

describe('fix #292: deferred unresolved adjudication is gate-bearing on a positive pin', () => {
    const { adjudicateDeferredUnresolved } = require('../eval/oracle-gate-policy');

    it('a target pin keeps the edge and restores gate-bearing status', () => {
        assert.deepStrictEqual(adjudicateDeferredUnresolved('target'),
            { keep: true, gateBearing: true });
    });

    it('a broad-family pin drops the edge as a different definition', () => {
        assert.deepStrictEqual(adjudicateDeferredUnresolved('other'),
            { keep: false, bucket: 'broad' });
    });

    it('an oracle abstention drops the edge without punishing the engine', () => {
        assert.deepStrictEqual(adjudicateDeferredUnresolved('unresolved'),
            { keep: false, bucket: 'abstention' });
    });

    it('an unavailable lookup keeps the edge loud but never hard-gates', () => {
        assert.deepStrictEqual(adjudicateDeferredUnresolved('unavailable'),
            { keep: true, gateBearing: false });
    });
});

describe('fix #406: unscored edges are classified by the oracle\'s own projection', () => {
    const fs = require('fs');
    const os = require('os');
    const {
        unscoredProng,
        expandedDefinitionStatus,
    } = require('../eval/oracle-gate-policy');
    const {
        cargoLinkedProjects,
        projectionStatus,
        lineOutsideProjection,
        inlineExpansion,
        originalLine,
        wordOffsets,
    } = require('../eval/oracles/rust-analyzer-oracle');
    const {
        staticConditionRanges,
        STATIC_CONDITION_UNREACHABLE,
    } = require('../eval/oracles/pyright-oracle');

    it('only configuration-gated verdicts enter the configuration prong', () => {
        assert.strictEqual(unscoredProng({ scorable: false, abstention: 'configuration-gated' }),
            'configuration');
        assert.strictEqual(unscoredProng({ scorable: false, abstention: 'definition-unresolved' }),
            'abstention');
        assert.strictEqual(unscoredProng({ scorable: false, abstention: 'macro-template-expansion' }),
            'abstention');
        assert.strictEqual(unscoredProng({ scorable: true, hit: true }), null);
        assert.throws(() => unscoredProng({ scorable: false }), /no abstention class/);
    });

    it('rand: 80 template abstentions no longer read as configuration gating', () => {
        // Weekly Eval run 38261618148: 80 macro-template-expansion + 6
        // definition-unresolved of 317 confirmed edges were tallied 80/6
        // configuration/abstention (25.24% > 10%).
        const verdicts = [
            ...Array(80).fill({ scorable: false, abstention: 'macro-template-expansion' }),
            ...Array(6).fill({ scorable: false, abstention: 'definition-unresolved' }),
        ];
        const abstentions = verdicts.filter(v => unscoredProng(v) === 'abstention').length;
        const coverage = evaluateOracleCoverage({
            confirmedEdges: 317,
            confirmedUnscored: verdicts.length,
            confirmedAbstentionUnscored: abstentions,
        }, 0.10);
        assert.strictEqual(coverage.precisionConfigGatedRatio, 0);
        assert.deepStrictEqual(coverage.failures, []);
    });

    it('a macro expansion scores only what the oracle resolved', () => {
        const target = d => d.file === 'src/u.rs' && d.line === 235;
        assert.strictEqual(expandedDefinitionStatus(null, target), 'unavailable');
        assert.strictEqual(expandedDefinitionStatus({
            definitions: [{ file: 'src/u.rs', line: 235 }, { file: 'src/v.rs', line: 9 }],
            unresolved: 1,
        }, target), 'target');
        assert.strictEqual(expandedDefinitionStatus({
            definitions: [{ file: 'src/v.rs', line: 9 }], unresolved: 0,
        }, target), 'other');
        // An occurrence that resolved nowhere may be the claimed call.
        assert.strictEqual(expandedDefinitionStatus({
            definitions: [{ file: 'src/v.rs', line: 9 }], unresolved: 1,
        }, target), 'unresolved');
        // A declaration the expansion generated is never the source target.
        assert.strictEqual(expandedDefinitionStatus({
            definitions: [{ file: 'src/u.rs', line: 0, generated: true }], unresolved: 0,
        }, () => true), 'other');
        assert.strictEqual(expandedDefinitionStatus({
            definitions: [{ file: '/rustlib/core/simd.rs', line: 3, external: true }], unresolved: 0,
        }, () => true), 'other');
    });

    it('rust-analyzer projection: inactive-code ranges and unlinked files only', () => {
        const status = projectionStatus([
            { code: 'inactive-code', range: { start: { line: 12 }, end: { line: 13 } } },
            { code: 'unused_variables', range: { start: { line: 40 }, end: { line: 40 } } },
        ]);
        assert.deepStrictEqual(status, { unlinked: false, inactive: [[13, 14]] });
        assert.strictEqual(lineOutsideProjection(status, 14), true);
        // An active line is analyzed whatever #[cfg] attributes surround it.
        assert.strictEqual(lineOutsideProjection(status, 15), false);
        assert.strictEqual(lineOutsideProjection(status, 41), false);
        const unlinked = projectionStatus([
            { code: { value: 'unlinked-file' }, range: { start: { line: 0 }, end: { line: 0 } } },
        ]);
        assert.strictEqual(lineOutsideProjection(unlinked, 99), true);
    });

    it('inlines an expansion in the invocation\'s AST position and maps lines back', () => {
        const source = 'fn a() {}\nfn main() {\n    t!(x);\n    a();\n}\n';
        const call = { kind: 'stmt', startLine: 3, startUtf16Col: 4, endLine: 3, endUtf16Col: 9 };
        const inlined = inlineExpansion(source, call, 'let q = a();\nb(q)');
        assert.strictEqual(inlined.text,
            'fn a() {}\nfn main() {\n    {\nlet q = a();\nb(q)\n};\n    a();\n}\n');
        const [inside] = wordOffsets(inlined.replacement, 'a').map(o => o + inlined.start);
        assert.strictEqual(originalLine(inlined, inside), null, 'expansion text has no source line');
        assert.strictEqual(originalLine(inlined, 3), 1, 'before the invocation');
        assert.strictEqual(originalLine(inlined, inlined.text.indexOf('a();\n}')), 4,
            'after the invocation, shifted back');
        assert.match(inlineExpansion(source, { ...call, kind: 'expr' }, 'a()').text, /\(\{\na\(\)\n\}\)/);
        // An item invocation's span includes its own `;` (helper protocol).
        assert.strictEqual(inlineExpansion(source,
            { ...call, kind: 'item', endUtf16Col: 10 }, 'fn g() {}').text,
        'fn a() {}\nfn main() {\n    \nfn g() {}\n\n    a();\n}\n');
        assert.strictEqual(inlineExpansion(source, { ...call, kind: 'other' }, 'x'), null);
        assert.strictEqual(inlineExpansion(source, call, ''), null);
        assert.deepStrictEqual(wordOffsets('new(renew, new_x, new)', 'new'), [0, 18]);
    });

    it('links every Cargo workspace under the target, skipping members and build output', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-406-'));
        try {
            for (const dir of ['', 'crates/a', 'benches', 'target/debug/x', '.github/x', 'broken']) {
                fs.mkdirSync(path.join(root, dir), { recursive: true });
                fs.writeFileSync(path.join(root, dir, 'Cargo.toml'), '[package]\n');
            }
            const manifest = dir => path.join(root, dir, 'Cargo.toml');
            const queried = [];
            const metadata = file => {
                queried.push(path.relative(root, file));
                if (file === manifest('broken')) throw new Error('failed to parse manifest');
                if (file === manifest('benches')) {
                    return { workspaceRoot: path.join(root, 'benches'), memberManifests: [manifest('benches')] };
                }
                return { workspaceRoot: root, memberManifests: [manifest(''), manifest('crates/a')] };
            };
            const logged = [];
            const linked = cargoLinkedProjects(root, root, {
                metadata, log: { write: line => logged.push(line) },
            });
            assert.deepStrictEqual(linked, [manifest(''), manifest('benches')]);
            assert.deepStrictEqual(queried, ['Cargo.toml', 'benches/Cargo.toml', 'broken/Cargo.toml'],
                'members of a loaded workspace and build output are not queried');
            assert.ok(logged.some(line => line.includes('broken/Cargo.toml')));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('pyright: only statically false conditions are configuration', () => {
        const hint = (message, from, to) => ({
            message, tags: [1], range: { start: { line: from - 1 }, end: { line: to - 1 } },
        });
        assert.deepStrictEqual(staticConditionRanges([
            hint(STATIC_CONDITION_UNREACHABLE, 854, 904),
            hint('Code is structurally unreachable', 796, 808),
            hint('Type analysis indicates code is unreachable', 10, 12),
            hint('"tb" is not accessed', 138, 138),
            { message: STATIC_CONDITION_UNREACHABLE, range: { start: { line: 1 }, end: { line: 2 } } },
        ]), [[854, 904]]);
        // The message is matched against the pinned pyright's own English
        // localization: a pyright bump that rewords it must fail here.
        const bundle = fs.readFileSync(
            require.resolve('pyright/dist/pyright-internal.js'), 'utf8');
        assert.ok(bundle.includes(`"unreachableCodeCondition":"${STATIC_CONDITION_UNREACHABLE}"`));
    });
});
