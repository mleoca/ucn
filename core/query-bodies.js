'use strict';

const { langTraits, getParser, getLanguageAdapter, safeParse } = require('../languages');
const { getUsageResult, storeUsageResult } = require('./cache');
const { indexedContent, syntaxMode } = require('./source-memo');
const localNameTrees = new WeakSet();

/**
 * Bodies whose declarations cannot bind a name outside their own scope.
 * A block is damaged when an enclosing ERROR node or an enclosing block or
 * callable with an error holds it. One native query lists those nodes in
 * document order; a stack of the open ones stands for each block's
 * ancestors (fix #435: every block walked its parent chain). In document
 * order a node that starts before an open non-empty node ends lies inside it.
 */
function bodyRanges(tree, kinds) {
    if (!tree) return null;
    const ranges = [];
    if (!tree.rootNode.hasError) {
        // No node of an error-free tree has an error. A block's first and
        // last tokens are its first and last characters (an error-free tree
        // has no missing tokens), read from the parsed text when it is at
        // hand instead of asking for two child nodes (fix #436).
        const text = typeof tree.input === 'string' ? tree.input : null;
        for (const body of tree.rootNode.descendantsOfType('block')) {
            const start = body.startIndex, end = body.endIndex;
            if (text !== null ? end - start >= 2 && text[start] === '{' && text[end - 1] === '}'
                : body.firstChild?.type === '{' && body.lastChild?.type === '}') {
                ranges.push([start + 1, end - 1]);
            }
        }
        return ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    }
    const open = []; // [endIndex, damages descendants]
    for (const node of tree.rootNode.descendantsOfType(['block', 'ERROR', ...kinds])) {
        const start = node.startIndex, end = node.endIndex;
        while (open.length && open[open.length - 1][0] <= start) open.pop();
        const damaged = open.some(entry => entry[1]);
        const hasError = node.hasError;
        if (node.type === 'block' && !damaged && !hasError && node.firstChild?.type === '{' &&
            node.lastChild?.type === '}') ranges.push([start + 1, end - 1]);
        if (end > start) open.push([end, node.type === 'ERROR' || hasError]);
    }
    // Bindings in a block stay in that block. Retain nested ranges so a
    // query-bearing function can still skip unrelated sibling scopes.
    return ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
}

function viewKey(owns) { return owns == null ? 'primary' : [...owns].sort((a, b) => a - b).join(','); }

// Recovery remains visible at the same positions, in the same containers.
// Never prune an erroneous callable or anything inside an ERROR node.
function errorShape(tree) {
    const errors = [], pending = [tree.rootNode];
    while (pending.length) {
        const node = pending.pop();
        if (node.type === 'ERROR' || node.isMissing) {
            const parents = [];
            for (let parent = node.parent; parent; parent = parent.parent) {
                parents.push([parent.type, parent.startIndex, parent.endIndex]);
            }
            errors.push([node.type, node.startIndex, node.endIndex, !!node.isMissing, parents]);
        } else if (node.hasError) pending.push(...node.children);
    }
    return JSON.stringify(errors);
}

function readRanges(value, content) {
    if (!Array.isArray(value) || !value.length) return null;
    const views = new Map();
    for (const record of value) {
        if (!Array.isArray(record) || record.length !== 3 || typeof record[0] !== 'string' ||
            views.has(record[0]) || !Array.isArray(record[1]) || typeof record[2] !== 'string') return null;
        let previous = -1;
        const ends = [];
        for (const range of record[1]) {
            if (!Array.isArray(range) || range.length !== 2 ||
                !range.every(Number.isInteger) || range[0] <= previous || range[0] < 1 ||
                range[1] < range[0] || range[1] >= content.length ||
                content[range[0] - 1] !== '{' || content[range[1]] !== '}') return null;
            while (ends.length && range[0] >= ends[ends.length - 1]) ends.pop();
            if (ends.length && range[1] >= ends[ends.length - 1]) return null;
            ends.push(range[1]);
            previous = range[0];
        }
        views.set(record[0], { ranges: record[1], errors: record[2] });
    }
    return views.has('primary') ? views : null;
}

function blankBodies(source, ranges, name) {
    const chunks = [];
    let at = 0;
    let occurrence = source.indexOf(name);
    for (const [start, end] of ranges) {
        if (start < at) continue;
        while (occurrence >= 0 && occurrence < start) occurrence = source.indexOf(name, occurrence + name.length);
        if (occurrence >= start && occurrence < end) continue;
        const body = source.slice(start, end);
        const newline = char => char === '\r' || char === '\n';
        let first = 0, last = body.length - 2;
        while (first < last && (newline(body[first]) || newline(body[first + 1]))) first++;
        while (last > first + 1 && (newline(body[last]) || newline(body[last + 1]))) last--;
        if (last <= first + 1) continue;
        // All opted-in grammars have non-nesting block comments. One opaque
        // token avoids parsing the unrelated body while preserving every
        // UTF-16 offset and newline. Existing terminators stay inside it.
        const comment = body.slice(first + 2, last).replace(/\*\//g, '* ');
        chunks.push(source.slice(at, start), body.slice(0, first), '/*', comment, '*/', body.slice(last + 2));
        at = end;
    }
    return chunks.length ? chunks.join('') + source.slice(at) : source;
}

/**
 * Keep every declaration header and every body containing the queried text.
 * The persisted facts are AST ranges, never type or ownership resolutions.
 * These private trees never enter the index's complete parsed-tree caches.
 */
function localQueryTree(index, file, entry, language, name, content) {
    const traits = langTraits(language);
    if (!traits.closedQueryBodies?.length || !entry.hash || !index._usageResultCache ||
        index.isProvenanceFactIndex || !indexedContent(index, file, entry, content)) return null;
    const mode = syntaxMode('valueBodies', [language, traits.closedQueryBodies, entry.conditionalViews, entry.recoveryBlanks]);
    const key = '\x01body-ranges';
    const value = getUsageResult(index, file, key, mode);
    const ranges = readRanges(value, content);
    const persistent = index._persistentParsedTree?.(file, language);
    const warm = index._opTreeCache?.has(file) || persistent?.fileHash === entry.hash;
    const parser = getParser(language);
    if (ranges && !warm) {
        let complete = true;
        const transform = (source, owns) => {
            const view = ranges.get(viewKey(owns));
            if (!view) { complete = false; return source; }
            return blankBodies(source, view.ranges, name);
        };
        const tree = traits.queryBodyTree
            ? traits.queryBodyTree(content, parser, entry, transform)
            : safeParse(parser, transform(content, null));
        const views = traits.queryBodyViews?.(tree) || [{ tree }];
        if (complete && views.every(view => view.tree &&
            errorShape(view.tree) === ranges.get(viewKey(view.owns))?.errors)) {
            for (const view of views) localNameTrees.add(view.tree);
            return tree;
        }
    }
    const tree = index._getParsedTree(file, content, language) ||
        getLanguageAdapter(language)?.queryTree?.(content, parser, entry) || safeParse(parser, content);
    if (!ranges && tree) {
        const views = traits.queryBodyViews?.(tree) || [{ tree }];
        const kinds = new Set(traits.closedQueryBodies);
        const records = views.map(view => [viewKey(view.owns), bodyRanges(view.tree, kinds), errorShape(view.tree)]);
        if (records.every(record => record[1] !== null)) storeUsageResult(index, file, key, mode, records);
    }
    return tree;
}

module.exports = { localQueryTree, isLocalNameTree: tree => localNameTrees.has(tree), bodyRangesForTest: bodyRanges };
