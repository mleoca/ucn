'use strict';

require('./helpers/cache-root');
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmp, rm, idx } = require('./helpers');
const { execute } = require('../core/execute');
const { createTestModel } = require('../core/test-units');

function repository(files) {
    const dir = tmp(files);
    for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'base']]) {
        execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test',
            '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
        { cwd: dir, stdio: 'pipe' });
    }
    return dir;
}

function check(index, full) {
    const original = index.affectedTests;
    if (full) {
        index.affectedTests = function(name, options) {
            return original.call(this, name, { ...options, _testSitesOnly: false });
        };
    }
    try {
        const answer = execute(index, 'check', { base: 'HEAD' });
        assert.ok(answer.ok, JSON.stringify(answer.error));
        return answer.result;
    } finally { index.affectedTests = original; }
}

describe('fix #503: aggregate check test units once, preserving the full answer', () => {
    const fixtures = [
        {
            name: 'same-line JavaScript tests and confirmed/possible sites', file: 'lib.js',
            files: {
                'package.json': '{"type":"module"}',
                'lib.js': 'export function leaf(){return 1;}\nexport function second(){return 1;}\n',
                'test/shared.test.js': "import test from 'node:test';\nimport {leaf, second} from '../lib.js';\ntest('first',()=>leaf()); test('unrelated',()=>9); test('second',()=>second());\n",
                'test/possible.test.js': "import test from 'node:test';\nfunction invoke(value){value.leaf();}\ntest('possible',()=>invoke({leaf(){return 1;}}));\n",
            }, expected: 2,
        },
        {
            name: 'Python inherited shared bodies and conditional tests', file: 'library.py',
            files: {
                'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths=["tests"]\n',
                'library.py': 'def leaf() -> int:\n    return 1\n\ndef second() -> int:\n    return 1\n',
                'Base.py': 'from library import leaf, second\nclass Base:\n    def test_shared(self):\n        assert leaf() + second() == 2\n',
                'tests/test_inherited.py': 'from Base import Base\nclass TestFirst(Base):\n    pass\nclass TestSecond(Base):\n    pass\n',
                'tests/test_conditional.py': 'import pytest\nimport os\nfrom library import leaf\n@pytest.mark.skipif("os.getenv(\'SKIP_OPTIONAL\')")\ndef test_conditional():\n    assert leaf() == 1\n',
            }, expected: 3,
        },
        {
            name: 'Go same-line test declarations', file: 'lib.go',
            files: {
                'go.mod': 'module positions\n\ngo 1.20\n',
                'lib.go': 'package positions\nfunc leaf() int { return 1 }\n',
                'lib_test.go': 'package positions\nimport "testing"\nfunc TestTarget(t *testing.T) { leaf() }; func TestUnrelated(t *testing.T) {}\n',
            }, expected: 1,
        },
        {
            name: 'Rust conditional test attributes', file: 'src/lib.rs',
            files: {
                'Cargo.toml': '[package]\nname="positions"\nversion="0.1.0"\nedition="2021"\n[features]\noptional=[]\n',
                'src/lib.rs': 'fn leaf() -> i32 { 1 }\n#[cfg(test)] mod tests { use super::*; #[test] fn target() { leaf(); } #[cfg_attr(feature="optional", test)] fn conditional() { leaf(); } #[test] fn unrelated() {} }\n',
            }, expected: 2,
        },
        {
            name: 'JUnit inherited test body', file: 'Lib.java',
            files: {
                'Lib.java': 'class Lib { static int leaf() { return 1; } }\n',
                'Base.java': 'import org.junit.jupiter.api.Test;\nclass Base { @Test void target() { Lib.leaf(); } }\n',
                'ChildTest.java': 'class ChildTest extends Base {}\n',
            }, expected: 2,
        },
    ];

    for (const fixture of fixtures) {
        it(fixture.name, () => {
            const dir = repository(fixture.files);
            try {
                fs.writeFileSync(path.join(dir, fixture.file), fixture.files[fixture.file].replace(/return 1|\{ 1 \}/g,
                    text => text === 'return 1' ? 'return 2' : '{ 2 }'));
                const index = idx(dir);
                const answer = check(index, false);
                assert.deepStrictEqual(answer, check(index, true), 'full public projection and aggregate projection agree');
                assert.strictEqual(answer.totalTests, fixture.expected);
                assert.deepStrictEqual(check(index, false), answer, 'a subsequent operation retains the same answer');
                index.saveCache(); index.saveUsageCache();
                const { ProjectIndex } = require('../core/project');
                const loaded = new ProjectIndex(dir);
                assert.strictEqual(loaded.loadCache(), true);
                assert.deepStrictEqual(check(loaded, false), answer, 'a cache load retains the same answer');
                assert.deepStrictEqual(check(loaded, true), answer);
                fs.writeFileSync(path.join(dir, fixture.file), fixture.files[fixture.file]);
                index.build(null, { quiet: true });
                const rebuilt = check(index, false);
                assert.deepStrictEqual(rebuilt, check(index, true));
                assert.deepStrictEqual(rebuilt, check(idx(dir), false), 'rebuild discards the previous selection');
            } finally { rm(dir); }
        });
    }

    it('does not construct per-root unit descriptions before check links their union', () => {
        const dir = tmp({
            'package.json': '{"type":"module"}',
            'lib.js': 'export function leaf(){return 1;}\n',
            'test/shared.test.js': "import test from 'node:test';\nimport {leaf} from '../lib.js';\ntest('target',()=>leaf());\n",
        });
        try {
            const index = idx(dir), model = createTestModel(index);
            const describeUnit = model.describe;
            let descriptions = 0;
            model.describe = (...args) => { descriptions++; return describeUnit(...args); };
            const sites = index.affectedTests('leaf', { file: 'lib.js', _testModel: model, _testSitesOnly: true });
            assert.strictEqual(descriptions, 0);
            const full = index.affectedTests('leaf', { file: 'lib.js', _testModel: model });
            assert.ok(descriptions > 0);
            assert.deepStrictEqual(sites.testFiles.map(row => ({ file: row.file, matches: row.matches })),
                full.testFiles.map(row => ({ file: row.file, matches: row.matches })));
        } finally { rm(dir); }
    });
});

