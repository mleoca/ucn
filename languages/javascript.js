/**
 * languages/javascript.js - Tree-sitter based JS/TS/TSX parsing
 *
 * Handles: function declarations, arrow functions, class declarations,
 * interfaces, type aliases, enums, and state objects.
 */

const {
    traverseTree,
    nodeToLocation,
    extractParams,
    parseStructuredParams,
    extractJSDocstring
} = require('./utils');
const { PARSE_OPTIONS, safeParse } = require('./index');

// Helper to consistently parse with buffer retries
function parseTree(parser, code) {
    return safeParse(parser, code, undefined, PARSE_OPTIONS);
}

/**
 * Extract return type annotation from JS/TS function
 * @param {object} node - Function node
 * @returns {string|null} Return type or null
 */
function extractReturnType(node) {
    const returnTypeNode = node.childForFieldName('return_type');
    if (returnTypeNode) {
        let text = returnTypeNode.text.trim();
        if (text.startsWith(':')) {
            text = text.slice(1).trim();
        }
        return text || null;
    }
    return null;
}

/**
 * Check if function is a generator
 * @param {object} node - Function node
 * @returns {boolean}
 */
function isGenerator(node) {
    return node.type === 'generator_function_declaration' ||
           node.type === 'generator_function';
}

/**
 * Extract generics from a function node
 * @param {object} node - Function node
 * @returns {string|null}
 */
function extractGenerics(node) {
    const typeParamsNode = node.childForFieldName('type_parameters');
    if (typeParamsNode) {
        return typeParamsNode.text;
    }
    return null;
}

/**
 * Get assignment name from left side of assignment
 */
function getAssignmentName(leftNode) {
    if (!leftNode) return null;
    if (leftNode.type === 'identifier') return leftNode.text;
    if (leftNode.type === 'member_expression') {
        const propNode = leftNode.childForFieldName('property');
        if (propNode && (propNode.type === 'property_identifier' || propNode.type === 'identifier')) {
            return propNode.text;
        }
    }
    return null;
}

/**
 * Extract modifiers from function text
 */
function extractModifiers(text) {
    const mods = [];
    const firstLine = text.split('\n')[0];
    if (firstLine.includes('export ')) mods.push('export');
    if (firstLine.includes('async ')) mods.push('async');
    if (firstLine.includes('default ')) mods.push('default');
    return mods;
}

/**
 * Find all functions in JS/TS code using tree-sitter
 * @param {string} code - Source code
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array}
 */
function findFunctions(code, parser) {
    const tree = parseTree(parser, code);
    const functions = [];
    const processedRanges = new Set();

    traverseTree(tree.rootNode, (node) => {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;

        // Function declarations
        if (node.type === 'function_declaration' || node.type === 'generator_function_declaration') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            const nameNode = node.childForFieldName('name');
            const paramsNode = node.childForFieldName('parameters');

            if (nameNode) {
                const { startLine, endLine, indent } = nodeToLocation(node, code);
                const returnType = extractReturnType(node);
                const generics = extractGenerics(node);
                const docstring = extractJSDocstring(code, startLine);
                const isGen = isGenerator(node);
                // Check parent for export status (function_declaration inside export_statement)
                const modifiers = node.parent && node.parent.type === 'export_statement'
                    ? extractModifiers(node.parent.text)
                    : extractModifiers(node.text);

                functions.push({
                    name: nameNode.text,
                    params: extractParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'javascript'),
                    startLine,
                    endLine,
                    indent,
                    isArrow: false,
                    isGenerator: isGen,
                    modifiers,
                    ...(returnType && { returnType }),
                    ...(generics && { generics }),
                    ...(docstring && { docstring })
                });
            }
            return true;
        }

        // TypeScript function signatures (e.g., in .d.ts files)
        if (node.type === 'function_signature') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            const nameNode = node.childForFieldName('name');
            const paramsNode = node.childForFieldName('parameters');

            if (nameNode) {
                const { startLine, endLine, indent } = nodeToLocation(node, code);
                const returnType = extractReturnType(node);
                const generics = extractGenerics(node);
                const docstring = extractJSDocstring(code, startLine);

                functions.push({
                    name: nameNode.text,
                    params: extractParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'typescript'),
                    startLine,
                    endLine,
                    indent,
                    isArrow: false,
                    isGenerator: false,
                    modifiers: [],
                    ...(returnType && { returnType }),
                    ...(generics && { generics }),
                    ...(docstring && { docstring })
                });
            }
            return true;
        }

        // Variable declarations with arrow functions or function expressions
        if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
            if (processedRanges.has(rangeKey)) return true;

            for (let i = 0; i < node.namedChildCount; i++) {
                const declarator = node.namedChild(i);
                if (declarator.type === 'variable_declarator') {
                    const nameNode = declarator.childForFieldName('name');
                    const valueNode = declarator.childForFieldName('value');

                    if (nameNode && valueNode) {
                        const isArrow = valueNode.type === 'arrow_function';
                        const isFnExpr = valueNode.type === 'function_expression' ||
                                         valueNode.type === 'generator_function';

                        if (isArrow || isFnExpr) {
                            processedRanges.add(rangeKey);
                            const paramsNode = valueNode.childForFieldName('parameters');
                            const { startLine, endLine, indent } = nodeToLocation(node, code);
                            const returnType = extractReturnType(valueNode);
                            const generics = extractGenerics(valueNode);
                            const docstring = extractJSDocstring(code, startLine);
                            const isGen = isGenerator(valueNode);
                            // Check parent for export status (lexical_declaration inside export_statement)
                            const modifiers = node.parent && node.parent.type === 'export_statement'
                                ? extractModifiers(node.parent.text)
                                : extractModifiers(node.text);

                            functions.push({
                                name: nameNode.text,
                                params: extractParams(paramsNode),
                                paramsStructured: parseStructuredParams(paramsNode, 'javascript'),
                                startLine,
                                endLine,
                                indent,
                                isArrow,
                                isGenerator: isGen,
                                modifiers,
                                ...(returnType && { returnType }),
                                ...(generics && { generics }),
                                ...(docstring && { docstring })
                            });
                        }
                    }
                }
            }
            return true;
        }

        // Assignment expressions: obj.method = function() {} or prototype assignments
        if (node.type === 'assignment_expression') {
            if (processedRanges.has(rangeKey)) return true;

            const leftNode = node.childForFieldName('left');
            const isPrototypeAssignment = leftNode && leftNode.type === 'member_expression' &&
                leftNode.text.includes('.prototype.');

            // For non-prototype assignments, check if nested
            if (!isPrototypeAssignment) {
                let parent = node.parent;
                let isTopLevel = true;
                while (parent) {
                    const ptype = parent.type;
                    if (ptype === 'function_declaration' || ptype === 'arrow_function' ||
                        ptype === 'function_expression' || ptype === 'method_definition' ||
                        ptype === 'generator_function_declaration' || ptype === 'generator_function' ||
                        ptype === 'class_body') {
                        isTopLevel = false;
                        break;
                    }
                    if (ptype === 'program' || ptype === 'module') {
                        break;
                    }
                    parent = parent.parent;
                }
                if (!isTopLevel) return true;
            }

            const rightNode = node.childForFieldName('right');

            if (leftNode && rightNode) {
                const isArrow = rightNode.type === 'arrow_function';
                const isFnExpr = rightNode.type === 'function_expression' ||
                                 rightNode.type === 'generator_function';

                if (isArrow || isFnExpr) {
                    const name = getAssignmentName(leftNode);
                    if (name) {
                        processedRanges.add(rangeKey);
                        const paramsNode = rightNode.childForFieldName('parameters');
                        const { startLine, endLine, indent } = nodeToLocation(node, code);
                        const returnType = extractReturnType(rightNode);
                        const generics = extractGenerics(rightNode);
                        const docstring = extractJSDocstring(code, startLine);
                        const isGen = isGenerator(rightNode);

                        functions.push({
                            name,
                            params: extractParams(paramsNode),
                            paramsStructured: parseStructuredParams(paramsNode, 'javascript'),
                            startLine,
                            endLine,
                            indent,
                            isArrow,
                            isGenerator: isGen,
                            modifiers: [],
                            ...(returnType && { returnType }),
                            ...(generics && { generics }),
                            ...(docstring && { docstring })
                        });
                    }
                }
            }
            return true;
        }

        // Export statements with anonymous functions
        if (node.type === 'export_statement') {
            const declaration = node.childForFieldName('declaration');
            if (!declaration) {
                for (let i = 0; i < node.namedChildCount; i++) {
                    const child = node.namedChild(i);
                    if (child.type === 'arrow_function' || child.type === 'function_expression' ||
                        child.type === 'generator_function') {
                        if (processedRanges.has(rangeKey)) return true;
                        processedRanges.add(rangeKey);

                        const paramsNode = child.childForFieldName('parameters');
                        const { startLine, endLine, indent } = nodeToLocation(node, code);
                        const returnType = extractReturnType(child);
                        const generics = extractGenerics(child);
                        const docstring = extractJSDocstring(code, startLine);
                        const isGen = isGenerator(child);

                        functions.push({
                            name: 'default',
                            params: extractParams(paramsNode),
                            paramsStructured: parseStructuredParams(paramsNode, 'javascript'),
                            startLine,
                            endLine,
                            indent,
                            isArrow: child.type === 'arrow_function',
                            isGenerator: isGen,
                            modifiers: ['export', 'default'],
                            ...(returnType && { returnType }),
                            ...(generics && { generics }),
                            ...(docstring && { docstring })
                        });
                        return true;
                    }
                }
            }
            return true;
        }

        return true;
    });

    functions.sort((a, b) => a.startLine - b.startLine);
    return functions;
}

