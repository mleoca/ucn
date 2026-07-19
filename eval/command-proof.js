'use strict';

/**
 * Oracle-backed command-surface proofs shared by run-oracle-eval.js.
 *
 * The caller/callee scorer proves the semantic call engine.  This module
 * exercises the other commands that can be judged from the SAME independent
 * compiler/LSP symbol and reference set, so one strong call score cannot hide
 * a broken definition lookup, usage scan, extractor, test lookup, or example
 * selector.
 *
 * Reference recall is intentionally scoped to oracle references whose source
 * line contains the symbol's literal identifier.  UCN's `usages` command is a
 * literal-name/code-reference inventory; renamed aliases that contain no
 * target token are call-graph evidence and are scored by the caller/callee arm.
 */

const fs = require('fs');
const path = require('path');

const { execute } = require('../core/execute');
const { isTestFile } = require('../core/discovery');

function key(file, line) { return `${file}:${line}`; }

function emptyMetric() {
    return { eligible: 0, hits: 0, missing: 0, unscored: 0, abstained: 0 };
}

function createCommandProofSummary() {
    return {
        sampled: 0,
        executionErrors: 0,
        definition: emptyMetric(),
        find: emptyMetric(),
        extraction: emptyMetric(),
        brief: emptyMetric(),
        typedef: emptyMetric(),
        usages: emptyMetric(),
        tests: emptyMetric(),
        example: emptyMetric(),
        missingSamples: [],
        errorSamples: [],
    };
}

function sourceLine(index, relFile, line) {
    const abs = path.join(index.root, relFile);
    try {
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        return line >= 1 && line <= lines.length ? lines[line - 1] : '';
    } catch {
        return '';
    }
}

function lineContainsIdentifier(index, relFile, line, name) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const identifier = /[A-Za-z0-9_$]/;
    const left = identifier.test(String(name)[0] || '') ? '(^|[^A-Za-z0-9_$])' : '';
    const right = identifier.test(String(name).slice(-1)) ? '(?![A-Za-z0-9_$])' : '';
    const regex = new RegExp(`${left}${escaped}${right}`, 'g');
    const text = sourceLine(index, relFile, line);
    const abs = path.join(index.root, relFile);
    let content = null;
    let match;
    while ((match = regex.exec(text)) !== null) {
        // `left` may consume one boundary character; point at the identifier.
        const offset = match[0].lastIndexOf(String(name));
        const column = match.index + Math.max(0, offset);
        if (content == null) {
            try { content = fs.readFileSync(abs, 'utf8'); } catch { content = ''; }
        }
        if (!index.isCommentOrStringAtPosition(content, line, column, abs)) return true;
        if (match[0].length === 0) regex.lastIndex++;
    }
    return false;
}

function relativeFile(index, item) {
    if (item.relativePath) return item.relativePath;
    if (!item.file) return null;
    return path.isAbsolute(item.file) ? path.relative(index.root, item.file) : item.file;
}

function recordsContain(index, records, file, line) {
    const relFile = path.isAbsolute(file) ? path.relative(index.root, file) : file;
    return (records || []).some(r => relativeFile(index, r) === relFile && r.line === line);
}

function entriesContainTarget(index, result, targetDef) {
    const entries = result?.entries || [];
    return entries.some(entry => {
        const match = entry.match || entry;
        return relativeFile(index, match) === targetDef.relativePath &&
            match.startLine === targetDef.startLine;
    });
}

function addMetric(summary, metricName, hit, sample) {
    const metric = summary[metricName];
    metric.eligible++;
    if (hit) {
        metric.hits++;
    } else {
        metric.missing++;
        if (summary.missingSamples.length < 40) {
            summary.missingSamples.push({ command: metricName, ...sample });
        }
    }
}

function addExecutionError(summary, command, error, sample) {
    summary.executionErrors++;
    if (summary.errorSamples.length < 40) {
        summary.errorSamples.push({ command, error, ...sample });
    }
}

function executeProof(summary, index, command, params, sample) {
    const response = execute(index, command, params);
    if (!response.ok) {
        addExecutionError(summary, command, response.error, sample);
        return null;
    }
    return response.result;
}

function isCallableTarget(targetDef) {
    return targetDef && (targetDef.params !== undefined ||
        ['function', 'method', 'constructor'].includes(targetDef.type));
}

function isTypeTarget(targetDef) {
    return targetDef && [
        'class', 'interface', 'type', 'typeAlias', 'struct', 'enum', 'trait',
    ].includes(targetDef.type);
}

/**
 * Evaluate every oracle-judgable command for one sampled compiler symbol.
 * Mutates `summary` and returns a compact per-symbol record.
 */
