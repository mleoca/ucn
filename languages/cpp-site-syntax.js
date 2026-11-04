'use strict';

const C_TYPE_SPECIFIERS = new Set(['class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier']);
const textOf = node => node ? node.text.replace(/\s+/g, '') : '';
const contains = (outer, inner) => outer.startIndex <= inner.startIndex && outer.endIndex >= inner.endIndex;

// Only syntax belongs here. Namespace macros, recovered class owners and
// include visibility are resolved by the current index at query time.
function cppSiteSyntax(node) {
    const namespaces = [];
    const classes = [];
    let memberOf = null;
    let recovered = false;
    for (let current = node.parent; current; current = current.parent) {
        if (current.type === 'ERROR') recovered = true;
        if (current.type === 'namespace_definition') {
            const nameNode = current.childForFieldName('name');
            if (nameNode) namespaces.unshift(textOf(nameNode));
        } else if (C_TYPE_SPECIFIERS.has(current.type)) {
            const body = current.childForFieldName('body');
            const nameNode = current.childForFieldName('name');
            if (body && contains(body, node) && nameNode) {
                // Specializations keep their arguments (`Acc<double>`), as
                // the index names them; an out-of-class nested definition
                // (`struct List<K>::Node`) is in its owner's scope too
                // (fix #396).
                const segments = textOf(nameNode).split('::');
                classes.unshift(segments.slice(-2).join('::'));
            }
        } else if (current.type === 'function_definition' && !memberOf && classes.length === 0) {
            let declarator = current.childForFieldName('declarator');
            while (declarator && declarator.type !== 'function_declarator' && declarator.childForFieldName?.('declarator')) {
                declarator = declarator.childForFieldName('declarator');
            }
            const qualified = declarator?.childForFieldName?.('declarator');
            if (qualified?.type === 'qualified_identifier') {
                const scope = qualified.childForFieldName('scope');
                // `List<K>::Node::f`: Node's scope, then List's (fix #396).
                if (scope) memberOf = qualifiedScopeText(qualified) || textOf(scope).split('::').pop();
            }
        }
    }
    return { namespaces, classes, memberOf, recovered };
}

/** The class path a qualified declarator's scope names, without its
 * leading namespace-looking segments: `ns::List<K>::Node::f` -> the scope
 * segments `List<K>::Node` (the last two at most). */
function qualifiedScopeText(qualified) {
    const scopes = [];
    let current = qualified;
    while (current?.type === 'qualified_identifier') {
        const scope = current.childForFieldName('scope');
        if (scope) scopes.push(textOf(scope));
        current = current.childForFieldName('name');
    }
    return scopes.length > 0 ? scopes.slice(-2).join('::') : null;
}

// Locate the headers the recovered calls ask about in the raw tree.
// A null syntax records that the exact node is absent, not a binding verdict.
function cppBaseSyntax(source, parser, positions, tree = null) {
    if (!positions.length) return [];
    const owned = !tree;
    tree ||= require('./index').safeParse(parser, source);
    if (!tree) return null;
    try {
        const rows = [], seen = new Set();
        for (const at of positions) {
            const key = JSON.stringify([at.start, at.end, at.nodeType, at.line, at.column]);
            if (seen.has(key)) continue;
            seen.add(key);
            let node = tree.rootNode.descendantForIndex(at.start);
            while (node && !(node.startIndex === at.start && node.endIndex === at.end && node.type === at.nodeType)) node = node.parent;
            const matches = node && node.startPosition.row + 1 === at.line && node.startPosition.column === at.column;
            rows.push({ start: at.start, end: at.end, nodeType: at.nodeType, line: at.line, column: at.column,
                syntax: matches ? cppSiteSyntax(node) : null });
        }
        return rows;
    } finally { if (owned) tree.delete?.(); }
}

module.exports = { cppSiteSyntax, cppBaseSyntax };
