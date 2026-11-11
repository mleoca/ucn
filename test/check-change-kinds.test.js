'use strict';

/**
 * The pre-commit check answers by what a change DID.
 *
 * core/change-kinds.js reads a callable's contract (header, kind, inferred
 * return) before and after a change; core/capture.js asks whether an added
 * declaration can be reached by anything that existed; core/deletion.js
 * assesses a deleted declaration from its base record. core/check.js turns
 * those into one verdict per changed symbol: blocked (a break was
 * observed), review (can reach existing code, not settled) or ready
 * (nothing that existed depends on the change).
 */

require('./helpers/cache-root');
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { tmp, rm, idx, runCli } = require('./helpers');
const { execute } = require('../core/execute');
const output = require('../core/output');
const { callableContract, classifyChange, parseRevision } = require('../core/change-kinds');
const { definiteDependentsOf } = require('../core/deletion');

function git(dir, ...args) {
    return execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repository with `files` committed as its base revision. */
function repo(files) {
    const dir = tmp(files);
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    return dir;
}

function write(dir, file, content) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
}

function edit(dir, file, from, to) {
    const before = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(before.includes(from), `${file} holds the text to replace`);
    fs.writeFileSync(path.join(dir, file), before.replace(from, to));
}

function checked(dir, params = {}) {
    const done = execute(idx(dir), 'check', params);
    assert.ok(done.ok, done.error);
    return done.result;
}

/** `name:kind=verdict(reasons)` for every changed symbol, in output order. */
function verdicts(result) {
    return (result.changed || []).map(item =>
        `${item.name}:${item.kind}=${item.verdict}${item.reasons.length ? `(${item.reasons.join(',')})` : ''}`);
}

