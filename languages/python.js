/**
 * languages/python.js - Tree-sitter based Python parsing
 *
 * Handles: function definitions (regular, async, decorated),
 * class definitions, and state objects (constants).
 */

const {
    traverseTree,
    nodeToLocation,
    parseStructuredParams,
    extractPythonDocstring
} = require('./utils');
const { PARSE_OPTIONS, safeParse } = require('./index');

function parseTree(parser, code) {
    return safeParse(parser, code, undefined, PARSE_OPTIONS);
}

/**
 * Extract return type annotation from Python function
 * @param {object} node - Function definition node
 * @returns {string|null} Return type or null
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
 * Find the actual def line (not decorator) for docstring extraction
 */
function getDefLine(node) {
    return node.startPosition.row + 1;
}

/**
 * Get indentation of a node
 */
function getIndent(node, code) {
    const lines = code.split('\n');
    const firstLine = lines[node.startPosition.row] || '';
    const indentMatch = firstLine.match(/^(\s*)/);
    return indentMatch ? indentMatch[1].length : 0;
}

/**
 * Extract Python parameters
 */
function extractPythonParams(paramsNode) {
    if (!paramsNode) return '...';
    const text = paramsNode.text;
    let params = text.replace(/^\(|\)$/g, '').trim();
    if (!params) return '...';
    return params;
}

/**
 * Find all functions in Python code using tree-sitter
 */
function findFunctions(code, parser) {
    const tree = parseTree(parser, code);
    const functions = [];
    const processedRanges = new Set();

    traverseTree(tree.rootNode, (node) => {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;

        if (node.type === 'function_definition') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            // Skip functions that are inside a class (they're extracted as class members)
            let parent = node.parent;
            // Handle decorated_definition wrapper
            if (parent && parent.type === 'decorated_definition') {
                parent = parent.parent;
            }
            // Check if parent is a class body (block inside class_definition)
            if (parent && parent.type === 'block') {
                const grandparent = parent.parent;
                if (grandparent && grandparent.type === 'class_definition') {
                    return true;  // Skip - this is a class method
                }
            }

            const nameNode = node.childForFieldName('name');
            const paramsNode = node.childForFieldName('parameters');

            if (nameNode) {
                // Check for decorators
                let startLine = node.startPosition.row + 1;
                let decoratorStartLine = startLine;

                if (node.parent && node.parent.type === 'decorated_definition') {
                    decoratorStartLine = node.parent.startPosition.row + 1;
                }

                const endLine = node.endPosition.row + 1;
                const indent = getIndent(node, code);
                const returnType = extractReturnType(node);
                const defLine = getDefLine(node);
                const docstring = extractPythonDocstring(code, defLine);

                // Check for async
                const isAsync = node.text.trimStart().startsWith('async ');

                // Extract decorators
                const decorators = extractDecorators(node);

                // nameLine: the line where the name identifier lives (for deadcode def-site filtering)
                // Only set when different from startLine (i.e., when decorators push startLine earlier)
                const nameLine = nameNode.startPosition.row + 1;

                functions.push({
                    name: nameNode.text,
                    params: extractPythonParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'python'),
                    startLine: decoratorStartLine,
                    endLine,
                    indent,
                    isAsync,
                    modifiers: isAsync ? ['async'] : [],
                    ...(returnType && { returnType }),
                    ...(docstring && { docstring }),
                    ...(decorators.length > 0 && { decorators }),
                    ...(nameLine !== decoratorStartLine && { nameLine })
                });
            }
            return true;
        }

        if (node.type === 'decorated_definition') {
            return true;  // Continue traversing into decorated definitions
        }

        return true;
    });

    functions.sort((a, b) => a.startLine - b.startLine);
    return functions;
}

/**
 * Extract decorators from a function/class node
 */
function extractDecorators(node) {
    const decorators = [];
    if (node.parent && node.parent.type === 'decorated_definition') {
        for (let i = 0; i < node.parent.namedChildCount; i++) {
            const child = node.parent.namedChild(i);
            if (child.type === 'decorator') {
                decorators.push(child.text.replace('@', ''));
            }
        }
    }
    return decorators;
}

/**
 * Find all classes in Python code using tree-sitter
 */
