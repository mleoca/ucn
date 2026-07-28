'use strict';

/**
 * Shared AST extraction for C and C++.
 *
 * This module deliberately works from tree-sitter node kinds and fields. Text
 * is read only from nodes already identified by the grammar; there is no regex
 * source fallback.
 */

const {
    traverseTree,
    traverseTreeCached,
    nodeToLocation,
    extractJSDocstring,
    visitNameNodes,
    sameNode,
    extractStringArg,
} = require('./utils');
const { PARSE_OPTIONS, safeParse } = require('./index');

const TYPE_NODES = new Set([
    'primitive_type', 'type_identifier', 'sized_type_specifier',
    'qualified_identifier', 'template_type', 'auto', 'decltype',
]);
const CLASS_NODES = new Set([
    'class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier',
]);
const FUNCTION_CONTAINERS = new Set(['function_definition', 'declaration', 'field_declaration']);
const IDENTIFIER_NODES = new Set([
    'identifier', 'field_identifier', 'type_identifier', 'namespace_identifier',
    'operator_name', 'destructor_name',
]);

function parseTree(parser, code) {
    return safeParse(parser, code, undefined, PARSE_OPTIONS);
}

function unwrapDeclarator(node) {
    let current = node;
    const seen = new Set();
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        if (current.type === 'function_declarator') return current;
        const next = current.childForFieldName('declarator');
        if (next) {
            current = next;
            continue;
        }
        for (const child of current.namedChildren || []) {
            if (child.type === 'function_declarator' ||
                child.type.endsWith('_declarator') ||
                child.type === 'qualified_identifier') {
                current = child;
                break;
            }
        }
        if (current === node || !current) break;
    }
    return null;
}

function functionDeclarator(node) {
    if (!node) return null;
    if (node.type === 'function_declarator') return node;
    const direct = node.childForFieldName('declarator');
    const unwrapped = unwrapDeclarator(direct);
    if (unwrapped) return unwrapped;
    for (const child of node.namedChildren || []) {
        const found = unwrapDeclarator(child);
        if (found) return found;
    }
    return null;
}

function declaratorIdentity(declarator) {
    if (!declarator) return {};
    let node = declarator.childForFieldName('declarator') || declarator;
    while (node && (node.type.endsWith('_declarator') ||
        node.type === 'parenthesized_declarator')) {
        const next = node.childForFieldName('declarator');
        if (!next) break;
        node = next;
    }
    if (!node) return {};
    if (node.type === 'qualified_identifier') {
        const nameNode = node.childForFieldName('name') ||
            node.namedChildren[node.namedChildCount - 1];
        const scopeNode = node.childForFieldName('scope') || node.namedChild(0);
        return {
            name: nameNode?.text,
            className: scopeNode?.text?.split('::').pop(),
            nameNode,
        };
    }
    if (IDENTIFIER_NODES.has(node.type)) {
        return { name: node.text, nameNode: node };
    }
    const named = node.namedChildren || [];
    for (let i = named.length - 1; i >= 0; i--) {
        const candidate = declaratorIdentity(named[i]);
        if (candidate.name) return candidate;
    }
    return {};
}

function enclosingClass(node) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (CLASS_NODES.has(parent.type)) {
            return classIdentity(parent);
        }
    }
    return null;
}

function enclosingClassName(node) {
    return enclosingClass(node)?.name || null;
}

function classIdentity(node) {
    let nameNode = node.childForFieldName('name');
    if (!nameNode && node.parent?.type === 'type_definition') {
        nameNode = node.parent.childForFieldName('declarator');
    }
    return nameNode ? { name: nameNode.text, node } : null;
}

function modifiersOf(node, extra = []) {
    const modifiers = new Set(extra);
    for (const child of node.namedChildren || []) {
        if (child.type === 'storage_class_specifier' ||
            child.type === 'type_qualifier' ||
            child.type === 'virtual_specifier' ||
            child.type === 'access_specifier') {
            modifiers.add(child.text);
        }
    }
    return [...modifiers];
}

function structuredParams(paramsNode) {
    if (!paramsNode) return [];
    const result = [];
    for (const param of paramsNode.namedChildren || []) {
        if (param.type !== 'parameter_declaration' &&
            param.type !== 'optional_parameter_declaration') continue;
        const declarator = param.childForFieldName('declarator');
        const identity = declaratorIdentity(declarator);
        const typeNode = param.childForFieldName('type') ||
            param.namedChildren.find(child => TYPE_NODES.has(child.type));
        const info = {
            name: identity.name || (typeNode?.text === 'void' ? 'void' : param.text),
        };
        if (typeNode) info.type = typeNode.text;
        if (param.type === 'optional_parameter_declaration') info.optional = true;
        if (declarator?.type === 'variadic_declarator' || param.text.includes('...')) {
            info.rest = true;
        }
        result.push(info);
    }
    if (result.length === 1 && result[0].name === 'void') return [];
    return result;
}

