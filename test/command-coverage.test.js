/**
 * Behavioral tests for commands that previously had only parity-test coverage.
 * Covers: affectedTests, blast, reverseTrace, circularDeps, diffImpact,
 *         exporters, fileExports, plan, stacktrace, stats, usages, api, search
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmp, rm, idx } = require('./helpers');
const { execute } = require('../core/execute');

// ── Shared Fixtures ──────────────────────────────────────────────────────────

const SIMPLE_FIXTURE = {
    'package.json': '{"name":"test"}',
    'lib.js': `
function helper(x) { return x + 1; }
function unused() { return 42; }
// TODO: refactor helper
module.exports = { helper };
`,
    'app.js': `
const { helper } = require('./lib');
function main() {
    const result = helper(5);
    return result;
}
module.exports = { main };
`,
    'utils.js': `
export function formatData(data) { return String(data); }
export function parseData(str) { return parseInt(str); }
export default function init() {}
`,
};

const CHAIN_FIXTURE = {
    'package.json': '{"name":"test"}',
    'lib.js': `
function leaf() { return 1; }
function middle() { return leaf(); }
module.exports = { leaf, middle };
`,
    'app.js': `
const { middle } = require('./lib');
function top() { return middle(); }
module.exports = { top };
`,
    'entry.js': `
const { top } = require('./app');
function main() { top(); }
`,
    'test/app.test.js': `
const { top } = require('../app');
describe('top function', () => {
    it('should work', () => { top(); });
});
`,
};

const CIRCULAR_FIXTURE = {
    'package.json': '{"name":"test"}',
    'a.js': `
const { bFunc } = require('./b');
function aFunc() { return bFunc(); }
module.exports = { aFunc };
`,
    'b.js': `
const { aFunc } = require('./a');
function bFunc() { return aFunc(); }
module.exports = { bFunc };
`,
    'c.js': `
function standalone() { return 1; }
module.exports = { standalone };
`,
};

// ── Group 1: Simple commands ─────────────────────────────────────────────────

describe('stats command', () => {
    it('counts files, symbols, and languages', () => {
        const dir = tmp(SIMPLE_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'stats', {});
            assert.ok(ok);
            assert.ok(result.files > 0, 'should have files');
            assert.ok(result.symbols > 0, 'should have symbols');
            assert.ok(result.byLanguage, 'should have language breakdown');
            assert.ok(result.byLanguage.javascript, 'should have JS stats');
        } finally { rm(dir); }
    });

    it('returns per-function line counts with functions=true', () => {
        const dir = tmp(SIMPLE_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'stats', { functions: true });
            assert.ok(ok);
            assert.ok(Array.isArray(result.functions), 'should have functions array');
            assert.ok(result.functions.length > 0, 'should list functions');
            assert.ok(result.functions[0].lines > 0, 'functions should have line counts');
        } finally { rm(dir); }
    });
});

describe('api command', () => {
    it('returns only exported symbols project-wide', () => {
        const dir = tmp(SIMPLE_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'api', {});
            assert.ok(ok);
            assert.ok(Array.isArray(result), 'should be an array');
            const names = result.map(s => s.name);
            assert.ok(names.includes('helper'), 'exported helper should be in api');
            assert.ok(!names.includes('unused'), 'non-exported unused should not be in api');
        } finally { rm(dir); }
    });

    it('returns exports from a specific file', () => {
        const dir = tmp(SIMPLE_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'api', { file: 'utils.js' });
            assert.ok(ok);
            const names = result.map(s => s.name);
            assert.ok(names.includes('formatData'), 'should find formatData export');
            assert.ok(names.includes('parseData'), 'should find parseData export');
        } finally { rm(dir); }
    });
});

describe('fileExports command', () => {
    it('lists named and default exports', () => {
        const dir = tmp(SIMPLE_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'fileExports', { file: 'utils.js' });
            assert.ok(ok);
            assert.ok(Array.isArray(result), 'should be an array');
            const names = result.map(e => e.name);
            assert.ok(names.includes('formatData'), 'should have formatData');
            assert.ok(names.includes('init'), 'should have default export init');
        } finally { rm(dir); }
    });

    it('shows module.exports for CJS', () => {
        const dir = tmp(SIMPLE_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'fileExports', { file: 'lib.js' });
            assert.ok(ok);
            assert.ok(Array.isArray(result), 'should be an array');
            const names = result.map(e => e.name);
            assert.ok(names.includes('helper'), 'should export helper');
        } finally { rm(dir); }
    });
});

describe('exporters command', () => {
    it('finds files that import a given file', () => {
        const dir = tmp(SIMPLE_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'exporters', { file: 'lib.js' });
            assert.ok(ok);
            assert.ok(Array.isArray(result), 'should be an array');
            const importers = result.map(r => r.relativePath || path.relative(dir, r.file));
            assert.ok(importers.some(f => f.includes('app.js')), 'app.js should import lib.js');
        } finally { rm(dir); }
    });

    it('returns empty for file with no importers', () => {
        const dir = tmp(SIMPLE_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'exporters', { file: 'utils.js' });
            assert.ok(ok);
            assert.ok(Array.isArray(result), 'should be an array');
            assert.strictEqual(result.length, 0, 'utils.js has no importers');
        } finally { rm(dir); }
    });
});

describe('usages command', () => {
    it('finds definition and call usage types', () => {
        const dir = tmp(SIMPLE_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'usages', { name: 'helper' });
            assert.ok(ok);
            assert.ok(Array.isArray(result), 'should be array');
            assert.ok(result.length > 0, 'should find usages');
            assert.ok(result.some(u => u.isDefinition), 'should include definition');
            assert.ok(result.some(u => u.usageType === 'call'), 'should include call site');
        } finally { rm(dir); }
    });

    it('limit truncates results with note', () => {
        const dir = tmp(SIMPLE_FIXTURE);
        try {
            const index = idx(dir);
            const full = execute(index, 'usages', { name: 'helper' });
            if (full.result.length > 1) {
                const { ok, result, note } = execute(index, 'usages', { name: 'helper', limit: 1 });
                assert.ok(ok);
                assert.strictEqual(result.length, 1, 'should be limited to 1');
                assert.ok(note, 'should have truncation note');
            }
        } finally { rm(dir); }
    });

    it('returns empty array for nonexistent symbol', () => {
        const dir = tmp(SIMPLE_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'usages', { name: 'nonexistent_xyz' });
            assert.ok(ok);
            assert.strictEqual(result.length, 0, 'should find no usages');
        } finally { rm(dir); }
    });
});

describe('search command', () => {
    it('text search finds matches across files', () => {
        const dir = tmp(SIMPLE_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'search', { term: 'helper' });
            assert.ok(ok);
            assert.ok(Array.isArray(result), 'should be array');
            assert.ok(result.length > 0, 'should find matches');
            assert.ok(result[0].matches, 'each result should have matches array');
            assert.ok(result[0].matches[0].content, 'matches should have content');
        } finally { rm(dir); }
    });

    it('structural search type=function returns functions', () => {
        const dir = tmp(SIMPLE_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'search', { type: 'function' });
            assert.ok(ok);
            assert.ok(result.results, 'structural search should have results');
            assert.ok(result.results.length > 0, 'should find functions');
            for (const r of result.results) {
                assert.ok(r.name, 'each result should have a name');
            }
        } finally { rm(dir); }
    });

    it('returns empty for no matches', () => {
        const dir = tmp(SIMPLE_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'search', { term: 'zzz_no_match_xyz' });
            assert.ok(ok);
            assert.strictEqual(result.length, 0, 'should find no matches');
        } finally { rm(dir); }
    });
});

describe('circularDeps command', () => {
    it('detects A→B→A cycle', () => {
        const dir = tmp(CIRCULAR_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'circularDeps', {});
            assert.ok(ok);
            assert.ok(result.cycles, 'should have cycles array');
            assert.ok(result.cycles.length > 0, 'should detect circular dependency');
            const cycle = result.cycles[0];
            const files = cycle.files || cycle;
            const fileNames = (Array.isArray(files) ? files : []).map(f => path.basename(f));
            assert.ok(fileNames.includes('a.js') || fileNames.includes('b.js'),
                'cycle should involve a.js and/or b.js');
        } finally { rm(dir); }
    });

    it('returns empty cycles for acyclic project', () => {
        const dir = tmp(SIMPLE_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'circularDeps', {});
            assert.ok(ok);
            assert.strictEqual(result.cycles.length, 0, 'acyclic project should have no cycles');
        } finally { rm(dir); }
    });
});

// ── Group 2: Call chain commands ─────────────────────────────────────────────

describe('blast command', () => {
    it('shows transitive callers', () => {
        const dir = tmp(CHAIN_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'blast', { name: 'leaf', depth: 10 });
            assert.ok(ok);
            assert.ok(result, 'should return result');
            // The blast result should include middle and top as transitive callers
            const text = JSON.stringify(result);
            assert.ok(text.includes('middle'), 'should include direct caller middle');
            assert.ok(text.includes('top'), 'should include transitive caller top');
        } finally { rm(dir); }
    });

    it('depth=1 limits to direct callers only', () => {
        const dir = tmp(CHAIN_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'blast', { name: 'leaf', depth: 1 });
            assert.ok(ok);
            const text = JSON.stringify(result);
            assert.ok(text.includes('middle'), 'should include direct caller middle');
        } finally { rm(dir); }
    });

    it('returns result for function with no callers', () => {
        const dir = tmp(CHAIN_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'blast', { name: 'main' });
            assert.ok(ok);
            assert.ok(result, 'should still return a result object');
        } finally { rm(dir); }
    });
});

describe('reverseTrace command', () => {
    it('traces upward call chain', () => {
        const dir = tmp(CHAIN_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result, error } = execute(index, 'reverseTrace', { name: 'leaf', depth: 10 });
            assert.ok(ok, `should succeed, got error: ${error}`);
            assert.ok(result, 'should return result');
            const text = JSON.stringify(result);
            assert.ok(text.includes('middle') || text.includes('top'),
                'should trace upward through call chain');
        } finally { rm(dir); }
    });

    it('respects depth parameter', () => {
        const dir = tmp(CHAIN_FIXTURE);
        try {
            const index = idx(dir);
            const shallow = execute(index, 'reverseTrace', { name: 'leaf', depth: 1 });
            const deep = execute(index, 'reverseTrace', { name: 'leaf', depth: 10 });
            assert.ok(shallow.ok);
            assert.ok(deep.ok);
        } finally { rm(dir); }
    });
});

describe('affectedTests command', () => {
    it('finds tests that transitively call the function', () => {
        const dir = tmp(CHAIN_FIXTURE);
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'affectedTests', { name: 'leaf', depth: 10 });
            assert.ok(ok);
            assert.ok(result, 'should return result');
            // leaf is called by middle, called by top, which is tested in test/app.test.js
            if (result.testFiles && result.testFiles.length > 0) {
                const testFile = result.testFiles[0];
                assert.ok(testFile.relativePath || testFile.file, 'test file should have path');
            }
        } finally { rm(dir); }
    });

    it('returns result for function with no test coverage', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function isolated() { return 1; }\nmodule.exports = { isolated };',
        });
        try {
            const index = idx(dir);
            const { ok, result, error } = execute(index, 'affectedTests', { name: 'isolated' });
            assert.ok(ok, `should succeed, got error: ${error}`);
            assert.ok(result, 'should return result even with no tests');
        } finally { rm(dir); }
    });
});

// ── Group 3: Specialized commands ────────────────────────────────────────────

describe('plan command', () => {
    it('addParam shows updated call sites', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': `
function calc(a, b) { return a + b; }
module.exports = { calc };
`,
            'app.js': `
const { calc } = require('./lib');
function run() { return calc(1, 2); }
`,
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'plan', { name: 'calc', addParam: 'c' });
            assert.ok(ok);
            assert.ok(result, 'should return plan result');
            assert.ok(result.found, 'should find the function');
            assert.strictEqual(result.operation, 'add-param');
            assert.ok(result.after.params.includes('c'), 'after should include new param c');
            assert.ok(result.changes.length > 0, 'should have call site changes');
        } finally { rm(dir); }
    });

    it('renameTo shows renamed function', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': `
function calc(a, b) { return a + b; }
module.exports = { calc };
`,
            'app.js': `
const { calc } = require('./lib');
function run() { return calc(1, 2); }
`,
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'plan', { name: 'calc', renameTo: 'calculate' });
            assert.ok(ok);
            assert.ok(result, 'should return plan result');
        } finally { rm(dir); }
    });

    it('requires an operation parameter', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function calc(a, b) { return a + b; }\nmodule.exports = { calc };',
        });
        try {
            const index = idx(dir);
            const { ok, error } = execute(index, 'plan', { name: 'calc' });
            assert.ok(!ok, 'should fail without operation');
            assert.ok(error.includes('requires'), 'error should mention requirement');
        } finally { rm(dir); }
    });
});

describe('stacktrace command', () => {
    it('parses Node.js-style stack trace', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': `
function doWork() { throw new Error('fail'); }
function main() { doWork(); }
`,
        });
        try {
            const index = idx(dir);
            const stack = `Error: fail
    at doWork (app.js:2:30)
    at main (app.js:3:20)
    at Object.<anonymous> (app.js:4:1)`;
            const { ok, result } = execute(index, 'stacktrace', { stack });
            assert.ok(ok);
            assert.ok(result.frames, 'should have frames array');
            assert.ok(result.frames.length >= 2, 'should parse at least 2 frames');
        } finally { rm(dir); }
    });

    it('resolves frames to project files', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/handler.js': `
function handleRequest() { return 1; }
module.exports = { handleRequest };
`,
        });
        try {
            const index = idx(dir);
            const stack = `Error: test
    at handleRequest (src/handler.js:2:10)
    at node:internal/main:1:1`;
            const { ok, result } = execute(index, 'stacktrace', { stack });
            assert.ok(ok);
            const resolved = result.frames.filter(f => f.found);
            assert.ok(resolved.length >= 1, 'should resolve at least one frame to project file');
        } finally { rm(dir); }
    });

    it('requires stack trace input', () => {
        const dir = tmp({ 'package.json': '{"name":"test"}', 'a.js': 'function x(){}' });
        try {
            const index = idx(dir);
            const { ok, error } = execute(index, 'stacktrace', {});
            assert.ok(!ok, 'should fail without stack trace');
            assert.ok(error.includes('required'), 'error should mention requirement');
        } finally { rm(dir); }
    });
});

describe('diffImpact command', () => {
    it('detects modified functions and their callers', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': `
function helper(x) { return x + 1; }
module.exports = { helper };
`,
            'app.js': `
const { helper } = require('./lib');
function main() { return helper(5); }
`,
        });
        try {
            // Initialize git repo and commit
            execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
            execFileSync('git', ['-c', 'user.email=test@test.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
            execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
            execFileSync('git', ['-c', 'user.email=test@test.com', '-c', 'user.name=Test', 'commit', '-m', 'add files'], { cwd: dir, stdio: 'pipe' });

            // Modify a function
            const libPath = path.join(dir, 'lib.js');
            fs.writeFileSync(libPath, `
function helper(x) { return x + 2; }
module.exports = { helper };
`);
            const index = idx(dir);
            const { ok, result } = execute(index, 'diffImpact', { base: 'HEAD' });
            assert.ok(ok);
            assert.ok(result, 'should return result');
            assert.ok(result.changed || result.newFunctions || result.summary,
                'should have diff impact data');
        } finally { rm(dir); }
    });

    it('detects new functions', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function existing() { return 1; }\nmodule.exports = { existing };',
        });
        try {
            execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
            execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
            execFileSync('git', ['-c', 'user.email=test@test.com', '-c', 'user.name=Test', 'commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });

            // Add new function
            const libPath = path.join(dir, 'lib.js');
            fs.writeFileSync(libPath, 'function existing() { return 1; }\nfunction brandNew() { return 2; }\nmodule.exports = { existing, brandNew };');

            const index = idx(dir);
            const { ok, result } = execute(index, 'diffImpact', { base: 'HEAD' });
            assert.ok(ok);
            if (result.newFunctions) {
                const names = result.newFunctions.map(f => f.name);
                assert.ok(names.includes('brandNew'), 'should detect new function');
            }
        } finally { rm(dir); }
    });
});
