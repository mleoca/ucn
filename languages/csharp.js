'use strict';

const {
    traverseTree,
    traverseTreeCached,
    nodeToLocation,
    extractJSDocstring,
    extractStringArg,
    visitNameNodes,
    sameNode,
} = require('./utils');
const { PARSE_OPTIONS, safeParse } = require('./index');

const TYPE_DECLARATIONS = new Map([
    ['class_declaration', 'class'],
    ['interface_declaration', 'interface'],
    ['struct_declaration', 'struct'],
    ['record_declaration', 'record'],
    ['enum_declaration', 'enum'],
]);
const IDENTIFIER_NODES = new Set(['identifier', 'generic_name']);
const METHOD_LIKE_NODES = new Set([
    'method_declaration', 'constructor_declaration',
    'destructor_declaration', 'operator_declaration',
    'conversion_operator_declaration',
]);
const CONTROL_FLOW_KEYWORDS = new Set([
    'if', 'for', 'foreach', 'while', 'switch', 'catch',
    'using', 'lock', 'fixed',
]);
const CONVERT_RETURN_TYPES = new Map([
    ['ToBoolean', 'bool'],
    ['ToByte', 'byte'],
    ['ToSByte', 'sbyte'],
    ['ToInt16', 'short'],
    ['ToUInt16', 'ushort'],
    ['ToInt32', 'int'],
    ['ToUInt32', 'uint'],
    ['ToInt64', 'long'],
    ['ToUInt64', 'ulong'],
    ['ToSingle', 'float'],
    ['ToDouble', 'double'],
    ['ToDecimal', 'decimal'],
    ['ToChar', 'char'],
    ['ToDateTime', 'DateTime'],
    ['ToString', 'string'],
]);

function isControlFlowLocalArtifact(node) {
    return node?.type === 'local_function_statement' &&
        CONTROL_FLOW_KEYWORDS.has(node.childForFieldName('name')?.text);
}

function parseTree(parser, code) {
    return safeParse(parser, code, undefined, PARSE_OPTIONS);
}

function namespaceOf(node, tree) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (parent.type === 'namespace_declaration') {
            return parent.childForFieldName('name')?.text ||
                parent.namedChildren.find(child =>
                    child.type === 'identifier' || child.type === 'qualified_name')?.text ||
                null;
        }
    }
    const fileScoped = (tree?.rootNode?.namedChildren || []).find(child =>
        child.type === 'file_scoped_namespace_declaration');
    return fileScoped?.childForFieldName('name')?.text ||
        fileScoped?.namedChildren.find(child =>
            child.type === 'identifier' || child.type === 'qualified_name')?.text ||
        null;
}

function modifiersOf(node) {
    return (node.namedChildren || [])
        .filter(child => child.type === 'modifier')
        .map(child => child.text);
}

function attributeData(node) {
    const attributes = [];
    for (const list of (node.namedChildren || []).filter(child => child.type === 'attribute_list')) {
        for (const attribute of list.namedChildren || []) {
            if (attribute.type !== 'attribute') continue;
            const nameNode = attribute.childForFieldName('name') || attribute.namedChild(0);
            if (!nameNode) continue;
            const args = attribute.namedChildren.find(child => child.type === 'attribute_argument_list');
            const firstArg = args?.namedChildren.find(child => child.type === 'attribute_argument')
                ?.namedChild(0);
            const stringArg = extractStringArg(firstArg);
            attributes.push({
                name: nameNode.text.replace(/Attribute$/, ''),
                ...(stringArg && {
                    arg: stringArg.value,
                    interp: stringArg.interp,
                }),
            });
        }
    }
    return attributes;
}

function structuredParams(paramsNode) {
    if (!paramsNode) return [];
    const params = [];
    const recoveredParams = [];
    // tree-sitter-c-sharp 0.23 exposes `params T[] name` as three siblings
    // (`params` token, type node, identifier) rather than a named
    // parameter_array node. Recover that compiler-significant shape before
    // processing ordinary parameter nodes; losing it makes overload arity
    // and normal-vs-expanded params resolution unsound.
    for (let i = 0; i < paramsNode.childCount; i++) {
        if (paramsNode.child(i).type !== 'params') continue;
        let typeNode = null;
        let nameNode = null;
        for (let j = i + 1; j < paramsNode.childCount; j++) {
            const child = paramsNode.child(j);
            if (child.type === ',' || child.type === ')') break;
            if (!child.isNamed) continue;
            if (!typeNode) typeNode = child;
            else {
                nameNode = child;
                break;
            }
        }
        if (nameNode) {
            recoveredParams.push({
                name: nameNode.text,
                ...(typeNode && { type: typeNode.text }),
                rest: true,
            });
        }
    }
    for (const param of paramsNode.namedChildren || []) {
        if (param.type !== 'parameter' && param.type !== 'parameter_array') continue;
        const nameNode = param.childForFieldName('name');
        const typeNode = param.childForFieldName('type');
        if (!nameNode) continue;
        const info = { name: nameNode.text };
        if (typeNode) info.type = typeNode.text;
        if (modifiersOf(param).includes('this')) info.extensionReceiver = true;
        if (param.type === 'parameter_array') info.rest = true;
        const value = param.childForFieldName('value') ||
            param.namedChildren.find(child => child !== nameNode && child !== typeNode &&
                !['attribute_list', 'modifier'].includes(child.type));
        if (value) {
            info.default = value.text;
            info.optional = true;
        }
        params.push(info);
    }
    // A params array is required to be the final declaration parameter.
    params.push(...recoveredParams);
    return params;
}

// `operator +` / `operator ==` name from the token following the anonymous
// `operator` keyword; conversion operators name their target type
// (`implicit operator int` → `operator int`), matching the C++ operator_name
// convention.
function operatorName(node) {
    if (node.type === 'operator_declaration') {
        for (let i = 0; i < node.childCount - 1; i++) {
            if (node.child(i).type === 'operator') {
                return `operator${node.child(i + 1).text}`;
            }
        }
        return null;
    }
    if (node.type === 'conversion_operator_declaration') {
        const target = node.childForFieldName('type');
        return target ? `operator ${target.text}` : null;
    }
    return null;
}

function conversionKind(node) {
    if (node.type !== 'conversion_operator_declaration') return null;
    for (let i = 0; i < node.childCount; i++) {
        const type = node.child(i).type;
        if (type === 'implicit' || type === 'explicit') return type;
    }
    return null;
}

