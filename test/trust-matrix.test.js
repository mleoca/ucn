'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

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

describe('command trust matrix: fail-closed proof coverage', () => {
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
            ['checks', 'release']);
        assert.deepStrictEqual(evaluationMatrix('schedule', false), evaluationMatrix('schedule', true));
        assert.throws(() => evaluationMatrix('push', true), /Unsupported/);
        assert.throws(() => evaluationMatrix('schedule', 'false'), /boolean/);
        assert.throws(() => evaluationMatrix('schedule', true, []), /empty/);
        assert.throws(() => evaluationMatrix('schedule', true, [{ name: 'new', language: 'unknown' }]), /No oracle group/);
        assert.throws(() => evaluationMatrix('schedule', true, [REPOS[0], REPOS[0]]), /duplicate/);
        assert.throws(() => evaluationMatrix('schedule', true, [{ name: '--bad,name', language: 'java' }]), /Invalid/);
    });

    it('every planned arm survives earlier failures without running in another job', () => {
        const vm = require('node:vm');
        const { evaluationMatrix } = require('../eval/run-ci-plan');
        const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/eval.yml'), 'utf8');
        const arms = workflow.split(/\n      - name: /).slice(1).filter(step =>
            /\n        run: (?:node eval\/|npm run trust:gate)/.test(step));
        assert.strictEqual(arms.length, 8);
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
                        step.startsWith('"Oracle eval') ? 'oracle' : 'checks';
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
        assert.strictEqual(REPOS.length, 43);
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
            'more-itertools', 'rust-url', 'indicatif', 'cachetools']) {
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
