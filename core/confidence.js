/**
 * core/confidence.js - Deterministic edge confidence scoring
 *
 * Assigns a 0.0-1.0 confidence score to each caller/callee edge based on
 * how the call was resolved. Rule-based, no ML.
 */

'use strict';

// Resolution types ordered from most to least confident
const RESOLUTION = {
    EXACT_BINDING:  'exact-binding',
    SAME_CLASS:     'same-class',
    RECEIVER_HINT:  'receiver-hint',
    SCOPE_MATCH:    'scope-match',
    NAME_ONLY:      'name-only',
    UNCERTAIN:      'uncertain',
};

// Seed scores per resolution type (tunable)
const SCORES = {
    [RESOLUTION.EXACT_BINDING]:  0.98,
    [RESOLUTION.SAME_CLASS]:     0.92,
    [RESOLUTION.RECEIVER_HINT]:  0.80,
    [RESOLUTION.SCOPE_MATCH]:    0.65,
    [RESOLUTION.NAME_ONLY]:      0.40,
    [RESOLUTION.UNCERTAIN]:      0.25,
};

// Trust tiers for the grep-reliability contract. CONFIRMED = the resolution
// rests on binding/receiver/import evidence; UNVERIFIED = name match without
// evidence. The mapping is resolution-based, never language-based — evidence
// flags already come from langTraits dispatch in callers.js, so every
// language gets correct tiers automatically.
const TIER = { CONFIRMED: 'confirmed', UNVERIFIED: 'unverified' };
const RESOLUTION_TIER = {
    [RESOLUTION.EXACT_BINDING]: TIER.CONFIRMED,
    [RESOLUTION.SAME_CLASS]:    TIER.CONFIRMED,
    [RESOLUTION.RECEIVER_HINT]: TIER.CONFIRMED,
    // scope-match is only assigned with import/receiver/callback evidence
    // (see scoreEdge below) — that satisfies the contract's evidence clause.
    [RESOLUTION.SCOPE_MATCH]:   TIER.CONFIRMED,
    [RESOLUTION.NAME_ONLY]:     TIER.UNVERIFIED,
    [RESOLUTION.UNCERTAIN]:     TIER.UNVERIFIED,
};

/** Map a RESOLUTION value to its trust tier (unknown values are unverified). */
function tierForResolution(resolution) {
    return RESOLUTION_TIER[resolution] || TIER.UNVERIFIED;
}

/**
 * Score a caller/callee edge based on resolution evidence.
 *
 * @param {object} evidence - Resolution evidence collected during call resolution
 * @param {boolean} [evidence.hasBindingId] - Call resolved to a specific bindingId
 * @param {boolean} [evidence.resolvedBySameClass] - Resolved via self/this/super/cls
 * @param {boolean} [evidence.resolvedByReceiverHint] - Receiver type narrowed via local hints
 * @param {boolean} [evidence.hasImportEvidence] - File imports the target definition
 * @param {boolean} [evidence.hasReceiverEvidence] - Receiver variable has binding in file scope
 * @param {boolean} [evidence.isUncertain] - Marked uncertain by resolution logic
 * @param {boolean} [evidence.isFunctionReference] - Passed as callback argument
 * @param {boolean} [evidence.hasReceiverType] - Go/Java/Rust parser-inferred receiverType
 * @returns {{ confidence: number, resolution: string, evidence: string[] }}
 */
function scoreEdge(evidence) {
    const reasons = [];

    // Known receiver/path type mismatch — checked FIRST: positive evidence the
    // call targets a different symbol overrides any receiver-type signal
    // (without this, a known mismatch would score receiver-hint 0.80).
    if (evidence.typeMismatch) {
        reasons.push('receiver type mismatch');
        return { confidence: SCORES[RESOLUTION.UNCERTAIN], resolution: RESOLUTION.UNCERTAIN, evidence: reasons };
    }

    // Exact binding match (highest confidence)
    if (evidence.hasBindingId) {
        reasons.push('binding-id match');
        if (evidence.hasImportEvidence) reasons.push('import-verified');
        return { confidence: SCORES[RESOLUTION.EXACT_BINDING], resolution: RESOLUTION.EXACT_BINDING, evidence: reasons };
    }

    // Same-class resolution (self/this/super/cls)
    if (evidence.resolvedBySameClass) {
        reasons.push('same-class method');
        if (evidence.hasInheritanceChain) reasons.push('via inheritance');
        return { confidence: SCORES[RESOLUTION.SAME_CLASS], resolution: RESOLUTION.SAME_CLASS, evidence: reasons };
    }

    // Receiver hint narrowed to specific type
    if (evidence.resolvedByReceiverHint || evidence.hasReceiverType) {
        reasons.push(evidence.hasReceiverType ? 'parser receiver-type' : 'local type inference');
        return { confidence: SCORES[RESOLUTION.RECEIVER_HINT], resolution: RESOLUTION.RECEIVER_HINT, evidence: reasons };
    }

    // Function reference (callback / passed-as-argument). Argument position is
    // only confirming when the name demonstrably reaches the target (same file,
    // same package, or an import edge) — otherwise it's a bare name match: a
    // local variable or an unrelated same-name symbol shadows it invisibly.
    if (evidence.isFunctionReference) {
        reasons.push('function reference');
        if (evidence.hasImportEvidence || evidence.hasSamePackageEvidence) {
            reasons.push(evidence.hasImportEvidence ? 'import-supported' : 'same package/module');
            return { confidence: SCORES[RESOLUTION.SCOPE_MATCH], resolution: RESOLUTION.SCOPE_MATCH, evidence: reasons };
        }
        reasons.push('no import evidence');
        return { confidence: SCORES[RESOLUTION.NAME_ONLY], resolution: RESOLUTION.NAME_ONLY, evidence: reasons };
    }

    // Scope/import-supported match
    if (evidence.hasImportEvidence || evidence.hasReceiverEvidence || evidence.hasSamePackageEvidence) {
        if (evidence.hasImportEvidence) reasons.push('import-supported');
        if (evidence.hasReceiverEvidence) reasons.push('receiver binding in scope');
        if (evidence.hasSamePackageEvidence) reasons.push('same package/module');
        return { confidence: SCORES[RESOLUTION.SCOPE_MATCH], resolution: RESOLUTION.SCOPE_MATCH, evidence: reasons };
    }

    // Uncertain
    if (evidence.isUncertain) {
        reasons.push('ambiguous resolution');
        return { confidence: SCORES[RESOLUTION.UNCERTAIN], resolution: RESOLUTION.UNCERTAIN, evidence: reasons };
    }

    // Name-only match (no additional evidence)
    reasons.push('name match only');
    return { confidence: SCORES[RESOLUTION.NAME_ONLY], resolution: RESOLUTION.NAME_ONLY, evidence: reasons };
}

/**
 * Filter edges by minimum confidence threshold.
 * @param {Array} edges - Array of objects with .confidence property
 * @param {number} minConfidence - Minimum confidence (0.0-1.0)
 * @returns {{ kept: Array, filtered: number }}
 */
function filterByConfidence(edges, minConfidence) {
    if (!minConfidence || minConfidence <= 0) return { kept: edges, filtered: 0 };
    const kept = [];
    let filtered = 0;
    for (const edge of edges) {
        if ((edge.confidence || 0) >= minConfidence) {
            kept.push(edge);
        } else {
            filtered++;
        }
    }
    return { kept, filtered };
}

module.exports = {
    RESOLUTION,
    SCORES,
    TIER,
    RESOLUTION_TIER,
    tierForResolution,
    scoreEdge,
    filterByConfidence,
};
