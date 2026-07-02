/**
 * languages/go.js - Tree-sitter based Go parsing
 *
 * Handles: function declarations, method declarations (with receivers),
 * struct/interface types, and const/var declarations.
 */

const {
    traverseTree,
    traverseTreeCached,
    nodeToLocation,
    parseStructuredParams,
    extractGoDocstring,
    visitNameNodes,
    sameNode,
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
    // Distinguish "we have no node" (genuinely unknown) from "node is empty".
    // Returning '...' for empty parens conflated zero-param functions with
    // unknown signatures in JSON output (fix #238; the shared
    // utils.extractParams already had this fix).
    if (!paramsNode) return '...';
    const text = paramsNode.text;
    return text.replace(/^\(|\)$/g, '').trim();
}

/**
 * Extract receiver from method declaration
 */
function extractReceiver(receiverNode) {
    if (!receiverNode) return null;
    // receiverNode is a parameter_list: (r *Router)
    // Find the parameter_declaration child
    const param = receiverNode.namedChildren.find(c => c.type === 'parameter_declaration');
    if (!param) return receiverNode.text.replace(/^\(|\)$/g, '').trim();
    // The type is the last named child (name is first for named receivers)
    const typeNode = param.namedChildren[param.namedChildren.length - 1];
    if (!typeNode) return null;
    return typeNode.text;
}

// --- Single-pass helpers: extracted from find* callbacks ---

/**
 * Process a node for function extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 */
