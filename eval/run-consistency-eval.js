#!/usr/bin/env node

/**
 * Deterministic cross-command disagreement evaluation.
 *
 * External compiler/LSP oracles answer "is this semantic claim true?". This
 * gate answers the orthogonal question "do UCN's overlapping public commands
 * make the same claim for the same pinned symbol?". It runs one stable,
 * stratified symbol board and compares:
 *
 *   - target identity across find / show / source / impact / check / caller-trace;
 *   - source and direct-test projections against their standalone commands;
 *   - confirmed caller-site multisets across show / impact / check;
 *   - unverified caller-site multisets across show / impact / check;
 *   - the complete literal-name account across all four commands;
 *   - each command's reported site total against its own visible site rows.
 *
 * Every failure carries a stable handle and a minimal only-in/value witness.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');

const { ProjectIndex } = require('../core/project');
const { execute } = require('../core/execute');
const {
    CALLABLE_SYMBOL_KINDS,
    codeUnitCompare,
    formatSymbolHandle,
    isTestPath,
} = require('../core/shared');
const {
    REPOS,
    RELEASE_REPOS,
    cloneAtCommit,
    resolveTarget,
} = require('./lib/repos');
const {
    compareMultiset,
    compareStructured,
    evaluateConsistencySummary,
} = require('./consistency-gate-policy');

const argv = process.argv.slice(2);
const REPORTS_DIR = path.resolve(
    process.env.UCN_EVAL_REPORTS_DIR || path.join(__dirname, 'reports'));
const WITNESS_LIMIT = 100;

function readArg(flag) {
    const exact = argv.indexOf(flag);
    if (exact !== -1) return argv[exact + 1] ?? null;
    const prefix = `${flag}=`;
    const matched = argv.find(arg => arg.startsWith(prefix));
    return matched ? matched.slice(prefix.length) : null;
}

function positiveInteger(flag, fallback) {
    const raw = readArg(flag);
    if (!argv.includes(flag) && !argv.some(arg => arg.startsWith(`${flag}=`))) {
        return fallback;
    }
    if (raw == null) throw new Error(`${flag} requires a value`);
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${flag} must be a positive integer (got ${raw})`);
    }
    return value;
}

function normalizeRelativePath(index, file) {
    if (!file) return '';
    const value = path.isAbsolute(file) ? path.relative(index.root, file) : file;
    return String(value).split(path.sep).join('/');
}

function siteKeys(index, sites, { withReason = false, withResolution = false } = {}) {
    return (sites || []).map(site => {
        const file = normalizeRelativePath(index, site.relativePath || site.file);
        const base = `${file}:${site.line || 0}`;
        if (withReason) return `${base}:${site.reason || ''}`;
        if (withResolution) return `${base}:${site.resolution || ''}`;
        return base;
    }).sort(codeUnitCompare);
}

function accountValue(account) {
    if (!account) return null;
    return {
        symbol: account.symbol,
        groundTotal: account.groundTotal,
        fileCount: account.fileCount,
        confirmed: account.confirmed,
        unverified: account.unverified,
        nonCall: account.nonCall,
        excluded: account.excluded,
        unparsed: account.unparsed,
        unreadableFiles: account.unreadableFiles,
        beyondText: account.beyondText,
        filtered: account.filtered,
        unaccounted: account.unaccounted,
        conserved: account.conserved,
        contract: account.contract,
    };
}

function targetIdentity(result, command) {
    if (command === 'show') {
        const symbol = result.summary?.symbol || {};
        return {
            name: symbol.name,
            file: symbol.file,
            line: symbol.startLine,
        };
    }
    if (command === 'find') {
        const definition = result[0] || {};
        return {
            name: definition.name,
            file: definition.relativePath || definition.file,
            line: definition.startLine,
        };
    }
    if (command === 'source') {
        const definition = result.entries?.[0]?.match || {};
        return {
            name: definition.name,
            file: definition.relativePath || definition.file,
            line: definition.startLine,
        };
    }
    if (command === 'trace') {
        return { name: result.root, file: result.file, line: result.line };
    }
    return {
        name: result.function || result.name,
        file: result.file,
        line: result.startLine,
    };
}

function impactConfirmed(result) {
    return (result.byFile || []).flatMap(group =>
        (group.sites || []).map(site => ({ ...site, file: site.file || group.file })));
}

function checkConfirmed(result) {
    return [
        ...(result.validDetails || []),
        ...(result.mismatchDetails || []),
        ...(result.uncertainDetails || []),
    ];
}

function definitionKind(def) {
    if (def.className || def.receiver || def.isMethod || def.type !== 'function') {
        return 'member';
    }
    return 'function';
}

function consistencyBoard(index, limit) {
    const handles = new Set();
    const candidates = [];
    for (const [, definitions] of index.symbols) {
        for (const def of definitions) {
            if (!CALLABLE_SYMBOL_KINDS.has(def.type)) continue;
            const handle = formatSymbolHandle(def);
            if (!handle || handles.has(handle)) continue;
            handles.add(handle);
            const fileEntry = index.files.get(def.file);
            const sameName = (index.symbols.get(def.name) || [])
                .filter(candidate => CALLABLE_SYMBOL_KINDS.has(candidate.type)).length;
            const called = (index.getCalleeFiles(def.name)?.size || 0) > 0;
            const inTest = isTestPath(def.relativePath || '');
            candidates.push({
                def,
                handle,
                stratum: [
                    fileEntry?.language || def.language || 'unknown',
                    definitionKind(def),
                    sameName > 1 ? 'ambiguous' : 'unique',
                    called ? 'called' : 'zero',
                    inTest ? 'test' : 'production',
                ].join(':'),
            });
        }
    }

    const stable = (a, b) =>
        codeUnitCompare(a.handle, b.handle);
    const groups = new Map();
    for (const candidate of candidates.sort(stable)) {
        let group = groups.get(candidate.stratum);
        if (!group) {
            group = [];
            groups.set(candidate.stratum, group);
        }
        group.push(candidate);
    }

    // Round-robin over stable strata. This deliberately represents members,
    // same-name definitions, zero-caller answers, test code, and every indexed
    // language rather than drawing a random or hot-symbol-heavy sample.
    const queues = [...groups.entries()]
        .sort((a, b) => codeUnitCompare(a[0], b[0]))
        .map(([, rows]) => rows);
    const board = [];
    let round = 0;
    while (board.length < limit) {
        let added = false;
        for (const queue of queues) {
            if (round >= queue.length) continue;
            board.push(queue[round]);
            added = true;
            if (board.length >= limit) break;
        }
        if (!added) break;
        round++;
    }
    return { candidates: candidates.length, strata: groups.size, board };
}

function runCommands(index, handle) {
    const specs = {
        find: { name: handle, exact: true },
        show: { name: handle, sections: 'summary,callers,source,tests', all: true },
        source: { name: handle },
        impact: { name: handle },
        check: { name: handle, all: true },
        trace: { name: handle, direction: 'callers', depth: 1, all: true },
        tests: { name: handle, depth: 0, all: true },
    };
    const results = {};
    const errors = [];
    for (const [command, params] of Object.entries(specs)) {
        const response = execute(index, command, params);
        if (!response.ok) {
            errors.push({ command, error: response.error || 'unknown error' });
        } else {
            results[command] = response.result;
        }
    }
    return { results, errors };
}

function evaluateDefinition(index, row) {
    const { def, handle, stratum } = row;
    const { results, errors } = runCommands(index, handle);
    if (errors.length > 0) {
        return {
            handle,
            name: def.name,
            kind: def.type,
            stratum,
            comparisons: 0,
            errors,
            disagreements: [],
        };
    }

    const showContext = results.show.context;
    const confirmed = {
        show: siteKeys(index, showContext.callers),
        impact: siteKeys(index, impactConfirmed(results.impact)),
        check: siteKeys(index, checkConfirmed(results.check)),
    };
    const unverified = {
        show: siteKeys(index, showContext.unverifiedCallers, { withReason: true }),
        impact: siteKeys(index, results.impact.unverifiedSites, { withReason: true }),
        check: siteKeys(index, results.check.unverifiedSites, { withReason: true }),
    };
    const confirmedResolution = {
        show: siteKeys(index, showContext.callers, { withResolution: true }),
        impact: siteKeys(index, impactConfirmed(results.impact), { withResolution: true }),
    };
    const accounts = {
        show: accountValue(showContext.meta?.account),
        impact: accountValue(results.impact.account),
        check: accountValue(results.check.account),
        trace: accountValue(results.trace.account),
    };
    const expectedIdentity = {
        name: def.name,
        file: normalizeRelativePath(index, def.relativePath || def.file),
        line: def.startLine,
    };

    const disagreements = [];
    let comparisons = 0;
    const add = (value) => {
        comparisons++;
        if (value) disagreements.push(value);
    };

    for (const command of ['find', 'show', 'source', 'impact', 'check', 'trace']) {
        const identity = targetIdentity(results[command], command);
        identity.file = normalizeRelativePath(index, identity.file);
        add(compareStructured('target-identity', 'expected', expectedIdentity,
            command, identity));
    }
    add(compareStructured('find-exact-definition-count', 'expected', 1,
        'find', results.find.length));
    add(compareStructured('source-exact-definition-count', 'expected', 1,
        'source', results.source.entries?.length || 0));
    add(compareStructured('source-projection', 'show', results.show.source,
        'source', results.source));
    add(compareStructured('direct-tests-projection', 'show', results.show.tests,
        'tests', results.tests));
    add(compareMultiset('confirmed-callers', 'show', confirmed.show,
        'impact', confirmed.impact));
    add(compareMultiset('confirmed-callers', 'show', confirmed.show,
        'check', confirmed.check));
    add(compareMultiset('confirmed-caller-resolution', 'show',
        confirmedResolution.show, 'impact', confirmedResolution.impact));
    add(compareMultiset('unverified-callers', 'show', unverified.show,
        'impact', unverified.impact));
    add(compareMultiset('unverified-callers', 'show', unverified.show,
        'check', unverified.check));
    for (const command of ['impact', 'check', 'trace']) {
        add(compareStructured('caller-account', 'show', accounts.show,
            command, accounts[command]));
    }
    add(compareStructured('impact-visible-total', 'reported',
        results.impact.totalCallSites, 'rows', confirmed.impact.length));
    add(compareStructured('check-visible-total', 'reported',
        results.check.totalCalls, 'rows', confirmed.check.length));

    return {
        handle,
        name: def.name,
        kind: def.type,
        stratum,
        comparisons,
        errors: [],
        disagreements,
    };
}

function evaluateProject(projectPath, metadata = {}, sample = 40) {
    const started = performance.now();
    const index = new ProjectIndex(projectPath);
    index.build(null, { quiet: true });
    const selection = consistencyBoard(index, sample);
    const rows = selection.board.map(row => evaluateDefinition(index, row));
    const witnesses = [];
    const byCheck = {};
    let disagreements = 0;
    let commandErrors = 0;
    let comparisons = 0;
    for (const row of rows) {
        comparisons += row.comparisons;
        commandErrors += row.errors.length;
        for (const disagreement of row.disagreements) {
            disagreements++;
            byCheck[disagreement.check] = (byCheck[disagreement.check] || 0) + 1;
            if (witnesses.length < WITNESS_LIMIT) {
                witnesses.push({
                    handle: row.handle,
                    name: row.name,
                    kind: row.kind,
                    stratum: row.stratum,
                    ...disagreement,
                });
            }
        }
        for (const error of row.errors) {
            if (witnesses.length < WITNESS_LIMIT) {
                witnesses.push({
                    handle: row.handle,
                    name: row.name,
                    kind: row.kind,
                    stratum: row.stratum,
                    check: 'command-error',
                    ...error,
                });
            }
        }
    }
    const parseFailures = index.failedFiles?.size || 0;
    const summary = {
        sampledSymbols: rows.length,
        comparisons,
        disagreements,
        commandErrors,
        parseFailures,
    };
    const verdict = evaluateConsistencySummary(summary);
    return {
        project: metadata.name || path.basename(index.root),
        root: index.root,
        language: metadata.language || null,
        commit: metadata.commit || null,
        files: index.files.size,
        candidateSymbols: selection.candidates,
        strata: selection.strata,
        durationMs: Number((performance.now() - started).toFixed(3)),
        ...summary,
        byCheck,
        omittedWitnesses: Math.max(0, disagreements + commandErrors - witnesses.length),
        witnesses,
        failures: verdict.failures,
        passed: verdict.failures.length === 0,
    };
}

function formatMarkdown(report) {
    const lines = [
        `# UCN cross-command consistency - ${report.date}`,
        '',
        'Deterministic stratified stable-handle board. Zero disagreement is the release invariant.',
        '',
        '| project | files | candidates | strata | sampled | comparisons | disagreements | errors | duration | result |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|',
        ...report.results.map(result =>
            `| ${result.project} | ${result.files} | ${result.candidateSymbols} | ` +
            `${result.strata} | ${result.sampledSymbols} | ${result.comparisons} | ` +
            `${result.disagreements} | ${result.commandErrors} | ${result.durationMs}ms | ` +
            `${result.passed ? 'PASS' : `**FAIL:** ${result.failures.join('; ')}`} |`),
        '',
        `Overall: ${report.passed ? 'PASS' : 'FAIL'} — ${report.summary.sampledSymbols} symbols, ` +
            `${report.summary.comparisons} comparisons, ${report.summary.disagreements} disagreements, ` +
            `${report.summary.commandErrors} command errors.`,
    ];
    const witnesses = report.results.flatMap(result =>
        result.witnesses.map(witness => ({ project: result.project, ...witness })));
    if (witnesses.length > 0) {
        lines.push('', '## Witnesses', '');
        for (const witness of witnesses) {
            lines.push(`- \`${witness.project} :: ${witness.handle}\` — ${witness.check}: ` +
                `\`${JSON.stringify(witness)}\``);
        }
    }
    return `${lines.join('\n')}\n`;
}

function aggregate(results) {
    const summary = {
        projects: results.length,
        sampledSymbols: 0,
        comparisons: 0,
        disagreements: 0,
        commandErrors: 0,
        parseFailures: 0,
    };
    for (const result of results) {
        for (const key of [
            'sampledSymbols', 'comparisons', 'disagreements',
            'commandErrors', 'parseFailures',
        ]) summary[key] += result[key] || 0;
    }
    const verdict = evaluateConsistencySummary(summary);
    return { summary, failures: verdict.failures, passed: verdict.failures.length === 0 };
}

function workerMain() {
    const project = readArg('--worker-project');
    const resultPath = readArg('--worker-result');
    if (!project || !resultPath) {
        throw new Error('--worker-project and --worker-result are required');
    }
    const metadata = {
        name: readArg('--worker-name'),
        language: readArg('--worker-language'),
        commit: readArg('--worker-commit'),
    };
    const result = evaluateProject(project, metadata, positiveInteger('--sample', 40));
    fs.writeFileSync(resultPath, JSON.stringify(result));
}

function runPinnedRepos(repos, sample) {
    const results = [];
    const workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-consistency-workers-'));
    try {
        for (const repo of repos) {
            const clone = cloneAtCommit(repo);
            const target = resolveTarget(clone, repo);
            const resultPath = path.join(workerDir, `${repo.name}.json`);
            const child = spawnSync(process.execPath, [
                __filename,
                '--worker-project', target,
                '--worker-result', resultPath,
                '--worker-name', repo.name,
                '--worker-language', repo.language,
                '--worker-commit', repo.commit,
                '--sample', String(sample),
            ], {
                cwd: process.cwd(),
                env: process.env,
                stdio: 'inherit',
                timeout: 10 * 60 * 1000,
            });
            if (child.error || child.status !== 0 || !fs.existsSync(resultPath)) {
                const error = child.error?.message ||
                    `consistency worker exited ${child.status}`;
                results.push({
                    project: repo.name,
                    language: repo.language,
                    commit: repo.commit,
                    files: 0,
                    candidateSymbols: 0,
                    strata: 0,
                    sampledSymbols: 0,
                    comparisons: 0,
                    disagreements: 0,
                    commandErrors: 1,
                    parseFailures: 0,
                    durationMs: 0,
                    byCheck: {},
                    witnesses: [{ check: 'worker-error', error }],
                    failures: [error],
                    passed: false,
                });
                continue;
            }
            results.push(JSON.parse(fs.readFileSync(resultPath, 'utf8')));
        }
    } finally {
        fs.rmSync(workerDir, { recursive: true, force: true });
    }
    return results;
}

function main() {
    const sample = positiveInteger('--sample', 40);
    const projectArg = readArg('--project');
    const repoArg = readArg('--repo');
    const release = argv.includes('--release');
    if (projectArg && (repoArg || release)) {
        throw new Error('--project cannot be combined with --repo or --release');
    }

    let results;
    let mode;
    if (projectArg || (!repoArg && !release)) {
        const project = path.resolve(projectArg || process.cwd());
        results = [evaluateProject(project, { name: path.basename(project) }, sample)];
        mode = 'project';
    } else {
        const names = repoArg
            ? new Set(repoArg.split(',').map(value => value.trim()).filter(Boolean))
            : null;
        const base = release ? RELEASE_REPOS : REPOS;
        const repos = base.filter(repo => !names || names.has(repo.name));
        const unknown = names
            ? [...names].filter(name => !repos.some(repo => repo.name === name))
            : [];
        if (unknown.length > 0) {
            throw new Error(`Unknown repositories: ${unknown.join(', ')}`);
        }
        if (repos.length === 0) throw new Error('No repositories selected');
        results = runPinnedRepos(repos, sample);
        mode = release ? 'release' : 'pinned';
    }

    const totals = aggregate(results);
    const date = new Date().toISOString().slice(0, 10);
    const report = {
        schemaVersion: 1,
        date,
        mode,
        sampling: {
            kind: 'deterministic-stratified-round-robin',
            samplePerProject: sample,
            dimensions: ['language', 'function/member', 'unique/ambiguous',
                'called/zero', 'production/test'],
        },
        invariants: [
            'target identity: find = show = source = impact = check = caller trace',
            'show source and direct-test projections equal standalone source and tests',
            'confirmed caller multiset: show = impact = check',
            'confirmed caller resolution: show = impact',
            'unverified caller multiset and reason: show = impact = check',
            'literal-name caller account: show = impact = check = caller trace',
            'reported visible totals equal emitted site rows',
        ],
        ...totals,
        results,
    };

    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const jsonPath = path.resolve(readArg('--json') ||
        path.join(REPORTS_DIR, `consistency-eval-${date}.json`));
    const mdPath = path.resolve(readArg('--md') ||
        path.join(REPORTS_DIR, `consistency-eval-${date}.md`));
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(mdPath, formatMarkdown(report));

    process.stdout.write(`Cross-command consistency ${report.passed ? 'PASS' : 'FAIL'}: ` +
        `${report.summary.sampledSymbols} symbols, ${report.summary.comparisons} comparisons, ` +
        `${report.summary.disagreements} disagreements, ` +
        `${report.summary.commandErrors} errors.\n`);
    process.stdout.write(`  JSON: ${jsonPath}\n  MD:   ${mdPath}\n`);
    if (!report.passed) {
        for (const failure of report.failures) process.stdout.write(`  - ${failure}\n`);
    }
    if (argv.includes('--gate') || release) {
        process.exitCode = report.passed ? 0 : 1;
    }
}

if (require.main === module) {
    const entry = readArg('--worker-project') ? workerMain : main;
    try {
        entry();
    } catch (error) {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    normalizeRelativePath,
    siteKeys,
    accountValue,
    consistencyBoard,
    evaluateDefinition,
    evaluateProject,
    aggregate,
    formatMarkdown,
};