/**
 * Find all classes, interfaces, types, and enums
 * @param {string} code - Source code
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array}
 */
function findClasses(code, parser) {
    const tree = parseTree(parser, code);
    const classes = [];

    traverseTree(tree.rootNode, (node) => {
        // Class declarations
        if (node.type === 'class_declaration' || node.type === 'class') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(node, code);
                const members = extractClassMembers(node, code);
                const docstring = extractJSDocstring(code, startLine);
                const generics = extractGenerics(node);
                const extendsInfo = extractExtends(node);
                const implementsInfo = extractImplements(node);

                classes.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    type: 'class',
                    members,
                    ...(docstring && { docstring }),
                    ...(generics && { generics }),
                    ...(extendsInfo && { extends: extendsInfo }),
                    ...(implementsInfo.length > 0 && { implements: implementsInfo })
                });
            }
            return false;
        }

        // TypeScript interface declarations
        if (node.type === 'interface_declaration') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(node, code);
                const docstring = extractJSDocstring(code, startLine);
                const generics = extractGenerics(node);
                const extendsInfo = extractInterfaceExtends(node);

                classes.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    type: 'interface',
                    members: [],
                    ...(docstring && { docstring }),
                    ...(generics && { generics }),
                    ...(extendsInfo.length > 0 && { extends: extendsInfo.join(', ') })
                });
            }
            return false;
        }

        // TypeScript type alias declarations
        if (node.type === 'type_alias_declaration') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(node, code);
                const docstring = extractJSDocstring(code, startLine);

                classes.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    type: 'type',
                    members: [],
                    ...(docstring && { docstring })
                });
            }
            return false;
        }

        // TypeScript enum declarations
        if (node.type === 'enum_declaration') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(node, code);
                const docstring = extractJSDocstring(code, startLine);

                classes.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    type: 'enum',
                    members: [],
                    ...(docstring && { docstring })
                });
            }
            return false;
        }

        return true;
    });

    classes.sort((a, b) => a.startLine - b.startLine);
    return classes;
}

/**
 * Extract extends clause from class
 */
function extractExtends(classNode) {
    for (let i = 0; i < classNode.namedChildCount; i++) {
        const child = classNode.namedChild(i);
        if (child.type === 'class_heritage') {
            // Extract extends clause, preserving dotted names and generic type params
            // e.g. "extends React.Component<Props, State>" → "React.Component<Props, State>"
            const text = child.text;
            const extendsIdx = text.indexOf('extends ');
            if (extendsIdx !== -1) {
                let extendsType = text.slice(extendsIdx + 8).trim();
                // Stop at "implements" if present
                const implIdx = extendsType.indexOf(' implements ');
                if (implIdx !== -1) extendsType = extendsType.slice(0, implIdx).trim();
                // Stop at opening brace
                const braceIdx = extendsType.indexOf('{');
                if (braceIdx !== -1) extendsType = extendsType.slice(0, braceIdx).trim();
                if (extendsType) return extendsType;
            }
        }
    }
    return null;
}

/**
 * Extract implements clause from class
 */
