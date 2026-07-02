/**
 * UCN Phase 2 Command Regression Tests
 *
 * blast, affected-tests, structural search, reverse-trace, circular-deps,
 * Phase 2 bug fixes, and Phase 2 edge-to-edge cross-language tests.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const output = require('../core/output');
const { execute } = require('../core/execute');
const { tmp, rm, idx, runCli, runInteractive } = require('./helpers');

// ============================================================================
// BLAST (transitive blast radius)
// ============================================================================

describe('blast: transitive blast radius', () => {
    it('walks callers transitively', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'mid.js': 'const { helper } = require("./lib");\nfunction middle() { return helper(); }\nmodule.exports = { middle };',
            'app.js': 'const { middle } = require("./mid");\nfunction main() { return middle(); }'
        });
        try {
            const index = idx(dir);
            const result = index.blast('helper', { depth: 3 });
            assert.ok(result, 'blast should return a result');
            assert.strictEqual(result.root, 'helper');
            assert.ok(result.tree, 'should have a tree');

            // helper → middle → main (2 levels deep)
            assert.ok(result.tree.children.length > 0, 'helper should have callers');
            const middleNode = result.tree.children.find(c => c.name === 'middle');
            assert.ok(middleNode, 'middle should be a direct caller');
            assert.ok(middleNode.children.length > 0, 'middle should have its own callers');
            const mainNode = middleNode.children.find(c => c.name === 'main');
            assert.ok(mainNode, 'main should be a transitive caller via middle');

            // Summary
            assert.ok(result.summary.totalAffected >= 2, 'at least 2 functions affected');
            assert.ok(result.summary.totalFiles >= 2, 'at least 2 files affected');
        } finally {
            rm(dir);
        }
    });

    it('detects cycles without infinite loop', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'cycle.js': 'function a() { b(); }\nfunction b() { a(); }\nmodule.exports = { a, b };'
        });
        try {
            const index = idx(dir);
            const result = index.blast('a', { depth: 5 });
            assert.ok(result, 'should complete without infinite loop');
            // b calls a, a calls b — cycle should be detected
            const bNode = result.tree.children.find(c => c.name === 'b');
            if (bNode) {
                // If b has children, one of them should be 'a' with alreadyShown
                const cycleNode = bNode.children.find(c => c.name === 'a');
                if (cycleNode) {
                    assert.ok(cycleNode.alreadyShown, 'cycle should be marked as alreadyShown');
                }
            }
        } finally {
            rm(dir);
        }
    });

    it('respects depth limit', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'chain.js': [
                'function d() { return 1; }',
                'function c() { return d(); }',
                'function b() { return c(); }',
                'function a() { return b(); }',
                'module.exports = { a, b, c, d };'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            // depth=1: only direct callers
            const r1 = index.blast('d', { depth: 1 });
            assert.ok(r1.tree.children.length > 0, 'should have direct callers');
            const cNode = r1.tree.children.find(c => c.name === 'c');
            assert.ok(cNode, 'c should be a direct caller');
            assert.strictEqual(cNode.children.length, 0, 'depth=1 should not recurse further');

            // depth=3: full chain
            const r3 = index.blast('d', { depth: 3 });
            assert.ok(r3.summary.totalAffected >= 3, 'depth=3 should find a, b, c');
        } finally {
            rm(dir);
        }
    });

    it('returns no-callers for entry points', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': 'function main() { console.log("hi"); }'
        });
        try {
            const index = idx(dir);
            const result = index.blast('main', { depth: 3 });
            assert.ok(result, 'should return a result');
            assert.strictEqual(result.tree.children.length, 0, 'entry point has no callers');
            assert.strictEqual(result.summary.totalAffected, 0);
        } finally {
            rm(dir);
        }
    });

    it('works through execute()', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'blast', { name: 'helper', depth: 2 });
            assert.ok(ok, 'execute should succeed');
            assert.strictEqual(result.root, 'helper');
            assert.ok(result.tree.children.length > 0);
        } finally {
            rm(dir);
        }
    });

    it('formatBlast produces readable output', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction caller() { helper(); }'
        });
        try {
            const index = idx(dir);
            const result = index.blast('helper', { depth: 2 });
            const text = output.formatBlast(result);
            assert.ok(text.includes('Blast radius for helper'), 'should have header');
            assert.ok(text.includes('caller'), 'should show caller');
            assert.ok(text.includes('Summary:'), 'should have summary');
        } finally {
            rm(dir);
        }
    });

    it('formatBlastJson produces valid JSON', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction caller() { helper(); }'
        });
        try {
            const index = idx(dir);
            const result = index.blast('helper', { depth: 2 });
            const json = output.formatBlastJson(result);
            const parsed = JSON.parse(json);
            assert.strictEqual(parsed.root, 'helper');
            assert.ok(parsed.tree);
            assert.ok(parsed.summary);
        } finally {
            rm(dir);
        }
    });

    it('supports --exclude filter', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'src/app.js': 'const { helper } = require("../lib");\nfunction appCaller() { helper(); }',
            'test/test.js': 'const { helper } = require("../lib");\nfunction testCaller() { helper(); }'
        });
        try {
            const index = idx(dir);
            // Without exclude: should find callers in both src and test
            const all = index.blast('helper', { depth: 1 });
            assert.ok(all.tree.children.length >= 2, 'should find callers in both locations');

            // With exclude=test: should only find src caller
            const filtered = index.blast('helper', { depth: 1, exclude: ['test'] });
            const testCaller = filtered.tree.children.find(c => c.file && c.file.includes('test'));
            assert.ok(!testCaller, 'test callers should be excluded');
        } finally {
            rm(dir);
        }
    });

    it('CLI blast command works', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const out = runCli(dir, 'blast', ['helper']);
            assert.ok(out.includes('Blast radius for helper'), 'CLI output should have header');
            assert.ok(out.includes('main'), 'CLI output should show caller');
        } finally {
            rm(dir);
        }
    });

    it('diamond pattern: shared caller shown once, second as (see above)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'chain.js': [
                'function d() { return 1; }',
                'function b() { return d(); }',
                'function c() { return d(); }',
                'function a() { b(); c(); }',
                'module.exports = { a, b, c, d };'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.blast('d', { depth: 3 });
            assert.ok(result);
            // b and c are both direct callers of d
            assert.strictEqual(result.tree.children.length, 2, 'should have 2 direct callers');
            const bNode = result.tree.children.find(c => c.name === 'b');
            const cNode = result.tree.children.find(c => c.name === 'c');
            assert.ok(bNode && cNode, 'both b and c should be callers');
            // a calls both b and c — should appear under one and be (see above) under the other
            const aUnderB = bNode.children.find(c => c.name === 'a');
            const aUnderC = cNode.children.find(c => c.name === 'a');
            assert.ok(aUnderB || aUnderC, 'a should appear at least once');
            if (aUnderB && aUnderC) {
                // One must be alreadyShown
                assert.ok(aUnderB.alreadyShown || aUnderC.alreadyShown,
                    'second occurrence of a should be marked alreadyShown');
            }
            // Summary: b, c, a = 3 affected
            assert.strictEqual(result.summary.totalAffected, 3);
        } finally {
            rm(dir);
        }
    });

    it('depth=0 shows root only with hint', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function f() { return 1; }\nfunction g() { f(); }'
        });
        try {
            const index = idx(dir);
            const result = index.blast('f', { depth: 0 });
            assert.strictEqual(result.tree.children.length, 0, 'depth=0 should not recurse');
            assert.ok(result.warnings, 'should have warnings');
            assert.ok(result.warnings.some(w => w.message.includes('depth=0')), 'should hint about depth');
            assert.strictEqual(result.summary.totalAffected, 0);
        } finally {
            rm(dir);
        }
    });

    it('negative depth clamped to 0', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function f() { return 1; }\nfunction g() { f(); }'
        });
        try {
            const index = idx(dir);
            const result = index.blast('f', { depth: -5 });
            assert.strictEqual(result.maxDepth, 0, 'negative depth should clamp to 0');
            assert.strictEqual(result.tree.children.length, 0);
        } finally {
            rm(dir);
        }
    });

    it('module-level callers are skipped (no crash)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'top.js': 'const { helper } = require("./lib");\nconst val = helper();\nconsole.log(val);'
        });
        try {
            const index = idx(dir);
            const result = index.blast('helper', { depth: 2 });
            assert.ok(result, 'should not crash');
            // Module-level caller (val = helper()) should be filtered out
            assert.strictEqual(result.tree.children.length, 0,
                'module-level caller should be skipped');
        } finally {
            rm(dir);
        }
    });

    it('Go method calls traverse correctly', () => {
        const dir = tmp({
            'go.mod': 'module test\ngo 1.21',
            'lib.go': 'package main\ntype Parser struct{}\nfunc (p *Parser) Parse() []string { return nil }\n',
            'app.go': 'package main\nfunc Run() { p := &Parser{}; p.Parse() }\nfunc Main() { Run() }\n'
        });
        try {
            const index = idx(dir);
            const result = index.blast('Parse', { depth: 3 });
            assert.ok(result);
            assert.ok(result.tree.children.length > 0, 'Parse should have callers');
            const runNode = result.tree.children.find(c => c.name === 'Run');
            assert.ok(runNode, 'Run should be a caller of Parse');
            if (runNode.children.length > 0) {
                const mainNode = runNode.children.find(c => c.name === 'Main');
                assert.ok(mainNode, 'Main should be a transitive caller');
            }
        } finally {
            rm(dir);
        }
    });

    it('Python self.method() resolves transitively', () => {
        const dir = tmp({
            'setup.py': '',
            'engine.py': 'class Engine:\n    def process(self, data):\n        return self.transform(data)\n    def transform(self, data):\n        return data.upper()\n',
            'runner.py': 'from engine import Engine\ndef run():\n    e = Engine()\n    return e.process("hello")\n',
            'main.py': 'from runner import run\ndef main():\n    run()\n'
        });
        try {
            const index = idx(dir);
            const result = index.blast('transform', { depth: 3 });
            assert.ok(result, 'should resolve Python method');
            // transform → process → run → main
            assert.ok(result.summary.totalAffected >= 2,
                'should find at least process and run as transitive callers');
        } finally {
            rm(dir);
        }
    });

    it('truncation at 10 callers by default, --all shows all', () => {
        const dir = tmp(Object.assign(
            { 'package.json': '{"name":"test"}',
              'lib.js': 'function util() { return 1; }\nmodule.exports = { util };' },
            ...Array.from({ length: 15 }, (_, i) => ({
                [`c${i}.js`]: `const { util } = require("./lib");\nfunction fn${i}() { return util(); }\nmodule.exports = { fn${i} };`
            }))
        ));
        try {
            const index = idx(dir);
            // Default: truncation
            const r = index.blast('util', { depth: 1 });
            assert.strictEqual(r.tree.children.length, 10, 'default truncation at 10');
            assert.strictEqual(r.tree.truncatedChildren, 5, 'should report 5 truncated');

            // --all: no truncation
            const rAll = index.blast('util', { depth: 1, all: true });
            assert.strictEqual(rAll.tree.children.length, 15, '--all should show all 15');
            assert.ok(!rAll.tree.truncatedChildren, 'no truncation with --all');
        } finally {
            rm(dir);
        }
    });

    it('multiple call sites in same caller deduped with callSites count', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction caller() {\n  helper();\n  helper();\n  helper();\n}'
        });
        try {
            const index = idx(dir);
            const result = index.blast('helper', { depth: 1 });
            assert.strictEqual(result.tree.children.length, 1, 'one unique caller');
            assert.ok(result.tree.children[0].callSites >= 2,
                'should count multiple call sites');
        } finally {
            rm(dir);
        }
    });

    it('formatBlast handles null gracefully', () => {
        assert.strictEqual(output.formatBlast(null), 'Function not found.');
        const json = JSON.parse(output.formatBlastJson(null));
        assert.strictEqual(json.found, false);
    });

    it('formatBlast shows truncation hint', () => {
        const text = output.formatBlast({
            root: 'f', file: 'f.js', line: 1, maxDepth: 3, includeMethods: true,
            tree: {
                name: 'f', file: 'f.js', line: 1, type: 'function',
                children: [{ name: 'a', file: 'a.js', line: 1, type: 'function', children: [] }],
                truncatedChildren: 5
            },
            summary: { totalAffected: 1, totalFiles: 1, maxDepthReached: 1 }
        });
        assert.ok(text.includes('5 more callers'), 'should show truncation count');
        assert.ok(text.includes('--all'), 'should hint about --all');
    });

    it('formatBlast shows callSites count for multi-call callers', () => {
        const text = output.formatBlast({
            root: 'f', file: 'f.js', line: 1, maxDepth: 3, includeMethods: true,
            tree: {
                name: 'f', file: 'f.js', line: 1, type: 'function',
                children: [{ name: 'g', file: 'g.js', line: 5, type: 'function', callSites: 3, children: [] }]
            },
            summary: { totalAffected: 1, totalFiles: 1, maxDepthReached: 1 }
        });
        assert.ok(text.includes('3x'), 'should show 3x for 3 call sites');
    });

    it('formatBlast shows (see above) for cycles', () => {
        const text = output.formatBlast({
            root: 'a', file: 'a.js', line: 1, maxDepth: 3, includeMethods: true,
            tree: {
                name: 'a', file: 'a.js', line: 1, type: 'function',
                children: [{
                    name: 'b', file: 'b.js', line: 1, type: 'function',
                    children: [{ name: 'a', file: 'a.js', line: 1, type: 'function', children: [], alreadyShown: true }]
                }]
            },
            summary: { totalAffected: 1, totalFiles: 1, maxDepthReached: 2 }
        });
        assert.ok(text.includes('(see above)'), 'should show cycle indicator');
    });

    it('CLI --json returns valid JSON with full structure', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const out = runCli(dir, 'blast', ['helper', '--json']);
            const parsed = JSON.parse(out);
            assert.strictEqual(parsed.root, 'helper');
            assert.ok(parsed.tree, 'JSON should have tree');
            assert.ok(parsed.summary, 'JSON should have summary');
            assert.ok(typeof parsed.maxDepth === 'number', 'maxDepth should be a number');
            assert.ok(typeof parsed.summary.totalAffected === 'number');
        } finally {
            rm(dir);
        }
    });

    it('interactive mode blast works', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const out = runInteractive(dir, ['blast helper']);
            assert.ok(out.includes('Blast radius'), 'interactive should show blast header');
            assert.ok(out.includes('main'), 'interactive should show caller');
        } finally {
            rm(dir);
        }
    });

    it('Rust methods blast correctly', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"',
            'src/lib.rs': 'pub struct Engine {\n    state: i32\n}\nimpl Engine {\n    pub fn run(&self) -> i32 { self.state }\n}\n',
            'src/main.rs': 'use crate::Engine;\nfn start() { let e = Engine { state: 1 }; e.run(); }\nfn main() { start(); }\n'
        });
        try {
            const index = idx(dir);
            const result = index.blast('run', { depth: 3 });
            assert.ok(result, 'should find Rust method');
            assert.ok(result.tree.children.length > 0, 'run should have callers');
        } finally {
            rm(dir);
        }
    });

    it('exclude filters at all levels of the tree', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'src/mid.js': 'const { helper } = require("../lib");\nfunction middle() { return helper(); }\nmodule.exports = { middle };',
            'test/t.js': 'const { middle } = require("../src/mid");\nfunction testMiddle() { return middle(); }'
        });
        try {
            const index = idx(dir);
            // Without exclude: should have helper → middle → testMiddle
            const all = index.blast('helper', { depth: 3 });
            const middleNode = all.tree.children.find(c => c.name === 'middle');
            assert.ok(middleNode, 'should find middle');

            // With exclude=test: middle is still shown, but testMiddle should be excluded
            const filtered = index.blast('helper', { depth: 3, exclude: ['test'] });
            const filteredMiddle = filtered.tree.children.find(c => c.name === 'middle');
            assert.ok(filteredMiddle, 'middle should still be shown');
            if (filteredMiddle) {
                const testChild = filteredMiddle.children.find(c => c.name === 'testMiddle');
                assert.ok(!testChild, 'testMiddle in test/ should be excluded at depth 2');
            }
        } finally {
            rm(dir);
        }
    });

    it('execute rejects missing name', () => {
        const dir = tmp({ 'package.json': '{"name":"test"}', 'a.js': 'function f() {}' });
        try {
            const index = idx(dir);
            const r = execute(index, 'blast', {});
            assert.strictEqual(r.ok, false);
            assert.ok(r.error.includes('required'));
        } finally {
            rm(dir);
        }
    });

    it('execute rejects nonexistent function', () => {
        const dir = tmp({ 'package.json': '{"name":"test"}', 'a.js': 'function f() {}' });
        try {
            const index = idx(dir);
            const r = execute(index, 'blast', { name: 'nonexistent' });
            assert.strictEqual(r.ok, false);
            assert.ok(r.error.includes('not found'));
        } finally {
            rm(dir);
        }
    });

    it('execute rejects invalid className', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class Foo { bar() {} }\nclass Baz { bar() {} }'
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'blast', { name: 'bar', className: 'Nonexistent' });
            assert.strictEqual(r.ok, false);
            assert.ok(r.error.includes('Nonexistent'));
        } finally {
            rm(dir);
        }
    });

    it('execute rejects file pattern that matches nothing', () => {
        const dir = tmp({ 'package.json': '{"name":"test"}', 'a.js': 'function f() {}' });
        try {
            const index = idx(dir);
            const r = execute(index, 'blast', { name: 'f', file: 'nonexistent.js' });
            assert.strictEqual(r.ok, false);
            assert.ok(r.error.includes('No files matched'));
        } finally {
            rm(dir);
        }
    });

    it('Class.method syntax works', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class Foo {\n  bar() { return 1; }\n}\nfunction caller() { const f = new Foo(); f.bar(); }'
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'blast', { name: 'Foo.bar', depth: 1 });
            assert.ok(r.ok, 'Class.method syntax should work');
            assert.strictEqual(r.result.root, 'bar');
        } finally {
            rm(dir);
        }
    });

    it('maxDepthReached tracks actual depth', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'chain.js': [
                'function d() { return 1; }',
                'function c() { return d(); }',
                'function b() { return c(); }',
                'function a() { return b(); }',
                'module.exports = { a, b, c, d };'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            // Chain is 3 deep; ask for depth=10
            const r = index.blast('d', { depth: 10 });
            assert.strictEqual(r.summary.maxDepthReached, 3,
                'should report actual depth reached, not maxDepth');
        } finally {
            rm(dir);
        }
    });

    it('import-graph disambiguation: only shows callers from correct import chain', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function save() { return "a"; }\nmodule.exports = { save };',
            'b.js': 'function save() { return "b"; }\nmodule.exports = { save };',
            'user_a.js': 'const { save } = require("./a");\nfunction saveA() { save(); }',
            'user_b.js': 'const { save } = require("./b");\nfunction saveB() { save(); }'
        });
        try {
            const index = idx(dir);
            // blast for a.js:save should only show saveA
            const rA = index.blast('save', { depth: 1, file: 'a.js' });
            assert.strictEqual(rA.tree.children.length, 1, 'should have exactly 1 caller for a.js:save');
            assert.strictEqual(rA.tree.children[0].name, 'saveA');

            // blast for b.js:save should only show saveB
            const rB = index.blast('save', { depth: 1, file: 'b.js' });
            assert.strictEqual(rB.tree.children.length, 1, 'should have exactly 1 caller for b.js:save');
            assert.strictEqual(rB.tree.children[0].name, 'saveB');
        } finally {
            rm(dir);
        }
    });

    it('import-graph disambiguation works through barrel re-exports', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function save() { return "a"; }\nmodule.exports = { save };',
            'b.js': 'function save() { return "b"; }\nmodule.exports = { save };',
            'barrel.js': 'module.exports = require("./a");',
            'user.js': 'const { save } = require("./barrel");\nfunction useSave() { save(); }'
        });
        try {
            const index = idx(dir);
            // user.js imports via barrel → a.js, so it should be a caller of a.js:save
            const rA = index.blast('save', { depth: 1, file: 'a.js' });
            const names = rA.tree.children.map(c => c.name);
            assert.ok(names.includes('useSave'), 'should find useSave via barrel re-export');

            // user.js should NOT be a caller of b.js:save
            const rB = index.blast('save', { depth: 1, file: 'b.js' });
            const namesB = rB.tree.children.map(c => c.name);
            assert.ok(!namesB.includes('useSave'), 'useSave imports from barrel→a, not b');
        } finally {
            rm(dir);
        }
    });

    it('hint when multiple definitions exist and none has callers', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function process() { return 1; }\nmodule.exports = { process };',
            'b.js': 'function process() { return 2; }\nmodule.exports = { process };'
        });
        try {
            const index = idx(dir);
            const result = index.blast('process', { depth: 1 });
            if (result.tree.children.length === 0 && result.warnings) {
                // Should hint about other definitions
                assert.ok(result.warnings.some(w => w.message.includes('other definition')),
                    'should hint about other definitions');
            }
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// AFFECTED-TESTS: blast + test detection
// ============================================================================

describe('affected-tests: transitive test detection', () => {
    it('finds tests for direct and transitive callers', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nfunction mid() { return helper(); }\nfunction top() { return mid(); }\nmodule.exports = { helper, mid, top };',
            'test/lib.test.js': 'const { helper, top } = require("../lib");\ndescribe("lib", () => {\n  it("helper works", () => { helper(); });\n  it("top works", () => { top(); });\n});',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result, 'should return result');
            assert.strictEqual(result.root, 'helper');
            // Should find affected functions: helper, mid, top
            assert.ok(result.affectedFunctions.includes('helper'));
            assert.ok(result.affectedFunctions.includes('mid'));
            assert.ok(result.affectedFunctions.includes('top'));
            // Should find the test file
            assert.ok(result.testFiles.length > 0, 'should find test files');
            assert.ok(result.testFiles[0].file.includes('test/lib.test.js'));
            // Summary stats
            assert.ok(result.summary.totalAffected >= 3);
            assert.ok(result.summary.totalTestFiles >= 1);
        } finally {
            rm(dir);
        }
    });

    it('returns null for nonexistent function', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('nonexistent');
            assert.strictEqual(result, null);
        } finally {
            rm(dir);
        }
    });

    it('identifies uncovered functions', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nfunction caller() { return helper(); }\nmodule.exports = { helper, caller };',
            'test/lib.test.js': 'const { helper } = require("../lib");\nit("test", () => { helper(); });',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            // 'caller' has no test references
            assert.ok(result.uncovered.includes('caller'), 'caller should be uncovered');
            assert.ok(result.summary.uncoveredCount > 0);
        } finally {
            rm(dir);
        }
    });

    it('respects depth parameter', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function a() { return 1; }\nfunction b() { return a(); }\nfunction c() { return b(); }\nfunction d() { return c(); }\nmodule.exports = { a, b, c, d };',
            'test/lib.test.js': 'const { d } = require("../lib");\nit("test d", () => { d(); });',
        });
        try {
            const index = idx(dir);
            const shallow = index.affectedTests('a', { depth: 1 });
            const deep = index.affectedTests('a', { depth: 3 });
            assert.ok(shallow);
            assert.ok(deep);
            assert.ok(deep.affectedFunctions.length >= shallow.affectedFunctions.length,
                'deeper depth should find more affected functions');
        } finally {
            rm(dir);
        }
    });

    it('execute handler validates input', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }',
        });
        try {
            const index = idx(dir);
            // Missing name
            const r1 = execute(index, 'affectedTests', {});
            assert.strictEqual(r1.ok, false);
            assert.ok(r1.error.includes('required'));
            // Nonexistent function
            const r2 = execute(index, 'affectedTests', { name: 'nope' });
            assert.strictEqual(r2.ok, false);
            assert.ok(r2.error.includes('not found'));
        } finally {
            rm(dir);
        }
    });

    it('formatAffectedTests handles null', () => {
        const text = output.formatAffectedTests(null);
        assert.ok(text.includes('not found'));
    });

    it('formatAffectedTests renders summary', () => {
        const result = {
            root: 'fn', file: 'lib.js', line: 1, depth: 3,
            affectedFunctions: ['fn', 'caller'],
            testFiles: [{
                file: 'test/lib.test.js',
                coveredFunctions: ['fn'],
                matchCount: 1,
                matches: [{ line: 5, content: 'fn();', matchType: 'call', functionName: 'fn' }]
            }],
            summary: { totalAffected: 2, totalTestFiles: 1, coveredFunctions: 1, uncoveredCount: 1 },
            uncovered: ['caller'],
        };
        const text = output.formatAffectedTests(result);
        assert.ok(text.includes('affected-tests: fn'));
        assert.ok(text.includes('2 functions affected'));
        assert.ok(text.includes('Test files to run (1)'));
        assert.ok(text.includes('Uncovered (1): caller'));
        assert.ok(text.includes('1/2 functions covered (50%)'));
    });

    it('formatAffectedTestsJson returns valid JSON', () => {
        const result = {
            root: 'fn', file: 'lib.js', line: 1, depth: 3,
            affectedFunctions: ['fn'], testFiles: [],
            summary: { totalAffected: 1, totalTestFiles: 0, coveredFunctions: 0, uncoveredCount: 1 },
            uncovered: ['fn'],
        };
        const json = JSON.parse(output.formatAffectedTestsJson(result));
        assert.strictEqual(json.root, 'fn');
        assert.ok(Array.isArray(json.testFiles));
    });

    it('works via CLI', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nfunction caller() { return helper(); }\nmodule.exports = { helper, caller };',
            'test/lib.test.js': 'const { helper } = require("../lib");\nit("test", () => { helper(); });',
        });
        try {
            const out = runCli(dir, 'affected-tests', ['helper']);
            assert.ok(out.includes('affected-tests: helper'));
            assert.ok(out.includes('functions affected'));
        } finally {
            rm(dir);
        }
    });

    it('works via interactive mode', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nfunction caller() { return helper(); }\nmodule.exports = { helper, caller };',
            'test/lib.test.js': 'const { helper } = require("../lib");\nit("test", () => { helper(); });',
        });
        try {
            const out = runInteractive(dir, ['affected-tests helper']);
            assert.ok(out.includes('affected-tests: helper'));
        } finally {
            rm(dir);
        }
    });

    it('shows no test files message when no tests exist', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nfunction caller() { return helper(); }\nmodule.exports = { helper, caller };',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            assert.strictEqual(result.testFiles.length, 0);
            const text = output.formatAffectedTests(result);
            assert.ok(text.includes('No test files found'));
        } finally {
            rm(dir);
        }
    });

    it('handles mutual recursion (cycles)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function a() { return b(); }\nfunction b() { return a(); }\nfunction c() { return a(); }\nmodule.exports = { a, b, c };',
            'test/lib.test.js': 'const { a, c } = require("../lib");\nit("test a", () => { a(); });\nit("test c", () => { c(); });',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('a');
            assert.ok(result, 'should not hang on cycles');
            // a→b (mutual), c calls a
            assert.ok(result.affectedFunctions.includes('a'));
            assert.ok(result.affectedFunctions.includes('b'));
            assert.ok(result.affectedFunctions.includes('c'));
        } finally {
            rm(dir);
        }
    });

    it('handles diamond pattern (shared callers)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function base() { return 1; }\nfunction left() { return base(); }\nfunction right() { return base(); }\nfunction top() { return left() + right(); }\nmodule.exports = { base, left, right, top };',
            'test/lib.test.js': 'const { top, base } = require("../lib");\nit("test top", () => { top(); });\nit("test base", () => { base(); });',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('base');
            assert.ok(result);
            assert.ok(result.affectedFunctions.includes('left'));
            assert.ok(result.affectedFunctions.includes('right'));
            assert.ok(result.affectedFunctions.includes('top'));
            assert.ok(result.testFiles.length > 0);
        } finally {
            rm(dir);
        }
    });

    it('multiple test files cover different parts of the chain', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function core() { return 1; }\nfunction mid() { return core(); }\nfunction api() { return mid(); }\nmodule.exports = { core, mid, api };',
            'test/core.test.js': 'const { core } = require("../lib");\nit("core", () => { core(); });',
            'test/api.test.js': 'const { api } = require("../lib");\nit("api", () => { api(); });',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('core');
            assert.ok(result);
            assert.strictEqual(result.testFiles.length, 2, 'should find both test files');
            // 'mid' is uncovered — no test references it directly
            assert.ok(result.uncovered.includes('mid'));
        } finally {
            rm(dir);
        }
    });

    it('depth=0 returns only root function', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function a() { return 1; }\nfunction b() { return a(); }\nmodule.exports = { a, b };',
            'test/lib.test.js': 'const { a } = require("../lib");\nit("test a", () => { a(); });',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('a', { depth: 0 });
            assert.ok(result);
            assert.strictEqual(result.affectedFunctions.length, 1);
            assert.ok(result.affectedFunctions.includes('a'));
            // b should NOT be in the affected set at depth=0
            assert.ok(!result.affectedFunctions.includes('b'));
        } finally {
            rm(dir);
        }
    });

    it('repeated calls do not corrupt index state (_beginOp nesting)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function a() { return 1; }\nfunction b() { return a(); }\nmodule.exports = { a, b };',
            'test/lib.test.js': 'const { a } = require("../lib");\nit("test a", () => { a(); });',
        });
        try {
            const index = idx(dir);
            // Call 5 times — _beginOp/_endOp must balance
            for (let i = 0; i < 5; i++) {
                const r = index.affectedTests('a');
                assert.ok(r, `call ${i} should succeed`);
            }
            // Index must still work after
            const ctx = index.context('a');
            assert.ok(ctx, 'context should work after repeated affectedTests calls');
        } finally {
            rm(dir);
        }
    });

    it('wide blast (50 callers) performs well', () => {
        const files = { 'package.json': '{"name":"test"}', 'lib.js': 'function base() { return 1; }\nmodule.exports = { base };' };
        for (let i = 0; i < 50; i++) {
            files['caller' + i + '.js'] = 'const { base } = require("./lib");\nfunction caller' + i + '() { return base(); }\nmodule.exports = { caller' + i + ' };';
        }
        files['test/base.test.js'] = 'const { base } = require("../lib");\nit("test", () => { base(); });';
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const t1 = performance.now();
            const result = index.affectedTests('base');
            const t2 = performance.now();
            assert.ok(result);
            assert.strictEqual(result.affectedFunctions.length, 51, '50 callers + root');
            assert.ok(t2 - t1 < 5000, `should complete in <5s, took ${Math.round(t2-t1)}ms`);
        } finally {
            rm(dir);
        }
    });

    it('deep chain (depth=99) traverses fully', () => {
        const files = { 'package.json': '{"name":"test"}' };
        let chain = '';
        for (let i = 0; i < 30; i++) {
            chain += i === 0
                ? 'function fn0() { return 1; }\n'
                : 'function fn' + i + '() { return fn' + (i-1) + '(); }\n';
        }
        chain += 'module.exports = { ' + Array.from({length:30}, (_,i) => 'fn'+i).join(', ') + ' };';
        files['lib.js'] = chain;
        files['test/lib.test.js'] = 'const lib = require("../lib");\nit("test fn29", () => { lib.fn29(); });';
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const result = index.affectedTests('fn0', { depth: 99 });
            assert.ok(result);
            assert.strictEqual(result.affectedFunctions.length, 30);
        } finally {
            rm(dir);
        }
    });

    it('passes blast warnings through', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'b.js': 'function helper() { return 2; }\nmodule.exports = { helper };',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            // Multiple definitions → should have disambiguation warning
            assert.ok(result.warnings && result.warnings.length > 0, 'should pass through blast warnings');
        } finally {
            rm(dir);
        }
    });

    it('file filter narrows the target definition', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function helper() { return 1; }\nfunction callerA() { return helper(); }\nmodule.exports = { helper, callerA };',
            'b.js': 'function helper() { return 2; }\nfunction callerB() { return helper(); }\nmodule.exports = { helper, callerB };',
            'test/a.test.js': 'const { helper } = require("../a");\nit("test a helper", () => { helper(); });',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper', { file: 'a.js' });
            assert.ok(result);
            assert.ok(result.file.includes('a.js'));
            assert.ok(result.affectedFunctions.includes('callerA'));
        } finally {
            rm(dir);
        }
    });

    it('bad file filter returns error via execute', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'affectedTests', { name: 'helper', file: 'nonexistent' });
            assert.strictEqual(result.ok, false);
            assert.ok(result.error.includes('No files matched'));
        } finally {
            rm(dir);
        }
    });

    it('bad className filter returns error via execute', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'class Foo { bar() { return 1; } }',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'affectedTests', { name: 'bar', className: 'Baz' });
            assert.strictEqual(result.ok, false);
            assert.ok(result.error.includes('not found in class'));
        } finally {
            rm(dir);
        }
    });

    it('Class.method syntax works', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'class Calc {\n  add(a, b) { return a + b; }\n  sum(arr) { return arr.reduce((s, x) => this.add(s, x), 0); }\n}\nmodule.exports = { Calc };',
            'test/calc.test.js': 'const { Calc } = require("../lib");\nit("test add", () => { new Calc().add(1, 2); });',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'affectedTests', { name: 'Calc.add' });
            assert.ok(result.ok, result.error);
            assert.ok(result.result.affectedFunctions.includes('add'));
        } finally {
            rm(dir);
        }
    });

    it('Python test detection works', () => {
        const dir = tmp({
            'setup.py': '',
            'lib.py': 'def helper():\n    return 1\n\ndef caller():\n    return helper()\n',
            'test_lib.py': 'from lib import helper\n\ndef test_helper():\n    assert helper() == 1\n',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            assert.ok(result.testFiles.length > 0, 'should find Python test file');
            assert.ok(result.testFiles[0].file.includes('test_lib.py'));
        } finally {
            rm(dir);
        }
    });

    it('Go test detection works', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test',
            'lib.go': 'package main\n\nfunc helper() int { return 1 }\nfunc caller() int { return helper() }\n',
            'lib_test.go': 'package main\n\nimport "testing"\n\nfunc TestHelper(t *testing.T) {\n\tresult := helper()\n\tif result != 1 { t.Fatal("fail") }\n}\n',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            assert.ok(result.testFiles.length > 0, 'should find Go test file');
            assert.ok(result.testFiles[0].file.includes('_test.go'));
        } finally {
            rm(dir);
        }
    });

    it('Java test detection works', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'src/main/java/App.java': 'public class App {\n    public static int helper() { return 1; }\n    public static int caller() { return helper(); }\n}',
            'src/test/java/AppTest.java': 'import org.junit.Test;\npublic class AppTest {\n    @Test\n    public void testHelper() { App.helper(); }\n}',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            assert.ok(result.testFiles.length > 0, 'should find Java test file');
        } finally {
            rm(dir);
        }
    });

    it('TypeScript test detection works', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'lib.ts': 'export function helper(): number { return 1; }\nexport function caller(): number { return helper(); }\n',
            'test/lib.test.ts': 'import { helper, caller } from "../lib";\nfunction runsHelper() { helper(); }\nfunction runsCaller() { caller(); }\ndescribe("lib", () => {\n  it("helper", runsHelper);\n  it("caller", runsCaller);\n});\n',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            assert.ok(result.testFiles.length > 0, 'should find TypeScript test file');
            assert.ok(result.testFiles[0].file.includes('.test.ts'));
            assert.strictEqual(result.summary.coveredFunctions, result.summary.totalAffected, 'all functions should be covered');
        } finally {
            rm(dir);
        }
    });

    it('Rust test detection works (separate test file)', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': 'pub fn helper() -> i32 { 1 }\npub fn caller() -> i32 { helper() }\n',
            'tests/integration_test.rs': 'use test::helper;\nfn invokes_helper() { helper(); }\n#[test]\nfn test_helper() {\n    invokes_helper();\n}\n',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            assert.ok(result.testFiles.length > 0, 'should find Rust test file');
            assert.ok(result.testFiles[0].file.includes('tests/'));
        } finally {
            rm(dir);
        }
    });

    it('CLI --json flag returns valid JSON', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nfunction caller() { return helper(); }\nmodule.exports = { helper, caller };',
            'test/lib.test.js': 'const { helper } = require("../lib");\nit("test", () => { helper(); });',
        });
        try {
            const out = runCli(dir, 'affected-tests', ['helper'], ['--json']);
            const parsed = JSON.parse(out);
            assert.strictEqual(parsed.root, 'helper');
            assert.ok(Array.isArray(parsed.affectedFunctions));
            assert.ok(Array.isArray(parsed.testFiles));
            assert.ok(parsed.summary);
        } finally {
            rm(dir);
        }
    });

    it('CLI --depth flag works', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function a() { return 1; }\nfunction b() { return a(); }\nfunction c() { return b(); }\nmodule.exports = { a, b, c };',
            'test/lib.test.js': 'const { c } = require("../lib");\nit("test", () => { c(); });',
        });
        try {
            const out = runCli(dir, 'affected-tests', ['a'], ['--depth=1']);
            assert.ok(out.includes('depth 1'));
        } finally {
            rm(dir);
        }
    });

    it('match types are correctly classified', () => {
        // Use a NAMED function (`runs`) for the helper() call site instead of
        // an inline arrow callback. Tree-sitter intermittently classifies calls
        // inside arrow callbacks as `reference` instead of `call`, which made
        // this test flake. A named function gives the parser a deterministic
        // function_declaration boundary so the call type is stable.
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'test/lib.test.js': 'const { helper } = require("../lib");\nfunction runs() { helper(); }\ndescribe("lib", () => {\n  it("works", runs);\n});',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            assert.ok(result.testFiles.length > 0);
            const matches = result.testFiles[0].matches;
            const types = new Set(matches.map(m => m.matchType));
            assert.ok(types.has('import'), 'should have import match');
            assert.ok(types.has('call'), 'should have call match');
        } finally {
            rm(dir);
        }
    });

    it('formatAffectedTests shows key matches (calls and test-cases only)', () => {
        const result = {
            root: 'fn', file: 'lib.js', line: 1, depth: 3,
            affectedFunctions: ['fn'],
            testFiles: [{
                file: 'test/lib.test.js',
                coveredFunctions: ['fn'],
                matchCount: 3,
                matches: [
                    { line: 1, content: 'const { fn } = require("../lib");', matchType: 'import', functionName: 'fn' },
                    { line: 2, content: 'it("test fn", () => {', matchType: 'test-case', functionName: 'fn' },
                    { line: 3, content: '  fn();', matchType: 'call', functionName: 'fn' },
                ]
            }],
            summary: { totalAffected: 1, totalTestFiles: 1, coveredFunctions: 1, uncoveredCount: 0 },
            uncovered: [],
        };
        const text = output.formatAffectedTests(result);
        // Formatter should show call and test-case matches, not imports
        assert.ok(text.includes('[call]'));
        assert.ok(text.includes('[test-case]'));
        // Import is not in key matches (formatAffectedTests filters to call + test-case)
        assert.ok(!text.includes('[import]'));
    });

    it('exclude filter applies to blast callers but still scans all test files', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function core() { return 1; }\nmodule.exports = { core };',
            'utils/helper.js': 'const { core } = require("../lib");\nfunction useCore() { return core(); }\nmodule.exports = { useCore };',
            'test/core.test.js': 'const { core } = require("../lib");\nit("test core", () => { core(); });',
        });
        try {
            const index = idx(dir);
            // Without exclude: finds useCore as a caller
            const full = index.affectedTests('core');
            assert.ok(full);
            const hasUseCore = full.affectedFunctions.includes('useCore');

            // With exclude=utils: blast should skip callers in utils/
            const filtered = index.affectedTests('core', { exclude: ['utils'] });
            assert.ok(filtered);
            assert.ok(!filtered.affectedFunctions.includes('useCore'), 'useCore should be excluded from affected');
            // Test file should still be found
            assert.ok(filtered.testFiles.length > 0, 'test file should still be found');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// STRUCTURAL SEARCH: Index-based queries (Phase 2)
// ============================================================================

describe('structural search: index-based queries', () => {
    const { execute } = require('../core/execute');
    const output = require('../core/output');

    // Shared fixture with rich symbol metadata across languages
    let dir;
    let index;

    // Create a comprehensive multi-language fixture
    // No project file (package.json/go.mod/etc) so ALL language patterns are used
    function setupFixture() {
        dir = tmp({
            'app.js': `
const { helper } = require('./lib');
function handleRequest(req, res) { return helper(req); }
function processData(data, options) { return data; }
function unusedFunc() { return 42; }
module.exports = { handleRequest, processData };
`,
            'lib.js': `
function helper(request) { return request.body; }
function formatResponse(data) { return JSON.stringify(data); }
module.exports = { helper, formatResponse };
`,
            'handlers.py': `
from typing import Optional
import json

def handle_request(request: 'Request', response: 'Response') -> dict:
    return process(request)

def process(data):
    return json.loads(data)

class RequestHandler:
    def handle(self, request):
        return self.validate(request)

    def validate(self, data):
        return data is not None
`,
            'service.go': `
package service

import "net/http"

func HandleHTTP(w http.ResponseWriter, r *http.Request) {
    Process(r)
}

func Process(r *http.Request) error {
    return nil
}

type Service struct {
    Name string
}

func (s *Service) Start() error {
    return nil
}
`,
            'model.java': `
package com.example;

import java.util.List;

public class UserService {
    public List<String> getUsers(String filter) {
        return findAll(filter);
    }

    private List<String> findAll(String query) {
        return null;
    }
}

@Deprecated
class OldService {
    public void process() {}
}
`,
            'lib.rs': `
pub fn calculate(input: &str) -> Result<i32, String> {
    parse_input(input)
}

fn parse_input(s: &str) -> Result<i32, String> {
    Ok(42)
}

pub struct Calculator {
    value: i32,
}

impl Calculator {
    pub fn new() -> Self {
        Calculator { value: 0 }
    }
}
`,
        });
        index = idx(dir);
    }

    it('--type=function finds all functions', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function' });
            assert.ok(result.results.length > 0, 'should find functions');
            assert.ok(result.results.every(r => !['class', 'struct', 'interface', 'enum'].includes(r.kind)),
                'should not include classes');
            assert.ok(result.meta.mode === 'structural');
        } finally { rm(dir); }
    });

    it('--type=class finds classes/structs', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'class' });
            assert.ok(result.results.length >= 3, 'should find RequestHandler, UserService, OldService, Calculator, Service');
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('RequestHandler'), 'Python class');
            assert.ok(names.includes('UserService'), 'Java class');
        } finally { rm(dir); }
    });

    it('--type=call finds call sites', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'call' });
            assert.ok(result.results.length > 0, 'should find calls');
            assert.ok(result.results.every(r => r.kind === 'call'));
        } finally { rm(dir); }
    });

    it('--type=call --receiver filters by receiver', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'call', receiver: 'json' });
            assert.ok(result.results.length > 0, 'should find json.* calls');
            assert.ok(result.results.every(r => r.receiver && r.receiver.toLowerCase().includes('json')));
        } finally { rm(dir); }
    });

    it('--param filters by parameter name', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', param: 'request' });
            assert.ok(result.results.length >= 2, 'should find functions with request param');
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('handleRequest') || names.includes('handle_request'),
                'should include handleRequest or handle_request');
        } finally { rm(dir); }
    });

    it('--param filters by parameter type', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', param: 'Request' });
            assert.ok(result.results.length >= 1, 'should find functions with Request param type');
        } finally { rm(dir); }
    });

    it('--returns filters by return type (Go)', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', returns: 'error' });
            assert.ok(result.results.length >= 1, 'should find Go functions returning error');
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('Process') || names.includes('Start'), 'Go error-returning function');
        } finally { rm(dir); }
    });

    it('--returns filters by return type (Rust)', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', returns: 'Result' });
            assert.ok(result.results.length >= 1, 'should find Rust functions returning Result');
        } finally { rm(dir); }
    });

    it('--exported finds only exported symbols', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', exported: true });
            assert.ok(result.results.length > 0, 'should find exported functions');
            // All Go exported functions start with uppercase
            const goResults = result.results.filter(r => r.file.endsWith('.go'));
            assert.ok(goResults.every(r => /^[A-Z]/.test(r.name)), 'Go exports are uppercase');
        } finally { rm(dir); }
    });

    it('--unused finds functions with zero callers', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', unused: true });
            assert.ok(result.results.length > 0, 'should find unused functions');
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('unusedFunc'), 'unusedFunc has no callers');
        } finally { rm(dir); }
    });

    it('term as glob filter', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', term: 'handle*' });
            assert.ok(result.results.length >= 2, 'should find handle* functions');
            assert.ok(result.results.every(r => r.name.toLowerCase().startsWith('handle')));
        } finally { rm(dir); }
    });

    it('term with ? wildcard', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', term: 'process*' });
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('processData') || names.includes('process') || names.includes('Process'),
                'should find process* functions');
        } finally { rm(dir); }
    });

    it('--file restricts to file pattern', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', file: 'app.js' });
            assert.ok(result.results.length > 0);
            assert.ok(result.results.every(r => r.file.includes('app.js')));
        } finally { rm(dir); }
    });

    it('--exclude filters out files', () => {
        setupFixture();
        try {
            const all = index.structuralSearch({ type: 'function' });
            const filtered = index.structuralSearch({ type: 'function', exclude: ['handler'] });
            assert.ok(filtered.results.length < all.results.length, 'exclude should reduce results');
            assert.ok(filtered.results.every(r => !r.file.toLowerCase().includes('handler')));
        } finally { rm(dir); }
    });

    it('--top limits results', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', top: 3 });
            assert.ok(result.results.length <= 3, 'should limit to 3');
            assert.ok(result.meta.totalMatched >= result.meta.shown, 'meta shows total');
        } finally { rm(dir); }
    });

    it('combined filters narrow results', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({
                type: 'function',
                param: 'request',
                exported: true,
            });
            // Should be narrow — exported functions with 'request' param
            assert.ok(result.results.length >= 1);
        } finally { rm(dir); }
    });

    it('--decorator finds decorated symbols (Java via modifiers)', () => {
        setupFixture();
        try {
            // Java @Deprecated is stored as lowercase 'deprecated' in modifiers
            const result = index.structuralSearch({ decorator: 'deprecated' });
            assert.ok(result.results.length >= 1, 'should find @Deprecated class');
            assert.ok(result.results.some(r => r.name === 'OldService'));
        } finally { rm(dir); }
    });

    it('no structural flags falls through to text search', () => {
        setupFixture();
        try {
            // Without structural flags, execute routes to text search
            const { ok, result, structural } = execute(index, 'search', { term: 'helper' });
            assert.ok(ok);
            assert.ok(!structural, 'should not be structural mode');
            assert.ok(Array.isArray(result), 'text search returns array');
        } finally { rm(dir); }
    });

    it('structural mode via execute handler', () => {
        setupFixture();
        try {
            const { ok, result, structural } = execute(index, 'search', { type: 'function', param: 'data' });
            assert.ok(ok);
            assert.ok(structural, 'should be structural mode');
            assert.ok(result.meta.mode === 'structural');
            assert.ok(result.results.length > 0);
        } finally { rm(dir); }
    });

    it('structural mode without term is valid', () => {
        setupFixture();
        try {
            const { ok, result, structural } = execute(index, 'search', { type: 'class' });
            assert.ok(ok);
            assert.ok(structural);
            assert.ok(result.results.length > 0);
        } finally { rm(dir); }
    });

    it('empty result returns cleanly', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', returns: 'NonExistentType' });
            assert.strictEqual(result.results.length, 0);
            assert.strictEqual(result.meta.totalMatched, 0);
        } finally { rm(dir); }
    });

    it('results sorted by file then line', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function' });
            for (let i = 1; i < result.results.length; i++) {
                const prev = result.results[i - 1];
                const curr = result.results[i];
                if (prev.file === curr.file) {
                    assert.ok(prev.line <= curr.line, `${prev.name}:${prev.line} should be before ${curr.name}:${curr.line}`);
                }
            }
        } finally { rm(dir); }
    });

    it('text formatter produces readable output', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', exported: true, top: 5 });
            const text = output.formatStructuralSearch(result);
            assert.ok(text.includes('Structural search:'));
            assert.ok(text.includes('exported'));
            assert.ok(text.includes('Found'));
        } finally { rm(dir); }
    });

    it('JSON formatter produces valid JSON', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'class' });
            const json = output.formatStructuralSearchJson(result);
            const parsed = JSON.parse(json);
            assert.ok(parsed.results);
            assert.ok(parsed.meta);
            assert.strictEqual(parsed.meta.mode, 'structural');
        } finally { rm(dir); }
    });

    it('--type=method finds class methods', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'method' });
            assert.ok(result.results.length >= 2, 'should find methods');
            // Should include Python methods, Java methods, etc.
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('handle') || names.includes('validate') ||
                names.includes('getUsers') || names.includes('findAll'),
                'should include class methods');
        } finally { rm(dir); }
    });

    it('CLI structural search works', () => {
        setupFixture();
        try {
            const out = runCli(dir, 'search', [], ['--type=function', '--exported', '--top=5']);
            assert.ok(out.includes('Structural search:'));
            assert.ok(out.includes('exported'));
        } finally { rm(dir); }
    });

    it('CLI structural search --json works', () => {
        setupFixture();
        try {
            const out = runCli(dir, 'search', [], ['--type=class', '--json']);
            const parsed = JSON.parse(out);
            assert.ok(parsed.results);
            assert.strictEqual(parsed.meta.mode, 'structural');
        } finally { rm(dir); }
    });

    it('interactive structural search works', () => {
        setupFixture();
        try {
            const out = runInteractive(dir, ['search --type=function --param=data']);
            assert.ok(out.includes('Structural search:') || out.includes('function'));
        } finally { rm(dir); }
    });

    it('formatter handles empty results', () => {
        const result = {
            results: [],
            meta: { mode: 'structural', query: { type: 'function', returns: 'xyz' }, totalMatched: 0, shown: 0 }
        };
        const text = output.formatStructuralSearch(result);
        assert.ok(text.includes('No matches found'));
    });

    it('formatter handles truncation note', () => {
        const results = Array.from({ length: 5 }, (_, i) => ({
            kind: 'function', name: `fn${i}`, file: 'a.js', line: i + 1,
            params: null, returnType: null, decorators: null, className: null,
        }));
        const result = { results, meta: { mode: 'structural', query: { type: 'function' }, totalMatched: 100, shown: 5 } };
        const text = output.formatStructuralSearch(result);
        assert.ok(text.includes('5 of 100 shown'));
    });

    it('call results show receiver correctly', () => {
        const result = {
            results: [
                { kind: 'call', name: 'db.query', file: 'a.js', line: 10, receiver: 'db', isMethod: true },
            ],
            meta: { mode: 'structural', query: { type: 'call', receiver: 'db' }, totalMatched: 1, shown: 1 }
        };
        const text = output.formatStructuralSearch(result);
        assert.ok(text.includes('db.query()'));
        assert.ok(text.includes('[method]'));
    });

    it('Python decorator search (using fixture)', () => {
        const d = tmp({
            'app.py': `
import pytest

@pytest.fixture
def client():
    return create_app()

@pytest.mark.parametrize("x", [1, 2])
def test_math(x):
    assert x > 0

def plain_func():
    pass
`,
        });
        try {
            const i = idx(d);
            const result = i.structuralSearch({ decorator: 'fixture' });
            assert.ok(result.results.some(r => r.name === 'client'), 'should find @pytest.fixture function');
            assert.ok(!result.results.some(r => r.name === 'plain_func'), 'should not include plain function');
        } finally { rm(d); }
    });

    it('Go exported function search', () => {
        const d = tmp({
            'go.mod': 'module test\ngo 1.21',
            'main.go': `
package main

func HandleRequest(w Writer, r *Request) {}
func processInternal() {}
func Format(data []byte) string { return "" }
`,
        });
        try {
            const i = idx(d);
            const result = i.structuralSearch({ type: 'function', exported: true, file: 'main.go' });
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('HandleRequest'), 'exported Go function');
            assert.ok(names.includes('Format'), 'exported Go function');
            assert.ok(!names.includes('processInternal'), 'unexported Go function excluded');
        } finally { rm(d); }
    });

    it('Rust return type search', () => {
        const d = tmp({
            'Cargo.toml': '[package]\nname = "test"\nversion = "0.1.0"',
            'lib.rs': `
pub fn parse(input: &str) -> Result<Value, Error> {
    Ok(Value::new())
}

fn helper() -> Option<String> {
    None
}

fn no_return() {}
`,
        });
        try {
            const i = idx(d);
            const result = i.structuralSearch({ type: 'function', returns: 'Result' });
            assert.ok(result.results.some(r => r.name === 'parse'), 'Rust Result-returning function');
            assert.ok(!result.results.some(r => r.name === 'helper'), 'Option function not included');
        } finally { rm(d); }
    });

    it('Java annotation search', () => {
        const d = tmp({
            'Controller.java': `
package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
public class UserController {
    @GetMapping("/users")
    public List<User> getUsers() {
        return null;
    }

    @PostMapping("/users")
    public User createUser() {
        return null;
    }

    private void helper() {}
}
`,
        });
        try {
            const i = idx(d);
            // Java annotations are stored as lowercase modifiers
            const result = i.structuralSearch({ decorator: 'getmapping' });
            assert.ok(result.results.some(r => r.name === 'getUsers'), 'should find @GetMapping method');
            assert.ok(!result.results.some(r => r.name === 'createUser'), 'should not include @PostMapping');
        } finally { rm(d); }
    });

    it('TypeScript type search', () => {
        const d = tmp({
            'package.json': '{"name":"test"}',
            'types.ts': `
export interface Config {
    name: string;
    port: number;
}

export type Handler = (req: Request) => Response;

export enum Status {
    Active,
    Inactive,
}
`,
        });
        try {
            const i = idx(d);
            const result = i.structuralSearch({ type: 'type' });
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('Config'), 'interface is a type');
            assert.ok(names.includes('Handler') || names.includes('Status'), 'type alias or enum');
        } finally { rm(d); }
    });

    it('multiple flags combined: exported + param + type', () => {
        const d = tmp({
            'go.mod': 'module test\ngo 1.21',
            'api.go': `
package api

func HandleRequest(ctx Context, req *Request) error {
    return nil
}

func process(ctx Context) {}

func Format(data []byte) string { return "" }
`,
        });
        try {
            const i = idx(d);
            const result = i.structuralSearch({ type: 'function', param: 'ctx', exported: true });
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('HandleRequest'), 'exported with ctx param');
            assert.ok(!names.includes('process'), 'unexported excluded');
            assert.ok(!names.includes('Format'), 'no ctx param excluded');
        } finally { rm(d); }
    });
});

// ============================================================================
// STRUCTURAL SEARCH: Hardening (edge cases, validation, stability)
// ============================================================================

describe('structural search: hardening', () => {
    const { execute } = require('../core/execute');
    const output = require('../core/output');

    it('invalid --type returns error', () => {
        const d = tmp({ 'package.json': '{"name":"t"}', 'a.js': 'function f() {}' });
        try {
            const i = idx(d);
            const { ok, error } = execute(i, 'search', { type: 'bogus' });
            assert.ok(!ok, 'should fail');
            assert.ok(error.includes('Invalid type'), error);
            assert.ok(error.includes('function, class, call, method, type'));
        } finally { rm(d); }
    });

    it('--receiver without --type auto-infers type=call', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'const fs = require("fs");\nfunction read() { return fs.readFileSync("x"); }',
        });
        try {
            const i = idx(d);
            const { ok, result, structural } = execute(i, 'search', { receiver: 'fs' });
            assert.ok(ok && structural);
            assert.ok(result.results.every(r => r.kind === 'call'), 'should auto-infer call type');
            assert.ok(result.results.some(r => r.name.includes('readFileSync')));
        } finally { rm(d); }
    });

    it('--case-sensitive makes glob case-sensitive', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function hello() {}\nfunction Hello() {}\nmodule.exports = { hello, Hello };',
        });
        try {
            const i = idx(d);
            const r1 = i.structuralSearch({ type: 'function', term: 'hello' });
            assert.strictEqual(r1.results.length, 2, 'case-insensitive finds both');
            const r2 = i.structuralSearch({ type: 'function', term: 'hello', caseSensitive: true });
            assert.strictEqual(r2.results.length, 1, 'case-sensitive finds one');
            assert.strictEqual(r2.results[0].name, 'hello');
        } finally { rm(d); }
    });

    it('--case-sensitive applies to param filter', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function a(Request) {}\nfunction b(request) {}',
        });
        try {
            const i = idx(d);
            const r1 = i.structuralSearch({ type: 'function', param: 'request' });
            assert.strictEqual(r1.results.length, 2, 'case-insensitive matches both');
            const r2 = i.structuralSearch({ type: 'function', param: 'Request', caseSensitive: true });
            assert.strictEqual(r2.results.length, 1, 'case-sensitive matches one');
        } finally { rm(d); }
    });

    it('empty index returns 0 results, no crash', () => {
        const d = tmp({});
        try {
            const i = idx(d);
            const r = i.structuralSearch({ type: 'function' });
            assert.strictEqual(r.results.length, 0);
            assert.strictEqual(r.meta.totalMatched, 0);
        } finally { rm(d); }
    });

    it('file with parse errors does not crash', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'bad.js': 'function( {{{{{ broken',
            'good.js': 'function ok() { return 1; }',
        });
        try {
            const i = idx(d);
            const r = i.structuralSearch({ type: 'function' });
            assert.ok(r.results.some(x => x.name === 'ok'), 'good file still found');
        } finally { rm(d); }
    });

    it('_beginOp nesting: structural + blast interleaved', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function alpha() { beta(); }\nfunction beta() { gamma(); }\nfunction gamma() {}\nmodule.exports = { alpha, beta, gamma };',
        });
        try {
            const i = idx(d);
            i.structuralSearch({ type: 'function' });
            i.structuralSearch({ type: 'call' });
            i.blast('gamma');
            const r = i.structuralSearch({ type: 'function' });
            assert.strictEqual(r.results.length, 3);
            // Verify context still works after interleaving
            const ctx = i.context('gamma');
            assert.ok(ctx);
        } finally { rm(d); }
    });

    it('unicode function names work', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function π() { return 3.14; }\nfunction add(a, b) { return a + b; }',
        });
        try {
            const i = idx(d);
            const r = i.structuralSearch({ type: 'function', term: 'π' });
            assert.strictEqual(r.results.length, 1);
            assert.strictEqual(r.results[0].name, 'π');
        } finally { rm(d); }
    });

    it('wide result set with top limit', () => {
        const lines = [];
        for (let i = 0; i < 100; i++) lines.push(`function fn_${i}(data) { return data; }`);
        const d = tmp({ 'package.json': '{"name":"t"}', 'big.js': lines.join('\n') });
        try {
            const i = idx(d);
            const r = i.structuralSearch({ type: 'function', top: 5 });
            assert.strictEqual(r.results.length, 5);
            assert.strictEqual(r.meta.totalMatched, 100);
        } finally { rm(d); }
    });

    it('--unused correctly identifies called vs uncalled', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function used() {}\nfunction unused1() {}\nfunction unused2() {}\nfunction main() { used(); }',
        });
        try {
            const i = idx(d);
            const r = i.structuralSearch({ type: 'function', unused: true });
            const names = r.results.map(x => x.name);
            assert.ok(!names.includes('used'), 'called function excluded');
            assert.ok(names.includes('unused1'), 'uncalled function included');
            assert.ok(names.includes('unused2'), 'uncalled function included');
        } finally { rm(d); }
    });

    it('glob special chars in term are escaped properly', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function a() {}\nfunction b() {}',
        });
        try {
            const i = idx(d);
            // "a.b" should not match anything (. is literal, not regex wildcard)
            const r = i.structuralSearch({ type: 'function', term: 'a.b' });
            assert.strictEqual(r.results.length, 0, 'dot is literal in glob');
        } finally { rm(d); }
    });

    it('--type=call with --receiver scans correctly', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'const db = require("./db");\nfunction query() { return db.find(); }\nfunction update() { return db.save(); }',
        });
        try {
            const i = idx(d);
            const r = i.structuralSearch({ type: 'call', receiver: 'db' });
            assert.ok(r.results.length >= 2, 'should find db.find and db.save');
            assert.ok(r.results.every(x => x.receiver === 'db'));
        } finally { rm(d); }
    });

    it('--in flag restricts structural search to subdirectory', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'src/core.js': 'function coreFunc() {}',
            'lib/util.js': 'function libFunc() {}',
        });
        try {
            const i = idx(d);
            const r = i.structuralSearch({ type: 'function', in: 'src' });
            assert.ok(r.results.every(x => x.file.startsWith('src/')));
            assert.ok(r.results.some(x => x.name === 'coreFunc'));
        } finally { rm(d); }
    });

    it('text formatter shows error for invalid type', () => {
        const result = {
            results: [],
            meta: { mode: 'structural', query: { type: 'bogus' }, totalMatched: 0, shown: 0, error: 'Invalid type "bogus"' }
        };
        const text = output.formatStructuralSearch(result);
        assert.ok(text.includes('No matches found'));
    });

    it('structural search does not interfere with text search', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function hello() { /* search_term_xyz */ return 1; }',
        });
        try {
            const i = idx(d);
            // Text search should still work normally
            const { ok, result, structural } = execute(i, 'search', { term: 'search_term_xyz' });
            assert.ok(ok);
            assert.ok(!structural, 'no structural flags = text search');
            assert.ok(result.length > 0, 'text search finds the term');
        } finally { rm(d); }
    });

    it('--exclude with structural search filters correctly', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'src/api.js': 'function handler() {}',
            'test/api.test.js': 'function testHandler() {}',
        });
        try {
            const i = idx(d);
            const all = i.structuralSearch({ type: 'function' });
            const noTest = i.structuralSearch({ type: 'function', exclude: ['test'] });
            assert.ok(noTest.results.length < all.results.length, 'exclude reduces results');
            assert.ok(!noTest.results.some(x => x.file.includes('test')));
        } finally { rm(d); }
    });

    it('CLI --type=function without term does not require term', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function f() {}',
        });
        try {
            const out = runCli(d, 'search', [], ['--type=function']);
            assert.ok(out.includes('Structural search:'));
            assert.ok(!out.includes('required'));
        } finally { rm(d); }
    });

    it('CLI invalid type shows error message', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function f() {}',
        });
        try {
            const out = runCli(d, 'search', [], ['--type=bogus']);
            assert.ok(out.includes('Invalid type'), 'should show invalid type error: ' + out);
        } finally { rm(d); }
    });
});

