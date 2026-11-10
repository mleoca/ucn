/**
 * core/source-universe.js - What a completeness claim ranges over.
 *
 * An index analyzes the files it parsed. A "text partition complete" claim
 * is about more than those: it says no other occurrence of the name exists
 * in the project's source. This module is the single owner of that second
 * set. Every discovered path that is not an indexed file falls into exactly
 * one class:
 *
 *   text-only  readable source UCN does not analyze: an unsupported
 *              language, a bundled/minified file, a file over the size
 *              limit, a file beyond the file limit, a path the project's
 *              `.ucn.json` excludes from indexing. It is word-scanned per
 *              name, and it weakens a claim only for a name that occurs
 *              in it.
 *   opaque     a path whose contents cannot be read name by name: an
 *              unreadable file or directory, a directory past the depth
 *              limit, a failed git listing, an unusable config, text beyond
 *              the scan budget. Nothing can be said about any name, so it
 *              withdraws the claim for every name.
 *   outside    not project source by declaration or by kind: the default
 *              ignores, .gitignore, `.ucn.json` `outsideProject`, source
 *              maps (data). It is no part of the claim and is stated in the
 *              repository's scope summary.
 *
 * Consumers (accounts, dead-code coverage, command notes, health, check)
 * read this model. None of them interprets raw discovery issues.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { codeUnitCompare, literalNameRegex } = require('./shared');

/** Total bytes of text-only source scanned per name. Text past the budget
 *  becomes opaque: the limit is a property of the repository, never of the
 *  query, so the same name gets the same answer every time. */
const DEFAULT_TEXT_SCAN_BUDGET = 256 * 1024 * 1024;

/** A text-only file up to this size is read whole (and shared within one
 *  operation); a larger one is streamed and never retained. */
const WHOLE_FILE_BYTES = 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;

const SITE_CAP = 50;
const SITE_TEXT_MAX = 160;

const TEXT_ONLY_ISSUES = new Set(['bundled', 'config-exclude', 'max-file-size', 'max-files']);

/** How a text-only class is named in an answer. An unsupported-language
 *  file is named by its language instead. */
const REASON_LABELS = Object.freeze({
    'bundled': 'bundled/minified',
    'config-exclude': 'excluded by .ucn.json',
    'max-file-size': 'over the file-size limit',
    'max-files': 'beyond the file limit',
    'unsupported-language': 'unsupported language',
});

function isSourceMap(relativePath) {
    return relativePath.endsWith('.map');
}

function scanBudget(index) {
    const configured = index.config && index.config.textScanBudgetBytes;
    return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_TEXT_SCAN_BUDGET;
}

/**
 * Classify every non-indexed path of the index. Memoized per build: the
 * result is a function of the discovery facts and the files' sizes.
 *
 * @returns {{
 *   textOnly: Array<{relativePath, reason, label, size, mtimeMs}>,  // path order
 *   opaque: Array<{relativePath, kind, reason, detail}>,
 *   outside: Array<{relativePath, kind, reason}>,
 *   budget: {limitBytes, usedBytes},
 * }}
 */
