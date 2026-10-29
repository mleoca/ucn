'use strict';

const PORTABLE_AST_REVIEW_BUDGETS = Object.freeze({
    maxTrueEdgeUnverifiedRate: 0.10,
    maxKindTrueEdgeUnverifiedRate: 0.20,
    minKindOracleEdges: 20,
    minZeroUnverifiedTargetRate: 0.80,
    maxUnverifiedCandidatesP95: 5,
    maxUnverifiedReviewItemsPerOracleEdge: 0.10,
});

function optionalRate(raw, flag) {
    if (raw == null) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`${flag} must be a number from 0 to 1 (got ${raw})`);
    }
    return value;
}

function optionalNonNegative(raw, flag, integer = false) {
    if (raw == null) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
        const kind = integer ? 'a non-negative integer' : 'a non-negative number';
        throw new Error(`${flag} must be ${kind} (got ${raw})`);
    }
    return value;
}

function rate(numerator, denominator) {
    return denominator > 0 ? numerator / denominator : 0;
}

function roundedRate(numerator, denominator) {
    return Number(rate(numerator, denominator).toFixed(4));
}

function percentile(values, fraction) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

/**
 * Convert per-symbol candidate counts and aggregate oracle placement into the
 * review burden an agent actually experiences. A named runtime-dispatch
 * boundary is reported separately from actionable ambiguity: the agent knows
 * why the edge exists and raw candidates remain fully scored. Configuration-
 * unscored candidates are reported but are not called false positives.
 */
