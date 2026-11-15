'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmp, rm, idx } = require('./helpers');
const { execute } = require('../core/execute');
const cases = require('../eval/check-outgoing-cases');

function git(dir, ...args) {
    return execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function write(dir, files) {
    for (const [file, source] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), source);
    }
}
function check(dir, options = {}) {
    const result = execute(idx(dir), 'check', options);
    assert.ok(result.ok, JSON.stringify(result));
    return result.result;
}

describe('fix #502: outgoing calls in changed code', () => {
    for (const fixture of cases) it(fixture.id, () => {
        const dir = tmp(fixture.base);
        try {
            git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
            write(dir, fixture.after);
            const result = check(dir);
            assert.strictEqual(result.trust.status, fixture.answer, fixture.id);
            const items = result.changed.filter(item => item.name === fixture.name);
            assert.ok(items.length, JSON.stringify(result));
            if (fixture.expect === 'break') assert.ok(items.some(item => item.verdict !== 'ready'), JSON.stringify(items));
            else assert.ok(items.every(item => item.verdict !== 'blocked'), JSON.stringify(items));
            git(dir, 'add', '-A');
            write(dir, fixture.base);
            const staged = check(dir, { staged: true });
            assert.deepStrictEqual(staged.changed.map(item => [item.name, item.verdict, item.reasons]),
                result.changed.map(item => [item.name, item.verdict, item.reasons]));
        } finally { rm(dir); }
    });

    it('new owner members do not capture unrelated homonyms', () => {
        const dir = tmp({ 'old.py': 'class Existing:\n    close: int = 1\n    date: str = "old"\n\ndef read():\n    return Existing.close\n' });
        try {
            git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
            write(dir, { 'fresh.py': 'class FreshRecord:\n    close: int = 5\n    date: str = "new"\n' });
            const result = check(dir);
            assert.ok(result.changed.every(item => item.verdict === 'ready'), JSON.stringify(result.changed));
        } finally { rm(dir); }
    });

    it('invalidly placed pyright setting still suppresses the call diagnostic', () => {
        const source = 'sentinel = 0  # pyright: reportCallIssue=false\n' +
            'def compute(value: int) -> int:\n    return value\n' +
            'def changed() -> int:\n    return compute()\n';
        const dir = tmp({ 'lib.py': source });
        try {
            git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
            write(dir, { 'lib.py': source.replace('return compute()', 'return compute(1, 2)') });
            const result = check(dir);
            assert.strictEqual(result.trust.status, 'REVIEW_REQUIRED', JSON.stringify(result.changed));
            const item = result.changed.find(row => row.name === 'changed');
            assert.ok(item.mismatches.length > 0);
            assert.ok(item.mismatches.every(row => row.unchecked));
            assert.deepStrictEqual(item.reasons, ['site-not-checked']);
            git(dir, 'add', '-A');
            write(dir, { 'lib.py': source });
            const staged = check(dir, { staged: true });
            assert.deepStrictEqual(staged.changed.map(row => [row.name, row.verdict, row.reasons]),
                result.changed.map(row => [row.name, row.verdict, row.reasons]));
        } finally { rm(dir); }
    });
});

describe('fix #502: unchanged call context controls', () => {
    const controls = [
        ['ts comment', 'lib.ts',
            'function compute(value: number): number { return value; }\nfunction changed(): number {\n const value = 1;\n return compute(value);\n}\nfunction consumer(): number { return changed(); }\n',
            ' return compute(value);', ' // An ordinary explanation.\n return compute(value);'],
        ['ts blank line', 'lib.ts',
            'function compute(value: number): number { return value; }\nfunction changed(): number {\n const value = 1;\n return compute(value);\n}\nfunction consumer(): number { return changed(); }\n',
            ' return compute(value);', '\n return compute(value);'],
        ['py comment', 'lib.py',
            'def compute(value: int) -> int:\n    return value\n\ndef changed() -> int:\n    value = 1\n    return compute(value)\n\ndef consumer() -> int:\n    return changed()\n',
            '    return compute(value)', '    # An ordinary explanation.\n    return compute(value)'],
        ['py blank line', 'lib.py',
            'def compute(value: int) -> int:\n    return value\n\ndef changed() -> int:\n    value = 1\n    return compute(value)\n\ndef consumer() -> int:\n    return changed()\n',
            '    return compute(value)', '\n    return compute(value)'],
    ];
    for (const [name, file, source, from, to] of controls) it(name, () => {
        const dir = tmp({ [file]: source });
        try {
            git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
            write(dir, { [file]: source.replace(from, to) });
            const result = check(dir);
            assert.strictEqual(result.trust.status, 'READY_FOR_TOOLCHAIN', JSON.stringify(result.changed));
        } finally { rm(dir); }
    });

    it('visible checked-JS contracts do not claim argument fit', () => {
        const source = '// @ts-check\n/** @param {number} value */\nfunction compute(value) { return value; }\n' +
            'function changed() { compute(1); return 0; }\nfunction consumer() { return changed(); }\n';
        const dir = tmp({ 'lib.js': source });
        try {
            git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
            write(dir, { 'lib.js': source.replace('compute(1)', 'compute("bad")') });
            const result = check(dir);
            assert.strictEqual(result.trust.status, 'REVIEW_REQUIRED', JSON.stringify(result.changed));
        } finally { rm(dir); }
    });
});

