'use strict';

function optionalRate(raw, flag) {
    if (raw == null) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`${flag} must be a number from 0 to 1 (got ${raw})`);
    }
    return value;
}

function rate(numerator, denominator) {
    return denominator > 0 ? numerator / denominator : 0;
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
    const unverifiedUniverse = summary.unverifiedEdges || 0;
    const unverifiedUnscoredRatio = rate(summary.unverifiedUnscored || 0, unverifiedUniverse);
    const calleeUniverse = (summary.calleeSites || 0) + (summary.calleeUnscoredSites || 0);
    const calleeUnscoredRatio = rate(summary.calleeUnscoredSites || 0, calleeUniverse);
    const failures = [];

    if (maxUnscoredRatio != null && precisionUnscoredRatio > maxUnscoredRatio) {
        failures.push(`precision configuration-unscored ratio ${(precisionUnscoredRatio * 100).toFixed(2)}% ` +
            `> ${(maxUnscoredRatio * 100).toFixed(2)}%`);
    }
    if (maxUnscoredRatio != null && calleeUnscoredRatio > maxUnscoredRatio) {
        failures.push(`callee configuration-unscored ratio ${(calleeUnscoredRatio * 100).toFixed(2)}% ` +
            `> ${(maxUnscoredRatio * 100).toFixed(2)}%`);
    }

    return { failures, precisionUnscoredRatio, unverifiedUnscoredRatio, calleeUnscoredRatio };
}

module.exports = { optionalRate, evaluateOracleCoverage };
