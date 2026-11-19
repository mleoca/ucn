'use strict';

/**
 * fix #511: the check matrix scores READY by one definition with the outcome
 * gate. A false-ready is READY while the toolchain reports a new error on a
 * line the change did not write; the lines a change wrote come from the
 * case's own files. Pure logic, no toolchain: judge output below is captured
 * from the toolchains the matrix runs (tsc 7.0.2, pyright 1.1.411, go 1.25.1,
 * rustc 1.96.0 short format, javac 26.0.1, dotnet 9.0.305, clang 17).
 */

require('./helpers/cache-root');
const { describe, it } = require('node:test');
const assert = require('node:assert');

const scoring = require('../eval/check-scoring');

const L = (...lines) => lines.join('\n') + '\n';
const ROOT = '/private/var/folders/xx/T/ucn-check-matrix-abc123';

describe('fix #511: lines a change wrote, from the case alone', () => {
    it('reads an inserted line, a replaced line and a new file', () => {
        const before = L('def f(x):', '    y = x + 1', '    return y');
        assert.deepStrictEqual([...scoring.writtenLines(before, L('def f(x):', '    log(x)', '    y = x + 1', '    return y'))], [2]);
        assert.deepStrictEqual([...scoring.writtenLines(before, L('def f(x):', '    y = x + 2', '    return y'))], [2]);
        assert.deepStrictEqual([...scoring.writtenLines(undefined, L('a', 'b'))], [1, 2]);
    });

    it('a deleted file and a pure deletion write nothing', () => {
        assert.deepStrictEqual([...scoring.writtenLines(L('a', 'b'), null)], []);
        assert.deepStrictEqual([...scoring.writtenLines(L('a', 'b', 'c'), L('a', 'c'))], []);
    });

    it('text added after a repeated closing line is the added text', () => {
        const before = L('func f() int {', '    return 1', '}');
        const after = L('func f() int {', '    return 1', '}', '', 'func g() int {', '}');
        assert.deepStrictEqual([...scoring.writtenLines(before, after)], [4, 5, 6]);
    });

    it('ranges are contiguous runs per file, in file then line order', () => {
        const byFile = new Map([['b.ts', new Set([3])], ['a.ts', new Set([4, 2, 3, 7])]]);
        assert.deepStrictEqual(scoring.writtenRanges(byFile), [
            { file: 'a.ts', startLine: 2, endLine: 4 },
            { file: 'a.ts', startLine: 7, endLine: 7 },
            { file: 'b.ts', startLine: 3, endLine: 3 },
        ]);
    });

    it('a case names its files as written', () => {
        const byFile = scoring.writtenLinesOf({
            base: { 'lib.py': L('a', 'b'), 'gone.py': L('x') },
            after: { 'lib.py': L('a', 'B'), 'gone.py': null, 'new.py': L('n') },
        });
        assert.deepStrictEqual([...byFile].map(([file, lines]) => [file, [...lines]]),
            [['lib.py', [2]], ['gone.py', []], ['new.py', [1]]]);
    });
});