describe('fix #506: what settles a changed call, and what is said of the rest', () => {
    // One changed function per fixture; the rows of its outgoing review.
    function rowsOf(base, after, name, options = {}) {
        const dir = tmp(base);
        try {
            git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
            write(dir, after);
            const result = check(dir, options);
            const item = result.changed.find(row => row.name === name);
            assert.ok(item, JSON.stringify(result.changed));
            return { result, item, rows: (item.outgoingReview || []).map(row => `${row.line} ${row.name}: ${row.reason}`) };
        } finally { rm(dir); }
    }
    const LIB = 'def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\n' +
        'def typed(value: int) -> int:\n    return value\n\n\nasync def later(x):\n    return x\n\n\n' +
        'class Box:\n    def __init__(self, w, h):\n        self.w = w\n        self.h = h\n\n' +
        '    def grow(self, by):\n        return Box(self.w + by, self.h + by)\n';
    const APP = 'from lib import Box, add, later, scale, typed\n\n\ndef use():\n    return scale(3)\n';
    const edit = body => ({ 'app.py': APP.replace('    return scale(3)\n', body) });

    it('an argument into a parameter with no written type needs no proof', () => {
        for (const body of ['    return scale(3, 5)\n', '    return scale(x=[1], factor=1)\n', '    return add(object(), None)\n']) {
            const { item } = rowsOf({ 'lib.py': LIB, 'app.py': APP }, edit(body), 'use');
            assert.strictEqual(item.verdict, 'ready', body);
            assert.strictEqual(item.outgoingReview, undefined, body);
        }
    });

    it('each unsettled call names the one thing that is not shown', () => {
        const expected = [
            // A literal default types the parameter: another kind is not shown to fit.
            ['    return scale(3, "x")\n', ['5 scale: argument-compatibility-unverified']],
            ['    return typed(len("ab"))\n', ['5 typed: argument-compatibility-unverified']],
            // The value goes where its type is checked.
            ['    return add(1, 2) + scale(1)\n', ['5 add: result-use-unverified', '5 scale: result-use-unverified']],
            ['    value = typed(1)\n    return value\n', ['5 typed: result-use-unverified']],
            ['    later(1)\n    return 1\n', ['5 later: result-use-unverified']],
            // A spread is not counted.
            ['    args = (1, 2)\n    return add(*args)\n', ['6 add: argument-count-not-static']],
            // A construction is not its initializer's parameter list alone.
            ['    Box(1, 2)\n    return 1\n', ['5 Box: call-interface-unverified', '5 __init__: call-interface-unverified']],
            // Nothing binds the name.
            ['    return scalee(3)\n', ['5 scalee: unresolved-callee']],
        ];
        for (const [body, rows] of expected) {
            const found = rowsOf({ 'lib.py': LIB, 'app.py': APP }, edit(body), 'use');
            assert.deepStrictEqual(found.rows, rows, body);
            assert.strictEqual(found.item.verdict, 'review', body);
            assert.deepStrictEqual(found.item.reasons, ['outgoing-call-unverified'], body);
        }
    });

    it('a bound name is never an unresolved callee', () => {
        const bodies = [
            '    return len([1])\n',
            '    raise ValueError("no")\n',
            '    scale = lambda: 1\n    return scale()\n',
            '    helper = print\n    return helper(1)\n',
            '    return [scalee(1) for scalee in (len,)]\n',
            '    for missing in (len,):\n        missing("a")\n    return 1\n',
            '    return (lambda fn: fn(1))(abs)\n',
            '    return _("text")\n',
        ];
        for (const body of bodies) {
            const { rows } = rowsOf({ 'lib.py': LIB, 'app.py': APP }, edit(body), 'use');
            assert.deepStrictEqual(rows.filter(row => row.includes('unresolved-callee')), [], body);
        }
        // A star import, a `global` declaration and a file that names the
        // builtins namespace can each supply a name the file does not write.
        const supplied = [
            [{ 'lib.py': LIB, 'app.py': 'from lib import *\n\n\ndef use():\n    return 1\n' },
                { 'app.py': 'from lib import *\n\n\ndef use():\n    return anything(1)\n' }],
            [{ 'app.py': 'def setup():\n    global helper\n    helper = len\n\n\ndef use():\n    return 1\n' },
                { 'app.py': 'def setup():\n    global helper\n    helper = len\n\n\ndef use():\n    return helper("a")\n' }],
            [{ 'boot.py': 'import builtins\n\nbuiltins.tr = str\n', 'app.py': 'def use():\n    return 1\n' },
                { 'app.py': 'def use():\n    return tr(1)\n' }],
            // Code run from text binds what it likes.
            [{ 'app.py': 'exec("def helper():\\n    return 1")\n\n\ndef use():\n    return 1\n' },
                { 'app.py': 'exec("def helper():\\n    return 1")\n\n\ndef use():\n    return helper()\n' }],
        ];
        for (const [base, after] of supplied) {
            const { rows, item } = rowsOf(base, after, 'use');
            assert.deepStrictEqual(rows, [], JSON.stringify(after));
            assert.strictEqual(item.verdict, 'ready');
        }
    });

    it('a local the function binds after the call is unresolved there', () => {
        const base = { 'app.py': 'def outer():\n    def inner():\n        return 1\n\n    return inner()\n' };
        const before = rowsOf(base, { 'app.py': 'def outer():\n    inner()\n\n    def inner():\n        return 1\n\n    return inner()\n' }, 'outer');
        assert.deepStrictEqual(before.rows, ['2 inner: unresolved-callee']);
        // A loop can run the later statement first.
        const looped = rowsOf(base, { 'app.py': 'def outer():\n    for _ in range(2):\n        if _:\n            inner()\n\n        def inner():\n            return 1\n\n    return 1\n' }, 'outer');
        assert.deepStrictEqual(looped.rows.filter(row => row.includes('unresolved-callee')), []);
    });

    it('a member through a receiver typed by its construction is checked: a wrong count is a break', () => {
        for (const body of ['    return Box(1, 2).grow()\n', '    box = Box(1, 2)\n    return box.grow()\n']) {
            const { result, item } = rowsOf({ 'lib.py': LIB, 'app.py': APP }, edit(body), 'use');
            assert.strictEqual(item.verdict, 'blocked', body);
            assert.deepStrictEqual(item.mismatches.map(row => [row.target, row.expected, row.actual]), [['grow', '1 arg(s)', 0]], body);
            // The error names the callee and the call; no line counts zero.
            const errors = result.actions.filter(action => action.severity === 'error').map(action => action.message);
            assert.strictEqual(errors.length, 1, JSON.stringify(errors));
            assert.match(errors[0], /^use: 1 call\(s\) it makes do not fit the callee: grow at app\.py:\d+ \(expected 1 arg\(s\), got 0\)$/);
            assert.ok(!result.actions.some(action => /\b0 [a-z]/.test(action.message)), JSON.stringify(result.actions));
        }
        // A receiver nothing types stays a candidate, never a break.
        const { item } = rowsOf({ 'lib.py': LIB, 'app.py': 'from lib import Box\n\n\ndef use(box):\n    return 1\n' },
            { 'app.py': 'from lib import Box\n\n\ndef use(box):\n    return box.grow()\n' }, 'use');
        assert.strictEqual(item.verdict, 'review');
        assert.deepStrictEqual(item.outgoingReview.map(row => row.name), ['grow']);
    });

    it('a function that is not a member and names its first parameter self is not counted without it', () => {
        const lib = 'def helper(self, x):\n    return x\n\n\ndef use():\n    return 1\n';
        const { item, rows } = rowsOf({ 'lib.py': lib }, { 'lib.py': lib.replace('    return 1\n', '    helper(1, 2)\n    return 1\n') }, 'use');
        assert.strictEqual(item.verdict, 'review');
        assert.strictEqual(item.mismatches, undefined);
        assert.deepStrictEqual(rows, ['6 helper: call-interface-unverified']);
    });

    it('an added declaration with a call that does not fit says which call, and nothing about object literals', () => {
        const { result, item } = rowsOf({ 'lib.py': LIB, 'app.py': APP },
            { 'app.py': APP + '\n\ndef fresh():\n    return add(1)\n' }, 'fresh');
        assert.strictEqual(item.verdict, 'blocked');
        const messages = result.actions.map(action => action.message);
        assert.ok(messages.includes('fresh: 1 call(s) it makes do not fit the callee: add at app.py:9 (expected 2 arg(s), got 1)'), JSON.stringify(messages));
        assert.ok(!messages.some(message => /object literal|its signature|outgoing-signature-mismatch/.test(message)), JSON.stringify(messages));
    });

    it('the summary counts calls, the rows stay in the result, and the text lists them only on request', () => {
        const output = require('../core/output');
        const body = '    Box(1, 2)\n    value = typed(1)\n    return add(*[value, 2]) + typed(len("a"))\n';
        const { result, item } = rowsOf({ 'lib.py': LIB, 'app.py': APP }, edit(body), 'use');
        // Two rows of one construction are one call.
        assert.strictEqual(item.outgoingReview.length, 5);
        assert.deepStrictEqual(item.outgoingCalls, { unverified: 4, reasons: [
            { reason: 'argument-compatibility-unverified', calls: 1 },
            { reason: 'argument-count-not-static', calls: 1 },
            { reason: 'call-interface-unverified', calls: 1 },
            { reason: 'result-use-unverified', calls: 1 },
        ] });
        const line = '4 outgoing call(s) not verified (argument-compatibility-unverified 1, argument-count-not-static 1, ' +
            'call-interface-unverified 1, result-use-unverified 1)';
        const text = output.formatPublicText('check', result, {}, { surface: 'cli' });
        assert.ok(text.includes(`    ↳ ${line}; use --all to list each`), text);
        assert.ok(!text.includes('app.py:6:'), text);
        assert.ok(text.includes(`  ⚠ use: ${line}; the compiler or type checker decides them`), text);
        const all = output.formatPublicText('check', result, { all: true }, { surface: 'cli' });
        for (const row of item.outgoingReview) assert.ok(all.includes(`${row.file}:${row.line}:${row.column + 1}  ${row.name}: ${row.reason}`), all);
        assert.ok(output.formatPublicText('check', result, {}, { surface: 'mcp' }).includes(`${line}; use all=true to list each`));
    });

    it('a language with no checker of calls settles a new call that binds one declaration', () => {
        const lib = 'exports.scale = function scale(x) { return x * 2; };\n';
        const app = 'const { scale } = require("./lib");\nfunction use() {\n return 0;\n}\nexports.use = use;\n';
        const { item } = rowsOf({ 'lib.js': lib, 'app.js': app }, { 'app.js': app.replace(' return 0;', ' const n = scale(2);\n console.log(n);\n return 0;') }, 'use');
        assert.strictEqual(item.verdict, 'ready');
        assert.strictEqual(item.outgoingReview, undefined);
    });

    it('a new call where the language requires more than the binding is named as such', () => {
        const source = 'package probe\n\nfunc note(level int) {}\n\nfunc changed() int {\n return 1\n}\n';
        const { rows, item } = rowsOf({ 'go.mod': 'module example.invalid/probe\n\ngo 1.20\n', 'main.go': source },
            { 'main.go': source.replace(' return 1', ' note(2)\n return 1') }, 'changed');
        assert.strictEqual(item.verdict, 'review');
        assert.deepStrictEqual(rows, ['6 note: call-requirements-unverified']);
    });
});

