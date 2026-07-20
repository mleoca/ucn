/**
 * languages/javascript.js - Tree-sitter based JS/TS/TSX parsing
 *
 * Handles: function declarations, arrow functions, class declarations,
 * interfaces, type aliases, enums, and state objects.
 */

const {
    traverseTree,
    traverseTreeCached,
    nodeToLocation,
    extractParams,
    parseStructuredParams,
    extractJSDocstring,
    buildTypeAnnotations,
    visitNameNodes,
    sameNode,
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
 * Base type name from a type-alias target (fix #208, TS): ZodType<any, any>
 * → ZodType, ns.Type → Type, (T) → T. Unions, intersections, object/function
 * types, mapped/conditional types, and predefined types return null — they
 * are not single-type identities a method receiver can be resolved through.
 */
function aliasBaseTypeName(typeNode) {
    if (!typeNode) return null;
    if (typeNode.type === 'type_identifier') return typeNode.text;
    if (typeNode.type === 'nested_type_identifier') {
        return typeNode.childForFieldName('name')?.text || null;
    }
    if (typeNode.type === 'generic_type') {
        return aliasBaseTypeName(typeNode.childForFieldName('name') || typeNode.namedChild(0));
    }
    if (typeNode.type === 'parenthesized_type') {
        return aliasBaseTypeName(typeNode.namedChild(0));
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

/** True when a declaration is outside every function/class body. */
function isModuleScope(node) {
    let current = node && node.parent;
    while (current) {
        if (current.type === 'function_declaration' || current.type === 'arrow_function' ||
            current.type === 'function_expression' || current.type === 'method_definition' ||
            current.type === 'generator_function_declaration' || current.type === 'generator_function' ||
            current.type === 'class_body') {
            return false;
        }
        if (current.type === 'program' || current.type === 'module') return true;
        current = current.parent;
    }
    return false;
}

/** Unwrap common type/runtime wrappers around an object-literal registry. */
function unwrapObjectRegistry(node) {
    let current = node;
    while (current && (current.type === 'parenthesized_expression' ||
        current.type === 'as_expression' || current.type === 'satisfies_expression' ||
        current.type === 'type_assertion')) {
        current = current.namedChild(0);
    }
    if (current && current.type === 'object') return current;
    if (current && current.type === 'call_expression') {
        const callee = current.childForFieldName('function');
        if (callee && (callee.text === 'Object.freeze' || callee.text === 'Object.seal')) {
            const args = current.childForFieldName('arguments');
            const first = args && args.namedChild(0);
            return unwrapObjectRegistry(first);
        }
    }
    return null;
}

function objectPropertyName(nameNode) {
    if (!nameNode) return null;
    if (nameNode.type === 'identifier' || nameNode.type === 'property_identifier') return nameNode.text;
    if (nameNode.type === 'string') {
        const raw = nameNode.text;
        if (raw.length >= 2 && raw[0] === raw[raw.length - 1]) return raw.slice(1, -1);
    }
    return null;
}

/**
 * Index function-valued object properties. Module-scope objects are dynamic
 * dispatch surfaces (`HANDLERS[command](...)`); without symbols for their
 * members, calls inside them are orphaned and reachability/deadcode lie.
 */
function appendObjectFunctionMembers(objectNode, functions, lines, extraFields = {}) {
    if (!objectNode) return 0;
    let added = 0;
    for (let i = 0; i < objectNode.namedChildCount; i++) {
        const prop = objectNode.namedChild(i);
        let nameNode = null;
        let fnNode = null;
        if (prop.type === 'method_definition') {
            nameNode = prop.childForFieldName('name');
            fnNode = prop;
        } else if (prop.type === 'pair') {
            const value = prop.childForFieldName('value');
            if (value && (value.type === 'function_expression' || value.type === 'arrow_function' ||
                value.type === 'generator_function')) {
                nameNode = prop.childForFieldName('key');
                fnNode = value;
            }
        }
        const name = objectPropertyName(nameNode);
        if (!name || !fnNode) continue;

        const paramsNode = fnNode.childForFieldName('parameters');
        const { startLine, endLine, indent } = nodeToLocation(prop, lines);
        const returnType = extractReturnType(fnNode);
        const generics = extractGenerics(fnNode);
        const docstring = extractJSDocstring(lines, startLine);
        const paramsStructured = parseStructuredParams(paramsNode, 'javascript');
        const typeAnno = buildTypeAnnotations(paramsStructured, returnType, lines, startLine, true);
        const modifiers = extractModifiers(fnNode);
        functions.push({
            name,
            params: extractParams(paramsNode),
            paramsStructured,
            startLine,
            endLine,
            indent,
            isArrow: fnNode.type === 'arrow_function',
            isGenerator: isGenerator(fnNode),
            isAsync: modifiers.includes('async'),
            modifiers,
            memberAssigned: true,
            registryMember: true,
            ...extraFields,
            ...typeAnno,
            ...(generics && { generics }),
            ...(docstring && { docstring }),
        });
        added++;
    }
    return added;
}

/**
 * Extract modifiers from a declaration NODE — AST tokens, never text
 * (fix #249: the first-line regex fabricated export/async/default from
 * string literals, comments, and `m?.default?.()` on one-line functions,
 * leaking fake exports into api/fileExports and corrupting isAsync).
 * Accepts the declaration or its export_statement wrapper.
 */
function extractModifiers(node) {
    const mods = [];
    if (!node) return mods;
    let decl = node;
    if (node.type === 'export_statement') {
        mods.push('export');
        decl = node.childForFieldName('declaration') || node;
    }
    // Resolve to the actual function-shaped node: `const x = async () => {}`
    // keeps its async token on the arrow, not the declaration.
    if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
        const declarator = decl.namedChildren.find(c => c.type === 'variable_declarator');
        const value = declarator && declarator.childForFieldName('value');
        if (value) decl = value;
    }
    let isAsync = false;
    for (let i = 0; i < decl.childCount; i++) {
        if (decl.child(i).type === 'async') { isAsync = true; break; }
    }
    if (isAsync) mods.push('async');
    if (node.type === 'export_statement') {
        for (let i = 0; i < node.childCount; i++) {
            if (node.child(i).type === 'default') { mods.push('default'); break; }
        }
    }
    return mods;
}

/**
 * Extract decorators from a JS/TS class or method node.
 * In tree-sitter-javascript/typescript, decorators are direct children of the node.
 * @param {object} node - AST node (class_declaration, method_definition, etc.)
 * @returns {string[]} Array of decorator names (without @)
 */
function extractDecorators(node) {
    const decorators = [];
    const consume = (n) => {
        if (n.type !== 'decorator') return;
        let text = n.text.replace(/^@/, '');
        const parenIdx = text.indexOf('(');
        if (parenIdx > 0) text = text.substring(0, parenIdx);
        decorators.push(text);
    };

    // 1. Direct children — covers most class/method decorators.
    for (let i = 0; i < node.namedChildCount; i++) {
        consume(node.namedChild(i));
    }

    // 2. When a class/function is wrapped in `export class …`, tree-sitter
    //    wraps it in an `export_statement`. The decorator becomes a sibling
    //    of the inner declaration *inside* that export_statement. Walk the
    //    wrapper's children for any decorator preceding the inner node.
    if (node.parent && node.parent.type === 'export_statement') {
        const wrapper = node.parent;
        let myIdx = -1;
        for (let i = 0; i < wrapper.namedChildCount; i++) {
            if (wrapper.namedChild(i).id === node.id) { myIdx = i; break; }
        }
        for (let i = myIdx - 1; i >= 0; i--) {
            const sib = wrapper.namedChild(i);
            if (sib.type === 'decorator') consume(sib);
            else break;
        }
    }

    // 3. Some grammars place decorators as preceding siblings of the
    //    declaration itself (rather than wrapping in export_statement).
    //    Walk back from this node within its parent.
    if (node.parent && node.parent.type !== 'export_statement') {
        const parent = node.parent;
        let myIdx = -1;
        for (let i = 0; i < parent.namedChildCount; i++) {
            if (parent.namedChild(i).id === node.id) { myIdx = i; break; }
        }
        for (let i = myIdx - 1; i >= 0; i--) {
            const sib = parent.namedChild(i);
            if (sib.type === 'decorator') consume(sib);
            else break;
        }
    }
    return decorators;
}

/**
 * Extract decorators along with their string-literal first argument.
 * Returns array of { name, args, firstStringArg } where:
 *   - name is the decorator name (no @)
 *   - args is the raw argument text (without outer parens), or null
 *   - firstStringArg is the literal value of the first string-literal argument, or null
 *
 *   @Get(':id')               → { name: 'Get', args: "':id'", firstStringArg: ':id' }
 *   @Controller('/api/users') → { name: 'Controller', args: "'/api/users'", firstStringArg: '/api/users' }
 *   @Injectable               → { name: 'Injectable', args: null, firstStringArg: null }
 *
 * Used by route extraction (NestJS, etc.) — only the firstStringArg is currently
 * consumed by core/bridge.js, but `args` is preserved for future structural-search use.
 */
function extractDecoratorsWithArgs(node) {
    const result = [];
    const { extractStringArg } = require('./utils');

    const consume = (n) => {
        if (n.type !== 'decorator') return;
        // tree-sitter-javascript: decorator has a single 'expression' child.
        // Look for call_expression vs identifier vs member_expression.
        let inner = null;
        for (let i = 0; i < n.namedChildCount; i++) {
            const c = n.namedChild(i);
            if (!c.type.endsWith('comment')) { inner = c; break; }
        }
        if (!inner) return;

        if (inner.type === 'call_expression') {
            const fn = inner.childForFieldName('function');
            const argsNode = inner.childForFieldName('arguments');
            if (!fn || !argsNode) return;
            const name = fn.text;
            // Get raw arg text without the surrounding parens
            const argsText = argsNode.text.replace(/^\(|\)$/g, '');
            // Find first string-literal arg
            let firstStringArg = null;
            for (let j = 0; j < argsNode.namedChildCount; j++) {
                const arg = argsNode.namedChild(j);
                if (arg.type.endsWith('comment')) continue;
                const s = extractStringArg(arg);
                if (s && !s.interp) { firstStringArg = s.value; break; }
                if (s) { firstStringArg = s.value; break; }
                break;
            }
            result.push({ name, args: argsText, firstStringArg });
        } else if (inner.type === 'identifier' || inner.type === 'member_expression') {
            // Plain decorator: @Injectable
            result.push({ name: inner.text, args: null, firstStringArg: null });
        }
    };

    // Same traversal as extractDecorators
    for (let i = 0; i < node.namedChildCount; i++) {
        consume(node.namedChild(i));
    }
    if (node.parent && node.parent.type === 'export_statement') {
        const wrapper = node.parent;
        let myIdx = -1;
        for (let i = 0; i < wrapper.namedChildCount; i++) {
            if (wrapper.namedChild(i).id === node.id) { myIdx = i; break; }
        }
        for (let i = myIdx - 1; i >= 0; i--) {
            const sib = wrapper.namedChild(i);
            if (sib.type === 'decorator') consume(sib);
            else break;
        }
    }
    if (node.parent && node.parent.type !== 'export_statement') {
        const parent = node.parent;
        let myIdx = -1;
        for (let i = 0; i < parent.namedChildCount; i++) {
            if (parent.namedChild(i).id === node.id) { myIdx = i; break; }
        }
        for (let i = myIdx - 1; i >= 0; i--) {
            const sib = parent.namedChild(i);
            if (sib.type === 'decorator') consume(sib);
            else break;
        }
    }
    return result;
}

// --- Single-pass helpers: extracted from find* callbacks ---

/**
 * Process a node for function extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 */
function _processFunction(node, functions, processedRanges, lines) {
    const rangeKey = `${node.startIndex}-${node.endIndex}`;

    // Function declarations
    if (node.type === 'function_declaration' || node.type === 'generator_function_declaration') {
        if (processedRanges.has(rangeKey)) return false;
        processedRanges.add(rangeKey);

        const nameNode = node.childForFieldName('name');
        const paramsNode = node.childForFieldName('parameters');

        if (nameNode) {
            const { startLine, endLine, indent } = nodeToLocation(node, lines);
            const returnType = extractReturnType(node);
            const generics = extractGenerics(node);
            const docstring = extractJSDocstring(lines, startLine);
            const isGen = isGenerator(node);
            const paramsStructured = parseStructuredParams(paramsNode, 'javascript');
            const typeAnno = buildTypeAnnotations(paramsStructured, returnType, lines, startLine, true);
            // Check parent for export status (function_declaration inside export_statement)
            const modifiers = node.parent && node.parent.type === 'export_statement'
                ? extractModifiers(node.parent)
                : extractModifiers(node);
            // Feature B: explicit isAsync flag (auditAsync needs to know whether
            // the fn was declared `async function`).
            const isAsync = modifiers.includes('async');

            functions.push({
                name: nameNode.text,
                params: extractParams(paramsNode),
                paramsStructured,
                startLine,
                endLine,
                indent,
                isArrow: false,
                isGenerator: isGen,
                isAsync,
                modifiers,
                ...typeAnno,
                ...(generics && { generics }),
                ...(docstring && { docstring })
            });
        }
        return true;
    }

    // Named function expressions used as callbacks have a real lexical
    // definition even when no variable owns them: `test('x', function run()
    // {})`.  Property/variable assignments are handled by their binding
    // branches below; indexing the expression name there as a second symbol
    // would manufacture a duplicate public definition.
    if (node.type === 'function_expression' || node.type === 'generator_function') {
        const parent = node.parent;
        const isBoundValue = (parent?.type === 'variable_declarator' &&
                sameNode(parent.childForFieldName('value'), node)) ||
            (parent?.type === 'assignment_expression' &&
                sameNode(parent.childForFieldName('right'), node)) ||
            (parent?.type === 'pair' && sameNode(parent.childForFieldName('value'), node));
        const nameNode = node.childForFieldName('name');
        if (!isBoundValue && nameNode && !processedRanges.has(rangeKey)) {
            processedRanges.add(rangeKey);
            const paramsNode = node.childForFieldName('parameters');
            const { startLine, endLine, indent } = nodeToLocation(node, lines);
            const returnType = extractReturnType(node);
            const generics = extractGenerics(node);
            const paramsStructured = parseStructuredParams(paramsNode, 'javascript');
            const typeAnno = buildTypeAnnotations(paramsStructured, returnType, lines, startLine, true);
            const docstring = extractJSDocstring(lines, startLine);
            functions.push({
                name: nameNode.text,
                params: extractParams(paramsNode),
                paramsStructured,
                startLine,
                endLine,
                indent,
                isArrow: false,
                isGenerator: isGenerator(node),
                isAsync: node.text.trimStart().startsWith('async '),
                modifiers: [],
                // ECMA-262: a FunctionExpression's BindingIdentifier is in
                // scope only within its own body — the name creates no
                // file-level binding (never enters the bindings table) and
                // the expression is consumed where it appears (argument /
                // value position), so deadcode never audits it.
                bodyScopedName: true,
                ...typeAnno,
                ...(generics && { generics }),
                ...(docstring && { docstring })
            });
        }
        return true;
    }

    // TypeScript function signatures (e.g., in .d.ts files)
    if (node.type === 'function_signature') {
        if (processedRanges.has(rangeKey)) return false;
        processedRanges.add(rangeKey);

        const nameNode = node.childForFieldName('name');
        const paramsNode = node.childForFieldName('parameters');

        if (nameNode) {
            const { startLine, endLine, indent } = nodeToLocation(node, lines);
            const returnType = extractReturnType(node);
            const generics = extractGenerics(node);
            const docstring = extractJSDocstring(lines, startLine);
            const paramsStructured = parseStructuredParams(paramsNode, 'typescript');
            const typeAnno = buildTypeAnnotations(paramsStructured, returnType, lines, startLine, true);

            functions.push({
                name: nameNode.text,
                params: extractParams(paramsNode),
                paramsStructured,
                startLine,
                endLine,
                indent,
                isArrow: false,
                isGenerator: false,
                isSignature: true,
                modifiers: [],
                ...typeAnno,
                ...(generics && { generics }),
                ...(docstring && { docstring })
            });
        }
        return true;
    }

    // Variable declarations with arrow functions or function expressions
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
        if (processedRanges.has(rangeKey)) return false;

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
                        const { startLine, endLine, indent } = nodeToLocation(node, lines);
                        const returnType = extractReturnType(valueNode);
                        const generics = extractGenerics(valueNode);
                        const docstring = extractJSDocstring(lines, startLine);
                        const isGen = isGenerator(valueNode);
                        const paramsStructured = parseStructuredParams(paramsNode, 'javascript');
                        const typeAnno = buildTypeAnnotations(paramsStructured, returnType, lines, startLine, true);
                        // Check parent for export status (lexical_declaration inside export_statement)
                        const modifiers = node.parent && node.parent.type === 'export_statement'
                            ? extractModifiers(node.parent)
                            : extractModifiers(node);
                        // Feature B: detect async — for arrow/fn-expressions the `async`
                        // keyword precedes the parameter list on the value node, NOT on
                        // the lexical_declaration text. extractModifiers walked the full
                        // declaration text, so we double-check the value node directly.
                        const valueIsAsync = valueNode.text.trimStart().startsWith('async ');
                        const isAsync = valueIsAsync || modifiers.includes('async');

                        functions.push({
                            name: nameNode.text,
                            params: extractParams(paramsNode),
                            paramsStructured,
                            startLine,
                            endLine,
                            indent,
                            isArrow,
                            isGenerator: isGen,
                            isAsync,
                            modifiers,
                            ...typeAnno,
                            ...(generics && { generics }),
                            ...(docstring && { docstring })
                        });
                    }

                    // React wrapper patterns: React.forwardRef(...), React.memo(...), forwardRef(...), memo(...)
                    // const Button = React.forwardRef<Props, Ref>((props, ref) => ...)
                    // const Memoized = memo((props) => ...)
                    if (!isArrow && !isFnExpr && valueNode.type === 'call_expression') {
                        const funcNode = valueNode.childForFieldName('function');
                        if (funcNode) {
                            let wrapperName = null;
                            if (funcNode.type === 'member_expression') {
                                const prop = funcNode.childForFieldName('property');
                                wrapperName = prop?.text;
                            } else if (funcNode.type === 'identifier') {
                                wrapperName = funcNode.text;
                            }
                            if (wrapperName === 'forwardRef' || wrapperName === 'memo') {
                                const argsNode = valueNode.childForFieldName('arguments');
                                if (argsNode && argsNode.namedChildCount > 0) {
                                    const innerFn = argsNode.namedChild(0);
                                    if (innerFn && (innerFn.type === 'arrow_function' || innerFn.type === 'function_expression')) {
                                        processedRanges.add(rangeKey);
                                        const paramsNode = innerFn.childForFieldName('parameters');
                                        const { startLine, endLine, indent } = nodeToLocation(node, lines);
                                        const returnType = extractReturnType(innerFn);
                                        const generics = extractGenerics(innerFn);
                                        const docstring = extractJSDocstring(lines, startLine);
                                        const paramsStructured = parseStructuredParams(paramsNode, 'javascript');
                                        const typeAnno = buildTypeAnnotations(paramsStructured, returnType, lines, startLine, true);
                                        const modifiers = node.parent && node.parent.type === 'export_statement'
                                            ? extractModifiers(node.parent)
                                            : extractModifiers(node);

                                        functions.push({
                                            name: nameNode.text,
                                            params: extractParams(paramsNode),
                                            paramsStructured,
                                            startLine,
                                            endLine,
                                            indent,
                                            isArrow: innerFn.type === 'arrow_function',
                                            isGenerator: false,
                                            modifiers,
                                            ...typeAnno,
                                            ...(generics && { generics }),
                                            ...(docstring && { docstring })
                                        });
                                    }
                                }
                            }
                        }
                    }

                    // Module-scope dispatch tables (including Object.freeze /
                    // Object.seal wrappers). These handlers are invoked through
                    // computed property access, so a plain name-based call graph
                    // cannot discover their incoming edge. Index them explicitly
                    // and let reachability treat them as conservative roots.
                    if (!isArrow && !isFnExpr && isModuleScope(node)) {
                        const registryObject = unwrapObjectRegistry(valueNode);
                        if (registryObject) {
                            const added = appendObjectFunctionMembers(registryObject, functions, lines, {
                                registryContainer: nameNode.text,
                            });
                            if (added > 0) processedRanges.add(rangeKey);
                        }
                    }
                }
            }
        }
        return true;
    }

    // Assignment expressions: obj.method = function() {} or prototype assignments
    if (node.type === 'assignment_expression') {
        if (processedRanges.has(rangeKey)) return false;

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
            // A nested property assignment still defines that object's
            // callable member (`reply.send = () => {}`).  Only a nested bare
            // assignment lacks a new symbol binding and stays excluded.
            if (!isTopLevel && leftNode?.type !== 'member_expression') return true;
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
                    const { startLine, endLine, indent } = nodeToLocation(node, lines);
                    const returnType = extractReturnType(rightNode);
                    const generics = extractGenerics(rightNode);
                    const docstring = extractJSDocstring(lines, startLine);
                    const isGen = isGenerator(rightNode);
                    const paramsStructured = parseStructuredParams(paramsNode, 'javascript');
                    const typeAnno = buildTypeAnnotations(paramsStructured, returnType, lines, startLine, true);

                    functions.push({
                        name,
                        params: extractParams(paramsNode),
                        paramsStructured,
                        startLine,
                        endLine,
                        indent,
                        isArrow,
                        isGenerator: isGen,
                        modifiers: [],
                        // A property-assignment def (Reply.prototype.serialize
                        // = function, exports.h = () => ...) creates NO
                        // lexical name — a bare call in the file can never
                        // bind it (fix #269, fastify-measured: the prototype
                        // def stole the module-scope binding from the free
                        // `function serialize(...)` below it). Prototype
                        // assignments carry their class so typed-receiver
                        // method resolution reaches them.
                        ...(leftNode.type === 'member_expression' && { memberAssigned: true }),
                        ...(leftNode.type === 'member_expression' &&
                            /^([A-Za-z_$][\w$]*)\.prototype\.[A-Za-z_$][\w$]*$/.test(leftNode.text) &&
                            { className: leftNode.text.split('.')[0], isMethod: true }),
                        ...typeAnno,
                        ...(generics && { generics }),
                        ...(docstring && { docstring })
                    });
                }
            } else if (rightNode.type === 'object') {
                // CJS export object maps (fix #252): the functions in
                // `module.exports = { doThing(x) {...}, h: function() {...} }`
                // are the module's public API — prototype and exports.h
                // assignments were indexed while this shape was invisible
                // to fn/find/toc.
                const lhsText = leftNode.text;
                if (lhsText === 'module.exports' || lhsText === 'exports' ||
                    lhsText.startsWith('module.exports.') || lhsText.startsWith('exports.')) {
                    processedRanges.add(rangeKey);
                    appendObjectFunctionMembers(rightNode, functions, lines, {
                        registryContainer: lhsText,
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
                    const { startLine, endLine, indent } = nodeToLocation(node, lines);
                    const returnType = extractReturnType(child);
                    const generics = extractGenerics(child);
                    const docstring = extractJSDocstring(lines, startLine);
                    const isGen = isGenerator(child);
                    const paramsStructured = parseStructuredParams(paramsNode, 'javascript');
                    const typeAnno = buildTypeAnnotations(paramsStructured, returnType, lines, startLine, true);

                    functions.push({
                        name: 'default',
                        params: extractParams(paramsNode),
                        paramsStructured,
                        startLine,
                        endLine,
                        indent,
                        isArrow: child.type === 'arrow_function',
                        isGenerator: isGen,
                        modifiers: ['export', 'default'],
                        ...typeAnno,
                        ...(generics && { generics }),
                        ...(docstring && { docstring })
                    });
                    return true;
                }
            }
        }
        return true;
    }

    return false;
}

