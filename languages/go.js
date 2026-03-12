/**
 * languages/go.js - Tree-sitter based Go parsing
 *
 * Handles: function declarations, method declarations (with receivers),
 * struct/interface types, and const/var declarations.
 */

const {
    traverseTree,
    nodeToLocation,
    parseStructuredParams,
    extractGoDocstring
} = require('./utils');
const { PARSE_OPTIONS, safeParse } = require('./index');

function parseTree(parser, code) {
    return safeParse(parser, code, undefined, PARSE_OPTIONS);
}

/**
 * Extract return type from Go function/method
 */
function extractReturnType(node) {
    const resultNode = node.childForFieldName('result');
    if (resultNode) {
        return resultNode.text.trim() || null;
    }
    return null;
}

/**
 * Extract Go parameters
 */
function extractGoParams(paramsNode) {
    if (!paramsNode) return '...';
    const text = paramsNode.text;
    let params = text.replace(/^\(|\)$/g, '').trim();
    if (!params) return '...';
    return params;
}

/**
 * Extract receiver from method declaration
 */
function extractReceiver(receiverNode) {
    if (!receiverNode) return null;
    const text = receiverNode.text;
    // Match named receiver: (r *Router) or (r Router[T])
    const namedMatch = text.match(/\(\s*\w+\s+(\*?\w+(?:\[[\w,\s]+\])?)\s*\)/);
    if (namedMatch) return namedMatch[1];
    // Match unnamed receiver: (Router) or (*Router) or (Router[T])
    const unnamedMatch = text.match(/\(\s*(\*?\w+(?:\[[\w,\s]+\])?)\s*\)/);
    if (unnamedMatch) return unnamedMatch[1];
    return text.replace(/^\(|\)$/g, '').trim();
}

/**
 * Find all functions in Go code using tree-sitter
 */
function findFunctions(code, parser) {
    const tree = parseTree(parser, code);
    const functions = [];
    const processedRanges = new Set();

    traverseTree(tree.rootNode, (node) => {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;

        // Function declarations
        if (node.type === 'function_declaration') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            const nameNode = node.childForFieldName('name');
            const paramsNode = node.childForFieldName('parameters');

            if (nameNode) {
                const { startLine, endLine, indent } = nodeToLocation(node, code);
                const returnType = extractReturnType(node);
                const docstring = extractGoDocstring(code, startLine);
                const typeParams = extractTypeParams(node);

                // Check if exported (capitalized)
                const isExported = /^[A-Z]/.test(nameNode.text);

                functions.push({
                    name: nameNode.text,
                    params: extractGoParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'go'),
                    startLine,
                    endLine,
                    indent,
                    modifiers: isExported ? ['export'] : [],
                    ...(returnType && { returnType }),
                    ...(docstring && { docstring }),
                    ...(typeParams && { generics: typeParams })
                });
            }
            return true;
        }

        // Method declarations (with receivers)
        if (node.type === 'method_declaration') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            const nameNode = node.childForFieldName('name');
            const paramsNode = node.childForFieldName('parameters');
            const receiverNode = node.childForFieldName('receiver');

            if (nameNode) {
                const { startLine, endLine, indent } = nodeToLocation(node, code);
                const receiver = extractReceiver(receiverNode);
                const returnType = extractReturnType(node);
                const docstring = extractGoDocstring(code, startLine);

                // Check if exported
                const isExported = /^[A-Z]/.test(nameNode.text);

                functions.push({
                    name: nameNode.text,
                    params: extractGoParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'go'),
                    startLine,
                    endLine,
                    indent,
                    isMethod: true,
                    receiver,
                    modifiers: isExported ? ['export'] : [],
                    ...(returnType && { returnType }),
                    ...(docstring && { docstring })
                });
            }
            return true;
        }

        return true;
    });

    functions.sort((a, b) => a.startLine - b.startLine);
    return functions;
}

/**
 * Extract type parameters (generics) from function/type
 */
function extractTypeParams(node) {
    const typeParamsNode = node.childForFieldName('type_parameters');
    if (typeParamsNode) {
        return typeParamsNode.text;
    }
    return null;
}

/**
 * Find all types (structs, interfaces) in Go code using tree-sitter
 */
