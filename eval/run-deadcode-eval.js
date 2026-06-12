#!/usr/bin/env node

/**
 * eval/run-deadcode-eval.js - Verify UCN's deadcode claims against an
 * external compiler/LSP oracle (the zeroTrust analog for deadcode).
 *
 * "This is dead" is the scariest claim UCN makes — it invites deletion.
 * For every symbol deadcode reports unused, ask the oracle for references.
 * Any oracle reference UCN's usage scan missed (excluding the definition
 * itself) is a FALSE-DEAD claim: a user deleting the symbol breaks the code.
 *
 * Arms:
 *   default   — `deadcode` with default options: the production claim.
 *   exported  — `deadcode --include-exported`, exported-only claims: the
 *               audit-exports claim. Within the eval universe the oracle has
 *               the same visibility as UCN, so this is a fair engine test
 *               (external npm/pkg consumers are invisible to BOTH sides).
 *
 * Verdicts per claim:
 *   agreed-dead       — oracle finds no references beyond the definition
 *   false-dead        — oracle finds ≥1 non-definition reference in a file
 *                       UCN indexed: the engine missed a usage. THE GATE
 *                       (default arm): 0.
 *   outside-universe  — oracle references exist only in files UCN does not
 *                       index (universe gap, not a usage-scan miss)
 *   unpinnable        — oracle could not resolve the symbol at the claimed
 *                       position (reported, not gated)
 *
 * Usage:
 *   node eval/run-deadcode-eval.js                  # all repos with an oracle
 *   node eval/run-deadcode-eval.js --repo zod,gson  # subset
 *   node eval/run-deadcode-eval.js --sample 60      # claims per repo per arm
 *   node eval/run-deadcode-eval.js --arm default    # default | exported | both
 *   node eval/run-deadcode-eval.js --oracle jedi    # force an oracle
 *
 * NOT part of npm test — run via `npm run eval:deadcode` or eval.yml.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { ProjectIndex } = require('../core/project');
const { execute } = require('../core/execute');
const { isTestFile } = require('../core/discovery');
const { REPOS, cloneAtCommit, resolveTarget, seededRandom } = require('./lib/repos');
const { validateOracle } = require('./oracles/oracle-interface');
const { tsMorphOracle } = require('./oracles/ts-morph-oracle');
const { pyrightOracle } = require('./oracles/pyright-oracle');
const { jediOracle } = require('./oracles/jedi-oracle');
const { goplsOracle } = require('./oracles/gopls-oracle');
const { rustAnalyzerOracle } = require('./oracles/rust-analyzer-oracle');
const { jdtlsOracle } = require('./oracles/jdtls-oracle');

const args = process.argv.slice(2);
const repoFilter = readArgValue(args, '--repo');
const repoFilterSet = repoFilter ? new Set(repoFilter.split(',').map(s => s.trim())) : null;
const sampleSize = Number(readArgValue(args, '--sample') || 60);
const armFilter = readArgValue(args, '--arm') || 'both';
const oracleFilter = readArgValue(args, '--oracle');
const REPORTS_DIR = path.join(__dirname, 'reports');

// Same precedence as run-oracle-eval.js: first language match wins.
const ORACLES = [tsMorphOracle, pyrightOracle, jediOracle, goplsOracle, rustAnalyzerOracle, jdtlsOracle]
    .map(validateOracle)
    .filter(o => !oracleFilter || o.name === oracleFilter);

function readArgValue(argv, flag) {
    const i = argv.indexOf(flag);
    return i === -1 ? null : (argv[i + 1] || null);
}

function key(file, line) { return `${file}:${line}`; }

/**
 * Resolve the symbol record behind a deadcode claim so the verdict can
 * exclude definition-position references (startLine vs nameLine — decorator/
 * annotation conventions put the name on a different line than the start).
 */
function findClaimSymbol(index, claim) {
    const syms = index.symbols.get(claim.name) || [];
    return syms.find(s => s.relativePath === claim.file && s.startLine === claim.startLine) || null;
}

