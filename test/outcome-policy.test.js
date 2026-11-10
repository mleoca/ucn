'use strict';

/**
 * Unit tests for eval/outcome-policy.js — the pure logic of the task-outcome
 * eval (proposal extraction, mechanical edits, judge parsing, aggregation).
 */

require('./helpers/cache-root'); // isolated cache root (fix #433)
const { describe, it } = require('node:test');
const assert = require('node:assert');

const policy = require('../eval/outcome-policy');

describe('outcome-policy: identifier rename mechanics', () => {
    it('renames word-boundary occurrences only', () => {
        assert.strictEqual(
            policy.renameOnLine('format(food, format_data, obj.format(x))', 'format', 'fmt2'),
            'fmt2(food, format_data, obj.fmt2(x))');
    });

    it('treats $ as an identifier character', () => {
        assert.strictEqual(policy.renameOnLine('$save(save)', 'save', 's2'), '$save(s2)');
    });

    it('applyRenameToContent reports replaced and no-effect lines', () => {
        const content = 'a()\nb()\na() // a\n';
        const result = policy.applyRenameToContent(content, [1, 2, 3, 99], 'a', 'a2');
        assert.strictEqual(result.content, 'a2()\nb()\na2() // a2\n');
        assert.deepStrictEqual(result.replacedLines, [1, 3]);
        assert.deepStrictEqual(result.noEffectLines, [2, 99]);
    });

    it('applies the exact planned expression when one line has two same-named calls', () => {
        const content = [
            'func use(r *Router) {',
            '\tr.PathPrefix("/before").PathPrefix("/after")',
            '}',
        ].join('\n');
        const result = policy.applyPlannedEditsToContent(content, [{
            file: 'mux.go',
            line: 2,
            expression: 'r.PathPrefix("/before").PathPrefix("/after")',
            newExpression: 'r.PathPrefixV2("/before").PathPrefix("/after")',
        }]);
        assert.strictEqual(result.content, [
            'func use(r *Router) {',
            '\tr.PathPrefixV2("/before").PathPrefix("/after")',
            '}',
        ].join('\n'));
        assert.strictEqual(result.appliedEdits.length, 1);
        assert.deepStrictEqual(result.noEffectEdits, []);
    });

    it('applies multiline planned expressions from their reported start line', () => {
        const content = 'before\n\toldCall(\n\t\tvalue,\n\t)\nafter';
        const result = policy.applyPlannedEditsToContent(content, [{
            line: 2,
            expression: 'oldCall(\n\t\tvalue,\n\t)',
            newExpression: 'newCall(\n\t\tvalue,\n\t)',
        }]);
        assert.strictEqual(result.content, 'before\n\tnewCall(\n\t\tvalue,\n\t)\nafter');
        assert.strictEqual(result.appliedEdits.length, 1);
    });

    it('applyDeleteToContent removes the inclusive 1-based range', () => {
        assert.strictEqual(policy.applyDeleteToContent('l1\nl2\nl3\nl4', 2, 3), 'l1\nl4');
    });
});

describe('outcome-policy: definition-line rename', () => {
    it('renames only the first occurrence — params/types sharing the name survive', () => {
        assert.strictEqual(
            policy.renameFirstOnLine(
                '  public JsonWriter value(long value) throws IOException {',
                'value', 'value_ucnq'),
            '  public JsonWriter value_ucnq(long value) throws IOException {');
        assert.strictEqual(
            policy.renameFirstOnLine(
                'func (r *Route) BuildVarsFunc(f BuildVarsFunc) *Route {',
                'BuildVarsFunc', 'BVF2'),
            'func (r *Route) BVF2(f BuildVarsFunc) *Route {');
    });

    it('word-boundary only, and a no-match line is returned unchanged', () => {
        assert.strictEqual(
            policy.renameFirstOnLine('let valuex = value2;', 'value', 'v2'),
            'let valuex = value2;');
    });
});

describe('outcome-policy: import stripping', () => {
    it('strips one name from a Python import list', () => {
        assert.strictEqual(
            policy.stripNameFromImportLine('from x import alpha, beta', 'alpha'),
            'from x import beta');
        assert.strictEqual(
            policy.stripNameFromImportLine('from x import alpha, beta', 'beta'),
            'from x import alpha');
    });

    it('drops the line for a sole import', () => {
        assert.strictEqual(policy.stripNameFromImportLine('from x import alpha', 'alpha'), null);
        assert.strictEqual(policy.stripNameFromImportLine('use crate::alpha;', 'alpha'), null);
        assert.strictEqual(
            policy.stripNameFromImportLine("import { alpha } from './x'", 'alpha'), null);
    });

    it('never touches the module path', () => {
        assert.strictEqual(policy.stripNameFromImportLine('from alpha import alpha', 'alpha'), null);
        assert.strictEqual(
            policy.stripNameFromImportLine('from alpha import alpha, beta', 'alpha'),
            'from alpha import beta');
    });

    it('strips from JS destructured require and Rust use lists', () => {
        assert.strictEqual(
            policy.stripNameFromImportLine("const { alpha, beta } = require('./x');", 'alpha'),
            "const { beta } = require('./x');");
        assert.strictEqual(
            policy.stripNameFromImportLine('use x::{alpha, beta};', 'beta'),
            'use x::{alpha};');
    });

    it('returns the line unchanged when the name is absent', () => {
        assert.strictEqual(
            policy.stripNameFromImportLine('from x import beta', 'alpha'),
            'from x import beta');
    });
});

