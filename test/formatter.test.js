/**
 * UCN Formatter Tests
 *
 * Output formatting tests — existing extractions + new coverage for untested formatters.
 * Extracted from parser.test.js with new tests added.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { parse } = require('../core/parser');
const { ProjectIndex } = require('../core/project');
const output = require('../core/output');
const { tmp, rm, idx, FIXTURES_PATH, PROJECT_DIR, CLI_PATH } = require('./helpers');

// ============================================================================
// EXTRACTED: Output Formatting (parser.test.js lines 605-645)
// ============================================================================

describe('Output Formatting', () => {

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
// EXTRACTED: formatFunctionSignature has correct spacing (parser.test.js lines 7316-7353)
// ============================================================================

describe('Regression: formatFunctionSignature has correct spacing', () => {
    it('should separate modifiers from function name with space', () => {
        const sig = output.formatFunctionSignature({
            name: 'getSymbol',
            modifiers: ['public'],
            params: 'String key'
        });
        assert.ok(sig.startsWith('public getSymbol('), `Expected "public getSymbol(" but got "${sig}"`);
    });

    it('should handle multiple modifiers', () => {
        const sig = output.formatFunctionSignature({
            name: 'main',
            modifiers: ['public', 'static'],
            params: 'String[] args',
            returnType: 'void'
        });
        assert.ok(sig.startsWith('public static main('), `Expected "public static main(" but got "${sig}"`);
        assert.ok(sig.includes('): void'), `Expected return type but got "${sig}"`);
    });

    it('should not add leading space when no modifiers', () => {
        const sig = output.formatFunctionSignature({
            name: 'helper',
            modifiers: [],
            params: ''
        });
        assert.ok(sig.startsWith('helper('), `Expected "helper(" but got "${sig}"`);
    });
});

// ============================================================================
// EXTRACTED: JSON formatters (parser.test.js lines 13366-13506)
// ============================================================================

describe('JSON formatters', () => {

    it('formatPlanJson structures output correctly', () => {
        const plan = {
            found: true,
            function: 'myFunc',
            file: 'src/app.js',
            startLine: 10,
            operation: 'add-param',
            before: { signature: 'myFunc(a, b)' },
            after: { signature: 'myFunc(a, b, c)' },
            totalChanges: 2,
            filesAffected: 1,
            changes: [
                { file: 'src/app.js', line: 20, expression: 'myFunc(1, 2)', suggestion: 'myFunc(1, 2, undefined)', _internal: 'leaked' }
            ]
        };
        const json = JSON.parse(output.formatPlanJson(plan));
        assert.strictEqual(json.found, true);
        assert.strictEqual(json.function, 'myFunc');
        assert.strictEqual(json.totalChanges, 2);
        assert.strictEqual(json.changes[0].suggestion, 'myFunc(1, 2, undefined)');
        // Internal fields should not leak
        assert.strictEqual(json.changes[0]._internal, undefined);
    });

    it('formatPlanJson handles not-found', () => {
        const json = JSON.parse(output.formatPlanJson(null));
        assert.strictEqual(json.found, false);
    });

    it('formatStackTraceJson structures output correctly', () => {
        const result = {
            frameCount: 1,
            frames: [{
                function: 'doWork',
                file: 'src/worker.js',
                line: 42,
                found: true,
                resolvedFile: '/abs/src/worker.js',
                context: [{ line: 41, code: 'function doWork() {', isCurrent: false }, { line: 42, code: '  throw new Error();', isCurrent: true }],
                functionInfo: { name: 'doWork', params: '', startLine: 41, endLine: 50 },
                raw: '    at doWork (src/worker.js:42:5)'
            }]
        };
        const json = JSON.parse(output.formatStackTraceJson(result));
        assert.strictEqual(json.frameCount, 1);
        assert.strictEqual(json.frames[0].found, true);
        assert.strictEqual(json.frames[0].context[1].isCurrent, true);
        assert.strictEqual(json.frames[0].functionInfo.name, 'doWork');
    });

    it('formatStackTraceJson handles empty result', () => {
        const json = JSON.parse(output.formatStackTraceJson(null));
        assert.strictEqual(json.frameCount, 0);
    });

    it('formatVerifyJson structures output correctly', () => {
        const result = {
            found: true,
            function: 'parse',
            file: 'src/parser.js',
            startLine: 5,
            signature: 'parse(input, options)',
            expectedArgs: { min: 1, max: 2 },
            totalCalls: 3,
            valid: 2,
            mismatches: 1,
            uncertain: 0,
            mismatchDetails: [{ file: 'src/main.js', line: 10, expression: 'parse()', expected: '1-2', actual: 0, args: [] }],
            uncertainDetails: []
        };
        const json = JSON.parse(output.formatVerifyJson(result));
        assert.strictEqual(json.found, true);
        assert.strictEqual(json.mismatches, 1);
        assert.strictEqual(json.mismatchDetails[0].actual, 0);
    });

    it('formatExampleJson structures output correctly', () => {
        const result = {
            best: {
                relativePath: 'src/main.js',
                line: 15,
                content: 'parse(data, { strict: true })',
                score: 85,
                reasons: ['has named args', 'in src/'],
                before: ['const data = load();'],
                after: ['console.log(result);']
            },
            totalCalls: 5
        };
        const json = JSON.parse(output.formatExampleJson(result, 'parse'));
        assert.strictEqual(json.found, true);
        assert.strictEqual(json.query, 'parse');
        assert.strictEqual(json.totalCalls, 5);
        assert.strictEqual(json.best.score, 85);
        assert.ok(Array.isArray(json.best.reasons));
    });

    it('formatExampleJson handles not-found', () => {
        const json = JSON.parse(output.formatExampleJson(null, 'missing'));
        assert.strictEqual(json.found, false);
        assert.strictEqual(json.query, 'missing');
    });

    it('formatDeadcodeJson structures output correctly', () => {
        const results = [
            { name: 'unusedFn', type: 'function', file: 'src/utils.js', startLine: 10, endLine: 20 },
            { name: 'OldClass', type: 'class', file: 'src/old.js', startLine: 1, endLine: 50, isExported: true, decorators: ['deprecated'] }
        ];
        results.excludedExported = 3;
        results.excludedDecorated = 1;
        const json = JSON.parse(output.formatDeadcodeJson(results));
        assert.strictEqual(json.count, 2);
        assert.strictEqual(json.excludedExported, 3);
        assert.strictEqual(json.excludedDecorated, 1);
        assert.strictEqual(json.symbols[0].name, 'unusedFn');
        assert.strictEqual(json.symbols[1].decorators[0], 'deprecated');
    });

    it('example --json flag works via CLI', () => {
        const { execFileSync } = require('child_process');
        // Run CLI with --json flag to ensure example command goes through printOutput
        const result = execFileSync('node', [CLI_PATH, '.', 'example', 'formatExample', '--json'], {
            encoding: 'utf-8',
            cwd: PROJECT_DIR,
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        const json = JSON.parse(result);
        // Should have structured output, not raw formatExample text
        assert.ok(json.found !== undefined || json.query !== undefined, 'JSON output should have structured fields');
    });
});

// ============================================================================
// EXTRACTED: formatImports DYNAMIC classification (parser.test.js lines 8889-8912)
// ============================================================================

describe('MCP Demo Fixes — formatImports', () => {

    it('formatImports shows DYNAMIC (unresolved) group', () => {
        const imports = [
            { module: './utils', names: ['helper'], type: 'esm', resolved: 'src/utils.js', isExternal: false, isDynamic: false },
            { module: 'lodash', names: ['map'], type: 'esm', resolved: null, isExternal: true, isDynamic: false },
            { module: 'configPath', names: [], type: 'require', resolved: null, isExternal: false, isDynamic: true }
        ];
        const text = output.formatImports(imports, 'test.js');
        assert.ok(text.includes('INTERNAL:'), 'Should have INTERNAL section');
        assert.ok(text.includes('EXTERNAL:'), 'Should have EXTERNAL section');
        assert.ok(text.includes('DYNAMIC (unresolved):'), 'Should have DYNAMIC section');
        assert.ok(text.includes('configPath'), 'DYNAMIC section should contain configPath');
        // configPath should NOT be under EXTERNAL
        const externalIdx = text.indexOf('EXTERNAL:');
        const dynamicIdx = text.indexOf('DYNAMIC (unresolved):');
        const configIdx = text.indexOf('configPath');
        assert.ok(configIdx > dynamicIdx, 'configPath should appear after DYNAMIC header, not EXTERNAL');
    });

});

// ============================================================================
// EXTRACTED: formatTrace output (parser.test.js lines 8993-9012)
// ============================================================================

describe('MCP Demo Fixes — formatTrace', () => {

    it('formatTrace includes include_methods hint when explicitly excluded', () => {
        const traceData = {
            root: 'test',
            file: 'a.js',
            line: 1,
            direction: 'down',
            maxDepth: 3,
            includeMethods: false,
            tree: { name: 'test', file: 'a.js', line: 1, children: [] }
        };
        const text = output.formatTrace(traceData);
        assert.ok(text.includes('obj.method() calls excluded'), 'Should hint about include-methods when excluded');

        // With includeMethods: true (default), no hint
        const traceData2 = { ...traceData, includeMethods: true };
        const text2 = output.formatTrace(traceData2);
        assert.ok(!text2.includes('obj.method() calls excluded'), 'Should not hint when includeMethods=true (default)');
    });

});

// ============================================================================
// EXTRACTED: formatExample (parser.test.js lines 9107-9140)
// ============================================================================

describe('MCP Issues Fixes — formatExample', () => {

    it('formatExample formats result correctly (issue 2)', () => {
        const result = {
            best: {
                relativePath: 'app.js',
                line: 5,
                content: 'const x = greet("hi")',
                before: ['// setup'],
                after: ['console.log(x)'],
                score: 15,
                reasons: ['typed assignment']
            },
            totalCalls: 3
        };

        const text = output.formatExample(result, 'greet');
        assert.ok(text.includes('Best example of "greet"'), 'should include header');
        assert.ok(text.includes('app.js:5'), 'should include file:line');
        assert.ok(text.includes('greet'), 'should include function name');
        assert.ok(text.includes('Score: 15'), 'should include score');
        assert.ok(text.includes('3 total calls'), 'should include total calls');
        assert.ok(text.includes('typed assignment'), 'should include reasons');
    });

    it('formatExample handles null result (issue 2)', () => {
        const text = output.formatExample(null, 'missing');
        assert.ok(text.includes('No call examples found'), 'should show not found message');
    });

});

// ============================================================================
// EXTRACTED: formatDeadcode hints (parser.test.js lines 9273-9320)
// ============================================================================

describe('Reliability Hints — formatDeadcode', () => {

    it('formatDeadcode shows decorator hints', () => {
        const results = [
            { name: 'cleanup', type: 'function', file: 'app.py', startLine: 2, endLine: 5, isExported: false, decorators: ['app.route("/cleanup")'] },
            { name: 'helper', type: 'function', file: 'app.py', startLine: 10, endLine: 12, isExported: false },
            { name: 'scheduled', type: 'method', file: 'Service.java', startLine: 5, endLine: 8, isExported: true, annotations: ['scheduled'] }
        ];
        const text = output.formatDeadcode(results);
        assert.ok(text.includes('[has @app.route("/cleanup")]'), 'Should show Python decorator hint');
        assert.ok(!text.includes('helper (function) [has'), 'helper should not have decorator hint');
        assert.ok(text.includes('[has @scheduled]'), 'Should show Java annotation hint');
    });

});

// ============================================================================
// EXTRACTED: formatContext hints (parser.test.js lines 9312-9350)
// ============================================================================

describe('Reliability Hints — formatContext', () => {

    it('context includes isMethod/className in meta for class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-ctx-hint-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'service.py'), `
class UserService:
    def get_user(self, user_id):
        return self._fetch(user_id)

    def _fetch(self, uid):
        return {'id': uid}
`);
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.py', { quiet: true });

            const ctx = index.context('get_user');
            assert.ok(ctx, 'Should find get_user');
            assert.ok(ctx.meta, 'Should have meta');
            assert.ok(ctx.meta.isMethod || ctx.meta.className, 'Should indicate it is a class method');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('formatContext shows class method hint when callers <= 3', () => {
        // Class method with 1 caller
        const ctx1 = {
            function: 'get_user',
            file: 'service.py',
            startLine: 3,
            endLine: 5,
            callers: [{ relativePath: 'router.py', line: 10, callerName: 'handle_request', content: 'svc.get_user(id)' }],
            callees: [],
            meta: { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0, includeMethods: true, isMethod: true, className: 'UserService' }
        };
        const { text: text1 } = output.formatContext(ctx1);
        assert.ok(text1.includes('class/struct method'), 'Should show class method hint for 1 caller');
        assert.ok(text1.includes('constructed or injected'), 'Should mention injected instances');

        // Non-method function with 1 caller — no hint
        const ctx2 = {
            function: 'helper',
            file: 'utils.py',
            startLine: 1,
            endLine: 3,
            callers: [{ relativePath: 'main.py', line: 5, callerName: 'main', content: 'helper()' }],
            callees: [],
            meta: { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0, includeMethods: true }
        };
        const { text: text2 } = output.formatContext(ctx2);
        assert.ok(!text2.includes('class/struct method'), 'Should NOT show hint for standalone function');

        // Class method with many callers — no hint
        const manyCallers = Array.from({ length: 10 }, (_, i) => ({
            relativePath: `file${i}.py`, line: i + 1, callerName: `fn${i}`, content: `svc.get_user(${i})`
        }));
        const ctx3 = {
            function: 'get_user',
            file: 'service.py',
            startLine: 3,
            endLine: 5,
            callers: manyCallers,
            callees: [],
            meta: { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0, includeMethods: true, isMethod: true, className: 'UserService' }
        };
        const { text: text3 } = output.formatContext(ctx3);
        assert.ok(!text3.includes('class/struct method'), 'Should NOT show hint when callers > 3');
    });

});

// ============================================================================
// EXTRACTED: formatDeadcode exclusion counts, top option (parser.test.js lines 9619-9700)
// ============================================================================

describe('Reliability Hints — formatDeadcode exclusion counts and top', () => {

    it('formatDeadcode shows exclusion counts in hints', () => {
        // Simulate results with exclusion counts
        const results = [
            { name: 'helper', type: 'function', file: 'utils.py', startLine: 1, endLine: 3, isExported: false }
        ];
        results.excludedDecorated = 5;
        results.excludedExported = 12;

        const text = output.formatDeadcode(results);
        assert.ok(text.includes('5 decorated/annotated symbol(s) hidden'), 'Should show decorated count');
        assert.ok(text.includes('--include-decorated'), 'Should hint at --include-decorated flag');
        assert.ok(text.includes('12 exported symbol(s) excluded'), 'Should show exported count');
        assert.ok(text.includes('--include-exported'), 'Should hint at --include-exported flag');
    });

    it('formatDeadcode handles zero exclusions without hints', () => {
        const results = [
            { name: 'helper', type: 'function', file: 'utils.py', startLine: 1, endLine: 3, isExported: false }
        ];
        results.excludedDecorated = 0;
        results.excludedExported = 0;

        const text = output.formatDeadcode(results);
        assert.ok(!text.includes('hidden'), 'Should not show any hidden hints when counts are 0');
        assert.ok(text.includes('helper'), 'Should still show the result');
    });

    it('formatDeadcode respects --top option', () => {
        const results = [
            { name: 'a', type: 'function', file: 'a.js', startLine: 1, endLine: 3, isExported: false },
            { name: 'b', type: 'function', file: 'b.js', startLine: 1, endLine: 3, isExported: false },
            { name: 'c', type: 'function', file: 'c.js', startLine: 1, endLine: 3, isExported: false },
            { name: 'd', type: 'function', file: 'd.js', startLine: 1, endLine: 3, isExported: false },
            { name: 'e', type: 'function', file: 'e.js', startLine: 1, endLine: 3, isExported: false }
        ];
        results.excludedDecorated = 0;
        results.excludedExported = 0;

        // With top=2, should show only 2 results
        const text = output.formatDeadcode(results, { top: 2 });
        assert.ok(text.includes('(showing 2)'), 'Should indicate showing 2');
        assert.ok(text.includes('a (function)'), 'Should show first result');
        assert.ok(text.includes('b (function)'), 'Should show second result');
        assert.ok(!text.includes('c (function)'), 'Should not show third result');
        assert.ok(text.includes('3 more result(s) not shown'), 'Should show hidden count');

        // Without top, should show all results
        const textAll = output.formatDeadcode(results);
        assert.ok(!textAll.includes('showing'), 'Should not indicate partial results');
        assert.ok(textAll.includes('e (function)'), 'Should show all results');
        assert.ok(!textAll.includes('more result(s) not shown'), 'Should not show hidden hint');
    });

});

// ============================================================================
// EXTRACTED: formatImports/formatExporters/formatFileExports/formatGraph error display (FIX #78)
// ============================================================================

describe('FIX #78: format error display for file-not-found', () => {

    it('fix #78: formatImports shows error for file-not-found', () => {
        const result = output.formatImports({ error: 'file-not-found', filePath: 'missing.js' }, 'missing.js');
        assert.ok(result.includes('Error: File not found in project: missing.js'));
    });

    it('fix #78: formatExporters shows error for file-not-found', () => {
        const result = output.formatExporters({ error: 'file-not-found', filePath: 'missing.js' }, 'missing.js');
        assert.ok(result.includes('Error: File not found in project: missing.js'));
    });

    it('fix #78: formatFileExports shows error for file-not-found', () => {
        const result = output.formatFileExports({ error: 'file-not-found', filePath: 'missing.js' }, 'missing.js');
        assert.ok(result.includes('Error: File not found in project: missing.js'));
    });

    it('fix #78: formatGraph shows error for file-not-found', () => {
        const result = output.formatGraph({ error: 'file-not-found', filePath: 'missing.js' });
        assert.ok(result.includes('Error: File not found in project: missing.js'));
    });

});

// ============================================================================
// EXTRACTED: formatToc truncation hint (FIX #79)
// ============================================================================

describe('FIX #79: formatToc truncation', () => {

    it('fix #79: formatToc shows truncation hint when hiddenFiles > 0', () => {
        const toc = {
            totals: { files: 60, lines: 600, functions: 60, classes: 0, state: 0, testFiles: 0 },
            meta: {},
            summary: {},
            files: [{ file: 'a.js', lines: 10, functions: 1 }],
            hiddenFiles: 59
        };
        const result = output.formatToc(toc);
        assert.ok(result.includes('... and 59 more files'));
    });

});

// ============================================================================
// EXTRACTED: formatTrace warnings (FIX #80)
// ============================================================================

describe('FIX #80: formatTrace warnings', () => {

    it('fix #80: formatTrace displays warnings', () => {
        const trace = {
            root: 'doWork',
            file: 'delegate.js',
            line: 1,
            direction: 'down',
            maxDepth: 3,
            includeMethods: true,
            tree: { name: 'doWork', children: [] },
            warnings: [{ message: 'Resolved to delegate.js:1 which has no callees. 1 other definition(s) exist — use --file to pick a different one.' }]
        };
        const result = output.formatTrace(trace);
        assert.ok(result.includes('Note: Resolved to delegate.js:1 which has no callees'));
        assert.ok(result.includes('--file'));
    });

});

// ============================================================================
// EXTRACTED: search metadata — formatSearch (parser.test.js lines 13939-14082)
// ============================================================================

describe('Feature: search metadata in results', () => {

    it('results include meta with filesScanned count', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-search-meta-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'a.js'), 'const x = 1;\n');
            fs.writeFileSync(path.join(tmpDir, 'b.js'), 'const y = 2;\n');
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const results = index.search('nonexistent_term_xyz');
            assert.ok(results.meta, 'Results should have meta property');
            assert.strictEqual(results.meta.filesScanned, 2, 'Should have scanned 2 files');
            assert.strictEqual(results.meta.totalFiles, 2, 'Total files should be 2');
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });

    it('meta tracks filesSkipped with exclude filter', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-search-meta2-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), 'const x = 1;\n');
            fs.mkdirSync(path.join(tmpDir, 'test'));
            fs.writeFileSync(path.join(tmpDir, 'test', 'app.test.js'), 'const y = 2;\n');
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const results = index.search('nonexistent', { exclude: ['test'] });
            assert.ok(results.meta, 'Results should have meta property');
            assert.strictEqual(results.meta.filesScanned, 1, 'Should scan 1 file (test excluded)');
            assert.strictEqual(results.meta.filesSkipped, 1, 'Should skip 1 file');
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });

    it('formatSearch shows scope info when no matches', () => {
        const results = [];
        results.meta = { filesScanned: 15, filesSkipped: 3, totalFiles: 18 };
        const formatted = output.formatSearch(results, 'nonexistent');
        assert.ok(formatted.includes('Searched 15 of 18 files'), `Should mention scanned/total: "${formatted}"`);
        assert.ok(formatted.includes('3 excluded'), `Should mention excluded: "${formatted}"`);
    });

    it('formatSearch shows simple scope when no files skipped', () => {
        const results = [];
        results.meta = { filesScanned: 10, filesSkipped: 0, totalFiles: 10 };
        const formatted = output.formatSearch(results, 'nonexistent');
        assert.ok(formatted.includes('Searched 10 files'), `Should mention scanned count: "${formatted}"`);
        assert.ok(!formatted.includes('excluded'), 'Should not mention excluded when none skipped');
    });

    it('formatSearch uses singular "file" when 1 file matches', () => {
        const results = [{ file: 'test.js', matches: [{ line: 1, content: 'foo' }] }];
        results.meta = { filesScanned: 5, filesSkipped: 0, totalFiles: 5 };
        const formatted = output.formatSearch(results, 'foo');
        assert.ok(formatted.includes('in 1 file:'), `Should say "1 file" not "1 files": "${formatted}"`);
    });

    it('formatSearch uses plural "files" when multiple files match', () => {
        const results = [
            { file: 'a.js', matches: [{ line: 1, content: 'foo' }] },
            { file: 'b.js', matches: [{ line: 2, content: 'foo' }] }
        ];
        results.meta = { filesScanned: 5, filesSkipped: 0, totalFiles: 5 };
        const formatted = output.formatSearch(results, 'foo');
        assert.ok(formatted.includes('in 2 files:'), `Should say "2 files": "${formatted}"`);
    });

    it('formatSearch uses singular "match" when 1 match found', () => {
        const results = [{ file: 'test.js', matches: [{ line: 1, content: 'foo' }] }];
        results.meta = { filesScanned: 5, filesSkipped: 0, totalFiles: 5 };
        const formatted = output.formatSearch(results, 'foo');
        assert.ok(formatted.includes('Found 1 match for'), `Should say "1 match" not "1 matches": "${formatted}"`);
    });

    it('detectDoubleEscaping detects double-escaped dot', () => {
        const hint = output.detectDoubleEscaping('CONFIG\\\\.speed');
        assert.ok(hint.includes('\\\\.' ), `Should mention \\\\.: "${hint}"`);
        assert.ok(hint.includes('\\.'), `Should suggest \\.: "${hint}"`);
        assert.ok(hint.includes('single backslash'), `Should mention single backslash: "${hint}"`);
    });

    it('detectDoubleEscaping detects double-escaped \\d', () => {
        const hint = output.detectDoubleEscaping('\\\\d+');
        assert.ok(hint.includes('\\\\d'), `Should mention \\\\d: "${hint}"`);
        assert.ok(hint.includes('\\d'), `Should suggest \\d: "${hint}"`);
    });

    it('detectDoubleEscaping returns empty for normal patterns', () => {
        assert.strictEqual(output.detectDoubleEscaping('CONFIG.speed'), '');
        assert.strictEqual(output.detectDoubleEscaping('foo'), '');
        assert.strictEqual(output.detectDoubleEscaping('\\.speed'), '');
    });

    it('formatSearch shows double-escaping hint on 0 results', () => {
        const results = [];
        results.meta = { filesScanned: 10, filesSkipped: 0, totalFiles: 10 };
        const formatted = output.formatSearch(results, 'CONFIG\\\\.speed');
        assert.ok(formatted.includes('No matches'), `Should show no matches: "${formatted}"`);
        assert.ok(formatted.includes('Hint:'), `Should show hint: "${formatted}"`);
        assert.ok(formatted.includes('single backslash'), `Should mention single backslash: "${formatted}"`);
    });

    it('formatSearch does not show hint when matches exist', () => {
        const results = [{ file: 'test.js', matches: [{ line: 1, content: 'x' }] }];
        results.meta = { filesScanned: 5, filesSkipped: 0, totalFiles: 5 };
        const formatted = output.formatSearch(results, 'CONFIG\\\\.speed');
        assert.ok(!formatted.includes('Hint:'), `Should not show hint when matches exist: "${formatted}"`);
    });

    it('formatSearch does not show hint on 0 results without double-escaping', () => {
        const results = [];
        results.meta = { filesScanned: 10, filesSkipped: 0, totalFiles: 10 };
        const formatted = output.formatSearch(results, 'nonexistent');
        assert.ok(!formatted.includes('Hint:'), `Should not show hint for normal pattern: "${formatted}"`);
    });

    it('formatSearch scope uses singular "file" when 1 file scanned', () => {
        const results = [];
        results.meta = { filesScanned: 1, filesSkipped: 0, totalFiles: 1 };
        const formatted = output.formatSearch(results, 'nonexistent');
        assert.ok(formatted.includes('Searched 1 file.'), `Should say "1 file" not "1 files": "${formatted}"`);
    });

});

// ============================================================================
// PART 2: New Formatter Coverage
// ============================================================================

describe('New Formatter Coverage', () => {

    // ────────────────────────────────────────────────────────────────────────
    // 1. formatAbout
    // ────────────────────────────────────────────────────────────────────────

    describe('formatAbout', () => {

        it('returns "Symbol not found." for null input', () => {
            const text = output.formatAbout(null);
            assert.strictEqual(text, 'Symbol not found.');
        });

        it('returns "Symbol not found." with suggestions when found=false', () => {
            const about = {
                found: false,
                suggestions: [
                    { name: 'parseJSON', type: 'function', file: 'utils.js', line: 5, usageCount: 3 }
                ]
            };
            const text = output.formatAbout(about);
            assert.ok(text.includes('Symbol not found.'), 'Should say not found');
            assert.ok(text.includes('Did you mean:'), 'Should show suggestions');
            assert.ok(text.includes('parseJSON'), 'Should include suggestion name');
            assert.ok(text.includes('utils.js'), 'Should include suggestion file');
        });

        it('formats found symbol with callers, callees, tests, and code', () => {
            const about = {
                found: true,
                symbol: {
                    name: 'processData',
                    type: 'function',
                    file: 'src/processor.js',
                    startLine: 10,
                    endLine: 25,
                    signature: 'processData(input, options)'
                },
                totalUsages: 8,
                usages: { calls: 5, imports: 2, references: 1 },
                callers: {
                    total: 2,
                    top: [
                        { file: 'src/main.js', line: 15, callerName: 'main', expression: 'processData(data, opts)' },
                        { file: 'src/api.js', line: 30, callerName: 'handleRequest', expression: 'processData(req.body)' }
                    ]
                },
                callees: {
                    total: 1,
                    top: [
                        { name: 'validate', weight: 'core', file: 'src/validator.js', line: 5, callCount: 3 }
                    ]
                },
                tests: {
                    totalMatches: 3,
                    fileCount: 1,
                    files: ['test/processor.test.js']
                },
                otherDefinitions: [],
                code: 'function processData(input, options) {\n  validate(input);\n  return transform(input);\n}'
            };
            const text = output.formatAbout(about);

            // Header
            assert.ok(text.includes('processData (function)'), 'Should show name and type');
            assert.ok(text.includes('src/processor.js:10-25'), 'Should show file location');
            assert.ok(text.includes('processData(input, options)'), 'Should show signature');

            // Usages
            assert.ok(text.includes('USAGES: 8 total'), 'Should show usage summary');
            assert.ok(text.includes('5 calls'), 'Should show call count');

            // Callers
            assert.ok(text.includes('CALLERS (2):'), 'Should show callers section');
            assert.ok(text.includes('src/main.js:15'), 'Should show caller location');
            assert.ok(text.includes('[main]'), 'Should show caller name');

            // Callees
            assert.ok(text.includes('CALLEES (1):'), 'Should show callees section');
            assert.ok(text.includes('validate'), 'Should show callee name');
            assert.ok(text.includes('[core]'), 'Should show callee weight');

            // Tests
            assert.ok(text.includes('TESTS:'), 'Should show tests section');
            assert.ok(text.includes('test/processor.test.js'), 'Should show test file');

            // Code
            assert.ok(text.includes('CODE'), 'Should show code section');
            assert.ok(text.includes('function processData'), 'Should include function code');
        });

        it('shows truncation hint when callers/callees exceed top', () => {
            const about = {
                found: true,
                symbol: { name: 'fn', type: 'function', file: 'a.js', startLine: 1, endLine: 5 },
                totalUsages: 20,
                usages: { calls: 15, imports: 3, references: 2 },
                callers: {
                    total: 15,
                    top: [{ file: 'b.js', line: 1, callerName: 'caller1', expression: 'fn()' }]
                },
                callees: { total: 0, top: [] },
                tests: { totalMatches: 0, fileCount: 0, files: [] },
                otherDefinitions: [],
                code: 'function fn() {}'
            };
            const text = output.formatAbout(about);
            assert.ok(text.includes('showing 1 of 15'), 'Should show truncated count');
            assert.ok(text.includes('truncated'), 'Should mention truncation');
        });

        it('shows other definitions when present', () => {
            const about = {
                found: true,
                symbol: { name: 'process', type: 'function', file: 'a.js', startLine: 1, endLine: 3 },
                totalUsages: 5,
                usages: { calls: 3, imports: 1, references: 1 },
                callers: { total: 0, top: [] },
                callees: { total: 0, top: [] },
                tests: { totalMatches: 0, fileCount: 0, files: [] },
                otherDefinitions: [{ file: 'b.js', line: 10, usageCount: 2 }],
                code: 'function process() {}'
            };
            const text = output.formatAbout(about);
            assert.ok(text.includes('OTHER DEFINITIONS (1):'), 'Should show other definitions');
            assert.ok(text.includes('b.js:10'), 'Should show other definition location');
        });

        it('includes-methods hint when includeMethods is false', () => {
            const about = {
                found: true,
                symbol: { name: 'fn', type: 'function', file: 'a.js', startLine: 1, endLine: 3 },
                totalUsages: 1,
                usages: { calls: 1, imports: 0, references: 0 },
                callers: { total: 0, top: [] },
                callees: { total: 0, top: [] },
                tests: { totalMatches: 0, fileCount: 0, files: [] },
                otherDefinitions: [],
                code: 'function fn() {}',
                includeMethods: false
            };
            const text = output.formatAbout(about);
            assert.ok(text.includes('obj.method()'), 'Should mention method calls excluded');
        });

    });

    // ────────────────────────────────────────────────────────────────────────
    // 2. formatContext
    // ────────────────────────────────────────────────────────────────────────

    describe('formatContext', () => {

        it('returns "Symbol not found." for null input', () => {
            const { text } = output.formatContext(null);
            assert.strictEqual(text, 'Symbol not found.');
        });

        it('formats function context with callers and callees', () => {
            const ctx = {
                function: 'handleRequest',
                file: 'src/server.js',
                startLine: 10,
                endLine: 30,
                callers: [
                    { relativePath: 'src/app.js', line: 20, callerName: 'startServer', content: 'handleRequest(req, res)' }
                ],
                callees: [
                    { name: 'parseBody', weight: 'core', relativePath: 'src/parser.js', file: 'src/parser.js', startLine: 5, endLine: 15 },
                    { name: 'sendResponse', weight: 'utility', relativePath: 'src/response.js', file: 'src/response.js', startLine: 1, endLine: 8 }
                ],
                meta: { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0, includeMethods: true }
            };
            const { text, expandable } = output.formatContext(ctx);

            assert.ok(text.includes('Context for handleRequest:'), 'Should show function name');
            assert.ok(text.includes('CALLERS (1):'), 'Should show callers section');
            assert.ok(text.includes('src/app.js:20'), 'Should show caller location');
            assert.ok(text.includes('[startServer]'), 'Should show caller name');
            assert.ok(text.includes('CALLEES (2):'), 'Should show callees section');
            assert.ok(text.includes('parseBody'), 'Should show callee name');
            assert.ok(text.includes('[core]'), 'Should show core weight');
            assert.ok(text.includes('[utility]'), 'Should show utility weight');

            // Expandable items
            assert.ok(expandable.length === 3, 'Should have 3 expandable items (1 caller + 2 callees)');
            assert.strictEqual(expandable[0].type, 'caller');
            assert.strictEqual(expandable[1].type, 'callee');
        });

        it('formats class/struct context with methods', () => {
            const ctx = {
                name: 'UserService',
                type: 'class',
                file: 'src/service.js',
                methods: [
                    { name: 'getUser', params: 'id', file: 'src/service.js', line: 5, endLine: 10 },
                    { name: 'saveUser', params: 'user', file: 'src/service.js', line: 12, endLine: 20 }
                ],
                callers: [
                    { relativePath: 'src/api.js', line: 8, callerName: 'handler', content: 'new UserService()' }
                ]
            };
            const { text, expandable } = output.formatContext(ctx);

            assert.ok(text.includes('Context for class UserService:'), 'Should identify as class context');
            assert.ok(text.includes('METHODS (2):'), 'Should show methods section');
            assert.ok(text.includes('getUser(id)'), 'Should show method signature');
            assert.ok(text.includes('saveUser(user)'), 'Should show second method');
            assert.ok(text.includes('CALLERS (1):'), 'Should show callers section');

            // Expandable: 2 methods + 1 caller = 3
            assert.strictEqual(expandable.length, 3);
            assert.strictEqual(expandable[0].type, 'method');
            assert.strictEqual(expandable[2].type, 'caller');
        });

        it('shows methods-excluded hint when includeMethods is false', () => {
            const ctx = {
                function: 'fn',
                file: 'a.js',
                startLine: 1,
                endLine: 3,
                callers: [],
                callees: [],
                meta: { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0, includeMethods: false }
            };
            const { text } = output.formatContext(ctx);
            assert.ok(text.includes('obj.method() calls excluded'), 'Should show methods-excluded hint');
        });

        it('shows uncertain calls note in meta', () => {
            const ctx = {
                function: 'fn',
                file: 'a.js',
                startLine: 1,
                endLine: 3,
                callers: [],
                callees: [],
                meta: { complete: true, skipped: 0, dynamicImports: 2, uncertain: 3, includeMethods: true }
            };
            const { text } = output.formatContext(ctx);
            assert.ok(text.includes('2 dynamic import(s)'), 'Should show dynamic import count');
            assert.ok(text.includes('3 uncertain call(s) skipped'), 'Should show uncertain count');
        });

    });

    // ────────────────────────────────────────────────────────────────────────
    // 3. formatUsages
    // ────────────────────────────────────────────────────────────────────────

    describe('formatUsages', () => {

        it('formats usages with all sections', () => {
            const usages = [
                { relativePath: 'src/parser.js', line: 10, startLine: 10, isDefinition: true, usageType: 'definition', signature: 'parse(input)' },
                { relativePath: 'src/main.js', line: 20, isDefinition: false, usageType: 'call', content: 'parse(data)' },
                { relativePath: 'src/app.js', line: 5, isDefinition: false, usageType: 'call', content: 'parse(config)' },
                { relativePath: 'src/index.js', line: 1, isDefinition: false, usageType: 'import', content: "const { parse } = require('./parser')" },
                { relativePath: 'src/helper.js', line: 15, isDefinition: false, usageType: 'reference', content: 'const fn = parse' }
            ];
            const text = output.formatUsages(usages, 'parse');

            assert.ok(text.includes('Usages of "parse":'), 'Should show header with name');
            assert.ok(text.includes('1 definitions'), 'Should count definitions');
            assert.ok(text.includes('2 calls'), 'Should count calls');
            assert.ok(text.includes('1 imports'), 'Should count imports');
            assert.ok(text.includes('1 references'), 'Should count references');
            assert.ok(text.includes('DEFINITIONS:'), 'Should have definitions section');
            assert.ok(text.includes('src/parser.js:10'), 'Should show definition location');
            assert.ok(text.includes('CALLS:'), 'Should have calls section');
            assert.ok(text.includes('parse(data)'), 'Should show call content');
            assert.ok(text.includes('IMPORTS:'), 'Should have imports section');
            assert.ok(text.includes('REFERENCES:'), 'Should have references section');
        });

        it('omits empty sections', () => {
            const usages = [
                { relativePath: 'src/main.js', line: 20, isDefinition: false, usageType: 'call', content: 'parse(data)' }
            ];
            const text = output.formatUsages(usages, 'parse');
            assert.ok(text.includes('CALLS:'), 'Should have calls section');
            assert.ok(!text.includes('DEFINITIONS:'), 'Should not have definitions section');
            assert.ok(!text.includes('IMPORTS:'), 'Should not have imports section');
            assert.ok(!text.includes('REFERENCES:'), 'Should not have references section');
        });

        it('includes context lines when present', () => {
            const usages = [
                {
                    relativePath: 'src/main.js', line: 20, isDefinition: false, usageType: 'call',
                    content: 'parse(data)',
                    before: ['const data = loadFile();'],
                    after: ['console.log(result);']
                }
            ];
            const text = output.formatUsages(usages, 'parse');
            assert.ok(text.includes('const data = loadFile()'), 'Should include before context');
            assert.ok(text.includes('console.log(result)'), 'Should include after context');
        });

    });

    // ────────────────────────────────────────────────────────────────────────
    // 4. formatFind
    // ────────────────────────────────────────────────────────────────────────

    describe('formatFind', () => {

        it('returns not found message for empty results', () => {
            const text = output.formatFind([], 'missing');
            assert.ok(text.includes('No symbols found for "missing"'), 'Should show not found');
        });

        it('formats found symbols with usage counts', () => {
            const symbols = [
                { name: 'parseJSON', relativePath: 'src/parser.js', startLine: 10, params: 'input', usageCount: 12 },
                { name: 'parseXML', relativePath: 'src/xml.js', startLine: 5, params: 'data, options', usageCount: 3 }
            ];
            const text = output.formatFind(symbols, 'parse');

            assert.ok(text.includes('Found 2 match(es) for "parse"'), 'Should show match count');
            assert.ok(text.includes('src/parser.js:10'), 'Should show first file location');
            assert.ok(text.includes('parseJSON(input)'), 'Should show first signature');
            assert.ok(text.includes('12 usages'), 'Should show usage count');
            assert.ok(text.includes('src/xml.js:5'), 'Should show second file location');
        });

        it('shows hidden count when results exceed limit', () => {
            const symbols = [];
            for (let i = 0; i < 15; i++) {
                symbols.push({ name: `fn${i}`, relativePath: `file${i}.js`, startLine: 1, params: '', usageCount: i });
            }
            const text = output.formatFind(symbols, 'fn');
            assert.ok(text.includes('showing top 10'), 'Should indicate truncation at default limit');
            assert.ok(text.includes('5 more result(s)'), 'Should show hidden count');
        });

        it('respects custom top parameter', () => {
            const symbols = [
                { name: 'a', relativePath: 'a.js', startLine: 1, params: '', usageCount: 5 },
                { name: 'b', relativePath: 'b.js', startLine: 1, params: '', usageCount: 3 },
                { name: 'c', relativePath: 'c.js', startLine: 1, params: '', usageCount: 1 }
            ];
            const text = output.formatFind(symbols, 'fn', 2);
            assert.ok(text.includes('showing top 2'), 'Should show top 2');
            assert.ok(text.includes('1 more result(s)'), 'Should show 1 hidden');
        });

        it('formats usageCounts breakdown when available', () => {
            const symbols = [
                {
                    name: 'handler', relativePath: 'api.js', startLine: 1, params: 'req',
                    usageCounts: { total: 10, calls: 6, definitions: 1, imports: 2, references: 1 }
                }
            ];
            const text = output.formatFind(symbols, 'handler');
            assert.ok(text.includes('10 usages:'), 'Should show total usages');
            assert.ok(text.includes('6 calls'), 'Should show calls breakdown');
            assert.ok(text.includes('2 imports'), 'Should show imports breakdown');
        });

    });

    // ────────────────────────────────────────────────────────────────────────
    // 5. formatSmart
    // ────────────────────────────────────────────────────────────────────────

    describe('formatSmart', () => {

        it('returns "Function not found." for null input', () => {
            const text = output.formatSmart(null);
            assert.strictEqual(text, 'Function not found.');
        });

        it('formats main function with dependencies', () => {
            const smart = {
                target: {
                    name: 'processOrder',
                    file: 'src/orders.js',
                    startLine: 20,
                    code: 'function processOrder(order) {\n  validate(order);\n  return save(order);\n}'
                },
                dependencies: [
                    { name: 'validate', weight: 'core', relativePath: 'src/validator.js', startLine: 5, code: 'function validate(obj) { return true; }' },
                    { name: 'save', weight: 'utility', relativePath: 'src/db.js', startLine: 10, code: 'function save(data) { db.insert(data); }' }
                ],
                meta: { dynamicImports: 0, uncertain: 0 }
            };
            const text = output.formatSmart(smart);

            assert.ok(text.includes('processOrder (src/orders.js:20)'), 'Should show target header');
            assert.ok(text.includes('function processOrder(order)'), 'Should include main function code');
            assert.ok(text.includes('DEPENDENCIES'), 'Should show dependencies section');
            assert.ok(text.includes('// validate [core] (src/validator.js:5)'), 'Should show dependency header with weight');
            assert.ok(text.includes('function validate(obj)'), 'Should include dependency code');
            assert.ok(text.includes('// save [utility] (src/db.js:10)'), 'Should show second dependency');
        });

        it('formats function with no dependencies', () => {
            const smart = {
                target: {
                    name: 'helper',
                    file: 'src/utils.js',
                    startLine: 1,
                    code: 'function helper() { return 42; }'
                },
                dependencies: [],
                meta: { dynamicImports: 0, uncertain: 0 }
            };
            const text = output.formatSmart(smart);
            assert.ok(text.includes('helper (src/utils.js:1)'), 'Should show target');
            assert.ok(text.includes('function helper()'), 'Should show code');
            assert.ok(!text.includes('DEPENDENCIES'), 'Should not show dependencies section');
        });

        it('includes types section when present', () => {
            const smart = {
                target: {
                    name: 'fn',
                    file: 'a.ts',
                    startLine: 1,
                    code: 'function fn(x: Config): void {}'
                },
                dependencies: [],
                types: [
                    { name: 'Config', relativePath: 'types.ts', startLine: 5, code: 'interface Config { key: string; }' }
                ],
                meta: { dynamicImports: 0, uncertain: 0 }
            };
            const text = output.formatSmart(smart);
            assert.ok(text.includes('TYPES'), 'Should show types section');
            assert.ok(text.includes('// Config (types.ts:5)'), 'Should show type header');
            assert.ok(text.includes('interface Config'), 'Should show type code');
        });

        it('shows meta notes for uncertain and dynamic imports', () => {
            const smart = {
                target: { name: 'fn', file: 'a.js', startLine: 1, code: 'function fn() {}' },
                dependencies: [],
                meta: { dynamicImports: 2, uncertain: 1 }
            };
            const text = output.formatSmart(smart);
            assert.ok(text.includes('2 dynamic import(s)'), 'Should show dynamic imports note');
            assert.ok(text.includes('1 uncertain call(s) skipped'), 'Should show uncertain note');
        });

    });

    // ────────────────────────────────────────────────────────────────────────
    // 6. formatImpact
    // ────────────────────────────────────────────────────────────────────────

    describe('formatImpact', () => {

        it('returns "Function not found." for null input', () => {
            const text = output.formatImpact(null);
            assert.strictEqual(text, 'Function not found.');
        });

        it('formats impact with call sites grouped by file', () => {
            const impact = {
                function: 'saveUser',
                file: 'src/db.js',
                startLine: 15,
                signature: 'saveUser(user)',
                totalCallSites: 3,
                byFile: [
                    {
                        file: 'src/api.js',
                        count: 2,
                        sites: [
                            { line: 20, callerName: 'createUser', expression: 'saveUser(newUser)', args: ['newUser'] },
                            { line: 45, callerName: 'updateUser', expression: 'saveUser(updatedUser)', args: ['updatedUser'] }
                        ]
                    },
                    {
                        file: 'src/admin.js',
                        count: 1,
                        sites: [
                            { line: 10, callerName: 'bulkImport', expression: 'saveUser(record)' }
                        ]
                    }
                ],
                patterns: { constantArgs: 0, variableArgs: 3, awaitedCalls: 0, chainedCalls: 0, spreadCalls: 0 }
            };
            const text = output.formatImpact(impact);

            assert.ok(text.includes('Impact analysis for saveUser'), 'Should show header');
            assert.ok(text.includes('src/db.js:15'), 'Should show definition location');
            assert.ok(text.includes('saveUser(user)'), 'Should show signature');
            assert.ok(text.includes('CALL SITES: 3'), 'Should show total call sites');
            assert.ok(text.includes('Files affected: 2'), 'Should show affected file count');
            assert.ok(text.includes('3 with variables'), 'Should show variable args pattern');
            assert.ok(text.includes('BY FILE:'), 'Should have by-file section');
            assert.ok(text.includes('src/api.js (2 calls)'), 'Should show file group');
            assert.ok(text.includes('[createUser]'), 'Should show caller name');
            assert.ok(text.includes('saveUser(newUser)'), 'Should show expression');
            assert.ok(text.includes('args: newUser'), 'Should show args');
            assert.ok(text.includes('src/admin.js (1 calls)'), 'Should show second file group');
        });

        it('formats impact without patterns when all zero', () => {
            const impact = {
                function: 'fn',
                file: 'a.js',
                startLine: 1,
                signature: 'fn()',
                totalCallSites: 1,
                byFile: [
                    { file: 'b.js', count: 1, sites: [{ line: 5, callerName: null, expression: 'fn()' }] }
                ],
                patterns: { constantArgs: 0, variableArgs: 0, awaitedCalls: 0, chainedCalls: 0, spreadCalls: 0 }
            };
            const text = output.formatImpact(impact);
            assert.ok(!text.includes('Patterns:'), 'Should not show patterns when all zero');
        });

    });

    // ────────────────────────────────────────────────────────────────────────
    // 7. formatDiffImpact
    // ────────────────────────────────────────────────────────────────────────

    describe('formatDiffImpact', () => {

        it('returns "No diff data." for null input', () => {
            const text = output.formatDiffImpact(null);
            assert.strictEqual(text, 'No diff data.');
        });

        it('formats diff impact with modified, new, and deleted functions', () => {
            const result = {
                base: 'HEAD',
                summary: {
                    modifiedFunctions: 1,
                    deletedFunctions: 1,
                    newFunctions: 1,
                    totalCallSites: 5,
                    affectedFiles: 3
                },
                functions: [
                    {
                        name: 'processData',
                        relativePath: 'src/app.js',
                        startLine: 10,
                        signature: 'processData(input)',
                        addedLines: [12, 13],
                        deletedLines: [11],
                        callers: [
                            { relativePath: 'src/main.js', line: 20, callerName: 'main', content: 'processData(data)' }
                        ]
                    }
                ],
                newFunctions: [
                    { name: 'validateInput', relativePath: 'src/validate.js', startLine: 5, signature: 'validateInput(data)' }
                ],
                deletedFunctions: [
                    { name: 'oldHelper', relativePath: 'src/old.js', startLine: 1 }
                ],
                moduleLevelChanges: [
                    { relativePath: 'src/config.js', addedLines: [1, 2, 3], deletedLines: [] }
                ]
            };
            const text = output.formatDiffImpact(result);

            assert.ok(text.includes('Diff Impact Analysis (vs HEAD)'), 'Should show header with base');
            assert.ok(text.includes('1 modified'), 'Should mention modified count');
            assert.ok(text.includes('1 deleted'), 'Should mention deleted count');
            assert.ok(text.includes('1 new'), 'Should mention new count');
            assert.ok(text.includes('5 call sites'), 'Should mention call sites');

            // Modified
            assert.ok(text.includes('MODIFIED FUNCTIONS:'), 'Should have modified section');
            assert.ok(text.includes('processData'), 'Should show modified function name');
            assert.ok(text.includes('Lines added:'), 'Should show added lines');
            assert.ok(text.includes('Lines deleted:'), 'Should show deleted lines');
            assert.ok(text.includes('Callers (1):'), 'Should show callers');
            assert.ok(text.includes('src/main.js:20'), 'Should show caller location');

            // New
            assert.ok(text.includes('NEW FUNCTIONS:'), 'Should have new section');
            assert.ok(text.includes('validateInput'), 'Should show new function name');

            // Deleted
            assert.ok(text.includes('DELETED FUNCTIONS:'), 'Should have deleted section');
            assert.ok(text.includes('oldHelper'), 'Should show deleted function name');

            // Module-level
            assert.ok(text.includes('MODULE-LEVEL CHANGES:'), 'Should have module-level section');
            assert.ok(text.includes('src/config.js'), 'Should show changed config file');
            assert.ok(text.includes('+3 lines'), 'Should show added lines count');
        });

        it('omits sections when empty', () => {
            const result = {
                base: 'main',
                summary: { modifiedFunctions: 1, deletedFunctions: 0, newFunctions: 0, totalCallSites: 0, affectedFiles: 0 },
                functions: [
                    {
                        name: 'fn',
                        relativePath: 'a.js',
                        startLine: 1,
                        signature: 'fn()',
                        addedLines: [2],
                        deletedLines: [],
                        callers: []
                    }
                ],
                newFunctions: [],
                deletedFunctions: [],
                moduleLevelChanges: []
            };
            const text = output.formatDiffImpact(result);
            assert.ok(text.includes('MODIFIED FUNCTIONS:'), 'Should show modified section');
            assert.ok(!text.includes('NEW FUNCTIONS:'), 'Should not show new functions section');
            assert.ok(!text.includes('DELETED FUNCTIONS:'), 'Should not show deleted section');
            assert.ok(!text.includes('MODULE-LEVEL CHANGES:'), 'Should not show module-level section');
            assert.ok(text.includes('Callers: none found'), 'Should say no callers');
        });

    });

    // ────────────────────────────────────────────────────────────────────────
    // 8. formatRelated
    // ────────────────────────────────────────────────────────────────────────

    describe('formatRelated', () => {

        it('returns "Function not found." for null input', () => {
            const text = output.formatRelated(null);
            assert.strictEqual(text, 'Function not found.');
        });

        it('formats related with all sections', () => {
            const related = {
                target: { name: 'parseJSON', file: 'src/parser.js', line: 10 },
                sameFile: [
                    { name: 'parseXML', line: 30, params: 'data' },
                    { name: 'parseCSV', line: 50, params: 'data, delimiter' }
                ],
                similarNames: [
                    { name: 'parseYAML', file: 'src/yaml.js', line: 5, sharedParts: ['parse'] }
                ],
                sharedCallers: [
                    { name: 'formatJSON', file: 'src/format.js', line: 15, sharedCallerCount: 3 }
                ],
                sharedCallees: [
                    { name: 'validate', file: 'src/validator.js', line: 1, sharedCalleeCount: 2 }
                ]
            };
            const text = output.formatRelated(related);

            assert.ok(text.includes('Related to parseJSON'), 'Should show header');
            assert.ok(text.includes('src/parser.js:10'), 'Should show target location');

            // Same file
            assert.ok(text.includes('SAME FILE (2):'), 'Should show same file section');
            assert.ok(text.includes('parseXML(data)'), 'Should show same-file function');
            assert.ok(text.includes('parseCSV(data, delimiter)'), 'Should show second function with params');

            // Similar names
            assert.ok(text.includes('SIMILAR NAMES (1):'), 'Should show similar names section');
            assert.ok(text.includes('parseYAML'), 'Should show similar name');
            assert.ok(text.includes('shared: parse'), 'Should show shared parts');

            // Shared callers
            assert.ok(text.includes('CALLED BY SAME FUNCTIONS (1):'), 'Should show shared callers');
            assert.ok(text.includes('formatJSON'), 'Should show shared caller name');
            assert.ok(text.includes('3 shared callers'), 'Should show shared count');

            // Shared callees
            assert.ok(text.includes('CALLS SAME FUNCTIONS (1):'), 'Should show shared callees');
            assert.ok(text.includes('validate'), 'Should show shared callee name');
        });

        it('omits empty sections', () => {
            const related = {
                target: { name: 'fn', file: 'a.js', line: 1 },
                sameFile: [],
                similarNames: [],
                sharedCallers: [],
                sharedCallees: []
            };
            const text = output.formatRelated(related);
            assert.ok(text.includes('Related to fn'), 'Should show header');
            assert.ok(!text.includes('SAME FILE'), 'Should not show empty same file');
            assert.ok(!text.includes('SIMILAR NAMES'), 'Should not show empty similar names');
            assert.ok(!text.includes('CALLED BY SAME'), 'Should not show empty shared callers');
            assert.ok(!text.includes('CALLS SAME'), 'Should not show empty shared callees');
        });

        it('shows truncation hint when same file exceeds limit', () => {
            const sameFile = [];
            for (let i = 0; i < 12; i++) {
                sameFile.push({ name: `fn${i}`, line: i + 1 });
            }
            const related = {
                target: { name: 'main', file: 'a.js', line: 1 },
                sameFile,
                similarNames: [],
                sharedCallers: [],
                sharedCallees: []
            };
            const text = output.formatRelated(related);
            assert.ok(text.includes('... and 4 more'), 'Should show truncation (12 - 8 default = 4 more)');
            assert.ok(text.includes('truncated'), 'Should indicate truncation');
        });

        it('shows all with showAll option', () => {
            const sameFile = [];
            for (let i = 0; i < 12; i++) {
                sameFile.push({ name: `fn${i}`, line: i + 1 });
            }
            const related = {
                target: { name: 'main', file: 'a.js', line: 1 },
                sameFile,
                similarNames: [],
                sharedCallers: [],
                sharedCallees: []
            };
            const text = output.formatRelated(related, { showAll: true });
            assert.ok(!text.includes('... and'), 'Should not truncate with showAll');
            assert.ok(text.includes('fn11'), 'Should show last function');
        });

    });

});

// ============================================================================
// NEW: Additional Formatter Coverage
// ============================================================================

describe('Additional Formatter Coverage', () => {

    // --- formatFn ---
    describe('formatFn', () => {
        it('formats function with location and code', () => {
            const match = { relativePath: 'src/utils.js', startLine: 10, endLine: 15, name: 'helper', params: 'x, y' };
            const code = 'function helper(x, y) {\n  return x + y;\n}';
            const text = output.formatFn(match, code);
            assert.ok(text.includes('src/utils.js:10'), 'Should show file:line');
            assert.ok(text.includes('10-'), 'Should show line range');
            assert.ok(text.includes('helper(x, y)'), 'Should show function signature');
            assert.ok(text.includes('function helper(x, y)'), 'Should include code');
        });
    });

    // --- formatClass ---
    describe('formatClass', () => {
        it('formats class with location and code', () => {
            const cls = { relativePath: 'src/model.js', file: '/abs/src/model.js', startLine: 5, endLine: 20, type: 'class', name: 'User' };
            const code = 'class User {\n  constructor() {}\n}';
            const text = output.formatClass(cls, code);
            assert.ok(text.includes('src/model.js:5'), 'Should show file:line');
            assert.ok(text.includes('5-'), 'Should show line range');
            assert.ok(text.includes('class User'), 'Should include class signature and code');
        });

        it('falls back to file when relativePath missing', () => {
            const cls = { file: '/abs/src/model.js', startLine: 1, endLine: 10, type: 'class', name: 'Foo' };
            const text = output.formatClass(cls, 'class Foo {}');
            assert.ok(text.includes('/abs/src/model.js:1'), 'Should fall back to file');
        });
    });

    // --- formatApi ---
    describe('formatApi', () => {
        it('formats project API with grouped symbols', () => {
            const symbols = [
                { file: 'src/a.js', name: 'foo', type: 'function', startLine: 1, endLine: 5, signature: 'function foo()' },
                { file: 'src/a.js', name: 'bar', type: 'function', startLine: 10, endLine: 15, signature: 'function bar(x)' },
                { file: 'src/b.js', name: 'Baz', type: 'class', startLine: 1, endLine: 20, signature: 'class Baz' }
            ];
            const text = output.formatApi(symbols);
            assert.ok(text.includes('Project API'), 'Should have project header');
            assert.ok(text.includes('src/a.js'), 'Should group by file');
            assert.ok(text.includes('src/b.js'), 'Should show second file');
            assert.ok(text.includes('1-') && text.includes('5]'), 'Should show line ranges');
        });

        it('formats file-scoped API', () => {
            const symbols = [{ file: 'lib.js', name: 'init', type: 'function', startLine: 1, endLine: 3 }];
            const text = output.formatApi(symbols, 'lib.js');
            assert.ok(text.includes('Exports from lib.js'), 'Should mention file path in header');
        });

        it('returns none found for empty symbols', () => {
            const text = output.formatApi([]);
            assert.ok(text.includes('(none found)'), 'Should say none found');
        });
    });

    // --- formatTypedef ---
    describe('formatTypedef', () => {
        it('formats type definitions with usage count', () => {
            const types = [
                { relativePath: 'types.ts', startLine: 10, type: 'interface', name: 'Config', usageCount: 5, code: 'interface Config { port: number; }' }
            ];
            const text = output.formatTypedef(types, 'Config');
            assert.ok(text.includes('Type definitions for "Config"'), 'Should show query name');
            assert.ok(text.includes('types.ts:10'), 'Should show location');
            assert.ok(text.includes('interface'), 'Should show type kind');
            assert.ok(text.includes('5 usages'), 'Should show usage count');
            assert.ok(text.includes('interface Config'), 'Should include code');
        });

        it('shows zero usage count', () => {
            const types = [{ relativePath: 'a.ts', startLine: 1, type: 'type', name: 'X', usageCount: 0 }];
            const text = output.formatTypedef(types, 'X');
            assert.ok(text.includes('0 usages'), 'Should show 0 usages');
        });

        it('returns none found for empty', () => {
            const text = output.formatTypedef([], 'Missing');
            assert.ok(text.includes('(none found)'), 'Should say none found');
        });
    });

    // --- formatStats ---
    describe('formatStats', () => {
        it('formats project stats with language and type breakdown', () => {
            const stats = {
                root: '/project',
                files: 10,
                symbols: 50,
                buildTime: 123,
                byLanguage: { javascript: { files: 8, lines: 500, symbols: 40 }, python: { files: 2, lines: 100, symbols: 10 } },
                byType: { function: 30, class: 10, variable: 10 }
            };
            const text = output.formatStats(stats);
            assert.ok(text.includes('PROJECT STATISTICS'), 'Should have header');
            assert.ok(text.includes('10'), 'Should show file count');
            assert.ok(text.includes('50'), 'Should show symbol count');
            assert.ok(text.includes('javascript'), 'Should show language');
            assert.ok(text.includes('python'), 'Should show second language');
            assert.ok(text.includes('function'), 'Should show type');
        });

        it('includes function line counts when present', () => {
            const stats = {
                root: '/p',
                files: 1,
                symbols: 2,
                buildTime: 10,
                byLanguage: { javascript: { files: 1, lines: 100, symbols: 2 } },
                byType: { function: 2 },
                functions: [
                    { file: 'a.js', startLine: 1, name: 'big', lines: 50 },
                    { file: 'a.js', startLine: 60, name: 'small', lines: 10 }
                ]
            };
            const text = output.formatStats(stats);
            assert.ok(text.includes('big'), 'Should show function name');
            assert.ok(text.includes('50'), 'Should show line count');
        });
    });

    // --- formatImports ---
    describe('formatImports', () => {
        it('formats internal and external imports', () => {
            const imports = [
                { isExternal: false, isDynamic: false, module: './utils', resolved: 'src/utils.js', names: ['helper'] },
                { isExternal: true, isDynamic: false, module: 'lodash', names: ['map', 'filter'] }
            ];
            const text = output.formatImports(imports, 'src/index.js');
            assert.ok(text.includes('Imports in src/index.js'), 'Should show file header');
            assert.ok(text.includes('INTERNAL'), 'Should have internal section');
            assert.ok(text.includes('EXTERNAL'), 'Should have external section');
            assert.ok(text.includes('src/utils.js'), 'Should show resolved path');
            assert.ok(text.includes('lodash'), 'Should show external module');
        });

        it('formats dynamic imports', () => {
            const imports = [
                { isExternal: false, isDynamic: true, module: '', names: [] }
            ];
            const text = output.formatImports(imports, 'a.js');
            assert.ok(text.includes('DYNAMIC'), 'Should have dynamic section');
        });

        it('handles file-not-found error', () => {
            const text = output.formatImports({ error: 'file-not-found', filePath: 'missing.js' }, 'missing.js');
            assert.ok(text.includes('not found') || text.includes('Error'), 'Should show error');
        });
    });

    // --- formatExporters ---
    describe('formatExporters', () => {
        it('formats list of importing files', () => {
            const exporters = [
                { file: 'src/a.js', importLine: 5 },
                { file: 'src/b.js', importLine: 12 }
            ];
            const text = output.formatExporters(exporters, 'src/utils.js');
            assert.ok(text.includes('src/utils.js'), 'Should mention target file');
            assert.ok(text.includes('src/a.js'), 'Should list importer');
            assert.ok(text.includes('src/b.js'), 'Should list second importer');
        });

        it('returns none found for empty', () => {
            const text = output.formatExporters([], 'lonely.js');
            assert.ok(text.includes('(none found)'), 'Should say none found');
        });

        it('handles file-not-found error', () => {
            const text = output.formatExporters({ error: 'file-not-found', filePath: 'x.js' }, 'x.js');
            assert.ok(text.includes('not found') || text.includes('Error'), 'Should show error');
        });
    });

    // --- formatFileExports ---
    describe('formatFileExports', () => {
        it('formats export list with signatures', () => {
            const exports = [
                { startLine: 1, endLine: 5, name: 'parse', signature: 'function parse(code)' },
                { startLine: 10, endLine: 12, name: 'VERSION' }
            ];
            const text = output.formatFileExports(exports, 'lib.js');
            assert.ok(text.includes('Exports from lib.js'), 'Should show header');
            assert.ok(text.includes('1-') && text.includes('5]'), 'Should show line range');
            assert.ok(text.includes('function parse(code)'), 'Should show signature');
            assert.ok(text.includes('VERSION'), 'Should show name fallback');
        });

        it('returns no exports for empty', () => {
            const text = output.formatFileExports([], 'empty.js');
            assert.ok(text.includes('No exports found'), 'Should say no exports');
        });

        it('handles file-not-found error', () => {
            const text = output.formatFileExports({ error: 'file-not-found', filePath: 'x.js' }, 'x.js');
            assert.ok(text.includes('not found') || text.includes('Error'), 'Should show error');
        });
    });

    // --- formatToc ---
    describe('formatToc', () => {
        it('formats compact toc with totals and files', () => {
            const toc = {
                totals: { files: 3, lines: 300, functions: 15, classes: 2, state: 1 },
                files: [
                    { file: 'a.js', lines: 150, functions: 10, classes: 1, state: 0 },
                    { file: 'b.js', lines: 100, functions: 3, classes: 1, state: 1 },
                    { file: 'c.js', lines: 50, functions: 2, classes: 0, state: 0 }
                ]
            };
            const text = output.formatToc(toc);
            assert.ok(text.includes('3 files'), 'Should show file count');
            assert.ok(text.includes('300 lines'), 'Should show line count');
            assert.ok(text.includes('a.js'), 'Should list files');
        });

        it('formats detailed toc with symbols', () => {
            const toc = {
                totals: { files: 1, lines: 50, functions: 2, classes: 0, state: 0 },
                files: [{
                    file: 'lib.js', lines: 50, functions: 2, classes: 0, state: 0,
                    symbols: {
                        functions: [{ name: 'parse', startLine: 1, endLine: 10, signature: 'function parse(code)' }],
                        classes: []
                    }
                }]
            };
            const text = output.formatToc(toc);
            assert.ok(text.includes('parse'), 'Should show function names in detailed mode');
        });

        it('shows hidden files hint', () => {
            const toc = {
                totals: { files: 100, lines: 5000, functions: 200, classes: 20, state: 5 },
                files: [{ file: 'a.js', lines: 50, functions: 5, classes: 1, state: 0 }],
                hiddenFiles: 99
            };
            const text = output.formatToc(toc);
            assert.ok(text.includes('99'), 'Should mention hidden file count');
        });

        it('shows entry points from summary', () => {
            const toc = {
                totals: { files: 2, lines: 100, functions: 5, classes: 0, state: 0 },
                files: [{ file: 'index.js', lines: 50, functions: 3, classes: 0, state: 0 }],
                summary: { entryFiles: ['index.js'] }
            };
            const text = output.formatToc(toc);
            assert.ok(text.includes('index.js'), 'Should show entry point');
        });
    });

    // --- formatGraph ---
    describe('formatGraph', () => {
        it('formats single-direction import tree', () => {
            const graph = {
                root: 'src/index.js',
                nodes: [{ file: 'src/index.js', relativePath: 'src/index.js' }, { file: 'src/utils.js', relativePath: 'src/utils.js' }],
                edges: [{ from: 'src/index.js', to: 'src/utils.js' }],
                direction: 'imports'
            };
            const text = output.formatGraph(graph);
            assert.ok(text.includes('src/index.js'), 'Should show root');
            assert.ok(text.includes('src/utils.js'), 'Should show dependency');
        });

        it('formats both-direction graph', () => {
            const graph = {
                root: 'src/lib.js',
                nodes: [{ file: 'src/lib.js', relativePath: 'src/lib.js' }],
                edges: [],
                direction: 'both',
                imports: { nodes: [{ file: 'src/dep.js', relativePath: 'src/dep.js' }], edges: [{ from: 'src/lib.js', to: 'src/dep.js' }] },
                importers: { nodes: [{ file: 'src/main.js', relativePath: 'src/main.js' }], edges: [{ from: 'src/main.js', to: 'src/lib.js' }] }
            };
            const text = output.formatGraph(graph);
            assert.ok(text.includes('IMPORTS') || text.includes('imports'), 'Should have imports section');
            assert.ok(text.includes('IMPORTERS') || text.includes('importers'), 'Should have importers section');
        });

        it('handles empty graph', () => {
            const graph = { root: 'missing.js', nodes: [], edges: [] };
            const text = output.formatGraph(graph);
            assert.ok(text.includes('not found') || text.includes('File not found') || text.length > 0, 'Should handle empty');
        });

        it('handles file-not-found error', () => {
            const text = output.formatGraph({ error: 'file-not-found', filePath: 'x.js' });
            assert.ok(text.includes('not found') || text.includes('Error'), 'Should show error');
        });
    });

    // --- JSON Formatters ---
    describe('JSON Formatters', () => {

        it('formatTocJson returns meta and structured data', () => {
            const toc = { totals: { files: 1, lines: 10 }, files: [{ file: 'a.js' }] };
            const json = JSON.parse(output.formatTocJson(toc));
            assert.ok(json.meta, 'Should have meta');
            assert.ok(json.totals || json.files, 'Should have toc data');
        });

        it('formatSymbolJson wraps results with query', () => {
            const symbols = [{ name: 'foo', type: 'function', file: 'a.js', startLine: 1, endLine: 5 }];
            const json = JSON.parse(output.formatSymbolJson(symbols, 'foo'));
            assert.ok(json.meta, 'Should have meta');
            assert.strictEqual(json.data.query, 'foo', 'Should include query');
            assert.strictEqual(json.data.count, 1, 'Should count results');
        });

        it('formatUsagesJson splits by type', () => {
            const usages = [
                { type: 'definition', file: 'a.js', line: 1 },
                { type: 'call', file: 'b.js', line: 5 },
                { type: 'import', file: 'c.js', line: 1 }
            ];
            const json = JSON.parse(output.formatUsagesJson(usages, 'x'));
            assert.ok(json.data, 'Should have data');
            assert.strictEqual(json.data.symbol, 'x', 'Should include symbol name');
        });

        it('formatContextJson handles function context', () => {
            const ctx = {
                name: 'parse',
                file: 'a.js',
                callers: [{ name: 'main', file: 'b.js', line: 10 }],
                callees: [{ name: 'tokenize', file: 'a.js', line: 20, weight: 'core' }]
            };
            const json = JSON.parse(output.formatContextJson(ctx));
            assert.ok(json.meta, 'Should have meta');
            assert.ok(json.data.callerCount !== undefined || json.data.function, 'Should include function info');
        });

        it('formatFunctionJson returns flat object', () => {
            const fn = { name: 'go', params: ['x'], startLine: 1, endLine: 3 };
            const json = JSON.parse(output.formatFunctionJson(fn, 'function go(x) {}'));
            assert.strictEqual(json.name, 'go', 'Should have name');
            assert.strictEqual(json.code, 'function go(x) {}', 'Should have code');
        });

        it('formatSearchJson includes term and files', () => {
            const results = [{ file: 'a.js', matches: [{ line: 1, content: 'hello' }] }];
            results.meta = { filesScanned: 1 };
            const json = JSON.parse(output.formatSearchJson(results, 'hello'));
            assert.strictEqual(json.term, 'hello', 'Should include term');
            assert.strictEqual(json.totalMatches, 1, 'Should count matches');
        });

        it('formatImportsJson handles normal and error', () => {
            const imports = [{ module: 'fs', names: ['readFileSync'], isExternal: true, isDynamic: false }];
            const json = JSON.parse(output.formatImportsJson(imports, 'a.js'));
            assert.strictEqual(json.file, 'a.js', 'Should include file');
            assert.ok(json.importCount >= 0, 'Should have count');

            const errJson = JSON.parse(output.formatImportsJson({ error: 'file-not-found', filePath: 'x.js' }, 'x.js'));
            assert.strictEqual(errJson.found, false, 'Error should set found=false');
        });

        it('formatStatsJson returns stringified stats', () => {
            const stats = { root: '/p', files: 1, symbols: 2 };
            const json = JSON.parse(output.formatStatsJson(stats));
            assert.strictEqual(json.root, '/p', 'Should passthrough');
        });

        it('formatGraphJson handles normal and error', () => {
            const graph = { file: 'a.js', depth: 2, dependencies: [] };
            const json = JSON.parse(output.formatGraphJson(graph));
            assert.strictEqual(json.file, 'a.js', 'Should include file');

            const errJson = JSON.parse(output.formatGraphJson({ error: 'file-not-found', filePath: 'x.js' }));
            assert.strictEqual(errJson.found, false, 'Error should set found=false');
        });

        it('formatSmartJson includes target and dependencies', () => {
            const result = {
                target: { name: 'fn', file: 'a.js', startLine: 1, endLine: 5, params: [], code: 'function fn() {}' },
                dependencies: [],
                types: []
            };
            const json = JSON.parse(output.formatSmartJson(result));
            assert.ok(json.data.target, 'Should have target');
            assert.strictEqual(json.data.target.name, 'fn', 'Target should have name');
        });

        it('formatExportersJson handles normal and error', () => {
            const exporters = [{ file: 'b.js', importLine: 3 }];
            const json = JSON.parse(output.formatExportersJson(exporters, 'a.js'));
            assert.strictEqual(json.file, 'a.js', 'Should include file');
            assert.strictEqual(json.importerCount, 1, 'Should count importers');

            const errJson = JSON.parse(output.formatExportersJson({ error: 'file-not-found', filePath: 'x.js' }, 'x.js'));
            assert.strictEqual(errJson.found, false, 'Error should set found=false');
        });

        it('formatTypedefJson includes query and types', () => {
            const types = [{ name: 'Cfg', type: 'interface', file: 'a.ts', startLine: 1, endLine: 5 }];
            const json = JSON.parse(output.formatTypedefJson(types, 'Cfg'));
            assert.strictEqual(json.query, 'Cfg', 'Should include query');
            assert.strictEqual(json.count, 1, 'Should count types');
        });

        it('formatTestsJson includes query and count', () => {
            const tests = [{ file: 'test/a.test.js', matches: [{ line: 5, content: 'it("works")' }] }];
            const json = JSON.parse(output.formatTestsJson(tests, 'fn'));
            assert.strictEqual(json.query, 'fn', 'Should include query');
            assert.ok(json.testFileCount >= 0, 'Should have count');
        });

        it('formatApiJson includes exports', () => {
            const symbols = [{ name: 'init', type: 'function', file: 'a.js', startLine: 1, endLine: 3 }];
            const json = JSON.parse(output.formatApiJson(symbols));
            assert.strictEqual(json.exportCount, 1, 'Should count exports');
        });

        it('formatTraceJson handles null and data', () => {
            const errJson = JSON.parse(output.formatTraceJson(null));
            assert.strictEqual(errJson.found, false, 'Null should return not found');

            const json = JSON.parse(output.formatTraceJson({ name: 'fn', children: [] }));
            assert.ok(json.name, 'Should passthrough data');
        });

        it('formatRelatedJson handles null and data', () => {
            const errJson = JSON.parse(output.formatRelatedJson(null));
            assert.strictEqual(errJson.found, false, 'Null should return not found');
        });

        it('formatImpactJson handles null and data', () => {
            const errJson = JSON.parse(output.formatImpactJson(null));
            assert.strictEqual(errJson.found, false, 'Null should return not found');
        });

        it('formatAboutJson handles null and data', () => {
            const errJson = JSON.parse(output.formatAboutJson(null));
            assert.strictEqual(errJson.found, false, 'Null should return not found');
        });

        it('formatPlanJson handles null and found/not-found', () => {
            const errJson = JSON.parse(output.formatPlanJson(null));
            assert.strictEqual(errJson.found, false, 'Null should return not found');

            const notFound = JSON.parse(output.formatPlanJson({ found: false }));
            assert.strictEqual(notFound.found, false, 'Not found should propagate');
        });

        it('formatStackTraceJson handles empty result', () => {
            const json = JSON.parse(output.formatStackTraceJson(null));
            assert.strictEqual(json.frameCount, 0, 'Null should return 0 frames');
        });

        it('formatVerifyJson handles null and not-found', () => {
            const errJson = JSON.parse(output.formatVerifyJson(null));
            assert.strictEqual(errJson.found, false, 'Null should return not found');

            const notFound = JSON.parse(output.formatVerifyJson({ found: false }));
            assert.strictEqual(notFound.found, false, 'Not found should propagate');
        });

        it('formatExampleJson handles null and found', () => {
            const errJson = JSON.parse(output.formatExampleJson(null, 'fn'));
            assert.strictEqual(errJson.found, false, 'Null should return not found');
            assert.strictEqual(errJson.query, 'fn', 'Should include query');
        });

        it('formatDeadcodeJson returns count and symbols', () => {
            const results = [{ name: 'unused', type: 'function', file: 'a.js', startLine: 1, endLine: 3 }];
            const json = JSON.parse(output.formatDeadcodeJson(results));
            assert.strictEqual(json.count, 1, 'Should count symbols');
            assert.strictEqual(json.symbols[0].name, 'unused', 'Should include symbol');
        });

        it('formatDiffImpactJson passthroughs data', () => {
            const result = { changedFunctions: [], deletedFunctions: [] };
            const json = JSON.parse(output.formatDiffImpactJson(result));
            assert.ok(Array.isArray(json.changedFunctions), 'Should passthrough');
        });
    });
});

describe('Bug Hunt: Formatter regressions', () => {
    it('formatFind shows clean output when all usage counts are zero', () => {
        const results = [{
            relativePath: 'test.js',
            startLine: 1,
            name: 'test',
            type: 'function',
            params: 'a',
            usageCounts: { calls: 0, definitions: 0, imports: 0, references: 0, total: 0 }
        }];
        const text = output.formatFind(results, 'test');
        assert.ok(!text.includes('usages: )'), 'should not have trailing colon-space before paren');
        assert.ok(text.includes('(0 usages)'), 'should show clean (0 usages) without breakdown');
    });

    it('formatAbout depth works with both string and numeric values', () => {
        const about = {
            found: true,
            symbol: { name: 'hello', type: 'function', file: 'test.js', startLine: 1, endLine: 3 },
            source: 'function hello() {}',
            callers: [],
            callees: [],
            tests: [],
            usages: { calls: 0, imports: 0, references: 0 },
            totalUsages: 0,
        };

        // String depth (from CLI) should work
        const textStr = output.formatAbout(about, { depth: '0' });
        assert.ok(textStr.includes('test.js:1'), 'string depth 0 should return location');
        assert.ok(!textStr.includes('═'), 'string depth 0 should be compact');

        // Numeric depth (from MCP) should also work
        const textNum = output.formatAbout(about, { depth: 0 });
        assert.ok(textNum.includes('test.js:1'), 'numeric depth 0 should return location');
        assert.ok(!textNum.includes('═'), 'numeric depth 0 should be compact');

        // Numeric depth 1 should also work
        const textNum1 = output.formatAbout(about, { depth: 1 });
        assert.ok(textNum1.includes('test.js:1'), 'numeric depth 1 should include location');
        assert.ok(textNum1.includes('usages'), 'numeric depth 1 should include usage counts');
    });

    it('formatGraph uses correct tree connectors (last child gets └──)', () => {
        const graph = {
            root: '/project/src/index.js',
            nodes: [
                { file: '/project/src/index.js', relativePath: 'src/index.js' },
                { file: '/project/src/a.js', relativePath: 'src/a.js' },
                { file: '/project/src/b.js', relativePath: 'src/b.js' },
            ],
            edges: [
                { from: '/project/src/index.js', to: '/project/src/a.js' },
                { from: '/project/src/index.js', to: '/project/src/b.js' },
            ]
        };
        const text = output.formatGraph(graph, { showAll: true });
        // Last child (b.js) should use └── connector
        assert.ok(text.includes('└── src/b.js'), `last child should use └── connector, got:\n${text}`);
        // First child (a.js) should use ├── connector
        assert.ok(text.includes('├── src/a.js'), `non-last child should use ├── connector, got:\n${text}`);
    });
});
