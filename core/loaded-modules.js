'use strict';

/**
 * Module objects a program loads by path or by a literal name (fix #507).
 *
 *     spec = importlib.util.spec_from_file_location("n", SCRIPT_PATH)
 *     mod = importlib.util.module_from_spec(spec)
 *     spec.loader.exec_module(mod)
 *     mod.main()
 *
 * binds `mod` to the module at SCRIPT_PATH: `mod.main()` calls the `main`
 * that file binds and no other. The answer is read for the receiver of one
 * call record, from the syntax tree of the file that holds it, by the trait
 * `loadedModule` of the file's language:
 *
 *   null                         the receiver is not shown to hold such a module
 *   { kind: 'file', file }       the module at that indexed file
 *   { kind: 'files', files }     one of these indexed files: the path has a
 *                                runtime part and these are the files it matches
 *   { kind: 'unread' }           a loader is proven, its path is not readable
 *   { kind: 'unresolved' }       a readable path that names no indexed file
 *   { kind: 'ambiguous', files } a relative path that names a different file
 *                                read from the loading file's own directory
 *   { kind: 'module', module }   a literal module name the resolver did not place
 *
 * each with `via`, a short text naming the loader and the path. A relative
 * path is read from the directory the file's test runner runs in (the one
 * its printed commands run from), else the project root.
 */

const path = require('path');
const { langTraits, getParser, safeParse } = require('../languages');
const { sameNode } = require('../languages/utils');
const { referenceScopeNode, pythonScopeBindingTable } = require('../languages/lexical-scope');
const { pythonPossibleIdentities, pythonSourceName } = require('./python-binding-identity');

const MAX_DEPTH = 12;
const MAX_HELPER_HOPS = 2;

// Standard-library loaders, by the identity the file's bindings give them.
const SPEC_FROM_FILE = 'importlib.util.spec_from_file_location';
const MODULE_FROM_SPEC = 'importlib.util.module_from_spec';
const SOURCE_FILE_LOADER = 'importlib.machinery.SourceFileLoader';
const IMPORT_MODULE = 'importlib.import_module';
// Text a file must hold for any of them to be called in it.
const LOADER_WORDS = ['module_from_spec', 'load_module', 'import_module'];

// Path-valued standard functions: what each makes of its arguments.
const PATH_CONSTRUCTORS = new Set(['pathlib.Path', 'pathlib.PurePath', 'pathlib.PosixPath', 'pathlib.PurePosixPath']);
const PATH_SAME = new Set(['os.path.abspath', 'os.path.realpath', 'os.path.normpath', 'os.fspath', 'builtins.str']);
// Path spellings `os` names (POSIX values: the paths are matched as POSIX).
const OS_PATH_CONSTANTS = { 'os.pardir': '..', 'os.curdir': '.', 'os.path.pardir': '..', 'os.path.curdir': '.' };
// Methods and properties of a path that keep its file.
const PATH_SAME_METHODS = new Set(['resolve', 'absolute']);
// Names a file may rebind any module-level name through.
const NAMESPACE_WRITERS = new Set(['exec', 'eval', 'globals', 'vars', 'locals', 'setattr', 'delattr']);

const WILD = null;

/** The module a call's receiver holds, or null (see the header). */
function loadedModuleOfReceiver(index, filePath, call) {
    if (!call || !call.isMethod || !call.receiver || call.receiverField || call.receiverModuleSpecifier) return null;
    const entry = index.files.get(filePath);
    // A module receiver the import graph placed is an import, not a load:
    // only one whose every import of the name is a load the graph could
    // not read (`const m = require(P)`) is read here (fix #513).
    if (call.receiverIsModule && !unplacedLoadBinding(entry, call.receiver)) return null;
    const reader = entry && langTraits(entry.language)?.loadedModule;
    if (!reader) return null;
    const memo = index._opMemo?.('loadedModuleOfReceiver') || null;
    const key = `${filePath}\0${call.callSite?.start ?? call.callStart ?? ''}\0${call.line}\0${call.receiver}`;
    if (memo?.has(key)) return memo.get(key);
    let answer;
    try {
        answer = reader(index, filePath, call) || null;
    } catch {
        answer = null;
    }
    memo?.set(key, answer);
    return answer;
}

