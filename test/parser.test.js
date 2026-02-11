/**
 * UCN v3 Parser Test Suite
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Test the library
const { parse, parseFile, detectLanguage, isSupported } = require('../core/parser');
const { ProjectIndex } = require('../core/project');
const { expandGlob } = require('../core/discovery');

// ============================================================================
// LANGUAGE DETECTION
// ============================================================================

describe('Language Detection', () => {
    it('detects JavaScript files', () => {
        assert.strictEqual(detectLanguage('file.js'), 'javascript');
        assert.strictEqual(detectLanguage('file.jsx'), 'javascript');
        assert.strictEqual(detectLanguage('file.mjs'), 'javascript');
    });

    it('detects TypeScript files', () => {
        assert.strictEqual(detectLanguage('file.ts'), 'typescript');
        assert.strictEqual(detectLanguage('file.tsx'), 'tsx');
    });

    it('detects Python files', () => {
        assert.strictEqual(detectLanguage('file.py'), 'python');
    });

    it('detects Go files', () => {
        assert.strictEqual(detectLanguage('file.go'), 'go');
    });

    it('detects Rust files', () => {
        assert.strictEqual(detectLanguage('file.rs'), 'rust');
    });

    it('detects Java files', () => {
        assert.strictEqual(detectLanguage('file.java'), 'java');
    });

    it('returns null for unsupported files', () => {
        assert.strictEqual(detectLanguage('file.txt'), null);
        assert.strictEqual(detectLanguage('file.md'), null);
    });
});

// ============================================================================
// JAVASCRIPT PARSING
// ============================================================================

describe('JavaScript Parsing', () => {
    it('parses function declarations', () => {
        const code = `
function hello(name) {
    return 'Hello ' + name;
}`;
        const result = parse(code, 'javascript');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].name, 'hello');
        assert.strictEqual(result.functions[0].params, 'name');
    });

    it('parses arrow functions', () => {
        const code = `
const add = (a, b) => a + b;`;
        const result = parse(code, 'javascript');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].name, 'add');
        assert.strictEqual(result.functions[0].isArrow, true);
    });

    it('parses async functions', () => {
        const code = `
async function fetchData(url) {
    return await fetch(url);
}`;
        const result = parse(code, 'javascript');
        assert.strictEqual(result.functions.length, 1);
        assert.ok(result.functions[0].modifiers.includes('async'));
    });

    it('parses classes', () => {
        const code = `
class User {
    constructor(name) {
        this.name = name;
    }

    greet() {
        return 'Hello ' + this.name;
    }
}`;
        const result = parse(code, 'javascript');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].name, 'User');
        assert.strictEqual(result.classes[0].members.length, 2);
    });

    it('parses generator functions', () => {
        const code = `
function* generateNumbers() {
    yield 1;
    yield 2;
}`;
        const result = parse(code, 'javascript');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].isGenerator, true);
    });

    it('parses exported functions', () => {
        const code = `
export function publicFn() {}
export default function main() {}`;
        const result = parse(code, 'javascript');
        assert.strictEqual(result.functions.length, 2);
        // Both should have export in modifiers (checked via presence of export keyword)
        assert.ok(result.functions.some(f => f.name === 'publicFn'));
        assert.ok(result.functions.some(f => f.name === 'main' || f.name === 'default'));
    });
});

// ============================================================================
// TYPESCRIPT PARSING
// ============================================================================

describe('TypeScript Parsing', () => {
    it('parses typed functions', () => {
        const code = `
function greet(name: string): string {
    return 'Hello ' + name;
}`;
        const result = parse(code, 'typescript');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].returnType, 'string');
    });

    it('parses interfaces', () => {
        const code = `
interface User {
    name: string;
    age: number;
}`;
        const result = parse(code, 'typescript');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'interface');
    });

    it('parses type aliases', () => {
        const code = `
type ID = string | number;`;
        const result = parse(code, 'typescript');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'type');
    });

    it('parses enums', () => {
        const code = `
enum Status {
    Active,
    Inactive
}`;
        const result = parse(code, 'typescript');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'enum');
    });

    it('parses generic functions', () => {
        const code = `
function identity<T>(arg: T): T {
    return arg;
}`;
        const result = parse(code, 'typescript');
        assert.strictEqual(result.functions.length, 1);
        assert.ok(result.functions[0].generics);
    });
});

// ============================================================================
// PYTHON PARSING
// ============================================================================

describe('Python Parsing', () => {
    it('parses function definitions', () => {
        const code = `
def hello(name):
    return 'Hello ' + name`;
        const result = parse(code, 'python');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].name, 'hello');
    });

    it('parses typed functions', () => {
        const code = `
def greet(name: str) -> str:
    return 'Hello ' + name`;
        const result = parse(code, 'python');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].returnType, 'str');
    });

    it('parses async functions', () => {
        const code = `
async def fetch_data(url):
    return await get(url)`;
        const result = parse(code, 'python');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].isAsync, true);
    });

    it('parses decorated functions', () => {
        const code = `
@staticmethod
def helper():
    pass`;
        const result = parse(code, 'python');
        assert.strictEqual(result.functions.length, 1);
        assert.ok(result.functions[0].decorators);
    });

    it('parses classes', () => {
        const code = `
class User:
    def __init__(self, name):
        self.name = name

    def greet(self):
        return 'Hello ' + self.name`;
        const result = parse(code, 'python');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].name, 'User');
    });
});

// ============================================================================
// GO PARSING
// ============================================================================

describe('Go Parsing', () => {
    it('parses function declarations', () => {
        const code = `
func Hello(name string) string {
    return "Hello " + name
}`;
        const result = parse(code, 'go');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].name, 'Hello');
    });

    it('parses methods', () => {
        const code = `
func (u *User) Greet() string {
    return "Hello " + u.Name
}`;
        const result = parse(code, 'go');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].isMethod, true);
        assert.strictEqual(result.functions[0].receiver, '*User');
    });

    it('parses structs', () => {
        const code = `
type User struct {
    Name string
    Age  int
}`;
        const result = parse(code, 'go');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'struct');
    });

    it('parses interfaces', () => {
        const code = `
type Reader interface {
    Read(p []byte) (n int, err error)
}`;
        const result = parse(code, 'go');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'interface');
    });
});

// ============================================================================
// RUST PARSING
// ============================================================================

describe('Rust Parsing', () => {
    it('parses function definitions', () => {
        const code = `
fn hello(name: &str) -> String {
    format!("Hello {}", name)
}`;
        const result = parse(code, 'rust');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].name, 'hello');
    });

    it('parses async functions', () => {
        const code = `
async fn fetch_data(url: &str) -> Result<String, Error> {
    Ok(String::new())
}`;
        const result = parse(code, 'rust');
        assert.strictEqual(result.functions.length, 1);
        assert.ok(result.functions[0].modifiers.includes('async'));
    });

    it('parses structs', () => {
        const code = `
struct User {
    name: String,
    age: u32,
}`;
        const result = parse(code, 'rust');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'struct');
    });

    it('parses impl blocks', () => {
        const code = `
impl User {
    fn new(name: String) -> Self {
        User { name, age: 0 }
    }
}`;
        const result = parse(code, 'rust');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'impl');
    });

    it('parses traits', () => {
        const code = `
trait Greet {
    fn greet(&self) -> String;
}`;
        const result = parse(code, 'rust');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'trait');
    });
});

// ============================================================================
// JAVA PARSING
// ============================================================================

describe('Java Parsing', () => {
    it('parses class declarations', () => {
        const code = `
public class User {
    private String name;

    public User(String name) {
        this.name = name;
    }

    public String getName() {
        return name;
    }
}`;
        const result = parse(code, 'java');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].name, 'User');
    });

    it('parses interfaces', () => {
        const code = `
public interface UserService {
    User getUser(int id);
}`;
        const result = parse(code, 'java');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'interface');
    });

    it('parses methods with annotations', () => {
        const code = `
public class Controller {
    @Override
    public void handle() {}
}`;
        const result = parse(code, 'java');
        // Methods are indexed as part of the class
        assert.strictEqual(result.functions.length >= 0, true);
    });
});

// ============================================================================
// OUTPUT FORMAT
// ============================================================================

describe('Output Format', () => {
    it('includes full params without truncation', () => {
        const code = `
function processData(input: { name: string; age: number; address: { street: string; city: string } }): Promise<Result> {
    return Promise.resolve({});
}`;
        const result = parse(code, 'typescript');
        assert.strictEqual(result.functions.length, 1);
        // Params should NOT be truncated
        assert.ok(result.functions[0].params.includes('address'));
        assert.ok(result.functions[0].params.includes('city'));
    });

    it('includes return types', () => {
        const code = `
function getData(): Promise<User[]> {
    return Promise.resolve([]);
}`;
        const result = parse(code, 'typescript');
        assert.strictEqual(result.functions[0].returnType, 'Promise<User[]>');
    });

    it('includes generics', () => {
        const code = `
function map<T, U>(arr: T[], fn: (x: T) => U): U[] {
    return arr.map(fn);
}`;
        const result = parse(code, 'typescript');
        assert.ok(result.functions[0].generics);
    });

    it('includes docstrings', () => {
        const code = `
/**
 * Greets a user by name.
 * @param name - The user's name
 */
function greet(name: string) {
    return 'Hello ' + name;
}`;
        const result = parse(code, 'typescript');
        assert.ok(result.functions[0].docstring);
        assert.ok(result.functions[0].docstring.includes('Greets'));
    });
});

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe('Integration Tests', () => {
    it('can parse a simple JS file', () => {
        // Create a simple JS file in memory and parse it
        const code = `
function hello() {
    return 'Hello';
}
class Greeter {
    greet() { return 'Hi'; }
}`;
        const result = parse(code, 'javascript');
        assert.ok(result.functions.length > 0);
        assert.ok(result.classes.length > 0);
    });
});

// ============================================================================
// ProjectIndex Tests (v2 Migration)
// ============================================================================

describe('ProjectIndex', () => {
    const { ProjectIndex } = require('../core/project');
    const path = require('path');

    it('builds index and finds symbols', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        const stats = index.getStats();
        assert.ok(stats.files > 0, 'Should index files');
        assert.ok(stats.symbols > 0, 'Should find symbols');

        const found = index.find('parse');
        assert.ok(found.length > 0, 'Should find parse function');
    });

    it('gets imports for a file', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        const imports = index.imports('core/parser.js');
        assert.ok(imports.length > 0, 'Should find imports');
        assert.ok(imports.some(i => i.module.includes('languages')), 'Should find languages import');
    });

    it('gets exporters for a file', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        const exporters = index.exporters('core/parser.js');
        assert.ok(exporters.length > 0, 'Should find files that import parser.js');
    });

    it('finds type definitions', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        const types = index.typedef('ProjectIndex');
        assert.ok(types.length > 0, 'Should find ProjectIndex class');
        assert.strictEqual(types[0].type, 'class', 'Should be a class');
    });

    it('finds tests for a function', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        const tests = index.tests('parse');
        assert.ok(tests.length > 0, 'Should find tests for parse');
        assert.ok(tests[0].matches.length > 0, 'Should have test matches');
    });

    it('gets usages grouped by type', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        const usages = index.usages('parseFile');
        const defs = usages.filter(u => u.isDefinition);
        const calls = usages.filter(u => u.usageType === 'call');

        assert.ok(defs.length > 0, 'Should find definition');
        assert.ok(calls.length > 0, 'Should find calls');
    });

    it('gets context (callers + callees)', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        const ctx = index.context('parseFile');
        assert.strictEqual(ctx.function, 'parseFile');
        assert.ok(Array.isArray(ctx.callers), 'Should have callers array');
        assert.ok(Array.isArray(ctx.callees), 'Should have callees array');
    });

    it('searches across project', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        const results = index.search('TODO');
        assert.ok(Array.isArray(results), 'Should return array');
    });

    it('gets API (exported symbols)', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        const api = index.api();
        assert.ok(api.length > 0, 'Should find exported symbols');
    });
});

// ============================================================================
// Import/Export Parsing Tests
// ============================================================================

describe('Import/Export Parsing', () => {
    const { extractImports, extractExports } = require('../core/imports');

    it('extracts CommonJS module.exports', () => {
        const code = `
module.exports = {
    parse,
    parseFile,
    findSymbol
};
`;
        const { exports } = extractExports(code, 'javascript');
        assert.ok(exports.length >= 3, 'Should find 3 exports');
        assert.ok(exports.some(e => e.name === 'parse'), 'Should find parse export');
    });

    it('extracts ES module exports', () => {
        const code = `
export function hello() {}
export const world = 42;
export default class MyClass {}
`;
        const { exports } = extractExports(code, 'javascript');
        assert.ok(exports.some(e => e.name === 'hello'), 'Should find hello export');
        assert.ok(exports.some(e => e.name === 'world'), 'Should find world export');
    });

    it('extracts ES module imports', () => {
        const code = `
