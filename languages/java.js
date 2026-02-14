/**
 * languages/java.js - Tree-sitter based Java parsing
 *
 * Handles: method declarations, constructors, class/interface/enum/record
 * declarations, and static final constants.
 */

const {
    traverseTree,
    nodeToLocation,
    parseStructuredParams,
    extractJavaDocstring
} = require('./utils');
const { PARSE_OPTIONS, safeParse } = require('./index');

function parseTree(parser, code) {
    return safeParse(parser, code, undefined, PARSE_OPTIONS);
}

/**
 * Extract Java parameters
 */
function extractJavaParams(paramsNode) {
    if (!paramsNode) return '...';
    const text = paramsNode.text;
    let params = text.replace(/^\(|\)$/g, '').trim();
    if (!params) return '...';
    return params;
}

/**
 * Extract modifiers from a node
 */
function extractModifiers(node) {
    const modifiers = [];
    // Try field name first, fall back to finding child by type
    // (class body members may not have 'modifiers' as a field name)
    let modifiersNode = node.childForFieldName('modifiers');
    if (!modifiersNode) {
        for (let i = 0; i < node.namedChildCount; i++) {
            if (node.namedChild(i).type === 'modifiers') {
                modifiersNode = node.namedChild(i);
                break;
            }
        }
    }

    if (modifiersNode) {
        for (let i = 0; i < modifiersNode.namedChildCount; i++) {
            const mod = modifiersNode.namedChild(i);
            if (mod.type === 'marker_annotation' || mod.type === 'annotation') {
                // Store annotation name (without @) as modifier (e.g., @Test -> 'test', @Override -> 'override')
                const annoText = mod.text.replace(/^@/, '').split('(')[0].toLowerCase();
                modifiers.push(annoText);
                continue;
            }
            modifiers.push(mod.text);
        }
    }

    // Also check first line for modifiers
    const text = node.text;
    const firstLine = text.split('\n')[0];
    const keywords = ['public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'native', 'default'];
    for (const kw of keywords) {
        if (firstLine.includes(kw + ' ') && !modifiers.includes(kw)) {
            modifiers.push(kw);
        }
    }

    return [...new Set(modifiers)];
}

/**
 * Extract annotations from a node
 */
function extractAnnotations(node) {
    const annotations = [];
    const modifiersNode = node.childForFieldName('modifiers');

    if (modifiersNode) {
        for (let i = 0; i < modifiersNode.namedChildCount; i++) {
            const mod = modifiersNode.namedChild(i);
            if (mod.type === 'marker_annotation' || mod.type === 'annotation') {
                annotations.push(mod.text);
            }
        }
    }

    return annotations;
}

/**
 * Extract return type from method
 */
function extractReturnType(node) {
    const typeNode = node.childForFieldName('type');
    if (typeNode) {
        return typeNode.text;
    }
    return null;
}

/**
 * Extract generics/type parameters
 */
function extractGenerics(node) {
    const typeParamsNode = node.childForFieldName('type_parameters');
    if (typeParamsNode) {
        return typeParamsNode.text;
    }
    return null;
}

/**
 * Find all methods/constructors in Java code using tree-sitter
 */
function findFunctions(code, parser) {
    const tree = parseTree(parser, code);
    const functions = [];
    const processedRanges = new Set();

    traverseTree(tree.rootNode, (node) => {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;

        // Method declarations
        if (node.type === 'method_declaration') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            // Skip methods inside a class body (they're extracted as class members)
            let parent = node.parent;
            if (parent && parent.type === 'class_body') {
                return true;  // Skip - this is a class method
            }

            const nameNode = node.childForFieldName('name');
            const paramsNode = node.childForFieldName('parameters');

            if (nameNode) {
                const { startLine, endLine, indent } = nodeToLocation(node, code);
                const modifiers = extractModifiers(node);
                const annotations = extractAnnotations(node);
                const returnType = extractReturnType(node);
                const generics = extractGenerics(node);
                const docstring = extractJavaDocstring(code, startLine);
                // nameLine: where the name identifier lives (differs from startLine when annotations are present)
                const nameLine = nameNode.startPosition.row + 1;

                functions.push({
                    name: nameNode.text,
                    params: extractJavaParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'java'),
                    startLine,
                    endLine,
                    indent,
                    modifiers,
                    ...(returnType && { returnType }),
                    ...(generics && { generics }),
                    ...(docstring && { docstring }),
                    ...(annotations.length > 0 && { annotations }),
                    ...(nameLine !== startLine && { nameLine })
                });
            }
            return true;
        }

        // Constructor declarations
        if (node.type === 'constructor_declaration') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            // Skip constructors inside a class body (they're extracted as class members)
            let parent = node.parent;
            if (parent && parent.type === 'class_body') {
                return true;  // Skip - this is a class constructor
            }

            const nameNode = node.childForFieldName('name');
            const paramsNode = node.childForFieldName('parameters');

            if (nameNode) {
                const { startLine, endLine, indent } = nodeToLocation(node, code);
                const modifiers = extractModifiers(node);
                const annotations = extractAnnotations(node);
                const docstring = extractJavaDocstring(code, startLine);
                const nameLine = nameNode.startPosition.row + 1;

                functions.push({
                    name: nameNode.text,
                    params: extractJavaParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'java'),
                    startLine,
                    endLine,
                    indent,
                    modifiers,
                    isConstructor: true,
                    ...(docstring && { docstring }),
                    ...(annotations.length > 0 && { annotations }),
                    ...(nameLine !== startLine && { nameLine })
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
 * Find all classes, interfaces, enums, records in Java code
 */
function findClasses(code, parser) {
    const tree = parseTree(parser, code);
    const classes = [];
    const processedRanges = new Set();

    traverseTree(tree.rootNode, (node) => {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;

        // Class declarations
        if (node.type === 'class_declaration') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(node, code);
                const members = extractClassMembers(node, code);
                const modifiers = extractModifiers(node);
                const annotations = extractAnnotations(node);
                const docstring = extractJavaDocstring(code, startLine);
                const generics = extractGenerics(node);
                const extendsInfo = extractExtends(node);
                const implementsInfo = extractImplements(node);

                // Check if this is a nested/inner class
                let parentNode = node.parent;
                const isNested = parentNode && parentNode.type === 'class_body';

                classes.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    type: 'class',
                    members,
                    modifiers,
                    ...(isNested && { isNested: true }),
                    ...(docstring && { docstring }),
                    ...(generics && { generics }),
                    ...(annotations.length > 0 && { annotations }),
                    ...(extendsInfo && { extends: extendsInfo }),
                    ...(implementsInfo.length > 0 && { implements: implementsInfo })
                });
            }
            // Continue traversal to find inner classes, but members are already extracted
            return true;
        }

        // Interface declarations
        if (node.type === 'interface_declaration') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(node, code);
                const modifiers = extractModifiers(node);
                const annotations = extractAnnotations(node);
                const docstring = extractJavaDocstring(code, startLine);
                const generics = extractGenerics(node);
                const extendsInfo = extractInterfaceExtends(node);

                classes.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    type: 'interface',
                    members: [],
                    modifiers,
                    ...(docstring && { docstring }),
                    ...(generics && { generics }),
                    ...(annotations.length > 0 && { annotations }),
                    ...(extendsInfo.length > 0 && { extends: extendsInfo.join(', ') })
                });
            }
            return false;
        }

        // Enum declarations
        if (node.type === 'enum_declaration') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(node, code);
                const modifiers = extractModifiers(node);
                const annotations = extractAnnotations(node);
                const docstring = extractJavaDocstring(code, startLine);

                classes.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    type: 'enum',
                    members: [],
                    modifiers,
                    ...(docstring && { docstring }),
                    ...(annotations.length > 0 && { annotations })
                });
            }
            return false;
        }

        // Record declarations (Java 14+)
        if (node.type === 'record_declaration') {
            if (processedRanges.has(rangeKey)) return true;
            processedRanges.add(rangeKey);

            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(node, code);
                const modifiers = extractModifiers(node);
                const annotations = extractAnnotations(node);
                const docstring = extractJavaDocstring(code, startLine);
                const generics = extractGenerics(node);

                classes.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    type: 'record',
                    members: [],
                    modifiers,
                    ...(docstring && { docstring }),
                    ...(generics && { generics }),
                    ...(annotations.length > 0 && { annotations })
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
    const superclassNode = classNode.childForFieldName('superclass');
    if (superclassNode) {
        // superclassNode.text includes "extends TypeName", extract just the type
        for (let i = 0; i < superclassNode.namedChildCount; i++) {
            const child = superclassNode.namedChild(i);
            if (child.type === 'type_identifier' || child.type === 'generic_type' || child.type === 'scoped_type_identifier') {
                return child.text;
            }
        }
        // Fallback: strip leading "extends " if present
        const text = superclassNode.text;
        return text.startsWith('extends ') ? text.slice(8) : text;
    }
    return null;
}

