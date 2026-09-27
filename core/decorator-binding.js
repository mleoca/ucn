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
function projectDecoratorDef(index, def, head, rest) {
    const { _nameBindingReaches, _moduleAttributeBindingReaches } = require('./callers');
    const target = rest ? rest.slice(1) : head;
    if (rest && rest.includes('.', 1)) return null;
    const candidates = (index.symbols.get(target) || []).filter(candidate =>
        !candidate.className && /function|method/.test(candidate.type || 'function'));
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

module.exports = { nameBindingDecorators };
