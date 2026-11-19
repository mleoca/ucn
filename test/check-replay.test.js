'use strict';

/**
 * fix #510: the history replay of the pre-commit check. Unit tests for the
 * pure policy (eval/check-replay-policy.js), the pinned list
 * (eval/check-replay-commits.js) and the runner's option parser, fed with
 * small hand-written answers. No network, no git, no CLI.
 */

require('./helpers/cache-root'); // isolated cache root (fix #433)
const { describe, it } = require('node:test');
const assert = require('node:assert');

const policy = require('../eval/check-replay-policy');
const { REPLAY_REPOS } = require('../eval/check-replay-commits');
const { REPOS } = require('../eval/lib/repos');
const { parseArgs, UsageError } = require('../eval/run-check-replay');

const { STATUS } = policy;
const sha = n => n.toString(16).padStart(40, '0');

function repo(name, count, knownBreaks = []) {
    const commits = [];
    for (let i = 0; i < count; i++) commits.push({ commit: sha(1000 * (name.length + 1) + 2 * i + 1), parent: sha(1000 * (name.length + 1) + 2 * i + 2) });
    return { name, url: `https://example.test/${name}`, commits, knownBreaks };
}

function item(kind, verdict, reasons = [], extra = {}) {
    return { name: extra.name || `${kind}Fn`, file: 'src/a.go', line: 10, kind, verdict, reasons, ...extra };
}

function answer(items, extra = {}) {
    const count = verdict => items.filter(entry => entry.verdict === verdict).length;
    const worst = count('blocked') ? STATUS.blocked : count('review') ? STATUS.review : STATUS.ready;
    return {
        ok: true, status: 'checked', changed: items,
        trust: { status: worst, blocked: count('blocked'), review: count('review'), ready: count('ready') },
        ...extra,
    };
}

function cliRun(data, exitCode) {
    return { exitCode, signal: null, stdout: JSON.stringify({ meta: { command: 'check' }, data }), timedOut: false, spawnError: null };
}

describe('fix #510: check replay pinned list', () => {
    it('pins 40 commits of each of the eight repositories under the URL the eval board uses', () => {
        assert.deepStrictEqual(policy.validateReplayList(REPLAY_REPOS), []);
        assert.deepStrictEqual(REPLAY_REPOS.map(entry => entry.name),
            ['chi', 'click', 'cobra', 'hono', 'httpx', 'itertools', 'ripgrep', 'zod']);
        for (const entry of REPLAY_REPOS) {
            assert.strictEqual(entry.commits.length, 40, entry.name);
            assert.match(entry.tip, /^[0-9a-f]{40}$/, entry.name);
            assert.ok(Array.isArray(entry.pathspec) && entry.pathspec.length > 0, entry.name);
            const board = REPOS.find(pinned => pinned.name === entry.name);
            if (board) {
                assert.strictEqual(entry.url, board.url, `${entry.name}: the URL eval/lib/repos.js pins`);
                assert.strictEqual(entry.language, board.language, entry.name);
            }
        }
    });

    it('refuses a malformed list', () => {
        const good = repo('alpha', 2);
        assert.deepStrictEqual(policy.validateReplayList([good]), []);
        assert.deepStrictEqual(policy.validateReplayList([]), ['the pinned list names no repository']);
        const problems = list => policy.validateReplayList(list).join('\n');
        assert.match(problems([good, good]), /alpha: listed twice/);
        assert.match(problems([{ ...good, url: 'http://example.test/alpha' }]), /https URL/);
        assert.match(problems([{ ...good, commits: [] }]), /no commit is pinned/);
        assert.match(problems([{ ...good, commits: [{ commit: 'abc', parent: sha(9) }] }]), /full lowercase SHAs/);
        assert.match(problems([{ ...good, commits: [{ commit: sha(9), parent: sha(9) }] }]), /its own parent/);
        assert.match(problems([{ ...good, commits: [good.commits[0], good.commits[0]] }]), /pinned twice/);
        assert.match(problems([{ name: 'Bad Name', url: 'https://x', commits: good.commits }]), /invalid repository name/);
    });

    it('requires a known break to name a pinned commit and state its evidence', () => {
        const base = repo('alpha', 2);
        const problems = marks => policy.validateReplayList([{ ...base, knownBreaks: marks }]).join('\n');
        assert.strictEqual(problems([{ commit: base.commits[0].commit, evidence: 'go vet: too many arguments' }]), '');
        assert.match(problems([{ commit: sha(77), evidence: 'x' }]), /is not a pinned commit/);
        assert.match(problems([{ commit: base.commits[0].commit, evidence: ' ' }]), /states no toolchain evidence/);
        assert.match(problems([{ commit: base.commits[0].commit }]), /states no toolchain evidence/);
        const twice = { commit: base.commits[0].commit, evidence: 'e' };
        assert.match(problems([twice, twice]), /marked twice/);
        assert.match(problems('none'), /knownBreaks must be a list/);
    });
});

