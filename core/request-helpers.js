/**
 * core/request-helpers.js - structural proof that a call performs an HTTP
 * request (fix #366).
 *
 * Generated API clients and hand-written wrappers pass the request as
 * configuration: `__request(OpenAPI, { method: 'POST', url: '/api/v1/x' })`,
 * `(options.client ?? client).post({ url: '/api/v1/x' })`,
 * `session.request(method="GET", url="/x")`. The parser records the
 * configuration (`requestConfig`); this module decides whether the CALLEE is
 * an HTTP request helper from its definition, never from its name:
 *
 *   - the callee (or the receiver value it is called on) is bound to an HTTP
 *     client package import (axios, ky, got, undici, requests, httpx, ...),
 *     or is the platform `fetch`;
 *   - the callee is a project function whose body - following project
 *     function calls a few hops - performs such a call;
 *   - the receiver value was produced by such a factory
 *     (`export const client = createClient(...)` where createClient calls
 *     `axios.create`), possibly through `a ?? b` / `a || b` / ternaries.
 *
 * Anything else is unproven and stays in the "possible client requests"
 * band with a reason.
 */

'use strict';

const path = require('path');
const rg = require('./route-graph');

const { field, namedChildren, unwrap, findDecl } = rg;

const MAX_HOPS = 4;           // project function bodies followed from a helper
const MAX_RESOLVE = 16;       // value/alias resolution steps
const MAX_NODES_PER_FUNCTION = 20000;

// HTTP client packages: calling them, or methods on values they produce,
// performs HTTP. Library identities, not project names.
const JS_HTTP_PACKAGES = [
    'axios', 'ky', 'got', 'node-fetch', 'cross-fetch', 'isomorphic-fetch', 'undici',
    'superagent', 'ofetch', 'redaxios', 'wretch', 'http', 'https', 'node:http',
    'node:https', '@angular/common/http', '@hey-api/client-fetch', '@hey-api/client-axios',
    '@hey-api/client-next', '@hey-api/client-nuxt', 'openapi-fetch',
];
const JS_HTTP_GLOBAL_CALLS = new Set(['fetch']);
const JS_HTTP_GLOBAL_CTORS = new Set(['XMLHttpRequest', 'EventSource']);
const PY_HTTP_MODULES = [
    'requests', 'httpx', 'aiohttp', 'urllib3', 'urllib.request', 'http.client', 'niquests', 'treq',
];

function isHttpPackage(spec, list) {
    if (!spec) return false;
    const s = String(spec);
    return list.some(p => s === p || s.startsWith(p + '/') || s.startsWith(p + '.'));
}

const JS_LANGS = new Set(['javascript', 'typescript', 'tsx']);
const JS_FUNCTION_TYPES = new Set([
    'function_declaration', 'function_expression', 'function', 'arrow_function',
    'method_definition', 'generator_function_declaration', 'generator_function',
]);

const PROVEN = Object.freeze({ proven: true });
const PY_CLIENT_TYPE = /^(TestClient|Client|AsyncClient|Session|FlaskClient|ClientSession|AsyncSession)$/;
const CLIENT_METHOD = /^(get|post|put|delete|patch|options|head|fetch|send)$|request/i;

function unknown(reason) {
    return { proven: false, reason };
}

class RequestHelperProof {
    constructor(index, sess) {
        this.index = index;
        this.sess = sess;
        this.fnMemo = new Map();
    }