/**
 * Find all functions in JS/TS code using tree-sitter
 * @param {string} code - Source code
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array}
 */
function findFunctions(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const functions = [];
    const processedRanges = new Set();
    traverseTreeCached(tree.rootNode, (node) => {
        _processFunction(node, functions, processedRanges, lines);
        return true;
    });
    functions.sort((a, b) => a.startLine - b.startLine);
    return functions;
}

/**
 * Process a node for class/interface/type/enum extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 */
function _processClass(node, classes, processedRanges, lines) {
    // Class declarations (including abstract classes)
    if (node.type === 'class_declaration' || node.type === 'class' || node.type === 'abstract_class_declaration') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const { startLine, endLine } = nodeToLocation(node, lines);
            const members = extractClassMembers(node, lines);
            const docstring = extractJSDocstring(lines, startLine);
            const generics = extractGenerics(node);
            const extendsInfo = extractExtends(node);
            const implementsInfo = extractImplements(node);
            const decorators = extractDecorators(node);
            const decoratorsWithArgs = extractDecoratorsWithArgs(node);

            const isAbstract = node.type === 'abstract_class_declaration';
            classes.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'class',
                members,
                ...(isAbstract && { modifiers: ['abstract'] }),
                ...(docstring && { docstring }),
                ...(generics && { generics }),
                ...(extendsInfo && { extends: extendsInfo }),
                ...(implementsInfo.length > 0 && { implements: implementsInfo }),
                ...(decorators.length > 0 && { decorators }),
                ...(decoratorsWithArgs.some(d => d.firstStringArg) && { decoratorsWithArgs })
            });
        }
        return true;
    }

    // TypeScript interface declarations
    if (node.type === 'interface_declaration') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const { startLine, endLine } = nodeToLocation(node, lines);
            const docstring = extractJSDocstring(lines, startLine);
            const generics = extractGenerics(node);
            const extendsInfo = extractInterfaceExtends(node);
            const members = extractInterfaceMembers(node, lines);

            classes.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'interface',
                members,
                ...(docstring && { docstring }),
                ...(generics && { generics }),
                ...(extendsInfo.length > 0 && { extends: extendsInfo.join(', ') })
            });
        }
        return true;
    }

    // TypeScript type alias declarations
    if (node.type === 'type_alias_declaration') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const { startLine, endLine } = nodeToLocation(node, lines);
            const docstring = extractJSDocstring(lines, startLine);
            // `type ZodTypeAny = ZodType<any, any, any>;` — the alias IS the
            // aliased type. Record the base name so receivers annotated with
            // the alias validate against the base type's methods (fix #208,
            // TS parity with Rust/Go).
            const aliasOf = aliasBaseTypeName(node.childForFieldName('value'));

            classes.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'type',
                members: [],
                ...(aliasOf && { aliasOf }),
                ...(docstring && { docstring })
            });
        }
        return true;
    }

    // TypeScript enum declarations
    if (node.type === 'enum_declaration') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const { startLine, endLine } = nodeToLocation(node, lines);
            const docstring = extractJSDocstring(lines, startLine);
            const members = extractEnumMembers(node, lines);

            classes.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'enum',
                members,
                ...(docstring && { docstring })
            });
        }
        return true;
    }

    // TypeScript namespace/module declarations
    if (node.type === 'internal_module' || node.type === 'module') {
        const nameNode = node.childForFieldName('name');
        // A STRING-named module declaration (`declare module '../vanilla'`)
        // is a module AUGMENTATION/shape declaration, not a nameable symbol
        // (fix #267, zustand-measured): it declares no identifier project
        // code can reference, so indexing it as a namespace made deadcode
        // claim every augmentation block dead (5 FALSE-DEADs on zustand's
        // StoreMutators augmentations). The compiler merges it into the
        // TARGET module — never claimable, never importable by this "name".
        if (nameNode && nameNode.type !== 'string') {
            const { startLine, endLine } = nodeToLocation(node, lines);
            const docstring = extractJSDocstring(lines, startLine);

            classes.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'namespace',
                members: [],
                ...(docstring && { docstring })
            });
        }
        // Matched but continue traversal to find inner functions/classes
        return true;
    }

    return false;
}

