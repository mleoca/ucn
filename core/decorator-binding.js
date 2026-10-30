/**
 * core/decorator-binding.js - Decorators that may bind a callable by its name
 * (fix #392).
 *
 * Where a decorator replaces the callable (`decoratorsWrapCallables`: Python,
 * JS/TS), it receives the function object, and with it the function's NAME:
 * a pytest fixture is requested by it, a click command and a Flask endpoint
 * are named after it, a registry may key on `fn.__name__`, a TS member
 * decorator receives the property key. Renaming the definition and its
 * references is then not the whole rename. A decorator is known to keep the
 * name out of it when:
 *   - it resolves (through the file's import bindings or builtins) to one of
 *     the language's name-preserving decorators (trait `callableDecorators`:
 *     `transparent`, `asyncContextManagers`, `namePreserving`);
 *   - it is the member's own property accessor (`@size.setter` on `size`);
 *   - it resolves to a project function whose decorated-callable parameter is
 *     only called, returned, passed to `functools.wraps`/`update_wrapper`, or
 *     tested with `callable`/`isinstance` (Python), or whose name/context
 *     parameters are never read (JS/TS); a decorator factory `@f(args)` is
 *     proven through the decorator it returns.
 * Any other decorator is reported, so the plan asks for review.
 */

'use strict';

const { langTraits, getParser, safeParse } = require('../languages');
const { sameNode, traverseTree } = require('../languages/utils');
const { resolveDecorator } = require('./async-producers');

function namedChildrenOf(node) {
    return node ? node.namedChildren || [] : [];
}

function treeOf(index, filePath) {
    const entry = index.files.get(filePath);
    if (!entry) return null;
    let content;
    try { content = index._readFile(filePath); } catch { return null; }
    const tree = index._getParsedTree?.(filePath, content, entry.language);
    if (tree) return tree;
    const parser = getParser(entry.language);
    return parser ? safeParse(parser, content) : null;
}

/** The function node declared at `line` (1-based) with `name`. */
function functionNodeAt(tree, line, name) {
    let found = null;
    const row = line - 1;
    traverseTree(tree.rootNode, node => {
        if (found) return false;
        if (node.endPosition.row < row || node.startPosition.row > row) return false;
        const nameNode = node.childForFieldName?.('name');
        if (nameNode && nameNode.text === name && nameNode.startPosition.row === row &&
            /function|method|arrow/.test(node.type)) {
            found = node;
            return false;
        }
        if (node.type === 'variable_declarator' && nameNode?.text === name &&
            nameNode.startPosition.row === row) {
            const value = node.childForFieldName('value');
            if (value && /function|arrow/.test(value.type)) {
                found = value;
                return false;
            }
        }
        return true;
    });
    return found;
}

function firstParamName(fnNode, family) {
    const params = fnNode.childForFieldName('parameters') || fnNode.childForFieldName('parameter');
    if (!params) return null;
    if (params.type === 'identifier') return params.text;
    for (const param of namedChildrenOf(params)) {
        if (param.type === 'identifier') return param.text;
        const nameNode = param.childForFieldName?.('name') || param.childForFieldName?.('pattern');
        if (nameNode?.type === 'identifier') return nameNode.text;
        if (family === 'python' && param.type === 'typed_parameter' &&
            param.namedChild(0)?.type === 'identifier') return param.namedChild(0).text;
        return null;
    }
    return null;
}

function paramNames(fnNode) {
    const params = fnNode.childForFieldName('parameters') || fnNode.childForFieldName('parameter');
    if (!params) return [];
    if (params.type === 'identifier') return [params.text];
    const names = [];
    for (const param of namedChildrenOf(params)) {
        if (param.type === 'identifier') { names.push(param.text); continue; }
        const nameNode = param.childForFieldName?.('name') || param.childForFieldName?.('pattern');
        names.push(nameNode?.type === 'identifier' ? nameNode.text : null);
    }
    return names;
}

/**
 * Python: the decorated-callable parameter `p` of decorator `fnNode` is only
 * called, returned, passed to functools.wraps/update_wrapper, or tested.
 */
