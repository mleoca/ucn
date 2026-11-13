#!/usr/bin/env node
/**
 * eval/run-test-unit-matrix.js - does the test model agree with the test
 * runners about what a test is and how to run one?
 *
 * Every test in eval/test-unit-matrix-cases.js records its own execution:
 * its body appends an identity to the file named by UCN_RAN. A case writes
 * `mark("<file>::<label>")`; when the project is written out, a mark whose
 * file is the one it stands in becomes `<file>:<line>`, so two declarations
 * are two identities whatever they are called. A test that runs under a
 * class it does not stand in (an inherited one) computes its identity at
 * run time as `<file of the class>::<suite > name>`.
 * For every case:
 *   1. the engine's answer (roles, runners, units, selectors) must be the
 *      pinned one in eval/test-unit-matrix-answers.json;
 *   2. the runner's own whole-project command runs, and what executed is
 *      compared with the units the engine lists;
 *   3. every selector the engine printed runs, and what executed must be
 *      exactly the unit it was printed for; every file command must run
 *      all of that file's tests.
 *
 * A unit owns the marks on its own lines, or the run-time identity that
 * carries its label. FALSE-UNIT is a unit the runner never executes.
 * FALSE-SKIP is a unit called skipped that the runner executes. A claim
 * that only weakens what is said has to be deliberate: every unit called
 * conditional (SOMETIMES) and every test file with a command from which
 * nothing runs (EMPTY-FILE) must be named by its case, and a file's count
 * must be the number of its listed tests that are not skipped (COUNT).
 * WRONG-SELECTOR is a command that runs nothing, something else, or more
 * than its unit (a second declaration of the same name included), and a
 * joined command that does not run exactly what the files' own commands
 * run. REPEATED is a body that executes more often than the tests listed
 * for it, unless the case says the declaration stands for several.
 * FALSE-SUPPORT is a file called support that the runner executes tests
 * from. UNDECLARED is a test the runner executes and the engine does not
 * list: each one must be named by its case (a measured limit), never a
 * surprise. Naming one does not excuse the count the engine prints:
 * INEXACT-COUNT is a file from which the runner executes a test the
 * engine does not list (or a body more often than listed) while the
 * engine gives the file's count as exact. A count given as a lower bound
 * is a weaker claim and has to be deliberate too: LOWER-BOUND is a file so
 * marked that its case does not name (`atLeast`), or one named that is not
 * marked. The count is judged as the commands print it: what linking
 * every line of the file answers (the path `tests`, the affected-test
 * selection and `check` share) must be the file's own count and mark.
 * A file's command that executes tests of another file is a
 * WRONG-SELECTOR as well (go runs a package and cargo a module tree: both
 * hold several files; a test declared inside a function of another file
 * belongs to the file that calls it, whose count is a lower bound).
 * A test the whole run executes because of the order files are loaded in
 * (another module switched it on first) is one a file's own command
 * cannot run: its case names it (`onlyInWholeRun`), the engine has to
 * call it conditional, and one named that the file's command does run
 * fails as well.
 * The run fails on any of them, on an answer that differs from
 * the pin, and on a runner it could not start (a missing runner is never a
 * pass; --allow-missing permits a partial run, a run that judged nothing
 * always fails).
 *
 * usage: node eval/run-test-unit-matrix.js [--allow-missing] [--only <substring>] [--pin]
 *   UCN_TEST_TOOLS: directories put in front of PATH (pytest, mvn).
 *   UCN_JS_TEST_MODULES: a node_modules directory holding jest, vitest, mocha.
 *   UCN_EVAL_REPORTS_DIR, when set, receives test-unit-matrix-<date>.json,
 *   which names the version of every runner that judged.
 *   --pin rewrites the pinned answers from the engine's current ones.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { ProjectIndex } = require('../core/project');
const { createTestModel, selectorText, unitLabel, commandsFor, linkFile, standsForSeveral } = require('../core/test-units');
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
    'go-test': { probe: ['go', ['version']], full: 'go test ./...', fileIsPackage: true },
    'cargo-test': { probe: ['cargo', ['--version']], full: 'cargo test', fileIsModuleTree: true },
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

/**
 * The version of a runner that can judge, kept in the report: the first
 * line its probe prints, and for a runner that is a package the version of
 * that package. Null when the runner is not installed.
 */
