'use strict';

/**
 * One model of what a test is (core/test-units.js): a unit is a file, a
 * suite chain, a name and a line; a runner is named on evidence; a command
 * is printed only for a runner whose selection syntax is modeled.
 *
 * The cases in eval/test-unit-matrix-cases.js are judged by the runners
 * themselves in eval/run-test-unit-matrix.js. Here the engine's answer on
 * every case is pinned, with no runner needed, and the consumers of the
 * model (`tests`, the affected-test selection, `check`, `verify`) are held
 * to it.
 */

require('./helpers/cache-root');
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { tmp, rm, idx } = require('./helpers');
const { execute } = require('../core/execute');
const output = require('../core/output');
const {
    createTestModel, selectorText, unitLabel, linkFile, linkFiles, commandsFor,
    scriptRunners, nodeTestOptions, configWords, tableText, namesRequirement, focusedOut,
} = require('../core/test-units');
const { CASES } = require('../eval/test-unit-matrix-cases');
const { answerOf, judgeWholeRun } = require('../eval/run-test-unit-matrix');
const PINNED = require('../eval/test-unit-matrix-answers.json');

function git(dir, ...args) {
    return execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function projectOf(files) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-units-test-')));
    for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
}

/** The model's rows for one file of a project. */
function rowsOf(index, relativePath) {
    index._beginOp();
    try {
        const model = createTestModel(index);
        const filePath = path.join(index.root, relativePath);
        return {
            model,
            filePath,
            facts: model.fileFacts(filePath),
            units: model.unitsOf(filePath).units.map(unit => ({
                label: unitLabel(unit), kind: unit.kind, ...model.describe(filePath, unit),
            })),
        };
    } finally {
        index._endOp();
    }
}

describe('test units: the engine answer on every matrix case', () => {
    for (const testCase of CASES) {
        it(testCase.id, () => {
            const dir = projectOf(testCase.files);
            try {
                assert.ok(PINNED[testCase.id], 'the case has a pinned answer');
                assert.deepStrictEqual(answerOf(dir).lines, PINNED[testCase.id]);
            } finally {
                rm(dir);
            }
        });
    }

    it('every pinned answer belongs to a case', () => {
        const ids = new Set(CASES.map(testCase => testCase.id));
        assert.deepStrictEqual(Object.keys(PINNED).filter(id => !ids.has(id)), []);
    });
});

describe('test units: manifests are read as their own tools read them', () => {
    it('names the runner a package script starts, through wrappers and environment', () => {
        assert.deepStrictEqual(scriptRunners('jest'), ['jest']);
        assert.deepStrictEqual(scriptRunners('NODE_ENV=test npx vitest run'), ['vitest']);
        assert.deepStrictEqual(scriptRunners('tsc -p . && c8 mocha --recursive'), ['?tsc', 'mocha']);
        assert.deepStrictEqual(scriptRunners('node --test test/'), ['node-test']);
        assert.deepStrictEqual(scriptRunners('node scripts/run.js'), ['?node']);
        assert.deepStrictEqual(scriptRunners('bun test'), ['bun']);
        assert.deepStrictEqual(scriptRunners(undefined), []);
    });

    it('keeps the node options that decide how a test file loads, and only those', () => {
        assert.deepStrictEqual(nodeTestOptions('node --test --import tsx --test-reporter spec test/*.test.ts'),
            ['--import', 'tsx']);
        assert.deepStrictEqual(nodeTestOptions('node --experimental-strip-types --test --test-concurrency 2'),
            ['--experimental-strip-types']);
        assert.deepStrictEqual(nodeTestOptions('node --test'), []);
        assert.strictEqual(nodeTestOptions('node --test && eslint .'), null);
        assert.strictEqual(nodeTestOptions('jest'), null);
    });

    it('reads a pytest table and its name lists from INI and TOML', () => {
        const ini = '[tox]\nenvlist = py3\n\n[pytest]\npython_files = check_*.py\n    spec_*.py\npython_functions = check_* verify\n\n[other]\npython_classes = No\n';
        const table = tableText(ini, 'pytest');
        assert.deepStrictEqual(configWords(table, 'python_files'), ['check_*.py', 'spec_*.py']);
        assert.deepStrictEqual(configWords(table, 'python_functions'), ['check_*', 'verify']);
        assert.strictEqual(configWords(table, 'python_classes'), null);
        const toml = '[tool.pytest.ini_options]\npython_functions = [\n  "spec_*",\n  "test_*",\n]\npython_classes = "Describe*"\n';
        const tomlTable = tableText(toml, 'tool.pytest.ini_options');
        assert.deepStrictEqual(configWords(tomlTable, 'python_functions'), ['spec_*', 'test_*']);
        assert.deepStrictEqual(configWords(tomlTable, 'python_classes'), ['Describe*']);
        assert.strictEqual(tableText(toml, 'tool.other'), null);
    });
});

