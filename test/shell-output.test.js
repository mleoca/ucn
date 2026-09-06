'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn, execFileSync } = require('child_process');
const { tmp, rm, idx } = require('./helpers');
const { execute } = require('../core/execute');
const { formatPublicText } = require('../core/output/public');
const cli = path.resolve(__dirname, '../cli/index.js');
const run = (dir, ...args) => spawnSync(process.execPath, [cli, dir, ...args], {
    encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
});
const records = text => text.split('\n').filter(Boolean);
const fixture = {
    'package.json': '{}',
    'lib.js': 'function helper(x) {\n  return x + 1;\n}\nmodule.exports = { helper };',
    'app.js': 'const { helper } = require("./lib");\nfunction run() { return helper(1); }',
};

describe('release shell contracts', () => {
    it('lists accessor dependency sites with filterable unverified tags', () => {
        const dir = tmp({ 'lib.ts': [
            'class Box { get value() { return 1; } }',
            'function read(o) { return o.value; }',
        ].join('\n') });
        try {
            const result = run(dir, 'impact', 'value', '--lines');
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /^lib.ts:2:.*\t# unverified: .*; property-access$/m);
            assert.match(result.stderr, /^# PROPERTY ACCESS SITES: 0 confirmed, 1 unverified/m);
        } finally { rm(dir); }
    });
    it('definition listings preserve inventory without computing caller activity', () => {
        const dir = tmp(fixture);
        try {
            const index = idx(dir);
            const expected = execute(index, 'find', { name: '*' }).result
                .map(item => `${item.relativePath}:${item.startLine}:${item.name}`).sort();
            let callerQueries = 0;
            const findCallers = index.findCallers.bind(index);
            index.findCallers = (...args) => { callerQueries++; return findCallers(...args); };
            const result = execute(index, 'find', { name: '*', lines: true });
            assert.equal(result.ok, true, result.error);
            assert.deepEqual(result.result.map(item => `${item.relativePath}:${item.startLine}:${item.name}`).sort(), expected);
            assert.equal(callerQueries, 0, 'a signature-only listing must not resolve every caller');
        } finally { rm(dir); }
    });

    it('uses the same record and failure contract in file and glob modes', () => {
        const dir = tmp(fixture);
        try {
            for (const target of [path.join(dir, 'lib.js'), path.join(dir, '*.js')]) {
                const found = run(target, 'search', 'helper', '--lines');
                assert.equal(found.status, 0, found.stderr);
                assert.ok(records(found.stdout).every(line => /^[^:]+:\d+:/.test(line)));
                const empty = run(target, 'search', 'NO_SUCH_TEXT', '--lines');
                assert.equal(empty.status, 1, empty.stderr);
                assert.equal(empty.stdout, '');
                assert.equal(run(target, 'source', 'NO_SUCH_SYMBOL', '--raw').status, 2);
            }
        } finally { rm(dir); }
    });

    it('honors max-lines for every class in an explicit all extraction', () => {
        const dir = tmp({
            'a.js': 'class Thing {\n  one() {}\n  two() {}\n}',
            'b.js': 'class Thing {\n  three() {}\n  four() {}\n}',
        });
        try {
            const result = run(dir, 'source', 'Thing', '--raw', '--all', '--max-lines=2');
            assert.equal(result.status, 0, result.stderr);
            assert.equal(records(result.stdout).length, 4);
            assert.equal(records(result.stderr).filter(line => line.startsWith('# Source truncated:')).length, 2);
            assert.ok(records(result.stderr).every(line => line.startsWith('# ')));
        } finally { rm(dir); }
    });
    it('raw extracts the full large class, and discloses an explicit source limit', () => {
        const code = 'class Big {\n' + Array.from({ length: 210 }, (_, i) => `  m${i}() {}`).join('\n') + '\n}';
        const dir = tmp({ ...fixture, 'big.js': code });
        try {
            const full = run(dir, 'source', 'Big', '--raw');
            assert.equal(full.status, 0, full.stderr);
            assert.equal(full.stdout, code + '\n');
            for (const name of ['Big', 'helper']) {
                const limited = run(dir, 'source', name, '--raw', '--max-lines=2');
                assert.equal(limited.status, 0, limited.stderr);
                assert.equal(records(limited.stdout).length, 2);
                assert.match(limited.stderr, /^# Source truncated:/m);
            }
        } finally { rm(dir); }
    });

    it('lists all text and structural matches beyond the former 500/50 defaults on CLI and engine', () => {
        const dir = tmp({ ...fixture, 'many.js': Array.from({ length: 530 }, () => 'helper(1);').join('\n') });
        try {
            const index = idx(dir);
            for (const [args, params] of [
                [['search', 'helper(', '--lines'], { term: 'helper(', lines: true }],
                [['search', '--type=call', '--lines'], { type: 'call', lines: true }],
            ]) {
                const expected = 532; // structural mode also includes require().
                const result = run(dir, ...args);
                assert.equal(result.status, 0, result.stderr);
                assert.equal(records(result.stdout).length, expected, result.stderr);
                const response = execute(index, 'search', params);
                assert.equal(response.ok, true, response.error);
                assert.equal(records(formatPublicText('search', response.result, params, response)).filter(l => !l.startsWith('# ')).length, expected);
                const capped = run(dir, ...args, '--limit=3');
                assert.equal(records(capped.stdout).length, 3);
                assert.match(capped.stderr, /more match\(es\)/);
            }
        } finally { rm(dir); }
    });

    it('keeps multiline notes on stderr and accepts normalized relationship sections', () => {
        const dir = tmp(fixture);
        try {
            const response = execute(idx(dir), 'show', { name: 'helper', lines: true, sections: ['CALLERS'] });
            assert.equal(response.ok, true, response.error);
            const text = formatPublicText('show', response.result, { lines: true, sections: ['CALLERS'] }, {
                ...response, note: 'first note\nsecond note',
            });
            assert.match(text, /^app.js:2:/m);
            assert.match(text, /^# second note$/m);
            const invalid = run(dir, 'show', 'helper', '--lines', '--sections=source');
            assert.equal(invalid.status, 2);
            assert.equal(invalid.stdout, '');
            assert.match(invalid.stderr, /Available: callers, callees/);
        } finally { rm(dir); }
    });

    it('never writes partial records or prose into budgeted shell output', () => {
        const dir = tmp(fixture);
        try {
            for (const args of [['show', 'helper', '--lines'], ['source', 'helper', '--raw']]) {
                const clipped = run(dir, ...args, '--max-chars=10');
                assert.equal(clipped.status, 2, clipped.stderr);
                assert.equal(clipped.stdout, '');
                assert.match(clipped.stderr, /shell output cannot be truncated/);
                const full = run(dir, ...args, '--max-chars=10000');
                assert.equal(full.status, 0, full.stderr);
                assert.equal(full.stdout, run(dir, ...args).stdout);
            }
        } finally { rm(dir); }
    });

    it('distinguishes no records (1) from invalid input and extraction failures (2)', () => {
        const dir = tmp(fixture);
        try {
            assert.equal(run(dir, 'find', 'doesNotExist', '--lines').status, 1);
            for (const args of [
                ['search', '(', '--regex', '--lines'],
                ['source', 'doesNotExist', '--raw'],
                ['find', 'helper', '--lines', '--limit=nope'],
                ['find', 'helper', '--lines', '--unknown'],
            ]) {
                const result = run(dir, ...args);
                assert.equal(result.status, 2, JSON.stringify({ args, ...result }));
                assert.equal(result.stdout, '');
            }
        } finally { rm(dir); }
    });

    it('lists Git-diff callers and preserves ambiguity warnings for symbol impact', () => {
        const dir = tmp({ ...fixture, 'other.js': 'function helper(y) { return y; }' });
        try {
            const symbol = run(dir, 'impact', 'helper', '--lines');
            assert.equal(symbol.status, 0, symbol.stderr);
            assert.match(symbol.stderr, /definitions for "helper"/);
            execFileSync('git', ['init', '-q', dir]);
            execFileSync('git', ['-C', dir, 'add', '.']);
            execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
            fs.writeFileSync(path.join(dir, 'lib.js'), fixture['lib.js'].replace('x + 1', 'x + 2'));
            const diff = run(dir, 'impact', '--lines');
            assert.equal(diff.status, 0, diff.stderr);
            assert.match(diff.stdout, /^app.js:2:.*helper\(1\)/m);
            assert.match(diff.stderr, /^# ACCOUNT:/m);
            assert.match(diff.stderr, /^# Diff: 1 modified/m);
        } finally { rm(dir); }
    });

    it('keeps filenames beginning with a comment marker and escaped newlines as records', () => {
        const dir = tmp({ '# odd.js': 'function unusual() {}', 'new\nline.js': 'function unusual2() {}' });
        try {
            const result = run(dir, 'find', 'unusual*', '--lines');
            assert.equal(result.status, 0, result.stderr);
            assert.equal(records(result.stdout).length, 2);
            assert.match(result.stdout, /^\.\/# odd.js:1:/m);
            assert.match(result.stdout, /^new\\nline.js:1:/m);
        } finally { rm(dir); }
    });

    it('handles a consumer closing a large output pipe without an unhandled EPIPE', async () => {
        const dir = tmp({ 'many.js': 'helper();\n'.repeat(10000) });
        try {
            const child = spawn(process.execPath, [cli, dir, 'search', 'helper', '--lines']);
            let stderr = '';
            child.stderr.on('data', data => { stderr += data; });
            child.stdout.once('data', () => child.stdout.destroy());
            const status = await new Promise((resolve, reject) => {
                child.on('error', reject);
                child.on('close', resolve);
            });
            assert.equal(status, 0, stderr);
            assert.doesNotMatch(stderr, /EPIPE|Unhandled/);
        } finally { rm(dir); }
    });
});
