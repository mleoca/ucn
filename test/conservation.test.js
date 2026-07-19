/**
 * Conservation-law tests: the answer to "who calls X" must be a PARTITION of
 * the text-occurrence ground set, never a subset.
 *
 * Invariant (core/account.js):
 *   groundTotal === confirmed + unverified + nonCall.total + excluded.total
 *                   + unparsed.lines + unaccounted
 *
 * Phase 1 (baseline): the invariant arithmetic must hold exactly; engine
 * misses surface as `call-not-resolved` unverified lines, and the per-symbol
 * gap is logged. Phase 2 instruments the engine so every drop carries a
 * reason; Phase 3 makes the unverified tier visible in output.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { tmp, rm, idx, forEachLanguage } = require('./helpers');
const { computeGroundSet, buildAccount } = require('../core/account');

/**
 * Build the account for a symbol. Prefers the ENGINE-composed account
 * (ctx.meta.account from collectAccount instrumentation); falls back to a
 * manual composition for symbols with no definition (context returns null).
 * STRICT since Phase 2: the invariant must hold exactly, always.
 */
function accountForSymbol(index, name, { log = false } = {}) {
    index._beginOp();
    try {
        const ctx = index.context(name);
        let account;
        if (ctx && ctx.meta && ctx.meta.account) {
            account = ctx.meta.account;
        } else {
            // No definition (or class-type context) — manual composition over
            // the raw text ground set with no engine claims.
            const groundSet = computeGroundSet(index, name);
            const confirmedEntries = ((ctx && ctx.callers) || []).map(c => ({ file: c.file, line: c.line }));
            account = buildAccount(index, name, { groundSet, confirmedEntries });
        }

        // The arithmetic identity must hold unconditionally — a non-zero
        // residual means double-counting or a classification bug.
        const sum = account.confirmed + account.unverified + account.nonCall.total
            + account.excluded.total + account.unparsed.lines + account.unaccounted;
        assert.strictEqual(sum, account.groundTotal,
            `buckets must sum to groundTotal for "${name}": ${JSON.stringify(account)}`);
        assert.strictEqual(account.unaccounted, 0,
            `unaccounted must be 0 for "${name}": ${JSON.stringify(account)}`);
        assert.ok(account.conserved, `account.conserved must be true for "${name}"`);
        assert.strictEqual(account.contract.kind, 'literal-name-text-partition');
        assert.strictEqual(account.contract.semanticComplete, false,
            'text conservation must never be represented as semantic completeness');
        assert.strictEqual(account.contract.safeToDelete, false,
            'a zero literal-name partition is not deletion proof');
        assert.strictEqual(account.contract.textComplete,
            account.unparsed.fileCount === 0 && account.unreadableFiles.length === 0,
            'parse/read failures must degrade the text contract');

        if (log && account.callNotResolved && account.callNotResolved.length > 0) {
            console.log(`  [gap] "${name}": ${account.callNotResolved.length} call line(s) not claimed by engine`,
                account.callNotResolved.slice(0, 3).map(c => `${c.relativePath}:${c.line}`).join(', '));
        }
        return account;
    } finally {
        index._endOp();
    }
}

