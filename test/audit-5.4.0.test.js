'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');
const { tmp, rm, idx, CLI_PATH, McpClient } = require('./helpers');
const { execute } = require('../core/execute');
const { formatPublicText, formatPublicJson } = require('../core/output/public');
const { applyOutputBudget } = require('../core/output-budget');
const cli = (dir, ...args) => spawnSync(process.execPath, [CLI_PATH, dir, ...args], { encoding: 'utf8' });
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
function baseline(dir) {
    git(dir, 'init', '-q');
    git(dir, 'add', '.');
    git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'baseline');
}

describe('5.4.0 independent audit regressions', () => {
    it('F1: type-only diffs expose references and block an unvalidated shape change', () => {
        const dir = tmp({
            'types.ts': 'export interface Point {\n  x: number;\n}\n',
            'use.ts': 'import { Point } from "./types";\nexport function read(p: Point) { return p.x; }\n',
        });
        try {
            baseline(dir);
            fs.writeFileSync(dir + '/types.ts', 'export interface Point {\n  x: number;\n  z: number;\n}\n');
            const index = idx(dir);
            const response = execute(index, 'impact', {});
            assert.equal(response.ok, true);
            const point = response.result.symbols.find(s => s.name === 'Point');
            assert.equal(point.type, 'interface');
            assert.equal(point.impact.typeReferences.confirmedCount, 1);
            const text = formatPublicText('impact', response.result, {}, response);
            assert.match(text, /MODIFIED DECLARATIONS/);
            assert.match(text, /TYPE REFERENCE SITES: 1 confirmed/);
            assert.doesNotMatch(text, /BY FILE:/);
            const shell = cli(dir, 'impact', '--lines');
            assert.match(shell.stdout, /types.ts:1:Point/);
            assert.match(shell.stdout, /use.ts:2:.*type-reference/);
            const checked = cli(dir, 'check', '--json');
            assert.equal(checked.status, 1, checked.stderr);
            const data = JSON.parse(checked.stdout).data;
            assert.equal(data.trust.status, 'BLOCKED');
            assert.ok(data.changed.some(s => s.name === 'Point' && s.dependencyCount === 1));
            assert.ok(data.actions.some(a => a.kind === 'declaration_change'));
        } finally { rm(dir); }
    });

    it('F1: class base changes, deletion, and tracked/untracked additions retain their declarations', () => {
        const dir = tmp({
            'core.py': 'class Base:\n    pass\nclass Child(Base):\n    def run(self): pass\n',
            'gone.py': 'class Removed:\n    pass\n',
            'use.py': 'from core import Child\nfrom gone import Removed\nx = Child()\ny = Removed()\n',
        });
        try {
            baseline(dir);
            fs.writeFileSync(dir + '/core.py', 'class Base(dict):\n    pass\n');
            fs.unlinkSync(dir + '/gone.py');
            fs.writeFileSync(dir + '/new.py', 'class Registry:\n    def add(self): pass\n');
            let result = execute(idx(dir), 'impact', {}).result;
            assert.ok(result.symbols.some(s => s.name === 'Base'));
            assert.deepEqual(result.deletedSymbols.map(s => s.name).sort(), ['Child', 'Removed']);
            assert.ok(result.deletedSymbols.every(s => s.remainingReferences.length > 0));
            assert.ok(result.newSymbols.some(s => s.name === 'Registry'));
            assert.ok(result.newFunctions.some(s => s.name === 'add'));
            git(dir, 'add', '.');
            result = execute(idx(dir), 'impact', { staged: true }).result;
            assert.ok(result.newSymbols.some(s => s.name === 'Registry'));
            const limited = execute(idx(dir), 'check', { limit: 1 }).result;
            assert.equal(limited.truncated, true);
            assert.ok(limited.actions.some(a => a.kind === 'truncated_change_set'));
        } finally { rm(dir); }
    });

    it('F2: aliases use their own arguments, including mixed and nested calls on one line', () => {
        const dir = tmp({
            'core.py': 'def compute(a, b=2, *, scale=1): return a+b\nhandler = compute\ndef use(): return handler() + compute(1) + handler(2)\ndef nested(): return handler(handler())\n',
            'use.py': 'from core import compute as add_them\ndef bad(): return add_them()\ndef valid(): return add_them(1, scale=3)\n',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'check', { name: 'core.py:1:compute' }).result;
            assert.equal(result.mismatches, 3);
            assert.equal(result.valid, 4);
            assert.equal(result.uncertain, 0);
            assert.deepEqual(result.mismatchDetails.map(s => [s.file, s.line, s.actual]), [
                ['core.py', 3, 0], ['core.py', 4, 0], ['use.py', 2, 0],
            ]);
            const impact = index.impact('compute', { file: 'core.py', line: 1 });
            assert.equal(impact.byFile.flatMap(g => g.sites).filter(s => Array.isArray(s.args)).length, 7);
        } finally { rm(dir); }
    });

    it('F2: JavaScript import aliases are verified without changing bind uncertainty', () => {
        const dir = tmp({
            'lib.js': 'export function compute(a) { return a; }\n',
            'use.js': 'import { compute as other } from "./lib";\nother(); other(1);\nother.bind(null);\n',
        });
        try {
            const result = idx(dir).verify('compute');
            assert.equal(result.mismatches, 1);
            assert.equal(result.valid, 1);
            assert.ok(result.uncertainDetails.every(s => !s.reason.includes('Could not parse')));
        } finally { rm(dir); }
    });

    it('F3: JavaScript runtime handlers never receive a Java-specific disclosure', () => {
        const dir = tmp({ 'events.js': 'target.onmessage = function handler(event) { return event; };\n' });
        try {
            const response = execute(idx(dir), 'deadcode', {});
            assert.ok(response.result.excludedRuntimeContract > 0);
            const text = formatPublicText('deadcode', response.result, {}, response);
            assert.match(text, /runtime callback/);
            assert.doesNotMatch(text, /Java serialization|JVM/);
        } finally { rm(dir); }
    });

    it('F4: output budgets include notices, metadata, and the CLI newline', () => {
        const source = 'HEAD\n' + 'x'.repeat(4000) + '\nACCOUNT: accounted\nCONTRACT: complete\n';
        for (const limit of [1, 80, 499, 500, 800, 1500, 3000]) {
            for (const trailingChars of [0, 1]) {
                const result = applyOutputBudget(source, { command: 'repo', maxChars: limit, trailingChars });
                assert.ok(result.text.length + trailingChars <= limit, `${limit}: ${result.text.length}`);
                assert.equal(result.requestedLimit, limit);
                if (limit >= 500) assert.match(result.text, /ACCOUNT: accounted/);
            }
        }
        const dir = tmp({ 'lib.js': Array.from({ length: 30 }, (_, i) => `function unused${i}() { return ${i}; }`).join('\n') });
        try {
            for (const limit of [500, 800, 1500]) {
                for (const command of ['repo', 'deadcode']) {
                    const result = cli(dir, command, `--max-chars=${limit}`);
                    assert.equal(result.status, 0, result.stderr);
                    assert.ok(result.stdout.length <= limit, `${command}: ${result.stdout.length} > ${limit}`);
                }
            }
        } finally { rm(dir); }
    });

    it('F5: shell usages emit one JSX row per line while JSON preserves occurrences', () => {
        const dir = tmp({ 'view.tsx': 'function Widget() { return null; }\nconst a = <Widget>inline</Widget>;\nconst b = <Widget>\n  child\n</Widget>;\nconst c = <Widget />;\n' });
        try {
            const result = cli(dir, 'usages', 'Widget', '--lines');
            const rows = result.stdout.trim().split('\n');
            assert.equal(rows.length, 5);
            assert.equal(rows.filter(r => r.startsWith('view.tsx:2:')).length, 1);
            assert.match(rows.find(r => r.startsWith('view.tsx:2:')), /call; reference; 2 occurrences/);
            const json = JSON.parse(cli(dir, 'usages', 'Widget', '--json').stdout);
            assert.equal(json.data.filter(r => r.line === 2).length, 2);
        } finally { rm(dir); }
    });

    it('F6: route scope and test labels agree across CLI, JSON, and MCP', async () => {
        const dir = tmp({
            'api/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/live")\ndef live(): return {}\n',
            'tests/test_api.py': 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/test")\ndef test_route(): return {}\n',
            'client.js': 'fetch("/live");\nfetch("/test");\n',
        });
        const client = new McpClient();
        try {
            const index = idx(dir);
            const response = execute(index, 'endpoints', { bridge: true });
            assert.equal(response.result.meta.testRoutes, 1);
            assert.match(formatPublicText('endpoints', response.result, {}, response), /\[test\]/);
            const envelope = JSON.parse(formatPublicJson('endpoints', response.result, {}, response));
            assert.equal(envelope.data.routes.filter(r => r.isTest).length, 1);
            const production = execute(index, 'endpoints', { excludeTests: true, bridge: true }).result;
            assert.deepEqual(production.routes.map(r => r.path), ['/live']);
            assert.ok(production.bridges.every(b => !b.route.isTest && !b.request.isTest));
            assert.deepEqual(production.unmatchedRequests.map(r => r.path), ['/test']);
            const scoped = cli(dir, 'endpoints', '--in=api/', '--json');
            assert.equal(JSON.parse(scoped.stdout).data.routes.length, 1);
            await client.start(); await client.initialize();
            const mcp = await client.callTool({ command: 'endpoints', project_dir: dir, exclude_tests: true });
            assert.equal(mcp.isError, false);
            assert.match(mcp.text, /\/live/);
            assert.doesNotMatch(mcp.text, /→ test_route/);
        } finally { client.stop(); rm(dir); }
    });

    it('accessor impact distinguishes reads/writes and confirms an inherited owner without overriding', () => {
        const dir = tmp({ 'props.py': 'class Base:\n    @property\n    def value(self): return 1\nclass Child(Base):\n    def bump(self): self.value = self.value + 1\nclass Override(Base):\n    @property\n    def value(self): return 2\n    def read(self): return self.value\n' });
        try {
            const index = idx(dir);
            const response = execute(index, 'impact', { name: 'props.py:2:value' });
            const access = response.result.propertyAccesses;
            assert.deepEqual(access.byFile.flatMap(f => f.sites).map(s => s.accessKind), ['write', 'read']);
            assert.equal(access.unverifiedSites.length, 1);
            const text = formatPublicText('impact', response.result, {}, response);
            assert.match(text, /\[write, column \d+\]/);
            assert.match(text, /\[read, column \d+\]/);
            assert.doesNotMatch(text, /BY FILE:/);
        } finally { rm(dir); }
    });

    it('Python coroutine expressions discarded in sync scopes are audited, consumers are respected', () => {
        const dir = tmp({
            'lib.py': 'async def fetch_row(x): return x\n',
            'app.py': 'import asyncio\nfrom lib import fetch_row\ndef dropped():\n    fetch_row(1)\ndef returned(): return fetch_row(2)\ndef consumed(): asyncio.run(fetch_row(3))\ndef stored():\n    value = fetch_row(4)\n    return value\nfetch_row(5)\n',
        });
        try {
            const result = idx(dir).auditAsync();
            assert.deepEqual(result.issues.map(i => [i.file, i.line, i.callerName]), [
                ['app.py', 4, 'dropped'], ['app.py', 10, '<module>'],
            ]);
        } finally { rm(dir); }
    });
});