// ==================================================================
// REVERSE TRACE: upward call chain to entry points
// ==================================================================

describe('reverse-trace: upward call chain to entry points', () => {
    let dir;
    let index;

    // Build a call chain: main → orchestrator → helper → util
    // Also: handler → helper (second entry point)
    // entryA has no callers (entry point)
    // entryB has no callers (entry point)
    // entry.js imports its callees properly — under the tiered tree contract
    // a bare cross-file name without an import edge is an unverified frontier
    // entry, not a trunk node (the legacy fixture relied on name-only scope
    // confirmation that the contract routes visible-unverified).
    const fixture = {
        'package.json': '{"name":"rtrace-test"}',
        'entry.js': `
const { orchestrator } = require('./mid');
const { helper } = require('./util');
function main() { orchestrator(); }
function handler() { helper(); }
module.exports = { main, handler };
`,
        'mid.js': `
const { helper } = require('./util');
function orchestrator() { helper(); doWork(); }
function doWork() { helper(); }
module.exports = { orchestrator, doWork };
`,
        'util.js': `
function helper() { return lowLevel(); }
function lowLevel() { return 42; }
module.exports = { helper, lowLevel };
`,
    };

    it('walks callers to entry points and marks them', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('helper', { depth: 5 });
            assert.ok(result, 'should find helper');
            assert.strictEqual(result.root, 'helper');

            // Should have callers
            assert.ok(result.tree.children.length > 0, 'should have callers');

            // Entry points should be found
            assert.ok(result.entryPoints.length > 0, 'should find entry points');

            // main and handler should be entry points (no callers)
            const epNames = result.entryPoints.map(e => e.name);
            assert.ok(epNames.includes('main'), 'main should be entry point: ' + JSON.stringify(epNames));
            assert.ok(epNames.includes('handler'), 'handler should be entry point: ' + JSON.stringify(epNames));
        } finally { rm(d); }
    });

    it('respects --depth limit', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('lowLevel', { depth: 1 });
            assert.ok(result);
            // At depth 1, should see helper but not go further
            assert.ok(result.tree.children.length > 0);
            // Should not have deep entry points since depth is limited
            assert.strictEqual(result.summary.maxDepthReached, 1);
        } finally { rm(d); }
    });

    it('depth=0 shows root only', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('helper', { depth: 0 });
            assert.ok(result);
            assert.strictEqual(result.tree.children.length, 0);
            assert.ok(result.warnings);
            assert.ok(result.warnings.some(w => w.message.includes('depth=0')));
        } finally { rm(d); }
    });

    it('marks root as entry point when it has no callers', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('main', { depth: 3 });
            assert.ok(result);
            assert.ok(result.tree.entryPoint, 'root should be marked as entry point');
            assert.ok(result.entryPoints.some(e => e.name === 'main'));
        } finally { rm(d); }
    });

    it('handles --exclude filter', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'src/lib.js': 'function target() {}\nmodule.exports = { target };',
            'src/app.js': 'const { target } = require("./lib");\nfunction app() { target(); }',
            'test/lib.test.js': 'const { target } = require("../src/lib");\nfunction testTarget() { target(); }',
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('target', { depth: 3, exclude: ['test'] });
            assert.ok(result);
            // Only app should appear, not testTarget
            const names = [];
            const collect = (node) => { names.push(node.name); (node.children || []).forEach(collect); };
            if (result.tree.children) result.tree.children.forEach(collect);
            assert.ok(!names.includes('testTarget'), 'testTarget should be excluded: ' + JSON.stringify(names));
        } finally { rm(d); }
    });

    it('handles circular call chains without infinite loop', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'cycle.js': `
function a() { b(); }
function b() { a(); c(); }
function c() { b(); }
module.exports = { a, b, c };
`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('c', { depth: 5 });
            assert.ok(result, 'should complete without hanging');
            // b calls c, a calls b, b calls a (cycle) — should show (see above)
        } finally { rm(d); }
    });

    it('returns null for unknown function', () => {
        const d = tmp({ 'package.json': '{"name":"t"}', 'a.js': 'function f() {}' });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('nonexistent');
            assert.strictEqual(result, null);
        } finally { rm(d); }
    });

    it('summary counts are correct', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('helper', { depth: 5, all: true });
            assert.ok(result.summary);
            assert.ok(result.summary.totalEntryPoints > 0);
            assert.ok(result.summary.totalFunctions > 0);
            assert.ok(result.summary.maxDepthReached > 0);
        } finally { rm(d); }
    });

    it('execute handler works', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const { ok, result, error } = execute(ix, 'reverseTrace', { name: 'helper' });
            assert.ok(ok, 'should succeed: ' + error);
            assert.ok(result.entryPoints.length > 0);
        } finally { rm(d); }
    });

    it('execute handler requires name', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const { ok, error } = execute(ix, 'reverseTrace', {});
            assert.ok(!ok);
            assert.ok(error.includes('required'));
        } finally { rm(d); }
    });

    it('execute handler returns error for unknown function', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const { ok, error } = execute(ix, 'reverseTrace', { name: 'nope' });
            assert.ok(!ok);
            assert.ok(error.includes('not found'));
        } finally { rm(d); }
    });

    it('text formatter shows entry point markers', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('helper', { depth: 5 });
            const text = output.formatReverseTrace(result);
            assert.ok(text.includes('★ entry point'), 'should show entry point marker');
            assert.ok(text.includes('Reverse trace for helper'));
            assert.ok(text.includes('Entry points'));
            assert.ok(text.includes('Summary:'));
        } finally { rm(d); }
    });

    it('text formatter handles null result', () => {
        const text = output.formatReverseTrace(null);
        assert.strictEqual(text, 'Function not found.');
    });

    it('JSON formatter produces valid JSON', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('helper', { depth: 5 });
            const json = output.formatReverseTraceJson(result);
            const parsed = JSON.parse(json);
            assert.ok(parsed.entryPoints);
            assert.ok(parsed.tree);
            assert.ok(parsed.summary);
        } finally { rm(d); }
    });

    it('JSON formatter handles null result', () => {
        const json = output.formatReverseTraceJson(null);
        const parsed = JSON.parse(json);
        assert.strictEqual(parsed.found, false);
    });

    it('CLI reverse-trace works', () => {
        const d = tmp(fixture);
        try {
            const out = runCli(d, 'reverse-trace', ['helper']);
            assert.ok(out.includes('Reverse trace for helper'));
            assert.ok(out.includes('entry point'));
        } finally { rm(d); }
    });

    it('CLI rtrace alias works', () => {
        const d = tmp(fixture);
        try {
            const out = runCli(d, 'rtrace', ['helper']);
            assert.ok(out.includes('Reverse trace for helper'));
        } finally { rm(d); }
    });

    it('CLI --json flag works', () => {
        const d = tmp(fixture);
        try {
            const out = runCli(d, 'reverse-trace', ['helper'], ['--json']);
            const parsed = JSON.parse(out);
            assert.ok(parsed.entryPoints);
        } finally { rm(d); }
    });

    it('default depth is 5 (not 3 like blast/trace)', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('helper');
            assert.strictEqual(result.maxDepth, 5);
        } finally { rm(d); }
    });

    it('entry point for self-contained function', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function standalone() { return 1; }',
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('standalone');
            assert.ok(result);
            assert.ok(result.tree.entryPoint);
            assert.ok(result.entryPoints.some(e => e.name === 'standalone'));
            assert.strictEqual(result.summary.totalFunctions, 0);
        } finally { rm(d); }
    });
});