// ── Per-language ground-set fixtures with hand-counted occurrences ──────────
// Each template defines exactly which lines word-boundary-match `target`.
const CONSERVATION_FIXTURES = {
    javascript: {
        files: {
            'package.json': '{"name":"t"}',
            'lib.js': [
                'function target() { return 1; }',            // def
                'function caller() { return target(); }',     // call
                '// target appears in this comment',           // comment
                'const s = "target in string";',               // string
                'module.exports = { target, caller };',        // export ref
            ].join('\n'),
        },
        expectedTotal: 5,
        minUnclassified: 2, // comment + string
    },
    typescript: {
        files: {
            'package.json': '{"name":"t"}',
            'lib.ts': [
                'export function target(): number { return 1; }',
                'export function caller(): number { return target(); }',
                '// target appears in this comment',
                'const s = "target in string";',
            ].join('\n'),
        },
        expectedTotal: 4,
        minUnclassified: 2,
    },
    python: {
        files: {
            'lib.py': [
                'def target():',
                '    return 1',
                '',
                'def caller():',
                '    # target appears in this comment',
                '    s = "target in string"',
                '    return target()',
            ].join('\n'),
        },
        expectedTotal: 4,
        minUnclassified: 2,
    },
    go: {
        files: {
            'go.mod': 'module test\n\ngo 1.21',
            'lib.go': [
                'package main',
                '',
                'func target() int { return 1 }',
                '',
                'func caller() int {',
                '\t// target appears in this comment',
                '\ts := "target in string"',
                '\t_ = s',
                '\treturn target()',
                '}',
            ].join('\n'),
        },
        expectedTotal: 4,
        minUnclassified: 2,
    },
    rust: {
        files: {
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"',
            'lib.rs': [
                'fn target() -> i32 { 1 }',
                '',
                'fn caller() -> i32 {',
                '    // target appears in this comment',
                '    let s = "target in string";',
                '    let _ = s;',
                '    target()',
                '}',
            ].join('\n'),
        },
        expectedTotal: 4,
        minUnclassified: 2,
    },
    java: {
        files: {
            'Lib.java': [
                'public class Lib {',
                '    public static int target() { return 1; }',
                '    public static int caller() {',
                '        // target appears in this comment',
                '        String s = "target in string";',
                '        return target();',
                '    }',
                '}',
            ].join('\n'),
        },
        expectedTotal: 4,
        minUnclassified: 2,
    },
};

describe('conservation: ground-set semantics', () => {
    it('JS: hand-counted ground set with exact buckets', () => {
        const dir = tmp(CONSERVATION_FIXTURES.javascript.files);
        try {
            const index = idx(dir);
            index._beginOp();
            try {
                const ground = computeGroundSet(index, 'target');
                assert.strictEqual(ground.total, 5, 'def + call + comment + string + export = 5 lines');
                assert.strictEqual(ground.fileCount, 1);
                assert.strictEqual(ground.unparsed.lines, 0);
            } finally { index._endOp(); }

            const account = accountForSymbol(index, 'target', { log: true });
            assert.strictEqual(account.groundTotal, 5);
            // comment + string can never be claimed by anything
            assert.ok(account.nonCall.unclassifiedText >= 2,
                `comment+string lines must land in unclassifiedText: ${JSON.stringify(account.nonCall)}`);
            // the call line must be claimed (confirmed) or surface as unverified — never vanish
            assert.ok(account.confirmed + account.unverified >= 1,
                `call line must be confirmed or unverified: ${JSON.stringify(account)}`);
        } finally { rm(dir); }
    });

    it('JS: word-boundary semantics — substring inside identifier does not count', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': [
                'function parse(x) { return x; }',
                'function myParse(x) { return x; }',          // "parse" inside myParse: NOT a \\bparse\\b match
                'const spectrum = 1;',                          // unrelated
                'module.exports = { parse, myParse };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            index._beginOp();
            try {
                const ground = computeGroundSet(index, 'parse');
                // line 1 (def) and line 4 (export) only
                assert.strictEqual(ground.total, 2, `\\bparse\\b must not match inside myParse: ${ground.total}`);
            } finally { index._endOp(); }
        } finally { rm(dir); }
    });

    it('JS: builtin token lands in unclassifiedText (scanner-skipped, honestly unclassified)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': [
                'function run(s) { return JSON.parse(s); }',   // `parse` via builtin member — scanner skips
                'module.exports = { run };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const account = accountForSymbol(index, 'parse');
            assert.strictEqual(account.groundTotal, 1);
            assert.strictEqual(account.conserved, true);
            // however the line is classified, it must be accounted — not silently dropped
            const sum = account.confirmed + account.unverified + account.nonCall.total + account.excluded.total;
            assert.strictEqual(sum, 1, `the JSON.parse line must land in exactly one bucket: ${JSON.stringify(account)}`);
        } finally { rm(dir); }
    });

    forEachLanguage((lang) => {
        const fixture = CONSERVATION_FIXTURES[lang];
        if (!fixture) return;
        it(`${lang}: ground total matches hand count and arithmetic conserves`, () => {
            const dir = tmp(fixture.files);
            try {
                const index = idx(dir);
                index._beginOp();
                try {
                    const ground = computeGroundSet(index, 'target');
                    assert.strictEqual(ground.total, fixture.expectedTotal,
                        `${lang}: hand-counted ground total`);
                } finally { index._endOp(); }

                const account = accountForSymbol(index, 'target', { log: true });
                assert.strictEqual(account.groundTotal, fixture.expectedTotal);
                assert.ok(account.nonCall.unclassifiedText >= fixture.minUnclassified,
                    `${lang}: comment/string lines land in unclassifiedText: ${JSON.stringify(account.nonCall)}`);
                assert.ok(account.confirmed + account.unverified >= 1,
                    `${lang}: the call line must be visible (confirmed or unverified): ${JSON.stringify(account)}`);
            } finally { rm(dir); }
        });
    });
});

