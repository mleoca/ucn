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
    constructorClassEdges,
    oracleCallerScope,
} = require('../eval/oracle-gate-policy');

describe('fix #441: unresolved TypeScript import navigation is an abstention', () => {
    it('keeps unresolved aliases distinct from compiler-resolved function declarations', async () => {
        const { tmp, rm } = require('./helpers');
        const { tsMorphOracle } = require('../eval/oracles/ts-morph-oracle');
        const dir = tmp({
            'mixed.js': 'import { present } from "./esm";\nexports.version = function () { return present(); };\n',
            'esm.js': 'export function present() { return 1; }\nexport function other() { return 2; }\n',
            'use.js': [
                'import { version } from "./mixed";',
                'import { present as renamed, other, missing } from "./esm";',
                'version();',
                'renamed();',
                'other();',
                'missing();',
            ].join('\n'),
        });
        try {
            const handle = await tsMorphOracle.prepare(dir, { repo: { language: 'javascript' } });
            const definitions = (name, line) => tsMorphOracle.resolveDefinition(handle,
                { file: 'use.js', name, line, kind: 'function' });
            assert.deepStrictEqual(await definitions('version', 3), []);
            assert.deepStrictEqual(await definitions('missing', 6), []);
            assert.deepStrictEqual(await definitions('renamed', 4), [{ file: 'esm.js', line: 1 }]);
            assert.deepStrictEqual(await definitions('other', 5), [{ file: 'esm.js', line: 2 }]);
        } finally { rm(dir); }
    });
});

describe('fix #417: clangd class adjudication follows an alias construction type', () => {
    const { tmp, rm } = require('./helpers');
    const { pathToFileURL } = require('url');
    const { clangdOracle } = require('../eval/oracles/clangd-oracle');
    const range = (line, start, end) => ({ start: { line, character: start }, end: { line, character: end } });
    for (const [label, ast, expected] of [
        ...['CXXTemporaryObject', 'CXXFunctionalCast', 'CXXNew'].map(kind => [kind,
            { kind, range: range(2, 0, 12), children: [{ role: 'type', kind: 'Typedef', range: range(2, 0, 5) }] }, true]),
        ['ordinary call return type', { kind: 'Call', range: range(2, 0, 12), children: [
            { kind: 'DeclRef', role: 'expression', range: range(2, 0, 5) }] }, false],
        ['constructor argument', { kind: 'CXXTemporaryObject', range: range(2, 0, 12), children: [
            { kind: 'Record', role: 'type', range: range(2, 0, 3) },
            { kind: 'DeclRef', role: 'expression', range: range(2, 4, 9) }] }, false],
        ['unavailable AST', null, false],
    ]) it(label, async () => {
        // The oracle opens files by their real path; a symlinked temporary
        // directory (macOS /var) must not read as an unopened file (fix #419).
        const dir = require('fs').realpathSync.native(tmp({ 'n.cpp': 'struct Box {};\nusing Alias=Box;\nAlias(1);\n' }));
        try {
            const file = path.join(dir, 'n.cpp'), uri = pathToFileURL(file).href, requests = [];
            const handle = { root: dir, opened: new Set([file]), source: new Map(), astLines: new Map(),
                lsp: { async request(method) {
                    requests.push(method);
                    if (method === 'textDocument/ast') return ast;
                    if (method === 'textDocument/definition') return [{ uri, range: range(1, 6, 11) }];
                    if (method === 'textDocument/typeDefinition') return [{ uri, range: range(0, 7, 10) }];
                    return [];
                } } };
            const definitions = await clangdOracle.resolveDefinition(handle, { kind: 'class', name: 'Alias',
                file: 'n.cpp', line: 3, column: label === 'constructor argument' ? 5 : 0 });
            assert.equal(definitions.some(def => def.file === 'n.cpp' && def.line === 1), expected);
            assert.equal(requests.includes('textDocument/typeDefinition'), expected);
            requests.length = 0;
            await clangdOracle.resolveDefinition(handle, { kind: 'function', name: 'Alias', file: 'n.cpp', line: 3, column: 0 });
            assert.equal(requests.includes('textDocument/typeDefinition'), false);
        } finally { rm(dir); }
    });
});