function findClasses(code, parser) {
    const tree = parseTree(parser, code);
    const classes = [];
    const processedRanges = new Set();

    traverseTree(tree.rootNode, (node) => {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;

        if (node.type === 'class_definition') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            const nameNode = node.childForFieldName('name');

            if (nameNode) {
                // Check for decorators
                let startLine = node.startPosition.row + 1;
                if (node.parent && node.parent.type === 'decorated_definition') {
                    startLine = node.parent.startPosition.row + 1;
                }

                const endLine = node.endPosition.row + 1;
                const members = extractClassMembers(node, code);
                const defLine = getDefLine(node);
                const docstring = extractPythonDocstring(code, defLine);
                const decorators = extractDecorators(node);
                const bases = extractBases(node);
                const nameLine = nameNode.startPosition.row + 1;

                classes.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    type: 'class',
                    members,
                    ...(docstring && { docstring }),
                    ...(decorators.length > 0 && { decorators }),
                    ...(bases.length > 0 && { extends: bases.join(', ') }),
                    ...(nameLine !== startLine && { nameLine })
                });
            }
            return false;  // Don't traverse into class body
        }

        return true;
    });

    classes.sort((a, b) => a.startLine - b.startLine);
    return classes;
}

/**
 * Extract base classes from class definition
 */
function extractBases(classNode) {
    const bases = [];
    const argsNode = classNode.childForFieldName('superclasses');
    if (argsNode) {
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type === 'identifier' || arg.type === 'attribute') {
                bases.push(arg.text);
            }
        }
    }
    return bases;
}

/**
 * Extract class members (methods)
 */
function extractClassMembers(classNode, code) {
    const members = [];
    const bodyNode = classNode.childForFieldName('body');
    if (!bodyNode) return members;

    for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const child = bodyNode.namedChild(i);

        let funcNode = child;
        let decoratorStart = null;
        const memberDecorators = [];

        if (child.type === 'decorated_definition') {
            decoratorStart = child.startPosition.row + 1;
            // Collect decorators
            for (let j = 0; j < child.namedChildCount; j++) {
                const inner = child.namedChild(j);
                if (inner.type === 'decorator') {
                    memberDecorators.push(inner.text.replace('@', ''));
                }
                if (inner.type === 'function_definition') {
                    funcNode = inner;
                }
            }
        }

        if (funcNode.type === 'function_definition') {
            const nameNode = funcNode.childForFieldName('name');
            const paramsNode = funcNode.childForFieldName('parameters');

            if (nameNode) {
                const name = nameNode.text;
                const startLine = decoratorStart || funcNode.startPosition.row + 1;
                const endLine = funcNode.endPosition.row + 1;

                // Determine member type
                let memberType = 'method';
                if (name === '__init__') {
                    memberType = 'constructor';
                } else if (name.startsWith('__') && name.endsWith('__')) {
                    memberType = 'special';
                } else if (name.startsWith('_')) {
                    memberType = 'private';
                }

                // Check decorators
                for (const dec of memberDecorators) {
                    if (dec.includes('staticmethod')) {
                        memberType = 'static';
                    } else if (dec.includes('classmethod')) {
                        memberType = 'classmethod';
                    } else if (dec.includes('property')) {
                        memberType = 'property';
                    }
                }

                const isAsync = funcNode.text.trimStart().startsWith('async ');
                const returnType = extractReturnType(funcNode);
                const defLine = getDefLine(funcNode);
                const docstring = extractPythonDocstring(code, defLine);
                // nameLine: where the name identifier lives (differs from startLine when decorated)
                const nameLine = nameNode.startPosition.row + 1;

                members.push({
                    name,
                    params: extractPythonParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'python'),
                    startLine,
                    endLine,
                    memberType,
                    isAsync,
                    isMethod: true,  // Mark as method for context() lookups
                    ...(returnType && { returnType }),
                    ...(docstring && { docstring }),
                    ...(memberDecorators.length > 0 && { decorators: memberDecorators }),
                    ...(nameLine !== startLine && { nameLine })
                });
            }
        }
    }

    return members;
}

/**
 * Find state objects (constants) in Python code
 */