function returnTypeOf(node) {
    const typeNode = node.childForFieldName('type') ||
        node.namedChildren.find(child => TYPE_NODES.has(child.type));
    return typeNode?.text || null;
}

function memberFromNode(node, className, access, lines, mode) {
    const declarator = functionDeclarator(node);
    if (!declarator) return null;
    const identity = declaratorIdentity(declarator);
    if (!identity.name) return null;
    const paramsNode = declarator.childForFieldName('parameters');
    const { startLine, endLine, indent } = nodeToLocation(node, lines);
    const isConstructor = mode === 'cpp' &&
        (identity.name === className || identity.name === `~${className}`);
    const modifiers = modifiersOf(node, access ? [access] : []);
    if (isConstructor && identity.name.startsWith('~')) modifiers.push('destructor');
    return {
        name: identity.name,
        params: paramsNode ? paramsNode.text.replace(/^\(|\)$/g, '').trim() : '...',
        paramsStructured: structuredParams(paramsNode),
        returnType: isConstructor ? null : returnTypeOf(node),
        startLine,
        endLine,
        indent,
        modifiers,
        memberType: isConstructor ? 'constructor' : 'method',
        isMethod: true,
        isConstructor,
        className,
        docstring: extractJSDocstring(lines, startLine),
    };
}

function fieldMembers(node, access, lines) {
    if (node.type !== 'field_declaration') return [];
    if (functionDeclarator(node)) return [];
    const typeNode = node.childForFieldName('type') ||
        node.namedChildren.find(child => TYPE_NODES.has(child.type));
    const fields = [];
    for (const child of node.namedChildren || []) {
        if (!IDENTIFIER_NODES.has(child.type) && child.type !== 'field_declarator') continue;
        const identity = declaratorIdentity(child);
        if (!identity.name || identity.name === typeNode?.text) continue;
        const { startLine, endLine, indent } = nodeToLocation(child, lines);
        fields.push({
            name: identity.name,
            startLine,
            endLine,
            indent,
            modifiers: access ? [access] : [],
            memberType: 'field',
            fieldType: typeNode?.text || null,
        });
    }
    return fields;
}

function classMembers(node, lines, mode) {
    const identity = classIdentity(node);
    if (!identity) return [];
    const body = node.childForFieldName('body');
    if (!body) return [];
    let access = node.type === 'class_specifier' ? 'private' : 'public';
    const members = [];
    for (const child of body.namedChildren || []) {
        if (child.type === 'access_specifier') {
            access = child.text;
            continue;
        }
        if (CLASS_NODES.has(child.type)) continue;
        const member = memberFromNode(child, identity.name, access, lines, mode);
        if (member) members.push(member);
        else members.push(...fieldMembers(child, access, lines));
    }
    return members;
}

