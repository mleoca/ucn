/**
 * languages/rust.js - Tree-sitter based Rust parsing
 *
 * Handles: function definitions, struct/enum/trait/impl blocks,
 * modules, macros, and const/static declarations.
 */

const {
    traverseTree,
    nodeToLocation,
    parseStructuredParams,
    extractRustDocstring
} = require('./utils');
const { PARSE_OPTIONS, safeParse } = require('./index');

function parseTree(parser, code) {
    return safeParse(parser, code, undefined, PARSE_OPTIONS);
}

/**
 * Extract return type from Rust function
 */
function extractReturnType(node) {
    const returnTypeNode = node.childForFieldName('return_type');
    if (returnTypeNode) {
        let text = returnTypeNode.text.trim();
        if (text.startsWith('->')) {
            text = text.slice(2).trim();
        }
        return text || null;
    }
    return null;
}

/**
 * Extract Rust parameters
 */
function extractRustParams(paramsNode) {
    if (!paramsNode) return '...';
    const text = paramsNode.text;
    let params = text.replace(/^\(|\)$/g, '').trim();
    if (!params) return '...';
    return params;
}

/**
 * Extract visibility modifier
 */
function extractVisibility(text) {
    const firstLine = text.split('\n')[0];
    if (firstLine.includes('pub(crate)')) return 'pub(crate)';
    if (firstLine.includes('pub(self)')) return 'pub(self)';
    if (firstLine.includes('pub(super)')) return 'pub(super)';
    if (firstLine.includes('pub ')) return 'pub';
    return null;
}

/**
 * Extract attributes from a function node (e.g., #[test], #[tokio::main])
 * @param {Node} node - AST node
 * @param {string} code - Source code
 * @returns {string[]} Array of attribute names
 */
