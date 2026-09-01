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
    sameNode,
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

const PY_FUNCTION_SCOPE_NODES = new Set([
    'function_definition', 'async_function_definition', 'lambda',
]);

/**
 * Concrete constructor calls returned by one Python function.
 *
 * This is deliberately data-only parser evidence. Query-time analysis still
 * resolves each qualifier against the producer file before deciding whether
 * the runtime class is project-owned or external. Recording the full
 * qualifier is what makes aliases such as
 * `Event = Union[asyncio.Event, trio.Event]` usable without treating the
 * annotation's unresolved terminal name as type identity.
 */
function extractReturnedConstructors(node) {
    const body = node.childForFieldName('body');
    if (!body) return null;
    const constructors = [];
    let incomplete = false;
    const unwrapValue = value => {
        let current = value;
        while (current && ['parenthesized_expression', 'await'].includes(current.type) &&
            current.namedChildCount === 1) {
            current = current.namedChild(0);
        }
        return current;
    };
    const stack = [body];
    while (stack.length > 0) {
        const current = stack.pop();
        if (current !== body && PY_FUNCTION_SCOPE_NODES.has(current.type)) continue;
        if (current.type === 'class_definition') continue;
        if (current.type === 'return_statement') {
            const value = unwrapValue(current.namedChild(0));
            if (value?.type !== 'call') {
                incomplete = true;
                continue;
            }
            const callable = value.childForFieldName('function');
            let type, qualifier;
            if (callable?.type === 'identifier') {
                type = callable.text;
            } else if (callable?.type === 'attribute') {
                type = callable.childForFieldName('attribute')?.text;
                qualifier = callable.childForFieldName('object')?.text;
            }
            if (!type || !/^[A-Z]/.test(type) || (qualifier && !/^[\w.]+$/.test(qualifier))) {
                incomplete = true;
                continue;
            }
            constructors.push({ type, ...(qualifier && { qualifier }) });
            continue;
        }
        for (let i = current.namedChildCount - 1; i >= 0; i--) {
            stack.push(current.namedChild(i));
        }
    }
    if (incomplete || constructors.length === 0 ||
        new Set(constructors.map(item => item.type)).size !== 1) return null;
    return constructors;
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
    // Distinguish "we have no node" (genuinely unknown) from "node is empty".
    // Returning '...' for empty parens conflated zero-param functions with
    // unknown signatures in JSON output (fix #241; go/rust got this in #238,
    // the shared utils.extractParams already had it).
    if (!paramsNode) return '...';
    const text = paramsNode.text;
    let params = text.replace(/^\(|\)$/g, '').trim();
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
            const returnedConstructors = extractReturnedConstructors(node);
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
                ...(returnedConstructors && { returnedConstructors }),
                ...(paramTypes && { paramTypes }),
                ...(docstring && { docstring }),
                ...(decorators.length > 0 && { decorators }),
                ...(isOverloadDecorated(decorators) && { isSignature: true }),
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
 * A typing @overload-decorated def is a SIGNATURE of the implementation that
 * follows, not a callable of its own (fix #265 — TS overload parity): the
 * runtime discards the stub bodies, so pin identity must close over the
 * group and resolution must prefer the implementation.
 */
function isOverloadDecorated(decorators) {
    return decorators.some(d => {
        const head = d.split('(')[0].trim();
        return head === 'overload' || head.endsWith('.overload');
    });
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
 * Return the runtime/type-identity head of a Python alias expression.
 * `typing.Dict[str, int]` and `dict[str, int]` both alias `dict`; a project
 * generic such as `Page[T]` aliases `Page`. Unions deliberately have no
 * single identity and therefore return null.
 */
const PY_ALIAS_RUNTIME_TYPES = new Map([
    ['Dict', 'dict'], ['List', 'list'], ['Set', 'set'], ['Tuple', 'tuple'],
    ['FrozenSet', 'frozenset'], ['Text', 'str'],
]);

function pythonAliasBase(node) {
    let current = unwrapTypeNode(node);
    while (current?.type === 'parenthesized_expression' &&
        current.namedChildCount === 1) {
        current = unwrapTypeNode(current.namedChild(0));
    }
    if (!current) return null;
    if (current.type === 'binary_operator') return null;
    if (current.type === 'subscript' || current.type === 'generic_type') {
        const parts = genericTypeParts(current);
        if (!parts?.base) return null;
        return PY_ALIAS_RUNTIME_TYPES.get(parts.base) || parts.base;
    }
    const base = typeNameFromExpr(current);
    return base ? (PY_ALIAS_RUNTIME_TYPES.get(base) || base) : null;
}

/**
 * Python type aliases: PEP 695 `type X = int`, annotated
 * `X: TypeAlias = ...`, and module-scope static aliases such as
 * `Scope = typing.Dict[str, Any]` become `type` symbols. The last form is
 * accepted only for conventional type-style names and generic type
 * expressions, avoiding ordinary runtime assignments.
 */
function _processTypeAlias(node, classes, processedRanges, lines) {
    let name;
    let valueNode;
    if (node.type === 'type_alias_statement') {
        // grammar shape: type <left> = <right>
        const left = node.namedChild(0);
        const right = node.namedChild(1);
        if (!left) return false;
        name = left.text.replace(/\[.*\]$/, ''); // strip PEP 695 type params
        valueNode = right || null;
    } else if (node.type === 'expression_statement') {
        const child = node.namedChild(0);
        if (!child || child.type !== 'assignment') return false;
        const typeNode = child.childForFieldName('type');
        const leftNode = child.childForFieldName('left');
        const rightNode = child.childForFieldName('right');
        if (!leftNode || leftNode.type !== 'identifier') return false;
        const explicit = !!typeNode && /\bTypeAlias\b/.test(typeNode.text);
        const implicit = !typeNode && node.parent?.type === 'module' &&
            /^[A-Z][A-Za-z0-9_]*$/.test(leftNode.text) &&
            ['subscript', 'generic_type'].includes(unwrapTypeNode(rightNode)?.type);
        if (!explicit && !implicit) return false;
        name = leftNode.text;
        valueNode = rightNode || null;
    } else {
        return false;
    }
    if (!name) return false;
    const rangeKey = `${node.startIndex}-${node.endIndex}`;
    if (processedRanges.has(rangeKey)) return true;
    processedRanges.add(rangeKey);
    const { startLine, endLine } = nodeToLocation(node, lines);
    const aliasOf = pythonAliasBase(valueNode);
    classes.push({
        name,
        type: 'type',
        startLine,
        endLine,
        methods: [],
        members: [],
        ...(aliasOf && { aliasOf }),
    });
    return true;
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
        _processClass(node, classes, processedRanges, lines) ||
            _processTypeAlias(node, classes, processedRanges, lines);
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
                const returnedConstructors = extractReturnedConstructors(funcNode);
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
                    ...(returnedConstructors && { returnedConstructors }),
                    ...(paramTypes && { paramTypes }),
                    ...(docstring && { docstring }),
                    ...(memberDecorators.length > 0 && { decorators: memberDecorators }),
                    ...(isOverloadDecorated(memberDecorators) && { isSignature: true }),
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
        _processClass(node, classes, processedCls, lines) ||
            _processTypeAlias(node, classes, processedCls, lines);
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
        ...(tree.rootNode.hasError && { parseRecovery: true }),
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

/**
 * Companion to typeNameFromAnnotation: the dotted module qualifier that owns
 * the annotated name (fix #286e, flask-measured: `app: flask.Flask` typed the
 * receiver bare 'Flask', and with a second test-local Flask class the origin
 * fell back to directory proximity and excluded a compiler-true caller).
 * Returns undefined when the annotation carries no qualifier.
 */
function typeQualifierFromAnnotation(typeNode) {
    if (!typeNode) return undefined;
    const inner = typeNode.namedChildCount > 0 ? typeNode.namedChild(0) : null;
    return typeQualifierFromExpr(inner);
}

function typeQualifierFromExpr(node) {
    if (!node) return undefined;
    switch (node.type) {
        case 'attribute':
            return node.childForFieldName('object')?.text;
        case 'parenthesized_expression':
            return node.namedChildCount === 1
                ? typeQualifierFromExpr(node.namedChild(0)) : undefined;
        case 'binary_operator': {
            const left = node.namedChild(0);
            const right = node.namedChild(1);
            if (left?.type === 'none' && right?.type !== 'none') return typeQualifierFromExpr(right);
            if (right?.type === 'none' && left?.type !== 'none') return typeQualifierFromExpr(left);
            return undefined;
        }
        case 'subscript': {
            const base = typeNameFromExpr(node.childForFieldName('value'));
            if (PY_TYPE_WRAPPERS.has(base)) {
                return typeQualifierFromExpr(node.childForFieldName('subscript'));
            }
            return undefined;
        }
        case 'generic_type': {
            const base = typeNameFromExpr(node.namedChild(0));
            if (PY_TYPE_WRAPPERS.has(base)) {
                const params = node.namedChild(1);
                const firstType = params && params.namedChildCount > 0 ? params.namedChild(0) : null;
                return typeQualifierFromAnnotation(firstType);
            }
            return undefined;
        }
        case 'string': {
            for (let i = 0; i < node.childCount; i++) {
                const c = node.child(i);
                if (c.type === 'string_content') {
                    const txt = c.text.trim();
                    if (/^[A-Za-z_][\w.]*$/.test(txt) && txt.includes('.')) {
                        return txt.split('.').slice(0, -1).join('.');
                    }
                }
            }
            return undefined;
        }
        default:
            return undefined;
    }
}

function typeNamesFromAnnotation(typeNode) {
    if (!typeNode) return [];
    const inner = typeNode.namedChildCount > 0 ? typeNode.namedChild(0) : null;
    const collect = node => {
        if (!node) return [];
        if (node.type === 'binary_operator' && node.text.includes('|')) {
            return [...collect(node.namedChild(0)), ...collect(node.namedChild(1))];
        }
        if (node.type === 'identifier') return node.text === 'None' ? [] : [node.text];
        if (node.type === 'none') return [];
        if (node.type === 'attribute') {
            const attr = node.childForFieldName('attribute');
            return attr ? [attr.text] : [];
        }
        return [];
    };
    return [...new Set(collect(inner))];
}

function unwrapTypeNode(node) {
    let current = node;
    while (current?.type === 'type' && current.namedChildCount === 1) {
        current = current.namedChild(0);
    }
    return current;
}

function genericTypeParts(node) {
    const current = unwrapTypeNode(node);
    if (!current || !['generic_type', 'subscript'].includes(current.type)) return null;
    const baseNode = current.type === 'subscript'
        ? (current.childForFieldName('value') || current.namedChild(0))
        : current.namedChild(0);
    const base = typeNameFromExpr(baseNode);
    if (!base) return null;
    let args;
    if (current.type === 'subscript') {
        args = [];
        for (let i = 0; i < current.namedChildCount; i++) {
            const child = current.namedChild(i);
            if (child.id !== baseNode.id) args.push(unwrapTypeNode(child));
        }
    } else {
        const params = current.namedChild(1);
        args = [];
        if (params) {
            for (let i = 0; i < params.namedChildCount; i++) {
                args.push(unwrapTypeNode(params.namedChild(i)));
            }
        }
    }
    return { base, args };
}

const PY_ITERABLE_ANNOTATIONS = new Set([
    'list', 'set', 'tuple', 'Iterable', 'Iterator', 'Sequence',
    'Collection', 'Generator', 'List', 'Set', 'Tuple',
]);

function iterableBindingTypes(typeNode) {
    const outer = genericTypeParts(typeNode);
    if (!outer || !PY_ITERABLE_ANNOTATIONS.has(outer.base) ||
        outer.args.length === 0) return [];
    const item = outer.args[0];
    const tuple = genericTypeParts(item);
    if (['tuple', 'Tuple'].includes(tuple?.base) && tuple.args.length > 0) {
        return tuple.args.map(arg => typeNameFromExpr(unwrapTypeNode(arg)));
    }
    const typeName = typeNameFromExpr(unwrapTypeNode(item));
    return typeName ? [typeName] : [];
}

function patternIdentifiers(node, out = []) {
    if (!node) return out;
    if (node.type === 'identifier') {
        out.push(node.text);
        return out;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
        patternIdentifiers(node.namedChild(i), out);
    }
    return out;
}

function enclosingPythonClassName(node) {
    for (let current = node; current; current = current.parent) {
        if (current.type === 'class_definition') {
            return current.childForFieldName('name')?.text;
        }
    }
    return null;
}

function explicitInstanceFieldContracts(tree, parser) {
    const result = new Map();
    const parseCommentType = comment => {
        const text = comment?.text?.trim();
        const prefix = '# type:';
        if (!text?.startsWith(prefix)) return null;
        const annotation = text.slice(prefix.length).trim();
        if (!annotation) return null;
        const annotationTree = parseTree(parser, `_value: ${annotation}`);
        const statement = annotationTree.rootNode.namedChild(0);
        const assignment = statement?.namedChild(0);
        return assignment?.childForFieldName('type') || null;
    };
    traverseTreeCached(tree.rootNode, node => {
        if (node.type !== 'expression_statement') return true;
        const assignment = node.namedChild(0);
        if (assignment?.type !== 'assignment') return true;
        const left = assignment.childForFieldName('left');
        if (left?.type !== 'attribute' ||
            left.childForFieldName('object')?.text !== 'self') return true;
        const field = left.childForFieldName('attribute')?.text;
        const className = enclosingPythonClassName(node);
        if (!field || !className) return true;
        let typeNode = assignment.childForFieldName('type');
        if (!typeNode) {
            const parent = node.parent;
            for (let i = 0; parent && i < parent.namedChildCount; i++) {
                const sibling = parent.namedChild(i);
                if (sibling.type === 'comment' &&
                    sibling.startPosition.row === node.endPosition.row) {
                    typeNode = parseCommentType(sibling);
                    if (typeNode) break;
                }
            }
        }
        if (!typeNode) return true;
        const type = typeNameFromAnnotation(typeNode);
        const itemTypes = iterableBindingTypes(typeNode);
        if (!type && itemTypes.length === 0) return true;
        if (!result.has(className)) result.set(className, new Map());
        result.get(className).set(field, {
            ...(type && { type }),
            ...(itemTypes.length > 0 && { itemTypes }),
        });
        return true;
    });
    return result;
}

function comprehensionReceiverType(
    refNode, receiverName, iterableTypes, callableIterableTypes = new Map(),
    instanceFieldContracts = new Map()) {
    for (let current = refNode?.parent; current; current = current.parent) {
        if (['generator_expression', 'list_comprehension',
            'set_comprehension', 'dictionary_comprehension'].includes(current.type)) {
            for (let i = 0; i < current.namedChildCount; i++) {
                const clause = current.namedChild(i);
                if (clause.type !== 'for_in_clause') continue;
                const names = patternIdentifiers(clause.childForFieldName('left'));
                const index = names.indexOf(receiverName);
                const iterable = clause.childForFieldName('right');
                const types = iterableTypesFromExpr(
                    iterable, iterableTypes, callableIterableTypes,
                    instanceFieldContracts, clause);
                if (index >= 0 && types?.[index]) return types[index];
            }
        }
        if (current.type === 'function_definition' ||
            current.type === 'async_function_definition' ||
            current.type === 'lambda') break;
    }
    return undefined;
}

function iterableTypesFromExpr(
    node, iterableTypes, callableIterableTypes,
    instanceFieldContracts = new Map(), contextNode = node) {
    const current = unwrapTypeNode(node);
    if (!current) return null;
    if (current.type === 'identifier') return iterableTypes.get(current.text) || null;
    if (current.type === 'call') {
        const fn = current.childForFieldName('function');
        if (fn?.type === 'identifier') return callableIterableTypes.get(fn.text) || null;
    }
    if (current.type === 'attribute' &&
        current.childForFieldName('object')?.text === 'self') {
        const field = current.childForFieldName('attribute')?.text;
        const className = enclosingPythonClassName(contextNode);
        return instanceFieldContracts.get(className)?.get(field)?.itemTypes || null;
    }
    return null;
}

function nodeContains(ancestor, node) {
    return !!ancestor && !!node &&
        node.startIndex >= ancestor.startIndex && node.endIndex <= ancestor.endIndex;
}

function isinstanceTypes(condition, receiverName) {
    if (!condition || condition.type !== 'call') return [];
    const fn = condition.childForFieldName('function');
    const args = condition.childForFieldName('arguments');
    if (fn?.type !== 'identifier' || fn.text !== 'isinstance' ||
        !args || args.namedChildCount < 2) return [];
    const value = args.namedChild(0);
    const typeExpr = args.namedChild(1);
    if (value?.type !== 'identifier' || value.text !== receiverName) return [];
    const extract = node => {
        if (!node) return [];
        if (node.type === 'identifier') return [node.text];
        if (node.type === 'attribute') {
            const attr = node.childForFieldName('attribute');
            return attr ? [attr.text] : [];
        }
        if (node.type === 'tuple') {
            const out = [];
            for (let i = 0; i < node.namedChildCount; i++) {
                out.push(...extract(node.namedChild(i)));
            }
            return out;
        }
        return [];
    };
    return [...new Set(extract(typeExpr))];
}

function narrowedReceiverType(refNode, receiverName, declaredUnion) {
    for (let current = refNode; current?.parent; current = current.parent) {
        const parent = current.parent;
        if (parent.type === 'if_statement') {
            const condition = parent.childForFieldName('condition');
            const positive = isinstanceTypes(condition, receiverName);
            if (positive.length === 0) continue;
            const consequence = parent.childForFieldName('consequence');
            const alternative = parent.childForFieldName('alternative');
            if (nodeContains(consequence, refNode) && positive.length === 1) {
                return positive[0];
            }
            if (nodeContains(alternative, refNode) && declaredUnion?.length) {
                const remaining = declaredUnion.filter(type => !positive.includes(type));
                if (remaining.length === 1) return remaining[0];
            }
        }
        if (parent.type === 'conditional_expression' &&
            parent.namedChildCount >= 3) {
            const consequence = parent.namedChild(0);
            const condition = parent.namedChild(1);
            const alternative = parent.namedChild(2);
            const positive = isinstanceTypes(condition, receiverName);
            if (nodeContains(consequence, refNode) && positive.length === 1) {
                return positive[0];
            }
            if (nodeContains(alternative, refNode) && declaredUnion?.length) {
                const remaining = declaredUnion.filter(type => !positive.includes(type));
                if (remaining.length === 1) return remaining[0];
            }
        }
        if (parent.type === 'function_definition' ||
            parent.type === 'async_function_definition' ||
            parent.type === 'lambda') break;
    }
    return undefined;
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
        case 'parenthesized_expression':
            return node.namedChildCount === 1
                ? typeNameFromExpr(node.namedChild(0)) : undefined;
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
 * For-loop iteration target of a call used as the iterable:
 * `for ep in entry_points(...)` / comprehension `for x in items()`.
 * The loop variable holds an ELEMENT of the producer's result, never the
 * return type itself — consumers must only use this for provenance
 * (external-producer demotion), never positive typing (fix #294).
 */
function iterTargetOf(callNode) {
    let n = callNode;
    let p = n.parent;
    if (p && p.type === 'await') { n = p; p = n.parent; }
    if (!p || (p.type !== 'for_statement' && p.type !== 'for_in_clause')) return undefined;
    const right = p.childForFieldName('right');
    if (!right || right.id !== n.id) return undefined;
    const left = p.childForFieldName('left');
    if (!left) return undefined;
    const names = [];
    if (left.type === 'identifier') {
        names.push(left.text);
    } else if (left.type === 'pattern_list' || left.type === 'tuple_pattern') {
        for (let i = 0; i < left.namedChildCount; i++) {
            const c = left.namedChild(i);
            if (c.type === 'identifier') names.push(c.text);
        }
    }
    if (names.length === 0) return undefined;
    return { first: names[0], rest: names.slice(1) };
}

function contextTargetOf(callNode) {
    const pattern = callNode?.parent;
    if (pattern?.type !== 'as_pattern' ||
        pattern.namedChild(0)?.id !== callNode.id) return undefined;
    const target = pattern.namedChild(pattern.namedChildCount - 1);
    if (target?.type === 'as_pattern_target') {
        const identifier = target.namedChild(0);
        return identifier?.type === 'identifier' ? identifier.text : undefined;
    }
    return target?.type === 'identifier' ? target.text : undefined;
}

/**
 * Type identity hint from a constructor-call callee: ClassName(...) or
 * pkg.ClassName(...).  Preserve the qualifier: dropping `threading` from
 * `threading.Thread()` turns an external class into an unqualified project
 * type name and can falsely confirm `thread.join()` against Project.join.
 * Uppercase-first remains a Python class-naming heuristic, so callers use the
 * qualifier as routing/provenance evidence rather than a hidden hard claim.
 */
function constructorTypeInfo(funcNode) {
    if (!funcNode) return undefined;
    if (funcNode.type === 'identifier') {
        return /^[A-Z]/.test(funcNode.text) ? { type: funcNode.text } : undefined;
    }
    if (funcNode.type === 'attribute') {
        const attr = funcNode.childForFieldName('attribute');
        const object = funcNode.childForFieldName('object');
        return attr && /^[A-Z]/.test(attr.text)
            ? { type: attr.text, qualifier: object?.text || undefined }
            : undefined;
    }
    return undefined;
}

function attributeReceiverPath(node) {
    if (!node || node.type !== 'attribute') return null;
    const fields = [];
    let current = node;
    while (current?.type === 'attribute') {
        const attribute = current.childForFieldName('attribute');
        if (!attribute) return null;
        fields.unshift(attribute.text);
        current = current.childForFieldName('object');
    }
    return current?.type === 'identifier' && fields.length > 0
        ? { root: current.text, fields }
        : null;
}

function iterableAttributeSource(node, localVarTypes) {
    const current = unwrapTypeNode(node);
    const path = attributeReceiverPath(current);
    if (!path) return null;
    return {
        root: path.root,
        fields: path.fields,
        ...(localVarTypes.get(path.root) && {
            rootType: localVarTypes.get(path.root),
        }),
    };
}

function literalStringValue(node) {
    if (node?.type !== 'string') return null;
    let value = '';
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child.type === 'interpolation') return null;
        if (child.type === 'string_content') value += child.text;
    }
    return value;
}

/**
 * Return the method name when a method call is dominated by a positive,
 * receiver-exact capability check:
 *
 *     if hasattr(self._stream, "aread"):
 *         await self._stream.aread(...)
 *
 * This is not type evidence—the runtime object may implement any matching
 * contract—but it is useful provenance for the visible dispatch tier. Keep
 * the recognizer deliberately narrow: a direct hasattr call or an AND term in
 * the if/elif condition. OR and NOT do not guarantee the capability on entry.
 */
function receiverCapabilityGuard(callNode, receiverNode, methodName) {
    if (!callNode || !receiverNode || !methodName) return undefined;
    const receiverText = receiverNode.text;

    const unwrap = node => {
        let current = node;
        while (current?.type === 'parenthesized_expression' &&
            current.namedChildCount === 1) {
            current = current.namedChild(0);
        }
        return current;
    };

    const matchesHasattr = node => {
        const current = unwrap(node);
        if (current?.type !== 'call') return false;
        const fn = current.childForFieldName('function');
        if (fn?.type !== 'identifier' || fn.text !== 'hasattr') return false;
        const args = current.childForFieldName('arguments');
        if (!args || args.namedChildCount < 2) return false;
        return args.namedChild(0)?.text === receiverText &&
            literalStringValue(args.namedChild(1)) === methodName;
    };

    const positivelyRequiresCapability = node => {
        const current = unwrap(node);
        if (matchesHasattr(current)) return true;
        if (current?.type !== 'boolean_operator') return false;
        let hasAnd = false;
        for (let i = 0; i < current.childCount; i++) {
            const child = current.child(i);
            if (!child.isNamed && child.type === 'and') hasAnd = true;
            if (!child.isNamed && child.type === 'or') return false;
        }
        return hasAnd && Array.from(
            { length: current.namedChildCount },
            (_, i) => current.namedChild(i)
        ).some(positivelyRequiresCapability);
    };

    let child = callNode;
    for (let current = callNode.parent; current; child = current, current = current.parent) {
        if (current.type === 'function_definition' || current.type === 'lambda') break;
        if (current.type !== 'if_statement' && current.type !== 'elif_clause') continue;
        const consequence = current.childForFieldName('consequence');
        if (!consequence || child.id !== consequence.id) continue;
        const condition = current.childForFieldName('condition') || current.namedChild(0);
        if (positivelyRequiresCapability(condition)) return methodName;
    }
    return undefined;
}

function pickleRoundTripSource(node) {
    if (node?.type !== 'call') return null;
    const loads = node.childForFieldName('function');
    if (loads?.type !== 'attribute' ||
        loads.childForFieldName('object')?.text !== 'pickle' ||
        loads.childForFieldName('attribute')?.text !== 'loads') return null;
    const loadsArgs = node.childForFieldName('arguments');
    const dumped = loadsArgs?.namedChild(0);
    if (dumped?.type !== 'call') return null;
    const dumps = dumped.childForFieldName('function');
    if (dumps?.type !== 'attribute' ||
        dumps.childForFieldName('object')?.text !== 'pickle' ||
        dumps.childForFieldName('attribute')?.text !== 'dumps') return null;
    const value = dumped.childForFieldName('arguments')?.namedChild(0);
    return value?.type === 'identifier' ? value.text : null;
}

function pythonTargetBindsName(left, name) {
    if (!left) return false;
    if (left.type === 'identifier' && left.text === name) return true;
    if (left.type === 'pattern_list' || left.type === 'tuple_pattern') {
        for (let i = 0; i < left.namedChildCount; i++) {
            if (left.namedChild(i).type === 'identifier' &&
                left.namedChild(i).text === name) return true;
        }
    }
    return false;
}

function pythonScopeBindsName(scopeNode, name) {
    for (let i = 0; i < scopeNode.namedChildCount; i++) {
        const child = scopeNode.namedChild(i);
        if (child.type === 'function_definition' ||
            child.type === 'async_function_definition' ||
            child.type === 'class_definition') {
            // The nested body is a separate scope, but the declaration name
            // binds in this scope.
            if (child.childForFieldName('name')?.text === name) return true;
            continue;
        }
        if (child.type === 'lambda') continue;
        if (child.type === 'assignment' ||
            child.type === 'augmented_assignment' ||
            child.type === 'named_expression') {
            if (pythonTargetBindsName(
                child.childForFieldName('left') || child.childForFieldName('name'),
                name)) return true;
        } else if (child.type === 'for_statement') {
            if (pythonTargetBindsName(child.childForFieldName('left'), name)) return true;
        } else if (child.type === 'with_statement') {
            const text = child.namedChild(0)?.text || '';
            const match = text.match(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)/);
            if (match && match[1] === name) return true;
        }
        if (pythonScopeBindsName(child, name)) return true;
    }
    return false;
}

const PY_COMPREHENSIONS = new Set([
    'generator_expression', 'list_comprehension', 'set_comprehension',
    'dictionary_comprehension',
]);

// Whether this reference is evaluated with `name` bound by an enclosing
// for/comprehension target. Keep the check lexical: a nested function has its
// own scope, and the iterable expression of `for x in source(x)` sees the
// outer x rather than the new loop binding.
function isPythonIterationBindingAt(refNode, name) {
    for (let parent = refNode?.parent; parent; parent = parent.parent) {
        if (parent.type === 'for_statement' &&
            pythonTargetBindsName(parent.childForFieldName('left'), name)) {
            const body = parent.childForFieldName('body');
            if (nodeContains(body, refNode)) return true;
        }
        if (PY_COMPREHENSIONS.has(parent.type)) {
            for (let i = 0; i < parent.namedChildCount; i++) {
                const clause = parent.namedChild(i);
                if (clause.type !== 'for_in_clause' ||
                    !pythonTargetBindsName(
                        clause.childForFieldName('left'), name)) continue;
                const iterable = clause.childForFieldName('right');
                if (!nodeContains(iterable, refNode)) return true;
            }
        }
        if (parent.type === 'function_definition' ||
            parent.type === 'async_function_definition' ||
            parent.type === 'lambda') break;
    }
    return false;
}

// Stronger subset used for dispatch tiering: an element drawn from an
// identifier/attribute iterable has unknown provenance. Direct call
// producers are handled separately by assignedIter flow: external calls
// demote there, while a project-internal producer intentionally keeps the
// measured single-owner rule (#294's counter-probe).
function isPythonUnprovenIterationBindingAt(refNode, name) {
    for (let parent = refNode?.parent; parent; parent = parent.parent) {
        if (parent.type === 'for_statement' &&
            pythonTargetBindsName(parent.childForFieldName('left'), name)) {
            const body = parent.childForFieldName('body');
            if (nodeContains(body, refNode)) {
                return unwrapTypeNode(parent.childForFieldName('right'))?.type !== 'call';
            }
        }
        if (PY_COMPREHENSIONS.has(parent.type)) {
            for (let i = 0; i < parent.namedChildCount; i++) {
                const clause = parent.namedChild(i);
                if (clause.type !== 'for_in_clause' ||
                    !pythonTargetBindsName(
                        clause.childForFieldName('left'), name)) continue;
                const iterable = clause.childForFieldName('right');
                if (!nodeContains(iterable, refNode)) {
                    return unwrapTypeNode(iterable)?.type !== 'call';
                }
            }
        }
        if (parent.type === 'function_definition' ||
            parent.type === 'async_function_definition' ||
            parent.type === 'lambda') break;
    }
    return false;
}

// Python locals are function-scoped: an assignment anywhere in the function
// shadows an imported module for every reference in that function. Keep this
// shared between call records and reference records so plan cannot promote a
// receiver that callers would reject as locally rebound.
function isPythonNameShadowedAt(refNode, name) {
    if (isPythonIterationBindingAt(refNode, name)) return true;
    for (let parent = refNode.parent; parent; parent = parent.parent) {
        if (PY_COMPREHENSIONS.has(parent.type)) {
            for (let i = 0; i < parent.namedChildCount; i++) {
                const clause = parent.namedChild(i);
                if (clause.type === 'for_in_clause' &&
                    pythonTargetBindsName(clause.childForFieldName('left'), name)) {
                    return true;
                }
            }
        }
        if (parent.type === 'lambda') {
            const params = parent.childForFieldName('parameters');
            if (params) for (let i = 0; i < params.namedChildCount; i++) {
                const param = params.namedChild(i);
                if (param.type === 'identifier' && param.text === name) return true;
                if (param.type === 'default_parameter' &&
                    param.childForFieldName('name')?.text === name) return true;
            }
        }
        if (parent.type === 'function_definition' ||
            parent.type === 'async_function_definition') {
            const params = parent.childForFieldName('parameters');
            if (params) {
                for (let i = 0; i < params.namedChildCount; i++) {
                    const param = params.namedChild(i);
                    const paramName = param.type === 'identifier'
                        ? param
                        : (param.childForFieldName('name') || param.namedChild(0));
                    if (paramName?.type === 'identifier' &&
                        paramName.text === name) return true;
                }
            }
            const body = parent.childForFieldName('body');
            return body ? pythonScopeBindsName(body, name) : false;
        }
    }
    return false;
}

/**
 * Whether an uppercase call target is a local VALUE binding rather than a
 * class declaration.
 *
 * Python permits runtime class factories and decorators to be rebound under
 * class-shaped names:
 *
 *     C2 = attrs.define(...)(Base)
 *     value = C2()
 *
 * The capitalization convention alone cannot type `value` as an indexed
 * `class C2` from another lexical scope.  Scan the nearest Python scope using
 * AST bindings and reject constructor-name inference when a parameter,
 * function, assignment, loop, or with-target owns the name.  A sole local
 * class declaration is deliberately allowed; its exact declaration is
 * selected later with the call site's enclosing-function range.
 */
function isPythonConstructorValueShadowedAt(refNode, name) {
    let scope = null;
    for (let parent = refNode?.parent; parent; parent = parent.parent) {
        if (PY_COMPREHENSIONS.has(parent.type)) {
            for (let i = 0; i < parent.namedChildCount; i++) {
                const clause = parent.namedChild(i);
                if (clause.type === 'for_in_clause' &&
                    pythonTargetBindsName(
                        clause.childForFieldName('left'), name)) return true;
            }
        }
        if (parent.type === 'lambda') {
            const params = parent.childForFieldName('parameters');
            if (params) {
                for (let i = 0; i < params.namedChildCount; i++) {
                    const param = params.namedChild(i);
                    const paramName = param.type === 'identifier'
                        ? param
                        : (param.childForFieldName('name') || param.namedChild(0));
                    if (paramName?.type === 'identifier' &&
                        paramName.text === name) return true;
                }
            }
            scope = parent;
            break;
        }
        if (parent.type === 'function_definition' ||
            parent.type === 'async_function_definition') {
            const params = parent.childForFieldName('parameters');
            if (params) {
                for (let i = 0; i < params.namedChildCount; i++) {
                    const param = params.namedChild(i);
                    const paramName = param.type === 'identifier'
                        ? param
                        : (param.childForFieldName('name') || param.namedChild(0));
                    if (paramName?.type === 'identifier' &&
                        paramName.text === name) return true;
                }
            }
            scope = parent.childForFieldName('body');
            break;
        }
        if (parent.type === 'class_definition') {
            scope = parent.childForFieldName('body');
            break;
        }
        if (parent.type === 'module') {
            scope = parent;
            break;
        }
    }
    if (!scope) return false;

    let classDeclarations = 0;
    const stack = [scope];
    while (stack.length > 0) {
        const node = stack.pop();
        if (node !== scope && (node.type === 'function_definition' ||
            node.type === 'async_function_definition' ||
            node.type === 'class_definition')) {
            const declaredName = node.childForFieldName('name')?.text;
            if (declaredName === name) {
                if (node.type === 'class_definition') classDeclarations++;
                else return true;
            }
            // The declaration name binds in this scope; its body does not.
            continue;
        }
        if (node.type === 'decorated_definition') {
            let declaration = null;
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'function_definition' ||
                    child.type === 'async_function_definition' ||
                    child.type === 'class_definition') {
                    declaration = child;
                    break;
                }
            }
            if (declaration) {
                const declaredName = declaration.childForFieldName('name')?.text;
                if (declaredName === name) {
                    if (declaration.type === 'class_definition') classDeclarations++;
                    else return true;
                }
                continue;
            }
        }
        if (node.type === 'assignment' ||
            node.type === 'augmented_assignment' ||
            node.type === 'named_expression') {
            if (pythonTargetBindsName(
                node.childForFieldName('left') || node.childForFieldName('name'),
                name)) return true;
        } else if (node.type === 'for_statement' || node.type === 'for_in_clause') {
            if (pythonTargetBindsName(node.childForFieldName('left'), name)) return true;
        } else if (node.type === 'with_item') {
            const value = node.childForFieldName('value') || node.namedChild(0);
            const target = value?.type === 'as_pattern'
                ? value.namedChild(value.namedChildCount - 1) : null;
            if (pythonTargetBindsName(
                target?.type === 'as_pattern_target' ? target.namedChild(0) : target,
                name)) return true;
        }
        for (let i = node.namedChildCount - 1; i >= 0; i--) {
            stack.push(node.namedChild(i));
        }
    }
    // Two conditional/repeated local class declarations with the same name
    // are not one stable identity.  Refuse the heuristic and leave the value
    // on the visible unverified rail.
    return classDeclarations > 1;
}

function pythonModuleAliases(tree) {
    const aliases = new Set();
    traverseTreeCached(tree.rootNode, node => {
        if (node.type !== 'import_statement') return true;
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child.type === 'dotted_name') {
                const first = child.namedChild(0);
                if (first?.type === 'identifier') aliases.add(first.text);
            } else if (child.type === 'aliased_import') {
                const alias = child.childForFieldName('alias');
                if (alias?.type === 'identifier') aliases.add(alias.text);
            }
        }
        return true;
    });
    return aliases;
}

function findCallsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const calls = [];
    const instanceFieldContracts = explicitInstanceFieldContracts(tree, parser);
    // Same-file callable return contracts are a closed type source for loop
    // bindings: `for item in parse_items()` can use
    // `parse_items() -> list[Item]` without guessing about external code.
    const callableIterableTypes = new Map();
    traverseTreeCached(tree.rootNode, node => {
        if (node.type !== 'function_definition') return true;
        const name = node.childForFieldName('name')?.text;
        const returnType = node.childForFieldName('return_type');
        const itemTypes = iterableBindingTypes(returnType);
        if (!name || itemTypes.length === 0) return true;
        const previous = callableIterableTypes.get(name);
        if (!previous) callableIterableTypes.set(name, itemTypes);
        else if (previous.join('\0') !== itemTypes.join('\0')) {
            // Overloads/redefinitions must agree before their result can type
            // a receiver.
            callableIterableTypes.delete(name);
        }
        return true;
    });
    const functionStack = [];  // Stack of { name, startLine, endLine }
    const aliases = new Map();  // Track local aliases: aliasName -> originalName
    const nonCallableNames = new Set();  // Track names assigned non-callable values
    const localVarTypes = new Map();  // Track local variable types: varName -> typeName (for receiverType inference)
    const declaredVarTypes = new Map(); // Compiler-checked annotations survive later assignments
    const localVarTypeQualifiers = new Map(); // varName -> imported module alias that owns the inferred type
    const localVarUnionTypes = new Map(); // varName -> concrete PEP 604 alternatives
    const localIterableTypes = new Map(); // iterable binding -> loop-variable types
    const localIterationSources = new Map(); // loop variable -> declared iterable path + tuple index
    const localDictValueTypes = new Map(); // local dict -> exact string-key value types
    const localVarStdlibContracts = new Map(); // variable -> stdlib module proving its type flow
    const assignmentRhsReceiverTypes = new Map(); // call-node id -> pre-assignment receiver type
    const constructedReceiverVars = new Set(); // exact constructor-result bindings
    const withBindingVars = new Set(); // names produced by a context-manager as-target
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
    const declaredVarTypesStack = [];
    const localVarTypeQualifiersStack = [];
    const localVarUnionTypesStack = [];
    const localIterableTypesStack = [];
    const localIterationSourcesStack = [];
    const localDictValueTypesStack = [];
    const localVarStdlibContractsStack = [];
    const constructedReceiverVarsStack = [];
    const withBindingVarsStack = [];

    // Helper: extract first string-arg literal from a call node.
    // Used by route extraction to capture path arg of requests.get('/users'), httpx.get('/users') etc.
    // Handles both plain strings and f-strings (returns interp:true with literal prefix).
    const { extractStringArg: _extractStringArg } = require('./utils');
    const getFirstStringArg = (callNode) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return null;
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type.endsWith('comment')) continue;
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
        if (functionStack.length === 0) return null;
        return {
            ...functionStack[functionStack.length - 1],
            scopeChain: functionStack.map(scope => scope.startLine),
        };
    };

    const isShadowedByLocal = isPythonNameShadowedAt;
    const exactConstructorInfo = funcNode => {
        const ctor = constructorTypeInfo(funcNode);
        if (!ctor) return undefined;
        if (!ctor.qualifier) {
            return isPythonConstructorValueShadowedAt(funcNode, ctor.type)
                ? undefined : ctor;
        }
        // Attribute calls are constructors only when the receiver is an
        // unshadowed module alias. `self.Widget()` / `factory.Widget()` and a
        // parameter shadowing `import pkg` are dynamic attribute dispatch,
        // not type identity. Previously their qualifier was discarded and
        // the terminal name could borrow an unrelated project class.
        const root = ctor.qualifier.split('.')[0];
        return moduleAliases.has(root) && !isShadowedByLocal(funcNode, root)
            ? ctor : undefined;
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
            const returnParts = genericTypeParts(
                node.childForFieldName('return_type'));
            const generatorSendType =
                ['Generator', 'AsyncGenerator'].includes(returnParts?.base) &&
                returnParts.args.length > 1
                    ? typeNameFromExpr(returnParts.args[1]) : undefined;
            functionStack.push({
                name: extractFunctionName(node),
                startLine,
                endLine: node.endPosition.row + 1,
                ...(generatorSendType && { generatorSendType }),
            });
            // Save localVarTypes so inner declarations don't leak to sibling functions
            localVarTypesStack.push(new Map(localVarTypes));
            declaredVarTypesStack.push(new Map(declaredVarTypes));
            localVarTypeQualifiersStack.push(new Map(localVarTypeQualifiers));
            localVarUnionTypesStack.push(new Map(localVarUnionTypes));
            localIterableTypesStack.push(new Map(localIterableTypes));
            localIterationSourcesStack.push(new Map(localIterationSources));
            localDictValueTypesStack.push(new Map(
                [...localDictValueTypes].map(([name, values]) =>
                    [name, new Map(values)])));
            localVarStdlibContractsStack.push(new Map(localVarStdlibContracts));
            constructedReceiverVarsStack.push(new Set(constructedReceiverVars));
            withBindingVarsStack.push(new Set(withBindingVars));
            memberAliasesStack.push(new Map(memberAliases));
        }

        // Track parameter type annotations: def foo(x: Foo) → x is Foo
        if (node.type === 'typed_parameter' || node.type === 'typed_default_parameter') {
            // typed_default_parameter has 'name' field; typed_parameter does not — use namedChild(0)
            let nameNode = node.childForFieldName('name') || node.namedChild(0);
            const parameterPattern = nameNode;
            if (nameNode && ['dictionary_splat_pattern', 'list_splat_pattern']
                .includes(nameNode.type)) {
                nameNode = nameNode.namedChild(0);
            }
            const typeNode = node.childForFieldName('type');
            if (nameNode?.type === 'identifier' && typeNode) {
                const typeName = typeNameFromAnnotation(typeNode);
                const unionTypes = typeNamesFromAnnotation(typeNode);
                const itemTypes = iterableBindingTypes(typeNode);
                const receiverType = parameterPattern?.type === 'dictionary_splat_pattern'
                    ? 'dict'
                    : (parameterPattern?.type === 'list_splat_pattern' ? 'tuple' : typeName);
                if (receiverType && !['self', 'cls'].includes(nameNode.text)) {
                    localVarTypes.set(nameNode.text, receiverType);
                    declaredVarTypes.set(nameNode.text, receiverType);
                    // The annotation's module qualifier is identity (fix
                    // #286e) — splat params got a builtin type, no qualifier.
                    const annotationQualifier = receiverType === typeName
                        ? typeQualifierFromAnnotation(typeNode) : undefined;
                    if (annotationQualifier) {
                        localVarTypeQualifiers.set(nameNode.text, annotationQualifier);
                    } else {
                        localVarTypeQualifiers.delete(nameNode.text);
                    }
                }
                if (unionTypes.length > 1) localVarUnionTypes.set(nameNode.text, unionTypes);
                else localVarUnionTypes.delete(nameNode.text);
                if (itemTypes.length > 0) localIterableTypes.set(nameNode.text, itemTypes);
                else localIterableTypes.delete(nameNode.text);
            }
        }

        // Compiler-declared iterable element flow for ordinary for-loops.
        // Tuple destructuring is positional: `for name, value in
        // headers:`, where headers is list[tuple[bytes, bytes]], types both
        // receivers as bytes. Comprehensions are handled at the call site
        // because their result expression precedes the for-clause in the AST.
        if (node.type === 'for_statement') {
            const left = node.childForFieldName('left');
            const right = node.childForFieldName('right');
            const itemTypes = iterableTypesFromExpr(
                right, localIterableTypes, callableIterableTypes,
                instanceFieldContracts, node);
            if (itemTypes?.length) {
                const names = patternIdentifiers(left);
                if (names.length === itemTypes.length) {
                    for (let i = 0; i < names.length; i++) {
                        if (itemTypes[i]) localVarTypes.set(names[i], itemTypes[i]);
                    }
                } else if (names.length === 1 && itemTypes.length === 1) {
                    localVarTypes.set(names[0], itemTypes[0]);
                }
            } else {
                const source = iterableAttributeSource(right, localVarTypes);
                const names = patternIdentifiers(left);
                for (let i = 0; source && i < names.length; i++) {
                    localIterationSources.set(names[i], {
                        ...source,
                        index: i,
                    });
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
                const recordWithTargets = n => {
                    if (!n) return;
                    if (n.type === 'identifier') withBindingVars.add(n.text);
                    for (let i = 0; i < n.namedChildCount; i++) recordWithTargets(n.namedChild(i));
                };
                recordWithTargets(targetId || target);
                if (ctx?.type === 'call' && targetId?.type === 'identifier') {
                    const constructorNode = ctx.childForFieldName('function');
                    const exactCtor = exactConstructorInfo(constructorNode);
                    if (exactCtor) {
                        localVarTypes.set(targetId.text, exactCtor.type);
                        constructedReceiverVars.add(targetId.text);
                        if (exactCtor.qualifier &&
                            moduleAliases.has(exactCtor.qualifier.split('.')[0])) {
                            localVarTypeQualifiers.set(targetId.text, exactCtor.qualifier);
                        } else {
                            localVarTypeQualifiers.delete(targetId.text);
                        }
                    } else if (ctx.childForFieldName('function')?.type === 'identifier' &&
                        ctx.childForFieldName('function').text === 'open' &&
                        !isShadowedByLocal(ctx.childForFieldName('function'), 'open')) {
                        // Builtin open() is its own context value and always
                        // yields an IO object. The exact text/binary subtype
                        // is irrelevant for method-owner exclusion.
                        localVarTypes.set(targetId.text, 'IO');
                    }
                }
            }
        }

        // Track local aliases and non-callable assignments
        if (node.type === 'assignment') {
            const left = node.childForFieldName('left');
            const right = node.childForFieldName('right');
            if (left?.type === 'identifier') {
                const previousType = localVarTypes.get(left.text);
                if (previousType && right?.type === 'call') {
                    const rightFunction = right.childForFieldName('function');
                    if (rightFunction?.type === 'attribute' &&
                        rightFunction.childForFieldName('object')?.type === 'identifier' &&
                        rightFunction.childForFieldName('object').text === left.text) {
                        assignmentRhsReceiverTypes.set(right.id, previousType);
                    }
                }
                // Track type annotation: x: Foo = ... → x is Foo
                const typeNode = node.childForFieldName('type');
                if (typeNode) {
                    const typeName = typeNameFromAnnotation(typeNode);
                    const unionTypes = typeNamesFromAnnotation(typeNode);
                    const itemTypes = iterableBindingTypes(typeNode);
                    if (typeName) {
                        localVarTypes.set(left.text, typeName);
                        declaredVarTypes.set(left.text, typeName);
                    }
                    if (unionTypes.length > 1) localVarUnionTypes.set(left.text, unionTypes);
                    else localVarUnionTypes.delete(left.text);
                    if (itemTypes.length > 0) localIterableTypes.set(left.text, itemTypes);
                    else localIterableTypes.delete(left.text);
                }
                memberAliases.delete(left.text); // any assignment rebinds the name
                constructedReceiverVars.delete(left.text);
                withBindingVars.delete(left.text);
                // Rebinding without a known type makes any previously inferred
                // type stale — nearest-preceding-assignment semantics (#199's
                // documented rule). Without this, `x = ""; x = render(); x.m()`
                // would carry str and falsely exclude project methods.
                if (!typeNode) {
                    localVarTypes.delete(left.text);
                    localVarTypeQualifiers.delete(left.text);
                    localVarUnionTypes.delete(left.text);
                    localIterableTypes.delete(left.text);
                    localIterationSources.delete(left.text);
                    localDictValueTypes.delete(left.text);
                    localVarStdlibContracts.delete(left.text);
                    // Python assignments remain constrained by a variable or
                    // parameter annotation. Constructor/literal inference is
                    // nearest-assignment only, but a declared contract is
                    // valid for every subsequent assignment in type-correct
                    // code (`boundary: bytes | None; boundary = make()`).
                    const declaredType = declaredVarTypes.get(left.text);
                    if (declaredType) localVarTypes.set(left.text, declaredType);
                } else {
                    // An annotation is the authoritative type source; a
                    // previous constructor qualifier must not survive it —
                    // the annotation's OWN qualifier does (fix #286e).
                    const annotationQualifier = typeNameFromAnnotation(typeNode)
                        ? typeQualifierFromAnnotation(typeNode) : undefined;
                    if (annotationQualifier) {
                        localVarTypeQualifiers.set(left.text, annotationQualifier);
                    } else {
                        localVarTypeQualifiers.delete(left.text);
                    }
                }
                // Preserve a declared collection contract through the common
                // normalization idiom `x = {} if x is None else x`. The
                // literal branch is a concrete implementation of the prior
                // protocol; retaining that protocol is compiler-safe and
                // keeps later method dispatch out of unrelated project
                // classes.
                if (!typeNode && previousType &&
                    right?.type === 'conditional_expression') {
                    const consequence = right.namedChild(0);
                    const alternative = right.namedChild(2);
                    const selfBranch = [consequence, alternative].find(
                        branch => branch?.type === 'identifier' &&
                            branch.text === left.text);
                    const otherBranch = selfBranch === consequence
                        ? alternative : consequence;
                    const literalType = otherBranch
                        ? PY_LITERAL_RECEIVER_TYPES[otherBranch.type] : null;
                    const compatible = {
                        Mapping: new Set(['dict']),
                        MutableMapping: new Set(['dict']),
                        Sequence: new Set(['list', 'tuple', 'str', 'bytes']),
                        MutableSequence: new Set(['list']),
                        Collection: new Set(['list', 'tuple', 'set', 'dict', 'str', 'bytes']),
                        Iterable: new Set(['list', 'tuple', 'set', 'dict', 'str', 'bytes']),
                    };
                    if (selfBranch && literalType &&
                        (previousType === literalType ||
                            compatible[previousType]?.has(literalType))) {
                        localVarTypes.set(left.text, previousType);
                    }
                }
                if (!typeNode && right?.type === 'yield') {
                    const sendType = functionStack[
                        functionStack.length - 1]?.generatorSendType;
                    if (sendType) localVarTypes.set(left.text, sendType);
                }
                // Literal assignment types the variable (fix #218):
                // ansi_bytes = b"…" → bytes; out = [] → list. Compiler-true,
                // same trust grade as literal receivers ({}.get() → dict).
                if (!typeNode && right && PY_LITERAL_RECEIVER_TYPES[right.type]) {
                    let litType = PY_LITERAL_RECEIVER_TYPES[right.type];
                    if (litType === 'str' && /^[rRuU]*[bB]/.test(right.text)) litType = 'bytes';
                    localVarTypes.set(left.text, litType);
                }
                if (right?.type === 'dictionary') {
                    const valueTypes = new Map();
                    for (let i = 0; i < right.namedChildCount; i++) {
                        const pair = right.namedChild(i);
                        if (pair.type !== 'pair') continue;
                        const key = literalStringValue(pair.childForFieldName('key'));
                        const value = pair.childForFieldName('value');
                        const valueType = value?.type === 'identifier'
                            ? localVarTypes.get(value.text)
                            : PY_LITERAL_RECEIVER_TYPES[value?.type];
                        if (key != null && valueType) valueTypes.set(key, valueType);
                    }
                    if (valueTypes.size > 0) {
                        localDictValueTypes.set(left.text, valueTypes);
                    }
                }
                const roundTripSource = pickleRoundTripSource(right);
                const roundTripType = roundTripSource
                    ? localVarTypes.get(roundTripSource) : null;
                if (roundTripType && moduleAliases.has('pickle')) {
                    localVarTypes.set(left.text, roundTripType);
                    localVarStdlibContracts.set(left.text, 'pickle');
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
                    const constructorNode = right.childForFieldName('function');
                    const exactCtor = exactConstructorInfo(constructorNode);
                    if (exactCtor) {
                        localVarTypes.set(left.text, exactCtor.type);
                        constructedReceiverVars.add(left.text);
                        if (exactCtor.qualifier &&
                            moduleAliases.has(exactCtor.qualifier.split('.')[0])) {
                            localVarTypeQualifiers.set(left.text, exactCtor.qualifier);
                        } else {
                            localVarTypeQualifiers.delete(left.text);
                        }
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
            const assignedContext = contextTargetOf(node);
            let assignedTo = assignmentTargetOf(node) || assignedContext;
            // For-loop iterable producer (fix #294): the loop variable's
            // provenance comes from this call. assignedIter marks that the
            // variable holds an ELEMENT, not the return value — the flow map
            // uses it for external-producer demotion only, never typing.
            let assignedIter = false;
            let assignedIterRest = null;
            if (!assignedTo) {
                const iterTarget = iterTargetOf(node);
                if (iterTarget) {
                    assignedTo = iterTarget.first;
                    assignedIterRest = iterTarget.rest;
                    assignedIter = true;
                }
            }
            const assignedIterFields = {
                ...(assignedIter && { assignedIter: true }),
                ...(assignedIter && assignedIterRest && assignedIterRest.length > 0 &&
                    { assignedTupleRest: assignedIterRest }),
            };

            // Call-site arg count (positional + keyword) for arity pruning.
            // *args/**kwargs splats make the count open-ended — flag them so
            // pruning skips the site.
            const callArgsNode = node.childForFieldName('arguments');
            let argCount = 0;
            let argSpread = false;
            if (callArgsNode) {
                for (let i = 0; i < callArgsNode.namedChildCount; i++) {
                    const arg = callArgsNode.namedChild(i);
                    if (arg.type.endsWith('comment')) continue;
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
                        ...assignedIterFields,
                        ...(assignedContext && { assignedContext: true }),
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
                        ...assignedIterFields,
                        ...(assignedContext && { assignedContext: true }),
                        argCount,
                        ...(argSpread && { argSpread: true }),
                        enclosingFunction,
                        uncertain,
                        ...(isShadowedByLocal(funcNode, funcNode.text) && { localShadow: true }),
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
                    const receiverPath = attributeReceiverPath(objNode);
                    // Chained receiver (fix #219): the receiver IS a call —
                    // fetch_data().json() — record the producer so findCallers
                    // can type the receiver from its declared return
                    // annotation. `(await f()).m()` unwraps to the call and
                    // marks awaited (an un-awaited async producer's value is a
                    // coroutine, not the annotation's type).
                    let receiverCall, receiverCallIsMethod, receiverCallAwaited, receiverCallLine;

                    // Detect super().method() pattern
                    if (objNode?.type === 'call') {
                        const superFunc = objNode.childForFieldName('function');
                        if (superFunc?.type === 'identifier' && superFunc.text === 'super') {
                            receiver = 'super';
                        }
                    }
                    {
                        let recvNode = objNode;
                        while (recvNode?.type === 'parenthesized_expression' &&
                            recvNode.namedChildCount === 1) {
                            recvNode = recvNode.namedChild(0);
                        }
                        if (recvNode?.type === 'await') {
                            receiverCallAwaited = true;
                            recvNode = recvNode.namedChild(0);
                            while (recvNode?.type === 'parenthesized_expression' &&
                                recvNode.namedChildCount === 1) {
                                recvNode = recvNode.namedChild(0);
                            }
                        }
                        if (recvNode?.type === 'call' && receiver !== 'super') {
                            const prodFunc = recvNode.childForFieldName('function');
                            if (prodFunc?.type === 'identifier') {
                                receiverCall = prodFunc.text;
                                // Producer link (fix #258): plain-call records
                                // carry the call node's start line
                                receiverCallLine = recvNode.startPosition.row + 1;
                            } else if (prodFunc?.type === 'attribute') {
                                const prodAttr = prodFunc.childForFieldName('attribute');
                                if (prodAttr) {
                                    receiverCall = prodAttr.text;
                                    receiverCallIsMethod = true;
                                    // Method records report the attribute
                                    // node's own line
                                    receiverCallLine = prodAttr.startPosition.row + 1;
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
                    let subscriptReceiverType;
                    if (objNode?.type === 'subscript') {
                        const base = objNode.childForFieldName('value');
                        const key = literalStringValue(
                            objNode.childForFieldName('subscript'));
                        if (base?.type === 'identifier' && key != null) {
                            subscriptReceiverType =
                                localDictValueTypes.get(base.text)?.get(key);
                        }
                    }
                    const receiverType = receiver
                        ? (narrowedReceiverType(
                            objNode, receiver, localVarUnionTypes.get(receiver)) ||
                            comprehensionReceiverType(
                                objNode, receiver, localIterableTypes,
                                callableIterableTypes, instanceFieldContracts) ||
                            localVarTypes.get(receiver))
                            || assignmentRhsReceiverTypes.get(node.id)
                        : (subscriptReceiverType ||
                            (objNode ? PY_LITERAL_RECEIVER_TYPES[objNode.type] : undefined));
                    let iterationSource = receiver
                        ? localIterationSources.get(receiver) : null;
                    if (receiver && !iterationSource) {
                        for (let current = objNode?.parent; current; current = current.parent) {
                            if (['generator_expression', 'list_comprehension',
                                'set_comprehension', 'dictionary_comprehension']
                                .includes(current.type)) {
                                for (let i = 0; i < current.namedChildCount; i++) {
                                    const clause = current.namedChild(i);
                                    if (clause.type !== 'for_in_clause') continue;
                                    const names = patternIdentifiers(
                                        clause.childForFieldName('left'));
                                    const index = names.indexOf(receiver);
                                    if (index < 0) continue;
                                    const source = iterableAttributeSource(
                                        clause.childForFieldName('right'),
                                        localVarTypes);
                                    if (source) iterationSource = {
                                        ...source, index,
                                    };
                                }
                            }
                            if (isFunctionNode(current)) break;
                        }
                    }
                    const receiverTypeQualifier = receiver
                        ? localVarTypeQualifiers.get(receiver)
                        : undefined;
                    const receiverRootType = receiverPath
                        ? localVarTypes.get(receiverPath.root) : undefined;
                    // Module receiver (httpx.get()) — unless locally shadowed
                    // by a typed instance binding
                    const receiverIsModule = !!receiver && moduleAliases.has(receiver) &&
                        !localVarTypes.has(receiver);
                    const firstArg = getFirstStringArg(node);
                    const capabilityGuard = receiverCapabilityGuard(
                        node, objNode, attrNode.text);
                    calls.push({
                        name: attrNode.text,
                        // Multi-line chains (obj.x()\n.y()) must report each
                        // method's OWN name line, not the chain-start line —
                        // the account's ground set is keyed by the name's line
                        line: attrNode.startPosition.row + 1,
                        isMethod: true,
                        receiver,
                        ...(receiverType && { receiverType }),
                        ...(receiver && localVarStdlibContracts.has(receiver) && {
                            receiverTypeStdlibModule:
                                localVarStdlibContracts.get(receiver),
                        }),
                        ...(receiverTypeQualifier && { receiverTypeQualifier }),
                        ...(receiver && constructedReceiverVars.has(receiver) && { receiverConstructed: true }),
                        ...(receiver && withBindingVars.has(receiver) && { receiverWithBinding: true }),
                        ...(receiverIsModule && { receiverIsModule: true }),
                        ...(receiver && objNode?.type === 'identifier' &&
                            isShadowedByLocal(objNode, receiver) && { receiverLocalBinding: true }),
                        ...(receiver && !receiverType && objNode?.type === 'identifier' &&
                            isPythonUnprovenIterationBindingAt(objNode, receiver) && {
                                receiverUntypedIteration: true,
                            }),
                        ...(receiverPath && {
                            receiverRoot: receiverPath.root,
                            receiverField: receiverPath.fields[receiverPath.fields.length - 1],
                            receiverFields: receiverPath.fields,
                        }),
                        ...(receiverRootType && { receiverRootType }),
                        ...(iterationSource && {
                            receiverIterationRoot: iterationSource.root,
                            receiverIterationFields: iterationSource.fields,
                            receiverIterationIndex: iterationSource.index,
                            ...(iterationSource.rootType && {
                                receiverIterationRootType: iterationSource.rootType,
                            }),
                        }),
                        ...(selfAttribute && { selfAttribute }),
                        ...(receiverCall && { receiverCall }),
                        ...(receiverCallIsMethod && { receiverCallIsMethod: true }),
                        ...(receiverCallAwaited && { receiverCallAwaited: true }),
                        ...(receiverCallLine && { receiverCallLine }),
                        ...(capabilityGuard && {
                            receiverCapabilityGuard: capabilityGuard,
                        }),
                        ...(assignedTo && { assignedTo }),
                        ...assignedIterFields,
                        ...(assignedContext && { assignedContext: true }),
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
                    // Method-value references (fix #295, flask-check-measured):
                    // `pytest.raises(NIE, t.check, None)` passes the bound
                    // method t.check — an attribute argument on a one-hop
                    // identifier receiver is a potential method value, typed
                    // from the same localVarTypes evidence method calls use.
                    // No isPotentialCallback: the record rides the MAIN path's
                    // full receiver physics (the JS HOF member-value
                    // convention), not the bare-name callback fast path.
                    // self/cls receivers (same-class values) and module-alias
                    // receivers (name-level ownership physics) are
                    // classified-deferred families — not emitted.
                    if (arg.type === 'attribute') {
                        const mvObj = arg.childForFieldName('object');
                        const mvAttr = arg.childForFieldName('attribute');
                        if (mvObj?.type === 'identifier' && mvAttr &&
                            !PYTHON_SKIP.has(mvObj.text) &&
                            !moduleAliases.has(mvObj.text) &&
                            !PYTHON_SKIP.has(mvAttr.text)) {
                            const mvType = localVarTypes.get(mvObj.text);
                            calls.push({
                                name: mvAttr.text,
                                line: mvAttr.startPosition.row + 1,
                                isMethod: true,
                                receiver: mvObj.text,
                                ...(mvType && { receiverType: mvType }),
                                isFunctionReference: true,
                                enclosingFunction
                            });
                        }
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
                const savedDeclared = declaredVarTypesStack.pop();
                if (savedDeclared) {
                    declaredVarTypes.clear();
                    for (const [k, v] of savedDeclared) declaredVarTypes.set(k, v);
                }
                const savedQualifiers = localVarTypeQualifiersStack.pop();
                if (savedQualifiers) {
                    localVarTypeQualifiers.clear();
                    for (const [k, v] of savedQualifiers) localVarTypeQualifiers.set(k, v);
                }
                const savedUnions = localVarUnionTypesStack.pop();
                if (savedUnions) {
                    localVarUnionTypes.clear();
                    for (const [k, v] of savedUnions) localVarUnionTypes.set(k, v);
                }
                const savedIterables = localIterableTypesStack.pop();
                if (savedIterables) {
                    localIterableTypes.clear();
                    for (const [k, v] of savedIterables) localIterableTypes.set(k, v);
                }
                const savedIterationSources = localIterationSourcesStack.pop();
                if (savedIterationSources) {
                    localIterationSources.clear();
                    for (const [k, v] of savedIterationSources) {
                        localIterationSources.set(k, v);
                    }
                }
                const savedDictValueTypes = localDictValueTypesStack.pop();
                if (savedDictValueTypes) {
                    localDictValueTypes.clear();
                    for (const [name, values] of savedDictValueTypes) {
                        localDictValueTypes.set(name, values);
                    }
                }
                const savedStdlibContracts = localVarStdlibContractsStack.pop();
                if (savedStdlibContracts) {
                    localVarStdlibContracts.clear();
                    for (const [name, moduleName] of savedStdlibContracts) {
                        localVarStdlibContracts.set(name, moduleName);
                    }
                }
                const savedConstructed = constructedReceiverVarsStack.pop();
                constructedReceiverVars.clear();
                if (savedConstructed) for (const name of savedConstructed) constructedReceiverVars.add(name);
                const savedWithBindings = withBindingVarsStack.pop();
                withBindingVars.clear();
                if (savedWithBindings) for (const name of savedWithBindings) withBindingVars.add(name);
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

    // Imports nested in a function/lambda do not execute during ordinary
    // module initialization. Preserve that AST fact so dependency-cycle
    // reporting can distinguish an eager import loop from a deliberate lazy
    // edge without deleting either edge from the graph.
    const isDeferredImport = (node) => {
        for (let parent = node.parent; parent; parent = parent.parent) {
            if (parent.type === 'function_definition' || parent.type === 'lambda') {
                return true;
            }
        }
        return false;
    };

    traverseTreeCached(tree.rootNode, (node) => {
        // import statement: import os, import sys as system
        if (node.type === 'import_statement') {
            const line = node.startPosition.row + 1;
            const deferred = isDeferredImport(node);

            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'dotted_name') {
                    // `import pkg.submodule` binds `pkg`, while also loading
                    // the complete submodule. Record both ownership edges so
                    // `pkg.public_api()` can resolve through pkg/__init__.py
                    // and `pkg.submodule.member` can still resolve to the
                    // imported child module.
                    const parts = child.text.split('.');
                    if (parts.length > 1) {
                        imports.push({
                            module: parts[0],
                            names: [parts[0]],
                            type: 'import',
                            line,
                            ...(deferred && { deferred: true })
                        });
                        imports.push({
                            module: child.text,
                            names: [],
                            type: 'import-submodule',
                            line,
                            ...(deferred && { deferred: true })
                        });
                    } else {
                        imports.push({
                            module: child.text,
                            names: [child.text],
                            type: 'import',
                            line,
                            ...(deferred && { deferred: true })
                        });
                    }
                } else if (child.type === 'aliased_import') {
                    // import sys as system
                    const nameNode = child.namedChild(0);
                    const aliasNode = child.namedChild(1);
                    if (nameNode) {
                        imports.push({
                            module: nameNode.text,
                            names: [aliasNode ? aliasNode.text : nameNode.text.split('.').pop()],
                            type: 'import',
                            line,
                            ...(deferred && { deferred: true })
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
            const deferred = isDeferredImport(node);
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
                    line,
                    ...(deferred && { deferred: true })
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
                    const deferred = isDeferredImport(node);
                    const isLiteral = firstArg.type === 'string';
                    imports.push({
                        module: isLiteral ? firstArg.text.replace(/^['"]|['"]$/g, '') : firstArg.text,
                        names: [],
                        type: 'dynamic',
                        line,
                        dynamic: !isLiteral,
                        ...(deferred && { deferred: true })
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
        // PEP 484 explicit re-export idiom:
        // `from .core import public_thing as public_thing`. The redundant
        // alias is deliberate compiler/tooling evidence that the imported
        // name belongs to this module's public surface even without __all__.
        if (node.type === 'import_from_statement') {
            let source = '';
            for (let index = 0; index < node.namedChildCount; index++) {
                const child = node.namedChild(index);
                if (!source && (child.type === 'dotted_name' ||
                    child.type === 'relative_import')) {
                    source = child.text;
                    continue;
                }
                if (child.type !== 'aliased_import') continue;
                const imported = child.namedChild(0);
                const alias = child.namedChild(1);
                if (imported?.text && alias?.text === imported.text) {
                    exports.push({
                        name: alias.text,
                        type: 're-export',
                        source,
                        line: node.startPosition.row + 1,
                    });
                }
            }
            return true;
        }
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
 * @param {object} [tree] - Pre-parsed tree (per-operation cache); parsed here when absent
 * @returns {Array<{line: number, column: number, usageType: string}>}
 */
function findUsagesInCode(code, name, parser, tree) {
    tree = tree || parseTree(parser, code);
    const usages = [];
    const moduleAliases = pythonModuleAliases(tree);

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
                     sameNode(parent.childForFieldName('function'), node)) {
                usageType = 'call';
            }
            // Definition: def name(...):
            else if (parent.type === 'function_definition' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: class name:
            else if (parent.type === 'class_definition' &&
                     sameNode(parent.childForFieldName('name'), node)) {
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
                     sameNode(parent.childForFieldName('left'), node)) {
                usageType = 'definition';
            }
            // Definition: for loop variable
            else if (parent.type === 'for_statement' &&
                     sameNode(parent.childForFieldName('left'), node)) {
                usageType = 'definition';
            }
            // Method call: obj.name()
            else if (parent.type === 'attribute' &&
                     sameNode(parent.childForFieldName('attribute'), node)) {
                const grandparent = parent.parent;
                if (grandparent && grandparent.type === 'call') {
                    usageType = 'call';
                } else {
                    usageType = 'reference';
                }
                // Track receiver for member expressions (obj.name → receiver = 'obj')
                const object = parent.childForFieldName('object');
                if (object && object.type === 'identifier') {
                    usages.push({
                        line,
                        column,
                        usageType,
                        receiver: object.text,
                        ...(moduleAliases.has(object.text) && { receiverIsModule: true }),
                        ...(isPythonNameShadowedAt(object, object.text) && {
                            receiverLocalBinding: true,
                        }),
                    });
                    return true;
                }
                // Constructed receiver: ColorTriplet(...).normalized is a
                // class-associated property reference, not an unowned bare
                // name. This matters to class-scoped `tests` queries.
                if (object && object.type === 'call') {
                    const ctor = object.childForFieldName('function');
                    if (ctor?.type === 'identifier') {
                        usages.push({ line, column, usageType, receiver: ctor.text });
                        return true;
                    }
                }
                // self.attr receiver (unittest setUp idiom: self.w = Widget(3);
                // self.w.render()) — record the ATTR name so the instance-type
                // map built from the assignment line ('w' → Widget) matches
                // (fix #244: class-scoped tests dropped these calls entirely).
                if (object && object.type === 'attribute') {
                    const innerObj = object.childForFieldName('object');
                    const innerAttr = object.childForFieldName('attribute');
                    if (innerObj && innerObj.type === 'identifier' &&
                        ['self', 'cls'].includes(innerObj.text) && innerAttr) {
                        usages.push({ line, column, usageType, receiver: innerAttr.text });
                        return true;
                    }
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
function findInstanceAttributeTypes(code, parser, options = {}) {
    const tree = parseTree(parser, code);
    const result = new Map(); // className -> Map(attrName -> typeName)
    const explicitContracts = explicitInstanceFieldContracts(tree, parser);

    const PRIMITIVE_TYPES = new Set(['int', 'float', 'str', 'bool', 'bytes', 'list', 'dict', 'set', 'tuple', 'None', 'Any', 'object']);

    traverseTreeCached(tree.rootNode, (node) => {
        if (node.type !== 'class_definition') return true;

        const classNameNode = node.childForFieldName('name');
        if (!classNameNode) return true;
        const className = classNameNode.text;

        const body = node.childForFieldName('body');
        if (!body) return false;

        const attrTypes = new Map();
        for (const [field, contract] of explicitContracts.get(className) || []) {
            if (contract.type) attrTypes.set(field, contract.type);
        }
        const methodReturns = new Map();
        for (let i = 0; i < body.namedChildCount; i++) {
            let member = body.namedChild(i);
            if (member.type === 'decorated_definition') {
                member = Array.from({ length: member.namedChildCount },
                    (_, index) => member.namedChild(index))
                    .find(child => child.type === 'function_definition') || member;
            }
            if (member.type !== 'function_definition') continue;
            const methodName = member.childForFieldName('name')?.text;
            const returnType = typeNameFromAnnotation(
                member.childForFieldName('return_type'));
            if (methodName && returnType) methodReturns.set(methodName, returnType);
        }

        // Scan annotated class-level fields: name: Type [= ...]. Originally
        // @dataclass-only (fix #28); a BARE class-body annotation is the
        // same compiler-visible typing evidence (`engine: Engine` inside
        // class Car types self.engine — pyright enforces it), so those scan
        // for every class (fix #234). Annotations WITH a value stay
        // dataclass-only: `tracker: BracketTracker = None` in a plain class
        // is routinely rebound to something else per-instance, while a
        // dataclass field default is constructor-managed.
        const parentNode = node.parent;
        const isDataclass = parentNode?.type === 'decorated_definition' &&
            Array.from({ length: parentNode.childCount }, (_, d) => parentNode.child(d))
                .some(dec => dec.type === 'decorator' &&
                    (dec.text.startsWith('@dataclass') || dec.text.includes('.dataclass')));
        for (let i = 0; i < body.childCount; i++) {
            const stmt = body.child(i);
            if (stmt.type !== 'expression_statement') continue;
            const assign = stmt.firstChild;
            if (!assign || assign.type !== 'assignment') continue;

            // Must have a type annotation
            const typeNode = assign.childForFieldName('type');
            if (!typeNode) continue;
            if (!isDataclass && assign.childForFieldName('right')) continue;

            // Use the same single-type annotation parser as parameters and
            // explicit instance fields. This admits compiler-equivalent bare
            // contracts such as `color: Optional[Color]` and `Color | None`,
            // while unions with several value types still abstain. Qualified
            // names need origin metadata that this compact attr map does not
            // retain, so leave those to declared field symbols.
            const typeName = typeNameFromAnnotation(typeNode);
            if (!typeName || typeQualifierFromAnnotation(typeNode)) continue;

            // Skip primitives and lowercase types
            if (PRIMITIVE_TYPES.has(typeName)) continue;
            if (typeName[0] < 'A' || typeName[0] > 'Z') continue;

            // Field name from LHS
            const lhs = assign.childForFieldName('left');
            if (!lhs || lhs.type !== 'identifier') continue;
            attrTypes.set(lhs.text, typeName);
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
                            // Use the shared annotation parser so forward
                            // references (`"Environment"`), dotted names,
                            // and Optional/union wrappers participate in the
                            // same conservative receiver-type contract as
                            // ordinary parameter calls.
                            const tn = typeNameFromAnnotation(pType);
                            if (tn && !PRIMITIVE_TYPES.has(tn) &&
                                tn[0] >= 'A' && tn[0] <= 'Z') {
                                paramTypes.set(pName.text, tn);
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
                } else if (rhs.type === 'call') {
                    const fn = rhs.childForFieldName('function');
                    if (fn?.type === 'attribute') {
                        const moduleName = fn.childForFieldName('object')?.text;
                        const functionName = fn.childForFieldName('attribute')?.text;
                        const methodType = moduleName === 'self' && functionName
                            ? methodReturns.get(functionName) : null;
                        const builtinType = moduleName && functionName &&
                            options.resolveBuiltinCallType?.(moduleName, functionName);
                        if (methodType || builtinType) {
                            attrTypes.set(attrName, methodType || builtinType);
                        }
                    }
                } else if (rhs.type === 'identifier' && paramTypes.has(rhs.text)) {
                    // self.X = param where param has type annotation
                    attrTypes.set(attrName, paramTypes.get(rhs.text));
                }

                return true;
            });
        }

        // Stable external/runtime constructors assigned outside __init__ are
        // still exact field evidence when every observed contract agrees.
        // This covers lifecycle-owned fields such as
        // `self.ready = asyncio.Event()` in serve(), without generalizing the
        // old constructor-name heuristic to arbitrary methods. Unknown or
        // conflicting assignments leave the field untyped.
        const runtimeFieldTypes = new Map();
        const invalidRuntimeFields = new Set();
        for (let i = 0; i < body.namedChildCount; i++) {
            let member = body.namedChild(i);
            if (member.type === 'decorated_definition') {
                member = Array.from({ length: member.namedChildCount },
                    (_, index) => member.namedChild(index))
                    .find(child => child.type === 'function_definition') || member;
            }
            if (member.type !== 'function_definition') continue;
            const memberBody = member.childForFieldName('body');
            if (!memberBody) continue;
            traverseTree(memberBody, stmt => {
                if (stmt.type !== 'expression_statement') return true;
                const assignment = stmt.firstChild;
                if (assignment?.type !== 'assignment') return true;
                const left = assignment.childForFieldName('left');
                const field = left?.type === 'attribute' &&
                    left.childForFieldName('object')?.text === 'self'
                    ? left.childForFieldName('attribute')?.text : null;
                if (!field) return true;
                const right = assignment.childForFieldName('right');
                const callable = right?.type === 'call'
                    ? right.childForFieldName('function') : null;
                const callableReceiver = callable?.type === 'attribute'
                    ? callable.childForFieldName('object') : null;
                const moduleName = callableReceiver?.type === 'identifier'
                    ? callableReceiver.text : null;
                const functionName = callable?.type === 'attribute'
                    ? callable.childForFieldName('attribute')?.text : null;
                const resolveCallType = options.resolveCallType ||
                    options.resolveBuiltinCallType;
                const runtimeType = moduleName && functionName &&
                    !isPythonNameShadowedAt(callable, moduleName)
                    ? resolveCallType?.(moduleName, functionName)
                    : null;
                if (!runtimeType) {
                    // None is a harmless uninitialized state; any other
                    // unknown write could replace the field with a project
                    // value and therefore invalidates exclusion-grade flow.
                    if (right?.type !== 'none') invalidRuntimeFields.add(field);
                    return true;
                }
                if (!runtimeFieldTypes.has(field)) runtimeFieldTypes.set(field, new Set());
                runtimeFieldTypes.get(field).add(runtimeType);
                return true;
            });
        }
        for (const [field, types] of runtimeFieldTypes) {
            if (invalidRuntimeFields.has(field) || types.size !== 1) continue;
            const type = [...types][0];
            if (!attrTypes.has(field) || attrTypes.get(field) === type) {
                attrTypes.set(field, type);
            }
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

// Stable CPython/stdlib runtime contracts. These are intentionally small and
// language-owned: callers must still prove that the import is external (not a
// project module with the same name) before using them as exclusion evidence.
const PY_BUILTIN_CALL_RETURNS = Object.freeze({
    'asyncio.Event': 'AsyncEvent',
    'base64.b64encode': 'bytes',
    'base64.b64decode': 'bytes',
    'json.dumps': 'str',
    'os.urandom': 'bytes',
    'urllib.request.getproxies': 'dict',
    'zlib.compressobj': 'ZlibCompress',
    'zlib.decompressobj': 'ZlibDecompress',
});

const PY_BUILTIN_FIELD_TYPES = Object.freeze({
    'os.environ': 'dict',
});

function getBuiltinCallReturnType(moduleName, functionName) {
    return PY_BUILTIN_CALL_RETURNS[`${moduleName}.${functionName}`] || null;
}

function getBuiltinFieldType(moduleName, fieldName) {
    return PY_BUILTIN_FIELD_TYPES[`${moduleName}.${fieldName}`] || null;
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
    getBuiltinCallReturnType,
    getBuiltinFieldType,
    isEntryPoint,
    getEntryPointKind,
    parse
};
