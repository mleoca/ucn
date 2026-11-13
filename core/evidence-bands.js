'use strict';

/**
 * How often an unverified reason was a real edge on the release board.
 *
 * Display only. The table labels the per-reason summary line of an
 * unverified section and orders that line; it decides no tier, filter,
 * score or account, and nothing outside the output layer reads it (guarded
 * by test/evidence-bands.test.js). Entries of a section keep their own
 * order.
 *
 * The table (core/evidence-bands.json) is written by
 * `node eval/run-unverified-census.js --bands` from the release board's
 * oracle reports: per reason, the candidates the language's own tool scored
 * and how many of them were real edges. A reason scored fewer times than
 * the table's minimum has no row and is labelled "not measured".
 */

const DEFAULT_TABLE = require('./evidence-bands.json');

const BAND_RANK = Object.freeze({ often: 0, sometimes: 1, rarely: 2 });
const UNMEASURED_RANK = 3;

const codeUnitCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The measured row of a reason: { band, scored, real }, or null. */
function evidenceBand(reason, table = DEFAULT_TABLE) {
    const row = table?.reasons?.[reason];
    if (!row || BAND_RANK[row.band] === undefined) return null;
    return { band: row.band, scored: row.scored, real: row.real };
}

/**
 * The reasons of a list of unverified entries (or a `{ reason: count }`
 * map) with their counts and bands: most often real first, then the larger
 * count, then the name.
 */
function summarizeReasons(entries, table = DEFAULT_TABLE) {
    const counts = new Map();
    if (Array.isArray(entries)) {
        for (const entry of entries) {
            const reason = entry?.reason || 'unknown';
            counts.set(reason, (counts.get(reason) || 0) + 1);
        }
    } else {
        for (const [reason, count] of Object.entries(entries || {})) {
            if (count > 0) counts.set(reason, count);
        }
    }
    const rows = [...counts].map(([reason, count]) => ({ reason, count, ...evidenceBand(reason, table) }));
    const rank = row => (row.band ? BAND_RANK[row.band] : UNMEASURED_RANK);
    return rows.sort((a, b) => rank(a) - rank(b) || b.count - a.count || codeUnitCompare(a.reason, b.reason));
}

/**
 * The summary line of an unverified section, or null when it would add
 * nothing: one reason that is not measured.
 */
function reasonSummaryLine(entries, table = DEFAULT_TABLE) {
    const rows = summarizeReasons(entries, table);
    if (rows.length === 0 || (rows.length === 1 && !rows[0].band)) return null;
    const parts = rows.map(row => (row.band
        ? `${row.reason} ${row.count} (${row.band}, ${row.real}/${row.scored})`
        : `${row.reason} ${row.count} (not measured)`));
    return `  by reason, with how often each was a real call on the release board: ${parts.join('; ')}`;
}

module.exports = { evidenceBand, summarizeReasons, reasonSummaryLine };
