'use strict';

/**
 * core/async-producers.js - what calling an async definition RETURNS (fix #364).
 *
 * audit-async flags a call as "missing await" only when the callee returns an
 * awaitable. The `async` keyword alone does not decide that:
 *   - coroutine        `async def` / `async function` / C# `async Task`: awaitable
 *   - iterator         async generators (`async def` with an own-body `yield`,
 *                      `async function*`, C# `async IAsyncEnumerable` iterators):
 *                      consumed by `async for` / `for await` / `await foreach`,
 *                      never awaited
 *   - context-manager  a decorator resolving to the language's async
 *                      context-manager factory: entered by `async with`
 *   - void             C# `async void`: nothing to await
 *   - unknown          a decorator whose effect is not known replaces the
 *                      callable, or same-name definitions disagree: not audited
 * The callee definition is resolved lexically first (nearest enclosing scope
 * that binds the name: a local def, a parameter, a variable), then by the
 * file's own definitions, then project-wide.
 */

const { langTraits } = require('../languages');
const { sameNode } = require('../languages/utils');

const CALLABLE_TYPES = new Set(['function', 'method', 'constructor', 'arrow']);

function isCallableDef(def) {
    return !!def && (CALLABLE_TYPES.has(def.type) || def.params != null || def.paramsStructured != null);
}

function isDefAsync(def) {
    return def.isAsync === true || (Array.isArray(def.modifiers) && def.modifiers.includes('async'));
}

/**
 * Resolve a decorator expression to its qualified identity through the
 * defining file's import bindings. Returns { name, called } or null.
 */
function resolveDecorator(text, fileEntry, vocab) {
    let expr = String(text || '').trim();
    let called = false;
    const paren = expr.indexOf('(');
    if (paren >= 0) {
        called = true;
        expr = expr.slice(0, paren).trim();
    }
    if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(expr)) return null;
    const dot = expr.indexOf('.');
    const head = dot < 0 ? expr : expr.slice(0, dot);
    const rest = dot < 0 ? '' : expr.slice(dot);
    const binding = (fileEntry?.importBindings || []).find(b =>
        (b.alias || b.name) === head && b.module && (b.kind === 'from' || b.kind === 'import'));
    let name = null;
    if (binding) {
        name = binding.kind === 'from'
            ? `${binding.module}.${binding.name}${rest}`
            : `${binding.module}${rest}`;
    } else if (!rest && (vocab.builtins || []).includes(head)) {
        name = `builtins.${head}`;
    }
    return name ? { name, called } : null;
}

/**
 * Classify one definition. Memoized per definition object in `memo`.
 */
function producerKind(index, def, memo) {
    if (memo.has(def)) return memo.get(def);
    let kind;
    if (!isDefAsync(def)) {
        kind = 'sync';
    } else if (typeof def.returnType === 'string' && def.returnType.trim() === 'void') {
        kind = 'void';
    } else {
        // The body decides first; a wrapping decorator then replaces it.
        kind = def.isGenerator ? 'iterator' : 'coroutine';
        const decorators = Array.isArray(def.decorators) ? def.decorators : [];
        const fileEntry = decorators.length > 0 ? index.files.get(def.file) : null;
        const traits = fileEntry ? langTraits(fileEntry.language) : null;
        if (traits?.decoratorsWrapCallables) {
            const vocab = traits.callableDecorators || {};
            let contextManager = false;
            for (const decorator of decorators) {
                const resolved = resolveDecorator(decorator, fileEntry, vocab);
                const key = resolved ? resolved.name + (resolved.called ? '()' : '') : null;
                if (key && !contextManager && (vocab.asyncContextManagers || []).includes(key)) {
                    contextManager = true;
                } else if (!key || !(vocab.transparent || []).includes(key)) {
                    kind = 'unknown';
                    break;
                }
            }
            if (contextManager && kind !== 'unknown') kind = 'context-manager';
        }
    }
    memo.set(def, kind);
    return kind;
}

/**
 * Collapse the kinds of the definitions a call may reach.
 * `requireAllAsync`: a sync definition anywhere makes the name ambiguous
 * (project-wide lookup); otherwise the async definitions win (file-local).
 * Returns null (not an async producer), a kind, or 'unknown' (disagreeing).
 */
function collapseKinds(index, defs, memo, requireAllAsync) {
    const kinds = new Set();
    let sync = false;
    for (const def of defs) {
        if (!isCallableDef(def)) continue;
        const kind = producerKind(index, def, memo);
        if (kind === 'sync') sync = true;
        else kinds.add(kind);
    }
    if (kinds.size === 0 || (sync && requireAllAsync)) return null;
    return kinds.size === 1 ? [...kinds][0] : 'unknown';
}

// ── Lexical resolution (structural languages resolve bare calls by scope) ──