    /** Classify one call record carrying `requestConfig`. */
    classify(file, call) {
        const lang = this.sess.lang(file);
        if (JS_LANGS.has(lang)) {
            // A method call proves HTTP only as a client-shaped method on a
            // client value, or through a module namespace (`api.fn(...)`):
            // refuse the rest from the record, before any parse.
            if (call.isMethod && !CLIENT_METHOD.test(call.name) && !call.receiverIsModule &&
                !this.jsNamespaceReceiver(file, call.receiver)) {
                return unknown('method-not-request');
            }
            const root = this.sess.root(file);
            if (!root) return unknown('unparsed');
            const node = locateCall(root, call.callStart, call.callEnd, 'call_expression');
            if (!node) return unknown('call-not-located');
            return this.jsCallee(file, unwrap(field(node, 'function')), 0);
        }
        if (lang === 'python') {
            // Cheap refusals from the call record before any parse: a dotted
            // receiver (`Model.objects.create`, `self.client.x`) is never a
            // module or module-level client binding, and a bare name that
            // is neither a local function nor an import is a class/builtin.
            if (call.isMethod) {
                const typed = call.receiverType && PY_CLIENT_TYPE.test(String(call.receiverType).split('.').pop()) &&
                    call.receiverTypeSource !== 'guess';
                if (typed) return PROVEN;
                if (!call.receiver || !/^[A-Za-z_]\w*$/.test(call.receiver) ||
                    call.receiver === 'self' || call.receiver === 'cls') {
                    return unknown('receiver-unproven');
                }
                // A class receiver (`RedirectView.as_view(url=...)`) is not a
                // client value or module.
                const recvDefs = this.index.symbols.get(call.receiver) || [];
                if (recvDefs.length > 0 && recvDefs.every(d => d.type === 'class')) {
                    return unknown('receiver-unproven');
                }
            } else {
                const entry = this.sess.entry(file);
                const local = (entry?.symbols || []).some(sym => sym.name === call.name &&
                    (sym.type === 'function' || sym.type === 'method'));
                const imported = (entry?.importBindings || []).some(b => (b.alias || b.name) === call.name) ||
                    (entry?.importAliases || []).some(a => a.local === call.name);
                if (!local && !imported) return unknown('callee-unresolved');
                // A project class constructor is not a request helper.
                const defs = this.index.symbols.get(call.name) || [];
                if (!local && defs.length > 0 && defs.every(d => d.type === 'class')) {
                    return unknown('constructor');
                }
            }
            const root = this.sess.root(file);
            if (!root) return unknown('unparsed');
            const start = call.callSite?.start;
            const node = start != null ? locateCall(root, start, start + 1, 'call') : null;
            if (!node) return unknown('call-not-located');
            return this.pyCallee(file, unwrap(field(node, 'function')), call, 0);
        }
        return unknown('language');
    }

    // ------------------------------------------------------------ JS/TS

    /** Receiver bound by an import to a project module namespace. */
    jsNamespaceReceiver(file, receiver) {
        if (!receiver) return false;
        const b = this.jsBinding(file, receiver);
        return !!b && b.binding.kind === 'namespace';
    }

    jsBinding(file, name) {
        const entry = this.sess.entry(file);
        if (!entry) return null;
        const bindings = entry.importBindings || [];
        let binding = bindings.find(b => (b.alias || b.name) === name);
        let original = binding ? binding.name : name;
        if (!binding) {
            const alias = (entry.importAliases || []).find(a => a.local === name);
            if (alias) {
                original = alias.original;
                binding = bindings.find(b => b.name === original);
            }
        }
        return binding ? { binding, original } : null;
    }

    jsImportRecord(file, binding, original) {
        const entry = this.sess.entry(file);
        const rel = entry?.moduleResolved?.[binding.module];
        if (!rel) return null;
        const target = path.join(this.index.root, rel);
        if (binding.kind === 'namespace') return { file: target, namespace: true };
        if (binding.kind === 'default' || original === 'default' ||
            (binding.kind === 'require' && binding.defaultLike)) {
            return rg.resolveJsDefaultExport(this.sess, target, 1);
        }
        return rg.resolveJsExport(this.sess, target, original, 1) ||
            (binding.kind === 'named' ? rg.resolveJsDefaultExport(this.sess, target, 1) : null);
    }

