/**
 * eval/outcome-policy.js - Pure logic for the task-outcome eval.
 *
 * The outcome eval (eval/run-outcome-eval.js) measures downstream TASK
 * outcomes: the same mechanical task executed by fixed scripted policies
 * ("arms") that differ only in the discovery tool available — text grep vs
 * UCN's public CLI — with the language toolchain as the only judge. This
 * module holds everything that can be pure and unit-tested: proposal
 * extraction, mechanical edit application, judge-output parsing, error-set
 * diffing, and paired aggregation. No filesystem, no child processes.
 *
 * Design rules inherited from the eval suite:
 *   - deterministic ordering everywhere (codeUnitCompare, never locale);
 *   - the judge is the compiler/type-checker — never model judgment;
 *   - a task where EVERY arm fails carries no discriminating signal and is
 *     excluded from paired deltas but disclosed (allArmsBroke).
 */

'use strict';

const IDENT_CHAR = 'A-Za-z0-9_$';

function codeUnitCompare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary identifier matcher (global). `$` counts as an identifier
 *  character so JS `$name` idioms never half-match; harmless elsewhere. */
function identifierRegex(name) {
    return new RegExp(
        `(?<![${IDENT_CHAR}])${escapeRegExp(name)}(?![${IDENT_CHAR}])`, 'g');
}

/** Replace every word-boundary occurrence of name on one line. */
function renameOnLine(line, name, newName) {
    return line.replace(identifierRegex(name), newName);
}

/**
 * Apply a rename to file content at the proposed 1-based lines only.
 * Returns { content, replacedLines, noEffectLines } — a proposed line where
 * the name does not occur is a wasted edit the arm pays for in precision.
 */
function applyRenameToContent(content, lineNumbers, name, newName) {
    const lines = content.split('\n');
    const replacedLines = [];
    const noEffectLines = [];
    const wanted = [...new Set(lineNumbers)].sort((a, b) => a - b);
    for (const lineNo of wanted) {
        const index = lineNo - 1;
        if (index < 0 || index >= lines.length) {
            noEffectLines.push(lineNo);
            continue;
        }
        const replaced = renameOnLine(lines[index], name, newName);
        if (replaced === lines[index]) {
            noEffectLines.push(lineNo);
        } else {
            lines[index] = replaced;
            replacedLines.push(lineNo);
        }
    }
    return { content: lines.join('\n'), replacedLines, noEffectLines };
}

/** Delete a definition's line range (1-based, inclusive). */
function applyDeleteToContent(content, startLine, endLine) {
    const lines = content.split('\n');
    const from = Math.max(0, startLine - 1);
    const to = Math.min(lines.length, endLine);
    lines.splice(from, to - from);
    return lines.join('\n');
}

/**
 * Strip one imported name from an import-syntax line.
 * Returns the new line text, or null when the line should be dropped
 * (the name was the only thing the line imported).
 * Handles the comma-list shapes of Python/JS/TS/Rust; Go imports are
 * package-level and never reach this.
 */
function stripNameFromImportLine(line, name) {
    // Only touch the imported-names region, never the module path
    // (`from a import a` must strip the second `a` only).
    const importKeyword = line.match(/\bimport\s/);
    let regionStart = 0;
    if (importKeyword) {
        regionStart = importKeyword.index + importKeyword[0].length;
    } else {
        const brace = line.indexOf('{');
        if (brace >= 0) regionStart = brace;
    }
    const head = line.slice(0, regionStart);
    const region = line.slice(regionStart);
    const pattern = identifierRegex(name);
    if (!pattern.test(region)) return line;
    // name followed by a comma: remove "name," (and the space after)
    let out = region.replace(new RegExp(
        `(?<![${IDENT_CHAR}])${escapeRegExp(name)}(?![${IDENT_CHAR}])\\s*,\\s*`), '');
    if (out !== region) return head + out;
    // comma before the name: remove ", name"
    out = region.replace(new RegExp(
        `\\s*,\\s*${escapeRegExp(name)}(?![${IDENT_CHAR}])`), '');
    if (out !== region) return head + out;
    // sole import — drop the whole line
    return null;
}