function summarizeReviewBurden({
    symbols = [],
    oracleCallEdges = 0,
    placement = {},
    exactOracleCallEdges = oracleCallEdges,
    exactPlacement = placement,
    runtimeOracleCallEdges = 0,
    compileTimeOracleCallEdges = 0,
    unresolvedOracleCallEdges = 0,
    unverifiedEdges = 0,
    unverifiedHits = 0,
    unverifiedUnscored = 0,
} = {}) {
    const validSymbols = symbols.filter(symbol => symbol && !symbol.error);
    const counts = validSymbols
        .map(symbol => Number(symbol.actionableUnverified) || 0);
    const reviewedSymbols = counts.length;
    const zeroActionableUnverifiedTargets =
        counts.filter(count => count === 0).length;
    const runtimeDispatchSites = validSymbols.reduce((sum, symbol) =>
        sum + (Number(symbol?.runtimeDispatchSites) || 0), 0);
    const runtimeDispatchGroups = validSymbols.reduce((sum, symbol) =>
        sum + (Number(symbol?.runtimeDispatchGroups) || 0), 0);
    const compileTimeDispatchSites = validSymbols.reduce((sum, symbol) =>
        sum + (Number(symbol?.compileTimeDispatchSites) || 0), 0);
    const compileTimeDispatchGroups = validSymbols.reduce((sum, symbol) =>
        sum + (Number(symbol?.compileTimeDispatchGroups) || 0), 0);
    const actionableUnverifiedCandidates = counts.reduce(
        (sum, count) => sum + count, 0);
    const actionableUnverifiedHits = validSymbols.reduce((sum, symbol) =>
        sum + (Number(symbol?.actionableUnverifiedHits) || 0), 0);
    const actionableUnverifiedUnscored = validSymbols.reduce((sum, symbol) =>
        sum + (Number(symbol?.actionableUnverifiedUnscored) || 0), 0);
    const actionableUnverifiedScored = Math.max(0,
        actionableUnverifiedCandidates - actionableUnverifiedUnscored);
    const actionableFalseUnverifiedCandidates = Math.max(0,
        actionableUnverifiedScored - actionableUnverifiedHits);
    const semanticEligibleEdges = Math.max(0,
        oracleCallEdges - (placement.missingExplained || 0) - (placement.configurationGated || 0));
    // Runtime polymorphism and compiler-dependent templates both identify a
    // family that MAY reach the target, not one statically exact definition.
    // Keep those edges in semantic recall, but do not mislabel them as exact
    // target identity. Each family remains visible and separately charged.
    const exactSemanticEligibleEdges = Math.max(0,
        exactOracleCallEdges - (exactPlacement.missingExplained || 0) -
            (exactPlacement.configurationGated || 0));
    const nonExactOracleEdges = Math.max(0,
        semanticEligibleEdges - exactSemanticEligibleEdges);
    const runtimeDependentOracleEdges = Math.min(
        nonExactOracleEdges, Math.max(0, runtimeOracleCallEdges));
    const compilerDependentOracleEdges = Math.min(
        Math.max(0, nonExactOracleEdges - runtimeDependentOracleEdges),
        Math.max(0, compileTimeOracleCallEdges));
    const oracleAbstentionEdges = Math.min(
        Math.max(0, nonExactOracleEdges - runtimeDependentOracleEdges -
            compilerDependentOracleEdges),
        Math.max(0, unresolvedOracleCallEdges));
    const trueEdgesUnverified = exactPlacement.unverified || 0;
    const allOracleEdgesUnverified = placement.unverified || 0;
    const unverifiedScoredEdges = Math.max(0, unverifiedEdges - unverifiedUnscored);
    const rawFalseUnverifiedCandidates = Math.max(0,
        unverifiedScoredEdges - unverifiedHits);
    // Runtime-dispatch sites are rendered as named families. An agent reviews
    // one boundary explanation, not every raw implementation candidate.
    // Charge every family once (conservative even when it contains a true
    // edge), while actionable ambiguities remain candidate-by-candidate.
    const unverifiedReviewItems = actionableFalseUnverifiedCandidates +
        runtimeDispatchGroups + compileTimeDispatchGroups;

    return {
        reviewedSymbols,
        zeroActionableUnverifiedTargets,
        zeroActionableUnverifiedTargetRate: reviewedSymbols > 0
            ? roundedRate(zeroActionableUnverifiedTargets, reviewedSymbols) : 1,
        actionableUnverifiedCandidatesP50: percentile(counts, 0.50),
        actionableUnverifiedCandidatesP95: percentile(counts, 0.95),
        actionableUnverifiedCandidatesMax:
            counts.length ? Math.max(...counts) : 0,
        actionableUnverifiedCandidates,
        actionableUnverifiedScored,
        actionableUnverifiedUnscored,
        actionableUnverifiedHits,
        actionableFalseUnverifiedCandidates,
        runtimeDispatchSites,
        runtimeDispatchGroups,
        runtimeDispatchReviewItems: runtimeDispatchGroups,
        compileTimeDispatchSites,
        compileTimeDispatchGroups,
        compileTimeDispatchReviewItems: compileTimeDispatchGroups,
        semanticEligibleEdges,
        exactSemanticEligibleEdges,
        nonExactOracleEdges,
        runtimeDependentOracleEdges,
        compilerDependentOracleEdges,
        oracleAbstentionEdges,
        trueEdgesUnverified,
        trueEdgeUnverifiedRate: roundedRate(
            trueEdgesUnverified, exactSemanticEligibleEdges),
        allOracleEdgesUnverified,
        allOracleEdgeUnverifiedRate: roundedRate(
            allOracleEdgesUnverified, semanticEligibleEdges),
        unverifiedCandidates: unverifiedEdges,
        unverifiedScoredEdges,
        unverifiedUnscored,
        unverifiedHits,
        unverifiedPrecision: unverifiedScoredEdges > 0
            ? roundedRate(unverifiedHits, unverifiedScoredEdges) : null,
        rawFalseUnverifiedCandidates,
        rawFalseUnverifiedPerOracleEdge: roundedRate(
            rawFalseUnverifiedCandidates, semanticEligibleEdges),
        unverifiedReviewItems,
        unverifiedReviewItemsPerOracleEdge: roundedRate(
            unverifiedReviewItems, semanticEligibleEdges),
        unverifiedCandidatesPerOracleEdge: roundedRate(
            unverifiedEdges, semanticEligibleEdges),
    };
}

