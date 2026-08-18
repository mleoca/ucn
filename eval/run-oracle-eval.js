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
 *   node eval/run-oracle-eval.js --release        # publish-blocking shared board
 *   node eval/run-oracle-eval.js --sample 20      # symbols per repo (default 50)
 *   node eval/run-oracle-eval.js --oracle jedi    # force an oracle (default: first match;
 *                                                 # python = pyright, jedi second opinion)
 *   node eval/run-oracle-eval.js --min-precision 0.98   # ALSO gate on tier-1 precision
 *                                                 # (PR gate: catch regressions, not just
 *                                                 # contract violations)
 *   node eval/run-oracle-eval.js --max-true-edge-unverified-rate 0.10
 *   node eval/run-oracle-eval.js --min-zero-unverified-rate 0.80
 *   node eval/run-oracle-eval.js --max-unverified-p95 5
 *   node eval/run-oracle-eval.js --max-unverified-review-items-per-oracle-edge 0.10
 *                                                 # review-burden gates; --release uses
 *                                                 # the portable-AST v5 budgets by default
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
    PROOF_COMMANDS,
    createCommandProofSummary,
    evaluateSymbolCommandProof,
    finalizeCommandProof,
    lineContainsIdentifier,
} = require('./command-proof');
const {
    REPOS,
    RELEASE_REPOS,
    cloneAtCommit,
    resolveTarget,
    seededRandom,
    resolveFreshCommit,
    selectFreshRepos,
} = require('./lib/repos');
const { validateOracle, createOraclePathMapper } = require('./oracles/oracle-interface');
const {
    PORTABLE_AST_REVIEW_BUDGETS,
    optionalRate,
    optionalNonNegative,
    summarizeReviewBurden,
    evaluateReviewBurden,
    evaluateOracleCoverage,
    closeJsTsDeclarationIdentity,
    adjudicateDeferredUnresolved,
} = require('./oracle-gate-policy');
const { tsMorphOracle } = require('./oracles/ts-morph-oracle');
const { pyrightOracle } = require('./oracles/pyright-oracle');
const { jediOracle } = require('./oracles/jedi-oracle');
const { goplsOracle } = require('./oracles/gopls-oracle');
const { rustAnalyzerOracle } = require('./oracles/rust-analyzer-oracle');
const { jdtlsOracle } = require('./oracles/jdtls-oracle');
const { roslynOracle } = require('./oracles/roslyn-oracle');
const { clangdOracle } = require('./oracles/clangd-oracle');

const args = process.argv.slice(2);
const releaseOnly = args.includes('--release');
const repoFilter = readArgValue(args, '--repo'); // name, or comma-separated names
const repoFilterSet = repoFilter ? new Set(repoFilter.split(',').map(s => s.trim())) : null;
const sampleSize = Number(readArgValue(args, '--sample') || 50);
const oracleFilter = readArgValue(args, '--oracle');
const minPrecision = optionalRateArg('--min-precision');
const maxUnscoredRatio = optionalRateArg('--max-unscored-ratio');
const reviewBudgetOverrides = {
    maxTrueEdgeUnverifiedRate: optionalRateArg('--max-true-edge-unverified-rate'),
    maxKindTrueEdgeUnverifiedRate: optionalRateArg('--max-kind-true-edge-unverified-rate'),
    minZeroUnverifiedTargetRate: optionalRateArg('--min-zero-unverified-rate'),
    maxUnverifiedCandidatesP95: optionalNonNegativeArg('--max-unverified-p95', true),
    maxUnverifiedReviewItemsPerOracleEdge: optionalNonNegativeArg(
        '--max-unverified-review-items-per-oracle-edge'),
    minKindOracleEdges: optionalNonNegativeArg('--min-kind-oracle-edges', true),
};
const requestedReviewBudgets = Object.fromEntries(
    Object.entries(reviewBudgetOverrides).filter(([, value]) => value != null));
const reviewBudgets = releaseOnly
    ? { ...PORTABLE_AST_REVIEW_BUDGETS, ...requestedReviewBudgets }
    : (Object.keys(requestedReviewBudgets).length > 0 ? requestedReviewBudgets : null);
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
const REPORTS_DIR = path.resolve(
    process.env.UCN_EVAL_REPORTS_DIR || path.join(__dirname, 'reports'));

// Order matters: per repo the FIRST language match wins — pyright (stronger
// inference) is the primary Python oracle, jedi stays as the second opinion
// via --oracle jedi.
const ORACLES = [
    tsMorphOracle,
    pyrightOracle,
    jediOracle,
    goplsOracle,
    rustAnalyzerOracle,
    jdtlsOracle,
    roslynOracle,
    clangdOracle,
]
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

function optionalRateArg(flag) {
    if (!args.includes(flag)) return null;
    const raw = readArgValue(args, flag);
    if (raw == null) throw new Error(`${flag} requires a value`);
    return optionalRate(raw, flag);
}

function optionalNonNegativeArg(flag, integer = false) {
    if (!args.includes(flag)) return null;
    const raw = readArgValue(args, flag);
    if (raw == null) throw new Error(`${flag} requires a value`);
    return optionalNonNegative(raw, flag, integer);
}

function key(file, line) { return `${file}:${line}`; }

function isExactOracleCall(call) {
    return !call?.uncertaintyClass;
}

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
        unverifiedReasons: {},
        oracleCallEdges: 0,
        exactOracleCallEdges: 0,
        runtimeOracleCallEdges: 0,
        compileTimeOracleCallEdges: 0,
        unresolvedOracleCallEdges: 0,
        placement: emptyPlacement(),
        exactPlacement: emptyPlacement(),
    };
}

function addReasonStat(stats, reason, verdict) {
    const keyName = reason || 'unspecified';
    if (!stats[keyName]) stats[keyName] = { candidates: 0, hits: 0, unscored: 0 };
    const row = stats[keyName];
    row.candidates++;
    if (!verdict.scorable) row.unscored++;
    else if (verdict.hit) row.hits++;
}

function mergeReasonStats(target, source) {
    for (const [reason, row] of Object.entries(source || {})) {
        if (!target[reason]) target[reason] = { candidates: 0, hits: 0, unscored: 0 };
        target[reason].candidates += row.candidates || 0;
        target[reason].hits += row.hits || 0;
        target[reason].unscored += row.unscored || 0;
    }
}

function finalizeReasonStats(stats) {
    return Object.fromEntries(Object.entries(stats || {})
        .map(([reason, row]) => {
            const scored = Math.max(0, row.candidates - row.unscored);
            const falseCandidates = Math.max(0, scored - row.hits);
            return [reason, {
                ...row,
                scored,
                falseCandidates,
                precision: scored > 0 ? rate(row.hits, scored) : null,
            }];
        })
        .sort((a, b) => b[1].candidates - a[1].candidates || a[0].localeCompare(b[0])));
}