    /** Proof for the function expression being called. */
    jsCallee(file, fn, depth, factory = false) {
        if (!fn || depth > MAX_RESOLVE) return unknown('depth');
        if (fn.type === 'identifier') {
            const decl = findDecl(this.sess, file, fn.text, fn);
            if (decl) return this.jsDeclCallable(file, decl, depth);
            const b = this.jsBinding(file, fn.text);
            if (b) return this.jsImportedCallable(file, b, depth);
            if (JS_HTTP_GLOBAL_CALLS.has(fn.text)) return PROVEN;
            return unknown('callee-unresolved');
        }
        if (fn.type === 'member_expression') {
            const obj = unwrap(field(fn, 'object'));
            const prop = field(fn, 'property')?.text;
            // Namespace import of a project module: `api.request({...})`.
            if (obj && obj.type === 'identifier' && prop && !findDecl(this.sess, file, obj.text, obj)) {
                const b = this.jsBinding(file, obj.text);
                if (b && isHttpPackage(b.binding.module, JS_HTTP_PACKAGES)) return PROVEN;
                const rec = b && this.jsImportRecord(file, b.binding, b.original);
                if (rec && rec.namespace) {
                    const exported = rg.resolveJsExport(this.sess, rec.file, prop, 1);
                    return exported ? this.jsRecordCallable(exported, depth + 1)
                        : unknown('callee-unresolved');
                }
            }
            // A method on an HTTP client VALUE performs a request only when
            // the method reads as one (`client.post`, `instance.request`);
            // a server built on an HTTP stack (`app.route(...)`) is not a
            // client.
            // A factory call on a client value (`axios.create()`) yields a
            // client value too.
            if (!factory && (!prop || !CLIENT_METHOD.test(prop))) return unknown('method-not-request');
            return this.jsValue(file, obj, depth + 1);
        }
        if (fn.type === 'call_expression') return this.jsValue(file, fn, depth + 1);
        return unknown('callee-unresolved');
    }

    jsDeclCallable(file, decl, depth) {
        if (decl.kind === 'function') return this.jsFunction(file, decl.valueNode, 0);
        if (decl.kind === 'param') return this.jsParam(file, decl, depth + 1);
        if ((decl.kind === 'const' || decl.kind === 'var') && decl.valueNode && decl.count === 1) {
            const v = unwrap(decl.valueNode);
            if (JS_FUNCTION_TYPES.has(v.type)) return this.jsFunction(file, v, 0);
            if (v.type === 'identifier' || v.type === 'member_expression') return this.jsCallee(file, v, depth + 1);
            return this.jsValue(file, v, depth + 1);
        }
        return unknown('callee-unresolved');
    }

    jsImportedCallable(file, b, depth) {
        if (isHttpPackage(b.binding.module, JS_HTTP_PACKAGES)) return PROVEN;
        const rec = this.jsImportRecord(file, b.binding, b.original);
        if (!rec) return unknown('external-helper');
        return this.jsRecordCallable(rec, depth + 1);
    }

    jsRecordCallable(rec, depth) {
        if (!rec || rec.namespace) return unknown('callee-unresolved');
        if (rec.decl) return this.jsDeclCallable(rec.file, rec.decl, depth + 1);
        if (rec.valueNode) {
            const v = unwrap(rec.valueNode);
            if (JS_FUNCTION_TYPES.has(v.type)) return this.jsFunction(rec.file, v, 0);
            return this.jsValue(rec.file, v, depth + 1);
        }
        if (rec.importedName) {
            const b = this.jsBinding(rec.file, rec.importedName);
            return b ? this.jsImportedCallable(rec.file, b, depth + 1) : unknown('callee-unresolved');
        }
        return unknown('callee-unresolved');
    }

    /** `const x = require('<spec>')` - the required module specifier. */
    requireSpecOf(decl) {
        const v = decl && decl.valueNode ? unwrap(decl.valueNode) : null;
        if (!v || v.type !== 'call_expression') return null;
        const f = field(v, 'function');
        if (!f || f.type !== 'identifier' || f.text !== 'require') return null;
        const arg = namedChildren(field(v, 'arguments'))[0];
        return arg && arg.type === 'string' ? rg.readLiteral(arg, () => '') : null;
    }

