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
