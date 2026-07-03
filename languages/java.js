/**
 * languages/java.js - Tree-sitter based Java parsing
 *
 * Handles: method declarations, constructors, class/interface/enum/record
 * declarations, and static final constants.
 */

const {
    traverseTree,
    traverseTreeCached,
    nodeToLocation,
    parseStructuredParams,
    extractJavaDocstring,
    visitNameNodes,
    sameNode,
} = require('./utils');
const { PARSE_OPTIONS, safeParse } = require('./index');

function parseTree(parser, code) {
    return safeParse(parser, code, undefined, PARSE_OPTIONS);
}

/**
 * Extract Java parameters
 */
function extractJavaParams(paramsNode) {
    // Distinguish "we have no node" (genuinely unknown) from "node is empty".
    // Returning '...' for empty parens conflated zero-param methods with
    // unknown signatures in JSON output (fix #241; go/rust got this in #238,
    // the shared utils.extractParams already had it).
    if (!paramsNode) return '...';
    const text = paramsNode.text;
    let params = text.replace(/^\(|\)$/g, '').trim();
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
                // Skip noise annotations that don't carry semantic meaning
                const SKIP_ANNOTATIONS = new Set(['suppresswarnings', 'safevarargs', 'serial', 'generated']);
                if (!SKIP_ANNOTATIONS.has(annoText)) {
                    modifiers.push(annoText);
                }
                continue;
            }
            modifiers.push(mod.text);
        }
    }

    // Also check text before the parameter list (methods) or the class body
    // opening brace (classes/interfaces). Without this scope, the fallback
    // would scan into field declarations and leak `private`/`final` from the
    // body up onto the class signature.
    const text = node.text;
    const paramsNode = node.childForFieldName('parameters');
    const bodyNode = node.childForFieldName('body');
    let preParams;
    if (paramsNode) {
        preParams = text.substring(0, paramsNode.startIndex - node.startIndex);
    } else if (bodyNode) {
        preParams = text.substring(0, bodyNode.startIndex - node.startIndex);
    } else {
        // Last-resort fallback: only the first line. Class bodies start on
        // their own line nearly always, so this avoids leaking field modifiers.
        const firstLine = text.split('\n')[0] || '';
        preParams = firstLine;
    }
    const keywords = ['public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'native', 'default'];
    for (const kw of keywords) {
        if (preParams.includes(kw + ' ') && !modifiers.includes(kw)) {
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
 * Extract annotations along with their string-literal first argument.
 * Returns array of { name, args: string|null, firstStringArg: string|null }.
 *   @GetMapping("/users/{id}")  →  { name: 'GetMapping', args: '"/users/{id}"', firstStringArg: '/users/{id}' }
 *   @Override                   →  { name: 'Override', args: null, firstStringArg: null }
 *   @RequestMapping(value = "/api", method = RequestMethod.GET)
 *                               →  { name: 'RequestMapping', args: 'value = "/api", method = RequestMethod.GET',
 *                                    firstStringArg: '/api' }
 *
 * @param {Node} node - Method/class node
 * @returns {Array<{name: string, args: string|null, firstStringArg: string|null}>}
 */
function extractAnnotationsWithArgs(node) {
    const result = [];
    const modifiersNode = node.childForFieldName('modifiers') || (() => {
        for (let i = 0; i < node.namedChildCount; i++) {
            if (node.namedChild(i).type === 'modifiers') return node.namedChild(i);
        }
        return null;
    })();
    if (!modifiersNode) return result;

    for (let i = 0; i < modifiersNode.namedChildCount; i++) {
        const mod = modifiersNode.namedChild(i);
        if (mod.type === 'marker_annotation') {
            // @Override (no args)
            const nameNode = mod.childForFieldName('name');
            if (nameNode) {
                result.push({ name: nameNode.text, args: null, firstStringArg: null });
            }
        } else if (mod.type === 'annotation') {
            const nameNode = mod.childForFieldName('name');
            const argsNode = mod.childForFieldName('arguments');
            const name = nameNode ? nameNode.text : null;
            const argsRaw = argsNode ? argsNode.text.replace(/^\(|\)$/g, '') : null;
            // Find first string-literal arg (handles positional and value=... patterns)
            let firstStringArg = null;
            if (argsNode) {
                // Walk children: positional string_literal OR element_value_pair with key 'value'
                for (let j = 0; j < argsNode.namedChildCount; j++) {
                    const child = argsNode.namedChild(j);
                    if (child.type === 'string_literal') {
                        firstStringArg = stripJavaString(child.text);
                        break;
                    }
                    if (child.type === 'element_value_pair') {
                        const key = child.childForFieldName('key');
                        const value = child.childForFieldName('value');
                        if (key?.text === 'value' && value?.type === 'string_literal') {
                            firstStringArg = stripJavaString(value.text);
                            break;
                        }
                    }
                }
                // Fallback: first string_literal anywhere in subtree (handles path = "/x")
                if (!firstStringArg) {
                    const m = argsNode.text.match(/"([^"\\]|\\.)*"/);
                    if (m) firstStringArg = m[0].slice(1, -1);
                }
            }
            if (name) {
                result.push({ name, args: argsRaw, firstStringArg });
            }
        }
    }
    return result;
}

function stripJavaString(text) {
    if (!text) return text;
    if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
    return text;
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
 * Process a node for function/method extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 */
function _processFunction(node, functions, processedRanges, lines, code) {
    // Method declarations
    if (node.type === 'method_declaration') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;
        processedRanges.add(rangeKey);

        // Skip methods inside a class/interface/enum body (they're extracted as class members)
        let parent = node.parent;
        if (parent && (parent.type === 'class_body' || parent.type === 'interface_body' || parent.type === 'enum_body' || parent.type === 'enum_body_declarations')) {
            return true;  // Skip - this is a class/interface/enum method
        }

        const nameNode = node.childForFieldName('name');
        const paramsNode = node.childForFieldName('parameters');

        if (nameNode) {
            const { startLine, endLine, indent } = nodeToLocation(node, lines);
            const modifiers = extractModifiers(node);
            const annotations = extractAnnotations(node);
            const annotationsWithArgs = extractAnnotationsWithArgs(node);
            const returnType = extractReturnType(node);
            const generics = extractGenerics(node);
            const docstring = extractJavaDocstring(lines, startLine);
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
                ...(annotationsWithArgs.length > 0 && { annotationsWithArgs }),
                ...(nameLine !== startLine && { nameLine })
            });
        }
        return true;
    }

    // Constructor declarations
    if (node.type === 'constructor_declaration') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;
        processedRanges.add(rangeKey);

        // Skip constructors inside a class/enum body (they're extracted as class members)
        let parent = node.parent;
        if (parent && (parent.type === 'class_body' || parent.type === 'enum_body' || parent.type === 'enum_body_declarations')) {
            return true;  // Skip - this is a class/enum constructor
        }

        const nameNode = node.childForFieldName('name');
        const paramsNode = node.childForFieldName('parameters');

        if (nameNode) {
            const { startLine, endLine, indent } = nodeToLocation(node, lines);
            const modifiers = extractModifiers(node);
            const annotations = extractAnnotations(node);
            const annotationsWithArgs = extractAnnotationsWithArgs(node);
            const docstring = extractJavaDocstring(lines, startLine);
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

    return false;
}

/**
 * Find all methods/constructors in Java code using tree-sitter
 */
function findFunctions(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const functions = [];
    const processedRanges = new Set();

    traverseTreeCached(tree.rootNode, (node) => {
        _processFunction(node, functions, processedRanges, lines, code);
        return true;
    });

    functions.sort((a, b) => a.startLine - b.startLine);
    return functions;
}

/**
 * Process a node for class/interface/enum/record extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 */
function _processClass(node, classes, processedRanges, lines, code) {
    // Class declarations
    if (node.type === 'class_declaration') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;
        processedRanges.add(rangeKey);

        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const { startLine, endLine } = nodeToLocation(node, lines);
            const members = extractClassMembers(node, lines);
            const modifiers = extractModifiers(node);
            const annotations = extractAnnotations(node);
            const annotationsWithArgs = extractAnnotationsWithArgs(node);
            const docstring = extractJavaDocstring(lines, startLine);
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
                ...(annotationsWithArgs.length > 0 && { annotationsWithArgs }),
                ...(extendsInfo && { extends: extendsInfo }),
                ...(implementsInfo.length > 0 && { implements: implementsInfo })
            });
        }
        return true;
    }

    // Interface declarations
    if (node.type === 'interface_declaration') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;
        processedRanges.add(rangeKey);

        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const { startLine, endLine } = nodeToLocation(node, lines);
            const modifiers = extractModifiers(node);
            const annotations = extractAnnotations(node);
            const annotationsWithArgs = extractAnnotationsWithArgs(node);
            const docstring = extractJavaDocstring(lines, startLine);
            const generics = extractGenerics(node);
            const extendsInfo = extractInterfaceExtends(node);

            classes.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'interface',
                members: extractClassMembers(node, lines),
                modifiers,
                ...(docstring && { docstring }),
                ...(generics && { generics }),
                ...(annotations.length > 0 && { annotations }),
                ...(annotationsWithArgs.length > 0 && { annotationsWithArgs }),
                ...(extendsInfo.length > 0 && { extends: extendsInfo.join(', ') })
            });
        }
        return true;
    }

    // Enum declarations
    if (node.type === 'enum_declaration') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;
        processedRanges.add(rangeKey);

        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const { startLine, endLine } = nodeToLocation(node, lines);
            const modifiers = extractModifiers(node);
            const annotations = extractAnnotations(node);
            const annotationsWithArgs = extractAnnotationsWithArgs(node);
            const docstring = extractJavaDocstring(lines, startLine);

            classes.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'enum',
                members: extractEnumConstants(node, lines),
                modifiers,
                ...(docstring && { docstring }),
                ...(annotations.length > 0 && { annotations })
            });
        }
        return true;
    }

    // Record declarations (Java 14+)
    if (node.type === 'record_declaration') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;
        processedRanges.add(rangeKey);

        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const { startLine, endLine } = nodeToLocation(node, lines);
            const modifiers = extractModifiers(node);
            const annotations = extractAnnotations(node);
            const annotationsWithArgs = extractAnnotationsWithArgs(node);
            const docstring = extractJavaDocstring(lines, startLine);
            const generics = extractGenerics(node);
            const implementsInfo = extractImplements(node);

            // Extract record components as members
            const members = extractClassMembers(node, lines);
            // Also extract record components from formal_parameters
            const paramsNode = node.childForFieldName('parameters');
            if (paramsNode) {
                for (let pi = 0; pi < paramsNode.namedChildCount; pi++) {
                    const param = paramsNode.namedChild(pi);
                    if (param.type === 'formal_parameter' || param.type === 'spread_parameter') {
                        const pName = param.childForFieldName('name');
                        const pType = param.childForFieldName('type');
                        if (pName) {
                            const { startLine: pLine, endLine: pEnd } = nodeToLocation(param, lines);
                            members.push({
                                name: pName.text,
                                startLine: pLine,
                                endLine: pEnd,
                                memberType: 'field',
                                ...(pType && { fieldType: pType.text })
                            });
                        }
                    }
                }
            }

            classes.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'record',
                members,
                modifiers,
                ...(docstring && { docstring }),
                ...(generics && { generics }),
                ...(annotations.length > 0 && { annotations }),
                ...(implementsInfo.length > 0 && { implements: implementsInfo })
            });
        }
        return true;
    }

    return false;
}

