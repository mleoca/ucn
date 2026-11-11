/**
 * eval/test-unit-matrix-cases.js - tiny test projects, one runner each.
 *
 * Every test body records its own execution: it appends
 * `<file>::<suite > name>` (the engine's label for the unit) to the file
 * named by UCN_RAN. So the judge is the runner itself: what a whole-project
 * run executes is what a test is, and what a printed command executes is
 * what that command selects.
 *
 * Fields: `runner` (the runner that judges the case), `files`, and where
 * needed `judge: false` (nothing to run: the case pins an answer that
 * names no runner), `undeclared` (tests the runner executes that the
 * engine does not list: inherited, generated), `notRunByDefault` (units a
 * whole-project run leaves out and an explicit command runs), `moduleDirs`
 * (where a JavaScript case needs node_modules), `full` (the whole-project
 * command when it is not the runner's default).
 *
 * Two consumers share this data: eval/run-test-unit-matrix.js runs the
 * runners; test/test-units.test.js pins the engine's answer on every case
 * (eval/test-unit-matrix-answers.json) with no runner needed.
 */

'use strict';

const PY = 'import os\ndef mark(i):\n    open(os.environ["UCN_RAN"], "a").write(i + "\\n")\n';
const CJS = "const mark = id => require('fs').appendFileSync(process.env.UCN_RAN, id + '\\n');\n";
const ESM = "import { appendFileSync } from 'node:fs';\nconst mark = id => appendFileSync(process.env.UCN_RAN, id + '\\n');\n";
const GO = pkg => `package ${pkg}\n\nimport (\n\t"os"\n)\n\nfunc mark(id string) {\n\tf, _ := os.OpenFile(os.Getenv("UCN_RAN"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)\n\tf.WriteString(id + "\\n")\n\tf.Close()\n}\n`;
const RS = '#[allow(dead_code)]\npub fn mark(id: &str) {\n    use std::io::Write;\n    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(std::env::var("UCN_RAN").unwrap()).unwrap();\n    f.write_all(format!("{}\\n", id).as_bytes()).unwrap();\n}\n';
const CS = '    static class Rec { static readonly object Gate = new object(); public static void Mark(string id) { lock (Gate) { System.IO.File.AppendAllText(System.Environment.GetEnvironmentVariable("UCN_RAN"), id + "\\n"); } } }\n';
const JAVA = '    static void mark(String id) { try { java.nio.file.Files.writeString(java.nio.file.Path.of(System.getenv("UCN_RAN")), id + "\\n", java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND); } catch (Exception e) { throw new RuntimeException(e); } }\n';
const CARGO = name => `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n`;
const POM = `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.x</groupId><artifactId>m</artifactId><version>1</version>
  <properties><maven.compiler.source>17</maven.compiler.source><maven.compiler.target>17</maven.compiler.target><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>
  <dependencies>
DEPENDENCIES
  </dependencies>
  <build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.2.5</version></plugin></plugins></build>
</project>
`;
const JUPITER = '    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.10.2</version><scope>test</scope></dependency>';
const JUNIT4 = '    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency>';
const CSPROJ = packages => `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net9.0</TargetFramework><IsPackable>false</IsPackable><Nullable>disable</Nullable></PropertyGroup>
  <ItemGroup>
${packages.map(([name, version]) => `    <PackageReference Include="${name}" Version="${version}" />`).join('\n')}
  </ItemGroup>
</Project>
`;
const XUNIT = [['Microsoft.NET.Test.Sdk', '17.12.0'], ['xunit', '2.9.3'], ['xunit.runner.visualstudio', '3.1.5']];