/**
 * Find all classes, interfaces, types, and enums
 * @param {string} code - Source code
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array}
 */
function findClasses(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const classes = [];
    const processedRanges = new Set();
    traverseTreeCached(tree.rootNode, (node) => {
        const matched = _processClass(node, classes, processedRanges, lines);
        // Skip subtrees for class/interface/type/enum (but not namespace)
        if (matched && node.type !== 'internal_module' && node.type !== 'module') {
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
 * Split comma-separated type names, respecting angle bracket nesting.
 * "Bar<A, B>, Baz" → ["Bar<A, B>", "Baz"]
 */
function splitTypeList(text) {
    const result = [];
    let depth = 0;
    let current = '';
    for (const ch of text) {
        if (ch === '<') depth++;
        else if (ch === '>') depth--;
        if (ch === ',' && depth === 0) {
            result.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) result.push(current.trim());
    return result;
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
                const names = splitTypeList(implMatch[1]);
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
            // Parse comma-separated type names respecting generics
            const text = child.text.replace(/^extends\s+/, '');
            const names = splitTypeList(text);
            extends_.push(...names);
        }
    }
    return extends_;
}

/**
 * Extract interface members (method signatures, property signatures)
 */
function extractInterfaceMembers(interfaceNode, code) {
    const members = [];
    const bodyNode = interfaceNode.childForFieldName('body');
    if (!bodyNode) return members;

    for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const child = bodyNode.namedChild(i);

        if (child.type === 'method_signature') {
            const nameNode = child.childForFieldName('name');
            const paramsNode = child.childForFieldName('parameters');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(child, code);
                const returnType = extractReturnType(child);
                const paramsStructured = parseStructuredParams(paramsNode, 'javascript');
                const typeAnno = buildTypeAnnotations(paramsStructured, returnType, code, startLine, true);
                members.push({
                    name: nameNode.text,
                    params: extractParams(paramsNode),
                    paramsStructured,
                    startLine,
                    endLine,
                    memberType: 'method',
                    isMethod: true,
                    ...typeAnno
                });
            }
        } else if (child.type === 'property_signature') {
            const nameNode = child.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(child, code);
                // Declared property type (fix #219): raw annotation text —
                // findCallers hops field receivers to it (this._map.has()),
                // and function-typed properties ((arg) => T) count as
                // callable owners in the dispatch tiering.
                const typeNode = child.childForFieldName('type');
                const fieldType = typeNode ? typeNode.text.replace(/^:\s*/, '').trim() : undefined;
                members.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    memberType: 'field',
                    ...(fieldType && { fieldType })
                });
            }
        }
    }
    return members;
}

/**
 * Extract enum members (name and optional value)
 */
function extractEnumMembers(enumNode, code) {
    const members = [];
    const bodyNode = enumNode.childForFieldName('body');
    if (!bodyNode) return members;

    for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const child = bodyNode.namedChild(i);
        if (child.type === 'enum_assignment') {
            const nameNode = child.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(child, code);
                members.push({ name: nameNode.text, startLine, endLine, memberType: 'field' });
            }
        } else if (child.type === 'property_identifier') {
            const { startLine, endLine } = nodeToLocation(child, code);
            members.push({ name: child.text, startLine, endLine, memberType: 'field' });
        }
    }
    return members;
}

/**
 * Extract class members
 */