function extractAttributes(node, code) {
    const attributes = [];
    const lines = code.split('\n');

    // Look at lines before the function for attributes
    const startLine = node.startPosition.row;
    for (let i = startLine - 1; i >= 0 && i >= startLine - 5; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        if (line.startsWith('#[')) {
            // Extract attribute name (e.g., #[test] -> test, #[tokio::main] -> tokio::main)
            const match = line.match(/#\[([^\]]+)\]/);
            if (match) {
                const attrContent = match[1];
                // Get just the attribute name (without arguments)
                const attrName = attrContent.split('(')[0].trim();
                attributes.push(attrName);
            }
        } else if (!line.startsWith('//')) {
            // Stop at non-comment, non-attribute lines
            break;
        }
    }

    return attributes;
}

/**
 * Find all functions in Rust code using tree-sitter
 */
function findFunctions(code, parser) {
    const tree = parseTree(parser, code);
    const functions = [];
    const processedRanges = new Set();

    traverseTree(tree.rootNode, (node) => {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;

        if (node.type === 'function_item') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            // Skip functions inside impl blocks (they're extracted as impl members)
            let parent = node.parent;
            if (parent && (parent.type === 'impl_item' || parent.type === 'declaration_list')) {
                // declaration_list is the body of an impl block
                const grandparent = parent.parent;
                if (grandparent && grandparent.type === 'impl_item') {
                    return true;  // Skip - this is an impl method
                }
                if (parent.type === 'impl_item') {
                    return true;  // Skip - this is an impl method
                }
            }

            const nameNode = node.childForFieldName('name');
            const paramsNode = node.childForFieldName('parameters');

            if (nameNode) {
                const { startLine, endLine, indent } = nodeToLocation(node, code);
                const text = node.text;
                const firstLine = text.split('\n')[0];

                const isAsync = firstLine.includes('async ');
                const isUnsafe = firstLine.includes('unsafe ');
                const isConst = firstLine.includes('const fn');
                const visibility = extractVisibility(text);
                const returnType = extractReturnType(node);
                const docstring = extractRustDocstring(code, startLine);
                const generics = extractGenerics(node);
                const attributes = extractAttributes(node, code);

                const modifiers = [];
                if (visibility) modifiers.push(visibility);
                if (isAsync) modifiers.push('async');
                if (isUnsafe) modifiers.push('unsafe');
                if (isConst) modifiers.push('const');
                // Add attributes like #[test] to modifiers
                for (const attr of attributes) {
                    modifiers.push(attr);
                }

                functions.push({
                    name: nameNode.text,
                    params: extractRustParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'rust'),
                    startLine,
                    endLine,
                    indent,
                    modifiers,
                    ...(returnType && { returnType }),
                    ...(docstring && { docstring }),
                    ...(generics && { generics })
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
 * Extract generics from a node
 */
function extractGenerics(node) {
    const typeParamsNode = node.childForFieldName('type_parameters');
    if (typeParamsNode) {
        return typeParamsNode.text;
    }
    return null;
}

/**
 * Find all types (structs, enums, traits, impls) in Rust code
 */
function findClasses(code, parser) {
    const tree = parseTree(parser, code);
    const types = [];
    const processedRanges = new Set();

    traverseTree(tree.rootNode, (node) => {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;

        // Struct items
        if (node.type === 'struct_item') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(node, code);
                const docstring = extractRustDocstring(code, startLine);
                const visibility = extractVisibility(node.text);
                const generics = extractGenerics(node);
                const members = extractStructFields(node, code);

                types.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    type: 'struct',
                    members,
                    modifiers: visibility ? [visibility] : [],
                    ...(docstring && { docstring }),
                    ...(generics && { generics })
                });
            }
            return true;
        }

        // Enum items
        if (node.type === 'enum_item') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(node, code);
                const docstring = extractRustDocstring(code, startLine);
                const visibility = extractVisibility(node.text);
                const generics = extractGenerics(node);

                types.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    type: 'enum',
                    members: [],
                    modifiers: visibility ? [visibility] : [],
                    ...(docstring && { docstring }),
                    ...(generics && { generics })
                });
            }
            return true;
        }

        // Trait items
        if (node.type === 'trait_item') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(node, code);
                const docstring = extractRustDocstring(code, startLine);
                const visibility = extractVisibility(node.text);
                const generics = extractGenerics(node);

                types.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    type: 'trait',
                    members: [],
                    modifiers: visibility ? [visibility] : [],
                    ...(docstring && { docstring }),
                    ...(generics && { generics })
                });
            }
            return true;
        }

        // Impl items
        if (node.type === 'impl_item') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            const { startLine, endLine } = nodeToLocation(node, code);
            const implInfo = extractImplInfo(node);
            const docstring = extractRustDocstring(code, startLine);

            types.push({
                name: implInfo.name,
                startLine,
                endLine,
                type: 'impl',
                traitName: implInfo.traitName,
                typeName: implInfo.typeName,
                members: extractImplMembers(node, code, implInfo.typeName),
                modifiers: [],
                ...(docstring && { docstring })
            });
            return false;  // Don't traverse into impl body
        }

        // Module items
        if (node.type === 'mod_item') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(node, code);
                const docstring = extractRustDocstring(code, startLine);
                const visibility = extractVisibility(node.text);

                types.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    type: 'module',
                    members: [],
                    modifiers: visibility ? [visibility] : [],
                    ...(docstring && { docstring })
                });
            }
            return true;
        }

        // Macro definitions
        if (node.type === 'macro_definition') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(node, code);
                const docstring = extractRustDocstring(code, startLine);

                types.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    type: 'macro',
                    members: [],
                    modifiers: [],
                    ...(docstring && { docstring })
                });
            }
            return true;
        }

        // Type aliases (only top-level, not inside traits/impls)
        if (node.type === 'type_item') {
            if (processedRanges.has(rangeKey)) return true;

            // Skip if inside trait or impl
            let parent = node.parent;
            while (parent) {
                if (parent.type === 'trait_item' || parent.type === 'impl_item') {
                    return true;  // Skip this one
                }
                parent = parent.parent;
            }

            processedRanges.add(rangeKey);

            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(node, code);
                const docstring = extractRustDocstring(code, startLine);
                const visibility = extractVisibility(node.text);

                types.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    type: 'type',
                    members: [],
                    modifiers: visibility ? [visibility] : [],
                    ...(docstring && { docstring })
                });
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
    const bodyNode = structNode.childForFieldName('body');
    if (!bodyNode) return fields;

    for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const field = bodyNode.namedChild(i);
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
 * Extract impl block info
 */
