/**
 * UCN Feature Tests
 *
 * Deadcode, graph, file-exports, HTML parsing, search, stats, MCP param parity.
 * Extracted from parser.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { parse, parseFile, detectLanguage } = require('../core/parser');
const { ProjectIndex } = require('../core/project');
const output = require('../core/output');
const { createTempDir, cleanup, tmp, rm, idx, FIXTURES_PATH, PROJECT_DIR } = require('./helpers');

// ============================================================================
// FEATURE TESTS: file-exports, deadcode, graph
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
// REGRESSION: deadcode detection accuracy
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
// HTML PARSING
// ============================================================================

describe('HTML Parsing', () => {
    const { getParser, getLanguageModule } = require('../languages');

    function getHtmlTools() {
        return {
            parser: getParser('html'),
            mod: getLanguageModule('html')
        };
    }

    // -- Language detection --

    it('detects HTML files', () => {
        assert.strictEqual(detectLanguage('file.html'), 'html');
        assert.strictEqual(detectLanguage('page.htm'), 'html');
        assert.strictEqual(detectLanguage('INDEX.HTML'), 'html');
    });

    // -- Script extraction basics --

    it('finds functions in a single script block', () => {
        const { parser, mod } = getHtmlTools();
        const html = '<html><body><script>\nfunction hello() { return 1; }\n</script></body></html>';
        const fns = mod.findFunctions(html, parser);
        assert.strictEqual(fns.length, 1);
        assert.strictEqual(fns[0].name, 'hello');
    });

    it('finds functions from multiple script blocks', () => {
        const { parser, mod } = getHtmlTools();
        const html = `<script>
function foo() {}
</script>
<div>content</div>
<script>
function bar() {}
</script>`;
        const fns = mod.findFunctions(html, parser);
        const names = fns.map(f => f.name);
        assert.ok(names.includes('foo'), `Expected foo in ${names}`);
        assert.ok(names.includes('bar'), `Expected bar in ${names}`);
    });

    it('returns empty results for HTML with no script tags', () => {
        const { parser, mod } = getHtmlTools();
        const html = '<html><body><h1>Hello</h1></body></html>';
        const result = mod.parse(html, parser);
        assert.strictEqual(result.functions.length, 0);
        assert.strictEqual(result.classes.length, 0);
        assert.strictEqual(result.language, 'html');
    });

    it('returns empty results for empty script tag', () => {
        const { parser, mod } = getHtmlTools();
        const html = '<html><body><script></script></body></html>';
        const result = mod.parse(html, parser);
        assert.strictEqual(result.functions.length, 0);
    });

    it('returns empty results when only external scripts present', () => {
        const { parser, mod } = getHtmlTools();
        const html = '<script src="app.js"></script>\n<script src="vendor.js"></script>';
        const result = mod.parse(html, parser);
        assert.strictEqual(result.functions.length, 0);
    });

    // -- Type attribute filtering --

    it('parses type="module" scripts', () => {
        const { parser, mod } = getHtmlTools();
        const html = '<script type="module">\nfunction modFn() {}\n</script>';
        const fns = mod.findFunctions(html, parser);
        assert.strictEqual(fns.length, 1);
        assert.strictEqual(fns[0].name, 'modFn');
    });

    it('parses type="text/javascript" scripts', () => {
        const { parser, mod } = getHtmlTools();
        const html = '<script type="text/javascript">\nfunction textJsFn() {}\n</script>';
        const fns = mod.findFunctions(html, parser);
        assert.strictEqual(fns.length, 1);
        assert.strictEqual(fns[0].name, 'textJsFn');
    });

    it('parses type="application/javascript" scripts', () => {
        const { parser, mod } = getHtmlTools();
        const html = '<script type="application/javascript">\nfunction appJsFn() {}\n</script>';
        const fns = mod.findFunctions(html, parser);
        assert.strictEqual(fns.length, 1);
        assert.strictEqual(fns[0].name, 'appJsFn');
    });

    it('skips type="application/json" scripts', () => {
        const { parser, mod } = getHtmlTools();
        const html = '<script type="application/json">{"key": "value"}</script>\n<script>\nfunction realFn() {}\n</script>';
        const fns = mod.findFunctions(html, parser);
        assert.strictEqual(fns.length, 1);
        assert.strictEqual(fns[0].name, 'realFn');
    });

    it('skips type="importmap" scripts', () => {
        const { parser, mod } = getHtmlTools();
        const html = '<script type="importmap">{"imports": {}}</script>';
        const result = mod.parse(html, parser);
        assert.strictEqual(result.functions.length, 0);
    });

    it('parses scripts with no type attribute (default is JS)', () => {
        const { parser, mod } = getHtmlTools();
        const html = '<script>\nfunction defaultFn() {}\n</script>';
        const fns = mod.findFunctions(html, parser);
        assert.strictEqual(fns.length, 1);
        assert.strictEqual(fns[0].name, 'defaultFn');
    });

    it('skips scripts with src attribute', () => {
        const { parser, mod } = getHtmlTools();
        const html = '<script src="app.js"></script>\n<script>\nfunction inlineFn() {}\n</script>';
        const fns = mod.findFunctions(html, parser);
        assert.strictEqual(fns.length, 1);
        assert.strictEqual(fns[0].name, 'inlineFn');
    });

    // -- Line number accuracy --

    it('reports correct line numbers for functions', () => {
        const { parser, mod } = getHtmlTools();
        const html = `<html>
<head>
  <title>Test</title>
</head>
<body>
  <script>
    function atLine7() { return 1; }
    function atLine8() { return 2; }
  </script>
</body>
</html>`;
        const fns = mod.findFunctions(html, parser);
        const fn7 = fns.find(f => f.name === 'atLine7');
        const fn8 = fns.find(f => f.name === 'atLine8');
        assert.ok(fn7, 'atLine7 should be found');
        assert.ok(fn8, 'atLine8 should be found');
        assert.strictEqual(fn7.startLine, 7, `atLine7 should be on line 7, got ${fn7.startLine}`);
        assert.strictEqual(fn8.startLine, 8, `atLine8 should be on line 8, got ${fn8.startLine}`);
    });

    it('reports correct line numbers across multiple script blocks with HTML gaps', () => {
        const { parser, mod } = getHtmlTools();
        const html = `<script>
function first() {}
</script>
<div>gap line 4</div>
<div>gap line 5</div>
<script>
function second() {}
</script>`;
        const fns = mod.findFunctions(html, parser);
        const first = fns.find(f => f.name === 'first');
        const second = fns.find(f => f.name === 'second');
        assert.ok(first && second, 'Both functions should be found');
        assert.strictEqual(first.startLine, 2, `first should be at line 2, got ${first.startLine}`);
        assert.strictEqual(second.startLine, 7, `second should be at line 7, got ${second.startLine}`);
    });

    it('reports correct line numbers for classes', () => {
        const { parser, mod } = getHtmlTools();
        const html = `<html>
<body>
<script>
class MyApp {
    constructor() {}
    render() {}
}
</script>
</body>
</html>`;
        const classes = mod.findClasses(html, parser);
        assert.strictEqual(classes.length, 1);
        assert.strictEqual(classes[0].name, 'MyApp');
        assert.strictEqual(classes[0].startLine, 4, `MyApp should start at line 4, got ${classes[0].startLine}`);
    });

    it('reports correct line numbers for state objects', () => {
        const { parser, mod } = getHtmlTools();
        const html = `<html>
<head>
<script>
const CONFIG = { debug: true, version: '1.0' };
</script>
</head>
</html>`;
        const states = mod.findStateObjects(html, parser);
        const config = states.find(s => s.name === 'CONFIG');
        assert.ok(config, 'CONFIG should be found');
        assert.strictEqual(config.startLine, 4, `CONFIG should be at line 4, got ${config.startLine}`);
    });

    // -- Feature integration --

    it('detects function calls between functions', () => {
        const { parser, mod } = getHtmlTools();
        const html = `<script>
function initApp() { renderUI(); loadData(); }
function renderUI() { console.log('render'); }
function loadData() { fetch('/api'); }
</script>`;
        const calls = mod.findCallsInCode(html, parser);
        const callNames = calls.map(c => c.name);
        assert.ok(callNames.includes('renderUI'), `Expected renderUI call, got: ${callNames}`);
        assert.ok(callNames.includes('loadData'), `Expected loadData call, got: ${callNames}`);
    });

    it('detects cross-block function calls', () => {
        const { parser, mod } = getHtmlTools();
        const html = `<script>
function initApp() { renderUI(); }
</script>
<div>separator</div>
<script>
function renderUI() { console.log('render'); }
</script>`;
        const calls = mod.findCallsInCode(html, parser);
        const callNames = calls.map(c => c.name);
        assert.ok(callNames.includes('renderUI'), `Expected cross-block renderUI call, got: ${callNames}`);
    });

    it('finds usages within script blocks', () => {
        const { parser, mod } = getHtmlTools();
        const html = `<script>
const API_URL = '/api';
function fetchData() { return fetch(API_URL); }
</script>`;
        const usages = mod.findUsagesInCode(html, 'API_URL', parser);
        assert.ok(usages.length >= 1, `Expected at least 1 usage of API_URL, got ${usages.length}`);
    });

    it('finds imports in type="module" scripts', () => {
        const { parser, mod } = getHtmlTools();
        const html = `<script type="module">
import { createApp } from './app.js';
createApp();
</script>`;
        const imports = mod.findImportsInCode(html, parser);
        assert.ok(imports.length >= 1, `Expected imports, got ${imports.length}`);
    });

    it('finds classes and state objects', () => {
        const { parser, mod } = getHtmlTools();
        const html = `<script>
const SETTINGS = { theme: 'dark', lang: 'en' };
class GameEngine {
    constructor() {}
    start() {}
}
</script>`;
        const result = mod.parse(html, parser);
        assert.ok(result.classes.length >= 1, 'Should find GameEngine class');
        assert.strictEqual(result.classes[0].name, 'GameEngine');
        const settings = result.stateObjects.find(s => s.name === 'SETTINGS');
        assert.ok(settings, 'Should find SETTINGS state object');
    });

    // -- Edge cases --

    it('handles script content on same line as script tag (column offset)', () => {
        const { parser, mod } = getHtmlTools();
        const html = '<div><script>function inline() { return 42; }</script></div>';
        const fns = mod.findFunctions(html, parser);
        assert.strictEqual(fns.length, 1);
        assert.strictEqual(fns[0].name, 'inline');
    });

    it('handles mixed JS and non-JS script blocks in same file', () => {
        const { parser, mod } = getHtmlTools();
        const html = `<script type="application/json">{"not": "js"}</script>
<script type="importmap">{"imports": {"a": "b"}}</script>
<script>function realJS() {}</script>
<script type="text/template"><div>{{template}}</div></script>`;
        const fns = mod.findFunctions(html, parser);
        assert.strictEqual(fns.length, 1);
        assert.strictEqual(fns[0].name, 'realJS');
    });

    it('parse() returns language html', () => {
        const { parser, mod } = getHtmlTools();
        const html = '<script>var x = 1;</script>';
        const result = mod.parse(html, parser);
        assert.strictEqual(result.language, 'html');
    });

    it('totalLines matches HTML file line count, not JS line count', () => {
        const { parser, mod } = getHtmlTools();
        const html = `<html>
<head>
  <title>Page</title>
</head>
<body>
  <script>
    var x = 1;
  </script>
</body>
</html>`;
        const result = mod.parse(html, parser);
        assert.strictEqual(result.totalLines, 10, `Expected 10 lines, got ${result.totalLines}`);
    });

    // -- Project integration --

    it('indexes HTML files in project mode', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-html-project-'));
        fs.writeFileSync(path.join(tmpDir, 'index.html'), `<html>
<body>
<script>
function initApp() { renderUI(); }
function renderUI() { console.log('hello'); }
const CONFIG = { debug: true };
</script>
</body>
</html>`);
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

        const { ProjectIndex } = require('../core/project');
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        // Functions should be found
        const initDefs = index.find('initApp');
        assert.ok(initDefs.length > 0, 'initApp should be found in project index');
        assert.strictEqual(initDefs[0].startLine, 4, 'initApp should be at line 4');

        // Callers should work
        const renderDefs = index.find('renderUI');
        assert.ok(renderDefs.length > 0, 'renderUI should be found');
        const callers = index.findCallers('renderUI');
        const callerNames = callers.map(c => c.callerName);
        assert.ok(callerNames.includes('initApp'), `initApp should call renderUI, got: ${callerNames}`);

        // State objects should be found
        const configDefs = index.find('CONFIG');
        assert.ok(configDefs.length > 0, 'CONFIG should be found');

        fs.rmSync(tmpDir, { recursive: true });
    });

    it('extractCode works with HTML files', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-html-extract-'));
        const htmlContent = `<html>
<body>
<script>
function greet(name) {
    return 'Hello ' + name;
}
</script>
</body>
</html>`;
        fs.writeFileSync(path.join(tmpDir, 'page.html'), htmlContent);
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

        const { ProjectIndex } = require('../core/project');
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const defs = index.find('greet');
        assert.ok(defs.length > 0, 'greet should be found');
        const code = index.extractCode(defs[0]);
        assert.ok(code.includes('function greet'), `Extracted code should contain function: ${code}`);
        assert.ok(code.includes('Hello'), `Extracted code should contain body: ${code}`);

        fs.rmSync(tmpDir, { recursive: true });
    });

    // -- extractScriptBlocks and buildVirtualJSContent unit tests --

    it('extractScriptBlocks returns correct block positions', () => {
        const { extractScriptBlocks } = require('../languages/html');
        const parser = getParser('html');
        const html = `<html>
<body>
<script>
var x = 1;
</script>
</body>
</html>`;
        const blocks = extractScriptBlocks(html, parser);
        assert.strictEqual(blocks.length, 1);
        assert.strictEqual(blocks[0].startRow, 2, `Block should start at row 2 (0-indexed, raw_text starts after <script> closing >), got ${blocks[0].startRow}`);
        assert.ok(blocks[0].text.includes('var x = 1'), `Block text should contain JS: ${blocks[0].text}`);
    });

    it('buildVirtualJSContent preserves line positions', () => {
        const { buildVirtualJSContent } = require('../languages/html');
        const html = `line0
line1
<script>
var x = 1;
</script>
line5`;
        const blocks = [{ text: '\nvar x = 1;\n', startRow: 2, startCol: 8 }];
        const virtual = buildVirtualJSContent(html, blocks);
        const lines = virtual.split('\n');
        assert.strictEqual(lines.length, 6, `Should have 6 lines, got ${lines.length}`);
        assert.strictEqual(lines[0], '', 'Line 0 should be empty (HTML)');
        assert.strictEqual(lines[1], '', 'Line 1 should be empty (HTML)');
        assert.strictEqual(lines[3].trim(), 'var x = 1;', 'Line 3 should have JS content');
        assert.strictEqual(lines[5], '', 'Line 5 should be empty (HTML)');
    });

    // Bug fix tests
    // ─────────────────────────────────────────────────────────────

    it('cleanHtmlScriptTags strips script tags from same-line scripts', () => {
        const { cleanHtmlScriptTags } = require('../core/parser');

        // Same-line script: <script>function foo() { return 1; }</script>
        const lines1 = ['<script>function foo() { return 1; }</script>'];
        cleanHtmlScriptTags(lines1, 'html');
        assert.strictEqual(lines1[0], 'function foo() { return 1; }');

        // Multi-line: only first/last lines affected
        const lines2 = ['    <script type="module">', '        function bar() {', '        }', '    </script>'];
        cleanHtmlScriptTags(lines2, 'html');
        assert.strictEqual(lines2[0], '    ', 'First line should have only indentation');
        assert.strictEqual(lines2[1], '        function bar() {', 'Middle lines unchanged');
        assert.strictEqual(lines2[3], '    ', 'Last line should have only indentation');

        // Non-HTML language: no changes
        const lines3 = ['<script>function foo() {}</script>'];
        cleanHtmlScriptTags(lines3, 'javascript');
        assert.strictEqual(lines3[0], '<script>function foo() {}</script>', 'Non-HTML should be unchanged');

        // Uppercase SCRIPT tag
        const lines4 = ['<SCRIPT>function foo() {}</SCRIPT>'];
        cleanHtmlScriptTags(lines4, 'html');
        assert.strictEqual(lines4[0], 'function foo() {}');
    });

    it('extractCode strips script tags for HTML files', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-html-extract-'));
        const htmlFile = path.join(tmpDir, 'test.html');
        fs.writeFileSync(htmlFile, `<!DOCTYPE html>
<html>
<body>
<script>function oneLiner() { return 42; }</script>
<script>
function multiLine() {
    return 99;
}
</script>
</body>
</html>`);

        const { ProjectIndex } = require('../core/project');
        const index = new ProjectIndex(tmpDir);
        index.build();

        // Find oneLiner and check its extracted code
        const oneLineDefs = index.find('oneLiner');
        assert.ok(oneLineDefs.length > 0, 'Should find oneLiner');
        const code = index.extractCode(oneLineDefs[0]);
        assert.ok(!code.includes('<script>'), 'extractCode should not include <script> tag');
        assert.ok(!code.includes('</script>'), 'extractCode should not include </script> tag');
        assert.ok(code.includes('function oneLiner'), 'extractCode should include function body');

        // Multi-line function should not be affected
        const multiDefs = index.find('multiLine');
        assert.ok(multiDefs.length > 0, 'Should find multiLine');
        const multiCode = index.extractCode(multiDefs[0]);
        assert.ok(!multiCode.includes('<script>'), 'Multi-line extractCode should not include <script>');
        assert.ok(multiCode.includes('function multiLine'), 'Multi-line extractCode should include function body');

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('smart respects --file disambiguation', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-html-smart-'));
        // Create two files with same function name
        fs.writeFileSync(path.join(tmpDir, 'a.html'), `<html><body>
<script>
function myFunc() { return 'from html'; }
</script>
</body></html>`);
        fs.writeFileSync(path.join(tmpDir, 'b.js'), `function myFunc() { return 'from js'; }\n`);
        // Need package.json for discovery
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');

        const { ProjectIndex } = require('../core/project');
        const index = new ProjectIndex(tmpDir);
        index.build();

        // Without --file, picks best scoring (b.js is not in tests/ so it should win)
        const result1 = index.smart('myFunc');
        assert.ok(result1, 'smart should find myFunc');

        // With --file=a.html, should pick the HTML file
        const result2 = index.smart('myFunc', { file: 'a.html' });
        assert.ok(result2, 'smart with file filter should find myFunc');
        assert.ok(result2.target.file.endsWith('a.html'), `Should resolve to a.html, got ${result2.target.file}`);

        // With --file=b.js, should pick the JS file
        const result3 = index.smart('myFunc', { file: 'b.js' });
        assert.ok(result3, 'smart with file filter should find myFunc in b.js');
        assert.ok(result3.target.file.endsWith('b.js'), `Should resolve to b.js, got ${result3.target.file}`);

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('deadcode buildUsageIndex parses HTML inline scripts', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-html-deadcode-'));
        fs.writeFileSync(path.join(tmpDir, 'app.html'), `<html><body>
<script>
function helper() { return 42; }
function main() { return helper(); }
</script>
</body></html>`);
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');

        const { ProjectIndex } = require('../core/project');
        const index = new ProjectIndex(tmpDir);
        index.build();

        // helper is called by main, so it should NOT be dead code
        const dead = index.deadcode({ includeExported: true });
        const deadNames = dead.map(d => d.name);
        assert.ok(!deadNames.includes('helper'), `helper should not be dead code (called by main), got: ${deadNames.join(', ')}`);
        // main has no callers, so it should be dead
        assert.ok(deadNames.includes('main'), 'main should be dead code (no callers)');

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── HTML event handler tests (fix #90) ──────────────────────────────────

    it('extractEventHandlerCalls extracts calls from onclick attributes', () => {
        const { extractEventHandlerCalls } = require('../languages/html');
        const parser = getParser('html');
        const html = '<button onclick="resetGame()">Click</button>';
        const calls = extractEventHandlerCalls(html, parser);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].name, 'resetGame');
        assert.strictEqual(calls[0].line, 1);
        assert.strictEqual(calls[0].isMethod, false);
        assert.strictEqual(calls[0].isEventHandler, true);
    });

    it('extractEventHandlerCalls handles multiple calls in one handler', () => {
        const { extractEventHandlerCalls } = require('../languages/html');
        const parser = getParser('html');
        const html = '<button onclick="validateForm(); submitData()">Go</button>';
        const calls = extractEventHandlerCalls(html, parser);
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[0].name, 'validateForm');
        assert.strictEqual(calls[1].name, 'submitData');
    });

    it('extractEventHandlerCalls skips method calls on objects', () => {
        const { extractEventHandlerCalls } = require('../languages/html');
        const parser = getParser('html');
        const html = '<button onclick="event.stopPropagation(); selectCar(\'abc\')">Buy</button>';
        const calls = extractEventHandlerCalls(html, parser);
        const names = calls.map(c => c.name);
        assert.ok(!names.includes('stopPropagation'), 'should skip event.stopPropagation()');
        assert.ok(names.includes('selectCar'), 'should detect selectCar()');
    });

    it('extractEventHandlerCalls skips JS keywords', () => {
        const { extractEventHandlerCalls } = require('../languages/html');
        const parser = getParser('html');
        const html = '<button onclick="if (confirm(\'sure?\')) deleteItem(id)">Del</button>';
        const calls = extractEventHandlerCalls(html, parser);
        const names = calls.map(c => c.name);
        assert.ok(!names.includes('if'), 'should skip keyword if');
        assert.ok(names.includes('confirm'));
        assert.ok(names.includes('deleteItem'));
    });

    it('extractEventHandlerCalls works with various on* attributes', () => {
        const { extractEventHandlerCalls } = require('../languages/html');
        const parser = getParser('html');
        const html = `<input onchange="updateValue()" onfocus="highlight()" onblur="unhighlight()">`;
        const calls = extractEventHandlerCalls(html, parser);
        const names = calls.map(c => c.name);
        assert.ok(names.includes('updateValue'));
        assert.ok(names.includes('highlight'));
        assert.ok(names.includes('unhighlight'));
    });

    it('extractEventHandlerCalls does not extract from script elements', () => {
        const { extractEventHandlerCalls } = require('../languages/html');
        const parser = getParser('html');
        const html = `<script>function foo() { bar(); }</script>
<button onclick="foo()">Click</button>`;
        const calls = extractEventHandlerCalls(html, parser);
        // Should only find foo from onclick, not bar from <script>
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].name, 'foo');
    });

    it('extractEventHandlerCalls reports correct line numbers', () => {
        const { extractEventHandlerCalls } = require('../languages/html');
        const parser = getParser('html');
        const html = `<html>
<body>
<div>text</div>
<button onclick="doA()">A</button>
<button onclick="doB()">B</button>
</body>
</html>`;
        const calls = extractEventHandlerCalls(html, parser);
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[0].name, 'doA');
        assert.strictEqual(calls[0].line, 4);
        assert.strictEqual(calls[1].name, 'doB');
        assert.strictEqual(calls[1].line, 5);
    });

    it('findCallsInCode includes event handler calls for HTML', () => {
        const { parser, mod } = getHtmlTools();
        const html = `<button onclick="handleClick()">Click</button>
<script>
function handleClick() { doWork(); }
function doWork() { return 42; }
</script>`;
        const calls = mod.findCallsInCode(html, parser);
        const names = calls.map(c => c.name);
        assert.ok(names.includes('handleClick'), 'should find handleClick from onclick');
        assert.ok(names.includes('doWork'), 'should find doWork from script');
    });

    it('deadcode does not report functions called from HTML event handlers', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-html-onclick-'));
        fs.writeFileSync(path.join(tmpDir, 'page.html'), `<html><body>
<button onclick="resetGame()">Reset</button>
<button onclick="startGame('easy')">Start</button>
<script>
function resetGame() { init(); }
function startGame(mode) { setup(mode); }
function init() { return 1; }
function setup(m) { return m; }
function unusedFn() { return 0; }
</script>
</body></html>`);
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');

        const { ProjectIndex } = require('../core/project');
        const index = new ProjectIndex(tmpDir);
        index.build();

        const dead = index.deadcode({ includeExported: true });
        const deadNames = dead.map(d => d.name);
        // resetGame and startGame are called from onclick — NOT dead
        assert.ok(!deadNames.includes('resetGame'), 'resetGame should not be dead (called from onclick)');
        assert.ok(!deadNames.includes('startGame'), 'startGame should not be dead (called from onclick)');
        // init and setup are called from script — NOT dead
        assert.ok(!deadNames.includes('init'), 'init should not be dead (called from resetGame)');
        assert.ok(!deadNames.includes('setup'), 'setup should not be dead (called from startGame)');
        // unusedFn has no callers — dead
        assert.ok(deadNames.includes('unusedFn'), 'unusedFn should be dead');

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('verify/impact analyzeCallSite works for HTML inline scripts', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-html-verify-'));
        fs.writeFileSync(path.join(tmpDir, 'game.html'), `<html><body>
<script>
function checkCollision(objA, objB, threshX, threshZ) { return true; }
function update() {
    var hitbox = { x: 1, z: 2 };
    if (checkCollision(p, player, hitbox.x, hitbox.z)) { return; }
}
</script>
</body></html>`);
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');

        const { ProjectIndex } = require('../core/project');
        const index = new ProjectIndex(tmpDir);
        index.build();

        const result = index.verify('checkCollision');
        assert.ok(result.found);
        assert.strictEqual(result.totalCalls, 1);
        assert.strictEqual(result.valid, 1, `Expected 1 valid call, got ${result.valid} valid, ${result.uncertain} uncertain`);
        assert.strictEqual(result.uncertain, 0, 'dot-access args should not be uncertain');

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('findCallers detects callers from HTML event handlers', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-html-callers-'));
        fs.writeFileSync(path.join(tmpDir, 'page.html'), `<html><body>
<button onclick="doStuff()">Go</button>
<script>
function doStuff() { return 42; }
</script>
</body></html>`);
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');

        const { ProjectIndex } = require('../core/project');
        const index = new ProjectIndex(tmpDir);
        index.build();

        const callers = index.findCallers('doStuff');
        assert.strictEqual(callers.length, 1);
        assert.strictEqual(callers[0].line, 2);
        assert.ok(callers[0].content.includes('onclick="doStuff()"'));

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});

describe('Feature: search with exclude and in filters', () => {
    it('search --exclude filters out matching files', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-search-excl-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), 'const x = "hello world";\n');
            fs.mkdirSync(path.join(tmpDir, 'test'));
            fs.writeFileSync(path.join(tmpDir, 'test', 'app.test.js'), 'const y = "hello world";\n');
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Without exclude: both files
            const all = index.search('hello');
            assert.strictEqual(all.length, 2, 'Should find in both files');

            // With exclude=test: only app.js
            const filtered = index.search('hello', { exclude: ['test'] });
            assert.strictEqual(filtered.length, 1, 'Should find in 1 file after exclude');
            assert.ok(filtered[0].file.includes('app.js'), 'Should be app.js');
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });

    it('search --in filters to matching directory', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-search-in-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'src'));
            fs.mkdirSync(path.join(tmpDir, 'lib'));
            fs.writeFileSync(path.join(tmpDir, 'src', 'a.js'), 'const x = "target";\n');
            fs.writeFileSync(path.join(tmpDir, 'lib', 'b.js'), 'const y = "target";\n');
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const filtered = index.search('target', { in: 'src' });
            assert.strictEqual(filtered.length, 1, 'Should find in 1 file with --in');
            assert.ok(filtered[0].file.includes('src'), 'Should be in src/');
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });
});

describe('Feature: bulk fn extraction (comma-separated)', () => {
    it('extracts multiple functions from project index', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        // extractFunction is file-level; bulk is CLI/MCP level
        // Test that find works for each name in a comma-split
        const names = 'escapeRegExp,toolResult';
        const fnNames = names.split(',').map(n => n.trim());
        for (const fnName of fnNames) {
            const matches = index.find(fnName).filter(m => m.type === 'function' || m.params !== undefined);
            assert.ok(matches.length > 0, `Should find function "${fnName}"`);
        }
    });
});


describe('Feature: find with glob patterns', () => {
    it('finds functions matching glob pattern with *', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

        const results = index.find('format*Json');
        assert.ok(results.length > 5, `Should find multiple format*Json functions, got ${results.length}`);
        for (const r of results) {
            assert.ok(r.name.startsWith('format') && r.name.endsWith('Json'),
                `${r.name} should match format*Json`);
        }
    });

    it('finds functions matching glob pattern with ?', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-glob-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'a.js'), `
function getData() { return 1; }
function getDate() { return 2; }
function getNode() { return 3; }
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const results = index.find('getDat?');
            assert.strictEqual(results.length, 2, 'Should find getData and getDate');
            const names = results.map(r => r.name).sort();
            assert.deepStrictEqual(names, ['getData', 'getDate']);
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });

    it('glob pattern does not activate with --exact', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-glob-exact-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'a.js'), `
function getData() { return 1; }
function getDate() { return 2; }
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const results = index.find('getDat*', { exact: true });
            assert.strictEqual(results.length, 0, 'Glob should not activate with --exact');
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });
});

// ============================================================================
// Feature: search --regex flag
// ============================================================================


describe('Feature: search --regex flag', () => {
    function makeRegexTestIndex() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-search-regex-'));
        fs.writeFileSync(path.join(dir, 'app.js'), `
function processData(x) {
    const count = 42;
    const total = 100;
    const ratio = 3.14;
    return x + count;
}
function handleRequest(req) {
    const id = req.params.id;
    return id;
}
function handleResponse(res) {
    return res.status(200);
}
`);
        fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"test"}');
        const idx = new ProjectIndex(dir);
        idx.build('**/*.js', { quiet: true });
        return { dir, idx };
    }

    it('regex mode matches digit patterns', () => {
        const { dir, idx } = makeRegexTestIndex();
        try {
            const results = idx.search('\\d+', { regex: true });
            const matches = results.reduce((sum, r) => sum + r.matches.length, 0);
            assert.ok(matches >= 3, `Should find lines with numbers (found ${matches})`);
        } finally {
            fs.rmSync(dir, { recursive: true });
        }
    });

    it('regex mode matches alternation patterns', () => {
        const { dir, idx } = makeRegexTestIndex();
        try {
            const results = idx.search('handleRequest|handleResponse', { regex: true });
            const matches = results.reduce((sum, r) => sum + r.matches.length, 0);
            assert.ok(matches >= 2, `Should find both handle functions (found ${matches})`);
        } finally {
            fs.rmSync(dir, { recursive: true });
        }
    });

    it('regex mode matches word boundary patterns', () => {
        const { dir, idx } = makeRegexTestIndex();
        try {
            const results = idx.search('\\bcount\\b', { regex: true });
            const matches = results.reduce((sum, r) => sum + r.matches.length, 0);
            assert.ok(matches >= 1, `Should find "count" as whole word (found ${matches})`);
        } finally {
            fs.rmSync(dir, { recursive: true });
        }
    });

    it('regex mode matches character class patterns', () => {
        const { dir, idx } = makeRegexTestIndex();
        try {
            const results = idx.search('handle[A-Z]\\w+', { regex: true });
            const matches = results.reduce((sum, r) => sum + r.matches.length, 0);
            assert.ok(matches >= 2, `Should find handle* functions (found ${matches})`);
        } finally {
            fs.rmSync(dir, { recursive: true });
        }
    });

    it('plain text mode (regex=false) escapes regex special chars', () => {
        const { dir, idx } = makeRegexTestIndex();
        try {
            const results = idx.search('x + count', { regex: false });
            const matches = results.reduce((sum, r) => sum + r.matches.length, 0);
            assert.ok(matches >= 1, 'Should find literal "x + count"');
        } finally {
            fs.rmSync(dir, { recursive: true });
        }
    });

    it('invalid regex auto-falls back to plain text', () => {
        const { dir, idx } = makeRegexTestIndex();
        try {
            // process( is invalid regex — should not throw, falls back to plain text
            const results = idx.search('process(');
            assert.ok(Array.isArray(results), 'Should return results array, not throw');
        } finally {
            fs.rmSync(dir, { recursive: true });
        }
    });

    it('regex is default — no flag needed for patterns', () => {
        const { dir, idx } = makeRegexTestIndex();
        try {
            // Should work as regex without explicit regex:true
            const results = idx.search('handle\\w+');
            const matches = results.reduce((sum, r) => sum + r.matches.length, 0);
            assert.ok(matches >= 2, `Should find handle* functions by default (found ${matches})`);
        } finally {
            fs.rmSync(dir, { recursive: true });
        }
    });

    it('invalid regex falls back to plain text (does not throw)', () => {
        const { dir, idx } = makeRegexTestIndex();
        try {
            assert.doesNotThrow(() => idx.search('[invalid'));
            const results = idx.search('[invalid');
            assert.ok(Array.isArray(results), 'Should return array (fallback to plain text)');
        } finally {
            fs.rmSync(dir, { recursive: true });
        }
    });

    it('invalid regex fallback sets regexFallback in meta', () => {
        const { dir, idx } = makeRegexTestIndex();
        try {
            const results = idx.search('[invalid');
            assert.ok(results.meta, 'Results should have meta');
            assert.ok(results.meta.regexFallback, 'meta.regexFallback should be set');
            assert.ok(results.meta.regexFallback.includes('Invalid regular expression'),
                `regexFallback should contain error message: "${results.meta.regexFallback}"`);
        } finally {
            fs.rmSync(dir, { recursive: true });
        }
    });

    it('valid regex does not set regexFallback in meta', () => {
        const { dir, idx } = makeRegexTestIndex();
        try {
            const results = idx.search('\\d+');
            assert.ok(results.meta, 'Results should have meta');
            assert.strictEqual(results.meta.regexFallback, false, 'regexFallback should be false for valid regex');
        } finally {
            fs.rmSync(dir, { recursive: true });
        }
    });

    it('formatSearch shows fallback warning for invalid regex', () => {
        const output = require('../core/output');
        const results = [];
        results.meta = { filesScanned: 5, filesSkipped: 0, totalFiles: 5, regexFallback: 'Invalid regular expression: Unterminated character class' };
        const formatted = output.formatSearch(results, '[invalid');
        assert.ok(formatted.includes('Invalid regex'), `Should mention invalid regex: "${formatted}"`);
        assert.ok(formatted.includes('plain text'), `Should mention plain text fallback: "${formatted}"`);
    });

    it('regex mode works with case-sensitive flag', () => {
        const { dir, idx } = makeRegexTestIndex();
        try {
            const insensitive = idx.search('PROCESSDATA', { regex: true });
            const sensitive = idx.search('PROCESSDATA', { regex: true, caseSensitive: true });
            const insensitiveCount = insensitive.reduce((sum, r) => sum + r.matches.length, 0);
            const sensitiveCount = sensitive.reduce((sum, r) => sum + r.matches.length, 0);
            assert.ok(insensitiveCount > sensitiveCount,
                `Case-insensitive regex (${insensitiveCount}) should find more than case-sensitive (${sensitiveCount})`);
        } finally {
            fs.rmSync(dir, { recursive: true });
        }
    });

    it('regex mode works with codeOnly flag', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-regex-code-'));
        try {
            fs.writeFileSync(path.join(dir, 'test.js'), `
// Comment with number 42
const x = 42;
/* block with 100 */
const y = 100;
`);
            fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"test"}');
            const idx = new ProjectIndex(dir);
            idx.build('**/*.js', { quiet: true });

            const all = idx.search('\\d+', { regex: true });
            const codeOnly = idx.search('\\d+', { regex: true, codeOnly: true });
            const allCount = all.reduce((sum, r) => sum + r.matches.length, 0);
            const codeCount = codeOnly.reduce((sum, r) => sum + r.matches.length, 0);
            assert.ok(allCount > codeCount,
                `All matches (${allCount}) should be more than code-only (${codeCount})`);
        } finally {
            fs.rmSync(dir, { recursive: true });
        }
    });
});