describe('test units: a line belongs to the innermost unit that holds it', () => {
    const FILES = {
        'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
        'lib.js': 'function target() { return 1; }\nmodule.exports = { target };\n',
        'test/a.test.js': [
            "const { describe, it, before } = require('node:test');",    // 1
            "const { target } = require('../lib');",                     // 2
            'function helper() { return target(); }',                    // 3
            "describe('outer', () => {",                                 // 4
            '    before(() => { target(); });',                          // 5
            "    it('first', () => { target(); });",                     // 6
            "    describe('inner', () => {",                             // 7
            "        it('second', () => {",                              // 8
            '            target();',                                     // 9
            '        });',                                               // 10
            '    });',                                                   // 11
            '});',                                                       // 12
            "it('third', () => { helper(); });",                         // 13
            '',
        ].join('\n'),
        'test/helpers.js': "const { target } = require('../lib');\nmodule.exports = { make() { return target(); } };\n",
    };

    it('a test before a suite, a suite before the file', () => {
        const dir = projectOf(FILES);
        try {
            const index = idx(dir);
            const { model, filePath } = rowsOf(index, 'test/a.test.js');
            assert.strictEqual(unitLabel(model.unitAt(filePath, 9)), 'outer > inner > second');
            assert.strictEqual(unitLabel(model.unitAt(filePath, 6)), 'outer > first');
            assert.strictEqual(model.unitAt(filePath, 5).kind, 'suite');
            assert.strictEqual(unitLabel(model.unitAt(filePath, 5)), 'outer');
            assert.strictEqual(model.unitAt(filePath, 3), null);
        } finally {
            rm(dir);
        }
    });

    it('counts a suite-level line as the suite\'s tests and a file-level line as the file\'s', () => {
        const dir = projectOf(FILES);
        try {
            const index = idx(dir);
            index._beginOp();
            try {
                const model = createTestModel(index);
                const filePath = path.join(index.root, 'test/a.test.js');
                assert.strictEqual(linkFile(model, index, filePath, [9]).tests, 1);
                assert.strictEqual(linkFile(model, index, filePath, [5]).tests, 2, 'a hook runs with both tests of its suite');
                assert.strictEqual(linkFile(model, index, filePath, [3]).tests, 3, 'a helper at file level runs with every test');
                assert.strictEqual(linkFile(model, index, filePath, [6, 9]).tests, 2);
                const support = linkFile(model, index, path.join(index.root, 'test/helpers.js'), [2]);
                assert.strictEqual(support.role, 'support');
                assert.strictEqual(support.tests, 0);
                assert.strictEqual(support.run, undefined);
            } finally {
                index._endOp();
            }
        } finally {
            rm(dir);
        }
    });

    it('`tests` lists the test that holds each call, says how many tests, and how to run the file', () => {
        const dir = projectOf(FILES);
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'target' });
            assert.ok(result.ok, result.error);
            const byFile = new Map(result.result.map(row => [row.file, row]));
            const tests = byFile.get('test/a.test.js');
            assert.strictEqual(tests.role, 'tests');
            assert.strictEqual(tests.runner, 'node-test');
            assert.strictEqual(tests.tests, 3);
            assert.strictEqual(selectorText(tests.run), 'node --test test/a.test.js');
            assert.deepStrictEqual(tests.units.filter(unit => unit.kind === 'test').map(unit => unitLabel(unit)),
                ['outer > first', 'outer > inner > second']);
            assert.strictEqual(selectorText(tests.units.find(unit => unit.name === 'second').selector),
                "node --test --test-name-pattern='^outer inner second$' test/a.test.js");
            // A test written on the line of its call needs no row of its own.
            assert.deepStrictEqual(tests.matches.filter(match => match.matchType === 'test-case').map(match => match.line),
                [8]);
            const support = byFile.get('test/helpers.js');
            assert.strictEqual(support.role, 'support');
            assert.strictEqual(support.run, undefined);
            const text = output.formatTests(result.result, 'target');
            assert.match(text, /test\/a\.test\.js {2}\(3 tests\)/);
            assert.match(text, /\n {2}run: node --test test\/a\.test\.js\n/);
            assert.match(text, /test\/helpers\.js {2}\[support: declares no test\]/);
            assert.doesNotMatch(text, /run: node --test test\/helpers\.js/);
        } finally {
            rm(dir);
        }
    });

    it('a title that names the function is a link only around a call when the selection needs one', () => {
        const dir = projectOf({
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'lib.js': 'function target() { return 1; }\nmodule.exports = { target };\n',
            'test/t.test.js': [
                "const { describe, it } = require('node:test');",
                "const { target } = require('../lib');",
                "describe('target', () => {",
                "    it('is called', () => { target(); });",
                '});',
                "describe('untargeted zone', () => {",
                "    it('mentions target in prose only', () => {});",
                '});',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const direct = execute(index, 'tests', { name: 'target' }).result[0];
            assert.deepStrictEqual(direct.matches.filter(match => match.matchType === 'test-case').map(match => match.line),
                [3, 7], 'a title names the function where the word stands alone');
            const affected = index.affectedTests('target', { depth: 1 });
            assert.deepStrictEqual(affected.testFiles[0].matches.filter(match => match.matchType === 'test-case')
                .map(match => match.line), [3]);
            assert.strictEqual(affected.summary.totalTests, 1);
        } finally {
            rm(dir);
        }
    });
});

describe('test units: inherited tests run where the deriving class is', () => {
    const FILES = {
        'pytest.ini': '[pytest]\n',
        'app.py': 'def target():\n    return 1\n',
        'tests/__init__.py': '',
        'tests/base.py': 'from app import target\n\nclass Checks:\n    def test_shared(self):\n        assert target() == 1\n\n    def helper(self):\n        return target()\n',
        'tests/test_child.py': 'from tests.base import Checks\n\nclass TestChild(Checks):\n    pass\n\nclass TestOther(Checks):\n    def test_shared(self):\n        pass\n',
    };

    it('a call in a base class method is run by the classes that inherit the method', () => {
        const dir = projectOf(FILES);
        try {
            const index = idx(dir);
            index._beginOp();
            try {
                const model = createTestModel(index);
                const base = path.join(index.root, 'tests/base.py');
                const child = path.join(index.root, 'tests/test_child.py');
                const runs = model.runsAt(base, 5);
                assert.deepStrictEqual(runs.map(run => `${index.files.get(run.filePath).relativePath}::${unitLabel(run.unit)}`),
                    ['tests/test_child.py::TestChild > test_shared']);
                // The base file is support: it holds no test and has no
                // command. The test is handed to the file that runs it.
                const own = linkFile(model, index, base, [5]);
                assert.strictEqual(own.role, 'support');
                assert.strictEqual(own.tests, 0);
                assert.deepStrictEqual(own.units, []);
                assert.strictEqual(own.carried.length, 1);
                const linked = linkFiles(model, index, new Map([[base, [5]]]));
                assert.deepStrictEqual([...linked.keys()], [base, child]);
                const carried = linked.get(child);
                assert.strictEqual(carried.role, 'tests');
                assert.strictEqual(carried.tests, 1);
                assert.deepStrictEqual(carried.from, ['tests/base.py']);
                assert.strictEqual(carried.units[0].inheritedFrom, 'tests/base.py:4');
                assert.strictEqual(selectorText(carried.units[0].selector), 'pytest tests/test_child.py::TestChild::test_shared');
                assert.strictEqual(selectorText(carried.run), 'pytest tests/test_child.py');
                assert.strictEqual(linkFiles(model, index, new Map([[base, [8]]])).size, 1,
                    'a helper of a class nothing collects is file-level support code');
            } finally {
                index._endOp();
            }
        } finally {
            rm(dir);
        }
    });

    it('tests, the affected-test selection and check all name the file that runs an inherited test', () => {
        const dir = projectOf(FILES);
        try {
            git(dir, 'init', '-q');
            git(dir, 'add', '-A');
            git(dir, 'commit', '-q', '-m', 'base');
            fs.writeFileSync(path.join(dir, 'app.py'), 'def target():\n    return 1 + 0\n');
            const index = idx(dir);

            const direct = execute(index, 'tests', { name: 'target' }).result;
            const byFile = new Map(direct.map(row => [row.file, row]));
            assert.strictEqual(byFile.get('tests/base.py').role, 'support');
            const child = byFile.get('tests/test_child.py');
            assert.strictEqual(child.role, 'tests');
            assert.strictEqual(child.tests, 1);
            assert.deepStrictEqual(child.matches.map(match => `${match.line}:${match.matchType}:${match.name}:${match.from}`),
                ['3:inherited-test:test_shared:tests/base.py:4']);
            const text = output.formatTests(direct, 'target');
            assert.match(text, /tests\/test_child\.py {2}\(1 test\)\n {2}3: \[inherited\] class TestChild\(Checks\): {2}test_shared \(from tests\/base\.py:4\)\n {2}run: pytest tests\/test_child\.py/);

            const affected = index.affectedTests('target', { depth: 2 });
            const rows = new Map(affected.testFiles.map(row => [row.file, row]));
            assert.strictEqual(rows.get('tests/base.py').role, 'support');
            assert.strictEqual(rows.get('tests/test_child.py').testCount, 1);
            assert.deepStrictEqual(rows.get('tests/test_child.py').linkedFunctions, ['target']);
            assert.strictEqual(affected.summary.totalTests, 1);
            assert.deepStrictEqual(affected.commands, ['pytest tests/test_child.py']);

            const checked = execute(index, 'check', {});
            assert.ok(checked.ok, checked.error);
            assert.strictEqual(checked.result.totalTests, 1);
            assert.deepStrictEqual(checked.result.testFiles.map(row => row.file), ['tests/test_child.py']);
            assert.deepStrictEqual(checked.result.supportFiles.map(row => row.file), ['tests/base.py']);
            assert.deepStrictEqual(checked.result.actions.find(row => row.kind === 'tests_to_run').commands,
                ['pytest tests/test_child.py']);
        } finally {
            rm(dir);
        }
    });

    it('an inherited test is the body Python looks up, not the first one a depth-first walk meets', () => {
        const dir = projectOf({
            'pytest.ini': '[pytest]\n',
            'app.py': 'def target():\n    return 1\n\ndef other():\n    return 2\n',
            'tests/__init__.py': '',
            'tests/base.py': [
                'from app import target, other',
                '',
                'class Root:',
                '    def test_shared(self):',
                '        assert target() == 1',
                '',
                'class Left(Root):',
                '    pass',
                '',
                'class Right(Root):',
                '    def test_shared(self):',
                '        assert other() == 2',
                '',
            ].join('\n'),
            'tests/test_leaf.py': 'from tests.base import Left, Right\n\nclass TestLeaf(Left, Right):\n    pass\n',
        });
        try {
            const index = idx(dir);
            const rootBody = index.affectedTests('target', { depth: 2 });
            assert.strictEqual(rootBody.summary.totalTests, 0, 'the body that calls target is not the one TestLeaf runs');
            assert.deepStrictEqual(rootBody.commands, []);
            const rightBody = index.affectedTests('other', { depth: 2 });
            assert.strictEqual(rightBody.summary.totalTests, 1);
            const leaf = rightBody.testFiles.find(row => row.file === 'tests/test_leaf.py');
            assert.strictEqual(leaf.units[0].inheritedFrom, 'tests/base.py:11');
            assert.deepStrictEqual(rightBody.commands, ['pytest tests/test_leaf.py']);
        } finally {
            rm(dir);
        }
    });
});

