#!/usr/bin/env node
/**
 * eval/run-test-unit-matrix.js - does the test model agree with the test
 * runners about what a test is and how to run one?
 *
 * Every test in eval/test-unit-matrix-cases.js records its own execution:
 * its body appends `<file>::<suite > name>` to the file named by UCN_RAN.
 * For every case:
 *   1. the engine's answer (roles, runners, units, selectors) must be the
 *      pinned one in eval/test-unit-matrix-answers.json;
 *   2. the runner's own whole-project command runs, and what executed is
 *      compared with the units the engine lists;
 *   3. every selector the engine printed runs, and what executed must be
 *      exactly the unit it was printed for; every file command must run
 *      all of that file's tests.
 *
 * FALSE-UNIT is a unit the runner never executes. WRONG-SELECTOR is a
 * command that runs nothing, something else, or more than its unit.
 * FALSE-SUPPORT is a file called support that the runner executes tests
 * from. UNDECLARED is a test the runner executes and the engine does not
 * list: each one must be named by its case (a measured limit), never a
 * surprise. The run fails on any of them, on an answer that differs from
 * the pin, and on a runner it could not start (a missing runner is never a
 * pass; --allow-missing permits a partial run, a run that judged nothing
 * always fails).
 *
 * usage: node eval/run-test-unit-matrix.js [--allow-missing] [--only <substring>] [--pin]
 *   UCN_TEST_TOOLS: directories put in front of PATH (pytest, mvn).
 *   UCN_JS_TEST_MODULES: a node_modules directory holding jest, vitest, mocha.
 *   UCN_EVAL_REPORTS_DIR, when set, receives test-unit-matrix-<date>.json.
 *   --pin rewrites the pinned answers from the engine's current ones.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { ProjectIndex } = require('../core/project');
const { createTestModel, selectorText, unitLabel } = require('../core/test-units');
const { isTestFile } = require('../core/discovery');
const { CASES } = require('./test-unit-matrix-cases');

const ANSWERS_FILE = path.join(__dirname, 'test-unit-matrix-answers.json');
const TIMEOUT_MS = 600000;

// The command each runner uses for a whole project, and how to tell that
// the runner is installed.
const RUNNERS = {
    'pytest': { probe: ['pytest', ['--version']], full: 'pytest -q' },
    'node-test': { probe: ['node', ['--version']], full: 'node --test' },
    'jest': { probe: ['node', ['--version']], full: 'npx jest', modules: 'jest' },
    'vitest': { probe: ['node', ['--version']], full: 'npx vitest run', modules: 'vitest' },
    'mocha': { probe: ['node', ['--version']], full: 'npx mocha --recursive', modules: 'mocha' },
    'go-test': { probe: ['go', ['version']], full: 'go test ./...' },
    'cargo-test': { probe: ['cargo', ['--version']], full: 'cargo test' },
    'dotnet-test': { probe: ['dotnet', ['--version']], full: 'dotnet test' },
    'maven': { probe: ['mvn', ['--version']], full: 'mvn -q test' },
};

function toolEnv(extra = {}) {
    const front = (process.env.UCN_TEST_TOOLS || '').split(path.delimiter).filter(Boolean);
    return {
        ...process.env,
        PATH: [...front, process.env.PATH].join(path.delimiter),
        ...extra,
    };
}

function available(runner) {
    const spec = RUNNERS[runner];
    if (!spec) return false;
    if (spec.modules) {
        const modules = process.env.UCN_JS_TEST_MODULES;
        if (!modules || !fs.existsSync(path.join(modules, spec.modules))) return false;
    }
    try {
        execFileSync(spec.probe[0], spec.probe[1], { stdio: 'pipe', env: toolEnv(), timeout: 60000 });
        return true;
    } catch {
        return false;
    }
}

function writeProject(dir, files) {
    for (const [name, content] of Object.entries(files)) {
        const target = path.join(dir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
}

/**
 * The engine's answer about a project, as lines: one per test-path file
 * (role, runner or why none, the file command), one per unit under it.
 */
