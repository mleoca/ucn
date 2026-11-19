#!/usr/bin/env node
/**
 * eval/run-check-matrix.js - does the pre-commit check agree with the
 * compiler about what a change breaks?
 *
 * For every case in eval/check-matrix-cases.js:
 *   1. the base project is committed and its toolchain must accept it;
 *   2. the change is applied to the worktree and `check` answers;
 *   3. the toolchain judges the changed project;
 *   4. the change is staged and `check --staged` answers from an exported
 *      snapshot of the git index.
 *
 * The toolchain's exit status is its verdict on the whole change (`expect`).
 * Its errors are read with their locations (eval/check-scoring.js), so each
 * new error is placed on a line the change wrote or on one it did not.
 * FALSE-READY is READY_FOR_TOOLCHAIN (or "no changes to analyze") while the
 * toolchain reports a new error on a line the change did not write (or one
 * with no location); the outcome gate scores `check` by the same rule.
 * FALSE-BLOCKED is BLOCKED for a change the toolchain accepts: BLOCKED claims
 * a break was observed. The run fails on either (a false-ready an exact pin
 * names is printed as a known gap), on a stale pin, on a toolchain verdict
 * that is not the one the case records, on a baseline the toolchain
 * rejects, on a staged answer that differs from the worktree's, and on any
 * language it could not judge (a missing toolchain is never a pass;
 * --allow-missing permits a partial run, a run that judged nothing always
 * fails). READY for a change whose every new error is on a line it wrote
 * is reported (`ready-with-local-break`, each case listed by id), and so is
 * every READY the toolchain rejects anywhere (`ready-while-rejected`). REVIEW
 * on a clean change is reported as over-caution, never a failure.
 *
 * usage: node eval/run-check-matrix.js [--allow-missing] [--only <substring>]
 *   JAVAC and CXX override the Java and C++ compilers.
 *   UCN_EVAL_REPORTS_DIR, when set, receives check-matrix-<date>.json,
 *   which names the version of every toolchain that judged.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { ProjectIndex } = require('../core/project');
const { check } = require('../core/check');
const { CASES } = require('./check-matrix-cases');
const { TOOLCHAINS, toolchainVersions } = require('./run-deletion-matrix');
const { KNOWN_FALSE_READY, writtenLinesOf, locate, placeNewErrors, columnOf, scoreRun } = require('./check-scoring');

const TIMEOUT_MS = 180000;
const BUILD_OUTPUTS = ['out', 'obj', 'bin', 'a.out', 'out.rmeta'];

/** Exit status and everything the command printed. */
function run(command, cwd) {
    const [cmd, args] = command;
    try {
        const stdout = execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
        return { ok: true, output: stdout };
    } catch (error) {
        if (error.status == null) throw error;
        return { ok: false, output: `${error.stdout || ''}\n${error.stderr || ''}` };
    }
}

function succeeds(command, cwd) {
    return run(command, cwd).ok;
}

/**
 * The judge's own command, asked to print its errors with their locations:
 * pyright as its JSON document, rustc one line per diagnostic, tsc without
 * decoration. The exit status is the same verdict.
 */
function locatingCommand(lang, [cmd, args]) {
    if (lang === 'py') return [cmd, ['--outputjson', ...args]];
    if (lang === 'rs') return [cmd, ['--error-format=short', ...args]];
    if (lang === 'ts') return [cmd, ['--pretty', 'false', ...args]];
    return [cmd, args];
}

/**
 * One judging: the verdict and the run's errors, located. `go vet` stops at
 * a package's first type error, so a rejected Go change is also compiled
 * with every error reported; that run only adds locations.
 */
function judgeLocated(lang, toolchain, files, root) {
    const verdict = run(locatingCommand(lang, toolchain.judge(files)), root);
    let output = verdict.output;
    if (!verdict.ok && lang === 'go') output += `\n${run(['go', ['build', '-gcflags=-e', './...']], root).output}`;
    return { verdict: verdict.ok ? 'clean' : 'break', located: locate(lang, output, root) };
}

