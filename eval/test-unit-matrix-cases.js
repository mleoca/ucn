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
 * command when it is not the runner's default), `sometimes` (units the
 * engine calls conditional: each must be meant), `emptyTestFiles` (files
 * the engine calls test files, with a command, from which nothing runs),
 * `repeats` (bodies that execute more often than the tests listed for
 * them: a table of cases), `atLeast` (files whose count the engine gives
 * as a lower bound: every file from which the runner executes something
 * the engine does not list has to be one), `onlyInWholeRun` (tests a
 * whole run executes because of the order files are loaded in, which the
 * file's own command cannot run: the engine has to call them
 * conditional). `undeclared`, `repeats` and `onlyInWholeRun` name a mark
 * as it is written (`<file>::<label>`), a line (`<file>:<line>`) or a
 * run-time label.
 *
 * Two consumers share this data: eval/run-test-unit-matrix.js runs the
 * runners; test/test-units.test.js pins the engine's answer on every case
 * (eval/test-unit-matrix-answers.json) with no runner needed.
 */

'use strict';

const PY = 'import os\ndef mark(i):\n    open(os.environ["UCN_RAN"], "a").write(i + "\\n")\n';
// The identity of the pytest test that is running: `<file>::<suite > name>`.
const RID = 'def rid():\n    n = os.environ["PYTEST_CURRENT_TEST"].split(" ")[0].split("::")\n    return n[0] + "::" + " > ".join(n[1:])\n';
// The same for a test that runs once for each row of a table: the row is not part of the identity.
const RIDP = 'def rid():\n    n = os.environ["PYTEST_CURRENT_TEST"].split(" ")[0].split("::")\n    n[-1] = n[-1].split("[")[0]\n    return n[0] + "::" + " > ".join(n[1:])\n';
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
const TESTNG = '    <dependency><groupId>org.testng</groupId><artifactId>testng</artifactId><version>7.10.2</version><scope>test</scope></dependency>';
const CSPROJ = packages => `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net9.0</TargetFramework><IsPackable>false</IsPackable><Nullable>disable</Nullable></PropertyGroup>
  <ItemGroup>
${packages.map(([name, version]) => `    <PackageReference Include="${name}" Version="${version}" />`).join('\n')}
  </ItemGroup>
</Project>
`;
const XUNIT = [['Microsoft.NET.Test.Sdk', '17.12.0'], ['xunit', '2.9.3'], ['xunit.runner.visualstudio', '3.1.5']];
const NUNIT = [['Microsoft.NET.Test.Sdk', '17.12.0'], ['NUnit', '3.12.0'], ['NUnit3TestAdapter', '4.6.0']];
const MSTEST = [['Microsoft.NET.Test.Sdk', '17.12.0'], ['MSTest.TestAdapter', '1.2.1'], ['MSTest.TestFramework', '1.2.1']];

