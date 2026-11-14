'use strict';

const { sameNode } = require('./utils');
const SCOPES = new Set(['program', 'statement_block', 'switch_body', 'for_statement', 'for_in_statement',
    'function_declaration', 'generator_function_declaration', 'function_expression', 'generator_function',
    'arrow_function', 'method_definition', 'catch_clause', 'class', 'class_declaration']);
const FUNCTIONS = new Set(['function_declaration', 'generator_function_declaration', 'function_expression',
    'generator_function', 'arrow_function', 'method_definition']);

function hasName(pattern, name) {
    return !!pattern && (pattern.text === name ||
        pattern.descendantsOfType(['identifier', 'shorthand_property_identifier_pattern']).some(id => id.text === name));
}

/** Decode a JavaScript literal without evaluating project code. */
function jsString(node) {
    if (!node || !['string', 'template_string'].includes(node.type) ||
        node.namedChildren.some(child => child.type === 'template_substitution')) return null;
    const escapes = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
    return node.text.slice(1, -1).replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[0-3][0-7]{0,2}|[4-7][0-7]?|\r?\n|[\s\S])/g, (whole, escape) => {
        if (/^[0-7]+$/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
        if (escape[0] === 'u' || escape[0] === 'x') {
            const code = parseInt(escape.replace(/^[ux]\{?|\}$/g, ''), 16);
            return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        if (escape === '\n' || escape === '\r\n') return '';
        return Object.hasOwn(escapes, escape) ? escapes[escape] : escape;
    });
}

/** One stable const binding, with block and parameter shadowing. */
function jsConstValue(node, constructedMutable = false) {
    if (node?.type !== 'identifier') return null;
    const name = node.text;
    for (let scope = node.parent; scope; scope = scope.parent) {
        if (scope.type === 'with_statement') return null;
        if (!SCOPES.has(scope.type)) continue;
        // Named function/generator/class expressions bind their own name in
        // their body; it never denotes an outer const of the same spelling.
        if (['function_expression', 'generator_function', 'function_declaration',
            'generator_function_declaration', 'class', 'class_declaration'].includes(scope.type) &&
            scope.childForFieldName('name')?.text === name) return null;
        const params = scope.childForFieldName('parameters') || scope.childForFieldName('parameter');
        if (hasName(params, name) || (scope.type === 'for_in_statement' && hasName(scope.childForFieldName('left'), name))) return null;
        if (FUNCTIONS.has(scope.type)) {
            let shadow = false;
            const scanVars = current => {
                for (const child of current.namedChildren) {
                    if (FUNCTIONS.has(child.type)) continue;
                    if (child.type === 'variable_declarator' && child.parent?.type === 'variable_declaration' &&
                        hasName(child.childForFieldName('name'), name)) shadow = true;
                    scanVars(child);
                }
            };
            scanVars(scope);
            if (shadow) return null;
        }
        const bindings = [];
        const walk = current => {
            for (const child of current.namedChildren) {
                if (['function_declaration', 'generator_function_declaration', 'class_declaration'].includes(child.type) && child.childForFieldName('name')?.text === name) bindings.push(child);
                if (SCOPES.has(child.type) && !sameNode(child, scope)) continue;
                if (child.type === 'variable_declarator' && hasName(child.childForFieldName('name'), name)) bindings.push(child);
                else if (child.type === 'import_statement' && hasName(child, name)) bindings.push(child);
                walk(child);
            }
        };
        walk(scope);
        if (bindings.length === 0) continue;
        if (bindings.length !== 1) return null;
        const binding = bindings[0];
        if (binding.type !== 'variable_declarator' || binding.childForFieldName('name')?.type !== 'identifier' ||
            binding.endIndex > node.startIndex) return null;
        const value = binding.childForFieldName('value');
        if (binding.parent?.type === 'lexical_declaration' && binding.parent.child(0)?.type === 'const') return value;
        if (!constructedMutable || value?.type !== 'new_expression') return null;
        const writes = node.tree.rootNode.descendantsOfType(['assignment_expression', 'augmented_assignment_expression', 'update_expression']);
        if (writes.some(write => hasName(write.childForFieldName('left') || write.childForFieldName('argument'), name))) return null;
        return value;
    }
    return null;
}

function jsStaticKey(node) {
    return jsString(node) ?? jsString(jsConstValue(node));
}

module.exports = { jsString, jsConstValue, jsStaticKey };