// ── Arm proposal extraction ─────────────────────────────────────────────────

function siteKey(site) {
    return `${site.file}:${site.line}`;
}

/**
 * Site set for the UCN arms from a `plan --rename-to --json` document.
 *   mode 'confirmed': the engine's confirmed changes only (tier-blind agent);
 *   mode 'contract':  + visible unverified sites, plus escalation files the
 *                     account discloses as never analyzed (unparsed +
 *                     unsupported), which the arm must grep itself.
 */
function armSitesFromPlan(planData, mode) {
    const sites = [];
    for (const change of planData.changes || []) {
        sites.push({ file: change.file, line: change.line, kind: change.editKind });
    }
    const escalationFiles = [];
    if (mode === 'contract') {
        for (const site of planData.unverifiedSites || []) {
            sites.push({ file: site.file, line: site.line, kind: 'unverified' });
        }
        const account = planData.account || {};
        for (const file of (account.unparsed && account.unparsed.files) || []) {
            escalationFiles.push(file);
        }
        for (const file of (account.unsupported && account.unsupported.files) || []) {
            escalationFiles.push(file);
        }
    }
    const unique = new Map();
    for (const site of sites) {
        if (!unique.has(siteKey(site))) unique.set(siteKey(site), site);
    }
    return {
        sites: [...unique.values()].sort((a, b) =>
            codeUnitCompare(a.file, b.file) || a.line - b.line),
        escalationFiles: [...new Set(escalationFiles)].sort(codeUnitCompare),
    };
}

/**
 * Grep arm proposal: every word-boundary occurrence of the name in every
 * source file (comments and strings included — that is what a text rename
 * does). contentByFile: Map<relativePath, content>. Metering mirrors what a
 * grep-only agent pays: bytes scanned, files scanned, and the matched lines
 * it must read (outputChars ~ `grep -rn` output).
 */
function grepProposal(contentByFile, name) {
    const pattern = identifierRegex(name);
    const sites = [];
    let scannedBytes = 0;
    let outputChars = 0;
    const files = [...contentByFile.keys()].sort(codeUnitCompare);
    for (const file of files) {
        const content = contentByFile.get(file);
        scannedBytes += Buffer.byteLength(content, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            pattern.lastIndex = 0;
            if (!pattern.test(lines[i])) continue;
            sites.push({ file, line: i + 1, kind: 'text-match' });
            outputChars += file.length + String(i + 1).length + lines[i].length + 2;
        }
    }
    return { sites, scannedBytes, filesScanned: files.length, outputChars };
}

// ── Delete-triage verdicts ──────────────────────────────────────────────────

/** Tier-blind UCN verdict: safe iff `show` reports zero confirmed callers. */
function deleteVerdictFromShow(showData) {
    const context = showData.context || {};
    const confirmed = Array.isArray(context.callers) ? context.callers.length : 0;
    return { safe: confirmed === 0, confirmedCallers: confirmed };
}

/**
 * Contract-following UCN verdict from `usages --json` rows: unsafe when any
 * row is neither the definition nor an import (imports are removed by the
 * deletion itself). Rows inside the definition's own range are deleted WITH
 * it (a body call like `self.map.contains_key(...)` is not outside evidence)
 * — pass def {file, startLine, endLine} to exclude them. Conservative on
 * references — a shadowing local still counts as usage evidence.
 */
function deleteVerdictFromUsages(usageRows, def) {
    let usageEvidence = 0;
    for (const row of usageRows || []) {
        const type = row.usageType || 'reference';
        if (type === 'definition' || type === 'import') continue;
        if (def && (row.relativePath || row.file) === def.file &&
            row.line >= def.startLine && row.line <= def.endLine) continue;
        usageEvidence++;
    }
    return { safe: usageEvidence === 0, usageEvidence };
}

/**
 * Grep verdict: unsafe when any word-boundary match falls outside the
 * definition range and outside import-shaped lines. A comment or string
 * mention counts as usage evidence — grep cannot classify it.
 */
