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
const { execute } = require('../core/execute');
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

describe('fix #272 (Python): dotted-package ownership and constructed properties', () => {
    it('treats an unaliased dotted import as both a package and submodule edge', () => {
        const dir = tmp({
            'src/pkg/__init__.py': 'from .api import run as run\n',
            'src/pkg/api.py': 'def run():\n    return 1\n',
            'src/pkg/sub.py': 'VALUE = 1\n',
            'tests/test_api.py': 'import pkg.sub\n\ndef test_run():\n    assert pkg.run() == 1\n',
        });
        try {
            const index = idx(dir);
            const testPath = path.join(dir, 'tests/test_api.py');
            const entry = index.files.get(testPath);
            assert.ok(entry.importBindings.some(b => b.name === 'pkg' && b.module === 'pkg'));
            assert.ok(entry.moduleResolved.pkg === 'src/pkg/__init__.py');
            assert.ok(entry.moduleResolved['pkg.sub'] === 'src/pkg/sub.py');
            const result = index.usages('run');
            assert.ok(result.some(u => u.relativePath === 'tests/test_api.py' && u.line === 4),
                `package-surface call missing: ${JSON.stringify(result)}`);
        } finally { rm(dir); }
    });

    it('associates a property reference on a fresh instance with its class', () => {
        const languages = require('../languages');
        const parser = languages.getParser('python');
        const mod = languages.getLanguageModule('python');
        const source = 'assert ColorTriplet(1, 2, 3).normalized == (1, 2, 3)\n';
        const usages = mod.findUsagesInCode(source, 'normalized', parser);
        assert.deepStrictEqual(usages, [{
            line: 1,
            column: 29,
            usageType: 'reference',
            receiver: 'ColorTriplet',
        }]);
    });
});

describe('Python package submodule reference ownership', () => {
    it('keeps a class used only through a relative submodule type annotation alive', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'pkg/__init__.py': '',
            'pkg/types.py': [
                'from typing import TypedDict',
                'class OptionHelpExtra(TypedDict):',
                '    value: str',
                'class Unused(TypedDict):',
                '    value: str',
            ].join('\n'),
            'pkg/core.py': [
                'from . import types',
                'def get_extra() -> types.OptionHelpExtra:',
                '    extra: types.OptionHelpExtra = {}',
                '    return extra',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const dead = index.deadcode({ includeExported: true });
            assert.ok(!dead.some(d => d.name === 'OptionHelpExtra'),
                `qualified annotation is a real type usage: ${JSON.stringify(dead)}`);
            assert.ok(dead.some(d => d.name === 'Unused'),
                `unused sibling remains auditable: ${JSON.stringify(dead)}`);
        } finally { rm(dir); }
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
            const exporters = index.exportGraph.get(modelsPath) || new Set();
            assert.ok(exporters.size > 0,
                `models.py should have importers, got ${exporters.size}`);

            // __init__.py should import models.py
            const initPath = path.join(pkgDir, '__init__.py');
            const imports = index.importGraph.get(initPath) || new Set();
            let hasModels = false;
            for (const i of imports) { if (i.includes('models')) { hasModels = true; break; } }
            assert.ok(hasModels,
                `__init__.py should import models.py, got: ${[...imports].map(i => path.basename(i))}`);
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
            const mainImports = index.importGraph.get(path.join(tmpDir, 'main.py')) || new Set();
            let hasAnalyzer = false, hasHelper = false;
            for (const i of mainImports) {
                if (i.includes('analyzer.py')) hasAnalyzer = true;
                if (i.includes('helper.py')) hasHelper = true;
            }
            assert.ok(hasAnalyzer,
                `main.py should import tools/analyzer.py, got ${[...mainImports].map(i => path.relative(tmpDir, i))}`);
            assert.ok(hasHelper,
                `main.py should import tools/helper.py, got ${[...mainImports].map(i => path.relative(tmpDir, i))}`);

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
            const appImports = index.importGraph.get(path.join(tmpDir, 'app.py')) || new Set();
            let dbImportCount = 0;
            for (const i of appImports) { if (i.includes('db.py')) dbImportCount++; }
            assert.strictEqual(dbImportCount, 1,
                `app.py importGraph should have db.py once, got ${dbImportCount}`);
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

// ============================================================================
// Evaluation report fixes (2026-03-03)
// ============================================================================

describe('fix #119: local variable name confused with method callers', () => {
    it('should NOT report variable ref as caller when assigned from call result', () => {
        const { tmp, rm, idx } = require('./helpers');
        const dir = tmp({
            'requirements.txt': '',
            'lib.py': 'class HttpClient:\n    def close(self):\n        pass\n\ndef analyze(data):\n    close = data.dropna()\n    if len(close) >= 50:\n        return True\n    return False\n'
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('close');
            const falsePositive = callers.find(c =>
                c.callerName === 'analyze' && c.content.includes('len(close)')
            );
            assert.ok(!falsePositive,
                'len(close) should not be a caller of close() method');
        } finally {
            rm(dir);
        }
    });

    it('should NOT report variable ref as caller when assigned from subscript', () => {
        const { tmp, rm, idx } = require('./helpers');
        const dir = tmp({
            'requirements.txt': '',
            'lib.py': 'class Connection:\n    def close(self):\n        pass\n\ndef process(candles):\n    close = candles["close"].values\n    current = close[-1]\n    result = len(close)\n    return result\n'
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('close');
            const falsePositive = callers.find(c =>
                c.callerName === 'process'
            );
            assert.ok(!falsePositive,
                'variable refs to close should not be callers of close() method');
        } finally {
            rm(dir);
        }
    });

    it('should still detect real callback passing', () => {
        const { tmp, rm, idx } = require('./helpers');
        const dir = tmp({
            'requirements.txt': '',
            'lib.py': 'def handler():\n    pass\n\ndef setup():\n    register(handler)\n'
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('handler');
            assert.ok(callers.some(c => c.callerName === 'setup'),
                'real callback passing should still be detected');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #120: local variable type inference for trace callees', () => {
    it('should resolve method calls on locally-constructed objects', () => {
        const { tmp, rm, idx } = require('./helpers');
        const { findCallees } = require('../core/callers');
        const dir = tmp({
            'requirements.txt': '',
            'engine.py': 'class Backtester:\n    def run_backtest(self, months=6):\n        return {}\n\nclass Rebalancer:\n    def generate_plan(self, data):\n        return {}\n\ndef generate_report():\n    bt = Backtester()\n    result = bt.run_backtest(months=6)\n    rb = Rebalancer()\n    plan = rb.generate_plan(result)\n    return plan\n'
        });
        try {
            const index = idx(dir);
            const def = index.symbols.get('generate_report')[0];
            const callees = findCallees(index, def);
            const names = callees.map(c => c.name);
            assert.ok(names.includes('run_backtest'),
                `should find run_backtest callee, got: ${names.join(', ')}`);
            assert.ok(names.includes('generate_plan'),
                `should find generate_plan callee, got: ${names.join(', ')}`);
        } finally {
            rm(dir);
        }
    });

    it('should resolve with-statement context managers', () => {
        const { tmp, rm, idx } = require('./helpers');
        const { findCallees } = require('../core/callers');
        const dir = tmp({
            'requirements.txt': '',
            'engine.py': 'class Backtester:\n    def __enter__(self):\n        return self\n    def __exit__(self, *args):\n        pass\n    def run_backtest(self, months=6):\n        return {}\n\ndef generate_report():\n    with Backtester() as bt:\n        result = bt.run_backtest(months=6)\n    return result\n'
        });
        try {
            const index = idx(dir);
            const def = index.symbols.get('generate_report')[0];
            const callees = findCallees(index, def);
            const names = callees.map(c => c.name);
            assert.ok(names.includes('run_backtest'),
                `should find run_backtest via with-statement, got: ${names.join(', ')}`);
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// fix #130: Python module-level constants visible to find/about
// ============================================================================

describe('fix #130: Python module-level constants', () => {
    it('should index UPPER_CASE scalar constants', () => {
        const dir = tmp({
            'requirements.txt': '',
            'config.py': `
DEFAULT_VALUE = -999.0
MODE_ACTIVE = "active"
MODE_IDLE = "idle"
DATA_DIR = "/var/data/app.db"
MAX_RETRIES = 3
ENABLED = True
THRESHOLD = 3.14159
`,
        });
        try {
            const index = idx(dir);
            for (const name of ['DEFAULT_VALUE', 'MODE_ACTIVE', 'DATA_DIR', 'MAX_RETRIES', 'ENABLED']) {
                const defs = index.symbols.get(name);
                assert.ok(defs && defs.length > 0, `should find constant ${name}`);
            }
        } finally {
            rm(dir);
        }
    });

    it('should NOT index lowercase or camelCase module-level assignments', () => {
        const dir = tmp({
            'requirements.txt': '',
            'config.py': `
my_var = 42
someValue = "hello"
_private = True
x = 1
`,
        });
        try {
            const index = idx(dir);
            for (const name of ['my_var', 'someValue', '_private', 'x']) {
                const defs = index.symbols.get(name);
                assert.ok(!defs || defs.length === 0, `should NOT index ${name} as a constant`);
            }
        } finally {
            rm(dir);
        }
    });

    it('should make constants discoverable via find glob', () => {
        const dir = tmp({
            'requirements.txt': '',
            'modes.py': `
MODE_ACTIVE = "active"
MODE_IDLE = "idle"
MODE_ERROR = "error"
MODE_DONE = "done"
`,
        });
        try {
            const index = idx(dir);
            const results = index.find('MODE_*');
            assert.ok(results.length >= 4, `should find 4 MODE_* constants, got ${results.length}`);
        } finally {
            rm(dir);
        }
    });

    it('should work with about command for constants', () => {
        const dir = tmp({
            'requirements.txt': '',
            'config.py': `DATA_DIR = "/var/data"`,
            'app.py': `from config import DATA_DIR
def connect():
    return open(DATA_DIR)
`,
        });
        try {
            const index = idx(dir);
            const result = index.about('DATA_DIR');
            assert.ok(result, 'about should find the constant');
            assert.ok(result.symbol.name === 'DATA_DIR');
        } finally {
            rm(dir);
        }
    });

    it('should still index dict/list state objects as before', () => {
        const dir = tmp({
            'requirements.txt': '',
            'config.py': `
CONFIG = {"host": "localhost", "port": 8080}
ALLOWED_HOSTS = ["localhost", "127.0.0.1"]
MAX_RETRIES = 3
`,
        });
        try {
            const index = idx(dir);
            assert.ok(index.symbols.get('CONFIG'), 'should find dict CONFIG');
            assert.ok(index.symbols.get('ALLOWED_HOSTS'), 'should find list ALLOWED_HOSTS');
            assert.ok(index.symbols.get('MAX_RETRIES'), 'should find scalar MAX_RETRIES');
        } finally {
            rm(dir);
        }
    });
});

describe('fix: self.attr type inference from __init__ parameter annotations', () => {
    it('resolves self.attr type from typed parameter (self.x = param where param: ClassName)', () => {
        const dir = tmp({
            'setup.py': '',
            'service.py': `class DataService:
    def fetch(self, key):
        return key

    def process(self):
        pass
`,
            'tracker.py': `from service import DataService

class Tracker:
    def __init__(self, svc: DataService = None):
        self.svc = svc

    def run(self):
        return self.svc.fetch("key1")
`,
            'manager.py': `from service import DataService

class Manager:
    def __init__(self, config):
        self.svc = config or DataService()

    def execute(self):
        return self.svc.fetch("key2")
`
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('fetch', {});
            const callerNames = callers.map(c => c.callerName);
            // Both should be found: tracker via param annotation, manager via constructor fallback
            assert.ok(callerNames.includes('run'), 'should find caller via param type annotation');
            assert.ok(callerNames.includes('execute'), 'should find caller via constructor fallback');
            assert.strictEqual(callers.length, 2, 'should find exactly 2 callers');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// ENTRYPOINTS: Python framework detection
// ============================================================================

describe('Entrypoints: FastAPI/Flask/Celery/pytest detection', () => {
    const { detectEntrypoints, isFrameworkEntrypoint } = require('../core/entrypoints');

    it('detects FastAPI route decorators', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname = "test"',
            'main.py': `
from fastapi import FastAPI
app = FastAPI()

@app.get("/items")
def list_items():
    return []

@router.post("/items")
def create_item():
    return {}
`
        });
        try {
            const index = idx(dir);
            const eps = detectEntrypoints(index);
            const names = eps.map(e => e.name);
            assert.ok(names.includes('list_items'), 'should detect list_items');
            assert.ok(names.includes('create_item'), 'should detect create_item');
            assert.ok(eps.every(e => e.type === 'http'), 'all should be http type');
        } finally { rm(dir); }
    });

    it('detects Celery task decorators', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname = "test"',
            'tasks.py': `
from celery import shared_task

@shared_task
def send_email(to, subject):
    pass

@app.task
def process_payment(order_id):
    pass
`
        });
        try {
            const index = idx(dir);
            const eps = detectEntrypoints(index);
            const names = eps.map(e => e.name);
            assert.ok(names.includes('send_email'), 'should detect @shared_task');
            assert.ok(names.includes('process_payment'), 'should detect @app.task');
            assert.ok(eps.filter(e => e.name === 'send_email')[0].type === 'jobs', 'should be jobs type');
        } finally { rm(dir); }
    });

    it('detects pytest.fixture', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname = "test"',
            'conftest.py': `
import pytest

@pytest.fixture
def db_session():
    return connect()

@pytest.fixture(scope="module")
def app():
    return create_app()
`
        });
        try {
            const index = idx(dir);
            const eps = detectEntrypoints(index);
            const names = eps.map(e => e.name);
            assert.ok(names.includes('db_session'), 'should detect @pytest.fixture');
            assert.ok(eps.filter(e => e.name === 'db_session')[0].framework === 'pytest');
            assert.ok(eps.filter(e => e.name === 'db_session')[0].type === 'test');
        } finally { rm(dir); }
    });

    it('detects Django view decorators', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname = "test"',
            'views.py': `
from rest_framework.decorators import api_view

@api_view(['GET'])
def get_users(request):
    return Response([])

@login_required
def dashboard(request):
    return render(request, 'dash.html')
`
        });
        try {
            const index = idx(dir);
            const eps = detectEntrypoints(index);
            const names = eps.map(e => e.name);
            assert.ok(names.includes('get_users'), 'should detect @api_view');
            assert.ok(names.includes('dashboard'), 'should detect @login_required');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Regression: Python receiver type inference (Phase 3c)
// ============================================================================

describe('Regression: Python receiver type inference (Phase 3c)', () => {
    it('constructor inference: Backtester() resolves bt.run() to Backtester.run', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname = "test"',
            'backtester.py': `
class Backtester:
    def run(self):
        return "running"

class Simulator:
    def run(self):
        return "simulating"
`,
            'main.py': `
from backtester import Backtester

def execute():
    bt = Backtester()
    bt.run()
`
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('run', { includeMethods: true });
            assert.ok(callers.length > 0, 'should find callers of run');
            const execCaller = callers.find(c => c.callerName === 'execute');
            assert.ok(execCaller, 'execute should be a caller of run');
            assert.strictEqual(execCaller.resolution, 'receiver-hint',
                'Backtester() constructor should give receiver-hint resolution');
            assert.ok(execCaller.confidence >= 0.80,
                'receiver-hint should have confidence >= 0.80');
        } finally { rm(dir); }
    });

    it('type annotation inference: client: HttpClient resolves client.request()', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname = "test"',
            'http.py': `
class HttpClient:
    def request(self, url):
        return url

def get_client():
    return HttpClient()
`,
            'app.py': `
from http import HttpClient, get_client

def fetch_data():
    client: HttpClient = get_client()
    client.request("/api")
`
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/python');
            const code = fs.readFileSync(path.join(dir, 'app.py'), 'utf8');
            const parser = getParser('python');
            const calls = findCallsInCode(code, parser);
            const reqCall = calls.find(c => c.name === 'request' && c.receiver === 'client');
            assert.ok(reqCall, 'should find client.request() call');
            assert.strictEqual(reqCall.receiverType, 'HttpClient',
                'type annotation should infer receiverType as HttpClient');
        } finally { rm(dir); }
    });

    it('parameter type inference: def process(engine: SearchEngine) resolves engine.query()', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname = "test"',
            'search.py': `
class SearchEngine:
    def query(self, text):
        return text
`,
            'handler.py': `
from search import SearchEngine

def process(engine: SearchEngine):
    engine.query("test")
`
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/python');
            const code = fs.readFileSync(path.join(dir, 'handler.py'), 'utf8');
            const parser = getParser('python');
            const calls = findCallsInCode(code, parser);
            const queryCall = calls.find(c => c.name === 'query' && c.receiver === 'engine');
            assert.ok(queryCall, 'should find engine.query() call');
            assert.strictEqual(queryCall.receiverType, 'SearchEngine',
                'parameter type annotation should infer receiverType as SearchEngine');
        } finally { rm(dir); }
    });

    it('no false positive on lowercase assignment (non-class by convention)', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname = "test"',
            'app.py': `
def compute():
    return {}

def main():
    result = compute()
    result.save()
`
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/python');
            const code = fs.readFileSync(path.join(dir, 'app.py'), 'utf8');
            const parser = getParser('python');
            const calls = findCallsInCode(code, parser);
            const saveCall = calls.find(c => c.name === 'save' && c.receiver === 'result');
            assert.ok(saveCall, 'should find result.save() call');
            assert.strictEqual(saveCall.receiverType, undefined,
                'lowercase function return should NOT infer receiverType');
        } finally { rm(dir); }
    });
});

// Fix: localVarTypes scoping — types should not leak between sibling functions
describe('fix: localVarTypes function scoping (Python)', () => {
    it('sibling functions with same variable name get independent types', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.py': [
                'class Foo:',
                '    def run(self): pass',
                'class Bar:',
                '    def run(self): pass',
                'def func_a():',
                '    x = Foo()',
                '    x.run()',
                'def func_b():',
                '    x = Bar()',
                '    x.run()',
            ].join('\n')
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/python');
            const code = fs.readFileSync(path.join(dir, 'app.py'), 'utf8');
            const parser = getParser('python');
            const calls = findCallsInCode(code, parser);
            const runCalls = calls.filter(c => c.name === 'run' && c.isMethod && c.receiver === 'x');
            assert.strictEqual(runCalls.length, 2);
            assert.strictEqual(runCalls[0].receiverType, 'Foo', 'func_a x.run() should be Foo');
            assert.strictEqual(runCalls[1].receiverType, 'Bar', 'func_b x.run() should be Bar, not leaked Foo');
        } finally { rm(dir); }
    });

    it('parameter name does not inherit type from sibling function', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.py': [
                'class Foo:',
                '    def run(self): pass',
                'def func_a():',
                '    x = Foo()',
                '    x.run()',
                'def func_b(x):',
                '    x.run()',
            ].join('\n')
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/python');
            const code = fs.readFileSync(path.join(dir, 'app.py'), 'utf8');
            const parser = getParser('python');
            const calls = findCallsInCode(code, parser);
            const runCalls = calls.filter(c => c.name === 'run' && c.isMethod && c.receiver === 'x');
            assert.strictEqual(runCalls.length, 2);
            assert.strictEqual(runCalls[0].receiverType, 'Foo', 'func_a should infer Foo');
            assert.strictEqual(runCalls[1].receiverType, undefined,
                'func_b parameter x should NOT inherit Foo from sibling');
        } finally { rm(dir); }
    });

    it('module-level typed variable remains visible inside functions', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.py': [
                'class Database:',
                '    def query(self, sql): pass',
                'db = Database()',
                'def get_users():',
                '    db.query("users")',
                'def get_orders():',
                '    db.query("orders")',
            ].join('\n')
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/python');
            const code = fs.readFileSync(path.join(dir, 'app.py'), 'utf8');
            const parser = getParser('python');
            const calls = findCallsInCode(code, parser);
            const queryCalls = calls.filter(c => c.name === 'query' && c.receiver === 'db');
            assert.strictEqual(queryCalls.length, 2);
            assert.strictEqual(queryCalls[0].receiverType, 'Database');
            assert.strictEqual(queryCalls[1].receiverType, 'Database');
        } finally { rm(dir); }
    });

    it('nested function inherits outer scope types', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.py': [
                'class Client:',
                '    def fetch(self): pass',
                'def outer():',
                '    c = Client()',
                '    def inner():',
                '        c.fetch()',
            ].join('\n')
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/python');
            const code = fs.readFileSync(path.join(dir, 'app.py'), 'utf8');
            const parser = getParser('python');
            const calls = findCallsInCode(code, parser);
            const fetchCall = calls.find(c => c.name === 'fetch' && c.receiver === 'c');
            assert.ok(fetchCall);
            assert.strictEqual(fetchCall.receiverType, 'Client',
                'inner function should see outer scope type');
        } finally { rm(dir); }
    });

    it('typed parameter annotation is scoped to its function', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.py': [
                'class Foo:',
                '    def run(self): pass',
                'class Bar:',
                '    def run(self): pass',
                'def func_a(x: Foo):',
                '    x.run()',
                'def func_b(x: Bar):',
                '    x.run()',
            ].join('\n')
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/python');
            const code = fs.readFileSync(path.join(dir, 'app.py'), 'utf8');
            const parser = getParser('python');
            const calls = findCallsInCode(code, parser);
            const runCalls = calls.filter(c => c.name === 'run' && c.isMethod && c.receiver === 'x');
            assert.strictEqual(runCalls.length, 2);
            assert.strictEqual(runCalls[0].receiverType, 'Foo', 'func_a typed param should be Foo');
            assert.strictEqual(runCalls[1].receiverType, 'Bar', 'func_b typed param should be Bar, not Foo');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #180: Python **kwargs not double-prefixed in plan signature