const PY_SCOPES = new Set(['function_definition', 'lambda', 'module', 'class_definition',
    'list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);
const PY_NESTED = new Set(['function_definition', 'lambda', 'class_definition',
    'list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);
const JS_FUNCTIONS = new Set(['function_declaration', 'function_expression', 'arrow_function',
    'method_definition', 'generator_function', 'generator_function_declaration']);
const JS_FUNCTION_VALUES = new Set(['function_expression', 'arrow_function', 'generator_function']);
const JS_SCOPES = new Set([...JS_FUNCTIONS, 'statement_block', 'program', 'for_statement',
    'for_in_statement', 'catch_clause']);

const LEXICAL_FAMILY = {
    python: 'python',
    javascript: 'js', typescript: 'js', tsx: 'js', html: 'js',
};

function addBinding(map, name, entry) {
    if (!name) return;
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(entry);
}

function collectPatternNames(node, out, skipFields) {
    if (!node) return;
    if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') {
        out.push(node.text);
        return;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (skipFields.some(field => sameNode(node.childForFieldName(field), child))) continue;
        if (child.type === 'type_annotation' || child.type === 'type') continue;
        collectPatternNames(child, out, skipFields);
    }
}

function pythonScopeBindings(scope) {
    const map = new Map();
    const bindTarget = (target, entry) => {
        const names = [];
        collectPatternNames(target, names, ['value', 'subscript', 'attribute', 'object']);
        if (target && (target.type === 'attribute' || target.type === 'subscript')) return;
        for (const name of names) addBinding(map, name, entry);
    };
    if (scope.type === 'function_definition' || scope.type === 'lambda') {
        const params = scope.childForFieldName('parameters');
        for (const param of params?.namedChildren || []) {
            const names = [];
            const nameNode = param.childForFieldName('name');
            if (nameNode) names.push(nameNode.text);
            else collectPatternNames(param, names, ['value', 'type']);
            for (const name of names) addBinding(map, name, { kind: 'binding' });
        }
    }
    if (PY_NESTED.has(scope.type) && scope.type !== 'function_definition' &&
        scope.type !== 'lambda' && scope.type !== 'class_definition') {
        for (const clause of scope.namedChildren) {
            if (clause.type === 'for_in_clause') bindTarget(clause.childForFieldName('left'), { kind: 'binding' });
        }
        return map;
    }
    const body = scope.type === 'module' ? scope : scope.childForFieldName('body');
    const stack = body ? [body] : [];
    while (stack.length > 0) {
        const node = stack.pop();
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            switch (child.type) {
                case 'function_definition':
                    addBinding(map, child.childForFieldName('name')?.text, { kind: 'def', node: child });
                    continue;
                case 'class_definition':
                    addBinding(map, child.childForFieldName('name')?.text, { kind: 'binding' });
                    continue;
                case 'lambda': case 'list_comprehension': case 'set_comprehension':
                case 'dictionary_comprehension': case 'generator_expression':
                    continue;
                case 'import_statement': case 'import_from_statement':
                case 'future_import_statement': case 'global_statement':
                case 'nonlocal_statement':
                    // Resolved by the file/project definitions, or not ours.
                    for (const name of child.namedChildren) {
                        const alias = name.childForFieldName('alias') || name.childForFieldName('name') || name;
                        const text = alias.type === 'identifier' ? alias.text : alias.text.split('.')[0];
                        addBinding(map, text, { kind: 'external' });
                    }
                    continue;
                case 'assignment': case 'augmented_assignment':
                    bindTarget(child.childForFieldName('left'), { kind: 'binding' });
                    break;
                case 'named_expression':
                    addBinding(map, child.childForFieldName('name')?.text, { kind: 'binding' });
                    break;
                case 'for_statement':
                    bindTarget(child.childForFieldName('left'), { kind: 'binding' });
                    break;
                case 'as_pattern_target':
                    bindTarget(child, { kind: 'binding' });
                    continue;
                case 'except_clause':
                    for (const part of child.namedChildren) {
                        if (part.type === 'as_pattern') bindTarget(part.childForFieldName('alias'), { kind: 'binding' });
                    }
                    break;
                default:
                    break;
            }
            stack.push(child);
        }
    }
    return map;
}

function jsScopeBindings(scope) {
    const map = new Map();
    if (JS_FUNCTIONS.has(scope.type)) {
        const params = scope.childForFieldName('parameters') || scope.childForFieldName('parameter');
        const names = [];
        if (params?.type === 'identifier') names.push(params.text);
        else collectPatternNames(params, names, ['right', 'value', 'type']);
        for (const name of names) addBinding(map, name, { kind: 'binding' });
        return map;
    }
    if (scope.type === 'catch_clause') {
        const names = [];
        collectPatternNames(scope.childForFieldName('parameter'), names, ['right', 'value']);
        for (const name of names) addBinding(map, name, { kind: 'binding' });
        return map;
    }
    if (scope.type === 'for_statement' || scope.type === 'for_in_statement') {
        const init = scope.childForFieldName('initializer') || scope.childForFieldName('left');
        const names = [];
        if (init?.type === 'lexical_declaration' || init?.type === 'variable_declaration') {
            for (const decl of init.namedChildren) collectPatternNames(decl.childForFieldName('name'), names, []);
        } else if (scope.type === 'for_in_statement' && init) {
            collectPatternNames(init, names, ['right', 'value']);
        }
        for (const name of names) addBinding(map, name, { kind: 'binding' });
        return map;
    }
    for (const child of scope.namedChildren) {
        let statement = child;
        if (statement.type === 'export_statement') {
            statement = statement.childForFieldName('declaration') || statement;
        }
        switch (statement.type) {
            case 'function_declaration': case 'generator_function_declaration':
                addBinding(map, statement.childForFieldName('name')?.text, { kind: 'def', node: statement });
                break;
            case 'class_declaration':
                addBinding(map, statement.childForFieldName('name')?.text, { kind: 'binding' });
                break;
            case 'lexical_declaration': case 'variable_declaration':
                for (const decl of statement.namedChildren) {
                    if (decl.type !== 'variable_declarator') continue;
                    const nameNode = decl.childForFieldName('name');
                    const value = decl.childForFieldName('value');
                    if (nameNode?.type === 'identifier' && value && JS_FUNCTION_VALUES.has(value.type)) {
                        addBinding(map, nameNode.text, { kind: 'def', node: decl });
                    } else {
                        const names = [];
                        collectPatternNames(nameNode, names, []);
                        for (const name of names) addBinding(map, name, { kind: 'binding' });
                    }
                }
                break;
            case 'import_statement':
                // Imported names resolve through file/project definitions.
                break;
            default:
                break;
        }
    }
    return map;
}

/**
 * Per-file lexical resolver. `resolve(callNode, name)` returns:
 *   { defs: [symbol...] }  the name binds to local definitions
 *   { shadowed: true }     a parameter/variable binds the name (not provably async)
 *   null                   no enclosing scope binds it (use file/project lookup)
 */
function createLexicalResolver(fileEntry, language) {
    const family = LEXICAL_FAMILY[language];
    if (!family) return null;
    const scopes = new Map();
    const bindingsOf = scope => {
        let map = scopes.get(scope.id);
        if (!map) {
            map = family === 'python' ? pythonScopeBindings(scope) : jsScopeBindings(scope);
            scopes.set(scope.id, map);
        }
        return map;
    };
    const symbolsByName = new Map();
    for (const symbol of fileEntry.symbols || []) {
        if (!symbol?.name || !isCallableDef(symbol)) continue;
        if (!symbolsByName.has(symbol.name)) symbolsByName.set(symbol.name, []);
        symbolsByName.get(symbol.name).push(symbol);
    }
    const symbolFor = (entry, name) => {
        const nameNode = entry.node.childForFieldName('name');
        const line = (nameNode || entry.node).startPosition.row + 1;
        let best = null;
        for (const symbol of symbolsByName.get(name) || []) {
            const anchor = symbol.nameLine || symbol.startLine;
            if (anchor === line) return symbol;
            if (symbol.startLine <= line && symbol.endLine >= line &&
                (!best || symbol.startLine > best.startLine)) best = symbol;
        }
        return best;
    };
    return function resolve(callNode, name) {
        let passedFunction = false;
        for (let scope = callNode.parent; scope; scope = scope.parent) {
            const isScope = family === 'python' ? PY_SCOPES.has(scope.type) : JS_SCOPES.has(scope.type);
            if (!isScope) continue;
            // A class body is not an enclosing scope for the methods it holds.
            if (family === 'python' && scope.type === 'class_definition' && passedFunction) continue;
            if (family === 'python' && (scope.type === 'function_definition' || scope.type === 'lambda')) {
                passedFunction = true;
            }
            const entries = bindingsOf(scope).get(name);
            if (!entries) continue;
            if (entries.some(entry => entry.kind === 'external')) return null;
            if (entries.some(entry => entry.kind === 'binding')) return { shadowed: true };
            const defs = [];
            for (const entry of entries) {
                const symbol = symbolFor(entry, name);
                if (!symbol) return null;
                defs.push(symbol);
            }
            return { defs };
        }
        return null;
    };
}

// ── Consumer positions: a call there is never a missing await ──

function hasChildToken(node, tokenType) {
    for (let i = 0; i < node.childCount; i++) {
        if (node.child(i).type === tokenType) return true;
    }
    return false;
}

/**
 * The async consumer a call feeds directly, or null:
 * 'async-for' (Python `async for` / async comprehension, JS `for await`,
 * C# `await foreach`) or 'async-with' (Python `async with`, C# `await using`).
 */
function asyncConsumerRole(callNode) {
    let expr = callNode;
    while (expr.parent?.type === 'parenthesized_expression') expr = expr.parent;
    let parent = expr.parent;
    if (!parent) return null;
    switch (parent.type) {
        case 'for_statement':
        case 'for_in_clause':
            return sameNode(parent.childForFieldName('right'), expr) && hasChildToken(parent, 'async')
                ? 'async-for' : null;
        case 'for_in_statement':
            return sameNode(parent.childForFieldName('right'), expr) && hasChildToken(parent, 'await')
                ? 'async-for' : null;
        case 'foreach_statement':
            return sameNode(parent.childForFieldName('right'), expr) && hasChildToken(parent, 'await')
                ? 'async-for' : null;
        case 'using_statement':
            return !sameNode(parent.childForFieldName('body'), expr) && hasChildToken(parent, 'await')
                ? 'async-with' : null;
        case 'as_pattern':
            if (!sameNode(parent.namedChild(0), expr)) return null;
            parent = parent.parent;
            if (parent?.type !== 'with_item') return null;
            // falls through
        case 'with_item': {
            const statement = parent.parent?.parent;
            return statement?.type === 'with_statement' && hasChildToken(statement, 'async')
                ? 'async-with' : null;
        }
        default:
            return null;
    }
}

/** Whether the call's value is discarded (a bare expression statement). */
function isDiscardedCall(callNode) {
    let expr = callNode;
    while (expr.parent?.type === 'parenthesized_expression') expr = expr.parent;
    return expr.parent?.type === 'expression_statement';
}

// fix #367c: where an unawaited coroutine/promise value GOES. Only a lost
// value (discarded, or stored in a local that is never read) or a value used
// as if it were already resolved is a missing await; any other destination
// (an argument, a collection/generator/spread element, a returned or yielded
// value, a conditional/logical branch that itself flows, a stored field)
// hands the awaitable on.
const VALUE_TRANSPARENT = new Set([
    'parenthesized_expression', 'as_expression', 'satisfies_expression',
    'non_null_expression', 'type_assertion',
]);
const VALUE_FLOW_PARENTS = new Set([
    // arguments
    'arguments', 'argument_list', 'argument', 'keyword_argument',
    // collections, spreads, generators, comprehensions
    'array', 'list', 'tuple', 'set', 'dictionary', 'pair', 'object',
    'spread_element', 'list_splat', 'dictionary_splat', 'expression_list',
    'generator_expression', 'list_comprehension', 'set_comprehension',
    'dictionary_comprehension', 'initializer_expression',
    'collection_expression', 'spread_expression',
    // handed to the caller
    'return_statement', 'yield_expression', 'yield', 'arrow_function', 'lambda',
    'lambda_expression', 'arrow_expression_clause', 'export_statement',
    // stored somewhere other than a plain local
    'assignment_pattern', 'default_parameter', 'public_field_definition',
    'field_definition', 'jsx_expression', 'sequence_expression',
]);
const RESOLVED_OPERATORS = new Set(['+', '-', '*', '/', '%', '**', '//', '@', '<', '>',
    '<=', '>=', '==', '!=', '===', '!==', '|', '&', '^', '<<', '>>', '>>>', 'in', 'instanceof']);
const AWAITABLE_MEMBERS = {
    // Promise protocol and Object.prototype members.
    promise: new Set(['then', 'catch', 'finally', 'constructor', 'toString', 'toLocaleString',
        'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable']),
    // Coroutine object protocol.
    coroutine: new Set(['send', 'throw', 'close', '__await__', 'cr_await', 'cr_frame',
        'cr_running', 'cr_code', 'cr_origin', 'cr_suspended']),
};

function fieldIs(parent, field, node) {
    const child = parent.childForFieldName(field);
    return !!child && sameNode(child, node);
}

function conditionOf(parent) {
    // Python conditional_expression has no field names: body `if` cond `else` alt.
    return parent.childForFieldName('condition') ||
        (parent.type === 'conditional_expression' && !parent.childForFieldName('consequence')
            ? parent.namedChild(1) : null);
}

/**
 * Classify an unawaited call's value. Returns
 *   { kind: 'flow' }                          handed on (no finding)
 *   { kind: 'discarded' }                     bare expression statement
 *   { kind: 'stored', binding, scopeNode }    plain local; caller checks reads
 *   { kind: 'used-as-value' }                 treated as the resolved value
 *   { kind: 'intentional' }                   explicit discard (`void`, C# `_ =`)
 */
function valueFlow(callNode, language) {
    let expr = callNode;
    for (let depth = 0; depth < 32; depth++) {
        const parent = expr.parent;
        if (!parent) return { kind: 'flow' };
        const type = parent.type;
        if (VALUE_TRANSPARENT.has(type)) { expr = parent; continue; }
        if (type === 'expression_statement') return { kind: 'discarded' };
        if (VALUE_FLOW_PARENTS.has(type)) return { kind: 'flow' };
        switch (type) {
            case 'ternary_expression':
            case 'conditional_expression': {
                const condition = conditionOf(parent);
                if (condition && sameNode(condition, expr)) return { kind: 'used-as-value' };
                expr = parent;
                continue;
            }
            case 'binary_expression':
            case 'boolean_operator': {
                const operator = parent.childForFieldName('operator')?.text ||
                    parent.children.find(child => !child.isNamed)?.text;
                if (operator === '??' || operator === '||' || operator === '&&' ||
                    operator === 'or' || operator === 'and') {
                    // The left operand is tested for truthiness (an
                    // awaitable is always truthy / never null); the right
                    // operand is the expression's value.
                    if (fieldIs(parent, 'left', expr)) return { kind: 'used-as-value' };
                    expr = parent;
                    continue;
                }
                return RESOLVED_OPERATORS.has(operator) ? { kind: 'used-as-value' } : { kind: 'flow' };
            }
            case 'comparison_operator':
            case 'binary_operator':
            case 'not_operator':
            case 'update_expression':
            case 'augmented_assignment_expression':
            case 'augmented_assignment':
            case 'template_substitution':
            case 'interpolation':
            case 'subscript_expression':
            case 'element_access_expression':
                return { kind: 'used-as-value' };
            case 'unary_expression':
            case 'unary_operator':
            case 'prefix_unary_expression': {
                const operator = parent.childForFieldName('operator')?.text ||
                    parent.children.find(child => !child.isNamed)?.text;
                if (operator === 'void') return { kind: 'intentional' };
                return operator === 'typeof' ? { kind: 'flow' } : { kind: 'used-as-value' };
            }
            case 'subscript':
                return fieldIs(parent, 'value', expr) ? { kind: 'used-as-value' } : { kind: 'flow' };
            case 'member_expression':
            case 'attribute': {
                if (!fieldIs(parent, 'object', expr)) return { kind: 'flow' };
                const member = (parent.childForFieldName('property') ||
                    parent.childForFieldName('attribute'))?.text;
                const members = type === 'attribute' ? AWAITABLE_MEMBERS.coroutine : AWAITABLE_MEMBERS.promise;
                return members.has(member) ? { kind: 'flow' } : { kind: 'used-as-value' };
            }
            case 'member_access_expression':
                // Task members (ConfigureAwait, Result, ContinueWith, ...).
                return { kind: 'flow' };
            case 'call_expression':
            case 'call':
                // `fn()(...)` calls the awaitable itself.
                return fieldIs(parent, 'function', expr) ? { kind: 'used-as-value' } : { kind: 'flow' };
            case 'if_statement':
            case 'while_statement':
            case 'do_statement':
            case 'elif_clause':
            case 'assert_statement':
                return fieldIs(parent, 'condition', expr) || type === 'assert_statement'
                    ? { kind: 'used-as-value' } : { kind: 'flow' };
            case 'for_statement':
            case 'for_in_statement':
            case 'for_in_clause':
            case 'foreach_statement':
                // A synchronous loop over the awaitable (async loops were
                // classified as consumers before this point).
                return fieldIs(parent, 'right', expr) ? { kind: 'used-as-value' } : { kind: 'flow' };
            case 'with_item':
            case 'as_pattern':
                return { kind: 'used-as-value' };
            case 'variable_declarator':
            case 'assignment_expression':
            case 'assignment':
            case 'named_expression':
            case 'equals_value_clause': {
                let holder = parent;
                if (type === 'equals_value_clause') holder = parent.parent;
                const target = holder?.childForFieldName('name') || holder?.childForFieldName('left');
                if (!target || (holder.type !== 'variable_declarator' && fieldIs(holder, 'left', expr)) ||
                    (target && sameNode(target, expr))) return { kind: 'flow' };
                if (['object_pattern', 'array_pattern', 'pattern_list', 'tuple_pattern', 'list_pattern']
                    .includes(target.type)) return { kind: 'used-as-value' };
                if (target.type !== 'identifier') return { kind: 'flow' };
                if (language === 'csharp' && target.text === '_') return { kind: 'intentional' };
                // fix #380: a plain assignment (not a declaration) whose
                // name is not a local of the enclosing function stores into
                // a field/property (implicit this) or an outer variable:
                // the value outlives the function and flows on.
                if ((holder.type === 'assignment_expression' || holder.type === 'assignment') &&
                    !assignmentTargetIsLocal(holder, target.text, language)) return { kind: 'flow' };
                return { kind: 'stored', binding: target.text, holder };
            }
            default:
                return { kind: 'flow' };
        }
    }
    return { kind: 'flow' };
}

// Function-like nodes that open a local scope, across the audited grammars.
const LOCAL_SCOPE_TYPES = new Set([
    'function_declaration', 'function_expression', 'arrow_function', 'method_definition',
    'generator_function', 'generator_function_declaration', 'function_definition',
    'async_function_definition', 'lambda', 'method_declaration', 'local_function_statement',
    'anonymous_method_expression', 'lambda_expression', 'constructor_declaration',
    'accessor_declaration', 'operator_declaration', 'conversion_operator_declaration',
    'destructor_declaration',
]);
// Declaration parents whose `name`/`left`/`pattern` child binds a local.
const LOCAL_DECLARATION_PARENTS = new Set([
    'variable_declarator', 'parameter', 'required_parameter', 'optional_parameter',
    'rest_pattern', 'catch_declaration', 'catch_clause', 'foreach_statement', 'for_in_statement',
    'declaration_expression', 'typed_parameter', 'default_parameter', 'typed_default_parameter',
    'formal_parameters', 'parameters', 'lambda_parameters', 'implicit_parameter',
    'single_variable_designation', 'for_each_statement', 'using_statement',
]);

/**
 * fix #380: whether the name assigned by `holder` is a local of its enclosing
 * function. Languages whose plain assignment declares a local (Python, unless
 * a `global`/`nonlocal` statement names it) answer from the statement; the
 * others (JS/TS: outer variables, C#: implicit-this fields and properties)
 * need a declaration or parameter of that name inside the function.
 */
function assignmentTargetIsLocal(holder, name, language) {
    let scope = holder.parent;
    while (scope && !LOCAL_SCOPE_TYPES.has(scope.type)) scope = scope.parent;
    if (!scope) return false;
    const declaresLocal = !!langTraits(language)?.assignmentDeclaresLocal;
    let declared = false;
    let escapes = false;
    const visit = node => {
        if (declared || escapes) return;
        if (!sameNode(node, scope) && LOCAL_SCOPE_TYPES.has(node.type)) return;
        if (declaresLocal) {
            if (node.type === 'global_statement' || node.type === 'nonlocal_statement') {
                for (let i = 0; i < node.namedChildCount; i++) {
                    if (node.namedChild(i).text === name) { escapes = true; return; }
                }
            }
        } else if (node.type === 'identifier' && node.text === name) {
            const parent = node.parent;
            if (parent && LOCAL_DECLARATION_PARENTS.has(parent.type) &&
                !(parent.type === 'foreach_statement' && !fieldIs(parent, 'left', node)) &&
                !(parent.type === 'for_in_statement' && !fieldIs(parent, 'left', node))) {
                const value = parent.childForFieldName('value');
                const init = parent.childForFieldName('default_value') || parent.childForFieldName('right');
                if (!(value && sameNode(value, node)) && !(init && sameNode(init, node))) {
                    declared = true;
                    return;
                }
            }
        }
        for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
    };
    visit(scope);
    return declaresLocal ? !escapes : declared;
}

/**
 * Whether a local that received an awaitable is read after the assignment
 * anywhere in its function (nested closures included) - a stored value that
 * is never read is as lost as a discarded one.
 */
function storedValueRead(holder, name, functionTypes) {
    let scope = holder.parent;
    while (scope && !functionTypes.has(scope.type)) scope = scope.parent;
    const root = scope ? (scope.childForFieldName('body') || scope) : null;
    let top = holder;
    while (!root && top.parent) top = top.parent;
    const searchRoot = root || top;
    const after = holder.endIndex;
    let found = false;
    const visit = node => {
        if (found || node.endIndex <= after) return;
        if (node.type === 'identifier' && node.text === name && node.startIndex >= after) {
            const parent = node.parent;
            const isWriteTarget = parent &&
                ['assignment', 'assignment_expression', 'variable_declarator'].includes(parent.type) &&
                (fieldIs(parent, 'left', node) || fieldIs(parent, 'name', node));
            if (!isWriteTarget) { found = true; return; }
        }
        for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
    };
    visit(searchRoot);
    return found;
}

// ── Rust futures (fix #370) ──
//
// Calling an `async fn` (or a fn whose return type is a future) creates a
// lazy future that runs only when polled: awaited, spawned, joined, selected,
// boxed/stored and used, or returned. A future that is discarded, dropped by
// `let _ =`, bound to a local that is never used, or used as if it were its
// Output never runs. The enclosing function does not matter: a sync fn that
// creates a future and drops it loses it too.

/** Base type name of a declared type string (`&'a mut foo::Bar<T>` -> Bar). */
function rustTypeBase(text) {
    let rest = String(text || '').trim();
    for (;;) {
        const before = rest;
        rest = rest.replace(/^&\s*/, '').replace(/^'[A-Za-z_]\w*\s+/, '').replace(/^mut\s+/, '').replace(/^dyn\s+/, '');
        if (rest === before) break;
    }
    const lt = rest.indexOf('<');
    const head = (lt >= 0 ? rest.slice(0, lt) : rest).trim();
    if (!/^[A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)*$/.test(head)) return null;
    const parts = head.split('::');
    return parts[parts.length - 1];
}

/**
 * Project types a returned value can be a future through: aliases of future
 * types (`type Fut = Pin<Box<dyn Future..>>`) and structs/enums with an
 * `impl Future for T`. Map name -> { kind, output }.
 */
function rustProjectFutureTypes(index) {
    const out = new Map();
    for (const [name, defs] of index.symbols) {
        let future = null;
        let other = false;
        for (const def of defs) {
            if (def.type === 'type' && def.futureReturn) {
                future = future || { kind: 'future', output: def.futureReturn.output ?? null };
            } else if ((def.type === 'struct' || def.type === 'enum') && Array.isArray(def.implements) &&
                def.implements.some(trait => rustTypeBase(trait) === 'Future')) {
                // A concrete type implementing Future may be a handle to work
                // that already started (a join handle): not known to be lazy.
                future = future || { kind: 'named', output: null, type: name };
            } else if (['struct', 'enum', 'type', 'trait', 'union'].includes(def.type)) {
                other = true;
            }
        }
        // A name shared with a non-future type cannot be told apart by name.
        if (future && !other) out.set(name, future);
    }
    return out;
}

// Future kinds whose loss is reported. 'named' (a type implementing Future)
// and 'wrapped' (a proc-macro attribute may rewrite the fn) are not known to
// be lazy: counted as not audited.
const RUST_LAZY_FUTURE_KINDS = new Set(['async', 'future']);

/** What calling a Rust definition returns when it is a future, else null. */
function rustDefFuture(def, futureTypes) {
    if (!def) return null;
    if (def.futureReturn) return def.futureReturn;
    if (futureTypes.size === 0 || typeof def.returnType !== 'string') return null;
    return futureTypes.get(rustTypeBase(def.returnType)) || null;
}




const rustFlow = require('../languages/rust-value-flow');
const { rustPatternBinds, rustLetPattern } = rustFlow;

/**
 * Where an unpolled Rust future value goes (languages/rust-value-flow.js).
 * A method called on it is judged here: a method of the future's own named
 * type flows; a project method of its Output type takes it for its Output.
 */
function rustMemberVerdict(index) {
    return (future, member, isMethod) => {
        if (!isMethod) {
            // An opaque future has no fields; a project future type
            // may declare its own.
            return future.kind === 'named' ? { kind: 'flow' } : { kind: 'used-as-value', member };
        }
        if (future.kind === 'named' && rustOwnedMethods(index, member, future.type).length > 0) {
            return { kind: 'flow' };
        }
        const outputOwner = rustTypeBase(future.output);
        return rustOwnedMethods(index, member, outputOwner).length > 0
            ? { kind: 'used-as-value', member } : { kind: 'flow' };
    };
}

function rustValueFlow(index, exprNode, future) {
    return rustFlow.rustValueFlow(exprNode, future, rustMemberVerdict(index));
}

function rustStoredFutureUse(index, holder, name, future) {
    return rustFlow.rustStoredFutureUse(holder, name, future, rustMemberVerdict(index));
}

/**
 * Lexical binding of a bare call name inside the enclosing function:
 * { future } for a local closure whose body is an async block,
 * { shadowed: true } for any other local/parameter, null when none binds it.
 */
function rustLocalCallee(callNode, name) {
    let child = callNode;
    for (let scope = callNode.parent; scope; child = scope, scope = scope.parent) {
        if (scope.type === 'block') {
            let found = null;
            for (let i = 0; i < scope.namedChildCount; i++) {
                const statement = scope.namedChild(i);
                if (statement.startIndex >= child.startIndex) break;
                if (statement.type === 'let_declaration' && rustPatternBinds(rustLetPattern(statement), name)) {
                    found = statement;
                }
            }
            if (found) {
                const value = found.childForFieldName('value');
                const body = value?.type === 'closure_expression' ? value.childForFieldName('body') : null;
                return body?.type === 'async_block' ? { future: { kind: 'future', output: null } } : { shadowed: true };
            }
        } else if (scope.type === 'closure_expression') {
            if (rustPatternBinds(scope.childForFieldName('parameters'), name)) return { shadowed: true };
        } else if (scope.type === 'function_item') {
            const params = scope.childForFieldName('parameters');
            for (const param of params?.namedChildren || []) {
                if (rustPatternBinds(param.childForFieldName('pattern'), name)) return { shadowed: true };
            }
            return null;
        } else if (scope.type === 'match_arm' || scope.type === 'if_expression' || scope.type === 'while_expression') {
            const pattern = scope.type === 'match_arm'
                ? scope.childForFieldName('pattern')
                : scope.childForFieldName('condition');
            if (pattern && !sameNode(pattern, child) && rustPatternBinds(
                pattern.type === 'let_condition' ? pattern.childForFieldName('pattern') : pattern, name)) {
                return { shadowed: true };
            }
        } else if (scope.type === 'for_expression') {
            if (!sameNode(scope.childForFieldName('value'), child) &&
                rustPatternBinds(scope.childForFieldName('pattern'), name)) return { shadowed: true };
        }
    }
    return null;
}

/** Project methods named `method` owned by type `owner`. */
function rustOwnedMethods(index, method, owner) {
    if (!owner) return [];
    return (index.symbols.get(method) || []).filter(def =>
        isCallableDef(def) && (def.className === owner || def.receiver === owner));
}




/**
 * Index of future-producing definitions by name, split by the call shapes
 * that can reach them: free functions (bare/module-path calls), members by
 * owner type, and trait-declared members (reachable through dispatch).
 */
function rustFutureDefIndex(index, futureTypes) {
    const byName = new Map();
    for (const [name, defs] of index.symbols) {
        let entry = null;
        for (const def of defs) {
            if (!isCallableDef(def) || !rustDefFuture(def, futureTypes)) continue;
            entry = entry || { defs: [] };
            const owner = def.className || def.receiver;
            const ownerDefs = owner ? index.symbols.get(def.className || '') || [] : [];
            entry.defs.push({
                def,
                owner: owner || null,
                traitDeclared: ownerDefs.some(ownerDef => ownerDef.type === 'trait'),
                // Private items are visible only inside their own module.
                moduleScope: rustPrivateModuleScope(def, ownerDefs),
            });
        }
        if (entry) byName.set(name, entry);
    }
    return byName;
}

/**
 * The module a private (no `pub`) Rust item is confined to, as
 * { file, dir }: its own file and, for `mod.rs`/`lib.rs`/`main.rs` or a
 * `name.rs` with a `name/` directory, the child module files. Null when the
 * item is visible beyond its module (any `pub`, trait declarations and trait
 * impl members, which take the trait's visibility).
 */
function rustPrivateModuleScope(def, ownerDefs) {
    const modifiers = Array.isArray(def.modifiers) ? def.modifiers : [];
    if (modifiers.some(modifier => /^pub\b/.test(modifier))) return null;
    if (def.traitImpl || ownerDefs.some(ownerDef => ownerDef.type === 'trait')) return null;
    if (!def.file || !def.file.endsWith('.rs')) return null;
    const path = require('path');
    const base = path.basename(def.file);
    const dir = ['mod.rs', 'lib.rs', 'main.rs'].includes(base)
        ? path.dirname(def.file)
        : def.file.slice(0, -3);
    return { file: def.file, dir: dir + path.sep };
}

function rustDefVisibleFrom(entryDef, filePath) {
    const scope = entryDef.moduleScope;
    return !scope || filePath === scope.file || String(filePath).startsWith(scope.dir);
}

/**
 * `a.producer().name()`: every project definition of `producer` declares a
 * return type whose own `name` method is not a future (and the type has no
 * future `name`). Then the chained call cannot reach a future producer.
 */
function rustProducerReturnsSyncOwner(index, producer, name, owners) {
    const producers = (index.symbols.get(producer) || []).filter(isCallableDef);
    if (producers.length === 0) return false;
    for (const def of producers) {
        let owner = rustTypeBase(def.returnTypeResolved || def.returnType);
        if (owner === 'Self') owner = def.className || def.receiver || null;
        if (!owner || owners.has(owner)) return false;
        const methods = (index.symbols.get(name) || []).filter(method =>
            isCallableDef(method) && (method.className === owner || method.receiver === owner));
        if (methods.length === 0) return false;
    }
    return true;
}

/**
 * Cheap name-level test on an indexed call record: can this call shape reach
 * any future producer of its name? (A bare call never reaches a method; a
 * typed receiver reaches only its own type's members or a trait's.)
 */
function rustRecordMayReachFuture(record, futureDefs, index, filePath) {
    const all = record?.name ? futureDefs.get(record.name) : null;
    if (!all) return false;
    const visible = filePath ? all.defs.filter(entryDef => rustDefVisibleFrom(entryDef, filePath)) : all.defs;
    if (visible.length === 0) return false;
    const entry = {
        free: visible.some(entryDef => !entryDef.owner),
        owners: new Set(visible.filter(entryDef => entryDef.owner).map(entryDef => entryDef.owner)),
        traitDeclared: visible.some(entryDef => entryDef.traitDeclared),
    };
    if (!record.isMethod) return entry.free;
    if (index && record.receiverCall && !record.receiverType && !record.isPathCall &&
        rustProducerReturnsSyncOwner(index, record.receiverCall, record.name, entry.owners)) return false;
    if (record.isPathCall) {
        const parts = String(record.receiver || '').split('::').filter(Boolean);
        const last = parts[parts.length - 1];
        if (['std', 'core', 'alloc'].includes(parts[0])) return false;
        return entry.free || last === 'Self' || entry.owners.has(last) || entry.traitDeclared;
    }
    if (record.receiverType) return entry.owners.has(record.receiverType) || entry.traitDeclared;
    return entry.owners.size > 0;
}

/**
 * Whether the type through which a call reached a project method can be that
 * method's owner. The engine pins receivers by type NAME; a `use std::fs::File`
 * or a `crate::loom::sync::Mutex` field type names a different type than a
 * same-name project type, and such a site is not audited.
 */
function rustTargetTypeNamed(index, filePath, record, def) {
    const owner = def.className || def.receiver;
    if (!owner) return true;
    const { rustTypeNameDenotes } = require('./callers');
    const external = qualifier => ['std', 'core', 'alloc'].includes(String(qualifier || '').split('::')[0]);
    // Several project types share the owner's name: the naming site must
    // positively reach the target's file.
    const ambiguous = (index.symbols.get(owner) || []).filter(symbol =>
        ['struct', 'enum', 'type', 'trait', 'union'].includes(symbol.type)).length > 1;
    const denotes = (file) => {
        const verdict = rustTypeNameDenotes(index, file, owner, def.file);
        return verdict === 'yes' || (verdict === 'unknown' && !ambiguous);
    };
    if (record.receiverTypeQualifier && external(record.receiverTypeQualifier)) return false;
    if (record.isPathCall && record.receiver) {
        const parts = String(record.receiver).split('::').filter(Boolean);
        if (parts.length > 1 && external(parts[0])) return false;
        const last = parts[parts.length - 1];
        if (last === owner && parts.length === 1 && !denotes(filePath)) return false;
        return true;
    }
    if (record.receiverRootType && Array.isArray(record.receiverFields) && record.receiverFields.length > 0) {
        // The last field's declared type is written in its struct's file.
        let type = record.receiverRootType;
        let field = null;
        for (const name of record.receiverFields) {
            field = (index.symbols.get(name) || []).find(symbol =>
                symbol.type === 'field' && symbol.className === type && symbol.fieldType);
            if (!field) return !ambiguous;
            type = rustTypeBase(field.fieldType);
        }
        if (type !== owner) return !ambiguous;
        return denotes(field.file);
    }
    if (record.receiverType === owner && ['annotation', 'guess', 'constructor'].includes(record.receiverTypeSource) &&
        !denotes(filePath)) return false;
    return true;
}


function rustEnclosingName(node) {
    for (let cur = node.parent; cur; cur = cur.parent) {
        if (cur.type === 'function_item') return cur.childForFieldName('name')?.text || '<anonymous>';
    }
    return '<module>';
}

/**
 * Can calling project method `member` on the value of a `name(..)` call take
 * a future for its Output? Only when some producer of that name is not
 * known, is a named future type, or has an Output type owning `member`.
 * Name-level: needs no syntax tree (fix #371 uses it as a prefilter).
 */
function rustMemberMayMisuse(index, futureDefs, futureTypes, name, member) {
    const entry = futureDefs?.get(name);
    if (!entry) return true;
    return entry.defs.some(({ def }) => {
        const future = rustDefFuture(def, futureTypes);
        return !future || future.kind === 'named' ||
            rustOwnedMethods(index, member, rustTypeBase(future.output)).length > 0;
    });
}

/**
 * Whether a call record's value is provably not lost without reading the
 * file (fix #371): awaited or passed on where it is produced, or the
 * receiver of a method that cannot take a future for its Output.
 */
function rustRecordValueConsumed(index, futureDefs, futureTypes, record) {
    if (record.valueConsumed) return true;
    return !!record.consumingMethod &&
        !rustMemberMayMisuse(index, futureDefs, futureTypes, record.name, record.consumingMethod);
}

function rustCallableSymbols(fileEntry) {
    return (fileEntry.symbols || []).filter(sym => isCallableDef(sym) && sym.startLine && sym.endLine);
}

/** The innermost callable definition enclosing a line (the callee-query owner). */
function rustSiteOwner(symbols, line) {
    let owner = null;
    for (const sym of symbols) {
        if (sym.startLine <= line && sym.endLine >= line &&
            (!owner || sym.startLine >= owner.startLine)) owner = sym;
    }
    return owner;
}

/**
 * Engine targets of the call named `name` starting at `start`, read from the
 * owner's findCallees result: confirmed callees at that site, plus the
 * trait's own declaration for a possible dispatch through a trait (every
 * implementation must match it). [] when a dispatch trait has no declared
 * member of that name.
 */
function rustSiteTargets(index, callees, start, line, name) {
    const atSite = callee => callee.name === name && (callee.siteProvenance || []).some(site =>
        site.start === start || (!Number.isInteger(site.start) && site.line === line));
    const targets = callees.filter(atSite);
    for (const entry of callees.unverifiedCallees || []) {
        if (entry.reason !== 'possible-dispatch' || !entry.dispatchVia || !atSite(entry)) continue;
        const declared = rustOwnedMethods(index, name, entry.dispatchVia);
        if (declared.length === 0) return [];
        targets.push(...declared);
    }
    return targets;
}

/**
 * Resolve every possibly-lost candidate call record of a file through the
 * engine, before any parse (fix #371): one restricted findCallees run per
 * enclosing function. Returns { calleeMemo, needsTree } - needsTree is false
 * when no candidate can reach a future producer, so the file is not read.
 */
function rustResolveCandidates(ctx, records) {
    const { index, futureTypes, fileEntry, filePath } = ctx;
    const symbols = rustCallableSymbols(fileEntry);
    const byOwner = new Map();
    for (const record of records) {
        const owner = rustSiteOwner(symbols, record.line);
        if (!owner) continue;
        if (!byOwner.has(owner)) byOwner.set(owner, new Set());
        byOwner.get(owner).add(record.callStart);
    }
    const calleeMemo = new Map();
    for (const [owner, siteStarts] of byOwner) {
        let callees;
        try {
            callees = index.findCallees(owner, { collectAccount: true, siteStarts }) || [];
        } catch (_) {
            callees = [];
        }
        calleeMemo.set(owner, callees);
    }
    let needsTree = false;
    for (const record of records) {
        const owner = rustSiteOwner(symbols, record.line);
        if (!owner) continue;
        const targets = rustSiteTargets(index, calleeMemo.get(owner), record.callStart, record.line, record.name);
        if (targets.length > 0 && targets.every(def => rustTargetTypeNamed(index, filePath, record, def) &&
            rustDefFuture(def, futureTypes))) {
            needsTree = true;
            break;
        }
    }
    return { calleeMemo, needsTree };
}

/**
 * Audit one Rust file. `ctx`: { index, futureTypes, candidateNames,
 * fileEntry, filePath, tree, calls }. Returns issue records.
 */
function auditRustFile(ctx) {
    const { index, futureTypes, candidateNames, fileEntry, filePath, tree } = ctx;
    const issues = [];
    const relativePath = fileEntry.relativePath || filePath;
    const calls = Array.isArray(ctx.calls) ? ctx.calls : [];
    const callsByStart = new Map();
    for (const call of calls) {
        if (Number.isInteger(call?.callStart)) callsByStart.set(call.callStart, call);
    }
    const symbols = rustCallableSymbols(fileEntry);
    // Engine resolution is batched per enclosing function and restricted to
    // the sites that need it (fix #371): a collecting pass records them, one
    // findCallees run per function resolves exactly those sites. A caller
    // may pass sites it already resolved (ctx.calleeMemo).
    const calleeMemo = ctx.calleeMemo || new Map();
    let pendingSites = null;
    const lostCandidates = [];
    const confirmedTargets = (callNode, name) => {
        const line = callNode.startPosition.row + 1;
        const owner = rustSiteOwner(symbols, line);
        if (!owner) return null;
        if (pendingSites) {
            if (!calleeMemo.has(owner)) {
                if (!pendingSites.has(owner)) pendingSites.set(owner, new Set());
                pendingSites.get(owner).add(callNode.startIndex);
            }
            return null;
        }
        if (!calleeMemo.has(owner)) {
            let callees;
            try {
                callees = index.findCallees(owner, { collectAccount: true }) || [];
            } catch (_) {
                callees = [];
            }
            calleeMemo.set(owner, callees);
        }
        return rustSiteTargets(index, calleeMemo.get(owner), callNode.startIndex, line, name);
    };
    const futureOfCall = (callNode, fnNode) => {
        let target = fnNode;
        if (target.type === 'generic_function') target = target.childForFieldName('function');
        if (!target) return null;
        let name;
        if (target.type === 'identifier') name = target.text;
        else if (target.type === 'scoped_identifier') name = target.childForFieldName('name')?.text;
        else if (target.type === 'field_expression') name = target.childForFieldName('field')?.text;
        if (!name) return null;
        if (target.type === 'identifier') {
            const local = rustLocalCallee(callNode, name);
            if (local?.shadowed) return null;
            if (local?.future) return { name, future: local.future };
        }
        if (!candidateNames.has(name)) return null;
        const record = callsByStart.get(callNode.startIndex);
        if (!record || record.name !== name ||
            (ctx.futureDefs && !rustRecordMayReachFuture(record, ctx.futureDefs, index, filePath))) return null;
        const targets = confirmedTargets(callNode, name);
        if (!targets || targets.length === 0) return null;
        if (targets.some(def => !rustTargetTypeNamed(index, filePath, record, def))) return null;
        const futures = targets.map(def => rustDefFuture(def, futureTypes));
        if (futures.some(future => !future)) return null;
        return { name, future: futures[0] };
    };
    const lazy = future => RUST_LAZY_FUTURE_KINDS.has(future.kind);
    const push = (node, name, reason, extra) => issues.push({
        file: relativePath,
        line: node.startPosition.row + 1,
        callerName: rustEnclosingName(node),
        calleeName: name,
        reason,
        ...extra,
    });
    const skipped = ctx.skipped || { count: 0 };
    // A value that is awaited or handed on needs no producer resolution;
    // only a possibly lost or misused value is resolved (engine callees).
    // A method called on the value is a misuse only when it is a project
    // method of some producer's Output type (or a field of an opaque future).
    const memberMayMisuse = (name, memberNode) => {
        const parent = memberNode?.parent;
        const call = parent?.parent;
        if (!(call?.type === 'call_expression' && fieldIs(call, 'function', parent))) return true;
        const member = parent.childForFieldName('field')?.text;
        return rustMemberMayMisuse(index, ctx.futureDefs, futureTypes, name, member);
    };
    const mayBeLost = (node, name) => {
        const flow = rustValueFlow(index, node, null);
        if (flow.kind === 'awaited' || flow.kind === 'flow') return false;
        if (flow.kind === 'member') return memberMayMisuse(name, flow.node);
        if (flow.kind !== 'stored') return true;
        const use = rustStoredFutureUse(index, flow.holder, flow.binding, null);
        if (!use.read) return true;
        if (!use.misuse) return false;
        const misuseFlow = rustValueFlow(index, use.misuse, null);
        return misuseFlow.kind !== 'member' || memberMayMisuse(name, misuseFlow.node);
    };
    const visit = node => {
        if (node.type === 'call_expression') {
            const fnNode = node.childForFieldName('function');
            const target = fnNode?.type === 'generic_function' ? fnNode.childForFieldName('function') : fnNode;
            const quickName = target?.type === 'identifier' ? target.text
                : (target?.childForFieldName('name') || target?.childForFieldName('field'))?.text;
            const plausible = quickName && (candidateNames.has(quickName) ||
                (target.type === 'identifier' && ctx.asyncClosures?.has(quickName)));
            if (pendingSites) {
                // Collecting pass: record the sites that need resolution.
                if (plausible && mayBeLost(node, quickName)) {
                    lostCandidates.push(node);
                    futureOfCall(node, fnNode);
                }
                return;
            }
            const resolved = plausible && mayBeLost(node, quickName) ? futureOfCall(node, fnNode) : null;
            if (resolved) {
                const { name, future } = resolved;
                const flow = rustValueFlow(index, node, future);
                const use = flow.kind === 'stored'
                    ? rustStoredFutureUse(index, flow.holder, flow.binding, future) : null;
                const lost = flow.kind === 'discarded' || flow.kind === 'dropped' ||
                    flow.kind === 'used-as-value' || (use && (!!use.misuse || !use.read));
                if (lost && !lazy(future)) {
                    skipped.count++;
                } else if (flow.kind === 'discarded') {
                    push(node, name, 'future-discarded');
                } else if (flow.kind === 'dropped') {
                    push(node, name, 'future-dropped');
                } else if (flow.kind === 'used-as-value') {
                    push(node, name, 'async-result-used-as-value');
                } else if (use) {
                    if (use.misuse) {
                        issues.push({
                            file: relativePath,
                            line: use.misuse.startPosition.row + 1,
                            callerName: rustEnclosingName(node),
                            calleeName: name,
                            reason: 'stored-future-used-as-value',
                            variable: flow.binding,
                            originLine: node.startPosition.row + 1,
                        });
                    } else if (!use.read) {
                        push(node, name, 'future-unused', { variable: flow.binding });
                    }
                }
            }
        }
    };
    // Only indexed call records can be resolved: jump to each candidate
    // record's call node instead of walking the whole tree.
    const root = tree.rootNode;
    const seen = new Set();
    const starts = [];
    for (const record of calls) {
        if (!Number.isInteger(record?.callStart) || !Number.isInteger(record?.callEnd) || record.inMacro) continue;
        if (!(record.localShadow && ctx.asyncClosures?.has(record.name)) && !(ctx.futureDefs
            ? rustRecordMayReachFuture(record, ctx.futureDefs, index, filePath)
            : candidateNames.has(record.name))) continue;
        if (seen.has(record.callStart)) continue;
        seen.add(record.callStart);
        // Awaited, passed on, or the receiver of a method that cannot take
        // it for its Output (parser facts): nothing to resolve (fix #371).
        if (rustRecordValueConsumed(index, ctx.futureDefs, futureTypes, record)) continue;
        starts.push(record);
    }
    starts.sort((a, b) => a.callStart - b.callStart);
    const nodes = [];
    for (const record of starts) {
        let node = root.descendantForIndex(record.callStart, record.callEnd);
        while (node && !(node.type === 'call_expression' && node.startIndex === record.callStart &&
            node.endIndex === record.callEnd)) node = node.parent;
        if (node) nodes.push(node);
    }
    // Collect the sites whose producer needs engine resolution, resolve them
    // per enclosing function, then audit in source order.
    pendingSites = new Map();
    for (const node of nodes) visit(node);
    const batches = pendingSites;
    pendingSites = null;
    for (const [owner, siteStarts] of batches) {
        if (calleeMemo.has(owner)) continue;
        let callees;
        try {
            callees = index.findCallees(owner, { collectAccount: true, siteStarts }) || [];
        } catch (_) {
            callees = [];
        }
        calleeMemo.set(owner, callees);
    }
    for (const node of lostCandidates) visit(node);
    return issues;
}

module.exports = {
    auditRustFile,
    rustResolveCandidates,
    rustRecordValueConsumed,
    rustFutureDefIndex,
    rustRecordMayReachFuture,
    rustProjectFutureTypes,
    rustDefFuture,
    valueFlow,
    storedValueRead,
    isCallableDef,
    isDefAsync,
    producerKind,
    collapseKinds,
    createLexicalResolver,
    asyncConsumerRole,
    isDiscardedCall,
    resolveDecorator,
};