describe('fix #417: oracle caller placement follows the call token and declaration identity', () => {
    const { tmp, rm, idx } = require('./helpers');
    const { getCachedCalls } = require('../core/callers');
    const oracleCall = (file, source, call) => {
        const column = call.column ?? call.callSite?.column ??
            (Number.isInteger(call.callStart) ? source.slice(0, call.callStart).split('\n').at(-1).length : undefined);
        assert.ok(Number.isInteger(column), call.name);
        return { file, line: call.line, column };
    };
    for (const [file, source] of [
        ['n.js', 'function alpha(){} function beta(){} function left(){alpha()} function right(){beta()}'],
        ['n.ts', 'function alpha(){} function beta(){} function left(){alpha()} function right(){beta()}'],
        ['N.java', 'class Scope {static void alpha(){} static void beta(){} static void left(){alpha();} static void right(){beta();}}'],
        ['N.cs', 'class Scope {static void alpha(){} static void beta(){} static void left(){alpha();} static void right(){beta();}}'],
        ['n.go', 'package scope\nfunc alpha(){};func beta(){};func left(){alpha()};func right(){beta()}'],
        ['n.rs', 'fn alpha(){} fn beta(){} fn left(){alpha();} fn right(){beta();}'],
        ['n.cpp', 'void alpha(){} void beta(){} void left(){alpha();} void right(){beta();}'],
        ['n.c', 'void alpha(){} void beta(){} void left(){alpha();} void right(){beta();}'],
    ]) {
        it(`${file}: sibling scopes on one line cannot share a callee answer`, () => {
            const dir = tmp({ [file]: source });
            try {
                const index = idx(dir), calls = getCachedCalls(index, path.join(dir, file));
                const scopes = ['alpha', 'beta'].map(name => {
                    const call = calls.find(call => call.name === name);
                    assert.ok(call, name);
                    return oracleCallerScope(index, oracleCall(file, source, call));
                });
                assert.deepEqual(scopes.map(scope => scope?.definition.name), ['left', 'right']);
                assert.notEqual(scopes[0].key, scopes[1].key);
            } finally { rm(dir); }
        });
    }
    for (const [label, source, expected] of [
        ['module callback', 'bind({}, "x", function getter(){nested();});', null],
        ['nested callback', 'function outer(){bind({}, "x", function getter(){nested();});}', 'outer'],
    ]) {
        it(`${label}: a call does not belong to its callback argument`, () => {
            const dir = tmp({ 'n.js': source });
            try {
                const index = idx(dir), calls = getCachedCalls(index, path.join(dir, 'n.js'));
                const at = name => {
                    const call = calls.find(call => call.name === name);
                    return oracleCallerScope(index, oracleCall('n.js', source, call));
                };
                assert.equal(at('bind')?.definition.name ?? null, expected);
                assert.equal(at('nested').definition.name, 'getter');
                if (expected) assert.notEqual(at('bind').key, at('nested').key);
            } finally { rm(dir); }
        });
    }
});

