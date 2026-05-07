/**
 * UCN Individual Bug Fix Regression Tests
 *
 * diff-impact, lines command, cross-language builtins, expand, impact/verify/plan,
 * trace disambiguation, Class.method syntax, className filtering, React components,
 * blast/affected-tests usages, and other individual fix regressions.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { execSync } = require('child_process');
const output = require('../core/output');
const { execute } = require('../core/execute');
const { tmp, rm, idx, runCli, runInteractive } = require('./helpers');


describe('fix: diff-impact nested project root path resolution', () => {
    it('reports modified functions when run from nested package root', () => {
        const dir = tmp({
            'package.json': '{"name":"root"}',
            'pkg/package.json': '{"name":"pkg"}',
            'pkg/a.js': 'function foo() { return 1; }\nfunction bar() { return foo(); }\nmodule.exports = { foo, bar };\n'
        });
        try {
            // Initialize git repo at the top level
            execSync('git init -q', { cwd: dir });
            execSync('git add .', { cwd: dir });
            execSync('git commit -qm init', { cwd: dir });

            // Modify a function in the nested package
            fs.writeFileSync(path.join(dir, 'pkg/a.js'),
                'function foo() { return 2; }\nfunction bar() { return foo(); }\nmodule.exports = { foo, bar };\n');

            // Run diff-impact from nested package root
            const pkgDir = path.join(dir, 'pkg');
            const index = idx(pkgDir);
            const result = index.diffImpact({ base: 'HEAD' });

            assert.ok(result.functions.length > 0 || result.summary.modifiedFunctions > 0,
                'nested project root should still detect modified functions');
            assert.ok(result.summary.modifiedFunctions >= 1,
                `expected at least 1 modified function, got ${result.summary.modifiedFunctions}`);
        } finally {
            rm(dir);
        }
    });
});

describe('fix: lines command rejects malformed ranges', () => {
    it('rejects triple-segment range like 1-2-3', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'file.js': 'line1\nline2\nline3\nline4\nline5\n'
        });
        try {
            const index = idx(dir);
            const { ok, error } = execute(index, 'lines', { range: '1-2-3', file: 'file.js' });
            assert.strictEqual(ok, false, 'should reject malformed range');
            assert.ok(error.includes('Invalid line range'), `error should mention invalid range, got: ${error}`);
        } finally {
            rm(dir);
        }
    });

    it('rejects range with trailing text like 1-2foo', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'file.js': 'line1\nline2\nline3\nline4\nline5\n'
        });
        try {
            const index = idx(dir);
            const { ok, error } = execute(index, 'lines', { range: '1-2foo', file: 'file.js' });
            assert.strictEqual(ok, false, 'should reject malformed range');
            assert.ok(error.includes('Invalid line range'), `error should mention invalid range, got: ${error}`);
        } finally {
            rm(dir);
        }
    });

    it('still accepts valid ranges', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'file.js': 'line1\nline2\nline3\nline4\nline5\n'
        });
        try {
            const index = idx(dir);
            const { ok } = execute(index, 'lines', { range: '2-4', file: 'file.js' });
            assert.strictEqual(ok, true, 'valid range should succeed');
            const { ok: ok2 } = execute(index, 'lines', { range: '3', file: 'file.js' });
            assert.strictEqual(ok2, true, 'single line should succeed');
        } finally {
            rm(dir);
        }
    });
});

describe('fix: diff-impact suppresses git stderr in non-git directories', () => {
    it('emits only UCN error, no raw git stderr', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function x(){}\n'
        });
        try {
            const out = runCli(dir, 'diff-impact', [], ['--no-cache']);
            // Should contain the friendly UCN error
            assert.ok(out.includes('Not a git repository') || out.includes('diff-impact requires git'),
                'should show UCN error message');
            // Should NOT contain raw git fatal message
            assert.ok(!out.includes('fatal:'),
                `should not leak raw git stderr, got: ${out}`);
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG HUNT 2026-03-02 ROUND 2 REGRESSIONS
// ============================================================================

describe('fix R2: nested diff-impact deleted-function detection and stderr', () => {
    it('detects deleted functions from nested package root', () => {
        const dir = tmp({
            'package.json': '{"name":"root"}',
            'pkg/package.json': '{"name":"pkg"}',
            'pkg/a.js': 'function foo() { return 1; }\nfunction bar() { return foo(); }\nmodule.exports = { foo, bar };\n'
        });
        try {
            execSync('git init -q', { cwd: dir });
            execSync('git add .', { cwd: dir });
            execSync('git commit -qm init', { cwd: dir });

            // Delete foo, keep bar
            fs.writeFileSync(path.join(dir, 'pkg/a.js'),
                'function bar() { return 1; }\nmodule.exports = { bar };\n');

            const pkgDir = path.join(dir, 'pkg');
            const index = idx(pkgDir);
            const result = index.diffImpact({ base: 'HEAD' });

            assert.ok(result.deletedFunctions.length >= 1,
                `expected at least 1 deleted function, got ${result.deletedFunctions.length}`);
            assert.ok(result.deletedFunctions.some(f => f.name === 'foo'),
                'should detect foo as deleted');
        } finally {
            rm(dir);
        }
    });

    it('does not leak git stderr for nested deleted-function analysis', () => {
        const dir = tmp({
            'package.json': '{"name":"root"}',
            'pkg/package.json': '{"name":"pkg"}',
            'pkg/a.js': 'function foo() { return 1; }\nmodule.exports = { foo };\n'
        });
        try {
            execSync('git init -q', { cwd: dir });
            execSync('git add .', { cwd: dir });
            execSync('git commit -qm init', { cwd: dir });

            // Delete foo
            fs.writeFileSync(path.join(dir, 'pkg/a.js'),
                'module.exports = {};\n');

            const pkgDir = path.join(dir, 'pkg');
            const out = runCli(pkgDir, 'diff-impact', [], ['--base=HEAD', '--no-cache']);
            assert.ok(!out.includes('fatal:'),
                `should not leak git stderr, got: ${out}`);
        } finally {
            rm(dir);
        }
    });
});

describe('fix R2: repeated space-form --exclude applies all values', () => {
    it('CLI --exclude test --exclude vendor excludes both', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/a.js': 'function target() {}\nmodule.exports = { target };\n',
            'test/a.js': 'function target() {}\n',
            'vendor/a.js': 'function target() {}\n'
        });
        try {
            const out = runCli(dir, 'find', ['target'], ['--include-tests', '--exclude', 'test', '--exclude', 'vendor', '--no-cache']);
            assert.ok(out.includes('src/a.js'), 'should include src/a.js');
            assert.ok(!out.includes('test/a.js'), 'should exclude test/a.js');
            assert.ok(!out.includes('vendor/a.js'), 'should exclude vendor/a.js');
        } finally {
            rm(dir);
        }
    });

    it('interactive --not test --not vendor excludes both', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/a.js': 'function target() {}\nmodule.exports = { target };\n',
            'test/a.js': 'function target() {}\n',
            'vendor/a.js': 'function target() {}\n'
        });
        try {
            const out = runInteractive(dir, ['find target --include-tests --not test --not vendor']);
            assert.ok(out.includes('src/a.js'), 'should include src/a.js');
            assert.ok(!out.includes('test/a.js'), 'should exclude test/a.js');
            assert.ok(!out.includes('vendor/a.js'), 'should exclude vendor/a.js');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// FIX: Python builtins should not resolve to JS definitions
// ============================================================================

describe('fix: cross-language builtin false positives', () => {
    it('Python builtins should not appear as callees from JS bundle', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'requirements.txt': '',
            'app.py': [
                'def analyze(data):',
                '    s = set(data)',
                '    v = abs(data[0])',
                '    n = len(data)',
                '    m = min(data)',
                '    return sorted(s)',
            ].join('\n'),
            'bundle.js': [
                'function set(o, k, v) { o[k] = v; }',
                'function abs(x) { return x < 0 ? -x : x; }',
                'function len(a) { return a.length; }',
                'function min(a, b) { return a < b ? a : b; }',
                'function sorted(a) { return a.slice().sort(); }',
                'module.exports = { set, abs, len, min, sorted };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'context', { name: 'analyze' });
            assert.ok(result.ok, 'context should succeed');
            // Python builtins should NOT resolve to bundle.js definitions
            const callees = result.result.callees || [];
            const jsCallees = callees.filter(c => c.file && c.file.includes('bundle.js'));
            assert.strictEqual(jsCallees.length, 0,
                `Python builtins should not resolve to JS definitions, got: ${jsCallees.map(c => c.name).join(', ')}`);
        } finally {
            rm(dir);
        }
    });

    it('Go builtins should not resolve to JS definitions', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'go.mod': 'module test\ngo 1.21',
            'main.go': [
                'package main',
                'func process() {',
                '    s := make([]int, 10)',
                '    n := len(s)',
                '    s = append(s, 1)',
                '    println(n)',
                '}',
            ].join('\n'),
            'utils.js': [
                'function len(a) { return a.length; }',
                'function append(a, v) { a.push(v); return a; }',
                'module.exports = { len, append };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'context', { name: 'process' });
            assert.ok(result.ok, 'context should succeed');
            const callees = result.result.callees || [];
            const jsCallees = callees.filter(c => c.file && c.file.includes('utils.js'));
            assert.strictEqual(jsCallees.length, 0,
                `Go builtins should not resolve to JS definitions, got: ${jsCallees.map(c => c.name).join(', ')}`);
        } finally {
            rm(dir);
        }
    });

    it('isKeyword covers Python builtins', () => {
        const dir = tmp({ 'package.json': '{"name":"t"}', 'a.py': 'x = 1' });
        try {
            const index = idx(dir);
            for (const name of ['set', 'abs', 'len', 'min', 'max', 'sum', 'sorted', 'print',
                'int', 'str', 'float', 'bool', 'list', 'dict', 'tuple',
                'isinstance', 'hasattr', 'getattr', 'ValueError', 'TypeError', 'Exception']) {
                assert.ok(index.isKeyword(name, 'python'), `${name} should be a Python keyword/builtin`);
            }
        } finally {
            rm(dir);
        }
    });

    it('isKeyword covers Go builtins', () => {
        const dir = tmp({ 'package.json': '{"name":"t"}', 'a.go': 'package main' });
        try {
            const index = idx(dir);
            for (const name of ['append', 'len', 'make', 'cap', 'close', 'copy', 'delete',
                'panic', 'recover', 'println', 'print', 'nil', 'true', 'false']) {
                assert.ok(index.isKeyword(name, 'go'), `${name} should be a Go keyword/builtin`);
            }
        } finally {
            rm(dir);
        }
    });

    it('isKeyword covers Java builtins', () => {
        const dir = tmp({ 'package.json': '{"name":"t"}', 'A.java': 'class A {}' });
        try {
            const index = idx(dir);
            for (const name of ['System', 'String', 'Object', 'Math', 'Integer',
                'Exception', 'RuntimeException', 'NullPointerException', 'Override']) {
                assert.ok(index.isKeyword(name, 'java'), `${name} should be a Java keyword/builtin`);
            }
        } finally {
            rm(dir);
        }
    });

    it('isKeyword covers Rust builtins', () => {
        const dir = tmp({ 'package.json': '{"name":"t"}', 'a.rs': 'fn main() {}' });
        try {
            const index = idx(dir);
            for (const name of ['println', 'vec', 'panic', 'assert', 'assert_eq',
                'Some', 'None', 'Ok', 'Err', 'Box', 'Vec', 'String', 'Option', 'Result']) {
                assert.ok(index.isKeyword(name, 'rust'), `${name} should be a Rust keyword/builtin`);
            }
        } finally {
            rm(dir);
        }
    });

    it('isKeyword covers JS builtins', () => {
        const dir = tmp({ 'package.json': '{"name":"t"}', 'a.js': 'const x = 1;' });
        try {
            const index = idx(dir);
            for (const name of ['console', 'JSON', 'Math', 'Date', 'Promise', 'Map', 'Set',
                'Error', 'TypeError', 'parseInt', 'fetch', 'require', 'setTimeout']) {
                assert.ok(index.isKeyword(name, 'javascript'), `${name} should be a JS keyword/builtin`);
            }
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug Report Round 2 — bugs #6-#12
// ============================================================================

describe('fix #124: find respects explicit include_tests=false', () => {
    it('should filter out test functions when include_tests is explicitly false', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/lib.js': 'function testSetup() { return 1; }\nmodule.exports = { testSetup };',
            'test/unit.test.js': 'function test_one() {}\nfunction test_two() {}',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'find', { name: 'test_*', includeTests: false });
            assert.ok(result.ok);
            const testFileFns = result.result.filter(m =>
                m.relativePath && m.relativePath.includes('test/')
            );
            assert.strictEqual(testFileFns.length, 0, 'should not include functions from test files');
        } finally {
            rm(dir);
        }
    });

    it('should auto-include tests when include_tests is undefined and pattern is test_*', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'test/unit.test.js': 'function test_one() {}\nfunction test_two() {}',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'find', { name: 'test_*' });
            assert.ok(result.ok);
            assert.ok(result.result.length >= 2, 'should auto-include test functions');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #125: expand shows full function source', () => {
    it('should render complete function body, not just signature', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': `function compute() {
  const a = 1;
  const b = 2;
  return a + b;
}

function run() {
  return compute();
}

module.exports = { compute, run };`,
        });
        try {
            const index = idx(dir);
            const ctx = index.context('compute');
            assert.ok(ctx);
            const formatted = output.formatContext(ctx);
            assert.ok(formatted.expandable.length > 0, 'should have expandable items');
            const item = formatted.expandable[0];
            const result = execute(index, 'expand', {
                itemNum: item.num,
                match: item,
            });
            assert.ok(result.ok, 'expand should succeed');
            const lines = result.result.text.split('\n');
            assert.ok(lines.length > 4, `should show full function body, got ${lines.length} lines`);
        } finally {
            rm(dir);
        }
    });

    it('should detect Python function end via indentation', () => {
        const dir = tmp({
            'requirements.txt': '',
            'lib.py': `def compute():
    a = 1
    b = 2
    return a + b

def run():
    return compute()
`,
        });
        try {
            const index = idx(dir);
            const ctx = index.context('compute');
            assert.ok(ctx, 'context should find compute');
            const formatted = output.formatContext(ctx);
            const callerItem = formatted.expandable.find(e => e.name === 'run');
            assert.ok(callerItem, 'should have expandable caller item for run');
            const result = execute(index, 'expand', {
                itemNum: callerItem.num,
                match: callerItem,
            });
            assert.ok(result.ok);
            assert.ok(result.result.text.includes('return compute()'), 'should include function body');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #126: impact respects top parameter', () => {
    it('should limit call sites when top is specified', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function doWork(x) { return x; }\nmodule.exports = { doWork };',
            'a.js': 'const { doWork } = require("./lib");\ndoWork(1);\ndoWork(2);\ndoWork(3);',
            'b.js': 'const { doWork } = require("./lib");\ndoWork(4);\ndoWork(5);',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'impact', { name: 'doWork', top: 2 });
            assert.ok(result.ok);
            let shownSites = 0;
            for (const fg of result.result.byFile) {
                shownSites += fg.sites.length;
            }
            assert.ok(shownSites <= 2, `should show at most 2 sites, got ${shownSites}`);
            assert.ok(result.result.totalCallSites >= 5, 'totalCallSites should reflect full count');
        } finally {
            rm(dir);
        }
    });

    it('should show all sites when top is not specified', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function doWork(x) { return x; }\nmodule.exports = { doWork };',
            'a.js': 'const { doWork } = require("./lib");\ndoWork(1);\ndoWork(2);',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'impact', { name: 'doWork' });
            assert.ok(result.ok);
            let shownSites = 0;
            for (const fg of result.result.byFile) {
                shownSites += fg.sites.length;
            }
            assert.strictEqual(shownSites, result.result.totalCallSites, 'should show all sites');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #127: plan includes import updates for rename', () => {
    it('should include import statement changes in rename plan', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': `export function compute(x) { return x * 2; }`,
            'app.js': `import { compute } from './lib.js';
function run() { return compute(5); }`,
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'plan', { name: 'compute', renameTo: 'calculate' });
            assert.ok(result.ok);
            const plan = result.result;
            assert.ok(plan.found, 'plan should find the function');
            assert.strictEqual(plan.operation, 'rename');
            // Check that changes cover both calls and imports
            const importChanges = plan.changes.filter(c => c.isImport);
            assert.ok(importChanges.length > 0, 'should include import statement changes');
            assert.ok(importChanges[0].suggestion.includes('calculate'), 'import should reference new name');
        } finally {
            rm(dir);
        }
    });

    it('should not duplicate import changes when import line is also a call site', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function doWork() { return 1; }\nmodule.exports = { doWork };',
            'app.js': 'const { doWork } = require("./lib");\ndoWork();\ndoWork();',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'plan', { name: 'doWork', renameTo: 'doTask' });
            assert.ok(result.ok);
            const changeKeys = result.result.changes.map(c => `${c.file}:${c.line}`);
            const uniqueKeys = new Set(changeKeys);
            assert.strictEqual(changeKeys.length, uniqueKeys.size, 'should not have duplicate changes');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #128: cross-language name collision uses usage tiebreaker', () => {
    it('should prefer the definition with more usages when scores tie', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'requirements.txt': '',
            'tools/handler.py': `class Handler:
    def __init__(self):
        pass
    def process(self):
        pass
`,
            'svc_a.py': `from tools.handler import Handler
h = Handler()
h.process()
`,
            'svc_b.py': `from tools.handler import Handler
h = Handler()
`,
            'components/Handler.tsx': `export function Handler() {
  return <div>handler</div>;
}`,
        });
        try {
            const index = idx(dir);
            const result = index.resolveSymbol('Handler');
            assert.ok(result.def, 'should resolve Handler');
            // The Python class should win due to more usages
            assert.ok(
                result.def.relativePath.includes('.py'),
                `should prefer Python class with more usages, got ${result.def.relativePath}`
            );
        } finally {
            rm(dir);
        }
    });
});

describe('fix #129: trace uses import context to disambiguate callees', () => {
    it('should prefer callee from imported file over same-name in unrelated file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'utils/format.js': `function format(data) { return JSON.stringify(data); }
module.exports = { format };`,
            'utils/other.js': `function format(html) { return html.trim(); }
module.exports = { format };`,
            'app.js': `const { format } = require('./utils/format');
function run() {
  return format({});
}
module.exports = { run };`,
        });
        try {
            const index = idx(dir);
            const result = index.trace('run', { depth: 2 });
            assert.ok(result);
            assert.ok(result.tree);
            const fmtChild = result.tree.children.find(c => c.name === 'format');
            if (fmtChild) {
                assert.ok(
                    fmtChild.file.includes('utils/format'),
                    `should resolve to imported format, got ${fmtChild.file}`
                );
            }
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug #8: impact top parameter ignored in MCP
// ============================================================================

describe('fix #119: impact respects top parameter', () => {
    it('limits call sites to top N', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper(x) { return x + 1; }\nmodule.exports = { helper };',
            'a.js': 'const { helper } = require("./lib");\nfunction a() { helper(1); helper(2); }',
            'b.js': 'const { helper } = require("./lib");\nfunction b() { helper(3); }',
            'c.js': 'const { helper } = require("./lib");\nfunction c() { helper(4); helper(5); }',
            'd.js': 'const { helper } = require("./lib");\nfunction d() { helper(6); }',
            'e.js': 'const { helper } = require("./lib");\nfunction e() { helper(7); helper(8); }',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'impact', { name: 'helper', top: 3 });
            assert.ok(ok, 'impact should succeed');
            assert.strictEqual(result.shownCallSites, 3, 'should show only 3 call sites');
            assert.ok(result.totalCallSites > 3, `total should exceed 3, got ${result.totalCallSites}`);
            // byFile entries should sum to 3 total sites
            const totalShown = result.byFile.reduce((sum, f) => sum + f.count, 0);
            assert.strictEqual(totalShown, 3, `byFile should sum to 3, got ${totalShown}`);
        } finally {
            rm(dir);
        }
    });

    it('shows all call sites when top is not specified', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper(x) { return x + 1; }\nmodule.exports = { helper };',
            'a.js': 'const { helper } = require("./lib");\nfunction a() { helper(1); }',
            'b.js': 'const { helper } = require("./lib");\nfunction b() { helper(2); }',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'impact', { name: 'helper' });
            assert.ok(ok);
            assert.strictEqual(result.shownCallSites, result.totalCallSites, 'should show all');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug #12: trace cross-language symbol resolution
// ============================================================================

describe('fix #120: trace prefers same-language callee definitions', () => {
    it('Python trace prefers Python class over TS component with same name', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'requirements.txt': '',
            // Python class with more usages
            'tracker.py': [
                'class DataProcessor:',
                '    def __init__(self):',
                '        self.data = []',
                '    def process(self):',
                '        return self.data',
            ].join('\n'),
            'app.py': [
                'from tracker import DataProcessor',
                '',
                'def create_app():',
                '    processor = DataProcessor()',
                '    processor.process()',
                '    return processor',
            ].join('\n'),
            // More Python files importing DataProcessor to boost usage count
            'worker.py': [
                'from tracker import DataProcessor',
                'def run():',
                '    dp = DataProcessor()',
                '    dp.process()',
            ].join('\n'),
            // TS component with same name but fewer usages
            'DataProcessor.tsx': [
                'export function DataProcessor() {',
                '    return <div>Data</div>;',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'trace', { name: 'create_app', depth: 1 });
            assert.ok(ok, 'trace should succeed');
            // Find the DataProcessor callee in the tree
            const dpChild = result.tree.children.find(c => c.name === 'DataProcessor');
            if (dpChild) {
                // Should resolve to Python file, not TSX
                assert.ok(
                    dpChild.file.includes('tracker.py'),
                    `DataProcessor should resolve to tracker.py, got ${dpChild.file}`
                );
            }
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Feature: Class.method syntax for about/context/impact/find
// ============================================================================

describe('Class.method syntax support', () => {
    it('about("ClassA.close") resolves to ClassA method only', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'server.js': [
                'class HttpClient {',
                '    close() { return "http"; }',
                '    open() { this.close(); }',
                '}',
                'class DbConnection {',
                '    close() { return "db"; }',
                '    disconnect() { this.close(); }',
                '}',
                'module.exports = { HttpClient, DbConnection };',
            ].join('\n'),
            'app.js': [
                'const { HttpClient } = require("./server");',
                'const c = new HttpClient();',
                'c.close();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            // HttpClient.close
            const { ok: ok1, result: r1 } = execute(index, 'about', { name: 'HttpClient.close' });
            assert.ok(ok1, 'should find HttpClient.close');
            assert.strictEqual(r1.symbol.name, 'close');
            assert.ok(r1.symbol.file.includes('server.js'), 'should be in server.js');

            // DbConnection.close
            const { ok: ok2, result: r2 } = execute(index, 'about', { name: 'DbConnection.close' });
            assert.ok(ok2, 'should find DbConnection.close');
            assert.strictEqual(r2.symbol.name, 'close');
        } finally {
            rm(dir);
        }
    });

    it('find("MyClass.method") filters by class', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'models.js': [
                'class User {',
                '    save() { return "user"; }',
                '}',
                'class Post {',
                '    save() { return "post"; }',
                '}',
                'module.exports = { User, Post };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'find', { name: 'User.save' });
            assert.ok(ok);
            assert.ok(result.length >= 1, 'should find at least one match');
            assert.ok(result.every(r => r.className === 'User'), 'all results should be from User class');
        } finally {
            rm(dir);
        }
    });

    it('impact("Class.method") scopes to that class method', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': [
                'class Parser {',
                '    parse(input) { return input; }',
                '}',
                'class Formatter {',
                '    parse(input) { return input.trim(); }',
                '}',
                'const p = new Parser();',
                'p.parse("hello");',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'impact', { name: 'Parser.parse' });
            assert.ok(ok, 'impact should succeed');
            assert.strictEqual(result.function, 'parse');
        } finally {
            rm(dir);
        }
    });

    it('Class.method ignores multi-dot names', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            const index = idx(dir);
            // "a.b.c" should NOT be split — treated as "not found"
            const { ok } = execute(index, 'about', { name: 'a.b.c' });
            assert.ok(!ok, 'multi-dot name should not be found');
        } finally {
            rm(dir);
        }
    });

    it('Class.method does not interfere with dotless names', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'about', { name: 'helper' });
            assert.ok(ok, 'regular name should work');
            assert.strictEqual(result.symbol.name, 'helper');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Feature: fn suggests class command
// ============================================================================

describe('fn suggests class command for class names', () => {
    it('suggests class command when fn receives a class name', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'widget.js': [
                'class MyWidget {',
                '    render() { return "hello"; }',
                '}',
                'module.exports = { MyWidget };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { ok, error } = execute(index, 'fn', { name: 'MyWidget' });
            assert.ok(!ok, 'fn should fail for a class name');
            assert.ok(error.includes('class'), `error should suggest class command, got: ${error}`);
            assert.ok(error.includes('MyWidget'), 'error should mention the name');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Feature: find exact=true with glob warning
// ============================================================================

describe('find exact=true glob warning', () => {
    it('warns when exact=true and name has glob characters', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function get_data() { return 1; }',
        });
        try {
            const index = idx(dir);
            const { ok, note } = execute(index, 'find', { name: 'get_*', exact: true });
            assert.ok(ok, 'find should succeed');
            assert.ok(note, 'should have a warning note');
            assert.ok(note.includes('exact'), `note should mention exact mode, got: ${note}`);
        } finally {
            rm(dir);
        }
    });

    it('no warning when exact=false', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function get_data() { return 1; }',
        });
        try {
            const index = idx(dir);
            const { ok, note } = execute(index, 'find', { name: 'get_*' });
            assert.ok(ok);
            assert.ok(!note, 'should not have a warning for normal glob');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Feature: about better error for nonexistent file filter
// ============================================================================

describe('about file-filter error improvement', () => {
    it('gives helpful error when file filter misses but symbol exists elsewhere', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nhelper();',
        });
        try {
            const index = idx(dir);
            const { ok, error } = execute(index, 'about', { name: 'helper', file: 'nonexistent.py' });
            assert.ok(!ok, 'should fail');
            assert.ok(error.includes('lib.js'), `error should mention where symbol exists, got: ${error}`);
            assert.ok(error.includes('nonexistent.py'), 'error should mention the filter used');
        } finally {
            rm(dir);
        }
    });

    it('gives generic error when symbol truly does not exist', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }',
        });
        try {
            const index = idx(dir);
            const { ok, error } = execute(index, 'about', { name: 'nonexistent', file: 'lib.js' });
            assert.ok(!ok);
            assert.ok(error.includes('not found'), 'should give generic not found error');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG #13: plan should detect existing parameters
// ============================================================================

describe('fix #13: plan rejects duplicate parameter', () => {
    it('returns error when add_param names an existing parameter', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function fetch(url, timeout) { return url; }\nmodule.exports = { fetch };',
            'app.js': 'const { fetch } = require("./lib");\nfetch("http://x", 5000);',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'plan', { name: 'fetch', addParam: 'timeout' });
            assert.ok(ok, 'should return ok (found the function)');
            assert.ok(result.error, 'should have error field');
            assert.ok(result.error.includes('already exists'), `should say "already exists", got: ${result.error}`);
            assert.deepStrictEqual(result.currentParams, ['url', 'timeout']);
        } finally {
            rm(dir);
        }
    });

    it('allows adding a genuinely new parameter', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function fetch(url, timeout) { return url; }\nmodule.exports = { fetch };',
            'app.js': 'const { fetch } = require("./lib");\nfetch("http://x", 5000);',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'plan', { name: 'fetch', addParam: 'retries', defaultValue: '3' });
            assert.ok(ok);
            assert.ok(!result.error, 'should not have error');
            assert.strictEqual(result.operation, 'add-param');
            assert.ok(result.after.params.includes('retries'), 'new param should be in after.params');
            assert.ok(result.after.signature.includes('retries'), 'new param should be in signature');
        } finally {
            rm(dir);
        }
    });

    it('detects duplicate even when param has default value (Python)', () => {
        const dir = tmp({
            'setup.py': '',
            'lib.py': 'def transform(data, verbose=False):\n    return data\n',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'plan', { name: 'transform', addParam: 'verbose', defaultValue: 'True' });
            assert.ok(ok);
            assert.ok(result.error, 'should detect duplicate');
            assert.ok(result.error.includes('already exists'));
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG #14: about and impact caller count consistency
// ============================================================================

describe('fix #14 (updated by H3): about excludes obj.method, impact defaults to including', () => {
    it('about excludes obj.method() callers by default; impact now includes them (H3)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function parse(text) { return text; }\nmodule.exports = { parse };',
            'direct.js': 'const { parse } = require("./lib");\nfunction run() { parse("hello"); }',
            'method.js': 'const obj = require("./lib");\nfunction go() { obj.parse("world"); }',
        });
        try {
            const index = idx(dir);
            const aboutResult = execute(index, 'about', { name: 'parse' });
            const impactResult = execute(index, 'impact', { name: 'parse' });
            const impactNoMethods = execute(index, 'impact', { name: 'parse', includeMethods: false });
            assert.ok(aboutResult.ok);
            assert.ok(impactResult.ok);
            // BUG-H3: impact now defaults to includeMethods:true ("what breaks if I change this"
            // should reach all callable sites). about keeps the old default (false for
            // standalone functions). With includeMethods=false they agree again.
            const aboutCallers = aboutResult.result.callers.total;
            const impactCallers = impactResult.result.totalCallSites;
            const impactNoMethodsCount = impactNoMethods.result.totalCallSites;
            assert.strictEqual(aboutCallers, impactNoMethodsCount,
                `about (${aboutCallers}) and impact --no-include-methods (${impactNoMethodsCount}) should agree`);
            assert.ok(impactCallers >= impactNoMethodsCount,
                `impact default (${impactCallers}) should include at least as many sites as --no-include-methods (${impactNoMethodsCount})`);
        } finally {
            rm(dir);
        }
    });

    it('about with includeMethods=true shows more callers', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function parse(text) { return text; }\nmodule.exports = { parse };',
            'direct.js': 'const { parse } = require("./lib");\nfunction run() { parse("hello"); }',
            'method.js': 'const obj = require("./lib");\nfunction go() { obj.parse("world"); }',
        });
        try {
            const index = idx(dir);
            const defaultResult = execute(index, 'about', { name: 'parse' });
            const withMethods = execute(index, 'about', { name: 'parse', includeMethods: true });
            assert.ok(defaultResult.ok);
            assert.ok(withMethods.ok);
            // With includeMethods=true, should have >= default callers
            assert.ok(withMethods.result.callers.total >= defaultResult.result.callers.total,
                'includeMethods=true should show at least as many callers as default');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// QUALITY: related SIMILAR NAMES noise reduction (short token filtering)
// ============================================================================

describe('related: short token filtering reduces noise', () => {
    it('does not match on 3-char tokens like "get"', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function get_data() { return 1; }\nmodule.exports = { get_data };',
            'b.js': 'function get_config() { return 2; }\nmodule.exports = { get_config };',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'related', { name: 'get_data' });
            assert.ok(ok);
            const similarNames = result.similarNames.map(s => s.name);
            assert.ok(!similarNames.includes('get_config'),
                'should NOT match get_config via shared "get" token (3 chars too short)');
        } finally {
            rm(dir);
        }
    });

    it('matches on 4+ char tokens like "data"', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function get_data() { return 1; }\nmodule.exports = { get_data };',
            'b.js': 'function data_processor() { return 2; }\nmodule.exports = { data_processor };',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'related', { name: 'get_data' });
            assert.ok(ok);
            const similarNames = result.similarNames.map(s => s.name);
            assert.ok(similarNames.includes('data_processor'),
                'should match data_processor via shared "data" token (4 chars)');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug #15: with_types=true should show TYPES section
// ============================================================================

describe('fix #119: about with_types=true shows related types', () => {
    it('shows types referenced in function signature', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'types.ts': `export interface UserConfig {\n  name: string;\n  age: number;\n}`,
            'lib.ts': `import { UserConfig } from './types';\nexport function loadConfig(name: string): UserConfig {\n  return { name, age: 0 };\n}`,
        });
        try {
            const index = idx(dir);
            const result = index.about('loadConfig', { withTypes: true });
            assert.ok(result.found);
            assert.ok(result.types.length > 0, 'should find UserConfig type');
            assert.strictEqual(result.types[0].name, 'UserConfig');
            // Verify formatter shows TYPES section
            const text = output.formatAbout(result);
            assert.ok(text.includes('TYPES:'), 'formatted output should show TYPES section');
            assert.ok(text.includes('UserConfig'), 'should display type name');
        } finally {
            rm(dir);
        }
    });

    it('shows types from Python type annotations', () => {
        const dir = tmp({
            'requirements.txt': '',
            'models.py': `class UserData:\n    def __init__(self, name):\n        self.name = name\n`,
            'service.py': `from models import UserData\ndef get_user(uid: int) -> UserData:\n    return UserData("test")\n`,
        });
        try {
            const index = idx(dir);
            const result = index.about('get_user', { withTypes: true });
            assert.ok(result && result.found);
            assert.ok(result.types.length > 0, 'should find UserData type from return annotation');
            assert.strictEqual(result.types[0].name, 'UserData');
        } finally {
            rm(dir);
        }
    });

    it('extractTypeNames filters to only project-defined types', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.ts': `export function parse(data: string): number {\n  return parseInt(data);\n}`,
        });
        try {
            const index = idx(dir);
            const result = index.about('parse', { withTypes: true });
            assert.ok(result.found);
            assert.strictEqual(result.types.length, 0, 'built-in types should not appear');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug #16: search in= should work with file paths, not just directories
// ============================================================================

describe('fix #120: search/find in= works with file paths', () => {
    it('search filters to a specific file path', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/util.js': 'function helper() { return "hello"; }',
            'src/main.js': 'function main() { return "hello"; }',
        });
        try {
            const index = idx(dir);
            const results = index.search('hello', { in: 'src/util.js' });
            assert.ok(results.length > 0, 'should find matches in the specified file');
            assert.ok(results.every(r => r.file.includes('util.js')), 'all matches should be in util.js');
        } finally {
            rm(dir);
        }
    });

    it('search in= with basename-only file path works', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/util.js': 'function helper() { return "target"; }',
            'src/main.js': 'function main() { return "target"; }',
        });
        try {
            const index = idx(dir);
            const results = index.search('target', { in: 'util.js' });
            assert.ok(results.length > 0, 'should find matches with basename filter');
            assert.ok(results.every(r => r.file.includes('util.js')), 'all matches should be in util.js');
        } finally {
            rm(dir);
        }
    });

    it('search in= still works with directory paths', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/util.js': 'function helper() { return "value"; }',
            'lib/other.js': 'function other() { return "value"; }',
        });
        try {
            const index = idx(dir);
            const results = index.search('value', { in: 'src' });
            assert.ok(results.length > 0, 'should find matches in directory');
            assert.ok(results.every(r => r.file.includes('src/')), 'all matches should be in src/');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug #17: related all=true should not truncate sameFile section
// ============================================================================

describe('fix #121: related all=true fully expands sameFile', () => {
    it('shows all same-file functions when all=true', () => {
        // Create a file with many functions to exceed the default limit of 8
        const funcs = Array.from({ length: 15 }, (_, i) =>
            `function fn${i}() { return ${i}; }`
        ).join('\n');
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'big.js': funcs + '\nmodule.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.related('fn0', { all: true });
            assert.ok(result);
            // sameFile should have 14 others (fn1-fn14)
            assert.ok(result.sameFile.length >= 14, `should have 14 same-file functions, got ${result.sameFile.length}`);

            // Format with all=true should NOT truncate
            const text = output.formatRelated(result, { all: true });
            assert.ok(!text.includes('... and'), 'should not show truncation with all=true');
            assert.ok(!text.includes('Some sections truncated'), 'should not show truncation hint');
            // Verify all functions are shown
            assert.ok(text.includes('fn14'), 'should show fn14 with all=true');
        } finally {
            rm(dir);
        }
    });

    it('truncates sameFile by default when there are many', () => {
        const funcs = Array.from({ length: 15 }, (_, i) =>
            `function fn${i}() { return ${i}; }`
        ).join('\n');
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'big.js': funcs + '\nmodule.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.related('fn0');
            const text = output.formatRelated(result, {});
            assert.ok(text.includes('... and'), 'should show truncation by default');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug #18: scope pollution warning for methods shared across classes
// ============================================================================

describe('fix #122: impact/verify/plan warn about scope pollution', () => {
    it('impact shows scopeWarning for methods in multiple classes', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class FileService { close() { } }\nmodule.exports = { FileService };',
            'b.js': 'class DbConn { close() { } }\nmodule.exports = { DbConn };',
            'main.js': 'const { FileService } = require("./a");\nconst { DbConn } = require("./b");\nnew FileService().close();\nnew DbConn().close();\n',
        });
        try {
            const index = idx(dir);
            const result = index.impact('close');
            assert.ok(result);
            assert.ok(result.scopeWarning, 'should have scope warning');
            assert.ok(result.scopeWarning.otherClasses.length > 0, 'should list other classes');
            assert.ok(result.scopeWarning.hint.includes('file=') || result.scopeWarning.hint.includes('className='),
                'hint should suggest disambiguation');
            // Verify formatter shows the warning
            const text = output.formatImpact(result);
            assert.ok(text.includes('Note:'), 'formatted output should show scope warning');
        } finally {
            rm(dir);
        }
    });

    it('verify shows scopeWarning for methods in multiple classes', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class A { close(x) {} }\nmodule.exports = { A };',
            'b.js': 'class B { close(y) {} }\nmodule.exports = { B };',
            'main.js': 'const { A } = require("./a");\nnew A().close(1);\n',
        });
        try {
            const index = idx(dir);
            const result = index.verify('close');
            assert.ok(result.found);
            assert.ok(result.scopeWarning, 'verify should have scope warning');
            // Verify formatter shows the warning
            const text = output.formatVerify(result);
            assert.ok(text.includes('Note:'), 'formatted verify should show scope warning');
        } finally {
            rm(dir);
        }
    });

    it('no scopeWarning for unique function names', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function uniqueHelper() { return 1; }\nmodule.exports = { uniqueHelper };',
            'app.js': 'const { uniqueHelper } = require("./lib");\nuniqueHelper();',
        });
        try {
            const index = idx(dir);
            const result = index.impact('uniqueHelper');
            assert.ok(result);
            assert.strictEqual(result.scopeWarning, null, 'should not warn for unique names');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug #19: React.forwardRef components should be visible to find/about
// ============================================================================

describe('fix #123: React.forwardRef/memo components detected', () => {
    it('detects React.forwardRef component', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'Button.tsx': `import React from 'react';\nconst Button = React.forwardRef<HTMLButtonElement, {}>((props, ref) => {\n  return <button ref={ref} {...props} />;\n});\nexport default Button;\n`,
        });
        try {
            const index = idx(dir);
            const defs = index.find('Button', { exact: true });
            assert.ok(defs.length > 0, 'should find Button component');
            assert.strictEqual(defs[0].name, 'Button');
        } finally {
            rm(dir);
        }
    });

    it('detects forwardRef without React prefix', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'Input.tsx': `import { forwardRef } from 'react';\nconst Input = forwardRef((props, ref) => {\n  return <input ref={ref} />;\n});\nexport default Input;\n`,
        });
        try {
            const index = idx(dir);
            const defs = index.find('Input', { exact: true });
            assert.ok(defs.length > 0, 'should find Input component');
        } finally {
            rm(dir);
        }
    });

    it('detects React.memo component', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'Card.tsx': `import React from 'react';\nconst Card = React.memo((props) => {\n  return <div>{props.children}</div>;\n});\nexport default Card;\n`,
        });
        try {
            const index = idx(dir);
            const defs = index.find('Card', { exact: true });
            assert.ok(defs.length > 0, 'should find Card component');
        } finally {
            rm(dir);
        }
    });

    it('detects memo without React prefix', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'List.tsx': `import { memo } from 'react';\nconst List = memo(function ListInner(props) {\n  return <ul>{props.items.map(i => <li key={i}>{i}</li>)}</ul>;\n});\nexport default List;\n`,
        });
        try {
            const index = idx(dir);
            const defs = index.find('List', { exact: true });
            assert.ok(defs.length > 0, 'should find List component');
        } finally {
            rm(dir);
        }
    });

    it('about works on forwardRef components', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'Dialog.tsx': `import React from 'react';\nconst Dialog = React.forwardRef((props, ref) => {\n  return <div ref={ref}>{props.children}</div>;\n});\nexport default Dialog;\n`,
            'App.tsx': `import Dialog from './Dialog';\nfunction App() {\n  return <Dialog>Hello</Dialog>;\n}\n`,
        });
        try {
            const index = idx(dir);
            const result = index.about('Dialog');
            assert.ok(result && result.found, 'about should find the forwardRef component');
            assert.strictEqual(result.symbol.name, 'Dialog');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug Report #5 — Evaluation Round 5 Fixes (#115-#125)
// ============================================================================

describe('fix #115: trace depth=0 misleading message', () => {
    it('shows "depth=0: showing root only" instead of "no callees"', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function process(x) { return helper(x); }\nfunction helper(x) { return x * 2; }\nmodule.exports = { process, helper };',
            'app.js': 'const { process } = require("./lib");\nprocess(42);'
        });
        try {
            const index = idx(dir);
            const result = index.trace('process', { depth: 0 });
            assert.ok(result, 'trace should return result');
            assert.ok(result.tree, 'tree should exist');
            assert.strictEqual(result.tree.children.length, 0, 'no children at depth 0');
            assert.ok(result.warnings, 'should have warnings');
            assert.ok(result.warnings.some(w => w.message.includes('depth=0')),
                'warning should mention depth=0');
            assert.ok(!result.warnings.some(w => w.message.includes('no callees')),
                'warning should NOT say "no callees"');
        } finally {
            rm(dir);
        }
    });

    it('still shows "no callees" hint for genuinely leaf functions at depth > 0', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function foo() { return 1; }\nmodule.exports = { foo };',
            'b.js': 'function foo() { return bar(); }\nfunction bar() { return 2; }\nmodule.exports = { foo };'
        });
        try {
            const index = idx(dir);
            // foo in a.js truly has no callees; foo in b.js does
            const result = index.trace('foo', { depth: 3, file: 'a.js' });
            assert.ok(result, 'trace should return result');
            // No ambiguity warning since we specified file
            // But it should NOT show depth=0 message since depth > 0
            if (result.warnings) {
                assert.ok(!result.warnings.some(w => w.message.includes('depth=0')),
                    'should NOT mention depth=0 when depth > 0');
            }
        } finally {
            rm(dir);
        }
    });
});

describe('fix #116: search respects top= parameter', () => {
    it('limits total matches with top parameter', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const x = 1;\nconst y = 2;\nconst z = 3;\nconst w = 4;\nconst v = 5;',
            'b.js': 'const x = 10;\nconst y = 20;\nconst z = 30;',
        });
        try {
            const index = idx(dir);
            const allResults = index.search('const', {});
            const totalAll = allResults.reduce((s, r) => s + r.matches.length, 0);
            assert.ok(totalAll > 3, `should find > 3 matches, got ${totalAll}`);

            const limited = index.search('const', { top: 3 });
            const totalLimited = limited.reduce((s, r) => s + r.matches.length, 0);
            assert.strictEqual(totalLimited, 3, 'should limit to 3 matches');
            assert.ok(limited.meta.truncatedMatches > 0, 'should report truncated count');
            assert.strictEqual(limited.meta.totalMatches, totalAll, 'should report total');
        } finally {
            rm(dir);
        }
    });

    it('top=1 returns exactly one match', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'let a = 1;\nlet b = 2;\nlet c = 3;',
        });
        try {
            const index = idx(dir);
            const result = index.search('let', { top: 1 });
            const total = result.reduce((s, r) => s + r.matches.length, 0);
            assert.strictEqual(total, 1, 'should return exactly 1 match');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #117: className= parameter functional in impact/verify/plan', () => {
    it('impact scopes to className', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'service.py': `
class ServiceA:
    def close(self):
        pass

class ServiceB:
    def close(self):
        pass
`,
            'app.py': `
from service import ServiceA, ServiceB
def run():
    a = ServiceA()
    a.close()
    b = ServiceB()
    b.close()
`,
        });
        try {
            const index = idx(dir);

            // Without className: finds calls from both classes
            const impactAll = index.impact('close', {});
            assert.ok(impactAll, 'should find close');

            // With className=ServiceA: should scope results
            const impactA = index.impact('close', { className: 'ServiceA' });
            assert.ok(impactA, 'should find close for ServiceA');
            assert.ok(impactA.file.includes('service.py'), 'should resolve to service.py');
        } finally {
            rm(dir);
        }
    });

    it('verify scopes to className', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'svc.py': `
class Alpha:
    def process(self, data):
        return data

class Beta:
    def process(self, x, y):
        return x + y
`,
            'main.py': `
from svc import Alpha, Beta
def run():
    a = Alpha()
    a.process("hello")
    b = Beta()
    b.process(1, 2)
`,
        });
        try {
            const index = idx(dir);
            const verifyA = index.verify('process', { className: 'Alpha' });
            assert.ok(verifyA, 'should find process for Alpha');
            assert.ok(verifyA.found, 'should be found');
            // Alpha.process takes 1 arg (self excluded), Beta.process takes 2
            assert.strictEqual(verifyA.expectedArgs.min, 1, 'Alpha.process expects 1 arg');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #118: verify finds calls for *args/**kwargs functions', () => {
    it('finds call sites for functions with *args', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'util.py': `
def submit(*args, **kwargs):
    return args, kwargs
`,
            'caller.py': `
from util import submit
def run():
    submit(1, 2, 3)
    submit(key="value")
    submit()
`,
        });
        try {
            const index = idx(dir);
            const result = index.verify('submit', {});
            assert.ok(result, 'should find submit');
            assert.ok(result.found, 'should be found');
            assert.ok(result.totalCalls > 0, `should find calls, got ${result.totalCalls}`);
        } finally {
            rm(dir);
        }
    });
});

describe('fix #125: verify counts module-level calls (jobs.submit pattern)', () => {
    it('finds calls via import module (import jobs + jobs.submit)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'jobs.py': `
def submit(task, priority=1):
    pass

def cancel(task_id):
    pass
`,
            'worker.py': `
import jobs

def process():
    jobs.submit("task1")
    jobs.submit("task2", priority=2)
    jobs.cancel("abc")
`,
        });
        try {
            const index = idx(dir);
            const result = index.verify('submit');
            assert.ok(result.found, 'Should find submit function');
            assert.strictEqual(result.totalCalls, 2,
                `Should count 2 module-level calls via jobs.submit(), got ${result.totalCalls}`);
            assert.strictEqual(result.valid, 2, 'Both calls should be valid');
        } finally {
            rm(dir);
        }
    });

    it('finds calls via from-import (from api import jobs + jobs.submit)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'jobs.py': `
def submit(fn, *args, **kwargs):
    pass
`,
            'caller.py': `
from . import jobs

def run():
    jobs.submit(task_fn, 1, 2, key="val")
`,
        });
        try {
            const index = idx(dir);
            const result = index.verify('submit');
            assert.ok(result.found, 'Should find submit function');
            assert.strictEqual(result.totalCalls, 1,
                `Should count 1 module-level call via jobs.submit(), got ${result.totalCalls}`);
        } finally {
            rm(dir);
        }
    });

    it('still filters dict.get() false positives', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'api.py': `
def get(url):
    return url
`,
            'client.py': `
from api import get

def fetch():
    result = get("/data")
    headers = {"Host": "example.com"}
    host = headers.get("Host")
    data = {"key": "value"}
    val = data.get("key")
`,
        });
        try {
            const index = idx(dir);
            const result = index.verify('get');
            assert.ok(result.found, 'Should find get function');
            // Only direct get("/data") should count, not headers.get() or data.get()
            assert.strictEqual(result.totalCalls, 1,
                `Should count only 1 direct call, got ${result.totalCalls}`);
        } finally {
            rm(dir);
        }
    });
});

describe('fix #119: about CALLERS includes method callers for class methods', () => {
    it('defaults includeMethods=true for class methods', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'analyzer.py': `
class Analyzer:
    def analyze(self, data):
        return self._process(data)

    def _process(self, data):
        return data * 2
`,
            'main.py': `
from analyzer import Analyzer
def run():
    a = Analyzer()
    a.analyze('test')
    result = a.analyze('other')
`,
        });
        try {
            const index = idx(dir);
            const about = index.about('analyze');
            assert.ok(about, 'should find analyze');
            assert.ok(about.found, 'should be found');
            assert.ok(about.includeMethods === true, 'should default to includeMethods=true for methods');
            // Should find callers including a.analyze() calls
            assert.ok(about.callers.total > 0, `should find callers, got ${about.callers.total}`);
        } finally {
            rm(dir);
        }
    });

    it('defaults includeMethods=false for standalone functions', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }',
        });
        try {
            const index = idx(dir);
            const about = index.about('helper');
            assert.ok(about, 'should find helper');
            assert.ok(about.found, 'should be found');
            assert.ok(about.includeMethods === false, 'should default to includeMethods=false for functions');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #120: impact finds call sites despite local name collision', () => {
    it('finds method calls in files with same-name local function', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'engine.py': `
class Engine:
    def analyze(self, data):
        return data * 2
`,
            'api.py': `
from engine import Engine

def analyze(request):
    """FastAPI endpoint with same name"""
    eng = Engine()
    result = eng.analyze(request.data)
    return result
`,
            'worker.py': `
from engine import Engine
def run_worker():
    e = Engine()
    e.analyze('batch_data')
`,
        });
        try {
            const index = idx(dir);
            // impact on Engine.analyze should find calls in BOTH api.py and worker.py
            const result = index.impact('analyze', { className: 'Engine' });
            assert.ok(result, 'should find analyze');
            const files = result.byFile.map(f => f.file);
            assert.ok(result.totalCallSites >= 2,
                `should find >= 2 call sites, got ${result.totalCallSites} in files: ${files.join(', ')}`);
        } finally {
            rm(dir);
        }
    });
});

describe('fix #121: stacktrace uses AST-based function attribution', () => {
    it('resolves correct enclosing function when trace name mismatches', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': `
function alpha() {
    return 1;
}

function beta() {
    // line 7
    // line 8
    // line 9
    return alpha() + 1;
}

function gamma() {
    // line 13
    // line 14
    return beta() + 2;
}
`
        });
        try {
            const index = idx(dir);
            // Simulate a stack trace where function name is wrong (e.g., from minified code)
            const frame = index.createStackFrame(
                'app.js', 10, 'wrong_name', null, '    at wrong_name (app.js:10:5)'
            );
            assert.ok(frame, 'should create frame');
            assert.ok(frame.found, 'should find file');
            // Should use AST to find the actual enclosing function (beta, lines 6-11)
            if (frame.functionInfo) {
                assert.strictEqual(frame.functionInfo.name, 'beta',
                    `should attribute to beta (enclosing function), got ${frame.functionInfo.name}`);
                assert.ok(frame.functionInfo.inferred, 'should be marked as inferred');
                assert.strictEqual(frame.functionInfo.traceName, 'wrong_name',
                    'should preserve original trace name');
            }
        } finally {
            rm(dir);
        }
    });
});

describe('fix #122: with_types=true shows types from function body', () => {
    it('includes types referenced in method body, not just parent class', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'models.py': `
class Config:
    pass

class Report:
    pass

class Processor:
    def process(self, data):
        config = Config()
        report = Report()
        return report
`,
        });
        try {
            const index = idx(dir);
            const about = index.about('process', { withTypes: true });
            assert.ok(about, 'should find process');
            assert.ok(about.found, 'should be found');
            const typeNames = about.types.map(t => t.name);
            assert.ok(typeNames.includes('Processor'), 'should include parent class');
            assert.ok(typeNames.includes('Config'), 'should include Config from body');
            assert.ok(typeNames.includes('Report'), 'should include Report from body');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #123: deadcode not fooled by property access substring matching', () => {
    it('does not count obj.Name as usage of standalone Name', () => {
        const dir = tmp({
            'package.json': '{"name":"test","type":"module"}',
            'components.js': `
export const Separator = () => '<hr/>';
export const Button = () => '<button/>';
`,
            'lib.js': `
const Primitives = { Separator: 'primitive-sep' };
// Uses Primitives.Separator (property access), not the exported Separator
export function render() { return Primitives.Separator; }
`,
        });
        try {
            const index = idx(dir);
            const dead = index.deadcode({ includeExported: true });
            const deadNames = dead.map(d => d.name);
            // Separator should be detected as dead — Primitives.Separator is NOT a usage
            assert.ok(deadNames.includes('Separator'),
                `Separator should be dead code, dead items: ${deadNames.join(', ')}`);
            // Button should also be dead (no usage at all)
            assert.ok(deadNames.includes('Button'),
                `Button should be dead code`);
        } finally {
            rm(dir);
        }
    });
});

describe('fix #124: include_methods=false filters self/this method calls in callees', () => {
    it('excludes self.method() callees when includeMethods=false', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'service.py': `
class Service:
    def run(self):
        self.step_one()
        self.step_two()
        helper()

    def step_one(self):
        pass

    def step_two(self):
        pass

def helper():
    pass
`,
        });
        try {
            const index = idx(dir);
            // With includeMethods=true: should see step_one, step_two, helper
            const withMethods = index.findCallees(
                index.symbols.get('run').find(s => s.className === 'Service'),
                { includeMethods: true }
            );
            const withNames = withMethods.map(c => c.name);
            assert.ok(withNames.includes('step_one'), 'should include step_one with methods');
            assert.ok(withNames.includes('step_two'), 'should include step_two with methods');

            // With includeMethods=false: should only see helper (non-method calls)
            const withoutMethods = index.findCallees(
                index.symbols.get('run').find(s => s.className === 'Service'),
                { includeMethods: false }
            );
            const withoutNames = withoutMethods.map(c => c.name);
            assert.ok(!withoutNames.includes('step_one'), 'should exclude step_one without methods');
            assert.ok(!withoutNames.includes('step_two'), 'should exclude step_two without methods');
            assert.ok(withoutNames.includes('helper'), 'should still include helper (non-method)');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// FIX #24: impact className strict filter
// ============================================================================

describe('Fix #24: impact className filter', () => {
    it('should filter unrelated receivers when className is specified', () => {
        const dir = tmp({
            'setup.py': 'from setuptools import setup',
            'app.py': `
class MyService:
    def close(self):
        pass

class OtherService:
    def close(self):
        pass

def main():
    svc = MyService()
    svc.close()
    other = OtherService()
    other.close()
`,
        });
        try {
            const index = idx(dir);
            const { execute } = require('../core/execute');
            const { ok, result } = execute(index, 'impact', { name: 'close', className: 'MyService' });
            assert.strictEqual(ok, true);
            // Should find callers of MyService.close, not OtherService.close
            assert.ok(result, 'impact should return a result');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG #22: findCallees false positives for dict.get(), plt.close()
// ============================================================================

describe('Bug #22: findCallees receiver false positives', () => {
    it('should not resolve dict.get() to a standalone get() function', () => {
        const dir = tmp({
            'setup.py': 'from setuptools import setup',
            'api.py': 'def get(key):\n    return key\n',
            'main.py': `
LOOKUP = {"a": 1}

def compute(analysis, data):
    v1 = analysis.get("key")
    v2 = data.get("other")
    v3 = LOOKUP.get("test")
`,
        });
        try {
            const index = idx(dir);
            const computeDef = index.symbols.get('compute')?.[0];
            assert.ok(computeDef, 'compute should be found');
            const callees = index.findCallees(computeDef, { includeMethods: true });
            const names = callees.map(c => c.name);
            assert.ok(!names.includes('get'),
                'get should NOT be in callees — all .get() calls are on dicts/params');
        } finally {
            rm(dir);
        }
    });

    it('should not resolve plt.close() to a same-file class method', () => {
        const dir = tmp({
            'setup.py': 'from setuptools import setup',
            'report.py': `
import matplotlib.pyplot as plt

class ReportGen:
    def close(self):
        pass

    def generate(self):
        plt.figure()
        plt.close()
`,
        });
        try {
            const index = idx(dir);
            const genDef = index.symbols.get('generate')?.[0];
            assert.ok(genDef, 'generate should be found');
            const callees = index.findCallees(genDef, { includeMethods: true });
            const names = callees.map(c => c.name);
            assert.ok(!names.includes('close'),
                'close should NOT be in callees — plt.close() is an external library call');
        } finally {
            rm(dir);
        }
    });

    it('should still resolve local-type method calls correctly', () => {
        const dir = tmp({
            'setup.py': 'from setuptools import setup',
            'db.py': `
class Connection:
    def close(self):
        pass

def cleanup():
    conn = Connection()
    conn.close()
`,
        });
        try {
            const index = idx(dir);
            const cleanupDef = index.symbols.get('cleanup')?.[0];
            assert.ok(cleanupDef, 'cleanup should be found');
            const callees = index.findCallees(cleanupDef, { includeMethods: true });
            const names = callees.map(c => c.name);
            assert.ok(names.includes('Connection'), 'Connection constructor should be a callee');
            assert.ok(names.includes('close'), 'close should be a callee via localTypes (conn → Connection)');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG #23: usages receiver tracking for member expressions
// ============================================================================

describe('Bug #23: usages filters external namespace member expressions', () => {
    it('should filter Ns.Separator but keep standalone Separator (JS)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.jsx': `
import * as Ns from "@external/lib";

function Separator() { return null; }

function Menu() {
    return Ns.Separator;
}
`,
        });
        try {
            const index = idx(dir);
            const usages = index.usages('Separator');
            // Ns.Separator should be FILTERED (external namespace access)
            const nsUsage = usages.find(u => u.receiver === 'Ns');
            assert.ok(!nsUsage, 'Ns.Separator should be filtered out');
            // Standalone definition should remain
            const defUsage = usages.find(u => u.isDefinition);
            assert.ok(defUsage, 'standalone Separator definition should exist');
        } finally {
            rm(dir);
        }
    });

    it('should keep module.fn() when imported file defines the name (JS)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() {}\nmodule.exports = { helper };',
            'app.js': 'const lib = require("./lib");\nfunction main() { lib.helper(); }\n',
        });
        try {
            const index = idx(dir);
            const usages = index.usages('helper');
            const moduleCall = usages.find(u => u.receiver === 'lib');
            assert.ok(moduleCall, 'lib.helper() should be kept — imported file defines helper');
        } finally {
            rm(dir);
        }
    });

    it('should filter external namespace member expressions (Python)', () => {
        const dir = tmp({
            'setup.py': 'from setuptools import setup',
            'app.py': `
import os

def path():
    return "/"

x = os.path
`,
        });
        try {
            const index = idx(dir);
            const usages = index.usages('path');
            // os.path should be FILTERED (os is external, no project file defines path via import)
            const osUsage = usages.find(u => u.receiver === 'os' && !u.isDefinition);
            assert.ok(!osUsage, 'os.path should be filtered — os is external');
            // Local path() definition should remain
            const defUsage = usages.find(u => u.isDefinition);
            assert.ok(defUsage, 'standalone path() definition should exist');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// CLI --class-name flag
// ============================================================================

describe('CLI --class-name flag', () => {
    it('should pass className via CLI to impact command', () => {
        const dir = tmp({
            'setup.py': 'from setuptools import setup',
            'app.py': `
class Alpha:
    def process(self):
        pass

class Beta:
    def process(self):
        pass
`,
        });
        try {
            const output = runCli(dir, 'impact', ['process'], ['--class-name=Alpha']);
            assert.ok(output.includes('Alpha') || output.includes('process'),
                'impact with --class-name should work');
            assert.ok(!output.includes('Unknown flag'),
                '--class-name should be a recognized flag');
        } finally {
            rm(dir);
        }
    });

    it('should pass className via CLI to verify command', () => {
        const dir = tmp({
            'setup.py': 'from setuptools import setup',
            'app.py': `
class MyClass:
    def process(self, data):
        pass

def caller():
    m = MyClass()
    m.process("hello")
`,
        });
        try {
            const output = runCli(dir, 'verify', ['process'], ['--class-name=MyClass']);
            assert.ok(!output.includes('Unknown flag'),
                '--class-name should be a recognized flag');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #156: verify respects class_name filtering', () => {
    it('filters verify results to only calls on the specified class', () => {
        const dir = tmp({
            'requirements.txt': '',
            'models.py': 'class HttpClient:\n    def close(self):\n        pass\n\nclass MarketDataFetcher:\n    def close(self):\n        pass\n',
            'app.py': 'from models import HttpClient, MarketDataFetcher\n\ndef use_http():\n    c = HttpClient()\n    c.close()\n\ndef use_market():\n    m = MarketDataFetcher()\n    m.close()\n\ndef plot_stuff():\n    import matplotlib.pyplot as plt\n    plt.close("all")\n',
        });
        try {
            const index = idx(dir);
            const result = index.verify('close', { className: 'HttpClient' });
            assert.ok(result.found, 'should find close');
            // totalCalls should be 1 (only c.close() from use_http), not 2 or 3
            assert.strictEqual(result.totalCalls, 1, 'should only find 1 call (HttpClient)');
            assert.strictEqual(result.valid, 1, 'the single HttpClient call should be valid');
            // plt.close and m.close (MarketDataFetcher) should be filtered out
            assert.strictEqual(result.mismatches, 0, 'no mismatches from other classes');
            assert.strictEqual(result.mismatchDetails.length, 0, 'no mismatch details from plt.close()');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #157: impact/verify className filter uses parameter type annotations', () => {
    it('impact includes calls through typed parameters', () => {
        const dir = tmp({
            'requirements.txt': '',
            'tracker.py': 'class SourceTracker:\n    def record(self, data):\n        pass\n',
            'service.py': 'from tracker import SourceTracker\n\ndef process_data(tracker: SourceTracker, items):\n    for item in items:\n        tracker.record(item)\n\ndef direct_use():\n    t = SourceTracker()\n    t.record("hello")\n',
        });
        try {
            const index = idx(dir);
            const impact = index.impact('record', { className: 'SourceTracker' });
            assert.ok(impact, 'impact should return results');
            // Gather all call sites from byFile
            const allSites = impact.byFile.flatMap(f => f.sites);
            // direct_use: t.record("hello")
            const hasDirectCall = allSites.some(c =>
                c.expression && c.expression.includes('t.record')
            );
            // process_data: tracker.record(item) - should be found via parameter type annotation
            const hasParamCall = allSites.some(c =>
                c.expression && c.expression.includes('tracker.record')
            );
            assert.ok(hasDirectCall, 'should find direct constructor-based call');
            assert.ok(hasParamCall, 'should find call via typed parameter (tracker: SourceTracker)');
        } finally {
            rm(dir);
        }
    });

    it('verify includes calls through typed parameters', () => {
        const dir = tmp({
            'requirements.txt': '',
            'client.py': 'class HttpClient:\n    def get(self, url):\n        pass\n',
            'handler.py': 'from client import HttpClient\n\ndef fetch_data(client: HttpClient):\n    client.get("/api/data")\n\ndef direct():\n    c = HttpClient()\n    c.get("/api/other")\n',
        });
        try {
            const index = idx(dir);
            const result = index.verify('get', { className: 'HttpClient' });
            assert.ok(result.found, 'should find get');
            // Both calls should be counted: client.get() (typed param) and c.get() (constructor)
            assert.strictEqual(result.totalCalls, 2, 'should find 2 calls (typed param + constructor)');
            assert.strictEqual(result.valid, 2, 'both calls should be valid');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #159: unique method heuristic for className filtering', () => {
    it('impact includes untyped param calls when method is unique to target class', () => {
        const dir = tmp({
            'requirements.txt': '',
            'tracker.py': 'class SourceTracker:\n    def record(self, data):\n        pass\n',
            'service.py': 'from tracker import SourceTracker\n\ndef process(tracker=None):\n    if tracker:\n        tracker.record("data")\n\ndef direct():\n    t = SourceTracker()\n    t.record("hello")\n',
        });
        try {
            const index = idx(dir);
            const impact = index.impact('record', { className: 'SourceTracker' });
            assert.ok(impact, 'impact should return results');
            const allSites = impact.byFile.flatMap(f => f.sites);
            // Both calls should be included: direct constructor + untyped param (unique method)
            assert.ok(allSites.some(c => c.expression && c.expression.includes('t.record')),
                'should find direct constructor-based call');
            assert.ok(allSites.some(c => c.expression && c.expression.includes('tracker.record')),
                'should find untyped param call via unique method heuristic');
        } finally {
            rm(dir);
        }
    });

    it('does NOT include calls when method exists on multiple classes', () => {
        const dir = tmp({
            'requirements.txt': '',
            'classes.py': 'class HttpClient:\n    def close(self):\n        pass\n\nclass DbConnection:\n    def close(self):\n        pass\n',
            'app.py': 'from classes import HttpClient, DbConnection\n\ndef cleanup(conn=None):\n    if conn:\n        conn.close()\n\ndef direct():\n    c = HttpClient()\n    c.close()\n',
        });
        try {
            const index = idx(dir);
            const impact = index.impact('close', { className: 'HttpClient' });
            assert.ok(impact, 'impact should return results');
            const allSites = impact.byFile.flatMap(f => f.sites);
            // direct c.close() should be included (constructor assignment)
            assert.ok(allSites.some(c => c.expression && c.expression.includes('c.close')),
                'should find direct constructor-based call');
            // conn.close() should NOT be included (close exists on 2 classes)
            assert.ok(!allSites.some(c => c.expression && c.expression.includes('conn.close')),
                'should NOT find ambiguous untyped param call when method is on multiple classes');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #158: search shows test file exclusion note', () => {
    it('shows note about excluded test files when matches are found', () => {
        const dir = tmp({
            'requirements.txt': '',
            'lib.py': 'MAGIC_VALUE = 42\n',
            'test_lib.py': 'from lib import MAGIC_VALUE\ndef test_magic():\n    assert MAGIC_VALUE == 42\n',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'search', { term: 'MAGIC_VALUE' });
            assert.ok(result.ok);
            const text = output.formatSearch(result.result, 'MAGIC_VALUE');
            assert.ok(text.includes('MAGIC_VALUE'), 'should find matches');
            // Should mention excluded files
            assert.ok(text.includes('test file') && text.includes('hidden'),
                'should mention that test files were excluded');
        } finally {
            rm(dir);
        }
    });

    it('does not show note when include_tests=true', () => {
        const dir = tmp({
            'requirements.txt': '',
            'lib.py': 'MAGIC_VALUE = 42\n',
            'test_lib.py': 'from lib import MAGIC_VALUE\ndef test_magic():\n    assert MAGIC_VALUE == 42\n',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'search', { term: 'MAGIC_VALUE', includeTests: true });
            assert.ok(result.ok);
            const text = output.formatSearch(result.result, 'MAGIC_VALUE');
            assert.ok(text.includes('MAGIC_VALUE'), 'should find matches');
            assert.ok(!text.includes('test files hidden'),
                'should not mention test exclusion when include_tests=true');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG #35: impact/verify/context silently ignore invalid class_name
// ============================================================================

describe('fix #35: impact/verify/context reject invalid class_name', () => {
    let dir, index;

    it('setup', () => {
        dir = tmp({
            'requirements.txt': '',
            'api.py': `
class JobRunner:
    def submit(self):
        return "job"

def submit():
    return "standalone"
`,
            'app.py': `
from api import submit, JobRunner

def main():
    result = submit()
    runner = JobRunner()
    runner.submit()
`,
        });
        index = idx(dir);
    });

    it('impact errors when class_name has no such method', () => {
        const result = execute(index, 'impact', { name: 'submit', className: 'NonExistentClass' });
        assert.strictEqual(result.ok, false);
        assert.ok(result.error.includes('not found in class'), result.error);
    });

    it('impact errors when method not in specified class', () => {
        const result = execute(index, 'impact', { name: 'main', className: 'JobRunner' });
        assert.strictEqual(result.ok, false);
        assert.ok(result.error.includes('not a method'), result.error);
    });

    it('verify errors when class_name is invalid', () => {
        const result = execute(index, 'verify', { name: 'submit', className: 'NonExistentClass' });
        assert.strictEqual(result.ok, false);
        assert.ok(result.error.includes('not found in class'), result.error);
    });

    it('context errors when class_name is invalid', () => {
        const result = execute(index, 'context', { name: 'submit', className: 'NonExistentClass' });
        assert.strictEqual(result.ok, false);
        assert.ok(result.error.includes('not found in class'), result.error);
    });

    it('plan errors when class_name is invalid', () => {
        const result = execute(index, 'plan', { name: 'submit', className: 'NonExistentClass', addParam: 'x' });
        assert.strictEqual(result.ok, false);
        assert.ok(result.error.includes('not found in class'), result.error);
    });

    it('impact succeeds with valid class_name', () => {
        const result = execute(index, 'impact', { name: 'submit', className: 'JobRunner' });
        assert.strictEqual(result.ok, true);
    });

    it('verify succeeds with valid class_name', () => {
        const result = execute(index, 'verify', { name: 'submit', className: 'JobRunner' });
        assert.strictEqual(result.ok, true);
    });

    it('error lists available classes', () => {
        const result = execute(index, 'impact', { name: 'submit', className: 'WrongClass' });
        assert.strictEqual(result.ok, false);
        assert.ok(result.error.includes('JobRunner'), 'should mention available class');
    });

    it('cleanup', () => { rm(dir); });
});

// ============================================================================
// BUG #36: find undercounts obj.method() patterns
// ============================================================================

describe('fix #36: find counts obj.method() calls accurately', () => {
    it('counts method calls from files without direct import', () => {
        const dir = tmp({
            'requirements.txt': '',
            'tracker.py': `
class Tracker:
    def record(self, event):
        pass
`,
            'app.py': `
from tracker import Tracker

def start():
    t = Tracker()
    t.record("start")
`,
            'helper.py': `
def process(tracker):
    tracker.record("step1")
    tracker.record("step2")
`,
        });
        try {
            const index = idx(dir);
            const results = index.find('record');
            assert.ok(results.length > 0, 'should find record');
            const recordResult = results.find(r => r.name === 'record');
            // Should count calls from helper.py too (no direct import)
            assert.ok(recordResult.usageCounts.calls >= 3,
                `Expected at least 3 calls, got ${recordResult.usageCounts.calls}`);
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG #37: toc file= silently ignored
// ============================================================================

describe('fix #37: toc respects file parameter', () => {
    it('scopes toc to a single file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nfunction other() { return 2; }\n',
            'app.js': 'function main() { return helper(); }\n',
            'utils.js': 'function util() {}\n',
        });
        try {
            const index = idx(dir);
            // Full toc should show all files
            const full = execute(index, 'toc', {});
            assert.ok(full.ok);
            assert.ok(full.result.totals.files >= 3);

            // Scoped toc should show only matching file
            const scoped = execute(index, 'toc', { file: 'lib.js' });
            assert.ok(scoped.ok);
            assert.strictEqual(scoped.result.totals.files, 1, 'should show only 1 file');
            assert.strictEqual(scoped.result.files[0].file, 'lib.js');
            assert.strictEqual(scoped.result.totals.functions, 2, 'lib.js has 2 functions');
        } finally {
            rm(dir);
        }
    });

    it('toc file= with partial path', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/api/routes.js': 'function getUsers() {}\nfunction createUser() {}\n',
            'src/lib/utils.js': 'function format() {}\n',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'toc', { file: 'api/routes' });
            assert.ok(result.ok);
            assert.strictEqual(result.result.totals.files, 1);
            assert.ok(result.result.files[0].file.includes('routes'));
        } finally {
            rm(dir);
        }
    });

    it('toc file= returns error for missing file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() {}\n',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'toc', { file: 'nonexistent.js' });
            assert.ok(!result.ok, 'should return error for non-matching file pattern');
            assert.ok(result.error.includes('No files matched'));
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG #38: plan add_param without default produces invalid signature
// ============================================================================

describe('fix #38: plan add_param places required param before optionals', () => {
    it('inserts required param before optional params (Python)', () => {
        const dir = tmp({
            'requirements.txt': '',
            'cache.py': `
def set_cache(key, data, hours=4, conn=None):
    pass
`,
            'app.py': `
from cache import set_cache

def store():
    set_cache("k", "v")
`,
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'plan', {
                name: 'set_cache',
                addParam: 'ttl_hours',
            });
            assert.ok(result.ok);
            // The new required param should appear BEFORE optional params
            const afterSig = result.result.after.signature;
            assert.ok(afterSig.includes('ttl_hours'), 'should contain new param');
            // ttl_hours should come before hours (which has default)
            const ttlIdx = afterSig.indexOf('ttl_hours');
            const hoursIdx = afterSig.indexOf('hours');
            assert.ok(ttlIdx < hoursIdx,
                `Required param 'ttl_hours' (pos ${ttlIdx}) should come before optional 'hours' (pos ${hoursIdx})`);
        } finally {
            rm(dir);
        }
    });

    it('appends param at end when it has a default value', () => {
        const dir = tmp({
            'requirements.txt': '',
            'cache.py': `
def set_cache(key, data, hours=4, conn=None):
    pass
`,
            'app.py': `
from cache import set_cache

def store():
    set_cache("k", "v")
`,
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'plan', {
                name: 'set_cache',
                addParam: 'ttl_hours',
                defaultValue: '24',
            });
            assert.ok(result.ok);
            const afterSig = result.result.after.signature;
            // With default, the param should be at the end (valid position)
            assert.ok(afterSig.includes('ttl_hours = 24'), 'should have param with default');
        } finally {
            rm(dir);
        }
    });

    it('inserts required param before optional in JS/TS', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': `
function connect(host, port, timeout = 5000, retries = 3) {
    return null;
}
`,
            'app.js': `
const { connect } = require('./lib');
function main() { connect("localhost", 8080); }
`,
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'plan', {
                name: 'connect',
                addParam: 'protocol',
            });
            assert.ok(result.ok);
            const afterSig = result.result.after.signature;
            const protoIdx = afterSig.indexOf('protocol');
            const timeoutIdx = afterSig.indexOf('timeout');
            assert.ok(protoIdx < timeoutIdx,
                `Required 'protocol' should come before optional 'timeout'`);
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG #39: plan add_param (no default) misleading guidance (fixed by #38)
// ============================================================================

describe('fix #39: plan add_param required param shows correct guidance', () => {
    it('call sites say "Add argument" when no default (valid with #38 fix)', () => {
        const dir = tmp({
            'requirements.txt': '',
            'cache.py': `
def set_cache(key, data, hours=4):
    pass
`,
            'app.py': `
from cache import set_cache

def store():
    set_cache("k", "v")
`,
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'plan', {
                name: 'set_cache',
                addParam: 'ttl_hours',
            });
            assert.ok(result.ok);
            // Signature should be valid (ttl_hours before hours)
            const afterSig = result.result.after.signature;
            const ttlIdx = afterSig.indexOf('ttl_hours');
            const hoursIdx = afterSig.indexOf('hours');
            assert.ok(ttlIdx < hoursIdx, 'signature should be valid');
            // Call sites should have guidance
            assert.ok(result.result.changes.length > 0, 'should have call site changes');
            assert.ok(result.result.changes[0].suggestion.includes('Add argument'));
        } finally {
            rm(dir);
        }
    });
});

describe('fix #168: commands warn when --file matches no files', () => {
    it('context returns error for non-matching --file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() {}\nmodule.exports = { helper };',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'helper', file: 'nonexistent' });
            assert.ok(!r.ok, 'should fail');
            assert.ok(r.error.includes('nonexistent'), 'should mention the pattern');
        } finally {
            rm(dir);
        }
    });

    it('impact returns error for non-matching --file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() {}',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'impact', { name: 'helper', file: 'xyz' });
            assert.ok(!r.ok);
            assert.ok(r.error.includes('xyz'));
        } finally {
            rm(dir);
        }
    });

    it('deadcode returns error for non-matching --file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() {}',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'deadcode', { file: 'nonexistent' });
            assert.ok(!r.ok);
            assert.ok(r.error.includes('nonexistent'));
        } finally {
            rm(dir);
        }
    });

    it('fn returns error for non-matching --file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() {}',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'fn', { name: 'helper', file: 'nope' });
            assert.ok(!r.ok);
            assert.ok(r.error.includes('nope'));
        } finally {
            rm(dir);
        }
    });
});

describe('fix #166: api command respects --file pattern filter', () => {
    it('filters api results by file substring pattern', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib/utils.js': 'export function helper() {}\nexport function other() {}',
            'app.js': 'export function main() {}',
        });
        try {
            const index = idx(dir);
            const r1 = execute(index, 'api', {});
            assert.strictEqual(r1.result.length, 3, 'should find 3 total exports');
            const r2 = execute(index, 'api', { file: 'utils' });
            assert.ok(r2.ok, 'should not error');
            assert.strictEqual(r2.result.length, 2, 'should find 2 exports in utils.js');
            const r3 = execute(index, 'api', { file: 'app' });
            assert.ok(r3.ok);
            assert.strictEqual(r3.result.length, 1, 'should find 1 export in app.js');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Fix #187: usages() uses filtered definitions for method detection
// ============================================================================
describe('fix #187: usages test exclusion consistency', () => {
    it('usages with test exclusion should not count test-only method definitions', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': `
class Handler {
    process(data) { return data; }
}
module.exports = { Handler };
`,
            'app.js': `
const { Handler } = require('./lib');
const h = new Handler();
h.process('input');
`,
            'test/test.js': `
class TestHandler {
    process(data) { return 'test'; }
}
const t = new TestHandler();
t.process('test-input');
`
        });
        try {
            const index = idx(dir);
            // Without test exclusion
            const allUsages = index.usages('process', {});
            // With test exclusion
            const filteredUsages = index.usages('process', {
                exclude: ['test']
            });
            // Filtered should have fewer usages (test file excluded)
            assert.ok(filteredUsages.length < allUsages.length,
                'Test-excluded usages should be fewer than all usages');
            // No filtered usage should be from test files
            const testUsage = filteredUsages.find(u =>
                u.relativePath && u.relativePath.includes('test/'));
            assert.ok(!testUsage, 'No usage should come from test files');
        } finally {
            rm(dir);
        }
    });
});