describe('fix #510: one check answer as a scored row', () => {
    it('counts verdicts per kind and keeps the reason set of every item that is not ready', () => {
        const row = policy.summarizeCheck(answer([
            item('modified', 'review', ['path-end-changed', 'header'], { name: 'b' }),
            item('modified', 'review', ['header', 'path-end-changed'], { name: 'a' }),
            item('added', 'ready'),
            item('module', 'review', ['module-name-in-use']),
            item('deleted', 'review', ['name-still-used']),
            item('modified', 'ready'),
        ]));
        assert.strictEqual(row.status, STATUS.review);
        assert.deepStrictEqual(Object.keys(row.items), ['added', 'modified', 'deleted', 'module']);
        assert.deepStrictEqual(row.items.modified, { ready: 1, review: 2, blocked: 0 });
        assert.deepStrictEqual(row.reasonSets, [
            { kind: 'modified', reasons: ['header', 'path-end-changed'], items: 2 },
            { kind: 'deleted', reasons: ['name-still-used'], items: 1 },
            { kind: 'module', reasons: ['module-name-in-use'], items: 1 },
        ]);
        assert.deepStrictEqual(row.blocked, []);
    });

    it('sums outgoing-call reasons by calls, most calls first', () => {
        const row = policy.summarizeCheck(answer([
            item('modified', 'review', ['outgoing-call-unverified'], {
                outgoingCalls: { unverified: 3, reasons: [{ reason: 'call-interface-unverified', calls: 2 }, { reason: 'result-use-unverified', calls: 1 }] },
            }),
            item('added', 'review', ['outgoing-call-unverified'], {
                outgoingCalls: { unverified: 2, reasons: [{ reason: 'result-use-unverified', calls: 2 }] },
            }),
        ]));
        assert.deepStrictEqual(row.outgoingReasons, [
            { reason: 'result-use-unverified', calls: 3 },
            { reason: 'call-interface-unverified', calls: 2 },
        ]);
    });

    it('keeps each blocked item with its mismatch rows and sites, in location order', () => {
        const row = policy.summarizeCheck(answer([
            item('modified', 'blocked', ['outgoing-signature-mismatch'], {
                name: 'run', file: 'b.rs', line: 5,
                mismatches: [
                    { file: 'b.rs', line: 9, target: 'helper', expression: '  helper(a,\n    b)  ', expected: '1 arg(s)', actual: 2, args: ['a', 'b'], patterns: {} },
                    { file: 'a.rs', line: 3, problem: 'too many arguments', unchecked: true },
                ],
            }),
            item('deleted', 'blocked', ['still-referenced'], {
                name: 'gone', file: 'a.rs', line: 1,
                sites: [{ file: 'c.rs', line: 4, kind: 'call' }, { file: 'a.rs', line: 8, kind: 'import' }],
            }),
            item('modified', 'review', ['header']),
        ]));
        assert.strictEqual(row.status, STATUS.blocked);
        assert.deepStrictEqual(row.blocked.map(entry => entry.name), ['gone', 'run']);
        assert.deepStrictEqual(row.blocked[1].mismatches, [
            { file: 'a.rs', line: 3, problem: 'too many arguments', unchecked: true },
            { file: 'b.rs', line: 9, target: 'helper', expression: 'helper(a, b)', expected: '1 arg(s)', actual: 2 },
        ]);
        assert.deepStrictEqual(row.blocked[0].sites, [
            { file: 'a.rs', line: 8, kind: 'import' },
            { file: 'c.rs', line: 4, kind: 'call' },
        ]);
    });

    it('reads "no changes" as NO-VERDICT and a check that did not run as an ERROR row', () => {
        assert.deepStrictEqual(policy.summarizeCheck({ ok: true, empty: true, status: 'clean', reason: '2 changed path(s), all outside supported source files' }),
            { status: STATUS.noVerdict, noVerdictReason: '2 changed path(s), all outside supported source files' });
        assert.deepStrictEqual(policy.summarizeCheck({ ok: false, status: 'diff-failed', error: 'git diff failed\nbad object' }),
            { status: STATUS.error, error: 'check did not run (diff-failed): git diff failed' });
    });

    it('turns an answer that disagrees with itself or with the known statuses into an ERROR row', () => {
        const error = data => policy.summarizeCheck(data);
        assert.strictEqual(error(null).status, STATUS.error);
        assert.match(error({ ok: true, changed: [], trust: { status: 'MAYBE' } }).error, /unknown check status "MAYBE"/);
        assert.match(error({ ok: true, trust: { status: STATUS.ready, blocked: 0, review: 0, ready: 0 } }).error, /no changed list/);
        const counted = answer([item('modified', 'review', ['header'])]);
        assert.match(error({ ...counted, trust: { ...counted.trust, review: 2 } }).error, /trust counts disagree/);
        assert.match(error({ ...counted, trust: { ...counted.trust, status: STATUS.ready } }).error, /disagrees with the item verdicts/);
        assert.match(error(answer([item('modified', 'maybe')])).error, /verdict "maybe"/);
        assert.match(error(answer([item('modified', 'review', [], { outgoingCalls: { reasons: [{ reason: 'x', calls: -1 }] } })])).error, /malformed/);
    });
});