/** Are the file's imports of `name` all loads the import graph did not place? */
function unplacedLoadBinding(entry, name) {
    const bindings = (entry?.importBindings || []).filter(binding => (binding.alias || binding.name) === name);
    return bindings.length > 0 && bindings.every(binding => binding.dynamic === true &&
        !entry.moduleResolved?.[binding.module]);
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

/** The module the receiver of a Python call record holds (trait `loadedModule`). */
function pythonLoadedModule(index, filePath, call) {
    let content;
    try { content = index._readFile(filePath); } catch { return null; }
    // A file that names no loader holds no load: asked once per file.
    const named = index._opMemo?.('loadedModuleWords') || null;
    let mayLoad = named?.get(filePath);
    if (mayLoad === undefined) {
        mayLoad = LOADER_WORDS.some(word => content.includes(word));
        named?.set(filePath, mayLoad);
    }
    if (!mayLoad) return null;
    return withTree(index, filePath, content, 'python', tree => {
        const receiver = receiverNode(tree, call);
        if (!receiver) return null;
        const ctx = {
            index, filePath, entry: index.files.get(filePath), tree,
            scopeMemo: new Map(), identityMemo: new Map(), identities: new Map(), helperHops: 0,
        };
        const value = boundValue(receiver, ctx);
        if (!value) return null;
        const loaded = moduleOf(value, ctx, 0);
        return loaded ? place(loaded, ctx) : null;
    });
}

function withTree(index, filePath, content, language, read) {
    let owned = null;
    try {
        const tree = index._getParsedTree?.(filePath, content, language) ||
            (owned = safeParse(getParser(language), content));
        return tree ? read(tree) : null;
    } finally {
        owned?.delete?.();
    }
}

/** The identifier `mod` of `mod.name(..)` at the record's site. */
function receiverNode(tree, call) {
    const site = call.callSite;
    if (!site || site.start == null || site.end == null) return null;
    const token = tree.rootNode.descendantForIndex(site.start, site.end);
    const attribute = token?.parent;
    if (attribute?.type !== 'attribute' || !sameNode(attribute.childForFieldName('attribute'), token)) return null;
    const object = attribute.childForFieldName('object');
    return object?.type === 'identifier' && object.text === call.receiver ? object : null;
}

/**
 * The standard API a callee spelling names, or null. Its spelling must
 * resolve to one origin through imports that are the only bindings of its
 * first name in the scope the name is read from (a function reads the
 * module's import whenever it runs), that name never declared global or
 * written through, no member of it written, and no project module of the
 * imported name (which shadows the standard one).
 */
function standardIdentity(callee, ctx) {
    const node = unwrap(callee);
    if (!node) return null;
    const key = `${node.startIndex}:${node.endIndex}`;
    if (ctx.identities.has(key)) return ctx.identities.get(key);
    let identity;
    try { identity = readStandardIdentity(node, ctx); } catch { identity = null; }
    ctx.identities.set(key, identity);
    return identity;
}

function readStandardIdentity(node, ctx) {
    let root = node;
    while (root?.type === 'attribute') root = unwrap(root.childForFieldName('object'));
    if (root?.type !== 'identifier') return null;
    const origins = pythonPossibleIdentities(node, ctx.identityMemo);
    if (origins.length !== 1) return null;
    const scope = referenceScopeNode(root, root.text, ctx.scopeMemo);
    if (!scope || !SCOPES.has(scope.type) || escapes(ctx.tree, root.text)) return null;
    // Imports only (`import importlib` beside `import importlib.util` binds
    // the one package twice); the single origin above says they agree.
    const sites = pythonScopeBindingTable(scope).get(root.text) || [];
    if (sites.length === 0 || sites.some(site => site.kind !== 'import')) return null;
    if (scope.type === 'module' && namespaceWritten(ctx.tree)) return null;
    if (membersWritten(ctx.tree.rootNode, root.text)) return null;
    const identity = origins[0];
    for (const module of Object.keys(ctx.entry?.moduleResolved || {})) {
        if (identity === module || identity.startsWith(`${module}.`)) return null;
    }
    return identity;
}

/** Is the callee the standard API of that identity? */
function isStandard(callee, identity, ctx) {
    return standardIdentity(callee, ctx) === identity;
}

/** The identity of a standard callee among `identities`, or null. */
function standardOf(callee, identities, ctx) {
    const identity = standardIdentity(callee, ctx);
    return identity && identities.includes(identity) ? identity : null;
}

/** An argument by position or keyword. */
function argumentOf(call, position, keyword) {
    const args = call.childForFieldName('arguments')?.namedChildren || [];
    const named = args.find(arg => arg.type === 'keyword_argument' &&
        arg.childForFieldName('name')?.text === keyword);
    if (named) return named.childForFieldName('value');
    let at = 0;
    for (const arg of args) {
        if (arg.type === 'keyword_argument') continue;
        if (['list_splat', 'dictionary_splat'].includes(arg.type)) return null;
        if (at === position) return arg;
        at++;
    }
    return null;
}

const SCOPES = new Set(['function_definition', 'module']);

/**
 * The value a name holds where it is read: its one binding in the scope the
 * read resolves to, an unconditional assignment that is a statement of that
 * scope and is written before the read (or the read is in a function the
 * scope defines). Null when the name is bound more than once, by anything
 * else, under a condition, declared global or nonlocal anywhere, written
 * through a namespace, or its members are written.
 */
function boundValue(identifier, ctx) {
    if (identifier?.type !== 'identifier') return null;
    const name = identifier.text;
    const scope = referenceScopeNode(identifier, name, ctx.scopeMemo);
    if (!scope || !SCOPES.has(scope.type)) return null;
    if (escapes(ctx.tree, name)) return null;
    const sites = pythonScopeBindingTable(scope).get(name) || [];
    if (sites.length !== 1 || sites[0].kind !== 'binding') return null;
    const target = sites[0].node;
    let assignment = target.parent;
    if (assignment?.type !== 'assignment' || !sameNode(assignment.childForFieldName('left'), target)) return null;
    // `a = b = value` binds both names to value.
    let statement = assignment;
    while (statement.parent?.type === 'assignment') statement = statement.parent;
    if (statement.parent?.type !== 'expression_statement' || !isStatementOf(statement.parent, scope)) return null;
    const deferred = crossesFunction(identifier, scope);
    if (!deferred && assignment.endIndex > identifier.startIndex) return null;
    if (scope.type === 'module' && namespaceWritten(ctx.tree)) return null;
    if (membersWritten(scope, name)) return null;
    let value = assignment.childForFieldName('right');
    while (value?.type === 'assignment') value = value.childForFieldName('right');
    return value || null;
}

/** Is `statement` a statement of the scope's own body, not under a condition? */
function isStatementOf(statement, scope) {
    const holder = statement.parent;
    if (scope.type === 'module') return sameNode(holder, scope);
    return sameNode(holder, scope.childForFieldName('body'));
}

/** Does a function (or lambda) stand between the node and the scope? */
function crossesFunction(node, scope) {
    for (let parent = node.parent; parent && !sameNode(parent, scope); parent = parent.parent) {
        if (['function_definition', 'lambda'].includes(parent.type)) return true;
    }
    return false;
}

const ESCAPES = new WeakMap();
/** Is the name declared global or nonlocal anywhere in the file? */
function escapes(tree, name) {
    let names = ESCAPES.get(tree);
    if (!names) {
        names = new Set();
        for (const declaration of tree.rootNode.descendantsOfType(['global_statement', 'nonlocal_statement'])) {
            for (const part of declaration.namedChildren) if (part.type === 'identifier') names.add(pythonSourceName(part.text));
        }
        ESCAPES.set(tree, names);
    }
    return names.has(pythonSourceName(name));
}

const NAMESPACE_WRITES = new WeakMap();
/** Does the file call something that can rebind a module-level name? */
function namespaceWritten(tree) {
    if (NAMESPACE_WRITES.has(tree)) return NAMESPACE_WRITES.get(tree);
    const written = tree.rootNode.descendantsOfType('call').some(call => {
        const callee = call.childForFieldName('function');
        return callee?.type === 'identifier' && NAMESPACE_WRITERS.has(pythonSourceName(callee.text));
    }) || tree.rootNode.descendantsOfType('wildcard_import').length > 0;
    NAMESPACE_WRITES.set(tree, written);
    return written;
}

/**
 * Are members of the name written in the scope (`mod.main = ..`, `del
 * mod.main`, `setattr(mod, ..)`, `mod.__dict__`, `vars(mod)`)? Then a call
 * of a member may not reach what the loaded file binds.
 */
function membersWritten(scope, name) {
    const root = scope;
    const isName = node => node?.type === 'identifier' && node.text === name;
    for (const node of root.descendantsOfType(['assignment', 'augmented_assignment', 'delete_statement', 'attribute', 'call'])) {
        if (node.type === 'attribute') {
            if (isName(node.childForFieldName('object')) &&
                ['__dict__', '__setattr__', '__delattr__'].includes(node.childForFieldName('attribute')?.text)) return true;
            continue;
        }
        if (node.type === 'call') {
            const callee = node.childForFieldName('function');
            const first = node.childForFieldName('arguments')?.namedChildren?.[0];
            if (callee?.type === 'identifier' && ['setattr', 'delattr', 'vars'].includes(callee.text) && isName(first)) return true;
            continue;
        }
        const targets = node.type === 'delete_statement' ? node.namedChildren : [node.childForFieldName('left')];
        const stack = targets.filter(Boolean);
        // The name at the root of a written member chain (`mod.main = ..`,
        // `importlib.util.module_from_spec = ..`, `mod.table[k] = ..`).
        const rootOf = node => {
            while (node?.type === 'attribute' || node?.type === 'subscript') {
                node = unwrap(node.childForFieldName(node.type === 'attribute' ? 'object' : 'value'));
            }
            return node;
        };
        while (stack.length > 0) {
            const target = stack.pop();
            if ((target.type === 'attribute' || target.type === 'subscript') && isName(rootOf(target))) return true;
            if (['pattern_list', 'tuple_pattern', 'list_pattern', 'expression_list', 'tuple', 'list',
                'parenthesized_expression'].includes(target.type)) stack.push(...target.namedChildren);
        }
    }
    return false;
}

function unwrap(node) {
    while (node?.type === 'parenthesized_expression') node = node.namedChild(0);
    return node;
}

/**
 * The module an expression evaluates to: a loader's result, a name bound
 * to one, or a call of a function of the file whose every return gives one.
 * Answers { kind, via, path?, module? } before placing; null when not shown.
 */
function moduleOf(expression, ctx, depth) {
    const node = unwrap(expression);
    if (!node || depth > MAX_DEPTH) return null;
    if (node.type === 'identifier') {
        const value = boundValue(node, ctx);
        return value ? moduleOf(value, ctx, depth + 1) : null;
    }
    if (node.type !== 'call') return null;
    const callee = unwrap(node.childForFieldName('function'));
    if (!callee) return null;
    if (isStandard(callee, MODULE_FROM_SPEC, ctx)) {
        // A module made from a spec this reader cannot follow is still a
        // module: its path is not read.
        const spec = specOf(argumentOf(node, 0, 'spec'), ctx, depth + 1);
        return { ...(spec || { kind: 'unread' }), via: MODULE_FROM_SPEC };
    }
    if (callee.type === 'attribute' && callee.childForFieldName('attribute')?.text === 'load_module') {
        const loader = loaderOf(callee.childForFieldName('object'), ctx, depth + 1);
        return loader ? { ...loader, via: `${SOURCE_FILE_LOADER}.load_module` } : null;
    }
    if (isStandard(callee, IMPORT_MODULE, ctx)) {
        const args = node.childForFieldName('arguments')?.namedChildren || [];
        const name = literalString(argumentOf(node, 0, 'name'));
        // A relative name is read against `package`: not modeled.
        if (!name || name.startsWith('.') || args.length !== 1) return { kind: 'unread', via: IMPORT_MODULE };
        return { kind: 'module', module: name, via: IMPORT_MODULE };
    }
    if (callee.type === 'identifier') return helperModule(callee, ctx, depth);
    return null;
}

/** The spec `spec_from_file_location(name, location)` gives: its location. */
function specOf(expression, ctx, depth) {
    const node = unwrap(expression);
    if (!node || depth > MAX_DEPTH) return null;
    if (node.type === 'identifier') {
        const value = boundValue(node, ctx);
        return value ? specOf(value, ctx, depth + 1) : null;
    }
    if (node.type !== 'call' || !isStandard(unwrap(node.childForFieldName('function')), SPEC_FROM_FILE, ctx)) return null;
    return pathAnswer(argumentOf(node, 1, 'location'), ctx);
}

/** The path a `SourceFileLoader(name, path)` loads. */
function loaderOf(expression, ctx, depth) {
    const node = unwrap(expression);
    if (!node || depth > MAX_DEPTH) return null;
    if (node.type === 'identifier') {
        const value = boundValue(node, ctx);
        return value ? loaderOf(value, ctx, depth + 1) : null;
    }
    if (node.type !== 'call' || !isStandard(unwrap(node.childForFieldName('function')), SOURCE_FILE_LOADER, ctx)) return null;
    return pathAnswer(argumentOf(node, 1, 'path'), ctx);
}

function pathAnswer(argument, ctx) {
    const value = argument ? pathOf(argument, ctx, 0) : null;
    if (!value || value.unknown || value.parts.every(part => part === WILD)) return { kind: 'unread' };
    return { kind: 'path', path: value };
}

/**
 * A function of the file called by name whose every return gives the same
 * module (one hop of return flow, at most MAX_HELPER_HOPS deep): not
 * decorated, not a generator, bound once.
 */
function helperModule(callee, ctx, depth) {
    if (ctx.helperHops >= MAX_HELPER_HOPS) return null;
    const scope = referenceScopeNode(callee, callee.text, ctx.scopeMemo);
    if (!scope || !SCOPES.has(scope.type) || escapes(ctx.tree, callee.text)) return null;
    const sites = pythonScopeBindingTable(scope).get(callee.text) || [];
    if (sites.length !== 1 || sites[0].kind !== 'def') return null;
    const definition = sites[0].node.parent;
    if (definition?.type !== 'function_definition' || definition.parent?.type === 'decorated_definition') return null;
    if (scope.type === 'module' && namespaceWritten(ctx.tree)) return null;
    const body = definition.childForFieldName('body');
    const own = node => {
        for (let parent = node.parent; parent; parent = parent.parent) {
            if (sameNode(parent, definition)) return true;
            if (['function_definition', 'lambda', 'class_definition'].includes(parent.type)) return false;
        }
        return false;
    };
    if (body.descendantsOfType(['yield', 'await']).some(own)) return null;
    const returns = body.descendantsOfType('return_statement').filter(own);
    if (returns.length === 0) return null;
    ctx.helperHops++;
    try {
        let answer = null;
        for (const statement of returns) {
            const value = statement.namedChild(0);
            const loaded = value ? moduleOf(value, ctx, depth + 1) : null;
            if (!loaded) return null;
            if (!answer) { answer = loaded; continue; }
            if (!sameLoad(answer, loaded)) return null;
        }
        return answer;
    } finally {
        ctx.helperHops--;
    }
}

function sameLoad(a, b) {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'module') return a.module === b.module;
    if (a.kind === 'path') return a.path.parts.length === b.path.parts.length &&
        a.path.parts.every((part, at) => part === b.path.parts[at]);
    return false;
}