function pythonParamKeepsName(fnNode, p, resolveName) {
    const body = fnNode.childForFieldName('body');
    if (!body) return false;
    let proven = true;
    traverseTree(body, node => {
        if (!proven) return false;
        if (node.type !== 'identifier' || node.text !== p) return true;
        const parent = node.parent;
        if (!parent) { proven = false; return false; }
        // `return p`
        if (parent.type === 'return_statement') return true;
        // `p(...)`
        if (parent.type === 'call' && sameNode(parent.childForFieldName('function'), node)) return true;
        // `wraps(p)`, `update_wrapper(w, p)`, `callable(p)`, `isinstance(p, T)`
        if (parent.type === 'argument_list' && parent.parent?.type === 'call') {
            const callee = parent.parent.childForFieldName('function');
            const key = callee ? resolveName(callee.text) : null;
            if (key === 'functools.wraps' || key === 'functools.update_wrapper' ||
                key === 'builtins.callable' || key === 'builtins.isinstance') return true;
        }
        proven = false;
        return false;
    });
    return proven;
}

/** JS/TS: every parameter after the decorated value is unread. */
function jsExtraParamsUnread(fnNode) {
    const names = paramNames(fnNode).slice(1);
    if (names.some(n => n === null)) return false;
    if (names.length === 0) return true;
    const body = fnNode.childForFieldName('body');
    if (!body) return true;
    let read = false;
    traverseTree(body, node => {
        if (read) return false;
        if (node.type === 'identifier' && names.includes(node.text)) read = true;
        return !read;
    });
    return !read;
}

/** The nested decorator a factory returns (`return inner` / `return lambda..`). */
function returnedDecorator(fnNode, family) {
    const body = fnNode.childForFieldName('body');
    if (!body) return null;
    const nested = new Map();
    const returns = [];
    traverseTree(body, node => {
        if (sameNode(node, body)) return true;
        if (/^(function_definition|function_declaration)$/.test(node.type)) {
            const n = node.childForFieldName('name');
            if (n) nested.set(n.text, node);
            return false;
        }
        if (/function|arrow|lambda/.test(node.type)) return false;
        if (node.type === 'variable_declarator') {
            const n = node.childForFieldName('name');
            const v = node.childForFieldName('value');
            if (n && v && /function|arrow/.test(v.type)) nested.set(n.text, v);
        }
        if (node.type === 'return_statement') returns.push(node);
        return true;
    });
    // JS arrow shorthand: `(x) => (target, key) => {}`
    if (family === 'js' && body.type !== 'statement_block' && /function|arrow/.test(body.type)) return body;
    if (returns.length !== 1) return null;
    const value = returns[0].namedChild(0);
    if (!value) return null;
    if (value.type === 'identifier') return nested.get(value.text) || null;
    if (/function|arrow/.test(value.type)) return value;
    return null;
}

/**
 * Resolve a decorator's head name to one project callable definition, or null.
 */
function projectDecoratorDef(index, def, head, rest, implementation = false) {
    const { _nameBindingReaches, _moduleAttributeBindingReaches } = require('./callers');
    const target = rest ? rest.slice(1) : head;
    if (rest && rest.includes('.', 1)) return null;
    // `@overload` stubs declare signatures of the implementation beside
    // them; the implementation decides what a call returns (fix #434).
    const candidates = (index.symbols.get(target) || []).filter(candidate =>
        !candidate.className && /function|method/.test(candidate.type || 'function') &&
        !(implementation && (candidate.decorators || []).some(name =>
            /^(typing\.)?overload$/.test(String(typeof name === 'string' ? name : name?.name || '')))));
    const reaching = candidates.filter(candidate => {
        const targets = new Set([candidate.file]);
        if (!rest) {
            if (candidate.file === def.file) return true;
            return _nameBindingReaches(index, def.file, head, targets) === 'yes';
        }
        return _moduleAttributeBindingReaches(index, def.file, head, target, targets) === 'yes';
    });
    return reaching.length === 1 ? reaching[0] : null;
}

