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

    // Scope/import-supported match
    if (evidence.hasImportEvidence || evidence.hasReceiverEvidence) {
        if (evidence.hasImportEvidence) reasons.push('import-supported');
        if (evidence.hasReceiverEvidence) reasons.push('receiver binding in scope');
        return { confidence: SCORES[RESOLUTION.SCOPE_MATCH], resolution: RESOLUTION.SCOPE_MATCH, evidence: reasons };
    }

    // Function reference (callback)
    if (evidence.isFunctionReference) {
        reasons.push('function reference');
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
    scoreEdge,
    filterByConfidence,
};