function answerOf(dir) {
    const index = new ProjectIndex(dir);
    index.build(null, { quiet: true });
    index._beginOp();
    try {
        const model = createTestModel(index);
        const lines = [];
        const units = [];
        const files = [];
        const entries = [...index.files].sort((a, b) => a[1].relativePath < b[1].relativePath ? -1 : 1);
        for (const [filePath, entry] of entries) {
            const declared = model.unitsOf(filePath);
            if (!declared.modeled) continue;
            if (declared.units.length === 0 && !isTestFile(entry.relativePath, entry.language)) continue;
            const facts = model.fileFacts(filePath);
            const runner = model.runnerOf(filePath);
            const run = facts.run ? selectorText(facts.run) : null;
            lines.push(`${entry.relativePath} [${facts.role}] ${runner.id || `no runner: ${runner.reason}`}` +
                (facts.role === 'tests' ? `  run: ${run || `(withheld: ${facts.runWithheld})`}` : ''));
            files.push({ file: entry.relativePath, role: facts.role, run });
            for (const unit of declared.units) {
                const label = unitLabel(unit);
                if (unit.kind !== 'test') {
                    lines.push(`  S ${label}`);
                    continue;
                }
                const row = model.describe(filePath, unit);
                const selector = row.selector ? selectorText(row.selector) : null;
                lines.push(`  T ${label}${unit.conditional ? ' [conditional]' : ''}` +
                    `${unit.inherited ? ` (from ${unit.inherited.file}:${unit.inherited.line})` : ''} => ` +
                    (selector || `(withheld: ${row.selectorWithheld})`));
                units.push({
                    id: `${entry.relativePath}::${label}`, file: entry.relativePath,
                    selector, conditional: !!unit.conditional,
                });
            }
        }
        return { lines, units, files };
    } finally {
        index._endOp();
    }
}

function runRecorded(commandLine, cwd, env) {
    const record = path.join(cwd, '.ucn-ran');
    fs.rmSync(record, { force: true });
    const result = spawnSync('sh', ['-c', commandLine], {
        cwd, env: { ...env, UCN_RAN: record }, stdio: 'pipe', timeout: TIMEOUT_MS,
    });
    if (result.error) throw result.error;
    let ran;
    try {
        ran = fs.readFileSync(record, 'utf8').split('\n').filter(Boolean);
    } catch {
        ran = [];
    }
    return {
        ran: [...new Set(ran)].sort(),
        status: result.status,
        output: `${result.stdout || ''}${result.stderr || ''}`,
    };
}

function sameSet(a, b) {
    return a.length === b.length && a.every((value, i) => value === b[i]);
}

