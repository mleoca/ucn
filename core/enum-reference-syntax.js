'use strict';

const { langTraits } = require('../languages');
const cache = require('./cache');
const { indexedContent, parseViewParts, syntaxMode } = require('./source-memo');
const { TypeReferenceResolver } = require('./type-references');
const { classDefsNamed, findDeclaringClass } = require('./class-identity');

function validScope(value) {
    return value && typeof value.namespace === 'string' &&
        Number.isInteger(value.startIndex) && Number.isInteger(value.endIndex) &&
        value.startIndex >= 0 && value.endIndex >= value.startIndex;
}

function validContext(value) {
    return value == null || Array.isArray(value.scopes) && value.scopes.every(validScope) &&
        Array.isArray(value.directives) && value.directives.every(detail => detail &&
            typeof detail.type === 'string' && typeof detail.module === 'string' &&
            Array.isArray(detail.names) && detail.names.every(name => typeof name === 'string') &&
            (detail.namespace == null || typeof detail.namespace === 'string') &&
            ['static', 'global', 'rooted'].every(key => detail[key] == null || typeof detail[key] === 'boolean') &&
            Array.isArray(detail.usingScopes) && detail.usingScopes.every(validScope));
}

/** Persist syntax only; every owner and member verdict is recomputed. */
class EnumReferenceSyntax {
    constructor(resolver) { this.resolver = resolver; this.states = new Map(); }

    collecting(file) { return this.states.get(file)?.valid === true; }

    capture(file, fact) {
        const state = this.states.get(file);
        if (!state?.valid) return;
        if (!fact) state.valid = false;
        else state.facts.push(fact);
    }

    read(file, entry, language, rows, content) {
        const r = this.resolver, index = r.index;
        if (file === r.def.file || r.owner?.def?.type !== 'enum' ||
            !langTraits(language)?.staticEnumReferenceSyntax || !entry.hash ||
            !index._usageResultCache || index.isProvenanceFactIndex ||
            !indexedContent(index, file, entry, content)) return null;
        const mode = syntaxMode('enumSyntax', [...parseViewParts(entry, language), rows]);
        this.states.set(file, { valid: true, facts: [], mode });
        const value = cache.getUsageResult(index, file, r.name, mode);
        if (!Array.isArray(value) || value.length !== 3 || value[0] !== 2 ||
            !Array.isArray(value[1]) || !Array.isArray(value[2])) return null;
        const lines = new Map(), wanted = new Set(rows);
        for (const record of value[1]) {
            if (!Array.isArray(record) || record.length !== 4 || !wanted.has(record[0]) ||
                lines.has(record[0]) || !Number.isInteger(record[1]) || record[1] < 0 ||
                typeof record[2] !== 'boolean' || record[3] !== 0) return null;
            lines.set(record[0], { edits: [], reviews: [], skips: 0, skipColumns: [],
                text: record[2], tokens: record[1], macroBody: false });
        }
        if (lines.size !== rows.length) return null;
        const counts = new Map(), references = [];
        for (const fact of value[2]) {
            if (!fact || !wanted.has(fact.line) || !Number.isInteger(fact.column) || fact.column < 0 ||
                !Number.isInteger(fact.at) || fact.at < 0 || content.slice(fact.at, fact.at + r.name.length) !== r.name ||
                !['member', 'type', 'opaque'].includes(fact.kind) || typeof fact.accessKind !== 'string' ||
                fact.kind !== 'opaque' && (typeof fact.receiver !== 'string' || !fact.receiver) ||
                fact.kind === 'opaque' && (!['macro', 'template'].includes(fact.sourceRole) ||
                    fact.receiver != null || fact.context != null || fact.owner != null) ||
                !validContext(fact.context) || fact.owner != null &&
                (typeof fact.owner.name !== 'string' || !Number.isInteger(fact.owner.startLine) ||
                    !Number.isInteger(fact.owner.endLine) || fact.owner.startLine < 1 ||
                    fact.owner.endLine < fact.owner.startLine)) return null;
            if (fact.kind !== 'opaque' && langTraits(language).enumReferenceContext && fact.context == null) return null;
            counts.set(fact.line, (counts.get(fact.line) || 0) + 1);
        }
        for (const [line, slot] of lines) if ((counts.get(line) || 0) !== slot.tokens) return null;
        for (const fact of value[2]) {
            const lookup = fact.kind === 'opaque' ? null : this.ownerOf(file, language, fact);
            if (fact.kind !== 'opaque' && !lookup) return null;
            const verdict = fact.kind === 'opaque'
                ? { verdict: 'unknown', reason: 'value-binding-unresolved' } : r.memberAt(lookup.owner);
            const slot = lines.get(fact.line);
            if (verdict.verdict === 'yes') slot.edits.push(fact.column);
            else if (verdict.verdict === 'unknown') slot.reviews.push({ column: fact.column, reason: verdict.reason });
            else { slot.skips++; slot.skipColumns.push(fact.column); }
            references.push({ file: entry.relativePath, absoluteFile: file,
                line: fact.line, column: fact.column, expression: index.getLineContent(file, fact.line).trim(),
                ...(fact.kind === 'member' && { receiver: fact.receiver }), accessKind: fact.accessKind,
                verdict: verdict.verdict, reason: verdict.reason });
        }
        r.references.push(...references);
        return lines;
    }

