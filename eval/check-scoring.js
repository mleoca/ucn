/**
 * eval/check-scoring.js - How the check matrix scores an answer: pure logic,
 * no filesystem, no child processes.
 *
 * One definition serves the check matrix and the outcome gate
 * (`classifyNewDiagnostics` in eval/outcome-policy.js):
 *
 *   FALSE-READY  READY (or "no changes") while the toolchain reports a NEW
 *                error on a line the change did not write.
 *
 * New errors are the judge's error keys minus the baseline run's, as a
 * multiset. Errors only: a warning is no break, but a run the toolchain
 * rejects with no error read from it counts as one error with no location.
 * Notes attached to an error (a compiler's "declared here") are not
 * locations of it. Written lines come from the case alone: a line of the
 * changed file that a longest-common-subsequence alignment does not match to
 * a line of the base file. A deleted file has none. A new error is local
 * when every location of it is on a written line; a location on any other
 * line, or no location at all, puts it outside.
 *
 * Columns of a run:
 *   false-ready             gate: READY while a new error is outside, unless
 *                           an exact pin below names the case;
 *   ready-with-local-break  READY while every new error is on written lines
 *                           (reported; each case is listed by id below);
 *   ready-while-rejected    READY while the toolchain rejects the change
 *                           anywhere (the sum of the two above);
 *   false-blocked           gate: BLOCKED for a change the toolchain accepts;
 *   over-cautious           REVIEW for a change the toolchain accepts.
 */

'use strict';

const {
    classifyNewDiagnostics, normalizeDiagnosticFile, codeUnitCompare,
    parseGoDiagnostics, parseCargoDiagnostics, parsePyrightDiagnostics,
    parseJavacDiagnostics, parseTscDiagnostics,
} = require('./outcome-policy');

const READY = 'READY_FOR_TOOLCHAIN';
const NO_CHANGES = 'NO-CHANGES';
const BLOCKED = 'BLOCKED';

/**
 * Judged breaks the check answers READY with an error on a line the change
 * did not write: known gaps, each named by its exact case id and the
 * toolchain diagnostic that shows it. Any other false-ready fails the run,
 * and a pin whose case is judged and is not false-ready fails it too. Each
 * is a binding or a condition the change wrote that a line it did not
 * write is checked against (eval/check-written-line-cases.js): a binding
 * changed before an unchanged `return`, a guard or assertion condition
 * changed with its end kept, a guard added above a literal comparison; or
 * text a change only deleted that an unwritten line relied on (the last use
 * of a local in Go, the call a Java `catch` expected).
 */
const KNOWN_FALSE_READY = Object.freeze([
    Object.freeze({ id: 'written-go-call-removed-leaves-a-local-unused',
        evidence: 'go vet: a.go:6 declared and not used: y' }),
    Object.freeze({ id: 'written-java-throwing-call-removed-from-try',
        evidence: 'javac: Lib.java:13 exception IOException is never thrown in body of corresponding try statement' }),
    Object.freeze({ id: 'written-py-assert-condition-changed',
        evidence: "pyright: lib.py:3 reportOperatorIssue, Operator \"+\" not supported for types \"None\" and \"Literal[1]\"" }),
    Object.freeze({ id: 'written-py-binding-before-return',
        evidence: "pyright: lib.py:3 reportReturnType, Type \"Literal['bad']\" is not assignable to return type \"int\"" }),
    Object.freeze({ id: 'written-py-guard-condition-changed',
        evidence: "pyright: lib.py:4 reportReturnType, Type \"None\" is not assignable to return type \"int\"" }),
    Object.freeze({ id: 'written-ts-binding-before-return',
        evidence: "tsc: lib.ts(3) TS2322, Type 'string' is not assignable to type 'number'" }),
    Object.freeze({ id: 'written-ts-guard-added-above-literal-comparison',
        evidence: "tsc: lib.ts(3) TS2367, This comparison appears to be unintentional because the types '\"a\"' and '\"b\"' have no overlap" }),
    Object.freeze({ id: 'written-ts-guard-condition-changed',
        evidence: "tsc: lib.ts(3) TS2322, Type 'undefined' is not assignable to type 'number'" }),
]);