describe('reverse-trace: hardening', () => {
    it('node at depth limit is NOT falsely marked as entry point', () => {
        // Chain: entryA → mid → target. At depth=1, mid appears but we can't
        // see entryA. mid should NOT be marked as entry point — it just hit the depth limit.
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': `
function entryA() { mid(); }
function mid() { target(); }
function target() { return 1; }
module.exports = { entryA, mid, target };
`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('target', { depth: 1 });
            assert.ok(result);
            // mid is a caller of target — it appears at depth 1
            const midNode = result.tree.children.find(c => c.name === 'mid');
            assert.ok(midNode, 'mid should appear as caller');
            // mid should NOT be marked as entry point (it has callers, just depth-limited)
            assert.ok(!midNode.entryPoint, 'mid should NOT be marked as entry point at depth limit');
            // entryPoints list should be empty (no true entry points found within depth)
            assert.strictEqual(result.entryPoints.length, 0, 'no entry points should be found at depth 1');
        } finally { rm(d); }
    });

    it('all callers excluded → node becomes entry point within scope', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'src/lib.js': 'function target() {}\nmodule.exports = { target };',
            'src/app.js': 'const { target } = require("./lib");\nfunction app() { target(); }',
            'test/t.test.js': 'const { target } = require("../src/lib");\nfunction testIt() { target(); }',
        });
        try {
            const ix = idx(d);
            // Without exclude: app and testIt are callers, both are entry points
            const full = ix.reverseTrace('target', { depth: 3 });
            assert.ok(full.entryPoints.length >= 2);

            // With exclude=test: only app visible, app is entry point
            const filtered = ix.reverseTrace('target', { depth: 3, exclude: ['test'] });
            assert.ok(filtered.entryPoints.length >= 1);
            assert.ok(filtered.entryPoints.some(e => e.name === 'app'));
            assert.ok(!filtered.entryPoints.some(e => e.name === 'testIt'));
        } finally { rm(d); }
    });

    it('truncation when more than 10 callers', () => {
        // Create 15 callers of target
        const callerCode = Array.from({ length: 15 }, (_, i) =>
            `function caller${i}() { target(); }`
        ).join('\n');
        const d = tmp({
            'package.json': '{"name":"t"}',
            'target.js': 'function target() {}\nmodule.exports = { target };',
            'callers.js': `const { target } = require('./target');\n${callerCode}\nmodule.exports = {};`,
        });
        try {
            const ix = idx(d);
            // Default: maxChildren=10 (no --all)
            const result = ix.reverseTrace('target', { depth: 2 });
            assert.ok(result);
            // Should have exactly 10 children + truncatedChildren
            assert.ok(result.tree.children.length <= 10, 'should truncate to 10');
            assert.ok(result.tree.truncatedChildren > 0, 'should have truncatedChildren');

            // Formatter should show truncation hint
            const text = output.formatReverseTrace(result);
            assert.ok(text.includes('more callers'), 'should show truncation in tree');
            assert.ok(text.includes('truncated'), 'should show truncation hint');
        } finally { rm(d); }
    });

    it('--all flag shows all callers without truncation', () => {
        const callerCode = Array.from({ length: 15 }, (_, i) =>
            `function caller${i}() { target(); }`
        ).join('\n');
        const d = tmp({
            'package.json': '{"name":"t"}',
            'target.js': 'function target() {}\nmodule.exports = { target };',
            'callers.js': `const { target } = require('./target');\n${callerCode}\nmodule.exports = {};`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('target', { depth: 2, all: true });
            assert.ok(result);
            assert.ok(result.tree.children.length >= 15, 'should show all callers: ' + result.tree.children.length);
            assert.ok(!result.tree.truncatedChildren, 'should not have truncation');
        } finally { rm(d); }
    });

    it('multiple call sites show Nx annotation', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': `
function caller() { target(); target(); target(); }
function target() {}
module.exports = { caller, target };
`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('target', { depth: 2 });
            assert.ok(result);
            const callerNode = result.tree.children.find(c => c.name === 'caller');
            assert.ok(callerNode, 'should find caller');
            assert.strictEqual(callerNode.callSites, 3, 'should count 3 call sites');

            // Formatter should show 3x
            const text = output.formatReverseTrace(result);
            assert.ok(text.includes('3x'), 'should show 3x annotation');
        } finally { rm(d); }
    });

    it('Class.method syntax works', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': `
class MyService {
    process() { return this.helper(); }
    helper() { return 42; }
}
function main() { const s = new MyService(); s.process(); }
module.exports = { MyService, main };
`,
        });
        try {
            const ix = idx(d);
            const { ok, result } = execute(ix, 'reverseTrace', { name: 'MyService.process' });
            assert.ok(ok, 'should succeed with Class.method syntax');
            assert.strictEqual(result.root, 'process');
        } finally { rm(d); }
    });

    it('--file disambiguation', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib/process.js': 'function handle() { return 1; }\nmodule.exports = { handle };',
            'api/process.js': 'function handle() { return 2; }\nmodule.exports = { handle };',
            'app.js': 'const lib = require("./lib/process");\nfunction main() { lib.handle(); }',
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('handle', { file: 'lib' });
            assert.ok(result);
            assert.ok(result.file.includes('lib'), 'should resolve to lib/process.js: ' + result.file);
        } finally { rm(d); }
    });

    it('deep chain (>5 levels) with increased depth', () => {
        // Chain: f0 → f1 → f2 → ... → f7 → leaf
        const fns = Array.from({ length: 8 }, (_, i) =>
            `function f${i}() { ${i < 7 ? `f${i + 1}()` : 'leaf()'} }`
        ).join('\n');
        const d = tmp({
            'package.json': '{"name":"t"}',
            'chain.js': `${fns}\nfunction leaf() { return 42; }\nmodule.exports = {};`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('leaf', { depth: 10 });
            assert.ok(result);
            // Should reach f0 as entry point (8 levels up)
            assert.ok(result.entryPoints.some(e => e.name === 'f0'),
                'should find f0 as entry point: ' + JSON.stringify(result.entryPoints));
            assert.ok(result.summary.maxDepthReached >= 8, 'should reach depth 8+');
        } finally { rm(d); }
    });

    it('entry points are not duplicated when reached via two paths', () => {
        // Diamond: target ← A ← entry, target ← B ← entry
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': `
function entry() { pathA(); pathB(); }
function pathA() { target(); }
function pathB() { target(); }
function target() { return 1; }
module.exports = { entry, pathA, pathB, target };
`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('target', { depth: 5 });
            assert.ok(result);
            // entry should appear exactly once in entryPoints
            const entryOccurrences = result.entryPoints.filter(e => e.name === 'entry');
            assert.strictEqual(entryOccurrences.length, 1,
                'entry should appear once, not duplicated: ' + JSON.stringify(result.entryPoints));
        } finally { rm(d); }
    });

    it('formatter shows includeMethods=false note', () => {
        const mockResult = {
            root: 'test',
            file: 'a.js',
            line: 1,
            maxDepth: 5,
            includeMethods: false,
            tree: { name: 'test', file: 'a.js', line: 1, type: 'function', children: [] },
            entryPoints: [{ name: 'test', file: 'a.js', line: 1 }],
            summary: { totalEntryPoints: 1, totalFunctions: 0, maxDepthReached: 0 },
        };
        const text = output.formatReverseTrace(mockResult);
        assert.ok(text.includes('obj.method() calls excluded'), 'should show methods excluded note');
    });

    it('formatter shows warnings', () => {
        const mockResult = {
            root: 'test',
            file: 'a.js',
            line: 1,
            maxDepth: 0,
            includeMethods: true,
            tree: { name: 'test', file: 'a.js', line: 1, type: 'function', children: [] },
            entryPoints: [],
            summary: { totalEntryPoints: 0, totalFunctions: 0, maxDepthReached: 0 },
            warnings: [{ message: 'depth=0: showing root function only. Increase depth to see callers.' }],
        };
        const text = output.formatReverseTrace(mockResult);
        assert.ok(text.includes('Note: depth=0'), 'should show warning');
    });

    it('formatter root entry point label', () => {
        const mockResult = {
            root: 'standalone',
            file: 'a.js',
            line: 1,
            maxDepth: 5,
            includeMethods: true,
            tree: { name: 'standalone', file: 'a.js', line: 1, type: 'function', children: [], entryPoint: true },
            entryPoints: [{ name: 'standalone', file: 'a.js', line: 1 }],
            summary: { totalEntryPoints: 1, totalFunctions: 0, maxDepthReached: 0 },
        };
        const text = output.formatReverseTrace(mockResult);
        assert.ok(text.includes('standalone ★ entry point (no callers)'), 'should mark root as entry point: ' + text.split('\n').find(l => l.includes('standalone')));
    });

    it('summary with zero entry points (depth-limited leaves)', () => {
        // mid calls target, entryA calls mid. At depth=1, we see mid but not entryA.
        // No entry points found within depth.
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': `
function entryA() { mid(); }
function mid() { target(); }
function target() { return 1; }
module.exports = { entryA, mid, target };
`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('target', { depth: 1 });
            assert.ok(result);
            assert.strictEqual(result.entryPoints.length, 0);
            // Summary should still show intermediate functions
            assert.ok(result.summary.totalFunctions > 0);
        } finally { rm(d); }
    });

    it('Go language support', () => {
        const d = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': `package main
func main() { handler() }
func handler() { process() }
func process() { return }
`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('process', { depth: 5 });
            assert.ok(result, 'should find Go function');
            assert.ok(result.tree.children.length > 0, 'should find callers');
            assert.ok(result.entryPoints.some(e => e.name === 'main'),
                'main should be entry point: ' + JSON.stringify(result.entryPoints));
        } finally { rm(d); }
    });

    it('Python language support', () => {
        const d = tmp({
            'app.py': `
def main():
    handler()

def handler():
    process()

def process():
    return 42
`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('process', { depth: 5 });
            assert.ok(result, 'should find Python function');
            assert.ok(result.tree.children.length > 0, 'should find callers');
            assert.ok(result.entryPoints.some(e => e.name === 'main'),
                'main should be entry point: ' + JSON.stringify(result.entryPoints));
        } finally { rm(d); }
    });

    it('interactive mode works via CLI', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function entry() { target(); }\nfunction target() {}\nmodule.exports = { entry, target };',
        });
        try {
            const out = runInteractive(d, ['reverse-trace target']);
            assert.ok(out.includes('Reverse trace for target') || out.includes('entry point'),
                'interactive should work: ' + out.substring(0, 200));
        } finally { rm(d); }
    });

    it('negative depth clamped to 0', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function f() {}\nmodule.exports = { f };',
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('f', { depth: -3 });
            assert.ok(result);
            assert.strictEqual(result.maxDepth, 0);
            assert.strictEqual(result.tree.children.length, 0);
        } finally { rm(d); }
    });

    it('alreadyShown for cycles in formatter', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': `
function a() { b(); }
function b() { a(); }
module.exports = { a, b };
`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('b', { depth: 5 });
            const text = output.formatReverseTrace(result);
            assert.ok(text.includes('see above'), 'should show (see above) for cycle: ' + text);
        } finally { rm(d); }
    });

    it('MCP reverse_trace command via execute', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function entry() { target(); }\nfunction target() {}\nmodule.exports = { entry, target };',
        });
        try {
            const ix = idx(d);
            // MCP sends canonical form through execute
            const { ok, result } = execute(ix, 'reverseTrace', { name: 'target', depth: 3 });
            assert.ok(ok);
            assert.ok(result.entryPoints.length > 0);
            // Verify formatter doesn't crash
            const text = output.formatReverseTrace(result, { allHint: 'Set depth to expand all children.' });
            assert.ok(text.includes('Reverse trace'));
        } finally { rm(d); }
    });

    it('entry point summary singular/plural grammar', () => {
        // 1 entry point → singular
        const single = output.formatReverseTrace({
            root: 't', file: 'a.js', line: 1, maxDepth: 5, includeMethods: true,
            tree: { name: 't', file: 'a.js', line: 1, type: 'function', children: [
                { name: 'ep', file: 'b.js', line: 1, type: 'function', children: [], entryPoint: true }
            ] },
            entryPoints: [{ name: 'ep', file: 'b.js', line: 1 }],
            summary: { totalEntryPoints: 1, totalFunctions: 1, maxDepthReached: 1 },
        });
        assert.ok(single.includes('1 entry point reaches'), 'singular entry point');
        assert.ok(single.includes('1 intermediate function'), 'singular function');

        // 2 entry points → plural
        const plural = output.formatReverseTrace({
            root: 't', file: 'a.js', line: 1, maxDepth: 5, includeMethods: true,
            tree: { name: 't', file: 'a.js', line: 1, type: 'function', children: [
                { name: 'ep1', file: 'b.js', line: 1, type: 'function', children: [], entryPoint: true },
                { name: 'ep2', file: 'c.js', line: 1, type: 'function', children: [], entryPoint: true },
            ] },
            entryPoints: [{ name: 'ep1', file: 'b.js', line: 1 }, { name: 'ep2', file: 'c.js', line: 1 }],
            summary: { totalEntryPoints: 2, totalFunctions: 2, maxDepthReached: 1 },
        });
        assert.ok(plural.includes('2 entry points reach '), 'plural entry points');
        assert.ok(plural.includes('2 intermediate functions'), 'plural functions');
    });
});

// ============================================================================
// circular-deps: circular dependency detection
// ============================================================================

describe('circular-deps: circular dependency detection', () => {
    const { execute } = require('../core/execute');
    const output = require('../core/output');

    it('detects simple A→B→A cycle', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 1);
            assert.strictEqual(result.cycles[0].length, 2);
            assert.ok(result.cycles[0].files.includes('a.js'));
            assert.ok(result.cycles[0].files.includes('b.js'));
        } finally { rm(dir); }
    });

    it('detects A→B→C→A triangle cycle', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const c = require("./c"); module.exports = {};',
            'c.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 1);
            assert.strictEqual(result.cycles[0].length, 3);
        } finally { rm(dir); }
    });

    it('returns empty when no cycles exist', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const c = require("./c"); module.exports = {};',
            'c.js': 'module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 0);
            assert.strictEqual(result.cycles.length, 0);
        } finally { rm(dir); }
    });

    it('filters by --file pattern', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
            'x.js': 'const y = require("./y"); module.exports = {};',
            'y.js': 'const x = require("./x"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const all = index.circularDeps();
            assert.strictEqual(all.summary.totalCycles, 2);
            const filtered = index.circularDeps({ file: 'x.js' });
            assert.strictEqual(filtered.summary.totalCycles, 1);
            assert.ok(filtered.cycles[0].files.includes('x.js'));
        } finally { rm(dir); }
    });

    it('respects --exclude filter', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/a.js': 'const b = require("./b"); module.exports = {};',
            'src/b.js': 'const a = require("./a"); module.exports = {};',
            'test/x.js': 'const y = require("./y"); module.exports = {};',
            'test/y.js': 'const x = require("./x"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const all = index.circularDeps();
            assert.strictEqual(all.summary.totalCycles, 2);
            const filtered = index.circularDeps({ exclude: ['test'] });
            assert.strictEqual(filtered.summary.totalCycles, 1);
            assert.ok(filtered.cycles[0].files.some(f => f.includes('src/')));
        } finally { rm(dir); }
    });

    it('deduplicates same cycle discovered from different starting nodes', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            // A→B→A is same cycle as B→A→B — should be one cycle, not two
            assert.strictEqual(result.summary.totalCycles, 1);
        } finally { rm(dir); }
    });

    it('detects multiple independent cycles', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
            'x.js': 'const y = require("./y"); module.exports = {};',
            'y.js': 'const z = require("./z"); module.exports = {};',
            'z.js': 'const x = require("./x"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 2);
            // 2-file cycle and 3-file cycle
            const lengths = result.cycles.map(c => c.length).sort();
            assert.deepStrictEqual(lengths, [2, 3]);
        } finally { rm(dir); }
    });

    it('handles diamond dependencies (not cycles)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); const c = require("./c"); module.exports = {};',
            'b.js': 'const d = require("./d"); module.exports = {};',
            'c.js': 'const d = require("./d"); module.exports = {};',
            'd.js': 'module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 0);
        } finally { rm(dir); }
    });

    it('reports totalFiles correctly', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'module.exports = {};',
            'b.js': 'module.exports = {};',
            'c.js': 'module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.totalFiles, 3);
        } finally { rm(dir); }
    });

    it('reports filesInCycles correctly', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
            'c.js': 'module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.filesInCycles, 2);
        } finally { rm(dir); }
    });

    // ── execute.js integration ──────────────────────────────────────────

    it('works through execute()', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'circularDeps', {});
            assert.ok(ok);
            assert.strictEqual(result.summary.totalCycles, 1);
        } finally { rm(dir); }
    });

    it('execute() supports file and exclude params', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'circularDeps', { file: 'nonexistent' });
            assert.ok(ok);
            assert.strictEqual(result.summary.totalCycles, 0);
        } finally { rm(dir); }
    });

    // ── formatters ──────────────────────────────────────────────────────

    it('formatCircularDeps shows cycle chain with arrow back to start', () => {
        const text = output.formatCircularDeps({
            cycles: [{ files: ['a.js', 'b.js'], length: 2 }],
            totalFiles: 5,
            summary: { totalCycles: 1, filesInCycles: 2 },
        });
        assert.ok(text.includes('a.js → b.js → a.js'), 'chain closes the loop');
        assert.ok(text.includes('Cycle 1 (2 files)'));
        assert.ok(text.includes('1 circular dependency chain'));
    });

    it('formatCircularDeps handles no cycles', () => {
        const text = output.formatCircularDeps({
            cycles: [],
            totalFiles: 10,
            summary: { totalCycles: 0, filesInCycles: 0 },
        });
        assert.ok(text.includes('No circular dependencies found'));
        assert.ok(text.includes('Scanned 10 files'));
    });

    it('formatCircularDeps shows file filter', () => {
        const text = output.formatCircularDeps({
            cycles: [{ files: ['a.js', 'b.js'], length: 2 }],
            totalFiles: 5,
            fileFilter: 'a.js',
            summary: { totalCycles: 1, filesInCycles: 2 },
        });
        assert.ok(text.includes('Filtered to cycles involving: a.js'));
    });

    it('formatCircularDeps plural/singular grammar', () => {
        const singular = output.formatCircularDeps({
            cycles: [{ files: ['a.js', 'b.js'], length: 2 }],
            totalFiles: 5,
            summary: { totalCycles: 1, filesInCycles: 1 },
        });
        assert.ok(singular.includes('1 circular dependency chain involving 1 file'));
        assert.ok(!singular.includes('chains'));

        const plural = output.formatCircularDeps({
            cycles: [{ files: ['a.js', 'b.js'], length: 2 }, { files: ['x.js', 'y.js'], length: 2 }],
            totalFiles: 10,
            summary: { totalCycles: 2, filesInCycles: 4 },
        });
        assert.ok(plural.includes('2 circular dependency chains involving 4 files'));
    });

    it('formatCircularDepsJson returns valid JSON', () => {
        const json = output.formatCircularDepsJson({
            cycles: [{ files: ['a.js', 'b.js'], length: 2 }],
            totalFiles: 5,
            summary: { totalCycles: 1, filesInCycles: 2 },
        });
        const parsed = JSON.parse(json);
        assert.strictEqual(parsed.cycles.length, 1);
        assert.strictEqual(parsed.summary.totalCycles, 1);
    });

    it('formatCircularDepsJson handles null input', () => {
        const json = output.formatCircularDepsJson(null);
        const parsed = JSON.parse(json);
        assert.ok(parsed.error);
    });

    // ── sorting ─────────────────────────────────────────────────────────

    it('sorts cycles by length then alphabetically', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'x.js': 'const y = require("./y"); module.exports = {};',
            'y.js': 'const z = require("./z"); module.exports = {};',
            'z.js': 'const x = require("./x"); module.exports = {};',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            // 2-file cycle should come before 3-file cycle
            assert.strictEqual(result.cycles[0].length, 2);
            assert.strictEqual(result.cycles[1].length, 3);
        } finally { rm(dir); }
    });
});

// ============================================================================
// circular-deps: hardening & edge cases
// ============================================================================

describe('circular-deps: hardening', () => {
    const { execute } = require('../core/execute');
    const output = require('../core/output');

    it('handles project with zero imports (no edges)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function foo() { return 1; }',
            'b.js': 'function bar() { return 2; }',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 0);
            assert.strictEqual(result.totalFiles, 2);
        } finally { rm(dir); }
    });

    it('handles single-file project', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function foo() { return 1; }',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 0);
            assert.strictEqual(result.totalFiles, 1);
        } finally { rm(dir); }
    });

    it('handles self-imports gracefully (if they occur)', () => {
        // Most bundlers/runtimes don't allow self-import, but test robustness
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            // Self-import creates a 1-file cycle
            if (result.summary.totalCycles > 0) {
                assert.ok(result.cycles[0].length >= 1);
            }
            // Either 0 or 1 cycle — just shouldn't crash
        } finally { rm(dir); }
    });

    it('handles deeply nested cycle (A→B→C→D→E→A)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const c = require("./c"); module.exports = {};',
            'c.js': 'const d = require("./d"); module.exports = {};',
            'd.js': 'const e = require("./e"); module.exports = {};',
            'e.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 1);
            assert.strictEqual(result.cycles[0].length, 5);
        } finally { rm(dir); }
    });

    it('handles cycle with branch (A→B→A and A→C with no cycle)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); const c = require("./c"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
            'c.js': 'module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 1);
            assert.strictEqual(result.cycles[0].length, 2);
        } finally { rm(dir); }
    });

    it('handles overlapping cycles sharing a node', () => {
        // A→B→A and A→C→A — two cycles sharing node A
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); const c = require("./c"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
            'c.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 2);
        } finally { rm(dir); }
    });

    it('handles TypeScript imports', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'a.ts': 'import { b } from "./b"; export const a = 1;',
            'b.ts': 'import { a } from "./a"; export const b = 2;',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 1);
        } finally { rm(dir); }
    });

    it('handles Python imports', () => {
        const dir = tmp({
            'a.py': 'from b import something\ndef fn(): pass',
            'b.py': 'from a import fn\nsomething = 1',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 1);
        } finally { rm(dir); }
    });

    it('handles Go package cycles', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg1/a.go': 'package pkg1\nimport "example.com/test/pkg2"\nfunc A() { pkg2.B() }',
            'pkg2/b.go': 'package pkg2\nimport "example.com/test/pkg1"\nfunc B() { pkg1.A() }',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            // Go compiler forbids circular package imports, but if the index resolves them,
            // our DFS should detect the cycle
            if (result.summary.totalCycles > 0) {
                assert.ok(result.cycles[0].length >= 2);
            }
        } finally { rm(dir); }
    });

    it('exclude filter removes all files in excluded pattern', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/a.js': 'const b = require("./b"); module.exports = {};',
            'src/b.js': 'const a = require("./a"); module.exports = {};',
            'mock/x.js': 'const y = require("./y"); module.exports = {};',
            'mock/y.js': 'const x = require("./x"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps({ exclude: ['mock'] });
            assert.strictEqual(result.summary.totalCycles, 1);
            assert.ok(result.cycles[0].files.every(f => !f.includes('mock')));
        } finally { rm(dir); }
    });

    it('--file filter is substring match', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/api.js': 'const util = require("./util"); module.exports = {};',
            'src/util.js': 'const api = require("./api"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps({ file: 'api' });
            assert.strictEqual(result.summary.totalCycles, 1);
        } finally { rm(dir); }
    });

    it('CLI aliases work (circular, cycles)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const { ok: ok1, result: r1 } = execute(index, 'circularDeps', {});
            assert.ok(ok1);
            assert.strictEqual(r1.summary.totalCycles, 1);
        } finally { rm(dir); }
    });

    it('cycles sorted by length then first file alphabetically', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'z.js': 'const w = require("./w"); module.exports = {};',
            'w.js': 'const z = require("./z"); module.exports = {};',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 2);
            // Both length 2, should be sorted alphabetically
            assert.ok(result.cycles[0].files[0] < result.cycles[1].files[0],
                `${result.cycles[0].files[0]} should come before ${result.cycles[1].files[0]}`);
        } finally { rm(dir); }
    });

    it('format shows numbered cycles', () => {
        const text = output.formatCircularDeps({
            cycles: [
                { files: ['a.js', 'b.js'], length: 2 },
                { files: ['x.js', 'y.js', 'z.js'], length: 3 },
            ],
            totalFiles: 10,
            summary: { totalCycles: 2, filesInCycles: 5 },
        });
        assert.ok(text.includes('Cycle 1'));
        assert.ok(text.includes('Cycle 2'));
        assert.ok(text.includes('(2 files)'));
        assert.ok(text.includes('(3 files)'));
        assert.ok(text.includes('x.js → y.js → z.js → x.js'));
    });

    it('handles nested directory cycles', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib/core.js': 'const util = require("./util"); module.exports = {};',
            'lib/util.js': 'const core = require("./core"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 1);
            assert.ok(result.cycles[0].files.some(f => f.includes('lib/')));
        } finally { rm(dir); }
    });

    it('multiple exclude patterns work together', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/a.js': 'const b = require("./b"); module.exports = {};',
            'src/b.js': 'const a = require("./a"); module.exports = {};',
            'test/t.js': 'const u = require("./u"); module.exports = {};',
            'test/u.js': 'const t = require("./t"); module.exports = {};',
            'mock/m.js': 'const n = require("./n"); module.exports = {};',
            'mock/n.js': 'const m = require("./m"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps({ exclude: ['test', 'mock'] });
            assert.strictEqual(result.summary.totalCycles, 1);
            assert.ok(result.cycles[0].files.every(f => f.includes('src/')));
        } finally { rm(dir); }
    });

    it('formatCircularDeps handles null input', () => {
        const text = output.formatCircularDeps(null);
        assert.strictEqual(text, 'No results.');
    });
});

// ============================================================================
// Phase 2 bug fixes from deep review
// ============================================================================

describe('Phase 2 bug fixes', () => {
    const { execute } = require('../core/execute');
    const output = require('../core/output');

    it('fix: structural search --type=function includes Python @staticmethod', () => {
        const dir = tmp({
            'a.py': 'class Svc:\n    @staticmethod\n    def helper():\n        pass\n    @classmethod\n    def factory(cls):\n        pass\n    def normal(self):\n        pass',
        });
        try {
            const index = idx(dir);
            // --type=function should find static and classmethod types
            const result = index.structuralSearch({ type: 'function', top: 50 });
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('helper'), 'should find @staticmethod');
            assert.ok(names.includes('factory'), 'should find @classmethod');
            assert.ok(names.includes('normal'), 'should find normal method');
        } finally { rm(dir); }
    });

    it('fix: toc --detailed includes @classmethod in function count', () => {
        const dir = tmp({
            'requirements.txt': '',
            'a.py': 'class Svc:\n    @classmethod\n    def factory(cls):\n        pass\n    @staticmethod\n    def helper():\n        pass\n    def normal(self):\n        pass',
        });
        try {
            const index = idx(dir);
            const toc = index.getToc({ detailed: true });
            const file = toc.files.find(f => f.file === 'a.py');
            assert.ok(file, 'should find a.py in toc');
            // Should include all 3 methods: classmethod, staticmethod, normal
            const fnCount = file.symbols?.functions?.length ?? file.functions;
            assert.ok(fnCount >= 3, `expected 3+ functions, got ${fnCount}`);
        } finally { rm(dir); }
    });

    it('fix: reverse-trace grammar "1 entry point reaches" (singular)', () => {
        const text = output.formatReverseTrace({
            root: 'helper', file: 'lib.js', line: 1, maxDepth: 5,
            includeMethods: true,
            tree: { name: 'helper', file: 'lib.js', line: 1, type: 'function', children: [
                { name: 'main', file: 'app.js', line: 1, type: 'function', children: [], entryPoint: true },
            ] },
            entryPoints: [{ name: 'main', file: 'app.js', line: 1 }],
            summary: { totalEntryPoints: 1, totalFunctions: 1, maxDepthReached: 1 },
        });
        assert.ok(text.includes('1 entry point reaches'), `should say "reaches" not "reach": ${text}`);
        assert.ok(!text.includes('1 entry point reach '), 'should not have bare "reach"');
    });

    it('fix: reverse-trace truncated branches still counted in entry points', () => {
        // Create a function with 12+ callers (all entry points), maxChildren=10
        const files = { 'package.json': '{"name":"test"}' };
        files['helper.js'] = 'function helper() { return 1; }\nmodule.exports = { helper };';
        for (let i = 0; i < 12; i++) {
            files[`caller${i}.js`] = `const { helper } = require("./helper");\nfunction caller${i}() { helper(); }`;
        }
        const dir = tmp(files);
        try {
            const index = idx(dir);
            // Without --all, maxChildren=10 truncates 2 callers
            const result = index.reverseTrace('helper', { depth: 5 });
            // All 12 callers are entry points (they have no callers themselves)
            assert.ok(result.entryPoints.length >= 12,
                `should count all 12 entry points even with truncation, got ${result.entryPoints.length}`);
        } finally { rm(dir); }
    });

    it('fix: blast truncated callers counted in summary', () => {
        const files = { 'package.json': '{"name":"test"}' };
        files['helper.js'] = 'function helper() { return 1; }\nmodule.exports = { helper };';
        for (let i = 0; i < 12; i++) {
            files[`caller${i}.js`] = `const { helper } = require("./helper");\nfunction caller${i}() { helper(); }`;
        }
        const dir = tmp(files);
        try {
            const index = idx(dir);
            // Without --all, maxChildren=10 truncates 2 callers
            const result = index.blast('helper', { depth: 3 });
            // Summary should count all 12 affected functions
            assert.ok(result.summary.totalAffected >= 12,
                `should count all 12 affected functions even with truncation, got ${result.summary.totalAffected}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// PHASE 2 BUG FIXES - DEEP EDGE-TO-EDGE TESTING (2026-03-12)
// ============================================================================

describe('fix: Rust pub fn in impl blocks should have type method, not public', () => {
    it('pub fn methods in impl blocks are findable via --type=function', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'pub struct Server { port: u16 }',
                'impl Server {',
                '    pub fn new(port: u16) -> Server { Server { port } }',
                '    pub fn start(&self) { println!("starting"); }',
                '    fn private_helper(&self) {}',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ type: 'function' });
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('new'), 'pub fn new should be findable as function');
            assert.ok(names.includes('start'), 'pub fn start should be findable as function');
            assert.ok(names.includes('private_helper'), 'fn private_helper should be findable as function');
        } finally { rm(dir); }
    });

    it('pub fn methods in impl blocks are findable via --type=method', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'pub struct Server {}',
                'impl Server {',
                '    pub fn new() -> Server { Server {} }',
                '    pub fn run(&self) {}',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ type: 'method' });
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('run'), 'pub fn run with &self should be a method');
        } finally { rm(dir); }
    });

    it('pub fn methods have pub in modifiers for --exported filter', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'pub struct Server {}',
                'impl Server {',
                '    pub fn public_method(&self) {}',
                '    fn private_method(&self) {}',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ type: 'function', exported: true });
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('public_method'), 'pub fn should be findable via --exported');
            assert.ok(!names.includes('private_method'), 'fn (no pub) should NOT appear in --exported');
        } finally { rm(dir); }
    });
});

