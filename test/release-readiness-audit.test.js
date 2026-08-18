'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { tmp, rm, idx } = require('./helpers');
const output = require('../core/output');
const { execute } = require('../core/execute');
const { getLanguageAdapter, getParser } = require('../languages');
const { ProjectIndex } = require('../core/project');
const { applyOutputBudget } = require('../core/output-budget');
const { collectRollupResults } = require('../eval/run-deadcode-eval');

describe('UCN v5 release-readiness audit regressions', () => {
    it('release follow-up: deadcode rollups merge every same-day repository row', () => {
        const date = '2026-08-11';
        const files = {};
        for (let i = 0; i < 10; i++) {
            const repo = `repo-${i}`;
            files[`deadcode-eval-${repo}-oracle-${date}.json`] = JSON.stringify({
                repo, oracle: 'oracle', arms: [],
            });
        }
        const dir = tmp(files);
        try {
            const rows = collectRollupResults(dir, date, [{
                repo: 'repo-3', oracle: 'new-oracle', arms: [],
            }]);
            assert.equal(rows.length, 10);
            assert.deepEqual(rows.map(row => row.repo),
                Array.from({ length: 10 }, (_, i) => `repo-${i}`).sort());
            assert.equal(rows.find(row => row.repo === 'repo-3').oracle,
                'new-oracle');
        } finally { rm(dir); }
    });

    it('R2-001: plan follows file-qualified inheritance identity', () => {
        const dir = tmp({
            'package.json': '{"name":"plan2"}',
            'pkg1/handler.js': [
                'class Handler {',
                '  process(x) { return x + 1; }',
                '}',
                'module.exports = { Handler };',
            ].join('\n'),
            'pkg1/main.js': "const { Handler } = require('./handler');\nmodule.exports = () => new Handler().process(1);",
            'pkg2/handler.js': [
                'class Handler { handleIt() { return 0; } }',
                'class Special extends Handler {',
                '  process(y) { return y * 3; }',
                '}',
                'module.exports = { Handler, Special };',
            ].join('\n'),
            'pkg2/main.js': "const { Special } = require('./handler');\nmodule.exports = () => new Special().process(9);",
        });
        try {
            const result = idx(dir).plan('process', {
                renameTo: 'handle', file: 'pkg1/handler.js',
            });
            assert.ok(result.changes.some(c => c.file === 'pkg1/handler.js'));
            assert.ok(result.changes.some(c => c.file === 'pkg1/main.js'));
            assert.ok(!result.changes.some(c => c.file.startsWith('pkg2/')),
                JSON.stringify(result.changes, null, 2));
        } finally { rm(dir); }
    });

    it('R2-002: plan rewrites only positively-owned export surfaces', () => {
        const dir = tmp({
            'package.json': '{"name":"plan4"}',
            'lib.js': 'function helper(a) { return a + 1; }\nmodule.exports = { helper };',
            'widgets.js': "const { helper } = require('./lib');\nfunction helper2(a) { return helper(a) * 2; }\nmodule.exports = { helper2 };",
            'shapes.js': "const { helper2 } = require('./widgets');\nfunction helper(z) { return helper2(z) - 1; }\nmodule.exports = { helper };",
            'app.js': "const s = require('./shapes');\nconsole.log(s.helper(2));",
        });
        try {
            const result = idx(dir).plan('helper', {
                renameTo: 'assist', file: 'lib.js',
            });
            assert.ok(result.changes.some(c => c.file === 'lib.js'));
            assert.ok(result.changes.some(c => c.file === 'widgets.js'));
            assert.ok(!result.changes.some(c => c.file === 'shapes.js' || c.file === 'app.js'),
                JSON.stringify(result.changes, null, 2));
        } finally { rm(dir); }
    });

    it('R2-005/007: module-scope callers render and prevent false root claims', () => {
        const dir = tmp({
            'lib.py': 'def make_error(msg):\n    return RuntimeError(msg)\n',
            'use.py': 'from lib import make_error\nERR_THING = make_error("thing")\n',
        });
        try {
            const index = idx(dir);
            const blast = index.blast('make_error', { depth: 3 });
            assert.equal(blast.treeAccount.confirmedEdges, 1);
            assert.equal(blast.tree.children.length, 1);
            assert.equal(blast.tree.children[0].name, '(module/anonymous scope)');
            assert.doesNotMatch(output.formatBlast(blast), /No callers found|root\/entry point/);

            const reverse = index.reverseTrace('make_error', { depth: 5 });
            assert.equal(reverse.tree.entryPoint, undefined);
            assert.equal(reverse.tree.children.length, 1);
            assert.doesNotMatch(output.formatReverseTrace(reverse),
                /make_error ★ entry point|No callers found — this function is itself an entry point/);
        } finally { rm(dir); }
    });

    it('R2-006: sibling overload calls are not self-recursion', () => {
        const dir = tmp({
            'Snap.cs': [
                'namespace Demo {',
                'public class Snap {',
                '  public string Render() {',
                '    return Render("default", 1);',
                '  }',
                '  private static string Render(string mode, int depth) {',
                '    return mode + depth;',
                '  }',
                '}',
                '}',
            ].join('\n'),
        });
        try {
            const result = idx(dir).deadcode();
            assert.ok(!result.some(c => c.name === 'Render'), JSON.stringify(result));
        } finally { rm(dir); }
    });

    it('R2-008/025: explicit C# interface implementations are compiler contracts', () => {
        const dir = tmp({
            'Demo.cs': [
                'using System;',
                'namespace Demo {',
                'internal sealed class Resource : IDisposable {',
                '  void IDisposable.Dispose() { Console.WriteLine("closed"); }',
                '}',
                'public static class Program {',
                '  public static void Main() { using (var r = (IDisposable)new Resource()) { } }',
                '}',
                '}',
            ].join('\n'),
        });
        try {
            const result = idx(dir).deadcode();
            assert.ok(!result.some(c => c.name === 'Dispose'), JSON.stringify(result));
            assert.ok(result.excludedExternalContract >= 1);
        } finally { rm(dir); }
    });

    it('R2-009: the deadcode release gate wires C, C++, and C# oracles', () => {
        const source = fs.readFileSync(path.join(__dirname, '../eval/run-deadcode-eval.js'), 'utf8');
        assert.match(source, /roslynOracle/);
        assert.match(source, /clangdOracle/);
        assert.match(source, /unsupportedRepos/);
        assert.match(source, /arms\.every\(\(\{ claims \}\) => claims\.length === 0\)/,
            'an empty claim set must not cold-start an external language server');
        assert.match(source, /oracle not started: empty claim set/);
        assert.match(source, /repo\.oracleExclude\.map/,
            'deadcode must index the same explicit universe as its oracle');
        assert.match(source, /oracle\.prepare\(target, \{ repo \}\)/);

        const { REPOS } = require('../eval/lib/repos');
        const cjson = REPOS.find(repo => repo.name === 'cjson');
        assert.ok(cjson.oracleExclude.includes('tests/unity'),
            'the cJSON row must not sample its vendored Unity framework');

        const rustOracle = fs.readFileSync(
            path.join(__dirname, '../eval/oracles/rust-analyzer-oracle.js'), 'utf8');
        assert.match(rustOracle, /UCN_EVAL_RUST_QUIESCENT_TIMEOUT_MS/,
            'the compiler readiness bound remains explicitly configurable');
        assert.match(rustOracle, /configuredQuiescentTimeout : 900000/,
            'the default readiness wait remains bounded at fifteen minutes');
        assert.match(rustOracle, /cachePriming: \{ enable: false \}/,
            'the batch oracle must not block semantic readiness on cache warming');
        assert.match(rustOracle, /didChangeWatchedFiles: \{ dynamicRegistration: true \}/);
        assert.match(rustOracle, /files: \{ watcher: 'client' \}/,
            'immutable eval clones must not depend on a platform filesystem watcher');
        assert.match(rustOracle, /helperChild\.kill\(\)/);
        assert.match(rustOracle, /lsp\?\.kill\(\)/);
    });

    it('release feedback: C internal linkage cannot steal a cross-file callee', () => {
        const dir = tmp({
            'tests/common.h': [
                '#pragma once',
                'char *read_file(const char *path) { return (char *)path; }',
            ].join('\n'),
            'tests/use.c': [
                '#include "common.h"',
                'char *run(void) { return read_file("fixture"); }',
            ].join('\n'),
            'fuzzing/afl.c': [
                'static char *read_file(const char *path) { return (char *)path; }',
                'char *fuzz(void) { return read_file("seed"); }',
            ].join('\n'),
            'whitebox/private.c': [
                'static int hidden_helper(void) { return 7; }',
            ].join('\n'),
            'whitebox/private_test.c': [
                '#include "private.c"',
                'int exercise_hidden(void) { return hidden_helper(); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const run = index.find('run', { skipCounts: true })[0];
            const runCallees = index.findCallees(run, { collectAccount: true });
            const read = runCallees.find(callee => callee.name === 'read_file');
            assert.equal(read?.relativePath, 'tests/common.h');

            const fuzz = index.find('fuzz', { skipCounts: true })[0];
            const fuzzCallees = index.findCallees(fuzz, { collectAccount: true });
            assert.equal(
                fuzzCallees.find(callee => callee.name === 'read_file')?.relativePath,
                'fuzzing/afl.c');

            const exercise = index.find('exercise_hidden', { skipCounts: true })[0];
            const includedCallees = index.findCallees(exercise, {
                collectAccount: true,
            });
            assert.equal(includedCallees.find(callee =>
                callee.name === 'hidden_helper')?.relativePath,
            'whitebox/private.c');
        } finally { rm(dir); }
    });

    it('release feedback: C++ scoped aliases and auto-return chains preserve type identity', () => {
        const dir = tmp({
            'include/types.h': [
                '#pragma once',
                'struct Wrong { int high() const { return 1; } };',
                'struct Right { int high() const { return 2; } };',
                'struct FloatBox {',
                '  using entry_type = Wrong;',
                '  static int read(const entry_type& value) { return value.high(); }',
                '};',
                'struct DoubleBox {',
                '  using entry_type = Right;',
                '  static int read(const entry_type& value) { return value.high(); }',
                '};',
                'struct Specs { bool alt() const { return true; } };',
                'inline auto parse_specs() { auto specs = Specs(); return specs; }',
            ].join('\n'),
            'test/types-test.cpp': [
                '#include "../include/types.h"',
                'int exercise() { return parse_specs().alt() ? DoubleBox::read(Right()) : 0; }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const rightHigh = index.find('high', {
                file: 'include/types.h', className: 'Right', skipCounts: true,
            })[0];
            const highContext = index.context('high', {
                file: rightHigh.relativePath,
                line: rightHigh.startLine,
                includeTests: true,
            });
            assert.ok(highContext.callers.some(caller => caller.line === 10),
                JSON.stringify(highContext, null, 2));
            assert.ok(!highContext.callers.some(caller => caller.line === 6));

            const alt = index.find('alt', {
                file: 'include/types.h', className: 'Specs', skipCounts: true,
            })[0];
            const altContext = index.context('alt', {
                file: alt.relativePath,
                line: alt.startLine,
                includeTests: true,
            });
            assert.ok(altContext.callers.some(caller =>
                caller.relativePath === 'test/types-test.cpp' && caller.line === 2),
            JSON.stringify(altContext, null, 2));
            assert.ok(index.tests('alt', {
                file: alt.relativePath, line: alt.startLine,
            }).some(test => test.file === 'test/types-test.cpp'));
        } finally { rm(dir); }
    });

    it('R2-010: renamed-import aliases require no call-site edit', () => {
        const dir = tmp({
            'core.py': 'def transform(x):\n    return x * 2\n',
            'aliased.py': 'from core import transform as xf\ndef run_alias():\n    return xf(2)\n',
        });
        try {
            const result = idx(dir).plan('transform', { renameTo: 'convert' });
            const aliasChanges = result.changes.filter(c => c.file === 'aliased.py');
            assert.deepEqual(aliasChanges.map(c => c.editKind), ['import']);
            assert.match(aliasChanges[0].newExpression, /convert as xf/);
        } finally { rm(dir); }
    });

    it('R2-011/012: hot ranking refines only viable leaders and survives cache provenance', () => {
        const definitions = [];
        const calls = [];
        for (let i = 0; i < 180; i++) {
            definitions.push(`function f${i}() { return ${i}; }`);
            calls.push(`f${i}();`);
        }
        for (let i = 0; i < 60; i++) calls.push('f0();');
        const dir = tmp({
            'package.json': '{}',
            'lib.js': `${definitions.join('\n')}\nmodule.exports = { ${definitions.map((_, i) => `f${i}`).join(', ')} };`,
            'main.js': `const lib = require('./lib');\n${calls.join('\n')}`.replace(/\bf(\d+)\(\)/g, 'lib.f$1()'),
        });
        try {
            const built = idx(dir);
            const fresh = built.getStats({ hot: true, top: 1 });
            assert.equal(fresh.hot.items[0].name, 'f0');
            assert.equal(fresh.hot.items[0].callCount, 61);
            assert.ok(fresh.hot.refined <= 2, JSON.stringify(fresh.hot));
            built.saveCache();

            const loaded = new ProjectIndex(dir);
            assert.equal(loaded.loadCache(), true);
            const warm = loaded.getStats({ hot: true, top: 1 });
            assert.deepEqual(warm.hot, fresh.hot);
        } finally { rm(dir); }
    });

    it('R2-013/026: C++ destructors are invisible runtime invocations, not dead claims', () => {
        const dir = tmp({
            'buffer.cpp': [
                '#include <cstdlib>',
                'class Buffer {',
                '  int *data_;',
                'public:',
                '  Buffer() { data_ = (int*)malloc(16); }',
                '  ~Buffer() { free(data_); }',
                '  void genuinely_dead() {}',
                '};',
            ].join('\n'),
        });
        try {
            const result = idx(dir).deadcode({ includeExported: true });
            assert.ok(!result.some(c => c.name === '~Buffer'), JSON.stringify(result));
            assert.ok(result.some(c => c.name === 'genuinely_dead'));
        } finally { rm(dir); }
    });

    it('R2-014: nested gitignore rules exclude package build output', () => {
        const dir = tmp({
            'package.json': '{"name":"mono","private":true}',
            '.gitignore': 'node_modules\n',
            'packages/a/.gitignore': 'dist/\n',
            'packages/a/src/index.js': 'function computeTotal(xs) { return xs.length; }\nmodule.exports = { computeTotal };',
            'packages/a/dist/index.js': 'function computeTotal(xs) { return xs.length; }\nmodule.exports = { computeTotal };',
        });
        try {
            const matches = idx(dir).find('computeTotal', { skipCounts: true });
            assert.deepEqual(matches.map(match => match.relativePath), ['packages/a/src/index.js']);
        } finally { rm(dir); }
    });

    it('release feedback: built-in artifact ignores are not reported as config gaps', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname="ignore-contract"\nversion="0.1.0"\n',
            'src/lib.rs': 'pub fn keep() -> i32 { 1 }\n',
            'src/use.rs': 'use crate::keep;\npub fn run() -> i32 { keep() }\n',
            'target/generated.rs': 'pub fn generated() -> i32 { 2 }\n',
        });
        try {
            const index = idx(dir);
            assert.ok(!index.discoveryIssues.some(issue =>
                issue.reason === 'config-exclude'), JSON.stringify(index.discoveryIssues));
            assert.equal(index.context('keep').meta.account.contract.textComplete, true);
            assert.equal(index.find('generated', { skipCounts: true }).length, 0);
        } finally { rm(dir); }
    });

    it('R2-015: module-local exports shadow transitive same-name dependencies', () => {
        const dir = tmp({
            'package.json': '{}',
            'lib.js': 'function helper(a) { return a + 1; }\nfunction other(a) { return a; }\nmodule.exports = { helper, other };',
            'widgets.js': "const { other } = require('./lib');\nfunction helper(z) { return other(z) - 1; }\nmodule.exports = { helper };",
            'app.js': "const w = require('./widgets');\nconsole.log(w.helper(2));",
        });
        try {
            const context = idx(dir).context('helper', { file: 'lib.js' });
            assert.equal(context.callers.length, 0);
            assert.equal(context.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('R2-016: conditional recovery conserves macro and state definitions', () => {
        const dir = tmp({
            'branches.c': [
                '#ifdef MODE',
                '#define BRANCH_A 1',
                'int state_a;',
                '#else',
                '#define BRANCH_B 2',
                'int state_b;',
                '#endif',
                'void use(int x) {',
                '#ifdef FEATURE',
                '  if (x) {',
                '#endif',
                '    state_a = x;',
                '#ifdef FEATURE',
                '  }',
                '#endif',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            for (const name of ['BRANCH_A', 'BRANCH_B', 'state_a', 'state_b']) {
                assert.ok(index.find(name, { skipCounts: true }).length >= 1, name);
            }
        } finally { rm(dir); }
    });

    it('R2-017/018: global C++ qualification is deterministic and never self-dispatch', () => {
        const adapter = getLanguageAdapter('cpp');
        const parser = getParser('cpp');
        const source = [
            'namespace app {',
            'class Conn {',
            '  int fd_;',
            'public:',
            '  void close() { ::close(fd_); }',
            '  ~Conn() { close(); }',
            '};',
            '}',
        ].join('\n');
        const shape = () => adapter.findCallsInCode(source, parser)
            .find(c => c.name === 'close' && c.line === 5);
        const first = shape();
        for (let i = 0; i < 12; i++) {
            adapter.findCallsInCode(`#ifdef F${i}\nint a${i};\n#else\nint b${i};\n#endif`, parser);
        }
        const later = shape();
        assert.equal(first.globalQualified, true);
        assert.equal(first.isMethod, false);
        assert.deepEqual(later, first);

        const dir = tmp({ 'target.cpp': source });
        try {
            const context = idx(dir).context('close', { line: 5, file: 'target.cpp' });
            assert.deepEqual(context.callers.map(c => c.line), [6]);
            const excluded = Object.values(context.meta.account.excluded.byReason)
                .flatMap(reason => reason.sample || []);
            assert.ok(excluded.some(site => site.line === 5));
        } finally { rm(dir); }
    });

    it('R2-019: Python stubs are indexed and conserved', () => {
        const dir = tmp({
            'lib.py': 'def helper(x):\n    return x\n',
            'stubs.pyi': 'def helper(x: int) -> int: ...\n',
            'app.py': 'from lib import helper\ndef main():\n    return helper(1)\n',
        });
        try {
            const index = idx(dir);
            assert.ok([...index.files.values()].some(fe => fe.relativePath === 'stubs.pyi'));
            assert.equal(index.find('helper', { skipCounts: true }).length, 2);
            assert.equal(index.context('helper', { file: 'lib.py' }).meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('R2-020/023: C++ declarations and definitions share callers and header defaults', () => {
        const dir = tmp({
            'lib.h': [
                '#pragma once',
                'namespace app { class Logger {',
                'public: virtual void sink(int value = 0);',
                '}; }',
            ].join('\n'),
            'lib.cpp': [
                '#include "lib.h"',
                'namespace app {',
                'void Logger::sink(int value) { if (value) sink(); }',
                '}',
                'void use(app::Logger &logger) { logger.sink(); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const defs = index.find('sink', { skipCounts: true });
            assert.equal(defs.length, 2);
            const partitions = defs.map(definition => index.context('sink', {
                file: definition.relativePath, line: definition.startLine,
            }).callers.map(call => `${call.relativePath}:${call.line}`));
            assert.deepEqual(partitions[0], partitions[1]);
            assert.deepEqual(index.verify('sink', { file: 'lib.cpp' }).expectedArgs,
                { min: 0, max: 1 });
            assert.equal(index.verify('sink', { file: 'lib.cpp' }).mismatches, 0);
        } finally { rm(dir); }
    });

    it('R2-021: macro control-flow statements cannot truncate a C++ function', () => {
        const dir = tmp({
            'macro.cpp': [
                '#define MY_TRY try',
                '#define MY_CATCH(x) catch (const int &) { }',
                'void inner(int x);',
                'void tail(int x);',
                'void handle(int msg) {',
                '  MY_TRY { inner(msg); }',
                '  MY_CATCH(msg)',
                '  tail(msg);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const definition = index.find('handle', { skipCounts: true })[0];
            assert.equal(definition.endLine, 9);
            const callees = new Set(index.findCallees(definition).map(callee => callee.name));
            assert.ok(callees.has('inner'));
            assert.ok(callees.has('tail'));
            const tail = index.context('tail', { file: 'macro.cpp' });
            assert.equal(tail.callers[0].callerName, 'handle');
        } finally { rm(dir); }
    });

    it('R2-022: macro-qualified brace-initialized C++ constructors retain their body', () => {
        const dir = tmp({
            'a.h': [
                'struct Base { int v; };',
                'struct Derived : Base {',
                '  Derived(const Base &orig);',
                '  void step_one();',
                '  void step_two();',
                '};',
            ].join('\n'),
            'a.cpp': [
                '#include "a.h"',
                '#define MY_INLINE inline',
                'MY_INLINE Derived::Derived(const Base &orig)',
                '    : Base{orig} {',
                '  step_one();',
                '  step_two();',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const definition = index.find('Derived', { skipCounts: true })
                .find(match => match.relativePath === 'a.cpp');
            assert.equal(definition.endLine, 7);
            assert.equal(definition.isSignature, undefined);
            assert.deepEqual(new Set(index.findCallees(definition).map(callee => callee.name)),
                new Set(['step_one', 'step_two']));
        } finally { rm(dir); }
    });

    it('R2-024: Java concatenated arguments never select an incompatible varargs overload', () => {
        const dir = tmp({
            'Utils.java': [
                'class Utils {',
                '  static RuntimeException methodError(Method m, String s, Object... args) { return null; }',
                '  static RuntimeException methodError(Method m, Throwable t, String s, Object... args) { return null; }',
                '  static void parse(Method method, Object queryParams) {',
                '    throw methodError(',
                '      method,',
                '      "URL query " + "must not have block",',
                '      queryParams);',
                '  }',
                '}',
                'class Method {}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const short = index.context('methodError', { file: 'Utils.java', line: 2 });
            const long = index.context('methodError', { file: 'Utils.java', line: 3 });
            assert.deepEqual(short.callers.map(call => call.line), [5]);
            assert.equal(long.callers.some(call => call.line === 5), false);
        } finally { rm(dir); }
    });

    it('R2-027: large high-bytes-per-line bundles are excluded from deadcode and hot', () => {
        const huge = 'function zz(){return 1;}'.repeat(5000);
        const lines = [huge, ...Array.from({ length: 55 }, (_, i) => `var a${i}=1;`)];
        const dir = tmp({ 'package.json': '{}', 'vendor.js': lines.join('\n') });
        try {
            const index = idx(dir);
            assert.equal([...index.files.values()][0].isBundled, true);
            assert.ok(!index.deadcode({ includeExported: true }).some(c => c.name === 'zz'));
            const stats = execute(index, 'stats', { hot: true }).result;
            assert.ok(!stats.hot.items.some(item => item.name === 'zz'));
        } finally { rm(dir); }
    });

    it('R2-028: ordinary array indexing is not computed dispatch; invoked selections are', () => {
        const dir = tmp({
            'package.json': '{}',
            'a.js': 'function sum(xs) { let t=0; for(let i=0;i<xs.length;i++) t += xs[i]; return t; }\nmodule.exports={sum};',
            'b.js': 'const handlers={open(){}}; function run(k){ const h=handlers[k]; h(); }',
        });
        try {
            const result = execute(idx(dir), 'doctor', { deep: true }).result;
            assert.equal(result.blindSpots.computedDispatch.count, 1);
            assert.deepEqual(result.blindSpots.computedDispatch.files, ['b.js']);
        } finally { rm(dir); }
    });

    it('R2-029: serde string-path callbacks keep Rust helpers live', () => {
        const dir = tmp({
            'src/lib.rs': [
                '#[derive(Serialize)]',
                'struct Row {',
                '  #[serde(serialize_with = "serialize_big")]',
                '  value: u64,',
                '  #[serde(default = "default_name")]',
                '  name: String,',
                '}',
                'fn serialize_big(v: &u64) -> u64 { *v }',
                'fn default_name() -> String { String::new() }',
                'fn genuinely_dead() -> u32 { 7 }',
            ].join('\n'),
        });
        try {
            const dead = idx(dir).deadcode({ includeExported: true });
            assert.ok(!dead.some(c => ['serialize_big', 'default_name'].includes(c.name)), JSON.stringify(dead));
            assert.ok(dead.some(c => c.name === 'genuinely_dead'));
        } finally { rm(dir); }
    });

    it('R2-030: PyO3 generated runtime surfaces are not dead claims', () => {
        const dir = tmp({
            'src/lib.rs': [
                'struct Url { inner: String }',
                '#[pymethods]',
                'impl Url {',
                '  fn __richcmp__(&self) -> bool { true }',
                '  fn helper_exposed(&self) {}',
                '}',
                '#[pymodule_init]',
                'fn module_init() {}',
                'fn genuinely_dead() {}',
            ].join('\n'),
        });
        try {
            const dead = idx(dir).deadcode({ includeExported: true });
            assert.ok(!dead.some(c => ['__richcmp__', 'helper_exposed', 'module_init'].includes(c.name)), JSON.stringify(dead));
            assert.ok(dead.some(c => c.name === 'genuinely_dead'));
        } finally { rm(dir); }
    });

    it('R2-031: action commands disclose ambiguous symbol selection in text and JSON', () => {
        const dir = tmp({
            'package.json': '{}',
            'a/x.js': 'function handler(req) { return req.a; }\nmodule.exports={handler};',
            'b/x.js': 'function handler(req,res) { return res.send(req.b); }\nmodule.exports={handler};',
            'main.js': "const A=require('./a/x'); const B=require('./b/x');\nA.handler({a:1}); B.handler({b:2},{send(){}});",
            'a/x.test.js': "const {handler}=require('./x'); test('a',()=>handler({a:1}));",
            'b/x.test.js': "const {handler}=require('./x'); test('b',()=>handler({b:2},{send(){}}));",
        });
        try {
            const index = idx(dir);
            const cases = [
                ['impact', execute(index, 'impact', { name: 'handler' })],
                ['check', execute(index, 'check', { name: 'handler' })],
                ['tests', execute(index, 'tests', { name: 'handler' })],
                ['plan', execute(index, 'plan', { name: 'handler', renameTo: 'handle2' })],
            ];
            for (const [command, execution] of cases) {
                assert.equal(execution.ok, true, `${command}: ${execution.error || ''}`);
                assert.equal(execution.result.warnings?.[0]?.type, 'ambiguous', command);
                const text = output.formatPublicText(command, execution.result,
                    { name: 'handler' }, { surface: 'cli' });
                assert.match(text, /Found 2 definitions/, `${command} text`);
                const json = JSON.parse(output.formatPublicJson(command,
                    execution.result, { name: 'handler' }, { surface: 'cli' }));
                assert.equal(json.meta.warnings?.[0]?.type, 'ambiguous', `${command} JSON`);
            }
        } finally { rm(dir); }
    });

    it('R2-033: pinned class projections exclude foreign same-named members', () => {
        const dir = tmp({
            'package.json': '{}',
            'a/model.js': 'class Model { save(){} load(){} }\nmodule.exports={Model};',
            'b/model.js': 'class Model { totallyDifferentMethod(){} }\nmodule.exports={Model};',
        });
        try {
            const context = idx(dir).context('Model', { file: 'a/model.js', line: 1 });
            assert.deepEqual(new Set(context.methods.map(method => method.name)),
                new Set(['save', 'load']));
            assert.ok(context.methods.every(method => method.file === 'a/model.js'));
        } finally { rm(dir); }
    });

    it('R2-032: unverified sites make check status visibly partial', () => {
        const text = output.formatVerify({
            found: true, function: 'f', file: 'a.js', startLine: 1,
            signature: 'f(x)', expectedArgs: { min: 1, max: 1 },
            totalCalls: 1, valid: 1, mismatches: 0, uncertain: 0,
            unverifiedCount: 2, unverifiedSites: [], validDetails: [],
            mismatchDetails: [], uncertainDetails: [], patterns: {},
        });
        assert.match(text, /STATUS: ⚠ .*2 unverified sites not arg-checked/);
        assert.doesNotMatch(text, /✓ All calls valid/);
    });

    it('R2-034: exclude patterns are literal and consistent on entrypoints/endpoints', () => {
        const dir = tmp({
            'go.mod': 'module demo\ngo 1.21\n',
            'main.go': 'package main\nfunc main(){}\n',
            'helper_test.go': 'package main\nfunc TestThing(){}\n',
        });
        try {
            const index = idx(dir);
            const all = execute(index, 'entrypoints', { includeTests: true }).result;
            const dotted = execute(index, 'entrypoints', { includeTests: true, exclude: ['helpe.'] }).result;
            assert.equal(dotted.length, all.length);
            assert.doesNotThrow(() => execute(index, 'entrypoints', { exclude: ['('] }));
        } finally { rm(dir); }
    });

    it('R2-036/037: ordinary regexes work and ambiguous repetition stays bounded', () => {
        const dir = tmp({
            'package.json': '{}',
            'lib.js': 'export async function loadThing() { return 1; }\n' +
                'const nope = "export function hidden() {}";\n' +
                `${'a'.repeat(20000)}!\n`,
        });
        try {
            const index = idx(dir);
            const ordinary = index.search('^\\s*export\\s+(async\\s+)?function', {
                regex: true,
            });
            assert.equal(ordinary.meta.totalMatches, 1);
            const started = performance.now();
            const adversarial = index.search('^(a|a)*$', { regex: true });
            assert.ok(!adversarial.some(file =>
                file.matches.some(match => match.line === 3)));
            assert.ok(performance.now() - started < 1000,
                'linear regex search should not exhibit exponential backtracking');

            const codeOnly = index.search('export\\s+(async\\s+)?function', {
                regex: true, codeOnly: true,
            });
            assert.equal(codeOnly.meta.totalMatches, 1);
        } finally { rm(dir); }
    });

    it('R2-041: git-tracked source overrides a matching gitignore rule', () => {
        const dir = tmp({
            '.gitignore': 'build\n',
            'src/lib.py': 'def target(a):\n    return a + 1\n',
            'src/build/gen.py': 'from ..lib import target\ndef caller():\n    return target(1)\n',
        });
        try {
            execFileSync('git', ['init', '-q', dir]);
            execFileSync('git', ['-C', dir, 'add', '-f', '.gitignore', 'src/lib.py', 'src/build/gen.py']);
            const context = idx(dir).context('target', { file: 'src/lib.py' });
            assert.deepEqual(context.callers.map(call => call.relativePath), ['src/build/gen.py']);
            assert.equal(context.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('R2-038: public JSON bytes are stable across fresh and cached indexes', () => {
        const dir = tmp({
            'package.json': '{}',
            'src/lib.js': 'function helper(a){ return a+1; }\nmodule.exports={helper};',
            'src/app.js': "const {helper}=require('./lib');\nhelper(1);",
        });
        try {
            const cachePath = path.join(dir, 'cache', 'index.json');
            const fresh = idx(dir);
            const freshResult = execute(fresh, 'find', { name: 'helper' }).result;
            const freshJson = output.formatPublicJson('find', freshResult,
                { name: 'helper' }, { surface: 'cli' });
            fresh.saveCache(cachePath);
            const cached = new ProjectIndex(dir);
            assert.equal(cached.loadCache(cachePath), true);
            const cachedResult = execute(cached, 'find', { name: 'helper' }).result;
            const cachedJson = output.formatPublicJson('find', cachedResult,
                { name: 'helper' }, { surface: 'cli' });
            assert.equal(cachedJson, freshJson);
        } finally { rm(dir); }
    });

    it('R2-039: find exposes pinned call candidates with their evidence tiers', () => {
        const dir = tmp({
            'package.json': '{}',
            'a.js': [
                'class Sink { sink_it_(){} }',
                'const s=new Sink();',
                's.sink_it_();',
                'unknown.sink_it_();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const found = execute(index, 'find', { name: 'sink_it_' }).result[0];
            const syntaxCalls = index.usages('sink_it_')
                .filter(usage => usage.usageType === 'call').length;
            assert.equal(found.usageCounts.calls, syntaxCalls);
            assert.equal(found.usageCounts.countKind,
                'target-call-candidates-with-tier-breakdown-excludes-references');
            assert.match(output.formatFindDetailed([found], 'sink_it_'),
                /target call candidate/);
        } finally { rm(dir); }
    });

    it('R2-040: C# nested types resolve enclosing partial-class static members', () => {
        const dir = tmp({
            'A.cs': [
                'namespace Demo {',
                ' public static partial class Mapper {',
                '  private static int GetCacheInfo(string key) => key.Length;',
                '  public static int Local(string k) => GetCacheInfo(k);',
                ' }',
                '}',
            ].join('\n'),
            'C.cs': [
                'namespace Demo {',
                ' public static partial class Mapper {',
                '  public partial class Grid {',
                '   public int Read(string k) => GetCacheInfo(k);',
                '  }',
                ' }',
                '}',
            ].join('\n'),
        });
        try {
            const context = idx(dir).context('GetCacheInfo', { file: 'A.cs', line: 3 });
            assert.ok(context.callers.some(call =>
                call.relativePath === 'C.cs' && call.callerName === 'Read'));
            assert.ok(!context.unverifiedCallers.some(call => call.relativePath === 'C.cs'));
        } finally { rm(dir); }
    });

    it('R2-042/043: decorators and member-assigned handlers are hidden from default deadcode', () => {
        const dir = tmp({
            'model.py': [
                'def field_validator(*args, **kwargs):',
                '    return lambda fn: fn',
                'class Model:',
                '    @field_validator("x")',
                '    def validate_x(self, value):',
                '        return value',
                'def really_dead():',
                '    return 1',
            ].join('\n'),
            'app.js': [
                'const worker = new Worker("w.js");',
                'worker.onmessage = function onmessage(ev) { console.log(ev.data); };',
                'const socket = new WebSocket("ws://x");',
                'socket.onopen = ({data}) => { console.log(data); };',
                'function deadJs() {}',
            ].join('\n'),
        });
        try {
            const dead = idx(dir).deadcode({ includeExported: true });
            assert.ok(!dead.some(item =>
                ['validate_x', 'onmessage', 'onopen'].includes(item.name)),
            JSON.stringify(dead));
            assert.ok(dead.some(item => item.name === 'really_dead'));
            assert.ok(dead.some(item => item.name === 'deadJs'));
            assert.ok(dead.excludedDecorated > 0);
        } finally { rm(dir); }
    });

    it('R2-044: max_chars is a hard transport ceiling including trust metadata', () => {
        const full = Array.from({ length: 100 }, (_, i) =>
            `line ${i} ${'x'.repeat(100)}`).join('\n') +
            '\nACCOUNT: confirmed 1 + unverified 2 = total 3';
        for (const limit of [50, 500, 1000, 3000]) {
            const budgeted = applyOutputBudget(full, {
                command: 'impact', maxChars: limit, surface: 'cli',
            });
            assert.ok(budgeted.text.length <= limit,
                `${budgeted.text.length} exceeded ${limit}`);
        }
        const withContract = applyOutputBudget(full, {
            command: 'impact', maxChars: 500, surface: 'cli',
        });
        assert.match(withContract.text, /ACCOUNT:/);
    });

    it('R2-045/046: unsupported scope and empty section selectors fail honestly', () => {
        const dir = tmp({
            'package.json': '{}',
            'app.js': 'function jsHelper(x){ return x; }',
            'worker.rb': 'class Worker\n  def perform(job)\n  end\nend\n',
        });
        try {
            const index = idx(dir);
            const find = execute(index, 'find', { name: 'Worker' });
            assert.equal(find.ok, true);
            assert.match(find.note, /not a semantic zero/i);
            const show = execute(index, 'show', { name: 'Worker' });
            assert.equal(show.ok, false);
            assert.match(show.error, /unsupported-language|not a semantic zero/i);
            const deps = execute(index, 'deps', { file: 'worker.rb' });
            assert.equal(deps.ok, false);
            assert.match(deps.error, /exists but is not indexed/i);
            for (const sections of [' ', ',', ' , ']) {
                const result = execute(index, 'repo', { sections });
                assert.equal(result.ok, false);
                assert.match(result.error, /No valid repo sections/);
            }
        } finally { rm(dir); }
    });

    it('R2-048: target-less check keeps advisory review non-blocking', () => {
        const dir = tmp({
            'package.json': '{"name":"check-exit"}',
            'src/lib.js': [
                'function greet(name) {',
                "  return 'hi ' + name;",
                '}',
                "function callSites(){ return greet('a'); }",
                'module.exports={greet,callSites};',
            ].join('\n'),
        });
        try {
            execFileSync('git', ['init', '-q', dir]);
            execFileSync('git', ['-C', dir, 'add', '-A']);
            execFileSync('git', ['-C', dir, '-c', 'user.email=a@b',
                '-c', 'user.name=t', 'commit', '-qm', 'init']);
            const file = path.join(dir, 'src/lib.js');
            fs.writeFileSync(file,
                fs.readFileSync(file, 'utf8').replace("'hi '", "'hello '"));
            const text = execFileSync('node', [
                path.join(__dirname, '..', 'cli/index.js'), dir, 'check',
            ], { encoding: 'utf8', timeout: 30000 });
            assert.match(text, /TRUST: REVIEW_REQUIRED/);
        } finally { rm(dir); }
    });

    it('R2-053: Java enum constants keep their invoked constructor live', () => {
        const dir = tmp({
            'Colors.java': [
                'enum Colors {',
                ' RED(1), GREEN(2);',
                ' private final int code;',
                ' Colors(int code) { this.code = code; }',
                '}',
            ].join('\n'),
        });
        try {
            const dead = idx(dir).deadcode({ includeExported: true });
            assert.ok(!dead.some(item =>
                item.name === 'Colors' && item.type === 'constructor'),
            JSON.stringify(dead));
        } finally { rm(dir); }
    });

    it('R2-054/055/056: trust, enum guidance, and source signatures stay truthful', () => {
        const dir = tmp({
            'package.json': '{}',
            'app.js': 'const handlers={open(){}}; function run(k){ handlers[k](); }',
        });
        try {
            const index = idx(dir);
            const orient = execute(index, 'repo', {}).result.summary;
            assert.ok(orient.trust.blindSpots.computedDispatch > 0);
            assert.match(output.formatOrient(orient), /computed dispatch/);
            const badFramework = execute(index, 'endpoints', { framework: 'bogus' });
            assert.equal(badFramework.ok, false);
            assert.match(badFramework.error, /Valid: .*express.*unknown-python/);
            const source = output.formatFn({
                relativePath: 'SqlMapper.cs', startLine: 1, endLine: 2,
                name: 'GetCacheInfo', className: 'SqlMapper', params: '',
                paramsStructured: [], modifiers: ['private', 'static'],
            }, 'private static void GetCacheInfo() {}');
            assert.match(source, /private static SqlMapper\.GetCacheInfo\(\)/);
            assert.doesNotMatch(source, /SqlMapper\.private/);
        } finally { rm(dir); }
    });
});