    ownerOf(file, language, fact) {
        const r = this.resolver, index = r.index;
        if (fact.kind === 'member' && langTraits(language).bareCallReachesMethods) {
            let enclosing = null;
            if (fact.owner) {
                const entries = classDefsNamed(index, fact.owner.name).entries.filter(e =>
                    e.def.file === file && e.def.startLine <= fact.owner.startLine &&
                    e.def.endLine >= fact.owner.endLine);
                if (new Set(entries.map(e => e.key)).size !== 1) return null;
                enclosing = { name: entries[0].def.name, key: entries[0].key, def: entries[0].def };
            } else if (index.findEnclosingFunction(file, fact.line, true)?.className) return null;
            const members = (index.symbols.get(fact.receiver) || []).filter(d => d.className);
            if (enclosing && findDeclaringClass(index, enclosing, members)) return { owner: null };
        }
        if ((index.symbols.get(fact.receiver) || []).some(d => d.type === 'type')) return null;
        const matches = [];
        for (const entry of classDefsNamed(index, fact.receiver).entries) {
            // Same-file declarations also need the native lexical scope relation.
            if (entry.def.file === file) return null;
            const sub = new TypeReferenceResolver(index, entry.def, fact.receiver);
            sub.siteFile = file;
            if (fact.context) sub.siteSyntax = { file, line: fact.line, arity: 0, context: fact.context };
            const verdict = sub.resolveName(file, fact.line, fact.receiver);
            if (verdict.verdict === 'unknown') return { owner: null };
            if (verdict.verdict === 'yes') matches.push(entry);
        }
        if (new Set(matches.map(e => e.key)).size !== 1) return { owner: null };
        return { owner: { name: matches[0].def.name, key: matches[0].key, def: matches[0].def } };
    }

    remember(file, lines) {
        const state = this.states.get(file);
        if (!state?.valid) return;
        const counts = new Map();
        for (const fact of state.facts) counts.set(fact.line, (counts.get(fact.line) || 0) + 1);
        if ([...lines].some(([line, slot]) => slot.macroBody || slot.stringAnnotation ||
            slot.tokens !== (counts.get(line) || 0) || slot.tokens === 0 && !slot.text)) return;
        const value = [2, [...lines].map(([line, slot]) => [line, slot.tokens, slot.text, 0]), state.facts];
        cache.storeUsageResult(this.resolver.index, file, this.resolver.name, state.mode, value);
    }
}

module.exports = { EnumReferenceSyntax };