function evaluateReviewBurden(metrics, budgets, label = 'review burden') {
    const failures = [];
    if (!budgets) return { failures };

    const maxChecks = [
        ['trueEdgeUnverifiedRate', budgets.maxTrueEdgeUnverifiedRate,
            'true-edge unverified rate', true],
        ['actionableUnverifiedCandidatesP95', budgets.maxUnverifiedCandidatesP95,
            'actionable unverified candidates p95', false],
        ['unverifiedReviewItemsPerOracleEdge',
            budgets.maxUnverifiedReviewItemsPerOracleEdge,
            'unverified review items per oracle edge', false],
    ];
    for (const [field, ceiling, description, percentage] of maxChecks) {
        if (ceiling == null) continue;
        const value = metrics[field];
        if (!Number.isFinite(value)) {
            failures.push(`${label} ${description} is missing`);
        } else if (value > ceiling) {
            const shownValue = percentage ? `${(value * 100).toFixed(2)}%` : value;
            const shownCeiling = percentage ? `${(ceiling * 100).toFixed(2)}%` : ceiling;
            failures.push(`${label} ${description} ${shownValue} > ${shownCeiling}`);
        }
    }

    const floor = budgets.minZeroUnverifiedTargetRate;
    if (floor != null) {
        const value = metrics.zeroActionableUnverifiedTargetRate;
        if (!Number.isFinite(value)) {
            failures.push(`${label} zero-actionable-ambiguity target rate is missing`);
        } else if (value < floor) {
            failures.push(`${label} zero-actionable-ambiguity target rate ${(value * 100).toFixed(2)}% ` +
                `< ${(floor * 100).toFixed(2)}%`);
        }
    }

    return { failures };
}

/**
 * Compiler/LSP configuration can legitimately hide platform-gated code, but
 * it must not silently shrink the precision denominator enough to make the
 * release board look stronger than the evidence supports.
 */
function evaluateOracleCoverage(summary, maxUnscoredRatio) {
    // The release precision claim is the confirmed tier. Unverified entries
    // are an explicit abstention band and do not enter tier1Precision, so
    // configuration-gated abstentions must not dilute the coverage of the
    // claim being gated. Report their coverage separately for transparency.
    const precisionUniverse = summary.confirmedEdges || 0;
    const precisionUnscoredRatio = rate(summary.confirmedUnscored || 0, precisionUniverse);
    // Two classes hide in confirmedUnscored (fix #286g, flask-measured: 100%
    // of the 27.85% "configuration-unscored" band was definition-unresolved
    // — pyright cannot type pytest-fixture receivers that single-owner
    // physics correctly confirms). True configuration gating (the oracle's
    // own projection leaves the line or the target out) keeps the hard
    // bound; oracle ABSTENTION (analyzed but unresolved, or a construct the
    // oracle cannot report, see unscoredProng) gets a looser 3x ceiling —
    // intrinsic to fixture-heavy dynamic code, but a runaway still fails
    // loudly.
    const precisionAbstentionUnscored = summary.confirmedAbstentionUnscored || 0;
    const precisionConfigGatedRatio = rate(
        Math.max(0, (summary.confirmedUnscored || 0) - precisionAbstentionUnscored),
        precisionUniverse);
    const precisionAbstentionRatio = rate(precisionAbstentionUnscored, precisionUniverse);
    const unverifiedUniverse = summary.unverifiedEdges || 0;
    const unverifiedUnscoredRatio = rate(summary.unverifiedUnscored || 0, unverifiedUniverse);
    const calleeUniverse = (summary.calleeSites || 0) + (summary.calleeUnscoredSites || 0);
    const calleeUnscoredRatio = rate(summary.calleeUnscoredSites || 0, calleeUniverse);
    const definitionUniverse = summary.definitionAdjudicationUniverse ||
        ((summary.definitionValidatedOracleCalls || 0) +
            (summary.definitionUnresolvedReferenceEdges || 0) +
            (summary.oracleBroadReferenceEdges || 0));
    const definitionUnresolvedRatio = rate(
        summary.definitionUnresolvedReferenceEdges || 0, definitionUniverse);
    // Oracle edges at lines the oracle's own projection leaves out (fix
    // #429) leave the recall universe; the same hard bound keeps that from
    // shrinking it unnoticed.
    const recallConfigGatedRatio = rate(
        summary.oracleConfigurationGatedEdges || 0, summary.oracleCallEdges || 0);
    const failures = [];
    if (maxUnscoredRatio != null && recallConfigGatedRatio > maxUnscoredRatio) {
        failures.push(`recall configuration-unscored ratio ${(recallConfigGatedRatio * 100).toFixed(2)}% ` +
            `> ${(maxUnscoredRatio * 100).toFixed(2)}%`);
    }

    if (maxUnscoredRatio != null && precisionConfigGatedRatio > maxUnscoredRatio) {
        failures.push(`precision configuration-unscored ratio ${(precisionConfigGatedRatio * 100).toFixed(2)}% ` +
            `> ${(maxUnscoredRatio * 100).toFixed(2)}%`);
    }
    if (maxUnscoredRatio != null && precisionAbstentionRatio > maxUnscoredRatio * 3) {
        failures.push(`precision oracle-abstention ratio ${(precisionAbstentionRatio * 100).toFixed(2)}% ` +
            `> ${(maxUnscoredRatio * 300).toFixed(2)}%`);
    }
    if (maxUnscoredRatio != null && calleeUnscoredRatio > maxUnscoredRatio) {
        failures.push(`callee configuration-unscored ratio ${(calleeUnscoredRatio * 100).toFixed(2)}% ` +
            `> ${(maxUnscoredRatio * 100).toFixed(2)}%`);
    }
    // An oracle that DECLARES weak definition lookup (ts-morph with no
    // tsconfig: plain-JS mode, resolveDefinition often abstains) gets its
    // measured capability ceiling instead of the ordinary hard bound. It is
    // still gated: a completely blind oracle must never produce a green
    // release board (fix #286h).
    const definitionUnresolvedCeiling = summary.definitionLookupWeak
        ? summary.definitionUnresolvedRatioCeiling
        : maxUnscoredRatio;
    if (maxUnscoredRatio != null &&
        (!Number.isFinite(definitionUnresolvedCeiling) ||
            definitionUnresolvedRatio > definitionUnresolvedCeiling)) {
        const ceiling = Number.isFinite(definitionUnresolvedCeiling)
            ? definitionUnresolvedCeiling : maxUnscoredRatio;
        failures.push(`definition-unresolved oracle ratio ${(definitionUnresolvedRatio * 100).toFixed(2)}% ` +
            `> ${(ceiling * 100).toFixed(2)}%`);
    }

    return {
        failures,
        precisionUnscoredRatio,
        precisionConfigGatedRatio,
        precisionAbstentionRatio,
        unverifiedUnscoredRatio,
        calleeUnscoredRatio,
        definitionUnresolvedRatio,
        recallConfigGatedRatio,
    };
}