describe('outcome-policy: arm proposal extraction', () => {
    const planData = {
        changes: [
            { file: 'lib.py', line: 2, editKind: 'definition' },
            { file: 'app.py', line: 5, editKind: 'call' },
            { file: 'app.py', line: 1, editKind: 'import' },
        ],
        unverifiedSites: [
            { file: 'lib.py', line: 10, reason: 'method-ambiguous' },
            { file: 'app.py', line: 5, reason: 'method-ambiguous' },
            // External-attributed dispatch (fix #294 flask ep.load family):
            // the contract arm must DEFER this site, not rename it.
            { file: 'ext.py', line: 3, reason: 'possible-dispatch',
                dispatchVia: 'importlib.metadata.entry_points', externalContract: true },
            // Module-attribute dispatch (flask.json.load family): the name
            // binds the module's export surface — defer likewise.
            { file: 'mod.py', line: 8, reason: 'possible-dispatch',
                dispatchVia: 'flask.json — module attribute', moduleAttribute: true },
        ],
        account: {
            unparsed: { files: ['legacy/old.js'] },
            unsupported: { files: ['scripts/build.rb'] },
        },
    };

    it('confirmed mode keeps engine changes only', () => {
        const result = policy.armSitesFromPlan(planData, 'confirmed');
        assert.strictEqual(result.sites.length, 3);
        assert.deepStrictEqual(result.escalationFiles, []);
        assert.deepStrictEqual(result.deferredExternal, []);
    });

    it('contract mode adds unverified sites (deduped) and escalation files', () => {
        const result = policy.armSitesFromPlan(planData, 'contract');
        assert.strictEqual(result.sites.length, 4);
        assert.ok(result.sites.some(site => site.file === 'lib.py' && site.line === 10));
        assert.deepStrictEqual(result.escalationFiles, ['legacy/old.js', 'scripts/build.rb']);
    });

    it('sites are ordered by (file, numeric line)', () => {
        const result = policy.armSitesFromPlan(planData, 'contract');
        assert.deepStrictEqual(result.sites.map(policy.siteKey),
            ['app.py:1', 'app.py:5', 'lib.py:2', 'lib.py:10']);
    });

    it('contract mode defers external and module-attribute unverified sites', () => {
        const result = policy.armSitesFromPlan(planData, 'contract');
        assert.ok(!result.sites.some(site => site.file === 'ext.py'),
            'external-attributed site must not be a rename site');
        assert.ok(!result.sites.some(site => site.file === 'mod.py'),
            'module-attribute site must not be a rename site');
        assert.deepStrictEqual(result.deferredExternal,
            [{ file: 'ext.py', line: 3 }, { file: 'mod.py', line: 8 }]);
    });

    it('slot-attributed possible-dispatch sites keep applying', () => {
        // Generic-param / supertype dispatch attribution: the site CAN bind
        // the renamed slot — deferring it would miss a true site (the serde
        // exponent contract win rides on this).
        const doc = {
            changes: [],
            unverifiedSites: [
                { file: 'app.rs', line: 9, reason: 'possible-dispatch',
                    dispatchVia: 'TStore' },
            ],
        };
        const result = policy.armSitesFromPlan(doc, 'contract');
        assert.deepStrictEqual(result.sites.map(policy.siteKey), ['app.rs:9']);
        assert.deepStrictEqual(result.deferredExternal, []);
    });

    it('a deferred external line already confirmed elsewhere stays edited', () => {
        // Confirmed evidence outranks: the change entry survives even when an
        // external-attributed unverified entry shares the file:line.
        const doc = {
            changes: [{ file: 'x.py', line: 4, editKind: 'call' }],
            unverifiedSites: [
                { file: 'x.py', line: 4, reason: 'possible-dispatch', externalContract: true },
            ],
        };
        const result = policy.armSitesFromPlan(doc, 'contract');
        assert.deepStrictEqual(result.sites.map(policy.siteKey), ['x.py:4']);
        assert.strictEqual(result.sites[0].kind, 'call');
    });
});

describe('outcome-policy: grep arm', () => {
    it('proposes every word-boundary match with metering', () => {
        const contentByFile = new Map([
            ['b.py', 'def save(x):\n    return x\n'],
            ['a.py', 'save(1)  # save the world\nsaver(2)\n"save"\n'],
        ]);
        const result = policy.grepProposal(contentByFile, 'save');
        assert.deepStrictEqual(result.sites.map(policy.siteKey),
            ['a.py:1', 'a.py:3', 'b.py:1']);
        assert.strictEqual(result.filesScanned, 2);
        assert.ok(result.scannedBytes > 0 && result.outputChars > 0);
    });

    it('grep delete verdict ignores the def range and import lines', () => {
        const contentByFile = new Map([
            ['lib.py', 'def gone():\n    return 1\n'],
            ['app.py', 'from lib import gone\n'],
        ]);
        const verdict = policy.grepDeleteVerdict(contentByFile, 'gone', 'lib.py', 1, 2);
        assert.strictEqual(verdict.safe, true);
        const used = policy.grepDeleteVerdict(new Map([
            ...contentByFile, ['use.py', 'gone()\n'],
        ]), 'gone', 'lib.py', 1, 2);
        assert.strictEqual(used.safe, false);
        assert.strictEqual(used.usageEvidence, 1);
    });
});

