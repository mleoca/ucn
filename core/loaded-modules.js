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
    if (!call || !call.isMethod || !call.receiver || call.receiverField || call.receiverIsModule ||
        call.receiverModuleSpecifier) return null;
    const entry = index.files.get(filePath);
    const reader = entry && langTraits(entry.language)?.loadedModule;
    if (!reader) return null;
    const memo = index._opMemo?.('loadedModuleOfReceiver') || null;
    const key = `${filePath}\0${call.callSite?.start ?? ''}\0${call.line}\0${call.receiver}`;
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
function pathPattern(parts) {
    const first = parts.findIndex(part => part === WILD);
    const prefix = first > 0 ? parts.slice(0, first).join('') : '';
    let normalized = prefix ? path.posix.normalize(prefix) : '';
    if (prefix.endsWith('/') && !normalized.endsWith('/')) normalized += '/';
    const rest = parts.slice(first);
    const after = rest.filter(part => part !== WILD).join('/');
    if (after.split('/').some(segment => segment === '.' || segment === '..')) return null;
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = rest.map(part => (part === WILD ? '.*' : escape(part))).join('');
    try {
        return new RegExp(`^${escape(normalized)}${body}$`);
    } catch {
        return null;
    }
}

const toPosix = text => String(text).split(path.sep).join('/');
const fromPosix = text => (path.sep === '/' ? text : text.split('/').join(path.sep));

module.exports = { loadedModuleOfReceiver, pythonLoadedModule };