function universe(index) {
    if (index._sourceUniverse) return index._sourceUniverse;
    const candidates = new Map();
    const opaque = [];
    const outside = [];
    for (const file of index.unsupportedFiles || []) {
        candidates.set(file.relativePath, {
            relativePath: file.relativePath,
            reason: 'unsupported-language',
            label: file.language || file.extension || 'unknown',
        });
    }
    for (const issue of index.discoveryIssues || []) {
        const relativePath = issue.relativePath || '.';
        if (issue.reason === 'outside-project' ||
            (issue.reason === 'bundled' && isSourceMap(relativePath))) {
            outside.push({
                relativePath,
                kind: issue.kind,
                reason: issue.reason === 'bundled' ? 'source-map' : issue.reason,
            });
            continue;
        }
        if (TEXT_ONLY_ISSUES.has(issue.reason) && issue.kind === 'file') {
            if (!candidates.has(relativePath)) {
                candidates.set(relativePath, {
                    relativePath,
                    reason: issue.reason,
                    label: REASON_LABELS[issue.reason],
                });
            }
            continue;
        }
        opaque.push({
            relativePath, kind: issue.kind, reason: issue.reason, detail: issue.detail,
        });
    }

    // Sizes decide the budget. A candidate that cannot be read as a file
    // (missing, not a regular file, no read permission) is opaque, like any
    // other unreadable path. Every candidate keeps its stat, whatever class
    // it ends in: an edit to ANY of them can change the budget assignment.
    const sized = [];
    const candidateStats = [];
    for (const entry of candidates.values()) {
        const stat = readableStat(path.join(index.root, entry.relativePath));
        candidateStats.push({
            relativePath: entry.relativePath, reason: entry.reason,
            size: stat.size, mtimeMs: stat.mtimeMs, readable: stat.readable,
        });
        if (stat.readable) {
            sized.push({ ...entry, size: stat.size, mtimeMs: stat.mtimeMs });
        } else {
            opaque.push({
                relativePath: entry.relativePath, kind: 'file',
                reason: 'unreadable-file', detail: stat.detail,
            });
        }
    }
    // Smallest first, then path: the largest files are the ones a budget
    // gives up, and the assignment depends on nothing but the file table.
    sized.sort((a, b) => a.size - b.size || codeUnitCompare(a.relativePath, b.relativePath));
    const limitBytes = scanBudget(index);
    let usedBytes = 0;
    const textOnly = [];
    for (const entry of sized) {
        if (usedBytes + entry.size > limitBytes) {
            opaque.push({
                relativePath: entry.relativePath, kind: 'file', reason: 'text-scan-budget',
                detail: `text-only source beyond the ${limitBytes}-byte scan budget`,
            });
            continue;
        }
        usedBytes += entry.size;
        textOnly.push(entry);
    }
    const byPath = (a, b) => codeUnitCompare(a.relativePath, b.relativePath);
    textOnly.sort(byPath);
    opaque.sort((a, b) => byPath(a, b) || codeUnitCompare(a.reason, b.reason));
    outside.sort(byPath);
    index._sourceUniverse = {
        textOnly, opaque, outside, budget: { limitBytes, usedBytes },
        candidates: candidateStats,
    };
    return index._sourceUniverse;
}

