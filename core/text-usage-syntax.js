'use strict';

const crypto = require('crypto');
const cache = require('./cache');

/** Source positions only; no binding or ownership decisions are retained. */
function textUsageSyntax(index, file, entry, content, name) {
    const eligible = entry.hash && index._usageResultCache && !index.isProvenanceFactIndex &&
        crypto.createHash('md5').update(content).digest('hex') === entry.hash;
    const mode = eligible ? 'usage-text-v1:' + crypto.createHash('sha256').update(JSON.stringify([
        entry.language, entry.conditionalViews, entry.recoveryBlanks, entry.externalMacroKey,
    ])).digest('hex') : null;
    const stored = eligible ? cache.getUsageResult(index, file, name, mode) : null;
    const facts = new Map();
    if (Array.isArray(stored) && stored.every(fact => Array.isArray(fact) && fact.length === 3 &&
        Number.isInteger(fact[0]) && fact[0] > 0 && Number.isInteger(fact[1]) && fact[1] >= 0 &&
        ['identifier', 'comment-or-string', 'markup-or-text'].includes(fact[2]))) {
        for (const fact of stored) facts.set(fact[0], fact);
    }
    let dirty = false;
    return {
        kind(line, column) {
            const saved = facts.get(line);
            if (saved?.[1] === column) return saved[2];
            const kind = index.isCommentOrStringAtPosition(content, line, column, file)
                ? 'comment-or-string'
                : index.isIdentifierAtPosition(content, line, column, file, name)
                    ? 'identifier' : 'markup-or-text';
            facts.set(line, [line, column, kind]);
            dirty = true;
            return kind;
        },
        save() {
            if (eligible && dirty) cache.storeUsageResult(index, file, name, mode,
                [...facts.values()].sort((a, b) => a[0] - b[0]));
        },
    };
}

module.exports = { textUsageSyntax };