function memberFromNode(node, className, lines) {
    if (!METHOD_LIKE_NODES.has(node.type)) return null;
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text ||
        operatorName(node) ||
        (node.type === 'constructor_declaration' ? className : null);
    if (!name) return null;
    const paramsNode = node.childForFieldName('parameters');
    const returnNode = node.childForFieldName('returns') || node.childForFieldName('type');
    const { startLine, endLine, indent } = nodeToLocation(node, lines);
    const attrs = attributeData(node);
    const modifiers = modifiersOf(node);
    const isConstructor = node.type === 'constructor_declaration';
    if (isConstructor) modifiers.push('constructor');
    if (node.type === 'destructor_declaration') modifiers.push('destructor');
    const conversion = conversionKind(node);
    if (conversion) modifiers.push(conversion);
    const explicitInterfaceNode = node.namedChildren.find(child =>
        child.type === 'explicit_interface_specifier');
    const explicitInterface = explicitInterfaceNode?.text
        .replace(/\.$/, '').trim() || null;
    const paramsStructured = structuredParams(paramsNode);
    return {
        name,
        params: paramsNode ? paramsNode.text.replace(/^\(|\)$/g, '').trim() : '...',
        paramsStructured,
        returnType: isConstructor ? null : returnNode?.text || null,
        startLine,
        endLine,
        indent,
        modifiers,
        memberType: isConstructor ? 'constructor' : 'method',
        isMethod: true,
        isConstructor,
        className,
        ...(explicitInterface && { explicitInterface }),
        isAsync: modifiers.includes('async'),
        ...(modifiers.includes('static') &&
            paramsStructured[0]?.extensionReceiver && {
                isExtensionMethod: true,
            }),
        docstring: extractJSDocstring(lines, startLine),
        ...(attrs.length > 0 && {
            decorators: attrs.map(attr => attr.name),
            attributesWithArgs: attrs,
        }),
    };
}

function fieldMembers(node, lines) {
    if (node.type !== 'field_declaration' && node.type !== 'event_field_declaration') return [];
    const declaration = node.namedChildren.find(child => child.type === 'variable_declaration');
    const typeNode = declaration?.childForFieldName('type');
    const members = [];
    for (const declarator of declaration?.namedChildren || []) {
        if (declarator.type !== 'variable_declarator') continue;
        const nameNode = declarator.childForFieldName('name');
        if (!nameNode?.text) continue;
        const { startLine, endLine, indent } = nodeToLocation(declarator, lines);
        members.push({
            name: nameNode.text,
            startLine,
            endLine,
            indent,
            modifiers: modifiersOf(node),
            memberType: 'field',
            fieldType: typeNode?.text || null,
        });
    }
    return members;
}

function indexerMember(node, className, lines) {
    if (node.type !== 'indexer_declaration') return null;
    const paramsNode = node.childForFieldName('parameters');
    const typeNode = node.childForFieldName('type');
    const { startLine, endLine, indent } = nodeToLocation(node, lines);
    return {
        name: 'this[]',
        params: paramsNode ? paramsNode.text.replace(/^\[|\]$/g, '').trim() : '...',
        paramsStructured: structuredParams(paramsNode),
        returnType: typeNode?.text || null,
        startLine,
        endLine,
        indent,
        modifiers: modifiersOf(node),
        memberType: 'property',
        isMethod: true,
        className,
        docstring: extractJSDocstring(lines, startLine),
    };
}

function propertyMember(node, lines) {
    if (node.type !== 'property_declaration' && node.type !== 'event_declaration') return null;
    const nameNode = node.childForFieldName('name');
    const typeNode = node.childForFieldName('type');
    // Conditional attributes inside a property can make tree-sitter recover a
    // second, zero-width property fragment (`get { ... }` with a missing name).
    // The real declaration is already indexed; reject the missing-node
    // artifact instead of letting one invalid symbol discard the whole file.
    if (!nameNode?.text) return null;
    const { startLine, endLine, indent } = nodeToLocation(node, lines);
    return {
        name: nameNode.text,
        startLine,
        endLine,
        indent,
        modifiers: modifiersOf(node),
        memberType: 'field',
        fieldType: typeNode?.text || null,
    };
}

function baseHeadName(text) {
    return text.replace(/<.*$/, '').split('.').pop().trim();
}

// Classify the base list into extends/implements. The C# grammar guarantees a
// class base precedes the interfaces, so only position 0 needs deciding:
// same-file declarations are ground truth, and the BCL-wide I-prefix
// convention (IDisposable, IList<T>) covers external names. Interfaces only
// ever extend; structs only ever implement.
function classifyBases(bases, type, fileTypeKinds) {
    if (bases.length === 0) return {};
    if (type === 'interface') return { extends: bases.join(', ') };
    if (type === 'enum') return { extends: bases[0] };
    let extendsBase = null;
    let implementsList = bases;
    if (type !== 'struct') {
        const head = baseHeadName(bases[0]);
        const declaredKind = fileTypeKinds.get(head);
        const isInterface = declaredKind === 'interface' ||
            (!declaredKind && /^I[A-Z]/.test(head));
        if (!isInterface) {
            extendsBase = bases[0];
            implementsList = bases.slice(1);
        }
    }
    return {
        ...(extendsBase && { extends: extendsBase }),
        ...(implementsList.length > 0 && { implements: implementsList }),
    };
}