const CASES = [
    // ------------------------------------------------------------------ pytest
    {
        id: 'pytest-what-is-collected', runner: 'pytest',
        // Counts given as lower bounds.
        atLeast: ['tests/test_a.py'],
        // A definition inside a branch exists only where the branch runs.
        sometimes: ['tests/test_a.py::test_cond'],
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
        // A module the configured names leave out is not collected: it
        // declares no test.
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
        // Counts given as lower bounds.
        atLeast: ['tests/test_outside.py'],
        emptyTestFiles: ['tests/test_outside.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/base.py': `${PY}import inspect

def ran(self, name):
    # The test pytest is running: a class runs where it is collected.
    n = os.environ["PYTEST_CURRENT_TEST"].split(" ")[0].split("::")
    mark(n[0] + "::" + " > ".join(n[1:]))

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
        // Counts given as lower bounds.
        atLeast: ['tests/test_o.py'],
        sometimes: ['tests/test_o.py::TestOnDict > test_never'],
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
        id: 'pytest-what-is-not-collected', runner: 'pytest',
        // Counts given as lower bounds.
        atLeast: ['tests/test_switch_elsewhere.py'],
        sometimes: ['tests/test_switch_elsewhere.py::test_decorated_off', 'tests/test_switch_elsewhere.py::test_plain'],
        emptyTestFiles: ['tests/test_marked.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/test_forms.py': `${PY}import pytest
import unittest
from unittest import TestCase as Base

def test_twice():
    mark("tests/test_forms.py::test_twice first")

def test_twice():
    mark("tests/test_forms.py::test_twice last")

def test_switched():
    mark("tests/test_forms.py::test_switched")

test_switched.__test__ = False

@pytest.mark.skip(reason="not now")
def test_skip_marked():
    mark("tests/test_forms.py::test_skip_marked")

class TestNew:
    def __new__(cls):
        return object.__new__(cls)

    def test_in_new(self):
        mark("tests/test_forms.py::TestNew > test_in_new")

class HasNew:
    def __new__(cls):
        return object.__new__(cls)

class TestInheritsNew(HasNew):
    def test_inherits_new(self):
        mark("tests/test_forms.py::TestInheritsNew > test_inherits_new")

class Aliased(Base):
    def test_alias_base(self):
        mark("tests/test_forms.py::Aliased > test_alias_base")

class TestTwiceInClass:
    def test_m(self):
        mark("tests/test_forms.py::TestTwiceInClass > test_m first")

    def test_m(self):
        mark("tests/test_forms.py::TestTwiceInClass > test_m last")

class TestOn:
    __test__ = True

    def test_on(self):
        mark("tests/test_forms.py::TestOn > test_on")

class TestSwitchedLater:
    def test_late(self):
        mark("tests/test_forms.py::TestSwitchedLater > test_late")

TestSwitchedLater.__test__ = False
`,
            'tests/test_marked.py': `${PY}import pytest

pytestmark = pytest.mark.skip(reason="whole module")

def test_under_module_mark():
    mark("tests/test_marked.py::test_under_module_mark")
`,
            'tests/test_module_off.py': `${PY}__test__ = False

def test_hidden():
    mark("tests/test_module_off.py::test_hidden")

class TestHidden:
    __test__ = True

    def test_inner(self):
        mark("tests/test_module_off.py::TestHidden > test_inner")
`,
            'tests/test_switch_elsewhere.py': `${PY}
def nottest(function):
    function.__test__ = False
    return function

@nottest
def test_decorated_off():
    mark("tests/test_switch_elsewhere.py::test_decorated_off")

def test_plain():
    mark("tests/test_switch_elsewhere.py::test_plain")
`,
        },
    },
    {
        id: 'pytest-method-resolution-order', runner: 'pytest',
        // Counts given as lower bounds.
        atLeast: ['tests/test_leaf.py'],
        // A class behind a base that is not read runs the same bodies (named below).
        repeats: ['tests/base.py::the only body', 'tests/base.py::the body in Right'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/base.py': `${PY}import inspect

def ran(self, name):
    cls = type(self)
    mark(os.path.relpath(inspect.getfile(cls)).replace(os.sep, "/") + "::" + cls.__name__ + " > " + name)

class Root:
    def test_shared(self):
        ran(self, "test_shared")
        mark("tests/base.py::the body in Root")

    def test_root_only(self):
        ran(self, "test_root_only")
        mark("tests/base.py::the only body")

class Left(Root):
    pass

class Right(Root):
    def test_shared(self):
        ran(self, "test_shared")
        mark("tests/base.py::the body in Right")
`,
            'tests/test_leaf.py': `import contextlib
import unittest
from unittest import TestCase
from tests.base import Left, Right, Root, ran
from tests.base import Right as Other

class KnownByName(TestCase, Other):
    pass

class TestLeaf(Left, Right):
    pass

class Known(unittest.TestCase, Right):
    pass

class TestBehindUnknown(contextlib.AbstractContextManager, Right):
    def __exit__(self, *args):
        return None
`,
        },
        // A base the project does not declare stands before the class that
        // declares the tests: which body runs is not settled, so the
        // engine lists none of them.
        undeclared: [
            'tests/test_leaf.py::TestBehindUnknown > test_root_only',
            'tests/test_leaf.py::TestBehindUnknown > test_shared',
        ],
    },
    {
        id: 'pytest-switches-and-marks-are-syntax', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/test_text.py': `${PY}
DOC = """
__test__ = False
pytestmark = pytest.mark.skip
"""
# __test__ = False

def test_under_a_string():
    mark("tests/test_text.py::test_under_a_string")
`,
            'tests/test_reset.py': `${PY}__test__ = False
__test__ = True

def test_switched_back_on():
    mark("tests/test_reset.py::test_switched_back_on")

class TestReset:
    __test__ = False
    __test__ = True

    def test_in_class(self):
        mark("tests/test_reset.py::TestReset > test_in_class")

def test_named_reset():
    mark("tests/test_reset.py::test_named_reset")

test_named_reset.__test__ = False
test_named_reset.__test__ = True
`,
            'tests/test_warning.py': `${PY}import pytest

pytestmark = pytest.mark.filterwarnings("ignore:skip")

def test_under_a_filter():
    mark("tests/test_warning.py::test_under_a_filter")

class TestFiltered:
    pytestmark = [pytest.mark.filterwarnings("ignore:skip")]

    def test_in_class(self):
        mark("tests/test_warning.py::TestFiltered > test_in_class")
`,
            'tests/test_listed_marks.py': `${PY}import pytest

pytestmark = [pytest.mark.filterwarnings("ignore"), pytest.mark.skip(reason="whole module")]

def test_under_a_list():
    mark("tests/test_listed_marks.py::test_under_a_list")
`,
            'tests/test_branch.py': `${PY}
if os.environ.get("UCN_NO_SUCH_SETTING"):
    __test__ = False

def test_under_a_branch():
    mark("tests/test_branch.py::test_under_a_branch")
`,
            'tests/test_decorators.py': `${PY}import unittest
from unittest import skip as leave_out

def skip(function):
    return function

@skip
def test_own_decorator_named_skip():
    mark("tests/test_decorators.py::test_own_decorator_named_skip")

@leave_out("not now")
def test_unittest_skip_renamed():
    mark("tests/test_decorators.py::test_unittest_skip_renamed")

@unittest.skipIf(False, "never true")
def test_skip_if():
    mark("tests/test_decorators.py::test_skip_if")

@unittest.skip("whole class")
class TestOffByDecorator(unittest.TestCase):
    def test_in_skipped_class(self):
        mark("tests/test_decorators.py::TestOffByDecorator > test_in_skipped_class")
`,
            'tests/test_annotated.py': `${PY}__test__: bool = False

def test_under_an_annotated_switch():
    mark("tests/test_annotated.py::test_under_an_annotated_switch")
`,
        },
        sometimes: [
            'tests/test_branch.py::test_under_a_branch',
            'tests/test_decorators.py::test_own_decorator_named_skip',
            'tests/test_decorators.py::test_skip_if',
        ],
        emptyTestFiles: ['tests/test_listed_marks.py'],
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
        // Counts given as lower bounds.
        atLeast: ['test/helpers.js'],
        // node looks for every file under test/: a helper there is run as a test of its own.
        emptyTestFiles: ['test/helpers.js'],
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
        id: 'node-test-runner-under-other-names', runner: 'node-test', full: 'node --test test/names.js',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/names.js': `${CJS}const { test: caseIt, describe: group } = require('node:test');
const runner = require('node:test');
caseIt('aliased', () => { mark('test/names.js::aliased'); });
group('grouped', () => {
    caseIt('inner', () => { mark('test/names.js::grouped > inner'); });
});
runner.test('namespaced', () => { mark('test/names.js::namespaced'); });
runner.describe('ns', () => {
    runner.it('deep', () => { mark('test/names.js::ns > deep'); });
});
const again = caseIt;
again('local alias', () => { mark('test/names.js::local alias'); });
const { it: spec } = runner;
spec('from the namespace', () => { mark('test/names.js::from the namespace'); });
const member = runner.test;
member('member alias', () => { mark('test/names.js::member alias'); });
const direct = require('node:test').test;
direct('required member', () => { mark('test/names.js::required member'); });
`,
        },
    },
    {
        id: 'node-test-esm-bindings', runner: 'node-test', full: 'node --test test/esm.mjs',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/esm.mjs': `${ESM}import { test as caseIt } from 'node:test';
import * as runner from 'node:test';
import nodeTest from 'node:test';
caseIt('aliased', () => { mark('test/esm.mjs::aliased'); });
runner.describe('ns', () => {
    runner.it('deep', () => { mark('test/esm.mjs::ns > deep'); });
});
nodeTest('default import', () => { mark('test/esm.mjs::default import'); });
nodeTest.describe('on default', () => {
    nodeTest.it('member', () => { mark('test/esm.mjs::on default > member'); });
});
`,
        },
    },
    {
        id: 'node-test-binding-not-followed', runner: 'node-test', full: 'node --test test/computed.js',
        // Counts given as lower bounds.
        atLeast: ['test/computed.js', 'test/hooks-only.js'],
        emptyTestFiles: ['test/hooks-only.js'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/computed.js': `${CJS}const runner = require('node:test');
const pick = runner[process.env.UCN_NO_SUCH_NAME || 'test'];
pick('picked at run time', () => { mark('test/computed.js::picked at run time'); });
`,
            'test/hooks-only.js': "const { beforeEach } = require('node:test');\nmodule.exports = { install() { beforeEach(() => {}); } };\n",
        },
        // The declaring function is chosen at run time: the file is a test
        // file with a command, and its one test is not listed.
        undeclared: ['test/computed.js:4'],
    },
    {
        id: 'node-test-same-name-twice', runner: 'node-test',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/twice.test.js': `${CJS}const { test, describe, it } = require('node:test');
test('same', () => { mark('test/twice.test.js::same first'); });
test('same', () => { mark('test/twice.test.js::same second'); });
test('alone', () => { mark('test/twice.test.js::alone'); });
describe('group', () => {
    it('inside', () => { mark('test/twice.test.js::group > inside first'); });
});
describe('group', () => {
    it('inside', () => { mark('test/twice.test.js::group > inside second'); });
    it('other', () => { mark('test/twice.test.js::group > other'); });
});
`,
        },
    },
    {
        id: 'node-test-skipped-and-unregistered', runner: 'node-test',
        // Counts given as lower bounds.
        atLeast: ['test/unregistered.test.js'],
        sometimes: ['test/unregistered.test.js::never registered'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/skips.test.js': `${CJS}const { test, describe, it } = require('node:test');
test('runs', () => { mark('test/skips.test.js::runs'); });
test.skip('skipped', () => { mark('test/skips.test.js::skipped'); });
test.todo('later', () => { mark('test/skips.test.js::later'); });
describe.skip('whole group', () => {
    it('inside a skipped group', () => { mark('test/skips.test.js::whole group > inside a skipped group'); });
});
`,
            'test/unregistered.test.js': `${CJS}const { test } = require('node:test');
function register() {
    test('never registered', () => { mark('test/unregistered.test.js::never registered'); });
}
module.exports = { register };
`,
        },
    },
    {
        id: 'node-test-only-is-inert-without-its-flag', runner: 'node-test',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/focus.test.js': `${CJS}const { test } = require('node:test');
test.only('focused', () => { mark('test/focus.test.js::focused'); });
test('not left out', () => { mark('test/focus.test.js::not left out'); });
`,
        },
    },
    {
        id: 'node-test-binding-at-the-call', runner: 'node-test',
        // Counts given as lower bounds.
        atLeast: ['test/bound.test.js'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'helper.js': 'function it(name, callback) { return name; }\nmodule.exports = { it };\n',
            'reexport.js': "const runner = require('node:test');\nmodule.exports = { it: runner.it, group: runner.describe };\n",
            'test/bound.test.js': `${CJS}const { test, describe, it: real } = require('node:test');
const { it } = require('../helper');
const { it: again, group } = require('../reexport');
it('from a helper that is not the runner', () => { mark('test/bound.test.js::from a helper that is not the runner'); });
test('real', () => { mark('test/bound.test.js::real'); });
describe('suite', () => {
    const real = (name, callback) => name;
    real('shadowed inside the suite', () => { mark('test/bound.test.js::suite > shadowed inside the suite'); });
    test('inside', () => { mark('test/bound.test.js::suite > inside'); });
});
function register(test) {
    test('through a parameter', () => { mark('test/bound.test.js::through a parameter'); });
}
register((name, callback) => name);
group('re-exported', () => {
    again('through a project module', () => { mark('test/bound.test.js::re-exported > through a project module'); });
});
real('after the suite', () => { mark('test/bound.test.js::after the suite'); });
`,
        },
    },
    {
        id: 'node-test-through-an-esm-module', runner: 'node-test', full: 'node --test test/through.test.mjs',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'harness.mjs': "import { test } from 'node:test';\nexport { it as spec } from 'node:test';\nexport * from 'node:test';\nexport const again = test;\nexport function fake(name, callback) { return name; }\n",
            'test/through.test.mjs': `${ESM}import { spec, describe, again, fake } from '../harness.mjs';
describe('grouped', () => {
    spec('renamed on the way out', () => { mark('test/through.test.mjs::grouped > renamed on the way out'); });
});
again('a constant of the module', () => { mark('test/through.test.mjs::a constant of the module'); });
fake('a function of the module', () => { mark('test/through.test.mjs::a function of the module'); });
`,
        },
    },
    {
        id: 'node-test-names-of-inner-scopes', runner: 'node-test',
        // Counts given as lower bounds.
        atLeast: ['test/scopes.test.js'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/scopes.test.js': `${CJS}const { test, describe, it } = require('node:test');
describe('declared inside', () => {
    function it(name, callback) { return name; }
    it('a function of the suite', () => { mark('test/scopes.test.js::declared inside > a function of the suite'); });
    test('still the runner', () => { mark('test/scopes.test.js::declared inside > still the runner'); });
});
{
    const test = (name, callback) => name;
    test('a constant of a block', () => { mark('test/scopes.test.js::a constant of a block'); });
}
for (const it of [(name, callback) => name]) {
    it('a loop variable', () => { mark('test/scopes.test.js::a loop variable'); });
}
try {
    throw (name, callback) => name;
} catch (test) {
    test('a caught value', () => { mark('test/scopes.test.js::a caught value'); });
}
test('after them all', () => { mark('test/scopes.test.js::after them all'); });
it('and the other name', () => { mark('test/scopes.test.js::and the other name'); });
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
        // Counts given as lower bounds.
        atLeast: ['test/e.test.js'],
        sometimes: ['test/e.test.js::from helper', 'test/e.test.js::in callback'],
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
        // Counts given as lower bounds.
        atLeast: ['src/sum.test.js'],
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

    {
        id: 'jest-same-name-twice-and-skips', runner: 'jest',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'src/twice.test.js': `${CJS}
it('same', () => { mark('src/twice.test.js::same first'); });
it('same', () => { mark('src/twice.test.js::same second'); });
it('alone', () => { mark('src/twice.test.js::alone'); });
xit('crossed out', () => { mark('src/twice.test.js::crossed out'); });
it.skip('skipped', () => { mark('src/twice.test.js::skipped'); });
describe.skip('group', () => {
    it('inside', () => { mark('src/twice.test.js::group > inside'); });
});
const spec = it;
spec('global under another name', () => { mark('src/twice.test.js::global under another name'); });
`,
        },
    },

    {
        id: 'jest-focused-tests', runner: 'jest',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'src/focus.test.js': `${CJS}
it.only('focused', () => { mark('src/focus.test.js::focused'); });
it('left out', () => { mark('src/focus.test.js::left out'); });
describe('group', () => {
    it('inside', () => { mark('src/focus.test.js::group > inside'); });
});
describe.only('focused group', () => {
    it('inside focus', () => { mark('src/focus.test.js::focused group > inside focus'); });
});
`,
            'src/plain.test.js': `${CJS}it('other file', () => { mark('src/plain.test.js::other file'); });\n`,
        },
    },

    {
        id: 'jest-nested-focus', runner: 'jest',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'src/nested.test.js': `${CJS}
describe.only('outer', () => {
    it.only('one', () => { mark('src/nested.test.js::outer > one'); });
    it('two', () => { mark('src/nested.test.js::outer > two'); });
    describe('inner', () => {
        it('three', () => { mark('src/nested.test.js::outer > inner > three'); });
    });
});
describe('plain', () => {
    it.only('direct', () => { mark('src/nested.test.js::plain > direct'); });
    describe.only('nested focus', () => {
        it('in nested focus', () => { mark('src/nested.test.js::plain > nested focus > in nested focus'); });
    });
    describe('nested plain', () => {
        it('in nested plain', () => { mark('src/nested.test.js::plain > nested plain > in nested plain'); });
    });
});
it('outside', () => { mark('src/nested.test.js::outside'); });
`,
        },
    },

    {
        id: 'jest-file-the-default-pattern-leaves-out', runner: 'jest',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'test/plain.js': `${CJS}it('in a file jest does not look for', () => { mark('test/plain.js::in a file jest does not look for'); });\n`,
            'test/named.test.js': `${CJS}it('in a file jest looks for', () => { mark('test/named.test.js::in a file jest looks for'); });\n`,
        },
        notRunByDefault: ['test/plain.js::in a file jest does not look for'],
    },

    // ------------------------------------------------------------------ vitest
    {
        id: 'vitest-dependency', runner: 'vitest',
        sometimes: ['src/sum.test.ts::other > conditional'],
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

    {
        id: 'vitest-runner-under-other-names', runner: 'vitest',
        files: {
            'package.json': '{ "name": "x", "type": "module", "devDependencies": { "vitest": "^3" } }\n',
            'src/names.test.js': `${ESM}import { it as spec, describe as group } from 'vitest';
import * as vt from 'vitest';
group('grouped', () => {
    spec('inner', () => { mark('src/names.test.js::grouped > inner'); });
});
vt.test('namespaced', () => { mark('src/names.test.js::namespaced'); });
`,
        },
    },

    {
        id: 'vitest-nested-focus', runner: 'vitest',
        files: {
            'package.json': '{ "name": "x", "type": "module", "devDependencies": { "vitest": "^3" } }\n',
            'src/nested.test.js': `${ESM}import { it, describe } from 'vitest';
describe.only('outer', () => {
    it.only('one', () => { mark('src/nested.test.js::outer > one'); });
    it('two', () => { mark('src/nested.test.js::outer > two'); });
    describe('inner', () => {
        it('three', () => { mark('src/nested.test.js::outer > inner > three'); });
    });
});
describe('plain', () => {
    it.only('direct', () => { mark('src/nested.test.js::plain > direct'); });
    describe.only('nested focus', () => {
        it('in nested focus', () => { mark('src/nested.test.js::plain > nested focus > in nested focus'); });
    });
    describe('nested plain', () => {
        it('in nested plain', () => { mark('src/nested.test.js::plain > nested plain > in nested plain'); });
    });
});
it('outside', () => { mark('src/nested.test.js::outside'); });
`,
        },
    },

    {
        id: 'vitest-file-the-default-pattern-leaves-out', runner: 'vitest',
        files: {
            'package.json': '{ "name": "x", "type": "module", "devDependencies": { "vitest": "^3" } }\n',
            'test/plain.js': `${ESM}import { it } from 'vitest';\nit('in a file vitest does not look for', () => { mark('test/plain.js::in a file vitest does not look for'); });\n`,
            'test/named.test.js': `${ESM}import { it } from 'vitest';\nit('in a file vitest looks for', () => { mark('test/named.test.js::in a file vitest looks for'); });\n`,
        },
        notRunByDefault: ['test/plain.js::in a file vitest does not look for'],
    },

    {
        id: 'vitest-skipped-forms', runner: 'vitest',
        files: {
            'package.json': '{ "name": "x", "type": "module", "devDependencies": { "vitest": "^3" } }\n',
            'src/skips.test.js': `${ESM}import { it, describe, test } from 'vitest';
it('runs', () => { mark('src/skips.test.js::runs'); });
it.skip('skipped', () => { mark('src/skips.test.js::skipped'); });
it.todo('later');
test.skipIf(true)('skipped when true', () => { mark('src/skips.test.js::skipped when true'); });
test.runIf(true)('run when true', () => { mark('src/skips.test.js::run when true'); });
describe.skip('skipped group', () => {
    it('inside', () => { mark('src/skips.test.js::skipped group > inside'); });
});
it('with options', { skip: true }, () => { mark('src/skips.test.js::with options'); });
`,
        },
        sometimes: ['src/skips.test.js::run when true', 'src/skips.test.js::skipped when true'],
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
        // Counts given as lower bounds.
        atLeast: ['test/fifo.test.js', 'test/shared.js'],
        sometimes: ['test/shared.js::pushes'],
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

    {
        id: 'mocha-focused-tests', runner: 'mocha',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha --recursive" } }\n',
            'test/focus.test.js': `${CJS}
it.only('focused', function () { mark('test/focus.test.js::focused'); });
it('left out', function () { mark('test/focus.test.js::left out'); });
`,
            'test/plain.test.js': `${CJS}it('other file', function () { mark('test/plain.test.js::other file'); });\n`,
        },
        // mocha's focus holds for the whole run: a file without one runs
        // when it is the only file given.
        notRunByDefault: ['test/plain.test.js::other file'],
    },
    {
        id: 'vitest-focused-tests', runner: 'vitest',
        files: {
            'package.json': '{ "name": "x", "type": "module", "devDependencies": { "vitest": "^3" } }\n',
            'src/focus.test.js': `${ESM}import { it, describe } from 'vitest';
it.only('focused', () => { mark('src/focus.test.js::focused'); });
it('left out', () => { mark('src/focus.test.js::left out'); });
describe('group', () => {
    it('inside', () => { mark('src/focus.test.js::group > inside'); });
});
`,
            'src/plain.test.js': `${ESM}import { it } from 'vitest';\nit('other file', () => { mark('src/plain.test.js::other file'); });\n`,
        },
    },

    {
        id: 'mocha-nested-focus', runner: 'mocha',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha --recursive" } }\n',
            'test/nested.test.js': `${CJS}
describe.only('outer', function () {
    it.only('one', function () { mark('test/nested.test.js::outer > one'); });
    it('two', function () { mark('test/nested.test.js::outer > two'); });
    describe('inner', function () {
        it('three', function () { mark('test/nested.test.js::outer > inner > three'); });
    });
});
describe('plain', function () {
    it.only('direct', function () { mark('test/nested.test.js::plain > direct'); });
    describe.only('nested focus', function () {
        it('in nested focus', function () { mark('test/nested.test.js::plain > nested focus > in nested focus'); });
    });
    describe('nested plain', function () {
        it('in nested plain', function () { mark('test/nested.test.js::plain > nested plain > in nested plain'); });
    });
});
it('outside', function () { mark('test/nested.test.js::outside'); });
`,
        },
    },

    {
        id: 'mocha-skipped-forms', runner: 'mocha',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha --recursive" } }\n',
            'test/skips.test.js': `${CJS}
it('runs', function () { mark('test/skips.test.js::runs'); });
it.skip('skipped', function () { mark('test/skips.test.js::skipped'); });
xit('crossed out', function () { mark('test/skips.test.js::crossed out'); });
it('pending, no body');
describe.skip('skipped group', function () {
    it('inside', function () { mark('test/skips.test.js::skipped group > inside'); });
});
xdescribe('crossed group', function () {
    it('inside', function () { mark('test/skips.test.js::crossed group > inside'); });
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
        sometimes: ['slow_test.go::TestSlow'],
        files: {
            'go.mod': 'module example.com/m\n\ngo 1.21\n',
            'mark_test.go': GO('m'),
            'a_test.go': 'package m\n\nimport "testing"\n\nfunc TestAlways(t *testing.T) { mark("a_test.go::TestAlways") }\n',
            'slow_test.go': '//go:build integration\n\npackage m\n\nimport "testing"\n\nfunc TestSlow(t *testing.T) { mark("slow_test.go::TestSlow") }\n',
        },
    },

    {
        id: 'go-platform-file-and-external-package', runner: 'go-test',
        sometimes: ['only_plan9_test.go::TestElsewhere'],
        files: {
            'go.mod': 'module example.com/m\n\ngo 1.21\n',
            'util.go': 'package m\n\nfunc Add(a, b int) int { return a + b }\n',
            'mark_test.go': GO('m_test'),
            'ext_test.go': 'package m_test\n\nimport "testing"\n\nfunc TestOutside(t *testing.T) { mark("ext_test.go::TestOutside") }\n',
            'only_plan9_test.go': 'package m_test\n\nimport "testing"\n\nfunc TestElsewhere(t *testing.T) { mark("only_plan9_test.go::TestElsewhere") }\n',
        },
    },

    {
        id: 'go-example-output-is-the-last-comment', runner: 'go-test',
        files: {
            'go.mod': 'module example.com/m\n\ngo 1.21\n',
            'util.go': 'package m\n\nfunc Add(a, b int) int { return a + b }\nfunc Sub(a, b int) int { return a - b }\nfunc Mul(a, b int) int { return a * b }\nfunc Div(a, b int) int { return a / b }\n',
            'mark_test.go': GO('m'),
            'ex_test.go': `package m

import "fmt"

func ExampleAdd() {
	mark("ex_test.go::ExampleAdd")
	fmt.Println("hi")
	// Output: hi
}

func ExampleSub() {
	mark("ex_test.go::ExampleSub")
	_ = \`
// Output: only text in a string
\`
}

func ExampleDiv() {
	mark("ex_test.go::ExampleDiv")
	fmt.Println("hi")
	/* Output:
	hi
	*/
}
`,
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
        sometimes: ['src/lib.rs::extra > gated_module', 'src/lib.rs::tests > gated'],
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
        id: 'cargo-attribute-macros', runner: 'cargo-test',
        // Counts given as lower bounds.
        atLeast: ['src/lib.rs'],
        files: {
            'Cargo.toml': `${CARGO('case_macros')}\n[dev-dependencies]\ntokio = { version = "1", features = ["macros", "rt"] }\nrstest = "0.23"\n`,
            'src/lib.rs': `${RS}
#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    #[tokio::test]
    async fn waits() { mark("src/lib.rs::tests > waits"); }

    #[rstest]
    #[case(1)]
    #[case(2)]
    fn rows(#[case] n: i32) { let _ = n; mark("src/lib.rs::tests > rows"); }

    #[test]
    fn plain() { mark("src/lib.rs::tests > plain"); }
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
        // Counts given as lower bounds.
        atLeast: ['FooTests.cs'],
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
        id: 'dotnet-xunit-what-is-not-discovered', runner: 'dotnet-test',
        files: {
            'App.Tests.csproj': CSPROJ(XUNIT),
            'Hidden.cs': `using Xunit;

namespace Hid.Tests
{
${CS}
    public class Shown
    {
        [Fact]
        public void Runs() { Rec.Mark("Hidden.cs::Shown > Runs"); }

        [Fact]
        void PrivateFact() { Rec.Mark("Hidden.cs::Shown > PrivateFact"); }

        [Fact]
        public static void StaticFact() { Rec.Mark("Hidden.cs::Shown > StaticFact"); }

        [Fact(Skip = "not now")]
        public void Skipped() { Rec.Mark("Hidden.cs::Shown > Skipped"); }
    }
}
`,
        },
    },
    {
        id: 'dotnet-xunit-skip-is-an-argument', runner: 'dotnet-test',
        files: {
            'App.Tests.csproj': CSPROJ(XUNIT),
            'Named.cs': `using Xunit;

namespace Named.Tests
{
${CS}
    public class Named
    {
        [Fact(DisplayName = "when asked to, Skip = no")]
        public void Runs() { Rec.Mark("Named.cs::Named > Runs"); }

        [Fact(Skip = "not now")]
        public void Skipped() { Rec.Mark("Named.cs::Named > Skipped"); }
    }
}
`,
        },
    },
    {
        id: 'dotnet-mstest-what-is-not-discovered', runner: 'dotnet-test',
        files: {
            'App.Tests.csproj': CSPROJ([['Microsoft.NET.Test.Sdk', '17.12.0'], ['MSTest.TestAdapter', '1.2.1'], ['MSTest.TestFramework', '1.2.1']]),
            'Loose.cs': `using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Loose.Tests
{
${CS}
    [TestClass]
    public class Marked
    {
        [TestMethod]
        public void Runs() { Rec.Mark("Loose.cs::Marked > Runs"); }

        [TestMethod]
        void PrivateMethod() { Rec.Mark("Loose.cs::Marked > PrivateMethod"); }

        [TestMethod]
        [Ignore]
        public void Ignored() { Rec.Mark("Loose.cs::Marked > Ignored"); }
    }

    public class Unmarked
    {
        [TestMethod]
        public void NeverFound() { Rec.Mark("Loose.cs::Unmarked > NeverFound"); }
    }
}
`,
        },
    },
    {
        id: 'dotnet-nunit-what-is-not-discovered', runner: 'dotnet-test',
        files: {
            'App.Tests.csproj': CSPROJ([['Microsoft.NET.Test.Sdk', '17.12.0'], ['NUnit', '3.12.0'], ['NUnit3TestAdapter', '4.6.0']]),
            'Quiet.cs': `using NUnit.Framework;

namespace Quiet.Tests
{
${CS}
    public class Fixture
    {
        [Test]
        public void Runs() { Rec.Mark("Quiet.cs::Fixture > Runs"); }

        [Test]
        [Ignore("not now")]
        public void Ignored() { Rec.Mark("Quiet.cs::Fixture > Ignored"); }

        [Test]
        public static void StaticTest() { Rec.Mark("Quiet.cs::Fixture > StaticTest"); }

        [Test]
        void PrivateTest() { Rec.Mark("Quiet.cs::Fixture > PrivateTest"); }

        [TestCase(1, Ignore = "later")]
        public void IgnoredCase(int x) { Rec.Mark("Quiet.cs::Fixture > IgnoredCase"); }

        [Test]
        [Ignore("for now", Until = "2099-01-01")]
        public void IgnoredForNow() { Rec.Mark("Quiet.cs::Fixture > IgnoredForNow"); }

        [Test, Explicit]
        public void OnlyWhenAsked() { Rec.Mark("Quiet.cs::Fixture > OnlyWhenAsked"); }

        [Test, Category("fast"), Description("plain")]
        public void UnderPlainAttributes() { Rec.Mark("Quiet.cs::Fixture > UnderPlainAttributes"); }
    }
}
`,
        },
        sometimes: ['Quiet.cs::Fixture > IgnoredForNow', 'Quiet.cs::Fixture > OnlyWhenAsked'],
    },
    {
        id: 'dotnet-mstest', runner: 'dotnet-test',
        // Counts given as lower bounds.
        atLeast: ['CalcTests.cs'],
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
        // Counts given as lower bounds.
        atLeast: ['QueueTests.cs'],
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
        // Counts given as lower bounds.
        atLeast: ['src/test/java/com/x/FooTest.java'],
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

    @Test
    @org.junit.Ignore("not now")
    public void ignored() { mark("src/test/java/com/x/ChildTest.java::ChildTest > ignored"); }
}
`,
            'src/test/java/com/x/OnlyInheritsTest.java': 'package com.x;\n\npublic class OnlyInheritsTest extends BaseChecks {\n}\n',
        },
    },
    {
        id: 'maven-nested-classes', runner: 'maven',
        sometimes: ['src/test/java/com/x/OuterTest.java::OuterTest > Plain > inStatic'],
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
        id: 'maven-junit5-what-is-not-run', runner: 'maven',
        files: {
            'pom.xml': POM.replace('DEPENDENCIES', JUPITER),
            'src/test/java/com/x/RulesTest.java': `package com.x;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;

class RulesTest {
${JAVA}
    @Test
    void runs() { mark("src/test/java/com/x/RulesTest.java::RulesTest > runs"); }

    @Test
    private void hidden() { mark("src/test/java/com/x/RulesTest.java::RulesTest > hidden"); }

    @Test
    static void onTheClass() { mark("src/test/java/com/x/RulesTest.java::RulesTest > onTheClass"); }

    @Test
    @Disabled("not now")
    void disabled() { mark("src/test/java/com/x/RulesTest.java::RulesTest > disabled"); }

    @Test
    void overloaded() { mark("src/test/java/com/x/RulesTest.java::RulesTest > overloaded"); }
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
    // ------------------------------------------- what a later write leaves
    {
        id: 'node-test-body-given-as-an-expression', runner: 'node-test',
        // Counts given as lower bounds.
        atLeast: ['test/b.test.js'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/b.test.js': `${CJS}const { test } = require('node:test');
function body(t) { mark('test/b.test.js::' + t.name); }
const bodies = { one(t) { mark('test/b.test.js::' + t.name); } };
const wrap = fn => fn;
const options = { timeout: 1000 };
const nothing = undefined;
test('named callback', body);
test('named callback with options', { timeout: 1000 }, body);
test('member callback', bodies.one);
test('wrapped callback', wrap(t => { mark('test/b.test.js::' + t.name); }));
test('options only', options);
test('undefined body', nothing);
test('no callback');
test(...['spread title', () => { mark('test/b.test.js::spread'); }]);
`,
        },
    },
    {
        id: 'node-test-names-written-again', runner: 'node-test',
        // Counts given as lower bounds.
        atLeast: ['test/block.test.js', 'test/r.test.js'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/r.test.js': `${CJS}const { test } = require('node:test');
const fake = (name, fn) => name;
let caseFn = test;
caseFn = fake;
caseFn('not a test: reassigned', () => { mark('test/r.test.js::not a test: reassigned'); });
if (true) { var it = fake; }
it('not a test: hoisted var', () => { mark('test/r.test.js::not a test: hoisted var'); });
specify('not a test: hoisted function', () => { mark('test/r.test.js::not a test: hoisted function'); });
function specify(name, fn) { return name; }
let swapped = test;
function swap() { swapped = fake; }
swap();
swapped('not a test: written in a function', () => { mark('test/r.test.js::not a test: written in a function'); });
let picked = test;
({ picked } = { picked: fake });
picked('not a test: destructured over', () => { mark('test/r.test.js::not a test: destructured over'); });
globalThis.fit = fake;
fit('not a test: global written', () => { mark('test/r.test.js::not a test: global written'); });
test('real', () => { mark('test/r.test.js::real'); });
`,
            'test/block.test.js': `${CJS}const { test } = require('node:test');
const fake = (name, fn) => name;
{ function specify(name, fn) { return fake(name, fn); } }
specify('not a test: block function', () => { mark('test/block.test.js::not a test: block function'); });
test('real beside a block', () => { mark('test/block.test.js::real beside a block'); });
`,
            'test/once.test.js': `${CJS}let declare;
declare = require('node:test').test;
declare('assigned once', () => { mark('test/once.test.js::assigned once'); });
`,
        },
    },
    {
        id: 'node-test-names-no-scope-settles', runner: 'node-test',
        // Counts given as lower bounds.
        atLeast: ['test/w.test.js'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/w.test.js': `${CJS}const { test } = require('node:test');
const fake = (name, fn) => name;
with ({ test: fake }) {
    test('not a test: inside with', () => { mark('test/w.test.js::not a test: inside with'); });
}
function scoped() {
    eval('var test = fake');
    test('not a test: after eval', () => { mark('test/w.test.js::not a test: after eval'); });
}
scoped();
test('real', () => { mark('test/w.test.js::real'); });
`,
        },
    },
    {
        id: 'node-test-skip-option-values', runner: 'node-test',
        sometimes: ['test/o.test.js::named options', 'test/o.test.js::shorthand', 'test/o.test.js::spread options'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/o.test.js': `${CJS}const { test } = require('node:test');
const skip = true;
const opts = { skip: true };
test('empty reason runs', { skip: '' }, () => { mark('test/o.test.js::empty reason runs'); });
test('zero runs', { skip: 0 }, () => { mark('test/o.test.js::zero runs'); });
test('null runs', { skip: null }, () => { mark('test/o.test.js::null runs'); });
test('undefined runs', { skip: undefined }, () => { mark('test/o.test.js::undefined runs'); });
test('reason skips', { skip: 'not today' }, () => { mark('test/o.test.js::reason skips'); });
test('one skips', { skip: 1 }, () => { mark('test/o.test.js::one skips'); });
test('shorthand', { skip }, () => { mark('test/o.test.js::shorthand'); });
test('spread options', { ...opts }, () => { mark('test/o.test.js::spread options'); });
test('named options', opts, () => { mark('test/o.test.js::named options'); });
test('computed key', { ['skip']: true }, () => { mark('test/o.test.js::computed key'); });
`,
        },
    },
    {
        // node runs a file that declares no test as one test.
        id: 'node-test-files-the-script-names', runner: 'node-test',
        // Counts given as lower bounds.
        atLeast: ['test/smoke.js'],
        full: 'npm test --silent',
        undeclared: ['test/smoke.js::the script'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test test/a.test.js test/smoke.js" } }\n',
            'test/a.test.js': `${CJS}const { test } = require('node:test');
test('declared', () => { mark('test/a.test.js::declared'); });
`,
            'test/smoke.js': `${CJS}if (1 + 1 !== 2) process.exit(1);
mark('test/smoke.js::the script');
`,
            'test/helpers/util.js': `${CJS}mark('test/helpers/util.js::never loaded');
module.exports = {};
`,
        },
    },
    {
        id: 'node-test-files-node-looks-for', runner: 'node-test',
        // Counts given as lower bounds.
        atLeast: ['test/tools/setup.js'],
        undeclared: ['test/tools/setup.js::the script'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/a.test.js': `${CJS}const { test } = require('node:test');
test('declared', () => { mark('test/a.test.js::declared'); });
`,
            'test/tools/setup.js': `${CJS}mark('test/tools/setup.js::the script');\n`,
            'lib/tools.js': `${CJS}mark('lib/tools.js::never loaded');\nmodule.exports = {};\n`,
        },
    },
    // ------------------------------------- one run, several files, a focus
    {
        id: 'jest-joined-with-a-focused-file', runner: 'jest',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'test/focus.test.js': `${CJS}test.only('focused', () => { mark('test/focus.test.js::focused'); });
test('left out', () => { mark('test/focus.test.js::left out'); });
`,
            'test/plain.test.js': `${CJS}test('other file', () => { mark('test/plain.test.js::other file'); });\n`,
        },
    },
    {
        id: 'vitest-joined-with-a-focused-file', runner: 'vitest',
        files: {
            'package.json': '{ "name": "x", "type": "module", "scripts": { "test": "vitest run" } }\n',
            'test/focus.test.js': `${ESM}import { test } from 'vitest';
test.only('focused', () => { mark('test/focus.test.js::focused'); });
test('left out', () => { mark('test/focus.test.js::left out'); });
`,
            'test/plain.test.js': `${ESM}import { test } from 'vitest';
test('other file', () => { mark('test/plain.test.js::other file'); });
`,
        },
    },
    // -------------------------------------------- the runner's own config
    {
        id: 'mocha-config-adds-files', runner: 'mocha',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n',
            '.mocharc.json': '{ "spec": ["test/**/*.test.js"] }\n',
            'test/a.test.js': `${CJS}it('first', function () { mark('test/a.test.js::first'); });\n`,
            'test/deep/b.test.js': `${CJS}it('second', function () { mark('test/deep/b.test.js::second'); });\n`,
        },
    },
    {
        id: 'mocha-config-that-selects-nothing', runner: 'mocha',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n',
            '.mocharc.yml': 'timeout: 5000\nreporter: dot\n',
            'test/a.test.js': `${CJS}it('first', function () { mark('test/a.test.js::first'); });\n`,
            'test/b.test.js': `${CJS}it('second', function () { mark('test/b.test.js::second'); });\n`,
        },
    },
    {
        id: 'mocha-config-in-code', runner: 'mocha',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" }, "mocha": { "timeout": 4000 } }\n',
            '.mocharc.js': "module.exports = Object.assign({}, { grep: 'first' });\n",
            'test/a.test.js': `${CJS}it('first', function () { mark('test/a.test.js::first'); });\n`,
            'test/b.test.js': `${CJS}it('second', function () { mark('test/b.test.js::second'); });\n`,
        },
        notRunByDefault: ['test/b.test.js::second'],
    },
    {
        id: 'jest-config-chooses-files', runner: 'jest',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.js': "module.exports = { testMatch: ['**/*.spec.js'] };\n",
            'test/a.spec.js': `${CJS}test('chosen', () => { mark('test/a.spec.js::chosen'); });\n`,
            'test/b.test.js': `${CJS}test('left out by the config', () => { mark('test/b.test.js::left out by the config'); });\n`,
        },
        notRunByDefault: ['test/b.test.js::left out by the config'],
    },
    {
        id: 'jest-config-roots-and-pattern', runner: 'jest',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" }, "jest": { "roots": ["<rootDir>/test"], "testRegex": ["test/(.*?/)?.*test.js$"], "testPathIgnorePatterns": ["<rootDir>/test/skipped/"], "collectCoverage": false } }\n',
            'test/a.test.js': `${CJS}test('in the root', () => { mark('test/a.test.js::in the root'); });\n`,
            'test/sub/b.test.js': `${CJS}test('deeper', () => { mark('test/sub/b.test.js::deeper'); });\n`,
            'test/skipped/c.test.js': `${CJS}test('ignored path', () => { mark('test/skipped/c.test.js::ignored path'); });\n`,
            'src/d.test.js': `${CJS}test('outside the roots', () => { mark('src/d.test.js::outside the roots'); });\n`,
        },
        notRunByDefault: ['src/d.test.js::outside the roots', 'test/skipped/c.test.js::ignored path'],
    },
    {
        id: 'jest-config-that-selects-nothing', runner: 'jest',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.js': "/** @type {import('jest').Config} */\nconst config = {\n    testEnvironment: 'node',\n    verbose: true,\n};\nmodule.exports = config;\n",
            'test/a.test.js': `${CJS}test('plain', () => { mark('test/a.test.js::plain'); });\n`,
        },
    },
    {
        id: 'vitest-config-chooses-files', runner: 'vitest',
        files: {
            'package.json': '{ "name": "x", "type": "module", "scripts": { "test": "vitest run" } }\n',
            'vitest.config.js': "export default { test: { include: ['**/*.spec.js'] } };\n",
            'test/a.spec.js': `${ESM}import { test } from 'vitest';
test('chosen', () => { mark('test/a.spec.js::chosen'); });
`,
            'test/b.test.js': `${ESM}import { test } from 'vitest';
test('left out by the config', () => { mark('test/b.test.js::left out by the config'); });
`,
        },
        notRunByDefault: ['test/b.test.js::left out by the config'],
    },
    {
        id: 'vitest-config-directory', runner: 'vitest',
        files: {
            'package.json': '{ "name": "x", "type": "module", "scripts": { "test": "vitest run" } }\n',
            'vitest.config.js': "import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({\n    test: {\n        name: 'unit',\n        globals: true,\n        environment: 'node',\n        dir: 'tests',\n    },\n});\n",
            'tests/a.test.js': `${ESM}test('in the directory', () => { mark('tests/a.test.js::in the directory'); });\n`,
            'src/b.test.js': `${ESM}test('outside the directory', () => { mark('src/b.test.js::outside the directory'); });\n`,
        },
        notRunByDefault: ['src/b.test.js::outside the directory'],
    },
    {
        id: 'mocha-script-loads-what-the-tests-need', runner: 'mocha',
        full: 'npm test --silent',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha --require ./support/setup.js --reporter dot test/" } }\n',
            'support/setup.js': 'global.ready = true;\n',
            'test/a.test.js': `${CJS}it('needs the setup', function () {
    if (!global.ready) throw new Error('setup not loaded');
    mark('test/a.test.js::needs the setup');
});
`,
            'test/b.test.js': `${CJS}it('needs it too', function () {
    if (!global.ready) throw new Error('setup not loaded');
    mark('test/b.test.js::needs it too');
});
`,
        },
    },
    {
        id: 'jest-script-names-its-configuration', runner: 'jest',
        full: 'npm test --silent',
        notRunByDefault: ['test/b.test.js::under the default pattern'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest --config jest.unit.config.js" } }\n',
            'jest.unit.config.js': "module.exports = { testMatch: ['**/*.unit.js'] };\n",
            'test/a.unit.js': `${CJS}test('under the configuration the script names', () => { mark('test/a.unit.js::under the configuration the script names'); });\n`,
            'test/b.test.js': `${CJS}test('under the default pattern', () => { mark('test/b.test.js::under the default pattern'); });\n`,
        },
    },
    {
        // Code the runner asks: a hook of a conftest.py, a TestMain. The
        // hook here is one pytest calls once for the whole run, with every
        // test collected: it holds for the tests of the other directory too.
        id: 'pytest-hooks-decide-at-run-time', runner: 'pytest',
        sometimes: ['other/test_free.py::test_no_hook_above', 'tests/test_h.py::test_kept', 'tests/test_h.py::test_left_out'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/conftest.py': 'def pytest_collection_modifyitems(config, items):\n    items[:] = [item for item in items if item.name != "test_left_out"]\n',
            'tests/test_h.py': `${PY}def test_left_out():
    mark("tests/test_h.py::test_left_out")

def test_kept():
    mark("tests/test_h.py::test_kept")
`,
            // A hook that only does something else decides nothing.
            'other/conftest.py': 'import gc\n\ndef pytest_runtest_setup():\n    gc.collect()\n\ndef pytest_collection():\n    gc.disable()\n',
            'other/test_free.py': `${PY}def test_no_hook_above():
    mark("other/test_free.py::test_no_hook_above")
`,
        },
    },
    {
        id: 'go-test-main-decides', runner: 'go-test',
        sometimes: ['gated/gated_test.go::TestBehindMain'],
        emptyTestFiles: ['gated/gated_test.go'],
        files: {
            'go.mod': 'module example.com/mains\n\ngo 1.21\n',
            'mark.go': GO('mains'),
            'free_test.go': 'package mains\n\nimport "testing"\n\nfunc TestFree(t *testing.T) { mark("free_test.go::TestFree") }\n',
            'gated/mark.go': GO('gated'),
            'gated/main_test.go': 'package gated\n\nimport (\n\t"os"\n\t"testing"\n)\n\nfunc TestMain(m *testing.M) {\n\tif os.Getenv("UCN_RUN_GATED") == "" {\n\t\tos.Exit(0)\n\t}\n\tos.Exit(m.Run())\n}\n',
            'gated/gated_test.go': 'package gated\n\nimport "testing"\n\nfunc TestBehindMain(t *testing.T) { mark("gated/gated_test.go::TestBehindMain") }\n',
            // A TestMain that sets up and runs decides nothing.
            'plain/mark.go': GO('plain'),
            'plain/main_test.go': 'package plain\n\nimport (\n\t"os"\n\t"testing"\n)\n\nfunc TestMain(m *testing.M) {\n\tos.Setenv("UCN_SET_UP", "1")\n\tcode := m.Run()\n\tos.Exit(code)\n}\n',
            'plain/plain_test.go': 'package plain\n\nimport "testing"\n\nfunc TestAfterSetup(t *testing.T) { mark("plain/plain_test.go::TestAfterSetup") }\n',
        },
    },
    // ---------------------------------------------- pytest: later writes
    {
        id: 'pytest-a-later-write-decides', runner: 'pytest',
        sometimes: [
            'tests/test_class_and_function.py::TestComputed > test_actual',
            'tests/test_class_and_function.py::test_function',
            'tests/test_marks_branch.py::test_mark_in_branch',
            'tests/test_marks_grown.py::test_mark_added',
            'tests/test_module_branch.py::test_actual',
            'tests/test_module_computed.py::test_actual',
            'tests/test_rebound.py::TestBody > test_in_branch',
            'tests/test_rebound.py::test_else',
            'tests/test_rebound.py::test_never',
        ],
        // A second name for one function is a second test.
        emptyTestFiles: ['tests/test_marks_branch.py', 'tests/test_marks_grown.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_module_computed.py': `${PY}__test__ = False
__test__ = bool(1)

def test_actual():
    mark("tests/test_module_computed.py::test_actual")
`,
            'tests/test_module_branch.py': `${PY}__test__ = False
if True:
    __test__ = True

def test_actual():
    mark("tests/test_module_branch.py::test_actual")
`,
            'tests/test_class_and_function.py': `${PY}class TestComputed:
    __test__ = False
    __test__ = bool(1)

    def test_actual(self):
        mark("tests/test_class_and_function.py::TestComputed > test_actual")

class TestBackOn:
    __test__ = False
    __test__ = True

    def test_on(self):
        mark("tests/test_class_and_function.py::TestBackOn > test_on")

def test_function():
    mark("tests/test_class_and_function.py::test_function")

test_function.__test__ = False
test_function.__test__ = bool(1)

def test_function_back_on():
    mark("tests/test_class_and_function.py::test_function_back_on")

test_function_back_on.__test__ = False
test_function_back_on.__test__ = True
`,
            'tests/test_marks.py': `${PY}import pytest

pytestmark = pytest.mark.skip
pytestmark = []

def test_mark_replaced():
    mark("tests/test_marks.py::test_mark_replaced")
`,
            'tests/test_marks_branch.py': `${PY}import pytest

if True:
    pytestmark = pytest.mark.skip

def test_mark_in_branch():
    mark("tests/test_marks_branch.py::test_mark_in_branch")
`,
            'tests/test_marks_grown.py': `${PY}import pytest

pytestmark = []
pytestmark += [pytest.mark.skip]

def test_mark_added():
    mark("tests/test_marks_grown.py::test_mark_added")
`,
            'tests/test_rebound.py': `${PY}import sys

def test_gone():
    mark("tests/test_rebound.py::test_gone")

test_gone = None

def test_deleted():
    mark("tests/test_rebound.py::test_deleted")

del test_deleted

def test_kept():
    mark("tests/test_rebound.py::test_kept")

test_second_name = test_kept

if sys.platform == "nope":
    def test_never():
        mark("tests/test_rebound.py::test_never")
else:
    def test_else():
        mark("tests/test_rebound.py::test_else")

class TestBody:
    def test_m(self):
        mark("tests/test_rebound.py::TestBody > test_m")

    test_m_again = test_m

    def test_none(self):
        mark("tests/test_rebound.py::TestBody > test_none")

    test_none = None

    if True:
        def test_in_branch(self):
            mark("tests/test_rebound.py::TestBody > test_in_branch")
`,
        },
    },
    {
        id: 'pytest-options-deselect', runner: 'pytest',
        // Counts given as lower bounds.
        atLeast: ['tests/test_marked.py'],
        sometimes: [
            'tests/test_marked.py::test_decorated_elsewhere',
            'tests/test_marked.py::test_some_cases',
        ],
        files: {
            'pytest.ini': '[pytest]\naddopts = -ra -m "not slow" --strict-markers --deselect tests/test_marked.py::test_deselected_by_id\nmarkers =\n    slow: takes long\n',
            'tests/__init__.py': '',
            'tests/deco.py': 'def passthrough(f):\n    return f\n',
            'tests/test_marked.py': `${PY}import pytest
from tests.deco import passthrough

slow = pytest.mark.slow

@pytest.mark.slow
def test_marked():
    mark("tests/test_marked.py::test_marked")

@slow
def test_marked_through_a_name():
    mark("tests/test_marked.py::test_marked_through_a_name")

@pytest.mark.slow
class TestMarkedClass:
    def test_inside(self):
        mark("tests/test_marked.py::TestMarkedClass > test_inside")

class TestMarkInBody:
    pytestmark = pytest.mark.slow

    def test_under_body_mark(self):
        mark("tests/test_marked.py::the body under a body mark")

class TestDerived(TestMarkInBody):
    def test_own(self):
        mark("tests/test_marked.py::TestDerived > test_own")

@passthrough
def test_decorated_elsewhere():
    mark("tests/test_marked.py::test_decorated_elsewhere")

def test_deselected_by_id():
    mark("tests/test_marked.py::test_deselected_by_id")

@pytest.mark.parametrize("v", [1, pytest.param(2, marks=pytest.mark.slow)])
def test_some_cases(v):
    mark("tests/test_marked.py::test_some_cases")

def test_plain():
    mark("tests/test_marked.py::test_plain")
`,
            'tests/test_module_marked.py': `${PY}import pytest

pytestmark = [pytest.mark.slow]

def test_under_module_mark():
    mark("tests/test_module_marked.py::test_under_module_mark")
`,
        },
    },
    {
        id: 'pytest-options-not-read', runner: 'pytest',
        notRunByDefault: ['tests/test_k.py::test_thing'],
        files: {
            'pytest.ini': '[pytest]\naddopts = -k "not thing"\n',
            'tests/__init__.py': '',
            'tests/test_k.py': `${PY}def test_thing():
    mark("tests/test_k.py::test_thing")

def test_other():
    mark("tests/test_k.py::test_other")
`,
        },
    },
    {
        id: 'pytest-imported-tests-run-where-imported', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/base.py': `${PY}${RID}import unittest

class TestBase:
    def test_shared(self):
        mark(rid())

class CaseBase(unittest.TestCase):
    def test_case_shared(self):
        mark(rid())

class Plain:
    def test_under_another_name(self):
        mark(rid())

def test_function_elsewhere():
    mark(rid())
`,
            'tests/test_child.py': `from tests.base import TestBase, CaseBase
from tests.base import test_function_elsewhere
from tests.base import TestBase as Renamed
from tests.base import Plain as TestPlain

class TestChild(TestBase):
    pass

class ChildCase(CaseBase):
    pass
`,
        },
    },
    {
        id: 'pytest-decorators-and-module-skips', runner: 'pytest',
        sometimes: [
            'tests/test_deco.py::test_needs_db',
            'tests/test_deco.py::test_passed_through',
            'tests/test_module_skip.py::test_unreached',
            'tests/test_needs_module.py::test_needs_it',
        ],
        emptyTestFiles: ['tests/test_module_skip.py', 'tests/test_needs_module.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/deco.py': 'import pytest\n\nrequires_db = pytest.mark.skip(reason="no db")\n\ndef passthrough(f):\n    return f\n',
            'tests/test_deco.py': `${PY}import pytest
from unittest import mock
from tests.deco import requires_db, passthrough

@requires_db
def test_needs_db():
    mark("tests/test_deco.py::test_needs_db")

@passthrough
def test_passed_through():
    mark("tests/test_deco.py::test_passed_through")

@pytest.mark.xfail(run=False)
def test_never_started():
    mark("tests/test_deco.py::test_never_started")

@pytest.mark.xfail
def test_expected_to_fail():
    mark("tests/test_deco.py::test_expected_to_fail")
    assert False

@mock.patch("os.getcwd")
def test_patched(cwd):
    mark("tests/test_deco.py::test_patched")

@pytest.mark.usefixtures("tmp_path")
def test_with_fixture():
    mark("tests/test_deco.py::test_with_fixture")
`,
            'tests/test_needs_module.py': `${PY}import pytest

missing = pytest.importorskip("a_module_that_is_not_installed")

def test_needs_it():
    mark("tests/test_needs_module.py::test_needs_it")
`,
            'tests/test_module_skip.py': `${PY}import pytest

pytest.skip("not here", allow_module_level=True)

def test_unreached():
    mark("tests/test_module_skip.py::test_unreached")
`,
        },
    },
    // ------------------------------------- marks whose argument is a value
    {
        id: 'dotnet-xunit-skip-is-a-value', runner: 'dotnet-test',
        // Counts given as lower bounds.
        atLeast: ['SkipValues.cs'],
        sometimes: ['SkipValues.cs::SkipValues > ConstantElsewhere', 'SkipValues.cs::SkipValues > UnderAnAttributeOfTheProject'],
        files: {
            'App.Tests.csproj': CSPROJ(XUNIT),
            'Elsewhere.cs': 'namespace Values.Tests\n{\n    public static class Elsewhere { public const string Why = "elsewhere"; }\n}\n',
            'SkipValues.cs': `using Xunit;

namespace Values.Tests
{
${CS}
    public static class Reasons
    {
        public const string Later = "later";
        public const string None = null;
    }

    public class SkipValues
    {
        const string Local = "local reason";

        [Fact(Skip = null)]
        public void NullRuns() { Rec.Mark("SkipValues.cs::SkipValues > NullRuns"); }

        [Fact(Skip = (string)null)]
        public void CastNullRuns() { Rec.Mark("SkipValues.cs::SkipValues > CastNullRuns"); }

        [Fact(Skip = default)]
        public void DefaultRuns() { Rec.Mark("SkipValues.cs::SkipValues > DefaultRuns"); }

        [Fact(Skip = Reasons.None)]
        public void NullConstantRuns() { Rec.Mark("SkipValues.cs::SkipValues > NullConstantRuns"); }

        [Fact(Skip = "why")]
        public void LiteralSkips() { Rec.Mark("SkipValues.cs::SkipValues > LiteralSkips"); }

        [Fact(Skip = Local)]
        public void LocalConstantSkips() { Rec.Mark("SkipValues.cs::SkipValues > LocalConstantSkips"); }

        [Fact(Skip = Reasons.Later)]
        public void ConstantSkips() { Rec.Mark("SkipValues.cs::SkipValues > ConstantSkips"); }

        [Fact(Skip = nameof(Reasons))]
        public void NameofSkips() { Rec.Mark("SkipValues.cs::SkipValues > NameofSkips"); }

        [Fact(Skip = "a" + "b")]
        public void JoinedSkips() { Rec.Mark("SkipValues.cs::SkipValues > JoinedSkips"); }

        [Fact(Skip = Elsewhere.Why)]
        public void ConstantElsewhere() { Rec.Mark("SkipValues.cs::SkipValues > ConstantElsewhere"); }

        [Fact(Skip = "")]
        public void EmptyReason() { Rec.Mark("SkipValues.cs::SkipValues > EmptyReason"); }

        [RetryFact]
        public void UnderAnAttributeOfTheProject() { Rec.Mark("SkipValues.cs::SkipValues > UnderAnAttributeOfTheProject"); }
    }

    public class RetryFactAttribute : FactAttribute
    {
    }
}
`,
        },
    },
    {
        id: 'maven-junit5-conditions', runner: 'maven',
        sometimes: [
            'src/test/java/com/x/ConditionsTest.java::ConditionsTest > notOnWindows',
            'src/test/java/com/x/ConditionsTest.java::ConditionsTest > onlyOnWindows',
        ],
        files: {
            'pom.xml': POM.replace('DEPENDENCIES', JUPITER),
            'src/test/java/com/x/Flaky.java': `package com.x;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import org.junit.jupiter.api.Disabled;

@Retention(RetentionPolicy.RUNTIME)
@Disabled("flaky")
public @interface Flaky {
}
`,
            'src/test/java/com/x/Quick.java': `package com.x;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@Test
@Tag("quick")
public @interface Quick {
}
`,
            'src/test/java/com/x/ConditionsTest.java': `package com.x;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;

class ConditionsTest {
${JAVA}
    @Test
    @EnabledOnOs(OS.WINDOWS)
    void onlyOnWindows() { mark("src/test/java/com/x/ConditionsTest.java::ConditionsTest > onlyOnWindows"); }

    @Test
    @DisabledOnOs(OS.WINDOWS)
    void notOnWindows() { mark("src/test/java/com/x/ConditionsTest.java::ConditionsTest > notOnWindows"); }

    @Test
    @Flaky
    void underAnAnnotationOfTheProject() { mark("src/test/java/com/x/ConditionsTest.java::ConditionsTest > underAnAnnotationOfTheProject"); }

    @Test
    @Tag("fast")
    @DisplayName("a name")
    @Timeout(5)
    void underJUnitsOwn() { mark("src/test/java/com/x/ConditionsTest.java::ConditionsTest > underJUnitsOwn"); }

    @Quick
    void declaredByAnAnnotationOfTheProject() { mark("src/test/java/com/x/ConditionsTest.java::ConditionsTest > declaredByAnAnnotationOfTheProject"); }
}
`,
        },
    },
    {
        id: 'cargo-ignored-on-a-condition', runner: 'cargo-test',
        sometimes: ['src/lib.rs::tests > ignored_here', 'src/lib.rs::tests > ignored_elsewhere'],
        files: {
            'Cargo.toml': CARGO('case_cfg_attr'),
            'src/lib.rs': `${RS}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn always() { mark("src/lib.rs::tests > always"); }

    #[test]
    #[cfg_attr(not(target_os = "none"), ignore)]
    fn ignored_here() { mark("src/lib.rs::tests > ignored_here"); }

    #[test]
    #[cfg_attr(target_os = "none", ignore = "not there")]
    fn ignored_elsewhere() { mark("src/lib.rs::tests > ignored_elsewhere"); }

    #[test]
    #[ignore = "takes long"]
    fn ignored_with_a_reason() { mark("src/lib.rs::tests > ignored_with_a_reason"); }
}
`,
        },
    },
    // ----- pytest: a switch through the lookup order and through imports
    {
        id: 'pytest-switch-not-a-literal-over-a-base-switched-off', runner: 'pytest',
        sometimes: ['tests/test_a.py::TestActual > test_actual'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}class Base:
    __test__ = False
    def test_actual(self):
        mark(rid())

class TestActual(Base):
    __test__ = bool(1)
`,
        },
    },
    {
        id: 'pytest-switch-not-a-literal-base-in-another-file', runner: 'pytest',
        sometimes: ['tests/test_a.py::TestActual > test_actual'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/base.py': `${PY}${RID}class Base:
    __test__ = False
    def test_actual(self):
        mark(rid())
`,
            'tests/test_a.py': `from tests.base import Base

class TestActual(Base):
    __test__ = bool(1)
`,
        },
    },
    {
        id: 'pytest-base-switch-not-a-literal-false', runner: 'pytest',
        sometimes: ['tests/test_a.py::Base > test_inherited', 'tests/test_a.py::TestX > test_inherited', 'tests/test_a.py::TestX > test_own'],
        emptyTestFiles: ['tests/test_a.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}class Base:
    __test__ = bool(0)
    def test_inherited(self):
        mark(rid())

class TestX(Base):
    def test_own(self):
        mark(rid())
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
        },
    },
    {
        id: 'pytest-base-switch-not-a-literal-true', runner: 'pytest',
        sometimes: ['tests/test_a.py::Base > test_inherited', 'tests/test_a.py::TestX > test_inherited', 'tests/test_a.py::TestX > test_own'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}class Base:
    __test__ = bool(1)
    def test_inherited(self):
        mark(rid())

class TestX(Base):
    def test_own(self):
        mark(rid())
`,
        },
    },
    {
        id: 'pytest-switch-nearest-in-the-lookup-order', runner: 'pytest',
        sometimes: ['tests/test_a.py::TestC > test_own'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}class A:
    __test__ = False

class B(A):
    __test__ = bool(1)

class TestC(B):
    def test_own(self):
        mark(rid())
`,
        },
    },
    {
        id: 'pytest-module-switch-holds-for-imported-tests', runner: 'pytest',
        sometimes: ['tests/test_b.py::test_x'],
        emptyTestFiles: ['tests/test_b.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}def test_x():
    mark(rid())
`,
            'tests/test_b.py': 'from tests.test_a import test_x\n__test__ = bool(0)\n',
        },
    },
    {
        id: 'pytest-module-mark-holds-for-imported-tests', runner: 'pytest',
        emptyTestFiles: ['tests/test_b.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}def test_x():
    mark(rid())

class TestK:
    def test_m(self):
        mark(rid())
`,
            'tests/test_b.py': `import pytest
from tests.test_a import test_x, TestK
pytestmark = pytest.mark.skip
`,
        },
    },
    {
        id: 'pytest-module-skip-holds-for-imported-tests', runner: 'pytest',
        sometimes: ['tests/test_b.py::TestK > test_m', 'tests/test_b.py::test_x'],
        emptyTestFiles: ['tests/test_b.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}def test_x():
    mark(rid())

class TestK:
    def test_m(self):
        mark(rid())
`,
            'tests/test_b.py': `import pytest
from tests.test_a import test_x, TestK
pytest.importorskip("no_such_module_ucn")
`,
        },
    },
    {
        id: 'pytest-mark-of-a-base-class', runner: 'pytest',
        emptyTestFiles: ['tests/test_a.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}import pytest

@pytest.mark.skip
class Base:
    def test_inherited(self):
        mark(rid())

class TestX(Base):
    def test_own(self):
        mark(rid())
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
        },
    },
    {
        id: 'pytest-pytestmark-of-a-base-class-in-another-file', runner: 'pytest',
        emptyTestFiles: ['tests/test_a.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/base.py': `${PY}${RID}import pytest

class Base:
    pytestmark = pytest.mark.skip
    def test_inherited(self):
        mark(rid())
`,
            'tests/test_a.py': `${PY}${RID}from tests.base import Base

class TestX(Base):
    def test_own(self):
        mark(rid())
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
        },
    },
    {
        id: 'pytest-mark-of-a-base-module-stays-there', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/base.py': `${PY}${RID}import pytest
pytestmark = pytest.mark.skip

class Base:
    def test_inherited(self):
        mark(rid())
`,
            'tests/test_a.py': `from tests.base import Base

class TestX(Base):
    pass
`,
        },
    },
    {
        id: 'pytest-switch-written-on-an-imported-class', runner: 'pytest',
        // In the module the class comes from, the switch holds where the writer was loaded first.
        sometimes: ['tests/test_a.py::TestA > test_m'],
        emptyTestFiles: ['tests/test_b.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}class TestA:
    def test_m(self):
        mark(rid())
`,
            'tests/test_b.py': 'from tests.test_a import TestA\nTestA.__test__ = False\n',
        },
    },
    {
        id: 'pytest-switch-written-through-a-string', runner: 'pytest',
        sometimes: ['tests/test_a.py::TestX > test_m', 'tests/test_a.py::test_f'],
        atLeast: ['tests/test_a.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}class TestX:
    def test_m(self):
        mark("tests/test_a.py::TestX > test_m")

setattr(TestX, "__test__", False)

def test_f():
    mark("tests/test_a.py::test_f")

globals()["__test__"] = True
`,
        },
    },
    {
        id: 'pytest-switch-set-by-a-decorator', runner: 'pytest',
        sometimes: ['tests/test_a.py::TestX > test_m'],
        emptyTestFiles: ['tests/test_a.py'],
        atLeast: ['tests/test_a.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}def nottest(c):
    c.__test__ = False
    return c

@nottest
class TestX:
    def test_m(self):
        mark("tests/test_a.py::TestX > test_m")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
        },
    },
    {
        id: 'pytest-switch-set-by-a-base-for-its-subclasses', runner: 'pytest',
        sometimes: ['tests/test_a.py::TestX > test_m'],
        emptyTestFiles: ['tests/test_a.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/base.py': `class Base:
    def __init_subclass__(cls, **kw):
        cls.__test__ = False
`,
            'tests/test_a.py': `${PY}from tests.base import Base

class TestX(Base):
    def test_m(self):
        mark("tests/test_a.py::TestX > test_m")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
        },
    },
    {
        id: 'pytest-class-of-the-project-named-testcase', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}class BaseTestCase:
    def test_x(self):
        mark(rid())

