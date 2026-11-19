#!/usr/bin/env node
/**
 * eval/run-check-replay.js - does the pre-commit check block code its
 * project accepted?
 *
 * For every commit pinned in eval/check-replay-commits.js the replay puts a
 * detached worktree at the commit, in its own clone, and asks
 * `check --base=<first parent> --json` through the public CLI. Upstream
 * history on a default branch is code its project accepted, so BLOCKED is a
 * false block unless the pinned list marks that exact commit as a known
 * break with its toolchain diagnostic; the share of READY is how often the
 * answer needs no follow-up.
 *
 * The instrument fetches what it needs itself, without a full clone: each
 * pinned commit and its first parent by SHA, at depth one, into its own
 * clone under --cache-dir. Objects already there are not fetched again.
 * Every check runs with its own UCN_CACHE_DIR, emptied when a repository
 * starts and kept apart per CLI. A CLI crash or an answer that is not a
 * well-formed check result is an ERROR row, counted, never dropped.
 *
 * Without --gate the run is a measurement. With --gate a BLOCKED accepted
 * commit, a known-break mark the replay does not answer BLOCKED, or an
 * ERROR row fails it. Rates are reported, never gated.
 *
 * Exit: 0 the replay ran (and the gate passed); 1 the gate failed (--gate
 * only); 2 infrastructure or usage failure (a fetch, a git command, a
 * pinned parent that differs from the fetched commit's, a bad option):
 * never a score.
 *
 * Reports go to UCN_EVAL_REPORTS_DIR (default eval/reports): one
 * check-replay-<repo>-<date>.json per repository and the dated
 * check-replay-<date>.md rollup over every same-dated report of the same
 * kind. A --limit or --cli run gets its own suffix, so it never mixes with
 * the full replay of this tree. Only `scored` is compared between runs;
 * wall times, dates and paths are outside it.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { REPLAY_REPOS } = require('./check-replay-commits');
const policy = require('./check-replay-policy');

const TREE_CLI = path.join(__dirname, '..', 'cli', 'index.js');
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), 'ucn-check-replay');
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 256 * 1024 * 1024;
const EXIT = Object.freeze({ ok: 0, gate: 1, infrastructure: 2 });
const SCHEMA_VERSION = 1;
// Variables that would point git at another repository than the clone.
const GIT_REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'];

const USAGE = `usage: node eval/run-check-replay.js [options]

Replays pinned upstream commits through \`check --base=<first parent> --json\`.

  --repo NAME[,NAME]  replay these repositories only (default: every pinned one)
  --limit N           replay the first N pinned commits of each repository
  --gate              exit 1 on BLOCKED for an accepted commit, a stale
                      known-break mark or an error row
  --cli PATH          judge this UCN CLI (cli/index.js of another tree)
                      instead of this tree's
  --cache-dir PATH    clones and index caches (default: ${DEFAULT_CACHE_DIR})
  --help              print this text

Exit: 0 ran (gate passed), 1 gate failure (--gate only), 2 infrastructure or
usage failure. UCN_EVAL_REPORTS_DIR receives the reports.
Repositories: ${REPLAY_REPOS.map(repo => repo.name).join(', ')}.`;

class InfrastructureError extends Error {}
class UsageError extends Error {}

/** The command line as options; an unknown or malformed option is a UsageError. */
function parseArgs(argv) {
    const options = { repos: null, limit: null, gate: false, cli: null, cacheDir: null, help: false };
    const valued = { '--repo': 'repos', '--limit': 'limit', '--cli': 'cli', '--cache-dir': 'cacheDir' };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') { options.help = true; continue; }
        if (arg === '--gate') { options.gate = true; continue; }
        const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
        const flag = equals > 0 ? arg.slice(0, equals) : arg;
        if (!Object.hasOwn(valued, flag)) throw new UsageError(`unknown option ${arg}`);
        let value;
        if (equals > 0) {
            value = arg.slice(equals + 1);
        } else {
            value = argv[++i];
            if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
        }
        if (value === '') throw new UsageError(`${flag} needs a value`);
        if (options[valued[flag]] !== null) throw new UsageError(`${flag} is given twice`);
        options[valued[flag]] = value;
    }
    if (options.limit !== null) {
        if (!/^[1-9]\d*$/.test(options.limit)) throw new UsageError('--limit must be a positive integer');
        options.limit = Number(options.limit);
    }
    if (options.repos !== null) {
        options.repos = [...new Set(options.repos.split(',').map(name => name.trim()).filter(Boolean))];
        if (options.repos.length === 0) throw new UsageError('--repo names no repository');
    }
    return options;
}

