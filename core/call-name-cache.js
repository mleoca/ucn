'use strict';

const fs = require('fs');
const path = require('path');
const { calleeNames, codeUnitCompare } = require('./shared');
const { version } = require('../package.json');

// Call-record names only. Binding, dispatch, aliases and type queries still
// run through their ordinary record consumers.
function snapshot(index, files, captured) {
    return { files, captured, filesMap: index.files, graph: index.importGraph,
        config: JSON.stringify(index.config), generation: index._callsGenerationKey };
}

function current(index, cache) {
    return !!cache && cache.filesMap === index.files && cache.graph === index.importGraph &&
        cache.config === JSON.stringify(index.config) && cache.files.size === index.files.size &&
        [...cache.files].every(([file, item]) => index.files.get(file) === item.entry &&
            item.entry.hash === item.hash);
}

function ensure(index) {
    if (index.isProvenanceFactIndex || !index._callsGenerationKey ||
        index._callNameCacheReadGeneration === index._callsGenerationKey) return;
    index._callNameCacheReadGeneration = index._callsGenerationKey;
    if (index._callNameCacheDir) load(index, index._callNameCacheDir);
}

function capture(index, collected, file, calls) {
    if (index.isProvenanceFactIndex) return;
    const entry = index.files.get(file), raw = index.callsCache.get(file);
    if (!entry?.hash || raw?.hash !== entry.hash || !Array.isArray(calls) ||
        !Number.isFinite(raw.mtime)) return;
    const names = calleeNames(calls);
    if ([...names].some(name => typeof name !== 'string')) return;
    collected.set(file, { entry, hash: entry.hash, raw, rawCalls: raw.calls, names, mtime: raw.mtime });
}

function remember(index, files) {
    if (index.isProvenanceFactIndex || files.size !== index.files.size) return;
    index._callNameCache = snapshot(index, files, true);
    if (index._callsGenerationKey && !index.callsCacheDirty && !index.macroExpansionDirty && index._callsCacheDir) save(index, path.join(index._callsCacheDir, 'calls'));
}

function save(index, directory) {
    if (index.isProvenanceFactIndex) return;
    const cache = index._callNameCache;
    if (!cache?.captured || !index._callsGenerationKey ||
        !current(index, cache) || !fs.existsSync(directory)) return;
    for (const [file, item] of cache.files) {
        if (index.files.get(file) !== item.entry ||
            index.callsCache.get(file) !== item.raw || item.raw.calls !== item.rawCalls ||
            item.raw.mtime !== item.mtime) return;
    }
    const dictionary = [...new Set([...cache.files.values()].flatMap(item =>
        [...item.names]))].sort(codeUnitCompare);
    const ids = new Map(dictionary.map((name, id) => [name, id]));
    const files = [...cache.files].map(([file, item]) => [
        path.relative(index.root, file), item.mtime,
        [...item.names].map(name => ids.get(name)),
    ]).sort((a, b) => codeUnitCompare(a[0], b[0]));
    const target = path.join(directory, 'names.json');
    try {
        fs.writeFileSync(target + '.tmp', JSON.stringify({
            version, format: 2, generation: index._callsGenerationKey, dictionary, files,
        }));
        fs.renameSync(target + '.tmp', target);
    } catch (_) { /* A missing optimization falls back to the record shards. */ }
}

function load(index, directory) {
    if (index.isProvenanceFactIndex) return;
    index._callNameCache = null;
    try {
        const data = JSON.parse(fs.readFileSync(path.join(directory, 'names.json'), 'utf8'));
        if (data.version !== version || data.format !== 2 ||
            data.generation !== index._callsGenerationKey ||
            !Array.isArray(data.dictionary) || !Array.isArray(data.files) ||
            data.files.length !== index.files.size ||
            data.dictionary.some(name => typeof name !== 'string') ||
            new Set(data.dictionary).size !== data.dictionary.length) return;
        const files = new Map();
        for (const row of data.files) {
            if (!Array.isArray(row) || row.length !== 3 || typeof row[0] !== 'string' ||
                !Number.isFinite(row[1]) || !Array.isArray(row[2])) return;
            const file = path.resolve(index.root, row[0]), entry = index.files.get(file);
            if (!entry || files.has(file) || row[2].some(id =>
                !Number.isInteger(id) || id < 0 || id >= data.dictionary.length) ||
                new Set(row[2]).size !== row[2].length) return;
            files.set(file, {
                entry, hash: entry.hash, mtime: row[1], names: new Set(row[2].map(id => data.dictionary[id])),
            });
        }
        index._callNameCache = snapshot(index, files, false);
    } catch (_) { /* Missing or invalid names: use the record shards. */ }
}

function restore(index) {
    if (index.isProvenanceFactIndex) return false;
    ensure(index);
    const cache = index._callNameCache;
    // A fresh in-memory parse wins over persisted names, as it does over
    // persisted call records. A rebuild discards this cache explicitly.
    if (index.callsCache.size || !current(index, cache) ||
        cache.generation !== index._callsGenerationKey) return false;
    for (const [file, item] of cache.files) {
        if (index.files.get(file) !== item.entry) return false;
    }
    const byName = new Map();
    for (const [file] of index.files) {
        for (const name of cache.files.get(file).names) {
            let files = byName.get(name);
            if (!files) byName.set(name, files = new Set());
            files.add(file);
        }
    }
    index.calleeIndex = byName;
    return true;
}

function absent(index, file, name) {
    if (index.isProvenanceFactIndex || index.callsCache.has(file)) return false;
    ensure(index);
    const item = index._callNameCache?.files.get(file);
    if (!item || index.files.get(file) !== item.entry || item.entry.hash !== item.hash ||
        item.entry.rustMacroExpansion || item.names.has(name)) return false;
    // Match the raw record cache's mtime rule. Changed source must reach
    // its normal read/hash/reparse path even if its previous names lacked
    // this query. No negative binding or ownership verdict is cached.
    try { return fs.statSync(file).mtimeMs === item.mtime; } catch (_) { return false; }
}

module.exports = { capture, remember, save, load, restore, absent };