describe('conservation: parse-failure surfacing', () => {
    it('failed-file lines are counted as unparsed, never silently missing', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'ok.js': 'function target() { return 1; }\nfunction c() { return target(); }\nmodule.exports = { target, c };',
        });
        try {
            const index = idx(dir);
            // Deterministic injection: a readable file the index failed to parse.
            // (Real triggers are platform-dependent; the contract is about how
            // failedFiles are SURFACED, not how they got there.)
            const failedPath = path.join(dir, 'legacy', 'old-parser.js');
            fs.mkdirSync(path.dirname(failedPath), { recursive: true });
            fs.writeFileSync(failedPath, 'function uses() { return target(); }\n// target mentioned\n');
            index.failedFiles.add(failedPath);

            index._beginOp();
            try {
                const ground = computeGroundSet(index, 'target');
                assert.strictEqual(ground.unparsed.fileCount, 1);
                assert.strictEqual(ground.unparsed.lines, 2, 'both matching lines in the failed file count');
                assert.deepStrictEqual(ground.unparsed.files, [path.join('legacy', 'old-parser.js')]);
                // 3 lines in ok.js + 2 unparsed
                assert.strictEqual(ground.total, 5);
            } finally { index._endOp(); }

            const account = accountForSymbol(index, 'target');
            assert.strictEqual(account.unparsed.lines, 2);
            assert.strictEqual(account.conserved, true);
        } finally { rm(dir); }
    });

    it('unreadable failed files are listed but stay outside the arithmetic', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'ok.js': 'function target() { return 1; }\nmodule.exports = { target };',
        });
        try {
            const index = idx(dir);
            index.failedFiles.add(path.join(dir, 'gone.js')); // never existed on disk
            index._beginOp();
            try {
                const ground = computeGroundSet(index, 'target');
                assert.deepStrictEqual(ground.unreadableFiles, ['gone.js']);
                assert.strictEqual(ground.unparsed.lines, 0);
                assert.strictEqual(ground.total, 2);
            } finally { index._endOp(); }
        } finally { rm(dir); }
    });
});

describe('conservation: beyond-text claims (alias-resolved callers)', () => {
    it('alias call site is counted in beyondText, not the ground arithmetic', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': 'function parse(input) { return input; }\nmodule.exports = { parse };',
            'app.js': [
                'const { parse } = require("./lib");',
                'const myParse = parse;',
                'function run() { return myParse("x"); }',     // engine resolves via alias; line has NO \\bparse\\b
                'module.exports = { run };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const account = accountForSymbol(index, 'parse');
            assert.strictEqual(account.conserved, true, `invariant holds with alias claims: ${JSON.stringify(account)}`);
            assert.ok(account.beyondText.count >= 1,
                `alias caller line (no word-boundary match) must be counted beyondText: ${JSON.stringify(account)}`);
        } finally { rm(dir); }
    });
});

describe('conservation: baseline invariant across fixture symbols', () => {
    // Lenient mode (Phase 1): arithmetic identity asserted, engine gaps logged.
    // Phase 2 flips allowUnaccounted to false project-wide.
    it('every defined function in a mixed fixture conserves', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'service.js': [
                'const { helper } = require("./util");',
                'function processData(input) {',
                '  // processData is the entry — helper does the work',
                '  return helper(input);',
                '}',
                'class Engine {',
                '  start() { return processData("go"); }',
                '  stop() { return this.start(); }',
                '}',
                'module.exports = { processData, Engine };',
            ].join('\n'),
            'util.js': [
                'function helper(x) { return x; }',
                'function unused() { return "helper unused"; }',
                'module.exports = { helper };',
            ].join('\n'),
            'app.test.js': [
                'const { processData } = require("./service");',
                'test("processData works", () => { processData("x"); });',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            for (const name of ['processData', 'helper', 'start', 'unused']) {
                const account = accountForSymbol(index, name, { log: true });
                assert.strictEqual(account.conserved, true, `"${name}" must conserve`);
                assert.ok(account.groundTotal > 0, `"${name}" must have ground occurrences`);
            }
        } finally { rm(dir); }
    });
});