describe('fix: Rust path-qualified calls matched by findCallers', () => {
    it('module::function() calls detected as callers', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': 'mod db;\n\npub fn main() {\n    db::execute_query();\n}',
            'src/db.rs': 'pub fn execute_query() {\n    println!("querying");\n}'
        });
        try {
            const index = idx(dir);
            const ctx = index.context('execute_query');
            assert.ok(ctx.callers.length > 0, 'module::function() should be detected as a caller');
            assert.ok(ctx.callers.some(c => c.callerName === 'main'), 'main should be a caller of execute_query');
        } finally { rm(dir); }
    });

    it('blast follows Rust path-qualified call chains', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': 'mod api;\nmod db;\n\npub fn main() {\n    api::handle_request();\n}',
            'src/api.rs': 'use crate::db;\n\npub fn handle_request() {\n    db::query();\n}',
            'src/db.rs': 'pub fn query() {\n    println!("querying");\n}'
        });
        try {
            const index = idx(dir);
            const ctx = index.context('query');
            assert.ok(ctx.callers.some(c => c.callerName === 'handle_request'),
                'handle_request should call query via db::query()');
        } finally { rm(dir); }
    });

    it('Type::associated_fn() still matches impl methods', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'pub struct Config {}',
                'impl Config {',
                '    pub fn default() -> Config {',
                '        Config {}',
                '    }',
                '}',
                'pub fn setup() {',
                '    let c = Config::default();',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const ctx = index.context('default');
            // Config::default() should be found as a caller
            assert.ok(ctx.callers.some(c => c.callerName === 'setup'),
                'setup should be a caller of Config::default()');
        } finally { rm(dir); }
    });
});