function findClasses(code, parser) {
    const tree = parseTree(parser, code);
    const types = [];
    const processedRanges = new Set();

    traverseTree(tree.rootNode, (node) => {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;

        if (node.type === 'type_declaration') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            for (let i = 0; i < node.namedChildCount; i++) {
                const spec = node.namedChild(i);
                if (spec.type === 'type_spec') {
                    const nameNode = spec.childForFieldName('name');
                    const typeNode = spec.childForFieldName('type');

                    if (nameNode && typeNode) {
                        const { startLine, endLine } = nodeToLocation(node, code);
                        const name = nameNode.text;
                        const docstring = extractGoDocstring(code, startLine);
                        const typeParams = extractTypeParams(spec);

                        let typeKind = 'type';
                        if (typeNode.type === 'struct_type') {
                            typeKind = 'struct';
                        } else if (typeNode.type === 'interface_type') {
                            typeKind = 'interface';
                        }

                        // Check if exported
                        const isExported = /^[A-Z]/.test(name);

                        const members = typeKind === 'struct' ? extractStructFields(typeNode, code)
                            : typeKind === 'interface' ? extractInterfaceMembers(typeNode, code)
                            : [];

                        // Extract embedded field names as extends (Go composition)
                        const embeddedBases = members
                            .filter(m => m.embedded)
                            .map(m => m.name);

                        types.push({
                            name,
                            startLine,
                            endLine,
                            type: typeKind,
                            members,
                            modifiers: isExported ? ['export'] : [],
                            ...(docstring && { docstring }),
                            ...(typeParams && { generics: typeParams }),
                            ...(embeddedBases.length > 0 && { extends: embeddedBases.join(', ') })
                        });
                    }
                }
            }
            return true;
        }

        return true;
    });

    types.sort((a, b) => a.startLine - b.startLine);
    return types;
}

/**
 * Extract struct fields
 */
function extractStructFields(structNode, code) {
    const fields = [];
    // struct_type contains a field_declaration_list child (not a 'body' field)
    let fieldListNode = structNode.childForFieldName('body');
    if (!fieldListNode) {
        for (let i = 0; i < structNode.namedChildCount; i++) {
            if (structNode.namedChild(i).type === 'field_declaration_list') {
                fieldListNode = structNode.namedChild(i);
                break;
            }
        }
    }
    if (!fieldListNode) fieldListNode = structNode;

    for (let i = 0; i < fieldListNode.namedChildCount; i++) {
        const field = fieldListNode.namedChild(i);
        if (field.type === 'field_declaration') {
            const { startLine, endLine } = nodeToLocation(field, code);
            const nameNode = field.childForFieldName('name');
            const typeNode = field.childForFieldName('type');

            if (nameNode) {
                fields.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    memberType: 'field',
                    ...(typeNode && { fieldType: typeNode.text })
                });
            } else if (typeNode) {
                // Embedded field: has type but no name (e.g., `Base` in `type Child struct { Base; Name string }`)
                // Use the type name as the field name
                let embeddedName = typeNode.text;
                // Strip pointer prefix: *Base → Base
                if (embeddedName.startsWith('*')) embeddedName = embeddedName.slice(1);
                // Strip package prefix: pkg.Base → Base
                const dotIdx = embeddedName.indexOf('.');
                if (dotIdx >= 0) embeddedName = embeddedName.slice(dotIdx + 1);
                fields.push({
                    name: embeddedName,
                    startLine,
                    endLine,
                    memberType: 'field',
                    embedded: true,
                    fieldType: typeNode.text
                });
            }
        }
    }

    return fields;
}

/**
 * Extract interface method signatures
 */