describe('test units: the model keeps nothing between two questions', () => {
    it('a manifest written after the first answer is read by the second, on the same index', () => {
        const dir = projectOf({
            'lib.js': 'function target() { return 1; }\nmodule.exports = { target };\n',
            'src/a.test.js': "const { target } = require('../lib');\ndescribe('a', () => { it('b', () => { target(); }); });\n",
        });
        try {
            const index = idx(dir);
            const before = execute(index, 'tests', { name: 'target' }).result[0];
            assert.strictEqual(before.run, undefined);
            assert.strictEqual(before.runWithheld, 'no-runner-evidence');
            fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "x", "scripts": { "test": "jest" } }\n');
            const after = execute(index, 'tests', { name: 'target' }).result[0];
            assert.strictEqual(selectorText(after.run), 'npx jest --runTestsByPath src/a.test.js');
            const fresh = execute(idx(dir), 'tests', { name: 'target' }).result[0];
            assert.deepStrictEqual(after, fresh);
        } finally {
            rm(dir);
        }
    });
});

describe('test units: the affected-test selection takes a declaration, not a name', () => {
    const FILES = {
        'pytest.ini': '[pytest]\n',
        'lib.py': 'class A:\n    def run(self):\n        return 1\n\nclass B:\n    def run(self):\n        return 2\n',
        'tests/test_a.py': 'from lib import A\n\ndef test_a():\n    assert A().run() == 1\n',
        'tests/test_b.py': 'from lib import B\n\ndef test_b():\n    assert B().run() == 2\n\ndef test_b_again():\n    assert B().run() == 2\n',
        'tests/conftest.py': '',
    };

    it('a line pin selects one of two same-name methods of one file', () => {
        const dir = projectOf(FILES);
        try {
            const index = idx(dir);
            const first = index.affectedTests('run', { file: 'lib.py', line: 2, depth: 1 });
            assert.deepStrictEqual(first.testFiles.map(row => row.file), ['tests/test_a.py']);
            const second = index.affectedTests('run', { file: 'lib.py', line: 6, depth: 1 });
            assert.deepStrictEqual(second.testFiles.map(row => row.file), ['tests/test_b.py']);
            assert.strictEqual(second.summary.totalTests, 2);
            assert.deepStrictEqual(second.commands, ['pytest tests/test_b.py']);
            assert.deepStrictEqual(second.testFiles[0].units.map(unit => selectorText(unit.selector)),
                ['pytest tests/test_b.py::test_b', 'pytest tests/test_b.py::test_b_again']);
        } finally {
            rm(dir);
        }
    });

    it('check asks for every changed symbol by its declaration and counts each test once', () => {
        const dir = projectOf(FILES);
        try {
            git(dir, 'init', '-q');
            git(dir, 'add', '-A');
            git(dir, 'commit', '-q', '-m', 'base');
            fs.writeFileSync(path.join(dir, 'lib.py'),
                'class A:\n    def run(self):\n        return 1\n\nclass B:\n    def run(self):\n        return 2 + 0\n');
            const only = execute(idx(dir), 'check', {});
            assert.ok(only.ok, only.error);
            assert.deepStrictEqual(only.result.testFiles.map(row => row.file), ['tests/test_b.py']);
            assert.strictEqual(only.result.totalTests, 2);
            const text = output.formatCheck(only.result);
            assert.match(text, /Tests potentially affected: 2 in 1 file\n {2}tests\/test_b\.py \(2\)/);
            assert.match(text, /Run tests: pytest tests\/test_b\.py/);

            fs.writeFileSync(path.join(dir, 'lib.py'),
                'class A:\n    def run(self):\n        return 1 + 0\n\nclass B:\n    def run(self):\n        return 2 + 0\n');
            const both = execute(idx(dir), 'check', {});
            assert.deepStrictEqual(both.result.testFiles.map(row => row.file), ['tests/test_a.py', 'tests/test_b.py']);
            assert.strictEqual(both.result.totalTests, 3);
            const action = both.result.actions.find(row => row.kind === 'tests_to_run');
            assert.deepStrictEqual(action.commands, ['pytest tests/test_a.py tests/test_b.py']);
        } finally {
            rm(dir);
        }
    });

    it('check reaches past the tenth changed symbol', () => {
        const names = Array.from({ length: 12 }, (_, i) => `fn${i}`);
        const lib = body => names.map(name => `def ${name}():\n    return ${body}\n`).join('\n');
        const dir = projectOf({
            'pytest.ini': '[pytest]\n',
            'lib.py': lib('1'),
            'tests/test_last.py': 'from lib import fn11\n\ndef test_last():\n    assert fn11()\n',
        });
        try {
            git(dir, 'init', '-q');
            git(dir, 'add', '-A');
            git(dir, 'commit', '-q', '-m', 'base');
            fs.writeFileSync(path.join(dir, 'lib.py'), lib('2'));
            const result = execute(idx(dir), 'check', {});
            assert.ok(result.ok, result.error);
            assert.deepStrictEqual(result.result.testFiles.map(row => row.file), ['tests/test_last.py']);
            assert.strictEqual(result.result.totalTests, 1);
        } finally {
            rm(dir);
        }
    });

    it('support code a change reaches is named and is not something to run', () => {
        const dir = projectOf({
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'lib.js': 'function target() { return 1; }\nmodule.exports = { target };\n',
            'test/helpers.js': "const { target } = require('../lib');\nfunction make() { return target(); }\nmodule.exports = { make };\n",
            'test/a.test.js': "const { it } = require('node:test');\nconst { make } = require('./helpers');\nit('uses the helper', () => { make(); });\n",
        });
        try {
            const index = idx(dir);
            const affected = index.affectedTests('target', { depth: 2 });
            const roles = new Map(affected.testFiles.map(row => [row.file, row.role]));
            assert.strictEqual(roles.get('test/helpers.js'), 'support');
            assert.strictEqual(roles.get('test/a.test.js'), 'tests');
            assert.deepStrictEqual(affected.commands, ['node --test test/a.test.js']);
            assert.strictEqual(affected.summary.totalTests, 1);
            assert.strictEqual(affected.summary.supportFiles, 1);
            const text = output.formatAffectedTests(affected);
            assert.match(text, /Test files to run \(1\), 1 test:/);
            assert.match(text, /Test support code reached \(1\)/);
            assert.match(text, /\nRun:\n {2}node --test test\/a\.test\.js\n/);
        } finally {
            rm(dir);
        }
    });
});

