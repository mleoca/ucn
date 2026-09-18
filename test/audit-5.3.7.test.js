'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmp, rm, idx, CLI_PATH, McpClient } = require('./helpers');
const { execute } = require('../core/execute');
const { formatPublicJson, formatPublicText } = require('../core/output/public');
const { ProjectIndex } = require('../core/project');
const { saveCache, loadCache } = require('../core/cache');

const cli = (dir, ...args) => spawnSync(process.execPath, [CLI_PATH, dir, ...args], {
    encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
});

describe('5.3.7 second-pass audit regressions', () => {
    it('api honors an exact test file and discloses broad test exclusions, including empty results', () => {
        const dir = tmp({
            'tests/conftest.py': 'def fixture_factory():\n    return 1\nPUBLIC_VALUE = 2\n',
            'lib.py': 'def public_fn():\n    return 3\n',
        });
        try {
            const index = idx(dir);
            for (const file of ['tests/conftest.py', path.join(dir, 'tests/conftest.py')]) {
                const response = execute(index, 'api', { file });
                assert.equal(response.ok, true, response.error);
                assert.deepEqual(response.result.map(s => s.name), ['fixture_factory', 'PUBLIC_VALUE']);
                assert.equal(response.result.apiInfo.excludedTestFiles, 0);
            }
            for (const params of [{}, { in: 'tests' }, { file: 'tests/' }, { limit: 1 }]) {
                const response = execute(index, 'api', params);
                assert.match(response.note, /1 test file\(s\) excluded.*--include-tests/);
                const envelope = JSON.parse(formatPublicJson('api', response.result, params, response));
                assert.equal(envelope.meta.apiInfo.excludedTestFiles, 1);
                assert.equal(response.result.some(s => s.name === 'fixture_factory'), false);
                const opted = execute(index, 'api', { ...params, includeTests: true, limit: 10 });
                assert.equal(opted.result.some(s => s.name === 'fixture_factory'), true);
            }
            const fileMode = spawnSync(process.execPath, [CLI_PATH, path.join(dir, 'tests/conftest.py'), 'api', '--json'], { encoding: 'utf8' });
            assert.equal(fileMode.status, 0, fileMode.stderr);
            assert.equal(JSON.parse(fileMode.stdout).data.length, 2);
        } finally { rm(dir); }
    });

    it('unused builds the call index at most once and preserves complete totals under limits', () => {
        const dir = tmp({
            'lib.js': Array.from({ length: 100 }, (_, i) => `function candidate${i}() {}`).join('\n') +
                '\ncandidate99();\nfunction recursive() { recursive(); }\n',
        });
        try {
            const index = idx(dir);
            const build = index.buildCalleeIndex.bind(index);
            let builds = 0;
            index.buildCalleeIndex = () => { builds++; return build(); };
            index.calleeIndex = null;
            const full = execute(index, 'search', { unused: true, includeTests: true, lines: true });
            assert.equal(builds, 1);
            assert.equal(full.result.meta.totalMatched, 100);
            assert.equal(full.result.results.some(r => r.name === 'recursive'), true);
            assert.equal(full.result.results.some(r => r.name === 'candidate99'), false);
            const limited = execute(index, 'search', { unused: true, includeTests: true, limit: 5 });
            assert.equal(builds, 1, 'warm call index must not be rebuilt per query or candidate');
            assert.equal(limited.result.meta.totalMatched, 100);
            assert.deepEqual(limited.result.results, full.result.results.slice(0, 5));
        } finally { rm(dir); }
    });

    it('CLI and MCP keep API test opt-in and unused safety/decorator evidence', async () => {
        const dir = tmp({
            'app.py': '@app.get(\n    "/items"\n)\ndef registered_route():\n    return []\n',
            'tests/conftest.py': 'def fixture_factory():\n    return 1\n',
        });
        const client = new McpClient();
        try {
            const shell = cli(dir, 'search', '--unused', '--include-tests', '--lines');
            assert.equal(shell.status, 0, shell.stderr);
            assert.match(shell.stdout, /registered_route.*# function; @app.get\( "\/items" \)/);
            assert.equal(shell.stdout.trim().split('\n').length, 2, 'multiline decorators stay on the record line');
            assert.doesNotMatch(shell.stdout, /safe-delete/);
            assert.match(shell.stderr, /# --unused.*not safe-delete proof/);
            const empty = cli(dir, 'search', 'absent', '--unused', '--lines');
            assert.equal(empty.status, 1);
            assert.match(empty.stderr, /not safe-delete proof/);
            assert.equal(JSON.parse(cli(dir, 'api', '--include-tests', '--json').stdout).data.length, 2);
            await client.start();
            await client.initialize();
            const params = { project_dir: dir, command: 'api' };
            assert.match((await client.callTool(params)).text, /1 test file\(s\) excluded.*include_tests/);
            const api = await client.callTool({ ...params, include_tests: true });
            assert.match(api.text, /fixture_factory/);
            assert.doesNotMatch(api.text, /not applicable/);
            const pinned = await client.callTool({ ...params, file: 'tests/conftest.py' });
            assert.match(pinned.text, /fixture_factory/);
            const search = await client.callTool({ ...params, command: 'search', unused: true, lines: true });
            assert.match(search.text, /not safe-delete proof/);
            assert.match(search.text, /@app.get/);
        } finally { client.stop(); rm(dir); }
    });

    const signatures = {
        'sample.py': 'def inspect(value: list[\n # param_marker\n int], note="😀#literal_marker") -> list[\n # return_marker\n int]:\n    return value\n',
        'sample.ts': 'function inspect(value: Array</* param_marker */string>, note = "/*literal_marker*/"): Array</* return_marker */string> { return value; }',
        'sample.js': 'function inspect(value /* param_marker */, note = "//literal_marker") { return value; }',
        'sample.go': 'package sample\nfunc Inspect(value [] /* param_marker */int) [] /* return_marker */int { return value }',
        'sample.rs': 'fn inspect(value: Vec</* param_marker */i32>) -> Vec</* return_marker */i32> { value }',
        'Sample.java': 'class Sample { public List</* return_marker */String> inspect(List</* param_marker */String> value) { return value; } }',
        'sample.c': 'char /* return_marker */ *inspect(char /* param_marker */ *value) { return value; }',
        'sample.cpp': 'std::vector</* return_marker */int> inspect(std::vector</* param_marker */int> value) { return value; }',
        'Sample.cs': 'class Sample { public List</* return_marker */int> Inspect(List</* param_marker */int> value, string note = "/*literal_marker*/") { return value; } }',
        'sample.html': '<script>function inspect(value /* param_marker */, note = "//literal_marker") { return value; }</script>',
    };
    for (const [file, code] of Object.entries(signatures)) {
        it(`structural signature filters ignore AST comments in ${file}`, () => {
            const dir = tmp({ [file]: code });
            try {
                const index = idx(dir);
                const search = params => execute(index, 'search', { includeTests: true, ...params }).result.results;
                assert.equal(search({ param: 'value' }).length, 1, 'positive parameter control');
                assert.equal(search({ param: 'param_marker' }).length, 0);
                assert.equal(search({ returns: 'return_marker' }).length, 0);
                if (code.includes('literal_marker')) assert.equal(search({ param: 'literal_marker' }).length, 1);
                const symbols = [...index.symbols.values()].flat();
                const callable = symbols.find(s => /inspect/i.test(s.name));
                assert.ok(callable);
                assert.doesNotMatch(JSON.stringify([callable.params, callable.paramsStructured, callable.returnType]), /param_marker|return_marker/);
                const cacheFile = path.join(dir, '.cache-test', 'index.json');
                saveCache(index, cacheFile);
                const warm = new ProjectIndex(dir);
                assert.equal(loadCache(warm, cacheFile), true);
                assert.deepEqual(execute(warm, 'search', { param: 'param_marker' }).result.results, []);
            } finally { rm(dir); }
        });
    }

    it('keeps quoted annotations and compound defaults searchable while skipping nested comments', () => {
        const dir = tmp({ 'lib.py': 'def inspect(value: "#forward_marker", other=(\n # hidden_marker\n "😀#default_marker"\n)) -> "#return_literal":\n    return value\n' });
        try {
            const index = idx(dir);
            for (const param of ['forward_marker', 'default_marker']) {
                assert.equal(index.structuralSearch({ param }).results.length, 1);
            }
            assert.equal(index.structuralSearch({ param: 'hidden_marker' }).results.length, 0);
            assert.equal(index.structuralSearch({ returns: 'return_literal' }).results.length, 1);
        } finally { rm(dir); }
    });

    it('labels persisted build time as historical index work rather than command wall time', () => {
        const dir = tmp({ 'lib.js': 'function present() {}' });
        try {
            const index = idx(dir);
            const cacheFile = path.join(dir, '.cache-test', 'index.json');
            saveCache(index, cacheFile);
            const warm = new ProjectIndex(dir);
            assert.equal(loadCache(warm, cacheFile), true);
            assert.equal(warm.buildTime, index.buildTime);
            const response = execute(warm, 'repo', { sections: 'summary,stats' });
            for (const section of ['summary', 'stats']) {
                assert.match(response.result[section].buildTimeNote, /excludes cache I\/O and query execution/);
                assert.match(response.result[section].buildTimeNote, /cached index/);
            }
            assert.match(formatPublicText('repo', response.result, {}, response), /Last index build:/);
        } finally { rm(dir); }
    });
});
