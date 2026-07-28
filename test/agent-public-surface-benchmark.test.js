'use strict';

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
            max_chars: 100000,
            file: 'src',
            include_tests: true,
        });
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

    it('normalizes only CLI/MCP-native guidance for semantic parity', () => {
        const cli = 'ACCOUNT: 3 = 2 confirmed + 1 unverified\n' +
            'Next: ucn show run · ucn repo --sections=health --deep\n' +
            'Use --limit=N to return and display more results.';
        const mcp = 'ACCOUNT: 3 = 2 confirmed + 1 unverified\n' +
            'Next: command=show name=run · command=repo sections=health deep=true\n' +
            'Use limit=<n> to return and display more results.';
        assert.strictEqual(normalizeSurfaceGuidance(cli), normalizeSurfaceGuidance(mcp));
        assert.notStrictEqual(
            normalizeSurfaceGuidance(cli.replace('confirmed', 'excluded')),
            normalizeSurfaceGuidance(mcp),
            'engine/trust facts remain byte-sensitive',
        );
    });
});