/** Size, mtime and readability of a text-only candidate, without throwing. */
function readableStat(absolutePath) {
    try {
        const stat = fs.statSync(absolutePath);
        if (!stat.isFile()) {
            return { readable: false, size: null, mtimeMs: null, detail: 'not a regular file' };
        }
        fs.accessSync(absolutePath, fs.constants.R_OK);
        return { readable: true, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch (error) {
        return { readable: false, size: null, mtimeMs: null, detail: error.message };
    }
}

/**
 * A text-only file that could not be read when it was scanned: it is opaque
 * from here on, so the same answer and every later one say that part of the
 * project could not be searched. A read failure never just drops a file
 * from an answer.
 */
function demoteToOpaque(index, entry, error) {
    const model = universe(index);
    const at = model.textOnly.findIndex(item => item.relativePath === entry.relativePath);
    if (at === -1) return;
    model.textOnly.splice(at, 1);
    model.budget.usedBytes -= entry.size || 0;
    model.opaque.push({
        relativePath: entry.relativePath, kind: 'file', reason: 'unreadable-file',
        detail: error && error.message ? error.message : 'read failed',
    });
    model.opaque.sort((a, b) => codeUnitCompare(a.relativePath, b.relativePath) ||
        codeUnitCompare(a.reason, b.reason));
    // Scans made while it still counted as searchable are not reusable.
    index._groundSetCache = new Map();
    index._groundSetCacheLines = 0;
}

/** Drop the memoized universe (a build, a cache load, a refreshed file). */
function resetUniverse(index) {
    index._sourceUniverse = null;
}

// ── Scanning ────────────────────────────────────────────────────────────────

/** Decoded text of a file in bounded pieces. */
function* streamChunks(absolutePath) {
    const descriptor = fs.openSync(absolutePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
        const decoder = new StringDecoder('utf8');
        for (;;) {
            const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            if (read === 0) break;
            yield decoder.write(buffer.subarray(0, read));
        }
        const rest = decoder.end();
        if (rest) yield rest;
    } finally {
        fs.closeSync(descriptor);
    }
}

function* textOnlyChunks(index, absolutePath, size) {
    if (size <= WHOLE_FILE_BYTES) {
        yield index._readFile(absolutePath);
        return;
    }
    yield* streamChunks(absolutePath);
}

/** The matched line as an answer shows it: the whole line when it is short,
 *  a window around the match when it is not (a minified file is one line). */
function siteText(text, at, nameLength) {
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    let lineEnd = text.indexOf('\n', at);
    if (lineEnd === -1) lineEnd = text.length;
    if (lineEnd - lineStart <= SITE_TEXT_MAX) {
        return text.slice(lineStart, lineEnd).trim().slice(0, SITE_TEXT_MAX);
    }
    let from = Math.max(lineStart, at - 60);
    let to = Math.min(lineEnd, from + SITE_TEXT_MAX);
    // A window edge never falls inside a character.
    if (from > lineStart && isLowSurrogate(text.charCodeAt(from))) from++;
    if (to < lineEnd && isHighSurrogate(text.charCodeAt(to - 1))) to--;
    return text.slice(from, to).trim();
}

/**
 * Lines of a text on which `name` occurs as a whole word, over any chunking
 * of that text. Semantics are those of the ground set (`grep -n -w`): the
 * unit is the line, a line counts once, boundaries are `literalNameRegex`'s.
 *
 * A match is decided only when the characters around it are in hand: the
 * scanner holds back the tail of a chunk until the next one arrives, and
 * keeps a short prefix so a boundary and a site window never straddle a
 * dropped edge.
 *
 * onMatch(line, text) is called once per matching line, in line order.
 */
function scanChunksForName(chunks, name, onMatch) {
    if (!name || name.includes('\n')) return;
    const wordRe = literalNameRegex(name, 'y');
    // Post-context held back: the match, one boundary character (two code
    // units for an astral one) and the rest of a short line for the site.
    const hold = name.length + SITE_TEXT_MAX + 96;
    const keepBefore = SITE_TEXT_MAX + 96;
    let text = '';
    let cursor = 0;       // next index to search from
    let counted = 0;      // newlines are counted up to this index
    let line = 1;         // line number at `counted`
    let lastLine = 0;     // last line reported
    let skipLine = false; // a line already matched extends past the buffer

    const lineAt = position => {
        let newline = text.indexOf('\n', counted);
        while (newline !== -1 && newline < position) {
            line++;
            newline = text.indexOf('\n', newline + 1);
        }
        counted = position;
        return line;
    };

    const drain = final => {
        const limit = final ? text.length : Math.max(0, text.length - hold);
        while (cursor < limit) {
            if (skipLine) {
                const newline = text.indexOf('\n', cursor);
                if (newline === -1 || newline >= limit) { cursor = limit; break; }
                cursor = newline + 1;
                skipLine = false;
                continue;
            }
            const at = text.indexOf(name, cursor);
            if (at === -1 || at >= limit) { cursor = limit; break; }
            wordRe.lastIndex = at;
            if (!wordRe.test(text)) {
                // A rejected candidate can overlap a later valid occurrence.
                cursor = at + 1;
                continue;
            }
            const matchedLine = lineAt(at);
            if (matchedLine !== lastLine) {
                lastLine = matchedLine;
                onMatch(matchedLine, siteText(text, at, name.length));
            }
            // The rest of this line cannot change the account.
            const newline = text.indexOf('\n', at);
            if (newline === -1 || newline >= limit) {
                skipLine = true;
                cursor = Math.min(limit, at + name.length);
            } else {
                cursor = newline + 1;
            }
        }
        if (final) return;
        // Drop the decided prefix. Newlines in it are counted first unless a
        // match beyond it already counted them.
        const drop = Math.max(0, cursor - keepBefore);
        if (drop > 0) {
            if (drop > counted) lineAt(drop);
            text = text.slice(drop);
            cursor -= drop;
            counted -= drop;
        }
    };

    for (const chunk of chunks) {
        if (!chunk) continue;
        text += chunk;
        drain(false);
    }
    drain(true);
}

const WORD_RUN = /[\p{L}\p{N}_]+/gu;
const ALL_WORD = /^[\p{L}\p{N}_]+$/u;
const WORD_CHARACTER = /^[\p{L}\p{N}_]$/u;

function isHighSurrogate(unit) { return unit >= 0xd800 && unit <= 0xdbff; }
function isLowSurrogate(unit) { return unit >= 0xdc00 && unit <= 0xdfff; }

/**
 * Where the word that touches the end of `text` starts: everything from
 * there on may continue in the next piece and must be held back. Walks
 * CODE POINTS, never UTF-16 units: a letter outside the BMP is two units,
 * neither of which is a letter on its own, so a unit-wise walk stops inside
 * it and splits the word (`a𐐀` + `b` read as the words `a𐐀` and `b`).
 * A lone high surrogate at the very end is half of a character still to
 * come and is held back with whatever word precedes it.
 */
function trailingWordStart(text) {
    let end = text.length;
    if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end--;
    while (end > 0) {
        const size = end >= 2 && isLowSurrogate(text.charCodeAt(end - 1)) &&
            isHighSurrogate(text.charCodeAt(end - 2)) ? 2 : 1;
        if (!WORD_CHARACTER.test(text.slice(end - size, end))) break;
        end -= size;
    }
    return end;
}

/**
 * Which of `names` occur as whole words in a text, in one pass. A name made
 * only of word characters occurs exactly when a maximal word run equals it,
 * which is `literalNameRegex`'s boundary rule; any other name is scanned on
 * its own with that regex. Returns the Set of names found.
 */
function scanChunksForNames(makeChunks, names) {
    const wordNames = new Set();
    const otherNames = [];
    for (const name of names) {
        if (ALL_WORD.test(name)) wordNames.add(name);
        else if (name) otherNames.push(name);
    }
    const found = new Set();
    if (wordNames.size > 0) {
        let carry = '';
        const collect = (text, final) => {
            // A run touching the end of a non-final piece may continue.
            const end = final ? text.length : trailingWordStart(text);
            const head = text.slice(0, end);
            for (const run of head.match(WORD_RUN) || []) {
                if (wordNames.has(run)) found.add(run);
            }
            return text.slice(end);
        };
        for (const chunk of makeChunks()) carry = collect(carry + chunk, false);
        collect(carry, true);
    }
    for (const name of otherNames) {
        let hit = false;
        scanChunksForName(makeChunks(), name, () => { hit = true; });
        if (hit) found.add(name);
    }
    return found;
}

/**
 * The `unsupported` account bucket: lines of text-only source on which the
 * name occurs. Shared by computeGroundSet and by commands whose result is
 * not account-shaped (find, usages, tests, search) but must not stay silent
 * about an occurrence UCN cannot analyze.
 *
 * @param {object} index - ProjectIndex
 * @param {string} name
 * @returns {{fileCount, lines, files, languages, reasons, sites, sitesTruncated}}
 */
function scanTextOnly(index, name) {
    const bucket = {
        fileCount: 0, lines: 0, files: [], languages: {}, reasons: {},
        sites: [], sitesTruncated: false,
    };
    const { textOnly } = universe(index);
    if (textOnly.length === 0 || !name) return bucket;
    const languages = new Map();
    const reasons = new Map();
    for (const entry of [...textOnly]) {
        const absolutePath = path.join(index.root, entry.relativePath);
        let matched = 0;
        const sites = [];
        try {
            scanChunksForName(textOnlyChunks(index, absolutePath, entry.size), name, (line, text) => {
                matched++;
                sites.push({ file: entry.relativePath, line, text });
            });
        } catch (error) {
            // Not searched: the path becomes opaque, the one channel every
            // consumer of this model reports (accounts, lookups, health).
            demoteToOpaque(index, entry, error);
            continue;
        }
        for (const site of sites) {
            if (bucket.sites.length < SITE_CAP) bucket.sites.push(site);
            else bucket.sitesTruncated = true;
        }
        if (matched === 0) continue;
        bucket.fileCount++;
        bucket.lines += matched;
        bucket.files.push(entry.relativePath);
        reasons.set(entry.reason, (reasons.get(entry.reason) || 0) + matched);
        if (entry.reason === 'unsupported-language') {
            languages.set(entry.label, (languages.get(entry.label) || 0) + matched);
        }
    }
    bucket.files.sort(codeUnitCompare);
    bucket.sites.sort((a, b) => codeUnitCompare(a.file, b.file) || a.line - b.line);
    for (const key of [...languages.keys()].sort(codeUnitCompare)) {
        bucket.languages[key] = languages.get(key);
    }
    for (const key of [...reasons.keys()].sort(codeUnitCompare)) {
        bucket.reasons[key] = reasons.get(key);
    }
    return bucket;
}

/** Lines of one readable file on which the name occurs (parse failures). */
function countNameLines(absolutePath, name) {
    let lines = 0;
    const size = fs.statSync(absolutePath).size;
    const chunks = size <= WHOLE_FILE_BYTES
        ? [fs.readFileSync(absolutePath, 'utf-8')]
        : streamChunks(absolutePath);
    scanChunksForName(chunks, name, () => { lines++; });
    return lines;
}

/**
 * Which of `names` occur anywhere in text-only source, one pass per file.
 * Returns { matchedNames: Set, files: string[], unreadableFiles: string[],
 * reasons: {reason: fileCount} }.
 */
function scanTextOnlyNames(index, names, extraFiles = []) {
    const matchedNames = new Set();
    const files = [];
    const unreadableFiles = [];
    const reasons = {};
    const { textOnly } = universe(index);
    const entries = [
        ...extraFiles,
        ...textOnly.map(entry => ({
            absolutePath: path.join(index.root, entry.relativePath),
            relativePath: entry.relativePath,
            reason: entry.reason,
            size: entry.size,
            textOnly: entry,
        })),
    ];
    for (const entry of entries) {
        files.push(entry.relativePath);
        reasons[entry.reason] = (reasons[entry.reason] || 0) + 1;
        try {
            const size = entry.size ?? fs.statSync(entry.absolutePath).size;
            const found = scanChunksForNames(
                () => textOnlyChunks(index, entry.absolutePath, size), names);
            for (const name of found) matchedNames.add(name);
        } catch (error) {
            unreadableFiles.push(entry.relativePath);
            if (entry.textOnly) demoteToOpaque(index, entry.textOnly, error);
        }
    }
    return {
        matchedNames,
        files: files.sort(codeUnitCompare),
        unreadableFiles: unreadableFiles.sort(codeUnitCompare),
        reasons,
    };
}

// ── Summaries ───────────────────────────────────────────────────────────────

function countBy(entries, key) {
    const counts = {};
    for (const entry of entries) counts[entry[key]] = (counts[entry[key]] || 0) + 1;
    return Object.fromEntries(Object.entries(counts)
        .sort((a, b) => codeUnitCompare(a[0], b[0])));
}

/**
 * What an account needs to say about paths no name can be checked against:
 * the count, the reasons, and a few paths. Zero means the claim stands or
 * falls on the name's own occurrences.
 */
function opaqueSummary(index) {
    const { opaque } = universe(index);
    return {
        count: opaque.length,
        reasons: countBy(opaque, 'reason'),
        sample: opaque.slice(0, 3).map(entry => ({
            path: entry.relativePath, reason: entry.reason,
        })),
    };
}

/** The repository's scope statement (repo / health): said once, in full. */
function scopeSummary(index, sampleSize = 10) {
    const { textOnly, opaque, outside, budget } = universe(index);
    const sample = entries => entries.slice(0, sampleSize).map(entry => ({
        path: entry.relativePath, reason: entry.reason,
    }));
    return {
        textOnly: {
            count: textOnly.length,
            bytes: budget.usedBytes,
            reasons: countBy(textOnly, 'reason'),
            sample: sample(textOnly),
        },
        opaque: {
            count: opaque.length,
            reasons: countBy(opaque, 'reason'),
            sample: sample(opaque),
        },
        outside: {
            count: outside.length,
            reasons: countBy(outside, 'reason'),
            sample: sample(outside),
        },
        scanBudgetBytes: budget.limitBytes,
    };
}

/**
 * Has text-only source changed on disk since it was classified?
 *   'unchanged'  nothing moved;
 *   'refreshed'  a file's content changed and it is still text-only: the
 *                universe was rebuilt and name scans must not be reused;
 *   'reindex'    a file is gone, or one kept out by the size limit is no
 *                longer over it: the set of indexed files may differ, which
 *                only a build can settle.
 */
function refreshTextOnly(index, { maxFileSize } = {}) {
    const current = index._sourceUniverse;
    if (!current) return 'unchanged';
    let changed = false;
    // Every candidate, not only the ones currently searched: a file the
    // budget left out, or one that could not be read, changes the
    // assignment for the others when it shrinks or becomes readable.
    for (const entry of current.candidates || []) {
        const absolutePath = path.join(index.root, entry.relativePath);
        const stat = readableStat(absolutePath);
        if (!stat.readable) {
            // Gone: the set of discovered files may differ. Still unreadable
            // as before: nothing moved.
            if (!fs.existsSync(absolutePath)) return 'reindex';
            if (entry.readable) changed = true;
            continue;
        }
        if (entry.readable && stat.size === entry.size && stat.mtimeMs === entry.mtimeMs) continue;
        if (entry.reason === 'max-file-size' && maxFileSize != null && stat.size <= maxFileSize) {
            return 'reindex';
        }
        changed = true;
    }
    if (!changed) return 'unchanged';
    resetUniverse(index);
    return 'refreshed';
}

/** "Ruby, bundled/minified": what kind of unanalyzed source matched. */
function matchLabels(bucket) {
    const labels = Object.keys((bucket && bucket.languages) || {});
    for (const reason of Object.keys((bucket && bucket.reasons) || {})) {
        if (reason === 'unsupported-language') continue;
        labels.push(REASON_LABELS[reason] || reason);
    }
    return labels.join(', ');
}

/** "(Ruby: 2, bundled/minified: 1)" with line counts. */
function matchLabelCounts(bucket) {
    const parts = Object.entries((bucket && bucket.languages) || {})
        .map(([language, count]) => `${language}: ${count}`);
    for (const [reason, count] of Object.entries((bucket && bucket.reasons) || {})) {
        if (reason === 'unsupported-language') continue;
        parts.push(`${REASON_LABELS[reason] || reason}: ${count}`);
    }
    return parts.join(', ');
}

/** What to do about a match in unanalyzed source. */
function matchAdvice(bucket) {
    const bundled = bucket && bucket.reasons && bucket.reasons.bundled > 0;
    return 'Use grep/ripgrep plus a language-native analyzer.' +
        (bundled ? ' --include-bundled indexes JavaScript bundles.' : '');
}

function reasonList(reasons) {
    return Object.entries(reasons || {}).map(([reason, count]) => `${reason} ${count}`).join(', ');
}

/** One sentence for an answer that found nothing while part of the project
 *  could not be searched at all; '' when everything readable was scanned. */
function unsearchedNote(index) {
    const opaque = opaqueSummary(index);
    if (opaque.count === 0) return '';
    return `${opaque.count} path(s) could not be searched (${reasonList(opaque.reasons)}); ` +
        'this is not a repository-wide zero. See repo --sections=health.';
}

function hasTextOnly(index) {
    return universe(index).textOnly.length > 0;
}

module.exports = {
    DEFAULT_TEXT_SCAN_BUDGET,
    matchLabels,
    matchLabelCounts,
    matchAdvice,
    reasonList,
    unsearchedNote,
    hasTextOnly,
    REASON_LABELS,
    universe,
    resetUniverse,
    scanChunksForName,
    scanChunksForNames,
    scanTextOnly,
    scanTextOnlyNames,
    countNameLines,
    opaqueSummary,
    scopeSummary,
    refreshTextOnly,
};
