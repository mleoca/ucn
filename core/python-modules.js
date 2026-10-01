/**
 * Resolve Python module objects through imported names and package attributes.
 * A module import, a from-imported submodule and an ordinary package value
 * have different bindings. Unknown or conflicting bindings never pin a file.
 * The caller owns the memo and discards it when the index changes.
 */
'use strict';

const path = require('path');

function moduleFile(index, entry, name) {
    const rel = entry.moduleResolved?.[name];
    return rel ? path.isAbsolute(rel) ? rel : path.join(index.root, rel) : null;
}

function pythonModulePath(index, file, receiver, memo = new Map(), seen = new Set()) {
    memo ||= new Map();
    const key = `py-module\0${file}\0${receiver}`;
    if (memo.has(key)) return memo.get(key);
    if (seen.has(key) || seen.size >= 16) return { files: [], unknown: true };
    const next = new Set(seen).add(key);
    const entry = index.files.get(file);
    if (!entry) return { files: [], unknown: true };
    const [head, ...tail] = receiver.split('.');
    const named = (entry.importBindings || []).filter(b => (b.alias || b.name) === head);
    const bindings = named.filter(b =>
        !(entry.symbols || []).some(s => s.startLine <= b.line && s.endLine >= b.line));
    if (bindings.length === 0) return named.length ? { files: [], unknown: true } : null;
    const files = new Set();
    let unknown = (entry.moduleAssignedNames || []).includes(head) ||
        (entry.symbols || []).some(s => s.name === head && !s.className &&
            s.lexicalScopeStartLine == null);
    let bound = false;
    let external = false;
    for (const b of bindings) {
        const module = String(b.module || '');
        if (b.kind !== 'import') {
            const parent = moduleFile(index, entry, module);
            const parentEntry = index.files.get(parent);
            if ((parentEntry?.moduleAssignedNames || []).includes(b.name) ||
                (parentEntry?.symbols || []).some(s => s.name === b.name && !s.className &&
                    s.lexicalScopeStartLine == null)) {
                // A from-import reads the package's attribute before
                // loading a same-named child module.
                bound = true;
                unknown = true;
                continue;
            }
        }
        const spec = b.kind === 'import' ? module
            : module.endsWith('.') ? module + b.name : `${module}.${b.name}`;
        const start = moduleFile(index, entry, spec);
        if (start) {
            bound = true;
            files.add(start);
        } else if (b.kind === 'import') {
            bound = true;
            const { bindingIsExternal } = require('./type-denotation');
            if (bindingIsExternal(index, entry, file, b) !== true) unknown = true;
            else external = true;
        } else {
            // A package can re-export a module imported under another
            // name. Chase that binding, never a same-spelled disk path.
            const parent = moduleFile(index, entry, module);
            const imported = parent && pythonModulePath(index, parent, b.name, memo, next);
            if (imported) {
                bound = true;
                unknown ||= imported.unknown;
                external ||= imported.files.length === 0 && !imported.unknown;
                for (const target of imported.files) files.add(target);
            } else if (bindings.length > 1) unknown = true;
        }
    }
    if (!bound) return null;
    unknown ||= external && files.size > 0;
    let current = [...files];
    for (const part of tail) {
        const children = new Set();
        let externalChild = false;
        for (const parent of current) {
            const imported = pythonModulePath(index, parent, part, memo, next);
            if (imported) {
                unknown ||= imported.unknown;
                externalChild ||= imported.files.length === 0 && !imported.unknown;
                for (const target of imported.files) children.add(target);
                continue;
            }
            const parentEntry = index.files.get(parent);
            const rebound = (parentEntry?.moduleAssignedNames || []).includes(part) ||
                (parentEntry?.symbols || []).some(s => s.name === part) ||
                (parentEntry?.importBindings || []).some(b => (b.alias || b.name) === part);
            // `import pkg.sub` loads sub onto the package object. Its
            // indexed child is usable unless the package binds that
            // attribute to a different (or unknown) value.
            const child = path.basename(parent) === '__init__.py' && !rebound
                ? [path.join(path.dirname(parent), part + '.py'),
                    path.join(path.dirname(parent), part, '__init__.py')]
                    .find(candidate => index.files.has(candidate)) : null;
            if (child) children.add(child);
            else unknown = true;
        }
        unknown ||= externalChild && children.size > 0;
        current = [...children];
    }
    const result = { files: current, unknown };
    memo.set(key, result);
    return result;
}

/** Whether a module root is read from global scope at its written origin.
 * An annotation's origin is its annotation node, not a later call in the
 * function body; a class's bases are evaluated outside its own body. */
function pythonModuleScope(index, file, receiver, site, memo = new Map()) {
    if (!site) return true;
    memo ||= new Map();
    const head = receiver.split('.')[0];
    const key = `py-module-scope\0${file}\0${head}\0${site.start ?? ''}\0${site.end ?? ''}\0${site.startLine ?? ''}`;
    if (memo.has(key)) return memo.get(key);
    let ownedTree;
    let result = false;
    try {
        const content = index._readFile(file);
        const { getParser, safeParse } = require('../languages');
        const tree = index._getParsedTree(file, content, 'python') ||
            (ownedTree = safeParse(getParser('python'), content));
        let node;
        if (Number.isInteger(site.start) && Number.isInteger(site.end)) {
            node = tree?.rootNode.descendantForIndex(site.start, Math.max(site.start, site.end - 1));
        } else if (site.startLine != null && site.endLine != null) {
            const stack = tree ? [tree.rootNode] : [];
            while (stack.length) {
                const current = stack.pop();
                if (current.endPosition.row + 1 < site.startLine ||
                    current.startPosition.row + 1 > site.endLine) continue;
                if (current.type === 'class_definition' &&
                    current.childForFieldName('name')?.text === site.name &&
                    current.endPosition.row + 1 === site.endLine) {
                    node = current.childForFieldName('superclasses');
                    break;
                }
                for (const child of current.namedChildren) stack.push(child);
            }
        }
        if (node) {
            const { referenceScope } = require('../languages/lexical-scope');
            const scopesKey = 'py-module-scopes';
            let trees = memo.get(scopesKey);
            if (!trees) { trees = new WeakMap(); memo.set(scopesKey, trees); }
            let scopes = trees.get(tree);
            if (!scopes) { scopes = new Map(); trees.set(tree, scopes); }
            result = referenceScope(node, 'python', scopes, head) === 'module';
        }
    } finally {
        ownedTree?.delete?.();
    }
    memo.set(key, result);
    return result;
}

/** Definitions a resolved module exposes under this exact type name.
 * Preserve the file-closure witness for unmodeled wildcard exports. A
 * definitive different binding never takes that fallback. */
function pythonModuleTypes(index, file, name, definitions) {
    const { _nameBindingReaches, _importReaches } = require('./callers');
    const verdicts = definitions.map(def => ({ def, verdict: _nameBindingReaches(
        index, file, name, new Set([def.file]), 8, { exactName: true }) }));
    const named = verdicts.filter(row => row.verdict === 'yes').map(row => row.def);
    if (named.length) return named;
    return verdicts.filter(row => row.verdict === 'unknown' &&
        _importReaches(index, file, new Set([row.def.file]))).map(row => row.def);
}

module.exports = { pythonModulePath, pythonModuleScope, pythonModuleTypes };