/**
 * Judged breaks the check answers READY whose every new error is on a line
 * the change wrote, by exact case id. The pinned answers are held to it
 * without a toolchain (test/check-change-kinds.test.js); the matrix run
 * reports where its own scoring disagrees with it.
 */
const READY_LOCAL_BREAKS = Object.freeze([
    'outgoing-review2-cs-byte-range',
    'outgoing-review2-cs-ref-modifier-removed',
    'outgoing-review3-cs-overload-obsolete-target',
    'outgoing-review3-cs-overload-ref-target',
    'outgoing-review3-java-overload-checked-throws',
    'outgoing-review3-java-overload-generic-throws',
    'settled-py-derived-owner-inherits-parameter-type',
    'settled-py-new-discarded-coroutine',
    'settled-py-own-parameter-of-another-type',
    'settled-py-result-follows-argument-through-operator',
    'settled-ts-own-method-through-another-this',
    'settled-ts-own-parameter-shadowed-in-block',
    'settled-ts-own-parameter-that-may-be-absent',
    'written-ts-discarded-call-wrong-argument',
]);

// ── Written lines ───────────────────────────────────────────────────────────

/**
 * Lines of `after` (1-based) that a longest-common-subsequence alignment does
 * not match to a line of `before`. Ties take the earliest match, so text
 * added after a repeated line (a closing brace) is the added text.
 */
function writtenLines(before, after) {
    if (after == null) return new Set();
    // The empty string after a final newline is no line of the file.
    const linesOf = text => {
        const lines = String(text).split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        return lines;
    };
    const a = before == null ? [] : linesOf(before);
    const b = linesOf(after);
    const width = b.length + 1;
    const table = new Int32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i * width + j] = a[i] === b[j]
                ? table[(i + 1) * width + j + 1] + 1
                : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
        }
    }
    const written = new Set();
    let i = 0;
    let j = 0;
    while (j < b.length) {
        if (i < a.length && a[i] === b[j]) { i++; j++; continue; }
        if (i < a.length && table[(i + 1) * width + j] >= table[i * width + j + 1]) { i++; continue; }
        written.add(j + 1);
        j++;
    }
    return written;
}

/** file -> Set of written lines, for every file a case changes. */
function writtenLinesOf(testCase) {
    const byFile = new Map();
    for (const [file, content] of Object.entries(testCase.after || {})) {
        byFile.set(normalizeDiagnosticFile(file), writtenLines((testCase.base || {})[file], content));
    }
    return byFile;
}

/** Written lines as ranges in post-edit coordinates, in file then line order. */
function writtenRanges(byFile) {
    const ranges = [];
    for (const file of [...byFile.keys()].sort(codeUnitCompare)) {
        const lines = [...byFile.get(file)].sort((x, y) => x - y);
        for (const line of lines) {
            const last = ranges[ranges.length - 1];
            if (last && last.file === file && last.endLine === line - 1) last.endLine = line;
            else ranges.push({ file, startLine: line, endLine: line });
        }
    }
    return ranges;
}

// ── Located judges the outcome eval has no parser for ──────────────────────

/**
 * `dotnet build` output -> error diagnostics. MSBuild prints every error
 * twice (as it happens and in the summary), with the project in brackets:
 * one diagnostic per key, line and column. A path under `root` is made
 * relative. An MSBuild error with no file has no location.
 */