describe('change kinds: what a change did to a callable\'s contract', () => {
    const lines = (...rows) => rows.join('\n') + '\n';
    // [label, language, before, after, [startLine, endLine] before, after, expected]
    const CASES = [
        ['py: a statement that binds nothing returned', 'python',
            lines('def f(x):', '    y = x + 1', '    return y'),
            lines('def f(x):', '    log(x)', '    y = x + 1', '    return y'), [1, 3], [1, 4], 'inert'],
        ['py: the returned expression', 'python',
            lines('def f(x):', '    y = x + 1', '    return y'),
            lines('def f(x):', '    y = x + 1', '    return None'), [1, 3], [1, 3], 'contract:inferred-return-contract'],
        ['py: what a returned name is bound to', 'python',
            lines('def f(x):', '    y = x + 1', '    return y'),
            lines('def f(x):', '    y = str(x)', '    return y'), [1, 3], [1, 3], 'contract:inferred-return-contract'],
        ['py: a binding nothing returned uses', 'python',
            lines('def f(x):', '    z = 1', '    y = x + 1', '    return y'),
            lines('def f(x):', '    z = 2', '    y = x + 1', '    return y'), [1, 4], [1, 4], 'inert'],
        ['py: a yield makes it a generator', 'python',
            lines('def f(x):', '    return x'),
            lines('def f(x):', '    yield x', '    return x'), [1, 2], [1, 3], 'contract:callable-kind,inferred-return-contract'],
        ['py: a return moved under a condition can fall off the end', 'python',
            lines('def f(x):', '    return x'),
            lines('def f(x):', '    if x:', '        return x'), [1, 2], [1, 3], 'contract:inferred-return-contract'],
        ['py: an annotated return is the contract', 'python',
            lines('def f(x) -> int:', '    return x'),
            lines('def f(x) -> int:', '    return x + 1'), [1, 2], [1, 2], 'inert'],
        ['py: a default value is header', 'python',
            lines('def f(x, y=1):', '    return x'),
            lines('def f(x, y=2):', '    return x'), [1, 2], [1, 2], 'contract:header'],
        ['py: a decorator is header', 'python',
            lines('def f(x):', '    return x'),
            lines('@cache', 'def f(x):', '    return x'), [1, 2], [1, 3], 'contract:header'],
        ['py: a docstring is not', 'python',
            lines('def f(x):', '    """a"""', '    return x'),
            lines('def f(x):', '    """b"""', '    return x'), [1, 3], [1, 3], 'inert'],
        ['py: a reformatted, commented header is the same header', 'python',
            lines('def f(x, y):', '    return x'),
            lines('def f(x,', '      y):  # note', '    return x'), [1, 2], [1, 3], 'inert'],
        ['js: a statement that binds nothing returned', 'javascript',
            lines('function f(x) {', '  const y = x + 1;', '  return y;', '}'),
            lines('function f(x) {', '  console.log(x);', '  const y = x + 1;', '  return y;', '}'), [1, 4], [1, 5], 'inert'],
        ['js: an arrow\'s expression body is its result', 'javascript',
            lines('const f = (x) => x + 1;'), lines('const f = (x) => String(x);'), [1, 1], [1, 1],
            'contract:inferred-return-contract'],
        ['js: a destructured binding of a returned name', 'javascript',
            lines('function f(o) {', '  const { a } = o;', '  return a;', '}'),
            lines('function f(o) {', '  const { a } = o.inner;', '  return a;', '}'), [1, 4], [1, 4],
            'contract:inferred-return-contract'],
        ['js: async and the generator star are header', 'javascript',
            lines('function f(x) {', '  return x;', '}'),
            lines('async function* f(x) {', '  return x;', '}'), [1, 3], [1, 3], 'contract:header'],
        ['ts: a declared return type is the contract', 'typescript',
            lines('function f(x: number): number {', '  return x;', '}'),
            lines('function f(x: number): number {', '  return x + 1;', '}'), [1, 3], [1, 3], 'inert'],
        ['ts: no return type, the body is', 'typescript',
            lines('function f(x: number) {', '  return x;', '}'),
            lines('function f(x: number) {', '  return String(x);', '}'), [1, 3], [1, 3],
            'contract:inferred-return-contract'],
        ['ts: a parameter type', 'typescript',
            lines('function f(x: number) {', '  return 1;', '}'),
            lines('function f(x: string) {', '  return 1;', '}'), [1, 3], [1, 3], 'contract:header'],
        ['go: the header is the whole contract', 'go',
            lines('package p', '', 'func f(x int) int {', '\treturn x', '}'),
            lines('package p', '', 'func f(x int) int {', '\treturn x + 1', '}'), [3, 5], [3, 5], 'inert'],
        ['go: a parameter', 'go',
            lines('package p', '', 'func f(x int) int {', '\treturn x', '}'),
            lines('package p', '', 'func f(x int, y int) int {', '\treturn x', '}'), [3, 5], [3, 5], 'contract:header'],
        ['java: a body edit', 'java',
            lines('class A {', '    int f(int x) {', '        return x;', '    }', '}'),
            lines('class A {', '    int f(int x) {', '        return x + 1;', '    }', '}'), [2, 4], [2, 4], 'inert'],
        ['java: a throws clause', 'java',
            lines('class A {', '    int f(int x) {', '        return x;', '    }', '}'),
            lines('class A {', '    int f(int x) throws Exception {', '        return x;', '    }', '}'), [2, 4], [2, 4],
            'contract:header'],
        ['rust: a declared return type', 'rust',
            lines('fn f(x: i32) -> i32 {', '    x', '}'), lines('fn f(x: i32) -> i32 {', '    x + 1', '}'),
            [1, 3], [1, 3], 'inert'],
        ['rust: an opaque return type exposes the body', 'rust',
            lines('fn f() -> impl Iterator<Item = i32> {', '    vec![1].into_iter()', '}'),
            lines('fn f() -> impl Iterator<Item = i32> {', '    std::iter::once(1)', '}'), [1, 3], [1, 3],
            'contract:inferred-return-contract'],
        ['rust: an attribute is header', 'rust',
            lines('fn f(x: i32) -> i32 {', '    x', '}'), lines('#[inline]', 'fn f(x: i32) -> i32 {', '    x', '}'),
            [1, 3], [2, 4], 'contract:header'],
        ['c++: a placeholder return type is deduced from the body', 'cpp',
            lines('auto f(int x) {', '    return x;', '}'), lines('auto f(int x) {', '    return x + 1.5;', '}'),
            [1, 3], [1, 3], 'contract:inferred-return-contract'],
        ['c++: a declared return type', 'cpp',
            lines('int f(int x) {', '    return x;', '}'), lines('int f(int x) {', '    return x + 1;', '}'),
            [1, 3], [1, 3], 'inert'],
        ['c#: an attribute is header', 'csharp',
            lines('class A {', '    int F(int x) {', '        return x;', '    }', '}'),
            lines('class A {', '    [Obsolete]', '    int F(int x) {', '        return x;', '    }', '}'), [2, 4], [2, 5],
            'contract:header'],
    ];
    for (const [label, language, before, after, was, is, expected] of CASES) {
        it(label, () => {
            const change = classifyChange(
                callableContract(parseRevision(before, language), language, { startLine: was[0], endLine: was[1] }),
                callableContract(parseRevision(after, language), language, { startLine: is[0], endLine: is[1] }),
                language);
            assert.strictEqual(change.kind === 'inert' ? 'inert' : `${change.kind}:${change.reasons.join(',')}`, expected);
        });
    }

    it('a contract that cannot be read is unknown, never inert', () => {
        const contract = callableContract(parseRevision('def f(x):\n    return x\n', 'python'), 'python',
            { startLine: 1, endLine: 2 });
        assert.deepStrictEqual(classifyChange(null, contract, 'python'),
            { kind: 'unknown', reasons: ['contract-unreadable'] });
        assert.strictEqual(callableContract(parseRevision('x = 1\n', 'python'), 'python', { startLine: 7, endLine: 9 }), null);
    });
});