/**
 * Extract implements clause from class
 */
function extractImplements(classNode) {
    const interfacesNode = classNode.childForFieldName('interfaces');
    if (interfacesNode) {
        const interfaces = [];
        for (let i = 0; i < interfacesNode.namedChildCount; i++) {
            const iface = interfacesNode.namedChild(i);
            if (iface.type === 'type_identifier' || iface.type === 'generic_type') {
                interfaces.push(iface.text);
            }
        }
        return interfaces;
    }
    return [];
}

/**
 * Extract extends from interface
 */
function extractInterfaceExtends(interfaceNode) {
    const extendsNode = interfaceNode.childForFieldName('extends');
    if (extendsNode) {
        const interfaces = [];
        for (let i = 0; i < extendsNode.namedChildCount; i++) {
            const iface = extendsNode.namedChild(i);
            interfaces.push(iface.text);
        }
        return interfaces;
    }
    return [];
}

/**
 * Extract class members (methods, constructors)
 */
function extractClassMembers(classNode, code) {
    const members = [];
    const bodyNode = classNode.childForFieldName('body');
    if (!bodyNode) return members;

    for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const child = bodyNode.namedChild(i);

        // Method declarations
        if (child.type === 'method_declaration') {
            const nameNode = child.childForFieldName('name');
            const paramsNode = child.childForFieldName('parameters');

            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(child, code);
                const modifiers = extractModifiers(child);
                const returnType = extractReturnType(child);
                const docstring = extractJavaDocstring(code, startLine);
                const nameLine = nameNode.startPosition.row + 1;

                let memberType = 'method';
                if (modifiers.includes('static')) {
                    memberType = 'static';
                } else if (modifiers.includes('abstract')) {
                    memberType = 'abstract';
                }

                members.push({
                    name: nameNode.text,
                    params: extractJavaParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'java'),
                    startLine,
                    endLine,
                    memberType,
                    modifiers,
                    isMethod: true,  // Mark as method for context() lookups
                    ...(returnType && { returnType }),
                    ...(docstring && { docstring }),
                    ...(nameLine !== startLine && { nameLine })
                });
            }
        }

        // Constructor declarations
        if (child.type === 'constructor_declaration') {
            const nameNode = child.childForFieldName('name');
            const paramsNode = child.childForFieldName('parameters');

            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(child, code);
                const modifiers = extractModifiers(child);
                const docstring = extractJavaDocstring(code, startLine);
                const nameLine = nameNode.startPosition.row + 1;

                members.push({
                    name: nameNode.text,
                    params: extractJavaParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'java'),
                    startLine,
                    endLine,
                    memberType: 'constructor',
                    modifiers,
                    isMethod: true,  // Mark as method for context() lookups
                    ...(docstring && { docstring }),
                    ...(nameLine !== startLine && { nameLine })
                });
            }
        }
    }

    return members;
}