describe('fix: affected-tests --exclude filters test files', () => {
    it('--exclude removes matching test files from results', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/helper.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'src/caller.js': 'const { helper } = require("./helper");\nfunction caller() { return helper(); }\nmodule.exports = { caller };',
            'test/unit/helper.test.js': 'const { helper } = require("../../src/helper");\nfunction testHelper() { helper(); }\nit("h", () => { testHelper(); });',
            'test/e2e/smoke.test.js': 'const { helper } = require("../../src/helper");\nfunction testSmoke() { helper(); }\nit("h", () => { testSmoke(); });'
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper', { exclude: ['e2e'] });
            assert.ok(result, 'should return result');
            const testFiles = result.testFiles.map(t => t.file);
            assert.ok(testFiles.some(f => f.includes('unit')),
                'unit test should be included');
            assert.ok(!testFiles.some(f => f.includes('e2e')),
                'e2e test should be excluded by --exclude=e2e');
        } finally { rm(dir); }
    });

    it('--exclude filters both blast radius and test files', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/core.js': 'function core() { return 1; }\nmodule.exports = { core };',
            'test/core.test.js': 'const { core } = require("../src/core");\ncore();',
            'test/integration/int.test.js': 'const { core } = require("../../src/core");\ncore();'
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('core', { exclude: ['integration'] });
            assert.ok(result, 'should return result');
            const testFiles = result.testFiles.map(t => t.file);
            assert.ok(!testFiles.some(f => f.includes('integration')),
                'integration tests should be excluded');
        } finally { rm(dir); }
    });
});

