/**
 * languages/python.js - Tree-sitter based Python parsing
 *
 * Handles: function definitions (regular, async, decorated),
 * class definitions, and state objects (constants).
 */

const {
    traverseTree,
    traverseTreeCached,
    nodeToLocation,
    parseStructuredParams,
    extractPythonDocstring,
    paramTypesFromStructured,
    visitNameNodes,
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

// --- Single-pass helpers: extracted from find* callbacks ---

/**
 * Process a node for function extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 */
function _processFunction(node, functions, processedRanges, lines, code) {
    if (node.type === 'function_definition') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
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
            const docstring = extractPythonDocstring(lines, defLine);

            // Check for async
            const isAsync = node.text.trimStart().startsWith('async ');

            // Extract decorators
            const decorators = extractDecorators(node);

            // nameLine: the line where the name identifier lives (for deadcode def-site filtering)
            // Only set when different from startLine (i.e., when decorators push startLine earlier)
            const nameLine = nameNode.startPosition.row + 1;

            const paramsStructured = parseStructuredParams(paramsNode, 'python');
            const paramTypes = paramTypesFromStructured(paramsStructured);
            functions.push({
                name: nameNode.text,
                params: extractPythonParams(paramsNode),
                paramsStructured,
                startLine: decoratorStartLine,
                endLine,
                indent,
                isAsync,
                modifiers: isAsync ? ['async'] : [],
                ...(returnType && { returnType }),
                ...(paramTypes && { paramTypes }),
                ...(docstring && { docstring }),
                ...(decorators.length > 0 && { decorators }),
                ...(nameLine !== decoratorStartLine && { nameLine })
            });
        }
        return true;
    }

    return false;
}

/**
 * Process a node for class extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 */
function _processClass(node, classes, processedRanges, lines) {
    if (node.type !== 'class_definition') return false;

    const rangeKey = `${node.startIndex}-${node.endIndex}`;
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
        const members = extractClassMembers(node, lines);
        const defLine = getDefLine(node);
        const docstring = extractPythonDocstring(lines, defLine);
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
    return true;
}

// Module-level state detection patterns
const _STATE_PATTERN = /^(CONFIG|SETTINGS|[A-Z][A-Z0-9_]+|[A-Z][a-zA-Z]*(?:Config|Settings|Options|State|Store|Context))$/;
// Pattern for UPPER_CASE constants that may have scalar values (string, number, bool, etc.)
const _CONSTANT_PATTERN = /^[A-Z][A-Z0-9_]{1,}$/;
// RHS types that are scalar/simple values (not dict/list which are handled separately)
const _SCALAR_TYPES = new Set([
    'string', 'concatenated_string', 'integer', 'float', 'true', 'false', 'none',
    'unary_operator', 'binary_operator', 'tuple', 'set', 'parenthesized_expression',
    'call', 'attribute', 'identifier', 'subscript',
]);

/**
 * Process a node for state object extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 */
function _processState(node, objects, lines) {
    if (node.type === 'expression_statement' && node.parent && node.parent.parent === null) {
        const child = node.namedChild(0);
        if (child && child.type === 'assignment') {
            const leftNode = child.childForFieldName('left');
            const rightNode = child.childForFieldName('right');

            if (leftNode && leftNode.type === 'identifier' && rightNode) {
                const name = leftNode.text;
                const isObject = rightNode.type === 'dictionary';
                const isArray = rightNode.type === 'list';

                if ((isObject || isArray) && _STATE_PATTERN.test(name)) {
                    const { startLine, endLine } = nodeToLocation(node, lines);
                    objects.push({ name, startLine, endLine });
                    return true;
                } else if (_CONSTANT_PATTERN.test(name) && _SCALAR_TYPES.has(rightNode.type)) {
                    // Module-level UPPER_CASE constants with scalar values
                    const { startLine, endLine } = nodeToLocation(node, lines);
                    objects.push({ name, startLine, endLine, isConstant: true });
                    return true;
                }
            }
        }
    }
    return false;
}

