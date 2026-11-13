'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const { CANONICAL_COMMANDS } = require('../core/registry');
const { tmp, rm, idx } = require('./helpers');
const { execute } = require('../core/execute');
const { formatDoctor, formatDoctorJson } = require('../core/output');
const {
    PROOF_CATALOG,
    COMMAND_TRUST_MATRIX,
    summarizeCommandTrust,
} = require('../core/trust-matrix');

const ROOT = path.join(__dirname, '..');
const { REPOS, RELEASE_REPO_NAMES, RELEASE_REPOS } = require('../eval/lib/repos');

// The gates the Eval workflow qualifies on its own runners on every trigger.
// The release gate takes all of them or none, each exactly as qualified.
const MATRIX_COMMANDS = [
    'node eval/run-deletion-matrix.js',
    'node eval/run-check-matrix.js',
    'node eval/run-test-unit-matrix.js',
];
const QUALIFIED_COMMANDS = [...MATRIX_COMMANDS, 'node eval/run-outcome-eval.js --gate'];
const MATRIX_RUNNER = /eval\/run-(?:deletion|check|test-unit)-matrix\.js/;
const QUALIFIED_RUNNER = /eval\/run-(?:(?:deletion|check|test-unit)-matrix|outcome-eval)\.js/;
const TOOLCHAIN_ACTION = './.github/actions/matrix-toolchains';
// The test-unit matrix alone starts a test runner about two thousand times.
const MATRIX_MINUTES = 120;
const EVAL_TRIGGERS = [['schedule', false], ['workflow_dispatch', false], ['workflow_dispatch', true]];

// This guard accepts a small command language, not arbitrary shell programs:
// literal node commands and npm run aliases joined by &&. Only terminal node
// commands may receive npm's literal `--` arguments. Other gate-bearing forms
// fail closed; unrelated installer/upload shell blocks stay opaque.
const NPM_RUN = /\bnpm\b[^\n;&|]*\brun(?:-script)?\b/;
const LITERAL_WORD = /^[A-Za-z0-9_./:@%+=,-]+$/;

function relevantCommands(text) {
    return QUALIFIED_RUNNER.test(text) || /\btrust:gate\b/.test(text) || NPM_RUN.test(text);
}

