'use strict';

const crypto = require('crypto');
const fs = require('fs');

// Bounded memos and source identities shared by the query-time syntax
// caches (fix #418). A memo keys a value by the exact input that determines
// it (a source text, a parsed view), never by a binding or ownership verdict.

/** A least-recently-used map bounded by entry count and by total weight. */
class BoundedMap {
    constructor({ maxEntries = Infinity, maxWeight = Infinity, weigh = null } = {}) {
        this.maxEntries = maxEntries;
        this.maxWeight = maxWeight;
        this.weigh = weigh;
        this.entries = new Map();
        this.weight = 0;
    }

    get size() { return this.entries.size; }

    has(key) { return this.entries.has(key); }

    /** The value, made most recently used; undefined when absent. */
    get(key) {
        const entry = this.entries.get(key);
        if (entry === undefined) return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    /** Store a value; one heavier than the whole bound is not kept. */
    set(key, value) {
        const weight = this.weigh ? this.weigh(value, key) : 0;
        this.delete(key);
        if (weight > this.maxWeight) return false;
        while (this.entries.size > 0 && (this.entries.size >= this.maxEntries ||
            this.weight + weight > this.maxWeight)) {
            this.delete(this.entries.keys().next().value);
        }
        this.entries.set(key, { value, weight });
        this.weight += weight;
        return true;
    }

    delete(key) {
        const entry = this.entries.get(key);
        if (entry === undefined) return false;
        this.entries.delete(key);
        this.weight -= entry.weight;
        return true;
    }

    clear() {
        this.entries.clear();
        this.weight = 0;
    }

    *[Symbol.iterator]() {
        for (const [key, entry] of this.entries) yield [key, entry.value];
    }
}

/**
 * A memo of facts derived from a source text in one language. The text is
 * the key itself, so a lookup never builds a key string as long as the
 * source; its weight counts the retained text.
 */
class SourceMemo {
    constructor({ maxEntries = 256, maxWeight = 32 * 1024 * 1024, weigh = () => 0 } = {}) {
        this.memo = new BoundedMap({ maxEntries, maxWeight,
            weigh: (byLanguage, source) => source.length * 2 + [...byLanguage.values()].reduce(
                (sum, value) => sum + weigh(value), 0) });
    }

    get(language, source) {
        return this.memo.get(source)?.get(language);
    }

    set(language, source, value) {
        const byLanguage = new Map(this.memo.get(source) || []);
        byLanguage.set(language, value);
        this.memo.set(source, byLanguage);
        return value;
    }
}

// Parsed trees of recently read sources, by grammar. A tree is immutable
// and collected by the runtime; a reader never edits one. Readers that ask
// for whole-file syntax at many sites of the same few files share a parse
// (fix #418: an overload check parsed both of its files for every argument).
const parsedSources = new SourceMemo({ maxEntries: 32, maxWeight: 64 * 1024 * 1024 });

/** The tree of `source` in the grammar `language`, or null when it cannot parse. */
function parsedSource(language, source) {
    if (typeof source !== 'string') return null;
    let tree = parsedSources.get(language, source);
    if (tree === undefined) {
        const { getParser, safeParse } = require('../languages');
        tree = safeParse(getParser(language), source) || null;
        parsedSources.set(language, source, tree);
    }
    return tree;
}

// One stat per file per operation (fix #365), for every reader of the
// operation (fix #418: the call-name cache stated a file per query).
const OPERATION_STATS = new WeakMap(); // operation content cache -> Map<file, mtimeMs>

/** The file's mtime, read once per operation; throws as statSync does. */
function fileMtime(index, file) {
    const scope = index._opContentCache;
    let memo = scope ? OPERATION_STATS.get(scope) : null;
    if (scope && !memo) OPERATION_STATS.set(scope, memo = new Map());
    let mtime = memo?.get(file);
    if (mtime === undefined) {
        mtime = fs.statSync(file).mtimeMs;
        memo?.set(file, mtime);
    }
    return mtime;
}

/** The SHA-256 of the JSON of `parts`: a view or option identity. */
function digestOf(parts) {
    return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * Does `content` equal the source the index read for `file`? One hash per
 * file and content in an operation (every syntax cache of an operation
 * asks it of the same files).
 */
function indexedContent(index, file, entry, content) {
    if (!entry?.hash || typeof content !== 'string') return false;
    const memo = !index.isProvenanceFactIndex && typeof index._opMemo === 'function'
        ? index._opMemo('indexedContent', () => new Map()) : null;
    const saved = memo?.get(file);
    if (saved && saved.content === content && saved.hash === entry.hash) return saved.fresh;
    const fresh = crypto.createHash('md5').update(content).digest('hex') === entry.hash;
    memo?.set(file, { content, hash: entry.hash, fresh });
    return fresh;
}

/**
 * Are the type names written in `file` usable as the index read them (trait
 * `typeNameSourceCanonical` of `language`)? The index's own parse of the
 * same content tells whether it had errors, so most sources need no second
 * parse (fix #418).
 */
function typeNamesCanonical(index, file, canonical, language) {
    const source = index._readFile(file);
    // The verdict is the same with or without the hint, so a witness view
    // takes it unrecorded from its live index; its replay derives it again.
    const hint = live => {
        const entry = live.files.get(file);
        return entry?.language === language && indexedContent(live, file, entry, source)
            ? !!entry.parseRecovery : undefined;
    };
    return canonical(source, () => index.isProvenanceFactIndex ? index.unrecordedHint(hint) : hint(index));
}

/** The parsed views of a file: grammar, configured views, recovery blanks and external macro scope. */
function parseViewParts(entry, language = entry.language) {
    return [language, entry.conditionalViews, entry.recoveryBlanks, entry.externalMacroKey];
}

/**
 * Persisted source-only syntax caches (fix #415): each family's mode
 * prefix and the weight of one stored value in the usage-result LRU.
 * A producer names its mode through `syntaxMode`, so a version bump in a
 * prefix keeps its weight.
 */
const SYNTAX_FAMILIES = Object.freeze({
    callToken: { prefix: 'call-token-v1', weight: 'rows' },
    declarationToken: { prefix: 'declaration-token-v1', weight: 'rows' },
    contractSyntax: { prefix: 'contract-syntax-v1', weight: 'json' },
    usageText: { prefix: 'usage-text-v1', weight: 'json' },
    enumSyntax: { prefix: 'enum-syntax-v2', weight: 'json' },
    valueLocal: { prefix: 'value-local-v1', weight: 'json' },
    valueBodies: { prefix: 'value-bodies-v4', weight: 'json' },
    classFields: { prefix: 'class-fields-v1', weight: 'json' },
});

/** A family's mode: its prefix, an optional qualifier and the digest of `parts`. */
function syntaxMode(family, parts, qualifier = null) {
    return `${SYNTAX_FAMILIES[family].prefix}:${qualifier === null ? '' : `${qualifier}:`}${digestOf(parts)}`;
}

function syntaxWeightKind(mode) {
    const prefix = String(mode).split(':', 1)[0];
    for (const family of Object.values(SYNTAX_FAMILIES)) {
        if (family.prefix === prefix) return family.weight;
    }
    return null;
}

module.exports = { BoundedMap, SourceMemo, parsedSource, fileMtime, digestOf, indexedContent, typeNamesCanonical, parseViewParts,
    SYNTAX_FAMILIES, syntaxMode, syntaxWeightKind };