describe('conservation: drop points carry reasons (Phase 2 engine instrumentation)', () => {
    function engineAccount(index, name, options = {}) {
        index._beginOp();
        try {
            const ctx = index.context(name, options);
            assert.ok(ctx && ctx.meta && ctx.meta.account, `context must carry meta.account for "${name}"`);
            return ctx.meta.account;
        } finally { index._endOp(); }
    }

    it('JS: obj.method() without receiver evidence -> unverified, not invisible', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'svc.js': 'function run(m) { return m.helper(); }\nmodule.exports = { run };',
        });
        try {
            const account = engineAccount(idx(dir), 'helper');
            assert.ok(account.unverified >= 1,
                `m.helper() must surface as unverified: ${JSON.stringify(account)}`);
            assert.strictEqual(account.conserved, true);
        } finally { rm(dir); }
    });

    it('Go: stdlib package call -> excluded external-package', () => {
        const dir = tmp({
            'go.mod': 'module test\n\ngo 1.21',
            'lib.go': 'package main\n\nfunc Println(s string) {}\n',
            'app.go': 'package main\n\nimport "fmt"\n\nfunc run() {\n\tfmt.Println("x")\n}\n',
        });
        try {
            const account = engineAccount(idx(dir), 'Println');
            assert.ok(account.excluded.byReason['external-package'],
                `fmt.Println must be excluded as external-package: ${JSON.stringify(account.excluded)}`);
            assert.strictEqual(account.conserved, true);
        } finally { rm(dir); }
    });

    it('Go: method call vs standalone target -> excluded method-kind-mismatch', () => {
        const dir = tmp({
            'go.mod': 'module test\n\ngo 1.21',
            'lib.go': 'package main\n\nfunc Errorf(s string) {}\n',
            'app.go': [
                'package main',
                '',
                'type T struct{}',
                '',
                'func (t *T) Errorf(s string) {}',
                '',
                'func run(t *T) {',
                '\tt.Errorf("x")',
                '}',
            ].join('\n') + '\n',
        });
        try {
            // Scope the query to the standalone definition in lib.go
            const account = engineAccount(idx(dir), 'Errorf', { file: 'lib.go' });
            assert.strictEqual(account.conserved, true);
            // t.Errorf() targets the method, not the standalone — it must land in
            // a non-confirmed bucket (excluded with a kind/definition reason).
            assert.ok(account.excluded.total >= 1,
                `t.Errorf() must be excluded with a reason: ${JSON.stringify(account)}`);
        } finally { rm(dir); }
    });

    it('JS: call bound to a different same-name definition -> excluded other-definition', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function process(x) { return x; }\nmodule.exports = { process };',
            'b.js': 'function process(y) { return y * 2; }\nfunction useB() { return process(1); }\nmodule.exports = { useB };',
        });
        try {
            // Scope the query to a.js's definition — b.js's call binds to b.js's own process
            const account = engineAccount(idx(dir), 'process', { file: 'a.js' });
            assert.strictEqual(account.conserved, true);
            assert.ok(account.excluded.total >= 1,
                `b.js process(1) must be excluded (bound to other definition): ${JSON.stringify(account)}`);
            assert.strictEqual(account.confirmed, 0,
                `no confirmed callers for a.js process: ${JSON.stringify(account)}`);
        } finally { rm(dir); }
    });

    it('engine account equals manual ground arithmetic on the same fixture', () => {
        const dir = tmp(CONSERVATION_FIXTURES.javascript.files);
        try {
            const index = idx(dir);
            const account = engineAccount(index, 'target');
            index._beginOp();
            try {
                const ground = computeGroundSet(index, 'target');
                assert.strictEqual(account.groundTotal, ground.total,
                    'engine account ground total must equal raw computeGroundSet');
            } finally { index._endOp(); }
        } finally { rm(dir); }
    });
});

