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
const { tmp, rm, idx, FIXTURES_PATH, runCli } = require('./helpers');
const { execute } = require('../core/execute');
const output = require('../core/output');

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

    // BUG-F regression: trailing modified 1-line functions in a tightly-packed file
    // were classified as `newFunctions[]` instead of `functions[]` because the
    // deletedLines loop used a ±2 line tolerance and broke on first match — an
    // earlier 1-line symbol's expanded range claimed the deleted line that
    // actually belonged to a later 1-line function.
    describe('BUG-F: tightly-packed 1-line functions attributed correctly', () => {
        function setupTightlyPackedRepo(suffix) {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                // Tightly-packed: 3 consecutive 1-line functions, no blank lines.
                // function a is at line 1, b at line 2, c at line 3.
                'pack.js': 'function a() { return 1; }\nfunction b() { return 2; }\nfunction c() { return 3; }\nmodule.exports = { a, b, c };\n',
            });
            execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
            execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
            execFileSync('git', ['-c', 'user.email=test@test.com', '-c', 'user.name=Test', 'commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
            return dir;
        }

        it('modifying trailing 1-line function classifies it as modified, not new', () => {
            const dir = setupTightlyPackedRepo();
            try {
                // Modify only `c` (the trailing 1-line function)
                const packPath = path.join(dir, 'pack.js');
                fs.writeFileSync(packPath, 'function a() { return 1; }\nfunction b() { return 2; }\nfunction c() { return 99; }\nmodule.exports = { a, b, c };\n');

                const index = idx(dir);
                const { ok, result } = execute(index, 'diffImpact', { base: 'HEAD' });
                assert.ok(ok);

                const modifiedNames = (result.functions || []).map(f => f.name);
                const newNames = (result.newFunctions || []).map(f => f.name);

                assert.ok(modifiedNames.includes('c'),
                    `c should be in functions[] (modified). Got modified=${JSON.stringify(modifiedNames)}, new=${JSON.stringify(newNames)}`);
                assert.ok(!newNames.includes('c'),
                    `c should NOT be in newFunctions[]. Got new=${JSON.stringify(newNames)}`);
                // Sibling 1-line functions a and b were not touched — they should not appear at all.
                assert.ok(!modifiedNames.includes('a'), 'a should not be modified');
                assert.ok(!modifiedNames.includes('b'), 'b should not be modified');
            } finally { rm(dir); }
        });

        it('modifying middle 1-line function classifies it as modified, not new', () => {
            const dir = setupTightlyPackedRepo();
            try {
                // Modify only `b` (the middle 1-line function)
                const packPath = path.join(dir, 'pack.js');
                fs.writeFileSync(packPath, 'function a() { return 1; }\nfunction b() { return 88; }\nfunction c() { return 3; }\nmodule.exports = { a, b, c };\n');

                const index = idx(dir);
                const { ok, result } = execute(index, 'diffImpact', { base: 'HEAD' });
                assert.ok(ok);

                const modifiedNames = (result.functions || []).map(f => f.name);
                const newNames = (result.newFunctions || []).map(f => f.name);

                assert.ok(modifiedNames.includes('b'),
                    `b should be in functions[] (modified). Got modified=${JSON.stringify(modifiedNames)}, new=${JSON.stringify(newNames)}`);
                assert.ok(!newNames.includes('b'),
                    `b should NOT be in newFunctions[]. Got new=${JSON.stringify(newNames)}`);
            } finally { rm(dir); }
        });

        it('check command does not flag modified 1-line trailing function as [ADDED, ORPHAN]', () => {
            const dir = setupTightlyPackedRepo();
            try {
                const packPath = path.join(dir, 'pack.js');
                fs.writeFileSync(packPath, 'function a() { return 1; }\nfunction b() { return 2; }\nfunction c() { return 99; }\nmodule.exports = { a, b, c };\n');

                const index = idx(dir);
                const { ok, result } = execute(index, 'check', { base: 'HEAD' });
                assert.ok(ok);

                const items = result && Array.isArray(result.items) ? result.items : [];
                const cItem = items.find(i => i.name === 'c');
                if (cItem) {
                    assert.notStrictEqual(cItem.kind, 'added',
                        `c should be 'modified', not 'added'. Got kind=${cItem.kind}`);
                    assert.ok(!cItem.orphan,
                        `c should NOT be marked orphan. Got orphan=${cItem.orphan}`);
                }
            } finally { rm(dir); }
        });
    });
});