describe('outcome-policy: delete verdicts from UCN output', () => {
    it('show verdict is confirmed-caller based', () => {
        assert.strictEqual(policy.deleteVerdictFromShow({ context: { callers: [] } }).safe, true);
        assert.strictEqual(
            policy.deleteVerdictFromShow({ context: { callers: [{ line: 3 }] } }).safe, false);
    });

    it('usages verdict counts non-definition non-import rows', () => {
        const rows = [
            { usageType: 'definition' },
            { usageType: 'import' },
            { usageType: 'call' },
        ];
        const verdict = policy.deleteVerdictFromUsages(rows);
        assert.strictEqual(verdict.safe, false);
        assert.strictEqual(verdict.usageEvidence, 1);
        assert.strictEqual(policy.deleteVerdictFromUsages(rows.slice(0, 2)).safe, true);
    });

    it('usages verdict ignores rows inside the definition range (deleted with it)', () => {
        const rows = [
            { usageType: 'definition', relativePath: 'map.rs', line: 10 },
            { usageType: 'call', relativePath: 'map.rs', line: 12 },
            { usageType: 'call', relativePath: 'app.rs', line: 3 },
        ];
        const def = { file: 'map.rs', startLine: 10, endLine: 14 };
        const verdict = policy.deleteVerdictFromUsages(rows, def);
        assert.strictEqual(verdict.usageEvidence, 1);
        assert.strictEqual(verdict.safe, false);
        const selfOnly = policy.deleteVerdictFromUsages(rows.slice(0, 2), def);
        assert.strictEqual(selfOnly.safe, true);
    });
});

describe('outcome-policy: judge parsing and error diffing', () => {
    it('parses go build and go vet output', () => {
        const text = [
            'internal/a.go:10:5: undefined: format_data',
            'vet: internal/b.go:3:1: undefined: helper',
            '# example.com/pkg',
            'random noise',
        ].join('\n');
        const keys = policy.parseGoErrors(text);
        assert.strictEqual(keys.length, 2);
        assert.ok(keys[0].startsWith('internal/a.go|undefined: format_data'));
    });

    it('parses cargo short-format errors and ignores warnings', () => {
        const text = [
            'src/lib.rs:10:5: error[E0425]: cannot find function `run2` in this scope',
            'src/lib.rs:11:5: warning: unused variable: `x`',
        ].join('\n');
        const keys = policy.parseCargoErrors(text);
        assert.strictEqual(keys.length, 1);
        assert.ok(keys[0].includes('cannot find function'));
    });

    it('dedupes cargo compilation-context echoes of one diagnostic', () => {
        // rust-csv-measured: benches/bench.rs compiles as bench AND test
        // target under --all-targets — a dirty bench emits the crate-level
        // `#![feature]` error twice while the cached baseline replayed it
        // once, so the multiset diff manufactured a phantom new error.
        const text = [
            'benches/bench.rs:1:1: error[E0554]: `#![feature]` may not be used on the stable release channel',
            'benches/bench.rs:1:1: error[E0554]: `#![feature]` may not be used on the stable release channel',
        ].join('\n');
        const keys = policy.parseCargoErrors(text);
        assert.strictEqual(keys.length, 1);
        assert.deepStrictEqual(
            policy.diffErrorKeys(policy.parseCargoErrors(text.split('\n')[0]), keys), []);
    });

    it('parses javac errors, relative keys, footer ignored, echoes deduped', () => {
        const text = [
            'gson/src/main/java/com/google/gson/JsonArray.java:106: error: method add(Number) is already defined',
            'gson/src/main/java/com/google/gson/JsonArray.java:106: error: method add(Number) is already defined',
            'gson/src/main/java/com/google/gson/Gson.java:50: warning: [deprecation] x',
            '2 errors',
        ].join('\n');
        const keys = policy.parseJavacErrors(text);
        assert.strictEqual(keys.length, 1);
        assert.ok(keys[0].startsWith('gson/src/main/java/com/google/gson/JsonArray.java|'));
    });

    it('parses pyright JSON errors only', () => {
        const doc = {
            generalDiagnostics: [
                { file: '/r/a.py', severity: 'error', rule: 'reportUndefinedVariable', message: '"x" is not defined' },
                { file: '/r/a.py', severity: 'warning', message: 'unused' },
            ],
        };
        const keys = policy.parsePyrightErrors(doc);
        assert.strictEqual(keys.length, 1);
        assert.ok(keys[0].includes('reportUndefinedVariable'));
    });

    it('parses tsc errors', () => {
        const keys = policy.parseTscErrors(
            "src/a.ts(4,1): error TS2304: Cannot find name 'oldName'.");
        assert.strictEqual(keys.length, 1);
        assert.ok(keys[0].includes('TS2304'));
    });

    it('diffErrorKeys is multiset-aware and line-shift tolerant', () => {
        const baseline = ['a.py||x is broken', 'a.py||x is broken'];
        const after = ['a.py||x is broken', 'a.py||x is broken', 'a.py||x is broken', 'b.py||new'];
        assert.deepStrictEqual(policy.diffErrorKeys(baseline, after),
            ['a.py||x is broken', 'b.py||new']);
        assert.deepStrictEqual(policy.diffErrorKeys(after, baseline), []);
    });
});