function extractImplements(classNode) {
    const implements_ = [];
    for (let i = 0; i < classNode.namedChildCount; i++) {
        const child = classNode.namedChild(i);
        if (child.type === 'class_heritage') {
            const implMatch = child.text.match(/implements\s+([^{]+)/);
            if (implMatch) {
                const names = implMatch[1].split(',').map(n => n.trim());
                implements_.push(...names);
            }
        }
    }
    return implements_;
}

/**
 * Extract extends from interface
 */
function extractInterfaceExtends(interfaceNode) {
    const extends_ = [];
    for (let i = 0; i < interfaceNode.namedChildCount; i++) {
        const child = interfaceNode.namedChild(i);
        if (child.type === 'extends_type_clause') {
            // Parse comma-separated type names
            const text = child.text.replace(/^extends\s+/, '');
            const names = text.split(',').map(n => n.trim());
            extends_.push(...names);
        }
    }
    return extends_;
}

/**
 * Extract class members
 */
function extractClassMembers(classNode, code) {
    const members = [];
    const bodyNode = classNode.childForFieldName('body');
    if (!bodyNode) return members;

    for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const child = bodyNode.namedChild(i);

        // Method definitions
        if (child.type === 'method_definition' || child.type === 'method_signature') {
            const nameNode = child.childForFieldName('name');
            const paramsNode = child.childForFieldName('parameters');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(child, code);
                let name = nameNode.text;
                const text = child.text;

                // Determine member type
                let memberType = 'method';
                const hasOverride = /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?override\s/.test(text);
                const isGen = /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?\*/.test(text);

                if (name === 'static') {
                    const staticMatch = text.match(/^\s*static\s+(?:override\s+|readonly\s+|async\s+)?\*?\s*(?:get\s+|set\s+)?(\w+)/);
                    if (staticMatch) name = staticMatch[1];
                }

                if (name === 'constructor') {
                    memberType = 'constructor';
                } else if (text.match(/^\s*(?:public\s+|private\s+|protected\s+)?(?:override\s+)?static\s+(?:override\s+)?get\s/)) {
                    memberType = hasOverride ? 'static override get' : 'static get';
                } else if (text.match(/^\s*(?:public\s+|private\s+|protected\s+)?(?:override\s+)?static\s+(?:override\s+)?set\s/)) {
                    memberType = hasOverride ? 'static override set' : 'static set';
                } else if (text.match(/^\s*(?:public\s+|private\s+|protected\s+)?(?:override\s+)?static\s/)) {
                    memberType = hasOverride ? 'static override' : 'static';
                } else if (text.match(/^\s*(?:public\s+|private\s+|protected\s+)?(?:override\s+)?get\s/)) {
                    memberType = hasOverride ? 'override get' : 'get';
                } else if (text.match(/^\s*(?:public\s+|private\s+|protected\s+)?(?:override\s+)?set\s/)) {
                    memberType = hasOverride ? 'override set' : 'set';
                } else if (name.startsWith('#')) {
                    memberType = 'private';
                } else if (hasOverride) {
                    memberType = 'override';
                }

                const isAsync = text.match(/^\s*(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:override\s+)?async\s/) !== null;
                const returnType = extractReturnType(child);
                const docstring = extractJSDocstring(code, startLine);

                members.push({
                    name,
                    params: extractParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'javascript'),
                    startLine,
                    endLine,
                    memberType,
                    isAsync,
                    isGenerator: isGen,
                    isMethod: true,  // Mark as method for context() lookups
                    ...(returnType && { returnType }),
                    ...(docstring && { docstring })
                });
            }
        }

        // Field definitions
        if (child.type === 'field_definition' || child.type === 'public_field_definition') {
            const nameNode = child.childForFieldName('name') || child.childForFieldName('property');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(child, code);
                const name = nameNode.text;
                const valueNode = child.childForFieldName('value');
                const isArrow = valueNode && valueNode.type === 'arrow_function';

                if (isArrow) {
                    const paramsNode = valueNode.childForFieldName('parameters');
                    const returnType = extractReturnType(valueNode);
                    members.push({
                        name,
                        params: extractParams(paramsNode),
                        paramsStructured: parseStructuredParams(paramsNode, 'javascript'),
                        startLine,
                        endLine,
                        memberType: name.startsWith('#') ? 'private' : 'field',
                        isArrow: true,
                        isMethod: true,  // Arrow fields are callable like methods
                        ...(returnType && { returnType })
                    });
                } else {
                    members.push({
                        name,
                        startLine,
                        endLine,
                        memberType: name.startsWith('#') ? 'private field' : 'field'
                        // Not a method - regular field
                    });
                }
            }
        }
    }

    return members;
}

/**
 * Find state objects (CONFIG, constants, etc.)
 */