function extractClassMembers(classNode, codeOrLines) {
    const code = codeOrLines; // Accept either string or lines array (nodeToLocation handles both)
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

                // Collect decorators from preceding siblings in the class body
                const decorators = [];
                for (let j = i - 1; j >= 0; j--) {
                    const prev = bodyNode.namedChild(j);
                    if (prev.type === 'decorator') {
                        let dText = prev.text.replace(/^@/, '');
                        const parenIdx = dText.indexOf('(');
                        if (parenIdx > 0) dText = dText.substring(0, parenIdx);
                        decorators.unshift(dText);
                    } else {
                        break;
                    }
                }

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
                const paramsStructured = parseStructuredParams(paramsNode, 'javascript');
                const typeAnno = buildTypeAnnotations(paramsStructured, returnType, code, startLine, true);

                const decoratorsWithArgs = extractDecoratorsWithArgs(child);
                // TS accessibility keywords (fix #247): `private`/`protected`
                // members are not public API — without this, deadcode's
                // exported-member check treated them as implicitly public and
                // hid them from the default audit. `public` is the default
                // and stays unrecorded (recording it would read as an export
                // marker in symbolIsExported).
                const accessMatch = text.match(/^\s*(private|protected)\s/);
                members.push({
                    name,
                    params: extractParams(paramsNode),
                    paramsStructured,
                    startLine,
                    endLine,
                    memberType,
                    ...(accessMatch && { modifiers: [accessMatch[1]] }),
                    isAsync,
                    isGenerator: isGen,
                    isMethod: true,  // Mark as method for context() lookups
                    // TS method OVERLOAD signatures (body-less method_signature
                    // in a class body) mirror the standalone-function marker
                    // (fix #230) — pickBestDefinition prefers the implementation.
                    ...(child.type === 'method_signature' && { isSignature: true }),
                    ...typeAnno,
                    ...(docstring && { docstring }),
                    ...(decorators.length > 0 && { decorators }),
                    ...(decoratorsWithArgs.length > 0 && { decoratorsWithArgs })
                });

                // TypeScript constructor parameter-properties are declared
                // fields, not ordinary parameters. Index them from the AST so
                // `constructor(private repo: Repository)` gives
                // `this.repo.save()` compiler-visible receiver evidence.
                // Accessibility and `readonly` are syntax tokens on the
                // parameter node; no text-pattern fallback is needed.
                if (name === 'constructor' && paramsNode) {
                    for (let pi = 0; pi < paramsNode.namedChildCount; pi++) {
                        const param = paramsNode.namedChild(pi);
                        if (!['required_parameter', 'optional_parameter'].includes(param.type)) continue;
                        const access = Array.from({ length: param.namedChildCount }, (_, ci) => param.namedChild(ci))
                            .find(n => n.type === 'accessibility_modifier');
                        const readonly = Array.from({ length: param.childCount }, (_, ci) => param.child(ci))
                            .some(n => n.type === 'readonly');
                        if (!access && !readonly) continue;
                        const pattern = param.childForFieldName('pattern');
                        if (!pattern || pattern.type !== 'identifier') continue;
                        const typeNode = param.childForFieldName('type');
                        const fieldType = typeNode
                            ? typeNode.text.replace(/^:\s*/, '').trim() : undefined;
                        const loc = nodeToLocation(param, code);
                        members.push({
                            name: pattern.text,
                            startLine: loc.startLine,
                            endLine: loc.endLine,
                            memberType: 'field',
                            ...(fieldType && { fieldType }),
                            ...(access && ['private', 'protected'].includes(access.text) && {
                                modifiers: [access.text],
                            }),
                        });
                    }
                }
            }
        }

        // Abstract method signatures (TypeScript)
        if (child.type === 'abstract_method_signature') {
            const nameNode = child.childForFieldName('name');
            const paramsNode = child.childForFieldName('parameters');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(child, code);
                const returnType = extractReturnType(child);
                const docstring = extractJSDocstring(code, startLine);
                const paramsStructured = parseStructuredParams(paramsNode, 'javascript');
                const typeAnno = buildTypeAnnotations(paramsStructured, returnType, code, startLine, true);
                // Collect decorators from preceding siblings
                const decorators = [];
                for (let j = i - 1; j >= 0; j--) {
                    const prev = bodyNode.namedChild(j);
                    if (prev.type === 'decorator') {
                        let dText = prev.text.replace(/^@/, '');
                        const parenIdx = dText.indexOf('(');
                        if (parenIdx > 0) dText = dText.substring(0, parenIdx);
                        decorators.unshift(dText);
                    } else break;
                }
                members.push({
                    name: nameNode.text,
                    params: extractParams(paramsNode),
                    paramsStructured,
                    startLine,
                    endLine,
                    memberType: 'abstract',
                    isMethod: true,
                    ...typeAnno,
                    ...(docstring && { docstring }),
                    ...(decorators.length > 0 && { decorators })
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

                // Collect decorators — children of the field node (TS) or preceding siblings (JS)
                const fieldDecorators = [];
                // Check children first (TypeScript: decorator is child of public_field_definition)
                for (let ci = 0; ci < child.namedChildCount; ci++) {
                    const fc = child.namedChild(ci);
                    if (fc.type === 'decorator') {
                        let dText = fc.text.replace(/^@/, '');
                        const parenIdx = dText.indexOf('(');
                        if (parenIdx > 0) dText = dText.substring(0, parenIdx);
                        fieldDecorators.push(dText);
                    }
                }
                // Also check preceding siblings (JS proposal decorators)
                if (fieldDecorators.length === 0) {
                    for (let j = i - 1; j >= 0; j--) {
                        const prev = bodyNode.namedChild(j);
                        if (prev.type === 'decorator') {
                            let dText = prev.text.replace(/^@/, '');
                            const parenIdx = dText.indexOf('(');
                            if (parenIdx > 0) dText = dText.substring(0, parenIdx);
                            fieldDecorators.unshift(dText);
                        } else break;
                    }
                }

                if (isArrow) {
                    const paramsNode = valueNode.childForFieldName('parameters');
                    const returnType = extractReturnType(valueNode);
                    const paramsStructured = parseStructuredParams(paramsNode, 'javascript');
                    const typeAnno = buildTypeAnnotations(paramsStructured, returnType, code, startLine, true);
                    members.push({
                        name,
                        params: extractParams(paramsNode),
                        paramsStructured,
                        startLine,
                        endLine,
                        memberType: name.startsWith('#') ? 'private' : 'field',
                        isArrow: true,
                        isMethod: true,  // Arrow fields are callable like methods
                        ...typeAnno,
                        ...(fieldDecorators.length > 0 && { decorators: fieldDecorators })
                    });
                } else {
                    // Declared field type (fix #219): `_map: WeakMap<K,V> =
                    // new WeakMap()` — the annotation is the compiler-true
                    // contract for every receiver hop through this field.
                    const fieldTypeNode = child.childForFieldName('type');
                    const fieldType = fieldTypeNode
                        ? fieldTypeNode.text.replace(/^:\s*/, '').trim() : undefined;
                    members.push({
                        name,
                        startLine,
                        endLine,
                        memberType: name.startsWith('#') ? 'private field' : 'field',
                        ...(fieldType && { fieldType }),
                        ...(fieldDecorators.length > 0 && { decorators: fieldDecorators })
                        // Not a method - regular field
                    });
                }
            }
        }
    }

    return members;
}

// Module-level state detection helpers
const _STATE_PATTERN = /^(CONFIG|[A-Z][a-zA-Z]*(?:State|Store|Context|Options|Settings)|[A-Z][A-Z_]+|Entities|Input)$/;
const _ACTION_PATTERN = /^(action\w*|[a-z]+Action|[a-z]+State)$/;
const _FACTORY_FUNCTIONS = ['register', 'createAction', 'defineAction', 'makeAction'];

function _isFactoryCall(node) {
    if (node.type !== 'call_expression') return false;
    const funcNode = node.childForFieldName('function');
    if (!funcNode) return false;
    const funcName = funcNode.type === 'identifier' ? funcNode.text : null;
    return funcName && _FACTORY_FUNCTIONS.includes(funcName);
}

/**
 * Process a node for state object extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 */
function _processState(node, objects, lines) {
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

                    if ((isObject || isArray) && _STATE_PATTERN.test(name)) {
                        const { startLine, endLine } = nodeToLocation(node, lines);
                        objects.push({ name, startLine, endLine });
                    } else if (_isFactoryCall(valueNode) && (_ACTION_PATTERN.test(name) || _STATE_PATTERN.test(name))) {
                        const { startLine, endLine } = nodeToLocation(node, lines);
                        objects.push({ name, startLine, endLine });
                    }
                }
            }
        }
        return true;
    }
    return false;
}

/**
 * Find state objects (CONFIG, constants, etc.)
 */