// ---------------------------------------------------------------------------
// Path values: a list of parts, each a string or WILD (a runtime part)
// ---------------------------------------------------------------------------

const exact = text => ({ parts: [text] });
const UNKNOWN = Object.freeze({ unknown: true, parts: [WILD] });

function isExact(value) {
    return !!value && !value.unknown && value.parts.length === 1 && typeof value.parts[0] === 'string';
}

function concat(...values) {
    const parts = [];
    for (const value of values) {
        for (const part of value.parts) {
            if (part !== WILD && typeof parts[parts.length - 1] === 'string') parts[parts.length - 1] += part;
            else if (part !== WILD || parts[parts.length - 1] !== WILD || parts.length === 0) parts.push(part);
        }
    }
    return { parts };
}

/** os.path.join / pathlib `/`: a later absolute part replaces what is before it. */
function join(values) {
    let joined = null;
    for (const value of values) {
        if (!value || value.unknown) return null;
        // A runtime part at the start may be absolute.
        if (value.parts[0] === WILD) return null;
        if (value.parts[0].startsWith('/') || !joined) { joined = value; continue; }
        const last = joined.parts[joined.parts.length - 1];
        joined = last === WILD || last.endsWith('/') ? concat(joined, value) : concat(joined, exact('/'), value);
    }
    return joined;
}

function dirname(value) {
    if (!isExact(value)) return null;
    return exact(path.posix.dirname(path.posix.normalize(value.parts[0])));
}

