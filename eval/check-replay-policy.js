/**
 * eval/check-replay-policy.js - Pure logic for the history replay of the
 * pre-commit check (eval/run-check-replay.js).
 *
 * The replay puts a worktree at an upstream commit and asks
 * `check --base=<first parent> --json`. Upstream history on a default
 * branch is code its project accepted, so a BLOCKED answer is a false block
 * unless the pinned list marks that commit as a known break with the
 * toolchain diagnostic that shows it. This module holds everything that can
 * be pure: validating the pinned list, reading one CLI answer into a scored
 * row, the gate's findings, the rates, the lever list and the Markdown
 * rollup. No filesystem, no child processes.
 *
 * Ordering is explicit everywhere (code-unit comparison, never locale), so
 * the same answers give byte-identical scored fields.
 */

'use strict';

const STATUS = Object.freeze({
    ready: 'READY_FOR_TOOLCHAIN',
    review: 'REVIEW_REQUIRED',
    blocked: 'BLOCKED',
    noVerdict: 'NO-VERDICT',
    error: 'ERROR',
});
const CHECK_STATUSES = Object.freeze([STATUS.ready, STATUS.review, STATUS.blocked]);
const ROW_STATUSES = Object.freeze([...CHECK_STATUSES, STATUS.noVerdict, STATUS.error]);
const VERDICTS = Object.freeze(['ready', 'review', 'blocked']);
const ITEM_KINDS = Object.freeze(['added', 'modified', 'deleted', 'module']);
const SHA = /^[0-9a-f]{40}$/;
const REPO_NAME = /^[a-z0-9][a-z0-9_.-]*$/;
const EXPRESSION_LIMIT = 160;
const MISMATCH_FIELDS = Object.freeze(['file', 'line', 'column', 'target', 'expression',
    'expected', 'actual', 'problem', 'reason', 'unchecked']);
const SITE_FIELDS = Object.freeze(['file', 'line', 'kind', 'unchecked']);

function codeUnitCompare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