describe('fix #510: one CLI run as a scored row', () => {
    const blocked = answer([item('modified', 'blocked', ['outgoing-signature-mismatch'])]);
    const review = answer([item('modified', 'review', ['header'])]);

    it('accepts an answer whose exit code it explains', () => {
        assert.strictEqual(policy.readCliRun(cliRun(blocked, 1)).status, STATUS.blocked);
        assert.strictEqual(policy.readCliRun(cliRun(review, 0)).status, STATUS.review);
        assert.strictEqual(policy.readCliRun(cliRun({ ok: true, empty: true, reason: 'no changes detected' }, 0)).status, STATUS.noVerdict);
    });

    it('counts a crash, a timeout, a stopped process and unparsable output as ERROR rows', () => {
        const run = extra => policy.readCliRun({ ...cliRun(review, 0), ...extra });
        assert.deepStrictEqual(run({ timedOut: true }), { status: STATUS.error, error: 'the CLI did not finish within the time limit' });
        assert.deepStrictEqual(run({ spawnError: 'ENOBUFS' }), { status: STATUS.error, error: 'the CLI could not run (ENOBUFS)' });
        assert.deepStrictEqual(run({ signal: 'SIGKILL', exitCode: null }), { status: STATUS.error, error: 'the CLI was stopped by SIGKILL' });
        assert.deepStrictEqual(run({ exitCode: 1, stdout: 'TypeError: x is undefined' }),
            { status: STATUS.error, error: 'the CLI exited 1 without JSON output' });
        assert.deepStrictEqual(run({ stdout: '{"meta":{}}' }), { status: STATUS.error, error: 'the CLI exited 0 without a data field' });
        assert.deepStrictEqual(policy.readCliRun(cliRun(blocked, 0)), { status: STATUS.error, error: 'the CLI exited 0 for BLOCKED' });
        assert.deepStrictEqual(policy.readCliRun(cliRun(review, 2)), { status: STATUS.error, error: 'the CLI exited 2 for REVIEW_REQUIRED' });
    });
});

