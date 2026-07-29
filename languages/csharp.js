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
    for (const param of paramsNode.namedChildren || []) {
        if (param.type !== 'parameter' && param.type !== 'parameter_array') continue;
        const nameNode = param.childForFieldName('name');
        const typeNode = param.childForFieldName('type');
        if (!nameNode) continue;
        const info = { name: nameNode.text };
        if (typeNode) info.type = typeNode.text;
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
    const methodLike = node.type === 'method_declaration' ||
        node.type === 'constructor_declaration' ||
        node.type === 'destructor_declaration' ||
        node.type === 'operator_declaration' ||
        node.type === 'conversion_operator_declaration';
    if (!methodLike) return null;
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
    return {
        name,
        params: paramsNode ? paramsNode.text.replace(/^\(|\)$/g, '').trim() : '...',
        paramsStructured: structuredParams(paramsNode),
        returnType: isConstructor ? null : returnNode?.text || null,
        startLine,
        endLine,
        indent,
        modifiers,
        memberType: isConstructor ? 'constructor' : 'method',
        isMethod: true,
        isConstructor,
        className,
        isAsync: modifiers.includes('async'),
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
        if (!nameNode) continue;
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
    if (!nameNode) return null;
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
        for (const child of body?.namedChildren || []) {
            if (TYPE_DECLARATIONS.has(child.type)) continue;
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
        classes.push({
            name: nameNode.text,
            type,
            startLine,
            endLine,
            indent,
            modifiers: modifiersOf(node),
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

function buildVariableTypes(tree) {
    const types = new Map();
    traverseTree(tree.rootNode, node => {
        if (node.type === 'parameter') {
            const name = node.childForFieldName('name')?.text;
            const type = node.childForFieldName('type')?.text;
            if (name && type) types.set(name, type);
        } else if (node.type === 'variable_declaration') {
            const typeNode = node.childForFieldName('type');
            for (const declarator of node.namedChildren || []) {
                if (declarator.type !== 'variable_declarator') continue;
                const name = declarator.childForFieldName('name')?.text;
                const value = declarator.childForFieldName('value') ||
                    declarator.namedChildren.find(child => child.type === 'object_creation_expression');
                const dynamicType = value?.type === 'object_creation_expression'
                    ? value.childForFieldName('type')?.text : null;
                const type = dynamicType || (typeNode?.text !== 'var' ? typeNode?.text : null);
                if (name && type) types.set(name, type);
            }
        }
        return true;
    });
    return types;
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
    return {};
}

function callArgs(node) {
    const argsNode = node.childForFieldName('arguments') ||
        node.namedChildren.find(child => child.type === 'argument_list');
    const args = (argsNode?.namedChildren || []).filter(child => child.type === 'argument');
    return {
        argCount: args.length,
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
    const variableTypes = buildVariableTypes(tree);
    const calls = [];
    traverseTree(tree.rootNode, node => {
        if (node.type === 'invocation_expression') {
            const identity = invocationIdentity(node.childForFieldName('function'));
            if (!identity.name) return true;
            const args = callArgs(node);
            const first = extractStringArg(args.firstArg);
            const receiverRoot = identity.receiver?.split('.')[0];
            const receiverTypeInfo = normalizeReceiverType(
                receiverRoot && variableTypes.get(receiverRoot));
            const receiverType = receiverTypeInfo?.name;
            const currentNamespace = namespaceOf(node, tree);
            const functionNode = node.childForFieldName('function');
            const receiverNode = functionNode?.type === 'member_access_expression'
                ? functionNode.childForFieldName('expression') || functionNode.namedChild(0)
                : null;
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
            let fieldRoot, fieldName, fieldRootType;
            if (identity.isMethod && !receiverType && identity.receiver) {
                const parts = identity.receiver.split('.');
                if (parts.length === 2 && (parts[0] === 'this' || parts[0] === 'base')) {
                    fieldRoot = parts[0];
                    fieldName = parts[1];
                    fieldRootType = enclosingClassName(node);
                } else if (parts.length === 1 && !variableTypes.has(parts[0])) {
                    fieldRoot = 'this';
                    fieldName = parts[0];
                    fieldRootType = enclosingClassName(node);
                }
            }
            calls.push({
                name: identity.name,
                line: identity.nameNode?.startPosition.row + 1 || node.startPosition.row + 1,
                isMethod: identity.isMethod,
                ...(identity.receiver && { receiver: identity.receiver }),
                ...(receiverType && { receiverType }),
                ...(receiverType && {
                    receiverTypeNamespace: receiverTypeInfo.namespace || currentNamespace,
                }),
                ...(fieldName && {
                    receiverRoot: fieldRoot,
                    receiverField: fieldName,
                    receiverRootType: fieldRootType,
                    ...(currentNamespace && { receiverRootNamespace: currentNamespace }),
                }),
                ...(receiverCall && { receiverCall }),
                ...(receiverCallIsMethod && { receiverCallIsMethod: true }),
                ...(receiverCallLine && { receiverCallLine }),
                ...(receiverCallReceiver && { receiverCallReceiver }),
                ...(assignment?.assignedTo && { assignedTo: assignment.assignedTo }),
                ...(assignment?.assignedUnwrap && { assignedUnwrap: true }),
                argCount: args.argCount,
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
            const args = callArgs(node);
            const raw = typeNode.text.replace(/<.*>$/, '');
            const name = raw.split('.').pop();
            calls.push({
                name,
                line: typeNode.startPosition.row + 1,
                isMethod: false,
                isConstructor: true,
                argCount: args.argCount,
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
        for (const member of cls.members || []) {
            if (member.modifiers?.includes('public')) {
                exports.push({ name: member.name, type: 'export', line: member.startLine });
            }
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
    isEntryPoint,
    getEntryPointKind,
    parse,
};