function findStateObjects(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const objects = [];
    traverseTreeCached(tree.rootNode, (node) => {
        _processState(node, objects, lines);
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
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const functions = [], classes = [], stateObjects = [];
    const processedFn = new Set(), processedCls = new Set();

    traverseTreeCached(tree.rootNode, (node) => {
        _processFunction(node, functions, processedFn, lines);
        _processClass(node, classes, processedCls, lines);
        _processState(node, stateObjects, lines);
        return true; // always continue, never skip subtrees
    });

    // Some valid overload-heavy TypeScript files exceed the grammar's error
    // recovery budget. tree-sitter then returns a whole-file ERROR root and
    // flattens later declarations into unrelated type nodes without throwing.
    // Recover from AST tokens, not source patterns: top-level declaration
    // tokens define bounded fragments which are reparsed by the same grammar.
    // This keeps the AST-only contract while preventing a valid declaration
    // near the end of one difficult type file from disappearing silently.
    if (tree.rootNode.hasError) {
        const declarationTokens = [];
        const startsDeclaration = new Set([
            'export', 'declare', 'async', 'function', 'class', 'abstract',
            'interface', 'type', 'enum', 'namespace', 'module',
            'const', 'let', 'var'
        ]);
        const stack = [tree.rootNode];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node.childCount === 0) {
                // In severe recovery, a keyword itself can be downgraded to
                // an identifier token. Its AST position/text still supplies
                // a safe declaration boundary; semantic extraction remains
                // entirely delegated to the reparsed fragment.
                const recoveredKeyword = node.type === 'identifier' &&
                    startsDeclaration.has(node.text);
                if (node.startPosition.column === 0 &&
                    (startsDeclaration.has(node.type) || recoveredKeyword)) {
                    declarationTokens.push(node);
                }
                continue;
            }
            const children = node.children;
            for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
        }
        declarationTokens.sort((a, b) => a.startIndex - b.startIndex);

        const recoveredFunctions = [], recoveredClasses = [], recoveredState = [];
        for (let i = 0; i < declarationTokens.length; i++) {
            const token = declarationTokens[i];
            const next = declarationTokens[i + 1];
            if (next && next.startIndex === token.startIndex) continue;
            const fragment = code.slice(token.startIndex, next?.startIndex ?? code.length);
            if (!fragment.trim()) continue;
            const fragmentTree = parseTree(parser, fragment);
            const fragmentLines = fragment.split('\n');
            const ff = [], fc = [], fs = [];
            const pf = new Set(), pc = new Set();
            traverseTreeCached(fragmentTree.rootNode, (node) => {
                _processFunction(node, ff, pf, fragmentLines);
                _processClass(node, fc, pc, fragmentLines);
                _processState(node, fs, fragmentLines);
                return true;
            });
            const lineOffset = token.startPosition.row;
            const shiftLines = (value) => {
                if (!value || typeof value !== 'object') return;
                if (Array.isArray(value)) {
                    for (const item of value) shiftLines(item);
                    return;
                }
                for (const [key, child] of Object.entries(value)) {
                    if (Number.isInteger(child) && /Line$/.test(key)) value[key] = child + lineOffset;
                    else if (child && typeof child === 'object') shiftLines(child);
                }
            };
            for (const item of ff) { shiftLines(item); recoveredFunctions.push(item); }
            for (const item of fc) { shiftLines(item); recoveredClasses.push(item); }
            for (const item of fs) { shiftLines(item); recoveredState.push(item); }
        }

        const mergeUnique = (target, additions, kind) => {
            const seen = new Set(target.map(item => `${kind}\0${item.name}\0${item.startLine}`));
            for (const item of additions) {
                const key = `${kind}\0${item.name}\0${item.startLine}`;
                if (!seen.has(key)) { seen.add(key); target.push(item); }
            }
        };
        mergeUnique(functions, recoveredFunctions, 'function');
        mergeUnique(classes, recoveredClasses, 'class');
        mergeUnique(stateObjects, recoveredState, 'state');
    }

    functions.sort((a, b) => a.startLine - b.startLine);
    classes.sort((a, b) => a.startLine - b.startLine);
    stateObjects.sort((a, b) => a.startLine - b.startLine);

    return {
        language: 'javascript',
        totalLines: lines.length,
        functions,
        classes,
        stateObjects,
        ...(tree.rootNode.hasError && { parseRecovery: true }),
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
// Builtin types for literal method receivers: [].map() is Array.map, never a
// project class method. Keys are tree-sitter node types.
const JS_LITERAL_RECEIVER_TYPES = {
    array: 'Array',
    string: 'String',
    template_string: 'String',
    object: 'Object',
    regex: 'RegExp',
    number: 'Number',
};

// Literal ASSIGNMENTS type the variable (fix #262, the #218d Python rule):
// `const lines = []` → lines is Array, so lines.push() is Array.push. Object
// literals are deliberately absent — `const obj = {}` is the mutable
// property-bag / namespace idiom (obj.render = fn happens later), so typing
// it 'Object' would falsely externalize its assigned methods. A DIRECT
// literal receiver (`{}.hasOwnProperty()`) has no such future, hence the
// separate map above.
const JS_LITERAL_ASSIGN_TYPES = {
    array: 'Array',
    string: 'String',
    template_string: 'String',
    regex: 'RegExp',
    number: 'Number',
};

// Predefined TS types that pin a receiver; any/unknown/object say nothing.
const TS_PREDEFINED_RECEIVER_TYPES = new Set(['string', 'number', 'boolean', 'bigint', 'symbol']);

/**
 * Extract a single concrete type name from a TS type node. Conservative by
 * design: a wrong type would exclude true callers downstream
 * (receiver-type-mismatch), so anything ambiguous returns undefined.
 * Handles: Foo · ns.Foo · Foo | null · Store<string> · (Foo) · string
 */
function tsTypeName(node) {
    if (!node) return undefined;
    switch (node.type) {
        case 'type_identifier':
        case 'identifier':
            return node.text;
        case 'nested_type_identifier': {
            // ns.Foo → classes match by name in the symbol table → last segment
            const last = node.namedChild(node.namedChildCount - 1);
            return last?.text;
        }
        case 'generic_type':
            // Store<string> → Store
            return tsTypeName(node.namedChild(0));
        case 'union_type': {
            // Foo | null / Foo | undefined → Foo; unions of two real types are ambiguous
            const real = [];
            for (let i = 0; i < node.namedChildCount; i++) {
                const c = node.namedChild(i);
                if (c.type === 'literal_type' ||
                    (c.type === 'predefined_type' && !TS_PREDEFINED_RECEIVER_TYPES.has(c.text))) {
                    continue;
                }
                real.push(c);
            }
            return real.length === 1 ? tsTypeName(real[0]) : undefined;
        }
        case 'parenthesized_type':
            return tsTypeName(node.namedChild(0));
        case 'predefined_type':
            return TS_PREDEFINED_RECEIVER_TYPES.has(node.text) ? node.text : undefined;
        default:
            return undefined;
    }
}

/**
 * Variable receiving this call's result: `const x = foo()` / `x = await foo()`
 * → 'x'. Identifier targets only. Compared by node id — tree-sitter wrapper
 * objects are not identity-stable.
 */
function jsAssignmentTargetOf(callNode) {
    let n = callNode;
    let p = n.parent;
    if (p && p.type === 'await_expression') { n = p; p = n.parent; }
    if (p && p.type === 'variable_declarator') {
        const value = p.childForFieldName('value');
        const nameNode = p.childForFieldName('name');
        if (value && value.id === n.id && nameNode?.type === 'identifier') return nameNode.text;
    }
    if (p && p.type === 'assignment_expression') {
        const right = p.childForFieldName('right');
        const left = p.childForFieldName('left');
        if (right && right.id === n.id && left?.type === 'identifier') return left.text;
    }
    return undefined;
}

/**
 * Type name from a new-expression constructor node: new Foo() or new pkg.Foo().
 */
function jsConstructorTypeName(ctorNode) {
    if (!ctorNode) return undefined;
    if (ctorNode.type === 'identifier') return ctorNode.text;
    if (ctorNode.type === 'member_expression') {
        const prop = ctorNode.childForFieldName('property');
        return prop?.text;
    }
    return undefined;
}

function jsConstructorTypeQualifier(ctorNode) {
    if (ctorNode?.type !== 'member_expression') return undefined;
    let root = ctorNode.childForFieldName('object');
    while (root?.type === 'member_expression') root = root.childForFieldName('object');
    return root?.type === 'identifier' ? root.text : undefined;
}

function findCallsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const calls = [];
    const functionStack = [];  // Stack of { name, startLine, endLine }
    // Local aliases with lexical ownership. A flat aliasName→target map leaks
    // block locals into the rest of a module (`let effect = batchedEffect`
    // inside a loop rewrote a later module-level `effect()` call), producing
    // false external edges and caller/callee disagreement.
    const aliases = new Map();  // aliasName -> [{ target, declarationIndex, scopeStart, scopeEnd }]
    const nonCallableNames = new Set();  // Track names assigned non-callable values
    const localVarTypes = new Map();  // Track local variable types: varName -> typeName (for receiverType inference)
    const localVarTypeQualifiers = new Map(); // qualifier provenance for new ns.Type()
    // Names whose type came from a DECLARED annotation (TS `x: Foo` / typed
    // params). The compiler enforces assignability for these, so reassignment
    // never stales them; inferred types (literal/new) DO stale and are
    // deleted on untyped reassignment (fix #262, #218d semantics).
    const declaredTypeVars = new Set();
    const declaredTypeVarsStack = [];
    const moduleAliases = new Set();  // Names bound to MODULES (import * as ns / const pkg = require(...))
    const localVarTypesStack = [];  // Stack for function-scoped save/restore of localVarTypes
    const localVarTypeQualifiersStack = [];

    // Helper: extract first string-arg literal from a call_expression node.
    // Used by route extraction to capture path arg of fetch('/path'), app.get('/path', handler) etc.
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

    // Helper: count the number of (non-comment) arguments in a call_expression.
    // Used to disambiguate dual-purpose Express APIs (BUG M5):
    //   app.get('/users', handler)  → 2 args → route registration
    //   app.get('env')              → 1 arg  → config getter, NOT a route
    const getArgCount = (callNode) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return 0;
        let count = 0;
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type.endsWith('comment')) continue;
            count++;
        }
        return count;
    };

    // MEDIUM-5: extract HTTP method from `fetch(url, { method: 'POST' })`
    // and similar XHR/Request-init shapes. Returns the upper-cased method
    // string or null. Looks at argument index `argIdx` (default 1, the
    // options object after the URL).
    const getOptionsMethod = (callNode, argIdx = 1) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return null;
        // Walk named children and pick the argIdx-th non-comment node.
        let idx = 0;
        let target = null;
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type.endsWith('comment')) continue;
            if (idx === argIdx) { target = arg; break; }
            idx++;
        }
        if (!target || target.type !== 'object') return null;
        for (let i = 0; i < target.namedChildCount; i++) {
            const prop = target.namedChild(i);
            if (prop.type !== 'pair') continue;
            const keyNode = prop.childForFieldName('key');
            const valNode = prop.childForFieldName('value');
            if (!keyNode || !valNode) continue;
            // Key may be `method`, `'method'`, or `"method"`.
            let keyName = keyNode.text;
            if (keyNode.type === 'string' || keyNode.type === 'property_identifier') {
                keyName = keyName.replace(/^['"`]|['"`]$/g, '');
            }
            if (keyName !== 'method') continue;
            // Value must be a literal string. Skip variables / expressions
            // (we can't statically resolve those).
            const v = _extractStringArg(valNode);
            if (v && !v.interp && typeof v.value === 'string' && v.value.length > 0) {
                return v.value.toUpperCase();
            }
            return null;
        }
        return null;
    };

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

    const aliasScope = (declarator) => {
        const declaration = declarator.parent;
        const lexical = declaration?.type === 'lexical_declaration';
        for (let p = declaration?.parent; p; p = p.parent) {
            if (lexical && (p.type === 'statement_block' || p.type === 'switch_body' ||
                p.type === 'for_statement' || p.type === 'for_in_statement')) return p;
            if (isFunctionNode(p) || p.type === 'program' || p.type === 'module') return p;
        }
        return tree.rootNode;
    };
    const recordAlias = (name, target, declarator) => {
        const scope = aliasScope(declarator);
        if (!aliases.has(name)) aliases.set(name, []);
        aliases.get(name).push({
            target,
            declarationIndex: declarator.startIndex,
            scopeStart: scope.startIndex,
            scopeEnd: scope.endIndex,
        });
    };
    const resolveAlias = (name, callNode) => {
        const records = aliases.get(name);
        if (!records) return undefined;
        let best;
        for (const record of records) {
            if (record.declarationIndex > callNode.startIndex ||
                callNode.startIndex < record.scopeStart || callNode.endIndex > record.scopeEnd) continue;
            if (!best || record.declarationIndex > best.declarationIndex) best = record;
        }
        return best && best.target;
    };

    const _patternDeclaresName = (pattern, name) => {
        if (!pattern) return false;
        if ((pattern.type === 'identifier' ||
            pattern.type === 'shorthand_property_identifier_pattern') &&
            pattern.text === name) return true;
        if (pattern.type === 'pair_pattern' || pattern.type === 'pair') {
            return _patternDeclaresName(pattern.childForFieldName('value'), name);
        }
        if (pattern.type === 'assignment_pattern') {
            return _patternDeclaresName(
                pattern.childForFieldName('left') || pattern.childForFieldName('pattern'), name);
        }
        for (let i = 0; i < pattern.namedChildCount; i++) {
            if (_patternDeclaresName(pattern.namedChild(i), name)) return true;
        }
        return false;
    };

    // fix #203: does a declaration node declare `name` (including nested destructuring)?
    const _declaresName = (declNode, name) => {
        for (let i = 0; i < declNode.namedChildCount; i++) {
            const d = declNode.namedChild(i);
            if (d.type !== 'variable_declarator') continue;
            const nameNode = d.childForFieldName('name');
            if (_patternDeclaresName(nameNode, name)) return true;
        }
        return false;
    };

    // fix #203: is a bare-identifier function REFERENCE shadowed by a
    // let/const/var local, for/catch binding, or inner-arrow param in an
    // enclosing lexical scope? Block-accurate, declaration-before-use.
    // The enclosing SYMBOL's params are checked at query time in
    // findCallers — let locals and non-symbol arrow params are only
    // visible here. Module-level (program) declarations are NOT shadows:
    // that's the module binding itself, owned by binding resolution.
    const isShadowedByLocal = (refNode, name) => {
        for (let p = refNode.parent; p; p = p.parent) {
            if (p.type === 'statement_block') {
                for (let i = 0; i < p.namedChildCount; i++) {
                    const stmt = p.namedChild(i);
                    // Nested function/class declarations are hoisted within
                    // their block — they shadow regardless of position
                    // (fix #218: `function getStyle() {}` after the ref).
                    if ((stmt.type === 'function_declaration' ||
                        stmt.type === 'generator_function_declaration' ||
                        stmt.type === 'class_declaration') &&
                        stmt.childForFieldName('name')?.text === name) return true;
                    if (stmt.startIndex >= refNode.startIndex) continue; // declaration-before-use
                    if ((stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') &&
                        _declaresName(stmt, name)) return true;
                }
            } else if (p.type === 'for_statement') {
                const init = p.childForFieldName('initializer');
                if (init && (init.type === 'lexical_declaration' || init.type === 'variable_declaration') &&
                    _declaresName(init, name)) return true;
            } else if (p.type === 'for_in_statement') {
                const left = p.childForFieldName('left');
                if (_patternDeclaresName(left, name)) return true;
                if (left && (left.type === 'lexical_declaration' || left.type === 'variable_declaration') &&
                    _declaresName(left, name)) return true;
            } else if (p.type === 'catch_clause') {
                const param = p.childForFieldName('parameter');
                if (_patternDeclaresName(param, name)) return true;
            } else if (p.type === 'arrow_function' || p.type === 'function_expression' ||
                p.type === 'function_declaration' || p.type === 'function' ||
                p.type === 'method_definition' || p.type === 'generator_function' ||
                p.type === 'generator_function_declaration') {
                const params = p.childForFieldName('parameters') || p.childForFieldName('parameter');
                if (params) {
                    if (_patternDeclaresName(params, name)) return true;
                    for (let i = 0; i < params.namedChildCount; i++) {
                        const prm = params.namedChild(i);
                        if (_patternDeclaresName(prm, name)) return true;
                    }
                }
            }
        }
        return false;
    };

    const isConditionalReassignment = node => {
        for (let p = node.parent; p && !isFunctionNode(p); p = p.parent) {
            if (p.type === 'if_statement') {
                const condition = p.childForFieldName('condition');
                if (!condition || node.startIndex < condition.startIndex ||
                    node.endIndex > condition.endIndex) return true;
            }
            if (p.type === 'switch_case' || p.type === 'ternary_expression' ||
                p.type === 'for_statement' || p.type === 'for_in_statement' ||
                p.type === 'while_statement' || p.type === 'do_statement' ||
                p.type === 'catch_clause') return true;
        }
        return false;
    };

    traverseTree(tree.rootNode, (node) => {
        // Track module-alias bindings: `import * as ns from "./m"` binds ns to a
        // MODULE — method calls through it dispatch to module exports, never to
        // class methods.
        if (node.type === 'namespace_import') {
            const id = node.namedChild(0);
            if (id?.type === 'identifier') moduleAliases.add(id.text);
        }

        // Track function entry
        if (isFunctionNode(node)) {
            functionStack.push({
                name: extractFunctionName(node),
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1
            });
            // Save localVarTypes so inner declarations don't leak to sibling functions
            localVarTypesStack.push(new Map(localVarTypes));
            localVarTypeQualifiersStack.push(new Map(localVarTypeQualifiers));
            declaredTypeVarsStack.push(new Set(declaredTypeVars));
        }

        // Track local aliases: const myParse = parse, const { parse: csvParse } = ...
        if (node.type === 'variable_declarator') {
            const nameNode = node.childForFieldName('name');
            const initNode = node.childForFieldName('value');
            // const pkg = require("./lib") — pkg is a module namespace
            if (nameNode?.type === 'identifier' && initNode?.type === 'call_expression') {
                const fn = initNode.childForFieldName('function');
                if (fn?.type === 'identifier' && fn.text === 'require') {
                    moduleAliases.add(nameNode.text);
                }
            }
            if (nameNode?.type === 'identifier' && initNode?.type === 'identifier') {
                // Simple alias: const p = parse
                recordAlias(nameNode.text, initNode.text, node);
            }
            // Ternary alias: const fn = cond ? parseCSV : parseJSON → both targets
            if (nameNode?.type === 'identifier' && initNode?.type === 'ternary_expression') {
                const consequence = initNode.childForFieldName('consequence');
                const alternative = initNode.childForFieldName('alternative');
                const targets = [];
                if (consequence?.type === 'identifier') targets.push(consequence.text);
                if (alternative?.type === 'identifier') targets.push(alternative.text);
                if (targets.length > 0) recordAlias(nameNode.text, targets, node);
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
                            recordAlias(value.text, key.text, node);
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
                // Infer type: const x = new Foo() / new pkg.Foo() → x is Foo
                const ctorName = jsConstructorTypeName(initNode.childForFieldName('constructor'));
                if (ctorName) {
                    localVarTypes.set(nameNode.text, ctorName);
                    const qualifier = jsConstructorTypeQualifier(
                        initNode.childForFieldName('constructor'));
                    if (qualifier) localVarTypeQualifiers.set(nameNode.text, qualifier);
                    else localVarTypeQualifiers.delete(nameNode.text);
                }
            }
            // Track TypeScript type annotations: const x: Foo = ...
            if (nameNode?.type === 'identifier') {
                const typeNode = node.childForFieldName('type');
                if (typeNode) {
                    // type_annotation → first named child is the type identifier
                    const typeId = typeNode.type === 'type_annotation'
                        ? typeNode.namedChild(0) : typeNode;
                    const typeName = tsTypeName(typeId);
                    if (typeName) {
                        localVarTypes.set(nameNode.text, typeName);
                        declaredTypeVars.add(nameNode.text);
                    }
                } else if (initNode && JS_LITERAL_ASSIGN_TYPES[initNode.type]) {
                    // Literal declaration types the variable (fix #262):
                    // `const lines = []` → Array. Annotation, when present,
                    // wins (the branch above).
                    localVarTypes.set(nameNode.text, JS_LITERAL_ASSIGN_TYPES[initNode.type]);
                }
            }
        }

        // Track TS parameter type annotations: function f(client: Client) → client is Client
        if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
            const pat = node.childForFieldName('pattern') || node.namedChild(0);
            const typeNode = node.childForFieldName('type');
            if (pat?.type === 'identifier' && typeNode) {
                const inner = typeNode.type === 'type_annotation' ? typeNode.namedChild(0) : typeNode;
                const typeName = tsTypeName(inner);
                if (typeName) {
                    localVarTypes.set(pat.text, typeName);
                    declaredTypeVars.add(pat.text);
                }
            }
        }

        // Track reassignment with new expression: x = new Bar() → update localVarTypes
        if (node.type === 'assignment_expression') {
            const left = node.childForFieldName('left');
            const right = node.childForFieldName('right');
            if (left?.type === 'identifier') {
                if (right?.type === 'new_expression') {
                    nonCallableNames.add(left.text);
                    const ctorName = jsConstructorTypeName(right.childForFieldName('constructor'));
                    if (ctorName && !isConditionalReassignment(node)) {
                        localVarTypes.set(left.text, ctorName);
                        const qualifier = jsConstructorTypeQualifier(
                            right.childForFieldName('constructor'));
                        if (qualifier) localVarTypeQualifiers.set(left.text, qualifier);
                        else localVarTypeQualifiers.delete(left.text);
                    } else if (!declaredTypeVars.has(left.text)) {
                        localVarTypes.delete(left.text);
                        localVarTypeQualifiers.delete(left.text);
                    }
                } else if (right && JS_LITERAL_ASSIGN_TYPES[right.type]) {
                    // Literal reassignment re-types the variable (fix #262)
                    if (!declaredTypeVars.has(left.text)) {
                        localVarTypes.set(left.text, JS_LITERAL_ASSIGN_TYPES[right.type]);
                        localVarTypeQualifiers.delete(left.text);
                    }
                } else if (localVarTypes.has(left.text) && !declaredTypeVars.has(left.text)) {
                    // Rebinding without a known type makes any previously
                    // INFERRED type stale — nearest-preceding-assignment
                    // semantics (#218d). Annotation-declared types survive:
                    // the TS compiler enforces assignability for those.
                    localVarTypes.delete(left.text);
                    localVarTypeQualifiers.delete(left.text);
                }
            }
            // Handler-registration references (fix #252, the #221 family's
            // missing shape): `window.onload = secondPageInit` /
            // `element.onclick = handler` establish the call relationship
            // through property assignment — plain assignment RHS and
            // argument-position references were captured, the
            // member-expression LHS shape recorded nothing, so search
            // --unused claimed live handlers dead.
            if (left?.type === 'member_expression' && right?.type === 'identifier' &&
                !SKIP_IDENTS.has(right.text) && !nonCallableNames.has(right.text)) {
                calls.push({
                    name: right.text,
                    line: right.startPosition.row + 1,
                    isMethod: false,
                    isFunctionReference: true,
                    isPotentialCallback: true,
                    ...(isShadowedByLocal(right, right.text) && { localShadow: true }),
                    enclosingFunction: getCurrentEnclosingFunction(),
                });
            }
        }

        // Tree-sitter recovery can flatten a valid constructor into an ERROR
        // node when an earlier unsupported TypeScript construct destabilizes
        // the surrounding declaration. Keep this AST-first: inspect recovery
        // tokens/named children only—never source regex. Example (Hono's
        // overload-heavy factory file): ERROR children `app`, `=`, `new`,
        // `Hono` for `const app = new Hono<E>(...)`. Without this, the class
        // had a false zero-caller answer even though the identifier and `new`
        // token survived in the syntax tree.
        if (node.type === 'ERROR') {
            for (let i = 0; i < node.childCount - 1; i++) {
                const token = node.child(i);
                if (token.type !== 'new' || token.isNamed) continue;
                let ctorNode = null;
                for (let j = i + 1; j < node.childCount; j++) {
                    const candidate = node.child(j);
                    if (candidate.isNamed) { ctorNode = candidate; break; }
                }
                const ctorName = jsConstructorTypeName(ctorNode);
                if (!ctorName) continue;
                calls.push({
                    name: ctorName,
                    line: ctorNode.startPosition.row + 1,
                    isMethod: ctorNode.type === 'member_expression',
                    isConstructor: true,
                    parseRecovery: true,
                    enclosingFunction: getCurrentEnclosingFunction(),
                });
            }
        }

        // Handle regular function calls: foo(), obj.foo(), foo.call()
        if (node.type === 'call_expression') {
            let funcNode = node.childForFieldName('function');
            if (!funcNode) return true;

            // tree-sitter-typescript represents `await obj.method<T>()` with
            // the await_expression inside the call's function field. Unwrap
            // it so generic awaited calls use the same AST call path as every
            // other method invocation.
            if (funcNode.type === 'await_expression' && funcNode.namedChildCount === 1) {
                funcNode = funcNode.namedChild(0);
            }

            const enclosingFunction = getCurrentEnclosingFunction();
            let uncertain = false;
            // optional chaining implies possible non-call
            // Only check text before the opening paren to avoid false positives from arguments like foo(bar?.baz)
            const parenIdx = node.text.indexOf('(');
            if (parenIdx > 0 && node.text.slice(0, parenIdx).includes('?.')) uncertain = true;

            if (funcNode.type === 'identifier') {
                // Direct call: foo()
                const alias = resolveAlias(funcNode.text, node);
                const resolvedName = typeof alias === 'string' ? alias : undefined;
                const resolvedNames = Array.isArray(alias) ? alias : undefined;
                const firstArg = getFirstStringArg(node);
                const assignedTo = jsAssignmentTargetOf(node);
                // MEDIUM-5: capture explicit method for fetch(url, { method }).
                const optionsMethod = funcNode.text === 'fetch'
                    ? getOptionsMethod(node, 1)
                    : null;
                calls.push({
                    name: funcNode.text,
                    ...(resolvedName && { resolvedName }),
                    ...(resolvedNames && { resolvedNames }),
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    ...(assignedTo && { assignedTo }),
                    enclosingFunction,
                    uncertain,
                    ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp }),
                    ...(optionsMethod && { optionsMethod })
                });
            } else if (funcNode.type === 'super') {
                // super(config) — the subclass constructor invoking the
                // parent class's constructor (fix #238; these sites were
                // invisible to every command). Recorded as a super-received
                // 'constructor' method call so the super walk resolves it to
                // the parent class's constructor definition.
                calls.push({
                    name: 'constructor',
                    line: node.startPosition.row + 1,
                    isMethod: true,
                    receiver: 'super',
                    argCount: node.childForFieldName('arguments')?.namedChildCount ?? 0,
                    enclosingFunction,
                    uncertain: false,
                });
            } else if (funcNode.type === 'member_expression') {
                // Method call: obj.foo() or foo.call/apply/bind()
                const propNode = funcNode.childForFieldName('property');
                const objNode = funcNode.childForFieldName('object');

                if (propNode) {
                    const propName = propNode.text;

                    // Handle .call(), .apply(), .bind() - these are calls TO the object.
                    // boundCall marks the indirection (fix #221, family B): the line
                    // establishes the call relationship through Function.prototype
                    // rather than direct call syntax — the edge surfaces as
                    // calledAs:'bound' so consumers know reference oracles see a
                    // non-call reference here.
                    if (['call', 'apply', 'bind'].includes(propName) && objNode) {
                        if (objNode.type === 'identifier') {
                            // foo.call() -> call to foo
                            calls.push({
                                name: objNode.text,
                                line: node.startPosition.row + 1,
                                isMethod: false,
                                boundCall: true,
                                enclosingFunction
                            });
                        } else if (objNode.type === 'member_expression') {
                            // obj.foo.call() -> method call to foo
                            const innerProp = objNode.childForFieldName('property');
                            const innerObj = objNode.childForFieldName('object');
                            if (innerProp) {
                                const boundReceiver = innerObj?.type === 'identifier'
                                    ? innerObj.text : innerObj?.text;
                                const boundReceiverType = innerObj?.type === 'identifier'
                                    ? localVarTypes.get(innerObj.text) : undefined;
                                calls.push({
                                    name: innerProp.text,
                                    line: node.startPosition.row + 1,
                                    isMethod: true,
                                    boundCall: true,
                                    receiver: boundReceiver,
                                    ...(boundReceiverType && { receiverType: boundReceiverType }),
                                    ...(innerObj?.type === 'identifier' &&
                                        localVarTypeQualifiers.has(innerObj.text) && {
                                            receiverTypeQualifier: localVarTypeQualifiers.get(innerObj.text),
                                        }),
                                    ...(innerObj?.type === 'identifier' &&
                                        isShadowedByLocal(innerObj, innerObj.text) && {
                                            receiverLocalBinding: true,
                                        }),
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
                        // One-hop field receiver (fix #219 — #202's shape for
                        // structural): this._map.has(x) / def.cache.get(k) —
                        // receiverRoot/Field let findCallers hop to the
                        // field's DECLARED type annotation. `this`-rooted hops
                        // resolve their root type query-side (the enclosing
                        // class); identifier roots type from local annotations.
                        let receiverRoot, receiverFieldName, receiverRootType, receiverBindingNode;
                        if (receiver && objNode?.type === 'identifier') receiverBindingNode = objNode;
                        if (!receiver && objNode && objNode.type === 'member_expression') {
                            const rootNode = objNode.childForFieldName('object');
                            const fldNode = objNode.childForFieldName('property');
                            if (fldNode && rootNode &&
                                (rootNode.type === 'identifier' || rootNode.type === 'this')) {
                                receiverRoot = rootNode.text;
                                receiverBindingNode = rootNode.type === 'identifier' ? rootNode : undefined;
                                receiverFieldName = fldNode.text;
                                if (rootNode.type === 'identifier') {
                                    receiverRootType = localVarTypes.get(rootNode.text);
                                }
                            }
                        }
                        // Chained receiver (fix #219): the receiver IS a call —
                        // parseAsync(args).catch(...) — record the producer so
                        // findCallers can type the receiver from its declared
                        // return annotation (Promise<...> → Promise).
                        let receiverCall, receiverCallIsMethod, receiverCallAwaited, receiverCallLine;
                        {
                            let recvNode = objNode;
                            if (recvNode && recvNode.type === 'parenthesized_expression') {
                                recvNode = recvNode.namedChild(0);
                            }
                            if (recvNode && recvNode.type === 'await_expression') {
                                receiverCallAwaited = true;
                                recvNode = recvNode.namedChild(0);
                            }
                            if (recvNode && recvNode.type === 'call_expression') {
                                const prodFunc = recvNode.childForFieldName('function');
                                if (prodFunc?.type === 'identifier') {
                                    receiverCall = prodFunc.text;
                                    // Producer link (fix #258): plain-call
                                    // records carry the call node's start line
                                    receiverCallLine = recvNode.startPosition.row + 1;
                                } else if (prodFunc?.type === 'member_expression') {
                                    const prodProp = prodFunc.childForFieldName('property');
                                    if (prodProp) {
                                        receiverCall = prodProp.text;
                                        receiverCallIsMethod = true;
                                        // Method records report the property
                                        // node's own line
                                        receiverCallLine = prodProp.startPosition.row + 1;
                                    }
                                }
                            }
                            if (!receiverCall) receiverCallAwaited = undefined;
                        }
                        // Literal receivers carry their builtin type: [].map() can
                        // never be a project class method
                        // A freshly constructed receiver has an exact runtime
                        // type as well: new Service().start(). Recording it here
                        // avoids treating the call as an untyped method dispatch.
                        const constructedReceiverType = objNode?.type === 'new_expression'
                            ? jsConstructorTypeName(objNode.childForFieldName('constructor'))
                            : undefined;
                        const constructedReceiverQualifier = objNode?.type === 'new_expression'
                            ? jsConstructorTypeQualifier(objNode.childForFieldName('constructor'))
                            : undefined;
                        const receiverType = receiver
                            ? localVarTypes.get(receiver)
                            : (constructedReceiverType ||
                                (objNode ? JS_LITERAL_RECEIVER_TYPES[objNode.type] : undefined));
                        // Module receiver (ns.helper()) — unless locally shadowed
                        // by a typed instance binding
                        const receiverIsModule = !!receiver && moduleAliases.has(receiver) &&
                            !localVarTypes.has(receiver);
                        const firstArg = getFirstStringArg(node);
                        const argCount = getArgCount(node);
                        const assignedTo = jsAssignmentTargetOf(node);
                        calls.push({
                            name: propName,
                            // Multi-line chains (builder.x()\n.y()) must report
                            // each method's OWN name line, not the chain-start
                            // line — the account's ground set is keyed by the
                            // name's line
                            line: propNode.startPosition.row + 1,
                            isMethod: true,
                            receiver,
                            ...(receiverType && { receiverType }),
                            ...((constructedReceiverQualifier ||
                                (receiver && localVarTypeQualifiers.get(receiver))) && {
                                receiverTypeQualifier: constructedReceiverQualifier ||
                                    localVarTypeQualifiers.get(receiver),
                            }),
                            ...(receiverIsModule && { receiverIsModule: true }),
                            ...(receiverBindingNode &&
                                isShadowedByLocal(receiverBindingNode, receiverBindingNode.text) &&
                                { receiverLocalBinding: true }),
                            ...(receiverFieldName && { receiverRoot, receiverField: receiverFieldName }),
                            ...(receiverFieldName && receiverRootType && { receiverRootType }),
                            ...(receiverCall && { receiverCall }),
                            ...(receiverCallIsMethod && { receiverCallIsMethod: true }),
                            ...(receiverCallAwaited && { receiverCallAwaited: true }),
                            ...(receiverCallLine && { receiverCallLine }),
                            ...(assignedTo && { assignedTo }),
                            enclosingFunction,
                            uncertain,
                            ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp }),
                            argCount
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
                        if (arg.type.endsWith('comment')) continue;
                        // Only check args at callback positions (null = all positions)
                        const isCallbackPos = callbackIndices === null || callbackIndices === undefined || callbackIndices.has(argIdx);
                        if (isCallbackPos) {
                            if (arg.type === 'identifier' && !SKIP_IDENTS.has(arg.text)) {
                                calls.push({
                                    name: arg.text,
                                    line: arg.startPosition.row + 1,
                                    isMethod: false,
                                    isFunctionReference: true,
                                    ...(isShadowedByLocal(arg, arg.text) && { localShadow: true }),
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
                                ...(isShadowedByLocal(arg, arg.text) && { localShadow: true }),
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
                                            ...(isShadowedByLocal(val, val.text) && { localShadow: true }),
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
                        ...(isShadowedByLocal(ctorNode, ctorNode.text) && { localShadow: true }),
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
                        ...(isShadowedByLocal(child, child.text) && { localShadow: true }),
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
                // Restore localVarTypes to pre-function state
                const saved = localVarTypesStack.pop();
                if (saved) {
                    localVarTypes.clear();
                    for (const [k, v] of saved) localVarTypes.set(k, v);
                }
                const savedQualifiers = localVarTypeQualifiersStack.pop();
                if (savedQualifiers) {
                    localVarTypeQualifiers.clear();
                    for (const [k, v] of savedQualifiers) localVarTypeQualifiers.set(k, v);
                }
                const savedDeclared = declaredTypeVarsStack.pop();
                if (savedDeclared) {
                    declaredTypeVars.clear();
                    for (const k of savedDeclared) declaredTypeVars.add(k);
                }
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

    traverseTreeCached(tree.rootNode, (node) => {
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

    traverseTreeCached(tree.rootNode, (node) => {
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

    traverseTreeCached(tree.rootNode, (node) => {
        // ES6 import statements
        if (node.type === 'import_statement') {
            const line = node.startPosition.row + 1;
            let modulePath = null;
            const names = [];
            const esmRenames = [];
            let importType = 'named';

            // Find the module path (string node)
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'string') {
                    // Extract text without quotes
                    const text = child.text;
                    modulePath = text.slice(1, -1);
                }
                // TS import-equals: `import x = require('./y')` — the
                // dependency edge was invisible to imports/exporters/graph/
                // circularDeps (fix #245; `export = fn` was already captured).
                if (child.type === 'import_require_clause') {
                    let alias = null, src = null;
                    for (let j = 0; j < child.namedChildCount; j++) {
                        const c = child.namedChild(j);
                        if (c.type === 'identifier') alias = c.text;
                        if (c.type === 'string') src = c.text.slice(1, -1);
                    }
                    if (src) {
                        imports.push({ module: src, names: alias ? [alias] : [], type: 'require', line });
                    }
                    return true;
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
                                        esmRenames.push({ original: nameNode.text, local: aliasNode.text });
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
                imports.push({ module: modulePath, names, type: importType, line,
                    ...(esmRenames.length > 0 && { renames: esmRenames }) });
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
                    const renames = [];
                    let modulePath;
                    let dynamic = false;

                    if (firstArg && firstArg.type === 'string') {
                        modulePath = firstArg.text.slice(1, -1);
                    } else {
                        dynamic = true;
                        modulePath = firstArg ? firstArg.text : null;
                    }

                    // Check parent for variable name
                    let parent = node.parent;
                    let defaultLike = false;
                    if (parent && parent.type === 'variable_declarator') {
                        const nameNode = parent.childForFieldName('name');
                        if (nameNode) {
                            if (nameNode.type === 'identifier') {
                                names.push(nameNode.text);
                                // `const app = require('./app')` binds the
                                // value assigned to `module.exports`, not a
                                // named property called `app`. Preserve that
                                // distinction for exact import ownership.
                                defaultLike = true;
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
                                            renames.push({ original: key.text, local: val.text });
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if (modulePath) {
                        imports.push({ module: modulePath, names, type: 'require', line, dynamic,
                            ...(defaultLike && { defaultLike: true }),
                            // Per-import rename pairing (fix #269): the flat
                            // importAliases list loses WHICH module a renamed
                            // name came from — `{ validate: validateSchema }`
                            // must pin to its own require, not any module
                            // exporting the source name.
                            ...(renames.length > 0 && { renames }) });
                    }
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
                    } else if (firstArg) {
                        imports.push({ module: firstArg.text, names: [], type: 'dynamic', line, dynamic: true });
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

    traverseTreeCached(tree.rootNode, (node) => {
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
                // `export * as ns from 'x'` exposes ONLY the single name `ns`
                // (a module namespace object), not x's flattened surface —
                // record the alias so name-level chases don't walk through it
                // (fix #218: zod's `export * as core` made z._default look
                // reachable from core). Name stays '*' for shape stability.
                let nsAlias = null;
                for (let i = 0; i < node.namedChildCount; i++) {
                    const child = node.namedChild(i);
                    if (child.type === 'namespace_export') {
                        const id = child.namedChild(0);
                        if (id) nsAlias = id.text;
                    }
                }
                exports.push({ name: '*', type: 're-export-all', line, source, ...(nsAlias && { alias: nsAlias }) });
                return true;
            }

            // Check for export clause: export { a, b } or export { a } from 'x'
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'export_clause') {
                    for (let j = 0; j < child.namedChildCount; j++) {
                        const specifier = child.namedChild(j);
                        if (specifier.type === 'export_specifier') {
                            const nameNode = specifier.childForFieldName('name') || specifier.namedChild(0);
                            // Export rename: `export { _gt as gt }` — name keeps the
                            // local/source symbol (deadcode and re-export resolution
                            // key on it); alias carries the external name callers use.
                            const aliasNode = specifier.childForFieldName('alias');
                            if (nameNode) {
                                const exportType = source ? 're-export' : 'named';
                                exports.push({
                                    name: nameNode.text, type: exportType, line,
                                    ...(source && { source }),
                                    ...(aliasNode && aliasNode.text !== nameNode.text && { alias: aliasNode.text }),
                                });
                            }
                        }
                    }
                    return true;
                }
            }

            // Named/default exports: export function/class/const, export default function/class
            // Check if this is a default export by looking for the 'default' token
            let isDefaultExport = false;
            for (let ci = 0; ci < node.childCount; ci++) {
                if (node.child(ci).type === 'default') { isDefaultExport = true; break; }
            }
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'function_declaration' || child.type === 'generator_function_declaration') {
                    const nameNode = child.childForFieldName('name');
                    if (nameNode) {
                        exports.push({ name: nameNode.text, type: isDefaultExport ? 'default' : 'named', line });
                    }
                } else if (child.type === 'class_declaration' || child.type === 'abstract_class_declaration') {
                    // tree-sitter-typescript emits abstract_class_declaration
                    // for `export abstract class X` — the symbol extractor
                    // knew the node type, the export scanner did not (fix
                    // #245: the class was never recorded as an export).
                    const nameNode = child.childForFieldName('name');
                    if (nameNode) {
                        exports.push({ name: nameNode.text, type: isDefaultExport ? 'default' : 'named', line });
                    }
                } else if (child.type === 'ambient_declaration') {
                    // export declare function/class/const X — the ambient
                    // wrapper holds the real declaration (fix #245).
                    for (let j = 0; j < child.namedChildCount; j++) {
                        const inner = child.namedChild(j);
                        const nameNode = inner.childForFieldName?.('name');
                        if (nameNode) {
                            exports.push({ name: nameNode.text, type: 'named', line });
                        } else if (inner.type === 'lexical_declaration' || inner.type === 'variable_declaration') {
                            for (let k = 0; k < inner.namedChildCount; k++) {
                                const d = inner.namedChild(k);
                                const n = d.type === 'variable_declarator' && d.childForFieldName('name');
                                if (n && n.type === 'identifier') {
                                    exports.push({ name: n.text, type: 'named', line, isVariable: true, declKind: 'declare' });
                                }
                            }
                        }
                    }
                } else if (child.type === 'internal_module' || child.type === 'module') {
                    // export namespace Geo { ... } — the NAMESPACE is the
                    // importable name; its inner members are reached as
                    // Geo.member (fix #245: only inner names were listed,
                    // none of them importable).
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
                                } else if (prop.type === 'method_definition') {
                                    // Shorthand methods are exports too
                                    // (fix #252 — `module.exports =
                                    // { doThing(x) {} }` was invisible to the
                                    // export list, so deadcode audited a
                                    // require()-reachable function).
                                    const mName = prop.childForFieldName('name');
                                    if (mName) exports.push({ name: mName.text, type: 'module.exports', line });
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

                    // module.exports.name = ...
                    if (objNode.type === 'member_expression' && objNode.text === 'module.exports') {
                        const line = node.startPosition.row + 1;
                        exports.push({ name: propNode.text, type: 'module.exports', line });
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
 * @param {object} [tree] - Pre-parsed tree (per-operation cache); parsed here when absent
 * @returns {Array<{line: number, column: number, usageType: string}>}
 */
function findUsagesInCode(code, name, parser, tree) {
    tree = tree || parseTree(parser, code);
    const usages = [];

    visitNameNodes(tree, code, name, (node) => {
        // Look for identifier, property_identifier (method names in obj.method() calls),
        // private_property_identifier (#method definitions and calls),
        // type_identifier (TypeScript type annotations), shorthand_property_identifier_pattern
        // (destructured names in `const { name } = require(...)`), and
        // shorthand_property_identifier (value-position shorthand — CJS export
        // objects `module.exports = { helper }` and option objects `f({ helper })`
        // reference the symbol but produced no usage record at all, fix #241)
        const isIdentifier = node.type === 'identifier' || node.type === 'property_identifier' ||
            node.type === 'private_property_identifier' ||
            node.type === 'type_identifier' || node.type === 'shorthand_property_identifier_pattern' ||
            node.type === 'shorthand_property_identifier';
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
                     sameNode(parent.childForFieldName('function'), node)) {
                usageType = 'call';
            }
            // New expression: identifier is constructor
            else if (parent.type === 'new_expression' &&
                     sameNode(parent.childForFieldName('constructor'), node)) {
                usageType = 'call';
            }
            // Definition: function name in declaration
            else if ((parent.type === 'function_declaration' ||
                      parent.type === 'generator_function_declaration') &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: variable name in declarator (left side of =).
            // When the right side is require()/import() the line IS the import
            // of the symbol — `const Service = require('./service')` classified
            // as 'definition' made the project's only import invisible (fix #241).
            else if (parent.type === 'variable_declarator' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
                let value = parent.childForFieldName('value');
                if (value && value.type === 'await_expression') {
                    value = value.namedChild(0);
                }
                // Unwrap require('./x').member — still an import binding
                if (value && value.type === 'member_expression') {
                    value = value.childForFieldName('object');
                }
                if (value && value.type === 'call_expression') {
                    const func = value.childForFieldName('function');
                    if (func && (func.text === 'require' || func.type === 'import')) {
                        usageType = 'import';
                    }
                }
            }
            // Definition: class name
            else if (parent.type === 'class_declaration' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: method name
            else if (parent.type === 'method_definition' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: function expression name (named function expressions)
            else if (parent.type === 'function' &&
                     sameNode(parent.childForFieldName('name'), node)) {
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
            // Destructured require: const { name } = require('...')
            else if (node.type === 'shorthand_property_identifier_pattern' &&
                     parent.type === 'object_pattern') {
                // Check if the object_pattern is part of a variable_declarator with require()
                const declarator = parent.parent;
                if (declarator && declarator.type === 'variable_declarator') {
                    const value = declarator.childForFieldName('value');
                    if (value && value.type === 'call_expression') {
                        const func = value.childForFieldName('function');
                        if (func && func.text === 'require') {
                            usageType = 'import';
                        }
                    }
                }
            }
            // Property access (method call): a.name() - the name after dot
            else if (parent.type === 'member_expression' &&
                     sameNode(parent.childForFieldName('property'), node)) {
                // Preserve the receiver and let the project-aware usage layer
                // decide ownership. A spelling such as `util` or `path` can be
                // either a standard module or a local project namespace, which
                // cannot be decided correctly from this file's AST alone.
                const object = parent.childForFieldName('object');
                // Check if this is a method call
                const grandparent = parent.parent;
                if (grandparent && grandparent.type === 'call_expression') {
                    usageType = 'call';
                } else {
                    usageType = 'reference';
                }
                // Track receiver for member expressions (obj.name → receiver = 'obj')
                if (object && object.type === 'identifier') {
                    usages.push({ line, column, usageType, receiver: object.text });
                    return true;
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

const _JS_LIFECYCLE_METHODS = new Set([
    'render', 'componentDidMount', 'componentDidUpdate', 'componentWillUnmount',
    'getDerivedStateFromProps', 'getDerivedStateFromError', 'componentDidCatch',
    'getSnapshotBeforeUpdate', 'shouldComponentUpdate',
    'connectedCallback', 'disconnectedCallback', 'attributeChangedCallback', 'adoptedCallback'
]);

/**
 * Classify a JS/TS symbol as a runtime entry point of a specific kind.
 * Returns 'framework' | null.
 *
 * - 'framework': React lifecycle methods (componentDidMount, etc.) and Web
 *                Components callbacks (connectedCallback, etc.) — invoked by
 *                the framework, not user code.
 *
 * Note: in JS/TS, test cases are framework calls (`it`, `test`, `describe`)
 * not function definitions, so they aren't classified as test entry points
 * here — `_addAffectedTestCases` in core/tracing.js handles them via call
 * detection rather than this predicate.
 *
 * Used by tracing/search so `affectedTests` only tags genuine test cases.
 */
function getEntryPointKind(symbol) {
    if (symbol.isMethod && _JS_LIFECYCLE_METHODS.has(symbol.name)) return 'framework';
    return null;
}

/**
 * Check if a symbol is a JS/TS-convention entry point.
 * These are framework lifecycle methods invoked by React or Web Components.
 */
function isEntryPoint(symbol) {
    return getEntryPointKind(symbol) !== null;
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
    isEntryPoint,
    getEntryPointKind,
    parse
};