function provenProjectDecorator(index, def, text, family, resolveName, memo) {
    const call = text.indexOf('(');
    const expr = (call >= 0 ? text.slice(0, call) : text).trim();
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/.test(expr)) return false;
    const dot = expr.indexOf('.');
    const head = dot < 0 ? expr : expr.slice(0, dot);
    const rest = dot < 0 ? '' : expr.slice(dot);
    const target = projectDecoratorDef(index, def, head, rest);
    if (!target) return false;
    const key = `${target.file}\0${target.startLine}\0${call >= 0 ? 1 : 0}`;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, false); // recursion guard
    const tree = treeOf(index, target.file);
    let fnNode = tree ? functionNodeAt(tree, target.nameLine || target.startLine, target.name) : null;
    if (fnNode && call >= 0) fnNode = returnedDecorator(fnNode, family);
    let proven = false;
    if (fnNode) {
        if (family === 'python') {
            const p = firstParamName(fnNode, family);
            const targetEntry = index.files.get(target.file);
            const vocab = langTraits(targetEntry?.language)?.callableDecorators || {};
            const resolveInTarget = name => resolveDecorator(name, targetEntry, vocab)?.name || null;
            proven = !!p && pythonParamKeepsName(fnNode, p, resolveInTarget);
        } else {
            proven = jsExtraParamsUnread(fnNode);
        }
    }
    memo.set(key, proven);
    return proven;
}

/**
 * Decorators of `def` not proven to keep its name out of what they do.
 * Returns [] when the language's decorators never replace the callable.
 */
function nameBindingDecorators(index, def, memo = new Map()) {
    const decorators = Array.isArray(def.decorators) ? def.decorators : [];
    if (decorators.length === 0) return [];
    const fileEntry = index.files.get(def.file);
    const traits = fileEntry ? langTraits(fileEntry.language) : null;
    if (!traits?.decoratorsWrapCallables) return [];
    const family = fileEntry.language === 'python' ? 'python' : 'js';
    const vocab = traits.callableDecorators || {};
    const preserving = new Set([...(vocab.transparent || []), ...(vocab.asyncContextManagers || []),
        ...(vocab.namePreserving || [])]);
    const resolveName = name => resolveDecorator(name, fileEntry, vocab)?.name || null;
    const unproven = [];
    for (const raw of decorators) {
        const text = String(typeof raw === 'string' ? raw : raw?.name || '').replace(/^@/, '').trim();
        if (!text) continue;
        const resolved = resolveDecorator(text, fileEntry, vocab);
        if (resolved) {
            const key = resolved.name + (resolved.called ? '()' : '');
            if (preserving.has(key) || preserving.has(resolved.name)) continue;
        }
        // The member's own property accessors keep its name by definition.
        if (new RegExp(`^${def.name.replace(/[$]/g, '\\$')}\\.(setter|getter|deleter)$`).test(text)) continue;
        if (provenProjectDecorator(index, def, text, family, resolveName, memo)) continue;
        unproven.push(text);
    }
    return unproven;
}

// A Python `if` condition testing the parameter against None: true for
// `p is None`, false for `p is not None`, null for anything else.
function noneTest(condition, p) {
    if (condition?.type !== 'comparison_operator' || condition.namedChildCount !== 2) return null;
    const [left, right] = condition.namedChildren;
    if (left.type !== 'identifier' || left.text !== p || right.type !== 'none') return null;
    const operators = condition.children.filter(child => !child.isNamed).map(child => child.type);
    if (operators.length === 1 && operators[0] === 'is') return true;
    if (operators.length === 2 && operators[0] === 'is' && operators[1] === 'not') return false;
    return null;
}

/**
 * The return statements of a Python function body that run when the
 * parameter `p` is None (`pIsNone`) or is a class (fix #434): branches of
 * `if p is None` / `if p is not None` the value rules out are skipped;
 * nested definitions, lambdas and classes run elsewhere.
 */
function pythonReturnsUnder(block, p, pIsNone, out = []) {
    for (const statement of namedChildrenOf(block)) {
        if (statement.type === 'return_statement') { out.push(statement); continue; }
        if (/^(function_definition|class_definition|decorated_definition)$/.test(statement.type)) continue;
        if (statement.type === 'if_statement') {
            const test = noneTest(statement.childForFieldName('condition'), p);
            if (test !== null) {
                if (test === pIsNone) pythonReturnsUnder(statement.childForFieldName('consequence'), p, pIsNone, out);
                else {
                    for (const alternative of namedChildrenOf(statement).filter(child =>
                        child.type === 'else_clause' || child.type === 'elif_clause')) {
                        if (alternative.type === 'elif_clause') return null;
                        pythonReturnsUnder(alternative.childForFieldName('body'), p, pIsNone, out);
                    }
                }
                continue;
            }
        }
        let invalid = false;
        traverseTree(statement, node => {
            if (invalid) return false;
            if (/^(function_definition|class_definition|lambda)$/.test(node.type)) return false;
            if (node.type === 'return_statement') out.push(node);
            if (node.type === 'yield') invalid = true;
            return true;
        });
        if (invalid) return null;
    }
    return out;
}