function extractInterfaceMembers(interfaceNode, code) {
    const members = [];
    for (let i = 0; i < interfaceNode.namedChildCount; i++) {
        const child = interfaceNode.namedChild(i);
        // tree-sitter Go uses method_elem (or method_spec in older versions)
        if (child.type === 'method_elem' || child.type === 'method_spec') {
            const { startLine, endLine } = nodeToLocation(child, code);
            // Name is in a field_identifier child
            let nameText = null;
            let paramsText = null;
            let returnType = null;
            let hasParams = false;
            for (let j = 0; j < child.namedChildCount; j++) {
                const sub = child.namedChild(j);
                if (sub.type === 'field_identifier' || sub.type === 'type_identifier') {
                    if (!nameText) nameText = sub.text;
                } else if (sub.type === 'parameter_list') {
                    hasParams = true;
                    if (!paramsText) {
                        paramsText = sub.text.slice(1, -1); // strip parens
                    } else {
                        // Second parameter_list is the return type tuple
                        returnType = sub.text;
                    }
                }
            }
            // Also check childForFieldName for compatibility
            if (!nameText) {
                const nameNode = child.childForFieldName('name');
                if (nameNode) nameText = nameNode.text;
            }
            if (!returnType) {
                // Single return type (not a tuple) is a type_identifier
                for (let j = 0; j < child.namedChildCount; j++) {
                    const sub = child.namedChild(j);
                    if (sub.type === 'type_identifier' && sub.text !== nameText) {
                        returnType = sub.text;
                    }
                }
            }
            if (nameText) {
                // Distinguish between method signatures and embedded interfaces:
                // method_elem with parameter_list → method
                // method_elem with only type_identifier → embedded interface
                if (!hasParams && child.namedChildCount === 1 && child.namedChild(0).type === 'type_identifier') {
                    // Embedded interface
                    members.push({
                        name: nameText,
                        startLine,
                        endLine,
                        memberType: 'field',
                        embedded: true,
                        fieldType: nameText
                    });
                } else {
                    members.push({
                        name: nameText,
                        startLine,
                        endLine,
                        memberType: 'method',
                        ...(paramsText !== null && { params: paramsText }),
                        ...(returnType && { returnType })
                    });
                }
            }
        } else if (child.type === 'type_identifier' || child.type === 'qualified_type') {
            // Standalone type identifier inside interface body — embedded interface
            const { startLine, endLine } = nodeToLocation(child, code);
            let embName = child.text;
            const dotIdx = embName.indexOf('.');
            if (dotIdx >= 0) embName = embName.slice(dotIdx + 1);
            members.push({
                name: embName,
                startLine,
                endLine,
                memberType: 'field',
                embedded: true,
                fieldType: child.text
            });
        } else if (child.type === 'type_elem') {
            // type_elem wrapping a type_identifier — embedded interface
            // e.g., `Reader` in `type ReadWriter interface { Reader; Write(...) }`
            for (let j = 0; j < child.namedChildCount; j++) {
                const sub = child.namedChild(j);
                if (sub.type === 'type_identifier' || sub.type === 'qualified_type') {
                    const { startLine, endLine } = nodeToLocation(sub, code);
                    let embName = sub.text;
                    const dotIdx = embName.indexOf('.');
                    if (dotIdx >= 0) embName = embName.slice(dotIdx + 1);
                    members.push({
                        name: embName,
                        startLine,
                        endLine,
                        memberType: 'field',
                        embedded: true,
                        fieldType: sub.text
                    });
                }
            }
        }
    }
    return members;
}

/**
 * Find state objects (constants) in Go code
 */
function findStateObjects(code, parser) {
    const tree = parseTree(parser, code);
    const objects = [];

    const statePattern = /^(CONFIG|SETTINGS|[A-Z][A-Z0-9_]+|Default[A-Z][a-zA-Z]*|[A-Z][a-zA-Z]*(?:Config|Settings|Options))$/;
    // All exported (^[A-Z]) package-level const/var are indexed as state objects
    const isExportedName = (name) => /^[A-Z]/.test(name);

    // Check if a value node is a composite literal
    function isCompositeLiteral(valueNode) {
        if (!valueNode) return false;
        if (valueNode.type === 'composite_literal') return true;
        for (let i = 0; i < valueNode.namedChildCount; i++) {
            if (valueNode.namedChild(i).type === 'composite_literal') return true;
        }
        return false;
    }

    // Check if a const block uses iota (enum-like pattern)
    function blockHasIota(constDecl) {
        for (let i = 0; i < constDecl.namedChildCount; i++) {
            const spec = constDecl.namedChild(i);
            if (spec.type === 'const_spec') {
                const valueNode = spec.childForFieldName('value');
                if (valueNode) {
                    // Check if any child is 'iota'
                    const checkIota = (n) => {
                        if (n.type === 'iota') return true;
                        for (let j = 0; j < n.childCount; j++) {
                            if (checkIota(n.child(j))) return true;
                        }
                        return false;
                    };
                    if (checkIota(valueNode)) return true;
                }
            }
        }
        return false;
    }

    traverseTree(tree.rootNode, (node) => {
        // Handle const declarations
        if (node.type === 'const_declaration') {
            const isIotaBlock = blockHasIota(node);
            for (let i = 0; i < node.namedChildCount; i++) {
                const spec = node.namedChild(i);
                if (spec.type === 'const_spec') {
                    const nameNode = spec.childForFieldName('name');
                    const valueNode = spec.childForFieldName('value');
                    if (!nameNode) continue;
                    const name = nameNode.text;

                    // Include if: composite literal matching state pattern, OR exported const in iota block,
                    // OR any exported (^[A-Z]) package-level const
                    if (valueNode && isCompositeLiteral(valueNode) && statePattern.test(name)) {
                        const { startLine, endLine } = nodeToLocation(spec, code);
                        objects.push({ name, startLine, endLine });
                    } else if (isIotaBlock && /^[A-Z]/.test(name)) {
                        const { startLine, endLine } = nodeToLocation(spec, code);
                        objects.push({ name, startLine, endLine, isConst: true });
                    } else if (isExportedName(name)) {
                        const { startLine, endLine } = nodeToLocation(spec, code);
                        objects.push({ name, startLine, endLine, isConst: true });
                    }
                }
            }
            return true;
        }

        // Handle var declarations
        if (node.type === 'var_declaration') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const spec = node.namedChild(i);
                if (spec.type === 'var_spec') {
                    const nameNode = spec.childForFieldName('name');
                    const valueNode = spec.childForFieldName('value');

                    if (nameNode) {
                        const name = nameNode.text;
                        if (valueNode && isCompositeLiteral(valueNode) && statePattern.test(name)) {
                            const { startLine, endLine } = nodeToLocation(spec, code);
                            objects.push({ name, startLine, endLine });
                        } else if (isExportedName(name)) {
                            const { startLine, endLine } = nodeToLocation(spec, code);
                            objects.push({ name, startLine, endLine });
                        }
                    }
                }
            }
            return true;
        }

        return true;
    });

    objects.sort((a, b) => a.startLine - b.startLine);
    return objects;
}

