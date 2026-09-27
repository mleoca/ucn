/**
 * languages/javascript.js - Tree-sitter based JS/TS/TSX parsing
 *
 * Handles: function declarations, arrow functions, class declarations,
 * interfaces, type aliases, enums, and state objects.
 */

const { ReceiverTypeMap, typeOrigin } = require('./type-evidence');
const { referenceScope, scopeFields } = require('./lexical-scope');


const {
    traverseTree,
    nodeTextWithoutComments,
    traverseTreeCached,
    nodeToLocation,
    extractParams,
    parseStructuredParams,
    extractJSDocstring,
    buildTypeAnnotations,
    visitNameNodes,
    sameNode,
    parseErrorRegions,
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
        let text = nodeTextWithoutComments(returnTypeNode).trim();
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

// Names of the global object itself: a property assigned on one of them
// (unshadowed) is a global binding that bare names resolve to.
const JS_GLOBAL_OBJECT_NAMES = new Set(['globalThis', 'window', 'self', 'global']);

const FUNCTION_NODE_TYPES = new Set([
    'function_declaration', 'function_expression', 'function', 'arrow_function',
    'method_definition', 'generator_function', 'generator_function_declaration',
]);

function unwrapValueExpression(node) {
    while (node && (node.type === 'parenthesized_expression' || node.type === 'as_expression' ||
        node.type === 'non_null_expression' || node.type === 'satisfies_expression' ||
        node.type === 'type_assertion')) {
        node = node.type === 'type_assertion'
            ? node.namedChild(node.namedChildCount - 1) : node.namedChild(0);
    }
    return node;
}

/** Names a binding pattern declares (identifiers, shorthand, rest, defaults' targets). */
function collectPatternNames(pattern, out) {
    if (!pattern) return;
    if (pattern.type === 'required_parameter' || pattern.type === 'optional_parameter') {
        collectPatternNames(pattern.childForFieldName('pattern') || pattern.childForFieldName('name'), out);
        return;
    }
    if (pattern.type === 'identifier' || pattern.type === 'shorthand_property_identifier_pattern') {
        out.push(pattern.text);
        return;
    }
    if (pattern.type === 'pair_pattern' || pattern.type === 'pair') {
        collectPatternNames(pattern.childForFieldName('value'), out);
        return;
    }
    if (pattern.type === 'assignment_pattern') {
        collectPatternNames(pattern.childForFieldName('left') || pattern.childForFieldName('pattern'), out);
        return;
    }
    if (pattern.type === 'type_annotation') return;
    for (let i = 0; i < pattern.namedChildCount; i++) collectPatternNames(pattern.namedChild(i), out);
}

// Module-level alias: findCallsInCode declares its own one-argument
// collectPatternNames for module value bindings.
const collectBoundPatternNames = collectPatternNames;

// Function kinds whose parameters bind in their own range (fix #397).
const JS_SHADOW_FUNCTIONS = new Set(['arrow_function', 'function_expression', 'function_declaration',
    'function', 'method_definition', 'generator_function', 'generator_function_declaration']);

/** A declarator value that is a require()/import() (through await, parens, `.member`). */
function isImportInitializerNode(value) {
    let v = value;
    for (;;) {
        if (!v) return false;
        if (v.type === 'await_expression' || v.type === 'parenthesized_expression') {
            v = v.namedChild(0);
            continue;
        }
        if (v.type === 'member_expression' || v.type === 'subscript_expression') {
            v = v.childForFieldName('object');
            continue;
        }
        break;
    }
    if (v.type !== 'call_expression') return false;
    const fn = v.childForFieldName('function');
    return !!fn && (fn.type === 'import' || (fn.type === 'identifier' && fn.text === 'require'));
}

/** Record the bindings one statement introduces into `table` (first wins). */
function collectStatementBindings(stmt, table) {
    const add = (name, binding) => { if (name && !table.has(name)) table.set(name, binding); };
    if (stmt.type === 'export_statement') {
        const declaration = stmt.childForFieldName('declaration');
        if (declaration) collectStatementBindings(declaration, table);
        return;
    }
    if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
        for (let i = 0; i < stmt.namedChildCount; i++) {
            const declarator = stmt.namedChild(i);
            if (declarator.type !== 'variable_declarator') continue;
            const target = declarator.childForFieldName('name');
            const start = stmt.startIndex;
            const line = stmt.startPosition.row + 1;
            if (target?.type === 'identifier') {
                add(target.text, { kind: 'declarator', value: declarator.childForFieldName('value'), declarator,
                    start, line });
            } else {
                const names = [];
                collectPatternNames(target, names);
                for (const name of names) add(name, { kind: 'pattern', declarator, start, line });
            }
        }
        return;
    }
    if (stmt.type === 'function_declaration' || stmt.type === 'generator_function_declaration' ||
        stmt.type === 'class_declaration') {
        add(stmt.childForFieldName('name')?.text,
            { kind: stmt.type === 'class_declaration' ? 'class' : 'function', line: stmt.startPosition.row + 1 });
        return;
    }
    if (stmt.type === 'import_statement') {
        for (const clause of stmt.namedChildren) {
            if (clause.type !== 'import_clause') continue;
            for (const part of clause.namedChildren) {
                if (part.type === 'identifier') add(part.text, { kind: 'import' });
                else if (part.type === 'namespace_import') {
                    for (const child of part.namedChildren) {
                        if (child.type === 'identifier') add(child.text, { kind: 'import' });
                    }
                } else if (part.type === 'named_imports') {
                    for (const spec of part.namedChildren) {
                        const local = spec.childForFieldName('alias') || spec.childForFieldName('name');
                        if (local) add(local.text, { kind: 'import' });
                    }
                }
            }
        }
    }
}

// Statement-list binding tables per tree, by node id: one scan per list
// however many member assignments look names up in it.
const statementListTables = new WeakMap();

function statementListBindings(listNode) {
    let byId = statementListTables.get(listNode.tree);
    if (!byId) {
        byId = new Map();
        statementListTables.set(listNode.tree, byId);
    }
    let table = byId.get(listNode.id);
    if (!table) {
        table = new Map();
        for (let i = 0; i < listNode.namedChildCount; i++) {
            collectStatementBindings(listNode.namedChild(i), table);
        }
        byId.set(listNode.id, table);
    }
    return table;
}

/**
 * The declaration of `name` visible at `refNode`: statement-list bindings
 * (hoisted declarations anywhere in the list), loop and catch bindings,
 * parameters and a function expression's own name; null when free.
 */
function declarationVisibleAt(refNode, name) {
    for (let p = refNode.parent; p; p = p.parent) {
        if (p.type === 'statement_block' || p.type === 'program' || p.type === 'class_static_block') {
            const binding = statementListBindings(p).get(name);
            if (binding) return binding;
        } else if (p.type === 'for_statement' || p.type === 'for_in_statement') {
            const head = p.childForFieldName('initializer') || p.childForFieldName('left');
            if (head) {
                const names = [];
                if (head.type === 'lexical_declaration' || head.type === 'variable_declaration') {
                    const table = new Map();
                    collectStatementBindings(head, table);
                    if (table.has(name)) return { kind: 'loop' };
                } else {
                    collectPatternNames(head, names);
                    if (names.includes(name)) return { kind: 'loop' };
                }
            }
        } else if (p.type === 'catch_clause') {
            const names = [];
            collectPatternNames(p.childForFieldName('parameter'), names);
            if (names.includes(name)) return { kind: 'param' };
        } else if (FUNCTION_NODE_TYPES.has(p.type)) {
            const params = p.childForFieldName('parameters') || p.childForFieldName('parameter');
            if (params) {
                const names = [];
                collectPatternNames(params, names);
                if (names.includes(name)) return { kind: 'param' };
            }
            if ((p.type === 'function_expression' || p.type === 'function' ||
                p.type === 'generator_function') && p.childForFieldName('name')?.text === name) {
                return { kind: 'function' };
            }
        } else if (p.type === 'class' && p.childForFieldName('name')?.text === name) {
            return { kind: 'class' };
        }
    }
    return null;
}

/** A value that is a fresh or module object, never the global object. */
function provablyNonGlobalValue(valueNode) {
    let value = unwrapValueExpression(valueNode);
    while (value?.type === 'assignment_expression') {
        value = unwrapValueExpression(value.childForFieldName('right'));
    }
    if (!value) return false;
    if (['new_expression', 'object', 'array', 'class', 'function_expression', 'function',
        'arrow_function', 'generator_function'].includes(value.type)) return true;
    const callee = value.type === 'call_expression' ? value.childForFieldName('function') : null;
    return callee?.type === 'identifier' && callee.text === 'require';
}

/**
 * Whether `this` at a node is an object other than the global object: a
 * class member body, or a function installed as a method (object literal
 * value, member assignment). A plain function's `this` can be the global
 * object (a sloppy-mode plain call), as can module-level `this` in a script.
 */
function thisIsNonGlobalObject(thisNode) {
    for (let p = thisNode.parent; p; p = p.parent) {
        if (p.type === 'arrow_function') continue;
        if (p.type === 'method_definition' || p.type === 'class_body' ||
            p.type === 'class_static_block') return true;
        if (p.type === 'function_expression' || p.type === 'function' ||
            p.type === 'generator_function') {
            const holder = p.parent;
            if (holder?.type === 'pair' && sameNode(holder.childForFieldName('value'), p)) return true;
            return holder?.type === 'assignment_expression' &&
                sameNode(holder.childForFieldName('right'), p) &&
                holder.childForFieldName('left')?.type === 'member_expression';
        }
        if (p.type === 'function_declaration' || p.type === 'generator_function_declaration' ||
            p.type === 'program') return false;
    }
    return false;
}

/**
 * What the object of a member assignment (`obj.f = function () {}`) is for
 * bare-name lookup: 'global' when it is the global object (the member is a
 * global binding), 'object' when it is provably another object (the member
 * creates no name a bare call can reach), null when it may be either (a
 * parameter, a plain function's `this`, a value UCN does not follow).
 */
function classifyAssignedObject(objectNode) {
    const node = unwrapValueExpression(objectNode);
    if (!node) return null;
    if (node.type === 'this') return thisIsNonGlobalObject(node) ? 'object' : null;
    if (node.type === 'identifier') {
        const declaration = declarationVisibleAt(node, node.text);
        if (!declaration) return JS_GLOBAL_OBJECT_NAMES.has(node.text) ? 'global' : 'object';
        if (declaration.kind === 'function' || declaration.kind === 'class' ||
            declaration.kind === 'import') return 'object';
        if (declaration.kind === 'declarator' && provablyNonGlobalValue(declaration.value)) return 'object';
        // `var global = globalThis` (fix #397, handlebars-measured): a
        // binding of the global object itself, never assigned again, names
        // the global object.
        if (declaration.kind === 'declarator' && declaration.declarator &&
            globalObjectAlias(declaration.declarator, node.text)) return 'global';
        return null;
    }
    if (node.type === 'member_expression' || node.type === 'subscript_expression') {
        // A property value is the global object only through a global
        // alias of the global object itself (`window.self`).
        const property = node.type === 'member_expression'
            ? node.childForFieldName('property')?.text : null;
        if (property && JS_GLOBAL_OBJECT_NAMES.has(property) &&
            classifyAssignedObject(node.childForFieldName('object')) === 'global') return 'global';
        return 'object';
    }
    return null;
}

/**
 * Whether a declarator binds the global object and nothing assigns the name
 * again in its scope: `var global = globalThis`, `const root = window`.
 */
function globalObjectAlias(declarator, name) {
    const value = unwrapValueExpression(declarator.childForFieldName('value'));
    if (value?.type !== 'identifier' || !JS_GLOBAL_OBJECT_NAMES.has(value.text) ||
        declarationVisibleAt(value, value.text)) return false;
    const statement = declarator.parent;
    const scope = statement?.parent;
    if (!scope) return false;
    if (statement.type === 'lexical_declaration' && statement.child(0)?.type === 'const') return true;
    for (const assignment of scope.descendantsOfType(['assignment_expression', 'augmented_assignment_expression'])) {
        const left = assignment.childForFieldName('left');
        if (left?.type === 'identifier' && left.text === name) return false;
    }
    return true;
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
        // `get name() {}` / `set name(v) {}` in the literal: one property
        // accessed by reads and writes (fix #397).
        let accessorKind = null;
        if (prop.type === 'method_definition') {
            for (let c = 0; c < prop.childCount; c++) {
                const token = prop.child(c);
                if (nameNode && token.startIndex >= nameNode.startIndex) break;
                if (token.type === 'get' || token.type === 'set') accessorKind = token.type;
            }
        }

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
            // The literal's own line: members of one object literal share it
            // (fix #397: `this` in a member names that object).
            objectLiteralLine: objectNode.startPosition.row + 1,
            ...(accessorKind && { memberType: accessorKind }),
            // An object literal member is a property of a fresh object: no
            // bare name reaches it, except a self-named function
            // expression's own name inside its body (fix #384).
            assignedObject: 'object',
            ...(fnNode.type !== 'method_definition' &&
                fnNode.childForFieldName('name')?.text === name && { selfNamed: true }),
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

const FUNCTION_SCOPE_NODES = new Set([
    'function_declaration', 'generator_function_declaration',
    'function_expression', 'generator_function', 'arrow_function',
    'method_definition',
]);

function lexicalOwnerRange(node) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (!FUNCTION_SCOPE_NODES.has(parent.type)) continue;
        const body = parent.childForFieldName('body') || parent;
        return {
            lexicalScopeStartLine: body.startPosition.row + 1,
            lexicalScopeEndLine: body.endPosition.row + 1,
        };
    }
    return {};
}