function findStateObjects(code, parser) {
    const tree = parseTree(parser, code);
    const objects = [];

    const statePattern = /^(CONFIG|SETTINGS|[A-Z][A-Z0-9_]+|[A-Z][a-zA-Z]*(?:Config|Settings|Options|State|Store|Context))$/;

    traverseTree(tree.rootNode, (node) => {
        if (node.type === 'expression_statement' && node.parent === tree.rootNode) {
            const child = node.namedChild(0);
            if (child && child.type === 'assignment') {
                const leftNode = child.childForFieldName('left');
                const rightNode = child.childForFieldName('right');

                if (leftNode && leftNode.type === 'identifier' && rightNode) {
                    const name = leftNode.text;
                    const isObject = rightNode.type === 'dictionary';
                    const isArray = rightNode.type === 'list';

                    if ((isObject || isArray) && statePattern.test(name)) {
                        const { startLine, endLine } = nodeToLocation(node, code);
                        objects.push({ name, startLine, endLine });
                    }
                }
            }
        }
        return true;
    });

    objects.sort((a, b) => a.startLine - b.startLine);
    return objects;
}

/**
 * Parse a Python file completely
 */
function parse(code, parser) {
    return {
        language: 'python',
        totalLines: code.split('\n').length,
        functions: findFunctions(code, parser),
        classes: findClasses(code, parser),
        stateObjects: findStateObjects(code, parser),
        imports: [],
        exports: []
    };
}

/**
 * Find all function calls in Python code using tree-sitter AST
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{name: string, line: number, isMethod: boolean, receiver?: string}>}
 */
function findCallsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const calls = [];
    const functionStack = [];  // Stack of { name, startLine, endLine }
    const aliases = new Map();  // Track local aliases: aliasName -> originalName
    const nonCallableNames = new Set();  // Track names assigned non-callable values

    // Helper to check if a node is a non-callable literal
    const isNonCallableInit = (node) => {
        // Primitive literals
        if (['integer', 'float', 'string', 'concatenated_string',
             'true', 'false', 'none'].includes(node.type)) {
            return true;
        }
        // Collection literals: non-callable if no lambda values
        if (['list', 'tuple', 'set'].includes(node.type)) {
            for (let i = 0; i < node.namedChildCount; i++) {
                if (node.namedChild(i).type === 'lambda') return false;
            }
            return true;
        }
        if (node.type === 'dictionary') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const pair = node.namedChild(i);
                if (pair.type === 'pair') {
                    const val = pair.childForFieldName('value');
                    if (val?.type === 'lambda') return false;
                }
            }
            return true;
        }
        return false;
    };

    // Helper to check if a node creates a function scope
    const isFunctionNode = (node) => {
        return ['function_definition', 'async_function_definition', 'lambda'].includes(node.type);
    };

    // Helper to extract function name from a function node
    const extractFunctionName = (node) => {
        if (node.type === 'function_definition' || node.type === 'async_function_definition') {
            const nameNode = node.childForFieldName('name');
            return nameNode?.text || '<anonymous>';
        }
        if (node.type === 'lambda') {
            return '<lambda>';
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
            // Use decorated_definition start line if present, to match symbol index
            let startLine = node.startPosition.row + 1;
            if (node.parent && node.parent.type === 'decorated_definition') {
                startLine = node.parent.startPosition.row + 1;
            }
            functionStack.push({
                name: extractFunctionName(node),
                startLine,
                endLine: node.endPosition.row + 1
            });
        }

        // Track local aliases and non-callable assignments
        if (node.type === 'assignment') {
            const left = node.childForFieldName('left');
            const right = node.childForFieldName('right');
            if (left?.type === 'identifier') {
                if (right?.type === 'identifier') {
                    aliases.set(left.text, right.text);
                }
                // Track partial(fn, ...) aliases: fast_process = partial(process, mode='fast')
                else if (right?.type === 'call') {
                    const callFunc = right.childForFieldName('function');
                    let isPartial = false;
                    if (callFunc?.type === 'identifier' && callFunc.text === 'partial') {
                        isPartial = true;
                    } else if (callFunc?.type === 'attribute') {
                        const attr = callFunc.childForFieldName('attribute');
                        const obj = callFunc.childForFieldName('object');
                        if (attr?.text === 'partial' && obj?.type === 'identifier' && obj.text === 'functools') {
                            isPartial = true;
                        }
                    }
                    if (isPartial) {
                        const args = right.childForFieldName('arguments');
                        if (args) {
                            for (let i = 0; i < args.namedChildCount; i++) {
                                const arg = args.namedChild(i);
                                if (arg.type === 'identifier') {
                                    aliases.set(left.text, arg.text);
                                    break;
                                }
                                if (arg.type === 'keyword_argument') continue;
                                break;
                            }
                        }
                    }
                }
                // Track non-callable assignments: count = 5, name = "hello"
                if (right && isNonCallableInit(right)) {
                    nonCallableNames.add(left.text);
                }
            }
        }

        // Handle function calls: foo(), obj.foo()
        if (node.type === 'call') {
            const funcNode = node.childForFieldName('function');
            if (!funcNode) return true;

            const enclosingFunction = getCurrentEnclosingFunction();
            let uncertain = false;

            if (funcNode.type === 'identifier') {
                // Direct call: foo()
                const resolvedName = aliases.get(funcNode.text);
                calls.push({
                    name: funcNode.text,
                    ...(resolvedName && { resolvedName }),
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    enclosingFunction,
                    uncertain
                });
            } else if (funcNode.type === 'attribute') {
                // Method/attribute call: obj.foo() or self.attr.foo()
                const attrNode = funcNode.childForFieldName('attribute');
                const objNode = funcNode.childForFieldName('object');

                if (attrNode) {
                    let receiver = objNode?.type === 'identifier' ? objNode.text : undefined;
                    let selfAttribute = undefined;

                    // Detect super().method() pattern
                    if (objNode?.type === 'call') {
                        const superFunc = objNode.childForFieldName('function');
                        if (superFunc?.type === 'identifier' && superFunc.text === 'super') {
                            receiver = 'super';
                        }
                    }

                    // Detect self.X.method() pattern: objNode is attribute access on self/cls
                    if (objNode?.type === 'attribute') {
                        const innerObj = objNode.childForFieldName('object');
                        const innerAttr = objNode.childForFieldName('attribute');
                        if (innerObj?.type === 'identifier' &&
                            ['self', 'cls'].includes(innerObj.text) &&
                            innerAttr) {
                            selfAttribute = innerAttr.text;
                            receiver = innerObj.text;
                        }
                    }

                    calls.push({
                        name: attrNode.text,
                        line: node.startPosition.row + 1,
                        isMethod: true,
                        receiver,
                        ...(selfAttribute && { selfAttribute }),
                        enclosingFunction,
                        uncertain
                    });
                }
            }

            // General function-argument detection
            // Detects: map(process, items), registry.register('x', handler), etc.
            const PYTHON_SKIP = new Set([
                'None', 'True', 'False', 'self', 'cls', 'super',
                'print', 'len', 'range', 'str', 'int', 'float', 'bool',
                'list', 'dict', 'set', 'tuple', 'type', 'object',
                'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr',
                'property', 'staticmethod', 'classmethod',
            ]);
            const argsNode = node.childForFieldName('arguments');
            if (argsNode) {
                for (let i = 0; i < argsNode.namedChildCount; i++) {
                    const arg = argsNode.namedChild(i);
                    if (arg.type === 'identifier' && !PYTHON_SKIP.has(arg.text) && !nonCallableNames.has(arg.text)) {
                        calls.push({
                            name: arg.text,
                            line: arg.startPosition.row + 1,
                            isMethod: false,
                            isFunctionReference: true,
                            isPotentialCallback: true,
                            enclosingFunction
                        });
                    }
                    // Scan dict literal args for function refs in values
                    // e.g., do_request({'on_success': handle_success})
                    if (arg.type === 'dictionary') {
                        for (let j = 0; j < arg.namedChildCount; j++) {
                            const pair = arg.namedChild(j);
                            if (pair.type === 'pair') {
                                const val = pair.childForFieldName('value');
                                if (val?.type === 'identifier' && !PYTHON_SKIP.has(val.text) && !nonCallableNames.has(val.text)) {
                                    calls.push({
                                        name: val.text,
                                        line: val.startPosition.row + 1,
                                        isMethod: false,
                                        isFunctionReference: true,
                                        isPotentialCallback: true,
                                        enclosingFunction
                                    });
                                }
                            }
                        }
                    }
                }
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
 * Find all imports in Python code using tree-sitter AST
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{module: string, names: string[], type: string, line: number}>}
 */
function findImportsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const imports = [];
    let importAliases = null;  // {original, local}[] — tracks renamed imports

    traverseTree(tree.rootNode, (node) => {
        // import statement: import os, import sys as system
        if (node.type === 'import_statement') {
            const line = node.startPosition.row + 1;

            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'dotted_name') {
                    // import os
                    imports.push({
                        module: child.text,
                        names: [child.text.split('.').pop()],
                        type: 'import',
                        line
                    });
                } else if (child.type === 'aliased_import') {
                    // import sys as system
                    const nameNode = child.namedChild(0);
                    const aliasNode = child.namedChild(1);
                    if (nameNode) {
                        imports.push({
                            module: nameNode.text,
                            names: [aliasNode ? aliasNode.text : nameNode.text.split('.').pop()],
                            type: 'import',
                            line
                        });
                        if (aliasNode && aliasNode.text !== nameNode.text) {
                            if (!importAliases) importAliases = [];
                            importAliases.push({ original: nameNode.text, local: aliasNode.text });
                        }
                    }
                }
            }
            return true;
        }

        // from ... import statement
        if (node.type === 'import_from_statement') {
            const line = node.startPosition.row + 1;
            let modulePath = '';
            const names = [];

            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);

                // Module path (first dotted_name or relative_import)
                if (i === 0 && (child.type === 'dotted_name' || child.type === 'relative_import')) {
                    modulePath = child.text;
                }
                // Imported names
                else if (child.type === 'dotted_name') {
                    names.push(child.text);
                } else if (child.type === 'aliased_import') {
                    const nameNode = child.namedChild(0);
                    const aliasNode = child.namedChild(1);
                    if (nameNode) names.push(nameNode.text);
                    if (nameNode && aliasNode && aliasNode.text !== nameNode.text) {
                        if (!importAliases) importAliases = [];
                        importAliases.push({ original: nameNode.text, local: aliasNode.text });
                    }
                } else if (child.type === 'wildcard_import') {
                    names.push('*');
                }
            }

            if (modulePath) {
                const isRelative = modulePath.startsWith('.');
                imports.push({
                    module: modulePath,
                    names,
                    type: isRelative ? 'relative' : 'from',
                    line
                });
            }
            return true;
        }

        // Dynamic imports via importlib/import_module or __import__
        if (node.type === 'call') {
            const funcNode = node.childForFieldName('function');
            const argsNode = node.childForFieldName('arguments');
            if (funcNode && argsNode && argsNode.namedChildCount > 0) {
                const funcName = funcNode.text;
                const firstArg = argsNode.namedChild(0);
                if ((funcName === 'importlib.import_module' || funcName === '__import__') && firstArg) {
                    const line = node.startPosition.row + 1;
                    const isLiteral = firstArg.type === 'string';
                    imports.push({
                        module: isLiteral ? firstArg.text.replace(/^['"]|['"]$/g, '') : firstArg.text,
                        names: [],
                        type: 'dynamic',
                        line,
                        dynamic: !isLiteral
                    });
                }
            }
            return true;
        }

        return true;
    });

    if (importAliases) imports.aliases = importAliases;
    return imports;
}