const CASES = [
    // ------------------------------------------------------------------ pytest
    {
        id: 'pytest-what-is-collected', runner: 'pytest',
        files: {
            'pyproject.toml': '[tool.pytest.ini_options]\n',
            'tests/test_a.py': `${PY}import unittest
import pytest

def test_a():
    mark("tests/test_a.py::test_a")

def testb():
    mark("tests/test_a.py::testb")

def helper():
    mark("tests/test_a.py::helper")

def outer():
    def test_inner():
        mark("tests/test_a.py::test_inner")

if True:
    def test_cond():
        mark("tests/test_a.py::test_cond")

class TestX:
    def test_m(self):
        mark("tests/test_a.py::TestX > test_m")

    def helper(self):
        mark("tests/test_a.py::TestX > helper")

    @staticmethod
    def test_static():
        mark("tests/test_a.py::TestX > test_static")

    @classmethod
    def test_cls(cls):
        mark("tests/test_a.py::TestX > test_cls")

    class TestInner:
        def test_z(self):
            mark("tests/test_a.py::TestX > TestInner > test_z")

    class Inner:
        def test_no(self):
            mark("tests/test_a.py::TestX > Inner > test_no")

class TestWithInit:
    def __init__(self):
        pass

    def test_q(self):
        mark("tests/test_a.py::TestWithInit > test_q")

class MyTest:
    def test_notcollected(self):
        mark("tests/test_a.py::MyTest > test_notcollected")

class Foo(unittest.TestCase):
    def test_u(self):
        mark("tests/test_a.py::Foo > test_u")

    def check(self):
        mark("tests/test_a.py::Foo > check")

@pytest.mark.parametrize("v", [1, 2])
def test_p(v):
    mark("tests/test_a.py::test_p")

@pytest.fixture
def test_fixture_named():
    mark("tests/test_a.py::test_fixture_named")
`,
            'tests/helpers.py': `${PY}def make():\n    mark("tests/helpers.py::make")\n`,
            'tests/conftest.py': 'import pytest\n\n@pytest.fixture\ndef db():\n    return 1\n',
        },
    },
    {
        id: 'pytest-configured-names', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\npython_files = check_*.py\npython_functions = check_* verify\npython_classes = *Suite\n',
            'tests/check_a.py': `${PY}
def check_one():
    mark("tests/check_a.py::check_one")

def verify_two():
    mark("tests/check_a.py::verify_two")

def test_not():
    mark("tests/check_a.py::test_not")

class MathSuite:
    def check_three(self):
        mark("tests/check_a.py::MathSuite > check_three")

class TestOld:
    def check_four(self):
        mark("tests/check_a.py::TestOld > check_four")
`,
            'tests/test_plain.py': `${PY}\ndef check_five():\n    mark("tests/test_plain.py::check_five")\n`,
        },
        // An explicit path runs a file the configured names leave out.
        notRunByDefault: ['tests/test_plain.py::check_five'],
    },
    {
        id: 'pytest-toml-array-names', runner: 'pytest',
        files: {
            'pyproject.toml': '[project]\nname = "x"\n\n[tool.pytest.ini_options]\npython_functions = [\n    "spec_*",\n    "test_*",\n]\n\n[tool.other]\npython_functions = ["nope_*"]\n',
            'test_s.py': `${PY}\ndef spec_one():\n    mark("test_s.py::spec_one")\n\ndef test_two():\n    mark("test_s.py::test_two")\n\ndef nope_three():\n    mark("test_s.py::nope_three")\n`,
        },
    },
    {
        id: 'pytest-proved-by-conftest', runner: 'pytest',
        files: {
            'conftest.py': '',
            'tests/unit/test_b.py': `${PY}\ndef test_x():\n    mark("tests/unit/test_b.py::test_x")\n`,
        },
    },
    {
        id: 'pytest-proved-by-import', runner: 'pytest',
        files: {
            'test_c.py': `${PY}import pytest\n\ndef test_x():\n    mark("test_c.py::test_x")\n`,
        },
    },
    {
        id: 'pytest-proved-by-requirements', runner: 'pytest',
        files: {
            'requirements.txt': 'requests>=2\npytest>=7\n',
            'tests/test_r.py': `${PY}\ndef test_x():\n    mark("tests/test_r.py::test_x")\n`,
        },
    },
    {
        id: 'pytest-setup-cfg-and-tox', runner: 'pytest',
        files: {
            'setup.cfg': '[metadata]\nname = x\n\n[tool:pytest]\naddopts = -q\n',
            'tests/test_s.py': `${PY}\ndef test_x():\n    mark("tests/test_s.py::test_x")\n`,
        },
    },
    {
        id: 'pytest-nested-project', runner: 'pytest', cwd: 'services/api',
        files: {
            'services/api/tox.ini': '[tox]\nenvlist = py3\n\n[pytest]\naddopts = -q\n',
            'services/api/tests/test_c.py': `${PY}\ndef test_x():\n    mark("services/api/tests/test_c.py::test_x")\n\nclass TestK:\n    def test_y(self):\n        mark("services/api/tests/test_c.py::TestK > test_y")\n`,
        },
    },
    {
        id: 'pytest-inherited-tests', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/base.py': `${PY}import inspect

def ran(self, name):
    cls = type(self)
    mark(os.path.relpath(inspect.getfile(cls)).replace(os.sep, "/") + "::" + cls.__name__ + " > " + name)

class Checks:
    def test_shared(self):
        ran(self, "test_shared")

    def test_hidden(self):
        ran(self, "test_hidden")

class TestBase:
    def test_twice(self):
        ran(self, "test_twice")
`,
            'tests/test_child.py': `import unittest
from tests.base import Checks, TestBase, ran

class TestChild(Checks):
    def test_hidden(self):
        ran(self, "test_hidden")

class TestGrandChild(TestChild):
    def test_own(self):
        ran(self, "test_own")

class TestAgain(TestBase):
    pass

class Elsewhere(unittest.TestCase, Checks):
    pass
`,
            'tests/test_outside.py': `import collections

class TestOpen(collections.UserDict):
    pass
`,
            'tests/__init__.py': '',
        },
    },
    {
        id: 'pytest-classes-pytest-refuses', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/test_k.py': `${PY}
class Base:
    def __init__(self):
        self.ready = True

class TestWithInheritedInit(Base):
    def test_never(self):
        mark("tests/test_k.py::TestWithInheritedInit > test_never")

class TestSwitchedOff:
    __test__ = False

    def test_off(self):
        mark("tests/test_k.py::TestSwitchedOff > test_off")

class TestPlain:
    def test_on(self):
        mark("tests/test_k.py::TestPlain > test_on")

    @property
    def test_value(self):
        return 1
`,
        },
    },
    {
        id: 'pytest-base-from-outside-the-project', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/test_o.py': `${PY}import collections
import abc

class TestOnDict(collections.UserDict):
    def test_never(self):
        mark("tests/test_o.py::TestOnDict > test_never")

class TestOnAbc(abc.ABC):
    def test_runs(self):
        mark("tests/test_o.py::TestOnAbc > test_runs")
`,
        },
    },
    {
        id: 'python-no-runner-named', runner: 'pytest', judge: false,
        files: {
            'tests/test_u.py': 'import unittest\n\nclass T(unittest.TestCase):\n    def test_x(self):\n        pass\n',
            'tests/util.py': 'def make():\n    return 1\n',
        },
    },

    // --------------------------------------------------------------- node:test
    {
        id: 'node-test-script', runner: 'node-test',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/a.test.js': `${CJS}const { test, describe, it } = require('node:test');

test('top level', () => { mark('test/a.test.js::top level'); });

describe('math', () => {
    it('adds', () => { mark('test/a.test.js::math > adds'); });
    describe('deep', () => {
        it('adds', () => { mark('test/a.test.js::math > deep > adds'); });
    });
});

describe('text', () => {
    it('adds', () => { mark('test/a.test.js::text > adds'); });
    it('escapes (a+b) [x]?', () => { mark('test/a.test.js::text > escapes (a+b) [x]?'); });
    it("it's quoted", () => { mark("test/a.test.js::text > it's quoted"); });
});
`,
            'test/helpers.js': `${CJS}module.exports = { make() { return 1; } };\n`,
        },
    },
    {
        id: 'node-test-name-read-two-ways', runner: 'node-test',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/n.test.js': `${CJS}const { test, describe, it } = require('node:test');
test('adds', () => { mark('test/n.test.js::adds'); });
describe('math', () => {
    it('adds', () => { mark('test/n.test.js::math > adds'); });
    it('subtracts', () => { mark('test/n.test.js::math > subtracts'); });
});
describe('math adds', () => {
    it('x', () => { mark('test/n.test.js::math adds > x'); });
});
`,
        },
    },
    {
        id: 'node-test-script-loader', runner: 'node-test', full: 'npm test',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test --import ./setup.mjs --test-reporter spec" } }\n',
            'setup.mjs': 'globalThis.READY = true;\n',
            'test/b.test.js': `${CJS}const { test } = require('node:test');\ntest('needs setup', () => { if (!globalThis.READY) throw new Error('no setup'); mark('test/b.test.js::needs setup'); });\n`,
        },
    },
    {
        id: 'node-test-by-import-only', runner: 'node-test',
        files: {
            'test/c.test.js': `${CJS}const test = require('node:test');\ntest('alone', () => { mark('test/c.test.js::alone'); });\ntest.describe('group', () => {\n    test.it('inner', () => { mark('test/c.test.js::group > inner'); });\n});\n`,
        },
    },
    {
        id: 'node-test-typescript-by-script-option', runner: 'node-test', full: 'npm test',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --experimental-strip-types --test --test-reporter spec" } }\n',
            'test/typed.test.ts': `import { appendFileSync } from 'node:fs';
import { test, describe, it } from 'node:test';
const mark = (id: string): void => appendFileSync(process.env.UCN_RAN as string, id + '\\n');
test('typed top', () => { mark('test/typed.test.ts::typed top'); });
describe('typed group', () => {
    it('inner', () => { mark('test/typed.test.ts::typed group > inner'); });
});
`,
        },
    },
    {
        id: 'node-test-typescript-no-loader', runner: 'node-test', judge: false,
        files: {
            'test/d.test.ts': "import { test } from 'node:test';\ntest('typed', () => {});\n",
        },
    },
    {
        id: 'node-test-names-not-written', runner: 'node-test',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/e.test.js': `${CJS}const { test, describe, it } = require('node:test');
const name = 'computed';
test(name, () => { mark('test/e.test.js::(computed name)'); });
test(\`plain template\`, () => { mark('test/e.test.js::plain template'); });
for (const n of [1, 2]) {
    test(\`case \${n}\`, () => { mark('test/e.test.js::(computed name)'); });
}
function shared() {
    it('from helper', () => { mark('test/e.test.js::from helper'); });
}
describe('uses helper', () => { shared(); });
[1].forEach(() => {
    it('in callback', () => { mark('test/e.test.js::in callback'); });
});
`,
        },
    },

    // -------------------------------------------------------------------- jest
    {
        id: 'jest-script', runner: 'jest',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'src/sum.test.js': `${CJS}
describe('sum', () => {
    it('adds', () => { mark('src/sum.test.js::sum > adds'); });
    test('adds more', () => { mark('src/sum.test.js::sum > adds more'); });
    describe('edge', () => {
        it('adds', () => { mark('src/sum.test.js::sum > edge > adds'); });
        it('handles $ and ^ (really)', () => { mark('src/sum.test.js::sum > edge > handles $ and ^ (really)'); });
    });
});
describe('other', () => {
    it('adds', () => { mark('src/sum.test.js::other > adds'); });
});
it('bare', () => { mark('src/sum.test.js::bare'); });
it.each([[1], [2]])('row %i', () => { mark('src/sum.test.js::row %i'); });
`,
            '__tests__/helpers.js': 'module.exports = { make() { return 1; } };\n',
            'test/setup.js': 'module.exports = {};\n',
        },
        // Jest runs every file under __tests__ and rejects one without a test.
        full: 'npx jest src',
    },
    {
        id: 'jest-local-function-named-test', runner: 'jest',
        files: {
            'package.json': '{ "name": "x", "devDependencies": { "jest": "^29" } }\n',
            'src/t.test.js': `${CJS}
function test(input) { return input; }
describe('uses a local test()', () => {
    it('calls it', () => { test('not a title', () => {}); mark('src/t.test.js::uses a local test() > calls it'); });
});
`,
        },
    },
    {
        id: 'js-two-runners-declared', runner: 'jest', judge: false,
        files: {
            'package.json': '{ "name": "x", "devDependencies": { "jest": "^29", "vitest": "^3" } }\n',
            'src/a.test.js': "describe('a', () => { it('b', () => {}); });\n",
        },
    },
    {
        id: 'js-runner-not-modeled', runner: 'jest', judge: false,
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "ava" } }\n',
            'test/a.test.js': "const test = require('ava');\ntest('b', t => { t.pass(); });\n",
        },
    },

    {
        id: 'jest-path-that-names-two-files', runner: 'jest',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'src/sum.test.js': `${CJS}it('adds', () => { mark('src/sum.test.js::adds'); });\n`,
            'src/sum.test.jsx': `${CJS}it('adds', () => { mark('src/sum.test.jsx::adds'); });\n`,
            'src/checksum.test.js': `${CJS}it('adds', () => { mark('src/checksum.test.js::adds'); });\n`,
        },
    },

    // ------------------------------------------------------------------ vitest
    {
        id: 'vitest-dependency', runner: 'vitest',
        files: {
            'package.json': '{ "name": "x", "type": "module", "devDependencies": { "vitest": "^3" } }\n',
            'src/sum.test.ts': `${ESM}import { describe, it, test } from 'vitest';

describe('sum', () => {
    it('adds', () => { mark('src/sum.test.ts::sum > adds'); });
    describe('edge', () => {
        it('adds', () => { mark('src/sum.test.ts::sum > edge > adds'); });
    });
});
describe('other', () => {
    it('adds', () => { mark('src/sum.test.ts::other > adds'); });
    it.skipIf(false)('conditional', () => { mark('src/sum.test.ts::other > conditional'); });
});
test('bare (x)', () => { mark('src/sum.test.ts::bare (x)'); });
`,
        },
    },
    {
        id: 'vitest-import-beats-manifest', runner: 'vitest',
        files: {
            'package.json': '{ "name": "x", "type": "module", "devDependencies": { "jest": "^29", "vitest": "^3" } }\n',
            'src/v.test.js': `${ESM}import { it } from 'vitest';\nit('runs', () => { mark('src/v.test.js::runs'); });\n`,
        },
    },

    {
        id: 'vitest-path-that-names-two-files', runner: 'vitest',
        files: {
            'package.json': '{ "name": "x", "type": "module", "scripts": { "test": "vitest run" } }\n',
            'src/sum.test.js': `${ESM}import { it } from 'vitest';\nit('adds', () => { mark('src/sum.test.js::adds'); });\n`,
            'src/sum.test.jsx': `${ESM}import { it } from 'vitest';\nit('adds', () => { mark('src/sum.test.jsx::adds'); });\n`,
            'src/checksum.test.js': `${ESM}import { it } from 'vitest';\nit('adds', () => { mark('src/checksum.test.js::adds'); });\n`,
        },
    },

    // ------------------------------------------------------------------- mocha
    {
        id: 'mocha-script', runner: 'mocha',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha --recursive" } }\n',
            'test/a.test.js': `${CJS}
describe('queue', function () {
    it('pushes', function () { mark('test/a.test.js::queue > pushes'); });
    context('when empty', function () {
        specify('pops nothing', function () { mark('test/a.test.js::queue > when empty > pops nothing'); });
        it('pushes', function () { mark('test/a.test.js::queue > when empty > pushes'); });
    });
});
describe('stack', function () {
    it('pushes', function () { mark('test/a.test.js::stack > pushes'); });
});
`,
            'test/support/build.js': 'module.exports = { make() { return 1; } };\n',
        },
    },

    {
        id: 'mocha-shared-behaviour', runner: 'mocha',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha --recursive" } }\n',
            'test/shared.js': `${CJS}
module.exports = function behavesLikeAQueue(name) {
    it('pushes', function () { mark('test/shared.js::pushes'); });
};
`,
            'test/fifo.test.js': `const behavesLikeAQueue = require('./shared');
describe('fifo', function () {
    behavesLikeAQueue('fifo');
});
`,
        },
    },

    // ---------------------------------------------------------------------- go
    {
        id: 'go-what-is-a-test', runner: 'go-test',
        files: {
            'go.mod': 'module example.com/m\n\ngo 1.21\n',
            'mark_test.go': GO('m'),
            'a_test.go': `package m

import (
	"fmt"
	"testing"
)

func TestA(t *testing.T) {
	mark("a_test.go::TestA")
	t.Run("sub", func(t *testing.T) {})
}
func Test_b(t *testing.T) { mark("a_test.go::Test_b") }
func Test(t *testing.T)   { mark("a_test.go::Test") }
func Test1(t *testing.T)  { mark("a_test.go::Test1") }
func TestMain(m *testing.M) { m.Run() }
func BenchmarkX(b *testing.B) { mark("a_test.go::BenchmarkX") }
func FuzzY(f *testing.F) { mark("a_test.go::FuzzY") }
func Example_silent() { mark("a_test.go::Example_silent") }
func ExampleAdd() {
	mark("a_test.go::ExampleAdd")
	fmt.Println("hi")
	// Output: hi
}

type S struct{}

func (s *S) TestMethod(t *testing.T) { mark("a_test.go::TestMethod") }
func helper()                        { mark("a_test.go::helper") }
`,
            'util.go': 'package m\n\nfunc Add(a, b int) int { return a + b }\n',
        },
    },
    {
        id: 'go-nested-module-and-packages', runner: 'go-test', cwd: 'svc',
        files: {
            'svc/go.mod': 'module example.com/svc\n\ngo 1.21\n',
            'svc/a/mark_test.go': GO('a'),
            'svc/a/a_test.go': 'package a\n\nimport "testing"\n\nfunc TestSame(t *testing.T) { mark("svc/a/a_test.go::TestSame") }\n',
            'svc/b/mark_test.go': GO('b'),
            'svc/b/b_test.go': 'package b\n\nimport "testing"\n\nfunc TestSame(t *testing.T) { mark("svc/b/b_test.go::TestSame") }\nfunc TestSameMore(t *testing.T) { mark("svc/b/b_test.go::TestSameMore") }\n',
        },
    },
    {
        id: 'go-build-constraint', runner: 'go-test',
        files: {
            'go.mod': 'module example.com/m\n\ngo 1.21\n',
            'mark_test.go': GO('m'),
            'a_test.go': 'package m\n\nimport "testing"\n\nfunc TestAlways(t *testing.T) { mark("a_test.go::TestAlways") }\n',
            'slow_test.go': '//go:build integration\n\npackage m\n\nimport "testing"\n\nfunc TestSlow(t *testing.T) { mark("slow_test.go::TestSlow") }\n',
        },
    },

    {
        id: 'go-platform-file-and-external-package', runner: 'go-test',
        files: {
            'go.mod': 'module example.com/m\n\ngo 1.21\n',
            'util.go': 'package m\n\nfunc Add(a, b int) int { return a + b }\n',
            'mark_test.go': GO('m_test'),
            'ext_test.go': 'package m_test\n\nimport "testing"\n\nfunc TestOutside(t *testing.T) { mark("ext_test.go::TestOutside") }\n',
            'only_plan9_test.go': 'package m_test\n\nimport "testing"\n\nfunc TestElsewhere(t *testing.T) { mark("only_plan9_test.go::TestElsewhere") }\n',
        },
    },

    // ------------------------------------------------------------------- cargo
    {
        id: 'cargo-library', runner: 'cargo-test',
        files: {
            'Cargo.toml': CARGO('case_library'),
            'src/lib.rs': `${RS}pub mod util;

pub fn add(a: i32, b: i32) -> i32 { a + b }

#[cfg(test)]
mod tests {
    use super::*;

    fn helper() {}

    #[test]
    fn adds() { helper(); mark("src/lib.rs::tests > adds"); }

    #[test]
    #[ignore]
    fn slow() { mark("src/lib.rs::tests > slow"); }

    mod inner {
        #[test]
        fn adds() { crate::mark("src/lib.rs::tests > inner > adds"); }
    }
}

#[test]
fn at_root() { mark("src/lib.rs::at_root"); }
`,
            'src/util.rs': `pub fn twice(a: i32) -> i32 { a * 2 }

#[cfg(test)]
mod tests {
    #[test]
    fn adds() { crate::mark("src/util.rs::tests > adds"); }
    #[test]
    fn adds_more() { crate::mark("src/util.rs::tests > adds_more"); }
}
`,
        },
        notRunByDefault: ['src/lib.rs::tests > slow'],
    },
    {
        id: 'cargo-integration-tests', runner: 'cargo-test',
        files: {
            'Cargo.toml': CARGO('case_integration'),
            'src/lib.rs': 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n',
            'tests/api.rs': `${RS}mod common;

#[test]
fn adds() { common::setup(); mark("tests/api.rs::adds"); }

mod more {
    #[test]
    fn adds() { super::mark("tests/api.rs::more > adds"); }
}
`,
            'tests/common/mod.rs': 'pub fn setup() {}\n',
            'tests/suite/main.rs': `${RS}mod part;

#[test]
fn whole() { mark("tests/suite/main.rs::whole"); }
`,
            'tests/suite/part.rs': '#[test]\nfn piece() { crate::mark("tests/suite/part.rs::piece"); }\n',
        },
    },
    {
        id: 'cargo-binary-and-library', runner: 'cargo-test',
        files: {
            'Cargo.toml': CARGO('case_binlib'),
            'src/lib.rs': `${RS}pub mod shared;\n`,
            'src/shared.rs': '#[cfg(test)]\nmod tests {\n    #[test]\n    fn in_lib() { crate::mark("src/shared.rs::tests > in_lib"); }\n}\n',
            'src/main.rs': `mod cli;

fn main() {}

#[cfg(test)]
mod tests {
    #[test]
    fn in_bin() { case_binlib::mark("src/main.rs::tests > in_bin"); }
}
`,
            'src/cli.rs': '#[cfg(test)]\nmod tests {\n    #[test]\n    fn in_bin_module() { case_binlib::mark("src/cli.rs::tests > in_bin_module"); }\n}\n',
        },
    },
    {
        id: 'cargo-workspace-member', runner: 'cargo-test',
        files: {
            'Cargo.toml': '[workspace]\nmembers = ["crates/one"]\nresolver = "2"\n',
            'crates/one/Cargo.toml': CARGO('case_member'),
            'crates/one/src/lib.rs': `${RS}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn member() { mark("crates/one/src/lib.rs::tests > member"); }
}
`,
        },
    },
    {
        id: 'cargo-feature-gated', runner: 'cargo-test',
        files: {
            'Cargo.toml': `${CARGO('case_gated')}\n[features]\nextra = []\n`,
            'src/lib.rs': `${RS}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn always() { mark("src/lib.rs::tests > always"); }

    #[cfg(feature = "extra")]
    #[test]
    fn gated() { mark("src/lib.rs::tests > gated"); }
}

#[cfg(feature = "extra")]
mod extra {
    #[test]
    fn gated_module() { crate::mark("src/lib.rs::extra > gated_module"); }
}
`,
        },
    },
    {
        id: 'cargo-custom-targets', runner: 'cargo-test',
        files: {
            'Cargo.toml': `${CARGO('case_custom')}\n[lib]\npath = "source/entry.rs"\n`,
            'source/entry.rs': `${RS}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn moved() { mark("source/entry.rs::tests > moved"); }
}
`,
        },
    },

    // ------------------------------------------------------------------ dotnet
    {
        id: 'dotnet-xunit', runner: 'dotnet-test',
        files: {
            'App.Tests.csproj': CSPROJ(XUNIT),
            'FooTests.cs': `using Xunit;

namespace My.App.Tests
{
${CS}
    public class FooTests
    {
        [Fact]
        public void Adds() { Rec.Mark("FooTests.cs::FooTests > Adds"); }

        [Theory]
        [InlineData(1)]
        [InlineData(2)]
        public void Rows(int x) { Rec.Mark("FooTests.cs::FooTests > Rows"); }

        public void Helper() { Rec.Mark("FooTests.cs::FooTests > Helper"); }

        public class Inner
        {
            [Fact]
            public void Adds() { Rec.Mark("FooTests.cs::FooTests > Inner > Adds"); }
        }
    }

    public class FooTestsMore
    {
        [Fact]
        public void Adds() { Rec.Mark("FooTests.cs::FooTestsMore > Adds"); }
    }

    public abstract class Shared
    {
        [Fact]
        public void Inherited() { Rec.Mark("FooTests.cs::" + GetType().Name + " > Inherited"); }
    }

    public class Concrete : Shared { }
}
`,
            'Builders.cs': 'namespace My.App.Tests\n{\n    public static class Builders { public static int Make() { return 1; } }\n}\n',
        },
    },

    {
        id: 'dotnet-file-scoped-namespace', runner: 'dotnet-test',
        files: {
            'App.Tests.csproj': CSPROJ(XUNIT),
            'DeepTests.cs': `using Xunit;

namespace Deep.Space;

static class Rec { static readonly object Gate = new object(); public static void Mark(string id) { lock (Gate) { System.IO.File.AppendAllText(System.Environment.GetEnvironmentVariable("UCN_RAN"), id + "\\n"); } } }

public class DeepTests
{
    [Fact]
    public void Lands() { Rec.Mark("DeepTests.cs::DeepTests > Lands"); }
}
`,
        },
    },
    {
        id: 'dotnet-mstest', runner: 'dotnet-test',
        files: {
            'App.Tests.csproj': CSPROJ([['Microsoft.NET.Test.Sdk', '17.12.0'], ['MSTest.TestAdapter', '1.2.1'], ['MSTest.TestFramework', '1.2.1']]),
            'CalcTests.cs': `using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Calc.Tests
{
${CS}
    [TestClass]
    public class CalcTests
    {
        [TestMethod]
        public void Adds() { Rec.Mark("CalcTests.cs::CalcTests > Adds"); }

        [DataTestMethod]
        [DataRow(1)]
        [DataRow(2)]
        public void Rows(int x) { Rec.Mark("CalcTests.cs::CalcTests > Rows"); }

        public void Helper() { }
    }
}
`,
        },
    },

    {
        id: 'dotnet-nunit', runner: 'dotnet-test',
        files: {
            'App.Tests.csproj': CSPROJ([['Microsoft.NET.Test.Sdk', '17.12.0'], ['NUnit', '3.12.0'], ['NUnit3TestAdapter', '4.6.0']]),
            'QueueTests.cs': `using NUnit.Framework;

namespace Queue.Tests
{
${CS}
    [TestFixture]
    public class QueueTests
    {
        [Test]
        public void Pushes() { Rec.Mark("QueueTests.cs::QueueTests > Pushes"); }

        [TestCase(1)]
        [TestCase(2)]
        public void Rows(int x) { Rec.Mark("QueueTests.cs::QueueTests > Rows"); }

        [Test]
        public void PushesMore() { Rec.Mark("QueueTests.cs::QueueTests > PushesMore"); }
    }
}
`,
        },
    },

    // ------------------------------------------------------------------- maven
    {
        id: 'maven-junit5', runner: 'maven',
        files: {
            'pom.xml': POM.replace('DEPENDENCIES', JUPITER),
            'src/test/java/com/x/FooTest.java': `package com.x;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class FooTest {
${JAVA}
    @BeforeEach
    void setUp() {}

    @Test
    void adds() { mark("src/test/java/com/x/FooTest.java::FooTest > adds"); }

    @ParameterizedTest
    @ValueSource(ints = {1, 2})
    void rows(int x) { mark("src/test/java/com/x/FooTest.java::FooTest > rows"); }

    void helper() { mark("src/test/java/com/x/FooTest.java::FooTest > helper"); }

    @Nested
    class Inner {
        @Test
        void adds() { mark("src/test/java/com/x/FooTest.java::FooTest > Inner > adds"); }
    }
}
`,
            'src/test/java/com/x/OtherTest.java': `package com.x;

import org.junit.jupiter.api.Test;

class OtherTest {
    @Test
    void adds() { FooTest.mark("src/test/java/com/x/OtherTest.java::OtherTest > adds"); }
}
`,
            'src/test/java/com/x/Fixtures.java': 'package com.x;\n\nclass Fixtures {\n    static int make() { return 1; }\n}\n',
        },
    },
    {
        id: 'maven-junit4-and-inherited', runner: 'maven',
        files: {
            'pom.xml': POM.replace('DEPENDENCIES', JUNIT4),
            'src/test/java/com/x/BaseChecks.java': `package com.x;

import org.junit.Test;

public abstract class BaseChecks {
${JAVA}
    @Test
    public void shared() { String c = getClass().getSimpleName(); mark("src/test/java/com/x/" + c + ".java::" + c + " > shared"); }
}
`,
            'src/test/java/com/x/ChildTest.java': `package com.x;

import org.junit.Test;

public class ChildTest extends BaseChecks {
    @Test
    public void own() { mark("src/test/java/com/x/ChildTest.java::ChildTest > own"); }
}
`,
            'src/test/java/com/x/OnlyInheritsTest.java': 'package com.x;\n\npublic class OnlyInheritsTest extends BaseChecks {\n}\n',
        },
    },
    {
        id: 'maven-nested-classes', runner: 'maven',
        files: {
            'pom.xml': POM.replace('DEPENDENCIES', JUPITER),
            'src/test/java/com/x/OuterTest.java': `package com.x;

import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

class OuterTest {
${JAVA}
    @Test
    void top() { mark("src/test/java/com/x/OuterTest.java::OuterTest > top"); }

    static class Plain {
        @Test
        void inStatic() { mark("src/test/java/com/x/OuterTest.java::OuterTest > Plain > inStatic"); }
    }

    @Nested
    class Deep {
        @Nested
        class Deeper {
            @Test
            void bottom() { mark("src/test/java/com/x/OuterTest.java::OuterTest > Deep > Deeper > bottom"); }
        }
    }
}
`,
        },
    },
    {
        id: 'java-gradle-not-modeled', runner: 'maven', judge: false,
        files: {
            'build.gradle': "plugins { id 'java' }\n",
            'src/test/java/com/x/FooTest.java': 'package com.x;\n\nimport org.junit.jupiter.api.Test;\n\nclass FooTest {\n    @Test\n    void adds() {}\n}\n',
        },
    },
];

module.exports = { CASES };