/** Nested function definitions of a body, by name (not inside other defs). */
function nestedDefinitions(fnNode) {
    const nested = new Map();
    const body = fnNode.childForFieldName('body');
    traverseTree(body, node => {
        if (sameNode(node, body)) return true;
        const definition = node.type === 'decorated_definition' ? node.childForFieldName('definition') : node;
        if (definition?.type === 'function_definition') {
            const name = definition.childForFieldName('name');
            if (name && node.type === 'function_definition') nested.set(name.text, definition);
            return false;
        }
        return !/^(class_definition|lambda)$/.test(node.type);
    });
    return nested;
}

/**
 * Python: decorator `fnNode` applied to a class returns that class (fix
 * #434): every return reachable when its first parameter holds the class
 * returns the parameter, or passes it first to a nested function that
 * does. `pIsNone` evaluates the factory form (`@d(..)` with the class
 * parameter left at its None default): every reachable return then gives
 * a decorator that returns its argument.
 */
function pythonReturnsItsClass(fnNode, scope, depth = 0, pIsNone = false) {
    if (!fnNode || depth > 4) return false;
    const p = firstParamName(fnNode, 'python');
    const body = fnNode.childForFieldName('body');
    if (!p || !body) return false;
    const nested = new Map([...scope, ...nestedDefinitions(fnNode)]);
    const returns = pythonReturnsUnder(body, p, pIsNone);
    if (!returns || returns.length === 0) return false;
    return returns.every(statement => {
        const value = statement.namedChild(0);
        if (pIsNone) {
            const decorator = value?.type === 'identifier' ? nested.get(value.text) : null;
            return !!decorator && pythonReturnsItsClass(decorator, nested, depth + 1);
        }
        if (value?.type === 'identifier') return value.text === p;
        if (value?.type !== 'call') return false;
        const callee = value.childForFieldName('function');
        const first = namedChildrenOf(value.childForFieldName('arguments'))[0];
        const inner = callee?.type === 'identifier' ? nested.get(callee.text) : null;
        return !!inner && first?.type === 'identifier' && first.text === p &&
            pythonReturnsItsClass(inner, nested, depth + 1);
    });
}

/**
 * Whether a project class decorator returns the class it decorates (fix
 * #434): `@register` / `@rich_repr` / `@rich_repr(angular=True)` keep the
 * class (and its synthesized initializer) in place.
 */
function classPreservingDecorator(index, classDef, text) {
    const fileEntry = index.files.get(classDef.file);
    if (fileEntry?.language !== 'python') return false;
    const call = text.indexOf('(');
    const expr = (call >= 0 ? text.slice(0, call) : text).trim();
    if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?$/.test(expr)) return false;
    const dot = expr.indexOf('.');
    const head = dot < 0 ? expr : expr.slice(0, dot);
    const rest = dot < 0 ? '' : expr.slice(dot);
    const target = projectDecoratorDef(index, classDef, head, rest, true);
    if (!target) return false;
    const tree = treeOf(index, target.file);
    const fnNode = tree ? functionNodeAt(tree, target.nameLine || target.startLine, target.name) : null;
    if (!fnNode) return false;
    if (call < 0) return pythonReturnsItsClass(fnNode, new Map());
    // The factory form: the class parameter is left at its None default
    // when no positional argument is passed.
    const args = text.slice(call + 1, text.lastIndexOf(')')).trim();
    const positional = args.length > 0 && args.split(',').some(arg => !/^\s*[A-Za-z_]\w*\s*=/.test(arg));
    const firstParam = namedChildrenOf(fnNode.childForFieldName('parameters'))[0];
    if (!positional && firstParam?.type === 'default_parameter' &&
        firstParam.childForFieldName('value')?.type === 'none') {
        return pythonReturnsItsClass(fnNode, new Map(), 0, true);
    }
    return pythonReturnsItsClass(returnedDecorator(fnNode, 'python'), new Map());
}

module.exports = { nameBindingDecorators, classPreservingDecorator };