describe('fix #501: stop namespace inventory after an all-identities effect', () => {
    const { pythonProjectIdentityAffected } = require('../core/python-binding-identity');
    const identities = ['builtins.property', 'builtins.classmethod', 'typing.Generic'];
    const answers = index => {
        index._beginOp();
        try { return identities.map(identity => pythonProjectIdentityAffected(index, identity)); }
        finally { index._endOp(); }
    };

    it('retains every answer without reading files after a wildcard', () => {
        const dir = tmp({
            'a.py': 'def expose(value):\n    return vars(value)\n',
            'z.py': 'import builtins\ndef register(fn): return fn\nbuiltins.property=register\n',
        });
        try {
            const index = idx(dir), visited = [];
            const read = index._readFile.bind(index);
            index._readFile = (...args) => { visited.push(path.basename(args[0])); return read(...args); };
            assert.deepStrictEqual(answers(index), [true, true, true]);
            assert.deepStrictEqual(visited, ['a.py'], 'remaining files cannot affect an already universal answer');
        } finally { rm(dir); }
    });

    it('reads later mutators again after repair, including a cache-loaded index', () => {
        const wildcard = 'def expose(value):\n    return vars(value)\n';
        const clean = 'def expose(value):\n    return value\n';
        const dir = tmp({
            'a.py': wildcard,
            'z.py': 'import builtins\ndef register(fn): return fn\nbuiltins.property=register\n',
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(answers(index), [true, true, true]);
            index.saveCache();
            const { ProjectIndex } = require('../core/project');
            const loaded = new ProjectIndex(dir);
            assert.strictEqual(loaded.loadCache(), true);
            assert.deepStrictEqual(answers(loaded), [true, true, true]);
            fs.writeFileSync(path.join(dir, 'a.py'), clean);
            for (const current of [index, loaded]) {
                current.build(null, { quiet: true });
                const visited = [];
                const read = current._readFile.bind(current);
                current._readFile = (...args) => { visited.push(path.basename(args[0])); return read(...args); };
                assert.deepStrictEqual(answers(current), [true, false, false]);
                assert.deepStrictEqual(visited, ['a.py', 'z.py'], 'a specific effect must not hide later files');
                current._readFile = read;
            }
            fs.writeFileSync(path.join(dir, 'z.py'), 'import builtins\n');
            loaded.build(null, { quiet: true });
            assert.deepStrictEqual(answers(loaded), [false, false, false]);
            assert.deepStrictEqual(answers(loaded), answers(idx(dir)), 'no wildcard survives its source repair');
        } finally { rm(dir); }
    });
});
