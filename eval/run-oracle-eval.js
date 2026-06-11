#!/usr/bin/env node

/**
 * eval/run-oracle-eval.js - Score UCN's tiered caller answers against an
 * external compiler/LSP oracle (ts-morph for TypeScript, jedi for Python).
 *
 * Metrics (per repo):
 *   tier1Precision      — |confirmed ∩ oracle-calls| / |confirmed|
 *   tierSeparation      — precision(confirmed) − precision(unverified):
 *                         proves the tier labels carry information
 *   oraclePlacement     — for every oracle call edge: confirmed / unverified /
 *                         reported-non-call / missing-explained / missing-unexplained.
 *                         RELEASE GATE: missing-unexplained = 0 (an oracle call
 *                         edge UCN neither showed nor accounted for = the
 *                         silent lie the contract forbids)
 *   zeroTrustworthiness — P(oracle finds 0 call refs | UCN shows 0 confirmed
 *                         + 0 unverified): "a UCN zero is as safe as a grep zero"
 *   conservedRate       — account invariant holds on real-repo symbols
 *
 * Usage:
 *   node eval/run-oracle-eval.js                  # all repos with a matching oracle
 *   node eval/run-oracle-eval.js --repo zod
 *   node eval/run-oracle-eval.js --sample 20      # symbols per repo (default 50)
 *
 * NOT part of npm test — run via `npm run eval:oracle` or eval.yml.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { ProjectIndex } = require('../core/project');
const { execute } = require('../core/execute');
const output = require('../core/output');
const { REPOS, cloneAtCommit, resolveTarget, seededRandom } = require('./lib/repos');
const { validateOracle } = require('./oracles/oracle-interface');
const { tsMorphOracle } = require('./oracles/ts-morph-oracle');
const { jediOracle } = require('./oracles/jedi-oracle');

const args = process.argv.slice(2);
const repoFilter = readArgValue(args, '--repo');
const sampleSize = Number(readArgValue(args, '--sample') || 50);
const REPORTS_DIR = path.join(__dirname, 'reports');

const ORACLES = [validateOracle(tsMorphOracle), validateOracle(jediOracle)];

const REF_BUCKETS = [
    { name: '0', test: (n) => n === 0 },
    { name: '1-5', test: (n) => n >= 1 && n <= 5 },
    { name: '6-20', test: (n) => n >= 6 && n <= 20 },
    { name: '>20', test: (n) => n > 20 },
];

function readArgValue(argv, flag) {
    const i = argv.indexOf(flag);
    return i === -1 ? null : (argv[i + 1] || null);
}

function key(file, line) { return `${file}:${line}`; }

const SYMBOL_KINDS = ['function', 'method', 'class'];

function emptyPlacement() {
    return { confirmed: 0, unverified: 0, reportedNonCall: 0, missingExplained: 0, missingBeyondText: 0, missingUnexplained: 0 };
}

function emptyKindTotals() {
    return {
        sampled: 0,
        confirmedEdges: 0, confirmedHits: 0,
        unverifiedEdges: 0, unverifiedHits: 0,
        oracleCallEdges: 0,
        placement: emptyPlacement(),
    };
}

async function evaluateRepo(repo, oracle) {
    process.stdout.write(`\n=== ${repo.name} (${repo.language}) @ ${repo.commit.slice(0, 8)} — oracle: ${oracle.name} ===\n`);
    const repoPath = cloneAtCommit(repo);
    const target = resolveTarget(repoPath, repo);

    const index = new ProjectIndex(target);
    index.build(null, { quiet: true });
    const indexedFiles = new Set([...index.files.values()].map(fe => fe.relativePath));
    process.stdout.write(`  UCN indexed ${indexedFiles.size} files\n`);

    const handle = await oracle.prepare(target);
    // Path-base normalization: oracle paths are relative to the prepared
    // target dir; UCN paths are relative to its detected project root (which
    // may be a parent, e.g. packages/core vs packages/core/src). Convert all
    // oracle paths to UCN-relative so the universes align.
    const toUcnRel = (f) => path.relative(index.root, path.join(target, f));
    const rawSymbols = await oracle.listSymbols(handle, {});
    const allSymbols = rawSymbols.map(s => ({ ...s, file: toUcnRel(s.file), oracleFile: s.file }));
    process.stdout.write(`  oracle lists ${allSymbols.length} symbols\n`);

    // Restrict to symbols in files BOTH sides see (file-universe normalization),
    // with usable names.
    const candidates = allSymbols.filter(s =>
        s.name && s.name.length >= 3 && indexedFiles.has(s.file));

    // Seeded shuffle, then stratify by oracle reference count.
    const rand = seededRandom(0xACE0FBA5E);
    for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const perBucket = Math.ceil(sampleSize / REF_BUCKETS.length);
    const buckets = new Map(REF_BUCKETS.map(b => [b.name, []]));
    const refCache = new Map();
    for (const sym of candidates) {
        if ([...buckets.values()].every(list => list.length >= perBucket)) break;
        let refs;
        try {
            refs = await oracle.findReferences(handle, { name: sym.name, file: sym.oracleFile, line: sym.line });
        } catch (e) { continue; }
        refs = refs.map(r => ({ ...r, file: toUcnRel(r.file) }));
        const callRefs = refs.filter(r => r.kind === 'call');
        const bucket = REF_BUCKETS.find(b => b.test(callRefs.length));
        const list = buckets.get(bucket.name);
        if (list.length >= perBucket) continue;
        refCache.set(sym, refs);
        list.push(sym);
    }
    const sampled = [...buckets.values()].flat().slice(0, sampleSize);
    process.stdout.write(`  sampled ${sampled.length} symbols (buckets: ${[...buckets].map(([n, l]) => `${n}:${l.length}`).join(' ')})\n`);

    // Score each symbol
    const perSymbol = [];
    const totals = {
        confirmedEdges: 0, confirmedHits: 0,
        unverifiedEdges: 0, unverifiedHits: 0,
        oracleCallEdges: 0,
        placement: emptyPlacement(),
        zeroCases: 0, zeroAgreed: 0,
        conserved: 0, evaluated: 0,
    };
    const byKind = new Map(SYMBOL_KINDS.map(k => [k, emptyKindTotals()]));
    const unexplainedSamples = [];

    for (const sym of sampled) {
        const oracleRefs = refCache.get(sym) || [];
        const oracleCalls = dedupe(oracleRefs.filter(r => r.kind === 'call')
            // a "call" on the declaration line is the declaration itself in some
            // ts-morph shapes — exclude self-lines
            .filter(r => !(r.file === sym.file && r.line === sym.line)));

        // UCN answer via the REAL contract surface: execute → formatContextJson.
        // Pin resolution to the oracle's exact declaration via symbol handle.
        const handleName = `${sym.file}:${sym.line}:${sym.name}`;
        const r = execute(index, 'context', { name: handleName });
        if (!r.ok) {
            perSymbol.push({ name: sym.name, file: sym.file, line: sym.line, kind: sym.kind, error: r.error });
            continue;
        }
        const json = JSON.parse(output.formatContextJson(r.result));
        // Function/method symbols expose confirmed callers as `callers`; class
        // symbols expose them as `usages` (constructor/type-usage sites, same
        // confirmed tier). Both carry tier labels.
        const confirmed = dedupe((json.data.callers || json.data.usages || []).map(c => ({ file: c.file, line: c.line })));
        const unverified = dedupe((json.data.unverifiedCallers || []).map(c => ({ file: c.file, line: c.line })));
        const account = json.meta.account;

        const confirmedKeys = new Set(confirmed.map(c => key(c.file, c.line)));
        const unverifiedKeys = new Set(unverified.map(c => key(c.file, c.line)));
        const oracleKeys = new Set(oracleCalls.map(c => key(c.file, c.line)));

        // Tier precision (against oracle call edges)
        const confirmedHits = confirmed.filter(c => oracleKeys.has(key(c.file, c.line))).length;
        const unverifiedHits = unverified.filter(c => oracleKeys.has(key(c.file, c.line))).length;

        // Oracle-edge placement.
        //   reportedNonCall      — line is in the text ground set; by the
        //                          conservation invariant it sits in an ACCOUNT
        //                          bucket (non-call/excluded/definition): visible.
        //   missingBeyondText    — line does NOT contain the symbol name (the
        //                          oracle resolved through an export-rename /
        //                          alias, e.g. `export { _gt as gt }`). Outside
        //                          the text ground set: grep would ALSO miss it.
        //                          Documented engine-improvement metric, not a
        //                          contract violation.
        //   missingUnexplained   — in the ground set, indexed, yet unaccounted:
        //                          the silent lie the contract forbids. GATE: 0.
        const placement = emptyPlacement();
        for (const oc of oracleCalls) {
            const k = key(oc.file, oc.line);
            if (confirmedKeys.has(k)) placement.confirmed++;
            else if (unverifiedKeys.has(k)) placement.unverified++;
            else if (!indexedFiles.has(oc.file)) placement.missingExplained++; // outside UCN's file universe
            else if (!lineMatchesSymbol(index.root, oc.file, oc.line, sym.name)) {
                placement.missingBeyondText++;
            } else if (account && account.conserved) {
                placement.reportedNonCall++;
            } else {
                placement.missingUnexplained++;
                if (unexplainedSamples.length < 10) {
                    unexplainedSamples.push({ symbol: sym.name, edge: k });
                }
            }
        }

        // Zero-trustworthiness
        const ucnZero = confirmed.length === 0 && unverified.length === 0;
        if (ucnZero) {
            totals.zeroCases++;
            if (oracleCalls.length === 0) totals.zeroAgreed++;
        }

        totals.confirmedEdges += confirmed.length;
        totals.confirmedHits += confirmedHits;
        totals.unverifiedEdges += unverified.length;
        totals.unverifiedHits += unverifiedHits;
        totals.oracleCallEdges += oracleCalls.length;
        for (const k of Object.keys(placement)) totals.placement[camel(k)] += placement[k];
        totals.evaluated++;
        if (account && account.conserved) totals.conserved++;

        if (!byKind.has(sym.kind)) byKind.set(sym.kind, emptyKindTotals());
        const kt = byKind.get(sym.kind);
        kt.sampled++;
        kt.confirmedEdges += confirmed.length;
        kt.confirmedHits += confirmedHits;
        kt.unverifiedEdges += unverified.length;
        kt.unverifiedHits += unverifiedHits;
        kt.oracleCallEdges += oracleCalls.length;
        for (const k of Object.keys(placement)) kt.placement[k] += placement[k];

        perSymbol.push({
            name: sym.name, file: sym.file, line: sym.line, kind: sym.kind,
            oracleCalls: oracleCalls.length,
            confirmed: confirmed.length, confirmedHits,
            unverified: unverified.length, unverifiedHits,
            placement,
            conserved: account ? account.conserved : null,
        });
    }

    const tier1Precision = rate(totals.confirmedHits, totals.confirmedEdges);
    const unverifiedPrecision = rate(totals.unverifiedHits, totals.unverifiedEdges);
    const byKindSummary = {};
    for (const [kind, kt] of byKind) {
        if (kt.sampled === 0) continue;
        const p1 = rate(kt.confirmedHits, kt.confirmedEdges);
        const pu = rate(kt.unverifiedHits, kt.unverifiedEdges);
        byKindSummary[kind] = {
            sampled: kt.sampled,
            oracleCallEdges: kt.oracleCallEdges,
            confirmedEdges: kt.confirmedEdges,
            confirmedHits: kt.confirmedHits,
            tier1Precision: p1,
            unverifiedEdges: kt.unverifiedEdges,
            unverifiedHits: kt.unverifiedHits,
            unverifiedPrecision: pu,
            tierSeparation: kt.confirmedEdges && kt.unverifiedEdges
                ? Number((p1 - pu).toFixed(4)) : null,
            oraclePlacement: kt.placement,
        };
    }
    const summary = {
        repo: repo.name,
        oracle: oracle.name,
        commit: repo.commit,
        indexedFiles: indexedFiles.size,
        sampled: sampled.length,
        evaluated: totals.evaluated,
        errors: perSymbol.filter(s => s.error).length,
        oracleCallEdges: totals.oracleCallEdges,
        tier1Precision,
        unverifiedPrecision,
        tierSeparation: totals.confirmedEdges && totals.unverifiedEdges
            ? Number((tier1Precision - unverifiedPrecision).toFixed(4)) : null,
        oraclePlacement: totals.placement,
        byKind: byKindSummary,
        // THE GATE:
        missingUnexplained: totals.placement.missingUnexplained,
        unexplainedSamples,
        zeroTrustworthiness: totals.zeroCases ? rate(totals.zeroAgreed, totals.zeroCases) : null,
        zeroCases: totals.zeroCases,
        conservedRate: rate(totals.conserved, totals.evaluated),
    };

    process.stdout.write(`  tier1Precision ${pct(summary.tier1Precision)} | unverifiedPrecision ${pct(summary.unverifiedPrecision)} | ` +
        `tierSeparation ${summary.tierSeparation ?? 'n/a'} | placement ${JSON.stringify(summary.oraclePlacement)} | ` +
        `zeroTrust ${summary.zeroTrustworthiness != null ? pct(summary.zeroTrustworthiness) : 'n/a'} (${summary.zeroCases} cases) | ` +
        `conserved ${pct(summary.conservedRate)}\n`);
    for (const [kind, k] of Object.entries(summary.byKind)) {
        process.stdout.write(`    ${kind.padEnd(8)} n=${k.sampled} | tier1 ${pct(k.tier1Precision)} (${k.confirmedHits}/${k.confirmedEdges}) | ` +
            `unverified ${pct(k.unverifiedPrecision)} (${k.unverifiedHits}/${k.unverifiedEdges}) | ` +
            `placement ${JSON.stringify(k.oraclePlacement)}\n`);
    }
    if (summary.missingUnexplained > 0) {
        process.stdout.write(`  ⚠ GATE FAILURE: ${summary.missingUnexplained} oracle call edge(s) unexplained: ${JSON.stringify(unexplainedSamples.slice(0, 3))}\n`);
    }

    return { summary, perSymbol };
}

const _lineCache = new Map();
/** Does (file, line) word-boundary match the symbol name? (= ground-set membership) */
function lineMatchesSymbol(root, relFile, line, name) {
    const abs = path.join(root, relFile);
    let lines = _lineCache.get(abs);
    if (lines === undefined) {
        try { lines = fs.readFileSync(abs, 'utf-8').split('\n'); }
        catch (e) { lines = null; }
        _lineCache.set(abs, lines);
    }
    if (!lines || line < 1 || line > lines.length) return false;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${esc}\\b`).test(lines[line - 1]);
}

function dedupe(edges) {
    const seen = new Set();
    return edges.filter(e => {
        const k = key(e.file, e.line);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

function camel(s) { return s; }
function rate(n, d) { return d ? Number((n / d).toFixed(4)) : 0; }
function pct(x) { return `${(x * 100).toFixed(1)}%`; }

async function main() {
    const oracleRepos = REPOS.filter(r =>
        ORACLES.some(o => o.languages.includes(r.language)) &&
        (!repoFilter || r.name === repoFilter));
    if (oracleRepos.length === 0) {
        console.error(`No matching repos for oracle languages${repoFilter ? ` and --repo ${repoFilter}` : ''}.`);
        process.exit(1);
    }

    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const results = [];
    let gateFailed = false;

    for (const repo of oracleRepos) {
        const oracle = ORACLES.find(o => o.languages.includes(repo.language));
        try {
            const result = await evaluateRepo(repo, oracle);
            results.push(result);
            if (result.summary.missingUnexplained > 0) gateFailed = true;
            const jsonPath = path.join(REPORTS_DIR, `oracle-eval-${repo.name}-${date}.json`);
            fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
            process.stdout.write(`  wrote ${path.relative(process.cwd(), jsonPath)}\n`);
        } catch (e) {
            process.stderr.write(`  FAILED ${repo.name}: ${e.stack || e.message}\n`);
            results.push({ summary: { repo: repo.name, error: e.message }, perSymbol: [] });
            gateFailed = true;
        }
    }

    const lines = [
        `# Oracle eval — ${date}`,
        '',
        'UCN tiered caller answers scored against compiler/LSP ground truth.',
        '`missing-unexplained` is the release gate: an oracle call edge UCN',
        'neither showed (confirmed/unverified) nor accounted for — the silent',
        'lie the grep-reliability contract forbids. Target: 0.',
        '',
        '| repo | oracle | sampled | oracle edges | tier1 precision | unverified precision | separation | missing-unexplained | zero-trust | conserved |',
        '|---|---|---|---|---|---|---|---|---|---|',
    ];
    for (const { summary: s } of results) {
        if (s.error) { lines.push(`| ${s.repo} | — | — | — | — | — | — | — | — | ERROR: ${s.error} |`); continue; }
        lines.push(`| ${s.repo} | ${s.oracle} | ${s.sampled} | ${s.oracleCallEdges} | ${pct(s.tier1Precision)} | ${pct(s.unverifiedPrecision)} | ${s.tierSeparation ?? 'n/a'} | **${s.missingUnexplained}** | ${s.zeroTrustworthiness != null ? pct(s.zeroTrustworthiness) : 'n/a'} (${s.zeroCases}) | ${pct(s.conservedRate)} |`);
    }
    lines.push('');
    lines.push('## Per-kind breakdown');
    lines.push('');
    lines.push('Same metrics split by symbol kind (function / method / class), to');
    lines.push('localize precision gaps — e.g. method-name conflation, where import');
    lines.push('evidence confirms the file but not the receiver type.');
    lines.push('');
    lines.push('| repo | kind | sampled | oracle edges | tier1 precision | unverified precision | separation | placement |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const { summary: s } of results) {
        if (s.error || !s.byKind) continue;
        for (const [kind, k] of Object.entries(s.byKind)) {
            lines.push(`| ${s.repo} | ${kind} | ${k.sampled} | ${k.oracleCallEdges} | ${pct(k.tier1Precision)} (${k.confirmedHits}/${k.confirmedEdges}) | ${pct(k.unverifiedPrecision)} (${k.unverifiedHits}/${k.unverifiedEdges}) | ${k.tierSeparation ?? 'n/a'} | ${JSON.stringify(k.oraclePlacement)} |`);
        }
    }
    lines.push('');
    const mdPath = path.join(REPORTS_DIR, `oracle-eval-rollup-${date}.md`);
    fs.writeFileSync(mdPath, lines.join('\n'));
    process.stdout.write(`\nwrote ${path.relative(process.cwd(), mdPath)}\n`);

    process.exit(gateFailed ? 1 : 0);
}

main();
