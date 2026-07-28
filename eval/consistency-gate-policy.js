'use strict';

/**
 * Canonical JSON representation for comparison witnesses. Object key order is
 * normalized recursively so report diffs describe semantic disagreement, not
 * construction order.
 */
function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort()
        .map(key => [key, stableValue(value[key])]));
}

function stableJson(value) {
    return JSON.stringify(stableValue(value));
}

/**
 * Compare arrays as multisets. Repeated calls on one source line remain
 * repeated claims; converting to Set would hide a real disagreement.
 */
function multisetDifference(left = [], right = []) {
    const counts = new Map();
    for (const item of right) counts.set(item, (counts.get(item) || 0) + 1);
    const onlyLeft = [];
    for (const item of left) {
        const remaining = counts.get(item) || 0;
        if (remaining > 0) counts.set(item, remaining - 1);
        else onlyLeft.push(item);
    }
    const onlyRight = [];
    for (const [item, count] of counts) {
        for (let i = 0; i < count; i++) onlyRight.push(item);
    }
    return {
        onlyLeft: onlyLeft.sort(),
        onlyRight: onlyRight.sort(),
    };
}

function compareMultiset(check, leftCommand, left, rightCommand, right, witnessLimit = 20) {
    const diff = multisetDifference(left, right);
    if (diff.onlyLeft.length === 0 && diff.onlyRight.length === 0) return null;
    return {
        check,
        commands: [leftCommand, rightCommand],
        leftCount: left.length,
        rightCount: right.length,
        onlyIn: {
            [leftCommand]: diff.onlyLeft.slice(0, witnessLimit),
            [rightCommand]: diff.onlyRight.slice(0, witnessLimit),
        },
        omittedWitnesses: Math.max(0, diff.onlyLeft.length - witnessLimit) +
            Math.max(0, diff.onlyRight.length - witnessLimit),
    };
}

function compareStructured(check, baselineCommand, baseline, command, value) {
    if (stableJson(baseline) === stableJson(value)) return null;
    return {
        check,
        commands: [baselineCommand, command],
        values: {
            [baselineCommand]: stableValue(baseline),
            [command]: stableValue(value),
        },
    };
}

function evaluateConsistencySummary(summary) {
    const failures = [];
    if (!summary || !Number.isInteger(summary.sampledSymbols) ||
        summary.sampledSymbols < 1) {
        failures.push('no symbols were evaluated');
    }
    if ((summary?.parseFailures || 0) > 0) {
        failures.push(`${summary.parseFailures} parse failure(s) made the comparison universe incomplete`);
    }
    if ((summary?.commandErrors || 0) > 0) {
        failures.push(`${summary.commandErrors} command execution error(s)`);
    }
    if ((summary?.disagreements || 0) > 0) {
        failures.push(`${summary.disagreements} cross-command disagreement(s)`);
    }
    return { failures };
}

module.exports = {
    stableValue,
    stableJson,
    multisetDifference,
    compareMultiset,
    compareStructured,
    evaluateConsistencySummary,
};