function round(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

/** part / whole rounded to four digits; null when there is nothing to divide. */
function share(part, whole) {
    return whole > 0 ? round(part / whole) : null;
}

/** The four item kinds of a check answer first, any other kind after them by name. */
function compareKinds(a, b) {
    const ia = ITEM_KINDS.indexOf(a);
    const ib = ITEM_KINDS.indexOf(b);
    if (ia >= 0 || ib >= 0) {
        if (ia < 0) return 1;
        if (ib < 0) return -1;
        return ia - ib;
    }
    return codeUnitCompare(a, b);
}

function firstLine(text) {
    return String(text == null ? '' : text).split('\n')[0].trim().slice(0, 200);
}

function errorRow(error) {
    return { status: STATUS.error, error };
}

/**
 * Problems with the pinned list, as sentences; empty when it is usable.
 * Every repository has a name, an https URL and at least one pinned commit;
 * each commit and its parent are full SHAs, no commit is pinned twice, and
 * every known break names a pinned commit and states its evidence.
 */
function validateReplayList(repos) {
    if (!Array.isArray(repos) || repos.length === 0) return ['the pinned list names no repository'];
    const problems = [];
    const names = new Set();
    for (const repo of repos) {
        if (!repo || typeof repo.name !== 'string' || !REPO_NAME.test(repo.name)) {
            problems.push(`invalid repository name ${JSON.stringify(repo && repo.name)}`);
            continue;
        }
        if (names.has(repo.name)) problems.push(`${repo.name}: listed twice`);
        names.add(repo.name);
        if (typeof repo.url !== 'string' || !/^https:\/\/\S+$/.test(repo.url)) {
            problems.push(`${repo.name}: the URL must be an https URL`);
        }
        if (!Array.isArray(repo.commits) || repo.commits.length === 0) {
            problems.push(`${repo.name}: no commit is pinned`);
            continue;
        }
        const pinned = new Set();
        for (const row of repo.commits) {
            if (!row || !SHA.test(row.commit || '') || !SHA.test(row.parent || '')) {
                problems.push(`${repo.name}: a commit and its parent must be full lowercase SHAs (${JSON.stringify(row)})`);
                continue;
            }
            if (row.commit === row.parent) problems.push(`${repo.name}: ${row.commit} is pinned as its own parent`);
            if (pinned.has(row.commit)) problems.push(`${repo.name}: ${row.commit} is pinned twice`);
            pinned.add(row.commit);
        }
        const marks = repo.knownBreaks === undefined ? [] : repo.knownBreaks;
        if (!Array.isArray(marks)) {
            problems.push(`${repo.name}: knownBreaks must be a list`);
            continue;
        }
        const marked = new Set();
        for (const mark of marks) {
            const commit = mark && mark.commit;
            if (!pinned.has(commit)) problems.push(`${repo.name}: known break ${commit} is not a pinned commit`);
            if (!mark || typeof mark.evidence !== 'string' || !mark.evidence.trim()) {
                problems.push(`${repo.name}: known break ${commit} states no toolchain evidence`);
            }
            if (marked.has(commit)) problems.push(`${repo.name}: known break ${commit} is marked twice`);
            marked.add(commit);
        }
    }
    return problems;
}

function pick(source, fields) {
    const out = {};
    for (const field of fields) {
        if (source[field] === undefined || source[field] === null) continue;
        out[field] = field === 'expression'
            ? String(source[field]).replace(/\s+/g, ' ').trim().slice(0, EXPRESSION_LIMIT)
            : source[field];
    }
    return out;
}

function compareLocation(a, b) {
    return codeUnitCompare(String(a.file || ''), String(b.file || '')) ||
        (Number(a.line) || 0) - (Number(b.line) || 0) ||
        codeUnitCompare(String(a.name || ''), String(b.name || '')) ||
        codeUnitCompare(String(a.kind || ''), String(b.kind || ''));
}

function compareReasonSets(a, b) {
    return b.items - a.items || compareKinds(a.kind, b.kind) ||
        codeUnitCompare(a.reasons.join('\0'), b.reasons.join('\0'));
}

function compareOutgoing(a, b) {
    return b.calls - a.calls || codeUnitCompare(a.reason, b.reason);
}

/**
 * One check answer (the `data` of `check --json`) as a scored row: the
 * status, verdict counts per item kind, the reason set of every item that
 * is not ready, the outgoing-call reasons with their call counts, and each
 * blocked item with its mismatch rows and sites. "No changes" is a row of
 * its own (NO-VERDICT). Anything that is not a well-formed check answer is
 * an ERROR row with a stable reason, never a dropped row.
 */
function summarizeCheck(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return errorRow('no check answer in the output');
    if (data.ok === false) {
        return errorRow(`check did not run (${data.status || 'no status'}): ${firstLine(data.error)}`);
    }
    if (data.ok === true && data.empty === true) {
        return { status: STATUS.noVerdict, noVerdictReason: firstLine(data.reason) };
    }
    const trust = data.trust;
    const status = trust && trust.status;
    if (!CHECK_STATUSES.includes(status)) return errorRow(`unknown check status ${JSON.stringify(status === undefined ? null : status)}`);
    if (!Array.isArray(data.changed)) return errorRow('the check answer has no changed list');

    const counts = new Map();
    const sets = new Map();
    const outgoing = new Map();
    const blocked = [];
    const verdicts = { ready: 0, review: 0, blocked: 0 };
    for (const item of data.changed) {
        if (!item || typeof item.kind !== 'string' || !VERDICTS.includes(item.verdict)) {
            return errorRow(`a changed item has kind ${JSON.stringify(item && item.kind)} and verdict ${JSON.stringify(item && item.verdict)}`);
        }
        verdicts[item.verdict]++;
        if (!counts.has(item.kind)) counts.set(item.kind, { ready: 0, review: 0, blocked: 0 });
        counts.get(item.kind)[item.verdict]++;
        const outgoingCalls = item.outgoingCalls && item.outgoingCalls.reasons;
        if (outgoingCalls !== undefined) {
            if (!Array.isArray(outgoingCalls)) return errorRow(`${item.name}: outgoing-call reasons are not a list`);
            for (const entry of outgoingCalls) {
                if (!entry || typeof entry.reason !== 'string' || !Number.isInteger(entry.calls) || entry.calls < 0) {
                    return errorRow(`${item.name}: an outgoing-call reason is malformed`);
                }
                outgoing.set(entry.reason, (outgoing.get(entry.reason) || 0) + entry.calls);
            }
        }
        if (item.verdict === 'ready') continue;
        const reasons = [...new Set(Array.isArray(item.reasons) ? item.reasons.map(String) : [])].sort(codeUnitCompare);
        const key = `${item.kind}\0${reasons.join('\0')}`;
        if (!sets.has(key)) sets.set(key, { kind: item.kind, reasons, items: 0 });
        sets.get(key).items++;
        if (item.verdict === 'blocked') {
            blocked.push({
                kind: item.kind,
                name: String(item.name),
                file: String(item.file || ''),
                line: Number(item.line) || 0,
                reasons: Array.isArray(item.reasons) ? item.reasons.map(String) : [],
                mismatches: (Array.isArray(item.mismatches) ? item.mismatches : [])
                    .map(row => pick(row || {}, MISMATCH_FIELDS)).sort(compareLocation),
                sites: (Array.isArray(item.sites) ? item.sites : [])
                    .map(row => pick(row || {}, SITE_FIELDS)).sort(compareLocation),
            });
        }
    }
    // The answer must agree with itself: the trust counts are the item
    // verdicts and the status is the worst of them.
    if (trust.blocked !== verdicts.blocked || trust.review !== verdicts.review || trust.ready !== verdicts.ready) {
        return errorRow('the trust counts disagree with the changed items');
    }
    const worst = verdicts.blocked > 0 ? STATUS.blocked
        : (verdicts.review > 0 || data.truncated) ? STATUS.review : STATUS.ready;
    if (worst !== status) return errorRow(`status ${status} disagrees with the item verdicts (${worst})`);

    const items = {};
    for (const kind of [...counts.keys()].sort(compareKinds)) items[kind] = counts.get(kind);
    return {
        status,
        items,
        reasonSets: [...sets.values()].sort(compareReasonSets),
        outgoingReasons: [...outgoing].map(([reason, calls]) => ({ reason, calls })).sort(compareOutgoing),
        blocked: blocked.sort(compareLocation),
    };
}

/**
 * One CLI run as a scored row. A run that could not start, timed out, was
 * stopped, printed no JSON, or exited with a code its answer does not
 * explain (1 for BLOCKED, 0 otherwise) is an ERROR row.
 */
function readCliRun({ exitCode, signal, stdout, timedOut, spawnError }) {
    if (timedOut) return errorRow('the CLI did not finish within the time limit');
    if (spawnError) return errorRow(`the CLI could not run (${spawnError})`);
    if (signal) return errorRow(`the CLI was stopped by ${signal}`);
    let doc;
    try {
        doc = JSON.parse(stdout);
    } catch (_) {
        return errorRow(`the CLI exited ${exitCode} without JSON output`);
    }
    if (!doc || typeof doc !== 'object' || !Object.hasOwn(doc, 'data')) {
        return errorRow(`the CLI exited ${exitCode} without a data field`);
    }
    const row = summarizeCheck(doc.data);
    if (row.status === STATUS.error) return row;
    const expected = row.status === STATUS.blocked ? 1 : 0;
    if (exitCode !== expected) return errorRow(`the CLI exited ${exitCode} for ${row.status}`);
    return row;
}

/**
 * Rates over replayed rows: commit shares by status, READY share of items
 * by kind, the reason sets of items that are not ready, the lever list,
 * and the outgoing-call reasons with their call counts.
 */
function summarizeRows(rows) {
    const statuses = {};
    for (const status of ROW_STATUSES) statuses[status] = 0;
    const kinds = new Map();
    const sets = new Map();
    const outgoing = new Map();
    for (const row of rows) {
        statuses[ROW_STATUSES.includes(row.status) ? row.status : STATUS.error]++;
        for (const [kind, counts] of Object.entries(row.items || {})) {
            if (!kinds.has(kind)) kinds.set(kind, { ready: 0, review: 0, blocked: 0 });
            const total = kinds.get(kind);
            for (const verdict of VERDICTS) total[verdict] += counts[verdict] || 0;
        }
        for (const set of row.reasonSets || []) {
            const key = `${set.kind}\0${set.reasons.join('\0')}`;
            if (!sets.has(key)) sets.set(key, { kind: set.kind, reasons: [...set.reasons], items: 0 });
            sets.get(key).items += set.items;
        }
        for (const entry of row.outgoingReasons || []) {
            outgoing.set(entry.reason, (outgoing.get(entry.reason) || 0) + entry.calls);
        }
    }
    const commits = rows.length;
    const items = {};
    for (const kind of [...kinds.keys()].sort(compareKinds)) {
        const counts = kinds.get(kind);
        const total = counts.ready + counts.review + counts.blocked;
        items[kind] = { ...counts, total, readyShare: share(counts.ready, total) };
    }
    const reasonSets = [...sets.values()].sort(compareReasonSets);
    return {
        commits,
        statuses,
        shares: {
            ready: share(statuses[STATUS.ready], commits),
            review: share(statuses[STATUS.review], commits),
            blocked: share(statuses[STATUS.blocked], commits),
            noVerdict: share(statuses[STATUS.noVerdict], commits),
            error: share(statuses[STATUS.error], commits),
        },
        items,
        reasonSets,
        levers: leverList(reasonSets),
        outgoingReasons: [...outgoing].map(([reason, calls]) => ({ reason, calls })).sort(compareOutgoing),
    };
}

/**
 * Which single reason, if settled, frees the most items: per reason, the
 * items it holds alone (their whole reason set is that reason) and every
 * item whose set contains it. Ranked by items held alone, then by items
 * holding it, then by name.
 */
function leverList(reasonSets) {
    const byReason = new Map();
    for (const set of reasonSets) {
        for (const reason of set.reasons) {
            if (!byReason.has(reason)) byReason.set(reason, { reason, alone: 0, total: 0 });
            const entry = byReason.get(reason);
            entry.total += set.items;
            if (set.reasons.length === 1) entry.alone += set.items;
        }
    }
    return [...byReason.values()].sort((a, b) =>
        b.alone - a.alone || b.total - a.total || codeUnitCompare(a.reason, b.reason));
}

/**
 * The gate's findings over replayed rows ({ repo, commit, status, error,
 * blocked }) against the pinned list:
 *   blockedFailures  BLOCKED on a commit no known break names;
 *   knownBreaks      BLOCKED on a commit a known break names (held);
 *   stalePins        a known break whose commit was replayed and answered
 *                    anything but BLOCKED (an ERROR row is reported as an
 *                    error, not as a stale pin);
 *   unjudgedPins     a known break whose commit this run did not replay;
 *   errors           ERROR rows.
 * `failures` lists what fails the gate: list problems, a run that replayed
 * nothing, blocked failures, stale pins and error rows.
 */
function evaluateReplay(rows, repos) {
    const listProblems = validateReplayList(repos);
    const order = new Map();
    for (const repo of repos || []) {
        for (const [index, row] of (repo.commits || []).entries()) order.set(`${repo.name}\0${row.commit}`, index);
    }
    const byPinnedOrder = (a, b) => codeUnitCompare(a.repo, b.repo) ||
        (order.get(`${a.repo}\0${a.commit}`) ?? Infinity) - (order.get(`${b.repo}\0${b.commit}`) ?? Infinity) ||
        codeUnitCompare(a.commit, b.commit);
    const pins = new Map();
    for (const repo of repos || []) {
        for (const mark of Array.isArray(repo.knownBreaks) ? repo.knownBreaks : []) {
            if (mark && typeof mark.commit === 'string') {
                pins.set(`${repo.name}\0${mark.commit}`, { repo: repo.name, commit: mark.commit, evidence: mark.evidence });
            }
        }
    }
    const replayed = new Map(rows.map(row => [`${row.repo}\0${row.commit}`, row]));
    const blockedFailures = [];
    const knownBreaks = [];
    const errors = [];
    for (const row of rows) {
        const key = `${row.repo}\0${row.commit}`;
        if (row.status === STATUS.blocked) {
            if (pins.has(key)) knownBreaks.push(pins.get(key));
            else blockedFailures.push({ repo: row.repo, commit: row.commit, blocked: row.blocked || [] });
        } else if (row.status === STATUS.error || !ROW_STATUSES.includes(row.status)) {
            errors.push({ repo: row.repo, commit: row.commit, error: row.error || `unknown row status ${row.status}` });
        }
    }
    const stalePins = [];
    const unjudgedPins = [];
    for (const [key, pin] of pins) {
        const row = replayed.get(key);
        if (!row) unjudgedPins.push({ repo: pin.repo, commit: pin.commit });
        else if (row.status !== STATUS.blocked && row.status !== STATUS.error) {
            stalePins.push({ repo: pin.repo, commit: pin.commit, status: row.status });
        }
    }
    for (const list of [blockedFailures, knownBreaks, errors, stalePins, unjudgedPins]) list.sort(byPinnedOrder);

    const failures = listProblems.map(problem => `pinned list: ${problem}`);
    if (rows.length === 0) failures.push('no commit was replayed');
    for (const row of blockedFailures) {
        const names = row.blocked.map(item => `${item.name} (${item.kind})`);
        failures.push(`${row.repo} ${row.commit}: BLOCKED on an accepted upstream commit` +
            (names.length ? `: ${names.join(', ')}` : ''));
    }
    for (const pin of stalePins) {
        failures.push(`${pin.repo} ${pin.commit}: marked as a known break and answered ${pin.status}; remove the mark`);
    }
    for (const row of errors) failures.push(`${row.repo} ${row.commit}: error row: ${row.error}`);
    return { blockedFailures, knownBreaks, stalePins, unjudgedPins, errors, failures };
}

function fraction(part, whole) {
    return whole > 0 ? `${part}/${whole} (${share(part, whole)})` : '-';
}

function mismatchText(row) {
    const where = row.file ? `${row.file}:${row.line}` : '';
    const callee = row.target ? ` ${row.target}:` : '';
    const expression = row.expression ? ` \`${row.expression.replace(/`/g, "'")}\`` : '';
    const problem = row.problem || (row.expected !== undefined
        ? `expected ${row.expected}, got ${row.actual}` : (row.reason || 'mismatch'));
    return `${where}${expression}${callee} ${problem}${row.unchecked ? ' (unchecked)' : ''}`;
}