describe('test units: a language whose tests are not read', () => {
    it('keeps the harness-invoked function as the row and claims no unit, count or command', () => {
        const dir = projectOf({
            'lib.c': 'int target(int a) { return a; }\n',
            'lib.h': 'int target(int a);\n',
            'tests/test_lib.c': '#include "../lib.h"\n\nvoid test_target(void) {\n    target(1);\n}\n',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'tests', { name: 'target' });
            assert.ok(result.ok, result.error);
            const row = result.result.find(file => file.file === 'tests/test_lib.c');
            assert.deepStrictEqual(row.matches.map(match => `${match.line}:${match.matchType}`), ['3:test-case', '4:call']);
            assert.strictEqual(row.role, 'unmodeled');
            assert.strictEqual(row.tests, 0);
            assert.strictEqual(row.units, undefined);
            assert.strictEqual(row.run, undefined);
        } finally {
            rm(dir);
        }
    });
});

describe('test units: commands for several files', () => {
    it('joins the files of one runner and one directory, and keeps other runners apart', () => {
        const dir = projectOf({
            'package.json': '{ "name": "root" }\n',
            'web/package.json': '{ "name": "web", "scripts": { "test": "vitest run" } }\n',
            'web/src/a.test.js': "import { it } from 'vitest';\nit('a', () => {});\n",
            'web/src/b.test.js': "import { it } from 'vitest';\nit('b', () => {});\n",
            'api/go.mod': 'module example.com/api\n\ngo 1.21\n',
            'api/pkg/x_test.go': 'package pkg\n\nimport "testing"\n\nfunc TestX(t *testing.T) {}\n',
            'api/pkg/y_test.go': 'package pkg\n\nimport "testing"\n\nfunc TestY(t *testing.T) {}\n',
        });
        try {
            const index = idx(dir);
            index._beginOp();
            try {
                const model = createTestModel(index);
                const files = ['web/src/a.test.js', 'web/src/b.test.js', 'api/pkg/x_test.go', 'api/pkg/y_test.go']
                    .map(rel => path.join(index.root, rel));
                assert.deepStrictEqual(commandsFor(model, files), [
                    '(cd web && npx vitest run src/a.test.js src/b.test.js)',
                    '(cd api && go test ./pkg)',
                ]);
            } finally {
                index._endOp();
            }
        } finally {
            rm(dir);
        }
    });
});