function extractImplInfo(implNode) {
    let traitName = null;
    let typeName = null;
    const typeParamsNode = implNode.childForFieldName('type_parameters');
    const typeParams = typeParamsNode ? typeParamsNode.text.trim() : '';

    const traitNode = implNode.childForFieldName('trait');
    const typeNode = implNode.childForFieldName('type');

    if (traitNode) {
        traitName = traitNode.text;
    }

    if (typeNode) {
        typeName = typeNode.text;
    }

    const prefix = typeParams ? `${typeParams} ` : '';
    let name;
    if (traitName && typeName) {
        name = `${prefix}${traitName} for ${typeName}`;
    } else if (typeName) {
        name = `${prefix}${typeName}`;
    } else {
        const text = implNode.text;
        const match = text.match(/impl\s*(?:<[^>]+>\s*)?(\w+(?:\s+for\s+\w+)?)/);
        name = match ? `${prefix}${match[1]}` : 'impl';
    }

    return { name, traitName, typeName };
}

/**
 * Extract impl block members (functions)
 * @param {Node} implNode - The impl block AST node
 * @param {string} code - Source code
 * @param {string} [typeName] - The type this impl is for (e.g., "MyStruct")
 */
function extractImplMembers(implNode, code, typeName) {
    const members = [];
    const bodyNode = implNode.childForFieldName('body');
    if (!bodyNode) return members;

    for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const child = bodyNode.namedChild(i);

        if (child.type === 'function_item') {
            const nameNode = child.childForFieldName('name');
            const paramsNode = child.childForFieldName('parameters');

            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(child, code);
                const text = child.text;
                const firstLine = text.split('\n')[0];
                const returnType = extractReturnType(child);
                const docstring = extractRustDocstring(code, startLine);
                const visibility = extractVisibility(text);

                // Check if this is a method (has self parameter) or associated function
                const hasSelf = paramsNode && paramsNode.text.includes('self');

                members.push({
                    name: nameNode.text,
                    params: extractRustParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'rust'),
                    startLine,
                    endLine,
                    memberType: visibility ? 'public' : 'method',
                    isAsync: firstLine.includes('async '),
                    isMethod: true,  // Mark as method for context() lookups
                    ...(typeName && { receiver: typeName }),  // Track which type this impl is for
                    ...(returnType && { returnType }),
                    ...(docstring && { docstring })
                });
            }
        }
    }

    return members;
}

/**
 * Find state objects (const/static) in Rust code
 */
