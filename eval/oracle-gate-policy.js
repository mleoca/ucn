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
        oracleCallEdges - (placement.missingExplained || 0));
    // Runtime polymorphism and compiler-dependent templates both identify a
    // family that MAY reach the target, not one statically exact definition.
    // Keep those edges in semantic recall, but do not mislabel them as exact
    // target identity. Each family remains visible and separately charged.
    const exactSemanticEligibleEdges = Math.max(0,
        exactOracleCallEdges - (exactPlacement.missingExplained || 0));
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
    // Two abstention classes hide in confirmedUnscored (fix #286g,
    // flask-measured: 100% of the 27.85% "configuration-unscored" band was
    // definition-unresolved — pyright cannot type pytest-fixture receivers
    // that single-owner physics correctly confirms). True configuration
    // gating (platform/config-invisible code) keeps the hard bound; oracle
    // ABSTENTION gets a looser 3x ceiling — intrinsic to fixture-heavy
    // dynamic code, but a runaway still fails loudly.
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
    const failures = [];

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

module.exports = {
    PORTABLE_AST_REVIEW_BUDGETS,
    optionalRate,
    optionalNonNegative,
    summarizeReviewBurden,
    evaluateReviewBurden,
    evaluateOracleCoverage,
    closeJsTsDeclarationIdentity,
};