describe('fix #417: compiler class references retain proven constructor dependencies', () => {
    const { tmp, rm, idx } = require('./helpers');
    for (const [file, code] of [
        ['n.js', 'class Widget {constructor(v){}}\nfunction build(){return new Widget(1);}\n'],
        ['n.ts', 'class Widget {constructor(v:number){}}\nfunction build(){return new Widget(1);}\n'],
        ['n.tsx', 'class Widget {constructor(v:number){}}\nfunction build(){return new Widget(1);}\n'],
        ['n.html', '<script>\nclass Widget {constructor(v){}}\nfunction build(){return new Widget(1);}\n</script>'],
        ['n.py', 'class Widget:\n def __init__(self,v):pass\ndef build():return Widget(1)\n'],
    ]) {
        it(`${file}: a class dependency requires a replayable occurrence proof`, () => {
            const dir = tmp({ [file]: code });
            try {
                const index = idx(dir), target = index.symbols.get('Widget').find(def => def.type === 'class');
                const answer = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
                // The answer's own class edge is never projected again (fix #421);
                // the projection is measured on the constructor body edge alone.
                assert.ok(answer.some(def => def.type === 'class' && def.name === 'Widget'));
                assert.equal(constructorClassEdges(answer, [target]).length, 0);
                const edges = answer.filter(def => def.type === 'constructor');
                const projected = constructorClassEdges(edges, [target]);
                assert.equal(projected.length, 1);
                assert.equal(projected[0].name, 'Widget');
                assert.equal(projected[0].startLine, target.startLine);
                assert.equal(projected[0].siteProvenance.length, 1);
                assert.equal(constructorClassEdges(edges, [target], () => true).length, 0);
                assert.equal(constructorClassEdges(edges, [{ ...target, relativePath: 'other' }]).length, 0);
                assert.equal(constructorClassEdges(edges, [{ ...target, namespace: 'Other' }]).length, 0);
                const incomplete = JSON.parse(JSON.stringify(edges));
                incomplete[0].siteProvenance[0].provenance.facts.constructorCall.typeLookup = null;
                assert.equal(constructorClassEdges(incomplete, [target]).length, 0);
                assert.equal(constructorClassEdges([{ ...edges[0], siteProvenance: [] }], [target]).length, 0);
            } finally { rm(dir); }
        });
    }
    it('shared inherited bodies retain each constructed type at its own sites', () => {
        const dir = tmp({ 'n.js': 'class Base {constructor(v){}}\nclass Left extends Base {}\nclass Right extends Base {}\nfunction build(){\n new Left(1);\n new Right(2);\n}\n' });
        try {
            const index = idx(dir), edges = index.findCallees(index.symbols.get('build')[0], { collectAccount: true })
                .filter(def => def.type === 'constructor');
            const targets = ['Left', 'Right'].map(name => index.symbols.get(name).find(def => def.type === 'class'));
            const projected = constructorClassEdges(edges, targets);
            assert.deepEqual(projected.map(edge => [edge.name, edge.sites]), [['Left', [5]], ['Right', [6]]]);
            assert.ok(projected.every(edge => edge.siteProvenance.length === 1));
        } finally { rm(dir); }
    });
    for (const [file, code] of [
        ['N.cs', 'class Base {public Base(){}}\nclass Child:Base {public Child(){}}\n'],
        ['N.java', 'class Base {Base(){}}\nclass Child extends Base {Child(){}}\n'],
        ['n.cpp', 'struct Base {Base(){}};\nstruct Child:Base {Child(){}};\n'],
    ]) {
        it(`${file}: an omitted initializer is not a written class reference`, () => {
            const dir = tmp({ [file]: code });
            try {
                const index = idx(dir), target = index.symbols.get('Base').find(def => ['class', 'struct'].includes(def.type));
                const child = index.symbols.get('Child').find(def => def.type === 'constructor');
                const edges = index.findCallees(child, { collectAccount: true });
                assert.ok(edges.some(edge => edge.siteProvenance?.some(site =>
                    site.provenance?.facts?.constructorCall?.call?.syntax === 'implicit')));
                assert.equal(constructorClassEdges(edges, [target]).length, 0);
            } finally { rm(dir); }
        });
    }
});

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

describe('fix #422: the rust-analyzer oracle projects a plain cargo build', () => {
    it('sets the cfgs a `cargo check --all-targets` build sees: no `miri`', () => {
        const { CARGO_PROJECTION } = require('../eval/oracles/rust-analyzer-oracle');
        assert.deepStrictEqual(CARGO_PROJECTION.cfgs, ['debug_assertions']);
        assert.strictEqual(CARGO_PROJECTION.features, 'all');
        assert.strictEqual(CARGO_PROJECTION.allTargets, true);
    });
});

