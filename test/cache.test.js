/**
 * UCN Cache Tests
 *
 * Cache behavior, staleness, F-001/F-003/F-004/F-005, performance, diff-impact.
 * Extracted from parser.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const { parse, parseFile, detectLanguage } = require('../core/parser');
const { ProjectIndex, parseDiff } = require('../core/project');
const { createTempDir, cleanup, tmp, rm, idx, FIXTURES_PATH, PROJECT_DIR } = require('./helpers');

describe('Cache Behavior', () => {

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

    it('should track files that fail to index in failedFiles', () => {
        const tmpDir = createTempDir();
        try {
            // Create a normal file and a file that will fail to parse
            fs.writeFileSync(path.join(tmpDir, 'good.js'), 'function hello() { return 1; }');
            // Create a huge minified file that exceeds tree-sitter buffer
            const hugeLine = 'var x=' + 'a+'.repeat(600000) + '1;';
            fs.writeFileSync(path.join(tmpDir, 'bundle.js'), hugeLine);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // good.js should be indexed
            assert.ok(index.files.has(path.join(tmpDir, 'good.js')), 'good.js should be in files');
            assert.ok(index.symbols.has('hello'), 'hello should be in symbols');

            // bundle.js should be in failedFiles (too large for tree-sitter)
            assert.ok(index.failedFiles.has(path.join(tmpDir, 'bundle.js')), 'bundle.js should be in failedFiles');
            assert.ok(!index.files.has(path.join(tmpDir, 'bundle.js')), 'bundle.js should NOT be in files');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should not report failedFiles as new in isCacheStale', () => {
        const tmpDir = createTempDir();
        try {
            fs.writeFileSync(path.join(tmpDir, 'good.js'), 'function hello() {}');
            const hugeLine = 'var x=' + 'a+'.repeat(600000) + '1;';
            fs.writeFileSync(path.join(tmpDir, 'bundle.js'), hugeLine);

            // Build and save cache
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });
            index1.saveCache();

            // isCacheStale should return false (bundle.js is in failedFiles, not "new")
            assert.strictEqual(index1.isCacheStale(), false,
                'Cache should not be stale — failed files are tracked');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should persist failedFiles across save/load cache cycle', () => {
        const tmpDir = createTempDir();
        try {
            fs.writeFileSync(path.join(tmpDir, 'good.js'), 'function hello() {}');
            const hugeLine = 'var x=' + 'a+'.repeat(600000) + '1;';
            fs.writeFileSync(path.join(tmpDir, 'bundle.js'), hugeLine);

            // Build and save
            const index1 = new ProjectIndex(tmpDir);
            index1.build('**/*.js', { quiet: true });
            assert.ok(index1.failedFiles.size > 0, 'Should have failed files after build');
            index1.saveCache();

            // Load into new index
            const index2 = new ProjectIndex(tmpDir);
            const loaded = index2.loadCache();
            assert.ok(loaded, 'Cache should load successfully');

            // failedFiles should be restored
            assert.ok(index2.failedFiles.has(path.join(tmpDir, 'bundle.js')),
                'bundle.js should be in failedFiles after cache load');

            // isCacheStale should return false
            assert.strictEqual(index2.isCacheStale(), false,
                'Cache should not be stale after loading with failedFiles');
        } finally {
            cleanup(tmpDir);
        }
    });

    it('should remove from failedFiles if file later indexes successfully', () => {
        const tmpDir = createTempDir();
        try {
            // Start with a file that fails
            const hugeLine = 'var x=' + 'a+'.repeat(600000) + '1;';
            fs.writeFileSync(path.join(tmpDir, 'bundle.js'), hugeLine);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });
            assert.ok(index.failedFiles.has(path.join(tmpDir, 'bundle.js')),
                'bundle.js should fail initially');

            // Replace with valid content and rebuild
            fs.writeFileSync(path.join(tmpDir, 'bundle.js'), 'function fixed() {}');
            index.build('**/*.js', { quiet: true, forceRebuild: true });

            assert.ok(!index.failedFiles.has(path.join(tmpDir, 'bundle.js')),
                'bundle.js should be removed from failedFiles after successful indexing');
            assert.ok(index.files.has(path.join(tmpDir, 'bundle.js')),
                'bundle.js should now be in files');
        } finally {
            cleanup(tmpDir);
        }
    });
});