/** The path an expression is, or UNKNOWN for a runtime string, or null. */
function pathOf(expression, ctx, depth) {
    const node = unwrap(expression);
    if (!node || depth > MAX_DEPTH) return null;
    switch (node.type) {
        case 'string': return stringValue(node);
        case 'concatenated_string': {
            const values = node.namedChildren.map(stringValue);
            return values.every(Boolean) ? concat(...values) : null;
        }
        case 'identifier': {
            if (node.text === '__file__' && unbound(node, ctx)) return exact(ctx.filePath);
            const value = boundValue(node, ctx);
            if (value) return pathOf(value, ctx, depth + 1);
            return isParameter(node, ctx) ? UNKNOWN : null;
        }
        case 'binary_operator': {
            const operator = node.childForFieldName('operator')?.text;
            const left = pathOf(node.childForFieldName('left'), ctx, depth + 1);
            const right = pathOf(node.childForFieldName('right'), ctx, depth + 1);
            if (!left || !right) return null;
            if (operator === '/') return join([left, right]);
            if (operator === '+') return concat(left, right);
            return null;
        }
        case 'attribute': {
            if (node.childForFieldName('attribute')?.text === 'parent') {
                return dirname(pathOf(node.childForFieldName('object'), ctx, depth + 1));
            }
            const constant = standardOf(node, Object.keys(OS_PATH_CONSTANTS), ctx);
            return constant ? exact(OS_PATH_CONSTANTS[constant]) : null;
        }
        case 'subscript': {
            // `p.parents[N]`: the N+1-th directory above p.
            const value = unwrap(node.childForFieldName('value'));
            const subscripts = node.namedChildren.filter(child => !sameNode(child, node.childForFieldName('value')));
            if (value?.type !== 'attribute' || value.childForFieldName('attribute')?.text !== 'parents' ||
                subscripts.length !== 1 || subscripts[0].type !== 'integer' || !/^\d+$/.test(subscripts[0].text)) return null;
            let dir = pathOf(value.childForFieldName('object'), ctx, depth + 1);
            for (let up = Number(subscripts[0].text); dir && up >= 0; up--) dir = dirname(dir);
            return dir;
        }
        case 'call': return pathCall(node, ctx, depth);
        default: return null;
    }
}

function pathCall(node, ctx, depth) {
    const callee = unwrap(node.childForFieldName('function'));
    const args = node.childForFieldName('arguments')?.namedChildren || [];
    if (args.some(arg => ['keyword_argument', 'list_splat', 'dictionary_splat'].includes(arg.type))) return null;
    const values = () => args.map(arg => pathOf(arg, ctx, depth + 1));
    if (callee?.type === 'attribute') {
        const method = callee.childForFieldName('attribute')?.text;
        const object = callee.childForFieldName('object');
        // A method of a path object.
        if (PATH_SAME_METHODS.has(method) && args.length === 0 && !standardModuleRoot(object, ctx)) {
            return pathOf(object, ctx, depth + 1);
        }
        if (method === 'joinpath' && !standardModuleRoot(object, ctx)) {
            return join([pathOf(object, ctx, depth + 1), ...values()]);
        }
    }
    const identity = standardOf(callee, [...PATH_CONSTRUCTORS, ...PATH_SAME, 'os.path.join', 'os.path.dirname'], ctx) ||
        (callee?.type === 'identifier' && callee.text === 'str' && unbound(callee, ctx) ? 'builtins.str' : null);
    if (!identity) return null;
    if (PATH_CONSTRUCTORS.has(identity)) return args.length === 0 ? exact('.') : join(values());
    if (identity === 'os.path.join') return args.length === 0 ? null : join(values());
    if (args.length !== 1) return null;
    const [value] = values();
    if (!value || value.unknown) return identity === 'builtins.str' && value ? value : null;
    if (identity === 'os.path.dirname') return dirname(value);
    return value;
}

/** Is the callee's receiver a module (so `.resolve()` is no path method)? */
function standardModuleRoot(object, ctx) {
    const node = unwrap(object);
    if (node?.type !== 'identifier') return false;
    return (ctx.entry?.importBindings || []).some(binding => (binding.alias || binding.name) === node.text);
}