describe('fix #429: the oracle runner refuses unknown options and prints help', () => {
    const fs = require('fs');
    const os = require('os');
    const { validateOracleArgs, ORACLE_EVAL_USAGE } = require('../eval/oracle-gate-policy');
    const script = path.join(__dirname, '..', 'eval', 'run-oracle-eval.js');

    it('--help prints the usage and exits without running or writing a board', () => {
        const reports = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-429-help-'));
        fs.rmSync(reports, { recursive: true });
        const result = spawnSync(process.execPath, [script, '--help'], {
            encoding: 'utf8', env: { ...process.env, UCN_EVAL_REPORTS_DIR: reports },
        });
        assert.strictEqual(result.status, 0);
        assert.match(result.stdout, /^Usage: node eval\/run-oracle-eval\.js/);
        assert.ok(result.stdout.includes('--symbols'));
        assert.strictEqual(fs.existsSync(reports), false);
        assert.strictEqual(result.stdout, ORACLE_EVAL_USAGE);
    });

    it('a misspelled gate flag fails instead of running ungated', () => {
        assert.throws(() => validateOracleArgs(['--max-unscored', '0.10']), /unknown option --max-unscored/);
        assert.throws(() => validateOracleArgs(['--repo']), /--repo requires a value/);
        assert.throws(() => validateOracleArgs(['zod']), /unknown option zod/);
        const result = spawnSync(process.execPath, [script, '--min-precison', '0.98'], { encoding: 'utf8' });
        assert.notStrictEqual(result.status, 0);
        assert.match(result.stderr, /unknown option --min-precison/);
    });

    it('accepts every documented option shape', () => {
        validateOracleArgs(['--release', '--min-precision', '0.98', '--max-unscored-ratio', '0.10']);
        validateOracleArgs(['--fresh', '--max-unscored-ratio', '0.10']);
        validateOracleArgs(['--fresh', '2', '--seed', '0x5eed3b', '--value-sample', '0']);
        validateOracleArgs(['--repo', 'zod', '--symbols', 'a.ts:3:f', '-h']);
    });
});

describe('fix #429: named handles are scored like sampled symbols', () => {
    const { parseSymbolHandles, resolveSymbolHandle, CALLER_ARM_KINDS, VALUE_ARM_KINDS } =
        require('../eval/oracle-gate-policy');
    const symbols = [
        { name: 'Map', file: 'src/ClassMap`1.cs', line: 28, kind: 'method' },
        { name: 'Map', file: 'src/ClassMap`1.cs', line: 43, kind: 'method' },
        { name: 'with', file: 'core/Modules.java', line: 200, kind: 'method' },
        { name: 'count', file: 'core/Modules.java', line: 12, kind: 'field' },
        { name: 'f', file: 'a.py', line: 4, kind: 'function' },
    ];
    const index = { symbols: new Map([['f', [{ relativePath: 'a.py', startLine: 4, nameLine: 5 }]]]) };

    it('parses file:line:name lists, file paths with colons-free names', () => {
        assert.deepStrictEqual(parseSymbolHandles('src/ClassMap`1.cs:28:Map, core/Modules.java:200:with'), [
            { file: 'src/ClassMap`1.cs', line: 28, name: 'Map' },
            { file: 'core/Modules.java', line: 200, name: 'with' },
        ]);
        assert.strictEqual(parseSymbolHandles(null), null);
        assert.throws(() => parseSymbolHandles('Map'), /file:line:name/);
    });

    it('pins the exact declaration and never guesses between overloads', () => {
        assert.strictEqual(resolveSymbolHandle({ file: 'src/ClassMap`1.cs', line: 43, name: 'Map' },
            symbols, index, CALLER_ARM_KINDS).line, 43);
        assert.throws(() => resolveSymbolHandle({ file: 'src/ClassMap`1.cs', line: 30, name: 'Map' },
            symbols, index, CALLER_ARM_KINDS), /no oracle symbol at that declaration \(oracle rows of that name in the file: 28:method, 43:method\)/);
    });

    it('maps an engine handle onto the oracle row inside the declaration head', () => {
        assert.strictEqual(resolveSymbolHandle({ file: 'a.py', line: 5, name: 'f' },
            symbols, index, CALLER_ARM_KINDS).line, 4);
    });

    it('routes value members to the value arm', () => {
        assert.throws(() => resolveSymbolHandle({ file: 'core/Modules.java', line: 12, name: 'count' },
            symbols, index, CALLER_ARM_KINDS));
        assert.strictEqual(resolveSymbolHandle({ file: 'core/Modules.java', line: 12, name: 'count' },
            symbols, index, VALUE_ARM_KINDS).kind, 'field');
    });
});

describe('fix #429: a class and its constructors are one named entity in usages/tests eligibility', () => {
    const { namedEntities } = require('../eval/command-proof');
    it('Java/C#/C++ constructors named after their class do not make the class name repeated', () => {
        const defs = [
            { name: 'Foo', type: 'class' },
            { name: 'Foo', type: 'constructor', className: 'Foo' },
            { name: 'Foo', type: 'constructor', className: 'Foo' },
        ];
        assert.strictEqual(namedEntities(defs, 'Foo').length, 1);
    });
    it('a second class of the name is still another entity', () => {
        const defs = [
            { name: 'Foo', type: 'class', namespace: 'a' },
            { name: 'Foo', type: 'class', namespace: 'b' },
            { name: 'Foo', type: 'constructor', className: 'Foo' },
        ];
        assert.strictEqual(namedEntities(defs, 'Foo').length, 2);
        assert.strictEqual(namedEntities([{ name: 'm', type: 'method', className: 'Foo' },
            { name: 'm', type: 'method', className: 'Bar' }], 'm').length, 2);
    });
});