function findClasses(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const classes = [];
    // Same-file type kinds override the I-prefix convention when classifying
    // base lists (a project class legitimately named IFoo stays `extends`).
    const fileTypeKinds = new Map();
    traverseTreeCached(tree.rootNode, node => {
        const kind = TYPE_DECLARATIONS.get(node.type);
        if (!kind) return true;
        const kindName = node.childForFieldName('name')?.text;
        if (kindName && !fileTypeKinds.has(kindName)) fileTypeKinds.set(kindName, kind);
        return true;
    });
    traverseTreeCached(tree.rootNode, node => {
        if (node.type === 'delegate_declaration') {
            // A delegate declares an importable callable type, like a C
            // function-pointer typedef.
            const delegateName = node.childForFieldName('name');
            if (delegateName) {
                const { startLine, endLine, indent } = nodeToLocation(node, lines);
                classes.push({
                    name: delegateName.text,
                    type: 'type',
                    startLine,
                    endLine,
                    indent,
                    modifiers: modifiersOf(node),
                    ...(namespaceOf(node, tree) && { namespace: namespaceOf(node, tree) }),
                    members: [],
                    docstring: extractJSDocstring(lines, startLine),
                });
            }
            return true;
        }
        const type = TYPE_DECLARATIONS.get(node.type);
        if (!type) return true;
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return true;
        const body = node.childForFieldName('body') ||
            node.namedChildren.find(child => child.type === 'declaration_list');
        const members = [];
        const memberNodes = [];
        const collectMemberNodes = (container) => {
            for (const child of container?.namedChildren || []) {
                if (TYPE_DECLARATIONS.has(child.type)) continue;
                if (child.type.startsWith('preproc_')) {
                    collectMemberNodes(child);
                } else {
                    memberNodes.push(child);
                }
            }
        };
        collectMemberNodes(body);
        for (const child of memberNodes) {
            if (TYPE_DECLARATIONS.has(child.type)) continue;
            if (type === 'enum' && child.type === 'enum_member_declaration') {
                const enumName = child.childForFieldName('name') ||
                    child.namedChildren.find(item => item.type === 'identifier');
                if (enumName) {
                    const { startLine, endLine, indent } = nodeToLocation(child, lines);
                    members.push({
                        name: enumName.text,
                        startLine,
                        endLine,
                        indent,
                        modifiers: ['public', 'static'],
                        memberType: 'field',
                        fieldType: nameNode.text,
                    });
                }
                continue;
            }
            const method = memberFromNode(child, nameNode.text, lines);
            if (method) members.push(method);
            else {
                const property = propertyMember(child, lines) ||
                    indexerMember(child, nameNode.text, lines);
                if (property) members.push(property);
                members.push(...fieldMembers(child, lines));
            }
        }
        const baseList = node.namedChildren.find(child => child.type === 'base_list');
        const bases = baseList?.namedChildren.map(child => child.text) || [];
        const { startLine, endLine, indent } = nodeToLocation(node, lines);
        const attrs = attributeData(node);
        let enclosingType;
        for (let parent = node.parent; parent; parent = parent.parent) {
            if (!TYPE_DECLARATIONS.has(parent.type)) continue;
            enclosingType = parent.childForFieldName('name')?.text;
            if (enclosingType) break;
        }
        classes.push({
            name: nameNode.text,
            type,
            startLine,
            endLine,
            indent,
            modifiers: modifiersOf(node),
            ...(enclosingType && { enclosingType }),
            ...(namespaceOf(node, tree) && { namespace: namespaceOf(node, tree) }),
            members,
            ...classifyBases(bases, type, fileTypeKinds),
            docstring: extractJSDocstring(lines, startLine),
            ...(attrs.length > 0 && {
                decorators: attrs.map(attr => attr.name),
                attributesWithArgs: attrs,
            }),
        });
        return true;
    });

    // tree-sitter-c-sharp can end a class node early after a malformed
    // preprocessor branch while still recovering all following methods as
    // method_declaration siblings under the namespace. Preserve those AST
    // declarations by attaching an orphan to the nearest preceding type in
    // the same namespace and at a shallower indentation. This is declaration
    // recovery only—call extraction remains AST-derived.
    traverseTreeCached(tree.rootNode, node => {
        if (!METHOD_LIKE_NODES.has(node.type)) return true;
        for (let parent = node.parent; parent; parent = parent.parent) {
            if (TYPE_DECLARATIONS.has(parent.type)) return false;
        }
        const startLine = node.startPosition.row + 1;
        const nodeNamespace = namespaceOf(node, tree);
        const candidate = classes
            .filter(type => type.startLine < startLine &&
                (type.namespace || null) === (nodeNamespace || null) &&
                type.indent < node.startPosition.column &&
                type.type !== 'enum')
            .sort((a, b) => b.startLine - a.startLine)[0];
        if (!candidate) return false;
        const member = memberFromNode(node, candidate.name, lines);
        if (member && !candidate.members.some(existing =>
            existing.startLine === member.startLine &&
            existing.name === member.name)) {
            candidate.members.push(member);
            candidate.endLine = Math.max(candidate.endLine, member.endLine);
        }
        return false;
    });
    return classes;
}

function findFunctions(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const functions = [];
    traverseTreeCached(tree.rootNode, node => {
        if (node.type !== 'local_function_statement') return true;
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return true;
        // Conditional-compilation recovery can make `else if (...)` look
        // like a local function whose return type is `else` and name is
        // `if`. C# keywords cannot be ordinary local-function identifiers;
        // rejecting this parser artifact keeps enclosing-function ownership
        // on the real constructor/method.
        if (isControlFlowLocalArtifact(node)) {
            return false;
        }
        const paramsNode = node.childForFieldName('parameters');
        const returnNode = node.childForFieldName('returns') || node.childForFieldName('type');
        const { startLine, endLine, indent } = nodeToLocation(node, lines);
        const modifiers = modifiersOf(node);
        functions.push({
            name: nameNode.text,
            params: paramsNode ? paramsNode.text.replace(/^\(|\)$/g, '').trim() : '...',
            paramsStructured: structuredParams(paramsNode),
            returnType: returnNode?.text || null,
            startLine,
            endLine,
            indent,
            modifiers,
            isAsync: modifiers.includes('async'),
            isNested: true,
            docstring: extractJSDocstring(lines, startLine),
        });
        return false;
    });
    const topLevel = (tree.rootNode.namedChildren || []).filter(child =>
        child.type === 'global_statement');
    if (topLevel.length > 0) {
        functions.push({
            name: 'Main',
            params: '',
            paramsStructured: [],
            returnType: null,
            startLine: topLevel[0].startPosition.row + 1,
            endLine: topLevel[topLevel.length - 1].endPosition.row + 1,
            indent: topLevel[0].startPosition.column,
            modifiers: ['static', 'top-level'],
            namespace: namespaceOf(topLevel[0], tree) || undefined,
        });
    }
    return functions;
}

function findStateObjects(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const states = [];
    traverseTreeCached(tree.rootNode, node => {
        if (node.type !== 'global_statement') return true;
        const declaration = node.namedChildren.find(child =>
            child.type === 'local_declaration_statement')?.namedChild(0);
        for (const declarator of declaration?.namedChildren || []) {
            if (declarator.type !== 'variable_declarator') continue;
            const nameNode = declarator.childForFieldName('name');
            if (!nameNode) continue;
            const { startLine, endLine, indent } = nodeToLocation(node, lines);
            states.push({
                name: nameNode.text,
                startLine,
                endLine,
                indent,
                modifiers: [],
            });
        }
        return false;
    });
    return states;
}

