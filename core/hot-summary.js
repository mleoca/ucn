'use strict';

/**
 * core/hot-summary.js - The HOT ranking of `repo`, kept per index state.
 *
 * Ranking the most-called functions runs an exact, pinned caller query on
 * every definition able to enter the list (core/reporting.js getStats). On a
 * 3,400-file project that is about 1,300 queries and ten seconds, and the
 * answer is the same until a file changes: it is a function of the index and
 * of the options that shape the ranking, nothing else. So it is kept:
 *
 *   - in memory, on the index, until the index is rebuilt;
 *   - on disk beside the index (hot-summary.json), tagged with the index
 *     generation it was computed on. A loaded index reads it back only when
 *     its own generation is the tagged one. Every save of the index starts a
 *     new generation and rewrites the file under it; a rebuild drops the
 *     summaries first, so a changed file always ranks afresh.
 *
 * A summary answers only the request it was computed for: the key is every
 * option that reaches the ranking (list length, production-only counting,
 * both budgets, scope). No summary is derived from another, so a kept answer
 * is the answer a fresh ranking gives, byte for byte. Fresh and kept answers
 * leave this module through the same serialization.
 *
 * Two more conditions keep that true. A ranking is kept only when every
 * indexed file still is what the index recorded once it has been computed:
 * call records are refreshed from a file that changes under a running
 * command, and such a ranking describes neither the index nor the edit. And
 * a stored ranking is read only by the engine build that computed it: unlike
 * a parsed fact it is a verdict of the caller engine, so an edited engine
 * file in a development tree ends it.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { version: UCN_VERSION } = require('../package.json');

const SUMMARY_FILE = 'hot-summary.json';
const SUMMARY_FORMAT = 1;
// Requests differ by scope and list length; a session asks a handful.
const MAX_SUMMARIES = 8;
// Listed functions kept on disk across all summaries. A list longer than
// this (`--hot --top=10000`) is ranked again instead of being stored.
const MAX_STORED_ITEMS = 2000;

/** The request a summary answers: every option the ranking reads. */
function keyOf({ top, productionCallsOnly, maxRefine, workBudget, file, in: inScope, exclude }) {
    return JSON.stringify([
        top,
        !!productionCallsOnly,
        Number.isFinite(maxRefine) ? maxRefine : null,
        Number.isFinite(workBudget) ? workBudget : null,
        file || null,
        inScope || null,
        Array.isArray(exclude) && exclude.length > 0 ? exclude : null,
    ]);
}

let engineStampMemo = null;
/**
 * The engine build: the package version and the size and modification time
 * of every engine source file. Constant for an installed package.
 */
function engineStamp() {
    if (engineStampMemo) return engineStampMemo;
    const hash = crypto.createHash('md5').update(UCN_VERSION);
    const root = path.join(__dirname, '..');
    for (const folder of ['core', 'core/output', 'languages']) {
        let names = [];
        try {
            names = fs.readdirSync(path.join(root, folder)).filter(name => name.endsWith('.js')).sort();
        } catch (_) { /* a folder this build does not have */ }
        for (const name of names) {
            let state = '?';
            try {
                const stat = fs.statSync(path.join(root, folder, name));
                state = `${stat.size}:${stat.mtimeMs}`;
            } catch (_) { /* unreadable: its own state */ }
            hash.update(`\0${folder}/${name}:${state}`);
        }
    }
    return (engineStampMemo = hash.digest('hex'));
}

/**
 * Whether every indexed file still is what the index recorded: same size
 * and modification time, or the same content when only the time moved (the
 * rule the staleness check applies).
 */
function sourceMatchesIndex(index) {
    for (const [filePath, entry] of index.files) {
        try {
            const stat = fs.statSync(filePath);
            if (entry.size !== undefined && stat.size !== entry.size) return false;
            if (entry.mtime && stat.mtimeMs === entry.mtime) continue;
            const content = fs.readFileSync(filePath, 'utf-8');
            if (crypto.createHash('md5').update(content).digest('hex') !== entry.hash) return false;
        } catch (_) { return false; }
    }
    return true;
}

function cacheDirOf(index, cachePath) {
    if (cachePath) return path.dirname(cachePath);
    if (index._cacheDir) return index._cacheDir;
    return require('./cache').getProjectCacheDir(index.root);
}