/** A string literal as a path value; an f-string's replacement fields are runtime parts. */
function stringValue(node) {
    if (node?.type !== 'string') return null;
    const start = node.namedChildren.find(child => child.type === 'string_start')?.text || '';
    const prefix = start.replace(/["']+$/, '').toLowerCase();
    if (/[bu]/.test(prefix)) return prefix.includes('u') && !prefix.includes('b') ? plain() : null;
    if (!prefix.includes('f')) return plain();
    const parts = [];
    for (const child of node.namedChildren) {
        if (child.type === 'string_start' || child.type === 'string_end') continue;
        if (child.type === 'interpolation') { parts.push(WILD); continue; }
        if (child.type !== 'string_content') return null;
        if (child.text.includes('\\')) return null;
        parts.push(child.text.replace(/\{\{/g, '{').replace(/\}\}/g, '}'));
    }
    return concat({ parts });

    function plain() {
        const text = require('./runtime-entrypoints').pythonStringLiteral(node);
        return text == null ? null : exact(text);
    }
}

/** A plain string literal's value, or null. */
function literalString(node) {
    const value = node?.type === 'string' ? stringValue(node) : null;
    return isExact(value) ? value.parts[0] : null;
}

/** A name nothing in the file binds (a builtin or a module attribute such as `__file__`). */
function unbound(identifier, ctx) {
    const scope = referenceScopeNode(identifier, identifier.text, ctx.scopeMemo);
    if (scope?.type !== 'module' || escapes(ctx.tree, identifier.text) || namespaceWritten(ctx.tree)) return false;
    return !(pythonScopeBindingTable(scope).get(identifier.text) || []).length;
}

/** Is the name a parameter of the function it is read in? */
function isParameter(identifier, ctx) {
    const scope = referenceScopeNode(identifier, identifier.text, ctx.scopeMemo);
    if (scope?.type !== 'function_definition') return false;
    const sites = pythonScopeBindingTable(scope).get(identifier.text) || [];
    return sites.length > 0 && sites.every(site => {
        let holder = site.node.parent;
        if (['default_parameter', 'typed_default_parameter', 'typed_parameter'].includes(holder?.type)) holder = holder.parent;
        return holder?.type === 'parameters';
    });
}

// ---------------------------------------------------------------------------
// Placing a load on the project's files
// ---------------------------------------------------------------------------

/** The directory a relative path is read from: the file's runner's, else the root. */
function baseDir(index, filePath) {
    let dir = '';
    try {
        const memo = index._opMemo?.('loadedModulesTestModel', () => ({ model: null }));
        const holder = memo || { model: null };
        if (!holder.model) holder.model = require('./test-units').createTestModel(index);
        const runner = holder.model.runnerOf(filePath);
        if (runner?.id && runner.dir) dir = runner.dir;
    } catch {
        dir = '';
    }
    return dir ? path.join(index.root, dir) : index.root;
}

function place(loaded, ctx) {
    const { index, filePath } = ctx;
    const posixRoot = toPosix(index.root);
    const shown = text => {
        const posix = toPosix(text);
        return posix.startsWith(`${posixRoot}/`) ? posix.slice(posixRoot.length + 1) : posix;
    };
    if (loaded.kind === 'unread') return { kind: 'unread', via: loaded.via };
    if (loaded.kind === 'module') {
        const rel = ctx.entry?.moduleResolved?.[loaded.module];
        if (rel) return { kind: 'file', file: path.join(index.root, rel), via: `${loaded.via}("${loaded.module}")` };
        return { kind: 'module', module: loaded.module, via: `${loaded.via}("${loaded.module}")` };
    }
    const value = loaded.path;
    const bases = [...new Set([toPosix(baseDir(index, filePath)), toPosix(path.dirname(filePath))])];
    const absolute = typeof value.parts[0] === 'string' && value.parts[0].startsWith('/');
    if (isExact(value)) {
        const candidates = (absolute ? [value.parts[0]] : bases.map(base => `${base}/${value.parts[0]}`))
            .map(text => fromPosix(path.posix.normalize(text)));
        const via = `${loaded.via}: ${shown(path.posix.normalize(absolute ? value.parts[0] : `${bases[0]}/${value.parts[0]}`))}`;
        const first = candidates[0];
        const others = candidates.slice(1).filter(other => other !== first && index.files.has(other));
        if (others.length > 0) return { kind: 'ambiguous', files: [first, ...others].filter(f => index.files.has(f)).sort(), via };
        return index.files.has(first) ? { kind: 'file', file: first, via } : { kind: 'unresolved', via };
    }
    // A runtime part: the files the written parts allow, read from every
    // directory the relative path may be read from.
    const patterns = [];
    for (const base of absolute ? [''] : bases) {
        const parts = absolute ? value.parts : concat(exact(`${base}/`), value).parts;
        const pattern = pathPattern(parts);
        if (!pattern) return { kind: 'unread', via: loaded.via };
        patterns.push(pattern);
    }
    const files = [];
    for (const file of index.files.keys()) {
        const posix = toPosix(file);
        if (patterns.some(pattern => pattern.test(posix))) files.push(file);
    }
    files.sort();
    const text = value.parts.map(part => (part === WILD ? '*' : part)).join('');
    const via = `${loaded.via}: ${absolute ? shown(text) : text}`;
    return files.length > 0 ? { kind: 'files', files, via } : { kind: 'unresolved', via };
}

/**
 * A regular expression for the paths a written path with runtime parts can
 * be. The written prefix is normalized; a `.` or `..` segment after a
 * runtime part cannot be, and leaves the path unread.
 */
function pathPattern(parts, tail = null) {
    const first = parts.findIndex(part => part === WILD);
    const prefix = first > 0 ? parts.slice(0, first).join('') : '';
    let normalized = prefix ? path.posix.normalize(prefix) : '';
    if (prefix.endsWith('/') && !normalized.endsWith('/')) normalized += '/';
    const rest = parts.slice(first);
    const after = rest.filter(part => part !== WILD).join('/');
    if (after.split('/').some(segment => segment === '.' || segment === '..')) return null;
    const body = rest.map(part => (part === WILD ? '.*' : escapeRegExp(part))).join('');
    try {
        return new RegExp(`^${escapeRegExp(normalized)}${tail ? tail(body, rest) : body}$`);
    } catch {
        return null;
    }
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toPosix = text => String(text).split(path.sep).join('/');
const fromPosix = text => (path.sep === '/' ? text : text.split('/').join(path.sep));

// ---------------------------------------------------------------------------
// JavaScript and TypeScript (fix #513)
// ---------------------------------------------------------------------------
//
//     const SCRIPT = path.resolve(__dirname, '../scripts/delta.js');
//     const d = require(SCRIPT);            d.main()
//     const g = await import('../scripts/gamma.js');   g.main()
//     const m = require(`../scripts/${name}.js`);      m.main()
//
// `require(..)` and `await import(..)` load the module at a path: a relative
// specifier is read from the loading file's directory, a bare one names a
// package, an absolute one is that file; `path.resolve` of a relative path
// is read from the directory the program runs in (the test runner's, else
// the project root) and from the file's own directory, like the Python
// reader's relative paths. The answers and refusals are the Python reader's:
// one unconditional binding, the name never written, no member written.

// One table of a scope's binding sites per name, per syntax tree.
const JS_SCOPE_SITES = new WeakMap();
// Node's path module, by the specifiers that name it.
const JS_PATH_MODULES = new Set(['path', 'node:path', 'path/posix', 'node:path/posix']);
const JS_PATH_FUNCTIONS = new Set(['join', 'resolve', 'dirname', 'normalize']);
// Source extensions a load of an extensionless path or a runtime tail may
// reach, and the sources a compiled extension names (TypeScript ESM).
const JS_EXTENSIONS = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'];
const JS_EXTENSION_SOURCES = { js: ['js', 'ts', 'tsx'], jsx: ['jsx', 'tsx'], mjs: ['mjs', 'mts'], cjs: ['cjs', 'cts'] };
const JS_FUNCTION_NODES = new Set(['function_declaration', 'generator_function_declaration', 'function_expression',
    'function', 'generator_function', 'arrow_function', 'method_definition']);
const JS_WRAPPERS = new Set(['parenthesized_expression', 'as_expression', 'non_null_expression',
    'satisfies_expression', 'type_assertion']);

/** The module the receiver of a JavaScript or TypeScript call record holds (trait `loadedModule`). */
function javascriptLoadedModule(index, filePath, call) {
    let content;
    try { content = index._readFile(filePath); } catch { return null; }
    const entry = index.files.get(filePath);
    // A load is written in the file: a `require` the import graph recorded
    // as dynamic under the receiver's name, or an `import(..)` call. Asked
    // once per file.
    const named = index._opMemo?.('loadedModuleWordsJs') || null;
    let loads = named?.get(filePath);
    if (loads === undefined) {
        loads = {
            names: new Set((entry?.importBindings || []).filter(binding => binding.dynamic === true)
                .map(binding => binding.alias || binding.name)),
            importCall: /\bimport\s*\(/.test(content),
        };
        named?.set(filePath, loads);
    }
    if (!loads.importCall && !loads.names.has(call.receiver)) return null;
    return withTree(index, filePath, content, entry.language, tree => {
        const receiver = jsReceiverNode(tree, call);
        if (!receiver) return null;
        let sites = JS_SCOPE_SITES.get(tree);
        if (!sites) { sites = new Map(); JS_SCOPE_SITES.set(tree, sites); }
        const ctx = { index, filePath, entry, tree, sites };
        const value = jsBoundValue(receiver, ctx);
        if (!value) return null;
        const loaded = jsModuleOf(value, ctx, 0);
        return loaded ? jsPlace(loaded, ctx) : null;
    });
}

function jsUnwrap(node) {
    while (node && JS_WRAPPERS.has(node.type)) node = node.namedChild(0);
    return node;
}

/** The identifier `m` of `m.name(..)` at the record's call. */
function jsReceiverNode(tree, call) {
    const start = call.callStart;
    const end = call.callEnd;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    // The call whose span the record holds (a chain's calls share its start).
    let node = tree.rootNode.descendantForIndex(start);
    while (node && !(node.type === 'call_expression' && node.startIndex === start && node.endIndex === end)) {
        if (node.startIndex < start || node.endIndex > end) return null;
        node = node.parent;
    }
    const callee = jsUnwrap(node?.childForFieldName('function'));
    if (callee?.type !== 'member_expression' || callee.childForFieldName('property')?.text !== call.name) return null;
    const object = callee.childForFieldName('object');
    return object?.type === 'identifier' && object.text === call.receiver ? object : null;
}

/** The function or program whose own declarations a read of a name at `node` sees first. */
function jsEnclosingScope(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.type === 'program' || JS_FUNCTION_NODES.has(parent.type)) return parent;
    }
    return null;
}

/**
 * Every site in the scope's own code (nested functions and classes left
 * out, their names kept) that binds `name`: { kind, node } with kind
 * 'declarator' (the plain name of a variable declarator), 'param',
 * 'import' or 'other' (patterns, functions, classes, catch and loop
 * bindings).
 */
function jsScopeSites(scope, name, ctx) {
    const key = `${scope.startIndex}:${scope.endIndex}\0${name}`;
    if (ctx.sites.has(key)) return ctx.sites.get(key);
    const sites = [];
    const patternNames = (pattern, out) => {
        if (!pattern) return;
        if (pattern.type === 'identifier' || pattern.type === 'shorthand_property_identifier_pattern') { out.push(pattern); return; }
        if (pattern.type === 'assignment_pattern') return patternNames(pattern.childForFieldName('left'), out);
        if (pattern.type === 'pair_pattern') return patternNames(pattern.childForFieldName('value'), out);
        if (['required_parameter', 'optional_parameter'].includes(pattern.type)) return patternNames(pattern.childForFieldName('pattern'), out);
        for (const child of pattern.namedChildren) patternNames(child, out);
    };
    if (scope.type !== 'program') {
        const params = scope.childForFieldName('parameters') || scope.childForFieldName('parameter');
        const names = [];
        patternNames(params, names);
        for (const node of names) if (node.text === name) sites.push({ kind: 'param', node });
        const own = scope.childForFieldName('name');
        if (own?.text === name && scope.type !== 'function_declaration' && scope.type !== 'generator_function_declaration') {
            sites.push({ kind: 'other', node: own });
        }
    }
    const body = scope.type === 'program' ? scope : scope.childForFieldName('body');
    const stack = body ? [body] : [];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!sameNode(node, body) && (JS_FUNCTION_NODES.has(node.type) || node.type === 'class_declaration' ||
            node.type === 'class' || node.type === 'abstract_class_declaration')) {
            // A declaration's name binds here; an expression's or a
            // method's does not.
            const own = node.childForFieldName('name');
            if (own?.text === name && ['function_declaration', 'generator_function_declaration',
                'class_declaration', 'abstract_class_declaration'].includes(node.type)) sites.push({ kind: 'other', node: own });
            continue;
        }
        if (node.type === 'variable_declarator') {
            const target = node.childForFieldName('name');
            if (target?.type === 'identifier') {
                if (target.text === name) sites.push({ kind: 'declarator', node: target });
            } else {
                const names = [];
                patternNames(target, names);
                for (const found of names) if (found.text === name) sites.push({ kind: 'other', node: found });
            }
        } else if (node.type === 'import_statement') {
            for (const found of node.descendantsOfType(['identifier'])) {
                if (found.text === name && found.parent?.type !== 'string') sites.push({ kind: 'import', node: found });
            }
            continue;
        } else if (node.type === 'catch_clause') {
            const names = [];
            patternNames(node.childForFieldName('parameter'), names);
            for (const found of names) if (found.text === name) sites.push({ kind: 'other', node: found });
        } else if (node.type === 'for_in_statement') {
            const names = [];
            patternNames(node.childForFieldName('left'), names);
            for (const found of names) if (found.text === name) sites.push({ kind: 'other', node: found });
        }
        for (const child of node.namedChildren) stack.push(child);
    }
    ctx.sites.set(key, sites);
    return sites;
}

