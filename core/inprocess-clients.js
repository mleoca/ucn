/**
 * core/inprocess-clients.js - The app an in-process test client serves
 * (fix #392).
 *
 * A test client built from an app object (`TestClient(app)`,
 * `test_client_factory(app)`, `AsyncClient(transport=ASGITransport(app=app))`,
 * `app.test_client()`) sends its requests to that app in process: only the
 * routes registered on it, or mounted under it, can serve them. A request
 * whose receiver is such a client carries the app's route-container key
 * (the key scheme of core/route-lists.js: `file:name` for a module-level
 * binding, `file@scope:name` for a function-local one, the defining module's
 * key for an imported one).
 *
 * The client is found where the receiver is bound: an assignment or
 * `with ... as name` in the enclosing function, a module-level assignment,
 * or a pytest fixture parameter (the fixture's yielded/returned value, found
 * in the test's module or a conftest.py up the directory chain). The app is
 * the constructor's `app=` argument (also inside a `transport=` argument),
 * else its first positional argument, or the receiver of `.test_client()`.
 * An app that is itself a fixture parameter resolves through that fixture's
 * returned name. Anything else is unresolved (null).
 */

'use strict';

const path = require('path');
const routeGraph = require('./route-graph');
const { pythonContainerKey } = require('./route-lists');

const { field, namedChildren, unwrap } = routeGraph;
const { sameNode } = require('../languages/utils');

const MAX_HOPS = 3;

function enclosingFunctionNode(node) {
    for (let n = node?.parent; n; n = n.parent) {
        if (n.type === 'function_definition') return n;
    }
    return null;
}

/** Call nodes on a 1-based line: `receiver.name(...)`. */
function requestCallNodes(root, line, receiver, name) {
    const row = line - 1;
    const out = [];
    for (const call of root.descendantsOfType('call', { row, column: 0 }, { row, column: 1 << 20 })) {
        const fn = field(call, 'function');
        if (fn?.type !== 'attribute') continue;
        const attr = field(fn, 'attribute');
        const obj = unwrap(field(fn, 'object'));
        if (attr?.text === name && attr.startPosition.row === row && obj?.type === 'identifier' &&
            obj.text === receiver) out.push({ call, receiverNode: obj });
    }
    return out;
}

const BINDING_TYPES = ['assignment', 'augmented_assignment', 'for_statement', 'with_item',
    'function_definition', 'class_definition'];
const SCOPE_TYPES = new Set(['function_definition', 'class_definition', 'lambda']);

/**
 * Values bound to `name` directly in a function body or module (nested
 * function/class bodies excluded): `name = V` and `with V as name`, each
 * with `top`, the container's statement holding it. null when the name is
 * bound any other way (loop target, augmented assignment, tuple unpacking, a
 * def or class of the name).
 */
function boundValues(container, name, memoByTree = null) {
    let memo = null;
    if (memoByTree && container.tree) {
        memo = memoByTree.get(container.tree);
        if (!memo) { memo = new Map(); memoByTree.set(container.tree, memo); }
    }
    const key = memo ? `${container.startIndex}:${container.endIndex}:${name}` : null;
    if (key && memo.has(key)) return memo.get(key);
    const values = [];
    let other = false;
    for (const node of container.descendantsOfType(BINDING_TYPES)) {
        if (!node.text.includes(name)) continue;
        // The statement of the container holding it, unless a nested
        // function or class scope lies in between.
        let top = null;
        let nested = false;
        for (let n = node; n; n = n.parent) {
            if (!sameNode(n, node) && SCOPE_TYPES.has(n.type)) { nested = true; break; }
            if (n.parent && sameNode(n.parent, container)) { top = n; break; }
        }
        if (nested || !top) continue;
        switch (node.type) {
            case 'function_definition': case 'class_definition':
                if (field(node, 'name')?.text === name) other = true;
                break;
            case 'assignment': {
                const left = field(node, 'left');
                if (left?.type === 'identifier' && left.text === name) {
                    const right = field(node, 'right');
                    if (right) values.push({ node: right, top });
                    else other = true;
                } else if (left && left.type !== 'identifier' && left.type !== 'attribute' &&
                    left.type !== 'subscript' && left.descendantsOfType('identifier').some(n => n.text === name)) {
                    other = true;
                }
                break;
            }
            case 'augmented_assignment':
                if (field(node, 'left')?.text === name) other = true;
                break;
            case 'for_statement': {
                const left = field(node, 'left');
                if (left && (left.text === name || left.descendantsOfType('identifier').some(n => n.text === name))) {
                    other = true;
                }
                break;
            }
            case 'with_item': {
                const value = field(node, 'value');
                if (value?.type === 'as_pattern') {
                    const alias = field(value, 'alias');
                    const target = alias && alias.namedChild(0);
                    if (target?.type === 'identifier' && target.text === name) {
                        const expr = value.namedChild(0);
                        if (expr) values.push({ node: expr, top });
                    } else if (alias && alias.descendantsOfType('identifier').some(n => n.text === name)) {
                        other = true;
                    }
                }
                break;
            }
            default:
                break;
        }
    }
    const result = other ? null : values;
    if (key) memo.set(key, result);
    return result;
}

