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
    createTestModel, selectorText, unitLabel, linkFile, commandsFor,
    scriptRunners, nodeTestOptions, configWords, tableText,
} = require('../core/test-units');
const { CASES } = require('../eval/test-unit-matrix-cases');
const { answerOf } = require('../eval/run-test-unit-matrix');
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
                const runs = model.runsAt(base, 5);
                assert.deepStrictEqual(runs.map(run => `${index.files.get(run.filePath).relativePath}::${unitLabel(run.unit)}`),
                    ['tests/test_child.py::TestChild > test_shared']);
                const linked = linkFile(model, index, base, [5]);
                assert.strictEqual(linked.role, 'support');
                assert.strictEqual(linked.tests, 1);
                assert.strictEqual(linked.units[0].file, 'tests/test_child.py');
                assert.strictEqual(selectorText(linked.units[0].selector), 'pytest tests/test_child.py::TestChild::test_shared');
                assert.strictEqual(linkFile(model, index, base, [8]).tests, 0, 'a helper of a class nothing collects is file-level support code');
            } finally {
                index._endOp();
            }
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