const JS_WRITTEN = new WeakMap();
/** The names any assignment, update or destructuring write in the file writes. */
function jsWrittenNames(tree) {
    let names = JS_WRITTEN.get(tree);
    if (names) return names;
    names = new Set();
    const collect = target => {
        const node = jsUnwrap(target);
        if (!node) return;
        if (node.type === 'identifier') { names.add(node.text); return; }
        if (['object_pattern', 'array_pattern', 'rest_pattern', 'pair_pattern', 'assignment_pattern',
            'shorthand_property_identifier_pattern'].includes(node.type)) {
            if (node.type === 'shorthand_property_identifier_pattern') { names.add(node.text); return; }
            if (node.type === 'pair_pattern') return collect(node.childForFieldName('value'));
            if (node.type === 'assignment_pattern') return collect(node.childForFieldName('left'));
            for (const child of node.namedChildren) collect(child);
        }
    };
    for (const node of tree.rootNode.descendantsOfType(['assignment_expression', 'augmented_assignment_expression', 'update_expression'])) {
        collect(node.childForFieldName(node.type === 'update_expression' ? 'argument' : 'left'));
    }
    for (const node of tree.rootNode.descendantsOfType('for_in_statement')) {
        if (!node.childForFieldName('kind')) collect(node.childForFieldName('left'));
    }
    JS_WRITTEN.set(tree, names);
    return names;
}

/**
 * Members of the name written in the scope (`m.main = ..`, `m[k] = ..`,
 * `delete m.main`, `Object.assign(m, ..)`, `Object.defineProperty(m, ..)`)?
 */
function jsMembersWritten(scope, name) {
    const rootOf = node => {
        let current = jsUnwrap(node);
        while (current && (current.type === 'member_expression' || current.type === 'subscript_expression')) {
            current = jsUnwrap(current.childForFieldName('object'));
        }
        return current;
    };
    const isName = node => node?.type === 'identifier' && node.text === name;
    for (const node of scope.descendantsOfType(['assignment_expression', 'augmented_assignment_expression',
        'update_expression', 'unary_expression', 'call_expression'])) {
        if (node.type === 'call_expression') {
            const callee = jsUnwrap(node.childForFieldName('function'));
            const first = node.childForFieldName('arguments')?.namedChildren?.[0];
            if (callee?.type === 'member_expression' && callee.childForFieldName('object')?.text === 'Object' &&
                ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'].includes(callee.childForFieldName('property')?.text) &&
                isName(jsUnwrap(first))) return true;
            continue;
        }
        if (node.type === 'unary_expression') {
            if (node.child(0)?.type === 'delete') {
                const target = jsUnwrap(node.childForFieldName('argument'));
                if (target && target.type !== 'identifier' && isName(rootOf(target))) return true;
            }
            continue;
        }
        const target = jsUnwrap(node.childForFieldName(node.type === 'update_expression' ? 'argument' : 'left'));
        if (target && (target.type === 'member_expression' || target.type === 'subscript_expression') && isName(rootOf(target))) return true;
    }
    return false;
}

/** Does a function stand between the node and the scope? */
function jsCrossesFunction(node, scope) {
    for (let parent = node.parent; parent && !sameNode(parent, scope); parent = parent.parent) {
        if (JS_FUNCTION_NODES.has(parent.type)) return true;
    }
    return false;
}