// ── brief ───────────────────────────────────────────────────────────────────

describe('brief command', () => {
    it('returns signature, docstring, side effects, and complexity', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': `/**
 * @param {string} name
 * @returns {Promise<User>}
 */
async function fetchUser(name) {
    if (!name) throw new Error('no name');
    const fs = require('fs');
    const data = fs.readFileSync('cache.json');
    return JSON.parse(data);
}
module.exports = fetchUser;`
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'brief', { name: 'fetchUser' });
            assert.ok(ok);
            assert.strictEqual(result.symbol.name, 'fetchUser');
            assert.strictEqual(result.symbol.returnType, 'Promise<User>');
            assert.deepStrictEqual(result.symbol.paramTypes, { name: 'string' });
            assert.ok(result.sideEffects.includes('fs'), 'should detect fs side effect');
            assert.ok(result.complexity.branches >= 1, 'should count if branch');
            assert.ok(result.lineCount > 0);
        } finally { rm(dir); }
    });

    it('classifies pure function as no side effects', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function add(x, y) { return x + y; }\nmodule.exports = add;'
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'brief', { name: 'add' });
            assert.ok(ok);
            assert.deepStrictEqual(result.sideEffects, []);
            assert.strictEqual(result.complexity.branches, 0);
        } finally { rm(dir); }
    });

    it('detects Python global_mutation', () => {
        const dir = tmp({
            'requirements.txt': '',
            'svc.py': 'state = {}\n\ndef set_value(key: str, value: int) -> None:\n    global state\n    state[key] = value\n'
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'brief', { name: 'set_value' });
            assert.ok(ok);
            assert.ok(result.sideEffects.includes('global_mutation'));
        } finally { rm(dir); }
    });

    it('handles class types with member count', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'cls.js': 'class Foo {\n  bar() {}\n  baz() {}\n}\nmodule.exports = Foo;'
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'brief', { name: 'Foo' });
            assert.ok(ok);
            assert.strictEqual(result.kind, 'type');
            assert.strictEqual(result.memberCount, 2);
        } finally { rm(dir); }
    });

    it('errors with not-found message for unknown symbol', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function a() {}'
        });
        try {
            const index = idx(dir);
            const { ok, error } = execute(index, 'brief', { name: 'doesNotExist' });
            assert.strictEqual(ok, false);
            assert.match(error, /not found/);
        } finally { rm(dir); }
    });
});

// ── stable symbol handles ─────────────────────────────────────────────────

describe('symbol handles', () => {
    const { parseSymbolHandle, formatSymbolHandle, looksLikeHandle } = require('../core/shared');

    it('parses file:line:name', () => {
        const h = parseSymbolHandle('lib/api.ts:42:handler');
        assert.deepStrictEqual(h, { file: 'lib/api.ts', line: 42, name: 'handler' });
    });

    it('parses file:line (name-less)', () => {
        const h = parseSymbolHandle('lib/api.ts:42');
        assert.deepStrictEqual(h, { file: 'lib/api.ts', line: 42 });
    });

    it('rejects non-handle strings', () => {
        assert.strictEqual(parseSymbolHandle('handler'), null);
        assert.strictEqual(parseSymbolHandle(''), null);
        assert.strictEqual(parseSymbolHandle('lib.js:abc'), null);
    });

    it('looksLikeHandle distinguishes handles from names', () => {
        assert.strictEqual(looksLikeHandle('handler'), false);
        assert.strictEqual(looksLikeHandle('lib.js:42'), true);
        assert.strictEqual(looksLikeHandle('lib.js:42:handler'), true);
    });

    it('formats and parses round-trip', () => {
        const sym = { name: 'foo', relativePath: 'src/a.js', startLine: 10 };
        const handle = formatSymbolHandle(sym);
        const parsed = parseSymbolHandle(handle);
        assert.strictEqual(parsed.file, 'src/a.js');
        assert.strictEqual(parsed.line, 10);
        assert.strictEqual(parsed.name, 'foo');
    });

    it('handle pins resolution to exact definition when name is ambiguous', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function process(x) { return x; }\nmodule.exports = process;',
            'b.js': 'function process(y, z) { return y + z; }\nmodule.exports = process;',
        });
        try {
            const index = idx(dir);
            // Bare name picks one — but which one is heuristic
            const r1 = execute(index, 'brief', { name: 'process' });
            assert.ok(r1.ok);
            // Handle pins to a.js's process
            const r2 = execute(index, 'brief', { name: 'a.js:1:process' });
            assert.ok(r2.ok);
            assert.strictEqual(r2.result.symbol.file, 'a.js');
            assert.strictEqual(r2.result.symbol.startLine, 1);
            // Handle pins to b.js's process (different signature)
            const r3 = execute(index, 'brief', { name: 'b.js:1:process' });
            assert.ok(r3.ok);
            assert.strictEqual(r3.result.symbol.file, 'b.js');
        } finally { rm(dir); }
    });

    it('name-less handle recovers name via index lookup', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function compute() { return 1; }\nmodule.exports = compute;',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'brief', { name: 'lib.js:1' });
            assert.ok(r.ok);
            assert.strictEqual(r.result.symbol.name, 'compute');
        } finally { rm(dir); }
    });

    it('find emits handle for every result', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function foo() {}\nfunction bar() {}',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'find', { name: 'foo' });
            assert.ok(r.ok);
            assert.ok(Array.isArray(r.result));
            assert.ok(r.result.length > 0);
            // Each result has the fields needed to construct a handle
            const s = r.result[0];
            const handle = formatSymbolHandle(s);
            assert.ok(handle);
            assert.match(handle, /a\.js:1:foo/);
        } finally { rm(dir); }
    });

    it('about JSON includes handle', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function foo() {}\nmodule.exports = foo;',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'about', { name: 'foo' });
            assert.ok(r.ok);
            assert.ok(r.result.symbol.handle);
            assert.match(r.result.symbol.handle, /a\.js:1:foo/);
        } finally { rm(dir); }
    });
});

// ── doctor ─────────────────────────────────────────────────────────────────

describe('doctor command', () => {
    it('returns project trust report with files and languages', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function a() {}',
            'b.js': 'function b() {}',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'doctor', {});
            assert.ok(ok);
            assert.ok(result.files.scanned >= 2);
            assert.ok(result.symbols >= 2);
            assert.ok(result.languages.javascript);
            assert.ok(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].includes(result.trust));
        } finally { rm(dir); }
    });

    it('detects eval and reflection blind spots', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'evil.js': 'function run() { eval("1+1"); }',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'doctor', {});
            assert.ok(ok);
            assert.ok(result.blindSpots.evalCalls.count >= 1, 'should flag eval call');
        } finally { rm(dir); }
    });

    it('deep mode produces resolution coverage histogram', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper(x) { return x + 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(1); helper(2); }\nmain();'
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'doctor', { deep: true });
            assert.ok(ok);
            assert.ok(result.coverage, 'should have coverage data');
            assert.ok(result.coverage.total >= 0);
        } finally { rm(dir); }
    });

    it('handles empty project gracefully', () => {
        const dir = tmp({ 'package.json': '{"name":"test"}' });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'doctor', {});
            assert.ok(ok);
            assert.strictEqual(result.symbols, 0);
            assert.strictEqual(result.files.scanned, 0);
            // Should not crash, should produce a verdict
            assert.ok(result.trust);
        } finally { rm(dir); }
    });
});

// ── side-effect tags on callees ────────────────────────────────────────────

describe('callee side-effect tags', () => {
    it('tags fs callees in context', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': "const fs = require('fs');\nfunction load() { return fs.readFileSync('x'); }\nfunction wrap() { return load(); }\nmodule.exports = { load, wrap };",
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'context', { name: 'wrap', includeMethods: true });
            assert.ok(ok);
            // The single callee `load` should be tagged with [fs]
            assert.ok(Array.isArray(result.callees));
            const load = result.callees.find(c => c.name === 'load');
            if (load) {
                assert.ok(load.sideEffects && load.sideEffects.includes('fs'),
                    `load should be tagged fs; got ${JSON.stringify(load.sideEffects)}`);
            }
        } finally { rm(dir); }
    });

    it('does not tag pure callees', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function add(a, b) { return a + b; }\nfunction caller() { return add(1, 2); }\nmodule.exports = { caller };',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'context', { name: 'caller', includeMethods: true });
            assert.ok(ok);
            const add = result.callees.find(c => c.name === 'add');
            if (add) {
                // Pure function should have no sideEffects field (or empty array)
                assert.ok(!add.sideEffects || add.sideEffects.length === 0,
                    `add should be pure; got ${JSON.stringify(add.sideEffects)}`);
            }
        } finally { rm(dir); }
    });
});

// ── check ──────────────────────────────────────────────────────────────────

describe('check command', () => {
    it('returns empty result when no diff', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function a() {}',
        });
        try {
            const index = idx(dir);
            // No git repo — diffImpact returns empty/no changes
            const { ok, result } = execute(index, 'check', { base: 'HEAD' });
            assert.ok(ok);
            assert.ok(result.empty || result.changed.length === 0,
                'should be empty without git changes');
        } finally { rm(dir); }
    });

    it('summarizes changed/added functions when diff exists', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function existing() { return 1; }\nmodule.exports = existing;',
        });
        try {
            // Init a git repo, commit, then modify
            execFileSync('git', ['init', '-q'], { cwd: dir });
            execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'add', '.'], { cwd: dir });
            execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir });

            // Modify and add a function
            fs.writeFileSync(path.join(dir, 'a.js'),
                'function existing() { return 2; }\nfunction brandNew() { return 3; }\nmodule.exports = { existing, brandNew };');
            const index = idx(dir);
            const { ok, result } = execute(index, 'check', { base: 'HEAD' });
            assert.ok(ok);
            if (!result.empty) {
                assert.ok(result.changed.length > 0, 'should have changed entries');
                const names = result.changed.map(c => c.name);
                assert.ok(names.includes('brandNew') || names.includes('existing'));
            }
        } finally { rm(dir); }
    });
});

// ── auditAsync ────────────────────────────────────────────────────────────────

describe('audit-async behavioral', () => {
    it('returns {issues, totalIssues, filesAffected} shape', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': [
                'async function helper() { return 1; }',
                'async function caller() { helper(); }',
                'caller();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'auditAsync', {});
            assert.ok(ok);
            assert.ok(Array.isArray(result.issues));
            assert.strictEqual(typeof result.totalIssues, 'number');
            assert.strictEqual(typeof result.filesAffected, 'number');
        } finally { rm(dir); }
    });

    it('respects file= filter', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'good.js': [
                'async function helper1() { return 1; }',
                'async function caller1() { await helper1(); }',
                'caller1();',
            ].join('\n'),
            'bad.js': [
                'async function helper2() { return 1; }',
                'async function caller2() { helper2(); }',
                'caller2();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            // Whole project sees one issue from bad.js.
            const all = execute(index, 'auditAsync', {}).result;
            assert.strictEqual(all.totalIssues, 1);
            // file=good.js sees 0.
            const filtered = execute(index, 'auditAsync', { file: 'good.js' }).result;
            assert.strictEqual(filtered.totalIssues, 0);
        } finally { rm(dir); }
    });

    it('produces stable ordering across runs', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': [
                'async function fa() { return 1; }',
                'async function callerA() { fa(); }',
                'callerA();',
            ].join('\n'),
            'b.js': [
                'async function fb() { return 1; }',
                'async function callerB() { fb(); }',
                'callerB();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r1 = execute(index, 'auditAsync', {}).result;
            const r2 = execute(index, 'auditAsync', {}).result;
            assert.deepStrictEqual(
                r1.issues.map(i => `${i.file}:${i.line}:${i.calleeName}`),
                r2.issues.map(i => `${i.file}:${i.line}:${i.calleeName}`),
                'same input → same output ordering (rule #11)'
            );
            // a.js sorts before b.js alphabetically.
            assert.match(r1.issues[0].file, /a\.js$/);
        } finally { rm(dir); }
    });
});

// ── endpoints command behavioral ─────────────────────────────────────────────

describe('endpoints command behavioral', () => {
    const JS_FIXTURE = path.join(FIXTURES_PATH, 'endpoints', 'javascript');
    const PY_FIXTURE = path.join(FIXTURES_PATH, 'endpoints', 'python');

    it('returns server routes when no flag set', () => {
        const index = idx(JS_FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        assert.ok(Array.isArray(result.routes));
        assert.ok(result.routes.length > 0);
        // No --bridge → no bridge records computed
        assert.strictEqual(result.bridges.length, 0);
        // Without --bridge or --unmatched, unmatched lists are not computed (empty)
        assert.strictEqual(result.unmatchedRoutes.length, 0);
        assert.strictEqual(result.unmatchedRequests.length, 0);
    });

    it('--bridge produces bridges + unmatched lists', () => {
        const index = idx(JS_FIXTURE);
        const { ok, result } = execute(index, 'endpoints', { bridge: true });
        assert.ok(ok);
        assert.ok(result.bridges.length > 0, 'should have at least one bridge');
        // Total bridges + unmatched ≤ total
        for (const b of result.bridges) {
            assert.ok(b.confidence > 0 && b.confidence <= 1);
            assert.ok(['exact', 'partial', 'uncertain'].includes(b.matchType));
        }
    });

    it('--unmatched populates unmatched routes/requests and implies --bridge', () => {
        const index = idx(JS_FIXTURE);
        const { ok, result } = execute(index, 'endpoints', { unmatched: true });
        assert.ok(ok);
        // HIGH-2 fix: --unmatched implies --bridge for computation. Bridges
        // are computed internally so we know which routes/requests didn't
        // match, but the formatter suppresses the "Matched" section.
        assert.ok(result._bridge, 'unmatched should imply bridge mode');
        assert.ok(result._unmatched, 'unmatched flag should propagate');
        // unmatchedRoutes/unmatchedRequests are populated
        assert.ok(result.unmatchedRoutes.length + result.unmatchedRequests.length > 0,
            'expected some unmatched entries');
    });

    // HIGH-2: --unmatched (without --bridge) text output omits the Matched section.
    it('--unmatched text output omits Matched section', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'server.js': "const express = require('express'); const app = express();\napp.get('/health', a);\napp.get('/orphan', b);\nfunction a() {}\nfunction b() {}\n",
            'client.js': "function f() { return fetch('/health'); }\nfunction g() { return fetch('/missing'); }\n",
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'endpoints', { unmatched: true });
            assert.ok(ok);
            const text = output.formatEndpoints(result, { bridge: result._bridge, unmatched: result._unmatched });
            assert.ok(!/Matched \(\d+ routes?\):/.test(text),
                `--unmatched should not show Matched section, got:\n${text}`);
            assert.ok(/Unmatched server routes \(1\)/.test(text),
                `--unmatched should list unmatched server routes`);
            assert.ok(/Unmatched client requests \(1\)/.test(text),
                `--unmatched should list unmatched client requests`);
        } finally { rm(dir); }
    });

    // HIGH-2: --bridge --unmatched also omits Matched section.
    it('--bridge --unmatched text output also omits Matched section', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'server.js': "const express = require('express'); const app = express();\napp.get('/health', a);\napp.get('/orphan', b);\nfunction a() {}\nfunction b() {}\n",
            'client.js': "function f() { return fetch('/health'); }\nfunction g() { return fetch('/missing'); }\n",
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'endpoints', { bridge: true, unmatched: true });
            assert.ok(ok);
            const text = output.formatEndpoints(result, { bridge: result._bridge, unmatched: result._unmatched });
            assert.ok(!/Matched \(\d+ routes?\):/.test(text),
                `--bridge --unmatched should not show Matched section`);
        } finally { rm(dir); }
    });

    // HIGH-2: JSON output suppresses bridges array in unmatched-only mode.
    it('--unmatched JSON output excludes bridges array', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'server.js': "const express = require('express'); const app = express();\napp.get('/health', a);\nfunction a() {}\n",
            'client.js': "function f() { return fetch('/health'); }\nfunction g() { return fetch('/missing'); }\n",
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'endpoints', { unmatched: true });
            assert.ok(ok);
            const json = output.formatEndpointsJson(result, { unmatched: result._unmatched });
            const parsed = JSON.parse(json);
            assert.strictEqual(parsed.data.bridges.length, 0,
                'bridges array should be empty in unmatched JSON output');
            assert.strictEqual(parsed.meta.filterMode, 'unmatched',
                'meta.filterMode should signal unmatched-only mode');
        } finally { rm(dir); }
    });

    // HIGH-3: trailing-slash dups produce many-to-many matches; percentage
    // must be ≤100 (count unique matched requests, not raw bridges).
    it('match percentage ≤100% on many-to-many matches', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'server.js': "const express = require('express'); const app = express();\napp.get('/users', a);\napp.get('/users/', b);\nfunction a() {}\nfunction b() {}\n",
            'client.js': "function get() { return fetch('/users'); }\n",
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'endpoints', { bridge: true });
            assert.ok(ok);
            // 2 bridges (1 client matches both server routes), but 1 unique
            // request → percentage should be 100, NOT 200.
            assert.ok(result.bridges.length >= 2, 'expected >=2 bridges from trailing-slash dup');
            const text = output.formatEndpoints(result, { bridge: result._bridge });
            const m = text.match(/Matched: \d+ \((\d+)%\)/);
            assert.ok(m, `should have a percentage line, got:\n${text}`);
            const pct = parseInt(m[1], 10);
            assert.ok(pct <= 100, `percentage ${pct}% should be ≤100%`);
        } finally { rm(dir); }
    });

    // HIGH-4: trailing slash should normalize to EXACT match (1.00).
    it('trailing slash on server side: server /users/ ↔ client /users is EXACT', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'server.js': "const express = require('express'); const app = express();\napp.get('/users/', handle);\nfunction handle() {}\n",
            'client.js': "function get() { return fetch('/users'); }\n",
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'endpoints', { bridge: true });
            assert.ok(ok);
            assert.strictEqual(result.bridges.length, 1);
            assert.strictEqual(result.bridges[0].matchType, 'exact');
            assert.strictEqual(result.bridges[0].confidence, 1);
        } finally { rm(dir); }
    });

    // MEDIUM-5: fetch(url, { method: 'POST' }) extracts explicit method.
    it('fetch with options.method: POST matches POST server route', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'server.js': "const express = require('express'); const app = express();\napp.post('/users', handle);\nfunction handle() {}\n",
            'client.js': "function create() { return fetch('/users', { method: 'POST' }); }\n",
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'endpoints', { bridge: true });
            assert.ok(ok);
            assert.strictEqual(result.bridges.length, 1);
            const b = result.bridges[0];
            assert.strictEqual(b.request.method, 'POST');
            assert.strictEqual(b.methodInferred, false,
                'explicit options.method should not be marked as inferred');
        } finally { rm(dir); }
    });

    // HIGH-4 (reverse): trailing slash on client side: server /users ↔ client /users/.
    it('trailing slash on client side: server /users ↔ client /users/ is EXACT', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'server.js': "const express = require('express'); const app = express();\napp.get('/users', handle);\nfunction handle() {}\n",
            'client.js': "function get() { return fetch('/users/'); }\n",
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'endpoints', { bridge: true });
            assert.ok(ok);
            assert.strictEqual(result.bridges.length, 1);
            assert.strictEqual(result.bridges[0].matchType, 'exact');
        } finally { rm(dir); }
    });

    it('--method=GET filters routes/requests to only GET method', () => {
        const index = idx(JS_FIXTURE);
        const { ok, result } = execute(index, 'endpoints', { method: 'GET' });
        assert.ok(ok);
        for (const r of result.routes) {
            // ALL/USE are also kept (catch-all)
            assert.ok(r.method === 'GET' || r.method === 'ALL' || r.method === 'USE',
                `expected GET/ALL/USE got ${r.method}`);
        }
        for (const r of result.requests) {
            assert.ok(r.method === 'GET' || r.method === 'ALL',
                `expected GET/ALL got ${r.method}`);
        }
    });

    it('--method is case-insensitive (lowercase get)', () => {
        const index = idx(JS_FIXTURE);
        const { ok, result } = execute(index, 'endpoints', { method: 'get' });
        assert.ok(ok);
        // All listed routes should be GET (or wildcard)
        for (const r of result.routes) {
            assert.ok(['GET', 'ALL', 'USE'].includes(r.method));
        }
    });

    it('--method rejects unknown HTTP verb with helpful error', () => {
        const index = idx(JS_FIXTURE);
        const r = execute(index, 'endpoints', { method: 'INVALID' });
        assert.strictEqual(r.ok, false, `expected error, got ok=${r.ok}`);
        assert.match(r.error, /--method/);
        assert.match(r.error, /INVALID/);
        // Should list the accepted verbs in the error message.
        assert.match(r.error, /GET/);
        assert.match(r.error, /POST/);
    });

    it('--prefix=/api filters routes/requests by path prefix', () => {
        const index = idx(JS_FIXTURE);
        const { ok, result } = execute(index, 'endpoints', { prefix: '/api' });
        assert.ok(ok);
        for (const r of result.routes) {
            assert.ok(r.path.startsWith('/api') || r.normalizedPath.startsWith('/api'),
                `route ${r.path} should start with /api`);
        }
    });

    it('exact match: literal route ↔ literal client gives confidence=1', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'server.js': "const express = require('express'); const app = express();\napp.get('/health', healthCheck);\nfunction healthCheck() {}\n",
            'client.js': "function ping() { return fetch('/health'); }\n",
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'endpoints', { bridge: true });
            assert.ok(ok);
            assert.strictEqual(result.bridges.length, 1);
            const b = result.bridges[0];
            assert.strictEqual(b.matchType, 'exact');
            assert.strictEqual(b.confidence, 1);
        } finally { rm(dir); }
    });

    it('partial match: server /users/:id ↔ client literal /users/123', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'server.js': "const express = require('express'); const app = express();\napp.get('/users/:id', handle);\nfunction handle() {}\n",
            'client.js': "function get() { return fetch('/users/123'); }\n",
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'endpoints', { bridge: true });
            assert.ok(ok);
            assert.strictEqual(result.bridges.length, 1);
            const b = result.bridges[0];
            assert.strictEqual(b.matchType, 'partial');
            assert.ok(b.confidence > 0 && b.confidence < 1);
        } finally { rm(dir); }
    });

    it('uncertain match: client interp /foo/${id}/bar ↔ server /foo/:id/bar', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'server.js': "const express = require('express'); const app = express();\napp.get('/foo/:id/bar', handle);\nfunction handle() {}\n",
            'client.js': 'function f(id) { return fetch(`/foo/${id}/bar`); }\n',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'endpoints', { bridge: true });
            assert.ok(ok);
            // The interp client path becomes /foo/* (parser truncates after `${`)
            // server /foo/:id/bar → /foo/*/bar — these don't overlap normally
            // but the looser fallback (shared prefix) matches as 'uncertain'
            assert.ok(result.bridges.length >= 1);
            const interpMatch = result.bridges.find(b => b.matchType === 'uncertain');
            assert.ok(interpMatch, 'should produce uncertain match for interp client');
            // Uncertain has lower confidence
            assert.ok(interpMatch.confidence < 0.85);
        } finally { rm(dir); }
    });

    it('method inference: bare fetch/axios.get default to GET with methodInferred=true', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'a.js': "function f() { return fetch('/foo'); }\n",
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'endpoints', {});
            assert.ok(ok);
            assert.strictEqual(result.requests.length, 1);
            assert.strictEqual(result.requests[0].method, 'GET');
            assert.strictEqual(result.requests[0].methodInferred, true);
            assert.strictEqual(result.requests[0].framework, 'fetch');
        } finally { rm(dir); }
    });

    it('stable output ordering: same input produces byte-identical results (rule #11)', () => {
        const index = idx(JS_FIXTURE);
        // Clear any cache that might affect identity across runs
        index._endpointsCache = null;
        const r1 = execute(index, 'endpoints', { bridge: true }).result;
        index._endpointsCache = null;
        const r2 = execute(index, 'endpoints', { bridge: true }).result;
        // Routes ordering (file, line, method, path)
        assert.deepStrictEqual(
            r1.routes.map(r => `${r.file}:${r.line}:${r.method}:${r.path}`),
            r2.routes.map(r => `${r.file}:${r.line}:${r.method}:${r.path}`),
            'routes ordering must be deterministic'
        );
        // Requests ordering
        assert.deepStrictEqual(
            r1.requests.map(r => `${r.file}:${r.line}:${r.method}:${r.path}`),
            r2.requests.map(r => `${r.file}:${r.line}:${r.method}:${r.path}`),
            'requests ordering must be deterministic'
        );
        // Bridges ordering
        assert.deepStrictEqual(
            r1.bridges.map(b => `${b.route.file}:${b.route.line}:${b.request.file}:${b.request.line}`),
            r2.bridges.map(b => `${b.route.file}:${b.route.line}:${b.request.file}:${b.request.line}`),
            'bridges ordering must be deterministic'
        );
    });

    it('JSON output (--bridge --json) matches expected schema', () => {
        const out = runCli(JS_FIXTURE, 'endpoints', [], ['--bridge', '--json']);
        const parsed = JSON.parse(out);
        // Top-level shape: { meta, data }
        assert.ok(parsed.meta, 'should have meta');
        assert.ok(parsed.data, 'should have data');
        // meta fields
        assert.strictEqual(parsed.meta.ok, true);
        assert.ok(typeof parsed.meta.totalRoutes === 'number');
        assert.ok(typeof parsed.meta.totalRequests === 'number');
        assert.ok(typeof parsed.meta.totalBridges === 'number');
        assert.ok(parsed.meta.byFramework);
        // data fields
        assert.ok(Array.isArray(parsed.data.routes));
        assert.ok(Array.isArray(parsed.data.requests));
        assert.ok(Array.isArray(parsed.data.bridges));
        assert.ok(Array.isArray(parsed.data.unmatchedRoutes));
        assert.ok(Array.isArray(parsed.data.unmatchedRequests));
        // Bridges have well-defined fields
        if (parsed.data.bridges.length > 0) {
            const b = parsed.data.bridges[0];
            assert.ok(b.route);
            assert.ok(b.request);
            assert.ok(b.matchType);
            assert.ok(typeof b.confidence === 'number');
        }
        // Routes contain method/path/handler/line/framework
        for (const r of parsed.data.routes) {
            assert.ok(r.method);
            assert.ok(r.path);
            assert.ok(typeof r.line === 'number');
            assert.ok(r.framework);
        }
    });

    it('text output is non-empty and includes Server Routes header', () => {
        const out = runCli(JS_FIXTURE, 'endpoints', [], []);
        assert.ok(out.includes('Server Routes:'), 'expected Server Routes: header');
        // 9 routes → header should reflect this
        assert.match(out, /Server Routes: 9/);
    });

    it('--bridge text output includes Endpoint Bridges header', () => {
        const out = runCli(JS_FIXTURE, 'endpoints', [], ['--bridge']);
        assert.ok(out.includes('Endpoint Bridges'), 'expected Endpoint Bridges header');
        assert.match(out, /Matched: \d+/);
    });
});