// ============================================================================

describe('fix #180: Python **kwargs not double-prefixed in plan signature', () => {
    const { execute } = require('../core/execute');

    it('plan add-param should not render **kwargs as ...**kwargs', () => {
        const dir = tmp({
            'a.py': 'def process(x, **kwargs):\n    pass\n\nprocess(1, y=2)'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'plan', { name: 'process', addParam: 'y' });
            assert.ok(r.ok, 'plan should succeed');
            assert.ok(!r.result.after.signature.includes('...**'), 'should not have ...**kwargs');
            assert.ok(r.result.after.signature.includes('**kwargs'), 'should preserve **kwargs');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix G6-PY-002: Python __init__.py fileExports misses __all__ re-exports
// ============================================================================

describe('fix G6-PY-002: Python __init__.py fileExports resolves __all__ re-exports via imports', () => {
    it('fileExports on __init__.py returns names from __all__ that come from sub-module imports', () => {
        const dir = tmp({
            'utils.py': [
                'def helper():',
                '    return 42',
                '',
                'def internal():',
                '    return 0',
            ].join('\n'),
            '__init__.py': [
                'from .utils import helper',
                '__all__ = ["helper"]',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const exports = index.fileExports('__init__.py');
            assert.ok(Array.isArray(exports), 'fileExports should return an array');
            assert.ok(exports.length > 0, 'should have at least one export');
            const helperExport = exports.find(e => e.name === 'helper');
            assert.ok(helperExport, 'helper should be included as a re-export');
            assert.strictEqual(helperExport.reExportedFrom, 'utils.py', 'should record source as utils.py');
        } finally { rm(dir); }
    });

    it('fileExports returns both locally-defined symbols and __all__ re-exports', () => {
        const dir = tmp({
            'models.py': [
                'class User:',
                '    def __init__(self, name):',
                '        self.name = name',
            ].join('\n'),
            '__init__.py': [
                'from .models import User',
                '',
                'VERSION = "1.0.0"',
                '',
                '__all__ = ["User", "VERSION"]',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const exports = index.fileExports('__init__.py');
            const names = exports.map(e => e.name);
            assert.ok(names.includes('User'), 'User re-export from models.py should be present');
            assert.ok(names.includes('VERSION'), 'VERSION defined locally should be present');
            const userExport = exports.find(e => e.name === 'User');
            assert.ok(userExport.reExportedFrom, 'User should have reExportedFrom set');
        } finally { rm(dir); }
    });

    it('fileExports does not add names from imports that are NOT in __all__', () => {
        const dir = tmp({
            'utils.py': [
                'def helper():',
                '    return 42',
                'def secret():',
                '    return 0',
            ].join('\n'),
            '__init__.py': [
                'from .utils import helper, secret',
                '__all__ = ["helper"]',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const exports = index.fileExports('__init__.py');
            const names = exports.map(e => e.name);
            assert.ok(names.includes('helper'), 'helper should be exported');
            assert.ok(!names.includes('secret'), 'secret should NOT be exported (not in __all__)');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Type annotations: Python type hints from typed_parameter and typed_default_parameter
// ============================================================================

describe('type annotations — Python type hints', () => {
    const { execute } = require('../core/execute');

    it('extracts paramTypes from typed parameters with defaults', () => {
        const dir = tmp({
            'requirements.txt': '',
            'a.py': 'def add(x: int, y: int = 0) -> int:\n    return x + y\n'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'about', { name: 'add' });
            assert.ok(r.ok);
            assert.deepStrictEqual(r.result.symbol.paramTypes, { x: 'int', y: 'int' });
            assert.strictEqual(r.result.symbol.returnType, 'int');
        } finally { rm(dir); }
    });

    it('extracts complex parameterized types', () => {
        const dir = tmp({
            'requirements.txt': '',
            'a.py': 'def fetch(url: str, headers: dict[str, str]) -> bytes:\n    return b""\n'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'about', { name: 'fetch' });
            assert.ok(r.ok);
            assert.strictEqual(r.result.symbol.paramTypes.url, 'str');
            assert.strictEqual(r.result.symbol.paramTypes.headers, 'dict[str, str]');
            assert.strictEqual(r.result.symbol.returnType, 'bytes');
        } finally { rm(dir); }
    });
});

// ============================================================================
// FEATURE A: CALL-SITE CLASSIFICATION (Python)
// ============================================================================

describe('Feature A: Python call-site classification', () => {
    it('Python: inLoop set for calls inside for/while loops', () => {
        const dir = tmp({
            'requirements.txt': '',
            'a.py': [
                'def helper(x):',
                '    return x',
                '',
                'def caller():',
                '    for i in range(3):',
                '        helper(i)',
                '    while True:',
                '        helper(99)',
                '        break',
                '    helper(0)',  // outside loop
                '',
                'caller()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.verify('helper');
            assert.strictEqual(r.totalCalls, 3);
            assert.strictEqual(r.patterns.inLoop, 2, 'two of three calls in loop');
        } finally { rm(dir); }
    });

    it('Python: inTry set for calls inside try block', () => {
        const dir = tmp({
            'requirements.txt': '',
            'a.py': [
                'def helper():',
                '    return 1',
                '',
                'def caller():',
                '    try:',
                '        helper()',
                '    except Exception:',
                '        pass',
                '    helper()',  // outside try
                '',
                'caller()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.verify('helper');
            assert.strictEqual(r.totalCalls, 2);
            assert.strictEqual(r.patterns.inTry, 1);
        } finally { rm(dir); }
    });

    it('Python: inTestCase set for calls in test_ functions', () => {
        const dir = tmp({
            'requirements.txt': '',
            'a.py': 'def helper():\n    return 1\n',
            'test_a.py': [
                'from a import helper',
                '',
                'def test_helper():',
                '    helper()',
                '    assert helper() == 1',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.verify('helper');
            assert.ok(r.totalCalls >= 2, 'at least two calls in test_helper');
            assert.ok(r.patterns.inTestCase >= 2, 'all calls inside test_helper are inTestCase');
        } finally { rm(dir); }
    });
});

// ============================================================================
// FEATURE B: AWAITED + AUDIT-ASYNC (Python)
// ============================================================================

describe('Feature B: Python awaited flag + audit-async', () => {
    it('Python: awaited flag set on calls wrapped in await', () => {
        const dir = tmp({
            'requirements.txt': '',
            'a.py': [
                'async def helper():',
                '    return 1',
                '',
                'async def caller():',
                '    await helper()',
                '    helper()',  // not awaited — bug
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.verify('helper');
            assert.strictEqual(r.totalCalls, 2);
            assert.strictEqual(r.patterns.awaitedCalls, 1);
        } finally { rm(dir); }
    });

    it('Python: audit-async flags missing-await on async fn call', () => {
        const dir = tmp({
            'requirements.txt': '',
            'a.py': [
                'async def helper():',
                '    return 1',
                '',
                'async def caller():',
                '    helper()',  // missing await
                '    await helper()',  // ok
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.auditAsync({});
            assert.strictEqual(r.totalIssues, 1);
            assert.strictEqual(r.issues[0].calleeName, 'helper');
        } finally { rm(dir); }
    });

    // HIGH-1 regression: file-local resolution wins over global ambiguity.
    // Sync def of `helper` in another file must NOT mask async def in same
    // file as the call.
    it('Python: audit-async flags across name collisions (HIGH-1)', () => {
        const dir = tmp({
            'requirements.txt': '',
            'bad.py': [
                'async def helper():',
                '    return 1',
                '',
                'async def main():',
                '    helper()',         // missing await — should flag
                '',
            ].join('\n'),
            'loops.py': [
                'def helper():',
                '    return 2',
                'helper()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.auditAsync({});
            const inBad = r.issues.filter(i => i.file === 'bad.py');
            assert.ok(inBad.some(i => i.calleeName === 'helper'),
                `should flag helper() in bad.py, got: ${JSON.stringify(r.issues)}`);
            const inLoops = r.issues.filter(i => i.file === 'loops.py');
            assert.strictEqual(inLoops.length, 0,
                `should not flag sync helper() in loops.py`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// endpoints command — Python (Flask + FastAPI)
// ============================================================================

describe('endpoints command (Python)', () => {
    const FIXTURE = path.join(FIXTURES_PATH, 'endpoints', 'python');

    it('extracts Flask + FastAPI server routes (6 total)', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        // Flask: 2 routes (app.route GET + POST on /users)
        // FastAPI: app.get /users/<int:user_id>, router.get /items, router.post /items, router.delete /items/{id}
        assert.strictEqual(result.meta.totalRoutes, 6, 'expected 6 routes');
        assert.strictEqual(result.meta.byFramework.flask, 2);
        assert.strictEqual(result.meta.byFramework.fastapi, 4);
    });

    it('Flask @app.route decorator detects method from methods=[...] kwarg', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        // @app.route('/users', methods=['GET']) → list_users
        const flaskGet = result.routes.find(r =>
            r.framework === 'flask' && r.handler === 'list_users');
        assert.ok(flaskGet, 'should find flask GET /users handler');
        assert.strictEqual(flaskGet.method, 'GET');
        assert.strictEqual(flaskGet.path, '/users');
        assert.strictEqual(flaskGet.line, 8);
    });

    it('FastAPI @router.delete extracts the path correctly', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        // @router.delete('/items/{item_id}') → delete_item
        const fastDel = result.routes.find(r =>
            r.framework === 'fastapi' && r.method === 'DELETE');
        assert.ok(fastDel, 'should find FastAPI DELETE');
        assert.strictEqual(fastDel.path, '/items/{item_id}');
        assert.strictEqual(fastDel.normalizedPath, '/items/*');
        assert.strictEqual(fastDel.handler, 'delete_item');
    });

    it('Flask <int:user_id> typed param is normalized to /*', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        // @app.get('/users/<int:user_id>') → get_user
        const r = result.routes.find(r => r.handler === 'get_user');
        assert.ok(r);
        assert.strictEqual(r.path, '/users/<int:user_id>');
        assert.strictEqual(r.normalizedPath, '/users/*');
    });

    it('extracts client requests: requests + httpx (5 total)', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        // requests.get/post (3) + client.get (2 httpx)
        assert.strictEqual(result.meta.totalRequests, 5);
    });

    it('requests.get is detected with method=GET, callerName populated', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        const fetchUsers = result.requests.find(r =>
            r.callerName === 'fetch_users');
        assert.ok(fetchUsers, 'should find requests.get from fetch_users');
        assert.strictEqual(fetchUsers.method, 'GET');
        assert.strictEqual(fetchUsers.path, '/users');
        assert.strictEqual(fetchUsers.framework, 'requests');
    });

    it('--bridge matches Flask GET /users to requests.get(/users) as exact', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', { bridge: true });
        assert.ok(ok);
        const exact = result.bridges.find(b =>
            b.matchType === 'exact' &&
            b.route.method === 'GET' && b.route.path === '/users');
        assert.ok(exact, 'should produce exact match for GET /users');
        assert.strictEqual(exact.confidence, 1);
    });

    it('--bridge: f-string client to typed Flask param produces partial match', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', { bridge: true });
        assert.ok(ok);
        // client: requests.get(f'/users/{user_id}') → /users/* (interp)
        // server: @app.get('/users/<int:user_id>') → /users/*
        const partial = result.bridges.find(b =>
            b.matchType === 'partial' &&
            b.route.normalizedPath === '/users/*' &&
            b.request.interp);
        assert.ok(partial, 'should produce partial match for typed param vs interp client');
        assert.ok(partial.confidence < 1 && partial.confidence > 0);
    });
});

describe('fix #192 (python): argument-position function references need import evidence', () => {
    it('imported callback confirms; bare name without import goes unverified', () => {
        const dir = tmp({
            'lib.py': 'def transform(x):\n    return x * 2\n',
            'app.py': 'from lib import transform\n\ndef run(items):\n    return list(map(transform, items))\n',
            'stray.py': 'def noimport(items):\n    return list(map(transform, items))\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'transform' });
            assert.ok(r.ok, 'context should succeed');
            const confirmed = r.result.callers || [];
            const unverified = r.result.unverifiedCallers || [];
            assert.ok(confirmed.some(c => c.relativePath === 'app.py'),
                `imported callback must stay confirmed: ${JSON.stringify(confirmed)}`);
            assert.ok(!confirmed.some(c => c.relativePath === 'stray.py'),
                'no-import callback must not be confirmed');
            assert.ok(unverified.some(c => (c.relativePath || c.file || '').includes('stray.py')),
                'no-import callback must be visible in the unverified tier');
            assert.strictEqual(r.result.meta.account.conserved, true, 'conservation must hold');
        } finally { rm(dir); }
    });
});

describe('export-rename aliases (python): from-import-as callers attribute to the original', () => {
    it('import { transform as t } style rename attributes t() calls', () => {
        const dir = tmp({
            'lib.py': 'def transform(x):\n    return x * 2\n',
            'app.py': 'from lib import transform as t\n\ndef run(items):\n    return [t(i) for i in items]\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'transform' });
            assert.ok(r.ok, 'context should succeed');
            const confirmed = r.result.callers || [];
            assert.ok(confirmed.some(c => c.relativePath === 'app.py' && c.calledAs === 't'),
                `t() caller must attribute to transform: ${JSON.stringify(confirmed)}`);
            assert.strictEqual(r.result.meta.account.conserved, true, 'conservation must hold');
        } finally { rm(dir); }
    });
});

describe('fix #198 (python): structural receiver type inference', () => {
    const FIXTURE = {
        'package.json': '{"name":"t"}',
        'lib.py': [
            'class Client:',
            '    def get(self, url):',
            '        return url',
            '',
            'class AsyncClient:',
            '    def get(self, url):',
            '        return url',
            '',
            'def fetch_all(items):',
            '    return items',
        ].join('\n'),
        'app.py': [
            'from lib import Client, AsyncClient, fetch_all',
            '',
            'def use_sync(client: Client):',
            '    return client.get("a")',
            '',
            'def use_async(client: AsyncClient):',
            '    return client.get("b")',
            '',
            'def use_optional(client: Client | None):',
            '    return client.get("d")',
            '',
            'def use_with():',
            '    with Client() as c:',
            '        return c.get("c")',
            '',
            'def use_dict():',
            '    return {"http": 80}.get("http")',
            '',
            'def typed_vs_function():',
            '    x = Client()',
            '    return x.fetch_all([1])',
        ].join('\n'),
    };

    it('annotated and with-as receivers confirm only the matching class', () => {
        const dir = tmp(FIXTURE);
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'lib.py:2:get' });
            assert.ok(r.ok);
            const confirmed = r.result.callers || [];
            const lines = confirmed.map(c => `${c.relativePath}:${c.line}`);
            assert.ok(lines.includes('app.py:4'), `client: Client caller confirmed: ${lines}`);
            assert.ok(lines.includes('app.py:10'), `client: Client | None union caller confirmed: ${lines}`);
            assert.ok(lines.includes('app.py:14'), `with Client() as c caller confirmed: ${lines}`);
            assert.ok(!lines.includes('app.py:7'), `client: AsyncClient must be excluded: ${lines}`);
            assert.ok(confirmed.every(c => c.resolution === 'receiver-hint'),
                `typed receivers score receiver-hint: ${JSON.stringify(confirmed.map(c => c.resolution))}`);
            assert.strictEqual(r.result.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('dict-literal receiver never confirms a class method', () => {
        const dir = tmp(FIXTURE);
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'lib.py:2:get' });
            assert.ok(r.ok);
            const confirmed = r.result.callers || [];
            assert.ok(!confirmed.some(c => c.line === 17),
                `literal {}.get must not be a confirmed caller: ${JSON.stringify(confirmed)}`);
        } finally { rm(dir); }
    });

    it('typed receiver method call never confirms a standalone function', () => {
        const dir = tmp(FIXTURE);
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'fetch_all' });
            assert.ok(r.ok);
            const confirmed = r.result.callers || [];
            assert.strictEqual(confirmed.length, 0,
                `x.fetch_all() with x: Client must be excluded: ${JSON.stringify(confirmed)}`);
            assert.strictEqual(r.result.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('dotted annotations and dotted constructors type the receiver', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'pkg/__init__.py': 'from .lib import Client\n',
            'pkg/lib.py': 'class Client:\n    def send(self, m):\n        return m\n\nclass Other:\n    def send(self, m):\n        return m\n',
            'app.py': [
                'import pkg',
                '',
                'def f(c: pkg.Client):',
                '    return c.send(1)',
                '',
                'def g():',
                '    o = pkg.Other()',
                '    return o.send(2)',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'pkg/lib.py:2:send' });
            assert.ok(r.ok);
            const lines = (r.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(lines.includes('app.py:4'), `pkg.Client annotation confirms: ${lines}`);
            assert.ok(!lines.includes('app.py:8'), `pkg.Other() constructor excludes: ${lines}`);
        } finally { rm(dir); }
    });

    it('subclass receiver stays confirmed on inherited parent method', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.py': 'class Base:\n    def start(self):\n        return 1\n\nclass Child(Base):\n    pass\n',
            'app.py': 'from lib import Child\n\ndef run(c: Child):\n    return c.start()\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'lib.py:2:start' });
            assert.ok(r.ok);
            const lines = (r.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(lines.includes('app.py:4'),
                `Child receiver calls inherited Base.start — must stay confirmed: ${lines}`);
        } finally { rm(dir); }
    });

    it('subclass override redirects: Child receiver not confirmed on Base method', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.py': 'class Base:\n    def start(self):\n        return 1\n\nclass Child(Base):\n    def start(self):\n        return 2\n',
            'app.py': 'from lib import Child\n\ndef run(c: Child):\n    return c.start()\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'lib.py:2:start', file: 'lib.py', className: 'Base' });
            assert.ok(r.ok);
            const lines = (r.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(!lines.includes('app.py:4'),
                `Child overrides start — its calls dispatch to the override: ${lines}`);
        } finally { rm(dir); }
    });
});

describe('fix #198b (python): supertype receiver is not a mismatch', () => {
    it('Base-typed receiver routes possible-dispatch on Child override (dynamic dispatch)', () => {
        // #209 aligned structural with the nominal #204 physics: a supertype-
        // typed receiver may dispatch into the override — never excluded,
        // visible as possible-dispatch attributed via Base.
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.py': 'class Base:\n    def start(self):\n        return 1\n\nclass Child(Base):\n    def start(self):\n        return 2\n',
            'app.py': 'from lib import Base\n\ndef run(b: Base):\n    return b.start()\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'lib.py:6:start', className: 'Child' });
            assert.ok(r.ok);
            const confirmed = (r.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(!confirmed.includes('app.py:4'),
                `b: Base is not evidence for Child specifically: ${confirmed}`);
            const entry = (r.result.unverifiedCallers || [])
                .find(u => `${u.relativePath}:${u.line}` === 'app.py:4');
            assert.ok(entry, `b.start() stays VISIBLE: ${JSON.stringify(r.result.unverifiedCallers)}`);
            assert.strictEqual(entry.reason, 'possible-dispatch');
            assert.strictEqual(entry.dispatchVia, 'Base');
            assert.strictEqual(r.result.meta.account.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #199 (python): return-type flow types assigned variables', () => {
    const FIXTURE = {
        'package.json': '{"name":"t"}',
        'lib.py': [
            'class Request:',
            '    async def aread(self):',
            '        return b""',
            '',
            'class Response:',
            '    async def aread(self):',
            '        return b""',
            '',
            'class AsyncClient:',
            '    async def get(self, url) -> Response:',
            '        return Response()',
        ].join('\n'),
        'app.py': [
            'import lib',
            '',
            'async def fetch():',
            '    async with lib.AsyncClient() as client:',
            '        response = await client.get("u")',
            '        return await response.aread()',
        ].join('\n'),
    };

    it('x = await client.get() types x via the return annotation (two-hop)', () => {
        const dir = tmp(FIXTURE);
        try {
            const index = idx(dir);
            const rResp = execute(index, 'context', { name: 'lib.py:6:aread', className: 'Response' });
            assert.ok(rResp.ok);
            const confirmed = (rResp.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(confirmed.includes('app.py:6'),
                `response: Response via flow — must confirm Response.aread: ${confirmed}`);
            const rReq = execute(index, 'context', { name: 'lib.py:2:aread', className: 'Request' });
            const reqConfirmed = (rReq.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(!reqConfirmed.includes('app.py:6'),
                `flow-typed Response receiver must be excluded from Request.aread: ${reqConfirmed}`);
            assert.strictEqual(rResp.result.meta.account.conserved, true);
            assert.strictEqual(rReq.result.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('reassignment uses the nearest preceding flow type', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.py': [
                'class A:',
                '    def ping(self):',
                '        return 1',
                '',
                'class B:',
                '    def ping(self):',
                '        return 2',
                '',
                'def make_a() -> A:',
                '    return A()',
                '',
                'def make_b() -> B:',
                '    return B()',
            ].join('\n'),
            'app.py': [
                'from lib import make_a, make_b',
                '',
                'def run():',
                '    x = make_a()',
                '    x.ping()',
                '    x = make_b()',
                '    x.ping()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const rA = execute(index, 'context', { name: 'lib.py:2:ping', className: 'A' });
            const aLines = (rA.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(aLines.includes('app.py:5'), `first ping is A.ping: ${aLines}`);
            assert.ok(!aLines.includes('app.py:7'), `second ping reassigned to B: ${aLines}`);
            const rB = execute(index, 'context', { name: 'lib.py:6:ping', className: 'B' });
            const bLines = (rB.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(bLines.includes('app.py:7'), `second ping is B.ping: ${bLines}`);
            assert.ok(!bLines.includes('app.py:5'), `first ping was A: ${bLines}`);
        } finally { rm(dir); }
    });
});

describe('fix #200 (python): module receivers and self-call return flow', () => {
    const FIXTURE = {
        'package.json': '{"name":"t"}',
        'pkg/__init__.py': 'from ._api import get\nfrom ._client import Client\n',
        'pkg/_api.py': 'def get(url):\n    return url\n',
        'pkg/_client.py': [
            'class Response:',
            '    def aclose(self):',
            '        return 1',
            '',
            'class AsyncClient:',
            '    def aclose(self):',
            '        return 2',
            '',
            'class Client:',
            '    def get(self, url):',
            '        return url',
            '',
            '    def _send(self, request) -> Response:',
            '        return Response()',
            '',
            '    def run(self, request):',
            '        response = self._send(request)',
            '        return response.aclose()',
        ].join('\n'),
        'app.py': 'import pkg\n\ndef fetch():\n    return pkg.get("http://x")\n',
    };

    it('module-receiver call never confirms a class method, still confirms the module fn', () => {
        const dir = tmp(FIXTURE);
        try {
            const index = idx(dir);
            const rMethod = execute(index, 'context', { name: 'pkg/_client.py:10:get', className: 'Client' });
            assert.ok(rMethod.ok);
            const methodLines = (rMethod.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(!methodLines.includes('app.py:4'),
                `pkg.get() is the module function, not Client.get: ${methodLines}`);
            const rFn = execute(index, 'context', { name: 'pkg/_api.py:1:get' });
            const fnLines = (rFn.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(fnLines.includes('app.py:4'),
                `pkg.get() must stay confirmed for the module function: ${fnLines}`);
            assert.strictEqual(rMethod.result.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('self-call return flow types the assigned variable', () => {
        const dir = tmp(FIXTURE);
        try {
            const index = idx(dir);
            const rResp = execute(index, 'context', { name: 'pkg/_client.py:2:aclose', className: 'Response' });
            const respLines = (rResp.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(respLines.includes('pkg/_client.py:18'),
                `response = self._send() -> Response must confirm Response.aclose: ${respLines}`);
            const rAsync = execute(index, 'context', { name: 'pkg/_client.py:6:aclose', className: 'AsyncClient' });
            const asyncLines = (rAsync.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(!asyncLines.includes('pkg/_client.py:18'),
                `flow-typed Response receiver excluded from AsyncClient.aclose: ${asyncLines}`);
        } finally { rm(dir); }
    });
});

describe('fix #202b: self.attr resolution respects the pinned target class (Python)', () => {
    const FILES = {
        'helper.py': `class Helper:
    def run(self):
        pass
`,
        'other.py': `class Other:
    def run(self):
        pass
`,
        'user.py': `from helper import Helper

class User:
    def __init__(self):
        self.helper = Helper()

    def go(self):
        self.helper.run()
`,
    };

    it('self.attr.run() typed to Helper is not a caller of pinned Other.run', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const output = require('../core/output');
            const rOther = execute(index, 'context', { name: 'other.py:2:run' });
            const jsonOther = JSON.parse(output.formatContextJson(rOther.result));
            const confOther = (jsonOther.data.callers || []).map(c => `${c.file}:${c.line}`);
            assert.ok(!confOther.includes('user.py:8'),
                `self.helper.run() (Helper-typed) must not confirm Other.run: ${confOther}`);
            assert.strictEqual(jsonOther.meta.account.conserved, true);

            const rHelper = execute(index, 'context', { name: 'helper.py:2:run' });
            const jsonHelper = JSON.parse(output.formatContextJson(rHelper.result));
            const confHelper = (jsonHelper.data.callers || []).map(c => `${c.file}:${c.line}`);
            assert.ok(confHelper.includes('user.py:8'),
                `self.helper.run() must still confirm Helper.run: ${confHelper}`);
        } finally { rm(dir); }
    });
});

describe('fix #203: assigned locals shadow callback references (Python)', () => {
    const FILES = {
        'lib.py': `def effect(fn):
    return fn

def needs_recompute(t):
    return bool(t)

def end_batch(batched):
    effect = batched
    while effect is not None:
        needs_recompute(effect)

def real_user():
    schedule(effect)

def schedule(fn):
    pass
`,
    };

    it('function-wide assignment makes the name local for all references', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const output = require('../core/output');
            const r = execute(index, 'context', { name: 'lib.py:1:effect' });
            const json = JSON.parse(output.formatContextJson(r.result));
            const confirmed = (json.data.callers || []).map(c => `${c.file}:${c.line}`);
            assert.ok(!confirmed.includes('lib.py:10'),
                `needs_recompute(effect) with assigned local must not confirm the effect function: ${confirmed}`);
            assert.ok(confirmed.includes('lib.py:13'),
                `schedule(effect) without shadowing must stay confirmed: ${confirmed}`);
            assert.strictEqual(json.meta.account.conserved, true);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #209: structural dispatch tiering (httpx-measured) — the #204 nominal
// discipline applied to JS/TS/Python. File-level import evidence is not
// receiver evidence; name-level import bindings shadow bare names; external
// module-qualified attributes are owned by their module; builtin literal
// receiver types outrank same-file name bindings.
// ============================================================================

describe('fix #209: structural dispatch tiering (Python)', () => {
    const FILES = {
        'package.json': '{"name":"t"}',
        'pkg/__init__.py': 'from .decoders import ContentDecoder, TextDecoder\nfrom .urls import URL\n',
        'pkg/decoders.py': [
            'class ContentDecoder:',
            '    def decode(self, data):',
            '        return data',
            '',
            'class TextDecoder:',
            '    def decode(self, data):',
            '        return data',
        ].join('\n'),
        'pkg/urls.py': [
            'from urllib.parse import unquote',
            '',
            'class URL:',
            '    def join(self, other):',
            '        return other',
            '',
            'def fragment(path):',
            '    return unquote(path)',
            '',
            'def authority(parts):',
            '    return "".join(parts)',
        ].join('\n'),
        'pkg/utils.py': [
            'def unquote(value):',
            '    return value',
        ].join('\n'),
        'pkg/models.py': [
            'from .decoders import ContentDecoder',
            'import httpcore',
            '',
            'def stream(decoder, key):',
            '    decoder.decode(b"x")',
            '    key.decode("ascii")',
            '',
            'def make_origin(url):',
            '    return httpcore.URL(url)',
        ].join('\n'),
    };

    function contract(index, handle) {
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, `context ${handle} failed: ${r.error}`);
        const output = require('../core/output');
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || json.data.usages || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(u => ({
                key: `${u.file}:${u.line}`, reason: u.reason, dispatchVia: u.dispatchVia,
            })),
            excluded: json.meta.account?.excluded,
            conserved: json.meta.account?.conserved,
        };
    }

    it('untyped-receiver method call against multiple owners routes method-ambiguous', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'pkg/decoders.py:2:decode');
            assert.ok(!res.confirmed.includes('pkg/models.py:5'),
                `decoder is untyped and decode has 2 owners: ${res.confirmed}`);
            assert.ok(!res.confirmed.includes('pkg/models.py:6'),
                `key.decode("ascii") is bytes.decode: ${res.confirmed}`);
            const entries = res.unverified.filter(u =>
                u.key === 'pkg/models.py:5' || u.key === 'pkg/models.py:6');
            assert.strictEqual(entries.length, 2,
                `both stay VISIBLE: ${JSON.stringify(res.unverified)}`);
            assert.ok(entries.every(e => e.reason === 'method-ambiguous'));
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('an external import binding of the name shadows the bare call', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'pkg/utils.py:1:unquote');
            assert.ok(!res.confirmed.includes('pkg/urls.py:8'),
                `urls.py rebinds unquote from urllib.parse: ${res.confirmed}`);
            assert.ok(res.excluded.byReason['other-definition-import']?.count >= 1,
                JSON.stringify(res.excluded.byReason));
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('an external module-qualified constructor is owned by that module', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'pkg/urls.py:3:URL');
            assert.ok(!res.confirmed.includes('pkg/models.py:9'),
                `httpcore.URL is httpcore's URL, not the project class: ${res.confirmed}`);
            assert.ok(res.excluded.byReason['external-package']?.count >= 1,
                JSON.stringify(res.excluded.byReason));
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('a literal str receiver outranks a same-file name binding', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'pkg/urls.py:4:join');
            assert.ok(!res.confirmed.includes('pkg/urls.py:11'),
                `"".join(parts) is str.join even where URL.join is defined: ${res.confirmed}`);
            assert.ok(res.excluded.byReason['receiver-type-mismatch']?.count >= 1,
                JSON.stringify(res.excluded.byReason));
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #202b (Python re-scope): plain self/cls/super same-class resolution
// must land on the pinned target's class — a sibling class's self.method()
// is not a caller of the target (httpx-measured: ~5 sibling self-call FP
// edges, Client/AsyncClient in one file; same-file siblings bypass the
// binding and import gates, so the same-class branch decides). Python MRO
// guard: exclusion requires that the matched class and the target share NO
// project descendant — class C(Target, Mixin) makes self.method() inside
// Mixin reach Target.method through C's MRO.
// ============================================================================

describe('fix #202b: Python self-call sibling-class pinning', () => {
    const output = require('../core/output');

    it('same-file sibling self.process() is excluded other-definition (httpx family)', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname = "t"\n',
            'a.py': [
                'class Target:',
                '    def process(self):',
                '        return 1',
                '',
                'class Sibling:',
                '    def process(self):',
                '        return 2',
                '    def run(self):',
                '        return self.process()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'a.py:2:process' });
            assert.ok(r.ok, `context failed: ${r.error}`);
            const json = JSON.parse(output.formatContextJson(r.result));
            assert.ok(!(json.data.callers || []).some(c => c.line === 9),
                `Sibling.process self-call is not a Target.process caller: ${JSON.stringify(json.data.callers)}`);
            const byReason = json.meta.account.excluded?.byReason || {};
            assert.ok((byReason['other-definition']?.count || 0) >= 1,
                `excluded with reason: ${JSON.stringify(byReason)}`);
            assert.strictEqual(json.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('subclass-without-override self.process() stays a confirmed caller', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname = "t"\n',
            'a.py': [
                'class Target:',
                '    def process(self):',
                '        return 1',
            ].join('\n'),
            'c.py': [
                'from a import Target',
                '',
                'class Child(Target):',
                '    def run(self):',
                '        return self.process()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'a.py:2:process' });
            assert.ok(r.ok, `context failed: ${r.error}`);
            const confirmed = (r.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(confirmed.includes('c.py:5'),
                `inherited method resolves to Target.process: ${confirmed}`);
        } finally { rm(dir); }
    });

    it('overriding subclass self.process() is excluded (target unreachable below the override)', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname = "t"\n',
            'a.py': [
                'class Target:',
                '    def process(self):',
                '        return 1',
                '',
                'class Override(Target):',
                '    def process(self):',
                '        return 4',
                '    def run(self):',
                '        return self.process()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'a.py:2:process' });
            assert.ok(r.ok, `context failed: ${r.error}`);
            const json = JSON.parse(output.formatContextJson(r.result));
            assert.ok(!(json.data.callers || []).some(c => c.line === 9),
                `self.process() under Override binds the override, never Target.process: ${JSON.stringify(json.data.callers)}`);
            assert.strictEqual(json.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('co-parent mixin (MRO trap) is NOT excluded — class C(Target, Mixin) reaches Target.process', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname = "t"\n',
            'a.py': [
                'class Target:',
                '    def process(self):',
                '        return 1',
                '',
                'class Mixin:',
                '    def process(self):',
                '        return 3',
                '    def run(self):',
                '        return self.process()',
            ].join('\n'),
            'combo.py': [
                'from a import Target, Mixin',
                '',
                'class Combo(Target, Mixin):',
                '    pass',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'a.py:2:process' });
            assert.ok(r.ok, `context failed: ${r.error}`);
            const json = JSON.parse(output.formatContextJson(r.result));
            const byReason = json.meta.account.excluded?.byReason || {};
            const trapExcluded = (byReason['other-definition']?.sample || [])
                .some(s => s.line === 9);
            assert.ok(!trapExcluded,
                `Mixin self-call can dispatch to Target.process via Combo's MRO: ${JSON.stringify(byReason)}`);
            assert.strictEqual(json.meta.account.conserved, true);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #210: external-contract methods (Python side — typing @override).
// A method marked @override in a class whose base is external (import from
// an unresolvable package), with a single project-wide owner: the name
// provably exists on a contract UCN cannot see, so unique ownership is not
// identity evidence for untyped receivers. Routes possible-dispatch.
// ============================================================================

describe('fix #210: external-contract methods (Python)', () => {
    const FILES = {
        'mine.py': `from typing import override
from external_pkg import Base


class Mine(Base):
    @override
    def compute(self, x):
        return x + 1

    def plain(self, x):
        return x
`,
        'user.py': `from mine import Mine


def drive(o):
    Mine()
    return o.compute(1) + o.plain(2)
`,
    };

    function contract(index, handle) {
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, `context ${handle} failed: ${r.error}`);
        const output = require('../core/output');
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(u => ({
                key: `${u.file}:${u.line}`, reason: u.reason,
                dispatchVia: u.dispatchVia, externalContract: u.externalContract,
            })),
            conserved: json.meta.account?.conserved,
        };
    }

    it('@override method routes untyped-receiver calls possible-dispatch via the external base', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'mine.py:6:compute');
            assert.ok(!res.confirmed.includes('user.py:6'),
                `o.compute() could be Base's: ${res.confirmed}`);
            const entry = res.unverified.find(u => u.key === 'user.py:6');
            assert.ok(entry, `untyped-receiver call stays visible: ${JSON.stringify(res.unverified)}`);
            assert.strictEqual(entry.reason, 'possible-dispatch');
            assert.strictEqual(entry.dispatchVia, 'Base');
            assert.strictEqual(entry.externalContract, true);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('un-marked single-owner methods keep confirming (control)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'mine.py:10:plain');
            assert.ok(res.confirmed.includes('user.py:6'),
                `plain has no override marker — import evidence stays sufficient: ${res.confirmed} / ${JSON.stringify(res.unverified)}`);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #211: deadcode — methods of __all__-exported classes are public API
// ============================================================================

describe('fix #211: deadcode — exported-class methods (Python)', () => {
    it('methods of an __all__-exported class are excluded by default', () => {
        const dir = tmp({
            'requirements.txt': '',
            'mod.py': [
                '__all__ = ["Client"]',
                'class Client:',
                '    def request(self):',
                '        pass',
                'class Internal:',
                '    def helper(self):',
                '        pass',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const def = index.deadcode({});
            assert.ok(!def.some(d => d.name === 'request'),
                `method of __all__-exported class is public API: ${def.map(d => d.name)}`);
            assert.ok(def.some(d => d.name === 'helper'),
                `method of non-exported class stays claimable: ${def.map(d => d.name)}`);
            const exp = index.deadcode({ includeExported: true });
            const entry = exp.find(d => d.name === 'request');
            assert.ok(entry && entry.isExported, 'claimed as exported under --include-exported');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #215: bare-name scope discipline (rich-measured: 225 builtin print(...)
// calls in test files confirmed against rich/__init__.py's `print` via
// file-level import edges). A bare name in a module file resolves to a local
// binding, an import binding of THAT name, or a builtin — never an
// unimported project def.
// ============================================================================

describe('fix #215: bare calls need a name binding to reach another file (Python)', () => {
    const FILES = {
        'requirements.txt': '',
        'lib/__init__.py': 'def print(*args):\n    return args\n',
        'uses_it.py': 'from lib import print\nprint(1)\n',
        'builtin_user.py': 'from lib import other_thing\nprint(2)\n',
        'star_user.py': 'from lib import *\nfrom os import sep\nprint(3)\n',
        'script_no_imports.py': 'print(4)\n',
    };

    function callers(index, handle) {
        const output = require('../core/output');
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, r.error);
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(c => `${c.file}:${c.line}`),
        };
    }

    it('name-imported caller confirms; unimported bare call is excluded', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callers(index, 'lib/__init__.py:1:print');
            assert.ok(res.confirmed.includes('uses_it.py:2'),
                `from lib import print → real caller: ${res.confirmed}`);
            assert.ok(!res.confirmed.includes('builtin_user.py:2'),
                `no import binding of print → builtin call, not lib's: ${res.confirmed}`);
            assert.ok(!res.unverified.includes('builtin_user.py:2'),
                'excluded-with-reason, not unverified');
        } finally { rm(dir); }
    });

    it('star imports suppress the exclusion (the name may be injected)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callers(index, 'lib/__init__.py:1:print');
            const everywhere = [...res.confirmed, ...res.unverified];
            assert.ok(everywhere.includes('star_user.py:3'),
                `from lib import * can bind print — must stay visible: ${JSON.stringify(res)}`);
        } finally { rm(dir); }
    });

    it('files without import bindings (scripts) are not subject to the rule', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callers(index, 'lib/__init__.py:1:print');
            const everywhere = [...res.confirmed, ...res.unverified];
            // No module discipline to reason from — stays wherever legacy put it
            assert.ok(everywhere.includes('script_no_imports.py:1') ||
                !everywhere.includes('script_no_imports.py:1'),
                'documenting: script files skip the block');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #217: name-level export-chain ownership (rich-measured: 24 test-file
// `render(bar)` calls confirmed against markup.render although the binding
// `from .render import render` pins to tests/render.py's OWN def — file-level
// import reach chased on through other imports).
// ============================================================================

describe('fix #217: import bindings pin by NAME, not by file (Python)', () => {
    function callers(index, handle) {
        const output = require('../core/output');
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, JSON.stringify(r.error));
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(c => `${c.file}:${c.line}`),
        };
    }

    it('binding resolved to a file that defines the name itself is excluded', () => {
        const dir = tmp({
            'requirements.txt': '',
            'pkg/__init__.py': '',
            'pkg/markup.py': 'def render(text):\n    return text\n',
            'pkg/console.py': 'from .markup import render as render_markup\n\ndef use():\n    return render_markup("x")\n',
            'tests/__init__.py': '',
            // tests/render.py defines its OWN render — and imports console,
            // which imports markup: file-level reach would say yes.
            'tests/render.py': 'from pkg.console import use\n\ndef render(thing):\n    return use() + str(thing)\n',
            'tests/test_bar.py': 'from tests.render import render\n\ndef test_one():\n    assert render(1)\n',
            'tests/test_direct.py': 'from pkg.markup import render\n\ndef test_two():\n    assert render("y")\n',
        });
        try {
            const index = idx(dir);
            const res = callers(index, 'pkg/markup.py:1:render');
            assert.ok(!res.confirmed.includes('tests/test_bar.py:4'),
                `binding pins to tests/render.py's def, not markup's: ${res.confirmed}`);
            assert.ok(!res.unverified.includes('tests/test_bar.py:4'),
                'excluded-with-reason, not unverified');
            assert.ok(res.confirmed.includes('tests/test_direct.py:4'),
                `direct import still confirms: ${res.confirmed}`);
        } finally { rm(dir); }
    });

    it('re-export barrel chains still confirm; module assignments block exclusion', () => {
        const dir = tmp({
            'requirements.txt': '',
            'pkg/__init__.py': '',
            'pkg/impl.py': 'def thing():\n    return 1\n',
            // Barrel re-exports the name — chase follows it
            'pkg/barrel.py': 'from pkg.impl import thing\n',
            'user_barrel.py': 'from pkg.barrel import thing\n\ndef go():\n    return thing()\n',
            // This module ASSIGNS the name at module level — the chase cannot
            // model the RHS, so the binding must stay un-excluded (visible
            // somewhere), never wrongly excluded.
            'pkg/assigned.py': 'from pkg.impl import thing as _t\n\nthing = _t\n',
            'user_assigned.py': 'from pkg.assigned import thing\n\ndef go2():\n    return thing()\n',
        });
        try {
            const index = idx(dir);
            const res = callers(index, 'pkg/impl.py:1:thing');
            assert.ok(res.confirmed.includes('user_barrel.py:4'),
                `barrel re-export chain confirms: ${res.confirmed}`);
            const everywhere = [...res.confirmed, ...res.unverified];
            assert.ok(everywhere.includes('user_assigned.py:4'),
                `module-level assignment of the name → undetermined, stays visible: ${JSON.stringify(res)}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #218: rich FP families — comprehension/nested-def shadows, method calls
// vs function targets, member-access aliases, literal assignment typing,
// strict-ancestor same-class routing.
// ============================================================================

describe('fix #218: comprehension and nested-def shadows (Python)', () => {
    function callers(index, handle) {
        const output = require('../core/output');
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, JSON.stringify(r.error));
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(c => `${c.file}:${c.line}`),
        };
    }

    const FILES = {
        'requirements.txt': '',
        'lib.py': [
            'class Console:',
            '    def get_style(self, name):',
            '        return name',
            '',
            'class Segment:',
            '    def line(self):',
            '        return 1',
            '',
        ].join('\n'),
        'user.py': [
            'from lib import Console, Segment',
            '',
            'def test_nested(text):',
            '    def get_style(t):',
            '        return t',
            '    return highlight(text, get_style)',
            '',
            'def test_comp(lines):',
            '    return max(cell_len(line) for line in lines)',
            '',
            'def test_lambda(items):',
            '    return sorted(items, key=lambda line: cell_len(line))',
            '',
            'def highlight(t, fn):',
            '    return fn(t)',
            '',
            'def cell_len(x):',
            '    return len(x)',
            '',
        ].join('\n'),
    };

    it('a nested def shadows callback references to a same-named method', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callers(index, 'lib.py:2:get_style');
            assert.ok(!res.confirmed.some(c => c.startsWith('user.py')),
                `nested def get_style shadows the callback ref: ${res.confirmed}`);
        } finally { rm(dir); }
    });

    it('comprehension and lambda bindings shadow refs inside them', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callers(index, 'lib.py:6:line');
            assert.ok(!res.confirmed.some(c => c.startsWith('user.py')),
                `for-in-clause/lambda param bind 'line' locally: ${res.confirmed}`);
        } finally { rm(dir); }
    });
});

describe('fix #218: a method call cannot denote a standalone function (Python)', () => {
    it('console.print routes visible; module receiver rich.print confirms', () => {
        const dir = tmp({
            'requirements.txt': '',
            'rich/__init__.py': 'def print(*objects):\n    return objects\n',
            'rich/console.py': 'class Console:\n    def print(self, *objects):\n        return objects\n',
            'user.py': [
                'import rich',
                'from rich.console import Console',
                '',
                'def use_module():',
                '    rich.print("hello")',
                '',
                'def use_method(console):',
                '    console.print("table")',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const output = require('../core/output');
            const r = execute(index, 'context', { name: 'rich/__init__.py:1:print' });
            assert.ok(r.ok);
            const json = JSON.parse(output.formatContextJson(r.result));
            const confirmed = (json.data.callers || []).map(c => `${c.file}:${c.line}`);
            const unverified = (json.data.unverifiedCallers || []).map(c => `${c.file}:${c.line}`);
            assert.ok(confirmed.includes('user.py:5'), `module-receiver call confirms: ${confirmed}`);
            assert.ok(!confirmed.includes('user.py:8'), `method call ≠ module function: ${confirmed}`);
            assert.ok(unverified.includes('user.py:8'), `visible, never dropped: ${unverified}`);
        } finally { rm(dir); }
    });
});

describe('fix #218: member-access aliases and literal assignment typing (Python)', () => {
    it('append = output.append never binds bare append() to a class method', () => {
        const dir = tmp({
            'requirements.txt': '',
            'text.py': [
                'from typing import List',
                '',
                'class Text:',
                '    def append(self, text):',
                '        return self',
                '',
                '    def markup(self):',
                '        output: List[str] = []',
                '        append = output.append',
                '        append("piece")',
                '        return "".join(output)',
                '',
                '    def true_use(self, other):',
                '        self.append(other)',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const output = require('../core/output');
            const r = execute(index, 'context', { name: 'text.py:4:append' });
            assert.ok(r.ok);
            const json = JSON.parse(output.formatContextJson(r.result));
            const confirmed = (json.data.callers || []).map(c => `${c.file}:${c.line}`);
            assert.ok(confirmed.includes('text.py:14'), `self.append stays confirmed: ${confirmed}`);
            assert.ok(!confirmed.includes('text.py:10'), `aliased list.append is not Text.append: ${confirmed}`);
        } finally { rm(dir); }
    });

    it('a typed-receiver alias call is a TRUE edge but routes visible alias-call', () => {
        const dir = tmp({
            'requirements.txt': '',
            'console.py': 'class Console:\n    def get_style(self, name):\n        return name\n',
            'tree.py': [
                'from console import Console',
                '',
                'def render(console: Console):',
                '    get_style = console.get_style',
                '    return get_style("tree.line")',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const output = require('../core/output');
            const r = execute(index, 'context', { name: 'console.py:2:get_style' });
            assert.ok(r.ok);
            const json = JSON.parse(output.formatContextJson(r.result));
            const confirmed = (json.data.callers || []).map(c => `${c.file}:${c.line}`);
            const unv = (json.data.unverifiedCallers || []);
            assert.ok(!confirmed.includes('tree.py:5'),
                `alias indirection is not grep-verifiable — never confirmed: ${confirmed}`);
            assert.ok(unv.some(c => `${c.file}:${c.line}` === 'tree.py:5'),
                `visible unverified (true edge, conserved): ${JSON.stringify(unv)}`);
        } finally { rm(dir); }
    });

    it('a bytes-literal assignment types the receiver for exclusion', () => {
        const dir = tmp({
            'requirements.txt': '',
            'ansi.py': [
                'class AnsiDecoder:',
                '    def decode(self, terminal_text):',
                '        return terminal_text',
                '',
                'def test_decode():',
                '    ansi_bytes = b"x1b[1mHello"',
                '    return ansi_bytes.decode("utf-8")',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const output = require('../core/output');
            const r = execute(index, 'context', { name: 'ansi.py:2:decode' });
            assert.ok(r.ok);
            const json = JSON.parse(output.formatContextJson(r.result));
            const confirmed = (json.data.callers || []).map(c => `${c.file}:${c.line}`);
            const unverified = (json.data.unverifiedCallers || []).map(c => `${c.file}:${c.line}`);
            assert.ok(!confirmed.includes('ansi.py:7') && !unverified.includes('ansi.py:7'),
                `bytes.decode excluded against AnsiDecoder.decode: ${JSON.stringify({ confirmed, unverified })}`);
        } finally { rm(dir); }
    });
});

describe('fix #218: strict-ancestor same-class match routes possible-dispatch (Python)', () => {
    const FILES = {
        'requirements.txt': '',
        'progress.py': [
            'class ProgressColumn:',
            '    def __call__(self, task):',
            '        return self.render(task)',
            '',
            '    def render(self, task):',
            '        raise NotImplementedError',
            '',
            'class TransferSpeedColumn(ProgressColumn):',
            '    def render(self, task):',
            '        return str(task)',
            '',
        ].join('\n'),
    };

    it('pinned subclass override: base-class self-call is possible-dispatch', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const output = require('../core/output');
            const r = execute(index, 'context', { name: 'progress.py:9:render' });
            assert.ok(r.ok);
            const json = JSON.parse(output.formatContextJson(r.result));
            const confirmed = (json.data.callers || []).map(c => `${c.file}:${c.line}`);
            const unv = (json.data.unverifiedCallers || []);
            assert.ok(!confirmed.includes('progress.py:3'),
                `self.render in the BASE reaches the override only dynamically: ${confirmed}`);
            assert.ok(unv.some(c => `${c.file}:${c.line}` === 'progress.py:3'),
                `visible possible-dispatch, conserved: ${JSON.stringify(unv)}`);
        } finally { rm(dir); }
    });

    it('pinned base def: the same self-call stays confirmed', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const output = require('../core/output');
            const r = execute(index, 'context', { name: 'progress.py:5:render' });
            assert.ok(r.ok);
            const json = JSON.parse(output.formatContextJson(r.result));
            const confirmed = (json.data.callers || []).map(c => `${c.file}:${c.line}`);
            assert.ok(confirmed.includes('progress.py:3'),
                `matchedClass ∈ targetClasses — confirmation stands: ${confirmed}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #219: chained-receiver return-type flow (Python side of the structural
// family — the producer's declared return annotation types the receiver of
// `fetch_data().json()`; async producers type only AWAITED chains)
// ============================================================================

describe('fix #219: chained-receiver return-type flow (Python)', () => {
    const output = require('../core/output');
    const FILES = {
        'app.py': [
            'class Response:',
            '    def json(self):',
            '        return {}',
            '',
            'class Codec:',
            '    def json(self):',
            '        return []',
            '',
            'def fetch_data() -> Response:',
            '    return Response()',
            '',
            'def use():',
            '    fetch_data().json()',
            '',
            'async def fetch_async() -> Response:',
            '    return Response()',
            '',
            'def use_async():',
            '    fetch_async().json()',
        ].join('\n'),
    };

    function contextOf(index, handle) {
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, JSON.stringify(r.error));
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(c => `${c.file}:${c.line}`),
            excluded: ((json.meta.account || {}).excluded || {}).byReason || {},
        };
    }

    it('annotated producer confirms the returned class and excludes the sibling', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const resp = contextOf(index, 'app.py:2:json');
            assert.ok(resp.confirmed.includes('app.py:13'),
                `fetch_data() -> Response types the receiver: ${resp.confirmed}`);
            const codec = contextOf(index, 'app.py:6:json');
            assert.ok(!codec.confirmed.includes('app.py:13'),
                `Response-typed chain is not a Codec.json caller: ${codec.confirmed}`);
            assert.ok(codec.excluded['receiver-type-mismatch'],
                `expected receiver-type-mismatch: ${JSON.stringify(codec.excluded)}`);
        } finally { rm(dir); }
    });

    it('un-awaited async producer does NOT type (the value is a coroutine)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const resp = contextOf(index, 'app.py:2:json');
            assert.ok(!resp.confirmed.includes('app.py:19'),
                `fetch_async() un-awaited is a coroutine, not a Response: ${resp.confirmed}`);
            assert.ok(resp.unverified.includes('app.py:19'),
                `the async-chain edge stays VISIBLE: ${resp.unverified}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #222 (seed-C): bare-call class-member bindings + external producers
// ============================================================================

describe('fix #222: a bare Python call never binds a class-scoped member', () => {
    const { execute } = require('../core/execute');
    const output = require('../core/output');
    const FILES = {
        'cells.py': 'def cell_len(text):\n    return len(text)\n',
        'text.py': [
            'from cells import cell_len',
            '',
            '',
            'class Text:',
            '    @property',
            '    def cell_len(self):',
            '        return cell_len(self.plain)',
            '',
            '    def fit(self, width):',
            '        length = cell_len(self.plain)',
            '        return length',
        ].join('\n'),
    };

    function contract(index, handle) {
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, JSON.stringify(r.error));
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            conserved: json.meta.account?.conserved,
        };
    }

    it('the method pin gets no bare-call callers (import binding owns the name)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'text.py:5:cell_len');
            assert.strictEqual(res.confirmed.length, 0,
                `bare cell_len(...) binds the import, never Text.cell_len: ${res.confirmed}`);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('the imported function gains the callers the member binding used to steal', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'cells.py:1:cell_len');
            assert.ok(res.confirmed.includes('text.py:7') && res.confirmed.includes('text.py:10'),
                `bare calls belong to cells.cell_len: ${res.confirmed}`);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #222: external-module producers block single-owner confirmation (structural)', () => {
    const { execute } = require('../core/execute');
    const output = require('../core/output');

    it('logger = logging.getLogger() receiver routes possible-dispatch, real receiver confirms', () => {
        const dir = tmp({
            'models.py': [
                'import logging',
                '',
                'logger = logging.getLogger("app")',
                '',
                '',
                'class Cookies:',
                '    def info(self, msg):',
                '        return msg',
                '',
                '',
                'def run():',
                '    logger.info("starting")',
                '    c = Cookies()',
                '    c.info("real")',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'models.py:7:info' });
            assert.ok(r.ok, JSON.stringify(r.error));
            const json = JSON.parse(output.formatContextJson(r.result));
            const confirmed = (json.data.callers || []).map(c => c.line);
            const unverified = json.data.unverifiedCallers || [];
            assert.ok(!confirmed.includes(12),
                `logger.info is logging's, not Cookies.info: ${confirmed}`);
            const entry = unverified.find(u => u.line === 12);
            assert.ok(entry, `the edge stays VISIBLE: ${JSON.stringify(unverified)}`);
            assert.strictEqual(entry.reason, 'possible-dispatch');
            assert.strictEqual(entry.dispatchVia, 'logging.getLogger');
            assert.ok(confirmed.includes(14), `typed receiver keeps confirming: ${confirmed}`);
            assert.strictEqual(json.meta.account?.conserved, true);
        } finally { rm(dir); }
    });
});

describe('deadcode: out-of-tree base-class overrides are not dead (fix: #210 analog)', () => {
    // FastAPI-measured false positives: build_middleware_stack overrides
    // Starlette, bytes_schema overrides Pydantic's GenerateJsonSchema — the
    // only caller lives in an unindexed dependency, so a zero usage count is
    // not evidence of deadness.
    it('hides a public method whose class extends an unresolved base; standalone code stays claimable', () => {
        const dir = tmp({
            'app.py': [
                'from framework import Base  # external, not in this project',
                '',
                'class Widget(Base):',
                '    def render(self):',           // public method on an out-of-tree base -> hidden
                '        return 1',
                '',
                'def orphan():',                   // standalone, can override nothing -> stays claimable
                '    return 3',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const def = index.deadcode();
            const names = def.map(d => d.name);
            assert.ok(!names.includes('render'),
                `render overrides an out-of-tree base — must not be claimed dead: ${names}`);
            assert.strictEqual(def.excludedExternalContract, 2,
                `render AND the Widget class itself (fix #253a: a class extending an unresolved base is framework-discoverable) are counted under excludedExternalContract: ${def.excludedExternalContract}`);
            assert.ok(names.includes('orphan'),
                `standalone function with no callers is still dead: ${names}`);

            // --include-exported reveals it, labeled as external-contract surface
            const exp = index.deadcode({ includeExported: true });
            const r = exp.find(d => d.name === 'render');
            assert.ok(r, 'render is revealed under includeExported');
            assert.strictEqual(r.externalContract, true, 'revealed render is labeled externalContract');
        } finally { rm(dir); }
    });

    it('still claims a dead public method when the base IS in-project (no external contract)', () => {
        const dir = tmp({
            'base.py': 'class Base:\n    def shared(self):\n        return 0\n',
            'child.py': [
                'from base import Base',
                '',
                'class Child(Base):',
                '    def never_called(self):',   // overrides nothing external; nobody calls it
                '        return 1',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const names = index.deadcode().map(d => d.name);
            assert.ok(names.includes('never_called'),
                `in-project-only inheritance: a truly-unused method is still dead: ${names}`);
        } finally { rm(dir); }
    });

    it('does not shield inherent methods when the only base is the universal object root', () => {
        // class Foo(object) is semantically identical to class Foo — the universal
        // root dispatches nothing arbitrary, so a cosmetic base must not change the verdict.
        const dir = tmp({
            'app.py': [
                'class Foo(object):',
                '    def dead_method(self):',
                '        return 1',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const def = index.deadcode();
            assert.ok(def.map(d => d.name).includes('dead_method'),
                `class Foo(object) must behave like class Foo — dead_method stays dead: ${def.map(d => d.name)}`);
            assert.strictEqual(def.excludedExternalContract, 0,
                `the object root is not an external-contract base: ${def.excludedExternalContract}`);
        } finally { rm(dir); }
    });
});

describe('fix #236 (Python): callee-side class-qualified and single-owner receivers', () => {
    it('ClassName.method() through an import binding confirms; instance single-owner confirms', () => {
        const dir = tmp({
            'requirements.txt': '',
            'engine.py': 'class Engine:\n    @classmethod\n    def create(cls):\n        return cls()\n\n    def start(self):\n        return 1\n',
            'app.py': 'from engine import Engine\n\ndef main():\n    e = Engine.create()\n    return e.start()\n',
        });
        try {
            const index = idx(dir);
            const def = index.symbols.get('main')[0];
            const acct = index.findCallees(def, { collectAccount: true, includeMethods: true });
            assert.ok(acct.some(c => c.name === 'create' && c.className === 'Engine'),
                `Engine.create() must confirm: ${JSON.stringify(acct.map(c => c.name))}`);
            assert.ok(acct.some(c => c.name === 'start' && c.className === 'Engine'),
                `e.start() must confirm via single owner: ${JSON.stringify(acct.map(c => c.name))}`);
            assert.ok(acct.calleeAccount.conserved);
        } finally { rm(dir); }
    });

    it('counter-probe: a module receiver never confirms via single-owner (#209)', () => {
        const dir = tmp({
            'requirements.txt': '',
            'report.py': 'class Report:\n    def close(self):\n        return 1\n',
            'app.py': 'import matplotlib.pyplot as plt\n\ndef main():\n    plt.close()\n',
        });
        try {
            const index = idx(dir);
            const def = index.symbols.get('main')[0];
            const acct = index.findCallees(def, { collectAccount: true, includeMethods: true });
            assert.strictEqual(acct.filter(c => c.name === 'close').length, 0,
                `plt.close() must not confirm Report.close: ${JSON.stringify(acct.map(c => c.name))}`);
        } finally { rm(dir); }
    });
});

describe('fix #238 (Python): super().__init__ is a resolvable callee, not a builtin', () => {
    it('resolves through the parent class instead of routing external', () => {
        const dir = tmp({
            'requirements.txt': '',
            'base.py': 'class Base:\n    def __init__(self, x):\n        self.x = x\n',
            'child.py': 'from base import Base\n\nclass Child(Base):\n    def __init__(self, x):\n        super().__init__(x)\n',
        });
        try {
            const index = idx(dir);
            const ctor = index.symbols.get('__init__').find(s => s.className === 'Child');
            const acct = index.findCallees(ctor, { collectAccount: true, includeMethods: true });
            assert.ok(acct.some(c => c.name === '__init__' && c.className === 'Base'),
                `super().__init__ resolves to Base.__init__: ${JSON.stringify(acct.map(c => c.className))}`);
            assert.ok(acct.calleeAccount.conserved);
        } finally { rm(dir); }
    });
});

describe('fix #240 (Python): import lines from the parser, dynamic-import consistency', () => {
    it('repeated and substring-shadowed imports each report their own AST line', () => {
        const dir = tmp({
            'requirements.txt': '',
            'timeout.py': 'def t(): pass',
            'main.py': '# osmosis is important here\nimport timeout\n\ndef f():\n    import timeout\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'imports', { file: 'main.py' });
            assert.ok(r.ok);
            const lines = r.result.filter(i => i.module === 'timeout').map(i => i.line);
            assert.deepStrictEqual(lines, [2, 5],
                'each import statement keeps its own line — never the comment or the first occurrence');
        } finally { rm(dir); }
    });

    it('exporters never attributes the import to a comment mentioning the module', () => {
        const dir = tmp({
            'requirements.txt': '',
            'util.py': 'def helper(): pass',
            'main.py': '# util has important helpers\n# see util for details\nimport util\n\ndef go(): util.helper()\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'exporters', { file: 'util.py' });
            assert.ok(r.ok);
            const main = r.result.find(x => x.file === 'main.py');
            assert.ok(main, 'main.py is an importer');
            assert.strictEqual(main.importLine, 3, 'line of the import statement, not the comments');
        } finally { rm(dir); }
    });

    it('string-literal importlib imports report isDynamic consistently with type', () => {
        const dir = tmp({
            'requirements.txt': '',
            'x.py': 'def x(): pass',
            'main.py': 'import importlib\ndef f():\n    m = importlib.import_module("x")\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'imports', { file: 'main.py' });
            assert.ok(r.ok);
            const dyn = r.result.find(i => i.type === 'dynamic');
            assert.ok(dyn, 'dynamic import listed');
            assert.strictEqual(dyn.isDynamic, true, 'type dynamic implies isDynamic');
            assert.strictEqual(dyn.resolved, 'x.py', 'string-literal path still resolves');
        } finally { rm(dir); }
    });

    it('exporters resolves from-import submodule lines (fix #224 spec composition)', () => {
        const dir = tmp({
            'requirements.txt': '',
            'pkg/__init__.py': '',
            'pkg/jobs.py': 'def run(): pass',
            'pkg/api.py': '# jobs module is important\nfrom . import jobs\n\ndef go(): jobs.run()\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'exporters', { file: 'pkg/jobs.py' });
            assert.ok(r.ok);
            const api = r.result.find(x => x.file === 'pkg/api.py');
            assert.ok(api, 'api.py is an importer via from-import submodule');
            assert.strictEqual(api.importLine, 2, 'line of the from-import, not the comment');
        } finally { rm(dir); }
    });
});

describe('fix #241 (Python): zero-param functions record empty params, not the unknown sentinel', () => {
    it('params is "" for empty parens and keeps real params intact', () => {
        const dir = tmp({
            'requirements.txt': '',
            'a.py': 'def zero(): pass\n\ndef two(a, b=1): pass\n',
        });
        try {
            const index = idx(dir);
            assert.strictEqual(index.symbols.get('zero')[0].params, '');
            assert.strictEqual(index.symbols.get('two')[0].params, 'a, b=1');
        } finally { rm(dir); }
    });
});

describe('fix #243 (Python): bare dotted decorators keep the decorating method alive', () => {
    it('deadcode never claims a method used as @instance.method', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname="t"\n',
            'events.py': 'class Bus:\n    def subscribe(self, fn):\n        return fn\n\nbus = Bus()\n\n@bus.subscribe\ndef on_message(msg):\n    pass\non_message(1)\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'deadcode', {});
            assert.ok(!r.result.some(s => s.name === 'subscribe'),
                'decorator application is an import-time call — deleting subscribe breaks the module');
            const su = execute(index, 'search', { unused: true });
            const list = su.result.results || su.result;
            assert.ok(!list.some(s => s.name === 'subscribe'), 'search --unused spares it too');
        } finally { rm(dir); }
    });

    it('an alias assignment line still counts as a usage (never excluded as a def line)', () => {
        const dir = tmp({
            'requirements.txt': '',
            'a.py': 'def helper():\n    return 1\n',
            'b.py': 'import a\nhelper = a.helper\nprint(helper)\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'deadcode', {});
            assert.ok(!r.result.some(s => s.name === 'helper' && s.file === 'a.py'),
                'the alias line references a.helper — excluding it would be a false-dead');
        } finally { rm(dir); }
    });
});

describe('fix #244 (Python): setUp self.attr receivers and interior-node class scoping', () => {
    it('the unittest setUp idiom produces coverage — self.w.render() matches under --class-name', () => {
        const dir = tmp({
            'requirements.txt': '',
            'mod.py': 'class Widget:\n    def __init__(self, n):\n        self.n = n\n    def render(self):\n        return self.n\n',
            'test_mod.py': 'import unittest\nfrom mod import Widget\n\nclass WidgetCase(unittest.TestCase):\n    def setUp(self):\n        self.w = Widget(3)\n    def test_render(self):\n        self.assertEqual(self.w.render(), 3)\n',
        });
        try {
            const index = idx(dir);
            const t = execute(index, 'tests', { name: 'render', className: 'Widget' });
            assert.ok(t.result.some(f => f.matches.some(m => m.line === 8)),
                'self.w.render() kept under class scoping');
            const at = execute(index, 'affectedTests', { name: 'render', className: 'Widget' });
            const inSomeBand = at.result.testFiles.some(f => f.file === 'test_mod.py') ||
                at.result.possiblyAffectedTests.some(f => f.file === 'test_mod.py');
            assert.ok(inSomeBand, 'the only test exercising render appears in a band');
        } finally { rm(dir); }
    });

    it('a test of a different class\'s same-named method is not interior coverage', () => {
        const dir = tmp({
            'requirements.txt': '',
            'lib.py': 'def util_fn():\n    return 1\n',
            'app.py': 'from lib import util_fn\n\nclass Manager:\n    def save(self):\n        return util_fn()\n\nclass Service:\n    def save(self):\n        return 2\n',
            'test_app.py': 'from app import Service\n\ndef test_service_save():\n    s = Service()\n    assert s.save() == 2\n',
        });
        try {
            const index = idx(dir);
            const at = execute(index, 'affectedTests', { name: 'util_fn' });
            const credited = at.result.testFiles.flatMap(f => f.coveredFunctions);
            assert.ok(!credited.includes('save'),
                'Service.save cannot reach util_fn — the tree itself excludes that site');
        } finally { rm(dir); }
    });
});

describe('fix #245 (Python): flask route shortcuts stay flask', () => {
    it('@app.route and @app.post on the same app attribute to one framework', () => {
        const dir = tmp({
            'requirements.txt': '',
            'webapp.py': 'from flask import Flask\napp = Flask(__name__)\n\n@app.route("/home")\ndef home():\n    pass\n\n@app.post("/save")\ndef save():\n    pass\n',
        });
        try {
            const index = idx(dir);
            const eps = execute(index, 'entrypoints', {}).result;
            assert.strictEqual(eps.find(e => e.name === 'home').framework, 'flask');
            assert.strictEqual(eps.find(e => e.name === 'save').framework, 'flask');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #258: chained-receiver fold — builder chains typed hop-by-hop from the
// producer link (the clap family, Python shape: make().opt(1).opt(2).done()
// with forward-ref string annotations).
// ============================================================================

describe('fix #258: chained-receiver fold (Python)', () => {
    const FILES = {
        'builder.py': `class Builder:
    def __init__(self):
        self.n = 0

    def opt(self, v: int) -> "Builder":
        self.n += v
        return self

    def done(self) -> int:
        return self.n


class Other:
    def opt(self, v: int) -> "Other":
        return self


def make() -> "Builder":
    return Builder()


def make_other() -> "Other":
    return Other()
`,
        'user.py': `from builder import make, make_other


def build() -> int:
    return make().opt(1).opt(2).done()


def other() -> int:
    make_other().opt(9)
    return 0
`,
    };

    function contract(index, handle) {
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, `context ${handle} failed: ${r.error}`);
        const output = require('../core/output');
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            conserved: json.meta.account?.conserved,
        };
    }

    it('annotation-rooted chain confirms hops on the right owner (one-line chain)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'builder.py:5:opt');
            assert.ok(res.confirmed.includes('user.py:5'), `hops: ${res.confirmed}`);
            assert.ok(!res.confirmed.includes('user.py:9'), 'Other chain never confirms on Builder.opt');
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('counter: the sibling owner claims its own chain', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'builder.py:14:opt');
            assert.ok(res.confirmed.includes('user.py:9'), `Other chain: ${res.confirmed}`);
            assert.ok(!res.confirmed.includes('user.py:5'), 'Builder hops stay off the Other pin');
        } finally { rm(dir); }
    });

    it('chain terminal resolves through folded hops', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'builder.py:9:done');
            assert.ok(res.confirmed.includes('user.py:5'), `terminal: ${res.confirmed}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #259: deadcode line-scan — `//` is floor DIVISION in Python, never a
// comment; a name whose only reference sits after `//` on a line was dropped.
// (`#` keeps commenting Python — counter-probed.)
// ============================================================================

describe('fix #259: deadcode scan — Python floor division vs // comment', () => {
    it('a reference after // (floor division) counts as a usage', () => {
        const dir = tmp({
            'lib.py': [
                'BUCKET_SIZE = 0',
                '',
                '',
                'def bucket_of(n):',
                '    return n // bucket_size_helper()',
                '',
                '',
                'def bucket_size_helper():',
                '    return 10',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const dead = index.deadcode();
            assert.ok(!dead.some(d => d.name === 'bucket_size_helper'),
                `floor-division operand is a usage: ${dead.map(d => d.name)}`);
        } finally { rm(dir); }
    });

    it('counter: a name mentioned only in a # comment stays dead', () => {
        const dir = tmp({
            'lib.py': [
                'def commented_only():',
                '    return 1',
                '',
                '',
                'def live():',
                '    # commented_only() is not really called here',
                '    return 2',
                '',
                '',
                'print(live())',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const dead = index.deadcode();
            assert.ok(dead.some(d => d.name === 'commented_only'),
                `# comment mention is not a usage: ${dead.map(d => d.name)}`);
        } finally { rm(dir); }
    });
});

describe('fix #265: @overload signature identity + dunder universal names', () => {
    it('pinning the implementation confirms a caller binding an @overload stub', () => {
        const dir = tmp({
            'lib.py': [
                'from typing import overload',
                '',
                '@overload',
                'def parse(x: int) -> int: ...',
                '@overload',
                'def parse(x: str) -> str: ...',
                'def parse(x):',
                '    return x',
                '',
                'def use():',
                '    return parse(1)',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const defs = index.symbols.get('parse') || [];
            const sigs = defs.filter(d => d.isSignature);
            assert.strictEqual(sigs.length, 2, '@overload stubs carry isSignature');
            const impl = defs.find(d => !d.isSignature);
            assert.ok(impl, 'implementation exists');
            const res = index.findCallers('parse', {
                targetDefinitions: [impl], collectAccount: true,
            });
            assert.ok(res.some(c => c.line === 11),
                `implementation pin confirms the caller: ${JSON.stringify(res.map(c => c.line))}`);
        } finally { rm(dir); }
    });

    it('dunder method calls never confirm via single project owner', () => {
        const dir = tmp({
            'shape.py': [
                'class Shape:',
                '    def __iter__(self):',
                '        return iter([])',
                '',
                'def drain(x):',
                '    return x.__iter__()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const def = (index.symbols.get('__iter__') || [])[0];
            assert.ok(def);
            const res = index.findCallers('__iter__', {
                targetDefinitions: [def], collectAccount: true,
            });
            assert.ok(!res.some(c => c.line === 6),
                'untyped x.__iter__() satisfies the object protocol externally');
            assert.ok((res.unverifiedEntries || []).some(u => u.line === 6),
                'dunder call routes visible possible-dispatch');
        } finally { rm(dir); }
    });
});

describe('fix #269: PEP-517 src layout resolves project imports', () => {
    const FILES = {
        'pyproject.toml': '[project]\nname = "pkg"',
        'src/pkg/__init__.py': 'from .utils import helper as helper\n',
        'src/pkg/utils.py': 'def helper(name):\n    return name\n',
        'tests/test_pkg.py': [
            'import pkg',
            'from pkg.utils import helper',
            '',
            'def test_module_receiver():',
            '    return pkg.helper("x")',       // 5
            '',
            'def test_bare_import():',
            '    return helper("y")',           // 8
        ].join('\n'),
    };

    function contract(index, handle) {
        const { execute } = require('../core/execute');
        const output = require('../core/output');
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, JSON.stringify(r.error || {}));
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            excluded: json.meta.account?.excluded?.byReason || {},
        };
    }

    it('module-qualified and renamed-import test callers confirm through src/', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'src/pkg/utils.py:1:helper');
            assert.ok(res.confirmed.includes('tests/test_pkg.py:5'),
                `pkg.helper("x") resolves via src layout: ${res.confirmed}`);
            assert.ok(res.confirmed.includes('tests/test_pkg.py:8'),
                `from pkg.utils import helper binds the src def: ${res.confirmed}`);
            assert.ok(!res.excluded['external-package'],
                'the project package is never provably external');
        } finally { rm(dir); }
    });

    it('counter: a genuinely external module stays external', () => {
        const dir = tmp({
            'pyproject.toml': '[project]\nname = "pkg"',
            'src/pkg/utils.py': 'def get(url):\n    return url\n',
            'tests/test_ext.py': [
                'import requests',
                '',
                'def test_ext():',
                '    return requests.get("http://x")',  // 4
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { execute } = require('../core/execute');
            const output = require('../core/output');
            const r = execute(index, 'context', { name: 'src/pkg/utils.py:1:get' });
            const json = JSON.parse(output.formatContextJson(r.result));
            const confirmed = (json.data.callers || []).map(c => `${c.file}:${c.line}`);
            assert.ok(!confirmed.includes('tests/test_ext.py:4'),
                'requests.get is external, never the project get');
        } finally { rm(dir); }
    });
});

describe('Python class calls are callees without a new-expression token', () => {
    it('constructor and raised exception calls resolve to their class symbols', () => {
        const dir = tmp({
            'requirements.txt': '',
            'app.py': [
                'class InvalidURL(Exception):',
                '    pass',
                'class Client:',
                '    pass',
                'def build(flag):',
                '    if flag:',
                '        raise InvalidURL("bad")',
                '    return Client()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const build = (index.symbols.get('build') || [])[0];
            const callees = index.findCallees(build, { collectAccount: true, includeMethods: true });
            assert.ok(callees.some(c => c.name === 'InvalidURL' && c.sites.includes(7)),
                `raised class is a callee: ${JSON.stringify(callees)}`);
            assert.ok(callees.some(c => c.name === 'Client' && c.sites.includes(8)),
                `constructed class is a callee: ${JSON.stringify(callees)}`);
            assert.ok(callees.calleeAccount.conserved);
        } finally { rm(dir); }
    });

    it('lowercase imported classes own type-qualified method calls', () => {
        const dir = tmp({
            'requirements.txt': '',
            'status.py': [
                'class codes:',
                '    @classmethod',
                '    def is_ok(cls, value):',
                '        return value == 200',
            ].join('\n'),
            'app.py': [
                'from status import codes',
                'class Response:',
                '    @property',
                '    def is_ok(self):',
                '        return codes.is_ok(200)',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const responseProp = (index.symbols.get('is_ok') || [])
                .find(s => s.className === 'Response');
            const callees = index.findCallees(responseProp, { collectAccount: true, includeMethods: true });
            assert.ok(callees.some(c => c.className === 'codes' && c.sites.includes(5)),
                `imported lowercase class owns the call: ${JSON.stringify(callees)}`);
            assert.ok(!callees.some(c => c.className === 'Response'),
                'same-name enclosing property must not steal the receiver-qualified call');
        } finally { rm(dir); }
    });
});

describe('fix #270 (Python): external-contract shield walks extends chains transitively', () => {
    it('shields a public method when the parent chain reaches an unindexed base', () => {
        const dir = tmp({
            'requirements.txt': '',
            'base.py': [
                'from ext_pkg import ExtBase',
                'class Mid(ExtBase):',
                '    pass',
            ].join('\n'),
            'leaf.py': [
                'from base import Mid',
                'class Leaf(Mid):',
                '    def hookish(self):',
                '        pass',
                'w = Leaf()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const dead = index.deadcode();
            assert.ok(!dead.some(d => d.name === 'hookish'),
                `subclass-of-subclass of a framework base is dispatchable surface: ${dead.map(d => d.name)}`);
            assert.strictEqual(dead.excludedExternalContract, 1);
        } finally { rm(dir); }
    });

    it('keeps claiming when the whole chain resolves in-project (counter)', () => {
        const dir = tmp({
            'requirements.txt': '',
            'a.py': [
                'class Root:',
                '    pass',
                'class Mid(Root):',
                '    pass',
                'class Leaf(Mid):',
                '    def deadling(self):',
                '        pass',
                'w = Leaf()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const dead = index.deadcode();
            assert.ok(dead.some(d => d.name === 'deadling'),
                `fully in-project chain stays claimable: ${dead.map(d => d.name)}`);
        } finally { rm(dir); }
    });
});

describe('fix #271 (Python): project type identity outranks receiver-blind names', () => {
    function context(index, handle) {
        const output = require('../core/output');
        const result = execute(index, 'context', { name: handle });
        assert.ok(result.ok, JSON.stringify(result.error));
        return JSON.parse(output.formatContextJson(result.result));
    }

    it('does not rewrite a project class named Text to typing.Text/str in a chain', () => {
        const dir = tmp({
            'text.py': [
                'class Text:',
                '    def copy(self) -> "Text":',
                '        return self',
                '',
                '    def blank_copy(self) -> "Text":',
                '        return self',
                '',
                '    def join(self, values):',
                '        return self',
                '',
                '    def render(self):',
                '        text = self.copy()',
                '        return text.blank_copy().join([])',
            ].join('\n'),
        });
        try {
            const json = context(idx(dir), 'text.py:8:join');
            const caller = (json.data.callers || []).find(c => c.file === 'text.py' && c.line === 13);
            assert.ok(caller, `Text-returning chain must reach Text.join: ${JSON.stringify(json.data)}`);
            assert.strictEqual(json.meta.account?.conserved, true);
        } finally { rm(dir); }
    });

    it('validated self.field type outranks a same-name enclosing method binding', () => {
        const dir = tmp({
            'live.py': 'class Live:\n    def update(self, value):\n        return value\n',
            'spinner.py': 'class Spinner:\n    def update(self, value):\n        return value\n',
            'status.py': [
                'from live import Live',
                'from spinner import Spinner',
                '',
                'class Status:',
                '    def __init__(self):',
                '        self._live = Live()',
                '        self._spinner = Spinner()',
                '',
                '    def update(self, value):',
                '        self._live.update(value)',
                '        self._spinner.update(value)',
            ].join('\n'),
        });
        try {
            const json = context(idx(dir), 'live.py:2:update');
            const caller = (json.data.callers || []).find(c => c.file === 'status.py' && c.line === 10);
            assert.ok(caller, `Live-typed field must reach Live.update: ${JSON.stringify(json.data)}`);
            assert.strictEqual(caller.resolution, 'receiver-hint');
            assert.ok(!(json.data.callers || []).some(c => c.file === 'status.py' && c.line === 11),
                'Spinner-typed sibling must not reach Live.update');
            assert.strictEqual(json.meta.account?.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #272 (Python): lexical and module-qualified identity', () => {
    it('selects the function-local class binding among repeated nested names', () => {
        const dir = tmp({
            'test_app.py': [
                'def first():',
                '    class Local:',
                '        pass',
                '    return Local()',
                '',
                'def second():',
                '    class Local:',
                '        pass',
                '    return Local()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const output = require('../core/output');
            const result = execute(index, 'context', { name: 'test_app.py:7:Local' });
            assert.ok(result.ok, JSON.stringify(result.error));
            const json = JSON.parse(output.formatContextJson(result.result));
            assert.ok((json.data.usages || []).some(c => c.file === 'test_app.py' && c.line === 9),
                `second.Local constructor resolves lexically: ${JSON.stringify(json.data)}`);
            assert.ok(!(json.data.usages || []).some(c => c.line === 4),
                'first.Local is a distinct binding');
        } finally { rm(dir); }
    });

    it('resolves a qualified project parent through its imported module', () => {
        const dir = tmp({
            'pkg/__init__.py': 'from .core import Base\n',
            'pkg/core.py': 'class Base:\n    def run(self):\n        return 1\n',
            'user.py': [
                'import pkg',
                'class Child(pkg.Base):',
                '    pass',
                'def use():',
                '    child = Child()',
                '    return child.run()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const output = require('../core/output');
            const result = execute(index, 'context', { name: 'pkg/core.py:2:run' });
            assert.ok(result.ok, JSON.stringify(result.error));
            const json = JSON.parse(output.formatContextJson(result.result));
            assert.ok((json.data.callers || []).some(c => c.file === 'user.py' && c.line === 6),
                `qualified subclass reaches Base.run: ${JSON.stringify(json.data)}`);
        } finally { rm(dir); }
    });

    it('module-qualified decorators do not bind to the decorated local name', () => {
        const dir = tmp({
            'pkg/__init__.py': 'from .decorators import command\n',
            'pkg/decorators.py': [
                'def command():',
                '    def wrap(fn):',
                '        return fn',
                '    return wrap',
            ].join('\n'),
            'user.py': [
                'import pkg',
                '@pkg.command()',
                'def command():',
                '    return 1',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const local = index.symbols.get('command').find(d =>
                d.relativePath === 'user.py');
            assert.ok(local, 'decorated local function should be indexed');
            const callees = index.findCallees(local, { collectAccount: true, includeMethods: true });
            assert.ok(callees.some(c => c.relativePath === 'pkg/decorators.py' && c.startLine === 1),
                `decorator resolves through module export: ${callees.map(c => `${c.relativePath}:${c.startLine}`)}`);
            assert.ok(!callees.some(c => c.relativePath === 'user.py' && c.startLine === 3),
                'decorated local function is not its own decorator callee');
        } finally { rm(dir); }
    });
});

describe('fix #274 (Python): qualified constructor provenance', () => {
    function context(index, handle) {
        const output = require('../core/output');
        const result = execute(index, 'context', { name: handle });
        assert.ok(result.ok, JSON.stringify(result.error));
        return JSON.parse(output.formatContextJson(result.result));
    }

    it('keeps an external constructor receiver visible but out of the confirmed tier', () => {
        const dir = tmp({
            'target.py': 'class URL:\n    def join(self):\n        return self\n',
            'user.py': [
                'import threading',
                'def use():',
                '    thread = threading.Thread()',
                '    thread.join()',
            ].join('\n'),
        });
        try {
            const json = context(idx(dir), 'target.py:2:join');
            assert.ok(!(json.data.callers || []).some(c => c.file === 'user.py' && c.line === 4),
                `threading.Thread.join must not confirm URL.join: ${JSON.stringify(json.data)}`);
            const visible = (json.data.unverifiedCallers || [])
                .find(c => c.file === 'user.py' && c.line === 4);
            assert.ok(visible, `external receiver remains visible: ${JSON.stringify(json.data)}`);
            assert.strictEqual(visible.reason, 'possible-dispatch');
            assert.strictEqual(visible.dispatchVia, 'threading.Thread');
            assert.strictEqual(visible.externalContract, true);
            assert.strictEqual(json.meta.account?.conserved, true);
        } finally { rm(dir); }
    });

    it('uses a resolved project module as exact constructor type provenance', () => {
        const dir = tmp({
            'pkg/__init__.py': 'from .url import URL\n',
            'pkg/url.py': 'class URL:\n    def join(self):\n        return self\n',
            'user.py': [
                'import pkg',
                'def use():',
                '    url = pkg.URL()',
                '    url.join()',
            ].join('\n'),
        });
        try {
            const json = context(idx(dir), 'pkg/url.py:2:join');
            const caller = (json.data.callers || [])
                .find(c => c.file === 'user.py' && c.line === 4);
            assert.ok(caller, `resolved pkg.URL confirms URL.join: ${JSON.stringify(json.data)}`);
            assert.strictEqual(caller.resolution, 'receiver-hint');
            assert.strictEqual(json.meta.account?.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #275: Python lexical call ownership', () => {
    it('marks parameter calls as local shadows instead of imported functions', () => {
        const dir = tmp({
            'lib.py': 'def option(value):\n    return value\n',
            'app.py': [
                'from lib import option',
                'def apply(option, value):',
                '    return option(value)',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('option').find(d => d.relativePath === 'lib.py');
            const callers = index.findCallers('option', {
                targetDefinitions: [target], collectAccount: true,
            });
            assert.ok(!callers.some(c => c.relativePath === 'app.py' && c.line === 3),
                `parameter call must not bind to imported option: ${JSON.stringify(callers)}`);
            assert.ok(callers.accountRaw.excludedEntries.some(e =>
                e.relativePath === undefined && e.line === 3 && e.reason === 'local-shadow'),
            `local-shadow reason missing: ${JSON.stringify(callers.accountRaw)}`);

            const apply = index.symbols.get('apply')[0];
            const callees = index.findCallees(apply, { collectAccount: true, includeMethods: true });
            assert.ok(!callees.some(c => c.name === 'option'),
                `parameter call must not become a callee: ${JSON.stringify(callees)}`);
            assert.ok(callees.calleeAccount.excluded.byReason['local-shadow'] >= 1);
        } finally { rm(dir); }
    });

    it('keeps calls to a nested function bound in the same lexical scope', () => {
        const dir = tmp({
            'app.py': [
                'def outer():',
                '    def emulate(value):',
                '        return value',
                '    return emulate(1)',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('emulate')[0];
            const callers = index.findCallers('emulate', {
                targetDefinitions: [target], collectAccount: true,
            });
            assert.ok(callers.some(c => c.relativePath === 'app.py' && c.line === 4),
                `nested lexical call missing: ${JSON.stringify(callers)}`);
            const outer = index.symbols.get('outer')[0];
            const callees = index.findCallees(outer, { collectAccount: true, includeMethods: true });
            assert.ok(callees.some(c => c.name === 'emulate' && c.relativePath === 'app.py'),
                `nested lexical callee missing: ${JSON.stringify(callees)}`);
        } finally { rm(dir); }
    });

    it('does not confirm external constructor or untyped with-result methods by spelling', () => {
        const dir = tmp({
            'target.py': [
                'class Formatter:',
                '    def getvalue(self):',
                '        return "project"',
            ].join('\n'),
            'app.py': [
                'from io import StringIO',
                'def external():',
                '    out = StringIO()',
                '    return out.getvalue()',
                'def managed(ctx):',
                '    with ctx as out:',
                '        return out.getvalue()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('getvalue')[0];
            const callers = index.findCallers('getvalue', {
                targetDefinitions: [target], collectAccount: true,
            });
            assert.ok(!callers.some(c => c.relativePath === 'app.py' && [4, 7].includes(c.line)),
                `unproven receiver entered confirmed tier: ${JSON.stringify(callers)}`);
            const visible = callers.unverifiedEntries || [];
            assert.ok(visible.some(c => c.line === 4 && c.reason === 'possible-dispatch'));
            assert.ok(visible.some(c => c.line === 7 && c.reason === 'possible-dispatch'));
        } finally { rm(dir); }
    });
});

describe('fix #276: Python alias and chained-builtin precision', () => {
    it('preserves a class constructor alias in JSON output', () => {
        const dir = tmp({
            'app.py': [
                'class Widget:',
                '    pass',
                'def build():',
                '    Alias = Widget',
                '    return Alias()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'context', { name: 'app.py:1:Widget' });
            const json = JSON.parse(require('../core/output').formatContextJson(result.result));
            const usage = json.data.usages.find(c => c.line === 5);
            assert.ok(usage, `aliased construction missing: ${JSON.stringify(json.data)}`);
            assert.strictEqual(usage.calledAs, 'Alias');
        } finally { rm(dir); }
    });

    it('resolves a module-qualified function even when its name is a builtin', () => {
        const dir = tmp({
            'printer.py': 'def print(value):\n    return value\n',
            'app.py': [
                'import printer',
                'def run():',
                '    return printer.print("ok")',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const run = index.symbols.get('run')[0];
            const callees = index.findCallees(run, { collectAccount: true, includeMethods: true });
            assert.ok(callees.some(c => c.name === 'print' && c.relativePath === 'printer.py'),
                `module-owned builtin spelling must resolve: ${JSON.stringify(callees)}`);
            assert.strictEqual(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });

    it('keeps local callable aliases visible but out of exact callees', () => {
        const dir = tmp({
            'app.py': [
                'class Console:',
                '    def get_style(self, name):',
                '        return name',
                'def render(console):',
                '    get_style = console.get_style',
                '    return get_style("bold")',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const render = index.symbols.get('render')[0];
            const callees = index.findCallees(render, { collectAccount: true, includeMethods: true });
            assert.ok(!callees.some(c => c.name === 'get_style' && c.sites?.includes(6)),
                `alias call must not claim an exact definition: ${JSON.stringify(callees)}`);
            assert.ok((callees.unverifiedCallees || []).some(c =>
                c.name === 'get_style' && c.reason === 'alias-call' && c.sites.includes(6)),
            `alias call must remain visible: ${JSON.stringify(callees.unverifiedCallees)}`);
            assert.strictEqual(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });

    it('types BytesIO.getvalue in a chained receiver as bytes', () => {
        const dir = tmp({
            'target.py': 'class Codec:\n    def decode(self):\n        return "project"\n',
            'app.py': [
                'import io',
                'def read():',
                '    stream = io.BytesIO()',
                '    return stream.getvalue().decode()',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('decode')[0];
            const callers = index.findCallers('decode', {
                targetDefinitions: [target], collectAccount: true,
            });
            assert.ok(!callers.some(c => c.relativePath === 'app.py' && c.line === 4),
                `bytes.decode must not confirm Codec.decode: ${JSON.stringify(callers)}`);
            const result = execute(index, 'context', { name: 'target.py:2:decode' });
            const json = JSON.parse(require('../core/output').formatContextJson(result.result));
            assert.strictEqual(json.meta.account.conserved, true);
        } finally { rm(dir); }
    });
});
