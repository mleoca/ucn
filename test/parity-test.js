'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    CANONICAL_COMMANDS,
    PARAM_MAP,
    REVERSE_PARAM_MAP,
    FLAG_APPLICABILITY,
    BROAD_COMMANDS,
    FILE_LOCAL_COMMANDS,
    getCliCommandSet,
    getMcpCommandEnum,
    generateMcpParamSection,
    normalizeParams,
    resolveCommand,
    suggestCommand,
    toCliName,
    toMcpName,
} = require('../core/registry');
const { execute } = require('../core/execute');
const { formatPublicJson, formatPublicText } = require('../core/output');
const { normalizeSurfaceGuidance } = require('./agent-public-surface-benchmark');
const { tmp, rm, idx, runCli, runInteractive, McpClient } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const EXPECTED_COMMANDS = [
    'show', 'find', 'usages', 'search', 'source', 'trace',
    'impact', 'tests', 'check', 'plan', 'repo', 'deps', 'api',
    'entrypoints', 'endpoints', 'deadcode', 'auditAsync', 'stacktrace',
];

function fixture() {
    return tmp({
        'src/service.js': [
            'export function helper(value) { return value + 1; }',
            'export function processData(value) { return helper(value); }',
            'export async function missingAwait() { helper(1); }',
            'function orphan() { return 0; }',
            "app.get('/items', processData);",
        ].join('\n'),
        'src/client.js': [
            "import { processData } from './service.js';",
            'export function run() { return processData(2); }',
        ].join('\n'),
        'test/service-check.js': [
            "import { processData } from '../src/service.js';",
            'test("processData", () => processData(1));',
        ].join('\n'),
    });
}

function assertClean(text, label) {
    assert.ok(text && text.trim(), `${label} should produce output`);
    assert.doesNotMatch(text, /^Unknown command:/m, `${label} must be registered`);
    assert.doesNotMatch(text, /^Error:/m, `${label} must execute cleanly`);
}

describe('v5 public command registry', () => {
    it('contains exactly the 18 task-oriented commands', () => {
        assert.deepStrictEqual(CANONICAL_COMMANDS, EXPECTED_COMMANDS);
        assert.deepStrictEqual([...getCliCommandSet()], EXPECTED_COMMANDS.map(toCliName));
        assert.deepStrictEqual(getMcpCommandEnum(), EXPECTED_COMMANDS.map(toMcpName));
    });

    it('has no legacy aliases and rejects retired command names', () => {
        for (const retired of ['about', 'context', 'blast', 'reverse-trace', 'affected-tests',
            'verify', 'fn', 'class', 'lines', 'toc', 'stats', 'doctor', 'expand']) {
            assert.strictEqual(resolveCommand(retired, 'cli'), null, retired);
        }
        assert.strictEqual(resolveCommand('audit-async', 'cli'), 'auditAsync');
        assert.strictEqual(resolveCommand('audit_async', 'mcp'), 'auditAsync');
    });

    it('offers only high-confidence corrections for misspelled commands', () => {
        assert.strictEqual(suggestCommand('shwo', 'cli'), 'show');
        assert.strictEqual(suggestCommand('audit_asnyc', 'mcp'), 'audit_async');
        assert.strictEqual(suggestCommand('src', 'cli'), null,
            'an unrelated missing path must not be reinterpreted as a command');
    });

    it('normalizes MCP spelling once', () => {
        assert.deepStrictEqual(normalizeParams({
            with_source: true,
            expand_unverified: true,
            project_dir: '/tmp/project',
        }), {
            withSource: true,
            expandUnverified: true,
            projectDir: '/tmp/project',
        });
    });

    it('classifies every public command and no retired command', () => {
        assert.deepStrictEqual(Object.keys(FLAG_APPLICABILITY).sort(), [...EXPECTED_COMMANDS].sort());
        for (const command of BROAD_COMMANDS) assert.ok(EXPECTED_COMMANDS.includes(command));
        for (const command of FILE_LOCAL_COMMANDS) assert.ok(EXPECTED_COMMANDS.includes(command));
    });

    it('puts the honest command contract in every machine-readable answer', () => {
        const document = JSON.parse(formatPublicJson('find', [], { name: 'missing' }));
        assert.strictEqual(document.meta.contract.question,
            'Which indexed definition or type does this name identify?');
        assert.strictEqual(document.meta.contract.decisionSafety, 'navigation');
        assert.ok(document.meta.contract.truth);
        assert.ok(document.meta.contract.next.length > 0);
    });
});