/**
 * Collect module-scope assignment target names (fix #217). A module-level
 * `render = something` (including inside if/try/for blocks — module control
 * flow still binds module attributes) or a `global name` declaration creates
 * a module attribute the import-binding name-chase cannot model, so the
 * chase must treat such names as undetermined rather than provably absent.
 */
function _processModuleAssign(node, names) {
    if (node.type === 'global_statement') {
        // `global X` declares that enclosing-function assignments of X bind
        // the MODULE attribute — collect regardless of nesting.
        for (let i = 0; i < node.namedChildCount; i++) {
            const c = node.namedChild(i);
            if (c.type === 'identifier') names.add(c.text);
        }
        return;
    }
    if (node.type !== 'assignment' && node.type !== 'named_expression') return;
    for (let p = node.parent; p; p = p.parent) {
        // Function scope → local; class body → class attr. Either way, not a
        // module attribute. if/try/for/with blocks at module level still are.
        if (p.type === 'function_definition' || p.type === 'class_definition') return;
    }
    const left = node.childForFieldName('left') || node.childForFieldName('name');
    if (!left) return;
    if (left.type === 'identifier') names.add(left.text);
    else if (left.type === 'tuple' || left.type === 'pattern_list') {
        for (let i = 0; i < left.namedChildCount; i++) {
            const c = left.namedChild(i);
            if (c.type === 'identifier') names.add(c.text);
        }
    }
}

// --- End single-pass helpers ---

/**
 * Find all functions in Python code using tree-sitter
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
    const lines = code.split('\n');
    const classes = [];
    const processedRanges = new Set();
    traverseTreeCached(tree.rootNode, (node) => {
        _processClass(node, classes, processedRanges, lines);
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
            } else if (arg.type === 'subscript') {
                // Parameterized base: Generic[T], Protocol[T], Dict[str, int]
                const baseNode = arg.childForFieldName('value');
                if (baseNode) bases.push(baseNode.text);
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
                    } else if (dec.endsWith('.setter')) {
                        memberType = 'setter';
                    } else if (dec.endsWith('.deleter')) {
                        memberType = 'deleter';
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

                const paramsStructured = parseStructuredParams(paramsNode, 'python');
                const paramTypes = paramTypesFromStructured(paramsStructured);
                members.push({
                    name,
                    params: extractPythonParams(paramsNode),
                    paramsStructured,
                    startLine,
                    endLine,
                    memberType,
                    isAsync,
                    isMethod: true,  // Mark as method for context() lookups
                    // Match top-level Python functions: `async def` → ['async'] modifiers.
                    modifiers: isAsync ? ['async'] : [],
                    ...(returnType && { returnType }),
                    ...(paramTypes && { paramTypes }),
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
 * Parse a Python file completely
 */