function findStateObjects(code, parser) {
    const tree = parseTree(parser, code);
    const objects = [];

    const statePattern = /^([A-Z][A-Z0-9_]+|DEFAULT_[A-Z_]+)$/;

    traverseTree(tree.rootNode, (node) => {
        // Handle const items (only top-level)
        if (node.type === 'const_item') {
            if (!node.parent || node.parent.type !== 'source_file') return true;
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                if (statePattern.test(name)) {
                    const { startLine, endLine } = nodeToLocation(node, code);
                    objects.push({ name, startLine, endLine });
                }
            }
            return true;
        }

        // Handle static items (only top-level)
        if (node.type === 'static_item') {
            if (!node.parent || node.parent.type !== 'source_file') return true;
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                if (statePattern.test(name)) {
                    const { startLine, endLine } = nodeToLocation(node, code);
                    objects.push({ name, startLine, endLine });
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
 * Parse a Rust file completely
 */
function parse(code, parser) {
    return {
        language: 'rust',
        totalLines: code.split('\n').length,
        functions: findFunctions(code, parser),
        classes: findClasses(code, parser),
        stateObjects: findStateObjects(code, parser),
        imports: [],
        exports: []
    };
}

/**
 * Find all function calls in Rust code using tree-sitter AST
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{name: string, line: number, isMethod: boolean, receiver?: string, isMacro?: boolean}>}
 */
function findCallsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const calls = [];
    const functionStack = [];  // Stack of { name, startLine, endLine }

    // Helper to check if a node creates a function scope
    const isFunctionNode = (node) => {
        return ['function_item', 'closure_expression'].includes(node.type);
    };

    // Helper to extract function name from a function node
    const extractFunctionName = (node) => {
        if (node.type === 'function_item') {
            const nameNode = node.childForFieldName('name');
            return nameNode?.text || '<anonymous>';
        }
        if (node.type === 'closure_expression') {
            return '<closure>';
        }
        return '<anonymous>';
    };

    // Helper to get current enclosing function
    const getCurrentEnclosingFunction = () => {
        return functionStack.length > 0
            ? { ...functionStack[functionStack.length - 1] }
            : null;
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

        // Handle function calls: foo(), obj.method(), Type::func()
        if (node.type === 'call_expression') {
            const funcNode = node.childForFieldName('function');
            if (!funcNode) return true;

            const enclosingFunction = getCurrentEnclosingFunction();

            if (funcNode.type === 'identifier') {
                // Direct call: foo()
                calls.push({
                    name: funcNode.text,
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    enclosingFunction
                });
            } else if (funcNode.type === 'field_expression') {
                // Method call: obj.method()
                const fieldNode = funcNode.childForFieldName('field');
                const valueNode = funcNode.childForFieldName('value');

                if (fieldNode) {
                    calls.push({
                        name: fieldNode.text,
                        line: node.startPosition.row + 1,
                        isMethod: true,
                        receiver: (valueNode?.type === 'identifier' || valueNode?.type === 'self') ? valueNode.text : undefined,
                        enclosingFunction
                    });
                }
            } else if (funcNode.type === 'scoped_identifier') {
                // Path call: Type::func() or module::func()
                // Get the last segment of the path
                const pathText = funcNode.text;
                const segments = pathText.split('::');
                const name = segments[segments.length - 1];
                calls.push({
                    name: name,
                    line: node.startPosition.row + 1,
                    isMethod: segments.length > 1,
                    receiver: segments.length > 1 ? segments.slice(0, -1).join('::') : undefined,
                    enclosingFunction
                });
            }
            return true;
        }

        // Handle macro invocations: println!(), vec![]
        if (node.type === 'macro_invocation') {
            const macroNode = node.childForFieldName('macro');
            if (macroNode) {
                let macroName = macroNode.text;
                // Remove the trailing ! if present in the name
                if (macroName.endsWith('!')) {
                    macroName = macroName.slice(0, -1);
                }
                const enclosingFunction = getCurrentEnclosingFunction();
                calls.push({
                    name: macroName,
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    isMacro: true,
                    enclosingFunction
                });
            }
            return true;
        }

        return true;
    }, {
        onLeave: (node) => {
            if (isFunctionNode(node)) {
                functionStack.pop();
            }
        }
    });

    return calls;
}

/**
 * Find all imports in Rust code using tree-sitter AST
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{module: string, names: string[], type: string, line: number}>}
 */
function findImportsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const imports = [];

    traverseTree(tree.rootNode, (node) => {
        // use declarations
        if (node.type === 'use_declaration') {
            const line = node.startPosition.row + 1;

            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);

                if (child.type === 'scoped_identifier' || child.type === 'identifier') {
                    // use std::io or use foo
                    const path = child.text;
                    const segments = path.split('::');
                    imports.push({
                        module: path,
                        names: [segments[segments.length - 1]],
                        type: 'use',
                        dynamic: false,
                        line
                    });
                } else if (child.type === 'use_wildcard') {
                    // use std::collections::*
                    const scopedId = child.namedChild(0);
                    if (scopedId) {
                        imports.push({
                            module: scopedId.text,
                            names: ['*'],
                            type: 'use-glob',
                            dynamic: true,
                            line
                        });
                    }
                } else if (child.type === 'use_list' || child.type === 'scoped_use_list') {
                    // use std::{io, fs} or use foo::{bar, baz}
                    // Extract the base path and names
                    const pathNode = child.childForFieldName('path');
                    const listNode = child.childForFieldName('list');

                    if (pathNode && listNode) {
                        const basePath = pathNode.text;
                        const names = [];
                        for (let j = 0; j < listNode.namedChildCount; j++) {
                            const item = listNode.namedChild(j);
                            if (item.type === 'identifier') {
                                names.push(item.text);
                            } else if (item.type === 'use_as_clause') {
                                const nameNode = item.namedChild(0);
                                if (nameNode) names.push(nameNode.text);
                            }
                        }
                        imports.push({
                            module: basePath,
                            names,
                            type: 'use',
                            dynamic: false,
                            line
                        });
                    }
                }
            }
            return true;
        }

        // mod declarations (external module imports)
        if (node.type === 'mod_item') {
            const line = node.startPosition.row + 1;
            const nameNode = node.childForFieldName('name');

            // Only count mod declarations without body (file-based modules)
            const hasBody = node.namedChildren.some(c => c.type === 'declaration_list');

            if (nameNode && !hasBody) {
                imports.push({
                    module: nameNode.text,
                    names: [nameNode.text],
                    type: 'mod',
                    dynamic: false,
                    line
                });
            }
            return true;
        }

        return true;
    });

    // include! macros with non-literal paths
    traverseTree(tree.rootNode, (node) => {
        if (node.type === 'macro_invocation') {
            const nameNode = node.childForFieldName('macro');
            if (nameNode && /^include(_str|_bytes)?!$/.test(nameNode.text)) {
                const argsNode = node.childForFieldName('argument_list');
                const arg = argsNode?.namedChild(0);
                const dynamic = !arg || arg.type !== 'string_literal';
                imports.push({
                    module: arg ? arg.text.replace(/^["']|["']$/g, '') : null,
                    names: [],
                    type: 'include',
                    dynamic,
                    line: node.startPosition.row + 1
                });
            }
        }
        return true;
    });

    return imports;
}

/**
 * Find all exports in Rust code using tree-sitter AST
 * In Rust, exports are pub items
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{name: string, type: string, line: number}>}
 */
function findExportsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const exports = [];

    function hasVisibility(node) {
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child.type === 'visibility_modifier') {
                return true;
            }
        }
        return false;
    }

    traverseTree(tree.rootNode, (node) => {
        // Public functions
        if (node.type === 'function_item' && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                exports.push({
                    name: nameNode.text,
                    type: 'function',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        // Public structs
        if (node.type === 'struct_item' && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                exports.push({
                    name: nameNode.text,
                    type: 'struct',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        // Public enums
        if (node.type === 'enum_item' && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                exports.push({
                    name: nameNode.text,
                    type: 'enum',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        // Public traits
        if (node.type === 'trait_item' && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                exports.push({
                    name: nameNode.text,
                    type: 'trait',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        // Public modules
        if (node.type === 'mod_item' && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                exports.push({
                    name: nameNode.text,
                    type: 'module',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        // Public type aliases
        if (node.type === 'type_item' && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                exports.push({
                    name: nameNode.text,
                    type: 'type',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        // Public const
        if (node.type === 'const_item' && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                exports.push({
                    name: nameNode.text,
                    type: 'const',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        // Public static
        if (node.type === 'static_item' && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                exports.push({
                    name: nameNode.text,
                    type: 'static',
                    line: node.startPosition.row + 1
                });
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
        // Look for both identifier and field_identifier (method names in obj.method() calls)
        const isIdentifier = node.type === 'identifier' || node.type === 'field_identifier';
        if (!isIdentifier || node.text !== name) {
            return true;
        }

        const line = node.startPosition.row + 1;
        const column = node.startPosition.column;
        const parent = node.parent;

        let usageType = 'reference';

        if (parent) {
            // Import: use path::name
            if (parent.type === 'use_declaration' ||
                parent.type === 'use_as_clause' ||
                parent.type === 'scoped_identifier' && parent.parent?.type === 'use_declaration') {
                usageType = 'import';
            }
            // Call: name()
            else if (parent.type === 'call_expression' &&
                     parent.childForFieldName('function') === node) {
                usageType = 'call';
            }
            // Macro invocation: name!
            else if (parent.type === 'macro_invocation') {
                const macroNode = parent.childForFieldName('macro');
                if (macroNode === node) {
                    usageType = 'call';
                }
            }
            // Definition: fn name
            else if (parent.type === 'function_item' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: struct name
            else if (parent.type === 'struct_item' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: enum name
            else if (parent.type === 'enum_item' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: impl for Type
            else if (parent.type === 'impl_item') {
                usageType = 'definition';
            }
            // Definition: type alias
            else if (parent.type === 'type_item' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: let binding
            else if (parent.type === 'let_declaration' &&
                     parent.childForFieldName('pattern')?.text === name) {
                usageType = 'definition';
            }
            // Definition: const/static
            else if ((parent.type === 'const_item' || parent.type === 'static_item') &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: parameter
            else if (parent.type === 'parameter') {
                usageType = 'definition';
            }
            // Method call: obj.name()
            else if (parent.type === 'field_expression' &&
                     parent.childForFieldName('field') === node) {
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
