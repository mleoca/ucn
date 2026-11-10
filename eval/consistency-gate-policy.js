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

/**
 * Answer tax: the share of an answer's characters that sit on lines repeated
 * across (nearly) every answer of the same command on one board.
 *
 * A line present in at least `threshold` of the answers does not depend on
 * the symbol asked about: a standing caveat, a repo-level notice, a fixed
 * header. Those characters are paid on every call and carry no answer. The
 * measure is a report, never a gate, and is withheld below `minAnswers`
 * (with a handful of answers "nearly every" is not a meaningful statement).
 *
 * texts: string[] — one formatted answer per board symbol.
 */
function measureAnswerTax(texts, { threshold = 0.9, minAnswers = 5 } = {}) {
    const answers = (texts || []).filter(text => typeof text === 'string');
    const chars = answers.reduce((sum, text) => sum + text.length, 0);
    if (answers.length < minAnswers) {
        return { answers: answers.length, chars, taxChars: null, share: null, lines: [] };
    }
    const presence = new Map();
    const split = answers.map(text => text.split('\n'));
    for (const lines of split) {
        for (const line of new Set(lines)) {
            if (line.trim() === '') continue;
            presence.set(line, (presence.get(line) || 0) + 1);
        }
    }
    const constant = new Map();
    for (const [line, count] of presence) {
        if (count / answers.length >= threshold) constant.set(line, 0);
    }
    let taxChars = 0;
    for (const lines of split) {
        for (const line of lines) {
            if (!constant.has(line)) continue;
            taxChars += line.length;
            constant.set(line, constant.get(line) + line.length);
        }
    }
    const lines = [...constant.entries()]
        .map(([line, total]) => ({ line, chars: total, answers: presence.get(line) }))
        .sort((a, b) => b.chars - a.chars || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
    return {
        answers: answers.length,
        chars,
        taxChars,
        share: chars === 0 ? 0 : Number((taxChars / chars).toFixed(4)),
        lines,
    };
}

module.exports = {
    measureAnswerTax,
    stableValue,
    stableJson,
    multisetDifference,
    compareMultiset,
    compareStructured,
    evaluateConsistencySummary,
};