describe('fix #511: where a new error is (boundaries)', () => {
    // The change wrote lines 4-6 of a.py.
    const written = new Map([['a.py', new Set([4, 5, 6])]]);
    const run = (...diagnostics) => ({ keys: diagnostics.map(d => d.key), diagnostics });
    const place = (judged, baseline = { keys: [] }, rejected = true) =>
        scoring.placeNewErrors(baseline, judged, written, rejected);

    it('the first and the last written line are local', () => {
        assert.deepStrictEqual(place(run({ key: 'a.py|r|first', file: 'a.py', line: 4 })).outside, 0);
        assert.deepStrictEqual(place(run({ key: 'a.py|r|last', file: 'a.py', line: 6 })).local, 1);
    });

    it('the line before and the line after are outside', () => {
        assert.strictEqual(place(run({ key: 'a.py|r|before', file: 'a.py', line: 3 })).outside, 1);
        assert.strictEqual(place(run({ key: 'a.py|r|after', file: 'a.py', line: 7 })).outside, 1);
    });

    it('a line of another file is outside', () => {
        assert.strictEqual(place(run({ key: 'b.py|r|caller', file: 'b.py', line: 5 })).outside, 1);
    });

    it('one error with a location inside and one outside is outside', () => {
        const placed = place(run({ key: 'a.py|r|same', file: 'a.py', line: 5 }, { key: 'a.py|r|same', file: 'a.py', line: 9 }));
        assert.strictEqual(placed.local, 0);
        assert.ok(placed.outside > 0);
    });

    it('an error with no location is outside', () => {
        assert.strictEqual(place(run({ key: '|linker command failed', file: null, line: null })).outside, 1);
    });

    it('a rejected run with no error read is one error with no location', () => {
        const placed = place(run());
        assert.deepStrictEqual([placed.newErrors, placed.outside, placed.unread], [1, 1, true]);
        assert.deepStrictEqual(place(run(), { keys: [] }, false), { newErrors: 0, local: 0, outside: 0, outsideKeys: [], unread: false });
    });

    it('nothing in a deleted file is written', () => {
        const gone = scoring.placeNewErrors({ keys: [] }, run({ key: 'use.py|r|import', file: 'use.py', line: 1 }),
            scoring.writtenLinesOf({ base: { 'lib.py': L('x') }, after: { 'lib.py': null } }), true);
        assert.strictEqual(gone.outside, 1);
    });

    it('a baseline error that persists is not new, wherever it moved', () => {
        const baseline = { keys: ['b.py|r|old'] };
        const placed = place(run({ key: 'b.py|r|old', file: 'b.py', line: 12 }, { key: 'a.py|r|new', file: 'a.py', line: 5 }), baseline);
        assert.deepStrictEqual([placed.newErrors, placed.local, placed.outside], [1, 1, 0]);
    });

    it('a warning is not an error', () => {
        const text = [
            `${ROOT}/a.cs(3,16): warning CS8632: The annotation for nullable reference types should only be used in code within a '#nullable' annotations context. [${ROOT}/m.csproj]`,
            `${ROOT}/a.cs(5,28): error CS7036: There is no argument given that corresponds to the required parameter 'y' of 'A.F(int, int)' [${ROOT}/m.csproj]`,
        ].join('\n');
        const located = scoring.locate('cs', text, ROOT);
        assert.deepStrictEqual(located.diagnostics.map(d => [d.file, d.line]), [['a.cs', 5]]);
        assert.deepStrictEqual(scoring.locate('cpp', 'a.cpp:3:5: warning: unused variable \'x\' [-Wunused-variable]\n', ROOT).keys, []);
    });
});