describe('check: a verdict per changed symbol, by what the change did', () => {
    const APP = [
        'def helper(x):',
        '    y = x + 1',
        '    return y',
        '',
        '',
        'def caller():',
        '    return helper(1) + helper(2)',
        '',
        '',
        'def gone():',
        '    return 3',
        '',
        '',
        'def user():',
        '    return gone()',
        '',
    ].join('\n');

    // [label, edit(dir), expected trust, expected verdicts]
    const SCENARIOS = [
        ['an inert body edit is ready, whatever calls it',
            dir => edit(dir, 'app.py', '    y = x + 1\n', '    print(x)\n    y = x + 1\n'),
            'READY_FOR_TOOLCHAIN', ['helper:modified=ready']],
        ['a comment is an inert edit',
            dir => edit(dir, 'app.py', '    y = x + 1\n', '    y = x + 1  # note\n'),
            'READY_FOR_TOOLCHAIN', ['helper:modified=ready']],
        ['a changed inferred return is review',
            dir => edit(dir, 'app.py', '    return y\n', '    return None\n'),
            'REVIEW_REQUIRED', ['helper:modified=review(inferred-return-contract)']],
        ['a body that now yields is review',
            dir => edit(dir, 'app.py', '    y = x + 1\n', '    yield x\n    y = x + 1\n'),
            'REVIEW_REQUIRED', ['helper:modified=review(callable-kind,inferred-return-contract)']],
        ['a required parameter that call sites do not pass is a break',
            dir => edit(dir, 'app.py', 'def helper(x):', 'def helper(x, must):'),
            'BLOCKED', ['helper:modified=blocked(signature-mismatch,header)']],
        ['an optional parameter fits every call site: review, not a break',
            dir => edit(dir, 'app.py', 'def helper(x):', 'def helper(x, opt=None):'),
            'REVIEW_REQUIRED', ['helper:modified=review(header)']],
        ['a changed header nothing depends on is ready',
            dir => edit(dir, 'app.py', 'def user():', 'def user(flag=False):'),
            'READY_FOR_TOOLCHAIN', ['user:modified=ready']],
        ['a deleted function that is still called is a break',
            dir => edit(dir, 'app.py', 'def gone():\n    return 3\n\n\n', ''),
            'BLOCKED', ['gone:deleted=blocked(still-referenced)']],
        ['a deleted function nothing names is ready',
            dir => edit(dir, 'app.py', '\n\ndef user():\n    return gone()\n', '\n'),
            'READY_FOR_TOOLCHAIN', ['user:deleted=ready']],
        ['a new file under new names is ready',
            dir => write(dir, 'fresh.py', 'def brand_new_thing(a):\n    return a\n'),
            'READY_FOR_TOOLCHAIN', ['brand_new_thing:added=ready']],
        ['a new function and the new code that calls it are ready',
            dir => write(dir, 'app.py', APP +
                '\n\ndef brand_new_thing(a):\n    return a\n\n\ndef brand_new_user():\n    return brand_new_thing(1)\n'),
            'READY_FOR_TOOLCHAIN', ['brand_new_thing:added=ready', 'brand_new_user:added=ready']],
    ];
    for (const [label, change, trust, expected] of SCENARIOS) {
        it(label, () => {
            const dir = repo({ 'app.py': APP });
            try {
                change(dir);
                const result = checked(dir);
                assert.deepStrictEqual([result.trust.status, verdicts(result)], [trust, expected]);
                assert.strictEqual(result.trust.passes, trust !== 'BLOCKED');
            } finally { rm(dir); }
        });
    }

    it('a new function whose name existing code already uses is review, with the sites', () => {
        const dir = repo({ 'app.py': APP.replace('    return gone()\n', '    return gone() + later()\n') });
        try {
            write(dir, 'app.py', fs.readFileSync(path.join(dir, 'app.py'), 'utf8') + '\n\ndef later():\n    return 1\n');
            const result = checked(dir);
            assert.deepStrictEqual([result.trust.status, verdicts(result)],
                ['REVIEW_REQUIRED', ['later:added=review(name-in-use)']]);
            assert.deepStrictEqual(result.changed[0].sites, [{ file: 'app.py', line: 15 }]);
        } finally { rm(dir); }
    });

    it('--strict makes review fail; a break fails either way; ready passes either way', () => {
        const dir = repo({ 'app.py': APP });
        try {
            edit(dir, 'app.py', 'def helper(x):', 'def helper(x, opt=None):');
            assert.strictEqual(runCliStatus(dir, 'check'), 0);
            assert.strictEqual(runCliStatus(dir, 'check', '--strict'), 1);
            const strict = checked(dir, { strict: true });
            assert.deepStrictEqual([strict.trust.status, strict.trust.passes, strict.trust.strict],
                ['REVIEW_REQUIRED', false, true]);
            assert.match(output.formatCheck(strict), /strict: review does not pass/);
            edit(dir, 'app.py', 'def helper(x, opt=None):', 'def helper(x, must):');
            assert.strictEqual(runCliStatus(dir, 'check'), 1);
            edit(dir, 'app.py', 'def helper(x, must):', 'def helper(x):');
            edit(dir, 'app.py', '    y = x + 1\n', '    print(x)\n    y = x + 1\n');
            assert.strictEqual(runCliStatus(dir, 'check', '--strict'), 0);
        } finally { rm(dir); }
    });

    it('lists every call site of a break: thirteen sites are thirteen lines', () => {
        const calls = Array.from({ length: 13 }, (_, i) => `    total += widened(${i})`).join('\n');
        const dir = repo({
            'lib.py': 'def widened(a):\n    return a\n',
            'use.py': `from lib import widened\n\n\ndef run():\n    total = 0\n${calls}\n    return total\n`,
        });
        try {
            edit(dir, 'lib.py', 'def widened(a):', 'def widened(a, b):');
            const result = checked(dir);
            assert.strictEqual(result.trust.status, 'BLOCKED');
            assert.strictEqual(result.changed[0].mismatches.length, 13);
            const text = output.formatCheck(result);
            assert.strictEqual((text.match(/↳ use\.py:\d+ {2}total \+= widened\(\d+\) {2}expected 2 arg\(s\), got 1/g) || []).length, 13);
            assert.match(text, /BLOCKED \(1\) — a break was observed:/);
        } finally { rm(dir); }
    });

    it('counts caller evidence only where callers matter', () => {
        // An inert edit of a function with an unverified caller: nothing to
        // review, and the trust line does not say there is.
        const dir = repo({
            'a.js': 'function run(x) {\n  const y = x;\n  return y;\n}\nmodule.exports = { run };\n',
            'b.js': 'function go(obj) {\n  return obj.run(1);\n}\nmodule.exports = { go };\n',
        });
        try {
            edit(dir, 'a.js', '  const y = x;\n', '  console.log(x);\n  const y = x;\n');
            const result = checked(dir);
            assert.deepStrictEqual([result.trust.status, result.trust.unverifiedCallSites, result.trust.incompleteAccounts],
                ['READY_FOR_TOOLCHAIN', 0, 0]);
            assert.ok(result.changed[0].unverifiedCallerCount > 0, 'the candidate is still reported on the item');
        } finally { rm(dir); }
    });
});