/**
 * Find all classes, interfaces, enums, records in Java code
 */
function findClasses(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const classes = [];
    const processedRanges = new Set();

    traverseTreeCached(tree.rootNode, (node) => {
        _processClass(node, classes, processedRanges, lines, code);
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
            } else if (iface.type === 'type_list') {
                // Records and some class declarations wrap interfaces in a type_list
                for (let j = 0; j < iface.namedChildCount; j++) {
                    const inner = iface.namedChild(j);
                    if (inner.type === 'type_identifier' || inner.type === 'generic_type') {
                        interfaces.push(inner.text);
                    }
                }
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
 * Extract enum constants from enum body
 */
function extractEnumConstants(enumNode, codeOrLines) {
    const code = codeOrLines;
    const constants = [];
    const bodyNode = enumNode.childForFieldName('body');
    if (!bodyNode) return constants;

    for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const child = bodyNode.namedChild(i);
        if (child.type === 'enum_constant') {
            const nameNode = child.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(child, code);
                const argsNode = child.childForFieldName('arguments');
                constants.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    memberType: 'constant',
                    // JLS: enum constants are implicitly public static final
                    // (fix #251 — api omitted them for lack of a modifier).
                    modifiers: ['public', 'static', 'final'],
                    ...(argsNode && { params: argsNode.text.slice(1, -1) })
                });
            }
        }
    }

    // Also extract methods from enum_body_declarations
    if (bodyNode) {
        for (let i = 0; i < bodyNode.namedChildCount; i++) {
            const child = bodyNode.namedChild(i);
            if (child.type === 'enum_body_declarations') {
                for (let j = 0; j < child.namedChildCount; j++) {
                    const member = child.namedChild(j);
                    if (member.type === 'method_declaration') {
                        const nameNode = member.childForFieldName('name');
                        const paramsNode = member.childForFieldName('parameters');
                        if (nameNode) {
                            const { startLine, endLine } = nodeToLocation(member, code);
                            const modifiers = extractModifiers(member);
                            const returnType = extractReturnType(member);
                            constants.push({
                                name: nameNode.text,
                                params: extractJavaParams(paramsNode),
                                paramsStructured: parseStructuredParams(paramsNode, 'java'),
                                startLine,
                                endLine,
                                memberType: modifiers.includes('static') ? 'static' : 'method',
                                modifiers,
                                isMethod: true,
                                ...(returnType && { returnType })
                            });
                        }
                    } else if (member.type === 'constructor_declaration') {
                        const nameNode = member.childForFieldName('name');
                        const paramsNode = member.childForFieldName('parameters');
                        if (nameNode) {
                            const { startLine, endLine } = nodeToLocation(member, code);
                            const modifiers = extractModifiers(member);
                            constants.push({
                                name: nameNode.text,
                                params: extractJavaParams(paramsNode),
                                // paramsStructured drives verify's arg-check
                                // (fix #230 — enum constant args LOW(1) were
                                // checked against an empty list).
                                paramsStructured: parseStructuredParams(paramsNode, 'java'),
                                startLine,
                                endLine,
                                memberType: 'constructor',
                                modifiers,
                                isMethod: true
                            });
                        }
                    }
                }
            }
        }
    }

    return constants;
}