describe('fix #511: judges read with their locations', () => {
    it('tsc: an error line, not its related information', () => {
        const text = 'lib.ts(5,14): error TS2420: Class \'Square\' incorrectly implements interface \'Shape\'.\n' +
            '  Property \'perimeter\' is missing in type \'Square\' but required in type \'Shape\'.\n';
        assert.deepStrictEqual(scoring.locate('ts', text, ROOT).diagnostics.map(d => [d.file, d.line]), [['lib.ts', 5]]);
    });

    it('pyright: the JSON document, errors only, lines from one', () => {
        const doc = JSON.stringify({ generalDiagnostics: [
            { file: `${ROOT}/use.py`, severity: 'error', message: 'Argument missing for parameter "y"',
                range: { start: { line: 2, character: 9 }, end: { line: 2, character: 13 } }, rule: 'reportCallIssue' },
            { file: `${ROOT}/use.py`, severity: 'warning', message: 'unused', range: { start: { line: 0, character: 0 } } },
        ] });
        const located = scoring.locate('py', doc, ROOT);
        assert.deepStrictEqual(located.diagnostics.map(d => [d.file, d.line]), [['use.py', 3]]);
        assert.deepStrictEqual(scoring.locate('py', 'not json', ROOT), { keys: [], diagnostics: [] });
    });

    it('go: vet\'s first error and the compiler\'s, continuation lines left out', () => {
        const text = '# example.com/m\nvet: ./b.go:3:12: not enough arguments in call to f\n\thave (number)\n\twant (int, int)\n' +
            '# example.com/m\n./b.go:3:11: not enough arguments in call to f\n\thave (number)\n\twant (int, int)\n' +
            './c.go:3:11: not enough arguments in call to f\n';
        const located = scoring.locate('go', text, ROOT);
        assert.deepStrictEqual(located.diagnostics.map(d => [d.file, d.line]), [['b.go', 3], ['b.go', 3], ['c.go', 3]]);
    });

    it('rustc short format: one line per error, the abort line left out', () => {
        const text = 'a.rs:4:26: error[E0061]: this function takes 2 arguments but 1 argument was supplied\n' +
            'error: aborting due to 1 previous error\n';
        assert.deepStrictEqual(scoring.locate('rs', text, ROOT).diagnostics.map(d => [d.file, d.line]), [['a.rs', 4]]);
    });

    it('javac: the error line, not the source excerpt or the footer', () => {
        const text = 'B.java:2: error: method f in class A cannot be applied to given types;\n    static int n = A.f(1);\n' +
            '                    ^\n  required: int,int\n  found:    int\n1 error\n';
        assert.deepStrictEqual(scoring.locate('java', text, ROOT).diagnostics.map(d => [d.file, d.line]), [['B.java', 2]]);
    });

    it('dotnet: each error once although MSBuild prints it twice', () => {
        const line = `${ROOT}/B.cs(2,22): error CS7036: There is no argument given that corresponds to the required parameter 'y' of 'A.F(int, int)' [${ROOT}/m.csproj]`;
        const text = `${line}\n\nBuild FAILED.\n\n${line}\n    0 Warning(s)\n    1 Error(s)\n`;
        const located = scoring.locate('cs', text, ROOT);
        assert.deepStrictEqual(located.diagnostics, [{ key: 'B.cs|CS7036|There is no argument given that corresponds to the required parameter \'y\' of \'A.F(int, int)\'', file: 'B.cs', line: 2 }]);
        assert.deepStrictEqual(located.keys, [located.diagnostics[0].key]);
        // Two errors on one line at two columns stay two.
        const two = `${ROOT}/B.cs(2,10): error CS0103: The name 'a' does not exist in the current context\n` +
            `${ROOT}/B.cs(2,20): error CS0103: The name 'a' does not exist in the current context\n`;
        assert.strictEqual(scoring.locate('cs', two, ROOT).keys.length, 2);
        const project = `MSBUILD : error MSB1009: Project file does not exist.\n`;
        assert.deepStrictEqual(scoring.locate('cs', project, ROOT).diagnostics.map(d => [d.file, d.line]), [[null, null]]);
    });

    it('clang: errors with their file, notes are not locations, a linker failure has none', () => {
        const text = [
            'a.cpp:2:10: error: out-of-line definition of \'f\' does not match any declaration in \'Box\'',
            '    2 | int Box::f(int x) { return x; }',
            '      |          ^',
            'a.cpp:3:33: error: too few arguments to function call, expected 2, have 1',
            './a.h:2:9: note: \'f\' declared here',
            '    2 |     int f(int x, int y);',
            '2 errors generated.',
        ].join('\n');
        assert.deepStrictEqual(scoring.locate('cpp', text, ROOT).diagnostics.map(d => [d.file, d.line]), [['a.cpp', 2], ['a.cpp', 3]]);
        const link = 'Undefined symbols for architecture arm64:\n  "f()", referenced from:\n      _main in a-1.o\n' +
            'ld: symbol(s) not found for architecture arm64\nclang++: error: linker command failed with exit code 1 (use -v to see invocation)\n';
        assert.deepStrictEqual(scoring.locate('cpp', link, ROOT).diagnostics,
            [{ key: '|linker command failed with exit code 1 (use -v to see invocation)', file: null, line: null }]);
    });
});