/**
 * Concrete runtime value returned by a function when every reachable return
 * constructs the same class. Nested functions/classes are separate scopes.
 * This complements (never guesses beyond) a declared interface return type.
 */
function extractReturnedConcreteType(node) {
    const body = node.childForFieldName('body');
    if (!body) return null;
    const types = [];
    let incomplete = false;
    const stack = [body];
    while (stack.length > 0) {
        const current = stack.pop();
        if (current !== body && FUNCTION_SCOPE_NODES.has(current.type)) continue;
        if (current.type === 'class_declaration' || current.type === 'class') continue;
        if (current.type === 'return_statement') {
            const value = current.namedChild(0);
            if (value?.type !== 'new_expression') {
                incomplete = true;
                continue;
            }
            const constructor = value.childForFieldName('constructor');
            if (!constructor ||
                !['identifier', 'member_expression'].includes(constructor.type)) {
                incomplete = true;
                continue;
            }
            types.push(constructor.text.split('.').pop());
            continue;
        }
        for (let i = current.namedChildCount - 1; i >= 0; i--) {
            stack.push(current.namedChild(i));
        }
    }
    return !incomplete && types.length > 0 && new Set(types).size === 1
        ? types[0] : null;
}

/**
 * Whether every explicit value-producing return yields the current receiver.
 * A fallthrough/empty return cannot feed a subsequent chained call, so it does
 * not compete with `this`; any other returned value makes the result unknown.
 */
function returnsReceiverSelf(node) {
    const body = node.childForFieldName('body');
    if (!body) return false;
    let sawSelf = false;
    const stack = [body];
    while (stack.length > 0) {
        const current = stack.pop();
        if (current !== body && FUNCTION_SCOPE_NODES.has(current.type)) continue;
        if (current.type === 'class_declaration' || current.type === 'class') continue;
        if (current.type === 'return_statement') {
            const value = current.namedChild(0);
            if (!value) continue;
            if (value.type !== 'this') return false;
            sawSelf = true;
            continue;
        }
        for (let i = current.namedChildCount - 1; i >= 0; i--) {
            stack.push(current.namedChild(i));
        }
    }
    return sawSelf;
}

/**
 * Exact call expression returned by an expression-bodied arrow. This is a
 * syntax proof, not return-type inference: query-time flow resolves the call
 * through its ordinary import/receiver ownership rails. Block bodies,
 * conditionals, and other expressions deliberately stay unmarked.
 */
function returnedArrowCallSpan(node) {
    if (node.type !== 'arrow_function') return null;
    let body = node.childForFieldName('body');
    while (body?.type === 'parenthesized_expression' && body.namedChildCount === 1) {
        body = body.namedChild(0);
    }
    if (body?.type !== 'call_expression') return null;
    return { start: body.startIndex, end: body.endIndex };
}

/**
 * Exact `this.field...` value returned by a one-statement method body. The
 * deliberately narrow shape proves both that the member path is returned and
 * that no fallthrough/alternate return widens the compiler-inferred type.
 */
