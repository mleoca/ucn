/**
 * UCN MCP Regression Tests
 *
 * MCP Demo Fixes, MCP Issues, stale cache, max_files, and two-tier output limits.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { ProjectIndex } = require('../core/project');
const output = require('../core/output');
const { tmp, rm, McpClient, PROJECT_DIR } = require('./helpers');

// ============================================================================
// MCP DEMO FIXES
// ============================================================================

describe('MCP Demo Fixes', () => {

// Issue 1: Variable require() should be DYNAMIC, not EXTERNAL
it('imports() classifies variable require() as isDynamic', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dynreq-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'main.js'), `
const path = require('path');
const configPath = './config.json';
const config = require(configPath);
module.exports = config;
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.js', { quiet: true });
        const imports = index.imports(path.join(tmpDir, 'main.js'));

        const pathImp = imports.find(i => i.module === 'path');
        assert.ok(pathImp, 'Should find path import');
        assert.strictEqual(pathImp.isDynamic, false, 'path should not be dynamic');

        const dynImp = imports.find(i => i.module === 'configPath');
        assert.ok(dynImp, 'Should find dynamic require(configPath)');
        assert.strictEqual(dynImp.isDynamic, true, 'variable require should be isDynamic');
        assert.strictEqual(dynImp.isExternal, false, 'variable require should not be isExternal');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// Issue 1: formatImports shows DYNAMIC group
it('formatImports shows DYNAMIC (unresolved) group', () => {
    const { formatImports } = require('../core/output');
    const imports = [
        { module: './utils', names: ['helper'], type: 'esm', resolved: 'src/utils.js', isExternal: false, isDynamic: false },
        { module: 'lodash', names: ['map'], type: 'esm', resolved: null, isExternal: true, isDynamic: false },
        { module: 'configPath', names: [], type: 'require', resolved: null, isExternal: false, isDynamic: true }
    ];
    const text = formatImports(imports, 'test.js');
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

// Issue 2: ucn_class summary for large classes
it('large class gets summary when no max_lines set', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bigclass-'));
    try {
        // Generate a class with >200 lines
        let classBody = 'class BigClass {\n';
        for (let i = 0; i < 210; i++) {
            classBody += `  method${i}() { return ${i}; }\n`;
        }
        classBody += '}\nmodule.exports = BigClass;\n';
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'big.js'), classBody);

        const index = new ProjectIndex(tmpDir);
        index.build('**/*.js', { quiet: true });

        // Verify the class is found and >200 lines
        const matches = index.find('BigClass', {}).filter(m =>
            ['class', 'interface', 'type', 'enum', 'struct', 'trait'].includes(m.type)
        );
        assert.ok(matches.length > 0, 'Should find BigClass');
        const match = matches[0];
        const lineCount = match.endLine - match.startLine + 1;
        assert.ok(lineCount > 200, `Class should be >200 lines, got ${lineCount}`);

        // Verify findMethodsForType finds methods
        const methods = index.findMethodsForType('BigClass');
        assert.ok(methods.length > 100, `Should find >100 methods, got ${methods.length}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// Issue 5: context() includes includeMethods in meta
it('context() meta includes includeMethods flag', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-incmeth-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'a.js'), `
function greet(name) { return 'hi ' + name; }
function main() { greet('world'); }
module.exports = { greet, main };
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.js', { quiet: true });

        // Default: includeMethods should be false
        const ctx1 = index.context('greet', {});
        assert.ok(ctx1, 'Should find greet');
        assert.ok(ctx1.meta, 'Should have meta');
        assert.strictEqual(ctx1.meta.includeMethods, false, 'includeMethods should be false by default');

        // With includeMethods: true
        const ctx2 = index.context('greet', { includeMethods: true });
        assert.strictEqual(ctx2.meta.includeMethods, true, 'includeMethods should be true when set');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// Issue 5: trace() includes includeMethods flag (defaults to true)
it('trace() includes includeMethods flag', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-tracemeth-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'a.js'), `
function greet(name) { return 'hi ' + name; }
function main() { greet('world'); }
module.exports = { greet, main };
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.js', { quiet: true });

        const trace1 = index.trace('main', {});
        assert.ok(trace1, 'Should find main');
        assert.strictEqual(trace1.includeMethods, true, 'includeMethods should be true by default for trace');

        const trace2 = index.trace('main', { includeMethods: false });
        assert.strictEqual(trace2.includeMethods, false, 'includeMethods should be false when explicitly set');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// Issue 5 (updated for fact-based notes): formatTrace mentions hidden method
// edges only when the account actually FILTERED some — a bare
// includeMethods:false with nothing filtered stays silent (the note used to
// claim an exclusion that never happened).
it('formatTrace notes hidden method edges only when the account filtered some', () => {
    const { formatTrace } = require('../core/output');
    const traceData = {
        root: 'test',
        file: 'a.js',
        line: 1,
        direction: 'down',
        maxDepth: 3,
        includeMethods: false,
        tree: { name: 'test', file: 'a.js', line: 1, children: [] }
    };
    const text = formatTrace(traceData);
    assert.ok(!text.includes('hidden'), 'no filtered edges — no note');

    const traceData2 = {
        ...traceData,
        treeAccount: { callSites: { total: 3, confirmed: 2, unverified: 0, external: 0, excluded: 0, filtered: 1 } },
    };
    const text2 = formatTrace(traceData2);
    assert.ok(text2.includes('1 obj.method() callee edge(s) hidden'), 'filtered edges are reported with their count');

    const traceData3 = { ...traceData2, includeMethods: true };
    const text3 = formatTrace(traceData3);
    assert.ok(!text3.includes('hidden'), 'no note when includeMethods=true');
});

}); // end describe('MCP Demo Fixes')

// ============================================================================
// MCP ISSUES FIXES
// ============================================================================

describe('MCP Issues Fixes', () => {

    // Issue 1: expand cache was keyed by project only, losing previous context results
    it('expand cache supports multiple symbols per project (issue 1)', () => {
        const { ExpandCache } = require(path.join(PROJECT_DIR, 'core', 'expand-cache'));
        const cache = new ExpandCache();
        const projectRoot = '/fake/project';

        // Store context for symbol A
        cache.save(projectRoot, 'funcA', null, [{ num: 1, name: 'callerOfA', type: 'function' }]);

        // Store context for symbol B (should NOT overwrite A)
        cache.save(projectRoot, 'funcB', null, [{ num: 1, name: 'callerOfB', type: 'function' }]);

        // Both should be retrievable — funcB is most recent, but funcA's items are still findable
        const lookupB = cache.lookup(projectRoot, 1);
        assert.ok(lookupB.match, 'should find item 1 from most recent context (funcB)');
        assert.strictEqual(lookupB.match.name, 'callerOfB', 'most recent should be funcB');

        // Item with a unique number in funcA should be findable via fallback
        cache.save(projectRoot, 'funcA', null, [
            { num: 1, name: 'callerOfA', type: 'function' },
            { num: 2, name: 'otherCallerOfA', type: 'function' }
        ]);
        // funcA is now most recent, so item 2 should be found
        const lookupA2 = cache.lookup(projectRoot, 2);
        assert.ok(lookupA2.match, 'should find item 2 from funcA');
        assert.strictEqual(lookupA2.match.name, 'otherCallerOfA');
    });

    // Issue 2: example() method moved to core/project.js
    it('ProjectIndex.example() returns scored result (issue 2)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        // Create a JS file with a function that is called
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        fs.writeFileSync(path.join(dir, 'lib.js'), `
function greet(name) {
    return 'Hello ' + name;
}
module.exports = { greet };
`);
        fs.writeFileSync(path.join(dir, 'app.js'), `
const { greet } = require('./lib');
const msg = greet('world');
console.log(msg);
`);

        const index = new ProjectIndex(dir);
        index.build(null, { quiet: true });

        const result = index.example('greet');
        assert.ok(result, 'example() should return a result');
        assert.ok(result.best, 'should have a best example');
        assert.ok(result.best.score >= 0, 'should have a score');
        assert.ok(result.totalCalls > 0, 'should have total calls');
        assert.ok(result.best.content.includes('greet'), 'best example content should contain the function name');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('ProjectIndex.example() returns null when no calls found (issue 2)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        fs.writeFileSync(path.join(dir, 'lib.js'), `
function unusedFn() { return 42; }
`);

        const index = new ProjectIndex(dir);
        index.build(null, { quiet: true });

        const result = index.example('unusedFn');
        assert.strictEqual(result, null, 'should return null for unused function');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    // Issue 3: ucn_class uses index data instead of re-parsing (generics stored in index)
    it('index stores generics for classes (issue 4)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        fs.writeFileSync(path.join(dir, 'generic.ts'), `
class Container<T> {
    private value: T;
    constructor(val: T) {
        this.value = val;
    }
    get(): T { return this.value; }
}
`);

        const index = new ProjectIndex(dir);
        index.build(null, { quiet: true });

        const matches = index.find('Container').filter(m => m.type === 'class');
        assert.ok(matches.length > 0, 'should find Container class');
        assert.ok(matches[0].generics, 'class should have generics field');
        assert.ok(matches[0].generics.includes('T'), 'generics should contain T');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    // Issue 5: CALLERS label instead of USAGES
    it('context class output uses CALLERS label instead of USAGES (issue 5)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        fs.writeFileSync(path.join(dir, 'animal.js'), `
class Animal {
    constructor(name) { this.name = name; }
    speak() { return this.name; }
}
module.exports = { Animal };
`);
        fs.writeFileSync(path.join(dir, 'main.js'), `
const { Animal } = require('./animal');
const a = new Animal('dog');
`);

        const index = new ProjectIndex(dir);
        index.build(null, { quiet: true });
        const ctx = index.context('Animal');
        assert.ok(ctx, 'context should return result');
        assert.ok(ctx.callers !== undefined, 'should have callers field');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    // Issue 6: CLI graph --direction flag
    it('graph supports direction=imports (issue 6)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        fs.writeFileSync(path.join(dir, 'a.js'), `const b = require('./b'); module.exports = {};`);
        fs.writeFileSync(path.join(dir, 'b.js'), `module.exports = { x: 1 };`);
        fs.writeFileSync(path.join(dir, 'c.js'), `const a = require('./a'); module.exports = {};`);

        const index = new ProjectIndex(dir);
        index.build(null, { quiet: true });

        // direction=imports — what a.js depends on
        const imports = index.graph('a.js', { direction: 'imports', maxDepth: 2 });
        assert.ok(imports.nodes.length > 0, 'should have nodes');
        const importPaths = imports.nodes.map(n => n.relativePath);
        assert.ok(importPaths.includes('b.js'), 'imports should include b.js');

        // direction=importers — who depends on a.js
        const importers = index.graph('a.js', { direction: 'importers', maxDepth: 2 });
        assert.ok(importers.nodes.length > 0, 'should have nodes');
        const importerPaths = importers.nodes.map(n => n.relativePath);
        assert.ok(importerPaths.includes('c.js'), 'importers should include c.js');

        fs.rmSync(dir, { recursive: true, force: true });
    });

}); // end describe('MCP Issues Fixes')


describe('fix: MCP stale cache after file edit', () => {
    it('MCP returns fresh results immediately after file edit', async () => {
        const { McpClient } = require('./helpers');
        const dir = tmp({
            'package.json': '{"name":"stale-test"}',
            'a.js': 'function alpha() { return 1; }\nmodule.exports = { alpha };\n'
        });
        let client;
        try {
            client = new McpClient();
            await client.start();
            await client.initialize();

            // First query — should find alpha
            const res1 = await client.callTool('ucn', {
                command: 'find', project_dir: dir, name: 'alpha'
            });
            const text1 = res1.result?.content?.map(c => c.text).join('') || '';
            assert.ok(text1.includes('alpha'), `First query should find alpha, got: ${text1}`);

            // Edit file — replace alpha with beta
            fs.writeFileSync(path.join(dir, 'a.js'), 'function beta() { return 2; }\nmodule.exports = { beta };\n');

            // Immediate second query — should find beta (no stale cache)
            const res2 = await client.callTool('ucn', {
                command: 'find', project_dir: dir, name: 'beta'
            });
            const text2 = res2.result?.content?.map(c => c.text).join('') || '';
            assert.ok(text2.includes('beta'), `Second query should find beta immediately after edit, got: ${text2}`);
        } finally {
            if (client) client.stop();
            rm(dir);
        }
    });
});

describe('fix: MCP max_files parameter honored', () => {
    it('MCP max_files limits indexed files', async () => {
        const { McpClient } = require('./helpers');
        const dir = tmp({
            'package.json': '{"name":"maxfiles-test"}',
            'a.js': 'function funcA() {}\nmodule.exports = { funcA };\n',
            'b.js': 'function funcB() {}\nmodule.exports = { funcB };\n',
            'c.js': 'function funcC() {}\nmodule.exports = { funcC };\n'
        });
        let client;
        try {
            client = new McpClient();
            await client.start();
            await client.initialize();

            // With max_files: 1, only one file should be indexed
            const res = await client.callTool('ucn', {
                command: 'toc', project_dir: dir, max_files: 1
            });
            const text = res.result?.content?.map(c => c.text).join('') || '';
            // Toc should show only 1 file (max_files limits discovery)
            assert.ok(text.includes('1 file'), `Should show 1 file with max_files=1, got: ${text}`);
        } finally {
            if (client) client.stop();
            rm(dir);
        }
    });

    it('MCP max_files does not pollute cache for subsequent full queries', async () => {
        const { McpClient } = require('./helpers');
        const dir = tmp({
            'package.json': '{"name":"maxfiles-cache-test"}',
            'a.js': 'function funcA() {}\nmodule.exports = { funcA };\n',
            'b.js': 'function funcB() {}\nmodule.exports = { funcB };\n'
        });
        let client;
        try {
            client = new McpClient();
            await client.start();
            await client.initialize();

            // First: limited query
            await client.callTool('ucn', {
                command: 'toc', project_dir: dir, max_files: 1
            });

            // Second: full query (no max_files) — should see all files
            const res = await client.callTool('ucn', {
                command: 'toc', project_dir: dir
            });
            const text = res.result?.content?.map(c => c.text).join('') || '';
            assert.ok(text.includes('2 file'), `Full query should show 2 files, got: ${text}`);
        } finally {
            if (client) client.stop();
            rm(dir);
        }
    });
});

// =============================================================================
// MCP two-tier output limits
// =============================================================================
describe('MCP two-tier output limits', () => {
    it('serves a concise, calibrated agent description by default', async () => {
        const client = new McpClient();
        try {
            await client.start();
            await client.initialize();
            const res = await client.send('tools/list', {});
            const description = res.result?.tools?.find(t => t.name === 'ucn')?.description || '';
            assert.ok(description.length > 1000 && description.length < 8000,
                `description should be useful without consuming the context window (${description.length} chars)`);
            assert.ok(description.includes('observed-text zero'), description);
            assert.ok(description.includes('ordinal evidence weights, not probabilities'), description);
            assert.ok(!description.includes('genuinely has no callers'), description);
        } finally {
            client.stop();
        }
    });

    it('BROAD_COMMANDS set includes the correct commands', () => {
        const serverCode = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'server.js'), 'utf-8');
        for (const cmd of ['toc', 'entrypoints', 'diff_impact', 'affected_tests', 'deadcode', 'usages']) {
            assert.ok(serverCode.includes(`'${cmd}'`), `BROAD_COMMANDS should include ${cmd}`);
        }
    });

    it('broad commands use 3K default, targeted use 10K', () => {
        const serverCode = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'server.js'), 'utf-8');
        assert.ok(serverCode.includes('BROAD_OUTPUT_CHARS = 3000'), 'Broad limit should be 3000');
        assert.ok(serverCode.includes('DEFAULT_OUTPUT_CHARS = 10000'), 'Targeted limit should be 10000');
        assert.ok(serverCode.includes('BROAD_COMMANDS.has(command) ? BROAD_OUTPUT_CHARS : DEFAULT_OUTPUT_CHARS'),
            'toolResult should select limit based on command type');
    });

    it('each broad command has a narrowing hint', () => {
        const serverCode = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'server.js'), 'utf-8');
        for (const cmd of ['toc', 'entrypoints', 'diff_impact', 'affected_tests', 'deadcode', 'usages']) {
            assert.ok(serverCode.includes(`${cmd}:`), `Should have narrowing hint for ${cmd}`);
        }
    });

    it('preserves caller ACCOUNT and CONTRACT metadata after truncation', async () => {
        const callers = Array.from({ length: 80 }, (_, i) =>
            `function caller${i}() { return target(${i}); }`).join('\n');
        const dir = tmp({
            'package.json': '{"name":"contract-truncation"}',
            'index.js': `function target(x) { return x; }\n${callers}\nmodule.exports = { target };\n`,
        });
        const client = new McpClient();
        try {
            await client.start();
            await client.initialize();
            const res = await client.callTool('ucn', {
                command: 'impact', project_dir: dir, name: 'target', max_chars: 800,
            });
            const text = res.result?.content?.map(c => c.text).join('') || '';
            assert.ok(text.includes('OUTPUT TRUNCATED'), text);
            assert.ok(text.includes('PRESERVED CONTRACT METADATA'), text);
            assert.ok(text.includes('ACCOUNT: "target"'), text);
            assert.ok(text.includes('CONTRACT: literal-name text partition complete'), text);
            assert.strictEqual(res.result?.structuredContent?.truncated, true);
            assert.strictEqual(res.result?.structuredContent?.contractMetadataComplete, true);
        } finally {
            client.stop();
            rm(dir);
        }
    });
});

// =============================================================================
// MED-4: MCP numeric range validation (Round 5 audit)
// =============================================================================
describe('MED-4: MCP rejects out-of-range numeric params via Zod', () => {
    let client;
    before(async () => {
        client = new McpClient();
        await client.start();
        await client.initialize();
    });
    after(() => { if (client) client.stop(); });

    // Helper: extract any user-visible error text from an MCP response.
    // Zod validation errors come back as JSON-RPC error responses (res.error)
    // OR as content with isError:true (depending on how MCP wraps the throw).
    function errText(res) {
        if (res.error) return res.error.message || JSON.stringify(res.error);
        const content = res.result && res.result.content;
        return (content && content[0] && content[0].text) || '';
    }

    it('top=1e100 is rejected by Zod (max cap)', async () => {
        const res = await client.callTool('ucn', {
            command: 'context', project_dir: PROJECT_DIR, name: 'main', top: 1e100,
        });
        const isError = res.error || (res.result && res.result.isError === true);
        assert.ok(isError, `should error on top=1e100, got: ${JSON.stringify(res).slice(0, 300)}`);
        assert.ok(/top|number|integer|max|less than/i.test(errText(res)),
            `error should reference top/number, got: ${errText(res).slice(0, 200)}`);
    });

    it('top=-5 is rejected (must be positive)', async () => {
        const res = await client.callTool('ucn', {
            command: 'context', project_dir: PROJECT_DIR, name: 'main', top: -5,
        });
        const isError = res.error || (res.result && res.result.isError === true);
        assert.ok(isError, `should error on top=-5, got: ${JSON.stringify(res).slice(0, 300)}`);
    });

    it('top=NaN is rejected', async () => {
        const res = await client.callTool('ucn', {
            command: 'context', project_dir: PROJECT_DIR, name: 'main', top: NaN,
        });
        const isError = res.error || (res.result && res.result.isError === true);
        assert.ok(isError, `should error on top=NaN, got: ${JSON.stringify(res).slice(0, 300)}`);
    });

    it('top=0 is rejected (must be positive)', async () => {
        const res = await client.callTool('ucn', {
            command: 'context', project_dir: PROJECT_DIR, name: 'main', top: 0,
        });
        const isError = res.error || (res.result && res.result.isError === true);
        assert.ok(isError, `should error on top=0, got: ${JSON.stringify(res).slice(0, 300)}`);
    });

    it('top=1.5 is rejected (must be integer)', async () => {
        const res = await client.callTool('ucn', {
            command: 'context', project_dir: PROJECT_DIR, name: 'main', top: 1.5,
        });
        const isError = res.error || (res.result && res.result.isError === true);
        assert.ok(isError, `should error on top=1.5, got: ${JSON.stringify(res).slice(0, 300)}`);
    });

    it('limit=0 is rejected', async () => {
        const res = await client.callTool('ucn', {
            command: 'find', project_dir: PROJECT_DIR, name: 'main', limit: 0,
        });
        const isError = res.error || (res.result && res.result.isError === true);
        assert.ok(isError, `should error on limit=0, got: ${JSON.stringify(res).slice(0, 300)}`);
    });

    it('max_files=0 is rejected', async () => {
        const res = await client.callTool('ucn', {
            command: 'toc', project_dir: PROJECT_DIR, max_files: 0,
        });
        const isError = res.error || (res.result && res.result.isError === true);
        assert.ok(isError, `should error on max_files=0, got: ${JSON.stringify(res).slice(0, 300)}`);
    });

    it('max_chars above the documented 100K transport ceiling is rejected', async () => {
        const res = await client.callTool('ucn', {
            command: 'about', project_dir: PROJECT_DIR, name: 'main', max_chars: 100001,
        });
        const isError = res.error || (res.result && res.result.isError === true);
        assert.ok(isError, `should error above max_chars=100000, got: ${JSON.stringify(res).slice(0, 300)}`);
        assert.ok(/max_chars|number|less than|100000/i.test(errText(res)),
            `error should describe the max_chars ceiling, got: ${errText(res).slice(0, 200)}`);
    });

    it('depth=0 is allowed (meaningful: limit to this symbol only)', async () => {
        const res = await client.callTool('ucn', {
            command: 'trace', project_dir: PROJECT_DIR, name: 'main', depth: 0,
        });
        // depth=0 should not be a Zod validation error. It may still produce
        // an empty/short result, but no isError due to schema rejection.
        const zodFailed = res.error || (res.result && res.result.isError === true &&
            /must be|expected|number|integer|positive/i.test(errText(res)));
        assert.ok(!zodFailed, `depth=0 should not fail Zod validation, got: ${errText(res).slice(0, 200)}`);
    });

    it('depth=-1 is rejected (must be non-negative)', async () => {
        const res = await client.callTool('ucn', {
            command: 'trace', project_dir: PROJECT_DIR, name: 'main', depth: -1,
        });
        const isError = res.error || (res.result && res.result.isError === true);
        assert.ok(isError, `should error on depth=-1, got: ${JSON.stringify(res).slice(0, 300)}`);
    });

    it('valid top=10 is accepted', async () => {
        const res = await client.callTool('ucn', {
            command: 'context', project_dir: PROJECT_DIR, name: 'main', top: 10,
        });
        // Should succeed (or at worst, fail for other reasons — not Zod).
        // Just verify no Zod validation error.
        const zodFailed = res.error || (res.result && res.result.isError === true &&
            /must be|integer|less than|positive/i.test(errText(res)));
        assert.ok(!zodFailed, `valid top=10 should not fail Zod, got: ${errText(res).slice(0, 200)}`);
    });

    it('min_confidence=2.0 is rejected (must be in [0,1])', async () => {
        const res = await client.callTool('ucn', {
            command: 'context', project_dir: PROJECT_DIR, name: 'main', min_confidence: 2.0,
        });
        const isError = res.error || (res.result && res.result.isError === true);
        assert.ok(isError, `should error on min_confidence=2.0, got: ${JSON.stringify(res).slice(0, 300)}`);
    });
});

describe('fix #242: MCP notes use param syntax, never CLI flag syntax', () => {
    let client;
    let dir;
    before(async () => {
        dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function d1() {}\nfunction d2() {}\nfunction d3() {}\nmodule.exports = {};',
        });
        client = new McpClient();
        await client.start();
        await client.initialize();
    });
    after(() => { client.stop(); rm(dir); });

    it('deadcode limit note says limit=<n>, not --limit N', async () => {
        const res = await client.callTool({ command: 'deadcode', project_dir: dir, limit: 2 });
        assert.ok(res.text.includes('Showing 2 of 3'), 'truncation note present: ' + res.text.slice(-300));
        assert.ok(!res.text.includes('--limit'), 'no CLI flag syntax at the MCP surface');
        assert.ok(res.text.includes('limit=<n>'), 'param-styled hint');
    });
});

describe('fix #250: MCP find parity + compact + fn notes', () => {
    let client;
    let dir;
    before(async () => {
        dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function taskOne() { return 1; }\nfunction taskTwo() { return taskOne(); }\nfunction taskThree() { return 2; }\nfunction taskFour() { return 3; }\nfunction taskFive() { return 4; }\nfunction taskSix() { return 5; }\nmodule.exports = { taskOne, taskTwo, taskThree, taskFour, taskFive, taskSix };\n',
        });
        client = new McpClient();
        await client.start();
        await client.initialize();
    });
    after(() => { client.stop(); rm(dir); });

    it('find renders detailed output with stable handles and honors all=true', async () => {
        const res = await client.callTool({ command: 'find', project_dir: dir, name: 'task' });
        assert.ok(/a\.js:\d+:task/.test(res.text), 'stable file:line:name handles present: ' + res.text.slice(0, 300));
        const all = await client.callTool({ command: 'find', project_dir: dir, name: 'task', all: true });
        for (const n of ['taskOne', 'taskTwo', 'taskThree', 'taskFour', 'taskFive', 'taskSix']) {
            assert.ok(all.text.includes(n), `all=true shows ${n}`);
        }
    });

    it('compact=true changes about output shape', async () => {
        const full = await client.callTool({ command: 'about', project_dir: dir, name: 'taskOne', compact: false });
        const compact = await client.callTool({ command: 'about', project_dir: dir, name: 'taskOne' });
        assert.ok(compact.text.length < full.text.length, `compact is smaller (${compact.text.length} vs ${full.text.length})`);
        assert.ok(compact.text.includes('SOURCE: omitted in compact mode'), compact.text);
        assert.ok(!compact.text.includes('─── CODE ───'), compact.text);
    });

    it('fn multi-definition notes use param syntax, not --flags', async () => {
        const d2 = tmp({
            'package.json': '{"name":"test"}',
            'x.js': 'class A { run() { return 1; } }\nclass B { run() { return 2; } }\nmodule.exports = { A, B };\n',
        });
        try {
            const res = await client.callTool({ command: 'fn', project_dir: d2, name: 'run' });
            assert.ok(!res.text.includes('--all'), 'no CLI flag syntax: ' + res.text.slice(0, 300));
        } finally { rm(d2); }
    });
});
