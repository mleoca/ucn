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
 * FALSE-READY is READY_FOR_TOOLCHAIN (or "no changes to analyze") for a
 * change the toolchain rejects. FALSE-BLOCKED is BLOCKED for a change the
 * toolchain accepts: BLOCKED claims a break was observed. The run fails on
 * either, on a toolchain verdict that is not the one the case records, on
 * a baseline the toolchain rejects, on a staged answer that differs from
 * the worktree's, and on any language it could not judge (a missing
 * toolchain is never a pass; --allow-missing permits a partial run, a run
 * that judged nothing always fails). REVIEW on a clean change is reported
 * as over-caution, never a failure.
 *
 * usage: node eval/run-check-matrix.js [--allow-missing] [--only <substring>]
 *   JAVAC and CXX override the Java and C++ compilers.
 *   UCN_EVAL_REPORTS_DIR, when set, receives check-matrix-<date>.json.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { ProjectIndex } = require('../core/project');
const { check } = require('../core/check');
const { CASES } = require('./check-matrix-cases');
const { TOOLCHAINS } = require('./run-deletion-matrix');

const TIMEOUT_MS = 180000;
const BUILD_OUTPUTS = ['out', 'obj', 'bin', 'a.out', 'out.rmeta'];
const READY = 'READY_FOR_TOOLCHAIN';
const BLOCKED = 'BLOCKED';

function succeeds(command, cwd) {
    const [cmd, args] = command;
    try {
        execFileSync(cmd, args, { cwd, stdio: 'pipe', timeout: TIMEOUT_MS });
        return true;
    } catch (error) {
        if (error.status == null) throw error;
        return false;
    }
}

function available(toolchain) {
    try { return succeeds(toolchain.probe, os.tmpdir()); } catch { return false; }
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
            return succeeds(toolchain.judge(present), root) ? 'clean' : 'break';
        };
        const baseline = judge();
        for (const output of BUILD_OUTPUTS) fs.rmSync(path.join(root, output), { recursive: true, force: true });
        const { worktree, staged } = answersFor(testCase, root);
        const judged = judge();
        return {
            id: testCase.id,
            baseline,
            judged,
            expect: testCase.expect,
            answer: answerOf(worktree),
            detail: detailOf(worktree),
            staged: answerOf(staged),
            stagedDetail: detailOf(staged),
        };
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function main() {
    const args = process.argv.slice(2);
    const allowMissing = args.includes('--allow-missing');
    const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
    const usable = {};
    for (const [lang, toolchain] of Object.entries(TOOLCHAINS)) usable[lang] = available(toolchain);

    const rows = [];
    const totals = { judged: 0, falseReady: 0, falseBlocked: 0, overCautious: 0, problems: 0, notJudged: 0 };
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
            const passes = row.answer === READY || row.answer === 'NO-CHANGES';
            if (row.judged === 'break' && passes) { flags.push('FALSE-READY'); totals.falseReady++; }
            if (row.judged === 'clean' && row.answer === BLOCKED) { flags.push('FALSE-BLOCKED'); totals.falseBlocked++; }
            if (row.judged === 'clean' && !passes && row.answer !== BLOCKED) { flags.push('over-cautious'); totals.overCautious++; }
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
    const failed = totals.falseReady > 0 || totals.falseBlocked > 0 || totals.problems > 0 ||
        totals.judged === 0 || (!allowMissing && totals.notJudged > 0);
    const verdict = failed ? 'FAIL' : (totals.notJudged > 0 ? 'PASS (partial)' : 'PASS');
    console.log(`\nCHECK MATRIX: ${verdict} (${totals.judged} judged, ${totals.falseReady} false-ready, ` +
        `${totals.falseBlocked} false-blocked, ${totals.overCautious} over-cautious, ` +
        `${totals.problems} problem(s), ${totals.notJudged} not judged)`);

    const reportsDir = process.env.UCN_EVAL_REPORTS_DIR;
    if (reportsDir) {
        fs.mkdirSync(reportsDir, { recursive: true });
        const file = path.join(reportsDir, `check-matrix-${new Date().toISOString().slice(0, 10)}.json`);
        fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, totals, allowMissing, rows }, null, 2));
        console.log(`  JSON: ${file}`);
    }
    process.exit(failed ? 1 : 0);
}

if (require.main === module) main();

module.exports = { materialize, answersFor, answerOf, detailOf, writeFiles };
