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
    shellSplit, configArguments, pytestOptions, markSelects, nodeRunsFile,
} = require('../core/test-units');
const { CASES } = require('../eval/test-unit-matrix-cases');
const { answerOf, judgeWholeRun, judgeJoined, namedIdentities } = require('../eval/run-test-unit-matrix');
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
        'package.json': '{ "name": "x", "scripts": { "test": "node --test test/a.test.js" } }\n',
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
            'package.json': '{ "name": "x", "scripts": { "test": "node --test test/a.test.js" } }\n',
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
            'package.json': MANIFEST.replace('node --test', 'node --test test/computed.js'),
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
            // One declaration that exists once for every call of its
            // function: a lower bound, and a test that runs only sometimes.
            assert.match(text, /src\/indirect\.test\.js \(links: [^)]*\) · at least 1 test \(1 conditional\) · no command: declared-indirectly/);
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
            ['UNDECLARED', 'INEXACT-COUNT']);
        const support = { units: [], files: [{ file: 'helper.js', role: 'support', run: null, tests: 0 }] };
        assert.deepStrictEqual(kinds({}, support, ['helper.js:2']), ['FALSE-SUPPORT', 'UNDECLARED']);
    });

    it('a count is exact only where the runner executes nothing more from the file', () => {
        const lower = [{ file: 'a.test.js', role: 'tests', run: 'run a.test.js', tests: 1, more: true }];
        const ran = ['a.test.js:3', 'a.test.js:9'];
        // Naming the test the engine does not list does not excuse the count.
        assert.deepStrictEqual(kinds({ undeclared: ['a.test.js:9'] }, { units: [unit(3)], files: files(1) }, ran), ['INEXACT-COUNT']);
        // A lower bound is the weaker claim, and has to be deliberate.
        assert.deepStrictEqual(kinds({ undeclared: ['a.test.js:9'] }, { units: [unit(3)], files: lower }, ran), ['LOWER-BOUND']);
        assert.deepStrictEqual(kinds({ undeclared: ['a.test.js:9'], atLeast: ['a.test.js'] }, { units: [unit(3)], files: lower }, ran), []);
        assert.deepStrictEqual(kinds({ atLeast: ['a.test.js'] }, { units: [unit(3)], files: files(1) }, ['a.test.js:3']), ['LOWER-BOUND']);
        // What the commands print (every line of the file linked) is the file's own answer.
        const printed = linked => [{ file: 'a.test.js', role: 'tests', run: 'run a.test.js', tests: 1, more: false, linked }];
        assert.deepStrictEqual(kinds({}, { units: [unit(3)], files: printed({ tests: 1, more: false }) }, ['a.test.js:3']), []);
        assert.deepStrictEqual(kinds({}, { units: [unit(3)], files: printed({ tests: 2, more: false }) }, ['a.test.js:3']), ['COUNT']);
        assert.deepStrictEqual(kinds({}, { units: [unit(3)], files: printed({ tests: 1, more: true }) }, ['a.test.js:3']), ['COUNT']);
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
            'package.json': '{ "name": "x", "scripts": { "test": "node --test test/wrapped.js" } }\n',
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

// ---------------------------------------------------------------------------
// What is passed, written, imported and configured
// ---------------------------------------------------------------------------

/** The answer for one file of a project written out for the question. */
function answerFor(files, relativePath) {
    const dir = projectOf(files);
    try {
        const found = rowsOf(idx(dir), relativePath);
        return { facts: found.facts, units: found.units.filter(unit => unit.kind === 'test') };
    } finally {
        rm(dir);
    }
}
const labelsOf = (units, keep = () => true) => units.filter(keep).map(unit => unit.label);
const NODE = { 'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n' };
const NODE_HEAD = "const { test } = require('node:test');\n";

describe('test units: the body of a test is whatever is passed for it', () => {
    const units = source => answerFor({ ...NODE, 'test/b.test.js': NODE_HEAD + source }, 'test/b.test.js');

    it('a named function, with or without options before it, is a body', () => {
        const { facts, units: found } = units("function body() {}\ntest('named', body);\ntest('with options', { timeout: 1000 }, body);\n");
        assert.strictEqual(facts.tests, 2);
        assert.deepStrictEqual(found.map(unit => [unit.label, !!unit.skipped, !!unit.conditional]),
            [['named', false, false], ['with options', false, false]]);
    });

    it('a member, the result of a call and a spread are taken to be one', () => {
        const { units: found } = units("const bodies = { one() {} };\nconst wrap = fn => fn;\ntest('member', bodies.one);\ntest('wrapped', wrap(() => {}));\ntest(...['spread', () => {}]);\n");
        assert.deepStrictEqual(found.map(unit => !!unit.skipped), [false, false, false]);
    });

    it('a test given nothing that can be a body has nothing to execute', () => {
        const { facts, units: found } = units("const options = { timeout: 1 };\nconst nothing = undefined;\ntest('options only', options);\ntest('undefined', nothing);\ntest('none');\n");
        assert.strictEqual(facts.tests, 0);
        assert.deepStrictEqual(found.map(unit => !!unit.skipped), [true, true, true]);
    });

    it('a title that is a name is the title, not an option', () => {
        const { units: found } = units("const title = 'computed';\ntest(title, () => {});\n");
        assert.deepStrictEqual(found.map(unit => [!!unit.skipped, !!unit.conditional]), [[false, false]]);
    });

    it('a skip option is its value: a falsy literal does not skip, one that is not written out may', () => {
        const state = source => {
            const [unit] = units(source).units;
            return unit.skipped ? 'skipped' : unit.conditional ? 'conditional' : 'runs';
        };
        for (const [options, expected] of [
            ["{ skip: '' }", 'runs'], ['{ skip: 0 }', 'runs'], ['{ skip: null }', 'runs'], ['{ skip: undefined }', 'runs'],
            ['{ skip: false }', 'runs'], ["{ skip: 'not today' }", 'skipped'], ['{ skip: 1 }', 'skipped'],
            ["{ ['skip']: true }", 'skipped'], ['{ skip }', 'conditional'], ['{ ...opts }', 'conditional'],
            ['opts', 'conditional'], ['{ skip: flag() }', 'conditional'],
        ]) {
            assert.strictEqual(state(`const skip = true;\nconst opts = { skip: true };\nconst flag = () => true;\ntest('t', ${options}, () => {});\n`), expected, options);
        }
    });
});

describe('test units: a name written more than once is read only where every write agrees', () => {
    const FAKE = 'const fake = (name, fn) => name;\n';
    const names = (source, file = 'test/b.test.js', manifest = NODE) =>
        labelsOf(answerFor({ ...manifest, [file]: source }, file).units);

    it('an alias assigned something else afterwards declares nothing', () => {
        assert.deepStrictEqual(names(`${NODE_HEAD}${FAKE}let caseFn = test;\ncaseFn = fake;\ncaseFn('not a test', () => {});\ntest('real', () => {});\n`), ['real']);
    });

    it('a var in a block and a function declared later belong to the whole function', () => {
        assert.deepStrictEqual(names(`${NODE_HEAD}${FAKE}if (true) { var it = fake; }\nit('not a test', () => {});\nspecify('not a test either', () => {});\nfunction specify(name, fn) { return name; }\ntest('real', () => {});\n`), ['real']);
    });

    it('a write inside a function, a destructuring assignment and a write to the global count', () => {
        assert.deepStrictEqual(names(`${NODE_HEAD}${FAKE}let swapped = test;\nfunction swap() { swapped = fake; }\nswap();\nswapped('a', () => {});\nlet picked = test;\n({ picked } = { picked: fake });\npicked('b', () => {});\nglobalThis.fit = fake;\nfit('c', () => {});\ntest('real', () => {});\n`), ['real']);
    });

    it('a function declared in a block may be the name outside it', () => {
        assert.deepStrictEqual(names(`${NODE_HEAD}${FAKE}{ function specify(name, fn) { return name; } }\nspecify('not a test', () => {});\ntest('real', () => {});\n`), ['real']);
    });

    it('inside with, and after eval in the same function, a name is not read', () => {
        assert.deepStrictEqual(names(`${NODE_HEAD}${FAKE}with ({ test: fake }) {\n    test('inside with', () => {});\n}\nfunction scoped() {\n    eval('var test = fake');\n    test('after eval', () => {});\n}\nscoped();\ntest('real', () => {});\n`), ['real']);
    });

    it('a name declared bare and assigned once holds that value', () => {
        assert.deepStrictEqual(names("let declare;\ndeclare = require('node:test').test;\ndeclare('assigned once', () => {});\n"), ['assigned once']);
    });

    it('a declaration for the type checker binds nothing at run time', () => {
        assert.deepStrictEqual(names("declare const it: (name: string, fn: () => void) => void;\nit('global', () => {});\n", 'test/b.test.ts',
            { 'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n' }), ['global']);
    });

    it('a call given the global object leaves the runner\'s globals, unless it defines or assigns them', () => {
        const JEST = { 'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n' };
        const under = source => labelsOf(answerFor({ ...JEST, 'test/a.test.js': source }, 'test/a.test.js').units);
        assert.deepStrictEqual(under("jest.spyOn(global, 'fetch');\nsinon.stub(window, 'open');\nrender(globalThis);\ntest('kept', () => {});\n"), ['kept']);
        assert.deepStrictEqual(under("Object.defineProperty(globalThis, 'matchMedia', { value: () => {} });\ntest('kept', () => {});\n"), ['kept']);
        assert.deepStrictEqual(under("Object.defineProperty(globalThis, 'test', { value: () => {} });\ntest('not read', () => {});\n"), []);
        assert.deepStrictEqual(under("Object.assign(global, { test: () => {} });\ntest('not read', () => {});\nit('kept', () => {});\n"), ['kept']);
        assert.deepStrictEqual(under("Object.assign(global, require('./helpers'));\ntest('not read', () => {});\n"), []);
    });

    it('a name that is assigned from itself is not unread for that', () => {
        const { facts } = answerFor({
            'package.json': '{ "name": "x", "scripts": { "test": "mocha test/a.test.js" } }\n',
            'test/a.test.js': "it('a', () => {});\n",
            'test/support/render.js': 'module.exports = function render(str, done) {\n    str = str.replace(/a/g, "b");\n    done(null, str.trim());\n};\n',
        }, 'test/support/render.js');
        assert.strictEqual(facts.role, 'support');
    });

    it('a helper that calls through its loop variables is not a test file', () => {
        const { facts } = answerFor({
            'package.json': '{ "name": "x", "scripts": { "test": "node --test test/a.test.js" } }\n',
            'test/a.test.js': `${NODE_HEAD}test('a', () => {});\n`,
            'test/helpers/kill.js': 'function stop(children) {\n    for (const child of children) child.kill();\n    let n = 0;\n    n++;\n}\nmodule.exports = { stop };\n',
        }, 'test/helpers/kill.js');
        assert.strictEqual(facts.role, 'support');
    });
});

describe('test units: what pytest collects is what the names hold when the module has run', () => {
    const PYTEST = { 'pytest.ini': '[pytest]\n', 'tests/__init__.py': '' };
    const units = (source, more = {}) => answerFor({ ...PYTEST, 'tests/test_x.py': source, ...more }, 'tests/test_x.py');
    const stateOf = unit => unit.skipped ? 'skipped' : unit.conditional ? 'conditional' : 'runs';

    it('a switch written again with a value that is not a literal no longer says off', () => {
        for (const source of [
            '__test__ = False\n__test__ = bool(1)\n\ndef test_actual():\n    pass\n',
            '__test__ = False\nif True:\n    __test__ = True\n\ndef test_actual():\n    pass\n',
            'class TestActual:\n    __test__ = False\n    __test__ = bool(1)\n    def test_actual(self):\n        pass\n',
            'def test_actual():\n    pass\n\ntest_actual.__test__ = False\ntest_actual.__test__ = bool(1)\n',
        ]) {
            const { facts, units: found } = units(source);
            assert.deepStrictEqual(found.map(unit => [unit.name, stateOf(unit), unit.selectorWithheld]),
                [['test_actual', 'conditional', 'collection-switch']], source);
            assert.notStrictEqual(facts.runWithheld, 'collection-switched-off', source);
        }
    });

    it('the last literal write decides, for the module, a class and a function', () => {
        assert.deepStrictEqual(units('__test__ = True\n__test__ = False\n\ndef test_off():\n    pass\n').facts.runWithheld, 'collection-switched-off');
        assert.deepStrictEqual(units('class TestBackOn:\n    __test__ = False\n    __test__ = True\n    def test_on(self):\n        pass\n\ndef test_f():\n    pass\n\ntest_f.__test__ = False\ntest_f.__test__ = True\n')
            .units.map(unit => [unit.label, stateOf(unit)]), [['TestBackOn > test_on', 'runs'], ['test_f', 'runs']]);
    });

    it('pytestmark is its last write: replaced, in a branch, added to', () => {
        const mark = body => stateOf(units(`import pytest\n${body}\ndef test_a():\n    pass\n`).units[0]);
        assert.strictEqual(mark('pytestmark = pytest.mark.skip\npytestmark = []\n'), 'runs');
        assert.strictEqual(mark('pytestmark = []\npytestmark = pytest.mark.skip\n'), 'skipped');
        assert.strictEqual(mark('if True:\n    pytestmark = pytest.mark.skip\n'), 'conditional');
        assert.strictEqual(mark('pytestmark = []\npytestmark += [pytest.mark.skip]\n'), 'conditional');
    });

    it('a definition overwritten or deleted is gone; one in a branch exists only sometimes', () => {
        const { units: found } = units('import sys\n\ndef test_gone():\n    pass\n\ntest_gone = None\n\ndef test_deleted():\n    pass\n\ndel test_deleted\n\ndef test_kept():\n    pass\n\nif sys.platform == "nope":\n    def test_never():\n        pass\nelse:\n    def test_else():\n        pass\n\nclass TestBody:\n    def test_none(self):\n        pass\n    test_none = None\n    if True:\n        def test_in_branch(self):\n            pass\n');
        assert.deepStrictEqual(found.map(unit => [unit.label, stateOf(unit), unit.selectorWithheld || null]), [
            ['test_kept', 'runs', null],
            ['test_never', 'conditional', 'defined-conditionally'],
            ['test_else', 'conditional', 'defined-conditionally'],
            ['TestBody > test_in_branch', 'conditional', 'defined-conditionally'],
        ]);
    });

    it('a class or function taken by an import is collected where it is imported, under the name it gets', () => {
        const base = 'import unittest\n\nclass TestBase:\n    def test_shared(self):\n        pass\n\nclass CaseBase(unittest.TestCase):\n    def test_case_shared(self):\n        pass\n\nclass Plain:\n    def test_plain(self):\n        pass\n\ndef test_function_elsewhere():\n    pass\n';
        const { units: found } = units('from tests.base import TestBase, CaseBase\nfrom tests.base import test_function_elsewhere\nfrom tests.base import TestBase as Renamed\nfrom tests.base import Plain as TestPlain\n\nclass ChildCase(CaseBase):\n    pass\n',
            { 'tests/base.py': base });
        assert.deepStrictEqual(found.map(unit => [unit.label, unit.inheritedFrom, unit.selector && unit.selector.command]), [
            ['CaseBase > test_case_shared', 'tests/base.py:8', 'pytest tests/test_x.py::CaseBase::test_case_shared'],
            ['TestBase > test_shared', 'tests/base.py:4', 'pytest tests/test_x.py::TestBase::test_shared'],
            ['test_function_elsewhere', 'tests/base.py:15', 'pytest tests/test_x.py::test_function_elsewhere'],
            ['TestPlain > test_plain', 'tests/base.py:12', 'pytest tests/test_x.py::TestPlain::test_plain'],
            ['ChildCase > test_case_shared', 'tests/base.py:8', 'pytest tests/test_x.py::ChildCase::test_case_shared'],
        ]);
    });

    it('a module whose name pytest does not look for declares no test, and still lends its classes', () => {
        const files = {
            ...PYTEST, 'tests/base.py': 'class TestBase:\n    def test_shared(self):\n        pass\n',
            'tests/test_x.py': 'from tests.base import TestBase\n',
        };
        assert.deepStrictEqual([answerFor(files, 'tests/base.py').facts.role, answerFor(files, 'tests/base.py').units.length], ['support', 0]);
        assert.strictEqual(answerFor(files, 'tests/test_x.py').facts.tests, 1);
    });

    it('a line of a body that runs elsewhere reaches the tests that run it', () => {
        const dir = projectOf({
            ...PYTEST, 'tests/base.py': 'class TestBase:\n    def test_shared(self):\n        pass\n\ndef test_fn():\n    pass\n',
            'tests/test_x.py': 'from tests.base import TestBase, test_fn\n',
        });
        try {
            const index = idx(dir);
            index._beginOp();
            const model = createTestModel(index);
            const runs = line => model.runsAt(path.join(dir, 'tests/base.py'), line)
                .map(run => `${path.relative(dir, run.filePath)}::${unitLabel(run.unit)}`);
            assert.deepStrictEqual(runs(3), ['tests/test_x.py::TestBase > test_shared']);
            assert.deepStrictEqual(runs(6), ['tests/test_x.py::test_fn']);
            index._endOp();
        } finally {
            rm(dir);
        }
    });
});

describe('test units: pytest options the project configures are applied or the command is withheld', () => {
    const project = (addopts, source, more = {}) => ({
        'pytest.ini': `[pytest]\naddopts = ${addopts}\n`, 'tests/__init__.py': '', 'tests/test_x.py': source, ...more,
    });
    const MARKED = 'import pytest\nfrom tests.deco import passthrough\n\nslow = pytest.mark.slow\n\n@pytest.mark.slow\ndef test_marked():\n    pass\n\n@slow\ndef test_through_a_name():\n    pass\n\n@pytest.mark.slow\nclass TestMarked:\n    def test_inside(self):\n        pass\n\nclass TestBodyMark:\n    pytestmark = pytest.mark.slow\n    def test_under(self):\n        pass\n\nclass TestDerived(TestBodyMark):\n    def test_own(self):\n        pass\n\n@passthrough\ndef test_decorated_elsewhere():\n    pass\n\ndef test_plain():\n    pass\n';

    it('a mark expression leaves out the tests that carry the mark, however it reaches them', () => {
        const { facts, units } = answerFor(project('-ra -m "not slow" --strict-markers', MARKED, { 'tests/deco.py': 'def passthrough(f):\n    return f\n' }), 'tests/test_x.py');
        assert.deepStrictEqual(units.map(unit => [unit.label, unit.skipped ? unit.selectorWithheld : unit.conditional ? 'conditional' : 'runs']), [
            ['test_marked', 'deselected-by-options'], ['test_through_a_name', 'deselected-by-options'],
            ['TestMarked > test_inside', 'deselected-by-options'], ['TestBodyMark > test_under', 'deselected-by-options'],
            ['TestDerived > test_under', 'deselected-by-options'], ['TestDerived > test_own', 'deselected-by-options'],
            ['test_decorated_elsewhere', 'conditional'], ['test_plain', 'runs'],
        ]);
        assert.strictEqual(facts.tests, 2);
    });

    it('a file whose tests are all left out has no command; a test left out by its id is not counted', () => {
        assert.strictEqual(answerFor(project('-m "not slow"', 'import pytest\npytestmark = [pytest.mark.slow]\n\ndef test_a():\n    pass\n'), 'tests/test_x.py').facts.runWithheld, 'deselected-by-options');
        const { facts, units } = answerFor(project('--deselect tests/test_x.py::test_a', 'def test_a():\n    pass\n\ndef test_b():\n    pass\n'), 'tests/test_x.py');
        assert.deepStrictEqual([facts.tests, units[0].selectorWithheld, units[1].selector.command], [1, 'deselected-by-options', 'pytest tests/test_x.py::test_b']);
    });

    it('an option that may select and is not modeled withholds every command', () => {
        for (const addopts of ['-k "not thing"', 'tests/other', '-p my_plugin', '-o python_functions=check_*', '-p no:skipping']) {
            const { facts, units } = answerFor(project(addopts, 'def test_a():\n    pass\n'), 'tests/test_x.py');
            assert.deepStrictEqual([facts.runWithheld, units[0].selectorWithheld], ['runner-options-not-read', 'runner-options-not-read'], addopts);
        }
    });

    it('options that select nothing leave the commands', () => {
        for (const addopts of ['-ra --showlocals --strict-config --capture=sys -p no:logging -p no:tmpdir', '--tb short -W error --cov=src --cov-report term', '--ignore=tests/legacy --import-mode=importlib -n auto']) {
            const { facts } = answerFor(project(addopts, 'def test_a():\n    pass\n'), 'tests/test_x.py');
            assert.strictEqual(facts.run && facts.run.command, 'pytest tests/test_x.py', addopts);
        }
    });

    it('the pure readers: words, options, mark expressions', () => {
        assert.deepStrictEqual(shellSplit(`-m 'not slow' --tb=short "a b"\\ c`), ['-m', 'not slow', '--tb=short', 'a b c']);
        assert.deepStrictEqual(configArguments({ file: 'pyproject.toml', table: 'addopts = [\n    "-m",\n    "not property",   # opt-in "only"\n    "-p", "no:logging",\n]\n' }, 'addopts'),
            ['-m', 'not property', '-p', 'no:logging']);
        assert.deepStrictEqual(configArguments({ file: 'pytest.ini', table: 'addopts = -ra\n    -m "not slow"\n' }, 'addopts'), ['-ra', '-m', 'not slow']);
        assert.deepStrictEqual(pytestOptions(['-ra', '-m', 'not slow', '--deselect=a::b']), { markExpr: 'not slow', deselect: ['a::b'], unread: false });
        assert.strictEqual(pytestOptions(null).unread, true);
        const selects = (expression, marks, open = false) => markSelects(expression, new Set(marks), open);
        assert.deepStrictEqual([selects('not slow', ['slow']), selects('not slow', []), selects('not slow', [], true)], [false, true, null]);
        assert.deepStrictEqual([selects('slow or (fast and not net)', ['fast']), selects('slow and fast', ['slow'], true), selects('slow and fast', ['slow'])], [true, null, false]);
        assert.strictEqual(selects('slow(reason="x")', ['slow']), null);
    });
});

describe('test units: a decorator, an attribute and an annotation are read by what they are', () => {
    const stateOf = unit => unit.skipped ? 'skipped' : unit.conditional ? 'conditional' : 'runs';

    it('Python: marks by import, patches of the standard library, anything else may do anything', () => {
        const { units } = answerFor({
            'pytest.ini': '[pytest]\n', 'tests/__init__.py': '',
            'tests/deco.py': 'import pytest\nrequires_db = pytest.mark.skip(reason="no db")\n',
            'tests/test_x.py': 'import pytest\nfrom unittest import mock\nfrom tests.deco import requires_db\n\nlater = pytest.mark.skip(reason="later")\n\n@requires_db\ndef test_needs_db():\n    pass\n\n@pytest.mark.xfail(run=False)\ndef test_never_started():\n    pass\n\n@pytest.mark.xfail\ndef test_expected_to_fail():\n    pass\n\n@mock.patch("os.getcwd")\ndef test_patched(cwd):\n    pass\n\n@later\ndef test_marked_by_a_name_of_the_file():\n    pass\n\n@pytest.mark.usefixtures("tmp_path")\ndef test_with_fixture():\n    pass\n',
        }, 'tests/test_x.py');
        assert.deepStrictEqual(units.map(stateOf), ['conditional', 'skipped', 'runs', 'runs', 'skipped', 'runs']);
    });

    it('Python: a module that skips itself at its top runs only sometimes', () => {
        for (const head of ['missing = pytest.importorskip("not_installed")', 'pytest.skip("no", allow_module_level=True)']) {
            const { units } = answerFor({ 'pytest.ini': '[pytest]\n', 'tests/test_x.py': `import pytest\n${head}\n\ndef test_a():\n    pass\n` }, 'tests/test_x.py');
            assert.deepStrictEqual(units.map(stateOf), ['conditional'], head);
        }
    });

    it('Python: a TestCase reached through a class of the project is a TestCase', () => {
        const { units } = answerFor({
            'pytest.ini': '[pytest]\n', 'tests/__init__.py': '',
            'tests/base.py': 'import unittest\n\nclass Base(unittest.TestCase):\n    pass\n',
            'tests/test_x.py': 'from tests.base import Base\n\nclass Checks(Base):\n    def test_a(self):\n        pass\n',
        }, 'tests/test_x.py');
        assert.deepStrictEqual(labelsOf(units), ['Checks > test_a']);
    });

    it('C#: Skip is a value, read where the file holds it', () => {
        const method = (attribute, name) => `        ${attribute}\n        public void ${name}() { }\n`;
        const rows = [
            ['[Fact(Skip = null)]', 'runs'], ['[Fact(Skip = (string)null)]', 'runs'], ['[Fact(Skip = default)]', 'runs'],
            ['[Fact(Skip = Reasons.None)]', 'runs'], ['[Fact(Skip = "")]', 'runs'], ['[Fact(Skip = "why")]', 'skipped'],
            ['[Fact(Skip = Local)]', 'skipped'], ['[Fact(Skip = Reasons.Later)]', 'skipped'], ['[Fact(Skip = nameof(Reasons))]', 'skipped'],
            ['[Fact(Skip = "a" + "b")]', 'skipped'], ['[Fact(Skip = Elsewhere.Why)]', 'conditional'],
            ['[Fact(DisplayName = "Skip = no")]', 'runs'], ['[RetryFact]', 'conditional'],
        ];
        const { units } = answerFor({
            'App.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit" Version="2.9.3" /></ItemGroup></Project>\n',
            'T.cs': `using Xunit;\nnamespace N\n{\n    public static class Reasons { public const string Later = "later"; public const string None = null; }\n    public class RetryFactAttribute : FactAttribute { }\n    public class T\n    {\n        const string Local = "x";\n${rows.map(([attribute], i) => method(attribute, `M${i}`)).join('')}    }\n}\n`,
        }, 'T.cs');
        assert.deepStrictEqual(units.map(stateOf), rows.map(([, expected]) => expected));
    });

    it('C#: [Ignore] skips, with Until for a time; an attribute that is not a framework\'s own may do anything', () => {
        const { units } = answerFor({
            'App.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="NUnit" Version="4.0.0" /></ItemGroup></Project>\n',
            'T.cs': 'using NUnit.Framework;\nnamespace N\n{\n    public class T\n    {\n        [Test, Ignore("why")]\n        public void Ignored() { }\n        [Test]\n        [Ignore("why", Until = "2099-01-01")]\n        public void IgnoredForNow() { }\n        [Test, Category("fast")]\n        public void Plain() { }\n        [Test, Platform("Win")]\n        public void OnAPlatform() { }\n    }\n}\n',
        }, 'T.cs');
        assert.deepStrictEqual(units.map(stateOf), ['skipped', 'conditional', 'runs', 'conditional']);
    });

    it('Rust: an attribute macro beside #[test] may rewrite the function; the language\'s own attributes do not', () => {
        const { units } = answerFor({
            'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n',
            'src/lib.rs': '#[cfg(test)]\nmod tests {\n    #[test]\n    #[should_panic]\n    #[allow(unused)]\n    fn plain() {}\n\n    #[test]\n    #[serial]\n    fn under_a_macro() {}\n\n    #[tokio::test]\n    async fn by_a_test_macro() {}\n\n    #[test]\n    #[ignore = "slow"]\n    fn ignored() {}\n}\n',
        }, 'src/lib.rs');
        assert.deepStrictEqual(units.map(unit => [unit.name, stateOf(unit), !!unit.selector]),
            [['plain', 'runs', true], ['under_a_macro', 'conditional', true], ['by_a_test_macro', 'runs', true], ['ignored', 'skipped', true]]);
    });

    it('Go and pytest: code the runner asks at run time makes the tests beside it conditional', () => {
        const go = main => answerFor({
            'go.mod': 'module example.com/x\n\ngo 1.21\n',
            'main_test.go': `package x\n\nimport (\n\t"os"\n\t"testing"\n)\n\nfunc TestMain(m *testing.M) {\n${main}\n}\n`,
            'a_test.go': 'package x\n\nimport "testing"\n\nfunc TestA(t *testing.T) {}\n',
        }, 'a_test.go').units.map(stateOf);
        assert.deepStrictEqual(go('\tos.Exit(m.Run())'), ['runs']);
        assert.deepStrictEqual(go('\tsetup()\n\tcode := m.Run()\n\tteardown()\n\tos.Exit(code)'), ['runs']);
        assert.deepStrictEqual(go('\tif os.Getenv("CI") == "" {\n\t\tos.Exit(0)\n\t}\n\tos.Exit(m.Run())'), ['conditional']);
        assert.deepStrictEqual(go('\tleak.VerifyTestMain(m)'), ['conditional']);
        assert.deepStrictEqual(go('\tos.Exit(0)'), ['conditional']);
        const hooked = {
            'pytest.ini': '[pytest]\n', 'tests/__init__.py': '',
            'tests/conftest.py': 'def pytest_collection_modifyitems(config, items):\n    del items[:]\n',
            'tests/test_x.py': 'def test_a():\n    pass\n', 'other/test_y.py': 'def test_b():\n    pass\n',
        };
        assert.deepStrictEqual(answerFor(hooked, 'tests/test_x.py').units.map(stateOf), ['conditional']);
        // pytest calls that hook once, with every test of the run: it
        // holds for the other directory too. A hook it calls for one test
        // holds below its conftest.py only.
        assert.deepStrictEqual(answerFor(hooked, 'other/test_y.py').units.map(stateOf), ['conditional']);
        const perTest = { ...hooked, 'tests/conftest.py': 'import pytest\n\ndef pytest_runtest_setup(item):\n    pytest.skip("no")\n' };
        assert.deepStrictEqual(answerFor(perTest, 'tests/test_x.py').units.map(stateOf), ['conditional']);
        assert.deepStrictEqual(answerFor(perTest, 'other/test_y.py').units.map(stateOf), ['runs']);
        const hook = body => answerFor({ ...hooked, 'tests/conftest.py': body }, 'tests/test_x.py').units.map(stateOf)[0];
        assert.strictEqual(hook('import gc\n\ndef pytest_runtest_setup():\n    gc.collect()\n\ndef pytest_collection():\n    gc.disable()\n'), 'runs');
        assert.strictEqual(hook('import pytest\n\ndef pytest_runtest_setup(item):\n    if "slow" in item.keywords:\n        pytest.skip("slow")\n'), 'conditional');
        assert.strictEqual(hook('def pytest_ignore_collect(collection_path, config):\n    return collection_path.name.startswith("legacy")\n'), 'conditional');
        assert.strictEqual(hook('from helpers import reorder\n\ndef pytest_collection_modifyitems(config, items):\n    reorder(items)\n'), 'conditional');
        // What a hook is handed reaches it under any name; only the calls
        // that read leave the run alone.
        assert.strictEqual(hook('def pytest_collection_modifyitems(items):\n    selected = items\n    selected.clear()\n'), 'conditional');
        assert.strictEqual(hook('def pytest_collection_modifyitems(items):\n    items *= 0\n'), 'conditional');
        assert.strictEqual(hook('def pytest_configure(config):\n    config.option.markexpr = "none"\n'), 'conditional');
        assert.strictEqual(hook('def pytest_configure(config):\n    config.addinivalue_line("markers", "slow: slow")\n    if config.getoption("verbose"):\n        print("verbose")\n'), 'runs');
        assert.strictEqual(hook('def pytest_addoption(parser):\n    group = parser.getgroup("mine")\n    group.addoption("--mine", action="store_true")\n'), 'runs');
        assert.strictEqual(hook('pytest_collection_modifyitems = lambda items: items.clear()\n'), 'conditional');
        assert.strictEqual(hook('pytest_plugins = [name for name in ("a", "b")]\n'), 'conditional');
        // A fixture every test gets, and a fixture a test asks for.
        assert.strictEqual(hook('import pytest\n\n@pytest.fixture(autouse=True)\ndef guard():\n    pytest.skip("no")\n'), 'conditional');
        assert.strictEqual(hook('import pytest\n\n@pytest.fixture(autouse=True)\ndef clean(monkeypatch):\n    monkeypatch.delenv("X", raising=False)\n    yield\n'), 'runs');
        const asks = { ...hooked, 'tests/conftest.py': 'import pytest\n\n@pytest.fixture\ndef db():\n    pytest.skip("no db")\n\n@pytest.fixture\ndef client(db):\n    return 1\n',
            'tests/test_x.py': 'def test_a(client):\n    pass\n\ndef test_b():\n    pass\n' };
        assert.deepStrictEqual(answerFor(asks, 'tests/test_x.py').units.map(stateOf), ['conditional', 'runs']);
    });

    it('Java: an annotation of the project stands for the ones it carries', () => {
        const annotation = (name, carried) => `package com.x;\nimport java.lang.annotation.Retention;\nimport java.lang.annotation.RetentionPolicy;\n@Retention(RetentionPolicy.RUNTIME)\n${carried}\npublic @interface ${name} {\n}\n`;
        const { units } = answerFor({
            'pom.xml': '<project></project>\n',
            'src/test/java/com/x/Flaky.java': annotation('Flaky', '@org.junit.jupiter.api.Disabled("flaky")'),
            'src/test/java/com/x/Quick.java': annotation('Quick', '@org.junit.jupiter.api.Test'),
            'src/test/java/com/x/ATest.java': 'package com.x;\nimport org.junit.jupiter.api.Test;\nimport org.junit.jupiter.api.Tag;\nimport org.junit.jupiter.api.condition.EnabledOnOs;\nimport org.junit.jupiter.api.condition.OS;\nclass ATest {\n    @Test\n    @EnabledOnOs(OS.WINDOWS)\n    void onlyOnWindows() { }\n    @Test\n    @Flaky\n    void flaky() { }\n    @Quick\n    void composed() { }\n    @Test\n    @Tag("fast")\n    void plain() { }\n    @Test\n    @FromElsewhere\n    void unknown() { }\n}\n',
        }, 'src/test/java/com/x/ATest.java');
        assert.deepStrictEqual(units.map(unit => [unit.name, stateOf(unit)]),
            [['onlyOnWindows', 'conditional'], ['flaky', 'skipped'], ['composed', 'runs'], ['plain', 'runs'], ['unknown', 'conditional']]);
    });
});

describe('test units: a command follows the runner\'s own configuration, or is withheld', () => {
    const MOCHA = { 'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n' };
    const JEST = { 'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n' };
    const one = "it('a', () => {});\n";
    const run = (files, file) => {
        const { facts } = answerFor(files, file);
        return facts.run ? facts.run.command : facts.runWithheld;
    };

    it('mocha: a configuration that adds files, greps or ignores leaves no exact command; one that does not, does', () => {
        for (const config of ['{ "spec": ["test/**/*.js"] }', '{ "grep": "a" }', '{ "ignore": ["test/b.test.js"] }', '{ "file": ["test/setup.js"] }']) {
            assert.strictEqual(run({ ...MOCHA, '.mocharc.json': config, 'test/a.test.js': one }, 'test/a.test.js'), 'runner-config-not-read', config);
        }
        assert.strictEqual(run({ ...MOCHA, '.mocharc.yml': 'timeout: 5000\nreporter: dot\n', 'test/a.test.js': one }, 'test/a.test.js'), 'npx mocha test/a.test.js');
        assert.strictEqual(run({ ...MOCHA, '.mocharc.yml': 'spec:\n  - test/**/*.js\n', 'test/a.test.js': one }, 'test/a.test.js'), 'runner-config-not-read');
        assert.strictEqual(run({ ...MOCHA, '.mocharc.js': "module.exports = Object.assign({}, { grep: 'a' });\n", 'test/a.test.js': one }, 'test/a.test.js'), 'runner-config-not-read');
        assert.strictEqual(run({ 'package.json': '{ "name": "x", "scripts": { "test": "mocha" }, "mocha": { "spec": "test" } }\n', 'test/a.test.js': one }, 'test/a.test.js'), 'runner-config-not-read');
    });

    it('mocha: what the project\'s script loads is loaded by the command, and a typed file needs it', () => {
        const script = test => ({ 'package.json': JSON.stringify({ name: 'x', scripts: { test } }) });
        assert.strictEqual(run({ ...script('mocha --require ./support/setup.js --reporter dot --timeout 500 test/'), 'test/a.test.js': one }, 'test/a.test.js'),
            'npx mocha --require ./support/setup.js test/a.test.js');
        assert.strictEqual(run({ ...script('mocha -r ts-node/register "test/**/*.ts"'), 'test/a.test.ts': one }, 'test/a.test.ts'), 'npx mocha -r ts-node/register test/a.test.ts');
        assert.strictEqual(run({ ...script('mocha'), 'test/a.test.ts': one }, 'test/a.test.ts'), 'loader-unknown');
        assert.strictEqual(run({ ...script('mocha'), '.mocharc.json': '{ "require": ["ts-node/register"] }', 'test/a.test.ts': one }, 'test/a.test.ts'), 'npx mocha test/a.test.ts');
        assert.strictEqual(run({ ...script('mocha --config .mocharc.unit.json'), 'test/a.test.js': one }, 'test/a.test.js'), 'runner-config-not-read');
    });

    it('mocha: a focused file is run by itself, the others together', () => {
        const dir = projectOf({ ...MOCHA, 'test/a.test.js': "it.only('focused', () => {});\n", 'test/b.test.js': one, 'test/c.test.js': one });
        try {
            const index = idx(dir);
            index._beginOp();
            const model = createTestModel(index);
            assert.deepStrictEqual(commandsFor(model, ['a', 'b', 'c'].map(name => path.join(dir, `test/${name}.test.js`))),
                ['npx mocha test/b.test.js test/c.test.js', 'npx mocha test/a.test.js']);
            index._endOp();
        } finally {
            rm(dir);
        }
    });

    it('jest: a configuration that chooses files is applied where it is roots and patterns, else nothing is offered', () => {
        const t = "test('a', () => {});\n";
        assert.strictEqual(run({ ...JEST, 'jest.config.js': "module.exports = { testMatch: ['**/*.spec.js'] };\n", 'test/a.test.js': t }, 'test/a.test.js'), 'runner-config-not-read');
        assert.strictEqual(run({ ...JEST, 'jest.config.js': "const config = {\n    testEnvironment: 'node',\n    verbose: true,\n};\nmodule.exports = config;\n", 'test/a.test.js': t }, 'test/a.test.js'),
            'npx jest --runTestsByPath test/a.test.js');
        assert.strictEqual(run({ ...JEST, 'jest.config.ts': "import type { Config } from 'jest';\nexport default { testEnvironment: 'node' } satisfies Config;\n", 'test/a.test.js': t }, 'test/a.test.js'),
            'npx jest --runTestsByPath test/a.test.js');
        assert.strictEqual(run({ ...JEST, 'jest.config.js': "module.exports = { ...require('./base'), verbose: true };\n", 'test/a.test.js': t }, 'test/a.test.js'), 'runner-config-not-read');
        const keyed = { 'package.json': '{ "name": "x", "scripts": { "test": "jest" }, "jest": { "roots": ["test"], "testRegex": "test/(.*?/)?.*test.js$", "testPathIgnorePatterns": ["/skipped/"] } }\n' };
        const files = { ...keyed, 'test/a.test.js': t, 'test/sub/b.check-test.js': t, 'test/skipped/c.test.js': t, 'src/d.test.js': t };
        assert.deepStrictEqual(['test/a.test.js', 'test/sub/b.check-test.js', 'test/skipped/c.test.js', 'src/d.test.js'].map(file => run(files, file)),
            ['npx jest --runTestsByPath test/a.test.js', 'npx jest --runTestsByPath test/sub/b.check-test.js', 'outside-runner-config', 'outside-runner-config']);
        assert.strictEqual(run({ 'package.json': '{ "name": "x", "scripts": { "test": "jest --config jest.unit.config.js" } }\n', 'test/a.test.js': t }, 'test/a.test.js'), 'runner-config-not-read');
    });

    it('vitest: the directory it is told to scan is applied; a focused file is allowed to run', () => {
        const VITEST = { 'package.json': '{ "name": "x", "type": "module", "scripts": { "test": "vitest run" } }\n' };
        const t = "import { test } from 'vitest';\ntest('a', () => {});\n";
        const dirConfig = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({\n    test: { globals: true, dir: 'tests' },\n});\n";
        assert.strictEqual(run({ ...VITEST, 'vitest.config.ts': dirConfig, 'tests/a.test.js': t }, 'tests/a.test.js'), 'npx vitest run tests/a.test.js');
        assert.strictEqual(run({ ...VITEST, 'vitest.config.ts': dirConfig, 'src/a.test.js': t }, 'src/a.test.js'), 'outside-runner-config');
        assert.strictEqual(run({ ...VITEST, 'vitest.config.js': "export default { test: { include: ['**/*.spec.js'] } };\n", 'src/a.test.js': t }, 'src/a.test.js'), 'runner-config-not-read');
        assert.strictEqual(run({ ...VITEST, 'vite.config.js': "export default { plugins: [] };\n", 'src/a.test.js': t }, 'src/a.test.js'), 'npx vitest run src/a.test.js');
        assert.strictEqual(run({ ...VITEST, 'src/a.test.js': "import { test } from 'vitest';\ntest.only('a', () => {});\n" }, 'src/a.test.js'), 'npx vitest run --allowOnly src/a.test.js');
    });

    it('a configuration above the runner\'s directory is not read: nothing is offered below it', () => {
        assert.strictEqual(run({
            'jest.config.js': "module.exports = { projects: ['packages/*'] };\n", 'package.json': '{ "name": "root" }\n',
            'packages/a/package.json': '{ "name": "a", "scripts": { "test": "jest" } }\n', 'packages/a/x.test.js': "test('a', () => {});\n",
        }, 'packages/a/x.test.js'), 'runner-config-not-read');
    });

    it('node: a file the script names, or node looks for, is a test file though it declares none', () => {
        const named = { 'package.json': '{ "name": "x", "scripts": { "test": "node --test test/a.test.js test/smoke.js" } }\n', 'test/a.test.js': `${NODE_HEAD}test('a', () => {});\n`, 'test/smoke.js': 'process.exitCode = 0;\n', 'test/helpers/util.js': 'module.exports = {};\n' };
        assert.deepStrictEqual([answerFor(named, 'test/smoke.js').facts.role, run(named, 'test/smoke.js'), answerFor(named, 'test/helpers/util.js').facts.role],
            ['tests', 'node --test test/smoke.js', 'support']);
        const looked = { ...NODE, 'test/tools/setup.js': 'process.exitCode = 0;\n', 'lib/tools.js': 'module.exports = {};\n' };
        assert.strictEqual(answerFor(looked, 'test/tools/setup.js').facts.role, 'tests');
        assert.deepStrictEqual([nodeRunsFile({ script: 'node --test "test/**/*.spec.js"' }, 'test/a/b.spec.js'), nodeRunsFile({ script: 'node --test "test/**/*.spec.js"' }, 'test/a/b.test.js'),
            nodeRunsFile({ script: 'node --test' }, 'lib/x.js'), nodeRunsFile({ script: 'npm run lint && node --test' }, 'test/x.js')], [true, false, false, null]);
    });
});

describe('test units: the judge counts runs and holds joined commands to the files\' own', () => {
    const unit = (line, more = {}) => ({
        id: `a.test.js::t${line}`, file: 'a.test.js', line, startLine: line, endLine: line,
        selector: null, conditional: false, skipped: false, inherited: false, ...more,
    });
    const files = tests => [{ file: 'a.test.js', role: 'tests', run: 'run a.test.js', tests }];
    const kinds = (testCase, answer, ran, counts) => judgeWholeRun(testCase, answer, ran, counts).problems.map(problem => problem.kind);

    it('a body that runs more often than the tests listed for it is a test not listed, unless the case says so', () => {
        const answer = { units: [unit(3)], files: files(1) };
        const lower = { units: [unit(3)], files: [{ ...files(1)[0], more: true }] };
        assert.deepStrictEqual(kinds({}, answer, ['a.test.js:3'], { 'a.test.js:3': 2 }), ['INEXACT-COUNT', 'REPEATED']);
        // Named by the case, the count still has to be given as a lower bound.
        assert.deepStrictEqual(kinds({ repeats: ['a.test.js:3'] }, answer, ['a.test.js:3'], { 'a.test.js:3': 2 }), ['INEXACT-COUNT']);
        assert.deepStrictEqual(kinds({ repeats: ['a.test.js:3'], atLeast: ['a.test.js'] }, lower, ['a.test.js:3'], { 'a.test.js:3': 2 }), []);
        assert.deepStrictEqual(kinds({ repeats: ['a.test.js:3'] }, answer, ['a.test.js:3'], { 'a.test.js:3': 1 }), ['REPEATED']);
        assert.deepStrictEqual(kinds({}, { units: [unit(3, { generated: true })], files: files(1) }, ['a.test.js:3'], { 'a.test.js:3': 4 }), []);
    });

    it('joined commands must run exactly what the files\' own commands run', () => {
        assert.deepStrictEqual(judgeJoined(['a:1', 'b:1'], ['a:1', 'b:1']), []);
        assert.match(judgeJoined(['a:1', 'b:1'], ['a:1'])[0].detail, /do not run b:1/);
        assert.match(judgeJoined(['a:1'], ['a:1', 'c:1'])[0].detail, /run c:1, which no file/);
    });

    it('a case names a repeat or an undeclared test by the mark as written', () => {
        const named = namedIdentities({
            files: { 'tests/test_a.py': 'def test_p(v):\n    mark("tests/test_a.py::test_p")\n' },
            repeats: ['tests/test_a.py::test_p'], undeclared: ['tests/test_a.py:9', 'tests/x.py::T > m'],
        });
        assert.deepStrictEqual([named.repeats, named.undeclared], [['tests/test_a.py:2'], ['tests/test_a.py:9', 'tests/x.py::T > m']]);
    });
});

// ---------------------------------------------------------------------------
// A count is exact only where every test is listed
// ---------------------------------------------------------------------------

describe('test units: a count the commands print is exact, or says it is a lower bound', () => {
    const PYTEST = { 'pytest.ini': '[pytest]\n', 'tests/__init__.py': '', 'app.py': 'def target():\n    return 1\n' };
    const head = 'from app import target\n\n';
    const surfaces = files => {
        const dir = projectOf({ ...PYTEST, ...files });
        try {
            git(dir, 'init', '-q');
            git(dir, 'add', '-A');
            git(dir, 'commit', '-q', '-m', 'base');
            fs.writeFileSync(path.join(dir, 'app.py'), 'def target():\n    return 2\n');
            const index = idx(dir);
            const affected = index.affectedTests('target', { depth: 2 });
            const tests = execute(index, 'tests', { name: 'target' });
            const check = execute(idx(dir), 'check', {});
            assert.ok(tests.ok && check.ok, tests.error || check.error);
            return {
                affected, tests: tests.result, check: check.result,
                affectedText: output.formatAffectedTests(affected),
                testsText: output.formatTests(tests.result, 'target'),
                checkText: output.formatCheck(check.result),
            };
        } finally {
            rm(dir);
        }
    };

    it('another name for a test is a test of its own, counted and listed', () => {
        const found = surfaces({ 'tests/test_case.py': `${head}def test_actual():\n    target()\n\ntest_alias = test_actual\n` });
        assert.strictEqual(found.affected.summary.totalTests, 2);
        assert.strictEqual(found.affected.summary.moreTests, undefined);
        assert.match(found.affectedText, /Test files to run \(1\), 2 tests:/);
        assert.match(found.affectedText, /test_alias \(from tests\/test_case\.py:3\)\s+\[inherited-test\]/);
        assert.strictEqual(found.tests[0].tests, 2);
        assert.match(found.testsText, /tests\/test_case\.py {2}\(2 tests\)/);
        assert.strictEqual(found.check.totalTests, 2);
        assert.match(found.checkText, /Tests potentially affected: 2 in 1 file/);
    });

    it('a name bound to something that is not read leaves a lower bound on all three commands', () => {
        const found = surfaces({
            'tests/test_case.py': `${head}def make():\n    return lambda: target()\n\ndef test_actual():\n    target()\n\ntest_made = make()\n`,
        });
        assert.strictEqual(found.affected.summary.totalTests, 1);
        assert.strictEqual(found.affected.summary.moreTests, true);
        assert.strictEqual(found.affected.testFiles[0].moreTests, true);
        assert.match(found.affectedText, /Test files to run \(1\), at least 1 test:/);
        assert.match(found.affectedText, /tests\/test_case\.py \(links: [^)]*\) · at least 1 test/);
        assert.match(found.affectedText, /Summary: .*\(at least 1 test\)/);
        assert.strictEqual(found.tests[0].moreTests, true);
        assert.match(found.testsText, /tests\/test_case\.py {2}\(at least 1 test\)/);
        assert.strictEqual(found.check.moreTests, true);
        assert.strictEqual(found.check.testFiles[0].moreTests, true);
        assert.match(found.checkText, /Tests potentially affected: at least 1 in 1 file/);
        assert.match(found.checkText, /tests\/test_case\.py \(at least 1\)/);
    });

    it('a parametrized test is one declaration the runner reports as several: a lower bound', () => {
        const found = surfaces({
            'tests/test_case.py': `import pytest\n${head}@pytest.mark.parametrize("v", [1, 2])\ndef test_table(v):\n    target()\n`,
        });
        assert.strictEqual(found.affected.summary.totalTests, 1);
        assert.strictEqual(found.affected.summary.moreTests, true);
        assert.match(found.affectedText, /at least 1 test/);
        // A file with a parametrized test the link does not reach keeps an exact count.
        const apart = surfaces({
            'tests/test_case.py': `import pytest\n${head}@pytest.mark.parametrize("v", [1, 2])\ndef test_table(v):\n    pass\n\ndef test_linked():\n    target()\n`,
        });
        assert.strictEqual(apart.affected.summary.moreTests, undefined);
        assert.match(apart.affectedText, /Test files to run \(1\), 1 test:/);
    });

    it('a test that runs only sometimes is counted, and said to be conditional', () => {
        const found = surfaces({
            'tests/conftest.py': 'import pytest\n\n@pytest.fixture\ndef db():\n    pytest.skip("no db")\n',
            'tests/test_case.py': `${head}def test_needs_db(db):\n    target()\n\ndef test_plain():\n    target()\n`,
        });
        assert.strictEqual(found.affected.summary.totalTests, 2);
        assert.strictEqual(found.affected.summary.conditionalTests, 1);
        assert.match(found.affectedText, /Test files to run \(1\), 2 tests \(1 conditional\):/);
        assert.strictEqual(found.tests[0].conditionalTests, 1);
        assert.match(found.testsText, /\(2 tests \(1 conditional\)\)/);
        assert.strictEqual(found.check.conditionalTests, 1);
        assert.match(found.checkText, /Tests potentially affected: 2 in 1 file \(1 conditional\)/);
    });

    it('a JavaScript file that hands the runner\'s function on, or calls a function that declares, holds more', () => {
        const node = files => {
            const dir = projectOf({ ...NODE, ...files });
            try {
                const index = idx(dir);
                index._beginOp();
                try {
                    const model = createTestModel(index);
                    return Object.fromEntries(Object.keys(files).filter(name => /\.js$/.test(name))
                        .map(name => [name, model.fileFacts(path.join(index.root, name))]));
                } finally {
                    index._endOp();
                }
            } finally {
                rm(dir);
            }
        };
        const facts = node({
            'test/a.test.js': `${NODE_HEAD}function define(fn) { fn('via', () => {}); }\ndefine(test);\ntest('read', () => {});\n`,
            'test/b.test.js': `${NODE_HEAD}const shared = require('./shared');\nshared('b');\ntest('read', () => {});\n`,
            'test/c.test.js': `${NODE_HEAD}const path = require('node:path');\npath.join('a', 'b');\ntest('read', () => {});\n`,
            'test/d.test.js': `${NODE_HEAD}test('read', context => { context.skip(); });\n`,
            'test/shared.js': `${NODE_HEAD}module.exports = function shared(name) { test('shared ' + name, () => {}); };\n`,
        });
        assert.deepStrictEqual(Object.entries(facts).map(([name, fact]) => [name, fact.tests, !!fact.moreTests]), [
            ['test/a.test.js', 1, true], ['test/b.test.js', 1, true], ['test/c.test.js', 1, false],
            ['test/d.test.js', 1, false], ['test/shared.js', 1, true],
        ]);
    });
});

describe('test units: a framework\'s name is the framework\'s by where it comes from', () => {
    const stateOf = unit => unit.skipped ? 'skipped' : unit.conditional ? 'conditional' : 'runs';

    it('Java: an annotation of the project named like JUnit\'s is not JUnit\'s, and JUnit\'s written in full is', () => {
        const own = name => `package com.x;\nimport java.lang.annotation.*;\n@Retention(RetentionPolicy.RUNTIME)\npublic @interface ${name} {}\n`;
        const { units } = answerFor({
            'pom.xml': '<project></project>\n',
            'src/test/java/com/x/Test.java': own('Test'),
            'src/test/java/com/x/Disabled.java': own('Disabled'),
            'src/test/java/com/x/BaseTestCase.java': 'package com.x;\npublic class BaseTestCase {}\n',
            'src/test/java/com/x/ATest.java': 'package com.x;\npublic class ATest extends BaseTestCase {\n    @Test\n    void notJunits() { }\n    @org.junit.jupiter.api.Test\n    void junits() { }\n    @org.junit.jupiter.api.Test\n    @Disabled\n    void ownDisabledRuns() { }\n    public void testNotJunit3() { }\n}\n',
        }, 'src/test/java/com/x/ATest.java');
        assert.deepStrictEqual(units.map(unit => [unit.name, stateOf(unit)]), [['junits', 'runs'], ['ownDisabledRuns', 'runs']]);
        // Imported by name from JUnit, the same spelling is JUnit's.
        const imported = answerFor({
            'pom.xml': '<project></project>\n',
            'src/test/java/com/y/Test.java': own('Test').replace('com.x', 'com.y'),
            'src/test/java/com/x/BTest.java': 'package com.x;\nimport org.junit.jupiter.api.Test;\nclass BTest {\n    @Test\n    void junits() { }\n}\n',
        }, 'src/test/java/com/x/BTest.java');
        assert.deepStrictEqual(imported.units.map(unit => unit.name), ['junits']);
    });

    it('Java: a setup method that assumes makes the tests of its class, and of the classes deriving from it, conditional', () => {
        const files = {
            'pom.xml': '<project></project>\n',
            'src/test/java/com/x/Base.java': 'package com.x;\nimport org.junit.jupiter.api.*;\nabstract class Base {\n    @BeforeEach\n    void needs() { Assumptions.assumeTrue(System.getenv("X") != null); }\n}\n',
            'src/test/java/com/x/ATest.java': 'package com.x;\nimport org.junit.jupiter.api.*;\nclass ATest extends Base {\n    @Test\n    void behindTheBase() { }\n}\n',
            'src/test/java/com/x/BTest.java': 'package com.x;\nimport org.junit.jupiter.api.*;\nclass BTest {\n    int ready;\n    @BeforeEach\n    void prepare() { ready = 1; }\n    @Test\n    void free() { }\n}\n',
        };
        assert.deepStrictEqual(answerFor(files, 'src/test/java/com/x/ATest.java').units.map(stateOf), ['conditional']);
        assert.deepStrictEqual(answerFor(files, 'src/test/java/com/x/BTest.java').units.map(stateOf), ['runs']);
    });

    it('C#: an attribute class of the project named like xUnit\'s is not xUnit\'s; a setup that ignores is read', () => {
        const xunit = answerFor({
            'App.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit" Version="2.9.3" /></ItemGroup></Project>\n',
            'Own.cs': 'namespace Own\n{\n    public class FactAttribute : System.Attribute { }\n}\n',
            'Tests.cs': 'namespace Own.Tests\n{\n    public class Lookalike\n    {\n        [Own.Fact]\n        public void NotXunits() { }\n\n        [Xunit.Fact]\n        public void Xunits() { }\n\n        [Fact]\n        public void TheNearerOne() { }\n    }\n}\n',
        }, 'Tests.cs');
        assert.deepStrictEqual(xunit.units.map(unit => unit.name), ['Xunits']);
        const nunit = answerFor({
            'App.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="NUnit" Version="3.12.0" /></ItemGroup></Project>\n',
            'Tests.cs': 'using NUnit.Framework;\n\nnamespace N.Tests\n{\n    public class Guarded\n    {\n        [SetUp]\n        public void Needs() { Assert.Ignore("not here"); }\n\n        [Test]\n        public void NeverRuns() { }\n    }\n\n    public class Free\n    {\n        [SetUp]\n        public void Prepare() { }\n\n        [Test]\n        public void Runs() { }\n    }\n}\n',
        }, 'Tests.cs');
        assert.deepStrictEqual(nunit.units.map(unit => [unit.name, stateOf(unit)]), [['NeverRuns', 'conditional'], ['Runs', 'runs']]);
    });

    it('JavaScript: a setup hook that can skip makes the tests of its suite conditional, however deep', () => {
        const { units } = answerFor({
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n',
            'test/a.test.js': "describe('outer', function () {\n    before(function () { this.skip(); });\n    it('direct', function () {});\n    describe('inner', function () {\n        it('deep', function () {});\n    });\n});\ndescribe('free', function () {\n    before(function () { this.timeout(1000); });\n    it('runs', function () {});\n});\ndescribe('named', function () {\n    beforeEach(prepare);\n    it('behind a function not written here', function () {});\n});\n",
        }, 'test/a.test.js');
        assert.deepStrictEqual(units.map(unit => [unit.name, stateOf(unit)]),
            [['direct', 'conditional'], ['deep', 'conditional'], ['runs', 'runs'], ['behind a function not written here', 'conditional']]);
    });

    it('Rust: tests a macro makes are not listed, and the count says so', () => {
        const facts = source => answerFor({ 'Cargo.toml': '[package]\nname = "m"\nversion = "0.1.0"\nedition = "2021"\n', 'src/lib.rs': source }, 'src/lib.rs').facts;
        const made = 'macro_rules! cases {\n    ($($name:ident),*) => { $( #[test] fn $name() {} )* };\n}\n\n#[cfg(test)]\nmod tests {\n    cases!(first, second);\n\n    #[test]\n    fn written() {}\n}\n';
        assert.deepStrictEqual([facts(made).tests, facts(made).moreTests], [1, true]);
        const inBody = '#[cfg(test)]\nmod tests {\n    proptest! {\n        #[test]\n        fn generated(x in 0..3) {}\n    }\n\n    #[test]\n    fn written() {}\n}\n';
        // A function written inside an invocation is read where it parses as one; the file still holds more.
        assert.deepStrictEqual([facts(inBody).tests, facts(inBody).moreTests], [2, true]);
        const plain = 'lazy_static! { static ref X: u8 = 1; }\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn written() {}\n}\n';
        assert.deepStrictEqual([facts(plain).tests, facts(plain).moreTests], [1, undefined]);
    });
});

describe('test units: a configuration that is code is read only where nothing else can change it', () => {
    const jest = config => answerFor({
        'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n', ...config,
        'test/a.test.js': "test('a', () => {});\n",
    }, 'test/a.test.js').facts;
    const run = fact => fact.run ? 'command' : fact.runWithheld;

    it('one object written out, with what packages and the language provide', () => {
        for (const source of [
            'module.exports = {};\n',
            "'use strict';\n\n/** @type {import('jest').Config} */\nconst config = { verbose: true };\n\nmodule.exports = config;\n",
            "const path = require('path');\nconst { join } = require('node:path');\nmodule.exports = { coverageDirectory: path.join(__dirname, 'c'), cacheDirectory: join(process.cwd(), '.c'), bail: process.env.CI ? 1 : 0 };\n",
            "const pkg = JSON.parse(require('fs').readFileSync('./package.json', 'utf8'));\nmodule.exports = { displayName: pkg.name };\n",
            'module.exports = { globals: { fn: () => 1 }, testTimeout: 10 * 1000 };\n',
        ]) assert.strictEqual(run(jest({ 'jest.config.js': source })), 'command', source);
        assert.strictEqual(run(jest({ 'jest.config.mjs': 'export default { verbose: true };\n' })), 'command');
        assert.strictEqual(run(jest({ 'jest.config.ts': "import type { Config } from 'jest';\n\nconst config: Config = { verbose: true };\n\nexport default config;\n" })), 'command');
    });

    it('anything that can change the object, or act on the run, leaves the configuration unread', () => {
        for (const source of [
            'module.exports = {};\nmodule.exports.verbose = true;\n',
            'const config = {};\nconfig.verbose = true;\nmodule.exports = config;\n',
            'const config = {};\nconst copy = config;\nmodule.exports = config;\n',
            'function defineConfig(c) { return c; }\nmodule.exports = defineConfig({});\n',
            'const defineConfig = c => c;\nmodule.exports = defineConfig({});\n',
            "const { defineConfig } = require('./define');\nmodule.exports = defineConfig({});\n",
            'module.exports = {};\nexports.verbose = true;\n',
            "module.exports = { ...require('./base') };\n",
            'module.exports = { get verbose() { return true; } };\n',
            'module.exports = { ["verbose"]: true };\n',
            'module.exports = { __proto__: { verbose: true } };\n',
            "require('./setup-env');\nmodule.exports = {};\n",
            "import './setup-env';\nexport default {};\n",
            "process.chdir('..');\nmodule.exports = {};\n",
            "const moved = process.chdir('..');\nmodule.exports = {};\n",
            "const made = require('fs').writeFileSync('x', '');\nmodule.exports = {};\n",
            'module.exports = { verbose: (() => true)() };\n',
            'module.exports = async () => ({});\n',
            'if (process.env.CI) { module.exports = {}; } else { module.exports = { verbose: true }; }\n',
            'const m = module;\nmodule.exports = {};\n',
            'module.exports = {};\nrequire.cache[__filename].exports.verbose = true;\n',
            'module.exports = { unknownKeyOfSomePlugin: true };\n',
            'module.exports = { testSequencer: "./sequencer.js" };\n',
        ]) assert.strictEqual(run(jest({ 'jest.config.js': source })), 'runner-config-not-read', source);
    });

    it('the function that passes a configuration through is the runner\'s own by its import', () => {
        const vitest = config => run(answerFor({
            'package.json': '{ "name": "x", "type": "module", "scripts": { "test": "vitest run" } }\n', 'vitest.config.js': config,
            'test/a.test.js': "import { test } from 'vitest';\ntest('a', () => {});\n",
        }, 'test/a.test.js').facts);
        assert.strictEqual(vitest("import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { globals: true } });\n"), 'command');
        assert.strictEqual(vitest("import { defineConfig as define } from 'vite';\nexport default define({ test: {} });\n"), 'command');
        assert.strictEqual(vitest("import react from '@vitejs/plugin-react';\nimport { defineConfig } from 'vitest/config';\nexport default defineConfig({ plugins: [react()], test: {} });\n"), 'command');
        assert.strictEqual(vitest("import { defineConfig } from './define.js';\nexport default defineConfig({ test: {} });\n"), 'runner-config-not-read');
        assert.strictEqual(vitest("import { defineConfig } from 'vitest/config';\nexport default defineConfig({ plugins: [{ name: 'x', config: () => ({}) }], test: {} });\n"), 'runner-config-not-read');
        assert.strictEqual(vitest("import { defineConfig, mergeConfig } from 'vitest/config';\nexport default mergeConfig({}, defineConfig({ test: {} }));\n"), 'runner-config-not-read');
        assert.strictEqual(vitest("import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { typecheck: { only: true } } });\n"), 'runner-config-not-read');
        assert.strictEqual(vitest("import { defineConfig } from 'vitest/config';\nexport default defineConfig({ root: 'packages/a', test: {} });\n"), 'runner-config-not-read');
    });

    it('JSON keeps what its strings hold when comments are taken out; YAML is read one key to a line or not at all', () => {
        const withComments = jest({ 'jest.config.json': '{\n  // comment\n  "testPathIgnorePatterns": ["/zz/*", "/yy*/"] /* after */\n}\n' });
        assert.strictEqual(run(withComments), 'command');
        const ignored = jest({ 'jest.config.json': '{\n  // comment\n  "testPathIgnorePatterns": ["/zz/*", "/yy*/", "a.test.js"]\n}\n' });
        assert.strictEqual(run(ignored), 'outside-runner-config');
        const mocha = config => run(answerFor({
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n', ...config,
            'test/a.test.js': "it('a', function () {});\n",
        }, 'test/a.test.js').facts);
        assert.strictEqual(mocha({ '.mocharc.yml': 'timeout: 4000\nreporter: dot\nrequire:\n  - ./setup.js\n' }), 'command');
        assert.strictEqual(mocha({ '.mocharc.yml': '---\n"timeout": 4000\n# a comment\nrequire:\n- ./setup.js\n' }), 'command');
        for (const yaml of ['{ timeout: 4000 }\n', '  timeout: 4000\n', '? timeout\n: 4000\n', 'base: &b\n  timeout: 1\n<<: *b\n',
            'timeout: 4000\nspec: other\n', 'timeout: 4000\n---\nspec: other\n', 'unknown-option: 1\n']) {
            assert.strictEqual(mocha({ '.mocharc.yml': yaml }), 'runner-config-not-read', yaml);
        }
    });
});

describe('test units: pytest collects by what a name holds, not by how a class is spelled', () => {
    const stateOf = unit => unit.skipped ? 'skipped' : unit.conditional ? 'conditional' : 'runs';
    const pytest = (files, name = 'tests/test_a.py') => answerFor({ 'pytest.ini': '[pytest]\n', 'tests/__init__.py': '', ...files }, name);
    const shape = found => found.units.map(unit => `${unit.label}:${stateOf(unit)}`);

    it('the nearest switch in the lookup order decides: off, the literal True, or a value that is not read', () => {
        const base = 'class Base:\n    __test__ = False\n    def test_m(self):\n        pass\n\n';
        assert.deepStrictEqual(shape(pytest({ 'tests/test_a.py': `${base}class TestX(Base):\n    pass\n` })), []);
        assert.deepStrictEqual(shape(pytest({ 'tests/test_a.py': `${base}class TestX(Base):\n    __test__ = True\n` })), ['TestX > test_m:runs']);
        assert.deepStrictEqual(shape(pytest({ 'tests/test_a.py': `${base}class TestX(Base):\n    __test__ = bool(1)\n` })), ['TestX > test_m:conditional']);
        assert.deepStrictEqual(shape(pytest({ 'tests/test_a.py': `${base}class Mid(Base):\n    __test__ = bool(1)\n\nclass TestX(Mid):\n    pass\n` })),
            ['Mid > test_m:conditional', 'TestX > test_m:conditional']);
        // The literal True collects a class or a function whatever it is called; a truthy value does not.
        assert.deepStrictEqual(shape(pytest({ 'tests/test_a.py': 'class Helper:\n    __test__ = True\n    def test_m(self):\n        pass\n\nclass Other:\n    __test__ = 1\n    def test_m(self):\n        pass\n\ndef check():\n    pass\ncheck.__test__ = True\n' })),
            ['Helper > test_m:runs', 'check:runs']);
    });

    it('a switch written on a class taken from another module holds for the classes here that derive from it', () => {
        const files = {
            'tests/test_a.py': 'class Base:\n    def test_m(self):\n        pass\n\nclass TestHome(Base):\n    pass\n',
            'tests/test_b.py': 'from tests.test_a import Base\n\nBase.__test__ = False\n\nclass TestHere(Base):\n    def test_own(self):\n        pass\n\ndef test_free():\n    pass\n',
            'tests/test_c.py': 'from tests.test_a import Base\n\nBase.__test__ = bool(1)\n\nclass TestHere(Base):\n    def test_own(self):\n        pass\n',
        };
        // In the module the class comes from the write holds where a writer was loaded first.
        // (test_c.py writes a value that may be the literal True: Base itself may then be taken.)
        assert.deepStrictEqual(shape(pytest(files)), ['Base > test_m:conditional', 'TestHome > test_m:conditional']);
        assert.deepStrictEqual(shape(pytest({ ...files, 'tests/test_c.py': '' })), ['TestHome > test_m:conditional']);
        assert.deepStrictEqual(shape(pytest({ 'tests/test_a.py': files['tests/test_a.py'] })), ['TestHome > test_m:runs']);
        assert.deepStrictEqual(shape(pytest(files, 'tests/test_b.py')), ['test_free:runs']);
        assert.deepStrictEqual(shape(pytest(files, 'tests/test_c.py')),
            ['Base > test_m:conditional', 'TestHere > test_m:conditional', 'TestHere > test_own:conditional']);
    });

    it('a class of the project named like a TestCase is no unittest class; one deriving from unittest\'s is, through the project', () => {
        const found = pytest({
            'tests/base.py': 'import unittest\n\nclass ProjectCase(unittest.TestCase):\n    pass\n\nclass BaseTestCase:\n    def test_x(self):\n        pass\n',
            'tests/test_a.py': 'from tests.base import ProjectCase, BaseTestCase\n\nclass Checks(BaseTestCase):\n    def test_y(self):\n        pass\n\nclass Real(ProjectCase):\n    def test_z(self):\n        pass\n',
        });
        assert.deepStrictEqual(shape(found), ['Real > test_z:runs']);
    });

    it('marks, setups and fixtures of the classes a class derives from reach its tests; a module\'s reach the tests it imports', () => {
        const files = {
            'tests/base.py': 'import pytest\n\n@pytest.mark.skip\nclass Skipped:\n    def test_s(self):\n        pass\n\nclass Guarded:\n    def setup_method(self):\n        pytest.skip("no")\n    def test_g(self):\n        pass\n\ndef test_fn():\n    pass\n',
            'tests/test_a.py': 'from tests.base import Skipped, Guarded\n\nclass TestS(Skipped):\n    def test_own(self):\n        pass\n\nclass TestG(Guarded):\n    def test_own(self):\n        pass\n',
            'tests/test_b.py': 'import pytest\nfrom tests.base import test_fn\npytestmark = pytest.mark.skip\n',
            'tests/test_c.py': 'from tests.base import test_fn\n__test__ = bool(0)\n',
        };
        assert.deepStrictEqual(shape(pytest(files)),
            ['TestS > test_s:skipped', 'TestS > test_own:skipped', 'TestG > test_g:conditional', 'TestG > test_own:conditional']);
        assert.deepStrictEqual(shape(pytest(files, 'tests/test_b.py')), ['test_fn:skipped']);
        assert.deepStrictEqual(shape(pytest(files, 'tests/test_c.py')), ['test_fn:conditional']);
    });

    it('a module that stops when it is imported: through another name, in a function it calls, never under __main__', () => {
        const module = source => shape(pytest({ 'tests/test_a.py': `import pytest\n${source}\ndef test_a():\n    pass\n` }));
        assert.deepStrictEqual(module('skip = pytest.skip\nskip("x", allow_module_level=True)\n'), ['test_a:conditional']);
        assert.deepStrictEqual(module('def need():\n    pytest.skip("x", allow_module_level=True)\n\nneed()\n'), ['test_a:conditional']);
        assert.deepStrictEqual(module('def need():\n    pytest.skip("x", allow_module_level=True)\n'), ['test_a:runs']);
        assert.deepStrictEqual(module('requires = pytest.mark.skipif(True, reason="x")\n'), ['test_a:runs']);
        assert.deepStrictEqual(module('if __name__ == "__main__":\n    raise SystemExit(pytest.main([__file__]))\n'), ['test_a:runs']);
        assert.deepStrictEqual(module('if __name__ != "__main__":\n    raise RuntimeError("x")\n'), ['test_a:conditional']);
    });

    it('a stopping call in another module of the project is followed one module deep, from a fixture, a setup, a hook and the module', () => {
        const helpers = 'import pytest\n\ndef need():\n    pytest.skip("no")\n\ndef make():\n    return 1\n';
        const files = {
            'tests/helpers.py': helpers,
            'tests/conftest.py': 'import pytest\nfrom tests.helpers import need, make\n\n@pytest.fixture\ndef service():\n    need()\n\n@pytest.fixture\ndef thing():\n    return make()\n',
            'tests/test_a.py': 'from tests import helpers\n\ndef test_needs(service):\n    pass\n\ndef test_plain(thing):\n    pass\n\nclass TestNeeds:\n    def setup_method(self):\n        helpers.need()\n    def test_m(self):\n        pass\n\nclass TestFree:\n    def setup_method(self):\n        helpers.make()\n    def test_m(self):\n        pass\n',
            'tests/test_b.py': 'from tests.helpers import need\n\nneed()\n\ndef test_behind():\n    pass\n',
            'tests/test_c.py': 'from tests.helpers import make\n\nvalue = make()\n\ndef test_free():\n    pass\n',
        };
        assert.deepStrictEqual(shape(pytest(files)),
            ['test_needs:conditional', 'test_plain:runs', 'TestNeeds > test_m:conditional', 'TestFree > test_m:runs']);
        assert.deepStrictEqual(shape(pytest(files, 'tests/test_b.py')), ['test_behind:conditional']);
        assert.deepStrictEqual(shape(pytest(files, 'tests/test_c.py')), ['test_free:runs']);
        const hooked = body => ({ ...files, 'tests/conftest.py': `from tests.helpers import make, need\n\ndef pytest_runtest_setup(item):\n    ${body}\n` });
        assert.deepStrictEqual(shape(pytest(hooked('make()'), 'tests/test_c.py')), ['test_free:runs']);
        assert.deepStrictEqual(shape(pytest(hooked('need()'), 'tests/test_c.py')), ['test_free:conditional']);
    });
});

// ---------------------------------------------------------------------------
// A declaration is kept apart from its state, and a class has what its
// lookup order finds first
// ---------------------------------------------------------------------------

describe('test units: a switch is the state of an object, whoever holds it', () => {
    const stateOf = unit => unit.skipped ? 'skipped' : unit.conditional ? 'conditional' : 'runs';
    const pytest = (files, name = 'tests/test_case.py') => answerFor({ 'pytest.ini': '[pytest]\n', 'tests/__init__.py': '', ...files }, name);
    const shape = found => found.units.map(unit => `${unit.label}:${stateOf(unit)}`);
    const OFF = 'def helper():\n    pass\n\nhelper.__test__ = False\n';

    it('a function its module switches off is one again where a module that takes it switches it on', () => {
        const files = { 'tests/helpers.py': OFF };
        assert.deepStrictEqual(shape(pytest({ ...files, 'tests/test_case.py': 'from tests.helpers import helper as test_actual\ntest_actual.__test__ = True\n' })),
            ['test_actual:runs']);
        // Taken and left as it is, it stays off; switched on under a name pytest does not take, it is taken.
        assert.deepStrictEqual(shape(pytest({ ...files, 'tests/test_case.py': 'from tests.helpers import helper as test_actual\n' })), []);
        assert.deepStrictEqual(shape(pytest({ 'tests/helpers.py': 'def helper():\n    pass\n', 'tests/test_case.py': 'from tests.helpers import helper\nhelper.__test__ = True\n' })),
            ['helper:runs']);
        // A switch written in a branch may not be written.
        assert.deepStrictEqual(shape(pytest({ ...files, 'tests/test_case.py': 'import os\nfrom tests.helpers import helper as test_actual\nif os.environ.get("X"):\n    test_actual.__test__ = True\n' })),
            ['test_actual:conditional']);
        // On a name a star import brings.
        assert.deepStrictEqual(shape(pytest({ 'tests/helpers.py': 'def test_shared():\n    pass\n\ntest_shared.__test__ = False\n', 'tests/test_case.py': 'from tests.helpers import *\ntest_shared.__test__ = True\n' })),
            ['test_shared:runs']);
        // Another name for a function that is off is off.
        assert.deepStrictEqual(shape(pytest({ 'tests/test_case.py': `${OFF}test_alias = helper\n\ndef test_own():\n    pass\n` })), ['test_own:runs']);
    });

    it('a switch another module writes holds where that module was loaded first: the test runs only sometimes', () => {
        const files = {
            'tests/test_b.py': 'def test_x():\n    pass\n\ndef test_y():\n    pass\n',
            'tests/test_a.py': 'from tests.test_b import test_x\ntest_x.__test__ = False\n\ndef test_own():\n    pass\n',
        };
        assert.deepStrictEqual(shape(pytest(files, 'tests/test_b.py')), ['test_x:conditional', 'test_y:runs']);
        assert.deepStrictEqual(shape(pytest(files, 'tests/test_a.py')), ['test_own:runs']);
        // One the module leaves off that another switches on is listed, as running only sometimes.
        const on = {
            'tests/test_helpers.py': `${OFF}\ndef test_own():\n    pass\n`,
            'tests/test_case.py': 'from tests.test_helpers import helper as test_actual\ntest_actual.__test__ = True\n',
        };
        assert.deepStrictEqual(shape(pytest(on, 'tests/test_helpers.py')), ['helper:conditional', 'test_own:runs']);
        assert.deepStrictEqual(shape(pytest(on)), ['test_actual:runs']);
        // A third module that takes the function sees the write where the writer was loaded first.
        assert.deepStrictEqual(shape(pytest({ ...on, 'tests/test_third.py': 'from tests.test_helpers import helper as test_again\n' }, 'tests/test_third.py')),
            ['test_again:conditional']);
    });

    it('a switch written in a way that is not read: what its module switched off may be on again', () => {
        const files = {
            'tests/helpers.py': `${OFF}\nclass Base:\n    def test_m(self):\n        pass\n    test_m.__test__ = False\n\ndef plain():\n    pass\n`,
            'tests/test_case.py': 'from tests.helpers import helper, plain, Base\n\ntest_x = helper\ntest_x.__test__ = True\n\nclass TestK(Base):\n    pass\n\nBase.test_m.__test__ = True\n',
        };
        const found = pytest(files);
        // Under each name the module holds it; a function nothing switched is left alone.
        assert.deepStrictEqual(shape(found), ['helper:conditional', 'test_x:conditional', 'TestK > test_m:conditional']);
        assert.strictEqual(found.facts.moreTests, true);
        // With every switch read, the same module lists what is on.
        assert.deepStrictEqual(shape(pytest({ ...files, 'tests/test_case.py': 'from tests.helpers import helper, plain, Base\n\nclass TestK(Base):\n    pass\n' })), []);
    });

    it('the module that writes on what it took from another is never joined with another file', () => {
        const dir = projectOf({
            'pytest.ini': '[pytest]\n', 'tests/__init__.py': '', 'tests/helpers.py': OFF,
            'tests/test_case.py': 'from tests.helpers import helper as test_actual\ntest_actual.__test__ = True\n',
            'tests/test_other.py': 'def test_o():\n    pass\n',
            'tests/test_more.py': 'def test_m():\n    pass\n',
        });
        try {
            const index = idx(dir);
            index._beginOp();
            const model = createTestModel(index);
            const lines = commandsFor(model, ['tests/test_case.py', 'tests/test_more.py', 'tests/test_other.py'].map(name => path.join(dir, name)));
            index._endOp();
            assert.deepStrictEqual(lines, ['pytest tests/test_case.py', 'pytest tests/test_more.py tests/test_other.py']);
        } finally {
            rm(dir);
        }
    });
});

describe('test units: a class has the constructor its lookup order binds first', () => {
    const stateOf = unit => unit.skipped ? 'skipped' : unit.conditional ? 'conditional' : 'runs';
    const pytest = (files, name = 'tests/test_case.py') => answerFor({ 'pytest.ini': '[pytest]\n', 'tests/__init__.py': '', ...files }, name);
    const shape = found => found.units.map(unit => `${unit.label}:${stateOf(unit)}`);
    const BASE = 'class Base:\n    def __init__(self): pass\n    def test_actual(self):\n        pass\n\n';
    const one = source => shape(pytest({ 'tests/test_case.py': source }));

    it('a class that writes the builtin constructor back is collected, whatever stands behind it', () => {
        assert.deepStrictEqual(one(`${BASE}class TestActual(Base):\n    pass\n`), []);
        assert.deepStrictEqual(one(`${BASE}class TestActual(Base):\n    __init__ = object.__init__\n`), ['TestActual > test_actual:runs']);
        assert.deepStrictEqual(one(`${BASE}class Mid(Base):\n    __init__ = object.__init__\n\nclass TestActual(Mid):\n    pass\n`),
            ['TestActual > test_actual:runs']);
        assert.deepStrictEqual(one(`${BASE}class Mid(Base):\n    __init__ = object.__init__\n\nclass TestActual(Mid):\n    def __init__(self): pass\n`), []);
        const made = 'class Base:\n    def __new__(cls): return object.__new__(cls)\n    def test_actual(self):\n        pass\n\n';
        assert.deepStrictEqual(one(`${made}class TestActual(Base):\n    __new__ = object.__new__\n`), ['TestActual > test_actual:runs']);
        // With the base in another file the deriving file keeps its test.
        assert.deepStrictEqual(shape(pytest({
            'tests/helpers.py': BASE, 'tests/test_case.py': 'from tests.helpers import Base\n\nclass TestActual(Base):\n    __init__ = object.__init__\n',
        })), ['TestActual > test_actual:runs']);
    });

    it('the order of two bases decides; a constructor that is deleted is gone', () => {
        const two = 'class A:\n    def __init__(self): pass\n\nclass B:\n    __init__ = object.__init__\n\n';
        assert.deepStrictEqual(one(`${two}class TestBA(B, A):\n    def test_m(self):\n        pass\n\nclass TestAB(A, B):\n    def test_m(self):\n        pass\n`),
            ['TestBA > test_m:runs']);
        assert.deepStrictEqual(one('class TestActual:\n    def __init__(self): pass\n    del __init__\n    def test_m(self):\n        pass\n'),
            ['TestActual > test_m:runs']);
    });

    it('a constructor that is not read leaves the class collected only sometimes, with no command for its tests', () => {
        const unread = source => {
            const found = pytest({ 'tests/test_case.py': source });
            return found.units.map(unit => `${unit.label}:${stateOf(unit)}:${unit.selectorWithheld || 'command'}`);
        };
        assert.deepStrictEqual(unread(`${BASE}class Plain:\n    pass\n\nclass TestActual(Base):\n    __init__ = Plain.__init__\n`),
            ['TestActual > test_actual:conditional:constructor-not-read']);
        assert.deepStrictEqual(unread('import os\n\nclass TestActual:\n    if os.environ.get("X"):\n        def __init__(self): pass\n    def test_m(self):\n        pass\n'),
            ['TestActual > test_m:conditional:constructor-not-read']);
        // Written from outside the class, here or on a class taken from another module.
        assert.deepStrictEqual(unread(`${BASE}class TestActual(Base):\n    pass\n\nTestActual.__init__ = object.__init__\n`),
            ['TestActual > test_actual:conditional:constructor-not-read']);
        assert.deepStrictEqual(shape(pytest({
            'tests/helpers.py': BASE,
            'tests/test_case.py': 'from tests.helpers import Base\n\nBase.__init__ = object.__init__\n\nclass TestActual(Base):\n    pass\n',
        })), ['TestActual > test_actual:conditional']);
        // A base that is not read may bind one, unless a class nearer wrote both back.
        assert.deepStrictEqual(unread('import argparse\n\nclass TestSpace(argparse.Namespace):\n    __init__ = object.__init__\n    def test_m(self):\n        pass\n'),
            ['TestSpace > test_m:conditional:base-not-resolved']);
    });

    it('typing.Protocol gives a class a constructor: pytest takes neither it nor a class deriving from it', () => {
        assert.deepStrictEqual(one('import typing\n\nclass TestProtocol(typing.Protocol):\n    def test_m(self):\n        pass\n\nclass TestImpl(TestProtocol):\n    pass\n\nclass TestFree(TestProtocol):\n    __init__ = object.__init__\n\nclass TestPlain(typing.Generic[typing.TypeVar("T")]):\n    def test_p(self):\n        pass\n'),
            ['TestFree > test_m:runs', 'TestPlain > test_p:runs']);
    });

    it('unittest runs the nearest runTest of a class that has no other test', () => {
        assert.deepStrictEqual(one('import unittest\n\nclass Base(unittest.TestCase):\n    def runTest(self):\n        pass\n\nclass Child(Base):\n    pass\n\nclass WithTest(Base):\n    def test_w(self):\n        pass\n'),
            ['Base > runTest:runs', 'Child > runTest:runs', 'WithTest > test_w:runs']);
    });
});

describe('test units: a table of parameters runs the body only through a row that does', () => {
    const stateOf = unit => unit.skipped ? 'skipped' : unit.conditional ? 'conditional' : 'runs';
    const pytest = (files, name = 'tests/test_case.py') => answerFor({ 'pytest.ini': '[pytest]\n', 'tests/__init__.py': '', ...files }, name);
    const shape = found => found.units.map(unit => `${unit.label}:${stateOf(unit)}`);
    const SKIP = 'pytest.param(1, marks=pytest.mark.skip(reason="off"))';
    const test = (rows, name = 'test_actual') => `@pytest.mark.parametrize("value", ${rows})\ndef ${name}(value):\n    pass\n`;
    const one = source => shape(pytest({ 'tests/test_case.py': `import pytest\n\n${source}` }));

    it('rows that carry a skip, a condition or an xfail that does not run', () => {
        assert.deepStrictEqual(one(test(`[${SKIP}]`)), ['test_actual:skipped']);
        assert.deepStrictEqual(one(test(`[${SKIP}, 2]`)), ['test_actual:runs']);
        assert.deepStrictEqual(one(test('[pytest.param(1, marks=pytest.mark.xfail(run=False))]')), ['test_actual:skipped']);
        assert.deepStrictEqual(one(test('[pytest.param(1, marks=pytest.mark.xfail(strict=True))]')), ['test_actual:runs']);
        assert.deepStrictEqual(one(test('[pytest.param(1, marks=pytest.mark.skipif(True, reason="x"))]')), ['test_actual:conditional']);
        assert.deepStrictEqual(one(test('[pytest.param(1, id="one")]')), ['test_actual:runs']);
        // Inside a row a param is a value like any other.
        assert.deepStrictEqual(one(test(`[(${SKIP},)]`)), ['test_actual:runs']);
        // Two tables: each needs a row that runs.
        assert.deepStrictEqual(one(`@pytest.mark.parametrize("other", [1, 2])\n${test(`[${SKIP}]`)}`), ['test_actual:skipped']);
    });

    it('an xfail that does not run the body applies where its condition holds', () => {
        const xfail = args => one(`import sys\n\n@pytest.mark.xfail(${args})\ndef test_actual():\n    pass\n`);
        assert.deepStrictEqual(xfail('run=False'), ['test_actual:skipped']);
        assert.deepStrictEqual(xfail('True, run=False, reason="x"'), ['test_actual:skipped']);
        assert.deepStrictEqual(xfail('False, run=False, reason="x"'), ['test_actual:runs']);
        assert.deepStrictEqual(xfail('condition=False, run=False, reason="x"'), ['test_actual:runs']);
        assert.deepStrictEqual(xfail('sys.platform == "nope", run=False, reason="x"'), ['test_actual:conditional']);
        // A condition written as text is evaluated by pytest.
        assert.deepStrictEqual(xfail('"sys.platform == \'nope\'", run=False'), ['test_actual:conditional']);
        assert.deepStrictEqual(xfail('False, True, run=False, reason="x"'), ['test_actual:skipped']);
        assert.deepStrictEqual(xfail('sys.platform == "nope"'), ['test_actual:runs']);
    });

    it('a row under a name, in a list under a name, starred, or made by a function of the module', () => {
        assert.deepStrictEqual(one(`OFF = ${SKIP}\nON = pytest.param(2)\n\n${test('[OFF]', 'test_off')}\n${test('[ON]', 'test_on')}`),
            ['test_off:skipped', 'test_on:runs']);
        assert.deepStrictEqual(one(`ROWS = [${SKIP}]\n\n${test('ROWS')}`), ['test_actual:skipped']);
        assert.deepStrictEqual(one(`ROWS = [${SKIP}]\nNONE = []\n\n${test('[*ROWS]', 'test_off')}\n${test('[*NONE]', 'test_none')}\n${test('[*NONE, 1]', 'test_one')}`),
            ['test_off:skipped', 'test_none:skipped', 'test_one:runs']);
        assert.deepStrictEqual(one(`def off(v):\n    return pytest.param(v, marks=pytest.mark.skip(reason="off"))\n\ndef plain(v):\n    return v + 1\n\n${test('[off(1)]', 'test_off')}\n${test('[plain(1)]', 'test_on')}\n${test('[plain(off(1))]', 'test_through')}`),
            ['test_off:conditional', 'test_on:runs', 'test_through:conditional']);
    });

    it('a row that is a value: a class, a member, an instance, a builtin, what a package gives', () => {
        const source = `import decimal\n\nclass Kind:\n    A = 1\n\n${['Kind', 'Kind.A', 'Kind()', 'decimal.Decimal("1")', 'dict', 'lambda: 1', '-1', 'f"a{1}"', 'pytest.param(1, marks=pytest.mark.slow)']
            .map((row, i) => test(`[${row}]`, `test_${i}`)).join('\n')}`;
        assert.deepStrictEqual(one(source), Array.from({ length: 9 }, (unused, i) => `test_${i}:runs`));
    });

    it('a row named in another module of the project is read there, through the modules that pass the name on', () => {
        const files = {
            'tests/cases.py': `import pytest\nfrom tests.far import FAR\n\nOFF = ${SKIP}\nON = 2\n\nclass Kind:\n    A = 1\n    GONE = ${SKIP}\n\ndef off(v):\n    return pytest.param(v, marks=pytest.mark.skip(reason="off"))\n\ndef plain(v):\n    return v\n`,
            'tests/far.py': `import pytest\n\nFAR = 1\nGONE = ${SKIP}\n`,
            'tests/all.py': 'from tests.far import *\n',
            'tests/test_case.py': `import pytest\nfrom tests.cases import OFF, ON, FAR, Kind, off, plain\nfrom tests import cases, all\n\n${[
                ['OFF', 'off'], ['ON', 'on'], ['cases.OFF', 'module_off'], ['cases.ON', 'module_on'], ['Kind.A', 'member_on'],
                ['Kind.GONE', 'member_off'], ['off(1)', 'call_off'], ['plain(1)', 'call_on'], ['Kind', 'class_on'], ['FAR', 'far'], ['cases', 'module'],
                ['all.FAR', 'star_on'], ['all.GONE', 'star_off'], ['all.MISSING', 'star_missing'],
            ].map(([row, name]) => test(`[${row}]`, `test_${name}`)).join('\n')}`,
        };
        assert.deepStrictEqual(shape(pytest(files)), [
            'test_off:skipped', 'test_on:runs', 'test_module_off:skipped', 'test_module_on:runs', 'test_member_on:runs',
            'test_member_off:skipped', 'test_call_off:conditional', 'test_call_on:runs', 'test_class_on:runs',
            // A name a module took from another, or by a star import, is read where it is bound.
            'test_far:runs', 'test_module:runs', 'test_star_on:runs', 'test_star_off:skipped', 'test_star_missing:conditional',
        ]);
    });

    it('a table on a class or on the module, and the rows of a fixture', () => {
        assert.deepStrictEqual(one(`@pytest.mark.parametrize("value", [${SKIP}])\nclass TestK:\n    def test_m(self, value):\n        pass\n\nclass TestL:\n    pytestmark = pytest.mark.parametrize("value", [${SKIP}])\n    def test_m(self, value):\n        pass\n`),
            ['TestK > test_m:skipped', 'TestL > test_m:skipped']);
        assert.deepStrictEqual(one(`pytestmark = pytest.mark.parametrize("value", [${SKIP}])\n\ndef test_actual(value):\n    pass\n`), ['test_actual:skipped']);
        assert.deepStrictEqual(one(`OFF = ${SKIP}\n\n@pytest.fixture(params=[OFF])\ndef by_name(request): return request.param\n\n@pytest.fixture(params=[${SKIP}, 2])\ndef some(request): return request.param\n\ndef test_by_name(by_name):\n    pass\n\ndef test_some(some):\n    pass\n`),
            ['test_by_name:conditional', 'test_some:runs']);
    });
});

describe('test units: what runs a test more than once without its declaration saying so', () => {
    const stateOf = unit => unit.skipped ? 'skipped' : unit.conditional ? 'conditional' : 'runs';
    const pytest = (files, name = 'tests/test_case.py') => answerFor({ 'pytest.ini': '[pytest]\n', 'tests/__init__.py': '', ...files }, name);
    const count = found => `${found.facts.tests}${found.facts.moreTests ? '+' : ''} ${found.units.map(unit => `${unit.label}:${stateOf(unit)}`).join(' ')}`;
    const TWICE = 'import pytest\n\n@pytest.fixture(params=[1, 2], autouse=True)\ndef value(request): return request.param\n';
    const TEST = 'def test_actual():\n    pass\n';

    it('a fixture every test gets that has a table: in the module, a conftest.py, a plugin, the class or one it derives from', () => {
        assert.strictEqual(count(pytest({ 'tests/test_case.py': TEST })), '1 test_actual:runs');
        assert.strictEqual(count(pytest({ 'tests/test_case.py': `${TWICE}\n${TEST}` })), '1+ test_actual:runs');
        assert.strictEqual(count(pytest({ 'conftest.py': TWICE, 'tests/test_case.py': TEST })), '1+ test_actual:runs');
        assert.strictEqual(count(pytest({ 'tests/plugin.py': TWICE, 'conftest.py': 'pytest_plugins = ["tests.plugin"]\n', 'tests/test_case.py': TEST })),
            '1+ test_actual:runs');
        // One beside the file's directory does not reach it.
        assert.strictEqual(count(pytest({ 'other/conftest.py': TWICE, 'tests/test_case.py': TEST })), '1 test_actual:runs');
        assert.strictEqual(count(pytest({ 'tests/test_case.py': `import pytest\n\nclass TestK:\n    @pytest.fixture(params=[1, 2], autouse=True)\n    def value(self, request): return request.param\n    def test_m(self):\n        pass\n\n${TEST}` })),
            '2+ TestK > test_m:runs test_actual:runs');
        assert.strictEqual(count(pytest({
            'tests/helpers.py': 'import pytest\n\nclass Base:\n    @pytest.fixture(params=[1, 2], autouse=True)\n    def value(self, request): return request.param\n',
            'tests/test_case.py': 'from tests.helpers import Base\n\nclass TestK(Base):\n    def test_m(self):\n        pass\n',
        })), '1+ TestK > test_m:runs');
        // Through a fixture it asks for, and with rows that do not run the body.
        assert.strictEqual(count(pytest({ 'tests/test_case.py': `import pytest\n\n@pytest.fixture(params=[1, 2])\ndef value(request): return request.param\n\n@pytest.fixture(autouse=True)\ndef every(value): return value\n\n${TEST}` })),
            '1+ test_actual:runs');
        assert.strictEqual(count(pytest({ 'tests/test_case.py': `import pytest\n\n@pytest.fixture(params=[pytest.param(1, marks=pytest.mark.skip(reason="off"))], autouse=True)\ndef value(request): return request.param\n\n${TEST}` })),
            '1+ test_actual:conditional');
    });

    it('a hook that makes tests from a test: of a conftest.py, the module, a plugin, the class', () => {
        const hook = 'def pytest_generate_tests(metafunc):\n    metafunc.parametrize("value", [1, 2])\n';
        const body = 'def test_actual(value):\n    pass\n';
        assert.strictEqual(count(pytest({ 'conftest.py': hook, 'tests/test_case.py': body })), '1+ test_actual:conditional');
        assert.strictEqual(count(pytest({ 'tests/test_case.py': `${hook}\n${body}` })), '1+ test_actual:conditional');
        assert.strictEqual(count(pytest({ 'tests/plugin.py': hook, 'conftest.py': 'pytest_plugins = ["tests.plugin"]\n', 'tests/test_case.py': body })),
            '1+ test_actual:conditional');
        assert.strictEqual(count(pytest({ 'tests/test_case.py': 'class TestK:\n    def pytest_generate_tests(self, metafunc):\n        metafunc.parametrize("value", [1, 2])\n\n    def test_m(self, value):\n        pass\n\ndef test_free():\n    pass\n' })),
            '2+ TestK > test_m:conditional test_free:runs');
    });

    it('a test of unittest takes no parameters: under a fixture\'s table it runs only sometimes', () => {
        const unit = 'import unittest\n\nclass K(unittest.TestCase):\n    def test_m(self):\n        pass\n';
        assert.strictEqual(count(pytest({ 'conftest.py': TWICE, 'tests/test_case.py': unit })), '1+ K > test_m:conditional');
        assert.strictEqual(count(pytest({ 'conftest.py': 'import pytest\n\n@pytest.fixture(autouse=True)\ndef every(): return 1\n', 'tests/test_case.py': unit })),
            '1 K > test_m:runs');
    });
});

describe('test units: Java annotations are read by each framework\'s own rule', () => {
    const stateOf = unit => unit.skipped ? 'skipped' : unit.conditional ? 'conditional' : 'runs';
    const D = 'src/test/java/com/x/';
    const POM = '<project><modelVersion>4.0.0</modelVersion><groupId>com.x</groupId><artifactId>m</artifactId><version>1</version></project>\n';
    const java = (files, name) => {
        const found = answerFor({ 'pom.xml': POM, ...Object.fromEntries(Object.entries(files).map(([file, text]) => [`${D}${file}`, `package com.x;\n\n${text}`])) }, `${D}${name}`);
        return `${found.facts.tests}${found.facts.moreTests ? '+' : ''} ${found.units.map(unit => `${unit.label.split(' > ').pop()}:${stateOf(unit)}${unit.selector ? '' : ':no-command'}`).join(' ')}`;
    };

    it('@Disabled and @Ignore on a class hold for that class, not for one deriving from it', () => {
        assert.strictEqual(java({
            'DisabledBase.java': 'import org.junit.jupiter.api.Disabled;\nimport org.junit.jupiter.api.Test;\n\n@Disabled\nabstract class DisabledBase {\n    @Test\n    void inherited() { }\n\n    @Test\n    @Disabled\n    void off() { }\n}\n',
            'ChildTest.java': 'class ChildTest extends DisabledBase {\n}\n',
        }, 'ChildTest.java'), '1 inherited:runs off:skipped');
        assert.strictEqual(java({
            'IgnoredBase.java': 'import org.junit.Ignore;\nimport org.junit.Test;\n\n@Ignore\npublic abstract class IgnoredBase {\n    @Test\n    public void inherited() { }\n}\n',
            'ChildTest.java': 'public class ChildTest extends IgnoredBase {\n}\n',
        }, 'ChildTest.java'), '1 inherited:runs');
        // On the class itself it holds.
        assert.strictEqual(java({
            'Base.java': 'import org.junit.jupiter.api.Test;\n\nabstract class Base {\n    @Test\n    void inherited() { }\n}\n',
            'ChildTest.java': 'import org.junit.jupiter.api.Disabled;\n\n@Disabled\nclass ChildTest extends Base {\n}\n',
        }, 'ChildTest.java'), '0 inherited:skipped');
    });

    it('a method redeclared without the annotation: JUnit 5 no longer runs it, JUnit 4 and TestNG run it with the new body', () => {
        const child = 'public class ChildTest extends Base {\n    @Override\n    public void overridden() { }\n}\n';
        const base = pkg => `import ${pkg}.Test;\n\npublic abstract class Base {\n    @Test\n    public void kept() { }\n\n    @Test\n    public void overridden() { }\n}\n`;
        assert.strictEqual(java({ 'Base.java': base('org.junit.jupiter.api'), 'ChildTest.java': child }, 'ChildTest.java'), '1 kept:runs');
        assert.strictEqual(java({ 'Base.java': base('org.junit'), 'ChildTest.java': child }, 'ChildTest.java'), '2 kept:runs overridden:runs');
        // Maven's filter does not find a TestNG test under the class that inherits it.
        assert.strictEqual(java({ 'Base.java': base('org.testng.annotations'), 'ChildTest.java': child }, 'ChildTest.java'),
            '2 kept:runs:no-command overridden:runs:no-command');
        // The body is the class's own: its lines are the unit's.
        const dir = projectOf({ 'pom.xml': POM, [`${D}Base.java`]: `package com.x;\n\n${base('org.junit')}`, [`${D}ChildTest.java`]: `package com.x;\n\n${child}` });
        try {
            const found = rowsOf(idx(dir), `${D}ChildTest.java`);
            const unit = found.units.find(each => each.label === 'ChildTest > overridden');
            assert.deepStrictEqual([unit.line, unit.inherited || null], [5, null]);
        } finally {
            rm(dir);
        }
    });

    it('a method of the same name with other parameters is another method: the inherited test runs as it stands', () => {
        const base = pkg => `import ${pkg}.Test;\n\npublic abstract class Base {\n    @Test\n    public void works() { }\n\n    @Test\n    public void kept() { }\n}\n`;
        const overloads = 'public class ChildTest extends Base {\n    public void works(int ignored) { }\n\n    public void kept(String other, java.util.List<String> more) { }\n}\n';
        const below = { 'Middle.java': 'public abstract class Middle extends Base {\n    public void works(String ignored) { }\n}\n', 'ChildTest.java': 'public class ChildTest extends Middle {\n}\n' };
        for (const [pkg, command] of [['org.junit', ''], ['org.junit.jupiter.api', ''], ['org.testng.annotations', ':no-command']]) {
            assert.strictEqual(java({ 'Base.java': base(pkg), 'ChildTest.java': overloads }, 'ChildTest.java'),
                `2 kept:runs${command} works:runs${command}`, pkg);
            assert.strictEqual(java({ 'Base.java': base(pkg), ...below }, 'ChildTest.java'), `2 kept:runs${command} works:runs${command}`, pkg);
        }
        // The body is the base's: the unit says where it stands, and a call there reaches the deriving class.
        const dir = projectOf({
            'pom.xml': POM, [`${D}App.java`]: 'package com.x;\n\npublic class App {\n    public static void target() { }\n}\n',
            [`${D}Base.java`]: 'package com.x;\n\nimport org.junit.Test;\n\npublic abstract class Base {\n    @Test\n    public void works() {\n        App.target();\n    }\n}\n',
            [`${D}ChildTest.java`]: 'package com.x;\n\npublic class ChildTest extends Base {\n    public void works(int ignored) { }\n}\n',
        });
        try {
            const index = idx(dir);
            const unit = rowsOf(index, `${D}ChildTest.java`).units.find(each => each.kind === 'test');
            assert.strictEqual(unit.inheritedFrom, `${D}Base.java:7`);
            const affected = index.affectedTests('target', { depth: 2 });
            assert.strictEqual(affected.summary.totalTests, 1);
            assert.ok(affected.testFiles.some(file => file.file === `${D}ChildTest.java`));
            assert.ok(affected.commands.length > 0);
        } finally {
            rm(dir);
        }
        // Qualifiers and type arguments are no part of a signature: this one is an override.
        assert.strictEqual(java({
            'Base.java': 'import org.junit.jupiter.api.Test;\nimport org.junit.jupiter.params.ParameterizedTest;\nimport org.junit.jupiter.params.provider.NullSource;\n\npublic abstract class Base {\n    @ParameterizedTest\n    @NullSource\n    void rows(java.util.List<String> items) { }\n\n    @Test\n    void kept() { }\n}\n',
            'ChildTest.java': 'import java.util.List;\n\npublic class ChildTest extends Base {\n    @Override\n    void rows(List<String> items) { }\n}\n',
        }, 'ChildTest.java'), '1 kept:runs');
    });

    it('a test with parameters runs through the rows its sources give', () => {
        const head = 'import org.junit.jupiter.api.RepeatedTest;\nimport org.junit.jupiter.api.Test;\nimport org.junit.jupiter.params.ParameterizedTest;\nimport org.junit.jupiter.params.provider.*;\n\nclass RowsTest {\n';
        const method = (annotations, name) => `    @ParameterizedTest\n${annotations.map(each => `    ${each}\n`).join('')}    void ${name}(int x) { }\n\n`;
        assert.strictEqual(java({
            'RowsTest.java': `${head}${method(['@MethodSource("rows")'], 'computed')}${method(['@ValueSource(ints = {})'], 'empty')}${method(['@ValueSource(ints = {1, 2})'], 'written')}${method([], 'none')}${method(['@EnumSource(Kind.class)'], 'kinds')}${method(['@EnumSource(value = Kind.class, names = {"A"})'], 'someKinds')}${method(['@NullSource'], 'oneNull')}${method(['@CsvSource({})'], 'noCsv')}${method(['@CsvSource({"a,b"})'], 'csv')}    @RepeatedTest(3)\n    void thrice() { }\n\n    @RepeatedTest(0)\n    void never() { }\n\n    @Test\n    void plain() { }\n}\n`,
        }, 'RowsTest.java'), '8+ computed:conditional empty:skipped written:runs none:skipped kinds:runs someKinds:conditional oneNull:runs noCsv:skipped csv:runs thrice:runs never:skipped plain:runs');
        // A runner named on a JUnit 4 class decides how often its tests run.
        assert.strictEqual(java({
            'TableTest.java': 'import org.junit.Test;\nimport org.junit.runner.RunWith;\nimport org.junit.runners.Parameterized;\n\n@RunWith(Parameterized.class)\npublic class TableTest {\n    @Test\n    public void row() { }\n}\n',
        }, 'TableTest.java'), '1+ row:conditional');
    });

    it('TestNG: enabled, invocationCount, a data provider, @Test on a class, @Ignore through a base', () => {
        const head = 'import org.testng.annotations.*;\n\n';
        assert.strictEqual(java({
            'PlainTest.java': `${head}public class PlainTest {\n    @Test\n    public void runs() { }\n\n    @Test(enabled = false)\n    public void off() { }\n\n    @Test(invocationCount = 3)\n    public void thrice() { }\n\n    @Test(invocationCount = 0)\n    public void never() { }\n\n    @Test(dataProvider = "rows")\n    public void rows(int x) { }\n\n    @Test(description = "plain", groups = "fast")\n    public void described() { }\n\n    @Test(dependsOnMethods = "runs")\n    public void after() { }\n\n    public void helper() { }\n}\n`,
        }, 'PlainTest.java'), '5+ runs:runs off:skipped thrice:runs never:skipped rows:conditional described:runs after:conditional');
        assert.strictEqual(java({
            'ClassLevelTest.java': `${head}@Test\npublic class ClassLevelTest {\n    public void every() { }\n\n    void hidden() { }\n\n    @BeforeMethod\n    public void prepare() { }\n}\n`,
        }, 'ClassLevelTest.java'), '1 every:runs');
        assert.strictEqual(java({
            'OffTest.java': `${head}@Test(enabled = false)\npublic class OffTest {\n    public void a() { }\n\n    @Test\n    public void b() { }\n}\n`,
        }, 'OffTest.java'), '1 b:runs');
        // On a class the mark makes the public methods of a deriving class tests too.
        assert.strictEqual(java({
            'TBase.java': `${head}@Test\npublic abstract class TBase {\n    public void fromBase() { }\n}\n`,
            'ChildTest.java': 'public class ChildTest extends TBase {\n    public void own() { }\n}\n',
        }, 'ChildTest.java'), '2 fromBase:runs:no-command own:runs:no-command');
        assert.strictEqual(java({
            'IgnoredBase.java': `${head}@Ignore\npublic abstract class IgnoredBase {\n    @Test\n    public void inherited() { }\n}\n`,
            'ChildTest.java': 'public class ChildTest extends IgnoredBase {\n}\n',
        }, 'ChildTest.java'), '0 inherited:skipped:no-command');
    });
});

describe('test units: C# rows, fixtures and overrides are read by each framework\'s own rule', () => {
    const stateOf = unit => unit.skipped ? 'skipped' : unit.conditional ? 'conditional' : 'runs';
    const PROJ = name => `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="${name}" Version="1.0.0" /></ItemGroup></Project>\n`;
    const cs = (framework, using, body, file = 'Tests.cs', more = {}) => {
        const found = answerFor({ 'App.Tests.csproj': PROJ(framework), [file]: `using ${using};\n\nnamespace P.Tests\n{\n${body}}\n`, ...more }, file);
        return `${found.facts.tests}${found.facts.moreTests ? '+' : ''} ${found.units.map(unit => `${unit.label}:${stateOf(unit)}${unit.selector ? '' : ':no-command'}`).join(' ')}`;
    };

    it('[Ignore] on a class holds for that class, not for one deriving from it', () => {
        const body = attribute => `    ${attribute}\n    public abstract class IgnoredBase\n    {\n        [Test]\n        public void Inherited() { }\n    }\n\n    public class Child : IgnoredBase { }\n`;
        assert.strictEqual(cs('NUnit', 'NUnit.Framework', body('[Ignore("base only")]')), '1 Child > Inherited:runs');
        assert.strictEqual(cs('NUnit', 'NUnit.Framework', body('').replace('public class Child', '[Ignore("here")]\n    public class Child')), '0 Child > Inherited:skipped');
        assert.strictEqual(cs('MSTest.TestFramework', 'Microsoft.VisualStudio.TestTools.UnitTesting',
            '    [TestClass]\n    [Ignore]\n    public abstract class IgnoredBase\n    {\n        [TestMethod]\n        public void Inherited() { }\n    }\n\n    [TestClass]\n    public class Child : IgnoredBase { }\n'),
        '1 Child > Inherited:runs');
    });

    it('MSTest wants the class that runs a test marked, not the one that declares it', () => {
        assert.strictEqual(cs('MSTest.TestFramework', 'Microsoft.VisualStudio.TestTools.UnitTesting',
            '    [TestClass]\n    public abstract class Base\n    {\n        [TestMethod]\n        public void Kept() { }\n    }\n\n    public class Unmarked : Base { }\n\n    [TestClass]\n    public class Marked : Base { }\n\n    public abstract class PlainBase\n    {\n        [TestMethod]\n        public void FromPlain() { }\n    }\n\n    [TestClass]\n    public class MarkedOverPlain : PlainBase { }\n\n    public class Bare\n    {\n        [TestMethod]\n        public void Own() { }\n    }\n'),
        '2 Marked > Kept:runs MarkedOverPlain > FromPlain:runs');
    });

    it('a method overridden without the attribute: xUnit runs it with the new body, NUnit and MSTest do not', () => {
        const body = (attribute, mark = '') => `    public abstract class Base\n    {\n        [${attribute}]\n        public virtual void Overridden() { }\n\n        [${attribute}]\n        public void Kept() { }\n    }\n\n    ${mark}public class Child : Base\n    {\n        public override void Overridden() { }\n    }\n`;
        assert.strictEqual(cs('xunit', 'Xunit', body('Fact')), '2 Child > Kept:runs Child > Overridden:runs');
        assert.strictEqual(cs('NUnit', 'NUnit.Framework', body('Test')), '1 Child > Kept:runs');
        assert.strictEqual(cs('MSTest.TestFramework', 'Microsoft.VisualStudio.TestTools.UnitTesting', body('TestMethod', '[TestClass]\n    ').replace('public abstract class Base', '[TestClass]\n    public abstract class Base')),
            '1 Child > Kept:runs');
    });

    it('what a method of a deriving class does to an inherited test of its name is each framework\'s rule', () => {
        const body = (attribute, mark = '') => `    ${mark}public abstract class Base\n    {\n        [${attribute}]\n        public virtual void Works() { }\n\n        [${attribute}]\n        public void Kept() { }\n    }\n\n    ${mark}public class Overloads : Base\n    {\n        public void Works(int ignored) { }\n    }\n\n    ${mark}public class Hides : Base\n    {\n        public new void Kept() { }\n    }\n\n    ${mark}public class Overrides : Base\n    {\n        public override void Works() { }\n    }\n`;
        // NUnit: only a declared override of the signature takes the test away.
        assert.strictEqual(cs('NUnit', 'NUnit.Framework', body('Test')),
            '5 Overloads > Kept:runs Overloads > Works:runs Hides > Kept:runs Hides > Works:runs Overrides > Kept:runs');
        // MSTest takes one method of each name: any method of the name hides the inherited test.
        assert.strictEqual(cs('MSTest.TestFramework', 'Microsoft.VisualStudio.TestTools.UnitTesting', body('TestMethod', '[TestClass]\n    ')),
            '3 Overloads > Kept:runs Hides > Works:runs Overrides > Kept:runs');
        // xUnit runs the test with the body of the override; a method of other parameters is not one.
        assert.strictEqual(cs('xunit', 'Xunit', '    public abstract class Base\n    {\n        [Fact]\n        public virtual void Works() { }\n    }\n\n    public class Overrides : Base\n    {\n        public override void Works() { }\n\n        public void Works(int ignored) { }\n    }\n'),
            '1 Overrides > Works:runs');
    });

    it('rows written out, rows left out by their own arguments, rows that are computed', () => {
        assert.strictEqual(cs('xunit', 'Xunit', '    public class RowTests\n    {\n        [Theory]\n        [InlineData(1, Skip = "off")]\n        public void AllSkipped(int x) { }\n\n        [Theory]\n        [InlineData(1, Skip = "off")]\n        [InlineData(2)]\n        public void SomeSkipped(int x) { }\n\n        [Theory]\n        [MemberData(nameof(Rows))]\n        public void Computed(int x) { }\n\n        [Fact]\n        public void Plain() { }\n    }\n'),
            '3+ RowTests > AllSkipped:skipped RowTests > SomeSkipped:runs RowTests > Computed:conditional RowTests > Plain:runs');
        assert.strictEqual(cs('NUnit', 'NUnit.Framework', '    public class RowTests\n    {\n        [Test]\n        public void Each([Values(1, 2)] int x) { }\n\n        [Test]\n        public void Ranged([Range(1, 3)] int x) { }\n\n        [Test]\n        public void Sourced([ValueSource(nameof(Rows))] int x) { }\n\n        [Test, Repeat(3)]\n        public void Thrice() { }\n\n        [TestCaseSource(nameof(Rows))]\n        public void Computed(int x) { }\n\n        [TestCase(1, Ignore = "off")]\n        [TestCase(2, Ignore = "off")]\n        public void AllIgnored(int x) { }\n\n        [TestCase(1, Explicit = true)]\n        public void ExplicitRow(int x) { }\n\n        [TestCase(1, IncludePlatform = "Win")]\n        public void OnePlatform(int x) { }\n\n        [TestCase(1, TestName = "named", ExpectedResult = 1)]\n        public int Named(int x) { return x; }\n\n        [Theory]\n        public void NoData(int x) { }\n    }\n'),
            '9+ RowTests > Each:runs RowTests > Ranged:runs RowTests > Sourced:conditional RowTests > Thrice:runs RowTests > Computed:conditional RowTests > AllIgnored:skipped RowTests > ExplicitRow:conditional RowTests > OnePlatform:conditional RowTests > Named:runs RowTests > NoData:conditional');
        assert.strictEqual(cs('MSTest.TestFramework', 'Microsoft.VisualStudio.TestTools.UnitTesting', '    [TestClass]\n    public class RowTests\n    {\n        [DataTestMethod]\n        public void NoRows(int x) { }\n\n        [TestMethod]\n        [DataRow(1)]\n        public void Rows(int x) { }\n\n        [DataTestMethod]\n        [DynamicData(nameof(Rows2))]\n        public void Dynamic(int x) { }\n    }\n'),
            '3+ RowTests > NoRows:conditional RowTests > Rows:runs RowTests > Dynamic:conditional');
    });

    it('an NUnit fixture built once for each set of arguments runs under names no filter by its class holds', () => {
        const dir = projectOf({
            'App.Tests.csproj': PROJ('NUnit'),
            'Tests.cs': 'using NUnit.Framework;\n\nnamespace P.Tests\n{\n    [TestFixture(1)]\n    [TestFixture(2)]\n    public class Twice\n    {\n        public Twice(int x) { }\n\n        [Test]\n        public void Runs() { }\n    }\n}\n',
            'Plain.cs': 'using NUnit.Framework;\n\nnamespace P.Tests\n{\n    [TestFixture]\n    public class Plain\n    {\n        [Test]\n        public void Runs() { }\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            const twice = rowsOf(index, 'Tests.cs');
            assert.deepStrictEqual([twice.facts.tests, !!twice.facts.moreTests, twice.facts.run || null, twice.facts.runWithheld],
                [1, true, null, 'generated-cases']);
            assert.strictEqual(twice.units.find(unit => unit.kind === 'test').selectorWithheld, 'generated-cases');
            const plain = rowsOf(index, 'Plain.cs');
            assert.deepStrictEqual([plain.facts.tests, !!plain.facts.moreTests, !!plain.facts.run], [1, false, true]);
        } finally {
            rm(dir);
        }
    });
});

describe('test units: a JavaScript declaration exists as often as its statement runs', () => {
    const stateOf = unit => unit.skipped ? 'skipped' : unit.conditional ? 'conditional' : 'runs';
    const node = source => {
        const found = answerFor({ ...NODE, 'test/a.test.js': `${NODE_HEAD}const never = process.env.X;\n${source}` }, 'test/a.test.js');
        return `${found.facts.tests}${found.facts.moreTests ? '+' : ''} ${found.units.map(unit => `${unit.label}:${stateOf(unit)}`).join(' ')}`;
    };
    const t = name => `test('${name}', () => {});`;

    it('a branch, a handler and the right side of a condition run only sometimes', () => {
        assert.strictEqual(node(`if (never) { ${t('a')} } else { ${t('b')} }\n${t('c')}\n`), '3 a:conditional b:conditional c:runs');
        assert.strictEqual(node(`never && ${t('a')}\nnever || ${t('b')}\nnever ?? ${t('c')}\nnever ? ${t('d').slice(0, -1)} : ${t('e')}\n`),
            '5 a:conditional b:conditional c:conditional d:conditional e:conditional');
        assert.strictEqual(node(`switch (never) {\n    case 'x': ${t('a')} break;\n    default: ${t('b')}\n}\n`), '2 a:conditional b:conditional');
        assert.strictEqual(node(`try { ${t('a')} } catch (e) { ${t('b')} } finally { ${t('c')} }\n{ ${t('d')} }\n`),
            '4 a:runs b:conditional c:runs d:runs');
    });

    it('a loop makes several tests of one declaration, or none', () => {
        // Over a list written out that holds something, the body runs.
        assert.strictEqual(node(`for (const n of [1, 2]) { ${t('a')} }\n${t('b')}\n`), '2+ a:runs b:runs');
        assert.strictEqual(node(`const rows = [1, 2];\nfor (const n of rows) { ${t('a')} }\nfor (const n of []) { ${t('b')} }\nfor (const n of never) { ${t('c')} }\nfor (const k in { a: 1 }) { ${t('d')} }\n`),
            '4+ a:runs b:conditional c:conditional d:conditional');
        assert.strictEqual(node(`for (let i = 0; i < 2; i++) { ${t('a')} }\nlet n = 0;\nwhile (n++ < 2) { ${t('b')} }\ndo { ${t('c')} } while (false);\n`),
            '3+ a:conditional b:conditional c:runs');
        // The tests of a suite declared in a loop.
        assert.strictEqual(node(`const { describe } = require('node:test');\nfor (const n of [1, 2]) {\n    describe('s', () => { ${t('a')} });\n}\n`), '1+ s > a:runs');
    });

    it('what stands after a statement that may leave its function runs only sometimes', () => {
        assert.strictEqual(node(`const { describe } = require('node:test');\ndescribe('s', () => {\n    ${t('a')}\n    if (never) return;\n    ${t('b')}\n});\n${t('c')}\n`),
            '3 s > a:runs s > b:conditional c:runs');
        assert.strictEqual(node(`${t('a')}\nif (never) throw new Error('x');\n${t('b')}\n`), '2 a:runs b:conditional');
        assert.strictEqual(node(`${t('a')}\nif (never) process.exit(0);\n${t('b')}\n`), '2 a:runs b:conditional');
        // A return inside a function written among the statements is that function's.
        assert.strictEqual(node(`const pick = () => { if (never) return 1; return 2; };\n${t('a')}\n`), '1 a:runs');
    });

    it('a table of cases is read where it is written out', () => {
        const jest = source => {
            const found = answerFor({ 'package.json': '{ "name": "x", "scripts": { "test": "jest" }, "devDependencies": { "jest": "*" } }\n', 'test/a.test.js': source }, 'test/a.test.js');
            return found.units.map(unit => `${unit.label}:${stateOf(unit)}`).join(' ');
        };
        assert.strictEqual(jest("const two = [1, 2];\nconst none = [];\nfunction rows() { return [1]; }\ntest.each([1, 2])('a %i', () => {});\ntest.each(two)('b %i', () => {});\ntest.each(rows())('c %i', () => {});\ntest.each`\n  n\n  ${1}\n`('d $n', () => {});\ntest.each([...two])('e %i', () => {});\ntest('plain', () => {});\n"),
            'a %i:runs b %i:runs c %i:conditional d $n:runs e %i:runs plain:runs');
        // jest refuses a file that gives a table no row: none of its tests runs for certain.
        assert.strictEqual(jest("test.each([])('a %i', () => {});\ntest('plain', () => {});\n"), 'a %i:skipped plain:conditional');
        assert.strictEqual(jest("const none = [];\ndescribe.each(none)('s %i', () => {\n    test('inside', () => {});\n});\ntest('plain', () => {});\n"),
            's %i > inside:skipped plain:conditional');
        const vitest = answerFor({
            'package.json': '{ "name": "x", "type": "module", "devDependencies": { "vitest": "*" } }\n',
            'test/a.test.js': "import { test } from 'vitest';\ntest.each([])('a %i', () => {});\ntest('plain', () => {});\n",
        }, 'test/a.test.js');
        assert.strictEqual(vitest.units.map(unit => `${unit.label}:${stateOf(unit)}`).join(' '), 'a %i:skipped plain:runs');
    });
});

describe('test units: a Rust attribute that is a macro rewrites the test', () => {
    it('what it makes is not read: the test runs only sometimes and the count is a lower bound', () => {
        const found = answerFor({
            'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n',
            'src/lib.rs': '#[cfg(test)]\nmod tests {\n    #[twice]\n    #[test]\n    fn doubled() {}\n\n    #[tokio::test]\n    async fn waits() {}\n\n    #[test]\n    #[should_panic]\n    fn plain() {}\n}\n',
        }, 'src/lib.rs');
        assert.deepStrictEqual([found.facts.tests, !!found.facts.moreTests], [3, true]);
        assert.deepStrictEqual(found.units.map(unit => `${unit.label}:${unit.conditional ? 'conditional' : 'runs'}`),
            ['tests > doubled:conditional', 'tests > waits:runs', 'tests > plain:runs']);
    });
});

describe('test units: the judge holds a weaker claim to what it says', () => {
    const unit = (line, more = {}) => ({
        id: `a.test.js::t${line}`, file: 'a.test.js', line, startLine: line, endLine: line,
        selector: null, conditional: false, skipped: false, inherited: false, ...more,
    });
    const file = (tests, more = false) => [{ file: 'a.test.js', role: 'tests', run: 'run a.test.js', tests, more }];
    const kinds = (testCase, answer, ran, counts) => judgeWholeRun(testCase, answer, ran, counts).problems.map(problem => problem.kind);

    it('a test that runs only sometimes is still one test: a body that runs twice is a count that is not exact', () => {
        const conditional = { units: [unit(3, { conditional: true })], files: file(1) };
        assert.deepStrictEqual(kinds({ sometimes: ['a.test.js::t3'] }, conditional, ['a.test.js:3'], { 'a.test.js:3': 2 }), ['INEXACT-COUNT', 'REPEATED']);
        assert.deepStrictEqual(kinds({ sometimes: ['a.test.js::t3'] }, conditional, ['a.test.js:3'], { 'a.test.js:3': 1 }), []);
        const several = { units: [unit(3, { conditional: true, generated: true })], files: file(1, true) };
        assert.deepStrictEqual(kinds({ sometimes: ['a.test.js::t3'], atLeast: ['a.test.js'] }, several, ['a.test.js:3'], { 'a.test.js:3': 2 }), []);
    });

    it('a case names a test only the order of a whole run executes by the mark as written', () => {
        const named = namedIdentities({
            files: { 'tests/test_a.py': 'def helper():\n    mark("tests/test_a.py::helper")\n' },
            onlyInWholeRun: ['tests/test_a.py::helper'],
        });
        assert.deepStrictEqual(named.onlyInWholeRun, ['tests/test_a.py:2']);
    });
});