function findStateObjects(code, parser) {
    const tree = parseTree(parser, code);
    const objects = [];

    const statePattern = /^(CONFIG|[A-Z][a-zA-Z]*(?:State|Store|Context|Options|Settings)|[A-Z][A-Z_]+|Entities|Input)$/;
    const actionPattern = /^(action\w*|[a-z]+Action|[a-z]+State)$/;
    const factoryFunctions = ['register', 'createAction', 'defineAction', 'makeAction'];

    const isFactoryCall = (node) => {
        if (node.type !== 'call_expression') return false;
        const funcNode = node.childForFieldName('function');
        if (!funcNode) return false;
        const funcName = funcNode.type === 'identifier' ? funcNode.text : null;
        return funcName && factoryFunctions.includes(funcName);
    };

    traverseTree(tree.rootNode, (node) => {
        if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const declarator = node.namedChild(i);
                if (declarator.type === 'variable_declarator') {
                    const nameNode = declarator.childForFieldName('name');
                    const valueNode = declarator.childForFieldName('value');

                    if (nameNode && valueNode) {
                        const name = nameNode.text;
                        const isObject = valueNode.type === 'object';
                        const isArray = valueNode.type === 'array';

                        if ((isObject || isArray) && statePattern.test(name)) {
                            const { startLine, endLine } = nodeToLocation(node, code);
                            objects.push({ name, startLine, endLine });
                        } else if (isFactoryCall(valueNode) && (actionPattern.test(name) || statePattern.test(name))) {
                            const { startLine, endLine } = nodeToLocation(node, code);
                            objects.push({ name, startLine, endLine });
                        }
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
 * Parse a JavaScript/TypeScript file completely
 * @param {string} code - Source code
 * @param {object} parser - Tree-sitter parser instance
 * @returns {ParseResult}
 */
function parse(code, parser) {
    return {
        language: 'javascript',
        totalLines: code.split('\n').length,
        functions: findFunctions(code, parser),
        classes: findClasses(code, parser),
        stateObjects: findStateObjects(code, parser),
        imports: [],  // Handled by core/imports.js
        exports: []   // Handled by core/imports.js
    };
}

/**
 * Find all function calls in code using tree-sitter AST
 * Returns calls with their names and line numbers, properly excluding
 * calls that appear in comments, strings, and regex literals.
 *
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{name: string, line: number, isMethod: boolean, receiver?: string, isConstructor?: boolean}>}
 */
function findCallsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const calls = [];
    const functionStack = [];  // Stack of { name, startLine, endLine }
    const aliases = new Map();  // Track local aliases: aliasName -> originalName (string or string[])
    const nonCallableNames = new Set();  // Track names assigned non-callable values

    // Helper to check if a node is a non-callable literal
    const isNonCallableInit = (node) => {
        // Primitive literals
        if (['number', 'string', 'template_string', 'true', 'false', 'null', 'regex'].includes(node.type)) {
            return true;
        }
        if (node.type === 'identifier' && node.text === 'undefined') {
            return true;
        }
        // Array literal: non-callable if no function-valued elements
        if (node.type === 'array') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const el = node.namedChild(i);
                if (['function_expression', 'arrow_function', 'generator_function'].includes(el.type)) {
                    return false;
                }
            }
            return true;
        }
        // Object literal: non-callable if no function-valued properties
        if (node.type === 'object') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const prop = node.namedChild(i);
                if (prop.type === 'method_definition') return false;
                if (prop.type === 'pair') {
                    const val = prop.childForFieldName('value');
                    if (val && ['function_expression', 'arrow_function', 'generator_function'].includes(val.type)) {
                        return false;
                    }
                }
            }
            return true;
        }
        return false;
    };

    // Known higher-order function methods where arguments are likely function references
    // Maps method name -> Set of argument indices that are callbacks (null = all args are callbacks)
    const HOF_METHODS = new Map([
        // Promise — all args are callbacks
        ['then', null], ['catch', null], ['finally', null],
        // Array — first arg is always the callback
        ['map', new Set([0])], ['flatMap', new Set([0])], ['filter', new Set([0])],
        ['find', new Set([0])], ['findIndex', new Set([0])],
        ['some', new Set([0])], ['every', new Set([0])],
        ['forEach', new Set([0])], ['reduce', new Set([0])], ['reduceRight', new Set([0])],
        ['sort', new Set([0])], ['toSorted', new Set([0])],
        // Event — second arg is the callback (first is event name string)
        ['addEventListener', new Set([1])], ['removeEventListener', new Set([1])],
        ['on', new Set([1])], ['once', new Set([1])], ['off', new Set([1])],
        // Other common HOFs — all args
        ['pipe', null], ['subscribe', null], ['tap', null], ['use', null]
    ]);
    // Standalone HOFs (called as free functions, not methods)
    const HOF_FUNCTIONS = new Map([
        ['setTimeout', new Set([0])], ['setInterval', new Set([0])],
        ['setImmediate', new Set([0])], ['requestAnimationFrame', new Set([0])],
        ['queueMicrotask', new Set([0])]
    ]);
    // Identifiers that should never be treated as function references
    const SKIP_IDENTS = new Set([
        'null', 'undefined', 'true', 'false', 'this', 'super',
        'NaN', 'Infinity', 'arguments', 'globalThis', 'window', 'document',
        'module', 'exports', 'require', 'console', 'process'
    ]);

    // Helper to check if a node creates a function scope
    const isFunctionNode = (node) => {
        return ['function_declaration', 'function_expression', 'arrow_function',
                'method_definition', 'generator_function_declaration', 'generator_function'].includes(node.type);
    };

    // Helper to extract function name from a function node
    const extractFunctionName = (node) => {
        if (node.type === 'function_declaration' || node.type === 'generator_function_declaration') {
            const nameNode = node.childForFieldName('name');
            return nameNode?.text || '<anonymous>';
        }
        if (node.type === 'method_definition') {
            const nameNode = node.childForFieldName('name');
            return nameNode?.text || '<anonymous>';
        }
        if (node.type === 'function_expression' || node.type === 'generator_function') {
            const nameNode = node.childForFieldName('name');
            return nameNode?.text || '<anonymous>';
        }
        if (node.type === 'arrow_function') {
            // Arrow functions don't have names, but check parent for variable assignment
            const parent = node.parent;
            if (parent?.type === 'variable_declarator') {
                const nameNode = parent.childForFieldName('name');
                return nameNode?.text || '<anonymous>';
            }
            if (parent?.type === 'pair') {
                const keyNode = parent.childForFieldName('key');
                return keyNode?.text || '<anonymous>';
            }
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

    traverseTree(tree.rootNode, (node) => {
        // Track function entry
        if (isFunctionNode(node)) {
            functionStack.push({
                name: extractFunctionName(node),
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1
            });
        }

        // Track local aliases: const myParse = parse, const { parse: csvParse } = ...
        if (node.type === 'variable_declarator') {
            const nameNode = node.childForFieldName('name');
            const initNode = node.childForFieldName('value');
            if (nameNode?.type === 'identifier' && initNode?.type === 'identifier') {
                // Simple alias: const p = parse
                aliases.set(nameNode.text, initNode.text);
            }
            // Ternary alias: const fn = cond ? parseCSV : parseJSON → both targets
            if (nameNode?.type === 'identifier' && initNode?.type === 'ternary_expression') {
                const consequence = initNode.childForFieldName('consequence');
                const alternative = initNode.childForFieldName('alternative');
                const targets = [];
                if (consequence?.type === 'identifier') targets.push(consequence.text);
                if (alternative?.type === 'identifier') targets.push(alternative.text);
                if (targets.length > 0) aliases.set(nameNode.text, targets);
            }
            // Destructured rename: const { parse: csvParse } = require(...)
            if (nameNode?.type === 'object_pattern') {
                for (let i = 0; i < nameNode.namedChildCount; i++) {
                    const prop = nameNode.namedChild(i);
                    if (prop.type === 'pair_pattern') {
                        const key = prop.childForFieldName('key');
                        const value = prop.childForFieldName('value');
                        if ((key?.type === 'identifier' || key?.type === 'property_identifier') &&
                            value?.type === 'identifier') {
                            aliases.set(value.text, key.text);
                        }
                    }
                }
            }
            // Track non-callable assignments: const count = 5, const name = "hello"
            if (nameNode?.type === 'identifier' && initNode && isNonCallableInit(initNode)) {
                nonCallableNames.add(nameNode.text);
            }
            // Track new expression results: const request = new Foo()
            // Constructor results are object instances, not callable functions
            if (nameNode?.type === 'identifier' && initNode?.type === 'new_expression') {
                nonCallableNames.add(nameNode.text);
            }
        }

        // Handle regular function calls: foo(), obj.foo(), foo.call()
        if (node.type === 'call_expression') {
            const funcNode = node.childForFieldName('function');
            if (!funcNode) return true;

            const enclosingFunction = getCurrentEnclosingFunction();
            let uncertain = false;
            // optional chaining implies possible non-call
            // Only check text before the opening paren to avoid false positives from arguments like foo(bar?.baz)
            const parenIdx = node.text.indexOf('(');
            if (parenIdx > 0 && node.text.slice(0, parenIdx).includes('?.')) uncertain = true;

            if (funcNode.type === 'identifier') {
                // Direct call: foo()
                const alias = aliases.get(funcNode.text);
                const resolvedName = typeof alias === 'string' ? alias : undefined;
                const resolvedNames = Array.isArray(alias) ? alias : undefined;
                calls.push({
                    name: funcNode.text,
                    ...(resolvedName && { resolvedName }),
                    ...(resolvedNames && { resolvedNames }),
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    enclosingFunction,
                    uncertain
                });
            } else if (funcNode.type === 'member_expression') {
                // Method call: obj.foo() or foo.call/apply/bind()
                const propNode = funcNode.childForFieldName('property');
                const objNode = funcNode.childForFieldName('object');

                if (propNode) {
                    const propName = propNode.text;

                    // Handle .call(), .apply(), .bind() - these are calls TO the object
                    if (['call', 'apply', 'bind'].includes(propName) && objNode) {
                        if (objNode.type === 'identifier') {
                            // foo.call() -> call to foo
                            calls.push({
                                name: objNode.text,
                                line: node.startPosition.row + 1,
                                isMethod: false,
                                enclosingFunction
                            });
                        } else if (objNode.type === 'member_expression') {
                            // obj.foo.call() -> method call to foo
                            const innerProp = objNode.childForFieldName('property');
                            const innerObj = objNode.childForFieldName('object');
                            if (innerProp) {
                                calls.push({
                                    name: innerProp.text,
                                    line: node.startPosition.row + 1,
                                    isMethod: true,
                                    receiver: innerObj?.text,
                                    enclosingFunction,
                                    uncertain
                                });
                            }
                        }
                    } else {
                        // Regular method call: obj.foo()
                        // Extract receiver: handles identifiers (obj), this, super
                        let receiver = undefined;
                        if (objNode) {
                            if (objNode.type === 'identifier' || objNode.type === 'this' || objNode.type === 'super') {
                                receiver = objNode.text;
                            }
                        }
                        calls.push({
                            name: propName,
                            line: node.startPosition.row + 1,
                            isMethod: true,
                            receiver,
                            enclosingFunction,
                            uncertain
                        });
                    }
                }
            }

            // Detect function references passed as arguments to HOFs
            // e.g., .then(handleProcess), .map(processItem), setTimeout(doWork, 1000)
            let calledName = null;
            if (funcNode.type === 'identifier') {
                calledName = funcNode.text;
            } else if (funcNode.type === 'member_expression') {
                const propNode = funcNode.childForFieldName('property');
                calledName = propNode?.text;
            }

            const hofMethodIndices = calledName ? HOF_METHODS.get(calledName) : undefined;
            const hofFuncIndices = (funcNode.type === 'identifier' && calledName) ? HOF_FUNCTIONS.get(calledName) : undefined;
            const isHOF = HOF_METHODS.has(calledName) || (funcNode.type === 'identifier' && HOF_FUNCTIONS.has(calledName));
            const callbackIndices = hofMethodIndices !== undefined ? hofMethodIndices : hofFuncIndices;
            if (isHOF) {
                const argsNode = node.childForFieldName('arguments');
                if (argsNode) {
                    let argIdx = 0;
                    for (let i = 0; i < argsNode.namedChildCount; i++) {
                        const arg = argsNode.namedChild(i);
                        // Skip non-argument nodes (e.g. commas)
                        if (arg.type === 'comment') continue;
                        // Only check args at callback positions (null = all positions)
                        const isCallbackPos = callbackIndices === null || callbackIndices === undefined || callbackIndices.has(argIdx);
                        if (isCallbackPos) {
                            if (arg.type === 'identifier' && !SKIP_IDENTS.has(arg.text)) {
                                calls.push({
                                    name: arg.text,
                                    line: arg.startPosition.row + 1,
                                    isMethod: false,
                                    isFunctionReference: true,
                                    enclosingFunction
                                });
                            } else if (arg.type === 'member_expression') {
                                // Handle obj.method passed as callback: .then(utils.handleError)
                                const propNode = arg.childForFieldName('property');
                                const objNode = arg.childForFieldName('object');
                                if (propNode && !SKIP_IDENTS.has(propNode.text)) {
                                    calls.push({
                                        name: propNode.text,
                                        line: arg.startPosition.row + 1,
                                        isMethod: true,
                                        receiver: objNode?.type === 'identifier' ? objNode.text : undefined,
                                        isFunctionReference: true,
                                        enclosingFunction
                                    });
                                }
                            }
                        }
                        argIdx++;
                    }
                }
            }

            // General function-argument detection for non-HOF calls
            // Detects: execute(processItem, 42), retry(fetchData, 3), etc.
            // Also detects function refs in object literal args: doRequest({onSuccess: handleSuccess})
            if (!isHOF) {
                const argsNode = node.childForFieldName('arguments');
                if (argsNode) {
                    for (let i = 0; i < argsNode.namedChildCount; i++) {
                        const arg = argsNode.namedChild(i);
                        if (arg.type === 'identifier' && !SKIP_IDENTS.has(arg.text) && !nonCallableNames.has(arg.text)) {
                            calls.push({
                                name: arg.text,
                                line: arg.startPosition.row + 1,
                                isMethod: false,
                                isFunctionReference: true,
                                isPotentialCallback: true,
                                enclosingFunction
                            });
                        }
                        // Scan object literal args for function refs in property values
                        // e.g., doRequest({onSuccess: handleSuccess, onError: handleError})
                        if (arg.type === 'object') {
                            for (let j = 0; j < arg.namedChildCount; j++) {
                                const prop = arg.namedChild(j);
                                if (prop.type === 'pair') {
                                    const val = prop.childForFieldName('value');
                                    if (val?.type === 'identifier' && !SKIP_IDENTS.has(val.text) && !nonCallableNames.has(val.text)) {
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
            }

            return true;
        }

        // Handle constructor calls: new Foo()
        if (node.type === 'new_expression') {
            const ctorNode = node.childForFieldName('constructor');
            if (ctorNode) {
                const enclosingFunction = getCurrentEnclosingFunction();

                if (ctorNode.type === 'identifier') {
                    calls.push({
                        name: ctorNode.text,
                        line: node.startPosition.row + 1,
                        isMethod: false,
                        isConstructor: true,
                        enclosingFunction
                    });
                } else if (ctorNode.type === 'member_expression') {
                    // new obj.Foo() or new module.Class()
                    const propNode = ctorNode.childForFieldName('property');
                    if (propNode) {
                        calls.push({
                            name: propNode.text,
                            line: node.startPosition.row + 1,
                            isMethod: true,
                            isConstructor: true,
                            enclosingFunction
                        });
                    }
                }
            }
            return true;
        }

        // Handle JSX component usage: <Component /> or <Component>...</Component>
        // Only track PascalCase names (React components), not lowercase (HTML elements)
        if (node.type === 'jsx_self_closing_element' || node.type === 'jsx_opening_element') {
            // First named child is the element name
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'identifier') {
                    const name = child.text;
                    // React components start with uppercase
                    if (name && /^[A-Z]/.test(name)) {
                        const enclosingFunction = getCurrentEnclosingFunction();
                        calls.push({
                            name: name,
                            line: child.startPosition.row + 1,
                            isMethod: false,
                            isJsxComponent: true,
                            enclosingFunction
                        });
                    }
                    break;
                }
                // Handle namespaced components: <Foo.Bar />
                if (child.type === 'member_expression' || child.type === 'nested_identifier') {
                    const text = child.text;
                    // Get the last part after the dot
                    const parts = text.split('.');
                    const componentName = parts[parts.length - 1];
                    if (componentName && /^[A-Z]/.test(componentName)) {
                        const enclosingFunction = getCurrentEnclosingFunction();
                        calls.push({
                            name: componentName,
                            line: child.startPosition.row + 1,
                            isMethod: true,
                            receiver: parts.slice(0, -1).join('.'),
                            isJsxComponent: true,
                            enclosingFunction
                        });
                    }
                    break;
                }
            }
            return true;
        }

        // Handle JSX attribute function references: onClick={handlePaste}, onSubmit={utils.handler}
        // Only captures bare identifiers/member expressions (not calls like onClick={handlePaste()})
        if (node.type === 'jsx_expression') {
            const parent = node.parent;
            if (parent?.type === 'jsx_attribute' && node.namedChildCount === 1) {
                const child = node.namedChild(0);
                if (child.type === 'identifier' && !SKIP_IDENTS.has(child.text) && !nonCallableNames.has(child.text)) {
                    const enclosingFunction = getCurrentEnclosingFunction();
                    calls.push({
                        name: child.text,
                        line: child.startPosition.row + 1,
                        isMethod: false,
                        isFunctionReference: true,
                        isPotentialCallback: true,
                        enclosingFunction
                    });
                } else if (child.type === 'member_expression') {
                    const propNode = child.childForFieldName('property');
                    const objNode = child.childForFieldName('object');
                    if (propNode && !SKIP_IDENTS.has(propNode.text)) {
                        const enclosingFunction = getCurrentEnclosingFunction();
                        calls.push({
                            name: propNode.text,
                            line: child.startPosition.row + 1,
                            isMethod: true,
                            receiver: objNode?.type === 'identifier' ? objNode.text : undefined,
                            isFunctionReference: true,
                            isPotentialCallback: true,
                            enclosingFunction
                        });
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
 * Find all callback usages - functions passed as arguments to other functions
 * Detects patterns like: array.map(fn), addEventListener('click', handler), router.get('/path', handler)
 * @param {string} code - Source code to analyze
 * @param {string} name - Function name to look for
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{line: number, context: string, pattern: string}>}
 */
function findCallbackUsages(code, name, parser) {
    const tree = parseTree(parser, code);
    const usages = [];

    traverseTree(tree.rootNode, (node) => {
        // Look for call expressions where our name is passed as an argument
        if (node.type === 'call_expression') {
            const argsNode = node.childForFieldName('arguments');
            if (!argsNode) return true;

            // Check each argument
            for (let i = 0; i < argsNode.namedChildCount; i++) {
                const arg = argsNode.namedChild(i);

                // Direct identifier: map(fn), addEventListener('click', handler)
                if (arg.type === 'identifier' && arg.text === name) {
                    const funcNode = node.childForFieldName('function');
                    let pattern = 'callback';

                    // Detect specific patterns
                    if (funcNode) {
                        if (funcNode.type === 'member_expression') {
                            const prop = funcNode.childForFieldName('property');
                            if (prop) {
                                const methodName = prop.text;
                                // Higher-order array methods
                                if (['map', 'filter', 'reduce', 'forEach', 'find', 'some', 'every', 'flatMap', 'sort'].includes(methodName)) {
                                    pattern = 'array-method';
                                }
                                // Event listeners
                                else if (['addEventListener', 'removeEventListener', 'on', 'once', 'off', 'emit'].includes(methodName)) {
                                    pattern = 'event-handler';
                                }
                                // Router/middleware
                                else if (['get', 'post', 'put', 'delete', 'patch', 'use', 'all', 'route'].includes(methodName)) {
                                    pattern = 'route-handler';
                                }
                                // Promise methods
                                else if (['then', 'catch', 'finally'].includes(methodName)) {
                                    pattern = 'promise-handler';
                                }
                            }
                        }
                    }

                    usages.push({
                        line: node.startPosition.row + 1,
                        context: node.text.substring(0, 80),
                        pattern
                    });
                }

                // Member expression: use obj.handler
                if (arg.type === 'member_expression') {
                    const prop = arg.childForFieldName('property');
                    if (prop && prop.text === name) {
                        usages.push({
                            line: node.startPosition.row + 1,
                            context: node.text.substring(0, 80),
                            pattern: 'method-reference'
                        });
                    }
                }
            }
            return true;
        }

        // Look for JSX event handlers: onClick={handler}
        if (node.type === 'jsx_attribute') {
            const valueNode = node.childForFieldName('value');
            if (valueNode && valueNode.type === 'jsx_expression') {
                for (let i = 0; i < valueNode.namedChildCount; i++) {
                    const expr = valueNode.namedChild(i);
                    if (expr.type === 'identifier' && expr.text === name) {
                        usages.push({
                            line: node.startPosition.row + 1,
                            context: node.text,
                            pattern: 'jsx-handler'
                        });
                    }
                }
            }
            return true;
        }

        return true;
    });

    return usages;
}

/**
 * Find re-exports: export { fn } from './module'
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{name: string, from: string, line: number}>}
 */
function findReExports(code, parser) {
    const tree = parseTree(parser, code);
    const reExports = [];

    traverseTree(tree.rootNode, (node) => {
        // export { name } from './module'
        if (node.type === 'export_statement') {
            let hasFrom = false;
            let fromModule = null;
            const names = [];

            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'string') {
                    fromModule = child.text.slice(1, -1);
                    hasFrom = true;
                }
                if (child.type === 'export_clause') {
                    for (let j = 0; j < child.namedChildCount; j++) {
                        const specifier = child.namedChild(j);
                        if (specifier.type === 'export_specifier') {
                            const nameNode = specifier.childForFieldName('name') || specifier.namedChild(0);
                            if (nameNode) {
                                names.push(nameNode.text);
                            }
                        }
                    }
                }
            }

            if (hasFrom && fromModule && names.length > 0) {
                for (const name of names) {
                    reExports.push({
                        name,
                        from: fromModule,
                        line: node.startPosition.row + 1
                    });
                }
            }
        }
        return true;
    });

    return reExports;
}

/**
 * Find all imports in JavaScript/TypeScript code using tree-sitter AST
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{module: string, names: string[], type: string, line: number}>}
 */
function findImportsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const imports = [];
    let importAliases = null;  // {original, local}[] — tracks renamed imports

    traverseTree(tree.rootNode, (node) => {
        // ES6 import statements
        if (node.type === 'import_statement') {
            const line = node.startPosition.row + 1;
            let modulePath = null;
            const names = [];
            let importType = 'named';

            // Find the module path (string node)
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'string') {
                    // Extract text without quotes
                    const text = child.text;
                    modulePath = text.slice(1, -1);
                }
                if (child.type === 'import_clause') {
                    // Process import clause
                    for (let j = 0; j < child.namedChildCount; j++) {
                        const clauseChild = child.namedChild(j);
                        if (clauseChild.type === 'identifier') {
                            // Default import: import foo from 'x'
                            names.push(clauseChild.text);
                            importType = 'default';
                        } else if (clauseChild.type === 'named_imports') {
                            // Named imports: import { a, b } from 'x'
                            for (let k = 0; k < clauseChild.namedChildCount; k++) {
                                const specifier = clauseChild.namedChild(k);
                                if (specifier.type === 'import_specifier') {
                                    const nameNode = specifier.namedChild(0);
                                    const aliasNode = specifier.namedChild(1);
                                    if (nameNode) names.push(nameNode.text);
                                    // Track renamed imports: import { X as Y }
                                    if (nameNode && aliasNode && aliasNode.text !== nameNode.text) {
                                        if (!importAliases) importAliases = [];
                                        importAliases.push({ original: nameNode.text, local: aliasNode.text });
                                    }
                                }
                            }
                            importType = 'named';
                        } else if (clauseChild.type === 'namespace_import') {
                            // Namespace import: import * as foo from 'x'
                            const nsName = clauseChild.childForFieldName('name') ||
                                          clauseChild.namedChild(0);
                            if (nsName) names.push(nsName.text);
                            importType = 'namespace';
                        }
                    }
                }
            }

            if (modulePath) {
                if (names.length === 0) {
                    // Side-effect import: import 'x'
                    importType = 'side-effect';
                }
                imports.push({ module: modulePath, names, type: importType, line });
            }
            return true;
        }

        // Re-export statements: export { X } from './module' or export * from './module'
        // These are implicit imports that must be tracked for dependency resolution
        if (node.type === 'export_statement') {
            let source = null;
            const names = [];

            // Find the source module (string node with 'from')
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'string') {
                    source = child.text.slice(1, -1);
                }
                if (child.type === 'export_clause') {
                    for (let j = 0; j < child.namedChildCount; j++) {
                        const specifier = child.namedChild(j);
                        if (specifier.type === 'export_specifier') {
                            const nameNode = specifier.namedChild(0);
                            if (nameNode) names.push(nameNode.text);
                        }
                    }
                }
            }

            if (source) {
                const line = node.startPosition.row + 1;
                const isStarReExport = node.text.includes('export *');
                const importType = isStarReExport ? 'namespace' : 'named';
                imports.push({ module: source, names, type: importType, line, isReExport: true });
            }
            return true;
        }

        // CommonJS require() calls
        if (node.type === 'call_expression') {
            const funcNode = node.childForFieldName('function');
            if (funcNode && funcNode.type === 'identifier' && funcNode.text === 'require') {
                const argsNode = node.childForFieldName('arguments');
                if (argsNode && argsNode.namedChildCount > 0) {
                    const firstArg = argsNode.namedChild(0);
                    const line = node.startPosition.row + 1;
                    const names = [];
                    let modulePath = null;
                    let dynamic = false;

                    if (firstArg && firstArg.type === 'string') {
                        modulePath = firstArg.text.slice(1, -1);
                    } else {
                        dynamic = true;
                        modulePath = firstArg ? firstArg.text : null;
                    }

                    // Check parent for variable name
                    let parent = node.parent;
                    if (parent && parent.type === 'variable_declarator') {
                        const nameNode = parent.childForFieldName('name');
                        if (nameNode) {
                            if (nameNode.type === 'identifier') {
                                names.push(nameNode.text);
                            } else if (nameNode.type === 'object_pattern') {
                                // Destructuring: const { a, b } = require('x')
                                for (let i = 0; i < nameNode.namedChildCount; i++) {
                                    const prop = nameNode.namedChild(i);
                                    if (prop.type === 'shorthand_property_identifier_pattern') {
                                        names.push(prop.text);
                                    } else if (prop.type === 'pair_pattern') {
                                        const key = prop.childForFieldName('key');
                                        const val = prop.childForFieldName('value');
                                        if (key) names.push(key.text);
                                        // Track renamed destructuring: const { X: Y } = require(...)
                                        if (key && val && val.text !== key.text) {
                                            if (!importAliases) importAliases = [];
                                            importAliases.push({ original: key.text, local: val.text });
                                        }
                                    }
                                }
                            }
                        }
                    }

                    imports.push({ module: modulePath, names, type: 'require', line, dynamic });
                }
            }

            // Dynamic import: import('x')
            if (funcNode && funcNode.type === 'import') {
                const argsNode = node.childForFieldName('arguments');
                if (argsNode && argsNode.namedChildCount > 0) {
                    const firstArg = argsNode.namedChild(0);
                    const line = node.startPosition.row + 1;
                    if (firstArg && firstArg.type === 'string') {
                        const modulePath = firstArg.text.slice(1, -1);
                        imports.push({ module: modulePath, names: [], type: 'dynamic', line, dynamic: false });
                    } else {
                        imports.push({ module: firstArg ? firstArg.text : null, names: [], type: 'dynamic', line, dynamic: true });
                    }
                }
            }
            return true;
        }

        return true;
    });

    // Attach aliases to the imports array for buildInheritanceGraph resolution
    if (importAliases) imports.aliases = importAliases;
    return imports;
}

/**
 * Find all exports in JavaScript/TypeScript code using tree-sitter AST
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{name: string, type: string, line: number, source?: string}>}
 */
function findExportsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const exports = [];

    traverseTree(tree.rootNode, (node) => {
        // ES6 export statements
        if (node.type === 'export_statement') {
            const line = node.startPosition.row + 1;
            let source = null;

            // Check for re-export source
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'string') {
                    source = child.text.slice(1, -1);
                }
            }

            // Check for export * from 'x'
            if (node.text.includes('export *') && source) {
                exports.push({ name: '*', type: 're-export-all', line, source });
                return true;
            }

            // Check for export clause: export { a, b } or export { a } from 'x'
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'export_clause') {
                    for (let j = 0; j < child.namedChildCount; j++) {
                        const specifier = child.namedChild(j);
                        if (specifier.type === 'export_specifier') {
                            const nameNode = specifier.namedChild(0);
                            if (nameNode) {
                                const exportType = source ? 're-export' : 'named';
                                exports.push({ name: nameNode.text, type: exportType, line, ...(source && { source }) });
                            }
                        }
                    }
                    return true;
                }
            }

            // Named exports: export function/class/const
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'function_declaration' || child.type === 'generator_function_declaration') {
                    const nameNode = child.childForFieldName('name');
                    if (nameNode) {
                        exports.push({ name: nameNode.text, type: 'named', line });
                    }
                } else if (child.type === 'class_declaration') {
                    const nameNode = child.childForFieldName('name');
                    if (nameNode) {
                        exports.push({ name: nameNode.text, type: 'named', line });
                    }
                } else if (child.type === 'type_alias_declaration') {
                    // export type X = ...
                    const nameNode = child.childForFieldName('name');
                    if (nameNode) {
                        exports.push({ name: nameNode.text, type: 'named', line, isTypeExport: true });
                    }
                } else if (child.type === 'interface_declaration') {
                    // export interface X { ... }
                    const nameNode = child.childForFieldName('name');
                    if (nameNode) {
                        exports.push({ name: nameNode.text, type: 'named', line, isTypeExport: true });
                    }
                } else if (child.type === 'enum_declaration') {
                    // export enum X { ... }
                    const nameNode = child.childForFieldName('name');
                    if (nameNode) {
                        exports.push({ name: nameNode.text, type: 'named', line });
                    }
                } else if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
                    // Determine declaration kind from AST (const/let/var)
                    let declKind = 'var';
                    if (child.type === 'lexical_declaration') {
                        const firstChild = child.child(0);
                        if (firstChild) declKind = firstChild.text; // 'const' or 'let'
                    }
                    for (let j = 0; j < child.namedChildCount; j++) {
                        const declarator = child.namedChild(j);
                        if (declarator.type === 'variable_declarator') {
                            const nameNode = declarator.childForFieldName('name');
                            if (nameNode && nameNode.type === 'identifier') {
                                // Extract type annotation from AST (TypeScript)
                                const typeNode = declarator.childForFieldName('type');
                                const typeAnnotation = typeNode ? typeNode.text.replace(/^\s*:\s*/, '') : null;
                                exports.push({ name: nameNode.text, type: 'named', line, isVariable: true, declKind, typeAnnotation });
                            }
                        }
                    }
                } else if (child.type === 'function_expression' || child.type === 'arrow_function' ||
                           child.type === 'class' || child.type === 'identifier') {
                    // export default ...
                    const name = child.type === 'identifier' ? child.text : 'default';
                    exports.push({ name, type: 'default', line });
                }
            }

            // Check for export default with no declaration child found
            if (node.text.startsWith('export default') && exports.filter(e => e.line === line).length === 0) {
                exports.push({ name: 'default', type: 'default', line });
            }

            return true;
        }

        // CommonJS module.exports
        if (node.type === 'assignment_expression') {
            const leftNode = node.childForFieldName('left');
            if (leftNode && leftNode.type === 'member_expression') {
                const objNode = leftNode.childForFieldName('object');
                const propNode = leftNode.childForFieldName('property');

                if (objNode && propNode) {
                    // module.exports = ...
                    if (objNode.text === 'module' && propNode.text === 'exports') {
                        const line = node.startPosition.row + 1;
                        const rightNode = node.childForFieldName('right');
                        if (rightNode && rightNode.type === 'object') {
                            // module.exports = { a, b }
                            for (let i = 0; i < rightNode.namedChildCount; i++) {
                                const prop = rightNode.namedChild(i);
                                if (prop.type === 'shorthand_property_identifier') {
                                    exports.push({ name: prop.text, type: 'module.exports', line });
                                } else if (prop.type === 'pair') {
                                    const key = prop.childForFieldName('key');
                                    if (key) exports.push({ name: key.text, type: 'module.exports', line });
                                }
                            }
                        } else if (rightNode && rightNode.type === 'identifier') {
                            // module.exports = something
                            exports.push({ name: rightNode.text, type: 'module.exports', line });
                        } else {
                            exports.push({ name: 'default', type: 'module.exports', line });
                        }
                        return true;
                    }

                    // exports.name = ...
                    if (objNode.text === 'exports') {
                        const line = node.startPosition.row + 1;
                        exports.push({ name: propNode.text, type: 'exports', line });
                        return true;
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
        // Look for identifier, property_identifier (method names in obj.method() calls),
        // and type_identifier (TypeScript type annotations like `params: MyType`)
        const isIdentifier = node.type === 'identifier' || node.type === 'property_identifier' || node.type === 'type_identifier';
        if (!isIdentifier || node.text !== name) {
            return true;
        }

        const line = node.startPosition.row + 1;
        const column = node.startPosition.column;
        const parent = node.parent;

        // Classify based on parent node
        let usageType = 'reference';

        if (parent) {
            // Import: identifier inside import_specifier or import_clause
            if (parent.type === 'import_specifier' ||
                parent.type === 'import_clause' ||
                parent.type === 'namespace_import') {
                usageType = 'import';
            }
            // Call: identifier is function in call_expression
            else if (parent.type === 'call_expression' &&
                     parent.childForFieldName('function') === node) {
                usageType = 'call';
            }
            // New expression: identifier is constructor
            else if (parent.type === 'new_expression' &&
                     parent.childForFieldName('constructor') === node) {
                usageType = 'call';
            }
            // Definition: function name in declaration
            else if ((parent.type === 'function_declaration' ||
                      parent.type === 'generator_function_declaration') &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: variable name in declarator (left side of =)
            else if (parent.type === 'variable_declarator' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: class name
            else if (parent.type === 'class_declaration' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: method name
            else if (parent.type === 'method_definition' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: function expression name (named function expressions)
            else if (parent.type === 'function' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Require: identifier is the name in require('...')
            else if (parent.type === 'call_expression') {
                const func = parent.childForFieldName('function');
                if (func && func.text === 'require') {
                    // This is inside require(), check if it's the name being assigned
                    const grandparent = parent.parent;
                    if (grandparent && grandparent.type === 'variable_declarator' &&
                        grandparent.childForFieldName('name')?.text === name) {
                        usageType = 'import';
                    }
                }
            }
            // Property access (method call): a.name() - the name after dot
            else if (parent.type === 'member_expression' &&
                     parent.childForFieldName('property') === node) {
                // Skip built-in objects and common module names (JSON.parse, path.parse, etc.)
                const object = parent.childForFieldName('object');
                const builtins = [
                    // JS built-in objects
                    'JSON', 'Math', 'console', 'Object', 'Array', 'String', 'Number', 'Date', 'RegExp', 'Promise', 'Reflect', 'Proxy', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Intl', 'WebAssembly', 'Atomics', 'SharedArrayBuffer', 'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'URL', 'URLSearchParams',
                    // Node.js core modules
                    'path', 'fs', 'os', 'http', 'https', 'net', 'dgram', 'dns', 'tls', 'crypto', 'zlib', 'stream', 'util', 'events', 'buffer', 'child_process', 'cluster', 'readline', 'repl', 'vm', 'assert', 'querystring', 'url', 'punycode', 'string_decoder', 'timers', 'tty', 'v8', 'perf_hooks', 'worker_threads', 'inspector', 'trace_events', 'async_hooks', 'process'
                ];
                if (object && object.type === 'identifier' && builtins.includes(object.text)) {
                    return true; // Skip built-in method calls
                }
                // Check if this is a method call
                const grandparent = parent.parent;
                if (grandparent && grandparent.type === 'call_expression') {
                    usageType = 'call';
                } else {
                    usageType = 'reference';
                }
            }
            // JSX component usage: <Component /> or <Component>...</Component>
            else if (parent.type === 'jsx_self_closing_element' || parent.type === 'jsx_opening_element') {
                usageType = 'call';  // Treat JSX component usage as a "call"
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
    findCallbackUsages,
    findReExports,
    findImportsInCode,
    findExportsInCode,
    findUsagesInCode,
    parse
};