/** Scalar conditions are deliberately limited to bare GitHub expressions. */
function workflowCondition(value) {
    if (value === null) return null;
    value = value.trim();
    assert.ok(!/^["']/.test(value), `quoted workflow condition is unsupported: ${value}`);
    return value.match(/^\$\{\{ (.+) \}\}$/)?.[1] ?? value;
}

/** One step of a workflow job: its condition, the action it uses, the commands it runs. */
function workflowStep(text) {
    const field = name => text.match(new RegExp(`(?:^|\\n {8})${name}: (.*)`))?.[1] ?? null;
    let script = field('run') ?? '';
    const block = text.match(/(?:^|\n {8})run: [|>][+-]?\n/);
    if (block) {
        const lines = [];
        for (const line of text.slice(block.index + block[0].length).split('\n')) {
            if (line !== '' && !line.startsWith(' '.repeat(10))) break;
            lines.push(line);
        }
        script = lines.join('\n');
    }
    const condition = field('if');
    return {
        id: field('id'),
        uses: field('uses'),
        condition: workflowCondition(condition),
        continueOnError: field('continue-on-error'),
        commands: script.trim() ? [script.trim()] : [],
    };
}

/** The jobs of a workflow file, each with its time limit and its steps in order. */
function workflowJobs(text) {
    const start = text.indexOf('\njobs:\n');
    assert.ok(start >= 0, 'a workflow declares jobs');
    const jobs = new Map();
    for (const part of text.slice(start + '\njobs:'.length).split(/\n {2}(?=[\w-]+:\n)/).slice(1)) {
        const name = part.slice(0, part.indexOf(':'));
        const stepsAt = part.indexOf('\n    steps:\n');
        assert.ok(stepsAt >= 0, `job ${name} declares steps`);
        const steps = part.slice(stepsAt + '\n    steps:'.length).split(/\n {6}- /).slice(1).map(workflowStep);
        assert.ok(steps.length > 0, `job ${name} has steps`);
        const head = part.slice(0, stepsAt);
        jobs.set(name, {
            timeout: head.match(/\n {4}timeout-minutes: (.+)/)?.[1] ?? null,
            needs: head.match(/\n {4}needs: (.+)/)?.[1] ?? null,
            condition: workflowCondition(head.match(/\n {4}if: (.+)/)?.[1] ?? null),
            continueOnError: head.match(/\n {4}continue-on-error: (.+)/)?.[1] ?? null,
            steps,
        });
    }
    assert.ok(jobs.size > 0, 'a workflow has jobs');
    return jobs;
}

/** The commands a step ends up running once every `npm run <script>` is followed. */
function leafCommands(commands, scripts, stack = [], enforced = false) {
    const leaves = [];
    for (const text of commands) {
        if (!enforced && !relevantCommands(text)) {
            leaves.push(text);
            continue;
        }
        // Never discard an operator: || can skip a gate or swallow its failure;
        // newlines/semicolon/background/pipelines need shell semantics we do not model.
        const chain = text.split('&&');
        assert.ok(chain.every(command => command.trim()) &&
            !/[\n\r;&|]/.test(chain.join('')), `unsupported gate command syntax: ${text}`);
        for (const part of chain) {
            const words = part.trim().split(/[ \t]+/);
            assert.ok(words.every(word => LITERAL_WORD.test(word)), `unsupported gate command syntax: ${part}`);
            if (words[0] === 'npm') {
                assert.ok(['run', 'run-script'].includes(words[1]) && /^[\w:.-]+$/.test(words[2] || ''),
                    `unsupported npm gate invocation: ${part}`);
                const script = words[2];
                const tail = words.slice(3);
                assert.ok(tail.length === 0 || tail[0] === '--', `unsupported npm gate arguments: ${part}`);
                assert.ok(Object.hasOwn(scripts, script) && typeof scripts[script] === 'string' && scripts[script].trim(),
                    `unknown or empty gate script: ${script}`);
                assert.ok(!stack.includes(script), `cyclic gate script: ${[...stack, script].join(' -> ')}`);
                let body = scripts[script];
                const args = tail.slice(1);
                if (args.length) {
                    // npm appends arguments to its script text, which is not the
                    // same as forwarding them to every child of a composite alias.
                    assert.ok(!body.includes('&&') && !NPM_RUN.test(body),
                        `cannot forward arguments through a composite gate script: ${script}`);
                    body += ` ${args.join(' ')}`;
                }
                leaves.push(...leafCommands([body], scripts, [...stack, script],
                    enforced || script === 'trust:gate' || script.startsWith('trust:gate:') || args.length > 0));
            } else {
                let executable = 0;
                while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[executable] || '')) executable++;
                assert.strictEqual(words[executable], 'node', `unsupported gate executable: ${part}`);
                assert.ok(words.length > executable + 1, `node gate has no script: ${part}`);
                leaves.push(words.join(' '));
            }
        }
    }
    return leaves;
}

/** Qualification and publishing use the default dependency-success condition. */
function assertRequiredJob(label, job) {
    assert.ok(job, `${label} exists`);
    assert.strictEqual(job.condition, null, `${label} must not override its dependency-success condition`);
    assert.strictEqual(job.continueOnError, null, `${label} must fail when a gate fails`);
}

/** Does this step run for this planned row, every earlier step having succeeded? */
function stepActive(step, context) {
    if (step.condition === null) return true;
    return Boolean(vm.runInNewContext(step.condition, {
        github: { event_name: context.event }, inputs: { full: context.full }, matrix: context.row,
        steps: { dependencies: { outcome: 'success' } },
        cancelled: () => false, failure: () => false, success: () => true, always: () => true,
    }));
}

/** A job's time limit in minutes for a planned row; null when the job sets none. */
function jobMinutes(job, context) {
    if (job.timeout === null) return null;
    const expression = job.timeout.match(/^\$\{\{ (.+) \}\}$/)?.[1] ?? job.timeout;
    const minutes = vm.runInNewContext(expression, { matrix: context.row });
    assert.ok(Number.isInteger(minutes) && minutes > 0 && minutes <= 360, `time limit ${job.timeout} gives ${minutes}`);
    return minutes;
}

/**
 * Wherever a job runs a matrix, the toolchain action has run earlier in that
 * same job and the job's time limit leaves the matrices their time.
 */