function runCliStatus(dir, ...args) {
    try {
        execFileSync(process.execPath, [path.join(__dirname, '..', 'cli', 'index.js'), dir, ...args, '--no-cache'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return 0;
    } catch (error) {
        return error.status;
    }
}
void runCli;

describe('check: one change each, and whether it breaks code the change did not touch', () => {
    // eval/check-matrix-cases.js: `expect` is what the language's own
    // toolchain says about the change (judged by eval/run-check-matrix.js,
    // not here); `answer` and `detail` are the check's. Each change is
    // asked twice: against the worktree, and staged, from a snapshot
    // exported from the git index.
    const { CASES } = require('../eval/check-matrix-cases');
    const { materialize, answersFor, answerOf, detailOf } = require('../eval/run-check-matrix');
    for (const testCase of CASES) {
        it(`${testCase.id}: ${testCase.answer}`, () => {
            const dir = materialize(testCase);
            try {
                const { worktree, staged } = answersFor(testCase, dir);
                assert.deepStrictEqual([answerOf(worktree), detailOf(worktree)], [testCase.answer, testCase.detail]);
                assert.deepStrictEqual([answerOf(staged), detailOf(staged)], [testCase.answer, testCase.detail],
                    'the staged tree answers as the worktree does');
            } finally { rm(dir); }
        });
    }

    it('never passes a change the toolchain rejects, never calls a clean one a break', () => {
        const passes = answer => answer === 'READY_FOR_TOOLCHAIN' || answer === 'NO-CHANGES';
        for (const testCase of CASES) {
            if (testCase.expect === 'break') assert.ok(!passes(testCase.answer), testCase.id);
            else assert.notStrictEqual(testCase.answer, 'BLOCKED', testCase.id);
        }
        // Every language has a change that is READY and one that is a
        // break: asking for review of everything would pass the half above.
        for (const lang of new Set(CASES.map(testCase => testCase.lang))) {
            const ofLang = CASES.filter(testCase => testCase.lang === lang);
            assert.ok(ofLang.some(testCase => testCase.answer === 'READY_FOR_TOOLCHAIN'), `${lang}: a ready change`);
            assert.ok(ofLang.some(testCase => testCase.answer === 'BLOCKED'), `${lang}: an observed break`);
        }
    });
});

describe('check: the answer survives a character budget', () => {
    const { applyOutputBudget } = require('../core/output-budget');
    const calls = Array.from({ length: 40 }, (_, i) => `    total += widened(${i})`).join('\n');
    const files = {
        'lib.py': 'def widened(a):\n    return a\n\n\ndef tidy(a):\n    b = a\n    return b\n',
        'use.py': `from lib import widened, tidy\n\n\ndef run():\n    total = tidy(0)\n${calls}\n    return total\n`,
    };

    it('keeps the verdict and a head of every verdict section', () => {
        const dir = repo(files);
        try {
            edit(dir, 'lib.py', 'def widened(a):', 'def widened(a, b):');
            edit(dir, 'lib.py', '    b = a\n', '    print(a)\n    b = a\n');
            write(dir, 'fresh.py', 'def brand_new_one():\n    return 1\n');
            const full = output.formatCheck(checked(dir));
            assert.strictEqual((full.match(/↳ use\.py:/g) || []).length, 40);
            const cut = applyOutputBudget(full, { command: 'check', maxChars: 1200 }).text;
            assert.ok(cut.length <= 1200);
            assert.match(cut, /^TRUST: BLOCKED — /m);
            // Forty breaks do not push what is ready out of the answer.
            assert.match(cut, /BLOCKED \(1\) — a break was observed:\n {2}widened \(lib\.py:1\)/);
            assert.match(cut, /\.\.\. \+\d+ more/);
            assert.match(cut, /READY \(2\) — nothing that existed depends on the change:\n {2}tidy \(lib\.py:5\) \[MODIFIED, contract unchanged\]/);
            // A budget too small for any section still states the verdict.
            const tiny = applyOutputBudget(full, { command: 'check', maxChars: 300 }).text;
            assert.ok(tiny.length <= 300);
            assert.match(tiny, /TRUST: BLOCKED — UCN evidence is not semantic proof; compiler and tests are required/);
        } finally { rm(dir); }
    });
});

describe('review items: one count for the check, the caller listing and the oracle eval', () => {
    const { reviewItemsOf, uncertaintyClassOf, partitionUnverified } = require('../core/review-items');
    const sites = [
        { reason: 'no-binding-evidence' },
        { reason: 'receiver-untyped' },
        // One interface boundary, three sites: one thing to look at.
        { reason: 'possible-dispatch', dispatchVia: 'Shape', dispatchCandidates: 4 },
        { reason: 'possible-dispatch', dispatchVia: 'Shape', dispatchCandidates: 4 },
        { uncertaintyClass: 'runtime-dispatch', dispatchVia: 'Shape', dispatchCandidates: 4 },
        { reason: 'possible-dispatch', dispatchVia: 'Writer', dispatchCandidates: 2, externalContract: true },
        // A template family the compiler instantiates.
        { uncertaintyClass: 'compile-time-dispatch', dispatchFamily: 'emit<T>', dispatchCandidates: 3 },
        { uncertaintyClass: 'compile-time-dispatch', dispatchFamily: 'emit<T>', dispatchCandidates: 3 },
    ];

    it('charges a site a reader can settle once, and a dispatch family once', () => {
        assert.deepStrictEqual(reviewItemsOf(sites), {
            actionable: 2,
            runtimeDispatchSites: 4,
            runtimeDispatchGroups: 2,
            compileTimeDispatchSites: 2,
            compileTimeDispatchGroups: 1,
            items: 5,
        });
        assert.deepStrictEqual(reviewItemsOf([]).items, 0);
        assert.deepStrictEqual(reviewItemsOf(undefined).items, 0);
    });

    it('the class the engine recorded wins; every site has exactly one class', () => {
        assert.strictEqual(uncertaintyClassOf({ reason: 'possible-dispatch', dispatchVia: 'X' }), 'runtime-dispatch');
        assert.strictEqual(uncertaintyClassOf({ reason: 'possible-dispatch' }), 'actionable-ambiguity');
        assert.strictEqual(uncertaintyClassOf({
            uncertaintyClass: 'compile-time-dispatch', reason: 'possible-dispatch', dispatchVia: 'X',
        }), 'compile-time-dispatch');
        const parts = partitionUnverified(sites);
        assert.strictEqual(parts.actionable.length + parts.runtime.length + parts.compileTime.length, sites.length);
    });
});

describe('check: deletions are assessed from the base declaration', () => {
    it('an import of the name from its former module is a break; a module-path call is review', () => {
        const dir = repo({
            'm.py': 'def gone():\n    return 1\n\n\ndef other():\n    return 2\n',
            'named.py': 'from m import gone\n\nprint(gone())\n',
            'pathed.py': 'import m\n\nprint(m.other())\n',
        });
        try {
            edit(dir, 'm.py', 'def gone():\n    return 1\n\n\n', '');
            let result = checked(dir);
            assert.deepStrictEqual(verdicts(result), ['gone:deleted=blocked(still-referenced)']);
            assert.deepStrictEqual(result.changed[0].sites, [{ file: 'named.py', line: 1, kind: 'import' }]);
            // Reached through the module, never imported by name: the name
            // is still used, and nothing proves the use breaks.
            write(dir, 'named.py', 'import m\n\nprint(m.gone())\n');
            git(dir, 'add', '-A');
            git(dir, 'commit', '-q', '-m', 'by module path');
            write(dir, 'm.py', 'def gone():\n    return 1\n\n\ndef other():\n    return 2\n');
            git(dir, 'add', '-A');
            git(dir, 'commit', '-q', '-m', 'restore');
            edit(dir, 'm.py', 'def gone():\n    return 1\n\n\n', '');
            result = checked(dir);
            assert.deepStrictEqual(verdicts(result), ['gone:deleted=review(name-still-used)']);
            assert.strictEqual(result.trust.status, 'REVIEW_REQUIRED');
        } finally { rm(dir); }
    });

    it('a bare call is a break only where the language says the name has nothing left to mean', () => {
        for (const [file, base, removed, expected] of [
            // A parameter and a local of the same name are not the function.
            ['m.py', 'def gone():\n    return 1\n\n\ndef a():\n    return gone()\n\n\ndef b(gone):\n    return gone()\n\n\ndef c():\n    gone = lambda: 2\n    return gone()\n',
                'def gone():\n    return 1\n\n\n', [{ file: 'm.py', line: 2, kind: 'call' }]],
            ['m.js', 'function gone() { return 1; }\nfunction a() { return gone(); }\nfunction b(gone) { return gone(); }\nfunction c() { const gone = () => 2; return gone(); }\na(); b(); c();\n',
                'function gone() { return 1; }\n', [{ file: 'm.js', line: 1, kind: 'call' }]],
            ['m.rs', 'fn gone() -> i32 { 1 }\nfn a() -> i32 { gone() }\nfn c() -> i32 { let gone = || 2; gone() }\n',
                'fn gone() -> i32 { 1 }\n', [{ file: 'm.rs', line: 1, kind: 'call' }]],
            // Rebound at module scope: the call still has a meaning.
            ['r.py', 'def gone():\n    return 1\n\n\ngone = len\n\n\ndef a():\n    return gone([])\n',
                'def gone():\n    return 1\n\n\n', []],
        ]) {
            const dir = repo({ [file]: base });
            try {
                const before = idx(dir);
                const record = JSON.parse(JSON.stringify((before.symbols.get('gone') || [])
                    .find(definition => definition.type === 'function' && definition.startLine === 1)));
                edit(dir, file, removed, '');
                assert.deepStrictEqual(definiteDependentsOf(idx(dir), record), expected, file);
            } finally { rm(dir); }
        }
    });

    it('a directory package: a call in a sibling file is a break', () => {
        const dir = repo({
            'go.mod': 'module example.com/m\n\ngo 1.21\n',
            'm.go': 'package m\n\nfunc gone() int { return 1 }\n',
            'n.go': 'package m\n\nfunc a() int { return gone() }\nfunc c() int { gone := func() int { return 2 }; return gone() }\n',
        });
        try {
            edit(dir, 'm.go', 'func gone() int { return 1 }\n', '');
            const result = checked(dir);
            assert.deepStrictEqual(verdicts(result), ['gone:deleted=blocked(still-referenced)']);
            assert.deepStrictEqual(result.changed[0].sites, [{ file: 'n.go', line: 3, kind: 'call' }]);
        } finally { rm(dir); }
    });

    it('a registered handler and an exported library function are never ready to delete', () => {
        const dir = repo({
            'package.json': '{"name":"lib","main":"index.js"}',
            'index.js': 'function publicApi() { return 1; }\nfunction keep() { return 2; }\nmodule.exports = { publicApi, keep };\n',
            'web.py': 'from flask import Flask\n\napp = Flask(__name__)\n\n\n@app.route("/health")\ndef health():\n    return "ok"\n\n\ndef keep():\n    return 1\n',
        });
        try {
            edit(dir, 'index.js', 'function publicApi() { return 1; }\n', '');
            edit(dir, 'index.js', 'module.exports = { publicApi, keep };', 'module.exports = { keep };');
            edit(dir, 'web.py', '@app.route("/health")\ndef health():\n    return "ok"\n\n\n', '');
            const result = checked(dir);
            const byName = Object.fromEntries(result.changed.map(item => [item.name, item]));
            // Zero occurrences left in the repository, both of them.
            assert.deepStrictEqual([byName.publicApi.verdict, byName.publicApi.reasons],
                ['review', ['downstream-exposure']]);
            assert.deepStrictEqual([byName.health.verdict, byName.health.reasons], ['review', ['registered']]);
            assert.strictEqual(result.trust.status, 'REVIEW_REQUIRED');
        } finally { rm(dir); }
    });
});

describe('check: what a change did to a module outside its declarations', () => {
    const moduleItem = result => (result.changed || []).find(item => item.kind === 'module');

    it('an import written as a call is an import: adding a name to it is not module code', () => {
        const dir = repo({
            'shared.js': 'function a() { return 1; }\nfunction b() { return 2; }\nmodule.exports = { a, b };\n',
            'lib.js': 'const { a } = require("./shared");\nfunction keep() { return a(); }\nmodule.exports = { keep };\n',
        });
        try {
            write(dir, 'lib.js', 'const { a, b } = require("./shared");\nfunction keep() { return a() + b(); }\nmodule.exports = { keep };\n');
            const result = checked(dir);
            assert.strictEqual(moduleItem(result), undefined);
        } finally { rm(dir); }
    });

    it('an import dropped for what importing it did is review; one whose name is unused is not', () => {
        const dir = repo({
            'polyfill.js': 'globalThis.ready = true;\n',
            'util.js': 'function a() { return 1; }\nmodule.exports = { a };\n',
            'lib.js': 'require("./polyfill");\nconst { a } = require("./util");\nfunction keep() { return 2; }\nmodule.exports = { keep };\n',
        });
        try {
            // The unused binding goes: nothing in the file wrote `a`.
            write(dir, 'lib.js', 'require("./polyfill");\nfunction keep() { return 2; }\nmodule.exports = { keep };\n');
            assert.strictEqual(moduleItem(checked(dir)), undefined);
            // The side-effect import goes too.
            write(dir, 'lib.js', 'function keep() { return 2; }\nmodule.exports = { keep };\n');
            const item = moduleItem(checked(dir));
            assert.deepStrictEqual([item.verdict, item.reasons], ['review', ['imports-removed']]);
        } finally { rm(dir); }
    });

    it('an import whose name the file still uses is review, with the uses', () => {
        const dir = repo({
            'util.py': 'def helper():\n    return 1\n',
            'lib.py': 'from util import helper\n\n\ndef keep():\n    return helper()\n',
        });
        try {
            write(dir, 'lib.py', 'def keep():\n    return helper()\n');
            const item = moduleItem(checked(dir));
            assert.deepStrictEqual([item.verdict, item.reasons], ['review', ['import-removed-still-used']]);
            assert.deepStrictEqual(item.sites, [{ file: 'lib.py', line: 2, kind: 'uses helper' }]);
        } finally { rm(dir); }
    });

    it('loose module code is review in a module and nothing in a test file', () => {
        const dir = repo({
            'lib.py': 'def keep():\n    return 2\n\n\nprint(keep())\n',
            'tests/test_lib.py': 'from lib import keep\n\nassert keep() == 2\n',
        });
        try {
            write(dir, 'lib.py', 'def keep():\n    return 2\n\n\nprint(keep() + 1)\n');
            write(dir, 'tests/test_lib.py', 'from lib import keep\n\nassert keep() == 2\nassert keep() != 3\n');
            const result = checked(dir);
            const items = result.changed.filter(item => item.kind === 'module');
            assert.deepStrictEqual(items.map(item => [item.file, item.reasons]), [['lib.py', ['module-level-code']]]);
        } finally { rm(dir); }
    });

    it('a diff that only un-exports a name still imported is a break, not "no changes"', () => {
        const dir = repo({
            'lib.js': 'function a() { return 1; }\nfunction b() { return 2; }\nmodule.exports = { a, b };\n',
            'use.js': 'const { a, b } = require("./lib");\nmodule.exports = { run: () => a() + b() };\n',
        });
        try {
            write(dir, 'lib.js', 'function a() { return 1; }\nfunction b() { return 2; }\nb();\nmodule.exports = { a };\n');
            const result = checked(dir);
            assert.strictEqual(result.empty, undefined);
            assert.strictEqual(result.trust.status, 'BLOCKED');
            const item = moduleItem(result);
            assert.deepStrictEqual([item.verdict, item.reasons, item.sites],
                ['blocked', ['no-longer-provided'], [{ file: 'use.js', line: 1, kind: 'import b' }]]);
            assert.match(output.formatCheck(result), /\(module\) \(lib\.js:1\) \[MODULE, no-longer-provided\]\n {4}↳ use\.js:1 {2}import b/);
        } finally { rm(dir); }
    });
});

describe('check: a new name is new where it can be meant', () => {
    // An occurrence of the same spelling somewhere the declaration cannot
    // be reached from is another name: it could not have meant this
    // declaration before the change and cannot now.
    const added = (dir, name) => checked(dir).changed.find(item => item.name === name && item.kind === 'added');
    const answer = item => `${item.verdict}${item.reasons.length ? `(${item.reasons.join(',')})` : ''}`;

    it('a module-private helper is not the local of that name in another module', () => {
        const dir = repo({
            'a.js': 'function keep() { return 1; }\nmodule.exports = { keep };\n',
            'b.js': 'const { keep } = require("./a");\nfunction other() { const rows = [keep()]; return rows; }\nmodule.exports = { other };\n',
        });
        try {
            write(dir, 'a.js', 'function keep() { return rows().length; }\nfunction rows() { return [1]; }\nmodule.exports = { keep };\n');
            assert.strictEqual(answer(added(dir, 'rows')), 'ready');
        } finally { rm(dir); }
    });

    it('the same file is always in reach', () => {
        const dir = repo({
            'a.js': 'function keep(rows) { return rows; }\nmodule.exports = { keep };\n',
        });
        try {
            write(dir, 'a.js', 'function keep(rows) { return rows; }\nfunction rows() { return [1]; }\nmodule.exports = { keep };\n');
            const item = added(dir, 'rows');
            assert.strictEqual(answer(item), 'review(name-in-use)');
            assert.deepStrictEqual(item.sites, [{ file: 'a.js', line: 1 }]);
        } finally { rm(dir); }
    });

    it('an exported name reaches the files that import it and the files that hold the module', () => {
        const dir = repo({
            'a.js': 'function keep() { return 1; }\nmodule.exports = { keep };\n',
            // Imports a name the module does not have yet.
            'named.js': 'const { keep, later } = require("./a");\nmodule.exports = { run: () => keep() + later() };\n',
            // Holds the module and reaches for the member.
            'held.js': 'const a = require("./a");\nmodule.exports = { run: () => a.keep() + a.later() };\n',
            // Its own `later`: never this one.
            'apart.js': 'function later() { return 0; }\nmodule.exports = { later };\n',
        });
        try {
            write(dir, 'a.js', 'function keep() { return 1; }\nfunction later() { return 2; }\nmodule.exports = { keep, later };\n');
            const item = added(dir, 'later');
            assert.strictEqual(answer(item), 'review(name-in-use)');
            assert.deepStrictEqual([...new Set(item.sites.map(site => site.file))], ['held.js', 'named.js']);
        } finally { rm(dir); }
    });

    it('a star import takes whatever the module has', () => {
        const dir = repo({
            'm.py': 'def keep():\n    return 1\n',
            'star.py': 'from m import *\n\n\ndef run(later):\n    return keep() + later\n',
            'apart.py': 'def run(later):\n    return later\n',
        });
        try {
            write(dir, 'm.py', 'def keep():\n    return 1\n\n\ndef later():\n    return 2\n');
            const item = added(dir, 'later');
            assert.strictEqual(answer(item), 'review(name-in-use)');
            assert.deepStrictEqual([...new Set(item.sites.map(site => site.file))], ['star.py']);
        } finally { rm(dir); }
    });

    it('scripts without module syntax share one scope', () => {
        const dir = repo({
            'a.js': 'function keep() { return 1; }\n',
            'b.js': 'function run() { return later(); }\n',
        });
        try {
            write(dir, 'a.js', 'function keep() { return 1; }\nfunction later() { return 2; }\n');
            const item = added(dir, 'later');
            assert.strictEqual(answer(item), 'review(name-in-use)');
            assert.deepStrictEqual(item.sites.map(site => site.file), ['b.js']);
        } finally { rm(dir); }
    });

    it('a member can be reached through a receiver from anywhere', () => {
        const dir = repo({
            'a.py': 'class Box:\n    def size(self):\n        return 1\n',
            'b.py': 'def run(thing):\n    return thing.weight()\n',
        });
        try {
            write(dir, 'a.py', 'class Box:\n    def size(self):\n        return 1\n\n    def weight(self):\n        return 2\n');
            const item = added(dir, 'weight');
            assert.strictEqual(answer(item), 'review(name-in-use)');
            assert.deepStrictEqual(item.sites, [{ file: 'b.py', line: 2 }]);
        } finally { rm(dir); }
    });
});

describe('check: an addition is inert only when nothing that existed can reach it', () => {
    // [label, base files, edit, expected verdict string for the added symbol]
    const CASES = [
        ['py: a method that overrides an inherited one',
            { 'a.py': 'class Base:\n    def run(self):\n        return 1\n\n\nclass Child(Base):\n    def other(self):\n        return 2\n' },
            dir => edit(dir, 'a.py', '    def other(self):\n        return 2\n', '    def other(self):\n        return 2\n\n    def run(self):\n        return 3\n'),
            'run:added=review(name-in-use,overrides-inherited)'],
        ['java: a new abstract method every implementer must now supply',
            { 'A.java': 'interface Contract {\n    void keep();\n}\nclass Impl implements Contract {\n    public void keep() {}\n}\n' },
            dir => edit(dir, 'A.java', '    void keep();\n', '    void keep();\n    void fresh();\n'),
            'fresh:added=review(new-requirement)'],
        ['rust: a new required trait method',
            { 'a.rs': 'trait Contract {\n    fn keep(&self);\n}\nstruct Impl;\nimpl Contract for Impl {\n    fn keep(&self) {}\n}\n' },
            dir => edit(dir, 'a.rs', '    fn keep(&self);\n', '    fn keep(&self);\n    fn fresh(&self);\n'),
            'fresh:added=review(new-requirement)'],
        ['py: a member the runtime calls by name',
            { 'a.py': 'class Box:\n    def size(self):\n        return 1\n' },
            dir => edit(dir, 'a.py', '        return 1\n', '        return 1\n\n    def __len__(self):\n        return 1\n'),
            '__len__:added=review(protocol-member)'],
        ['py: a handler registered by a decorator',
            { 'web.py': 'from flask import Flask\n\napp = Flask(__name__)\n' },
            dir => write(dir, 'web.py', 'from flask import Flask\n\napp = Flask(__name__)\n\n\n@app.route("/fresh")\ndef fresh_route():\n    return "ok"\n'),
            'fresh_route:added=review(registered)'],
        ['ts: a novel method of an existing class is ready',
            { 'a.ts': 'class Box {\n  size() { return 1; }\n}\nnew Box().size();\n' },
            dir => edit(dir, 'a.ts', '  size() { return 1; }\n', '  size() { return 1; }\n  freshlyNamed() { return 2; }\n'),
            'freshlyNamed:added=ready'],
        ['ts: a novel class and its members are ready',
            { 'a.ts': 'export const one = 1;\n' },
            dir => write(dir, 'b.ts', 'export class FreshBox {\n  freshSize() { return 1; }\n}\n'),
            'freshSize:added=ready'],
    ];
    for (const [label, files, change, expected] of CASES) {
        it(label, () => {
            const dir = repo(files);
            try {
                change(dir);
                const result = checked(dir);
                assert.ok(verdicts(result).includes(expected), verdicts(result).join('  '));
            } finally { rm(dir); }
        });
    }
});