function parse(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const functions = [];
    const classes = [];
    const stateObjects = [];
    const moduleAssigned = new Set();
    const processedFn = new Set();
    const processedCls = new Set();

    traverseTreeCached(tree.rootNode, (node) => {
        _processFunction(node, functions, processedFn, lines, code);
        _processClass(node, classes, processedCls, lines);
        _processState(node, stateObjects, lines);
        _processModuleAssign(node, moduleAssigned);
        return true;
    });

    functions.sort((a, b) => a.startLine - b.startLine);
    classes.sort((a, b) => a.startLine - b.startLine);
    stateObjects.sort((a, b) => a.startLine - b.startLine);

    return {
        language: 'python',
        totalLines: lines.length,
        functions,
        classes,
        stateObjects,
        ...(moduleAssigned.size > 0 && { moduleAssignedNames: [...moduleAssigned].sort() }),
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
// Builtin types for literal method receivers: {'a': 1}.get('a') is dict.get,
// never a project class method. Keys are tree-sitter node types.
const PY_LITERAL_RECEIVER_TYPES = {
    dictionary: 'dict',
    dictionary_comprehension: 'dict',
    list: 'list',
    list_comprehension: 'list',
    set: 'set',
    set_comprehension: 'set',
    string: 'str',
    concatenated_string: 'str',
    tuple: 'tuple',
};

// typing wrappers whose first argument is the actual value type
const PY_TYPE_WRAPPERS = new Set(['Optional', 'Annotated', 'Final', 'ClassVar']);

/**
 * Extract a single concrete type name from an annotation's `type` node.
 * Conservative by design: a wrong type would exclude true callers downstream
 * (receiver-type-mismatch), so anything ambiguous returns undefined.
 * Handles: Foo · pkg.Foo · Foo | None · Optional[Foo] · "Foo" · dict[str, int]
 */
function typeNameFromAnnotation(typeNode) {
    if (!typeNode) return undefined;
    const inner = typeNode.namedChildCount > 0 ? typeNode.namedChild(0) : null;
    return typeNameFromExpr(inner);
}

function typeNameFromExpr(node) {
    if (!node) return undefined;
    switch (node.type) {
        case 'identifier':
            return node.text;
        case 'attribute': {
            // dotted name: classes match by name in the symbol table → last segment
            const attr = node.childForFieldName('attribute');
            return attr?.text;
        }
        case 'binary_operator': {
            // PEP 604 union: X | None → X; unions of two real types are ambiguous
            const left = node.namedChild(0);
            const right = node.namedChild(1);
            if (left?.type === 'none' && right?.type !== 'none') return typeNameFromExpr(right);
            if (right?.type === 'none' && left?.type !== 'none') return typeNameFromExpr(left);
            return undefined;
        }
        case 'subscript': {
            // typing.Optional[Foo] parses as subscript when base is dotted
            const base = typeNameFromExpr(node.childForFieldName('value'));
            if (PY_TYPE_WRAPPERS.has(base)) {
                return typeNameFromExpr(node.childForFieldName('subscript'));
            }
            return base; // dict[str, int] → the receiver IS a dict
        }
        case 'generic_type': {
            // Optional[Foo] / Mapping[str, int] in annotation position
            const base = typeNameFromExpr(node.namedChild(0));
            if (PY_TYPE_WRAPPERS.has(base)) {
                const params = node.namedChild(1); // type_parameter → type wrappers
                const firstType = params && params.namedChildCount > 0 ? params.namedChild(0) : null;
                return typeNameFromAnnotation(firstType);
            }
            return base;
        }
        case 'string': {
            // forward reference: "Foo" — only accept a bare dotted name
            for (let i = 0; i < node.childCount; i++) {
                const c = node.child(i);
                if (c.type === 'string_content') {
                    const txt = c.text.trim();
                    if (/^[A-Za-z_][\w.]*$/.test(txt)) return txt.split('.').pop();
                }
            }
            return undefined;
        }
        default:
            return undefined;
    }
}

/**
 * Variable receiving this call's result: `x = foo(...)` / `x = await foo(...)`
 * → 'x'. Identifier targets only (no tuples/attributes). Compared by node id —
 * tree-sitter wrapper objects are not identity-stable.
 */
function assignmentTargetOf(callNode) {
    let n = callNode;
    let p = n.parent;
    if (p && p.type === 'await') { n = p; p = n.parent; }
    if (p && p.type === 'assignment') {
        const right = p.childForFieldName('right');
        const left = p.childForFieldName('left');
        if (right && right.id === n.id && left?.type === 'identifier') return left.text;
    }
    return undefined;
}

/**
 * Type name from a constructor-call callee: ClassName(...) or pkg.ClassName(...).
 * Uppercase-first heuristic (Python class naming convention).
 */
function constructorTypeName(funcNode) {
    if (!funcNode) return undefined;
    if (funcNode.type === 'identifier') {
        return /^[A-Z]/.test(funcNode.text) ? funcNode.text : undefined;
    }
    if (funcNode.type === 'attribute') {
        const attr = funcNode.childForFieldName('attribute');
        return attr && /^[A-Z]/.test(attr.text) ? attr.text : undefined;
    }
    return undefined;
}

function findCallsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const calls = [];
    const functionStack = [];  // Stack of { name, startLine, endLine }
    const aliases = new Map();  // Track local aliases: aliasName -> originalName
    const nonCallableNames = new Set();  // Track names assigned non-callable values
    const localVarTypes = new Map();  // Track local variable types: varName -> typeName (for receiverType inference)
    // Member-access aliases (fix #218): `append = output.append` makes a later
    // bare `append(part)` a METHOD call on `output` — it must carry the
    // receiver's evidence, never bind by bare name to a same-file def
    // (rich text.py: 7 list.append calls confirmed exact-binding against
    // Text.append). aliasName -> { receiver: string|null, attr: string };
    // receiver is null for chained/deep objects (self._text.append) — the
    // rewritten call is then receiver-blind and routes through dispatch tiering.
    const memberAliases = new Map();
    const memberAliasesStack = [];  // function-scoped save/restore, like localVarTypes
    const moduleAliases = new Set();  // Names bound to MODULES (import httpx / import numpy as np)
    const localVarTypesStack = [];  // Stack for function-scoped save/restore of localVarTypes

    // Helper: extract first string-arg literal from a call node.
    // Used by route extraction to capture path arg of requests.get('/users'), httpx.get('/users') etc.
    // Handles both plain strings and f-strings (returns interp:true with literal prefix).
    const { extractStringArg: _extractStringArg } = require('./utils');
    const getFirstStringArg = (callNode) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return null;
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type === 'comment') continue;
            // Handle f-string explicitly
            if (arg.type === 'string') {
                // f-string detection: tree-sitter-python wraps interpolations as 'interpolation' children.
                // If any interpolation child exists, this is interpolated; extract literal prefix.
                let interp = false;
                let prefix = '';
                for (let j = 0; j < arg.namedChildCount; j++) {
                    const sc = arg.namedChild(j);
                    if (sc.type === 'interpolation') { interp = true; break; }
                    if (sc.type === 'string_content') prefix += sc.text;
                }
                if (interp) {
                    return { value: prefix + (prefix.endsWith('*') ? '' : '*'), interp: true };
                }
                return _extractStringArg(arg);
            }
            return _extractStringArg(arg);
        }
        return null;
    };

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

    // fix #203: is a bare-identifier function REFERENCE shadowed by a local of
    // the enclosing function? Python locals are FUNCTION-scoped and an
    // assignment ANYWHERE in the function makes the name local for ALL its
    // references (UnboundLocalError semantics) — so scan the whole enclosing
    // function subtree (excluding nested function bodies, which are separate
    // scopes) for assignment/for/with-as/walrus bindings of the name.
    // Enclosing-function PARAMS are checked at query time in findCallers.
    const _targetBindsName = (left, name) => {
        if (!left) return false;
        if (left.type === 'identifier' && left.text === name) return true;
        if (left.type === 'pattern_list' || left.type === 'tuple_pattern') {
            for (let j = 0; j < left.namedChildCount; j++) {
                if (left.namedChild(j).type === 'identifier' && left.namedChild(j).text === name) return true;
            }
        }
        return false;
    };
    const _bindsNameInScope = (scopeNode, name) => {
        for (let i = 0; i < scopeNode.namedChildCount; i++) {
            const c = scopeNode.namedChild(i);
            if (c.type === 'function_definition' || c.type === 'async_function_definition' ||
                c.type === 'class_definition') {
                // The body is a separate scope, but the DEF NAME itself is an
                // assignment in THIS scope (fix #218: a nested `def get_style`
                // shadows the name for sibling references).
                if (c.childForFieldName('name')?.text === name) return true;
                continue;
            }
            if (c.type === 'lambda') continue; // separate scope, no name
            if (c.type === 'assignment' || c.type === 'augmented_assignment' || c.type === 'named_expression') {
                if (_targetBindsName(c.childForFieldName('left') || c.childForFieldName('name'), name)) return true;
            } else if (c.type === 'for_statement') {
                if (_targetBindsName(c.childForFieldName('left'), name)) return true;
            } else if (c.type === 'with_statement') {
                // with open(f) as fh: — as-target is inside with_clause/with_item
                const text = c.namedChild(0)?.text || '';
                const m = text.match(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)/);
                if (m && m[1] === name) return true;
            }
            if (_bindsNameInScope(c, name)) return true;
        }
        return false;
    };
    const PY_COMPREHENSIONS = new Set([
        'generator_expression', 'list_comprehension', 'set_comprehension', 'dictionary_comprehension',
    ]);
    const isShadowedByLocal = (refNode, name) => {
        for (let p = refNode.parent; p; p = p.parent) {
            // Comprehension for-clause targets are scoped to the comprehension
            // itself (PEP 3110-era scoping): `cell_len(line) for line in lines`
            // binds `line` ONLY inside the comprehension — block-accurate, so
            // check on the way up rather than function-wide (fix #218).
            if (PY_COMPREHENSIONS.has(p.type)) {
                for (let i = 0; i < p.namedChildCount; i++) {
                    const c = p.namedChild(i);
                    if (c.type === 'for_in_clause' && _targetBindsName(c.childForFieldName('left'), name)) return true;
                }
            }
            // Lambda params shadow their body the same way (fix #218).
            if (p.type === 'lambda') {
                const params = p.childForFieldName('parameters');
                if (params) for (let i = 0; i < params.namedChildCount; i++) {
                    const c = params.namedChild(i);
                    if (c.type === 'identifier' && c.text === name) return true;
                    if (c.type === 'default_parameter' && c.childForFieldName('name')?.text === name) return true;
                }
            }
            if (p.type === 'function_definition' || p.type === 'async_function_definition') {
                const body = p.childForFieldName('body');
                return body ? _bindsNameInScope(body, name) : false;
            }
        }
        return false; // module level — that's a module binding, not a shadow
    };

    traverseTree(tree.rootNode, (node) => {
        // Track module-alias bindings: `import httpx` binds 'httpx' (a module),
        // `import numpy as np` binds 'np'. Method calls through these receivers
        // dispatch to module functions, never to class methods. `from x import y`
        // is skipped — y may be a symbol, not a module.
        if (node.type === 'import_statement') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'dotted_name') {
                    const first = child.namedChild(0);
                    if (first?.type === 'identifier') moduleAliases.add(first.text);
                } else if (child.type === 'aliased_import') {
                    const alias = child.childForFieldName('alias');
                    if (alias?.type === 'identifier') moduleAliases.add(alias.text);
                }
            }
        }

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
            // Save localVarTypes so inner declarations don't leak to sibling functions
            localVarTypesStack.push(new Map(localVarTypes));
            memberAliasesStack.push(new Map(memberAliases));
        }

        // Track parameter type annotations: def foo(x: Foo) → x is Foo
        if (node.type === 'typed_parameter' || node.type === 'typed_default_parameter') {
            // typed_default_parameter has 'name' field; typed_parameter does not — use namedChild(0)
            const nameNode = node.childForFieldName('name') || node.namedChild(0);
            const typeNode = node.childForFieldName('type');
            if (nameNode?.type === 'identifier' && typeNode) {
                const typeName = typeNameFromAnnotation(typeNode);
                if (typeName && !['self', 'cls'].includes(nameNode.text)) {
                    localVarTypes.set(nameNode.text, typeName);
                }
            }
        }

        // Track with-statement bindings: with Client() as c → c is Client
        // (covers async with too — same with_item/as_pattern node shape)
        if (node.type === 'with_item') {
            const value = node.childForFieldName('value') || node.namedChild(0);
            if (value?.type === 'as_pattern') {
                const ctx = value.namedChild(0);
                const target = value.namedChildCount > 1 ? value.namedChild(value.namedChildCount - 1) : null;
                const targetId = target?.type === 'as_pattern_target' ? target.namedChild(0) : null;
                if (ctx?.type === 'call' && targetId?.type === 'identifier') {
                    const ctorName = constructorTypeName(ctx.childForFieldName('function'));
                    if (ctorName) localVarTypes.set(targetId.text, ctorName);
                }
            }
        }

        // Track local aliases and non-callable assignments
        if (node.type === 'assignment') {
            const left = node.childForFieldName('left');
            const right = node.childForFieldName('right');
            if (left?.type === 'identifier') {
                // Track type annotation: x: Foo = ... → x is Foo
                const typeNode = node.childForFieldName('type');
                if (typeNode) {
                    const typeName = typeNameFromAnnotation(typeNode);
                    if (typeName) {
                        localVarTypes.set(left.text, typeName);
                    }
                }
                memberAliases.delete(left.text); // any assignment rebinds the name
                // Rebinding without a known type makes any previously inferred
                // type stale — nearest-preceding-assignment semantics (#199's
                // documented rule). Without this, `x = ""; x = render(); x.m()`
                // would carry str and falsely exclude project methods.
                if (!typeNode) localVarTypes.delete(left.text);
                // Literal assignment types the variable (fix #218):
                // ansi_bytes = b"…" → bytes; out = [] → list. Compiler-true,
                // same trust grade as literal receivers ({}.get() → dict).
                if (!typeNode && right && PY_LITERAL_RECEIVER_TYPES[right.type]) {
                    let litType = PY_LITERAL_RECEIVER_TYPES[right.type];
                    if (litType === 'str' && /^[rRuU]*[bB]/.test(right.text)) litType = 'bytes';
                    localVarTypes.set(left.text, litType);
                }
                if (right?.type === 'identifier') {
                    aliases.set(left.text, right.text);
                }
                // Member-access alias (fix #218): append = output.append
                else if (right?.type === 'attribute') {
                    const attrName = right.childForFieldName('attribute');
                    const objNode = right.childForFieldName('object');
                    if (attrName?.type === 'identifier') {
                        memberAliases.set(left.text, {
                            receiver: objNode?.type === 'identifier' ? objNode.text : null,
                            attr: attrName.text,
                        });
                    }
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
                // Track non-callable assignments.
                // First: explicit literal check (handles dicts-with-lambdas correctly)
                if (right && isNonCallableInit(right)) {
                    nonCallableNames.add(left.text);
                }
                // Second: function call results are generally non-callable data
                // (e.g., close = series.dropna(), result = db.query(...))
                // Exception: partial() already handled above via alias tracking.
                else if (right?.type === 'call' && !aliases.has(left.text)) {
                    nonCallableNames.add(left.text);
                    // Infer type from constructor call: x = ClassName(...) or
                    // x = pkg.ClassName(...). Python convention: classes start uppercase
                    const ctorName = constructorTypeName(right.childForFieldName('function'));
                    if (ctorName) {
                        localVarTypes.set(left.text, ctorName);
                    }
                }
                // Third: subscript/attribute access results are non-callable data
                // (e.g., close = candles["close"].values, item = data[0])
                else if (right && !aliases.has(left.text) &&
                    ['subscript', 'attribute', 'binary_operator', 'comparison_operator',
                     'unary_operator', 'conditional_expression', 'await',
                     'parenthesized_expression', 'not_operator', 'boolean_operator'].includes(right.type)) {
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
            const assignedTo = assignmentTargetOf(node);

            // Call-site arg count (positional + keyword) for arity pruning.
            // *args/**kwargs splats make the count open-ended — flag them so
            // pruning skips the site.
            const callArgsNode = node.childForFieldName('arguments');
            let argCount = 0;
            let argSpread = false;
            if (callArgsNode) {
                for (let i = 0; i < callArgsNode.namedChildCount; i++) {
                    const arg = callArgsNode.namedChild(i);
                    if (arg.type === 'comment') continue;
                    if (arg.type === 'list_splat' || arg.type === 'dictionary_splat') argSpread = true;
                    argCount++;
                }
            }

            if (funcNode.type === 'identifier') {
                // Member-alias call (fix #218): `append = output.append` makes
                // this bare call a METHOD call on the alias's receiver — emit
                // it as one so receiver typing/dispatch tiering applies.
                // Restricted to self-named aliases (alias === attr, the local
                // bound-method optimization idiom): a renamed alias's line
                // doesn't contain the method name, so it sits outside the
                // account's text ground set — and never matched the target
                // name before either (no FP to fix there).
                const memberAlias = memberAliases.get(funcNode.text);
                if (memberAlias && memberAlias.attr === funcNode.text) {
                    const recvType = memberAlias.receiver ? localVarTypes.get(memberAlias.receiver) : undefined;
                    const recvIsModule = !!memberAlias.receiver && moduleAliases.has(memberAlias.receiver) &&
                        !localVarTypes.has(memberAlias.receiver);
                    calls.push({
                        name: memberAlias.attr,
                        line: node.startPosition.row + 1,
                        isMethod: true,
                        aliasCall: true,
                        ...(memberAlias.receiver && { receiver: memberAlias.receiver }),
                        ...(recvType && { receiverType: recvType }),
                        ...(recvIsModule && { receiverIsModule: true }),
                        ...(assignedTo && { assignedTo }),
                        argCount,
                        ...(argSpread && { argSpread: true }),
                        enclosingFunction,
                        uncertain,
                    });
                } else {
                    // Direct call: foo()
                    const resolvedName = aliases.get(funcNode.text);
                    const firstArg = getFirstStringArg(node);
                    calls.push({
                        name: funcNode.text,
                        ...(resolvedName && { resolvedName }),
                        line: node.startPosition.row + 1,
                        isMethod: false,
                        ...(assignedTo && { assignedTo }),
                        argCount,
                        ...(argSpread && { argSpread: true }),
                        enclosingFunction,
                        uncertain,
                        ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp })
                    });
                }
            } else if (funcNode.type === 'attribute') {
                // Method/attribute call: obj.foo() or self.attr.foo()
                const attrNode = funcNode.childForFieldName('attribute');
                const objNode = funcNode.childForFieldName('object');

                if (attrNode) {
                    let receiver = objNode?.type === 'identifier' ? objNode.text : undefined;
                    let selfAttribute = undefined;
                    // Chained receiver (fix #219): the receiver IS a call —
                    // fetch_data().json() — record the producer so findCallers
                    // can type the receiver from its declared return
                    // annotation. `(await f()).m()` unwraps to the call and
                    // marks awaited (an un-awaited async producer's value is a
                    // coroutine, not the annotation's type).
                    let receiverCall, receiverCallIsMethod, receiverCallAwaited;

                    // Detect super().method() pattern
                    if (objNode?.type === 'call') {
                        const superFunc = objNode.childForFieldName('function');
                        if (superFunc?.type === 'identifier' && superFunc.text === 'super') {
                            receiver = 'super';
                        }
                    }
                    {
                        let recvNode = objNode;
                        if (recvNode?.type === 'parenthesized_expression' &&
                            recvNode.namedChild(0)?.type === 'await') {
                            receiverCallAwaited = true;
                            recvNode = recvNode.namedChild(0).namedChild(0);
                        }
                        if (recvNode?.type === 'call' && receiver !== 'super') {
                            const prodFunc = recvNode.childForFieldName('function');
                            if (prodFunc?.type === 'identifier') {
                                receiverCall = prodFunc.text;
                            } else if (prodFunc?.type === 'attribute') {
                                const prodAttr = prodFunc.childForFieldName('attribute');
                                if (prodAttr) {
                                    receiverCall = prodAttr.text;
                                    receiverCallIsMethod = true;
                                }
                            }
                        }
                        if (!receiverCall) receiverCallAwaited = undefined;
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

                    // Literal receivers carry their builtin type: {}.get() can
                    // never be a project class method
                    const receiverType = receiver
                        ? localVarTypes.get(receiver)
                        : (objNode ? PY_LITERAL_RECEIVER_TYPES[objNode.type] : undefined);
                    // Module receiver (httpx.get()) — unless locally shadowed
                    // by a typed instance binding
                    const receiverIsModule = !!receiver && moduleAliases.has(receiver) &&
                        !localVarTypes.has(receiver);
                    const firstArg = getFirstStringArg(node);
                    calls.push({
                        name: attrNode.text,
                        // Multi-line chains (obj.x()\n.y()) must report each
                        // method's OWN name line, not the chain-start line —
                        // the account's ground set is keyed by the name's line
                        line: attrNode.startPosition.row + 1,
                        isMethod: true,
                        receiver,
                        ...(receiverType && { receiverType }),
                        ...(receiverIsModule && { receiverIsModule: true }),
                        ...(selfAttribute && { selfAttribute }),
                        ...(receiverCall && { receiverCall }),
                        ...(receiverCallIsMethod && { receiverCallIsMethod: true }),
                        ...(receiverCallAwaited && { receiverCallAwaited: true }),
                        ...(assignedTo && { assignedTo }),
                        argCount,
                        ...(argSpread && { argSpread: true }),
                        enclosingFunction,
                        uncertain,
                        ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp })
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
                            ...(isShadowedByLocal(arg, arg.text) && { localShadow: true }),
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
                                        ...(isShadowedByLocal(val, val.text) && { localShadow: true }),
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
                // Restore localVarTypes to pre-function state
                const saved = localVarTypesStack.pop();
                if (saved) {
                    localVarTypes.clear();
                    for (const [k, v] of saved) localVarTypes.set(k, v);
                }
                const savedAliases = memberAliasesStack.pop();
                if (savedAliases) {
                    memberAliases.clear();
                    for (const [k, v] of savedAliases) memberAliases.set(k, v);
                }
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

    traverseTreeCached(tree.rootNode, (node) => {
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

    traverseTreeCached(tree.rootNode, (node) => {
        // Look for __all__ = [...]
        if (node.type === 'expression_statement') {
            const child = node.namedChild(0);
            if (child && child.type === 'assignment') {
                const leftNode = child.childForFieldName('left');
                const rightNode = child.childForFieldName('right');

                if (leftNode && leftNode.type === 'identifier' && leftNode.text === '__all__') {
                    const line = node.startPosition.row + 1;

                    if (rightNode && (rightNode.type === 'list' || rightNode.type === 'tuple')) {
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

    visitNameNodes(tree, code, name, (node) => {
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
                // Track receiver for member expressions (obj.name → receiver = 'obj')
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

    traverseTreeCached(tree.rootNode, (node) => {
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

            // Build parameter type map from __init__ annotations
            // e.g. def __init__(self, market: MarketDataFetcher = None) → {market: MarketDataFetcher}
            const paramTypes = new Map();
            const params = child.childForFieldName('parameters');
            if (params) {
                for (let p = 0; p < params.childCount; p++) {
                    const param = params.child(p);
                    // typed_parameter or typed_default_parameter
                    if (param.type === 'typed_parameter' || param.type === 'typed_default_parameter') {
                        const pName = param.childForFieldName('name') || param.child(0);
                        const pType = param.childForFieldName('type');
                        if (pName && pType) {
                            const typeIdent = pType.type === 'type' ? pType.firstChild : pType;
                            if (typeIdent?.type === 'identifier') {
                                const tn = typeIdent.text;
                                if (!PRIMITIVE_TYPES.has(tn) && tn[0] >= 'A' && tn[0] <= 'Z') {
                                    paramTypes.set(pName.text, tn);
                                }
                            }
                        }
                    }
                }
            }

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
                } else if (rhs.type === 'identifier' && paramTypes.has(rhs.text)) {
                    // self.X = param where param has type annotation
                    attrTypes.set(attrName, paramTypes.get(rhs.text));
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

/**
 * Classify a Python symbol as a runtime entry point of a specific kind.
 * Returns 'test' | 'framework' | null.
 *
 * - 'test': pytest discovery (`test_*` functions, methods on `Test*` classes,
 *           `setUp`/`tearDown` lifecycle, pytest plugin hooks).
 * - 'framework': dunder methods (`__init__`, `__repr__`, etc.) — invoked by
 *                the Python runtime as part of the type protocol.
 *
 * Note: Python has no fn-level `main` entry point convention (the
 * `if __name__ == '__main__':` guard wraps statements, not a function).
 *
 * Used by tracing/search so `affectedTests` only tags genuine test functions.
 */
function getEntryPointKind(symbol) {
    const { name } = symbol;
    // Test entries first — pytest naming + unittest lifecycle hooks
    if (/^test_/.test(name)) return 'test';
    if (/^(setUp|tearDown)(Class|Module)?$/.test(name)) return 'test';
    if (/^pytest_/.test(name)) return 'test';
    // Methods inside a class whose name starts with Test (unittest/pytest discovery)
    if (symbol.isMethod && symbol.className && /^Test[A-Z_0-9]?/.test(symbol.className)) return 'test';
    // Dunder methods are framework entries (Python protocol)
    if (/^__\w+__$/.test(name)) return 'framework';
    return null;
}

/**
 * Check if a symbol is a Python-convention entry point.
 * These are invoked by the Python runtime, test runners, or frameworks.
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
    findInstanceAttributeTypes,
    isEntryPoint,
    getEntryPointKind,
    parse
};