class MyChecks(BaseTestCase):
    def test_y(self):
        mark(rid())

class TestReal(BaseTestCase):
    def test_z(self):
        mark(rid())
`,
        },
    },
    {
        id: 'pytest-unittest-switches', runner: 'pytest',
        sometimes: ['tests/test_a.py::Computed > test_shared'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}import unittest

class Base(unittest.TestCase):
    __test__ = False
    def test_shared(self):
        mark(rid())

class Real(Base):
    __test__ = True

class Computed(Base):
    __test__ = bool(1)

class Inherits(Base):
    pass
`,
        },
    },
    {
        id: 'pytest-switch-written-on-an-imported-function', runner: 'pytest',
        sometimes: ['tests/test_a.py::test_x'],
        emptyTestFiles: ['tests/test_b.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}def test_x():
    mark(rid())
`,
            'tests/test_b.py': 'from tests.test_a import test_x\ntest_x.__test__ = False\n',
        },
    },
    {
        id: 'pytest-switch-in-a-branch-over-a-base-switched-off', runner: 'pytest',
        sometimes: ['tests/test_a.py::TestActual > test_actual'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}import sys

class Base:
    __test__ = False
    def test_actual(self):
        mark(rid())

class TestActual(Base):
    if sys.version_info > (3,):
        __test__ = True
`,
        },
    },
    {
        id: 'pytest-switch-deleted-leaves-the-base-switch', runner: 'pytest',
        emptyTestFiles: ['tests/test_a.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}class Base:
    __test__ = False
    def test_actual(self):
        mark(rid())

class TestActual(Base):
    __test__ = True
    del __test__
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
        },
    },
    {
        id: 'pytest-switch-written-through-another-name', runner: 'pytest',
        sometimes: ['tests/test_a.py::Base > test_actual', 'tests/test_a.py::TestActual > test_actual'],
        emptyTestFiles: ['tests/test_a.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/base.py': `${PY}${RID}class Base:
    def test_actual(self):
        mark(rid())

for c in (Base,):
    c.__test__ = False
`,
            'tests/test_a.py': `from tests.base import Base

class TestActual(Base):
    pass
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
        },
    },
    {
        id: 'pytest-module-skips-through-another-name', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a'],
        emptyTestFiles: ['tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}import pytest
skip = pytest.skip
skip("x", allow_module_level=True)

def test_a():
    mark("tests/test_x.py::test_a")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
        },
    },
    {
        id: 'pytest-module-skips-in-a-function-it-calls', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a'],
        emptyTestFiles: ['tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}import pytest

def need():
    pytest.skip("x", allow_module_level=True)

need()

def test_a():
    mark("tests/test_x.py::test_a")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
        },
    },
    {
        id: 'pytest-switch-on-collects-whatever-the-name', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}class Helper:
    __test__ = True
    def test_m(self):
        mark(rid())

class Truthy:
    __test__ = 1
    def test_m(self):
        mark(rid())

class Base2:
    __test__ = True
    def test_b(self):
        mark(rid())

class Derived(Base2):
    def test_d(self):
        mark(rid())

def helper():
    mark(rid())
helper.__test__ = True

def truthy():
    mark(rid())
truthy.__test__ = 1

class TestMeth:
    def check(self):
        mark(rid())
    check.__test__ = True
    def test_off(self):
        mark(rid())
    test_off.__test__ = False
`,
        },
    },
    // ------------------------------ pytest: code that runs before a test
    {
        id: 'pytest-hook-changes-items-through-another-name', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a', 'tests/test_x.py::test_b', 'free/test_free.py::test_free'],
        emptyTestFiles: ['tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}def test_a():
    mark("tests/test_x.py::test_a")

def test_b():
    mark("tests/test_x.py::test_b")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
            'tests/conftest.py': `def pytest_collection_modifyitems(items):
    selected = items
    selected.clear()
`,
        },
    },
    {
        id: 'pytest-hook-changes-items-in-place', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a', 'tests/test_x.py::test_b', 'free/test_free.py::test_free'],
        emptyTestFiles: ['tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}def test_a():
    mark("tests/test_x.py::test_a")

def test_b():
    mark("tests/test_x.py::test_b")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
            'tests/conftest.py': 'def pytest_collection_modifyitems(items):\n    items *= 0\n',
        },
    },
    {
        id: 'pytest-hook-calls-a-method-that-is-not-read', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a', 'tests/test_x.py::test_b', 'free/test_free.py::test_free'],
        emptyTestFiles: ['tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}def test_a():
    mark("tests/test_x.py::test_a")

def test_b():
    mark("tests/test_x.py::test_b")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
            'tests/conftest.py': 'def pytest_collection_modifyitems(items):\n    items.__delitem__(slice(None))\n',
        },
    },
    {
        id: 'pytest-hook-sets-an-option', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a', 'tests/test_x.py::test_b', 'free/test_free.py::test_free'],
        emptyTestFiles: ['tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}def test_a():
    mark("tests/test_x.py::test_a")

def test_b():
    mark("tests/test_x.py::test_b")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
            'tests/conftest.py': 'def pytest_configure(config):\n    config.option.markexpr = "nope"\n',
        },
    },
    {
        id: 'pytest-hook-bound-by-an-import', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a', 'tests/test_x.py::test_b', 'free/test_free.py::test_free'],
        emptyTestFiles: ['tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}def test_a():
    mark("tests/test_x.py::test_a")

def test_b():
    mark("tests/test_x.py::test_b")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
            'tests/plugin.py': 'def pytest_collection_modifyitems(items):\n    items.clear()\n',
            'tests/conftest.py': 'from tests.plugin import pytest_collection_modifyitems\n',
        },
    },
    {
        id: 'pytest-hook-brought-by-a-star-import', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a', 'tests/test_x.py::test_b', 'free/test_free.py::test_free'],
        emptyTestFiles: ['tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}def test_a():
    mark("tests/test_x.py::test_a")

def test_b():
    mark("tests/test_x.py::test_b")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
            'tests/plugin.py': 'def pytest_collection_modifyitems(items):\n    items.clear()\n',
            'tests/conftest.py': 'from tests.plugin import *\n',
        },
    },
    {
        id: 'pytest-hook-bound-by-an-assignment', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a', 'tests/test_x.py::test_b', 'free/test_free.py::test_free'],
        emptyTestFiles: ['tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}def test_a():
    mark("tests/test_x.py::test_a")

def test_b():
    mark("tests/test_x.py::test_b")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
            'tests/conftest.py': 'pytest_collection_modifyitems = lambda items: items.clear()\n',
        },
    },
    {
        id: 'pytest-hook-of-a-registered-object', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a', 'tests/test_x.py::test_b', 'free/test_free.py::test_free'],
        emptyTestFiles: ['tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}def test_a():
    mark("tests/test_x.py::test_a")

def test_b():
    mark("tests/test_x.py::test_b")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
            'tests/conftest.py': `class P:
    def pytest_collection_modifyitems(self, items):
        items.clear()

def pytest_configure(config):
    config.pluginmanager.register(P())
`,
        },
    },
    {
        id: 'pytest-fixture-every-test-gets-skips', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a', 'tests/test_x.py::test_b'],
        emptyTestFiles: ['tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}def test_a():
    mark("tests/test_x.py::test_a")

def test_b():
    mark("tests/test_x.py::test_b")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
            'tests/conftest.py': `import pytest

@pytest.fixture(autouse=True)
def guard():
    pytest.skip("no")
`,
        },
    },
    {
        id: 'pytest-fixture-asked-for-skips', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a', 'tests/test_x.py::test_c', 'tests/test_x.py::test_d'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}import pytest

def test_a(db):
    mark("tests/test_x.py::test_a")

def test_b(plain):
    mark("tests/test_x.py::test_b")

def test_c(client):
    mark("tests/test_x.py::test_c")

@pytest.mark.usefixtures("db")
def test_d():
    mark("tests/test_x.py::test_d")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
            'tests/conftest.py': `import pytest

@pytest.fixture
def db():
    pytest.skip("no db")

@pytest.fixture
def client(db):
    return 1

@pytest.fixture
def plain():
    return 1
`,
        },
    },
    {
        id: 'pytest-setup-of-the-module-skips', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a'],
        emptyTestFiles: ['tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}import pytest

def setup_module(module):
    pytest.skip("x")

def test_a():
    mark("tests/test_x.py::test_a")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
        },
    },
    {
        id: 'pytest-setup-of-a-class-skips', runner: 'pytest',
        sometimes: ['tests/test_x.py::TestK > test_a', 'tests/test_x.py::K > test_b', 'tests/test_x.py::TestDerived > test_c'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}import pytest, unittest
from tests.base import Base

class TestK:
    def setup_method(self):
        pytest.skip("x")
    def test_a(self):
        mark("tests/test_x.py::TestK > test_a")

class K(unittest.TestCase):
    def setUp(self):
        self.skipTest("x")
    def test_b(self):
        mark("tests/test_x.py::K > test_b")

class TestDerived(Base):
    def test_c(self):
        mark("tests/test_x.py::TestDerived > test_c")

class TestFree:
    def setup_method(self):
        self.ready = True
    def test_d(self):
        mark("tests/test_x.py::TestFree > test_d")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
            'tests/base.py': `import pytest
class Base:
    def setup_method(self):
        pytest.skip("x")
`,
        },
    },
    {
        id: 'pytest-hook-answers-for-the-call', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a', 'tests/test_x.py::test_b'],
        emptyTestFiles: ['tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}def test_a():
    mark("tests/test_x.py::test_a")

def test_b():
    mark("tests/test_x.py::test_b")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
            'tests/conftest.py': 'def pytest_pyfunc_call(pyfuncitem):\n    return True\n',
        },
    },
    {
        id: 'pytest-hook-after-collection-clears', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a', 'tests/test_x.py::test_b', 'free/test_free.py::test_free'],
        emptyTestFiles: ['tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}def test_a():
    mark("tests/test_x.py::test_a")

def test_b():
    mark("tests/test_x.py::test_b")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
            'tests/conftest.py': 'def pytest_collection_finish(session):\n    session.items.clear()\n',
        },
    },
    {
        id: 'pytest-fixture-of-a-class-skips', runner: 'pytest',
        sometimes: ['tests/test_x.py::TestK > test_a'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}import pytest

class TestK:
    @pytest.fixture(autouse=True)
    def guard(self):
        pytest.skip("no")
    def test_a(self):
        mark("tests/test_x.py::TestK > test_a")

def test_b():
    mark("tests/test_x.py::test_b")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
        },
    },
    {
        id: 'pytest-no-parameter-to-run-with', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a'],
        atLeast: ['tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}import pytest

NONE = []

@pytest.fixture(params=[])
def p(request):
    return request.param

def test_a(p):
    mark("tests/test_x.py::test_a")

@pytest.mark.parametrize("v", [])
def test_b(v):
    mark("tests/test_x.py::test_b")

@pytest.mark.parametrize("v", NONE)
def test_c(v):
    mark("tests/test_x.py::test_c")

@pytest.mark.parametrize("v", [1])
def test_d(v):
    mark("tests/test_x.py::test_d")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
        },
    },
    {
        id: 'pytest-hook-of-the-module-generates', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a'],
        atLeast: ['tests/test_x.py'],
        emptyTestFiles: ['tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}def pytest_generate_tests(metafunc):
    metafunc.parametrize("x", [])

def test_a(x):
    mark("tests/test_x.py::test_a")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
        },
    },
    {
        id: 'pytest-plugin-named-by-a-conftest', runner: 'pytest',
        sometimes: ['tests/test_x.py::test_a', 'tests/test_x.py::test_b', 'free/test_free.py::test_free'],
        emptyTestFiles: ['free/test_free.py', 'tests/test_x.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}def test_a():
    mark("tests/test_x.py::test_a")

def test_b():
    mark("tests/test_x.py::test_b")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
            'tests/plugin.py': 'def pytest_collection_modifyitems(items):\n    items.clear()\n',
            'conftest.py': 'pytest_plugins = ["tests.plugin"]\n',
        },
    },
    {
        id: 'pytest-code-beside-tests-that-decides-nothing', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}def setup_module(module):
    module.ready = True