function runnerVersion(runner) {
    const spec = RUNNERS[runner];
    if (!spec) return null;
    let packaged = '';
    if (spec.modules) {
        const modules = process.env.UCN_JS_TEST_MODULES;
        if (!modules || !fs.existsSync(path.join(modules, spec.modules))) return null;
        try {
            packaged = `${spec.modules} ${JSON.parse(fs.readFileSync(path.join(modules, spec.modules, 'package.json'), 'utf8')).version}, node `;
        } catch {
            return null;
        }
    }
    const result = spawnSync(spec.probe[0], spec.probe[1], { encoding: 'utf8', env: toolEnv(), timeout: 60000 });
    if (result.error || result.status !== 0) return null;
    const line = `${result.stdout}\n${result.stderr}`.split('\n').map(text => text.trim()).find(Boolean);
    return `${packaged}${line || 'version not printed'}`;
}

/**
 * A file of a case as it is written to disk: every `mark("<this file>::...")`
 * becomes `mark("<this file>:<line>")`, the line the mark stands on.
 */
function materialize(name, content) {
    // One whole literal, in either quote: a computed identity is left alone.
    const rewrite = (line, i, quote) => line.replace(
        new RegExp(`(mark\\(\\s*)${quote}([^${quote}\\n]*?)::[^${quote}\\n]*${quote}(\\s*\\))`, 'gi'),
        (whole, head, file, tail) => file === name ? `${head}${quote}${name}:${i + 1}${quote}${tail}` : whole,
    );
    return content.split('\n').map((line, i) => rewrite(rewrite(line, i, '"'), i, "'")).join('\n');
}

/**
 * The identity a case's `<file>::<label>` has once the project is written
 * out: the line its mark stands on. A name that is no such mark (a line
 * identity, a run-time label) is itself.
 */
function namedIdentities(testCase) {
    const lines = new Map();
    for (const [name, content] of Object.entries(testCase.files)) {
        content.split('\n').forEach((line, i) => {
            for (const found of line.matchAll(/mark\(\s*(["'])([^"'\n]*?::[^"'\n]*)\1\s*\)/gi)) {
                if (found[2].startsWith(`${name}::`) && !lines.has(found[2])) lines.set(found[2], `${name}:${i + 1}`);
            }
        });
    }
    const resolve = list => (list || []).map(id => lines.get(id) || id);
    return {
        ...testCase, undeclared: resolve(testCase.undeclared), repeats: resolve(testCase.repeats),
        onlyInWholeRun: resolve(testCase.onlyInWholeRun),
    };
}