function parseDotnetDiagnostics(text, root) {
    const prefix = root ? String(root).replace(/\/?$/, '/') : null;
    const seen = new Set();
    const diagnostics = [];
    for (const raw of String(text || '').split('\n')) {
        const line = raw.replace(/\s+\[[^\]]*\]\s*$/, '').trim();
        let match = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+([A-Z]+\d+):\s*(.+)$/);
        let diagnostic;
        if (match) {
            let file = match[1];
            if (prefix && file.startsWith(prefix)) file = file.slice(prefix.length);
            file = normalizeDiagnosticFile(file);
            diagnostic = { key: `${file}|${match[4]}|${truncate(match[5])}`, file, line: Number(match[2]), column: Number(match[3]) };
        } else if ((match = line.match(/^(?:.*?:\s*)?error\s+([A-Z]+\d+):\s*(.+)$/))) {
            diagnostic = { key: `|${match[1]}|${truncate(match[2])}`, file: null, line: null, column: null };
        } else continue;
        const identity = `${diagnostic.key}\0${diagnostic.line}\0${diagnostic.column}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        diagnostics.push(diagnostic);
    }
    return diagnostics.map(({ column, ...rest }) => rest);
}

/**
 * clang / clang++ output -> error diagnostics. `note:` lines (a candidate,
 * "declared here") and warnings are not errors. A driver or linker error
 * (`clang++: error: linker command failed`) has no location.
 */
function parseClangDiagnostics(text) {
    const diagnostics = [];
    for (const raw of String(text || '').split('\n')) {
        let match = raw.match(/^(.+?):(\d+):(\d+):\s*(?:fatal\s+)?error:\s*(.+)$/);
        if (match) {
            const file = normalizeDiagnosticFile(match[1]);
            diagnostics.push({ key: `${file}|${truncate(match[4])}`, file, line: Number(match[2]) });
            continue;
        }
        match = raw.match(/^(?:\S*\/)?(?:clang(?:\+\+)?|c\+\+|g\+\+|gcc|cc|ld)(?:-[\w.]+)?:\s*error:\s*(.+)$/);
        if (match) diagnostics.push({ key: `|${truncate(match[1])}`, file: null, line: null });
    }
    return diagnostics;
}

function truncate(message) {
    return String(message || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * One judge run, located: `{ keys, diagnostics }` as classifyNewDiagnostics
 * reads it. `output` is the run's stdout and stderr as text; pyright's is
 * its `--outputjson` document. cargo/rustc and javac keys are deduplicated
 * as the outcome eval's are. A document that cannot be read gives no
 * diagnostics: the caller counts a rejected run with no error as one error
 * with no location.
 */
function locate(lang, output, root) {
    let diagnostics;
    let dedupe = false;
    switch (lang) {
        case 'ts': diagnostics = parseTscDiagnostics(output); break;
        case 'py': {
            const text = String(output || '');
            let doc;
            try { doc = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch (_) { doc = null; }
            diagnostics = doc ? parsePyrightDiagnostics(doc, root) : [];
            break;
        }
        case 'go': diagnostics = parseGoDiagnostics(output); break;
        case 'rs': diagnostics = parseCargoDiagnostics(output); dedupe = true; break;
        case 'java': diagnostics = parseJavacDiagnostics(output, root); dedupe = true; break;
        case 'cs': diagnostics = parseDotnetDiagnostics(output, root); break;
        case 'cpp': diagnostics = parseClangDiagnostics(output); break;
        default: diagnostics = [];
    }
    const keys = diagnostics.map(diagnostic => diagnostic.key);
    return { keys: dedupe ? [...new Set(keys)] : keys, diagnostics };
}

/**
 * Where the new errors of a judged change are.
 *
 * @param {{keys: string[]}} baseline - the base revision's located run
 * @param {{keys: string[], diagnostics: object[]}} judged - the change's
 * @param {Map<string, Set<number>>} writtenByFile - writtenLinesOf(case)
 * @param {boolean} rejected - the toolchain's verdict on the change
 * @returns {{newErrors, local, outside, outsideKeys, unread}} unread: the
 *   run was rejected and no new error was read (one outside error)
 */
function placeNewErrors(baseline, judged, writtenByFile, rejected) {
    const placed = classifyNewDiagnostics((baseline && baseline.keys) || [], judged, writtenRanges(writtenByFile));
    const unread = !!rejected && placed.newKeys.length === 0;
    return {
        newErrors: placed.newKeys.length + (unread ? 1 : 0),
        local: placed.inside,
        outside: placed.outside + (unread ? 1 : 0),
        outsideKeys: placed.outsideSamples,
        unread,
    };
}

/**
 * The column of one judged case.
 *
 * @param {object} row - { id, answer, judged: 'clean'|'break', placement }
 * @returns {string|null} 'false-ready' | 'ready-with-local-break' |
 *   'false-blocked' | 'over-cautious' | null
 */
function columnOf(row) {
    const passes = row.answer === READY || row.answer === NO_CHANGES;
    if (row.judged === 'break') {
        if (!passes) return null;
        return row.placement && row.placement.outside === 0 ? 'ready-with-local-break' : 'false-ready';
    }
    if (row.answer === BLOCKED) return 'false-blocked';
    return passes ? null : 'over-cautious';
}

/**
 * The columns of a run, each a sorted list of case ids, and the findings
 * that fail it.
 *
 * @param {object[]} rows - judged rows: { id, answer, judged, placement }
 * @param {object} [lists] - { knownFalseReady, readyLocalBreaks } (defaults:
 *   the lists above)
 */
function scoreRun(rows, lists = {}) {
    const knownFalseReady = lists.knownFalseReady || KNOWN_FALSE_READY;
    const readyLocalBreaks = new Set(lists.readyLocalBreaks || READY_LOCAL_BREAKS);
    const pinned = new Map(knownFalseReady.map(pin => [pin.id, pin]));
    const columns = {
        'false-ready': [], 'known-false-ready': [], 'ready-with-local-break': [],
        'ready-while-rejected': [], 'false-blocked': [], 'over-cautious': [],
    };
    const judged = new Set();
    for (const row of rows) {
        judged.add(row.id);
        const column = columnOf(row);
        if (!column) continue;
        if (column === 'false-ready' || column === 'ready-with-local-break') columns['ready-while-rejected'].push(row.id);
        if (column === 'false-ready' && pinned.has(row.id)) columns['known-false-ready'].push(row.id);
        else columns[column].push(row.id);
    }
    for (const list of Object.values(columns)) list.sort(codeUnitCompare);
    const isFalseReady = new Set([...columns['false-ready'], ...columns['known-false-ready']]);
    const failures = [];
    for (const id of columns['false-ready']) failures.push(`FALSE-READY ${id}`);
    for (const id of columns['false-blocked']) failures.push(`FALSE-BLOCKED ${id}`);
    for (const pin of knownFalseReady) {
        if (judged.has(pin.id) && !isFalseReady.has(pin.id)) {
            failures.push(`stale known false-ready pin ${pin.id}: the case is not false-ready; remove the pin`);
        }
    }
    // The list of READY local breaks is held to the pinned answers by the
    // check-change-kinds test; the run reports where it disagrees and does
    // not fail on a column it only reports.
    const notices = [];
    const local = new Set(columns['ready-with-local-break']);
    for (const id of columns['ready-with-local-break']) {
        if (!readyLocalBreaks.has(id)) notices.push(`READY with a local break, not listed: ${id}`);
    }
    for (const id of [...readyLocalBreaks].sort(codeUnitCompare)) {
        if (judged.has(id) && !local.has(id)) notices.push(`listed as READY with a local break, and it is not: ${id}`);
    }
    return { columns, failures, notices };
}

module.exports = {
    KNOWN_FALSE_READY,
    READY_LOCAL_BREAKS,
    writtenLines,
    writtenLinesOf,
    writtenRanges,
    parseDotnetDiagnostics,
    parseClangDiagnostics,
    locate,
    placeNewErrors,
    columnOf,
    scoreRun,
};
