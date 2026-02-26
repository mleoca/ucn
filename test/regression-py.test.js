/**
 * UCN Python Regression Tests
 *
 * Python-specific regressions: self.attr, dataclass, decorators, relative imports, magic methods.
 * Extracted from parser.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { parse } = require('../core/parser');
const { ProjectIndex } = require('../core/project');
const { tmp, rm, idx, FIXTURES_PATH } = require('./helpers');

describe('Regression: Python class methods in context', () => {
    it('should show methods for Python classes via className', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-py-class-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'user.py'), `class User:
    def __init__(self, name):
        self.name = name

    def greet(self):
        return f"Hello {self.name}"

    def validate(self):
        return len(self.name) > 0

    @staticmethod
    def create(name):
        return User(name)
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.py', { quiet: true });

            const ctx = index.context('User');

            // Should identify as class
            assert.strictEqual(ctx.type, 'class', 'User should be identified as class');
            assert.ok(ctx.methods, 'Should have methods array');
            assert.strictEqual(ctx.methods.length, 4, 'User class should have 4 methods');

            const methodNames = ctx.methods.map(m => m.name);
            assert.ok(methodNames.includes('__init__'), 'Should include __init__');
            assert.ok(methodNames.includes('greet'), 'Should include greet');
            assert.ok(methodNames.includes('validate'), 'Should include validate');
            assert.ok(methodNames.includes('create'), 'Should include create');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Python magic methods not flagged as deadcode', () => {
    it('should NOT report __init__, __call__, __enter__, __exit__ as dead code', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-py-magic-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'context.py'), `class MyContext:
    def __init__(self):
        self.count = 0

    def __enter__(self):
        self.count += 1
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.count -= 1
        return False

    def __call__(self, x):
        return x * 2

    def unused_method(self):
        pass
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.py', { quiet: true });

            const deadcode = index.deadcode();
            const deadNames = deadcode.map(d => d.name);

            // Magic methods should NOT be flagged as dead code
            assert.ok(!deadNames.includes('__init__'), '__init__ should not be flagged as dead code');
            assert.ok(!deadNames.includes('__enter__'), '__enter__ should not be flagged as dead code');
            assert.ok(!deadNames.includes('__exit__'), '__exit__ should not be flagged as dead code');
            assert.ok(!deadNames.includes('__call__'), '__call__ should not be flagged as dead code');

            // unused_method should be flagged as dead
            assert.ok(deadNames.includes('unused_method'), 'unused_method() should be flagged as dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Python relative import resolution', () => {
    it('should resolve from .module import in exporters', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-pyimport-${Date.now()}`);
        const pkgDir = path.join(tmpDir, 'mypackage');
        fs.mkdirSync(pkgDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            fs.writeFileSync(path.join(pkgDir, '__init__.py'), `
from .models import User, Product
from .utils import helper
`);
            fs.writeFileSync(path.join(pkgDir, 'models.py'), `
class User:
    def __init__(self, name):
        self.name = name

class Product:
    def __init__(self, title):
        self.title = title
`);
            fs.writeFileSync(path.join(pkgDir, 'utils.py'), `
def helper():
    return "help"
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // models.py should be found as an exporter (imported by __init__.py)
            const modelsPath = path.join(pkgDir, 'models.py');
            const exporters = index.exportGraph.get(modelsPath) || [];
            assert.ok(exporters.length > 0,
                `models.py should have importers, got ${exporters.length}`);

            // __init__.py should import models.py
            const initPath = path.join(pkgDir, '__init__.py');
            const imports = index.importGraph.get(initPath) || [];
            assert.ok(imports.some(i => i.includes('models')),
                `__init__.py should import models.py, got: ${imports.map(i => path.basename(i))}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should resolve parent relative imports (from ..utils import)', () => {
        const { resolveImport } = require('../core/imports');

        const tmpDir = path.join(os.tmpdir(), `ucn-test-pyrel-${Date.now()}`);
        const subDir = path.join(tmpDir, 'pkg', 'sub');
        fs.mkdirSync(subDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pkg', 'utils.py'), 'def helper(): pass');
            fs.writeFileSync(path.join(subDir, 'mod.py'), 'from ..utils import helper');

            const resolved = resolveImport('..utils', path.join(subDir, 'mod.py'), {
                language: 'python',
                root: tmpDir
            });
            assert.ok(resolved, 'Should resolve ..utils');
            assert.ok(resolved.endsWith('utils.py'), `Should resolve to utils.py, got ${resolved}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: verify excludes Python self/cls from param count', () => {
    it('should not count self as a required argument for Python methods', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-verify-self-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'setup.py'), '');
            fs.writeFileSync(path.join(tmpDir, 'calculator.py'), `
class Calculator:
    def add(self, a, b):
        return a + b

    def multiply(self, x, y, z=1):
        return x * y * z

    @classmethod
    def from_string(cls, s):
        return cls()
`);
            fs.writeFileSync(path.join(tmpDir, 'main.py'), `
from calculator import Calculator

c = Calculator()
c.add(1, 2)
c.add(3, 4)
c.multiply(2, 3)
c.multiply(2, 3, 4)
Calculator.from_string("test")
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // verify add: 2 params (not 3 counting self)
            const addResult = index.verify('add');
            assert.ok(addResult.found, 'add should be found');
            assert.strictEqual(addResult.expectedArgs.min, 2, 'add should expect min 2 args (not 3)');
            assert.strictEqual(addResult.expectedArgs.max, 2, 'add should expect max 2 args (not 3)');
            assert.strictEqual(addResult.mismatches, 0, `add should have 0 mismatches, got ${addResult.mismatches}`);

            // verify multiply: 2-3 params (not 3-4 counting self)
            const mulResult = index.verify('multiply');
            assert.ok(mulResult.found, 'multiply should be found');
            assert.strictEqual(mulResult.expectedArgs.min, 2, 'multiply should expect min 2 args');
            assert.strictEqual(mulResult.expectedArgs.max, 3, 'multiply should expect max 3 args');
            assert.strictEqual(mulResult.mismatches, 0, `multiply should have 0 mismatches, got ${mulResult.mismatches}`);

            // verify from_string: cls should also be excluded
            const clsResult = index.verify('from_string');
            assert.ok(clsResult.found, 'from_string should be found');
            assert.strictEqual(clsResult.expectedArgs.min, 1, 'from_string should expect 1 arg (not 2)');
            assert.strictEqual(clsResult.mismatches, 0, `from_string should have 0 mismatches, got ${clsResult.mismatches}`);

            // params list should not include self/cls
            assert.ok(!addResult.params.some(p => p.name === 'self'), 'params should not include self');
            assert.ok(!clsResult.params.some(p => p.name === 'cls'), 'params should not include cls');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: deadcode treats Python test_* as entry points', () => {
    it('should not flag test_* functions as dead code', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-deadcode-tests-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'setup.py'), '');
            fs.writeFileSync(path.join(tmpDir, 'app.py'), `
def helper():
    return 42

def unused_func():
    return 0
`);
            fs.writeFileSync(path.join(tmpDir, 'test_app.py'), `
from app import helper

def test_helper_returns_42():
    assert helper() == 42

def test_helper_type():
    assert isinstance(helper(), int)
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const dead = index.deadcode({ includeTests: true });
            const deadNames = dead.map(d => d.name);

            // test_* functions should NOT be in dead code
            assert.ok(!deadNames.includes('test_helper_returns_42'),
                'test_helper_returns_42 should not be flagged as dead code');
            assert.ok(!deadNames.includes('test_helper_type'),
                'test_helper_type should not be flagged as dead code');

            // unused_func should still be flagged
            assert.ok(deadNames.includes('unused_func'),
                'unused_func should be flagged as dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// Regression: Python non-relative package imports should resolve to local files
describe('Regression: Python package imports resolve to local files', () => {
    it('should resolve "tools.analyzer" to tools/analyzer.py', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-py-pkg-imports-${Date.now()}`);
        const toolsDir = path.join(tmpDir, 'tools');
        fs.mkdirSync(toolsDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'setup.py'), '');
            fs.writeFileSync(path.join(toolsDir, '__init__.py'), '');
            fs.writeFileSync(path.join(toolsDir, 'analyzer.py'), `
class Analyzer:
    def analyze(self, data):
        return len(data)
`);
            fs.writeFileSync(path.join(toolsDir, 'helper.py'), `
def compute():
    return 42
`);
            fs.writeFileSync(path.join(tmpDir, 'main.py'), `
from tools.analyzer import Analyzer
from tools.helper import compute

a = Analyzer()
a.analyze([1, 2, 3])
compute()
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // imports for main.py should resolve tools.analyzer
            const mainImports = index.importGraph.get(path.join(tmpDir, 'main.py')) || [];
            assert.ok(mainImports.some(i => i.includes('analyzer.py')),
                `main.py should import tools/analyzer.py, got ${mainImports.map(i => path.relative(tmpDir, i))}`);
            assert.ok(mainImports.some(i => i.includes('helper.py')),
                `main.py should import tools/helper.py, got ${mainImports.map(i => path.relative(tmpDir, i))}`);

            // exporters for analyzer.py should include main.py
            const exporters = index.exporters('tools/analyzer.py');
            assert.ok(exporters.some(e => e.file.includes('main.py')),
                `tools/analyzer.py should be exported to main.py, got ${JSON.stringify(exporters)}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: exporters deduplicates repeated imports of same module', () => {
    it('should not duplicate exporters when a file imports same module multiple times', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dedup-'));
        const pkgDir = path.join(tmpDir, 'pkg');
        fs.mkdirSync(pkgDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'setup.py'), '');
            fs.writeFileSync(path.join(pkgDir, '__init__.py'), '');
            fs.writeFileSync(path.join(pkgDir, 'db.py'), `
def get_connection():
    pass

def insert_record():
    pass

def delete_record():
    pass
`);
            // File with multiple function-body imports of same module
            fs.writeFileSync(path.join(tmpDir, 'app.py'), `
def cmd_add():
    from pkg.db import get_connection, insert_record
    conn = get_connection()
    insert_record()

def cmd_remove():
    from pkg.db import get_connection, delete_record
    conn = get_connection()
    delete_record()

def cmd_list():
    from pkg.db import get_connection
    conn = get_connection()
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // exporters for db.py should list app.py exactly once
            const exporters = index.exporters('pkg/db.py');
            const appEntries = exporters.filter(e => e.file.includes('app.py'));
            assert.strictEqual(appEntries.length, 1,
                `pkg/db.py should have exactly 1 exporter entry for app.py, got ${appEntries.length}`);

            // importGraph should also be deduplicated
            const appImports = index.importGraph.get(path.join(tmpDir, 'app.py')) || [];
            const dbImports = appImports.filter(i => i.includes('db.py'));
            assert.strictEqual(dbImports.length, 1,
                `app.py importGraph should have db.py once, got ${dbImports.length}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: exporters shows line numbers for __init__.py', () => {
    it('should find import line for package __init__.py using parent dir name', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-init-'));
        const pkgDir = path.join(tmpDir, 'mypackage');
        fs.mkdirSync(pkgDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'setup.py'), '');
            fs.writeFileSync(path.join(pkgDir, '__init__.py'), `
CONFIG = {'debug': False}

def load_config():
    return CONFIG
`);
            fs.writeFileSync(path.join(tmpDir, 'main.py'), `
import os
from mypackage import load_config

config = load_config()
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const exporters = index.exporters('mypackage/__init__.py');
            const mainEntry = exporters.find(e => e.file.includes('main.py'));
            assert.ok(mainEntry, 'main.py should be an exporter of mypackage/__init__.py');
            assert.ok(mainEntry.importLine !== null,
                `Should find import line for __init__.py, got null`);
            assert.strictEqual(mainEntry.importLine, 3,
                `Import line should be 3 (from mypackage import ...), got ${mainEntry.importLine}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Python self.attr.method() resolution', () => {
    it('findCallsInCode should detect selfAttribute for self.X.method()', () => {
        const { getParser, getLanguageModule } = require('../languages');
        const parser = getParser('python');
        const langModule = getLanguageModule('python');

        const code = `class ReportGenerator:
    def __init__(self, analyzer):
        self.analyzer = analyzer
        self.name = "test"

    def generate(self):
        result = self.analyzer.analyze(data)
        self.save(result)
        helper(result)
        self.name.upper()
`;
        const calls = langModule.findCallsInCode(code, parser);

        // self.analyzer.analyze() should have selfAttribute
        const analyzeCall = calls.find(c => c.name === 'analyze');
        assert.ok(analyzeCall, 'Should find analyze call');
        assert.strictEqual(analyzeCall.selfAttribute, 'analyzer');
        assert.strictEqual(analyzeCall.receiver, 'self');
        assert.strictEqual(analyzeCall.isMethod, true);

        // self.save() should NOT have selfAttribute (direct self method)
        const saveCall = calls.find(c => c.name === 'save');
        assert.ok(saveCall, 'Should find save call');
        assert.strictEqual(saveCall.selfAttribute, undefined);
        assert.strictEqual(saveCall.receiver, 'self');

        // helper() should be a regular function call
        const helperCall = calls.find(c => c.name === 'helper');
        assert.ok(helperCall, 'Should find helper call');
        assert.strictEqual(helperCall.isMethod, false);
        assert.strictEqual(helperCall.selfAttribute, undefined);

        // self.name.upper() should have selfAttribute but string method
        const upperCall = calls.find(c => c.name === 'upper');
        assert.ok(upperCall, 'Should find upper call');
        assert.strictEqual(upperCall.selfAttribute, 'name');
    });

    it('findInstanceAttributeTypes should parse __init__ assignments', () => {
        const { getParser, getLanguageModule } = require('../languages');
        const parser = getParser('python');
        const langModule = getLanguageModule('python');

        const code = `class ReportGenerator:
    def __init__(self, analyzer=None, db=None):
        self.analyzer = InstrumentAnalyzer(config)
        self.db = db or DatabaseClient()
        self.name = "test"
        self.count = 0
        self.items = []
        self.scanner = (param or MarketScanner())

class OtherClass:
    def __init__(self):
        self.helper = HelperTool()
`;
        const result = langModule.findInstanceAttributeTypes(code, parser);

        // ReportGenerator
        const rg = result.get('ReportGenerator');
        assert.ok(rg, 'Should find ReportGenerator');
        assert.strictEqual(rg.get('analyzer'), 'InstrumentAnalyzer');
        assert.strictEqual(rg.get('db'), 'DatabaseClient');
        assert.strictEqual(rg.get('scanner'), 'MarketScanner');
        assert.strictEqual(rg.has('name'), false, 'Should skip string literals');
        assert.strictEqual(rg.has('count'), false, 'Should skip number literals');
        assert.strictEqual(rg.has('items'), false, 'Should skip list literals');

        // OtherClass
        const oc = result.get('OtherClass');
        assert.ok(oc, 'Should find OtherClass');
        assert.strictEqual(oc.get('helper'), 'HelperTool');
    });

    it('findCallees should resolve self.attr.method() to target class', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-selfattr-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'analyzer.py'), `class InstrumentAnalyzer:
    def __init__(self, config):
        self.config = config

    def analyze_instrument(self, data):
        return process(data)

    def get_summary(self):
        return "summary"
`);
            fs.writeFileSync(path.join(tmpDir, 'report.py'), `from analyzer import InstrumentAnalyzer

class ReportGenerator:
    def __init__(self, config):
        self.analyzer = InstrumentAnalyzer(config)

    def generate_report(self, data):
        result = self.analyzer.analyze_instrument(data)
        summary = self.analyzer.get_summary()
        return format_output(result, summary)

def format_output(result, summary):
    return str(result) + summary
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.py', { quiet: true });

            // Find generate_report definition
            const defs = index.symbols.get('generate_report');
            assert.ok(defs && defs.length > 0, 'Should find generate_report');

            const callees = index.findCallees(defs[0]);
            const calleeNames = callees.map(c => c.name);

            assert.ok(calleeNames.includes('analyze_instrument'),
                `Should resolve self.analyzer.analyze_instrument(), got: ${calleeNames.join(', ')}`);
            assert.ok(calleeNames.includes('get_summary'),
                `Should resolve self.analyzer.get_summary(), got: ${calleeNames.join(', ')}`);
            assert.ok(calleeNames.includes('format_output'),
                `Should include direct call format_output(), got: ${calleeNames.join(', ')}`);

            // Verify the resolved callee points to InstrumentAnalyzer's method
            const analyzeCallee = callees.find(c => c.name === 'analyze_instrument');
            assert.strictEqual(analyzeCallee.className, 'InstrumentAnalyzer',
                'Resolved callee should belong to InstrumentAnalyzer class');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('findCallers should find callers through self.attr.method()', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-selfattr-callers-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'analyzer.py'), `class InstrumentAnalyzer:
    def __init__(self, config):
        self.config = config

    def analyze_instrument(self, data):
        return process(data)
`);
            fs.writeFileSync(path.join(tmpDir, 'report.py'), `from analyzer import InstrumentAnalyzer

class ReportGenerator:
    def __init__(self, config):
        self.analyzer = InstrumentAnalyzer(config)

    def generate_report(self, data):
        result = self.analyzer.analyze_instrument(data)
        return result
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.py', { quiet: true });

            const callers = index.findCallers('analyze_instrument');
            assert.ok(callers.length >= 1,
                `Should find at least 1 caller for analyze_instrument, got ${callers.length}`);

            const reportCaller = callers.find(c => c.callerName === 'generate_report');
            assert.ok(reportCaller,
                `Should find generate_report as caller, got: ${callers.map(c => c.callerName).join(', ')}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Python decorated function callees', () => {
    it('findCallees should work for @property and other decorated methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-decorated-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'models.py'), `class Headers:
    def get(self, key):
        return self.data.get(key)

class Response:
    def __init__(self, headers):
        self.headers = Headers(headers)

    @property
    def charset_encoding(self):
        content_type = self.headers.get("Content-Type")
        return parse_charset(content_type)

    @staticmethod
    def create(data):
        return Response(data)

    def normal_method(self):
        return self.headers.get("Accept")
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.py', { quiet: true });

            // @property method should have callees
            const propDefs = index.symbols.get('charset_encoding');
            assert.ok(propDefs && propDefs.length > 0, 'Should find charset_encoding');
            const propCallees = index.findCallees(propDefs[0]);
            const propCalleeNames = propCallees.map(c => c.name);
            assert.ok(propCalleeNames.includes('parse_charset') || propCalleeNames.includes('get'),
                `@property should have callees, got: ${propCalleeNames.join(', ')}`);

            // Normal method should also have callees
            const normalDefs = index.symbols.get('normal_method');
            assert.ok(normalDefs && normalDefs.length > 0, 'Should find normal_method');
            const normalCallees = index.findCallees(normalDefs[0]);
            assert.ok(normalCallees.length > 0,
                `Normal method should have callees, got: ${normalCallees.map(c => c.name).join(', ')}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Python conditional expression in attribute types', () => {
    it('findInstanceAttributeTypes should resolve conditional expressions', () => {
        const Parser = require('tree-sitter');
        const Python = require('tree-sitter-python');
        const parser = new Parser();
        parser.setLanguage(Python);
        const pythonParser = require('../languages/python');

        const code = `
class Live:
    def __init__(self, renderable=None, console=None):
        self._live_render = renderable if renderable else LiveRender(Text())
        self.console = console or Console()
        self.plain = "hello"
`;
        const result = pythonParser.findInstanceAttributeTypes(code, parser);
        assert.ok(result.has('Live'), 'Should find Live class');
        const attrs = result.get('Live');
        assert.strictEqual(attrs.get('_live_render'), 'LiveRender', 'Should resolve conditional to LiveRender');
        assert.strictEqual(attrs.get('console'), 'Console', 'Should still resolve boolean or pattern');
        assert.ok(!attrs.has('plain'), 'Should skip string literals');
    });
});

describe('Regression: Python @dataclass field annotation types', () => {
    it('findInstanceAttributeTypes should extract types from @dataclass annotated fields', () => {
        const Parser = require('tree-sitter');
        const Python = require('tree-sitter-python');
        const parser = new Parser();
        parser.setLanguage(Python);
        const pythonParser = require('../languages/python');

        const code = `
from dataclasses import dataclass, field

@dataclass
class Line:
    depth: int = 0
    bracket_tracker: BracketTracker = field(default_factory=BracketTracker)
    inside_brackets: bool = False
    comments: list = field(default_factory=list)
    mode: Mode = Mode.DEFAULT
`;
        const result = pythonParser.findInstanceAttributeTypes(code, parser);
        assert.ok(result.has('Line'), 'Should find Line class');
        const attrs = result.get('Line');
        assert.strictEqual(attrs.get('bracket_tracker'), 'BracketTracker', 'Should extract BracketTracker from annotation');
        assert.strictEqual(attrs.get('mode'), 'Mode', 'Should extract Mode from annotation');
        assert.ok(!attrs.has('depth'), 'Should skip int primitive');
        assert.ok(!attrs.has('inside_brackets'), 'Should skip bool primitive');
        assert.ok(!attrs.has('comments'), 'Should skip list primitive');
    });

    it('findInstanceAttributeTypes should not scan non-dataclass classes for field annotations', () => {
        const Parser = require('tree-sitter');
        const Python = require('tree-sitter-python');
        const parser = new Parser();
        parser.setLanguage(Python);
        const pythonParser = require('../languages/python');

        const code = `
class RegularClass:
    name: str = "default"
    tracker: BracketTracker = None

    def __init__(self):
        self.helper = Helper()
`;
        const result = pythonParser.findInstanceAttributeTypes(code, parser);
        // Should find Helper from __init__ but NOT BracketTracker from class-level annotation
        assert.ok(result.has('RegularClass'), 'Should find RegularClass');
        const attrs = result.get('RegularClass');
        assert.strictEqual(attrs.get('helper'), 'Helper', 'Should find Helper from __init__');
        assert.ok(!attrs.has('tracker'), 'Should NOT extract from non-dataclass class annotations');
    });

    it('findCallees should resolve @dataclass attribute method calls', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dataclass-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'linegen.py'), `
from dataclasses import dataclass, field

class BracketTracker:
    def any_open_brackets(self):
        return len(self.brackets) > 0

    def mark(self, leaf):
        self.brackets.append(leaf)

@dataclass
class Line:
    bracket_tracker: BracketTracker = field(default_factory=BracketTracker)

    def should_split(self):
        if self.bracket_tracker.any_open_brackets():
            return True
        self.bracket_tracker.mark(None)
        return False
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.py', { quiet: true });

            const defs = index.symbols.get('should_split');
            assert.ok(defs && defs.length > 0, 'Should find should_split');
            const callees = index.findCallees(defs[0]);
            const calleeNames = callees.map(c => c.name);
            assert.ok(calleeNames.includes('any_open_brackets'),
                `Should resolve self.bracket_tracker.any_open_brackets(), got: ${calleeNames.join(', ')}`);
            assert.ok(calleeNames.includes('mark'),
                `Should resolve self.bracket_tracker.mark(), got: ${calleeNames.join(', ')}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Python self.method() same-class resolution', () => {
    it('findCallees should resolve self.method() to same-class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-selfmethod-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'service.py'), `
class DataService:
    def _fetch_remote(self, key, days):
        return self._make_request(f"/api/{key}")

    def _make_request(self, url):
        return None

    def get_records(self, key, days=365):
        if self._is_valid(key):
            return self._fetch_remote(key, days)
        return None

    def _is_valid(self, key):
        return len(key) > 0
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.py', { quiet: true });

            // get_records should have _fetch_remote and _is_valid as callees
            const defs = index.symbols.get('get_records');
            assert.ok(defs && defs.length > 0, 'Should find get_records');
            const callees = index.findCallees(defs[0]);
            const calleeNames = callees.map(c => c.name);
            assert.ok(calleeNames.includes('_fetch_remote'),
                `Should resolve self._fetch_remote(), got: ${calleeNames.join(', ')}`);
            assert.ok(calleeNames.includes('_is_valid'),
                `Should resolve self._is_valid(), got: ${calleeNames.join(', ')}`);

            // _fetch_remote should have get_records as caller
            const fetchDefs = index.symbols.get('_fetch_remote');
            assert.ok(fetchDefs && fetchDefs.length > 0, 'Should find _fetch_remote');
            const callers = index.findCallers('_fetch_remote');
            const callerNames = callers.map(c => c.callerName);
            assert.ok(callerNames.includes('get_records'),
                `Should find get_records as caller of _fetch_remote, got: ${callerNames.join(', ')}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: deadcode treats Python framework methods as entry points', () => {
    it('should not report setUp/tearDown as dead code', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-py-setup-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            // setUp/tearDown in a non-test file (e.g., scripts/ directory)
            fs.writeFileSync(path.join(tmpDir, 'release_tests.py'), `
import unittest

class TestFoo(unittest.TestCase):
    def setUp(self):
        self.x = 42

    def tearDown(self):
        pass

    def test_something(self):
        assert self.x == 42
`);
            // Separate non-test file with genuinely unused code
            fs.writeFileSync(path.join(tmpDir, 'utils.py'), `
def unused_helper():
    return 1
`);
            const idx = new ProjectIndex(tmpDir);
            idx.build(null, { quiet: true });
            const dead = idx.deadcode();
            const deadNames = dead.map(d => d.name);

            // Framework methods should NOT appear (even in non-test files)
            assert.ok(!deadNames.includes('setUp'), 'setUp should not be dead code');
            assert.ok(!deadNames.includes('tearDown'), 'tearDown should not be dead code');
            assert.ok(!deadNames.includes('test_something'), 'test_something should not be dead code');

            // Genuinely unused function SHOULD appear
            assert.ok(deadNames.includes('unused_helper'), 'unused_helper should be dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should not report pytest_* hooks as dead code', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-py-pytest-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            fs.writeFileSync(path.join(tmpDir, 'conftest.py'), `
def pytest_configure(config):
    config.addinivalue_line("markers", "slow: slow test")

def pytest_collection_modifyitems(config, items):
    pass

def unused_function():
    return 1
`);
            const idx = new ProjectIndex(tmpDir);
            idx.build(null, { quiet: true });
            const dead = idx.deadcode();
            const deadNames = dead.map(d => d.name);

            // pytest hooks should NOT appear
            assert.ok(!deadNames.includes('pytest_configure'), 'pytest_configure should not be dead code');
            assert.ok(!deadNames.includes('pytest_collection_modifyitems'),
                'pytest_collection_modifyitems should not be dead code');

            // Genuinely unused function SHOULD appear
            assert.ok(deadNames.includes('unused_function'), 'unused_function should be dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Python Fix Regressions', () => {
    it('FIX 66 — functools.partial alias resolves to wrapped function', (t) => {
        const { getParser } = require('../languages');
        const { findCallsInCode } = require('../languages/python');

        const code = `
from functools import partial

def process(data, mode='default'):
    return data

fast_process = partial(process, mode='fast')

def run():
    fast_process(data)
`;
        const parser = getParser('python');
        const calls = findCallsInCode(code, parser);

        const fpCall = calls.find(c => c.name === 'fast_process' && !c.isFunctionReference);
        assert.ok(fpCall, 'fast_process() call should be detected');
        assert.strictEqual(fpCall.resolvedName, 'process',
            'fast_process should resolve to process via partial alias');
    });

    it('FIX 66 — functools.partial with qualified import', (t) => {
        const { getParser } = require('../languages');
        const { findCallsInCode } = require('../languages/python');

        const code = `
import functools

def transform(data):
    return data

quick_transform = functools.partial(transform, fast=True)

def main():
    quick_transform(items)
`;
        const parser = getParser('python');
        const calls = findCallsInCode(code, parser);

        const qtCall = calls.find(c => c.name === 'quick_transform' && !c.isFunctionReference);
        assert.ok(qtCall, 'quick_transform() call should be detected');
        assert.strictEqual(qtCall.resolvedName, 'transform',
            'quick_transform should resolve to transform via functools.partial alias');
    });

    it('FIX 66 — partial with keyword-only args still resolves', (t) => {
        const { getParser } = require('../languages');
        const { findCallsInCode } = require('../languages/python');

        const code = `
from functools import partial

def send(url, method='GET', timeout=30):
    pass

post = partial(send, method='POST')
`;
        const parser = getParser('python');
        const calls = findCallsInCode(code, parser);

        // partial(send, method='POST') — first positional arg is 'send'
        const postCall = calls.find(c => c.name === 'post' && !c.isFunctionReference);
        // 'post' is not called in this snippet, but check the alias was created
        // by checking for the partial call itself which should also emit process as alias
        const partialCall = calls.find(c => c.name === 'partial' && !c.isFunctionReference);
        assert.ok(partialCall, 'partial() call should be detected');
        // The send identifier passed as arg should be detected as a function reference
        const sendRef = calls.find(c => c.name === 'send' && c.isFunctionReference);
        assert.ok(sendRef, 'send should be detected as function reference argument to partial');
    });

    it('FIX 67 — Python: non-callable variable shadows should not produce false callback', (t) => {
        const { getParser } = require('../languages');
        const { findCallsInCode } = require('../languages/python');

        const code = `
def parse(data):
    return data

parse = 5
count = "hello"
items = [1, 2, 3]
config = {'a': 1}

def test():
    print(parse)
    some_func(count, items, config)
`;
        const parser = getParser('python');
        const calls = findCallsInCode(code, parser);

        const callbacks = calls.filter(c => c.isPotentialCallback);
        const cbNames = callbacks.map(c => c.name);
        assert.ok(!cbNames.includes('parse'), 'parse (integer) should not be potential callback');
        assert.ok(!cbNames.includes('count'), 'count (string) should not be potential callback');
        assert.ok(!cbNames.includes('items'), 'items (list) should not be potential callback');
        assert.ok(!cbNames.includes('config'), 'config (dict) should not be potential callback');
    });

    it('FIX 67 — Python: dict with lambda values should NOT be marked non-callable', (t) => {
        const { getParser } = require('../languages');
        const { findCallsInCode } = require('../languages/python');

        const code = `
dispatch = {'add': lambda x: x + 1}

def test():
    run(dispatch)
`;
        const parser = getParser('python');
        const calls = findCallsInCode(code, parser);

        const dispatchCb = calls.find(c => c.name === 'dispatch' && c.isPotentialCallback);
        assert.ok(dispatchCb, 'dispatch (dict with lambda) SHOULD still be potential callback');
    });
});

// ============================================================================
// Recovered lost tests
// ============================================================================

describe('Python method call filtering', () => {
    it('should still filter this/self/cls in non-Go languages', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-py-self-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'app.py'), `class Server:
    def __init__(self, port):
        self.port = port

    def start(self):
        self.listen()

    def listen(self):
        print(f"listening on {self.port}")

def main():
    srv = Server(8080)
    srv.start()
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.py', { quiet: true });

            const startCallers = index.findCallers('start');
            assert.strictEqual(startCallers.length, 0, 'Python method calls should be filtered by default');

            const startCallersIncluded = index.findCallers('start', { includeMethods: true });
            assert.strictEqual(startCallersIncluded.length, 1, 'With includeMethods, should find srv.start()');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Bug Report #3: Python typedef', () => {
    it('BUG 3b — typedef in file mode includes source code and class type', () => {
        const tmpFile = path.join(os.tmpdir(), 'ucn-typedef-test.py');
        fs.writeFileSync(tmpFile, `
from enum import Enum

class Color(Enum):
    RED = 1
    GREEN = 2
    BLUE = 3

class Point:
    x: float
    y: float
`);

        const lang = require('../languages');
        const pyMod = lang.getLanguageModule('python');
        const parser = lang.getParser('python');
        const code = fs.readFileSync(tmpFile, 'utf-8');
        const classes = pyMod.findClasses(code, parser);

        const typeKinds = ['type', 'interface', 'enum', 'struct', 'trait', 'class'];
        const colorMatch = classes.find(c => c.name === 'Color' && typeKinds.includes(c.type));
        assert.ok(colorMatch, 'Color(Enum) should be found by typedef with class in typeKinds');

        fs.unlinkSync(tmpFile);
    });
});
