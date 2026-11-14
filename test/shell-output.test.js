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

describe('fix #504: result summaries survive bounded output with their warnings', () => {
    const { applyOutputBudget } = require('../core/output-budget');
    it('keeps the result and every warning, or explicitly withholds across both surfaces', () => {
        const warnings = [
            'WARNING: 4 computed dispatch calls choose members at runtime.',
            'WARNING: 2 dynamic reflection calls have no static member spelling.',
            'WARNING: source coverage is incomplete; candidate names in skipped source were suppressed.',
        ];
        const summaries = [
            ['deadcode', 'Dead code: 8 unused symbol(s)'],
            ['plan', 'VERDICT: review'],
        ];
        for (const [command, summary] of summaries) {
            const text = [summary, '', '  candidate detail\n'.repeat(100), ...warnings].join('\n');
            for (const limit of [1, 60, 150, 300, 400, 500, 520, 600, 1000]) {
                const results = ['cli', 'mcp'].map(surface => applyOutputBudget(text, {
                    command, maxChars: limit, surface, peerText: text,
                    trailingChars: surface === 'cli' ? 1 : 0,
                }));
                for (const result of results) {
                    assert.ok(result.text.length <= limit);
                    const lines = result.text.split('\n').map(line => line.trim());
                    if (![summary, ...warnings].every(line => lines.includes(line))) {
                        assert.ok(result.text === '' || /withheld/.test(result.text), result.text);
                        assert.strictEqual(result.contractMetadataComplete, false);
                        assert.doesNotMatch(result.text, /candidate detail/);
                    } else {
                        assert.strictEqual(result.contractMetadataComplete, true);
                    }
                    const total = result.text.match(/OUTPUT TRUNCATED(?: \((\d+)→|: (\d+) chars total)/);
                    if (limit >= 300) assert.ok(total, result.text);
                    if (total) assert.strictEqual(Number(total[1] || total[2]), text.length);
                }
                const required = result => result.text.split('\n').filter(line =>
                    line === summary || warnings.includes(line));
                assert.deepStrictEqual(required(results[0]), required(results[1]));
                assert.strictEqual(results[0].contractMetadataComplete, results[1].contractMetadataComplete);
            }
        }
    });

    it('advertises enough room when the required budget gains another digit', () => {
        for (const length of [870, 900, 920, 950, 970, 990]) {
            const full = 'Dead code: 1 unused symbol(s)\n' + '  details\n'.repeat(200) +
                'WARNING: ' + 'x'.repeat(length);
            for (const surface of ['cli', 'mcp']) {
                const options = { command: 'deadcode', surface, peerText: full,
                    trailingChars: surface === 'cli' ? 1 : 0 };
                const small = applyOutputBudget(full, { ...options, maxChars: 300 });
                const needed = Number(small.text.match(/at least (\d+)/)?.[1]);
                assert.ok(needed > 300, small.text);
                const enough = applyOutputBudget(full, { ...options, maxChars: needed });
                assert.doesNotMatch(enough.text, /withheld/);
                assert.ok(enough.text.includes('WARNING: ' + 'x'.repeat(length)));
                assert.ok(enough.text.includes('Dead code: 1 unused symbol(s)'));
            }
        }
    });
});

describe('release shell contracts', () => {
    it('lists accessor dependency sites with filterable unverified tags', () => {
        const dir = tmp({ 'lib.ts': [
            'class Box { get value() { return 1; } }',
            'function read(o) { return o.value; }',
        ].join('\n') });
        try {
            const result = run(dir, 'impact', 'value', '--lines');
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /^lib.ts:2:.*\t# unverified: .*; property-access: read, column \d+$/m);
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
            assert.match(invalid.stderr, /Invalid show lines sections "source"\. Valid: callers, callees\./);
        } finally { rm(dir); }
    });

    it('raw source is never cut: an exceeded budget refuses before any output', () => {
        const dir = tmp(fixture);
        try {
            const args = ['source', 'helper', '--raw'];
            const clipped = run(dir, ...args, '--max-chars=10');
            assert.equal(clipped.status, 2, clipped.stderr);
            assert.equal(clipped.stdout, '');
            assert.match(clipped.stderr, /shell output cannot be truncated/);
            const full = run(dir, ...args, '--max-chars=10000');
            assert.equal(full.status, 0, full.stderr);
            assert.equal(full.stdout, run(dir, ...args).stdout);
        } finally { rm(dir); }
    });

    it('a line listing under a budget prints the rows that fit and counts the rest', () => {
        const dir = tmp({
            'package.json': '{}',
            'lib.js': 'function helper(x) {\n  return x + 1;\n}\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\n' +
                Array.from({ length: 40 }, (_, i) => `function run${i}() { return helper(${i}); }`).join('\n'),
        });
        try {
            for (const args of [
                ['show', 'helper', '--lines'],
                ['impact', 'helper', '--lines'],
                ['usages', 'helper', '--lines'],
                ['search', 'helper', '--lines'],
                ['find', 'run*', '--lines'],
            ]) {
                const label = args.join(' ');
                const full = run(dir, ...args);
                assert.equal(full.status, 0, `${label}: ${full.stderr}`);
                const rows = records(full.stdout);
                assert.ok(rows.length >= 40, `${label}: ${rows.length} rows`);
                const comments = records(full.stderr);
                const fullChars = full.stdout.length + full.stderr.length;

                // A budget the whole listing fits in changes nothing.
                const roomy = run(dir, ...args, `--max-chars=${fullChars}`);
                assert.equal(roomy.stdout, full.stdout, label);
                assert.equal(roomy.stderr, full.stderr, label);

                for (const budget of [fullChars - 1, Math.floor(fullChars / 2), comments.join('\n').length + 200]) {
                    const cut = run(dir, ...args, `--max-chars=${budget}`);
                    assert.equal(cut.status, 0, `${label} at ${budget}: ${cut.stderr}`);
                    const kept = records(cut.stdout);
                    // Whole records only, the first ones, in their order.
                    assert.ok(kept.length > 0 && kept.length < rows.length, `${label} at ${budget}: ${kept.length} rows`);
                    assert.deepEqual(kept, rows.slice(0, kept.length), `${label} at ${budget}`);
                    const said = records(cut.stderr);
                    // Every accounting line survives, then one line counts the rest.
                    assert.deepEqual(said.slice(0, -1), comments, `${label} at ${budget}`);
                    assert.equal(said.at(-1),
                        `# truncated: ${rows.length - kept.length} of ${rows.length} rows omitted; raise --max-chars or omit it`,
                        `${label} at ${budget}`);
                    assert.ok(cut.stdout.length + cut.stderr.length <= budget, `${label} at ${budget}: over budget`);
                    // The next row would not have fitted.
                    const nextSaid = [...comments,
                        `# truncated: ${rows.length - kept.length - 1} of ${rows.length} rows omitted; raise --max-chars or omit it`];
                    assert.ok([...rows.slice(0, kept.length + 1), ...nextSaid].join('\n').length + 1 > budget,
                        `${label} at ${budget}: a row that fits was left out`);
                }

                // Not one row fits: nothing is printed and the command says why.
                const none = run(dir, ...args, '--max-chars=10');
                assert.equal(none.status, 2, label);
                assert.equal(none.stdout, '', label);
                assert.match(none.stderr, /not one row fits/, label);
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


describe('fix #499: budgeted output keeps its accounting and semantic lines', () => {
    const { applyOutputBudget } = require('../core/output-budget');
    const { normalizeSurfaceGuidance } = require('./agent-public-surface-benchmark');
    it('withholds incomplete line accounting across tiny budgets and keeps ordered whole rows otherwise', () => {
        const shapes = [
            ['a.js:1:target()', '# ACCOUNT: ' + 'x'.repeat(220), '# CONTRACT: degraded'],
            ['# ACCOUNT: ' + 'x'.repeat(120), '# CONTRACT: complete'],
            ['a.js:1:' + '𐐀'.repeat(1000), '', '# ACCOUNT: all', '# CONTRACT: complete'],
            ...[1, 10, 40].map(count => [...Array.from({ length: count }, (_, i) => `a.js:${i + 1}:target(${i})`),
                '# ACCOUNT: first target', '# CONTRACT: first complete', '# ACCOUNT: second target', '# CONTRACT: second complete']),
        ];
        for (const lines of shapes) {
            const text = lines.join('\n');
            const accounts = lines.filter(line => line.startsWith('# '));
            const rows = lines.filter(line => line && !line.startsWith('# '));
            for (const limit of [1, 20, 70, 100, 200, 300, 500, 1200]) {
                const result = applyOutputBudget(text, { command: 'show', maxChars: limit, surface: 'mcp', params: { lines: true } });
                assert.ok(result.text.length <= limit);
                const shown = result.text.split('\n').filter(line => line && !line.startsWith('# '));
                if (accounts.some(line => !result.text.split('\n').includes(line))) {
                    assert.equal(result.contractMetadataComplete, false);
                    assert.ok(result.text === '' || /withheld/.test(result.text), result.text);
                    assert.deepEqual(shown, []);
                } else {
                    assert.deepEqual(shown, rows.slice(0, shown.length));
                    if (result.truncated) assert.match(result.text, new RegExp(`# truncated: ${rows.length - shown.length} of ${rows.length} rows omitted`));
                }
            }
        }
    });

    it('pairs native presentation costs while checking actual full-size and hard-limit facts independently', () => {
        const dir = path.join(__dirname, 'fixtures', 'agent-benchmark');
        const index = idx(dir);
        const params = { sections: 'summary,health', deep: true, exclude: 'tests' };
        const execution = execute(index, 'repo', params);
        assert.equal(execution.ok, true);
        const cliText = formatPublicText('repo', execution.result, params, { ...execution, surface: 'cli' });
        const mcpText = formatPublicText('repo', execution.result, params, { ...execution, surface: 'mcp' });
        for (const limit of [500, 800, 1200, 2000, 3000, 4000]) {
            const cli = applyOutputBudget(cliText, { command: 'repo', maxChars: limit, surface: 'cli', params, trailingChars: 1, peerText: mcpText });
            const mcp = applyOutputBudget(mcpText, { command: 'repo', maxChars: limit, surface: 'mcp', params, peerText: cliText });
            assert.ok(cli.text.length + 1 <= limit);
            assert.ok(mcp.text.length <= limit);
            assert.equal(cli.fullChars, cliText.length);
            assert.equal(mcp.fullChars, mcpText.length);
            for (const [result, full] of [[cli, cliText], [mcp, mcpText]]) {
                const total = result.text.match(/OUTPUT TRUNCATED: (\d+) chars total/);
                if (total) assert.equal(Number(total[1]), full.length);
            }
            assert.equal(normalizeSurfaceGuidance(cli.text.trimEnd()), normalizeSurfaceGuidance(mcp.text.trimEnd()), `budget ${limit}`);
        }
        const semantic = 'ACCOUNT: 5 confirmed\nCONTRACT: complete\nfile.js:8:call()\n# truncated: 2 of 5 rows omitted; raise --max-chars or omit it\n... OUTPUT TRUNCATED: 4000 chars total; hard limit 500. Use --max-chars=N.';
        for (const mutated of [semantic.replace('5 confirmed', '4 confirmed'), semantic.replace('complete', 'degraded'),
            semantic.replace('file.js:8:call()\n', ''), semantic.replace('2 of 5', '3 of 5'), semantic.replace('hard limit 500', 'hard limit 501')]) {
            assert.notEqual(normalizeSurfaceGuidance(mutated), normalizeSurfaceGuidance(semantic));
        }
    });

    it('paired withheld notices reserve full-size digit widths and keep identical trust lines', () => {
        for (const count of [2, 9, 10, 99, 100]) {
            const trust = [...Array.from({ length: count - 1 }, (_, i) => `ACCOUNT: t${i}`), 'CONTRACT: ' + 'x'.repeat(800)];
            const tail = '\n' + trust.join('\n');
            for (const boundary of [1000, 10000]) {
                if (tail.length + 6 > boundary - 1) continue;
                const smaller = 'Next: ' + 'a'.repeat(boundary - 1 - tail.length - 6) + tail;
                const larger = 'Next: b' + smaller.slice(6);
                for (const [cliText, mcpText] of [[smaller, larger], [larger, smaller]]) {
                    for (const limit of [...Array.from({ length: 160 }, (_, i) => i + 1), 199, 200, 299, 300, 399, 400, 499, 500]) {
                        const cli = applyOutputBudget(cliText, { command: 'show', maxChars: limit, surface: 'cli', trailingChars: 1, peerText: mcpText });
                        const mcp = applyOutputBudget(mcpText, { command: 'show', maxChars: limit, surface: 'mcp', peerText: cliText });
                        const label = `${cliText.length}/${mcpText.length} chars, ${count} trust lines, budget ${limit}`;
                        assert.deepEqual(cli.contractMetadata, mcp.contractMetadata, label);
                        assert.equal(cli.contractMetadataComplete, mcp.contractMetadataComplete, label);
                        assert.equal(cli.text.match(/(\d+ of \d+) trust line/)?.[1], mcp.text.match(/(\d+ of \d+) trust line/)?.[1], label);
                        assert.ok(cli.text.length + 1 <= limit, label);
                        assert.ok(mcp.text.length <= limit, label);
                        assert.equal(cli.fullChars, cliText.length);
                        assert.equal(mcp.fullChars, mcpText.length);
                    }
                }
            }
        }
    });

    it('real MCP caller listings explicitly withhold at 100 and 200 chars', async () => {
        const { McpClient } = require('./helpers');
        const client = new McpClient();
        try {
            await client.start(); await client.initialize();
            for (const max_chars of [100, 200]) {
                const result = await client.callTool({ command: 'show', project_dir: path.join(__dirname, 'fixtures', 'agent-benchmark'),
                    name: 'processCheckout', lines: true, max_chars });
                assert.equal(result.isError, false);
                assert.ok(result.text.length <= max_chars);
                assert.match(result.text, /Answer withheld/);
            }
        } finally { client.stop(); }
    });
});


describe('fix #499: CLI shell budgets count the emitted newline', () => {
    it('interactive raw extraction prints its mandatory note and refuses a budget that cannot carry it', () => {
        const dir = tmp({ 'lib.js': 'function target() {\n  const value = 1;\n  return value;\n}\n' });
        try {
            const args = ['source', 'target', '--raw', '--max-lines=2'];
            const full = run(dir, ...args);
            const repl = command => spawnSync(process.execPath, [cli, dir, '--interactive'], {
                input: command + '\nquit\n', encoding: 'utf8',
            });
            const shown = repl(args.join(' '));
            assert.equal(shown.status, 0, shown.stderr);
            assert.ok(shown.stdout.includes(full.stdout + full.stderr), shown.stdout);
            assert.match(shown.stdout, /# Source truncated:[^\n]+\nucn> Goodbye!/);
            const refused = repl(args.join(' ') + ` --max-chars=${full.stdout.length}\nfind target`);
            assert.doesNotMatch(refused.stdout, /function target\(/);
            assert.match(refused.stdout + refused.stderr, /exceeds --max-chars/);
            assert.doesNotMatch(refused.stdout + refused.stderr, /Internal error/);
            assert.match(refused.stdout, /Found 1 match/);
            const exact = repl(args.join(' ') + ` --max-chars=${full.stdout.length + full.stderr.length}`);
            assert.ok(exact.stdout.includes(full.stdout + full.stderr), exact.stdout);
        } finally { rm(dir); }
    });

    it('counts raw extraction notes before emitting any source', () => {
        const dir = tmp({ 'lib.js': 'function target() {\n  const value = 1;\n  return value;\n}\n' });
        try {
            const args = ['source', 'target', '--raw', '--max-lines=2'];
            const full = run(dir, ...args);
            assert.equal(full.status, 0, full.stderr);
            assert.match(full.stderr, /Source truncated/);
            const total = full.stdout.length + full.stderr.length;
            for (const limit of [full.stdout.length - 1, full.stdout.length, total - 1, total, total + 1]) {
                const result = run(dir, ...args, `--max-chars=${limit}`);
                if (limit < total) {
                    assert.equal(result.status, 2, `${limit}: ${result.stdout}`);
                    assert.equal(result.stdout, '');
                    assert.match(result.stderr, /exceeds --max-chars/);
                } else {
                    assert.equal(result.status, 0, result.stderr);
                    assert.equal(result.stdout, full.stdout);
                    assert.equal(result.stderr, full.stderr);
                    assert.ok(result.stdout.length + result.stderr.length <= limit);
                }
            }
        } finally { rm(dir); }
    });

    it('keeps actual stdout and accounting stderr within exact-fit row budgets', () => {
        const dir = tmp({ 'lib.js': 'function target() {}\n' + Array.from({ length: 20 }, (_, i) => `function c${i}() { target(); }`).join('\n') });
        try {
            const full = run(dir, 'show', 'target', '--lines');
            const total = full.stdout.length + full.stderr.length;
            for (const limit of [total - 1, total, total + 1, 300, 301]) {
                const result = run(dir, 'show', 'target', '--lines', `--max-chars=${limit}`);
                if (result.status === 0) assert.ok(result.stdout.length + result.stderr.length <= limit, `${limit}: ${result.stdout.length + result.stderr.length}`);
                else assert.equal(result.status, 2, result.stderr);
            }
            const source = run(dir, 'source', 'target', '--raw');
            for (const limit of [source.stdout.length - 1, source.stdout.length, source.stdout.length + 1]) {
                const result = run(dir, 'source', 'target', '--raw', `--max-chars=${limit}`);
                if (limit < source.stdout.length) {
                    assert.equal(result.status, 2);
                    assert.equal(result.stdout, '');
                } else {
                    assert.equal(result.status, 0, result.stderr);
                    assert.equal(result.stdout, source.stdout);
                    assert.ok(result.stdout.length <= limit);
                }
            }
        } finally { rm(dir); }
    });
});