describe('outcome-policy: aggregation', () => {
    const arms = ['grep', 'ucn-contract'];

    it('aggregates rename tasks with paired clean-vs-broken counts', () => {
        const cost = { outputChars: 100, toolCalls: 1, wallMs: 50 };
        const tasks = [
            {
                id: 'r1',
                arms: {
                    grep: { broken: true, newErrorCount: 2, proposedSites: 9, noEffectEdits: 1, cost },
                    'ucn-contract': { broken: false, newErrorCount: 0, proposedSites: 4, noEffectEdits: 0, cost },
                },
            },
            {
                id: 'r2',
                arms: {
                    grep: { broken: false, newErrorCount: 0, proposedSites: 3, noEffectEdits: 0, cost },
                    'ucn-contract': { broken: false, newErrorCount: 0, proposedSites: 3, noEffectEdits: 0, cost },
                },
            },
        ];
        const agg = policy.aggregateRenameTasks(tasks, arms);
        assert.strictEqual(agg.perArm.grep.brokenBuildRate, 0.5);
        assert.strictEqual(agg.perArm['ucn-contract'].brokenBuildRate, 0);
        assert.strictEqual(agg.allArmsBroke, 0);
        assert.strictEqual(agg.allArmsClean, 1);
        assert.strictEqual(agg.pairedCleanVsBroken['ucn-contract>-<grep'], 1);
        assert.strictEqual(agg.pairedCleanVsBroken['grep>-<ucn-contract'], 0);
    });

    it('aggregates delete verdicts with falseSafe as the dangerous direction', () => {
        const tasks = [
            { groundBroken: true, arms: { grep: { safe: false }, 'ucn-contract': { safe: true } } },
            { groundBroken: false, arms: { grep: { safe: false }, 'ucn-contract': { safe: true } } },
        ];
        const agg = policy.aggregateDeleteTasks(tasks, arms);
        assert.strictEqual(agg.perArm['ucn-contract'].falseSafe, 1);
        assert.strictEqual(agg.perArm['ucn-contract'].falseSafeRate, 0.5);
        assert.strictEqual(agg.perArm.grep.falseSafe, 0);
        assert.strictEqual(agg.perArm.grep.falseUnsafeUpperBound, 1);
        assert.strictEqual(agg.perArm.grep.agreementWithJudge, 0.5);
    });

    it('review rows abstain: excluded from falseSafe and decisive agreement', () => {
        const tasks = [
            // Review on a deletion that DID break — the tier intercepted it.
            { groundBroken: true, arms: { grep: { safe: true }, 'ucn-contract': { verdict: 'review' } } },
            // Review on a clean deletion — the over-caution upper bound.
            { groundBroken: false, arms: { grep: { safe: true }, 'ucn-contract': { verdict: 'review' } } },
            // Decisive verdicts still count normally.
            { groundBroken: false, arms: { grep: { safe: true }, 'ucn-contract': { verdict: 'safe' } } },
            { groundBroken: true, arms: { grep: { safe: false }, 'ucn-contract': { verdict: 'unsafe' } } },
        ];
        const agg = policy.aggregateDeleteTasks(tasks, arms);
        const contract = agg.perArm['ucn-contract'];
        assert.strictEqual(contract.review, 2);
        assert.strictEqual(contract.reviewGroundBroken, 1);
        assert.strictEqual(contract.reviewGroundClean, 1);
        assert.strictEqual(contract.saidSafe, 1);
        assert.strictEqual(contract.falseSafe, 0);
        assert.strictEqual(contract.agreementWithJudge, 1); // 2/2 decisive
        // The binary grep arm keeps its shape: one falseSafe (task 1).
        assert.strictEqual(agg.perArm.grep.falseSafe, 1);
    });
});

describe('outcome-policy: tri-state delete verdict', () => {
    it('usage evidence and confirmed callers are always unsafe', () => {
        assert.strictEqual(policy.deleteVerdictTriState({
            confirmedCallers: 2, usageEvidence: 0, audit: { claimed: true },
        }).verdict, 'unsafe');
        assert.strictEqual(policy.deleteVerdictTriState({
            confirmedCallers: 0, usageEvidence: 3, audit: { claimed: true },
        }).verdict, 'unsafe');
    });

    it('zero evidence is safe only when the audit claims the symbol dead', () => {
        const claimed = policy.deleteVerdictTriState({
            confirmedCallers: 0, usageEvidence: 0,
            audit: { claimed: true, claimsWithdrawn: false },
        });
        assert.strictEqual(claimed.verdict, 'safe');
        assert.strictEqual(claimed.reason, 'claimed-dead-by-audit');
        // The websocket Temporary/Timeout family: zero text evidence, but the
        // default audit excludes exported symbols — review, never safe.
        const unclaimed = policy.deleteVerdictTriState({
            confirmedCallers: 0, usageEvidence: 0,
            audit: { claimed: false, claimsWithdrawn: false },
        });
        assert.strictEqual(unclaimed.verdict, 'review');
        assert.strictEqual(unclaimed.reason, 'not-claimed-by-audit');
    });

    it('an unusable audit or usages answer routes review, never safe', () => {
        assert.strictEqual(policy.deleteVerdictTriState({
            confirmedCallers: 0, usageEvidence: 0, audit: null,
        }).verdict, 'review');
        assert.strictEqual(policy.deleteVerdictTriState({
            confirmedCallers: 0, usageEvidence: -1, audit: { claimed: true },
        }).verdict, 'review');
        assert.strictEqual(policy.deleteVerdictTriState({
            confirmedCallers: 0, usageEvidence: 0,
            audit: { claimed: true, claimsWithdrawn: true },
        }).verdict, 'review');
    });

    it('deadcodeClaimForTask matches by name, file and definition range', () => {
        const data = {
            symbols: [
                { name: 'helper', file: 'lib/util.py', startLine: 10, endLine: 14 },
            ],
            coverage: { complete: false, claimsWithdrawn: true },
        };
        const hit = policy.deadcodeClaimForTask(data, {
            name: 'helper', relativePath: 'lib/util.py', startLine: 10, endLine: 14,
        });
        assert.strictEqual(hit.claimed, true);
        assert.strictEqual(hit.claimsWithdrawn, true);
        const otherFile = policy.deadcodeClaimForTask(data, {
            name: 'helper', relativePath: 'lib/other.py', startLine: 10, endLine: 14,
        });
        assert.strictEqual(otherFile.claimed, false);
    });

    it('accepts the public CLI document shape (data array + meta.coverage)', () => {
        const doc = {
            data: [{ name: 'orphanHelper', file: 'main.go', startLine: 9, endLine: 9 }],
            meta: { coverage: { complete: true, claimsWithdrawn: false } },
        };
        const hit = policy.deadcodeClaimForTask(doc, {
            name: 'orphanHelper', relativePath: 'main.go', startLine: 9, endLine: 9,
        });
        assert.strictEqual(hit.claimed, true);
        assert.strictEqual(hit.claimsWithdrawn, false);
        const withdrawn = policy.deadcodeClaimForTask({
            data: [], meta: { coverage: { complete: false, claimsWithdrawn: true } },
        }, { name: 'x', relativePath: 'y.go', startLine: 1, endLine: 1 });
        assert.strictEqual(withdrawn.claimsWithdrawn, true);
    });
});

