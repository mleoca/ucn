/**
 * languages/java.js - Tree-sitter based Java parsing
 *
 * Handles: method declarations, constructors, class/interface/enum/record
 * declarations, and static final constants.
 */

const { ReceiverTypeMap, typeOrigin } = require('./type-evidence');


const {
    traverseTree,
    nodeTextWithoutComments,
    traverseTreeCached,
    nodeToLocation,
    parseStructuredParams,
    extractJavaDocstring,
    visitNameNodes,
    sameNode,
    parseErrorRegions,
    hasParameterizedQualifier,
} = require('./utils');
const { PARSE_OPTIONS, safeParse } = require('./index');

function parseTree(parser, code) {
    return safeParse(parser, code, undefined, PARSE_OPTIONS);
}

const ANNOTATION_BEFORE_DOTS = /@\s*[A-Za-z_$][\w$.]*(?:\s*\((?:[^()]|\([^()]*\))*\))?\s*\.\.\./;
// An annotation (with optional arguments) written right before `...`.
const VARARGS_ANNOTATION = /@\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*\((?:[^()]|\([^()]*\))*\))?\s*(?=\.\.\.)/g;

/**
 * Recovery of a grammar gap (fix #428): tree-sitter-java does not parse a
 * type annotation between a variable arity parameter's type and its `...`
 * (`Object @Nullable ... args`, JLS 8.4.1), and drops the parameter. Inside
 * each parse error of a parameter list, such annotations are blanked (same
 * offsets) and the source reparsed; the recovered tree is kept only when it
 * has fewer errors. Annotations carry no call or type facts the index reads
 * there.
 */
function recoverTypeAnnotatedVarargs(tree, source, reparse) {
    // Only a source spelling an annotation right before `...` can hold the
    // gap: one text test before any tree walk.
    if (!source.includes('...') || !ANNOTATION_BEFORE_DOTS.test(source)) return null;
    const ranges = [];
    for (const error of tree.rootNode.descendantsOfType('ERROR')) {
        let inParameters = false;
        for (let node = error.parent; node && !inParameters; node = node.parent) {
            if (node.type === 'formal_parameters') inParameters = true;
            if (node.type === 'class_body' || node.type === 'program') break;
        }
        if (!inParameters) continue;
        const text = source.slice(error.startIndex, error.endIndex);
        for (const match of text.matchAll(VARARGS_ANNOTATION)) {
            ranges.push([error.startIndex + match.index, error.startIndex + match.index + match[0].length]);
        }
    }
    if (ranges.length === 0) return null;
    let blanked = '';
    let at = 0;
    for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
        if (start < at) continue;
        blanked += source.slice(at, start) + source.slice(start, end).replace(/[^\n]/g, ' ');
        at = end;
    }
    blanked += source.slice(at);
    const recovered = reparse(blanked);
    const errors = root => root.descendantsOfType('ERROR').length + (root.hasError ? 1 : 0);
    return recovered && errors(recovered.rootNode) < errors(tree.rootNode) ? recovered : null;
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
    const text = nodeTextWithoutComments(paramsNode);
    // A recovered variable arity annotation leaves blanks before `...`.
    let params = text.replace(/^\(|\)$/g, '').trim().replace(/ {2,}(?=\.\.\.)/g, ' ');
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
            // Comments are named children of a Java modifiers node in
            // tree-sitter. Keyword modifiers are recovered from the bounded
            // declaration prefix below; never turn arbitrary comment text
            // into a semantic modifier/annotation.
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
        return nodeTextWithoutComments(typeNode);
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
            const { startLine, endLine, indent, sourceSpan } = nodeToLocation(node, lines);
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
                sourceSpan,
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
            const { startLine, endLine, indent, sourceSpan } = nodeToLocation(node, lines);
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
                sourceSpan,
                indent,
                modifiers,
                isConstructor: true,
                ...(docstring && { docstring }),
                ...(annotations.length > 0 && { annotations }),
                ...(annotationsWithArgs.length > 0 && { annotationsWithArgs }),
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

const JAVA_LOCAL_SCOPE_BODIES = new Set(['block', 'constructor_body', 'lambda_expression', 'switch_block']);

/**
 * Lexical scope of a local type (fix #381): a class, record, enum or
 * interface declared inside a block is visible from its declaration to the
 * end of that block, never as a member of the enclosing type.
 */
function javaLocalTypeScope(node) {
    for (let p = node.parent; p; p = p.parent) {
        if (p.type === 'class_body' || p.type === 'interface_body' || p.type === 'enum_body' ||
            p.type === 'enum_body_declarations' || p.type === 'program') return {};
        if (JAVA_LOCAL_SCOPE_BODIES.has(p.type)) {
            return {
                lexicalScopeStartLine: node.startPosition.row + 1,
                lexicalScopeEndLine: p.endPosition.row + 1,
            };
        }
    }
    return {};
}

/**
 * Process a node for class/interface/enum/record extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 */
function enclosingTypeName(current) {
    for (let p = current.parent; p; p = p.parent) {
        // A local class (declared in a method, constructor, initializer
        // or lambda body) is not a member of the enclosing type (fix #381).
        if (JAVA_LOCAL_SCOPE_BODIES.has(p.type)) return null;
        if (JAVA_TYPE_DECLARATIONS.has(p.type)) {
            return p.childForFieldName('name')?.text || null;
        }
    }
    return null;
}

const JAVA_TYPE_DECLARATIONS = new Set([
    'class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration',
    'annotation_type_declaration',
]);
// Type declarations that declare constructors.
const JAVA_CONSTRUCTOR_OWNER_TYPES = new Set(['class_declaration', 'enum_declaration', 'record_declaration']);

// A parameter type's erasure, read from its AST: type arguments and
// annotations dropped, array dimensions kept (`T...` is `T[]`).
function javaErasedType(typeNode) {
    if (!typeNode) return null;
    switch (typeNode.type) {
        case 'generic_type':
            return javaErasedType(typeNode.namedChildren.find(child =>
                child.type === 'type_identifier' || child.type === 'scoped_type_identifier'));
        case 'annotated_type':
            return javaErasedType(typeNode.namedChildren.find(child =>
                child.type !== 'marker_annotation' && child.type !== 'annotation'));
        case 'array_type': {
            const element = javaErasedType(typeNode.childForFieldName('element'));
            const dimensions = typeNode.childForFieldName('dimensions');
            const count = dimensions ? dimensions.children.filter(child => child.type === '[').length : 1;
            return element && `${element}${'[]'.repeat(count)}`;
        }
        case 'scoped_type_identifier':
            return typeNode.namedChildren.map(javaErasedType).join('.');
        default:
            return typeNode.text;
    }
}

function javaErasedParameters(paramsNode) {
    const erased = [];
    for (const param of paramsNode?.namedChildren || []) {
        if (param.type !== 'formal_parameter' && param.type !== 'spread_parameter') continue;
        const typeNode = param.childForFieldName('type') || param.namedChildren.find(child =>
            child.type !== 'modifiers' && child.type !== 'variable_declarator' && child.type !== 'identifier');
        const type = javaErasedType(typeNode);
        if (!type) return null;
        // `int b[]` writes its dimensions after the name.
        const dimensions = param.childForFieldName('dimensions');
        const trailing = dimensions ? '[]'.repeat(dimensions.children.filter(child => child.type === '[').length) : '';
        erased.push(`${type}${trailing}${param.type === 'spread_parameter' ? '[]' : ''}`);
    }
    return erased;
}

// Does a record's body declare its canonical constructor (JLS 8.10.4)?
// A compact constructor is canonical; so is a constructor whose parameter
// types are the component types. An undecidable spelling counts as not
// canonical: the implicit candidate then shares its signature, which
// leaves the choice between them open rather than closed.
function recordDeclaresCanonical(recordNode, paramsNode) {
    const components = javaErasedParameters(paramsNode);
    for (const child of recordNode.childForFieldName('body')?.namedChildren || []) {
        if (child.type === 'compact_constructor_declaration') return true;
        if (child.type !== 'constructor_declaration' || !components) continue;
        const declared = javaErasedParameters(child.childForFieldName('parameters'));
        if (declared && declared.length === components.length &&
            declared.every((type, at) => type === components[at])) return true;
    }
    return false;
}