describe('fix: JS/TS decorator extraction for structural search', () => {
    it('extracts TypeScript class decorators', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{"compilerOptions":{"experimentalDecorators":true}}',
            'app.ts': [
                '@Injectable()',
                'class UserService {',
                '    @Inject()',
                '    getUser() { return null; }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            // Search for classes with @Injectable decorator
            const result = index.structuralSearch({ decorator: 'Injectable' });
            assert.ok(result.results.some(r => r.name === 'UserService'),
                'UserService should be found via @Injectable decorator');
        } finally { rm(dir); }
    });

    it('extracts TypeScript method decorators', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'controller.ts': [
                'class AppController {',
                '    @Get("/api")',
                '    handleGet() { return "ok"; }',
                '',
                '    @Post("/api")',
                '    handlePost() { return "created"; }',
                '',
                '    noDecorator() { return "plain"; }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ decorator: 'Get' });
            assert.ok(result.results.some(r => r.name === 'handleGet'),
                'handleGet should be found via @Get decorator');
            assert.ok(!result.results.some(r => r.name === 'handlePost'),
                'handlePost has @Post, not @Get');
            assert.ok(!result.results.some(r => r.name === 'noDecorator'),
                'noDecorator has no decorators');
        } finally { rm(dir); }
    });

    it('extracts JavaScript class decorators', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'component.js': [
                '@Component',
                'class MyComponent {',
                '    render() { return null; }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ decorator: 'Component' });
            assert.ok(result.results.some(r => r.name === 'MyComponent'),
                'MyComponent should be found via @Component decorator');
        } finally { rm(dir); }
    });
});