def test_a(number):
    mark("tests/test_x.py::test_a")

def test_b():
    mark("tests/test_x.py::test_b")

if __name__ == "__main__":
    raise SystemExit(1)
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
            'tests/conftest.py': `import gc
import pytest

def pytest_addoption(parser):
    group = parser.getgroup("mine")
    group.addoption("--mine", action="store_true")
    parser.addini("mine_value", "help")

def pytest_configure(config):
    config.addinivalue_line("markers", "slow: slow tests")
    if config.getoption("--mine"):
        gc.collect()

def pytest_runtest_setup():
    gc.collect()

def pytest_collection():
    gc.disable()

def pytest_report_header():
    return "a header"

def pytest_sessionfinish():
    gc.enable()

@pytest.fixture(autouse=True)
def clean_environ(monkeypatch):
    monkeypatch.delenv("UCN_NOT_SET", raising=False)
    yield

@pytest.fixture
def number():
    return 3
`,
        },
    },
    {
        id: 'pytest-conftest-leaves-a-file-out-of-the-default-run', runner: 'pytest',
        notRunByDefault: ['tests/test_x.py::test_a', 'tests/test_x.py::test_b'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_x.py': `${PY}def test_a():
    mark("tests/test_x.py::test_a")

def test_b():
    mark("tests/test_x.py::test_b")
`,
            'free/__init__.py': '',
            'free/test_free.py': `${PY}def test_free():
    mark("free/test_free.py::test_free")
`,
            'tests/conftest.py': 'collect_ignore = ["test_x.py"]\n',
        },
    },
    // -------------- pytest: tests under names bound without a definition
    {
        id: 'pytest-another-name-for-a-function', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}def test_actual():
    mark(rid())

test_alias = test_actual
helper_alias = test_actual
`,
        },
    },
    {
        id: 'pytest-another-name-for-a-class-and-a-method', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}class TestK:
    def test_m(self):
        mark(rid())
    test_n = test_m
    other = test_m

TestAlias = TestK
NotATest = TestK
`,
        },
    },
    {
        id: 'pytest-another-name-for-an-import', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RID}def check():
    mark(rid())

class Checks:
    def test_c(self):
        mark(rid())
`,
            'tests/test_a.py': `from tests.helpers import check, Checks

test_check = check
TestChecks = Checks
`,
        },
    },
    {
        id: 'pytest-import-of-an-import', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}def test_x():
    mark(rid())
`,
            'tests/test_b.py': 'from tests.test_a import test_x\n',
            'tests/test_c.py': 'from tests.test_b import test_x\n',
        },
    },
    {
        id: 'pytest-star-import', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/shared.py': `${PY}${RID}def test_shared():
    mark(rid())

def _test_private():
    mark(rid())

class TestShared:
    def test_m(self):
        mark(rid())
`,
            'tests/test_a.py': 'from tests.shared import *\n',
        },
    },
    {
        id: 'pytest-star-import-of-a-listed-module', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/shared.py': `${PY}${RID}__all__ = ["test_listed"]

def test_listed():
    mark(rid())

def test_unlisted():
    mark(rid())
`,
            'tests/test_a.py': 'from tests.shared import *\n',
        },
    },
    {
        id: 'pytest-star-import-of-a-module-whose-list-is-computed', runner: 'pytest',
        atLeast: ['tests/test_a.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/shared.py': `${PY}${RID}__all__ = [name for name in dir() if name.startswith("test")]

def test_late():
    mark(rid())
`,
            'tests/test_a.py': `${PY}from tests.shared import *

def test_own():
    mark("tests/test_a.py::test_own")
`,
        },
    },
    {
        id: 'pytest-names-bound-without-an-assignment', runner: 'pytest',
        atLeast: ['tests/test_a.py', 'tests/test_b.py', 'tests/test_c.py'],
        undeclared: ['tests/test_a.py::test_made', 'tests/test_b.py::test_dynamic', 'tests/test_c.py::test_set'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}def make():
    def inner():
        mark(rid())
    return inner

test_made = make()

def test_plain():
    mark("tests/test_a.py::test_plain")
`,
            'tests/test_b.py': `${PY}${RID}def body():
    mark(rid())

globals()["test_dynamic"] = body

def test_plain():
    mark("tests/test_b.py::test_plain")
`,
            'tests/test_c.py': `${PY}${RID}import sys

def body():
    mark(rid())

setattr(sys.modules[__name__], "test_set", body)

def test_plain():
    mark("tests/test_c.py::test_plain")
`,
        },
    },
    {
        id: 'pytest-lambda-and-values-under-test-names', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}test_lambda = lambda: mark("tests/test_a.py::test_lambda")
test_data = [1, 2, 3]
test_text = "a"
test_none = None

def test_plain():
    mark("tests/test_a.py::test_plain")
`,
        },
    },
    {
        id: 'pytest-abstract-classes', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}import abc
import unittest

class TestAbs(abc.ABC):
    @abc.abstractmethod
    def make(self): ...
    def test_x(self):
        mark(rid())

class TestImpl(TestAbs):
    def make(self):
        return 1

class TestNoMeta:
    @abc.abstractmethod
    def make(self): ...
    def test_x(self):
        mark(rid())

class UTAbs(unittest.TestCase, abc.ABC):
    @abc.abstractmethod
    def make(self): ...
    def test_x(self):
        mark(rid())

class UTImpl(UTAbs):
    def make(self):
        return 1
`,
        },
    },
    {
        id: 'pytest-unittest-loader-rules', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}import unittest

class UT(unittest.TestCase):
    def test_a(self):
        mark(rid())
    test_a.__test__ = False
    def test_b(self):
        mark(rid())
    def check(self):
        mark(rid())

class UTRun(unittest.TestCase):
    def runTest(self):
        mark(rid())

class TestHolder(unittest.TestCase):
    class TestInner:
        def test_i(self):
            mark(rid())
    def test_o(self):
        mark(rid())

class Child(UT):
    test_b = None
    def test_c(self):
        mark(rid())