function _processClass(node, classes, processedRanges, lines, code) {
    // Only type declarations are processed below: every other node returns
    // before any ancestor climb (fix #388).
    if (!JAVA_TYPE_DECLARATIONS.has(node.type)) return false;
    const localScope = javaLocalTypeScope(node);
    // Class declarations
    if (node.type === 'class_declaration') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;
        processedRanges.add(rangeKey);

        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const { startLine, endLine, sourceSpan } = nodeToLocation(node, lines);
            const members = extractClassMembers(node, lines);
            const modifiers = extractModifiers(node);
            const annotations = extractAnnotations(node);
            const annotationsWithArgs = extractAnnotationsWithArgs(node);
            const docstring = extractJavaDocstring(lines, startLine);
            const generics = extractGenerics(node);
            const extendsInfo = extractExtends(node);
            const implementsInfo = extractImplements(node);

            // Check if this is a nested/inner class
            const parentNode = node.parent;
            const isNested = parentNode && parentNode.type === 'class_body';
            const enclosingType = enclosingTypeName(node);

            classes.push({
                name: nameNode.text,
                startLine,
                endLine,
                sourceSpan,
                // The name's own line when annotations precede it (fix #389).
                ...(nameNode.startPosition.row + 1 !== startLine && { nameLine: nameNode.startPosition.row + 1 }),
                type: 'class',
                members,
                modifiers,
                ...localScope,
                ...(isNested && { isNested: true }),
                ...(enclosingType && { enclosingType }),
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

    // Interface declarations. An annotation type (`@interface`) is an
    // interface whose elements are its methods (JLS 9.6), so it is indexed
    // as one (fix #389) with `annotationType` set.
    if (node.type === 'interface_declaration' || node.type === 'annotation_type_declaration') {
        const annotationType = node.type === 'annotation_type_declaration';
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;
        processedRanges.add(rangeKey);

        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const { startLine, endLine, sourceSpan } = nodeToLocation(node, lines);
            const modifiers = extractModifiers(node);
            const annotations = extractAnnotations(node);
            const annotationsWithArgs = extractAnnotationsWithArgs(node);
            const docstring = extractJavaDocstring(lines, startLine);
            const generics = extractGenerics(node);
            const extendsInfo = annotationType ? [] : extractInterfaceExtends(node);

            classes.push({
                name: nameNode.text,
                startLine,
                endLine,
                sourceSpan,
                // The name's own line when annotations precede it (fix #389).
                ...(nameNode.startPosition.row + 1 !== startLine && { nameLine: nameNode.startPosition.row + 1 }),
                type: 'interface',
                members: extractClassMembers(node, lines),
                modifiers,
                ...(annotationType && { annotationType: true }),
                ...localScope,
                ...(enclosingTypeName(node) && { enclosingType: enclosingTypeName(node) }),
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
            const { startLine, endLine, sourceSpan } = nodeToLocation(node, lines);
            const modifiers = extractModifiers(node);
            const annotations = extractAnnotations(node);
            const annotationsWithArgs = extractAnnotationsWithArgs(node);
            const docstring = extractJavaDocstring(lines, startLine);
            // An enum implements its interfaces like a class (fix #392): the
            // rename closure and dispatch reach its members through them.
            const implementsInfo = extractImplements(node);

            classes.push({
                name: nameNode.text,
                startLine,
                endLine,
                sourceSpan,
                // The name's own line when annotations precede it (fix #389).
                ...(nameNode.startPosition.row + 1 !== startLine && { nameLine: nameNode.startPosition.row + 1 }),
                type: 'enum',
                members: extractEnumConstants(node, lines),
                modifiers,
                ...localScope,
                ...(enclosingTypeName(node) && { enclosingType: enclosingTypeName(node) }),
                ...(docstring && { docstring }),
                ...(annotations.length > 0 && { annotations }),
                ...(annotationsWithArgs.length > 0 && { annotationsWithArgs }),
                ...(implementsInfo.length > 0 && { implements: implementsInfo })
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
            const { startLine, endLine, sourceSpan } = nodeToLocation(node, lines);
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
                sourceSpan,
                // The name's own line when annotations precede it (fix #389).
                ...(nameNode.startPosition.row + 1 !== startLine && { nameLine: nameNode.startPosition.row + 1 }),
                type: 'record',
                members,
                modifiers,
                // The implicit canonical constructor: a constructor the
                // header declares with no body declaration, like a C#
                // primary constructor (fix #419).
                ...(paramsNode && !recordDeclaresCanonical(node, paramsNode) && {
                    primaryParams: parseStructuredParams(paramsNode, 'java'),
                }),
                ...localScope,
                ...(enclosingTypeName(node) && { enclosingType: enclosingTypeName(node) }),
                ...(docstring && { docstring }),
                ...(generics && { generics }),
                ...(annotations.length > 0 && { annotations }),
                ...(annotationsWithArgs.length > 0 && { annotationsWithArgs }),
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
            if (iface.type === 'type_identifier' || iface.type === 'generic_type' ||
                iface.type === 'scoped_type_identifier') {
                interfaces.push(iface.text);
            } else if (iface.type === 'type_list') {
                // Records and some class declarations wrap interfaces in a type_list
                for (let j = 0; j < iface.namedChildCount; j++) {
                    const inner = iface.namedChild(j);
                    if (inner.type === 'type_identifier' || inner.type === 'generic_type' ||
                        inner.type === 'scoped_type_identifier') {
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
    // The grammar exposes interface extends as an `extends_interfaces` child
    // wrapping a type_list, not as an `extends` field — the field lookup
    // returned null and interfaces silently never recorded their supertypes
    // (fix #270: the deadcode heritage walk needs them).
    const interfaces = [];
    for (let i = 0; i < interfaceNode.namedChildCount; i++) {
        const child = interfaceNode.namedChild(i);
        if (child.type !== 'extends_interfaces') continue;
        for (let j = 0; j < child.namedChildCount; j++) {
            const entry = child.namedChild(j);
            if (entry.type === 'type_list') {
                for (let k = 0; k < entry.namedChildCount; k++) {
                    interfaces.push(entry.namedChild(k).text);
                }
            } else {
                interfaces.push(entry.text);
            }
        }
    }
    return interfaces;
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
                const { startLine, endLine, sourceSpan } = nodeToLocation(child, code);
                const argsNode = child.childForFieldName('arguments');
                constants.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    sourceSpan,
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
                            const { startLine, endLine, sourceSpan } = nodeToLocation(member, code);
                            const modifiers = extractModifiers(member);
                            const returnType = extractReturnType(member);
                            // The name's own line and annotations, as for class
                            // methods (fix #392: an `@Override` line above the
                            // method left its rename on the annotation line).
                            const nameLine = nameNode.startPosition.row + 1;
                            const annotationsWithArgs = extractAnnotationsWithArgs(member);
                            const memberGenerics = extractGenerics(member);
                            constants.push({
                                name: nameNode.text,
                                params: extractJavaParams(paramsNode),
                                paramsStructured: parseStructuredParams(paramsNode, 'java'),
                                startLine,
                                endLine,
                                sourceSpan,
                                memberType: modifiers.includes('static') ? 'static' : 'method',
                                modifiers,
                                isMethod: true,
                                ...(returnType && { returnType }),
                                ...(annotationsWithArgs.length > 0 && { annotationsWithArgs }),
                                ...(nameLine !== startLine && { nameLine }),
                                ...(memberGenerics && { generics: memberGenerics })
                            });
                        }
                    } else if (member.type === 'field_declaration') {
                        // Fields after the constants (fix #430).
                        constants.push(...javaFieldMembers(member, code));
                    } else if (member.type === 'constructor_declaration') {
                        const nameNode = member.childForFieldName('name');
                        const paramsNode = member.childForFieldName('parameters');
                        if (nameNode) {
                            const { startLine, endLine, sourceSpan } = nodeToLocation(member, code);
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
                                sourceSpan,
                                memberType: 'constructor',
                                isConstructor: true,
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
 * The field members a field or constant declaration declares. Interface and
 * annotation type constants (`constant_declaration`, implicitly public static
 * final; fix #389) are fields like class fields.
 */
function javaFieldMembers(child, code) {
    const members = [];
    const typeNode = child.childForFieldName('type');
    const fieldTypeText = typeNode ? typeNode.text : null;
    // Visibility travels with the member (fix #251 — public
    // instance fields were invisible to api/fileExports because
    // the member had no modifiers for the #240 discipline to read;
    // the #241 Rust-field twin).
    const fieldModifiers = extractModifiers(child);
    if (child.type === 'constant_declaration') {
        for (const implicit of ['public', 'static', 'final']) {
            if (!fieldModifiers.includes(implicit)) fieldModifiers.push(implicit);
        }
    }
    for (let j = 0; j < child.namedChildCount; j++) {
        const decl = child.namedChild(j);
        if (decl.type !== 'variable_declarator') continue;
        const nameNode = decl.childForFieldName('name');
        if (!nameNode || !fieldTypeText) continue;
        const { startLine, endLine, sourceSpan } = nodeToLocation(child, code);
        // fix #390: an annotation on its own line starts the
        // declaration; the name's line is where edits go.
        const nameLine = nameNode.startPosition.row + 1;
        members.push({
            name: nameNode.text,
            startLine,
            endLine,
            sourceSpan,
            ...(nameLine !== startLine && { nameLine }),
            memberType: 'field',
            ...(fieldModifiers.length > 0 && { modifiers: [...fieldModifiers] }),
            fieldType: fieldTypeText
        });
    }
    return members;
}

/**
 * Extract class members (methods, constructors)
 */
const JAVA_ELEMENT_ILLEGAL_MODIFIERS = new Set(['default', 'static', 'final', 'private', 'protected',
    'synchronized', 'native']);

function extractClassMembers(classNode, codeOrLines) {
    const code = codeOrLines;
    const members = [];
    const bodyNode = classNode.childForFieldName('body');
    if (!bodyNode) return members;
    const isInterface = bodyNode.type === 'interface_body' || bodyNode.type === 'annotation_type_body';

    for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const child = bodyNode.namedChild(i);

        // Method declarations
        if (child.type === 'method_declaration') {
            const nameNode = child.childForFieldName('name');
            const paramsNode = child.childForFieldName('parameters');

            if (nameNode) {
                const { startLine, endLine, sourceSpan } = nodeToLocation(child, code);
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
                    sourceSpan,
                    memberType,
                    modifiers,
                    isMethod: true,  // Mark as method for context() lookups
                    // Abstract by keyword or by being a bodiless interface
                    // method: a concrete subtype must supply it.
                    ...(modifiers.includes('abstract') && { requiredMember: true }),
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

        // Annotation type elements (fix #389): abstract, implicitly public
        // methods of the annotation interface; a `default` value makes the
        // element optional at use sites, never a body.
        if (child.type === 'annotation_type_element_declaration') {
            const nameNode = child.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine, sourceSpan } = nodeToLocation(child, code);
                // Elements take no keyword modifiers besides public/abstract;
                // `default` here introduces the default value.
                const modifiers = extractModifiers(child).filter(modifier =>
                    !JAVA_ELEMENT_ILLEGAL_MODIFIERS.has(modifier));
                if (!modifiers.includes('public')) modifiers.push('public');
                if (!modifiers.includes('abstract')) modifiers.push('abstract');
                const returnType = extractReturnType(child);
                const docstring = extractJavaDocstring(code, startLine);
                const nameLine = nameNode.startPosition.row + 1;
                members.push({
                    name: nameNode.text,
                    params: '',
                    paramsStructured: [],
                    startLine,
                    endLine,
                    sourceSpan,
                    memberType: 'abstract',
                    modifiers,
                    isMethod: true,
                    ...(returnType && { returnType }),
                    ...(docstring && { docstring }),
                    ...(nameLine !== startLine && { nameLine }),
                });
            }
        }

        if (child.type === 'constructor_declaration' || child.type === 'compact_constructor_declaration') {
            const nameNode = child.childForFieldName('name');
            const paramsNode = child.childForFieldName('parameters') ||
                (child.type === 'compact_constructor_declaration' && classNode.childForFieldName('parameters'));
            if (nameNode) {
                const { startLine, endLine, indent, sourceSpan } = nodeToLocation(child, code);
                const nameLine = nameNode.startPosition.row + 1;
                const annotationsWithArgs = extractAnnotationsWithArgs(child);
                const generics = extractGenerics(child);
                members.push({
                    name: nameNode.text,
                    params: extractJavaParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'java'),
                    startLine, endLine, sourceSpan, indent,
                    memberType: 'constructor',
                    isMethod: true,
                    isConstructor: true,
                    modifiers: extractModifiers(child),
                    ...(nameLine !== startLine && { nameLine }),
                    ...(annotationsWithArgs.length > 0 && { annotationsWithArgs }),
                    ...(generics && { generics }),
                    docstring: extractJavaDocstring(code, startLine),
                });
            }
        }

        // Field declarations: declared types drive receiver disambiguation
        // (fix #202) — Rust/Go already emit field members with fieldType.
        if (child.type === 'field_declaration' || child.type === 'constant_declaration') {
            members.push(...javaFieldMembers(child, code));
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
                            const { startLine, endLine, sourceSpan } = nodeToLocation(node, lines);
                            objects.push({ name, startLine, endLine, sourceSpan, modifiers });
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
    let namespace = null;
    for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
        const child = tree.rootNode.namedChild(i);
        if (child.type === 'package_declaration') {
            namespace = child.namedChild(0)?.text || null;
            break;
        }
    }

    traverseTreeCached(tree.rootNode, (node) => {
        _processFunction(node, functions, processedFn, lines, code);
        _processClass(node, classes, processedCls, lines, code);
        _processState(node, stateObjects, lines, code);
        return true;
    });

    functions.sort((a, b) => a.startLine - b.startLine);
    classes.sort((a, b) => a.startLine - b.startLine);
    stateObjects.sort((a, b) => a.startLine - b.startLine);
    if (namespace) {
        for (const item of [...functions, ...classes, ...stateObjects]) {
            if (!item.namespace) item.namespace = namespace;
        }
    }

    return {
        language: 'java',
        totalLines: lines.length,
        functions,
        classes,
        stateObjects,
        ...(tree.rootNode.hasError && { parseRecovery: true, parseErrorRegions: parseErrorRegions(tree.rootNode) }),
        typeParameterNames: require('./utils').declaredTypeParameterNames(tree),
        imports: [],
        exports: []
    };
}

/**
 * Call records for annotation element sites (fix #389): an
 * `element_value_pair` key names the element method of the annotation type
 * (`@Marker(priority = 2)`); a single-argument list without a key sets the
 * element `value` (`@Marker("x")`) with no name token (`implicitName`).
 */
function javaAnnotationElementSites(node, calls, enclosingFunctionOf) {
    const annotation = node.type === 'element_value_pair' ? node.parent?.parent : node.parent;
    if (annotation?.type !== 'annotation') return;
    const typeNode = annotation.childForFieldName('name');
    const typeName = typeNode?.type === 'scoped_identifier'
        ? typeNode.childForFieldName('name')?.text : typeNode?.text;
    if (!typeName) return;
    const typeQualifier = typeNode.type === 'scoped_identifier'
        ? typeNode.childForFieldName('scope')?.text : null;
    let nameNode = null;
    let argument = null;
    if (node.type === 'element_value_pair') {
        nameNode = node.childForFieldName('key');
        if (nameNode?.type !== 'identifier') return;
    } else {
        const args = node.namedChildren.filter(child => !child.type.includes('comment'));
        if (args.length !== 1 || args[0].type === 'element_value_pair') return;
        argument = args[0];
    }
    calls.push({
        callSite: typeOrigin('call', nameNode || typeNode),
        name: nameNode ? nameNode.text : 'value',
        line: (nameNode || argument).startPosition.row + 1,
        // Where `value = ` goes when the element is renamed.
        ...(argument && { argColumn: argument.startPosition.column }),
        isMethod: true,
        receiverType: typeName,
        receiverTypeSource: 'annotation',
        receiverTypeEvidence: typeOrigin('annotation', typeNode),
        ...(typeQualifier && { receiverTypeQualifier: typeQualifier }),
        annotationElement: true,
        ...(!nameNode && { implicitName: true }),
        argCount: 0,
        enclosingFunction: enclosingFunctionOf(),
    });
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
    const scopeRawTypes = new Map();
    const scopeTypeQualifiers = new Map();
    // Preserve import ownership in nested-call argument kinds. A simple
    // `Method.getReturnType()` marker is not enough to distinguish
    // java.lang.reflect.Method from a project class with the same name.
    const importedTypeNames = new Map();
    const localMethodReturnTypes = new Map();
    traverseTreeCached(tree.rootNode, (node) => {
        if (node.type === 'import_declaration') {
            const spec = String(node.text || '')
                .replace(/^import\s+/, '')
                .replace(/^static\s+/, '')
                .replace(/;\s*$/, '')
                .trim();
            if (!spec || spec.endsWith('.*')) return true;
            const simple = spec.split('.').pop();
            if (simple) importedTypeNames.set(simple, spec);
        } else if (node.type === 'method_declaration') {
            const name = node.childForFieldName('name')?.text;
            const result = node.childForFieldName('type')?.text;
            if (name && result) {
                if (!localMethodReturnTypes.has(name)) {
                    localMethodReturnTypes.set(name, new Set());
                }
                localMethodReturnTypes.get(name).add(result);
            }
        }
        return true;
    });

    // Helper: extract first string-arg literal from a method_invocation node.
    // Used by route extraction to capture path arg of webClient.uri("/users") etc.
    const { extractStringArg: _extractStringArg } = require('./utils');
    const getFirstStringArg = (callNode) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return null;
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type.endsWith('comment')) continue;
            return _extractStringArg(arg);
        }
        return null;
    };

    // Helper to check if a node creates a function scope
    const isFunctionNode = (node) => {
        return ['method_declaration', 'constructor_declaration', 'compact_constructor_declaration', 'lambda_expression'].includes(node.type);
    };
    const JAVA_TYPE_DECLARATIONS = new Set([
        'class_declaration', 'interface_declaration',
        'enum_declaration', 'record_declaration', 'annotation_type_declaration',
    ]);

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
    // A bare nested type is resolved through its lexical owner:
    // `JavaFile(Builder b)` inside JavaFile means JavaFile.Builder, and
    // `Builder copy(Builder b)` inside JavaFile.Builder means the same nested
    // type. Preserve that owner just as an explicit `JavaFile.Builder`
    // annotation does; flattening all of them to `Builder` conflates every
    // builder class in a package.
    const lexicalNestedTypeOwner = (node, typeName) => {
        if (!node || !typeName) return null;
        const enclosingTypes = [];
        for (let p = node.parent; p; p = p.parent) {
            if (JAVA_TYPE_DECLARATIONS.has(p.type)) enclosingTypes.push(p);
        }
        for (let i = 0; i < enclosingTypes.length; i++) {
            const owner = enclosingTypes[i];
            const ownerName = owner.childForFieldName('name')?.text;
            if (!ownerName) continue;
            if (ownerName === typeName) {
                return enclosingTypes[i + 1]?.childForFieldName('name')?.text || null;
            }
            const body = owner.childForFieldName('body');
            if (!body) continue;
            for (let j = 0; j < body.namedChildCount; j++) {
                const child = body.namedChild(j);
                if (JAVA_TYPE_DECLARATIONS.has(child.type) &&
                    child.childForFieldName('name')?.text === typeName) {
                    return ownerName;
                }
            }
        }
        return null;
    };
    const extractTypeQualifier = (typeNode) => {
        if (!typeNode) return null;
        const text = String(typeNode.text || '').replace(/<.*$/, '');
        const parts = text.split('.');
        if (parts.length >= 2) {
            const qualifier = parts[parts.length - 2];
            // A capitalized penultimate segment is a nested owner
            // (Outer.Builder). Lowercase segments are packages and do not
            // distinguish same-named top-level types by themselves.
            if (/^[A-Z]/.test(qualifier)) return qualifier;
        }
        return lexicalNestedTypeOwner(typeNode, extractTypeName(typeNode));
    };
    // A fully qualified type spelling `a.b.Node` names package `a.b` (fix
    // #394): Java has no relative package names, so the written prefix is
    // the whole package. Recorded where no nested owner qualifies the type.
    const extractTypePackage = (typeNode) => {
        if (!typeNode) return null;
        const text = String(typeNode.text || '').replace(/<.*$/s, '').replace(/(?:\[\s*\]\s*)+$/, '').trim();
        const parts = text.split('.').map(part => part.trim());
        if (parts.length < 2) return null;
        const prefix = parts.slice(0, -1);
        return prefix.every(part => /^[a-z_][A-Za-z0-9_$]*$/.test(part)) ? prefix.join('.') : null;
    };
    const extractReceiverTypeQualifier = (typeNode) =>
        extractTypeQualifier(typeNode) || extractTypePackage(typeNode);
    // Pattern variables (fix #425, the Go type-switch rule): `x instanceof
    // Sq s`, `case Sq s ->` and record components `case Pt(Sq a, ..)` bind a
    // local of the written type wherever its scope reaches (JLS 6.3.1,
    // decided by patternBindingReach). Collected once per file by name.
    let patternBindings = null;
    // Patterns occur only after `instanceof` and in `case` labels.
    const mayHavePatterns = /\binstanceof\b|\bcase\b/.test(code);
    const patternTypeAt = (refNode) => {
        if (!mayHavePatterns) return null;
        if (!patternBindings) {
            patternBindings = new Map();
            for (const n of tree.rootNode.descendantsOfType(['type_pattern', 'instanceof_expression',
                'record_pattern_component'])) {
                let nameNode;
                let typeNode;
                if (n.type === 'instanceof_expression') {
                    nameNode = n.childForFieldName('name');
                    typeNode = n.childForFieldName('right');
                } else {
                    const kids = n.namedChildren.filter(kid => !kid.type.includes('comment'));
                    nameNode = kids.length === 2 ? kids[1] : null;
                    typeNode = kids.length === 2 ? kids[0] : null;
                }
                if (nameNode?.type !== 'identifier' || !typeNode || typeNode.text === 'var') continue;
                if (!patternBindings.has(nameNode.text)) patternBindings.set(nameNode.text, []);
                patternBindings.get(nameNode.text).push({ nameNode, typeNode });
            }
        }
        const list = refNode?.type === 'identifier' ? patternBindings.get(refNode.text) : null;
        if (!list) return null;
        for (let i = list.length - 1; i >= 0; i--) {
            const { nameNode, typeNode } = list[i];
            if (patternBindingReach(nameNode, refNode) !== 'in') continue;
            const type = extractTypeName(typeNode);
            if (!type) return null;
            return {
                type,
                qualifier: extractReceiverTypeQualifier(typeNode) || undefined,
                evidence: {
                    receiverTypeSource: 'annotation',
                    receiverTypeEvidence: { ...typeOrigin('annotation', typeNode), name: refNode.text, type },
                },
            };
        }
        return null;
    };
    const qualifyTypeName = (text) => {
        const raw = String(text || '').trim()
            .replace(/^\?\s+extends\s+/, '')
            .replace(/^\?\s+super\s+/, '');
        const base = raw.replace(/<.*$/s, '').replace(/\[\]$/, '').trim();
        if (!base) return null;
        if (base.includes('.')) return base;
        if (importedTypeNames.has(base)) return importedTypeNames.get(base);
        // String and Class can name project types. Preserve those spellings
        // for query-time lookup in the file and lexical owner that wrote them.
        if (['Enum', 'Object', 'Throwable'].includes(base)) {
            return `java.lang.${base}`;
        }
        return base;
    };

    // The base type of the anonymous class whose body holds `node`, when the
    // nearest class body is an anonymous one (`new StrBuilder() { .. }`):
    // `super` there names that type (fix #394).
    // Does the anonymous (or enum-constant) body around `node` declare a
    // method of this name itself (fix #401)?
    const anonymousBodyDeclares = (node, name) => {
        for (let p = node.parent; p; p = p.parent) {
            if (p.type === 'class_body') {
                return p.namedChildren.some(member => member.type === 'method_declaration' &&
                    member.childForFieldName('name')?.text === name);
            }
            if (JAVA_TYPE_DECLARATIONS.has(p.type)) return false;
        }
        return false;
    };
    // The anonymous body's supertype as written, qualifier kept (fix #401).
    const anonymousSuperTypeText = (node) => {
        for (let p = node.parent; p; p = p.parent) {
            if (p.type === 'class_body') {
                const owner = p.parent;
                if (owner?.type === 'enum_constant') {
                    const enumDeclaration = owner.parent?.parent;
                    return enumDeclaration?.type === 'enum_declaration'
                        ? enumDeclaration.childForFieldName('name')?.text || null : null;
                }
                const typeNode = owner?.type === 'object_creation_expression' ? owner.childForFieldName('type') : null;
                return typeNode ? typeNode.text.replace(/<[^]*$/, '').replace(/\s+/g, '') || null : null;
            }
            if (JAVA_TYPE_DECLARATIONS.has(p.type)) return null;
        }
        return null;
    };
    const anonymousSuperType = (node) => {
        for (let p = node.parent; p; p = p.parent) {
            if (p.type === 'class_body') {
                const owner = p.parent;
                // An enum constant's body is an anonymous subclass of its
                // enum (fix #401): `super.m()` there is the enum's member.
                if (owner?.type === 'enum_constant') {
                    const enumDeclaration = owner.parent?.parent;
                    return enumDeclaration?.type === 'enum_declaration'
                        ? enumDeclaration.childForFieldName('name')?.text || null : null;
                }
                return owner?.type === 'object_creation_expression'
                    ? extractTypeName(owner.childForFieldName('type')) || null : null;
            }
            if (JAVA_TYPE_DECLARATIONS.has(p.type)) return null;
        }
        return null;
    };

    // A written type as an argument kind type: qualified element type plus
    // its array dimensions (fix #394; `Map<K, V[]>[]` keeps one).
    const arrayArgType = (text) => {
        const raw = String(text || '').trim();
        let outer = '';
        let depth = 0;
        for (const ch of raw) {
            if (ch === '<') depth++;
            else if (ch === '>') depth--;
            else if (depth === 0) outer += ch;
        }
        const trailing = outer.match(/(?:\[\s*\]\s*)+$/);
        const dims = trailing ? (trailing[0].match(/\[/g) || []).length : 0;
        const element = qualifyTypeName(raw.replace(/(?:\[\s*\]\s*)+$/, ''));
        return element ? element + '[]'.repeat(dims) : null;
    };

    // Build type map from method/constructor parameters
    // One-hop `var` aliases (fix #381): `var c = this.config; c.load()`
    // receives through `this.config`; `var c = cfg;` carries cfg's type.
    // name -> { node, scopeStart } for effectively-final locals only.
    const localFieldAliases = new Map();
    const assignedNamesByFn = new Map();
    const reassignedIn = (fnNode, name) => {
        let names = assignedNamesByFn.get(fnNode.id);
        if (!names) {
            names = new Set();
            const walk = (n) => {
                for (const c of n.namedChildren) {
                    if (c.type === 'assignment_expression') {
                        const left = c.childForFieldName('left');
                        if (left?.type === 'identifier') names.add(left.text);
                    } else if (c.type === 'update_expression') {
                        const target = c.namedChildren.find(x => x.type === 'identifier');
                        if (target) names.add(target.text);
                    }
                    walk(c);
                }
            };
            walk(fnNode);
            assignedNamesByFn.set(fnNode.id, names);
        }
        return names.has(name);
    };
    const enclosingFunctionNode = (n) => {
        for (let p = n.parent; p; p = p.parent) if (isFunctionNode(p)) return p;
        return null;
    };

    // Array dimensions written on a declarator (`int x[]`, `String a[]`).
    const declaratorDims = (node) => {
        let dims = '';
        for (const child of node?.namedChildren || []) {
            if (child.type === 'dimensions') dims += '[]'.repeat((child.text.match(/\[/g) || []).length);
        }
        return dims;
    };
    const buildScopeTypeMap = (node) => {
        const typeMap = new ReceiverTypeMap();
        const rawTypeMap = new Map();
        const qualifierMap = new Map();
        const paramsNode = node.childForFieldName('parameters');
        if (paramsNode) {
            for (let i = 0; i < paramsNode.namedChildCount; i++) {
                const param = paramsNode.namedChild(i);
                if (param.type === 'formal_parameter' || param.type === 'spread_parameter') {
                    const nameNode = param.childForFieldName('name');
                    const typeNode = param.childForFieldName('type');
                    const typeName = extractTypeName(typeNode);
                    if (nameNode && typeName) {
                        typeMap.set(nameNode.text, typeName, 'annotation', typeNode);
                        // `String a[]` is a String[] (fix #394).
                        rawTypeMap.set(nameNode.text, typeNode.text + declaratorDims(param));
                        const qualifier = extractReceiverTypeQualifier(typeNode);
                        if (qualifier) qualifierMap.set(nameNode.text, qualifier);
                    }
                }
            }
        }
        return { typeMap, rawTypeMap, qualifierMap };
    };

    // Helper to extract function name from a function node
    const extractFunctionName = (node) => {
        if (node.type === 'method_declaration') {
            const nameNode = node.childForFieldName('name');
            return nameNode?.text || '<anonymous>';
        }
        if (node.type === 'constructor_declaration' || node.type === 'compact_constructor_declaration') {
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
    const getReceiverType = (varName, evidence = false) => {
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const typeMap = scopeTypes.get(functionStack[i].startLine);
            if (typeMap?.has(varName)) return evidence ? typeMap.fields(varName) : typeMap.get(varName);
        }
        return undefined;
    };
    const getReceiverTypeOrigin = (varName) => {
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const typeMap = scopeTypes.get(functionStack[i].startLine);
            if (typeMap?.has(varName)) return typeMap.origins.get(varName);
        }
        return undefined;
    };
    const getReceiverRawType = (varName) => {
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const typeMap = scopeRawTypes.get(functionStack[i].startLine);
            if (typeMap?.has(varName)) return typeMap.get(varName);
        }
        return undefined;
    };
    const getReceiverTypeQualifier = (varName) => {
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const qualifierMap = scopeTypeQualifiers.get(functionStack[i].startLine);
            if (qualifierMap?.has(varName)) return qualifierMap.get(varName);
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
    const scopedTypeRestores = new Map();
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
    const hasEnclosingField = (n, name) => {
        for (let p = n.parent; p; p = p.parent) {
            if (p.type !== 'class_declaration' && p.type !== 'interface_declaration' &&
                p.type !== 'enum_declaration' && p.type !== 'record_declaration') continue;
            const body = p.childForFieldName('body');
            if (!body) return false;
            for (let i = 0; i < body.namedChildCount; i++) {
                const child = body.namedChild(i);
                if (child.type !== 'field_declaration') continue;
                for (let j = 0; j < child.namedChildCount; j++) {
                    const decl = child.namedChild(j);
                    if (decl.type === 'variable_declarator' &&
                        decl.childForFieldName('name')?.text === name) return true;
                }
            }
            return false;
        }
        return false;
    };
    const enclosingFieldDeclaration = (n, name) => {
        for (let p = n.parent; p; p = p.parent) {
            if (!JAVA_TYPE_DECLARATIONS.has(p.type)) continue;
            const body = p.childForFieldName('body');
            if (!body) return null;
            for (let i = 0; i < body.namedChildCount; i++) {
                const child = body.namedChild(i);
                if (child.type !== 'field_declaration') continue;
                for (let j = 0; j < child.namedChildCount; j++) {
                    const decl = child.namedChild(j);
                    if (decl.type === 'variable_declarator' &&
                        decl.childForFieldName('name')?.text === name) {
                        const type = child.childForFieldName('type');
                        return type ? { type, dims: declaratorDims(decl) } : null;
                    }
                }
            }
            return null;
        }
        return null;
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
    const methodCallPathOf = (node) => {
        if (node?.type !== 'method_invocation') return null;
        const method = node.childForFieldName('name')?.text;
        if (!method) return null;
        let ownerNode = node.childForFieldName('object');
        if (!ownerNode) {
            const owner = findEnclosingClassName(node);
            return owner ? { owner, written: owner, site: typeOrigin('call', node),
                arities: [getCallArgCount(node)], methods: [method] } : null;
        }
        while (ownerNode?.type === 'parenthesized_expression' &&
            ownerNode.namedChildCount === 1) {
            ownerNode = ownerNode.namedChild(0);
        }
        if (ownerNode?.type === 'method_invocation') {
            const parent = methodCallPathOf(ownerNode);
            return parent
                ? { ...parent, methods: [...parent.methods, method],
                    arities: [...parent.arities, getCallArgCount(node)] }
                : null;
        }
        let ownerType = null;
        if (ownerNode?.type === 'identifier') {
            ownerType = getReceiverRawType(ownerNode.text) ||
                getReceiverType(ownerNode.text) ||
                (/^[A-Z]/.test(ownerNode.text) ? ownerNode.text : null);
        } else if (ownerNode?.type === 'cast_expression') {
            ownerType = ownerNode.childForFieldName('type')?.text;
        } else if (ownerNode?.type === 'object_creation_expression') {
            ownerType = ownerNode.childForFieldName('type')?.text;
        }
        return ownerType
            ? { owner: qualifyTypeName(ownerType), written: ownerType,
                site: typeOrigin('call', node), arities: [getCallArgCount(node)], methods: [method] }
            : null;
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
                return tn ? `new:${qualifyTypeName(tn.text)}` : 'expr';
            }
            case 'array_creation_expression': {
                // `new String[3][]`, `new String[]{..}`: an array of that
                // many dimensions (fix #394).
                const tn = arg.childForFieldName('type');
                let dims = 0;
                for (const child of arg.namedChildren) {
                    if (child.type === 'dimensions_expr') dims++;
                    else if (child.type === 'dimensions') dims += (child.text.match(/\[/g) || []).length;
                }
                const element = tn && qualifyTypeName(tn.text);
                return element && dims > 0 ? `new:${element}${'[]'.repeat(dims)}` : 'expr';
            }
            case 'cast_expression': {
                const tn = arg.childForFieldName('type');
                const type = tn && arrayArgType(tn.text);
                return type ? `cast:${type}` : 'expr';
            }
            case 'class_literal': {
                const tn = arg.namedChild(0);
                return tn ? `class:${bareTypeName(tn.text)}` : 'class:Object';
            }
            case 'identifier': {
                const field = !isDeclaredLocal(arg.text)
                    ? enclosingFieldDeclaration(arg, arg.text) : null;
                const typeName = getReceiverType(arg.text) ||
                    extractTypeName(field?.type);
                const rawType = getReceiverRawType(arg.text) ||
                    (field ? field.type.text + field.dims : null);
                // Array dimensions stay on the kind (fix #394): a String[]
                // never binds a String parameter, a String never an Object[].
                const type = typeName ? arrayArgType(rawType || typeName) : null;
                return type ? `type:${type}` : 'expr';
            }
            case 'field_access': {
                // A class-qualified static field has a compiler-visible
                // declared type (`TypeName.DOUBLE` is TypeName). Preserve
                // owner + field identity in the call IR and resolve the
                // declaration from the project index at query time. Do not
                // flatten it to the owner's type: the field may hold any
                // declared value type.
                const ownerNode = arg.childForFieldName('object');
                const fieldNode = arg.childForFieldName('field');
                if (!ownerNode || !fieldNode) return 'expr';
                let ownerType = null;
                if (ownerNode.type === 'identifier') {
                    ownerType = getReceiverRawType(ownerNode.text) ||
                        getReceiverType(ownerNode.text) ||
                        (/^[A-Z]/.test(ownerNode.text) ? ownerNode.text : null);
                } else if (ownerNode.type === 'field_access' ||
                    ownerNode.type === 'scoped_identifier') {
                    ownerType = ownerNode.text;
                }
                const qualifiedOwner = ownerType && qualifyTypeName(ownerType);
                return qualifiedOwner
                    ? `field:${qualifiedOwner}:${fieldNode.text}`
                    : 'expr';
            }
            case 'method_invocation': {
                // Preserve compiler-visible producer ownership for nested
                // factories and helpers. Imported owners stay qualified so
                // platform contracts cannot be confused with project types
                // that share a simple name.
                const ownerNode = arg.childForFieldName('object');
                const methodNode = arg.childForFieldName('name');
                if (!methodNode) return 'expr';
                if (!ownerNode) {
                    const owner = findEnclosingClassName(arg);
                    return owner ? methodResultKind(owner, methodNode.text, arg) : 'expr';
                }
                let normalizedOwner = ownerNode;
                while (normalizedOwner?.type === 'parenthesized_expression' &&
                    normalizedOwner.namedChildCount === 1) {
                    normalizedOwner = normalizedOwner.namedChild(0);
                }
                let ownerType = null;
                let ownerRawType = null;
                if (normalizedOwner?.type === 'identifier') {
                    ownerType = getReceiverType(normalizedOwner.text) ||
                        (!isDeclaredLocal(normalizedOwner.text) &&
                         !hasEnclosingField(arg, normalizedOwner.text) &&
                         /^[A-Z]/.test(normalizedOwner.text) ? normalizedOwner.text : null);
                    ownerRawType = getReceiverRawType(normalizedOwner.text);
                } else if (normalizedOwner?.type === 'cast_expression') {
                    const typeNode = normalizedOwner.childForFieldName('type');
                    ownerType = extractTypeName(typeNode);
                    ownerRawType = typeNode?.text;
                } else if (normalizedOwner?.type === 'object_creation_expression') {
                    const typeNode = normalizedOwner.childForFieldName('type');
                    ownerType = extractTypeName(typeNode);
                    ownerRawType = typeNode?.text;
                } else if (normalizedOwner?.type === 'method_invocation') {
                    const producerName = normalizedOwner.childForFieldName('name')?.text;
                    const producerObject = normalizedOwner.childForFieldName('object');
                    if (producerName && !producerObject) {
                        const returns = localMethodReturnTypes.get(producerName);
                        if (returns?.size === 1) {
                            ownerRawType = [...returns][0];
                            ownerType = bareTypeName(ownerRawType);
                        }
                    }
                    if (!ownerType) {
                        const producerKind = argKindOf(normalizedOwner);
                        if (producerKind.startsWith('type:')) {
                            ownerType = producerKind.slice('type:'.length);
                            ownerRawType = ownerType;
                        }
                    }
                }
                // Generic get() return contracts are resolved from the
                // receiver's actual type at query time. A project container
                // does not acquire List/Map semantics from its type arguments.
                if (ownerType) {
                    const written = ownerRawType || ownerType;
                    return methodResultKind(hasParameterizedQualifier(written)
                        ? written : qualifyTypeName(written), methodNode.text, arg, written);
                }
                const path = methodCallPathOf(arg);
                if (path?.methods.length > 1) {
                    return `chain:${path.owner}#${path.methods.join('#')}|` +
                        encodeURIComponent(JSON.stringify({ written: path.written, site: path.site,
                            arities: path.arities }));
                }
                return 'expr';
            }
            case 'array_access': {
                const arrayNode = arg.childForFieldName('array') || arg.namedChild(0);
                if (!arrayNode) return 'expr';
                if (arrayNode.type === 'identifier') {
                    const rawType = getReceiverRawType(arrayNode.text);
                    if (rawType?.trim().endsWith(']')) {
                        const type = arrayArgType(rawType.trim().replace(/\[\s*\]$/, ''));
                        if (type) return `type:${type}`;
                    }
                }
                const containerKind = argKindOf(arrayNode);
                return containerKind !== 'expr' ? `element:${containerKind}` : 'expr';
            }
            case 'parenthesized_expression':
                return arg.namedChildCount === 1 ? argKindOf(arg.namedChild(0)) : 'expr';
            case 'lambda_expression': {
                // Its parameter count selects among functional-interface
                // overloads (fix #391).
                const params = arg.childForFieldName('parameters');
                if (!params) return 'lambda';
                if (params.type === 'identifier') return 'lambda:1';
                return `lambda:${params.namedChildren.filter(child =>
                    child.type === 'identifier' || child.type === 'formal_parameter' ||
                    child.type === 'spread_parameter').length}`;
            }
            case 'method_reference': return 'lambda';
            case 'binary_expression': {
                // String concatenation (JLS 15.18.1): `+` with a String
                // operand is a String (fix #390, `addStatement("a" + "b")`
                // selects the String overload, never addStatement(CodeBlock)).
                if (arg.childForFieldName('operator')?.text !== '+') return 'expr';
                const left = arg.childForFieldName('left');
                const right = arg.childForFieldName('right');
                return (left && argKindOf(left) === 'string') ||
                    (right && argKindOf(right) === 'string') ? 'string' : 'expr';
            }
            case 'unary_expression':
                // -1, -2.5 — numeric literal kinds survive negation
                return arg.namedChildCount === 1 ? argKindOf(arg.namedChild(0)) : 'expr';
            default: return 'expr';
        }
    };
    // The argument count alone: a chain records each hop's arity without
    // deriving every nested argument's kind again (fix #418).
    const getCallArgCount = (callNode) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return 0;
        let count = 0;
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            if (!argsNode.namedChild(i).type.endsWith('comment')) count++;
        }
        return count;
    };
    const getCallArgs = (callNode) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return { argCount: 0, argKinds: null };
        const kinds = [];
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type.endsWith('comment')) continue;
            kinds.push(argKindOf(arg));
        }
        return { argCount: kinds.length, argKinds: kinds.some(k => k !== 'expr') ? kinds : null };
    };
    const methodResultKind = (owner, method, node, written = owner) => {
        const args = getCallArgs(node);
        const kinds = args.argKinds || Array(args.argCount).fill('expr');
        return `callshape:${encodeURIComponent(owner)}|${encodeURIComponent(method)}|` +
            kinds.map(encodeURIComponent).join(',') + '|' +
            encodeURIComponent(JSON.stringify({ written, site: typeOrigin('call', node) }));
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
            const builtScope = buildScopeTypeMap(node);
            scopeTypes.set(entry.startLine, builtScope.typeMap);
            scopeRawTypes.set(entry.startLine, builtScope.rawTypeMap);
            scopeTypeQualifiers.set(entry.startLine, builtScope.qualifierMap);
            scopeDeclared.set(entry.startLine, collectDeclaredNames(node));
        }

        // Enhanced-for variables are compiler-typed locals whose scope is
        // exactly the loop body. Record the type before visiting the body and
        // restore any shadowed outer binding on leave.
        if (node.type === 'enhanced_for_statement' && functionStack.length > 0) {
            const typeNode = node.childForFieldName('type');
            const nameNode = node.childForFieldName('name');
            const typeName = extractTypeName(typeNode);
            const typeQualifier = extractReceiverTypeQualifier(typeNode);
            const scopeKey = functionStack[functionStack.length - 1].startLine;
            const typeMap = scopeTypes.get(scopeKey);
            if (nameNode && typeName && typeMap) {
                const rawTypeMap = scopeRawTypes.get(scopeKey);
                scopedTypeRestores.set(node.id, {
                    typeMap,
                    rawTypeMap,
                    name: nameNode.text,
                    had: typeMap.has(nameNode.text),
                    previous: typeMap.get(nameNode.text),
                    rawHad: rawTypeMap?.has(nameNode.text),
                    rawPrevious: rawTypeMap?.get(nameNode.text),
                });
                typeMap.set(nameNode.text, typeName, 'annotation', typeNode);
                rawTypeMap?.set(nameNode.text, typeNode.text);
                const qualifierMap = scopeTypeQualifiers.get(scopeKey);
                if (typeQualifier) qualifierMap?.set(nameNode.text, typeQualifier);
                else qualifierMap?.delete(nameNode.text);
            }
        }

        // Handle method invocations: foo(), obj.foo(), this.foo()
        if (node.type === 'method_invocation') {
            const nameNode = node.childForFieldName('name');
            let objNode = node.childForFieldName('object');
            // fix #381: `c.load()` after `var c = this.config` receives like
            // `this.config.load()` (same function, effectively final).
            if (objNode?.type === 'identifier' && localFieldAliases.has(objNode.text) &&
                !getReceiverType(objNode.text) &&
                localFieldAliases.get(objNode.text).scopeStart ===
                    functionStack[functionStack.length - 1]?.startLine) {
                objNode = localFieldAliases.get(objNode.text).node;
            }

            if (nameNode) {
                const enclosingFunction = getCurrentEnclosingFunction();
                let receiverNode = objNode;
                while (receiverNode?.type === 'parenthesized_expression' && receiverNode.namedChildCount === 1) {
                    receiverNode = receiverNode.namedChild(0);
                }
                let castReceiverType;
                let castReceiverName;
                if (receiverNode?.type === 'cast_expression') {
                    castReceiverType = extractTypeName(receiverNode.childForFieldName('type'));
                    const valueNode = receiverNode.childForFieldName('value');
                    if (valueNode?.type === 'identifier') castReceiverName = valueNode.text;
                }
                // `super.m()` names the direct superclass's member (fix #394).
                let receiver = castReceiverName ||
                    ((receiverNode?.type === 'identifier' || receiverNode?.type === 'this' ||
                        receiverNode?.type === 'super')
                        ? receiverNode.text : undefined);
                // fix #353: `beta.Helper.widget()` — a lowercase dotted root
                // under a capitalized member is a PACKAGE-qualified type
                // (Java packages are lowercase by convention, types
                // capitalized); the receiver is the type and the package is
                // its qualifier, so same-name static methods in two packages
                // resolve by the qualifier that is right there in the call.
                let packageQualifier;
                if (!receiver && receiverNode?.type === 'field_access') {
                    const rootNode = receiverNode.childForFieldName('object');
                    const fldNode = receiverNode.childForFieldName('field');
                    const rootText = rootNode?.text || '';
                    const rootHead = rootText.split('.')[0];
                    if (fldNode?.type === 'identifier' && /^[A-Z]/.test(fldNode.text) &&
                        /^[a-z_][\w]*(\.[a-z_][\w]*)*$/.test(rootText) &&
                        !getReceiverType(rootHead) && !isDeclaredLocal(rootHead) &&
                        !hasEnclosingField(node, rootHead)) {
                        receiver = fldNode.text;
                        packageQualifier = rootText;
                    }
                }
                const inlineConstructorType = receiverNode?.type === 'object_creation_expression'
                    ? extractTypeName(receiverNode.childForFieldName('type')) : undefined;
                // Declared array element (fix #359): `items[0].m()` with
                // `Conv[] items` dispatches on Conv. One dimension only; a
                // multi-dimensional access that yields an array abstains.
                let arrayElementType;
                let arrayElementQualifier;
                if (!receiver && receiverNode?.type === 'array_access') {
                    const arrayNode = receiverNode.childForFieldName('array');
                    const rawType = arrayNode?.type === 'identifier'
                        ? getReceiverRawType(arrayNode.text)?.trim() : undefined;
                    if (rawType && rawType.endsWith('[]')) {
                        const elementText = rawType.slice(0, -2).trim();
                        if (elementText && !elementText.includes('[') &&
                            !elementText.includes('<')) {
                            const parts = elementText.split('.');
                            arrayElementType = parts.pop();
                            if (parts.length > 0) arrayElementQualifier = parts.join('.');
                        }
                    }
                }
                const pattern = !castReceiverType && receiverNode?.type === 'identifier'
                    ? patternTypeAt(receiverNode) : null;
                const receiverType = castReceiverType || inlineConstructorType || arrayElementType ||
                    pattern?.type || ((receiver && receiver !== 'this') ? getReceiverType(receiver) : undefined);
                const receiverTypeQualifier = packageQualifier || arrayElementQualifier ||
                    (pattern ? pattern.qualifier : undefined) ||
                    (!castReceiverType && !pattern && receiver ? getReceiverTypeQualifier(receiver) : undefined);
                const receiverIsTypeQualified = !!((receiverNode?.type === 'identifier' || packageQualifier) &&
                    receiver && /^[A-Z]/.test(receiver) && !receiverType &&
                    !isDeclaredLocal(receiver) && !hasEnclosingField(node, receiver));
                // fix #202: one-hop declared-field receivers —
                // this.service.execute(), svc.client.run(), and bare
                // service.execute() where service is a class field (only when
                // no same-named local is declared anywhere in the method).
                let receiverRoot, receiverFieldName, receiverRootType;
                let receiverRootNamespace;
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
                                // `TypeName.CONSTANT.method()` is a one-hop
                                // static-field receiver. The capitalized root
                                // is type identity, then the field declaration
                                // supplies the value's static type.
                                const rootType = getReceiverType(rootNode.text) ||
                                    (/^[A-Z]/.test(rootNode.text) ? rootNode.text : undefined);
                                if (rootType) {
                                    receiverRoot = rootNode.text;
                                    receiverFieldName = fldNode.text;
                                    receiverRootType = rootType;
                                    // A nested owner only: the root's package
                                    // does not qualify the field's type.
                                    const rootQualifier = getReceiverTypeQualifier(rootNode.text);
                                    receiverRootNamespace = /^[A-Z]/.test(rootQualifier || '')
                                        ? rootQualifier : undefined;
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
                let receiverCall, receiverCallIsMethod, receiverCallLine;
                if (!receiver && !receiverFieldName && objNode?.type === 'method_invocation') {
                    const prodName = objNode.childForFieldName('name');
                    if (prodName) {
                        receiverCall = prodName.text;
                        // Producer link (fix #258): records report the name
                        // node's own line
                        receiverCallLine = prodName.startPosition.row + 1;
                        if (objNode.childForFieldName('object')) receiverCallIsMethod = true;
                    }
                }
                const firstArg = getFirstStringArg(node);
                const callArgs = getCallArgs(node);
                const assignedTo = assignmentTargetOf(node);
                const receiverPath = objNode?.type === 'method_invocation'
                    ? methodCallPathOf(objNode) : null;
                const receiverCallTypePath = receiverPath
                    ? (receiverPath.methods.length === 1
                        ? methodResultKind(receiverPath.owner, receiverPath.methods[0], objNode,
                            receiverPath.written)
                        : `chain:${receiverPath.owner}#${receiverPath.methods.join('#')}|` +
                            encodeURIComponent(JSON.stringify({ written: receiverPath.written,
                                site: receiverPath.site, arities: receiverPath.arities })))
                    : null;
                calls.push({
                    callSite: typeOrigin('call', nameNode),
                    name: nameNode.text,
                    // Multi-line chains (builder.x()\n.y()) must report each
                    // method's OWN name line, not the chain-start line — the
                    // account's ground set is keyed by the name's line
                    line: nameNode.startPosition.row + 1,
                    isMethod: !!objNode,
                    receiver,
                    ...(receiverType && { receiverType, ...((pattern && pattern.type === receiverType && pattern.evidence) ||
                        getReceiverType(receiver, true) ||
                        (castReceiverType ? { receiverTypeSource: 'cast', receiverTypeEvidence: typeOrigin('cast', objNode) } :
                            inlineConstructorType ? { receiverTypeSource: 'constructor', receiverTypeEvidence: typeOrigin('constructor', receiverNode) } :
                            arrayElementType ? { receiverTypeSource: 'annotation', receiverTypeEvidence: typeOrigin('annotation', receiverNode) } :
                            { receiverTypeSource: 'unknown' })) }),
                    ...(receiverTypeQualifier && { receiverTypeQualifier }),
                    ...(receiverIsTypeQualified && { receiverIsTypeQualified: true }),
                    ...(receiver === 'super' && anonymousSuperType(node) && { receiverSuperType: anonymousSuperType(node) }),
                    // A bare call in an anonymous class or enum-constant
                    // body: its implicit `this` is that body's class (fix
                    // #401), whose supertype's members come first.
                    ...(!objNode && anonymousSuperTypeText(node) && { anonymousSuperType: anonymousSuperTypeText(node),
                        ...(anonymousBodyDeclares(node, nameNode.text) && { anonymousDeclares: true }) }),
                    ...(castReceiverType && { receiverTypeCast: true }),
                    ...(receiverFieldName && { receiverRoot, receiverField: receiverFieldName }),
                    ...(receiverFieldName && receiverRootType && { receiverRootType }),
                    ...(receiverFieldName && receiverRootNamespace && {
                        receiverRootNamespace,
                    }),
                    ...(receiverCall && { receiverCall }),
                    ...(receiverCallIsMethod && { receiverCallIsMethod: true }),
                    ...(receiverCallLine && { receiverCallLine }),
                    ...(receiverCallTypePath && { receiverCallTypePath }),
                    argCount: callArgs.argCount,
                    ...(callArgs.argKinds && { argKinds: callArgs.argKinds }),
                    // `obj.<T>m()`: explicit method type arguments (fix #391).
                    ...(node.childForFieldName('type_arguments') && {
                        methodTypeArgs: node.childForFieldName('type_arguments').namedChildCount,
                    }),
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
        // Java constructors are named after their class. The record carries
        // that name, and constructor resolution selects its overload.
        if (node.type === 'explicit_constructor_invocation') {
            // The constructor's own type declaration: a class, enum or
            // record (a record's non-canonical constructor delegates with
            // `this(...)`, fix #419).
            let cls = node.parent;
            while (cls && !JAVA_CONSTRUCTOR_OWNER_TYPES.has(cls.type)) {
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
                const constructorQualifier = dotIdx > 0 ? targetClass.substring(0, dotIdx) : null;
                if (dotIdx > 0) targetClass = targetClass.substring(dotIdx + 1);
                const enclosingFunction = getCurrentEnclosingFunction();
                const ctorArgs = getCallArgs(node);
                calls.push({
                    callSite: typeOrigin('call', node),
                    name: targetClass,
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    isConstructor: true,
                    ...(constructorQualifier && { constructorQualifier }),
                    // 'this' delegation names the ENCLOSING class by
                    // construction — an intra-class mechanism, never a
                    // caller edge for the class (jdtls-measured, fix #238).
                    ctorDelegation: isSuperCall ? 'super' : 'this',
                    constructorSyntax: 'delegation',
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
                    callSite: typeOrigin('call', node),
                    name: enumName,
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    isConstructor: true,
                    // Part of the enum's own declaration — keeps the
                    // constructor alive for deadcode/--unused, but never a
                    // caller edge for the enum (jdtls-measured, fix #238).
                    enumConstant: true,
                    constructorSyntax: 'enum',
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
                let constructorQualifier = null;
                const dotIdx = typeName.lastIndexOf('.');
                if (dotIdx > 0) {
                    constructorQualifier = typeName.substring(0, dotIdx);
                    const qualParts = typeName.substring(0, dotIdx).split('.');
                    typeQualifier = qualParts[qualParts.length - 1] || null;
                    typeName = typeName.substring(dotIdx + 1);
                }

                const enclosingFunction = getCurrentEnclosingFunction();
                const ctorArgs = getCallArgs(node);
                calls.push({
                    callSite: typeOrigin('call', typeNode),
                    name: typeName,
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    isConstructor: true,
                    ...(typeQualifier && { receiver: typeQualifier }),
                    ...(constructorQualifier && { constructorQualifier }),
                    argCount: ctorArgs.argCount,
                    ...(ctorArgs.argKinds && { argKinds: ctorArgs.argKinds }),
                    enclosingFunction
                });
            }
            return true;
        }

        // Annotation element sites (fix #389): `@Marker(priority = 2)` and
        // the single-element shorthand `@Marker("x")`.
        if (node.type === 'element_value_pair' || node.type === 'annotation_argument_list') {
            javaAnnotationElementSites(node, calls, getCurrentEnclosingFunction);
            if (node.type === 'element_value_pair') return true;
        }

        // Detect method references passed as arguments: this::worker, obj::method
        if (node.type === 'method_reference') {
            const nameNode = node.namedChild(node.namedChildCount - 1);
            const objNode = node.namedChild(0);
            if (nameNode && nameNode.type === 'identifier') {
                // `obj::m`, `this::m`, `super::m` (fix #395: `super::m` was a
                // bare name) and qualified `a.b::m` all reference a method.
                const receiver = objNode && !sameNode(objNode, nameNode)
                    ? (['identifier', 'this', 'super'].includes(objNode.type) ? objNode.text
                        : objNode.text.replace(/\s+/g, '') || undefined)
                    : undefined;
                const receiverType = (receiver && receiver !== 'this' && receiver !== 'super' &&
                    objNode.type === 'identifier') ? getReceiverType(receiver) : undefined;
                const enclosingFunction = getCurrentEnclosingFunction();
                calls.push({
                    callSite: typeOrigin('call', nameNode),
                    name: nameNode.text,
                    line: node.startPosition.row + 1,
                    isMethod: !!receiver,
                    receiver,
                    ...(receiverType && { receiverType, ...(getReceiverType(receiver, true) || { receiverTypeSource: 'unknown' }) }),
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
            const declaredTypeQualifier = declTypeNode && declTypeNode.text !== 'var'
                ? extractReceiverTypeQualifier(declTypeNode) : null;
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'variable_declarator') {
                    const nameNode = child.childForFieldName('name');
                    const valueNode = child.childForFieldName('value');
                    // The declared type is the receiver's static type: `Shape s
                    // = new Circle(); s.area()` binds Shape.area and reaches
                    // Circle.area by dispatch (fix #394). `var` takes the
                    // constructed type; a declaration of the constructed
                    // type itself keeps the exact constructor evidence.
                    const constructedType = valueNode?.type === 'object_creation_expression'
                        ? extractTypeName(valueNode.childForFieldName('type'))
                        : null;
                    const constructedQualifier = valueNode?.type === 'object_creation_expression'
                        ? extractReceiverTypeQualifier(valueNode.childForFieldName('type'))
                        : null;
                    const constructorTyped = !!constructedType &&
                        (!declaredType || (constructedType === declaredType &&
                            (constructedQualifier || null) === (declaredTypeQualifier || null)));
                    let typeName = declaredType || constructedType;
                    let typeQualifier = declaredType ? declaredTypeQualifier : constructedQualifier;
                    // fix #381: an effectively-final `var` alias.
                    if (nameNode) localFieldAliases.delete(nameNode.text);
                    const fnNode = !typeName && nameNode && valueNode && declTypeNode?.text === 'var'
                        ? enclosingFunctionNode(node) : null;
                    if (fnNode && valueNode.text !== nameNode.text && !reassignedIn(fnNode, nameNode.text)) {
                        const scopeKey = functionStack[functionStack.length - 1].startLine;
                        if (valueNode.type === 'identifier' && getReceiverType(valueNode.text)) {
                            scopeTypes.get(scopeKey)?.set(nameNode.text, getReceiverType(valueNode.text),
                                getReceiverTypeOrigin(valueNode.text) || 'flow');
                            const qualifier = getReceiverTypeQualifier(valueNode.text);
                            if (qualifier) scopeTypeQualifiers.get(scopeKey)?.set(nameNode.text, qualifier);
                            const raw = getReceiverRawType(valueNode.text);
                            if (raw) scopeRawTypes.get(scopeKey)?.set(nameNode.text, raw);
                        } else if ((valueNode.type === 'field_access' &&
                                valueNode.childForFieldName('object')?.type === 'this' &&
                                valueNode.childForFieldName('field')?.type === 'identifier') ||
                            (valueNode.type === 'identifier' && !isDeclaredLocal(valueNode.text) &&
                                hasEnclosingField(node, valueNode.text))) {
                            localFieldAliases.set(nameNode.text, { node: valueNode, scopeStart: scopeKey });
                        }
                    }
                    if (nameNode && typeName) {
                        const scopeKey = functionStack[functionStack.length - 1].startLine;
                        const typeMap = scopeTypes.get(scopeKey);
                        // A local never reassigned holds exactly the constructed
                        // value: dispatch reaches that type's member, never an
                        // unrelated implementation of the declared type.
                        const fnOfLocal = constructedType && !constructorTyped ? enclosingFunctionNode(node) : null;
                        const origin = fnOfLocal && !reassignedIn(fnOfLocal, nameNode.text)
                            ? { ...typeOrigin('annotation', declTypeNode), constructedType } : null;
                        if (typeMap) typeMap.set(nameNode.text, typeName,
                            origin || (constructorTyped ? 'constructor' : 'annotation'),
                            constructorTyped ? valueNode : declTypeNode);
                        const rawTypeMap = scopeRawTypes.get(scopeKey);
                        const rawType = constructorTyped
                            ? valueNode.childForFieldName('type')?.text
                            : declTypeNode?.text && declTypeNode.text + declaratorDims(child);
                        if (rawType) rawTypeMap?.set(nameNode.text, rawType);
                        const qualifierMap = scopeTypeQualifiers.get(scopeKey);
                        if (typeQualifier) qualifierMap?.set(nameNode.text, typeQualifier);
                        else qualifierMap?.delete(nameNode.text);
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
            // The declared type is the variable's static type; only `var`
            // takes the constructed one (fix #430: `try (ObjectPool<..> pool =
            // new TestObjectPool())` calls ObjectPool's members).
            const declared = resTypeNode && resTypeNode.text !== 'var';
            const constructed = resValueNode?.type === 'object_creation_expression'
                ? resValueNode.childForFieldName('type') : null;
            const typeSource = declared ? resTypeNode : constructed;
            const typeName = typeSource ? extractTypeName(typeSource) : null;
            const typeQualifier = typeSource ? extractReceiverTypeQualifier(typeSource) : null;
            // A resource is final: it holds exactly the constructed value,
            // as a never-reassigned local does (fix #394).
            const constructedType = declared && constructed ? extractTypeName(constructed) : null;
            const exactValue = constructedType && (constructedType !== typeName ||
                (extractReceiverTypeQualifier(constructed) || null) !== (typeQualifier || null));
            if (resNameNode && typeName) {
                const scopeKey = functionStack[functionStack.length - 1].startLine;
                const typeMap = scopeTypes.get(scopeKey);
                if (typeMap) typeMap.set(resNameNode.text, typeName,
                    exactValue ? { ...typeOrigin('with-binding', node), constructedType } : 'with-binding', node);
                const rawTypeMap = scopeRawTypes.get(scopeKey);
                const rawType = typeSource?.text;
                if (rawType) rawTypeMap?.set(resNameNode.text, rawType);
                const qualifierMap = scopeTypeQualifiers.get(scopeKey);
                if (typeQualifier) qualifierMap?.set(resNameNode.text, typeQualifier);
                else qualifierMap?.delete(resNameNode.text);
            }
        }

        return true;
    }, {
        onLeave: (node) => {
            const restore = scopedTypeRestores.get(node.id);
            if (restore) {
                if (restore.had) restore.typeMap.set(restore.name, restore.previous);
                else restore.typeMap.delete(restore.name);
                if (restore.rawTypeMap) {
                    if (restore.rawHad) {
                        restore.rawTypeMap.set(restore.name, restore.rawPrevious);
                    } else {
                        restore.rawTypeMap.delete(restore.name);
                    }
                }
                scopedTypeRestores.delete(node.id);
            }
            if (isFunctionNode(node)) {
                const leaving = functionStack.pop();
                if (leaving) {
                    scopeTypes.delete(leaving.startLine);
                    scopeRawTypes.delete(leaving.startLine);
                    scopeTypeQualifiers.delete(leaving.startLine);
                }
            }
        }
    });

    calls.push(...require('./constructor-bases').implicitBaseCalls(tree.rootNode, 'java'));
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

        // Public interfaces (annotation types are interfaces, fix #389)
        if ((node.type === 'interface_declaration' || node.type === 'annotation_type_declaration') &&
            isPublic(node)) {
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
function staticValueImportSyntax(tree) {
    const imports = [];
    for (const declaration of tree.rootNode.namedChildren) {
        if (declaration.type !== 'import_declaration' ||
            !declaration.children.some(child => child.type === 'static')) continue;
        const path = declaration.namedChildren.find(child =>
            child.type === 'scoped_identifier' || child.type === 'identifier');
        if (!path) continue;
        const wildcard = declaration.children.some(child => child.text === '*');
        const member = path.childForFieldName('name');
        const owner = wildcard ? path : path.childForFieldName('scope');
        if (owner) imports.push({ member: wildcard ? '*' : member?.text,
            type: owner, token: wildcard ? null : member });
    }
    return imports;
}

/**
 * Whether a pattern variable's scope (JLS 6.3.1) holds a reference (fix
 * #420): 'in' (the reference names the pattern variable), 'out' (the
 * variable is not in scope there) or 'unknown'. A switch-label pattern
 * reaches its arm; an `instanceof` pattern follows the boolean structure
 * of its condition (`&&`, `||`, `!`, `?:`, if/while conditions) and, when
 * introduced while false, the statements after an `if` whose branch
 * cannot complete normally.
 */
function patternBindingReach(binding, reference) {
    const within = (outer, inner) => !!outer && outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;
    if (reference.startIndex <= binding.startIndex) return 'out';
    for (let node = binding.parent; node; node = node.parent) {
        if (node.type === 'switch_label') {
            const arm = node.parent;
            return arm && (arm.type === 'switch_rule' || arm.type === 'switch_block_statement_group') &&
                within(arm, reference) ? 'in' : 'out';
        }
        if (node.type === 'instanceof_expression') return instanceofReach(node, reference, within);
        if (/_statement$|^block$|_declaration$|lambda_expression/.test(node.type)) break;
    }
    return 'unknown';
}

function instanceofReach(expression, reference, within) {
    // A statement that cannot complete normally (null: undecided).
    const abrupt = statement => {
        if (!statement) return false;
        if (['return_statement', 'throw_statement', 'break_statement', 'continue_statement',
            'yield_statement'].includes(statement.type)) return true;
        if (statement.type === 'block') {
            const last = statement.namedChildren.filter(child => !child.type.includes('comment')).pop();
            return last ? abrupt(last) : false;
        }
        if (['expression_statement', 'local_variable_declaration'].includes(statement.type)) return false;
        return null;
    };
    let polarity = true;
    let node = expression;
    for (;;) {
        const parent = node.parent;
        if (!parent) return 'unknown';
        if (parent.type === 'parenthesized_expression') { node = parent; continue; }
        if (parent.type === 'unary_expression' && parent.childForFieldName('operator')?.type === '!') {
            polarity = !polarity;
            node = parent;
            continue;
        }
        if (parent.type === 'binary_expression') {
            const operator = parent.childForFieldName('operator')?.type;
            if (operator !== '&&' && operator !== '||') return 'out';
            if (within(parent.childForFieldName('left'), node) && within(parent.childForFieldName('right'), reference)) {
                return (operator === '&&') === polarity ? 'in' : 'out';
            }
            if ((operator === '&&') !== polarity) return 'out';
            node = parent;
            continue;
        }
        if (parent.type === 'ternary_expression' && within(parent.childForFieldName('condition'), node)) {
            if (within(parent.childForFieldName('consequence'), reference)) return polarity ? 'in' : 'out';
            if (within(parent.childForFieldName('alternative'), reference)) return polarity ? 'out' : 'in';
            return 'out';
        }
        if (['while_statement', 'for_statement', 'do_statement'].includes(parent.type) &&
            within(parent.childForFieldName('condition'), node)) {
            if (within(parent.childForFieldName('body'), reference)) {
                return parent.type !== 'do_statement' && polarity ? 'in' : 'out';
            }
            if (within(parent, reference)) return 'out';
            // After a loop exited through its condition only.
            return polarity ? 'out' : 'unknown';
        }
        if (parent.type === 'if_statement' && within(parent.childForFieldName('condition'), node)) {
            const consequence = parent.childForFieldName('consequence');
            const alternative = parent.childForFieldName('alternative');
            if (within(consequence, reference)) return polarity ? 'in' : 'out';
            if (alternative && within(alternative, reference)) return polarity ? 'out' : 'in';
            if (within(parent, reference)) return 'out';
            // The statements after the `if` in its block (JLS 6.3.2.2).
            const block = parent.parent;
            if (!block || !within(block, reference) || !['block', 'switch_block_statement_group',
                'constructor_body'].includes(block.type)) return 'out';
            const taken = polarity ? alternative : consequence;
            const other = polarity ? consequence : alternative;
            if (polarity && !alternative) return 'out';
            const takenAbrupt = abrupt(taken), otherAbrupt = other ? abrupt(other) : false;
            if (takenAbrupt === null || otherAbrupt === null) return 'unknown';
            return takenAbrupt && !otherAbrupt ? 'in' : 'out';
        }
        return 'out';
    }
}

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
            // Definition: interface / annotation type / annotation element name
            else if ((parent.type === 'interface_declaration' ||
                      parent.type === 'annotation_type_declaration' ||
                      parent.type === 'annotation_type_element_declaration') &&
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

/** Omitted base initializer calls of one class, read as findCallsInCode reads them (fix #421). */
function implicitBaseCallsOf(code, parser, ownerLine, ownerEndLine) {
    return require('./constructor-bases').implicitBaseCallsOfOwner(parseTree(parser, code).rootNode, 'java', null,
        ownerLine, ownerEndLine);
}

module.exports = {
    recoverTypeAnnotatedVarargs,
    implicitOwnerScope: node => ({ enclosingType: enclosingTypeName(node) }),
    implicitBaseCallsOf,
    staticValueImportSyntax,
    patternBindingReach,
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