/**
 * Parse a Go file completely
 */
function parse(code, parser) {
    return {
        language: 'go',
        totalLines: code.split('\n').length,
        functions: findFunctions(code, parser),
        classes: findClasses(code, parser),
        stateObjects: findStateObjects(code, parser),
        imports: [],
        exports: []
    };
}

/**
 * Find all function calls in Go code using tree-sitter AST
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{name: string, line: number, isMethod: boolean, receiver?: string}>}
 */
// Go built-in functions — calls to these should not match user-defined functions
const GO_BUILTINS = new Set([
    'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete',
    'imag', 'len', 'make', 'max', 'min', 'new', 'panic', 'print',
    'println', 'real', 'recover'
]);

function findCallsInCode(code, parser, options = {}) {
    const tree = parseTree(parser, code);
    const calls = [];
    const functionStack = [];  // Stack of { name, startLine, endLine }
    // Track local closure names per function scope (scopeStartLine -> Set<name>)
    const closureScopes = new Map();
    // Track variable -> type mappings per function scope (scopeStartLine -> Map<varName, typeName>)
    const scopeTypes = new Map();
    // Track function-typed parameter names per scope (scopeStartLine -> Set<name>)
    const funcParamScopes = new Map();

    // Build set of import aliases for distinguishing pkg.Func() from obj.Method()
    // options.imports contains resolved alias names (e.g., 'utilversion' for renamed imports,
    // 'fmt' for standard imports). These come from fileEntry.importNames.
    const importAliases = new Set();
    if (options.imports) {
        for (const name of options.imports) {
            if (name && name !== '_' && name !== '.') importAliases.add(name);
        }
    }

    // Helper to check if a node creates a function scope
    const isFunctionNode = (node) => {
        return ['function_declaration', 'method_declaration', 'func_literal'].includes(node.type);
    };

    // Extract the base type name from a type node (strips pointer, qualified, etc.)
    const extractTypeName = (typeNode) => {
        if (!typeNode) return null;
        if (typeNode.type === 'type_identifier') return typeNode.text;
        if (typeNode.type === 'pointer_type') {
            // *Framework -> Framework
            for (let i = 0; i < typeNode.namedChildCount; i++) {
                const r = extractTypeName(typeNode.namedChild(i));
                if (r) return r;
            }
        }
        if (typeNode.type === 'qualified_type') {
            // pkg.Type -> Type
            const tn = typeNode.childForFieldName('name');
            if (tn) return tn.text;
        }
        return null;
    };

    // Build type map from function/method parameters and receiver.
    // Also returns funcParamNames: parameter names with function types (func(...) ...)
    // so calls to them can be skipped (they're local parameter calls, not global function calls).
    const buildScopeTypeMap = (node) => {
        const typeMap = new Map();
        const funcParamNames = new Set();

        // Method receiver: func (f *Framework) Method()
        if (node.type === 'method_declaration') {
            const receiverNode = node.childForFieldName('receiver');
            if (receiverNode) {
                for (let i = 0; i < receiverNode.namedChildCount; i++) {
                    const param = receiverNode.namedChild(i);
                    if (param.type === 'parameter_declaration') {
                        const nameNode = param.childForFieldName('name');
                        const typeNode = param.childForFieldName('type');
                        const typeName = extractTypeName(typeNode);
                        if (nameNode && typeName) {
                            typeMap.set(nameNode.text, typeName);
                        }
                    }
                }
            }
        }

        // Function/method parameters
        // Go allows shared-type declarations: (adopt, release func(...) error)
        // childForFieldName('name') returns only the first name — iterate all identifier children
        const paramsNode = node.childForFieldName('parameters');
        if (paramsNode) {
            for (let i = 0; i < paramsNode.namedChildCount; i++) {
                const param = paramsNode.namedChild(i);
                if (param.type === 'parameter_declaration') {
                    const typeNode = param.childForFieldName('type');
                    if (!typeNode) continue;
                    // Collect all name identifiers in this declaration
                    const nameNodes = [];
                    for (let j = 0; j < param.namedChildCount; j++) {
                        const child = param.namedChild(j);
                        if (child.type === 'identifier') nameNodes.push(child);
                    }
                    if (nameNodes.length === 0) continue;
                    if (typeNode.type === 'function_type') {
                        for (const nn of nameNodes) funcParamNames.add(nn.text);
                    } else {
                        const typeName = extractTypeName(typeNode);
                        if (typeName) {
                            for (const nn of nameNodes) typeMap.set(nn.text, typeName);
                        }
                    }
                }
            }
        }

        return { typeMap, funcParamNames };
    };

    // Helper to extract function name from a function node
    const extractFunctionName = (node) => {
        if (node.type === 'function_declaration') {
            const nameNode = node.childForFieldName('name');
            return nameNode?.text || '<anonymous>';
        }
        if (node.type === 'method_declaration') {
            const nameNode = node.childForFieldName('name');
            return nameNode?.text || '<anonymous>';
        }
        if (node.type === 'func_literal') {
            return '<anonymous>';
        }
        return '<anonymous>';
    };

    // Helper to get current enclosing function
    const getCurrentEnclosingFunction = () => {
        return functionStack.length > 0
            ? { ...functionStack[functionStack.length - 1] }
            : null;
    };

    // Check if current scope has a local closure with the given name
    const isLocalClosure = (name) => {
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const scope = closureScopes.get(functionStack[i].startLine);
            if (scope?.has(name)) return true;
        }
        return false;
    };

    // Check if name is a function-typed parameter (e.g., match func(Object) bool)
    // Calls to these are local parameter invocations, not global function calls
    const isFuncTypedParam = (name) => {
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const scope = funcParamScopes.get(functionStack[i].startLine);
            if (scope?.has(name)) return true;
        }
        return false;
    };

    // Look up variable type from scope chain
    const getReceiverType = (varName) => {
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const typeMap = scopeTypes.get(functionStack[i].startLine);
            if (typeMap?.has(varName)) return typeMap.get(varName);
        }
        return undefined;
    };

    traverseTree(tree.rootNode, (node) => {
        // Track function entry
        if (isFunctionNode(node)) {
            const entry = {
                name: extractFunctionName(node),
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1
            };
            functionStack.push(entry);
            const { typeMap, funcParamNames } = buildScopeTypeMap(node);
            scopeTypes.set(entry.startLine, typeMap);
            if (funcParamNames.size > 0) {
                funcParamScopes.set(entry.startLine, funcParamNames);
            }
        }

        // Track local variable types from composite literals and typed assignments
        // e.g., s := &Status{...} → s has type Status
        //        registry := Registry{...} → registry has type Registry
        if (node.type === 'short_var_declaration' && functionStack.length > 0) {
            const left = node.childForFieldName('left');
            const right = node.childForFieldName('right');
            if (left && right) {
                const names = left.type === 'expression_list'
                    ? Array.from({ length: left.namedChildCount }, (_, i) => left.namedChild(i))
                          .filter(n => n.type === 'identifier').map(n => n.text)
                    : left.type === 'identifier' ? [left.text] : [];
                const values = right.type === 'expression_list'
                    ? Array.from({ length: right.namedChildCount }, (_, i) => right.namedChild(i))
                    : [right];
                const scopeKey = functionStack[functionStack.length - 1].startLine;
                const typeMap = scopeTypes.get(scopeKey);
                if (typeMap && names.length > 0 && values.length > 0) {
                    for (let vi = 0; vi < Math.min(names.length, values.length); vi++) {
                        const val = values[vi];
                        let typeName = null;
                        // &Type{...} or Type{...}
                        if (val.type === 'composite_literal') {
                            typeName = extractTypeName(val.childForFieldName('type'));
                        } else if (val.type === 'unary_expression' && val.childCount > 0) {
                            for (let ci = 0; ci < val.namedChildCount; ci++) {
                                const ch = val.namedChild(ci);
                                if (ch.type === 'composite_literal') {
                                    typeName = extractTypeName(ch.childForFieldName('type'));
                                    break;
                                }
                            }
                        } else if (val.type === 'call_expression') {
                            // NewFoo() or pkg.NewFoo() → infer type as Foo
                            const callFuncNode = val.childForFieldName('function');
                            if (callFuncNode) {
                                const callName = callFuncNode.type === 'identifier'
                                    ? callFuncNode.text
                                    : callFuncNode.type === 'selector_expression'
                                        ? callFuncNode.childForFieldName('field')?.text
                                        : null;
                                if (callName && /^New[A-Z]/.test(callName)) {
                                    typeName = callName.slice(3);
                                    if (!typeName || !/^[A-Z]/.test(typeName)) typeName = null;
                                }
                            }
                        }
                        if (typeName) typeMap.set(names[vi], typeName);
                    }
                }
            }
        }

        // Track local closures: atoi := func(...) { ... } or var handler = func(...) { ... }
        if (node.type === 'short_var_declaration' || node.type === 'var_declaration') {
            // Check if a subtree contains a func_literal
            const hasFunc = (n) => {
                if (!n) return false;
                if (n.type === 'func_literal') return true;
                for (let i = 0; i < n.childCount; i++) {
                    if (hasFunc(n.child(i))) return true;
                }
                return false;
            };
            let names = [];
            if (node.type === 'short_var_declaration') {
                // short_var_declaration checks the whole RHS
                if (hasFunc(node)) {
                    const left = node.childForFieldName('left');
                    if (left) {
                        names = left.type === 'expression_list'
                            ? Array.from({ length: left.namedChildCount }, (_, i) => left.namedChild(i))
                                  .filter(n => n.type === 'identifier').map(n => n.text)
                            : left.type === 'identifier' ? [left.text] : [];
                    }
                }
            } else {
                // var_declaration: check per-spec so only names with func_literal values are tracked
                // Handle both: var x = func(){} (var_declaration > var_spec)
                //          and: var (\n x = func(){} \n) (var_declaration > var_spec_list > var_spec)
                const collectClosureNames = (parent) => {
                    for (let i = 0; i < parent.namedChildCount; i++) {
                        const child = parent.namedChild(i);
                        if (child.type === 'var_spec' && hasFunc(child)) {
                            const nameNode = child.childForFieldName('name');
                            if (nameNode && nameNode.type === 'identifier') {
                                names.push(nameNode.text);
                            }
                        } else if (child.type === 'var_spec_list') {
                            collectClosureNames(child);
                        }
                    }
                };
                collectClosureNames(node);
            }
            if (names.length > 0 && functionStack.length > 0) {
                const scopeKey = functionStack[functionStack.length - 1].startLine;
                if (!closureScopes.has(scopeKey)) closureScopes.set(scopeKey, new Set());
                for (const n of names) closureScopes.get(scopeKey).add(n);
            }
        }

        // Handle function calls: foo(), pkg.Foo(), obj.Method()
        if (node.type === 'call_expression') {
            const funcNode = node.childForFieldName('function');
            if (!funcNode) return true;

            const enclosingFunction = getCurrentEnclosingFunction();
            let uncertain = false;

            if (funcNode.type === 'identifier') {
                const callName = funcNode.text;
                // Skip Go built-in function calls
                if (GO_BUILTINS.has(callName)) return true;
                // Skip calls to local closures (they shadow package-level functions)
                if (isLocalClosure(callName)) return true;
                // Skip calls to function-typed parameters (e.g., match func(Object) bool)
                // These are local parameter invocations, not calls to global functions
                if (isFuncTypedParam(callName)) return true;

                // Direct call: foo()
                calls.push({
                    name: callName,
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    enclosingFunction,
                    uncertain
                });
            } else if (funcNode.type === 'selector_expression') {
                // Method or package call: obj.Method() or pkg.Func()
                const fieldNode = funcNode.childForFieldName('field');
                const operandNode = funcNode.childForFieldName('operand');

                if (fieldNode) {
                    const receiver = operandNode?.type === 'identifier' ? operandNode.text : undefined;
                    // Distinguish pkg.Func() (package-qualified) from obj.Method()
                    // If receiver is a known import alias, this is a package call, not a method call
                    const isPkgCall = receiver && importAliases.has(receiver);
                    const receiverType = (!isPkgCall && receiver) ? getReceiverType(receiver) : undefined;
                    calls.push({
                        name: fieldNode.text,
                        line: node.startPosition.row + 1,
                        isMethod: !isPkgCall,
                        receiver,
                        ...(receiverType && { receiverType }),
                        enclosingFunction,
                        uncertain
                    });
                }
            }
            return true;
        }

        // Detect function references passed as arguments: dc.worker passed to UntilWithContext(ctx, dc.worker, ...)
        // selector_expression inside argument_list (not inside call_expression as the function)
        if (node.type === 'selector_expression' && node.parent?.type === 'argument_list') {
            // Only if this selector_expression is NOT the function being called
            const grandparent = node.parent?.parent;
            if (!grandparent || grandparent.type !== 'call_expression' || grandparent.childForFieldName('function') !== node) {
                const fieldNode = node.childForFieldName('field');
                const operandNode = node.childForFieldName('operand');
                if (fieldNode && operandNode) {
                    const receiver = operandNode.type === 'identifier' ? operandNode.text : undefined;
                    const receiverType = receiver ? getReceiverType(receiver) : undefined;
                    const enclosingFunction = getCurrentEnclosingFunction();
                    calls.push({
                        name: fieldNode.text,
                        line: node.startPosition.row + 1,
                        isMethod: true,
                        receiver,
                        ...(receiverType && { receiverType }),
                        enclosingFunction,
                        isPotentialCallback: true,
                        uncertain: false
                    });
                }
            }
        }

        return true;
    }, {
        onLeave: (node) => {
            if (isFunctionNode(node)) {
                const leaving = functionStack.pop();
                if (leaving) {
                    closureScopes.delete(leaving.startLine);
                    scopeTypes.delete(leaving.startLine);
                }
            }
        }
    });

    return calls;
}