`,
        },
    },
    {
        id: 'pytest-class-inside-a-class-not-collected', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}class Outer:
    class TestInner:
        def test_i(self):
            mark(rid())

class TestOuterOff:
    __test__ = False
    class TestInner2:
        def test_i(self):
            mark(rid())

class TestOuter:
    class TestInner3:
        def test_i(self):
            mark(rid())
`,
        },
    },
    {
        id: 'pytest-counts-of-parametrized-tests', runner: 'pytest',
        atLeast: ['tests/test_a.py', 'tests/test_b.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}import pytest

@pytest.fixture(params=[1, 2])
def twice(request):
    return request.param

def test_fixture_table(twice):
    mark("tests/test_a.py::test_fixture_table")

def test_plain():
    mark("tests/test_a.py::test_plain")
`,
            'tests/test_b.py': `${PY}import pytest

pytestmark = pytest.mark.parametrize("v", [1, 2])

def test_module_table(v):
    mark("tests/test_b.py::test_module_table")
`,
            'tests/test_c.py': `${PY}def test_exact():
    mark("tests/test_c.py::test_exact")
`,
        },
    },
    // ------------------- tests a file runs and does not declare in place
    {
        id: 'node-test-call-not-read-beside-tests', runner: 'node-test',
        atLeast: ['test/a.test.js'],
        undeclared: ['test/a.test.js::through a name that is not read'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/a.test.js': `${CJS}const { test, it } = require('node:test');
const maybe = process.env.UCN_NEVER ? it.skip : it;
maybe('through a name that is not read', () => { mark('test/a.test.js::through a name that is not read'); });
test('read', () => { mark('test/a.test.js::read'); });
`,
        },
    },
    {
        id: 'node-test-runner-function-handed-on', runner: 'node-test',
        atLeast: ['test/a.test.js', 'test/b.test.js', 'test/c.test.js'],
        undeclared: ['test/a.test.js::through a parameter', 'test/b.test.js::through a list', 'test/c.test.js::through call'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/a.test.js': `${CJS}const { test } = require('node:test');
function define(fn) { fn('through a parameter', () => { mark('test/a.test.js::through a parameter'); }); }
define(test);
test('read', () => { mark('test/a.test.js::read'); });
`,
            'test/b.test.js': `${CJS}const { test } = require('node:test');
[test].forEach(each => each('through a list', () => { mark('test/b.test.js::through a list'); }));
test('read', () => { mark('test/b.test.js::read'); });
`,
            'test/c.test.js': `${CJS}const { test } = require('node:test');
test.call(null, 'through call', () => { mark('test/c.test.js::through call'); });
test('read', () => { mark('test/c.test.js::read'); });
`,
        },
    },
    {
        id: 'mocha-function-of-another-module-declares', runner: 'mocha',
        sometimes: ['test/shared.js::behaves'],
        atLeast: ['test/a.test.js', 'test/b.test.js', 'test/shared.js'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n',
            'test/shared.js': `${CJS}module.exports = function behaves(name) {
    it('behaves', function () { mark('test/shared.js::behaves'); });
};
`,
            'test/through.js': 'const behaves = require(\'./shared\');\nmodule.exports = function again(name) { behaves(name); };\n',
            'test/a.test.js': `${CJS}const behaves = require('./shared');
describe('a', function () {
    behaves('a');
    it('own', function () { mark('test/a.test.js::a > own'); });
});
`,
            'test/b.test.js': `${CJS}const again = require('./through');
describe('b', function () {
    again('b');
    it('own', function () { mark('test/b.test.js::b > own'); });
});
`,
            'test/c.test.js': `${CJS}const path = require('path');
describe('c', function () {
    it('own', function () { mark('test/c.test.js::c > own'); path.join('a', 'b'); });
});
`,
        },
    },
    {
        id: 'cargo-tests-a-macro-makes', runner: 'cargo-test',
        atLeast: ['src/lib.rs'],
        undeclared: ['src/lib.rs::made by a macro'],
        repeats: ['src/lib.rs::made by a macro'],
        files: {
            'Cargo.toml': `[package]
name = "case_macro_tests"
version = "0.1.0"
edition = "2021"
`,
            'src/lib.rs': `${RS}
macro_rules! cases {
    ($($name:ident),*) => {
        $(
            #[test]
            fn $name() { crate::mark("src/lib.rs::made by a macro"); }
        )*
    };
}

#[cfg(test)]
mod tests {
    cases!(first, second);

    #[test]
    fn written() { crate::mark("src/lib.rs::tests > written"); }
}
`,
        },
    },
    // ---------------- setup code and names of the project, other runners
    {
        id: 'mocha-setup-hook-skips', runner: 'mocha',
        sometimes: ['test/a.test.js::each > never runs either', 'test/a.test.js::needs a service > never runs'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n',
            'test/a.test.js': `${CJS}describe('needs a service', function () {
    before(function () { this.skip(); });
    it('never runs', function () { mark('test/a.test.js::needs a service > never runs'); });
});
describe('each', function () {
    beforeEach(function () { this.skip(); });
    it('never runs either', function () { mark('test/a.test.js::each > never runs either'); });
});
describe('free', function () {
    before(function () { this.timeout(1000); });
    it('runs', function () { mark('test/a.test.js::free > runs'); });
});
`,
        },
    },
    {
        id: 'vitest-setup-hook-skips', runner: 'vitest',
        sometimes: ['test/a.test.js::each > never runs'],
        files: {
            'package.json': '{ "name": "x", "type": "module", "scripts": { "test": "vitest run" } }\n',
            'test/a.test.js': `${ESM}import { describe, it, beforeEach } from 'vitest';
describe('each', () => {
    beforeEach(context => { context.skip(); });
    it('never runs', () => { mark('test/a.test.js::each > never runs'); });
});
describe('free', () => {
    it('runs', () => { mark('test/a.test.js::free > runs'); });
});
`,
        },
    },
    {
        id: 'maven-names-of-the-project-like-junits', runner: 'maven',
        files: {
            'pom.xml': POM.replace('DEPENDENCIES', JUPITER),
            'src/test/java/com/x/Test.java': `package com.x;

import java.lang.annotation.*;

@Retention(RetentionPolicy.RUNTIME)
public @interface Test {}
`,
            'src/test/java/com/x/Disabled.java': `package com.x;

import java.lang.annotation.*;

@Retention(RetentionPolicy.RUNTIME)
public @interface Disabled {}
`,
            'src/test/java/com/x/BaseTestCase.java': `package com.x;

public class BaseTestCase {
}
`,
            'src/test/java/com/x/OwnAnnotationTest.java': `package com.x;

class OwnAnnotationTest {
${JAVA}
    @Test
    void notJunits() { mark("src/test/java/com/x/OwnAnnotationTest.java::OwnAnnotationTest > notJunits"); }

    @org.junit.jupiter.api.Test
    void junits() { mark("src/test/java/com/x/OwnAnnotationTest.java::OwnAnnotationTest > junits"); }

    @org.junit.jupiter.api.Test
    @Disabled
    void ownDisabledRuns() { mark("src/test/java/com/x/OwnAnnotationTest.java::OwnAnnotationTest > ownDisabledRuns"); }
}
`,
            'src/test/java/com/x/LooksLegacyTest.java': `package com.x;

public class LooksLegacyTest extends BaseTestCase {
${JAVA}
    public void testNotJunit3() { mark("src/test/java/com/x/LooksLegacyTest.java::LooksLegacyTest > testNotJunit3"); }

    @org.junit.jupiter.api.Test
    void real() { mark("src/test/java/com/x/LooksLegacyTest.java::LooksLegacyTest > real"); }
}
`,
        },
    },
    {
        id: 'maven-setup-assumes', runner: 'maven',
        sometimes: ['src/test/java/com/x/AssumeTest.java::AssumeTest > neverRuns'],
        emptyTestFiles: ['src/test/java/com/x/AssumeTest.java'],
        files: {
            'pom.xml': POM.replace('DEPENDENCIES', JUPITER),
            'src/test/java/com/x/AssumeTest.java': `package com.x;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class AssumeTest {
${JAVA}
    @BeforeEach
    void needs() { Assumptions.assumeTrue(System.getenv("UCN_NEVER_SET") != null); }

    @Test
    void neverRuns() { mark("src/test/java/com/x/AssumeTest.java::AssumeTest > neverRuns"); }
}
`,
            'src/test/java/com/x/FreeTest.java': `package com.x;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class FreeTest {
${JAVA}
    int ready;

    @BeforeEach
    void prepare() { ready = 1; }

    @Test
    void runs() { mark("src/test/java/com/x/FreeTest.java::FreeTest > runs"); }
}
`,
        },
    },
    {
        id: 'dotnet-names-of-the-project-like-xunits', runner: 'dotnet-test',
        files: {
            'App.Tests.csproj': CSPROJ(XUNIT),
            'Own.cs': `namespace Own
{
    public class FactAttribute : System.Attribute { }
}
`,
            'Tests.cs': `namespace Own.Tests
{
${CS}
    public class Lookalike
    {
        [Own.Fact]
        public void NotXunits() { Rec.Mark("Tests.cs::Lookalike > NotXunits"); }

        [Xunit.Fact]
        public void Xunits() { Rec.Mark("Tests.cs::Lookalike > Xunits"); }
    }
}
`,
        },
    },
    {
        id: 'dotnet-nunit-setup-ignores', runner: 'dotnet-test',
        sometimes: ['Tests.cs::Guarded > NeverRuns'],
        files: {
            'App.Tests.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net9.0</TargetFramework><IsPackable>false</IsPackable><Nullable>disable</Nullable></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <PackageReference Include="NUnit" Version="3.12.0" />
    <PackageReference Include="NUnit3TestAdapter" Version="4.6.0" />
  </ItemGroup>
</Project>
`,
            'Tests.cs': `using NUnit.Framework;

namespace N.Tests
{
${CS}
    public class Guarded
    {
        [SetUp]
        public void Needs() { Assert.Ignore("not here"); }

        [Test]
        public void NeverRuns() { Rec.Mark("Tests.cs::Guarded > NeverRuns"); }
    }

    public class Free
    {
        [SetUp]
        public void Prepare() { }

        [Test]
        public void Runs() { Rec.Mark("Tests.cs::Free > Runs"); }
    }
}
`,
        },
    },
    {
        id: 'go-test-main-hands-m-on', runner: 'go-test',
        sometimes: ['a_test.go::TestBehind'],
        emptyTestFiles: ['a_test.go'],
        files: {
            'go.mod': `module example.com/alias

go 1.21
`,
            'mark.go': GO('alias'),
            'main_test.go': `package alias

import (
	"os"
	"testing"
)

func run(m *testing.M) int {
	if os.Getenv("UCN_NEVER_SET") == "" {
		return 0
	}
	return m.Run()
}

func TestMain(m *testing.M) {
	os.Exit(run(m))
}
`,
            'a_test.go': `package alias

import "testing"

func TestBehind(t *testing.T) { mark("a_test.go::TestBehind") }
`,
        },
    },
    {
        id: 'go-test-main-keeps-run-and-does-not-call-it', runner: 'go-test',
        sometimes: ['a_test.go::TestBehind'],
        emptyTestFiles: ['a_test.go'],
        files: {
            'go.mod': `module example.com/kept

go 1.21
`,
            'mark.go': GO('kept'),
            'main_test.go': `package kept

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	run := m.Run
	_ = run
	os.Exit(0)
}
`,
            'a_test.go': `package kept

import "testing"

func TestBehind(t *testing.T) { mark("a_test.go::TestBehind") }
`,
        },
    },
    // -------------------------------------- a configuration that is code
    {
        id: 'jest-config-written-out-selects-nothing', runner: 'jest',
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.js': `const path = require('path');

module.exports = {
    verbose: false,
    coverageDirectory: path.join(__dirname, 'coverage'),
    moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
};
`,
            'test/case.test.js': `${CJS}test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${CJS}test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'jest-config-export-written-again', runner: 'jest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.js': 'module.exports = {};\nmodule.exports.testPathIgnorePatterns = [\'case.test.js\'];\n',
            'test/case.test.js': `${CJS}test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${CJS}test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'jest-config-object-under-a-name-used-again', runner: 'jest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.js': `const config = {};
config.testPathIgnorePatterns = ['case.test.js'];
module.exports = config;
`,
            'test/case.test.js': `${CJS}test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${CJS}test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'jest-config-through-a-function-of-the-file', runner: 'jest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.js': 'function defineConfig(config) { return { ...config, testPathIgnorePatterns: [\'case.test.js\'] }; }\nmodule.exports = defineConfig({});\n',
            'test/case.test.js': `${CJS}test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${CJS}test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'jest-config-list-filled-after', runner: 'jest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.js': `const config = { testPathIgnorePatterns: [] };
config.testPathIgnorePatterns.push('case.test.js');
module.exports = config;
`,
            'test/case.test.js': `${CJS}test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${CJS}test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'jest-config-object-assign-on-the-export', runner: 'jest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.js': 'module.exports = {};\nObject.assign(module.exports, { testPathIgnorePatterns: [\'case.test.js\'] });\n',
            'test/case.test.js': `${CJS}test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${CJS}test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'jest-config-module-under-another-name', runner: 'jest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.js': `module.exports = {};
const m = module;
m.exports.testPathIgnorePatterns = ['case.test.js'];
`,
            'test/case.test.js': `${CJS}test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${CJS}test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'jest-config-esm-written-after-the-export', runner: 'jest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.mjs': `const config = {};
export default config;
config.testPathIgnorePatterns = ['case.test.js'];
`,
            'test/case.test.js': `${CJS}test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${CJS}test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'jest-config-changed-by-a-function-called', runner: 'jest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.js': `const config = {};
function tune(c) { c.testPathIgnorePatterns = ['case.test.js']; }
tune(config);
module.exports = config;
`,
            'test/case.test.js': `${CJS}test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${CJS}test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'jest-config-value-under-a-name-used-again', runner: 'jest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.js': `const ignored = [];
ignored.push('case.test.js');
module.exports = { testPathIgnorePatterns: ignored };
`,
            'test/case.test.js': `${CJS}test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${CJS}test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'jest-config-exported-twice', runner: 'jest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.js': 'module.exports = {};\nif (true) { module.exports = { testPathIgnorePatterns: [\'case.test.js\'] }; }\n',
            'test/case.test.js': `${CJS}test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${CJS}test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'jest-config-written-in-a-value', runner: 'jest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.js': 'module.exports = { verbose: (() => { module.exports.testPathIgnorePatterns = [\'case.test.js\']; return false; })() };\n',
            'test/case.test.js': `${CJS}test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${CJS}test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'jest-config-define-property', runner: 'jest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.js': `const config = {};
Object.defineProperty(config, 'testPathIgnorePatterns', { value: ['case.test.js'], enumerable: true });
module.exports = config;
`,
            'test/case.test.js': `${CJS}test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${CJS}test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'jest-config-through-the-module-cache', runner: 'jest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.js': 'module.exports = {};\nrequire.cache[__filename].exports.testPathIgnorePatterns = [\'case.test.js\'];\n',
            'test/case.test.js': `${CJS}test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${CJS}test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'jest-config-json-with-comments', runner: 'jest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" } }\n',
            'jest.config.json': `{
  // unit tests only
  "testPathIgnorePatterns": ["/a/*", "/b*/", "case.test.js"]
}
`,
            'test/case.test.js': `${CJS}test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${CJS}test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'vitest-config-written-out-selects-nothing', runner: 'vitest',
        files: {
            'package.json': '{ "name": "x", "type": "module", "scripts": { "test": "vitest run" } }\n',
            'vitest.config.js': `import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: { alias: { '@': resolve('./src') } },
    test: { globals: false, reporters: process.env.CI ? ['dot'] : ['default'] },
});
`,
            'test/case.test.js': `${ESM}import { test } from 'vitest';
test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${ESM}import { test } from 'vitest';
test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'vitest-config-written-after-define', runner: 'vitest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "type": "module", "scripts": { "test": "vitest run" } }\n',
            'vitest.config.js': `import { defineConfig } from 'vitest/config';
const config = defineConfig({ test: {} });
config.test.exclude = ['**/case.test.js'];
export default config;
`,
            'test/case.test.js': `${ESM}import { test } from 'vitest';
test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${ESM}import { test } from 'vitest';
test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'vitest-config-define-config-of-the-file', runner: 'vitest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "type": "module", "scripts": { "test": "vitest run" } }\n',
            'vitest.config.js': 'function defineConfig(config) { return { test: { exclude: [\'**/case.test.js\'] } }; }\nexport default defineConfig({ test: {} });\n',
            'test/case.test.js': `${ESM}import { test } from 'vitest';
test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${ESM}import { test } from 'vitest';
test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'vitest-config-define-config-of-another-file', runner: 'vitest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "type": "module", "scripts": { "test": "vitest run" } }\n',
            'define.js': 'export function defineConfig(config) { return { test: { exclude: [\'**/case.test.js\'] } }; }\n',
            'vitest.config.js': 'import { defineConfig } from \'./define.js\';\nexport default defineConfig({ test: {} });\n',
            'test/case.test.js': `${ESM}import { test } from 'vitest';
test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${ESM}import { test } from 'vitest';
test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'vitest-config-plugin-written-in-the-file', runner: 'vitest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "type": "module", "scripts": { "test": "vitest run" } }\n',
            'vitest.config.js': 'import { defineConfig } from \'vitest/config\';\nexport default defineConfig({ plugins: [{ name: \'x\', config: () => ({ test: { exclude: [\'**/case.test.js\'] } }) }], test: {} });\n',
            'test/case.test.js': `${ESM}import { test } from 'vitest';
test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${ESM}import { test } from 'vitest';
test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'vitest-config-test-object-under-a-name-used-again', runner: 'vitest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "type": "module", "scripts": { "test": "vitest run" } }\n',
            'vitest.config.js': `import { defineConfig } from 'vitest/config';
const settings = {};
settings.exclude = ['**/case.test.js'];
export default defineConfig({ test: settings });
`,
            'test/case.test.js': `${ESM}import { test } from 'vitest';
test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${ESM}import { test } from 'vitest';
test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'vitest-config-define-config-shadowed', runner: 'vitest',
        notRunByDefault: ['test/case.test.js::left out'],
        files: {
            'package.json': '{ "name": "x", "type": "module", "scripts": { "test": "vitest run" } }\n',
            'vitest.config.js': `import { defineConfig as defineProject } from 'vitest/config';
const defineConfig = c => ({ test: { exclude: ['**/case.test.js'] } });
export default defineConfig(defineProject({ test: {} }));
`,
            'test/case.test.js': `${ESM}import { test } from 'vitest';
test('left out', () => { mark('test/case.test.js::left out'); });
`,
            'test/kept.test.js': `${ESM}import { test } from 'vitest';
test('kept', () => { mark('test/kept.test.js::kept'); });
`,
        },
    },
    {
        id: 'mocha-config-written-out-selects-nothing', runner: 'mocha',
        full: 'npx mocha',
        notRunByDefault: ['other/extra.js::where the configuration points'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n',
            '.mocharc.js': 'module.exports = { timeout: 4000 };\n',
            'test/case.test.js': `${CJS}it('in the default place', function () { mark('test/case.test.js::in the default place'); });
`,
            'other/extra.js': `${CJS}it('where the configuration points', function () { mark('other/extra.js::where the configuration points'); });
`,
        },
    },
    {
        id: 'mocha-config-export-written-again', runner: 'mocha',
        full: 'npx mocha',
        notRunByDefault: ['test/case.test.js::in the default place'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n',
            '.mocharc.js': 'module.exports = {};\nmodule.exports.spec = [\'other/extra.js\'];\n',
            'test/case.test.js': `${CJS}it('in the default place', function () { mark('test/case.test.js::in the default place'); });
`,
            'other/extra.js': `${CJS}it('where the configuration points', function () { mark('other/extra.js::where the configuration points'); });
`,
        },
    },
    {
        id: 'mocha-config-object-under-a-name-used-again', runner: 'mocha',
        full: 'npx mocha',
        notRunByDefault: ['test/case.test.js::in the default place'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n',
            '.mocharc.cjs': `const config = { timeout: 4000 };
config.spec = ['other/extra.js'];
module.exports = config;
`,
            'test/case.test.js': `${CJS}it('in the default place', function () { mark('test/case.test.js::in the default place'); });
`,
            'other/extra.js': `${CJS}it('where the configuration points', function () { mark('other/extra.js::where the configuration points'); });
`,
        },
    },
    {
        id: 'mocha-config-yaml-on-one-line', runner: 'mocha',
        full: 'npx mocha',
        notRunByDefault: ['test/case.test.js::in the default place'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n',
            '.mocharc.yml': '{ spec: [other/extra.js] }\n',
            'test/case.test.js': `${CJS}it('in the default place', function () { mark('test/case.test.js::in the default place'); });
`,
            'other/extra.js': `${CJS}it('where the configuration points', function () { mark('other/extra.js::where the configuration points'); });
`,
        },
    },
    {
        id: 'mocha-config-yaml-keys-indented', runner: 'mocha',
        full: 'npx mocha',
        notRunByDefault: ['test/case.test.js::in the default place'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n',
            '.mocharc.yml': '  spec: other/extra.js\n  timeout: 4000\n',
            'test/case.test.js': `${CJS}it('in the default place', function () { mark('test/case.test.js::in the default place'); });
`,
            'other/extra.js': `${CJS}it('where the configuration points', function () { mark('other/extra.js::where the configuration points'); });
`,
        },
    },
    {
        id: 'mocha-config-yaml-key-written-apart', runner: 'mocha',
        full: 'npx mocha',
        notRunByDefault: ['test/case.test.js::in the default place'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n',
            '.mocharc.yml': '? spec\n: other/extra.js\n',
            'test/case.test.js': `${CJS}it('in the default place', function () { mark('test/case.test.js::in the default place'); });
`,
            'other/extra.js': `${CJS}it('where the configuration points', function () { mark('other/extra.js::where the configuration points'); });
`,
        },
    },
    {
        id: 'mocha-config-yaml-merged-keys', runner: 'mocha',
        full: 'npx mocha',
        notRunByDefault: ['test/case.test.js::in the default place'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n',
            '.mocharc.yml': `base: &base
  spec: other/extra.js
<<: *base
`,
            'test/case.test.js': `${CJS}it('in the default place', function () { mark('test/case.test.js::in the default place'); });
`,
            'other/extra.js': `${CJS}it('where the configuration points', function () { mark('other/extra.js::where the configuration points'); });
`,
        },
    },
    {
        id: 'mocha-config-yaml-key-escaped', runner: 'mocha',
        full: 'npx mocha',
        notRunByDefault: ['test/case.test.js::in the default place'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n',
            '.mocharc.yml': '"sp\\u0065c": other/extra.js\n',
            'test/case.test.js': `${CJS}it('in the default place', function () { mark('test/case.test.js::in the default place'); });
`,
            'other/extra.js': `${CJS}it('where the configuration points', function () { mark('other/extra.js::where the configuration points'); });
`,
        },
    },
    {
        id: 'mocha-config-json-with-comments', runner: 'mocha',
        full: 'npx mocha',
        notRunByDefault: ['test/case.test.js::in the default place'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" } }\n',
            '.mocharc.jsonc': `{
  // extra files
  "spec": ["other/extra.js"] /* trailing */
}
`,
            'test/case.test.js': `${CJS}it('in the default place', function () { mark('test/case.test.js::in the default place'); });
`,
            'other/extra.js': `${CJS}it('where the configuration points', function () { mark('other/extra.js::where the configuration points'); });
`,
        },
    },
    // --------------------------------------- pytest: options of the ini file
    {
        id: 'pytest-fixtures-the-ini-file-gives-every-test', runner: 'pytest',
        sometimes: ['tests/test_a.py::test_x'],
        emptyTestFiles: ['tests/test_a.py'],
        files: {
            'pytest.ini': '[pytest]\nusefixtures = db\n',
            'conftest.py': 'import pytest\n\n@pytest.fixture\ndef db():\n    pytest.skip("no db")\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}def test_x():
    mark("tests/test_a.py::test_x")
`,
        },
    },
    {
        id: 'pytest-imported-tests-the-ini-file-leaves-out', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\ncollect_imported_tests = false\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}def test_x():
    mark(rid())

class TestK:
    def test_m(self):
        mark(rid())
`,
            'tests/test_b.py': `${PY}${RID}from tests.test_a import test_x, TestK
from tests.test_a import *

def test_own():
    mark(rid())

test_alias = test_own
test_alias_of_import = test_x
TestAlias = TestK
`,
        },
    },
    {
        // The call that stops a test stands in another module of the
        // project: followed one module deep from a fixture, a setup, a
        // hook and the module's own statements.
        id: 'pytest-stopping-call-in-another-module', runner: 'pytest',
        sometimes: [
            'stopped/test_s.py::test_under_a_hook_that_calls_a_skip',
            'tests/test_a.py::test_needs',
            'tests/test_b.py::test_behind_the_module',
            'tests/test_c.py::TestNeeds > test_m',
        ],
        emptyTestFiles: ['stopped/test_s.py', 'tests/test_b.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'hooked/__init__.py': '',
            'stopped/__init__.py': '',
            'stopped/conftest.py': 'from tests.helpers import need_service\n\ndef pytest_runtest_setup(item):\n    need_service()\n',
            'stopped/test_s.py': `${PY}def test_under_a_hook_that_calls_a_skip():
    mark("stopped/test_s.py::test_under_a_hook_that_calls_a_skip")
`,
            'tests/helpers.py': 'import pytest\n\ndef need_service():\n    pytest.skip("no service", allow_module_level=True)\n\ndef make():\n    return 1\n',
            'tests/conftest.py': 'import pytest\nfrom tests.helpers import need_service, make\n\n@pytest.fixture\ndef service():\n    need_service()\n\n@pytest.fixture\ndef thing():\n    return make()\n',
            'tests/test_a.py': `${PY}def test_needs(service):
    mark("tests/test_a.py::test_needs")

def test_plain(thing):
    mark("tests/test_a.py::test_plain")
`,
            'tests/test_b.py': `${PY}from tests import helpers

helpers.need_service()

def test_behind_the_module():
    mark("tests/test_b.py::test_behind_the_module")
`,
            'tests/test_c.py': `${PY}from tests.helpers import need_service, make

class TestNeeds:
    def setup_method(self):
        need_service()

    def test_m(self):
        mark("tests/test_c.py::TestNeeds > test_m")

class TestFree:
    def setup_method(self):
        self.thing = make()

    def test_m(self):
        mark("tests/test_c.py::TestFree > test_m")
`,
            'hooked/conftest.py': 'from tests.helpers import make\n\ndef pytest_runtest_setup(item):\n    make()\n',
            'hooked/test_h.py': `${PY}def test_under_a_hook_that_calls_the_project():
    mark("hooked/test_h.py::test_under_a_hook_that_calls_the_project")
`,
        },
    },
    {
        // A switch written on a class taken from another module: it holds
        // for the classes of the writing module that derive from it, and
        // (measured) for every module pytest loads after that one, which
        // is why the writing module is never joined with another file.
        id: 'pytest-switch-written-on-an-imported-base', runner: 'pytest',
        // The whole run loads the writer before test_c.py and after test_a.py.
        sometimes: ['tests/test_a.py::TestHome > test_m', 'tests/test_c.py::TestLater > test_m'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RID}class Base:
    def test_m(self):
        mark(rid())

class TestHome(Base):
    pass
`,
            'tests/test_b.py': `${PY}from tests.test_a import Base

Base.__test__ = False

class TestDerivedHere(Base):
    def test_own(self):
        mark("tests/test_b.py::TestDerivedHere > test_own")

def test_free():
    mark("tests/test_b.py::test_free")
`,
            'tests/test_c.py': `from tests.test_a import Base

class TestLater(Base):
    pass
`,
        },
    },
    // ------ pytest: a switch is the state of an object, whoever holds it
    {
        id: 'pytest-object-off-then-on-by-importer', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RIDP}def helper():
    mark(rid())

helper.__test__ = False
`,
            'tests/test_case.py': 'from tests.helpers import helper as test_actual\ntest_actual.__test__ = True\n',
        },
    },
    {
        id: 'pytest-object-off-and-imported', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RIDP}def helper():
    mark(rid())

helper.__test__ = False
`,
            'tests/test_case.py': `${PY}def test_own():
    mark("tests/test_case.py::test_own")

from tests.helpers import helper as test_actual
`,
        },
    },
    {
        id: 'pytest-object-on-by-importer-any-name', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RIDP}def helper():
    mark(rid())
`,
            'tests/test_case.py': 'from tests.helpers import helper\nhelper.__test__ = True\n',
        },
    },
    {
        id: 'pytest-object-off-by-importer-loaded-later', runner: 'pytest',
        sometimes: ['tests/test_a.py::test_x'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_a.py': `${PY}${RIDP}def test_x():
    mark(rid())
`,
            'tests/test_b.py': `${PY}from tests.test_a import test_x
test_x.__test__ = False

def test_own():
    mark("tests/test_b.py::test_own")
`,
        },
    },
    {
        id: 'pytest-object-off-by-importer-loaded-first', runner: 'pytest',
        sometimes: ['tests/test_b.py::test_x'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_b.py': `${PY}${RIDP}def test_x():
    mark(rid())
`,
            'tests/test_a.py': `${PY}from tests.test_b import test_x
test_x.__test__ = False

def test_own():
    mark("tests/test_a.py::test_own")
`,
        },
    },
    {
        id: 'pytest-object-fixture-imported-as-test', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `import pytest

@pytest.fixture
def fix():
    return 1
`,
            'tests/test_case.py': `${PY}def test_own():
    mark("tests/test_case.py::test_own")

from tests.helpers import fix as test_fix
`,
        },
    },
    {
        id: 'pytest-object-alias-of-off', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}def test_own():
    mark("tests/test_case.py::test_own")
${RIDP}
def helper():
    mark(rid())

helper.__test__ = False
test_alias = helper
`,
        },
    },
    {
        id: 'pytest-object-alias-in-helper-imported', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RIDP}def helper():
    mark(rid())

other = helper
`,
            'tests/test_case.py': 'from tests.helpers import other as test_o\n',
        },
    },
    {
        id: 'pytest-object-method-off-in-base', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RIDP}class Base:
    def test_m(self):
        mark(rid())
    test_m.__test__ = False
    def test_n(self):
        mark(rid())
`,
            'tests/test_case.py': `from tests.helpers import Base

class TestK(Base):
    pass
`,
        },
    },
    {
        id: 'pytest-object-class-off-then-on-by-importer', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RIDP}class K:
    __test__ = False
    def test_m(self):
        mark(rid())
`,
            'tests/test_case.py': 'from tests.helpers import K as TestK\nTestK.__test__ = True\n',
            'tests/test_other.py': 'from tests.helpers import K\nK.__test__ = True\n',
        },
    },
    {
        id: 'pytest-object-off-then-on-two-test-files', runner: 'pytest',
        sometimes: ['tests/test_helpers.py::helper'],
        onlyInWholeRun: ['tests/test_helpers.py::helper'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_helpers.py': `${PY}${RIDP}def helper():
    mark(rid())

helper.__test__ = False

def test_own():
    mark("tests/test_helpers.py::test_own")
`,
            'tests/test_case.py': 'from tests.test_helpers import helper as test_actual\ntest_actual.__test__ = True\n',
        },
    },
    {
        id: 'pytest-object-switch-in-a-branch-by-importer', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_actual'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RIDP}def helper():
    mark(rid())

helper.__test__ = False
`,
            'tests/test_case.py': `${PY}def test_own():
    mark("tests/test_case.py::test_own")

from tests.helpers import helper as test_actual
if os.environ.get("UCN_NEVER"):
    test_actual.__test__ = True
`,
        },
    },
    {
        id: 'pytest-object-module-off-origin', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_off.py': `${PY}${RIDP}__test__ = False

def test_x():
    mark(rid())
`,
            'tests/test_case.py': 'from tests.test_off import test_x\n',
        },
    },
    {
        id: 'pytest-object-off-on-in-origin-then-imported', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RIDP}def helper():
    mark(rid())

helper.__test__ = False
helper.__test__ = True
`,
            'tests/test_case.py': 'from tests.helpers import helper\n',
        },
    },
    {
        id: 'pytest-object-star-import-of-off', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RIDP}def test_shared():
    mark(rid())

test_shared.__test__ = False

def test_kept():
    mark(rid())
`,
            'tests/test_case.py': 'from tests.helpers import *\n',
        },
    },
    {
        id: 'pytest-object-star-import-then-on', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RIDP}def test_shared():
    mark(rid())

test_shared.__test__ = False
`,
            'tests/test_case.py': 'from tests.helpers import *\ntest_shared.__test__ = True\n',
        },
    },
    {
        id: 'pytest-object-off-method-alias-in-subclass', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RIDP}class Base:
    def check(self):
        mark(rid())
    check.__test__ = False
`,
            'tests/test_case.py': `${PY}def test_own():
    mark("tests/test_case.py::test_own")

from tests.helpers import Base

class TestK(Base):
    test_again = Base.check
`,
        },
    },
    {
        id: 'pytest-object-switch-through-another-name', runner: 'pytest',
        sometimes: ['tests/test_case.py::TestK > test_m', 'tests/test_case.py::helper', 'tests/test_case.py::test_x'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RIDP}def helper():
    mark(rid())

helper.__test__ = False

class Base:
    def test_m(self):
        mark(rid())
    test_m.__test__ = False
`,
            'tests/test_case.py': `from tests.helpers import helper, Base

test_x = helper
test_x.__test__ = True

class TestK(Base):
    pass

Base.test_m.__test__ = True
`,
        },
    },
    // ---- pytest: a class has the constructor its lookup order binds first
    {
        id: 'pytest-constructor-reset', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}class Base:
    def __init__(self): pass
    def test_actual(self):
        mark(rid())