/**
 * Extract class members (methods, constructors)
 */
function extractClassMembers(classNode, codeOrLines) {
    const code = codeOrLines;
    const members = [];
    const bodyNode = classNode.childForFieldName('body');
    if (!bodyNode) return members;
    const isInterface = bodyNode.type === 'interface_body';

    for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const child = bodyNode.namedChild(i);

        // Method declarations
        if (child.type === 'method_declaration') {
            const nameNode = child.childForFieldName('name');
            const paramsNode = child.childForFieldName('parameters');

            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(child, code);
                const modifiers = extractModifiers(child);
                const annotationsWithArgs = extractAnnotationsWithArgs(child);
                // Interface methods are implicitly public and abstract in Java
                if (isInterface) {
                    if (!modifiers.includes('public')) modifiers.push('public');
                    if (!modifiers.includes('abstract') && !modifiers.includes('default') && !modifiers.includes('static')) {
                        modifiers.push('abstract');
                    }
                }
                const returnType = extractReturnType(child);
                const docstring = extractJavaDocstring(code, startLine);
                const nameLine = nameNode.startPosition.row + 1;

                let memberType = 'method';
                if (modifiers.includes('static')) {
                    memberType = 'static';
                } else if (modifiers.includes('abstract')) {
                    memberType = 'abstract';
                }

                const memberGenerics = extractGenerics(child);
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
                    ...(annotationsWithArgs.length > 0 && { annotationsWithArgs }),
                    ...(nameLine !== startLine && { nameLine }),
                    // Method-level type params (fix #229): generic-param receiver
                    // types inside the method resolve against this declaration.
                    ...(memberGenerics && { generics: memberGenerics })
                });
            }
        }

        // Constructor declarations: intentionally NOT emitted as separate class
        // members. The class itself is the symbol; `new Foo(...)` calls resolve
        // to the class via `isConstructor: true` on the call. Emitting the
        // constructor as a member would create duplicate `find Foo` results
        // (one for class, one for constructor), forcing users to disambiguate.
        // Constructor signature info (params, line) remains accessible by reading
        // the class body when needed (e.g. via verify's AST walk).

        // Field declarations: declared types drive receiver disambiguation
        // (fix #202) — Rust/Go already emit field members with fieldType.
        if (child.type === 'field_declaration') {
            const typeNode = child.childForFieldName('type');
            const fieldTypeText = typeNode ? typeNode.text : null;
            // Visibility travels with the member (fix #251 — public
            // instance fields were invisible to api/fileExports because
            // the member had no modifiers for the #240 discipline to read;
            // the #241 Rust-field twin).
            const fieldModifiers = extractModifiers(child);
            for (let j = 0; j < child.namedChildCount; j++) {
                const decl = child.namedChild(j);
                if (decl.type === 'variable_declarator') {
                    const nameNode = decl.childForFieldName('name');
                    if (nameNode && fieldTypeText) {
                        const { startLine, endLine } = nodeToLocation(child, code);
                        members.push({
                            name: nameNode.text,
                            startLine,
                            endLine,
                            memberType: 'field',
                            ...(fieldModifiers.length > 0 && { modifiers: fieldModifiers }),
                            fieldType: fieldTypeText
                        });
                    }
                }
            }
        }
    }

    return members;
}