function grepDeleteVerdict(contentByFile, name, defFile, startLine, endLine) {
    const pattern = identifierRegex(name);
    const importLike = /^\s*(?:from\s|import\s|use\s|const\s.*=\s*require\s*\()/;
    let evidence = 0;
    let scannedBytes = 0;
    let outputChars = 0;
    const files = [...contentByFile.keys()].sort(codeUnitCompare);
    for (const file of files) {
        const content = contentByFile.get(file);
        scannedBytes += Buffer.byteLength(content, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            pattern.lastIndex = 0;
            if (!pattern.test(lines[i])) continue;
            outputChars += file.length + lines[i].length + 2;
            if (file === defFile && i + 1 >= startLine && i + 1 <= endLine) continue;
            if (importLike.test(lines[i])) continue;
            evidence++;
        }
    }
    return { safe: evidence === 0, usageEvidence: evidence, scannedBytes, outputChars };
}

// ── Judge-output parsing (error keys are line-INDEPENDENT so deletions that
//    shift line numbers do not manufacture phantom "new" errors) ─────────────

function truncateMessage(message) {
    return String(message || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** `go build` / `go vet` stderr → error keys. */
function parseGoErrors(text) {
    const keys = [];
    for (const raw of String(text || '').split('\n')) {
        const line = raw.replace(/^vet:\s*/, '');
        const match = line.match(/^(.+?\.go):(\d+)(?::\d+)?:\s*(.+)$/);
        if (match) keys.push(`${match[1]}|${truncateMessage(match[3])}`);
    }
    return keys;
}

/** `cargo check --message-format=short` output → error keys. */
function parseCargoErrors(text) {
    const keys = [];
    for (const raw of String(text || '').split('\n')) {
        const match = raw.match(/^(.+?\.rs):(\d+):(\d+):\s*error(?:\[[^\]]+\])?:\s*(.+)$/);
        if (match) keys.push(`${match[1]}|${truncateMessage(match[4])}`);
    }
    return keys;
}

/** pyright --outputjson document → error keys (errors only, warnings out).
 *  Pass root to relativize diagnostic paths (report readability). */
function parsePyrightErrors(doc, root) {
    const keys = [];
    const prefix = root ? String(root).replace(/\/?$/, '/') : null;
    for (const diag of (doc && doc.generalDiagnostics) || []) {
        if (diag.severity !== 'error') continue;
        let file = String(diag.file || '');
        if (prefix && file.startsWith(prefix)) file = file.slice(prefix.length);
        keys.push(`${file}|${diag.rule || ''}|${truncateMessage(diag.message)}`);
    }
    return keys;
}

/** tsc --noEmit output → error keys. */
function parseTscErrors(text) {
    const keys = [];
    for (const raw of String(text || '').split('\n')) {
        const match = raw.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/);
        if (match) keys.push(`${match[1]}|${match[4]}|${truncateMessage(match[5])}`);
    }
    return keys;
}

function errorMultiset(keys) {
    const counts = new Map();
    for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
}

/** New errors relative to baseline (multiset difference). */
function diffErrorKeys(baselineKeys, afterKeys) {
    const baseline = errorMultiset(baselineKeys);
    const after = errorMultiset(afterKeys);
    const newKeys = [];
    for (const [key, count] of after) {
        const extra = count - (baseline.get(key) || 0);
        for (let i = 0; i < extra; i++) newKeys.push(key);
    }
    return newKeys.sort(codeUnitCompare);
}

// ── Aggregation ─────────────────────────────────────────────────────────────

function round(value, digits = 4) {
    return Number(value.toFixed(digits));
}

/**
 * Aggregate per-arm outcomes over rename tasks and compute paired deltas.
 * Each task: { id, arms: { <armName>: { broken, newErrorCount, proposedSites,
 * noEffectEdits, cost: { outputChars, toolCalls, wallMs } } } }.
 * Tasks where every arm broke (or every arm was clean AND proposed identical
 * sites) still count in per-arm rates; paired comparisons additionally report
 * the discriminating subset.
 */
function aggregateRenameTasks(tasks, armNames) {
    const perArm = {};
    for (const arm of armNames) {
        const rows = tasks.map(task => task.arms[arm]).filter(Boolean);
        if (rows.length === 0) { perArm[arm] = null; continue; }
        perArm[arm] = {
            tasks: rows.length,
            brokenBuildRate: round(rows.filter(row => row.broken).length / rows.length),
            avgNewErrors: round(rows.reduce((sum, row) => sum + row.newErrorCount, 0) / rows.length, 2),
            avgProposedSites: round(rows.reduce((sum, row) => sum + row.proposedSites, 0) / rows.length, 2),
            avgNoEffectEdits: round(rows.reduce((sum, row) => sum + (row.noEffectEdits || 0), 0) / rows.length, 2),
            avgOutputChars: Math.round(rows.reduce((sum, row) => sum + row.cost.outputChars, 0) / rows.length),
            avgToolCalls: round(rows.reduce((sum, row) => sum + row.cost.toolCalls, 0) / rows.length, 2),
            avgWallMs: Math.round(rows.reduce((sum, row) => sum + row.cost.wallMs, 0) / rows.length),
        };
    }
    const allArmsBroke = tasks.filter(task =>
        armNames.every(arm => task.arms[arm] && task.arms[arm].broken)).length;
    const allArmsClean = tasks.filter(task =>
        armNames.every(arm => task.arms[arm] && !task.arms[arm].broken)).length;

    const paired = {};
    for (let i = 0; i < armNames.length; i++) {
        for (let j = 0; j < armNames.length; j++) {
            if (i === j) continue;
            const a = armNames[i];
            const b = armNames[j];
            let aCleanBBroken = 0;
            for (const task of tasks) {
                const armA = task.arms[a];
                const armB = task.arms[b];
                if (!armA || !armB) continue;
                if (!armA.broken && armB.broken) aCleanBBroken++;
            }
            paired[`${a}>-<${b}`] = aCleanBBroken;
        }
    }
    return { perArm, allArmsBroke, allArmsClean, pairedCleanVsBroken: paired };
}

/**
 * Aggregate delete-triage verdicts against the judged ground outcome.
 * Each task: { groundBroken, arms: { <armName>: { safe, cost } } }.
 * falseSafeRate is the dangerous direction (arm said safe, deletion broke the
 * build); falseUnsafeRate is an upper bound only — a compile-clean deletion
 * can still be runtime-unsafe, which the compiler judge cannot see.
 */
function aggregateDeleteTasks(tasks, armNames) {
    const perArm = {};
    for (const arm of armNames) {
        const rows = tasks
            .map(task => ({ ground: task.groundBroken, verdict: task.arms[arm] }))
            .filter(row => row.verdict);
        if (rows.length === 0) { perArm[arm] = null; continue; }
        const saidSafe = rows.filter(row => row.verdict.safe);
        const saidUnsafe = rows.filter(row => !row.verdict.safe);
        const falseSafe = saidSafe.filter(row => row.ground).length;
        const falseUnsafe = saidUnsafe.filter(row => !row.ground).length;
        perArm[arm] = {
            tasks: rows.length,
            saidSafe: saidSafe.length,
            falseSafe,
            falseSafeRate: round(saidSafe.length === 0 ? 0 : falseSafe / saidSafe.length),
            falseUnsafeUpperBound: falseUnsafe,
            agreementWithJudge: round(rows.filter(row =>
                row.verdict.safe === !row.ground).length / rows.length),
            avgOutputChars: Math.round(rows.reduce((sum, row) =>
                sum + ((row.verdict.cost && row.verdict.cost.outputChars) || 0), 0) / rows.length),
            avgToolCalls: round(rows.reduce((sum, row) =>
                sum + ((row.verdict.cost && row.verdict.cost.toolCalls) || 0), 0) / rows.length, 2),
        };
    }
    return { perArm };
}

module.exports = {
    codeUnitCompare,
    identifierRegex,
    renameOnLine,
    applyRenameToContent,
    applyDeleteToContent,
    stripNameFromImportLine,
    armSitesFromPlan,
    grepProposal,
    deleteVerdictFromShow,
    deleteVerdictFromUsages,
    grepDeleteVerdict,
    parseGoErrors,
    parseCargoErrors,
    parsePyrightErrors,
    parseTscErrors,
    diffErrorKeys,
    aggregateRenameTasks,
    aggregateDeleteTasks,
    siteKey,
};