class TestActual(Base):
    __init__ = object.__init__
`,
        },
    },
    {
        id: 'pytest-constructor-reset-support-base', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RIDP}class Base:
    def __init__(self): pass
    def test_actual(self):
        mark(rid())
`,
            'tests/test_case.py': `from tests.helpers import Base

class TestActual(Base):
    __init__ = object.__init__
`,
        },
    },
    {
        id: 'pytest-constructor-new-reset-support-base', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RIDP}class Base:
    def __new__(cls): return object.__new__(cls)
    def test_actual(self):
        mark(rid())
`,
            'tests/test_case.py': `from tests.helpers import Base

class TestActual(Base):
    __new__ = object.__new__
`,
        },
    },
    {
        id: 'pytest-constructor-init-none', runner: 'pytest',
        sometimes: ['tests/test_case.py::TestActual > test_actual'],
        emptyTestFiles: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}class Base:
    def __init__(self): pass
    def test_actual(self):
        mark(rid())

class TestActual(Base):
    __init__ = None
`,
        },
    },
    {
        id: 'pytest-constructor-reset-in-the-middle', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}class Base:
    def __init__(self): pass
    def test_actual(self):
        mark(rid())

class Mid(Base):
    __init__ = object.__init__

class TestActual(Mid):
    pass
`,
        },
    },
    {
        id: 'pytest-constructor-custom-after-reset', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}class Base:
    def __init__(self): pass
    def test_actual(self):
        mark(rid())

class Mid(Base):
    __init__ = object.__init__

class TestActual(Mid):
    def __init__(self): pass

def test_own():
    mark("tests/test_case.py::test_own")
`,
        },
    },
    {
        id: 'pytest-constructor-init-of-a-plain-class', runner: 'pytest',
        sometimes: ['tests/test_case.py::TestActual > test_actual'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}class Base:
    def __init__(self): pass
    def test_actual(self):
        mark(rid())

class Plain:
    pass

class TestActual(Base):
    __init__ = Plain.__init__
`,
        },
    },
    {
        id: 'pytest-constructor-init-deleted', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}class TestActual:
    def __init__(self): pass
    del __init__
    def test_m(self):
        mark(rid())
`,
        },
    },
    {
        id: 'pytest-constructor-lookup-order-of-two-bases', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}class A:
    def __init__(self): pass

class B:
    __init__ = object.__init__

class TestBA(B, A):
    def test_m(self):
        mark(rid())

class TestAB(A, B):
    def test_m(self):
        mark(rid())
`,
        },
    },
    {
        id: 'pytest-constructor-set-from-outside', runner: 'pytest',
        sometimes: ['tests/test_case.py::TestActual > test_actual'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}class Base:
    def __init__(self): pass
    def test_actual(self):
        mark(rid())

class TestActual(Base):
    pass

TestActual.__init__ = object.__init__
`,
        },
    },
    {
        id: 'pytest-constructor-dataclass', runner: 'pytest',
        sometimes: ['tests/test_case.py::TestData > test_m'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}import dataclasses

@dataclasses.dataclass
class TestData:
    x: int = 0
    def test_m(self):
        mark(rid())

def test_own():
    mark("tests/test_case.py::test_own")
`,
        },
    },
    {
        id: 'pytest-constructor-builtin-bases', runner: 'pytest',
        sometimes: ['tests/test_case.py::TestDict > test_m', 'tests/test_case.py::TestEnum > test_m', 'tests/test_case.py::TestError > test_m'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}import enum
import typing

T = typing.TypeVar("T")

class TestError(Exception):
    def test_m(self):
        mark(rid())

class TestDict(dict):
    def test_m(self):
        mark(rid())

class TestProtocol(typing.Protocol):
    def test_m(self):
        mark(rid())

class TestGeneric(typing.Generic[T]):
    def test_m(self):
        mark(rid())

class TestObject(object):
    def test_m(self):
        mark(rid())

class TestEnum(enum.Enum):
    def test_m(self):
        mark(rid())

def test_own():
    mark("tests/test_case.py::test_own")
`,
        },
    },
    {
        id: 'pytest-constructor-new-custom-and-reset', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}class Base:
    def __new__(cls): return object.__new__(cls)
    def test_actual(self):
        mark(rid())

class TestRefused(Base):
    pass

class TestActual(Base):
    __new__ = object.__new__
`,
        },
    },
    {
        id: 'pytest-constructor-init-in-a-branch', runner: 'pytest',
        sometimes: ['tests/test_case.py::TestActual > test_m'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}class TestActual:
    if os.environ.get("UCN_NEVER"):
        def __init__(self): pass
    def test_m(self):
        mark(rid())
`,
        },
    },
    {
        id: 'pytest-constructor-init-a-function-of-the-module', runner: 'pytest',
        sometimes: ['tests/test_case.py::TestRefused > test_m'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}def _init(self):
    pass

class TestRefused:
    __init__ = _init
    def test_m(self):
        mark(rid())

def test_own():
    mark("tests/test_case.py::test_own")
`,
        },
    },
    {
        id: 'pytest-constructor-inherited-runtest', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}import unittest

class Base(unittest.TestCase):
    def runTest(self):
        mark(rid())

class Child(Base):
    pass

class WithTest(Base):
    def test_w(self):
        mark(rid())
`,
        },
    },
    {
        id: 'pytest-constructor-unittest-constructor', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}import unittest

class K(unittest.TestCase):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
    def test_m(self):
        mark(rid())
`,
        },
    },
    {
        id: 'pytest-constructor-reset-over-a-base-not-read', runner: 'pytest',
        sometimes: ['tests/test_case.py::TestOrdered > test_m', 'tests/test_case.py::TestSpace > test_m'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}import collections
import argparse

class TestOrdered(collections.OrderedDict):
    __init__ = object.__init__
    def test_m(self):
        mark(rid())

class TestSpace(argparse.Namespace):
    __init__ = object.__init__
    def test_m(self):
        mark(rid())
`,
        },
    },
    {
        id: 'pytest-constructor-nested-constructor', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}class TestOuter:
    class TestInner:
        def __init__(self): pass
        def test_i(self):
            mark(rid())
    class TestFree:
        def test_f(self):
            mark(rid())
    def test_o(self):
        mark(rid())
`,
        },
    },
    {
        id: 'pytest-constructor-setup-overridden', runner: 'pytest',
        sometimes: ['tests/test_case.py::TestK > test_m'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RIDP}import pytest

class Base:
    def setup_method(self):
        pytest.skip("no")
    def test_m(self):
        mark(rid())
`,
            'tests/test_case.py': `from tests.helpers import Base

class TestK(Base):
    def setup_method(self):
        self.ready = True
`,
        },
    },
    {
        id: 'pytest-constructor-marks-reset-in-subclass', runner: 'pytest',
        emptyTestFiles: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}import pytest

@pytest.mark.skip(reason="base")
class Base:
    def test_m(self):
        mark(rid())

class TestK(Base):
    pytestmark = []