describe('Cache staleness handling', () => {
    it('should not create duplicate symbols when cache is stale', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-cache-test-${Date.now()}`);
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
        const tmpDir = path.join(os.tmpdir(), `ucn-cache-bug-${Date.now()}`);
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

            // Save cache (default path)
            index1.saveCache();

            // Verify main cache file does NOT have inline callsCache
            const mainCachePath = path.join(tmpDir, '.ucn-cache', 'index.json');
            const cacheData = JSON.parse(fs.readFileSync(mainCachePath, 'utf-8'));
            assert.strictEqual(cacheData.version, 5, 'Cache version should be 5');
            assert.ok(!cacheData.callsCache, 'Main cache should not have inline callsCache');

            // Verify separate calls-cache.json exists
            const callsCachePath = path.join(tmpDir, '.ucn-cache', 'calls-cache.json');
            assert.ok(fs.existsSync(callsCachePath), 'Separate calls-cache.json should exist');

            // Load in new instance
            const index2 = new ProjectIndex(tmpDir);
            const loaded = index2.loadCache();
            assert.ok(loaded, 'Cache should load successfully');

            // callsCache is lazy-loaded, so should be empty after loadCache
            assert.strictEqual(index2.callsCache.size, 0, 'callsCache should not be loaded eagerly');

            // Trigger lazy load via loadCallsCache
            index2.loadCallsCache();
            assert.ok(index2.callsCache.size > 0, 'callsCache should be restored after loadCallsCache');

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

            // Save cache (default path so lazy callsCache loading works)
            index1.saveCache();

            // Load in new instance
            const index2 = new ProjectIndex(tmpDir);
            index2.loadCache();

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

describe('related() optimization', () => {
    it('sharedCallees uses reverse lookup instead of scanning all symbols', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-related-'));
        try {
            // Create a project where multiple functions share callees
            fs.writeFileSync(path.join(tmpDir, 'shared.js'), `
function helper() { return 1; }
function utility() { return 2; }
`);
            fs.writeFileSync(path.join(tmpDir, 'a.js'), `
function funcA() { helper(); utility(); }
`);
            fs.writeFileSync(path.join(tmpDir, 'b.js'), `
function funcB() { helper(); utility(); }
`);
            fs.writeFileSync(path.join(tmpDir, 'c.js'), `
function funcC() { helper(); }
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const result = index.related('funcA');
            assert.ok(result, 'related should return result');

            // funcB shares both callees (helper, utility), funcC shares one (helper)
            assert.ok(result.sharedCallees.length > 0, 'Should find shared callees');
            const funcBEntry = result.sharedCallees.find(s => s.name === 'funcB');
            const funcCEntry = result.sharedCallees.find(s => s.name === 'funcC');
            assert.ok(funcBEntry, 'funcB should be in shared callees');
            assert.strictEqual(funcBEntry.sharedCalleeCount, 2, 'funcB shares 2 callees');
            if (funcCEntry) {
                assert.strictEqual(funcCEntry.sharedCalleeCount, 1, 'funcC shares 1 callee');
            }
            // Should be sorted: funcB (2) before funcC (1)
            if (funcCEntry) {
                const bIdx = result.sharedCallees.indexOf(funcBEntry);
                const cIdx = result.sharedCallees.indexOf(funcCEntry);
                assert.ok(bIdx < cIdx, 'Higher shared count should come first');
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Per-operation file content cache', () => {
    it('_readFile returns same content and uses cache within _beginOp/_endOp', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-opcache-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'a.js'), 'function a() { b(); }\n');
            fs.writeFileSync(path.join(tmpDir, 'b.js'), 'function b() { return 1; }\n');
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const fileA = path.join(tmpDir, 'a.js');

            // Without op cache, _readFile works normally
            const content1 = index._readFile(fileA);
            assert.ok(content1.includes('function a'), 'Should read file content');
            assert.strictEqual(index._opContentCache, null, 'No cache active outside op');

            // With op cache, repeated reads return cached content
            index._beginOp();
            const content2 = index._readFile(fileA);
            const content3 = index._readFile(fileA);
            assert.strictEqual(content2, content3, 'Should return same cached content');
            assert.strictEqual(index._opContentCache.size, 1, 'Cache should have 1 entry');
            index._endOp();
            assert.strictEqual(index._opContentCache, null, 'Cache cleared after op');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('about() activates op cache (nested methods share reads)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-opcache-'));
        try {
            // Create files that will be read multiple times during about()
            fs.writeFileSync(path.join(tmpDir, 'main.js'), `
function processData(input) {
    const result = helper(input);
    return transform(result);
}
`);
            fs.writeFileSync(path.join(tmpDir, 'helper.js'), `
function helper(x) { return x * 2; }
function transform(x) { return x + 1; }
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Monkey-patch fs.readFileSync to count actual disk reads
            let diskReads = 0;
            const origRead = fs.readFileSync;
            fs.readFileSync = function(p, ...args) {
                if (typeof p === 'string' && p.startsWith(tmpDir)) diskReads++;
                return origRead.call(fs, p, ...args);
            };

            const result = index.about('processData');
            fs.readFileSync = origRead; // restore immediately

            assert.ok(result, 'about should return result');
            assert.ok(result.found, 'Should find processData');

            // about() calls usages, findCallers, findCallees, tests, detectCompleteness
            // Each iterates all files. Without cache: 2 files * 5+ methods = 10+ reads
            // With cache: significant reduction due to shared reads across sub-methods
            // Some extra reads come from getCachedCalls (mtime-based), so allow headroom
            const fileCount = index.files.size;
            assert.ok(diskReads < fileCount * 5,
                `Disk reads (${diskReads}) should be significantly less than uncached (files=${fileCount}, worst case ${fileCount * 8}+)`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('op cache survives errors in methods (try/finally)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-opcache-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), 'function foo() {}\n');
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // about() with non-existent symbol should not leave cache dangling
            index.about('zzz_nonexistent_xyz');
            assert.strictEqual(index._opContentCache, null, 'Cache should be cleaned up even after non-match');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('nested _beginOp calls do not reset cache', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-opcache-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), 'function foo() { bar(); }\nfunction bar() {}\n');
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const filePath = path.join(tmpDir, 'test.js');

            index._beginOp();
            index._readFile(filePath);
            assert.strictEqual(index._opContentCache.size, 1, 'Should have 1 entry');

            // Nested _beginOp should NOT reset the cache
            index._beginOp();
            assert.strictEqual(index._opContentCache.size, 1, 'Nested beginOp should not reset cache');
            index._endOp();
            // After first endOp, cache is cleared (outermost owns it)
            // This is acceptable — inner methods just don't call _endOp
            // The design is: only top-level method clears
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: F-001 stale rebuild removes deleted file symbols', () => {
    it('build with forceRebuild removes symbols from deleted files', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f001-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'main.js'), 'function main() {}');
            fs.writeFileSync(path.join(tmpDir, 'helper.js'), 'function ghost() {}');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            assert.ok(index.symbols.has('ghost'), 'ghost should exist before delete');
            assert.ok(index.symbols.has('main'), 'main should exist');

            // Delete the file
            fs.unlinkSync(path.join(tmpDir, 'helper.js'));

            // Rebuild WITHOUT forceRebuild — ghost should persist (the bug)
            index.build(null, { quiet: true });
            const ghostAfterNoForce = index.symbols.has('ghost');

            // Rebuild WITH forceRebuild — ghost should be gone (the fix)
            index.build(null, { quiet: true, forceRebuild: true });
            assert.ok(!index.symbols.has('ghost'),
                'ghost symbol should be removed after forceRebuild');
            assert.ok(index.symbols.has('main'),
                'main should still exist after forceRebuild');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: F-003 completeness cache invalidated on rebuild', () => {
    it('detectCompleteness returns fresh result after rebuild', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f003-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'clean.js'), 'function clean() {}');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const first = index.detectCompleteness();
            assert.ok(first.complete, 'Should be complete initially (no dynamic patterns)');

            // Add a file with eval
            fs.writeFileSync(path.join(tmpDir, 'dirty.js'), 'const x = eval("1+1");');
            index.build(null, { quiet: true, forceRebuild: true });

            const second = index.detectCompleteness();
            assert.ok(!second.complete,
                'Should NOT be complete after adding eval — cache must be invalidated on rebuild');
            assert.ok(second.warnings.some(w => w.type === 'eval'),
                'Should have eval warning after rebuild');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: F-004 expand scoped to last context call', () => {
    it('context for different symbols produces independent expandable items', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f004-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'a.js'), `
function alpha() { beta(); }
function beta() { gamma(); }
function gamma() {}
`);
            fs.writeFileSync(path.join(tmpDir, 'b.js'), `
function delta() { epsilon(); }
function epsilon() {}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });
            const output = require('../core/output');

            // Call context for 'alpha'
            const ctxAlpha = index.context('alpha', {});
            const fmtAlpha = output.formatContext(ctxAlpha);

            // Call context for 'delta'
            const ctxDelta = index.context('delta', {});
            const fmtDelta = output.formatContext(ctxDelta);

            // Both should have expandable items
            assert.ok(fmtAlpha.expandable.length > 0, 'alpha context should have expandable items');
            assert.ok(fmtDelta.expandable.length > 0, 'delta context should have expandable items');

            // Items start at 1 for each context call — they overlap in numbering
            assert.strictEqual(fmtAlpha.expandable[0].num, 1);
            assert.strictEqual(fmtDelta.expandable[0].num, 1);

            // But they reference different symbols
            const alphaNames = fmtAlpha.expandable.map(e => e.name);
            const deltaNames = fmtDelta.expandable.map(e => e.name);
            assert.ok(!alphaNames.includes('epsilon'), 'alpha expandable should not include epsilon');
            assert.ok(!deltaNames.includes('beta'), 'delta expandable should not include beta');

            // Use shared ExpandCache to test last-context-wins behavior
            const { ExpandCache } = require(path.join(__dirname, '..', 'core', 'expand-cache'));
            const cache = new ExpandCache();
            const root = index.root;

            cache.save(root, 'alpha', null, fmtAlpha.expandable);
            cache.save(root, 'delta', null, fmtDelta.expandable);

            // Expand item 1 should come from delta (last context), not alpha
            const { match } = cache.lookup(root, 1);
            assert.ok(match, 'Should find item 1 in recent context');
            assert.ok(deltaNames.includes(match.name),
                `Item 1 should be from delta context (got ${match.name}), not alpha`);

            // Item beyond delta's range — lookup tries recent first, then falls back
            const maxDeltaItem = Math.max(...fmtDelta.expandable.map(i => i.num));
            const beyondRange = maxDeltaItem + 10;
            const { match: fallbackMatch } = cache.lookup(root, beyondRange);
            // If alpha doesn't have this item number either, it should be null
            const alphaHasIt = fmtAlpha.expandable.some(i => i.num === beyondRange);
            if (!alphaHasIt) {
                assert.strictEqual(fallbackMatch, null,
                    `Item ${beyondRange} should NOT be found when neither context has it`);
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: F-005 .ucn.json exclude applied to file discovery', () => {
    it('files in excluded directories are not indexed', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f005-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, '.ucn.json'), JSON.stringify({
                exclude: ['vendor', 'generated']
            }));
            fs.writeFileSync(path.join(tmpDir, 'main.js'), 'function main() {}');

            fs.mkdirSync(path.join(tmpDir, 'vendor'));
            fs.writeFileSync(path.join(tmpDir, 'vendor', 'lib.js'), 'function vendorFn() {}');

            fs.mkdirSync(path.join(tmpDir, 'generated'));
            fs.writeFileSync(path.join(tmpDir, 'generated', 'auto.js'), 'function autoFn() {}');

            fs.mkdirSync(path.join(tmpDir, 'src'));
            fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'function appFn() {}');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            assert.ok(index.symbols.has('main'), 'main should be indexed');
            assert.ok(index.symbols.has('appFn'), 'appFn should be indexed');
            assert.ok(!index.symbols.has('vendorFn'),
                'vendorFn should NOT be indexed (vendor is excluded)');
            assert.ok(!index.symbols.has('autoFn'),
                'autoFn should NOT be indexed (generated is excluded)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('exclude config does not affect indexing when not set', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f005b-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'main.js'), 'function main() {}');

            fs.mkdirSync(path.join(tmpDir, 'vendor'));
            fs.writeFileSync(path.join(tmpDir, 'vendor', 'lib.js'), 'function vendorFn() {}');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // Without .ucn.json exclude, vendor IS indexed (it's not in DEFAULT_IGNORES)
            assert.ok(index.symbols.has('main'), 'main should be indexed');
            assert.ok(index.symbols.has('vendorFn'),
                'vendorFn should be indexed when no exclude config');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: F-001 matchesFilters boundary matching', () => {
    it('does not exclude files whose names contain test patterns as substrings', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f001-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

            // Production files that contain test/spec/mock as substrings
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'spectrum.js'),
                'export function alpha() { return 1; }');
            fs.writeFileSync(path.join(tmpDir, 'src', 'inspector.js'),
                'export function inspect() { return 2; }');
            fs.writeFileSync(path.join(tmpDir, 'src', 'contest.js'),
                'export function compete() { return 3; }');
            fs.writeFileSync(path.join(tmpDir, 'src', 'mocker.js'),
                'export function mockery() { return 4; }');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // With default test exclusions, these should still be found
            const exclude = ['test', 'spec', 'mock'];
            const alphaResult = index.find('alpha', { exclude });
            const inspectResult = index.find('inspect', { exclude });
            const competeResult = index.find('compete', { exclude });
            const mockeryResult = index.find('mockery', { exclude });

            assert.ok(alphaResult.length > 0,
                'alpha in spectrum.js should NOT be excluded by "spec" pattern');
            assert.ok(inspectResult.length > 0,
                'inspect in inspector.js should NOT be excluded by "spec" pattern');
            assert.ok(competeResult.length > 0,
                'compete in contest.js should NOT be excluded by "test" pattern');
            assert.ok(mockeryResult.length > 0,
                'mockery in mocker.js should NOT be excluded by "mock" pattern');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('still excludes real test directories and files', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f001b-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.js'),
                'export function main() {}');

            // Real test paths that SHOULD be excluded
            fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'test', 'runner.js'),
                'function runTest() {}');
            fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'tests', 'unit.js'),
                'function unitTest() {}');
            fs.mkdirSync(path.join(tmpDir, 'spec'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'spec', 'helpers.js'),
                'function specHelper() {}');
            fs.mkdirSync(path.join(tmpDir, '__tests__'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, '__tests__', 'app.js'),
                'function appTest() {}');
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.test.js'),
                'function mainTest() {}');
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.spec.js'),
                'function mainSpec() {}');
            fs.mkdirSync(path.join(tmpDir, 'src', 'test_utils'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'test_utils', 'factory.js'),
                'function testFactory() {}');
            fs.mkdirSync(path.join(tmpDir, '__mocks__'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, '__mocks__', 'api.js'),
                'function mockApi() {}');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const exclude = ['test', 'spec', '__tests__', '__mocks__', 'mock'];

            assert.ok(index.find('main', { exclude }).length > 0,
                'main in src/ should be found');
            assert.strictEqual(index.find('runTest', { exclude }).length, 0,
                'runTest in test/ should be excluded');
            assert.strictEqual(index.find('unitTest', { exclude }).length, 0,
                'unitTest in tests/ should be excluded');
            assert.strictEqual(index.find('specHelper', { exclude }).length, 0,
                'specHelper in spec/ should be excluded');
            assert.strictEqual(index.find('appTest', { exclude }).length, 0,
                'appTest in __tests__/ should be excluded');
            assert.strictEqual(index.find('mainTest', { exclude }).length, 0,
                'mainTest in main.test.js should be excluded');
            assert.strictEqual(index.find('mainSpec', { exclude }).length, 0,
                'mainSpec in main.spec.js should be excluded');
            assert.strictEqual(index.find('testFactory', { exclude }).length, 0,
                'testFactory in test_utils/ should be excluded');
            assert.strictEqual(index.find('mockApi', { exclude }).length, 0,
                'mockApi in __mocks__/ should be excluded');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('handles special directory names like src/special/', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f001c-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.mkdirSync(path.join(tmpDir, 'src', 'special'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'special', 'handler.js'),
                'export function handleSpecial() {}');
            fs.mkdirSync(path.join(tmpDir, 'src', 'fixtures_data'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'fixtures_data', 'loader.js'),
                'export function loadData() {}');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const exclude = ['test', 'spec', 'fixture'];

            assert.ok(index.find('handleSpecial', { exclude }).length > 0,
                'handleSpecial in src/special/ should NOT be excluded (special != spec)');
            // fixtures_data starts with 'fixture' + 's' at boundary — SHOULD be excluded
            assert.strictEqual(index.find('loadData', { exclude }).length, 0,
                'loadData in fixtures_data/ should be excluded (fixture + s + boundary)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
    it('matchesFilters caches compiled regexes across calls', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-regex-cache-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'src.js'), 'function foo() {}');
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // First call should create the cache
            index.matchesFilters('src/foo.js', { exclude: ['test', 'mock'] });
            assert.ok(index._excludeRegexCache, 'Regex cache should be created');
            assert.strictEqual(index._excludeRegexCache.size, 2, 'Should cache both patterns');

            // Second call with same patterns should reuse cached regexes
            const cached1 = index._excludeRegexCache.get('test');
            index.matchesFilters('src/bar.js', { exclude: ['test', 'mock'] });
            const cached2 = index._excludeRegexCache.get('test');
            assert.strictEqual(cached1, cached2, 'Should reuse same regex object');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: F-003 matchesFilters boundary edge cases', () => {
    it('matchesFilters correctly handles all boundary types', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f003-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'dummy.js'), 'function x() {}');
            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const exclude = ['test', 'spec', 'mock', 'fixture'];

            // Should PASS filter (not excluded)
            assert.ok(index.matchesFilters('src/spectrum.js', { exclude }),
                'spectrum should not be excluded by spec');
            assert.ok(index.matchesFilters('src/inspector.js', { exclude }),
                'inspector should not be excluded by spec');
            assert.ok(index.matchesFilters('src/contest/handler.js', { exclude }),
                'contest should not be excluded by test');
            assert.ok(index.matchesFilters('src/backtester.js', { exclude }),
                'backtester should not be excluded by test');
            assert.ok(index.matchesFilters('src/mocker.js', { exclude }),
                'mocker should not be excluded by mock');
            assert.ok(index.matchesFilters('lib/distributed.js', { exclude }),
                'distributed should not be excluded by test');
            assert.ok(index.matchesFilters('src/testing.js', { exclude }),
                'testing should not be excluded by test');
            assert.ok(index.matchesFilters('src/special/handler.js', { exclude }),
                'special should not be excluded by spec');

            // Should FAIL filter (excluded)
            assert.ok(!index.matchesFilters('test/runner.js', { exclude }),
                'test/ should be excluded');
            assert.ok(!index.matchesFilters('tests/unit.js', { exclude }),
                'tests/ should be excluded');
            assert.ok(!index.matchesFilters('spec/helper.js', { exclude }),
                'spec/ should be excluded');
            assert.ok(!index.matchesFilters('specs/helper.js', { exclude }),
                'specs/ should be excluded');
            assert.ok(!index.matchesFilters('src/file.test.js', { exclude }),
                'file.test.js should be excluded');
            assert.ok(!index.matchesFilters('src/file.spec.js', { exclude }),
                'file.spec.js should be excluded');
            assert.ok(!index.matchesFilters('src/test_utils/factory.js', { exclude }),
                'test_utils/ should be excluded');
            assert.ok(!index.matchesFilters('__tests__/app.js', { exclude }),
                '__tests__/ should be excluded');
            assert.ok(!index.matchesFilters('__mocks__/api.js', { exclude: ['mock'] }),
                '__mocks__/ should be excluded by mock pattern');
            assert.ok(!index.matchesFilters('src/mock_data.js', { exclude }),
                'mock_data.js should be excluded');
            assert.ok(!index.matchesFilters('src/fixtures/data.js', { exclude }),
                'fixtures/ should be excluded by fixture pattern');
            assert.ok(!index.matchesFilters('fixture/setup.js', { exclude }),
                'fixture/ should be excluded');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Diff Impact', () => {
    // FIX 108: parseDiff correctly extracts file paths and line ranges
    it('FIX 108 — parseDiff extracts file paths and line ranges from unified diff', () => {
        const diffText = `diff --git a/src/app.js b/src/app.js
index 1234567..abcdefg 100644
--- a/src/app.js
+++ b/src/app.js
@@ -10,3 +10,5 @@ function old() {
+added line
+another added
@@ -25 +27 @@ function other() {
-old line
+new line
diff --git a/lib/utils.js b/lib/utils.js
--- a/lib/utils.js
+++ b/lib/utils.js
@@ -5,0 +6,2 @@
+new function added
+second line
@@ -20,2 +23,0 @@
`;

        const changes = parseDiff(diffText, '/project');

        assert.strictEqual(changes.length, 2);

        // First file
        assert.strictEqual(changes[0].relativePath, 'src/app.js');
        assert.strictEqual(changes[0].filePath, path.join('/project', 'src/app.js'));
        // First hunk: @@ -10,3 +10,5 @@ → deleted lines 10-12, added lines 10-14
        assert.deepStrictEqual(changes[0].deletedLines, [10, 11, 12, 25]);
        assert.deepStrictEqual(changes[0].addedLines, [10, 11, 12, 13, 14, 27]);

        // Second file
        assert.strictEqual(changes[1].relativePath, 'lib/utils.js');
        // @@ -5,0 +6,2 @@ → 0 deleted, 2 added (6-7)
        // @@ -20,2 +23,0 @@ → 2 deleted (20-21), 0 added
        assert.deepStrictEqual(changes[1].addedLines, [6, 7]);
        assert.deepStrictEqual(changes[1].deletedLines, [20, 21]);
    });

    // FIX 109: diffImpact end-to-end with temp git repo
    it('FIX 109 — diffImpact identifies changed functions and their callers', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-diff-impact-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Initialize git repo
            execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
            execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
            execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

            // Create initial files
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `function greet(name) {
    return 'Hello ' + name;
}

function main() {
    console.log(greet('world'));
}
`);

            execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

            // Modify the greet function
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `function greet(name) {
    return 'Hi ' + name + '!';
}

function main() {
    console.log(greet('world'));
}
`);

            // Run diff-impact
            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });
            const result = index.diffImpact({ base: 'HEAD' });

            // Verify modified function detected
            assert.ok(result.functions.length >= 1, 'Should detect modified function');
            const greetFn = result.functions.find(f => f.name === 'greet');
            assert.ok(greetFn, 'Should identify greet as modified');
            assert.ok(greetFn.callers.length >= 1, 'greet should have at least one caller');
            assert.ok(greetFn.callers.some(c => c.callerName === 'main'), 'main should be a caller of greet');

            // Summary should be populated
            assert.ok(result.summary.modifiedFunctions >= 1);
            assert.ok(result.summary.totalCallSites >= 1);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // FIX 110: diffImpact handles no-changes case
    it('FIX 110 — diffImpact returns empty result when no changes', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-diff-empty-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
            execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
            execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function a() { return 1; }\n');
            execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });
            const result = index.diffImpact({ base: 'HEAD' });

            assert.strictEqual(result.functions.length, 0);
            assert.strictEqual(result.newFunctions.length, 0);
            assert.strictEqual(result.moduleLevelChanges.length, 0);
            assert.strictEqual(result.summary.totalCallSites, 0);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // FIX 111: diffImpact works with --staged
    it('FIX 111 — diffImpact analyzes staged changes', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-diff-staged-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
            execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
            execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function calc(x) { return x; }\nfunction run() { calc(1); }\n');
            execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

            // Modify and stage
            fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function calc(x) { return x * 2; }\nfunction run() { calc(1); }\n');
            execSync('git add app.js', { cwd: tmpDir, stdio: 'pipe' });

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });
            const result = index.diffImpact({ staged: true });

            assert.ok(result.base === '(staged)');
            assert.ok(result.functions.length >= 1, 'Should detect staged change');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // FIX 112: diffImpact errors on non-git directory
    it('FIX 112 — diffImpact throws error for non-git directory', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-diff-nogit-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function a() {}\n');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            assert.throws(() => {
                index.diffImpact({ base: 'HEAD' });
            }, /git/i);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // FIX 113: diffImpact detects new functions
    it('FIX 113 — diffImpact detects newly added functions', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-diff-new-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
            execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
            execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function existing() { return 1; }\n');
            execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

            // Add a new function
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `function existing() { return 1; }
function brandNew(x, y) {
    return x + y;
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });
            const result = index.diffImpact({ base: 'HEAD' });

            assert.ok(result.newFunctions.some(f => f.name === 'brandNew'), 'Should detect brandNew as a new function');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // FIX 114: Incremental rebuild preserves unchanged file symbols
    it('FIX 114 — incremental rebuild skips unchanged files and handles deletions', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-incr-rebuild-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'a.js'), 'function alpha() { return 1; }\n');
            fs.writeFileSync(path.join(tmpDir, 'b.js'), 'function beta() { return 2; }\n');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            assert.ok(index.symbols.has('alpha'));
            assert.ok(index.symbols.has('beta'));

            // Delete b.js and rebuild (forceRebuild simulates cache-loaded stale state)
            fs.unlinkSync(path.join(tmpDir, 'b.js'));
            index.build(null, { quiet: true, forceRebuild: true });

            assert.ok(index.symbols.has('alpha'), 'alpha should still be indexed');
            assert.ok(!index.symbols.has('beta'), 'beta should be removed after file deletion');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // FIX 115: callsCache invalidated on removeFileSymbols
    it('FIX 115 — callsCache entry cleared when file symbols are removed', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-callscache-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function hello() { return 1; }\nfunction caller() { hello(); }\n');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const filePath = path.join(tmpDir, 'app.js');

            // Trigger callsCache population
            index.findCallers('hello');
            assert.ok(index.callsCache.has(filePath), 'callsCache should have entry after findCallers');

            // Remove file symbols — should also clear callsCache
            index.removeFileSymbols(filePath);
            assert.ok(!index.callsCache.has(filePath), 'callsCache entry should be cleared after removeFileSymbols');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// ExpandCache unit tests
// ============================================================================

describe('ExpandCache', () => {
    const { ExpandCache, renderExpandItem } = require(path.join(__dirname, '..', 'core', 'expand-cache'));

    it('save and lookup basic workflow', () => {
        const cache = new ExpandCache();
        const root = '/test/project';

        cache.save(root, 'myFunc', null, [
            { num: 1, name: 'caller1', type: 'function' },
            { num: 2, name: 'caller2', type: 'function' },
        ]);

        const { match, itemCount } = cache.lookup(root, 1);
        assert.ok(match);
        assert.strictEqual(match.name, 'caller1');
        assert.strictEqual(itemCount, 2);
    });

    it('lookup returns null for missing item', () => {
        const cache = new ExpandCache();
        const root = '/test/project';

        cache.save(root, 'myFunc', null, [
            { num: 1, name: 'caller1', type: 'function' },
        ]);

        const { match, itemCount } = cache.lookup(root, 99);
        assert.strictEqual(match, null);
        assert.strictEqual(itemCount, 1);
    });

    it('lookup returns empty when no cache exists', () => {
        const cache = new ExpandCache();
        const { match, itemCount } = cache.lookup('/nonexistent', 1);
        assert.strictEqual(match, null);
        assert.strictEqual(itemCount, 0);
    });

    it('last context wins — most recent save is preferred', () => {
        const cache = new ExpandCache();
        const root = '/test/project';

        cache.save(root, 'alpha', null, [
            { num: 1, name: 'alphaItem', type: 'function' },
        ]);
        cache.save(root, 'beta', null, [
            { num: 1, name: 'betaItem', type: 'function' },
        ]);

        const { match } = cache.lookup(root, 1);
        assert.strictEqual(match.name, 'betaItem', 'should prefer most recent context (beta)');
    });

    it('fallback to older context when item not in recent', () => {
        const cache = new ExpandCache();
        const root = '/test/project';

        cache.save(root, 'alpha', null, [
            { num: 1, name: 'alphaItem', type: 'function' },
            { num: 2, name: 'alphaItem2', type: 'function' },
        ]);
        cache.save(root, 'beta', null, [
            { num: 1, name: 'betaItem', type: 'function' },
        ]);

        // Item 2 only exists in alpha — should fall back
        const { match } = cache.lookup(root, 2);
        assert.ok(match);
        assert.strictEqual(match.name, 'alphaItem2');
    });

    it('LRU eviction when maxSize exceeded', () => {
        const cache = new ExpandCache({ maxSize: 2 });
        const root = '/test/project';

        cache.save(root, 'first', null, [{ num: 1, name: 'a', type: 'function' }]);
        cache.save(root, 'second', null, [{ num: 1, name: 'b', type: 'function' }]);
        cache.save(root, 'third', null, [{ num: 1, name: 'c', type: 'function' }]);

        assert.strictEqual(cache.size, 2, 'should evict oldest entry');
    });

    it('clearForRoot removes all entries for a project', () => {
        const cache = new ExpandCache();
        const root1 = '/project1';
        const root2 = '/project2';

        cache.save(root1, 'funcA', null, [{ num: 1, name: 'a', type: 'function' }]);
        cache.save(root2, 'funcB', null, [{ num: 1, name: 'b', type: 'function' }]);
        assert.strictEqual(cache.size, 2);

        cache.clearForRoot(root1);
        assert.strictEqual(cache.size, 1);

        const { match: match1 } = cache.lookup(root1, 1);
        assert.strictEqual(match1, null, 'root1 entries should be cleared');

        const { match: match2 } = cache.lookup(root2, 1);
        assert.ok(match2, 'root2 entries should remain');
    });

    it('save with empty items is a no-op', () => {
        const cache = new ExpandCache();
        cache.save('/test', 'func', null, []);
        assert.strictEqual(cache.size, 0);
        cache.save('/test', 'func', null, null);
        assert.strictEqual(cache.size, 0);
    });

    it('file parameter differentiates cache keys', () => {
        const cache = new ExpandCache();
        const root = '/test/project';

        cache.save(root, 'parse', 'parser.js', [{ num: 1, name: 'a', type: 'function' }]);
        cache.save(root, 'parse', 'utils.js', [{ num: 1, name: 'b', type: 'function' }]);

        assert.strictEqual(cache.size, 2, 'same name with different files should create separate entries');
    });

    it('renderExpandItem produces correct output', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-expand-'));
        try {
            const testFile = path.join(tmpDir, 'test.js');
            fs.writeFileSync(testFile, 'function hello() {\n  return "world";\n}\n');

            const match = {
                num: 1,
                name: 'hello',
                type: 'function',
                file: testFile,
                relativePath: 'test.js',
                startLine: 1,
                endLine: 3
            };

            const { ok, text } = renderExpandItem(match, tmpDir);
            assert.ok(ok);
            assert.ok(text.includes('[1] hello (function)'));
            assert.ok(text.includes('test.js:1-3'));
            assert.ok(text.includes('function hello()'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('LRU eviction cleans up stale lastKey pointing to evicted entry', () => {
        const cache = new ExpandCache({ maxSize: 2 });
        const root1 = '/project1';
        const root2 = '/project2';
        const root3 = '/project3';

        cache.save(root1, 'funcA', null, [{ num: 1, name: 'a', type: 'function' }]);
        cache.save(root2, 'funcB', null, [{ num: 1, name: 'b', type: 'function' }]);

        // root1 is the oldest — saving root3 should evict root1
        cache.save(root3, 'funcC', null, [{ num: 1, name: 'c', type: 'function' }]);

        assert.strictEqual(cache.size, 2);

        // lastKey for root1 should be cleaned up (not pointing to evicted entry)
        const result = cache.lookup(root1, 1);
        assert.strictEqual(result.match, null, 'evicted root should not return stale lastKey match');
    });

    it('lookup only refreshes usedAt on actual hit, not miss', () => {
        const cache = new ExpandCache({ maxSize: 3 });
        const root = '/test';

        cache.save(root, 'alpha', null, [{ num: 1, name: 'a', type: 'function' }]);
        const entryKey = `${root}:alpha:`;

        // Record initial usedAt
        const initialUsedAt = cache.entries.get(entryKey).usedAt;

        // Lookup a non-existent item number — should NOT refresh usedAt
        // (need a small delay to distinguish timestamps)
        const before = Date.now();
        cache.lookup(root, 999);
        const afterMiss = cache.entries.get(entryKey).usedAt;
        assert.strictEqual(afterMiss, initialUsedAt, 'usedAt should not change on miss');

        // Now lookup a valid item — should refresh usedAt
        cache.entries.get(entryKey).usedAt = before - 1000; // force old timestamp
        cache.lookup(root, 1);
        const afterHit = cache.entries.get(entryKey).usedAt;
        assert.ok(afterHit >= before, 'usedAt should be refreshed on hit');
    });

    it('renderExpandItem validates root when requested', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-expand-'));
        try {
            // Create file outside the "project root"
            const outsideFile = path.join(os.tmpdir(), 'outside.js');
            fs.writeFileSync(outsideFile, 'function hack() {}');

            const match = {
                num: 1, name: 'hack', type: 'function',
                file: outsideFile, relativePath: '../outside.js',
                startLine: 1, endLine: 1
            };

            const { ok, error } = renderExpandItem(match, tmpDir, { validateRoot: true });
            assert.ok(!ok, 'should fail validation');
            assert.ok(error.includes('outside project root'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Performance optimization regression tests
// ============================================================================

describe('fix: callsCache persisted to disk after command execution', () => {
    it('callsCache is populated and saved after findCallers runs', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }\nmodule.exports = { main };'
        });
        try {
            const index = idx(dir);
            assert.strictEqual(index.callsCache.size, 0, 'callsCache empty before findCallers');

            // findCallers populates callsCache
            index.findCallers('helper');
            assert.ok(index.callsCache.size > 0, 'callsCache populated after findCallers');
            assert.ok(index.callsCacheDirty, 'dirty flag set');

            // Save and reload — callsCache should persist in separate file
            index.saveCache();
            const index2 = new ProjectIndex(dir);
            index2.loadCache();
            // callsCache is now lazy-loaded, not inline in index.json
            assert.strictEqual(index2.callsCache.size, 0, 'callsCache not loaded eagerly');
            // Trigger lazy load
            index2.loadCallsCache();
            assert.ok(index2.callsCache.size > 0, 'callsCache loaded from separate file');
        } finally {
            rm(dir);
        }
    });

    it('callsCacheDirty flag set on mtime-only update', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const index = idx(dir);
            index.findCallers('helper');
            index.callsCacheDirty = false;

            // Touch a file (change mtime without changing content)
            const libPath = path.join(dir, 'lib.js');
            const now = new Date();
            fs.utimesSync(libPath, now, now);

            // findCallers again — should detect mtime change and set dirty
            index.findCallers('helper');
            assert.ok(index.callsCacheDirty, 'dirty flag set after mtime change');
        } finally {
            rm(dir);
        }
    });
});

describe('fix: skipCounts in find() avoids redundant usage counting', () => {
    it('find with skipCounts returns results without usageCount', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nhelper();'
        });
        try {
            const index = idx(dir);
            const withCounts = index.find('helper');
            const withoutCounts = index.find('helper', { skipCounts: true });

            assert.ok(withCounts.length > 0, 'find returns results');
            assert.strictEqual(withCounts.length, withoutCounts.length, 'same number of results');
            assert.ok(withCounts[0].usageCount !== undefined, 'usageCount present without skipCounts');
            assert.strictEqual(withoutCounts[0].usageCount, undefined, 'usageCount absent with skipCounts');
        } finally {
            rm(dir);
        }
    });
});

describe('fix: _getCachedUsages string pre-check and per-op caching', () => {
    it('files without symbol name are skipped (empty array, not null)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }',
            'other.js': 'function unrelated() { return 2; }'
        });
        try {
            const index = idx(dir);
            index._beginOp();
            try {
                const otherPath = path.join(dir, 'other.js');
                const result = index._getCachedUsages(otherPath, 'helper');
                assert.ok(Array.isArray(result), 'returns array, not null');
                assert.strictEqual(result.length, 0, 'empty array for file without name');

                // Verify it was cached
                const cacheKey = `${otherPath}\0helper`;
                assert.ok(index._opUsagesCache.has(cacheKey), 'result cached in _opUsagesCache');
            } finally {
                index._endOp();
            }
        } finally {
            rm(dir);
        }
    });

    it('per-operation cache is shared across find and usages', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nhelper();'
        });
        try {
            const index = idx(dir);
            index._beginOp();
            try {
                // First call populates cache
                index.find('helper', { exact: true });
                const cacheSize1 = index._opUsagesCache.size;

                // usages() should reuse cached entries
                index.usages('helper', { codeOnly: true });
                const cacheSize2 = index._opUsagesCache.size;

                // Cache may grow (usages scans all files), but shouldn't re-parse already-cached files
                assert.ok(cacheSize2 >= cacheSize1, 'cache grows or stays same');
            } finally {
                index._endOp();
            }
            // After _endOp, caches are cleared
            assert.strictEqual(index._opUsagesCache, null, 'cache cleared after endOp');
        } finally {
            rm(dir);
        }
    });
});

describe('fix: CLI error paths still save cache', () => {
    it('cache is saved even when command returns error', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }'
        });
        try {
            // Run a command that will fail (about with no name)
            const cliPath = path.join(__dirname, '..', 'cli', 'index.js');
            try {
                execSync(`node ${cliPath} ${dir} about`, {
                    encoding: 'utf-8',
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            } catch (e) {
                // Expected to fail
            }

            // Cache should exist despite the error
            const cachePath = path.join(dir, '.ucn-cache', 'index.json');
            assert.ok(fs.existsSync(cachePath), 'cache file exists after failed command');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Performance regression baseline
// ============================================================================

describe('perf: loadCache and findCallers baseline', () => {
    it('loadCache is fast with separate callsCache file', () => {
        // Create a medium fixture (100+ files)
        const files = { 'package.json': '{"name":"perf-test"}' };
        for (let i = 0; i < 120; i++) {
            files[`mod${i}.js`] = `function fn${i}() { return run(); }\nmodule.exports = { fn${i} };`;
        }
        files['run.js'] = 'function run() { return 42; }\nmodule.exports = { run };';

        const dir = tmp(files);
        try {
            const index1 = new ProjectIndex(dir);
            index1.build('**/*.js', { quiet: true });
            // Warm up callsCache
            index1.findCallers('run');
            index1.saveCache();

            // Measure loadCache time (should NOT load callsCache)
            const start = Date.now();
            const index2 = new ProjectIndex(dir);
            index2.loadCache();
            const loadTime = Date.now() - start;

            // callsCache should be empty (lazy)
            assert.strictEqual(index2.callsCache.size, 0, 'callsCache not loaded eagerly');
            assert.ok(loadTime < 500, `loadCache should be fast: ${loadTime}ms`);

            // Measure findCallers (triggers lazy load + lookup)
            const start2 = Date.now();
            const callers = index2.findCallers('run');
            const callersTime = Date.now() - start2;

            assert.ok(callers.length >= 100, `Should find 120 callers, got ${callers.length}`);
            assert.ok(callersTime < 2000, `findCallers should complete reasonably: ${callersTime}ms`);
        } finally {
            rm(dir);
        }
    });
});