describe('outcome-policy: gate thresholds', () => {
    const cleanReport = () => ({
        repo: 'demo',
        judgeErrors: 0,
        renameProposalErrors: 0,
        deleteProposalErrors: 0,
        rename: { aggregate: { perArm: {
            grep: { brokenBuildRate: 0.3 },
            'ucn-contract': { brokenBuildRate: 0.1 },
        } } },
        delete: { aggregate: { perArm: {
            'ucn-contract': {
                falseSafe: 0, saidSafe: 2,
                positive: { tasks: 2, safe: 2, rate: 1 },
                contractBound: { tasks: 1, falseSafe: 0 },
            },
        } } },
        language: 'python',
        check: {
            applicability: Object.fromEntries(policy.CHECK_TASK_KINDS.map(kind => [kind, true])),
            aggregate: policy.aggregateCheckTasks(policy.CHECK_TASK_KINDS.map(kind => ({
                kind, verdict: policy.CHECK_VERDICTS.review, outsideNew: 0, insideNew: 0,
            }))),
        },
    });

    it('passes a clean report', () => {
        assert.deepStrictEqual(policy.evaluateOutcomeGate([cleanReport()]), []);
    });

    it('fails on contract delete falseSafe, judge errors, proposal errors', () => {
        const bad = cleanReport();
        bad.judgeErrors = 1;
        bad.deleteProposalErrors = 2;
        bad.delete.aggregate.perArm['ucn-contract'].falseSafe = 1;
        const failures = policy.evaluateOutcomeGate([bad]);
        assert.strictEqual(failures.length, 3);
        assert.ok(failures.some(text => text.includes('judge error')));
        assert.ok(failures.some(text => text.includes('proposal failure')));
        assert.ok(failures.some(text => text.includes('falseSafe')));
    });

    it('fails when the contract rename rate exceeds the grep baseline', () => {
        const bad = cleanReport();
        bad.rename.aggregate.perArm['ucn-contract'].brokenBuildRate = 0.4;
        const failures = policy.evaluateOutcomeGate([bad]);
        assert.strictEqual(failures.length, 1);
        assert.ok(failures[0].includes('exceeds grep baseline'));
        // Equal to the baseline is acceptable — grep is the floor, not a margin.
        const even = cleanReport();
        even.rename.aggregate.perArm['ucn-contract'].brokenBuildRate = 0.3;
        assert.deepStrictEqual(policy.evaluateOutcomeGate([even]), []);
    });
});

