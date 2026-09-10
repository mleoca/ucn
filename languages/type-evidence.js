'use strict';

/** Data-only AST witness. Never retain a tree-sitter node in a call cache. */
function typeOrigin(source = 'unknown', node = null) {
    return {
        source,
        ...(node && {
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
            start: node.startIndex,
            end: node.endIndex,
            nodeType: node.type,
        }),
    };
}

/**
 * A string-valued type map with independent provenance. Existing inference
 * keeps its Map semantics; adding witnesses must not change classification.
 * Reassignment, deletion, and scope restoration update the witness together
 * with the inferred type so a stale constructor can never justify a new value.
 */
class ReceiverTypeMap extends Map {
    constructor(entries) {
        super();
        this.origins = new Map();
        if (entries) this.restore(entries);
    }

    set(name, type, source = 'unknown', node = null) {
        super.set(name, type);
        this.origins.set(name, typeof source === 'object' ? { ...source } : typeOrigin(source, node));
        return this;
    }

    delete(name) {
        this.origins.delete(name);
        return super.delete(name);
    }

    clear() {
        this.origins.clear();
        super.clear();
    }

    restore(entries) {
        this.clear();
        for (const [name, type] of entries) {
            this.set(name, type, entries.origins?.get(name) || 'unknown');
        }
        return this;
    }

    fields(name, type = this.get(name)) {
        const origin = type && type === this.get(name) ? this.origins.get(name) : null;
        return {
            receiverTypeSource: origin?.source || 'unknown',
            ...(origin && { receiverTypeEvidence: { ...origin, name, type } }),
        };
    }
}

module.exports = { ReceiverTypeMap, typeOrigin };