function isParameterOf(fnNode, name) {
    for (const param of namedChildren(field(fnNode, 'parameters'))) {
        const nameNode = param.type === 'identifier' ? param
            : field(param, 'name') || (param.type === 'typed_parameter' ? param.namedChild(0) : null);
        if (nameNode?.type === 'identifier' && nameNode.text === name) return true;
    }
    return false;
}

/** The app a wrapping constructor wraps: `app=` or its first positional. */
function wrappedApp(callNode) {
    const args = namedChildren(field(callNode, 'arguments'));
    for (const arg of args) {
        if (arg.type === 'keyword_argument' && field(arg, 'name')?.text === 'app') return field(arg, 'value');
    }
    const first = args.find(arg => arg.type !== 'keyword_argument' && arg.type !== 'list_splat' &&
        arg.type !== 'dictionary_splat');
    const value = unwrap(first);
    return value && (value.type === 'identifier' || value.type === 'call') ? value : null;
}

// An app served by its own callable (a function or class), never by routes.
const NO_ROUTES = '\0no-routes';

class PythonClientResolver {
    /** `served()`: the container keys some route is served from. */
    constructor(index, sess, served) {
        this.index = index;
        this.sess = sess;
        this.served = served;
        this.fixtureMemo = new Map();
        this.bindingMemo = new WeakMap();
        this.clientMemo = new Map();
    }

    /** Is `decorated` a pytest fixture (`@pytest.fixture`, `@fixture(...)`)? */
    isFixture(file, fnNode) {
        const decorated = fnNode.parent?.type === 'decorated_definition' ? fnNode.parent : null;
        if (!decorated) return false;
        const entry = this.index.files.get(file);
        const bindings = entry?.importBindings || [];
        for (const deco of namedChildren(decorated)) {
            if (deco.type !== 'decorator') continue;
            let expr = deco.namedChild(0);
            if (expr?.type === 'call') expr = field(expr, 'function');
            if (!expr) continue;
            if (expr.type === 'attribute' && field(expr, 'attribute')?.text === 'fixture') {
                const head = field(expr, 'object');
                if (head?.type === 'identifier' && bindings.some(b =>
                    (b.alias || b.name) === head.text && b.kind === 'import' && b.module === 'pytest')) return true;
            }
            if (expr.type === 'identifier' && bindings.some(b =>
                (b.alias || b.name) === expr.text && b.kind === 'from' && b.module === 'pytest' &&
                b.name === 'fixture')) return true;
        }
        return false;
    }

    /** The fixture named `name` a test in `file` requests: same module first,
     *  then conftest.py files from the test's directory up to the root. */
    fixtureDef(file, name) {
        const key = `${file}\0${name}`;
        if (this.fixtureMemo.has(key)) return this.fixtureMemo.get(key);
        let found = this.moduleFixture(file, name);
        if (!found) {
            for (let dir = path.dirname(file); dir.startsWith(this.index.root); dir = path.dirname(dir)) {
                const conftest = path.join(dir, 'conftest.py');
                if (this.index.files.has(conftest)) {
                    found = this.moduleFixture(conftest, name);
                    if (found) break;
                }
                if (dir === this.index.root || path.dirname(dir) === dir) break;
            }
        }
        this.fixtureMemo.set(key, found);
        return found;
    }

    moduleFixture(file, name) {
        const root = this.sess.root(file);
        if (!root) return null;
        const hits = [];
        for (const stmt of namedChildren(root)) {
            const fn = stmt.type === 'decorated_definition' ? field(stmt, 'definition') : stmt;
            if (fn?.type === 'function_definition' && field(fn, 'name')?.text === name &&
                this.isFixture(file, fn)) hits.push(fn);
        }
        return hits.length === 1 ? { file, fnNode: hits[0] } : null;
    }