describe('single-router architecture', () => {
    const cliCode = fs.readFileSync(path.join(ROOT, 'cli', 'index.js'), 'utf8');
    const mcpCode = fs.readFileSync(path.join(ROOT, 'mcp', 'server.js'), 'utf8');
    const executeCode = fs.readFileSync(path.join(ROOT, 'core', 'execute.js'), 'utf8');
    const publicOutputCode = fs.readFileSync(path.join(ROOT, 'core', 'output', 'public.js'), 'utf8');

    it('CLI project, file, glob, and interactive modes share the public router', () => {
        assert.ok((cliCode.match(/buildPublicParams\(/g) || []).length >= 4);
        assert.match(cliCode, /function formatCliText\(/);
        assert.ok((cliCode.match(/formatCliText\(/g) || []).length >= 5);
        assert.doesNotMatch(cliCode, /switch\s*\(canonical\)/);
        assert.doesNotMatch(cliCode, /switch\s*\(command\)/);
    });

    it('MCP has one generic execution and presentation path', () => {
        assert.match(mcpCode, /execute\(index, canonicalCommand, ep\)/);
        assert.match(mcpCode, /formatPublicText\(/);
        assert.doesNotMatch(mcpCode, /switch\s*\(command\)/);
        assert.doesNotMatch(mcpCode, /case\s+['"]/);
    });

    it('every public command has an engine handler and formatter case', () => {
        for (const command of EXPECTED_COMMANDS) {
            assert.match(executeCode, new RegExp(`\\n\\s{4}${command}:\\s*\\(`), `${command} handler`);
            assert.match(publicOutputCode, new RegExp(`case '${command}'`), `${command} formatter`);
        }
    });

    it('the MCP schema and generated flag reference cover every accepted parameter', () => {
        const generated = generateMcpParamSection();
        for (const [command, params] of Object.entries(FLAG_APPLICABILITY)) {
            assert.ok(generated.includes(`  ${toMcpName(command)}:`));
            for (const param of params) {
                const surface = REVERSE_PARAM_MAP[param] || param;
                assert.ok(generated.includes(surface), `${command}.${surface}`);
                assert.match(mcpCode, new RegExp(`\\n\\s*${surface}:\\s*z\\.`), `${surface} schema`);
            }
        }
        for (const snake of Object.keys(PARAM_MAP)) {
            assert.match(mcpCode, new RegExp(`\\n\\s*${snake}:\\s*z\\.`), `${snake} schema`);
        }
    });
});

describe('18-command CLI/MCP/interactive parity', () => {
    let dir;
    let mcp;

    const cases = [
        { command: 'repo', cliArgs: [], cliFlags: [], mcp: {} },
        { command: 'show', cliArgs: ['processData'], cliFlags: [], mcp: { name: 'processData' } },
        { command: 'find', cliArgs: ['processData'], cliFlags: [], mcp: { name: 'processData' } },
        { command: 'usages', cliArgs: ['processData'], cliFlags: ['--include-tests'], mcp: { name: 'processData', include_tests: true } },
        { command: 'search', cliArgs: ['processData'], cliFlags: ['--include-tests'], mcp: { term: 'processData', include_tests: true } },
        { command: 'source', cliArgs: ['processData'], cliFlags: ['--file=src/service.js'], mcp: { name: 'processData', file: 'src/service.js' } },
        { command: 'trace', cliArgs: ['processData'], cliFlags: ['--depth=1'], mcp: { name: 'processData', depth: 1 } },
        { command: 'impact', cliArgs: ['processData'], cliFlags: [], mcp: { name: 'processData' } },
        { command: 'tests', cliArgs: ['processData'], cliFlags: [], mcp: { name: 'processData' } },
        { command: 'check', cliArgs: ['processData'], cliFlags: [], mcp: { name: 'processData' } },
        { command: 'plan', cliArgs: ['processData'], cliFlags: ['--rename-to=processValue'], mcp: { name: 'processData', rename_to: 'processValue' } },
        { command: 'deps', cliArgs: ['src/service.js'], cliFlags: ['--depth=1'], mcp: { file: 'src/service.js', depth: 1 } },
        { command: 'api', cliArgs: ['src/service.js'], cliFlags: [], mcp: { file: 'src/service.js' } },
        { command: 'entrypoints', cliArgs: [], cliFlags: [], mcp: {} },
        { command: 'endpoints', cliArgs: [], cliFlags: [], mcp: {} },
        { command: 'deadcode', cliArgs: [], cliFlags: [], mcp: {} },
        { command: 'auditAsync', cliName: 'audit-async', mcpName: 'audit_async', cliArgs: [], cliFlags: [], mcp: {} },
        { command: 'stacktrace', cliArgs: ['at processData (src/service.js:2:1)'], cliFlags: [], mcp: { stack: 'at processData (src/service.js:2:1)' } },
    ];

    before(async () => {
        dir = fixture();
        mcp = new McpClient();
        await mcp.start();
        await mcp.initialize();
    });

    after(() => {
        if (mcp) mcp.stop();
        if (dir) rm(dir);
    });

    for (const spec of cases) {
        it(`${toCliName(spec.command)} executes through CLI, MCP, and interactive`, async () => {
            const cliName = spec.cliName || toCliName(spec.command);
            const mcpName = spec.mcpName || toMcpName(spec.command);
            const cli = runCli(dir, cliName, spec.cliArgs, spec.cliFlags);
            assertClean(cli, `CLI ${cliName}`);

            const interactiveLine = [cliName, ...spec.cliArgs, ...spec.cliFlags].join(' ');
            const interactive = runInteractive(dir, [interactiveLine]);
            assertClean(interactive, `interactive ${cliName}`);

            const result = await mcp.callTool({
                command: mcpName,
                project_dir: dir,
                ...spec.mcp,
            });
            assert.strictEqual(result.isError, false, result.text);
            assertClean(result.text, `MCP ${mcpName}`);
            assert.strictEqual(
                normalizeSurfaceGuidance(result.text.trimEnd()),
                normalizeSurfaceGuidance(cli.trimEnd()),
                `${cliName} engine facts must be byte-equivalent after native guidance normalization`,
            );
        });
    }

    it('MCP publishes one tool documenting exactly the public command set', async () => {
        const listed = await mcp.send('tools/list', {});
        assert.strictEqual(listed.result.tools.length, 1);
        const tool = listed.result.tools[0];
        assert.strictEqual(tool.name, 'ucn');
        // The command param is a described string, not a hard enum: an enum
        // would make v4 names die in SDK validation with no replacement
        // guidance. The handler validates against the same registry list.
        const commandSchema = tool.inputSchema.properties.command;
        assert.strictEqual(commandSchema.type, 'string');
        assert.strictEqual(commandSchema.enum, undefined);
        for (const name of getMcpCommandEnum()) {
            assert.ok(commandSchema.description.includes(name),
                `command description must list "${name}"`);
        }
        assert.match(tool.description, /18 task-oriented commands/);
        assert.doesNotMatch(tool.description, /- about\b|- context\b|- blast\b/);
    });

    it('CLI JSON uses one stable envelope for every public command', () => {
        for (const spec of cases.filter(c => c.command !== 'stacktrace')) {
            const text = runCli(dir, spec.cliName || toCliName(spec.command), spec.cliArgs,
                [...spec.cliFlags, '--json']);
            const parsed = JSON.parse(text);
            assert.strictEqual(parsed.meta.command, spec.cliName || toCliName(spec.command));
            if ((spec.cliName || toCliName(spec.command)) !== spec.command) {
                assert.strictEqual(parsed.meta.canonicalCommand, spec.command);
            }
            assert.ok(Object.hasOwn(parsed, 'data'));
        }
    });

    it('source accepts symbol and file-range forms', () => {
        assert.match(runCli(dir, 'source', ['processData'], ['--file=src/service.js']), /processData/);
        assert.match(runCli(dir, 'source', ['src/service.js:1-2']), /helper/);
    });

    it('CLI and interactive mode recover from command typos with one correction', () => {
        assert.match(runCli(dir, 'shwo', ['processData']), /Did you mean "show"\?/);
        assert.match(runInteractive(dir, ['shwo processData']), /Did you mean "show"\?/);
    });

    it('CLI and MCP expose the same explicit range and non-compact controls', async () => {
        const cliRange = runCli(dir, 'source', [], ['--file=src/service.js', '--range=1-2']);
        const mcpRange = await mcp.callTool({
            command: 'source', project_dir: dir, file: 'src/service.js', range: '1-2',
        });
        assert.strictEqual(mcpRange.isError, false, mcpRange.text);
        assert.strictEqual(
            normalizeSurfaceGuidance(mcpRange.text.trimEnd()),
            normalizeSurfaceGuidance(cliRange.trimEnd()),
        );

        const cliFull = runCli(dir, 'show', ['processData'], ['--no-compact']);
        const mcpFull = await mcp.callTool({
            command: 'show', project_dir: dir, name: 'processData', compact: false,
        });
        assert.strictEqual(mcpFull.isError, false, mcpFull.text);
        assert.strictEqual(
            normalizeSurfaceGuidance(mcpFull.text.trimEnd()),
            normalizeSurfaceGuidance(cliFull.trimEnd()),
        );
    });

    it('find uses one result cap and one explicit source control on every surface', async () => {
        const index = idx(dir);
        const execution = execute(index, 'find', {
            name: 'processData',
            exact: true,
            includeTests: true,
            limit: 1,
            withSource: true,
        });
        assert.ok(execution.ok, execution.error);
        assert.strictEqual(execution.result.length, 1);
        assert.match(execution.result[0].code, /function processData/);

        const cli = runCli(dir, 'find', ['processData'],
            ['--exact', '--include-tests', '--limit=1', '--with-source']);
        const mcpResult = await mcp.callTool({
            command: 'find',
            project_dir: dir,
            name: 'processData',
            exact: true,
            include_tests: true,
            limit: 1,
            with_source: true,
        });
        assert.strictEqual(mcpResult.isError, false, mcpResult.text);
        assert.strictEqual(
            normalizeSurfaceGuidance(mcpResult.text.trimEnd()),
            normalizeSurfaceGuidance(cli.trimEnd()),
        );
        assert.match(cli, /function processData/);

        const findFlags = generateMcpParamSection()
            .split('\n')
            .find(line => line.trimStart().startsWith('find:'));
        assert.match(findFlags, /\blimit\b/);
        assert.match(findFlags, /\bwith_source\b/);
        assert.doesNotMatch(findFlags, /\btop\b|\bdepth\b|\ball\b/);
    });

    it('CLI and MCP reject the same ambiguous command modes', async () => {
        const cli = runCli(dir, 'impact', ['processData'], ['--staged']);
        const mcpResult = await mcp.callTool({
            command: 'impact',
            project_dir: dir,
            name: 'processData',
            staged: true,
        });
        assert.match(cli, /accepts either a symbol target or Git diff scope/);
        assert.strictEqual(mcpResult.isError, true);
        assert.match(mcpResult.text, /accepts either a symbol target or Git diff scope/);
    });

    it('tests recognizes conventional test directories for JavaScript', () => {
        const result = execute(idx(dir), 'tests', { name: 'processData' });
        assert.ok(result.ok, result.error);
        assert.ok(result.result.some(item => item.file === 'test/service-check.js'));
    });
});

describe('tiered evidence survives composition', () => {
    it('show retains ACCOUNT/CONTRACT metadata when selecting one direction', () => {
        const dir = fixture();
        try {
            const index = idx(dir);
            const execution = execute(index, 'show', {
                name: 'processData',
                sections: 'callers',
                includeTests: true,
            });
            assert.ok(execution.ok, execution.error);
            assert.ok(execution.result.context.meta.account);
            const text = formatPublicText('show', execution.result, {
                name: 'processData', sections: 'callers', includeTests: true,
            }, execution);
            assert.match(text, /ACCOUNT:/);
            assert.match(text, /CONTRACT:/);
        } finally { rm(dir); }
    });

    it('invalid section, direction, and trace target combinations fail clearly', () => {
        const dir = fixture();
        try {
            const index = idx(dir);
            assert.match(execute(index, 'show', { name: 'processData', sections: 'bogus' }).error,
                /Unknown show section/);
            assert.match(execute(index, 'trace', { name: 'processData', direction: 'sideways' }).error,
                /callees or callers/);
            assert.match(execute(index, 'trace', { name: 'processData', to: 'entrypoints' }).error,
                /requires --direction=callers/);
        } finally { rm(dir); }
    });
});

describe('rule 11: no locale-dependent ordering in shipped code', () => {
    // Output ordering is a public contract (byte-identical across runs and
    // machines). localeCompare depends on the host ICU locale, so no shipped
    // source may call it — codeUnitCompare (core/shared.js) or an inlined
    // code-unit comparison is the only accepted ordering primitive.
    it('no .localeCompare( call sites in core/cli/mcp/languages', () => {
        const roots = ['core', 'cli', 'mcp', 'languages'];
        const offenders = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules') continue;
                    walk(full);
                } else if (entry.name.endsWith('.js')) {
                    const source = fs.readFileSync(full, 'utf8');
                    if (source.includes('.localeCompare(')) offenders.push(full);
                }
            }
        };
        for (const root of roots) walk(path.join(__dirname, '..', root));
        assert.deepStrictEqual(offenders, [],
            'use codeUnitCompare (core/shared.js) instead of localeCompare');
    });
});
