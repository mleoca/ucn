/**
 * languages/python.js - Tree-sitter based Python parsing
 *
 * Handles: function definitions (regular, async, decorated),
 * class definitions, and state objects (constants).
 */

const { ReceiverTypeMap, typeOrigin } = require('./type-evidence');
const { referenceScope, scopeFields } = require('./lexical-scope');


const {
    traverseTree,
    nodeTextWithoutComments,
    traverseTreeCached,
    nodeToLocation,
    parseStructuredParams,
    extractPythonDocstring,
    paramTypesFromStructured,
    visitNameNodes,
    sameNode,
    containsOwnNode,
    parseErrorRegions,
    branchClausesExclusive,
    getCachedNodeList,
} = require('./utils');

// A function whose OWN body yields is a generator: calling it returns an
// iterator (an async iterator for `async def`), never a coroutine.
const PY_YIELD_TYPES = new Set(['yield']);
const PY_SCOPE_BOUNDARIES = new Set(['function_definition', 'lambda', 'class_definition']);
function isPythonGenerator(fnNode) {
    const body = fnNode.childForFieldName('body');
    return !!body && body.text.includes('yield') &&
        containsOwnNode(body, PY_YIELD_TYPES, PY_SCOPE_BOUNDARIES);
}
const { PARSE_OPTIONS, safeParse } = require('./index');

// Statements that run in the namespace of the scope holding them: a def
// under `if`/`try`/`with`/`for`/`while`/`match` in a class body executes in
// the class namespace and binds a class attribute (a method), exactly like
// one written directly in the body (fix #402).
const PY_CLASS_BODY_COMPOUNDS = new Set(['block', 'if_statement', 'elif_clause', 'else_clause',
    'try_statement', 'except_clause', 'except_group_clause', 'finally_clause', 'with_statement',
    'for_statement', 'while_statement', 'match_statement', 'case_clause', 'decorated_definition']);

/** The class whose body declares `defNode` (a def or class, decorated or
 * not), through compound statements; null for any other scope. */
function pythonClassBodyOwner(defNode) {
    for (let node = defNode?.parent; node; node = node.parent) {
        if (node.type === 'class_definition') return node;
        if (!PY_CLASS_BODY_COMPOUNDS.has(node.type)) return null;
    }
    return null;
}

/** Function definitions a class body declares (decorated ones as their
 * `decorated_definition`), in source order, through compound statements;
 * nested functions and classes are not entered. */
function pythonClassBodyDefs(body) {
    const out = [];
    const visit = container => {
        for (let i = 0; i < container.namedChildCount; i++) {
            const child = container.namedChild(i);
            if (child.type === 'function_definition') { out.push(child); continue; }
            if (child.type === 'decorated_definition') {
                const definition = child.childForFieldName('definition');
                if (definition?.type === 'function_definition') out.push(child);
                continue;
            }
            if (child.type === 'class_definition') continue;
            if (PY_CLASS_BODY_COMPOUNDS.has(child.type)) visit(child);
        }
    };
    if (body) visit(body);
    return out;
}

/** The nodes an assignment target binds, through tuple and list targets:
 * identifiers (`kind` 'identifier') or attributes ('attribute'). */
function pythonTargetNames(target, kind) {
    const out = [];
    const visit = node => {
        if (!node) return;
        if (node.type === kind) { out.push(node); return; }
        if (['pattern_list', 'tuple_pattern', 'list_pattern', 'expression_list', 'tuple', 'list',
            'parenthesized_expression'].includes(node.type)) {
            for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
        }
    };
    visit(target);
    return out;
}

/** The first positional parameter's name of a function definition. */
function pythonReceiverName(fn) {
    const params = fn.childForFieldName('parameters');
    for (let i = 0; i < (params?.namedChildCount || 0); i++) {
        const param = params.namedChild(i);
        if (param.type === 'identifier') return param.text;
        if (['typed_parameter', 'default_parameter', 'typed_default_parameter'].includes(param.type)) {
            const name = param.childForFieldName('name') || param.namedChild(0);
            return name?.type === 'identifier' ? name.text : null;
        }
        if (param.type !== 'positional_separator') return null;
    }
    return null;
}

/** Whether a nested function or lambda binds `name` as a parameter. */
function pythonParamsBind(fn, name) {
    const params = fn.childForFieldName('parameters');
    for (let i = 0; i < (params?.namedChildCount || 0); i++) {
        let param = params.namedChild(i);
        if (param.type === 'default_parameter' || param.type === 'typed_default_parameter') {
            param = param.childForFieldName('name');
        } else if (param.type === 'typed_parameter') {
            param = param.namedChild(0);
        }
        if (param?.type === 'list_splat_pattern' || param?.type === 'dictionary_splat_pattern') {
            param = param.namedChild(0);
        }
        if (param?.type === 'identifier' && param.text === name) return true;
    }
    return false;
}

/** Instance attributes the methods of a class body assign on their receiver,
 * one per name in source order, names in `declared` excluded (fix #430).
 * A static method has no receiver; a nested class has its own; a nested
 * function or lambda that rebinds the receiver's name assigns another value. */
function pythonInstanceAttributes(bodyNode, declared) {
    const out = [];
    const seen = new Set(declared);
    for (const def of pythonClassBodyDefs(bodyNode)) {
        const fn = def.type === 'decorated_definition' ? def.childForFieldName('definition') : def;
        if (def.type === 'decorated_definition' && def.namedChildren.some(child =>
            child.type === 'decorator' && /^@\s*staticmethod\b/.test(child.text))) continue;
        const receiver = fn && pythonReceiverName(fn);
        const body = fn?.childForFieldName('body');
        if (!receiver || !body) continue;
        traverseTree(body, node => {
            if (node.type === 'class_definition') return false;
            if ((node.type === 'function_definition' || node.type === 'lambda') &&
                pythonParamsBind(node, receiver)) return false;
            if (node.type !== 'assignment' && node.type !== 'augmented_assignment') return true;
            const type = node.type === 'assignment' ? node.childForFieldName('type') : null;
            for (const target of pythonTargetNames(node.childForFieldName('left'), 'attribute')) {
                const object = target.childForFieldName('object');
                const attr = target.childForFieldName('attribute');
                if (object?.type !== 'identifier' || object.text !== receiver || !attr) continue;
                if (seen.has(attr.text)) continue;
                // Reading the previous member on the RHS does not change
                // the assignment's storage: `self.m = wrap(self.m)` creates
                // an instance attribute even if the class inherits `m`.
                seen.add(attr.text);
                out.push({ name: attr.text, startLine: attr.startPosition.row + 1,
                    endLine: node.endPosition.row + 1, memberType: 'field', instanceAttribute: true,
                    ...(type && { returnType: type.text, fieldType: type.text }) });
            }
            return true;
        });
    }
    return out;
}

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
        let text = nodeTextWithoutComments(returnTypeNode).trim();
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
    const text = nodeTextWithoutComments(paramsNode);
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

        // Skip functions a class body declares, directly or under its
        // compound statements: they're extracted as class members.
        if (pythonClassBodyOwner(node)) return true;

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
            const isGenerator = isPythonGenerator(node);

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
                sourceSpan: nodeToLocation(node.parent?.type === 'decorated_definition' ? node.parent : node, lines).sourceSpan,
                endLine,
                indent,
                isAsync,
                ...(isGenerator && { isGenerator }),
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
        const lexicalScope = pythonFunctionLocalScope(node);

        classes.push({
            name: nameNode.text,
            startLine,
            endLine,
            type: 'class',
            members,
            ...(docstring && { docstring }),
            ...(decorators.length > 0 && { decorators }),
            ...(bases.length > 0 && { extends: bases.join(', ') }),
            // A protocol class is satisfied by shape: no class has to name it.
            ...(isProtocolClass(node) && { protocolClass: true }),
            ...(nameLine !== startLine && { nameLine }),
            ...lexicalScope,
        });
    }
    return true;
}

/**
 * Lexical scope of a class declared inside a function (fix #381): the
 * enclosing function's body. The name is a local of that function, so it
 * is visible only there (including nested functions, which close over it).
 * Module-level and class-body classes are unscoped.
 */
function pythonFunctionLocalScope(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.type === 'class_definition') return {};
        if (parent.type === 'function_definition' ||
            parent.type === 'async_function_definition') {
            const body = parent.childForFieldName('body') || parent;
            return {
                lexicalScopeStartLine: body.startPosition.row + 1,
                lexicalScopeEndLine: body.endPosition.row + 1,
            };
        }
    }
    return {};
}

/**
 * Process a node for state object extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 */