    /** Does this VALUE denote an HTTP client (so methods on it perform HTTP)? */
    jsValue(file, expr, depth) {
        const e = unwrap(expr);
        if (!e || depth > MAX_RESOLVE) return unknown('depth');
        switch (e.type) {
            case 'identifier': {
                const decl = findDecl(this.sess, file, e.text, e);
                if (decl) {
                    if (decl.kind === 'param') return this.jsParam(file, decl, depth + 1);
                    if ((decl.kind === 'const' || decl.kind === 'var') && decl.valueNode && decl.count === 1) {
                        return this.jsValue(file, decl.valueNode, depth + 1);
                    }
                    return unknown('receiver-unproven');
                }
                const b = this.jsBinding(file, e.text);
                if (!b) return unknown('receiver-unproven');
                if (isHttpPackage(b.binding.module, JS_HTTP_PACKAGES)) return PROVEN;
                const rec = this.jsImportRecord(file, b.binding, b.original);
                if (!rec) return unknown('external-helper');
                if (rec.decl) {
                    return rec.decl.valueNode && rec.decl.count === 1
                        ? this.jsValue(rec.file, rec.decl.valueNode, depth + 1)
                        : unknown('receiver-unproven');
                }
                return rec.valueNode ? this.jsValue(rec.file, rec.valueNode, depth + 1)
                    : unknown('receiver-unproven');
            }
            case 'binary_expression': {
                const op = e.child(1)?.type;
                if (op !== '??' && op !== '||') return unknown('receiver-unproven');
                return this.anyProven([field(e, 'left'), field(e, 'right')], n => this.jsValue(file, n, depth + 1));
            }
            case 'ternary_expression':
                return this.anyProven([field(e, 'consequence'), field(e, 'alternative')],
                    n => this.jsValue(file, n, depth + 1));
            case 'call_expression': {
                // A factory result: `createClient(...)`, `axios.create(...)`.
                const callee = unwrap(field(e, 'function'));
                if (callee && callee.type === 'identifier' && callee.text === 'require') {
                    const spec = this.requireSpecOf({ valueNode: e });
                    return isHttpPackage(spec, JS_HTTP_PACKAGES) ? PROVEN : unknown('receiver-unproven');
                }
                return this.jsCallee(file, callee, depth + 1, true);
            }
            default:
                return unknown('receiver-unproven');
        }
    }

    anyProven(nodes, proof) {
        let last = unknown('receiver-unproven');
        for (const n of nodes) {
            if (!n) continue;
            const r = proof(n);
            if (r.proven) return r;
            last = r;
        }
        return last;
    }

    /** A parameter proves a client only through its declared type or default. */
    jsParam(file, decl, depth) {
        const holder = decl.nameNode.parent;
        const typeNode = decl.typeNode || (holder ? field(holder, 'type') : null);
        if (typeNode) {
            const m = typeNode.text.replace(/^:\s*/, '').match(/^([A-Za-z_$][\w$]*)/);
            const b = m ? this.jsBinding(file, m[1]) : null;
            if (b && isHttpPackage(b.binding.module, JS_HTTP_PACKAGES)) return PROVEN;
        }
        const dflt = holder ? (field(holder, 'value') || field(holder, 'right')) : null;
        if (dflt) return this.jsValue(file, dflt, depth + 1);
        return unknown('receiver-unproven');
    }

    /** A project function performs HTTP when its body (closures included)
     *  calls an HTTP primitive, directly or through project functions. */
    jsFunction(file, fnNode, hops) {
        if (!fnNode) return unknown('callee-unresolved');
        const key = `${file}#${fnNode.startIndex}`;
        if (this.fnMemo.has(key)) return this.fnMemo.get(key) || unknown('recursion');
        this.fnMemo.set(key, null);
        let result = unknown('helper-performs-no-http');
        {
            const stack = [fnNode];
            let visited = 0;
            const followUps = [];
            while (stack.length > 0 && visited++ < MAX_NODES_PER_FUNCTION) {
                const node = stack.pop();
                if (node.type === 'new_expression') {
                    const ctor = unwrap(field(node, 'constructor'));
                    if (ctor && ctor.type === 'identifier' && JS_HTTP_GLOBAL_CTORS.has(ctor.text) &&
                        !findDecl(this.sess, file, ctor.text, ctor)) { result = PROVEN; break; }
                } else if (node.type === 'call_expression') {
                    const callee = unwrap(field(node, 'function'));
                    if (callee && this.jsPrimitive(file, callee)) { result = PROVEN; break; }
                    if (callee && callee.type === 'identifier') followUps.push(callee);
                }
                for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push(node.namedChild(i));
            }
            if (!result.proven && hops < MAX_HOPS) {
                for (const callee of followUps) {
                    const r = this.jsLocalCallee(file, callee, hops + 1);
                    if (r.proven) { result = r; break; }
                }
            }
        }
        this.fnMemo.set(key, result);
        return result;
    }