function writeProject(dir, files) {
    for (const [name, content] of Object.entries(files)) {
        const target = path.join(dir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, materialize(name, content));
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
                (facts.role === 'tests' ? `  run: ${run || `(withheld: ${facts.runWithheld})`}` : '') +
                (facts.moreTests ? '  [holds more tests]' : ''));
            // The count as the commands print it: every line of the file linked.
            const lineCount = index._readFile(filePath).split('\n').length;
            const linked = linkFile(model, index, filePath, Array.from({ length: lineCount }, (unused, i) => i + 1));
            files.push({
                file: entry.relativePath, role: facts.role, run, tests: facts.tests, more: !!facts.moreTests,
                linked: { tests: linked.tests, more: !!linked.moreTests },
            });
            for (const unit of declared.units) {
                const label = unitLabel(unit);
                if (unit.kind !== 'test') {
                    lines.push(`  S ${label}`);
                    continue;
                }
                const row = model.describe(filePath, unit);
                const selector = row.selector ? selectorText(row.selector) : null;
                lines.push(`  T ${label}${unit.conditional ? ' [conditional]' : ''}${unit.skipped ? ' [skipped]' : ''}` +
                    `${unit.inherited ? ` (from ${unit.inherited.file}:${unit.inherited.line})` : ''}` +
                    `${unit.alternatives ? ` (or ${unit.alternatives.map(body => `${body.file}:${body.startLine}`).join(', ')})` : ''} => ` +
                    (selector || `(withheld: ${row.selectorWithheld})`));
                units.push({
                    id: `${entry.relativePath}::${label}`, file: entry.relativePath,
                    startLine: unit.startLine, endLine: unit.endLine, line: unit.line,
                    selector, conditional: !!unit.conditional, skipped: !!unit.skipped,
                    inherited: !!unit.inherited,
                    // A declaration the engine says stands for several tests.
                    generated: standsForSeveral(unit),
                    // Where the body of an inherited test stands.
                    ...(unit.inherited && {
                        origin: {
                            file: unit.inherited.file,
                            startLine: unit.inherited.startLine, endLine: unit.inherited.endLine,
                        },
                    }),
                    // The bodies the engine says the test may run instead
                    // (a method that may have replaced the inherited one).
                    ...(unit.alternatives && {
                        alternatives: unit.alternatives.map(body => ({
                            file: body.file, startLine: body.startLine, endLine: body.endLine,
                        })),
                    }),
                });
            }
        }
        // The commands for every test file of the project at once.
        const listed = new Set(files.filter(file => file.role === 'tests').map(file => file.file));
        const commands = commandsFor(model, entries.filter(([, entry]) => listed.has(entry.relativePath))
            .map(([filePath]) => filePath));
        for (const line of commands) lines.push(`all: ${line}`);
        return { lines, units, files, commands };
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
    const counts = {};
    for (const id of ran) counts[id] = (counts[id] || 0) + 1;
    return {
        ran: [...new Set(ran)].sort(),
        counts,
        status: result.status,
        output: `${result.stdout || ''}${result.stderr || ''}`,
    };
}