function findClasses(code, parser, mode) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const classes = [];
    const seen = new Set();
    traverseTreeCached(tree.rootNode, node => {
        if (!CLASS_NODES.has(node.type)) return true;
        const identity = classIdentity(node);
        if (!identity?.name) return true;
        const key = `${node.startIndex}:${identity.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        const { startLine, endLine, indent } = nodeToLocation(node, lines);
        let type = node.type.replace('_specifier', '');
        if (type === 'union') type = 'type';
        const baseClause = node.namedChildren.find(child => child.type === 'base_class_clause');
        const bases = baseClause
            ? baseClause.namedChildren
                .filter(child => child.type !== 'access_specifier')
                .map(child => child.text)
            : [];
        const modifiers = modifiersOf(node);
        if (mode === 'c' || node.type !== 'class_specifier' || modifiers.includes('public')) {
            modifiers.push('public');
        }
        classes.push({
            name: identity.name,
            type,
            startLine,
            endLine,
            indent,
            modifiers: [...new Set(modifiers)],
            members: classMembers(node, lines, mode),
            ...(bases.length > 0 && { extends: bases.join(', ') }),
            docstring: extractJSDocstring(lines, startLine),
        });
        return true;
    });
    return classes;
}

function findFunctions(code, parser, mode) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const functions = [];
    const seen = new Set();
    traverseTreeCached(tree.rootNode, node => {
        if (!FUNCTION_CONTAINERS.has(node.type)) return true;
        const declarator = functionDeclarator(node);
        if (!declarator) return true;
        const owner = enclosingClass(node);
        const identity = declaratorIdentity(declarator);
        if (!identity.name) return true;
        if (owner && !identity.className) return false;
        const key = `${node.startIndex}:${identity.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        const paramsNode = declarator.childForFieldName('parameters');
        const { startLine, endLine, indent } = nodeToLocation(node, lines);
        const isConstructor = mode === 'cpp' && !!identity.className &&
            (identity.name === identity.className || identity.name === `~${identity.className}`);
        const modifiers = modifiersOf(node);
        if (!modifiers.includes('static')) modifiers.push('export');
        functions.push({
            name: identity.name,
            params: paramsNode ? paramsNode.text.replace(/^\(|\)$/g, '').trim() : '...',
            paramsStructured: structuredParams(paramsNode),
            returnType: isConstructor ? null : returnTypeOf(node),
            startLine,
            endLine,
            indent,
            modifiers,
            ...(identity.className && {
                className: identity.className,
                receiver: identity.className,
                isMethod: true,
            }),
            ...(isConstructor && { isConstructor: true }),
            ...(node.type !== 'function_definition' && { isSignature: true }),
            docstring: extractJSDocstring(lines, startLine),
        });
        return false;
    });
    return functions;
}

function findStateObjects(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const states = [];
    traverseTreeCached(tree.rootNode, node => {
        if (node.type !== 'declaration') return true;
        if (functionDeclarator(node)) return false;
        const parentType = node.parent?.type;
        if (parentType !== 'translation_unit' && parentType !== 'declaration_list') return false;
        for (const child of node.namedChildren || []) {
            const identity = declaratorIdentity(child);
            if (!identity.name || TYPE_NODES.has(child.type)) continue;
            const { startLine, endLine, indent } = nodeToLocation(child, lines);
            states.push({
                name: identity.name,
                startLine,
                endLine,
                indent,
                modifiers: modifiersOf(node),
            });
        }
        return false;
    });
    return states;
}

function findMacros(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const macros = [];
    traverseTreeCached(tree.rootNode, node => {
        if (node.type !== 'preproc_function_def' && node.type !== 'preproc_def') {
            return true;
        }
        const nameNode = node.childForFieldName('name') ||
            (node.namedChildren || []).find(child => child.type === 'identifier');
        if (!nameNode) return false;
        const paramsNode = node.childForFieldName('parameters') ||
            (node.namedChildren || []).find(child => child.type === 'preproc_params');
        const { startLine, endLine, indent } = nodeToLocation(node, lines);
        macros.push({
            name: nameNode.text,
            startLine,
            endLine,
            indent,
            params: paramsNode ? paramsNode.text.replace(/^\(|\)$/g, '').trim() : undefined,
            paramsStructured: paramsNode
                ? (paramsNode.namedChildren || [])
                    .filter(child => child.type === 'identifier')
                    .map(child => ({ name: child.text }))
                : undefined,
            modifiers: [],
            functionLike: node.type === 'preproc_function_def',
            docstring: extractJSDocstring(lines, startLine),
        });
        return false;
    });
    return macros;
}

function enclosingFunctionOf(node) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (parent.type === 'function_definition') {
            const identity = declaratorIdentity(functionDeclarator(parent));
            return identity.name ? {
                name: identity.name,
                startLine: parent.startPosition.row + 1,
                endLine: parent.endPosition.row + 1,
            } : null;
        }
    }
    return null;
}

function typeName(node) {
    if (!node) return null;
    let text = node.text;
    text = text.replace(/\b(const|volatile|struct|class|typename)\b/g, '').trim();
    text = text.replace(/[*&]+/g, '').trim();
    const parts = text.split(/::/);
    return parts[parts.length - 1].replace(/<.*>$/, '').trim() || null;
}

function buildVariableTypes(tree) {
    const map = new Map();
    traverseTree(tree.rootNode, node => {
        if (node.type === 'parameter_declaration' || node.type === 'declaration') {
            const typeNode = node.childForFieldName('type') ||
                node.namedChildren.find(child => TYPE_NODES.has(child.type));
            const declarator = node.childForFieldName('declarator') ||
                node.namedChildren.find(child => child.type.endsWith('_declarator') ||
                    child.type === 'identifier');
            const identity = declaratorIdentity(declarator);
            const type = typeName(typeNode);
            if (identity.name && type) map.set(identity.name, type);
        }
        return true;
    });
    return map;
}

