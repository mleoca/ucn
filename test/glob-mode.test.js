const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { tmp, rm, runCli } = require('./helpers');

describe('Glob mode', () => {

    it('indexes only matching files', () => {
        const dir = tmp({
            'package.json': '{}',
            'src/app.js': 'function main() { helper(); }',
            'src/utils.js': 'function helper() { return 1; }',
            'lib/other.py': 'def other(): pass',
        });
        try {
            const out = runCli(path.join(dir, 'src', '*.js'), 'toc', [], ['--detailed']);
            assert.ok(out.includes('main'), 'Should include main from app.js');
            assert.ok(out.includes('helper'), 'Should include helper from utils.js');
            assert.ok(!out.includes('other'), 'Should NOT include other from .py file');
        } finally {
            rm(dir);
        }
    });

    it('nested glob matches files in subdirectories', () => {
        const dir = tmp({
            'package.json': '{}',
            'src/app.js': 'function appMain() {}',
            'src/lib/deep.js': 'function deepFn() {}',
            'top.js': 'function topFn() {}',
        });
        try {
            const out = runCli(path.join(dir, 'src', '**', '*.js'), 'toc', [], ['--detailed']);
            assert.ok(out.includes('appMain'), 'Should match src/app.js');
            assert.ok(out.includes('deepFn'), 'Should match src/lib/deep.js');
            assert.ok(!out.includes('topFn'), 'Should NOT match top.js (outside src/)');
        } finally {
            rm(dir);
        }
    });

    it('brace expansion matches multiple extensions', () => {
        const dir = tmp({
            'package.json': '{}',
            'app.js': 'function jsFunc() {}',
            'lib.py': 'def pyFunc(): pass',
            'data.txt': 'not code',
        });
        try {
            const out = runCli(path.join(dir, '*.{js,py}'), 'toc', [], ['--detailed']);
            assert.ok(out.includes('jsFunc'), 'Should match .js files');
            assert.ok(out.includes('pyFunc'), 'Should match .py files');
        } finally {
            rm(dir);
        }
    });

    it('no matches produces error', () => {
        const dir = tmp({
            'package.json': '{}',
            'app.js': 'function main() {}',
        });
        try {
            const out = runCli(path.join(dir, '*.xyz'), 'toc', [], []);
            assert.ok(out.includes('No files match'), 'Should show no-match error');
        } finally {
            rm(dir);
        }
    });

    it('glob + find command scopes to matching files', () => {
        const dir = tmp({
            'package.json': '{}',
            'src/app.js': 'function targetFn() { helper(); }',
            'src/utils.js': 'function helper() { return 1; }',
            'other/extra.js': 'function extraFn() {}',
        });
        try {
            const out = runCli(path.join(dir, 'src', '*.js'), 'find', ['targetFn'], []);
            assert.ok(out.includes('targetFn'), 'Should find targetFn in src/');
            // extraFn should not be findable since other/ isn't in the glob
            const out2 = runCli(path.join(dir, 'src', '*.js'), 'find', ['extraFn'], []);
            assert.ok(!out2.includes('function') || out2.includes('No results'), 'Should not find extraFn outside glob scope');
        } finally {
            rm(dir);
        }
    });

    it('glob + search command scopes results', () => {
        const dir = tmp({
            'package.json': '{}',
            'src/app.js': 'function processData() { return 42; }',
            'other/extra.js': 'function processOther() { return 99; }',
        });
        try {
            const out = runCli(path.join(dir, 'src', '*.js'), 'search', ['process'], []);
            assert.ok(out.includes('processData'), 'Should find processData in src/');
            assert.ok(!out.includes('processOther'), 'Should NOT find processOther outside glob');
        } finally {
            rm(dir);
        }
    });

    it('glob + --json flag produces valid JSON', () => {
        const dir = tmp({
            'package.json': '{}',
            'src/app.js': 'function main() {}',
        });
        try {
            const out = runCli(path.join(dir, 'src', '*.js'), 'toc', [], ['--json']);
            const parsed = JSON.parse(out);
            assert.ok(parsed.files, 'JSON output should have files field');
        } finally {
            rm(dir);
        }
    });

    it('glob + --detailed flag works on toc', () => {
        const dir = tmp({
            'package.json': '{}',
            'src/app.js': 'function main() {}\nfunction helper() {}',
        });
        try {
            const out = runCli(path.join(dir, 'src', '*.js'), 'toc', [], ['--detailed']);
            assert.ok(out.includes('main'), 'Should list main');
            assert.ok(out.includes('helper'), 'Should list helper');
        } finally {
            rm(dir);
        }
    });

    it('cross-file resolution is scoped to globbed files', () => {
        const dir = tmp({
            'package.json': '{}',
            'src/app.js': 'const { helper } = require("./utils");\nfunction main() { helper(); }',
            'src/utils.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'other/extra.js': 'const { helper } = require("../src/utils");\nfunction extra() { helper(); }',
        });
        try {
            const out = runCli(path.join(dir, 'src', '*.js'), 'context', ['helper'], []);
            assert.ok(out.includes('helper'), 'Should find helper');
            // extra() should NOT appear as caller since other/ is outside glob scope
            assert.ok(!out.includes('extra'), 'Caller from outside glob scope should not appear');
        } finally {
            rm(dir);
        }
    });
});