/**
 * The dated Markdown rollup over per-repository reports ({ repo, scored }).
 * Repositories by name; every list in the order the scored fields hold.
 */
function formatRollup(reports, { date, cli, limit, top = 15 } = {}) {
    const sorted = [...reports].sort((a, b) => codeUnitCompare(a.repo, b.repo));
    const allRows = sorted.flatMap(report => report.scored.rows.map(row => ({ ...row, repo: report.repo })));
    const overall = summarizeRows(allRows);
    const lines = [];
    lines.push(`# Check replay - ${date}`, '');
    lines.push('Upstream commits replayed through `check --base=<first parent> --json`. ' +
        'An accepted commit answered BLOCKED is a false block unless the pinned list marks it as a known break ' +
        'with its toolchain diagnostic.', '');
    lines.push(`CLI: ${cli || 'tree'}. Commits per repository: ${limit ? `first ${limit} pinned` : 'all pinned'}.`, '');

    lines.push('## Commits by status', '');
    lines.push('| Repository | Commits | READY | REVIEW | BLOCKED | NO-VERDICT | ERROR | READY share |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    const statusRow = (label, summary) => {
        const s = summary.statuses;
        lines.push(`| ${label} | ${summary.commits} | ${s[STATUS.ready]} | ${s[STATUS.review]} | ` +
            `${s[STATUS.blocked]} | ${s[STATUS.noVerdict]} | ${s[STATUS.error]} | ` +
            `${summary.shares.ready === null ? '-' : summary.shares.ready} |`);
    };
    for (const report of sorted) statusRow(report.repo, report.scored.summary);
    statusRow('**all**', overall);
    lines.push('');

    const kinds = Object.keys(overall.items);
    lines.push('## READY share of items by kind', '');
    if (kinds.length === 0) {
        lines.push('No changed items.', '');
    } else {
        lines.push(`| Repository | ${kinds.join(' | ')} |`);
        lines.push(`|---|${kinds.map(() => '---:').join('|')}|`);
        const kindRow = (label, summary) => lines.push(`| ${label} | ${kinds.map(kind => {
            const counts = summary.items[kind];
            return counts ? fraction(counts.ready, counts.total) : '-';
        }).join(' | ')} |`);
        for (const report of sorted) kindRow(report.repo, report.scored.summary);
        kindRow('**all**', overall);
        lines.push('');
        if (kinds.includes('module')) {
            lines.push('`check` lists a module item only when the module change is not READY, ' +
                'so the module column has a READY share of 0 by construction.', '');
        }
    }

    const findings = key => sorted.flatMap(report => report.scored.evaluation[key]);
    lines.push('## Gate findings', '');
    const blocked = findings('blockedFailures');
    lines.push(`- Blocked on accepted history: ${blocked.length || 'none'}`);
    for (const row of blocked) {
        lines.push(`  - ${row.repo} ${row.commit}`);
        for (const item of row.blocked) {
            lines.push(`    - ${item.name} (${item.kind}, ${item.file}:${item.line}): ${item.reasons.join(', ')}`);
            for (const mismatch of item.mismatches) lines.push(`      - ${mismatchText(mismatch)}`);
            for (const site of item.sites) lines.push(`      - ${site.file}${site.line ? `:${site.line}` : ''}${site.kind ? ` ${site.kind}` : ''}`);
        }
    }
    const known = findings('knownBreaks');
    lines.push(`- Known breaks held: ${known.length || 'none'}`);
    for (const pin of known) lines.push(`  - ${pin.repo} ${pin.commit}: ${pin.evidence}`);
    const stale = findings('stalePins');
    lines.push(`- Stale known-break marks: ${stale.length || 'none'}`);
    for (const pin of stale) lines.push(`  - ${pin.repo} ${pin.commit}: answered ${pin.status}`);
    const errors = findings('errors');
    lines.push(`- Error rows: ${errors.length || 'none'}`);
    for (const row of errors) lines.push(`  - ${row.repo} ${row.commit}: ${row.error}`);
    const unjudged = findings('unjudgedPins');
    if (unjudged.length) {
        lines.push(`- Known-break marks not replayed: ${unjudged.length}`);
        for (const pin of unjudged) lines.push(`  - ${pin.repo} ${pin.commit}`);
    }
    lines.push('');

    lines.push('## Levers: reasons that alone hold an item', '');
    if (overall.levers.length === 0) {
        lines.push('No item is held by a reason.', '');
    } else {
        lines.push('| Reason | Items it alone holds | Items it holds |', '|---|---:|---:|');
        for (const lever of overall.levers.slice(0, top)) lines.push(`| ${lever.reason} | ${lever.alone} | ${lever.total} |`);
        if (overall.levers.length > top) lines.push(`| (+${overall.levers.length - top} more) | | |`);
        lines.push('');
    }

    lines.push('## Reason sets of items that are not READY', '');
    if (overall.reasonSets.length === 0) {
        lines.push('None.', '');
    } else {
        lines.push('| Kind | Reasons | Items |', '|---|---|---:|');
        for (const set of overall.reasonSets.slice(0, top)) {
            lines.push(`| ${set.kind} | ${set.reasons.length ? set.reasons.join(' + ') : '(no reason)'} | ${set.items} |`);
        }
        if (overall.reasonSets.length > top) lines.push(`| (+${overall.reasonSets.length - top} more) | | |`);
        lines.push('');
    }

    lines.push('## Outgoing-call reasons', '');
    if (overall.outgoingReasons.length === 0) {
        lines.push('None.', '');
    } else {
        lines.push('| Reason | Calls |', '|---|---:|');
        for (const entry of overall.outgoingReasons) lines.push(`| ${entry.reason} | ${entry.calls} |`);
        lines.push('');
    }
    return lines.join('\n');
}

module.exports = {
    STATUS,
    ITEM_KINDS,
    codeUnitCompare,
    validateReplayList,
    summarizeCheck,
    readCliRun,
    summarizeRows,
    leverList,
    evaluateReplay,
    formatRollup,
};