function buildFieldTypes(tree) {
    const map = new Map();
    traverseTree(tree.rootNode, node => {
        if (node.type !== 'field_declaration' || functionDeclarator(node)) return true;
        const owner = enclosingClassName(node);
        const typeNode = node.childForFieldName('type') ||
            node.namedChildren.find(child => TYPE_NODES.has(child.type));
        const fieldType = typeName(typeNode);
        if (!owner || !fieldType) return true;
        for (const child of node.namedChildren || []) {
            if (!IDENTIFIER_NODES.has(child.type) && child.type !== 'field_declarator') continue;
            const identity = declaratorIdentity(child);
            if (identity.name && identity.name !== typeNode?.text) {
                map.set(`${owner}.${identity.name}`, fieldType);
            }
        }
        return true;
    });
    return map;
}

function callArguments(node) {
    const args = node.childForFieldName('arguments');
    if (!args) return { argCount: 0 };
    const values = args.namedChildren.filter(child => !child.type.endsWith('comment'));
    return { argCount: values.length, firstArg: values[0] };
}

function callIdentity(fnNode) {
    if (!fnNode) return {};
    if (IDENTIFIER_NODES.has(fnNode.type)) {
        return { name: fnNode.text, nameNode: fnNode, isMethod: false };
    }
    if (fnNode.type === 'field_expression') {
        const nameNode = fnNode.childForFieldName('field') ||
            fnNode.namedChildren[fnNode.namedChildCount - 1];
        const receiverNode = fnNode.childForFieldName('argument') || fnNode.namedChild(0);
        return {
            name: nameNode?.text,
            nameNode,
            isMethod: true,
            receiver: receiverNode?.text,
        };
    }
    if (fnNode.type === 'qualified_identifier') {
        const nameNode = fnNode.childForFieldName('name') ||
            fnNode.namedChildren[fnNode.namedChildCount - 1];
        const scopeNode = fnNode.childForFieldName('scope') || fnNode.namedChild(0);
        return {
            name: nameNode?.text,
            nameNode,
            isMethod: true,
            receiver: scopeNode?.text,
            isPathCall: true,
        };
    }
    if (fnNode.type === 'template_function') {
        return callIdentity(fnNode.childForFieldName('name') || fnNode.namedChild(0));
    }
    return {};
}

function findCallsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const variableTypes = buildVariableTypes(tree);
    const fieldTypes = buildFieldTypes(tree);
    const calls = [];
    traverseTree(tree.rootNode, node => {
        if (node.type === 'call_expression') {
            const functionNode = node.childForFieldName('function');
            const identity = callIdentity(functionNode);
            if (!identity.name) return true;
            const args = callArguments(node);
            const first = extractStringArg(args.firstArg);
            const receiverBase = identity.receiver?.split(/[.>]/)[0];
            const owner = enclosingClassName(node);
            const receiverNode = functionNode?.type === 'field_expression'
                ? functionNode.childForFieldName('argument') || functionNode.namedChild(0)
                : null;
            let receiverField = null;
            if (owner && receiverNode?.type === 'field_expression') {
                const root = receiverNode.childForFieldName('argument') || receiverNode.namedChild(0);
                const field = receiverNode.childForFieldName('field') ||
                    receiverNode.namedChildren[receiverNode.namedChildCount - 1];
                if (root?.type === 'this' && field?.text &&
                    fieldTypes.has(`${owner}.${field.text}`)) {
                    receiverField = field.text;
                }
            } else if (owner && receiverNode?.type === 'identifier' &&
                !variableTypes.has(receiverNode.text) &&
                fieldTypes.has(`${owner}.${receiverNode.text}`)) {
                receiverField = receiverNode.text;
            }
            calls.push({
                name: identity.name,
                line: identity.nameNode?.startPosition.row + 1 || node.startPosition.row + 1,
                isMethod: identity.isMethod,
                ...(identity.receiver && { receiver: identity.receiver }),
                ...(identity.isPathCall && { isPathCall: true }),
                ...(receiverBase && variableTypes.has(receiverBase) &&
                    { receiverType: variableTypes.get(receiverBase) }),
                ...(receiverField && {
                    receiverRoot: 'this',
                    receiverField,
                    receiverRootType: owner,
                }),
                argCount: args.argCount,
                enclosingFunction: enclosingFunctionOf(node),
                ...(first && {
                    firstStringArg: first.value,
                    firstStringArgInterp: first.interp,
                }),
            });
            return true;
        }
        if (node.type === 'new_expression') {
            const typeNode = node.childForFieldName('type') ||
                node.namedChildren.find(child => child.type === 'type_identifier' ||
                    child.type === 'qualified_identifier');
            if (!typeNode) return true;
            const args = callArguments(node);
            const name = typeName(typeNode);
            if (name) {
                calls.push({
                    name,
                    line: typeNode.startPosition.row + 1,
                    isMethod: false,
                    isConstructor: true,
                    argCount: args.argCount,
                    enclosingFunction: enclosingFunctionOf(node),
                });
            }
        }
        return true;
    });
    return calls;
}

function findImportsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const imports = [];
    traverseTreeCached(tree.rootNode, node => {
        if (node.type !== 'preproc_include') return true;
        const pathNode = node.childForFieldName('path') || node.namedChild(0);
        if (!pathNode) return false;
        const system = pathNode.type === 'system_lib_string';
        const raw = pathNode.text.replace(/^["<]|[">]$/g, '');
        imports.push({
            module: system ? raw : (raw.startsWith('.') ? raw : `./${raw}`),
            names: ['*'],
            type: system ? 'system-include' : 'include',
            line: node.startPosition.row + 1,
        });
        return false;
    });
    return imports;
}

function findUsagesInCode(code, name, parser, existingTree) {
    const tree = existingTree || parseTree(parser, code);
    const usages = [];
    visitNameNodes(tree, code, name, node => {
        if (!IDENTIFIER_NODES.has(node.type) || node.text !== name) return;
        let usageType = 'reference';
        const parent = node.parent;
        if (parent) {
            const call = parent.type === 'call_expression'
                ? parent
                : parent.parent?.type === 'call_expression' ? parent.parent : null;
            if (call && (sameNode(call.childForFieldName('function'), node) ||
                call.childForFieldName('function')?.descendantForIndex(node.startIndex)?.text === name)) {
                usageType = 'call';
            } else if ((parent.type === 'function_declarator' ||
                parent.type === 'class_specifier' ||
                parent.type === 'struct_specifier' ||
                parent.type === 'enum_specifier' ||
                parent.type === 'parameter_declaration') &&
                (sameNode(parent.childForFieldName('declarator'), node) ||
                    sameNode(parent.childForFieldName('name'), node))) {
                usageType = 'definition';
            } else if (parent.type === 'preproc_include') {
                usageType = 'import';
            }
        }
        usages.push({
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
            usageType,
        });
    });
    return usages;
}

function getEntryPointKind(symbol) {
    if (symbol.name === 'main' || symbol.name === 'WinMain' ||
        symbol.name === 'wWinMain' || symbol.name === 'DllMain') return 'main';
    if (/^(test_|Test|TEST_)/.test(symbol.name)) return 'test';
    return null;
}

function isEntryPoint(symbol) {
    return getEntryPointKind(symbol) !== null;
}

function parse(code, parser, mode) {
    const tree = parseTree(parser, code);
    return {
        language: mode,
        totalLines: code.length === 0 ? 0 : code.split('\n').length,
        functions: findFunctions(code, parser, mode),
        classes: findClasses(code, parser, mode),
        stateObjects: findStateObjects(code, parser),
        macros: findMacros(code, parser),
        imports: findImportsInCode(code, parser),
        exports: findExportsInCodeShallow(code, parser, mode),
        ...(tree.rootNode.hasError && { parseRecovery: true }),
    };
}

function findExportsInCodeShallow(code, parser, mode) {
    const functions = findFunctions(code, parser, mode);
    const classes = findClasses(code, parser, mode);
    return [
        ...functions
            .filter(fn => !fn.modifiers.includes('static'))
            .map(fn => ({ name: fn.name, type: 'export', line: fn.startLine })),
        ...classes.map(cls => ({ name: cls.name, type: 'export', line: cls.startLine })),
    ];
}

function createCFamilyLanguage(mode) {
    return {
        findFunctions: (code, parser) => findFunctions(code, parser, mode),
        findClasses: (code, parser) => findClasses(code, parser, mode),
        findStateObjects,
        findMacros,
        findCallsInCode,
        findImportsInCode,
        findExportsInCode: (code, parser) => findExportsInCodeShallow(code, parser, mode),
        findUsagesInCode,
        isEntryPoint,
        getEntryPointKind,
        parse: (code, parser) => parse(code, parser, mode),
    };
}

module.exports = { createCFamilyLanguage };
