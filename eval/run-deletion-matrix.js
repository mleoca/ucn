#!/usr/bin/env node
/**
 * eval/run-deletion-matrix.js - is a deletion the engine clears accepted by
 * the compiler?
 *
 * For every case in eval/deletion-matrix-cases.js:
 *   1. the project is written out and its toolchain must accept it;
 *   2. the engine assesses deleting the marked declaration, in place;
 *   3. the declaration is deleted and the toolchain judges the result;
 *   4. the index is rebuilt and the saved record is assessed again, with
 *      and without the file facts of the revision it came from (the path a
 *      diff takes: the declaration is no longer in the index).
 *
 * A FALSE-SAFE answer is `no-static-dependents` for a deletion the
 * toolchain rejects. The run fails on any false-safe answer, on a case
 * whose toolchain verdict is not the one the case records (the fixture no
 * longer tests what it says), on a baseline the toolchain rejects, and on
 * an answer that changes once the declaration is gone. A judge-clean case
 * the engine does not clear is over-caution: reported, never a failure.
 *
 * A language whose toolchain is not installed is listed as not judged. That
 * is not a pass: the run fails unless --allow-missing says a partial run is
 * what was asked for, and a run that judged nothing always fails.
 *
 * usage: node eval/run-deletion-matrix.js [--allow-missing] [--only <substring>]
 *   JAVAC and CXX override the Java and C++ compilers.
 *   UCN_EVAL_REPORTS_DIR, when set, receives deletion-matrix-<date>.json.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { ProjectIndex } = require('../core/project');
const { assessDeletion } = require('../core/deletion');
const { CASES, materialize, deleteTarget } = require('./deletion-matrix-cases');

const BIN = path.join(__dirname, '..', 'node_modules', '.bin');
const JAVAC = process.env.JAVAC || 'javac';
const CXX = process.env.CXX || 'clang++';
const TIMEOUT_MS = 180000;

// probe: a command that succeeds when the toolchain is usable.
// prepare: run before each judging (dependency restore).
// judge: exit 0 = the project is accepted.
const TOOLCHAINS = {
    ts: {
        label: 'tsc --noEmit --strict',
        probe: [path.join(BIN, 'tsc'), ['--version']],
        judge: files => [path.join(BIN, 'tsc'),
            ['--noEmit', '--strict', '--target', 'es2020', ...files.filter(f => f.endsWith('.ts'))]],
    },
    py: {
        label: 'pyright',
        probe: [path.join(BIN, 'pyright'), ['--version']],
        judge: files => [path.join(BIN, 'pyright'), files.filter(f => f.endsWith('.py'))],
    },
    go: {
        label: 'go vet ./...',
        probe: ['go', ['version']],
        judge: () => ['go', ['vet', './...']],
    },
    rs: {
        label: 'rustc --emit=metadata',
        probe: ['rustc', ['--version']],
        judge: files => ['rustc', ['--edition', '2021', '--crate-type', 'lib', '--emit=metadata',
            '-o', 'out.rmeta', '-A', 'warnings', files.find(f => f.endsWith('.rs'))]],
    },
    java: {
        label: 'javac',
        probe: [JAVAC, ['-version']],
        judge: files => [JAVAC, ['-d', 'out', ...files.filter(f => f.endsWith('.java'))]],
    },
    cs: {
        label: 'dotnet build',
        probe: ['dotnet', ['--version']],
        prepare: () => ['dotnet', ['restore', '-nologo', '-v', 'q']],
        judge: () => ['dotnet', ['build', '-nologo', '-v', 'q', '--no-restore']],
    },
    cpp: {
        label: `${CXX} (compile and link)`,
        probe: [CXX, ['--version']],
        judge: files => [CXX, ['-std=c++17', ...files.filter(f => f.endsWith('.cpp')), '-o', 'a.out']],
    },
};
const BUILD_OUTPUTS = ['out', 'obj', 'bin', 'a.out', 'out.rmeta'];

function succeeds(command, cwd) {
    const [cmd, args] = command;
    try {
        execFileSync(cmd, args, { cwd, stdio: 'pipe', timeout: TIMEOUT_MS });
        return true;
    } catch (error) {
        // No exit status: the tool did not run (missing, killed, timed out).
        if (error.status == null) throw error;
        return false;
    }
}

function available(toolchain) {
    try { return succeeds(toolchain.probe, os.tmpdir()); } catch { return false; }
}

function buildIndex(root) {
    const index = new ProjectIndex(root);
    index.build(null, { quiet: true });
    return index;
}

function answerOf(assessment) {
    return `${assessment.verdict}/${assessment.reason}`;
}

function runCase(testCase, toolchain) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-deletion-matrix-')));
    try {
        const target = materialize(testCase, root);
        const files = Object.keys(testCase.files);
        const judge = () => {
            for (const output of BUILD_OUTPUTS) fs.rmSync(path.join(root, output), { recursive: true, force: true });
            if (toolchain.prepare) succeeds(toolchain.prepare(files), root);
            return succeeds(toolchain.judge(files), root) ? 'clean' : 'break';
        };
        const baseline = judge();
        const before = buildIndex(root);
        const definitions = (before.symbols.get(testCase.name) || []).filter(definition =>
            definition.relativePath === target.file &&
            definition.startLine >= target.from && definition.startLine <= target.to);
        if (definitions.length !== 1) {
            return { id: testCase.id, problem: `the marked lines hold ${definitions.length} declarations of ${testCase.name}` };
        }
        const definition = definitions[0];
        const inPlace = answerOf(assessDeletion(before, definition));
        const record = JSON.parse(JSON.stringify(definition));
        const fileEntry = before.files.get(definition.file);
        deleteTarget(root, target);
        const judged = judge();
        const after = buildIndex(root);
        return {
            id: testCase.id,
            baseline,
            judged,
            expect: testCase.expect,
            inPlace,
            absent: answerOf(assessDeletion(after, record, { fileEntry })),
            recordOnly: answerOf(assessDeletion(after, record)),
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
    const totals = { judged: 0, falseSafe: 0, overCautious: 0, problems: 0, notJudged: 0 };
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
            for (const [label, answer] of [['in place', row.inPlace], ['deleted', row.absent], ['record only', row.recordOnly]]) {
                const cleared = answer.startsWith('no-static-dependents/');
                if (row.judged === 'break' && cleared) { flags.push(`FALSE-SAFE ${label}`); totals.falseSafe++; }
                if (row.judged === 'clean' && !cleared) { flags.push(`over-cautious ${label}`); totals.overCautious++; }
            }
            if (row.inPlace !== row.absent || row.inPlace !== row.recordOnly) {
                flags.push('PROBLEM the answer changes once the declaration is deleted');
                totals.problems++;
            }
        }
        row.flags = flags;
        rows.push(row);
        console.log(`${row.id.padEnd(38)} ${String(row.judged || '-').padEnd(6)} ${String(row.inPlace || '-').padEnd(42)} ${flags.join('; ')}`);
    }

    const missing = Object.keys(TOOLCHAINS).filter(lang => !usable[lang] &&
        CASES.some(testCase => testCase.lang === lang && (!only || testCase.id.includes(only))));
    for (const lang of missing) {
        const count = rows.filter(row => row.notJudged && CASES.find(c => c.id === row.id).lang === lang).length;
        console.log(`NOT JUDGED: ${count} ${lang} case(s), ${TOOLCHAINS[lang].label} is not available`);
    }
    const failed = totals.falseSafe > 0 || totals.problems > 0 || totals.judged === 0 ||
        (!allowMissing && totals.notJudged > 0);
    const verdict = failed ? 'FAIL' : (totals.notJudged > 0 ? 'PASS (partial)' : 'PASS');
    console.log(`\nDELETION MATRIX: ${verdict} (${totals.judged} judged, ` +
        `${totals.falseSafe} false-safe, ${totals.overCautious} over-cautious, ` +
        `${totals.problems} problem(s), ${totals.notJudged} not judged)`);

    const reportsDir = process.env.UCN_EVAL_REPORTS_DIR;
    if (reportsDir) {
        fs.mkdirSync(reportsDir, { recursive: true });
        const file = path.join(reportsDir, `deletion-matrix-${new Date().toISOString().slice(0, 10)}.json`);
        fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, totals, allowMissing, rows }, null, 2));
        console.log(`  JSON: ${file}`);
    }
    process.exit(failed ? 1 : 0);
}

if (require.main === module) main();

module.exports = { TOOLCHAINS, runCase };