function sameSet(a, b) {
    return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * Is an executed identity a unit's? A unit owns the marks on its own
 * lines; a test that runs under a class it does not stand in owns its
 * run-time label, and the marks of the body the engine says it runs:
 * another body running is another test. Where the engine says the test
 * may run one of several bodies (it calls such a test conditional), the
 * marks of each are the unit's; a body it does not name is not.
 */
function owns(unit, id) {
    if (id === unit.id) return true;
    const at = /^(.*):(\d+)$/.exec(id);
    if (!at) return false;
    const within = range => at[1] === range.file && Number(at[2]) >= range.startLine && Number(at[2]) <= range.endLine;
    return within(unit.inherited ? unit.origin : unit) || (unit.alternatives || []).some(within);
}

/**
 * A line of a body several classes share, owned in a file only by tests
 * the engine calls conditional there: the whole run does not say which
 * class executed it, so the file's own command is not held to it. Each
 * such test's own identity (its run-time label) is held to as before.
 */
function sharedBodyOnly(units, id) {
    return units.length > 0 && units.every(unit => unit.conditional && unit.inherited && id !== unit.id);
}

function fileOf(id) {
    return (/^(.*):(\d+)$/.exec(id) || /^(.*?)::/.exec(id) || [])[1];
}

function labelOf(unit) {
    return `${unit.id} (line ${unit.line})`;
}

/**
 * What a whole-project run says about an answer, with no command run:
 * the engine's units and files against the identities that executed.
 * @param {object} testCase - the case (its named exceptions)
 * @param {{units: object[], files: object[]}} answer
 * @param {string[]} ran - identities the whole run executed
 * @param {Object<string, number>} [counts] - how often each one executed
 * @returns {{problems: Array<{kind: string, detail: string}>, undeclared: string[]}}
 */
function judgeWholeRun(testCase, answer, ran, counts = {}) {
    const problems = [];
    const fail = (kind, detail) => problems.push({ kind, detail });
    for (const unit of answer.units) {
        // What is this unit's alone: its label when it runs under a class
        // it does not stand in (several classes share a body).
        const executed = ran.some(id => unit.inherited ? id === unit.id : owns(unit, id));
        if (unit.skipped) {
            if (executed) fail('FALSE-SKIP', `${labelOf(unit)} is called skipped and the runner executes it`);
            continue;
        }
        if (unit.conditional || (testCase.notRunByDefault || []).includes(unit.id)) continue;
        if (!ran.some(id => owns(unit, id))) {
            fail('FALSE-UNIT', `${labelOf(unit)} is listed and the runner never executes it`);
        }
    }
    // A weaker claim is a deliberate one.
    const sometimes = [...new Set(answer.units.filter(unit => unit.conditional).map(unit => unit.id))].sort();
    if (!sameSet(sometimes, (testCase.sometimes || []).slice().sort())) {
        fail('SOMETIMES', `units called conditional [${sometimes.join(', ')}], the case names [${(testCase.sometimes || []).slice().sort().join(', ')}]`);
    }
    for (const file of answer.files) {
        const listed = answer.units.filter(unit => unit.file === file.file && !unit.skipped).length;
        if (file.role === 'tests' && file.tests !== listed) {
            fail('COUNT', `${file.file} counts ${file.tests} tests and lists ${listed} that are not skipped`);
        }
        const executed = ran.filter(id => fileOf(id) === file.file);
        if (file.role === 'support' && executed.some(id => answer.units.every(unit => !owns(unit, id)))) {
            fail('FALSE-SUPPORT', `${file.file} is called support and the runner executes ${executed.join(', ')}`);
        }
    }
    const undeclared = ran.filter(id => !answer.units.some(unit => owns(unit, id)));
    const allowed = (testCase.undeclared || []).slice().sort();
    if (!sameSet(undeclared, allowed)) {
        fail('UNDECLARED', `the runner executes [${undeclared.join(', ')}], the case names [${allowed.join(', ')}]`);
    }
    // A body that executes more often than the tests listed for it. That
    // a test runs only sometimes says nothing about how often.
    const oftener = ran.filter(id => {
        const owners = answer.units.filter(unit => !unit.skipped && owns(unit, id));
        if (owners.some(unit => unit.generated)) return false;
        return (counts[id] || 1) > Math.max(1, owners.length);
    }).sort();
    // What the engine prints as a count is exact only where the runner
    // executes nothing more from the file.
    for (const file of answer.files) {
        if (file.role !== 'tests') continue;
        const beyond = [...undeclared, ...oftener].filter(id => fileOf(id) === file.file);
        if (beyond.length > 0 && !file.more) {
            fail('INEXACT-COUNT', `${file.file} is given ${file.tests} tests as an exact count and the runner executes more: ${[...new Set(beyond)].join(', ')}`);
        }
        if (file.linked && (file.linked.tests !== file.tests || file.linked.more !== file.more)) {
            fail('COUNT', `${file.file}: linking every line answers ${file.linked.tests} tests${file.linked.more ? ' (a lower bound)' : ''}, the file's own answer is ${file.tests}${file.more ? ' (a lower bound)' : ''}`);
        }
    }
    const lowerBounds = answer.files.filter(file => file.more).map(file => file.file).sort();
    if (!sameSet(lowerBounds, (testCase.atLeast || []).slice().sort())) {
        fail('LOWER-BOUND', `files whose count is given as a lower bound [${lowerBounds.join(', ')}], the case names [${(testCase.atLeast || []).slice().sort().join(', ')}]`);
    }
    // One declaration is one test: a body that executes more often than
    // the tests listed for it is a test the engine does not list (a second
    // name for one function, a class collected twice), unless the case
    // says the declaration stands for several (a table of cases, a loop).
    const repeated = oftener;
    if (!sameSet(repeated, (testCase.repeats || []).slice().sort())) {
        fail('REPEATED', `executed more often than the tests listed for them [${repeated.map(id => `${id} x${counts[id]}`).join(', ')}], the case names [${(testCase.repeats || []).slice().sort().join(', ')}]`);
    }
    return { problems, undeclared };
}

/**
 * What the joined commands say against the files' own: together they must
 * execute exactly what the files' own commands execute one by one. A test
 * one file's command runs and the joined one drops (a focus in another
 * file of the same run) is lost; one only the joined command runs was never
 * offered by a file.
 * @param {string[]} own - identities the files' own commands executed
 * @param {string[]} joined - identities the joined commands executed
 * @returns {Array<{kind: string, detail: string}>}
 */
function judgeJoined(own, joined) {
    const problems = [];
    const lost = [...new Set(own)].filter(id => !joined.includes(id)).sort();
    const extra = [...new Set(joined)].filter(id => !own.includes(id)).sort();
    if (lost.length > 0) problems.push({ kind: 'WRONG-SELECTOR', detail: `the joined commands do not run ${lost.join(', ')}, which the files' own commands run` });
    if (extra.length > 0) problems.push({ kind: 'WRONG-SELECTOR', detail: `the joined commands run ${extra.join(', ')}, which no file's own command runs` });
    return problems;
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

            if (!present.has(testCase.runner)) present.set(testCase.runner, runnerVersion(testCase.runner));
            if (present.get(testCase.runner) === null) {
                missing.add(testCase.runner);
                continue;
            }
            const spec = RUNNERS[testCase.runner];
            if (spec.modules) {
                for (const moduleDir of testCase.moduleDirs || ['']) {
                    fs.symlinkSync(process.env.UCN_JS_TEST_MODULES, path.join(dir, moduleDir, 'node_modules'), 'dir');
                }
            }
            // go reports a cached result for a package it already ran with
            // the same flags, and executes nothing: every run here must run.
            // CI is unset: runners change what they accept under it
            // (vitest rejects a focused test), and the claims are about a
            // run on a developer's machine.
            const env = toolEnv({ CARGO_TARGET_DIR: cargoTarget, NO_COLOR: '1', GOFLAGS: '-count=1' });
            delete env.CI;
            const cwd = path.join(dir, testCase.cwd || '');
            const full = runRecorded(testCase.full || spec.full, cwd, env);
            const label = labelOf;
            totals.judged++;
            totals.units += answer.units.length;
            if (full.ran.length === 0 && answer.units.some(unit => !unit.conditional && !unit.skipped)) {
                fail('RUNNER-RAN-NOTHING', `${testCase.full || spec.full} (exit ${full.status})\n${full.output.slice(-1500)}`);
                continue;
            }
            const named = namedIdentities(testCase);
            const whole = judgeWholeRun(named, answer, full.ran, full.counts);
            for (const problem of whole.problems) fail(problem.kind, problem.detail);
            totals.undeclared += whole.undeclared.length;
            const empty = [];
            const ownRan = new Set();
            // Tests only the order of a whole run executes, as the case names them.
            const orderOnly = new Set(named.onlyInWholeRun || []);
            const orderLost = new Set();
            for (const file of answer.files) {
                if (file.role !== 'tests' || !file.run) continue;
                // What the file's own tests executed in the whole run.
                const mine = full.ran.filter(id => answer.units.some(unit => unit.file === file.file && owns(unit, id)));
                totals.fileCommands++;
                const got = runRecorded(file.run, dir, env);
                for (const id of got.ran) ownRan.add(id);
                if (got.ran.length === 0) empty.push(file.file);
                const lost = mine.filter(id => !got.ran.includes(id)).filter(id => {
                    const units = answer.units.filter(unit => unit.file === file.file && owns(unit, id));
                    if (sharedBodyOnly(units, id)) return false;
                    if (!orderOnly.has(id) || !units.every(unit => unit.conditional)) return true;
                    orderLost.add(id);
                    return false;
                });
                if (lost.length > 0) {
                    fail('WRONG-SELECTOR', `${file.run} does not run ${lost.join(', ')} (exit ${got.status})\n${got.output.slice(-800)}`);
                }
                // A file's command runs that file: a test of another
                // file it executes was never asked for.
                // go runs a package and cargo a module with the modules
                // under it; a test declared inside a function of another
                // file is this file's when this file calls the function,
                // and the file's count has to be a lower bound then.
                const foreign = spec.fileIsModuleTree ? [] : got.ran.filter(id => fileOf(id) !== file.file &&
                    !answer.units.some(unit => unit.file === file.file && owns(unit, id)) &&
                    !(spec.fileIsPackage && path.posix.dirname(fileOf(id) || '') === path.posix.dirname(file.file)) &&
                    !(file.more && answer.units.some(unit => unit.generated && owns(unit, id))));
                if (foreign.length > 0) {
                    fail('WRONG-SELECTOR', `${file.run} runs tests of other files: ${foreign.join(', ')}`);
                }
            }
            const unused = [...orderOnly].filter(id => !orderLost.has(id)).sort();
            if (unused.length > 0) {
                fail('WRONG-SELECTOR', `the case names [${unused.join(', ')}] as run only by the order of a whole run; a file's own command runs them, or the engine does not call them conditional`);
            }
            empty.sort();
            if (!sameSet(empty, (testCase.emptyTestFiles || []).slice().sort())) {
                fail('EMPTY-FILE', `test files whose command runs nothing [${empty.join(', ')}], the case names [${(testCase.emptyTestFiles || []).slice().sort().join(', ')}]`);
            }
            // Joined commands run what the files' own commands run, no
            // less and no more, and a file that has no command of its own
            // is in none of them.
            if (answer.commands.length > 0) {
                totals.joined = (totals.joined || 0) + answer.commands.length;
                const ran = new Set();
                for (const line of answer.commands) for (const id of runRecorded(line, dir, env).ran) ran.add(id);
                for (const problem of judgeJoined([...ownRan], [...ran])) {
                    fail(problem.kind, `${problem.detail} [${answer.commands.join(' ; ')}]`);
                }
            }
            for (const file of answer.files) {
                if (file.role === 'tests' && file.run) continue;
                if (answer.commands.some(line => line.split(/\s+/).includes(file.file))) {
                    fail('WRONG-SELECTOR', `a joined command names ${file.file}, which has no command of its own`);
                }
            }
            for (const unit of answer.units) {
                if (!unit.selector) continue;
                totals.selectors++;
                const got = runRecorded(unit.selector, dir, env);
                const foreign = got.ran.filter(id => !owns(unit, id));
                // A unit that may not execute (named by its case) may run nothing.
                const nothing = got.ran.length === 0 && !unit.skipped && !unit.conditional;
                if (foreign.length > 0 || nothing) {
                    fail('WRONG-SELECTOR', `${unit.selector} ran [${got.ran.join(', ')}], expected only ${label(unit)} (exit ${got.status})\n${got.output.slice(-800)}`);
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

    const runners = {};
    for (const runner of [...present.keys()].sort()) runners[runner] = present.get(runner);
    const judgedBy = Object.entries(runners).filter(([, version]) => version)
        .map(([runner, version]) => `${runner} (${version})`).join(' | ');
    console.log(`runners: ${judgedBy || 'none'}`);
    console.log(`test-unit matrix: ${totals.cases} cases, ${totals.judged} judged by their runner`);
    console.log(`  units listed: ${totals.units} · unit selectors run: ${totals.selectors} · file commands run: ${totals.fileCommands} · joined commands run: ${totals.joined || 0}`);
    console.log(`  units without a command: ${totals.withheld} · runner tests the engine does not list (named by their cases): ${totals.undeclared}`);
    for (const failure of failures) console.log(`FAIL ${failure}`);
    console.log(failures.length === 0 ? 'PASS' : `FAILED (${failures.length})`);

    const reports = process.env.UCN_EVAL_REPORTS_DIR;
    if (reports) {
        fs.mkdirSync(reports, { recursive: true });
        const date = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(path.join(reports, `test-unit-matrix-${date}.json`),
            JSON.stringify({ totals, runners, missing: [...missing].sort(), failures, rows }, null, 2));
    }
    process.exit(failures.length === 0 ? 0 : 1);
}

if (require.main === module) main();

module.exports = { answerOf, materialize, judgeWholeRun, judgeJoined, namedIdentities, sharedBodyOnly, RUNNERS };