/**
 * The value a name holds where it is read: its one binding, a `const` /
 * `let` / `var` declarator of the plain name that is a statement of the
 * function or program the read resolves to, declared before the read (or
 * read from a function nested in that scope). Null when the name is bound
 * by anything else or more than once there, written anywhere in the file,
 * or its members are written.
 */
function jsBoundValue(identifier, ctx) {
    if (identifier?.type !== 'identifier') return null;
    const name = identifier.text;
    if (jsWrittenNames(ctx.tree).has(name)) return null;
    for (let scope = jsEnclosingScope(identifier); scope; scope = jsEnclosingScope(scope)) {
        const sites = jsScopeSites(scope, name, ctx);
        if (sites.length === 0) continue;
        if (sites.length !== 1 || sites[0].kind !== 'declarator') return null;
        const declarator = sites[0].node.parent;
        const value = declarator.childForFieldName('value');
        if (!value) return null;
        let statement = declarator.parent;
        if (!['lexical_declaration', 'variable_declaration'].includes(statement?.type)) return null;
        if (statement.parent?.type === 'export_statement') statement = statement.parent;
        const body = scope.type === 'program' ? scope : scope.childForFieldName('body');
        if (!sameNode(statement.parent, body)) return null;
        if (!jsCrossesFunction(identifier, scope) && declarator.endIndex > identifier.startIndex) return null;
        if (jsMembersWritten(scope, name)) return null;
        return value;
    }
    return null;
}

/** Is the name bound nowhere in the file (a global such as `require` or `__dirname`)? */
function jsUnbound(identifier, ctx) {
    const name = identifier.text;
    if (jsWrittenNames(ctx.tree).has(name)) return false;
    for (let scope = jsEnclosingScope(identifier); scope; scope = jsEnclosingScope(scope)) {
        if (jsScopeSites(scope, name, ctx).length > 0) return false;
    }
    return true;
}

/** The import record that binds a name the program binds only by that import. */
function jsImportBinding(identifier, ctx) {
    const program = ctx.tree.rootNode;
    if (jsWrittenNames(ctx.tree).has(identifier.text)) return null;
    for (let scope = jsEnclosingScope(identifier); scope && !sameNode(scope, program); scope = jsEnclosingScope(scope)) {
        if (jsScopeSites(scope, identifier.text, ctx).length > 0) return null;
    }
    const sites = jsScopeSites(program, identifier.text, ctx);
    if (sites.length !== 1 || sites[0].kind !== 'import') return null;
    const bindings = (ctx.entry?.importBindings || []).filter(binding => (binding.alias || binding.name) === identifier.text);
    return bindings.length === 1 ? bindings[0] : null;
}

/**
 * The path-module function a callee names: `path.join` with `path` bound to
 * Node's path module (`require('path')`, `import path from 'path'`, `import
 * * as path from 'node:path'`), or `join` imported by name from it
 * (`import { join } from 'path'`; a destructured `require` is not read).
 */
function jsPathFunction(callee, ctx) {
    const node = jsUnwrap(callee);
    if (node?.type === 'member_expression') {
        const method = node.childForFieldName('property')?.text;
        const object = jsUnwrap(node.childForFieldName('object'));
        if (!JS_PATH_FUNCTIONS.has(method) || object?.type !== 'identifier') return null;
        const binding = jsImportBinding(object, ctx);
        if (binding) {
            return JS_PATH_MODULES.has(binding.module) && ['default', 'namespace'].includes(binding.kind) ? method : null;
        }
        const value = jsUnwrap(jsBoundValue(object, ctx));
        return value && jsRequiredSpecifier(value, ctx) && JS_PATH_MODULES.has(jsRequiredSpecifier(value, ctx)) ? method : null;
    }
    if (node?.type === 'identifier') {
        const binding = jsImportBinding(node, ctx);
        if (binding && JS_PATH_MODULES.has(binding.module) && binding.kind === 'named' &&
            JS_PATH_FUNCTIONS.has(binding.name)) return binding.name;
    }
    return null;
}

/** The literal specifier of `require('x')` with the global `require`, or null. */
function jsRequiredSpecifier(node, ctx) {
    if (node?.type !== 'call_expression') return null;
    const callee = jsUnwrap(node.childForFieldName('function'));
    if (callee?.type !== 'identifier' || callee.text !== 'require' || !jsUnbound(callee, ctx)) return null;
    const args = node.childForFieldName('arguments')?.namedChildren || [];
    if (args.length !== 1) return null;
    const value = jsPathOf(args[0], ctx, 0);
    return isExact(value) ? value.parts[0] : null;
}

/**
 * The module an expression evaluates to: `require(p)` with the global
 * `require`, `await import(p)`, or a name bound to one. Answers
 * { kind: 'path', path, base } or { kind: 'module', module } or
 * { kind: 'unread' }, each with `via`; null when no load is shown.
 */
function jsModuleOf(expression, ctx, depth) {
    const node = jsUnwrap(expression);
    if (!node || depth > MAX_DEPTH) return null;
    if (node.type === 'identifier') {
        const value = jsBoundValue(node, ctx);
        return value ? jsModuleOf(value, ctx, depth + 1) : null;
    }
    let call = node;
    let via = 'require()';
    if (node.type === 'await_expression') {
        call = jsUnwrap(node.namedChild(0));
        if (call?.type !== 'call_expression' || call.childForFieldName('function')?.type !== 'import') return null;
        via = 'import()';
    } else {
        if (node.type !== 'call_expression') return null;
        const callee = jsUnwrap(node.childForFieldName('function'));
        if (callee?.type !== 'identifier' || callee.text !== 'require' || !jsUnbound(callee, ctx)) return null;
    }
    const args = call.childForFieldName('arguments')?.namedChildren || [];
    // `import(p, options)` takes import attributes; a spread is not read.
    if (args.length === 0 || args.some(arg => arg.type === 'spread_element') ||
        (via === 'require()' && args.length !== 1)) return { kind: 'unread', via };
    const value = jsPathOf(args[0], ctx, 0);
    if (!value || value.unknown || value.parts.every(part => part === WILD)) return { kind: 'unread', via };
    const first = value.parts[0];
    if (typeof first !== 'string') return { kind: 'unread', via };
    if (value.base === 'cwd') return { kind: 'path', path: value, base: 'cwd', via };
    if (first.startsWith('/')) return { kind: 'path', path: value, base: 'absolute', via };
    if (/^\.\.?(\/|$)/.test(first)) return { kind: 'path', path: value, base: 'file', via };
    // A bare specifier names a package; with a runtime part it is not read.
    return isExact(value) ? { kind: 'module', module: first, via } : { kind: 'unread', via };
}

/**
 * The path an expression is: { parts, base? } with runtime parts WILD and
 * `base: 'cwd'` for a relative `path.resolve(..)`; UNKNOWN for a parameter;
 * null when not read.
 */
