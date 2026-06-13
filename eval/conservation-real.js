#!/usr/bin/env node

/**
 * eval/conservation-real.js - Conservation baseline on pinned real repos.
 *
 * For each pinned repo: build the index, sample symbols stratified by usage
 * count, and measure how the engine's caller answer reconciles against the
 * text-occurrence ground set (core/account.js).
 *
 * The headline baseline metric is `callNotResolvedSymbols`: symbols where the
 * ground set contains AST call lines the engine did not claim — i.e. callers
 * an agent would never see. Phase 2/3 of the tiered caller program drive
 * this to zero-or-visible.
 *
 * Usage:
 *   node eval/conservation-real.js                # all repos
 *   node eval/conservation-real.js --repo zod     # one repo
 *   node eval/conservation-real.js --sample 50    # symbols per repo (default 30)
 *
 * Clones live in os.tmpdir()/ucn-eval-repos and are reused across runs when
 * the pinned commit matches (see eval/lib/repos.js).
 *
 * NOT part of npm test — run via `npm run eval:conservation`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { ProjectIndex } = require('../core/project');
const { computeGroundSet, buildAccount } = require('../core/account');
const { NON_CALLABLE_TYPES } = require('../core/shared');
const { REPOS, cloneAtCommit, resolveTarget, seededRandom } = require('./lib/repos');

const args = process.argv.slice(2);
const repoFilter = readArgValue(args, '--repo');
const sampleSize = Number(readArgValue(args, '--sample') || 30);

const REPORTS_DIR = path.join(__dirname, 'reports');
const USAGE_BUCKETS = [
    { name: '0', test: (n) => n === 0 },
    { name: '1-5', test: (n) => n >= 1 && n <= 5 },
    { name: '6-20', test: (n) => n >= 6 && n <= 20 },
    { name: '>20', test: (n) => n > 20 },
];

function readArgValue(argv, flag) {
    const idx = argv.indexOf(flag);
    if (idx === -1) return null;
    return argv[idx + 1] || null;
}

function sampleSymbols(index, limit, rand) {
    // Callable, non-trivial names only; one entry per name.
    const candidates = [];
    for (const [name, defs] of index.symbols) {
        if (!name || name.length < 3) continue;
        if (!Array.isArray(defs) || defs.length === 0) continue;
        if (defs.every(d => NON_CALLABLE_TYPES.has(d.type))) continue;
        candidates.push(name);
    }
    candidates.sort(); // deterministic base order

    // Stratify by usage-count bucket, then round-robin sample.
    const buckets = new Map(USAGE_BUCKETS.map(b => [b.name, []]));
    for (const name of candidates) {
        const defs = index.symbols.get(name);
        // countSymbolUsages takes a symbol object ({name, file}), not a string
        const total = index.countSymbolUsages({ name, file: defs[0].file }).total;
        const bucket = USAGE_BUCKETS.find(b => b.test(total));
        if (bucket) buckets.get(bucket.name).push(name);
    }
    for (const list of buckets.values()) {
        // Fisher-Yates with seeded RNG
        for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
        }
    }
    const sampled = [];
    const perBucket = Math.ceil(limit / USAGE_BUCKETS.length);
    for (const b of USAGE_BUCKETS) {
        sampled.push(...buckets.get(b.name).slice(0, perBucket).map(name => ({ name, bucket: b.name })));
    }
    return sampled.slice(0, limit);
}

function accountForSymbol(index, name) {
    index._beginOp();
    try {
        const ctx = index.context(name);
        // Engine-composed account (Phase 2 collectAccount instrumentation).
        if (ctx && ctx.meta && ctx.meta.account) return ctx.meta.account;
        // Fallback: no definition / class-type context — manual ground account.
        const groundSet = computeGroundSet(index, name);
        const confirmedEntries = ((ctx && ctx.callers) || []).map(c => ({ file: c.file, line: c.line }));
        return buildAccount(index, name, { groundSet, confirmedEntries });
    } finally {
        index._endOp();
    }
}

function evaluateRepo(repo) {
    process.stdout.write(`\n=== ${repo.name} (${repo.language}) @ ${repo.commit.slice(0, 8)} ===\n`);
    const repoPath = cloneAtCommit(repo);
    const target = resolveTarget(repoPath, repo);

    const buildStart = Date.now();
    const index = new ProjectIndex(target);
    index.build(null, { quiet: true });
    const buildMs = Date.now() - buildStart;
    process.stdout.write(`  indexed ${index.files.size} files, ${index.symbols.size} symbols in ${buildMs}ms` +
        (index.failedFiles.size ? `, ${index.failedFiles.size} failed files` : '') + '\n');

    const rand = seededRandom(0xC0FFEE);
    const symbols = sampleSymbols(index, sampleSize, rand);

    const perSymbol = [];
    let conservedCount = 0;
    let gapSymbols = 0;
    let totalGapLines = 0;
    let beyondTextTotal = 0;
    const accountStart = Date.now();
    for (const { name, bucket } of symbols) {
        let account;
        try {
            account = accountForSymbol(index, name);
        } catch (e) {
            perSymbol.push({ name, bucket, error: e.message });
            continue;
        }
        const gap = account.callNotResolved ? account.callNotResolved.length : 0;
        if (account.conserved) conservedCount++;
        if (gap > 0) { gapSymbols++; totalGapLines += gap; }
        beyondTextTotal += account.beyondText.count;
        perSymbol.push({
            name,
            bucket,
            groundTotal: account.groundTotal,
            confirmed: account.confirmed,
            unverified: account.unverified,
            callNotResolved: gap,
            nonCall: account.nonCall,
            excluded: account.excluded.total,
            unparsedLines: account.unparsed.lines,
            beyondText: account.beyondText.count,
            unaccounted: account.unaccounted,
            conserved: account.conserved,
            gapSample: gap > 0
                ? account.callNotResolved.slice(0, 3).map(c => `${c.relativePath}:${c.line}`)
                : undefined,
        });
    }
    const accountMs = Date.now() - accountStart;

    // Tree contract check (trace/blast tiered trees): on a sub-sample, run
    // blast + trace and verify the tree-level conservation claims — the root
    // text-ground account conserves, the frontier matches the tree account's
    // unverified count, and every expanded node's callee account partitions
    // its call sites. Violations are engine bugs, gate-style.
    const treeStart = Date.now();
    let treeChecked = 0;
    let treeViolations = 0;
    const treeViolationSamples = [];
    const treeSample = symbols.slice(0, Math.min(10, symbols.length));
    for (const { name } of treeSample) {
        try {
            const b = index.blast(name, { depth: 2 });
            if (b) {
                treeChecked++;
                const problems = [];
                if (b.account && !b.account.conserved) problems.push('root-account-not-conserved');
                if (b.treeAccount.unverifiedEdges !== (b.unverifiedFrontier || []).length) {
                    problems.push(`frontier-mismatch ${b.treeAccount.unverifiedEdges} vs ${(b.unverifiedFrontier || []).length}`);
                }
                if (problems.length > 0) {
                    treeViolations++;
                    if (treeViolationSamples.length < 5) treeViolationSamples.push({ name, cmd: 'blast', problems });
                }
            }
            const t = index.trace(name, { depth: 2 });
            if (t && t.treeAccount) {
                treeChecked++;
                const cs = t.treeAccount.callSites;
                const ok = cs.total === cs.confirmed + cs.unverified + cs.external + cs.excluded + cs.filtered;
                let nodeOk = true;
                const walk = (n) => {
                    if (!n) return;
                    if (n.calleeAccount && !n.calleeAccount.conserved) nodeOk = false;
                    (n.children || []).forEach(walk);
                };
                walk(t.tree);
                if (!ok || !nodeOk) {
                    treeViolations++;
                    if (treeViolationSamples.length < 5) {
                        treeViolationSamples.push({ name, cmd: 'trace', problems: [!ok && 'rollup-arithmetic', !nodeOk && 'node-account-not-conserved'].filter(Boolean) });
                    }
                }
            }
        } catch (e) {
            treeViolations++;
            if (treeViolationSamples.length < 5) treeViolationSamples.push({ name, cmd: 'tree', problems: [e.message] });
        }
    }
    const treeMs = Date.now() - treeStart;

    const evaluated = perSymbol.filter(s => !s.error);
    const summary = {
        repo: repo.name,
        language: repo.language,
        commit: repo.commit,
        files: index.files.size,
        symbols: index.symbols.size,
        failedFiles: index.failedFiles.size,
        buildMs,
        accountMs,
        avgAccountMs: evaluated.length ? Number((accountMs / evaluated.length).toFixed(1)) : 0,
        sampled: perSymbol.length,
        errors: perSymbol.length - evaluated.length,
        conservedRate: evaluated.length ? Number((conservedCount / evaluated.length).toFixed(4)) : 0,
        // Baseline trust-failure metrics:
        callNotResolvedSymbols: gapSymbols,        // symbols with >= 1 silently-unclaimed call line
        callNotResolvedLines: totalGapLines,       // total silently-unclaimed call lines
        beyondTextClaims: beyondTextTotal,         // alias-resolved finds beyond plain-text name matches
        // Tree contract (trace/blast): conservation of tree-level claims
        treeChecked,
        treeViolations,
        treeViolationSamples,
        treeMs,
    };

    process.stdout.write(`  sampled ${summary.sampled} symbols: conserved ${(summary.conservedRate * 100).toFixed(1)}%, ` +
        `${summary.callNotResolvedSymbols} symbols with unclaimed call lines (${summary.callNotResolvedLines} lines), ` +
        `${summary.beyondTextClaims} beyond-text claims (avg ${summary.avgAccountMs}ms/account)\n`);
    process.stdout.write(`  tree contract: ${summary.treeChecked} trees checked, ${summary.treeViolations} violations` +
        (summary.treeViolations > 0 ? ` ${JSON.stringify(summary.treeViolationSamples)}` : '') +
        ` (${summary.treeMs}ms)\n`);

    return { summary, perSymbol };
}

function main() {
    const repos = repoFilter ? REPOS.filter(r => r.name === repoFilter) : REPOS;
    if (repos.length === 0) {
        console.error(`Unknown repo "${repoFilter}". Known: ${REPOS.map(r => r.name).join(', ')}`);
        process.exit(1);
    }

    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const results = [];

    for (const repo of repos) {
        try {
            const result = evaluateRepo(repo);
            results.push(result);
            const jsonPath = path.join(REPORTS_DIR, `conservation-${repo.name}-${date}.json`);
            fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
            process.stdout.write(`  wrote ${path.relative(process.cwd(), jsonPath)}\n`);
        } catch (e) {
            process.stderr.write(`  FAILED ${repo.name}: ${e.message}\n`);
            results.push({ summary: { repo: repo.name, error: e.message }, perSymbol: [] });
        }
    }

    // Roll-up markdown
    const lines = [
        `# Conservation baseline — ${date}`,
        '',
        'Symbols sampled per repo, stratified by usage count. `gap symbols` are',
        'symbols where the ground set contains AST call lines the engine did not',
        'claim — callers an agent would never see (the silent false negatives the',
        'tiered caller contract eliminates).',
        '',
        '| repo | lang | files | sampled | conserved | gap symbols | gap lines | beyond-text | tree violations | avg ms/account |',
        '|---|---|---|---|---|---|---|---|---|---|',
    ];
    for (const { summary: s } of results) {
        if (s.error) {
            lines.push(`| ${s.repo} | — | — | — | — | — | — | — | ERROR: ${s.error} |`);
            continue;
        }
        lines.push(`| ${s.repo} | ${s.language} | ${s.files} | ${s.sampled} | ${(s.conservedRate * 100).toFixed(1)}% | ${s.callNotResolvedSymbols} | ${s.callNotResolvedLines} | ${s.beyondTextClaims} | ${s.treeViolations}/${s.treeChecked} | ${s.avgAccountMs} |`);
    }
    lines.push('');
    const mdPath = path.join(REPORTS_DIR, `conservation-rollup-${date}.md`);
    fs.writeFileSync(mdPath, lines.join('\n'));
    process.stdout.write(`\nwrote ${path.relative(process.cwd(), mdPath)}\n`);
}

main();
