'use strict';

require('./helpers/cache-root'); // isolated cache root (fix #433)
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { CANONICAL_COMMANDS } = require('../core/registry');
const {
    RELEASE_GATES,
    SCENARIOS,
    toCliInvocation,
    toMcpArguments,
    scorePlan,
    normalizeSurfaceGuidance,
    summarize,
    evaluateGates,
    formatMarkdown,
} = require('./agent-public-surface-benchmark');

describe('public-surface agent benchmark contract', () => {
    it('covers every public command and includes adversarial repeat scenarios', () => {
        assert.deepEqual(
            [...new Set(SCENARIOS.map(scenario => scenario.command))].sort(),
            [...CANONICAL_COMMANDS].sort());
        assert.ok(SCENARIOS.length > CANONICAL_COMMANDS.length);
        assert.equal(new Set(SCENARIOS.map(scenario => scenario.id)).size, SCENARIOS.length);
        assert.ok(SCENARIOS.every(scenario =>
            scenario.prompt && scenario.assertions.length > 0));
    });

    it('translates one canonical plan into CLI spelling and positional arguments', () => {
        assert.deepEqual(toCliInvocation({
            command: 'auditAsync',
            params: { file: 'src', includeTests: true, limit: 5 },
        }), {
            command: 'audit-async',
            args: [],
            flags: ['--file=src', '--include-tests', '--limit=5'],
        });
        assert.deepEqual(toCliInvocation({
            command: 'plan',
            params: { name: 'before', renameTo: 'after' },
        }), {
            command: 'plan',
            args: ['before'],
            flags: ['--rename-to=after'],
        });
    });

    it('translates the same plan into the one-tool MCP request', () => {
        assert.deepEqual(toMcpArguments('/project', {
            command: 'auditAsync',
            params: { file: 'src', includeTests: true },
        }), {
            command: 'audit_async',
            project_dir: '/project',
            file: 'src',
            include_tests: true,
        });
    });

    it('compares the same explicit or default transport budget on both surfaces', () => {
        const { parseFlags } = require('../cli/flags');
        const { normalizeParams, paramDefault, paramRange } = require('../core/registry');
        for (const command of ['repo', 'show']) {
            for (const params of [{}, { maxChars: 500 }, { max_chars: 701 }, { all: true }, { all: true, maxChars: 900 }]) {
                const call = { command, params };
                const cli = parseFlags(toCliInvocation(call).flags);
                const mcp = normalizeParams(toMcpArguments('/project', call));
                const budget = p => p.maxChars ?? (p.all ? paramRange('maxChars').max : paramDefault('maxChars', command));
                assert.equal(budget(cli), budget(mcp), JSON.stringify(call));
                assert.equal(Object.hasOwn(mcp, 'maxChars'), Object.hasOwn(cli, 'maxChars'));
            }
        }
        const a20 = SCENARIOS.find(scenario => scenario.id === 'A20');
        assert.ok(a20);
        const cli = parseFlags(toCliInvocation(a20).flags);
        const mcp = normalizeParams(toMcpArguments('/project', a20));
        assert.equal(cli.maxChars, undefined);
        assert.equal(mcp.maxChars, undefined);
        assert.equal(paramDefault('maxChars', a20.command), 3000);
    });

    it('preserves true and false booleans, including flags with only a negative spelling', () => {
        const { PARAMS, normalizeParams } = require('../core/registry');
        const { parseFlags, validateFlags } = require('../cli/flags');
        for (const [param, spec] of Object.entries(PARAMS)) {
            if (spec.type !== 'boolean') continue;
            for (const value of [true, false]) {
                const call = { command: 'show', params: { [param]: value } };
                const cli = parseFlags(toCliInvocation(call).flags);
                validateFlags(cli);
                const mcp = normalizeParams(toMcpArguments('/project', call));
                assert.equal(cli[param], mcp[param], `${param}=${value}`);
                assert.equal(cli[param], value, `${param}=${value}`);
            }
        }
        assert.deepEqual(toCliInvocation({ command: 'show', params: { followSymlinks: false } }).flags,
            ['--no-follow-symlinks']);
        assert.deepEqual(toCliInvocation({ command: 'show', params: { followSymlinks: true } }).flags,
            ['--no-follow-symlinks=false']);
    });

    it('A20 default-budget parity keeps actual native full-size and emitted-length facts', async () => {
        const path = require('path');
        const { spawnSync } = require('child_process');
        const { McpClient } = require('./helpers');
        const { paramDefault } = require('../core/registry');
        const project = path.join(__dirname, 'fixtures/agent-benchmark');
        const scenario = SCENARIOS.find(row => row.id === 'A20');
        const budget = paramDefault('maxChars', scenario.command);
        const invocation = toCliInvocation(scenario);
        const cliArgs = [path.join(__dirname, '../cli/index.js'), project,
            invocation.command, ...invocation.args, ...invocation.flags];
        const cli = spawnSync(process.execPath, cliArgs, { encoding: 'utf8' });
        assert.equal(cli.status, 0, cli.stderr);
        // Read each presentation from its own cache/session. A separate
        // fresh build can have different health-timing digits.
        const fullCli = spawnSync(process.execPath, [...cliArgs, '--max-chars=100000'], { encoding: 'utf8' });
        assert.equal(fullCli.status, 0, fullCli.stderr);
        const client = new McpClient();
        try {
            await client.start(); await client.initialize();
            const mcp = await client.callTool(toMcpArguments(project, scenario));
            assert.equal(mcp.isError, false, mcp.text);
            const fullMcp = await client.callTool({ ...toMcpArguments(project, scenario), max_chars: 100000 });
            assert.equal(fullMcp.isError, false, fullMcp.text);
            for (const [surface, text, full] of [
                ['cli', cli.stdout, fullCli.stdout.replace(/\n$/, '')],
                ['mcp', mcp.text, fullMcp.text],
            ]) {
                assert.ok(full.length > budget, `${surface}: fixture must require truncation`);
                assert.ok(text.length <= budget, `${surface}: ${text.length} > ${budget}`);
                const notice = text.match(/OUTPUT TRUNCATED: (\d+) chars total; hard limit (\d+)/);
                assert.ok(notice, text);
                assert.equal(Number(notice[1]), full.length, surface);
                assert.equal(Number(notice[2]), budget, surface);
            }
            assert.equal(normalizeSurfaceGuidance(cli.stdout.trimEnd()), normalizeSurfaceGuidance(mcp.text.trimEnd()));
        } finally { client.stop(); }
    });

    it('scores command choice and required parameters independently', () => {
        const scenario = SCENARIOS.find(row => row.command === 'plan');
        assert.deepEqual(scorePlan(scenario, {
            calls: [{
                command: 'show',
                params: { name: 'publishOrderCreated', rename_to: 'wrongName' },
            }],
        }), {
            calls: [{
                command: 'show',
                params: {
                    name: 'publishOrderCreated',
                    renameTo: 'wrongName',
                },
            }],
            selectionScore: 0,
            parameterScore: 0.5,
            toolCalls: 1,
        });
    });

    it('enforces the release workflow gates over measured executions', () => {
        const passingRows = CANONICAL_COMMANDS.map(command => ({
            expectedCommand: command,
            selectionScore: 1,
            parameterScore: 1,
            answerPassed: true,
            contractPassed: true,
            cliOk: true,
            mcpOk: true,
            parity: true,
            discoverabilityScore: 1,
            toolCalls: 1,
            cliJsonMs: 10,
            mcpMs: 2,
            estimatedOutputTokens: 100,
        }));
        const passing = summarize(passingRows);
        passing.recoveryRate = 1;
        passing.fixtureLoc = RELEASE_GATES.minFixtureLoc;
        assert.deepEqual(evaluateGates(passing), { passed: true, failures: [] });

        passingRows[0] = {
            ...passingRows[0],
            selectionScore: 0,
            answerPassed: false,
            parity: false,
            toolCalls: 4,
        };
        const failingSummary = summarize(passingRows);
        failingSummary.recoveryRate = 1;
        const failing = evaluateGates(failingSummary, RELEASE_GATES);
        assert.equal(failing.passed, false);
        assert.ok(failing.failures.some(failure => /answer accuracy/.test(failure)));
        assert.ok(failing.failures.some(failure => /parity/.test(failure)));
    });

    it('labels reference-plan scoring as conformance, not live-agent accuracy', () => {
        const markdown = formatMarkdown({
            generatedAt: 'now',
            fixtureDir: '/fixture',
            runs: 1,
            planSource: 'checked-in reference plans',
            measurementKind: 'reference-plan-contract-conformance',
            liveAgentPlans: false,
            summary: {
                commandsCovered: CANONICAL_COMMANDS.length,
                fixtureLoc: RELEASE_GATES.minFixtureLoc,
                selectionAccuracy: 1,
                parameterAccuracy: 1,
                answerAccuracy: 1,
                cliSuccessRate: 1,
                mcpSuccessRate: 1,
                parityRate: 1,
                discoverabilityRate: 1,
                contractRate: 1,
                recoveryRate: 1,
                medianAgentToolCalls: 1,
                cliJsonMsP50: 1,
                cliJsonMsP95: 1,
                mcpMsP50: 1,
                mcpMsP95: 1,
                outputTokensP50: 1,
                outputTokensP95: 1,
            },
            gate: { passed: true, failures: [] },
            recovery: { checks: [] },
            lastRun: [],
            scenarios: [],
        });
        assert.match(markdown, /reference-plan command conformance/i);
        assert.match(markdown, /not a claim about a live model/i);
        assert.doesNotMatch(markdown, /\| task-to-command selection \|/);
    });

    it('keeps trace truncation counts while normalizing native cap guidance', () => {
        const cli = '2 children truncated by the per-node cap. Use --all to expand them; --depth controls hops only.';
        const mcp = '2 children truncated by the per-node cap. Use all=true to expand them; depth controls hops only.';
        assert.equal(normalizeSurfaceGuidance(cli), normalizeSurfaceGuidance(mcp));
        assert.notEqual(normalizeSurfaceGuidance(cli.replace('2 children', '3 children')),
            normalizeSurfaceGuidance(mcp));
    });

    it('normalizes only CLI/MCP-native guidance for semantic parity', () => {
        const cli = 'ACCOUNT: 3 = 2 confirmed + 1 unverified\n' +
            'Next: ucn show run · ucn repo --sections=health --deep\n' +
            'Use --limit=N to return and display more results.\n' +
            'Use --depth=N for a deeper graph.';
        const mcp = 'ACCOUNT: 3 = 2 confirmed + 1 unverified\n' +
            'Next: command=show name=run · command=repo sections=health deep=true\n' +
            'Use limit=<n> to return and display more results.\n' +
            'Use depth=<n> for a deeper graph.';
        assert.strictEqual(normalizeSurfaceGuidance(cli), normalizeSurfaceGuidance(mcp));
        assert.notStrictEqual(
            normalizeSurfaceGuidance(cli.replace('confirmed', 'excluded')),
            normalizeSurfaceGuidance(mcp),
            'engine/trust facts remain byte-sensitive',
        );
    });
});