// Native-judged under C++20; the release matrix deliberately remains C++17.
it('fix #502: compile-time argument domains are not runtime literal proofs', () => {
    const fixture = {
    "id": "outgoing-review3-cpp-consteval-literal-domain",
    "lang": "cpp",
    "base": {
        "lib.cpp": "consteval int compute(int value) { if(value != 1) throw 1; return value; }\nint changed() { return compute(1); }\nint consumer() { return changed(); }\n"
    },
    "after": {
        "lib.cpp": "consteval int compute(int value) { if(value != 1) throw 1; return value; }\nint changed() { return compute(2); }\nint consumer() { return changed(); }\n"
    },
    "expect": "break",
    "name": "changed",
    "answer": "REVIEW_REQUIRED",
    "detail": "changed:modified=review(outgoing-call-unverified)"
};
    const dir = tmp(fixture.base);
    try {
        git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
        write(dir, fixture.after);
        const result = check(dir);
        assert.strictEqual(result.trust.status, 'REVIEW_REQUIRED');
        git(dir, 'add', '-A'); write(dir, fixture.base);
        assert.strictEqual(check(dir, { staged: true }).trust.status, 'REVIEW_REQUIRED');
    } finally { rm(dir); }
});

describe('fix #506c: what a call-shaped expression is counted against', () => {
    const shapes = require('../eval/check-call-shape-cases');
    const answers = new Map();
    // The changed symbol's item for one judged case, with its rows as text.
    function answerOf(id) {
        if (answers.has(id)) return answers.get(id);
        const fixture = shapes.find(testCase => testCase.id === `callshape-${id}`);
        assert.ok(fixture, id);
        const dir = tmp(fixture.base);
        try {
            git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
            write(dir, fixture.after);
            const result = check(dir);
            const item = result.changed.find(row => row.name === fixture.name);
            assert.ok(item, JSON.stringify(result.changed));
            const answer = { fixture, item, status: result.trust.status,
                mismatches: (item.mismatches || []).map(row => `${row.target}: expected ${row.expected}, got ${row.actual}`),
                rows: (item.outgoingReview || []).map(row => `${row.name}: ${row.reason}`) };
            answers.set(id, answer);
            return answer;
        } finally { rm(dir); }
    }
    const clean = id => {
        const { item, mismatches } = answerOf(id);
        assert.notStrictEqual(item.verdict, 'blocked', id);
        assert.deepStrictEqual(mismatches, [], id);
    };
    const broken = (id, expected) => {
        const { item, mismatches } = answerOf(id);
        assert.strictEqual(item.verdict, 'blocked', id);
        assert.deepStrictEqual(mismatches, expected, id);
    };

    it('each call of a chain is counted with its own arguments', () => {
        for (const lang of ['go', 'ts', 'py', 'java', 'cs', 'cpp']) clean(`${lang}-chain-receiver-call`);
        clean('rs-builder-chain');
        clean('rs-function-path-argument-in-chain');
        // Every call of the chain is a row of its own.
        assert.deepStrictEqual(answerOf('go-chain-receiver-call').rows.filter(row => /^(Root|Traverse):/.test(row)),
            ['Root: call-interface-unverified', 'Root: call-interface-unverified', 'Traverse: call-interface-unverified']);
        broken('go-chain-receiver-call-wrong-count', ['Traverse: expected 1 arg(s), got 0']);
        broken('go-chain-inner-wrong-count', ['Root: expected 0 arg(s), got 1']);
        broken('rs-builder-chain-wrong-count', ['require_git: expected 1 arg(s), got 0']);
        broken('rs-chain-method-wrong-count', ['map: expected 1 arg(s), got 2']);
        broken('ts-chain-receiver-call-wrong-count', ['walk: expected 1 arg(s), got 0']);
        broken('py-chain-receiver-call-wrong-count', ['walk: expected 1 arg(s), got 0']);
        broken('cpp-chain-receiver-call-wrong-count', ['walk: expected 1 arg(s), got 0']);
    });

    it('two calls of one name on a line, or in one chain, are two sites', () => {
        for (const lang of ['go', 'rs', 'ts']) {
            clean(`${lang}-two-calls-of-a-name-on-a-line`);
            broken(`${lang}-two-calls-on-a-line-second-wrong-count`, ['add: expected 2 arg(s), got 1']);
        }
        clean('go-same-name-twice-in-a-chain');
        clean('ts-same-name-twice-in-a-chain');
        clean('rs-self-tuple-constructor-chain');
        broken('go-same-name-twice-in-a-chain-second-wrong-count', ['With: expected 1 arg(s), got 0']);
        broken('ts-same-name-twice-in-a-chain-second-wrong-count', ['with: expected 1 arg(s), got 0']);
    });

    it('a constructor written on a declaration header is one of its constructors', () => {
        clean('cs-record-construction');
        clean('java-record-construction');
        broken('cs-record-construction-wrong-count', ['Point: expected 2 arg(s), got 1']);
        broken('java-record-construction-wrong-count', ['Point: expected 2 arg(s), got 1']);
    });

    it('a tuple struct or tuple variant takes one value per field', () => {
        for (const id of ['rs-tuple-variant-construction', 'rs-tuple-variant-pair', 'rs-tuple-struct-construction']) clean(id);
        broken('rs-tuple-variant-two-values', ['Literal: expected 1 arg(s), got 2']);
        broken('rs-tuple-variant-pair-one-value', ['Pair: expected 2 arg(s), got 1']);
        broken('rs-tuple-struct-two-values', ['Meters: expected 1 arg(s), got 2']);
    });

    it('a type name applied to a value converts it', () => {
        for (const id of ['go-conversion-to-named-type', 'go-conversion-to-alias', 'cpp-functional-cast-to-enum']) clean(id);
        broken('go-conversion-two-values', ['byName: expected 1 arg(s), got 2']);
        broken('go-function-beside-alias-wrong-count', ['Join: expected 2 arg(s), got 1']);
        broken('cpp-functional-cast-to-enum-two-values', ['Color: expected 0-1 arg(s), got 2']);
    });

    it('a declaration with no parameter list is never counted against an empty one', () => {
        for (const id of ['cpp-functional-cast-to-alias', 'cs-delegate-construction', 'java-anonymous-interface',
            'go-function-typed-field', 'ts-function-typed-field', 'py-newtype', 'py-alias-of-class']) clean(id);
        assert.deepStrictEqual(answerOf('cpp-functional-cast-to-alias').rows, ['Meters: call-interface-unverified']);
    });

    it('a callee the enclosing function binds is not the project function of that name', () => {
        for (const id of ['go-local-callee-of-method-result', 'go-local-callee-from-call', 'go-local-callee-declared',
            'go-parameter-callee', 'rs-local-callee-from-call', 'py-local-callee-from-call', 'ts-local-callee-from-call',
            'cs-local-callee-from-call', 'cpp-local-callee-from-call']) {
            clean(id);
            const { fixture, rows } = answerOf(id);
            const callee = id.startsWith('go-') ? 'fn' : id.startsWith('cs-') ? 'run' : 'run';
            assert.ok(!rows.some(row => row.startsWith(`${callee}:`)), `${fixture.id} ${rows.join(' | ')}`);
        }
        broken('go-package-function-wrong-count', ['fn: expected 0 arg(s), got 2']);
    });

    it('a name a module exposes is its own function, never a member of a type it declares', () => {
        for (const lang of ['py', 'ts']) {
            clean(`${lang}-module-function-beside-namesake-methods`);
            assert.deepStrictEqual(answerOf(`${lang}-module-function-wrong-count`).mismatches.map(row => row.replace(/^isatty: /, '')),
                ['expected 1 arg(s), got 2']);
        }
        clean('rs-function-beside-namesake-methods');
        clean('go-function-beside-namesake-methods');
        broken('rs-function-beside-namesake-methods-wrong-count', ['isatty: expected 1 arg(s), got 2']);
        broken('go-function-beside-namesake-methods-wrong-count', ['isatty: expected 1 arg(s), got 2']);
    });

    it('a callable held by a typed binding is called as the type says', () => {
        for (const id of ['ts-variable-typed-callable-optional-parameter', 'ts-variable-typed-callable-call-added',
            'ts-variable-typed-callable-fewer-parameters']) clean(id);
        broken('ts-variable-typed-callable-call-wrong-count', ['toSite: expected 2-3 arg(s), got 1']);
        // The declaration no longer fits its type: the toolchain rejects the
        // changed line, and no call site is blamed for it.
        const added = answerOf('ts-variable-typed-callable-parameter-added');
        assert.strictEqual(added.item.verdict, 'review');
        assert.deepStrictEqual(added.item.reasons, ['header']);
    });

    it('the binding type is read where the project declares it, and is unknown anywhere else', () => {
        const use = "export function run(): unknown {\n    return held('a');\n}\n";
        const project = declaration => ({ 'lib.ts': `${declaration}\n${use}` });
        const verifyOf = declaration => {
            const dir = tmp(project(declaration));
            try {
                const result = execute(idx(dir), 'verify', { name: 'held' });
                assert.ok(result.ok, JSON.stringify(result));
                return [result.result.valid, result.result.mismatches, result.result.uncertain];
            } finally { rm(dir); }
        };
        // [valid, mismatches, uncertain] for the one call `held('a')`.
        const expected = [
            ['type Fn = (a: string, b?: string) => string;\nexport const held: Fn = (a, b) => a + (b ?? "");', [1, 0, 0]],
            ['type Fn = (a: string, b: string) => string;\nexport const held: Fn = (a) => a;', [0, 1, 0]],
            ['interface Fn { (a: string): string; (a: string, b: string): string }\nexport const held: Fn = (a: string, b?: string) => a + (b ?? "");', [1, 0, 0]],
            ['type Inner = (a: string, ...rest: string[]) => string;\ntype Fn = Inner;\nexport const held: Fn = (a, ...rest) => a + rest.join("");', [1, 0, 0]],
            ['type Fn<T> = (a: T, b?: T) => T;\nexport const held: Fn<string> = (a, b) => a + (b ?? "");', [1, 0, 0]],
            // A supertype, a composition or a type from outside the project: not read.
            ['interface Base { (a: string, b?: string): string }\ninterface Fn extends Base { tag?: string }\nexport const held: Fn = (a, b) => a + (b ?? "");', [0, 0, 1]],
            ['type Fn = ((a: string) => string) & { tag?: string };\nexport const held: Fn = (a: string) => a;', [0, 0, 1]],
            ['export const held: Parameters<typeof String>[0] extends never ? never : (a: string, b?: string) => string = (a, b) => a + (b ?? "");', [0, 0, 1]],
        ];
        for (const [declaration, counts] of expected) assert.deepStrictEqual(verifyOf(declaration), counts, declaration);
    });

    it('every reason of an unverified call is a code', () => {
        for (const fixture of shapes) {
            const { rows } = answerOf(fixture.id.replace(/^callshape-/, ''));
            for (const row of rows) assert.match(row, /^[^:]+: [a-z][a-z-]*$/, `${fixture.id} ${row}`);
        }
        // A call written in a macro's tokens, and a construction by literal.
        const rust = { 'lib.rs': 'pub fn helper(a: i32) -> i32 {\n    a\n}\n\npub fn run() -> i32 {\n    1\n}\n' };
        const dir = tmp(rust);
        try {
            git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
            write(dir, { 'lib.rs': `${rust['lib.rs']}\npub fn more() -> i32 {\n    assert_eq!(helper(1), 1);\n    1\n}\n` });
            const item = check(dir).changed.find(row => row.name === 'more');
            assert.deepStrictEqual((item.outgoingReview || []).map(row => `${row.name}: ${row.reason}`), ['helper: call-arguments-unread']);
            assert.deepStrictEqual(item.outgoingCalls.reasons, [{ reason: 'call-arguments-unread', calls: 1 }]);
        } finally { rm(dir); }
    });

    it('verify keeps the sentence and adds the code beside it', () => {
        const dir = tmp({ 'lib.rs': 'pub fn helper(a: i32) -> i32 {\n    a\n}\n\npub fn run() -> i32 {\n    assert_eq!(helper(1), 1);\n    1\n}\n' });
        try {
            const result = execute(idx(dir), 'verify', { name: 'helper' });
            assert.ok(result.ok, JSON.stringify(result));
            const [row] = result.result.uncertainDetails;
            assert.strictEqual(row.reason, 'Could not parse call arguments');
            assert.strictEqual(row.code, 'call-arguments-unread');
            assert.ok(!Object.keys(row).includes('code'), 'the code is not part of what verify prints');
        } finally { rm(dir); }
    });
});