/** Name variants for oracle pinning (zod's `"~validate"` keeps its quotes in UCN). */
function nameVariants(name) {
    const variants = [name];
    const stripped = name.replace(/^["']|["']$/g, '');
    if (stripped !== name) variants.push(stripped);
    return variants;
}

async function oracleRefsForClaim(oracle, handle, claim, oracleFile, symbol) {
    const lines = [claim.startLine];
    if (symbol && symbol.nameLine && symbol.nameLine !== claim.startLine) lines.push(symbol.nameLine);
    let lastErr = null;
    for (const name of nameVariants(claim.name)) {
        for (const line of lines) {
            try {
                const refs = await oracle.findReferences(handle, { name, file: oracleFile, line });
                // ts-morph returns [] when it cannot pin the declaration; a
                // pinned symbol always yields at least the definition ref.
                if (refs.length === 0 && oracle.name === 'ts-morph') { lastErr = 'ts-morph: declaration not found'; continue; }
                return { refs, pinnedName: name };
            } catch (e) {
                lastErr = e.message;
            }
        }
    }
    return { error: lastErr || 'unpinnable' };
}

async function evaluateRepo(repo, oracle) {
    process.stdout.write(`\n=== ${repo.name} (${repo.language}) @ ${repo.commit.slice(0, 8)} — oracle: ${oracle.name} ===\n`);
    const repoPath = cloneAtCommit(repo);
    const target = resolveTarget(repoPath, repo);

    const index = new ProjectIndex(target);
    index.build(null, { quiet: true });
    const indexedFiles = new Set([...index.files.values()].map(fe => fe.relativePath));
    process.stdout.write(`  UCN indexed ${indexedFiles.size} files\n`);

    // Claims, per arm. The exported arm keeps only isExported claims so the
    // two arms are disjoint (include-exported output is a superset).
    const arms = [];
    if (armFilter === 'default' || armFilter === 'both') {
        const r = execute(index, 'deadcode', {});
        if (!r.ok) throw new Error(`deadcode failed: ${r.error}`);
        arms.push({ arm: 'default', claims: [...r.result] });
    }
    if (armFilter === 'exported' || armFilter === 'both') {
        const r = execute(index, 'deadcode', { includeExported: true });
        if (!r.ok) throw new Error(`deadcode --include-exported failed: ${r.error}`);
        arms.push({ arm: 'exported', claims: r.result.filter(c => c.isExported) });
    }

    const handle = await oracle.prepare(target);
    // Oracle paths are relative to the prepared target; UCN paths are relative
    // to its detected project root (possibly a parent). Same normalization as
    // run-oracle-eval.js.
    const toUcnRel = (f) => path.relative(index.root, path.join(target, f));
    const toOracleRel = (f) => path.relative(target, path.join(index.root, f));

    const armResults = [];
    for (const { arm, claims } of arms) {
        // Seeded shuffle + cap — LSP findReferences costs real time per claim.
        const rand = seededRandom(0xDEADC0DE);
        const shuffled = [...claims];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const sampled = shuffled.slice(0, sampleSize);

        const perClaim = [];
        const totals = { claims: claims.length, verified: 0, agreedDead: 0, falseDead: 0, outsideUniverse: 0, unpinnable: 0 };

        for (const claim of sampled) {
            const symbol = findClaimSymbol(index, claim);
            const oracleFile = toOracleRel(claim.file);
            const res = await oracleRefsForClaim(oracle, handle, claim, oracleFile, symbol);
            const record = {
                name: claim.name, type: claim.type, file: claim.file,
                startLine: claim.startLine, isExported: !!claim.isExported,
            };
            if (res.error) {
                totals.unpinnable++;
                perClaim.push({ ...record, verdict: 'unpinnable', error: res.error });
                continue;
            }
            totals.verified++;

            // Definition positions to exclude: the claim's own lines, in every
            // definition of this name in the claim's file (oracles may report
            // the declaration as a reference — jdtls ignores includeDeclaration).
            const defKeys = new Set([key(claim.file, claim.startLine)]);
            if (symbol && symbol.nameLine) defKeys.add(key(claim.file, symbol.nameLine));

            const seen = new Set();
            const usageRefs = [];
            for (const ref of res.refs) {
                if (ref.kind === 'definition') continue;
                const ucnRel = toUcnRel(ref.file);
                const k = key(ucnRel, ref.line);
                if (defKeys.has(k) || seen.has(k)) continue;
                seen.add(k);
                usageRefs.push({ file: ucnRel, line: ref.line, kind: ref.kind, indexed: indexedFiles.has(ucnRel) });
            }

            if (usageRefs.length === 0) {
                totals.agreedDead++;
                perClaim.push({ ...record, verdict: 'agreed-dead' });
                continue;
            }
            const indexedRefs = usageRefs.filter(r => r.indexed);
            if (indexedRefs.length === 0) {
                totals.outsideUniverse++;
                perClaim.push({ ...record, verdict: 'outside-universe', refs: usageRefs });
                continue;
            }
            totals.falseDead++;
            const lang = index.files.get(symbol ? symbol.file : null)?.language || repo.language;
            perClaim.push({
                ...record, verdict: 'false-dead',
                refs: indexedRefs,
                testRefsOnly: indexedRefs.every(r => isTestFile(r.file, lang)),
            });
        }

        const summary = {
            arm,
            claims: totals.claims,
            sampled: sampled.length,
            verified: totals.verified,
            agreedDead: totals.agreedDead,
            falseDead: totals.falseDead,
            outsideUniverse: totals.outsideUniverse,
            unpinnable: totals.unpinnable,
            falseDeadRate: totals.verified ? Number((totals.falseDead / totals.verified).toFixed(4)) : 0,
        };
        process.stdout.write(`  [${arm}] claims ${summary.claims} | sampled ${summary.sampled} | agreed-dead ${summary.agreedDead} | ` +
            `FALSE-DEAD ${summary.falseDead} | outside-universe ${summary.outsideUniverse} | unpinnable ${summary.unpinnable}\n`);
        for (const c of perClaim.filter(c => c.verdict === 'false-dead').slice(0, 10)) {
            process.stdout.write(`      ✗ ${c.type} ${c.name} @ ${c.file}:${c.startLine} — ${c.refs.length} oracle ref(s), e.g. ${c.refs[0].file}:${c.refs[0].line} (${c.refs[0].kind})${c.testRefsOnly ? ' [tests only]' : ''}\n`);
        }
        armResults.push({ summary, perClaim });
    }

    if (oracle.dispose) {
        try { await oracle.dispose(handle); } catch (e) { /* teardown is best-effort */ }
    }

    return {
        repo: repo.name, oracle: oracle.name, commit: repo.commit,
        indexedFiles: indexedFiles.size,
        arms: armResults,
    };
}

async function main() {
    const oracleRepos = REPOS.filter(r =>
        ORACLES.some(o => o.languages.includes(r.language)) &&
        (!repoFilterSet || repoFilterSet.has(r.name)));
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
            // THE GATE: default-arm false-dead = 0. The exported arm is
            // reported (engine-quality metric) but does not gate yet.
            const defaultArm = result.arms.find(a => a.summary.arm === 'default');
            if (defaultArm && defaultArm.summary.falseDead > 0) gateFailed = true;
            const jsonPath = path.join(REPORTS_DIR, `deadcode-eval-${repo.name}-${oracle.name}-${date}.json`);
            fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
            process.stdout.write(`  wrote ${path.relative(process.cwd(), jsonPath)}\n`);
        } catch (e) {
            process.stderr.write(`  FAILED ${repo.name}: ${e.stack || e.message}\n`);
            results.push({ repo: repo.name, error: e.message, arms: [] });
            gateFailed = true;
        }
    }

    const lines = [
        `# Deadcode eval — ${date}`,
        '',
        'Every symbol UCN deadcode reports unused is checked against compiler/LSP',
        'ground truth. `false-dead` = the oracle found a reference UCN\'s usage',
        'scan missed — deleting the symbol breaks the code. Gate: default-arm',
        'false-dead = 0.',
        '',
        '| repo | oracle | arm | claims | sampled | agreed-dead | false-dead | outside-universe | unpinnable |',
        '|---|---|---|---|---|---|---|---|---|',
    ];
    for (const r of results) {
        if (r.error) { lines.push(`| ${r.repo} | — | — | — | — | — | — | — | ERROR: ${r.error} |`); continue; }
        for (const { summary: s } of r.arms) {
            lines.push(`| ${r.repo} | ${r.oracle} | ${s.arm} | ${s.claims} | ${s.sampled} | ${s.agreedDead} | **${s.falseDead}** | ${s.outsideUniverse} | ${s.unpinnable} |`);
        }
    }
    lines.push('');
    const mdPath = path.join(REPORTS_DIR, `deadcode-eval-rollup-${date}.md`);
    fs.writeFileSync(mdPath, lines.join('\n'));
    process.stdout.write(`\nwrote ${path.relative(process.cwd(), mdPath)}\n`);

    process.exit(gateFailed ? 1 : 0);
}

main();