/**
 * Close a TypeScript overload/declaration surface over its one runtime
 * implementation. The language service commonly resolves calls to an
 * overload signature (or a `declare class` method) while UCN correctly pins
 * the adjacent function body / prototype assignment. They are one callable
 * identity only when file, lexical scope, namespace, and owner agree and the
 * group has exactly one implementation.
 */
function closeJsTsDeclarationIdentity(definitions, target) {
    if (!target) return [];
    const callableKinds = new Set([
        'function', 'method', 'constructor', 'get', 'set',
    ]);
    const sameSlot = (definitions || []).filter(definition =>
        definition.file === target.file &&
        (definition.className || null) === (target.className || null) &&
        (definition.namespace || null) === (target.namespace || null) &&
        (definition.lexicalScopeStartLine || null) ===
            (target.lexicalScopeStartLine || null) &&
        (definition.lexicalScopeEndLine || null) ===
            (target.lexicalScopeEndLine || null) &&
        (definition.isSignature || definition.memberAssigned ||
            callableKinds.has(definition.type)));
    const signatures = sameSlot.filter(definition => definition.isSignature);
    const implementations = sameSlot.filter(definition => !definition.isSignature);
    if (signatures.length === 0 || implementations.length !== 1 ||
        !sameSlot.includes(target)) {
        return [target];
    }
    return sameSlot;
}

/**
 * Deferred adjudication verdict for an oracle-unresolved call reference the
 * engine did NOT show (fix #286d, refined by #292). The oracle's reference
 * search could not bind the site; its exact definition lookup at the site
 * decides:
 *   'target'      → keep, gate-bearing: a positive pin is compiler-grade
 *                   identity, so the engine genuinely missed a true edge.
 *   'other'       → drop: a broad-family reference to a different definition.
 *   'unresolved'  → drop as a measured oracle abstention — never punish the
 *                   engine for excluding a site the oracle cannot pin.
 *   'unavailable' → keep, report-only: the oracle has no definition lookup
 *                   at all, so the edge stays loud in placement without
 *                   hard-gating on a weak oracle's name-match references.
 */