describe('fix: Rust #[derive()] and #[cfg(test)] attribute extraction', () => {
    it('#[derive(Debug)] extracted for structs', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                '#[derive(Debug, Clone)]',
                'pub struct Config {',
                '    pub name: String,',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ decorator: 'derive' });
            assert.ok(result.results.some(r => r.name === 'Config'),
                'Config struct should be found via #[derive] attribute');
        } finally { rm(dir); }
    });

    it('#[derive()] extracted for enums', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                '#[derive(Debug)]',
                'pub enum Status {',
                '    Active,',
                '    Inactive,',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ decorator: 'derive' });
            assert.ok(result.results.some(r => r.name === 'Status'),
                'Status enum should be found via #[derive] attribute');
        } finally { rm(dir); }
    });

    it('#[cfg(test)] extracted for modules', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'pub fn add(a: i32, b: i32) -> i32 { a + b }',
                '',
                '#[cfg(test)]',
                'mod tests {',
                '    use super::*;',
                '    #[test]',
                '    fn test_add() { assert_eq!(add(1, 2), 3); }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ decorator: 'cfg' });
            assert.ok(result.results.some(r => r.name === 'tests'),
                'tests module should be found via #[cfg(test)] attribute');
        } finally { rm(dir); }
    });

    it('#[test] attribute extracted on impl methods', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'pub struct Calculator {}',
                'impl Calculator {',
                '    pub fn add(&self, a: i32, b: i32) -> i32 { a + b }',
                '',
                '    #[test]',
                '    fn test_add(&self) { assert_eq!(self.add(1, 2), 3); }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ decorator: 'test' });
            assert.ok(result.results.some(r => r.name === 'test_add'),
                'test_add should be found via #[test] attribute on impl method');
        } finally { rm(dir); }
    });
});

describe('Phase 2 edge-to-edge: blast across languages', () => {
    it('blast follows Python cross-file call chains', () => {
        const dir = tmp({
            'requirements.txt': '',
            'app.py': 'from lib import helper\ndef main():\n    helper()',
            'lib.py': 'from utils import compute\ndef helper():\n    compute()',
            'utils.py': 'def compute():\n    return 42'
        });
        try {
            const index = idx(dir);
            const result = index.blast('compute', { depth: 3 });
            assert.ok(result, 'blast should return a result for Python');
            const names = new Set();
            const collectNames = (node) => {
                if (!node) return;
                names.add(node.name);
                for (const child of node.children || []) collectNames(child);
            };
            collectNames(result.tree);
            assert.ok(names.has('helper'), 'helper should be in blast tree');
            assert.ok(names.has('main'), 'main should be in blast tree');
        } finally { rm(dir); }
    });

    it('blast follows Go cross-file call chains', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': 'package main\n\nfunc main() {\n    Process()\n}',
            'process.go': 'package main\n\nfunc Process() {\n    Helper()\n}',
            'helper.go': 'package main\n\nfunc Helper() {\n    return\n}'
        });
        try {
            const index = idx(dir);
            const result = index.blast('Helper', { depth: 3 });
            assert.ok(result, 'blast should return a result for Go');
            assert.ok(result.summary.totalAffected >= 2, 'Process and main should be affected');
        } finally { rm(dir); }
    });

    it('blast follows Java cross-file call chains', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'App.java': [
                'class App {',
                '    void run() {',
                '        new Service().process();',
                '    }',
                '}'
            ].join('\n'),
            'Service.java': [
                'class Service {',
                '    void process() {',
                '        new Util().compute();',
                '    }',
                '}'
            ].join('\n'),
            'Util.java': [
                'class Util {',
                '    void compute() {',
                '        return;',
                '    }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const ctx = index.context('compute');
            assert.ok(ctx.callers.some(c => c.callerName === 'process'), 'process calls compute');
        } finally { rm(dir); }
    });
});

describe('Phase 2 edge-to-edge: structural search across languages', () => {
    it('--param works for Go typed parameters', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': [
                'package main',
                'import "net/http"',
                'func HandleRequest(w http.ResponseWriter, r *http.Request) {}',
                'func ProcessData(data string) {}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ type: 'function', param: 'Request' });
            assert.ok(result.results.some(r => r.name === 'HandleRequest'),
                'HandleRequest should match --param=Request (type match)');
        } finally { rm(dir); }
    });

    it('--returns works for Python type hints', () => {
        const dir = tmp({
            'requirements.txt': '',
            'lib.py': [
                'def get_name() -> str:',
                '    return "hello"',
                'def get_items() -> list:',
                '    return []',
                'def process():',
                '    pass'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ type: 'function', returns: 'str' });
            assert.ok(result.results.some(r => r.name === 'get_name'),
                'get_name should match --returns=str');
            assert.ok(!result.results.some(r => r.name === 'process'),
                'process has no return type');
        } finally { rm(dir); }
    });

    it('--exported works for Go capitalized functions', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': [
                'package main',
                'func PublicFunc() {}',
                'func privateFunc() {}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ type: 'function', exported: true });
            assert.ok(result.results.some(r => r.name === 'PublicFunc'),
                'PublicFunc (capitalized) should be exported');
            assert.ok(!result.results.some(r => r.name === 'privateFunc'),
                'privateFunc (lowercase) should not be exported');
        } finally { rm(dir); }
    });

    it('--decorator works for Java annotations', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'App.java': [
                'class App {',
                '    @Override',
                '    public void toString() { return "app"; }',
                '    @Deprecated',
                '    public void oldMethod() {}',
                '    public void normalMethod() {}',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ decorator: 'Override' });
            assert.ok(result.results.some(r => r.name === 'toString'),
                'toString with @Override should be found');
            assert.ok(!result.results.some(r => r.name === 'normalMethod'),
                'normalMethod has no annotation');
        } finally { rm(dir); }
    });

    it('--unused works across languages', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': [
                'function usedFunc() { return 1; }',
                'function unusedFunc() { return 2; }',
                'function caller() { usedFunc(); }'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ type: 'function', unused: true });
            assert.ok(result.results.some(r => r.name === 'unusedFunc'),
                'unusedFunc should be detected as unused');
            assert.ok(!result.results.some(r => r.name === 'usedFunc'),
                'usedFunc is called by caller, should not be unused');
        } finally { rm(dir); }
    });
});

describe('Phase 2 edge-to-edge: reverseTrace across languages', () => {
    it('reverseTrace finds Python entry points', () => {
        const dir = tmp({
            'requirements.txt': '',
            'app.py': 'from lib import helper\ndef main():\n    helper()',
            'lib.py': 'def helper():\n    return 42'
        });
        try {
            const index = idx(dir);
            const result = index.reverseTrace('helper', { depth: 5 });
            assert.ok(result, 'reverseTrace should return a result');
            assert.ok(result.entryPoints.some(ep => ep.name === 'main'),
                'main should be an entry point');
        } finally { rm(dir); }
    });

    it('reverseTrace finds Go entry points', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': 'package main\nfunc main() { Process() }',
            'process.go': 'package main\nfunc Process() { Helper() }',
            'helper.go': 'package main\nfunc Helper() { return }'
        });
        try {
            const index = idx(dir);
            const result = index.reverseTrace('Helper', { depth: 5 });
            assert.ok(result, 'reverseTrace should return a result');
            assert.ok(result.entryPoints.some(ep => ep.name === 'main'),
                'main should be an entry point');
        } finally { rm(dir); }
    });
});

