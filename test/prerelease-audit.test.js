'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const { execute } = require('../core/execute');
const output = require('../core/output');
const publicOutput = require('../core/output/public');
const { ProjectIndex } = require('../core/project');
const { detectEntrypoints } = require('../core/entrypoints');
const { applyOutputBudget } = require('../core/output-budget');
const { FLAG_APPLICABILITY } = require('../core/registry');
const { saveCache, loadCache, isCacheStale } = require('../core/cache');
const { tmp, rm, idx, runCli, runInteractive, CLI_PATH, McpClient } = require('./helpers');

describe('UCN v5 prerelease audit regressions', () => {
    it('UCN5-001/003: check ignores argument comments and understands annotated Python splats', () => {
        const dir = tmp({
            'package.json': '{}',
            'app.js': [
                'function compute(path, buf, flag) { return [path, buf, flag]; }',
                'compute(',
                '  "/x",',
                '  null, // buffer',
                '  true  // flag',
                ');',
            ].join('\n'),
            'app.py': [
                'def annotated(code: int, *args: object, **kwargs: object) -> int:',
                '    return code',
                'annotated(404)',
                'annotated(404, 1, 2, x=3)',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const js = index.verify('compute');
            assert.equal(js.mismatches, 0);
            assert.equal(js.valid, 1);

            const py = index.verify('annotated');
            assert.equal(py.mismatches, 0);
            assert.equal(py.valid, 2);
            assert.equal(py.expectedArgs.min, 1);
            assert.equal(py.expectedArgs.max, null);
        } finally { rm(dir); }
    });

    it('UCN5-002: C/C++ wrong-arity calls remain visible to check', () => {
        const dir = tmp({
            'lib.h': 'int add(int a, int b);\n',
            'lib.c': '#include "lib.h"\nint add(int a, int b) { return a + b; }\n',
            'app.c': [
                '#include "lib.h"',
                'int run(void) {',
                '  int good = add(1, 2);',
                '  int broken = add(1);',
                '  return good + broken;',
                '}',
            ].join('\n'),
            'same.cpp': [
                'int greet(int a, int b) { return a + b; }',
                'int use() {',
                '  int good = greet(1, 2);',
                '  int broken = greet(1);',
                '  return good + broken;',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            for (const name of ['add', 'greet']) {
                const result = index.verify(name);
                assert.equal(result.valid, 1, name);
                assert.equal(result.mismatches, 1, name);
                assert.equal(result.mismatchDetails[0].actual, 1, name);
            }
        } finally { rm(dir); }
    });

    it('UCN5-038/039/041/042: check parses C# calls, C++ new, and bare arrow params', () => {
        const dir = tmp({
            'package.json': '{}',
            'arrow.js': [
                'const bare = value => value * 2;',
                'bare(1);',
            ].join('\n'),
            'Call.cs': [
                'namespace N;',
                'class Svc { public int Do(int a, int b) => a + b; }',
                'class M { int Bad() { var s = new Svc(); return s.Do(1); } }',
            ].join('\n'),
            'new.cpp': [
                'class Widget { public: Widget(int a, int b) {} };',
                'int run() { Widget *ok = new Widget(1, 2); Widget *bad = new Widget(1); return 0; }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const arrow = index.verify('bare');
            assert.deepEqual(arrow.expectedArgs, { min: 1, max: 1 });
            assert.equal(arrow.mismatches, 0);

            const csharp = index.verify('Do');
            assert.equal(csharp.uncertain, 0);
            assert.equal(csharp.mismatches, 1);
            assert.equal(csharp.mismatchDetails[0].actual, 1);

            const cpp = index.verify('Widget');
            assert.equal(cpp.uncertain, 0);
            assert.equal(cpp.valid, 1);
            assert.equal(cpp.mismatches, 1);
        } finally { rm(dir); }
    });

    it('UCN5-026/027: zero-length code-only regexes always make progress', () => {
        const dir = tmp({
            'package.json': '{}',
            'app.js': 'const value = 1; // comment\n',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'search', {
                term: '.*', regex: true, codeOnly: true,
            });
            assert.equal(result.ok, true);
            assert.ok(Array.isArray(result.result));
        } finally { rm(dir); }
    });

    it('UCN5-029: object-like and function-like macros end on their own line', () => {
        const dir = tmp({
            'macros.c': [
                '#define ALPHA(x) ((x) + 1)',
                '#define BETA(x) ((x) * 2)',
                '#define LIMIT 10',
                '#define NEXT 20',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            for (const name of ['ALPHA', 'BETA', 'LIMIT', 'NEXT']) {
                const def = index.find(name, { skipCounts: true })[0];
                assert.equal(def.endLine, def.startLine, name);
                if (name === 'ALPHA' || name === 'BETA') {
                    const source = execute(index, 'source', {
                        name: `${def.relativePath}:${def.startLine}:${name}`,
                    }).result;
                    assert.equal(source.entries[0].code.split('\n').length, 1, name);
                }
            }
        } finally { rm(dir); }
    });

    it('UCN5-030/157: a usage handle pins the definition without limiting the scan', () => {
        const dir = tmp({
            'package.json': '{}',
            'lib.js': 'export function helper() { return 1; }',
            'app.js': 'import { helper } from "./lib.js";\nhelper();',
        });
        try {
            const index = idx(dir);
            const def = index.find('helper', { skipCounts: true })[0];
            const result = execute(index, 'usages', { name: def.handle || `lib.js:${def.startLine}:helper` });
            assert.equal(result.ok, true);
            assert.ok(result.result.some(usage =>
                usage.relativePath === 'app.js' && usage.usageType === 'call'));
        } finally { rm(dir); }
    });

    it('UCN5-004/016/018/019/025/051/053: discovery never silently drops source', () => {
        const deep = Array.from({ length: 24 }, (_, i) => `level${i}`).join('/');
        const dir = tmp({
            'package.json': '{}',
            'lib.js': 'export function keep() { return 1; }',
            'build/caller.js': 'import { keep } from "../lib.js";\nkeep();',
            [`${deep}/deep.js`]: 'export function deepSymbol() { return 1; }',
        });
        try {
            const index = idx(dir);
            assert.equal(index.find('keep', { skipCounts: true }).length, 1);
            assert.equal(index.find('deepSymbol', { skipCounts: true }).length, 1);
            const shown = execute(index, 'show', { name: 'keep' });
            assert.equal(shown.result.context.meta.account.confirmed, 1);
            assert.equal(shown.result.context.meta.account.contract.textComplete, true);

            const partial = new ProjectIndex(dir);
            partial.build(null, { quiet: true, maxFiles: 1 });
            assert.ok(partial.discoveryIssues.some(issue => issue.reason === 'max-files'));
            const health = execute(partial, 'doctor', {}).result;
            assert.equal(health.trust, 'PARTIAL');
            assert.ok(health.blindSpots.skippedSources.count > 0);
        } finally { rm(dir); }
    });

    it('UCN5-004/104: config exclusions and malformed config degrade trust and accounting', () => {
        const excluded = tmp({
            'package.json': '{}',
            '.ucn.json': JSON.stringify({ exclude: ['consumers/**'] }),
            'lib.js': 'export function keep() { return 1; }',
            'consumers/use.js': 'import { keep } from "../lib.js";\nkeep();',
        });
        const malformed = tmp({
            'package.json': '{}',
            '.ucn.json': '{broken',
            'app.js': 'export function run() { return 1; }',
        });
        try {
            const index = idx(excluded);
            assert.ok(index.discoveryIssues.some(issue => issue.reason === 'config-exclude'));
            const shown = execute(index, 'show', { name: 'keep' }).result;
            const account = shown.context.meta.account;
            assert.equal(account.contract.textComplete, false);
            assert.match(output.formatPublicText('show', shown, { name: 'keep' }),
                /source discovery gap|partial/i);
            assert.equal(execute(index, 'doctor', {}).result.trust, 'PARTIAL');

            const broken = idx(malformed);
            assert.ok(broken.discoveryIssues.some(issue => issue.reason === 'invalid-config'));
            assert.equal(execute(broken, 'doctor', {}).result.trust, 'PARTIAL');
        } finally {
            rm(excluded);
            rm(malformed);
        }
    });

    it('UCN5-052: gitignore globstars and negations retain re-included source', () => {
        const dir = tmp({
            'package.json': '{}',
            '.gitignore': 'generated/**\n!generated/keep.js\n',
            'generated/keep.js': 'export function retained() { return 1; }',
            'generated/drop.js': 'export function dropped() { return 1; }',
        });
        try {
            const index = idx(dir);
            assert.equal(index.find('retained', { skipCounts: true }).length, 1);
            assert.equal(index.find('dropped', { skipCounts: true }).length, 0);
        } finally { rm(dir); }
    });

    it('UCN5-161: oversized source is bounded and explicitly disclosed', () => {
        const dir = tmp({
            'package.json': '{}',
            'small.js': 'export function small() { return 1; }',
            'huge.js': '/*' + 'x'.repeat(8 * 1024 * 1024) + '*/',
        });
        try {
            const index = idx(dir);
            assert.equal(index.files.has(path.join(dir, 'huge.js')), false);
            assert.ok(index.discoveryIssues.some(issue =>
                issue.relativePath === 'huge.js' && issue.reason === 'max-file-size'));
            assert.equal(execute(index, 'doctor', {}).result.trust, 'PARTIAL');
        } finally { rm(dir); }
    });

    it('UCN5-005/007/012/013: paren-less member and nested-type references prevent false dead claims', () => {
        const dir = tmp({
            'package.json': '{}',
            'base.py': [
                'class Base:',
                '    @property',
                '    def has_thing(self): return True',
                '    def pick(self, n): return n',
            ].join('\n'),
            'app.py': [
                'from base import Base',
                'class App(Base):',
                '    def run(self):',
                '        if self.has_thing: return self.pick',
                'def callbacks():',
                '    s = Base()',
                '    return [s.pick]',
            ].join('\n'),
            'Nested.cs': [
                'namespace N;',
                'static class Outer {',
                '  internal static class Inner { public const string K = "k"; }',
                '}',
                'class Use { public string Go() => Outer.Inner.K; }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const dead = index.deadcode({ includeExported: true });
            for (const name of ['has_thing', 'pick', 'Inner']) {
                assert.equal(dead.some(item => item.name === name), false, name);
            }
        } finally { rm(dir); }
    });

    it('UCN5-006: same-named qualified external bases retain their contract shield', () => {
        const dir = tmp({
            'app.py': [
                'import werkzeug.test',
                'class EnvironBuilder(werkzeug.test.EnvironBuilder):',
                '    def json_dumps(self, obj): return str(obj)',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const dead = index.deadcode();
            assert.equal(dead.some(item =>
                item.name === 'EnvironBuilder' || item.name === 'json_dumps'), false);
            assert.ok(dead.excludedExternalContract >= 1);
        } finally { rm(dir); }
    });

    it('UCN5-008/009: syntax-only callables are excluded and a live member keeps its class alive', () => {
        const dir = tmp({
            'o.cpp': [
                'struct Key { int v; };',
                'static bool operator<(const Key& a, const Key& b) { return a.v < b.v; }',
                'int use() { Key a{1}; Key b{2}; return a < b; }',
            ].join('\n'),
            'M.cs': [
                'namespace D;',
                'public class Bag { public string this[int i] => "x"; }',
                'internal static class LoggerExtensions {',
                '  public static string WithLevel(this string logger, int level) => logger;',
                '}',
                'class Use { string Go(string log) { var b = new Bag(); return b[0].WithLevel(3); } }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const dead = index.deadcode({ includeExported: true });
            assert.equal(dead.some(item => item.name.startsWith('operator')), false);
            assert.equal(dead.some(item => item.name === 'this[]'), false);
            assert.equal(dead.some(item => item.name === 'LoggerExtensions'), false);
        } finally { rm(dir); }
    });

    it('UCN5-010: direct cross-file and two-step computed dispatch shield registry members', () => {
        const dir = tmp({
            'package.json': '{}',
            'reg.js': [
                'const handlers = { onOpen() { return 1; } };',
                'module.exports = { handlers };',
            ].join('\n'),
            'run.js': [
                "const { handlers } = require('./reg');",
                'function dispatch(evt) { const h = handlers[evt]; return h(); }',
                'module.exports = { dispatch };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const dead = index.deadcode({ includeExported: true });
            assert.equal(dead.some(item => item.name === 'onOpen'), false);
            assert.ok(dead.excludedDynamicDispatch >= 1);
            assert.ok(dead.computedDispatch.count >= 1);
        } finally { rm(dir); }
    });

    it('UCN5-011: skipped-source matches suppress dead claims and disclose degraded coverage', () => {
        const dir = tmp({
            'package.json': '{}',
            'helper.js': 'function formatDate(d) { return String(d); }',
            'view.vue': '<template>{{ formatDate(now) }}</template>',
        });
        try {
            const index = idx(dir);
            const dead = index.deadcode();
            assert.equal(dead.some(item => item.name === 'formatDate'), false);
            assert.equal(dead.coverage.complete, false);
            assert.equal(dead.coverage.suppressedMatched, 1);
            assert.match(output.formatDeadcode(dead), /source coverage is incomplete/i);
            const json = JSON.parse(output.formatDeadcodeJson(dead));
            assert.equal(json.data.coverage.complete, false);
        } finally { rm(dir); }
    });

    it('UCN5-014: calls on another receiver are never labelled self-recursive', () => {
        const dir = tmp({
            'package.json': '{}',
            'a.js': [
                'class Inner { emit(m) { return "i" + m; } }',
                'class Outer { emit() { return new Inner().emit("x"); } }',
                'module.exports = { Outer };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const dead = index.deadcode({ includeExported: true });
            assert.equal(dead.some(item => item.name === 'emit'), false);
            assert.equal(dead.some(item => item.selfRecursive), false);
        } finally { rm(dir); }
    });

    it('UCN5-017: CommonJS default function exports keep their authored identity', () => {
        const dir = tmp({
            'package.json': '{}',
            'transform.js': [
                'module.exports = function transformer(file, api) {',
                '  return api.run(file);',
                '};',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.equal(index.find('transformer', { skipCounts: true }).length, 1);
            assert.equal(index.find('exports', { skipCounts: true }).length, 0);
            assert.equal(index.deadcode().some(item => item.name === 'transformer'), false);
        } finally { rm(dir); }
    });

    it('UCN5-022: rename plans include CJS and ESM re-export surfaces', () => {
        const cjs = tmp({
            'package.json': '{}',
            'core.js': 'function transform(x) { return x; }\nmodule.exports = { transform };',
            'index.js': "const { transform } = require('./core');\nmodule.exports = { transform };",
            'app.js': "const { transform } = require('./index');\ntransform(1);",
        });
        const esm = tmp({
            'package.json': '{"type":"module"}',
            'core.js': 'export function transform(x) { return x; }',
            'index.js': "export { transform } from './core.js';",
            'app.js': "import { transform } from './index.js';\ntransform(1);",
        });
        try {
            for (const dir of [cjs, esm]) {
                const plan = idx(dir).plan('transform', { renameTo: 'convert' });
                assert.ok(plan.changes.some(change =>
                    change.file === 'index.js' && change.isExport &&
                    change.newExpression.includes('convert')),
                JSON.stringify(plan.changes));
            }
        } finally { rm(cjs); rm(esm); }
    });

    it('UCN5-023: rename plans edit aliased imports and omit alias-call no-ops', () => {
        const dir = tmp({
            'core.py': 'def transform(x):\n    return x * 2\n',
            'alias.py': 'from core import transform as xf\n\ndef run():\n    return xf(2)\n',
        });
        try {
            const plan = idx(dir).plan('transform', { renameTo: 'convert' });
            assert.ok(plan.changes.some(change =>
                change.file === 'alias.py' && change.line === 1 &&
                change.isImport && change.newExpression.includes('convert as xf')),
            JSON.stringify(plan.changes));
            assert.equal(plan.changes.some(change =>
                change.expression === change.newExpression), false);
        } finally { rm(dir); }
    });

    it('UCN5-024: method rename plans include descendant overrides', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'Base.java': 'public abstract class Base { public abstract String render(String ctx); }',
            'Child.java': [
                'public class Child extends Base {',
                '  @Override public String render(String ctx) { return ctx; }',
                '}',
            ].join('\n'),
            'Main.java': 'class Main { String go(Base b) { return b.render("x"); } }',
        });
        try {
            const plan = idx(dir).plan('render', {
                className: 'Base', renameTo: 'draw',
            });
            assert.ok(plan.changes.some(change =>
                change.file === 'Child.java' && change.isDefinition &&
                change.newExpression.includes('draw')),
            JSON.stringify(plan.changes));
            assert.equal(plan.changeSummary.definitions, 2);
        } finally { rm(dir); }
    });

    it('UCN5-020: external-typed receivers never become confirmed by single-owner spelling', () => {
        const goDir = tmp({
            'go.mod': 'module example.com/fxc\n\ngo 1.21\n',
            'a.go': 'package fxc\ntype MyCloser struct{}\nfunc (m *MyCloser) Close() error { return nil }\n',
            'b.go': [
                'package fxc',
                'import ("net/http"; "os")',
                'func Run() {',
                '  f, _ := os.Open("x")',
                '  defer f.Close()',
                '}',
                'func Run2(r *http.Response) {',
                '  r.Body.Close()',
                '}',
            ].join('\n'),
        });
        const tsDir = tmp({
            'package.json': '{}',
            'a.ts': 'export class MyLogger { flush(): void {} }',
            'b.ts': "import { WriteStream } from 'fs';\nfunction run(ws: WriteStream) { ws.flush(); }",
        });
        try {
            for (const [dir, name] of [[goDir, 'Close'], [tsDir, 'flush']]) {
                const index = idx(dir);
                const def = index.find(name, { skipCounts: true })[0];
                const shown = execute(index, 'show', {
                    name: `${def.relativePath}:${def.startLine}:${name}`,
                }).result;
                assert.equal(shown.context.meta.account.confirmed, 0, name);
                assert.equal(shown.context.meta.account.conserved, true, name);
            }
        } finally { rm(goDir); rm(tsDir); }
    });

    it('UCN5-028: C# extension methods bind through platform and project supertypes', () => {
        const dir = tmp({
            'Ext.cs': [
                'using System.Collections.Generic;',
                'namespace D {',
                '  public interface IThing { }',
                '  public class Thing : IThing { }',
                '  public class Sub : Thing { }',
                '  public static class Ext {',
                '    public static int TotalEnum(this IEnumerable<int> xs) => 0;',
                '    public static int Do(this IThing t) => 1;',
                '    public static int Sub2(this Thing t) => 2;',
                '  }',
                '  class Runner { int Go() {',
                '    List<int> ys = new List<int>();',
                '    Thing t = new Thing();',
                '    Sub s = new Sub();',
                '    return ys.TotalEnum() + t.Do() + s.Sub2();',
                '  } }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            for (const name of ['TotalEnum', 'Do', 'Sub2']) {
                const def = index.find(name, { skipCounts: true })[0];
                const shown = execute(index, 'show', {
                    name: `${def.relativePath}:${def.startLine}:${name}`,
                }).result;
                assert.equal(shown.context.meta.account.confirmed, 1, name);
                assert.equal(shown.context.meta.account.excluded.total, 0, name);
            }
        } finally { rm(dir); }
    });

    it('UCN5-015: C conditional braces recover following definitions and exact ranges', () => {
        const dir = tmp({
            't.c': [
                'static void dump_term(int x) {',
                '  switch (x) {',
                '  case 1: {',
                '    if (x == 0) {',
                '      dump_term(0);',
                '    } else {',
                '#ifdef USE_DECNUM',
                '      const char *lit = get_lit(x);',
                '      if (lit) {',
                '        put_str(lit);',
                '      } else {',
                '#endif',
                '        double d = val(x);',
                '        put_str(fmt(d));',
                '      }',
                '#ifdef USE_DECNUM',
                '    }',
                '#endif',
                '    break;',
                '  }',
                '  }',
                '}',
                '',
                'void dumpf(int x) {',
                '  dump_term(x);',
                '}',
                '',
                'int main(void) { dumpf(1); return 0; }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const term = index.find('dump_term', { skipCounts: true })[0];
            assert.deepEqual([term.startLine, term.endLine], [1, 22]);
            assert.equal(index.find('dumpf', { skipCounts: true }).length, 1);
            assert.equal(index.find('main', { skipCounts: true }).length, 1);
            const callers = index.findCallers('dump_term', { collectAccount: true });
            assert.ok(callers.some(call => call.line === 25 &&
                call.callerName === 'dumpf'));
            assert.equal(index.deadcode().some(item => item.name === 'dump_term'), false);
            assert.equal(index.files.get(term.file).parseRecovery, true);
        } finally { rm(dir); }
    });

    it('UCN5-021: Rust item-position macro bodies contribute declarations and ownership', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname="fxmacro"\nversion="0.1.0"\nedition="2021"\n',
            'src/lib.rs': [
                'macro_rules! declare {',
                '    ($($item:item)*) => { $($item)* };',
                '}',
                '',
                'declare! {',
                '    pub struct Config {',
                '        pub retries: u32,',
                '    }',
                '',
                '    pub fn helper(n: u32) -> u32 {',
                '        inner(n)',
                '    }',
                '}',
                '',
                'fn inner(n: u32) -> u32 { n + 1 }',
                '',
                'pub fn user() -> u32 {',
                '    helper(3)',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const config = index.find('Config', { skipCounts: true });
            const helper = index.find('helper', { skipCounts: true });
            assert.equal(config.length, 1);
            assert.equal(config[0].type, 'struct');
            assert.deepEqual([config[0].startLine, config[0].endLine], [6, 8]);
            assert.equal(helper.length, 1);
            assert.deepEqual([helper[0].startLine, helper[0].endLine], [10, 12]);
            assert.ok(index.files.get(helper[0].file).exportDetails.some(item =>
                item.name === 'helper' && item.type === 'function'));

            const innerCalls = index.findCallees(helper[0], { collectAccount: true });
            assert.ok(innerCalls.some(call => call.name === 'inner'));
            const user = index.find('user', { skipCounts: true })[0];
            const userCalls = index.findCallees(user, { collectAccount: true });
            assert.ok(userCalls.some(call => call.name === 'helper'));
            assert.equal(index.files.get(helper[0].file).parseRecovery, true);
        } finally { rm(dir); }
    });

    it('UCN5-031/032/033: api honors effective visibility, Python exports, and scope', () => {
        const dir = tmp({
            'Lib.cs': [
                'namespace Fx;',
                'public class PublicThing { public void Visible() { } }',
                'class InternalByDefault { public void Hidden() { } }',
                'internal class ExplicitInternal { public void HiddenToo() { } }',
                'public class Outer {',
                '  class PrivateNested { public void Deep() { } }',
                '  public class PublicNested { public void Reachable() { } }',
                '}',
            ].join('\n'),
            'pkg/core.py': [
                'def public_thing(): return 1',
                'def _private_thing(): return 2',
            ].join('\n'),
            'pkg/__init__.py': 'from .core import public_thing as public_thing\n',
            'outside/extra.js': 'export function outsideOnly() { return 1; }\n',
        });
        try {
            const index = idx(dir);
            const api = index.api();
            const names = new Set(api.map(item => item.name));
            for (const name of ['PublicThing', 'Visible', 'Outer',
                'PublicNested', 'Reachable', 'public_thing']) {
                assert.equal(names.has(name), true, name);
            }
            for (const name of ['InternalByDefault', 'Hidden',
                'ExplicitInternal', 'HiddenToo', 'PrivateNested', 'Deep',
                '_private_thing']) {
                assert.equal(names.has(name), false, name);
            }
            assert.match(output.formatApi(api), /Python files without __all__/);
            assert.match(output.formatApiJson(api), /top-level non-underscore/);

            const scoped = execute(index, 'api', { in: 'pkg' });
            assert.equal(scoped.ok, true);
            assert.ok(scoped.result.length > 0);
            assert.ok(scoped.result.every(item => item.file.startsWith('pkg/')));
            assert.equal(scoped.result.some(item => item.name === 'outsideOnly'), false);
            assert.equal(execute(index, 'api', { in: 'missing' }).ok, false);
        } finally { rm(dir); }
    });

    it('UCN5-034/035: async audits recognize asyncio consumers and ConfigureAwait', () => {
        const dir = tmp({
            'lib.py': [
                'import asyncio',
                'async def fetch(i): return i',
                'async def save(d): return d',
                'async def missing():',
                '    save(1)',
                'async def gathered():',
                '    await asyncio.gather(fetch(1), fetch(2))',
                'async def tasked():',
                '    asyncio.create_task(fetch(3))',
                'async def ensured():',
                '    asyncio.ensure_future(save(2))',
            ].join('\n'),
            'D.cs': [
                'using System.Threading.Tasks;',
                'namespace N;',
                'class T {',
                '  static async Task StepAsync() { await Task.Delay(1); }',
                '  public static async Task WithConfigure() { await StepAsync().ConfigureAwait(false); }',
                '  public static async Task Missing() { StepAsync(); }',
                '}',
            ].join('\n'),
        });
        try {
            const result = idx(dir).auditAsync();
            const sites = new Set(result.issues.map(
                issue => `${issue.file}:${issue.line}:${issue.calleeName}`));
            assert.deepEqual([...sites].sort(), [
                'D.cs:6:StepAsync',
                'lib.py:5:save',
            ]);
        } finally { rm(dir); }
    });

    it('UCN5-036: struct constructor arity is checked in C# and C++', () => {
        const dir = tmp({
            'Point.cs': [
                'namespace Demo;',
                'public struct Point { public Point(int x, int y) { } }',
                'class Use { void Run() { var good = new Point(1, 2); var bad = new Point(1); } }',
            ].join('\n'),
            'point.cpp': [
                'struct CppPoint { CppPoint(int x, int y) {} };',
                'int run() {',
                '  CppPoint *good = new CppPoint(1, 2);',
                '  CppPoint *bad = new CppPoint(1);',
                '  return 0;',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            for (const name of ['Point', 'CppPoint']) {
                const result = index.verify(name);
                assert.deepEqual(result.expectedArgs, { min: 2, max: 2 }, name);
                assert.equal(result.valid, 1, name);
                assert.equal(result.mismatches, 1, name);
            }
        } finally { rm(dir); }
    });

    it('UCN5-037: a Go variable named like its type is not a method expression', () => {
        const dir = tmp({
            'go.mod': 'module example.com/fx\n\ngo 1.21\n',
            'lib.go': [
                'package main',
                'type node struct{ v int }',
                'func (n *node) getValue(path string, flag bool) string { return path }',
                'func run() string {',
                '  node := &node{}',
                '  return node.getValue("/x", true)',
                '}',
            ].join('\n'),
        });
        try {
            const result = idx(dir).verify('getValue');
            assert.equal(result.valid, 1);
            assert.equal(result.mismatches, 0);
        } finally { rm(dir); }
    });

    it('UCN5-040: external-library receivers never enter refactor verification', () => {
        const dir = tmp({
            'go.mod': 'module example.com/external\n\ngo 1.21\n',
            'lib.go': [
                'package main',
                'import "net/http"',
                'type Context struct{}',
                'func (c *Context) Query(key string) string { return key }',
                'func local(c *Context) string { return c.Query("ok") }',
                'func external(req *http.Request) string { return req.URL.Query().Get("x") }',
            ].join('\n'),
        });
        try {
            const result = idx(dir).verify('Query');
            assert.equal(result.valid, 1);
            assert.equal(result.mismatches, 0);
            assert.equal(result.account.excluded.byReason['external-package'].count, 1);
        } finally { rm(dir); }
    });

    it('UCN5-043/045: CLI validates line pins and honors max-files on a warm cache', () => {
        const dir = tmp({
            'package.json': '{}',
            'a.js': 'function dup() { return 1; }\nmodule.exports = { dup };',
            'b.js': 'function dup() { return 2; }\nmodule.exports = { dup };',
        });
        try {
            for (const value of ['abc', '0', '1e1', '2.5']) {
                assert.match(runCli(dir, 'source', ['dup'], [`--line=${value}`]),
                    /Invalid --line value/);
            }
            runCli(dir, 'repo'); // warm a full disk cache
            assert.match(runCli(dir, 'repo', [], ['--max-files=1']), /1 files/);
        } finally { rm(dir); }
    });

    it('UCN5-044: interactive mode rebuilds after an edited source file', async () => {
        const dir = tmp({
            'package.json': '{}',
            'a.js': 'function one() { return 1; }\nmodule.exports = { one };',
        });
        const child = spawn(process.execPath, [CLI_PATH, '--interactive', '--no-cache', dir], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        const until = (pattern, timeout = 10000) => new Promise((resolve, reject) => {
            const started = Date.now();
            const poll = () => {
                if (pattern.test(stdout)) return resolve();
                if (Date.now() - started > timeout) return reject(new Error(`interactive timeout: ${stdout}`));
                setTimeout(poll, 20);
            };
            poll();
        });
        try {
            await until(/Index ready:/);
            child.stdin.write('find one\n');
            await until(/Found 1 match\(es\) for "one"/);
            fs.writeFileSync(path.join(dir, 'a.js'), [
                'function one() { return 1; }',
                'function two() { return one(); }',
                'module.exports = { one, two };',
            ].join('\n'));
            child.stdin.write('find two\n');
            await until(/Source changed; rebuilding index/);
            await until(/Found 1 match\(es\) for "two"/);
            assert.doesNotMatch(stdout, /No symbols found for "two"/);
        } finally {
            child.stdin.end('quit\n');
            if (!child.killed) child.kill();
            rm(dir);
        }
    });

    it('UCN5-046/047: runtime callbacks and implicit Python public APIs are protected', () => {
        const dir = tmp({
            'Singleton.java': [
                'import java.io.Serializable;',
                'class Singleton implements Serializable {',
                '  private Object readResolve() { return this; }',
                '  private int ordinaryUnused() { return 1; }',
                '}',
            ].join('\n'),
            'pkg/__init__.py': '',
            'pkg/core.py': [
                'class Widget:',
                '    def public_api(self): return 42',
                'def public_function(): return 1',
                'def _private_function(): return 2',
            ].join('\n'),
        });
        try {
            const result = idx(dir).deadcode();
            const names = new Set(result.map(item => item.name));
            assert.equal(names.has('readResolve'), false);
            assert.equal(names.has('ordinaryUnused'), true);
            assert.equal(names.has('Widget'), false);
            assert.equal(names.has('public_api'), false);
            assert.equal(names.has('public_function'), false);
            assert.equal(names.has('_private_function'), true);
            assert.equal(result.excludedRuntimeContract, 1);
            assert.ok(result.excludedExported >= 3);
            assert.equal(result.pythonImplicitExportFiles, 2);
            const text = output.formatDeadcode(result);
            assert.match(text, /Java serialization callback/);
            assert.match(text, /Python public-surface rule active/);
            assert.match(output.formatDeadcodeJson(result), /pythonImplicitExportFiles/);
        } finally { rm(dir); }
    });

    it('UCN5-048/049: deps excludes Go test artifacts and includes Java same-package references', () => {
        const dir = tmp({
            'go.mod': 'module example.com/graph\n\ngo 1.21\n',
            'pkg/thing/thing.go': 'package thing\nfunc Do() int { return 1 }',
            'pkg/thing/a_test.go': [
                'package thing_test',
                'import "example.com/graph/pkg/thing"',
                'func TestA() { thing.Do() }',
            ].join('\n'),
            'pkg/thing/b_test.go': [
                'package thing_test',
                'import "example.com/graph/pkg/thing"',
                'func TestB() { thing.Do() }',
            ].join('\n'),
            'A.java': 'package p;\nclass A { static int value() { return 1; } }',
            'B.java': 'package p;\nclass B { int use() { return A.value(); } }',
        });
        try {
            const index = idx(dir);
            const rels = file => [...index.importGraph.get(path.join(dir, file))]
                .map(target => index.files.get(target).relativePath);
            assert.deepEqual(rels('pkg/thing/a_test.go'), ['pkg/thing/thing.go']);
            assert.deepEqual(rels('pkg/thing/b_test.go'), ['pkg/thing/thing.go']);
            assert.equal(index.circularDeps().cycles.length, 0);
            assert.deepEqual(rels('B.java'), ['A.java']);
            assert.deepEqual(index.graph('A.java', { direction: 'importers', depth: 1 })
                .nodes.map(node => node.relativePath), ['A.java', 'B.java']);
        } finally { rm(dir); }
    });

    it('UCN5-050: absent deps depth renders identically across null/undefined surfaces', () => {
        const dir = tmp({
            'package.json': '{}',
            'a.js': 'export function a() {}',
            'b.js': 'import { a } from "./a.js"; export function b() { a(); }',
            'c.js': 'import { b } from "./b.js"; export function c() { b(); }',
            'd.js': 'import { c } from "./c.js"; export function d() { c(); }',
        });
        try {
            const index = idx(dir);
            const execution = execute(index, 'deps', { file: 'a.js', direction: 'importers' });
            assert.equal(execution.ok, true);
            const cliShape = publicOutput.formatPublicText('deps', execution.result,
                { depth: null }, execution);
            const mcpShape = publicOutput.formatPublicText('deps', execution.result,
                {}, execution);
            assert.equal(cliShape, mcpShape);
        } finally { rm(dir); }
    });

    it('UCN5-054/055/056/057: endpoints filters, labels, display modes, and mounts are exact', () => {
        const dir = tmp({
            'package.json': '{}',
            'users.js': [
                'const express = require("express");',
                'const router = express.Router();',
                'router.get("/", listUsers);',
                'router.get("/:id", getUser);',
                'function listUsers() {}',
                'function getUser() {}',
                'module.exports = router;',
            ].join('\n'),
            'app.js': [
                'const express = require("express");',
                'const usersRouter = require("./users");',
                'const app = express();',
                'app.use("/api/users", usersRouter);',
                'app.get("/health", health);',
                'function health() {}',
            ].join('\n'),
            'client.js': [
                'function loadUsers() { return fetch("/api/users"); }',
                'function loadRoot() { return fetch("/"); }',
            ].join('\n'),
            'routes.py': [
                'from flask import Flask',
                'app = Flask(__name__)',
                '@app.get("/items")',
                'def items(): return []',
            ].join('\n'),
            'go.mod': 'module example.com/routes\n\ngo 1.21\n',
            'main.go': [
                'package main',
                'func setup() {',
                '  engine := gin.Default()',
                '  group := engine.Group("/admin")',
                '  group.GET("/users", adminUsers)',
                '}',
                'func adminUsers() {}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const all = execute(index, 'endpoints', { bridge: true });
            assert.equal(all.ok, true);
            const paths = new Set(all.result.routes.map(route => route.path));
            for (const expected of ['/api/users', '/api/users/:id', '/admin/users']) {
                assert.equal(paths.has(expected), true, expected);
            }
            assert.equal(paths.has('/'), false);
            assert.equal(all.result.bridges.some(bridge =>
                bridge.route.path === '/api/users' && bridge.matchType === 'exact'), true);
            assert.equal(all.result.bridges.some(bridge => bridge.request.path === '/'), false);
            const flask = execute(index, 'endpoints', { framework: 'flask' });
            assert.equal(flask.result.routes.length, 1);
            assert.equal(flask.result.routes[0].framework, 'flask');
            assert.equal(execute(index, 'endpoints', { framework: 'zzzz' }).ok, false);

            const client = execute(index, 'endpoints', { clientOnly: true });
            const clientText = publicOutput.formatPublicText('endpoints', client.result,
                { clientOnly: true }, client);
            assert.doesNotMatch(clientText, /No server routes detected/);
            const server = execute(index, 'endpoints', { serverOnly: true });
            const serverText = publicOutput.formatPublicText('endpoints', server.result,
                { serverOnly: true }, server);
            assert.doesNotMatch(serverText, /No client requests detected/);
        } finally { rm(dir); }
    });

    it('UCN5-058/059/060/061: entrypoints require callable runtime evidence', () => {
        const dir = tmp({
            'package.json': '{}',
            'src/util/index.js': [
                'export function pad() {}',
                'export function trim() {}',
            ].join('\n'),
            'go.mod': 'module example.com/entry\n\ngo 1.21\n',
            'mode.go': [
                'package entry',
                'const TestMode = "test"',
                'type TestRender struct{}',
                'type TestErr string',
                'func TestReal() {}',
            ].join('\n'),
            'server.go': [
                'package entry',
                'type Opts struct { staticPrefix string }',
                'func server(staticPrefix string) {',
                '  mux.Handle(staticPrefix, newHandler())',
                '}',
                'func newHandler() {}',
            ].join('\n'),
            'decorators.py': [
                'import typing as t',
                'class Box:',
                '    @property',
                '    def size(self): return 1',
                '    @size.setter',
                '    def size(self, value): pass',
                '@t.overload',
                'def get(k: str) -> str: ...',
                '@app.before_request',
                'def before(): pass',
            ].join('\n'),
        });
        try {
            const entries = detectEntrypoints(idx(dir));
            const names = new Set(entries.map(entry => entry.name));
            for (const falseEntry of ['pad', 'trim', 'TestMode', 'TestRender',
                'TestErr', 'staticPrefix', 'size', 'get']) {
                assert.equal(names.has(falseEntry), false, falseEntry);
            }
            assert.equal(names.has('TestReal'), true);
            assert.equal(names.has('before'), true);
            assert.equal(entries.find(entry => entry.name === 'before').framework, 'flask');
        } finally { rm(dir); }
    });

    it('UCN5-062/063/068: find inventories tests and emitted handles round-trip exactly', () => {
        const dir = tmp({
            'package.json': '{}',
            'util.js': 'function helper() { return "root"; }\nmodule.exports={helper};',
            'internal/fs/util.js': 'function helper() { return "sub"; }\nmodule.exports={helper};',
            'tests/test_app.py': '@cache\ndef build_fixture():\n    return 1\n',
        });
        try {
            const index = idx(dir);
            const fixture = execute(index, 'find', { name: 'build_fixture' });
            assert.equal(fixture.result.length, 1);
            const byNameLine = execute(index, 'find', {
                name: 'build_fixture', file: 'tests/test_app.py', line: 2,
            });
            assert.equal(byNameLine.result.length, 1);

            const exact = execute(index, 'impact', {
                name: 'helper', file: 'util.js', line: 1,
            });
            assert.equal(exact.ok, true);
            assert.equal(exact.result.file, 'util.js');
            assert.equal(index.resolveSymbol('helper', {
                file: 'util.js', line: 1,
            }).def.relativePath, 'util.js');
        } finally { rm(dir); }
    });

    it('UCN5-064/074/075: find and HOT use pinned caller-engine counts', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname="counts"',
            'lib.py': [
                'def dumps(obj): return str(obj)',
                'class Alpha:',
                '    def save(self): return 1',
                'class Beta:',
                '    def save(self): return 2',
                'def run(a: Alpha, b: Beta):',
                '    a.save()',
                '    b.save(); b.save(); b.save()',
            ].join('\n'),
            'foreign.py': 'import json\ndef foreign(x): return json.dumps(x)\n',
        });
        try {
            const index = idx(dir);
            const dumps = execute(index, 'find', { name: 'dumps' }).result[0];
            assert.equal(dumps.usageCounts.calls, 0);
            const hot = execute(index, 'stats', { hot: true, top: 10 }).result.hot.items;
            assert.equal(hot.some(item => item.name === 'dumps'), false);
            assert.equal(hot.find(item => item.name === 'Alpha.save').callCount, 1);
            assert.equal(hot.find(item => item.name === 'Beta.save').callCount, 3);
        } finally { rm(dir); }
    });

    it('UCN5-065/066/067: explicit C++ dispatch and C# member receivers remain visible', () => {
        const dir = tmp({
            'v.cpp': [
                'struct Base { virtual int calc() const { return 0; } };',
                'struct Derived : Base { int calc() const override { return 7; } };',
                'int consume(const Base& b) { return b.calc(); }',
                'int drive() { Derived d; return d.calc(); }',
            ].join('\n'),
            'P.cs': [
                'namespace N;',
                'class Alpha { public void Run() { } }',
                'class Beta { public void Run() { } }',
                'class Caller {',
                ' public Alpha Prop { get; } = new Alpha();',
                ' private readonly Alpha Field = new Alpha();',
                ' public void F() { Prop.Run(); Field.Run(); this.Prop.Run(); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const cpp = index.symbols.get('calc');
            assert.equal(cpp.find(def => def.className === 'Base').modifiers.includes('virtual'), true);
            assert.equal(cpp.find(def => def.className === 'Derived').modifiers.includes('override'), true);
            const cppCallers = index.findCallers('calc', {
                targetDefinitions: cpp.filter(def => def.className === 'Derived'),
                collectAccount: true,
            });
            assert.equal(cppCallers.unverifiedEntries.some(site =>
                site.line === 3 && site.reason === 'possible-dispatch'), true);

            const csDefs = index.symbols.get('Run').filter(def => def.className === 'Alpha');
            const csCallers = index.findCallers('Run', {
                targetDefinitions: csDefs, collectAccount: true,
            });
            assert.equal(csCallers.length, 3);
            assert.deepEqual(csCallers.accountRaw.excludedEntries, []);
        } finally { rm(dir); }
    });

    it('UCN5-069/070: header detection is root-confined and Java comments are inert', () => {
        const parent = fs.mkdtempSync('/tmp/ucn-header-root-');
        const cppRoot = path.join(parent, 'cppproj');
        fs.mkdirSync(path.join(parent, 'cproj'), { recursive: true });
        fs.mkdirSync(path.join(cppRoot, 'include'), { recursive: true });
        fs.mkdirSync(path.join(cppRoot, 'src'), { recursive: true });
        try {
            for (let i = 0; i < 5; i++) {
                fs.writeFileSync(path.join(parent, 'cproj', `c${i}.c`), `int c${i}(void){return ${i};}`);
            }
            fs.writeFileSync(path.join(cppRoot, 'include/lib.h'),
                'namespace lib { class Engine { public: int start(); }; }');
            fs.writeFileSync(path.join(cppRoot, 'src/lib.cpp'), '#include "../include/lib.h"\n');
            fs.writeFileSync(path.join(cppRoot, 'src/main.cpp'), '#include "../include/lib.h"\n');
            const index = new ProjectIndex(cppRoot, { quiet: true });
            index.build(null, { quiet: true, noCache: true });
            assert.equal(index.files.get(path.join(cppRoot, 'include/lib.h')).language, 'cpp');
            assert.equal((index.symbols.get('Engine') || []).length, 1);

            const javaDir = tmp({
                'Demo.java': '@SuppressWarnings("unchecked") // not an annotation\npublic class Demo { public int run(){ return 1; } }',
            });
            try {
                const javaIndex = idx(javaDir);
                assert.equal(detectEntrypoints(javaIndex).length, 0);
                const demo = javaIndex.symbols.get('Demo')[0];
                assert.equal(demo.modifiers.some(mod => mod.startsWith('//')), false);
            } finally { rm(javaDir); }
        } finally { fs.rmSync(parent, { recursive: true, force: true }); }
    });

    it('UCN5-071/072: rename edits AST identifiers and paired C declarations', () => {
        const jsDir = tmp({
            'package.json': '{}',
            'lib.js': 'function greet(x){return x}\nmodule.exports={greet};',
            'app.js': 'const {greet}=require("./lib");\nfunction run(){ console.log("greet", greet(1)); /* greet */ }',
        });
        try {
            const plan = execute(idx(jsDir), 'plan', {
                name: 'greet', renameTo: 'salute',
            }).result;
            const call = plan.changes.find(change => change.file === 'app.js' && change.line === 2);
            assert.equal(call.newExpression.includes('"greet"'), true);
            assert.equal(call.newExpression.includes('/* greet */'), true);
            assert.equal(call.newExpression.includes('salute(1)'), true);
        } finally { rm(jsDir); }

        const cDir = tmp({
            'shared.h': 'int apply_op(int a, int b);',
            'ops.c': '#include "shared.h"\nint apply_op(int a,int b){return a+b;}\nint use(void){return apply_op(1,2);}',
        });
        try {
            const plan = execute(idx(cDir), 'plan', {
                name: 'apply_op', file: 'ops.c', line: 2,
                renameTo: 'apply_binop',
            }).result;
            assert.equal(plan.changes.some(change =>
                change.file === 'shared.h' && change.newExpression.includes('apply_binop')), true);
        } finally { rm(cDir); }
    });

    it('UCN5-073/076/077/078/079: surfaces guide migration and reject false precision', () => {
        const { v4MigrationHint } = require('../core/registry');
        assert.match(v4MigrationHint('fn'), /ucn source <name>/);
        assert.match(v4MigrationHint('toc', 'mcp'), /command "repo"/);

        const dir = tmp({
            'package.json': '{}',
            'a.js': 'function Foo(){}\nfunction foo(){}\n',
            'Nested.cs': 'namespace Demo; public class Outer { class Inner { public int Secret()=>42; } public int Use()=>new Inner().Secret(); }',
            'Outer.java': 'public class OuterJ { private static class InnerJ { public int secret(){return 1;} } }',
            'Helper.java': 'class Helper { public int helpMe(){return 1;} }',
        });
        try {
            const index = idx(dir);
            const search = execute(index, 'search', {
                term: 'Foo', caseSensitive: true, codeOnly: true,
            });
            assert.equal(search.result.reduce((n, file) => n + file.matches.length, 0), 1);
            const csApi = execute(index, 'api', { file: 'Nested.cs' }).result;
            assert.equal(csApi.some(item => item.name === 'Secret'), false);
            const javaApi = execute(index, 'api', {}).result;
            assert.equal(javaApi.some(item =>
                item.name === 'secret' || item.name === 'helpMe'), false);

            const started = Date.now();
            const unsafe = execute(index, 'search', {
                term: '(a+)+$', regex: true,
            });
            assert.equal(unsafe.ok, false);
            assert.match(unsafe.error, /Unsafe regular expression/);
            assert.ok(Date.now() - started < 1000);

            const cli = runCli(dir, 'fn', ['Foo']);
            assert.match(cli, /ucn source <name>/);
        } finally { rm(dir); }
    });

    it('UCN5-080/081/082: structural search separates calls from references and scopes unused honestly', () => {
        const dir = tmp({
            'package.json': '{}',
            'types.ts': [
                'export interface Opts { n: number }',
                'export function add(x: number, o: Opts) { return x + o.n; }',
                'const value: Opts = { n: 2 };',
                'add(1, value);',
            ].join('\n'),
            'calls.js': 'function parseRequest(input) { return String(input).trim(); }',
            'calls.py': 'def helper(x):\n    return str(x)\ndef main(data):\n    return helper(data)\n',
        });
        try {
            const index = idx(dir);
            const unused = execute(index, 'search', { unused: true }).result;
            assert.equal(unused.results.some(row =>
                ['class', 'struct', 'interface', 'type', 'field'].includes(row.kind)), false);
            assert.equal(unused.meta.unusedScope, 'callable-symbols-only');
            assert.match(publicOutput.formatPublicText('search', unused, {}, { structural: true }),
                /not safe-delete proof/);

            const calls = execute(index, 'search', { type: 'call' }).result.results;
            assert.equal(calls.some(row => ['input', 'x', 'data'].includes(row.name)), false);
            assert.equal(calls.some(row => row.name === 'String'), true);
            assert.equal(calls.some(row => row.name === 'helper'), true);
        } finally { rm(dir); }
    });

    it('UCN5-083/084/085/086/087/089: show preserves identity, projection truth, and ambiguity metadata', () => {
        const dir = tmp({
            'package.json': '{}',
            'a.ts': 'export interface Opts { n: number }\nexport function add(x: number, o: Opts) { return x + o.n; }',
            'b.ts': 'import { add, Opts } from "./a";\nexport function use(o: Opts) { return add(1, o); }',
            'alpha.js': 'class Alpha { ping(){ return 1; } }\nmodule.exports={Alpha};',
            'beta.js': 'class Beta { ping(){ return 2; } }\nmodule.exports={Beta};',
        });
        try {
            const index = idx(dir);
            const shownTypes = execute(index, 'show', {
                name: 'add', sections: 'types',
            });
            assert.equal(shownTypes.ok, true);
            const typeText = publicOutput.formatPublicText('show', shownTypes.result,
                { name: 'add' }, { note: shownTypes.note });
            assert.doesNotMatch(typeText, /undefined:undefined/);
            assert.match(typeText, /a\.ts:1/);

            assert.equal(execute(index, 'show', {
                name: 'ping', file: 'missing.js',
            }).ok, false);
            assert.equal(execute(index, 'show', {
                name: 'ping', file: 'a.ts',
            }).ok, false);
            assert.equal(execute(index, 'show', {
                name: 'ping', className: 'Gamma',
            }).ok, false);

            const calleesOnly = execute(index, 'show', {
                name: 'add', sections: 'callees',
            });
            const projection = publicOutput.formatPublicText('show', calleesOnly.result,
                { name: 'add' }, { note: calleesOnly.note });
            assert.doesNotMatch(projection, /CALLERS — CONFIRMED/);
            assert.match(projection, /CALLEES \(/);
            assert.equal('callers' in calleesOnly.result.context, false);

            const ambiguity = 'Found 50 definitions for "Run". Using a.go:1. Also in: b.go:1. Use --file to disambiguate.';
            const budget = applyOutputBudget('x\n'.repeat(3000) + ambiguity, {
                command: 'show', maxChars: 1000,
            });
            assert.equal(budget.contractMetadataComplete, true);
            assert.match(budget.text, /Found 50 definitions/);
        } finally { rm(dir); }
    });

    it('UCN5-088/090/091/092: source shares show resolution, honors class and line bounds', () => {
        const dir = tmp({
            'alpha.py': 'class Alpha:\n    def run(self):\n        return "alpha"\n\ndef use_alpha():\n    a=Alpha()\n    a.run(); a.run(); a.run()\n',
            'beta.py': 'def run():\n    return "beta"\n',
            'gamma.py': 'class Gamma:\n    def run(self, x, y):\n        return x+y\n',
            'Widget.cs': 'class Widget {\n public Widget(int n) { }\n public int Area() { return 1; }\n}\n',
            'long.js': 'function longFn(){\n  const a=1;\n  const b=2;\n  const c=3;\n  return a+b+c;\n}\n',
            'classes.js': 'class One { ping(){return 1;} }\nclass Two { ping(){return 2;} }',
        });
        try {
            const index = idx(dir);
            const show = execute(index, 'show', { name: 'run', sections: 'source' });
            const source = execute(index, 'source', { name: 'run' });
            assert.equal(source.ok, true);
            assert.equal(source.result.entries[0].match.file,
                show.result.source.entries[0].match.file);
            assert.equal(source.result.entries[0].match.startLine,
                show.result.source.entries[0].match.startLine);

            const scoped = execute(index, 'source', {
                name: 'ping', className: 'Two',
            });
            assert.equal(scoped.ok, true);
            assert.equal(scoped.result.entries[0].match.className, 'Two');
            assert.equal(FLAG_APPLICABILITY.source.includes('className'), true);

            const bounded = execute(index, 'source', { name: 'longFn', maxLines: 2 });
            assert.equal(bounded.result.entries[0].truncated, true);
            assert.equal(bounded.result.entries[0].code.split('\n').length, 2);

            const widget = execute(index, 'source', { name: 'Widget' });
            assert.equal(widget.result._publicMode, 'class');
            assert.equal(widget.result.entries[0].match.type, 'class');
        } finally { rm(dir); }
    });

    it('UCN5-093/094: tests keeps proven chained methods and bare test filenames', () => {
        const dir = tmp({
            'package.json': '{}',
            'src/list.ts': 'export class Msg { text(){return "x";} }\nexport class List { last(): Msg { return new Msg(); } }',
            'src/test.ts': 'import {List} from "./list";\nclass Fake { text(){return "fake";} }\ntest("chain",()=>{ new List().last().text(); });',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', {
                name: 'text', className: 'Msg', file: 'src/list.ts',
            });
            assert.equal(result.ok, true);
            assert.equal(result.result.some(file => file.file === 'src/test.ts' &&
                file.matches.some(match => match.line === 3)), true);
        } finally { rm(dir); }
    });

    it('UCN5-095/096/097: callee resolution respects package scope, type shape, and external field ownership', () => {
        const dir = tmp({
            'go.mod': 'module example.com/audit\n\ngo 1.21\n',
            'cmd.go': 'package audit\nfunc NewCmd() int { return 1 }\n',
            'main.go': 'package audit\nfunc Run() int { f := NewCmd; return f() }\n',
            'types.go': 'package audit\ntype header struct { Key string }\nfunc Perform(h header) int { return 1 }\n',
            'field.go': 'package audit\ntype writer struct { header string }\n',
            'literal.go': 'package audit\nfunc Literal() int { return Perform(header{Key:"x"}) }\n',
            'close.go': 'package audit\ntype MyCloser struct{}\nfunc (m *MyCloser) Close() error { return nil }\n',
            'external.go': 'package audit\nimport "net/http"\nfunc External(r *http.Response) { r.Body.Close() }\n',
        });
        try {
            const index = idx(dir);
            const run = execute(index, 'trace', {
                name: 'Run', file: 'main.go', direction: 'callees', depth: 1,
            }).result;
            assert.equal(run.tree.children.some(child => child.name === 'NewCmd'), true);

            const literal = execute(index, 'trace', {
                name: 'Literal', direction: 'callees', depth: 1,
            }).result;
            const header = literal.tree.children.find(child => child.name === 'header');
            assert.ok(header);
            assert.equal(header.file, 'types.go');

            const external = execute(index, 'trace', {
                name: 'External', direction: 'callees', depth: 1,
            }).result;
            assert.equal(external.tree.children.some(child => child.name === 'Close'), false);
        } finally { rm(dir); }
    });

    it('UCN5-098/099: trace depth is deterministic and no-op confidence flags are rejected', () => {
        const files = { 'target.js': 'function target(){}\nmodule.exports={target};' };
        for (let i = 0; i < 14; i++) {
            files[`c${i}.js`] = `const {target}=require("./target"); function c${i}(){target();}`;
        }
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const implicit = execute(index, 'trace', {
                name: 'target', direction: 'callers',
            }).result;
            const explicit = execute(index, 'trace', {
                name: 'target', direction: 'callers', depth: 3,
            }).result;
            assert.deepEqual(explicit.summary, implicit.summary);
            assert.deepEqual(explicit.treeAccount, implicit.treeAccount);
            assert.ok(implicit.treeAccount.truncatedChildren > 0);
            assert.equal(FLAG_APPLICABILITY.trace.includes('minConfidence'), false);
            assert.equal(FLAG_APPLICABILITY.tests.includes('minConfidence'), false);
        } finally { rm(dir); }
    });

    it('UCN5-100: usages inventories method-shaped literal occurrences', () => {
        const dir = tmp({
            'package.json': '{}',
            'src/parser.js': 'function parseRequest(input){return input;}\nmodule.exports={parseRequest};',
            'src/plugin.js': 'function run(parser,input){return parser.parseRequest(input);}\nmodule.exports={run};',
        });
        try {
            const result = execute(idx(dir), 'usages', { name: 'parseRequest' });
            assert.equal(result.ok, true);
            assert.equal(result.result.some(usage =>
                usage.relativePath === 'src/plugin.js' && usage.line === 1 &&
                usage.usageType === 'call'), true);
        } finally { rm(dir); }
    });

    it('UCN5-101/102: api explains Python implicit exports and respects C# type visibility', () => {
        const dir = tmp({
            'pkg/__init__.py': 'from .app import Flask as Flask\n',
            'pkg/app.py': 'class Flask:\n    pass\n',
            'B.cs': [
                'namespace Fx;',
                'public class Api { public void Secret() {} }',
                'class Secret { void OnlyPrivate() {} }',
                'class InternalWithCtor { public InternalWithCtor() {} }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const py = execute(index, 'api', { file: 'pkg' });
            assert.equal(py.ok, true);
            const pyText = publicOutput.formatPublicText('api', py.result,
                { file: 'pkg' }, { surface: 'cli' });
            assert.match(pyText, /Python .*top-level non-underscore|Python package/i);

            const cs = execute(index, 'api', { file: 'B.cs' });
            assert.equal(cs.ok, true);
            assert.equal(cs.result.some(symbol => symbol.name === 'Api'), true);
            assert.equal(cs.result.some(symbol => symbol.name === 'Secret' && !symbol.className), false);
            assert.equal(cs.result.some(symbol => symbol.name === 'InternalWithCtor'), false);
        } finally { rm(dir); }
    });

    it('UCN5-103/112/164: output-budget guidance only recommends applicable mode flags', () => {
        const api = applyOutputBudget('x\n'.repeat(7000), {
            command: 'api', maxChars: 100, surface: 'cli', params: {},
        }).text;
        assert.match(api, /--limit=N/);
        assert.doesNotMatch(api, /--in|--exclude/);

        const cycles = applyOutputBudget('x\n'.repeat(7000), {
            command: 'deps', maxChars: 100, surface: 'cli', params: { cycles: true },
        }).text;
        assert.match(cycles, /--max-chars=N/);
        assert.doesNotMatch(cycles, /--depth|--direction|--all/);

        for (const command of ['impact', 'trace']) {
            const cli = applyOutputBudget('x\n'.repeat(7000), {
                command, maxChars: 100, surface: 'cli', params: {},
            }).text;
            assert.match(cli, /--file/);
            assert.doesNotMatch(cli, /--in/);

            const mcp = applyOutputBudget('x\n'.repeat(7000), {
                command, maxChars: 100, surface: 'mcp', params: {},
            }).text;
            assert.match(mcp, /file=/);
            assert.doesNotMatch(mcp, /\bin=/);
        }
    });

    it('UCN5-104: gitignore changes immediately invalidate a loaded cache', () => {
        const dir = tmp({
            'package.json': '{}',
            'keep.js': 'function keeper(){}',
            'generated/gen.js': 'function generatedThing(){}',
        });
        const cacheFile = path.join(dir, 'cache', 'index.json');
        try {
            const built = idx(dir);
            saveCache(built, cacheFile);
            const loaded = new ProjectIndex(dir);
            assert.equal(loadCache(loaded, cacheFile), true);
            assert.equal(isCacheStale(loaded), false);
            fs.writeFileSync(path.join(dir, '.gitignore'), 'generated/\n');
            assert.equal(isCacheStale(loaded), true);
        } finally { rm(dir); }
    });

    it('UCN5-105: check gates and rejected plans return non-zero CLI status', () => {
        const dir = tmp({
            'package.json': '{"name":"gate"}',
            'lib.js': 'function greet(name){return name;}\nmodule.exports={greet};',
            'app.js': 'const {greet}=require("./lib");\nfunction main(){return greet("x");}',
        });
        const git = args => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
        const cli = args => spawnSync('node', [CLI_PATH, dir, ...args, '--no-cache'], {
            encoding: 'utf8',
        });
        try {
            assert.equal(git(['init', '-q']).status, 0);
            git(['config', 'user.email', 't@example.com']);
            git(['config', 'user.name', 'Test']);
            git(['add', '-A']);
            assert.equal(git(['commit', '-qm', 'base']).status, 0);
            fs.writeFileSync(path.join(dir, 'lib.js'),
                'function greet(name, punctuation){return name+punctuation;}\nmodule.exports={greet};');
            assert.equal(cli(['check']).status, 1);
            assert.equal(cli(['check', 'greet']).status, 1);
            assert.equal(cli(['plan', 'greet', '--rename-to=class']).status, 1);
            assert.equal(cli(['plan', 'greet', '--remove-param=missing']).status, 1);
        } finally { rm(dir); }
    });

    it('UCN5-106/107/108: C++ qualified calls verify and guidance is surface-correct', () => {
        const dir = tmp({
            'u.h': 'namespace util { int clampi(int v,int lo,int hi); }',
            'u.cpp': '#include "u.h"\nnamespace util { int clampi(int v,int lo,int hi){return v;} }',
            'm.cpp': '#include "u.h"\nint main(){return util::clampi(5,0,3);}',
            'classes.js': [
                'class Alpha { run(x){return x;} }',
                'class Beta { run(x,y){return x+y;} }',
                'function drive(a){return a.run(1);}',
            ].join('\n'),
            'classes.test.js': 'test("run",()=>new Alpha().run(1));',
        });
        try {
            const index = idx(dir);
            const verified = execute(index, 'check', { name: 'clampi' });
            assert.equal(verified.ok, true);
            assert.equal(verified.result.valid, 1);
            assert.equal(verified.result.uncertain, 0);

            const source = execute(index, 'source', { name: 'run', className: 'Beta' });
            assert.equal(source.ok, true);
            assert.equal(source.result.entries[0].match.className, 'Beta');

            const shown = execute(index, 'show', { name: 'run' });
            const cliText = publicOutput.formatPublicText('show', shown.result,
                { name: 'run' }, { surface: 'cli', note: shown.note });
            assert.doesNotMatch(cliText, /(?<!-)(?:\bline|\bfile|\bclass_name|\bclassName)=/);
            assert.match(cliText, /--(?:line|class-name)/);

            const checked = execute(index, 'check', { name: 'run' });
            const mcpText = publicOutput.formatPublicText('check', checked.result,
                { name: 'run' }, { surface: 'mcp', note: checked.note });
            assert.doesNotMatch(mcpText, /className=|--class-name/);
            assert.match(mcpText, /class_name=/);

            const searched = execute(index, 'search', { term: 'run', top: 1 });
            const searchCli = publicOutput.formatPublicText('search', searched.result,
                { term: 'run', top: 1 }, { surface: 'cli' });
            assert.match(searchCli, /--top=N|--include-tests/);
            assert.doesNotMatch(searchCli, /(?<!-)\btop=|include_tests=true/);
        } finally { rm(dir); }
    });

    it('UCN5-109/110/111: deadcode JSON is scoped and compiler contracts are not plain dead claims', () => {
        const dir = tmp({
            'go.mod': 'module example.com/dead\n\ngo 1.21\n',
            'sort.go': [
                'package dead',
                'import "sort"',
                'type Rows []int',
                'func (r Rows) Len() int { return len(r) }',
                'func (r Rows) Less(i,j int) bool { return r[i] < r[j] }',
                'func (r Rows) Swap(i,j int) { r[i],r[j] = r[j],r[i] }',
                'func Run(r Rows){ sort.Sort(r) }',
            ].join('\n'),
            'Model.cs': [
                'public class Model {',
                ' public static bool operator ==(Model a, Model b) => true;',
                ' public static bool operator !=(Model a, Model b) => false;',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const dead = execute(index, 'deadcode', { includeExported: true });
            const swap = dead.result.find(symbol => symbol.name === 'Swap');
            assert.ok(!swap || swap.externalContract === true);
            assert.equal(dead.result.some(symbol => /^operator/.test(symbol.name)), false);
            const json = JSON.parse(publicOutput.formatPublicJson('deadcode', dead.result,
                {}, { surface: 'cli' }));
            assert.equal(json.meta.deletionSafety, 'review-required');
            for (const key of ['excludedExported', 'excludedDecorated',
                'excludedExternalContract', 'excludedDynamicDispatch']) {
                assert.equal(typeof json.meta[key], 'number');
            }
        } finally { rm(dir); }
    });

    it('UCN5-113/114/115: dependency output distinguishes off-index targets and honors global using/all', () => {
        const offDir = tmp({
            'package.json': '{}',
            'amain.js': 'const {zhelper}=require("./zhelper"); function amain(){return zhelper();}',
            'zhelper.js': 'function zhelper(){return 1;} module.exports={zhelper};',
        });
        const csDir = tmp({
            'GlobalUsings.cs': 'global using P.Ev;',
            'Ev/Evt.cs': 'namespace P.Ev; public class Evt { public int N()=>1; }',
            'Core/Log.cs': 'namespace P.Core; public class Log { public int Go(){return new Evt().N();} }',
        });
        const many = { 'root.js': '' };
        for (let i = 0; i < 12; i++) {
            many[`d${i}.js`] = `function d${i}(){}`;
            many['root.js'] += `require("./d${i}");\n`;
        }
        const graphDir = tmp(many);
        try {
            const limited = new ProjectIndex(offDir);
            limited.build([path.join(offDir, 'amain.js')], { quiet: true });
            const detailed = execute(limited, 'deps', {
                file: 'amain.js', direction: 'imports', detailed: true,
            });
            const detailedText = publicOutput.formatPublicText('deps', detailed.result,
                { file: 'amain.js', direction: 'imports', detailed: true }, { surface: 'cli' });
            assert.match(detailedText, /not indexed; absent from dependency graph/);

            const csIndex = idx(csDir);
            const csDeps = execute(csIndex, 'deps', {
                file: 'Core/Log.cs', direction: 'imports', all: true,
            });
            assert.equal(csDeps.result.graph.edges.some(edge =>
                edge.to.endsWith(path.join('Ev', 'Evt.cs'))), true);

            const graph = execute(idx(graphDir), 'deps', {
                file: 'root.js', direction: 'imports',
            });
            const cliDefault = publicOutput.formatPublicText('deps', graph.result,
                { file: 'root.js', direction: 'imports' }, { surface: 'cli' });
            const mcpDefault = publicOutput.formatPublicText('deps', graph.result,
                { file: 'root.js', direction: 'imports' }, { surface: 'mcp' });
            assert.equal((cliDefault.match(/d\d+\.js/g) || []).length,
                (mcpDefault.match(/d\d+\.js/g) || []).length);
            const cliAll = publicOutput.formatPublicText('deps', graph.result,
                { file: 'root.js', direction: 'imports', all: true }, { surface: 'cli' });
            assert.ok((cliAll.match(/d\d+\.js/g) || []).length >
                (cliDefault.match(/d\d+\.js/g) || []).length);
        } finally {
            rm(offDir); rm(csDir); rm(graphDir);
        }
    });

    it('UCN5-116/117/118/119: router identity, hidden entry points, and failures guide agents', () => {
        const dir = tmp({
            'package.json': '{}',
            'users.js': [
                'const express = require("express");',
                'const usersRouter = express.Router();',
                'usersRouter.get("/", handler);',
                'function handler(req,res){}',
            ].join('\n'),
            'routes_test.go': [
                'package routes',
                'import "testing"',
                'func TestRoute(t *testing.T) {}',
            ].join('\n'),
            'symbols.js': 'function parseRequest(i){return i;}',
        });
        try {
            const index = idx(dir);
            const endpoints = execute(index, 'endpoints', {});
            assert.equal(endpoints.result.routes.some(route =>
                route.file === 'users.js' && route.path === '/'), true);
            const endpointsText = publicOutput.formatPublicText('endpoints', endpoints.result,
                {}, { surface: 'cli' });
            assert.match(endpointsText, /Advisory:.*absence is not proof/i);

            const entries = execute(index, 'entrypoints', {});
            assert.ok(entries.result.filterInfo.hiddenTests > 0);
            const entriesText = publicOutput.formatPublicText('entrypoints', entries.result,
                {}, { surface: 'cli', note: entries.note });
            assert.match(entriesText, /test-path entry point.*hidden.*--include-tests/i);
            const entriesJson = JSON.parse(publicOutput.formatPublicJson('entrypoints',
                entries.result, {}, { surface: 'cli', note: entries.note }));
            assert.ok(entriesJson.meta.hiddenTestEntrypoints > 0);

            const typo = execute(index, 'show', { name: 'parseRequst' });
            assert.equal(typo.ok, false);
            assert.match(typo.error, /Did you mean "parseRequest"/);
            assert.match(runCli(dir, 'fn', ['parseRequest']), /use: ucn source/i);
            assert.match(runCli(dir, 'utterly-wrong', []), /ucn --help/);
            assert.doesNotMatch(runCli(dir, 'impact', [], ['--staged']), /diff-impact/);
        } finally { rm(dir); }
    });

    it('UCN5-121/122/123/124/125/126: lookup limits validate and preserve the full inventory', () => {
        const dir = tmp({
            'package.json': '{}',
            'enum.c': 'enum Color { RED, GREEN = 4 };\nint paint(void) { return RED; }',
            'a.js': 'export function target() { return 1; }\nexport class Alpha { run(){} }',
            'b.js': 'export function target() { return 2; }\nexport class Beta { run(){} }',
            'c.js': 'import { target } from "./a.js";\nexport function caller1(){ return target(); }\nexport function caller2(){ return target(); }',
            'a.test.js': 'export function target() { return 3; }',
        });
        try {
            const index = idx(dir);
            const red = execute(index, 'find', { name: 'RED' });
            assert.equal(red.ok, true);
            assert.equal(red.result[0].type, 'field');
            assert.equal(red.result[0].className, 'Color');

            const invalidIn = execute(index, 'find', { name: 'target', in: 'missing' });
            assert.equal(invalidIn.ok, false);
            assert.match(invalidIn.error, /No files matched/);
            const invalidType = execute(index, 'find', { name: 'target', type: 'bogus' });
            assert.equal(invalidType.ok, false);
            assert.match(invalidType.error, /Invalid find type.*Valid types/);

            const found = execute(index, 'find', { name: 'target', limit: 1 });
            const foundText = publicOutput.formatPublicText('find', found.result,
                { name: 'target', limit: 1 }, { surface: 'cli', note: found.note });
            assert.match(foundText, /Found 3 match/);
            assert.match(foundText, /Showing 1 of 3/);

            const scoped = execute(index, 'find', {
                name: 'run', className: 'Alpha', limit: 1,
            });
            const scopedText = publicOutput.formatPublicText('find', scoped.result,
                { name: 'run', className: 'Alpha', limit: 1 }, { surface: 'cli' });
            assert.match(scopedText, /name-wide|other definition/i);

            for (const command of ['show', 'impact', 'trace']) {
                const malformed = execute(index, command, { name: '[Symbol.iterator]' });
                assert.equal(malformed.ok, false, command);
                assert.match(malformed.error, /\[Symbol\.iterator\]/, command);
            }

            const impact = execute(index, 'impact', { name: 'target', file: 'a.js', limit: 1 });
            assert.equal(impact.ok, true);
            assert.equal(impact.result.shownCallSites, 1);
            assert.equal(impact.result.totalCallSites, 2);

            const withTests = execute(index, 'find', {
                name: 'target', includeTests: true,
            });
            assert.equal(withTests.result.length, 3);
            const withoutTests = execute(index, 'find', { name: 'target' });
            assert.equal(withoutTests.result.length, 3);
        } finally { rm(dir); }
    });

    it('UCN5-127/128/130/131/132: MCP schema, no-op notices, budgets, and hints are literal', async () => {
        const dir = tmp({
            'package.json': '{}',
            'lib.js': Array.from({ length: 80 }, (_, i) =>
                `export function item${i}(){ return ${i}; }`).join('\n'),
        });
        const serverSource = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'server.js'), 'utf8');
        assert.match(serverSource, /show_confidence.*default to visible/);
        assert.match(serverSource, /compact.*default/i);
        const client = new McpClient();
        try {
            await client.start();
            await client.initialize();

            const noOp = await client.callTool({
                command: 'impact', project_dir: dir, name: 'item1', include_methods: true,
            });
            assert.match(noOp.text, /include_methods.*no effect|implied no-op/i);

            const capped = await client.callTool({
                command: 'search', project_dir: dir, term: 'function',
                all: true, max_chars: 500,
            });
            assert.match(capped.text, /OUTPUT TRUNCATED/);
            assert.ok(capped.text.length < 5000, `unexpected MCP budget: ${capped.text.length}`);
            assert.doesNotMatch(capped.text, /--top|--include-tests/);

            const budget = applyOutputBudget('x\n'.repeat(1000), {
                command: 'impact', maxChars: 120,
            });
            assert.doesNotMatch(budget.text, /--in/);
        } finally {
            client.stop();
            rm(dir);
        }
    });

    it('UCN5-129/165: MCP rejects an empty root and explicitly scopes subdirectory requests', async () => {
        const dir = tmp({
            'package.json': '{}',
            'src/sub/inside.js': 'export function inside(){}',
            'src/outside.js': 'export function outside(){}',
        });
        const client = new McpClient();
        try {
            await client.start();
            await client.initialize();
            const empty = await client.callTool({ command: 'repo', project_dir: '' });
            assert.match(JSON.stringify(empty), /non-empty path/);

            const scoped = await client.callTool({
                command: 'repo', project_dir: path.join(dir, 'src', 'sub'),
            });
            assert.match(scoped.text, /scoped to src\/sub|results scoped with in=src\/sub/i);
            assert.match(scoped.text, /1 files? · 1 symbols?/);
        } finally {
            client.stop();
            rm(dir);
        }
    });

    it('UCN5-133/134/135/136/138/139/140: repo counts, scopes, and trust stay honest', () => {
        const dir = tmp({
            'package.json': '{}',
            'src/types.ts': [
                'export class Alpha { run(){} }',
                'export class Beta { run(){} }',
                'export function callAlpha(a: Alpha){ a.run(); }',
                'export function callBeta(b: Beta){ b.run(); }',
                'export function extra(){}',
            ].join('\n'),
            'src/more.js': 'export function more(){}',
            'test/types.test.ts': 'import { Alpha } from "../src/types";\nexport function testOnly(a: Alpha){ a.run(); a.run(); a.run(); }',
        });
        try {
            const index = idx(dir);
            const stats = execute(index, 'repo', {
                sections: 'summary', hot: true, top: 20,
            });
            assert.equal(stats.ok, true);
            const runs = stats.result.summary.hot.items.filter(item => item.name.endsWith('.run'));
            assert.equal(runs.length, 2);
            assert.deepEqual(new Set(runs.map(item => item.name)), new Set(['Alpha.run', 'Beta.run']));
            assert.equal(runs.reduce((sum, item) => sum + item.callCount, 0), 2,
                'test-file call sites must not inflate production HOT');

            const files = execute(index, 'repo', {
                sections: 'files', detailed: true, limit: 1,
            });
            assert.equal(files.ok, true);
            assert.equal(files.result.files.files.length, 1);
            assert.ok(files.result.files.hiddenFiles > 0);
            assert.equal(files.result.files.meta.complete, false);
            const first = files.result.files.files[0];
            assert.equal(first.functions,
                (first.symbols.functions || []).length,
                'file totals must describe the full rendered file inventory');

            const scoped = execute(index, 'repo', { in: 'src', sections: 'summary' });
            const scopedText = publicOutput.formatPublicText('repo', scoped.result,
                { in: 'src', sections: 'summary' }, { surface: 'cli' });
            assert.match(scopedText, /scoped to src/);
            assert.equal(execute(index, 'repo', { in: 'nowhere' }).ok, false);

            // Force the known parser-recovery signal to verify that the
            // one-screen TRUST headline cannot omit the reason for PARTIAL.
            index.files.values().next().value.parseRecovery = true;
            const recovery = execute(index, 'repo', { sections: 'summary,health' });
            const recoveryText = publicOutput.formatPublicText('repo', recovery.result,
                { sections: 'summary,health' }, { surface: 'cli' });
            assert.match(recoveryText, /parser-recovery/i);
            assert.match(recoveryText, /PARTIAL/);
        } finally { rm(dir); }
    });

    it('UCN5-137: computed-dispatch analysis is memoized and survives cache round-trip', () => {
        const dir = tmp({
            'package.json': '{}',
            'app.js': 'const handlers = {};\nexport function run(name){ return handlers[name](); }',
        });
        try {
            const index = idx(dir);
            execute(index, 'doctor', {});
            assert.ok(index._computedDispatchBlindspots instanceof Map);
            const before = JSON.stringify([...index._computedDispatchBlindspots]);
            const cachePath = path.join(dir, 'cache-data', 'index.json');
            assert.ok(saveCache(index, cachePath));
            const loaded = new ProjectIndex(dir);
            assert.equal(loadCache(loaded, cachePath), true);
            assert.equal(JSON.stringify([...loaded._computedDispatchBlindspots]), before);
            assert.equal(loaded.computedDispatchDirty, false);
        } finally { rm(dir); }
    });

    it('UCN5-141/142/143: structural search covers public Python and every indexed data kind', () => {
        const dir = tmp({
            'package.json': '{}',
            'mod.py': 'def public_api(): return 1\ndef _private_api(): return 2\nSTATE = 3',
            'defs.c': '#define LIMIT 10\nenum Mode { FAST };\nint field_like = LIMIT;',
            'view.vue': '<template>{{ unsupportedNeedle }}</template>',
        });
        try {
            const index = idx(dir);
            const exported = execute(index, 'search', {
                exported: true,
            });
            assert.equal(exported.ok, true);
            assert.ok(exported.result.results.some(item => item.name === 'public_api'),
                JSON.stringify({
                    result: exported.result,
                    defs: index.symbols.get('public_api'),
                    file: [...index.files.values()].find(entry => entry.language === 'python'),
                }));
            assert.equal(exported.result.results.some(item => item.name === '_private_api'), false);

            for (const type of ['macro', 'field', 'state']) {
                const result = execute(index, 'search', { term: '', type });
                assert.equal(result.ok, true, type);
                assert.ok(result.result.results.length > 0, type);
            }

            const unsupported = execute(index, 'search', { term: 'unsupportedNeedle' });
            assert.equal(unsupported.ok, true);
            assert.match(unsupported.note, /unsupported-language.*grep\/ripgrep/i);
            const json = JSON.parse(publicOutput.formatPublicJson('search',
                unsupported.result, { term: 'unsupportedNeedle' }, {
                    surface: 'cli', note: unsupported.note,
                }));
            assert.ok(json.meta.unsupportedMatches.lines > 0);
        } finally { rm(dir); }
    });

    it('UCN5-144/145/146/147/148/149/150/151/152: show and trace projections remain composable', () => {
        const dir = tmp({
            'package.json': '{}',
            'model.ts': [
                'export interface Widget { id: number }',
                'export function leaf1(): Widget { return { id: 1 }; }',
                'export function leaf2(): Widget { return { id: 2 }; }',
                'export function target(w: Widget): Widget { leaf1(); leaf2(); return w; }',
                'export function c1(){ return target({id:1}); }',
                'export function c2(){ return target({id:2}); }',
                'export class Iter { [Symbol.iterator](){ return this; } }',
            ].join('\n'),
            'kinds.cs': 'public enum Mode { Fast, Slow }\npublic record Point(int X, int Y);',
        });
        try {
            const index = idx(dir);
            const shown = execute(index, 'show', {
                name: 'target', top: 1,
                sections: 'summary,callers,callees,types',
            });
            assert.equal(shown.ok, true);
            assert.equal(shown.result.context.callers.length, 1);
            assert.equal(shown.result.context.callees.length, 1);
            assert.ok(shown.result.context.meta.callerTotal > 1);
            assert.ok(shown.result.context.meta.calleeTotal > 1);
            const shownText = publicOutput.formatPublicText('show', shown.result,
                { name: 'target', top: 1, sections: shown.result.sections.join(',') },
                { surface: 'cli', note: shown.note });
            assert.doesNotMatch(shownText, /undefined:undefined/);

            const withTypes = execute(index, 'show', { name: 'target', withTypes: true });
            assert.equal(withTypes.ok, true);
            assert.ok(withTypes.result.sections.includes('types'));
            assert.ok(withTypes.result.types.types.some(type => type.name === 'Widget'));

            for (const name of ['Mode', 'Point']) {
                const typeShow = execute(index, 'show', { name, sections: 'callers' });
                assert.equal(typeShow.ok, true, name);
                const text = publicOutput.formatPublicText('show', typeShow.result,
                    { name, sections: 'callers' }, { surface: 'cli' });
                assert.doesNotMatch(text, /Context: undefined/, name);
            }

            const originalExample = index.example;
            index.example = () => null;
            const partial = execute(index, 'show', {
                name: 'target', sections: 'summary,example',
            });
            index.example = originalExample;
            assert.equal(partial.ok, true);
            assert.ok(partial.result.summary);
            assert.deepEqual(partial.result.unavailableSections.map(s => s.section), ['example']);

            const missingTests = execute(index, 'tests', { name: 'noSuchSymbol' });
            assert.equal(missingTests.ok, false);
            assert.match(missingTests.error, /not found/i);

            const trace = execute(index, 'trace', {
                name: 'target', direction: 'callees', depth: 1,
            });
            assert.equal(trace.ok, true);
            for (const child of trace.result.tree.children) {
                assert.equal(child.children.length, 0);
                assert.equal((child.unverifiedCallees || []).length, 0);
            }

            const computed = execute(index, 'find', {
                name: '[Symbol.iterator]', exact: true,
            });
            assert.equal(computed.ok, true);
            assert.ok(computed.result.length > 0);
            const computedDef = computed.result[0];
            const handle = `${computedDef.relativePath}:${computedDef.startLine}:${computedDef.name}`;
            const roundTrip = execute(index, 'show', { name: handle });
            assert.equal(roundTrip.ok, true, JSON.stringify(roundTrip));
        } finally { rm(dir); }
    });

    it('UCN5-153/154/155/156/157/159: contract disclosures survive limits and failures', () => {
        const dir = tmp({
            'package.json': '{}',
            'lib.py': [
                'import functools',
                '@functools.cache',
                'def target(): return 1',
                'class Alpha:',
                '    def run(self): return target()',
                'class Beta:',
                '    def run(self): return 2',
            ].join('\n'),
            'lib_test.py': 'from lib import target\ndef test_target(): target()',
        });
        try {
            const index = idx(dir);
            const missingFailed = path.join(dir, 'deleted-caller.py');
            const visibleFailed = path.join(dir, 'failed-caller.py');
            fs.writeFileSync(visibleFailed, 'def caller(): return target()\n');
            index.failedFiles.add(visibleFailed);
            index.failedFiles.add(missingFailed);

            const usages = execute(index, 'usages', { name: 'target' });
            assert.match(usages.note, /unparsed file/i);
            assert.match(usages.note, /unreadable file/i);
            const usageText = publicOutput.formatPublicText('usages', usages.result,
                { name: 'target' }, { surface: 'cli', note: usages.note });
            const capped = applyOutputBudget(usageText, {
                command: 'usages', maxChars: 180,
            });
            assert.match(capped.text, /test-file usage.*hidden by default/i);

            const decorated = execute(index, 'usages', {
                name: 'target', includeTests: true,
            });
            const defs = decorated.result.filter(item => item.isDefinition);
            assert.equal(defs[0].line, 3);
            assert.equal(decorated.result.some(item =>
                item.line === 3 && !item.isDefinition), false);

            const otherDefs = execute(index, 'usages', {
                name: 'run', className: 'Alpha', includeTests: true,
            });
            const otherText = publicOutput.formatPublicText('usages', otherDefs.result,
                { name: 'run', className: 'Alpha' }, { surface: 'cli' });
            assert.match(otherText, /OTHER DEFINITIONS/);
            assert.doesNotMatch(otherText, /REFERENCES:[\s\S]*def run\(self\): return 2/);

            const summaryBudget = applyOutputBudget([
                'header', ...Array.from({ length: 200 }, () => 'detail detail detail'),
                'Summary: 7 entry points reach target',
                'ACCOUNT: conserved',
            ].join('\n'), { command: 'trace', maxChars: 200 });
            assert.match(summaryBudget.text, /Summary: 7 entry points/);

            const workers = runCli(dir, 'find', ['target'], ['--workers=1']);
            assert.doesNotMatch(workers, /--workers has no effect/);
        } finally { rm(dir); }
    });

    it('UCN5-120/158: help documents exit semantics and bounded global cache cleanup', () => {
        const dir = tmp({
            'package.json': '{}',
            'app.js': 'export function target(){}',
        });
        const cacheRoot = path.join(dir, 'user-cache');
        try {
            const help = spawnSync('node', [CLI_PATH, '--help'], {
                encoding: 'utf8',
            }).stdout;
            assert.match(help, /Exit codes?:/i);
            assert.match(help, /0.*success/i);
            assert.match(help, /1.*finding|issues|unsafe/i);
            assert.match(help, /2.*could not run|usage|operational/i);
            assert.match(help, /--clear-cache --all/);

            const env = { ...process.env, UCN_CACHE_DIR: cacheRoot };
            const warm = spawnSync('node', [CLI_PATH, dir, 'find', 'target'], {
                encoding: 'utf8', env,
            });
            assert.equal(warm.status, 0);
            assert.equal(fs.existsSync(cacheRoot), true);
            const clear = spawnSync('node', [CLI_PATH, '--clear-cache', '--all'], {
                cwd: dir, encoding: 'utf8', env,
            });
            assert.equal(clear.status, 0);
            assert.match(clear.stdout, /All UCN user caches cleared/i);
        } finally { rm(dir); }
    });

    it('UCN5-160/163/168/169: CLI and interactive lookup guidance is copy-pasteable', () => {
        const dir = tmp({
            'package.json': '{}',
            'lib.ts': [
                'export function target(){}',
                'export function generic<',
                '  Input extends string,',
                '  Output extends Input = Input,',
                '>(value: Input): Output { return value as Output; }',
                ...Array.from({ length: 8 }, (_, i) => `const match${i} = "needle";`),
            ].join('\n'),
            'lib.test.ts': 'import { target } from "./lib";\ntarget();',
        });
        try {
            const cli = runCli(dir, 'search', ['target']);
            assert.match(cli, /--include-tests/);
            assert.doesNotMatch(cli, /include_tests=true/);
            const limited = runCli(dir, 'search', ['needle'], ['--limit=2']);
            assert.match(limited, /Found 8 matches.*showing 2/);
            assert.match(limited, /--top=N/);
            assert.doesNotMatch(limited, /Use top=/);

            const interactive = runInteractive(dir, ['search target']);
            assert.match(interactive, /--include-tests/);
            assert.doesNotMatch(interactive, /include_tests=true/);

            const compact = runCli(dir, 'find', ['generic'], ['--compact']);
            assert.match(compact, /generic<[^\n]*Output extends Input = Input[^\n]*>/);
            assert.doesNotMatch(compact, /generic<\n/);
        } finally { rm(dir); }
    });

    it('UCN5-162/167: endpoint and Go import labels describe what was actually parsed', () => {
        const pyDir = tmp({
            'app.py': [
                'def load(session):',
                '    user = session.get("user_id")',
                '    response = session.get("/api/users")',
                '    return user, response',
            ].join('\n'),
        });
        const goDir = tmp({
            'go.mod': 'module example.test/p\n\ngo 1.22',
            'main.go': 'package main\nimport (\n . "fmt"\n _ "embed"\n)\nfunc main(){ Println("x") }',
        });
        try {
            const endpoints = execute(idx(pyDir), 'endpoints', { clientOnly: true });
            assert.equal(endpoints.ok, true);
            assert.equal(endpoints.result.requests.some(r => r.path === 'user_id'), false);
            assert.equal(endpoints.result.requests.some(r => r.path === '/api/users'), true);

            const repo = execute(idx(goDir), 'repo', { sections: 'summary,health' });
            const text = publicOutput.formatPublicText('repo', repo.result,
                { sections: 'summary,health' }, { surface: 'cli' });
            assert.match(text, /blank\/dot import|blank\/dot imports/i);
            assert.doesNotMatch(text, /dynamic import/i);
        } finally {
            rm(pyDir);
            rm(goDir);
        }
    });

    it('UCN5-166: plan counts only concrete edits and partitions every change once', () => {
        const dir = tmp({
            'package.json': '{"type":"module"}',
            'core.js': 'export function transform(input) { return input * 2; }',
            'alias.js': 'import { transform as xf } from "./core.js";\nexport function use(){ return xf(1); }\nexport function use2(){ return xf(2); }',
        });
        try {
            const index = idx(dir);
            const add = execute(index, 'plan', {
                name: 'transform', addParam: 'mode', defaultValue: 'false',
            });
            assert.equal(add.ok, true);
            assert.equal(add.result.totalChanges, 1);
            assert.equal(add.result.unchangedSites, 2);
            assert.equal(add.result.changes.some(c => /No change needed/.test(c.suggestion)), false);

            const rename = execute(index, 'plan', {
                name: 'transform', renameTo: 'convert',
            });
            assert.equal(rename.ok, true);
            const s = rename.result.changeSummary;
            assert.equal(s.definitions + s.calls + s.imports + s.exports,
                rename.result.totalChanges);
            const text = publicOutput.formatPublicText('plan', add.result,
                { name: 'transform' }, { surface: 'cli' });
            assert.match(text, /core\.js \(1 change\)/);
        } finally { rm(dir); }
    });

    it('UCN5-170/171: macros and data members never masquerade as callables', () => {
        const dir = tmp({
            'defs.c': '#define MAXN 10\n#define ADD(x) ((x)+1)\nint use(void){ return ADD(MAXN); }',
            'Config.cs': 'public class Config { public string Name { get; set; } = "x"; }',
        });
        try {
            const index = idx(dir);
            const macro = execute(index, 'show', { name: 'MAXN', sections: 'summary' });
            const macroText = publicOutput.formatPublicText('show', macro.result,
                { name: 'MAXN', sections: 'summary' }, { surface: 'cli' });
            assert.match(macroText, /^MAXN$/m);
            assert.doesNotMatch(macroText, /MAXN\(/);

            const fnMacro = execute(index, 'show', { name: 'ADD', sections: 'summary' });
            const fnMacroText = publicOutput.formatPublicText('show', fnMacro.result,
                { name: 'ADD', sections: 'summary' }, { surface: 'cli' });
            assert.match(fnMacroText, /ADD\(x\)/);

            const field = execute(index, 'show', {
                name: 'Name', className: 'Config', sections: 'summary',
            });
            const fieldText = publicOutput.formatPublicText('show', field.result,
                { name: 'Name', sections: 'summary' }, { surface: 'cli' });
            assert.match(fieldText, /public Name: string/);
            assert.doesNotMatch(fieldText, /Name\(|async:|complexity:/);
        } finally { rm(dir); }
    });

    it('UCN5-172: Rust stack frame names survive split-line backtraces', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname="rs"\nversion="0.1.0"',
            'src/main.rs': 'fn inner() { panic!("boom"); }\nfn run() { inner(); }\nfn main() { run(); }',
        });
        try {
            const stack = [
                'stack backtrace:',
                '   3: rs::run',
                '             at ./src/main.rs:2:12',
                '   4: rs::main',
                '             at ./src/main.rs:3:13',
            ].join('\n');
            const result = execute(idx(dir), 'stacktrace', { stack });
            assert.equal(result.ok, true);
            assert.equal(result.result.frames[0].function, 'rs::run');
            const text = publicOutput.formatPublicText('stacktrace', result.result,
                { stack }, { surface: 'cli' });
            assert.match(text, /rs::run/);
            assert.doesNotMatch(text, /Frame 0: \(anonymous\)/);

            const skipped = output.formatStackTrace({
                frameCount: 1,
                frames: [{ function: 'run', file: 'node:internal/x', line: 1, found: false, raw: 'at run' }],
                skippedFrames: 2,
            });
            assert.match(skipped, /outside the indexed project/);
            assert.doesNotMatch(skipped, /without file:line/);
        } finally { rm(dir); }
    });

    it('UCN5-173: recursion is accounted separately from external blast impact', () => {
        const dir = tmp({
            'package.json': '{}',
            'cyc.js': 'export function selfRec(n) { return n <= 0 ? 0 : selfRec(n - 1); }',
        });
        try {
            const index = idx(dir);
            const blast = execute(index, 'trace', {
                name: 'selfRec', direction: 'callers', depth: 3,
            });
            assert.equal(blast.ok, true);
            assert.equal(blast.result.summary.totalAffected, 0);
            assert.equal(blast.result.summary.selfRecursive, true);
            assert.equal(blast.result.tree.children.length, 0);
            assert.equal(blast.result.treeAccount.confirmedEdges, 0);
            assert.equal(blast.result.treeAccount.recursiveEdges, 1);
            const text = publicOutput.formatPublicText('trace', blast.result,
                { name: 'selfRec', direction: 'callers' }, { surface: 'cli' });
            assert.match(text, /No external callers found.*self-recursive/i);
            assert.doesNotMatch(text, /root\/entry point/);

            const reverse = execute(index, 'trace', {
                name: 'selfRec', direction: 'callers', to: 'entrypoints', depth: 3,
            });
            assert.equal(reverse.ok, true);
            assert.equal(reverse.result.entryPoints.length, 0);
            assert.equal(reverse.result.summary.selfRecursive, true);
        } finally { rm(dir); }
    });
});