function enclosingFunctionOf(node) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (parent.type === 'method_declaration' ||
            parent.type === 'constructor_declaration' ||
            parent.type === 'local_function_statement') {
            if (isControlFlowLocalArtifact(parent)) continue;
            const nameNode = parent.childForFieldName('name');
            if (!nameNode) return null;
            return {
                name: nameNode.text,
                startLine: parent.startPosition.row + 1,
                endLine: parent.endPosition.row + 1,
            };
        }
        if (parent.type === 'global_statement') {
            return {
                name: 'Main',
                startLine: parent.startPosition.row + 1,
                endLine: parent.endPosition.row + 1,
            };
        }
    }
    return null;
}

function enclosingClassName(node) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (TYPE_DECLARATIONS.has(parent.type)) {
            return parent.childForFieldName('name')?.text || null;
        }
    }
    return null;
}

/** Whether a bare identifier is a field/property/event of the enclosing type. */
function enclosingTypeDeclaresMember(node, memberName) {
    let typeNode = null;
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (TYPE_DECLARATIONS.has(parent.type)) {
            typeNode = parent;
            break;
        }
    }
    const body = typeNode?.childForFieldName('body') ||
        typeNode?.namedChildren.find(child => child.type === 'declaration_list');
    if (!body) return false;
    const stack = [...(body.namedChildren || [])];
    while (stack.length > 0) {
        const current = stack.pop();
        if (TYPE_DECLARATIONS.has(current.type)) continue;
        if (current.type === 'property_declaration' ||
            current.type === 'event_declaration') {
            if (current.childForFieldName('name')?.text === memberName) return true;
            continue;
        }
        if (current.type === 'field_declaration' ||
            current.type === 'event_field_declaration') {
            for (const child of current.namedChildren || []) {
                const variables = child.type === 'variable_declaration'
                    ? child.namedChildren : [child];
                if (variables.some(variable =>
                    variable.type === 'variable_declarator' &&
                    variable.childForFieldName('name')?.text === memberName)) {
                    return true;
                }
            }
            continue;
        }
        // Preprocessor containers can wrap real declarations. Descend through
        // those and the type body, but never into methods/accessors where a
        // same-named local would not make the receiver a class member.
        if (current.type.startsWith('preproc_') || current.type === 'declaration_list') {
            stack.push(...(current.namedChildren || []));
        }
    }
    return false;
}

const CALLABLE_SCOPE_NODES = new Set([
    'method_declaration', 'constructor_declaration', 'destructor_declaration',
    'operator_declaration', 'conversion_operator_declaration',
    'local_function_statement', 'accessor_declaration',
]);

function variableScopeKey(node) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (CALLABLE_SCOPE_NODES.has(parent.type)) {
            if (isControlFlowLocalArtifact(parent)) continue;
            return parent.startPosition.row + 1;
        }
        if (parent.type === 'global_statement') return 'global';
    }
    return 'global';
}

function buildVariableTypes(tree, parser) {
    const byScope = new Map([['global', new Map()]]);
    const conflictsByScope = new Map([['global', new Set()]]);
    const scopeStack = [];
    const setType = (scope, name, type) => {
        if (!name || !type) return;
        if (!conflictsByScope.has(scope)) conflictsByScope.set(scope, new Set());
        const conflicts = conflictsByScope.get(scope);
        if (conflicts.has(name)) return;
        const types = byScope.get(scope);
        const previous = types.get(name);
        if (previous && previous !== type) {
            types.delete(name);
            conflicts.add(name);
            return;
        }
        types.set(name, type);
    };
    traverseTree(tree.rootNode, node => {
        if (CALLABLE_SCOPE_NODES.has(node.type) &&
            !isControlFlowLocalArtifact(node)) {
            const key = node.startPosition.row + 1;
            scopeStack.push(key);
            if (!byScope.has(key)) byScope.set(key, new Map());
            if (!conflictsByScope.has(key)) conflictsByScope.set(key, new Set());
        }
        const currentKey = scopeStack[scopeStack.length - 1] || 'global';
        if (isControlFlowLocalArtifact(node)) {
            const paramsNode = node.childForFieldName('parameters');
            const raw = paramsNode?.text;
            if (raw?.startsWith('(') && raw.endsWith(')')) {
                const expression = raw.slice(1, -1);
                const synthetic =
                    `class __UcnRecovery { bool __Call() => ${expression}; }`;
                const recovered = safeParse(
                    parser, synthetic, undefined, PARSE_OPTIONS);
                traverseTree(recovered.rootNode, recoveredNode => {
                    if (recoveredNode.type !== 'declaration_pattern' &&
                        recoveredNode.type !== 'declaration_expression') {
                        return true;
                    }
                    const name =
                        recoveredNode.childForFieldName('name')?.text ||
                        recoveredNode.namedChildren.at(-1)?.text;
                    const type =
                        recoveredNode.childForFieldName('type')?.text ||
                        recoveredNode.namedChild(0)?.text;
                    setType(currentKey, name, type);
                    return true;
                });
            }
        }
        if (node.type === 'parameter') {
            let artifactParameter = false;
            for (let parent = node.parent; parent; parent = parent.parent) {
                if (isControlFlowLocalArtifact(parent)) {
                    artifactParameter = true;
                    break;
                }
                if (CALLABLE_SCOPE_NODES.has(parent.type)) break;
            }
            if (artifactParameter) return true;
            const name = node.childForFieldName('name')?.text;
            const type = node.childForFieldName('type')?.text;
            setType(currentKey, name, type);
        } else if (node.type === 'declaration_pattern' ||
            node.type === 'declaration_expression') {
            const name = node.childForFieldName('name')?.text ||
                node.namedChildren.at(-1)?.text;
            const type = node.childForFieldName('type')?.text ||
                node.namedChild(0)?.text;
            setType(currentKey, name, type);
        } else if (node.type === 'variable_declaration') {
            // Class fields have their own declared-field receiver path; do not
            // leak them into the top-level-program local scope.
            if (scopeStack.length === 0) {
                let inGlobal = false;
                for (let parent = node.parent; parent; parent = parent.parent) {
                    if (parent.type === 'global_statement') {
                        inGlobal = true;
                        break;
                    }
                    if (TYPE_DECLARATIONS.has(parent.type)) break;
                }
                if (!inGlobal) return true;
            }
            const typeNode = node.childForFieldName('type');
            // A disabled preprocessor branch can make a switch label plus
            // following invocation look like `case <declarator>`. `case` is
            // not a type, so it must never overwrite a real parameter/local
            // receiver type (for example `JsonWriter writer`).
            if (typeNode?.text === 'case') return true;
            for (const declarator of node.namedChildren || []) {
                if (declarator.type !== 'variable_declarator') continue;
                const name = declarator.childForFieldName('name')?.text;
                const value = declarator.childForFieldName('value') ||
                    declarator.namedChildren.find(child => child.type === 'object_creation_expression');
                const dynamicType = value?.type === 'object_creation_expression'
                    ? value.childForFieldName('type')?.text : null;
                const type = dynamicType || (typeNode?.text !== 'var' ? typeNode?.text : null);
                setType(currentKey, name, type);
            }
        }
        return true;
    }, {
        onLeave(node) {
            if (CALLABLE_SCOPE_NODES.has(node.type) &&
                !isControlFlowLocalArtifact(node)) {
                scopeStack.pop();
            }
        },
    });
    return byScope;
}

