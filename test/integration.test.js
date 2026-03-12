/**
 * UCN Integration Tests
 *
 * ProjectIndex, file discovery, comprehensive commands, multi-language fixtures.
 * Extracted from parser.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { parse, parseFile, detectLanguage, isSupported } = require('../core/parser');
const { ProjectIndex } = require('../core/project');
const { expandGlob } = require('../core/discovery');
const { createTempDir, cleanup, tmp, rm, idx, FIXTURES_PATH, PROJECT_DIR, runCli } = require('./helpers');

// ============================================================================
// Integration Tests
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
    let index;
    before(() => {
        index = new ProjectIndex(PROJECT_DIR);
        index.build(null, { quiet: true });
    });

    it('builds index and finds symbols', () => {
        const stats = index.getStats();
        assert.ok(stats.files > 0, 'Should index files');
        assert.ok(stats.symbols > 0, 'Should find symbols');

        const found = index.find('parse');
        assert.ok(found.length > 0, 'Should find parse function');
    });

    it('gets imports for a file', () => {
        const imports = index.imports('core/parser.js');
        assert.ok(imports.length > 0, 'Should find imports');
        assert.ok(imports.some(i => i.module.includes('languages')), 'Should find languages import');
    });

    it('gets exporters for a file', () => {
        const exporters = index.exporters('core/parser.js');
        assert.ok(exporters.length > 0, 'Should find files that import parser.js');
    });

    it('finds type definitions', () => {
        const types = index.typedef('ProjectIndex');
        assert.ok(types.length > 0, 'Should find ProjectIndex class');
        assert.strictEqual(types[0].type, 'class', 'Should be a class');
    });

    it('finds tests for a function', () => {
        const tests = index.tests('parse');
        assert.ok(tests.length > 0, 'Should find tests for parse');
        assert.ok(tests[0].matches.length > 0, 'Should have test matches');
    });

    it('gets usages grouped by type', () => {
        const usages = index.usages('parseFile');
        const defs = usages.filter(u => u.isDefinition);
        const calls = usages.filter(u => u.usageType === 'call');

        assert.ok(defs.length > 0, 'Should find definition');
        assert.ok(calls.length > 0, 'Should find calls');
    });

    it('gets context (callers + callees)', () => {
        const ctx = index.context('parseFile');
        assert.strictEqual(ctx.function, 'parseFile');
        assert.ok(Array.isArray(ctx.callers), 'Should have callers array');
        assert.ok(Array.isArray(ctx.callees), 'Should have callees array');
    });

    it('searches across project', () => {
        const results = index.search('TODO');
        assert.ok(Array.isArray(results), 'Should return array');
    });

    it('gets API (exported symbols)', () => {
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
// File Discovery
// ============================================================================

describe('File Discovery', () => {
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
// Comprehensive command tests
// ============================================================================

describe('Comprehensive command tests', () => {
    let tmpDir;
    let index;

    // Setup test project
    function setupProject() {
        tmpDir = path.join(os.tmpdir(), `ucn-comprehensive-${Date.now()}`);
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

// ============================================================================
// JSON output format, Auto-routing, CLI helpers — share one ProjectIndex build
// ============================================================================

describe('ProjectIndex commands (shared build)', () => {
    let index;
    before(() => {
        index = new ProjectIndex(PROJECT_DIR);
        index.build(null, { quiet: true });
    });

    it('find returns valid JSON structure', () => {
        const found = index.find('parse');
        assert.ok(Array.isArray(found), 'Should be array');
        if (found.length > 0) {
            assert.ok(found[0].name, 'Should have name');
            assert.ok(found[0].file || found[0].relativePath, 'Should have file info');
        }
    });

    it('usages returns valid JSON structure', () => {
        const usages = index.usages('parse');
        assert.ok(Array.isArray(usages), 'Should be array');
        if (usages.length > 0) {
            assert.ok(typeof usages[0].isDefinition === 'boolean', 'Should have isDefinition');
            assert.ok(usages[0].usageType || usages[0].isDefinition, 'Should have usageType or isDefinition');
        }
    });

    it('stats returns valid JSON structure', () => {
        const stats = index.getStats();
        assert.ok(stats.root, 'Should have root');
        assert.ok(typeof stats.files === 'number', 'Should have files count');
        assert.ok(typeof stats.symbols === 'number', 'Should have symbols count');
        assert.ok(stats.byLanguage, 'Should have byLanguage');
        assert.ok(stats.byType, 'Should have byType');
    });

    it('should handle imports command on file path', () => {
        const imports = index.imports('cli/index.js');
        assert.ok(Array.isArray(imports), 'Should return imports array');
        assert.ok(imports.length > 0, 'Should have some imports');
        const hasInternal = imports.some(i => !i.isExternal);
        const hasExternal = imports.some(i => i.isExternal);
        assert.ok(hasInternal || hasExternal, 'Should have internal or external imports');
    });

    it('should handle exporters command on file path', () => {
        const exporters = index.exporters('core/parser.js');
        assert.ok(Array.isArray(exporters), 'Should return exporters array');
    });

    it('should handle graph command on file path', () => {
        const graph = index.graph('cli/index.js', { direction: 'both', maxDepth: 2 });
        assert.ok(graph, 'Should return graph result');
        assert.ok(graph.nodes, 'Should have nodes');
        assert.ok(graph.edges, 'Should have edges');
    });

    it('find should work with various options', () => {
        const exactResults = index.find('parse', { exact: true });
        assert.ok(Array.isArray(exactResults), 'Should return array');

        const filteredResults = index.find('parse', { file: 'parser' });
        assert.ok(Array.isArray(filteredResults), 'Should return array with file filter');
    });

    it('context should return proper structure', () => {
        const ctx = index.context('parse');
        assert.ok(ctx, 'Should return context');
        assert.ok(ctx.function === 'parse', 'Should have function name');
        assert.ok(Array.isArray(ctx.callers), 'Should have callers array');
        assert.ok(Array.isArray(ctx.callees), 'Should have callees array');
    });
});

// ============================================================================
// Multi-language Fixtures: Python
// ============================================================================

describe('Multi-language Fixtures: Python', () => {
    const fixturesPath = path.join(FIXTURES_PATH, 'python');

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

// ============================================================================
// Multi-language Fixtures: Go
// ============================================================================

describe('Multi-language Fixtures: Go', () => {
    const fixturesPath = path.join(FIXTURES_PATH, 'go');

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

// ============================================================================
// Multi-language Fixtures: Rust
// ============================================================================

describe('Multi-language Fixtures: Rust', () => {
    const fixturesPath = path.join(FIXTURES_PATH, 'rust');

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

// ============================================================================
// Multi-language Fixtures: Java
// ============================================================================

describe('Multi-language Fixtures: Java', () => {
    const fixturesPath = path.join(FIXTURES_PATH, 'java');

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

// ============================================================================
// Regression: Project detection with language markers
// ============================================================================

describe('Regression: Project detection with language markers', () => {
    it('should detect Python project with pyproject.toml', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-pyproject-${Date.now()}`);
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
        const tmpDir = path.join(os.tmpdir(), `ucn-test-gomod-${Date.now()}`);
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
        const tmpDir = path.join(os.tmpdir(), `ucn-test-cargo-${Date.now()}`);
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
        const tmpDir = path.join(os.tmpdir(), `ucn-test-pom-${Date.now()}`);
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
        const tmpDir = path.join(os.tmpdir(), `ucn-test-multilang-${Date.now()}`);
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
// Member extraction for Go interfaces, Rust traits/enums, Java enums/interfaces
// ============================================================================

describe('Type member extraction', () => {
    it('Go interface extracts method signatures', () => {
        const goCode = `
package main

type Reader interface {
    Read(p []byte) (n int, err error)
    Close() error
}
`;
        const goParser = require('../languages/go');
        const { getParser } = require('../languages');
        const parser = getParser('go');
        const result = goParser.parse(goCode, parser);
        const iface = result.classes.find(c => c.name === 'Reader');
        assert.ok(iface, 'Reader interface should be found');
        assert.strictEqual(iface.members.length, 2, 'Should have 2 methods');
        assert.strictEqual(iface.members[0].name, 'Read');
        assert.strictEqual(iface.members[0].memberType, 'method');
        assert.ok(iface.members[0].params.includes('[]byte'), 'Read params should include []byte');
        assert.strictEqual(iface.members[1].name, 'Close');
    });

    it('Rust enum extracts variants', () => {
        const rustCode = `
enum Color {
    Red,
    Green,
    Blue(u8, u8, u8),
}
`;
        const rustParser = require('../languages/rust');
        const { getParser } = require('../languages');
        const parser = getParser('rust');
        const result = rustParser.parse(rustCode, parser);
        const enumDef = result.classes.find(c => c.name === 'Color');
        assert.ok(enumDef, 'Color enum should be found');
        assert.strictEqual(enumDef.members.length, 3, 'Should have 3 variants');
        assert.strictEqual(enumDef.members[0].name, 'Red');
        assert.strictEqual(enumDef.members[0].memberType, 'variant');
        assert.strictEqual(enumDef.members[2].name, 'Blue');
        assert.ok(enumDef.members[2].params, 'Blue should have params');
    });

    it('Rust trait extracts method signatures', () => {
        const rustCode = `
trait Drawable {
    fn draw(&self);
    fn resize(&mut self, width: u32, height: u32) -> bool;
}
`;
        const rustParser = require('../languages/rust');
        const { getParser } = require('../languages');
        const parser = getParser('rust');
        const result = rustParser.parse(rustCode, parser);
        const trait = result.classes.find(c => c.name === 'Drawable');
        assert.ok(trait, 'Drawable trait should be found');
        assert.strictEqual(trait.members.length, 2, 'Should have 2 methods');
        assert.strictEqual(trait.members[0].name, 'draw');
        assert.strictEqual(trait.members[0].memberType, 'method');
        assert.strictEqual(trait.members[1].name, 'resize');
        assert.ok(trait.members[1].returnType, 'resize should have return type');
    });

    it('Java enum extracts constants', () => {
        const javaCode = `
public enum Day {
    MONDAY,
    TUESDAY,
    WEDNESDAY;

    public String label() { return name().toLowerCase(); }
}
`;
        const javaParser = require('../languages/java');
        const { getParser } = require('../languages');
        const parser = getParser('java');
        const result = javaParser.parse(javaCode, parser);
        const enumDef = result.classes.find(c => c.name === 'Day');
        assert.ok(enumDef, 'Day enum should be found');
        const constants = enumDef.members.filter(m => m.memberType === 'constant');
        assert.strictEqual(constants.length, 3, 'Should have 3 constants');
        assert.strictEqual(constants[0].name, 'MONDAY');
        // Also check that the method is extracted
        const methods = enumDef.members.filter(m => m.memberType === 'method');
        assert.strictEqual(methods.length, 1, 'Should have 1 method');
        assert.strictEqual(methods[0].name, 'label');
    });

    it('Java interface extracts method declarations', () => {
        const javaCode = `
public interface Comparable<T> {
    int compareTo(T other);
    default boolean isGreaterThan(T other) { return compareTo(other) > 0; }
}
`;
        const javaParser = require('../languages/java');
        const { getParser } = require('../languages');
        const parser = getParser('java');
        const result = javaParser.parse(javaCode, parser);
        const iface = result.classes.find(c => c.name === 'Comparable');
        assert.ok(iface, 'Comparable interface should be found');
        assert.ok(iface.members.length >= 1, 'Should have at least 1 method');
        const compareTo = iface.members.find(m => m.name === 'compareTo');
        assert.ok(compareTo, 'compareTo method should be found');
    });
});

// ============================================================================
// Discovery: .kt removal
// ============================================================================

it('detectProjectPattern does not include .kt for Gradle/Maven projects', () => {
    const discovery = require('../core/discovery');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-kt-'));
    try {
        // Create a build.gradle to trigger Java detection
        fs.writeFileSync(path.join(tmpDir, 'build.gradle'), 'plugins {}');
        const result = discovery.detectProjectPattern(tmpDir);
        assert.ok(result.includes('java'), 'Should include java');
        assert.ok(!result.includes('kt'), 'Should NOT include kt (no Kotlin parser)');
    } finally {
        fs.rmSync(tmpDir, { recursive: true });
    }
});

// ============================================================================
// BUG HUNT 2026-03-02: CLI positional arg parsing
// ============================================================================

describe('fix: CLI value-flag args not consumed as positional', () => {
    it('find --depth 1 without symbol name should error', () => {
        const out = runCli(FIXTURES_PATH + '/javascript', 'find', [], ['--depth', '1', '--no-cache']);
        assert.ok(out.includes('required') || out.includes('Usage') || out.includes('Symbol name'),
            `should error for missing symbol name, got: ${out.slice(0, 200)}`);
    });

    it('find --top 5 without symbol name should error', () => {
        const out = runCli(FIXTURES_PATH + '/javascript', 'find', [], ['--top', '5', '--no-cache']);
        assert.ok(out.includes('required') || out.includes('Usage') || out.includes('Symbol name'),
            `should error for missing symbol name, got: ${out.slice(0, 200)}`);
    });

    it('find --base HEAD without symbol name should error', () => {
        const out = runCli(FIXTURES_PATH + '/javascript', 'find', [], ['--base', 'HEAD', '--no-cache']);
        assert.ok(out.includes('required') || out.includes('Usage') || out.includes('Symbol name'),
            `should error for missing symbol name, got: ${out.slice(0, 200)}`);
    });
});

describe('fix R2: CLI --max-lines rejects non-integer values', () => {
    it('class --max-lines=abc should error', () => {
        const out = runCli(FIXTURES_PATH + '/javascript', 'class', ['DataProcessor'], ['--max-lines=abc', '--no-cache']);
        assert.ok(out.includes('positive integer'),
            `should reject non-numeric max-lines, got: ${out.slice(0, 200)}`);
    });

    it('class --max-lines=1.5 should error', () => {
        const out = runCli(FIXTURES_PATH + '/javascript', 'class', ['DataProcessor'], ['--max-lines=1.5', '--no-cache']);
        assert.ok(out.includes('positive integer'),
            `should reject decimal max-lines, got: ${out.slice(0, 200)}`);
    });

    it('class --max-lines=5 should succeed', () => {
        const out = runCli(FIXTURES_PATH + '/javascript', 'class', ['DataProcessor'], ['--max-lines=5', '--no-cache']);
        assert.ok(!out.includes('positive integer'),
            `valid max-lines should not error, got: ${out.slice(0, 200)}`);
    });
});

// ============================================================================
// Evaluation report fixes (2026-03-03)
// ============================================================================

describe('fix #121: find("*") should return all symbols', () => {
    it('bare wildcard returns all symbols', () => {
        const { tmp, rm, idx } = require('./helpers');
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function alpha() {}\nfunction beta() {}',
            'b.js': 'function gamma() {}'
        });
        try {
            const index = idx(dir);
            const results = index.find('*');
            assert.ok(results.length >= 3,
                `find("*") should find at least 3 symbols, got ${results.length}`);
            const names = results.map(r => r.name);
            assert.ok(names.includes('alpha'), 'should find alpha');
            assert.ok(names.includes('beta'), 'should find beta');
            assert.ok(names.includes('gamma'), 'should find gamma');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #122: find("test_*") should include test files', () => {
    it('auto-includes test files when pattern starts with test', () => {
        const { tmp, rm } = require('./helpers');
        const { execute } = require('../core/execute');
        const dir = tmp({
            'requirements.txt': '',
            'app.py': 'def main():\n    pass',
            'tests/test_app.py': 'def test_main_works():\n    pass\ndef test_edge_case():\n    pass'
        });
        try {
            const index = new ProjectIndex(dir);
            index.build(null, { quiet: true });
            const { ok, result } = execute(index, 'find', { name: 'test_*' });
            assert.ok(ok, 'find should succeed');
            assert.ok(result.length >= 2,
                `should find at least 2 test functions, got ${result.length}`);
            const names = result.map(r => r.name);
            assert.ok(names.includes('test_main_works'), 'should find test_main_works');
            assert.ok(names.includes('test_edge_case'), 'should find test_edge_case');
        } finally {
            rm(dir);
        }
    });
});

describe('config maxFiles from .ucn.json', () => {
    it('respects maxFiles from .ucn.json config', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            '.ucn.json': JSON.stringify({ maxFiles: 2 }),
            'a.js': 'function a() {}',
            'b.js': 'function b() {}',
            'c.js': 'function c() {}',
            'd.js': 'function d() {}',
        });
        try {
            const index = new ProjectIndex(dir);
            index.build(null, { quiet: true });
            // With maxFiles=2, only 2 files should be indexed
            assert.strictEqual(index.files.size, 2);
            assert.ok(index.truncated, 'should report truncation');
            assert.strictEqual(index.truncated.maxFiles, 2);
        } finally {
            rm(dir);
        }
    });

    it('CLI --max-files overrides config maxFiles', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            '.ucn.json': JSON.stringify({ maxFiles: 1 }),
            'a.js': 'function a() {}',
            'b.js': 'function b() {}',
            'c.js': 'function c() {}',
        });
        try {
            const index = new ProjectIndex(dir);
            // CLI maxFiles=10 should override config maxFiles=1
            index.build(null, { quiet: true, maxFiles: 10 });
            assert.strictEqual(index.files.size, 3);
            assert.ok(!index.truncated, 'should not be truncated');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Confidence Scoring Tests (Phase 3a)
// ============================================================================

describe('Confidence Scoring', () => {
    const { execute } = require('../core/execute');
    const { scoreEdge, filterByConfidence, RESOLUTION, SCORES } = require('../core/confidence');

    describe('scoreEdge', () => {
        it('scores exact-binding highest', () => {
            const result = scoreEdge({ hasBindingId: true });
            assert.strictEqual(result.resolution, RESOLUTION.EXACT_BINDING);
            assert.strictEqual(result.confidence, SCORES[RESOLUTION.EXACT_BINDING]);
        });

        it('scores same-class resolution', () => {
            const result = scoreEdge({ resolvedBySameClass: true });
            assert.strictEqual(result.resolution, RESOLUTION.SAME_CLASS);
            assert.strictEqual(result.confidence, SCORES[RESOLUTION.SAME_CLASS]);
        });

        it('scores receiver-hint resolution', () => {
            const result = scoreEdge({ resolvedByReceiverHint: true });
            assert.strictEqual(result.resolution, RESOLUTION.RECEIVER_HINT);
        });

        it('scores parser receiverType', () => {
            const result = scoreEdge({ hasReceiverType: true });
            assert.strictEqual(result.resolution, RESOLUTION.RECEIVER_HINT);
        });

        it('scores scope-match for import evidence', () => {
            const result = scoreEdge({ hasImportEvidence: true });
            assert.strictEqual(result.resolution, RESOLUTION.SCOPE_MATCH);
        });

        it('scores uncertain lowest', () => {
            const result = scoreEdge({ isUncertain: true });
            assert.strictEqual(result.resolution, RESOLUTION.UNCERTAIN);
            assert.strictEqual(result.confidence, SCORES[RESOLUTION.UNCERTAIN]);
        });

        it('scores name-only for no evidence', () => {
            const result = scoreEdge({});
            assert.strictEqual(result.resolution, RESOLUTION.NAME_ONLY);
        });

        it('includes evidence strings', () => {
            const result = scoreEdge({ hasBindingId: true, hasImportEvidence: true });
            assert.ok(result.evidence.length > 0);
            assert.ok(result.evidence.includes('binding-id match'));
        });
    });

    describe('filterByConfidence', () => {
        it('keeps all edges when threshold is 0', () => {
            const edges = [{ confidence: 0.5 }, { confidence: 0.2 }];
            const { kept, filtered } = filterByConfidence(edges, 0);
            assert.strictEqual(kept.length, 2);
            assert.strictEqual(filtered, 0);
        });

        it('filters edges below threshold', () => {
            const edges = [
                { confidence: 0.98 },
                { confidence: 0.65 },
                { confidence: 0.25 },
            ];
            const { kept, filtered } = filterByConfidence(edges, 0.5);
            assert.strictEqual(kept.length, 2);
            assert.strictEqual(filtered, 1);
        });

        it('handles empty array', () => {
            const { kept, filtered } = filterByConfidence([], 0.5);
            assert.strictEqual(kept.length, 0);
            assert.strictEqual(filtered, 0);
        });
    });

    describe('callers have confidence metadata', () => {
        it('attaches confidence to findCallers results', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
                'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
            });
            try {
                const index = idx(dir);
                const callers = index.findCallers('helper');
                assert.ok(callers.length > 0, 'should find callers');
                for (const c of callers) {
                    assert.ok(c.confidence != null, 'caller should have confidence');
                    assert.ok(c.resolution != null, 'caller should have resolution');
                    assert.ok(c.confidence >= 0 && c.confidence <= 1, 'confidence should be 0-1');
                }
            } finally {
                rm(dir);
            }
        });

        it('attaches confidence to findCallees results', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
                'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }\nmodule.exports = { main };'
            });
            try {
                const index = idx(dir);
                const mainDef = index.symbols.get('main');
                assert.ok(mainDef && mainDef.length > 0);
                const callees = index.findCallees(mainDef[0]);
                assert.ok(callees.length > 0, 'should find callees');
                for (const c of callees) {
                    assert.ok(c.confidence != null, 'callee should have confidence');
                    assert.ok(c.resolution != null, 'callee should have resolution');
                }
            } finally {
                rm(dir);
            }
        });
    });

    describe('context command with confidence', () => {
        it('includes confidenceFiltered in meta', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
                'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
            });
            try {
                const index = idx(dir);
                // With high min-confidence, should filter edges
                const result = index.context('helper', { minConfidence: 0.99 });
                assert.ok(result);
                assert.ok(result.meta.confidenceFiltered >= 0);
            } finally {
                rm(dir);
            }
        });

        it('callers in context have confidence when present', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
                'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
            });
            try {
                const index = idx(dir);
                const result = index.context('helper');
                assert.ok(result);
                assert.ok(result.callers.length > 0);
                assert.ok(result.callers[0].confidence != null);
            } finally {
                rm(dir);
            }
        });
    });

    describe('--min-confidence filtering via execute', () => {
        it('filters low-confidence callers in context', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'a.js': 'function foo() { return 1; }\nmodule.exports = { foo };',
                'b.js': 'const { foo } = require("./a");\nfunction bar() { foo(); }',
            });
            try {
                const index = idx(dir);
                // Without filter
                const r1 = execute(index, 'context', { name: 'foo' });
                assert.ok(r1.ok);
                const countBefore = r1.result.callers.length;

                // With impossibly high filter
                const r2 = execute(index, 'context', { name: 'foo', minConfidence: 0.99 });
                assert.ok(r2.ok);
                assert.ok(r2.result.callers.length <= countBefore);
                assert.ok(r2.result.meta.confidenceFiltered >= 0);
            } finally {
                rm(dir);
            }
        });
    });

    describe('confidence scoring per resolution tier', () => {
        it('same-file caller gets exact-binding (0.98)', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'function helper() { return 1; }\nfunction main() { helper(); }\nmodule.exports = { helper, main };'
            });
            try {
                const index = idx(dir);
                const callers = index.findCallers('helper');
                assert.ok(callers.length > 0);
                assert.strictEqual(callers[0].resolution, 'exact-binding');
                assert.strictEqual(callers[0].confidence, 0.98);
            } finally { rm(dir); }
        });

        it('cross-file imported caller gets scope-match (0.65)', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
                'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
            });
            try {
                const index = idx(dir);
                const callers = index.findCallers('helper');
                assert.ok(callers.length > 0);
                assert.strictEqual(callers[0].resolution, 'scope-match');
                assert.strictEqual(callers[0].confidence, 0.65);
            } finally { rm(dir); }
        });

        it('Go receiverType caller gets receiver-hint (0.80)', () => {
            const dir = tmp({
                'go.mod': 'module test\ngo 1.21',
                'main.go': 'package main\n\ntype Server struct{}\n\nfunc (s *Server) Start() {}\n\nfunc main() {\n    s := &Server{}\n    s.Start()\n}\n'
            });
            try {
                const index = idx(dir);
                const callers = index.findCallers('Start', { includeMethods: true });
                assert.ok(callers.length > 0);
                assert.strictEqual(callers[0].resolution, 'receiver-hint');
                assert.strictEqual(callers[0].confidence, 0.80);
            } finally { rm(dir); }
        });

        it('Java receiverType caller gets receiver-hint (0.80)', () => {
            const dir = tmp({
                'pom.xml': '<project></project>',
                'Service.java': 'public class Service {\n    public void execute() {}\n}\n',
                'App.java': 'public class App {\n    public void main() {\n        Service svc = new Service();\n        svc.execute();\n    }\n}\n'
            });
            try {
                const index = idx(dir);
                const callers = index.findCallers('execute', { includeMethods: true });
                assert.ok(callers.length > 0);
                assert.strictEqual(callers[0].resolution, 'receiver-hint');
                assert.strictEqual(callers[0].confidence, 0.80);
            } finally { rm(dir); }
        });

        it('JS new Constructor() caller gets receiver-hint (0.80)', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'client.js': 'class Client {\n    fetch(url) { return url; }\n}\nmodule.exports = { Client };',
                'app.js': 'const { Client } = require("./client");\nfunction run() {\n    const c = new Client();\n    c.fetch("/api");\n}\nmodule.exports = { run };'
            });
            try {
                const index = idx(dir);
                const callers = index.findCallers('fetch', { includeMethods: true });
                assert.ok(callers.length > 0, 'should find callers of fetch');
                assert.strictEqual(callers[0].resolution, 'receiver-hint',
                    'new Client() should infer receiverType and give receiver-hint');
                assert.ok(callers[0].confidence >= 0.80,
                    'receiver-hint confidence should be >= 0.80');
            } finally { rm(dir); }
        });

        it('Python cross-file inheritance caller gets same-class (0.92)', () => {
            const dir = tmp({
                'setup.py': '',
                'base.py': 'class Base:\n    def process(self):\n        return 1\n',
                'child.py': 'from base import Base\n\nclass Child(Base):\n    def run(self):\n        self.process()\n'
            });
            try {
                const index = idx(dir);
                const callers = index.findCallers('process', { includeMethods: true });
                assert.ok(callers.length > 0);
                assert.strictEqual(callers[0].resolution, 'same-class');
                assert.strictEqual(callers[0].confidence, 0.92);
            } finally { rm(dir); }
        });

        it('JS this.method() caller gets exact-binding (0.98)', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'app.js': 'class Controller {\n    helper() { return 1; }\n    main() { return this.helper(); }\n}\nmodule.exports = { Controller };'
            });
            try {
                const index = idx(dir);
                const callers = index.findCallers('helper', { includeMethods: true });
                assert.ok(callers.length > 0);
                assert.strictEqual(callers[0].resolution, 'exact-binding');
                assert.strictEqual(callers[0].confidence, 0.98);
            } finally { rm(dir); }
        });

        it('JS method call with no receiver evidence scores uncertain (0.25)', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'class Foo { get() { return 1; } }\nmodule.exports = { Foo };',
                'app.js': 'const m = getModule();\nm.get();\n'
            });
            try {
                const index = idx(dir);
                const callers = index.findCallers('get', { includeUncertain: true, includeMethods: true });
                assert.ok(callers.length > 0);
                assert.strictEqual(callers[0].resolution, 'uncertain');
                assert.strictEqual(callers[0].confidence, 0.25);
            } finally { rm(dir); }
        });

        it('callback caller gets scope-match (0.65)', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'function handler() { return 1; }\nmodule.exports = { handler };',
                'app.js': 'const { handler } = require("./lib");\nfunction setup() { emitter.on("click", handler); }\n'
            });
            try {
                const index = idx(dir);
                const callers = index.findCallers('handler');
                assert.ok(callers.length > 0);
                assert.strictEqual(callers[0].resolution, 'scope-match');
                assert.strictEqual(callers[0].confidence, 0.65);
            } finally { rm(dir); }
        });

        it('re-exported function callers get scope-match via barrel file', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': `function helper() { return 42; }\nmodule.exports = { helper };`,
                'barrel.js': `const { helper } = require('./lib');\nmodule.exports = { helper };`,
                'app.js': `const { helper } = require('./barrel');\nfunction main() { helper(); }\nmodule.exports = { main };`
            });
            try {
                const index = idx(dir);
                const callers = index.findCallers('helper');
                const appCaller = callers.find(c => c.file.endsWith('app.js'));
                assert.ok(appCaller, 'should find caller in app.js');
                assert.ok(appCaller.confidence >= 0.65, `re-export caller should be scope-match (0.65) or better, got ${appCaller.confidence}`);
                assert.notStrictEqual(appCaller.resolution, 'name-only', 'should not be name-only through barrel file');
            } finally {
                rm(dir);
            }
        });
    });

    describe('callee confidence scoring', () => {
        it('same-file callee gets exact-binding (0.98)', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'app.js': 'function helper() { return 1; }\nfunction main() { return helper(); }\nmodule.exports = { main };'
            });
            try {
                const index = idx(dir);
                const callees = index.findCallees(index.symbols.get('main')[0]);
                assert.ok(callees.length > 0);
                assert.strictEqual(callees[0].resolution, 'exact-binding');
                assert.strictEqual(callees[0].confidence, 0.98);
            } finally { rm(dir); }
        });

        it('cross-file callee with import gets scope-match (0.65)', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib1.js': 'function process(x) { return x + 1; }\nmodule.exports = { process };',
                'lib2.js': 'function process(x) { return x * 2; }\nmodule.exports = { process };',
                'app.js': 'const { process } = require("./lib1");\nfunction main() { return process(1); }\nmodule.exports = { main };'
            });
            try {
                const index = idx(dir);
                const callees = index.findCallees(index.symbols.get('main')[0]);
                const proc = callees.find(c => c.name === 'process');
                assert.ok(proc, 'should find process callee');
                assert.strictEqual(proc.resolution, 'scope-match');
                assert.strictEqual(proc.confidence, 0.65);
            } finally { rm(dir); }
        });
    });

    describe('confidence edge cases', () => {
        it('min-confidence=1.0 filters all non-perfect edges', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
                'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
            });
            try {
                const index = idx(dir);
                const result = index.context('helper', { minConfidence: 1.0 });
                assert.ok(result);
                assert.strictEqual(result.callers.length, 0);
                assert.strictEqual(result.meta.confidenceFiltered, 1);
            } finally { rm(dir); }
        });

        it('about command respects min-confidence', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
                'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
            });
            try {
                const index = idx(dir);
                const result = execute(index, 'about', { name: 'helper', minConfidence: 0.99 });
                assert.ok(result.ok);
                assert.strictEqual(result.result.callers.total, 0);
            } finally { rm(dir); }
        });

        it('import evidence overrides uncertain for callers with import graph', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'class Client { fetch() {} }\nmodule.exports = { Client };',
                'app.js': 'const { Client } = require("./lib");\nconst c = new Client();\nc.fetch();\n'
            });
            try {
                const index = idx(dir);
                const callers = index.findCallers('fetch', { includeUncertain: true, includeMethods: true });
                assert.ok(callers.length > 0);
                // Should be receiver-hint (type-inferred from `new Client()`) not uncertain
                assert.strictEqual(callers[0].resolution, 'receiver-hint');
                assert.ok(callers[0].confidence >= 0.80, 'type inference should give high confidence');
            } finally { rm(dir); }
        });

        it('about command tracks confidenceFiltered count', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
                'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }',
                'app2.js': 'const { helper } = require("./lib");\nfunction run() { helper(); }'
            });
            try {
                const index = idx(dir);
                const result = execute(index, 'about', { name: 'helper', minConfidence: 0.9 });
                assert.ok(result.ok);
                assert.strictEqual(result.result.confidenceFiltered, 2, 'should track 2 filtered edges');
                assert.strictEqual(result.result.callers.total, 0, 'all callers below threshold');
            } finally { rm(dir); }
        });

        it('about without min-confidence has no confidenceFiltered field', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
                'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
            });
            try {
                const index = idx(dir);
                const result = execute(index, 'about', { name: 'helper' });
                assert.ok(result.ok);
                assert.strictEqual(result.result.confidenceFiltered, undefined, 'no filtering = no counter');
            } finally { rm(dir); }
        });

        it('callee confidence: single definition gets scope-match', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
                'app.js': 'function main() { helper(); }'  // no import, but only 1 definition
            });
            try {
                const index = idx(dir);
                const result = execute(index, 'context', { name: 'main', showConfidence: true });
                assert.ok(result.ok);
                const callee = result.result.callees.find(c => c.name === 'helper');
                assert.ok(callee);
                assert.strictEqual(callee.resolution, 'scope-match', 'single def = scope-match');
                assert.strictEqual(callee.confidence, 0.65);
            } finally { rm(dir); }
        });

        it('callee confidence: ambiguous definitions get name-only', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'a.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
                'b.js': 'function helper() { return 2; }\nmodule.exports = { helper };',
                'app.js': 'function main() { helper(); }'  // no import, 2 definitions
            });
            try {
                const index = idx(dir);
                const result = execute(index, 'context', { name: 'main', showConfidence: true });
                assert.ok(result.ok);
                const callee = result.result.callees.find(c => c.name === 'helper');
                assert.ok(callee);
                assert.strictEqual(callee.resolution, 'name-only', 'ambiguous = name-only');
                assert.strictEqual(callee.confidence, 0.40);
            } finally { rm(dir); }
        });

        it('HTML inline script callers get confidence scoring', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'function handler() { return 1; }',
                'page.html': '<html><body><script>function init() { handler(); }</script></body></html>'
            });
            try {
                const index = idx(dir);
                const callers = index.findCallers('handler', { includeMethods: true });
                const htmlCaller = callers.find(c => c.file.endsWith('page.html'));
                assert.ok(htmlCaller, 'should find caller from HTML');
                assert.ok(htmlCaller.confidence != null, 'HTML caller should have confidence');
                assert.ok(htmlCaller.resolution != null, 'HTML caller should have resolution');
            } finally { rm(dir); }
        });

        it('filterByConfidence treats missing confidence as 0', () => {
            const { filterByConfidence } = require('../core/confidence');
            const edges = [
                { name: 'a', confidence: 0.98 },
                { name: 'b' },  // no confidence
                { name: 'c', confidence: 0.65 },
                { name: 'd', confidence: null },
            ];
            const { kept, filtered } = filterByConfidence(edges, 0.5);
            assert.strictEqual(kept.length, 2, 'should keep only edges >= 0.5');
            assert.strictEqual(filtered, 2, 'should filter edges without confidence');
            assert.ok(kept.every(e => e.confidence >= 0.5));
        });

        it('filterByConfidence handles NaN/negative/Infinity thresholds safely', () => {
            const { filterByConfidence } = require('../core/confidence');
            const edges = [{ name: 'a', confidence: 0.65 }];

            // NaN → no filtering (falsy check)
            assert.strictEqual(filterByConfidence(edges, NaN).kept.length, 1);
            // Negative → no filtering
            assert.strictEqual(filterByConfidence(edges, -1).kept.length, 1);
            // Infinity → filters everything
            assert.strictEqual(filterByConfidence(edges, Infinity).kept.length, 0);
        });

        it('self-recursive function gets exact-binding for self-call', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'function factorial(n) {\n  if (n <= 1) return 1;\n  return n * factorial(n - 1);\n}\nmodule.exports = { factorial };'
            });
            try {
                const index = idx(dir);
                const callers = index.findCallers('factorial');
                const selfCaller = callers.find(c => c.callerName === 'factorial');
                assert.ok(selfCaller, 'should find self-call');
                assert.strictEqual(selfCaller.resolution, 'exact-binding');
                assert.strictEqual(selfCaller.confidence, 0.98);
            } finally { rm(dir); }
        });

        it('--show-confidence + --include-methods works together', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'class S { process(d) { return d; } }\nfunction caller() { const s = new S(); s.process("x"); }\nmodule.exports = { S, caller };'
            });
            try {
                const index = idx(dir);
                const r = execute(index, 'context', { name: 'process', showConfidence: true, includeMethods: true });
                assert.ok(r.ok);
                assert.ok(r.result.callers.length > 0, 'should find method callers');
                assert.ok(r.result.callers[0].confidence != null, 'method callers should have confidence');
            } finally { rm(dir); }
        });

        it('JSON always includes confidence regardless of showConfidence flag', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'a.js': 'function fn() { return 1; }\nmodule.exports = { fn };',
                'b.js': 'const { fn } = require("./a");\nfunction c() { fn(); }\nmodule.exports = { c };'
            });
            try {
                const index = idx(dir);
                const output = require('../core/output');
                // Without showConfidence
                const ctx = execute(index, 'context', { name: 'fn' });
                const json = JSON.parse(output.formatContextJson(ctx.result));
                assert.ok(json.data.callers[0].confidence != null, 'JSON should always have confidence');
                assert.ok(json.data.callers[0].resolution != null, 'JSON should always have resolution');
            } finally { rm(dir); }
        });

        it('multiple same-name definitions: targeted callers disambiguate with confidence', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'modA.js': 'function validate(x) { return x > 0; }\nmodule.exports = { validate };',
                'modB.js': 'function validate(x) { return typeof x === "string"; }\nmodule.exports = { validate };',
                'userA.js': 'const { validate } = require("./modA");\nfunction check() { validate(42); }\nmodule.exports = { check };'
            });
            try {
                const index = idx(dir);
                const defsA = index.symbols.get('validate')?.filter(s => s.file?.endsWith('modA.js'));
                const callers = index.findCallers('validate', { targetDefinitions: defsA });
                assert.strictEqual(callers.length, 1, 'should find only userA caller');
                assert.ok(callers[0].file.endsWith('userA.js'));
                assert.ok(callers[0].confidence >= 0.65, 'targeted caller should have import evidence');
            } finally { rm(dir); }
        });

        it('2-hop re-export gets name-only (known limitation)', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': 'function deep() { return 42; }\nmodule.exports = { deep };',
                'mid.js': 'const { deep } = require("./lib");\nmodule.exports = { deep };',
                'barrel.js': 'const { deep } = require("./mid");\nmodule.exports = { deep };',
                'app.js': 'const { deep } = require("./barrel");\nfunction main() { deep(); }\nmodule.exports = { main };'
            });
            try {
                const index = idx(dir);
                const callers = index.findCallers('deep');
                const appCaller = callers.find(c => c.file.endsWith('app.js'));
                assert.ok(appCaller, 'should find caller through 2-hop re-export');
                // 2-hop re-export: our fix covers 1 hop, 2 hops falls back to name-only
                assert.strictEqual(appCaller.resolution, 'name-only', '2-hop re-export is name-only (known limitation)');
            } finally { rm(dir); }
        });
    });
});