describe('fix #511: the columns of a run', () => {
    const outside = { outside: 1, local: 0 };
    const local = { outside: 0, local: 1 };
    const rows = [
        { id: 'a-ready-outside', answer: 'READY_FOR_TOOLCHAIN', judged: 'break', placement: outside },
        { id: 'b-ready-local', answer: 'READY_FOR_TOOLCHAIN', judged: 'break', placement: local },
        { id: 'c-no-changes-outside', answer: 'NO-CHANGES', judged: 'break', placement: outside },
        { id: 'd-review-break', answer: 'REVIEW_REQUIRED', judged: 'break', placement: outside },
        { id: 'e-blocked-clean', answer: 'BLOCKED', judged: 'clean' },
        { id: 'f-review-clean', answer: 'REVIEW_REQUIRED', judged: 'clean' },
        { id: 'g-ready-clean', answer: 'READY_FOR_TOOLCHAIN', judged: 'clean' },
        { id: 'h-pinned', answer: 'READY_FOR_TOOLCHAIN', judged: 'break', placement: outside },
    ];
    const lists = { knownFalseReady: [{ id: 'h-pinned', evidence: 'a.py:3 reportReturnType' }], readyLocalBreaks: ['b-ready-local'] };

    it('puts each case in its column', () => {
        const { columns } = scoring.scoreRun(rows, lists);
        assert.deepStrictEqual(columns, {
            'false-ready': ['a-ready-outside', 'c-no-changes-outside'],
            'known-false-ready': ['h-pinned'],
            'ready-with-local-break': ['b-ready-local'],
            'ready-while-rejected': ['a-ready-outside', 'b-ready-local', 'c-no-changes-outside', 'h-pinned'],
            'false-blocked': ['e-blocked-clean'],
            'over-cautious': ['f-review-clean'],
        });
    });

    it('fails on an unpinned false-ready and a false-blocked, never on a pinned one', () => {
        const { failures } = scoring.scoreRun(rows, lists);
        assert.deepStrictEqual(failures, ['FALSE-READY a-ready-outside', 'FALSE-READY c-no-changes-outside', 'FALSE-BLOCKED e-blocked-clean']);
    });

    it('a pin whose case is judged and not false-ready is stale; an unjudged one is not', () => {
        const { failures } = scoring.scoreRun([{ id: 'h-pinned', answer: 'REVIEW_REQUIRED', judged: 'break', placement: outside }], lists);
        assert.deepStrictEqual(failures, ['stale known false-ready pin h-pinned: the case is not false-ready; remove the pin']);
        assert.deepStrictEqual(scoring.scoreRun([], lists).failures, []);
    });

    it('a local break READY is reported against its list, never a failure', () => {
        const unlisted = scoring.scoreRun([rows[1]], { knownFalseReady: [], readyLocalBreaks: [] });
        assert.deepStrictEqual([unlisted.failures, unlisted.notices], [[], ['READY with a local break, not listed: b-ready-local']]);
        const moved = scoring.scoreRun([{ ...rows[1], answer: 'REVIEW_REQUIRED' }], lists);
        assert.deepStrictEqual([moved.failures, moved.notices], [[], ['listed as READY with a local break, and it is not: b-ready-local']]);
    });

    it('the lists name cases of the matrix, once each', () => {
        const { CASES } = require('../eval/check-matrix-cases');
        const ids = new Set(CASES.map(testCase => testCase.id));
        const pinned = scoring.KNOWN_FALSE_READY.map(pin => pin.id);
        for (const pin of scoring.KNOWN_FALSE_READY) {
            assert.ok(ids.has(pin.id), `${pin.id} is a case`);
            assert.ok(typeof pin.evidence === 'string' && pin.evidence.length > 0, `${pin.id} names its diagnostic`);
        }
        for (const id of scoring.READY_LOCAL_BREAKS) assert.ok(ids.has(id), `${id} is a case`);
        const all = [...pinned, ...scoring.READY_LOCAL_BREAKS];
        assert.strictEqual(new Set(all).size, all.length, 'no case is listed twice');
    });
});