describe('fix #429: oracle edges in code the oracle projection leaves out', () => {
    it('leave the recall universe and are bounded by the coverage ratio', () => {
        const burden = summarizeReviewBurden({
            symbols: [], oracleCallEdges: 100,
            placement: { confirmed: 90, unverified: 0, missingExplained: 5, configurationGated: 5 },
            exactOracleCallEdges: 100,
            exactPlacement: { confirmed: 90, unverified: 0, missingExplained: 5, configurationGated: 5 },
        });
        assert.strictEqual(burden.semanticEligibleEdges, 90);
        assert.strictEqual(burden.exactSemanticEligibleEdges, 90);
        assert.deepStrictEqual(evaluateOracleCoverage({ oracleCallEdges: 100, oracleConfigurationGatedEdges: 5 },
            0.10).failures, []);
        assert.match(evaluateOracleCoverage({ oracleCallEdges: 100, oracleConfigurationGatedEdges: 11 },
            0.10).failures.join(), /recall configuration-unscored ratio 11\.00% > 10\.00%/);
    });
});

describe('fix #429: Roslyn oracle project universe and framework cap', () => {
    const fs = require('fs');
    const os = require('os');
    const { chooseTargetFramework, frameworkBuildable, findProjects } = require('../eval/oracles/roslyn-oracle');
    it('picks the newest framework the SDK can build', () => {
        assert.strictEqual(chooseTargetFramework(null, 'net461;netstandard2.0;net8.0;net10.0', 9), 'net8.0');
        assert.strictEqual(chooseTargetFramework(null, 'net461;netstandard2.0;net8.0;net10.0', 10), 'net10.0');
        assert.strictEqual(chooseTargetFramework('net10.0', null, 9), null);
        assert.strictEqual(chooseTargetFramework(null, 'net481;net8.0-windows;net8.0', 10), 'net8.0');
        assert.strictEqual(chooseTargetFramework(null, 'netstandard2.0;netstandard2.1', 9), 'netstandard2.1');
        assert.strictEqual(chooseTargetFramework('netcoreapp2.2', null, 9), 'netcoreapp2.2');
        assert.strictEqual(frameworkBuildable('net461', 6), true);
        assert.strictEqual(frameworkBuildable('net9.0', 8), false);
    });
    it('lists every project under the target, tests and samples included', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-429-cs-'));
        try {
            for (const rel of ['src/A/A.csproj', 'tests/A.Tests/A.Tests.csproj', 'samples/S/S.csproj',
                'src/A/bin/Release/Copy.csproj', '.hidden/H.csproj']) {
                fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
                fs.writeFileSync(path.join(root, rel), '<Project/>');
            }
            assert.deepStrictEqual(findProjects(root).map(p => path.relative(root, p)),
                ['samples/S/S.csproj', 'src/A/A.csproj', 'tests/A.Tests/A.Tests.csproj']);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('fix #437: Roslyn identity through a linked project root', () => {
    const fs = require('fs');
    const { spawnSync } = require('child_process');
    const { tmp, rm } = require('./helpers');
    const { roslynOracle } = require('../eval/oracles/roslyn-oracle');
    const sdk = spawnSync('dotnet', ['--version'], {
        cwd: path.join(__dirname, '../eval/oracles/roslyn-helper'), encoding: 'utf8',
    });
    const major = Number(sdk.stdout?.match(/^(\d+)\./)?.[1]);

    it('unifies compiler project references and every partial declaration without merging namesakes', {
        skip: sdk.status !== 0 || major < 9 ? '.NET 9+ SDK unavailable' : false,
        timeout: 120000,
    }, async () => {
        const project = extra => `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net${major}.0</TargetFramework></PropertyGroup>${extra}</Project>`;
        const root = tmp({
            'lib/Lib.csproj': project(''),
            'app/App.csproj': project('<ItemGroup><ProjectReference Include="../lib/Lib.csproj" /></ItemGroup>'),
            'lib/A.cs': 'namespace N;\npublic partial class Box<T> { public Box() : this(1) {} public Box(int n) {} }\n',
            'lib/B.cs': 'namespace N;\npublic partial class Box<T> { public int Value => 1; }\n',
            'lib/C.cs': 'namespace N;\npublic class Box { public Box() {}\n[System.Obsolete]\npublic int Field;\n}\n',
            'app/Use.cs': 'class Use {\n object A() => new N.Box<int>();\n object B() => new N.Box<string>(2);\n object C() => new N.Box();\n}\n',
        });
        const alias = root + '-link';
        let handle;
        try {
            fs.symlinkSync(root, alias, 'dir');
            handle = await roslynOracle.prepare(alias);
            assert.strictEqual(handle.root, fs.realpathSync(root));
            assert.strictEqual(handle.projection.units.length, 2);
            const symbols = await roslynOracle.listSymbols(handle);
            assert.ok(symbols.every(symbol => !symbol.file.startsWith('../')));
            // fix #439: field handles start at their declarator, not an
            // attribute list on an earlier line of the field statement.
            const field = symbols.find(symbol => symbol.name === 'Field');
            assert.strictEqual(field?.line, 4);
            assert.deepStrictEqual(await roslynOracle.resolveDefinition(handle, field),
                [{ file: 'lib/C.cs', line: 4 }]);
            for (const file of ['lib/A.cs', 'lib/B.cs']) {
                const target = { file, line: 2, name: 'Box' };
                const calls = (await roslynOracle.findReferences(handle, target))
                    .filter(ref => ref.kind === 'call').map(ref => `${ref.file}:${ref.line}`).sort();
                assert.deepStrictEqual(calls, ['app/Use.cs:2', 'app/Use.cs:3', 'lib/A.cs:2']);
                const definitions = await roslynOracle.resolveDefinition(handle, target);
                assert.deepStrictEqual(definitions, [{ file: 'lib/A.cs', line: 2 }, { file: 'lib/B.cs', line: 2 }]);
            }
            const definitions = await roslynOracle.resolveDefinition(handle, {
                file: 'app/Use.cs', line: 2, name: 'Box',
            });
            assert.ok(definitions.some(def => def.file === 'lib/B.cs'));
            assert.ok(definitions.every(def => def.file !== 'lib/C.cs'));
        } finally {
            if (handle) await roslynOracle.dispose(handle);
            if (fs.existsSync(alias)) fs.unlinkSync(alias);
            rm(root);
        }
    });
});

describe('fix #429: clangd oracle answers stay bounded and copy-aware', () => {
    const { pruneToLine, declarationHasBody } = require('../eval/oracles/clangd-oracle');
    it('a cached line AST keeps the line slice and every child position', () => {
        const at = (line, children) => ({ kind: 'X', range: { start: { line, character: 0 }, end: { line, character: 9 } }, children });
        const call = { kind: 'Call', range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } }, children: [
            at(4, [at(4)]), at(5, [at(5, [at(5)])]), at(6),
        ] };
        const pruned = pruneToLine({ kind: 'Function', children: [call, at(9, [at(9)])] }, 4);
        assert.strictEqual(pruned.children.length, 1); // the declaration off the line is dropped
        assert.strictEqual(pruned.children[0].children.length, 3); // a call keeps its argument count
        assert.strictEqual(pruned.children[0].children[1].children, undefined);
    });
    it('a declaration whose compiler range closes a brace is a definition', () => {
        const file = path.join(__dirname, 'fixtures-429-virtual.c');
        const handle = { source: new Map([[file, ['int f(void);', 'int g(void) {', '  return 1;', '}']]]) };
        const range = (sl, el, ec) => ({ start: { line: sl, character: 0 }, end: { line: el, character: ec } });
        assert.strictEqual(declarationHasBody(handle, file, range(0, 0, 11)), false);
        assert.strictEqual(declarationHasBody(handle, file, range(1, 3, 1)), true);
    });
    it('a vendored copy of a value is a defining declaration; out-of-class and extern ones redeclare', () => {
        const { definesValue } = require('../eval/oracles/clangd-oracle');
        const root = path.join(__dirname, 'fixtures-429-virtual');
        const file = path.join(root, 'v.hpp');
        const handle = { root, valueSymbols: new Map(), source: new Map([[file, [
            'static constexpr int max_size = 4;', 'int Foo::count = 0;', 'extern int g_level;', '    int depth{};',
        ]]]) };
        assert.strictEqual(definesValue(handle, 'v.hpp', 1, 'max_size'), true);
        assert.strictEqual(definesValue(handle, 'v.hpp', 2, 'count'), false);
        assert.strictEqual(definesValue(handle, 'v.hpp', 3, 'g_level'), false);
        assert.strictEqual(definesValue(handle, 'v.hpp', 4, 'depth'), true);
    });
    it('a definition location must spell the identifier (a dependent member answered with its base alias)', () => {
        const { spellsName } = require('../eval/oracles/clangd-oracle');
        const file = path.join(__dirname, 'fixtures-429-virtual.hpp');
        const handle = { source: new Map([[file, ['    using base_type = internal::basic<Char>;', '    hash_type hash{};']]]) };
        const at = (line, start, end) => ({ start: { line, character: start }, end: { line, character: end } });
        assert.strictEqual(spellsName(handle, file, at(0, 10, 19), 'hash'), false);
        assert.strictEqual(spellsName(handle, file, at(1, 14, 18), 'hash'), true);
    });
});

describe('fix #431: clangd value references at a macro invocation', () => {
    it('a reference whose range does not spell the name is the expansion\'s, though an argument spells it', () => {
        const { identifierAt } = require('../eval/oracles/clangd-oracle');
        const file = path.join(__dirname, 'fixtures-431-virtual.c');
        const handle = { source: new Map([[file, ['    INIT(*event, token->data.stream_start.encoding);']]]) };
        assert.strictEqual(identifierAt(handle, file, 1, 4, 'stream_start'), false);
        assert.strictEqual(identifierAt(handle, file, 1, 29, 'stream_start'), true);
        assert.strictEqual(identifierAt(handle, file, 1, 30, 'stream_start'), false);
    });
});

describe('fix #429: jdtls method-reference definitions', () => {
    const { declarationSpells } = require('../eval/oracles/jdtls-oracle');
    const fs = require('fs');
    const os = require('os');
    it('a functional interface method is not the binding of `T::m`', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-429-jdtls-'));
        try {
            const file = path.join(root, 'CharacterReader.java');
            fs.writeFileSync(file, 'interface CharPredicate {\n    boolean test(char c);\n}\n');
            const uri = require('url').pathToFileURL(file).href;
            assert.strictEqual(await declarationSpells({}, uri, 1, 'isIdent'), false);
            assert.strictEqual(await declarationSpells({}, uri, 1, 'test'), true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('fix #429: jdtls oracle helpers', () => {
    const { documentMethodSignatures, nestedTypeRanges, onBuildPath, declaringTypeName } =
        require('../eval/oracles/jdtls-oracle');
    it('a runtime body belongs to the type its declaration sits in (flat or nested symbols)', () => {
        const range = (s, e) => ({ start: { line: s, character: 0 }, end: { line: e, character: 0 } });
        const flat = [
            { name: 'getNumIdle()', kind: 6, containerName: 'GenericKeyedObjectPool<K, T, E>', location: { range: range(1210, 1213) } },
            { name: 'toString()', kind: 6, containerName: 'ObjectDeque<S>', location: { range: range(120, 125) } },
        ];
        assert.strictEqual(declaringTypeName(flat, 1211), 'GenericKeyedObjectPool<K, T, E>');
        assert.strictEqual(declaringTypeName(flat, 122), 'ObjectDeque<S>');
        const nested = [{ name: 'Outer', kind: 5, range: range(0, 50), children: [
            { name: 'Inner', kind: 5, range: range(10, 20), children: [{ name: 'm()', kind: 6, range: range(12, 14) }] },
            { name: 'm()', kind: 6, range: range(30, 32) },
        ] }];
        assert.strictEqual(declaringTypeName(nested, 13), 'Inner');
        assert.strictEqual(declaringTypeName(nested, 31), 'Outer');
    });
    it('reads parameter counts of an owner type\'s methods from documentSymbol labels', () => {
        const symbols = [{ name: 'Object', kind: 5, children: [
            { name: 'toString()', kind: 6 }, { name: 'equals(Object)', kind: 6 }, { name: 'wait(long, int)', kind: 6 },
        ] }, { name: 'Other', kind: 5, children: [{ name: 'toString()', kind: 6 }] }];
        assert.deepStrictEqual(documentMethodSignatures(symbols, 'Object', 'toString'), [0]);
        assert.deepStrictEqual(documentMethodSignatures(symbols, 'Object', 'wait'), [2]);
        assert.deepStrictEqual(documentMethodSignatures(symbols, 'Missing', 'toString'), []);
        const flat = [{ name: 'run()', kind: 6, containerName: 'Runnable' }, { name: 'call()', kind: 6, containerName: 'Other' }];
        assert.deepStrictEqual(documentMethodSignatures(flat, 'Runnable', 'run'), [0]);
        assert.deepStrictEqual(documentMethodSignatures(flat, 'Runnable', 'call'), []);
    });
    it('a body declared in a nested type is not the outer type\'s', () => {
        const range = (s, e) => ({ start: { line: s, character: 0 }, end: { line: e, character: 0 } });
        const outer = range(0, 50);
        const symbols = [{ name: 'Outer', kind: 5, range: outer, children: [
            { name: 'Inner', kind: 5, range: range(10, 20), children: [] }, { name: 'm()', kind: 6, range: range(30, 32) },
        ] }];
        assert.deepStrictEqual(nestedTypeRanges(symbols, outer), [range(10, 20)]);
    });
    it('a method reference on a constructed local follows its runtime class like a call', () => {
        const { constructedReceiverAt } = require('../eval/oracles/jdtls-oracle');
        const source = ['void t() {', '  try (ObjectPool<Object> pool = new GenericObjectPool<>(f)) {',
            '    assertThrows(X.class, pool::addObject);', '    pool.addObject();'];
        for (const line of [3, 4]) {
            const constructed = constructedReceiverAt({ name: 'addObject', line, source, sourceLine: source[line - 1] });
            assert.strictEqual(constructed?.ownerName, 'GenericObjectPool', `line ${line}`);
        }
    });
    it('files outside every imported source folder are outside the projection', () => {
        const handle = { root: '/r', sourcePaths: ['/r/src/main/java', '/r/src/test/java'] };
        assert.strictEqual(onBuildPath(handle, 'src/main/java/a/A.java'), true);
        assert.strictEqual(onBuildPath(handle, 'doc/Example.java'), false);
        assert.strictEqual(onBuildPath({ root: '/r', sourcePaths: null }, 'doc/Example.java'), true);
    });
});

describe('fix #429: the value-member arm summary', () => {
    const { emptyValueArm, finishValueArm } = require('../eval/oracle-gate-policy');
    it('scores precision over scored accesses and recall over exact eligible references', () => {
        const arm = emptyValueArm({ listed: 40 });
        Object.assign(arm, {
            sampled: 3, evaluated: 3, confirmedSites: 10, confirmedHits: 8, confirmedUnscored: 1,
            confirmedUnscoredByClass: { 'configuration-gated': 1 },
            exactOracleRefSites: 12, oracleRefSites: 13, accounts: 3, conserved: 3,
        });
        Object.assign(arm.exactPlacement, { confirmed: 8, unverified: 1, missingExplained: 1,
            configurationGated: 1, accountedNotShown: 1 });
        Object.assign(arm.placement, { ...arm.exactPlacement, missingUnexplained: 1 });
        const summary = finishValueArm(arm);
        assert.strictEqual(summary.tier1Precision, 0.8889); // 8 of 9 scored
        assert.strictEqual(summary.semanticMissing, 1);
        assert.strictEqual(summary.semanticRecall, 0.9); // 10 eligible (12 - explained - configuration)
        assert.strictEqual(summary.missingUnexplained, 0);
        assert.strictEqual(summary.allOracleMissingUnexplained, 1);
        assert.strictEqual(summary.confirmedConfigurationUnscored, 1);
        assert.strictEqual(summary.confirmedAbstentionUnscored, 0);
        assert.strictEqual(summary.conservedRate, 1);
    });
    it('a member with no oracle references and no accesses keeps full recall', () => {
        const summary = finishValueArm(emptyValueArm());
        assert.strictEqual(summary.semanticRecall, 1);
        assert.strictEqual(summary.tier1Precision, null);
    });
});