function returnedReceiverFieldPath(node) {
    const body = node.childForFieldName('body');
    if (!body || body.type !== 'statement_block' || body.namedChildCount !== 1) {
        return null;
    }
    const statement = body.namedChild(0);
    if (statement?.type !== 'return_statement' || statement.namedChildCount !== 1) {
        return null;
    }
    let value = statement.namedChild(0);
    while (value?.type === 'parenthesized_expression' && value.namedChildCount === 1) {
        value = value.namedChild(0);
    }
    const fields = [];
    while (value?.type === 'member_expression') {
        const property = value.childForFieldName('property');
        const object = value.childForFieldName('object');
        if (!property || !object ||
            !['property_identifier', 'private_property_identifier', 'identifier']
                .includes(property.type)) {
            return null;
        }
        fields.unshift(property.text);
        value = object;
    }
    return value?.type === 'this' && fields.length > 0 ? fields : null;
}

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
            const returnedConcreteType = extractReturnedConcreteType(node);
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
                ...lexicalOwnerRange(node),
                ...typeAnno,
                ...(returnedConcreteType && { returnedConcreteType }),
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
                        const paramsNode = valueNode.childForFieldName('parameters') ||
                            valueNode.childForFieldName('parameter');
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
                        const returnedCall = returnedArrowCallSpan(valueNode);

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
                            ...lexicalOwnerRange(node),
                            ...typeAnno,
                            ...(returnedCall && {
                                returnedCallStart: returnedCall.start,
                                returnedCallEnd: returnedCall.end,
                            }),
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
                            // The container's declared type (`const h: Handler =
                            // {...}`) makes each member a structural contract
                            // member of that type (fix #360: plan rename
                            // closure over interface slots).
                            const containerTypeNode = declarator.childForFieldName('type');
                            const containerType = containerTypeNode
                                ? containerTypeNode.text.replace(/^:\s*/, '').trim() : null;
                            const added = appendObjectFunctionMembers(registryObject, functions, lines, {
                                registryContainer: nameNode.text,
                                ...(containerType && { registryContainerType: containerType }),
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
        const assignedObject = leftNode?.type === 'member_expression'
            ? leftNode.childForFieldName('object') : null;
        const prototypeBase = assignedObject?.type === 'member_expression' &&
            assignedObject.childForFieldName('property')?.text === 'prototype'
            ? assignedObject.childForFieldName('object') : null;
        const prototypeOwner = prototypeBase?.type === 'identifier'
            ? prototypeBase.text : null;
        const isPrototypeAssignment = !!prototypeOwner;

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
                const isCommonJsDefault = leftNode.text === 'module.exports';
                const expressionName = isFnExpr
                    ? rightNode.childForFieldName('name')?.text : null;
                // `module.exports = function transformer(){}` exports the
                // function expression, not a symbol called "exports". Keep
                // its authored name when present; anonymous defaults use the
                // same `default` identity exposed by the API surface.
                const name = isCommonJsDefault
                    ? (expressionName || 'default')
                    : getAssignmentName(leftNode);
                if (name) {
                    processedRanges.add(rangeKey);
                    const paramsNode = rightNode.childForFieldName('parameters');
                    const { startLine, endLine, indent } = nodeToLocation(node, lines);
                    const returnType = extractReturnType(rightNode) ||
                        (prototypeOwner && returnsReceiverSelf(rightNode) ? 'this' : null);
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
                        modifiers: isCommonJsDefault ? ['export'] : [],
                        // A property-assignment def (Reply.prototype.serialize
                        // = function, exports.h = () => ...) creates NO
                        // lexical name — a bare call in the file can never
                        // bind it (fix #269, fastify-measured: the prototype
                        // def stole the module-scope binding from the free
                        // `function serialize(...)` below it). Prototype
                        // assignments carry their class so typed-receiver
                        // method resolution reaches them.
                        ...(leftNode.type === 'member_expression' && { memberAssigned: true }),
                        // One-hop member assignments record the object they
                        // patch (fix #286a: `console.log = () => {}` — the
                        // builtin-global exclusion must see cross-file that
                        // the project rebinds this global's member).
                        ...(leftNode.type === 'member_expression' &&
                            leftNode.childForFieldName('object')?.type === 'identifier' &&
                            { assignedReceiver: leftNode.childForFieldName('object').text }),
                        // Bare-name reachability of the member (fix #384): a
                        // bare call resolves lexically, then globally, so it
                        // reaches the member only when the object is the
                        // global object, or inside a self-named function
                        // expression's own body (ECMA-262 binds that name
                        // there).
                        ...(leftNode.type === 'member_expression' && (() => {
                            const kind = classifyAssignedObject(leftNode.childForFieldName('object'));
                            return kind ? { assignedObject: kind } : {};
                        })()),
                        ...(leftNode.type === 'member_expression' && expressionName === name &&
                            { selfNamed: true }),
                        ...(prototypeOwner && { className: prototypeOwner, isMethod: true }),
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
                ...(decoratorsWithArgs.some(d => d.firstStringArg) && { decoratorsWithArgs }),
                // A class declared in a function body is visible only there
                // (fix #378).
                ...(node.type !== 'class' && lexicalOwnerRange(node)),
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
            const valueNode = node.childForFieldName('value');
            // `type ZodTypeAny = ZodType<any, any, any>;` — the alias IS the
            // aliased type. Record the base name so receivers annotated with
            // the alias validate against the base type's methods (fix #208,
            // TS parity with Rust/Go).
            const aliasOf = aliasBaseTypeName(valueNode);
            // Object type aliases are structural record declarations, not
            // opaque labels. Index their declared fields just like interface
            // fields so a compiler-typed hop such as
            // `node: Node; node._source.unsubscribe()` can resolve Node's
            // `_source: Signal` contract without name guessing.
            const members = valueNode?.type === 'object_type'
                ? extractTypeMembers(valueNode, lines) : [];

            classes.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'type',
                members,
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
    const bodyNode = interfaceNode.childForFieldName('body');
    if (!bodyNode) return [];
    return extractTypeMembers(bodyNode, code);
}

function extractTypeMembers(bodyNode, code) {
    const members = [];
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
                const returnType = extractReturnType(child) ||
                    (returnsReceiverSelf(child) ? 'this' : null);
                const returnedReceiverPath = !returnType
                    ? returnedReceiverFieldPath(child) : null;
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
                    ...(returnedReceiverPath && { returnedReceiverPath }),
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
                // fix #390: a TS decorator is part of the field node; the
                // name's line is where definition edits go.
                const fieldNameLine = nameNode.startPosition.row + 1 !== startLine
                    ? { nameLine: nameNode.startPosition.row + 1 } : {};
                const valueNode = child.childForFieldName('value');
                const isArrow = valueNode && valueNode.type === 'arrow_function';
                const isStatic = Array.from({ length: child.childCount }, (_, ci) => child.child(ci))
                    .some(part => part.type === 'static');

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
                        ...fieldNameLine,
                        memberType: name.startsWith('#') ? 'private' : 'field',
                        ...(isStatic && { modifiers: ['static'] }),
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
                    // A direct identifier initializer on a static field keeps
                    // the lexical callable identity available to the IR:
                    // `static create = createSchema`. Resolution remains
                    // same-file and overload-disciplined in createFileIR;
                    // expressions, member accesses, and instance fields do
                    // not receive this proof marker.
                    const callableTarget = isStatic && valueNode?.type === 'identifier'
                        ? valueNode.text : undefined;
                    members.push({
                        name,
                        startLine,
                        endLine,
                        ...fieldNameLine,
                        memberType: name.startsWith('#') ? 'private field' : 'field',
                        ...(isStatic && { modifiers: ['static'] }),
                        ...(fieldType && { fieldType }),
                        ...(callableTarget && { callableTarget }),
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
 * Record immutable module-scope aliases of a statically named class member.
 *
 * `const make = Widget.create` preserves the member's compiler-visible
 * callable signature.  The normalized IR can therefore expose both the local
 * callable value and any `export { make as widget }` surface without guessing
 * from a later call spelling.  Mutable/local/object aliases deliberately stay
 * out: they need data-flow evidence, not a declaration-shape shortcut.
 */
function _processCallableAlias(node, aliases) {
    if (node.type !== 'lexical_declaration' || !isModuleScope(node)) return false;
    const declarationKind = node.child(0)?.text;
    if (declarationKind !== 'const') return false;

    let matched = false;
    for (let i = 0; i < node.namedChildCount; i++) {
        const declarator = node.namedChild(i);
        if (declarator.type !== 'variable_declarator') continue;
        const nameNode = declarator.childForFieldName('name');
        let valueNode = declarator.childForFieldName('value');
        if (nameNode?.type !== 'identifier' || !valueNode) continue;
        while (valueNode && ['parenthesized_expression', 'as_expression',
            'satisfies_expression', 'type_assertion'].includes(valueNode.type)) {
            valueNode = valueNode.namedChild(0);
        }
        if (valueNode?.type !== 'member_expression') continue;
        const owner = valueNode.childForFieldName('object');
        const member = valueNode.childForFieldName('property');
        if (owner?.type !== 'identifier' ||
            !['identifier', 'property_identifier'].includes(member?.type)) continue;
        aliases.push({
            name: nameNode.text,
            owner: owner.text,
            member: member.text,
            startLine: declarator.startPosition.row + 1,
            endLine: declarator.endPosition.row + 1,
        });
        matched = true;
    }
    return matched;
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
/**
 * Module-level `const` bindings of another name (fix #389): `const Alias =
 * Box;`, `export const Alias = models.Box;`. A const is bound once; query
 * time decides whether the target is a class (then `new Alias()` makes a
 * Box).
 */
function jsModuleValueAliases(root) {
    const aliases = [];
    const mutable = [];
    const declared = new Map();
    for (let statement of root.namedChildren) {
        if (statement.type === 'export_statement') {
            statement = statement.childForFieldName('declaration') ||
                statement.namedChildren.find(child => child.type === 'lexical_declaration');
        }
        if (statement?.type !== 'lexical_declaration' && statement?.type !== 'variable_declaration') continue;
        const isConst = statement.children.some(child => child.type === 'const');
        for (const declarator of statement.namedChildren) {
            if (declarator.type !== 'variable_declarator') continue;
            const nameNode = declarator.childForFieldName('name');
            if (nameNode?.type === 'identifier') declared.set(nameNode.text, (declared.get(nameNode.text) || 0) + 1);
            let value = declarator.childForFieldName('value');
            if (declarator.childForFieldName('type')) continue;
            while (value?.type === 'parenthesized_expression') value = value.namedChild(0);
            if (nameNode?.type !== 'identifier' || !value) continue;
            if ((value.type === 'identifier' || value.type === 'member_expression') &&
                /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(value.text) &&
                value.text !== nameNode.text) {
                const alias = { name: nameNode.text, target: value.text,
                    line: declarator.startPosition.row + 1 };
                if (isConst) aliases.push(alias);
                else mutable.push(alias);
            }
        }
    }
    if (mutable.length > 0) {
        // A `let`/`var` alias is the class only while nothing assigns the
        // name again (fix #392): any write to that identifier anywhere in the
        // module, or a second declaration, leaves it unbound.
        const written = new Set();
        const writeTargets = (node) => {
            if (!node) return;
            if (node.type === 'identifier') { written.add(node.text); return; }
            if (/pattern$/.test(node.type) || node.type === 'pair_pattern' ||
                node.type === 'shorthand_property_identifier_pattern') {
                if (node.type === 'shorthand_property_identifier_pattern') written.add(node.text);
                for (const child of node.namedChildren) writeTargets(child);
            }
        };
        for (const node of root.descendantsOfType(['assignment_expression',
            'augmented_assignment_expression', 'update_expression', 'for_in_statement'])) {
            if (node.type === 'update_expression') writeTargets(node.namedChild(0));
            else if (node.type === 'for_in_statement') {
                if (!node.childForFieldName('kind')) writeTargets(node.childForFieldName('left'));
            } else writeTargets(node.childForFieldName('left'));
        }
        for (const alias of mutable) {
            if (!written.has(alias.name) && declared.get(alias.name) === 1) aliases.push(alias);
        }
        aliases.sort((a, b) => a.line - b.line);
    }
    return aliases;
}

function parse(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const functions = [], classes = [], stateObjects = [], callableAliases = [];
    const processedFn = new Set(), processedCls = new Set();

    traverseTreeCached(tree.rootNode, (node) => {
        _processFunction(node, functions, processedFn, lines);
        _processClass(node, classes, processedCls, lines);
        _processState(node, stateObjects, lines);
        _processCallableAlias(node, callableAliases);
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
        const recoveredCallableAliases = [];
        for (let i = 0; i < declarationTokens.length; i++) {
            const token = declarationTokens[i];
            const next = declarationTokens[i + 1];
            if (next && next.startIndex === token.startIndex) continue;
            const fragment = code.slice(token.startIndex, next?.startIndex ?? code.length);
            if (!fragment.trim()) continue;
            const fragmentTree = parseTree(parser, fragment);
            const fragmentLines = fragment.split('\n');
            const ff = [], fc = [], fs = [], fa = [];
            const pf = new Set(), pc = new Set();
            traverseTreeCached(fragmentTree.rootNode, (node) => {
                _processFunction(node, ff, pf, fragmentLines);
                _processClass(node, fc, pc, fragmentLines);
                _processState(node, fs, fragmentLines);
                _processCallableAlias(node, fa);
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
            for (const item of fa) { shiftLines(item); recoveredCallableAliases.push(item); }
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
        const aliasKeys = new Set(callableAliases.map(alias =>
            `${alias.name}\0${alias.owner}\0${alias.member}\0${alias.startLine}`));
        for (const alias of recoveredCallableAliases) {
            const key = `${alias.name}\0${alias.owner}\0${alias.member}\0${alias.startLine}`;
            if (!aliasKeys.has(key)) {
                aliasKeys.add(key);
                callableAliases.push(alias);
            }
        }
    }

    functions.sort((a, b) => a.startLine - b.startLine);
    classes.sort((a, b) => a.startLine - b.startLine);
    stateObjects.sort((a, b) => a.startLine - b.startLine);
    callableAliases.sort((a, b) => a.startLine - b.startLine);
    const moduleValueAliases = jsModuleValueAliases(tree.rootNode);

    return {
        language: 'javascript',
        totalLines: lines.length,
        functions,
        classes,
        stateObjects,
        callableAliases,
        ...(moduleValueAliases.length > 0 && { moduleValueAliases }),
        ...(tree.rootNode.hasError && { parseRecovery: true, parseErrorRegions: parseErrorRegions(tree.rootNode) }),
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
 * Companion to tsTypeName: the namespace qualifier that owns the annotated
 * name (fix #286e — `app: ns.Flask` must carry 'ns' so two same-name classes
 * resolve by declaration origin, not directory proximity).
 */
function tsTypeQualifier(node) {
    if (!node) return undefined;
    switch (node.type) {
        case 'nested_type_identifier': {
            const last = node.namedChild(node.namedChildCount - 1);
            const start = node.startIndex;
            return last && last.startIndex > start
                ? node.text.slice(0, last.startIndex - start).replace(/\.$/, '') || undefined
                : undefined;
        }
        case 'generic_type':
            return tsTypeQualifier(node.namedChild(0));
        case 'union_type': {
            for (let i = 0; i < node.namedChildCount; i++) {
                const c = node.namedChild(i);
                if (c.type === 'nested_type_identifier' || c.type === 'generic_type') {
                    const q = tsTypeQualifier(c);
                    if (q) return q;
                }
            }
            return undefined;
        }
        case 'parenthesized_type':
            return tsTypeQualifier(node.namedChild(0));
        default:
            return undefined;
    }
}

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

function tsArrayElement(node) {
    if (!node) return null;
    if (['type_annotation', 'parenthesized_type', 'readonly_type'].includes(node.type)) {
        return tsArrayElement(node.namedChild(0));
    }
    if (node.type === 'union_type') {
        const present = node.namedChildren.filter(child =>
            !(child.type === 'literal_type' && ['null', 'undefined'].includes(child.text)));
        return present.length === 1 ? tsArrayElement(present[0]) : null;
    }
    let item = null;
    let keyed = false;
    if (node.type === 'array_type') {
        item = node.namedChild(0);
    } else if (node.type === 'generic_type') {
        // Declared container slots (fix #359): Array<T> / ReadonlyArray<T>
        // index to T; Record<K, V> keys to V.
        const base = node.childForFieldName('name') || node.namedChild(0);
        const argsNode = node.childForFieldName('type_arguments') ||
            node.namedChildren.find(child => child.type === 'type_arguments');
        const args = argsNode?.namedChildren || [];
        if (base?.type === 'type_identifier' &&
            ['Array', 'ReadonlyArray'].includes(base.text) && args.length === 1) {
            item = args[0];
        } else if (base?.type === 'type_identifier' && base.text === 'Record' &&
            args.length === 2) {
            item = args[1];
            keyed = true;
        }
    } else if (node.type === 'object_type' && node.namedChildCount === 1 &&
        node.namedChild(0).type === 'index_signature') {
        // `{ [key: string]: T }` keys to T.
        const signature = node.namedChild(0);
        const valueType = signature.childForFieldName('type');
        item = valueType?.type === 'type_annotation' ? valueType.namedChild(0) : valueType;
        keyed = true;
    }
    if (!['type_identifier', 'nested_type_identifier', 'generic_type', 'predefined_type'].includes(item?.type)) return null;
    const type = tsTypeName(item);
    return type ? { type, qualifier: tsTypeQualifier(item), node: item, ...(keyed && { keyed: true }) } : null;
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
 * For-of iteration target of a call used as the iterable:
 * `for (const x of getItems())`. The loop variable holds an ELEMENT of the
 * producer's result, never the return value — provenance only (fix #294).
 */
function jsIterTargetOf(callNode) {
    let n = callNode;
    let p = n.parent;
    if (p && p.type === 'await_expression') { n = p; p = n.parent; }
    if (!p || p.type !== 'for_in_statement') return undefined;
    if (p.childForFieldName('operator')?.text !== 'of') return undefined;
    const right = p.childForFieldName('right');
    if (!right || right.id !== n.id) return undefined;
    const left = p.childForFieldName('left');
    if (!left) return undefined;
    const names = [];
    if (left.type === 'identifier') {
        names.push(left.text);
    } else if (left.type === 'array_pattern') {
        for (let i = 0; i < left.namedChildCount; i++) {
            const c = left.namedChild(i);
            if (c.type === 'identifier') names.push(c.text);
        }
    }
    if (names.length === 0) return undefined;
    return { first: names[0], rest: names.slice(1) };
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

// CommonJS permits direct namespace calls without a local alias:
// `require('./output').formatContextJson(...)`. Preserve the literal module
// specifier on the outer call so the index can apply the same export-ownership
// rules as `const output = require('./output'); output.formatContextJson()`.
function jsLiteralRequireModule(node) {
    if (node?.type !== 'call_expression') return undefined;
    const fn = node.childForFieldName('function');
    if (fn?.type !== 'identifier' || fn.text !== 'require') return undefined;
    const args = node.childForFieldName('arguments');
    if (!args || args.namedChildCount !== 1) return undefined;
    const first = args.namedChild(0);
    return first?.type === 'string' ? first.text.slice(1, -1) : undefined;
}

function findCallsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const calls = [];
    const assignedMembers = new Set();
    const mutatedObjectRoots = new Set();
    const moduleCompositions = new Map();
    const unsafeModuleCompositions = new Set();
    const namespaceAliases = new Set();
    const arrayAnnotationNames = new Set();
    const accessRoot = (node) => {
        let current = node;
        while (current && (current.type === 'member_expression' ||
            current.type === 'subscript_expression')) {
            current = current.childForFieldName('object');
        }
        return current?.type === 'identifier' ? current.text : undefined;
    };
    // Local binding scopes by name (fix #397): every function-level
    // declaration, parameter, catch and loop binding with the source range it
    // binds in, so a reference's shadowing binding is found by range instead
    // of a parent walk; and the names object patterns bind.
    const bindingScopes = new Map(); // name -> [{ start, end, declStart, line }]
    const destructuredNames = new Set();
    const addScope = (pattern, scope, declStart, line) => {
        const names = [];
        collectBoundPatternNames(pattern, names);
        for (const n of names) {
            let list = bindingScopes.get(n);
            if (!list) { list = []; bindingScopes.set(n, list); }
            list.push({ start: scope.startIndex, end: scope.endIndex, declStart, line });
        }
    };
    traverseTreeCached(tree.rootNode, node => {
        switch (node.type) {
            case 'variable_declarator': {
                const statement = node.parent;
                const host = statement?.parent;
                if (host?.type === 'statement_block') {
                    // A declarator initialized from require()/import() is the
                    // module's binding reaching the scope, not a shadow (#337).
                    if (!isImportInitializerNode(node.childForFieldName('value'))) {
                        addScope(node.childForFieldName('name'), host, statement.startIndex,
                            statement.startPosition.row + 1);
                    }
                } else if (host?.type === 'for_statement' || host?.type === 'for_in_statement') {
                    addScope(node.childForFieldName('name'), host, null, -1);
                }
                break;
            }
            case 'formal_parameters':
                if (node.parent && JS_SHADOW_FUNCTIONS.has(node.parent.type)) addScope(node, node.parent, null, -1);
                break;
            case 'arrow_function': {
                const single = node.childForFieldName('parameter');
                if (single) addScope(single, node, null, -1);
                break;
            }
            case 'catch_clause': {
                const param = node.childForFieldName('parameter');
                if (param) addScope(param, node, null, -1);
                break;
            }
            case 'for_in_statement': {
                const left = node.childForFieldName('left');
                if (left && left.type !== 'lexical_declaration' && left.type !== 'variable_declaration') {
                    addScope(left, node, null, -1);
                }
                break;
            }
            case 'function_declaration': case 'generator_function_declaration': case 'class_declaration':
                if (node.parent?.type === 'statement_block') {
                    const nameNode = node.childForFieldName('name');
                    // Hoisted within the block: shadows at any position.
                    if (nameNode) addScope(nameNode, node.parent, null, node.startPosition.row + 1);
                }
                break;
            case 'object_pattern':
                for (let i = 0; i < node.namedChildCount; i++) {
                    const prop = node.namedChild(i);
                    if (prop.type === 'shorthand_property_identifier_pattern') destructuredNames.add(prop.text);
                    else if (prop.type === 'object_assignment_pattern') {
                        const left = prop.childForFieldName('left');
                        if (left) destructuredNames.add(left.text);
                    } else if (prop.type === 'pair_pattern') {
                        let value = prop.childForFieldName('value');
                        if (value?.type === 'assignment_pattern') value = value.childForFieldName('left');
                        if (value?.type === 'identifier') destructuredNames.add(value.text);
                    }
                }
                break;
            default:
                break;
        }
        if (['variable_declarator', 'required_parameter', 'optional_parameter'].includes(node.type)) {
            const name = node.childForFieldName('name') || node.childForFieldName('pattern');
            if (name?.type === 'identifier' && tsArrayElement(node.childForFieldName('type'))) {
                arrayAnnotationNames.add(name.text);
            }
        }
        if (node.type === 'namespace_import') {
            const identifier = node.namedChild(0);
            if (identifier?.type === 'identifier') namespaceAliases.add(identifier.text);
        }
        if (node.type === 'variable_declarator') {
            const declaration = node.parent;
            const nameNode = node.childForFieldName('name');
            const valueNode = node.childForFieldName('value');
            if (nameNode?.type === 'identifier' && valueNode?.type === 'object' &&
                declaration?.type === 'lexical_declaration' &&
                declaration.child(0)?.text === 'const' && isModuleScope(declaration)) {
                const layers = [];
                let spreadCandidates = 0;
                for (let i = 0; i < valueNode.namedChildCount; i++) {
                    const item = valueNode.namedChild(i);
                    if (item.type === 'spread_element') {
                        const value = item.namedChild(0);
                        if (value?.type === 'identifier') {
                            // Namespace imports may legally appear later in
                            // the module. Resolve candidates after this pass
                            // has seen the complete import surface.
                            layers.push({ kind: 'spread-candidate', receiver: value.text });
                            spreadCandidates++;
                        } else {
                            layers.push({ kind: 'unknown' });
                        }
                        continue;
                    }
                    if (item.type === 'pair') {
                        const key = item.childForFieldName('key');
                        const staticKey = key && ['property_identifier', 'identifier', 'string']
                            .includes(key.type)
                            ? key.text.replace(/^['"]|['"]$/g, '') : null;
                        layers.push(staticKey
                            ? { kind: 'property', name: staticKey }
                            : { kind: 'unknown' });
                        continue;
                    }
                    if (item.type === 'shorthand_property_identifier' ||
                        item.type === 'method_definition') {
                        const name = item.type === 'method_definition'
                            ? item.childForFieldName('name')?.text : item.text;
                        layers.push(name
                            ? { kind: 'property', name }
                            : { kind: 'unknown' });
                        continue;
                    }
                    layers.push({ kind: 'unknown' });
                }
                if (spreadCandidates > 0) moduleCompositions.set(nameNode.text, layers);
            }
        }
        if (node.type === 'assignment_expression' ||
            node.type === 'augmented_assignment_expression') {
            const left = node.childForFieldName('left');
            if (left?.type === 'member_expression') assignedMembers.add(left.text);
            const root = accessRoot(left);
            if (root) mutatedObjectRoots.add(root);
        }
        // A namespace-spread composite is exact only while the ordinary
        // object remains private and unmodified. Any use of the object value
        // itself (export, alias, return, argument, spread, etc.) can expose a
        // mutation; property reads/calls are the sole accepted uses.
        if (node.type !== 'identifier' || !moduleCompositions.has(node.text)) return true;
        const parent = node.parent;
        if (parent?.type === 'variable_declarator' &&
            parent.childForFieldName('name')?.id === node.id) return true;
        if ((parent?.type === 'member_expression' ||
            parent?.type === 'subscript_expression') &&
            parent.childForFieldName('object')?.id === node.id) {
            let access = parent;
            while ((access.parent?.type === 'member_expression' ||
                access.parent?.type === 'subscript_expression') &&
                access.parent.childForFieldName('object')?.id === access.id) {
                access = access.parent;
            }
            const container = access.parent;
            const assigned = (container?.type === 'assignment_expression' ||
                container?.type === 'augmented_assignment_expression') &&
                container.childForFieldName('left')?.id === access.id;
            const updated = container?.type === 'update_expression';
            const deleted = container?.type === 'unary_expression' &&
                container.child(0)?.text === 'delete';
            if (!assigned && !updated && !deleted) return true;
        }
        unsafeModuleCompositions.add(node.text);
        return true;
    });
    for (const [name, layers] of moduleCompositions) {
        const normalized = layers.map(layer => layer.kind === 'spread-candidate'
            ? (namespaceAliases.has(layer.receiver)
                ? { kind: 'spread', receiver: layer.receiver }
                : { kind: 'unknown' })
            : layer);
        if (normalized.some(layer => layer.kind === 'spread')) {
            moduleCompositions.set(name, normalized);
        } else {
            moduleCompositions.delete(name);
        }
    }
    for (const name of mutatedObjectRoots) unsafeModuleCompositions.add(name);
    const functionStack = [];  // Stack of { name, startLine, endLine }
    // Local aliases with lexical ownership. A flat aliasName→target map leaks
    // block locals into the rest of a module (`let effect = batchedEffect`
    // inside a loop rewrote a later module-level `effect()` call), producing
    // false external edges and caller/callee disagreement.
    const aliases = new Map();  // aliasName -> [{ target, declarationIndex, scopeStart, scopeEnd }]
    const nonCallableNames = new Set();  // Track names assigned non-callable values
    const localVarTypes = new ReceiverTypeMap();  // Track local variable types: varName -> typeName (for receiverType inference)
    // One-hop `const` aliases of member paths (fix #381):
    // `const c = this.config; c.load()` receives through `this.config`.
    // name -> { node: the aliased member_expression, scope: declaring block }.
    const localFieldAliases = new Map();
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

    // fix #366: request-config calls — `request(cfg, { method: 'POST',
    // url: '/api/users' })`, `client.post({ url: '/api/items' })` (generated
    // OpenAPI SDKs). Returns { url, interp, method? } for the first object
    // literal argument carrying a string `url`/`path` property. Whether the
    // callee really performs HTTP is decided at query time from the callee's
    // definition, never from this record.
    const getRequestConfig = (callNode) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return null;
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type !== 'object') continue;
            let url = null;
            let method = null;
            let handler = null;
            for (let j = 0; j < arg.namedChildCount; j++) {
                const prop = arg.namedChild(j);
                if (prop.type !== 'pair') continue;
                const keyNode = prop.childForFieldName('key');
                const valNode = prop.childForFieldName('value');
                if (!keyNode || !valNode) continue;
                const keyName = keyNode.type === 'string'
                    ? keyNode.text.replace(/^['"`]|['"`]$/g, '') : keyNode.text;
                if ((keyName === 'url' || keyName === 'path') && !url) {
                    const v = _extractStringArg(valNode);
                    if (v && typeof v.value === 'string' && v.value.length > 0) {
                        url = { value: v.value, interp: !!v.interp, key: keyName };
                    }
                } else if (keyName === 'method') {
                    const v = _extractStringArg(valNode);
                    if (v && !v.interp && typeof v.value === 'string' && v.value.length > 0) {
                        method = v.value.toUpperCase();
                    }
                } else if (keyName === 'handler') {
                    // fix #383: `route({ method, url, handler })` names its handler.
                    handler = handlerNameOf(valNode);
                }
            }
            if (url) {
                return { url: url.value, key: url.key, ...(url.interp && { interp: true }),
                    ...(method && { method }), ...(handler && { handler }) };
            }
        }
        return null;
    };

    // fix #383: the arguments of a route-shaped registration
    // (`app.get('/x', mw, handler)`) after its path: each argument's name,
    // '<anonymous>' for an inline function, the callee's name for a call
    // (`wrap(handler)`), null for any other expression.
    const ROUTE_VERB_METHODS = /^(get|post|put|delete|patch|options|head|all)$/;
    const handlerNameOf = (node) => {
        if (!node) return null;
        if (node.type === 'identifier') return node.text;
        if (node.type === 'member_expression') return node.childForFieldName('property')?.text || null;
        if (/function|arrow/.test(node.type)) return '<anonymous>';
        if (node.type === 'call_expression') {
            const fn = node.childForFieldName('function');
            if (fn?.type === 'identifier') return fn.text;
            if (fn?.type === 'member_expression') return fn.childForFieldName('property')?.text || null;
        }
        return null;
    };
    // The names of a registration's arguments after its path (null for an
    // expression with no name); the router decides which one is the handler.
    const getHandlerArgs = (callNode) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return null;
        const out = [];
        let first = true;
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type.endsWith('comment')) continue;
            if (first) { first = false; continue; }
            out.push(handlerNameOf(arg));
        }
        return out.length > 0 ? out : null;
    };

    const hasObjectKeyArg = (callNode, key) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return false;
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type !== 'object') continue;
            for (let j = 0; j < arg.namedChildCount; j++) {
                const prop = arg.namedChild(j);
                const keyNode = prop.type === 'pair' ? prop.childForFieldName('key') : prop;
                if (keyNode && keyNode.text.replace(/^['"`]|['"`]$/g, '') === key) return true;
            }
        }
        return false;
    };

    const getMountArgs = (callNode) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return null;
        const out = [];
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type.endsWith('comment')) continue;
            if (arg.type === 'identifier') out.push(arg.text);
            else if (arg.type === 'string' || (arg.type === 'template_string' && arg.namedChildCount <= 1)) out.push('""');
            else if (arg.type.includes('function')) out.push('fn');
            else out.push('()');
        }
        return out;
    };

    // fix #366: `x.register(plugin, { prefix: '/v1' })` (Fastify plugin
    // mounts). Records the prefix option (literal, or `prefixDynamic` for an
    // expression) and, for an inline plugin function, its span and first
    // parameter - the router the plugin registers routes on. Returns null
    // when the call carries neither.
    const getRegisterMount = (callNode) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return null;
        const args = [];
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (!arg.type.endsWith('comment')) args.push(arg);
        }
        if (args.length === 0) return null;
        const out = {};
        const opts = args[1];
        if (opts && opts.type === 'object') {
            for (let j = 0; j < opts.namedChildCount; j++) {
                const prop = opts.namedChild(j);
                const keyNode = prop.type === 'pair' ? prop.childForFieldName('key') : prop;
                if (!keyNode || keyNode.text.replace(/^['"`]|['"`]$/g, '') !== 'prefix') continue;
                const v = prop.type === 'pair' ? _extractStringArg(prop.childForFieldName('value')) : null;
                if (v && !v.interp && typeof v.value === 'string') out.prefix = v.value;
                else out.prefixDynamic = true;
            }
        } else if (opts) {
            out.prefixDynamic = true;
        }
        let plugin = args[0];
        // `register(fp(function (instance) {...}))`: a wrapper call around an
        // inline plugin function registers that function.
        if (plugin.type === 'call_expression') {
            const inner = plugin.childForFieldName('arguments')?.namedChild(0);
            if (inner && ['arrow_function', 'function_expression', 'function'].includes(inner.type)) plugin = inner;
        }
        if (['arrow_function', 'function_expression', 'function'].includes(plugin.type)) {
            const params = plugin.childForFieldName('parameters') || plugin.childForFieldName('parameter');
            let first = params && params.type === 'identifier' ? params : null;
            if (!first && params) {
                for (let i = 0; i < params.namedChildCount; i++) {
                    const p = params.namedChild(i);
                    if (p.type.endsWith('comment')) continue;
                    const pat = p.type === 'identifier' ? p : p.childForFieldName('pattern');
                    first = pat && pat.type === 'identifier' ? pat : null;
                    break;
                }
            }
            if (first) {
                out.plugin = { start: plugin.startIndex, end: plugin.endIndex, param: first.text };
            }
        } else if (plugin.type === 'identifier') {
            // A named plugin: a same-file function composes from the index;
            // anything else is resolved by the endpoints graph.
            out.pluginName = plugin.text;
        } else if (plugin.type === 'member_expression' || plugin.type === 'call_expression') {
            out.pluginRef = true;
        }
        return (out.prefix != null || out.prefixDynamic || out.plugin || out.pluginRef || out.pluginName)
            ? out : null;
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
            ? {
                ...functionStack[functionStack.length - 1],
                scopeChain: functionStack.map(scope => scope.startLine),
            }
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
        // TypeScript parameter wrappers contain both the runtime binding
        // pattern and a type annotation. Only the pattern declares names:
        // `metadata: registries.GlobalMeta` must not make the namespace
        // identifier `registries` look like a shadowing parameter.
        if (pattern.type === 'required_parameter' ||
            pattern.type === 'optional_parameter') {
            return _patternDeclaresName(
                pattern.childForFieldName('pattern') ||
                pattern.childForFieldName('name'), name);
        }
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

    // Resolve the actual lexical declaration for an indexed receiver. Keep
    // untyped bindings too: a shadow must stop an outer annotation from
    // leaking into a nested function or block. This lookup is cached per
    // spelling and used only for bracket receivers, not every ordinary call.
    const indexedBindings = new Map();
    const indexedBinding = (name, site) => {
        if (!indexedBindings.has(name)) {
            const records = [];
            const add = (pattern, declaration, scope) => {
                if (!scope || !_patternDeclaresName(pattern, name)) return;
                records.push({ declaration, scope, type: pattern?.type === 'identifier'
                    ? declaration.childForFieldName('type') : null });
            };
            traverseTree(tree.rootNode, current => {
                if (current.type === 'variable_declarator') {
                    add(current.childForFieldName('name'), current, aliasScope(current));
                } else if (isFunctionNode(current)) {
                    const parameters = current.childForFieldName('parameters');
                    for (const parameter of parameters?.namedChildren || []) {
                        const pattern = parameter.childForFieldName('pattern') ||
                            parameter.childForFieldName('name') || parameter;
                        add(pattern, parameter, current);
                    }
                    const lone = current.childForFieldName('parameter');
                    if (lone) add(lone, lone, current);
                    const fnName = current.childForFieldName('name');
                    if (fnName?.text === name) add(fnName, current,
                        current.type === 'function_declaration' ? current.parent : current);
                } else if (current.type === 'catch_clause') {
                    add(current.childForFieldName('parameter'), current, current);
                }
                return true;
            });
            indexedBindings.set(name, records);
        }
        const matches = indexedBindings.get(name).filter(record =>
            record.scope.startIndex <= site.startIndex && record.scope.endIndex >= site.endIndex)
            .sort((a, b) => (a.scope.endIndex - a.scope.startIndex) - (b.scope.endIndex - b.scope.startIndex));
        const nearest = matches[0];
        if (!nearest || nearest.declaration.startIndex > site.startIndex ||
            (matches[1] && matches[1].scope.id === nearest.scope.id)) return null;
        return nearest;
    };
    const indexedArrayReceiver = object => {
        if (object?.type !== 'subscript_expression') return null;
        const root = object.childForFieldName('object');
        const offset = object.childForFieldName('index');
        if (root?.type !== 'identifier' || !arrayAnnotationNames.has(root.text) || !offset) return null;
        const binding = indexedBinding(root.text, object);
        const element = tsArrayElement(binding?.type);
        // A keyed container (Record / index signature) accepts any key; an
        // array index must be numeric (a string key reads a property).
        let numeric = offset.type === 'number' || !!element?.keyed;
        if (offset.type === 'identifier' && !element?.keyed) {
            const indexBinding = indexedBinding(offset.text, object);
            const annotation = indexBinding?.type?.namedChild(0);
            numeric = annotation?.type === 'predefined_type' && annotation.text === 'number';
            if (!annotation && indexBinding?.declaration.childForFieldName('value')?.type === 'number') {
                numeric = localVarTypes.get(offset.text) === 'Number';
            }
        }
        if (!numeric) return null;
        if (element && !element.qualifier) {
            for (let scope = binding.declaration.parent; scope; scope = scope.parent) {
                const parameters = scope.childForFieldName('type_parameters');
                if (parameters?.namedChildren.some(parameter =>
                    (parameter.childForFieldName('name')?.text || parameter.text) === element.type)) return null;
            }
        }
        return element && { ...element,
            evidence: { ...typeOrigin('annotation', binding.type), projection: 'array-element',
                container: root.text, elementType: element.node.text,
                index: { start: offset.startIndex, end: offset.endIndex, nodeType: offset.type } } };
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
    // fix #337: a declarator initialized from require()/import() is an
    // IMPORT binding — the module's own name reaching this scope — not a
    // local shadow. `function build() { const { Foo } = require('./lib');
    // new Foo() }` resolves through import ownership exactly like the
    // top-level require the walk already exempts as the module binding
    // itself. Unwraps `await import()`, parens, and `require('./x').Foo`.
    const _isImportBindingInitializer = (value) => {
        let v = value;
        for (;;) {
            if (!v) return false;
            if (v.type === 'await_expression' || v.type === 'parenthesized_expression') {
                v = v.namedChild(0);
                continue;
            }
            if (v.type === 'member_expression' || v.type === 'subscript_expression') {
                v = v.childForFieldName('object');
                continue;
            }
            break;
        }
        if (v.type !== 'call_expression') return false;
        const fn = v.childForFieldName('function');
        return !!fn && (fn.type === 'import' || (fn.type === 'identifier' && fn.text === 'require'));
    };

    // Bare callback references need to distinguish a module-owned VALUE from
    // an unbound name. File-level import reachability cannot prove the value's
    // identity: `const app = express(); use(app)` may live in a file that also
    // imports the pinned target, but `app` is the factory result rather than a
    // direct lexical reference to that target. Keep the parser evidence exact
    // and cheap by collecting only declarations whose lexical owner is the
    // program/module root (export wrappers included).
    const moduleValueBindings = new Set();
    const collectPatternNames = (pattern) => {
        if (!pattern) return;
        if (pattern.type === 'identifier' ||
            pattern.type === 'shorthand_property_identifier_pattern') {
            moduleValueBindings.add(pattern.text);
            return;
        }
        if (pattern.type === 'pair_pattern' || pattern.type === 'pair') {
            collectPatternNames(pattern.childForFieldName('value'));
            return;
        }
        if (pattern.type === 'assignment_pattern') {
            collectPatternNames(
                pattern.childForFieldName('left') || pattern.childForFieldName('pattern'));
            return;
        }
        for (let i = 0; i < pattern.namedChildCount; i++) {
            collectPatternNames(pattern.namedChild(i));
        }
    };
    const collectModuleDeclaration = (statement) => {
        let declaration = statement;
        if (statement.type === 'export_statement') {
            declaration = null;
            for (let i = 0; i < statement.namedChildCount; i++) {
                const child = statement.namedChild(i);
                if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
                    declaration = child;
                    break;
                }
            }
        }
        if (!declaration ||
            (declaration.type !== 'lexical_declaration' &&
                declaration.type !== 'variable_declaration')) return;
        for (let i = 0; i < declaration.namedChildCount; i++) {
            const declarator = declaration.namedChild(i);
            if (declarator.type === 'variable_declarator') {
                collectPatternNames(declarator.childForFieldName('name'));
            }
        }
    };
    for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
        collectModuleDeclaration(tree.rootNode.namedChild(i));
    }

    // fix #203: is a bare-identifier function REFERENCE shadowed by a
    // let/const/var local, for/catch binding, or inner-arrow param in an
    // enclosing lexical scope? Block-accurate, declaration-before-use.
    // The enclosing SYMBOL's params are checked at query time in
    // findCallers — let locals and non-symbol arrow params are only
    // visible here. Module-level (program) declarations are NOT shadows:
    // that's the module binding itself, owned by binding resolution.
    // Returns the 1-based line of the shadowing declaration statement, -1
    // for a parameter / catch / loop binding (never an indexed definition),
    // 0 when the name is not shadowed. The declaration line lets the query
    // tell a shadow that IS the pinned definition (declared in any
    // enclosing function of the reference, fix #397) from an unrelated
    // local. Statement lists read their memoized binding tables: hoisted
    // function/class declarations shadow anywhere in the block, lexical and
    // var declarations from their statement on; a declarator initialized
    // from require()/import() is the module's binding, not a shadow (#337).
    // The innermost binding scope containing the reference: a hoisted
    // function/class declaration anywhere in its block, a lexical or var
    // declaration from its statement on, a parameter / catch / loop binding
    // anywhere in its function or statement.
    const shadowingLineOf = (refNode, name) => {
        const scopes = bindingScopes.get(name);
        if (!scopes) return 0;
        const at = refNode.startIndex;
        let best = null;
        for (const scope of scopes) {
            if (at < scope.start || at >= scope.end) continue;
            if (scope.declStart != null && scope.declStart >= at) continue;
            if (!best || scope.end - scope.start < best.end - best.start) best = scope;
        }
        return best ? best.line : 0;
    };
    const isShadowedByLocal = (refNode, name) => shadowingLineOf(refNode, name) !== 0;
    // `localShadow` holds the shadowing declaration's line (-1 for a
    // parameter / catch / loop binding): truthy like the other languages'
    // `true`, and the query compares the line with the pinned definition.
    const localShadowFields = (refNode, name) => {
        const line = shadowingLineOf(refNode, name);
        return line !== 0 ? { localShadow: line } : null;
    };

    // The aliased member expression when `refNode` names a live one-hop
    // const alias: inside the declaring block, after the declaration, and
    // not shadowed by a parameter or declaration in between (fix #381).
    const localFieldAliasAt = (refNode) => {
        const alias = localFieldAliases.get(refNode.text);
        if (!alias || refNode.startIndex < alias.node.endIndex ||
            refNode.startIndex < alias.scope.startIndex ||
            refNode.endIndex > alias.scope.endIndex) return null;
        const name = refNode.text;
        for (let p = refNode.parent; p && p.id !== alias.scope.id; p = p.parent) {
            if (p.type === 'statement_block') {
                for (let i = 0; i < p.namedChildCount; i++) {
                    const stmt = p.namedChild(i);
                    if ((stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') &&
                        _declaresName(stmt, name)) return null;
                    if ((stmt.type === 'function_declaration' || stmt.type === 'class_declaration' ||
                        stmt.type === 'generator_function_declaration') &&
                        stmt.childForFieldName('name')?.text === name) return null;
                }
            } else if (p.type === 'for_statement' || p.type === 'for_in_statement') {
                const left = p.childForFieldName('initializer') || p.childForFieldName('left');
                if (left && (_patternDeclaresName(left, name) ||
                    ((left.type === 'lexical_declaration' || left.type === 'variable_declaration') &&
                        _declaresName(left, name)))) return null;
            } else if (p.type === 'catch_clause') {
                if (_patternDeclaresName(p.childForFieldName('parameter'), name)) return null;
            } else if (isFunctionNode(p)) {
                const params = p.childForFieldName('parameters') || p.childForFieldName('parameter');
                if (params && (_patternDeclaresName(params, name) ||
                    params.namedChildren.some(prm => _patternDeclaresName(prm, name)))) return null;
            }
        }
        return alias.node;
    };

    // Receiver facts of a member access `objNode.propName` (the receiver
    // half of a method-call record). Shared by method calls and by bare
    // calls of names destructured from an object (fix #397), which read the
    // member of the destructuring source.
    const memberReceiverFacts = (objNode, propName) => {
        // Extract receiver: handles identifiers (obj), this, super
        let receiver = undefined;
        // fix #381: `c.load()` after `const c = this.config`
        // receives exactly like `this.config.load()` while the
        // const is the binding in scope.
        const aliasedReceiver = objNode?.type === 'identifier' &&
            !localVarTypes.has(objNode.text)
            ? localFieldAliasAt(objNode) : null;
        if (aliasedReceiver) objNode = aliasedReceiver;
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
        let receiverDeepPath = false;
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
            } else {
                // Preserve unresolved deeper member chains
                // (`client.req.query()`). Their terminal name
                // must not borrow a same-file method binding
                // while the root object's type is unknown.
                receiverDeepPath = true;
            }
        }
        // Chained receiver (fix #219): the receiver IS a call —
        // parseAsync(args).catch(...) — record the producer so
        // findCallers can type the receiver from its declared
        // return annotation (Promise<...> → Promise).
        let receiverCall, receiverCallIsMethod, receiverCallAwaited, receiverCallLine;
        let receiverCallStart, receiverCallEnd;
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
                    receiverCallStart = recvNode.startIndex;
                    receiverCallEnd = recvNode.endIndex;
                } else if (prodFunc?.type === 'member_expression') {
                    const prodProp = prodFunc.childForFieldName('property');
                    if (prodProp) {
                        receiverCall = prodProp.text;
                        receiverCallIsMethod = true;
                        // Method records report the property
                        // node's own line
                        receiverCallLine = prodProp.startPosition.row + 1;
                        receiverCallStart = recvNode.startIndex;
                        receiverCallEnd = recvNode.endIndex;
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
        const indexedReceiver = indexedArrayReceiver(objNode);
        const receiverType = indexedReceiver?.type || (receiver
            ? localVarTypes.get(receiver)
            : (constructedReceiverType ||
                (objNode ? JS_LITERAL_RECEIVER_TYPES[objNode.type] : undefined)));
        // Module receiver (ns.helper()) — unless locally shadowed
        // by a typed instance binding
        const receiverModuleSpecifier = jsLiteralRequireModule(objNode);
        const receiverIsModule = !!receiverModuleSpecifier ||
            (!!receiver && moduleAliases.has(receiver) &&
                !localVarTypes.has(receiver));
        const receiverModuleComposition = receiver &&
            !unsafeModuleCompositions.has(receiver)
            ? moduleCompositions.get(receiver) : undefined;
        return {
            receiver,
            ...(receiverType && { receiverType,
                ...(indexedReceiver ? { receiverTypeSource: 'annotation',
                    receiverTypeEvidence: indexedReceiver.evidence }
                    : receiver ? localVarTypes.fields(receiver, receiverType) : {
                    receiverTypeSource: constructedReceiverType ? 'constructor' : 'literal',
                    receiverTypeEvidence: typeOrigin(constructedReceiverType ? 'constructor' : 'literal', objNode),
                }),
            }),
            ...((indexedReceiver?.qualifier || constructedReceiverQualifier ||
                (receiver && localVarTypeQualifiers.get(receiver))) && {
                receiverTypeQualifier: indexedReceiver?.qualifier || constructedReceiverQualifier ||
                    localVarTypeQualifiers.get(receiver),
            }),
            ...(receiverIsModule && { receiverIsModule: true }),
            ...(receiverModuleSpecifier && { receiverModuleSpecifier }),
            ...(receiverModuleComposition && {
                receiverModuleComposition,
            }),
            ...(receiver && assignedMembers.has(`${receiver}.${propName}`) && {
                receiverMemberAssigned: true,
            }),
            ...(receiverBindingNode &&
                isShadowedByLocal(receiverBindingNode, receiverBindingNode.text) &&
                { receiverLocalBinding: true }),
            ...(receiverFieldName && { receiverRoot, receiverField: receiverFieldName }),
            ...(receiverFieldName && receiverRootType && { receiverRootType }),
            ...(receiverDeepPath && { receiverDeepPath: true }),
            ...(receiverCall && { receiverCall }),
            ...(receiverCallIsMethod && { receiverCallIsMethod: true }),
            ...(receiverCallAwaited && { receiverCallAwaited: true }),
            ...(receiverCallLine && { receiverCallLine }),
            ...(receiverCallStart != null && { receiverCallStart }),
            ...(receiverCallEnd != null && { receiverCallEnd }),
        };
    };

    // Destructured member bindings (fix #397, immer-measured: `const {
    // produce } = createPatchedImmer()` then `produce(...)` lost every
    // caller). An object-pattern binding holds the MEMBER of its source
    // object: `const { run } = make(); run()` reads `make().run`, so the bare
    // call is that member access. Names some object pattern binds, so the
    // lexical lookup below runs only for them.
    // The node declaring `name` in a declaration / parameter pattern.
    const patternBindingNode = (pattern, name) => {
        if (!pattern) return null;
        if (pattern.type === 'required_parameter' || pattern.type === 'optional_parameter') {
            return patternBindingNode(pattern.childForFieldName('pattern') ||
                pattern.childForFieldName('name'), name);
        }
        if (pattern.type === 'identifier' || pattern.type === 'shorthand_property_identifier_pattern') {
            return pattern.text === name ? pattern : null;
        }
        if (pattern.type === 'pair_pattern' || pattern.type === 'pair') {
            return patternBindingNode(pattern.childForFieldName('value'), name);
        }
        if (pattern.type === 'assignment_pattern' || pattern.type === 'object_assignment_pattern') {
            return patternBindingNode(pattern.childForFieldName('left') ||
                pattern.childForFieldName('pattern'), name);
        }
        if (pattern.type === 'type_annotation' || pattern.type === 'predefined_type') return null;
        for (let i = 0; i < pattern.namedChildCount; i++) {
            const found = patternBindingNode(pattern.namedChild(i), name);
            if (found) return found;
        }
        return null;
    };
    const declarationBindingNode = (declaration, name) => {
        for (let i = 0; i < declaration.namedChildCount; i++) {
            const declarator = declaration.namedChild(i);
            if (declarator.type !== 'variable_declarator') continue;
            const found = patternBindingNode(declarator.childForFieldName('name'), name);
            if (found) return found;
        }
        return null;
    };
    // The innermost lexical binding of `name` visible at `refNode`: the
    // declaring identifier / shorthand pattern node, or a marker for a
    // binding that is not a variable pattern (function, class, import,
    // named function expression). Within the declaring block a let/const
    // must precede the reference; from a nested function any position of
    // the block counts (the closure runs after the block is initialized).
    const innermostBinding = (refNode, name) => {
        let crossedFunction = false;
        for (let p = refNode.parent; p; p = p.parent) {
            if (p.type === 'statement_block' || p.type === 'program') {
                for (let i = 0; i < p.namedChildCount; i++) {
                    let stmt = p.namedChild(i);
                    if (stmt.type === 'export_statement') {
                        stmt = stmt.childForFieldName('declaration') || stmt.namedChild(0);
                        if (!stmt) continue;
                    }
                    if ((stmt.type === 'function_declaration' ||
                        stmt.type === 'generator_function_declaration' ||
                        stmt.type === 'class_declaration') &&
                        stmt.childForFieldName('name')?.text === name) return { other: true };
                    if (stmt.type === 'import_statement' && p.type === 'program') {
                        const clause = stmt.namedChildren.find(c => c.type === 'import_clause');
                        if (clause && clause.descendantsOfType(['identifier']).some(id => id.text === name)) {
                            return { other: true };
                        }
                        continue;
                    }
                    if (stmt.type !== 'lexical_declaration' && stmt.type !== 'variable_declaration') continue;
                    if (!crossedFunction && stmt.startIndex >= refNode.startIndex) continue;
                    const found = declarationBindingNode(stmt, name);
                    if (found) return { node: found };
                }
            } else if (p.type === 'for_statement') {
                const init = p.childForFieldName('initializer');
                if (init && (init.type === 'lexical_declaration' || init.type === 'variable_declaration')) {
                    const found = declarationBindingNode(init, name);
                    if (found) return { node: found };
                }
            } else if (p.type === 'for_in_statement') {
                const left = p.childForFieldName('left');
                const found = left && (patternBindingNode(left, name) ||
                    ((left.type === 'lexical_declaration' || left.type === 'variable_declaration')
                        ? declarationBindingNode(left, name) : null));
                if (found) return { node: found };
            } else if (p.type === 'catch_clause') {
                const found = patternBindingNode(p.childForFieldName('parameter'), name);
                if (found) return { node: found };
            } else if (isFunctionNode(p)) {
                const params = p.childForFieldName('parameters') || p.childForFieldName('parameter');
                const found = params && patternBindingNode(params, name);
                if (found) return { node: found };
                if ((p.type === 'function_expression' || p.type === 'function') &&
                    p.childForFieldName('name')?.text === name) return { other: true };
                crossedFunction = true;
            } else if (p.type === 'class' && p.childForFieldName('name')?.text === name) {
                return { other: true };
            }
        }
        return null;
    };
    // The destructuring that binds `name` at `refNode`, when the innermost
    // binding is an object-pattern property whose source is not an import
    // (`const { f } = require('./m')` stays an import binding): the property
    // key, its position, and the receiver facts of the source object read as
    // `source.key`. A parameter pattern's source is the argument (typed by a
    // plain TS annotation when present); nested patterns, loop and catch
    // bindings and defaulted properties have an unknown source.
    const destructuredBindingOf = (refNode, name) => {
        if (!destructuredNames.has(name)) return null;
        const binding = innermostBinding(refNode, name);
        const node = binding?.node;
        if (!node) return null;
        let keyNode = null;
        let shorthand = false;
        let hasDefault = false;
        let property = node;
        if (node.type === 'shorthand_property_identifier_pattern') {
            keyNode = node;
            shorthand = true;
            if (node.parent?.type === 'object_assignment_pattern') {
                hasDefault = true;
                property = node.parent;
            }
        } else if (node.type === 'identifier') {
            let holder = node.parent;
            if (holder?.type === 'assignment_pattern' &&
                sameNode(holder.childForFieldName('left'), node)) {
                hasDefault = true;
                holder = holder.parent;
            }
            if (holder?.type !== 'pair_pattern') return null;
            const key = holder.childForFieldName('key');
            if (!key || (key.type !== 'property_identifier' && key.type !== 'identifier')) return null;
            keyNode = key;
            property = holder;
        }
        const pattern = property.parent;
        if (!keyNode || pattern?.type !== 'object_pattern') return null;
        let holder = pattern.parent;
        let facts = null;
        let sourceKind = 'unknown';
        if (holder?.type === 'variable_declarator' &&
            sameNode(holder.childForFieldName('name'), pattern)) {
            const value = holder.childForFieldName('value');
            if (!value || _isImportBindingInitializer(value)) return null;
            if (!hasDefault) {
                facts = memberReceiverFacts(value, keyNode.text);
                sourceKind = 'value';
            }
        } else {
            let typeNode = null;
            if (holder?.type === 'assignment_pattern' && sameNode(holder.childForFieldName('left'), pattern)) {
                holder = holder.parent;
            }
            if (holder?.type === 'required_parameter' || holder?.type === 'optional_parameter') {
                typeNode = holder.childForFieldName('type');
                holder = holder.parent;
            }
            if (holder?.type === 'formal_parameters') {
                sourceKind = 'parameter';
                const written = typeNode?.namedChild(0);
                if (!hasDefault && written?.type === 'type_identifier') {
                    facts = { receiverType: written.text, receiverTypeSource: 'annotation',
                        receiverTypeEvidence: typeOrigin('annotation', written) };
                }
            }
        }
        return {
            key: keyNode.text,
            line: keyNode.startPosition.row + 1,
            column: keyNode.startPosition.column,
            ...(shorthand && { shorthand: true }),
            source: sourceKind,
            receiver: facts || { receiverDeepPath: true },
        };
    };
    // A method taken as a value (fix #397, immer-measured: `export const
    // produce = immer.produce`): a paren-less member access stored by a
    // declaration or assignment names the member exactly like a call on the
    // same receiver. Recorded when the receiver has typing evidence (a typed
    // local or `this`); an untyped `a.b` read stays a plain reference, since
    // most such reads are data.
    const memberValueReference = (valueNode) => {
        let value = valueNode;
        while (value && (value.type === 'parenthesized_expression' || value.type === 'as_expression' ||
            value.type === 'satisfies_expression' || value.type === 'non_null_expression')) {
            value = value.namedChild(0);
        }
        if (value?.type !== 'member_expression') return;
        const prop = value.childForFieldName('property');
        const obj = value.childForFieldName('object');
        if (prop?.type !== 'property_identifier' || !obj ||
            (obj.type !== 'identifier' && obj.type !== 'this') || SKIP_IDENTS.has(prop.text)) return;
        const facts = memberReceiverFacts(obj, prop.text);
        if (!facts.receiverType && facts.receiver !== 'this') return;
        calls.push({
            name: prop.text,
            line: prop.startPosition.row + 1,
            column: prop.startPosition.column,
            isMethod: true,
            ...facts,
            isFunctionReference: true,
            memberValue: true,
            enclosingFunction: getCurrentEnclosingFunction(),
        });
    };
    const destructuredFields = (refNode) => {
        const destructured = destructuredBindingOf(refNode, refNode.text);
        return destructured ? { destructured } : null;
    };

    const bareReferenceBindingFields = (refNode) => ({
        ...localShadowFields(refNode, refNode.text),
        ...(moduleValueBindings.has(refNode.text) && { moduleLocalBinding: true }),
        ...destructuredFields(refNode),
    });

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
            localVarTypesStack.push(new ReceiverTypeMap(localVarTypes));
            localVarTypeQualifiersStack.push(new Map(localVarTypeQualifiers));
            declaredTypeVarsStack.push(new Set(declaredTypeVars));
        }

        // Track local aliases: const myParse = parse, const { parse: csvParse } = ...
        if (node.type === 'variable_declarator') {
            const nameNode = node.childForFieldName('name');
            const initNode = node.childForFieldName('value');
            memberValueReference(initNode);
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
            // One-hop const alias (fix #381): `const c = cfg` with a typed
            // cfg carries cfg's type; `const c = this.config` receives like
            // `this.config`. Only `const` (one binding, never reassigned).
            if (nameNode?.type === 'identifier') localFieldAliases.delete(nameNode.text);
            if (nameNode?.type === 'identifier' && !node.childForFieldName('type') &&
                node.parent?.type === 'lexical_declaration' &&
                node.parent.child(0)?.type === 'const' && initNode &&
                initNode.text !== nameNode.text) {
                if (initNode.type === 'identifier' && localVarTypes.has(initNode.text)) {
                    localVarTypes.set(nameNode.text, localVarTypes.get(initNode.text),
                        localVarTypes.origins.get(initNode.text) || 'flow');
                    if (localVarTypeQualifiers.has(initNode.text)) {
                        localVarTypeQualifiers.set(nameNode.text, localVarTypeQualifiers.get(initNode.text));
                    } else {
                        localVarTypeQualifiers.delete(nameNode.text);
                    }
                } else if (initNode.type === 'member_expression' &&
                    initNode.childForFieldName('property')?.type === 'property_identifier' &&
                    ['this', 'identifier'].includes(initNode.childForFieldName('object')?.type) &&
                    node.parent.parent) {
                    localFieldAliases.set(nameNode.text, { node: initNode, scope: node.parent.parent });
                }
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
                    localVarTypes.set(nameNode.text, ctorName, 'constructor', initNode);
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
                        localVarTypes.set(nameNode.text, typeName, 'annotation', typeNode);
                        declaredTypeVars.add(nameNode.text);
                        const annotationQualifier = tsTypeQualifier(typeId);
                        if (annotationQualifier) {
                            localVarTypeQualifiers.set(nameNode.text, annotationQualifier);
                        } else {
                            localVarTypeQualifiers.delete(nameNode.text);
                        }
                    }
                } else if (initNode?.type === 'subscript_expression' &&
                    indexedArrayReceiver(initNode)) {
                    // Declared container element (fix #359): `const c =
                    // items[0]` with `items: Conv[]` binds a Conv.
                    const element = indexedArrayReceiver(initNode);
                    localVarTypes.set(nameNode.text, element.type, 'annotation', element.node);
                    if (element.qualifier) {
                        localVarTypeQualifiers.set(nameNode.text, element.qualifier);
                    } else {
                        localVarTypeQualifiers.delete(nameNode.text);
                    }
                } else if (initNode && JS_LITERAL_ASSIGN_TYPES[initNode.type]) {
                    // Literal declaration types the variable (fix #262):
                    // `const lines = []` → Array. Annotation, when present,
                    // wins (the branch above).
                    localVarTypes.set(nameNode.text, JS_LITERAL_ASSIGN_TYPES[initNode.type], 'literal', initNode);
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
                    localVarTypes.set(pat.text, typeName, 'annotation', node);
                    declaredTypeVars.add(pat.text);
                    const annotationQualifier = tsTypeQualifier(inner);
                    if (annotationQualifier) {
                        localVarTypeQualifiers.set(pat.text, annotationQualifier);
                    } else {
                        localVarTypeQualifiers.delete(pat.text);
                    }
                }
            }
        }

        // Track reassignment with new expression: x = new Bar() → update localVarTypes
        if (node.type === 'assignment_expression') {
            const left = node.childForFieldName('left');
            const right = node.childForFieldName('right');
            memberValueReference(right);
            if (left?.type === 'identifier') {
                if (right?.type === 'new_expression') {
                    nonCallableNames.add(left.text);
                    const ctorName = jsConstructorTypeName(right.childForFieldName('constructor'));
                    if (ctorName && !isConditionalReassignment(node)) {
                        localVarTypes.set(left.text, ctorName, 'constructor', right);
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
                        localVarTypes.set(left.text, JS_LITERAL_ASSIGN_TYPES[right.type], 'literal', right);
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
                    ...bareReferenceBindingFields(right),
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
                let assignedTo = jsAssignmentTargetOf(node);
                let assignedIterFields = {};
                if (!assignedTo) {
                    const iterTarget = jsIterTargetOf(node);
                    if (iterTarget) {
                        assignedTo = iterTarget.first;
                        assignedIterFields = {
                            assignedIter: true,
                            ...(iterTarget.rest.length > 0 && { assignedTupleRest: iterTarget.rest }),
                        };
                    }
                }
                // MEDIUM-5: capture explicit method for fetch(url, { method }).
                const optionsMethod = funcNode.text === 'fetch'
                    ? getOptionsMethod(node, 1)
                    : null;
                const requestConfig = getRequestConfig(node);
                calls.push({
                    name: funcNode.text,
                    ...(resolvedName && { resolvedName }),
                    ...(resolvedNames && { resolvedNames }),
                    line: node.startPosition.row + 1,
                    callStart: node.startIndex,
                    callEnd: node.endIndex,
                    isMethod: false,
                    // A local binding of the name (fix #397): the call runs
                    // the local's value, not a same-name outer definition.
                    ...localShadowFields(funcNode, funcNode.text),
                    ...destructuredFields(funcNode),
                    ...(assignedTo && { assignedTo }),
                    ...assignedIterFields,
                    enclosingFunction,
                    // Recorded only when true (fix #397: a `false` on every
                    // record was a twelfth of a JS calls cache).
                    ...(uncertain && { uncertain: true }),
                    ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp }),
                    ...(optionsMethod && { optionsMethod }),
                    ...(requestConfig && { requestConfig })
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
                    callStart: node.startIndex,
                    callEnd: node.endIndex,
                    isMethod: true,
                    receiver: 'super',
                    argCount: node.childForFieldName('arguments')?.namedChildCount ?? 0,
                    enclosingFunction,
                });
            } else if (funcNode.type === 'member_expression') {
                // Method call: obj.foo() or foo.call/apply/bind()
                const propNode = funcNode.childForFieldName('property');
                let objNode = funcNode.childForFieldName('object');

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
                                ...destructuredFields(objNode),
                                enclosingFunction
                            });
                        } else if (objNode.type === 'member_expression') {
                            // obj.foo.call() -> method call to foo
                            const innerProp = objNode.childForFieldName('property');
                            const innerObj = objNode.childForFieldName('object');
                            if (innerProp) {
                                const prototypeOwner = innerObj?.type === 'member_expression' &&
                                    innerObj.childForFieldName('property')?.text === 'prototype' &&
                                    innerObj.childForFieldName('object')?.type === 'identifier'
                                    ? innerObj.childForFieldName('object').text
                                    : undefined;
                                const boundReceiver = prototypeOwner ||
                                    (innerObj?.type === 'identifier'
                                        ? innerObj.text : innerObj?.text);
                                const boundReceiverType = prototypeOwner ||
                                    (innerObj?.type === 'identifier'
                                        ? localVarTypes.get(innerObj.text) : undefined);
                                calls.push({
                                    name: innerProp.text,
                                    line: node.startPosition.row + 1,
                                    isMethod: true,
                                    boundCall: true,
                                    receiver: boundReceiver,
                                    ...(boundReceiverType && { receiverType: boundReceiverType,
                                        ...(prototypeOwner ? {
                                            receiverTypeSource: 'type-qualified',
                                            receiverTypeEvidence: typeOrigin('type-qualified', innerObj),
                                        } : localVarTypes.fields(innerObj?.text, boundReceiverType)) }),
                                    ...(innerObj?.type === 'identifier' &&
                                        localVarTypeQualifiers.has(innerObj.text) && {
                                            receiverTypeQualifier: localVarTypeQualifiers.get(innerObj.text),
                                        }),
                                    ...(innerObj?.type === 'identifier' &&
                                        isShadowedByLocal(innerObj, innerObj.text) && {
                                            receiverLocalBinding: true,
                                        }),
                                    enclosingFunction,
                                    ...(uncertain && { uncertain: true }),
                                });
                            }
                        }
                    } else {
                        // Regular method call: obj.foo()
                        const receiverFacts = memberReceiverFacts(objNode, propName);
                        const firstArg = getFirstStringArg(node);
                        const requestConfig = getRequestConfig(node);
                        const handlerArgs = firstArg && ROUTE_VERB_METHODS.test(propNode.text) &&
                            getArgCount(node) >= 2 ? getHandlerArgs(node) : null;
                        // fix #366: `server.register(plugin, { prefix })` mounts
                        // the plugin's routes under the prefix.
                        const registerMount = propNode.text === 'register' ? getRegisterMount(node) : null;
                        // fix #366: the argument shapes of a router mount
                        // (`app.use('/api', router)`, `app.route('/v2', api)`):
                        // identifier names, or '()' for any other expression.
                        const mountArgs = (propNode.text === 'use' || propNode.text === 'route') &&
                            getArgCount(node) >= 2 ? getMountArgs(node) : null;
                        const argCount = getArgCount(node);
                        let assignedTo = jsAssignmentTargetOf(node);
                        let assignedIterFields = {};
                        if (!assignedTo) {
                            const iterTarget = jsIterTargetOf(node);
                            if (iterTarget) {
                                assignedTo = iterTarget.first;
                                assignedIterFields = {
                                    assignedIter: true,
                                    ...(iterTarget.rest.length > 0 &&
                                        { assignedTupleRest: iterTarget.rest }),
                                };
                            }
                        }
                        calls.push({
                            name: propName,
                            // Multi-line chains (builder.x()\n.y()) must report
                            // each method's OWN name line, not the chain-start
                            // line — the account's ground set is keyed by the
                            // name's line
                            line: propNode.startPosition.row + 1,
                            callStart: node.startIndex,
                            callEnd: node.endIndex,
                            isMethod: true,
                            ...receiverFacts,
                            ...(assignedTo && { assignedTo }),
                            ...assignedIterFields,
                            enclosingFunction,
                            ...(uncertain && { uncertain: true }),
                            ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp }),
                            ...(requestConfig && { requestConfig }),
                            ...(registerMount && { registerMount }),
                            ...(mountArgs && { mountArgs }),
                            ...(handlerArgs && { handlerArgs }),
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
                                    ...bareReferenceBindingFields(arg),
                                    enclosingFunction
                                });
                            } else if (arg.type === 'member_expression') {
                                // Handle obj.method passed as callback: .then(utils.handleError)
                                const propNode = arg.childForFieldName('property');
                                const objNode = arg.childForFieldName('object');
                                if (propNode && !SKIP_IDENTS.has(propNode.text)) {
                                    const hofRecv = objNode?.type === 'identifier' ? objNode.text : undefined;
                                    // Same typing evidence as the general-arg
                                    // member-value shape (fix #295) — tier must
                                    // not depend on argument position (#234).
                                    const hofRecvType = hofRecv ? localVarTypes.get(hofRecv) : undefined;
                                    calls.push({
                                        name: propNode.text,
                                        line: arg.startPosition.row + 1,
                                        isMethod: true,
                                        receiver: hofRecv,
                                        ...(hofRecvType && { receiverType: hofRecvType, ...localVarTypes.fields(hofRecv, hofRecvType) }),
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
                                ...bareReferenceBindingFields(arg),
                                enclosingFunction
                            });
                        }
                        // Method-value references (fix #295): `expectRaises(t.check, null)`
                        // passes the method value t.check — one-hop identifier
                        // receivers, typed from the same localVarTypes evidence
                        // method calls use. No isPotentialCallback: the record
                        // rides the MAIN path's full receiver physics (the HOF
                        // member-value convention above).
                        if (arg.type === 'member_expression') {
                            const mvProp = arg.childForFieldName('property');
                            const mvObj = arg.childForFieldName('object');
                            if (mvProp && mvObj?.type === 'identifier' &&
                                !SKIP_IDENTS.has(mvProp.text) && !SKIP_IDENTS.has(mvObj.text)) {
                                const mvType = localVarTypes.get(mvObj.text);
                                calls.push({
                                    name: mvProp.text,
                                    line: arg.startPosition.row + 1,
                                    isMethod: true,
                                    receiver: mvObj.text,
                                    ...(mvType && { receiverType: mvType, ...localVarTypes.fields(mvObj.text, mvType) }),
                                    isFunctionReference: true,
                                    enclosingFunction
                                });
                            }
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
                                            ...bareReferenceBindingFields(val),
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

                // fix #366: `new Router({ prefix: '/api' })` (koa-router)
                // carries a constructor mount prefix.
                const ctorPrefix = hasObjectKeyArg(node, 'prefix');
                if (ctorNode.type === 'identifier') {
                    calls.push({
                        name: ctorNode.text,
                        line: node.startPosition.row + 1,
                        isMethod: false,
                        isConstructor: true,
                        ...localShadowFields(ctorNode, ctorNode.text),
                        ...(ctorPrefix && { prefixOption: true }),
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
                            ...(ctorPrefix && { prefixOption: true }),
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
                        ...bareReferenceBindingFields(child),
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
                    localVarTypes.restore(saved);
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

    // fix #338: classify edges that do not execute during module
    // initialization so dependency-cycle reporting can separate an eager
    // import-time loop from a deliberate lazy one. `require()`/`import()`
    // nested in any function body (incl. `() => require('./x')` thunks) runs
    // only when that function is called; TS `import type` / `export type`
    // re-exports and all-`type` specifier lists are erased at compile time.
    const FUNCTION_LIKE = new Set(['function_declaration', 'function_expression', 'arrow_function',
        'method_definition', 'generator_function_declaration', 'generator_function', 'function']);
    const importDeferral = (node) => {
        for (let p = node.parent; p; p = p.parent) {
            if (FUNCTION_LIKE.has(p.type)) return 'function-local';
        }
        return null;
    };
    // Static path folding is positive identity evidence. A method merely
    // named join/resolve need not be Node's path utility. Keep an ambiguous
    // or shadowed binding dynamic rather than inventing a module edge.
    let pathBindings = null;
    const isPathModuleCall = node => {
        if (node?.type !== 'call_expression') return false;
        const fn = node.childForFieldName('function');
        const args = node.childForFieldName('arguments');
        const arg = args?.namedChild(0);
        return fn?.type === 'identifier' && fn.text === 'require' &&
            args.namedChildCount === 1 && arg?.type === 'string' &&
            ['path', 'node:path'].includes(arg.text.slice(1, -1));
    };
    const collectPathBindings = () => {
        if (pathBindings) return;
        pathBindings = new Map();
        const add = (pattern, value) => {
            if (!pattern) return;
            traverseTree(pattern, id => {
                if (id.type === 'identifier' || id.type === 'shorthand_property_identifier_pattern') {
                    const entries = pathBindings.get(id.text) || [];
                    entries.push({ pattern, value });
                    pathBindings.set(id.text, entries);
                }
                return true;
            });
        };
        // File-wide ambiguity is deliberately conservative, including writes
        // and parameters in unrelated scopes. This rare syntax needs proof,
        // while ordinary literal require specifiers keep their existing path.
        traverseTree(tree.rootNode, n => {
            if (n.type === 'variable_declarator') add(n.childForFieldName('name'), n.childForFieldName('value'));
            else if (n.type === 'formal_parameters' || n.type === 'import_clause') add(n, null);
            else if (n.type === 'assignment_expression' || n.type === 'augmented_assignment_expression') add(n.childForFieldName('left'), null);
            else if (n.type === 'update_expression') add(n.childForFieldName('argument'), null);
            else if (n.type === 'class_declaration' || n.type === 'class') add(n.childForFieldName('name'), null);
            else if (n.type === 'catch_clause') add(n.childForFieldName('parameter'), null);
            else if (FUNCTION_LIKE.has(n.type)) {
                add(n.childForFieldName('name'), null);
                add(n.childForFieldName('parameter'), null); // unparenthesized arrow
            }
            return true;
        });
    };
    const isPathUtility = fn => {
        if (pathBindings.has('require')) return false;
        if (fn?.type !== 'member_expression' ||
            !['join', 'resolve'].includes(fn.childForFieldName('property')?.text)) return false;
        const object = fn.childForFieldName('object');
        if (isPathModuleCall(object)) return true;
        if (object?.type !== 'identifier') return false;
        const bindings = pathBindings.get(object.text) || [];
        return bindings.length === 1 && bindings[0].pattern.type === 'identifier' &&
            isPathModuleCall(bindings[0].value);
    };
    // Static composition of `__dirname`-rooted require paths (fix #337b).
    // Returns a relative specifier ('./x' / '../x') or null when any piece is
    // not a string literal.
    const unquote = (n) => (n.type === 'string' &&
        !n.namedChildren.some(child => child.type === 'escape_sequence') ? n.text.slice(1, -1) : null);
    const staticDirnamePath = (arg) => {
        collectPathBindings();
        if (pathBindings.has('__dirname') || pathBindings.has('require')) return null;
        let parts = null;
        if (arg.type === 'call_expression') {
            const fn = arg.childForFieldName('function');
            if (!isPathUtility(fn)) return null;
            const args = arg.childForFieldName('arguments');
            if (!args || args.namedChildCount < 2) return null;
            if (args.namedChild(0).type !== 'identifier' || args.namedChild(0).text !== '__dirname') return null;
            parts = [];
            for (let i = 1; i < args.namedChildCount; i++) {
                const piece = unquote(args.namedChild(i));
                if (piece == null || piece.startsWith('/')) return null;
                parts.push(piece);
            }
        } else if (arg.type === 'binary_expression') {
            const operands = [];
            const flatten = (n) => {
                if (n.type === 'binary_expression' && n.childForFieldName('operator')?.text === '+') {
                    flatten(n.childForFieldName('left'));
                    flatten(n.childForFieldName('right'));
                } else operands.push(n);
            };
            flatten(arg);
            if (operands.length < 2 || operands[0].type !== 'identifier' || operands[0].text !== '__dirname') return null;
            let tail = '';
            for (let i = 1; i < operands.length; i++) {
                const piece = unquote(operands[i]);
                if (piece == null) return null;
                tail += piece;
            }
            if (!tail.startsWith('/')) return null;
            parts = [tail.slice(1)];
        } else if (arg.type === 'template_string') {
            let tail = '';
            let sawDirname = false;
            for (let i = 0; i < arg.childCount; i++) {
                const c = arg.child(i);
                if (c.type === 'template_substitution') {
                    if (sawDirname || c.namedChildCount !== 1 || c.namedChild(0).text !== '__dirname') return null;
                    sawDirname = true;
                } else if (c.type === 'string_fragment') {
                    if (!sawDirname) return null;
                    tail += c.text;
                } else if (c.type !== '`') return null;
            }
            if (!sawDirname || !tail.startsWith('/')) return null;
            parts = [tail.slice(1)];
        }
        if (!parts || parts.length === 0) return null;
        const joined = parts.join('/').replace(/\\/g, '/');
        if (!joined || joined.includes('${')) return null;
        const normalized = require('path').posix.normalize(joined);
        if (normalized.startsWith('/') || normalized === '.') return null;
        return normalized.startsWith('.') ? normalized : `./${normalized}`;
    };
    const hasTypeKeyword = (node) => {
        for (let i = 0; i < node.childCount; i++) {
            if (node.child(i).type === 'type') return true;
        }
        return false;
    };

    traverseTreeCached(tree.rootNode, (node) => {
        // ES6 import statements
        if (node.type === 'import_statement') {
            const line = node.startPosition.row + 1;
            let modulePath = null;
            const names = [];
            const esmRenames = [];
            let importType = 'named';
            let typeOnly = hasTypeKeyword(node);
            let specifierCount = 0;
            let typeSpecifierCount = 0;
            let hasValueBinding = false;

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
                        imports.push({ module: src, names: alias ? [alias] : [], type: 'require', line,
                            ...(typeOnly && { deferred: true, deferredReason: 'type-only' }) });
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
                            hasValueBinding = true;
                        } else if (clauseChild.type === 'named_imports') {
                            // Named imports: import { a, b } from 'x'
                            for (let k = 0; k < clauseChild.namedChildCount; k++) {
                                const specifier = clauseChild.namedChild(k);
                                if (specifier.type === 'import_specifier') {
                                    const nameNode = specifier.namedChild(0);
                                    const aliasNode = specifier.namedChild(1);
                                    specifierCount++;
                                    if (hasTypeKeyword(specifier)) typeSpecifierCount++;
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
                            hasValueBinding = true;
                        }
                    }
                }
            }

            if (modulePath) {
                if (names.length === 0) {
                    // Side-effect import: import 'x'
                    importType = 'side-effect';
                }
                if (!typeOnly && specifierCount > 0 && typeSpecifierCount === specifierCount &&
                    importType === 'named' && !hasValueBinding) {
                    typeOnly = true;
                }
                imports.push({ module: modulePath, names, type: importType, line,
                    ...(esmRenames.length > 0 && { renames: esmRenames }),
                    ...(typeOnly && { deferred: true, deferredReason: 'type-only' }) });
            }
            return true;
        }

        // Re-export statements: export { X } from './module' or export * from './module'
        // These are implicit imports that must be tracked for dependency resolution
        if (node.type === 'export_statement') {
            let source = null;
            const names = [];
            let specifierCount = 0;
            let typeSpecifierCount = 0;

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
                            specifierCount++;
                            if (hasTypeKeyword(specifier)) typeSpecifierCount++;
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
                imports.push({ module: source, names, type: importType, line, isReExport: true,
                    ...((hasTypeKeyword(node) || (specifierCount > 0 && specifierCount === typeSpecifierCount)) &&
                        { deferred: true, deferredReason: 'type-only' }) });
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

                    const composedPath = firstArg && firstArg.type !== 'string' ? staticDirnamePath(firstArg) : null;
                    if (firstArg && firstArg.type === 'string') {
                        modulePath = firstArg.text.slice(1, -1);
                    } else if (composedPath) {
                        // fix #337b: `require(path.join(__dirname, '..', 'x'))`,
                        // `require(__dirname + '/x')`, `require(\`${__dirname}/x\`)`
                        // compose to an exact relative specifier — the CJS
                        // test-suite idiom that used to be an unresolvable
                        // dynamic module (excluding every constructor call it
                        // bound as other-definition-import).
                        modulePath = composedPath;
                    } else {
                        dynamic = true;
                        modulePath = firstArg ? firstArg.text : null;
                    }

                    // Check parent for variable name
                    let parent = node.parent;
                    let defaultLike = false;
                    // `const stringify = require('url').format` binds the
                    // module's member `format` under the local name (fix
                    // #397, koa-measured): a renamed named import, never the
                    // module value nor a binding of `stringify` itself.
                    const memberOfRequire = parent?.type === 'member_expression' &&
                        sameNode(parent.childForFieldName('object'), node) &&
                        parent.childForFieldName('property')?.type === 'property_identifier' &&
                        parent.parent?.type === 'variable_declarator' &&
                        sameNode(parent.parent.childForFieldName('value'), parent)
                        ? parent.childForFieldName('property').text : null;
                    if (memberOfRequire) {
                        const nameNode = parent.parent.childForFieldName('name');
                        if (nameNode?.type === 'identifier') {
                            names.push(memberOfRequire);
                            if (nameNode.text !== memberOfRequire) {
                                if (!importAliases) importAliases = [];
                                importAliases.push({ original: memberOfRequire, local: nameNode.text });
                                renames.push({ original: memberOfRequire, local: nameNode.text });
                            }
                        }
                        parent = null;
                    }
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
                        const deferral = importDeferral(node);
                        imports.push({ module: modulePath, names, type: 'require', line, dynamic,
                            ...(deferral && { deferred: true, deferredReason: deferral }),
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
                    const deferral = importDeferral(node);
                    const deferredFields = deferral ? { deferred: true, deferredReason: deferral } : {};
                    if (firstArg && firstArg.type === 'string') {
                        const modulePath = firstArg.text.slice(1, -1);
                        imports.push({ module: modulePath, names: [], type: 'dynamic', line, dynamic: false,
                            ...deferredFields });
                    } else if (firstArg) {
                        imports.push({ module: firstArg.text, names: [], type: 'dynamic', line, dynamic: true,
                            ...deferredFields });
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
 * Return the local symbol created or referenced by a statically-owned
 * CommonJS property assignment. Dynamic expressions deliberately return
 * undefined: `exports.x = factory()` and `exports.x = other.y` may be
 * re-exports or arbitrary values, so they are not exclusion-grade identity.
 */
function cjsAssignedLocalName(valueNode, exposedName) {
    if (!valueNode) return undefined;
    if (valueNode.type === 'identifier') return valueNode.text;
    if (['function_expression', 'generator_function', 'arrow_function', 'class']
        .includes(valueNode.type)) {
        return valueNode.childForFieldName('name')?.text || exposedName;
    }
    return undefined;
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
                                    exports.push({ name: prop.text, localName: prop.text, type: 'module.exports', line });
                                } else if (prop.type === 'pair') {
                                    const key = prop.childForFieldName('key');
                                    const value = prop.childForFieldName('value');
                                    if (key) {
                                        const localName = cjsAssignedLocalName(value, key.text);
                                        exports.push({
                                            name: key.text,
                                            ...(localName && { localName }),
                                            type: 'module.exports',
                                            line,
                                        });
                                    }
                                } else if (prop.type === 'method_definition') {
                                    // Shorthand methods are exports too
                                    // (fix #252 — `module.exports =
                                    // { doThing(x) {} }` was invisible to the
                                    // export list, so deadcode audited a
                                    // require()-reachable function).
                                    const mName = prop.childForFieldName('name');
                                    if (mName) exports.push({ name: mName.text, localName: mName.text, type: 'module.exports', line });
                                } else if (prop.type === 'spread_element') {
                                    // CommonJS barrel: `module.exports = {
                                    // ...require('./public') }`. This is the
                                    // CJS equivalent of `export * from` and
                                    // must retain its SOURCE so namespace
                                    // calls through the barrel can establish
                                    // name ownership. A dynamic spread stays
                                    // an explicitly unmodelable CJS surface.
                                    const value = prop.namedChild(0);
                                    const fn = value?.type === 'call_expression'
                                        ? value.childForFieldName('function') : null;
                                    const args = value?.type === 'call_expression'
                                        ? value.childForFieldName('arguments') : null;
                                    const first = args?.namedChild(0);
                                    if (fn?.type === 'identifier' && fn.text === 'require' &&
                                        first?.type === 'string') {
                                        exports.push({
                                            name: '*',
                                            type: 're-export-all',
                                            line,
                                            source: first.text.slice(1, -1),
                                        });
                                    } else {
                                        exports.push({
                                            name: '*',
                                            type: 'module.exports',
                                            line,
                                        });
                                    }
                                }
                            }
                        } else if (rightNode && rightNode.type === 'identifier') {
                            // module.exports = something
                            exports.push({ name: rightNode.text, localName: rightNode.text,
                                type: 'module.exports', defaultLike: true, line });
                        } else {
                            // A named function/class expression still exports
                            // one callable default. Preserve its LOCAL symbol
                            // identity so `require('./mod')()` resolves back
                            // to the declaration; anonymous expressions use
                            // the parser's synthetic `default` symbol.
                            const localName = rightNode &&
                                ['function_expression', 'generator_function', 'class'].includes(rightNode.type)
                                ? rightNode.childForFieldName('name')?.text
                                : undefined;
                            exports.push({ name: 'default',
                                ...(localName && { localName }),
                                type: 'module.exports', defaultLike: true, line });
                        }
                        return true;
                    }

                    // exports.name = ...
                    if (objNode.text === 'exports') {
                        const line = node.startPosition.row + 1;
                        const rightNode = node.childForFieldName('right');
                        const localName = cjsAssignedLocalName(rightNode, propNode.text);
                        exports.push({
                            name: propNode.text,
                            ...(localName && { localName }),
                            type: 'exports',
                            line,
                        });
                        return true;
                    }

                    // module.exports.name = ...
                    if (objNode.type === 'member_expression' && objNode.text === 'module.exports') {
                        const line = node.startPosition.row + 1;
                        const rightNode = node.childForFieldName('right');
                        const localName = cjsAssignedLocalName(rightNode, propNode.text);
                        exports.push({ name: propNode.text,
                            ...(localName && { localName }),
                            type: 'module.exports', line });
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
/** A shorthand property of a module export object (`module.exports = { f }`, `export default { f }`). */
function jsExportObjectShorthand(node) {
    const object = node.parent;
    if (object?.type !== 'object') return false;
    const holder = object.parent;
    if (holder?.type === 'export_statement') return true;
    if (holder?.type !== 'assignment_expression' ||
        !sameNode(holder.childForFieldName('right'), object)) return false;
    const left = holder.childForFieldName('left')?.text?.replace(/\s+/g, '') || '';
    return left === 'module.exports' || left === 'exports' ||
        left.startsWith('module.exports.') || left.startsWith('exports.');
}

function findUsagesInCode(code, name, parser, tree, options = {}) {
    tree = tree || parseTree(parser, code);
    const usages = [];
    // Lexical scope verdicts (fix #392) only for refactoring internals.
    const scopeMemo = options.lexicalScopes ? new Map() : null;

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
        let importAliasLocal = false;

        if (parent) {
            // Import: identifier inside import_specifier or import_clause
            if (parent.type === 'import_specifier' ||
                parent.type === 'import_clause' ||
                parent.type === 'namespace_import') {
                usageType = 'import';
                // `import { g as f }`: f is the importer's local alias.
                const imported = parent.type === 'import_specifier' ? parent.childForFieldName('name') : null;
                if (imported && sameNode(parent.childForFieldName('alias'), node) && imported.text !== node.text) {
                    importAliasLocal = true;
                }
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
                    // `const f = require('m').g`: f is a local alias of g.
                    if (value.childForFieldName('property')?.text !== node.text) importAliasLocal = true;
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
                if (object && ['identifier', 'this', 'super'].includes(object.type)) {
                    usages.push({ line, column, usageType, receiver: object.text });
                    return true;
                }
            }
            // JSX component usage: <Component /> or <Component>...</Component>
            else if (parent.type === 'jsx_self_closing_element' || parent.type === 'jsx_opening_element') {
                usageType = 'call';  // Treat JSX component usage as a "call"
            }
        }

        // Where a bare reference resolves (fix #392).
        const scope = scopeMemo && usageType === 'reference'
            ? scopeFields(referenceScope(node, 'javascript', scopeMemo)) : null;
        // An object-literal shorthand `{ name }` is a key AND a reference to
        // the binding (fix #397): a rename of the binding keeps the key
        // (`{ name: renamed }`), except in a module's export object, whose
        // keys are the export names a rename follows into every importer.
        const shorthandProperty = scopeMemo && node.type === 'shorthand_property_identifier' &&
            !jsExportObjectShorthand(node);
        usages.push({ line, column, usageType, ...scope, ...(shorthandProperty && { shorthandProperty: true }),
            ...(importAliasLocal && usageType === 'import' && { importAlias: true }) });
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