function normalizeReceiverType(raw) {
    if (!raw) return null;
    let value = String(raw).trim().replace(/\?$/, '');
    if (value.endsWith('[]')) return { name: 'Array', namespace: 'System' };
    value = value.replace(/^global::/, '').replace(/::/g, '.');
    const match = value.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:<.*>)?$/s);
    if (!match) return null;
    const parts = match[1].split('.');
    return {
        name: parts.pop(),
        ...(parts.length > 0 && { namespace: parts.join('.') }),
    };
}

function literalReceiverType(node) {
    if (!node) return null;
    if (node.type === 'string_literal' ||
        node.type === 'verbatim_string_literal' ||
        node.type === 'interpolated_string_expression') {
        return { name: 'string', namespace: 'System' };
    }
    if (node.type === 'character_literal') {
        return { name: 'char', namespace: 'System' };
    }
    return null;
}

function unwrapReceiverNode(node) {
    let current = node;
    while (current && current.namedChildCount === 1 &&
        (current.type === 'parenthesized_expression' ||
         current.type === 'postfix_unary_expression')) {
        current = current.namedChild(0);
    }
    return current;
}

/**
 * Preserve compiler-visible receiver types which do not come from a local
 * declaration. Casts are especially important in C#: `((IList)value).Add()`
 * performs lookup on IList, not on every project method named Add.
 */
function receiverTypeFromNode(node, variableTypes) {
    const current = unwrapReceiverNode(node);
    if (!current) return null;
    const literal = literalReceiverType(current);
    if (literal) return literal;
    if (current.type === 'cast_expression') {
        return normalizeReceiverType(current.childForFieldName('type')?.text);
    }
    if (current.type === 'object_creation_expression') {
        return normalizeReceiverType(current.childForFieldName('type')?.text);
    }
    if (current.type === 'identifier') {
        return normalizeReceiverType(variableTypes?.get(current.text));
    }
    return null;
}

function receiverCastIsThis(node) {
    const current = unwrapReceiverNode(node);
    if (current?.type !== 'cast_expression') return false;
    const value = unwrapReceiverNode(current.childForFieldName('value') ||
        current.namedChildren[current.namedChildCount - 1]);
    return value?.text === 'this' || value?.text === 'base';
}

/**
 * Decompose a receiver into a declared root plus a member path. Query-time
 * resolution walks the indexed field/property types one hop at a time. This
 * covers `_list!.CopyTo()`, `_resolver.LoadedSchemas.Add()`, and conditional
 * access without guessing a final runtime type in the parser.
 */
function receiverFieldPath(node, variableTypes, enclosingClass) {
    const current = unwrapReceiverNode(node);
    if (!current) return null;
    if (current.type === 'this_expression' || current.type === 'base_expression' ||
        current.text === 'this' || current.text === 'base') {
        return enclosingClass
            ? { root: current.text, fields: [], rootType: enclosingClass }
            : null;
    }
    if (current.type === 'identifier') {
        const declared = normalizeReceiverType(variableTypes?.get(current.text));
        if (declared) {
            return {
                root: current.text,
                fields: [],
                rootType: declared.name,
                ...(declared.namespace && { rootNamespace: declared.namespace }),
            };
        }
        return {
            root: 'this',
            fields: [current.text],
            ...(enclosingClass && { rootType: enclosingClass }),
        };
    }
    if (current.type === 'member_access_expression') {
        const expression = current.childForFieldName('expression') || current.namedChild(0);
        const member = current.childForFieldName('name') ||
            current.namedChildren[current.namedChildCount - 1];
        const path = receiverFieldPath(expression, variableTypes, enclosingClass);
        return path && member
            ? { ...path, fields: [...path.fields, member.text] }
            : null;
    }
    if (current.type === 'conditional_access_expression') {
        const expression = current.childForFieldName('condition') || current.namedChild(0);
        const binding = current.namedChildren.find(child =>
            child.type === 'member_binding_expression');
        const member = binding?.childForFieldName('name') || binding?.namedChild(0);
        const path = receiverFieldPath(expression, variableTypes, enclosingClass);
        return path && member
            ? { ...path, fields: [...path.fields, member.text] }
            : null;
    }
    return null;
}

function invocationIdentity(node) {
    if (!node) return {};
    if (node.type === 'identifier' || node.type === 'generic_name') {
        return { name: node.type === 'generic_name' ? node.namedChild(0)?.text : node.text,
            nameNode: node, isMethod: false };
    }
    if (node.type === 'member_access_expression' || node.type === 'member_binding_expression') {
        const nameNode = node.childForFieldName('name') ||
            node.namedChildren[node.namedChildCount - 1];
        const expression = node.childForFieldName('expression') || node.namedChild(0);
        return {
            name: nameNode?.type === 'generic_name' ? nameNode.namedChild(0)?.text : nameNode?.text,
            nameNode,
            receiver: expression?.text,
            isMethod: true,
        };
    }
    if (node.type === 'conditional_access_expression') {
        const expression = node.childForFieldName('condition') ||
            node.namedChild(0);
        const binding = node.namedChildren.find(child =>
            child.type === 'member_binding_expression');
        const nameNode = binding?.childForFieldName('name') ||
            binding?.namedChild(0);
        return {
            name: nameNode?.type === 'generic_name'
                ? nameNode.namedChild(0)?.text : nameNode?.text,
            nameNode,
            receiver: expression?.text,
            isMethod: true,
        };
    }
    return {};
}