function assertMatricesProvided(label, job, scripts, contexts) {
    for (const context of contexts) {
        const where = context.row ? `${label} (${context.event}, ${context.row.id})` : label;
        const minutes = jobMinutes(job, context);
        const runsAt = job.steps.findIndex(step =>
            leafCommands(step.commands, scripts).some(command => MATRIX_RUNNER.test(command)) && stepActive(step, context));
        if (runsAt < 0) continue;
        assert.ok(job.steps.slice(0, runsAt).some(step => step.uses === TOOLCHAIN_ACTION && stepActive(step, context)),
            `${where} runs a matrix without installing its toolchains first`);
        assert.ok(minutes === null || minutes >= MATRIX_MINUTES,
            `${where} runs a matrix under a ${minutes}-minute limit`);
    }
}

/** A qualified gate is run exactly as the Eval workflow qualifies it, never a variant. */
function assertQualifiedWhole(label, commands) {
    assert.deepStrictEqual(
        commands.filter(command => QUALIFIED_RUNNER.test(command) && !QUALIFIED_COMMANDS.includes(command)), [],
        `${label} runs a qualified gate other than as qualified`);
}

/** The release gate holds every qualified gate or none of them. */
function assertEnrolledTogether(label, commands) {
    const missing = QUALIFIED_COMMANDS.filter(command => !commands.includes(command));
    assert.ok(missing.length === 0 || missing.length === QUALIFIED_COMMANDS.length,
        `${label} holds some of the qualified gates and not: ${missing.join(', ')}`);
}