/**
 * The coverage prong an unscored edge verdict belongs to (fix #406). Only
 * 'configuration-gated' — the oracle's own projection leaves out the call
 * line or the target definition — is configuration; every other class is an
 * oracle abstention on code it analyzes ('definition-unresolved', or
 * 'macro-template-expansion': a macro_rules! transcriber's call the oracle
 * cannot expand or resolve). rand-measured: 80 confirmed template edges were
 * counted as configuration because anything not 'definition-unresolved'
 * fell into that prong. A verdict without a class is a harness bug.
 */
function unscoredProng(verdict) {
    if (!verdict || verdict.scorable) return null;
    if (!verdict.abstention) {
        throw new Error('unscored oracle verdict carries no abstention class');
    }
    return verdict.abstention === 'configuration-gated' ? 'configuration' : 'abstention';
}

/**
 * Status of a macro-generated occurrence from the oracle's own expansion
 * (fix #406): 'target' when an occurrence resolves to the target, 'other'
 * only when every occurrence resolves and none to the target (a declaration
 * the expansion itself generated is never the target), 'unresolved' when any
 * occurrence resolves nowhere (unknown never fails a claim), 'unavailable'
 * when the oracle produced no expansion holding the name.
 */
function expandedDefinitionStatus(expanded, matchesTarget) {
    if (!expanded) return 'unavailable';
    const definitions = expanded.definitions || [];
    if (definitions.some(definition => !definition.external && !definition.generated &&
        matchesTarget(definition))) {
        return 'target';
    }
    if ((expanded.unresolved || 0) > 0 || definitions.length === 0) return 'unresolved';
    return 'other';
}

function adjudicateDeferredUnresolved(status) {
    if (status === 'target') return { keep: true, gateBearing: true };
    if (status === 'other') return { keep: false, bucket: 'broad' };
    if (status === 'unresolved') return { keep: false, bucket: 'abstention' };
    return { keep: true, gateBearing: false };
}

// Locate the caller by the oracle token, rather than a callback sharing its
// line. Same-line declarations also need distinct callee-answer cache keys.
function oracleCallerScope(index, call) {
    const file = require('path').resolve(index.root, call.file);
    const definition = index.findEnclosingFunction(file, call.line, true,
        { line: call.line, column: call.column });
    if (!definition) return null;
    const { declarationIdentity } = require('../core/provenance');
    return { definition, key: `${file}\0${JSON.stringify(declarationIdentity(definition))}` };
}

// Compiler class references and a proven initializer body describe the same
// construction dependency. Project each occurrence separately: two derived
// types can enter the same inherited initializer from one enclosing function.
// A construction's class edge already in the answer is not projected again.
function constructorClassEdges(edges, targets, alreadyExact = () => false) {
    const { declarationIdentity, sameDeclaration, validateConfirmation } = require('../core/provenance');
    const projected = [];
    for (const edge of edges) {
        if (edge.type !== 'constructor' || alreadyExact(edge)) continue;
        for (const target of targets) {
            if (!['class', 'struct', 'record', 'enum'].includes(target.type)) continue;
            const identity = declarationIdentity(target);
            const classLines = new Set(edges.filter(other => other.type !== 'constructor' &&
                sameDeclaration(declarationIdentity(other), identity)).flatMap(other => other.sites || []));
            const sites = (edge.siteProvenance || []).filter(site => {
                if (classLines.has(site.line)) return false;
                const proof = site.provenance, call = proof?.facts?.constructorCall;
                return call && call.call?.syntax !== 'implicit' &&
                    sameDeclaration(call.constructedOwner || call.owner, identity) &&
                    validateConfirmation(proof, declarationIdentity(edge)).verdict === 'establishes-target';
            });
            if (!sites.length) continue;
            projected.push({ ...edge, name: target.name, relativePath: target.relativePath,
                startLine: target.startLine, sites: [...new Set(sites.map(site => site.line))].sort((a, b) => a - b),
                siteProvenance: sites });
        }
    }
    return projected;
}

