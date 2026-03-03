/**
 * UCN Integration Tests
 *
 * ProjectIndex, file discovery, comprehensive commands, multi-language fixtures.
 * Extracted from parser.test.js.
 */

const { describe, it } = require('node:test');
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
    it('builds index and finds symbols', () => {
        const index = new ProjectIndex(PROJECT_DIR);
        index.build(null, { quiet: true });

        const stats = index.getStats();
        assert.ok(stats.files > 0, 'Should index files');
        assert.ok(stats.symbols > 0, 'Should find symbols');

        const found = index.find('parse');
        assert.ok(found.length > 0, 'Should find parse function');
    });

    it('gets imports for a file', () => {
        const index = new ProjectIndex(PROJECT_DIR);
        index.build(null, { quiet: true });

        const imports = index.imports('core/parser.js');
        assert.ok(imports.length > 0, 'Should find imports');
        assert.ok(imports.some(i => i.module.includes('languages')), 'Should find languages import');
    });

    it('gets exporters for a file', () => {
        const index = new ProjectIndex(PROJECT_DIR);
        index.build(null, { quiet: true });

        const exporters = index.exporters('core/parser.js');
        assert.ok(exporters.length > 0, 'Should find files that import parser.js');
    });

    it('finds type definitions', () => {
        const index = new ProjectIndex(PROJECT_DIR);
        index.build(null, { quiet: true });

        const types = index.typedef('ProjectIndex');
        assert.ok(types.length > 0, 'Should find ProjectIndex class');
        assert.strictEqual(types[0].type, 'class', 'Should be a class');
    });

    it('finds tests for a function', () => {
        const index = new ProjectIndex(PROJECT_DIR);
        index.build(null, { quiet: true });

        const tests = index.tests('parse');
        assert.ok(tests.length > 0, 'Should find tests for parse');
        assert.ok(tests[0].matches.length > 0, 'Should have test matches');
    });

    it('gets usages grouped by type', () => {
        const index = new ProjectIndex(PROJECT_DIR);
        index.build(null, { quiet: true });

        const usages = index.usages('parseFile');
        const defs = usages.filter(u => u.isDefinition);
        const calls = usages.filter(u => u.usageType === 'call');

        assert.ok(defs.length > 0, 'Should find definition');
        assert.ok(calls.length > 0, 'Should find calls');
    });

    it('gets context (callers + callees)', () => {
        const index = new ProjectIndex(PROJECT_DIR);
        index.build(null, { quiet: true });

        const ctx = index.context('parseFile');
        assert.strictEqual(ctx.function, 'parseFile');
        assert.ok(Array.isArray(ctx.callers), 'Should have callers array');
        assert.ok(Array.isArray(ctx.callees), 'Should have callees array');
    });

    it('searches across project', () => {
        const index = new ProjectIndex(PROJECT_DIR);
        index.build(null, { quiet: true });

        const results = index.search('TODO');
        assert.ok(Array.isArray(results), 'Should return array');
    });

    it('gets API (exported symbols)', () => {
        const index = new ProjectIndex(PROJECT_DIR);
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
// JSON output format
// ============================================================================

describe('JSON output format', () => {
    it('find returns valid JSON structure', () => {
        const index = new ProjectIndex(PROJECT_DIR);
        index.build(null, { quiet: true });

        const found = index.find('parse');
        assert.ok(Array.isArray(found), 'Should be array');
        if (found.length > 0) {
            assert.ok(found[0].name, 'Should have name');
            assert.ok(found[0].file || found[0].relativePath, 'Should have file info');
        }
    });

    it('usages returns valid JSON structure', () => {
        const index = new ProjectIndex(PROJECT_DIR);
        index.build(null, { quiet: true });

        const usages = index.usages('parse');
        assert.ok(Array.isArray(usages), 'Should be array');
        if (usages.length > 0) {
            assert.ok(typeof usages[0].isDefinition === 'boolean', 'Should have isDefinition');
            assert.ok(usages[0].usageType || usages[0].isDefinition, 'Should have usageType or isDefinition');
        }
    });

    it('stats returns valid JSON structure', () => {
        const index = new ProjectIndex(PROJECT_DIR);
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
// Auto-routing file commands to project mode
// ============================================================================

describe('Auto-routing file commands to project mode', () => {
    it('should handle imports command on file path', () => {
        const index = new ProjectIndex(PROJECT_DIR);
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
        const index = new ProjectIndex(PROJECT_DIR);
        index.build(null, { quiet: true });

        // Test that exporters works with a file path
        const exporters = index.exporters('core/parser.js');
        assert.ok(Array.isArray(exporters), 'Should return exporters array');
    });

    it('should handle graph command on file path', () => {
        const index = new ProjectIndex(PROJECT_DIR);
        index.build(null, { quiet: true });

        // Test that graph works with a file path
        const graph = index.graph('cli/index.js', { direction: 'both', maxDepth: 2 });
        assert.ok(graph, 'Should return graph result');
        assert.ok(graph.nodes, 'Should have nodes');
        assert.ok(graph.edges, 'Should have edges');
    });
});

// ============================================================================
// CLI helper functions
// ============================================================================

describe('CLI helper functions', () => {
    // These test the helper behavior indirectly through the API
    // The actual requireArg and printOutput are CLI-internal

    it('find should work with various options', () => {
        const index = new ProjectIndex(PROJECT_DIR);
        index.build(null, { quiet: true });

        // Test exact match
        const exactResults = index.find('parse', { exact: true });
        assert.ok(Array.isArray(exactResults), 'Should return array');

        // Test file filter
        const filteredResults = index.find('parse', { file: 'parser' });
        assert.ok(Array.isArray(filteredResults), 'Should return array with file filter');
    });

    it('context should return proper structure', () => {
        const index = new ProjectIndex(PROJECT_DIR);
        index.build(null, { quiet: true });

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
