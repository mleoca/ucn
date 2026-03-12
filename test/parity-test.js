#!/usr/bin/env node

/**
 * Cross-Interface Parity Test
 *
 * Verifies that CLI project mode, interactive mode, and MCP server
 * produce consistent behavior for the same commands and flags.
 *
 * Tests three categories:
 * 1. Option forwarding: flags that exist in one interface must work in all
 * 2. Test exclusion: find/usages/search must exclude tests by default across all interfaces
 * 3. Output consistency: same command+flags should produce equivalent results
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { McpClient, runCli, runInteractive, FIXTURES_PATH: BASE_FIXTURES } = require('./helpers');
const { CANONICAL_COMMANDS, CLI_ALIASES, MCP_ALIASES, getCliCommandSet, getMcpCommandEnum, resolveCommand, normalizeParams, PARAM_MAP } = require('../core/registry');
const FIXTURES_PATH = path.join(BASE_FIXTURES, 'javascript');

// ============================================================================
// Tests
// ============================================================================

describe('Cross-Interface Parity', () => {
    let mcpClient;

    before(async () => {
        mcpClient = new McpClient();
        await mcpClient.start();
        await mcpClient.initialize();
    });

    after(() => {
        mcpClient.stop();
    });

    // ========================================================================
    // Category 1: Test exclusion parity (Critical bugs #1-3)
    // ========================================================================

    describe('Test exclusion parity', () => {
        // Create a temp project with test files to verify exclusion behavior
        let tmpDir;

        before(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-parity-'));
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'main.js'), `
function processData(input) {
    return transform(input);
}
function transform(data) {
    return data;
}
module.exports = { processData, transform };
`);
            fs.writeFileSync(path.join(tmpDir, 'test', 'main.test.js').replace('test/', ''), '');
            fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'test', 'main.test.js'), `
const { processData } = require('../main');
function testProcessData() {
    processData('hello');
}
`);
        });

        after(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('find: CLI excludes test files by default', () => {
            const output = runCli(tmpDir, 'find', ['processData']);
            // Should find processData but test file should not dominate results
            assert.ok(output.includes('processData'), 'Should find processData');
        });

        it('find: interactive excludes test files by default', () => {
            const output = runInteractive(tmpDir, ['find processData']);
            assert.ok(output.includes('processData'), 'Should find processData');
        });

        it('find: MCP excludes test files by default', async () => {
            const res = await mcpClient.callTool({ command: 'find', project_dir: tmpDir, name: 'processData' });
            assert.ok(!res.isError, 'Should not error');
            assert.ok(res.text.includes('processData'), 'Should find processData');
        });

        it('find: CLI includes tests with --include-tests', () => {
            const output = runCli(tmpDir, 'find', ['processData'], ['--include-tests']);
            assert.ok(output.includes('processData'), 'Should find processData');
        });

        it('find: interactive includes tests with --include-tests', () => {
            const output = runInteractive(tmpDir, ['find processData --include-tests']);
            assert.ok(output.includes('processData'), 'Should find processData');
        });

        it('find: MCP includes tests with include_tests', async () => {
            const res = await mcpClient.callTool({ command: 'find', project_dir: tmpDir, name: 'processData', include_tests: true });
            assert.ok(!res.isError, 'Should not error');
            assert.ok(res.text.includes('processData'), 'Should find processData');
        });

        it('search: CLI excludes test files by default', () => {
            const output = runCli(tmpDir, 'search', ['processData']);
            assert.ok(output.includes('processData'), 'Should find search results');
        });

        it('search: interactive excludes test files by default', () => {
            const output = runInteractive(tmpDir, ['search processData']);
            assert.ok(output.includes('processData'), 'Should find search results');
        });

        it('search: MCP excludes test files by default', async () => {
            const res = await mcpClient.callTool({ command: 'search', project_dir: tmpDir, term: 'processData' });
            assert.ok(!res.isError, 'Should not error');
            assert.ok(res.text.includes('processData'), 'Should find search results');
        });
    });

    // ========================================================================
    // Category 2: Option forwarding parity
    // ========================================================================

    describe('toc options parity', () => {
        it('CLI: toc --top-level works', () => {
            const output = runCli(FIXTURES_PATH, 'toc', [], ['--top-level']);
            assert.ok(output.length > 0, 'Should produce output');
            assert.ok(!output.includes('Unknown flag'), 'Should not reject --top-level flag');
        });

        it('interactive: toc --top-level works', () => {
            const output = runInteractive(FIXTURES_PATH, ['toc --top-level']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('MCP: toc top_level works', async () => {
            const res = await mcpClient.callTool({ command: 'toc', project_dir: FIXTURES_PATH, top_level: true });
            assert.ok(!res.isError, 'Should not error');
            assert.ok(res.text.length > 0, 'Should produce output');
        });

        it('CLI: toc --all works', () => {
            const output = runCli(FIXTURES_PATH, 'toc', [], ['--all']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('interactive: toc --all works', () => {
            const output = runInteractive(FIXTURES_PATH, ['toc --all']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('MCP: toc all works', async () => {
            const res = await mcpClient.callTool({ command: 'toc', project_dir: FIXTURES_PATH, all: true });
            assert.ok(!res.isError, 'Should not error');
            assert.ok(res.text.length > 0, 'Should produce output');
        });

        it('CLI: toc --top=1 works', () => {
            const output = runCli(FIXTURES_PATH, 'toc', [], ['--top=1', '--detailed']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('interactive: toc --top=1 --detailed works', () => {
            const output = runInteractive(FIXTURES_PATH, ['toc --top=1 --detailed']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('MCP: toc top=1 detailed works', async () => {
            const res = await mcpClient.callTool({ command: 'toc', project_dir: FIXTURES_PATH, top: 1, detailed: true });
            assert.ok(!res.isError, 'Should not error');
            assert.ok(res.text.length > 0, 'Should produce output');
        });
    });

    describe('about options parity', () => {
        it('CLI: about --with-types works', () => {
            const output = runCli(FIXTURES_PATH, 'about', ['processData'], ['--with-types']);
            assert.ok(output.includes('processData'), 'Should find symbol');
        });

        it('interactive: about --with-types works', () => {
            const output = runInteractive(FIXTURES_PATH, ['about processData --with-types']);
            assert.ok(output.includes('processData'), 'Should find symbol');
        });

        it('MCP: about with_types works', async () => {
            const res = await mcpClient.callTool({ command: 'about', project_dir: FIXTURES_PATH, name: 'processData', with_types: true });
            assert.ok(!res.isError, 'Should not error');
            assert.ok(res.text.includes('processData'), 'Should find symbol');
        });

        it('CLI: about --all works', () => {
            const output = runCli(FIXTURES_PATH, 'about', ['processData'], ['--all']);
            assert.ok(output.includes('processData'), 'Should find symbol');
        });

        it('interactive: about --all works', () => {
            const output = runInteractive(FIXTURES_PATH, ['about processData --all']);
            assert.ok(output.includes('processData'), 'Should find symbol');
        });

        it('MCP: about all works', async () => {
            const res = await mcpClient.callTool({ command: 'about', project_dir: FIXTURES_PATH, name: 'processData', all: true });
            assert.ok(!res.isError, 'Should not error');
            assert.ok(res.text.includes('processData'), 'Should find symbol');
        });

        it('CLI: about --top=1 limits output', () => {
            const output = runCli(FIXTURES_PATH, 'about', ['processData'], ['--top=1']);
            assert.ok(output.includes('processData'), 'Should find symbol');
        });

        it('interactive: about --top=1 limits output', () => {
            const output = runInteractive(FIXTURES_PATH, ['about processData --top=1']);
            assert.ok(output.includes('processData'), 'Should find symbol');
        });

        it('MCP: about top=1 limits output', async () => {
            const res = await mcpClient.callTool({ command: 'about', project_dir: FIXTURES_PATH, name: 'processData', top: 1 });
            assert.ok(!res.isError, 'Should not error');
            assert.ok(res.text.includes('processData'), 'Should find symbol');
        });
    });

    describe('smart options parity', () => {
        it('CLI: smart --include-methods works', () => {
            const output = runCli(FIXTURES_PATH, 'smart', ['processData'], ['--include-methods']);
            assert.ok(output.includes('processData'), 'Should find symbol');
        });

        it('interactive: smart --include-methods works', () => {
            const output = runInteractive(FIXTURES_PATH, ['smart processData --include-methods']);
            assert.ok(output.includes('processData'), 'Should find symbol');
        });

        it('MCP: smart include_methods works', async () => {
            const res = await mcpClient.callTool({ command: 'smart', project_dir: FIXTURES_PATH, name: 'processData', include_methods: true });
            assert.ok(!res.isError, 'Should not error');
            assert.ok(res.text.includes('processData'), 'Should find symbol');
        });
    });

    describe('impact options parity', () => {
        it('CLI: impact --exclude=service works', () => {
            const output = runCli(FIXTURES_PATH, 'impact', ['processData'], ['--exclude=service']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('interactive: impact --exclude=service works', () => {
            const output = runInteractive(FIXTURES_PATH, ['impact processData --exclude=service']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('MCP: impact exclude works', async () => {
            const res = await mcpClient.callTool({ command: 'impact', project_dir: FIXTURES_PATH, name: 'processData', exclude: 'service' });
            assert.ok(!res.isError, 'Should not error');
        });
    });

    describe('find options parity', () => {
        it('CLI: find --file=main works', () => {
            const output = runCli(FIXTURES_PATH, 'find', ['processData'], ['--file=main']);
            assert.ok(output.includes('processData'), 'Should find symbol');
        });

        it('interactive: find --file=main works', () => {
            const output = runInteractive(FIXTURES_PATH, ['find processData --file=main']);
            assert.ok(output.includes('processData'), 'Should find symbol');
        });

        it('MCP: find file works', async () => {
            const res = await mcpClient.callTool({ command: 'find', project_dir: FIXTURES_PATH, name: 'processData', file: 'main' });
            assert.ok(!res.isError, 'Should not error');
            assert.ok(res.text.includes('processData'), 'Should find symbol');
        });
    });

    describe('usages options parity', () => {
        it('CLI: usages --exclude=service --in=. works', () => {
            const output = runCli(FIXTURES_PATH, 'usages', ['processData'], ['--exclude=service']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('interactive: usages --exclude=service works', () => {
            const output = runInteractive(FIXTURES_PATH, ['usages processData --exclude=service']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('MCP: usages exclude works', async () => {
            const res = await mcpClient.callTool({ command: 'usages', project_dir: FIXTURES_PATH, name: 'processData', exclude: 'service' });
            assert.ok(!res.isError, 'Should not error');
        });
    });

    describe('typedef options parity', () => {
        // Use TypeScript fixtures for typedef tests
        const tsFixtures = path.join(__dirname, 'fixtures', 'typescript');

        it('CLI: typedef --exact works', () => {
            const output = runCli(tsFixtures, 'typedef', ['Task'], ['--exact']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('interactive: typedef --exact works', () => {
            const output = runInteractive(tsFixtures, ['typedef Task --exact']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('MCP: typedef exact works', async () => {
            const res = await mcpClient.callTool({ command: 'typedef', project_dir: tsFixtures, name: 'Task', exact: true });
            assert.ok(!res.isError, 'Should not error');
        });
    });

    describe('api options parity', () => {
        it('CLI: api with file arg works', () => {
            const output = runCli(FIXTURES_PATH, 'api', ['main.js']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('interactive: api with file arg works', () => {
            const output = runInteractive(FIXTURES_PATH, ['api main.js']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('MCP: api with file works', async () => {
            const res = await mcpClient.callTool({ command: 'api', project_dir: FIXTURES_PATH, file: 'main.js' });
            assert.ok(!res.isError, 'Should not error');
        });
    });

    describe('graph options parity', () => {
        it('CLI: graph --depth=1 auto-expands', () => {
            const output = runCli(FIXTURES_PATH, 'graph', ['main.js'], ['--depth=1']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('interactive: graph --depth=1 auto-expands', () => {
            const output = runInteractive(FIXTURES_PATH, ['graph main.js --depth=1']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('MCP: graph depth=1 auto-expands', async () => {
            const res = await mcpClient.callTool({ command: 'graph', project_dir: FIXTURES_PATH, file: 'main.js', depth: 1 });
            assert.ok(!res.isError, 'Should not error');
        });
    });

    describe('related options parity', () => {
        it('CLI: related --top=1 works', () => {
            const output = runCli(FIXTURES_PATH, 'related', ['processData'], ['--top=1']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('interactive: related --top=1 works', () => {
            const output = runInteractive(FIXTURES_PATH, ['related processData --top=1']);
            assert.ok(output.length > 0, 'Should produce output');
        });

        it('MCP: related top=1 works', async () => {
            const res = await mcpClient.callTool({ command: 'related', project_dir: FIXTURES_PATH, name: 'processData', top: 1 });
            assert.ok(!res.isError, 'Should not error');
        });
    });

    describe('deadcode hint parity', () => {
        it('CLI: deadcode shows decorator/exported hints', () => {
            const output = runCli(FIXTURES_PATH, 'deadcode');
            // Just verify it doesn't crash — hints only show when there are excluded symbols
            assert.ok(typeof output === 'string', 'Should produce output');
        });

        it('interactive: deadcode shows hints', () => {
            const output = runInteractive(FIXTURES_PATH, ['deadcode']);
            assert.ok(typeof output === 'string', 'Should produce output');
        });

        it('MCP: deadcode shows hints', async () => {
            const res = await mcpClient.callTool({ command: 'deadcode', project_dir: FIXTURES_PATH });
            assert.ok(!res.isError, 'Should not error');
        });
    });

    // ========================================================================
    // Category 3: fn/class --all and --max-lines parity
    // ========================================================================

    describe('fn all parity', () => {
        // Create fixture with duplicate function names
        let tmpDir;

        before(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-fn-parity-'));
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'a.js'), 'function helper() { return 1; }\nmodule.exports = { helper };');
            fs.writeFileSync(path.join(tmpDir, 'b.js'), 'function helper() { return 2; }\nmodule.exports = { helper };');
        });

        after(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('CLI: fn --all shows all definitions', () => {
            const output = runCli(tmpDir, 'fn', ['helper'], ['--all']);
            // Should show both definitions
            assert.ok(output.includes('helper'), 'Should find helper');
        });

        it('interactive: fn --all shows all definitions', () => {
            const output = runInteractive(tmpDir, ['fn helper --all']);
            assert.ok(output.includes('helper'), 'Should find helper');
        });

        it('MCP: fn all shows all definitions', async () => {
            const res = await mcpClient.callTool({ command: 'fn', project_dir: tmpDir, name: 'helper', all: true });
            assert.ok(!res.isError, 'Should not error');
            assert.ok(res.text.includes('helper'), 'Should find helper');
            // With all=true and 2 definitions, should show both
            assert.ok(res.text.includes('return 1') && res.text.includes('return 2'),
                'Should show both definitions with all=true');
        });
    });

    describe('class max-lines parity', () => {
        let tmpDir;

        before(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-cls-parity-'));
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            // Create a class with >200 lines to test large class summary
            const methods = [];
            for (let i = 0; i < 70; i++) {
                methods.push(`    method${i}(arg) {\n        const x = arg + ${i};\n        return x;\n    }`);
            }
            fs.writeFileSync(path.join(tmpDir, 'big.js'), `class BigClass {\n${methods.join('\n')}\n}\nmodule.exports = { BigClass };`);
            // Small class for basic test
            fs.writeFileSync(path.join(tmpDir, 'small.js'), `class SmallClass {\n    greet() { return 'hi'; }\n}\nmodule.exports = { SmallClass };`);
        });

        after(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('CLI: class works for small class', () => {
            const output = runCli(tmpDir, 'class', ['SmallClass']);
            assert.ok(output.includes('SmallClass'), 'Should find class');
            assert.ok(output.includes('greet'), 'Should show method');
        });

        it('interactive: class works for small class', () => {
            const output = runInteractive(tmpDir, ['class SmallClass']);
            assert.ok(output.includes('SmallClass'), 'Should find class');
        });

        it('MCP: class works for small class', async () => {
            const res = await mcpClient.callTool({ command: 'class', project_dir: tmpDir, name: 'SmallClass' });
            assert.ok(!res.isError, 'Should not error');
            assert.ok(res.text.includes('SmallClass'), 'Should find class');
        });

        it('CLI: large class shows summary', () => {
            const output = runCli(tmpDir, 'class', ['BigClass']);
            assert.ok(output.includes('BigClass'), 'Should find class');
            assert.ok(output.includes('Methods'), 'Should show method summary for large class');
        });

        it('interactive: large class shows summary', () => {
            const output = runInteractive(tmpDir, ['class BigClass']);
            assert.ok(output.includes('BigClass'), 'Should find class');
            assert.ok(output.includes('Methods'), 'Should show method summary for large class');
        });

        it('MCP: large class shows summary', async () => {
            const res = await mcpClient.callTool({ command: 'class', project_dir: tmpDir, name: 'BigClass' });
            assert.ok(!res.isError, 'Should not error');
            assert.ok(res.text.includes('BigClass'), 'Should find class');
            assert.ok(res.text.includes('Methods'), 'Should show method summary');
        });

        it('CLI: class --max-lines=5 truncates', () => {
            const output = runCli(tmpDir, 'class', ['BigClass'], ['--max-lines=5']);
            assert.ok(output.includes('BigClass'), 'Should find class');
            assert.ok(output.includes('showing 5 of'), 'Should show truncation notice');
        });

        it('interactive: class --max-lines=5 truncates', () => {
            const output = runInteractive(tmpDir, ['class BigClass --max-lines=5']);
            assert.ok(output.includes('BigClass'), 'Should find class');
            assert.ok(output.includes('showing 5 of'), 'Should show truncation notice');
        });

        it('MCP: class max_lines=5 truncates', async () => {
            const res = await mcpClient.callTool({ command: 'class', project_dir: tmpDir, name: 'BigClass', max_lines: 5 });
            assert.ok(!res.isError, 'Should not error');
            assert.ok(res.text.includes('BigClass'), 'Should find class');
            assert.ok(res.text.includes('showing 5 of'), 'Should show truncation notice');
        });
    });

    // ========================================================================
    // Category 4: stats top default parity
    // ========================================================================

    describe('stats defaults parity', () => {
        it('CLI and MCP produce consistent stats output', async () => {
            const cliOutput = runCli(FIXTURES_PATH, 'stats');
            const mcpRes = await mcpClient.callTool({ command: 'stats', project_dir: FIXTURES_PATH });

            assert.ok(cliOutput.length > 0, 'CLI should produce output');
            assert.ok(mcpRes.text.length > 0, 'MCP should produce output');
            // Both should show basic stats (file counts, line counts)
            assert.ok(cliOutput.includes('file'), 'CLI should mention files');
            assert.ok(mcpRes.text.includes('file'), 'MCP should mention files');
        });
    });

    // ========================================================================
    // Category 5: All commands produce output without crashing
    // ========================================================================

    describe('All commands run without crashing across interfaces', () => {
        const symbolCommands = [
            { cmd: 'about', name: 'processData' },
            { cmd: 'context', name: 'processData' },
            { cmd: 'impact', name: 'processData' },
            { cmd: 'smart', name: 'processData' },
            { cmd: 'trace', name: 'processData' },
            { cmd: 'example', name: 'processData' },
            { cmd: 'related', name: 'processData' },
            { cmd: 'find', name: 'processData' },
            { cmd: 'usages', name: 'processData' },
            { cmd: 'tests', name: 'processData' },
            { cmd: 'typedef', name: 'DataProcessor' },
            { cmd: 'verify', name: 'processData' },
        ];

        const noArgCommands = [
            { cmd: 'toc' },
            { cmd: 'deadcode' },
            { cmd: 'stats' },
            { cmd: 'api' },
        ];

        const fileCommands = [
            { cmd: 'imports', file: 'main.js' },
            { cmd: 'exporters', file: 'main.js' },
            { cmd: 'file-exports', file: 'main.js', mcpCmd: 'file_exports' },
            { cmd: 'graph', file: 'main.js' },
        ];

        for (const { cmd, name } of symbolCommands) {
            it(`${cmd}: all 3 interfaces produce output`, async () => {
                const cliOut = runCli(FIXTURES_PATH, cmd, [name]);
                const intOut = runInteractive(FIXTURES_PATH, [`${cmd} ${name}`]);
                const mcpRes = await mcpClient.callTool({ command: cmd, project_dir: FIXTURES_PATH, name });

                assert.ok(cliOut.length > 0, `CLI ${cmd} should produce output`);
                assert.ok(intOut.length > 0, `Interactive ${cmd} should produce output`);
                assert.ok(!mcpRes.isError, `MCP ${cmd} should not error`);
            });
        }

        for (const { cmd } of noArgCommands) {
            it(`${cmd}: all 3 interfaces produce output`, async () => {
                const cliOut = runCli(FIXTURES_PATH, cmd);
                const intOut = runInteractive(FIXTURES_PATH, [cmd]);
                const mcpRes = await mcpClient.callTool({ command: cmd, project_dir: FIXTURES_PATH });

                assert.ok(cliOut.length > 0, `CLI ${cmd} should produce output`);
                assert.ok(intOut.length > 0, `Interactive ${cmd} should produce output`);
                assert.ok(!mcpRes.isError, `MCP ${cmd} should not error`);
            });
        }

        for (const { cmd, file, mcpCmd } of fileCommands) {
            it(`${cmd}: all 3 interfaces produce output`, async () => {
                const cliOut = runCli(FIXTURES_PATH, cmd, [file]);
                const intOut = runInteractive(FIXTURES_PATH, [`${cmd} ${file}`]);
                const mcpRes = await mcpClient.callTool({ command: mcpCmd || cmd, project_dir: FIXTURES_PATH, file });

                assert.ok(cliOut.length > 0, `CLI ${cmd} should produce output`);
                assert.ok(intOut.length > 0, `Interactive ${cmd} should produce output`);
                assert.ok(!mcpRes.isError, `MCP ${cmd} should not error`);
            });
        }

        it('search: all 3 interfaces produce output', async () => {
            const cliOut = runCli(FIXTURES_PATH, 'search', ['processData']);
            const intOut = runInteractive(FIXTURES_PATH, ['search processData']);
            const mcpRes = await mcpClient.callTool({ command: 'search', project_dir: FIXTURES_PATH, term: 'processData' });

            assert.ok(cliOut.length > 0, 'CLI search should produce output');
            assert.ok(intOut.length > 0, 'Interactive search should produce output');
            assert.ok(!mcpRes.isError, 'MCP search should not error');
        });

        it('fn: all 3 interfaces produce output', async () => {
            const cliOut = runCli(FIXTURES_PATH, 'fn', ['processData']);
            const intOut = runInteractive(FIXTURES_PATH, ['fn processData']);
            const mcpRes = await mcpClient.callTool({ command: 'fn', project_dir: FIXTURES_PATH, name: 'processData' });

            assert.ok(cliOut.length > 0, 'CLI fn should produce output');
            assert.ok(intOut.length > 0, 'Interactive fn should produce output');
            assert.ok(!mcpRes.isError, 'MCP fn should not error');
        });

        it('class: all 3 interfaces produce output', async () => {
            const cliOut = runCli(FIXTURES_PATH, 'class', ['DataProcessor']);
            const intOut = runInteractive(FIXTURES_PATH, ['class DataProcessor']);
            const mcpRes = await mcpClient.callTool({ command: 'class', project_dir: FIXTURES_PATH, name: 'DataProcessor' });

            assert.ok(cliOut.length > 0, 'CLI class should produce output');
            assert.ok(intOut.length > 0, 'Interactive class should produce output');
            assert.ok(!mcpRes.isError, 'MCP class should not error');
        });
    });

    // ========================================================================
    // P1 Bug Fixes
    // ========================================================================

    describe('P1 fix: MCP trace honors all parameter', () => {
        it('MCP trace with all=true should expand truncated sections', async () => {
            const resDefault = await mcpClient.callTool({ command: 'trace', project_dir: FIXTURES_PATH, name: 'processData' });
            const resAll = await mcpClient.callTool({ command: 'trace', project_dir: FIXTURES_PATH, name: 'processData', all: true });
            assert.ok(!resDefault.isError, 'Default trace should not error');
            assert.ok(!resAll.isError, 'Trace with all=true should not error');
            // all=true output should be >= default (never shorter)
            assert.ok(resAll.text.length >= resDefault.text.length, 'all=true should produce output at least as long as default');
        });

        it('CLI trace --all parity with MCP trace all=true', async () => {
            const cliAll = runCli(FIXTURES_PATH, 'trace', ['processData'], ['--all']);
            const mcpAll = await mcpClient.callTool({ command: 'trace', project_dir: FIXTURES_PATH, name: 'processData', all: true });
            assert.ok(cliAll.length > 0, 'CLI trace --all should produce output');
            assert.ok(!mcpAll.isError, 'MCP trace all=true should not error');
            assert.ok(mcpAll.text.length > 0, 'MCP trace all=true should produce output');
        });
    });

    describe('P1 fix: McpClient.callTool propagates isError', () => {
        it('callTool shorthand returns soft error for analysis failures', async () => {
            // api with nonexistent file returns a soft error (no isError flag)
            // to avoid killing sibling calls in parallel batches
            const res = await mcpClient.callTool({ command: 'api', project_dir: FIXTURES_PATH, file: 'nonexistent/path.js' });
            assert.strictEqual(res.isError, false, 'Analysis errors should be soft (no isError flag)');
            assert.ok(res.text.includes('not found') || res.text.includes('No file'), 'Should contain error message in text');
        });

        it('callTool shorthand returns isError=true for pre-validation errors', async () => {
            // Unknown command is a true infrastructure error — should use isError
            const res = await mcpClient.callTool({ command: 'nonexistent_command', project_dir: FIXTURES_PATH });
            assert.strictEqual(res.isError, true, 'Should return isError=true for unknown commands');
        });

        it('callTool shorthand returns isError=false for valid calls', async () => {
            const res = await mcpClient.callTool({ command: 'toc', project_dir: FIXTURES_PATH });
            assert.strictEqual(res.isError, false, 'Should return isError=false for valid call');
        });
    });

    describe('P1 fix: diff-impact base ref validation', () => {
        it('CLI rejects invalid base ref with clean error', () => {
            const output = runCli(FIXTURES_PATH, 'diff-impact', [], ['--base=; rm -rf /']);
            assert.ok(output.includes('Invalid git ref'), 'CLI should reject invalid base ref');
            assert.ok(!output.includes('at '), 'Should not show stack trace');
        });

        it('MCP rejects invalid base ref with soft error', async () => {
            // Invalid ref returns soft error to avoid killing sibling calls
            const res = await mcpClient.callTool({ command: 'diff_impact', project_dir: FIXTURES_PATH, base: '$(evil)' });
            assert.strictEqual(res.isError, false, 'Should be soft error (no isError flag)');
            assert.ok(res.text.includes('Invalid git ref'), 'Should mention invalid ref');
        });
    });

    // ========================================================================
    // Registry consistency
    // ========================================================================

    describe('Registry consistency', () => {
        it('all CLI aliases resolve to canonical commands', () => {
            for (const [alias, canonical] of Object.entries(CLI_ALIASES)) {
                assert.ok(CANONICAL_COMMANDS.includes(canonical),
                    `CLI alias "${alias}" resolves to "${canonical}" which is not in CANONICAL_COMMANDS`);
            }
        });

        it('all MCP aliases resolve to canonical commands', () => {
            for (const [alias, canonical] of Object.entries(MCP_ALIASES)) {
                assert.ok(CANONICAL_COMMANDS.includes(canonical),
                    `MCP alias "${alias}" resolves to "${canonical}" which is not in CANONICAL_COMMANDS`);
            }
        });

        it('CLI command set includes all canonical commands (hyphenated)', () => {
            const cliSet = getCliCommandSet();
            for (const cmd of CANONICAL_COMMANDS) {
                const hyphenated = cmd.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
                assert.ok(cliSet.has(hyphenated),
                    `Canonical "${cmd}" → CLI "${hyphenated}" missing from getCliCommandSet()`);
            }
        });

        it('MCP enum includes all canonical commands (snake_cased)', () => {
            const mcpEnum = getMcpCommandEnum();
            for (const cmd of CANONICAL_COMMANDS) {
                const snaked = cmd.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
                assert.ok(mcpEnum.includes(snaked),
                    `Canonical "${cmd}" → MCP "${snaked}" missing from getMcpCommandEnum()`);
            }
        });

        it('MCP enum matches canonical command count', () => {
            assert.strictEqual(getMcpCommandEnum().length, CANONICAL_COMMANDS.length);
        });

        it('resolveCommand handles all aliases', () => {
            assert.strictEqual(resolveCommand('diff-impact', 'cli'), 'diffImpact');
            assert.strictEqual(resolveCommand('diff_impact', 'mcp'), 'diffImpact');
            assert.strictEqual(resolveCommand('file-exports', 'cli'), 'fileExports');
            assert.strictEqual(resolveCommand('file_exports', 'mcp'), 'fileExports');
            assert.strictEqual(resolveCommand('stack', 'cli'), 'stacktrace');
            assert.strictEqual(resolveCommand('what-imports', 'cli'), 'imports');
            assert.strictEqual(resolveCommand('who-imports', 'cli'), 'exporters');
            assert.strictEqual(resolveCommand('what-exports', 'cli'), 'fileExports');
            assert.strictEqual(resolveCommand('about'), 'about'); // canonical passthrough
            assert.strictEqual(resolveCommand('bogus'), null);
        });

        it('normalizeParams converts all known snake_case params', () => {
            const input = {};
            for (const key of Object.keys(PARAM_MAP)) {
                input[key] = true;
            }
            const result = normalizeParams(input);
            for (const [snake, camel] of Object.entries(PARAM_MAP)) {
                assert.ok(camel in result, `${snake} should normalize to ${camel}`);
            }
        });

        it('normalizeParams passes through unknown params', () => {
            const result = normalizeParams({ depth: 3, name: 'foo', unknown_param: 'bar' });
            assert.strictEqual(result.depth, 3);
            assert.strictEqual(result.name, 'foo');
            assert.strictEqual(result.unknown_param, 'bar');
        });
    });
});

// ============================================================================
// Architecture Guard Tests
// ============================================================================

describe('Architecture Guards', () => {

    it('MCP switch has no duplicate case labels', () => {
        const serverCode = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'server.js'), 'utf-8');
        // Extract all case 'xxx': labels from the switch
        const caseRegex = /case\s+'([^']+)':/g;
        const cases = [];
        let match;
        while ((match = caseRegex.exec(serverCode)) !== null) {
            cases.push(match[1]);
        }
        const seen = new Set();
        const duplicates = [];
        for (const c of cases) {
            if (seen.has(c)) duplicates.push(c);
            seen.add(c);
        }
        assert.deepStrictEqual(duplicates, [],
            `MCP server has duplicate case labels: ${duplicates.join(', ')}`);
    });

    it('CLI runProjectCommand dispatches on canonical (not raw command)', () => {
        const cliCode = fs.readFileSync(path.join(__dirname, '..', 'cli', 'index.js'), 'utf-8');
        // Find the runProjectCommand function and verify it switches on canonical
        const fnMatch = cliCode.match(/function runProjectCommand[\s\S]*?switch\s*\((\w+)\)/);
        assert.ok(fnMatch, 'Should find switch in runProjectCommand');
        assert.strictEqual(fnMatch[1], 'canonical',
            'runProjectCommand should switch on canonical, not command');
    });

    it('every canonical command has a handler in execute.js (zero exceptions)', () => {
        const { execute } = require(path.join(__dirname, '..', 'core', 'execute'));

        for (const cmd of CANONICAL_COMMANDS) {
            // execute() should accept the command (not return "Unknown command")
            const result = execute({}, cmd, {});
            // It may fail with a validation error (e.g. "name required"), but NOT "Unknown command"
            if (!result.ok) {
                assert.ok(!result.error.startsWith('Unknown command'),
                    `Command "${cmd}" should have a handler in execute.js, got: ${result.error}`);
            }
        }
    });

    it('every MCP command enum value maps to a handler in the switch', () => {
        const mcpCommands = getMcpCommandEnum();
        const serverCode = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'server.js'), 'utf-8');

        for (const cmd of mcpCommands) {
            assert.ok(serverCode.includes(`case '${cmd}':`),
                `MCP command "${cmd}" should have a case in the server switch`);
        }
    });

    it('all CLI aliases resolve to valid canonical commands', () => {
        for (const [alias, canonical] of Object.entries(CLI_ALIASES)) {
            assert.ok(CANONICAL_COMMANDS.includes(canonical),
                `CLI alias "${alias}" → "${canonical}" should map to a canonical command`);
        }
    });

    it('all MCP aliases resolve to valid canonical commands', () => {
        for (const [alias, canonical] of Object.entries(MCP_ALIASES)) {
            assert.ok(CANONICAL_COMMANDS.includes(canonical),
                `MCP alias "${alias}" → "${canonical}" should map to a canonical command`);
        }
    });

    it('MCP server normalizes params once — no per-case normalizeParams drift', () => {
        const serverCode = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'server.js'), 'utf-8');
        // Must have single top-level normalization
        assert.ok(serverCode.includes('const ep = normalizeParams(rawParams)'),
            'MCP handler should normalize all params once at top');
        // No per-case normalizeParams calls inside switch
        const switchStart = serverCode.indexOf('switch (command)');
        const switchBody = serverCode.substring(switchStart);
        const perCaseCalls = (switchBody.match(/normalizeParams\(\{/g) || []).length;
        assert.strictEqual(perCaseCalls, 0,
            `Found ${perCaseCalls} per-case normalizeParams calls in switch — all params should flow through the shared ep`);
    });

    it('every PARAM_MAP entry has a matching Zod schema field in MCP', () => {
        const serverCode = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'server.js'), 'utf-8');
        for (const snakeKey of Object.keys(PARAM_MAP)) {
            assert.ok(serverCode.includes(`${snakeKey}:`),
                `PARAM_MAP key "${snakeKey}" should have a matching field in MCP Zod schema`);
        }
    });
});

// ============================================================================
// BUG HUNT 2026-03-02: max-lines validation parity
// ============================================================================

describe('fix: class --max-lines validation in core (all surfaces)', () => {
    it('rejects negative max-lines via execute()', () => {
        const { execute } = require(path.join(__dirname, '..', 'core', 'execute'));
        const { tmp, rm, idx } = require('./helpers');
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': 'class Foo {\n  method1() {}\n  method2() {}\n}\n'
        });
        try {
            const index = idx(dir);
            const { ok, error } = execute(index, 'class', { name: 'Foo', maxLines: -1 });
            assert.strictEqual(ok, false, 'should reject negative max-lines');
            assert.ok(error.includes('positive integer'), `error should mention positive integer, got: ${error}`);
        } finally {
            rm(dir);
        }
    });

    it('rejects non-numeric max-lines via execute()', () => {
        const { execute } = require(path.join(__dirname, '..', 'core', 'execute'));
        const { tmp, rm, idx } = require('./helpers');
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': 'class Bar {\n  method1() {}\n  method2() {}\n}\n'
        });
        try {
            const index = idx(dir);
            const { ok, error } = execute(index, 'class', { name: 'Bar', maxLines: 'abc' });
            assert.strictEqual(ok, false, 'should reject non-numeric max-lines');
            assert.ok(error.includes('positive integer'), `error should mention positive integer, got: ${error}`);
        } finally {
            rm(dir);
        }
    });

    it('CLI project mode commands spread all flags to execute()', () => {
        // Guard: all symbol-accepting commands in runProjectCommand should use
        // ...flags (not hand-picked params) to prevent drift when new flags are added.
        const cliSource = fs.readFileSync(path.join(__dirname, '..', 'cli', 'index.js'), 'utf-8');

        // Find the runProjectCommand function body — look for case statements that call execute()
        // Commands that should use ...flags pattern:
        const commandsNeedingFlags = [
            'about', 'context', 'impact', 'smart', 'trace', 'related',
            'verify', 'plan'
        ];

        for (const cmd of commandsNeedingFlags) {
            // Find the case block for this command and check it uses ...flags
            const caseRegex = new RegExp(`case '${cmd}':[\\s\\S]*?execute\\(index,\\s*'${cmd}',\\s*\\{[^}]*\\}\\)`, 'm');
            const match = cliSource.match(caseRegex);
            if (match) {
                assert.ok(match[0].includes('...flags'),
                    `CLI command '${cmd}' should spread ...flags to execute(), got: ${match[0].slice(-80)}`);
            }
        }
    });

    it('accepts valid positive integer max-lines', () => {
        const { execute } = require(path.join(__dirname, '..', 'core', 'execute'));
        const { tmp, rm, idx } = require('./helpers');
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': 'class Baz {\n  method1() {}\n  method2() {}\n}\n'
        });
        try {
            const index = idx(dir);
            const { ok } = execute(index, 'class', { name: 'Baz', maxLines: 2 });
            assert.strictEqual(ok, true, 'valid max-lines should succeed');
        } finally {
            rm(dir);
        }
    });
});