// ============================================================================
// Feature: per-function line count stats
// ============================================================================


describe('Feature: stats --functions', () => {
    it('getStats returns functions sorted by line count', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-stats-fn-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function shortFn() {
    return 1;
}
function longFn(a, b, c) {
    const x = a + b;
    const y = b + c;
    const z = x + y;
    if (z > 10) {
        console.log('big');
    } else {
        console.log('small');
    }
    return z;
}
function mediumFn(x) {
    const result = x * 2;
    return result;
}
`);
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Without --functions: no functions array
            const statsBasic = index.getStats();
            assert.strictEqual(statsBasic.functions, undefined, 'Should not include functions by default');

            // With --functions: sorted by line count
            const stats = index.getStats({ functions: true });
            assert.ok(stats.functions, 'Should include functions array');
            assert.ok(stats.functions.length >= 3, `Should have at least 3 functions (found ${stats.functions.length})`);

            // Verify sorted descending by line count
            for (let i = 1; i < stats.functions.length; i++) {
                assert.ok(stats.functions[i - 1].lines >= stats.functions[i].lines,
                    `Functions should be sorted by line count desc: ${stats.functions[i - 1].name}(${stats.functions[i - 1].lines}) >= ${stats.functions[i].name}(${stats.functions[i].lines})`);
            }

            // longFn should be first (most lines)
            assert.strictEqual(stats.functions[0].name, 'longFn', 'Longest function should be first');
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
        }
    });

    it('formatStats shows function listing when present', () => {
        const output = require('../core/output');
        const stats = {
            root: '/test',
            files: 2,
            symbols: 5,
            buildTime: 100,
            byLanguage: { javascript: { files: 2, lines: 50, symbols: 5 } },
            byType: { function: 3 },
            functions: [
                { name: 'longFn', file: 'app.js', startLine: 5, lines: 20 },
                { name: 'mediumFn', file: 'app.js', startLine: 25, lines: 10 },
                { name: 'shortFn', file: 'app.js', startLine: 35, lines: 3 }
            ]
        };
        const formatted = output.formatStats(stats);
        assert.ok(formatted.includes('Functions by line count'), 'Should have functions header');
        assert.ok(formatted.includes('longFn'), 'Should list longFn');
        assert.ok(formatted.includes('20 lines'), 'Should show line count');
    });
});

// ============================================================================
// MCP `all` and `top_level` parameter parity (bug hunt 2026-02-26)
// ============================================================================


describe('MCP parameter parity: all and top_level', () => {
    const serverCode = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'server.js'), 'utf-8');

    it('MCP schema includes all and top_level parameters', () => {
        assert.ok(serverCode.includes("all: z.boolean().optional()"), 'Schema should have all parameter');
        assert.ok(serverCode.includes("top_level: z.boolean().optional()"), 'Schema should have top_level parameter');
    });

    it('MCP destructures all and top_level from args', () => {
        assert.ok(serverCode.includes('functions, all, top_level }'), 'Should destructure all and top_level');
    });

    it('MCP about handler passes all and includeUncertain via executor', () => {
        // about should pass all and include_uncertain to executor via normalizeParams
        assert.ok(serverCode.includes('with_types, all, include_methods, include_uncertain, top'),
            'about handler should pass all and include_uncertain to executor');
    });

    it('MCP related handler uses explicit all parameter', () => {
        // related should NOT auto-infer all from top
        assert.ok(!serverCode.includes('all: top !== undefined'),
            'related handler should NOT auto-infer all from top');
        // Should pass explicit all to executor
        assert.ok(serverCode.includes("execute(index, 'related', { name, file, top, all })"),
            'related handler should pass explicit all parameter to executor');
    });

    it('MCP toc handler passes all and topLevel via executor', () => {
        assert.ok(serverCode.includes('detailed, top_level, all, top'),
            'toc handler should pass topLevel and all to executor');
    });

    it('MCP graph handler respects all in showAll', () => {
        assert.ok(serverCode.includes('showAll: all || depth !== undefined'),
            'graph handler should include all in showAll');
    });

    // Behavioral tests: verify all parameter works correctly in core

    it('about() with all=true returns unlimited callers', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-about-all-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
        // Create a function called by many callers
        let code = 'function target() { return 1; }\n';
        for (let i = 0; i < 15; i++) {
            code += `function caller${i}() { return target(); }\n`;
        }
        fs.writeFileSync(path.join(tmpDir, 'app.js'), code);

        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        // Without all — callers.top limited to 10
        const limited = index.about('target', { all: false });
        assert.ok(limited.callers.top.length <= 10, 'Without all, callers.top should be limited to 10');
        assert.strictEqual(limited.callers.total, 15, 'Total should still report 15');

        // With all — should show everything
        const unlimited = index.about('target', { all: true });
        assert.strictEqual(unlimited.callers.top.length, 15, 'With all=true, all 15 callers should be shown');

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('getToc() with topLevel=true filters nested functions', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-toc-toplevel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
        fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function outer() {
    function inner() {
        return 1;
    }
    return inner();
}
function another() { return 2; }
`);

        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const tocAll = index.getToc({ detailed: true, topLevel: false });
        const tocTopLevel = index.getToc({ detailed: true, topLevel: true });

        // topLevel should have fewer functions (excludes inner)
        const allFns = tocAll.files[0]?.symbols?.functions || [];
        const topFns = tocTopLevel.files[0]?.symbols?.functions || [];
        assert.ok(allFns.length > topFns.length,
            `topLevel should filter nested functions (all: ${allFns.length}, topLevel: ${topFns.length})`);

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('related() with all=true expands all results', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-related-all-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
        // Many functions in the same file to generate related results
        let code = '';
        for (let i = 0; i < 20; i++) {
            code += `function handler${i}() { return ${i}; }\n`;
        }
        fs.writeFileSync(path.join(tmpDir, 'handlers.js'), code);

        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const limited = index.related('handler0', { all: false });
        const expanded = index.related('handler0', { all: true });

        // With all, should return more (or equal) results
        assert.ok(expanded, 'related with all=true should return results');
        assert.ok(limited, 'related with all=false should return results');
        const limitedTotal = (limited.sameFile?.length || 0) + (limited.similarName?.length || 0) + (limited.sharedDeps?.length || 0);
        const expandedTotal = (expanded.sameFile?.length || 0) + (expanded.similarName?.length || 0) + (expanded.sharedDeps?.length || 0);
        assert.ok(expandedTotal >= limitedTotal,
            `all=true should return >= results (expanded: ${expandedTotal}, limited: ${limitedTotal})`);

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});