describe('conservation: tree/diffImpact/verify/plan/context-callees/smart run the contract', () => {
    it('blast/reverseTrace carry root account + tree account; trace down carries callee rollup', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': 'function inner() { return 1; }\nfunction outer() { return inner(); }\nmodule.exports = { inner, outer };',
            'app.js': 'const { outer } = require("./lib");\nfunction main() { return outer(); }\nmodule.exports = { main };',
        });
        try {
            const index = idx(dir);
            const { execute } = require('../core/execute');
            for (const cmd of ['blast', 'reverseTrace']) {
                const r = execute(index, cmd, { name: 'inner' });
                assert.ok(r.ok, `${cmd} should succeed`);
                assert.ok(r.result.account, `${cmd} must carry the root text-ground account`);
                assert.ok(r.result.account.conserved, `${cmd} root account must conserve`);
                assert.ok(r.result.treeAccount, `${cmd} must carry the tree account`);
                assert.ok(Array.isArray(r.result.unverifiedFrontier), `${cmd} must carry the frontier array`);
            }
            const t = execute(index, 'trace', { name: 'outer' });
            assert.ok(t.ok, 'trace should succeed');
            assert.ok(t.result.treeAccount, 'trace down must carry the callee rollup');
            assert.ok(t.result.treeAccount.callSites, 'callee rollup has callSites buckets');
            const cs = t.result.treeAccount.callSites;
            assert.strictEqual(cs.total,
                cs.confirmed + cs.unverified + cs.external + cs.excluded + cs.filtered,
                'callee rollup must conserve');
        } finally { rm(dir); }
    });

    it('diffImpact runs the contract — per-symbol account + tiered callers (v4)', () => {
        const { execFileSync } = require('child_process');
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': [
                'class Store {',
                '  save(x) { return x; }',
                '}',
                'function save(x) { return x + 1; }',
                'module.exports = { Store, save };',
            ].join('\n'),
            'app.js': [
                'const { save } = require("./lib");',
                '// save is called at startup',
                'function main() { return save(5); }',
                'function other(db) { return db.save(1); }',
            ].join('\n'),
        });
        try {
            execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
            execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
            execFileSync('git', ['-c', 'user.email=t@t.c', '-c', 'user.name=T', 'commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
            // Modify the standalone save()
            fs.writeFileSync(path.join(dir, 'lib.js'), [
                'class Store {',
                '  save(x) { return x; }',
                '}',
                'function save(x) { return x + 2; }',
                'module.exports = { Store, save };',
            ].join('\n'));

            const index = idx(dir);
            const { execute } = require('../core/execute');
            const r = execute(index, 'diffImpact', { base: 'HEAD' });
            assert.ok(r.ok, 'diffImpact should succeed');
            const fn = (r.result.functions || []).find(f => f.name === 'save');
            assert.ok(fn, 'modified save should be reported');

            // Confirmed tier: the bound direct call
            assert.ok(fn.callers.some(c => c.callerName === 'main' && c.tier === 'confirmed'),
                'main() direct call must be a confirmed caller');
            // Unverified tier: evidence-less method call is VISIBLE with a reason,
            // never silently dropped (pre-v4 diffImpact dropped it)
            assert.ok(fn.unverifiedCallers.some(u => u.callerName === 'other' && u.reason),
                `db.save(1) must appear in unverifiedCallers with a reason: ${JSON.stringify(fn.unverifiedCallers)}`);

            // Per-symbol conservation account
            assert.ok(fn.account, 'per-symbol account must be present');
            assert.ok(fn.account.conserved, `account must conserve: ${JSON.stringify(fn.account)}`);
            const a = fn.account;
            assert.strictEqual(
                a.confirmed + a.unverified + a.nonCall.total + a.excluded.total + a.unparsed.lines + a.unaccounted,
                a.groundTotal, 'buckets must sum to groundTotal');

            // Summary carries both bands
            assert.strictEqual(r.result.summary.totalCallSites, 1, 'confirmed count');
            assert.strictEqual(r.result.summary.unverifiedCallSites, 1, 'unverified count');
        } finally { rm(dir); }
    });

    it('verify/plan run the contract — account + visible unverified band (v4)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': [
                'class Store {',
                '  save(x) { return x; }',
                '}',
                'function save(x) { return x + 1; }',
                'module.exports = { Store, save };',
            ].join('\n'),
            'app.js': [
                'const { save } = require("./lib");',
                'function main() { return save(5); }',
                'function other(db) { return db.save(1, 2); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { execute } = require('../core/execute');

            const v = execute(index, 'verify', { name: 'save', file: 'lib.js', line: 4 });
            assert.ok(v.ok, 'verify should succeed');
            // Confirmed band arg-checked as before
            assert.strictEqual(v.result.totalCalls, 1, 'confirmed band: the bound direct call');
            assert.strictEqual(v.result.valid, 1);
            // Unverified band visible with reason — pre-v4 verify silently dropped it
            assert.strictEqual(v.result.unverifiedCount, 1, 'db.save must be visible unverified');
            assert.ok(v.result.unverifiedSites[0].reason, 'unverified site carries a reason');
            // Conservation account
            assert.ok(v.result.account, 'verify must carry the account');
            assert.ok(v.result.account.conserved, `verify account must conserve: ${JSON.stringify(v.result.account)}`);

            // BUG-BW lockstep under the contract: plan's confirmed sites === verify's
            const p = execute(index, 'plan', { name: 'save', file: 'lib.js', line: 4, addParam: 'opt' });
            assert.ok(p.ok, 'plan should succeed');
            assert.strictEqual(p.result.totalChanges, v.result.totalCalls,
                'plan totalChanges must equal verify totalCalls');
            assert.strictEqual(p.result.unverifiedCount, v.result.unverifiedCount,
                'plan and verify agree on the unverified band');
            assert.ok(p.result.account && p.result.account.conserved, 'plan account must conserve');
        } finally { rm(dir); }
    });

    it('advisory commands self-label (v4 two-tier surface)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': 'function helperFn(x) { return x; }\nfunction helperUtil() { return helperFn(2); }\nmodule.exports = { helperFn, helperUtil };',
            'app.js': 'const { helperFn } = require("./lib");\nfunction main() { return helperFn(1); }',
        });
        try {
            const index = idx(dir);
            assert.strictEqual(index.related('helperFn').advisory, 'similarity-heuristics',
                'related must self-label advisory');
            assert.strictEqual(index.example('helperFn').advisory, 'scored-selection',
                'example must self-label advisory');
            assert.strictEqual(index.parseStackTrace('at main (app.js:2:20)').advisory,
                'best-effort-frame-matching', 'stacktrace must self-label advisory');
        } finally { rm(dir); }
    });

    it('context/smart callee sides run the contract — calleeAccount + visible unverified callees (v4)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': 'function inner() { return 1; }\nmodule.exports = { inner };',
            'app.js': [
                'const { inner } = require("./lib");',
                'function outer(db) {',
                '  db.mystery(1);',       // uncertain receiver — unresolved callee
                '  return inner();',       // confirmed callee
                '}',
                'module.exports = { outer };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { execute } = require('../core/execute');

            const c = execute(index, 'context', { name: 'outer' });
            assert.ok(c.ok, 'context should succeed');
            assert.ok(c.result.callees.some(x => x.name === 'inner'), 'inner is a confirmed callee');
            const acct = c.result.meta.calleeAccount;
            assert.ok(acct, 'context must carry the calleeAccount');
            assert.strictEqual(acct.totalSites,
                acct.confirmed + acct.unverified + acct.external.count + acct.excluded.total + acct.filtered.count,
                `callee account must conserve: ${JSON.stringify(acct)}`);
            assert.ok(Array.isArray(c.result.unverifiedCallees), 'unverifiedCallees band present');

            const s = execute(index, 'smart', { name: 'outer' });
            assert.ok(s.ok, 'smart should succeed');
            assert.ok(s.result.meta.calleeAccount, 'smart must carry the calleeAccount');
            assert.ok(Array.isArray(s.result.unverifiedCallees), 'smart unverifiedCallees band present');
            assert.strictEqual(s.result.meta.calleeAccount.conserved, true, 'smart callee account conserves');
        } finally { rm(dir); }
    });
});