function git(cwd, ...args) {
    return execFileSync('git', ['-c', 'user.email=eval@example.test', '-c', 'user.name=eval', ...args],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeFiles(root, files) {
    for (const [file, content] of Object.entries(files)) {
        const target = path.join(root, file);
        if (content === null) {
            fs.rmSync(target, { force: true });
            continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
}

/** The check's answer as one comparable line. */
function answerOf(result) {
    if (!result || result.ok === false) return `DID-NOT-RUN(${result ? result.status : 'no result'})`;
    if (result.empty) return 'NO-CHANGES';
    return result.trust.status;
}

function detailOf(result) {
    return (result && result.changed ? result.changed : []).map(item =>
        `${item.name}:${item.kind}=${item.verdict}${item.reasons && item.reasons.length ? `(${item.reasons.join(',')})` : ''}`)
        .join(' ');
}

function buildIndex(root) {
    const index = new ProjectIndex(root);
    index.build(null, { quiet: true });
    return index;
}

/** Stage 1: a fresh repository holding the base project. */
function materialize(testCase) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-check-matrix-')));
    writeFiles(root, testCase.base);
    // Build products are not part of the project under test.
    fs.writeFileSync(path.join(root, '.gitignore'), BUILD_OUTPUTS.map(name => `/${name}`).join('\n') + '\n');
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    return root;
}

/** The check's answers for one case: worktree, then staged from a snapshot. */
function answersFor(testCase, root) {
    writeFiles(root, testCase.after);
    const worktree = check(buildIndex(root), {});
    git(root, 'add', '-A');
    const staged = check(buildIndex(root), { staged: true, forceStagedSnapshot: true });
    return { worktree, staged };
}

function runCase(testCase, toolchain) {
    const root = materialize(testCase);
    try {
        const files = [...new Set([...Object.keys(testCase.base), ...Object.keys(testCase.after)])];
        const judge = () => {
            for (const output of BUILD_OUTPUTS) fs.rmSync(path.join(root, output), { recursive: true, force: true });
            const present = files.filter(file => fs.existsSync(path.join(root, file)));
            if (toolchain.prepare) succeeds(toolchain.prepare(present), root);
            return judgeLocated(testCase.lang, toolchain, present, root);
        };
        const baseline = judge();
        for (const output of BUILD_OUTPUTS) fs.rmSync(path.join(root, output), { recursive: true, force: true });
        const { worktree, staged } = answersFor(testCase, root);
        const judged = judge();
        const placement = placeNewErrors(baseline.located, judged.located, writtenLinesOf(testCase), judged.verdict === 'break');
        return {
            id: testCase.id,
            lang: testCase.lang,
            baseline: baseline.verdict,
            judged: judged.verdict,
            expect: testCase.expect,
            answer: answerOf(worktree),
            detail: detailOf(worktree),
            staged: answerOf(staged),
            stagedDetail: detailOf(staged),
            placement,
            // Where a rejected change's new errors are: all on lines the
            // change wrote, or one at least elsewhere.
            ...(judged.verdict === 'break' && { locality: placement.outside > 0 ? 'outside' : 'local' }),
        };
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

const COLUMNS = [
    ['false-ready', 'gate: READY while a new error is on a line the change did not write'],
    ['known-false-ready', 'pinned gaps, each named by case and toolchain diagnostic'],
    ['ready-with-local-break', 'reported: READY while every new error is on a line the change wrote'],
    ['ready-while-rejected', 'reported: READY while the toolchain rejects the change anywhere'],
    ['false-blocked', 'gate: BLOCKED for a change the toolchain accepts'],
    ['over-cautious', 'reported: REVIEW for a change the toolchain accepts'],
];

function main() {
    const args = process.argv.slice(2);
    const allowMissing = args.includes('--allow-missing');
    const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
    const toolchains = toolchainVersions();
    const usable = {};
    for (const lang of Object.keys(TOOLCHAINS)) usable[lang] = toolchains[lang] !== null;

    const rows = [];
    const totals = { judged: 0, problems: 0, notJudged: 0 };
    const pins = new Map(KNOWN_FALSE_READY.map(pin => [pin.id, pin]));
    for (const testCase of CASES) {
        if (only && !testCase.id.includes(only)) continue;
        if (!usable[testCase.lang]) {
            totals.notJudged++;
            rows.push({ id: testCase.id, notJudged: true });
            continue;
        }
        let row;
        try {
            row = runCase(testCase, TOOLCHAINS[testCase.lang]);
        } catch (error) {
            row = { id: testCase.id, problem: `could not run: ${String(error.message).split('\n')[0].slice(0, 120)}` };
        }
        const flags = [];
        if (row.problem) {
            flags.push(`PROBLEM ${row.problem}`);
            totals.problems++;
        } else {
            totals.judged++;
            if (row.baseline !== 'clean') { flags.push('PROBLEM the toolchain rejects the baseline'); totals.problems++; }
            if (row.judged !== row.expect) {
                flags.push(`PROBLEM the toolchain says ${row.judged}, the case records ${row.expect}`);
                totals.problems++;
            }
            const column = columnOf(row);
            if (column === 'false-ready') flags.push(pins.has(row.id) ? 'known false-ready (pinned)' : 'FALSE-READY');
            else if (column === 'false-blocked') flags.push('FALSE-BLOCKED');
            else if (column) flags.push(column);
            if (row.locality) flags.push(`errors ${row.locality}`);
            if (row.staged !== row.answer || row.stagedDetail !== row.detail) {
                flags.push(`PROBLEM the staged answer differs: ${row.staged} ${row.stagedDetail}`);
                totals.problems++;
            }
        }
        row.flags = flags;
        rows.push(row);
        console.log(`${row.id.padEnd(38)} ${String(row.judged || '-').padEnd(6)} ${String(row.answer || '-').padEnd(20)} ${row.detail || ''} ${flags.join('; ')}`);
    }

    const missing = Object.keys(TOOLCHAINS).filter(lang => !usable[lang] &&
        CASES.some(testCase => testCase.lang === lang && (!only || testCase.id.includes(only))));
    for (const lang of missing) {
        const count = rows.filter(row => row.notJudged && CASES.find(c => c.id === row.id).lang === lang).length;
        console.log(`NOT JUDGED: ${count} ${lang} case(s), ${TOOLCHAINS[lang].label} is not available`);
    }
    const scored = scoreRun(rows.filter(row => !row.problem && !row.notJudged));
    for (const [name, list] of Object.entries(scored.columns)) totals[name] = list.length;
    console.log('');
    for (const [name, meaning] of COLUMNS) {
        const ids = scored.columns[name];
        console.log(`${name}: ${ids.length} (${meaning})`);
        for (const id of ids) {
            const pin = name === 'known-false-ready' ? pins.get(id) : null;
            console.log(`  ${id}${pin ? `  ${pin.evidence}` : ''}`);
        }
    }
    for (const notice of scored.notices) console.log(`notice: ${notice}`);
    for (const failure of scored.failures) console.log(failure);
    const failed = scored.failures.length > 0 || totals.problems > 0 ||
        totals.judged === 0 || (!allowMissing && totals.notJudged > 0);
    const verdict = failed ? 'FAIL' : (totals.notJudged > 0 ? 'PASS (partial)' : 'PASS');
    const judgedBy = Object.entries(toolchains).filter(([, version]) => version)
        .map(([lang, version]) => `${lang} ${version}`).join(' | ');
    console.log(`\ntoolchains: ${judgedBy || 'none'}`);
    console.log(`CHECK MATRIX: ${verdict} (${totals.judged} judged, ${totals['false-ready']} false-ready, ` +
        `${totals['known-false-ready']} known false-ready, ${totals['ready-with-local-break']} ready-with-local-break, ` +
        `${totals['ready-while-rejected']} ready-while-rejected, ${totals['false-blocked']} false-blocked, ` +
        `${totals['over-cautious']} over-cautious, ${totals.problems} problem(s), ${totals.notJudged} not judged)`);

    const reportsDir = process.env.UCN_EVAL_REPORTS_DIR;
    if (reportsDir) {
        fs.mkdirSync(reportsDir, { recursive: true });
        const file = path.join(reportsDir, `check-matrix-${new Date().toISOString().slice(0, 10)}.json`);
        fs.writeFileSync(file, JSON.stringify({
            schemaVersion: 2, totals, columns: scored.columns, failures: scored.failures, notices: scored.notices,
            knownFalseReady: KNOWN_FALSE_READY, allowMissing, toolchains, rows,
        }, null, 2));
        console.log(`  JSON: ${file}`);
    }
    process.exit(failed ? 1 : 0);
}

if (require.main === module) main();

module.exports = { materialize, answersFor, answerOf, detailOf, writeFiles, locatingCommand, runCase };