    /** fetch / HTTP-package call inside a function body. */
    jsPrimitive(file, callee) {
        if (callee.type === 'identifier') {
            const decl = findDecl(this.sess, file, callee.text, callee);
            if (decl) return isHttpPackage(this.requireSpecOf(decl), JS_HTTP_PACKAGES);
            if (JS_HTTP_GLOBAL_CALLS.has(callee.text) && !this.jsBinding(file, callee.text)) return true;
            const b = this.jsBinding(file, callee.text);
            return !!b && isHttpPackage(b.binding.module, JS_HTTP_PACKAGES);
        }
        if (callee.type === 'member_expression') {
            let root = unwrap(field(callee, 'object'));
            while (root && root.type === 'member_expression') root = unwrap(field(root, 'object'));
            if (!root || root.type !== 'identifier') return false;
            const decl = findDecl(this.sess, file, root.text, root);
            if (decl) return isHttpPackage(this.requireSpecOf(decl), JS_HTTP_PACKAGES);
            const b = this.jsBinding(file, root.text);
            return !!b && isHttpPackage(b.binding.module, JS_HTTP_PACKAGES);
        }
        return false;
    }

    /** A bare call inside a helper body: follow it into project functions. */
    jsLocalCallee(file, callee, depth) {
        const decl = findDecl(this.sess, file, callee.text, callee);
        if (decl) {
            if (decl.kind === 'function') return this.jsFunction(file, decl.valueNode, depth);
            if ((decl.kind === 'const' || decl.kind === 'var') && decl.valueNode && decl.count === 1) {
                const v = unwrap(decl.valueNode);
                if (JS_FUNCTION_TYPES.has(v.type)) return this.jsFunction(file, v, depth);
            }
            return unknown('callee-unresolved');
        }
        const b = this.jsBinding(file, callee.text);
        if (!b) return unknown('callee-unresolved');
        const rec = this.jsImportRecord(file, b.binding, b.original);
        if (!rec || rec.namespace) return unknown('callee-unresolved');
        if (rec.decl && rec.decl.kind === 'function') return this.jsFunction(rec.file, rec.decl.valueNode, depth);
        const v = rec.decl?.valueNode || rec.valueNode;
        const u = v ? unwrap(v) : null;
        return u && JS_FUNCTION_TYPES.has(u.type) ? this.jsFunction(rec.file, u, depth)
            : unknown('callee-unresolved');
    }

    // ------------------------------------------------------------ Python

    pyBinding(file, name) {
        const entry = this.sess.entry(file);
        if (!entry) return null;
        const bindings = entry.importBindings || [];
        let binding = bindings.find(b => (b.alias || b.name) === name);
        if (!binding) {
            const alias = (entry.importAliases || []).find(a => a.local === name);
            if (alias) binding = bindings.find(b => b.name === alias.original);
        }
        return binding || null;
    }

    pyBindingIsHttp(binding) {
        if (!binding) return false;
        const mod = String(binding.module || '');
        return isHttpPackage(mod, PY_HTTP_MODULES) ||
            (binding.kind !== 'from' && isHttpPackage(binding.name, PY_HTTP_MODULES));
    }

    pyCallee(file, fn, call, depth) {
        if (!fn || depth > MAX_RESOLVE) return unknown('depth');
        if (fn.type === 'identifier') {
            const decl = findDecl(this.sess, file, fn.text, fn);
            if (decl && decl.kind === 'function') return this.pyFunction(file, decl.valueNode, 0);
            if (decl) return unknown('callee-unresolved');
            const b = this.pyBinding(file, fn.text);
            if (this.pyBindingIsHttp(b)) return PROVEN;
            return this.pyValueCallable(pyImportedFunction(this.sess, file, fn.text, 0));
        }
        if (fn.type === 'attribute') {
            if (call && call.receiverType && PY_CLIENT_TYPE.test(String(call.receiverType).split('.').pop()) &&
                call.receiverTypeSource !== 'guess') {
                return PROVEN;
            }
            const obj = unwrap(field(fn, 'object'));
            const attr = field(fn, 'attribute')?.text;
            if (obj && obj.type === 'identifier') {
                const decl = findDecl(this.sess, file, obj.text, obj);
                if (!decl) {
                    const b = this.pyBinding(file, obj.text);
                    if (this.pyBindingIsHttp(b)) return PROVEN;
                    const v = rg.lookupValue(this.sess, file, obj, 1);
                    if (v && v.kind === 'module' && attr) {
                        return this.pyValueCallable(topLevelFunction(this.sess, v.file, attr) ||
                            pyImportedFunction(this.sess, v.file, attr, 0));
                    }
                    return unknown('receiver-unproven');
                }
                if (decl.valueNode && decl.count === 1) return this.pyValue(file, decl.valueNode, depth + 1);
            }
            return unknown('receiver-unproven');
        }
        return unknown('callee-unresolved');
    }