function firstLine(text) {
    return String(text || '').split('\n').map(line => line.trim()).filter(Boolean)[0] || '';
}

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function elapsedMs(started) {
    return Math.round(Number(process.hrtime.bigint() - started) / 1e6);
}

/** git (and the CLI) see the clone and nothing above it. */
function cloneEnv(clone, extra = {}) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: path.dirname(clone), ...extra };
    for (const name of GIT_REDIRECTS) delete env[name];
    return env;
}

function git(clone, args, { input, allowFailure = false } = {}) {
    const run = spawnSync('git', ['-C', clone, ...args], {
        env: cloneEnv(clone), encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER,
        input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (run.error) throw new InfrastructureError(`git ${args[0]} could not run in ${clone}: ${run.error.message}`);
    if (run.status !== 0) {
        if (allowFailure) return null;
        throw new InfrastructureError(`git ${args[0]} failed in ${clone}: ${firstLine(run.stderr) || `exit ${run.status}`}`);
    }
    return run.stdout;
}

/** The instrument's own clone of a repository: a repository of its own, never one that encloses it. */
function ensureClone(reposDir, repo) {
    const clone = path.join(reposDir, repo.name);
    fs.mkdirSync(clone, { recursive: true });
    if (!fs.existsSync(path.join(clone, '.git'))) git(clone, ['init', '-q']);
    if (!fs.statSync(path.join(clone, '.git')).isDirectory()) {
        throw new InfrastructureError(`${clone}/.git is not a directory`);
    }
    const top = git(clone, ['rev-parse', '--show-toplevel']).trim();
    if (fs.realpathSync(top) !== clone) throw new InfrastructureError(`${clone} is not the top of its own repository`);
    return clone;
}

/** The pinned SHAs the clone does not hold as commits. */
function missingCommits(clone, shas) {
    const out = git(clone, ['cat-file', '--batch-check'], { input: shas.map(sha => `${sha}^{commit}`).join('\n') + '\n' });
    const lines = out.split('\n').filter(Boolean);
    return shas.filter((sha, index) => !(lines[index] || '').startsWith(`${sha} commit `));
}

/** Fetch each pinned commit and its first parent by SHA, then check the parent each commit names. */
function fetchPinned(clone, repo, commits) {
    const wanted = [...new Set(commits.flatMap(row => [row.commit, row.parent]))];
    let missing = missingCommits(clone, wanted);
    if (missing.length > 0) {
        const run = spawnSync('git', ['-C', clone, '-c', 'protocol.version=2', 'fetch', '-q', '--no-tags',
            '--depth', '1', repo.url, ...missing], {
            env: cloneEnv(clone), encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (run.error || run.status !== 0) {
            const why = run.error ? run.error.message : (firstLine(run.stderr) || `exit ${run.status}`);
            throw new InfrastructureError(`fetching ${missing.length} commit(s) from ${repo.url} failed: ${why}`);
        }
        missing = missingCommits(clone, wanted);
        if (missing.length > 0) {
            throw new InfrastructureError(`${repo.url} did not provide ${missing.length} pinned commit(s): ${missing.slice(0, 3).join(', ')}`);
        }
    }
    for (const row of commits) {
        const parents = git(clone, ['cat-file', 'commit', row.commit]).split('\n')
            .filter(line => line.startsWith('parent ')).map(line => line.slice('parent '.length));
        if (parents.length !== 1 || parents[0] !== row.parent) {
            throw new InfrastructureError(`${repo.name} ${row.commit}: pinned parent ${row.parent}, ` +
                `the commit names ${parents.length ? parents.join(', ') : 'no parent'}`);
        }
    }
}

/** One commit: a clean detached worktree at it, then the check against its first parent. */
function replayCommit(clone, row, cli, indexCache) {
    git(clone, ['checkout', '-q', '--force', '--detach', row.commit]);
    git(clone, ['clean', '-q', '-ffdx']);
    const started = process.hrtime.bigint();
    const run = spawnSync(process.execPath, [cli, clone, 'check', `--base=${row.parent}`, '--json'], {
        cwd: clone, env: cloneEnv(clone, { UCN_CACHE_DIR: indexCache }), encoding: 'utf8',
        timeout: CHECK_TIMEOUT_MS, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const wallMs = elapsedMs(started);
    const timedOut = !!(run.error && run.error.code === 'ETIMEDOUT');
    const answer = policy.readCliRun({
        exitCode: run.status,
        signal: run.signal,
        stdout: run.stdout || '',
        timedOut,
        spawnError: run.error && !timedOut ? (run.error.code || run.error.message) : null,
    });
    return { row: { commit: row.commit, parent: row.parent, ...answer }, wallMs, stderr: run.stderr || '' };
}

function statusWord(status) {
    return { READY_FOR_TOOLCHAIN: 'READY', REVIEW_REQUIRED: 'REVIEW' }[status] || status;
}

function replayRepository(repo, options, context) {
    const commits = options.limit ? repo.commits.slice(0, options.limit) : repo.commits;
    const started = process.hrtime.bigint();
    const clone = ensureClone(context.reposDir, repo);
    fetchPinned(clone, repo, commits);
    const fetchMs = elapsedMs(started);
    const indexCache = path.join(context.indexDir, `${repo.name}-${context.cliKey}`);
    fs.rmSync(indexCache, { recursive: true, force: true });
    fs.mkdirSync(indexCache, { recursive: true });

    const rows = [];
    const perCommit = [];
    const diagnostics = [];
    for (const [index, pinned] of commits.entries()) {
        const { row, wallMs, stderr } = replayCommit(clone, pinned, context.cli, indexCache);
        rows.push(row);
        perCommit.push({ commit: row.commit, wallMs });
        if (row.status === policy.STATUS.error && stderr.trim()) {
            diagnostics.push({ commit: row.commit, stderr: stderr.trim().split('\n').slice(-20).join('\n') });
        }
        const detail = row.status === policy.STATUS.blocked
            ? ` ${row.blocked.map(item => `${item.name} (${item.kind})`).join(', ')}`
            : row.status === policy.STATUS.error ? ` ${row.error}` : '';
        process.stdout.write(`[${repo.name}] ${String(index + 1).padStart(2)}/${commits.length} ` +
            `${row.commit.slice(0, 12)} ${statusWord(row.status)}${detail} (${(wallMs / 1000).toFixed(1)}s)\n`);
    }
    // Leave the clone at the newest replayed commit, clean.
    git(clone, ['clean', '-q', '-ffdx']);

    const rowsWithRepo = rows.map(row => ({ repo: repo.name, ...row }));
    const scored = {
        repo: repo.name,
        pinned: repo.commits.length,
        replayed: rows.length,
        rows,
        summary: policy.summarizeRows(rows),
        evaluation: policy.evaluateReplay(rowsWithRepo, [repo]),
    };
    return {
        schemaVersion: SCHEMA_VERSION,
        instrument: 'check-replay',
        repo: repo.name,
        url: repo.url,
        language: repo.language,
        tip: repo.tip,
        pathspec: repo.pathspec,
        cli: context.cliLabel,
        limit: options.limit,
        generatedAt: new Date().toISOString(),
        scored,
        scoredSha256: sha256(JSON.stringify(scored)),
        timing: { fetchMs, checkMs: perCommit.reduce((sum, entry) => sum + entry.wallMs, 0), totalMs: elapsedMs(started), perCommit },
        diagnostics,
    };
}

/** Same-dated reports of the same kind, this run's last, one per repository. */
function mergedReports(reportsDir, date, suffix, current) {
    const merged = new Map();
    const pattern = new RegExp(`^check-replay-(.+)-${date}${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.json$`);
    for (const name of fs.readdirSync(reportsDir).sort(policy.codeUnitCompare)) {
        if (!pattern.test(name)) continue;
        try {
            const doc = JSON.parse(fs.readFileSync(path.join(reportsDir, name), 'utf8'));
            if (doc.instrument === 'check-replay' && doc.schemaVersion === SCHEMA_VERSION && doc.scored) merged.set(doc.repo, doc);
        } catch (_) { /* an unreadable report is not part of the rollup */ }
    }
    for (const report of current) merged.set(report.repo, report);
    return [...merged.values()].sort((a, b) => policy.codeUnitCompare(a.repo, b.repo));
}

function printSummary(reports, run) {
    const out = text => process.stdout.write(`${text}\n`);
    const header = ['repository', 'commits', 'READY', 'REVIEW', 'BLOCKED', 'NO-VERDICT', 'ERROR', 'wall', 'scored sha256'];
    const table = reports.map(report => {
        const s = report.scored.summary.statuses;
        return [report.repo, report.scored.replayed, s.READY_FOR_TOOLCHAIN, s.REVIEW_REQUIRED, s.BLOCKED,
            s['NO-VERDICT'], s.ERROR, `${(report.timing.totalMs / 1000).toFixed(1)}s`, report.scoredSha256.slice(0, 16)];
    });
    const overall = policy.summarizeRows(reports.flatMap(report => report.scored.rows));
    const o = overall.statuses;
    table.push(['all', overall.commits, o.READY_FOR_TOOLCHAIN, o.REVIEW_REQUIRED, o.BLOCKED, o['NO-VERDICT'], o.ERROR,
        `${(reports.reduce((sum, report) => sum + report.timing.totalMs, 0) / 1000).toFixed(1)}s`, '']);
    const widths = header.map((title, column) => Math.max(title.length, ...table.map(row => String(row[column]).length)));
    out('');
    for (const row of [header, ...table]) out(row.map((cell, column) => String(cell).padEnd(widths[column])).join('  ').trimEnd());
    out(`READY share: commits ${overall.shares.ready ?? '-'}; items ` +
        (Object.entries(overall.items).map(([kind, counts]) => `${kind} ${counts.ready}/${counts.total}`).join(', ') || '-'));
    const levers = overall.levers.slice(0, 8);
    if (levers.length > 0) {
        out('levers (items a reason alone holds / items holding it): ' +
            levers.map(lever => `${lever.reason} ${lever.alone}/${lever.total}`).join(', '));
    }
    const evaluation = run.evaluation;
    for (const row of evaluation.blockedFailures) {
        out(`BLOCKED on accepted history: ${row.repo} ${row.commit}`);
        for (const item of row.blocked) {
            out(`  ${item.name} (${item.kind}, ${item.file}:${item.line}) ${item.reasons.join(', ')}`);
            for (const mismatch of item.mismatches) {
                out(`    ${mismatch.file}:${mismatch.line}${mismatch.target ? ` ${mismatch.target}` : ''}` +
                    `${mismatch.expression ? ` ${mismatch.expression}` : ''} | ` +
                    `${mismatch.problem || `expected ${mismatch.expected}, got ${mismatch.actual}`}` +
                    `${mismatch.unchecked ? ' (unchecked)' : ''}`);
            }
            for (const site of item.sites) out(`    ${site.file}:${site.line}${site.kind ? ` ${site.kind}` : ''}`);
        }
    }
    for (const pin of evaluation.knownBreaks) out(`known break (pinned): ${pin.repo} ${pin.commit}: ${pin.evidence}`);
    for (const pin of evaluation.unjudgedPins) out(`known break not replayed in this run: ${pin.repo} ${pin.commit}`);
}

function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        if (!(error instanceof UsageError)) throw error;
        process.stderr.write(`${error.message}\n\n${USAGE}\n`);
        return EXIT.infrastructure;
    }
    if (options.help) {
        process.stdout.write(`${USAGE}\n`);
        return EXIT.ok;
    }
    const problems = policy.validateReplayList(REPLAY_REPOS);
    if (problems.length > 0) {
        process.stderr.write(`the pinned list is unusable:\n${problems.map(problem => `  - ${problem}`).join('\n')}\n`);
        return EXIT.infrastructure;
    }
    let repos = REPLAY_REPOS;
    if (options.repos) {
        const unknown = options.repos.filter(name => !REPLAY_REPOS.some(repo => repo.name === name));
        if (unknown.length > 0) {
            process.stderr.write(`unknown repository ${unknown.join(', ')}\n\n${USAGE}\n`);
            return EXIT.infrastructure;
        }
        repos = REPLAY_REPOS.filter(repo => options.repos.includes(repo.name));
    }

    const treeCli = fs.realpathSync(TREE_CLI);
    let cli = treeCli;
    if (options.cli) {
        const given = path.resolve(options.cli);
        if (!fs.existsSync(given) || !fs.statSync(given).isFile()) {
            process.stderr.write(`--cli ${options.cli}: no such file\n`);
            return EXIT.infrastructure;
        }
        cli = fs.realpathSync(given);
    }
    const external = cli !== treeCli;
    const cliKey = external ? `cli-${sha256(cli).slice(0, 12)}` : 'tree';
    const cacheRoot = path.resolve(options.cacheDir || DEFAULT_CACHE_DIR);
    fs.mkdirSync(cacheRoot, { recursive: true });
    const context = {
        cli,
        cliKey,
        cliLabel: external ? cli : 'tree',
        reposDir: path.join(fs.realpathSync(cacheRoot), 'repos'),
        indexDir: path.join(fs.realpathSync(cacheRoot), 'index'),
    };
    fs.mkdirSync(context.reposDir, { recursive: true });
    fs.mkdirSync(context.indexDir, { recursive: true });
    const reportsDir = path.resolve(process.env.UCN_EVAL_REPORTS_DIR || path.join(__dirname, 'reports'));
    fs.mkdirSync(reportsDir, { recursive: true });
    const suffix = `${options.limit ? `-limit${options.limit}` : ''}${external ? `-${cliKey}` : ''}`;

    process.stdout.write(`check replay: ${repos.length} repositories, ` +
        `${options.limit ? `first ${options.limit}` : 'all pinned'} commits each, CLI ${context.cliLabel}\n`);
    const reports = [];
    const infrastructure = [];
    for (const repo of repos) {
        try {
            const report = replayRepository(repo, options, context);
            const date = report.generatedAt.slice(0, 10);
            const file = path.join(reportsDir, `check-replay-${repo.name}-${date}${suffix}.json`);
            fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
            process.stdout.write(`[${repo.name}] ${report.scored.replayed} commit(s) in ` +
                `${(report.timing.totalMs / 1000).toFixed(1)}s, scored sha256 ${report.scoredSha256}\n[${repo.name}] JSON: ${file}\n`);
            reports.push(report);
        } catch (error) {
            if (!(error instanceof InfrastructureError)) throw error;
            infrastructure.push(`${repo.name}: ${error.message}`);
            process.stderr.write(`[${repo.name}] INFRASTRUCTURE FAILURE: ${error.message}\n`);
        }
    }

    const rows = reports.flatMap(report => report.scored.rows.map(row => ({ repo: report.repo, ...row })));
    const evaluation = policy.evaluateReplay(rows, repos);
    if (reports.length > 0) {
        const date = reports[0].generatedAt.slice(0, 10);
        const board = mergedReports(reportsDir, date, suffix, reports);
        const file = path.join(reportsDir, `check-replay-${date}${suffix}.md`);
        fs.writeFileSync(file, policy.formatRollup(board, { date, cli: context.cliLabel, limit: options.limit }));
        process.stdout.write(`Rollup MD: ${file}\n`);
    }
    printSummary(reports, { evaluation });

    if (infrastructure.length > 0) {
        process.stdout.write(`CHECK REPLAY: INFRASTRUCTURE FAILURE in ${infrastructure.length} repositor` +
            `${infrastructure.length === 1 ? 'y' : 'ies'}; no score\n`);
        for (const line of infrastructure) process.stdout.write(`  - ${line}\n`);
        return EXIT.infrastructure;
    }
    const s = policy.summarizeRows(rows).statuses;
    const counts = `${rows.length} commit(s): READY ${s.READY_FOR_TOOLCHAIN}, REVIEW ${s.REVIEW_REQUIRED}, ` +
        `BLOCKED ${s.BLOCKED}, NO-VERDICT ${s['NO-VERDICT']}, ERROR ${s.ERROR}`;
    if (!options.gate) {
        process.stdout.write(`CHECK REPLAY: ${counts}; ${evaluation.failures.length} gate finding(s) ` +
            '(measurement; --gate fails on them)\n');
        for (const failure of evaluation.failures) process.stdout.write(`  - ${failure}\n`);
        return EXIT.ok;
    }
    if (evaluation.failures.length > 0) {
        process.stdout.write(`CHECK REPLAY GATE: FAIL (${counts})\n`);
        for (const failure of evaluation.failures) process.stdout.write(`  - ${failure}\n`);
        return EXIT.gate;
    }
    process.stdout.write(`CHECK REPLAY GATE: PASS (${counts}; ${evaluation.knownBreaks.length} known break(s) held)\n`);
    return EXIT.ok;
}

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (error) {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = EXIT.infrastructure;
    }
}

module.exports = { parseArgs, UsageError, EXIT };