/**
 * Find all exports in Python code using tree-sitter AST
 * Looks for __all__ assignments
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{name: string, type: string, line: number}>}
 */
function findExportsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const exports = [];

    traverseTree(tree.rootNode, (node) => {
        // Look for __all__ = [...]
        if (node.type === 'expression_statement') {
            const child = node.namedChild(0);
            if (child && child.type === 'assignment') {
                const leftNode = child.childForFieldName('left');
                const rightNode = child.childForFieldName('right');

                if (leftNode && leftNode.type === 'identifier' && leftNode.text === '__all__') {
                    const line = node.startPosition.row + 1;

                    if (rightNode && rightNode.type === 'list') {
                        for (let i = 0; i < rightNode.namedChildCount; i++) {
                            const item = rightNode.namedChild(i);
                            if (item.type === 'string') {
                                // Extract string content
                                const contentNode = item.childForFieldName('content') ||
                                                   item.namedChild(0);
                                if (contentNode && contentNode.type === 'string_content') {
                                    exports.push({ name: contentNode.text, type: '__all__', line });
                                } else {
                                    // Fallback: remove quotes
                                    const text = item.text;
                                    const name = text.slice(1, -1);
                                    exports.push({ name, type: '__all__', line });
                                }
                            }
                        }
                    }
                }
            }
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
        // Only look for identifiers with the matching name
        if (node.type !== 'identifier' || node.text !== name) {
            return true;
        }

        const line = node.startPosition.row + 1;
        const column = node.startPosition.column;
        const parent = node.parent;

        let usageType = 'reference';

        if (parent) {
            // Import: from x import name, import name
            if (parent.type === 'aliased_import' ||
                parent.type === 'dotted_name' && parent.parent?.type === 'import_statement') {
                usageType = 'import';
            }
            // Import: from x import name (in import_from_statement)
            else if (parent.type === 'dotted_name' && parent.parent?.type === 'import_from_statement') {
                usageType = 'import';
            }
            // Import: direct identifier in import
            else if (parent.type === 'import_from_statement') {
                usageType = 'import';
            }
            // Call: name()
            else if (parent.type === 'call' &&
                     parent.childForFieldName('function') === node) {
                usageType = 'call';
            }
            // Definition: def name(...):
            else if (parent.type === 'function_definition' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: class name:
            else if (parent.type === 'class_definition' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: parameter
            else if (parent.type === 'parameter' ||
                     parent.type === 'default_parameter' ||
                     parent.type === 'typed_parameter' ||
                     parent.type === 'typed_default_parameter') {
                usageType = 'definition';
            }
            // Definition: assignment target (x = ...)
            else if (parent.type === 'assignment' &&
                     parent.childForFieldName('left') === node) {
                usageType = 'definition';
            }
            // Definition: for loop variable
            else if (parent.type === 'for_statement' &&
                     parent.childForFieldName('left') === node) {
                usageType = 'definition';
            }
            // Method call: obj.name()
            else if (parent.type === 'attribute' &&
                     parent.childForFieldName('attribute') === node) {
                const grandparent = parent.parent;
                if (grandparent && grandparent.type === 'call') {
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

/**
 * Find instance attribute types from __init__ constructor assignments.
 * Parses self.X = ClassName(...) patterns in __init__ methods.
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Map<string, Map<string, string>>} className -> (attrName -> typeName)
 */
function findInstanceAttributeTypes(code, parser) {
    const tree = parseTree(parser, code);
    const result = new Map(); // className -> Map(attrName -> typeName)

    const PRIMITIVE_TYPES = new Set(['int', 'float', 'str', 'bool', 'bytes', 'list', 'dict', 'set', 'tuple', 'None', 'Any', 'object']);

    traverseTree(tree.rootNode, (node) => {
        if (node.type !== 'class_definition') return true;

        const classNameNode = node.childForFieldName('name');
        if (!classNameNode) return true;
        const className = classNameNode.text;

        const body = node.childForFieldName('body');
        if (!body) return false;

        const attrTypes = new Map();

        // Check for @dataclass decorator — scan annotated class-level fields
        const parentNode = node.parent;
        if (parentNode?.type === 'decorated_definition') {
            for (let d = 0; d < parentNode.childCount; d++) {
                const dec = parentNode.child(d);
                if (dec.type !== 'decorator') continue;
                // Match @dataclass or @dataclasses.dataclass
                const decText = dec.text;
                if (decText.startsWith('@dataclass') || decText.includes('.dataclass')) {
                    // Scan class body for annotated fields: name: Type = ...
                    for (let i = 0; i < body.childCount; i++) {
                        const stmt = body.child(i);
                        if (stmt.type !== 'expression_statement') continue;
                        const assign = stmt.firstChild;
                        if (!assign || assign.type !== 'assignment') continue;

                        // Must have a type annotation
                        const typeNode = assign.childForFieldName('type');
                        if (!typeNode) continue;

                        // Extract type name from annotation
                        const typeIdent = typeNode.type === 'type' ? typeNode.firstChild : typeNode;
                        if (!typeIdent || typeIdent.type !== 'identifier') continue;
                        const typeName = typeIdent.text;

                        // Skip primitives and lowercase types
                        if (PRIMITIVE_TYPES.has(typeName)) continue;
                        if (typeName[0] < 'A' || typeName[0] > 'Z') continue;

                        // Field name from LHS
                        const lhs = assign.childForFieldName('left');
                        if (!lhs || lhs.type !== 'identifier') continue;
                        attrTypes.set(lhs.text, typeName);
                    }
                    break;
                }
            }
        }

        // Scan __init__ for self.X = ClassName(...) assignments
        for (let i = 0; i < body.childCount; i++) {
            let child = body.child(i);
            // Handle decorated_definition wrapper
            if (child.type === 'decorated_definition') {
                for (let j = 0; j < child.childCount; j++) {
                    if (child.child(j).type === 'function_definition') {
                        child = child.child(j);
                        break;
                    }
                }
            }
            if (child.type !== 'function_definition') continue;

            const fnName = child.childForFieldName('name');
            if (!fnName || fnName.text !== '__init__') continue;

            // Found __init__, now scan for self.X = ClassName(...) assignments
            const initBody = child.childForFieldName('body');
            if (!initBody) continue;

            traverseTree(initBody, (stmt) => {
                if (stmt.type !== 'expression_statement') return true;

                const assign = stmt.firstChild;
                if (!assign || assign.type !== 'assignment') return true;

                // LHS: self.X
                const lhs = assign.childForFieldName('left');
                if (!lhs || lhs.type !== 'attribute') return true;
                const lhsObj = lhs.childForFieldName('object');
                const lhsAttr = lhs.childForFieldName('attribute');
                if (!lhsObj || lhsObj.text !== 'self' || !lhsAttr) return true;

                const attrName = lhsAttr.text;

                // RHS: ClassName(...) or param or ClassName(...)
                const rhs = assign.childForFieldName('right');
                if (!rhs) return true;

                const typeName = extractConstructorName(rhs);
                if (typeName) {
                    attrTypes.set(attrName, typeName);
                }

                return true;
            });
        }

        if (attrTypes.size > 0) {
            result.set(className, attrTypes);
        }

        return false; // don't descend into nested classes from traverseTree
    });

    return result;
}

/**
 * Extract constructor class name from an expression node.
 * Handles: ClassName(...), param or ClassName(...), (param or ClassName(...)),
 *          expr if cond else ClassName(...)
 */
function extractConstructorName(node) {
    if (!node) return null;

    // Direct call: ClassName(...)
    if (node.type === 'call') {
        const func = node.childForFieldName('function');
        if (func?.type === 'identifier') {
            const name = func.text;
            // Only uppercase-first names (constructor heuristic)
            if (name[0] >= 'A' && name[0] <= 'Z') return name;
        }
        return null;
    }

    // Boolean fallback: param or ClassName(...)
    if (node.type === 'boolean_operator') {
        // Check operator is 'or'
        const op = node.child(1);
        if (op?.text === 'or') {
            const right = node.child(2);
            return extractConstructorName(right);
        }
    }

    // Conditional expression: expr if cond else ClassName(...)
    if (node.type === 'conditional_expression') {
        // Children: [0]=truthy, [1]='if', [2]=condition, [3]='else', [4]=else_value
        // Try else branch first (usually has the constructor fallback)
        const elseVal = node.child(4);
        const fromElse = extractConstructorName(elseVal);
        if (fromElse) return fromElse;
        // Also try truthy branch
        const truthyVal = node.child(0);
        return extractConstructorName(truthyVal);
    }

    // Parenthesized expression
    if (node.type === 'parenthesized_expression') {
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child.type !== '(' && child.type !== ')') {
                return extractConstructorName(child);
            }
        }
    }

    return null;
}

module.exports = {
    findFunctions,
    findClasses,
    findStateObjects,
    findCallsInCode,
    findImportsInCode,
    findExportsInCode,
    findUsagesInCode,
    findInstanceAttributeTypes,
    parse
};