`,
        },
    },
    {
        id: 'pytest-constructor-switch-on-then-constructor', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}${RIDP}class Helper:
    __test__ = True
    def __init__(self): pass
    def test_m(self):
        mark(rid())

def test_own():
    mark("tests/test_case.py::test_own")
`,
        },
    },
    // ---- pytest: a table of parameters runs the body through a row that does
    {
        id: 'pytest-rows-skip-all', runner: 'pytest',
        emptyTestFiles: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

@pytest.mark.parametrize("value", [pytest.param(1, marks=pytest.mark.skip(reason="off"))])
def test_actual(value):
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-rows-fixture-skip-all', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_actual'],
        emptyTestFiles: ['tests/test_case.py'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

@pytest.fixture(params=[pytest.param(1, marks=pytest.mark.skip(reason="off"))])
def value(request): return request.param

def test_actual(value):
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-rows-xfail-no-run', runner: 'pytest',
        emptyTestFiles: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

@pytest.mark.parametrize("value", [pytest.param(1, marks=pytest.mark.xfail(run=False))])
def test_actual(value):
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-rows-skip-some', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

@pytest.mark.parametrize("value", [pytest.param(1, marks=pytest.mark.skip(reason="off")), 2])
def test_actual(value):
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-rows-skipif-all', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_actual'],
        emptyTestFiles: ['tests/test_case.py'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

@pytest.mark.parametrize("value", [pytest.param(1, marks=pytest.mark.skipif(True, reason="off"))])
def test_actual(value):
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-rows-row-by-name', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

OFF = pytest.param(1, marks=pytest.mark.skip(reason="off"))
ON = pytest.param(2)

@pytest.mark.parametrize("value", [OFF])
def test_off(value):
    mark("tests/test_case.py::test_off")

@pytest.mark.parametrize("value", [ON])
def test_on(value):
    mark("tests/test_case.py::test_on")
`,
        },
    },
    {
        id: 'pytest-rows-row-by-helper', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_off'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

def off(v):
    return pytest.param(v, marks=pytest.mark.skip(reason="off"))

def plain(v):
    return v + 1

@pytest.mark.parametrize("value", [off(1)])
def test_off(value):
    mark("tests/test_case.py::test_off")

@pytest.mark.parametrize("value", [plain(1)])
def test_on(value):
    mark("tests/test_case.py::test_on")
`,
        },
    },
    {
        id: 'pytest-rows-row-imported', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_call_off', 'tests/test_case.py::test_module_off', 'tests/test_case.py::test_off'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/cases.py': `import pytest

OFF = pytest.param(1, marks=pytest.mark.skip(reason="off"))
ON = 2

class Kind:
    A = 1
    OFF = pytest.param(1, marks=pytest.mark.skip(reason="off"))

def off(v):
    return pytest.param(v, marks=pytest.mark.skip(reason="off"))

def plain(v):
    return v
`,
            'tests/test_case.py': `${PY}import pytest

from tests.cases import OFF, ON, Kind, off, plain
from tests import cases

@pytest.mark.parametrize("value", [OFF])
def test_off(value):
    mark("tests/test_case.py::test_off")

@pytest.mark.parametrize("value", [ON])
def test_on(value):
    mark("tests/test_case.py::test_on")

@pytest.mark.parametrize("value", [cases.OFF])
def test_module_off(value):
    mark("tests/test_case.py::test_module_off")

@pytest.mark.parametrize("value", [cases.ON])
def test_module_on(value):
    mark("tests/test_case.py::test_module_on")

@pytest.mark.parametrize("value", [Kind.A])
def test_member_on(value):
    mark("tests/test_case.py::test_member_on")

@pytest.mark.parametrize("value", [Kind.OFF])
def test_member_off(value):
    mark("tests/test_case.py::test_member_off")

@pytest.mark.parametrize("value", [off(1)])
def test_call_off(value):
    mark("tests/test_case.py::test_call_off")

@pytest.mark.parametrize("value", [plain(1)])
def test_call_on(value):
    mark("tests/test_case.py::test_call_on")

@pytest.mark.parametrize("value", [Kind])
def test_class_on(value):
    mark("tests/test_case.py::test_class_on")
`,
        },
    },
    {
        id: 'pytest-rows-class-level', runner: 'pytest',
        emptyTestFiles: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

@pytest.mark.parametrize("value", [pytest.param(1, marks=pytest.mark.skip(reason="off"))])
class TestK:
    def test_m(self, value):
        mark("tests/test_case.py::TestK > test_m")

class TestL:
    pytestmark = pytest.mark.parametrize("value", [pytest.param(1, marks=pytest.mark.skip(reason="off"))])
    def test_m(self, value):
        mark("tests/test_case.py::TestL > test_m")
`,
        },
    },
    {
        id: 'pytest-rows-module-level', runner: 'pytest',
        emptyTestFiles: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

pytestmark = pytest.mark.parametrize("value", [pytest.param(1, marks=pytest.mark.skip(reason="off"))])

def test_actual(value):
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-rows-row-usefixtures', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_actual'],
        emptyTestFiles: ['tests/test_case.py'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/conftest.py': `import pytest

@pytest.fixture
def db():
    pytest.skip("no db")
`,
            'tests/test_case.py': `${PY}import pytest

@pytest.mark.parametrize("value", [pytest.param(1, marks=pytest.mark.usefixtures("db"))])
def test_actual(value):
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-rows-indirect', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_actual'],
        emptyTestFiles: ['tests/test_case.py'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

@pytest.fixture
def value(request):
    pytest.skip("no")

@pytest.mark.parametrize("value", [1], indirect=True)
def test_actual(value):
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-rows-param-imported-by-name', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}from pytest import mark as m, param
import pytest

@m.parametrize("value", [param(1, marks=m.skip(reason="off"))])
def test_off(value):
    mark("tests/test_case.py::test_off")

@m.parametrize("value", [param(1)])
def test_on(value):
    mark("tests/test_case.py::test_on")
`,
        },
    },
    {
        id: 'pytest-rows-rows-by-name', runner: 'pytest',
        emptyTestFiles: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

ROWS = [pytest.param(1, marks=pytest.mark.skip(reason="off"))]

@pytest.mark.parametrize("value", ROWS)
def test_actual(value):
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-rows-rows-starred', runner: 'pytest',
        emptyTestFiles: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

ROWS = [pytest.param(1, marks=pytest.mark.skip(reason="off"))]
NONE = []

@pytest.mark.parametrize("value", [*ROWS])
def test_off(value):
    mark("tests/test_case.py::test_off")

@pytest.mark.parametrize("value", [*NONE])
def test_none(value):
    mark("tests/test_case.py::test_none")
`,
        },
    },
    {
        id: 'pytest-rows-stacked', runner: 'pytest',
        emptyTestFiles: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

@pytest.mark.parametrize("other", [1, 2])
@pytest.mark.parametrize("value", [pytest.param(1, marks=pytest.mark.skip(reason="off"))])
def test_actual(value, other):
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-rows-rows-that-run', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': `[pytest]
markers =
    slow: slow
`,
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

import decimal

class Kind:
    A = 1

def make(v):
    return [v]

@pytest.mark.parametrize("value", [pytest.param(1, marks=pytest.mark.xfail(strict=False))])
def test_xfail(value):
    mark("tests/test_case.py::test_xfail")

@pytest.mark.parametrize("value", [pytest.param(1, id="one")])
def test_id(value):
    mark("tests/test_case.py::test_id")

@pytest.mark.parametrize("value", [(pytest.param(1, marks=pytest.mark.skip(reason="off")),)])
def test_tuple(value):
    mark("tests/test_case.py::test_tuple")

@pytest.mark.parametrize("value", [Kind])
def test_class(value):
    mark("tests/test_case.py::test_class")

@pytest.mark.parametrize("value", [Kind.A])
def test_member(value):
    mark("tests/test_case.py::test_member")

@pytest.mark.parametrize("value", [Kind()])
def test_instance(value):
    mark("tests/test_case.py::test_instance")

@pytest.mark.parametrize("value", [decimal.Decimal("1")])
def test_package(value):
    mark("tests/test_case.py::test_package")

@pytest.mark.parametrize("value", [dict])
def test_builtin(value):
    mark("tests/test_case.py::test_builtin")

@pytest.mark.parametrize("value", [make(1)])
def test_helper(value):
    mark("tests/test_case.py::test_helper")

@pytest.mark.parametrize("value", [lambda: 1])
def test_lambda(value):
    mark("tests/test_case.py::test_lambda")

@pytest.mark.parametrize("value", [-1])
def test_negative(value):
    mark("tests/test_case.py::test_negative")

@pytest.mark.parametrize("value", [f"a{1}"])
def test_text(value):
    mark("tests/test_case.py::test_text")

@pytest.mark.parametrize("value", [pytest.param(1, marks=pytest.mark.slow)])
def test_own_mark(value):
    mark("tests/test_case.py::test_own_mark")
`,
        },
    },
    {
        id: 'pytest-rows-row-mark-and-expression', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_actual'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': `[pytest]
addopts = -m "not slow"
markers =
    slow: slow
`,
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

@pytest.mark.parametrize("value", [pytest.param(1, marks=pytest.mark.slow)])
def test_actual(value):
    mark("tests/test_case.py::test_actual")

def test_own():
    mark("tests/test_case.py::test_own")
`,
        },
    },
    {
        id: 'pytest-rows-fixture-rows', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_by_name', 'tests/test_case.py::test_maybe'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

OFF = pytest.param(1, marks=pytest.mark.skip(reason="off"))

@pytest.fixture(params=[OFF])
def by_name(request): return request.param

@pytest.fixture(params=[pytest.param(1, marks=pytest.mark.skip(reason="off")), 2])
def some(request): return request.param

@pytest.fixture(params=[pytest.param(1, marks=pytest.mark.skipif(True, reason="off"))])
def maybe(request): return request.param

def test_by_name(by_name):
    mark("tests/test_case.py::test_by_name")

def test_some(some):
    mark("tests/test_case.py::test_some")

def test_maybe(maybe):
    mark("tests/test_case.py::test_maybe")
`,
        },
    },
    {
        id: 'pytest-rows-unittest-skips', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import unittest

class K(unittest.TestCase):
    def test_sub(self):
        with self.subTest(i=1):
            mark("tests/test_case.py::K > test_sub")
`,
        },
    },
    {
        id: 'pytest-rows-rows-from-a-call', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_actual'],
        emptyTestFiles: ['tests/test_case.py'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

def rows():
    return [pytest.param(1, marks=pytest.mark.skip(reason="off"))]

@pytest.mark.parametrize("value", rows())
def test_actual(value):
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-rows-xfail-that-does-not-run-under-a-condition', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_condition_computed', 'tests/test_case.py::test_condition_text', 'tests/test_case.py::test_skipif_false'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest
import sys

@pytest.mark.xfail(False, run=False, reason="x")
def test_condition_false():
    mark("tests/test_case.py::test_condition_false")

@pytest.mark.xfail(True, run=False, reason="x")
def test_condition_true():
    mark("tests/test_case.py::test_condition_true")

@pytest.mark.xfail(sys.platform == "nope", run=False, reason="x")
def test_condition_computed():
    mark("tests/test_case.py::test_condition_computed")

@pytest.mark.xfail(condition=False, run=False, reason="x")
def test_condition_keyword():
    mark("tests/test_case.py::test_condition_keyword")

@pytest.mark.xfail(run=False)
def test_never():
    mark("tests/test_case.py::test_never")

@pytest.mark.xfail("sys.platform == 'nope'", run=False)
def test_condition_text():
    mark("tests/test_case.py::test_condition_text")

@pytest.mark.skipif(False, reason="x")
def test_skipif_false():
    mark("tests/test_case.py::test_skipif_false")

@pytest.mark.skip(False)
def test_skip_with_argument():
    mark("tests/test_case.py::test_skip_with_argument")
`,
        },
    },
    // ---- pytest: what runs a test more than once without its declaration saying so
    {
        id: 'pytest-several-autouse', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

@pytest.fixture(params=[1, 2], autouse=True)
def value(request): return request.param

def test_actual():
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-several-autouse-conftest', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'conftest.py': `import pytest

@pytest.fixture(params=[1, 2], autouse=True)
def value(request): return request.param
`,
            'tests/test_case.py': `${PY}def test_actual():
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-several-autouse-asks-for-a-table', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

@pytest.fixture(params=[1, 2])
def value(request): return request.param

@pytest.fixture(autouse=True)
def every(value): return value

def test_actual():
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-several-autouse-in-class', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

class TestK:
    @pytest.fixture(params=[1, 2], autouse=True)
    def value(self, request): return request.param
    def test_m(self):
        mark("tests/test_case.py::TestK > test_m")

def test_actual():
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-several-autouse-in-base-class', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `import pytest

class Base:
    @pytest.fixture(params=[1, 2], autouse=True)
    def value(self, request): return request.param
`,
            'tests/test_case.py': `${PY}from tests.helpers import Base

class TestK(Base):
    def test_m(self):
        mark("tests/test_case.py::TestK > test_m")
`,
        },
    },
    {
        id: 'pytest-several-autouse-in-plugin', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/plugin.py': `import pytest

@pytest.fixture(params=[1, 2], autouse=True)
def value(request): return request.param
`,
            'conftest.py': 'pytest_plugins = ["tests.plugin"]\n',
            'tests/test_case.py': `${PY}def test_actual():
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-several-autouse-unittest', runner: 'pytest',
        sometimes: ['tests/test_case.py::K > test_m'],
        emptyTestFiles: ['tests/test_case.py'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'conftest.py': `import pytest

@pytest.fixture(params=[1, 2], autouse=True)
def value(request): return request.param
`,
            'tests/test_case.py': `${PY}import unittest

class K(unittest.TestCase):
    def test_m(self):
        mark("tests/test_case.py::K > test_m")
`,
        },
    },
    {
        id: 'pytest-several-generate-tests', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_actual', 'tests/test_case.py::test_plain'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'conftest.py': `def pytest_generate_tests(metafunc):
    if "value" in metafunc.fixturenames:
        metafunc.parametrize("value", [1, 2])
`,
            'tests/test_case.py': `${PY}def test_actual(value):
    mark("tests/test_case.py::test_actual")

def test_plain():
    mark("tests/test_case.py::test_plain")
`,
        },
    },
    {
        id: 'pytest-several-generate-tests-in-module', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_actual'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}def pytest_generate_tests(metafunc):
    metafunc.parametrize("value", [1, 2])

def test_actual(value):
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-several-ini-usefixtures', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\nusefixtures = value\n',
            'tests/__init__.py': '',
            'conftest.py': `import pytest

@pytest.fixture(params=[1, 2])
def value(request): return request.param
`,
            'tests/test_case.py': `${PY}def test_actual():
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-several-class-usefixtures', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

@pytest.fixture(params=[1, 2])
def value(request): return request.param

@pytest.mark.usefixtures("value")
class TestK:
    def test_m(self):
        mark("tests/test_case.py::TestK > test_m")
`,
        },
    },
    {
        id: 'pytest-several-table-fixture-overridden', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'conftest.py': `import pytest

@pytest.fixture(params=[1, 2])
def value(request): return request.param
`,
            'tests/test_case.py': `${PY}import pytest

@pytest.fixture
def value(): return 3

def test_actual(value):
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-several-autouse-beside', runner: 'pytest',
        atLeast: ['other/test_there.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'other/__init__.py': '',
            'other/conftest.py': `import pytest

@pytest.fixture(params=[1, 2], autouse=True)
def value(request): return request.param
`,
            'other/test_there.py': `${PY}def test_there():
    mark("other/test_there.py::test_there")
`,
            'tests/test_case.py': `${PY}def test_actual():
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-several-imported-test-under-autouse', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `${PY}${RIDP}def check():
    mark(rid())
`,
            'tests/test_case.py': `import pytest
from tests.helpers import check as test_check

@pytest.fixture(params=[1, 2], autouse=True)
def value(request): return request.param
`,
        },
    },
    {
        id: 'pytest-several-doctest-modules', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\naddopts = --doctest-modules\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}def helper():
    """
    >>> 1 + 1
    2
    """

def test_actual():
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-several-autouse-table-empty', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_actual'],
        emptyTestFiles: ['tests/test_case.py'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

@pytest.fixture(params=[], autouse=True)
def value(request): return request.param

def test_actual():
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-several-autouse-rows-skip', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_actual'],
        emptyTestFiles: ['tests/test_case.py'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

@pytest.fixture(params=[pytest.param(1, marks=pytest.mark.skip(reason="off"))], autouse=True)
def value(request): return request.param

def test_actual():
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-several-autouse-fixture-by-name', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

@pytest.fixture(params=[1, 2], autouse=True, name="other")
def value(request): return request.param

def test_actual():
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-several-table-on-base-class', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/helpers.py': `import pytest

@pytest.mark.parametrize("value", [1, 2])
class Base:
    pass
`,
            'tests/test_case.py': `${PY}from tests.helpers import Base

class TestK(Base):
    def test_m(self, value):
        mark("tests/test_case.py::TestK > test_m")
`,
        },
    },
    {
        id: 'pytest-several-setup-class-autouse-module-scope', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

@pytest.fixture(params=[1, 2], autouse=True, scope="module")
def value(request): return request.param

def test_actual():
    mark("tests/test_case.py::test_actual")

def test_second():
    mark("tests/test_case.py::test_second")
`,
        },
    },
    {
        id: 'pytest-several-unittest-usefixtures-table', runner: 'pytest',
        sometimes: ['tests/test_case.py::K > test_m'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

import unittest

@pytest.fixture(params=[1, 2])
def value(request): return request.param

@pytest.fixture
def plain(): return 1

@pytest.mark.usefixtures("value")
class K(unittest.TestCase):
    def test_m(self):
        mark("tests/test_case.py::K > test_m")

@pytest.mark.usefixtures("plain")
class L(unittest.TestCase):
    def test_m(self):
        mark("tests/test_case.py::L > test_m")
`,
        },
    },
    {
        id: 'pytest-several-unittest-parametrize', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

import unittest

class K(unittest.TestCase):
    @pytest.mark.parametrize("value", [1, 2])
    def test_m(self, value=0):
        mark("tests/test_case.py::K > test_m")

    def test_n(self):
        mark("tests/test_case.py::K > test_n")
`,
        },
    },
    {
        id: 'pytest-several-unittest-autouse-plain', runner: 'pytest',
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'conftest.py': `import pytest

@pytest.fixture(autouse=True)
def every(): return 1
`,
            'tests/test_case.py': `${PY}import unittest

class K(unittest.TestCase):
    def test_m(self):
        mark("tests/test_case.py::K > test_m")
`,
        },
    },
    {
        id: 'pytest-several-generate-in-plugin', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_actual'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/plugin.py': `def pytest_generate_tests(metafunc):
    if "value" in metafunc.fixturenames:
        metafunc.parametrize("value", [1, 2])
`,
            'conftest.py': 'pytest_plugins = ["tests.plugin"]\n',
            'tests/test_case.py': `${PY}def test_actual(value):
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-several-class-generate', runner: 'pytest',
        sometimes: ['tests/test_case.py::TestK > test_m'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}class TestK:
    def pytest_generate_tests(self, metafunc):
        metafunc.parametrize("value", [1, 2])

    def test_m(self, value):
        mark("tests/test_case.py::TestK > test_m")
`,
        },
    },
    {
        id: 'pytest-several-fixture-params-by-name', runner: 'pytest',
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

ROWS = [1, 2]

@pytest.fixture(params=ROWS, autouse=True)
def value(request): return request.param

def test_actual():
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    {
        id: 'pytest-several-fixture-computed-params-autouse', runner: 'pytest',
        sometimes: ['tests/test_case.py::test_actual'],
        emptyTestFiles: ['tests/test_case.py'],
        atLeast: ['tests/test_case.py'],
        files: {
            'pytest.ini': '[pytest]\n',
            'tests/__init__.py': '',
            'tests/test_case.py': `${PY}import pytest

def rows():
    return []

@pytest.fixture(params=rows(), autouse=True)
def value(request): return request.param

def test_actual():
    mark("tests/test_case.py::test_actual")
`,
        },
    },
    // ---- JUnit and TestNG: what a class inherits, rows, repeats, runners
    {
        id: 'maven-junit5-what-a-class-inherits', runner: 'maven',
        sometimes: ['src/test/java/com/x/ChildTest.java::ChildTest > disabledBelow', 'src/test/java/com/x/ChildTest.java::ChildTest > kept', 'src/test/java/com/x/ChildTest.java::ChildTest > reenabled'],
        files: {
            'pom.xml': POM.replace('DEPENDENCIES', JUPITER),
            'src/test/java/com/x/Rec.java': `package com.x;

class Rec {
${JAVA}}
`,
            'src/test/java/com/x/DisabledBase.java': `package com.x;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;

@Disabled("base only")
abstract class DisabledBase {
    @Test
    void inherited() { Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > inherited"); }
}
`,
            'src/test/java/com/x/ChildOfDisabledTest.java': `package com.x;

class ChildOfDisabledTest extends DisabledBase {
}
`,
            'src/test/java/com/x/Base.java': `package com.x;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Assumptions;

abstract class Base {
    @BeforeEach
    void prepare() { Assumptions.assumeTrue(false); }

    @Test
    void kept() { Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > kept"); }

    @Test
    void overridden() { Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > overridden"); }

    @Test
    @Disabled("off in the base")
    void reenabled() { Rec.mark("src/test/java/com/x/Base.java::never"); }

    @Test
    void disabledBelow() { Rec.mark("src/test/java/com/x/Base.java::never"); }
}
`,
            'src/test/java/com/x/ChildTest.java': `package com.x;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;

class ChildTest extends Base {
    @Override
    void prepare() { }

    @Override
    void overridden() { Rec.mark("src/test/java/com/x/ChildTest.java::ChildTest > overridden without the annotation"); }

    @Override
    @Test
    void reenabled() { Rec.mark("src/test/java/com/x/ChildTest.java::ChildTest > reenabled"); }

    @Override
    @Test
    @Disabled("off here")
    void disabledBelow() { Rec.mark("src/test/java/com/x/ChildTest.java::ChildTest > disabledBelow"); }
}
`,
        },
    },
    {
        id: 'maven-junit5-rows-and-repeats', runner: 'maven',
        sometimes: ['src/test/java/com/x/RowsTest.java::RowsTest > noRows', 'src/test/java/com/x/RowsTest.java::RowsTest > twoRows'],
        atLeast: ['src/test/java/com/x/RowsTest.java'],
        files: {
            'pom.xml': POM.replace('DEPENDENCIES', JUPITER),
            'src/test/java/com/x/Rec.java': `package com.x;

class Rec {
${JAVA}}
`,
            'src/test/java/com/x/RowsTest.java': `package com.x;

import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.RepeatedTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;

class RowsTest {
    enum Kind { A, B }

    static Stream<Integer> none() { return Stream.empty(); }
    static Stream<Integer> two() { return Stream.of(1, 2); }

    @ParameterizedTest
    @MethodSource("none")
    void noRows(int x) { Rec.mark("src/test/java/com/x/RowsTest.java::RowsTest > noRows"); }

    @ParameterizedTest
    @MethodSource("two")
    void twoRows(int x) { Rec.mark("src/test/java/com/x/RowsTest.java::RowsTest > twoRows"); }

    @ParameterizedTest
    @ValueSource(ints = {})
    void emptyValues(int x) { Rec.mark("src/test/java/com/x/RowsTest.java::RowsTest > emptyValues"); }

    @ParameterizedTest
    @EnumSource(Kind.class)
    void everyKind(Kind kind) { Rec.mark("src/test/java/com/x/RowsTest.java::RowsTest > everyKind"); }

    @ParameterizedTest
    @NullSource
    void oneNull(String text) { Rec.mark("src/test/java/com/x/RowsTest.java::RowsTest > oneNull"); }

    @ParameterizedTest
    void noSource(int x) { Rec.mark("src/test/java/com/x/RowsTest.java::RowsTest > noSource"); }

    @RepeatedTest(3)
    void thrice() { Rec.mark("src/test/java/com/x/RowsTest.java::RowsTest > thrice"); }

    @RepeatedTest(1)
    void once() { Rec.mark("src/test/java/com/x/RowsTest.java::RowsTest > once"); }

    @TestFactory
    Stream<DynamicTest> made() {
        return Stream.of(DynamicTest.dynamicTest("a", () -> Rec.mark("src/test/java/com/x/RowsTest.java::RowsTest > made")),
            DynamicTest.dynamicTest("b", () -> Rec.mark("src/test/java/com/x/RowsTest.java::RowsTest > made")));
    }

    @Test
    void plain() { Rec.mark("src/test/java/com/x/RowsTest.java::RowsTest > plain"); }
}
`,
        },
    },
    {
        id: 'maven-junit4-overrides-runners-and-ignored-bases', runner: 'maven',
        sometimes: ['src/test/java/com/x/Child4Test.java::Child4Test > kept', 'src/test/java/com/x/Child4Test.java::Child4Test > overridden', 'src/test/java/com/x/EmptyTableTest.java::EmptyTableTest > row', 'src/test/java/com/x/TableTest.java::TableTest > row'],
        emptyTestFiles: ['src/test/java/com/x/EmptyTableTest.java'],
        atLeast: ['src/test/java/com/x/EmptyTableTest.java', 'src/test/java/com/x/TableTest.java'],
        files: {
            'pom.xml': POM.replace('DEPENDENCIES', JUNIT4),
            'src/test/java/com/x/Rec.java': `package com.x;

class Rec {
${JAVA}}
`,
            'src/test/java/com/x/IgnoredBase.java': `package com.x;

import org.junit.Ignore;
import org.junit.Test;

@Ignore("base only")
public abstract class IgnoredBase {
    @Test
    public void inherited() { Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > inherited"); }
}
`,
            'src/test/java/com/x/ChildOfIgnoredTest.java': `package com.x;

public class ChildOfIgnoredTest extends IgnoredBase {
}
`,
            'src/test/java/com/x/Base4.java': `package com.x;

import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;

public abstract class Base4 {
    @Before
    public void prepare() { Assume.assumeTrue(false); }

    @Test
    public void kept() { Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > kept"); }

    @Test
    public void overridden() { Rec.mark("src/test/java/com/x/Base4.java::never"); }
}
`,
            'src/test/java/com/x/Child4Test.java': `package com.x;

public class Child4Test extends Base4 {
    @Override
    public void prepare() { }

    @Override
    public void overridden() { Rec.mark("src/test/java/com/x/Child4Test.java::Child4Test > overridden without the annotation"); }
}
`,
            'src/test/java/com/x/TableTest.java': `package com.x;

import java.util.Arrays;
import java.util.Collection;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import org.junit.runners.Parameterized.Parameters;

@RunWith(Parameterized.class)
public class TableTest {
    @Parameters
    public static Collection<Object[]> rows() { return Arrays.asList(new Object[][] { { 1 }, { 2 } }); }

    private final int x;
    public TableTest(int x) { this.x = x; }

    @Test
    public void row() { Rec.mark("src/test/java/com/x/TableTest.java::TableTest > row"); }
}
`,
            'src/test/java/com/x/EmptyTableTest.java': `package com.x;

import java.util.Arrays;
import java.util.Collection;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import org.junit.runners.Parameterized.Parameters;

@RunWith(Parameterized.class)
public class EmptyTableTest {
    @Parameters
    public static Collection<Object[]> rows() { return Arrays.asList(new Object[][] { }); }

    public EmptyTableTest(int x) { }

    @Test
    public void row() { Rec.mark("src/test/java/com/x/EmptyTableTest.java::EmptyTableTest > row"); }
}
`,
        },
    },
    {
        id: 'maven-testng', runner: 'maven',
        sometimes: ['src/test/java/com/x/GuardedTest.java::GuardedTest > guarded', 'src/test/java/com/x/PlainTest.java::PlainTest > noRows', 'src/test/java/com/x/PlainTest.java::PlainTest > twoRows'],
        emptyTestFiles: ['src/test/java/com/x/ChildOfIgnoredTTest.java', 'src/test/java/com/x/GuardedTest.java', 'src/test/java/com/x/IgnoredTest.java'],
        atLeast: ['src/test/java/com/x/PlainTest.java'],
        files: {
            'pom.xml': POM.replace('DEPENDENCIES', TESTNG),
            'src/test/java/com/x/Rec.java': `package com.x;

public class Rec {
    public static void mark(String id) { try { java.nio.file.Files.writeString(java.nio.file.Path.of(System.getenv("UCN_RAN")), id + "\\n", java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND); } catch (Exception e) { throw new RuntimeException(e); } }
}
`,
            'src/test/java/com/x/PlainTest.java': `package com.x;

import org.testng.annotations.DataProvider;
import org.testng.annotations.Test;

public class PlainTest {
    @Test
    public void runs() { Rec.mark("src/test/java/com/x/PlainTest.java::PlainTest > runs"); }

    @Test(enabled = false)
    public void off() { Rec.mark("src/test/java/com/x/PlainTest.java::PlainTest > off"); }

    @Test(invocationCount = 3)
    public void thrice() { Rec.mark("src/test/java/com/x/PlainTest.java::PlainTest > thrice"); }

    @Test(invocationCount = 0)
    public void never() { Rec.mark("src/test/java/com/x/PlainTest.java::PlainTest > never"); }

    @DataProvider(name = "rows")
    public Object[][] rows() { return new Object[][] { { 1 }, { 2 } }; }

    @DataProvider(name = "none")
    public Object[][] none() { return new Object[][] { }; }

    @Test(dataProvider = "rows")
    public void twoRows(int x) { Rec.mark("src/test/java/com/x/PlainTest.java::PlainTest > twoRows"); }

    @Test(dataProvider = "none")
    public void noRows(int x) { Rec.mark("src/test/java/com/x/PlainTest.java::PlainTest > noRows"); }

    public void helper() { Rec.mark("src/test/java/com/x/PlainTest.java::PlainTest > helper"); }
}
`,
            'src/test/java/com/x/ClassLevelTest.java': `package com.x;

import org.testng.annotations.Test;

@Test
public class ClassLevelTest {
    public void everyPublicMethod() { Rec.mark("src/test/java/com/x/ClassLevelTest.java::ClassLevelTest > everyPublicMethod"); }

    void notPublic() { Rec.mark("src/test/java/com/x/ClassLevelTest.java::ClassLevelTest > notPublic"); }
}
`,
            'src/test/java/com/x/DisabledClassTest.java': `package com.x;

import org.testng.annotations.Test;

@Test(enabled = false)
public class DisabledClassTest {
    public void a() { Rec.mark("src/test/java/com/x/DisabledClassTest.java::DisabledClassTest > a"); }

    @Test
    public void b() { Rec.mark("src/test/java/com/x/DisabledClassTest.java::DisabledClassTest > b"); }
}
`,
            'src/test/java/com/x/GuardedTest.java': `package com.x;

import org.testng.SkipException;
import org.testng.annotations.BeforeMethod;
import org.testng.annotations.Test;

public class GuardedTest {
    @BeforeMethod
    public void prepare() { throw new SkipException("no"); }

    @Test
    public void guarded() { Rec.mark("src/test/java/com/x/GuardedTest.java::GuardedTest > guarded"); }
}
`,
            'src/test/java/com/x/TBase.java': `package com.x;

import org.testng.annotations.Test;

public abstract class TBase {
    @Test
    public void inherited() { Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > inherited"); }

    @Test
    public void overridden() { Rec.mark("src/test/java/com/x/TBase.java::never"); }
}
`,
            'src/test/java/com/x/TChildTest.java': `package com.x;

public class TChildTest extends TBase {
    @Override
    public void overridden() { Rec.mark("src/test/java/com/x/TChildTest.java::TChildTest > overridden"); }
}
`,
            'src/test/java/com/x/TBaseAll.java': `package com.x;

import org.testng.annotations.Test;

@Test
public abstract class TBaseAll {
    public void fromBase() { Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > fromBase"); }
}
`,
            'src/test/java/com/x/TAllChildTest.java': `package com.x;

public class TAllChildTest extends TBaseAll {
    public void own() { Rec.mark("src/test/java/com/x/TAllChildTest.java::TAllChildTest > own"); }
}
`,
            'src/test/java/com/x/IgnoredBaseT.java': `package com.x;

import org.testng.annotations.Ignore;
import org.testng.annotations.Test;

@Ignore
public abstract class IgnoredBaseT {
    @Test
    public void inherited() { Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > inherited"); }
}
`,
            'src/test/java/com/x/ChildOfIgnoredTTest.java': `package com.x;

public class ChildOfIgnoredTTest extends IgnoredBaseT {
}
`,
            'src/test/java/com/x/IgnoredTest.java': `package com.x;

import org.testng.annotations.Ignore;
import org.testng.annotations.Test;

@Ignore
public class IgnoredTest {
    @Test
    public void a() { Rec.mark("src/test/java/com/x/IgnoredTest.java::IgnoredTest > a"); }
}
`,
        },
    },
    // ------------- xUnit, NUnit and MSTest: rows, fixtures and overrides
    {
        id: 'dotnet-xunit-rows-and-overrides', runner: 'dotnet-test',
        sometimes: ['RowTests.cs::RowTests > NoRows', 'RowTests.cs::RowTests > TwoRows'],
        atLeast: ['RowTests.cs'],
        files: {
            'App.Tests.csproj': CSPROJ(XUNIT),
            'Rec.cs': `namespace P.Tests
{
    public static class Rec { static readonly object Gate = new object(); public static void Mark(string id) { lock (Gate) { System.IO.File.AppendAllText(System.Environment.GetEnvironmentVariable("UCN_RAN"), id + "\\n"); } } }
}
`,
            'RowTests.cs': `using System.Collections.Generic;
using Xunit;

namespace P.Tests
{
    public class RowTests
    {
        public static IEnumerable<object[]> None => new List<object[]>();
        public static IEnumerable<object[]> Two => new List<object[]> { new object[] { 1 }, new object[] { 2 } };

        [Theory]
        [InlineData(1, Skip = "off")]
        public void AllRowsSkipped(int x) { Rec.Mark("RowTests.cs::RowTests > AllRowsSkipped"); }

        [Theory]
        [InlineData(1, Skip = "off")]
        [InlineData(2)]
        public void SomeRowsSkipped(int x) { Rec.Mark("RowTests.cs::RowTests > SomeRowsSkipped"); }

        [Theory]
        [MemberData(nameof(None))]
        public void NoRows(int x) { Rec.Mark("RowTests.cs::RowTests > NoRows"); }

        [Theory]
        [MemberData(nameof(Two))]
        public void TwoRows(int x) { Rec.Mark("RowTests.cs::RowTests > TwoRows"); }

        [Fact]
        public void Plain() { Rec.Mark("RowTests.cs::RowTests > Plain"); }
    }
}
`,
            'LookupTests.cs': `using Xunit;

namespace P.Tests
{
    public abstract class Base
    {
        [Fact]
        public virtual void Overridden() { Rec.Mark("LookupTests.cs::never"); }

        [Fact]
        public void Kept() { Rec.Mark("LookupTests.cs::" + GetType().Name + " > Kept"); }

        [Fact(Skip = "off in the base")]
        public virtual void Reenabled() { Rec.Mark("LookupTests.cs::never"); }

        [Fact]
        public virtual void SkippedBelow() { Rec.Mark("LookupTests.cs::never"); }
    }

    public class Child : Base
    {
        public override void Overridden() { Rec.Mark("LookupTests.cs::Child > Overridden"); }

        [Fact]
        public override void Reenabled() { Rec.Mark("LookupTests.cs::Child > Reenabled"); }

        [Fact(Skip = "off here")]
        public override void SkippedBelow() { Rec.Mark("LookupTests.cs::Child > SkippedBelow"); }
    }
}
`,
        },
    },
    {
        id: 'dotnet-nunit-rows-fixtures-and-overrides', runner: 'dotnet-test',
        sometimes: ['LookupTests.cs::Child > Kept', 'LookupTests.cs::Child > Reenabled', 'RowTests.cs::IgnoreTests > ExplicitRow', 'RowTests.cs::PlatformTests > OnePlatform', 'RowTests.cs::SourceTests > NoRows', 'RowTests.cs::SourceTests > TwoRows', 'RowTests.cs::TheoryTests > TheoryWithoutData'],
        atLeast: ['RowTests.cs'],
        files: {
            'App.Tests.csproj': CSPROJ(NUNIT),
            'Rec.cs': `namespace P.Tests
{
    public static class Rec { static readonly object Gate = new object(); public static void Mark(string id) { lock (Gate) { System.IO.File.AppendAllText(System.Environment.GetEnvironmentVariable("UCN_RAN"), id + "\\n"); } } }
}
`,
            'RowTests.cs': `using NUnit.Framework;

namespace P.Tests
{
    public class ValuesTests
    {
        [Test]
        public void Each([Values(1, 2)] int x) { Rec.Mark("RowTests.cs::ValuesTests > Each"); }

        [Test]
        public void Ranged([Range(1, 3)] int x) { Rec.Mark("RowTests.cs::ValuesTests > Ranged"); }
    }

    public class RepeatTests
    {
        [Test, Repeat(3)]
        public void Thrice() { Rec.Mark("RowTests.cs::RepeatTests > Thrice"); }
    }

    public class SourceTests
    {
        static object[] None = { };
        static object[] Two = { 1, 2 };

        [TestCaseSource(nameof(None))]
        public void NoRows(int x) { Rec.Mark("RowTests.cs::SourceTests > NoRows"); }

        [TestCaseSource(nameof(Two))]
        public void TwoRows(int x) { Rec.Mark("RowTests.cs::SourceTests > TwoRows"); }
    }

    public class IgnoreTests
    {
        [TestCase(1, Ignore = "off")]
        [TestCase(2)]
        public void SomeIgnored(int x) { Rec.Mark("RowTests.cs::IgnoreTests > SomeIgnored"); }

        [TestCase(1, Ignore = "off")]
        [TestCase(2, Ignore = "off")]
        public void AllIgnored(int x) { Rec.Mark("RowTests.cs::IgnoreTests > AllIgnored"); }

        [TestCase(1, Explicit = true)]
        public void ExplicitRow(int x) { Rec.Mark("RowTests.cs::IgnoreTests > ExplicitRow"); }
    }

    public class PlatformTests
    {
        [TestCase(1, IncludePlatform = "Win")]
        [TestCase(1, IncludePlatform = "Unix")]
        public void OnePlatform(int x) { Rec.Mark("RowTests.cs::PlatformTests > OnePlatform"); }
    }

    public class TheoryTests
    {
        [Theory]
        public void TheoryWithoutData(int x) { Rec.Mark("RowTests.cs::TheoryTests > TheoryWithoutData"); }

        [Test]
        public void Plain() { Rec.Mark("RowTests.cs::TheoryTests > Plain"); }
    }

    [TestFixture(1)]
    [TestFixture(2)]
    public class TwiceFixture
    {
        public TwiceFixture(int x) { }

        [Test]
        public void Runs() { Rec.Mark("RowTests.cs::TwiceFixture > Runs"); }
    }

    [TestFixture]
    public class PlainFixture
    {
        [Test]
        public void Runs() { Rec.Mark("RowTests.cs::PlainFixture > Runs"); }
    }
}
`,
            'LookupTests.cs': `using NUnit.Framework;

namespace P.Tests
{
    [Ignore("base only")]
    public abstract class IgnoredBase
    {
        [Test]
        public void Inherited() { Rec.Mark("LookupTests.cs::" + GetType().Name + " > Inherited"); }
    }

    public class ChildOfIgnored : IgnoredBase { }

    public abstract class Base
    {
        [SetUp]
        public virtual void Prepare() { Assume.That(false); }

        [Test]
        public virtual void Overridden() { Rec.Mark("LookupTests.cs::never"); }

        [Test]
        public void Kept() { Rec.Mark("LookupTests.cs::" + GetType().Name + " > Kept"); }

        [Test]
        [Ignore("off in the base")]
        public virtual void Reenabled() { Rec.Mark("LookupTests.cs::never"); }
    }

    public class Child : Base
    {
        public override void Prepare() { }

        public override void Overridden() { Rec.Mark("LookupTests.cs::Child > Overridden"); }

        [Test]
        public override void Reenabled() { Rec.Mark("LookupTests.cs::Child > Reenabled"); }
    }
}
`,
        },
    },
    {
        id: 'dotnet-mstest-rows-and-overrides', runner: 'dotnet-test',
        sometimes: ['LookupTests.cs::Child > Kept', 'LookupTests.cs::Child > Reenabled', 'RowTests.cs::RowTests > DynamicNone', 'RowTests.cs::RowTests > DynamicTwo', 'RowTests.cs::RowTests > NoRows'],
        atLeast: ['RowTests.cs'],
        files: {
            'App.Tests.csproj': CSPROJ(MSTEST),
            'Rec.cs': `namespace P.Tests
{
    public static class Rec { static readonly object Gate = new object(); public static void Mark(string id) { lock (Gate) { System.IO.File.AppendAllText(System.Environment.GetEnvironmentVariable("UCN_RAN"), id + "\\n"); } } }
}
`,
            'RowTests.cs': `using System.Collections.Generic;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace P.Tests
{
    [TestClass]
    public class RowTests
    {
        public static IEnumerable<object[]> None => new List<object[]>();
        public static IEnumerable<object[]> Two => new List<object[]> { new object[] { 1 }, new object[] { 2 } };

        [DataTestMethod]
        public void NoRows(int x) { Rec.Mark("RowTests.cs::RowTests > NoRows"); }

        [TestMethod]
        [DataRow(1)]
        [DataRow(2)]
        public void RowsOnTestMethod(int x) { Rec.Mark("RowTests.cs::RowTests > RowsOnTestMethod"); }

        [DataTestMethod]
        [DynamicData(nameof(None))]
        public void DynamicNone(int x) { Rec.Mark("RowTests.cs::RowTests > DynamicNone"); }

        [DataTestMethod]
        [DynamicData(nameof(Two))]
        public void DynamicTwo(int x) { Rec.Mark("RowTests.cs::RowTests > DynamicTwo"); }

        [TestMethod]
        public void Plain() { Rec.Mark("RowTests.cs::RowTests > Plain"); }
    }
}
`,
            'LookupTests.cs': `using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace P.Tests
{
    [TestClass]
    [Ignore]
    public abstract class IgnoredBase
    {
        [TestMethod]
        public void Inherited() { Rec.Mark("LookupTests.cs::" + GetType().Name + " > Inherited"); }
    }

    [TestClass]
    public class ChildOfIgnored : IgnoredBase { }

    [TestClass]
    public abstract class Base
    {
        [TestInitialize]
        public virtual void Prepare() { Assert.Inconclusive("no"); }

        [TestMethod]
        public virtual void Overridden() { Rec.Mark("LookupTests.cs::never"); }

        [TestMethod]
        public void Kept() { Rec.Mark("LookupTests.cs::" + GetType().Name + " > Kept"); }

        [TestMethod]
        [Ignore]
        public virtual void Reenabled() { Rec.Mark("LookupTests.cs::never"); }
    }

    [TestClass]
    public class Child : Base
    {
        public override void Prepare() { }

        public override void Overridden() { Rec.Mark("LookupTests.cs::Child > Overridden"); }

        [TestMethod]
        public override void Reenabled() { Rec.Mark("LookupTests.cs::Child > Reenabled"); }
    }
}
`,
        },
    },
    {
        id: 'dotnet-mstest-class-mark-of-the-class-that-runs', runner: 'dotnet-test',
        files: {
            'App.Tests.csproj': CSPROJ(MSTEST),
            'Rec.cs': `namespace P.Tests
{
    public static class Rec { static readonly object Gate = new object(); public static void Mark(string id) { lock (Gate) { System.IO.File.AppendAllText(System.Environment.GetEnvironmentVariable("UCN_RAN"), id + "\\n"); } } }
}
`,
            'LookupTests.cs': `using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace P.Tests
{
    [TestClass]
    public abstract class Base
    {
        [TestMethod]
        public void Kept() { Rec.Mark("LookupTests.cs::" + GetType().Name + " > Kept"); }
    }

    public class Unmarked : Base { }

    [TestClass]
    public class Marked : Base { }

    public abstract class PlainBase
    {
        [TestMethod]
        public void FromPlain() { Rec.Mark("LookupTests.cs::" + GetType().Name + " > FromPlain"); }
    }

    [TestClass]
    public class MarkedOverPlain : PlainBase { }
}
`,
        },
    },
    {
        id: 'dotnet-nunit-explicit-base-and-fixture-arguments', runner: 'dotnet-test',
        sometimes: ['LookupTests.cs::ChildOfExplicit > Inherited'],
        atLeast: ['LookupTests.cs'],
        files: {
            'App.Tests.csproj': CSPROJ(NUNIT),
            'Rec.cs': `namespace P.Tests
{
    public static class Rec { static readonly object Gate = new object(); public static void Mark(string id) { lock (Gate) { System.IO.File.AppendAllText(System.Environment.GetEnvironmentVariable("UCN_RAN"), id + "\\n"); } } }
}
`,
            'LookupTests.cs': `using NUnit.Framework;

namespace P.Tests
{
    [Explicit]
    public abstract class ExplicitBase
    {
        [Test]
        public void Inherited() { Rec.Mark("LookupTests.cs::" + GetType().Name + " > Inherited"); }
    }

    public class ChildOfExplicit : ExplicitBase { }

    [TestFixture(1)]
    public abstract class ArgumentBase
    {
        protected ArgumentBase(int x) { }

        [Test]
        public void FromBase() { Rec.Mark("LookupTests.cs::" + GetType().Name + " > FromBase"); }
    }

    [TestFixture(2)]
    public class ChildOfArguments : ArgumentBase
    {
        public ChildOfArguments(int x) : base(x) { }
    }
}
`,
        },
    },
    // ---- JavaScript: tables of cases, and declarations under control flow
    {
        id: 'jest-tables-of-cases', runner: 'jest',
        sometimes: ['test/a.test.js::by call %i', 'test/b.test.js::plain', 'test/c.test.js::plain'],
        emptyTestFiles: ['test/b.test.js'],
        atLeast: ['test/a.test.js'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "jest" }, "devDependencies": { "jest": "*" } }\n',
            'test/a.test.js': `${CJS}const none = [];
const two = [1, 2];
function rows() { return [1]; }

test.each([1, 2])('written out %i', () => { mark('test/a.test.js::written out %i'); });
test.each(two)('by name %i', () => { mark('test/a.test.js::by name %i'); });
test.each(rows())('by call %i', () => { mark('test/a.test.js::by call %i'); });
test.skip.each([1])('skipped table %i', () => { mark('test/a.test.js::skipped table %i'); });
describe.each([1, 2])('suite %i', () => {
    test('inside', () => { mark('test/a.test.js::suite %i > inside'); });
});
test.todo('to do');
test('plain', () => { mark('test/a.test.js::plain'); });
`,
            'test/b.test.js': `${CJS}const none = [];
describe.each(none)('no suite %i', () => {
    test('inside', () => { mark('test/b.test.js::no suite %i > inside'); });
});
test('plain', () => { mark('test/b.test.js::plain'); });
`,
            'test/c.test.js': `${CJS}test.each([])('no rows %i', () => { mark('test/c.test.js::no rows %i'); });
test('plain', () => { mark('test/c.test.js::plain'); });
`,
        },
    },
    {
        id: 'vitest-tables-of-cases', runner: 'vitest',
        sometimes: ['test/a.test.js::run if false', 'test/a.test.js::run if true', 'test/a.test.js::skip if false', 'test/a.test.js::skip if true', 'test/a.test.js::suite run if > inside', 'test/a.test.js::suite skipped if > inside'],
        atLeast: ['test/a.test.js'],
        files: {
            'package.json': '{ "name": "x", "type": "module", "scripts": { "test": "vitest run" }, "devDependencies": { "vitest": "*" } }\n',
            'test/a.test.js': `${ESM}import { describe, it, test } from 'vitest';
const none = [];
const two = [1, 2];

test.each([1, 2])('written out %i', () => { mark('test/a.test.js::written out %i'); });
test.each(two)('by name %i', () => { mark('test/a.test.js::by name %i'); });
test.each(none)('no rows by name %i', () => { mark('test/a.test.js::no rows by name %i'); });
test.each([])('no rows %i', () => { mark('test/a.test.js::no rows %i'); });
test.for([1, 2])('for %i', () => { mark('test/a.test.js::for %i'); });
describe.each([1, 2])('suite %i', () => {
    test('inside', () => { mark('test/a.test.js::suite %i > inside'); });
});
describe.each(none)('no suite %i', () => {
    test('inside', () => { mark('test/a.test.js::no suite %i > inside'); });
});
it.skipIf(true)('skip if true', () => { mark('test/a.test.js::skip if true'); });
it.skipIf(false)('skip if false', () => { mark('test/a.test.js::skip if false'); });
it.runIf(false)('run if false', () => { mark('test/a.test.js::run if false'); });
it.runIf(true)('run if true', () => { mark('test/a.test.js::run if true'); });
describe.skipIf(true)('suite skipped if', () => {
    test('inside', () => { mark('test/a.test.js::suite skipped if > inside'); });
});
describe.runIf(process.env.UCN_NEVER)('suite run if', () => {
    test('inside', () => { mark('test/a.test.js::suite run if > inside'); });
});
test.todo('to do');
test('no body');
test('plain', () => { mark('test/a.test.js::plain'); });
`,
        },
    },
    {
        id: 'mocha-declarations-in-lists-and-loops', runner: 'mocha',
        sometimes: ['test/a.test.js:: > inside', 'test/a.test.js::lists > (computed name)'],
        atLeast: ['test/a.test.js'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" }, "devDependencies": { "mocha": "*" } }\n',
            'test/a.test.js': `${CJS}const none = [];
describe('lists', function () {
    [1, 2].forEach(n => {
        it('each ' + n, function () { mark('test/a.test.js::lists > each'); });
    });
    none.forEach(n => {
        it('never ' + n, function () { mark('test/a.test.js::lists > never'); });
    });
    for (const n of [1, 2]) {
        it('same title', function () { mark('test/a.test.js::lists > same title'); });
    }
    it('pending');
    xit('crossed out', function () { mark('test/a.test.js::lists > crossed out'); });
    it('plain', function () { mark('test/a.test.js::lists > plain'); });
});
[1, 2].forEach(n => {
    describe('suite ' + n, function () {
        it('inside', function () { mark('test/a.test.js::suite > inside'); });
    });
});
xdescribe('crossed out suite', function () {
    it('inside', function () { mark('test/a.test.js::crossed out suite > inside'); });
});
`,
        },
    },
    {
        id: 'node-test-loops-and-options', runner: 'node-test',
        sometimes: ['test/a.test.js::never', 'test/a.test.js::skip by value', 'test/a.test.js::suite by value > inside'],
        atLeast: ['test/a.test.js'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/a.test.js': `${CJS}const { test, describe, it } = require('node:test');
const none = [];
for (const n of [1, 2]) {
    test('same title', () => { mark('test/a.test.js::same title'); });
}
for (const n of none) {
    test('never', () => { mark('test/a.test.js::never'); });
}
test('skip option', { skip: true }, () => { mark('test/a.test.js::skip option'); });
test('skip by value', { skip: !!process.env.UCN_NEVER }, () => { mark('test/a.test.js::skip by value'); });
test('todo option', { todo: true }, () => { mark('test/a.test.js::todo option'); });
it.todo('to do', () => { mark('test/a.test.js::to do'); });
it.skip('skipped', () => { mark('test/a.test.js::skipped'); });
test('no body');
describe('suite', { skip: true }, () => {
    it('inside', () => { mark('test/a.test.js::suite > inside'); });
});
describe('suite by value', { skip: process.env.UCN_NEVER }, () => {
    it('inside', () => { mark('test/a.test.js::suite by value > inside'); });
});
test('plain', () => { mark('test/a.test.js::plain'); });
`,
        },
    },
    {
        id: 'node-test-declarations-under-control-flow', runner: 'node-test',
        sometimes: ['test/a.test.js::after and', 'test/a.test.js::after or', 'test/a.test.js::first arm', 'test/a.test.js::in a case', 'test/a.test.js::in a catch', 'test/a.test.js::in a for', 'test/a.test.js::in a for in', 'test/a.test.js::in a while', 'test/a.test.js::in an else', 'test/a.test.js::in an if', 'test/a.test.js::in the default', 'test/a.test.js::second arm'],
        atLeast: ['test/a.test.js'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "node --test" } }\n',
            'test/a.test.js': `${CJS}const { test } = require('node:test');
const never = process.env.UCN_NEVER;
if (never) {
    test('in an if', () => { mark('test/a.test.js::in an if'); });
} else {
    test('in an else', () => { mark('test/a.test.js::in an else'); });
}
never && test('after and', () => { mark('test/a.test.js::after and'); });
never || test('after or', () => { mark('test/a.test.js::after or'); });
never ? test('first arm', () => { mark('test/a.test.js::first arm'); }) : test('second arm', () => { mark('test/a.test.js::second arm'); });
switch (never) {
    case 'x': test('in a case', () => { mark('test/a.test.js::in a case'); }); break;
    default: test('in the default', () => { mark('test/a.test.js::in the default'); });
}
try {
    test('in a try', () => { mark('test/a.test.js::in a try'); });
} catch (e) {
    test('in a catch', () => { mark('test/a.test.js::in a catch'); });
} finally {
    test('in a finally', () => { mark('test/a.test.js::in a finally'); });
}
let n = 0;
while (n++ < 2) {
    test('in a while', () => { mark('test/a.test.js::in a while'); });
}
do {
    test('in a do', () => { mark('test/a.test.js::in a do'); });
} while (false);
for (let i = 0; i < 2; i++) {
    test('in a for', () => { mark('test/a.test.js::in a for'); });
}
for (const key in { a: 1, b: 2 }) {
    test('in a for in', () => { mark('test/a.test.js::in a for in'); });
}
{
    test('in a block', () => { mark('test/a.test.js::in a block'); });
}
test('plain', () => { mark('test/a.test.js::plain'); });
`,
        },
    },
    {
        id: 'mocha-declarations-under-control-flow', runner: 'mocha',
        sometimes: ['test/a.test.js::s > after and', 'test/a.test.js::s > after or', 'test/a.test.js::s > first arm', 'test/a.test.js::s > in a case', 'test/a.test.js::s > in a catch', 'test/a.test.js::s > in a for', 'test/a.test.js::s > in a for in', 'test/a.test.js::s > in a while', 'test/a.test.js::s > in an else', 'test/a.test.js::s > in an if', 'test/a.test.js::s > in the default', 'test/a.test.js::s > second arm'],
        atLeast: ['test/a.test.js'],
        files: {
            'package.json': '{ "name": "x", "scripts": { "test": "mocha" }, "devDependencies": { "mocha": "*" } }\n',
            'test/a.test.js': `${CJS}const test = it;
describe('s', function () {
const never = process.env.UCN_NEVER;
if (never) {
    test('in an if', () => { mark('test/a.test.js::s > in an if'); });
} else {
    test('in an else', () => { mark('test/a.test.js::s > in an else'); });
}
never && test('after and', () => { mark('test/a.test.js::s > after and'); });
never || test('after or', () => { mark('test/a.test.js::s > after or'); });
never ? test('first arm', () => { mark('test/a.test.js::s > first arm'); }) : test('second arm', () => { mark('test/a.test.js::s > second arm'); });
switch (never) {
    case 'x': test('in a case', () => { mark('test/a.test.js::s > in a case'); }); break;
    default: test('in the default', () => { mark('test/a.test.js::s > in the default'); });
}
try {
    test('in a try', () => { mark('test/a.test.js::s > in a try'); });
} catch (e) {
    test('in a catch', () => { mark('test/a.test.js::s > in a catch'); });
} finally {
    test('in a finally', () => { mark('test/a.test.js::s > in a finally'); });
}
let n = 0;
while (n++ < 2) {
    test('in a while', () => { mark('test/a.test.js::s > in a while'); });
}
do {
    test('in a do', () => { mark('test/a.test.js::s > in a do'); });
} while (false);
for (let i = 0; i < 2; i++) {
    test('in a for', () => { mark('test/a.test.js::s > in a for'); });
}
for (const key in { a: 1, b: 2 }) {
    test('in a for in', () => { mark('test/a.test.js::s > in a for in'); });
}
{
    test('in a block', () => { mark('test/a.test.js::s > in a block'); });
}
test('plain', () => { mark('test/a.test.js::s > plain'); });
});
`,
        },
    },
    // ------------------ cargo: a test under an attribute that is a macro
    {
        id: 'cargo-attribute-macro-makes-tests', runner: 'cargo-test',
        sometimes: ['src/lib.rs::tests > doubled', 'src/lib.rs::tests > removed'],
        atLeast: ['src/lib.rs'],
        files: {
            'Cargo.toml': `[package]
name = "x"
version = "0.1.0"
edition = "2021"

[dependencies]
twice = { path = "twice" }
`,
            'twice/Cargo.toml': `[package]
name = "twice"
version = "0.1.0"
edition = "2021"

[lib]
proc-macro = true
`,
            'twice/src/lib.rs': `extern crate proc_macro;
use proc_macro::TokenStream;

/// Declares the function twice, the second time under another name.
#[proc_macro_attribute]
pub fn twice(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let text = item.to_string();
    let second = text.replacen("fn ", "fn again_", 1);
    format!("{}\\n{}", text, second).parse().unwrap()
}

/// Declares nothing.
#[proc_macro_attribute]
pub fn never(_attr: TokenStream, _item: TokenStream) -> TokenStream {
    TokenStream::new()
}
`,
            'src/lib.rs': `${RS}
#[cfg(test)]
mod tests {
    use twice::{never, twice};

    #[twice]
    #[test]
    fn doubled() { crate::mark("src/lib.rs::tests > doubled"); }

    #[never]
    #[test]
    fn removed() { crate::mark("src/lib.rs::tests > removed"); }

    #[test]
    fn plain() { crate::mark("src/lib.rs::tests > plain"); }
}
`,
        },
    },
    // ---- a method of the same name: an overload is another method, an override the same one
    {
        id: 'maven-junit4-overload-is-not-an-override', runner: 'maven',
        files: {
            'pom.xml': POM.replace('DEPENDENCIES', JUNIT4),
            'src/test/java/com/x/Rec.java': `package com.x;

public class Rec {
    public static void mark(String id) { try { java.nio.file.Files.writeString(java.nio.file.Path.of(System.getenv("UCN_RAN")), id + "\\n", java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND); } catch (Exception e) { throw new RuntimeException(e); } }
}
`,
            'src/test/java/com/x/Base.java': `package com.x;

import org.junit.Test;

public abstract class Base {
    @Test
    public void works() {
        Rec.mark("src/test/java/com/x/Base.java::works body");
        Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > works");
    }

    @Test
    public void kept() {
        Rec.mark("src/test/java/com/x/Base.java::kept body");
        Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > kept");
    }
}
`,
            'src/test/java/com/x/OverloadTest.java': `package com.x;

public class OverloadTest extends Base {
    public void works(int ignored) { Rec.mark("src/test/java/com/x/OverloadTest.java::never"); }

    public void kept(String other, int more) { Rec.mark("src/test/java/com/x/OverloadTest.java::never"); }
}
`,
            'src/test/java/com/x/OverrideTest.java': `package com.x;

public class OverrideTest extends Base {
    @Override
    public void works() {
        Rec.mark("src/test/java/com/x/OverrideTest.java::works body");
        Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > works");
    }
}
`,
            'src/test/java/com/x/Middle.java': `package com.x;

public abstract class Middle extends Base {
    public void works(String ignored) { Rec.mark("src/test/java/com/x/Middle.java::never"); }
}
`,
            'src/test/java/com/x/BelowMiddleTest.java': `package com.x;

public class BelowMiddleTest extends Middle {
}
`,
        },
    },
    {
        id: 'maven-junit5-overload-is-not-an-override', runner: 'maven',
        files: {
            'pom.xml': POM.replace('DEPENDENCIES', JUPITER),
            'src/test/java/com/x/Rec.java': `package com.x;

public class Rec {
    public static void mark(String id) { try { java.nio.file.Files.writeString(java.nio.file.Path.of(System.getenv("UCN_RAN")), id + "\\n", java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND); } catch (Exception e) { throw new RuntimeException(e); } }
}
`,
            'src/test/java/com/x/Base.java': `package com.x;

import org.junit.jupiter.api.Test;

public abstract class Base {
    @Test
    public void works() {
        Rec.mark("src/test/java/com/x/Base.java::works body");
        Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > works");
    }

    @Test
    public void kept() {
        Rec.mark("src/test/java/com/x/Base.java::kept body");
        Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > kept");
    }
}
`,
            'src/test/java/com/x/OverloadTest.java': `package com.x;

public class OverloadTest extends Base {
    public void works(int ignored) { Rec.mark("src/test/java/com/x/OverloadTest.java::never"); }

    public void kept(String other, int more) { Rec.mark("src/test/java/com/x/OverloadTest.java::never"); }
}
`,
            'src/test/java/com/x/OverrideTest.java': `package com.x;

public class OverrideTest extends Base {
    @Override
    public void works() {
        Rec.mark("src/test/java/com/x/OverrideTest.java::works body");
        Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > works");
    }
}
`,
            'src/test/java/com/x/Middle.java': `package com.x;

public abstract class Middle extends Base {
    public void works(String ignored) { Rec.mark("src/test/java/com/x/Middle.java::never"); }
}
`,
            'src/test/java/com/x/BelowMiddleTest.java': `package com.x;

public class BelowMiddleTest extends Middle {
}
`,
        },
    },
    {
        id: 'maven-testng-overload-is-not-an-override', runner: 'maven',
        files: {
            'pom.xml': POM.replace('DEPENDENCIES', TESTNG),
            'src/test/java/com/x/Rec.java': `package com.x;

public class Rec {
    public static void mark(String id) { try { java.nio.file.Files.writeString(java.nio.file.Path.of(System.getenv("UCN_RAN")), id + "\\n", java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND); } catch (Exception e) { throw new RuntimeException(e); } }
}
`,
            'src/test/java/com/x/Base.java': `package com.x;

import org.testng.annotations.Test;

public abstract class Base {
    @Test
    public void works() {
        Rec.mark("src/test/java/com/x/Base.java::works body");
        Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > works");
    }

    @Test
    public void kept() {
        Rec.mark("src/test/java/com/x/Base.java::kept body");
        Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > kept");
    }
}
`,
            'src/test/java/com/x/OverloadTest.java': `package com.x;

public class OverloadTest extends Base {
    public void works(int ignored) { Rec.mark("src/test/java/com/x/OverloadTest.java::never"); }

    public void kept(String other, int more) { Rec.mark("src/test/java/com/x/OverloadTest.java::never"); }
}
`,
            'src/test/java/com/x/OverrideTest.java': `package com.x;

public class OverrideTest extends Base {
    @Override
    public void works() {
        Rec.mark("src/test/java/com/x/OverrideTest.java::works body");
        Rec.mark("src/test/java/com/x/" + getClass().getSimpleName() + ".java::" + getClass().getSimpleName() + " > works");
    }
}
`,
            'src/test/java/com/x/Middle.java': `package com.x;

public abstract class Middle extends Base {
    public void works(String ignored) { Rec.mark("src/test/java/com/x/Middle.java::never"); }
}
`,
            'src/test/java/com/x/BelowMiddleTest.java': `package com.x;

public class BelowMiddleTest extends Middle {
}
`,
        },
    },
    {
        id: 'dotnet-nunit-overload-and-hiding-are-not-overrides', runner: 'dotnet-test',
        files: {
            'App.Tests.csproj': CSPROJ(NUNIT),
            'Rec.cs': `namespace P.Tests
{
    public static class Rec { static readonly object Gate = new object(); public static void Mark(string id) { lock (Gate) { System.IO.File.AppendAllText(System.Environment.GetEnvironmentVariable("UCN_RAN"), id + "\\n"); } } }
}
`,
            'Tests.cs': `using NUnit.Framework;

namespace P.Tests
{
    public abstract class Base
    {
        [Test]
        public virtual void Works()
        {
            Rec.Mark("Tests.cs::Base works body");
            Rec.Mark("Tests.cs::" + GetType().Name + " > Works");
        }

        [Test]
        public void Kept()
        {
            Rec.Mark("Tests.cs::Base kept body");
            Rec.Mark("Tests.cs::" + GetType().Name + " > Kept");
        }
    }

    public class Overloads : Base
    {
        public void Works(int ignored) { Rec.Mark("Tests.cs::never"); }

        public void Kept(string other, int more) { Rec.Mark("Tests.cs::never"); }
    }

    public class Overrides : Base
    {
        public override void Works()
        {
            Rec.Mark("Tests.cs::Overrides works body");
            Rec.Mark("Tests.cs::" + GetType().Name + " > Works");
        }
    }

    public class Hides : Base
    {
        public new void Kept() { Rec.Mark("Tests.cs::Hides > Kept by new"); }
    }
}
`,
        },
    },
    {
        id: 'dotnet-mstest-one-method-of-each-name', runner: 'dotnet-test',
        files: {
            'App.Tests.csproj': CSPROJ(MSTEST),
            'Rec.cs': `namespace P.Tests
{
    public static class Rec { static readonly object Gate = new object(); public static void Mark(string id) { lock (Gate) { System.IO.File.AppendAllText(System.Environment.GetEnvironmentVariable("UCN_RAN"), id + "\\n"); } } }
}
`,
            'Tests.cs': `using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace P.Tests
{
    [TestClass]
    public abstract class Base
    {
        [TestMethod]
        public virtual void Works()
        {
            Rec.Mark("Tests.cs::Base works body");
            Rec.Mark("Tests.cs::" + GetType().Name + " > Works");
        }

        [TestMethod]
        public void Kept()
        {
            Rec.Mark("Tests.cs::Base kept body");
            Rec.Mark("Tests.cs::" + GetType().Name + " > Kept");
        }
    }

    [TestClass]
    public class Overloads : Base
    {
        public void Works(int ignored) { Rec.Mark("Tests.cs::never"); }

        public void Kept(string other, int more) { Rec.Mark("Tests.cs::never"); }
    }

    [TestClass]
    public class Overrides : Base
    {
        public override void Works()
        {
            Rec.Mark("Tests.cs::Overrides works body");
            Rec.Mark("Tests.cs::" + GetType().Name + " > Works");
        }
    }

    [TestClass]
    public class Hides : Base
    {
        public new void Kept() { Rec.Mark("Tests.cs::Hides > Kept by new"); }
    }
}
`,
        },
    },
];

module.exports = { CASES };