    /** A bare call inside a helper body: follow it into project functions. */
    pyFollow(file, callee, hops) {
        const decl = findDecl(this.sess, file, callee.text, callee);
        const v = decl ? (decl.kind === 'function' ? { kind: 'function', file, node: decl.valueNode } : null)
            : pyImportedFunction(this.sess, file, callee.text, 0);
        return v ? this.pyFunction(v.file, v.node, hops) : unknown('callee-unresolved');
    }

    pyValueCallable(v) {
        if (!v) return unknown('external-helper');
        if (v.kind === 'function') return this.pyFunction(v.file, v.node, 0);
        return unknown('callee-unresolved');
    }

    /** `s = requests.Session()` / `client = httpx.Client()` */
    pyValue(file, expr, depth) {
        const e = unwrap(expr);
        if (!e || e.type !== 'call' || depth > MAX_RESOLVE) return unknown('receiver-unproven');
        const callee = unwrap(field(e, 'function'));
        if (!callee) return unknown('receiver-unproven');
        let root = callee;
        while (root && root.type === 'attribute') root = unwrap(field(root, 'object'));
        if (root && root.type === 'identifier' && !findDecl(this.sess, file, root.text, root) &&
            this.pyBindingIsHttp(this.pyBinding(file, root.text))) return PROVEN;
        return unknown('receiver-unproven');
    }

    pyFunction(file, fnNode, hops) {
        if (!fnNode) return unknown('callee-unresolved');
        const key = `${file}#${fnNode.startIndex}`;
        if (this.fnMemo.has(key)) return this.fnMemo.get(key) || unknown('recursion');
        this.fnMemo.set(key, null);
        let result = unknown('helper-performs-no-http');
        const followUps = [];
        const stack = [fnNode];
        let visited = 0;
        while (stack.length > 0 && visited++ < MAX_NODES_PER_FUNCTION) {
            const node = stack.pop();
            if (node.type === 'call') {
                const callee = unwrap(field(node, 'function'));
                let root = callee;
                while (root && root.type === 'attribute') root = unwrap(field(root, 'object'));
                if (root && root.type === 'identifier' && !findDecl(this.sess, file, root.text, root) &&
                    this.pyBindingIsHttp(this.pyBinding(file, root.text))) { result = PROVEN; break; }
                if (callee && callee.type === 'identifier') followUps.push(callee);
            }
            for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push(node.namedChild(i));
        }
        if (!result.proven && hops < MAX_HOPS) {
            for (const callee of followUps) {
                const r = this.pyFollow(file, callee, hops + 1);
                if (r.proven) { result = r; break; }
            }
        }
        this.fnMemo.set(key, result);
        return result;
    }
}

function topLevelFunction(sess, file, name) {
    const root = sess.root(file);
    if (!root) return null;
    const decl = rg.scopeDecls(sess, file, sess.lang(file), root).get(name);
    return decl && decl.kind === 'function' ? { kind: 'function', file, node: decl.valueNode } : null;
}

/** A function a Python name imports (`from pkg.mod import helper`),
 *  chasing re-exports. */
function pyImportedFunction(sess, file, name, depth) {
    if (depth > MAX_HOPS) return null;
    const entry = sess.entry(file);
    const bindings = entry?.importBindings || [];
    let binding = bindings.find(b => (b.alias || b.name) === name);
    if (!binding) {
        const alias = (entry?.importAliases || []).find(a => a.local === name);
        if (alias) binding = bindings.find(b => b.name === alias.original);
    }
    if (!binding || binding.kind !== 'from') return null;
    const rel = entry.moduleResolved?.[String(binding.module || '')];
    if (!rel) return null;
    const target = path.join(sess.index.root, rel);
    return topLevelFunction(sess, target, binding.name) ||
        pyImportedFunction(sess, target, binding.name, depth + 1);
}

/** The call node of `type` starting at `start` (JS callStart / Python name). */
function locateCall(root, start, end, type) {
    let node = root.descendantForIndex(start, Math.max(start, end - 1));
    while (node && !(node.type === type && node.startIndex <= start && node.endIndex >= end)) {
        node = node.parent;
    }
    return node;
}

module.exports = { RequestHelperProof, JS_HTTP_PACKAGES, PY_HTTP_MODULES };