function staticMemberPath(node, variableTypes) {
    if (!node) return null;
    if (node.type === 'identifier') {
        const type = variableTypes?.get(node.text);
        if (type) return [type];
        return /^[A-Z]/.test(node.text) ? [node.text] : null;
    }
    if (node.type === 'member_access_expression') {
        const expression = node.childForFieldName('expression') ||
            node.namedChild(0);
        const member = node.childForFieldName('name') ||
            node.namedChildren[node.namedChildCount - 1];
        const path = staticMemberPath(expression, variableTypes);
        return path && member ? [...path, member.text] : null;
    }
    if (node.type === 'element_access_expression') {
        const expression = node.childForFieldName('expression') ||
            node.namedChild(0);
        const path = staticMemberPath(expression, variableTypes);
        return path ? [...path, '[]'] : null;
    }
    if (node.type === 'conditional_access_expression') {
        const expression = node.childForFieldName('condition') ||
            node.namedChild(0);
        const binding = node.namedChildren.find(child =>
            child.type === 'member_binding_expression');
        const member = binding?.childForFieldName('name') ||
            binding?.namedChild(0);
        const path = staticMemberPath(expression, variableTypes);
        return path && member ? [...path, member.text] : null;
    }
    if (node.type === 'parenthesized_expression' &&
        node.namedChildCount === 1) {
        return staticMemberPath(node.namedChild(0), variableTypes);
    }
    return null;
}

function staticArgKind(node, variableTypes) {
    if (!node) return 'expr';
    switch (node.type) {
        case 'string_literal':
        case 'verbatim_string_literal':
        case 'interpolated_string_expression':
            return 'string';
        case 'character_literal':
            return 'char';
        case 'integer_literal':
            return /[lL]$/.test(node.text) ? 'long' : 'int';
        case 'real_literal':
            return /[fF]$/.test(node.text) ? 'float' : 'double';
        case 'boolean_literal':
            return 'boolean';
        case 'null_literal':
            return 'null';
        case 'object_creation_expression': {
            const type = node.childForFieldName('type');
            return type ? `new:${type.text}` : 'expr';
        }
        case 'array_creation_expression': {
            const type = node.childForFieldName('type');
            return type ? `type:${type.text}` : 'expr';
        }
        case 'cast_expression': {
            const type = node.childForFieldName('type');
            return type ? `cast:${type.text}` : 'expr';
        }
        case 'identifier': {
            const type = variableTypes?.get(node.text);
            return type ? `type:${type}` : 'expr';
        }
        case 'member_access_expression': {
            const path = staticMemberPath(node, variableTypes);
            if (path?.length > 1) {
                return `fieldpath:${path.map(encodeURIComponent).join('|')}`;
            }
            const owner = node.childForFieldName('expression') || node.namedChild(0);
            const member = node.childForFieldName('name') ||
                node.namedChildren[node.namedChildCount - 1];
            if (!owner || !member) return 'expr';
            const ownerType = owner.type === 'identifier'
                ? variableTypes?.get(owner.text)
                : null;
            return `field:${ownerType || owner.text}:${member.text}`;
        }
        case 'invocation_expression': {
            const identity = invocationIdentity(node.childForFieldName('function'));
            if (identity.name === 'GetValueOrDefault' && identity.receiver) {
                const rawType = variableTypes?.get(identity.receiver);
                if (rawType?.trim().endsWith('?')) {
                    return `type:${rawType.trim().slice(0, -1)}`;
                }
            }
            if (identity.name === 'ToString') return 'type:string';
            if (identity.receiver === 'Convert' &&
                CONVERT_RETURN_TYPES.has(identity.name)) {
                return `type:${CONVERT_RETURN_TYPES.get(identity.name)}`;
            }
            if (identity.receiver) {
                const receiverType = variableTypes?.get(identity.receiver) ||
                    identity.receiver;
                const argsNode = node.childForFieldName('arguments') ||
                    node.namedChildren.find(child =>
                        child.type === 'argument_list');
                const kinds = (argsNode?.namedChildren || [])
                    .filter(child => child.type === 'argument')
                    .map(argument =>
                        staticArgKind(argument.namedChild(0), variableTypes));
                return `callshape:${encodeURIComponent(receiverType)}|` +
                    `${encodeURIComponent(identity.name)}|` +
                    kinds.map(encodeURIComponent).join(',');
            }
            return 'expr';
        }
        case 'conditional_access_expression': {
            const path = staticMemberPath(node, variableTypes);
            if (path?.length > 1) {
                return `fieldpath:${path.map(encodeURIComponent).join('|')}`;
            }
            const owner = node.namedChild(0);
            const binding = node.namedChildren.find(child =>
                child.type === 'member_binding_expression');
            const member = binding?.childForFieldName('name') ||
                binding?.namedChild(0);
            if (!owner || !member) return 'expr';
            const ownerType = owner.type === 'identifier'
                ? variableTypes?.get(owner.text)
                : null;
            return `field:${ownerType || owner.text}:${member.text}`;
        }
        case 'conditional_expression': {
            const consequence = node.childForFieldName('consequence');
            const alternative = node.childForFieldName('alternative');
            const left = staticArgKind(consequence, variableTypes);
            const right = staticArgKind(alternative, variableTypes);
            if (left === right) return left;
            const typed = kind => /^(?:new|cast|type):(.+)$/.exec(kind)?.[1] || null;
            const leftType = typed(left);
            const rightType = typed(right);
            if (left === 'null' && rightType) return `type:${rightType}`;
            if (right === 'null' && leftType) return `type:${leftType}`;
            if (leftType && rightType &&
                leftType.replace(/\?$/, '') === rightType.replace(/\?$/, '')) {
                const nullable = leftType.endsWith('?') ? leftType : rightType;
                return `type:${nullable}`;
            }
            return 'expr';
        }
        case 'parenthesized_expression':
            return node.namedChildCount === 1
                ? staticArgKind(node.namedChild(0), variableTypes)
                : 'expr';
        case 'prefix_unary_expression':
            return node.namedChildCount === 1
                ? staticArgKind(node.namedChild(0), variableTypes)
                : 'expr';
        case 'lambda_expression':
        case 'anonymous_method_expression':
            return 'lambda';
        default:
            return 'expr';
    }
}