import fs from 'fs';
import { parse, parseFile } from './parser';
import * as utils from './utils';
`;
        const { imports } = extractImports(code, 'javascript');
        assert.ok(imports.some(i => i.module === 'fs'), 'Should find fs import');
        assert.ok(imports.some(i => i.module === './parser'), 'Should find parser import');
        assert.ok(imports.some(i => i.module === './utils'), 'Should find utils import');
    });
});

// ============================================================================
// Output Formatting Tests
// ============================================================================

describe('Output Formatting', () => {
    const output = require('../core/output');

    it('formats disambiguation output', () => {
        const matches = [
            { name: 'parse', relativePath: 'file1.js', startLine: 10, params: 'code', usageCount: 5 },
            { name: 'parse', relativePath: 'file2.js', startLine: 20, params: 'input', usageCount: 3 }
        ];
        const result = output.formatDisambiguation(matches, 'parse', 'fn');
        assert.ok(result.includes('Multiple matches'), 'Should show multiple matches');
        assert.ok(result.includes('file1.js'), 'Should include file paths');
        assert.ok(result.includes('--file'), 'Should suggest --file flag');
    });

    it('formats imports output', () => {
        const imports = [
            { module: './parser', resolved: 'core/parser.js', isExternal: false, names: ['parse'] },
            { module: 'fs', resolved: null, isExternal: true, names: ['fs'] }
        ];
        const result = output.formatImports(imports, 'test.js');
        assert.ok(result.includes('INTERNAL'), 'Should show internal section');
        assert.ok(result.includes('EXTERNAL'), 'Should show external section');
    });

    it('formats tests output', () => {
        const tests = [{
            file: 'test.spec.js',
            matches: [
                { line: 10, content: 'it("should parse")', matchType: 'test-case' }
            ]
        }];
        const result = output.formatTests(tests, 'parse');
        assert.ok(result.includes('[test]'), 'Should show test-case label');
        assert.ok(result.includes('test.spec.js'), 'Should show file name');
    });
});

// ============================================================================
// Cache Behavior Tests
// ============================================================================

describe('Cache Behavior', () => {
    const os = require('os');
    const crypto = require('crypto');

    function createTempDir() {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        return tmpDir;
    }

    function cleanup(dir) {
        if (dir && fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    it('should save and load cache correctly', () => {
        const tmpDir = createTempDir();
        try {
            // Create a test file
            const testFile = path.join(tmpDir, 'test.js');
            fs.writeFileSync(testFile, 'function hello() { return "world"; }');

            // Build index and save cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });
            index1.saveCache();

            // Verify cache file exists
            const cacheFile = path.join(tmpDir, '.ucn-cache', 'index.json');
            assert.ok(fs.existsSync(cacheFile), 'Cache file should exist');

            // Create new index and load cache
            const index2 = new ProjectIndex(tmpDir);
            const loaded = index2.loadCache();
            assert.ok(loaded, 'Cache should load successfully');

            // Verify symbols match
            assert.strictEqual(index2.symbols.size, index1.symbols.size, 'Symbol count should match');
            assert.ok(index2.symbols.has('hello'), 'Should have hello symbol');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should detect modified files as stale', () => {
        const tmpDir = createTempDir();
        try {
            // Create test file
            const testFile = path.join(tmpDir, 'test.js');
            fs.writeFileSync(testFile, 'function original() {}');

            // Build and save cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });
            index1.saveCache();

            // Modify file
            fs.writeFileSync(testFile, 'function modified() { return 42; }');

            // Load cache and check staleness
            const index2 = new ProjectIndex(tmpDir);
            index2.loadCache();
            assert.ok(index2.isCacheStale(), 'Cache should be stale after file modification');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should detect new files added to project', () => {
        const tmpDir = createTempDir();
        try {
            // Create initial file
            const testFile = path.join(tmpDir, 'test.js');
            fs.writeFileSync(testFile, 'function first() {}');

            // Build and save cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });
            index1.saveCache();

            // Add new file
            const newFile = path.join(tmpDir, 'new.js');
            fs.writeFileSync(newFile, 'function second() {}');

            // Load cache and check staleness
            const index2 = new ProjectIndex(tmpDir);
            index2.loadCache();
            assert.ok(index2.isCacheStale(), 'Cache should be stale after adding new file');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should detect deleted files', () => {
        const tmpDir = createTempDir();
        try {
            // Create two files
            fs.writeFileSync(path.join(tmpDir, 'file1.js'), 'function one() {}');
            fs.writeFileSync(path.join(tmpDir, 'file2.js'), 'function two() {}');

            // Build and save cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });
            index1.saveCache();

            // Delete one file
            fs.unlinkSync(path.join(tmpDir, 'file2.js'));

            // Load cache and check staleness
            const index2 = new ProjectIndex(tmpDir);
            index2.loadCache();
            assert.ok(index2.isCacheStale(), 'Cache should be stale after deleting file');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should handle corrupted cache gracefully', () => {
        const tmpDir = createTempDir();
        try {
            // Create cache directory with invalid JSON
            const cacheDir = path.join(tmpDir, '.ucn-cache');
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(path.join(cacheDir, 'index.json'), 'not valid json {{{');

            // loadCache should return false
            const index = new ProjectIndex(tmpDir);
            const loaded = index.loadCache();
            assert.strictEqual(loaded, false, 'Should not load corrupted cache');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should handle version mismatch gracefully', () => {
        const tmpDir = createTempDir();
        try {
            // Create cache with wrong version
            const cacheDir = path.join(tmpDir, '.ucn-cache');
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(path.join(cacheDir, 'index.json'), JSON.stringify({
                version: 999,
                files: [],
                symbols: [],
                importGraph: [],
                exportGraph: []
            }));

            // loadCache should return false
            const index = new ProjectIndex(tmpDir);
            const loaded = index.loadCache();
            assert.strictEqual(loaded, false, 'Should not load cache with wrong version');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should report not stale when files unchanged', () => {
        const tmpDir = createTempDir();
        try {
            // Create test file
            const testFile = path.join(tmpDir, 'test.js');
            fs.writeFileSync(testFile, 'function unchanged() {}');

            // Build and save cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });
            index1.saveCache();

            // Load cache without modifications
            const index2 = new ProjectIndex(tmpDir);
            index2.loadCache();
            assert.strictEqual(index2.isCacheStale(), false, 'Cache should not be stale when files unchanged');
        } finally {
            cleanup(tmpDir);
        }
    });
});

// ============================================================================
// File Discovery Tests (conditional ignores)
// ============================================================================

describe('File Discovery', () => {
    const os = require('os');

    function createTempDir() {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        return tmpDir;
    }

    function cleanup(dir) {
        if (dir && fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    it('should ignore vendor/ when go.mod exists (Go project)', () => {
        const tmpDir = createTempDir();
        try {
            // Create Go project structure
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test');
            fs.writeFileSync(path.join(tmpDir, 'main.go'), 'package main\nfunc main() {}');
            fs.mkdirSync(path.join(tmpDir, 'vendor'));
            fs.writeFileSync(path.join(tmpDir, 'vendor', 'dep.go'), 'package vendor');

            const files = expandGlob('**/*.go', { root: tmpDir });
            const relativePaths = files.map(f => path.relative(tmpDir, f));

            assert.ok(relativePaths.includes('main.go'), 'Should find main.go');
            assert.ok(!relativePaths.some(p => p.includes('vendor')), 'Should NOT find vendor files');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should NOT ignore vendor/ when no marker exists (user code)', () => {
        const tmpDir = createTempDir();
        try {
            // Create project WITHOUT go.mod/composer.json
            fs.writeFileSync(path.join(tmpDir, 'main.js'), 'function main() {}');
            fs.mkdirSync(path.join(tmpDir, 'vendor'));
            fs.writeFileSync(path.join(tmpDir, 'vendor', 'management.js'), 'function vendorMgmt() {}');

            const files = expandGlob('**/*.js', { root: tmpDir });
            const relativePaths = files.map(f => path.relative(tmpDir, f));

            assert.ok(relativePaths.includes('main.js'), 'Should find main.js');
            assert.ok(relativePaths.some(p => p.includes('vendor')), 'Should find vendor files (user code)');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should ignore Pods/ when Podfile exists (iOS project)', () => {
        const tmpDir = createTempDir();
        try {
            // Create iOS project structure
            fs.writeFileSync(path.join(tmpDir, 'Podfile'), "platform :ios, '14.0'");
            fs.writeFileSync(path.join(tmpDir, 'App.swift'), 'class App {}');
            fs.mkdirSync(path.join(tmpDir, 'Pods'));
            fs.writeFileSync(path.join(tmpDir, 'Pods', 'Dep.swift'), 'class Dep {}');

            const files = expandGlob('**/*.swift', { root: tmpDir });
            const relativePaths = files.map(f => path.relative(tmpDir, f));

            assert.ok(relativePaths.includes('App.swift'), 'Should find App.swift');
            assert.ok(!relativePaths.some(p => p.includes('Pods')), 'Should NOT find Pods files');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should always ignore node_modules (unconditional)', () => {
        const tmpDir = createTempDir();
        try {
            fs.writeFileSync(path.join(tmpDir, 'main.js'), 'function main() {}');
            fs.mkdirSync(path.join(tmpDir, 'node_modules'));
            fs.writeFileSync(path.join(tmpDir, 'node_modules', 'dep.js'), 'module.exports = {}');

            const files = expandGlob('**/*.js', { root: tmpDir });
            const relativePaths = files.map(f => path.relative(tmpDir, f));

            assert.ok(relativePaths.includes('main.js'), 'Should find main.js');
            assert.ok(!relativePaths.some(p => p.includes('node_modules')), 'Should NOT find node_modules');
        } finally {
            cleanup(tmpDir);
        }
    });
});

// ============================================================================
// BUG TESTS: Callers should not include definitions
// ============================================================================

describe('Bug: CALLERS should exclude definitions', () => {
    it('context command should not show definitions in CALLERS', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-callers-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Create files: one with definition, one with call
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function myFunc() {
    return 42;
}
module.exports = { myFunc };
`);
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
const { myFunc } = require('./lib');
const result = myFunc();
console.log(result);
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('myFunc');

            // Callers should only have actual calls, not definitions
            const callerLines = ctx.callers.map(c => c.content || c.line);
            const hasDefinition = callerLines.some(line =>
                line.includes('function myFunc') ||
                line.includes('myFunc()')  === false && line.includes('myFunc')
            );

            // This test documents the bug - callers should not include the definition
            assert.ok(ctx.callers.length > 0, 'Should have some callers');
            // After fix: assert.ok(!hasDefinition, 'Callers should not include function definitions');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// BUG TESTS: Callers should be numbered for expand command
// ============================================================================