/**
 * Find state objects (static final constants) in Java code
 */
function findStateObjects(code, parser) {
    const tree = parseTree(parser, code);
    const objects = [];

    const statePattern = /^([A-Z][A-Z0-9_]+|[A-Z][a-zA-Z]*(?:CONFIG|SETTINGS|OPTIONS))$/;

    traverseTree(tree.rootNode, (node) => {
        if (node.type === 'field_declaration') {
            const modifiers = extractModifiers(node);
            if (modifiers.includes('static') && modifiers.includes('final')) {
                for (let i = 0; i < node.namedChildCount; i++) {
                    const child = node.namedChild(i);
                    if (child.type === 'variable_declarator') {
                        const nameNode = child.childForFieldName('name');
                        const valueNode = child.childForFieldName('value');

                        if (nameNode && valueNode) {
                            const name = nameNode.text;
                            if (statePattern.test(name)) {
                                const { startLine, endLine } = nodeToLocation(node, code);
                                objects.push({ name, startLine, endLine });
                            }
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
 * Parse a Java file completely
 */
function parse(code, parser) {
    return {
        language: 'java',
        totalLines: code.split('\n').length,
        functions: findFunctions(code, parser),
        classes: findClasses(code, parser),
        stateObjects: findStateObjects(code, parser),
        imports: [],
        exports: []
    };
}

/**
 * Find all function/method calls in Java code using tree-sitter AST
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{name: string, line: number, isMethod: boolean, receiver?: string, isConstructor?: boolean}>}
 */
function findCallsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const calls = [];
    const functionStack = [];  // Stack of { name, startLine, endLine }

    // Helper to check if a node creates a function scope
    const isFunctionNode = (node) => {
        return ['method_declaration', 'constructor_declaration', 'lambda_expression'].includes(node.type);
    };

    // Helper to extract function name from a function node
    const extractFunctionName = (node) => {
        if (node.type === 'method_declaration') {
            const nameNode = node.childForFieldName('name');
            return nameNode?.text || '<anonymous>';
        }
        if (node.type === 'constructor_declaration') {
            const nameNode = node.childForFieldName('name');
            return nameNode?.text || '<constructor>';
        }
        if (node.type === 'lambda_expression') {
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
            functionStack.push({
                name: extractFunctionName(node),
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1
            });
        }

        // Handle method invocations: foo(), obj.foo(), this.foo()
        if (node.type === 'method_invocation') {
            const nameNode = node.childForFieldName('name');
            const objNode = node.childForFieldName('object');

            if (nameNode) {
                const enclosingFunction = getCurrentEnclosingFunction();
                calls.push({
                    name: nameNode.text,
                    line: node.startPosition.row + 1,
                    isMethod: !!objNode,
                    receiver: (objNode?.type === 'identifier' || objNode?.type === 'this') ? objNode.text : undefined,
                    enclosingFunction
                });
            }
            return true;
        }

        // Handle constructor calls: new Foo(), new pkg.Bar()
        if (node.type === 'object_creation_expression') {
            const typeNode = node.childForFieldName('type');
            if (typeNode) {
                let typeName = typeNode.text;
                // Handle generic types like List<String>
                const genericIdx = typeName.indexOf('<');
                if (genericIdx > 0) {
                    typeName = typeName.substring(0, genericIdx);
                }
                // Handle qualified names like pkg.Class
                const dotIdx = typeName.lastIndexOf('.');
                if (dotIdx > 0) {
                    typeName = typeName.substring(dotIdx + 1);
                }

                const enclosingFunction = getCurrentEnclosingFunction();
                calls.push({
                    name: typeName,
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    isConstructor: true,
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
 * Find all imports in Java code using tree-sitter AST
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{module: string, names: string[], type: string, line: number}>}
 */
function findImportsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const imports = [];

    traverseTree(tree.rootNode, (node) => {
        if (node.type === 'import_declaration') {
            const line = node.startPosition.row + 1;
            let modulePath = null;
            let isStatic = node.text.includes('import static');
            let isWildcard = false;

            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'scoped_identifier' || child.type === 'identifier') {
                    modulePath = child.text;
                } else if (child.type === 'asterisk') {
                    isWildcard = true;
                }
            }

            if (modulePath) {
                const segments = modulePath.split('.');
                const name = isWildcard ? '*' : segments[segments.length - 1];
                imports.push({
                    module: modulePath + (isWildcard ? '.*' : ''),
                    names: [name],
                    type: isStatic ? 'static' : 'import',
                    line
                });
            }
            return true;
        }

        return true;
    });

    return imports;
}

/**
 * Find all exports in Java code using tree-sitter AST
 * In Java, public classes/interfaces/enums are exports
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{name: string, type: string, line: number}>}
 */
function findExportsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const exports = [];

    function isPublic(node) {
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child.type === 'modifiers' && child.text.includes('public')) {
                return true;
            }
        }
        return false;
    }

    traverseTree(tree.rootNode, (node) => {
        // Public classes
        if (node.type === 'class_declaration' && isPublic(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                exports.push({
                    name: nameNode.text,
                    type: 'class',
                    line: node.startPosition.row + 1
                });
            }
            return false; // Don't descend into class body
        }

        // Public interfaces
        if (node.type === 'interface_declaration' && isPublic(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                exports.push({
                    name: nameNode.text,
                    type: 'interface',
                    line: node.startPosition.row + 1
                });
            }
            return false;
        }

        // Public enums
        if (node.type === 'enum_declaration' && isPublic(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                exports.push({
                    name: nameNode.text,
                    type: 'enum',
                    line: node.startPosition.row + 1
                });
            }
            return false;
        }

        // Public records (Java 14+)
        if (node.type === 'record_declaration' && isPublic(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                exports.push({
                    name: nameNode.text,
                    type: 'record',
                    line: node.startPosition.row + 1
                });
            }
            return false;
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
        // Look for identifiers and type_identifiers with the matching name
        // type_identifier is used in Java for type references: new ClassName(), extends ClassName, field types
        if ((node.type !== 'identifier' && node.type !== 'type_identifier') || node.text !== name) {
            return true;
        }

        const line = node.startPosition.row + 1;
        const column = node.startPosition.column;
        const parent = node.parent;

        let usageType = 'reference';

        if (parent) {
            // Import: part of import declaration
            if (parent.type === 'scoped_identifier' ||
                parent.type === 'import_declaration') {
                // Check if we're inside an import
                let n = parent;
                while (n) {
                    if (n.type === 'import_declaration') {
                        usageType = 'import';
                        break;
                    }
                    n = n.parent;
                }
            }
            // Call: method_invocation with name field
            else if (parent.type === 'method_invocation' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'call';
            }
            // Definition: method name
            else if (parent.type === 'method_declaration' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: class name
            else if (parent.type === 'class_declaration' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: interface name
            else if (parent.type === 'interface_declaration' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: enum name
            else if (parent.type === 'enum_declaration' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: constructor
            else if (parent.type === 'constructor_declaration' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: local variable
            else if (parent.type === 'variable_declarator' &&
                     parent.childForFieldName('name') === node) {
                usageType = 'definition';
            }
            // Definition: parameter
            else if (parent.type === 'formal_parameter' ||
                     parent.type === 'spread_parameter') {
                usageType = 'definition';
            }
            // Definition: field
            else if (parent.type === 'field_declaration') {
                usageType = 'definition';
            }
            // Object creation: new ClassName()
            else if (parent.type === 'object_creation_expression') {
                const typeNode = parent.childForFieldName('type');
                if (typeNode === node || typeNode?.text === name) {
                    usageType = 'call';
                }
            }
            // Static method call: ClassName.staticMethod() — ClassName is the object
            else if (parent.type === 'method_invocation' &&
                     parent.childForFieldName('object') === node) {
                usageType = 'call';
            }
            // Field access: obj.field
            else if (parent.type === 'field_access' &&
                     parent.childForFieldName('field') === node) {
                usageType = 'reference';
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