// Symbol kinds each arm samples (fix #429). Oracles list both; the caller
// arm keeps its pre-#429 universe (callables and types) and draws its sample
// unchanged, the value arm draws its own.
const CALLER_ARM_KINDS = new Set(['function', 'method', 'class', 'constructor']);
const VALUE_ARM_KINDS = new Set(['field', 'constant', 'enum-member', 'variable', 'property']);
// The reference-count buckets stop at ">20": classifying more calls than this
// never changes a symbol's bucket.
const BUCKET_CALL_LIMIT = 21;

const ORACLE_EVAL_USAGE = `Usage: node eval/run-oracle-eval.js [options]

Scores UCN's tiered caller answers (and value-member access answers) against
compiler/LSP ground truth. Reports go to $UCN_EVAL_REPORTS_DIR (default
eval/reports).

  --repo NAME[,NAME]         repositories to run (default: every repo with an oracle)
  --release                  the publish-blocking release board
  --fresh [N]                N unpinned repos from the fresh rotation (default 2)
  --sample N                 caller-arm symbols per repo (default 50)
  --value-sample N           value-arm members per repo (default 20; 0 disables)
  --seed N                   sample seed (non-default seeds get their own reports)
  --symbols F:L:NAME[,...]   score these named handles instead of a random draw
                             (one --repo; reports suffixed -targeted)
  --oracle NAME              force an oracle (python: pyright, or jedi)
  --min-precision R          also gate tier-1 precision (caller, callee, value)
  --max-unscored-ratio R     gate oracle coverage (configuration/abstention)
  --max-true-edge-unverified-rate R
  --max-kind-true-edge-unverified-rate R
  --min-kind-oracle-edges N
  --min-zero-unverified-rate R
  --max-unverified-p95 N
  --max-unverified-review-items-per-oracle-edge R
                             review-burden gates (--release uses the v5 budgets)
  --manifest PATH            write a run manifest
  --replay-manifest PATH     replay a manifest's samples and oracle populations
  -h, --help                 print this help and exit
`;

const VALUE_FLAGS = new Set([
    '--repo', '--sample', '--value-sample', '--seed', '--symbols', '--oracle',
    '--min-precision', '--max-unscored-ratio', '--max-true-edge-unverified-rate',
    '--max-kind-true-edge-unverified-rate', '--min-kind-oracle-edges',
    '--min-zero-unverified-rate', '--max-unverified-p95',
    '--max-unverified-review-items-per-oracle-edge', '--manifest', '--replay-manifest',
]);
const BOOLEAN_FLAGS = new Set(['--release', '--help', '-h']);

/**
 * Reject unknown options and options that need a value (fix #429). Before,
 * a misspelled gate flag was ignored and the board ran ungated.
 */
function validateOracleArgs(argv) {
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (VALUE_FLAGS.has(arg)) {
            const value = argv[index + 1];
            if (value == null || /^--/.test(value)) throw new Error(`${arg} requires a value`);
            index++;
        } else if (arg === '--fresh') {
            if (argv[index + 1] != null && /^\d+$/.test(argv[index + 1])) index++;
        } else if (!BOOLEAN_FLAGS.has(arg)) {
            throw new Error(`unknown option ${arg} (see --help)`);
        }
    }
}

/** `file:line:name[,file:line:name...]` -> [{ file, line, name }] (paths are
 *  project-relative, as UCN handles print them). */
function parseSymbolHandles(raw) {
    if (raw == null) return null;
    const handles = String(raw).split(',').map(part => part.trim()).filter(Boolean).map(part => {
        const match = part.match(/^(.+):(\d+):([^:]+)$/);
        if (!match) throw new Error(`--symbols expects file:line:name, got ${part}`);
        return { file: match[1], line: Number(match[2]), name: match[3] };
    });
    if (handles.length === 0) throw new Error('--symbols needs at least one handle');
    return handles;
}

/**
 * The oracle symbol a named handle denotes: the oracle row at that exact
 * position, else the one row of that name inside the indexed definition's
 * head (its start line through its name line: attribute and decorator
 * conventions differ). Never a guess: a missing or ambiguous handle throws.
 */
