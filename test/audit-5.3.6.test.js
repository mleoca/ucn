'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmp, rm, idx, CLI_PATH, McpClient } = require('./helpers');
const { ProjectIndex } = require('../core/project');
const { execute } = require('../core/execute');
const { formatPublicJson, formatPublicText } = require('../core/output/public');
const { saveCache, loadCache, isCacheStale } = require('../core/cache');

const cli = (dir, ...args) => spawnSync(process.execPath, [CLI_PATH, dir, ...args], {
    encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
});
const json = (command, response, params = {}) =>
    JSON.parse(formatPublicJson(command, response.result, params, response));

// Audit IDs are those in the 17 September 2026 report.
describe('5.3.6 audit regressions', () => {
    it('F1: filters and bounds broad find queries before caller adjudication', () => {
        const dir = tmp({
            'lib.js': Array.from({ length: 40 }, (_, i) => `function query${i}() {}`).join('\n') +
                '\nclass QueryClass {}\nquery39();\nquery39();',
        });
        try {
            const index = idx(dir);
            const findCallers = index.findCallers.bind(index);
            let calls = 0;
            index.findCallers = (...args) => { calls++; return findCallers(...args); };
            for (const bound of [{ limit: 5 }, { limit: 2 }]) {
                calls = 0;
                const response = execute(index, 'find', { name: 'query', ...bound });
                assert.equal(response.ok, true, response.error);
                assert.equal(calls, bound.limit);
                assert.equal(response.result.length, bound.limit);
                assert.equal(response.result[0].name, 'query39');
                assert.equal(response.result[0].usageCounts.confirmedCalls, 2);
                assert.equal(response.result.findInfo.total, 41);
                assert.match(response.note, /approximate usage totals/);
            }
            calls = 0;
            const filtered = execute(index, 'find', { name: 'query', type: 'class', limit: 1 });
            assert.equal(filtered.result[0].name, 'QueryClass');
            assert.equal(calls, 1);
            calls = 0;
            const pinned = execute(index, 'find', { name: 'lib.js:20:query19', limit: 1 });
            assert.equal(pinned.result[0].name, 'query19');
            assert.equal(calls, 1);
            calls = 0;
            assert.equal(execute(index, 'find', { name: 'query', lines: true }).result.length, 41);
            assert.equal(calls, 0);
        } finally { rm(dir); }
    });

    it('F2: shared defaults cap find, api, deadcode and repo files with totals; usages stays uncapped', () => {
        const files = Object.fromEntries(Array.from({ length: 510 }, (_, i) => [
            `src/f${String(i).padStart(3, '0')}.js`, `export function listed${i}() {}\n// inventoryToken\n`,
        ]));
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const cases = [
                ['find', { name: 'listed' }],
                ['api', {}],
                ['deadcode', { includeExported: true }],
            ];
            for (const [command, params] of cases) {
                const response = execute(index, command, params);
                assert.equal(response.ok, true, `${command}: ${response.error}`);
                assert.equal(response.result.length, 500, command);
                const envelope = json(command, response, params);
                assert.equal(envelope.meta.total, 510, command);
                assert.equal(envelope.meta.truncated, true, command);
                assert.match(response.note, /Showing 500 of 510/);
                assert.equal(execute(index, command, { ...params, limit: 505 }).result.length, 505);
            }
            assert.equal(execute(index, 'find', { name: 'listed', lines: true }).result.length, 510);
            assert.equal(execute(index, 'usages', { name: 'inventoryToken' }).result.length, 510);
            assert.equal(execute(index, 'usages', { name: 'inventoryToken', lines: true }).result.length, 510);
            const repo = execute(index, 'repo', { sections: 'files' });
            assert.equal(repo.result.files.files.length, 500);
            assert.equal(repo.result.files.totals.files, 510);
            assert.equal(repo.result.files.hiddenFiles, 10);
            assert.equal(execute(index, 'repo', { sections: 'files', limit: 505 }).result.files.files.length, 505);
            assert.equal(execute(index, 'repo', { sections: 'files', all: true }).result.files.files.length, 510);
            assert.equal(execute(index, 'usages', { name: 'inventoryToken', limit: 5 }).result.length, 5);
        } finally { rm(dir); }
    });

    it('F3: bundles and maps are disclosed, withdraw completeness, and survive warm caches', () => {
        const dir = tmp({
            'package.json': '{}',
            'lib.js': 'export function target() {}',
            'vendor.min.js': 'function bundledOnly() {}\ntarget();',
            'vendor.bundle.js': 'target();',
            'vendor.js.map': '{"sourcesContent":["target();"]}',
            '.gitignore': 'ignored.min.js\n',
            'ignored.min.js': 'target();',
        });
        try {
            const index = idx(dir);
            assert.deepEqual(index.discoveryIssues.map(i => i.relativePath),
                ['vendor.bundle.js', 'vendor.js.map', 'vendor.min.js']);
            const repo = execute(index, 'repo', { sections: 'summary,health' });
            assert.deepEqual(repo.result.summary.skippedSources.reasons, { bundled: 3 });
            assert.equal(repo.result.health.trust, 'PARTIAL');
            const impact = execute(index, 'impact', { name: 'target' });
            assert.equal(impact.result.account.contract.textComplete, false);
            assert.equal(impact.result.account.skippedSources.length, 3);
            for (const command of ['find', 'usages']) {
                const response = execute(index, command, { name: 'bundledOnly', exact: true });
                assert.match(response.note, /UCN skipped 3 bundled/);
                assert.match(response.note, /--include-bundled/);
            }
            const cacheFile = path.join(dir, '.cache-test', 'index.json');
            saveCache(index, cacheFile);
            const warm = new ProjectIndex(dir);
            assert.equal(loadCache(warm, cacheFile), true);
            assert.deepEqual(warm.discoveryIssues, JSON.parse(JSON.stringify(index.discoveryIssues)));
            assert.equal(isCacheStale(warm), false);
            fs.writeFileSync(path.join(dir, 'added.min.js'), 'target();');
            warm._lastFreshAt = 0;
            assert.equal(isCacheStale(warm), true);
            fs.unlinkSync(path.join(dir, 'added.min.js'));
            fs.unlinkSync(path.join(dir, 'vendor.bundle.js'));
            warm._lastFreshAt = 0;
            assert.equal(isCacheStale(warm), true);
            const opted = new ProjectIndex(dir);
            opted.build(null, { quiet: true, includeBundled: true });
            assert.equal(opted.find('bundledOnly', { exact: true, skipCounts: true }).length, 1);
            assert.deepEqual(opted.discoveryIssues.map(i => i.relativePath), ['vendor.js.map']);
            assert.equal(opted.files.has(path.join(dir, 'ignored.min.js')), false);
        } finally { rm(dir); }
    });

    it('F3: CLI and MCP bundle opt-in does not contaminate the default index', async () => {
        const dir = tmp({
            'package.json': '{}',
            'lib.js': 'function ordinary() {}',
            'tiny.min.js': 'function bundledOnly() {}\nbundledOnly();',
        });
        const client = new McpClient();
        try {
            const defaultRun = cli(dir, 'find', 'bundledOnly', '--exact', '--json');
            assert.equal(defaultRun.status, 0, defaultRun.stderr);
            assert.equal(JSON.parse(defaultRun.stdout).data.length, 0);
            const opted = cli(dir, 'find', 'bundledOnly', '--exact', '--include-bundled', '--json');
            assert.equal(opted.status, 0, opted.stderr);
            assert.equal(JSON.parse(opted.stdout).data.length, 1);
            assert.equal(JSON.parse(cli(dir, 'find', 'bundledOnly', '--exact', '--json').stdout).data.length, 0);
            await client.start();
            await client.initialize();
            const params = { project_dir: dir, command: 'find', name: 'bundledOnly', exact: true };
            assert.match((await client.callTool(params)).text, /UCN skipped 1/);
            const mcp = await client.callTool({ ...params, include_bundled: true });
            assert.equal(!!mcp.isError, false, mcp.text);
            assert.match(mcp.text, /tiny.min.js:1:bundledOnly/);
            assert.doesNotMatch(mcp.text, /ignored \(not applicable/);
            assert.match((await client.callTool(params)).text, /UCN skipped 1/);
            assert.equal(JSON.parse(cli(dir, 'find', 'bundledOnly', '--exact', '--json').stdout).data.length, 0);
        } finally { client.stop(); rm(dir); }
    });

    it('F4: diff and check count untracked non-source paths, respecting staged and file scope', () => {
        const dir = tmp({ 'tracked.md': 'old\n', '.gitignore': 'ignored.md\n' });
        const git = (...args) => {
            const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
        };
        try {
            git('init', '-q');
            git('add', '.');
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
            fs.writeFileSync(path.join(dir, 'tracked.md'), 'changed\n');
            fs.writeFileSync(path.join(dir, 'first.md'), 'new\n');
            fs.writeFileSync(path.join(dir, 'second.md'), 'new\n');
            fs.writeFileSync(path.join(dir, 'ignored.md'), 'ignored\n');
            fs.writeFileSync(path.join(dir, 'new.py'), 'def introduced():\n    return 1\n');
            const index = idx(dir);
            for (const command of ['impact', 'check']) {
                const response = execute(index, command, {});
                assert.equal(response.ok, true, response.error);
                assert.equal(response.result.changedPaths, 4, command);
                assert.equal(response.result.nonSourcePaths, 3, command);
                assert.equal(response.result.untrackedPaths, 1, command);
                assert.match(formatPublicText(command, response.result, {}, response), /3 changed path\(s\) outside supported source/);
                assert.equal(execute(index, command, { staged: true }).result.changedPaths, 0);
                const scoped = execute(index, command, { file: 'first.md' });
                assert.equal(scoped.result.nonSourcePaths, 1);
            }
            fs.unlinkSync(path.join(dir, 'new.py'));
            const docsOnly = execute(idx(dir), 'check', {});
            assert.equal(docsOnly.result.changedPaths, 3);
            assert.match(docsOnly.result.reason, /3 changed path/);
        } finally { rm(dir); }
    });

    it('F5: errors exit 2 in text/shell modes and preserve the JSON error contract', () => {
        const dir = tmp({ 'lib.js': 'function found() {}' });
        try {
            for (const args of [
                ['find', 'found', '--bogus-flag'], ['bogus-command'], ['find'],
                ['show', 'no/such/file.py:1:nope'], ['find', 'found', '--limit=invalid'],
            ]) {
                for (const mode of [[], ['--lines']]) {
                    const response = cli(dir, ...args, ...mode);
                    assert.equal(response.status, 2, JSON.stringify({ args, mode, stderr: response.stderr }));
                }
                const response = cli(dir, ...args, '--json');
                assert.equal(response.status, 1, response.stderr);
                assert.equal(JSON.parse(response.stdout).meta.ok, false);
            }
            assert.equal(cli(dir, 'source', 'missing', '--raw').status, 2);
            assert.equal(cli(dir, 'find', 'absent', '--exact', '--lines').status, 1);
            assert.equal(cli(dir, 'find', 'absent', '--exact', '--json').status, 0);
        } finally { rm(dir); }
    });
});
