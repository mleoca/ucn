#!/usr/bin/env node

/**
 * Public-surface agent benchmark.
 *
 * The original agent benchmark called ProjectIndex methods directly. That
 * measured engine primitives but skipped the command-selection, parameter,
 * transport, formatting, and token costs an agent actually experiences.
 *
 * This harness replays natural-language tasks through the public CLI and the
 * single MCP `ucn` tool. By default it uses the checked-in reference plans.
 * Pass --plans=<file> to score plans captured from a real agent without
 * changing the ground truth or execution harness.
 *
 * Usage:
 *   node test/agent-public-surface-benchmark.js
 *   node test/agent-public-surface-benchmark.js --runs=5 --gate
 *   node test/agent-public-surface-benchmark.js --plans=agent-plans.json
 *   node test/agent-public-surface-benchmark.js --tasks=A01,A02
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { CLI_PATH, McpClient, TIMEOUT_MS } = require('./helpers');
const {
    CANONICAL_COMMANDS,
    REVERSE_PARAM_MAP,
    normalizeParams,
    resolveCommand,
    toCliName,
    toMcpName,
} = require('../core/registry');
const { COMMAND_TRUST_MATRIX } = require('../core/trust-matrix');

const DEFAULT_FIXTURE = path.join(__dirname, 'fixtures', 'agent-benchmark');
const DEFAULT_JSON = path.join(__dirname, 'agent-public-surface-benchmark-report.json');
const DEFAULT_MD = path.join(__dirname, 'agent-public-surface-benchmark-report.md');

const RELEASE_GATES = Object.freeze({
    minSelectionAccuracy: 0.95,
    minParameterAccuracy: 0.95,
    minAnswerAccuracy: 1,
    minSurfaceSuccessRate: 1,
    minParityRate: 1,
    minDiscoverabilityRate: 1,
    minContractRate: 1,
    minRecoveryRate: 1,
    maxMedianAgentToolCalls: 2,
    maxOutputTokensP95: 2000,
});

const POSITIONAL_PARAM = Object.freeze({
    show: 'name',
    find: 'name',
    usages: 'name',
    search: 'term',
    source: 'name',
    trace: 'name',
    impact: 'name',
    tests: 'name',
    check: 'name',
    plan: 'name',
    deps: 'file',
    api: 'file',
    stacktrace: 'stack',
});

function assertion(label, test) {
    return { label, test };
}

function hasName(rows, name) {
    return Array.isArray(rows) && rows.some(row => row?.name === name);
}

function graphHas(graph, relativePath) {
    return Array.isArray(graph?.nodes) &&
        graph.nodes.some(node => node?.relativePath === relativePath);
}

const SCENARIOS = Object.freeze([
    {
        id: 'A01',
        prompt: 'Orient in this repository and tell me whether the index is healthy.',
        command: 'repo',
        params: { sections: 'summary,health' },
        assertions: [
            assertion('repository summary counts indexed files',
                doc => doc.data?.summary?.files >= 20),
            assertion('health classifies all public commands',
                doc => doc.data?.health?.commandTrust?.commands === 18),
            assertion('health reports no parse failures',
                doc => doc.data?.health?.blindSpots?.parseFailures?.count === 0),
        ],
    },
    {
        id: 'A02',
        prompt: 'Find the exact definition of chargeCard before I inspect it.',
        command: 'find',
        params: { name: 'chargeCard', exact: true },
        assertions: [
            assertion('find returns one exact definition',
                doc => doc.data?.length === 1),
            assertion('definition is the Stripe function',
                doc => doc.data?.[0]?.relativePath === 'src/payments/stripe.ts' &&
                    doc.data[0].startLine === 1),
        ],
    },
    {
        id: 'A03',
        prompt: 'Show chargeCard and the evidence-backed code that calls it.',
        command: 'show',
        params: { name: 'chargeCard', sections: 'summary,callers' },
        assertions: [
            assertion('show pins the requested symbol',
                doc => doc.data?.summary?.symbol?.name === 'chargeCard'),
            assertion('alias-sensitive caller resolves to processCheckout',
                doc => doc.data?.context?.callers?.some(
                    caller => caller.callerName === 'processCheckout')),
            assertion('caller account is conserved',
                doc => doc.data?.context?.meta?.account?.conserved === true),
        ],
    },
    {
        id: 'A04',
        prompt: 'List every literal code usage of chargeCard, including imports and aliases.',
        command: 'usages',
        params: { name: 'chargeCard', includeTests: true },
        assertions: [
            assertion('usages retains the import',
                doc => doc.data?.some(row => row.usageType === 'import' &&
                    row.relativePath === 'src/services/order-service.ts')),
            assertion('usages retains the alias reference',
                doc => doc.data?.some(row => row.usageType === 'reference' &&
                    row.line === 27)),
            assertion('every usage row has an explicit machine-readable kind',
                doc => doc.data?.every(row => typeof row.usageType === 'string')),
        ],
    },
    {
        id: 'A05',
        prompt: 'Search the codebase text for processRefund, excluding comments and strings.',
        command: 'search',
        params: { term: 'processRefund', codeOnly: true, includeTests: true },
        assertions: [
            assertion('search finds the definition file',
                doc => doc.data?.some(row =>
                    row.file === 'src/services/refund-service.ts')),
            assertion('search finds the test file',
                doc => doc.data?.some(row => row.file === 'tests/refund.spec.ts')),
        ],
    },
    {
        id: 'A06',
        prompt: 'Extract the exact source of chargeCard from the Stripe module.',
        command: 'source',
        params: { name: 'chargeCard', file: 'src/payments/stripe.ts' },
        assertions: [
            assertion('source returns one function body',
                doc => doc.data?.entries?.length === 1),
            assertion('source contains the nonce call',
                doc => doc.data?.entries?.[0]?.code?.includes(
                    'createNonce(orderId)')),
        ],
    },
    {
        id: 'A07',
        prompt: 'Trace one level down from processCheckout to the functions it calls.',
        command: 'trace',
        params: { name: 'processCheckout', direction: 'callees', depth: 1 },
        assertions: [
            assertion('trace is routed downward',
                doc => doc.meta?.mode === 'callees' &&
                    doc.data?.direction === 'down'),
            assertion('trace includes chargeCard',
                doc => hasName(doc.data?.tree?.children, 'chargeCard')),
            assertion('trace includes calculateTotal',
                doc => hasName(doc.data?.tree?.children, 'calculateTotal')),
        ],
    },
    {
        id: 'A08',
        prompt: 'Assess the change impact of modifying chargeCard.',
        command: 'impact',
        params: { name: 'chargeCard' },
        assertions: [
            assertion('impact finds the alias call site',
                doc => doc.data?.byFile?.some(group =>
                    group.sites?.some(site =>
                        site.callerName === 'processCheckout' && site.line === 30))),
            assertion('impact account is conserved',
                doc => doc.data?.account?.conserved === true),
            assertion('impact does not claim semantic completeness',
                doc => doc.data?.account?.contract?.semanticComplete === false),
        ],
    },
    {
        id: 'A09',
        prompt: 'Select the direct tests that exercise processRefund.',
        command: 'tests',
        params: { name: 'processRefund' },
        assertions: [
            assertion('tests selects the refund spec',
                doc => doc.data?.some(row => row.file === 'tests/refund.spec.ts')),
        ],
    },
    {
        id: 'A10',
        prompt: 'Check whether every publishOrderCreated call matches its signature.',
        command: 'check',
        params: { name: 'publishOrderCreated' },
        assertions: [
            assertion('check finds one arity mismatch',
                doc => doc.data?.mismatches === 1),
            assertion('check locates the incomplete controller call',
                doc => doc.data?.mismatchDetails?.some(detail =>
                    detail.file === 'src/api/checkout-controller.ts' &&
                    detail.line === 13)),
        ],
    },
    {
        id: 'A11',
        prompt: 'Preview renaming publishOrderCreated to emitOrderCreated without editing files.',
        command: 'plan',
        params: { name: 'publishOrderCreated', renameTo: 'emitOrderCreated' },
        assertions: [
            assertion('plan stays a preview',
                doc => doc.data?.operation === 'rename'),
            assertion('plan includes calls and imports',
                doc => doc.data?.totalChanges === 4 &&
                    doc.data?.changes?.some(change => change.isImport)),
            assertion('plan renders the requested new name',
                doc => doc.data?.after?.signature?.includes('emitOrderCreated')),
        ],
    },
    {
        id: 'A12',
        prompt: 'Show direct imports and importers of the order service.',
        command: 'deps',
        params: {
            file: 'src/services/order-service.ts',
            direction: 'both',
            depth: 1,
        },
        assertions: [
            assertion('dependency graph includes the Stripe import',
                doc => graphHas(doc.data?.graph?.imports,
                    'src/payments/stripe.ts')),
            assertion('dependency graph includes the checkout importer',
                doc => graphHas(doc.data?.graph?.importers,
                    'src/api/checkout-controller.ts')),
        ],
    },
    {
        id: 'A13',
        prompt: 'List the exported API of the Stripe payment module.',
        command: 'api',
        params: { file: 'src/payments/stripe.ts' },
        assertions: [
            assertion('API includes chargeCard',
                doc => hasName(doc.data, 'chargeCard')),
            assertion('API includes refundCard',
                doc => hasName(doc.data, 'refundCard')),
            assertion('API excludes private createNonce',
                doc => !hasName(doc.data, 'createNonce')),
        ],
    },
    {
        id: 'A14',
        prompt: 'Find HTTP entry points and their registered handlers.',
        command: 'entrypoints',
        params: { type: 'http' },
        assertions: [
            assertion('entrypoints finds listOrders',
                doc => hasName(doc.data, 'listOrders')),
            assertion('entrypoints finds refundEndpoint',
                doc => hasName(doc.data, 'refundEndpoint')),
            assertion('entrypoints label the framework as Express',
                doc => doc.data?.every(row => row.framework === 'express')),
        ],
    },
    {
        id: 'A15',
        prompt: 'Match client HTTP requests to server routes and show unmatched endpoints.',
        command: 'endpoints',
        params: { bridge: true },
        assertions: [
            assertion('endpoint inventory has two routes',
                doc => doc.meta?.totalRoutes === 2),
            assertion('bridge matches GET /orders',
                doc => doc.data?.bridges?.some(bridge =>
                    bridge.route?.path === '/orders' &&
                    bridge.request?.path === '/orders')),
            assertion('POST /refunds remains unmatched',
                doc => doc.data?.unmatchedRoutes?.some(route =>
                    route.method === 'POST' && route.path === '/refunds')),
        ],
    },
    {
        id: 'A16',
        prompt: 'Find unused internal code, but treat every result as a review candidate.',
        command: 'deadcode',
        params: {},
        assertions: [
            assertion('deadcode includes formatInternalSnapshot',
                doc => hasName(doc.data, 'formatInternalSnapshot')),
            assertion('deadcode includes experimentalFraudCheck',
                doc => hasName(doc.data, 'experimentalFraudCheck')),
        ],
    },
    {
        id: 'A17',
        prompt: 'Audit the project for async calls whose returned promise is not awaited.',
        command: 'auditAsync',
        params: {},
        assertions: [
            assertion('async audit finds one issue',
                doc => doc.data?.totalIssues === 1),
            assertion('async audit identifies processRefund',
                doc => doc.data?.issues?.some(issue =>
                    issue.file === 'src/api/http-surface.ts' &&
                    issue.calleeName === 'processRefund')),
        ],
    },
    {
        id: 'A18',
        prompt: 'Resolve this runtime frame: at refundEndpoint (src/api/http-surface.ts:12:5).',
        command: 'stacktrace',
        params: {
            stack: 'at refundEndpoint (src/api/http-surface.ts:12:5)',
        },
        assertions: [
            assertion('stack frame resolves to source',
                doc => doc.data?.frames?.[0]?.found === true),
            assertion('stack frame shows the unawaited call',
                doc => doc.data?.frames?.[0]?.code?.includes('processRefund(')),
        ],
    },
    {
        id: 'A19',
        prompt: 'Find tests for src/index.ts without mistaking unrelated local variables named index for coverage.',
        command: 'tests',
        params: { name: 'src/index.ts' },
        assertions: [
            assertion('file target does not degrade into a basename symbol scan',
                doc => Array.isArray(doc.data) && doc.data.length === 0),
            assertion('empty static selection states its runtime-coverage boundary',
                doc => doc.meta?.note?.includes('not runtime coverage evidence')),
            assertion('tests contract remains review-required',
                doc => doc.meta?.contract?.decisionSafety === 'review-required'),
        ],
    },
    {
        id: 'A20',
        prompt: 'Assess production code only, excluding tests from every repository health projection.',
        command: 'repo',
        params: { sections: 'summary,health', deep: true, exclude: 'tests' },
        assertions: [
            assertion('summary and health scan the same scoped file set',
                doc => doc.data?.summary?.files === doc.data?.health?.files?.scanned),
            assertion('excluded test directories do not leak into the summary',
                doc => doc.data?.summary?.dirs?.every(
                    entry => !entry.dir.startsWith('tests'))),
            assertion('excluded test files do not leak into blind spots',
                doc => Object.values(doc.data?.health?.blindSpots || {}).every(
                    blindSpot => !blindSpot?.files?.some(
                        file => file.startsWith('tests/')))),
        ],
    },
]);

function readArgValue(argv, key) {
    const equals = argv.find(arg => arg.startsWith(`${key}=`));
    if (equals) return equals.slice(key.length + 1);
    const index = argv.indexOf(key);
    if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
        return argv[index + 1];
    }
    return null;
}

function canonicalCommand(raw) {
    return resolveCommand(raw, 'mcp') || resolveCommand(raw, 'cli') || raw;
}

function normalizePlanCall(call) {
    return {
        command: canonicalCommand(call?.command),
        params: normalizeParams(call?.params || {}),
    };
}

function referencePlans(scenarios = SCENARIOS) {
    return Object.fromEntries(scenarios.map(scenario => [scenario.id, {
        id: scenario.id,
        calls: [{ command: scenario.command, params: scenario.params }],
    }]));
}

function loadPlans(file, scenarios = SCENARIOS) {
    if (!file) return { source: 'checked-in reference plans', plans: referencePlans(scenarios) };
    const absolute = path.resolve(file);
    const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : parsed.plans;
    if (!Array.isArray(rows)) {
        throw new Error('Agent plan file must be an array or an object with a plans array');
    }
    const plans = {};
    for (const row of rows) {
        if (!row?.id || !Array.isArray(row.calls)) continue;
        plans[row.id] = { ...row, calls: row.calls.map(normalizePlanCall) };
    }
    return { source: absolute, plans };
}

function cliFlagName(param) {
    const snake = REVERSE_PARAM_MAP[param] || param;
    return snake.replace(/_/g, '-');
}

function toCliInvocation(call) {
    const command = canonicalCommand(call.command);
    const params = normalizeParams(call.params || {});
    const positionalKey = POSITIONAL_PARAM[command];
    const args = [];
    if (positionalKey && params[positionalKey] != null) {
        args.push(String(params[positionalKey]));
    }
    const flags = [];
    for (const [key, value] of Object.entries(params)) {
        if (key === positionalKey || value == null || value === false) continue;
        const flag = `--${cliFlagName(key)}`;
        if (value === true) flags.push(flag);
        else if (Array.isArray(value)) flags.push(`${flag}=${value.join(',')}`);
        else flags.push(`${flag}=${value}`);
    }
    return { command: toCliName(command), args, flags };
}

function toMcpArguments(projectDir, call) {
    const params = normalizeParams(call.params || {});
    const encoded = {};
    for (const [key, value] of Object.entries(params)) {
        encoded[REVERSE_PARAM_MAP[key] || key] = value;
    }
    return {
        command: toMcpName(canonicalCommand(call.command)),
        project_dir: projectDir,
        max_chars: 100000,
        ...encoded,
    };
}

function elapsedMs(started) {
    return Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(2));
}

function runCli(projectDir, call, json) {
    const invocation = toCliInvocation(call);
    const argv = [
        CLI_PATH,
        projectDir,
        invocation.command,
        ...invocation.args,
        ...invocation.flags,
        ...(json ? ['--json'] : []),
    ];
    const started = process.hrtime.bigint();
    const result = spawnSync(process.execPath, argv, {
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
        ok: result.status === 0 && !result.error,
        status: result.status,
        ms: elapsedMs(started),
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error?.message || null,
        argv: argv.slice(1),
    };
}

async function runMcp(client, projectDir, call) {
    const started = process.hrtime.bigint();
    const result = await client.callTool(toMcpArguments(projectDir, call));
    return {
        ok: !result.error && result.isError !== true,
        ms: elapsedMs(started),
        text: result.text || '',
        error: result.error || null,
    };
}

function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function scorePlan(scenario, plan) {
    const calls = Array.isArray(plan?.calls) ? plan.calls.map(normalizePlanCall) : [];
    const first = calls[0] || { command: null, params: {} };
    const selectionScore = first.command === scenario.command ? 1 : 0;
    const expectedEntries = Object.entries(scenario.params || {});
    const correctParams = expectedEntries.filter(([key, value]) =>
        deepEqual(first.params[key], value)).length;
    const parameterScore = expectedEntries.length === 0
        ? 1
        : correctParams / expectedEntries.length;
    return {
        calls,
        selectionScore,
        parameterScore: Number(parameterScore.toFixed(4)),
        toolCalls: calls.length,
    };
}

function scoreAssertions(scenario, document) {
    const failures = [];
    for (const check of scenario.assertions) {
        try {
            if (!check.test(document)) failures.push(check.label);
        } catch (error) {
            failures.push(`${check.label} (${error.message})`);
        }
    }
    return {
        passed: failures.length === 0,
        total: scenario.assertions.length,
        passedCount: scenario.assertions.length - failures.length,
        failures,
    };
}

function scoreContract(scenario, document) {
    const contract = document?.meta?.contract;
    const expectedSafety = COMMAND_TRUST_MATRIX[scenario.command]?.decisionSafety;
    return !!contract &&
        typeof contract.question === 'string' && contract.question.length > 0 &&
        typeof contract.truth === 'string' && contract.truth.length > 0 &&
        Array.isArray(contract.next) &&
        contract.decisionSafety === expectedSafety;
}

function discoverabilityScore(description, scenario) {
    const commandName = toMcpName(scenario.command);
    const commandVisible = description.includes(`  ${commandName}:`);
    const params = Object.keys(scenario.params || {}).map(
        key => REVERSE_PARAM_MAP[key] || key);
    const visibleParams = params.filter(param => description.includes(param)).length;
    const paramScore = params.length === 0 ? 1 : visibleParams / params.length;
    return Number(((Number(commandVisible) + paramScore) / 2).toFixed(4));
}

async function runScenario(client, projectDir, scenario, plan, toolDescription) {
    const planScore = scorePlan(scenario, plan);
    const call = planScore.calls[0];
    if (!call) {
        return {
            id: scenario.id,
            prompt: scenario.prompt,
            expectedCommand: scenario.command,
            selectedCommand: null,
            selectionScore: 0,
            parameterScore: 0,
            toolCalls: 0,
            answerPassed: false,
            contractPassed: false,
            assertionFailures: ['agent plan contains no tool call'],
            cliOk: false,
            mcpOk: false,
            parity: false,
            discoverabilityScore: discoverabilityScore(toolDescription, scenario),
        };
    }

    const cliJson = runCli(projectDir, call, true);
    const cliText = runCli(projectDir, call, false);
    const mcp = await runMcp(client, projectDir, call);
    let document = null;
    let parseError = null;
    if (cliJson.ok) {
        try {
            document = JSON.parse(cliJson.stdout);
        } catch (error) {
            parseError = error.message;
        }
    }
    const assertions = document
        ? scoreAssertions(scenario, document)
        : {
            passed: false,
            failures: [
                parseError
                    ? `CLI JSON parse failed: ${parseError}`
                    : `CLI JSON execution failed: ${cliJson.stderr || cliJson.error || cliJson.status}`,
            ],
        };
    const contractPassed = scoreContract(scenario, document);
    const parity = cliText.ok && mcp.ok &&
        cliText.stdout.trimEnd() === mcp.text.trimEnd();

    return {
        id: scenario.id,
        prompt: scenario.prompt,
        expectedCommand: scenario.command,
        selectedCommand: call.command,
        selectedParams: call.params,
        selectionScore: planScore.selectionScore,
        parameterScore: planScore.parameterScore,
        toolCalls: planScore.toolCalls,
        answerPassed: assertions.passed,
        contractPassed,
        assertionFailures: assertions.failures,
        cliOk: cliJson.ok && cliText.ok && !!document,
        mcpOk: mcp.ok,
        parity,
        discoverabilityScore: discoverabilityScore(toolDescription, scenario),
        cliJsonMs: cliJson.ms,
        cliTextMs: cliText.ms,
        mcpMs: mcp.ms,
        outputChars: mcp.text.length,
        estimatedOutputTokens: Math.ceil(mcp.text.length / 4),
        cliError: cliJson.ok && cliText.ok
            ? null
            : (cliJson.stderr || cliText.stderr || cliJson.error || cliText.error),
        mcpError: mcp.error,
    };
}

async function runRecoveryChecks(client, projectDir) {
    const typo = runCli(projectDir, { command: 'shwo', params: {} }, false);
    const missingCliTarget = runCli(projectDir, { command: 'show', params: {} }, false);
    const missingMcpTarget = await runMcp(client, projectDir, {
        command: 'show',
        params: {},
    });
    const ignoredMcpParam = await runMcp(client, projectDir, {
        command: 'find',
        params: { name: 'chargeCard', depth: 3 },
    });
    const checks = [
        {
            label: 'CLI typo offers one correction',
            passed: !typo.ok && /Did you mean "show"\?/.test(typo.stderr),
        },
        {
            label: 'CLI missing target names the required input',
            passed: !missingCliTarget.ok && /Symbol name is required/.test(missingCliTarget.stderr),
        },
        {
            label: 'MCP missing target names the required input',
            passed: !missingMcpTarget.ok &&
                /Symbol name is required/.test(missingMcpTarget.text || missingMcpTarget.error || ''),
        },
        {
            label: 'MCP ignored parameter remains explicit',
            passed: ignoredMcpParam.ok &&
                /depth ignored \(not applicable to find\)/.test(ignoredMcpParam.text),
        },
    ];
    return {
        rate: rate(checks.map(check => Number(check.passed))),
        checks,
    };
}

function rate(values) {
    if (!values.length) return 0;
    return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

function percentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(results) {
    return {
        taskExecutions: results.length,
        commandsCovered: new Set(results.map(result => result.expectedCommand)).size,
        selectionAccuracy: rate(results.map(result => result.selectionScore)),
        parameterAccuracy: rate(results.map(result => result.parameterScore)),
        answerAccuracy: rate(results.map(result => Number(result.answerPassed))),
        cliSuccessRate: rate(results.map(result => Number(result.cliOk))),
        mcpSuccessRate: rate(results.map(result => Number(result.mcpOk))),
        parityRate: rate(results.map(result => Number(result.parity))),
        discoverabilityRate: rate(results.map(result => result.discoverabilityScore)),
        contractRate: rate(results.map(result => Number(result.contractPassed))),
        medianAgentToolCalls: percentile(results.map(result => result.toolCalls), 0.50),
        p95AgentToolCalls: percentile(results.map(result => result.toolCalls), 0.95),
        cliJsonMsP50: percentile(results.map(result => result.cliJsonMs || 0), 0.50),
        cliJsonMsP95: percentile(results.map(result => result.cliJsonMs || 0), 0.95),
        mcpMsP50: percentile(results.map(result => result.mcpMs || 0), 0.50),
        mcpMsP95: percentile(results.map(result => result.mcpMs || 0), 0.95),
        outputTokensP50: percentile(
            results.map(result => result.estimatedOutputTokens || 0), 0.50),
        outputTokensP95: percentile(
            results.map(result => result.estimatedOutputTokens || 0), 0.95),
    };
}

function evaluateGates(summary, gates = RELEASE_GATES) {
    const failures = [];
    const floors = [
        ['selectionAccuracy', gates.minSelectionAccuracy, 'selection accuracy'],
        ['parameterAccuracy', gates.minParameterAccuracy, 'parameter accuracy'],
        ['answerAccuracy', gates.minAnswerAccuracy, 'answer accuracy'],
        ['cliSuccessRate', gates.minSurfaceSuccessRate, 'CLI success rate'],
        ['mcpSuccessRate', gates.minSurfaceSuccessRate, 'MCP success rate'],
        ['parityRate', gates.minParityRate, 'CLI/MCP parity rate'],
        ['discoverabilityRate', gates.minDiscoverabilityRate, 'discoverability rate'],
        ['contractRate', gates.minContractRate, 'answer-contract rate'],
        ['recoveryRate', gates.minRecoveryRate, 'failure-recovery rate'],
    ];
    for (const [field, floor, label] of floors) {
        if (summary[field] < floor) {
            failures.push(`${label} ${summary[field]} < ${floor}`);
        }
    }
    if (summary.medianAgentToolCalls > gates.maxMedianAgentToolCalls) {
        failures.push(`median agent tool calls ${summary.medianAgentToolCalls} ` +
            `> ${gates.maxMedianAgentToolCalls}`);
    }
    if (summary.outputTokensP95 > gates.maxOutputTokensP95) {
        failures.push(`output tokens p95 ${summary.outputTokensP95} ` +
            `> ${gates.maxOutputTokensP95}`);
    }
    if (summary.commandsCovered !== CANONICAL_COMMANDS.length) {
        failures.push(`public command coverage ${summary.commandsCovered}/${CANONICAL_COMMANDS.length}`);
    }
    return { passed: failures.length === 0, failures };
}

function formatMarkdown(report) {
    const summary = report.summary;
    const lines = [
        '# UCN public-surface agent benchmark',
        '',
        `Generated: ${report.generatedAt}`,
        `Fixture: ${report.fixtureDir}`,
        `Runs: ${report.runs}`,
        `Plan source: ${report.planSource}`,
        '',
        '> The checked-in reference plan validates the public execution and scoring',
        '> contract. It is not a claim about a live model. Use `--plans=<file>` with',
        '> captured agent plans to measure real command and parameter selection.',
        '',
        '## Summary',
        '',
        '| metric | result | gate |',
        '|---|---:|---:|',
        `| public commands covered | ${summary.commandsCovered}/${CANONICAL_COMMANDS.length} | ${CANONICAL_COMMANDS.length}/${CANONICAL_COMMANDS.length} |`,
        `| task-to-command selection | ${summary.selectionAccuracy} | ≥ ${RELEASE_GATES.minSelectionAccuracy} |`,
        `| parameter accuracy | ${summary.parameterAccuracy} | ≥ ${RELEASE_GATES.minParameterAccuracy} |`,
        `| answer accuracy | ${summary.answerAccuracy} | ${RELEASE_GATES.minAnswerAccuracy} |`,
        `| CLI success | ${summary.cliSuccessRate} | ${RELEASE_GATES.minSurfaceSuccessRate} |`,
        `| MCP success | ${summary.mcpSuccessRate} | ${RELEASE_GATES.minSurfaceSuccessRate} |`,
        `| CLI/MCP text parity | ${summary.parityRate} | ${RELEASE_GATES.minParityRate} |`,
        `| command/parameter discoverability | ${summary.discoverabilityRate} | ${RELEASE_GATES.minDiscoverabilityRate} |`,
        `| answer contract | ${summary.contractRate} | ${RELEASE_GATES.minContractRate} |`,
        `| failure recovery | ${summary.recoveryRate} | ${RELEASE_GATES.minRecoveryRate} |`,
        `| median agent tool calls | ${summary.medianAgentToolCalls} | ≤ ${RELEASE_GATES.maxMedianAgentToolCalls} |`,
        `| CLI JSON latency p50/p95 | ${summary.cliJsonMsP50}/${summary.cliJsonMsP95} ms | report-only |`,
        `| warm MCP latency p50/p95 | ${summary.mcpMsP50}/${summary.mcpMsP95} ms | report-only |`,
        `| output tokens p50/p95 | ${summary.outputTokensP50}/${summary.outputTokensP95} | p95 ≤ ${RELEASE_GATES.maxOutputTokensP95} |`,
        '',
        `Gate: **${report.gate.passed ? 'PASS' : 'FAIL'}**`,
    ];
    if (report.gate.failures.length) {
        for (const failure of report.gate.failures) lines.push(`- ${failure}`);
    }
    lines.push('', '## Recovery checks', '');
    for (const check of report.recovery?.checks || []) {
        lines.push(`- ${check.passed ? 'PASS' : 'FAIL'} — ${check.label}`);
    }
    lines.push('', '## Task results', '');
    lines.push('| id | task | expected → selected | params | answer | contract | CLI | MCP | parity | calls | tokens |');
    lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const result of report.lastRun) {
        lines.push(`| ${result.id} | ${result.prompt} | ${result.expectedCommand} → ${result.selectedCommand || 'none'} | ${result.parameterScore} | ${result.answerPassed ? 'pass' : 'fail'} | ${result.contractPassed ? 'pass' : 'fail'} | ${result.cliOk ? 'pass' : 'fail'} | ${result.mcpOk ? 'pass' : 'fail'} | ${result.parity ? 'pass' : 'fail'} | ${result.toolCalls} | ${result.estimatedOutputTokens || 0} |`);
        for (const failure of result.assertionFailures || []) {
            lines.push(`|  | ↳ assertion | ${failure} |  |  |  |  |  |  |  |  |`);
        }
    }
    lines.push('', '## Task corpus', '');
    for (const scenario of report.scenarios) {
        lines.push(`- **${scenario.id} — ${scenario.command}:** ${scenario.prompt}`);
    }
    lines.push('');
    return lines.join('\n');
}

async function runBenchmark(options = {}) {
    const scenarios = options.scenarios || SCENARIOS;
    const fixtureDir = path.resolve(options.fixtureDir || DEFAULT_FIXTURE);
    if (!fs.existsSync(fixtureDir)) throw new Error(`Fixture not found: ${fixtureDir}`);
    const loadedPlans = options.loadedPlans || loadPlans(options.plansFile, scenarios);
    const runs = options.runs || 3;
    const allResults = [];
    let toolMetadata = null;
    let recovery = null;

    for (let run = 1; run <= runs; run++) {
        const client = new McpClient();
        try {
            await client.start();
            await client.initialize();
            const listed = await client.send('tools/list', {});
            const tools = listed.result?.tools || [];
            const tool = tools.find(candidate => candidate.name === 'ucn');
            if (!tool) throw new Error('MCP did not publish the ucn tool');
            toolMetadata = {
                toolCount: tools.length,
                name: tool.name,
                descriptionChars: tool.description?.length || 0,
                commandEnum: tool.inputSchema?.properties?.command?.enum || [],
            };
            for (const scenario of scenarios) {
                const plan = loadedPlans.plans[scenario.id];
                const result = await runScenario(
                    client, fixtureDir, scenario, plan, tool.description || '');
                allResults.push({ run, ...result });
            }
            if (run === 1) recovery = await runRecoveryChecks(client, fixtureDir);
        } finally {
            client.stop();
        }
    }

    const summary = summarize(allResults);
    summary.recoveryRate = recovery?.rate || 0;
    const gate = evaluateGates(summary);
    if (toolMetadata?.toolCount !== 1) {
        gate.passed = false;
        gate.failures.push(`MCP publishes ${toolMetadata?.toolCount || 0} tools instead of 1`);
    }
    if (!deepEqual(toolMetadata?.commandEnum, CANONICAL_COMMANDS.map(toMcpName))) {
        gate.passed = false;
        gate.failures.push('MCP command enum does not match the 18-command registry');
    }
    return {
        schemaVersion: 3,
        generatedAt: new Date().toISOString(),
        fixtureDir,
        runs,
        planSource: loadedPlans.source,
        gates: RELEASE_GATES,
        gate,
        tool: toolMetadata,
        recovery,
        scenarios: scenarios.map(scenario => ({
            id: scenario.id,
            prompt: scenario.prompt,
            command: scenario.command,
            params: scenario.params,
            assertions: scenario.assertions.map(check => check.label),
        })),
        summary,
        results: allResults,
        lastRun: allResults.filter(result => result.run === runs),
    };
}

async function main() {
    const args = process.argv.slice(2);
    const runsRaw = readArgValue(args, '--runs');
    const runs = runsRaw == null ? 3 : Number(runsRaw);
    if (!Number.isInteger(runs) || runs < 1) {
        throw new Error(`--runs must be a positive integer (got ${runsRaw})`);
    }
    const taskFilter = readArgValue(args, '--tasks');
    const selected = taskFilter
        ? new Set(taskFilter.split(',').map(value => value.trim()).filter(Boolean))
        : null;
    const scenarios = selected
        ? SCENARIOS.filter(scenario => selected.has(scenario.id))
        : SCENARIOS;
    if (selected && scenarios.length !== selected.size) {
        const known = new Set(SCENARIOS.map(scenario => scenario.id));
        const unknown = [...selected].filter(id => !known.has(id));
        throw new Error(`Unknown task id(s): ${unknown.join(', ')}`);
    }

    const fixtureDir = readArgValue(args, '--fixture') || DEFAULT_FIXTURE;
    const jsonPath = path.resolve(readArgValue(args, '--json') || DEFAULT_JSON);
    const mdPath = path.resolve(readArgValue(args, '--md') || DEFAULT_MD);
    const plansFile = readArgValue(args, '--plans');
    const report = await runBenchmark({
        fixtureDir,
        runs,
        plansFile,
        scenarios,
    });
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(mdPath, formatMarkdown(report));

    process.stdout.write('Public-surface agent benchmark complete.\n');
    process.stdout.write(`  JSON: ${jsonPath}\n`);
    process.stdout.write(`  MD:   ${mdPath}\n`);
    process.stdout.write(`  selection=${report.summary.selectionAccuracy} ` +
        `parameters=${report.summary.parameterAccuracy} ` +
        `answers=${report.summary.answerAccuracy} ` +
        `contracts=${report.summary.contractRate} ` +
        `recovery=${report.summary.recoveryRate} ` +
        `parity=${report.summary.parityRate} ` +
        `median_calls=${report.summary.medianAgentToolCalls}\n`);
    process.stdout.write(`  gate=${report.gate.passed ? 'PASS' : 'FAIL'}\n`);
    if (report.gate.failures.length) {
        for (const failure of report.gate.failures) {
            process.stdout.write(`    - ${failure}\n`);
        }
    }
    if (args.includes('--gate') && !report.gate.passed) process.exitCode = 1;
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    RELEASE_GATES,
    SCENARIOS,
    canonicalCommand,
    toCliInvocation,
    toMcpArguments,
    scorePlan,
    summarize,
    evaluateGates,
    formatMarkdown,
    runBenchmark,
};