describe('outcome-policy: deletion guidance metrics', () => {
    const arms = ['ucn-contract'];
    const row = (verdict, groundBroken, extra = {}) => ({
        groundBroken, ...extra,
        arms: { 'ucn-contract': typeof verdict === 'string' ? { verdict } : verdict },
    });

    it('reports positive, negative and abstention views separately', () => {
        const tasks = [
            row('safe', false, { positiveSet: 'seeded-dead' }),
            row({ verdict: 'review', verdictReason: 'not-claimed-by-audit' }, false,
                { positiveSet: 'private-zero' }),
            row('unsafe', true),
            row({ verdict: 'review', verdictReason: 'audit-coverage-incomplete' }, true),
            row('unsafe', false),
        ];
        const contract = policy.aggregateDeleteTasks(tasks, arms).perArm['ucn-contract'];
        assert.deepStrictEqual(contract.positive, { tasks: 2, safe: 1, rate: 0.5 });
        assert.deepStrictEqual(contract.negative,
            { tasks: 2, unsafe: 1, review: 1, safe: 0, correctRate: 0.5 });
        assert.deepStrictEqual(contract.abstention, {
            review: 2, rate: 0.4,
            byReason: { 'audit-coverage-incomplete': 1, 'not-claimed-by-audit': 1 },
        });
    });

    it('a positive-set row whose deletion broke the build is not a positive case', () => {
        const contract = policy.aggregateDeleteTasks(
            [row('safe', true, { positiveSet: 'private-zero' })], arms).perArm['ucn-contract'];
        assert.strictEqual(contract.positive.tasks, 0);
        assert.strictEqual(contract.positive.rate, null);
        assert.strictEqual(contract.falseSafe, 1);
    });

    const gateReport = tasks => ({
        repo: 'demo', language: 'python', judgeErrors: 0,
        renameProposalErrors: 0, deleteProposalErrors: 0,
        delete: { aggregate: policy.aggregateDeleteTasks(tasks, arms) },
    });
    const floors = {
        ...policy.OUTCOME_GATE_THRESHOLDS,
        requireCheckCoverage: false,
        contractPositiveVerdictFloor: { demo: 0.5 },
    };
    const positives = verdict => [
        row(verdict, false, { positiveSet: 'seeded-dead' }),
        row(verdict, false, { positiveSet: 'seeded-dead' }),
        row('unsafe', true),
    ];

    it('an always-unsafe arm is fully decisive and still fails the gate', () => {
        const report = gateReport(positives('unsafe'));
        const contract = report.delete.aggregate.perArm['ucn-contract'];
        assert.strictEqual(contract.falseSafe, 0);
        assert.strictEqual(contract.review, 0); // decisive on every task
        assert.strictEqual(contract.positive.rate, 0);
        const failures = policy.evaluateOutcomeGate([report], floors);
        assert.strictEqual(failures.length, 1);
        assert.match(failures[0], /positive-verdict rate 0 below floor 0\.5/);
    });

    it('an always-review arm fails the same floor; a correct arm passes', () => {
        assert.strictEqual(
            policy.evaluateOutcomeGate([gateReport(positives('review'))], floors).length, 1);
        assert.deepStrictEqual(
            policy.evaluateOutcomeGate([gateReport(positives('safe'))], floors), []);
    });

    it('a positive set below the coverage minimum fails even without a floor', () => {
        const thin = gateReport([row('safe', false, { positiveSet: 'seeded-dead' })]);
        const failures = policy.evaluateOutcomeGate([thin],
            { ...policy.OUTCOME_GATE_THRESHOLDS, requireCheckCoverage: false });
        assert.strictEqual(failures.length, 1);
        assert.match(failures[0], /positive delete set has 1 task\(s\) \(min 2\)/);
    });

    it('seeded contract-bound falseSafe is always counted and gated on request', () => {
        const tasks = [
            ...positives('safe').slice(0, 2),
            row('safe', true, { seededKind: 'contract-bound' }),
        ];
        const report = gateReport(tasks);
        const contract = report.delete.aggregate.perArm['ucn-contract'];
        assert.strictEqual(contract.falseSafe, 1); // never hidden from the report
        assert.deepStrictEqual(contract.contractBound, { tasks: 1, falseSafe: 1 });
        const base = { ...policy.OUTCOME_GATE_THRESHOLDS, requireCheckCoverage: false };
        assert.deepStrictEqual(policy.evaluateOutcomeGate([report], base), []);
        const enforced = policy.evaluateOutcomeGate([report],
            { ...base, enforceSeededContractBound: true });
        assert.strictEqual(enforced.length, 1);
        assert.match(enforced[0], /contract delete falseSafe 1/);
    });

    it('language privacy is read from the header, unknown is not private', () => {
        assert.strictEqual(policy.isLanguagePrivate('python', '_helper', 'def _helper():'), true);
        assert.strictEqual(policy.isLanguagePrivate('python', 'helper', 'def helper():'), false);
        assert.strictEqual(policy.isLanguagePrivate('python', '__init__', 'def __init__(self):'), false);
        assert.strictEqual(policy.isLanguagePrivate('go', 'helper', 'func helper() {'), true);
        assert.strictEqual(policy.isLanguagePrivate('go', 'Helper', 'func Helper() {'), false);
        assert.strictEqual(policy.isLanguagePrivate('rust', 'helper', 'fn helper() {'), true);
        assert.strictEqual(policy.isLanguagePrivate('rust', 'helper', 'pub(crate) fn helper() {'), false);
        assert.strictEqual(policy.isLanguagePrivate('java', 'helper', 'private int helper() {'), true);
        assert.strictEqual(policy.isLanguagePrivate('java', 'helper', 'int helper() {'), false);
        assert.strictEqual(policy.isLanguagePrivate('typescript', 'helper', 'function helper() {'), false);
    });
});

