'use strict';

const crypto = require('crypto');
const cache = require('./cache');
const { langTraits } = require('../languages');

/** Cache AST-proved positions only; the caller resolves each binding anew. */
function callTokenSyntax(index, file, entry, content, range, name, line, derive) {
    if (index.isProvenanceFactIndex || !entry?.hash ||
        !langTraits(entry.language)?.physicalCallTokenSyntax ||
        !Number.isInteger(range.start) || !Number.isInteger(range.end) ||
        range.start < 0 || range.end <= range.start || !Number.isInteger(line) || line <= 0) return derive();
    const tree = index._peekParsedTree?.(file, entry?.language);
    const state = sourceState(index, file, entry, content, tree);
    if (!state?.mode) return derive();
    let facts = state.names.get(name);
    if (!facts) {
        const value = cache.getUsageResult(index, file, name, state.mode);
        const rows = Array.isArray(value) && value.every(row => Array.isArray(row) &&
            row.length === 4 && row.every(Number.isInteger) &&
            row[0] >= 0 && row[1] > row[0] && row[2] > 0 && row[3] >= 0)
            ? value.slice() : [];
        const positions = new Map();
        let duplicate = false;
        for (const row of rows) {
            const key = `${row[0]}:${row[1]}:${row[2]}`;
            if (positions.has(key)) duplicate = true;
            positions.set(key, row[3]);
        }
        facts = duplicate ? { rows: [], positions: new Map() } : { rows, positions };
        state.names.set(name, facts);
    }
    const key = `${range.start}:${range.end}:${line}`;
    const stored = facts.positions.get(key);
    state.lines ||= content.split('\n');
    const lineText = state.lines[line - 1] || '';
    if (!state.lineStarts) {
        let at = 0;
        state.lineStarts = state.lines.map(text => { const start = at; at += text.length + 1; return start; });
    }
    const lineStart = state.lineStarts[line - 1];
    const inRange = column => Number.isInteger(lineStart) && lineStart + column >= range.start &&
        lineStart + column + name.length <= range.end;
    if (!tree && stored !== undefined && inRange(stored) &&
        lineText.slice(stored, stored + name.length) === name) return stored;
    const column = derive();
    if (column === stored) return column;
    if (Number.isInteger(column) && column >= 0 && inRange(column) && Number.isInteger(range.start) &&
        Number.isInteger(range.end) && range.end > range.start && Number.isInteger(line) &&
        line > 0 && lineText.slice(column, column + name.length) === name) {
        const rows = facts.rows.filter(row =>
            row[0] !== range.start || row[1] !== range.end || row[2] !== line);
        rows.push([range.start, range.end, line, column]);
        facts.rows = rows;
        facts.positions.set(key, column);
        cache.storeUsageResult(index, file, name, state.mode, rows);
    }
    return column;
}

/** The selected declaration is a fresh input; only its physical name column is saved. */
function declarationTokenSyntax(index, file, entry, content, line, name, definition, allIdentifiers = true) {
    if (index.isProvenanceFactIndex || !entry?.hash ||
        !langTraits(entry.language)?.physicalCallTokenSyntax) return null;
    const tree = index._peekParsedTree?.(file, entry?.language);
    const state = sourceState(index, file, entry, content, tree);
    if (!state?.mode) return null;
    let identity;
    try {
        const description = JSON.stringify([allIdentifiers, definition || null], (_key, value) =>
            value && typeof value === 'object' && !Array.isArray(value)
                ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
        identity = crypto.createHash('sha256').update(description).digest('hex');
    }
    catch { return null; }
    const mode = state.mode.replace('call-token-v1:', 'declaration-token-v1:') + `:${line}:${identity}`;
    const saved = cache.getUsageResult(index, file, name, mode);
    state.lines ||= content.split('\n');
    const text = state.lines[line - 1] || '';
    const valid = value => Array.isArray(value) && value.length === 1 &&
        Number.isInteger(value[0]) && value[0] >= 0 &&
        text.slice(value[0], value[0] + name.length) === name;
    return {
        columns: !tree && valid(saved) ? saved.slice() : null,
        save(columns) {
            if (valid(columns) && (!valid(saved) || saved[0] !== columns[0])) {
                cache.storeUsageResult(index, file, name, mode, columns.slice());
            }
        },
    };
}

function sourceState(index, file, entry, content, tree) {
    if (index.isProvenanceFactIndex || !entry?.hash || !index._usageResultCache ||
        !langTraits(entry.language)?.physicalCallTokenSyntax) return null;
    const memo = index._opMemo?.('callTokenSyntax', () => new Map());
    let state = memo?.get(file);
    // Preserve the existing query-tree LRU and avoid rehashing a hot tree.
    if (!state && tree) return null;
    if (!state || state.content !== content || state.hash !== entry.hash) {
        const eligible = crypto.createHash('md5').update(content).digest('hex') === entry.hash;
        const mode = eligible ? 'call-token-v1:' + crypto.createHash('sha256').update(JSON.stringify([
            entry.language, entry.conditionalViews, entry.recoveryBlanks, entry.externalMacroKey,
        ])).digest('hex') : null;
        state = { content, hash: entry.hash, mode, names: new Map(), lines: null };
        memo?.set(file, state);
    }
    return state;
}

module.exports = { callTokenSyntax, declarationTokenSyntax };