    /** The expression a fixture provides: its single yielded/returned value,
     *  followed through a local binding. */
    fixtureValue(file, fnNode, hops) {
        const body = field(fnNode, 'body');
        if (!body) return null;
        const provided = [];
        const visit = (node) => {
            for (const child of namedChildren(node)) {
                if (child.type === 'function_definition' || child.type === 'class_definition' ||
                    child.type === 'decorated_definition' || child.type === 'lambda') continue;
                if (child.type === 'return_statement' || child.type === 'yield') {
                    const value = child.namedChild(0);
                    if (value) provided.push(value);
                    continue;
                }
                visit(child);
            }
        };
        visit(body);
        if (provided.length !== 1) return null;
        return this.followBinding(file, fnNode, unwrap(provided[0]), hops);
    }

    /** A name follows to its single bound value in the function or module. */
    followBinding(file, fnNode, expr, hops) {
        if (!expr || expr.type !== 'identifier' || hops > MAX_HOPS) return { file, expr };
        if (fnNode) {
            const values = boundValues(field(fnNode, 'body'), expr.text, this.bindingMemo);
            if (values === null) return null;
            if (values.length === 1) return this.followBinding(file, fnNode, unwrap(values[0].node), hops + 1);
            if (values.length > 1) return null;
            if (isParameterOf(fnNode, expr.text)) {
                const fixture = this.fixtureDef(file, expr.text);
                return fixture ? this.fixtureValue(fixture.file, fixture.fnNode, hops + 1) : null;
            }
        }
        return { file, expr };
    }

    /** clientApp, once per client expression (requests share clients). */
    clientAppOnce(file, expr) {
        const key = `${file}\0${expr.startIndex}:${expr.endIndex}`;
        if (this.clientMemo.has(key)) return this.clientMemo.get(key);
        const value = this.clientApp(file, expr, 1);
        this.clientMemo.set(key, value);
        return value;
    }

    /** The app a client-constructing expression is built from. */
    clientApp(file, clientExpr, hops) {
        const expr = unwrap(clientExpr);
        if (!expr || expr.type !== 'call') return null;
        const fn = field(expr, 'function');
        // Flask/werkzeug: `app.test_client()`.
        if (fn?.type === 'attribute' && field(fn, 'attribute')?.text === 'test_client') {
            return this.appKey(file, field(fn, 'object'), hops);
        }
        const args = field(expr, 'arguments');
        const keyword = (call, name) => {
            for (const arg of namedChildren(field(call, 'arguments'))) {
                if (arg.type === 'keyword_argument' && field(arg, 'name')?.text === name) return field(arg, 'value');
            }
            return null;
        };
        let app = keyword(expr, 'app');
        const transport = !app ? unwrap(keyword(expr, 'transport')) : null;
        if (transport?.type === 'call') {
            app = keyword(transport, 'app') ||
                namedChildren(field(transport, 'arguments')).find(a => a.type !== 'keyword_argument');
        }
        if (!app && !transport) app = namedChildren(args).find(a => a.type !== 'keyword_argument' &&
            a.type !== 'list_splat' && a.type !== 'dictionary_splat');
        return app ? this.appKey(file, app, hops) : null;
    }