describe('command trust matrix: fail-closed proof coverage', () => {
    it('keeps forwarded arguments and failure behavior in gate command expansion', () => {
        const scripts = {
            'trust:gate': 'npm run checks && npm run outcome -- --gate',
            checks: MATRIX_COMMANDS.join(' && '),
            check: MATRIX_COMMANDS[1],
            outcome: 'node eval/run-outcome-eval.js',
            alias: 'npm run check',
        };
        const judge = text => {
            const block = `run: |\n${text.split('\n').map(line => `          ${line}`).join('\n')}`;
            const commands = leafCommands(workflowStep(block).commands, scripts);
            assertQualifiedWhole('regression', commands);
            return commands;
        };
        assert.deepStrictEqual(judge('npm run trust:gate'), QUALIFIED_COMMANDS);
        assert.deepStrictEqual(judge('npm run-script alias'), [MATRIX_COMMANDS[1]]);
        assert.deepStrictEqual(judge('npm run check && npm run check'), [MATRIX_COMMANDS[1], MATRIX_COMMANDS[1]]);
        for (const args of ['--only ts-', '--allow-missing', '--pin', '--repo websocket']) {
            assert.throws(() => judge(`npm run check -- ${args}`), /other than as qualified/);
        }
        for (const text of [
            'npm run trust:gate || true', 'true || npm run trust:gate',
            'npm run trust:gate; true', 'npm run trust:gate | cat', 'npm run trust:gate &',
            'npm run trust:gate\ntrue', 'exit 0 && npm run trust:gate', 'exec true && npm run trust:gate',
            'npm --prefix elsewhere run trust:gate', 'npm run --if-present absent',
            'npm run check --allow-missing', 'npm run alias -- --only ts-',
        ]) assert.throws(() => judge(text), /unsupported|cannot forward/, text);
        for (const suffix of [' || true', '; true', '\ntrue']) {
            assert.throws(() => leafCommands(['npm run trust:gate'], {
                ...scripts, 'trust:gate': scripts['trust:gate'] + suffix,
            }), /unsupported gate command syntax/);
        }
        assert.throws(() => judge('npm run absent'), /unknown or empty/);
        assert.throws(() => leafCommands(['npm run trust:gate'], { 'trust:gate': 'npm run trust:gate' }), /cyclic/);
        assert.throws(() => leafCommands(['npm run trust:gate'], { 'trust:gate': '' }), /unknown or empty/);
        const installer = 'if command -v compiler; then echo "already installed"; else install compiler; fi';
        assert.deepStrictEqual(leafCommands([installer], scripts), [installer]);
    });

    it('keeps required workflow jobs blocking and refuses ambiguous condition scalars', () => {
        const read = head => workflowJobs(`name: test\njobs:\n  test:\n${head}    steps:\n      - run: npm run trust:gate\n`).get('test');
        assertRequiredJob('test', read(''));
        for (const condition of ['always()', 'false', '${{ always() }}']) {
            assert.throws(() => assertRequiredJob('test', read(`    if: ${condition}\n`)), /dependency-success/);
        }
        assert.throws(() => assertRequiredJob('test', read('    continue-on-error: true\n')), /must fail/);
        assert.throws(() => workflowStep("uses: example\n        if: 'false'"), /quoted workflow condition/);
        assert.throws(() => workflowStep("uses: example\n        if:    'false'"), /quoted workflow condition/);
        assert.strictEqual(stepActive(workflowStep('uses: example\n        if: false'), {}), false);
        assert.strictEqual(stepActive(workflowStep("uses: example\n        if: ${{ 'false' }}"), {}), true);
    });

    it('classifies every canonical command exactly once', () => {
        const canonical = [...CANONICAL_COMMANDS].sort();
        const classified = Object.keys(COMMAND_TRUST_MATRIX).sort();
        assert.deepStrictEqual(classified, canonical,
            'adding/removing a command requires an explicit trust-matrix decision');
    });

    it('references only registered, existing proof artifacts', () => {
        for (const [command, spec] of Object.entries(COMMAND_TRUST_MATRIX)) {
            assert.ok(spec.claim, `${command}: claim is required`);
            assert.ok(spec.performanceClass, `${command}: performance class is required`);
            assert.ok(spec.decisionSafety, `${command}: decision safety is required`);
            assert.ok(Array.isArray(spec.proofs) && spec.proofs.length > 0,
                `${command}: at least one falsifiable proof is required`);
            assert.ok(spec.proofs.includes('surface-parity'),
                `${command}: all public commands require three-surface parity proof`);
            for (const proofId of spec.proofs) {
                const proof = PROOF_CATALOG[proofId];
                assert.ok(proof, `${command}: unknown proof ${proofId}`);
                assert.ok(fs.existsSync(path.join(ROOT, proof.artifact)),
                    `${command}: proof artifact missing: ${proof.artifact}`);
            }
        }
    });

    it('keeps high-risk semantic commands on an external oracle', () => {
        const required = [
            'show', 'find', 'usages', 'source', 'trace', 'impact', 'tests',
            'check', 'plan', 'deadcode',
        ];
        for (const command of required) {
            const spec = COMMAND_TRUST_MATRIX[command];
            assert.ok(spec.proofs.some(id => PROOF_CATALOG[id].kind === 'external-oracle'),
                `${command}: high-risk semantic claim must be externally oracle-backed`);
        }
    });

    it('labels destructive or heuristic outputs review-only/advisory', () => {
        for (const command of ['deadcode', 'entrypoints', 'endpoints', 'auditAsync', 'stacktrace']) {
            assert.strictEqual(COMMAND_TRUST_MATRIX[command].decisionSafety, 'advisory-only',
                `${command}: must not imply autonomous safety`);
        }
        for (const command of ['show', 'trace', 'impact', 'tests', 'plan', 'check', 'api']) {
            assert.strictEqual(COMMAND_TRUST_MATRIX[command].decisionSafety, 'review-required');
        }
    });

    it('summary is explicit proof classification, never runtime accuracy', () => {
        const summary = summarizeCommandTrust();
        assert.strictEqual(summary.commands, CANONICAL_COMMANDS.length);
        assert.strictEqual(summary.classified, CANONICAL_COMMANDS.length);
        assert.strictEqual(summary.unclassified, 0);
        assert.ok(summary.oracleBacked > 0);
        assert.strictEqual(summary.contract, 'proof-classification-not-runtime-accuracy');
        assert.ok(!Object.hasOwn(summary, 'accuracy'));
    });

    it('doctor exposes the proof contract without calling it accuracy', () => {
        const dir = tmp({ 'app.js': 'export function run() { return 1; }' });
        try {
            const result = execute(idx(dir), 'doctor', {});
            assert.ok(result.ok, result.error);
            assert.deepStrictEqual(result.result.commandTrust, summarizeCommandTrust());
            assert.match(formatDoctor(result.result), /classification describes shipped proof coverage/i);
            const json = JSON.parse(formatDoctorJson(result.result));
            assert.strictEqual(json.commandTrust.contract,
                'proof-classification-not-runtime-accuracy');
            assert.ok(!Object.hasOwn(json.commandTrust, 'accuracy'));
        } finally { rm(dir); }
    });

    it('the caller engine source parses without an embedded raw NUL separator', () => {
        const source = fs.readFileSync(path.join(ROOT, 'core', 'callers.js'));
        assert.strictEqual(source.includes(0), false,
            'use a JavaScript \\0 escape; a raw NUL makes tree-sitter recover and weakens the index');
    });

    it('the packaged skill command reference lists every canonical command', () => {
        const commandRef = fs.readFileSync(path.join(
            ROOT, '.claude', 'skills', 'ucn', 'references', 'commands.md'), 'utf8');
        for (const command of CANONICAL_COMMANDS) {
            const cliName = command.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
            assert.ok(commandRef.includes('`' + cliName),
                `skill command reference must list ${cliName}`);
        }
    });

    it('release and weekly workflows execute semantic, deadcode, consistency, and performance gates', () => {
        const pkg = require('../package.json');
        assert.match(pkg.scripts['trust:gate'], /trust:gate:semantic/);
        assert.match(pkg.scripts['trust:gate'], /trust:gate:deadcode/);
        assert.match(pkg.scripts['trust:gate'], /trust:gate:consistency/);
        assert.match(pkg.scripts['trust:gate'], /trust:gate:performance/);
        assert.ok(pkg.scripts['trust:gate'].indexOf('trust:gate:performance')
            < pkg.scripts['trust:gate'].indexOf('trust:gate:semantic'),
        'performance must run before verbose compiler oracles can perturb wall-clock measurements');
        assert.ok(pkg.scripts['trust:gate:fast'].indexOf('run-performance-gate.js')
            < pkg.scripts['trust:gate:fast'].indexOf('run-oracle-eval.js'),
        'fast performance gate must also run before oracle output');
        const publish = fs.readFileSync(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8');
        const weekly = fs.readFileSync(path.join(ROOT, '.github/workflows/eval.yml'), 'utf8');
        assert.match(publish, /npm run trust:gate/);
        assert.match(publish, /clangd-18/);
        assert.match(publish, /setup-dotnet@v5/);
        assert.match(weekly, /trust:gate:consistency/);
        assert.match(weekly, /trust:gate:performance/);
        assert.match(weekly, /clangd-18/);
        assert.match(weekly, /setup-dotnet@v5/);
        assert.ok(weekly.indexOf('run: npm run trust:gate:performance')
            < weekly.indexOf('run: node eval/conservation-real.js'),
        'weekly timing precedes the independent correctness arms');
    });

    it('parallel evaluation covers the pinned board once and rejects unassigned repositories', () => {
        const { evaluationMatrix } = require('../eval/run-ci-plan');
        for (const event of ['schedule', 'workflow_dispatch']) {
            const rows = evaluationMatrix(event, true).include;
            const names = rows.filter(row => row.kind === 'oracle').flatMap(row => row.repos.split(','));
            assert.deepStrictEqual(names.sort(), REPOS.map(repo => repo.name).sort());
            assert.strictEqual(new Set(rows.map(row => row.id)).size, rows.length);
            assert.strictEqual(rows.filter(row => row.kind === 'checks').length, 1);
            assert.strictEqual(rows.filter(row => row.kind === 'release').length, event === 'workflow_dispatch' ? 1 : 0);
        }
        assert.deepStrictEqual(evaluationMatrix('workflow_dispatch', false).include.map(row => row.kind),
            ['checks', 'matrices', 'release']);
        for (const [event, full] of [['schedule', false], ['workflow_dispatch', false], ['workflow_dispatch', true]]) {
            assert.strictEqual(evaluationMatrix(event, full).include.filter(row => row.kind === 'matrices').length, 1,
                `${event} judges the matrices on one runner`);
        }
        assert.deepStrictEqual(evaluationMatrix('schedule', false), evaluationMatrix('schedule', true));
        assert.throws(() => evaluationMatrix('push', true), /Unsupported/);
        assert.throws(() => evaluationMatrix('schedule', 'false'), /boolean/);
        assert.throws(() => evaluationMatrix('schedule', true, []), /empty/);
        assert.throws(() => evaluationMatrix('schedule', true, [{ name: 'new', language: 'unknown' }]), /No oracle group/);
        assert.throws(() => evaluationMatrix('schedule', true, [REPOS[0], REPOS[0]]), /duplicate/);
        assert.throws(() => evaluationMatrix('schedule', true, [{ name: '--bad,name', language: 'java' }]), /Invalid/);
    });

    it('every planned arm survives earlier failures without running in another job', () => {
        const { evaluationMatrix } = require('../eval/run-ci-plan');
        const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/eval.yml'), 'utf8');
        const arms = workflow.split(/\n      - name: /).slice(1).filter(step =>
            /\n        run: (?:node eval\/|npm run trust:gate)/.test(step));
        assert.strictEqual(arms.length, 11);
        for (const [event, full] of [['schedule', false], ['workflow_dispatch', true], ['workflow_dispatch', false]]) {
            for (const matrix of evaluationMatrix(event, full).include) {
                for (const step of arms) {
                    const expression = step.match(/\n        if: \$\{\{ (.+) \}\}/)?.[1];
                    const title = step.split('\n')[0];
                    assert.ok(expression?.includes('!cancelled()'), title);
                    assert.doesNotMatch(step, /continue-on-error:/);
                    const evaluate = (cancelled, outcome) => vm.runInNewContext(expression, {
                        github: { event_name: event }, inputs: { full }, matrix,
                        cancelled: () => cancelled, steps: { dependencies: { outcome } },
                        // Explicit status functions override implicit success()
                        // so one failed arm does not suppress later reports.
                        success: () => false,
                    });
                    const kind = step.startsWith('"Pre-tag') ? 'release' :
                        step.startsWith('"Oracle eval') ? 'oracle' :
                            / matrix \(gate: /.test(title) ? 'matrices' : 'checks';
                    const scheduled = !step.startsWith('"Outcome') && kind === 'checks';
                    const expected = matrix.kind === kind && (!scheduled || event === 'schedule' || full);
                    assert.strictEqual(evaluate(false, 'success'), expected, `${event}/${matrix.id}/${title}`);
                    assert.strictEqual(evaluate(true, 'success'), false);
                    assert.strictEqual(evaluate(false, 'failure'), false);
                }
            }
        }
        assert.match(workflow, /- run: npm ci\n        id: dependencies/);
        assert.match(workflow, /fail-fast: false/);
        assert.match(workflow, /max-parallel: 6/);
        assert.match(workflow, /UCN_EVAL_REPORTS_DIR: .*\$\{\{ matrix.id \}\}/);
        assert.match(workflow, /name: Upload reports\n        if: always\(\)/);
        assert.match(workflow, /name: eval-reports-\$\{\{ matrix.id \}\}/);
        assert.match(workflow, /needs: \[plan, eval\]\n    if: always\(\)/);
        assert.match(workflow, /uses: actions\/upload-artifact\/merge@v6/);
        assert.match(workflow, /pattern: eval-reports-\*/);
    });

    it('the matrices run with every toolchain they judge by, and a missing one fails them', () => {
        const { evaluationMatrix } = require('../eval/run-ci-plan');
        const { TOOLCHAINS } = require('../eval/run-deletion-matrix');
        const { RUNNERS } = require('../eval/run-test-unit-matrix');
        const pkg = require('../package.json');
        const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/eval.yml'), 'utf8');
        const publish = fs.readFileSync(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8');
        const action = fs.readFileSync(path.join(ROOT, '.github/actions/matrix-toolchains/action.yml'), 'utf8');
        const lock = require('../package-lock.json');

        // Every qualified gate is one step of its own that runs whole (no
        // partial run, no case filter: an absent toolchain is a failure), on
        // exactly one runner of every trigger.
        const jobs = workflowJobs(workflow);
        const evalJob = jobs.get('eval');
        assertRequiredJob('eval.yml eval', evalJob);
        const contexts = EVAL_TRIGGERS.flatMap(([event, full]) =>
            evaluationMatrix(event, full).include.map(row => ({ event, full, row })));
        for (const command of QUALIFIED_COMMANDS) {
            const own = evalJob.steps.filter(step => step.commands.length === 1 && step.commands[0] === command);
            assert.strictEqual(own.length, 1, `the Eval workflow runs \`${command}\` as one step of its own`);
            for (const [event, full] of EVAL_TRIGGERS) {
                const rows = contexts.filter(context => context.event === event && context.full === full &&
                    stepActive(own[0], context));
                assert.strictEqual(rows.length, 1, `\`${command}\` runs on one runner of ${event}${full ? ' (full)' : ''}`);
            }
        }
        assert.doesNotMatch(workflow, /--allow-missing|--only|--pin/);

        // Where every toolchain comes from: the lockfile, the job's own
        // setup, the shared action, or the runner image (asserted present
        // by the action's version step).
        const setup = `${workflow}\n${action}`;
        const provided = {
            ts: () => lock.packages['node_modules/typescript'],
            py: () => lock.packages['node_modules/pyright'],
            go: () => /uses: actions\/setup-go@/.test(workflow),
            rs: () => /\n        rustc --version\n/.test(action),
            java: () => /uses: actions\/setup-java@/.test(workflow),
            cs: () => /uses: actions\/setup-dotnet@/.test(workflow),
            cpp: () => /echo "CXX=clang\+\+-18" >> "\$GITHUB_ENV"/.test(action),
            pytest: () => /pip install .*pytest==\d+\.\d+\.\d+/.test(action),
            'node-test': () => /uses: actions\/setup-node@/.test(workflow),
            jest: () => /npm install .* jest@\d+\.\d+\.\d+/.test(action),
            vitest: () => /npm install .* vitest@\d+\.\d+\.\d+/.test(action),
            mocha: () => /npm install .* mocha@\d+\.\d+\.\d+/.test(action),
            'go-test': () => /uses: actions\/setup-go@/.test(workflow),
            'cargo-test': () => /\n        cargo --version\n/.test(action),
            'dotnet-test': () => /uses: actions\/setup-dotnet@/.test(workflow),
            maven: () => /\n        mvn --version\n/.test(action) && /uses: actions\/setup-java@/.test(workflow),
        };
        for (const name of [...Object.keys(TOOLCHAINS), ...Object.keys(RUNNERS)]) {
            assert.ok(provided[name], `no declared source for the ${name} toolchain`);
            assert.ok(provided[name](), `the matrices job does not provide ${name}`);
        }
        assert.match(action, /echo "UCN_JS_TEST_MODULES=\$tools\/node_modules" >> "\$GITHUB_ENV"/);
        assert.match(setup, /uses: actions\/setup-python@v\d+\n\s+with:\n\s+python-version: '3\.\d+'/);

        // In every job of both workflows, for every planned runner: a matrix
        // runs only after the toolchain action, with the time the matrices
        // need. In the Eval job the action also precedes the dependencies
        // every arm waits for, so a failed install skips the arms.
        const publishJobs = workflowJobs(publish);
        assertRequiredJob('publish.yml test', publishJobs.get('test'));
        assertRequiredJob('publish.yml publish-npm', publishJobs.get('publish-npm'));
        for (const [name, job] of jobs) {
            assertMatricesProvided(`eval.yml ${name}`, job, pkg.scripts, name === 'eval' ? contexts : [{}]);
            assertQualifiedWhole(`eval.yml ${name}`, job.steps.flatMap(step => leafCommands(step.commands, pkg.scripts)));
        }
        const toolsAt = evalJob.steps.findIndex(step => step.uses === TOOLCHAIN_ACTION);
        const dependenciesAt = evalJob.steps.findIndex(step => step.id === 'dependencies');
        assert.ok(toolsAt >= 0 && dependenciesAt >= 0 && toolsAt < dependenciesAt);

        // The release gate: the script, and each publish job as it runs it.
        // It holds every qualified gate, each as qualified, or none.
        const gate = leafCommands(['npm run trust:gate'], pkg.scripts);
        assertQualifiedWhole('trust:gate', gate);
        assertEnrolledTogether('trust:gate', gate);
        for (const [name, job] of publishJobs) {
            const commands = job.steps.flatMap(step => leafCommands(step.commands, pkg.scripts));
            assertMatricesProvided(`publish.yml ${name}`, job, pkg.scripts, [{}]);
            assertQualifiedWhole(`publish.yml ${name}`, commands);
            assertEnrolledTogether(`publish.yml ${name}`, commands);
        }
        // Publishing waits for the job that runs the release gate, and that
        // step can neither be skipped nor fail without failing the job.
        const gateSteps = publishJobs.get('test').steps.filter(step => step.commands.includes('npm run trust:gate'));
        assert.strictEqual(gateSteps.length, 1, 'the publish test job runs the release gate');
        assert.strictEqual(gateSteps[0].condition, null);
        assert.strictEqual(gateSteps[0].continueOnError, null);
        assert.strictEqual(publishJobs.get('publish-npm').needs, 'test');

        // The pre-tag dry run rehearses what the publish job enforces.
        const qualifiedIn = steps => QUALIFIED_COMMANDS.filter(command =>
            steps.flatMap(step => leafCommands(step.commands, pkg.scripts)).includes(command));
        const dryRun = contexts.find(context => context.row.kind === 'release');
        assert.deepStrictEqual(qualifiedIn(evalJob.steps.filter(step => stepActive(step, dryRun))),
            qualifiedIn(publishJobs.get('test').steps),
            'the pre-tag dry run and the publish job hold the same qualified gates');
    });

    it('keeps one machine-readable release board across gates and documentation', () => {
        const pkg = require('../package.json');
        const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
        assert.strictEqual(RELEASE_REPO_NAMES.length, 10);
        assert.strictEqual(new Set(RELEASE_REPO_NAMES).size, RELEASE_REPO_NAMES.length);
        assert.deepStrictEqual(RELEASE_REPOS.map(repo => repo.name), [...RELEASE_REPO_NAMES]);
        assert.ok(RELEASE_REPOS.every(repo => REPOS.includes(repo)));
        for (const script of [
            pkg.scripts['trust:gate:semantic'],
            pkg.scripts['trust:gate:deadcode'],
            pkg.scripts['trust:gate:consistency'],
            pkg.scripts['trust:gate:performance'],
        ]) {
            assert.match(script, /--release/, `${script} must use the shared release board`);
            assert.doesNotMatch(script, /--repo/, `${script} must not duplicate the release list`);
        }
        assert.match(readme, /ten-repository/i);
        assert.match(readme, new RegExp(`${REPOS.length} pinned repositories`, 'i'));
        assert.strictEqual(REPOS.length, 44);
        for (const name of RELEASE_REPO_NAMES) {
            assert.ok(readme.includes(name), `README must name release repository ${name}`);
        }
        for (const repo of REPOS) {
            assert.ok(readme.includes(repo.name), `README must name scheduled repository ${repo.name}`);
        }
    });

    it('fix #432: keeps the fresh arm a holdout that spans every supported language', () => {
        const { FRESH_POOL, OUTCOME_POOL, OUTCOME_TUNED } = require('../eval/lib/repos');
        const pinned = new Set(REPOS.map(repo => repo.name));
        assert.strictEqual(pinned.size, REPOS.length, 'pinned repository names are unique');
        for (const repo of REPOS) {
            assert.match(repo.commit, /^[0-9a-f]{40}$/, `${repo.name} is pinned to a full commit`);
        }
        const fresh = FRESH_POOL.map(repo => repo.name);
        assert.strictEqual(fresh.length, 13);
        assert.strictEqual(new Set(fresh).size, fresh.length);
        const elsewhere = new Set([...pinned, ...OUTCOME_POOL.map(repo => repo.name),
            ...OUTCOME_TUNED.map(repo => repo.name)]);
        for (const repo of FRESH_POOL) {
            assert.ok(!elsewhere.has(repo.name), `${repo.name}: a tuned or outcome repository is no holdout`);
            assert.strictEqual(repo.commit, undefined, `${repo.name}: fresh repositories are unpinned`);
            assert.ok(repo.url && Array.isArray(repo.targetCandidates), repo.name);
        }
        // Repositories used for tuning belong on the pinned board.
        for (const name of ['dayjs', 'rand', 'pino', 'tanstack-form', 'tqdm', 'zap', 'nom',
            'guice', 'dapper', 'lz4', 'pugixml', 'stateless', 'luxon', 'arrow',
            'more-itertools', 'rust-url', 'indicatif', 'cachetools', 'djangoproject']) {
            assert.ok(pinned.has(name) && !fresh.includes(name), name);
        }
        const languages = new Set(FRESH_POOL.map(repo => repo.language));
        for (const family of [['javascript', 'typescript'], ['python'], ['go'], ['rust'], ['java'],
            ['csharp'], ['c'], ['cpp']]) {
            assert.ok(family.some(language => languages.has(language)),
                `the fresh pool covers ${family.join('/')}`);
        }
    });
});
