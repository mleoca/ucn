'use strict';

/**
 * Oracle-backed proofs for the public v5 command surface.
 *
 * The caller/callee scorer proves the semantic engine independently. This
 * module verifies that the same exact compiler/LSP symbols and references
 * survive the public compositions an agent can actually call. Removed
 * internal commands are intentionally absent: a v5 release must not pass
 * because `brief`, `typedef`, `fn`, `class`, or `example` still work behind
 * the public registry.
 *
 * Only commands with an oracle-judgable assertion belong here. The separate
 * public-surface agent benchmark covers the remaining commands and modes.
 */

const fs = require('fs');
const path = require('path');

const { execute } = require('../core/execute');
const { isTestFile } = require('../core/discovery');

function key(file, line) { return `${file}:${line}`; }

function emptyMetric() {
    return { eligible: 0, hits: 0, missing: 0, unscored: 0, abstained: 0 };
}

const PROOF_COMMANDS = Object.freeze([
    'find', 'show', 'source', 'trace', 'impact', 'usages', 'tests',
]);

function createCommandProofSummary() {
    return {
        sampled: 0,
        executionErrors: 0,
        ...Object.fromEntries(PROOF_COMMANDS.map(command => [command, emptyMetric()])),
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

function entriesContainTarget(index, result, targetDef) {
    return (result?.entries || []).some(entry => {
        const match = entry.match || entry;
        return relativeFile(index, match) === targetDef.relativePath &&
            match.startLine === targetDef.startLine;
    });
}

function addMetric(summary, command, hit, sample) {
    const metric = summary[command];
    metric.eligible++;
    if (hit) {
        metric.hits++;
    } else {
        metric.missing++;
        if (summary.missingSamples.length < 40) {
            summary.missingSamples.push({ command, ...sample });
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
    const startedAt = Date.now();
    const response = execute(index, command, params);
    if (process.env.UCN_EVAL_PROGRESS) {
        process.stderr.write(
            `      ${command} ${Date.now() - startedAt}ms (${sample.name})\n`);
    }
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

function exactSymbol(result, targetDef) {
    return result?.file === targetDef.relativePath &&
        result?.startLine === targetDef.startLine;
}

/**
 * Evaluate every oracle-judgable public command for one sampled compiler
 * symbol. Mutates `summary` and returns a compact per-symbol record.
 */
async function evaluateSymbolCommandProof({
    summary,
    index,
    sym,
    targetDef,
    sameNameDefs,
    oracleRefs,
    indexedFiles,
}) {
    summary.sampled++;
    const sample = { name: sym.name, file: sym.file, line: sym.line, kind: sym.kind };
    const record = {};

    // A missing indexed target is a public find failure. Do not manufacture
    // eligibility for handle-based commands that cannot be invoked exactly.
    if (!targetDef) {
        addMetric(summary, 'find', false, sample);
        record.find = false;
        return record;
    }

    const handle = `${targetDef.relativePath}:${targetDef.startLine}:${targetDef.name}`;
    const exactParams = {
        name: sym.name,
        exact: true,
        includeTests: true,
        file: targetDef.relativePath,
        ...(targetDef.className && { className: targetDef.className }),
    };

    const found = executeProof(summary, index, 'find', exactParams, sample);
    const findHit = !!found && found.some(definition =>
        relativeFile(index, definition) === targetDef.relativePath &&
        definition.startLine === targetDef.startLine);
    addMetric(summary, 'find', findHit, sample);
    record.find = findHit;

    // `show` is independently scored from `source`: it is a composition and
    // must retain exact target identity in both its summary and source
    // projection.
    const shown = executeProof(summary, index, 'show', {
        name: handle,
        sections: ['summary', 'source'],
        includeTests: true,
    }, sample);
    const showHit = !!shown &&
        shown.summary?.symbol?.file === targetDef.relativePath &&
        shown.summary?.symbol?.startLine === targetDef.startLine &&
        entriesContainTarget(index, shown.source, targetDef);
    addMetric(summary, 'show', showHit, sample);
    record.show = showHit;

    const source = executeProof(summary, index, 'source', { name: handle }, sample);
    const sourceHit = !!source && entriesContainTarget(index, source, targetDef);
    addMetric(summary, 'source', sourceHit, sample);
    record.source = sourceHit;

    if (isCallableTarget(targetDef)) {
        const trace = executeProof(summary, index, 'trace', {
            name: handle,
            direction: 'callers',
            depth: 1,
            includeTests: true,
        }, sample);
        const traceHit = !!trace && trace.root === targetDef.name &&
            trace.file === targetDef.relativePath && trace.line === targetDef.startLine;
        addMetric(summary, 'trace', traceHit, sample);
        record.trace = traceHit;

        const impact = executeProof(summary, index, 'impact', {
            name: handle,
            includeTests: true,
        }, sample);
        const impactHit = !!impact && exactSymbol(impact, targetDef);
        addMetric(summary, 'impact', impactHit, sample);
        record.impact = impactHit;
    }

    // `usages` is a literal-name inventory, not a target-pinned reference
    // command. Exact recall is therefore judged only for unique project names
    // and oracle references whose source line contains the literal token.
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
            const usageKeys = new Set((usageResult || []).map(usage =>
                key(relativeFile(index, usage), usage.line)));
            for (const ref of eligibleRefs) {
                const hit = usageKeys.has(key(ref.file, ref.line));
                addMetric(summary, 'usages', hit, {
                    ...sample,
                    ref: key(ref.file, ref.line),
                    refKind: ref.kind,
                });
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
                name: handle,
            }, sample);
            const testKeys = new Set();
            for (const fileResult of testsResult || []) {
                for (const match of fileResult.matches || []) {
                    testKeys.add(key(fileResult.file, match.line));
                }
            }
            for (const ref of directTestRefs) {
                const hit = testKeys.has(key(ref.file, ref.line));
                addMetric(summary, 'tests', hit, {
                    ...sample,
                    ref: key(ref.file, ref.line),
                    refKind: ref.kind,
                });
            }
            record.testRefs = directTestRefs.length;
        }
    }

    return record;
}

function finalizeCommandProof(summary) {
    let missing = 0;
    for (const command of PROOF_COMMANDS) {
        const metric = summary[command];
        metric.recall = metric.eligible
            ? Number((metric.hits / metric.eligible).toFixed(4))
            : 1;
        missing += metric.missing;
    }
    summary.missing = missing;
    summary.failures = missing + summary.executionErrors;
    return summary;
}

module.exports = {
    PROOF_COMMANDS,
    createCommandProofSummary,
    evaluateSymbolCommandProof,
    finalizeCommandProof,
    lineContainsIdentifier,
};