    /**
     * Container key of an app expression: a name (fixtures followed) or an
     * inline constructor call. An app that holds no routes of its own but
     * wraps another (`Middleware(inner)`, `app=inner`) is served by the inner
     * one; an app declared as a function or class serves every request
     * itself (NO_ROUTES). null: unresolved.
     */
    appKey(file, appExpr, hops) {
        const expr = unwrap(appExpr);
        if (!expr || hops > MAX_HOPS) return null;
        if (expr.type === 'call') {
            const inline = `${file}#${expr.startIndex}`;
            if (this.served().has(inline)) return inline;
            const inner = wrappedApp(expr);
            return inner ? this.appKey(file, inner, hops + 1) : null;
        }
        if (expr.type !== 'identifier') return null;
        const fnNode = enclosingFunctionNode(expr);
        if (fnNode && isParameterOf(fnNode, expr.text)) {
            const fixture = this.fixtureDef(file, expr.text);
            if (!fixture) return null;
            const value = this.fixtureValue(fixture.file, fixture.fnNode, hops + 1);
            if (!value?.expr) return null;
            return this.appKey(value.file, value.expr, hops + 1);
        }
        const key = pythonContainerKey(this.index, this.sess, file, expr);
        if (key && this.served().has(key)) return key;
        const decl = routeGraph.findDecl(this.sess, file, expr.text, expr);
        if (decl && (decl.kind === 'function' || decl.kind === 'class')) return NO_ROUTES;
        if (decl?.kind === 'var') {
            // The binding in effect at the reference (sequential rebinding
            // in one body picks the last one before it).
            const container = decl.scope.type === 'function_definition' ? field(decl.scope, 'body') : decl.scope;
            const values = container ? boundValues(container, expr.text, this.bindingMemo) : null;
            if (!values || values.length === 0) return null;
            const results = this.bindingInEffect(values, expr).map(node => {
                const value = unwrap(node);
                const inner = value?.type === 'call' ? wrappedApp(value) : null;
                return inner ? this.appKey(file, inner, hops + 1) : null;
            });
            return results.every(r => r && r === results[0]) ? results[0] : null;
        }
        return null;
    }

    /**
     * { appKey } for a request `receiver.verb(path)` at `line` of `file` made
     * through an in-process client, { inProcess: true } when the client is
     * built from an app that did not resolve, else null (not a client built
     * from an app).
     */
    resolve(file, line, receiver, name) {
        const root = this.sess.root(file);
        if (!root) return null;
        const sites = requestCallNodes(root, line, receiver, name);
        if (sites.length !== 1) return null;
        const { receiverNode } = sites[0];
        const fnNode = enclosingFunctionNode(receiverNode);
        let clients = null;
        if (fnNode) {
            const values = boundValues(field(fnNode, 'body'), receiver, this.bindingMemo);
            if (values === null) return null;
            if (values.length > 0) {
                clients = this.bindingInEffect(values, receiverNode).map(node => ({ file, expr: unwrap(node) }));
            } else if (isParameterOf(fnNode, receiver)) {
                const fixture = this.fixtureDef(file, receiver);
                const value = fixture ? this.fixtureValue(fixture.file, fixture.fnNode, 1) : null;
                clients = value ? [value] : [];
            }
        }
        if (!clients) {
            const values = boundValues(root, receiver, this.bindingMemo);
            if (values && values.length > 0) {
                clients = this.bindingInEffect(values, receiverNode).map(node => ({ file, expr: unwrap(node) }));
            }
        }
        if (!clients || clients.length === 0 || clients.some(c => c.expr?.type !== 'call')) return null;
        const keys = clients.map(c => this.clientAppOnce(c.file, c.expr));
        if (keys.every(key => key && key === keys[0])) {
            return keys[0] === NO_ROUTES ? { noRoutes: true } : { appKey: keys[0] };
        }
        return clients.some(c => this.looksBuiltFromApp(c.expr)) ? { inProcess: true } : null;
    }

    /**
     * The bindings that can be in effect at the request: all of them, unless
     * every binding runs in sequence in the same body (then the last one
     * before the request).
     */
    bindingInEffect(values, refNode) {
        if (values.length === 1 || values.some(v => !v.top)) return values.map(v => v.node);
        const before = values.filter(v => v.node.endIndex <= refNode.startIndex &&
            v.top.endIndex <= refNode.startIndex);
        const containing = values.find(v => v.top.startIndex <= refNode.startIndex &&
            v.top.endIndex >= refNode.endIndex);
        if (containing) return [containing.node]; // `with X as c:` around the request
        return before.length > 0 ? [before[before.length - 1].node] : values.map(v => v.node);
    }

    /** A client call built from an app-shaped argument that did not
     *  resolve: `.test_client()`, `app=`/`transport=`, or a first positional
     *  argument that is a name, attribute or call (never a literal URL). */
    looksBuiltFromApp(callExpr) {
        const fn = field(callExpr, 'function');
        if (fn?.type === 'attribute' && field(fn, 'attribute')?.text === 'test_client') return true;
        const args = namedChildren(field(callExpr, 'arguments'));
        if (args.some(arg => arg.type === 'keyword_argument' &&
            ['app', 'transport'].includes(field(arg, 'name')?.text))) return true;
        const first = args.find(arg => arg.type !== 'keyword_argument');
        return !!first && ['identifier', 'attribute', 'call'].includes(unwrap(first)?.type);
    }
}