const _statePattern = /^([A-Z][A-Z0-9_]+|[A-Z][a-zA-Z]*(?:CONFIG|SETTINGS|OPTIONS))$/;

/**
 * Process a node for state object extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 */
function _processState(node, objects, lines, code) {
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
                        if (_statePattern.test(name)) {
                            const { startLine, endLine } = nodeToLocation(node, lines);
                            objects.push({ name, startLine, endLine, modifiers });
                        }
                    }
                }
            }
        }
        return true;
    }

    return false;
}

/**
 * Find state objects (static final constants) in Java code
 */
function findStateObjects(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const objects = [];

    traverseTreeCached(tree.rootNode, (node) => {
        _processState(node, objects, lines, code);
        return true;
    });

    objects.sort((a, b) => a.startLine - b.startLine);
    return objects;
}

/**
 * Parse a Java file completely
 */
function parse(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const functions = [];
    const classes = [];
    const stateObjects = [];
    const processedFn = new Set();
    const processedCls = new Set();

    traverseTreeCached(tree.rootNode, (node) => {
        _processFunction(node, functions, processedFn, lines, code);
        _processClass(node, classes, processedCls, lines, code);
        _processState(node, stateObjects, lines, code);
        return true;
    });

    functions.sort((a, b) => a.startLine - b.startLine);
    classes.sort((a, b) => a.startLine - b.startLine);
    stateObjects.sort((a, b) => a.startLine - b.startLine);

    return {
        language: 'java',
        totalLines: lines.length,
        functions,
        classes,
        stateObjects,
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
    // Track variable -> type mappings per function scope (scopeStartLine -> Map<varName, typeName>)
    const scopeTypes = new Map();

    // Helper: extract first string-arg literal from a method_invocation node.
    // Used by route extraction to capture path arg of webClient.uri("/users") etc.
    const { extractStringArg: _extractStringArg } = require('./utils');
    const getFirstStringArg = (callNode) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return null;
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type === 'comment') continue;
            return _extractStringArg(arg);
        }
        return null;
    };

    // Helper to check if a node creates a function scope
    const isFunctionNode = (node) => {
        return ['method_declaration', 'constructor_declaration', 'lambda_expression'].includes(node.type);
    };

    // Extract type name from a Java type node (strips generics, qualified names)
    const extractTypeName = (typeNode) => {
        if (!typeNode) return null;
        if (typeNode.type === 'type_identifier') return typeNode.text;
        if (typeNode.type === 'generic_type') {
            // List<String> -> List (first named child is the base type)
            for (let i = 0; i < typeNode.namedChildCount; i++) {
                const r = extractTypeName(typeNode.namedChild(i));
                if (r) return r;
            }
        }
        if (typeNode.type === 'scoped_type_identifier') {
            // pkg.Type -> Type (last identifier)
            const nameNode = typeNode.childForFieldName('name') ||
                typeNode.namedChild(typeNode.namedChildCount - 1);
            return nameNode?.text || null;
        }
        if (typeNode.type === 'array_type') {
            return extractTypeName(typeNode.namedChild(0));
        }
        return null;
    };

    // Build type map from method/constructor parameters
    const buildScopeTypeMap = (node) => {
        const typeMap = new Map();
        const paramsNode = node.childForFieldName('parameters');
        if (paramsNode) {
            for (let i = 0; i < paramsNode.namedChildCount; i++) {
                const param = paramsNode.namedChild(i);
                if (param.type === 'formal_parameter' || param.type === 'spread_parameter') {
                    const nameNode = param.childForFieldName('name');
                    const typeNode = param.childForFieldName('type');
                    const typeName = extractTypeName(typeNode);
                    if (nameNode && typeName) {
                        typeMap.set(nameNode.text, typeName);
                    }
                }
            }
        }
        return typeMap;
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

    // Look up variable type from scope chain
    const getReceiverType = (varName) => {
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const typeMap = scopeTypes.get(functionStack[i].startLine);
            if (typeMap?.has(varName)) return typeMap.get(varName);
        }
        return undefined;
    };

    // Variable receiving this call's result (fix #207 return-type flow):
    // `var x = find();` / `x = find();` → 'x'. Declared-type locals are
    // already typed directly above — this covers `var` and reassignment,
    // letting findCallers type x from the producer's declared return type.
    const assignmentTargetOf = (callNode) => {
        const p = callNode.parent;
        if (p?.type === 'variable_declarator') {
            const value = p.childForFieldName('value');
            const nameNode = p.childForFieldName('name');
            if (value && value.id === callNode.id && nameNode?.type === 'identifier') return nameNode.text;
        }
        if (p?.type === 'assignment_expression') {
            const right = p.childForFieldName('right');
            const left = p.childForFieldName('left');
            if (right && right.id === callNode.id && left?.type === 'identifier') return left.text;
        }
        return undefined;
    };

    // All names declared anywhere in a function body (locals, for/catch/lambda
    // params). Guard for fix #202: a bare identifier receiver is only treated
    // as an implicit-this field when NO local of that name is declared —
    // mistyping a shadowed local could wrongly exclude a true caller.
    const scopeDeclared = new Map();
    const collectDeclaredNames = (fnNode) => {
        const declared = new Set();
        const walk = (n) => {
            for (let i = 0; i < n.namedChildCount; i++) {
                const c = n.namedChild(i);
                if (c.type === 'variable_declarator' ||
                    c.type === 'enhanced_for_statement' ||
                    c.type === 'catch_formal_parameter') {
                    const nn = c.childForFieldName('name');
                    if (nn) declared.add(nn.text);
                } else if (c.type === 'lambda_expression') {
                    const params = c.childForFieldName('parameters');
                    if (params?.type === 'identifier') declared.add(params.text);
                    else if (params) {
                        for (let j = 0; j < params.namedChildCount; j++) {
                            const pc = params.namedChild(j);
                            if (pc.type === 'identifier') declared.add(pc.text);
                            else {
                                const pn = pc.childForFieldName('name');
                                if (pn) declared.add(pn.text);
                            }
                        }
                    }
                }
                walk(c);
            }
        };
        walk(fnNode);
        return declared;
    };
    const isDeclaredLocal = (varName) => {
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const declared = scopeDeclared.get(functionStack[i].startLine);
            if (declared?.has(varName)) return true;
        }
        return false;
    };

    // Nearest enclosing class/interface/enum/record name (for implicit-this fields)
    const findEnclosingClassName = (n) => {
        for (let p = n.parent; p; p = p.parent) {
            if (p.type === 'class_declaration' || p.type === 'interface_declaration' ||
                p.type === 'enum_declaration' || p.type === 'record_declaration') {
                return p.childForFieldName('name')?.text;
            }
        }
        return undefined;
    };

    // Call-site argument shape: count + per-arg static kind. Kinds feed the
    // overload discipline in findCallers (Java is the only supported language
    // with arity/type overloading): literal kinds can prove a call binds a
    // DIFFERENT same-class overload than the pinned one. Unknown args are
    // 'expr' — never evidence.
    const bareTypeName = (text) => {
        let t = text;
        const g = t.indexOf('<');
        if (g > 0) t = t.substring(0, g);
        const d = t.lastIndexOf('.');
        if (d >= 0) t = t.substring(d + 1);
        return t.trim();
    };
    const argKindOf = (arg) => {
        switch (arg.type) {
            case 'string_literal': return 'string';
            case 'character_literal': return 'char';
            case 'decimal_integer_literal':
            case 'hex_integer_literal':
            case 'octal_integer_literal':
            case 'binary_integer_literal':
                return /[lL]$/.test(arg.text) ? 'long' : 'int';
            case 'decimal_floating_point_literal':
            case 'hex_floating_point_literal':
                return /[fF]$/.test(arg.text) ? 'float' : 'double';
            case 'true':
            case 'false': return 'boolean';
            case 'null_literal': return 'null';
            case 'object_creation_expression': {
                const tn = arg.childForFieldName('type');
                return tn ? `new:${bareTypeName(tn.text)}` : 'expr';
            }
            case 'cast_expression': {
                const tn = arg.childForFieldName('type');
                return tn ? `cast:${bareTypeName(tn.text)}` : 'expr';
            }
            case 'lambda_expression':
            case 'method_reference': return 'lambda';
            case 'unary_expression':
                // -1, -2.5 — numeric literal kinds survive negation
                return arg.namedChildCount === 1 ? argKindOf(arg.namedChild(0)) : 'expr';
            default: return 'expr';
        }
    };
    const getCallArgs = (callNode) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return { argCount: 0, argKinds: null };
        const kinds = [];
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type === 'comment') continue;
            kinds.push(argKindOf(arg));
        }
        return { argCount: kinds.length, argKinds: kinds.some(k => k !== 'expr') ? kinds : null };
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
            scopeTypes.set(entry.startLine, buildScopeTypeMap(node));
            scopeDeclared.set(entry.startLine, collectDeclaredNames(node));
        }

        // Handle method invocations: foo(), obj.foo(), this.foo()
        if (node.type === 'method_invocation') {
            const nameNode = node.childForFieldName('name');
            const objNode = node.childForFieldName('object');

            if (nameNode) {
                const enclosingFunction = getCurrentEnclosingFunction();
                const receiver = (objNode?.type === 'identifier' || objNode?.type === 'this') ? objNode.text : undefined;
                const receiverType = (receiver && receiver !== 'this') ? getReceiverType(receiver) : undefined;
                // fix #202: one-hop declared-field receivers —
                // this.service.execute(), svc.client.run(), and bare
                // service.execute() where service is a class field (only when
                // no same-named local is declared anywhere in the method).
                let receiverRoot, receiverFieldName, receiverRootType;
                if (objNode && !receiverType) {
                    if (objNode.type === 'field_access') {
                        const rootNode = objNode.childForFieldName('object');
                        const fldNode = objNode.childForFieldName('field');
                        if (fldNode?.type === 'identifier' && rootNode) {
                            if (rootNode.type === 'this') {
                                receiverRoot = 'this';
                                receiverFieldName = fldNode.text;
                                receiverRootType = findEnclosingClassName(node);
                            } else if (rootNode.type === 'identifier') {
                                const rootType = getReceiverType(rootNode.text);
                                if (rootType) {
                                    receiverRoot = rootNode.text;
                                    receiverFieldName = fldNode.text;
                                    receiverRootType = rootType;
                                }
                            }
                        }
                    } else if (objNode.type === 'identifier' && receiver &&
                        !isDeclaredLocal(receiver)) {
                        // Implicit-this field (or a class name — the field-type
                        // hop in findCallers simply finds no field and no-ops).
                        receiverRoot = 'this';
                        receiverFieldName = receiver;
                        receiverRootType = findEnclosingClassName(node);
                    }
                }
                // Chained receiver (fix #220): the receiver IS a call —
                // getConfig().validate() — record the producer so findCallers
                // can type it from the declared return annotation.
                let receiverCall, receiverCallIsMethod;
                if (!receiver && !receiverFieldName && objNode?.type === 'method_invocation') {
                    const prodName = objNode.childForFieldName('name');
                    if (prodName) {
                        receiverCall = prodName.text;
                        if (objNode.childForFieldName('object')) receiverCallIsMethod = true;
                    }
                }
                const firstArg = getFirstStringArg(node);
                const callArgs = getCallArgs(node);
                const assignedTo = assignmentTargetOf(node);
                calls.push({
                    name: nameNode.text,
                    // Multi-line chains (builder.x()\n.y()) must report each
                    // method's OWN name line, not the chain-start line — the
                    // account's ground set is keyed by the name's line
                    line: nameNode.startPosition.row + 1,
                    isMethod: !!objNode,
                    receiver,
                    ...(receiverType && { receiverType }),
                    ...(receiverFieldName && { receiverRoot, receiverField: receiverFieldName }),
                    ...(receiverFieldName && receiverRootType && { receiverRootType }),
                    ...(receiverCall && { receiverCall }),
                    ...(receiverCallIsMethod && { receiverCallIsMethod: true }),
                    argCount: callArgs.argCount,
                    ...(callArgs.argKinds && { argKinds: callArgs.argKinds }),
                    ...(assignedTo && { assignedTo }),
                    enclosingFunction,
                    ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp })
                });
            }
            return true;
        }

        // Handle constructor calls: new Foo(), new pkg.Bar()
        // super(x) / this(x) — constructor delegation (fix #238: these
        // sites were invisible to every command). Resolve to the parent
        // class's constructor (super) or a same-class overload (this);
        // Java constructors are indexed under the CLASS name, so the
        // record carries the target class as its name.
        if (node.type === 'explicit_constructor_invocation') {
            let cls = node.parent;
            while (cls && cls.type !== 'class_declaration' && cls.type !== 'enum_declaration') {
                cls = cls.parent;
            }
            const isSuperCall = node.children.some(c => c.type === 'super');
            let targetClass = null;
            if (cls) {
                if (isSuperCall) {
                    const sup = cls.childForFieldName('superclass');
                    targetClass = sup?.namedChild(0)?.text || null;
                } else {
                    targetClass = cls.childForFieldName('name')?.text || null;
                }
            }
            if (targetClass) {
                const genericIdx = targetClass.indexOf('<');
                if (genericIdx > 0) targetClass = targetClass.substring(0, genericIdx);
                const dotIdx = targetClass.lastIndexOf('.');
                if (dotIdx > 0) targetClass = targetClass.substring(dotIdx + 1);
                const enclosingFunction = getCurrentEnclosingFunction();
                const ctorArgs = getCallArgs(node);
                calls.push({
                    name: targetClass,
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    isConstructor: true,
                    // 'this' delegation names the ENCLOSING class by
                    // construction — an intra-class mechanism, never a
                    // caller edge for the class (jdtls-measured, fix #238).
                    ctorDelegation: isSuperCall ? 'super' : 'this',
                    argCount: ctorArgs.argCount,
                    ...(ctorArgs.argKinds && { argKinds: ctorArgs.argKinds }),
                    enclosingFunction
                });
            }
            return true;
        }

        // Enum constants with arguments (RED(1)) invoke the enum's own
        // constructor (fix #238: the constructor had no call records, so
        // search --unused / deadcode flagged it dead in every enum).
        // Argument-less constants still construct — they call the implicit
        // or 0-arg constructor.
        if (node.type === 'enum_constant') {
            let enclosingEnum = node.parent;
            while (enclosingEnum && enclosingEnum.type !== 'enum_declaration') {
                enclosingEnum = enclosingEnum.parent;
            }
            const enumName = enclosingEnum?.childForFieldName('name')?.text;
            if (enumName) {
                const ctorArgs = getCallArgs(node);
                calls.push({
                    name: enumName,
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    isConstructor: true,
                    // Part of the enum's own declaration — keeps the
                    // constructor alive for deadcode/--unused, but never a
                    // caller edge for the enum (jdtls-measured, fix #238).
                    enumConstant: true,
                    argCount: ctorArgs.argCount,
                    ...(ctorArgs.argKinds && { argKinds: ctorArgs.argKinds }),
                    enclosingFunction: getCurrentEnclosingFunction()
                });
            }
            return true;
        }

        if (node.type === 'object_creation_expression') {
            const typeNode = node.childForFieldName('type');
            if (typeNode) {
                let typeName = typeNode.text;
                // Handle generic types like List<String>
                const genericIdx = typeName.indexOf('<');
                if (genericIdx > 0) {
                    typeName = typeName.substring(0, genericIdx);
                }
                // Handle qualified names like pkg.Class — keep the qualifier
                // as receiver (fix #206): a qualified type must not resolve to
                // a same-file binding of an unrelated same-name symbol.
                let typeQualifier = null;
                const dotIdx = typeName.lastIndexOf('.');
                if (dotIdx > 0) {
                    const qualParts = typeName.substring(0, dotIdx).split('.');
                    typeQualifier = qualParts[qualParts.length - 1] || null;
                    typeName = typeName.substring(dotIdx + 1);
                }

                const enclosingFunction = getCurrentEnclosingFunction();
                const ctorArgs = getCallArgs(node);
                calls.push({
                    name: typeName,
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    isConstructor: true,
                    ...(typeQualifier && { receiver: typeQualifier }),
                    argCount: ctorArgs.argCount,
                    ...(ctorArgs.argKinds && { argKinds: ctorArgs.argKinds }),
                    enclosingFunction
                });
            }
            return true;
        }

        // Detect method references passed as arguments: this::worker, obj::method
        if (node.type === 'method_reference') {
            const nameNode = node.namedChild(node.namedChildCount - 1);
            const objNode = node.namedChild(0);
            if (nameNode && nameNode.type === 'identifier') {
                const receiver = objNode ? (objNode.type === 'identifier' || objNode.type === 'this' ? objNode.text : undefined) : undefined;
                const receiverType = (receiver && receiver !== 'this') ? getReceiverType(receiver) : undefined;
                const enclosingFunction = getCurrentEnclosingFunction();
                calls.push({
                    name: nameNode.text,
                    line: node.startPosition.row + 1,
                    isMethod: !!receiver,
                    receiver,
                    ...(receiverType && { receiverType }),
                    isFunctionReference: true,
                    isPotentialCallback: true,
                    enclosingFunction
                });
            }
            return true;
        }

        // Track local variable types from declarations (fix #207 extends #202-era
        // new-Type() inference): the DECLARED type is compiler-checked evidence —
        // `Service s = lookup();` types s as Service regardless of the value
        // expression. `var` declarations fall back to new Type() value inference.
        if (node.type === 'local_variable_declaration' && functionStack.length > 0) {
            const declTypeNode = node.childForFieldName('type');
            const declaredType = declTypeNode && declTypeNode.text !== 'var'
                ? extractTypeName(declTypeNode) : null;
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'variable_declarator') {
                    const nameNode = child.childForFieldName('name');
                    const valueNode = child.childForFieldName('value');
                    // new Type() is the DYNAMIC type — more precise than the
                    // declared static type (Foo f = new Bar() dispatches to Bar)
                    let typeName = valueNode?.type === 'object_creation_expression'
                        ? extractTypeName(valueNode.childForFieldName('type'))
                        : null;
                    if (!typeName) typeName = declaredType;
                    if (nameNode && typeName) {
                        const scopeKey = functionStack[functionStack.length - 1].startLine;
                        const typeMap = scopeTypes.get(scopeKey);
                        if (typeMap) typeMap.set(nameNode.text, typeName);
                    }
                }
            }
        }

        // Try-with-resources declarations are declared-type locals too (fix
        // #231): `try (Res r = new Res())` types r exactly like `Res r = ...`
        // — the resource node carries type/name/value fields directly.
        if (node.type === 'resource' && functionStack.length > 0) {
            const resTypeNode = node.childForFieldName('type');
            const resNameNode = node.childForFieldName('name');
            const resValueNode = node.childForFieldName('value');
            let typeName = resValueNode?.type === 'object_creation_expression'
                ? extractTypeName(resValueNode.childForFieldName('type'))
                : null;
            if (!typeName && resTypeNode && resTypeNode.text !== 'var') {
                typeName = extractTypeName(resTypeNode);
            }
            if (resNameNode && typeName) {
                const scopeKey = functionStack[functionStack.length - 1].startLine;
                const typeMap = scopeTypes.get(scopeKey);
                if (typeMap) typeMap.set(resNameNode.text, typeName);
            }
        }

        return true;
    }, {
        onLeave: (node) => {
            if (isFunctionNode(node)) {
                const leaving = functionStack.pop();
                if (leaving) {
                    scopeTypes.delete(leaving.startLine);
                }
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

    traverseTreeCached(tree.rootNode, (node) => {
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

    traverseTreeCached(tree.rootNode, (node) => {
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
 * @param {object} [tree] - Pre-parsed tree (per-operation cache); parsed here when absent
 * @returns {Array<{line: number, column: number, usageType: string}>}
 */
function findUsagesInCode(code, name, parser, tree) {
    tree = tree || parseTree(parser, code);
    const usages = [];

    visitNameNodes(tree, code, name, (node) => {
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
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'call';
                // Track receiver for method invocations (obj.name() → receiver = 'obj')
                const object = parent.childForFieldName('object');
                if (object && object.type === 'identifier') {
                    usages.push({ line, column, usageType, receiver: object.text });
                    return true;
                }
            }
            // Definition: method name
            else if (parent.type === 'method_declaration' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: class name
            else if (parent.type === 'class_declaration' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: interface name
            else if (parent.type === 'interface_declaration' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: enum name
            else if (parent.type === 'enum_declaration' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: constructor
            else if (parent.type === 'constructor_declaration' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: local variable
            else if (parent.type === 'variable_declarator' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: parameter (name field only, not the type)
            else if ((parent.type === 'formal_parameter' ||
                     parent.type === 'spread_parameter') &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: field (declarator name only, not the type)
            else if (parent.type === 'field_declaration' &&
                     node.type === 'identifier' &&
                     parent.descendantsOfType('variable_declarator').some(d => sameNode(d.childForFieldName('name'), node))) {
                usageType = 'definition';
            }
            // Object creation: new ClassName()
            else if (parent.type === 'object_creation_expression') {
                const typeNode = parent.childForFieldName('type');
                if (sameNode(typeNode, node) || typeNode?.text === name) {
                    usageType = 'call';
                }
            }
            // Object position of a method call: x.method() — x is a receiver
            // (variable or ClassName), referenced, not called. The call belongs
            // to the name field, handled above.
            else if (parent.type === 'method_invocation' &&
                     sameNode(parent.childForFieldName('object'), node)) {
                usageType = 'reference';
            }
            // Field access: obj.field
            else if (parent.type === 'field_access' &&
                     sameNode(parent.childForFieldName('field'), node)) {
                usageType = 'reference';
                // Track receiver for field access (obj.field → receiver = 'obj')
                const object = parent.childForFieldName('object');
                if (object && object.type === 'identifier') {
                    usages.push({ line, column, usageType, receiver: object.text });
                    return true;
                }
            }
        }

        usages.push({ line, column, usageType });
        return true;
    });

    return usages;
}

/**
 * Classify a Java symbol as a runtime entry point of a specific kind.
 * Returns 'test' | 'main' | 'framework' | null.
 *
 * - 'test': JUnit @Test family (Test, ParameterizedTest, RepeatedTest,
 *           TestFactory, TestTemplate) and JUnit lifecycle hooks
 *           (BeforeEach, AfterEach, BeforeAll, AfterAll).
 * - 'main': public static void main() — invoked by the JVM.
 * - 'framework': @Override methods (invoked by the type-system contract).
 *
 * Used by tracing/search so `affectedTests` only tags genuine test methods.
 */
function getEntryPointKind(symbol) {
    const m = symbol.modifiers || [];
    // JUnit @Test family — full lowercase set so deadcode/test detection treats
    // ParameterizedTest, RepeatedTest, TestFactory, TestTemplate as test entry points.
    const TEST_ANNOTATIONS = ['test', 'parameterizedtest', 'repeatedtest', 'testfactory', 'testtemplate',
        'beforeeach', 'aftereach', 'beforeall', 'afterall', 'before', 'after'];
    if (m.some(x => TEST_ANNOTATIONS.includes(x))) return 'test';
    if (symbol.name === 'main' && m.includes('public') && m.includes('static')) return 'main';
    if (m.includes('override')) return 'framework';
    return null;
}

/**
 * Check if a symbol is a Java-convention entry point.
 * These are invoked by the JVM runtime, test runners, or required by type system.
 */
function isEntryPoint(symbol) {
    return getEntryPointKind(symbol) !== null;
}

module.exports = {
    findFunctions,
    findClasses,
    findStateObjects,
    findCallsInCode,
    findImportsInCode,
    findExportsInCode,
    findUsagesInCode,
    isEntryPoint,
    getEntryPointKind,
    parse
};