function jsPathOf(expression, ctx, depth) {
    const node = jsUnwrap(expression);
    if (!node || depth > MAX_DEPTH) return null;
    switch (node.type) {
        case 'string': {
            if (node.namedChildren.some(child => child.type === 'escape_sequence')) return null;
            return exact(node.namedChildren.map(child => child.text).join(''));
        }
        case 'template_string': {
            const parts = [];
            for (const child of node.namedChildren) {
                if (child.type === 'string_fragment') { parts.push(child.text); continue; }
                if (child.type !== 'template_substitution') return null;
                const inner = jsPathOf(child.namedChild(0), ctx, depth + 1);
                if (inner && !inner.unknown && inner.base !== 'cwd') parts.push(...inner.parts);
                else parts.push(WILD);
            }
            return concat({ parts });
        }
        case 'identifier': {
            if ((node.text === '__dirname' || node.text === '__filename') && jsUnbound(node, ctx)) {
                return exact(node.text === '__dirname' ? toPosix(path.dirname(ctx.filePath)) : toPosix(ctx.filePath));
            }
            const value = jsBoundValue(node, ctx);
            if (value) return jsPathOf(value, ctx, depth + 1);
            return jsIsParameter(node, ctx) ? UNKNOWN : null;
        }
        case 'binary_expression': {
            if (node.childForFieldName('operator')?.text !== '+') return null;
            const left = jsPathOf(node.childForFieldName('left'), ctx, depth + 1);
            const right = jsPathOf(node.childForFieldName('right'), ctx, depth + 1);
            if (!left || !right || left.base === 'cwd' || right.base === 'cwd') return null;
            return concat(left, right);
        }
        case 'call_expression': {
            const fn = jsPathFunction(node.childForFieldName('function'), ctx);
            if (!fn) return null;
            const args = node.childForFieldName('arguments')?.namedChildren || [];
            if (args.some(arg => arg.type === 'spread_element')) return null;
            const values = args.map(arg => jsPathOf(arg, ctx, depth + 1));
            if (values.some(value => !value || value.unknown || value.base === 'cwd')) return null;
            if (fn === 'join') return values.length === 0 ? null : jsJoin(values);
            if (fn === 'resolve') return jsResolve(values);
            if (values.length !== 1) return null;
            if (fn === 'dirname') return dirname(values[0]);
            return isExact(values[0]) ? exact(path.posix.normalize(values[0].parts[0])) : values[0];
        }
        default: return null;
    }
}

/** Node's `path.join`: every part joined with `/`, an absolute part never restarting it. */
function jsJoin(values) {
    let joined = null;
    for (const value of values) {
        if (!joined) { joined = value; continue; }
        const last = joined.parts[joined.parts.length - 1];
        joined = last === WILD || String(last).endsWith('/') ? concat(joined, value) : concat(joined, exact('/'), value);
    }
    return joined && isExact(joined) ? exact(path.posix.normalize(joined.parts[0])) : joined;
}

/** Node's `path.resolve`: the last absolute part and what follows it; with none, a path read from the working directory. */
function jsResolve(values) {
    let from = -1;
    values.forEach((value, at) => {
        if (typeof value.parts[0] === 'string' && value.parts[0].startsWith('/')) from = at;
    });
    // A runtime part at the start of a later argument may be absolute.
    if (values.slice(from + 1).some(value => value.parts[0] === WILD)) return null;
    const joined = values.length === 0 ? exact('.') : jsJoin(from >= 0 ? values.slice(from) : values);
    return from >= 0 ? joined : { ...joined, base: 'cwd' };
}

/** Is the name a parameter of the function it is read in? */
function jsIsParameter(identifier, ctx) {
    const scope = jsEnclosingScope(identifier);
    if (!scope || scope.type === 'program') return false;
    const sites = jsScopeSites(scope, identifier.text, ctx);
    return sites.length > 0 && sites.every(site => site.kind === 'param');
}

/** The files a JavaScript load names (see `place`). */
function jsPlace(loaded, ctx) {
    const { index, filePath, entry } = ctx;
    const posixRoot = toPosix(index.root);
    const shown = text => (text.startsWith(`${posixRoot}/`) ? text.slice(posixRoot.length + 1) : text);
    const { resolveImport } = require('./imports');
    const resolve = specifier => {
        try {
            const resolved = resolveImport(specifier, filePath, {
                aliases: index.config?.aliases, language: entry.language, root: index.root,
            });
            return resolved && index.files.has(resolved) ? resolved : null;
        } catch {
            return null;
        }
    };
    if (loaded.kind === 'unread') return { kind: 'unread', via: loaded.via };
    if (loaded.kind === 'module') {
        const via = `${loaded.via}: "${loaded.module}"`;
        const file = entry.moduleResolved?.[loaded.module]
            ? path.join(index.root, entry.moduleResolved[loaded.module]) : resolve(loaded.module);
        return file ? { kind: 'file', file, via } : { kind: 'module', module: loaded.module, via };
    }
    const value = loaded.path;
    const fileDir = toPosix(path.dirname(filePath));
    const bases = loaded.base === 'absolute' ? ['']
        : loaded.base === 'file' ? [fileDir]
        : [...new Set([toPosix(baseDir(index, filePath)), fileDir])];
    const at = base => (base ? `${base}/` : '');
    if (isExact(value)) {
        const candidates = bases.map(base => path.posix.normalize(`${at(base)}${value.parts[0]}`));
        const via = `${loaded.via}: ${shown(candidates[0])}`;
        const files = [...new Set(candidates.map(candidate => resolve(fromPosix(candidate))).filter(Boolean))];
        if (files.length > 1) return { kind: 'ambiguous', files: files.sort(), via };
        if (files.length === 1 && resolve(fromPosix(candidates[0]))) return { kind: 'file', file: files[0], via };
        if (files.length === 1) return { kind: 'ambiguous', files, via };
        return { kind: 'unresolved', via };
    }
    const patterns = [];
    for (const base of bases) {
        const pattern = pathPattern(concat(exact(at(base)), value).parts, jsPatternTail);
        if (!pattern) return { kind: 'unread', via: loaded.via };
        patterns.push(pattern);
    }
    const files = [];
    for (const file of index.files.keys()) {
        const posix = toPosix(file);
        if (patterns.some(pattern => pattern.test(posix))) files.push(file);
    }
    files.sort();
    const text = value.parts.map(part => (part === WILD ? '*' : part)).join('');
    const via = `${loaded.via}: ${shown(text)}`;
    return files.length > 0 ? { kind: 'files', files, via } : { kind: 'unresolved', via };
}

/**
 * What a load's path can end with: a runtime tail or an extensionless path
 * reaches a source file or a directory's index; a written `.js` names its
 * TypeScript source too.
 */
function jsPatternTail(body, rest) {
    const extensions = `\\.(?:${JS_EXTENSIONS.join('|')})`;
    const last = rest[rest.length - 1];
    if (last === WILD) return `${body}${extensions}`;
    const written = /\.([A-Za-z]+)$/.exec(last)?.[1];
    if (written && JS_EXTENSIONS.includes(written)) {
        const sources = JS_EXTENSION_SOURCES[written] || [written];
        return `${body.slice(0, body.length - escapeRegExp(`.${written}`).length)}\\.(?:${sources.join('|')})`;
    }
    return `${body}(?:${extensions}|/index${extensions})`;
}

module.exports = { loadedModuleOfReceiver, pythonLoadedModule, javascriptLoadedModule };