/** A summary as every reader receives it: plain data, its own copy. */
function copyOf(summary) {
    return JSON.parse(JSON.stringify(summary));
}

function validSummary(summary) {
    return !!summary && typeof summary === 'object' && Number.isInteger(summary.top) &&
        Array.isArray(summary.items) && summary.items.every(item =>
        item && typeof item === 'object' && typeof item.name === 'string' &&
            Number.isInteger(item.callCount));
}

/**
 * Read the stored summaries of the generation in memory, once per
 * generation. An index that was rebuilt, or never saved, has none.
 */
function ensure(index) {
    const generation = index._callsGenerationKey || null;
    if (index._hotSummariesGeneration === generation && index._hotSummaries) return;
    // Summaries computed since the last save stay: the state they describe
    // is the one in memory.
    const kept = index._hotSummaries || new Map();
    index._hotSummaries = kept;
    index._hotSummariesGeneration = generation;
    if (!generation || index.isProvenanceFactIndex) return;
    let stored;
    try {
        stored = JSON.parse(fs.readFileSync(path.join(cacheDirOf(index), SUMMARY_FILE), 'utf8'));
    } catch (_) { return; }
    if (!stored || stored.format !== SUMMARY_FORMAT || stored.engine !== engineStamp() ||
        stored.generation !== generation || !Array.isArray(stored.summaries)) return;
    for (const row of stored.summaries) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' ||
            !validSummary(row[1])) return;
    }
    for (const [key, summary] of stored.summaries) {
        if (!kept.has(key)) kept.set(key, summary);
    }
}

/** The kept answer to this request, or undefined. */
function get(index, key) {
    ensure(index);
    const summary = index._hotSummaries.get(key);
    if (summary === undefined) return undefined;
    // Most recently asked last: the bound drops the oldest.
    index._hotSummaries.delete(key);
    index._hotSummaries.set(key, summary);
    return copyOf(summary);
}

/** Keep a freshly ranked answer; returns the copy the caller hands out. */
function put(index, key, summary) {
    const stored = copyOf(summary);
    // Ranked while a file was being edited: answered, not kept.
    if (!sourceMatchesIndex(index)) return stored;
    ensure(index);
    index._hotSummaries.delete(key);
    index._hotSummaries.set(key, stored);
    while (index._hotSummaries.size > MAX_SUMMARIES) {
        index._hotSummaries.delete(index._hotSummaries.keys().next().value);
    }
    index.hotSummaryDirty = true;
    return copyOf(stored);
}

/** Drop every summary: the index is being changed. */
function reset(index) {
    index._hotSummaries = new Map();
    // The generation in memory no longer describes the index, so its stored
    // summaries are not read back either.
    index._hotSummariesGeneration = index._callsGenerationKey || null;
    index.hotSummaryDirty = false;
}

/** Another saved state was loaded: its stored summaries are read on demand. */
function forget(index) {
    index._hotSummaries = null;
    index._hotSummariesGeneration = undefined;
    index.hotSummaryDirty = false;
}

/**
 * Write the summaries under the generation in memory. An index with no
 * generation has no saved state they could be read back against.
 */
function save(index, cachePath) {
    const generation = index._callsGenerationKey || null;
    if (!generation || index.isProvenanceFactIndex) return null;
    // The file is replaced, so what it holds for this generation comes first.
    ensure(index);
    const target = path.join(cacheDirOf(index, cachePath), SUMMARY_FILE);
    const summaries = [];
    let items = 0;
    // Newest first, within the stored-item bound.
    for (const [key, summary] of [...index._hotSummaries].reverse()) {
        if (items + summary.items.length > MAX_STORED_ITEMS) continue;
        items += summary.items.length;
        summaries.unshift([key, summary]);
    }
    index.hotSummaryDirty = false;
    if (summaries.length === 0) {
        try { fs.rmSync(target, { force: true }); } catch (_) { /* nothing stored */ }
        return null;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target + '.tmp', JSON.stringify({
        format: SUMMARY_FORMAT, engine: engineStamp(), generation, summaries,
    }));
    fs.renameSync(target + '.tmp', target);
    return target;
}

module.exports = { SUMMARY_FILE, keyOf, engineStamp, ensure, get, put, reset, forget, save };