function _processFunction(node, functions, processedRanges, lines) {
    if (node.type === 'function_declaration') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return false;
        processedRanges.add(rangeKey);

        const nameNode = node.childForFieldName('name');
        const paramsNode = node.childForFieldName('parameters');

        if (nameNode) {
            const { startLine, endLine, indent } = nodeToLocation(node, lines);
            const returnType = extractReturnType(node);
            const docstring = extractGoDocstring(lines, startLine);
            const typeParams = extractTypeParams(node);
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

    if (node.type === 'method_declaration') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return false;
        processedRanges.add(rangeKey);

        const nameNode = node.childForFieldName('name');
        const paramsNode = node.childForFieldName('parameters');
        const receiverNode = node.childForFieldName('receiver');

        if (nameNode) {
            const { startLine, endLine, indent } = nodeToLocation(node, lines);
            const receiver = extractReceiver(receiverNode);
            const returnType = extractReturnType(node);
            const docstring = extractGoDocstring(lines, startLine);
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

    return false;
}

/**
 * Process a node for type/class extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 */
function _processClass(node, types, processedRanges, lines) {
    if (node.type !== 'type_declaration') return false;

    const rangeKey = `${node.startIndex}-${node.endIndex}`;
    if (processedRanges.has(rangeKey)) return false;
    processedRanges.add(rangeKey);

    for (let i = 0; i < node.namedChildCount; i++) {
        const spec = node.namedChild(i);
        if (spec.type === 'type_spec') {
            const nameNode = spec.childForFieldName('name');
            const typeNode = spec.childForFieldName('type');

            if (nameNode && typeNode) {
                const { startLine, endLine } = nodeToLocation(node, lines);
                const name = nameNode.text;
                const docstring = extractGoDocstring(lines, startLine);
                const typeParams = extractTypeParams(spec);

                let typeKind = 'type';
                if (typeNode.type === 'struct_type') {
                    typeKind = 'struct';
                } else if (typeNode.type === 'interface_type') {
                    typeKind = 'interface';
                }

                const isExported = /^[A-Z]/.test(name);

                const members = typeKind === 'struct' ? extractStructFields(typeNode, lines)
                    : typeKind === 'interface' ? extractInterfaceMembers(typeNode, lines)
                    : [];

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
        } else if (spec.type === 'type_alias') {
            // `type A = B` — A IS B (compiler identity, methods carry over;
            // unlike `type A B` defined types, which get NO methods from B).
            // Record the aliased base so callers can treat A-qualified
            // receivers as B (fix #208).
            const nameNode = spec.childForFieldName('name');
            const typeNode = spec.childForFieldName('type');
            if (nameNode && typeNode) {
                const aliasOf = typeNode.type === 'type_identifier' ? typeNode.text
                    : typeNode.type === 'qualified_type' ? typeNode.childForFieldName('name')?.text
                    : null;
                const { startLine, endLine } = nodeToLocation(node, lines);
                types.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    type: 'type',
                    members: [],
                    modifiers: /^[A-Z]/.test(nameNode.text) ? ['export'] : [],
                    ...(aliasOf && { aliasOf }),
                });
            }
        }
    }
    return true;
}

// Module-level state detection helpers
const GO_STATE_PATTERN = /^(CONFIG|SETTINGS|[A-Z][A-Z0-9_]+|Default[A-Z][a-zA-Z]*|[A-Z][a-zA-Z]*(?:Config|Settings|Options))$/;

function _isGoExportedName(name) {
    return /^[A-Z]/.test(name);
}

function _isCompositeLiteral(valueNode) {
    if (!valueNode) return false;
    if (valueNode.type === 'composite_literal') return true;
    for (let i = 0; i < valueNode.namedChildCount; i++) {
        if (valueNode.namedChild(i).type === 'composite_literal') return true;
    }
    return false;
}

function _blockHasIota(constDecl) {
    for (let i = 0; i < constDecl.namedChildCount; i++) {
        const spec = constDecl.namedChild(i);
        if (spec.type === 'const_spec') {
            const valueNode = spec.childForFieldName('value');
            if (valueNode) {
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

/**
 * Process a node for state object extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 */
function _processState(node, objects, lines) {
    if (node.type === 'const_declaration') {
        const isIotaBlock = _blockHasIota(node);
        for (let i = 0; i < node.namedChildCount; i++) {
            const spec = node.namedChild(i);
            if (spec.type === 'const_spec') {
                const nameNode = spec.childForFieldName('name');
                const valueNode = spec.childForFieldName('value');
                if (!nameNode) continue;
                const name = nameNode.text;

                if (valueNode && _isCompositeLiteral(valueNode) && GO_STATE_PATTERN.test(name)) {
                    const { startLine, endLine } = nodeToLocation(spec, lines);
                    objects.push({ name, startLine, endLine });
                } else if (isIotaBlock && /^[A-Z]/.test(name)) {
                    const { startLine, endLine } = nodeToLocation(spec, lines);
                    objects.push({ name, startLine, endLine, isConst: true });
                } else if (_isGoExportedName(name)) {
                    const { startLine, endLine } = nodeToLocation(spec, lines);
                    objects.push({ name, startLine, endLine, isConst: true });
                }
            }
        }
        return true;
    }

    if (node.type === 'var_declaration') {
        for (let i = 0; i < node.namedChildCount; i++) {
            const spec = node.namedChild(i);
            if (spec.type === 'var_spec') {
                const nameNode = spec.childForFieldName('name');
                const valueNode = spec.childForFieldName('value');

                if (nameNode) {
                    const name = nameNode.text;
                    if (valueNode && _isCompositeLiteral(valueNode) && GO_STATE_PATTERN.test(name)) {
                        const { startLine, endLine } = nodeToLocation(spec, lines);
                        objects.push({ name, startLine, endLine });
                    } else if (_isGoExportedName(name)) {
                        const { startLine, endLine } = nodeToLocation(spec, lines);
                        objects.push({ name, startLine, endLine });
                    }
                }
            }
        }
        return true;
    }

    return false;
}

// --- End single-pass helpers ---

/**
 * Find all functions in Go code using tree-sitter
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
    const lines = code.split('\n');
    const types = [];
    const processedRanges = new Set();
    traverseTreeCached(tree.rootNode, (node) => {
        _processClass(node, types, processedRanges, lines);
        return true;
    });
    types.sort((a, b) => a.startLine - b.startLine);
    return types;
}

/**
 * Extract struct fields
 */
function extractStructFields(structNode, codeOrLines) {
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
            const { startLine, endLine } = nodeToLocation(field, codeOrLines);
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
function extractInterfaceMembers(interfaceNode, codeOrLines) {
    const members = [];
    for (let i = 0; i < interfaceNode.namedChildCount; i++) {
        const child = interfaceNode.namedChild(i);
        // tree-sitter Go uses method_elem (or method_spec in older versions)
        if (child.type === 'method_elem' || child.type === 'method_spec') {
            const { startLine, endLine } = nodeToLocation(child, codeOrLines);
            // Name is in a field_identifier child
            let nameText = null;
            let paramsText = null;
            let paramsNode = null;
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
                        paramsNode = sub;
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
                // Single return type — can be type_identifier, pointer_type, slice_type, map_type, etc.
                const returnTypeNodes = new Set([
                    'type_identifier', 'pointer_type', 'slice_type', 'map_type',
                    'array_type', 'channel_type', 'function_type', 'interface_type',
                    'struct_type', 'generic_type', 'qualified_type',
                ]);
                for (let j = 0; j < child.namedChildCount; j++) {
                    const sub = child.namedChild(j);
                    if (returnTypeNodes.has(sub.type) && sub.text !== nameText) {
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
                        ...(paramsNode && { paramsStructured: parseStructuredParams(paramsNode, 'go') }),
                        ...(returnType && { returnType })
                    });
                }
            }
        } else if (child.type === 'type_identifier' || child.type === 'qualified_type') {
            // Standalone type identifier inside interface body — embedded interface
            const { startLine, endLine } = nodeToLocation(child, codeOrLines);
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
                    const { startLine, endLine } = nodeToLocation(sub, codeOrLines);
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
 * Parse a Go file completely
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
        _processFunction(node, functions, processedFn, lines);
        _processClass(node, classes, processedCls, lines);
        _processState(node, stateObjects, lines);
        return true;
    });

    functions.sort((a, b) => a.startLine - b.startLine);
    classes.sort((a, b) => a.startLine - b.startLine);
    stateObjects.sort((a, b) => a.startLine - b.startLine);

    return {
        language: 'go',
        totalLines: lines.length,
        functions,
        classes,
        stateObjects,
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

/**
 * Variable receiving this call's result (fix #207 return-type flow):
 *   bb := balancer.Get(n)  → { assignedTo: 'bb' }
 *   x, err := pkg.Make()   → { assignedTo: 'x', assignedTuple: true }
 *                            (tuple unpack — the flow map pairs the first
 *                             return element with the first variable)
 *   y = q()                → { assignedTo: 'y' } (plain `=` only — `+=` etc.
 *                            don't bind the call's type to the variable)
 *   a, b := g(), h()       → parallel assignment: each call pairs with its
 *                            own LHS position, single-value semantics
 * Identifier targets only; blank (`_`) targets return undefined.
 */
function goAssignmentTargetOf(callNode) {
    let n = callNode;
    let p = n.parent;
    let rhsIndex = 0;
    let rhsCount = 1;
    if (p && p.type === 'expression_list') {
        rhsCount = p.namedChildCount;
        for (let i = 0; i < p.namedChildCount; i++) {
            if (p.namedChild(i).id === n.id) { rhsIndex = i; break; }
        }
        n = p; p = n.parent;
    }
    if (!p || (p.type !== 'short_var_declaration' && p.type !== 'assignment_statement')) return undefined;
    if (p.type === 'assignment_statement') {
        const op = p.childForFieldName('operator');
        if (op && op.text !== '=') return undefined;
    }
    const right = p.childForFieldName('right');
    if (!right || right.id !== n.id) return undefined;
    const left = p.childForFieldName('left');
    if (!left) return undefined;
    const names = left.type === 'expression_list'
        ? Array.from({ length: left.namedChildCount }, (_, i) => left.namedChild(i))
        : [left];
    if (rhsCount > 1) {
        const target = names[rhsIndex];
        return target?.type === 'identifier' && target.text !== '_'
            ? { assignedTo: target.text } : undefined;
    }
    const target = names[0];
    if (target?.type !== 'identifier' || target.text === '_') return undefined;
    if (names.length > 1) {
        // All LHS names (fix #220): an EXTERNAL producer decides every tuple
        // element's type, not just the first — `tmpFile, err := os.CreateTemp`
        // marks err external-flow too. The TYPED flow keeps pairing only
        // element 0 with the producer's return tuple (#207).
        const rest = names.slice(1)
            .filter(t => t.type === 'identifier' && t.text !== '_')
            .map(t => t.text);
        return { assignedTo: target.text, assignedTuple: true,
            ...(rest.length > 0 && { assignedTupleRest: rest }) };
    }
    return { assignedTo: target.text };
}

function findCallsInCode(code, parser, options = {}) {
    const tree = parseTree(parser, code);
    const calls = [];
    const functionStack = [];  // Stack of { name, startLine, endLine }

    // Helper: extract first string-arg literal from a call_expression node.
    // Used by route extraction to capture path arg of http.HandleFunc("/p", h),
    // r.GET("/users", listUsers), and detect fmt.Sprintf("/users/%d", id).
    const { extractStringArg: _extractStringArg, extractSprintfPrefix: _extractSprintfPrefix } = require('./utils');
    const getFirstStringArg = (callNode) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return null;
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type === 'comment') continue;
            // fmt.Sprintf interpolation
            if (arg.type === 'call_expression') {
                const inner = arg.childForFieldName('function');
                if (inner?.type === 'selector_expression') {
                    const operand = inner.childForFieldName('operand');
                    const field = inner.childForFieldName('field');
                    if (operand?.text === 'fmt' && field && /^Sprintf$/.test(field.text)) {
                        return _extractSprintfPrefix(arg);
                    }
                }
            }
            return _extractStringArg(arg);
        }
        return null;
    };
    // Skip common non-function identifiers when detecting callback arguments
    const GO_SKIP_IDENTS = new Set(['nil', 'true', 'false', 'err', 'ctx', 'context', 'iota']);
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

    // fix #203 (Go): is a bare-identifier function REFERENCE shadowed by an
    // enclosing func-literal/function parameter, method receiver, range/init
    // binding, or a := / var local declared before use? grpc-go-measured:
    // `&clusterInfo{unsubscribe: unsubscribe}` inside `func(ref int32,
    // unsubscribe func())` references the parameter, never a same-name
    // package symbol. The enclosing INDEXED symbol's params are checked at
    // query time in findCallers — func-literal params and block locals are
    // only visible here. (Rust/Java need no equivalent: their parsers emit
    // no bare-identifier callback references — Rust only obj.method field
    // expressions, Java only :: method references.)
    const _paramListDeclares = (paramsNode, name) => {
        if (!paramsNode) return false;
        for (let i = 0; i < paramsNode.namedChildCount; i++) {
            const pd = paramsNode.namedChild(i);
            if (pd.type !== 'parameter_declaration' && pd.type !== 'variadic_parameter_declaration') continue;
            // Go allows several names per declaration: `a, b int`
            for (let j = 0; j < pd.namedChildCount; j++) {
                const c = pd.namedChild(j);
                if (c.type === 'identifier' && c.text === name) return true;
            }
        }
        return false;
    };
    const _declaresLocal = (stmt, name, refNode) => {
        if (!stmt) return false;
        // The declaration CONTAINING the reference is not a shadow: in
        // `unsubscribe := unsubscribe` the RHS names the OUTER binding —
        // Go's := declares the LHS only after the statement.
        if (stmt.startIndex <= refNode.startIndex && stmt.endIndex >= refNode.endIndex) return false;
        if (stmt.type === 'short_var_declaration') {
            const left = stmt.childForFieldName('left');
            if (left) {
                for (let i = 0; i < left.namedChildCount; i++) {
                    const id = left.namedChild(i);
                    if (id.type === 'identifier' && id.text === name) return true;
                }
            }
        } else if (stmt.type === 'var_declaration') {
            for (let i = 0; i < stmt.namedChildCount; i++) {
                const spec = stmt.namedChild(i);
                if (spec.type !== 'var_spec') continue;
                for (let j = 0; j < spec.namedChildCount; j++) {
                    const id = spec.namedChild(j);
                    if (id.type === 'identifier' && id.text === name) return true;
                }
            }
        }
        return false;
    };
    const isShadowedByLocal = (refNode, name) => {
        for (let p = refNode.parent; p; p = p.parent) {
            if (p.type === 'block') {
                for (let i = 0; i < p.namedChildCount; i++) {
                    const stmt = p.namedChild(i);
                    if (stmt.startIndex >= refNode.startIndex) break; // declaration-before-use
                    if (_declaresLocal(stmt, name, refNode)) return true;
                }
            } else if (p.type === 'for_statement') {
                for (let i = 0; i < p.namedChildCount; i++) {
                    const c = p.namedChild(i);
                    if (c.type === 'range_clause') {
                        const left = c.childForFieldName('left');
                        if (left) {
                            for (let j = 0; j < left.namedChildCount; j++) {
                                const id = left.namedChild(j);
                                if (id.type === 'identifier' && id.text === name) return true;
                            }
                        }
                    } else if (c.type === 'for_clause') {
                        if (_declaresLocal(c.childForFieldName('initializer'), name, refNode)) return true;
                    }
                }
            } else if (p.type === 'if_statement' || p.type === 'expression_switch_statement' ||
                p.type === 'type_switch_statement') {
                if (_declaresLocal(p.childForFieldName('initializer'), name, refNode)) return true;
                // if/switch initializers are plain named children in some
                // grammar versions; type switches bind `v := x.(type)`
                for (let i = 0; i < p.namedChildCount; i++) {
                    const c = p.namedChild(i);
                    if (c.type === 'short_var_declaration' && _declaresLocal(c, name, refNode)) return true;
                    if (p.type === 'type_switch_statement' && c.type === 'expression_list' &&
                        c.nextSibling?.type === ':=') {
                        for (let j = 0; j < c.namedChildCount; j++) {
                            const id = c.namedChild(j);
                            if (id.type === 'identifier' && id.text === name) return true;
                        }
                    }
                }
            } else if (p.type === 'func_literal' || p.type === 'function_declaration' ||
                p.type === 'method_declaration') {
                if (_paramListDeclares(p.childForFieldName('parameters'), name)) return true;
                if (p.type === 'method_declaration' &&
                    _paramListDeclares(p.childForFieldName('receiver'), name)) return true;
            }
        }
        return false;
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
                                } else if (callFuncNode.type === 'identifier' &&
                                    callFuncNode.text === 'new') {
                                    // buf := new(bytes.Buffer) — the builtin
                                    // allocator returns *T (fix #220,
                                    // cobra-measured: buf.String() is
                                    // bytes.Buffer's, never a project method).
                                    // The argument parses as an expression:
                                    // identifier or selector_expression.
                                    const args = val.childForFieldName('arguments');
                                    const argNode = args && args.namedChild(0);
                                    if (argNode) {
                                        typeName = argNode.type === 'identifier'
                                            ? argNode.text
                                            : argNode.type === 'selector_expression'
                                                ? argNode.childForFieldName('field')?.text || null
                                                : extractTypeName(argNode);
                                    }
                                }
                            }
                        }
                        if (typeName) typeMap.set(names[vi], typeName);
                    }
                }
            }
        }

        // Explicitly typed var declarations: `var buf bytes.Buffer`,
        // `var sb strings.Builder` (fix #220, cobra-measured — sb.String()
        // on an untyped receiver fell to single-owner confirmation). Same
        // semantics as parameter annotations: the declared type is the
        // receiver's compile-time type.
        if (node.type === 'var_declaration' && functionStack.length > 0) {
            const scopeKey = functionStack[functionStack.length - 1].startLine;
            const varTypeMap = scopeTypes.get(scopeKey);
            if (varTypeMap) {
                const recordSpec = (spec) => {
                    if (spec.type !== 'var_spec') return;
                    const typeName = extractTypeName(spec.childForFieldName('type'));
                    if (!typeName) return;
                    for (let j = 0; j < spec.namedChildCount; j++) {
                        const id = spec.namedChild(j);
                        if (id.type === 'identifier') varTypeMap.set(id.text, typeName);
                    }
                };
                for (let i = 0; i < node.namedChildCount; i++) {
                    const c = node.namedChild(i);
                    if (c.type === 'var_spec') recordSpec(c);
                    else if (c.type === 'var_spec_list') {
                        for (let j = 0; j < c.namedChildCount; j++) recordSpec(c.namedChild(j));
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

            // Call-site arg count for arity pruning. Slice-spread (`xs...`)
            // makes the count open-ended — flag it so pruning skips the site.
            const argsNode = node.childForFieldName('arguments');
            let argCount = 0;
            let argSpread = false;
            if (argsNode) {
                for (let i = 0; i < argsNode.namedChildCount; i++) {
                    if (argsNode.namedChild(i).type === 'comment') continue;
                    argCount++;
                }
                for (let i = 0; i < argsNode.childCount; i++) {
                    if (argsNode.child(i).type === '...') { argSpread = true; break; }
                }
            }

            // Assignment target for return-type flow (fix #207):
            // bb := balancer.Get(n) lets findCallers type bb from Get's
            // declared return type at query time.
            const assigned = goAssignmentTargetOf(node);

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
                const firstArg = getFirstStringArg(node);
                calls.push({
                    name: callName,
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    argCount,
                    ...(argSpread && { argSpread: true }),
                    ...(assigned && { assignedTo: assigned.assignedTo }),
                    ...(assigned?.assignedTuple && { assignedTuple: true }),
                        ...(assigned?.assignedTupleRest && { assignedTupleRest: assigned.assignedTupleRest }),
                    enclosingFunction,
                    uncertain,
                    ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp })
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
                    // fix #202: one-hop declared-field receivers — h.inner.Run().
                    // receiverRoot/Field/RootType let findCallers hop to the
                    // field's declared struct-field type cross-file.
                    let receiverRoot, receiverFieldName, receiverRootType;
                    if (!receiver && operandNode?.type === 'selector_expression') {
                        const rootNode = operandNode.childForFieldName('operand');
                        const fldNode = operandNode.childForFieldName('field');
                        if (rootNode?.type === 'identifier' && fldNode &&
                            !importAliases.has(rootNode.text)) {
                            receiverRoot = rootNode.text;
                            receiverFieldName = fldNode.text;
                            receiverRootType = getReceiverType(rootNode.text);
                        }
                    }
                    // Chained receiver (fix #220, cobra-measured): the receiver
                    // IS a call — rootCmd.Flags().String(...) — record the
                    // producer so findCallers can type the receiver from its
                    // declared return (*pflag.FlagSet → external → routed).
                    // Package-qualified producers (os.CreateTemp().Name())
                    // carry the qualifier for strict import-package resolution.
                    let receiverCall, receiverCallIsMethod, receiverCallReceiver;
                    if (!receiver && !receiverFieldName && operandNode?.type === 'call_expression') {
                        const prodFunc = operandNode.childForFieldName('function');
                        if (prodFunc?.type === 'identifier') {
                            receiverCall = prodFunc.text;
                        } else if (prodFunc?.type === 'selector_expression') {
                            const pf = prodFunc.childForFieldName('field');
                            const po = prodFunc.childForFieldName('operand');
                            if (pf) {
                                receiverCall = pf.text;
                                if (po?.type === 'identifier' && importAliases.has(po.text)) {
                                    receiverCallReceiver = po.text;
                                } else {
                                    receiverCallIsMethod = true;
                                }
                            }
                        }
                    }
                    const firstArg = getFirstStringArg(node);
                    calls.push({
                        name: fieldNode.text,
                        // Name-node line convention (#201/RUST-2, fix #223):
                        // a method call on a multi-line receiver —
                        // (&pkg.Name{...}).String() — reports the FIELD's own
                        // line, not the chain-start line. The account's ground
                        // set and the oracles key by the name's line; Go was
                        // the only parser still using the call node's start.
                        line: fieldNode.startPosition.row + 1,
                        isMethod: !isPkgCall,
                        receiver,
                        ...(receiverType && { receiverType }),
                        ...(receiverFieldName && { receiverRoot, receiverField: receiverFieldName }),
                        ...(receiverFieldName && receiverRootType && { receiverRootType }),
                        ...(receiverCall && { receiverCall }),
                        ...(receiverCallIsMethod && { receiverCallIsMethod: true }),
                        ...(receiverCallReceiver && { receiverCallReceiver }),
                        argCount,
                        ...(argSpread && { argSpread: true }),
                        ...(assigned && { assignedTo: assigned.assignedTo }),
                        ...(assigned?.assignedTuple && { assignedTuple: true }),
                        ...(assigned?.assignedTupleRest && { assignedTupleRest: assigned.assignedTupleRest }),
                        enclosingFunction,
                        uncertain,
                        ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp })
                    });
                }
            }
            return true;
        }

        // R3-NEW-3: Detect Go struct composite literals as constructor calls.
        //   Foo{x: 1}        → call(name='Foo', isConstructor:true)
        //   pkg.Foo{...}     → call(name='Foo', isConstructor:true) — strip package
        //   &Foo{...}        → composite_literal nested inside unary_expression;
        //                       handled because we visit the inner composite_literal node.
        // Skipped: anonymous types (slices/maps/arrays/struct types):
        //   []int{...}, map[string]int{...}, struct{...}{...}, [3]int{...}
        // These have non-identifier type children — only type_identifier and
        // qualified_type produce a real type name.
        if (node.type === 'composite_literal') {
            // Skip composite literals that are nested inside another composite_literal's
            // value position — those are inner field initializers like
            // `Outer{ field: Inner{...} }`. Both the outer and inner are real
            // constructors, so we DO emit each, but we must not emit the same
            // node twice. Tree-sitter visits each node once, so this is fine.
            const typeNode = node.childForFieldName('type');
            if (typeNode) {
                let typeName = null;
                let typeQualifier = null;
                if (typeNode.type === 'type_identifier') {
                    // Foo{...}
                    typeName = typeNode.text;
                } else if (typeNode.type === 'qualified_type') {
                    // pkg.Foo{...} — keep the package qualifier as receiver: a
                    // package-qualified type can never resolve to a same-file
                    // binding (Go cannot self-import), so resolution must not
                    // claim local same-name symbols for it.
                    const tn = typeNode.childForFieldName('name');
                    if (tn) typeName = tn.text;
                    typeQualifier = typeNode.childForFieldName('package')?.text || null;
                }
                // Skip anonymous types (slice_type, map_type, array_type, struct_type, etc.)
                if (typeName) {
                    const enclosingFunction = getCurrentEnclosingFunction();
                    calls.push({
                        name: typeName,
                        line: node.startPosition.row + 1,
                        isMethod: false,
                        isConstructor: true,
                        ...(typeQualifier && { receiver: typeQualifier }),
                        enclosingFunction,
                        uncertain: false
                    });
                }
            }
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

        // Detect plain identifier function references passed as arguments:
        // e.g., r.GET("/users", listUsers) — listUsers is a plain identifier in argument_list
        if (node.type === 'identifier' && node.parent?.type === 'argument_list') {
            const name = node.text;
            if (!GO_SKIP_IDENTS.has(name) && !importAliases.has(name)) {
                const enclosingFunction = getCurrentEnclosingFunction();
                calls.push({
                    name,
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    isFunctionReference: true,
                    isPotentialCallback: true,
                    enclosingFunction,
                    uncertain: false,
                    ...(isShadowedByLocal(node, name) && { localShadow: true }),
                });
            }
        }

        // Detect function-value assignments:
        // Pattern 1: sched.SchedulePod = sched.schedulePod (field = method reference)
        // Pattern 2: sched.SchedulePod = schedulePod (field = function reference)
        // Pattern 3: var handler = processEvent (short variable = function reference)
        // The RHS is a function reference (not a call — no parentheses)
        if (node.type === 'assignment_statement' || node.type === 'short_var_declaration') {
            // Skip blank identifier assignments: _ = x (used to suppress unused warnings)
            const left = node.childForFieldName('left');
            const isBlankAssign = left && left.text.trim() === '_';
            const right = isBlankAssign ? null : node.childForFieldName('right');
            if (right) {
                // Walk through the expression list (could be multiple assignments)
                const rhsNodes = right.type === 'expression_list' ? right.namedChildren : [right];
                for (const rhs of rhsNodes) {
                    // selector_expression: sched.schedulePod
                    if (rhs.type === 'selector_expression') {
                        const fieldNode = rhs.childForFieldName('field');
                        const operandNode = rhs.childForFieldName('operand');
                        if (fieldNode && operandNode) {
                            const receiver = operandNode.type === 'identifier' ? operandNode.text : undefined;
                            const receiverType = receiver ? getReceiverType(receiver) : undefined;
                            const enclosingFunction = getCurrentEnclosingFunction();
                            calls.push({
                                name: fieldNode.text,
                                line: rhs.startPosition.row + 1,
                                isMethod: true,
                                receiver,
                                ...(receiverType && { receiverType }),
                                enclosingFunction,
                                isPotentialCallback: true,
                                uncertain: false
                            });
                        }
                    }
                    // Plain identifier: schedulePod (standalone function reference)
                    if (rhs.type === 'identifier') {
                        const name = rhs.text;
                        if (!GO_SKIP_IDENTS.has(name) && !GO_BUILTINS.has(name) && !importAliases.has(name) && /^[a-zA-Z]/.test(name)) {
                            const enclosingFunction = getCurrentEnclosingFunction();
                            calls.push({
                                name,
                                line: rhs.startPosition.row + 1,
                                isMethod: false,
                                isFunctionReference: true,
                                isPotentialCallback: true,
                                enclosingFunction,
                                uncertain: false,
                                ...(isShadowedByLocal(rhs, name) && { localShadow: true }),
                            });
                        }
                    }
                }
            }
        }

        // Detect function references in composite literal fields:
        // ResourceEventHandlerFuncs{AddFunc: addNodeToCache, UpdateFunc: updateNode}
        // keyed_element → literal_element(key) ":" literal_element(value)
        // Go wraps values in literal_element nodes — unwrap to get the actual expression
        if (node.type === 'keyed_element') {
            // The value (second child, unwrap literal_element if present)
            let valueNode = node.namedChildCount >= 2 ? node.namedChild(node.namedChildCount - 1) : null;
            if (valueNode && valueNode.type === 'literal_element') {
                valueNode = valueNode.namedChildCount > 0 ? valueNode.namedChild(0) : null;
            }
            if (valueNode) {
                // Extract field name (the key) and parent composite literal type
                let keyNode = node.namedChildCount >= 1 ? node.namedChild(0) : null;
                if (keyNode && keyNode.type === 'literal_element') {
                    keyNode = keyNode.namedChildCount > 0 ? keyNode.namedChild(0) : null;
                }
                const fieldName = keyNode ? keyNode.text : undefined;

                let compositeType;
                let compositeLit = node.parent; // literal_value
                if (compositeLit && compositeLit.type === 'literal_value') {
                    compositeLit = compositeLit.parent; // composite_literal
                }
                if (compositeLit && compositeLit.type === 'composite_literal') {
                    const typeNode = compositeLit.childForFieldName('type');
                    if (typeNode) {
                        if (typeNode.type === 'qualified_type') {
                            const pkg = typeNode.childForFieldName('package')?.text;
                            const typeName = typeNode.childForFieldName('name')?.text;
                            compositeType = pkg && typeName ? `${pkg}.${typeName}` : typeNode.text;
                        } else if (typeNode.type === 'type_identifier') {
                            compositeType = typeNode.text;
                        }
                    }
                }

                if (valueNode.type === 'identifier') {
                    const name = valueNode.text;
                    if (!GO_SKIP_IDENTS.has(name) && !GO_BUILTINS.has(name) && !importAliases.has(name) && /^[a-zA-Z]/.test(name)) {
                        const enclosingFunction = getCurrentEnclosingFunction();
                        calls.push({
                            name,
                            line: valueNode.startPosition.row + 1,
                            isMethod: false,
                            isFunctionReference: true,
                            isPotentialCallback: true,
                            enclosingFunction,
                            uncertain: false,
                            ...(compositeType && { compositeType }),
                            ...(fieldName && { fieldName }),
                            ...(isShadowedByLocal(valueNode, name) && { localShadow: true }),
                        });
                    }
                }
                if (valueNode.type === 'selector_expression') {
                    const fieldNode = valueNode.childForFieldName('field');
                    const operandNode = valueNode.childForFieldName('operand');
                    if (fieldNode && operandNode) {
                        const receiver = operandNode.type === 'identifier' ? operandNode.text : undefined;
                        const receiverType = receiver ? getReceiverType(receiver) : undefined;
                        const enclosingFunction = getCurrentEnclosingFunction();
                        calls.push({
                            name: fieldNode.text,
                            line: valueNode.startPosition.row + 1,
                            isMethod: true,
                            receiver,
                            ...(receiverType && { receiverType }),
                            enclosingFunction,
                            isPotentialCallback: true,
                            uncertain: false,
                            ...(compositeType && { compositeType }),
                            ...(fieldName && { fieldName }),
                        });
                    }
                }
                // Inline closure: RunE: func(cmd *cobra.Command, args []string) { ... }
                // Mark the enclosing function as the entry point (the closure itself has no name)
                if (valueNode.type === 'func_literal' && compositeType && fieldName) {
                    const enclosing = getCurrentEnclosingFunction();
                    const enclosingName = typeof enclosing === 'string' ? enclosing : enclosing?.name;
                    if (enclosingName) {
                        calls.push({
                            name: enclosingName,
                            line: valueNode.startPosition.row + 1,
                            isMethod: false,
                            isFunctionReference: false,
                            isPotentialCallback: true,
                            enclosingFunction: enclosing,
                            uncertain: false,
                            compositeType,
                            fieldName,
                        });
                    }
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
            // Package name is last segment of path, skipping Go version suffixes (v2, v3, etc.)
            let pkgName = alias;
            if (!pkgName) {
                const parts = modulePath.split('/');
                // Go convention: if last segment matches /^v\d+$/, use the previous segment
                // e.g., k8s.io/klog/v2 → klog, github.com/foo/bar/v3 → bar
                const last = parts[parts.length - 1];
                pkgName = (/^v\d+$/.test(last) && parts.length > 1) ? parts[parts.length - 2] : last;
            }
            imports.push({
                module: modulePath,
                names: [pkgName],
                type: importType,
                dynamic,
                line
            });
        }
    }

    traverseTreeCached(tree.rootNode, (node) => {
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

    traverseTreeCached(tree.rootNode, (node) => {
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
 * @param {object} [tree] - Pre-parsed tree (per-operation cache); parsed here when absent
 * @returns {Array<{line: number, column: number, usageType: string}>}
 */
function findUsagesInCode(code, name, parser, tree) {
    tree = tree || parseTree(parser, code);
    const usages = [];

    visitNameNodes(tree, code, name, (node) => {
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
                     sameNode(parent.childForFieldName('function'), node)) {
                usageType = 'call';
            }
            // Definition: function name
            else if (parent.type === 'function_declaration' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: method name
            else if (parent.type === 'method_declaration' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: type name
            else if (parent.type === 'type_spec' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: variable name in short var declaration
            else if (parent.type === 'short_var_declaration') {
                const left = parent.childForFieldName('left');
                if (left && (sameNode(left, node) || left.namedChildren?.some(c => sameNode(c, node)))) {
                    usageType = 'definition';
                }
            }
            // Multi-var: x, err := foo() — identifier parent is expression_list
            else if (parent.type === 'expression_list' &&
                     parent.parent?.type === 'short_var_declaration' &&
                     sameNode(parent.parent.childForFieldName('left'), parent)) {
                usageType = 'definition';
            }
            // Definition: const/var spec
            else if (parent.type === 'const_spec' || parent.type === 'var_spec') {
                const nameNode = parent.childForFieldName('name');
                if (sameNode(nameNode, node)) {
                    usageType = 'definition';
                }
            }
            // Definition: parameter name (not the type)
            else if (parent.type === 'parameter_declaration' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Composite literal: Type{} — type_identifier is the type of composite_literal
            else if (parent.type === 'composite_literal' &&
                     sameNode(parent.childForFieldName('type'), node)) {
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

/**
 * Classify a Go symbol as a runtime entry point of a specific kind.
 * Returns 'test' | 'main' | null.
 *
 * - 'test': functions named Test*, Benchmark*, Example*, Fuzz* — invoked by `go test`.
 * - 'main': fn main / fn init — invoked by the Go runtime.
 *
 * Used by tracing/search so `affectedTests` only tags genuine test functions.
 */
function getEntryPointKind(symbol) {
    const { name } = symbol;
    // Test* stays receiver-agnostic — testify suite METHODS (func (s *Suite)
    // TestFoo) are genuinely harness-invoked.
    if (/^(Test|Benchmark|Example|Fuzz)[A-Z_]/.test(name)) return 'test';
    // Only FREE functions main/init are runtime entries — a method named
    // main/init on a receiver is an ordinary method (fix #243).
    if ((name === 'main' || name === 'init') && !symbol.className && !symbol.receiver) return 'main';
    return null;
}

/**
 * Check if a symbol is a Go-convention entry point.
 * These are invoked by the Go runtime or test runner, not user code.
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