function _processState(node, objects, lines) {
    if (node.type !== 'assignment') return false;
    for (let scope = node.parent; scope; scope = scope.parent) {
        if (scope.type === 'function_definition' || scope.type === 'lambda' ||
            scope.type === 'class_definition') return false;
    }
    if (node.parent?.type === 'expression_statement' &&
        _processTypeAlias(node.parent, [], new Set(), lines)) return false;
    const target = node.childForFieldName('left');
    if (!target) return false;
    const bindings = [];
    const collect = pattern => {
        if (pattern.type === 'identifier') bindings.push(pattern);
        else if (['pattern_list', 'tuple_pattern', 'list_pattern', 'list_splat_pattern'].includes(pattern.type)) {
            for (const child of pattern.namedChildren) collect(child);
        }
    };
    collect(target);
    for (const binding of bindings) {
        objects.push({ name: binding.text, startLine: binding.startPosition.row + 1,
            endLine: nodeToLocation(node, lines).endLine });
    }
    return bindings.length > 0;
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

/**
 * Module-level names bound exactly once, to another name (fix #389):
 * `Alias = Box`, `Alias = models.Box`. Query time decides whether the
 * target is a class; such an alias then denotes it in annotations and
 * constructor calls. A name bound again at module scope (assignment,
 * augmented assignment, loop/with/except target, import, def, class, walrus,
 * del) or declared `global` in any function is not an alias.
 */
function pythonModuleValueAliases(root) {
    // Cheap first pass: a module-level statement `Name = other.name` at all
    // (directly, or in a module-level if/try/with block).
    const aliasShaped = (expr) => expr?.type === 'assignment' &&
        expr.childForFieldName('left')?.type === 'identifier' &&
        ['identifier', 'attribute'].includes(expr.childForFieldName('right')?.type);
    let shaped = false;
    const probe = (node) => {
        for (const statement of node.namedChildren) {
            if (shaped) return;
            if (statement.type === 'expression_statement') {
                if (statement.namedChildren.some(aliasShaped)) shaped = true;
            } else if (/^(if_statement|elif_clause|else_clause|try_statement|except_clause|finally_clause|with_statement|block)$/.test(statement.type)) {
                probe(statement);
            }
        }
    };
    probe(root);
    if (!shaped) return [];
    // Every module-level binding of each name (fix #392): an alias
    // assignment, an import, or anything else.
    const bindings = new Map();
    const bind = (name, entry) => {
        if (!name) return;
        if (!bindings.has(name)) bindings.set(name, []);
        bindings.get(name).push(entry);
    };
    const bindTarget = (node) => {
        if (!node) return;
        if (node.type === 'identifier') { bind(node.text, { kind: 'other' }); return; }
        if (['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list', 'expression_list',
            'parenthesized_expression', 'list_splat_pattern', 'list_splat', 'as_pattern_target'].includes(node.type)) {
            for (const child of node.namedChildren) bindTarget(child);
        }
    };
    const visit = (node) => {
        for (const child of node.namedChildren) {
            switch (child.type) {
                case 'function_definition':
                case 'class_definition':
                    bind(child.childForFieldName('name')?.text, { kind: 'other' });
                    continue;
                case 'decorated_definition':
                    bind(child.childForFieldName('definition')?.childForFieldName('name')?.text, { kind: 'other' });
                    continue;
                case 'import_statement':
                case 'future_import_statement':
                    for (const part of child.namedChildren) {
                        if (part.type === 'aliased_import') bind(part.childForFieldName('alias')?.text, { kind: 'other' });
                        else if (part.type === 'dotted_name') bind(part.namedChild(0)?.text, { kind: 'other' });
                    }
                    continue;
                case 'import_from_statement': {
                    const moduleName = child.childForFieldName('module_name')?.text;
                    for (const part of child.namedChildren) {
                        if (sameNode(part, child.childForFieldName('module_name'))) continue;
                        if (part.type === 'wildcard_import') { bind('*', { kind: 'other' }); continue; }
                        const imported = part.type === 'aliased_import'
                            ? part.childForFieldName('name')?.text : part.type === 'dotted_name' ? part.text : null;
                        const local = part.type === 'aliased_import'
                            ? part.childForFieldName('alias')?.text : part.type === 'dotted_name'
                                ? part.namedChild(part.namedChildCount - 1)?.text : null;
                        if (!local) continue;
                        // A from-import binds the imported object: one binding
                        // site of a class the name may alias.
                        bind(local, moduleName && imported && !imported.includes('.')
                            ? { kind: 'import', module: moduleName, imported, line: child.startPosition.row + 1 }
                            : { kind: 'other' });
                    }
                    continue;
                }
                case 'expression_statement':
                    for (let expr of child.namedChildren) {
                        while (expr?.type === 'assignment' || expr?.type === 'augmented_assignment') {
                            const left = expr.childForFieldName('left');
                            const right = expr.childForFieldName('right');
                            if (expr.type === 'assignment' && left?.type === 'identifier' &&
                                !expr.childForFieldName('type') &&
                                (right?.type === 'identifier' || right?.type === 'attribute') &&
                                /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(right.text) &&
                                right.text !== left.text) {
                                bind(left.text, { kind: 'alias', target: right.text,
                                    line: expr.startPosition.row + 1 });
                            } else if (expr.type === 'assignment' && left?.type === 'identifier' &&
                                !expr.childForFieldName('type') && right?.type === 'call' &&
                                right.childForFieldName('function')?.type === 'identifier') {
                                // `registry = Registry()` (fix #398F): a module value
                                // built by calling a name, read when an alias names
                                // one of its attributes.
                                bind(left.text, { kind: 'constructed',
                                    callee: right.childForFieldName('function').text,
                                    line: expr.startPosition.row + 1 });
                            } else {
                                bindTarget(left);
                            }
                            expr = expr.type === 'assignment' ? right : null;
                        }
                    }
                    continue;
                case 'delete_statement':
                    for (const target of child.namedChildren) bindTarget(target);
                    continue;
                case 'for_statement':
                    bindTarget(child.childForFieldName('left'));
                    break;
                case 'with_statement':
                case 'try_statement':
                    for (const target of child.descendantsOfType('as_pattern_target')) bindTarget(target);
                    break;
                default:
                    break;
            }
            if (child.namedChildCount > 0 && child.type !== 'expression_statement') visit(child);
        }
    };
    visit(root);
    for (const walrus of root.descendantsOfType('named_expression')) {
        let inFunction = false;
        for (let p = walrus.parent; p; p = p.parent) {
            if (p.type === 'function_definition' || p.type === 'class_definition' || p.type === 'lambda') {
                inFunction = true;
                break;
            }
        }
        if (!inFunction) bind(walrus.childForFieldName('name')?.text, { kind: 'other' });
    }
    const declaredGlobal = new Set();
    for (const statement of root.descendantsOfType('global_statement')) {
        for (const name of statement.namedChildren) declaredGlobal.add(name.text);
    }
    const aliases = [];
    const constructed = new Map();
    for (const [name, sites] of bindings) {
        if (declaredGlobal.has(name) || sites.some(site => site.kind === 'other')) continue;
        if (sites.length === 1 && sites[0].kind === 'constructed') {
            constructed.set(name, { name, callee: sites[0].callee, line: sites[0].line });
            continue;
        }
        const assignments = sites.filter(site => site.kind === 'alias');
        if (assignments.length === 0 || sites.some(site => site.kind === 'constructed')) continue;
        if (sites.length === 1) {
            // Bound once (also inside a module-level block, fix #392).
            aliases.push({ name, target: assignments[0].target, line: assignments[0].line });
            continue;
        }
        // Bound on several paths (if/else, try/except): an alias only when
        // every binding site names the same class, decided where it resolves.
        aliases.push({
            name, target: assignments[0].target, line: assignments[0].line,
            alternatives: sites.map(site => site.kind === 'alias'
                ? { target: site.target } : { module: site.module, imported: site.imported }),
        });
    }
    // Constructed values an alias reads an attribute of (`loads =
    // registry.loads`, fix #398F).
    const roots = new Set(aliases.flatMap(alias => [alias.target, ...(alias.alternatives || [])
        .map(alternative => alternative.target)]).filter(Boolean)
        .map(target => String(target).split('.')).filter(parts => parts.length === 2).map(parts => parts[0]));
    const values = [...roots].filter(root => constructed.has(root)).sort().map(root => constructed.get(root));
    if (values.length > 0) Object.defineProperty(aliases, 'constructed', { value: values });
    return aliases;
}

const PY_SCOPE_NODES = new Set(['function_definition', 'class_definition', 'lambda', 'module']);
const PY_BRANCH_CLAUSES = new Set(['elif_clause', 'else_clause', 'except_clause', 'except_group_clause',
    'finally_clause', 'case_clause']);

/** Does a statement list (descending compound statements, never into
 * nested scopes) bind `name`? */
function pythonClauseBindsName(node, name) {
    for (const child of node.namedChildren) {
        switch (child.type) {
            case 'function_definition':
            case 'class_definition':
                if (child.childForFieldName('name')?.text === name) return true;
                continue;
            case 'decorated_definition':
                if (child.childForFieldName('definition')?.childForFieldName('name')?.text === name) return true;
                continue;
            case 'import_statement':
            case 'import_from_statement':
            case 'expression_statement':
            case 'delete_statement':
            case 'for_statement':
            case 'with_statement':
                if (child.descendantsOfType('identifier').some(id => id.text === name)) return true;
                if (child.type === 'for_statement' || child.type === 'with_statement') {
                    for (const part of child.namedChildren) {
                        if ((part.type === 'block' || part.type === 'else_clause') && pythonClauseBindsName(part, name)) return true;
                    }
                }
                continue;
            default:
                if (child.type === 'block' || child.type.endsWith('_statement') || PY_BRANCH_CLAUSES.has(child.type)) {
                    if (pythonClauseBindsName(child, name)) return true;
                }
        }
    }
    return false;
}

/**
 * Cheap gate for configuration items: a def, class or import inside a
 * branch whose statement binds the same name in another clause. Files
 * without one (nearly all) skip the scope walk.
 */
function pythonConfigurationCandidateScopes(root, bindingNodes) {
    const scopes = new Set();
    const nodes = bindingNodes || getCachedNodeList(root).nodes.filter(node =>
        node.type === 'function_definition' || node.type === 'class_definition' ||
        node.type === 'import_statement' || node.type === 'import_from_statement');
    for (const node of nodes) {
        // Directly in a scope body: no branch can hold it.
        const holder = node.parent?.type === 'decorated_definition' ? node.parent.parent : node.parent;
        if (holder?.type === 'module' || (holder?.type === 'block' && PY_SCOPE_NODES.has(holder.parent?.type))) continue;
        let names = null;
        const start = node.parent?.type === 'decorated_definition' ? node.parent : node;
        for (let parent = start.parent; parent && !PY_SCOPE_NODES.has(parent.type); parent = parent.parent) {
            const statement = parent.type === 'block' ? null
                : ['if_statement', 'try_statement'].includes(parent.type) ? parent
                    : PY_BRANCH_CLAUSES.has(parent.type) ? (parent.type === 'case_clause' ? parent.parent?.parent : parent.parent)
                        : null;
            if (!statement) continue;
            if (!names) {
                if (node.type === 'function_definition' || node.type === 'class_definition') {
                    names = [node.childForFieldName('name')?.text].filter(Boolean);
                } else {
                    names = [];
                    for (const part of node.namedChildren) {
                        if (part.type === 'aliased_import') names.push(part.childForFieldName('alias')?.text);
                        else if (part.type === 'dotted_name' && !sameNode(part, node.childForFieldName('module_name'))) {
                            names.push(node.type === 'import_statement' ? part.namedChild(0)?.text
                                : part.namedChild(part.namedChildCount - 1)?.text);
                        }
                    }
                    names = names.filter(Boolean);
                }
                if (names.length === 0) break;
            }
            // Another clause of this statement (or its match body) binding
            // one of the names.
            const holder = statement.type === 'match_statement' ? statement.childForFieldName('body') : statement;
            let found = false;
            for (const clause of holder?.namedChildren || []) {
                if (clause.startIndex <= node.startIndex && clause.endIndex >= node.endIndex) continue;
                if (clause.type !== 'block' && !PY_BRANCH_CLAUSES.has(clause.type)) continue;
                if (names.some(name => pythonClauseBindsName(clause, name))) { found = true; break; }
            }
            if (found) {
                let scope = statement.parent;
                while (scope && !PY_SCOPE_NODES.has(scope.type)) scope = scope.parent;
                if (scope) scopes.add(scope);
                break;
            }
        }
    }
    return scopes;
}

/**
 * Configuration items (fix #398F): a name bound in one scope (module, class
 * body or function body) only in mutually exclusive branches of `if` /
 * `try` / `match` statements - `if sys.platform == "win32": def getchar` /
 * `else: def getchar`, `try: from ._speedups import f` / `except
 * ImportError: def f` - is ONE item with an alternative per configuration.
 * Every binding of the name in that scope must sit in a different exclusive
 * branch (a later unconditional rebinding, a loop target or a `global` /
 * `nonlocal` write breaks the item), and one of them must be a def, class or
 * import. Sites carry their branch path (statement line + clause tag, outer
 * first); `clauses` holds the line range of every clause of those
 * statements, so a call inside another branch is placed without the tree.
 */
function pythonConfigurationItems(root, bindingNodes = null, reboundNodes = null) {
    const candidateScopes = pythonConfigurationCandidateScopes(root, bindingNodes);
    if (candidateScopes.size === 0) return [];
    const scopes = new Map();   // scope line -> Map(name -> sites)
    const clauseRanges = new Map(); // statement line -> [[tag, start, end]]
    const rebound = new Set();  // `global` / `nonlocal` names
    const lineOf = node => node.startPosition.row + 1;
    const endOf = node => node.endPosition.row + 1;
    const add = (scope, name, kind, line, branch, target = null) => {
        if (!name) return;
        let names = scopes.get(scope);
        if (!names) scopes.set(scope, names = new Map());
        if (!names.has(name)) names.set(name, []);
        names.get(name).push({ kind, line, branch, ...(target && { target }) });
    };
    const bindTarget = (scope, node, branch) => {
        if (!node) return;
        if (node.type === 'identifier') { add(scope, node.text, 'value', lineOf(node), branch); return; }
        if (['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list', 'expression_list',
            'parenthesized_expression', 'list_splat_pattern', 'list_splat', 'as_pattern_target'].includes(node.type)) {
            for (const child of node.namedChildren) bindTarget(scope, child, branch);
        }
    };
    const noteClauses = (statement, clauses) => {
        clauseRanges.set(lineOf(statement), clauses.map(([tag, node]) => [tag, lineOf(node), endOf(node)]));
    };
    const visitBlock = (block, scope, branch) => {
        if (!block) return;
        for (const child of block.namedChildren) visitStatement(child, scope, branch);
    };
    const visitStatement = (node, scope, branch) => {
        switch (node.type) {
            case 'decorated_definition': {
                const definition = node.childForFieldName('definition');
                if (!definition) return;
                add(scope, definition.childForFieldName('name')?.text,
                    definition.type === 'class_definition' ? 'class' : 'def', lineOf(node), branch);
                return;
            }
            case 'function_definition':
            case 'class_definition':
                add(scope, node.childForFieldName('name')?.text,
                    node.type === 'class_definition' ? 'class' : 'def', lineOf(node), branch);
                return;
            case 'import_statement':
                for (const part of node.namedChildren) {
                    if (part.type === 'aliased_import') add(scope, part.childForFieldName('alias')?.text, 'import', lineOf(node), branch);
                    else if (part.type === 'dotted_name') add(scope, part.namedChild(0)?.text, 'import', lineOf(node), branch);
                }
                return;
            case 'import_from_statement': {
                const moduleName = node.childForFieldName('module_name');
                for (const part of node.namedChildren) {
                    if (moduleName && part.id === moduleName.id) continue;
                    if (part.type === 'wildcard_import') { add(scope, '*', 'import', lineOf(node), branch); continue; }
                    const local = part.type === 'aliased_import' ? part.childForFieldName('alias')?.text
                        : part.type === 'dotted_name' ? part.namedChild(part.namedChildCount - 1)?.text : null;
                    add(scope, local, 'import', lineOf(node), branch);
                }
                return;
            }
            case 'global_statement':
            case 'nonlocal_statement':
                return;
            case 'expression_statement':
                for (let expr of node.namedChildren) {
                    while (expr?.type === 'assignment' || expr?.type === 'augmented_assignment') {
                        const left = expr.childForFieldName('left');
                        const right = expr.childForFieldName('right');
                        // An alias value (`f = other`, `f = mod.other`)
                        // names what it binds (fix #424): the chase follows it.
                        if (expr.type === 'assignment' && left?.type === 'identifier' &&
                            !expr.childForFieldName('type') &&
                            (right?.type === 'identifier' || right?.type === 'attribute') &&
                            /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(right.text) &&
                            right.text !== left.text) {
                            add(scope, left.text, 'value', lineOf(left), branch, right.text);
                        } else {
                            bindTarget(scope, left, branch);
                        }
                        expr = expr.type === 'assignment' ? right : null;
                    }
                }
                return;
            case 'delete_statement':
                for (const target of node.namedChildren) bindTarget(scope, target, branch);
                return;
            case 'if_statement': {
                const line = lineOf(node);
                const consequence = node.childForFieldName('consequence');
                const clauses = consequence ? [['if', consequence]] : [];
                let elif = 0;
                for (const alternative of node.childrenForFieldName('alternative')) {
                    if (alternative.type === 'elif_clause') clauses.push([`elif:${elif++}`, alternative]);
                    else if (alternative.type === 'else_clause') clauses.push(['else', alternative]);
                }
                noteClauses(node, clauses);
                // `if TYPE_CHECKING:` branches exist for type checkers, not
                // for one runtime configuration: their names form no item.
                const typeChecking = /^(?:\w+\.)?TYPE_CHECKING$/.test(node.childForFieldName('condition')?.text || '');
                for (const [tag, clause] of clauses) {
                    const block = clause.type === 'block' ? clause
                        : clause.childForFieldName('consequence') || clause.childForFieldName('body');
                    visitBlock(block, scope, [...branch, typeChecking ? [line, tag, 'type-checking'] : [line, tag]]);
                }
                return;
            }
            case 'try_statement': {
                const line = lineOf(node);
                const clauses = [];
                let handler = 0;
                for (const child of node.namedChildren) {
                    if (child.type === 'block') clauses.push(['try', child]);
                    else if (child.type === 'except_clause' || child.type === 'except_group_clause') {
                        clauses.push([`except:${handler++}`, child]);
                    } else if (child.type === 'else_clause') clauses.push(['try-else', child]);
                    else if (child.type === 'finally_clause') clauses.push(['finally', child]);
                }
                noteClauses(node, clauses);
                for (const [tag, clause] of clauses) {
                    const path = [...branch, [line, tag]];
                    if (clause.type === 'block') { visitBlock(clause, scope, path); continue; }
                    for (const target of clause.descendantsOfType('as_pattern_target')) {
                        if (target.parent?.parent && sameNode(target.parent.parent, clause)) bindTarget(scope, target, path);
                    }
                    for (const child of clause.namedChildren) if (child.type === 'block') visitBlock(child, scope, path);
                }
                return;
            }
            case 'match_statement': {
                const line = lineOf(node);
                const body = node.childForFieldName('body');
                const cases = body ? body.namedChildren.filter(child => child.type === 'case_clause') : [];
                const clauses = cases.map((clause, i) => [`case:${i}`, clause]);
                noteClauses(node, clauses);
                for (const [tag, clause] of clauses) {
                    for (const child of clause.namedChildren) if (child.type === 'block') visitBlock(child, scope, [...branch, [line, tag]]);
                }
                return;
            }
            case 'for_statement':
                bindTarget(scope, node.childForFieldName('left'), branch);
                // A loop body may run several times or not at all: its
                // bindings are sequential, never exclusive alternatives.
                for (const child of node.namedChildren) if (child.type === 'block' || child.type === 'else_clause') visitBlock(child.type === 'block' ? child : child.namedChildren.find(c => c.type === 'block'), scope, [...branch, [lineOf(node), 'loop']]);
                return;
            case 'while_statement':
                for (const child of node.namedChildren) if (child.type === 'block' || child.type === 'else_clause') visitBlock(child.type === 'block' ? child : child.namedChildren.find(c => c.type === 'block'), scope, [...branch, [lineOf(node), 'loop']]);
                return;
            case 'with_statement':
                for (const target of node.descendantsOfType('as_pattern_target')) {
                    if (target.parent?.parent?.parent && sameNode(target.parent.parent.parent, node.namedChildren[0])) bindTarget(scope, target, branch);
                }
                visitBlock(node.childForFieldName('body'), scope, branch);
                return;
            default:
                return;
        }
    };
    // Only the scopes holding a candidate are walked (their own statements;
    // nested scopes are walked when they are candidates themselves).
    for (const scope of candidateScopes) {
        if (scope.type === 'module') { visitBlock(scope, 0, []); continue; }
        const head = scope.parent?.type === 'decorated_definition' ? scope.parent : scope;
        visitBlock(scope.childForFieldName('body'), lineOf(head), []);
    }
    // A `global` / `nonlocal` write anywhere rebinds the name at run time.
    for (const node of reboundNodes || getCachedNodeList(root).nodes) {
        if (node.type !== 'global_statement' && node.type !== 'nonlocal_statement') continue;
        for (const name of node.namedChildren) if (name.type === 'identifier') rebound.add(name.text);
    }
    const exclusive = (a, b) => {
        for (let k = 0; k < Math.min(a.length, b.length); k++) {
            if (a[k][0] !== b[k][0]) return false;
            if (a[k][1] !== b[k][1]) return branchClausesExclusive(a[k][1], b[k][1]);
        }
        return false;
    };
    const items = [];
    for (const [scope, names] of scopes) {
        for (const [name, sites] of names) {
            if (sites.length < 2 || name === '*' || rebound.has(name)) continue;
            if (!sites.some(site => site.kind !== 'value')) continue;
            if (sites.some(site => site.branch.some(step => step.length > 2))) continue;
            let all = true;
            for (let i = 0; all && i < sites.length; i++) {
                for (let j = i + 1; all && j < sites.length; j++) all = exclusive(sites[i].branch, sites[j].branch);
            }
            if (!all) continue;
            const statements = new Set(sites.flatMap(site => site.branch.map(([line]) => line)));
            items.push({
                name, scope,
                sites: sites.map(site => ({ kind: site.kind, line: site.line, branch: site.branch,
                    ...(site.target && { target: site.target }) })),
                clauses: [...statements].sort((a, b) => a - b).map(line => [line, clauseRanges.get(line) || []]),
            });
        }
    }
    items.sort((a, b) => a.scope - b.scope || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return items;
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
/**
 * A member a subclass or a structural satisfier must supply: decorated
 * abstract (`@abstractmethod` and its older `abstract*` spellings), or
 * declared in a class that lists `Protocol` among its bases (a protocol
 * class; a class that merely inherits from one is an implementation).
 */
const PY_ABSTRACT_DECORATORS = new Set(['abstractmethod', 'abstractproperty',
    'abstractclassmethod', 'abstractstaticmethod']);

// The names a module uses for `Protocol` and for the abstract decorators:
// the plain spellings, plus what `from m import Protocol as P` binds. A
// module alias (`import typing as t`) needs nothing: `t.Protocol` ends in
// the plain spelling.
const contractSpellingsByTree = new WeakMap();
function contractSpellings(node) {
    let spellings = contractSpellingsByTree.get(node.tree);
    if (spellings) return spellings;
    spellings = { protocol: new Set(['Protocol']), abstract: new Set(PY_ABSTRACT_DECORATORS) };
    for (const statement of node.tree.rootNode.descendantsOfType('import_from_statement')) {
        for (const part of statement.namedChildren) {
            if (part.type !== 'aliased_import') continue;
            const imported = part.childForFieldName('name')?.text.split('.').pop();
            const alias = part.childForFieldName('alias')?.text;
            if (!alias) continue;
            if (imported === 'Protocol') spellings.protocol.add(alias);
            if (PY_ABSTRACT_DECORATORS.has(imported)) spellings.abstract.add(alias);
        }
    }
    contractSpellingsByTree.set(node.tree, spellings);
    return spellings;
}

/** Does the class list Protocol among its bases (PEP 544 protocol class)? */
function isProtocolClass(classNode) {
    const { protocol } = contractSpellings(classNode);
    return extractBases(classNode).some(base => protocol.has(String(base).split('.').pop()));
}

function isRequiredPythonMember(classNode, decorators) {
    const { abstract } = contractSpellings(classNode);
    if ((decorators || []).some(decorator =>
        abstract.has(String(decorator).replace(/\(.*$/s, '').split('.').pop().trim()))) return true;
    return isProtocolClass(classNode);
}

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

function pythonAliasMembers(node) {
    const current = unwrapTypeNode(node);
    if (!current) return [];
    if (current.type === 'binary_operator' && current.text.includes('|')) {
        return [...new Set([
            ...pythonAliasMembers(current.namedChild(0)),
            ...pythonAliasMembers(current.namedChild(1)),
        ])];
    }
    if (current.type === 'subscript' || current.type === 'generic_type') {
        const parts = genericTypeParts(current);
        if (!parts || !['Union', 'Optional'].includes(parts.base)) return [];
        return [...new Set(parts.args.flatMap(pythonAliasMembers))];
    }
    const name = typeNameFromExpr(current);
    return name && name !== 'None' ? [name] : [];
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
    const { startLine, endLine, sourceSpan } = nodeToLocation(node, lines);
    const aliasOf = pythonAliasBase(valueNode);
    const aliasMembers = pythonAliasMembers(valueNode);
    classes.push({
        name,
        type: 'type',
        startLine,
        endLine,
        sourceSpan,
        methods: [],
        members: [],
        ...(aliasOf && { aliasOf }),
        ...(aliasMembers.length > 1 && { aliasMembers }),
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

    // A class-body assignment declares an attribute, including an annotated
    // dataclass field and each name of a tuple target. Function and
    // nested-class bodies have their own owners.
    const declared = new Set();
    traverseTree(bodyNode, node => {
        if (node.type === 'function_definition' || node.type === 'class_definition') return false;
        if (node.type !== 'assignment') return true;
        const type = node.childForFieldName('type');
        for (const name of pythonTargetNames(node.childForFieldName('left'), 'identifier')) {
            declared.add(name.text);
            members.push({ name: name.text, startLine: name.startPosition.row + 1,
                endLine: node.endPosition.row + 1, memberType: 'field',
                ...(type && { returnType: type.text, fieldType: type.text }) });
        }
        return true;
    });
    // An attribute a method assigns on its receiver (`self.x = v`, `self.x:
    // T = v`, `self.x += v`) is an instance attribute of the class (fix
    // #430): one declaration per name, the first in source order, unless
    // the class body declares the name.
    // A property the class body declares is a data descriptor: assigning
    // it on the receiver runs its setter, never declares an attribute.
    for (const def of pythonClassBodyDefs(bodyNode)) {
        if (def.type !== 'decorated_definition') continue;
        const name = def.childForFieldName('definition')?.childForFieldName('name')?.text;
        if (name && def.namedChildren.some(child => child.type === 'decorator' &&
            /^@\s*(?:property|[A-Za-z_]\w*\.(?:setter|deleter))\s*$/.test(child.text))) declared.add(name);
    }
    for (const attribute of pythonInstanceAttributes(bodyNode, declared)) members.push(attribute);

    for (const child of pythonClassBodyDefs(bodyNode)) {
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
                const isGenerator = isPythonGenerator(funcNode);
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
                    sourceSpan: nodeToLocation(child, code).sourceSpan,
                    endLine,
                    memberType,
                    isAsync,
                    ...(isGenerator && { isGenerator }),
                    isMethod: true,  // Mark as method for context() lookups
                    // Match top-level Python functions: `async def` → ['async'] modifiers.
                    modifiers: isAsync ? ['async'] : [],
                    ...(returnType && { returnType }),
                    ...(returnedConstructors && { returnedConstructors }),
                    ...(paramTypes && { paramTypes }),
                    ...(docstring && { docstring }),
                    ...(memberDecorators.length > 0 && { decorators: memberDecorators }),
                    ...(isOverloadDecorated(memberDecorators) && { isSignature: true }),
                    ...(isRequiredPythonMember(classNode, memberDecorators) && { requiredMember: true }),
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

    // Binding statements and `global`/`nonlocal` declarations seen by the
    // one traversal feed the configuration-item gate (fix #398F).
    const bindingNodes = [];
    const reboundNodes = [];
    traverseTreeCached(tree.rootNode, (node) => {
        _processFunction(node, functions, processedFn, lines, code);
        _processClass(node, classes, processedCls, lines) ||
            _processTypeAlias(node, classes, processedCls, lines);
        _processState(node, stateObjects, lines);
        _processModuleAssign(node, moduleAssigned);
        const type = node.type;
        if (type === 'function_definition' || type === 'class_definition' ||
            type === 'import_statement' || type === 'import_from_statement') bindingNodes.push(node);
        else if (type === 'global_statement' || type === 'nonlocal_statement') reboundNodes.push(node);
        return true;
    });

    functions.sort((a, b) => a.startLine - b.startLine);
    classes.sort((a, b) => a.startLine - b.startLine);
    stateObjects.sort((a, b) => a.startLine - b.startLine);
    const moduleValueAliases = moduleAssigned.size > 0 ? pythonModuleValueAliases(tree.rootNode) : [];
    const configurationItems = pythonConfigurationItems(tree.rootNode, bindingNodes, reboundNodes);

    return {
        language: 'python',
        totalLines: lines.length,
        functions,
        classes,
        stateObjects,
        ...(moduleValueAliases.length > 0 && { moduleValueAliases: [...moduleValueAliases] }),
        ...(moduleValueAliases.constructed && { moduleConstructedValues: moduleValueAliases.constructed }),
        ...(configurationItems.length > 0 && { configurationItems }),
        ...(tree.rootNode.hasError && { parseRecovery: true, parseErrorRegions: parseErrorRegions(tree.rootNode) }),
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

// Subscript contracts of builtin/typing containers (fix #359, starlette-
// measured): `params: dict[str, Convertor]` makes `params[key]` a Convertor;
// `items: list[Conv]` makes `items[0]` a Conv. The element is the declared
// value slot of the annotation, never guessed: unions, Any/object, bare
// type variables and heterogeneous tuples abstain.
const PY_MAPPING_ANNOTATIONS = new Set([
    'dict', 'Dict', 'Mapping', 'MutableMapping', 'OrderedDict', 'defaultdict',
    'DefaultDict',
]);
const PY_SEQUENCE_ANNOTATIONS = new Set([
    'list', 'List', 'Sequence', 'MutableSequence', 'deque', 'Deque',
]);
function subscriptElementContract(typeNode) {
    const outerRaw = typeNode && typeNode.type === 'type' && typeNode.namedChildCount > 0
        ? typeNode.namedChild(0) : typeNode;
    const outer = genericTypeParts(outerRaw);
    if (!outer) return null;
    let element = null;
    if (PY_MAPPING_ANNOTATIONS.has(outer.base) && outer.args.length === 2) {
        element = outer.args[1];
    } else if (PY_SEQUENCE_ANNOTATIONS.has(outer.base) && outer.args.length === 1) {
        element = outer.args[0];
    } else if (['tuple', 'Tuple'].includes(outer.base) && outer.args.length === 2 &&
        outer.args[1]?.type === 'ellipsis') {
        element = outer.args[0];
    }
    if (!element) return null;
    const type = typeNameFromExpr(unwrapTypeNode(element));
    if (!type || type === 'Any' || type === 'object' || type === 'None' ||
        /^[A-Z][A-Z0-9]?$/.test(type)) return null;
    const qualifier = typeQualifierFromExpr(unwrapTypeNode(element));
    return { type, ...(qualifier && { qualifier }), node: element };
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

const FIELD_CONTRACT_VALUE_NODES = new Set([
    'call', 'attribute', 'subscript', 'binary_operator', 'boolean_operator',
    'comparison_operator', 'list', 'dictionary', 'set', 'tuple', 'string',
    'concatenated_string', 'parameters', 'decorator',
]);

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
    traverseTree(tree.rootNode, node => {
        // Only statements can declare an annotated instance field. Value
        // expressions and parameter/default/decorator trees contain no
        // such statements, so do not materialize all their descendants.
        if (FIELD_CONTRACT_VALUE_NODES.has(node.type)) return false;
        if (node.type !== 'expression_statement') return true;
        const assignment = node.namedChild(0);
        if (assignment?.type !== 'assignment') return false;
        const left = assignment.childForFieldName('left');
        if (left?.type !== 'attribute' ||
            left.childForFieldName('object')?.text !== 'self') return false;
        const field = left.childForFieldName('attribute')?.text;
        const className = enclosingPythonClassName(node);
        if (!field || !className) return false;
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
        if (!typeNode) return false;
        const type = typeNameFromAnnotation(typeNode);
        const itemTypes = iterableBindingTypes(typeNode);
        if (!type && itemTypes.length === 0) return false;
        if (!result.has(className)) result.set(className, new Map());
        result.get(className).set(field, {
            ...(type && { type }),
            ...(itemTypes.length > 0 && { itemTypes }),
        });
        return false;
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
        if (parent.type === 'if_statement' || parent.type === 'elif_clause') {
            const condition = parent.childForFieldName('condition');
            const noneIdentity = condition?.type === 'comparison_operator' &&
                condition.namedChildCount === 2 &&
                condition.children.find(child =>
                    child.type === 'is' || child.type === 'is not');
            const noneIndex = noneIdentity
                ? [condition.namedChild(0), condition.namedChild(1)]
                    .findIndex(child => child?.type === 'none')
                : -1;
            const compared = noneIndex >= 0
                ? condition.namedChild(1 - noneIndex) : null;
            if (compared?.type === 'identifier' &&
                compared.text === receiverName && declaredUnion?.length) {
                const remaining = declaredUnion.filter(type => type !== 'None');
                const consequence = parent.childForFieldName('consequence');
                const alternative = parent.childForFieldName('alternative');
                const inNonNullBranch = noneIdentity.type === 'is not'
                    ? nodeContains(consequence, refNode)
                    : nodeContains(alternative, refNode);
                if (inNonNullBranch && remaining.length === 1) {
                    return remaining[0];
                }
            }
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
        // A class pattern (fix #425, the Go type-switch rule): in `case
        // Sq() as s:` the capture s is a Sq instance, and `match x: case
        // Sq():` narrows x to Sq, in the clause's body. A union of class
        // patterns names no single type.
        if (parent.type === 'case_clause' && sameNode(parent.childForFieldName('consequence'), current)) {
            const casePatterns = parent.namedChildren.filter(child => child.type === 'case_pattern');
            const pattern = casePatterns.length === 1 ? casePatterns[0].namedChild(0) : null;
            let classPattern = null;
            if (pattern?.type === 'as_pattern') {
                const target = pattern.namedChild(pattern.namedChildCount - 1);
                const targetName = target?.type === 'as_pattern_target' ? target.namedChild(0)?.text : target?.text;
                const inner = pattern.namedChild(0);
                if (targetName === receiverName && inner?.type === 'case_pattern' &&
                    inner.namedChild(0)?.type === 'class_pattern') classPattern = inner.namedChild(0);
            } else if (pattern?.type === 'class_pattern') {
                const subject = parent.parent?.parent?.type === 'match_statement'
                    ? parent.parent.parent.childForFieldName('subject') : null;
                if (subject?.type === 'identifier' && subject.text === receiverName) classPattern = pattern;
            }
            const dotted = classPattern?.namedChild(0);
            if (dotted?.type === 'dotted_name' && dotted.namedChildCount > 0) {
                return dotted.namedChild(dotted.namedChildCount - 1).text;
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

/** `Union[Foo, None]` names Foo (fix #402); a union of several types names none. */
function unionMemberName(node) {
    const members = (genericTypeParts(node)?.args || []).filter(arg => arg &&
        arg.type !== 'none' && !(arg.type === 'identifier' && arg.text === 'None'));
    return members.length === 1 ? typeNameFromExpr(members[0]) : undefined;
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
            if (base === 'Union') return unionMemberName(node);
            if (PY_TYPE_WRAPPERS.has(base)) {
                return typeNameFromExpr(node.childForFieldName('subscript'));
            }
            return base; // dict[str, int] → the receiver IS a dict
        }
        case 'generic_type': {
            // Optional[Foo] / Mapping[str, int] in annotation position
            const base = typeNameFromExpr(node.namedChild(0));
            if (base === 'Union') return unionMemberName(node);
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
 * PascalCase after optional privacy underscores remains a Python class-naming
 * heuristic, so callers use the qualifier as routing/provenance evidence
 * rather than a hidden hard claim. Private classes such as `_ClassBuilder`
 * are ordinary constructor values and must retain their type identity.
 */
function constructorTypeInfo(funcNode) {
    if (!funcNode) return undefined;
    if (funcNode.type === 'identifier') {
        return /^_*[A-Z]/.test(funcNode.text)
            ? { type: funcNode.text } : undefined;
    }
    if (funcNode.type === 'attribute') {
        const attr = funcNode.childForFieldName('attribute');
        const object = funcNode.childForFieldName('object');
        return attr && /^_*[A-Z]/.test(attr.text)
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

// One walk per scope body collects every name it binds at this scope level
// (declarations, assignment targets, for/with targets; nested def/class bodies
// are separate scopes, lambdas too). Memoized per tree by native node id: the
// caller loop asks the same body about many names, and a per-name walk made
// the Python build cost functions x tracked names x body size (measured 10s of
// a 60s sequential build on a 20MB Python repo).
const scopeBoundNamesByTree = new WeakMap();
function pythonScopeBoundNames(scopeNode) {
    let byId = scopeBoundNamesByTree.get(scopeNode.tree);
    if (!byId) { byId = new Map(); scopeBoundNamesByTree.set(scopeNode.tree, byId); }
    const cached = byId.get(scopeNode.id);
    if (cached) return cached;
    const names = new Set();
    const addTarget = (left) => {
        if (!left) return;
        if (left.type === 'identifier') names.add(left.text);
        else if (left.type === 'pattern_list' || left.type === 'tuple_pattern') {
            for (const item of left.namedChildren) {
                if (item.type === 'identifier') names.add(item.text);
            }
        }
    };
    const walk = (node) => {
        for (const child of node.namedChildren) {
            if (child.type === 'function_definition' ||
                child.type === 'async_function_definition' ||
                child.type === 'class_definition') {
                const declared = child.childForFieldName('name')?.text;
                if (declared) names.add(declared);
                continue;
            }
            if (child.type === 'lambda') continue;
            if (child.type === 'assignment' ||
                child.type === 'augmented_assignment' ||
                child.type === 'named_expression') {
                addTarget(child.childForFieldName('left') || child.childForFieldName('name'));
            } else if (child.type === 'for_statement') {
                addTarget(child.childForFieldName('left'));
            } else if (child.type === 'with_statement') {
                const text = child.namedChild(0)?.text || '';
                const match = text.match(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)/);
                if (match) names.add(match[1]);
            }
            walk(child);
        }
    };
    walk(scopeNode);
    byId.set(scopeNode.id, names);
    return names;
}

/** Type of the innermost scope node (function, lambda, class, module). */
function pythonEnclosingScopeType(node) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (['function_definition', 'async_function_definition', 'lambda',
            'class_definition', 'module'].includes(parent.type)) return parent.type;
    }
    return 'module';
}

/** Innermost enclosing function of a node; null at module/class/lambda level. */
function pythonEnclosingFunctionNode(node) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (parent.type === 'function_definition' ||
            parent.type === 'async_function_definition') return parent;
        if (parent.type === 'lambda' || parent.type === 'class_definition') return null;
    }
    return null;
}

const scopeBindingCountsByTree = new WeakMap();

/**
 * How many times a function binds each local name (fix #381): parameters,
 * assignment/augmented/walrus targets, loop and comprehension-free for
 * targets, with/except `as` targets, imports, nested def/class names; a
 * `global`/`nonlocal`/`del` of the name counts as two (never a single local
 * binding). Nested functions, lambdas and classes are their own scopes.
 */
function pythonBindingCount(fnNode, name) {
    let byId = scopeBindingCountsByTree.get(fnNode.tree);
    if (!byId) { byId = new Map(); scopeBindingCountsByTree.set(fnNode.tree, byId); }
    let counts = byId.get(fnNode.id);
    if (!counts) {
        counts = new Map();
        const add = (id, n = 1) => { if (id) counts.set(id, (counts.get(id) || 0) + n); };
        // Only names in binding position: `self.x = ...` / `a[i] = ...`
        // bind no local.
        const addTarget = (target) => {
            if (!target) return;
            if (target.type === 'identifier') { add(target.text); return; }
            if (['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list',
                'parenthesized_expression', 'list_splat_pattern', 'list_splat'].includes(target.type)) {
                for (const item of target.namedChildren) addTarget(item);
            }
        };
        const params = fnNode.childForFieldName('parameters');
        if (params) {
            for (const param of params.namedChildren) {
                const id = param.type === 'identifier' ? param
                    : (param.childForFieldName('name') || param.namedChild(0));
                if (id?.type === 'identifier') add(id.text);
            }
        }
        const walk = (node) => {
            for (const child of node.namedChildren) {
                if (child.type === 'function_definition' ||
                    child.type === 'async_function_definition' ||
                    child.type === 'class_definition') {
                    add(child.childForFieldName('name')?.text);
                    continue;
                }
                if (child.type === 'lambda') continue;
                if (child.type === 'assignment' || child.type === 'augmented_assignment') {
                    addTarget(child.childForFieldName('left'));
                } else if (child.type === 'named_expression') {
                    addTarget(child.childForFieldName('name'));
                } else if (child.type === 'for_statement' || child.type === 'for_in_clause') {
                    addTarget(child.childForFieldName('left'));
                } else if (child.type === 'as_pattern') {
                    addTarget(child.childForFieldName('alias') || child.namedChild(child.namedChildCount - 1));
                } else if (child.type === 'except_clause') {
                    for (const part of child.namedChildren) {
                        if (part.type === 'as_pattern') continue;
                        if (part.type === 'identifier' && part.previousSibling?.type === 'as') add(part.text);
                    }
                } else if (child.type === 'import_statement' || child.type === 'import_from_statement') {
                    for (const part of child.namedChildren) {
                        if (part.type === 'aliased_import') {
                            add(part.childForFieldName('alias')?.text);
                        } else if (part.type === 'dotted_name' &&
                            !(child.type === 'import_from_statement' && part === child.childForFieldName('module_name'))) {
                            add(part.text.split('.')[0]);
                        }
                    }
                } else if (child.type === 'global_statement' || child.type === 'nonlocal_statement' ||
                    child.type === 'delete_statement') {
                    for (const id of patternIdentifiers(child)) add(id, 2);
                }
                walk(child);
            }
        };
        const body = fnNode.childForFieldName('body');
        if (body) walk(body);
        byId.set(fnNode.id, counts);
    }
    return counts.get(name) || 0;
}

function pythonSingleLocalBinding(fnNode, name) {
    return pythonBindingCount(fnNode, name) === 1;
}

function pythonScopeBindsName(scopeNode, name) {
    return pythonScopeBoundNames(scopeNode).has(name);
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
            if (body && pythonScopeBindsName(body, name)) {
                // `global name` makes the function's binding the module's.
                return !pythonDeclaresScopeName(body, name);
            }
            // Unbound here: a nested function reads the enclosing function
            // scopes (closures) before the module (fix #402); class bodies
            // are skipped, as Python skips them.
            if (body && pythonDeclaresScopeName(body, name)) return false;
        }
    }
    return false;
}

/**
 * The start line (decorators included) of the enclosing function a closure
 * reference binds `name` in (fix #402): null when the reference's own
 * function (or a comprehension or loop around it) binds it, or no enclosing
 * function does. A lambda is a function of its own (fix #403): the call
 * records name it as the reference's enclosing function, so a name its
 * enclosing def binds is a closure name.
 */
function pythonClosureScopeLine(refNode, name) {
    let first = true;
    for (let parent = refNode.parent; parent; parent = parent.parent) {
        if (parent.type === 'lambda') {
            const params = parent.childForFieldName('parameters');
            if (params?.namedChildren.some(param => (param.type === 'identifier' ? param
                : param.childForFieldName('name'))?.text === name)) return null;
            first = false;
            continue;
        }
        if (PY_COMPREHENSIONS.has(parent.type)) {
            if (parent.namedChildren.some(clause => clause.type === 'for_in_clause' &&
                pythonTargetBindsName(clause.childForFieldName('left'), name))) return null;
            continue;
        }
        if (parent.type !== 'function_definition' && parent.type !== 'async_function_definition') continue;
        const params = parent.childForFieldName('parameters');
        const body = parent.childForFieldName('body');
        const bindsParam = !!params && params.namedChildren.some(param => {
            const id = param.type === 'identifier' ? param : (param.childForFieldName('name') || param.namedChild(0));
            return id?.type === 'identifier' && id.text === name;
        });
        if (body && pythonDeclaresScopeName(body, name)) return null;
        if (bindsParam || (body && pythonScopeBindsName(body, name))) {
            if (first) return null;
            const start = parent.parent?.type === 'decorated_definition' ? parent.parent : parent;
            return start.startPosition.row + 1;
        }
        first = false;
    }
    return null;
}

// Methods Python calls with the class as their first argument without a
// decorator (data model: implicit classmethods).
const PY_IMPLICIT_CLASS_METHODS = new Set(['__init_subclass__', '__class_getitem__']);

/**
 * A construction through a method's own receiver (fix #434): `cls(..)` in a
 * classmethod, `type(self)(..)` and `self.__class__(..)` in an instance
 * method build the method's class or a subclass of it. The receiver must be
 * the method's first parameter, never rebound, and read from the method
 * itself or a closure inside it. Returns the class (by its name line), the
 * method, the receiver binding ('class' or 'instance') and the spelling of
 * the callee, or null.
 */
function pythonOwnClassConstruction(callNode) {
    const funcNode = callNode.childForFieldName('function');
    let receiver = null, binding = null, spelling = null;
    if (funcNode?.type === 'identifier') {
        receiver = funcNode; binding = 'class'; spelling = funcNode.text;
    } else if (funcNode?.type === 'call') {
        const inner = funcNode.childForFieldName('function');
        const args = funcNode.childForFieldName('arguments');
        const named = args?.type === 'argument_list'
            ? args.namedChildren.filter(child => !child.type.endsWith('comment')) : [];
        if (inner?.type === 'identifier' && inner.text === 'type' && named.length === 1 &&
            named[0].type === 'identifier') {
            receiver = named[0]; binding = 'instance'; spelling = funcNode.text;
        }
    } else if (funcNode?.type === 'attribute' &&
        funcNode.childForFieldName('attribute')?.text === '__class__' &&
        funcNode.childForFieldName('object')?.type === 'identifier') {
        receiver = funcNode.childForFieldName('object'); binding = 'instance'; spelling = '__class__';
    }
    if (!receiver) return null;
    const name = receiver.text;
    let method = null;
    for (let parent = callNode.parent; parent && !method; parent = parent.parent) {
        if (parent.type === 'class_definition' || parent.type === 'module') return null;
        if (parent.type === 'lambda') {
            const params = parent.childForFieldName('parameters');
            if (params && pythonParametersBindName(params, name)) return null;
        } else if (PY_COMPREHENSIONS.has(parent.type)) {
            for (const clause of parent.namedChildren) {
                if (clause.type === 'for_in_clause' &&
                    pythonTargetBindsName(clause.childForFieldName('left'), name)) return null;
            }
        } else if (parent.type === 'function_definition' || parent.type === 'async_function_definition') {
            const params = parent.childForFieldName('parameters');
            const body = parent.childForFieldName('body');
            if (params && pythonParametersBindName(params, name)) method = parent;
            else if (body && pythonScopeBindsName(body, name)) return null;
        }
    }
    if (!method) return null;
    const params = method.childForFieldName('parameters');
    const first = params?.namedChildren.find(child => !child.type.endsWith('comment'));
    const body = method.childForFieldName('body');
    if (first?.type !== 'identifier' || first.text !== name || (body && pythonScopeBindsName(body, name)) ||
        isPythonIterationBindingAt(receiver, name)) return null;
    const holder = method.parent?.type === 'decorated_definition' ? method.parent : method;
    const classNode = holder.parent?.type === 'block' && holder.parent.parent?.type === 'class_definition'
        ? holder.parent.parent : null;
    const className = classNode?.childForFieldName('name');
    const methodName = method.childForFieldName('name');
    if (!className || !methodName) return null;
    const decorators = holder.type === 'decorated_definition'
        ? holder.namedChildren.filter(child => child.type === 'decorator').map(child => child.namedChild(0)?.text)
        : [];
    const classMethod = decorators.includes('classmethod') || PY_IMPLICIT_CLASS_METHODS.has(methodName.text);
    if (binding === 'class' ? !classMethod
        : classMethod || decorators.includes('staticmethod') || methodName.text === '__new__') return null;
    const own = { name: className.text, line: className.startPosition.row + 1, method: methodName.text,
        methodLine: methodName.startPosition.row + 1, receiver: name, binding, spelling };
    // The receiver token names the class at the site (`self` of `type(self)`).
    Object.defineProperty(own, 'receiverNode', { value: receiver, enumerable: false });
    return own;
}

/** The `ownClass` field of a call record (fix #434). */
function ownClassFields(callNode) {
    const ownClass = pythonOwnClassConstruction(callNode);
    return ownClass ? { ownClass } : null;
}

/** Whether a parameter list binds `name`. */
function pythonParametersBindName(params, name) {
    for (const param of params.namedChildren) {
        let paramName = param.type === 'identifier' ? param
            : (param.childForFieldName('name') || param.namedChild(0));
        if (paramName && ['dictionary_splat_pattern', 'list_splat_pattern'].includes(paramName.type)) {
            paramName = paramName.namedChild(0);
        }
        if (paramName?.type === 'identifier' && paramName.text === name) return true;
    }
    return false;
}

/** Shadow fields of a bare reference: `localShadow`, and the enclosing
 * function a closure binds it in. */
function pythonShadowFields(refNode, name) {
    if (!isPythonNameShadowedAt(refNode, name)) return null;
    const scope = pythonClosureScopeLine(refNode, name);
    return scope ? { localShadow: true, localShadowScope: scope } : { localShadow: true };
}

/** Names a function body declares `global` (not in nested scopes),
 * memoized per tree and body node (fix #402). */
const globalNamesByTree = new WeakMap();
function pythonGlobalNames(body) {
    let byId = globalNamesByTree.get(body.tree);
    if (!byId) { byId = new Map(); globalNamesByTree.set(body.tree, byId); }
    let names = byId.get(body.id);
    if (names) return names;
    names = new Set();
    // Prefilter: no `global` keyword in the body, no declaration.
    if (body.text.includes('global')) {
        const stack = [body];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node.type === 'global_statement') {
                for (const child of node.namedChildren) if (child.type === 'identifier') names.add(child.text);
                continue;
            }
            if (node !== body && (node.type === 'function_definition' || node.type === 'class_definition' ||
                node.type === 'lambda')) continue;
            for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push(node.namedChild(i));
        }
    }
    byId.set(body.id, names);
    return names;
}

/** Whether a function body declares `global name` (not in nested scopes). */
function pythonDeclaresScopeName(body, name) {
    return pythonGlobalNames(body).has(name);
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

const moduleAliasesByTree = new WeakMap();
function pythonModuleAliases(tree) {
    const cached = moduleAliasesByTree.get(tree);
    if (cached) return cached;
    const aliases = new Set();
    // A name query needs import statements, not a wrapper for every node
    // in the file. Keep this source-only answer with its immutable tree.
    for (const node of tree.rootNode.descendantsOfType('import_statement')) {
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
    }
    moduleAliasesByTree.set(tree, aliases);
    return aliases;
}

// Annotation positions whose value Python evaluates as an expression.
const PY_ANNOTATION_OWNERS = new Set(['typed_parameter', 'typed_default_parameter', 'function_definition', 'assignment']);

/**
 * String annotations holding calls (fix #398F): `def f(v: "Annotated[int,
 * typer.Argument()]")`. A forward reference is an expression the runtime
 * evaluates (`typing.get_type_hints`), so the calls it spells are calls.
 * Plain one-line string literals only (no prefix, escape or
 * interpolation); the result lists the byte ranges of their quotes.
 */
function annotationStringQuotes(tree) {
    const quotes = [];
    for (const holder of getCachedNodeList(tree.rootNode).nodes) {
        if (holder.type !== 'type') continue;
        const string = holder.namedChildCount === 1 ? holder.namedChild(0) : null;
        if (string?.type !== 'string' || string.startPosition.row !== string.endPosition.row) continue;
        const owner = holder.parent;
        if (!owner || !PY_ANNOTATION_OWNERS.has(owner.type)) continue;
        const field = owner.type === 'function_definition' ? 'return_type' : 'type';
        if (!sameNode(owner.childForFieldName(field), holder)) continue;
        const parts = string.children;
        if (parts.length !== 3 || parts[0].type !== 'string_start' || parts[1].type !== 'string_content' ||
            parts[2].type !== 'string_end') continue;
        const start = parts[0].text;
        if (start !== '"' && start !== "'") continue;
        const content = parts[1];
        if (content.namedChildCount > 0 || !content.text.includes('(')) continue;
        quotes.push({ open: parts[0].startIndex, close: parts[2].startIndex,
            contentStart: content.startIndex, contentEnd: content.endIndex });
    }
    return quotes;
}

/**
 * References to the file's function-local classes (fix #398F): the row of
 * the one class declaration the name binds at the call (the receiver's
 * constructor, a class qualifier, a bare constructor call), or 0 when a
 * parameter, assignment or second declaration binds it too. Query-time
 * identity proofs read this instead of parsing the file again.
 */
function annotateLocalClassReferences(tree, calls, classNodes) {
    const names = new Set();
    for (const definition of classNodes) {
        if (definition.parent?.type === 'module') continue;
        for (let parent = definition.parent; parent; parent = parent.parent) {
            if (parent.type === 'function_definition' || parent.type === 'lambda') {
                const name = definition.childForFieldName('name')?.text;
                if (name) names.add(name);
                break;
            }
        }
    }
    if (names.size === 0) return;
    const memo = new Map();
    const rowAt = (start, name) => {
        if (!Number.isInteger(start)) return undefined;
        let node = tree.rootNode.descendantForIndex(start);
        if (node?.text !== name) {
            for (let owner = node?.parent; owner && owner.startIndex === start; owner = owner.parent) {
                const value = owner.childForFieldName('right') || owner.childForFieldName('value');
                if (value?.type === 'call') {
                    node = value.childForFieldName('function');
                    break;
                }
            }
        }
        if (node?.text !== name && node?.parent?.type === 'attribute') {
            node = node.parent.childForFieldName('object');
        }
        if (!node || node.text !== name) return 0;
        const scope = referenceScope(node, 'python', memo, name, { includeClasses: true });
        return scope?.defRows?.length === 1 ? scope.defRows[0] + 1 : 0;
    };
    for (const call of calls) {
        if (!call.isMethod && !call.receiver && names.has(call.name)) {
            const row = rowAt(call.callSite?.start, call.name);
            if (row !== undefined) call.localClassRow = row;
        }
        if (call.isMethod && call.receiver && !call.receiverType && names.has(call.receiver)) {
            const row = rowAt(call.callSite?.start ?? call.callStart, call.receiver);
            if (row !== undefined) call.receiverLocalClassRow = row;
        }
        // Kept beside the evidence (never inside it: the evidence object is
        // a provenance fact), tied to the evidence position it was read at.
        const evidence = call.receiverTypeEvidence;
        if (call.receiverTypeSource === 'constructor' && evidence && names.has(call.receiverType)) {
            const row = rowAt(evidence.start, call.receiverType);
            if (row !== undefined) call.receiverTypeLocalClassRef = { start: evidence.start, row };
        }
    }
}

function findCallsInCode(code, parser, options = {}) {
    const tree = parseTree(parser, code);
    const sink = { classNodes: [] };
    const calls = findCallsInTree(code, tree, parser, sink);
    annotateLocalClassReferences(tree, calls, sink.classNodes);
    if (options.stringAnnotations === false || !/(?::|->)\s*["'][^"'\n]*\(/.test(code)) return calls;
    const quotes = annotationStringQuotes(tree);
    if (quotes.length === 0) return calls;
    // The same source with those quotes blanked parses the annotation as
    // the expression it is, at the same offsets; only calls inside the
    // blanked strings are taken from it, and only where it parses clean.
    const chars = code.split('');
    for (const quote of quotes) {
        chars[quote.open] = ' ';
        chars[quote.close] = ' ';
    }
    const masked = chars.join('');
    const maskedTree = parseTree(parser, masked);
    const clean = quotes.filter(quote => {
        const node = maskedTree.rootNode.descendantForIndex(quote.contentStart, quote.contentEnd);
        return node && !node.hasError && !node.isMissing;
    });
    if (clean.length === 0) return calls;
    const inside = call => {
        const start = call.callSite?.start;
        return Number.isInteger(start) &&
            clean.some(quote => start >= quote.contentStart && start < quote.contentEnd);
    };
    const extra = findCallsInTree(masked, maskedTree, parser)
        .filter(inside).map(call => ({ ...call, stringAnnotation: true }));
    if (extra.length === 0) return calls;
    const position = call => [call.line, call.callSite?.column ?? call.column ?? 0];
    const merged = [...calls];
    for (const call of extra) {
        const [line, column] = position(call);
        let at = merged.length;
        while (at > 0) {
            const [l, c] = position(merged[at - 1]);
            if (l < line || (l === line && c <= column)) break;
            at--;
        }
        merged.splice(at, 0, call);
    }
    return merged;
}

function findCallsInTree(code, tree, parser, sink = null) {
    const calls = [];
    const instanceFieldContracts = explicitInstanceFieldContracts(tree, parser);
    // Same-file callable return contracts are a closed type source for loop
    // bindings: `for item in parse_items()` can use
    // `parse_items() -> list[Item]` without guessing about external code.
    const callableIterableTypes = new Map();
    traverseTreeCached(tree.rootNode, node => {
        if (sink && node.type === 'class_definition') sink.classNodes.push(node);
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
    const aliasesStack = [];
    const nonCallableNames = new Set();  // Track names assigned non-callable values
    const nonCallableNamesStack = [];
    const localVarTypes = new ReceiverTypeMap();  // Track local variable types: varName -> typeName (for receiverType inference)
    const declaredVarTypes = new Map(); // Compiler-checked annotations survive later assignments
    const localVarTypeQualifiers = new Map(); // varName -> imported module alias that owns the inferred type
    // varName -> concrete union alternatives. `None` is retained only for a
    // complete constructor/nullable branch join so a later identity guard can
    // narrow it without typing unguarded calls.
    const localVarUnionTypes = new Map();
    const localIterableTypes = new Map(); // iterable binding -> loop-variable types
    const localIterationSources = new Map(); // loop variable -> declared iterable path + tuple index
    const localDictValueTypes = new Map(); // local dict -> exact string-key value types
    const localSubscriptSources = new Map(); // local value -> exact typed container selected by []
    const localSubscriptElements = new Map(); // container binding -> declared element contract (fix #359)
    const localSubscriptElementsStack = [];
    const localVarStdlibContracts = new Map(); // variable -> stdlib module proving its type flow
    const assignmentRhsReceiverTypes = new Map(); // call-node id -> pre-assignment type and origin
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
    // One-hop local aliases of attribute paths (fix #381):
    // `config = self.config; config.load()` receives through `self.config`.
    // name -> { node: the aliased attribute node, scope: function node id }.
    const localFieldAliases = new Map();
    const memberAliasesStack = [];  // function-scoped save/restore, like localVarTypes
    // Exact class-value aliases: `_Segment = Segment` makes later
    // `_Segment.line()` dispatch through the imported/local class object.
    // Keep this separate from callable aliases: receiver evidence must be
    // scope-local, position-aware, and invalidated by every later write.
    const classValueAliases = new ReceiverTypeMap();
    const classValueAliasesStack = [];
    const moduleAliases = new Set();  // Names bound to MODULES (import httpx / import numpy as np)
    const moduleImportSpecifiers = new Set(); // Exact dotted imports: import rich.repr
    const localVarTypesStack = [];  // Stack for function-scoped save/restore of localVarTypes
    const declaredVarTypesStack = [];
    const localVarTypeQualifiersStack = [];
    const localVarUnionTypesStack = [];
    const localIterableTypesStack = [];
    const localIterationSourcesStack = [];
    const localDictValueTypesStack = [];
    const localSubscriptSourcesStack = [];
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
            return stringValueOf(arg);
        }
        return null;
    };
    const stringValueOf = (arg) => {
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
        }
        return _extractStringArg(arg);
    };

    // fix #366: keyword request configuration — `session.request(
    // method="POST", url="/api/items")`, `send(url="/x")`. Returns
    // { url, interp, method? } when a `url=` keyword carries a string.
    // Whether the callee performs HTTP is decided at query time.
    const getRequestConfig = (callNode) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return null;
        let url = null;
        let method = null;
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type !== 'keyword_argument') continue;
            const nameNode = arg.childForFieldName('name');
            const valueNode = arg.childForFieldName('value');
            if (!nameNode || !valueNode || valueNode.type !== 'string') continue;
            // `path=` is overwhelmingly a filesystem path in Python APIs;
            // only `url=` names a request target.
            if (nameNode.text === 'url' && !url) {
                const v = stringValueOf(valueNode);
                if (v && typeof v.value === 'string' && v.value.length > 0) {
                    url = { value: v.value, interp: !!v.interp, key: nameNode.text };
                }
            } else if (nameNode.text === 'method') {
                const v = _extractStringArg(valueNode);
                if (v && !v.interp && typeof v.value === 'string' && v.value.length > 0) {
                    method = v.value.toUpperCase();
                }
            }
        }
        if (!url) return null;
        return { url: url.value, key: url.key, ...(url.interp && { interp: true }),
            ...(method && { method }) };
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
    const isDirectScopeAssignment = assignment => {
        const statement = assignment?.parent?.type === 'expression_statement'
            ? assignment.parent : assignment;
        const parent = statement?.parent;
        if (parent?.type === 'module') return true;
        if (parent?.type !== 'block') return false;
        return ['function_definition', 'async_function_definition']
            .includes(parent.parent?.type);
    };
    const functionParameterBindsName = (functionNode, name) => {
        const params = functionNode?.childForFieldName('parameters');
        if (!params) return false;
        for (let i = 0; i < params.namedChildCount; i++) {
            const param = params.namedChild(i);
            let paramName = param.type === 'identifier'
                ? param
                : (param.childForFieldName('name') || param.namedChild(0));
            if (paramName && ['dictionary_splat_pattern', 'list_splat_pattern']
                .includes(paramName.type)) {
                paramName = paramName.namedChild(0);
            }
            if (paramName?.type === 'identifier' && paramName.text === name) {
                return true;
            }
        }
        return false;
    };
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
    // Compiler-stable two-branch join (#330):
    //   if value is not None and not isinstance(value, T): out = T(value)
    //   else: out = value
    // The result is T | None. Require one direct assignment per branch and
    // exactly the two proving conjuncts; extra control flow must abstain.
    const nullableBranchJoinType = (assignment, targetName, source) => {
        if (!assignment || !source ||
            !['identifier', 'attribute'].includes(source.type)) return null;
        const block = assignment.parent?.parent;
        const elseClause = block?.parent;
        const statement = elseClause?.parent;
        if (block?.type !== 'block' || block.namedChildCount !== 1 ||
            elseClause?.type !== 'else_clause' ||
            statement?.type !== 'if_statement') return null;

        const directAssignment = branch => {
            if (branch?.type !== 'block' || branch.namedChildCount !== 1) {
                return null;
            }
            const expression = branch.namedChild(0);
            const candidate = expression?.type === 'expression_statement'
                ? expression.namedChild(0) : null;
            return candidate?.type === 'assignment' &&
                candidate.childForFieldName('left')?.type === 'identifier' &&
                candidate.childForFieldName('left').text === targetName
                ? candidate.childForFieldName('right') : null;
        };
        const alternative = elseClause.childForFieldName('body') ||
            elseClause.namedChild(0);
        const alternativeRhs = directAssignment(alternative);
        if (alternativeRhs?.id !== source.id) return null;

        const condition = statement.childForFieldName('condition');
        const andTerms = node => {
            const isAnd = node?.type === 'boolean_operator' &&
                node.children.some(child => child.type === 'and');
            return isAnd
                ? node.namedChildren.flatMap(andTerms)
                : (node ? [node] : []);
        };
        const terms = andTerms(condition);
        if (terms.length !== 2) return null;
        const sameSource = node => node?.type === source.type &&
            node.text === source.text;
        const nonNull = terms.find(term => {
            if (term.type !== 'comparison_operator' ||
                !term.children.some(child => child.type === 'is not') ||
                term.namedChildCount !== 2) return false;
            const parts = [term.namedChild(0), term.namedChild(1)];
            return parts.some(part => part?.type === 'none') &&
                parts.some(sameSource);
        });
        const negativeIsinstance = terms.find(term =>
            term.type === 'not_operator' &&
            term.namedChild(0)?.type === 'call');
        if (!nonNull || !negativeIsinstance) return null;
        const check = negativeIsinstance.namedChild(0);
        if (check.childForFieldName('function')?.type !== 'identifier' ||
            check.childForFieldName('function').text !== 'isinstance') return null;
        const args = check.childForFieldName('arguments');
        if (!args || args.namedChildCount !== 2 ||
            !sameSource(args.namedChild(0))) return null;
        const narrowedType = typeNameFromExpr(args.namedChild(1));
        if (!narrowedType) return null;

        const consequence = statement.childForFieldName('consequence');
        const consequenceRhs = directAssignment(consequence);
        if (consequenceRhs?.type !== 'call') return null;
        const constructor = exactConstructorInfo(
            consequenceRhs.childForFieldName('function'));
        return constructor?.type === narrowedType
            ? [narrowedType, 'None'] : null;
    };

    // A function may legally reference a module global declared later in the
    // file. The source-order walk cannot see that binding yet, so collect the
    // narrow compiler-stable subset up front: one direct module assignment to
    // a bare constructor, with no other module-scope write to the name. Keep
    // qualified constructors out of this forward pass because their module
    // import must itself be proven at the assignment position.
    const moduleBindingCounts = new Map();
    const forwardModuleConstructorCandidates = new Map();
    const moduleTargetNames = target => {
        if (!target) return [];
        if (target.type === 'identifier') return [target.text];
        if (!['tuple', 'pattern_list', 'list', 'list_pattern',
            'tuple_pattern', 'list_splat_pattern',
            'dictionary_splat_pattern'].includes(target.type)) return [];
        const names = [];
        for (let i = 0; i < target.namedChildCount; i++) {
            names.push(...moduleTargetNames(target.namedChild(i)));
        }
        return names;
    };
    const isModuleScopeNode = node => {
        for (let parent = node?.parent; parent; parent = parent.parent) {
            if (parent.type === 'function_definition' ||
                parent.type === 'class_definition' ||
                parent.type === 'lambda') return false;
        }
        return true;
    };
    const moduleBindingNodeTypes = new Set([
        'assignment', 'augmented_assignment', 'named_expression',
        'for_statement', 'function_definition', 'async_function_definition',
        'class_definition', 'import_statement', 'import_from_statement',
        'global_statement', 'delete_statement', 'as_pattern',
    ]);
    let hasModuleWildcardImport = false;
    traverseTreeCached(tree.rootNode, node => {
        if (!moduleBindingNodeTypes.has(node.type)) return true;
        if (node.type === 'global_statement') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type !== 'identifier') continue;
                moduleBindingCounts.set(child.text,
                    (moduleBindingCounts.get(child.text) || 0) + 1);
            }
            return true;
        }
        if (!isModuleScopeNode(node)) return true;
        let names = [];
        if (node.type === 'assignment' ||
            node.type === 'augmented_assignment' ||
            node.type === 'named_expression') {
            names = moduleTargetNames(
                node.childForFieldName('left') ||
                node.childForFieldName('name'));
        } else if (node.type === 'for_statement') {
            names = moduleTargetNames(node.childForFieldName('left'));
        } else if (node.type === 'function_definition' ||
            node.type === 'async_function_definition' ||
            node.type === 'class_definition') {
            names = moduleTargetNames(node.childForFieldName('name'));
        } else if (node.type === 'import_statement') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'aliased_import') {
                    const alias = child.childForFieldName('alias');
                    const imported = child.childForFieldName('name');
                    if (alias) names.push(alias.text);
                    else if (imported) names.push(imported.text.split('.')[0]);
                } else if (child.type === 'dotted_name') {
                    names.push(child.text.split('.')[0]);
                }
            }
        } else if (node.type === 'import_from_statement') {
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child.type === 'wildcard_import') {
                    hasModuleWildcardImport = true;
                } else if (child.type === 'aliased_import') {
                    const alias = child.childForFieldName('alias');
                    const imported = child.childForFieldName('name');
                    if (alias) names.push(alias.text);
                    else if (imported) names.push(imported.text.split('.').pop());
                } else if (i > 0 && child.type === 'dotted_name') {
                    names.push(child.text.split('.').pop());
                }
            }
        } else if (node.type === 'delete_statement') {
            for (let i = 0; i < node.namedChildCount; i++) {
                names.push(...moduleTargetNames(node.namedChild(i)));
            }
        } else if (node.type === 'as_pattern') {
            names = moduleTargetNames(
                node.childForFieldName('alias')?.namedChild(0));
        }
        for (const name of names) {
            moduleBindingCounts.set(name,
                (moduleBindingCounts.get(name) || 0) + 1);
        }
        if (node.type !== 'assignment' || names.length !== 1) return true;
        const statement = node.parent?.type === 'expression_statement'
            ? node.parent : node;
        if (statement.parent?.type !== 'module') return true;
        const right = node.childForFieldName('right');
        if (right?.type !== 'call') return true;
        const ctor = constructorTypeInfo(right.childForFieldName('function'));
        if (!ctor || ctor.qualifier ||
            isPythonConstructorValueShadowedAt(
                right.childForFieldName('function'), ctor.type)) return true;
        forwardModuleConstructorCandidates.set(names[0], ctor);
        return true;
    });
    const stableForwardModuleConstructors = new Map(
        [...forwardModuleConstructorCandidates].filter(([name]) =>
            !hasModuleWildcardImport && moduleBindingCounts.get(name) === 1));

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
                    moduleImportSpecifiers.add(child.text);
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
            localVarTypesStack.push(new ReceiverTypeMap(localVarTypes));
            declaredVarTypesStack.push(new Map(declaredVarTypes));
            localVarTypeQualifiersStack.push(new Map(localVarTypeQualifiers));
            localVarUnionTypesStack.push(new Map(localVarUnionTypes));
            localIterableTypesStack.push(new Map(localIterableTypes));
            localIterationSourcesStack.push(new Map(localIterationSources));
            localDictValueTypesStack.push(new Map(
                [...localDictValueTypes].map(([name, values]) =>
                    [name, new Map(values)])));
            localSubscriptSourcesStack.push(new Map(localSubscriptSources));
            localSubscriptElementsStack.push(new Map(localSubscriptElements));
            localVarStdlibContractsStack.push(new Map(localVarStdlibContracts));
            constructedReceiverVarsStack.push(new Set(constructedReceiverVars));
            withBindingVarsStack.push(new Set(withBindingVars));
            memberAliasesStack.push(new Map(memberAliases));
            classValueAliasesStack.push(new ReceiverTypeMap(classValueAliases));
            aliasesStack.push(new Map(aliases));
            nonCallableNamesStack.push(new Set(nonCallableNames));
            const body = node.childForFieldName('body');
            for (const [name, ctor] of stableForwardModuleConstructors) {
                if (functionParameterBindsName(node, name) ||
                    (body && pythonScopeBindsName(body, name))) continue;
                if (!localVarTypes.has(name)) {
                    localVarTypes.set(name, ctor.type, 'constructor');
                    constructedReceiverVars.add(name);
                }
            }
            for (const name of aliases.keys()) {
                if ((body && pythonScopeBindsName(body, name)) ||
                    functionParameterBindsName(node, name)) {
                    aliases.delete(name);
                }
            }
            for (const name of nonCallableNames) {
                if ((body && pythonScopeBindsName(body, name)) ||
                    functionParameterBindsName(node, name)) {
                    nonCallableNames.delete(name);
                }
            }
            for (const name of localSubscriptSources.keys()) {
                if ((body && pythonScopeBindsName(body, name)) ||
                    functionParameterBindsName(node, name)) {
                    localSubscriptSources.delete(name);
                }
            }
            for (const name of localSubscriptElements.keys()) {
                if ((body && pythonScopeBindsName(body, name)) ||
                    functionParameterBindsName(node, name)) {
                    localSubscriptElements.delete(name);
                }
            }
            for (const name of classValueAliases.keys()) {
                if ((body && pythonScopeBindsName(body, name)) ||
                    functionParameterBindsName(node, name)) {
                    classValueAliases.delete(name);
                }
            }
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
                    localVarTypes.set(nameNode.text, receiverType, 'annotation', typeNode);
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
                const elementContract = parameterPattern?.type === 'identifier'
                    ? subscriptElementContract(typeNode) : null;
                if (elementContract) localSubscriptElements.set(nameNode.text, elementContract);
                else localSubscriptElements.delete(nameNode.text);
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
                        if (itemTypes[i]) localVarTypes.set(names[i], itemTypes[i], 'flow', node);
                    }
                } else if (names.length === 1 && itemTypes.length === 1) {
                    localVarTypes.set(names[0], itemTypes[0], 'flow', node);
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
                        localVarTypes.set(targetId.text, exactCtor.type, 'constructor', node);
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
                        localVarTypes.set(targetId.text, 'IO', 'with-binding', node);
                    }
                }
            }
        }

        // Track local aliases and non-callable assignments
        if (node.type === 'assignment') {
            const left = node.childForFieldName('left');
            const right = node.childForFieldName('right');
            if (left?.type === 'identifier') {
                classValueAliases.delete(left.text);
                localSubscriptSources.delete(left.text);
                const previousType = localVarTypes.get(left.text);
                if (previousType && right?.type === 'call') {
                    const rightFunction = right.childForFieldName('function');
                    if (rightFunction?.type === 'attribute' &&
                        rightFunction.childForFieldName('object')?.type === 'identifier' &&
                        rightFunction.childForFieldName('object').text === left.text) {
                        assignmentRhsReceiverTypes.set(right.id, { type: previousType,
                            ...localVarTypes.fields(left.text, previousType) });
                    }
                }
                // Track type annotation: x: Foo = ... → x is Foo
                const typeNode = node.childForFieldName('type');
                const branchJoinUnion = !typeNode
                    ? nullableBranchJoinType(node, left.text, right) : null;
                if (typeNode) {
                    const typeName = typeNameFromAnnotation(typeNode);
                    const unionTypes = typeNamesFromAnnotation(typeNode);
                    const itemTypes = iterableBindingTypes(typeNode);
                    if (typeName) {
                        localVarTypes.set(left.text, typeName, 'constructor', right);
                        declaredVarTypes.set(left.text, typeName);
                    }
                    if (unionTypes.length > 1) localVarUnionTypes.set(left.text, unionTypes);
                    else localVarUnionTypes.delete(left.text);
                    if (itemTypes.length > 0) localIterableTypes.set(left.text, itemTypes);
                    else localIterableTypes.delete(left.text);
                    const elementContract = subscriptElementContract(typeNode);
                    if (elementContract) localSubscriptElements.set(left.text, elementContract);
                    else localSubscriptElements.delete(left.text);
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
                    localSubscriptElements.delete(left.text);
                    localIterationSources.delete(left.text);
                    localDictValueTypes.delete(left.text);
                    localVarStdlibContracts.delete(left.text);
                    if (branchJoinUnion) {
                        localVarUnionTypes.set(left.text, branchJoinUnion);
                    }
                    // Python assignments remain constrained by a variable or
                    // parameter annotation. Constructor/literal inference is
                    // nearest-assignment only, but a declared contract is
                    // valid for every subsequent assignment in type-correct
                    // code (`boundary: bytes | None; boundary = make()`).
                    const declaredType = declaredVarTypes.get(left.text);
                    if (declaredType) localVarTypes.set(left.text, declaredType, 'annotation', node);
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
                        localVarTypes.set(left.text, previousType, 'flow', node);
                    }
                }
                if (!typeNode && right?.type === 'yield') {
                    const sendType = functionStack[
                        functionStack.length - 1]?.generatorSendType;
                    if (sendType) localVarTypes.set(left.text, sendType, 'flow', node);
                }
                // Literal assignment types the variable (fix #218):
                // ansi_bytes = b"…" → bytes; out = [] → list. Compiler-true,
                // same trust grade as literal receivers ({}.get() → dict).
                if (!typeNode && right && PY_LITERAL_RECEIVER_TYPES[right.type]) {
                    let litType = PY_LITERAL_RECEIVER_TYPES[right.type];
                    if (litType === 'str' && /^[rRuU]*[bB]/.test(right.text)) litType = 'bytes';
                    localVarTypes.set(left.text, litType, 'literal', right);
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
                if (!typeNode && right?.type === 'subscript') {
                    const base = right.childForFieldName('value');
                    // Declared container element (fix #359): `c = params[k]`
                    // with `params: dict[str, Convertor]` types c. A slice
                    // (`items[1:]`) is a container, not an element.
                    const element = base?.type === 'identifier' && base.text !== left.text
                        ? localSubscriptElements.get(base.text) : null;
                    const subscriptKey = right.childForFieldName('subscript');
                    if (element && subscriptKey?.type !== 'slice' &&
                        !declaredVarTypes.get(left.text)) {
                        localVarTypes.set(left.text, element.type, 'annotation', element.node);
                        if (element.qualifier) {
                            localVarTypeQualifiers.set(left.text, element.qualifier);
                        } else {
                            localVarTypeQualifiers.delete(left.text);
                        }
                    }
                    if (base?.type === 'identifier' && base.text !== left.text) {
                        const rootType = localVarTypes.get(base.text);
                        if (rootType) {
                            localSubscriptSources.set(left.text, {
                                root: base.text,
                                rootType,
                                rootTypeQualifier:
                                    localVarTypeQualifiers.get(base.text),
                            });
                        }
                    }
                }
                const roundTripSource = pickleRoundTripSource(right);
                const roundTripType = roundTripSource
                    ? localVarTypes.get(roundTripSource) : null;
                if (roundTripType && moduleAliases.has('pickle')) {
                    localVarTypes.set(left.text, roundTripType, 'flow', node);
                    localVarStdlibContracts.set(left.text, 'pickle');
                }
                // A class-body assignment binds a class attribute, never a
                // name of the enclosing function (fix #381): `Connection =
                // Mock` inside a local class leaves the function's
                // `Connection(...)` calls alone.
                const classBodyAssignment = pythonEnclosingScopeType(node) === 'class_definition';
                if (right?.type === 'identifier' && classBodyAssignment) {
                    // attribute binding only
                } else if (right?.type === 'identifier') {
                    aliases.set(left.text, right.text);
                    const classValue = !typeNode && isDirectScopeAssignment(node)
                        ? exactConstructorInfo(right) : null;
                    if (classValue) {
                        classValueAliases.set(left.text, classValue.type, 'type-qualified', node);
                    }
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
                        // A bound method read through a typed receiver
                        // (`loads = registry.loads`, `run = Client().run`,
                        // fix #400) references the method: a rename edits
                        // the attribute, never the variable holding it.
                        let valueType = null;
                        let valueFields = null;
                        if (objNode?.type === 'identifier' && !['self', 'cls'].includes(objNode.text) &&
                            !moduleAliases.has(objNode.text)) {
                            valueType = localVarTypes.get(objNode.text) || null;
                            if (valueType) valueFields = localVarTypes.fields(objNode.text, valueType);
                        } else if (objNode?.type === 'call') {
                            const ctor = exactConstructorInfo(objNode.childForFieldName('function'));
                            if (ctor && !ctor.qualifier) {
                                valueType = ctor.type;
                                valueFields = { receiverTypeSource: 'constructor',
                                    receiverTypeEvidence: { ...typeOrigin('constructor', objNode), type: ctor.type } };
                            }
                        }
                        const valuePath = !valueType && objNode?.type === 'attribute'
                            ? attributeReceiverPath(objNode) : null;
                        if (valueType || valuePath) {
                            // The receiver context a call on it carries.
                            const recv = objNode.type === 'identifier' ? objNode.text : null;
                            calls.push({
                                callSite: typeOrigin('call', attrName),
                                name: attrName.text,
                                line: attrName.startPosition.row + 1,
                                isMethod: true,
                                ...(recv && { receiver: recv }),
                                ...(valueType && { receiverType: valueType }),
                                ...valueFields,
                                ...(valuePath && {
                                    receiverRoot: valuePath.root,
                                    receiverField: valuePath.fields[valuePath.fields.length - 1],
                                    receiverFields: valuePath.fields,
                                    ...(localVarTypes.has(valuePath.root) && {
                                        receiverRootType: localVarTypes.get(valuePath.root),
                                    }),
                                }),
                                ...(recv && localVarTypeQualifiers.get(recv) && {
                                    receiverTypeQualifier: localVarTypeQualifiers.get(recv),
                                }),
                                ...(recv && localVarStdlibContracts.has(recv) && {
                                    receiverTypeStdlibModule: localVarStdlibContracts.get(recv),
                                }),
                                ...(((!recv && !valuePath) || constructedReceiverVars.has(recv)) && { receiverConstructed: true }),
                                ...(recv && withBindingVars.has(recv) && { receiverWithBinding: true }),
                                ...(recv && isShadowedByLocal(objNode, recv) && { receiverLocalBinding: true }),
                                isFunctionReference: true,
                                ...(!valuePath && { memberRead: true }),
                                enclosingFunction: getCurrentEnclosingFunction(),
                            });
                        }
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
                // One-hop local alias (fix #381): a function local bound
                // exactly once, by `x = y` or `x = self.attr`, receives
                // like its initializer. A second binding anywhere in the
                // function (reassignment, loop target, global/nonlocal)
                // leaves it untyped.
                localFieldAliases.delete(left.text);
                if (!typeNode && right && right.text !== left.text &&
                    (right.type === 'identifier' || right.type === 'attribute')) {
                    const scope = pythonEnclosingFunctionNode(node);
                    if (scope && pythonSingleLocalBinding(scope, left.text)) {
                        if (right.type === 'identifier' && localVarTypes.has(right.text) &&
                            !localVarUnionTypes.has(right.text)) {
                            localVarTypes.set(left.text, localVarTypes.get(right.text),
                                localVarTypes.origins.get(right.text) || 'flow');
                            if (localVarTypeQualifiers.has(right.text)) {
                                localVarTypeQualifiers.set(left.text, localVarTypeQualifiers.get(right.text));
                            }
                            if (constructedReceiverVars.has(right.text)) constructedReceiverVars.add(left.text);
                            if (localVarStdlibContracts.has(right.text)) {
                                localVarStdlibContracts.set(left.text, localVarStdlibContracts.get(right.text));
                            }
                        } else if (right.type === 'attribute') {
                            const path = attributeReceiverPath(right);
                            if (path && path.root !== left.text &&
                                (path.root === 'self' || path.root === 'cls' ||
                                    pythonBindingCount(scope, path.root) <= 1)) {
                                localFieldAliases.set(left.text, { node: right, scope: scope.id });
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
                        localVarTypes.set(left.text, exactCtor.type, 'constructor', node);
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
                        callSite: typeOrigin('call', funcNode),
                        name: memberAlias.attr,
                        line: node.startPosition.row + 1,
                        isMethod: true,
                        aliasCall: true,
                        ...(memberAlias.receiver && { receiver: memberAlias.receiver }),
                        ...(recvType && { receiverType: recvType, ...localVarTypes.fields(memberAlias.receiver, recvType) }),
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
                    const requestConfig = argCount > 0 ? getRequestConfig(node) : null;
                    calls.push({
                        callSite: typeOrigin('call', funcNode),
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
                        ...pythonShadowFields(funcNode, funcNode.text),
                        ...ownClassFields(node),
                        ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp }),
                        ...(requestConfig && { requestConfig })
                    });
                }
            } else if (funcNode.type === 'call') {
                // `type(self)(..)` constructs the method's class (fix #434).
                const ownClass = pythonOwnClassConstruction(node);
                if (ownClass) {
                    calls.push({
                        callSite: typeOrigin('call', ownClass.receiverNode),
                        column: ownClass.receiverNode.startPosition.column,
                        name: ownClass.name,
                        line: node.startPosition.row + 1,
                        isMethod: false,
                        argCount,
                        ...(argSpread && { argSpread: true }),
                        enclosingFunction,
                        uncertain,
                        ownClass,
                    });
                }
            } else if (funcNode.type === 'attribute') {
                // Method/attribute call: obj.foo() or self.attr.foo()
                const attrNode = funcNode.childForFieldName('attribute');
                let objNode = funcNode.childForFieldName('object');
                // fix #381: `config.load()` after `config = self.config`
                // receives exactly like `self.config.load()`.
                if (objNode?.type === 'identifier' && localFieldAliases.has(objNode.text) &&
                    !localVarTypes.has(objNode.text)) {
                    const alias = localFieldAliases.get(objNode.text);
                    if (alias.scope === pythonEnclosingFunctionNode(objNode)?.id) objNode = alias.node;
                }

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
                        if (superFunc?.type === 'identifier' && superFunc.text === 'super' &&
                            objNode.childForFieldName('arguments')?.namedChildCount === 0) {
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
                    let subscriptElementReceiver = null;
                    let receiverSubscriptRoot;
                    let receiverSubscriptRootType;
                    let receiverSubscriptRootTypeQualifier;
                    if (objNode?.type === 'subscript') {
                        const base = objNode.childForFieldName('value');
                        const key = literalStringValue(
                            objNode.childForFieldName('subscript'));
                        if (base?.type === 'identifier') {
                            receiverSubscriptRoot = base.text;
                            receiverSubscriptRootType = localVarTypes.get(base.text);
                            receiverSubscriptRootTypeQualifier =
                                localVarTypeQualifiers.get(base.text);
                            if (key != null) {
                                subscriptReceiverType =
                                    localDictValueTypes.get(base.text)?.get(key);
                            }
                            const element = localSubscriptElements.get(base.text);
                            if (!subscriptReceiverType && element &&
                                objNode.childForFieldName('subscript')?.type !== 'slice') {
                                subscriptReceiverType = element.type;
                                subscriptElementReceiver = element;
                            }
                        }
                    }
                    if (!receiverSubscriptRoot && receiver) {
                        const source = localSubscriptSources.get(receiver);
                        if (source) {
                            receiverSubscriptRoot = source.root;
                            receiverSubscriptRootType = source.rootType;
                            receiverSubscriptRootTypeQualifier =
                                source.rootTypeQualifier;
                        }
                    }
                    const narrowedType = receiver && narrowedReceiverType(
                        objNode, receiver, localVarUnionTypes.get(receiver));
                    const comprehensionType = receiver && comprehensionReceiverType(
                        objNode, receiver, localIterableTypes, callableIterableTypes, instanceFieldContracts);
                    const rhsReceiver = assignmentRhsReceiverTypes.get(node.id);
                    const receiverType = receiver
                        ? (narrowedType || comprehensionType ||
                            localVarTypes.get(receiver) ||
                            classValueAliases.get(receiver))
                            || rhsReceiver?.type
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
                        : subscriptElementReceiver?.qualifier;
                    const receiverRootType = receiverPath
                        ? localVarTypes.get(receiverPath.root) : undefined;
                    const dottedReceiver = receiverPath
                        ? [receiverPath.root, ...receiverPath.fields].join('.')
                        : null;
                    const receiverModuleSpecifier = dottedReceiver &&
                        moduleImportSpecifiers.has(dottedReceiver) &&
                        !isShadowedByLocal(objNode, receiverPath.root)
                        ? dottedReceiver : undefined;
                    // Module receiver (httpx.get()) — unless locally shadowed
                    // by a typed instance binding
                    const receiverIsModule = !!receiver && moduleAliases.has(receiver) &&
                        !localVarTypes.has(receiver);
                    const firstArg = getFirstStringArg(node);
                    const requestConfig = argCount > 0 ? getRequestConfig(node) : null;
                    const capabilityGuard = receiverCapabilityGuard(
                        node, objNode, attrNode.text);
                    let awaitParent = node.parent;
                    while (awaitParent?.type === 'parenthesized_expression') awaitParent = awaitParent.parent;
                    calls.push({
                        callSite: typeOrigin('call', attrNode),
                        name: attrNode.text,
                        // Multi-line chains (obj.x()\n.y()) must report each
                        // method's OWN name line, not the chain-start line —
                        // the account's ground set is keyed by the name's line
                        line: attrNode.startPosition.row + 1,
                        isMethod: true,
                        // `await x.m()` and `f(x.m())` (fix #402): the value
                        // is awaited or passed on; audit-async skips them.
                        ...(awaitParent?.type === 'await' && { awaited: true }),
                        ...((awaitParent?.type === 'argument_list' || awaitParent?.type === 'keyword_argument') &&
                            { passedAsArgument: true }),
                        receiver,
                        ...(receiverType && { receiverType,
                            ...(narrowedType || comprehensionType ? {
                                receiverTypeSource: 'flow', receiverTypeEvidence: {
                                    ...typeOrigin('flow', objNode),
                                    union: localVarUnionTypes.get(receiver),
                                    ...(comprehensionType && { type: comprehensionType, comprehension: true }),
                                },
                            } : receiver && classValueAliases.get(receiver) === receiverType ?
                                classValueAliases.fields(receiver) :
                                receiver && !localVarTypes.has(receiver) && rhsReceiver?.type === receiverType
                                    ? { receiverTypeSource: rhsReceiver.receiverTypeSource,
                                        receiverTypeEvidence: rhsReceiver.receiverTypeEvidence } :
                                receiver ? localVarTypes.fields(receiver, receiverType) :
                                subscriptElementReceiver ? {
                                    receiverTypeSource: 'annotation',
                                    receiverTypeEvidence: typeOrigin('annotation', subscriptElementReceiver.node),
                                } : {
                                    receiverTypeSource: 'literal', receiverTypeEvidence: typeOrigin('literal', objNode),
                                }),
                        }),
                        ...(receiver && localVarStdlibContracts.has(receiver) && {
                            receiverTypeStdlibModule:
                                localVarStdlibContracts.get(receiver),
                        }),
                        ...(receiverTypeQualifier && { receiverTypeQualifier }),
                        ...(receiver && constructedReceiverVars.has(receiver) && { receiverConstructed: true }),
                        ...(receiver && withBindingVars.has(receiver) && { receiverWithBinding: true }),
                        ...(receiverIsModule && { receiverIsModule: true }),
                        ...(receiverModuleSpecifier && { receiverModuleSpecifier }),
                        ...(receiverSubscriptRoot && { receiverSubscriptRoot }),
                        ...(receiverSubscriptRootType && {
                            receiverSubscriptRootType,
                        }),
                        ...(receiverSubscriptRootTypeQualifier && {
                            receiverSubscriptRootTypeQualifier,
                        }),
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
                        ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp }),
                        ...(requestConfig && { requestConfig })
                    });
                    // `self.__class__(..)` constructs the method's class (fix #434).
                    const ownClass = attrNode.text === '__class__' ? pythonOwnClassConstruction(node) : null;
                    if (ownClass) {
                        calls.push({
                            callSite: typeOrigin('call', ownClass.receiverNode),
                            column: ownClass.receiverNode.startPosition.column,
                            name: ownClass.name,
                            line: node.startPosition.row + 1,
                            isMethod: false,
                            argCount,
                            ...(argSpread && { argSpread: true }),
                            enclosingFunction,
                            uncertain,
                            ownClass,
                        });
                    }
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
                    const rawArg = argsNode.namedChild(i);
                    const arg = rawArg.type === 'keyword_argument'
                        ? rawArg.childForFieldName('value') : rawArg;
                    if (!arg) continue;
                    // Bare keyword values already belong to the reference
                    // inventory/rename path; only extend the member-value
                    // callback model to match its positional counterpart.
                    if (rawArg.type === 'keyword_argument' && arg.type !== 'attribute') continue;
                    if (arg.type === 'identifier' && !PYTHON_SKIP.has(arg.text) && !nonCallableNames.has(arg.text)) {
                        calls.push({
                            name: arg.text,
                            line: arg.startPosition.row + 1,
                            isMethod: false,
                            isFunctionReference: true,
                            isPotentialCallback: true,
                            ...pythonShadowFields(arg, arg.text),
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
                                ...(mvType && { receiverType: mvType, ...localVarTypes.fields(mvObj.text, mvType) }),
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
                                        ...pythonShadowFields(val, val.text),
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
                    localVarTypes.restore(saved);
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
                const savedSubscriptElements = localSubscriptElementsStack.pop();
                if (savedSubscriptElements) {
                    localSubscriptElements.clear();
                    for (const [name, element] of savedSubscriptElements) {
                        localSubscriptElements.set(name, element);
                    }
                }
                const savedSubscriptSources = localSubscriptSourcesStack.pop();
                if (savedSubscriptSources) {
                    localSubscriptSources.clear();
                    for (const [name, source] of savedSubscriptSources) {
                        localSubscriptSources.set(name, source);
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
                const savedClassValueAliases = classValueAliasesStack.pop();
                if (savedClassValueAliases) {
                    classValueAliases.clear();
                    for (const [k, v] of savedClassValueAliases) {
                        classValueAliases.set(k, v, savedClassValueAliases.origins.get(k));
                    }
                }
                const savedCallableAliases = aliasesStack.pop();
                if (savedCallableAliases) {
                    aliases.clear();
                    for (const [k, v] of savedCallableAliases) aliases.set(k, v);
                }
                const savedNonCallableNames = nonCallableNamesStack.pop();
                if (savedNonCallableNames) {
                    nonCallableNames.clear();
                    for (const name of savedNonCallableNames) {
                        nonCallableNames.add(name);
                    }
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
    // fix #338: `if TYPE_CHECKING:` (bare, `t.TYPE_CHECKING`,
    // `typing.TYPE_CHECKING`) consequence blocks never execute at runtime —
    // the import exists for the type checker only. Only the consequence
    // branch is guarded: `else:` and `if not TYPE_CHECKING:` bodies DO run.
    let typingBindings = null;
    let typingWildcard = false;
    const isNestedScope = node => {
        for (let p = node.parent; p; p = p.parent) {
            if (p.type === 'function_definition' || p.type === 'class_definition' || p.type === 'lambda') return true;
        }
        return false;
    };
    // Which local names prove a runtime-false guard, and where. A guard at
    // module level reads the module binding: only module-level rebindings
    // (assignments, loops, def/class names, walrus, `as` targets) and a
    // second import of the same name can disturb it — a function parameter
    // or a nested import lives in its own scope. A guard INSIDE a function
    // can additionally be shadowed by that function's locals, so nested
    // rebindings poison nested guards (conservative: any nested scope, not
    // just the enclosing one). Same-spelled user flags/attributes can be
    // true; only a unique `typing` binding proves the guard false.
    const typingBindingKind = (name, guardNested) => {
        if (!typingBindings) {
            typingBindings = new Map();
            const entry = local => {
                let e = typingBindings.get(local);
                if (!e) { e = { kind: null, imports: 0, moduleShadow: false, nestedShadow: false }; typingBindings.set(local, e); }
                return e;
            };
            const shadow = (pattern, nested) => {
                if (!pattern) return;
                traverseTree(pattern, child => {
                    if (child.type === 'identifier') {
                        const e = entry(child.text);
                        if (nested) e.nestedShadow = true; else e.moduleShadow = true;
                    }
                    return true;
                });
            };
            traverseTree(tree.rootNode, n => {
                const nested = isNestedScope(n);
                if (n.type === 'import_statement' || n.type === 'import_from_statement') {
                    if (n.namedChildren.some(item => item.type === 'wildcard_import')) typingWildcard = true;
                    const moduleNode = n.childForFieldName('module_name');
                    for (const item of n.namedChildren) {
                        if (moduleNode && sameNode(moduleNode, item)) continue;
                        const imported = item.type === 'aliased_import' ? item.childForFieldName('name')?.text : item.text;
                        const local = item.type === 'aliased_import' ? item.childForFieldName('alias')?.text : imported?.split('.')[0];
                        if (!local) continue;
                        const e = entry(local);
                        if (nested) { e.nestedShadow = true; continue; }
                        const kind = n.type === 'import_statement'
                            ? (imported === 'typing' ? 'module' : null)
                            : (moduleNode?.text === 'typing' && imported === 'TYPE_CHECKING' ? 'flag' : null);
                        e.imports++;
                        e.kind = e.imports === 1 ? kind : null;
                    }
                } else if (n.type === 'assignment' || n.type === 'augmented_assignment' || n.type === 'for_statement' || n.type === 'for_in_clause') {
                    shadow(n.childForFieldName('left'), nested);
                } else if (n.type === 'parameters' || n.type === 'lambda_parameters') {
                    // Parameter NAMES rebind; annotations (`x: t.Any`) and
                    // default values are expressions that READ the outer
                    // binding. Walking the whole subtree treated every
                    // `t.`-annotated parameter as a rebinding of `t` and
                    // reverted click's TYPE_CHECKING guards to eager.
                    for (const param of n.namedChildren) {
                        if (param.type === 'default_parameter' || param.type === 'typed_default_parameter') {
                            shadow(param.childForFieldName('name'), true);
                        } else if (param.type === 'typed_parameter') {
                            shadow(param.namedChild(0), true);
                        } else if (param.type !== 'keyword_separator' && param.type !== 'positional_separator') {
                            shadow(param, true);
                        }
                    }
                } else if (n.type === 'named_expression') shadow(n.childForFieldName('name'), nested);
                else if (n.type === 'function_definition' || n.type === 'class_definition') shadow(n.childForFieldName('name'), nested);
                else if (n.type === 'as_pattern') shadow(n.childForFieldName('alias'), nested);
                return true;
            });
        }
        if (typingWildcard) return null;
        const e = typingBindings.get(name);
        if (!e || e.imports !== 1 || e.moduleShadow) return null;
        if (guardNested && e.nestedShadow) return null;
        return e.kind;
    };
    const isTypeCheckingGuard = (condition, guardNested = true) => {
        if (!condition) return false;
        if (condition.type === 'parenthesized_expression') return isTypeCheckingGuard(condition.namedChild(0), guardNested);
        if (condition.type === 'identifier') return typingBindingKind(condition.text, guardNested) === 'flag';
        if (condition.type === 'attribute') {
            const object = condition.childForFieldName('object');
            return condition.childForFieldName('attribute')?.text === 'TYPE_CHECKING' &&
                object?.type === 'identifier' && typingBindingKind(object.text, guardNested) === 'module';
        }
        return false;
    };
    const importDeferral = (node) => {
        for (let parent = node.parent; parent; parent = parent.parent) {
            if (parent.type === 'function_definition' || parent.type === 'lambda') {
                return 'function-local';
            }
            if (parent.type === 'block' && parent.parent &&
                (parent.parent.type === 'if_statement' || parent.parent.type === 'elif_clause') &&
                sameNode(parent.parent.childForFieldName('consequence'), parent) &&
                isTypeCheckingGuard(parent.parent.childForFieldName('condition'), isNestedScope(parent.parent))) {
                return 'type-checking';
            }
        }
        return null;
    };

    traverseTreeCached(tree.rootNode, (node) => {
        // import statement: import os, import sys as system
        if (node.type === 'import_statement') {
            const line = node.startPosition.row + 1;
            const deferral = importDeferral(node);

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
                            ...(deferral && { deferred: true, deferredReason: deferral })
                        });
                        imports.push({
                            module: child.text,
                            names: [],
                            type: 'import-submodule',
                            line,
                            ...(deferral && { deferred: true, deferredReason: deferral })
                        });
                    } else {
                        imports.push({
                            module: child.text,
                            names: [child.text],
                            type: 'import',
                            line,
                            ...(deferral && { deferred: true, deferredReason: deferral })
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
                            ...(deferral && { deferred: true, deferredReason: deferral })
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
            const deferral = importDeferral(node);
            let modulePath = '';
            const names = [];
            const renames = [];

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
                        renames.push({ original: nameNode.text, local: aliasNode.text });
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
                    ...(renames.length > 0 && { renames }),
                    ...(deferral && { deferred: true, deferredReason: deferral })
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
                    const deferral = importDeferral(node);
                    const isLiteral = firstArg.type === 'string';
                    imports.push({
                        module: isLiteral ? firstArg.text.replace(/^['"]|['"]$/g, '') : firstArg.text,
                        names: [],
                        type: 'dynamic',
                        line,
                        dynamic: !isLiteral,
                        ...(deferral && { deferred: true, deferredReason: deferral })
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
function findUsagesInCode(code, name, parser, tree, options = {}) {
    tree = tree || parseTree(parser, code);
    const usages = findUsagesInTree(code, name, parser, tree, options);
    // Names inside string annotations that spell calls (fix #398F) are code:
    // the annotation's expression, parsed from the same source with the
    // quotes blanked (offsets unchanged).
    if (!/(?::|->)\s*["'][^"'\n]*\(/.test(code)) return usages;
    const quotes = annotationStringQuotes(tree).filter(quote =>
        code.slice(quote.contentStart, quote.contentEnd).includes(name));
    if (quotes.length === 0) return usages;
    const chars = code.split('');
    for (const quote of quotes) {
        chars[quote.open] = ' ';
        chars[quote.close] = ' ';
    }
    const masked = chars.join('');
    const maskedTree = parseTree(parser, masked);
    const ranges = [];
    for (const quote of quotes) {
        const node = maskedTree.rootNode.descendantForIndex(quote.contentStart, quote.contentEnd);
        if (!node || node.hasError || node.isMissing) continue;
        const start = maskedTree.rootNode.descendantForIndex(quote.contentStart).startPosition;
        ranges.push({ row: start.row, from: start.column, to: start.column + (quote.contentEnd - quote.contentStart) });
    }
    if (ranges.length === 0) return usages;
    const extra = findUsagesInTree(masked, name, parser, maskedTree, options).filter(usage =>
        ranges.some(range => usage.line === range.row + 1 && usage.column >= range.from && usage.column < range.to));
    if (extra.length === 0) return usages;
    return [...usages, ...extra.map(usage => ({ ...usage, stringAnnotation: true }))]
        .sort((a, b) => a.line - b.line || a.column - b.column);
}

function findUsagesInTree(code, name, parser, tree, options = {}) {
    const usages = [];
    const moduleAliases = pythonModuleAliases(tree);
    // Lexical scope verdicts (fix #392) only for refactoring internals.
    const scopeMemo = options.lexicalScopes ? new Map() : null;

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
            // Definition: parameter name. A default VALUE is a reference
            // evaluated in the enclosing scope (fix #392).
            else if (parent.type === 'parameter' ||
                     parent.type === 'parameters' ||
                     parent.type === 'lambda_parameters' ||
                     ((parent.type === 'default_parameter' ||
                       parent.type === 'typed_default_parameter') &&
                      sameNode(parent.childForFieldName('name'), node)) ||
                     (parent.type === 'typed_parameter' &&
                      sameNode(parent.namedChild(0), node)) ||
                     ((parent.type === 'list_splat_pattern' ||
                       parent.type === 'dictionary_splat_pattern') &&
                      /^(parameters|lambda_parameters|typed_parameter)$/.test(parent.parent?.type || ''))) {
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

        // A module path segment (`from a.b import c`, `import a.b [as x]`)
        // names a module, never a function, class or variable; the name of
        // `from m import name as alias` is m's attribute, decided by m (fix
        // #424). Neither is a reference resolved in this file's scopes.
        const importRole = pythonImportTokenRole(node);
        if (importRole) {
            usages.push({ line, column, usageType, ...(importRole === 'module-path'
                ? { modulePath: true } : { importSource: true }) });
            return true;
        }
        // Where a bare reference resolves (fix #392): plan edits it only
        // when the language's scoping proves it names the renamed binding.
        const scope = scopeMemo && usageType === 'reference'
            ? scopeFields(referenceScope(node, 'python', scopeMemo)) : null;
        usages.push({ line, column, usageType, ...scope });
        return true;
    });

    return usages;
}

/**
 * The role of an identifier inside an import statement (fix #424):
 * 'module-path' for a segment of the imported module's dotted path,
 * 'import-source' for the imported name of `from m import name as alias`,
 * null otherwise (bound names and aliases).
 */
function pythonImportTokenRole(node) {
    const dotted = node.parent;
    if (dotted?.type !== 'dotted_name') return null;
    const holder = dotted.parent;
    if (!holder) return null;
    if (holder.type === 'relative_import' || holder.type === 'import_statement') return 'module-path';
    if (holder.type === 'import_from_statement') {
        return sameNode(holder.childForFieldName('module_name'), dotted) ? 'module-path' : null;
    }
    if (holder.type === 'aliased_import' && sameNode(holder.childForFieldName('name'), dotted)) {
        const statement = holder.parent?.type;
        if (statement === 'import_statement') return 'module-path';
        if (statement === 'import_from_statement') return 'import-source';
    }
    return null;
}

/**
 * Find instance attribute types from __init__ constructor assignments.
 * Parses self.X = ClassName(...) patterns in __init__ methods.
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Map<string, Map<string, string>>} className -> (attrName -> typeName)
 */
function findInstanceAttributeTypes(code, parser, options = {}) {
    const tree = options.tree || parseTree(parser, code);
    const result = new Map(); // className -> Map(attrName -> typeName)
    const explicitContracts = explicitInstanceFieldContracts(tree, parser);

    const PRIMITIVE_TYPES = new Set(['int', 'float', 'str', 'bool', 'bytes', 'list', 'dict', 'set', 'tuple', 'None', 'Any', 'object']);
    const conditionalFieldType = (node, parameterAlternatives) => {
        let current = node;
        while (current?.type === 'parenthesized_expression' &&
            current.namedChildCount === 1) {
            current = current.namedChild(0);
        }
        if (current?.type !== 'conditional_expression' ||
            current.namedChildCount < 3) return null;
        const consequence = current.namedChild(0);
        const condition = current.namedChild(1);
        const alternative = current.namedChild(2);
        const parameterBranches = [consequence, alternative]
            .map((branch, index) => branch?.type === 'identifier' &&
                parameterAlternatives.has(branch.text)
                ? { index, name: branch.text } : null)
            .filter(Boolean);
        if (parameterBranches.length !== 1) return null;
        const parameterBranch = parameterBranches[0];
        const positiveTypes = isinstanceTypes(condition, parameterBranch.name);
        if (positiveTypes.length === 0) return null;
        const declaredTypes = parameterAlternatives.get(parameterBranch.name);
        const narrowedTypes = parameterBranch.index === 0
            ? declaredTypes.filter(type => positiveTypes.includes(type))
            : declaredTypes.filter(type => !positiveTypes.includes(type));
        if (narrowedTypes.length !== 1) return null;

        const valueBranch = parameterBranch.index === 0
            ? alternative : consequence;
        if (valueBranch?.type !== 'call') return null;
        const callable = valueBranch.childForFieldName('function');
        let valueType = null;
        if (callable?.type === 'identifier' && /^[A-Z]/.test(callable.text) &&
            !isPythonConstructorValueShadowedAt(callable, callable.text)) {
            valueType = callable.text;
        } else if (callable?.type === 'attribute') {
            const owner = callable.childForFieldName('object');
            const method = callable.childForFieldName('attribute');
            if (owner?.type === 'identifier' && method?.type === 'identifier' &&
                !isPythonNameShadowedAt(callable, owner.text)) {
                valueType = options.resolveCallType?.(owner.text, method.text);
            }
        }
        return valueType === narrowedTypes[0] ? valueType : null;
    };

    traverseTree(tree.rootNode, (node) => {
        if (node.type !== 'class_definition') {
            return node.type !== 'expression_statement' && !FIELD_CONTRACT_VALUE_NODES.has(node.type);
        }

        const classNameNode = node.childForFieldName('name');
        if (!classNameNode) return true;
        const className = classNameNode.text;

        const body = node.childForFieldName('body');
        if (!body) return false;

        const attrTypes = new Map();
        const attrOrigins = new Map();
        Object.defineProperty(attrTypes, 'origins', { value: attrOrigins });
        const externalFlows = new Map();
        Object.defineProperty(attrTypes, 'externalFlows', { value: externalFlows });
        // Lines of the writes that typed each field (fix #381): a class name
        // resolves where it is written, so a function-local class assigned
        // to self.x names that local class, not a same-name module class.
        const typeWrites = new Map();
        const writeLines = new Map();
        Object.defineProperty(attrTypes, 'writeLines', { value: writeLines });
        const noteTypeWrite = (field, type, node) => {
            if (!typeWrites.has(field)) typeWrites.set(field, []);
            typeWrites.get(field).push({ type, line: node.startPosition.row + 1 });
        };
        for (const [field, contract] of explicitContracts.get(className) || []) {
            if (contract.type) attrTypes.set(field, contract.type);
        }
        const methodReturns = new Map();
        const memberDefs = pythonClassBodyDefs(body);
        for (let member of memberDefs) {
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
        for (let child of memberDefs) {
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
            const paramAlternatives = new Map();
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
                            const directAlternatives = typeNamesFromAnnotation(pType);
                            const aliasAlternatives = directAlternatives.length === 1
                                ? options.resolveTypeAliasMembers?.(
                                    directAlternatives[0])
                                : null;
                            const alternatives = aliasAlternatives?.length > 1
                                ? aliasAlternatives : directAlternatives;
                            if (alternatives.length > 1) {
                                paramAlternatives.set(pName.text, alternatives);
                            }
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

                const typeName = conditionalFieldType(rhs, paramAlternatives) ||
                    extractConstructorName(rhs);
                if (typeName) {
                    attrTypes.set(attrName, typeName);
                    noteTypeWrite(attrName, typeName, assign);
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
                    noteTypeWrite(attrName, paramTypes.get(rhs.text), assign);
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
        const runtimeFieldWrites = new Map();
        const externalFieldWrites = new Map();
        const invalidRuntimeFields = new Set();
        for (let member of memberDefs) {
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
                if (!['assignment', 'augmented_assignment'].includes(assignment?.type)) return true;
                const left = assignment.childForFieldName('left');
                const field = left?.type === 'attribute' &&
                    left.childForFieldName('object')?.text === 'self'
                    ? left.childForFieldName('attribute')?.text : null;
                if (!field) return true;
                let enclosing = assignment.parent;
                while (enclosing && !['function_definition', 'lambda', 'class_definition'].includes(enclosing.type)) enclosing = enclosing.parent;
                if (assignment.type !== 'assignment' || !sameNode(enclosing, member)) {
                    invalidRuntimeFields.add(field);
                    return true;
                }
                const right = assignment.childForFieldName('right');
                const callable = right?.type === 'call'
                    ? right.childForFieldName('function') : null;
                const callableReceiver = callable?.type === 'attribute'
                    ? callable.childForFieldName('object') : null;
                const directConstructor = callable?.type === 'identifier' &&
                    /^[A-Z]/.test(callable.text) &&
                    !isPythonConstructorValueShadowedAt(callable, callable.text)
                    ? callable.text : null;
                const moduleName = callableReceiver?.type === 'identifier'
                    ? callableReceiver.text : null;
                const functionName = callable?.type === 'attribute'
                    ? callable.childForFieldName('attribute')?.text : null;
                const resolveCallType = options.resolveCallType ||
                    options.resolveBuiltinCallType;
                const literalType = right && ['dictionary', 'dictionary_comprehension', 'list',
                    'list_comprehension', 'set', 'set_comprehension', 'tuple'].includes(right.type)
                    ? PY_LITERAL_RECEIVER_TYPES[right.type] : null;
                const importedCall = callable?.type === 'identifier' &&
                    !isPythonNameShadowedAt(callable, callable.text)
                    ? options.resolveImportedCallType?.(callable.text) : null;
                const runtimeType = literalType || importedCall?.type || directConstructor ||
                    (moduleName && functionName &&
                        !isPythonNameShadowedAt(callable, moduleName)
                        ? resolveCallType?.(moduleName, functionName)
                        : null);
                let producer = right, depth = 0;
                while (producer?.type === 'call') {
                    depth++;
                    producer = producer.childForFieldName('function');
                }
                const factoryPath = producer?.type === 'attribute' &&
                    producer.childForFieldName('object')?.type === 'identifier'
                    ? [producer.childForFieldName('object').text, producer.childForFieldName('attribute')?.text]
                    : producer?.type === 'identifier' ? [producer.text] : null;
                const externalFactory = !runtimeType && depth > 0 && depth <= 3 && factoryPath?.every(Boolean) &&
                    !isPythonNameShadowedAt(producer, factoryPath[0])
                    ? options.resolveExternalFactory?.(factoryPath) : null;
                if (externalFactory) {
                    if (!externalFieldWrites.has(field)) externalFieldWrites.set(field, []);
                    externalFieldWrites.get(field).push({ ...externalFactory, path: factoryPath, depth,
                        assignment: typeOrigin('field', assignment), expression: typeOrigin('field', right) });
                    return true;
                }
                if (!runtimeType) {
                    // None is a harmless uninitialized state; any other
                    // unknown write could replace the field with a project
                    // value and therefore invalidates exclusion-grade flow.
                    if (right?.type !== 'none') invalidRuntimeFields.add(field);
                    return true;
                }
                if (!runtimeFieldTypes.has(field)) runtimeFieldTypes.set(field, new Set());
                runtimeFieldTypes.get(field).add(runtimeType);
                if (directConstructor && runtimeType === directConstructor) {
                    noteTypeWrite(field, runtimeType, assignment);
                }
                if (!runtimeFieldWrites.has(field)) runtimeFieldWrites.set(field, []);
                runtimeFieldWrites.get(field).push({ type: runtimeType,
                    assignment: typeOrigin('field', assignment), expression: typeOrigin('field', right),
                    ...(literalType ? { literal: right.type } : importedCall ? { importedCall } : { legacy: true }) });
                return true;
            });
        }
        for (const [field, assignments] of externalFieldWrites) {
            if (!invalidRuntimeFields.has(field) && !runtimeFieldTypes.has(field) && !attrTypes.has(field) &&
                new Set(assignments.map(write => `${write.module}.${write.producer}:${write.depth}`)).size === 1) {
                externalFlows.set(field, { field, assignments });
            }
        }
        for (const [field, types] of runtimeFieldTypes) {
            if (invalidRuntimeFields.has(field) || types.size !== 1) continue;
            const type = [...types][0];
            if (!attrTypes.has(field) || attrTypes.get(field) === type) {
                attrTypes.set(field, type);
                const assignments = runtimeFieldWrites.get(field);
                if (assignments.every(write => !write.legacy)) {
                    attrOrigins.set(field, { assignments });
                }
            }
        }

        for (const [field, writes] of typeWrites) {
            const lines = writes.filter(write => write.type === attrTypes.get(field))
                .map(write => write.line);
            if (lines.length > 0) writeLines.set(field, [...new Set(lines)].sort((a, b) => a - b));
        }
        if (attrTypes.size > 0 || externalFlows.size > 0) {
            result.set(className, attrTypes);
        }

        return false; // don't descend into nested classes from traverseTree
    });

    return result;
}

const PY_STORE_CONTAINERS = new Set(['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list',
    'parenthesized_expression', 'list_splat_pattern', 'list_splat', 'expression_list']);

/** Whether an attribute node is written (assigned, deleted, a loop or
 * `with ... as` target), not read. */
function isPythonStoreTarget(node) {
    let target = node;
    while (target.parent && PY_STORE_CONTAINERS.has(target.parent.type)) target = target.parent;
    const parent = target.parent;
    if (!parent) return false;
    switch (parent.type) {
        case 'assignment':
        case 'augmented_assignment':
        case 'for_statement':
        case 'for_in_clause':
            return sameNode(parent.childForFieldName('left'), target);
        case 'as_pattern_target':
        case 'delete_statement':
            return true;
        default:
            return false;
    }
}

/**
 * What a class body does to its instance fields (fix #402): the class
 * members it declares (defs, class-level assignments, nested classes,
 * through compound statements), the fields its methods write on the
 * instance or class (`self.x = ..`, `cls.x = ..`, augmented, deleted, loop
 * and `with ... as` targets, nested functions included), and whether it
 * writes fields dynamically (`setattr(self, ..)`, `self.__dict__`,
 * `vars(self)`). Null when no class is declared at `line`.
 */
function findClassFieldFacts(tree, line, name) {
    if (!tree) return null;
    const row = line - 1;
    let classNode = null;
    const stack = [tree.rootNode];
    while (stack.length > 0 && !classNode) {
        const node = stack.pop();
        if (node.startPosition.row > row || node.endPosition.row < row) continue;
        if (node.type === 'class_definition') {
            const nameNode = node.childForFieldName('name');
            const start = node.parent?.type === 'decorated_definition' ? node.parent : node;
            if (nameNode?.text === name && (start.startPosition.row === row || node.startPosition.row === row ||
                nameNode.startPosition.row === row)) { classNode = node; break; }
        }
        for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push(node.namedChild(i));
    }
    const body = classNode?.childForFieldName('body');
    if (!body) return null;
    const members = new Set();
    const receivers = new Set(['self', 'cls']);
    const addTargets = target => {
        if (!target) return;
        if (target.type === 'identifier') { members.add(target.text); return; }
        if (PY_STORE_CONTAINERS.has(target.type)) {
            for (let i = 0; i < target.namedChildCount; i++) addTargets(target.namedChild(i));
        }
    };
    const visitBody = container => {
        for (let i = 0; i < container.namedChildCount; i++) {
            const child = container.namedChild(i);
            const definition = child.type === 'decorated_definition' ? child.childForFieldName('definition') : child;
            if (definition?.type === 'function_definition' || definition?.type === 'class_definition') {
                const declared = definition.childForFieldName('name')?.text;
                if (declared) members.add(declared);
                if (definition.type === 'function_definition') {
                    const params = definition.childForFieldName('parameters');
                    const first = params?.namedChild(0);
                    const firstName = first?.type === 'identifier' ? first.text
                        : (first?.childForFieldName?.('name') || first?.namedChild(0))?.text;
                    if (firstName) receivers.add(firstName);
                }
                continue;
            }
            if (child.type === 'expression_statement') {
                for (let j = 0; j < child.namedChildCount; j++) {
                    const expression = child.namedChild(j);
                    if (expression.type === 'assignment' || expression.type === 'augmented_assignment') {
                        addTargets(expression.childForFieldName('left'));
                    }
                }
                continue;
            }
            if (PY_CLASS_BODY_COMPOUNDS.has(child.type)) visitBody(child);
        }
    };
    visitBody(body);
    const written = new Set();
    let dynamic = false;
    let nestedClassEnd = -1;
    for (const node of body.descendantsOfType(['class_definition', 'attribute', 'call'])) {
        if (node.startIndex < nestedClassEnd) continue;
        if (node.type === 'class_definition') {
            nestedClassEnd = node.endIndex;
            continue;
        }
        if (node.type === 'attribute') {
            const object = node.childForFieldName('object');
            const attribute = node.childForFieldName('attribute');
            if (object?.type === 'identifier' && receivers.has(object.text) && attribute) {
                if (attribute.text === '__dict__') dynamic = true;
                else if (isPythonStoreTarget(node)) written.add(attribute.text);
            }
        } else if (node.type === 'call') {
            const fn = node.childForFieldName('function');
            const first = node.childForFieldName('arguments')?.namedChild(0);
            if (fn?.type === 'identifier' && (fn.text === 'setattr' || fn.text === 'vars' ||
                fn.text === 'delattr') && first?.type === 'identifier' && receivers.has(first.text)) dynamic = true;
        }
    }
    return { members, written, dynamic };
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


// Bases every class may name without bringing a constructor or a test.
const PYTHON_PLAIN_BASES = new Set(['object', 'ABC', 'Generic', 'Protocol']);
// Statements whose blocks run only sometimes.
const PY_BRANCHING = new Set(['if_statement', 'elif_clause', 'else_clause', 'try_statement', 'except_clause',
    'except_group_clause', 'finally_clause', 'with_statement', 'for_statement', 'while_statement',
    'match_statement', 'case_clause']);
// What stops a test before its body runs: pytest's and unittest's own
// names for skipping, leaving, failing and marking, wherever a setup, a
// fixture or a hook mentions one.
const PY_STOPPING_NAMES = new Set(['skip', 'skipTest', 'SkipTest', 'importorskip', 'xfail', 'exit', 'fail',
    'deselect', 'add_marker', 'applymarker', 'shouldstop', 'shouldfail', 'Skipped', 'Exit', 'getfixturevalue']);
const PY_STOPPING_PATHS = /^(pytest\.(skip|importorskip|exit|xfail|fail)|unittest\.(case\.)?SkipTest|_pytest\.outcomes\.\w+|nose\.SkipTest)(\.|$)/;
// Names through which a module's or a class's names are written without
// an assignment to them.
const PY_NAMESPACE_NAMES = new Set(['globals', 'vars', 'locals', 'setattr', 'exec', 'eval', '__dict__', '__setattr__']);
const PY_FIXTURE_PATHS = new Set(['pytest.fixture', 'pytest.yield_fixture', 'pytest_asyncio.fixture']);
const PY_ABSTRACT_PATHS = new Set(['abc.abstractmethod', 'abc.abstractproperty', 'abc.abstractclassmethod',
    'abc.abstractstaticmethod']);
// Functions the runner calls by their names before the tests of a module
// or of a class.
const PY_MODULE_SETUPS = new Set(['setup_module', 'setup_function', 'setUpModule']);
const PY_CLASS_SETUPS = new Set(['setup_class', 'setup_method', 'setUp', 'setUpClass', 'asyncSetUp', 'setup']);
// pytest hooks called for one test or one collected node: one in a
// conftest.py holds for what is collected below that file. Every other
// hook is called once for the whole run, whichever conftest.py has it.
const PYTEST_NODE_HOOKS = new Set(['pytest_runtest_protocol', 'pytest_runtest_logstart', 'pytest_runtest_logfinish',
    'pytest_runtest_setup', 'pytest_runtest_call', 'pytest_runtest_teardown', 'pytest_runtest_makereport',
    'pytest_pyfunc_call', 'pytest_collect_file', 'pytest_collect_directory', 'pytest_ignore_collect',
    'pytest_pycollect_makemodule', 'pytest_pycollect_makeitem', 'pytest_generate_tests', 'pytest_itemcollected',
    'pytest_collectstart', 'pytest_make_collect_report', 'pytest_collectreport', 'pytest_fixture_setup',
    'pytest_fixture_post_finalizer', 'pytest_make_parametrize_id']);
// pytest hooks whose return value only words a report.
const PYTEST_REPORTING_HOOKS = new Set(['pytest_report_header', 'pytest_report_collectionfinish',
    'pytest_report_teststatus', 'pytest_make_parametrize_id', 'pytest_assertrepr_compare',
    'pytest_report_to_serializable', 'pytest_report_from_serializable']);
// What a hook may call on the objects pytest hands it without changing
// what is collected or run; the second set gives back another such object.
const PYTEST_HOOK_READS = new Set(['getoption', 'getini', 'getvalue', 'addoption', 'addini', 'getgroup',
    'addinivalue_line', 'get_closest_marker', 'iter_markers', 'write_line', 'write_sep', 'write', 'section',
    'startswith', 'endswith', 'hasplugin', 'has_plugin', 'getplugin', 'get_plugin', 'is_registered', 'isatty']);
const PYTEST_HOOK_OBJECTS = new Set(['getgroup', 'get_closest_marker', 'iter_markers', 'getplugin', 'get_plugin']);
const PY_TRUTH_TESTS = new Set(['if_statement', 'elif_clause', 'while_statement', 'not_operator', 'boolean_operator',
    'comparison_operator', 'conditional_expression', 'assert_statement', 'expression_statement']);
// Values that are no function and no class, whatever name holds them.
const PY_PLAIN_VALUES = new Set(['none', 'true', 'false', 'integer', 'float', 'string', 'concatenated_string',
    'list', 'tuple', 'dictionary', 'set', 'list_comprehension', 'dictionary_comprehension', 'set_comprehension',
    'generator_expression', 'ellipsis']);

/**
 * What a Python file declares for pytest (measured on pytest 9), read from
 * this file alone: what the names of the module and of its classes are
 * bound to once the module has run. Who collects what is settled where
 * the files are put together (core/test-units.js), because a class runs
 * the tests of the classes it derives from, a module runs the tests it
 * imports, and a conftest.py decides for the modules beside it.
 *
 * Every write to a name counts, read from the syntax tree in the order
 * the module runs: the last write that always runs decides, together with
 * every later one that runs only sometimes (in a branch, a loop, a try).
 * Of two definitions the last is the one that exists; a definition
 * followed by `name = None` or `del name` is gone; one inside a branch
 * exists only sometimes. A name bound to another name of the module (an
 * alias) or to a lambda is one more test, listed; a test-shaped name bound
 * to anything else that could be a function or a class, a star import of
 * a module that is not read, and code that writes the module's names
 * through globals(), setattr and the like leave tests this does not list
 * (`inheriting`: the file's count is a lower bound).
 *
 * `__test__` is read as pytest reads it: false switches a module, a class
 * (and every class deriving from it) or a function off; the literal True
 * makes a class or a function a test whatever it is called; a value that
 * is not a literal leaves both open (`enabled`, `forced`: 'unknown'). A
 * write of it that is none of the forms read (through another name, a
 * string, a function) leaves every switch of the file open.
 *
 * A decorator is read by what it is imported as: pytest's and unittest's
 * marks (skip: declared and not executed; skipif: sometimes; xfail with
 * run=False: not executed; an empty parametrize: not executed), the
 * fixtures a test asks for by usefixtures, unittest.mock's patches
 * (nothing changes), a name of this file bound once to one of pytest's
 * marks. Any other decorator may do anything: the test is conditional.
 *
 * Code that runs before a test's body can stop it: the module's own
 * statements (pytest.importorskip, pytest.skip, a raise, a function of
 * the module that does one of these, outside `if __name__ == "__main__"`),
 * setup functions (setup_module, setUp, ...), fixtures and, in a
 * conftest.py or a plugin module, hooks. `runtime` says what this file
 * does as a plugin: whether one of its hooks can change what is collected
 * or run (it mentions a stopping name, raises, yields, returns a value
 * where the value decides, or uses what pytest hands it other than by the
 * few calls that only read), whether such a hook is one pytest calls
 * once for the whole run (`everywhere`) and not for one test, which
 * fixtures it defines and whether each can stop a test, and which modules
 * it loads as plugins. A setup, a fixture or the module itself that calls
 * a function of another module of the project names the call (`calls`,
 * `guardCalls`, `skipCalls`), and `stopping` names the module's own
 * functions that can stop a test: the two are matched where the files are
 * put together, one module deep (`runtime.hookCalls` for hooks).
 *
 * "classes" says, for every class, what it derives from and which
 * test-shaped members it declares; "functions" every function of the
 * module's top; "imports" the names it takes from other modules or binds
 * to other names of its own; "marks" pytest's marks by name, for the
 * runner's mark expression. A module whose name is outside python_files
 * is not collected: it declares for others and has no test of its own.
 */
function testUnits(fileEntry, helpers) {
    const collection = helpers.collection || {};
    const matches = (patterns, fallback, name) => (patterns && patterns.length > 0 ? patterns : fallback)
        .some(pattern => /[*?[]/.test(pattern) ? helpers.glob(pattern, name) : name.startsWith(pattern));
    const functionNamed = name => matches(collection.functions, ['test'], name);
    const classNamed = name => matches(collection.classes, ['Test'], name);
    const symbols = fileEntry.symbols || [];
    const tree = helpers.tree();
    if (!tree) return null;
    const root = tree.rootNode;

    // What an imported name stands for: "from unittest import TestCase as
    // Base" makes Base the TestCase of unittest.
    const imported = new Map();
    for (const binding of fileEntry.importBindings || []) {
        imported.set(binding.alias || binding.name, binding);
    }
    const inProject = moduleName => !!(fileEntry.moduleResolved || {})[moduleName];
    const origin = written => {
        const parts = String(written).split('.');
        const binding = imported.get(parts[0]);
        if (!binding) return { name: parts[parts.length - 1], module: null, bound: false };
        if (binding.kind !== 'import') {
            return { name: parts.length > 1 ? parts[parts.length - 1] : binding.name, module: binding.module, bound: true };
        }
        return { name: parts[parts.length - 1], module: [binding.module, ...parts.slice(1, -1)].join('.'), bound: true };
    };
    const basesOf = cls => (Array.isArray(cls.extends) ? cls.extends : String(cls.extends || '').split(','))
        .map(base => String(base).trim()).filter(base => base && base !== 'object');
    const holds = (cls, symbol) => symbol.className === cls.name && symbol.startLine >= cls.startLine &&
        (symbol.endLine ?? symbol.startLine) <= (cls.endLine ?? cls.startLine);

    // ---- the writes of the module and of each class body, in order ----
    const dotted = node => {
        if (!node) return null;
        if (node.type === 'identifier') return node.text;
        if (node.type !== 'attribute') return null;
        const object = dotted(node.childForFieldName('object'));
        const attribute = node.childForFieldName('attribute');
        return object && attribute ? `${object}.${attribute.text}` : null;
    };
    const scopeWrites = new Map(); // 'module' or a class node's id -> name -> writes
    const attributeWrites = new Map(); // '<scope>\0<name>' -> writes of <name>.__test__ in that scope
    const definitions = new Map(); // row of a def's or class's name -> { node, straight, scope }
    const accounted = new Set(); // start offsets of the __test__ and pytestmark names read as writes
    const stars = []; // modules whose every name the module takes
    const note = (scope, name, write) => {
        if (!scopeWrites.has(scope)) scopeWrites.set(scope, new Map());
        const names = scopeWrites.get(scope);
        if (!names.has(name)) names.set(name, []);
        names.get(name).push(write);
    };
    const targetsOf = (node, out = []) => {
        if (!node) return out;
        if (node.type === 'identifier') out.push(node);
        else if (node.type !== 'attribute' && node.type !== 'subscript') {
            for (const child of node.namedChildren) targetsOf(child, out);
        }
        return out;
    };
    const visitExpression = (node, scope, straight) => {
        if (!node) return;
        if (node.type === 'assignment' || node.type === 'augmented_assignment') {
            const left = node.childForFieldName('left');
            let value = node.childForFieldName('right');
            // a = b = value: every target gets the last value.
            while (value && value.type === 'assignment') {
                visitExpression(value, scope, straight);
                value = value.childForFieldName('right');
            }
            const kind = node.type === 'augmented_assignment' ? 'augment' : value ? 'assign' : 'annotation';
            const write = {
                kind, value: kind === 'assign' ? value : null, straight, pos: node.startIndex,
                line: node.startPosition.row + 1, endLine: node.endPosition.row + 1,
            };
            if (left && left.type === 'identifier') {
                if (kind !== 'annotation') {
                    note(scope, left.text, write);
                    accounted.add(left.startIndex);
                }
            } else if (left && left.type === 'attribute') {
                const object = left.childForFieldName('object');
                const attribute = left.childForFieldName('attribute');
                if (object && object.type === 'identifier' && attribute && attribute.text === '__test__') {
                    const key = `${scope}\0${object.text}`;
                    if (!attributeWrites.has(key)) attributeWrites.set(key, []);
                    attributeWrites.get(key).push(write);
                    accounted.add(attribute.startIndex);
                }
            } else {
                for (const target of targetsOf(left)) note(scope, target.text, { ...write, kind: 'other', value: null });
            }
            return;
        }
        if (node.type === 'named_expression') {
            const name = node.childForFieldName('name');
            if (name) note(scope, name.text, { kind: 'other', value: null, straight, pos: node.startIndex });
        }
    };
    const visitStatement = (statement, scope, straight) => {
        let node = statement;
        if (node.type === 'decorated_definition') node = node.childForFieldName('definition') || node;
        if (node.type === 'function_definition' || node.type === 'class_definition') {
            const name = node.childForFieldName('name');
            if (!name) return;
            const kind = node.type === 'class_definition' ? 'class' : 'def';
            note(scope, name.text, { kind, value: null, straight, pos: statement.startIndex, node });
            definitions.set(name.startPosition.row, { node, straight, scope, pos: statement.startIndex, holder: statement });
            if (kind === 'class') {
                const body = node.childForFieldName('body');
                for (const child of body ? body.namedChildren : []) visitStatement(child, node.id, true);
            }
            return;
        }
        if (node.type === 'expression_statement') {
            for (const child of node.namedChildren) visitExpression(child, scope, straight);
            return;
        }
        if (node.type === 'import_statement' || node.type === 'import_from_statement') {
            for (const part of node.namedChildren) {
                if (part.type === 'wildcard_import') {
                    const from = node.childForFieldName('module_name');
                    if (from && scope === 'module') stars.push({ module: from.text, line: node.startPosition.row + 1, straight });
                    continue;
                }
                if (node.type === 'import_from_statement' && sameNode(part, node.childForFieldName('module_name'))) continue;
                const bound = part.type === 'aliased_import' ? part.childForFieldName('alias')
                    : part.type === 'dotted_name' ? (node.type === 'import_statement' ? part.namedChild(0)
                        : part.namedChild(part.namedChildCount - 1)) : null;
                if (bound) note(scope, bound.text, { kind: 'import', value: null, straight, pos: node.startIndex, line: node.startPosition.row + 1 });
            }
            return;
        }
        if (node.type === 'delete_statement') {
            for (const target of targetsOf(node)) {
                note(scope, target.text, { kind: 'del', value: null, straight, pos: node.startIndex });
                accounted.add(target.startIndex);
            }
            return;
        }
        if (!PY_BRANCHING.has(node.type) && node.type !== 'block') return;
        if (node.type === 'for_statement') {
            for (const target of targetsOf(node.childForFieldName('left'))) {
                note(scope, target.text, { kind: 'other', value: null, straight: false, pos: node.startIndex });
            }
        }
        for (const child of node.namedChildren) {
            if (child.type === 'block') {
                for (const inner of child.namedChildren) visitStatement(inner, scope, false);
            } else if (PY_BRANCHING.has(child.type)) {
                visitStatement(child, scope, false);
            } else if (child.type === 'as_pattern' || child.type === 'with_clause') {
                // with ... as name, except ... as name
                const walk = part => {
                    if (part.type === 'as_pattern_target') {
                        for (const target of targetsOf(part)) {
                            note(scope, target.text, { kind: 'other', value: null, straight: false, pos: part.startIndex });
                        }
                        return;
                    }
                    for (const next of part.namedChildren) walk(next);
                };
                walk(child);
            }
        }
    };
    for (const statement of root.namedChildren) visitStatement(statement, 'module', true);
    const writesOf = (scope, name) => (scopeWrites.get(scope) || new Map()).get(name) || [];
    /** The writes that may be the last: the last one that always runs, and every later one. */
    const candidatesOf = writes => {
        if (!writes || writes.length === 0) return [];
        let last = -1;
        writes.forEach((write, i) => {
            if (write.straight) last = i;
        });
        return last === -1 ? [null, ...writes] : writes.slice(last);
    };
    /** The one write a name has for certain, or null. */
    const settled = (scope, name) => {
        const candidates = candidatesOf(writesOf(scope, name));
        return candidates.length === 1 && candidates[0] ? candidates[0] : null;
    };
    /**
     * The full path a written name stands for: by the file's imports, and
     * through the names of the module bound once to such a name.
     */
    const pathOf = (written, depth = 0) => {
        const parts = String(written).split('.');
        const binding = imported.get(parts[0]);
        if (binding) {
            if (binding.kind === 'import') return [binding.module, ...parts.slice(1)].join('.');
            return [binding.module, binding.name, ...parts.slice(1)].join('.');
        }
        const write = depth < 4 ? settled('module', parts[0]) : null;
        const target = write && write.kind === 'assign' ? dotted(write.value) : null;
        return target ? pathOf([target, ...parts.slice(1)].join('.'), depth + 1) : null;
    };
    const unwrapped = node => {
        let current = node;
        while (current && current.type === 'parenthesized_expression') current = current.namedChildren[0];
        return current;
    };
    const truthOf = node => {
        const value = unwrapped(node);
        if (!value) return null;
        switch (value.type) {
            case 'true': return true;
            case 'false': case 'none': return false;
            case 'integer': case 'float': return Number(value.text.replace(/_/g, '')) !== 0;
            case 'string': return value.namedChildren.some(child => child.type === 'interpolation') ? null
                : value.namedChildren.some(child => child.type === 'string_content');
            default: return null;
        }
    };
    const stringOf = node => {
        const value = unwrapped(node);
        if (!value || value.type !== 'string' || value.namedChildren.some(child => child.type === 'interpolation')) return null;
        return value.namedChildren.filter(child => child.type === 'string_content').map(child => child.text).join('');
    };
    /** A written-out list or tuple, or what a name of the module bound once to one holds. */
    const sequenceOf = (node, depth = 0) => {
        const value = unwrapped(node);
        if (!value) return null;
        if (value.type === 'list' || value.type === 'tuple') return value;
        if (value.type === 'identifier' && depth < 4 && !imported.has(value.text)) {
            const write = settled('module', value.text);
            return write && write.kind === 'assign' ? sequenceOf(write.value, depth + 1) : null;
        }
        return null;
    };
    const UNSET = Symbol('unset');
    const OPEN_SWITCH = Object.freeze({ on: 'unknown', forced: 'unknown' });
    /**
     * What `__test__` is once its scope has run: `on` (true, false,
     * 'unknown') and `forced` (it is the literal True: pytest takes the
     * class or function whatever it is called). Undefined: never written.
     */
    const switchValue = writes => {
        const candidates = candidatesOf(writes);
        if (candidates.length === 0) return undefined;
        const values = candidates.map(write => {
            if (write === null || write.kind === 'del') return UNSET;
            const truth = write.kind === 'assign' ? truthOf(write.value) : null;
            if (truth == null) return OPEN_SWITCH;
            return { on: truth, forced: truth && unwrapped(write.value).type === 'true' };
        });
        if (values.every(value => value === UNSET)) return undefined;
        if (values.some(value => value === UNSET)) return OPEN_SWITCH;
        const same = key => values.every(value => value[key] === values[0][key]) ? values[0][key] : 'unknown';
        return { on: same('on'), forced: same('forced') };
    };

    // Any use of the two names that is none of the writes read, a string
    // that spells one: nothing about them is settled.
    let switchUnsettled = false;
    let marksUnsettled = false;
    const scan = node => {
        if (node.type === 'identifier' && !accounted.has(node.startIndex)) {
            if (node.text === '__test__') switchUnsettled = true;
            else if (node.text === 'pytestmark') marksUnsettled = true;
        } else if (node.type === 'string_content') {
            if (node.text === '__test__') switchUnsettled = true;
            else if (node.text === 'pytestmark') marksUnsettled = true;
        }
        for (const child of node.namedChildren) scan(child);
    };
    if (/__test__|pytestmark/.test(root.text)) scan(root);
    // A switch written on a name is read only where the name is one
    // definition or one import of its scope: any other object is not followed.
    for (const key of attributeWrites.keys()) {
        const [scope, name] = key.split('\0');
        const scopeKey = scope === 'module' ? 'module' : Number(scope);
        const writes = writesOf(scopeKey, name);
        if (writes.length !== 1 || !['def', 'class', 'import'].includes(writes[0].kind)) switchUnsettled = true;
    }
    const attributeSwitch = (scope, name) => switchValue(attributeWrites.get(`${scope}\0${name}`));

    // ---- decorators and marks ----
    const NOTHING = Object.freeze({ skip: null, marks: [], open: false, fixtures: [], fixturesOpen: false });
    const UNREAD_MARK = Object.freeze({ skip: 'sometimes', marks: [], open: true, unread: true, fixtures: [], fixturesOpen: false });
    const keywordOf = (call, name) => {
        const args = call.childForFieldName('arguments');
        for (const argument of args ? args.namedChildren : []) {
            if (argument.type !== 'keyword_argument') continue;
            const key = argument.childForFieldName('name');
            if (key && key.text === name) return argument.childForFieldName('value');
        }
        return null;
    };
    const positional = call => {
        const args = call.childForFieldName('arguments');
        return (args ? args.namedChildren : []).filter(argument => argument.type !== 'keyword_argument' && argument.type !== 'comment');
    };
    const mentionsMarks = node => (node.type === 'keyword_argument' && node.childForFieldName('name')?.text === 'marks') ||
        node.namedChildren.some(mentionsMarks);
    const plainMark = (name, extra = {}) => ({ skip: null, marks: [name], open: false, fixtures: [], fixturesOpen: false, ...extra });
    /** What one decorator, or one value of pytestmark, is. */
    const readMark = (expression, depth = 0) => {
        if (!expression) return UNREAD_MARK;
        const call = expression.type === 'call' ? expression : null;
        const written = dotted(call ? call.childForFieldName('function') : expression);
        if (!written) {
            // pytest.mark.skip(reason=...)(function): a call of a call.
            return call && depth < 4 ? readMark(call.childForFieldName('function'), depth + 1) : UNREAD_MARK;
        }
        const path = imported.has(written.split('.')[0]) ? pathOf(written) : null;
        if (path) {
            const mark = /^pytest\.mark\.(\w+)$/.exec(path);
            if (mark) {
                if (mark[1] === 'skip') return plainMark('skip', { skip: 'skip' });
                if (mark[1] === 'skipif') return plainMark('skipif', { skip: 'sometimes' });
                if (mark[1] === 'xfail') {
                    const run = call ? keywordOf(call, 'run') : null;
                    const truth = run ? truthOf(run) : true;
                    return plainMark('xfail', { skip: truth === false ? 'skip' : truth == null ? 'sometimes' : null });
                }
                if (mark[1] === 'parametrize') {
                    // No value to run with: pytest skips the test. A list
                    // that is not written out may be empty.
                    const given = call ? keywordOf(call, 'argvalues') || positional(call)[1] : null;
                    const values = sequenceOf(given);
                    const skip = !call || !given ? 'sometimes'
                        : !values ? 'sometimes'
                            : values.namedChildren.filter(item => item.type !== 'comment').length === 0 ? 'skip' : null;
                    return plainMark('parametrize', { skip, open: !!call && mentionsMarks(call) });
                }
                if (mark[1] === 'usefixtures') {
                    const names = call ? positional(call).map(stringOf) : [];
                    return plainMark('usefixtures', {
                        fixtures: names.filter(name => name != null),
                        fixturesOpen: !call ? false : names.some(name => name == null),
                    });
                }
                return plainMark(mark[1]);
            }
            if (PY_FIXTURE_PATHS.has(path)) return { ...NOTHING, fixture: true };
            if (path === 'unittest.skip') return { ...NOTHING, skip: 'skip' };
            if (path === 'unittest.skipIf' || path === 'unittest.skipUnless') return { ...NOTHING, skip: 'sometimes' };
            if (path === 'unittest.expectedFailure') return NOTHING;
            if (/^unittest\.mock\.patch(\.(object|dict|multiple))?$/.test(path)) return NOTHING;
            if (PY_ABSTRACT_PATHS.has(path) || path === 'functools.wraps' || path === 'typing.override' ||
                path === 'typing_extensions.override') return NOTHING;
            return UNREAD_MARK;
        }
        if ((written === 'staticmethod' || written === 'classmethod' || written === 'property') &&
            writesOf('module', written).length === 0) {
            return NOTHING;
        }
        // A name of this module bound once, to one of pytest's marks.
        const write = written.includes('.') ? null : settled('module', written);
        if (write && write.kind === 'assign' && depth < 4) {
            const inner = readMark(write.value, depth + 1);
            if (!inner.unread && !inner.fixture) return inner;
        }
        return UNREAD_MARK;
    };
    const combine = parts => ({
        skip: parts.some(part => part.skip === 'skip') ? 'skip' : parts.some(part => part.skip === 'sometimes') ? 'sometimes' : null,
        marks: [...new Set(parts.flatMap(part => part.marks))],
        open: parts.some(part => part.open),
        fixtures: [...new Set(parts.flatMap(part => part.fixtures || []))],
        fixturesOpen: parts.some(part => part.fixturesOpen),
        ...(parts.some(part => part.fixture) && { fixture: true }),
    });
    const marksOfValue = node => {
        if (!node) return UNREAD_MARK;
        if (node.type === 'list' || node.type === 'tuple' || node.type === 'parenthesized_expression') {
            return combine(node.namedChildren.map(marksOfValue));
        }
        return readMark(node);
    };
    /** What pytestmark is in a scope once it has run. */
    const marksOf = scope => {
        const candidates = candidatesOf(writesOf(scope, 'pytestmark'));
        if (candidates.length === 0) return NOTHING;
        if (candidates.length === 1 && candidates[0] && candidates[0].kind === 'assign') return marksOfValue(candidates[0].value);
        const parts = candidates.map(write => write && write.kind === 'assign' ? marksOfValue(write.value) : NOTHING);
        return { ...combine(parts), skip: 'sometimes', open: true, fixturesOpen: true };
    };
    const decoratorsOf = info => {
        const holder = info && info.node.parent && info.node.parent.type === 'decorated_definition' ? info.node.parent : null;
        return (holder ? holder.namedChildren : []).filter(child => child.type === 'decorator').map(child => child.namedChildren[0]);
    };
    const decoratedMemo = new Map();
    const decoratedOf = info => {
        if (!info) return NOTHING;
        if (!decoratedMemo.has(info)) decoratedMemo.set(info, combine(decoratorsOf(info).map(expression => readMark(expression))));
        return decoratedMemo.get(info);
    };
    const settledModuleMarks = marksOf('module');
    const moduleMarks = marksUnsettled
        ? { ...settledModuleMarks, skip: settledModuleMarks.skip || 'sometimes', open: true, fixturesOpen: true }
        : settledModuleMarks;

    // ---- code that can stop a test before its body ----
    const functionsNamed = new Map(); // names of the module's top -> their definition nodes
    for (const info of definitions.values()) {
        if (info.scope !== 'module' || info.node.type !== 'function_definition') continue;
        const name = info.node.childForFieldName('name').text;
        if (!functionsNamed.has(name)) functionsNamed.set(name, []);
        functionsNamed.get(name).push(info.node);
    }
    const stopMemo = new Map();
    const NO_STOP = Object.freeze({ stops: false, calls: [] });
    /**
     * Can running a function stop a test: it mentions a stopping name,
     * raises, or calls a function of the module that can. `calls`: the
     * functions of other modules of the project it calls; whether one of
     * those can is said where the files are put together.
     */
    const stopFacts = (fn, raises = true) => {
        const key = `${fn.id}${raises ? '' : ' skips'}`;
        if (stopMemo.has(key)) return stopMemo.get(key);
        stopMemo.set(key, NO_STOP);
        const body = fn.childForFieldName('body');
        const calls = [];
        const answer = { stops: !!body && stops(body, calls, raises), calls };
        stopMemo.set(key, answer);
        return answer;
    };
    const mayStop = fn => stopFacts(fn).stops;
    // For a caller in another module: a function that names a skip. One
    // that only raises reports an error of its own, as any function may.
    const maySkip = fn => stopFacts(fn, false).stops;
    /** The function of another module of the project a callee names, or null. */
    const projectCall = callee => {
        const written = dotted(callee);
        if (!written) return null;
        const parts = written.split('.');
        const binding = imported.get(parts[0]);
        if (!binding) return null;
        if (binding.kind === 'import') {
            // module.function, by the module's own name or the one it is imported as
            if (parts.length !== 2 || !inProject(binding.module)) return null;
            return { module: binding.module, name: parts[1] };
        }
        // A function taken by name; or a module taken by name from its
        // package (from tests import helpers; helpers.need()).
        if (!inProject(binding.module)) return null;
        if (parts.length === 1) return { module: binding.module, name: binding.name };
        if (parts.length !== 2 || binding.kind !== 'from') return null;
        return { module: `${binding.module}.${binding.name}`, name: parts[1] };
    };
    const stops = (node, calls = [], raises = true) => {
        switch (node.type) {
            // A bare raise hands on what was already raised.
            case 'raise_statement':
                if (raises) return node.namedChildren.length > 0;
                break;
            case 'identifier': {
                if (PY_STOPPING_NAMES.has(node.text)) return true;
                const binding = imported.get(node.text);
                if (binding && binding.kind !== 'import' && PY_STOPPING_NAMES.has(binding.name)) return true;
                const path = pathOf(node.text);
                return !!path && PY_STOPPING_PATHS.test(path);
            }
            case 'attribute': {
                const written = dotted(node);
                const path = written ? pathOf(written) : null;
                // pytest.mark.skip is a mark: it is read where it is applied.
                if (path && /^pytest\.mark(\.|$)/.test(path)) return false;
                if (path && PY_STOPPING_PATHS.test(path)) return true;
                const name = node.childForFieldName('attribute');
                if (name && PY_STOPPING_NAMES.has(name.text)) return true;
                return stops(node.childForFieldName('object'), calls, raises);
            }
            case 'string_content': return PY_STOPPING_NAMES.has(node.text);
            case 'call': {
                const callee = node.childForFieldName('function');
                if (callee && callee.type === 'identifier' && !imported.has(callee.text)) {
                    for (const fn of functionsNamed.get(callee.text) || []) {
                        const facts = stopFacts(fn, raises);
                        if (facts.stops) return true;
                        calls.push(...facts.calls);
                    }
                }
                const elsewhere = projectCall(callee);
                if (elsewhere) calls.push(elsewhere);
                break;
            }
            default: break;
        }
        return node.namedChildren.some(child => stops(child, calls, raises));
    };
    const parameterNames = fn => {
        const names = [];
        const list = fn.childForFieldName('parameters');
        for (const parameter of list ? list.namedChildren : []) {
            let name = parameter.type === 'identifier' ? parameter : parameter.childForFieldName('name');
            if (!name && (parameter.type === 'list_splat_pattern' || parameter.type === 'dictionary_splat_pattern')) {
                name = parameter.namedChildren[0];
            }
            if (name && name.type === 'identifier') names.push(name.text);
        }
        return names;
    };
    /**
     * Can a hook change what is collected or run: it can stop a test, it
     * yields (it wraps the step), it returns a value where the value
     * decides, or it uses what pytest hands it in a way that is none of
     * the calls that only read.
     */
    const hookDecides = fn => {
        if (mayStop(fn)) return true;
        const body = fn.childForFieldName('body');
        if (!body) return true;
        const hookName = fn.childForFieldName('name').text;
        const wraps = node => node.type === 'yield' ||
            (node.type === 'return_statement' && !PYTEST_REPORTING_HOOKS.has(hookName) &&
                !!node.namedChildren[0] && node.namedChildren[0].type !== 'none') ||
            node.namedChildren.some(wraps);
        if (wraps(body)) return true;
        const handed = new Set(parameterNames(fn));
        if (handed.size === 0) return false;
        const isReference = node => {
            const parent = node.parent;
            if (!parent) return true;
            if (parent.type === 'attribute' && sameNode(parent.childForFieldName('attribute'), node)) return false;
            if (parent.type === 'keyword_argument' && sameNode(parent.childForFieldName('name'), node)) return false;
            // The name bound again: nothing is done to what it held.
            if (parent.type === 'assignment' && sameNode(parent.childForFieldName('left'), node)) return false;
            return true;
        };
        // What one use of a handed object is: false when it can change
        // something, else what the use makes of it.
        const useOf = reference => {
            let top = reference;
            for (;;) {
                while (top.parent && top.parent.type === 'attribute' && sameNode(top.parent.childForFieldName('object'), top)) top = top.parent;
                const call = top.parent;
                if (top.type !== 'attribute' || !call || call.type !== 'call' || !sameNode(call.childForFieldName('function'), top)) return false;
                const method = top.childForFieldName('attribute').text;
                if (!PYTEST_HOOK_READS.has(method)) return false;
                if (method === 'addinivalue_line') {
                    const key = stringOf(positional(call)[0]);
                    if (key !== 'markers' && key !== 'filterwarnings') return false;
                }
                if (!PYTEST_HOOK_OBJECTS.has(method)) return {};
                const holder = call.parent;
                if (holder && holder.type === 'attribute' && sameNode(holder.childForFieldName('object'), call)) {
                    top = call;
                    continue;
                }
                if (holder && holder.type === 'assignment' && sameNode(holder.childForFieldName('right'), call)) {
                    const left = holder.childForFieldName('left');
                    return left && left.type === 'identifier' ? { hands: left.text } : false;
                }
                return holder && PY_TRUTH_TESTS.has(holder.type) ? {} : false;
            }
        };
        let decides = false;
        let grew = true;
        const visit = node => {
            if (decides) return;
            if (node.type === 'identifier' && handed.has(node.text) && isReference(node)) {
                const use = useOf(node);
                if (use === false) decides = true;
                else if (use.hands && !handed.has(use.hands)) {
                    handed.add(use.hands);
                    grew = true;
                }
                return;
            }
            for (const child of node.namedChildren) visit(child);
        };
        while (grew && !decides) {
            grew = false;
            visit(body);
        }
        return decides;
    };
    /** The fixture a definition is, or null: its name, whether every test gets it, whether it can stop one. */
    const fixtureOf = info => {
        if (!info || info.node.type !== 'function_definition') return null;
        let made = null;
        for (const expression of decoratorsOf(info)) {
            const call = expression.type === 'call' ? expression : null;
            const written = dotted(call ? call.childForFieldName('function') : expression);
            const path = written ? pathOf(written) : null;
            if (path && PY_FIXTURE_PATHS.has(path)) made = { call };
        }
        if (!made) return null;
        const call = made.call;
        const functionName = info.node.childForFieldName('name').text;
        const renamed = call ? keywordOf(call, 'name') : null;
        const autouse = call ? keywordOf(call, 'autouse') : null;
        const params = call ? keywordOf(call, 'params') : null;
        const values = params ? sequenceOf(params) : null;
        const empty = !!params && (!values || values.namedChildren.filter(item => item.type !== 'comment').length === 0);
        return {
            name: renamed ? stringOf(renamed) : functionName,
            function: functionName,
            // A value that is not written out may be true.
            autouse: !!autouse && truthOf(autouse) !== false,
            decides: mayStop(info.node) || empty || (!!renamed && stringOf(renamed) == null),
            // A test that asks for it runs once for every parameter.
            ...(params && { params: true }),
            ...(stopFacts(info.node).calls.length > 0 && { calls: stopFacts(info.node).calls }),
            requests: parameterNames(info.node),
        };
    };

    // ---- what runs when the module is imported ----
    let moduleSkips = false;
    let namespaceWritten = false;
    const importTimeCalls = []; // functions of other modules of the project called when this one is imported
    const isMainTest = condition => !!condition && condition.type === 'comparison_operator' &&
        condition.namedChildren.length === 2 && condition.children.some(child => child.type === '==') &&
        condition.namedChildren.some(child => child.type === 'identifier' && child.text === '__name__') &&
        condition.namedChildren.some(child => stringOf(child) === '__main__');
    const importTime = node => {
        switch (node.type) {
            // Bodies run when called; decorators are read with the definition.
            case 'function_definition': case 'lambda': case 'import_statement': case 'import_from_statement':
            case 'decorator':
                return;
            case 'class_definition': {
                const body = node.childForFieldName('body');
                for (const child of body ? body.namedChildren : []) importTime(child);
                return;
            }
            case 'if_statement':
                // pytest never imports a module under the name __main__.
                if (isMainTest(node.childForFieldName('condition'))) {
                    for (const child of node.namedChildren) {
                        if (child.type === 'elif_clause' || child.type === 'else_clause') importTime(child);
                    }
                    return;
                }
                break;
            case 'raise_statement':
                if (node.namedChildren.length > 0) moduleSkips = true;
                return;
            case 'identifier': {
                if (PY_NAMESPACE_NAMES.has(node.text)) namespaceWritten = true;
                const path = pathOf(node.text);
                if (path && PY_STOPPING_PATHS.test(path)) moduleSkips = true;
                return;
            }
            case 'attribute': {
                const written = dotted(node);
                const path = written ? pathOf(written) : null;
                if (path && /^pytest\.mark(\.|$)/.test(path)) return;
                if (path && PY_STOPPING_PATHS.test(path)) {
                    moduleSkips = true;
                    return;
                }
                const name = node.childForFieldName('attribute');
                if (name && PY_NAMESPACE_NAMES.has(name.text)) namespaceWritten = true;
                importTime(node.childForFieldName('object'));
                return;
            }
            case 'call': {
                const callee = node.childForFieldName('function');
                if (callee && callee.type === 'identifier' && !imported.has(callee.text)) {
                    for (const fn of functionsNamed.get(callee.text) || []) {
                        if (mayStop(fn)) moduleSkips = true;
                        importTimeCalls.push(...stopFacts(fn).calls);
                    }
                }
                const elsewhere = projectCall(callee);
                if (elsewhere) importTimeCalls.push(elsewhere);
                break;
            }
            default: break;
        }
        for (const child of node.namedChildren) importTime(child);
    };
    importTime(root);

    // ---- what a definition is once its scope has run ----
    const infoOf = symbol => definitions.get((symbol.nameLine || symbol.startLine) - 1) ||
        definitions.get(symbol.startLine - 1) || null;
    const mentions = (node, name) => !!node && ((node.type === 'identifier' && node.text === name) ||
        node.namedChildren.some(child => mentions(child, name)));
    // 'definite': the name holds this definition. 'maybe': it may (a
    // branch, a later write that wraps it). 'gone': it does not.
    const stateOf = (info, name) => {
        if (!info) return 'gone';
        const candidates = candidatesOf(writesOf(info.scope, name));
        const mine = candidates.some(write => write && write.pos === info.pos);
        if (mine) return candidates.length === 1 ? 'definite' : 'maybe';
        return candidates.every(write => write && write.kind === 'assign' && mentions(write.value, name)) ? 'maybe' : 'gone';
    };
    /**
     * A function as a test, by what it is itself: its definition, its
     * decorators, a switch written on it. Null: no test (gone, a fixture,
     * switched off).
     */
    const rowOf = symbol => {
        const info = infoOf(symbol);
        const state = stateOf(info, symbol.name);
        if (state === 'gone') return null;
        const own = decoratedOf(info);
        if (own.fixture) return null;
        const written = attributeSwitch(info.scope, symbol.name);
        if (written && written.on === false) return null;
        const dynamic = state === 'maybe' ? 'defined-conditionally'
            : (switchUnsettled || (written && written.on === 'unknown')) ? 'collection-switch' : null;
        return {
            name: symbol.name, line: symbol.nameLine || symbol.startLine, startLine: symbol.startLine,
            endLine: symbol.endLine ?? symbol.startLine,
            named: functionNamed(symbol.name), prefixed: symbol.name.startsWith('test'),
            ...(written && written.forced && { forced: written.forced }),
            ...(own.skip === 'skip' && { skipped: true }),
            ...((own.skip === 'sometimes' || dynamic) && { conditional: true }),
            ...(dynamic && { dynamic }),
            marks: own.marks, marksOpen: own.open,
            requests: [...new Set([...parameterNames(info.node), ...own.fixtures])],
            ...(own.fixturesOpen && { requestsOpen: true }),
        };
    };
    /** Is a name bound to something this does not list that could be a test? */
    const boundToMore = writes => candidatesOf(writes).some(write => write && (write.kind === 'other' || write.kind === 'augment' ||
        (write.kind === 'assign' && !PY_PLAIN_VALUES.has(unwrapped(write.value).type))));
    let more = namespaceWritten || switchUnsettled;

    // ---- the module's own functions, other names for them, lambdas ----
    const moduleSwitch = switchUnsettled ? OPEN_SWITCH : switchValue(writesOf('module', '__test__'));
    const moduleOff = !!moduleSwitch && moduleSwitch.on === false;
    const units = [];
    const functions = [];
    const imports = [];
    for (const symbol of symbols) {
        if (!helpers.isCallable(symbol) || symbol.type === 'constructor') continue;
        if (helpers.enclosing(symbol).length > 0) continue;
        const info = infoOf(symbol);
        if (!info || info.scope !== 'module') continue;
        const row = rowOf(symbol);
        if (!row) continue;
        functions.push(row);
        if (row.named || row.forced) units.push({ kind: 'test', suite: [], ...row });
    }
    for (const [name, writes] of scopeWrites.get('module') || []) {
        const write = settled('module', name);
        const value = write && write.kind === 'assign' ? unwrapped(write.value) : null;
        if (value && value.type === 'identifier' && value.text !== name) {
            // Another name for something the module holds.
            imports.push({ name, original: value.text, module: null, line: write.line });
            continue;
        }
        if (value && value.type === 'lambda' && !functions.some(other => other.name === name)) {
            const row = {
                name, line: write.line, startLine: write.line, endLine: write.endLine,
                named: functionNamed(name), prefixed: name.startsWith('test'), marks: [], marksOpen: false,
                requests: parameterNames(value),
            };
            functions.push(row);
            if (row.named) units.push({ kind: 'test', suite: [], ...row });
            continue;
        }
        if ((functionNamed(name) || classNamed(name)) && boundToMore(writes)) more = true;
    }
    // Names taken from other modules that the module still holds when it
    // has run: a test class or function among them is collected here.
    for (const binding of fileEntry.importBindings || []) {
        if (binding.kind === 'import') continue;
        const bound = binding.alias || binding.name;
        const write = settled('module', bound);
        if (!write || write.kind !== 'import' || write.line !== binding.line) continue;
        imports.push({ name: bound, original: binding.name, module: binding.module, line: binding.line });
    }

    // ---- classes ----
    const classInfo = cls => infoOf(cls);
    const classes = [];
    const eligibleMemo = new Map();
    // Its definition is there, and so is every class around it.
    const eligible = cls => {
        if (!eligibleMemo.has(cls)) {
            eligibleMemo.set(cls, false);
            eligibleMemo.set(cls, stateOf(classInfo(cls), cls.name) !== 'gone' &&
                helpers.enclosing(cls).every(outer => outer.type === 'class' && eligible(outer)));
        }
        return eligibleMemo.get(cls);
    };
    for (const cls of symbols) {
        if (cls.type !== 'class') continue;
        const chain = helpers.enclosing(cls);
        if (chain.some(outer => outer.type !== 'class') || !eligible(cls)) continue;
        const info = classInfo(cls);
        const scope = info.node.id;
        // A base is looked up by the name it was declared under.
        const written = basesOf(cls).map(base => ({ base, from: origin(base) }));
        const declaredHere = name => symbols.some(symbol => symbol.type === 'class' && symbol.name === name) ||
            writesOf('module', name).length > 0;
        // A class of unittest, or (taken as one) a class from outside the
        // project that is named like one: neither brings a test.
        const outsideCase = ({ base, from }) => /TestCase$/.test(from.name) &&
            (from.bound ? !inProject(from.module) : !declaredHere(base.split('.')[0]));
        const ownMarks = combine([decoratedOf(info), marksOf(scope)]);
        const ownSwitch = switchUnsettled ? OPEN_SWITCH
            : switchValue([...writesOf(scope, '__test__'), ...(attributeWrites.get(`${info.scope}\0${cls.name}`) || [])]);
        const superclasses = info.node.childForFieldName('superclasses');
        const metaclass = (superclasses ? superclasses.namedChildren : [])
            .find(argument => argument.type === 'keyword_argument' && argument.childForFieldName('name')?.text === 'metaclass');
        const metaPath = metaclass ? pathOf(dotted(metaclass.childForFieldName('value')) || '') : null;
        const members = new Set(symbols.filter(symbol => holds(cls, symbol)).map(symbol => symbol.name));
        for (const name of (scopeWrites.get(scope) || new Map()).keys()) members.add(name);
        const tests = [];
        const abstract = [];
        const fixtures = [];
        const guardCalls = [];
        let guard = false;
        for (const symbol of symbols) {
            if (!holds(cls, symbol) || !helpers.isCallable(symbol)) continue;
            const memberInfo = infoOf(symbol);
            if (!memberInfo || memberInfo.scope !== scope) continue;
            if (decoratorsOf(memberInfo).some(expression => {
                const path = pathOf(dotted(expression.type === 'call' ? expression.childForFieldName('function') : expression) || '');
                return !!path && PY_ABSTRACT_PATHS.has(path);
            })) abstract.push(symbol.name);
            const fixture = fixtureOf(memberInfo);
            if (fixture) {
                fixtures.push(fixture);
                if (fixture.autouse && fixture.decides) guard = true;
                if (fixture.autouse) guardCalls.push(...(fixture.calls || []));
                continue;
            }
            if (PY_CLASS_SETUPS.has(symbol.name) && stateOf(memberInfo, symbol.name) !== 'gone') {
                if (mayStop(memberInfo.node)) guard = true;
                guardCalls.push(...stopFacts(memberInfo.node).calls);
            }
            if (symbol.type === 'constructor') continue;
            const row = rowOf(symbol);
            if (!row) continue;
            if (row.named || row.prefixed || row.forced || symbol.name === 'runTest') tests.push(row);
        }
        // Another name for a test of the class is one more test.
        for (const [name, writes] of scopeWrites.get(scope) || []) {
            const write = settled(scope, name);
            const value = write && write.kind === 'assign' ? unwrapped(write.value) : null;
            const target = value && value.type === 'identifier' && value.text !== name
                ? tests.find(row => row.name === value.text && !row.alias) : null;
            if (target && settled(scope, value.text) && settled(scope, value.text).kind === 'def') {
                tests.push({
                    ...target, name, line: write.line, of: target.line, alias: true,
                    named: functionNamed(name), prefixed: name.startsWith('test'),
                });
            } else if ((functionNamed(name) || name.startsWith('test') || classNamed(name)) && boundToMore(writes)) {
                more = true;
            }
        }
        classes.push({
            name: cls.name, suite: chain.map(outer => outer.name), bases: written.map(entry => entry.from.name),
            // Bases known to bring neither a constructor nor a test.
            plainBases: written.filter(entry => PYTHON_PLAIN_BASES.has(entry.from.name) ||
                entry.from.module === 'unittest' || (entry.from.module === null && /^unittest\./.test(entry.base)) ||
                outsideCase(entry)).map(entry => entry.from.name),
            named: classNamed(cls.name),
            ...(written.some(entry => (entry.from.module === 'unittest' && /TestCase$/.test(entry.from.name)) ||
                (entry.from.module === null && /^unittest\.\w*TestCase$/.test(entry.base)) || outsideCase(entry)) && { unittestBase: true }),
            // pytest does not collect a class that has a constructor, its
            // own or inherited; unittest's classes are built by unittest.
            refusedIfDeclares: ['__init__', '__new__'],
            ...(ownSwitch && { enabled: ownSwitch.on }),
            ...(ownSwitch && ownSwitch.forced && { forced: ownSwitch.forced }),
            ...(stateOf(info, cls.name) === 'maybe' && { unsettled: true }),
            ...(ownMarks.skip && { skip: ownMarks.skip }),
            ...(guard && { guard: true }),
            ...(guardCalls.length > 0 && { guardCalls }),
            ...(fixtures.length > 0 && { fixtures }),
            ...(ownMarks.fixtures.length > 0 && { usefixtures: ownMarks.fixtures }),
            ...(ownMarks.fixturesOpen && { usefixturesOpen: true }),
            ...(abstract.length > 0 && { abstract }),
            ...((written.some(entry => entry.from.module === 'abc' && entry.from.name === 'ABC') || metaPath === 'abc.ABCMeta')
                ? { abc: true } : metaclass ? { abc: 'unknown' } : {}),
            marks: ownMarks.marks, marksOpen: ownMarks.open,
            line: cls.nameLine || cls.startLine, startLine: cls.startLine, endLine: cls.endLine ?? cls.startLine,
            members: [...members], tests,
        });
    }

    // ---- what the file does as a plugin (a conftest.py, a module named by pytest_plugins) ----
    const moduleFixtures = [];
    const moduleGuardCalls = [];
    const hookCalls = []; // functions of other modules of the project its hooks call
    const stopping = []; // functions of the module's top that name a skip: they stop a test of a module that calls them
    let hooksDecide = false;
    let hooksEverywhere = false;
    let generates = false;
    let moduleGuard = false;
    for (const info of definitions.values()) {
        if (info.scope !== 'module' || info.node.type !== 'function_definition') continue;
        const name = info.node.childForFieldName('name').text;
        if (stateOf(info, name) === 'gone') continue;
        if (maySkip(info.node)) stopping.push(name);
        const fixture = fixtureOf(info);
        if (fixture) {
            moduleFixtures.push(fixture);
            if (fixture.autouse) moduleGuardCalls.push(...(fixture.calls || []));
            continue;
        }
        if (/^pytest_/.test(name) && hookDecides(info.node)) {
            hooksDecide = true;
            if (!PYTEST_NODE_HOOKS.has(name)) hooksEverywhere = true;
            // The one hook pytest also calls in a test module.
            if (name === 'pytest_generate_tests') generates = true;
        } else if (/^pytest_/.test(name)) {
            // A hook that decides nothing itself may call a function of
            // another module of the project that does.
            for (const call of stopFacts(info.node).calls) {
                hookCalls.push({
                    ...call,
                    ...(!PYTEST_NODE_HOOKS.has(name) && { everywhere: true }),
                    ...(name === 'pytest_generate_tests' && { generates: true }),
                });
            }
        }
        if (PY_MODULE_SETUPS.has(name)) {
            if (mayStop(info.node)) moduleGuard = true;
            moduleGuardCalls.push(...stopFacts(info.node).calls);
        }
    }
    const plugins = stars.map(star => ({ module: star.module, by: 'import' }));
    for (const [name, writes] of scopeWrites.get('module') || []) {
        if (!/^pytest_/.test(name)) continue;
        if (name === 'pytest_plugins') {
            // The modules named are loaded as plugins.
            const write = settled('module', name);
            const value = write && write.kind === 'assign' ? unwrapped(write.value) : null;
            const names = !value ? null : stringOf(value) != null ? [stringOf(value)]
                : (value.type === 'list' || value.type === 'tuple')
                    ? value.namedChildren.filter(item => item.type !== 'comment').map(stringOf) : null;
            if (!names || names.some(each => each == null)) {
                hooksDecide = true;
                hooksEverywhere = true;
            } else {
                for (const each of names) plugins.push({ module: each, by: 'name' });
            }
            continue;
        }
        // A hook bound by anything but its own definition is not read.
        if (writes.some(write => write.kind !== 'def')) {
            hooksDecide = true;
            if (!PYTEST_NODE_HOOKS.has(name)) hooksEverywhere = true;
            if (name === 'pytest_generate_tests') generates = true;
        }
    }
    // What a star import brings: the names __all__ lists when it is
    // written out, every public name otherwise.
    const allWrites = writesOf('module', '__all__');
    const allWrite = settled('module', '__all__');
    const allValue = allWrite && allWrite.kind === 'assign' ? unwrapped(allWrite.value) : null;
    const allNames = allValue && (allValue.type === 'list' || allValue.type === 'tuple')
        ? allValue.namedChildren.filter(item => item.type !== 'comment').map(stringOf) : null;
    const exportsAll = allWrites.length === 0 ? null
        : allNames && allNames.every(name => name != null) && allWrites.length === 1 ? allNames : 'unknown';

    const collected = collection.collected !== false;
    return {
        derived: true,
        units: collected ? units : [],
        classes, functions, imports, stars, exportsAll, linearization: 'c3',
        module: {
            ...(moduleMarks.skip || moduleSkips ? { skip: moduleMarks.skip === 'skip' ? 'skip' : 'sometimes' } : {}),
            ...(moduleSwitch && moduleSwitch.on === 'unknown' && { unsettled: true }),
            ...((moduleGuard || moduleFixtures.some(fixture => fixture.autouse && fixture.decides) || generates) && { guard: true }),
            ...(moduleMarks.fixtures.length > 0 && { usefixtures: moduleMarks.fixtures }),
            ...(moduleMarks.fixturesOpen && { usefixturesOpen: true }),
            // Functions of other modules of the project called when the
            // module is imported, and by its setups: one that can stop a
            // test makes its tests conditional.
            ...(importTimeCalls.length > 0 && { skipCalls: importTimeCalls }),
            ...(moduleGuardCalls.length > 0 && { guardCalls: moduleGuardCalls }),
            // Switches written here on names taken from other modules.
            switches: Object.fromEntries([...attributeWrites.keys()].filter(key => key.startsWith('module\0'))
                .map(key => key.slice('module\0'.length))
                .filter(name => writesOf('module', name).length === 1 && writesOf('module', name)[0].kind === 'import')
                .map(name => [name, switchUnsettled ? OPEN_SWITCH : attributeSwitch('module', name)])),
        },
        runtime: {
            decides: hooksDecide, everywhere: hooksEverywhere, generates, fixtures: moduleFixtures, plugins,
            ...(hookCalls.length > 0 && { hookCalls }),
        },
        stopping: [...new Set(stopping)],
        marks: moduleMarks.marks, marksOpen: moduleMarks.open,
        ...(moduleOff && { off: true }),
        ...(more && collected && { inheriting: true }),
        ...(!collected && { notCollected: true }),
    };
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

/** Module-level pytest declarations. Decorator ownership is resolved by the
 * index; a decorator merely spelled `fixture` is not sufficient evidence.
 */
function findPythonModuleEvidence(code, parser, parsedTree) {
    const tree = parsedTree || parseTree(parser, code), references = [], wildcards = [];
    traverseTree(tree.rootNode, node => {
        if (node.type === 'identifier' && node.text === '__all__') references.push(node);
        if (node.type === 'import_from_statement' && node.namedChildren.some(child => child.type === 'wildcard_import')) {
            const module = node.childForFieldName('module_name');
            wildcards.push({ name: '*', module: module?.text, origin: typeOrigin('import', node),
                topLevel: node.parent?.type === 'module' });
        }
        return true;
    });
    let exports = null;
    if (references.length === 1) {
        const name = references[0], assignment = name.parent, value = assignment.childForFieldName('right');
        if (assignment.type === 'assignment' && sameNode(assignment.childForFieldName('left'), name) &&
            assignment.parent?.parent?.type === 'module' && ['list', 'tuple'].includes(value?.type)) {
            const literals = value.namedChildren.map(item => {
                const content = item.type === 'string' && item.namedChildren.find(child => child.type === 'string_content');
                return content && item.namedChildren.every(child => ['string_start', 'string_content', 'string_end'].includes(child.type))
                    ? { value: content.text, origin: typeOrigin('literal', item) } : null;
            });
            if (literals.every(Boolean)) exports = { name: '__all__', origin: typeOrigin('assignment', assignment),
                literals, otherReferences: [] };
        }
    }
    return { exports, wildcards };
}

function findPytestFunctions(code, parser, parsedTree) {
    const tree = parsedTree || parseTree(parser, code);
    const pathOf = node => {
        if (node?.type === 'identifier') return [node.text];
        if (node?.type !== 'attribute') return null;
        const root = pathOf(node.childForFieldName('object'));
        const member = node.childForFieldName('attribute');
        return root && member ? [...root, member.text] : null;
    };
    const out = [];
    for (const outer of tree.rootNode.namedChildren) {
        const node = outer.type === 'decorated_definition' ? outer.childForFieldName('definition') : outer;
        if (node?.type !== 'function_definition') continue;
        const body = node.childForFieldName('body');
        const params = node.childForFieldName('parameters');
        const decorators = outer.type === 'decorated_definition'
            ? outer.namedChildren.filter(child => child.type === 'decorator').map(decorator => {
                const expression = decorator.namedChild(0);
                const callable = expression?.type === 'call' ? expression.childForFieldName('function') : expression;
                let alias, dynamicName = false;
                for (const argument of expression?.childForFieldName('arguments')?.namedChildren || []) {
                    if (argument.type !== 'keyword_argument' || argument.childForFieldName('name')?.text !== 'name') continue;
                    const value = argument.childForFieldName('value');
                    const content = value?.type === 'string' && value.namedChildren.find(child => child.type === 'string_content');
                    if (content && value.namedChildren.every(child => ['string_start', 'string_content', 'string_end'].includes(child.type))) alias = content.text;
                    else dynamicName = true;
                }
                return { path: pathOf(callable), alias, dynamicName, origin: typeOrigin('fixture', decorator) };
            }) : [];
        let yields = false;
        traverseTree(body, child => {
            if (child.type === 'function_definition' || child.type === 'lambda' || child.type === 'class_definition') return false;
            if (child.type === 'yield') yields = true;
            return true;
        });
        const annotation = node.childForFieldName('return_type');
        let value = annotation?.namedChild(0);
        let container;
        if (yields) {
            if (value?.type === 'subscript') {
                container = pathOf(value.childForFieldName('value'));
                value = value.childForFieldName('subscript');
            } else if (value?.type === 'generic_type') {
                container = pathOf(value.namedChild(0));
                value = value.namedChildren.find(child => child.type === 'type_parameter')?.namedChild(0)?.namedChild(0);
            } else value = null;
        }
        const valuePath = pathOf(value);
        out.push({ name: node.childForFieldName('name')?.text,
            startLine: outer.startPosition.row + 1, endLine: outer.endPosition.row + 1,
            async: node.children.some(child => child.type === 'async'), decorators, yields,
            parameters: (params?.namedChildren || []).filter(param => param.type === 'identifier')
                .map(param => ({ name: param.text, origin: typeOrigin('fixture', param),
                    unchanged: !pythonScopeBindsName(body, param.text) })),
            returnType: annotation?.text, valuePath, container,
            returnOrigin: annotation ? typeOrigin('annotation', annotation) : null,
        });
    }
    return out;
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
    'urllib.parse.parse_qs': 'dict',
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

/**
 * Other bindings of `name` in the scope that holds the definition on
 * `defLine` (fix #376). Python binds names at run time: every `def`,
 * `class`, assignment target and import of the name in one scope (module,
 * class body or function body, through if/elif/else, try/except/finally,
 * with and loop blocks) is the SAME variable, so version-conditional
 * definitions (`if sys.version_info >= ...: f = lib.f else: def f(...)`),
 * try/except import fallbacks and class-body rebindings are alternatives a
 * rename must change together. In a class body, bare reads of the name
 * (`close = release`, `@prop.setter`) bind to the class-scope variable and
 * are references to the member.
 * @returns {{line, column, kind: 'definition'|'assignment'|'import'|'import-name'|'reference'}[]}
 *   column is the byte column of the name token; 'import-name' is an
 *   unaliased `from m import name` (its alias must be added, not renamed).
 */
function findScopeAlternativeBindings(tree, defLine, name) {
    if (!tree || !name) return [];
    const row = defLine - 1;
    let defNode = null;
    const stack = [tree.rootNode];
    while (stack.length > 0 && !defNode) {
        const node = stack.pop();
        if (node.startPosition.row > row || node.endPosition.row < row) continue;
        if ((node.type === 'function_definition' || node.type === 'class_definition')) {
            const nameNode = node.childForFieldName('name');
            if (nameNode && nameNode.text === name && nameNode.startPosition.row === row) {
                defNode = node;
                break;
            }
        }
        for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push(node.namedChild(i));
    }
    if (!defNode) return [];
    let container = null;
    for (let cur = defNode; cur.parent; cur = cur.parent) {
        const parent = cur.parent;
        if (parent.type === 'module') { container = parent; break; }
        if (parent.type === 'block' && parent.parent &&
            (parent.parent.type === 'class_definition' ||
                parent.parent.type === 'function_definition')) {
            container = parent;
            break;
        }
    }
    if (!container) return [];
    const classBody = container.parent?.type === 'class_definition';
    const out = [];
    const push = (node, kind) => out.push({
        line: node.startPosition.row + 1, column: node.startPosition.column, kind,
    });
    const references = expr => {
        if (!classBody || !expr) return;
        const refStack = [expr];
        while (refStack.length > 0) {
            const node = refStack.pop();
            if (node.type === 'lambda' || node.type === 'function_definition' ||
                node.type === 'class_definition' || node.type.endsWith('comprehension') ||
                node.type === 'generator_expression') continue;
            if (node.type === 'identifier') {
                if (node.text === name) push(node, 'reference');
                continue;
            }
            if (node.type === 'attribute') {
                refStack.push(node.childForFieldName('object'));
                continue;
            }
            if (node.type === 'keyword_argument') {
                refStack.push(node.childForFieldName('value'));
                continue;
            }
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child) refStack.push(child);
            }
        }
    };
    const targets = (target, kind) => {
        if (!target) return;
        if (target.type === 'identifier') {
            if (target.text === name) push(target, kind);
            return;
        }
        if (['pattern_list', 'tuple_pattern', 'list_pattern', 'expression_list', 'tuple',
            'list', 'parenthesized_expression'].includes(target.type)) {
            for (let i = 0; i < target.namedChildCount; i++) targets(target.namedChild(i), kind);
            return;
        }
        references(target);
    };
    const visit = node => {
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (!child) continue;
            switch (child.type) {
                case 'function_definition':
                case 'class_definition': {
                    const nameNode = child.childForFieldName('name');
                    if (nameNode && nameNode.text === name && child.startIndex !== defNode.startIndex) {
                        push(nameNode, 'definition');
                    }
                    // Evaluated in this scope: base classes, return and
                    // parameter annotations, parameter defaults - never the
                    // parameter names themselves.
                    references(child.childForFieldName('superclasses'));
                    references(child.childForFieldName('return_type'));
                    const params = child.childForFieldName('parameters');
                    for (let j = 0; j < (params?.namedChildCount || 0); j++) {
                        const param = params.namedChild(j);
                        references(param.childForFieldName?.('type'));
                        references(param.childForFieldName?.('value'));
                    }
                    break;
                }
                case 'decorated_definition':
                    for (let j = 0; j < child.namedChildCount; j++) {
                        const part = child.namedChild(j);
                        if (part.type === 'decorator') references(part);
                    }
                    visit({ namedChildCount: 1, namedChild: () => child.childForFieldName('definition') });
                    break;
                case 'expression_statement':
                    visit(child);
                    break;
                case 'assignment':
                case 'augmented_assignment': {
                    targets(child.childForFieldName('left'), 'assignment');
                    references(child.childForFieldName('type'));
                    const right = child.childForFieldName('right');
                    if (right && right.type === 'assignment') visit({ namedChildCount: 1, namedChild: () => right });
                    else references(right);
                    break;
                }
                case 'import_from_statement':
                case 'import_statement':
                    for (let j = 0; j < child.namedChildCount; j++) {
                        const item = child.namedChild(j);
                        if (item.type === 'aliased_import') {
                            const alias = item.childForFieldName('alias');
                            if (alias && alias.text === name) push(alias, 'import');
                        } else if (item.type === 'dotted_name' &&
                            (child.type === 'import_statement' ||
                                !sameNode(item, child.childForFieldName('module_name')))) {
                            const parts = item.namedChildren || [];
                            if (parts.length === 1 && parts[0].text === name) {
                                push(parts[0], 'import-name');
                            }
                        }
                    }
                    break;
                case 'if_statement':
                case 'elif_clause':
                case 'else_clause':
                case 'try_statement':
                case 'except_clause':
                case 'except_group_clause':
                case 'finally_clause':
                case 'with_statement':
                case 'for_statement':
                case 'while_statement':
                case 'block':
                case 'match_statement':
                case 'case_clause':
                    if (child.type === 'for_statement') {
                        targets(child.childForFieldName('left'), 'assignment');
                        references(child.childForFieldName('right'));
                        for (const field of ['body', 'alternative']) {
                            const part = child.childForFieldName(field);
                            if (part) visit({ namedChildCount: 1, namedChild: () => part });
                        }
                        break;
                    }
                    visit(child);
                    break;
                default:
                    if (child.type !== 'comment' && child.type !== 'pass_statement') references(child);
            }
        }
    };
    visit(container);
    out.sort((a, b) => a.line - b.line || a.column - b.column);
    return out;
}

/**
 * The annotated type of a plain receiver of an attribute reference (fix
 * #424): `env.config` inside `def f(env: Environment)` reads a member of
 * Environment when the parameter is the only binding of `env` in the scope
 * the reference resolves to. `column` is the attribute token's column.
 * Undefined when the receiver is rebound, unannotated or not a parameter.
 */
function annotatedReceiverType(tree, line, column, receiver) {
    if (!tree || !receiver || receiver === 'self' || receiver === 'cls') return undefined;
    const token = tree.rootNode.descendantForPosition({ row: line - 1, column });
    const attribute = token?.parent;
    if (attribute?.type !== 'attribute' || !sameNode(attribute.childForFieldName('attribute'), token)) return undefined;
    const object = attribute.childForFieldName('object');
    if (object?.type !== 'identifier' || object.text !== receiver) return undefined;
    const { referenceScopeNode, pythonBindingSites } = require('./lexical-scope');
    const scope = referenceScopeNode(object, receiver);
    if (scope?.type !== 'function_definition') return undefined;
    const sites = pythonBindingSites(scope, receiver);
    if (sites.length !== 1) return undefined;
    const parameter = sites[0].parent;
    if (!parameter || !['typed_parameter', 'typed_default_parameter'].includes(parameter.type) ||
        parameter.parent?.type !== 'parameters') return undefined;
    return typeNameFromAnnotation(parameter.childForFieldName('type')) || undefined;
}

// The comments the type checker reads as directives (pyright's tokenizer).
const TYPE_IGNORE = /(^|#)\s*type:\s*ignore(\[[\s\w-,]*\]|\s|$)/;
const PYRIGHT_IGNORE = /(^|#)\s*pyright:\s*ignore(?:\[([\s\w-,]*)\]|\s|$)/;
const CHECK_MODES = new Set(['basic', 'standard', 'strict']);
// The rule each kind of break is reported under.
const RULE_OF = Object.freeze({
    'arity': 'reportCallIssue',
    'import-name': 'reportAttributeAccessIssue',
    'import-module': 'reportMissingImports',
    'undefined-name': 'reportUndefinedVariable',
});

/**
 * What the comments of a file tell the checker:
 *   all      a `type: ignore` comment before any token: nothing is reported;
 *   lines    line -> null (everything on it is ignored: `type: ignore`,
 *            `pyright: ignore`) or the rules a `pyright: ignore[..]` names;
 *   levels   rule -> level set by `# pyright: rule=level` comments, which
 *            apply to the file wherever they stand, alone on their line.
 *            `basic`, `standard` and `strict` choose a rule set: none of
 *            them turns a rule off.
 */
function checkDirectives(root, lines) {
    const ignored = new Map();
    const levels = new Map();
    let all = false;
    const firstToken = root.children.find(child => child.type !== 'comment');
    const codeStart = firstToken ? firstToken.startIndex : Infinity;
    for (const comment of root.descendantsOfType('comment')) {
        const text = comment.text;
        const line = comment.startPosition.row + 1;
        if (TYPE_IGNORE.test(text)) {
            if (comment.startIndex < codeStart) all = true;
            else ignored.set(line, null);
        }
        const scoped = PYRIGHT_IGNORE.exec(text);
        if (scoped && !(ignored.has(line) && ignored.get(line) === null)) {
            ignored.set(line, scoped[2] === undefined ? null
                : scoped[2].split(',').map(rule => rule.trim()).filter(Boolean));
        }
        const value = text.slice(1).trim();
        const ownLine = String(lines[line - 1] === undefined ? '' : lines[line - 1]).trim().startsWith('#');
        if (!ownLine || !value.startsWith('pyright:')) continue;
        const operands = value.slice('pyright:'.length);
        if (operands.trim().startsWith('ignore')) continue;
        const list = operands.split(',').map(operand => operand.trim()).filter(Boolean);
        if (list.some(operand => CHECK_MODES.has(operand))) levels.clear();
        for (const operand of list) {
            const [rule, level] = operand.split('=').map(part => part.trim());
            // A level the checker does not know leaves the rule as it was.
            if (rule && CHECK_LEVELS.has(level)) levels.set(rule, level);
        }
    }
    return { all, ignored, levels };
}

// The levels a `# pyright: rule=level` comment may set.
const CHECK_LEVELS = new Set(['true', 'false', 'error', 'warning', 'information', 'none']);

/** The `call` node that covers exactly `span`, or null. */
function callAtSpan(root, span) {
    for (let node = root.descendantForIndex(span.start, Math.max(span.start, span.end - 1)); node; node = node.parent) {
        if (node.startIndex === span.start && node.endIndex === span.end && node.type === 'call') return node;
        if (node.startIndex < span.start || node.endIndex > span.end) break;
    }
    return null;
}

/**
 * The ranges the checker reports a break over, one per report it makes: a
 * comment on any line of a range silences that report, and the break is
 * silenced when every report is.
 *   arity           too few arguments: the whole call. One positional
 *                   argument too many, a keyword the callable does not
 *                   take or takes twice: that argument;
 *   import-name     the imported name; import-module: the module name;
 *   undefined-name  the line itself.
 * The call is the one the engine measured (`site.span`), whatever name it
 * is called under and however many calls share its line; an import is the
 * statement that names `site.module`.
 */
function reportedRanges(root, site) {
    const line = site.line;
    const range = [{ row: line - 1, column: 0 }, { row: line, column: 0 }];
    const rows = node => [node.startPosition.row + 1, node.endPosition.row + 1];
    const spans = node => node.startPosition.row + 1 <= line && node.endPosition.row + 1 >= line;
    if (site.kind === 'arity') {
        const nameOf = call => {
            const callee = call.childForFieldName('function');
            return callee ? (callee.childForFieldName('attribute') || callee) : null;
        };
        const call = site.span ? callAtSpan(root, site.span)
            : root.descendantsOfType('call', ...range).filter(candidate => {
                const named = nameOf(candidate);
                return !!named && named.startPosition.row + 1 === line;
            }).find((candidate, at, all) => !site.name || nameOf(candidate).text === site.name ||
                !all.some(other => nameOf(other).text === site.name));
        if (!call) return [[line, line]];
        const given = (call.childForFieldName('arguments')?.namedChildren || [])
            .filter(argument => argument.type !== 'comment');
        const keyword = name => given.find(argument => argument.type === 'keyword_argument' &&
            argument.childForFieldName('name')?.text === name);
        const reports = [];
        // What the call was measured against, problem by problem.
        for (const problem of String(site.problem || '').split('; ').filter(Boolean)) {
            const named = /'([^']+)'/.exec(problem);
            if (/^takes \d+ positional/.test(problem)) {
                const positional = given.filter(argument => argument.type !== 'keyword_argument');
                const count = Number(/^takes (\d+)/.exec(problem)[1]);
                reports.push(rows(positional[count] || call));
            } else if (named && !/^missing/.test(problem) && keyword(named[1])) {
                reports.push(rows(keyword(named[1])));
            } else {
                reports.push(rows(call));
            }
        }
        if (reports.length > 0) return reports;
        if (Number.isInteger(site.most) && given.length > site.most) return [rows(given[site.most])];
        return [rows(call)];
    }
    if (site.kind === 'import-name' || site.kind === 'import-module') {
        const statements = root.descendantsOfType(['import_from_statement', 'import_statement'], ...range).filter(spans);
        const moduleOf = statement => statement.childForFieldName('module_name') ||
            statement.namedChildren.find(child => child.type === 'dotted_name' || child.type === 'aliased_import');
        const naming = site.module === undefined ? statements
            : statements.filter(statement => statement.descendantsOfType(['dotted_name', 'relative_import'])
                .some(node => node.text === site.module));
        for (const statement of naming.length > 0 ? naming : statements) {
            if (site.kind === 'import-name') {
                const named = statement.descendantsOfType(['dotted_name', 'identifier'])
                    .find(node => node.text === site.name);
                if (named) return [rows(named)];
            }
            const module = moduleOf(statement);
            if (module) return [rows(module)];
        }
    }
    return [[line, line]];
}

/**
 * Has the type checker been told not to report this break? As pyright
 * reads its comments: a `type: ignore` before any code, the break's rule
 * set to anything but an error by a `# pyright:` comment, or a
 * `type: ignore` / `pyright: ignore` comment (naming the rule, when it
 * names any) on a line of every range it is reported over.
 *
 * @param {object} site - { lines, root, line, kind, name, most, span,
 *   problem, module, memo }
 */
function checkSuppressedAt(site) {
    const { lines, root, memo } = site;
    if (!root) return false;
    if (memo && !memo.has('directives')) memo.set('directives', checkDirectives(root, lines));
    const directives = memo ? memo.get('directives') : checkDirectives(root, lines);
    if (directives.all) return true;
    const rule = RULE_OF[site.kind] || null;
    const level = rule ? directives.levels.get(rule) : undefined;
    if (level !== undefined && level !== 'true' && level !== 'error') return true;
    const silenced = ([first, last]) => {
        for (let at = first; at <= last; at++) {
            if (!directives.ignored.has(at)) continue;
            const rules = directives.ignored.get(at);
            if (rules === null || (rule !== null && rules.includes(rule))) return true;
        }
        return false;
    };
    return reportedRanges(root, site).every(silenced);
}

/**
 * Is the import written on `line` a statement the type checker resolves?
 * `importlib.import_module(..)` and `__import__(..)` are calls to it.
 * Several imports can share a line: the one asked about is the one that
 * names `module`, as it is written.
 */
function checkedImportAt(root, line, module) {
    const range = [{ row: line - 1, column: 0 }, { row: line, column: 0 }];
    return root.descendantsOfType(['import_statement', 'import_from_statement', 'future_import_statement'], ...range)
        .some(node => node.startPosition.row + 1 <= line && node.endPosition.row + 1 >= line &&
            (module === undefined || node.descendantsOfType(['dotted_name', 'relative_import'])
                .some(named => named.text === module)));
}

module.exports = {
    checkSuppressedAt,
    checkedImportAt,
    annotatedReceiverType,
    findScopeAlternativeBindings,
    findPythonModuleEvidence,
    findFunctions,
    findClasses,
    findStateObjects,
    findCallsInCode,
    findImportsInCode,
    findExportsInCode,
    findUsagesInCode,
    findInstanceAttributeTypes,
    findClassFieldFacts,
    getBuiltinCallReturnType,
    getBuiltinFieldType,
    findPytestFunctions,
    isEntryPoint,
    getEntryPointKind,
    testUnits,
    parse
};
