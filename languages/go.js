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
    const match = text.match(/\(\s*\w*\s*(\*?\w+)\s*\)/);
    return match ? match[1] : text.replace(/^\(|\)$/g, '').trim();
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

                        types.push({
                            name,
                            startLine,
                            endLine,
                            type: typeKind,
                            members: typeKind === 'struct' ? extractStructFields(typeNode, code) : [],
                            modifiers: isExported ? ['export'] : [],
                            ...(docstring && { docstring }),
                            ...(typeParams && { generics: typeParams })
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
    const fieldListNode = structNode.childForFieldName('body') || structNode;

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
            }
        }
    }

    return fields;
}

/**
 * Find state objects (constants) in Go code
 */
function findStateObjects(code, parser) {
    const tree = parseTree(parser, code);
    const objects = [];

    const statePattern = /^(CONFIG|SETTINGS|[A-Z][A-Z0-9_]+|Default[A-Z][a-zA-Z]*|[A-Z][a-zA-Z]*(?:Config|Settings|Options))$/;

    // Check if a value node is a composite literal
    function isCompositeLiteral(valueNode) {
        if (!valueNode) return false;
        if (valueNode.type === 'composite_literal') return true;
        for (let i = 0; i < valueNode.namedChildCount; i++) {
            if (valueNode.namedChild(i).type === 'composite_literal') return true;
        }
        return false;
    }

    traverseTree(tree.rootNode, (node) => {
        // Handle const declarations
        if (node.type === 'const_declaration') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const spec = node.namedChild(i);
                if (spec.type === 'const_spec') {
                    const nameNode = spec.childForFieldName('name');
                    const valueNode = spec.childForFieldName('value');

                    if (nameNode && valueNode && isCompositeLiteral(valueNode)) {
                        const name = nameNode.text;
                        if (statePattern.test(name)) {
                            const { startLine, endLine } = nodeToLocation(spec, code);
                            objects.push({ name, startLine, endLine });
                        }
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

                    if (nameNode && valueNode && isCompositeLiteral(valueNode)) {
                        const name = nameNode.text;
                        if (statePattern.test(name)) {
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

function findCallsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const calls = [];
    const functionStack = [];  // Stack of { name, startLine, endLine }
    // Track local closure names per function scope (scopeStartLine -> Set<name>)
    const closureScopes = new Map();

    // Helper to check if a node creates a function scope
    const isFunctionNode = (node) => {
        return ['function_declaration', 'method_declaration', 'func_literal'].includes(node.type);
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

    traverseTree(tree.rootNode, (node) => {
        // Track function entry
        if (isFunctionNode(node)) {
            functionStack.push({
                name: extractFunctionName(node),
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1
            });
        }

        // Track local closures: atoi := func(...) { ... }
        if (node.type === 'short_var_declaration' || node.type === 'var_declaration') {
            // Check if RHS contains a func_literal
            const hasFunc = (n) => {
                if (n.type === 'func_literal') return true;
                for (let i = 0; i < n.childCount; i++) {
                    if (hasFunc(n.child(i))) return true;
                }
                return false;
            };
            if (hasFunc(node)) {
                // Extract the variable name from the LHS
                const left = node.childForFieldName('left');
                if (left) {
                    const names = left.type === 'expression_list'
                        ? Array.from({ length: left.namedChildCount }, (_, i) => left.namedChild(i))
                              .filter(n => n.type === 'identifier').map(n => n.text)
                        : left.type === 'identifier' ? [left.text] : [];
                    if (names.length > 0 && functionStack.length > 0) {
                        const scopeKey = functionStack[functionStack.length - 1].startLine;
                        if (!closureScopes.has(scopeKey)) closureScopes.set(scopeKey, new Set());
                        for (const n of names) closureScopes.get(scopeKey).add(n);
                    }
                }
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
                    calls.push({
                        name: fieldNode.text,
                        line: node.startPosition.row + 1,
                        isMethod: true,
                        receiver: operandNode?.type === 'identifier' ? operandNode.text : undefined,
                        enclosingFunction,
                        uncertain
                    });
                }
            }
            return true;
        }

        return true;
    }, {
        onLeave: (node) => {
            if (isFunctionNode(node)) {
                const leaving = functionStack.pop();
                closureScopes.delete(leaving.startLine);
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
            if (child.type === 'interpreted_string_literal') {
                // Remove quotes
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
                            line: node.startPosition.row + 1
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
                            line: node.startPosition.row + 1
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
                if (left && (left === node || left.text.includes(name))) {
                    usageType = 'definition';
                }
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
