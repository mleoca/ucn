#!/usr/bin/env node
'use strict';

// A public, generated multi-symbol diff. This reports timings and answer
// columns together; it neither changes a performance baseline nor gates.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');

function value(args, flag, fallback) {
    const equals = args.find(arg => arg.startsWith(`${flag}=`));
    if (equals) return equals.slice(flag.length + 1);
    const at = args.indexOf(flag);
    return at < 0 ? fallback : args[at + 1];
}

function profile(args = process.argv.slice(2)) {
    const engine = path.resolve(value(args, '--engine-root', path.join(__dirname, '..')));
    const count = (flag, fallback, maximum) => {
        const number = Number(value(args, flag, fallback));
        if (!Number.isInteger(number) || number < 1 || number > maximum) {
            throw new Error(`${flag} must be an integer from 1 to ${maximum}`);
        }
        return number;
    };
    const symbols = count('--symbols', 57, 1000);
    const backgroundFiles = count('--background-files', 150, 5000);
    const foreignTests = count('--foreign-tests', 100, 5000);
    const samples = count('--samples', 3, 20);
    const change = value(args, '--change', 'added');
    if (!['added', 'modified'].includes(change)) throw new Error('--change must be added or modified');
    const { ProjectIndex } = require(path.join(engine, 'core/project'));
    const { execute } = require(path.join(engine, 'core/execute'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-profile-check-'));
    const write = (file, text) => {
        const destination = path.join(root, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, text);
    };
    const library = delta => Array.from({ length: symbols }, (_, i) =>
        `def operation_${i}() -> int:\n    return ${i + delta}\n`).join('\n') +
        '\ndef bridge() -> int:\n    return sum([\n' + Array.from({ length: symbols }, (_, i) =>
            `        operation_${i}(),\n`).join('') + '    ])\n' +
        '\ndef main() -> int:\n    return bridge()\n\ndef dispatch() -> int:\n    return main()\n';
    const baseline = change === 'added'
        ? 'def bridge() -> int:\n    return 0\n\ndef main() -> int:\n    return bridge()\n\ndef dispatch() -> int:\n    return main()\n'
        : library(0);
    const expectedSum = change === 'added' ? 0 : symbols * (symbols - 1) / 2;
    const nameCatalog = JSON.stringify(Array.from({ length: symbols }, (_, i) => `operation_${i}`));
    const git = (...command) => execFileSync('git', [
        '-c', 'user.name=UCN fixture', '-c', 'user.email=fixture@example.test',
        '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...command,
    ], { cwd: root, stdio: 'pipe' });
    try {
        write('pyproject.toml', '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
        write('library.py', baseline);
        write('other.py', 'def main():\n    return 0\n');
        write('tests/test_near.py', `from library import bridge\ndef test_near():\n    assert bridge() == ${expectedSum}\n`);
        write('tests/test_boundary.py', `from library import main\ndef test_boundary():\n    assert main() == ${expectedSum}\n`);
        write('tests/test_real.py', `from library import dispatch\ndef test_real():\n    assert dispatch() == ${expectedSum}\n`);
        for (let i = 0; i < backgroundFiles; i++) {
            write(`src/module_${i}.py`, 'from typing import Annotated\n\ndef marker():\n    return 0\n\n' +
                `def operation_${i % symbols}(value: "Annotated[int, marker()]") -> int:\n    return ${i}\n\n` +
                `KNOWN_NAMES = ${nameCatalog}\n`);
        }
        for (let i = 0; i < foreignTests; i++) {
            write(`tests/test_foreign_${i}.py`, 'import other\ndef test_foreign():\n    assert other.main() == 0\n');
        }
        git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'generated baseline');
        write('library.py', library(1));
        const start = performance.now();
        const index = new ProjectIndex(root);
        index.build(null, { quiet: true, workers: 0 });
        const buildMs = performance.now() - start;
        const runs = [];
        for (let i = 0; i < samples; i++) {
            const started = performance.now();
            const execution = execute(index, 'check', { base: 'HEAD' });
            const elapsedMs = performance.now() - started;
            if (!execution.ok) throw new Error(JSON.stringify(execution.error));
            const result = execution.result;
            runs.push({ elapsedMs, trust: result.trust?.status,
                changed: (result.changed || []).map(item => ({ name: item.name,
                    verdict: item.verdict, reasons: item.reasons })),
                testFiles: result.testFiles, totalTests: result.totalTests,
            });
        }
        return { engine, version: require(path.join(engine, 'package.json')).version,
            node: process.version, workload: { change, symbols, backgroundFiles, foreignTests,
                changedDeclarations: symbols + (change === 'added' ? 1 : 0) },
            expected: { withinDepth: ['tests/test_boundary.py', 'tests/test_near.py',
                ...(change === 'added' ? ['tests/test_real.py'] : [])],
                beyondDefaultDepth: change === 'added' ? [] : ['tests/test_real.py'], foreignTestsSelected: 0 },
            mode: 'one in-memory index; first and repeated whole check operations',
            indexedFiles: index.files.size, buildMs, runs };
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (require.main === module) {
    try { process.stdout.write(JSON.stringify(profile(), null, 2) + '\n'); }
    catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

module.exports = { profile };