function main() {
    const argv = process.argv.slice(2);
    const allowMissing = argv.includes('--allow-missing');
    const pin = argv.includes('--pin');
    const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
    const pinned = fs.existsSync(ANSWERS_FILE) ? JSON.parse(fs.readFileSync(ANSWERS_FILE, 'utf8')) : {};
    const nextPins = only ? { ...pinned } : {};
    const present = new Map();
    const failures = [];
    const missing = new Set();
    const totals = { cases: 0, judged: 0, units: 0, selectors: 0, fileCommands: 0, undeclared: 0, withheld: 0 };
    const rows = [];
    const cargoTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-units-cargo-'));

    for (const testCase of CASES) {
        if (only && !testCase.id.includes(only)) continue;
        totals.cases++;
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-units-')));
        try {
            writeProject(dir, testCase.files);
            const answer = answerOf(dir);
            nextPins[testCase.id] = answer.lines;
            const row = { id: testCase.id, runner: testCase.runner, problems: [] };
            rows.push(row);
            const fail = (kind, detail) => {
                row.problems.push({ kind, detail });
                failures.push(`${kind} ${testCase.id}: ${detail}`);
            };
            if (!pin && JSON.stringify(pinned[testCase.id] || null) !== JSON.stringify(answer.lines)) {
                fail('ANSWER-CHANGED', `engine answer differs from the pin:\n    ${answer.lines.join('\n    ')}`);
            }
            totals.withheld += answer.units.filter(unit => !unit.selector).length;
            if (testCase.judge === false) continue;

            if (!present.has(testCase.runner)) present.set(testCase.runner, available(testCase.runner));
            if (!present.get(testCase.runner)) {
                missing.add(testCase.runner);
                continue;
            }
            const spec = RUNNERS[testCase.runner];
            if (spec.modules) {
                for (const moduleDir of testCase.moduleDirs || ['']) {
                    fs.symlinkSync(process.env.UCN_JS_TEST_MODULES, path.join(dir, moduleDir, 'node_modules'), 'dir');
                }
            }
            const env = toolEnv({ CARGO_TARGET_DIR: cargoTarget, CI: '1', NO_COLOR: '1' });
            const cwd = path.join(dir, testCase.cwd || '');
            const full = runRecorded(testCase.full || spec.full, cwd, env);
            const expected = answer.units.filter(unit => !unit.conditional).map(unit => unit.id);
            const listed = new Set(answer.units.map(unit => unit.id));
            totals.judged++;
            totals.units += answer.units.length;
            if (full.ran.length === 0 && expected.length > 0) {
                fail('RUNNER-RAN-NOTHING', `${testCase.full || spec.full} (exit ${full.status})\n${full.output.slice(-1500)}`);
                continue;
            }
            for (const id of expected) {
                if (!full.ran.includes(id) && !(testCase.notRunByDefault || []).includes(id)) {
                    fail('FALSE-UNIT', `${id} is listed and the runner never executes it`);
                }
            }
            const undeclared = full.ran.filter(id => !listed.has(id));
            const allowed = (testCase.undeclared || []).slice().sort();
            if (!sameSet(undeclared, allowed)) {
                fail('UNDECLARED', `the runner executes [${undeclared.join(', ')}], the case names [${allowed.join(', ')}]`);
            }
            totals.undeclared += undeclared.length;
            for (const file of answer.files) {
                const executed = full.ran.filter(id => id.startsWith(`${file.file}::`));
                if (file.role === 'support' && executed.length > 0) {
                    fail('FALSE-SUPPORT', `${file.file} is called support and the runner executes ${executed.join(', ')}`);
                }
                if (file.role !== 'tests' || !file.run || executed.length === 0) continue;
                totals.fileCommands++;
                const got = runRecorded(file.run, dir, env);
                const lost = executed.filter(id => !got.ran.includes(id));
                if (lost.length > 0) {
                    fail('WRONG-SELECTOR', `${file.run} does not run ${lost.join(', ')} (exit ${got.status})\n${got.output.slice(-800)}`);
                }
            }
            for (const unit of answer.units) {
                if (!unit.selector) continue;
                totals.selectors++;
                const got = runRecorded(unit.selector, dir, env);
                if (!sameSet(got.ran, [unit.id])) {
                    fail('WRONG-SELECTOR', `${unit.selector} ran [${got.ran.join(', ')}], expected [${unit.id}] (exit ${got.status})\n${got.output.slice(-800)}`);
                }
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    fs.rmSync(cargoTarget, { recursive: true, force: true });

    if (pin) {
        const ordered = {};
        for (const id of Object.keys(nextPins).sort()) ordered[id] = nextPins[id];
        fs.writeFileSync(ANSWERS_FILE, JSON.stringify(ordered, null, 2) + '\n');
        console.log(`pinned ${Object.keys(ordered).length} answers`);
    }
    for (const runner of [...missing].sort()) {
        const line = `MISSING-RUNNER ${runner}: its cases were not judged`;
        if (allowMissing) console.log(line);
        else failures.push(line);
    }
    if (totals.judged === 0) failures.push('NOTHING-JUDGED: no case ran under its runner');

    console.log(`test-unit matrix: ${totals.cases} cases, ${totals.judged} judged by their runner`);
    console.log(`  units listed: ${totals.units} · unit selectors run: ${totals.selectors} · file commands run: ${totals.fileCommands}`);
    console.log(`  units without a command: ${totals.withheld} · runner tests the engine does not list (named by their cases): ${totals.undeclared}`);
    for (const failure of failures) console.log(`FAIL ${failure}`);
    console.log(failures.length === 0 ? 'PASS' : `FAILED (${failures.length})`);

    const reports = process.env.UCN_EVAL_REPORTS_DIR;
    if (reports) {
        fs.mkdirSync(reports, { recursive: true });
        const date = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(path.join(reports, `test-unit-matrix-${date}.json`),
            JSON.stringify({ totals, missing: [...missing].sort(), failures, rows }, null, 2));
    }
    process.exit(failures.length === 0 ? 0 : 1);
}

if (require.main === module) main();

module.exports = { answerOf, RUNNERS };