describe('outcome-policy: judge diagnostics keep locations', () => {
    it('each judge parser returns key, file and line; key lists are unchanged', () => {
        const go = './conn.go:12:3: undefined: x\nvet: ./a.go:7: bad';
        assert.deepStrictEqual(policy.parseGoDiagnostics(go), [
            { key: './conn.go|undefined: x', file: 'conn.go', line: 12 },
            { key: './a.go|bad', file: 'a.go', line: 7 },
        ]);
        assert.deepStrictEqual(policy.parseGoErrors(go), ['./conn.go|undefined: x', './a.go|bad']);

        const cargo = [
            'src/lib.rs:3:1: error[E0425]: nope',
            'src/lib.rs:3:1: error[E0425]: nope', // second target context
            'src/lib.rs:9:1: error[E0425]: nope',
        ].join('\n');
        assert.deepStrictEqual(policy.parseCargoDiagnostics(cargo).map(d => d.line), [3, 9]);
        assert.deepStrictEqual(policy.parseCargoErrors(cargo), ['src/lib.rs|nope']);

        const pyright = { generalDiagnostics: [
            { severity: 'error', file: '/r/app/a.py', rule: 'reportCallIssue',
              message: 'Missing argument', range: { start: { line: 4, character: 0 } } },
            { severity: 'warning', file: '/r/app/a.py', message: 'ignored' },
        ] };
        assert.deepStrictEqual(policy.parsePyrightDiagnostics(pyright, '/r'), [
            { key: 'app/a.py|reportCallIssue|Missing argument', file: 'app/a.py', line: 5 },
        ]);

        assert.deepStrictEqual(policy.parseJavacDiagnostics('A.java:8: error: cannot find symbol'),
            [{ key: 'A.java|cannot find symbol', file: 'A.java', line: 8 }]);
        assert.deepStrictEqual(policy.parseTscDiagnostics('src/a.ts(3,5): error TS2339: nope'),
            [{ key: 'src/a.ts|TS2339|nope', file: 'src/a.ts', line: 3 }]);
    });

    it('places new diagnostics inside or outside the edit ranges', () => {
        const after = [
            { key: 'a.py|r|in the edit', file: 'a.py', line: 5 },
            { key: 'b.py|r|a caller broke', file: 'b.py', line: 40 },
            { key: 'a.py|r|pre-existing', file: 'a.py', line: 90 },
        ];
        const placed = policy.classifyNewDiagnostics(
            ['a.py|r|pre-existing'], after, [{ file: './a.py', startLine: 4, endLine: 6 }]);
        assert.strictEqual(placed.inside, 1);
        assert.strictEqual(placed.outside, 1);
        assert.deepStrictEqual(placed.outsideSamples, ['b.py|r|a caller broke']);
    });

    it('a key seen both inside and outside the edit counts as outside', () => {
        const after = [
            { key: 'a.py|r|same message', file: 'a.py', line: 5 },
            { key: 'a.py|r|same message', file: 'a.py', line: 60 },
        ];
        const placed = policy.classifyNewDiagnostics(
            [], after, [{ file: 'a.py', startLine: 5, endLine: 5 }]);
        assert.strictEqual(placed.inside, 0);
        assert.strictEqual(placed.outside, 2);
    });

    it('a deletion is zero-width: nothing is inside it', () => {
        const placed = policy.classifyNewDiagnostics([],
            [{ key: 'a.go|undefined: gone', file: 'a.go', line: 10 }],
            [{ file: 'a.go', startLine: 10, endLine: 9 }]);
        assert.strictEqual(placed.outside, 1);
    });
});

