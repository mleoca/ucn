#!/usr/bin/env node

/**
 * eval/run-oracle-eval.js - Score UCN's tiered caller answers against an
 * external compiler/LSP oracle (ts-morph for TypeScript, jedi for Python).
 *
 * Metrics (per repo):
 *   tier1Precision      — |confirmed ∩ oracle-calls| / |confirmed|
 *   tierSeparation      — precision(confirmed) − precision(unverified):
 *                         proves the tier labels carry information
 *   semanticRecall      — oracle call edges shown in confirmed/unverified.
 *                         RELEASE GATE: 100% for indexed/in-scope edges.
 *                         A call hidden in non-call counts, beyond the literal-
 *                         name ground set, or merely conserved in an excluded
 *                         bucket is a semantic miss even when accounting is sound.
 *   observedZeroAgreement — P(oracle finds 0 call refs | UCN shows 0 confirmed
 *                           + 0 unverified). This measures the sample only; it
 *                           never turns a text-zero into deletion proof.
 *   conservedRate       — account invariant holds on real-repo symbols
 *
 * Usage:
 *   node eval/run-oracle-eval.js                  # all repos with a matching oracle
 *   node eval/run-oracle-eval.js --repo zod       # one repo (or comma-separated list)
 *   node eval/run-oracle-eval.js --sample 20      # symbols per repo (default 50)
 *   node eval/run-oracle-eval.js --oracle jedi    # force an oracle (default: first match;
 *                                                 # python = pyright, jedi second opinion)
 *   node eval/run-oracle-eval.js --min-precision 0.98   # ALSO gate on tier-1 precision
 *                                                 # (PR gate: catch regressions, not just
 *                                                 # contract violations)
 *   node eval/run-oracle-eval.js --fresh 2        # fresh-repo arm: 2 UNPINNED repos from
 *                                                 # the weekly rotation (generalization
 *                                                 # guard — repos the engine was never
 *                                                 # tuned on; HEAD SHA recorded in report)
 *
 * NOT part of npm test — run via `npm run eval:oracle` or eval.yml.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { ProjectIndex } = require('../core/project');
const { getCachedCalls } = require('../core/callers');
const { execute } = require('../core/execute');
const output = require('../core/output');
const {
    createCommandProofSummary,
    evaluateSymbolCommandProof,
    finalizeCommandProof,
} = require('./command-proof');
const { REPOS, cloneAtCommit, resolveTarget, seededRandom, resolveFreshCommit, selectFreshRepos } = require('./lib/repos');
const { validateOracle } = require('./oracles/oracle-interface');
const { tsMorphOracle } = require('./oracles/ts-morph-oracle');
const { pyrightOracle } = require('./oracles/pyright-oracle');
const { jediOracle } = require('./oracles/jedi-oracle');
const { goplsOracle } = require('./oracles/gopls-oracle');
const { rustAnalyzerOracle } = require('./oracles/rust-analyzer-oracle');
const { jdtlsOracle } = require('./oracles/jdtls-oracle');

const args = process.argv.slice(2);
const repoFilter = readArgValue(args, '--repo'); // name, or comma-separated names
const repoFilterSet = repoFilter ? new Set(repoFilter.split(',').map(s => s.trim())) : null;
const sampleSize = Number(readArgValue(args, '--sample') || 50);
const oracleFilter = readArgValue(args, '--oracle');
const minPrecision = readArgValue(args, '--min-precision') ? Number(readArgValue(args, '--min-precision')) : null;
// Statistical-hardening runs: a different seed draws a different stratified
// sample, confirming the board numbers aren't sample artifacts. Non-default
// seeds get their own report filenames so they never clobber the canonical
// dated rollup.
const DEFAULT_SEED = 0xACE0FBA5E;
const sampleSeed = readArgValue(args, '--seed') ? Number(readArgValue(args, '--seed')) : DEFAULT_SEED;
// Fresh-repo arm (--fresh [N], default 2): rotate through UNPINNED repos the
// engine was never tuned on — the generalization guard. Fresh runs get their
// own report filenames so they never clobber the canonical dated rollup.
const freshCount = args.includes('--fresh') ? (Number(readArgValue(args, '--fresh')) || 2) : 0;
const freshSuffix = freshCount ? '-fresh' : '';
const seedSuffix = (sampleSeed === DEFAULT_SEED ? '' : `-seed${sampleSeed.toString(16)}`) + freshSuffix;
const REPORTS_DIR = path.join(__dirname, 'reports');

// Order matters: per repo the FIRST language match wins — pyright (stronger
// inference) is the primary Python oracle, jedi stays as the second opinion
// via --oracle jedi.
const ORACLES = [tsMorphOracle, pyrightOracle, jediOracle, goplsOracle, rustAnalyzerOracle, jdtlsOracle]
    .map(validateOracle)
    .filter(o => !oracleFilter || o.name === oracleFilter);

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
    return { confirmed: 0, unverified: 0, accountedNotShown: 0, missingExplained: 0, missingBeyondText: 0, missingUnexplained: 0 };
}

// Callee-arm placement (trace-down contract): every oracle call edge X←D,
// re-read from D's side — UCN's findCallees(D) answer must show it (confirmed
// edge site / unverified entry site) or account for it (conserved bucket).
// moduleLevel = call site outside any function — findCallees' universe is
// function scopes by design (trace can never reach it).
function emptyCalleePlacement() {
    return { confirmed: 0, oracleBroadReference: 0, confirmedOtherDef: 0,
        unverified: 0, unverifiedWithOtherDef: 0, accounted: 0,
        moduleLevel: 0, missingExplained: 0, missingBeyondText: 0, missingUnexplained: 0 };
}

function emptyKindTotals() {
    return {
        sampled: 0,
        confirmedEdges: 0, confirmedHits: 0, confirmedUnscored: 0,
        unverifiedEdges: 0, unverifiedHits: 0, unverifiedUnscored: 0,
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
    const toOracleRel = (f) => path.relative(target, path.join(index.root, f));
    const rawSymbols = await oracle.listSymbols(handle, {});
    const allSymbols = rawSymbols.map(s => ({ ...s, file: toUcnRel(s.file), oracleFile: s.file }));
    process.stdout.write(`  oracle lists ${allSymbols.length} symbols\n`);

    // Restrict to symbols in files BOTH sides see (file-universe normalization),
    // with usable names.
    const candidates = allSymbols.filter(s =>
        s.name && s.name.length >= 3 && indexedFiles.has(s.file));

    // Seeded shuffle, then stratify by oracle reference count.
    const rand = seededRandom(sampleSeed);
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
        confirmedEdges: 0, confirmedHits: 0, confirmedUnscored: 0,
        unverifiedEdges: 0, unverifiedHits: 0, unverifiedUnscored: 0,
        oracleCallEdges: 0,
        placement: emptyPlacement(),
        zeroCases: 0, zeroAgreed: 0,
        conserved: 0, evaluated: 0,
    };
    const byKind = new Map(SYMBOL_KINDS.map(k => [k, emptyKindTotals()]));
    const confirmedFalsePositiveSamples = [];
    const unexplainedSamples = [];
    const semanticMissingSamples = [];
    const calleeAnswerCache = new Map();
    const calleeFalsePositiveSamples = [];
    const calleeUnexplainedSamples = [];
    const calleeSemanticMissingSamples = [];
    const calleeTotals = { sites: 0, hits: 0, placement: emptyCalleePlacement() };
    const commandProof = createCommandProofSummary();
    const definitionCache = new Map();
    let definitionValidatedConfirmed = 0;
    let definitionValidatedUnverified = 0;
    let definitionValidatedOracleCalls = 0;
    let oracleBroadReferenceEdges = 0;
    let definitionUnresolvedReferenceEdges = 0;
    let definitionLookupErrors = 0;
    let configurationGatedUnscored = 0;
    let sourceStatusErrors = 0;
    let calleeUnscoredSites = 0;
    const sourceStatusCache = new Map();

    const isConfigurationGated = async (file, line) => {
        if (typeof oracle.isConfigurationGated !== 'function') return false;
        const cacheKey = `${file}:${line}`;
        if (sourceStatusCache.has(cacheKey)) return sourceStatusCache.get(cacheKey);
        let gated = false;
        try {
            gated = await oracle.isConfigurationGated(handle, {
                file: toOracleRel(file), line,
            });
        } catch {
            sourceStatusErrors++;
        }
        sourceStatusCache.set(cacheKey, !!gated);
        return !!gated;
    };

    const resolvedDefinitions = async (file, line, name) => {
        if (typeof oracle.resolveDefinition !== 'function') return [];
        const cacheKey = `${file}:${line}:${name}`;
        if (definitionCache.has(cacheKey)) return definitionCache.get(cacheKey);
        let defs = [];
        try {
            defs = await oracle.resolveDefinition(handle, {
                file: toOracleRel(file), line, name,
            });
            defs = (defs || []).map(d => ({ ...d, file: toUcnRel(d.file) }));
        } catch {
            // Definition lookup is secondary to reference search, but an LSP
            // failure must remain visible so a trust report cannot silently
            // present a partially adjudicated result as exact.
            definitionLookupErrors++;
        }
        definitionCache.set(cacheKey, defs);
        return defs;
    };
    const resolvesTo = async (file, line, name, targetDef) => {
        if (!targetDef) return false;
        const defs = await resolvedDefinitions(file, line, name);
        return defs.some(d => d.file === targetDef.relativePath &&
            d.line >= targetDef.startLine && d.line <= targetDef.endLine);
    };
    const definitionStatus = async (file, line, name, targetDef) => {
        if (!targetDef || typeof oracle.resolveDefinition !== 'function') return 'unavailable';
        const defs = await resolvedDefinitions(file, line, name);
        if (defs.length === 0) return 'unresolved';
        return defs.some(d => d.file === targetDef.relativePath &&
            d.line >= targetDef.startLine && d.line <= targetDef.endLine)
            ? 'target' : 'other';
    };

    for (const sym of sampled) {
        const oracleRefs = refCache.get(sym) || [];
        const rawOracleCalls = dedupe(oracleRefs.filter(r => r.kind === 'call')
            // a "call" on the declaration line is the declaration itself in some
            // ts-morph shapes — exclude self-lines
            .filter(r => !(r.file === sym.file && r.line === sym.line)));

        const sameNameDefs = index.symbols.get(sym.name) || [];
        const targetDef = sameNameDefs.find(d =>
            d.relativePath === sym.file &&
            (d.startLine === sym.line || d.nameLine === sym.line));
        // Reference search in some LSPs expands virtual method families. For a
        // repeated project symbol name, exact definition lookup is therefore
        // the authority: an edge statically bound to another definition must
        // not inflate either this target's recall or its apparent precision.
        const needsDefinitionAdjudication = sameNameDefs.length > 1 &&
            typeof oracle.resolveDefinition === 'function';
        const oracleCalls = [];
        for (const oc of rawOracleCalls) {
            if (!needsDefinitionAdjudication) {
                oracleCalls.push(oc);
                continue;
            }
            const status = await definitionStatus(oc.file, oc.line, sym.name, targetDef);
            if (status === 'other') {
                oracleBroadReferenceEdges++;
            } else {
                oracleCalls.push(oc);
                if (status === 'target') definitionValidatedOracleCalls++;
                else definitionUnresolvedReferenceEdges++;
            }
        }

        const perCommandProof = await evaluateSymbolCommandProof({
            summary: commandProof,
            index,
            sym,
            targetDef,
            sameNameDefs,
            oracleRefs,
            oracleCalls,
            indexedFiles,
            adjudicateExample: async best => {
                const candidateFile = best.relativePath || best.file;
                const relFile = path.isAbsolute(candidateFile)
                    ? path.relative(index.root, candidateFile) : candidateFile;
                const status = await definitionStatus(relFile, best.line, sym.name, targetDef);
                if (status === 'target') return 'hit';
                if (await isConfigurationGated(relFile, best.line)) return 'unscored';
                return 'miss';
            },
        });

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
        // usageStyle: bound (bind/call/apply indirection) and function-reference
        // (callback/method-value) edges establish the call relationship without
        // direct call syntax — reference oracles classify those sites as
        // reference-kind, so they verify against ANY oracle ref (family B
        // decision 2026-06-12; the #218f class-kind precedent).
        const confirmed = dedupe((json.data.callers || json.data.usages || []).map(c => ({
            file: c.file, line: c.line,
            usageStyle: c.calledAs === 'bound' || !!c.functionReference,
        })));
        const unverified = dedupe((json.data.unverifiedCallers || []).map(c => ({
            file: c.file, line: c.line,
            usageStyle: c.calledAs === 'bound' || !!c.functionReference,
        })));
        const account = json.meta.account;

        const confirmedKeys = new Set(confirmed.map(c => key(c.file, c.line)));
        const unverifiedKeys = new Set(unverified.map(c => key(c.file, c.line)));
        const oracleKeys = new Set(oracleCalls.map(c => key(c.file, c.line)));

        // Tier precision. Function/method answers are CALL edges — verified
        // against oracle call refs. Class answers are USAGES by contract
        // (constructions AND type usages: `raise X(...)` is a call ref, but
        // `pytest.raises(X)` / `isinstance(v, X)` are reference-kind — equally
        // real usages, rich-measured 11 of 12 class-kind "FPs"), so any oracle
        // ref at the line verifies a class usage. Placement/recall stays over
        // call edges for all kinds.
        const anyRefKeys = new Set(oracleRefs
            .filter(r => !(r.file === sym.file && r.line === sym.line))
            .map(r => key(r.file, r.line)));
        const hitKeys = sym.kind === 'class' ? anyRefKeys : oracleKeys;
        // usage-style edges (calledAs:'bound', functionReference) verify against
        // any oracle ref at the line — see the mapping comment above.
        // Super-constructor sites (fix #268, jsoup-measured): `super(data)`
        // in a direct subclass invokes the pinned class's constructor —
        // compiler-true by the extends clause the parser resolved (#238
        // emits the record naming the extends target) — but the line holds
        // no type name, so reference oracles have NOTHING there (jdtls
        // attributes super() to the constructor declaration, which the
        // symbol universe excludes). Verified by construction.
        const superCtorSite = c => sym.kind === 'class' &&
            lineMatchesText(index.root, c.file, c.line, /(^|[^.\w])super\s*\(/);
        const edgeHitWithoutDefinition = c => hitKeys.has(key(c.file, c.line)) ||
            (c.usageStyle && anyRefKeys.has(key(c.file, c.line))) ||
            superCtorSite(c);
        const edgeMatchesTarget = async c => {
            if (superCtorSite(c)) return { hit: true, scorable: true, definitionValidated: false };
            if (needsDefinitionAdjudication) {
                const status = await definitionStatus(c.file, c.line, sym.name, targetDef);
                if (status === 'target') return { hit: true, scorable: true, definitionValidated: true };
                const referenceHit = edgeHitWithoutDefinition(c);
                if (status === 'other' && !referenceHit && await isConfigurationGated(c.file, c.line)) {
                    return { hit: false, scorable: false, definitionValidated: true };
                }
                if (status === 'other') return { hit: false, scorable: true, definitionValidated: true };
                if (referenceHit) return { hit: true, scorable: true, definitionValidated: false };
                if (await isConfigurationGated(c.file, c.line)) {
                    return { hit: false, scorable: false, definitionValidated: false };
                }
                return { hit: false, scorable: true, definitionValidated: false };
            }
            if (edgeHitWithoutDefinition(c)) return { hit: true, scorable: true, definitionValidated: false };
            const definitionHit = await resolvesTo(c.file, c.line, sym.name, targetDef);
            if (definitionHit) return { hit: true, scorable: true, definitionValidated: true };
            if (await isConfigurationGated(c.file, c.line)) {
                return { hit: false, scorable: false, definitionValidated: false };
            }
            return { hit: false, scorable: true, definitionValidated: false };
        };
        const confirmedVerdicts = [];
        for (const c of confirmed) {
            const verdict = await edgeMatchesTarget(c);
            confirmedVerdicts.push(verdict);
            if (verdict.hit && verdict.definitionValidated) definitionValidatedConfirmed++;
            if (!verdict.scorable) configurationGatedUnscored++;
        }
        const confirmedHits = confirmedVerdicts.filter(v => v.hit).length;
        const confirmedUnscored = confirmedVerdicts.filter(v => !v.scorable).length;
        let unverifiedHits = 0, unverifiedUnscored = 0;
        for (const c of unverified) {
            const verdict = await edgeMatchesTarget(c);
            if (!verdict.scorable) {
                unverifiedUnscored++;
                configurationGatedUnscored++;
                continue;
            }
            if (verdict.hit) {
                unverifiedHits++;
                if (verdict.definitionValidated) definitionValidatedUnverified++;
            }
        }
        for (let ci = 0; ci < confirmed.length; ci++) {
            const c = confirmed[ci];
            if (confirmedVerdicts[ci].hit || !confirmedVerdicts[ci].scorable) continue;
            pushSample(confirmedFalsePositiveSamples, {
                symbol: sym.name, target: `${sym.file}:${sym.line}`,
                edge: key(c.file, c.line), text: lineText(index.root, c.file, c.line),
            });
        }

        // Oracle-edge placement.
        //   accountedNotShown    — line is in the text ground set but only in
        //                          an excluded/non-call count. Accounting remains
        //                          sound, but the semantic caller answer missed it.
        //   missingBeyondText    — line does NOT contain the symbol name (the
        //                          oracle resolved through an export-rename /
        //                          alias, e.g. `export { _gt as gt }`). Outside
        //                          the text ground set: a plain-text name scan would ALSO miss it.
        //                          Still a semantic-recall miss: AST intelligence
        //                          must add value beyond literal-name grep.
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
                pushSample(semanticMissingSamples, {
                    category: 'missingBeyondText', symbol: sym.name, target: `${sym.file}:${sym.line}`,
                    edge: k, text: lineText(index.root, oc.file, oc.line),
                });
            } else if (account && account.conserved) {
                placement.accountedNotShown++;
                pushSample(semanticMissingSamples, {
                    category: 'accountedNotShown', symbol: sym.name, target: `${sym.file}:${sym.line}`,
                    edge: k, text: lineText(index.root, oc.file, oc.line),
                });
            } else {
                placement.missingUnexplained++;
                pushSample(semanticMissingSamples, {
                    category: 'missingUnexplained', symbol: sym.name, target: `${sym.file}:${sym.line}`,
                    edge: k, text: lineText(index.root, oc.file, oc.line),
                });
                if (unexplainedSamples.length < 10) {
                    unexplainedSamples.push({ symbol: sym.name, edge: k });
                }
            }
        }

        // ── Callee arm (trace-down contract) ──────────────────────────
        // The same oracle edges, verified from the CALLER's side: for each
        // oracle call ref of X, the enclosing function D's callee answer
        // (findCallees collectAccount — the trace-down engine path) must
        // show or account for the site. Precision: every confirmed callee
        // site D→X is checked against the oracle refs (function-reference
        // sites verify against any-kind refs — the #221 usage-style rule;
        // class-kind constructor edges likewise per #218f).
        const calleePlacement = emptyCalleePlacement();
        let calleeSites = 0, calleeHits = 0;
        {
            const seenPrecisionDefs = new Set();
            for (const oc of oracleCalls) {
                if (!indexedFiles.has(oc.file)) { calleePlacement.missingExplained++; continue; }
                const absFile = path.join(index.root, oc.file);
                const encl = index.findEnclosingFunction(absFile, oc.line, true);
                if (!encl) { calleePlacement.moduleLevel++; continue; }
                const dKey = `${absFile}:${encl.startLine}`;
                let ucnCallees = calleeAnswerCache.get(dKey);
                if (!ucnCallees) {
                    ucnCallees = index.findCallees({ ...encl, file: absFile }, {
                        includeMethods: true, collectAccount: true,
                    });
                    calleeAnswerCache.set(dKey, ucnCallees);
                }
                // Precision over D's confirmed edges pinned to THIS symbol —
                // once per (symbol, D) pair.
                if (!seenPrecisionDefs.has(dKey)) {
                    seenPrecisionDefs.add(dKey);
                    for (const e of ucnCallees) {
                        if (e.name !== sym.name || e.relativePath !== sym.file || e.startLine !== sym.line) continue;
                        for (const siteLine of e.sites || []) {
                            const verdict = await edgeMatchesTarget({
                                file: oc.file,
                                line: siteLine,
                                usageStyle: !!e.functionReference,
                            });
                            if (!verdict.scorable) {
                                calleeUnscoredSites++;
                                continue;
                            }
                            calleeSites++;
                            const k = key(oc.file, siteLine);
                            if (verdict.hit) {
                                calleeHits++;
                            } else {
                                pushSample(calleeFalsePositiveSamples, {
                                    symbol: sym.name, target: `${sym.file}:${sym.line}`,
                                    edge: k, enclosing: encl.name,
                                    text: lineText(index.root, oc.file, siteLine),
                                });
                            }
                        }
                    }
                }
                // Placement of this oracle edge in D's answer
                const exactEdge = ucnCallees.find(e =>
                    e.name === sym.name && e.sites && e.sites.includes(oc.line) &&
                    e.relativePath === sym.file && e.startLine === sym.line);
                if (exactEdge) { calleePlacement.confirmed++; continue; }
                const unvEntry = (ucnCallees.unverifiedCallees || []).find(u =>
                    u.name === sym.name && u.sites && u.sites.includes(oc.line));
                const otherDefEdge = ucnCallees.find(e =>
                    e.name === sym.name && e.sites && e.sites.includes(oc.line));
                // Several calls with the same spelling can occupy one source
                // line (`.arg(arg!(...))`). The evaluator is line-granular,
                // so a visible unverified target edge takes recall precedence
                // over a different confirmed same-name occurrence. Preserve
                // the collision as its own auditable bucket.
                if (unvEntry) {
                    if (otherDefEdge) calleePlacement.unverifiedWithOtherDef++;
                    else calleePlacement.unverified++;
                    continue;
                }
                if (otherDefEdge) {
                    // JDT reference search expands virtual method families.
                    // When definition lookup says this line statically binds
                    // the exact other edge UCN selected, the oracle target is
                    // a broad-family reference—not an exact-target miss.
                    if (await resolvesTo(oc.file, oc.line, sym.name, otherDefEdge)) {
                        calleePlacement.oracleBroadReference++;
                        continue;
                    }
                    calleePlacement.confirmedOtherDef++;
                    pushSample(calleeSemanticMissingSamples, {
                        category: 'confirmedOtherDef', symbol: sym.name, target: `${sym.file}:${sym.line}`,
                        edge: key(oc.file, oc.line), enclosing: encl.name,
                        selected: `${otherDefEdge.relativePath}:${otherDefEdge.startLine}`,
                        text: lineText(index.root, oc.file, oc.line),
                    });
                    continue;
                }
                if (!lineMatchesSymbol(index.root, oc.file, oc.line, sym.name)) {
                    calleePlacement.missingBeyondText++;
                    pushSample(calleeSemanticMissingSamples, {
                        category: 'missingBeyondText', symbol: sym.name, target: `${sym.file}:${sym.line}`,
                        edge: key(oc.file, oc.line), enclosing: encl.name,
                        text: lineText(index.root, oc.file, oc.line),
                    });
                    continue;
                }
                // Conserved account + a call record at the line ⇒ the site is
                // claimed by SOME bucket (external/excluded/filtered) — visible
                // in the callee account, not a silent gap.
                const acct = ucnCallees.calleeAccount;
                const records = getCachedCalls(index, absFile) || [];
                const hasRecord = records.some(c => c.line === oc.line &&
                    c.line >= encl.startLine && c.line <= encl.endLine);
                if (acct && acct.conserved && hasRecord) {
                    calleePlacement.accounted++;
                    pushSample(calleeSemanticMissingSamples, {
                        category: 'accounted', symbol: sym.name, target: `${sym.file}:${sym.line}`,
                        edge: key(oc.file, oc.line), enclosing: encl.name,
                        text: lineText(index.root, oc.file, oc.line),
                    });
                } else {
                    calleePlacement.missingUnexplained++;
                    pushSample(calleeSemanticMissingSamples, {
                        category: 'missingUnexplained', symbol: sym.name, target: `${sym.file}:${sym.line}`,
                        edge: key(oc.file, oc.line), enclosing: encl.name,
                        text: lineText(index.root, oc.file, oc.line),
                    });
                    if (calleeUnexplainedSamples.length < 10) {
                        calleeUnexplainedSamples.push({ symbol: sym.name, edge: key(oc.file, oc.line), enclosing: encl.name });
                    }
                }
            }
        }

        // Zero-trustworthiness
        const ucnZero = confirmed.length === 0 && unverified.length === 0;
        if (ucnZero) {
            totals.zeroCases++;
            if (oracleCalls.length === 0) totals.zeroAgreed++;
        }

        calleeTotals.sites += calleeSites;
        calleeTotals.hits += calleeHits;
        for (const k of Object.keys(calleePlacement)) calleeTotals.placement[k] += calleePlacement[k];

        totals.confirmedEdges += confirmed.length;
        totals.confirmedHits += confirmedHits;
        totals.confirmedUnscored += confirmedUnscored;
        totals.unverifiedEdges += unverified.length;
        totals.unverifiedHits += unverifiedHits;
        totals.unverifiedUnscored += unverifiedUnscored;
        totals.oracleCallEdges += oracleCalls.length;
        for (const k of Object.keys(placement)) totals.placement[camel(k)] += placement[k];
        totals.evaluated++;
        if (account && account.conserved) totals.conserved++;

        if (!byKind.has(sym.kind)) byKind.set(sym.kind, emptyKindTotals());
        const kt = byKind.get(sym.kind);
        kt.sampled++;
        kt.confirmedEdges += confirmed.length;
        kt.confirmedHits += confirmedHits;
        kt.confirmedUnscored += confirmedUnscored;
        kt.unverifiedEdges += unverified.length;
        kt.unverifiedHits += unverifiedHits;
        kt.unverifiedUnscored += unverifiedUnscored;
        kt.oracleCallEdges += oracleCalls.length;
        for (const k of Object.keys(placement)) kt.placement[k] += placement[k];

        perSymbol.push({
            name: sym.name, file: sym.file, line: sym.line, kind: sym.kind,
            oracleCalls: oracleCalls.length,
            confirmed: confirmed.length, confirmedHits, confirmedUnscored,
            unverified: unverified.length, unverifiedHits, unverifiedUnscored,
            placement,
            calleePlacement,
            calleeSites, calleeHits,
            conserved: account ? account.conserved : null,
            commandProof: perCommandProof,
        });
    }

    finalizeCommandProof(commandProof);

    const tier1ScoredEdges = totals.confirmedEdges - totals.confirmedUnscored;
    const unverifiedScoredEdges = totals.unverifiedEdges - totals.unverifiedUnscored;
    const tier1Precision = rate(totals.confirmedHits, tier1ScoredEdges);
    const unverifiedPrecision = rate(totals.unverifiedHits, unverifiedScoredEdges);
    const semanticMissing = totals.placement.accountedNotShown +
        totals.placement.missingBeyondText + totals.placement.missingUnexplained;
    const semanticEligible = Math.max(0, totals.oracleCallEdges - totals.placement.missingExplained);
    const semanticRecall = semanticEligible > 0 ? rate(semanticEligible - semanticMissing, semanticEligible) : 1;
    const calleeSemanticMissing = calleeTotals.placement.confirmedOtherDef +
        calleeTotals.placement.accounted + calleeTotals.placement.missingBeyondText +
        calleeTotals.placement.missingUnexplained;
    const calleePlacementTotal = Object.values(calleeTotals.placement).reduce((a, b) => a + b, 0);
    const calleeSemanticEligible = Math.max(0, calleePlacementTotal -
        calleeTotals.placement.moduleLevel - calleeTotals.placement.missingExplained);
    const calleeSemanticRecall = calleeSemanticEligible > 0
        ? rate(calleeSemanticEligible - calleeSemanticMissing, calleeSemanticEligible) : 1;
    const byKindSummary = {};
    for (const [kind, kt] of byKind) {
        if (kt.sampled === 0) continue;
        const confirmedScored = kt.confirmedEdges - kt.confirmedUnscored;
        const unverifiedScored = kt.unverifiedEdges - kt.unverifiedUnscored;
        const p1 = rate(kt.confirmedHits, confirmedScored);
        const pu = rate(kt.unverifiedHits, unverifiedScored);
        byKindSummary[kind] = {
            sampled: kt.sampled,
            oracleCallEdges: kt.oracleCallEdges,
            confirmedEdges: kt.confirmedEdges,
            confirmedHits: kt.confirmedHits,
            confirmedUnscored: kt.confirmedUnscored,
            confirmedScored,
            tier1Precision: p1,
            unverifiedEdges: kt.unverifiedEdges,
            unverifiedHits: kt.unverifiedHits,
            unverifiedUnscored: kt.unverifiedUnscored,
            unverifiedScored,
            unverifiedPrecision: pu,
            tierSeparation: confirmedScored && unverifiedScored
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
        confirmedEdges: totals.confirmedEdges,
        confirmedScoredEdges: tier1ScoredEdges,
        confirmedUnscored: totals.confirmedUnscored,
        confirmedHits: totals.confirmedHits,
        tier1Precision,
        confirmedFalsePositiveSamples,
        unverifiedPrecision,
        unverifiedEdges: totals.unverifiedEdges,
        unverifiedScoredEdges,
        unverifiedUnscored: totals.unverifiedUnscored,
        unverifiedHits: totals.unverifiedHits,
        tierSeparation: tier1ScoredEdges && unverifiedScoredEdges
            ? Number((tier1Precision - unverifiedPrecision).toFixed(4)) : null,
        oraclePlacement: totals.placement,
        byKind: byKindSummary,
        // Strict semantic-recall gate. Conservation alone is necessary but
        // insufficient: a compiler-true edge must be shown to the agent.
        semanticRecall,
        semanticMissing,
        missingUnexplained: totals.placement.missingUnexplained,
        unexplainedSamples,
        semanticMissingSamples,
        observedZeroAgreement: totals.zeroCases ? rate(totals.zeroAgreed, totals.zeroCases) : null,
        zeroCases: totals.zeroCases,
        conservedRate: rate(totals.conserved, totals.evaluated),
        // Callee arm (trace-down contract)
        calleePrecision: rate(calleeTotals.hits, calleeTotals.sites),
        definitionValidatedConfirmed,
        definitionValidatedUnverified,
        definitionValidatedOracleCalls,
        definitionUnresolvedReferenceEdges,
        definitionLookupErrors,
        oracleBroadReferenceEdges,
        configurationGatedUnscored,
        sourceStatusErrors,
        calleeUnscoredSites,
        calleeFalsePositiveSamples,
        calleeSites: calleeTotals.sites,
        calleeHits: calleeTotals.hits,
        calleePlacement: calleeTotals.placement,
        calleeSemanticRecall,
        calleeSemanticMissing,
        calleeMissingUnexplained: calleeTotals.placement.missingUnexplained,
        calleeUnexplainedSamples,
        calleeSemanticMissingSamples,
        commandProof,
    };

    process.stdout.write(`  tier1Precision ${pct(summary.tier1Precision)} | unverifiedPrecision ${pct(summary.unverifiedPrecision)} | ` +
        `tierSeparation ${summary.tierSeparation ?? 'n/a'} | placement ${JSON.stringify(summary.oraclePlacement)} | ` +
        `semanticRecall ${pct(summary.semanticRecall)} (${summary.semanticMissing} missing) | ` +
        `observedZeroAgreement ${summary.observedZeroAgreement != null ? pct(summary.observedZeroAgreement) : 'n/a'} (${summary.zeroCases} cases) | ` +
        `conserved ${pct(summary.conservedRate)}\n`);
    for (const [kind, k] of Object.entries(summary.byKind)) {
        process.stdout.write(`    ${kind.padEnd(8)} n=${k.sampled} | tier1 ${k.confirmedScored ? pct(k.tier1Precision) : 'n/a'} (${k.confirmedHits}/${k.confirmedScored} scored; ${k.confirmedUnscored} cfg-unscored) | ` +
            `unverified ${k.unverifiedScored ? pct(k.unverifiedPrecision) : 'n/a'} (${k.unverifiedHits}/${k.unverifiedScored} scored; ${k.unverifiedUnscored} cfg-unscored) | ` +
            `placement ${JSON.stringify(k.oraclePlacement)}\n`);
    }
    process.stdout.write(`  callee arm: precision ${pct(summary.calleePrecision)} (${summary.calleeHits}/${summary.calleeSites}) | ` +
        `semanticRecall ${pct(summary.calleeSemanticRecall)} (${summary.calleeSemanticMissing} missing) | ` +
        `placement ${JSON.stringify(summary.calleePlacement)}\n`);
    process.stdout.write(`  command arm: definition ${pct(summary.commandProof.definition.recall)} | ` +
        `find ${pct(summary.commandProof.find.recall)} | extraction ${pct(summary.commandProof.extraction.recall)} | ` +
        `brief ${pct(summary.commandProof.brief.recall)} | typedef ${pct(summary.commandProof.typedef.recall)} | ` +
        `usages ${pct(summary.commandProof.usages.recall)} | tests ${pct(summary.commandProof.tests.recall)} | ` +
        `example ${pct(summary.commandProof.example.recall)} | failures ${summary.commandProof.failures}\n`);
    if (typeof oracle.resolveDefinition === 'function') {
        process.stdout.write(`  definition adjudication: confirmed ${summary.definitionValidatedConfirmed}, ` +
            `unverified ${summary.definitionValidatedUnverified}, oracle calls ${summary.definitionValidatedOracleCalls} | ` +
            `broad-family refs excluded ${summary.oracleBroadReferenceEdges} | ` +
            `unresolved ${summary.definitionUnresolvedReferenceEdges} | errors ${summary.definitionLookupErrors}\n`);
    }
    if (typeof oracle.isConfigurationGated === 'function') {
        process.stdout.write(`  configuration coverage: ${summary.configurationGatedUnscored} precision edge(s) unscored, ` +
            `${summary.calleeUnscoredSites} callee site(s) unscored | status errors ${summary.sourceStatusErrors}\n`);
    }
    if (summary.missingUnexplained > 0) {
        process.stdout.write(`  ⚠ GATE FAILURE: ${summary.missingUnexplained} oracle call edge(s) unexplained: ${JSON.stringify(unexplainedSamples.slice(0, 3))}\n`);
    }
    if (summary.semanticMissing > 0) {
        process.stdout.write(`  ⚠ SEMANTIC RECALL GATE FAILURE: ${summary.semanticMissing} oracle edge(s) were not shown in confirmed/unverified: ${JSON.stringify(semanticMissingSamples.slice(0, 3))}\n`);
    }
    if (summary.calleeMissingUnexplained > 0) {
        process.stdout.write(`  ⚠ CALLEE GATE FAILURE: ${summary.calleeMissingUnexplained} oracle edge(s) unexplained in callee answers: ${JSON.stringify(calleeUnexplainedSamples.slice(0, 3))}\n`);
    }
    if (summary.calleeSemanticMissing > 0) {
        process.stdout.write(`  ⚠ CALLEE SEMANTIC RECALL GATE FAILURE: ${summary.calleeSemanticMissing} oracle edge(s) were not shown for the exact target: ${JSON.stringify(calleeSemanticMissingSamples.slice(0, 3))}\n`);
    }
    if (summary.definitionLookupErrors > 0) {
        process.stdout.write(`  ⚠ ORACLE ADJUDICATION FAILURE: ${summary.definitionLookupErrors} exact-definition request(s) failed\n`);
    }
    if (summary.sourceStatusErrors > 0) {
        process.stdout.write(`  ⚠ ORACLE SOURCE-STATUS FAILURE: ${summary.sourceStatusErrors} configuration-status request(s) failed\n`);
    }
    if (summary.commandProof.failures > 0) {
        process.stdout.write(`  ⚠ COMMAND-SURFACE GATE FAILURE: ${summary.commandProof.failures} missing/error result(s): ` +
            `${JSON.stringify([...summary.commandProof.missingSamples, ...summary.commandProof.errorSamples].slice(0, 5))}\n`);
    }

    if (oracle.dispose) {
        try { await oracle.dispose(handle); } catch (e) { /* teardown is best-effort */ }
    }

    return { summary, perSymbol };
}