async function evaluateSymbolCommandProof({
    summary,
    index,
    sym,
    targetDef,
    sameNameDefs,
    oracleRefs,
    oracleCalls,
    indexedFiles,
    adjudicateExample,
}) {
    summary.sampled++;
    const sample = { name: sym.name, file: sym.file, line: sym.line, kind: sym.kind };
    const handle = targetDef
        ? `${targetDef.relativePath}:${targetDef.startLine}:${targetDef.name}`
        : `${sym.file}:${sym.line}:${sym.name}`;
    const record = {};

    // Definition presence is the prerequisite for every pinned command.  It
    // is scored directly instead of being inferred from a successful context
    // call, because the old evaluator silently skipped command errors.
    const definitionHit = !!targetDef;
    addMetric(summary, 'definition', definitionHit, sample);
    record.definition = definitionHit;
    if (!targetDef) return record;

    const exactParams = {
        name: sym.name,
        exact: true,
        includeTests: true,
        file: targetDef.relativePath,
        ...(targetDef.className && { className: targetDef.className }),
    };
    const found = executeProof(summary, index, 'find', exactParams, sample);
    if (found) {
        const hit = found.some(d => relativeFile(index, d) === targetDef.relativePath &&
            d.startLine === targetDef.startLine);
        addMetric(summary, 'find', hit, sample);
        record.find = hit;
    } else {
        addMetric(summary, 'find', false, sample);
        record.find = false;
    }

    const extractionCommand = sym.kind === 'class' || !isCallableTarget(targetDef)
        ? (isTypeTarget(targetDef) ? 'class' : null)
        : 'fn';
    if (extractionCommand) {
        const extracted = executeProof(summary, index, extractionCommand, { name: handle }, sample);
        const hit = !!extracted && entriesContainTarget(index, extracted, targetDef);
        addMetric(summary, 'extraction', hit, { ...sample, extractor: extractionCommand });
        record.extraction = hit;
    }

    const brief = executeProof(summary, index, 'brief', { name: handle }, sample);
    const briefHit = !!brief && brief.symbol?.file === targetDef.relativePath &&
        brief.symbol?.startLine === targetDef.startLine;
    addMetric(summary, 'brief', briefHit, sample);
    record.brief = briefHit;

    if (isTypeTarget(targetDef)) {
        const typedef = executeProof(summary, index, 'typedef', {
            name: targetDef.name,
            file: targetDef.relativePath,
            exact: true,
            ...(targetDef.className && { className: targetDef.className }),
        }, sample);
        const typedefHit = !!typedef && typedef.some(d =>
            relativeFile(index, d) === targetDef.relativePath &&
            d.startLine === targetDef.startLine);
        addMetric(summary, 'typedef', typedefHit, sample);
        record.typedef = typedefHit;
    }

    // `usages` does not accept a definition handle.  Score exact semantic
    // recall only for unique project names; repeated names would make a
    // target-specific precision/recall claim impossible for this command's
    // documented name-inventory contract.
    if (sameNameDefs.length === 1) {
        const eligibleRefs = (oracleRefs || []).filter(ref =>
            ref.kind !== 'definition' && indexedFiles.has(ref.file) &&
            lineContainsIdentifier(index, ref.file, ref.line, sym.name));
        if (eligibleRefs.length > 0) {
            const usageResult = executeProof(summary, index, 'usages', {
                name: sym.name,
                includeTests: true,
                codeOnly: true,
            }, sample);
            const usageKeys = new Set((usageResult || []).map(u =>
                key(relativeFile(index, u), u.line)));
            for (const ref of eligibleRefs) {
                const hit = usageKeys.has(key(ref.file, ref.line));
                addMetric(summary, 'usages', hit, { ...sample, ref: key(ref.file, ref.line), refKind: ref.kind });
            }
            record.usageRefs = eligibleRefs.length;
        }

        const directTestRefs = (oracleRefs || []).filter(ref => {
            if (ref.kind === 'definition' || !indexedFiles.has(ref.file) ||
                !lineContainsIdentifier(index, ref.file, ref.line, sym.name)) return false;
            const abs = path.join(index.root, ref.file);
            const language = index.files.get(abs)?.language;
            return isTestFile(ref.file, language);
        });
        if (directTestRefs.length > 0) {
            const testsResult = executeProof(summary, index, 'tests', {
                name: sym.name,
                file: targetDef.relativePath,
                ...(targetDef.className && { className: targetDef.className }),
            }, sample);
            const testKeys = new Set();
            for (const fileResult of testsResult || []) {
                for (const match of fileResult.matches || []) {
                    testKeys.add(key(fileResult.file, match.line));
                }
            }
            for (const ref of directTestRefs) {
                const hit = testKeys.has(key(ref.file, ref.line));
                addMetric(summary, 'tests', hit, { ...sample, ref: key(ref.file, ref.line), refKind: ref.kind });
            }
            record.testRefs = directTestRefs.length;
        }
    }

    // `example` makes a precision claim: when an example is returned, it
    // must be one of the compiler/LSP call sites for this exact target.
    if ((oracleCalls || []).length > 0 && isCallableTarget(targetDef)) {
        const example = executeProof(summary, index, 'example', {
            name: handle,
            includeTests: true,
        }, sample);
        const best = example?.best || (Array.isArray(example?.examples) ? example.examples[0] : null);
        if (!best && example?.confirmedCalls === 0 && example?.unverifiedCalls > 0) {
            summary.example.abstained++;
            record.example = 'abstained-unverified';
            return record;
        }
        let exampleVerdict = !!best && recordsContain(index, oracleCalls, best.file, best.line)
            ? 'hit' : 'miss';
        if (best && exampleVerdict === 'miss' && typeof adjudicateExample === 'function') {
            exampleVerdict = await adjudicateExample(best);
        }
        if (exampleVerdict === 'unscored') {
            summary.example.unscored++;
            record.example = 'unscored';
        } else {
            const exampleHit = exampleVerdict === 'hit' || exampleVerdict === true;
            addMetric(summary, 'example', exampleHit, {
                ...sample,
                selected: best ? key(best.file, best.line) : null,
            });
            record.example = exampleHit;
        }
    }

    return record;
}

function finalizeCommandProof(summary) {
    const metrics = ['definition', 'find', 'extraction', 'brief', 'typedef', 'usages', 'tests', 'example'];
    let missing = 0;
    for (const name of metrics) {
        const metric = summary[name];
        metric.recall = metric.eligible ? Number((metric.hits / metric.eligible).toFixed(4)) : 1;
        missing += metric.missing;
    }
    summary.missing = missing;
    summary.failures = missing + summary.executionErrors;
    return summary;
}

module.exports = {
    createCommandProofSummary,
    evaluateSymbolCommandProof,
    finalizeCommandProof,
    lineContainsIdentifier,
};
