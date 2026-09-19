'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmp, rm, idx, CLI_PATH, McpClient } = require('./helpers');
const { execute } = require('../core/execute');
const { formatPublicJson, formatPublicText } = require('../core/output/public');
const cli = (dir, ...args) => spawnSync(process.execPath, [CLI_PATH, dir, ...args], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

describe('5.3.8 fresh audit regressions', () => {
    for (const [file, source] of Object.entries({
        'm.py': 'def beta(x): return x\ndef probe(b):\n    sink(b.beta)\n    sink(0, b.beta)\n    sink(key=b.beta)\n    sink([b.beta])\n    value = b.beta\n    return len(b.a1)\n',
        'm.js': 'function beta(x) { return x; }\nfunction probe(b) {\n    sink(b.beta);\n    sink(0, b.beta);\n    sink({key: b.beta});\n    sink([b.beta]);\n    const value = b.beta;\n    return len(b.a1);\n}',
    })) {
        it(`attribute data references never become calls in ${file}`, () => {
            const dir = tmp({ [file]: source });
            try {
                const index = idx(dir);
                const impact = execute(index, 'impact', { name: 'beta', includeTests: true }).result;
                assert.equal(impact.totalCallSites, 0);
                assert.equal(impact.unverifiedSites.length, 0);
                assert.equal(impact.account.nonCall.references, 5);
                assert.equal(impact.account.conserved, true);
                const trace = execute(index, 'trace', { name: 'probe', direction: 'callees', depth: 1, all: true }).result;
                assert.equal(trace.tree.calleeAccount.totalSites, 5);
                assert.equal(trace.tree.calleeAccount.conserved, true);
                assert.equal((trace.unverifiedFrontier || []).some(r => ['a1', 'beta'].includes(r.name)), false);
            } finally { rm(dir); }
        });
    }

    it('genuine typed method references survive in positional and keyword arguments', () => {
        const dir = tmp({ 'm.py': 'class Worker:\n    def run(self): pass\ndef use():\n    w = Worker()\n    sink(w.run)\n    sink(cb=w.run)\n' });
        try {
            const index = idx(dir);
            const result = execute(index, 'context', { name: 'Worker.run' }).result;
            assert.deepEqual(result.callers.map(c => c.line), [5, 6]);
            assert.ok(result.callers.every(c => c.isFunctionReference));
            assert.equal(result.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('property values belong to the property-access band, not the callable-reference model', () => {
        const dir = tmp({ 'm.py': 'class Box:\n    @property\n    def records(self): return []\ndef probe(b): return len(b.records)\n' });
        try {
            const result = execute(idx(dir), 'impact', { name: 'Box.records', includeTests: true }).result;
            assert.equal(result.unverifiedSites.length, 0);
            assert.equal(result.account.unverified, 0);
            assert.equal(result.account.nonCall.references, 1);
            assert.equal(result.account.conserved, true);
        } finally { rm(dir); }
    });

    it('uses language-aware test conventions, preserves explicit exclusions, and discloses structural omissions', () => {
        const production = ['normal.py', 'spectrum.py', 'respectable.py', 'inspector.py', 'conftest.py', 'spec.py', 'specs.py', 'chart_spec.py', 'foo_spec.py', 'my.spec.py'];
        const tests = ['test_x.py', 'x_test.py'];
        const files = Object.fromEntries([...production, ...tests].map((f, i) => [f, `def target${i}(): pass\n`]));
        files['web/widget.spec.ts'] = 'export function targetWeb() {}';
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const response = execute(index, 'search', { type: 'function', lines: true });
            assert.deepEqual(response.result.results.map(r => r.file).sort(), production.sort());
            assert.equal(response.result.meta.filesSkipped, 3);
            assert.match(response.note, /3 test file\(s\) hidden/);
            const empty = execute(index, 'search', { type: 'function', file: 'test_x.py', lines: true });
            assert.equal(empty.result.results.length, 0);
            assert.equal(empty.result.meta.filesSkipped, 1);
            assert.match(formatPublicText('search', empty.result, { lines: true }, empty), /test file\(s\) hidden/);
            const all = execute(index, 'search', { type: 'function', includeTests: true }).result;
            assert.equal(all.results.length, 13);
            assert.equal(all.meta.filesSkipped, 0);
            const explicit = execute(index, 'search', { type: 'function', exclude: ['spec'], includeTests: true }).result;
            assert.equal(explicit.results.some(r => r.file === 'chart_spec.py'), false);
            const usages = execute(index, 'usages', { name: 'target7' });
            assert.equal(usages.result.length, 1);
            assert.doesNotMatch(usages.note || '', /test-file usage/);
        } finally { rm(dir); }
    });

    it('JSON paths round-trip through absolute and relative handles without changing engine paths', async () => {
        const dir = tmp({ 'lib.js': 'export function target(x) { return x; }\n', 'use.js': 'import { target } from "./lib.js";\nfunction run() { return target(1); }\n' });
        const client = new McpClient();
        try {
            const index = idx(dir);
            for (const [command, params] of [['find', { name: 'target', exact: true }], ['usages', { name: 'target' }], ['show', { name: 'target' }], ['deps', { file: 'lib.js' }]]) {
                const response = execute(index, command, params);
                assert.equal(response.ok, true, response.error);
                const envelope = JSON.parse(formatPublicJson(command, response.result, params, response));
                assert.equal(envelope.meta.pathBase, index.root);
                const walk = object => {
                    if (!object || typeof object !== 'object') return;
                    for (const [key, value] of Object.entries(object)) {
                        if (['file', 'callerFile', 'from', 'to'].includes(key) && typeof value === 'string') assert.equal(path.isAbsolute(value), false, `${command}.${key}`);
                        walk(value);
                    }
                };
                walk(envelope.data);
            }
            assert.ok(path.isAbsolute(index.find('target', { exact: true, skipCounts: true })[0].file));
            const absolute = `${path.join(dir, 'lib.js')}:1:target`;
            for (const command of ['show', 'impact', 'source', 'check', 'trace']) {
                const response = cli(dir, command, absolute, '--json');
                assert.equal(response.status, 0, `${command}: ${response.stderr}`);
            }
            assert.equal(cli(dir, 'show', path.join(dir, 'lib.js') + ':1', '--json').status, 0);
            await client.start(); await client.initialize();
            const response = await client.callTool({ project_dir: dir, command: 'show', name: absolute });
            assert.equal(!!response.isError, false, response.text);
            assert.match(response.text, /target/);
        } finally { client.stop(); rm(dir); }
    });

    for (const extension of ['js', 'ts', 'tsx', 'html']) {
        it(`flags stored-promise value misuse while preserving legitimate uses in ${extension}`, () => {
            const code = [
                'async function load() { return 2; }',
                'async function arithmetic() { const v = load(); return v + 1; }',
                'async function method() { const v = load(); return v.toFixed(2); }',
                'async function condition() { const v = load(); if (v) return 2; }',
                'async function assignment() { let v; v = load(); return v + 1; }',
                'async function returned() { const v = load(); return v; }',
                'async function awaited() { const v = load(); return (await v) + 1; }',
                'async function awaitedInit() { const v = await load(); return v + 1; }',
                'async function handled() { const v = load(); return v.then(x => x + 1).catch(console.error); }',
                'async function combined() { const v = load(); return Promise.all([v]); }',
                'async function overwritten() { let v = load(); v = 2; return v + 1; }',
                'async function shadowed() { const v = load(); { const v = 2; sink(v + 1); } return v; }',
                'async function closure() { const v = load(); function inner(v) { return v + 1; } return v; }',
                'async function loop() { const v = load(); for (const v of [1, 2]) sink(v + 1); return v; }',
                'async function caught() { const v = load(); try { throw 1; } catch (v) { sink(v + 1); } return v; }',
                'async function destructured() { const v = load(); { const {v} = {v: 2}; sink(v + 1); } return v; }',
                'async function wrapped() { const v = await (load()); return v + 1; }',
            ].join('\n');
            const dir = tmp({ [`a.${extension}`]: extension === 'html' ? `<script>${code}</script>` : code });
            try {
                const response = execute(idx(dir), 'auditAsync', {});
                assert.deepEqual(response.result.issues.map(i => i.callerName), ['arithmetic', 'method', 'condition', 'assignment']);
                assert.ok(response.result.issues.every(i => i.reason === 'stored-promise-used-as-value' && i.variable === 'v'));
                assert.match(formatPublicText('auditAsync', response.result, {}, response), /used as a resolved value/);
            } finally { rm(dir); }
        });
    }

    it('parameter plans specify valid keyword syntax for keyword-bearing Python calls', () => {
        const dir = tmp({ 'm.py': 'def compute(a, b=2): return a + b\ndef use(): return compute(1, b=3)\n' });
        try {
            const result = execute(idx(dir), 'plan', { name: 'compute', addParam: 'c' }).result;
            const site = result.changes.find(c => c.editKind === 'call');
            assert.match(site.suggestion, /Add keyword argument: c=c/);
            assert.deepEqual(site.args, ['1', 'b=3']);
            const syntax = spawnSync('python3', ['-c', 'import ast; ast.parse("compute(1, b=3, c=c)")'], { encoding: 'utf8' });
            assert.equal(syntax.status, 0, syntax.stderr);
        } finally { rm(dir); }
    });
});