describe('fix #510: the gate over replayed history', () => {
    const alpha = repo('alpha', 3);
    const rowsOf = (name, statuses) => statuses.map((status, i) => ({
        repo: name,
        commit: alpha.commits[i].commit,
        status,
        ...(status === STATUS.blocked && { blocked: [{ name: 'run', kind: 'modified', file: 'a.go', line: 1, reasons: ['outgoing-signature-mismatch'], mismatches: [], sites: [] }] }),
        ...(status === STATUS.error && { error: 'the CLI exited 1 without JSON output' }),
    }));

    it('fails a BLOCKED commit no known break names', () => {
        const result = policy.evaluateReplay(rowsOf('alpha', [STATUS.review, STATUS.blocked, STATUS.ready]), [alpha]);
        assert.deepStrictEqual(result.blockedFailures.map(row => row.commit), [alpha.commits[1].commit]);
        assert.deepStrictEqual(result.failures,
            [`alpha ${alpha.commits[1].commit}: BLOCKED on an accepted upstream commit: run (modified)`]);
    });

    it('holds a BLOCKED commit a known break names with its evidence', () => {
        const pinned = { ...alpha, knownBreaks: [{ commit: alpha.commits[1].commit, evidence: 'cargo check: E0061' }] };
        const result = policy.evaluateReplay(rowsOf('alpha', [STATUS.review, STATUS.blocked, STATUS.ready]), [pinned]);
        assert.deepStrictEqual(result.failures, []);
        assert.deepStrictEqual(result.knownBreaks, [{ repo: 'alpha', commit: alpha.commits[1].commit, evidence: 'cargo check: E0061' }]);
    });

    it('fails a known-break mark whose commit is answered anything but BLOCKED (stale pin)', () => {
        const pinned = { ...alpha, knownBreaks: [{ commit: alpha.commits[0].commit, evidence: 'go vet: too many arguments' }] };
        const result = policy.evaluateReplay(rowsOf('alpha', [STATUS.review, STATUS.ready, STATUS.noVerdict]), [pinned]);
        assert.deepStrictEqual(result.stalePins, [{ repo: 'alpha', commit: alpha.commits[0].commit, status: STATUS.review }]);
        assert.match(result.failures.join('\n'), /marked as a known break and answered REVIEW_REQUIRED; remove the mark/);
    });

    it('does not judge a mark whose commit the run did not replay, and reports an errored one as an error', () => {
        const pinned = { ...alpha, knownBreaks: [
            { commit: alpha.commits[2].commit, evidence: 'pyright: reportCallIssue' },
            { commit: alpha.commits[0].commit, evidence: 'tsc: TS2554' },
        ] };
        const result = policy.evaluateReplay(rowsOf('alpha', [STATUS.error, STATUS.review]), [pinned]);
        assert.deepStrictEqual(result.unjudgedPins, [{ repo: 'alpha', commit: alpha.commits[2].commit }]);
        assert.deepStrictEqual(result.stalePins, []);
        assert.deepStrictEqual(result.errors, [{ repo: 'alpha', commit: alpha.commits[0].commit, error: 'the CLI exited 1 without JSON output' }]);
        assert.deepStrictEqual(result.failures, [`alpha ${alpha.commits[0].commit}: error row: the CLI exited 1 without JSON output`]);
    });

    it('fails a run that replayed nothing and a list that is not usable', () => {
        assert.deepStrictEqual(policy.evaluateReplay([], [alpha]).failures, ['no commit was replayed']);
        const broken = { ...alpha, knownBreaks: [{ commit: sha(5), evidence: 'x' }] };
        assert.match(policy.evaluateReplay(rowsOf('alpha', [STATUS.review]), [broken]).failures[0],
            /^pinned list: alpha: known break .* is not a pinned commit$/);
    });

    it('orders findings by repository, then by pinned order, whatever order the rows come in', () => {
        const beta = repo('beta', 2);
        const rows = [
            ...rowsOf('alpha', [STATUS.blocked, STATUS.blocked]),
            { repo: 'beta', commit: beta.commits[1].commit, status: STATUS.blocked, blocked: [] },
            { repo: 'beta', commit: beta.commits[0].commit, status: STATUS.blocked, blocked: [] },
        ];
        const expected = policy.evaluateReplay(rows, [alpha, beta]);
        const reversed = policy.evaluateReplay([...rows].reverse(), [beta, alpha]);
        assert.deepStrictEqual(reversed, expected);
        assert.deepStrictEqual(expected.blockedFailures.map(row => `${row.repo}:${row.commit}`), [
            `alpha:${alpha.commits[0].commit}`, `alpha:${alpha.commits[1].commit}`,
            `beta:${beta.commits[0].commit}`, `beta:${beta.commits[1].commit}`,
        ]);
    });
});