async function evaluateRepo(repo, oracle) {
    process.stdout.write(`\n=== ${repo.name} (${repo.language}) @ ${repo.commit.slice(0, 8)} — oracle: ${oracle.name} ===\n`);
    const repoPath = cloneAtCommit(repo);
    const target = resolveTarget(repoPath, repo);

    const index = new ProjectIndex(target);
    // Feed the same explicit include roots to UCN that the compiler oracle
    // receives. This keeps the comparison on one build configuration while
    // exercising the public `.ucn.json` includePaths capability used by
    // source distributions without compile_commands.json.
    const configuredIncludePaths = [];
    for (let i = 0; i < (repo.clangFlags || []).length; i++) {
        const flag = String(repo.clangFlags[i]);
        if (flag === '-I' && repo.clangFlags[i + 1]) {
            configuredIncludePaths.push(String(repo.clangFlags[++i]));
        } else if (flag.startsWith('-I') && flag.length > 2) {
            configuredIncludePaths.push(flag.slice(2));
        }
    }
    if (configuredIncludePaths.length > 0) {
        index.config.includePaths = configuredIncludePaths;
    }
    if ((repo.oracleExclude || []).length > 0) {
        index.config.exclude = [
            ...(index.config.exclude || []),
            ...repo.oracleExclude.map(relative =>
                `${String(relative).replace(/\/+$/, '')}/**`),
        ];
    }
    index.build(null, { quiet: true });
    const indexedFiles = new Set([...index.files.values()].map(fe => fe.relativePath));
    process.stdout.write(`  UCN indexed ${indexedFiles.size} files\n`);

    const handle = await oracle.prepare(target, { repo });
    // Path-base normalization: oracle paths are relative to the prepared
    // target dir; UCN paths are relative to its detected project root (which
    // may be a parent, e.g. packages/core vs packages/core/src). Convert all
    // oracle paths to UCN-relative so the universes align.
    const oracleRoot = handle.root || target;
    const pathMapper = createOraclePathMapper(index.root, oracleRoot);
    const toUcnRel = pathMapper.toIndex;
    const toOracleRel = pathMapper.toOracle;
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
    if (oracle.comprehensiveReferences) {
        process.stdout.write(
            '  resolving comprehensive compiler call occurrences for sampled symbols...\n');
        for (const sym of sampled) {
            const refs = await oracle.findReferences(handle, {
                name: sym.name,
                file: sym.oracleFile,
                line: sym.line,
                comprehensive: true,
            });
            refCache.set(sym, refs.map(reference => ({
                ...reference,
                file: toUcnRel(reference.file),
            })));
        }
    }

    // Score each symbol
    const perSymbol = [];
    const totals = {
        confirmedEdges: 0, confirmedHits: 0, confirmedUnscored: 0,
        unverifiedEdges: 0, unverifiedHits: 0, unverifiedUnscored: 0,
        unverifiedReasons: {},
        oracleCallEdges: 0,
        exactOracleCallEdges: 0,
        runtimeOracleCallEdges: 0,
        compileTimeOracleCallEdges: 0,
        unresolvedOracleCallEdges: 0,
        placement: emptyPlacement(),
        exactPlacement: emptyPlacement(),
        runtimeDispatchAccountedNotShown: 0,
        zeroCases: 0, zeroAgreed: 0,
        conserved: 0, evaluated: 0,
    };
    const byKind = new Map(SYMBOL_KINDS.map(k => [k, emptyKindTotals()]));
    const confirmedFalsePositiveSamples = [];
    const confirmedUnscoredSamples = [];
    const unverifiedUnscoredSamples = [];
    const unexplainedSamples = [];
    const semanticMissingSamples = [];
    const allOracleSemanticMissingSamples = [];
    const runtimeDispatchNotShownSamples = [];
    const calleeAnswerCache = new Map();
    const calleeFalsePositiveSamples = [];
    const calleeUnexplainedSamples = [];
    const calleeSemanticMissingSamples = [];
    const calleeTotals = {
        sites: 0,
        hits: 0,
        placement: emptyCalleePlacement(),
        exactPlacement: emptyCalleePlacement(),
    };
    const commandProof = createCommandProofSummary();
    const definitionCache = new Map();
    let definitionValidatedConfirmed = 0;
    let definitionValidatedUnverified = 0;
    let definitionValidatedOracleCalls = 0;
    let oracleBroadReferenceEdges = 0;
    let definitionUnresolvedReferenceEdges = 0;
    let definitionLookupErrors = 0;
    let configurationGatedUnscored = 0;
    let confirmedConfigurationUnscored = 0;
    let confirmedAbstentionUnscored = 0;
    let unverifiedConfigurationUnscored = 0;
    let unverifiedAbstentionUnscored = 0;
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

    const resolvedDefinitions = async (file, line, name, column) => {
        if (typeof oracle.resolveDefinition !== 'function') return [];
        const cacheKey = `${file}:${line}:${column ?? '*'}:${name}`;
        if (definitionCache.has(cacheKey)) return definitionCache.get(cacheKey);
        let defs = [];
        try {
            defs = await oracle.resolveDefinition(handle, {
                file: toOracleRel(file), line, name, column,
            });
            defs = (defs || []).map(d => d.external
                ? { ...d }
                : { ...d, file: toUcnRel(d.file) });
        } catch {
            // Definition lookup is secondary to reference search, but an LSP
            // failure must remain visible so a trust report cannot silently
            // present a partially adjudicated result as exact.
            definitionLookupErrors++;
        }
        definitionCache.set(cacheKey, defs);
        return defs;
    };
    const targetDefinitionList = targetDef =>
        (Array.isArray(targetDef) ? targetDef : [targetDef]).filter(Boolean);
    const definitionMatchesTarget = (definition, targetDef) =>
        targetDefinitionList(targetDef).some(target =>
            definition.file === target.relativePath &&
            definition.line >= target.startLine &&
            definition.line <= target.endLine);
    const resolvesTo = async (file, line, name, targetDef, column) => {
        if (targetDefinitionList(targetDef).length === 0) return false;
        const defs = await resolvedDefinitions(file, line, name, column);
        return defs.some(d => definitionMatchesTarget(d, targetDef));
    };
    const definitionStatus = async (file, line, name, targetDef, column) => {
        if (targetDefinitionList(targetDef).length === 0 ||
            typeof oracle.resolveDefinition !== 'function') return 'unavailable';
        const defs = await resolvedDefinitions(file, line, name, column);
        if (defs.length === 0) return 'unresolved';
        return defs.some(d => definitionMatchesTarget(d, targetDef))
            ? 'target' : 'other';
    };

    for (const sym of sampled) {
        const symbolStartedAt = Date.now();
        if (process.env.UCN_EVAL_PROGRESS) {
            process.stderr.write(
                `  evaluating ${sym.kind} ${sym.file}:${sym.line}:${sym.name}\n`);
        }
        const oracleRefs = refCache.get(sym) || [];
        const rawOracleCalls = dedupe(oracleRefs.filter(r => r.kind === 'call')
            // a "call" on the declaration line is the declaration itself in some
            // ts-morph shapes — exclude self-lines
            .filter(r => !(r.file === sym.file && r.line === sym.line)), true);

        const sameNameDefs = index.symbols.get(sym.name) || [];
        const targetDef = sameNameDefs.find(d =>
            d.relativePath === sym.file &&
            (d.startLine === sym.line || d.nameLine === sym.line));
        const targetLanguage = targetDef
            ? index.files.get(targetDef.file)?.language : null;
        // A C/C++ header prototype and its source definition are distinct
        // source records but one compiler identity. Ask the independent
        // oracle for the declaration's canonical definition, then map that
        // location back to UCN records so precision and recall are judged
        // against the whole redeclaration chain rather than whichever source
        // location happened to be sampled.
        let targetIdentityDefs = targetDef ? [targetDef] : [];
        if (targetDef && typeof oracle.resolveDefinition === 'function') {
            const canonicalTargets = await resolvedDefinitions(
                sym.file, sym.line, sym.name);
            for (const location of canonicalTargets) {
                const equivalent = sameNameDefs.find(definition =>
                    definition.relativePath === location.file &&
                    location.line >= definition.startLine &&
                    location.line <= definition.endLine);
                const isCFamilyPrototype =
                    ['c', 'cpp'].includes(targetLanguage) &&
                    targetDef.isSignature;
                const implementationIncludesTarget = equivalent &&
                    (() => {
                        if (equivalent.file === targetDef.file) return true;
                        const queue = [equivalent.file];
                        const seen = new Set(queue);
                        for (let depth = 0;
                            queue.length > 0 && depth < 16; depth++) {
                            const file = queue.shift();
                            for (const imported of
                                index.importGraph?.get(file) || []) {
                                if (imported === targetDef.file) return true;
                                if (!seen.has(imported)) {
                                    seen.add(imported);
                                    queue.push(imported);
                                }
                            }
                        }
                        return false;
                    })();
                // A clangd workspace can contain several independently linked
                // test binaries with the same external callback name. Its
                // workspace-wide "definition" choice for a header prototype
                // is then arbitrary. Accept only the same redeclaration file
                // or a source file that actually includes the sampled header.
                if (equivalent &&
                    (!isCFamilyPrototype ||
                     equivalent.relativePath === targetDef.relativePath ||
                     implementationIncludesTarget) &&
                    !targetIdentityDefs.includes(equivalent)) {
                    targetIdentityDefs.push(equivalent);
                }
            }
            if (['c', 'cpp'].includes(
                index.files.get(targetDef.file)?.language) &&
                targetDef.isSignature) {
                for (const equivalent of sameNameDefs) {
                    if (equivalent.relativePath === targetDef.relativePath &&
                        !targetIdentityDefs.includes(equivalent)) {
                        targetIdentityDefs.push(equivalent);
                    }
                }
            }
        }
        if (targetDef && ['javascript', 'typescript'].includes(targetLanguage)) {
            for (const equivalent of closeJsTsDeclarationIdentity(
                sameNameDefs, targetDef)) {
                if (!targetIdentityDefs.includes(equivalent)) {
                    targetIdentityDefs.push(equivalent);
                }
            }
        }
        if (targetDef && ['c', 'cpp'].includes(targetLanguage)) {
            const typeSignature = definition => {
                if (!Array.isArray(definition.paramsStructured)) return null;
                const types = definition.paramsStructured.map(param =>
                    String(param?.type ?? '').replace(/\s+/g, ''));
                return types.some(type => !type) ? null : types.join(',');
            };
            const targetSignature = typeSignature(targetDef);
            const sameSlotImplementations = sameNameDefs.filter(definition =>
                !definition.isSignature &&
                (definition.namespace || null) ===
                    (targetDef.namespace || null) &&
                (definition.className || definition.receiver || null) ===
                    (targetDef.className || targetDef.receiver || null) &&
                targetSignature !== null &&
                typeSignature(definition) === targetSignature);
            const targetExactOracleKeys = new Set(rawOracleCalls
                .filter(isExactOracleCall)
                .map(reference => key(reference.file, reference.line)));
            const reachesFile = (from, destination) => {
                if (from === destination) return true;
                const queue = [from];
                const seen = new Set(queue);
                for (let depth = 0;
                    queue.length > 0 && depth < 16; depth++) {
                    const current = queue.shift();
                    for (const imported of index.importGraph?.get(current) || []) {
                        if (imported === destination) return true;
                        if (!seen.has(imported)) {
                            seen.add(imported);
                            queue.push(imported);
                        }
                    }
                }
                return false;
            };
            for (const equivalent of sameNameDefs) {
                if (targetIdentityDefs.includes(equivalent) ||
                    (!targetDef.isSignature && !equivalent.isSignature) ||
                    (targetDef.namespace || null) !==
                        (equivalent.namespace || null) ||
                    (targetDef.className || targetDef.receiver || null) !==
                        (equivalent.className || equivalent.receiver || null) ||
                    targetSignature === null ||
                    typeSignature(equivalent) !== targetSignature) {
                    continue;
                }
                // A prototype and definition are one callable identity only
                // when one source surface reaches the other. This joins normal
                // header/source redeclarations while keeping independently
                // linked test callbacks such as multiple `setUp` definitions
                // distinct.
                const equivalentOracleSymbol = sampled.find(candidate =>
                    candidate.name === sym.name &&
                    candidate.file === equivalent.relativePath &&
                    candidate.line === equivalent.startLine);
                const equivalentExactOracleKeys = equivalentOracleSymbol
                    ? new Set((refCache.get(equivalentOracleSymbol) || [])
                        .filter(reference => reference.kind === 'call' &&
                            isExactOracleCall(reference))
                        .map(reference => key(reference.file, reference.line)))
                    : null;
                const sameCompilerReferenceFamily =
                    targetExactOracleKeys.size > 0 &&
                    equivalentExactOracleKeys?.size ===
                        targetExactOracleKeys.size &&
                    [...targetExactOracleKeys].every(referenceKey =>
                        equivalentExactOracleKeys.has(referenceKey));
                if (sameSlotImplementations.length === 1 ||
                    sameCompilerReferenceFamily ||
                    reachesFile(targetDef.file, equivalent.file) ||
                    reachesFile(equivalent.file, targetDef.file)) {
                    targetIdentityDefs.push(equivalent);
                }
            }
        }
        // UCN models `new Type(...)` as the exact constructor definition
        // when one is indexed, while compiler reference search for a sampled
        // class reports the construction as a use of the class symbol. Both
        // are the same dependency for a class-target query: selecting that
        // class's constructor is stronger evidence than merely selecting the
        // class declaration.
        const isExactCalleeTargetEdge = edge =>
            edge.name === sym.name &&
            (targetIdentityDefs.some(target =>
                edge.relativePath === target.relativePath &&
                edge.startLine === target.startLine) ||
             (sym.kind === 'class' && edge.type === 'constructor' &&
              edge.className === sym.name &&
              (edge.namespace || null) === (targetDef?.namespace || null)));
        // Reference search in some LSPs expands virtual method families. For a
        // repeated project symbol name, exact definition lookup is therefore
        // the authority: an edge statically bound to another definition must
        // not inflate either this target's recall or its apparent precision.
        const canAdjudicateDefinitions =
            !oracle.exactReferenceIdentity &&
            typeof oracle.resolveDefinition === 'function';
        const needsDefinitionAdjudication =
            canAdjudicateDefinitions && sameNameDefs.length > 1;
        const adjudicatedOracleCalls = [];
        for (const oc of rawOracleCalls) {
            if (!needsDefinitionAdjudication) {
                // An oracle-declared-unresolved call reference is a name
                // match the oracle could not bind (fix #286d, zod-measured:
                // benchmark-suite `.add(...)` on an untyped external import
                // credited to $ZodRegistry.add gated as a semantic-recall
                // miss). Single-def names skip adjudication here, but such
                // an edge must not GATE if the engine excluded it — tag it
                // for the deferred not-shown adjudication below. Adjudicating
                // the whole universe instead is wrong: a plain-JS repo is
                // MOSTLY unresolved (dayjs: 54% of edges dropped, coverage
                // gate red).
                if (canAdjudicateDefinitions &&
                    oc.oracleResolution === 'unresolved') {
                    oc._pendingUnresolved = true;
                }
                adjudicatedOracleCalls.push(oc);
                continue;
            }
            // Some oracles already perform runtime-reachability filtering on
            // each reference. In TypeScript, a call statically bound to a
            // base/interface declaration may execute the sampled override;
            // exact-definition equality would wrongly discard that
            // compiler-proven may-dispatch edge. Untyped/unresolved calls do
            // not carry this marker and still require adjudication below.
            if (oc.oracleResolution === 'may-reach') {
                adjudicatedOracleCalls.push(oc);
                definitionValidatedOracleCalls++;
                continue;
            }
            const status = await definitionStatus(
                oc.file, oc.line, sym.name, targetIdentityDefs, oc.column);
            if (status === 'other') {
                oracleBroadReferenceEdges++;
            } else if (status === 'target') {
                adjudicatedOracleCalls.push(oc);
                definitionValidatedOracleCalls++;
                // Same rule as the deferred pass: a positive definition pin
                // is compiler-grade identity — the edge is gate-bearing even
                // when the reference search abstained (fix #292).
                if (oc.uncertaintyClass === 'oracle-unresolved') {
                    delete oc.uncertaintyClass;
                }
            } else if (status === 'unresolved') {
                // A rename-oriented reference search plus an unresolved exact
                // definition is not compiler ground truth for THIS repeated
                // method — but whether the ENGINE shows the edge is not known
                // yet at this point. Defer (fix #292): an edge the engine
                // shows stays in the universe; only a not-shown one drops as
                // a measured abstention. The verdict is stashed so the
                // deferred pass never re-queries the oracle.
                oc._pendingUnresolved = true;
                oc._definitionStatus = 'unresolved';
                adjudicatedOracleCalls.push(oc);
            } else {
                adjudicatedOracleCalls.push(oc);
            }
        }
        // UCN's public occurrence contract is line-granular. Preserve columns
        // through adjudication so same-name calls on one line are classified
        // independently, then collapse compiler-true target calls to one line.
        const oracleCalls = dedupe(adjudicatedOracleCalls);

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
                const status = await definitionStatus(
                    relFile, best.line, best.calledAs || sym.name,
                    targetIdentityDefs);
                if (status === 'target') return 'hit';
                if (await isConfigurationGated(relFile, best.line)) return 'unscored';
                // 'other' is a positive contradiction — the site provably
                // calls a different definition, and the selection fails.
                // 'unresolved' (oracle blindness: `reg: any` receivers,
                // platform-only modules) and 'unavailable' (the oracle has
                // no definition lookup at all — ts-morph) contradict
                // nothing (#217 — unknown never fails a claim), so the
                // selection reports unscored — guarded by the called token
                // actually being on the line, so a fabricated site can
                // never ride this path.
                if (status === 'unresolved' || status === 'unavailable') {
                    if (lineContainsIdentifier(index, relFile, best.line,
                        best.calledAs || sym.name)) {
                        return 'unscored';
                    }
                }
                return 'miss';
            },
        });
        if (process.env.UCN_EVAL_PROGRESS) {
            process.stderr.write(
                `    public proof ${(Date.now() - symbolStartedAt)}ms\n`);
        }

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
            ...(Number.isInteger(c.column) && { column: c.column }),
            ...(c.calledAs && c.calledAs !== 'bound' && { calledAs: c.calledAs }),
            usageStyle: c.calledAs === 'bound' || !!c.functionReference,
        })));
        const unverified = dedupe((json.data.unverifiedCallers || []).map(c => ({
            file: c.file, line: c.line,
            ...(Number.isInteger(c.column) && { column: c.column }),
            ...(c.calledAs && c.calledAs !== 'bound' && { calledAs: c.calledAs }),
            usageStyle: c.calledAs === 'bound' || !!c.functionReference,
            reason: c.reason || c.resolution || 'unspecified',
            ...(c.dispatchVia && { dispatchVia: c.dispatchVia }),
            ...(c.dispatchCandidates != null && {
                dispatchCandidates: c.dispatchCandidates,
            }),
            ...(c.externalContract && { externalContract: true }),
            uncertaintyClass: c.uncertaintyClass || 'actionable-ambiguity',
            ...(c.dispatchFamily && { dispatchFamily: c.dispatchFamily }),
        })));
        const account = json.meta.account;

        const confirmedKeys = new Set(confirmed.map(c => key(c.file, c.line)));
        const unverifiedKeys = new Set(unverified.map(c => key(c.file, c.line)));
        // Deferred adjudication for oracle-unresolved references (fix #286d):
        // edges the engine SHOWS need no lookup — they stay in the universe
        // untouched (the dayjs lesson: plain-JS repos are mostly unresolved).
        // Only an unresolved edge the engine did NOT show is definition-
        // adjudicated: 'target' keeps it (a genuine, gate-bearing miss),
        // 'other' is a broad-family ref, 'unresolved' is an oracle
        // abstention — never punish the engine for excluding a site the
        // oracle cannot pin. 'unavailable' (no pinnable target defs) keeps
        // the edge — adjudication is impossible, stay loud.
        if (oracleCalls.some(oc => oc._pendingUnresolved)) {
            const kept = [];
            for (const oc of oracleCalls) {
                if (!oc._pendingUnresolved) { kept.push(oc); continue; }
                delete oc._pendingUnresolved;
                const stashedStatus = oc._definitionStatus;
                delete oc._definitionStatus;
                const k = key(oc.file, oc.line);
                if (confirmedKeys.has(k) || unverifiedKeys.has(k)) {
                    kept.push(oc);
                    continue;
                }
                const status = stashedStatus || await definitionStatus(
                    oc.file, oc.line, sym.name, targetIdentityDefs, oc.column);
                const verdict = adjudicateDeferredUnresolved(status);
                if (!verdict.keep) {
                    if (verdict.bucket === 'broad') oracleBroadReferenceEdges++;
                    else definitionUnresolvedReferenceEdges++;
                    continue;
                }
                kept.push(oc);
                if (verdict.gateBearing) {
                    definitionValidatedOracleCalls++;
                    // A positive definition pin at the site is compiler-grade
                    // identity: the miss re-enters the exact (gate-bearing)
                    // universe (fix #292 — restores #286d's "'target' keeps
                    // it a genuine, gate-bearing miss" semantics after the
                    // oracle-unresolved uncertainty class made kept edges
                    // silently non-exact).
                    delete oc.uncertaintyClass;
                }
            }
            oracleCalls.length = 0;
            oracleCalls.push(...kept);
        }
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
        const oracleMayReachKeys = new Set(oracleRefs
            .filter(r => r.kind === 'call' && r.oracleResolution === 'may-reach')
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
                if (oracleMayReachKeys.has(key(c.file, c.line))) {
                    return { hit: true, scorable: true, definitionValidated: true };
                }
                const status = await definitionStatus(
                    c.file, c.line, c.calledAs || sym.name,
                    targetIdentityDefs, c.column);
                if (status === 'target') return { hit: true, scorable: true, definitionValidated: true };
                const referenceHit = edgeHitWithoutDefinition(c);
                if (status === 'other' && !referenceHit && await isConfigurationGated(c.file, c.line)) {
                    return { hit: false, scorable: false, definitionValidated: true,
                        abstention: 'configuration-gated' };
                }
                if (status === 'other') return { hit: false, scorable: true, definitionValidated: true };
                if (status === 'unresolved' &&
                    lineContainsIdentifier(index, c.file, c.line,
                        c.calledAs || sym.name)) {
                    return { hit: false, scorable: false, definitionValidated: false,
                        abstention: 'definition-unresolved' };
                }
                if (referenceHit) return { hit: true, scorable: true, definitionValidated: false };
                if (await isConfigurationGated(c.file, c.line)) {
                    return { hit: false, scorable: false, definitionValidated: false,
                        abstention: 'configuration-gated' };
                }
                return { hit: false, scorable: true, definitionValidated: false };
            }
            if (edgeHitWithoutDefinition(c)) return { hit: true, scorable: true, definitionValidated: false };
            if (typeof oracle.resolveDefinition === 'function') {
                const status = await definitionStatus(
                    c.file, c.line, c.calledAs || sym.name,
                    targetIdentityDefs, c.column);
                if (status === 'target') {
                    return { hit: true, scorable: true, definitionValidated: true };
                }
                if (status === 'other') {
                    if (await isConfigurationGated(c.file, c.line)) {
                        return { hit: false, scorable: false, definitionValidated: true };
                    }
                    return { hit: false, scorable: true, definitionValidated: true };
                }
                // An oracle that cannot resolve an identifier occurrence is
                // abstaining, not proving that UCN selected the wrong target.
                // This discipline already applied to repeated names; apply it
                // equally to globally unique names so compiler namespace/
                // macro gaps cannot be scored as engine false positives.
                if (status === 'unresolved' &&
                    lineContainsIdentifier(index, c.file, c.line,
                        c.calledAs || sym.name)) {
                    return { hit: false, scorable: false, definitionValidated: false,
                        abstention: 'definition-unresolved' };
                }
            }
            if (await isConfigurationGated(c.file, c.line)) {
                return { hit: false, scorable: false, definitionValidated: false,
                    abstention: 'configuration-gated' };
            }
            return { hit: false, scorable: true, definitionValidated: false };
        };
        const confirmedVerdicts = [];
        for (const c of confirmed) {
            const verdict = await edgeMatchesTarget(c);
            confirmedVerdicts.push(verdict);
            if (verdict.hit && verdict.definitionValidated) definitionValidatedConfirmed++;
            if (!verdict.scorable) {
                configurationGatedUnscored++;
                if (verdict.abstention === 'definition-unresolved') {
                    confirmedAbstentionUnscored++;
                } else {
                    confirmedConfigurationUnscored++;
                }
                pushSample(confirmedUnscoredSamples, {
                    symbol: sym.name,
                    target: `${sym.file}:${sym.line}`,
                    edge: key(c.file, c.line),
                    abstention: verdict.abstention || 'oracle-unscored',
                    text: lineText(index.root, c.file, c.line),
                }, 100);
            }
        }
        const confirmedHits = confirmedVerdicts.filter(v => v.hit).length;
        const confirmedUnscored = confirmedVerdicts.filter(v => !v.scorable).length;
        let unverifiedHits = 0, unverifiedUnscored = 0;
        let actionableUnverifiedHits = 0, actionableUnverifiedUnscored = 0;
        let runtimeDispatchHits = 0, runtimeDispatchUnscored = 0;
        let compileTimeDispatchHits = 0, compileTimeDispatchUnscored = 0;
        const unverifiedReasonStats = {};
        for (const c of unverified) {
            const verdict = await edgeMatchesTarget(c);
            const runtimeDispatch = c.uncertaintyClass === 'runtime-dispatch';
            const compileTimeDispatch =
                c.uncertaintyClass === 'compile-time-dispatch';
            addReasonStat(unverifiedReasonStats, c.reason, verdict);
            if (!verdict.scorable) {
                unverifiedUnscored++;
                if (runtimeDispatch) runtimeDispatchUnscored++;
                else if (compileTimeDispatch) compileTimeDispatchUnscored++;
                else actionableUnverifiedUnscored++;
                configurationGatedUnscored++;
                if (verdict.abstention === 'definition-unresolved') {
                    unverifiedAbstentionUnscored++;
                } else {
                    unverifiedConfigurationUnscored++;
                }
                pushSample(unverifiedUnscoredSamples, {
                    symbol: sym.name,
                    target: `${sym.file}:${sym.line}`,
                    edge: key(c.file, c.line),
                    reason: c.reason,
                    abstention: verdict.abstention || 'oracle-unscored',
                    text: lineText(index.root, c.file, c.line),
                }, 100);
                continue;
            }
            if (verdict.hit) {
                unverifiedHits++;
                if (runtimeDispatch) runtimeDispatchHits++;
                else if (compileTimeDispatch) compileTimeDispatchHits++;
                else actionableUnverifiedHits++;
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
        const exactPlacement = emptyPlacement();
        for (const oc of oracleCalls) {
            const k = key(oc.file, oc.line);
            const exact = isExactOracleCall(oc);
            const place = field => {
                placement[field]++;
                if (exact) exactPlacement[field]++;
            };
            if (confirmedKeys.has(k)) place('confirmed');
            else if (unverifiedKeys.has(k)) place('unverified');
            else if (!indexedFiles.has(oc.file)) place('missingExplained'); // outside UCN's file universe
            else if (oc.oracleResolution === 'macro-expansion') {
                // UCN models the source dependency once at the macro body and
                // the macro invocation as a separate edge. Clang reports one
                // expanded target call per invocation. Those are compiler-true
                // runtime sites but not missing source dependencies: the
                // literal target does not exist on the expansion line and the
                // macro-body edge remains visible to trace.
                place('missingExplained');
            }
            else if (!lineMatchesSymbol(index.root, oc.file, oc.line, sym.name)) {
                place('missingBeyondText');
                const sample = {
                    category: 'missingBeyondText', symbol: sym.name, target: `${sym.file}:${sym.line}`,
                    edge: k, text: lineText(index.root, oc.file, oc.line),
                };
                pushSample(allOracleSemanticMissingSamples, sample);
                if (exact) pushSample(semanticMissingSamples, sample);
            } else if (account && account.conserved) {
                place('accountedNotShown');
                const sample = {
                    category: 'accountedNotShown', symbol: sym.name, target: `${sym.file}:${sym.line}`,
                    edge: k, text: lineText(index.root, oc.file, oc.line),
                };
                pushSample(allOracleSemanticMissingSamples, sample);
                if (exact) pushSample(semanticMissingSamples, sample);
                // A compiler-attested may-dispatch edge the engine EXCLUDED
                // with reason. Engine physics route possible-dispatch demote-
                // only (visible), so this bucket gates at 0 (fix #292 —
                // restores the sensitivity the runtime-dispatch class removed
                // from the exact gates).
                if (oc.uncertaintyClass === 'runtime-dispatch') {
                    totals.runtimeDispatchAccountedNotShown++;
                    pushSample(runtimeDispatchNotShownSamples, sample);
                }
            } else {
                place('missingUnexplained');
                const sample = {
                    category: 'missingUnexplained', symbol: sym.name, target: `${sym.file}:${sym.line}`,
                    edge: k, text: lineText(index.root, oc.file, oc.line),
                };
                pushSample(allOracleSemanticMissingSamples, sample);
                if (exact) pushSample(semanticMissingSamples, sample);
                if (exact && unexplainedSamples.length < 10) {
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
        const exactCalleePlacement = emptyCalleePlacement();
        let calleeSites = 0, calleeHits = 0;
        {
            const seenPrecisionDefs = new Set();
            for (const oc of oracleCalls) {
                const exactOracleEdge = isExactOracleCall(oc);
                const placeCallee = field => {
                    calleePlacement[field]++;
                    if (exactOracleEdge) exactCalleePlacement[field]++;
                };
                if (!indexedFiles.has(oc.file) ||
                    oc.oracleResolution === 'macro-expansion') {
                    placeCallee('missingExplained');
                    continue;
                }
                const absFile = path.join(index.root, oc.file);
                const encl = index.findEnclosingFunction(absFile, oc.line, true);
                if (!encl) { placeCallee('moduleLevel'); continue; }
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
                        if (!isExactCalleeTargetEdge(e)) continue;
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
                    e.sites && e.sites.includes(oc.line) &&
                    isExactCalleeTargetEdge(e));
                if (exactEdge) { placeCallee('confirmed'); continue; }
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
                    if (otherDefEdge) placeCallee('unverifiedWithOtherDef');
                    else placeCallee('unverified');
                    continue;
                }
                if (otherDefEdge) {
                    // JDT reference search expands virtual method families.
                    // When definition lookup says this line statically binds
                    // the exact other edge UCN selected, the oracle target is
                    // a broad-family reference—not an exact-target miss.
                    if (await resolvesTo(oc.file, oc.line, sym.name, otherDefEdge)) {
                        placeCallee('oracleBroadReference');
                        continue;
                    }
                    placeCallee('confirmedOtherDef');
                    if (exactOracleEdge) pushSample(calleeSemanticMissingSamples, {
                        category: 'confirmedOtherDef', symbol: sym.name, target: `${sym.file}:${sym.line}`,
                        edge: key(oc.file, oc.line), enclosing: encl.name,
                        selected: `${otherDefEdge.relativePath}:${otherDefEdge.startLine}`,
                        text: lineText(index.root, oc.file, oc.line),
                    });
                    continue;
                }
                if (!lineMatchesSymbol(index.root, oc.file, oc.line, sym.name)) {
                    placeCallee('missingBeyondText');
                    if (exactOracleEdge) pushSample(calleeSemanticMissingSamples, {
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
                    placeCallee('accounted');
                    if (exactOracleEdge) pushSample(calleeSemanticMissingSamples, {
                        category: 'accounted', symbol: sym.name, target: `${sym.file}:${sym.line}`,
                        edge: key(oc.file, oc.line), enclosing: encl.name,
                        text: lineText(index.root, oc.file, oc.line),
                    });
                } else {
                    placeCallee('missingUnexplained');
                    if (exactOracleEdge) pushSample(calleeSemanticMissingSamples, {
                        category: 'missingUnexplained', symbol: sym.name, target: `${sym.file}:${sym.line}`,
                        edge: key(oc.file, oc.line), enclosing: encl.name,
                        text: lineText(index.root, oc.file, oc.line),
                    });
                    if (exactOracleEdge && calleeUnexplainedSamples.length < 10) {
                        calleeUnexplainedSamples.push({ symbol: sym.name, edge: key(oc.file, oc.line), enclosing: encl.name });
                    }
                }
            }
        }

        // Zero-trustworthiness
        const ucnZero = confirmed.length === 0 && unverified.length === 0;
        if (ucnZero) {
            totals.zeroCases++;
            // Oracle edges outside the indexed file universe or emitted only
            // as compiler macro expansions are explicitly out of the direct
            // source-site contract. A UCN zero agrees when no eligible source
            // edge remains, not only when the compiler returned no runtime
            // edge whatsoever.
            const exactOracleCallsForSymbol = oracleCalls.filter(isExactOracleCall).length;
            if (exactOracleCallsForSymbol === exactPlacement.missingExplained) {
                totals.zeroAgreed++;
            }
        }

        calleeTotals.sites += calleeSites;
        calleeTotals.hits += calleeHits;
        for (const k of Object.keys(calleePlacement)) calleeTotals.placement[k] += calleePlacement[k];
        for (const k of Object.keys(exactCalleePlacement)) {
            calleeTotals.exactPlacement[k] += exactCalleePlacement[k];
        }

        totals.confirmedEdges += confirmed.length;
        totals.confirmedHits += confirmedHits;
        totals.confirmedUnscored += confirmedUnscored;
        totals.unverifiedEdges += unverified.length;
        totals.unverifiedHits += unverifiedHits;
        totals.unverifiedUnscored += unverifiedUnscored;
        mergeReasonStats(totals.unverifiedReasons, unverifiedReasonStats);
        totals.oracleCallEdges += oracleCalls.length;
        totals.exactOracleCallEdges += oracleCalls.filter(isExactOracleCall).length;
        totals.runtimeOracleCallEdges += oracleCalls.filter(call =>
            call.uncertaintyClass === 'runtime-dispatch').length;
        totals.compileTimeOracleCallEdges += oracleCalls.filter(call =>
            call.uncertaintyClass === 'compile-time-dispatch').length;
        totals.unresolvedOracleCallEdges += oracleCalls.filter(call =>
            call.uncertaintyClass === 'oracle-unresolved').length;
        for (const k of Object.keys(placement)) totals.placement[camel(k)] += placement[k];
        for (const k of Object.keys(exactPlacement)) {
            totals.exactPlacement[camel(k)] += exactPlacement[k];
        }
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
        mergeReasonStats(kt.unverifiedReasons, unverifiedReasonStats);
        kt.oracleCallEdges += oracleCalls.length;
        kt.exactOracleCallEdges += oracleCalls.filter(isExactOracleCall).length;
        kt.runtimeOracleCallEdges += oracleCalls.filter(call =>
            call.uncertaintyClass === 'runtime-dispatch').length;
        kt.compileTimeOracleCallEdges += oracleCalls.filter(call =>
            call.uncertaintyClass === 'compile-time-dispatch').length;
        kt.unresolvedOracleCallEdges += oracleCalls.filter(call =>
            call.uncertaintyClass === 'oracle-unresolved').length;
        for (const k of Object.keys(placement)) kt.placement[k] += placement[k];
        for (const k of Object.keys(exactPlacement)) {
            kt.exactPlacement[k] += exactPlacement[k];
        }

        const actionableUnverified = unverified.filter(
            site => site.uncertaintyClass !== 'runtime-dispatch' &&
                site.uncertaintyClass !== 'compile-time-dispatch');
        const runtimeDispatch = unverified.filter(
            site => site.uncertaintyClass === 'runtime-dispatch');
        const compileTimeDispatch = unverified.filter(
            site => site.uncertaintyClass === 'compile-time-dispatch');
        const runtimeDispatchGroups = new Set(runtimeDispatch.map(site =>
            `${site.dispatchVia || ''}\0${site.dispatchCandidates ?? ''}\0` +
            `${site.externalContract ? 'external' : 'project'}`));
        const compileTimeDispatchGroups = new Set(
            compileTimeDispatch.map(site =>
                `${site.dispatchFamily || ''}\0` +
                `${site.dispatchCandidates ?? ''}`));
        perSymbol.push({
            name: sym.name, file: sym.file, line: sym.line, kind: sym.kind,
            oracleCalls: oracleCalls.length,
            confirmed: confirmed.length, confirmedHits, confirmedUnscored,
            unverified: unverified.length, unverifiedHits, unverifiedUnscored,
            actionableUnverified: actionableUnverified.length,
            actionableUnverifiedHits,
            actionableUnverifiedUnscored,
            runtimeDispatchSites: runtimeDispatch.length,
            runtimeDispatchGroups: runtimeDispatchGroups.size,
            runtimeDispatchHits,
            runtimeDispatchUnscored,
            compileTimeDispatchSites: compileTimeDispatch.length,
            compileTimeDispatchGroups: compileTimeDispatchGroups.size,
            compileTimeDispatchHits,
            compileTimeDispatchUnscored,
            unverifiedReasons: finalizeReasonStats(unverifiedReasonStats),
            placement,
            exactOracleCalls: oracleCalls.filter(isExactOracleCall).length,
            runtimeOracleCalls: oracleCalls.filter(call =>
                call.uncertaintyClass === 'runtime-dispatch').length,
            compileTimeOracleCalls: oracleCalls.filter(call =>
                call.uncertaintyClass === 'compile-time-dispatch').length,
            exactPlacement,
            calleePlacement,
            exactCalleePlacement,
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
    const allOracleSemanticMissing = totals.placement.accountedNotShown +
        totals.placement.missingBeyondText + totals.placement.missingUnexplained;
    const allOracleSemanticEligible = Math.max(
        0, totals.oracleCallEdges - totals.placement.missingExplained);
    const allOracleSemanticRecall = allOracleSemanticEligible > 0
        ? rate(allOracleSemanticEligible - allOracleSemanticMissing,
            allOracleSemanticEligible)
        : 1;
    // Compiler-dependent overload families are conservative candidate sets,
    // not exact target edges. Gate semantic recall on the compiler's exact
    // identity set; retain the broad-family placement and recall alongside it
    // so the report never hides how much compile-time ambiguity exists.
    const semanticMissing = totals.exactPlacement.accountedNotShown +
        totals.exactPlacement.missingBeyondText +
        totals.exactPlacement.missingUnexplained;
    const semanticEligible = Math.max(0,
        totals.exactOracleCallEdges - totals.exactPlacement.missingExplained);
    const semanticRecall = semanticEligible > 0 ? rate(semanticEligible - semanticMissing, semanticEligible) : 1;
    const allOracleCalleeSemanticMissing =
        calleeTotals.placement.confirmedOtherDef +
        calleeTotals.placement.accounted +
        calleeTotals.placement.missingBeyondText +
        calleeTotals.placement.missingUnexplained;
    const calleeSemanticMissing = calleeTotals.exactPlacement.confirmedOtherDef +
        calleeTotals.exactPlacement.accounted +
        calleeTotals.exactPlacement.missingBeyondText +
        calleeTotals.exactPlacement.missingUnexplained;
    const calleePlacementTotal = Object.values(
        calleeTotals.exactPlacement).reduce((a, b) => a + b, 0);
    const calleeSemanticEligible = Math.max(0, calleePlacementTotal -
        calleeTotals.exactPlacement.moduleLevel -
        calleeTotals.exactPlacement.missingExplained);
    const calleeSemanticRecall = calleeSemanticEligible > 0
        ? rate(calleeSemanticEligible - calleeSemanticMissing, calleeSemanticEligible) : 1;
    const reviewBurden = summarizeReviewBurden({
        symbols: perSymbol,
        oracleCallEdges: totals.oracleCallEdges,
        placement: totals.placement,
        exactOracleCallEdges: totals.exactOracleCallEdges,
        exactPlacement: totals.exactPlacement,
        runtimeOracleCallEdges: totals.runtimeOracleCallEdges,
        compileTimeOracleCallEdges: totals.compileTimeOracleCallEdges,
        unresolvedOracleCallEdges: totals.unresolvedOracleCallEdges,
        unverifiedEdges: totals.unverifiedEdges,
        unverifiedHits: totals.unverifiedHits,
        unverifiedUnscored: totals.unverifiedUnscored,
    });
    const byKindSummary = {};
    for (const [kind, kt] of byKind) {
        if (kt.sampled === 0) continue;
        const confirmedScored = kt.confirmedEdges - kt.confirmedUnscored;
        const unverifiedScored = kt.unverifiedEdges - kt.unverifiedUnscored;
        const p1 = rate(kt.confirmedHits, confirmedScored);
        const pu = rate(kt.unverifiedHits, unverifiedScored);
        const kindReviewBurden = summarizeReviewBurden({
            symbols: perSymbol.filter(symbol => symbol.kind === kind),
            oracleCallEdges: kt.oracleCallEdges,
            placement: kt.placement,
            exactOracleCallEdges: kt.exactOracleCallEdges,
            exactPlacement: kt.exactPlacement,
            runtimeOracleCallEdges: kt.runtimeOracleCallEdges,
            compileTimeOracleCallEdges: kt.compileTimeOracleCallEdges,
            unresolvedOracleCallEdges: kt.unresolvedOracleCallEdges,
            unverifiedEdges: kt.unverifiedEdges,
            unverifiedHits: kt.unverifiedHits,
            unverifiedUnscored: kt.unverifiedUnscored,
        });
        byKindSummary[kind] = {
            sampled: kt.sampled,
            oracleCallEdges: kt.oracleCallEdges,
            exactOracleCallEdges: kt.exactOracleCallEdges,
            runtimeOracleCallEdges: kt.runtimeOracleCallEdges,
            compileTimeOracleCallEdges: kt.compileTimeOracleCallEdges,
            unresolvedOracleCallEdges: kt.unresolvedOracleCallEdges,
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
            exactOraclePlacement: kt.exactPlacement,
            reviewBurden: kindReviewBurden,
            unverifiedReasons: finalizeReasonStats(kt.unverifiedReasons),
        };
    }
    const summary = {
        repo: repo.name,
        oracle: oracle.name,
        ...(handle?.definitionLookupWeak && { definitionLookupWeak: true }),
        ...(Number.isFinite(handle?.definitionUnresolvedRatioCeiling) && {
            definitionUnresolvedRatioCeiling: handle.definitionUnresolvedRatioCeiling,
        }),
        commit: repo.commit,
        indexedFiles: indexedFiles.size,
        sampled: sampled.length,
        evaluated: totals.evaluated,
        errors: perSymbol.filter(s => s.error).length,
        oracleCallEdges: totals.oracleCallEdges,
        exactOracleCallEdges: totals.exactOracleCallEdges,
        runtimeOracleCallEdges: totals.runtimeOracleCallEdges,
        compileTimeOracleCallEdges: totals.compileTimeOracleCallEdges,
        unresolvedOracleCallEdges: totals.unresolvedOracleCallEdges,
        confirmedEdges: totals.confirmedEdges,
        confirmedScoredEdges: tier1ScoredEdges,
        confirmedUnscored: totals.confirmedUnscored,
        confirmedHits: totals.confirmedHits,
        tier1Precision,
        confirmedFalsePositiveSamples,
        confirmedUnscoredSamples,
        unverifiedPrecision,
        unverifiedEdges: totals.unverifiedEdges,
        unverifiedScoredEdges,
        unverifiedUnscored: totals.unverifiedUnscored,
        unverifiedUnscoredSamples,
        unverifiedHits: totals.unverifiedHits,
        unverifiedReasons: finalizeReasonStats(totals.unverifiedReasons),
        reviewBurden,
        tierSeparation: tier1ScoredEdges && unverifiedScoredEdges
            ? Number((tier1Precision - unverifiedPrecision).toFixed(4)) : null,
        oraclePlacement: totals.placement,
        exactOraclePlacement: totals.exactPlacement,
        byKind: byKindSummary,
        // Strict semantic-recall gate. Conservation alone is necessary but
        // insufficient: every compiler-exact edge must be shown to the agent.
        semanticRecall,
        semanticMissing,
        missingUnexplained: totals.exactPlacement.missingUnexplained,
        // All-class hard floor (fix #292): an oracle edge UCN neither showed
        // nor accounted for is a conservation lie regardless of its dispatch
        // class — gated at 0 alongside the exact gate. Likewise a compiler-
        // attested may-dispatch edge the engine EXCLUDED with reason violates
        // demote-only physics (possible-dispatch is visible, never excluded).
        allOracleMissingUnexplained: totals.placement.missingUnexplained,
        runtimeDispatchAccountedNotShown:
            totals.runtimeDispatchAccountedNotShown,
        runtimeDispatchNotShownSamples,
        unexplainedSamples,
        semanticMissingSamples,
        allOracleSemanticRecall,
        allOracleSemanticMissing,
        allOracleSemanticMissingSamples,
        observedZeroAgreement: totals.zeroCases ? rate(totals.zeroAgreed, totals.zeroCases) : null,
        zeroCases: totals.zeroCases,
        conservedRate: rate(totals.conserved, totals.evaluated),
        // Callee arm (trace-down contract)
        calleePrecision: rate(calleeTotals.hits, calleeTotals.sites),
        definitionValidatedConfirmed,
        definitionValidatedUnverified,
        definitionValidatedOracleCalls,
        definitionUnresolvedReferenceEdges,
        definitionAdjudicationUniverse: definitionValidatedOracleCalls +
            definitionUnresolvedReferenceEdges + oracleBroadReferenceEdges,
        definitionLookupErrors,
        oracleBroadReferenceEdges,
        configurationGatedUnscored,
        confirmedConfigurationUnscored,
        confirmedAbstentionUnscored,
        unverifiedConfigurationUnscored,
        unverifiedAbstentionUnscored,
        sourceStatusErrors,
        calleeUnscoredSites,
        calleeFalsePositiveSamples,
        calleeSites: calleeTotals.sites,
        calleeHits: calleeTotals.hits,
        calleePlacement: calleeTotals.placement,
        exactCalleePlacement: calleeTotals.exactPlacement,
        calleeSemanticRecall,
        calleeSemanticMissing,
        allOracleCalleeSemanticMissing,
        calleeMissingUnexplained:
            calleeTotals.exactPlacement.missingUnexplained,
        calleeAllOracleMissingUnexplained:
            calleeTotals.placement.missingUnexplained,
        calleeUnexplainedSamples,
        calleeSemanticMissingSamples,
        commandProof,
    };

    process.stdout.write(`  tier1Precision ${pct(summary.tier1Precision)} | unverifiedPrecision ${pct(summary.unverifiedPrecision)} | ` +
        `tierSeparation ${summary.tierSeparation ?? 'n/a'} | exact placement ${JSON.stringify(summary.exactOraclePlacement)} | ` +
        `semanticRecall ${pct(summary.semanticRecall)} (${summary.semanticMissing} missing) | ` +
        `observedZeroAgreement ${summary.observedZeroAgreement != null ? pct(summary.observedZeroAgreement) : 'n/a'} (${summary.zeroCases} cases) | ` +
        `conserved ${pct(summary.conservedRate)}\n`);
    process.stdout.write(`  review burden: exact true-edge unverified ${pct(reviewBurden.trueEdgeUnverifiedRate)} | ` +
        `all oracle-edge unverified ${pct(reviewBurden.allOracleEdgeUnverifiedRate)} | ` +
        `zero-actionable-ambiguity targets ${pct(reviewBurden.zeroActionableUnverifiedTargetRate)} | ` +
        `actionable candidates p50/p95/max ${reviewBurden.actionableUnverifiedCandidatesP50}/${reviewBurden.actionableUnverifiedCandidatesP95}/${reviewBurden.actionableUnverifiedCandidatesMax} | ` +
        `runtime dispatch ${reviewBurden.runtimeDispatchSites} sites/${reviewBurden.runtimeDispatchGroups} families ` +
        `(${reviewBurden.runtimeDependentOracleEdges} oracle edges) | ` +
        `compile-time dispatch ${reviewBurden.compileTimeDispatchSites} sites/${reviewBurden.compileTimeDispatchGroups} families ` +
        `(${reviewBurden.compilerDependentOracleEdges} oracle edges) | ` +
        `oracle abstentions ${reviewBurden.oracleAbstentionEdges} edges | ` +
        `effective review items/oracle-edge ${reviewBurden.unverifiedReviewItemsPerOracleEdge} ` +
        `(${reviewBurden.unverifiedReviewItems}; raw false candidates ` +
        `${reviewBurden.rawFalseUnverifiedCandidates})\n`);
    const topReasons = Object.entries(summary.unverifiedReasons).slice(0, 5)
        .map(([reason, row]) => `${reason}:${row.candidates}`).join(', ');
    if (topReasons) process.stdout.write(`  unverified reasons: ${topReasons}\n`);
    for (const [kind, k] of Object.entries(summary.byKind)) {
        process.stdout.write(`    ${kind.padEnd(8)} n=${k.sampled} | tier1 ${k.confirmedScored ? pct(k.tier1Precision) : 'n/a'} (${k.confirmedHits}/${k.confirmedScored} scored; ${k.confirmedUnscored} cfg-unscored) | ` +
            `unverified ${k.unverifiedScored ? pct(k.unverifiedPrecision) : 'n/a'} (${k.unverifiedHits}/${k.unverifiedScored} scored; ${k.unverifiedUnscored} cfg-unscored) | ` +
            `placement ${JSON.stringify(k.oraclePlacement)}\n`);
    }
        process.stdout.write(`  callee arm: precision ${pct(summary.calleePrecision)} (${summary.calleeHits}/${summary.calleeSites}) | ` +
            `semanticRecall ${pct(summary.calleeSemanticRecall)} (${summary.calleeSemanticMissing} missing) | ` +
            `exact placement ${JSON.stringify(summary.exactCalleePlacement)}\n`);
    const commandCells = PROOF_COMMANDS.map(command =>
        `${command} ${pct(summary.commandProof[command].recall)}`);
    process.stdout.write(`  public command arm: ${commandCells.join(' | ')} | ` +
        `failures ${summary.commandProof.failures}\n`);
    if (typeof oracle.resolveDefinition === 'function') {
        process.stdout.write(`  definition adjudication: confirmed ${summary.definitionValidatedConfirmed}, ` +
            `unverified ${summary.definitionValidatedUnverified}, oracle calls ${summary.definitionValidatedOracleCalls} | ` +
            `broad-family refs excluded ${summary.oracleBroadReferenceEdges} | ` +
            `unresolved ${summary.definitionUnresolvedReferenceEdges} | errors ${summary.definitionLookupErrors}\n`);
    }
    if (typeof oracle.isConfigurationGated === 'function' || handle?.definitionLookupWeak) {
        process.stdout.write(`  oracle coverage: ` +
            `${summary.confirmedConfigurationUnscored + summary.confirmedAbstentionUnscored} confirmed edge(s) unscored ` +
            `(${summary.confirmedConfigurationUnscored} configuration, ` +
            `${summary.confirmedAbstentionUnscored} definition-unresolved), ` +
            `${summary.unverifiedConfigurationUnscored + summary.unverifiedAbstentionUnscored} unverified edge(s) unscored ` +
            `(${summary.unverifiedConfigurationUnscored} configuration, ` +
            `${summary.unverifiedAbstentionUnscored} definition-unresolved), ` +
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

function dedupe(edges, includeColumn = false) {
    const seen = new Set();
    return edges.filter(e => {
        const k = includeColumn
            ? `${key(e.file, e.line)}:${e.column ?? '*'}`
            : key(e.file, e.line);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

function camel(s) { return s; }
function rate(n, d) { return d ? Number((n / d).toFixed(4)) : 0; }
function pct(x) { return `${(x * 100).toFixed(1)}%`; }

async function main() {
    if (freshCount && releaseOnly) {
        throw new Error('--release and --fresh cannot be combined');
    }
    const baseRepos = freshCount
        ? selectFreshRepos(freshCount)
        : (releaseOnly ? RELEASE_REPOS : REPOS);
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
            result.schemaVersion = 4;
            result.generatedAt = new Date().toISOString();
            result.reviewBudgets = reviewBudgets;
            results.push(result);
            if (result.summary.errors > 0 || result.summary.evaluated !== result.summary.sampled) {
                process.stdout.write(`  ⚠ EXECUTION-COMPLETENESS GATE FAILURE: evaluated ${result.summary.evaluated}/${result.summary.sampled}, errors ${result.summary.errors}\n`);
                gateFailed = true;
            }
            if (result.summary.semanticMissing > 0) gateFailed = true;
            if (result.summary.calleeSemanticMissing > 0) gateFailed = true;
            // All-class floors (fix #292): unaccounted edges and excluded
            // may-dispatch edges gate at 0 regardless of uncertainty class.
            if (result.summary.allOracleMissingUnexplained > 0) {
                process.stdout.write(`  ⚠ GATE FAILURE: ${result.summary.allOracleMissingUnexplained} non-exact oracle call edge(s) unexplained\n`);
                gateFailed = true;
            }
            if (result.summary.calleeAllOracleMissingUnexplained > 0) {
                process.stdout.write(`  ⚠ GATE FAILURE: ${result.summary.calleeAllOracleMissingUnexplained} non-exact callee edge(s) unexplained\n`);
                gateFailed = true;
            }
            if (result.summary.runtimeDispatchAccountedNotShown > 0) {
                process.stdout.write(`  ⚠ GATE FAILURE: ${result.summary.runtimeDispatchAccountedNotShown} runtime-dispatch oracle edge(s) excluded-with-reason: ${JSON.stringify((result.summary.runtimeDispatchNotShownSamples || []).slice(0, 3))}\n`);
                gateFailed = true;
            }
            if (result.summary.definitionLookupErrors > 0) gateFailed = true;
            if (result.summary.sourceStatusErrors > 0) gateFailed = true;
            if (result.summary.commandProof.failures > 0) gateFailed = true;
            const coverageGate = evaluateOracleCoverage(result.summary, maxUnscoredRatio);
            result.summary.precisionUnscoredRatio = Number(coverageGate.precisionUnscoredRatio.toFixed(4));
            result.summary.precisionConfigGatedRatio = Number(
                coverageGate.precisionConfigGatedRatio.toFixed(4));
            result.summary.precisionAbstentionRatio = Number(
                coverageGate.precisionAbstentionRatio.toFixed(4));
            result.summary.unverifiedUnscoredRatio = Number(
                coverageGate.unverifiedUnscoredRatio.toFixed(4));
            result.summary.calleeUnscoredRatio = Number(coverageGate.calleeUnscoredRatio.toFixed(4));
            result.summary.definitionUnresolvedRatio = Number(
                coverageGate.definitionUnresolvedRatio.toFixed(4));
            if (coverageGate.failures.length > 0) {
                process.stdout.write(`  ⚠ ORACLE COVERAGE GATE FAILURE: ${coverageGate.failures.join('; ')}\n`);
                gateFailed = true;
            }
            const reviewGate = evaluateReviewBurden(
                result.summary.reviewBurden, reviewBudgets, repo.name);
            const kindReviewFailures = [];
            if (reviewBudgets?.maxKindTrueEdgeUnverifiedRate != null) {
                for (const [kind, kindSummary] of Object.entries(result.summary.byKind || {})) {
                    const burden = kindSummary.reviewBurden;
                    const minEdges = reviewBudgets.minKindOracleEdges || 0;
                    if (!burden || burden.semanticEligibleEdges < minEdges) continue;
                    const verdict = evaluateReviewBurden(burden, {
                        maxTrueEdgeUnverifiedRate:
                            reviewBudgets.maxKindTrueEdgeUnverifiedRate,
                    }, `${repo.name}/${kind}`);
                    kindReviewFailures.push(...verdict.failures);
                }
            }
            const reviewFailures = [...reviewGate.failures, ...kindReviewFailures];
            if (reviewFailures.length > 0) {
                process.stdout.write(`  ⚠ REVIEW-BURDEN GATE FAILURE: ${reviewFailures.join('; ')}\n`);
                gateFailed = true;
            }
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

    // A dated rollup describes the DATE's board, not the last invocation —
    // per-repo runs used to clobber the .md down to a single row (the
    // documented release-report hazard, realized on 2026-07-20). Merge this
    // run's results over every same-dated per-repo JSON on disk so the
    // committed rollup always carries the full board; the exit gate stays
    // scoped to the CURRENT run's repos.
    const rollupByRepo = new Map();
    const perRepoSuffix = `-${date}${seedSuffix}.json`;
    for (const f of fs.readdirSync(REPORTS_DIR)) {
        if (!f.startsWith('oracle-eval-') || !f.endsWith(perRepoSuffix) ||
            f.includes('rollup')) continue;
        try {
            const prior = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
            if (prior?.summary?.repo) rollupByRepo.set(prior.summary.repo, prior);
        } catch { /* partial/unreadable file — this run's rows still land */ }
    }
    for (const r of results) if (r?.summary?.repo) rollupByRepo.set(r.summary.repo, r);
    const rollupResults = [...rollupByRepo.values()].sort((a, b) =>
        a.summary.repo < b.summary.repo ? -1 : a.summary.repo > b.summary.repo ? 1 : 0);
    const generatedAt = new Date().toISOString();
    const rollupPayload = {
        schemaVersion: 4,
        generatedAt,
        board: {
            date,
            sampleSize,
            sampleSeed,
            release: releaseOnly,
            freshCount,
            seedSuffix,
            repositories: rollupResults.map(result => result.summary.repo),
        },
        reviewBudgets,
        results: rollupResults,
    };
    const rollupJsonPath = path.join(
        REPORTS_DIR, `oracle-eval-rollup-${date}${seedSuffix}.json`);
    fs.writeFileSync(rollupJsonPath, JSON.stringify(rollupPayload, null, 2));

    const lines = [
        `# Oracle eval: ${date}${freshCount ? ' (fresh-repo arm: unpinned rotation)' : ''}`,
        '',
        'UCN tiered caller answers scored against compiler/LSP ground truth.',
        '`semantic-missing` is the release gate: every indexed, in-scope oracle',
        'call edge must appear in CONFIRMED or UNVERIFIED. Merely conserving it',
        'inside a non-call/excluded count is not enough. Target: 0.',
        '',
        '| repo | oracle | sampled | oracle edges | tier1 precision | semantic recall | semantic missing | unverified precision | observed-zero agreement | conserved |',
        '|---|---|---|---|---|---|---|---|---|---|',
    ];
    for (const { summary: s } of rollupResults) {
        if (s.error) { lines.push(`| ${s.repo} | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | ERROR: ${s.error} |`); continue; }
        lines.push(`| ${s.repo} | ${s.oracle} | ${s.sampled} | ${s.oracleCallEdges} | ${pct(s.tier1Precision)} | ${pct(s.semanticRecall)} | **${s.semanticMissing}** | ${pct(s.unverifiedPrecision)} | ${s.observedZeroAgreement != null ? pct(s.observedZeroAgreement) : 'n/a'} (${s.zeroCases}) | ${pct(s.conservedRate)} |`);
    }
    lines.push('');
    lines.push('## Unverified review burden');
    lines.push('');
    lines.push('Recall is not enough when an agent must inspect a large abstention band.');
    lines.push('This board measures how much candidate review remains, how often a pinned');
    lines.push('target has no actionable ambiguity, and how many effective review items');
    lines.push('the engine creates. Actionable false candidates count individually; named');
    lines.push('runtime-dispatch and compiler-dependent template families count once because');
    lines.push('that is how agents receive them. Exact, runtime-dependent, compiler-dependent,');
    lines.push('and oracle-unresolved edges remain separate, so a may-reach result or oracle');
    lines.push('abstention is never called exact.');
    lines.push('Raw candidates and raw false counts remain visible. Configuration-unscored');
    lines.push('candidates stay visible but are not labeled false.');
    lines.push('');
    lines.push('| repo | exact true-edge unverified | all oracle-edge unverified | zero actionable ambiguity | actionable p50/p95/max | runtime sites/families | compile-time sites/families | compiler-dependent oracle edges | oracle abstentions | raw unverified | raw false | effective review items | items/oracle edge | top reasons |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const { summary: s } of rollupResults) {
        if (s.error) continue;
        const b = s.reviewBurden;
        if (!b) {
            lines.push(`| ${s.repo} | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | report predates schema v4 |`);
            continue;
        }
        const reasons = Object.entries(s.unverifiedReasons || {}).slice(0, 3)
            .map(([reason, row]) => `${reason} (${row.candidates})`).join(', ') || 'none';
        lines.push(`| ${s.repo} | ${pct(b.trueEdgeUnverifiedRate)} (${b.trueEdgesUnverified}/${b.exactSemanticEligibleEdges}) | ${pct(b.allOracleEdgeUnverifiedRate)} (${b.allOracleEdgesUnverified}/${b.semanticEligibleEdges}) | ${pct(b.zeroActionableUnverifiedTargetRate)} (${b.zeroActionableUnverifiedTargets}/${b.reviewedSymbols}) | ${b.actionableUnverifiedCandidatesP50}/${b.actionableUnverifiedCandidatesP95}/${b.actionableUnverifiedCandidatesMax} | ${b.runtimeDispatchSites}/${b.runtimeDispatchGroups} | ${b.compileTimeDispatchSites}/${b.compileTimeDispatchGroups} | ${b.compilerDependentOracleEdges} | ${b.oracleAbstentionEdges} | ${b.unverifiedCandidates} | ${b.rawFalseUnverifiedCandidates} | ${b.unverifiedReviewItems} | ${b.unverifiedReviewItemsPerOracleEdge} | ${reasons} |`);
    }
    lines.push('');
    lines.push('## Oracle-backed command surface');
    lines.push('');
    lines.push('The sampled compiler/LSP symbols and references gate only commands an agent');
    lines.push('can invoke on the v5 public surface: exact `find`, composed `show`, exact');
    lines.push('`source`, caller `trace`, symbol `impact`, literal reference recall in');
    lines.push('`usages`, and direct test-reference recall in `tests`. Removed internal');
    lines.push('commands cannot make this gate pass. Command execution errors are failures.');
    lines.push('');
    lines.push(`| repo | evaluated | ${PROOF_COMMANDS.join(' | ')} | execution errors | failures |`);
    lines.push(`|---|---:|${PROOF_COMMANDS.map(() => '---:').join('|')}|---:|---:|`);
    for (const { summary: s } of rollupResults) {
        if (s.error || !s.commandProof) continue;
        const c = s.commandProof;
        const cell = m => `${pct(m.recall)} (${m.hits}/${m.eligible})`;
        lines.push(`| ${s.repo} | ${s.evaluated}/${s.sampled} | ` +
            `${PROOF_COMMANDS.map(command => cell(c[command])).join(' | ')} | ` +
            `**${c.executionErrors}** | **${c.failures}** |`);
    }
    lines.push('');
    lines.push('## Per-kind breakdown');
    lines.push('');
    lines.push('Same metrics split by symbol kind (function / method / class), to');
    lines.push('localize precision gaps, such as method-name conflation where import');
    lines.push('evidence confirms the file but not the receiver type.');
    lines.push('');
    lines.push('| repo | kind | sampled | oracle edges | tier1 precision | tier1 cfg-unscored | unverified precision | unverified cfg-unscored | separation | placement |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const { summary: s } of rollupResults) {
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
    lines.push('(findCallees collectAccount, the trace-down engine path) must show');
    lines.push('the exact site as confirmed or unverified. Account-only and');
    lines.push('same-name-other-definition placements are semantic misses unless');
    lines.push('exact definition lookup proves the reference search expanded a');
    lines.push('virtual-method family and UCN selected the actual static target.');
    lines.push('');
    lines.push('| repo | callee precision | semantic recall | semantic missing | confirmed | oracle-broad | other-def | unverified | unverified+other | accounted | module-level | beyond-text |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const { summary: s } of rollupResults) {
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
    for (const { summary: s } of rollupResults) {
        if (s.error) continue;
        lines.push(`| ${s.repo} | ${s.definitionValidatedConfirmed} | ${s.definitionValidatedUnverified} | ${s.definitionValidatedOracleCalls} | ${s.oracleBroadReferenceEdges} | ${s.definitionUnresolvedReferenceEdges} | **${s.definitionLookupErrors}** | ${s.configurationGatedUnscored} | ${s.calleeUnscoredSites} | **${s.sourceStatusErrors}** |`);
    }
    lines.push('');
    const mdPath = path.join(REPORTS_DIR, `oracle-eval-rollup-${date}${seedSuffix}.md`);
    fs.writeFileSync(mdPath, lines.join('\n'));
    process.stdout.write(`\nwrote ${path.relative(process.cwd(), rollupJsonPath)}\n`);
    process.stdout.write(`wrote ${path.relative(process.cwd(), mdPath)}\n`);

    process.exit(gateFailed ? 1 : 0);
}

main();