const _lineCache = new Map();
/** Does (file, line) word-boundary match the symbol name? (= ground-set membership) */
function lineMatchesSymbol(root, relFile, line, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return lineMatchesText(root, relFile, line, new RegExp(`\\b${esc}\\b`));
}

function lineMatchesText(root, relFile, line, regex) {
    const abs = path.join(root, relFile);
    let lines = _lineCache.get(abs);
    if (lines === undefined) {
        try { lines = fs.readFileSync(abs, 'utf-8').split('\n'); }
        catch (e) { lines = null; }
        _lineCache.set(abs, lines);
    }
    if (!lines || line < 1 || line > lines.length) return false;
    return regex.test(lines[line - 1]);
}

function lineText(root, relFile, line) {
    const abs = path.join(root, relFile);
    let lines = _lineCache.get(abs);
    if (lines === undefined) {
        try { lines = fs.readFileSync(abs, 'utf-8').split('\n'); }
        catch (e) { lines = null; }
        _lineCache.set(abs, lines);
    }
    return lines && line >= 1 && line <= lines.length ? lines[line - 1].trim() : null;
}

function pushSample(samples, sample, cap = 30) {
    if (samples.length < cap) samples.push(sample);
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
    const baseRepos = freshCount ? selectFreshRepos(freshCount) : REPOS;
    const oracleRepos = baseRepos.filter(r =>
        ORACLES.some(o => o.languages.includes(r.language)) &&
        (!repoFilterSet || repoFilterSet.has(r.name)));
    if (oracleRepos.length === 0) {
        console.error(`No matching repos for oracle languages${repoFilter ? ` and --repo ${repoFilter}` : ''}.`);
        process.exit(1);
    }
    if (freshCount) {
        for (const repo of oracleRepos) resolveFreshCommit(repo);
        process.stdout.write(`Fresh-repo arm: ${oracleRepos.map(r => `${r.name}@${r.commit.slice(0, 8)}`).join(', ')}\n`);
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
            if (result.summary.errors > 0 || result.summary.evaluated !== result.summary.sampled) {
                process.stdout.write(`  ⚠ EXECUTION-COMPLETENESS GATE FAILURE: evaluated ${result.summary.evaluated}/${result.summary.sampled}, errors ${result.summary.errors}\n`);
                gateFailed = true;
            }
            if (result.summary.semanticMissing > 0) gateFailed = true;
            if (result.summary.calleeSemanticMissing > 0) gateFailed = true;
            if (result.summary.definitionLookupErrors > 0) gateFailed = true;
            if (result.summary.sourceStatusErrors > 0) gateFailed = true;
            if (result.summary.commandProof.failures > 0) gateFailed = true;
            if (result.summary.conservedRate < 1) {
                process.stdout.write(`  ⚠ CONSERVATION GATE FAILURE: ${pct(result.summary.conservedRate)} of sampled accounts conserved\n`);
                gateFailed = true;
            }
            if (result.summary.observedZeroAgreement != null &&
                result.summary.observedZeroAgreement < 1) {
                process.stdout.write(`  ⚠ OBSERVED-ZERO GATE FAILURE: ${pct(result.summary.observedZeroAgreement)} agreement\n`);
                gateFailed = true;
            }
            if (minPrecision != null && result.summary.tier1Precision < minPrecision) {
                process.stdout.write(`  ⚠ PRECISION GATE FAILURE: tier1 ${pct(result.summary.tier1Precision)} < floor ${pct(minPrecision)}\n`);
                gateFailed = true;
            }
            if (minPrecision != null && result.summary.calleeSites > 0 &&
                result.summary.calleePrecision < minPrecision) {
                process.stdout.write(`  ⚠ CALLEE PRECISION GATE FAILURE: ${pct(result.summary.calleePrecision)} < floor ${pct(minPrecision)}\n`);
                gateFailed = true;
            }
            const jsonPath = path.join(REPORTS_DIR, `oracle-eval-${repo.name}-${oracle.name}-${date}${seedSuffix}.json`);
            fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
            process.stdout.write(`  wrote ${path.relative(process.cwd(), jsonPath)}\n`);
        } catch (e) {
            process.stderr.write(`  FAILED ${repo.name}: ${e.stack || e.message}\n`);
            results.push({ summary: { repo: repo.name, error: e.message }, perSymbol: [] });
            gateFailed = true;
        }
    }

    const lines = [
        `# Oracle eval — ${date}${freshCount ? ' (fresh-repo arm: unpinned rotation)' : ''}`,
        '',
        'UCN tiered caller answers scored against compiler/LSP ground truth.',
        '`semantic-missing` is the release gate: every indexed, in-scope oracle',
        'call edge must appear in CONFIRMED or UNVERIFIED. Merely conserving it',
        'inside a non-call/excluded count is not enough. Target: 0.',
        '',
        '| repo | oracle | sampled | oracle edges | tier1 precision | semantic recall | semantic missing | unverified precision | observed-zero agreement | conserved |',
        '|---|---|---|---|---|---|---|---|---|---|',
    ];
    for (const { summary: s } of results) {
        if (s.error) { lines.push(`| ${s.repo} | — | — | — | — | — | — | — | — | ERROR: ${s.error} |`); continue; }
        lines.push(`| ${s.repo} | ${s.oracle} | ${s.sampled} | ${s.oracleCallEdges} | ${pct(s.tier1Precision)} | ${pct(s.semanticRecall)} | **${s.semanticMissing}** | ${pct(s.unverifiedPrecision)} | ${s.observedZeroAgreement != null ? pct(s.observedZeroAgreement) : 'n/a'} (${s.zeroCases}) | ${pct(s.conservedRate)} |`);
    }
    lines.push('');
    lines.push('## Oracle-backed command surface');
    lines.push('');
    lines.push('The sampled compiler/LSP symbols and references also gate exact definition');
    lines.push('discovery, `find`, source extraction (`fn`/`class`), `brief`, `typedef`,');
    lines.push('literal code-reference recall in `usages`, direct test-reference recall in');
    lines.push('`tests`, and compiler-true selection by `example`. Command execution errors');
    lines.push('are failures; they can no longer silently reduce the evaluated sample.');
    lines.push('');
    lines.push('| repo | evaluated | definition | find | extract | brief | typedef | usages | tests | example | execution errors | failures |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const { summary: s } of results) {
        if (s.error || !s.commandProof) continue;
        const c = s.commandProof;
        const cell = m => `${pct(m.recall)} (${m.hits}/${m.eligible})`;
        lines.push(`| ${s.repo} | ${s.evaluated}/${s.sampled} | ${cell(c.definition)} | ${cell(c.find)} | ${cell(c.extraction)} | ${cell(c.brief)} | ${cell(c.typedef)} | ${cell(c.usages)} | ${cell(c.tests)} | ${cell(c.example)} | **${c.executionErrors}** | **${c.failures}** |`);
    }
    lines.push('');
    lines.push('## Per-kind breakdown');
    lines.push('');
    lines.push('Same metrics split by symbol kind (function / method / class), to');
    lines.push('localize precision gaps — e.g. method-name conflation, where import');
    lines.push('evidence confirms the file but not the receiver type.');
    lines.push('');
    lines.push('| repo | kind | sampled | oracle edges | tier1 precision | tier1 cfg-unscored | unverified precision | unverified cfg-unscored | separation | placement |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const { summary: s } of results) {
        if (s.error || !s.byKind) continue;
        for (const [kind, k] of Object.entries(s.byKind)) {
            lines.push(`| ${s.repo} | ${kind} | ${k.sampled} | ${k.oracleCallEdges} | ${k.confirmedScored ? pct(k.tier1Precision) : 'n/a'} (${k.confirmedHits}/${k.confirmedScored}) | ${k.confirmedUnscored} | ${k.unverifiedScored ? pct(k.unverifiedPrecision) : 'n/a'} (${k.unverifiedHits}/${k.unverifiedScored}) | ${k.unverifiedUnscored} | ${k.tierSeparation ?? 'n/a'} | ${JSON.stringify(k.oraclePlacement)} |`);
        }
    }
    lines.push('');
    lines.push('## Callee arm (trace-down contract)');
    lines.push('');
    lines.push('The same oracle edges re-read from the CALLER side: for each oracle');
    lines.push('call ref of a sampled symbol, the enclosing function\'s callee answer');
    lines.push('(findCallees collectAccount — the trace-down engine path) must show');
    lines.push('the exact site as confirmed or unverified. Account-only and');
    lines.push('same-name-other-definition placements are semantic misses unless');
    lines.push('exact definition lookup proves the reference search expanded a');
    lines.push('virtual-method family and UCN selected the actual static target.');
    lines.push('');
    lines.push('| repo | callee precision | semantic recall | semantic missing | confirmed | oracle-broad | other-def | unverified | unverified+other | accounted | module-level | beyond-text |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const { summary: s } of results) {
        if (s.error || !s.calleePlacement) continue;
        const cp = s.calleePlacement;
        lines.push(`| ${s.repo} | ${pct(s.calleePrecision)} (${s.calleeHits}/${s.calleeSites}) | ${pct(s.calleeSemanticRecall)} | **${s.calleeSemanticMissing}** | ${cp.confirmed} | ${cp.oracleBroadReference} | ${cp.confirmedOtherDef} | ${cp.unverified} | ${cp.unverifiedWithOtherDef} | ${cp.accounted} | ${cp.moduleLevel} | ${cp.missingBeyondText} |`);
    }
    lines.push('');
    lines.push('## Exact-definition adjudication');
    lines.push('');
    lines.push('For repeated project symbol names, reference-search hits are checked');
    lines.push('against `textDocument/definition`. References statically bound to');
    lines.push('another definition are excluded from this target\'s ground truth.');
    lines.push('Unresolved lookups remain in the conservative reference-search set;');
    lines.push('request errors fail the gate instead of silently weakening it.');
    lines.push('For Rust, unresolved precision edges inside syn-confirmed `#[cfg]`');
    lines.push('owners are reported as unscored because one rust-analyzer process');
    lines.push('cannot activate mutually exclusive feature/platform projections.');
    lines.push('');
    lines.push('| repo | confirmed edges validated | unverified edges validated | oracle calls validated | broad-family refs excluded | unresolved refs | lookup errors | cfg-unscored precision edges | cfg-unscored callee sites | source-status errors |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const { summary: s } of results) {
        if (s.error) continue;
        lines.push(`| ${s.repo} | ${s.definitionValidatedConfirmed} | ${s.definitionValidatedUnverified} | ${s.definitionValidatedOracleCalls} | ${s.oracleBroadReferenceEdges} | ${s.definitionUnresolvedReferenceEdges} | **${s.definitionLookupErrors}** | ${s.configurationGatedUnscored} | ${s.calleeUnscoredSites} | **${s.sourceStatusErrors}** |`);
    }
    lines.push('');
    const mdPath = path.join(REPORTS_DIR, `oracle-eval-rollup-${date}${seedSuffix}.md`);
    fs.writeFileSync(mdPath, lines.join('\n'));
    process.stdout.write(`\nwrote ${path.relative(process.cwd(), mdPath)}\n`);

    process.exit(gateFailed ? 1 : 0);
}

main();