function resolveSymbolHandle(spec, symbols, index, kinds) {
    const label = `${spec.file}:${spec.line}:${spec.name}`;
    const eligible = symbols.filter(symbol => symbol.file === spec.file && symbol.name === spec.name &&
        (!kinds || kinds.has(symbol.kind)));
    const exact = eligible.filter(symbol => symbol.line === spec.line);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
        throw new Error(`--symbols ${label} is ambiguous (${exact.map(symbol => symbol.kind).join(', ')})`);
    }
    const definition = (index?.symbols?.get(spec.name) || []).find(candidate =>
        candidate.relativePath === spec.file &&
        (candidate.startLine === spec.line || candidate.nameLine === spec.line));
    if (definition) {
        const first = definition.startLine;
        const last = Math.max(definition.nameLine || first, first);
        const within = eligible.filter(symbol => symbol.line >= first && symbol.line <= last);
        if (within.length === 1) return within[0];
    }
    const nearby = eligible.map(symbol => `${symbol.line}:${symbol.kind}`).join(', ') || 'none';
    throw new Error(`--symbols ${label}: no oracle symbol at that declaration (oracle rows of that name in the file: ${nearby})`);
}

function emptyValuePlacement() {
    return { confirmed: 0, unverified: 0, accountedNotShown: 0, missingExplained: 0,
        configurationGated: 0, missingBeyondText: 0, missingUnexplained: 0 };
}

/**
 * Value-member arm accumulator and summary (fix #429). Oracle references
 * are placed line by line in impact's access band; the exact ones (no
 * uncertainty class) carry semantic recall, every confirmed access is
 * scored for precision.
 */
function emptyValueArm(extra = {}) {
    return {
        listed: 0, sampled: 0, evaluated: 0, errors: 0, notIndexed: 0, indexedAsOtherKind: 0,
        oracleBroadReferences: 0,
        oracleRefSites: 0, exactOracleRefSites: 0,
        placement: emptyValuePlacement(), exactPlacement: emptyValuePlacement(),
        confirmedSites: 0, confirmedHits: 0, confirmedUnscored: 0, confirmedUnscoredByClass: {},
        unverifiedSites: 0, unverifiedHits: 0, unverifiedUnscored: 0,
        accounts: 0, conserved: 0,
        notIndexedSamples: [], errorSamples: [], falseConfirmationSamples: [], semanticMissingSamples: [],
        perSymbol: [],
        ...extra,
    };
}

function finishValueArm(arm) {
    const scored = arm.confirmedSites - arm.confirmedUnscored;
    const unverifiedScored = arm.unverifiedSites - arm.unverifiedUnscored;
    const exactEligible = Math.max(0, arm.exactOracleRefSites - arm.exactPlacement.missingExplained -
        arm.exactPlacement.configurationGated);
    const semanticMissing = arm.exactPlacement.accountedNotShown + arm.exactPlacement.missingBeyondText +
        arm.exactPlacement.missingUnexplained;
    return {
        ...arm,
        tier1Precision: scored > 0 ? roundedRate(arm.confirmedHits, scored) : null,
        unverifiedPrecision: unverifiedScored > 0 ? roundedRate(arm.unverifiedHits, unverifiedScored) : null,
        semanticRecall: exactEligible > 0 ? roundedRate(exactEligible - semanticMissing, exactEligible) : 1,
        semanticMissing,
        missingUnexplained: arm.exactPlacement.missingUnexplained,
        allOracleMissingUnexplained: arm.placement.missingUnexplained,
        conservedRate: arm.accounts > 0 ? roundedRate(arm.conserved, arm.accounts) : 1,
        confirmedConfigurationUnscored: arm.confirmedUnscoredByClass['configuration-gated'] || 0,
        confirmedAbstentionUnscored: arm.confirmedUnscored - (arm.confirmedUnscoredByClass['configuration-gated'] || 0),
    };
}


module.exports = {
    emptyValueArm,
    finishValueArm,
    CALLER_ARM_KINDS,
    VALUE_ARM_KINDS,
    BUCKET_CALL_LIMIT,
    ORACLE_EVAL_USAGE,
    validateOracleArgs,
    parseSymbolHandles,
    resolveSymbolHandle,
    PORTABLE_AST_REVIEW_BUDGETS,
    optionalRate,
    optionalNonNegative,
    summarizeReviewBurden,
    evaluateReviewBurden,
    evaluateOracleCoverage,
    closeJsTsDeclarationIdentity,
    adjudicateDeferredUnresolved,
    unscoredProng,
    expandedDefinitionStatus,
    constructorClassEdges,
    oracleCallerScope,
};