describe('test units: verify reads "in a test" from the same model', () => {
    it('a call in a helper far below no test is not in a test; a call in a test is', () => {
        const filler = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join('\n');
        const dir = tmp({
            'lib.js': 'function target(a) { return a; }\nmodule.exports = { target };\n',
            'test/a.test.js': [
                "const { it } = require('node:test');",
                "const { target } = require('../lib');",
                "it('calls it', () => { target(1); });",
                filler,
                'function helper() { return target(2); }',
                'module.exports = { helper };',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = index.verify('target', {});
            const flagged = new Map(result.validDetails.map(site => [site.line, site.patterns.inTestCase]));
            assert.strictEqual(flagged.get(3), true);
            assert.strictEqual(flagged.get(24), false);
        } finally {
            rm(dir);
        }
    });
});

describe('test units: a runner bound under another name is still the runner', () => {
    const LIB = 'function target() { return 1; }\nmodule.exports = { target };\n';
    const MANIFEST = '{ "name": "x", "scripts": { "test": "node --test" } }\n';

    for (const [form, source] of [
        ['an aliased member', "const { test: caseIt } = require('node:test');\nconst { target } = require('../lib');\ncaseIt('aliased', () => { target(); });\n"],
        ['the module itself', "const runner = require('node:test');\nconst { target } = require('../lib');\nrunner.test('namespaced', () => { target(); });\n"],
        ['a second name for an alias', "const { it: spec } = require('node:test');\nconst again = spec;\nconst { target } = require('../lib');\nagain('twice removed', () => { target(); });\n"],
    ]) {
        it(`${form} declares a test: the file is not support`, () => {
            const dir = projectOf({ 'package.json': MANIFEST, 'lib.js': LIB, 'test/names.js': source });
            try {
                const index = idx(dir);
                const rows = rowsOf(index, 'test/names.js');
                assert.strictEqual(rows.facts.role, 'tests');
                assert.strictEqual(rows.facts.tests, 1);
                const affected = index.affectedTests('target', { depth: 2 });
                assert.strictEqual(affected.summary.totalTests, 1);
                assert.deepStrictEqual(affected.commands, ['node --test test/names.js']);
            } finally {
                rm(dir);
            }
        });
    }

    it('a name the file gives to something else is not the runner; one bound inside a function says nothing of the file', () => {
        const dir = projectOf({
            'package.json': MANIFEST,
            'test/own.test.js': "const { describe, it } = require('node:test');\nfunction test(value) { return value; }\ndescribe('group', () => {\n    it('real', () => { test('not a title', () => {}); });\n});\n",
            'test/inner.test.js': "const { test } = require('node:test');\nfunction helper() { const test = { a: 1 }; return test; }\ntest('still a test', () => { helper(); });\n",
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(rowsOf(index, 'test/own.test.js').units.filter(unit => unit.kind === 'test').map(unit => unit.label),
                ['group > real']);
            assert.deepStrictEqual(rowsOf(index, 'test/inner.test.js').units.map(unit => unit.label), ['still a test']);
        } finally {
            rm(dir);
        }
    });

    it('a file that binds the runner and declares nothing readable is a test file with a command, never support', () => {
        const dir = projectOf({
            'package.json': MANIFEST,
            'test/computed.js': "const runner = require('node:test');\nconst pick = runner[process.env.NAME || 'test'];\npick('at run time', () => {});\n",
            'test/hooks.js': "const { beforeEach } = require('node:test');\nmodule.exports = () => beforeEach(() => {});\n",
        });
        try {
            const index = idx(dir);
            const computed = rowsOf(index, 'test/computed.js').facts;
            assert.strictEqual(computed.role, 'tests');
            assert.strictEqual(computed.tests, 0);
            assert.strictEqual(selectorText(computed.run), 'node --test test/computed.js');
            assert.strictEqual(rowsOf(index, 'test/hooks.js').facts.role, 'support');
        } finally {
            rm(dir);
        }
    });
});

describe('test units: one declaration is one test', () => {
    it('two tests of one name are two tests, and neither has a command of its own', () => {
        const dir = projectOf({
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'lib.js': 'function target() { return 1; }\nmodule.exports = { target };\n',
            'test/twice.test.js': "const { test } = require('node:test');\nconst { target } = require('../lib');\ntest('same', () => { target(); });\ntest('same', () => { target(); });\ntest('alone', () => { target(); });\n",
        });
        try {
            const index = idx(dir);
            index._beginOp();
            try {
                const model = createTestModel(index);
                const filePath = path.join(index.root, 'test/twice.test.js');
                const linked = linkFile(model, index, filePath, [3, 4, 5]);
                assert.strictEqual(linked.tests, 3);
                assert.deepStrictEqual(linked.units.map(unit => `${unit.line}:${unit.name}:${unit.selectorWithheld || 'command'}`),
                    ['3:same:name-not-unique', '4:same:name-not-unique', '5:alone:command']);
                assert.strictEqual(selectorText(linked.run), 'node --test test/twice.test.js');
            } finally {
                index._endOp();
            }
        } finally {
            rm(dir);
        }
    });

    it('of two Python definitions of one name the last is the test', () => {
        const dir = projectOf({
            'pytest.ini': '[pytest]\n',
            'tests/test_d.py': 'def test_a():\n    pass\n\ndef test_a():\n    pass\n',
        });
        try {
            const rows = rowsOf(idx(dir), 'tests/test_d.py');
            assert.deepStrictEqual(rows.units.map(unit => `${unit.line}:${unit.label}`), ['4:test_a']);
            assert.strictEqual(selectorText(rows.units[0].selector), 'pytest tests/test_d.py::test_a');
        } finally {
            rm(dir);
        }
    });

    it('a test that is declared and not executed is listed, marked, and not counted', () => {
        const dir = projectOf({
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'lib.js': 'function target() { return 1; }\nmodule.exports = { target };\n',
            'test/s.test.js': "const { test, describe, it } = require('node:test');\nconst { target } = require('../lib');\ntest.skip('off', () => { target(); });\ndescribe.skip('group', () => {\n    it('inside', () => { target(); });\n});\ntest('on', () => { target(); });\n",
        });
        try {
            const index = idx(dir);
            const rows = rowsOf(index, 'test/s.test.js');
            assert.strictEqual(rows.facts.tests, 1);
            assert.deepStrictEqual(rows.units.filter(unit => unit.kind === 'test').map(unit => `${unit.label}:${!!unit.skipped}`),
                ['off:true', 'group > inside:true', 'on:false']);
            assert.strictEqual(index.affectedTests('target', { depth: 1 }).summary.totalTests, 1);
        } finally {
            rm(dir);
        }
    });
});

describe('test units: what pytest does not collect is not a test', () => {
    for (const [form, source, units] of [
        ['a module switched off', 'from app import target\n__test__ = False\n\ndef test_hidden():\n    target()\n', 0],
        ['a class with __new__', 'from app import target\nclass TestNew:\n    def __new__(cls):\n        return object.__new__(cls)\n    def test_hidden(self):\n        target()\n', 0],
        ['a class that inherits __new__', 'from app import target\nclass Built:\n    def __new__(cls):\n        return object.__new__(cls)\nclass TestNew(Built):\n    def test_hidden(self):\n        target()\n', 0],
        ['a function switched off', 'from app import target\ndef test_hidden():\n    target()\ntest_hidden.__test__ = False\n', 0],
        ['a module switched on (the control)', 'from app import target\n__test__ = True\n\ndef test_shown():\n    target()\n', 1],
    ]) {
        it(form, () => {
            const dir = projectOf({
                'pytest.ini': '[pytest]\n', 'app.py': 'def target():\n    return 1\n',
                'tests/__init__.py': '', 'tests/test_f.py': source,
            });
            try {
                const index = idx(dir);
                const rows = rowsOf(index, 'tests/test_f.py');
                assert.strictEqual(rows.facts.tests, units);
                assert.strictEqual(rows.units.filter(unit => unit.kind === 'test').length, units);
                assert.strictEqual(index.affectedTests('target', { depth: 2 }).summary.totalTests, units);
            } finally {
                rm(dir);
            }
        });
    }

    it('a module that is switched off has no command; a switch that is not read leaves units without one', () => {
        const dir = projectOf({
            'pytest.ini': '[pytest]\n',
            'tests/test_off.py': '__test__ = False\n\ndef test_hidden():\n    pass\n',
            'tests/test_maybe.py': 'def nottest(f):\n    f.__test__ = False\n    return f\n\n@nottest\ndef test_a():\n    pass\n',
        });
        try {
            const index = idx(dir);
            const off = rowsOf(index, 'tests/test_off.py').facts;
            assert.strictEqual(off.run, undefined);
            assert.strictEqual(off.runWithheld, 'collection-switched-off');
            const maybe = rowsOf(index, 'tests/test_maybe.py');
            assert.deepStrictEqual(maybe.units.map(unit => `${unit.label}:${unit.selectorWithheld}:${!!unit.conditional}`),
                ['test_a:collection-switch:true']);
            assert.strictEqual(selectorText(maybe.facts.run), 'pytest tests/test_maybe.py');
        } finally {
            rm(dir);
        }
    });
});

describe('test units: a command the file answer withholds is not offered anywhere else', () => {
    it('a test declared inside a function nothing calls gives no command, alone or joined', () => {
        const dir = projectOf({
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'lib.js': 'function target() { return 1; }\nmodule.exports = { target };\n',
            'test/indirect.test.js': "const { test } = require('node:test');\nconst { target } = require('../lib');\nfunction register() {\n    test('never registered', () => { target(); });\n}\n",
            'test/direct.test.js': "const { test } = require('node:test');\nconst { target } = require('../lib');\ntest('registered', () => { target(); });\n",
        });
        try {
            const index = idx(dir);
            index._beginOp();
            try {
                const model = createTestModel(index);
                const indirect = path.join(index.root, 'test/indirect.test.js');
                const direct = path.join(index.root, 'test/direct.test.js');
                assert.strictEqual(model.fileFacts(indirect).runWithheld, 'declared-indirectly');
                assert.deepStrictEqual(commandsFor(model, [indirect]), []);
                assert.deepStrictEqual(commandsFor(model, [indirect, direct]), ['node --test test/direct.test.js']);
            } finally {
                index._endOp();
            }
            assert.deepStrictEqual(index.affectedTests('target', { depth: 2 }).commands, ['node --test test/direct.test.js']);
        } finally {
            rm(dir);
        }
    });
});

describe('test units: a test with no body', () => {
    it('is declared and not executed, whatever the runner calls it', () => {
        const dir = projectOf({
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n',
            'test/p.test.js': "it('pending, no body');\nit('runs', function () {});\ndescribe('empty group');\n",
        });
        try {
            const rows = rowsOf(idx(dir), 'test/p.test.js');
            assert.deepStrictEqual(rows.units.filter(unit => unit.kind === 'test').map(unit => `${unit.label}:${!!unit.skipped}`),
                ['pending, no body:true', 'runs:false']);
            assert.strictEqual(rows.facts.tests, 1);
        } finally {
            rm(dir);
        }
    });
});

describe('test units: a focused test and the rest of its file', () => {
    const SOURCE = "it.only('focused', () => {});\nit('left out', () => {});\n";

    it('under jest the others are declared and not executed; under node the mark does nothing by itself', () => {
        const jest = projectOf({
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'src/f.test.js': SOURCE,
        });
        const node = projectOf({
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'src/f.test.js': "const { it } = require('node:test');\n" + SOURCE,
        });
        try {
            const underJest = rowsOf(idx(jest), 'src/f.test.js');
            assert.deepStrictEqual(underJest.units.map(unit => `${unit.label}:${!!unit.skipped}`),
                ['focused:false', 'left out:true']);
            assert.strictEqual(underJest.facts.tests, 1);
            const underNode = rowsOf(idx(node), 'src/f.test.js');
            assert.deepStrictEqual(underNode.units.map(unit => `${unit.label}:${!!unit.skipped}`),
                ['focused:false', 'left out:false']);
            assert.strictEqual(underNode.facts.tests, 2);
        } finally {
            rm(jest);
            rm(node);
        }
    });
});

describe('test units: check names nothing to run that would not run', () => {
    it('with no runner proven, a file whose tests are declared inside functions is not suggested', () => {
        const dir = projectOf({
            'lib.js': 'function target() { return 1; }\nmodule.exports = { target };\n',
            'src/indirect.test.js': "const { target } = require('../lib');\nfunction register() {\n    it('never registered', () => { target(); });\n}\nmodule.exports = { register };\n",
            'src/direct.test.js': "const { target } = require('../lib');\nit('registered', () => { target(); });\n",
        });
        try {
            git(dir, 'init', '-q');
            git(dir, 'add', '-A');
            git(dir, 'commit', '-q', '-m', 'base');
            fs.writeFileSync(path.join(dir, 'lib.js'), 'function target() { return 1 + 0; }\nmodule.exports = { target };\n');
            const result = execute(idx(dir), 'check', {});
            assert.ok(result.ok, result.error);
            const action = result.result.actions.find(row => row.kind === 'tests_to_run');
            assert.strictEqual(action.message, 'Run tests: src/direct.test.js');
            assert.strictEqual(action.commands, undefined);
            const text = output.formatAffectedTests(idx(dir).affectedTests('target', { depth: 2 }));
            assert.match(text, /src\/indirect\.test\.js \(links: [^)]*\) · 1 test · no command: declared-indirectly/);
        } finally {
            rm(dir);
        }
    });
});

describe('test units: the judge rejects what the runner contradicts', () => {
    const unit = (line, more = {}) => ({
        id: 'a.test.js::same', file: 'a.test.js', line, startLine: line, endLine: line,
        selector: null, conditional: false, skipped: false, inherited: false, ...more,
    });
    const files = tests => [{ file: 'a.test.js', role: 'tests', run: 'run a.test.js', tests }];
    const kinds = (testCase, answer, ran) => judgeWholeRun(testCase, answer, ran).problems.map(problem => problem.kind);

    it('a test called skipped that executes is a false skip', () => {
        assert.deepStrictEqual(kinds({}, { units: [unit(3, { skipped: true })], files: files(0) }, ['a.test.js:3']),
            ['FALSE-SKIP']);
        assert.deepStrictEqual(kinds({}, { units: [unit(3, { skipped: true })], files: files(0) }, []), []);
    });

    it('two declarations of one name are two identities: one executing does not stand for the other', () => {
        const answer = { units: [unit(3), unit(4)], files: files(2) };
        assert.deepStrictEqual(kinds({}, answer, ['a.test.js:3', 'a.test.js:4']), []);
        assert.deepStrictEqual(kinds({}, answer, ['a.test.js:3']), ['FALSE-UNIT']);
    });

    it('a weaker claim must be named by the case, and a count must be the listed tests', () => {
        const answer = { units: [unit(3, { conditional: true })], files: files(1) };
        assert.deepStrictEqual(kinds({}, answer, []), ['SOMETIMES']);
        assert.deepStrictEqual(kinds({ sometimes: ['a.test.js::same'] }, answer, []), []);
        assert.deepStrictEqual(kinds({}, { units: [unit(3)], files: files(2) }, ['a.test.js:3']), ['COUNT']);
    });

    it('an execution no listed unit owns is undeclared, and makes a support label false', () => {
        assert.deepStrictEqual(kinds({}, { units: [unit(3)], files: files(1) }, ['a.test.js:3', 'a.test.js:9']),
            ['UNDECLARED']);
        const support = { units: [], files: [{ file: 'helper.js', role: 'support', run: null, tests: 0 }] };
        assert.deepStrictEqual(kinds({}, support, ['helper.js:2']), ['FALSE-SUPPORT', 'UNDECLARED']);
    });

    it('an inherited test is the body the engine names: another body running is not it', () => {
        const inherited = unit(5, {
            id: 'child.py::TestLeaf > test_shared', file: 'child.py', inherited: true,
            origin: { file: 'base.py', startLine: 10, endLine: 12 },
        });
        const answer = { units: [inherited], files: [{ file: 'child.py', role: 'tests', run: 'x', tests: 1 }] };
        assert.deepStrictEqual(kinds({}, answer, ['child.py::TestLeaf > test_shared', 'base.py:11']), []);
        assert.deepStrictEqual(kinds({}, answer, ['child.py::TestLeaf > test_shared', 'base.py:4']), ['UNDECLARED']);
    });
});

describe('test units: Python collection is read from syntax, and the last assignment is the one in effect', () => {
    const rows = source => {
        const dir = projectOf({ 'pytest.ini': '[pytest]\n', 'tests/test_f.py': source });
        try {
            return rowsOf(idx(dir), 'tests/test_f.py');
        } finally {
            rm(dir);
        }
    };
    const shape = found => found.units.filter(unit => unit.kind === 'test')
        .map(unit => `${unit.label}:${unit.skipped ? 'skipped' : unit.conditional ? 'sometimes' : 'runs'}`);

    for (const [form, source, expected] of [
        ['a switch inside a string or a comment is text',
            'DOC = """\n__test__ = False\npytestmark = pytest.mark.skip\n"""\n# __test__ = False\n\ndef test_a():\n    pass\n', ['test_a:runs']],
        ['a module switched off and on again',
            '__test__ = False\n__test__ = True\n\ndef test_a():\n    pass\n', ['test_a:runs']],
        ['a module switched on and off again',
            '__test__ = True\n__test__ = False\n\ndef test_a():\n    pass\n', []],
        ['a class switched off and on again',
            'class TestC:\n    __test__ = False\n    __test__ = True\n\n    def test_a(self):\n        pass\n', ['TestC > test_a:runs']],
        ['a function switched off and on again',
            'def test_a():\n    pass\n\ntest_a.__test__ = False\ntest_a.__test__ = True\n', ['test_a:runs']],
        ['a switch in a branch settles nothing',
            'import os\nif os.environ.get("X"):\n    __test__ = False\n\ndef test_a():\n    pass\n', ['test_a:sometimes']],
        ['a module mark that is not a skip',
            'import pytest\npytestmark = pytest.mark.filterwarnings("ignore:skip")\n\ndef test_a():\n    pass\n', ['test_a:runs']],
        ['a class mark that is not a skip',
            'import pytest\nclass TestC:\n    pytestmark = [pytest.mark.filterwarnings("ignore:skip")]\n\n    def test_a(self):\n        pass\n', ['TestC > test_a:runs']],
        ['a skip among the module marks',
            'import pytest\npytestmark = [pytest.mark.filterwarnings("ignore"), pytest.mark.skip(reason="x")]\n\ndef test_a():\n    pass\n', ['test_a:skipped']],
        ['a module mark that is not written out',
            'import pytest\nfrom marks import ALL\npytestmark = ALL\n\ndef test_a():\n    pass\n', ['test_a:sometimes']],
        ['a decorator of the file that is only called skip',
            'def skip(function):\n    return function\n\n@skip\ndef test_a():\n    pass\n', ['test_a:sometimes']],
        ['unittest.skip under another name',
            'from unittest import skip as leave_out\n\n@leave_out("x")\ndef test_a():\n    pass\n', ['test_a:skipped']],
        ['pytest.mark under another name',
            'from pytest import mark as m\n\n@m.skip\ndef test_a():\n    pass\n\n@m.parametrize("skip", [1])\ndef test_b(skip):\n    pass\n', ['test_a:skipped', 'test_b:runs']],
    ]) {
        it(form, () => assert.deepStrictEqual(shape(rows(source)), expected));
    }
});

describe('test units: a JavaScript name is what it is bound to where the call stands', () => {
    const HEAD = "const { test, describe, it } = require('node:test');\n";
    const names = (source, extra = {}) => {
        const dir = projectOf({
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/b.test.js': source, ...extra,
        });
        try {
            return rowsOf(idx(dir), 'test/b.test.js').units.filter(unit => unit.kind === 'test').map(unit => unit.label);
        } finally {
            rm(dir);
        }
    };

    it('a function imported from a project module that is not the runner declares nothing', () => {
        assert.deepStrictEqual(names("const { test } = require('node:test');\nconst { it } = require('../helper');\nit('not a test', () => {});\ntest('real', () => {});\n",
            { 'helper.js': 'function it(name, callback) { return name; }\nmodule.exports = { it };\n' }), ['real']);
    });

    it('the runner taken through a project module is the runner, under the names the module gives', () => {
        assert.deepStrictEqual(names("const { spec, group } = require('../harness');\ngroup('g', () => {\n    spec('through', () => {});\n});\n",
            { 'harness.js': "const runner = require('node:test');\nmodule.exports = { spec: runner.it, group: runner.describe };\n" }),
        ['g > through']);
    });

    for (const [form, body, expected] of [
        ['a constant of the suite', "describe('s', () => {\n    const it = (name, callback) => name;\n    it('fake', () => {});\n    test('real', () => {});\n});\n", ['s > real']],
        ['a function of the suite', "describe('s', () => {\n    function it(name, callback) { return name; }\n    it('fake', () => {});\n    test('real', () => {});\n});\n", ['s > real']],
        ['a parameter', "function register(test) {\n    test('fake', () => {});\n}\nregister(name => name);\ntest('real', () => {});\n", ['real']],
        ['a loop variable', "for (const it of [name => name]) {\n    it('fake', () => {});\n}\nit('real', () => {});\n", ['real']],
        ['a caught value', "try {\n    throw name => name;\n} catch (test) {\n    test('fake', () => {});\n}\ntest('real', () => {});\n", ['real']],
        ['a constant of a block ends with the block', "{\n    const test = name => name;\n    test('fake', () => {});\n}\ntest('real', () => {});\n", ['real']],
    ]) {
        it(`${form} shadows the runner there and nowhere else`, () => assert.deepStrictEqual(names(HEAD + body), expected));
    }

    it('a call through a name that is not read is no test, and the file stays a test file', () => {
        const dir = projectOf({
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/wrapped.js': "const { it: real } = require('node:test');\nconst it = wrap(real);\nit('through a wrapper', () => {});\nfunction wrap(f) { return f; }\n",
            'test/values.js': "const runner = require('node:test');\nmodule.exports = { it: runner.it };\n",
        });
        try {
            const index = idx(dir);
            const wrapped = rowsOf(index, 'test/wrapped.js');
            assert.deepStrictEqual(wrapped.units, []);
            assert.strictEqual(wrapped.facts.role, 'tests');
            assert.strictEqual(selectorText(wrapped.facts.run), 'node --test test/wrapped.js');
            assert.strictEqual(rowsOf(index, 'test/values.js').facts.role, 'support',
                'a file that only hands the runner on declares and calls nothing');
        } finally {
            rm(dir);
        }
    });
});

describe('test units: what a focus leaves out is each runner\'s own rule', () => {
    const SOURCE = [
        "describe.only('outer', () => {",
        "    it.only('one', () => {});",
        "    it('two', () => {});",
        "    describe('inner', () => {",
        "        it('three', () => {});",
        '    });',
        '});',
        "describe('plain', () => {",
        "    it.only('direct', () => {});",
        "    describe.only('nested focus', () => {",
        "        it('in nested focus', () => {});",
        '    });',
        "    describe('nested plain', () => {",
        "        it('in nested plain', () => {});",
        '    });',
        '});',
        "it('outside', () => {});",
        '',
    ].join('\n');
    const running = (script, head = '') => {
        const dir = projectOf({
            'package.json': `{ "name": "x", "scripts": { "test": "${script}" } }\n`,
            'src/n.test.js': head + SOURCE,
        });
        try {
            return rowsOf(idx(dir), 'src/n.test.js').units.filter(unit => unit.kind === 'test' && !unit.skipped)
                .map(unit => unit.name);
        } finally {
            rm(dir);
        }
    };

    it('jest: a marked suite passes its mark down, except to the siblings of a marked test', () => {
        assert.deepStrictEqual(running('jest'), ['one', 'three', 'direct', 'in nested focus']);
    });
    it('mocha: a suite with marked tests of its own runs those and nothing else of it', () => {
        assert.deepStrictEqual(running('mocha'), ['one', 'direct']);
    });
    it('vitest: everything inside a marked suite runs', () => {
        assert.deepStrictEqual(running('vitest run'), ['one', 'two', 'three', 'direct', 'in nested focus']);
    });
    it('node: the mark does nothing without its flag', () => {
        assert.deepStrictEqual(running('node --test', "const { describe, it } = require('node:test');\n"),
            ['one', 'two', 'three', 'direct', 'in nested focus', 'in nested plain', 'outside']);
    });
    it('a marked suite that holds no test leaves nothing out under jest', () => {
        const units = [
            { kind: 'suite', only: true, parent: -1 },
            { kind: 'test', parent: -1 },
        ];
        assert.strictEqual(focusedOut(units, 'jest').size, 0);
        assert.strictEqual(focusedOut(units, 'vitest').size, 1);
    });
});

describe('test units: marks and proofs are read where they are written', () => {
    it('a Go example runs when a comment of its body is an output comment, not when a string says so', () => {
        const dir = projectOf({
            'go.mod': 'module example.com/m\n\ngo 1.21\n',
            'util.go': 'package m\n\nfunc Add() {}\nfunc Sub() {}\nfunc Div() {}\n',
            'ex_test.go': 'package m\n\nimport "fmt"\n\nfunc ExampleAdd() {\n\tfmt.Println("hi")\n\t// Output: hi\n}\n\nfunc ExampleSub() {\n\t_ = `\n// Output: text in a string\n`\n}\n\nfunc ExampleDiv() {\n\tfmt.Println("hi")\n\t/* Output:\n\thi\n\t*/\n}\n',
        });
        try {
            assert.deepStrictEqual(rowsOf(idx(dir), 'ex_test.go').units.map(unit => unit.label), ['ExampleAdd', 'ExampleDiv']);
        } finally {
            rm(dir);
        }
    });

    it('a Go file named like a test file that declares no test is support', () => {
        const dir = projectOf({
            'go.mod': 'module example.com/m\n\ngo 1.21\n',
            'helpers_test.go': 'package m\n\nfunc build() int { return 1 }\n',
        });
        try {
            assert.strictEqual(rowsOf(idx(dir), 'helpers_test.go').facts.role, 'support');
        } finally {
            rm(dir);
        }
    });

    it('xUnit Skip is an argument of the attribute, not a word in one of its strings', () => {
        const dir = projectOf({
            'T.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit" Version="2.9.3" /></ItemGroup></Project>\n',
            'T.cs': 'using Xunit;\nnamespace N {\n    public class T {\n        [Fact(DisplayName = "when asked to, Skip = no")]\n        public void Runs() {}\n        [Fact(Skip = "not now")]\n        public void Off() {}\n    }\n}\n',
        });
        try {
            assert.deepStrictEqual(rowsOf(idx(dir), 'T.cs').units.filter(unit => unit.kind === 'test')
                .map(unit => `${unit.name}:${!!unit.skipped}`), ['Runs:false', 'Off:true']);
        } finally {
            rm(dir);
        }
    });

    it('a requirement names a package; a comment or another package\'s name does not', () => {
        assert.strictEqual(namesRequirement('requests>=2\npytest>=7\n', 'pytest'), true);
        assert.strictEqual(namesRequirement('dev = ["pytest", "ruff"]\n', 'pytest'), true);
        assert.strictEqual(namesRequirement('pytest = "^8"\n', 'pytest'), true);
        assert.strictEqual(namesRequirement('# we do not use pytest\nnose\n', 'pytest'), false);
        assert.strictEqual(namesRequirement('pytest-cov>=2\n', 'pytest'), false);
        assert.strictEqual(namesRequirement('mypytest\n', 'pytest'), false);
    });
});
