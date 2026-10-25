'use strict';

// Java translates eligible Unicode escapes before tokenization (JLS 3.3).
// Keep this lexical step separate from name lookup and never rescan output.
function translateUnicodeEscapes(source) {
    if (!source.includes('\\u')) return source;
    let result = '', backslashes = 0, escaped = false;
    for (let i = 0; i < source.length;) {
        let character = source[i++];
        if (character === '\\' && (escaped || backslashes % 2 === 0) && source[i] === 'u') {
            while (source[i] === 'u') i++;
            let value = 0;
            for (let digit = 0; digit < 4; digit++) {
                const code = source.charCodeAt(i++);
                const hex = code >= 48 && code <= 57 ? code - 48
                    : code >= 65 && code <= 70 ? code - 55
                        : code >= 97 && code <= 102 ? code - 87 : -1;
                if (hex < 0) return null;
                value = value * 16 + hex;
            }
            character = String.fromCharCode(value);
            escaped = true;
        } else escaped = false;
        result += character;
        backslashes = character === '\\' ? backslashes + 1 : 0;
    }
    return result;
}

// Identifier equality ignores these characters (JLS 3.8). An unassigned
// character may belong to a newer compiler's Unicode table; abstain there.
const NONCANONICAL_IDENTIFIER = /[\p{Cf}\p{Cn}]/u;
const LITERAL_PARTS = new Set(['string_fragment', 'multiline_string_fragment', 'escape_sequence']);

function noncanonicalIdentifier(text) {
    if (NONCANONICAL_IDENTIFIER.test(text)) return true;
    for (const character of text) {
        const code = character.charCodeAt(0);
        if (code <= 8 || code >= 14 && code <= 27 || code >= 127 && code <= 159) return true;
    }
    return false;
}

function typeNameStructure(tree) {
    if (!tree || tree.rootNode.hasError) return null;
    const tokens = [], stack = [tree.rootNode];
    while (stack.length) {
        const node = stack.pop();
        if (node.isMissing) return null;
        if (node.type === 'line_comment' || node.type === 'block_comment') continue;
        tokens.push(node.type);
        if (node.type === 'string_literal' || node.type === 'character_literal') {
            if (node.namedChildren.some(child => !LITERAL_PARTS.has(child.type))) return null;
            continue;
        }
        const children = node.children;
        if (!children.length) {
            if (noncanonicalIdentifier(node.text)) return null;
            tokens.push(node.text);
        } else {
            tokens.push(children.length);
            for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
        }
    }
    return JSON.stringify(tokens);
}

// Verdicts by source text (the text is the key; see core/source-memo.js).
const canonicalSources = new (require('../core/source-memo').BoundedMap)({ maxEntries: 1024,
    maxWeight: 32 * 1024 * 1024, weigh: (_verdict, source) => source.length * 2 });

function parseNameSource(parser, source, safeParse) {
    // A NUL is legal literal/comment content, but the grammar cannot read it.
    // Project it to an ordinary character, then prove every projected position
    // lies inside that AST content. A NUL in a name or other code stays opaque.
    const positions = [];
    for (let i = source.indexOf('\0'); i !== -1; i = source.indexOf('\0', i + 1)) positions.push(i);
    const tree = safeParse(parser, positions.length ? source.replaceAll('\0', 'x') : source);
    if (!tree) return null;
    for (const position of positions) {
        let node = tree.rootNode.descendantForIndex(position, position + 1);
        while (node && !['string_literal', 'character_literal', 'line_comment', 'block_comment'].includes(node.type)) {
            node = node.parent;
        }
        const contentStart = node?.type.endsWith('comment') ? node.startIndex + 2 : node?.startIndex + 1;
        const contentEnd = node?.type === 'line_comment' ? node.endIndex
            : node?.type === 'block_comment' ? node.endIndex - 2 : node?.endIndex - 1;
        if (!node || position < contentStart || position >= contentEnd) {
            tree.delete?.();
            return null;
        }
    }
    return tree;
}

// typeNameStructure(tree) !== null for a source with no character a
// noncanonical identifier test could reject: an error-free tree (MISSING
// nodes count as errors) whose literals hold only literal parts. The full
// token walk serves the other sources (fix #418: it walked every node of
// every Java file an overload check read).
function plainStructure(tree, source) {
    if (!tree || tree.rootNode.hasError) return false;
    if (noncanonicalIdentifier(source)) return typeNameStructure(tree) !== null;
    return tree.rootNode.descendantsOfType(['string_literal', 'character_literal'])
        .every(node => node.namedChildren.every(child => LITERAL_PARTS.has(child.type)));
}

// The index retains raw-source positions. Its type/name facts are usable
// when lexical translation preserves the AST's names and structure. Literal
// contents and comment text do not change Java's static argument types.
// `parseError` (a value or a function giving it) is whether the index's
// parse of this same content had errors, when known (fix #418): an
// error-free source with no escape, no string template and no character an
// identifier test could reject is canonical without a second parse; a source
// with errors never is.
function typeNameSourceCanonical(source, parseError = undefined) {
    if (typeof source !== 'string') return false;
    const saved = canonicalSources.get(source);
    if (saved !== undefined) return saved;
    const indexed = typeof parseError === 'function' ? parseError() : parseError;
    let canonical = false;
    if (indexed === true) canonical = false;
    else if (indexed === false && !source.includes('\\u') && !source.includes('\\{') &&
        !noncanonicalIdentifier(source)) canonical = true;
    else {
        const translated = translateUnicodeEscapes(source);
        if (translated !== null) {
            const { getParser, safeParse } = require('./index');
            const parser = getParser('java');
            const rawTree = safeParse(parser, source);
            if (translated === source) canonical = plainStructure(rawTree, source);
            else {
                const before = typeNameStructure(rawTree);
                if (before !== null) canonical = before === typeNameStructure(parseNameSource(parser, translated, safeParse));
            }
        }
    }
    canonicalSources.set(source, canonical);
    return canonical;
}

function typeNameOwnersAt(source, site) {
    if (!typeNameSourceCanonical(source) || !Number.isInteger(site?.start)) return null;
    const tree = require('../core/source-memo').parsedSource('java', source);
    if (!tree) return null;
    let node = tree.rootNode.descendantForIndex(site.start, site.start + 1);
    if (!node || node.startPosition.row + 1 !== site.line) return null;
    const owners = [];
    for (; node; node = node.parent) {
        // An anonymous body can inherit type names from its own base.
        if (node.type === 'class_body' && ['object_creation_expression', 'enum_constant'].includes(node.parent?.type)) return null;
        if (['class_declaration', 'interface_declaration', 'enum_declaration',
            'record_declaration', 'annotation_type_declaration'].includes(node.type)) {
            owners.push({ start: node.startIndex, end: node.endIndex });
        }
    }
    return owners.length ? owners : null;
}

module.exports = { translateUnicodeEscapes, typeNameSourceCanonical, typeNameOwnersAt };