/**
 * Find all imports in Go code using tree-sitter AST
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{module: string, names: string[], type: string, line: number}>}
 */
function findImportsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const imports = [];

    function processImportSpec(spec) {
        const line = spec.startPosition.row + 1;
        let modulePath = null;
        let alias = null;
        let importType = 'import';
        let dynamic = false;

        for (let i = 0; i < spec.namedChildCount; i++) {
            const child = spec.namedChild(i);
            if (child.type === 'interpreted_string_literal' || child.type === 'raw_string_literal') {
                // Remove quotes (double quotes or backticks)
                modulePath = child.text.slice(1, -1);
            } else if (child.type === 'package_identifier') {
                alias = child.text;
            } else if (child.type === 'blank_identifier') {
                alias = '_';
                importType = 'side-effect';
                dynamic = true; // treat side-effect imports as dynamic for completeness signals
            } else if (child.type === 'dot') {
                alias = '.';
                importType = 'dot-import';
                dynamic = true;
            }
        }

        if (modulePath) {
            // Package name is last segment of path
            const pkgName = alias || modulePath.split('/').pop();
            imports.push({
                module: modulePath,
                names: [pkgName],
                type: importType,
                dynamic,
                line
            });
        }
    }

    traverseTree(tree.rootNode, (node) => {
        if (node.type === 'import_declaration') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'import_spec') {
                    processImportSpec(child);
                } else if (child.type === 'import_spec_list') {
                    for (let j = 0; j < child.namedChildCount; j++) {
                        const spec = child.namedChild(j);
                        if (spec.type === 'import_spec') {
                            processImportSpec(spec);
                        }
                    }
                }
            }
            return true;
        }

        return true;
    });

    return imports;
}

