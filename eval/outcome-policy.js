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

/** Replace only the FIRST word-boundary occurrence — the definition-line
 *  rename. A def line can repeat the symbol as something else entirely:
 *  Java `public JsonWriter value(long value)` repeats it as a PARAMETER,
 *  Go `func (r *Route) BuildVarsFunc(f BuildVarsFunc) *Route` as a TYPE —
 *  renaming those breaks the body/type while the declared name comes first
 *  on its own line in every supported grammar. Proposed SITES keep
 *  all-occurrence semantics (line granularity is the instrument's design). */
function renameFirstOnLine(line, name, newName) {
    const pattern = identifierRegex(name);
    pattern.lastIndex = 0;
    const match = pattern.exec(line);
    if (!match) return line;
    return line.slice(0, match.index) + newName +
        line.slice(match.index + name.length);
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
 *
 * Contract-arm non-slot deferral (flask-measured, 2026-08-19): an unverified
 * site whose name binds a surface OUTSIDE the rename set is a disclosure,
 * not a rename site — editing it breaks the foreign binding while leaving it
 * never breaks the build. Two engine labels mark that shape:
 *   - `externalContract: true` (external-producer flow, override-marker
 *     contract, universal builtin name): flask `rename load` edited
 *     `ep.load()` — stdlib EntryPoint.load — and broke pyright;
 *   - `moduleAttribute: true` (fix #294 module-rooted dotted receivers):
 *     `flask.json.load(out)` binds the module-level `load` function, not the
 *     pinned JSONProvider.load — editing it broke pyright the same way.
 * Ambiguity entries (method-ambiguous, overload-ambiguous) and dispatch-slot
 * attributions (generic-param / supertype possible-dispatch) keep applying:
 * those sites CAN bind the renamed slot, and plan's #293 closure renames the
 * slot's definitions. Deferred sites are returned for disclosure, never
 * silently dropped.
 */
function armSitesFromPlan(planData, mode) {
    const sites = [];
    for (const change of planData.changes || []) {
        // A needsReview entry without a synthesized edit is an explicit
        // "verify before renaming" — the scripted agent defers those rather
        // than blindly rewriting the line.
        if (change.needsReview && !change.newExpression) continue;
        sites.push({ file: change.file, line: change.line, kind: change.editKind });
    }
    const escalationFiles = [];
    const deferredExternal = [];
    if (mode === 'contract') {
        for (const site of planData.unverifiedSites || []) {
            if (site.externalContract || site.moduleAttribute) {
                deferredExternal.push({ file: site.file, line: site.line });
                continue;
            }
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
        deferredExternal: deferredExternal.sort((a, b) =>
            codeUnitCompare(a.file, b.file) || a.line - b.line),
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

/**
 * Membership of one task's definition in a `deadcode --json` answer.
 * The audit's claim set is the engine's actual deletability surface: a claim
 * means the DEFAULT audit — exported, decorated, contract-shielded and
 * entry-point symbols already excluded — found no usage evidence. A symbol
 * the audit declines to claim is not thereby proven live; it is proven
 * "not provably dead by this audit", which is exactly the review tier.
 * claimsWithdrawn mirrors the audit's own coverage honesty — a withdrawn
 * claim set proves nothing in either direction.
 */
function deadcodeClaimForTask(deadcodeDoc, task) {
    // Accept the public CLI document ({ data: [claims], meta: { coverage } })
    // and the internal result shape ({ symbols, coverage }).
    const doc = deadcodeDoc || {};
    const symbols = Array.isArray(doc.data) ? doc.data
        : Array.isArray(doc.symbols) ? doc.symbols
            : (doc.data && doc.data.symbols) || [];
    const coverage = (doc.meta && doc.meta.coverage) || doc.coverage ||
        (doc.data && doc.data.coverage) || null;
    const claimed = symbols.some(symbol =>
        symbol.name === task.name &&
        symbol.file === task.relativePath &&
        symbol.startLine >= task.startLine &&
        symbol.startLine <= (task.endLine || task.startLine));
    return {
        claimed,
        claimsWithdrawn: !!(coverage && coverage.claimsWithdrawn),
    };
}

/**
 * Tri-state contract-arm delete verdict: 'unsafe' | 'safe' | 'review'.
 *
 * The binary contract verdict said "safe" whenever text evidence was zero —
 * but zero text evidence cannot prove a method deletable in languages with
 * implicit contracts (websocket's net.Error Temporary/Timeout methods have
 * no project references, and deleting them breaks interface satisfaction
 * every text/AST arm is blind to). The engine's deadcode audit encodes every
 * shield it has (exported exclusion, external-contract routing, heritage
 * closure, entry points), so:
 *   - any confirmed caller or usage evidence         → unsafe
 *   - zero evidence AND the default audit CLAIMS it  → safe
 *   - zero evidence, not claimed (or audit unusable) → review
 * Review is the honest third answer a grep arm cannot give: "no text
 * evidence, but not provably dead — verify the contract surface first."
 */
function deleteVerdictTriState({ confirmedCallers, usageEvidence, audit }) {
    if (confirmedCallers > 0) return { verdict: 'unsafe', reason: 'confirmed-callers' };
    if (usageEvidence > 0) return { verdict: 'unsafe', reason: 'usage-evidence' };
    if (usageEvidence < 0) return { verdict: 'review', reason: 'usages-unavailable' };
    if (!audit) return { verdict: 'review', reason: 'audit-unavailable' };
    if (audit.claimsWithdrawn) return { verdict: 'review', reason: 'audit-coverage-incomplete' };
    if (audit.claimed) return { verdict: 'safe', reason: 'claimed-dead-by-audit' };
    return { verdict: 'review', reason: 'not-claimed-by-audit' };
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

/** `cargo check --message-format=short` output → error keys.
 *  Keys are DEDUPED: cargo compiles one file under several target contexts
 *  (bench + test for benches/*.rs with --all-targets), and cached vs dirty
 *  targets replay diagnostics asymmetrically — a pristine baseline emitted
 *  `#![feature] may not be used` ONCE while the same repo with a touched
 *  bench file emitted it twice (rust-csv-measured, 2026-08-20). The multiset
 *  diff then manufactured a phantom "new" error for any arm that edits a
 *  bench file. Identical file|message keys are compilation-context echoes,
 *  not distinct errors. */
function parseCargoErrors(text) {
    const keys = new Set();
    for (const raw of String(text || '').split('\n')) {
        const match = raw.match(/^(.+?\.rs):(\d+):(\d+):\s*error(?:\[[^\]]+\])?:\s*(.+)$/);
        if (match) keys.add(`${match[1]}|${truncateMessage(match[4])}`);
    }
    return [...keys];
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

/** javac output → error keys (`path:line: error: message`; the `N errors`
 *  footer and warnings are ignored). Keys are deduped like cargo's — javac
 *  repeats a diagnostic when a file is reached through several compilation
 *  paths. Pass root to relativize absolute paths for report readability. */
function parseJavacErrors(text, root) {
    const keys = new Set();
    const prefix = root ? String(root).replace(/\/?$/, '/') : null;
    for (const raw of String(text || '').split('\n')) {
        const match = raw.match(/^(.+?\.java):(\d+):\s*error:\s*(.+)$/);
        if (!match) continue;
        let file = match[1];
        if (prefix && file.startsWith(prefix)) file = file.slice(prefix.length);
        keys.add(`${file}|${truncateMessage(match[3])}`);
    }
    return [...keys];
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

/** Arm verdict as a tri-state string; binary arms map safe→'safe' else
 *  'unsafe'. Only the contract arm currently emits 'review'. */
function armDeleteVerdict(row) {
    if (typeof row.verdict === 'string') return row.verdict;
    return row.safe ? 'safe' : 'unsafe';
}

/**
 * Aggregate delete-triage verdicts against the judged ground outcome.
 * Each task: { groundBroken, arms: { <armName>: { safe | verdict, cost } } }.
 * falseSafeRate is the dangerous direction (arm said safe, deletion broke the
 * build) and is computed over 'safe' verdicts only. Review rows are counted
 * separately with their ground outcomes — reviewGroundBroken is the breakage
 * the review tier intercepted, reviewGroundClean the over-caution upper
 * bound (a compile-clean deletion can still be runtime-unsafe, which the
 * compiler judge cannot see; falseUnsafe has the same upper-bound caveat).
 */
function aggregateDeleteTasks(tasks, armNames) {
    const perArm = {};
    for (const arm of armNames) {
        const rows = tasks
            .map(task => ({ ground: task.groundBroken, verdict: task.arms[arm] }))
            .filter(row => row.verdict);
        if (rows.length === 0) { perArm[arm] = null; continue; }
        const byVerdict = verdict => rows.filter(row =>
            armDeleteVerdict(row.verdict) === verdict);
        const saidSafe = byVerdict('safe');
        const saidUnsafe = byVerdict('unsafe');
        const review = byVerdict('review');
        const falseSafe = saidSafe.filter(row => row.ground).length;
        const falseUnsafe = saidUnsafe.filter(row => !row.ground).length;
        const decisive = saidSafe.length + saidUnsafe.length;
        const decisiveCorrect = saidSafe.filter(row => !row.ground).length +
            saidUnsafe.filter(row => row.ground).length;
        perArm[arm] = {
            tasks: rows.length,
            saidSafe: saidSafe.length,
            falseSafe,
            falseSafeRate: round(saidSafe.length === 0 ? 0 : falseSafe / saidSafe.length),
            saidUnsafe: saidUnsafe.length,
            falseUnsafeUpperBound: falseUnsafe,
            review: review.length,
            reviewGroundBroken: review.filter(row => row.ground).length,
            reviewGroundClean: review.filter(row => !row.ground).length,
            // Agreement over decisive verdicts only; review abstains.
            agreementWithJudge: round(decisive === 0 ? 0 : decisiveCorrect / decisive),
            avgOutputChars: Math.round(rows.reduce((sum, row) =>
                sum + ((row.verdict.cost && row.verdict.cost.outputChars) || 0), 0) / rows.length),
            avgToolCalls: round(rows.reduce((sum, row) =>
                sum + ((row.verdict.cost && row.verdict.cost.toolCalls) || 0), 0) / rows.length, 2),
        };
    }
    return { perArm };
}

// ── Gate policy (pinned tuned set only — unpinned holdouts never gate) ──────

/**
 * Explicit release thresholds for the outcome instrument, applied to the
 * PINNED tuned regression set (same commit + same seed → same tasks, so the
 * board is deterministic up to toolchain version). The contract arm is the
 * surface UCN tells agents to follow, so it is the arm under gate:
 *   - infra soundness: zero judge errors, zero proposal (plan/show) failures;
 *   - falseSafe = 0: a 'safe' delete verdict that breaks the build is the
 *     dangerous direction and never acceptable on tuned repos;
 *   - rename no-regression: contract broken-build rate must not exceed the
 *     grep baseline on the same tasks (text search is the floor).
 */
const OUTCOME_GATE_THRESHOLDS = Object.freeze({
    maxJudgeErrors: 0,
    maxProposalErrors: 0,
    maxContractDeleteFalseSafe: 0,
    contractRenameNoWorseThanGrep: true,
});

function evaluateOutcomeGate(reports, thresholds = OUTCOME_GATE_THRESHOLDS) {
    const failures = [];
    for (const report of reports) {
        const repo = report.repo;
        if ((report.judgeErrors || 0) > thresholds.maxJudgeErrors) {
            failures.push(`${repo}: ${report.judgeErrors} judge error(s) ` +
                `(max ${thresholds.maxJudgeErrors})`);
        }
        const proposalErrors = (report.renameProposalErrors || 0) +
            (report.deleteProposalErrors || 0);
        if (proposalErrors > thresholds.maxProposalErrors) {
            failures.push(`${repo}: ${proposalErrors} proposal failure(s) ` +
                `(max ${thresholds.maxProposalErrors})`);
        }
        const deleteArm = report.delete && report.delete.aggregate.perArm['ucn-contract'];
        if (deleteArm && deleteArm.falseSafe > thresholds.maxContractDeleteFalseSafe) {
            failures.push(`${repo}: contract delete falseSafe ${deleteArm.falseSafe} ` +
                `(max ${thresholds.maxContractDeleteFalseSafe})`);
        }
        if (thresholds.contractRenameNoWorseThanGrep && report.rename) {
            const perArm = report.rename.aggregate.perArm;
            const grep = perArm.grep;
            const contract = perArm['ucn-contract'];
            if (grep && contract &&
                contract.brokenBuildRate > grep.brokenBuildRate) {
                failures.push(`${repo}: contract rename broken-build ` +
                    `${contract.brokenBuildRate} exceeds grep baseline ` +
                    `${grep.brokenBuildRate}`);
            }
        }
    }
    return failures;
}

module.exports = {
    codeUnitCompare,
    identifierRegex,
    renameOnLine,
    renameFirstOnLine,
    applyRenameToContent,
    applyDeleteToContent,
    stripNameFromImportLine,
    armSitesFromPlan,
    grepProposal,
    deleteVerdictFromShow,
    deleteVerdictFromUsages,
    grepDeleteVerdict,
    deadcodeClaimForTask,
    deleteVerdictTriState,
    armDeleteVerdict,
    OUTCOME_GATE_THRESHOLDS,
    evaluateOutcomeGate,
    parseGoErrors,
    parseCargoErrors,
    parsePyrightErrors,
    parseJavacErrors,
    parseTscErrors,
    diffErrorKeys,
    aggregateRenameTasks,
    aggregateDeleteTasks,
    siteKey,
};