/**
 * The app a JS in-process client (supertest `request(app)`,
 * `request.agent(app)`) is built from (fix #397): the router value key of the
 * client call's first argument (the route graph's key scheme: the binding the
 * app is declared by, followed through imports), through `app.callback()`,
 * `app.listen(..)` and `http.createServer(app)` wrappers.
 */
class JsClientResolver {
    constructor(index, sess, graph) {
        this.index = index;
        this.sess = sess;
        this.graph = graph;
        this.keyMemo = new Map();
        this.routeKeys = new Map();
    }

    /** { jsAppKey } for the client built at [start, end) of `file`, { inProcess: true } when unresolved. */
    resolve(file, start, end) {
        if (!this.graph) return { inProcess: true };
        const root = this.sess.root(file);
        const call = root ? routeGraph.locateSpan(root, start, end, 'call_expression') : null;
        let app = call ? namedChildren(field(call, 'arguments')).filter(n => !n.type.endsWith('comment'))[0] : null;
        for (let hops = 0; app && hops < MAX_HOPS; hops++) {
            const value = unwrap(app);
            if (value?.type !== 'call_expression') { app = value; break; }
            const fn = unwrap(field(value, 'function'));
            const method = fn?.type === 'member_expression' ? field(fn, 'property')?.text : null;
            const args = namedChildren(field(value, 'arguments')).filter(n => !n.type.endsWith('comment'));
            if (method === 'callback' || method === 'listen') app = field(fn, 'object');
            else if ((method === 'createServer' || fn?.text === 'createServer') && args.length >= 1) {
                app = args[args.length - 1];
            } else { app = value; break; }
        }
        const key = app ? this.graph.jsRouterKey(file, app, 0) : null;
        return key ? { jsAppKey: key } : { inProcess: true };
    }

    /** Whether the route graph proved the key a router value. */
    isRouterValue(key) {
        return !!this.graph?.evidence?.has(key);
    }

    /** The router key a JS route registers on, from the graph or its call's receiver; null when unknown. */
    routeKey(route) {
        const site = route.jsRouterSite;
        if (!site || !this.graph) return null;
        if (site.key) return site.key;
        if (this.routeKeys.has(route)) return this.routeKeys.get(route);
        let key = null;
        const root = this.sess.root(route.absoluteFile);
        const call = root ? routeGraph.locateSpan(root, site.start, site.end, 'call_expression') : null;
        const fn = call ? unwrap(field(call, 'function')) : null;
        const obj = fn?.type === 'member_expression' ? field(fn, 'object') : null;
        if (obj) key = this.graph.jsRouterKey(route.absoluteFile, obj, 0);
        this.routeKeys.set(route, key);
        return key;
    }

    /**
     * true when the route's router is the app or is mounted under it, false
     * when it provably is not, null when the route cannot be keyed. Mount
     * edges come from the route graph; the files declaring the app and the
     * route are walked on demand when the keys differ.
     */
    routeServedBy(route, appKey) {
        const key = this.routeKey(route);
        if (!key) return null;
        if (key === appKey) return true;
        for (const file of [keyFile(appKey), keyFile(key), route.absoluteFile]) {
            if (file && !this.graph.walked.has(file)) {
                this.graph.enqueue(file);
                this.keyMemo.clear();
            }
        }
        if (this.graph.queue.length > 0) this.graph.run();
        return this.servingKeys(key).has(appKey);
    }

    /** The router key and every router that mounts it (transitively). */
    servingKeys(key) {
        let keys = this.keyMemo.get(key);
        if (keys) return keys;
        keys = new Set([key]);
        const queue = [key];
        while (queue.length > 0 && keys.size < 256) {
            const current = queue.shift();
            for (const edge of this.graph.edges.get(current) || []) {
                if (edge.mounterKey && !keys.has(edge.mounterKey)) {
                    keys.add(edge.mounterKey);
                    queue.push(edge.mounterKey);
                }
            }
        }
        this.keyMemo.set(key, keys);
        return keys;
    }
}

// The file a route-graph key names (`file#offset`).
function keyFile(key) {
    const at = typeof key === 'string' ? key.lastIndexOf('#') : -1;
    return at > 0 ? key.slice(0, at) : null;
}

module.exports = { PythonClientResolver, JsClientResolver };