describe('fix #510: rates and the lever list', () => {
    const rows = [
        policy.summarizeCheck(answer([item('modified', 'ready'), item('added', 'ready')])),
        policy.summarizeCheck(answer([
            item('modified', 'review', ['header']),
            item('modified', 'review', ['header', 'path-end-changed']),
            item('added', 'review', ['outgoing-call-unverified']),
        ])),
        policy.summarizeCheck(answer([item('modified', 'review', ['header']), item('modified', 'ready')])),
        { status: STATUS.noVerdict, noVerdictReason: 'no changes detected' },
        { status: STATUS.error, error: 'the CLI exited 1 without JSON output' },
    ];

    it('gives commit shares by status and the READY share of items by kind', () => {
        const summary = policy.summarizeRows(rows);
        assert.strictEqual(summary.commits, 5);
        assert.deepStrictEqual(summary.statuses, {
            READY_FOR_TOOLCHAIN: 1, REVIEW_REQUIRED: 2, BLOCKED: 0, 'NO-VERDICT': 1, ERROR: 1,
        });
        assert.deepStrictEqual(summary.shares, { ready: 0.2, review: 0.4, blocked: 0, noVerdict: 0.2, error: 0.2 });
        assert.deepStrictEqual(summary.items, {
            added: { ready: 1, review: 1, blocked: 0, total: 2, readyShare: 0.5 },
            modified: { ready: 2, review: 3, blocked: 0, total: 5, readyShare: 0.4 },
        });
        assert.deepStrictEqual(policy.summarizeRows([]).shares, { ready: null, review: null, blocked: null, noVerdict: null, error: null });
    });

    it('ranks reasons by the items they alone hold, then by every item holding them', () => {
        const summary = policy.summarizeRows(rows);
        assert.deepStrictEqual(summary.reasonSets, [
            { kind: 'modified', reasons: ['header'], items: 2 },
            { kind: 'added', reasons: ['outgoing-call-unverified'], items: 1 },
            { kind: 'modified', reasons: ['header', 'path-end-changed'], items: 1 },
        ]);
        assert.deepStrictEqual(summary.levers, [
            { reason: 'header', alone: 2, total: 3 },
            { reason: 'outgoing-call-unverified', alone: 1, total: 1 },
            { reason: 'path-end-changed', alone: 0, total: 1 },
        ]);
        assert.deepStrictEqual(policy.leverList([
            { kind: 'modified', reasons: ['b'], items: 1 },
            { kind: 'modified', reasons: ['a'], items: 1 },
        ]).map(lever => lever.reason), ['a', 'b']);
    });

    it('gives the same scored fields and the same rollup whatever order the inputs come in', () => {
        assert.deepStrictEqual(JSON.stringify(policy.summarizeRows([...rows].reverse())), JSON.stringify(policy.summarizeRows(rows)));
        const reportOf = (name, list) => ({
            repo: name,
            scored: { rows: list, summary: policy.summarizeRows(list), evaluation: policy.evaluateReplay(list.map(row => ({ repo: name, ...row })), [repo(name, 5)]) },
        });
        const reports = [reportOf('beta', rows.slice(0, 2)), reportOf('alpha', rows.slice(2))];
        const text = policy.formatRollup(reports, { date: '2026-01-01' });
        assert.strictEqual(policy.formatRollup([...reports].reverse(), { date: '2026-01-01' }), text);
        assert.ok(text.indexOf('| alpha |') < text.indexOf('| beta |'));
        assert.match(text, /\| \*\*all\*\* \| 5 \| 1 \| 2 \| 0 \| 1 \| 1 \| 0\.2 \|/);
        assert.match(text, /Blocked on accepted history: none/);
        assert.match(text, /Error rows: 1/);
        assert.match(text, /\| header \| 2 \| 3 \|/);
    });
});

describe('fix #510: runner options', () => {
    it('reads the documented options and refuses anything else', () => {
        assert.deepStrictEqual(parseArgs([]), { repos: null, limit: null, gate: false, cli: null, cacheDir: null, help: false });
        assert.deepStrictEqual(parseArgs(['--repo', 'cobra,ripgrep', '--limit=3', '--gate', '--cli', 'x/cli/index.js', '--cache-dir=/c']),
            { repos: ['cobra', 'ripgrep'], limit: 3, gate: true, cli: 'x/cli/index.js', cacheDir: '/c', help: false });
        assert.strictEqual(parseArgs(['--help']).help, true);
        for (const argv of [['--only', 'x'], ['--limit', '0'], ['--limit', 'two'], ['--repo'], ['--repo', '--gate'],
            ['--repo', ','], ['--limit', '1', '--limit', '2'], ['cobra'], ['--cli=']]) {
            assert.throws(() => parseArgs(argv), UsageError, argv.join(' '));
        }
    });
});