/**
 * Find all exports in Go code using tree-sitter AST
 * In Go, exports are capitalized public symbols
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{name: string, type: string, line: number}>}
 */
function findExportsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const exports = [];

    traverseTree(tree.rootNode, (node) => {
        // Exported functions
        if (node.type === 'function_declaration') {
            const nameNode = node.childForFieldName('name');
            if (nameNode && /^[A-Z]/.test(nameNode.text)) {
                exports.push({
                    name: nameNode.text,
                    type: 'function',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        // Exported methods
        if (node.type === 'method_declaration') {
            const nameNode = node.childForFieldName('name');
            if (nameNode && /^[A-Z]/.test(nameNode.text)) {
                exports.push({
                    name: nameNode.text,
                    type: 'method',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        // Exported types (struct, interface, type alias)
        if (node.type === 'type_declaration') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const spec = node.namedChild(i);
                if (spec.type === 'type_spec') {
                    const nameNode = spec.childForFieldName('name');
                    if (nameNode && /^[A-Z]/.test(nameNode.text)) {
                        exports.push({
                            name: nameNode.text,
                            type: 'type',
                            line: spec.startPosition.row + 1
                        });
                    }
                }
            }
            return true;
        }

        // Exported const/var
        if (node.type === 'const_declaration' || node.type === 'var_declaration') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const spec = node.namedChild(i);
                if (spec.type === 'const_spec' || spec.type === 'var_spec') {
                    const nameNode = spec.childForFieldName('name');
                    if (nameNode && /^[A-Z]/.test(nameNode.text)) {
                        exports.push({
                            name: nameNode.text,
                            type: node.type === 'const_declaration' ? 'const' : 'var',
                            line: spec.startPosition.row + 1
                        });
                    }
                }
            }
            return true;
        }

        return true;
    });

    return exports;
}

/**
 * Find all usages of a name in code using AST
 * @param {string} code - Source code
 * @param {string} name - Symbol name to find
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{line: number, column: number, usageType: string}>}
 */
function findUsagesInCode(code, name, parser) {
    const tree = parseTree(parser, code);
    const usages = [];

    traverseTree(tree.rootNode, (node) => {
        // Look for identifier, field_identifier (method names in selector expressions),
        // and type_identifier (type references in params, return types, composite literals, etc.)
        const isIdentifier = node.type === 'identifier' || node.type === 'field_identifier' || node.type === 'type_identifier';
        if (!isIdentifier || node.text !== name) {
            return true;
        }

        const line = node.startPosition.row + 1;
        const column = node.startPosition.column;
        const parent = node.parent;

        let usageType = 'reference';

        if (parent) {
            // Import: import_spec
            if (parent.type === 'import_spec' ||
                parent.type === 'package_identifier') {
                usageType = 'import';
            }
            // Call: identifier is function in call_expression
            else if (parent.type === 'call_expression' &&
                     parent.childForFieldName('function') === node) {
                usageType = 'call';
            }
            // Definition: function name
            else if (parent.type === 'function_declaration' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: method name
            else if (parent.type === 'method_declaration' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: type name
            else if (parent.type === 'type_spec' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: variable name in short var declaration
            else if (parent.type === 'short_var_declaration') {
                const left = parent.childForFieldName('left');
                if (left && (left === node || left.namedChildren?.some(c => c === node))) {
                    usageType = 'definition';
                }
            }
            // Multi-var: x, err := foo() — identifier parent is expression_list
            else if (parent.type === 'expression_list' &&
                     parent.parent?.type === 'short_var_declaration' &&
                     parent.parent.childForFieldName('left') === parent) {
                usageType = 'definition';
            }
            // Definition: const/var spec
            else if (parent.type === 'const_spec' || parent.type === 'var_spec') {
                const nameNode = parent.childForFieldName('name');
                if (nameNode === node) {
                    usageType = 'definition';
                }
            }
            // Definition: parameter name (not the type)
            else if (parent.type === 'parameter_declaration' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Composite literal: Type{} — type_identifier is the type of composite_literal
            else if (parent.type === 'composite_literal' &&
                     parent.childForFieldName('type') === node) {
                usageType = 'call';
            }
            // Method call: selector_expression followed by call (field_identifier case)
            else if (parent.type === 'selector_expression') {
                const grandparent = parent.parent;
                if (grandparent && grandparent.type === 'call_expression') {
                    usageType = 'call';
                } else {
                    usageType = 'reference';
                }
                // Track receiver for selector expressions (obj.name → receiver = 'obj')
                const operand = parent.childForFieldName('operand');
                if (operand && operand.type === 'identifier') {
                    usages.push({ line, column, usageType, receiver: operand.text });
                    return true;
                }
            }
        }

        usages.push({ line, column, usageType });
        return true;
    });

    return usages;
}

module.exports = {
    findFunctions,
    findClasses,
    findStateObjects,
    findCallsInCode,
    findImportsInCode,
    findExportsInCode,
    findUsagesInCode,
    parse
};