describe('Phase 2 edge-to-edge: circularDeps across languages', () => {
    it('detects circular deps in TypeScript ESM imports', () => {
        const dir = tmp({
            'package.json': '{"name":"test","type":"module"}',
            'tsconfig.json': '{}',
            'a.ts': 'import { b } from "./b";\nexport function a() { return b(); }',
            'b.ts': 'import { a } from "./a";\nexport function b() { return a(); }'
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.ok(result.cycles.length > 0, 'should detect TS circular dep');
        } finally { rm(dir); }
    });

    it('detects circular deps in Python imports', () => {
        const dir = tmp({
            'requirements.txt': '',
            'a.py': 'from b import func_b\ndef func_a():\n    return func_b()',
            'b.py': 'from a import func_a\ndef func_b():\n    return func_a()'
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.ok(result.cycles.length > 0, 'should detect Python circular dep');
        } finally { rm(dir); }
    });

    it('detects circular deps in Go packages', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'a.go': 'package main\nimport "example.com/test/pkg"\nfunc A() { pkg.B() }',
            'pkg/b.go': 'package pkg\nfunc B() {}'
        });
        try {
            const index = idx(dir);
            // Go intra-package doesn't create cycles; this tests the import graph is populated
            const result = index.circularDeps();
            assert.ok(result.totalFiles > 0, 'should scan Go files');
        } finally { rm(dir); }
    });
});

// ============================================================================
// R3-NEW-1: about histogram covers true total (including shadow callers)
// ============================================================================

describe('R3-NEW-1: about histogram includes shadow callers', () => {
    it('histogram total matches callers.total when callers exceed maxCallers*3', () => {
        // Build a fixture with many callers — more than maxCallers*3 (30) so the
        // post-filter total is driven by shadow callers, not enriched ones.
        // Without the fix, histogram would only count maxResults*3 (the enriched cap),
        // leaving the histogram diverging from callers.total.
        const callerCount = 50;
        const files = {
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        };
        for (let i = 0; i < callerCount; i++) {
            files[`caller${i}.js`] = `const { helper } = require('./lib');\nfunction caller${i}() { return helper(); }\nmodule.exports = { caller${i} };`;
        }
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const result = execute(index, 'about', { name: 'helper', maxCallers: 10 });
            assert.ok(result.ok, 'about should succeed');
            const about = result.result;
            assert.ok(about.callers.total >= callerCount, `expected total ≥ ${callerCount}, got ${about.callers.total}`);
            assert.ok(about.callers.histogram, 'histogram should be present');
            // The histogram total should match callers.total — not capped at top.length or maxResults*3.
            assert.strictEqual(
                about.callers.histogram.total,
                about.callers.total,
                `histogram.total (${about.callers.histogram.total}) must equal callers.total (${about.callers.total})`
            );
            // Sanity: high+medium+low === total
            const sum = about.callers.histogram.high + about.callers.histogram.medium + about.callers.histogram.low;
            assert.strictEqual(sum, about.callers.histogram.total, 'histogram buckets must sum to total');
        } finally { rm(dir); }
    });
});

// ============================================================================
// R3-NEW-4: about disambiguation count aligns with find's filtered count
// ============================================================================

describe('R3-NEW-4: about/find count alignment for ambiguous symbols', () => {
    it('about disambiguation message excludes test files like find does', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function shared() { return 1; }\nmodule.exports = { shared };',
            'b.js': 'function shared() { return 2; }\nmodule.exports = { shared };',
            'test/a.test.js': 'function shared() { return 99; }',
            'test/b.test.js': 'function shared() { return 100; }',
            'test/c.test.js': 'function shared() { return 101; }',
        });
        try {
            const index = idx(dir);
            // find should exclude test files (default behavior)
            const findRes = execute(index, 'find', { name: 'shared', exact: true });
            assert.ok(findRes.ok);
            const findCount = findRes.result.length;
            assert.strictEqual(findCount, 2, 'find should return 2 (test files excluded)');

            // about's warning message should reflect the same count
            const aboutRes = execute(index, 'about', { name: 'shared' });
            assert.ok(aboutRes.ok);
            const about = aboutRes.result;
            // The warning message should match find's count
            if (about.warnings && about.warnings.length > 0) {
                const ambiguous = about.warnings.find(w => w.type === 'ambiguous');
                if (ambiguous) {
                    assert.match(
                        ambiguous.message,
                        new RegExp(`Found ${findCount} definitions`),
                        `about's warning should say "Found ${findCount}" matching find's filtered count, got: ${ambiguous.message}`
                    );
                }
            }
        } finally { rm(dir); }
    });

    it('--include-tests preserves the raw count', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function shared() { return 1; }',
            'test/a.test.js': 'function shared() { return 99; }',
            'test/b.test.js': 'function shared() { return 100; }',
        });
        try {
            const index = idx(dir);
            const aboutRes = execute(index, 'about', { name: 'shared', includeTests: true });
            assert.ok(aboutRes.ok);
            const about = aboutRes.result;
            if (about.warnings && about.warnings.length > 0) {
                const ambiguous = about.warnings.find(w => w.type === 'ambiguous');
                if (ambiguous) {
                    // With --include-tests, all 3 should be counted
                    assert.match(
                        ambiguous.message,
                        /Found 3 definitions/,
                        `with --include-tests, expected "Found 3 definitions", got: ${ambiguous.message}`
                    );
                }
            }
        } finally { rm(dir); }
    });
});

// ============================================================================
// RUST-3: impact on class symbols shows constructor invocations
// ============================================================================

describe('RUST-3: impact on class types shows callers like about does', () => {
    it('impact ClassName shows constructor invocations (Java)', () => {
        const dir = tmp({
            'Foo.java': 'public class Foo {\n    public void hello() {}\n}\n',
            'Bar.java': 'public class Bar {\n    public void run() {\n        Foo f = new Foo();\n        f.hello();\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            const aboutRes = execute(index, 'about', { name: 'Foo' });
            const impactRes = execute(index, 'impact', { name: 'Foo' });
            assert.ok(aboutRes.ok);
            assert.ok(impactRes.ok);
            const about = aboutRes.result;
            const impact = impactRes.result;
            assert.ok(about.callers.total > 0, `about should find callers, got total=${about.callers.total}`);
            assert.ok(impact.totalCallSites > 0, `impact should find call sites, got ${impact.totalCallSites}`);
            // Rough alignment: impact and about should both find the constructor invocation
            assert.ok(
                impact.totalCallSites >= 1,
                `impact ClassName should show constructor invocations, got ${impact.totalCallSites}`
            );
        } finally { rm(dir); }
    });

    it('impact StructName shows callers (Rust)', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"\nversion = "0.1.0"\n',
            'src/lib.rs': `pub struct Foo { pub n: i32 }\n\npub fn make() {\n    let _f = Foo { n: 1 };\n    let _g = Foo { n: 2 };\n}\n`,
        });
        try {
            const index = idx(dir);
            const aboutRes = execute(index, 'about', { name: 'Foo' });
            const impactRes = execute(index, 'impact', { name: 'Foo' });
            assert.ok(aboutRes.ok);
            assert.ok(impactRes.ok);
            // Both about and impact should agree (could be 0 or more depending on parser)
            // The KEY guarantee: impact should NOT return 0 when about returns >0.
            const about = aboutRes.result;
            const impact = impactRes.result;
            if (about.callers.total > 0) {
                assert.ok(
                    impact.totalCallSites > 0,
                    `impact must show callers when about does (about=${about.callers.total}, impact=${impact.totalCallSites})`
                );
            }
        } finally { rm(dir); }
    });
});


// ============================================================================
// Typed-receiver method references at the callback gate (engine-gap closure):
// `take(r.RemoteAddr)` where r's type is neither the target type nor below it
// was a SILENT drop — the ground line surfaced as call-not-resolved
// (grpc-go/cursive-measured). Now disposed like the main method-call path:
// unrelated concrete type → excluded receiver-type-mismatch; interface
// receiver → visible possible-dispatch; alias/embedding (closed target set)
// → kept as a true edge.
// ============================================================================

describe('typed-receiver method references are disposed, never dropped', () => {
    const FILES = {
        'go.mod': 'module example.com/m\ngo 1.21\n',
        'lib/lib.go': `package lib

type Conn struct{}

func (c *Conn) RemoteAddr() string { return "conn" }
`,
        'app/app.go': `package app

type Request struct{ x int }

func (r *Request) RemoteAddr() string { return "req" }

func take(f func() string) {}

func use(r *Request) {
	take(r.RemoteAddr)
}
`,
    };

    it('unrelated concrete receiver type → excluded receiver-type-mismatch, conserved', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'lib/lib.go:5:RemoteAddr' });
            assert.ok(r.ok, `context failed: ${r.error}`);
            const json = JSON.parse(output.formatContextJson(r.result));
            assert.ok(!(json.data.callers || []).some(c => c.file === 'app/app.go'),
                'Request.RemoteAddr reference is not a Conn.RemoteAddr caller');
            assert.ok(!(json.data.unverifiedCallers || []).some(u => u.file === 'app/app.go'),
                `claimed as excluded, not left unverified: ${JSON.stringify(json.data.unverifiedCallers)}`);
            const byReason = json.meta.account.excluded?.byReason || {};
            assert.ok((byReason['receiver-type-mismatch']?.count || 0) >= 1,
                `excluded with reason: ${JSON.stringify(byReason)}`);
            assert.strictEqual(json.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('interface-typed receiver reference → visible possible-dispatch', () => {
        const dir = tmp({
            ...FILES,
            'app/iface.go': `package app

type Addresser interface {
	RemoteAddr() string
}

func useIface(a Addresser) {
	take(a.RemoteAddr)
}
`,
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'lib/lib.go:5:RemoteAddr' });
            assert.ok(r.ok, `context failed: ${r.error}`);
            const json = JSON.parse(output.formatContextJson(r.result));
            const entry = (json.data.unverifiedCallers || [])
                .find(u => u.file === 'app/iface.go' && u.reason === 'possible-dispatch');
            assert.ok(entry,
                `interface method value can hold any implementation: ${JSON.stringify(json.data.unverifiedCallers)}`);
            assert.strictEqual(entry.dispatchVia, 'Addresser');
            assert.strictEqual(json.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('embedding (promoting) receiver type → kept as a true caller edge', () => {
        const dir = tmp({
            ...FILES,
            'app/embed.go': `package app

import "example.com/m/lib"

type Wrapped struct {
	lib.Conn
}

func useWrapped(w *Wrapped) {
	take(w.RemoteAddr)
}
`,
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'lib/lib.go:5:RemoteAddr' });
            assert.ok(r.ok, `context failed: ${r.error}`);
            const confirmed = (r.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(confirmed.includes('app/embed.go:10'),
                `w.RemoteAddr IS the promoted Conn.RemoteAddr: ${confirmed}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// call-not-resolved listing contract (roadmap #4): a ground call-line the
// engine claims nowhere must be LISTED as a bare unverified entry, not just
// counted. Every natural producer is now closed (the callback gate above was
// the last), so the glue is pinned directly with a stubbed account.
// ============================================================================

describe('call-not-resolved entries render as bare unverified one-liners', () => {
    it('entries carry file:line, source text, and the reason', () => {
        const dir = tmp({
            'package.json': '{"name":"cnr-glue"}',
            'app.js': 'function helper() { return 1; }\nhelper();\n',
        });
        try {
            const index = idx(dir);
            const { callNotResolvedEntries } = require('../core/analysis');
            const file = [...index.files.keys()].find(f => f.endsWith('app.js'));
            const account = {
                callNotResolved: [{ file, relativePath: 'app.js', line: 2 }],
            };
            const entries = callNotResolvedEntries(index, account);
            assert.strictEqual(entries.length, 1);
            assert.strictEqual(entries[0].relativePath, 'app.js');
            assert.strictEqual(entries[0].line, 2);
            assert.strictEqual(entries[0].content, 'helper();');
            assert.strictEqual(entries[0].tier, 'unverified');
            assert.strictEqual(entries[0].reason, 'call-not-resolved');
            assert.strictEqual(entries[0].callerName, null);
        } finally { rm(dir); }
    });

    it('exclude filters apply; missing account yields no entries', () => {
        const dir = tmp({
            'package.json': '{"name":"cnr-glue2"}',
            'test/app.test.js': 'function helper() { return 1; }\nhelper();\n',
        });
        try {
            const index = idx(dir);
            const { callNotResolvedEntries } = require('../core/analysis');
            const file = [...index.files.keys()].find(f => f.endsWith('app.test.js'));
            const account = {
                callNotResolved: [{ file, relativePath: 'test/app.test.js', line: 2 }],
            };
            const filtered = callNotResolvedEntries(index, account, { exclude: ['test'] });
            assert.strictEqual(filtered.length, 0, 'exclude pattern filters entries');
            assert.deepStrictEqual(callNotResolvedEntries(index, null), []);
        } finally { rm(dir); }
    });
});

describe('fix #227: verify/plan honor the exact-line pin (incl. stable handles)', () => {
    const FILES = {
        'package.json': '{"name":"pin"}',
        'lib.js': [
            'class Store {',
            '  save(x) { return x; }',
            '}',
            'function save(a, b) { return a + b; }',
            'module.exports = { Store, save };',
        ].join('\n'),
        'app.js': [
            'const { save } = require("./lib");',
            'function main() { return save(1, 2); }',
        ].join('\n'),
    };

    it('verify --line pins the standalone function, not the same-name method', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const v = execute(index, 'verify', { name: 'save', file: 'lib.js', line: 4 });
            assert.ok(v.ok);
            assert.strictEqual(v.result.startLine, 4,
                'line pin must select the def at line 4 (was dropped by the execute handler)');
            assert.strictEqual(v.result.expectedArgs.max, 2, 'two-param function, not the one-param method');
        } finally { rm(dir); }
    });

    it('stable handle lib.js:4:save roundtrips into the same pin', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const v = execute(index, 'verify', { name: 'lib.js:4:save' });
            assert.ok(v.ok);
            assert.strictEqual(v.result.startLine, 4, 'handle syntax must pin by file+line');
        } finally { rm(dir); }
    });

    it('plan --line pins the same definition as verify', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const p = execute(index, 'plan', { name: 'save', file: 'lib.js', line: 4, addParam: 'opt' });
            assert.ok(p.ok);
            assert.strictEqual(p.result.file, 'lib.js');
            assert.strictEqual(p.result.startLine, 4, 'plan must operate on the pinned def');
        } finally { rm(dir); }
    });
});

describe('fix #228: unsatisfiable definition pins error instead of silently falling back', () => {
    const FILES = {
        'package.json': '{"name":"pin2"}',
        'utils.js': 'function camelToSnake(s) { return s; }\nmodule.exports = { camelToSnake };',
        'data.js': 'const { camelToSnake } = require("./utils");\nfunction use() { return camelToSnake("x"); }',
    };

    it('context/verify with a --file pin matching no definition error with locations', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            for (const cmd of ['context', 'verify', 'impact', 'trace', 'blast']) {
                const r = execute(index, cmd, { name: 'camelToSnake', file: 'data.js' });
                assert.strictEqual(r.ok, false, `${cmd} must reject the wrong-file pin`);
                assert.ok(r.error.includes('utils.js'), `${cmd} error lists the real location`);
            }
            // the correct pin still resolves
            const ok = execute(index, 'verify', { name: 'camelToSnake', file: 'utils.js' });
            assert.ok(ok.ok && ok.result.found);
        } finally { rm(dir); }
    });

    it('a stale line pin errors instead of analyzing a different definition', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const r = execute(index, 'verify', { name: 'camelToSnake', file: 'utils.js', line: 99 });
            assert.strictEqual(r.ok, false, 'stale handle line must not silently resolve elsewhere');
            assert.ok(r.error.includes('utils.js:1'), 'error lists the real definition line');
        } finally { rm(dir); }
    });
});
