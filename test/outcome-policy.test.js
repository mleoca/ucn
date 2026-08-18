'use strict';

/**
 * Unit tests for eval/outcome-policy.js — the pure logic of the task-outcome
 * eval (proposal extraction, mechanical edits, judge parsing, aggregation).
 */

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

    it('applyDeleteToContent removes the inclusive 1-based range', () => {
        assert.strictEqual(policy.applyDeleteToContent('l1\nl2\nl3\nl4', 2, 3), 'l1\nl4');
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
});