describe('outcome-policy: precommit-check tasks', () => {
    const { ready, review, blocked } = policy.CHECK_VERDICTS;

    it('scores readiness against dependents, not against the changed lines', () => {
        const agg = policy.aggregateCheckTasks([
            { kind: 'additive', verdict: blocked, outsideNew: 0, insideNew: 0 },
            { kind: 'additive', verdict: ready, outsideNew: 0, insideNew: 2 },
            { kind: 'required-param', verdict: blocked, outsideNew: 3, insideNew: 0 },
            { kind: 'return-contract-edit', verdict: ready, outsideNew: 1, insideNew: 0 },
            { kind: 'inert-body-edit', verdict: review, outsideNew: 0, insideNew: 0 },
        ]);
        assert.strictEqual(agg.tasks, 5);
        assert.strictEqual(agg.falseReady, 1);
        assert.strictEqual(agg.brokenFlagged, 1);
        assert.strictEqual(agg.groundClean, 3);
        assert.strictEqual(agg.blockedOnClean, 1);
        assert.strictEqual(agg.readyOnClean, 1);
        assert.strictEqual(agg.insideOnlyDiagnostics, 1);
        assert.strictEqual(agg.readyOnCleanRate, 0.3333);
        assert.strictEqual(agg.byKind.additive.blockedOnCleanRate, 0.5);
        assert.strictEqual(agg.byKind['return-contract-edit'].falseReady, 1);
        assert.strictEqual(agg.byKind['return-contract-edit'].readyOnCleanRate, null);
    });

    it('derives applicability from traits, never from a language name', () => {
        const inferring = policy.checkKindApplicability(
            { inferredReturnForms: ['unannotated'], callableKindFromBody: ['generator'] });
        assert.strictEqual(inferring['return-contract-edit'], true);
        assert.strictEqual(inferring['generator-transition'], true);
        const declared = policy.checkKindApplicability(
            { inferredReturnForms: [], callableKindFromBody: [] });
        assert.strictEqual(declared['return-contract-edit'], false);
        assert.strictEqual(declared['generator-transition'], false);
        assert.strictEqual(declared['required-param'], true);
        // A placeholder or opaque return is inferred too, but the board has
        // no mutation for it: not applicable to this instrument.
        assert.strictEqual(policy.checkKindApplicability(
            { inferredReturnForms: ['opaque'] })['return-contract-edit'], false);
    });

    it('the shipped traits give the board its languages\' real matrix', () => {
        const { langTraits } = require('../languages');
        const python = policy.checkKindApplicability(langTraits('python'));
        assert.strictEqual(python['return-contract-edit'], true);
        assert.strictEqual(python['generator-transition'], true);
        for (const language of ['go', 'rust', 'java']) {
            const matrix = policy.checkKindApplicability(langTraits(language));
            assert.strictEqual(matrix['return-contract-edit'], false, language);
            assert.strictEqual(matrix['generator-transition'], false, language);
            assert.strictEqual(matrix['inert-body-edit'], true, language);
        }
        // JS infers an unannotated return; only a header (`function*`) makes
        // a generator.
        const js = policy.checkKindApplicability(langTraits('javascript'));
        assert.strictEqual(js['return-contract-edit'], true);
        assert.strictEqual(js['generator-transition'], false);
    });

    const report = (repo, language, applicability, kinds) => ({
        repo, language, judgeErrors: 0,
        check: {
            applicability,
            aggregate: policy.aggregateCheckTasks(kinds.map(kind => ({
                kind, verdict: review, outsideNew: 0, insideNew: 0,
            }))),
        },
    });
    const all = Object.fromEntries(policy.CHECK_TASK_KINDS.map(kind => [kind, true]));
    const declaredOnly = { ...all, 'return-contract-edit': false, 'generator-transition': false };
    const declaredKinds = policy.CHECK_TASK_KINDS.filter(kind => declaredOnly[kind]);

    it('an inapplicable pair is N/A; the board still needs every kind somewhere', () => {
        const board = [
            report('py', 'python', all, policy.CHECK_TASK_KINDS),
            report('gorepo', 'go', declaredOnly, declaredKinds),
        ];
        assert.deepStrictEqual(policy.evaluateCheckCoverage(board), []);
        const goOnly = policy.evaluateCheckCoverage([board[1]]);
        assert.deepStrictEqual(goOnly, [
            'board: check kind return-contract-edit is judged on no repo',
            'board: check kind generator-transition is judged on no repo',
        ]);
    });

    it('an applicable pair with no judged task fails by name', () => {
        const thin = report('py', 'python', all,
            policy.CHECK_TASK_KINDS.filter(kind => kind !== 'required-param'));
        const failures = policy.evaluateCheckCoverage([thin]);
        assert.deepStrictEqual(failures, [
            'py: no judged required-param check task (applicable to python)',
            'board: check kind required-param is judged on no repo',
        ]);
    });

    it('a report without check tasks cannot pass the gate', () => {
        const failures = policy.evaluateOutcomeGate([{ repo: 'demo', judgeErrors: 0 }]);
        assert.ok(failures.includes('demo: no check tasks in the report'));
    });

    it('a known false-ready row is pinned by id; a new one still fails', () => {
        const tasks = [
            ...policy.CHECK_TASK_KINDS.map(kind => ({
                id: `a.py:1:${kind}`, kind, verdict: review, outsideNew: 0 })),
            { id: 'a.py:9:known', kind: 'generator-transition', verdict: ready, outsideNew: 4 },
        ];
        const pinned = report('py', 'python', all, policy.CHECK_TASK_KINDS);
        pinned.check.tasks = tasks;
        pinned.check.aggregate = policy.aggregateCheckTasks(tasks);
        const thresholds = {
            ...policy.OUTCOME_GATE_THRESHOLDS, knownCheckFalseReady: { py: ['a.py:9:known'] },
        };
        assert.strictEqual(pinned.check.aggregate.falseReady, 1); // still reported
        assert.deepStrictEqual(policy.evaluateOutcomeGate([pinned], thresholds), []);
        pinned.check.tasks = [...tasks,
            { id: 'b.py:3:fresh', kind: 'required-param', verdict: ready, outsideNew: 1 }];
        pinned.check.aggregate = policy.aggregateCheckTasks(pinned.check.tasks);
        const failures = policy.evaluateOutcomeGate([pinned], thresholds);
        assert.deepStrictEqual(failures, ['py: check falseReady 1 (max 0): b.py:3:fresh']);
    });

    it('the gate fails on falseReady and on a missed READY floor', () => {
        const bad = report('py', 'python', all, policy.CHECK_TASK_KINDS);
        bad.check.aggregate = policy.aggregateCheckTasks([
            ...policy.CHECK_TASK_KINDS.map(kind => ({ kind, verdict: review, outsideNew: 0 })),
            { kind: 'required-param', verdict: ready, outsideNew: 2 },
        ]);
        const failures = policy.evaluateOutcomeGate([bad], {
            ...policy.OUTCOME_GATE_THRESHOLDS, checkReadyOnCleanFloor: { py: 0.5 },
        });
        assert.ok(failures.some(text => /py: check falseReady 1 \(max 0\)/.test(text)));
        assert.ok(failures.some(text => /py: check READY rate on clean changes 0 below floor 0\.5/.test(text)));
    });
});

describe('fix #429: value-member rename mode is measurement-only', () => {
    const path = require('path');
    const { spawnSync } = require('child_process');
    const script = path.join(__dirname, '..', 'eval', 'run-outcome-eval.js');
    it('--kinds value cannot run as the gate', () => {
        const result = spawnSync(process.execPath, [script, '--gate', '--kinds', 'value'], { encoding: 'utf8' });
        assert.notStrictEqual(result.status, 0);
        assert.match(result.stderr, /--kinds value is a measurement mode/);
    });
    it('--kinds accepts only callable or value', () => {
        const result = spawnSync(process.execPath, [script, '--kinds', 'type'], { encoding: 'utf8' });
        assert.notStrictEqual(result.status, 0);
        assert.match(result.stderr, /--kinds must be callable or value/);
    });
});