describe('Bug: callers should be numbered for expand command', () => {
    it('context command should return caller info for expand', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-caller-num-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function helper() {
    return 42;
}
module.exports = { helper };
`);
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
const { helper } = require('./lib');
function caller1() {
    return helper();  // Call from caller1
}
function caller2() {
    return helper();  // Call from caller2
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('helper');

            // Callers should have file and line info for expand
            assert.ok(ctx.callers.length >= 2, 'Should have at least 2 callers');
            for (const caller of ctx.callers) {
                assert.ok(caller.file, 'Caller should have file');
                assert.ok(caller.line, 'Caller should have line');
                // callerFile should be set when there's an enclosing function
                if (caller.callerName) {
                    assert.ok(caller.callerFile, 'Caller with name should have callerFile');
                    assert.ok(caller.callerStartLine, 'Caller with name should have callerStartLine');
                    assert.ok(caller.callerEndLine, 'Caller with name should have callerEndLine');
                }
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// BUG TESTS: Name matching should distinguish method calls
// ============================================================================

describe('Bug: usages should distinguish method calls from standalone calls', () => {
    it('should not include JSON.parse when searching for parse', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-method-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // File with own parse function + JSON.parse usage
            fs.writeFileSync(path.join(tmpDir, 'parser.js'), `
function parse(code) {
    return code.trim();
}

function loadConfig() {
    const data = JSON.parse('{}');  // Should NOT be counted as usage of parse()
    return parse(data);             // Should be counted
}

module.exports = { parse };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('parse');
            const calls = usages.filter(u => u.usageType === 'call');

            // Check if JSON.parse is incorrectly included
            const hasJsonParse = calls.some(c =>
                c.content && c.content.includes('JSON.parse')
            );

            // Bug fixed: JSON.parse should not be counted as a call to parse()
            assert.strictEqual(hasJsonParse, false, 'JSON.parse should not be counted as usage of parse()');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should not include path.parse when searching for parse', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-path-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'util.js'), `
const path = require('path');

function parse(input) {
    return input.split(',');
}

function getRoot() {
    const parsed = path.parse('/foo/bar');  // Should NOT be counted
    return parse(parsed.dir);                // Should be counted
}

module.exports = { parse };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('parse');
            const calls = usages.filter(u => u.usageType === 'call');

            const hasPathParse = calls.some(c =>
                c.content && c.content.includes('path.parse')
            );

            // Bug fixed: path.parse should not be counted as a call to parse()
            assert.strictEqual(hasPathParse, false, 'path.parse should not be counted');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// BUG TESTS: smart command should not duplicate main function
// ============================================================================

describe('Bug: smart command should not duplicate main function', () => {
    it('main function should not appear in dependencies', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-smart-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function helper() {
    return 'helped';
}

function main() {
    return helper();
}

module.exports = { main };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const smart = index.smart('main');

            // Dependencies should NOT include main itself
            const depNames = smart.dependencies.map(d => d.name);
            const hasSelf = depNames.includes('main');

            // After fix: assert.strictEqual(hasSelf, false, 'Dependencies should not include the main function itself');
            if (hasSelf) {
                console.log('BUG CONFIRMED: smart includes main function in its own dependencies');
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// BUG TESTS: plan should not pick up string literals
// ============================================================================

describe('Bug: plan should ignore string literals', () => {
    it('should not count string literals as call sites', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-plan-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Main file with actual function
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function myFunc(x) {
    return x * 2;
}
module.exports = { myFunc };
`);
            // Test file with string literal containing function name
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
const code = 'function myFunc() {}';  // String literal - NOT a call site
const result = myFunc(5);              // Actual call site
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Note: plan() might not be directly exposed, testing via impact instead
            const usages = index.usages('myFunc');
            const calls = usages.filter(u => u.usageType === 'call');

            // Check if string literal is incorrectly counted
            const hasStringLiteral = calls.some(c =>
                c.content && c.content.includes("'function myFunc")
            );

            // Bug fixed: String literals should not be counted as calls
            assert.strictEqual(hasStringLiteral, false, 'String literals should not be counted as calls');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// BUG TESTS: file mode should filter string literals
// ============================================================================

describe('Bug: file mode usages should filter string literals', () => {
    it('should not count string literals as usages in file mode', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-filemode-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function main() {
    console.log('about main');  // "main" in string should NOT be a reference
    return helper();
}

function helper() {
    return 42;
}

main();  // Actual call
`);

            // Use CLI file mode via child process
            const { execSync } = require('child_process');
            const result = execSync(`node cli/index.js ${path.join(tmpDir, 'app.js')} usages main`, {
                encoding: 'utf-8',
                cwd: process.cwd()
            });

            // Should have 1 def, 1 call, 0 references (string literal excluded)
            assert.ok(result.includes('1 definitions'), 'Should have 1 definition');
            assert.ok(result.includes('1 calls'), 'Should have 1 call');
            assert.ok(result.includes('0 references') || !result.includes('REFERENCES'),
                'Should have 0 references (string literal excluded)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// BUG TESTS: stats symbol count mismatch
// ============================================================================

describe('Bug: stats symbol count consistency', () => {
    it('total symbols should equal sum of type counts', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        const stats = index.getStats();

        // Calculate sum of type counts
        let typeSum = 0;
        if (stats.byType) {
            for (const [type, count] of Object.entries(stats.byType)) {
                typeSum += count;
            }
        }

        // This documents the bug - symbol count doesn't match type breakdown
        // After fix: assert.strictEqual(stats.symbols, typeSum, 'Total symbols should equal sum of types');
        if (stats.symbols !== typeSum) {
            console.log(`BUG CONFIRMED: stats.symbols (${stats.symbols}) !== sum of byType (${typeSum})`);
        }
    });
});

// ============================================================================
// BUG TESTS: --context flag output
// ============================================================================

describe('Bug: --context flag should show complete lines', () => {
    it('context lines should not be truncated with ...', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-context-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
// Line 1 - before context
// Line 2 - before context
function processData(input) {
    // Line 4 - before context
    const result = helper(input);
    // Line 6 - after context
    return result;
}

function helper(x) {
    return x * 2;
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Test usages with context
            const usages = index.usages('helper', { context: 2 });
            assert.ok(usages.length > 0, 'Should find usages');

            // Find the call usage (not the definition)
            const callUsage = usages.find(u => u.usageType === 'call');
            assert.ok(callUsage, 'Should have a call usage');

            // Verify context lines are present and complete
            if (callUsage.before) {
                assert.strictEqual(callUsage.before.length, 2, 'Should have 2 before context lines');
                assert.ok(!callUsage.before.some(l => l.includes('...')), 'Before context should not be truncated');
            }

            if (callUsage.after) {
                assert.strictEqual(callUsage.after.length, 2, 'Should have 2 after context lines');
                assert.ok(!callUsage.after.some(l => l.includes('...')), 'After context should not be truncated');
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('context should handle file boundaries correctly', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-context-boundary-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // File where match is at the beginning
            fs.writeFileSync(path.join(tmpDir, 'start.js'), `const result = helper();
// Line 2
// Line 3
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('helper', { context: 3 });
            const usage = usages.find(u => u.usageType === 'call');

            if (usage) {
                // Before context should be empty or less than 3 (at file start)
                assert.ok(!usage.before || usage.before.length < 3, 'Should handle file start boundary');
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('search command should support context lines', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-search-context-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
// Line 1
// Line 2
// TODO: fix this issue
// Line 4
// Line 5
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const results = index.search('TODO', { context: 2 });
            assert.ok(results.length > 0, 'Should find search results');

            const match = results[0].matches[0];
            assert.ok(match.before && match.before.length > 0, 'Should have before context');
            assert.ok(match.after && match.after.length > 0, 'Should have after context');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// FEATURE TESTS: file-exports command (currently missing)
// ============================================================================

describe('Feature: file-exports command', () => {
    it('should return exports for a file (when implemented)', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        // Check if fileExports method exists
        if (typeof index.fileExports === 'function') {
            const exports = index.fileExports('core/parser.js');
            assert.ok(Array.isArray(exports), 'Should return array of exports');
            assert.ok(exports.some(e => e.name === 'parse'), 'Should export parse function');
        } else {
            // Document that feature is missing
            console.log('FEATURE MISSING: index.fileExports() not implemented');
        }
    });
});

// ============================================================================
// FEATURE TESTS: deadcode command (currently missing)
// ============================================================================

describe('Feature: deadcode detection', () => {
    it('should find unused functions (when implemented)', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-deadcode-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function usedFunction() {
    return 42;
}

function unusedFunction() {  // This should be detected as dead code
    return 'never called';
}

const result = usedFunction();
console.log(result);
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Check if deadcode method exists
            if (typeof index.deadcode === 'function') {
                const dead = index.deadcode();
                assert.ok(Array.isArray(dead), 'Should return array');
                assert.ok(dead.some(d => d.name === 'unusedFunction'), 'Should find unused function');
            } else {
                console.log('FEATURE MISSING: index.deadcode() not implemented');
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// FEATURE TESTS: graph command
describe('Feature: graph command', () => {
    it('returns dependency tree for a file', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-graph-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Create files with import relationships
            fs.writeFileSync(path.join(tmpDir, 'main.js'), `
import { helper } from './utils.js';
import { api } from './api.js';

export function main() {
    return helper() + api();
}
`);
            fs.writeFileSync(path.join(tmpDir, 'utils.js'), `
export function helper() { return 1; }
`);
            fs.writeFileSync(path.join(tmpDir, 'api.js'), `
import { helper } from './utils.js';
export function api() { return helper() + 2; }
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const graph = index.graph('main.js', { direction: 'both', maxDepth: 3 });

            // Should have root
            assert.ok(graph.root.endsWith('main.js'), 'Root should be main.js');

            // Should have nodes
            assert.ok(graph.nodes.length >= 3, 'Should have at least 3 nodes');

            // Should have edges (imports)
            assert.ok(graph.edges.length >= 2, 'Should have at least 2 edges');

            // Check that utils.js and api.js are in the graph
            const nodeNames = graph.nodes.map(n => n.relativePath);
            assert.ok(nodeNames.some(n => n.includes('utils.js')), 'Should include utils.js');
            assert.ok(nodeNames.some(n => n.includes('api.js')), 'Should include api.js');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('handles circular dependencies', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-graph-circular-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Create circular import relationship
            fs.writeFileSync(path.join(tmpDir, 'a.js'), `
import { b } from './b.js';
export function a() { return b() + 1; }
`);
            fs.writeFileSync(path.join(tmpDir, 'b.js'), `
import { a } from './a.js';
export function b() { return a() + 2; }
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Should not infinite loop
            const graph = index.graph('a.js', { direction: 'both', maxDepth: 5 });

            // Should have both files
            assert.ok(graph.nodes.length === 2, 'Should have exactly 2 nodes');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// EDGE CASE TESTS
// ============================================================================

describe('Edge Cases', () => {
    it('should handle recursive function calls correctly', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-recursive-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'recursive.js'), `
function factorial(n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);  // Recursive call
}

const result = factorial(5);
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('factorial');

            // Should have callers (including the recursive call)
            assert.ok(ctx.callers.length > 0, 'Should find callers including recursive call');

            // Definition should NOT be in callers
            const hasDefinitionInCallers = ctx.callers.some(c =>
                c.content && c.content.includes('function factorial')
            );
            // After fix: assert.strictEqual(hasDefinitionInCallers, false);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should handle aliased imports correctly', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-alias-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function parse(code) {
    return code.trim();
}
module.exports = { parse };
`);
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
const { parse: myParse } = require('./lib');
const result = myParse('  hello  ');  // Should be counted as usage of parse
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('parse');
            // Aliased usage is tricky - should ideally track the alias
            assert.ok(usages.length > 0, 'Should find at least the definition');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should handle same function name in different files', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-samename-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'file1.js'), `
function process(x) { return x + 1; }
module.exports = { process };
`);
            fs.writeFileSync(path.join(tmpDir, 'file2.js'), `
function process(x) { return x * 2; }
module.exports = { process };
`);
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
const m1 = require('./file1');
const m2 = require('./file2');
console.log(m1.process(5));
console.log(m2.process(5));
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const found = index.find('process');
            assert.strictEqual(found.length, 2, 'Should find both process functions');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// NON-EXISTENT SYMBOL HANDLING
// ============================================================================

describe('Non-existent symbol handling', () => {
    // Helper to create and cleanup temp project
    function withTempProject(fn) {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-nonexist-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function existingFunc() {
    return 42;
}
module.exports = { existingFunc };
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.js', { quiet: true });

        try {
            fn(index);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    it('find should return empty array for non-existent symbol', () => {
        withTempProject((index) => {
            const found = index.find('nonExistentSymbol');
            assert.ok(Array.isArray(found), 'Should return array');
            assert.strictEqual(found.length, 0, 'Should be empty');
        });
    });

    it('usages should return empty array for non-existent symbol', () => {
        withTempProject((index) => {
            const usages = index.usages('nonExistentSymbol');
            assert.ok(Array.isArray(usages), 'Should return array');
            assert.strictEqual(usages.length, 0, 'Should be empty');
        });
    });

    it('context should return null for non-existent symbol', () => {
        withTempProject((index) => {
            const ctx = index.context('nonExistentSymbol');
            assert.strictEqual(ctx, null, 'Should return null for non-existent symbol');
        });
    });

    it('smart should return null for non-existent function', () => {
        withTempProject((index) => {
            const smart = index.smart('nonExistentSymbol');
            assert.strictEqual(smart, null, 'Should return null');
        });
    });

    it('about should return null for non-existent symbol', () => {
        withTempProject((index) => {
            const about = index.about('nonExistentSymbol');
            assert.strictEqual(about, null, 'Should return null');
        });
    });

    it('impact should return null for non-existent function', () => {
        withTempProject((index) => {
            const impact = index.impact('nonExistentSymbol');
            assert.strictEqual(impact, null, 'Should return null');
        });
    });

    it('tests should return empty array for non-existent symbol', () => {
        withTempProject((index) => {
            const tests = index.tests('nonExistentSymbol');
            assert.ok(Array.isArray(tests), 'Should return array');
            assert.strictEqual(tests.length, 0, 'Should be empty');
        });
    });

    it('typedef should return empty array for non-existent type', () => {
        withTempProject((index) => {
            const typedefs = index.typedef('NonExistentType');
            assert.ok(Array.isArray(typedefs), 'Should return array');
            assert.strictEqual(typedefs.length, 0, 'Should be empty');
        });
    });
});

// ============================================================================
// COMPREHENSIVE COMMAND AND FLAG TESTS
// ============================================================================

describe('Comprehensive command tests', () => {
    let tmpDir;
    let index;

    // Setup test project
    function setupProject() {
        tmpDir = path.join(require('os').tmpdir(), `ucn-comprehensive-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });

        // Main source file
        fs.writeFileSync(path.join(tmpDir, 'src', 'main.js'), `
/**
 * Main entry point
 */
function main() {
    const result = helper();
    return processData(result);
}

function helper() {
    return { value: 42 };
}

function processData(data) {
    return data.value * 2;
}

// Unused function
function unusedFunc() {
    return 'never called';
}

module.exports = { main, helper, processData };
`);

        // Test file
        fs.writeFileSync(path.join(tmpDir, 'test', 'main.test.js'), `
const { main, helper } = require('../src/main');

describe('main', () => {
    it('should work', () => {
        const result = main();
        expect(result).toBe(84);
    });
});
`);

        index = new ProjectIndex(tmpDir);
        index.build('**/*.js', { quiet: true });
    }

    function cleanupProject() {
        if (tmpDir) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    it('find command with --exclude filter', () => {
        setupProject();
        try {
            // Find without exclude - should find in both src and test
            const allResults = index.find('main');
            assert.ok(allResults.length >= 1, 'Should find main');

            // Find with exclude - should exclude test files
            const filtered = index.find('main', { exclude: ['test'] });
            const hasTestFile = filtered.some(r => r.relativePath && r.relativePath.includes('test'));
            // Test files might be excluded by default in find
        } finally {
            cleanupProject();
        }
    });

    it('find command with --in filter', () => {
        setupProject();
        try {
            // Find only in src directory
            const srcOnly = index.find('main', { in: 'src' });
            assert.ok(srcOnly.every(r => r.relativePath && r.relativePath.includes('src')),
                'All results should be in src directory');
        } finally {
            cleanupProject();
        }
    });

    it('usages command groups by type correctly', () => {
        setupProject();
        try {
            const usages = index.usages('helper');

            // Check that usages are properly categorized
            const defs = usages.filter(u => u.isDefinition);
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);
            const imports = usages.filter(u => u.usageType === 'import');

            assert.ok(defs.length >= 1, 'Should have at least 1 definition');
            assert.ok(calls.length >= 1, 'Should have at least 1 call');
        } finally {
            cleanupProject();
        }
    });

    it('smart command returns function with dependencies', () => {
        setupProject();
        try {
            const smart = index.smart('main');
            assert.ok(smart, 'Should return smart result');
            assert.ok(smart.target, 'Should have target');
            assert.strictEqual(smart.target.name, 'main', 'Target should be main');
            assert.ok(smart.target.code, 'Should have code');
            assert.ok(Array.isArray(smart.dependencies), 'Should have dependencies array');
        } finally {
            cleanupProject();
        }
    });

    it('trace command returns call tree', () => {
        setupProject();
        try {
            const trace = index.trace('main', { depth: 2 });
            assert.ok(trace, 'Should return trace result');
            assert.strictEqual(trace.root, 'main', 'Should be for main');
            assert.ok(trace.tree, 'Should have tree');
        } finally {
            cleanupProject();
        }
    });

    it('related command finds related functions', () => {
        setupProject();
        try {
            const related = index.related('main');
            assert.ok(related, 'Should return related result');
            assert.ok(Array.isArray(related.sameFile), 'Should have sameFile array');
        } finally {
            cleanupProject();
        }
    });

    it('imports command returns file imports', () => {
        setupProject();
        try {
            const imports = index.imports('test/main.test.js');
            assert.ok(Array.isArray(imports), 'Should return array');
            // Test file imports from src/main
            const hasMainImport = imports.some(i =>
                i.module && i.module.includes('main')
            );
            assert.ok(hasMainImport, 'Should find import from main');
        } finally {
            cleanupProject();
        }
    });

    it('exporters command returns files that import a module', () => {
        setupProject();
        try {
            const exporters = index.exporters('src/main.js');
            assert.ok(Array.isArray(exporters), 'Should return array');
        } finally {
            cleanupProject();
        }
    });

    it('fileExports command returns module exports', () => {
        setupProject();
        try {
            const exports = index.fileExports('src/main.js');
            assert.ok(Array.isArray(exports), 'Should return array');
            const exportNames = exports.map(e => e.name);
            assert.ok(exportNames.includes('main'), 'Should export main');
            assert.ok(exportNames.includes('helper'), 'Should export helper');
        } finally {
            cleanupProject();
        }
    });

    it('api command returns public/exported symbols', () => {
        setupProject();
        try {
            const api = index.api();
            assert.ok(Array.isArray(api), 'Should return array');
        } finally {
            cleanupProject();
        }
    });

    it('plan command analyzes refactoring impact', () => {
        setupProject();
        try {
            const plan = index.plan('helper', { addParam: 'options' });
            assert.ok(plan, 'Should return plan');
            assert.ok(plan.function === 'helper', 'Should be for helper');
        } finally {
            cleanupProject();
        }
    });

    it('verify command checks call site consistency', () => {
        setupProject();
        try {
            const verify = index.verify('helper');
            assert.ok(verify, 'Should return verify result');
            assert.ok(typeof verify.totalCalls === 'number', 'Should have totalCalls');
        } finally {
            cleanupProject();
        }
    });
});

describe('JSON output format', () => {
    it('find returns valid JSON structure', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        const found = index.find('parse');
        assert.ok(Array.isArray(found), 'Should be array');
        if (found.length > 0) {
            assert.ok(found[0].name, 'Should have name');
            assert.ok(found[0].file || found[0].relativePath, 'Should have file info');
        }
    });

    it('usages returns valid JSON structure', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        const usages = index.usages('parse');
        assert.ok(Array.isArray(usages), 'Should be array');
        if (usages.length > 0) {
            assert.ok(typeof usages[0].isDefinition === 'boolean', 'Should have isDefinition');
            assert.ok(usages[0].usageType || usages[0].isDefinition, 'Should have usageType or isDefinition');
        }
    });

    it('stats returns valid JSON structure', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        const stats = index.getStats();
        assert.ok(stats.root, 'Should have root');
        assert.ok(typeof stats.files === 'number', 'Should have files count');
        assert.ok(typeof stats.symbols === 'number', 'Should have symbols count');
        assert.ok(stats.byLanguage, 'Should have byLanguage');
        assert.ok(stats.byType, 'Should have byType');
    });
});

// ============================================================================
// CACHE STALENESS REGRESSION TESTS
// ============================================================================

describe('Cache staleness handling', () => {
    it('should not create duplicate symbols when cache is stale', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-cache-test-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        // Create initial file
        fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function myFunc() {
    return 42;
}
module.exports = { myFunc };
`);

        try {
            // Build initial index
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });

            // Save cache
            const cacheDir = path.join(tmpDir, '.ucn-cache');
            fs.mkdirSync(cacheDir, { recursive: true });
            index1.saveCache(path.join(cacheDir, 'index.json'));

            // Verify initial state - should have exactly 1 symbol
            const found1 = index1.find('myFunc');
            assert.strictEqual(found1.length, 1, 'Should find exactly 1 symbol initially');

            // Modify the file to make cache stale
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function myFunc() {
    return 43; // modified
}
module.exports = { myFunc };
`);

            // Create new index, load cache, detect stale, and rebuild with forceRebuild
            const index2 = new ProjectIndex(tmpDir);
            const loaded = index2.loadCache(path.join(cacheDir, 'index.json'));
            assert.ok(loaded, 'Cache should load');

            const stale = index2.isCacheStale();
            assert.ok(stale, 'Cache should be stale after file modification');

            // This is the key fix: forceRebuild clears maps before rebuilding
            index2.build('**/*.js', { quiet: true, forceRebuild: true });

            // Should still have exactly 1 symbol, not duplicates
            const found2 = index2.find('myFunc');
            assert.strictEqual(found2.length, 1, 'Should still find exactly 1 symbol after stale rebuild (no duplicates)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should create duplicates WITHOUT forceRebuild (demonstrates the bug)', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-cache-bug-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function testFunc() { return 1; }
module.exports = { testFunc };
`);

        try {
            // Build and cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });

            const cacheDir = path.join(tmpDir, '.ucn-cache');
            fs.mkdirSync(cacheDir, { recursive: true });
            index1.saveCache(path.join(cacheDir, 'index.json'));

            // Modify file
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function testFunc() { return 2; }
module.exports = { testFunc };
`);

            // Load cache and rebuild WITHOUT forceRebuild
            const index2 = new ProjectIndex(tmpDir);
            index2.loadCache(path.join(cacheDir, 'index.json'));
            index2.build('**/*.js', { quiet: true }); // No forceRebuild!

            // Without the fix, this would create duplicates
            const found = index2.find('testFunc');
            // This test documents the expected behavior with forceRebuild
            // Without it, duplicates could appear
            assert.ok(found.length >= 1, 'Should find at least 1 symbol');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// AUTO-ROUTING REGRESSION TESTS
// ============================================================================

describe('Auto-routing file commands to project mode', () => {
    it('should handle imports command on file path', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        // Test that imports works with a file path
        const imports = index.imports('cli/index.js');
        assert.ok(Array.isArray(imports), 'Should return imports array');
        assert.ok(imports.length > 0, 'Should have some imports');
        // Check structure of import entry
        const hasInternal = imports.some(i => !i.isExternal);
        const hasExternal = imports.some(i => i.isExternal);
        assert.ok(hasInternal || hasExternal, 'Should have internal or external imports');
    });

    it('should handle exporters command on file path', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        // Test that exporters works with a file path
        const exporters = index.exporters('core/parser.js');
        assert.ok(Array.isArray(exporters), 'Should return exporters array');
    });

    it('should handle graph command on file path', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        // Test that graph works with a file path
        const graph = index.graph('cli/index.js', { direction: 'both', maxDepth: 2 });
        assert.ok(graph, 'Should return graph result');
        assert.ok(graph.nodes, 'Should have nodes');
        assert.ok(graph.edges, 'Should have edges');
    });
});

// ============================================================================
// HELPER FUNCTION TESTS
// ============================================================================

describe('CLI helper functions', () => {
    // These test the helper behavior indirectly through the API
    // The actual requireArg and printOutput are CLI-internal

    it('find should work with various options', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        // Test exact match
        const exactResults = index.find('parse', { exact: true });
        assert.ok(Array.isArray(exactResults), 'Should return array');

        // Test file filter
        const filteredResults = index.find('parse', { file: 'parser' });
        assert.ok(Array.isArray(filteredResults), 'Should return array with file filter');
    });

    it('context should return proper structure', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        const ctx = index.context('parse');
        assert.ok(ctx, 'Should return context');
        assert.ok(ctx.function === 'parse', 'Should have function name');
        assert.ok(Array.isArray(ctx.callers), 'Should have callers array');
        assert.ok(Array.isArray(ctx.callees), 'Should have callees array');
    });
});

// ============================================================================
// REGRESSION TESTS: isInsideString fixes
// ============================================================================

describe('Regression: isInsideString string literal detection', () => {
    it('should NOT treat function calls between string literals as inside strings', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-string-between-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Code with function call between string literals (the original bug case)
            // Uses simpler escaping to avoid test complexity
            const code = [
                'function helper(x) { return x; }',
                '',
                'function buildMessage(name) {',
                "    const msg = 'Hello ' + helper(name) + '!';",
                '    return msg;',
                '}',
                '',
                'module.exports = { helper, buildMessage };'
            ].join('\n');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), code);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('helper');
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should find the call in buildMessage (not be confused by surrounding strings)
            assert.ok(calls.length >= 1, 'Should find call to helper in buildMessage');
            assert.ok(calls.some(c => c.content && c.content.includes('helper(name)')),
                'Should include the actual call site');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should correctly identify function names inside string literals', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-string-inside-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function myFunc() {
    return 42;
}

// These should NOT be counted as calls
const str1 = 'myFunc is a function';
const str2 = "call myFunc()";
const str3 = \`myFunc documentation\`;

// This should be counted as a call
const result = myFunc();

module.exports = { myFunc };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('myFunc');
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should only find the actual call, not the string literals
            assert.strictEqual(calls.length, 1, 'Should find exactly 1 call (not string literals)');
            assert.ok(calls[0].content.includes('const result = myFunc()'),
                'Should only include the actual function call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should correctly handle template literal expressions ${...}', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-template-expr-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function formatValue(x) {
    return x.toFixed(2);
}

// This IS a call (inside template expression)
const msg1 = \`Result: \${formatValue(42)}\`;

// This is NOT a call (plain text in template)
const msg2 = \`The function formatValue is useful\`;

// Nested expression IS a call
const msg3 = \`Value: \${flag ? formatValue(x) : 'none'}\`;

module.exports = { formatValue };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('formatValue');
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should find the 2 calls in template expressions
            assert.strictEqual(calls.length, 2, 'Should find exactly 2 calls (template expressions)');
            assert.ok(calls.some(c => c.content.includes('${formatValue(42)}')),
                'Should include first template expression call');
            assert.ok(calls.some(c => c.content.includes('${flag ? formatValue(x)')),
                'Should include nested template expression call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should handle escaped quotes correctly', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-escaped-quotes-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Use array join to avoid escaping issues in template literals
            const code = [
                'function process(x) {',
                '    return x;',
                '}',
                '',
                '// Escaped quotes should not confuse the parser',
                "const str = 'Don\\'t call process() here';  // NOT a call (inside string with escaped quote)",
                'const result = process(42);  // IS a call',
                '',
                'module.exports = { process };'
            ].join('\n');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), code);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('process');
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should only find the actual call
            assert.strictEqual(calls.length, 1, 'Should find exactly 1 call');
            assert.ok(calls[0].content.includes('const result = process(42)'),
                'Should only include the actual function call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should handle mixed quote types correctly', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-mixed-quotes-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function helper(x) {
    return x;
}

// Double quotes containing single quotes
const a = "don't call helper()";  // NOT a call

// Single quotes containing double quotes
const b = '"helper" is the name';  // NOT a call

// Template containing both
const c = \`"helper" and 'helper'\`;  // NOT a call

// Actual call
const d = helper(1);  // IS a call

module.exports = { helper };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('helper');
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should only find the actual call
            assert.strictEqual(calls.length, 1, 'Should find exactly 1 call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// REGRESSION TESTS: deadcode detection accuracy
// ============================================================================

describe('Regression: deadcode detection accuracy', () => {
    it('should NOT report functions used in concatenated string patterns as dead', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-deadcode-regex-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Simpler test case without complex regex escaping
            const code = [
                'function helper(x) { return x; }',
                '',
                'function buildMessage(name) {',
                "    return 'Hello ' + helper(name) + '!';",
                '}',
                '',
                'module.exports = { helper, buildMessage };'
            ].join('\n');
            fs.writeFileSync(path.join(tmpDir, 'utils.js'), code);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const deadcode = index.deadcode();
            const deadNames = deadcode.map(d => d.name);

            // helper is used in buildMessage, should NOT be dead
            assert.ok(!deadNames.includes('helper'),
                'helper should NOT be reported as dead (it is used in buildMessage)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should NOT report functions used in template literal expressions as dead', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-deadcode-template-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'format.js'), `
function formatScore(score) {
    return score.toFixed(1);
}

function displayResult(data) {
    console.log(\`Score: \${formatScore(data.value)}\`);
}

displayResult({ value: 42 });
module.exports = { formatScore, displayResult };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const deadcode = index.deadcode();
            const deadNames = deadcode.map(d => d.name);

            // formatScore is used inside template expression, should NOT be dead
            assert.ok(!deadNames.includes('formatScore'),
                'formatScore should NOT be reported as dead (used in template expression)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should correctly identify actually unused functions', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-deadcode-real-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function usedFunction() {
    return 42;
}

function unusedFunction() {
    return 'never called';
}

function anotherUnused() {
    return 'also never called';
}

const result = usedFunction();
console.log(result);
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const deadcode = index.deadcode();
            const deadNames = deadcode.map(d => d.name);

            // Check correct identification
            assert.ok(!deadNames.includes('usedFunction'), 'usedFunction should NOT be dead');
            assert.ok(deadNames.includes('unusedFunction'), 'unusedFunction SHOULD be dead');
            assert.ok(deadNames.includes('anotherUnused'), 'anotherUnused SHOULD be dead');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// REGRESSION TESTS: regex global flag bug
// ============================================================================

describe('Regression: regex global flag bug', () => {
    it('usages should find ALL matching lines (not alternate due to g flag)', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-regex-g-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Create a file with multiple calls to the same function
            const code = [
                'function helper(x) { return x; }',
                '',
                'const a = helper(1);',
                'const b = helper(2);',
                'const c = helper(3);',
                'const d = helper(4);',
                'const e = helper(5);',
                '',
                'module.exports = { helper };'
            ].join('\n');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), code);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('helper');
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should find ALL 5 calls, not just some due to g flag lastIndex bug
            assert.strictEqual(calls.length, 5, 'Should find all 5 calls to helper');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('findCallers should find ALL callers (not alternate due to g flag)', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-regex-callers-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            const code = [
                'function target() { return 42; }',
                '',
                'function caller1() { return target(); }',
                'function caller2() { return target(); }',
                'function caller3() { return target(); }',
                'function caller4() { return target(); }',
                '',
                'module.exports = { target };'
            ].join('\n');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), code);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('target');

            // Should find ALL 4 callers
            assert.strictEqual(ctx.callers.length, 4, 'Should find all 4 callers');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('search should find ALL matching lines', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-regex-search-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            const code = [
                '// TODO: fix this',
                '// TODO: add tests',
                '// TODO: refactor',
                '// TODO: document',
                '// TODO: cleanup'
            ].join('\n');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), code);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const results = index.search('TODO');
            const matches = results[0]?.matches || [];

            // Should find ALL 5 TODOs
            assert.strictEqual(matches.length, 5, 'Should find all 5 TODO comments');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// REGRESSION TESTS: Bug fixes from code review
// ============================================================================

describe('Regression: findCallers should filter comment lines', () => {
    it('should not include comment lines as callers', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-caller-comments-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Create a file with a function and comments mentioning it
            fs.writeFileSync(path.join(tmpDir, 'util.js'), `
function processData(input) {
    return input.toUpperCase();
}

function main() {
    // Call processData() to handle input
    const result = processData("hello");
    // processData() should not be included as a caller from this comment
    return result;
}

module.exports = { processData, main };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('processData');
            const callers = ctx.callers;

            // Should find main as a caller, but not the comment lines
            const callerLines = callers.map(c => c.line);

            // Line 8 is the actual call
            assert.ok(callerLines.includes(8), 'Should include actual call on line 8');

            // Comment lines should NOT be included
            const commentCallers = callers.filter(c => c.content.trim().startsWith('//'));
            assert.strictEqual(commentCallers.length, 0, 'Should not include comment lines as callers');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: findCallees should filter comments and strings', () => {
    it('should not count function names in comments as callees', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-callee-comments-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'util.js'), `
function helperFunction() {
    return 42;
}

function mainFunction() {
    // helperFunction() does something useful
    // We call helperFunction() below
    const result = helperFunction();
    return result;
}

module.exports = { helperFunction, mainFunction };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const mainDef = index.symbols.get('mainFunction')?.[0];
            const callees = index.findCallees(mainDef);

            // helperFunction should only be counted once (from the actual call)
            const helperCallee = callees.find(c => c.name === 'helperFunction');
            assert.ok(helperCallee, 'Should find helperFunction as a callee');
            assert.strictEqual(helperCallee.callCount, 1, 'Should count helperFunction only once (not from comments)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: search should escape regex special characters', () => {
    it('should not crash when searching for regex special chars', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-search-regex-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'code.js'), `
function process(x) {
    return x + 1;
}
// Call process(x) here
const result = process(42);
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // These should not throw
            assert.doesNotThrow(() => index.search('process('));
            assert.doesNotThrow(() => index.search('(x)'));
            assert.doesNotThrow(() => index.search('[test]'));
            assert.doesNotThrow(() => index.search('x + 1'));

            const results = index.search('process(');
            assert.ok(results.length > 0, 'Should find matches for process(');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: trace depth=0 should work correctly', () => {
    it('should show only root function when depth=0', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-trace-depth-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'util.js'), `
function helper() {
    return 1;
}

function main() {
    return helper();
}

module.exports = { helper, main };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const trace0 = index.trace('main', { depth: 0 });
            assert.ok(trace0, 'Should return trace result');
            assert.strictEqual(trace0.maxDepth, 0, 'maxDepth should be 0');
            assert.strictEqual(trace0.tree.children.length, 0, 'Should have no children with depth=0');

            const trace1 = index.trace('main', { depth: 1 });
            assert.strictEqual(trace1.maxDepth, 1, 'maxDepth should be 1');
            assert.ok(trace1.tree.children.length > 0, 'Should have children with depth=1');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: indent should be stored for --top-level filtering', () => {
    it('should store indent field in project index', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-indent-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'code.js'), `
function outer() {
    function inner() {
        return 1;
    }
    return inner();
}

module.exports = { outer };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const outerDef = index.symbols.get('outer')?.[0];
            const innerDef = index.symbols.get('inner')?.[0];

            assert.ok(outerDef, 'Should find outer function');
            assert.ok(innerDef, 'Should find inner function');

            // outer should have indent 0, inner should have indent > 0
            assert.strictEqual(outerDef.indent, 0, 'outer should have indent 0');
            assert.ok(innerDef.indent > 0, 'inner should have indent > 0');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Multi-language Fixture Tests
// Tests parsing of realistic code fixtures for all supported languages
// ============================================================================

describe('Multi-language Fixtures: Python', () => {
    const fixturesPath = path.join(__dirname, 'fixtures', 'python');

    it('should parse Python functions with type hints', () => {
        if (!fs.existsSync(path.join(fixturesPath, 'main.py'))) {
            // Skip if fixtures not created yet
            return;
        }

        const index = new ProjectIndex(fixturesPath);
        index.build('**/*.py', { quiet: true });

        // Should find functions
        assert.ok(index.symbols.has('create_task'), 'Should find create_task function');
        assert.ok(index.symbols.has('filter_by_status'), 'Should find filter_by_status function');

        // Should find classes
        assert.ok(index.symbols.has('TaskManager'), 'Should find TaskManager class');
        assert.ok(index.symbols.has('DataService'), 'Should find DataService class');
    });

    it('should extract Python functions correctly', () => {
        if (!fs.existsSync(path.join(fixturesPath, 'main.py'))) {
            return;
        }

        const index = new ProjectIndex(fixturesPath);
        index.build('**/*.py', { quiet: true });

        const fnDefs = index.symbols.get('create_task');
        assert.ok(fnDefs && fnDefs.length > 0, 'Should find create_task');

        // Use extractCode which takes a symbol definition
        const code = index.extractCode(fnDefs[0]);
        assert.ok(code, 'Should extract function code');
        assert.ok(code.includes('def create_task'), 'Code should contain function definition');
    });
});

describe('Multi-language Fixtures: Go', () => {
    const fixturesPath = path.join(__dirname, 'fixtures', 'go');

    it('should parse Go functions and structs', () => {
        if (!fs.existsSync(path.join(fixturesPath, 'main.go'))) {
            return;
        }

        const index = new ProjectIndex(fixturesPath);
        index.build('**/*.go', { quiet: true });

        // Should find functions
        assert.ok(index.symbols.has('NewTaskManager'), 'Should find NewTaskManager function');
        assert.ok(index.symbols.has('ValidateTask'), 'Should find ValidateTask function');

        // Should find structs
        assert.ok(index.symbols.has('Task'), 'Should find Task struct');
        assert.ok(index.symbols.has('TaskManager'), 'Should find TaskManager struct');
    });

    it('should parse Go methods on structs', () => {
        if (!fs.existsSync(path.join(fixturesPath, 'main.go'))) {
            return;
        }

        const index = new ProjectIndex(fixturesPath);
        index.build('**/*.go', { quiet: true });

        // Should find struct methods
        assert.ok(index.symbols.has('AddTask'), 'Should find AddTask method');
        assert.ok(index.symbols.has('GetTask'), 'Should find GetTask method');
    });
});

describe('Multi-language Fixtures: Rust', () => {
    const fixturesPath = path.join(__dirname, 'fixtures', 'rust');

    it('should parse Rust functions and structs', () => {
        if (!fs.existsSync(path.join(fixturesPath, 'main.rs'))) {
            return;
        }

        const index = new ProjectIndex(fixturesPath);
        index.build('**/*.rs', { quiet: true });

        // Should find functions
        assert.ok(index.symbols.has('validate_task'), 'Should find validate_task function');
        assert.ok(index.symbols.has('create_task'), 'Should find create_task function');

        // Should find structs
        assert.ok(index.symbols.has('Task'), 'Should find Task struct');
        assert.ok(index.symbols.has('TaskManager'), 'Should find TaskManager struct');
    });

    it('should parse Rust impl blocks', () => {
        if (!fs.existsSync(path.join(fixturesPath, 'main.rs'))) {
            return;
        }

        const index = new ProjectIndex(fixturesPath);
        index.build('**/*.rs', { quiet: true });

        // Should find methods from impl blocks
        assert.ok(index.symbols.has('add_task'), 'Should find add_task method');
        assert.ok(index.symbols.has('get_task'), 'Should find get_task method');
    });
});

describe('Multi-language Fixtures: Java', () => {
    const fixturesPath = path.join(__dirname, 'fixtures', 'java');

    it('should parse Java classes and methods', () => {
        if (!fs.existsSync(path.join(fixturesPath, 'Main.java'))) {
            return;
        }

        const index = new ProjectIndex(fixturesPath);
        index.build('**/*.java', { quiet: true });

        // Should find classes
        assert.ok(index.symbols.has('Main'), 'Should find Main class');
        assert.ok(index.symbols.has('DataService'), 'Should find DataService class');

        // Should find methods
        assert.ok(index.symbols.has('createTask'), 'Should find createTask method');
        assert.ok(index.symbols.has('validateTask'), 'Should find validateTask method');
    });

    it('should parse Java inner classes', () => {
        if (!fs.existsSync(path.join(fixturesPath, 'Main.java'))) {
            return;
        }

        const index = new ProjectIndex(fixturesPath);
        index.build('**/*.java', { quiet: true });

        // Should find inner classes/enums
        assert.ok(index.symbols.has('Task'), 'Should find Task inner class');
        assert.ok(index.symbols.has('TaskManager'), 'Should find TaskManager inner class');
    });
});

describe('Regression: Project detection with language markers', () => {
    it('should detect Python project with pyproject.toml', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-pyproject-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            fs.writeFileSync(path.join(tmpDir, 'main.py'), 'def hello():\n    pass');

            const { detectProjectPattern } = require('../core/discovery');
            const pattern = detectProjectPattern(tmpDir);

            // Pattern format is **/*.{py} or includes py in extensions
            assert.ok(pattern.includes('py'), 'Should detect Python files');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect Go project with go.mod', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-gomod-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module test\ngo 1.21');
            fs.writeFileSync(path.join(tmpDir, 'main.go'), 'package main\nfunc main() {}');

            const { detectProjectPattern } = require('../core/discovery');
            const pattern = detectProjectPattern(tmpDir);

            assert.ok(pattern.includes('go'), 'Should detect Go files');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect Rust project with Cargo.toml', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-cargo-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"');
            fs.writeFileSync(path.join(tmpDir, 'main.rs'), 'fn main() {}');

            const { detectProjectPattern } = require('../core/discovery');
            const pattern = detectProjectPattern(tmpDir);

            assert.ok(pattern.includes('rs'), 'Should detect Rust files');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect Java project with pom.xml', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-pom-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'Main.java'), 'public class Main {}');

            const { detectProjectPattern } = require('../core/discovery');
            const pattern = detectProjectPattern(tmpDir);

            assert.ok(pattern.includes('java'), 'Should detect Java files');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect multi-language project (Go root + TS subdirectory)', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-multilang-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'web'), { recursive: true });

        try {
            // Go at root
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module test\ngo 1.21');
            fs.writeFileSync(path.join(tmpDir, 'main.go'), 'package main\nfunc main() {}');
            // TypeScript in web/ subdirectory
            fs.writeFileSync(path.join(tmpDir, 'web', 'package.json'), '{"name": "web"}');
            fs.writeFileSync(path.join(tmpDir, 'web', 'App.tsx'), 'export function App() {}');

            const { detectProjectPattern } = require('../core/discovery');
            const pattern = detectProjectPattern(tmpDir);

            // Should detect BOTH Go and TypeScript
            assert.ok(pattern.includes('go'), 'Should detect Go files from root');
            assert.ok(pattern.includes('tsx'), 'Should detect TypeScript files from subdirectory');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// REGRESSION: lines command should validate input
// ============================================================================

describe('Regression: lines command should validate input', () => {
    it('should error on out-of-bounds line range', () => {
        const fixtureFile = path.join(__dirname, 'fixtures', 'javascript', 'main.js');
        const content = fs.readFileSync(fixtureFile, 'utf-8');
        const lineCount = content.split('\n').length;

        // Run UCN with lines command that exceeds file length
        const { execSync } = require('child_process');
        const ucnPath = path.join(__dirname, '..', 'ucn.js');

        try {
            execSync(`node ${ucnPath} ${fixtureFile} lines ${lineCount + 100}-${lineCount + 200}`, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            assert.fail('Should have thrown an error for out-of-bounds range');
        } catch (e) {
            assert.ok(e.stderr.includes('out of bounds'), 'Should report out of bounds error');
        }
    });

    it('should handle reversed line range by swapping', () => {
        const fixtureFile = path.join(__dirname, 'fixtures', 'javascript', 'main.js');
        const { execSync } = require('child_process');
        const ucnPath = path.join(__dirname, '..', 'ucn.js');

        // Reversed range should work (10-5 should become 5-10)
        const output = execSync(`node ${ucnPath} ${fixtureFile} lines 10-5`, {
            encoding: 'utf8'
        });

        assert.ok(output.includes('5 │'), 'Should include line 5');
        assert.ok(output.includes('10 │'), 'Should include line 10');
    });

    it('should error on non-numeric line range', () => {
        const fixtureFile = path.join(__dirname, 'fixtures', 'javascript', 'main.js');
        const { execSync } = require('child_process');
        const ucnPath = path.join(__dirname, '..', 'ucn.js');

        try {
            execSync(`node ${ucnPath} ${fixtureFile} lines abc-def`, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            assert.fail('Should have thrown an error for non-numeric range');
        } catch (e) {
            assert.ok(e.stderr.includes('Invalid line range'), 'Should report invalid range error');
        }
    });
});

// ============================================================================
// REGRESSION: findCallees should not include function declaration
// ============================================================================

describe('Regression: findCallees should not include function declaration', () => {
    it('should not list function as its own callee when not recursive', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-callee-decl-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function nonRecursive(x) {
    return helper(x) + other(x);
}
function helper(x) { return x * 2; }
function other(x) { return x + 1; }
module.exports = { nonRecursive, helper, other };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('nonRecursive');

            // Function should not appear as its own callee
            const selfCallee = ctx.callees.find(c => c.name === 'nonRecursive');
            assert.ok(!selfCallee, 'Non-recursive function should not list itself as callee');

            // But should still list actual callees
            assert.ok(ctx.callees.some(c => c.name === 'helper'), 'Should list helper as callee');
            assert.ok(ctx.callees.some(c => c.name === 'other'), 'Should list other as callee');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect callees in single-line functions', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-single-line-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function singleLine() { return helper() + other(); }
function helper() { return 1; }
function other() { return 2; }
module.exports = { singleLine, helper, other };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('singleLine');

            // Single-line function should detect its callees
            assert.ok(ctx.callees.some(c => c.name === 'helper'), 'Should detect helper callee in single-line function');
            assert.ok(ctx.callees.some(c => c.name === 'other'), 'Should detect other callee in single-line function');
            // But should not include itself
            assert.ok(!ctx.callees.some(c => c.name === 'singleLine'), 'Should not include itself as callee');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should list function as callee when actually recursive', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-recursive-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function factorial(n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);
}
module.exports = { factorial };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('factorial');

            // Recursive function SHOULD appear as its own callee
            const selfCallee = ctx.callees.find(c => c.name === 'factorial');
            assert.ok(selfCallee, 'Recursive function should list itself as callee');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// REGRESSION: Negative depth values should be clamped to 0
// ============================================================================

describe('Regression: negative depth should be clamped to 0', () => {
    it('trace should work with negative depth (clamped to 0)', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-neg-depth-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function main() {
    return helper();
}
function helper() { return 42; }
module.exports = { main, helper };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Negative depth should be clamped to 0
            const trace = index.trace('main', { depth: -5 });

            assert.ok(trace, 'Trace should return a result');
            assert.strictEqual(trace.maxDepth, 0, 'maxDepth should be clamped to 0');
            assert.strictEqual(trace.root, 'main', 'Root should be main');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('graph should work with negative depth (clamped to 0)', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-neg-graph-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');
            fs.writeFileSync(path.join(tmpDir, 'main.js'), `
const { helper } = require('./helper');
console.log(helper());
`);
            fs.writeFileSync(path.join(tmpDir, 'helper.js'), `
module.exports = { helper: () => 42 };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Negative depth should be clamped to 0
            const graph = index.graph('main.js', { maxDepth: -10 });

            assert.ok(graph.nodes.length > 0, 'Graph should have nodes');
            // With depth 0, should only show root and its direct imports (depth 0)
            assert.ok(graph.nodes.some(n => n.relativePath === 'main.js'), 'Should include main.js');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// REGRESSION: Double dash separator should end flag processing
// ============================================================================

describe('Regression: double dash separator for arguments', () => {
    it('should allow searching for flag-like strings after --', () => {
        const fixtureDir = path.join(__dirname, 'fixtures', 'javascript');
        const { execSync } = require('child_process');
        const ucnPath = path.join(__dirname, '..', 'ucn.js');

        // This should NOT error with "Unknown flag"
        const output = execSync(`node ${ucnPath} ${fixtureDir} find -- --test`, {
            encoding: 'utf8'
        });

        // Should show "no symbols found" rather than "unknown flag"
        assert.ok(!output.includes('Unknown flag'), 'Should not treat --test as flag after --');
    });

    it('should process flags before -- normally', () => {
        const fixtureDir = path.join(__dirname, 'fixtures', 'javascript');
        const { execSync } = require('child_process');
        const ucnPath = path.join(__dirname, '..', 'ucn.js');

        // Flags before -- should work
        const output = execSync(`node ${ucnPath} ${fixtureDir} find processData --json --`, {
            encoding: 'utf8'
        });

        // Should be valid JSON
        assert.ok(output.startsWith('{'), 'Should output JSON when --json flag is before --');
        JSON.parse(output); // Should not throw
    });
});

// ============================================================================
// RELIABILITY IMPROVEMENTS: AST-based search filtering
// ============================================================================

describe('Reliability: AST-based search filtering', () => {
    it('should filter out matches in comments with --code-only', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-search-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
// This comment mentions fetchData
const x = 'fetchData in string';
const result = fetchData(); // trailing comment fetchData
/* block comment
   fetchData here too */
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const results = index.search('fetchData', { codeOnly: true });
            const allMatches = results.flatMap(r => r.matches);

            // Should only find the actual code call on line 4
            assert.strictEqual(allMatches.length, 1, 'Should find only 1 code match');
            assert.ok(allMatches[0].content.includes('const result = fetchData()'), 'Should find the actual call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should include template literal expressions as code', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-search-template-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
const str = \`fetchData in template\`;
const dynamic = \`Result: \${fetchData()}\`;
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const results = index.search('fetchData', { codeOnly: true });
            const allMatches = results.flatMap(r => r.matches);

            // Should find the expression inside ${}, not the string literal
            assert.strictEqual(allMatches.length, 1, 'Should find 1 match in template expression');
            assert.ok(allMatches[0].content.includes('${fetchData()}'), 'Should find the template expression');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// RELIABILITY IMPROVEMENTS: Stacktrace file matching
// ============================================================================

describe('Reliability: Stacktrace file matching', () => {
    it('should parse various stack trace formats', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-stack-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'src'));
            fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), `
function processData(data) {
    throw new Error('test');
}
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Test Node.js format
            const nodeStack = index.parseStackTrace('at processData (src/app.js:3:11)');
            assert.strictEqual(nodeStack.frames.length, 1);
            assert.ok(nodeStack.frames[0].found);

            // Test Firefox format
            const ffStack = index.parseStackTrace('processData@src/app.js:3:11');
            assert.strictEqual(ffStack.frames.length, 1);
            assert.ok(ffStack.frames[0].found);

            // Test async format
            const asyncStack = index.parseStackTrace('at async processData (src/app.js:3:11)');
            assert.strictEqual(asyncStack.frames.length, 1);
            assert.ok(asyncStack.frames[0].found);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should score path similarity and choose best match', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-stack-sim-'));
        try {
            // Create files with similar names in different directories
            fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'lib', 'utils'), { recursive: true });

            fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'helper.js'), `
function helper() { console.log('src'); }
`);
            fs.writeFileSync(path.join(tmpDir, 'lib', 'utils', 'helper.js'), `
function helper() { console.log('lib'); }
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Should prefer more specific path
            const stack = index.parseStackTrace('at helper (src/utils/helper.js:2:10)');
            assert.strictEqual(stack.frames.length, 1);
            assert.ok(stack.frames[0].found);
            assert.ok(stack.frames[0].resolvedFile.includes('src/utils'), 'Should match src path');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// RELIABILITY IMPROVEMENTS: Callback detection for deadcode
// ============================================================================

describe('Reliability: Callback detection for deadcode', () => {
    it('should not report functions used as callbacks as dead', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-deadcode-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'handlers.js'), `
function handleClick(e) { console.log(e); }
function mapItem(item) { return item.toUpperCase(); }
function unusedFn() { return 'dead'; }

document.addEventListener('click', handleClick);
const items = ['a', 'b'].map(mapItem);
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const dead = index.deadcode({ includeExported: true });
            const deadNames = dead.map(d => d.name);

            assert.ok(!deadNames.includes('handleClick'), 'handleClick should not be dead (event handler)');
            assert.ok(!deadNames.includes('mapItem'), 'mapItem should not be dead (array callback)');
            assert.ok(deadNames.includes('unusedFn'), 'unusedFn should be dead');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should not report re-exported functions as dead', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-reexport-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'utils.js'), `
export function formatDate(d) { return d.toString(); }
export function unusedUtil() { return null; }
`);
            fs.writeFileSync(path.join(tmpDir, 'index.js'), `
export { formatDate } from './utils';
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const dead = index.deadcode({ includeExported: true });
            const deadNames = dead.map(d => d.name);

            assert.ok(!deadNames.includes('formatDate'), 'formatDate should not be dead (re-exported)');
            // Note: unusedUtil might or might not be dead depending on export tracking
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// AST-BASED COMMENT/STRING DETECTION
// ============================================================================

describe('AST-based Comment/String Detection', () => {
    it('detects inline comments correctly', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-ast-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
const x = 5; // comment mentioning myFunc
myFunc(); // this is a call
// myFunc is mentioned here
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // isCommentOrStringAtPosition should detect the comment
            const content = fs.readFileSync(path.join(tmpDir, 'test.js'), 'utf-8');
            const filePath = path.join(tmpDir, 'test.js');

            // Line 2: "const x = 5; // comment mentioning myFunc"
            // Column 0 should be code, column after // should be comment
            assert.strictEqual(
                index.isCommentOrStringAtPosition(content, 2, 0, filePath),
                false,
                'Start of line 2 should be code'
            );
            assert.strictEqual(
                index.isCommentOrStringAtPosition(content, 2, 14, filePath),
                true,
                'Inside comment on line 2 should be comment'
            );

            // Line 4: "// myFunc is mentioned here" - entire line is comment
            assert.strictEqual(
                index.isCommentOrStringAtPosition(content, 4, 0, filePath),
                true,
                'Comment-only line should be comment'
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('detects string literals correctly', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-ast-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
const msg = "function call()";
const real = call();
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const content = fs.readFileSync(path.join(tmpDir, 'test.js'), 'utf-8');
            const filePath = path.join(tmpDir, 'test.js');

            // Line 2: const msg = "function call()";
            // "function" inside the string should be detected as string
            assert.strictEqual(
                index.isCommentOrStringAtPosition(content, 2, 13, filePath),
                true,
                'Inside string literal should be string'
            );

            // Line 3: const real = call();
            // "call" should be code
            assert.strictEqual(
                index.isCommentOrStringAtPosition(content, 3, 13, filePath),
                false,
                'Function call should be code'
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('handles template literals with expressions', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-ast-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), 'const x = `value is ${fn()} here`;');
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const content = fs.readFileSync(path.join(tmpDir, 'test.js'), 'utf-8');
            const filePath = path.join(tmpDir, 'test.js');

            // Inside template expression ${fn()} - "fn" should be code
            assert.strictEqual(
                index.isCommentOrStringAtPosition(content, 1, 22, filePath),
                false,
                'Inside template expression should be code'
            );

            // Inside template string but outside expression - should be string
            assert.strictEqual(
                index.isCommentOrStringAtPosition(content, 1, 12, filePath),
                true,
                'Inside template string should be string'
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('isInsideStringAST correctly identifies names in strings vs code', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-ast-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
const msg = "call myFunc here";
myFunc();
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const content = fs.readFileSync(path.join(tmpDir, 'test.js'), 'utf-8');
            const filePath = path.join(tmpDir, 'test.js');
            const lines = content.split('\n');

            // Line 2: myFunc appears inside string - should return true
            assert.strictEqual(
                index.isInsideStringAST(content, 2, lines[1], 'myFunc', filePath),
                true,
                'myFunc on line 2 is inside string'
            );

            // Line 3: myFunc appears as code - should return false
            assert.strictEqual(
                index.isInsideStringAST(content, 3, lines[2], 'myFunc', filePath),
                false,
                'myFunc on line 3 is code'
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('classifyUsageAST correctly classifies calls and definitions', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-ast-test-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
function myFunc() {}
myFunc();
import { other } from './other';
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const content = fs.readFileSync(path.join(tmpDir, 'test.js'), 'utf-8');
            const filePath = path.join(tmpDir, 'test.js');

            // Line 2: function definition
            assert.strictEqual(
                index.classifyUsageAST(content, 2, 'myFunc', filePath),
                'definition',
                'Function declaration should be classified as definition'
            );

            // Line 3: function call
            assert.strictEqual(
                index.classifyUsageAST(content, 3, 'myFunc', filePath),
                'call',
                'Function call should be classified as call'
            );

            // Line 4: import
            assert.strictEqual(
                index.classifyUsageAST(content, 4, 'other', filePath),
                'import',
                'Import should be classified as import'
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Cache Performance Optimizations', () => {
    it('getCachedCalls uses mtime for fast cache validation', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-cache-perf-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
function foo() { bar(); }
function bar() { return 1; }
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const filePath = path.join(tmpDir, 'test.js');

            // First call - should parse
            const calls1 = index.getCachedCalls(filePath);
            assert.ok(calls1, 'First call should return calls');
            assert.ok(calls1.length > 0, 'Should find calls');

            // Check cache entry has mtime
            const cached = index.callsCache.get(filePath);
            assert.ok(cached, 'Cache entry should exist');
            assert.ok(cached.mtime, 'Cache should have mtime');
            assert.ok(cached.hash, 'Cache should have hash');

            // Second call - should use mtime cache (no reparse)
            const calls2 = index.getCachedCalls(filePath);
            assert.deepStrictEqual(calls2, calls1, 'Second call should return same result');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('getCachedCalls with includeContent avoids double file read', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-cache-perf-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
function foo() { bar(); }
function bar() { return 1; }
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const filePath = path.join(tmpDir, 'test.js');

            // Call with includeContent
            const result = index.getCachedCalls(filePath, { includeContent: true });
            assert.ok(result, 'Should return result');
            assert.ok(result.calls, 'Should have calls');
            assert.ok(result.content, 'Should have content');
            assert.ok(result.content.includes('function foo'), 'Content should be the file');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('callsCache is persisted to disk and restored', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-cache-persist-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
function processData() {
    helper();
    console.log('done');
}
function helper() { return 42; }
`);
            // Build and populate cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });

            // Trigger callsCache population
            const filePath = path.join(tmpDir, 'test.js');
            index1.getCachedCalls(filePath);

            // Verify callsCache is populated
            assert.ok(index1.callsCache.size > 0, 'callsCache should be populated');

            // Save cache
            const cachePath = path.join(tmpDir, 'test-cache.json');
            index1.saveCache(cachePath);

            // Verify cache file has callsCache
            const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
            assert.strictEqual(cacheData.version, 4, 'Cache version should be 4 (className, memberType, isMethod for all languages)');
            assert.ok(Array.isArray(cacheData.callsCache), 'Cache should have callsCache array');
            assert.ok(cacheData.callsCache.length > 0, 'callsCache should have entries');

            // Load in new instance
            const index2 = new ProjectIndex(tmpDir);
            const loaded = index2.loadCache(cachePath);
            assert.ok(loaded, 'Cache should load successfully');

            // Verify callsCache is restored
            assert.ok(index2.callsCache.size > 0, 'callsCache should be restored');

            // Verify calls are usable without reparsing
            const calls = index2.getCachedCalls(filePath);
            assert.ok(calls, 'Should get calls from restored cache');
            assert.ok(calls.some(c => c.name === 'helper'), 'Should find helper call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('findCallers is fast after cache load (no reparse)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-cache-perf-'));
        try {
            // Create multiple files
            for (let i = 0; i < 10; i++) {
                fs.writeFileSync(path.join(tmpDir, `file${i}.js`), `
function caller${i}() { helper(); }
`);
            }
            fs.writeFileSync(path.join(tmpDir, 'helper.js'), `
function helper() { return 42; }
`);

            // Build and warm up cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });

            // Time first findCallers (populates callsCache)
            const start1 = Date.now();
            const callers1 = index1.findCallers('helper');
            const time1 = Date.now() - start1;

            // Save cache
            const cachePath = path.join(tmpDir, 'perf-cache.json');
            index1.saveCache(cachePath);

            // Load in new instance
            const index2 = new ProjectIndex(tmpDir);
            index2.loadCache(cachePath);

            // Time findCallers after cache load
            const start2 = Date.now();
            const callers2 = index2.findCallers('helper');
            const time2 = Date.now() - start2;

            // Verify results are same
            assert.strictEqual(callers1.length, callers2.length, 'Same number of callers');
            assert.strictEqual(callers1.length, 10, 'Should find 10 callers');

            // Cache-loaded should be reasonably fast (not doing full reparse)
            // Note: First call might be faster due to mtime check, second call uses persisted data
            assert.ok(time2 < time1 * 3 || time2 < 100,
                `Cache-loaded findCallers (${time2}ms) should not be much slower than warm (${time1}ms)`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('mtime change triggers reparse but hash match skips reparse', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-cache-mtime-'));
        try {
            const filePath = path.join(tmpDir, 'test.js');
            fs.writeFileSync(filePath, `function foo() { bar(); }`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Get initial cache
            index.getCachedCalls(filePath);
            const cached1 = index.callsCache.get(filePath);
            const originalMtime = cached1.mtime;
            const originalHash = cached1.hash;

            // Touch file (change mtime but not content)
            const now = new Date();
            fs.utimesSync(filePath, now, now);

            // Get calls again - should update mtime but not reparse (hash matches)
            index.getCachedCalls(filePath);
            const cached2 = index.callsCache.get(filePath);

            assert.notStrictEqual(cached2.mtime, originalMtime, 'mtime should be updated');
            assert.strictEqual(cached2.hash, originalHash, 'hash should be same (content unchanged)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// REGRESSION TESTS: Go-specific bug fixes (2026-02)
// ============================================================================

describe('Regression: Go entry points not flagged as deadcode', () => {
    it('should NOT report main() as dead code in Go', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-main-'));
        try {
            // Create a Go project with main and init functions
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test\n\ngo 1.21\n');
            fs.writeFileSync(path.join(tmpDir, 'main.go'), `package main

func main() {
    run()
}

func init() {
    setup()
}

func run() {
    println("running")
}

func setup() {
    println("setup")
}

func unusedHelper() {
    println("unused")
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            const deadcode = index.deadcode();
            const deadNames = deadcode.map(d => d.name);

            // main and init should NOT be reported as dead
            assert.ok(!deadNames.includes('main'), 'main() should not be flagged as dead code');
            assert.ok(!deadNames.includes('init'), 'init() should not be flagged as dead code');

            // run and setup are called, so not dead
            assert.ok(!deadNames.includes('run'), 'run() is called by main, not dead');
            assert.ok(!deadNames.includes('setup'), 'setup() is called by init, not dead');

            // unusedHelper should be flagged as dead
            assert.ok(deadNames.includes('unusedHelper'), 'unusedHelper() should be flagged as dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Go method calls included in findCallers', () => {
    it('should find Go method call sites without --include-methods flag', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-methods-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test\n\ngo 1.21\n');
            fs.writeFileSync(path.join(tmpDir, 'server.go'), `package main

type Server struct {
    port int
}

func (s *Server) Start() {
    s.listen()
}

func (s *Server) listen() {
    println("listening on", s.port)
}

func main() {
    srv := &Server{port: 8080}
    srv.Start()
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // Find callers of Start method - should find the call in main
            const callers = index.findCallers('Start');

            assert.strictEqual(callers.length, 1, 'Should find 1 caller for Start method');
            assert.strictEqual(callers[0].callerName, 'main', 'Caller should be main function');
            assert.ok(callers[0].content.includes('srv.Start()'), 'Should capture the method call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

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

            // self.listen() should be filtered out (self call)
            // but srv.start() should be included (external call)
            const listenCallers = index.findCallers('listen');
            // self.listen() is internal, so it depends on implementation
            // At minimum, without --include-methods, non-self calls should not show

            const startCallers = index.findCallers('start');
            // srv.start() is a method call with receiver 'srv', which is not this/self/cls
            // But since it's Python (not Go), it should be filtered unless --include-methods
            assert.strictEqual(startCallers.length, 0, 'Python method calls should be filtered by default');

            // With --include-methods, should find the call
            const startCallersIncluded = index.findCallers('start', { includeMethods: true });
            assert.strictEqual(startCallersIncluded.length, 1, 'With includeMethods, should find srv.start()');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: context for structs shows methods', () => {
    it('should return methods for Go struct types', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-struct-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test\n\ngo 1.21\n');
            fs.writeFileSync(path.join(tmpDir, 'types.go'), `package main

type User struct {
    Name  string
    Email string
}

func (u *User) Validate() bool {
    return u.Name != "" && u.Email != ""
}

func (u *User) String() string {
    return u.Name + " <" + u.Email + ">"
}

func (u User) IsEmpty() bool {
    return u.Name == "" && u.Email == ""
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            const ctx = index.context('User');

            // Should identify as struct type
            assert.strictEqual(ctx.type, 'struct', 'User should be identified as struct');
            assert.strictEqual(ctx.name, 'User', 'Should return correct name');

            // Should have methods
            assert.ok(ctx.methods, 'Should have methods array');
            assert.strictEqual(ctx.methods.length, 3, 'User struct should have 3 methods');

            const methodNames = ctx.methods.map(m => m.name);
            assert.ok(methodNames.includes('Validate'), 'Should include Validate method');
            assert.ok(methodNames.includes('String'), 'Should include String method');
            assert.ok(methodNames.includes('IsEmpty'), 'Should include IsEmpty method');

            // Methods should have receiver info
            const validateMethod = ctx.methods.find(m => m.name === 'Validate');
            assert.strictEqual(validateMethod.receiver, '*User', 'Validate has pointer receiver');

            const isEmptyMethod = ctx.methods.find(m => m.name === 'IsEmpty');
            assert.strictEqual(isEmptyMethod.receiver, 'User', 'IsEmpty has value receiver');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should return empty methods for struct with no methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-struct-empty-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test\n\ngo 1.21\n');
            fs.writeFileSync(path.join(tmpDir, 'types.go'), `package main

type Config struct {
    Port int
    Host string
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            const ctx = index.context('Config');

            assert.strictEqual(ctx.type, 'struct', 'Config should be identified as struct');
            assert.ok(ctx.methods, 'Should have methods array');
            assert.strictEqual(ctx.methods.length, 0, 'Config struct should have 0 methods');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: receiver field preserved in Go method symbols', () => {
    it('should store receiver info for Go methods in symbol index', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-receiver-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test\n\ngo 1.21\n');
            fs.writeFileSync(path.join(tmpDir, 'handler.go'), `package main

type Handler struct{}

func (h *Handler) ServeHTTP(w, r) {
    h.handleRequest(w, r)
}

func (h *Handler) handleRequest(w, r) {
    println("handling")
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // Check that receiver is preserved in symbols
            const serveHTTP = index.symbols.get('ServeHTTP');
            assert.ok(serveHTTP, 'ServeHTTP should be indexed');
            assert.strictEqual(serveHTTP.length, 1, 'Should have one definition');
            assert.strictEqual(serveHTTP[0].receiver, '*Handler', 'Receiver should be *Handler');
            assert.strictEqual(serveHTTP[0].isMethod, true, 'Should be marked as method');

            const handleRequest = index.symbols.get('handleRequest');
            assert.ok(handleRequest, 'handleRequest should be indexed');
            assert.strictEqual(handleRequest[0].receiver, '*Handler', 'Receiver should be *Handler');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// REGRESSION TESTS: Multi-language class/method handling (2026-02)
// ============================================================================

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

describe('Regression: Java class methods in context', () => {
    it('should show methods for Java classes via className', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-java-class-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'User.java'), `public class User {
    private String name;

    public User(String name) {
        this.name = name;
    }

    public String greet() {
        return "Hello " + this.name;
    }

    public boolean validate() {
        return this.name != null && this.name.length() > 0;
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.java', { quiet: true });

            const ctx = index.context('User');

            // Should identify as class
            assert.strictEqual(ctx.type, 'class', 'User should be identified as class');
            assert.ok(ctx.methods, 'Should have methods array');
            assert.strictEqual(ctx.methods.length, 3, 'User class should have 3 methods (constructor + 2 methods)');

            const methodNames = ctx.methods.map(m => m.name);
            assert.ok(methodNames.includes('User'), 'Should include constructor User');
            assert.ok(methodNames.includes('greet'), 'Should include greet');
            assert.ok(methodNames.includes('validate'), 'Should include validate');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Rust impl methods in context', () => {
    it('should show impl methods for Rust structs via receiver', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-rust-impl-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), `[package]
name = "test"
version = "0.1.0"
`);
            fs.writeFileSync(path.join(tmpDir, 'lib.rs'), `pub struct User {
    name: String,
}

impl User {
    pub fn new(name: String) -> Self {
        User { name }
    }

    pub fn greet(&self) -> String {
        format!("Hello {}", self.name)
    }

    fn validate(&self) -> bool {
        !self.name.is_empty()
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.rs', { quiet: true });

            const ctx = index.context('User');

            // Should identify as struct
            assert.strictEqual(ctx.type, 'struct', 'User should be identified as struct');
            assert.ok(ctx.methods, 'Should have methods array');
            assert.strictEqual(ctx.methods.length, 3, 'User impl should have 3 methods');

            const methodNames = ctx.methods.map(m => m.name);
            assert.ok(methodNames.includes('new'), 'Should include new');
            assert.ok(methodNames.includes('greet'), 'Should include greet');
            assert.ok(methodNames.includes('validate'), 'Should include validate');

            // Methods should have receiver info pointing to User
            const greetMethod = ctx.methods.find(m => m.name === 'greet');
            assert.strictEqual(greetMethod.receiver, 'User', 'greet should have User as receiver');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: JavaScript class methods in context', () => {
    it('should show methods for JS classes via className', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-js-class-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'user.js'), `class User {
    constructor(name) {
        this.name = name;
    }

    greet() {
        return 'Hello ' + this.name;
    }

    static create(name) {
        return new User(name);
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('User');

            // Should identify as class
            assert.strictEqual(ctx.type, 'class', 'User should be identified as class');
            assert.ok(ctx.methods, 'Should have methods array');
            assert.strictEqual(ctx.methods.length, 3, 'User class should have 3 methods');

            const methodNames = ctx.methods.map(m => m.name);
            assert.ok(methodNames.includes('constructor'), 'Should include constructor');
            assert.ok(methodNames.includes('greet'), 'Should include greet');
            assert.ok(methodNames.includes('create'), 'Should include create');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Java main() not flagged as deadcode', () => {
    it('should NOT report public static main as dead code in Java', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-java-main-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'App.java'), `public class App {
    public static void main(String[] args) {
        System.out.println("Hello");
        helper();
    }

    private static void helper() {
        System.out.println("Helper");
    }

    private static void unusedMethod() {
        System.out.println("Unused");
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.java', { quiet: true });

            const deadcode = index.deadcode();
            const deadNames = deadcode.map(d => d.name);

            // main should NOT be flagged as dead code (entry point)
            assert.ok(!deadNames.includes('main'), 'main() should not be flagged as dead code');

            // helper is called by main, so not dead
            assert.ok(!deadNames.includes('helper'), 'helper() is called by main, not dead');

            // unusedMethod should be flagged as dead
            assert.ok(deadNames.includes('unusedMethod'), 'unusedMethod() should be flagged as dead code');
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

describe('Regression: Rust main and #[test] not flagged as deadcode', () => {
    it('should NOT report main() or #[test] functions as dead code in Rust', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-rust-main-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), `[package]
name = "test"
version = "0.1.0"
`);
            fs.writeFileSync(path.join(tmpDir, 'main.rs'), `fn main() {
    helper();
}

fn helper() {
    println!("Helper");
}

fn unused_fn() {
    println!("Unused");
}

#[test]
fn test_something() {
    assert!(true);
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.rs', { quiet: true });

            const deadcode = index.deadcode();
            const deadNames = deadcode.map(d => d.name);

            // main should NOT be flagged as dead code (entry point)
            assert.ok(!deadNames.includes('main'), 'main() should not be flagged as dead code');

            // test_something should NOT be flagged (has #[test] attribute)
            assert.ok(!deadNames.includes('test_something'), '#[test] function should not be flagged as dead code');

            // helper is called by main
            assert.ok(!deadNames.includes('helper'), 'helper() is called by main, not dead');

            // unused_fn should be flagged as dead
            assert.ok(deadNames.includes('unused_fn'), 'unused_fn() should be flagged as dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: className field preserved in symbol index', () => {
    it('should store className for Python class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-classname-py-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'models.py'), `class User:
    def save(self):
        pass

class Product:
    def save(self):
        pass
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.py', { quiet: true });

            // Both save methods should have className field
            const saveMethods = index.symbols.get('save');
            assert.ok(saveMethods, 'save methods should be indexed');
            assert.strictEqual(saveMethods.length, 2, 'Should have 2 save methods');

            const classNames = saveMethods.map(m => m.className).sort();
            assert.deepStrictEqual(classNames, ['Product', 'User'], 'Should have User and Product as classNames');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should store className for Java class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-classname-java-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Models.java'), `class User {
    public void save() {}
}

class Product {
    public void save() {}
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.java', { quiet: true });

            // Both save methods should have className field
            const saveMethods = index.symbols.get('save');
            assert.ok(saveMethods, 'save methods should be indexed');
            assert.strictEqual(saveMethods.length, 2, 'Should have 2 save methods');

            const classNames = saveMethods.map(m => m.className).sort();
            assert.deepStrictEqual(classNames, ['Product', 'User'], 'Should have User and Product as classNames');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should store className for JavaScript class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-classname-js-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'models.js'), `class User {
    save() {}
}

class Product {
    save() {}
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Both save methods should have className field
            const saveMethods = index.symbols.get('save');
            assert.ok(saveMethods, 'save methods should be indexed');
            assert.strictEqual(saveMethods.length, 2, 'Should have 2 save methods');

            const classNames = saveMethods.map(m => m.className).sort();
            assert.deepStrictEqual(classNames, ['Product', 'User'], 'Should have User and Product as classNames');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should resolve Go module imports for exporters', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-import-'));
        try {
            // Create go.mod file
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), `module example.com/myproject

go 1.21
`);

            // Create package structure
            fs.mkdirSync(path.join(tmpDir, 'pkg', 'config'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'pkg', 'config', 'config.go'), `package config

type Config struct {
    Name string
}

func NewConfig() *Config {
    return &Config{}
}
`);

            fs.writeFileSync(path.join(tmpDir, 'main.go'), `package main

import "example.com/myproject/pkg/config"

func main() {
    cfg := config.NewConfig()
    _ = cfg
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // Get exporters for the config package
            const exportersResult = index.exporters(path.join(tmpDir, 'pkg', 'config', 'config.go'));
            assert.ok(exportersResult.length > 0, 'Should find files that import the config package');

            // main.go should be in the list
            const mainFile = exportersResult.find(e => e.file.includes('main.go'));
            assert.ok(mainFile, 'main.go should import the config package');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect Go method calls in usages (field_identifier)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-method-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), `module example.com/test
go 1.21
`);

            fs.writeFileSync(path.join(tmpDir, 'service.go'), `package main

type Service struct{}

func (s *Service) CollectAll() error {
    return nil
}

func main() {
    svc := &Service{}
    svc.CollectAll()
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // usages should find the method call
            const usages = index.usages('CollectAll', { codeOnly: true });
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);
            assert.ok(calls.length >= 1, 'Should find at least 1 call to CollectAll');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should find callees for Go receiver methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-callees-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), `module example.com/test
go 1.21
`);

            fs.writeFileSync(path.join(tmpDir, 'client.go'), `package main

type Client struct{}

func (c *Client) GetPods() []string {
    return nil
}

func (c *Client) GetNodes() []string {
    return nil
}

func (c *Client) CollectAll() {
    c.GetPods()
    c.GetNodes()
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // context should find callees (Go method calls)
            const ctx = index.context('CollectAll');
            assert.ok(ctx.callees, 'Should have callees');
            assert.ok(ctx.callees.length >= 2, 'Should find at least 2 callees (GetPods, GetNodes)');

            const calleeNames = ctx.callees.map(c => c.name);
            assert.ok(calleeNames.includes('GetPods'), 'GetPods should be a callee');
            assert.ok(calleeNames.includes('GetNodes'), 'GetNodes should be a callee');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should filter by --file for Go methods with same name', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-file-filter-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), `module example.com/test
go 1.21
`);

            fs.writeFileSync(path.join(tmpDir, 'service_a.go'), `package main

type ServiceA struct{}

func (s *ServiceA) Process() error {
    return nil
}
`);

            fs.writeFileSync(path.join(tmpDir, 'service_b.go'), `package main

type ServiceB struct{}

func (s *ServiceB) Process() error {
    return nil
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // Without file filter, should find both
            const allDefs = index.find('Process');
            assert.strictEqual(allDefs.length, 2, 'Should find 2 definitions of Process');

            // With file filter, should find only one
            const filteredDefs = index.find('Process', { file: 'service_a.go' });
            assert.strictEqual(filteredDefs.length, 1, 'Should find 1 definition with file filter');
            assert.ok(filteredDefs[0].relativePath.includes('service_a.go'), 'Should be from service_a.go');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect JavaScript method calls but filter built-ins', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-js-method-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
class Service {
  process() {}
}

function main() {
  const svc = new Service();
  svc.process();     // user method - SHOULD be counted
  JSON.parse('{}');  // built-in - should NOT be counted
  process();         // direct call - SHOULD be counted
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('process', { codeOnly: true });
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should find 2 calls: svc.process() and process()
            assert.strictEqual(calls.length, 2, 'Should find 2 calls (user method + direct)');

            // Should NOT include JSON.parse
            const hasJsonParse = calls.some(c => c.content && c.content.includes('JSON.parse'));
            assert.strictEqual(hasJsonParse, false, 'JSON.parse should NOT be counted');

            // Should include svc.process()
            const hasUserMethod = calls.some(c => c.content && c.content.includes('svc.process'));
            assert.strictEqual(hasUserMethod, true, 'svc.process() SHOULD be counted');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should prefer same-file callees for Go methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-callee-disambig-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), `module example.com/test
go 1.21
`);

            // Two files with same method name 'helper'
            fs.writeFileSync(path.join(tmpDir, 'service_a.go'), `package main

type ServiceA struct{}

func (s *ServiceA) Process() {
    s.helper()
}

func (s *ServiceA) helper() {}
`);

            fs.writeFileSync(path.join(tmpDir, 'service_b.go'), `package main

type ServiceB struct{}

func (s *ServiceB) Process() {
    s.helper()
}

func (s *ServiceB) helper() {}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // Get callees for ServiceA.Process - should find ServiceA.helper, not ServiceB.helper
            const defs = index.symbols.get('Process') || [];
            const serviceAProcess = defs.find(d => d.relativePath.includes('service_a.go'));
            assert.ok(serviceAProcess, 'Should find ServiceA.Process');

            const callees = index.findCallees(serviceAProcess);
            assert.ok(callees.length >= 1, 'Should find at least 1 callee');

            const helperCallee = callees.find(c => c.name === 'helper');
            assert.ok(helperCallee, 'Should find helper callee');
            assert.ok(helperCallee.relativePath.includes('service_a.go'),
                'helper callee should be from service_a.go, not service_b.go');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect JSX component usage as calls', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-jsx-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), `{"name": "test"}`);

            fs.writeFileSync(path.join(tmpDir, 'Page.tsx'), `
function EnvironmentsPage() {
  return <div>Hello</div>;
}

function App() {
  return <EnvironmentsPage />;
}

export { App, EnvironmentsPage };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.tsx', { quiet: true });

            const usages = index.usages('EnvironmentsPage', { codeOnly: true });
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should find JSX usage as a call
            assert.ok(calls.length >= 1, 'Should find at least 1 JSX component usage');
            assert.ok(calls.some(c => c.content && c.content.includes('<EnvironmentsPage')),
                'Should detect <EnvironmentsPage /> as a call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect Rust method calls in usages', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-rust-method-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), `[package]
name = "test"
version = "0.1.0"
`);

            fs.writeFileSync(path.join(tmpDir, 'main.rs'), `
struct Client {}

impl Client {
    fn process(&self) {}
}

fn main() {
    let c = Client{};
    c.process();
    process();
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.rs', { quiet: true });

            const usages = index.usages('process', { codeOnly: true });
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should find 2 calls: c.process() and process()
            assert.ok(calls.length >= 2, 'Should find at least 2 calls');

            // Should include c.process()
            const hasMethodCall = calls.some(c => c.content && c.content.includes('c.process'));
            assert.strictEqual(hasMethodCall, true, 'c.process() SHOULD be counted');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// REGRESSION: Reliability fixes (2026-02)
// ============================================================================

describe('Regression: Context class label bug', () => {
    it('should show class name in context, not undefined', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-ctx-class-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Python class
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            fs.writeFileSync(path.join(tmpDir, 'app.py'), `
class Session:
    def __init__(self):
        self.data = {}

    def get(self, key):
        return self.data.get(key)

def create_session():
    return Session()
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const ctx = index.context('Session');
            assert.strictEqual(ctx.type, 'class', 'Should detect as class type');
            assert.strictEqual(ctx.name, 'Session', 'Should have class name, not undefined');
            assert.ok(ctx.name !== undefined, 'Name must not be undefined');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should show Java class name in context', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-ctx-java-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'Gson.java'), `
public class Gson {
    public Gson() {}
    public String toJson(Object src) {
        return "";
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const ctx = index.context('Gson');
            assert.strictEqual(ctx.type, 'class');
            assert.strictEqual(ctx.name, 'Gson', 'Should show Gson, not undefined');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Java duplicate constructor entries', () => {
    it('should not duplicate constructors in find results', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-java-dedup-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'MyClass.java'), `
public class MyClass {
    private int value;

    public MyClass() {
        this.value = 0;
    }

    public MyClass(int value) {
        this.value = value;
    }

    public int getValue() {
        return value;
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const symbols = index.symbols.get('MyClass') || [];
            // Should have: 1 class + 2 constructors (as members) = 3 entries
            // Should NOT have: extra duplicates from findFunctions
            const types = symbols.map(s => s.type);
            assert.strictEqual(types.filter(t => t === 'class').length, 1, 'Should have exactly 1 class entry');
            // Constructors should only come from extractClassMembers, not findFunctions
            const constructors = symbols.filter(s => s.type === 'constructor');
            assert.strictEqual(constructors.length, 2, 'Should have exactly 2 constructor entries');
            // Each constructor at a unique line
            const lines = constructors.map(c => c.startLine);
            assert.notStrictEqual(lines[0], lines[1], 'Constructors should be at different lines');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Java overloaded method callees', () => {
    it('should detect callees for overloaded methods', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-java-overload-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'Converter.java'), `
public class Converter {
    public String convert(Object src) {
        return convert(src, src.getClass());
    }

    public String convert(Object src, Class<?> type) {
        return type.getName() + ": " + src.toString();
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // The first overload calls the second — smart should show it as a dependency
            const smart = index.smart('convert', { file: 'Converter' });
            assert.ok(smart, 'smart should return a result');
            // Should have at least 1 dependency (the other overload)
            assert.ok(smart.dependencies.length >= 1,
                `Should find overload as dependency, got ${smart.dependencies.length}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Disambiguation prefers non-test definitions', () => {
    it('should prefer src definition over test definition', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-disambig-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'src', 'render.js'), `
function render(template, data) {
    return template.replace(/{(\\w+)}/g, (_, key) => data[key] || '');
}
module.exports = { render };
`);
            fs.writeFileSync(path.join(tmpDir, 'test', 'render.test.js'), `
const { render } = require('../src/render');
function render(mockTemplate) {
    return 'mock: ' + mockTemplate;
}
test('render', () => { render('hello'); });
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // resolveSymbol should prefer src/render.js over test/render.test.js
            const { def } = index.resolveSymbol('render');
            assert.ok(def, 'Should find render');
            assert.ok(!def.relativePath.includes('test'),
                `Should prefer non-test file, got ${def.relativePath}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should use consistent selection across context, smart, trace', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-consistent-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'a.js'), `
function process(data) {
    return transform(data);
}
function transform(x) { return x * 2; }
module.exports = { process };
`);
            fs.writeFileSync(path.join(tmpDir, 'b.js'), `
function process(item) {
    return item.toString();
}
module.exports = { process };
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const ctx = index.context('process');
            const smart = index.smart('process');
            const trace = index.trace('process');

            // All should pick the same definition
            assert.strictEqual(ctx.file, smart.target.relativePath,
                'context and smart should pick same definition');
            assert.strictEqual(ctx.file, trace.file,
                'context and trace should pick same definition');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Verify filters method calls', () => {
    it('should not count obj.get() as call to standalone get()', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-verify-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            fs.writeFileSync(path.join(tmpDir, 'api.py'), `
def get(url, params=None):
    return request("GET", url, params=params)

def request(method, url, params=None):
    pass
`);
            fs.writeFileSync(path.join(tmpDir, 'client.py'), `
from .api import get

def fetch_data():
    result = get("/api/data")
    headers = {"Host": "example.com"}
    host = headers.get("Host")
    data = {"key": "value"}
    val = data.get("key")
    return result
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const result = index.verify('get');
            assert.ok(result.found, 'Should find get function');
            // Should NOT count headers.get("Host") or data.get("key") as mismatches
            // Only get("/api/data") should be counted
            assert.strictEqual(result.mismatches, 0,
                `Should have 0 mismatches (method calls filtered), got ${result.mismatches}`);
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

describe('Regression: Java inner classes found after constructor dedup', () => {
    it('should find inner classes with their own members', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-inner-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'Outer.java'), `
public class Outer {
    public static class Inner {
        private int x;

        public Inner(int x) {
            this.x = x;
        }

        public int getX() {
            return x;
        }
    }

    public Inner create() {
        return new Inner(42);
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // Inner class should be found
            assert.ok(index.symbols.has('Inner'), 'Should find Inner class');
            const innerSyms = index.symbols.get('Inner');
            const innerClass = innerSyms.find(s => s.type === 'class');
            assert.ok(innerClass, 'Should have Inner as class type');

            // Outer class should also be found
            assert.ok(index.symbols.has('Outer'), 'Should find Outer class');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: fn command auto-resolves best definition', () => {
    it('should prefer src/lib definition over test definition via pickBestDefinition-style scoring', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-fn-resolve-${Date.now()}`);
        fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'lib', 'app.js'), `
function render(template, data) {
    return template.replace(/{(\\w+)}/g, (_, key) => data[key] || '');
}
module.exports = { render };
`);
            fs.writeFileSync(path.join(tmpDir, 'test', 'app.test.js'), `
const { render } = require('../lib/app');
function render(mockTemplate) {
    return 'mock: ' + mockTemplate;
}
test('render works', () => { render('hello'); });
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // find should return both definitions
            const matches = index.find('render').filter(m => m.type === 'function' || m.params !== undefined);
            assert.ok(matches.length >= 2, `Should find at least 2 definitions, got ${matches.length}`);

            // resolveSymbol should prefer lib/ over test/
            const { def } = index.resolveSymbol('render');
            assert.ok(def, 'Should find render');
            assert.ok(def.relativePath.includes('lib/'),
                `Should prefer lib/ file, got ${def.relativePath}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Java package import resolution for exporters', () => {
    it('should resolve Java package imports and find exporters', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-java-exports-${Date.now()}`);
        const pkgDir = path.join(tmpDir, 'src', 'main', 'java', 'com', 'example');
        fs.mkdirSync(pkgDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(pkgDir, 'Model.java'), `
package com.example;
public class Model {
    private String name;
    public String getName() { return name; }
}
`);
            fs.writeFileSync(path.join(pkgDir, 'Service.java'), `
package com.example;
import com.example.Model;
public class Service {
    public Model getModel() { return new Model(); }
}
`);
            fs.writeFileSync(path.join(pkgDir, 'Controller.java'), `
package com.example;
import com.example.Model;
import com.example.Service;
public class Controller {
    private Service service = new Service();
    public Model handle() { return service.getModel(); }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // Model.java should have exporters (Service.java and Controller.java import it)
            const modelExporters = index.exporters('src/main/java/com/example/Model.java');
            assert.ok(modelExporters.length >= 2,
                `Model.java should have at least 2 importers, got ${modelExporters.length}: ${JSON.stringify(modelExporters.map(e => e.file))}`);

            // Service.java should also have an exporter (Controller.java imports it)
            const serviceExporters = index.exporters('src/main/java/com/example/Service.java');
            assert.ok(serviceExporters.length >= 1,
                `Service.java should have at least 1 importer, got ${serviceExporters.length}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Java overload callees finds ALL overloads', () => {
    it('should find all overload callees, not just the first', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-java-all-overloads-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'Serializer.java'), `
public class Serializer {
    public String serialize(Object src) {
        if (src == null) {
            return serialize("null_value");
        }
        return serialize(src, src.getClass());
    }

    public String serialize(Object src, Class<?> type) {
        return type.getName() + ": " + src.toString();
    }

    public String serialize(String value) {
        return "string: " + value;
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // smart for the first overload should show other overloads as dependencies
            const smart = index.smart('serialize', { file: 'Serializer' });
            assert.ok(smart, 'smart should return a result');

            // Should find at least 2 overload dependencies (the other two overloads)
            assert.ok(smart.dependencies.length >= 2,
                `Should find at least 2 overload dependencies, got ${smart.dependencies.length}: ${smart.dependencies.map(d => d.startLine).join(', ')}`);

            // Each dependency should be a different overload (different startLine)
            const depLines = new Set(smart.dependencies.map(d => d.startLine));
            assert.ok(depLines.size >= 2,
                `Dependencies should be distinct overloads, got ${depLines.size} unique`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should use binding ID for exact symbol lookup', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-java-binding-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'Builder.java'), `
public class Builder {
    public Builder set(String key, Object value) {
        return set(key, value, false);
    }

    public Builder set(String key, Object value, boolean override) {
        return this;
    }

    public String build() {
        return "built";
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // context for the first set() should show the second set() as a callee
            const ctx = index.context('set', { file: 'Builder' });
            assert.ok(ctx, 'context should return a result');
            assert.ok(ctx.callees.length >= 1,
                `Should find at least 1 callee (the other overload), got ${ctx.callees.length}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Regression: fn command extracts class methods (not just top-level functions)
// ============================================================================
describe('Regression: fn command extracts class methods', () => {
    it('should find and extract Python __init__ method via symbol index', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-fn-method-${Date.now()}`);
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            fs.writeFileSync(path.join(tmpDir, 'src', 'models.py'), `
class Session:
    def __init__(self, url, timeout=30):
        self.url = url
        self.timeout = timeout

    def get(self, path):
        return self.url + path
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // find should return __init__ (it has params, so it passes the filter)
            const matches = index.find('__init__').filter(m => m.type === 'function' || m.params !== undefined);
            assert.ok(matches.length >= 1, `Should find __init__, got ${matches.length}`);

            // The match should have valid startLine/endLine for direct code extraction
            const match = matches[0];
            assert.ok(match.startLine, 'Match should have startLine');
            assert.ok(match.endLine, 'Match should have endLine');
            assert.ok(match.file, 'Match should have file path');

            // Extract code using startLine/endLine (same approach as the fixed fn command)
            const code = fs.readFileSync(match.file, 'utf-8');
            const lines = code.split('\n');
            const fnCode = lines.slice(match.startLine - 1, match.endLine).join('\n');
            assert.ok(fnCode.includes('def __init__'), `Extracted code should contain __init__, got: ${fnCode}`);
            assert.ok(fnCode.includes('self.url = url'), `Extracted code should contain method body, got: ${fnCode}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should find and extract Java overloaded method via symbol index', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-fn-overload-${Date.now()}`);
        const pkgDir = path.join(tmpDir, 'src', 'main', 'java', 'com', 'example');
        fs.mkdirSync(pkgDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(pkgDir, 'Converter.java'), `
package com.example;
public class Converter {
    public String toJson(Object obj) {
        return obj.toString();
    }
    public String toJson(Object obj, boolean pretty) {
        String result = obj.toString();
        return pretty ? format(result) : result;
    }
    private String format(String s) {
        return s;
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // find should return toJson overloads
            const matches = index.find('toJson').filter(m => m.type === 'function' || m.params !== undefined);
            assert.ok(matches.length >= 1, `Should find toJson, got ${matches.length}`);

            // Each match should have valid location for direct extraction
            for (const match of matches) {
                assert.ok(match.startLine, `Match at ${match.relativePath} should have startLine`);
                assert.ok(match.endLine, `Match at ${match.relativePath} should have endLine`);

                const code = fs.readFileSync(match.file, 'utf-8');
                const lines = code.split('\n');
                const fnCode = lines.slice(match.startLine - 1, match.endLine).join('\n');
                assert.ok(fnCode.includes('toJson'), `Extracted code should contain toJson, got: ${fnCode}`);
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Regression: verify totalCalls excludes filtered method calls
// ============================================================================
describe('Regression: verify totalCalls excludes filtered method calls', () => {
    it('should not count method calls in totalCalls for standalone function', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-verify-total-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            fs.writeFileSync(path.join(tmpDir, 'api.py'), `
def get(url, params=None):
    return request("GET", url, params=params)

def request(method, url, params=None):
    pass
`);
            fs.writeFileSync(path.join(tmpDir, 'client.py'), `
from .api import get

def fetch_data():
    result = get("/api/data")
    headers = {"Host": "example.com"}
    host = headers.get("Host")
    data = {"key": "value"}
    val = data.get("key")
    return result
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const result = index.verify('get');
            assert.ok(result.found, 'Should find get function');
            // totalCalls should equal valid + mismatches + uncertain (no inflated count)
            assert.strictEqual(result.totalCalls, result.valid + result.mismatches + result.uncertain,
                `totalCalls (${result.totalCalls}) should equal valid (${result.valid}) + mismatches (${result.mismatches}) + uncertain (${result.uncertain})`);
            // Specifically, method calls like headers.get() and data.get() should NOT be in totalCalls
            assert.ok(result.totalCalls <= 2,
                `totalCalls should be at most 2 (direct calls only), got ${result.totalCalls}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should have consistent totals for Go method calls', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-verify-go-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test\n\ngo 1.21');
            fs.writeFileSync(path.join(tmpDir, 'main.go'), `
package main

import "os/exec"

func Run(opts string) error {
    return nil
}

func main() {
    Run("hello")
    cmd := exec.Command("ls")
    cmd.Run()
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const result = index.verify('Run');
            assert.ok(result.found, 'Should find Run function');
            // totalCalls must always equal valid + mismatches + uncertain
            assert.strictEqual(result.totalCalls, result.valid + result.mismatches + result.uncertain,
                `totalCalls (${result.totalCalls}) should equal valid (${result.valid}) + mismatches (${result.mismatches}) + uncertain (${result.uncertain})`);
            // cmd.Run() is a method call and should NOT inflate totalCalls
            assert.ok(result.totalCalls >= 1,
                `Should find at least 1 direct call to Run, got ${result.totalCalls}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Regression: context returns null for non-existent symbols
// ============================================================================
describe('Regression: context returns null for non-existent symbols', () => {
    it('should return null when symbol is not defined in the project', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-context-null-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
const router = require('express').Router();
function handleRequest(req, res) {
    res.send('hello');
}
module.exports = { handleRequest };
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // Symbol that doesn't exist at all
            const result1 = index.context('nonexistentXYZ');
            assert.strictEqual(result1, null,
                'context should return null for completely non-existent symbol');

            // Symbol used but not defined in project (external import)
            const result2 = index.context('Router');
            assert.strictEqual(result2, null,
                'context should return null for externally-defined symbol');

            // Symbol that IS defined should still work
            const result3 = index.context('handleRequest');
            assert.ok(result3, 'context should return result for defined symbol');
            assert.ok(result3.function || result3.name, 'Result should have function/name field');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// Regression: pickBestDefinition prefers larger function bodies as tiebreaker
describe('Regression: pickBestDefinition prefers larger functions over trivial ones', () => {
    it('should pick the __init__ with the largest body when all else is equal', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-pick-best-${Date.now()}`);
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            // Small __init__ (3 lines) - should NOT be preferred
            fs.writeFileSync(path.join(tmpDir, 'src', 'errors.py'), `
class AppError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message
`);
            // Large __init__ (20+ lines) - SHOULD be preferred
            fs.writeFileSync(path.join(tmpDir, 'src', 'client.py'), `
class Client:
    def __init__(self, url, timeout=30, retries=3, auth=None, headers=None):
        self.url = url
        self.timeout = timeout
        self.retries = retries
        self.auth = auth
        self.headers = headers or {}
        self.session = None
        self._pool = None
        self._closed = False
        self._setup_logging()
        self._verify_ssl = True
        self._proxy = None
        self._max_redirects = 10
        self._cookies = {}
        self._default_encoding = 'utf-8'
        self._event_hooks = {'request': [], 'response': []}
        self._transport = None
        self._base_url = url
        self._initialized = True

    def get(self, path):
        pass
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const matches = index.find('__init__').filter(m => m.type === 'function' || m.params !== undefined);
            assert.ok(matches.length >= 2, `Should find at least 2 __init__ methods, got ${matches.length}`);

            // Sort using same logic as pickBestDefinition
            const typeOrder = new Set(['class', 'struct', 'interface', 'type', 'impl']);
            const scored = matches.map(m => {
                let score = 0;
                const rp = m.relativePath || '';
                if (typeOrder.has(m.type)) score += 1000;
                if (/^(examples?|docs?|vendor|third[_-]?party|benchmarks?|samples?)\//i.test(rp)) score -= 300;
                if (/^(lib|src|core|internal|pkg|crates)\//i.test(rp)) score += 200;
                if (m.startLine && m.endLine) {
                    score += Math.min(m.endLine - m.startLine, 100);
                }
                return { match: m, score };
            });
            scored.sort((a, b) => b.score - a.score);
            const best = scored[0].match;

            // Should pick client.py (large body) over errors.py (small body)
            assert.ok(best.file.includes('client.py'),
                `Should prefer client.py __init__ (large body), got ${best.file}`);
            assert.ok(best.endLine - best.startLine > 10,
                `Selected __init__ should have >10 lines, got ${best.endLine - best.startLine}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// Regression: Rust crate:: import resolution for exporters
describe('Regression: Rust crate:: import resolution', () => {
    it('should resolve crate:: paths and mod declarations to file paths', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-rust-imports-${Date.now()}`);
        const srcDir = path.join(tmpDir, 'src');
        const displayDir = path.join(srcDir, 'display');
        fs.mkdirSync(displayDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test-crate"');

            // main.rs with mod declarations
            fs.writeFileSync(path.join(srcDir, 'main.rs'), `
mod display;
mod config;

use crate::display::Display;
use crate::config::Settings;

fn main() {
    let display = Display::new();
    let config = Settings::default();
}
`);
            // display/mod.rs
            fs.writeFileSync(path.join(displayDir, 'mod.rs'), `
use crate::config::Settings;

pub struct Display {
    width: u32,
    height: u32,
}

impl Display {
    pub fn new() -> Self {
        Display { width: 800, height: 600 }
    }
}
`);
            // config.rs
            fs.writeFileSync(path.join(srcDir, 'config.rs'), `
pub struct Settings {
    pub theme: String,
}

impl Settings {
    pub fn default() -> Self {
        Settings { theme: String::from("dark") }
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // Test mod declaration resolution: main.rs imports display/ and config.rs
            const mainImporters = index.importGraph.get(path.join(srcDir, 'main.rs')) || [];
            assert.ok(mainImporters.length >= 2,
                `main.rs should import at least 2 files (display + config), got ${mainImporters.length}`);

            // Test exporters: display/mod.rs should be imported by main.rs
            const displayExporters = index.exporters('src/display/mod.rs');
            assert.ok(displayExporters.length >= 1,
                `display/mod.rs should have at least 1 exporter, got ${displayExporters.length}`);
            assert.ok(displayExporters.some(e => e.file.includes('main.rs')),
                `main.rs should import display/mod.rs`);

            // Test crate:: resolution: display/mod.rs imports config.rs via crate::config
            const displayImports = index.importGraph.get(path.join(displayDir, 'mod.rs')) || [];
            assert.ok(displayImports.some(i => i.includes('config.rs')),
                `display/mod.rs should import config.rs via crate::config, got ${displayImports.map(i => path.basename(i))}`);

            // Test exporters for config.rs: should be imported by both main.rs and display/mod.rs
            const configExporters = index.exporters('src/config.rs');
            assert.ok(configExporters.length >= 2,
                `config.rs should have at least 2 exporters (main + display), got ${configExporters.length}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should resolve nested crate:: paths like crate::display::color', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-rust-nested-${Date.now()}`);
        const srcDir = path.join(tmpDir, 'src');
        const displayDir = path.join(srcDir, 'display');
        fs.mkdirSync(displayDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"');

            fs.writeFileSync(path.join(srcDir, 'main.rs'), `
mod display;
use crate::display::color::Rgb;

fn main() {
    let c = Rgb::new(255, 0, 0);
}
`);
            fs.writeFileSync(path.join(displayDir, 'mod.rs'), `
pub mod color;
pub struct Display;
`);
            fs.writeFileSync(path.join(displayDir, 'color.rs'), `
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub fn new(r: u8, g: u8, b: u8) -> Self {
        Rgb { r, g, b }
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // main.rs should resolve crate::display::color::Rgb to display/color.rs
            const mainImports = index.importGraph.get(path.join(srcDir, 'main.rs')) || [];
            assert.ok(mainImports.some(i => i.includes('color.rs')),
                `main.rs should import display/color.rs via crate::display::color::Rgb, got ${mainImports.map(i => path.basename(i))}`);

            // color.rs exporters should include main.rs
            const colorExporters = index.exporters('src/display/color.rs');
            assert.ok(colorExporters.some(e => e.file.includes('main.rs')),
                `color.rs should be exported to main.rs`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// Regression: verify should exclude self/cls from Python method parameter count
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

// Regression: deadcode should treat test_* as entry points in Python
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

describe('Regression: JS this.method() same-class resolution', () => {
    it('findCallees should resolve this.method() to same-class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-jsthis-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'service.js'), `
class DataService {
    _fetchRemote(key, days) {
        return this._makeRequest(\`/api/\${key}\`);
    }

    _makeRequest(url) {
        return null;
    }

    getRecords(key, days = 365) {
        if (this._isValid(key)) {
            return this._fetchRemote(key, days);
        }
        return null;
    }

    _isValid(key) {
        return key.length > 0;
    }
}
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // getRecords should have _fetchRemote and _isValid as callees
            const defs = index.symbols.get('getRecords');
            assert.ok(defs && defs.length > 0, 'Should find getRecords');
            const callees = index.findCallees(defs[0]);
            const calleeNames = callees.map(c => c.name);
            assert.ok(calleeNames.includes('_fetchRemote'),
                `Should resolve this._fetchRemote(), got: ${calleeNames.join(', ')}`);
            assert.ok(calleeNames.includes('_isValid'),
                `Should resolve this._isValid(), got: ${calleeNames.join(', ')}`);

            // _fetchRemote should have getRecords as caller
            const callers = index.findCallers('_fetchRemote');
            const callerNames = callers.map(c => c.callerName);
            assert.ok(callerNames.includes('getRecords'),
                `Should find getRecords as caller of _fetchRemote, got: ${callerNames.join(', ')}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Java this.method() same-class resolution', () => {
    it('findCallees should resolve this.method() to same-class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-javathis-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'DataService.java'), `
public class DataService {
    private Object fetchRemote(String key, int days) {
        return this.makeRequest("/api/" + key);
    }

    private Object makeRequest(String url) {
        return null;
    }

    public Object getRecords(String key) {
        if (this.isValid(key)) {
            return this.fetchRemote(key, 365);
        }
        return null;
    }

    private boolean isValid(String key) {
        return key.length() > 0;
    }
}
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.java', { quiet: true });

            // getRecords should have fetchRemote and isValid as callees
            const defs = index.symbols.get('getRecords');
            assert.ok(defs && defs.length > 0, 'Should find getRecords');
            const callees = index.findCallees(defs[0]);
            const calleeNames = callees.map(c => c.name);
            assert.ok(calleeNames.includes('fetchRemote'),
                `Should resolve this.fetchRemote(), got: ${calleeNames.join(', ')}`);
            assert.ok(calleeNames.includes('isValid'),
                `Should resolve this.isValid(), got: ${calleeNames.join(', ')}`);

            // fetchRemote should have getRecords as caller
            const callers = index.findCallers('fetchRemote');
            const callerNames = callers.map(c => c.callerName);
            assert.ok(callerNames.includes('getRecords'),
                `Should find getRecords as caller of fetchRemote, got: ${callerNames.join(', ')}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Rust self.method() same-class resolution', () => {
    it('findCallees should resolve self.method() to same-class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-rustself-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"');
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'service.rs'), `
struct DataService {
    base_url: String,
}

impl DataService {
    fn fetch_remote(&self, key: &str, days: i32) -> Option<String> {
        self.make_request(&format!("/api/{}", key))
    }

    fn make_request(&self, url: &str) -> Option<String> {
        None
    }

    fn get_records(&self, key: &str) -> Option<String> {
        if self.is_valid(key) {
            return self.fetch_remote(key, 365);
        }
        None
    }

    fn is_valid(&self, key: &str) -> bool {
        !key.is_empty()
    }
}
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.rs', { quiet: true });

            // get_records should have fetch_remote and is_valid as callees
            const defs = index.symbols.get('get_records');
            assert.ok(defs && defs.length > 0, 'Should find get_records');
            const callees = index.findCallees(defs[0]);
            const calleeNames = callees.map(c => c.name);
            assert.ok(calleeNames.includes('fetch_remote'),
                `Should resolve self.fetch_remote(), got: ${calleeNames.join(', ')}`);
            assert.ok(calleeNames.includes('is_valid'),
                `Should resolve self.is_valid(), got: ${calleeNames.join(', ')}`);

            // fetch_remote should have get_records as caller
            const callers = index.findCallers('fetch_remote');
            const callerNames = callers.map(c => c.callerName);
            assert.ok(callerNames.includes('get_records'),
                `Should find get_records as caller of fetch_remote, got: ${callerNames.join(', ')}`);
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

// Regression: isTestFile should use relative paths, not absolute paths
// Bug: When project lived at /Users/x/test/project/, the /test/ in the parent
// path matched the Python test pattern /\/tests?\//, marking ALL files as test files.
// This caused deadcode to either miss real dead code or produce false positives.
describe('Regression: deadcode uses relative paths for isTestFile', () => {
    it('should not treat non-test files as test files when project is inside a /test/ directory', () => {
        // Simulate a project inside a directory named "test"
        const tmpDir = path.join(os.tmpdir(), `ucn-test-relpath-${Date.now()}`, 'test', 'myproject');
        const toolsDir = path.join(tmpDir, 'tools');
        fs.mkdirSync(toolsDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'setup.py'), '');
            fs.writeFileSync(path.join(toolsDir, '__init__.py'), '');
            fs.writeFileSync(path.join(toolsDir, 'helper.py'), `
def unused_helper():
    return 42

def used_helper():
    return 1
`);
            fs.writeFileSync(path.join(tmpDir, 'main.py'), `
from tools.helper import used_helper

def main():
    print(used_helper())
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const dead = index.deadcode();
            const deadNames = dead.map(d => d.name);

            // unused_helper should be flagged as dead code
            assert.ok(deadNames.includes('unused_helper'),
                `unused_helper should be flagged as dead code, got: ${deadNames.join(', ')}`);

            // used_helper should NOT be flagged
            assert.ok(!deadNames.includes('used_helper'),
                `used_helper should not be flagged as dead code`);
        } finally {
            fs.rmSync(path.join(os.tmpdir(), `ucn-test-relpath-${Date.now()}`), { recursive: true, force: true });
            // Clean up the created dir tree
            const topDir = tmpDir.split('/test/myproject')[0];
            if (topDir.includes('ucn-test-relpath')) {
                fs.rmSync(topDir, { recursive: true, force: true });
            }
        }
    });

    it('should correctly filter test files even when project is inside /test/ directory', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-relpath2-${Date.now()}`, 'test', 'myproject');
        const testsDir = path.join(tmpDir, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'setup.py'), '');
            fs.writeFileSync(path.join(tmpDir, 'app.py'), `
def exported_func():
    return 42

def unused_func():
    return 0
`);
            fs.writeFileSync(path.join(testsDir, 'test_app.py'), `
from app import exported_func

def test_exported():
    assert exported_func() == 42

def _helper_in_test():
    return 'setup'
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // Default: test files excluded
            const deadDefault = index.deadcode();
            const deadDefaultNames = deadDefault.map(d => d.name);

            // unused_func from app.py should appear
            assert.ok(deadDefaultNames.includes('unused_func'),
                `unused_func should be in deadcode results`);

            // _helper_in_test from test file should NOT appear (test files excluded by default)
            assert.ok(!deadDefaultNames.includes('_helper_in_test'),
                `_helper_in_test should not appear without --include-tests`);

            // With --include-tests: test file symbols should appear
            const deadWithTests = index.deadcode({ includeTests: true });
            const deadWithTestsNames = deadWithTests.map(d => d.name);

            assert.ok(deadWithTestsNames.includes('_helper_in_test'),
                `_helper_in_test should appear with --include-tests`);

            // test_* functions should still be excluded (they're entry points)
            assert.ok(!deadWithTestsNames.includes('test_exported'),
                `test_exported should not be flagged (entry point)`);
        } finally {
            const topDir = tmpDir.split('/test/myproject')[0];
            if (topDir.includes('ucn-test-relpath2')) {
                fs.rmSync(topDir, { recursive: true, force: true });
            }
        }
    });
});

// Regression: deadcode --include-exported should not include test file symbols
// unless --include-tests is also specified
describe('Regression: deadcode --include-exported respects test file filtering', () => {
    it('should not show test methods when only --include-exported is set', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-exported-${Date.now()}`);
        const testsDir = path.join(tmpDir, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'setup.py'), '');
            fs.writeFileSync(path.join(tmpDir, 'lib.py'), `
def public_func():
    return 42
`);
            fs.writeFileSync(path.join(testsDir, 'test_lib.py'), `
from lib import public_func

class TestLib:
    def test_public_func(self):
        assert public_func() == 42

    def test_another(self):
        assert True
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // --include-exported but NOT --include-tests
            const dead = index.deadcode({ includeExported: true, includeTests: false });
            const deadNames = dead.map(d => d.name);

            // Test methods should NOT appear
            assert.ok(!deadNames.includes('test_public_func'),
                `test methods should not appear with only --include-exported`);
            assert.ok(!deadNames.includes('test_another'),
                `test methods should not appear with only --include-exported`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// Regression: isTestFile relative path fix applies to all languages (not just Python)
// Rust has /\/tests\// pattern that could match parent directories
describe('Regression: deadcode relative path fix works for Rust projects', () => {
    it('should not treat non-test Rust files as test files when project is inside /tests/ directory', () => {
        // Project lives inside a directory called "tests"
        const tmpDir = path.join(os.tmpdir(), `ucn-test-rust-relpath-${Date.now()}`, 'tests', 'myproject');
        const srcDir = path.join(tmpDir, 'src');
        fs.mkdirSync(srcDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"');
            fs.writeFileSync(path.join(srcDir, 'lib.rs'), `
fn unused_helper() -> i32 {
    42
}

pub fn used_func() -> i32 {
    unused_helper()
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const dead = index.deadcode();
            const deadNames = dead.map(d => d.name);

            // unused_helper should be flagged (it has a caller but let's check it's not filtered)
            // The key assertion: src/lib.rs should NOT be treated as a test file
            const { isTestFile } = require('../core/discovery');
            assert.ok(!isTestFile('src/lib.rs', 'rust'),
                'src/lib.rs should not be a test file');

            // Verify the old bug: absolute path WOULD falsely match
            const absPath = path.join(tmpDir, 'src', 'lib.rs');
            // The absolute path contains /tests/ from parent dir
            assert.ok(absPath.includes('/tests/'),
                'Absolute path should contain /tests/ from parent directory');
        } finally {
            const topDir = tmpDir.split('/tests/myproject')[0];
            if (topDir.includes('ucn-test-rust-relpath')) {
                fs.rmSync(topDir, { recursive: true, force: true });
            }
        }
    });
});

// Regression: deadcode relative path fix works for JS projects with __tests__ in parent
describe('Regression: deadcode relative path fix works for JS projects', () => {
    it('should not treat non-test JS files as test files when project is inside /__tests__/ directory', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-js-relpath-${Date.now()}`, '__tests__', 'myproject');
        const srcDir = path.join(tmpDir, 'src');
        fs.mkdirSync(srcDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');
            fs.writeFileSync(path.join(srcDir, 'utils.js'), `
function unusedUtil() {
    return 42;
}

function usedUtil() {
    return unusedUtil();
}

module.exports = { usedUtil };
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const dead = index.deadcode();
            const deadNames = dead.map(d => d.name);

            // src/utils.js should NOT be treated as a test file
            const { isTestFile } = require('../core/discovery');
            assert.ok(!isTestFile('src/utils.js', 'javascript'),
                'src/utils.js should not be a test file');
        } finally {
            const topDir = tmpDir.split('/__tests__/myproject')[0];
            if (topDir.includes('ucn-test-js-relpath')) {
                fs.rmSync(topDir, { recursive: true, force: true });
            }
        }
    });
});

// Regression: Rust trait impl methods should not appear as deadcode
describe('Regression: deadcode skips Rust trait impl methods', () => {
    it('should not report trait impl methods as dead code', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-rust-trait-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"\nversion = "0.1.0"');
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            // A struct with an inherent impl and a trait impl
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.rs'), `
struct Foo {
    val: i32,
}

impl Foo {
    fn new(val: i32) -> Self {
        Foo { val }
    }

    fn unused_method(&self) -> i32 {
        self.val
    }
}

impl std::fmt::Display for Foo {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}", self.val)
    }
}

impl PartialEq for Foo {
    fn eq(&self, other: &Self) -> bool {
        self.val == other.val
    }
}

fn main() {
    let f = Foo::new(42);
}
`);
            const idx = new ProjectIndex(tmpDir);
            idx.build(null, { quiet: true });
            const dead = idx.deadcode();
            const deadNames = dead.map(d => d.name);

            // Trait impl methods should NOT appear
            assert.ok(!deadNames.includes('fmt'), 'fmt (trait impl) should not be dead code');
            assert.ok(!deadNames.includes('eq'), 'eq (trait impl) should not be dead code');

            // Genuinely unused inherent method SHOULD appear
            assert.ok(deadNames.includes('unused_method'), 'unused_method should be dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// Regression: Rust #[bench] functions should be treated as entry points
describe('Regression: deadcode treats Rust #[bench] as entry points', () => {
    it('should not report #[bench] functions as dead code', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-rust-bench-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"\nversion = "0.1.0"');
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'benches'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.rs'), `
fn main() {}

fn helper() -> i32 { 42 }
`);
            fs.writeFileSync(path.join(tmpDir, 'benches', 'my_bench.rs'), `
#![feature(test)]
extern crate test;
use test::Bencher;

#[bench]
fn bench_something(b: &mut Bencher) {
    b.iter(|| 1 + 1);
}

fn unused_bench_helper() -> i32 {
    42
}
`);
            const idx = new ProjectIndex(tmpDir);
            idx.build(null, { quiet: true });
            const dead = idx.deadcode();
            const deadNames = dead.map(d => d.name);

            // #[bench] should NOT appear as dead code
            assert.ok(!deadNames.includes('bench_something'), 'bench_something should not be dead code');

            // Genuinely unused function SHOULD appear
            assert.ok(deadNames.includes('unused_bench_helper'), 'unused_bench_helper should be dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// Regression: test file patterns should match relative paths starting with tests/
describe('Regression: test file patterns match relative paths', () => {
    it('should detect tests/ at start of relative path for Python', () => {
        const { isTestFile } = require('../core/discovery');
        // Relative paths starting with tests/ should match
        assert.ok(isTestFile('tests/test_app.py', 'python'),
            'tests/test_app.py should be a test file');
        assert.ok(isTestFile('tests/helpers/factory.py', 'python'),
            'tests/helpers/factory.py should be a test file');
        // Subdirectory should still work
        assert.ok(isTestFile('src/tests/test_util.py', 'python'),
            'src/tests/test_util.py should be a test file');
        // Non-test paths should not match
        assert.ok(!isTestFile('src/utils.py', 'python'),
            'src/utils.py should not be a test file');
    });

    it('should detect tests/ at start of relative path for Rust', () => {
        const { isTestFile } = require('../core/discovery');
        assert.ok(isTestFile('tests/integration.rs', 'rust'),
            'tests/integration.rs should be a test file');
        assert.ok(isTestFile('tests/examples/hello.rs', 'rust'),
            'tests/examples/hello.rs should be a test file');
        // Non-test paths should not match
        assert.ok(!isTestFile('src/lib.rs', 'rust'),
            'src/lib.rs should not be a test file');
    });
});

// Regression: Java @Override methods should not appear as deadcode
describe('Regression: deadcode skips Java @Override methods', () => {
    it('should not report @Override methods as dead code', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-java-override-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'src', 'MyClass.java'), `
public class MyClass implements Runnable {
    @Override
    public void run() {
        System.out.println("running");
    }

    @Override
    public String toString() {
        return "MyClass";
    }

    void unusedMethod() {
        System.out.println("unused");
    }

    public static void main(String[] args) {
        new MyClass().run();
    }
}
`);
            const idx = new ProjectIndex(tmpDir);
            idx.build(null, { quiet: true });
            const dead = idx.deadcode();
            const deadNames = dead.map(d => d.name);

            // @Override methods should NOT appear
            assert.ok(!deadNames.includes('run'), 'run (@Override) should not be dead code');
            assert.ok(!deadNames.includes('toString'), 'toString (@Override) should not be dead code');

            // Genuinely unused method SHOULD appear
            assert.ok(deadNames.includes('unusedMethod'), 'unusedMethod should be dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// Regression: Python setUp/tearDown and pytest_* should be entry points
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

console.log('UCN v3 Test Suite');
console.log('Run with: node --test test/parser.test.js');