function callArgs(node, variableTypes) {
    const argsNode = node.childForFieldName('arguments') ||
        node.namedChildren.find(child => child.type === 'argument_list');
    const args = (argsNode?.namedChildren || []).filter(child => child.type === 'argument');
    const argKinds = args.map(argument =>
        staticArgKind(argument.namedChild(0), variableTypes));
    return {
        argCount: args.length,
        ...(argKinds.some(kind => kind !== 'expr') && { argKinds }),
        firstArg: args[0]?.namedChild(0),
        args,
    };
}

function assignmentTargetOf(callNode) {
    let value = callNode;
    let assignedUnwrap = false;
    while (value.parent && (value.parent.type === 'await_expression' ||
        value.parent.type === 'parenthesized_expression')) {
        if (value.parent.type === 'await_expression') assignedUnwrap = true;
        value = value.parent;
    }
    const parent = value.parent;
    if (parent?.type === 'variable_declarator') {
        const name = parent.childForFieldName('name');
        return name ? { assignedTo: name.text, assignedUnwrap } : null;
    }
    if (parent?.type === 'assignment_expression') {
        const left = parent.childForFieldName('left') || parent.namedChild(0);
        return left?.type === 'identifier'
            ? { assignedTo: left.text, assignedUnwrap }
            : null;
    }
    return null;
}

function findCallsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const variableTypesByScope = buildVariableTypes(tree, parser);
    const calls = [];
    traverseTree(tree.rootNode, node => {
        const variableTypes = variableTypesByScope.get(variableScopeKey(node)) ||
            variableTypesByScope.get('global');
        if (isControlFlowLocalArtifact(node)) {
            const paramsNode = node.childForFieldName('parameters');
            const raw = paramsNode?.text;
            if (raw?.startsWith('(') && raw.endsWith(')')) {
                const expression = raw.slice(1, -1);
                const synthetic = `class __UcnRecovery { bool __Call() => ${expression}; }`;
                const recovered = findCallsInCode(synthetic, parser);
                for (const call of recovered) {
                    calls.push({
                        ...call,
                        line: node.startPosition.row + call.line,
                        enclosingFunction: enclosingFunctionOf(node),
                    });
                }
            }
            // Keep traversing the artifact's real block; its body still
            // contains valid invocation AST nodes.
            return true;
        }
        if (node.type === 'invocation_expression') {
            const identity = invocationIdentity(node.childForFieldName('function'));
            if (!identity.name) return true;
            const args = callArgs(node, variableTypes);
            const first = extractStringArg(args.firstArg);
            const receiverRoot = identity.receiver?.split('.')[0];
            const functionNode = node.childForFieldName('function');
            const receiverNode = functionNode?.type === 'member_access_expression'
                ? functionNode.childForFieldName('expression') || functionNode.namedChild(0)
                : functionNode?.type === 'conditional_access_expression'
                    ? functionNode.childForFieldName('condition') || functionNode.namedChild(0)
                    : null;
            const unwrappedReceiverNode = unwrapReceiverNode(receiverNode);
            // A root variable's type is the receiver type only for a direct
            // `value.Method()` call. For `value.Property.Method()` the static
            // receiver type is the property's declared type, not `value`'s
            // type. Preserve that shape as a field path for query-time
            // declaration walking; collapsing it to the root class falsely
            // confirms sibling overrides (Newtonsoft JProperty.Value is a
            // JToken, not a JProperty).
            const receiverTypeInfo = receiverTypeFromNode(
                receiverNode, variableTypes) ||
                (unwrappedReceiverNode?.type === 'identifier'
                    ? normalizeReceiverType(
                        receiverRoot && variableTypes.get(receiverRoot))
                    : null);
            const receiverType = receiverTypeInfo?.name;
            const receiverCastThis = receiverCastIsThis(receiverNode);
            const receiverIsTypeQualified = !!(identity.isMethod &&
                unwrappedReceiverNode?.type === 'identifier' &&
                /^[A-Z]/.test(identity.receiver || '') &&
                !variableTypes.has(identity.receiver) &&
                !enclosingTypeDeclaresMember(node, identity.receiver));
            const currentNamespace = namespaceOf(node, tree);
            let receiverCall = null;
            let receiverCallIsMethod = false;
            let receiverCallLine = null;
            let receiverCallReceiver = null;
            if (receiverNode?.type === 'invocation_expression') {
                const producer = invocationIdentity(receiverNode.childForFieldName('function'));
                if (producer.name) {
                    receiverCall = producer.name;
                    receiverCallIsMethod = producer.isMethod;
                    receiverCallLine = producer.nameNode?.startPosition.row + 1 ||
                        receiverNode.startPosition.row + 1;
                    receiverCallReceiver = producer.receiver;
                }
            }
            const assignment = assignmentTargetOf(node);
            let fieldRoot, fieldName, fieldNames, fieldRootType, fieldRootNamespace;
            if (identity.isMethod && !receiverType && identity.receiver &&
                !receiverIsTypeQualified) {
                const fieldPath = receiverFieldPath(
                    receiverNode, variableTypes, enclosingClassName(node));
                if (fieldPath?.fields.length) {
                    fieldRoot = fieldPath.root;
                    fieldNames = fieldPath.fields;
                    fieldName = fieldNames[fieldNames.length - 1];
                    fieldRootType = fieldPath.rootType;
                    fieldRootNamespace = fieldPath.rootNamespace || currentNamespace;
                }
            }
            calls.push({
                name: identity.name,
                line: identity.nameNode?.startPosition.row + 1 || node.startPosition.row + 1,
                isMethod: identity.isMethod,
                ...(identity.receiver && { receiver: identity.receiver }),
                ...(receiverIsTypeQualified && { receiverIsTypeQualified: true }),
                ...(receiverType && { receiverType }),
                ...(receiverCastThis && { receiverCastThis: true }),
                ...(receiverType && receiverTypeInfo.namespace && {
                    receiverTypeNamespace: receiverTypeInfo.namespace,
                }),
                ...(fieldName && {
                    receiverRoot: fieldRoot,
                    receiverField: fieldName,
                    receiverFields: fieldNames,
                    ...(fieldRootType && { receiverRootType: fieldRootType }),
                    ...(fieldRootNamespace && { receiverRootNamespace: fieldRootNamespace }),
                }),
                ...(receiverCall && { receiverCall }),
                ...(receiverCallIsMethod && { receiverCallIsMethod: true }),
                ...(receiverCallLine && { receiverCallLine }),
                ...(receiverCallReceiver && { receiverCallReceiver }),
                ...(assignment?.assignedTo && { assignedTo: assignment.assignedTo }),
                ...(assignment?.assignedUnwrap && { assignedUnwrap: true }),
                argCount: args.argCount,
                ...(args.argKinds && { argKinds: args.argKinds }),
                enclosingFunction: enclosingFunctionOf(node),
                ...(first && {
                    firstStringArg: first.value,
                    firstStringArgInterp: first.interp,
                }),
            });
            // Minimal API registrations and other framework callbacks pass
            // method groups as arguments (`app.MapGet("/x", Handle)`). Keep
            // those references in the same call cache so entrypoint detection
            // and ordinary caller analysis share one AST-derived record.
            for (const argument of args.args.slice(1)) {
                const value = argument.namedChild(0);
                if (!value) continue;
                let callbackName = null;
                let callbackReceiver = null;
                if (value.type === 'identifier') {
                    callbackName = value.text;
                } else if (value.type === 'member_access_expression') {
                    const callback = invocationIdentity(value);
                    callbackName = callback.name;
                    callbackReceiver = callback.receiver;
                }
                if (!callbackName) continue;
                calls.push({
                    name: callbackName,
                    line: value.startPosition.row + 1,
                    isMethod: !!callbackReceiver,
                    ...(callbackReceiver && { receiver: callbackReceiver }),
                    isFunctionReference: true,
                    isPotentialCallback: true,
                    enclosingFunction: enclosingFunctionOf(node),
                });
            }
            return true;
        }
        if (node.type === 'object_creation_expression' ||
            node.type === 'implicit_object_creation_expression') {
            const typeNode = node.childForFieldName('type');
            if (!typeNode) return true;
            const args = callArgs(node, variableTypes);
            const raw = typeNode.text.replace(/<.*>$/, '');
            const name = raw.split('.').pop();
            calls.push({
                name,
                line: typeNode.startPosition.row + 1,
                isMethod: false,
                isConstructor: true,
                argCount: args.argCount,
                ...(args.argKinds && { argKinds: args.argKinds }),
                enclosingFunction: enclosingFunctionOf(node),
            });
        }
        return true;
    });
    return calls;
}

function findImportsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const imports = [];
    traverseTreeCached(tree.rootNode, node => {
        if (node.type !== 'using_directive') return true;
        const nameNode = node.childForFieldName('name');
        const named = node.namedChildren || [];
        const moduleNode = named[named.length - 1];
        if (!moduleNode) return false;
        imports.push({
            module: moduleNode.text,
            names: nameNode ? [nameNode.text] : ['*'],
            type: 'using',
            line: node.startPosition.row + 1,
            ...(node.text.trimStart().startsWith('global using ') && { global: true }),
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
            if ((parent.type === 'method_declaration' ||
                parent.type === 'constructor_declaration' ||
                TYPE_DECLARATIONS.has(parent.type) ||
                parent.type === 'parameter' ||
                parent.type === 'variable_declarator') &&
                (sameNode(parent.childForFieldName('name'), node))) {
                usageType = 'definition';
            } else if (parent.type === 'invocation_expression' ||
                parent.parent?.type === 'invocation_expression') {
                usageType = 'call';
            } else if (parent.type === 'using_directive') {
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
    const decorators = new Set(symbol.decorators || []);
    if (symbol.name === 'Main' && symbol.modifiers?.includes('static')) return 'main';
    if (decorators.has('Fact') || decorators.has('Theory') ||
        decorators.has('Test') || decorators.has('TestMethod')) return 'test';
    if ([...decorators].some(name => /^(Http(Get|Post|Put|Delete|Patch)|Route|ApiController)$/.test(name))) {
        return 'framework';
    }
    return null;
}

function isEntryPoint(symbol) {
    return getEntryPointKind(symbol) !== null;
}

// Stable BCL receiver identities used only after AST/declaration typing has
// proved the static receiver type. Interfaces are included intentionally:
// core still checks whether the pinned project type implements the interface
// before excluding, so virtual dispatch remains visible when it is possible.
const CSHARP_PLATFORM_RECEIVER_TYPES = new Set([
    'List', 'Dictionary', 'HashSet', 'Queue', 'Stack',
    'IEnumerable', 'ICollection', 'IList', 'IDictionary',
    'IReadOnlyCollection', 'IReadOnlyList', 'IReadOnlyDictionary',
    'BinaryReader', 'BinaryWriter', 'TextReader', 'TextWriter',
    'StringReader', 'StringWriter',
    'Type', 'MemberInfo', 'FieldInfo', 'PropertyInfo', 'MethodInfo',
]);

function isPlatformConcreteCall(receiverType, _methodName) {
    const normalized = normalizeReceiverType(receiverType);
    return !!normalized && CSHARP_PLATFORM_RECEIVER_TYPES.has(normalized.name);
}

function parse(code, parser) {
    const tree = parseTree(parser, code);
    return {
        language: 'csharp',
        totalLines: code.length === 0 ? 0 : code.split('\n').length,
        functions: findFunctions(code, parser),
        classes: findClasses(code, parser),
        stateObjects: findStateObjects(code, parser),
        imports: findImportsInCode(code, parser),
        exports: findExportsInCodeShallow(code, parser),
        ...(tree.rootNode.hasError && { parseRecovery: true }),
    };
}

function findExportsInCodeShallow(code, parser) {
    const classes = findClasses(code, parser);
    const exports = [];
    for (const cls of classes) {
        if (cls.modifiers.includes('public')) {
            exports.push({ name: cls.name, type: 'export', line: cls.startLine });
        }
    }
    return exports;
}

module.exports = {
    findFunctions,
    findClasses,
    findStateObjects,
    findCallsInCode,
    findImportsInCode,
    findExportsInCode: findExportsInCodeShallow,
    findUsagesInCode,
    isPlatformConcreteCall,
    isEntryPoint,
    getEntryPointKind,
    parse,
};
