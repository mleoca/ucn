/**
 * core/bridge.js — Polyglot HTTP API endpoint bridging.
 *
 * Detects HTTP server routes (Express/Fastify/Koa/NestJS, Flask/FastAPI,
 * net-http/gorilla/gin/echo/chi/fiber, Spring/JAX-RS, axum/actix-web) and
 * client requests (fetch, axios, requests, http, restTemplate, reqwest, etc.),
 * then matches them so a polyglot codebase shows which client call hits which
 * server route — across language boundaries.
 *
 * REUSES the call cache (getCachedCalls) and AST-derived symbol metadata
 * (decoratorsWithArgs/annotationsWithArgs/attributesWithArgs). Router mount
 * composition (fix #282, #366) re-parses only the files whose mounts the
 * call records cannot settle (Python include/mount calls, non-literal
 * prefixes, mounted call results, closures, routers passed to router-typed
 * parameters, redeclared router names) through one AST session
 * (core/route-graph.js), which also folds prefix expressions by constant
 * propagation. Request-configuration clients are proven HTTP from the
 * callee's definition (core/request-helpers.js). Declarative Python route
 * tables (Django URLconfs, DRF routers, Starlette route lists, aiohttp
 * tables) and registrations on proven apps come from core/route-lists.js,
 * whose include/mount edges join the Python mount composition (fix #373).
 * Extraction results are
 * cached lazily on `index._endpointsCache` and invalidated on rebuild via the
 * same mechanism as `_reachableSymbols`.
 *
 * Output shape:
 *   serverRoutes: [{ method, path, normalizedPath, handler, file, line, framework, raw }]
 *   clientRequests: [{ method, path, normalizedPath, file, line, callerName, callerStartLine,
 *                       framework, interp }]
 *   bridges: [{ route, request, confidence, methodInferred, matchType }]
 */

'use strict';

const fs = require('fs');
const { codeUnitCompare, isTestPath } = require('./shared');
const path = require('path');
const { getCachedCalls } = require('./callers');
const routeGraph = require('./route-graph');
const { RequestHelperProof } = require('./request-helpers');
const { collectRouteLists, regexCanMatchSlash, ANY_TEXT, pythonContainerKey } = require('./route-lists');

// ============================================================================
// HTTP METHOD CONSTANTS
// ============================================================================

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'ALL', 'USE']);

// ============================================================================
// PATH NORMALIZATION
// ============================================================================

/**
 * Canonicalize a route path for matching: strip the trailing slash (and,
 * for client URLs, the query string and fragment) and turn every parameter
 * into a wildcard token: `*` for a parameter within one segment, `**` for
 * one that can span segments (a catch-all, a path converter, a regex that
 * matches '/', or an unresolved `{?expr}` prefix).
 *
 * Parameter spellings differ by framework (fix #383): a ':' in a Starlette
 * route (`/users/{name}:disable`) or a client URL is literal text, and a
 * bare `*` is a catch-all in Express or echo but one segment in Spring.
 * `syntax` selects the spellings in force:
 *   router — Express/Koa/Fastify/Hono/NestJS, gin/echo/chi/gorilla/fiber/
 *            net/http, axum/actix: `:name` (with path-to-regexp `(re)`,
 *            `*`, `+`, `?`), `*name`, `*`, `{name}`, `{name:re}`, `{*name}`
 *   python — Flask/Django `<conv:name>` (`<path:x>` spans segments),
 *            Starlette/FastAPI/aiohttp `{name}`, `{name:conv|re}`
 *   jvm    — Spring/JAX-RS/ASP.NET `{name}`, `{name:re}`, `{*name}`, `**`
 *   client — request URLs: SDK templates `{name}`; interpolated values
 *            arrive as `*`
 *
 *   /users/:id            → /users/*
 *   /users/{id}           → /users/*
 *   /users/<int:user_id>  → /users/*
 *   /files/<path:rest>    → /files/**
 *   /static/*filepath     → /static/**
 *   /users?q=foo          → /users        (client)
 *
 * @param {string} p - Raw path
 * @param {string} [syntax] - router | python | jvm | client (default: all)
 * @returns {string} Canonical path
 */
const MULTI_SEGMENT = '\u0000';
const ONE_SEGMENT = '\u0001';
const PARAM_SYNTAX = {
    router: { colon: true, brace: true, starMulti: true },
    python: { angle: true, brace: true },
    jvm: { brace: true, doubleStarMulti: true },
    client: { brace: true, query: true },
};
const ALL_SYNTAX = { colon: true, brace: true, angle: true };

/** Index of the brace/paren closing the one at `open` (nesting-aware). */
function closingIndex(s, open) {
    const openCh = s[open];
    const closeCh = openCh === '{' ? '}' : openCh === '(' ? ')' : '>';
    let depth = 0;
    for (let j = open; j < s.length; j++) {
        const c = s[j];
        if (c === '\\') { j++; continue; }
        if (c === openCh) depth++;
        else if (c === closeCh) { depth--; if (depth === 0) return j; }
    }
    return -1;
}

function normalizePath(p, syntax = null) {
    if (typeof p !== 'string' || !p) return '';
    const fam = (syntax && PARAM_SYNTAX[syntax]) || ALL_SYNTAX;
    // fix #366: an unresolved mount-prefix segment `{?expr}` may stand for
    // several path segments; it normalizes to the multi-segment wildcard.
    let s = p.replace(/\{\?[^}]*\}/g, MULTI_SEGMENT);
    // Query strings and fragments belong to request URLs; in a route pattern
    // '?' is an optional marker or regex syntax.
    if (fam.query || !syntax) {
        const q = s.indexOf('?');
        if (q !== -1) s = s.slice(0, q);
        const h = s.indexOf('#');
        if (h !== -1) s = s.slice(0, h);
    }
    // Strip trailing slash (but keep "/")
    if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
    // No parameter spelling at all: the path is its own canonical form.
    if (!s.includes(MULTI_SEGMENT) && !/[<{:*]/.test(s)) return s;
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        const segmentStart = i === 0 || s[i - 1] === '/';
        if (fam.angle && c === '<') {
            const close = s.indexOf('>', i);
            if (close > i) {
                const inner = s.slice(i + 1, close);
                out += /^path:/.test(inner) ? MULTI_SEGMENT : ONE_SEGMENT;
                i = close;
                continue;
            }
        }
        if (fam.brace && c === '{') {
            const close = closingIndex(s, i);
            if (close > i) {
                const inner = s.slice(i + 1, close).trim();
                let token = ONE_SEGMENT;
                if (inner === '$') token = '';                               // Go 1.22 exact end
                else if (/^\*/.test(inner) || /\.\.\.$/.test(inner)) token = MULTI_SEGMENT; // {*rest} {**slug} {rest...}
                else {
                    const colon = inner.indexOf(':');
                    const spec = colon >= 0 ? inner.slice(colon + 1).trim() : '';
                    if (spec === 'path' || (spec && regexCanMatchSlash(spec))) token = MULTI_SEGMENT;
                }
                out += token;
                i = close;
                continue;
            }
        }
        if (fam.colon && c === ':' && /[A-Za-z_]/.test(s[i + 1] || '')) {
            let j = i + 1;
            while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
            let multi = false;
            if (s[j] === '(') {
                const close = closingIndex(s, j);
                if (close > j) {
                    multi = regexCanMatchSlash(s.slice(j + 1, close));
                    j = close + 1;
                }
            }
            if (s[j] === '*' || s[j] === '+') { multi = true; j++; } else if (s[j] === '?') j++;
            out += multi ? MULTI_SEGMENT : ONE_SEGMENT;
            i = j - 1;
            continue;
        }
        if (c === '*') {
            let j = i;
            while (s[j] === '*') j++;
            const stars = j - i;
            if (fam.colon && segmentStart && /[A-Za-z_]/.test(s[j] || '')) {
                // `*name`: httprouter/gin, axum, Express 5 catch-all.
                while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
                out += MULTI_SEGMENT;
            } else if (fam.starMulti || (fam.doubleStarMulti && stars >= 2) || (!syntax && stars >= 2)) {
                out += MULTI_SEGMENT;
            } else {
                out += ONE_SEGMENT;
            }
            i = j - 1;
            continue;
        }
        out += c;
    }
    // Adjacent wildcards within one run form one token (a multi-segment one
    // when any part spans segments).
    let rendered = '';
    for (let i = 0; i < out.length;) {
        if (out[i] !== MULTI_SEGMENT && out[i] !== ONE_SEGMENT) { rendered += out[i++]; continue; }
        let multi = false;
        while (i < out.length && (out[i] === MULTI_SEGMENT || out[i] === ONE_SEGMENT)) {
            if (out[i] === MULTI_SEGMENT) multi = true;
            i++;
        }
        rendered += multi ? '**' : '*';
    }
    return rendered;
}

/** Parameter spelling family of a server route, by its source language. */
function routeSyntax(lang) {
    if (lang === 'python') return 'python';
    if (lang === 'java' || lang === 'csharp' || lang === 'kotlin') return 'jvm';
    return 'router';
}

/**
 * How a framework joins a mounted fragment to the prefix it is mounted
 * under (fix #383):
 *   path    — one '/' between the parts whatever each side spells: Flask
 *             url_prefix, FastAPI include_router, Starlette Mount, aiohttp
 *             subapps, Express, Hono, NestJS, gin, chi, gorilla, fiber,
 *             net/http StripPrefix, axum nest, actix scope, Spring, JAX-RS,
 *             ASP.NET.
 *   concat  — the strings are concatenated as written: Django's resolver
 *             matches an include pattern and hands the remainder to the
 *             included patterns (`path("api", include(...))` + "items/"
 *             serves /apiitems/); Echo groups prepend their prefix.
 *   koa     — koa-router: concatenated; a '/' route under a prefix serves
 *             at the prefix itself.
 *   fastify — Fastify: route URLs are concatenated to the prefix, sharing
 *             one '/' when both spell it, and a '/' route serves at the
 *             prefix; plugin prefixes join with exactly one '/'.
 */
const JOIN_RULE_BY_FRAMEWORK = { django: 'concat', echo: 'concat', koa: 'koa', fastify: 'fastify' };

function joinRuleOf(framework) {
    return JOIN_RULE_BY_FRAMEWORK[framework] || 'path';
}

/** Join a mount prefix with a route path. */
function joinRoutePath(prefix, sub, rule = 'path') {
    if (rule !== 'path') {
        const p = prefix || '';
        let r = sub || '';
        if ((rule === 'fastify' || rule === 'koa') && r === '/' && p) r = '';
        else if (rule === 'fastify' && p.endsWith('/') && r.startsWith('/')) r = r.slice(1);
        const out = p + r;
        // The router matches from the root: a pattern that does not spell
        // the leading '/' is rooted by the resolver (Django strips it from
        // the request path, echo prepends it).
        return out.startsWith('/') ? out : '/' + out;
    }
    const p = (prefix || '').replace(/\/+$/, '');
    const s = (sub || '').replace(/^\/+/, '');
    if (!p && !s) return '/';
    if (!s) return p || '/';
    if (!p) return '/' + s;
    return p + '/' + s;
}

/** Join two PREFIX fragments (fix #282). Unlike joinRoutePath, two empty
 *  fragments compose to '' — a router with no mount prefix anywhere must not
 *  gain a spurious '/'. */
function joinPrefixes(a, b, rule = 'path') {
    // Fastify's plugin prefixes join with exactly one '/' (buildRoutePrefix):
    // the path rule. Only its route URLs concatenate.
    if (rule === 'concat' || rule === 'koa') return (a || '') + (b || '');
    if (!a) return b || '';
    if (!b) return a;
    return a.replace(/\/+$/, '') + '/' + b.replace(/^\/+/, '');
}

/**
 * Compose mount-prefix chains transitively (fix #282). A router's full
 * prefix = (each mounter's full prefix + the mount-call prefix) + its own
 * constructor prefix — FastAPI/Flask include semantics; Express has no
 * constructor prefix so `ctorPrefixes` is simply empty there.
 *
 * @param {Map<string, Array<{mounterKey: string|null, prefix: string, overridesCtor?: boolean, join?: string}>>} edges
 *        targetKey -> incoming mounts (mounterKey null = unresolvable mounter,
 *        treated as a root). `overridesCtor` models Flask's register_blueprint
 *        semantics: an explicit url_prefix REPLACES the blueprint's own prefix
 *        (FastAPI's include_router prefix composes with it instead). `join`
 *        is the mounting framework's join rule (fix #383, default 'path').
 * @param {Map<string, string>} ctorPrefixes - key -> constructor prefix
 * @param {Map<string, string>} [ctorJoins] - key -> join rule of its constructor prefix
 * @returns {Map<string, string[]>} key -> composed full prefixes (sorted)
 */
function composeMountPrefixes(edges, ctorPrefixes, ctorJoins = null) {
    const memo = new Map();
    const resolve = (key, depth, stack) => {
        if (key == null) return [''];
        if (memo.has(key)) return memo.get(key);
        if (depth > 8 || stack.has(key)) return [''];
        stack.add(key);
        const own = ctorPrefixes.get(key) || '';
        const ownJoin = (ctorJoins && ctorJoins.get(key)) || 'path';
        const incoming = edges.get(key) || [];
        const full = incoming.length === 0 ? [own]
            : incoming.flatMap(e => resolve(e.mounterKey, depth + 1, stack)
                .map(parentFull => joinPrefixes(joinPrefixes(parentFull, e.prefix, e.join || 'path'),
                    e.overridesCtor ? '' : own, ownJoin)));
        const out = [...new Set(full.length ? full : [own])].sort(codeUnitCompare);
        stack.delete(key);
        memo.set(key, out);
        return out;
    };
    // Only router keys are exposed — mounter-only keys (the app object) are
    // resolved for composition but would shadow group-prefix fallbacks if kept.
    const routerKeys = new Set([...edges.keys(), ...ctorPrefixes.keys()]);
    const out = new Map();
    for (const key of [...routerKeys].sort(codeUnitCompare)) {
        out.set(key, resolve(key, 0, new Set()));
    }
    return out;
}

// ============================================================================
// FRAMEWORK PATTERNS
// ============================================================================

// Server: receiver+method patterns (router-like calls).
// receiver matches case-insensitively; method matches exactly.
//
// Python is intentionally absent: Flask/FastAPI use decorators, which we capture
// via collectMethodRoutes(). Including a Python entry would double-count routes
// (the decorator application is also a call expression in the AST).
const SERVER_RECEIVER_PATTERNS = {
    javascript: [
        // Express, Fastify, Koa router, generic
        { receiverPattern: /^(app|router|server|api|fastify|koaRouter|koa)$/i,
          methodPattern: /^(get|post|put|delete|patch|options|head|all)$/,
          framework: 'express' },
        // app.use is more ambiguous but counts as a route mount
    ],
    typescript: [
        { receiverPattern: /^(app|router|server|api|fastify|koaRouter|koa)$/i,
          methodPattern: /^(get|post|put|delete|patch|options|head|all)$/,
          framework: 'express' },
    ],
    python: [],
    go: [
        // gin, echo, chi, fiber: r.GET("/x", h), r.Group("/api"), e.GET(...)
        { receiverPattern: /^(r|router|engine|app|e|api|v\d+|group|mux|serveMux|http)$/i,
          methodPattern: /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Handle|HandleFunc)$/,
          framework: 'go-http' },
    ],
    java: [
        // Less common — Spring uses annotations. Capture WebFlux router builders if present.
    ],
    rust: [
        // axum: matches both
        //   - Named variable form:    let app = Router::new(); app.route("/p", get(h))
        //     → receiver = 'app' (matched by the alpha pattern)
        //   - Chained constructor:    Router::new().route("/p", get(h)).route(...)
        //     → receiver = 'Router' (synthetic marker set by rust.js findCallsInCode
        //       when it walks the chain to its `Router::new()` root)
        { receiverPattern: /^(router|app|api|r)$/i,
          methodPattern: /^route$/,
          framework: 'axum' },
        // axum nested: .nest("/prefix", inner) — captured but treated as a
        // route mount with method ALL. (Prefix concat with inner router routes
        // is deferred — too complex to track inner Router argument.)
    ],
    csharp: [
        { receiverPattern: /^(app|endpoints|routes)$/i,
          methodPattern: /^Map(Get|Post|Put|Delete|Patch|Methods|Fallback)$/,
          framework: 'aspnet-minimal' },
    ],
};

// Client: receiver+method patterns and bare-call patterns.
const CLIENT_PATTERNS = {
    javascript: {
        // Bare calls: fetch('/x')
        bareCalls: new Set(['fetch']),
        // Receiver.method patterns
        receivers: [
            { receiverPattern: /^(axios|client|http|api|httpClient)$/i,
              methodPattern: /^(get|post|put|delete|patch|options|head|request)$/,
              framework: 'axios' },
        ],
        // axios('/path', {...}) or axios({method:..., url:'/path'})
        callableReceivers: new Set(['axios']),
    },
    typescript: {
        bareCalls: new Set(['fetch']),
        receivers: [
            { receiverPattern: /^(axios|client|http|api|httpClient)$/i,
              methodPattern: /^(get|post|put|delete|patch|options|head|request)$/,
              framework: 'axios' },
        ],
        callableReceivers: new Set(['axios']),
    },
    python: {
        bareCalls: new Set(),
        receivers: [
            { receiverPattern: /^(requests|httpx|client|session|s)$/,
              methodPattern: /^(get|post|put|delete|patch|options|head|request)$/,
              framework: 'requests' },
        ],
        callableReceivers: new Set(),
    },
    go: {
        bareCalls: new Set(),
        receivers: [
            { receiverPattern: /^(http|client|c)$/i,
              methodPattern: /^(Get|Post|PostForm|Head|Do|NewRequest|NewRequestWithContext)$/,
              framework: 'go-http' },
        ],
        callableReceivers: new Set(),
    },
    java: {
        bareCalls: new Set(),
        receivers: [
            { receiverPattern: /^(restTemplate|client|webClient|http|httpClient)$/i,
              methodPattern: /^(getForObject|postForObject|putForObject|exchange|getForEntity|postForEntity|uri|send)$/,
              framework: 'spring-client' },
        ],
        callableReceivers: new Set(),
    },
    rust: {
        bareCalls: new Set(),
        receivers: [
            { receiverPattern: /^(client|reqwest|c|http)$/i,
              methodPattern: /^(get|post|put|delete|patch|head|request)$/,
              framework: 'reqwest' },
        ],
        // reqwest::get("/path") is a path-call captured separately
        callableReceivers: new Set(),
    },
    csharp: {
        bareCalls: new Set(),
        receivers: [
            { receiverPattern: /^(client|http|httpClient)$/i,
              methodPattern: /^(GetAsync|PostAsync|PutAsync|DeleteAsync|PatchAsync|SendAsync)$/,
              framework: 'dotnet-httpclient' },
        ],
        callableReceivers: new Set(),
    },
};

// TSX files use the TypeScript patterns (fix #366: `.tsx` route and client
// calls were invisible).
SERVER_RECEIVER_PATTERNS.tsx = SERVER_RECEIVER_PATTERNS.typescript;
CLIENT_PATTERNS.tsx = CLIENT_PATTERNS.typescript;

// Languages whose routes can be registered by a call on a router value
// (the call-pattern loop of extractServerRoutes).
const CALL_REGISTERED_LANGS = new Set(Object.keys(SERVER_RECEIVER_PATTERNS)
    .filter(lang => SERVER_RECEIVER_PATTERNS[lang].length > 0 ||
        lang === 'javascript' || lang === 'typescript' || lang === 'tsx' || lang === 'go'));

// HTTP-method decorator/annotation/attribute patterns.
// name → method (or 'ALL' if multi).
const METHOD_DECORATORS = {
    // NestJS / TS decorators
    'Get':           'GET',
    'Post':          'POST',
    'Put':           'PUT',
    'Delete':        'DELETE',
    'Patch':         'PATCH',
    'Options':       'OPTIONS',
    'Head':          'HEAD',
    'All':           'ALL',
    // Spring
    'GetMapping':    'GET',
    'PostMapping':   'POST',
    'PutMapping':    'PUT',
    'DeleteMapping': 'DELETE',
    'PatchMapping':  'PATCH',
    // Spring catch-all (handled specially when 'method' attr present)
    'RequestMapping': null,
    // JAX-RS
    'GET':           'GET',
    'POST':          'POST',
    'PUT':           'PUT',
    'DELETE':        'DELETE',
    'HEAD':          'HEAD',
    'OPTIONS':       'OPTIONS',
    'PATCH':         'PATCH',
    'Path':          null, // JAX-RS @Path: only the prefix; HTTP method comes from @GET etc.
};

// Rust attribute names that map to HTTP methods (actix #[get("/x")] etc.)
const RUST_METHOD_ATTRS = {
    'get':    'GET',
    'post':   'POST',
    'put':    'PUT',
    'delete': 'DELETE',
    'patch':  'PATCH',
    'head':   'HEAD',
    'options':'OPTIONS',
};

// Class-level decorator names that contribute a path PREFIX (no HTTP method).
const PREFIX_DECORATORS = new Set([
    'Controller',     // NestJS class decorator: @Controller('/users')
]);
const PREFIX_ANNOTATIONS = new Set([
    'RequestMapping', // Spring class-level @RequestMapping("/api")
    'Path',           // JAX-RS class-level @Path("/api")
]);
const CSHARP_PREFIX_ATTRIBUTES = new Set(['Route']);

// ============================================================================
// EXTRACT SERVER ROUTES
// ============================================================================

// Server frameworks by the module that provides the router (fix #383). A
// file's call-registered routes carry the framework its imports prove (or
// the project's own package, when the project IS that framework); with no
// single framework in evidence they keep the family label.
const JS_ROUTER_MODULES = [
    [/^express(?:\/|$)/, 'express'],
    [/^(?:@koa\/router|koa-router)(?:\/|$)/, 'koa'],
    [/^fastify(?:\/|$)/, 'fastify'],
    [/^hono(?:\/|$)/, 'hono'],
];
const GO_ROUTER_MODULES = [
    [/^github\.com\/gin-gonic\/gin$/, 'gin'],
    [/^github\.com\/labstack\/echo(?:\/v\d+)?$/, 'echo'],
    [/^github\.com\/go-chi\/chi(?:\/v\d+)?$/, 'chi'],
    [/^github\.com\/gorilla\/mux$/, 'gorilla'],
    [/^github\.com\/gofiber\/fiber(?:\/v\d+)?$/, 'fiber'],
    [/^github\.com\/julienschmidt\/httprouter$/, 'httprouter'],
];

function frameworkOfModule(table, spec) {
    for (const [re, framework] of table) if (re.test(spec)) return framework;
    return null;
}

/** The project's own package, when its name is a router framework's. */
function projectJsFramework(index) {
    const cache = index._endpointsCache || (index._endpointsCache = {});
    if (cache.projectJsFramework !== undefined) return cache.projectJsFramework;
    let result = null;
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(index.root, 'package.json'), 'utf-8'));
        const framework = typeof pkg.name === 'string' ? frameworkOfModule(JS_ROUTER_MODULES, pkg.name) : null;
        const main = typeof pkg.main === 'string' ? pkg.main : 'index.js';
        const entry = path.resolve(index.root, main);
        const candidates = [entry, `${entry}.js`, path.join(entry, 'index.js')];
        const entryFile = candidates.find(file => index.files.has(file));
        if (framework && entryFile) result = { framework, entryFile };
    } catch {
        result = null;
    }
    cache.projectJsFramework = result;
    return result;
}

/** Whether a relative specifier names the project's own package entry
 *  (`require('..')` from test/, `require('../fastify')`). */
function ownPackageSpec(index, filePath, spec, own) {
    const target = path.resolve(path.dirname(filePath), spec);
    if (target === index.root) return true;
    return [target, `${target}.js`, `${target}.cjs`, `${target}.mjs`, path.join(target, 'index.js')]
        .includes(own.entryFile);
}

/**
 * The router framework a file's routes and mounts belong to, or null.
 * JS/TS: the framework modules it imports, or an import of the project's
 * own entry when the project is a framework. Go: the framework packages it
 * imports, or its own package's import path (go.mod module + directory).
 */
function routeFrameworkOfFile(index, filePath) {
    const cache = index._endpointsCache || (index._endpointsCache = {});
    if (!cache.frameworkByFile) cache.frameworkByFile = new Map();
    if (cache.frameworkByFile.has(filePath)) return cache.frameworkByFile.get(filePath);
    const entry = index.files.get(filePath);
    const lang = entry?.language;
    const found = new Set();
    if (lang === 'javascript' || lang === 'typescript' || lang === 'tsx') {
        const specs = new Set([...(entry.imports || []), ...(entry.importBindings || []).map(b => b.module)]);
        const own = projectJsFramework(index);
        for (const spec of specs) {
            if (typeof spec !== 'string') continue;
            const framework = frameworkOfModule(JS_ROUTER_MODULES, spec);
            if (framework) { found.add(framework); continue; }
            if (!own) continue;
            const rel = entry.moduleResolved?.[spec];
            if (rel ? path.resolve(index.root, rel) === own.entryFile
                : (spec.startsWith('.') && ownPackageSpec(index, filePath, spec, own))) found.add(own.framework);
        }
    } else if (lang === 'go') {
        for (const b of entry.importBindings || []) {
            const framework = b.module ? frameworkOfModule(GO_ROUTER_MODULES, b.module) : null;
            if (framework) found.add(framework);
        }
        if (found.size === 0) {
            const { findGoModule } = require('./imports');
            const mod = findGoModule(path.dirname(filePath));
            if (mod?.modulePath) {
                const rel = path.relative(mod.root, path.dirname(filePath)).split(path.sep).join('/');
                const own = frameworkOfModule(GO_ROUTER_MODULES, rel ? `${mod.modulePath}/${rel}` : mod.modulePath);
                if (own) found.add(own);
            }
        }
    }
    const framework = found.size === 1 ? [...found][0] : null;
    cache.frameworkByFile.set(filePath, framework);
    return framework;
}

/**
 * Build map of all server routes detected in the index.
 * Cached lazily on `index._endpointsCache.serverRoutes`.
 *
 * @param {object} index - ProjectIndex
 * @returns {Array<{method, path, normalizedPath, handler, file, line, framework, raw, classPrefix}>}
 */
function extractServerRoutes(index) {
    if (index._endpointsCache && index._endpointsCache.serverRoutes) {
        return index._endpointsCache.serverRoutes;
    }

    const routes = [];
    const sess = endpointsSession(index);
    const mountedPrefixes = collectProjectRouterMounts(index);
    // fix #373: declarative route tables (Django URLconfs, Starlette route
    // lists, DRF routers, aiohttp tables) and imperative registrations on
    // proven apps; their include/mount edges compose with the Python
    // router mounts.
    const mountFiles = pythonMountFiles(index);
    const routeLists = collectRouteLists(index, sess, new Set(mountFiles.map(([file]) => file)));
    if (!index._endpointsCache) index._endpointsCache = {};
    index._endpointsCache.routeContainers = routeLists.containers;
    const pythonMounts = collectPythonRouterMounts(index, sess, routeLists, mountFiles);
    const graph = buildCallRouterGraph(index, sess);
    index._endpointsCache.jsRouteGraph = graph;
    const rustNests = collectRustNestMounts(index);
    const actixScopes = collectActixScopes(index);
    // Python decorator receivers' frameworks, per file on first use (only
    // files with decorated symbols need them).
    const pythonReceiverFrameworksMemo = new Map();
    const pythonReceiverFrameworks = {
        get(filePath) {
            let receiverMap = pythonReceiverFrameworksMemo.get(filePath);
            if (receiverMap) return receiverMap;
            receiverMap = new Map();
            if (index.files.get(filePath)?.language === 'python') {
                for (const call of getCachedCalls(index, filePath) || []) {
                    if (!call.assignedTo) continue;
                    if (call.name === 'Flask' || call.name === 'Blueprint') {
                        receiverMap.set(call.assignedTo, 'flask');
                    } else if (call.name === 'FastAPI' || call.name === 'APIRouter') {
                        receiverMap.set(call.assignedTo, 'fastapi');
                    } else if (call.name === 'RouteTableDef' && isAiohttpWebRef(index.files.get(filePath), call)) {
                        // fix #373: `routes = web.RouteTableDef()` + `@routes.get(...)`
                        receiverMap.set(call.assignedTo, 'aiohttp');
                    }
                }
            }
            pythonReceiverFrameworksMemo.set(filePath, receiverMap);
            return receiverMap;
        },
    };

    // fix #373: routes declared in route lists / registered on apps, under
    // the composed prefixes of the container they flow into.
    const appKeyMemo = new Map();
    for (const r of routeLists.routes) {
        const entry = index.files.get(r.file);
        const prefixes = (r.containerKey && pythonMounts.get(r.containerKey)) || [''];
        const appKeys = servingAppKeys(pythonMounts.edges, r.containerKey, appKeyMemo);
        for (const prefix of prefixes) {
            // An empty route serves at its prefix exactly (Django `path("", v)`
            // under `docs/` is `/docs/`).
            const fullPath = r.path === '' ? (prefix || '/') : joinRoutePath(prefix, r.path, joinRuleOf(r.framework));
            routes.push(withAppKeys({
                method: r.method,
                path: fullPath,
                normalizedPath: normalizePath(fullPath, 'python'),
                handler: r.handler,
                file: entry?.relativePath || r.file,
                absoluteFile: r.file,
                line: r.line,
                framework: r.framework,
                ...(prefix && { mountPrefix: prefix }),
                ...(r.derived && { derived: r.derived }),
                raw: `${r.method} ${fullPath}`,
            }, appKeys));
        }
    }

    // 1) Decorator/annotation/attribute-based routes (NestJS, Flask/FastAPI, Spring, JAX-RS, Actix).
    //    Iterate symbols once and look at their decoratorsWithArgs/annotationsWithArgs/attributesWithArgs.
    //    Class-level prefixes are captured first then applied to methods inside the same class.
    //    A class may declare several prefixes (`@RequestMapping({"/a", "/b"})`):
    //    every method then serves under each of them.
    const classPrefixByFileClass = new Map(); // `${file}:${className}` -> prefix strings
    // Only decorated/annotated/attributed symbols can declare routes or
    // prefixes; the rest are skipped before any per-symbol work.
    const declares = sym => sym.decorators || sym.decoratorsWithArgs || sym.annotationsWithArgs ||
        sym.attributesWithArgs;
    for (const [, syms] of index.symbols) {
        for (const sym of syms) {
            if (!declares(sym)) continue;
            const fileEntry = index.files.get(sym.file);
            if (!fileEntry) continue;

            // CLASS-LEVEL prefix capture
            if (sym.type === 'class' || sym.type === 'interface') {
                const prefixes = collectClassPrefixes(sess, sym, fileEntry.language);
                if (prefixes.length > 0) {
                    classPrefixByFileClass.set(`${sym.file}:${sym.name}`, prefixes);
                }
            }
        }
    }
    // NestJS `app.setGlobalPrefix('api')` applies to every controller route.
    const nestGlobalPrefixes = [...new Set([...graph.globalPrefixes].filter(Boolean)
        .map(p => (p.startsWith('/') ? p : '/' + p)))].sort(codeUnitCompare);

    for (const [, syms] of index.symbols) {
        for (const sym of syms) {
            if (!declares(sym)) continue;
            const fileEntry = index.files.get(sym.file);
            if (!fileEntry) continue;
            const lang = fileEntry.language;
            // Only methods/functions are HTTP handlers; classes already produced prefixes above.
            if (sym.type !== 'function' && sym.type !== 'method' && !sym.isMethod) continue;

            // Resolve class prefixes if this is a method on a controller class
            const classPrefixes = (sym.className &&
                classPrefixByFileClass.get(`${sym.file}:${sym.className}`)) || [''];

            for (const classPrefix of classPrefixes) {
                const declRoutes = collectMethodRoutes(sess, sym, lang, classPrefix, fileEntry,
                    pythonReceiverFrameworks.get(sym.file));
                for (const r of declRoutes) {
                    // fix #282: FastAPI/Flask routers serve under their composed
                    // mount prefixes (APIRouter(prefix=) + include_router(prefix=)).
                    let prefixes = (lang === 'python' && r.receiver &&
                        pythonMounts.get(`${sym.file}:${r.receiver}`)) || [''];
                    const appKeys = lang === 'python' && r.receiver
                        ? servingAppKeys(pythonMounts.edges,
                            pythonDecoratorReceiverKey(index, sess, sym, r.receiver) || `${sym.file}:${r.receiver}`,
                            appKeyMemo)
                        : null;
                    if (r.framework === 'nestjs' && nestGlobalPrefixes.length > 0) {
                        prefixes = nestGlobalPrefixes;
                    }
                    if (r.framework === 'actix' && actixScopes && actixScopes.has(sym.name)) {
                        prefixes = actixScopes.get(sym.name);
                    }
                    for (const prefix of prefixes) {
                        const fullPath = prefix ? joinRoutePath(prefix, r.path) : r.path;
                        routes.push(withAppKeys({
                            method: r.method,
                            path: fullPath,
                            normalizedPath: normalizePath(fullPath, routeSyntax(lang)),
                            handler: sym.name,
                            file: sym.relativePath || sym.file,
                            absoluteFile: sym.file,
                            line: sym.startLine,
                            framework: r.framework,
                            classPrefix: classPrefix || undefined,
                            ...(prefix && { mountPrefix: prefix }),
                            ...(r.caseInsensitive && { caseInsensitive: true }),
                            raw: r.raw || `${r.method} ${fullPath}`,
                        }, appKeys));
                    }
                }
            }
        }
    }

    // 2) Call-pattern routes (Express/Fastify/Koa/Hono/Gin/Echo/Chi/Fiber, axum, http).
    //    Iterate calls once per file via the call cache.
    for (const [filePath, fileEntry] of index.files) {
        const lang = fileEntry.language;
        // Languages without call-registered route forms (Python, Java, C,
        // C++: decorators/annotations and route tables are handled above)
        // produce nothing in this loop; skip their records.
        if (!CALL_REGISTERED_LANGS.has(lang)) continue;
        const calls = getCachedCalls(index, filePath);
        if (!calls || calls.length === 0) continue;
        const routerReceivers = collectRouterReceivers(calls, lang);
        // The framework the file's imports prove (fix #383): its label, its
        // join rule, and its parameter syntax. Read on the file's first
        // route or mount.
        let fileFrameworkMemo;
        const fileFramework = () => (fileFrameworkMemo === undefined
            ? (fileFrameworkMemo = routeFrameworkOfFile(index, filePath)) : fileFrameworkMemo);
        const fileRule = () => joinRuleOf(fileFramework());
        const syntax = routeSyntax(lang);

        const groupPrefixes = new Map();
        for (const call of calls) {
            if (!/^(Group|group|MapGroup)$/.test(call.name) ||
                !call.assignedTo || !call.firstStringArg ||
                !routerReceivers.has(call.assignedTo)) continue;
            const parent = groupPrefixes.get(call.receiver) || '';
            groupPrefixes.set(call.assignedTo, joinRoutePath(parent, call.firstStringArg, fileRule()));
        }

        // fix #366: chained registrations (`app.get(a, h).post(b, h)`)
        // register on the router the chain started from. Records carry the
        // inner call's span; inner calls end first.
        let byLine = null; // line -> records (handler lookup), built on first route
        const routeSpans = new Map(); // chained-call span -> router prefixes
        const walked = graph.walked.has(filePath);
        const callRegistered = lang === 'javascript' || lang === 'typescript' || lang === 'tsx' || lang === 'go';
        const plugins = callRegistered && lang !== 'go' ? inlinePluginMounts(calls, fileEntry) : null;
        const ordered = callRegistered && calls.some(c => c.receiverCallStart != null)
            ? [...calls].sort((a, b) => (a.callEnd ?? Infinity) - (b.callEnd ?? Infinity)) : calls;
        // Mount prefixes of the router a route call registers on: the
        // scope-aware graph when it composed a prefix, else inline plugin
        // records, else the chain root's, else the name-keyed mounts (a
        // mount the graph could not model is kept rather than dropped).
        const routerPrefixesOf = (call) => {
            const site = walked && call.callStart != null
                ? graph.sites.get(`${filePath}:${call.callStart}:${call.callEnd}`) : null;
            const graphPrefixes = site ? graph.prefixes.get(site.key) : null;
            if (graphPrefixes && graphPrefixes.some(Boolean)) return graphPrefixes;
            if (plugins) {
                const list = registerPrefixesFor(plugins, call.receiver, call.callStart, call.line, 0, fileRule());
                if (list.some(Boolean)) return [...new Set(list.map(p => (p && !p.startsWith('/') ? '/' + p : p)))];
            }
            const chained = chainedPrefixes(call, routeSpans);
            if (chained) return chained;
            if (rustNests && lang === 'rust' && call.enclosingFunction) {
                const nested = rustNests.get(`${filePath}:${call.enclosingFunction.startLine}`);
                if (nested && nested.some(Boolean)) return nested;
            }
            return mountedPrefixes.get(`${filePath}:${call.receiver || ''}`) ||
                (groupPrefixes.has(call.receiver) ? [groupPrefixes.get(call.receiver)] : ['']);
        };
        for (const call of ordered) {
            // fix #366: `server.route({ method, url|path, handler })` - the
            // full-declaration form (Fastify, hapi) on a router receiver.
            if (call.requestConfig && call.name === 'route' && call.isMethod &&
                (call.receiver ? routerReceivers.has(call.receiver)
                    : JS_SERVER_FACTORY_CALL.test(call.receiverCall || '')) &&
                isPathShaped(call.requestConfig.url)) {
                const cfg = call.requestConfig;
                const receiverKey = `${filePath}:${call.receiver}`;
                for (const prefix of mountedPrefixes.get(receiverKey) || ['']) {
                    const fullPath = prefix ? joinRoutePath(prefix, cfg.url, fileRule()) : cfg.url;
                    routes.push({
                        method: cfg.method || 'ALL',
                        path: fullPath,
                        normalizedPath: normalizePath(fullPath, syntax),
                        handler: cfg.handler || '<anonymous>',
                        file: fileEntry.relativePath || filePath,
                        absoluteFile: filePath,
                        line: call.line,
                        framework: fileFramework() || 'route-config',
                        ...(prefix && { mountPrefix: prefix }),
                        raw: `${cfg.method || 'ALL'} ${fullPath}`,
                    });
                }
                continue;
            }
            // fix #366: the router graph resolves the site's receiver to a
            // router VALUE (scope-aware), proves it is a router, and folds a
            // non-literal route path.
            if (!call.isMethod && !call.receiver) continue;
            const site = walked && call.callStart != null
                ? graph.sites.get(`${filePath}:${call.callStart}:${call.callEnd}`) : null;
            // fix #383: `Handle(method, path, h)` / `Add` / `Match` take the
            // method first; the parser records the path it names.
            const routeCall = call.methodFirstRoute
                ? { ...call, firstStringArg: call.methodFirstRoute.path, firstStringArgInterp: !!call.methodFirstRoute.interp }
                : (!call.firstStringArg && site?.path != null ? { ...call, firstStringArg: site.path } : call);
            let r = matchCallPatternRoute(routeCall, lang, routerReceivers);
            // A method-first registration (`e.Add(http.MethodGet, "/x", h)`)
            // on a router receiver: the method and path settle the route.
            if (!r && call.methodFirstRoute && call.receiver && (routerReceivers.has(call.receiver) ||
                (SERVER_RECEIVER_PATTERNS[lang] || []).some(p => p.receiverPattern.test(call.receiver)) ||
                (site && graph.evidence.has(site.key)) || routerTypedReceiver(call, lang))) {
                r = { method: 'ALL', path: routeCall.firstStringArg, framework: 'go-http' };
            }
            if (!r && routeCall.firstStringArg && PROVEN_ROUTE_NAME.test(call.name) &&
                ((site && graph.evidence.has(site.key)) || routerTypedReceiver(call, lang) ||
                    chainedOnRoute(call, routeSpans) || (plugins && pluginFor(plugins, call.receiver, call.callStart, call.line)))) {
                r = matchProvenRouterRoute(routeCall, lang);
            }
            if (!r) {
                // `new Hono().use(mw).get(...)`: middleware registration on
                // a router returns the router for further chaining.
                if (call.name === 'use' && call.callStart != null && (routerTypedReceiver(call, lang) ||
                    (call.receiver && routerReceivers.has(call.receiver)) || chainedOnRoute(call, routeSpans))) {
                    routeSpans.set(`${call.callStart}:${call.callEnd}`, chainedPrefixes(call, routeSpans) ||
                        routerPrefixesOf(call));
                }
                continue;
            }

            // The handler: the parser's reading of the registration's
            // handler argument (fix #383), else a callback reference on the
            // same line in the same scope (a reference inside an inline
            // handler's body is not the handler).
            let handlerName = null;
            if (Array.isArray(call.handlerArgs) && call.handlerArgs.length > 0) {
                // Echo takes the handler first and middleware after it;
                // the other routers take middleware first, handler last.
                const pick = fileFramework() === 'echo' ? call.handlerArgs[0]
                    : call.handlerArgs[call.handlerArgs.length - 1];
                handlerName = pick || '<anonymous>';
            }
            if (!handlerName && call.methodFirstRoute) handlerName = '<anonymous>';
            if (!handlerName) {
                if (!byLine) {
                    byLine = new Map();
                    for (const c of calls) {
                        const list = byLine.get(c.line);
                        if (list) list.push(c); else byLine.set(c.line, [c]);
                    }
                }
                handlerName = findHandlerCallback(byLine.get(call.line) || [], call.line, call) || '<anonymous>';
            }
            // axum `.route(path, get(h).post(h2))`: one route per method the
            // method router serves (fix #383).
            const variants = Array.isArray(call.methodRouter) && call.methodRouter.length > 0
                ? call.methodRouter.map(m => ({ method: m.method, handler: m.handler || '<anonymous>' }))
                : call.methodFirstRoute
                    ? call.methodFirstRoute.methods.map(method => ({ method, handler: handlerName }))
                    : [{ method: r.method, handler: handlerName }];

            const prefixes = routerPrefixesOf(call);
            if (call.callStart != null && call.isMethod) routeSpans.set(`${call.callStart}:${call.callEnd}`, prefixes);
            for (const prefix of prefixes) {
                const fullPath = prefix ? joinRoutePath(prefix, r.path, fileRule()) : r.path;
                for (const variant of variants) {
                    const route = {
                        method: variant.method,
                        path: fullPath,
                        normalizedPath: normalizePath(fullPath, syntax),
                        handler: variant.handler,
                        file: fileEntry.relativePath || filePath,
                        absoluteFile: filePath,
                        line: call.line,
                        framework: fileFramework() || r.framework,
                        ...(prefix && { mountPrefix: prefix }),
                        raw: `${variant.method} ${fullPath}`,
                    };
                    // The router value it registers on (fix #397), for
                    // in-process clients built from an app: the graph's key
                    // when the file was walked, else computed on demand.
                    if (JS_LANGS.has(lang) && call.callStart != null) {
                        Object.defineProperty(route, 'jsRouterSite', {
                            value: { key: site?.key || null, start: call.callStart, end: call.callEnd },
                            enumerable: false,
                        });
                    }
                    routes.push(route);
                }
            }
        }
    }

    // 3) Next.js file-based routes — only scan if `pages/` or `app/` exists at root.
    const nextRoutes = extractNextjsRoutes(index);
    for (const r of nextRoutes) routes.push(r);

    // Sort deterministically (file, line, method, path)
    routes.sort((a, b) => {
        if (a.file !== b.file) return codeUnitCompare(a.file, b.file);
        if (a.line !== b.line) return a.line - b.line;
        if (a.method !== b.method) return codeUnitCompare(a.method, b.method);
        return codeUnitCompare(a.path, b.path);
    });

    // Cache it
    if (!index._endpointsCache) index._endpointsCache = {};
    index._endpointsCache.serverRoutes = routes;

    return routes;
}

/** A call record whose callee is aiohttp.web's (`web.X()` on the imported
 *  module, or a bare name imported from it). */
function isAiohttpWebRef(entry, call) {
    const bindings = entry?.importBindings || [];
    if (call.isMethod) {
        return !!call.receiver && bindings.some(b => (b.alias || b.name) === call.receiver &&
            ((b.module === 'aiohttp' && b.name === 'web') || (b.kind === 'import' && b.module === 'aiohttp.web')));
    }
    return bindings.some(b => (b.alias || b.name) === call.name && b.module === 'aiohttp.web');
}

/** One AST session per endpoints extraction (trees parsed once). */
function endpointsSession(index) {
    if (!index._endpointsCache) index._endpointsCache = {};
    if (!index._endpointsCache.astSession) {
        index._endpointsCache.astSession = new routeGraph.AstSession(index);
    }
    return index._endpointsCache.astSession;
}

// Mount/group calls that make a JS/Go file worth walking for the router graph.
const JS_MOUNT_CALLS = new Set(['use', 'route', 'register', 'basePath', 'setGlobalPrefix']);
const GO_MOUNT_CALLS = new Set(['Group', 'Route', 'Mount', 'Subrouter', 'PathPrefix', 'StripPrefix']);

/**
 * Router composition graph for call-registered frameworks (fix #366).
 * Seeds are the JS/TS/Go files whose call cache shows a mount/group call;
 * files reached through mount targets, router-returning functions and
 * router parameters are walked on demand.
 */
function buildCallRouterGraph(index, sess) {
    const seeds = [];
    let routerParamNames;
    for (const [filePath, entry] of index.files) {
        const lang = entry.language;
        const isJs = lang === 'javascript' || lang === 'typescript' || lang === 'tsx';
        if (!isJs && lang !== 'go') continue;
        if (lang === 'go' && routerParamNames === undefined) routerParamNames = goRouterParamFunctionNames(index);
        const calls = getCachedCalls(index, filePath) || [];
        if (needsRouterGraph(entry, calls, lang, isJs, routerParamNames)) seeds.push(filePath);
    }
    const graph = routeGraph.buildRouteGraph(index, sess, seeds, file => getCachedCalls(index, file),
        routerParamNames || new Set(), file => joinRuleOf(routeFrameworkOfFile(index, file)));
    graph.prefixes = rootPrefixes(composeMountPrefixes(graph.edges, graph.ctor, graph.ctorJoin));
    return graph;
}

/**
 * Whether a file's mounts need the AST router graph. Literal-prefix mounts
 * of unambiguous router names compose from the call records (name-keyed
 * mounts, Go literal groups, inline plugin registers); the graph is for
 * non-literal prefixes, mounted call results (`require('./r')`,
 * `adminRouter()`), closures (`Route("/x", func(r) ...)`), routers passed to
 * router-typed parameters, and names declared more than once.
 */
function needsRouterGraph(entry, calls, lang, isJs, routerParamNames) {
    let ambiguous = null;
    let requireLines = null;
    for (const c of calls) {
        if (isJs) {
            if (c.isConstructor && c.prefixOption) return true; // new Router({ prefix })
            if (!c.isMethod || !JS_MOUNT_CALLS.has(c.name)) continue;
            if (c.name === 'register') {
                const m = c.registerMount;
                // A prefix-less register composes nothing new.
                if (m && (m.prefixDynamic || (m.prefix != null && (!!m.pluginRef ||
                    (!!m.pluginName && !sameFilePlugin(entry, m.pluginName, c)))))) return true;
                continue;
            }
            if (c.name === 'basePath' || c.name === 'setGlobalPrefix') return true;
            const args = c.mountArgs;
            if (!args || args.length < 2) continue;
            const targets = args.slice(1);
            if (!targets.some(a => a !== 'fn' && a !== '""')) continue; // inline handlers only
            if (!c.firstStringArg && args[0] !== 'fn') return true;    // non-literal prefix
            if (!requireLines) {
                requireLines = new Set(calls.filter(r => r.name === 'require').map(r => r.line));
            }
            if (c.name === 'route' && targets.includes('()')) return true;
            if (requireLines.has(c.line)) return true;
            if (!ambiguous) ambiguous = ambiguousRouterNames(calls, entry.language);
            if (targets.some(a => ambiguous.has(a))) return true;
            continue;
        }
        // Go
        if (c.name === 'Group' && c.receiver) {
            if (!c.firstStringArg || !c.assignedTo) return true;
            if (!ambiguous) ambiguous = ambiguousRouterNames(calls, 'go');
            if (ambiguous.has(c.assignedTo)) return true;
            continue;
        }
        if (c.receiver && GO_MOUNT_CALLS.has(c.name)) return true;
        if (routerParamNames && routerParamNames.has(c.name) && (c.argCount == null || c.argCount > 0)) return true;
    }
    return false;
}


/** Go function/method names with a router-typed parameter (index
 *  structured parameters; no parse). Null when the project has no Go. */
function goRouterParamFunctionNames(index) {
    // Candidates: functions with a router-typed parameter. Only those whose
    // body registers on that parameter (route, group, mount), or hands it
    // to another such function, receive routers worth composing - a helper
    // taking `*Engine` to build a test context does not.
    const candidates = [];
    for (const [name, defs] of index.symbols) {
        for (const d of defs) {
            if (!d.paramsStructured || !d.file.endsWith('.go')) continue;
            const params = d.paramsStructured.filter(p => routeGraph.isGoRouterTypeText(p.type)).map(p => p.name);
            if (params.length > 0) candidates.push({ name, def: d, params, body: null });
        }
    }
    if (candidates.length === 0) return null;
    const names = new Set();
    let changed = true;
    while (changed) {
        changed = false;
        for (const cand of candidates) {
            if (names.has(cand.name)) continue;
            if (!cand.body) {
                const calls = getCachedCalls(index, cand.def.file) || [];
                cand.body = calls.filter(c => c.line >= cand.def.startLine && c.line <= cand.def.endLine);
            }
            if (cand.body.some(c => (c.receiver && cand.params.includes(c.receiver) &&
                GO_REGISTRATION_CALL.test(c.name)) || names.has(c.name))) {
                names.add(cand.name);
                changed = true;
            }
        }
    }
    return names.size > 0 ? names : null;
}
const GO_REGISTRATION_CALL = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Handle|HandleFunc|Get|Post|Put|Delete|Patch|Head|Options|Connect|Trace|All|Method|MethodFunc|Group|Route|Mount|With|Use|PathPrefix|Subrouter|Static|StaticFS|StaticFile)$/;

/**
 * axum `.nest("/api", api::routes())` (fix #366): the routes a function
 * builds serve under the prefixes of every nest that mounts its result.
 * Composed over functions from the call records: a nest call's argument
 * calls name the mounted functions, its enclosing function is the mounter.
 * Returns Map `${file}:${fnStartLine}` -> composed prefixes, or null.
 */
function collectRustNestMounts(index) {
    const edges = new Map();
    let fnByName = null;
    for (const [filePath, entry] of index.files) {
        if (entry.language !== 'rust') continue;
        const calls = getCachedCalls(index, filePath) || [];
        for (const nest of calls) {
            if (nest.name !== 'nest' || !nest.isMethod || !nest.firstStringArg || nest.callStart == null ||
                !nest.enclosingFunction) continue;
            const argsFrom = nest.receiverCallEnd != null ? nest.receiverCallEnd : nest.callStart;
            const mounter = `${filePath}:${nest.enclosingFunction.startLine}`;
            for (const arg of calls) {
                if (arg === nest || arg.callStart == null || arg.callStart < argsFrom ||
                    arg.callEnd > nest.callEnd || arg.name === 'nest') continue;
                if (!fnByName) fnByName = rustFunctionsByName(index);
                const target = resolveRustFunction(fnByName, arg, filePath);
                if (!target) continue;
                const key = `${target.file}:${target.startLine}`;
                const list = edges.get(key) || [];
                list.push({ mounterKey: mounter, prefix: nest.firstStringArg });
                edges.set(key, list);
            }
        }
    }
    return edges.size > 0 ? rootPrefixes(composeMountPrefixes(edges, new Map())) : null;
}

/**
 * actix-web `web::scope("/api").service(handler)` (fix #366): an attribute
 * route handler registered on a scope serves under the scope's prefix, and
 * a scope registered inside another scope's `.service(...)` composes. From
 * the call records: `serviceArg` names the handler, receiver-call spans walk
 * the builder chain to its `scope(...)` root. Returns Map handler name ->
 * prefixes (names registered with conflicting chains in different files
 * keep every prefix), or null.
 */
function collectActixScopes(index) {
    let out = null;
    for (const [filePath, entry] of index.files) {
        if (entry.language !== 'rust') continue;
        const calls = getCachedCalls(index, filePath) || [];
        const services = calls.filter(c => c.name === 'service' && c.isMethod && c.callStart != null);
        if (!services.some(c => c.serviceArg)) continue;
        const bySpan = new Map();
        for (const c of calls) if (c.callStart != null) bySpan.set(`${c.callStart}:${c.callEnd}`, c);
        const chainScope = (rec) => {
            let r = rec;
            let guard = 0;
            while (r && guard++ < 64) {
                if (r.name === 'scope' && r.firstStringArg != null) return { scope: r.firstStringArg, root: r };
                if (r.receiverCallStart == null) return { scope: '', root: r };
                r = bySpan.get(`${r.receiverCallStart}:${r.receiverCallEnd}`);
            }
            return { scope: '', root: rec };
        };
        const enclosingService = (rec) => {
            let best = null;
            for (const s2 of services) {
                const argsFrom = s2.receiverCallEnd != null ? s2.receiverCallEnd : s2.callStart;
                if (s2 === rec || rec.callStart < argsFrom || rec.callEnd > s2.callEnd) continue;
                if (!best || s2.callStart > best.callStart || (s2.callStart === best.callStart && s2.callEnd < best.callEnd)) best = s2;
            }
            return best;
        };
        const prefixOf = (rec, depth) => {
            const { scope, root } = chainScope(rec);
            const outer = depth < 16 ? enclosingService(root) : null;
            return joinPrefixes(outer ? prefixOf(outer, depth + 1) : '', scope);
        };
        for (const svc of services) {
            if (!svc.serviceArg) continue;
            const prefix = prefixOf(svc, 0);
            if (!prefix) continue;
            if (!out) out = new Map();
            const list = out.get(svc.serviceArg) || [];
            if (!list.includes(prefix)) list.push(prefix);
            out.set(svc.serviceArg, list);
        }
    }
    if (out) for (const [k, list] of out) out.set(k, [...new Set(list.map(p => (p.startsWith('/') ? p : '/' + p)))].sort(codeUnitCompare));
    return out;
}

function rustFunctionsByName(index) {
    const map = new Map();
    for (const [name, defs] of index.symbols) {
        const fns = defs.filter(d => d.type === 'function' && !d.className && d.file.endsWith('.rs'));
        if (fns.length > 0) map.set(name, fns);
    }
    return map;
}

/** The function a Rust call names: same file first, then the module a path
 *  call's qualifier names (`api::routes` -> api.rs / api/mod.rs), else a
 *  unique definition. */
function resolveRustFunction(fnByName, call, filePath) {
    const defs = fnByName.get(call.name);
    if (!defs) return null;
    if (!call.isPathCall && !call.isMethod) {
        const local = defs.filter(d => d.file === filePath);
        if (local.length === 1) return local[0];
    }
    if (call.isPathCall && call.receiver) {
        const mod = String(call.receiver).split('::').pop();
        const inMod = defs.filter(d => path.basename(d.file, '.rs') === mod ||
            (path.basename(d.file) === 'mod.rs' && path.basename(path.dirname(d.file)) === mod));
        if (inMod.length === 1) return inMod[0];
    }
    return defs.length === 1 ? defs[0] : null;
}

/** Router names assigned more than once in a file (`const router =
 *  express.Router()` in several test blocks): name-keyed composition would
 *  conflate them, so they need the scope-aware graph. */
function ambiguousRouterNames(calls, lang) {
    const seen = new Set();
    const out = new Set();
    // A receiver name whose type evidence points at different declarations
    // (`var router = new Router()` in several blocks) is declared twice.
    const declOf = new Map();
    for (const c of calls) {
        const ev = c.receiver && c.receiverTypeEvidence;
        if (ev && ev.start != null) {
            const prev = declOf.get(c.receiver);
            if (prev == null) declOf.set(c.receiver, ev.start);
            else if (prev !== ev.start) out.add(c.receiver);
        }
        if (!c.assignedTo) continue;
        const producer = lang === 'go'
            ? (c.name === 'Group' || c.name === 'NewRouter' || c.name === 'New' || c.name === 'Default' ||
                c.name === 'NewServeMux' || c.name === 'MapGroup')
            : (/^(Router|express|fastify|Fastify|Koa|Hono)$/.test(c.name) || c.name === 'basePath');
        if (!producer) continue;
        if (seen.has(c.assignedTo)) out.add(c.assignedTo);
        seen.add(c.assignedTo);
    }
    return out;
}

/** Inline plugin mounts of a file (`x.register((instance) => {...},
 *  { prefix })`), from the parse-time `registerMount` records. */
function inlinePluginMounts(calls, fileEntry) {
    let list = null;
    for (const c of calls) {
        const m = c.registerMount;
        if (!m || m.prefixDynamic) continue;
        let span = null;
        if (m.plugin) {
            span = { start: m.plugin.start, end: m.plugin.end, param: m.plugin.param };
        } else if (m.pluginName) {
            const fn = sameFilePlugin(fileEntry, m.pluginName, c);
            const param = fn?.paramsStructured?.[0]?.name;
            if (fn && param) span = { startLine: fn.startLine, endLine: fn.endLine, param };
        }
        if (!span) continue;
        (list || (list = [])).push({ ...span, prefix: m.prefix || '', receiver: c.receiver || null,
            at: c.callStart, atLine: c.line });
    }
    return list;
}

/** The same-file function a named plugin denotes: the single candidate
 *  visible from the register call (defined inside the call's enclosing
 *  function, else at top level). */
function sameFilePlugin(fileEntry, name, call = null) {
    const fns = (fileEntry?.symbols || []).filter(sym => sym.name === name && sym.type === 'function' &&
        !sym.className);
    if (fns.length <= 1 || !call) return fns.length === 1 ? fns[0] : null;
    const enc = call.enclosingFunction;
    const inside = enc?.endLine
        ? fns.filter(fn => fn.startLine >= enc.startLine && fn.endLine <= enc.endLine) : [];
    return inside.length === 1 ? inside[0] : null;
}

/** Mounts of the innermost plugin function whose router parameter is
 *  `receiver` at a call site (one function registered twice mounts twice). */
function pluginFor(plugins, receiver, pos, line) {
    if (!receiver) return null;
    let best = null;
    let bestRank = -1;
    for (const p of plugins) {
        if (p.param !== receiver) continue;
        const inside = p.start != null
            ? (pos != null && pos >= p.start && pos < p.end)
            : (line != null && line >= p.startLine && line <= p.endLine);
        if (!inside) continue;
        const rank = p.start != null ? p.start : p.startLine;
        if (rank > bestRank) { best = [p]; bestRank = rank; } else if (rank === bestRank) best.push(p);
    }
    return best;
}

/** Composed plugin prefixes for a router receiver at a call site. */
function registerPrefixesFor(plugins, receiver, pos, line, depth, rule = 'path') {
    const mounts = depth < 16 ? pluginFor(plugins, receiver, pos, line) : null;
    if (!mounts) return [''];
    const out = new Set();
    for (const p of mounts) {
        for (const parent of registerPrefixesFor(plugins, p.receiver, p.at, p.atLine, depth + 1, rule)) {
            out.add(joinPrefixes(parent, p.prefix, rule));
        }
    }
    return [...out].sort(codeUnitCompare);
}

/** A call chained on a detected route registration (`.get(...).post(...)`):
 *  JS route methods return the router. Records are visited by end offset,
 *  so a chain's inner call is classified before the outer one. */
function chainedOnRoute(call, routeSpans) {
    if (!call.receiverCallIsMethod || call.receiverCallStart == null || call.receiver) return false;
    return routeSpans.has(`${call.receiverCallStart}:${call.receiverCallEnd}`);
}

/** Prefixes of the router a chained call registers on (its chain root's). */
function chainedPrefixes(call, routeSpans) {
    if (!call.receiverCallIsMethod || call.receiverCallStart == null || call.receiver) return null;
    return routeSpans.get(`${call.receiverCallStart}:${call.receiverCallEnd}`) || null;
}

// Router receiver types by package (Go call records carry the parser's
// receiverType + receiverTypeQualifier evidence).
function routerTypedReceiver(call, lang) {
    if (!call.receiverType) return false;
    if (lang === 'go') {
        return !!call.receiverTypeQualifier &&
            routeGraph.GO_ROUTER_TYPES.has(`${call.receiverTypeQualifier}.${call.receiverType}`);
    }
    // JS/TS: a receiver constructed from / annotated with a router class.
    return (lang === 'javascript' || lang === 'typescript' || lang === 'tsx') &&
        call.receiverTypeSource !== 'guess' && JS_ROUTER_TYPE_NAMES.has(call.receiverType);
}
const JS_ROUTER_TYPE_NAMES = new Set(['Hono', 'Router', 'Koa', 'FastifyInstance', 'Express', 'OpenAPIHono']);

const PROVEN_ROUTE_NAME = /^(get|post|put|delete|patch|options|head|all|GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Handle|HandleFunc|Get|Post|Put|Delete|Patch|Head|Options|Connect|Trace|All)$/;
const PROVEN_JS_VERBS = /^(get|post|put|delete|patch|options|head|all)$/;
const PROVEN_GO_VERBS = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Handle|HandleFunc|Get|Post|Put|Delete|Patch|Head|Options|Connect|Trace|All)$/;

/** Route registration on a receiver PROVEN to be a router (factory,
 *  group, typed parameter, mounted value), whatever its variable name. */
function matchProvenRouterRoute(call, lang) {
    if (!call.firstStringArg || typeof call.argCount !== 'number' || call.argCount < 2) return null;
    const isJs = lang === 'javascript' || lang === 'typescript' || lang === 'tsx';
    if (isJs && PROVEN_JS_VERBS.test(call.name)) {
        return { method: call.name === 'all' ? 'ALL' : call.name.toUpperCase(),
            path: call.firstStringArg, framework: 'express' };
    }
    if (lang === 'go' && PROVEN_GO_VERBS.test(call.name)) {
        // Go route patterns are rooted; a non-path first argument is a method
        // (`Handle("GET", ...)`) or something else entirely.
        if (!call.firstStringArg.startsWith('/')) return null;
        const upper = call.name.toUpperCase();
        const method = (upper === 'ANY' || upper === 'ALL' || upper === 'HANDLE' || upper === 'HANDLEFUNC')
            ? 'ALL' : upper;
        return { method, path: call.firstStringArg, framework: 'go-http' };
    }
    return null;
}

/** Return the list of class-level path prefixes for a class symbol. */
function collectClassPrefixes(sess, sym, lang) {
    const prefixes = [];
    // JS/TS decorators
    if ((lang === 'javascript' || lang === 'typescript' || lang === 'tsx') && sym.decoratorsWithArgs) {
        for (const d of sym.decoratorsWithArgs) {
            if (PREFIX_DECORATORS.has(d.name) && d.firstStringArg != null) {
                prefixes.push(d.firstStringArg);
            }
        }
    }
    // Java annotations: @RequestMapping("/api"), @Path("/api"), constants,
    // arrays (fix #366)
    if (lang === 'java' && sym.annotationsWithArgs) {
        for (const a of sym.annotationsWithArgs) {
            if (!PREFIX_ANNOTATIONS.has(a.name)) continue;
            for (const p of jvmAnnotationPaths(sess, sym, a, 'java')) if (p) prefixes.push(p);
        }
    }
    if (lang === 'csharp' && sym.attributesWithArgs) {
        for (const attribute of sym.attributesWithArgs) {
            if (!CSHARP_PREFIX_ATTRIBUTES.has(attribute.name)) continue;
            for (const p of jvmAnnotationPaths(sess, sym, attribute, 'csharp')) if (p) prefixes.push(p);
        }
    }
    return [...new Set(prefixes)];
}

/** Enclosing class declaration node of a Java/C# symbol. */
function jvmClassNode(sess, sym) {
    const name = sym.className || ((sym.type === 'class' || sym.type === 'interface') ? sym.name : null);
    if (!name) return null;
    const root = sess.root(sym.file);
    if (!root) return null;
    const nodes = routeGraph.findClassDecls(root, name);
    return nodes.find(n => n.startPosition.row + 1 <= sym.startLine &&
        n.endPosition.row + 1 >= sym.startLine) || (nodes.length === 1 ? nodes[0] : null);
}

/**
 * Path arguments of a Java annotation / C# attribute (fix #366). Literal
 * arguments come straight from the parser record; constants, concatenation
 * and arrays are folded from a parse of the argument source, resolving
 * identifiers against the declaring class and project classes. Returns []
 * when the annotation carries no path.
 */
function jvmAnnotationPaths(sess, sym, a, lang) {
    if (lang === 'csharp') {
        if (a.arg != null) return [a.arg];
        if (!a.args) return [];
        const root = sess.snippet('csharp', `[__A(${a.args})] class __X {}`);
        const list = root && findFirst(root, n => n.type === 'attribute_argument_list');
        if (!list) return [];
        for (const arg of routeGraph.namedChildren(list)) {
            if (arg.type !== 'attribute_argument') continue;
            // Named properties (`Name = "x"`, `Order = 1`) are not the template.
            const kids = routeGraph.namedChildren(arg);
            if (kids.length !== 1 || /^\s*\w+\s*[=:]/.test(arg.text)) continue;
            const ctx = { lang: 'csharp', classNode: jvmClassNode(sess, sym) };
            return [routeGraph.evalString(sess, sym.file, kids[0], 0, ctx)];
        }
        return [];
    }
    const args = typeof a.args === 'string' ? a.args.trim() : '';
    if (!args) return a.firstStringArg != null ? [a.firstStringArg] : [];
    if (/^"(?:[^"\\]|\\.)*"$/.test(args)) return [a.firstStringArg ?? args.slice(1, -1)];
    const root = sess.snippet('java', `@__A(${args}) class __X {}`);
    const list = root && findFirst(root, n => n.type === 'annotation_argument_list');
    if (!list) return a.firstStringArg != null ? [a.firstStringArg] : [];
    let valueNode = null;
    for (const child of routeGraph.namedChildren(list)) {
        if (child.type.includes('comment')) continue;
        if (child.type === 'element_value_pair') {
            const key = child.childForFieldName('key')?.text;
            if (key === 'value' || key === 'path') { valueNode = child.childForFieldName('value'); break; }
            continue;
        }
        valueNode = child;
        break;
    }
    if (!valueNode) return [];
    const items = valueNode.type === 'element_value_array_initializer'
        ? routeGraph.namedChildren(valueNode).filter(c => !c.type.includes('comment'))
        : [valueNode];
    const ctx = { lang: 'java', classNode: jvmClassNode(sess, sym) };
    return items.map(item => routeGraph.evalString(sess, sym.file, item, 0, ctx));
}

function findFirst(root, pred) {
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (pred(node)) return node;
        for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push(node.namedChild(i));
    }
    return null;
}

/** ASP.NET route template: `[controller]`/`[action]` tokens, `/` and `~/`
 *  templates override the controller prefix, rooted at '/'. */
function aspnetRoutePath(classPrefix, template, sym) {
    const t = template || '';
    let p = /^~?\//.test(t) ? t.replace(/^~/, '') : joinRoutePath(classPrefix, t);
    const controller = String(sym.className || '').replace(/Controller$/, '');
    p = p.replace(/\[controller\]/gi, controller).replace(/\[action\]/gi, sym.name);
    if (!p.startsWith('/')) p = '/' + p;
    return p;
}

/**
 * Return zero or more route objects {method, path, framework, raw} for a method/function symbol.
 */
function collectMethodRoutes(sess, sym, lang, classPrefix, fileEntry = null,
    pythonReceiverFramework = null) {
    const out = [];

    // ── JS/TS decorators (NestJS) ────────────────────────────────────
    if ((lang === 'javascript' || lang === 'typescript' || lang === 'tsx') && sym.decoratorsWithArgs) {
        for (const d of sym.decoratorsWithArgs) {
            const method = METHOD_DECORATORS[d.name];
            if (method == null && d.name !== 'RequestMapping') continue;
            // Allow no-arg form: @Get() — defaults to ''
            const sub = d.firstStringArg || '';
            const fullPath = joinRoutePath(classPrefix, sub);
            out.push({
                method: method || 'GET',
                path: fullPath || '/',
                framework: 'nestjs',
            });
        }
    }

    // ── Python decorators (Flask, FastAPI) ───────────────────────────
    if (lang === 'python' && sym.decorators) {
        for (const decRaw of sym.decorators) {
            // Decorator text in Python is the full source: "app.route('/users', methods=['GET'])"
            for (const r of parsePythonDecoratorFull(decRaw, fileEntry, pythonReceiverFramework, sess)) {
                out.push({
                    method: r.method,
                    path: r.path,
                    framework: r.framework,
                    // fix #282: the decorator's receiver variable keys the
                    // composed mount-prefix lookup in extractServerRoutes.
                    receiver: r.receiver,
                });
            }
        }
    }

    // ── Java annotations (Spring, JAX-RS) ────────────────────────────
    if (lang === 'java' && sym.annotationsWithArgs) {
        // Track JAX-RS @Path + @GET pattern: @Path supplies path, @GET supplies method.
        let jaxrsPath = null;
        const jaxrsMethods = [];
        const subPaths = a => {
            const paths = jvmAnnotationPaths(sess, sym, a, 'java');
            return paths.length > 0 ? paths : [''];
        };
        for (const a of sym.annotationsWithArgs) {
            const meth = METHOD_DECORATORS[a.name];
            if (a.name === 'Path' && a.args != null) {
                jaxrsPath = subPaths(a)[0];
                continue;
            }
            if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(a.name) && a.firstStringArg == null) {
                jaxrsMethods.push(a.name);
                continue;
            }
            if (a.name === 'RequestMapping') {
                // Try to detect method= attribute in args
                const detectedMethod = parseSpringRequestMappingMethod(a.args) || 'ALL';
                for (const sub of subPaths(a)) {
                    out.push({
                        method: detectedMethod,
                        path: joinRoutePath(classPrefix, sub) || '/',
                        framework: 'spring',
                    });
                }
                continue;
            }
            if (meth) {
                // Spring @GetMapping, @PostMapping, etc.
                for (const sub of subPaths(a)) {
                    out.push({
                        method: meth,
                        path: joinRoutePath(classPrefix, sub) || '/',
                        framework: 'spring',
                    });
                }
            }
        }
        // JAX-RS finalization
        if (jaxrsMethods.length > 0) {
            const subPath = jaxrsPath || '';
            for (const m of jaxrsMethods) {
                out.push({
                    method: m,
                    path: joinRoutePath(classPrefix, subPath) || '/',
                    framework: 'jax-rs',
                });
            }
        }
    }

    // ── Rust attributes (actix #[get("/users")]) ─────────────────────
    if (lang === 'rust' && sym.attributesWithArgs) {
        for (const a of sym.attributesWithArgs) {
            const method = RUST_METHOD_ATTRS[a.name];
            if (!method) continue;
            // a.args = '"/users"'  — strip quotes
            const arg = (a.args || '').trim();
            const m = arg.match(/^"([^"]*)"/);
            if (m) {
                out.push({
                    method,
                    path: m[1] || '/',
                    framework: 'actix',
                });
            }
        }
    }

    // ── C# attributes (ASP.NET Core) ─────────────────────────────────
    // [HttpGet("{id}")] / [HttpPost] + [Route("create")] / [Route] alone
    // (any method). Templates resolve `[controller]`/`[action]` tokens and
    // constants; routing is case-insensitive.
    if (lang === 'csharp' && sym.attributesWithArgs) {
        const verbs = [];
        const routeTemplates = [];
        for (const attribute of sym.attributesWithArgs) {
            const match = attribute.name.match(
                /^Http(Get|Post|Put|Delete|Patch|Head|Options)$/);
            if (match) {
                verbs.push({ method: match[1].toUpperCase(),
                    templates: jvmAnnotationPaths(sess, sym, attribute, 'csharp') });
            } else if (attribute.name === 'Route') {
                routeTemplates.push(...jvmAnnotationPaths(sess, sym, attribute, 'csharp'));
            }
        }
        const emit = (method, template) => out.push({
            method,
            path: aspnetRoutePath(classPrefix, template, sym),
            framework: 'aspnet',
            caseInsensitive: true,
        });
        for (const verb of verbs) {
            const templates = verb.templates.length > 0 ? verb.templates
                : routeTemplates.length > 0 ? routeTemplates : [''];
            for (const t of templates) emit(verb.method, t);
        }
        if (verbs.length === 0) for (const t of routeTemplates) emit('ALL', t);
    }

    return out;
}

/**
 * Parse a Python decorator raw string like:
 *   "app.route('/users', methods=['GET'])"
 *   "app.get('/users/<int:user_id>')"
 *   "router.post('/items')"
 * Returns { method, path, framework } or null.
 */
function parsePythonDecoratorFull(raw, fileEntry = null, receiverFramework = null, sess = null) {
    if (typeof raw !== 'string') return [];
    // Match receiver.verb('path', ...)
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\.([a-z]+)\s*\(\s*(['"])([^'"]*)\3/);
    if (!m) return [];
    const verb = m[2];
    const pathStr = m[4];
    if (verb === 'route') {
        // fix #373: every method of `methods=[...]` / `(...)` / `{...}`
        // (read from the decorator's AST) is a route.
        if (receiverFramework?.get(m[1]) === 'aiohttp') {
            // aiohttp `@routes.route(method, path)`.
            const args = decoratorLiteralArgs(sess, raw);
            if (!args || args.length < 2 || !args[1].startsWith('/')) return [];
            const method = args[0] === '*' ? 'ALL' : args[0].toUpperCase();
            return [{ method, path: args[1], framework: 'aiohttp', receiver: m[1] }];
        }
        const methods = decoratorMethodsKwarg(sess, raw);
        return (methods && methods.length > 0 ? methods : ['GET'])
            .map(method => ({ method, path: pathStr, framework: 'flask', receiver: m[1] }));
    }
    if (['get','post','put','delete','patch','options','head'].includes(verb)) {
        const modules = (fileEntry?.imports || []).map(value =>
            typeof value === 'string' ? value : String(value?.module || ''));
        const framework = receiverFramework?.get(m[1]) ||
            (modules.some(module => /^flask\b/.test(module)) &&
             !modules.some(module => /^fastapi\b/.test(module))
                ? 'flask' : modules.some(module => /^fastapi\b/.test(module)) &&
                  !modules.some(module => /^flask\b/.test(module))
                    ? 'fastapi' : 'unknown-python');
        // fix #373: with no proven framework, only a rooted path is a route
        // (Flask, Starlette and aiohttp reject unrooted route paths);
        // `@mock.patch("pkg.mod.attr")` is not a PATCH route.
        if (framework === 'unknown-python' && pathStr !== '' && !pathStr.startsWith('/')) return [];
        return [{ method: verb.toUpperCase(), path: pathStr, framework, receiver: m[1] }];
    }
    return [];
}

/** Leading positional string-literal arguments of a decorator call. */
function decoratorLiteralArgs(sess, raw) {
    const call = decoratorCall(sess, raw);
    if (!call) return null;
    const args = call.childForFieldName('arguments');
    const out = [];
    for (let i = 0; i < (args ? args.namedChildCount : 0); i++) {
        const arg = args.namedChild(i);
        if (!routeGraph.isStringLiteral(arg)) break;
        const v = routeGraph.readLiteral(arg, () => null);
        if (v == null) break;
        out.push(v);
    }
    return out;
}

function decoratorCall(sess, raw) {
    if (!sess) return null;
    const root = sess.snippet('python', raw);
    const stmt = root && root.namedChild(0);
    const call = stmt && (stmt.type === 'expression_statement' ? stmt.namedChild(0) : stmt);
    return call && call.type === 'call' ? call : null;
}

/** String values of a decorator call's `methods=` keyword (AST of the
 *  decorator text), or null. */
function decoratorMethodsKwarg(sess, raw) {
    const call = decoratorCall(sess, raw);
    if (!call) return null;
    const args = call.childForFieldName('arguments');
    for (let i = 0; i < (args ? args.namedChildCount : 0); i++) {
        const arg = args.namedChild(i);
        if (arg.type !== 'keyword_argument' || arg.childForFieldName('name')?.text !== 'methods') continue;
        const value = arg.childForFieldName('value');
        if (!value || !['list', 'tuple', 'set'].includes(value.type)) return null;
        const out = [];
        for (let j = 0; j < value.namedChildCount; j++) {
            const el = value.namedChild(j);
            if (el.type.includes('comment')) continue;
            if (!routeGraph.isStringLiteral(el)) return null;
            const v = routeGraph.readLiteral(el, () => null);
            if (v == null) return null;
            out.push(v.toUpperCase());
        }
        return [...new Set(out)];
    }
    return null;
}

// ── Python router mounts (fix #282) ─────────────────────────────────────────
// FastAPI: `router = APIRouter(prefix="/api")` + `app.include_router(r, prefix="/v2")`.
// Flask:   `bp = Blueprint(..., url_prefix="/api")` + `app.register_blueprint(bp, url_prefix="/v2")`.
// Neither prefix mechanism is in the call cache (both are keyword arguments,
// and the mounted router is a non-string argument), so every route rendered
// with its bare decorator path — /list for the real /api/things/list — and
// --bridge matched nothing on a prefixed application.
const PY_ROUTER_FACTORIES = new Set(['APIRouter', 'Blueprint']);
// Router/app objects that can be mounted (fix #366: `app.mount("/v2", sub)`).
const PY_APP_FACTORIES = new Set(['APIRouter', 'Blueprint', 'FastAPI', 'Flask', 'Starlette']);
const PY_INCLUDE_METHODS = new Set(['include_router', 'register_blueprint']);
const PY_PREFIX_KWARGS = new Set(['prefix', 'url_prefix']);

/** First `prefix=`/`url_prefix=` keyword argument of a call node, folded by
 *  constant propagation (fix #366); an unprovable value is a `{?expr}`
 *  segment, never silently dropped. */
function pyPrefixKwarg(sess, filePath, argsNode) {
    if (!argsNode) return null;
    for (let i = 0; i < argsNode.namedChildCount; i++) {
        const arg = argsNode.namedChild(i);
        if (arg.type !== 'keyword_argument') continue;
        const nameNode = arg.childForFieldName('name') || arg.namedChild(0);
        if (!nameNode || !PY_PREFIX_KWARGS.has(nameNode.text)) continue;
        const valueNode = arg.childForFieldName('value') || arg.namedChild(1);
        if (!valueNode || valueNode.type === 'none') return null;
        return routeGraph.evalString(sess, filePath, valueNode);
    }
    return null;
}

/**
 * Map Python router variables to their composed mount prefixes.
 * Returns Map `${absFile}:${routerVar}` -> [full prefix strings].
 * Only files whose call cache mentions a router factory, include or mount
 * call are AST-parsed; an unresolvable mount target contributes no edge
 * (the route keeps its own prefix - conservative under the advisory
 * contract).
 */
/** Python files whose router mounts the AST pass must read. */
function pythonMountFiles(index) {
    const relevant = [];
    for (const [filePath, entry] of index.files) {
        if (entry.language !== 'python') continue;
        const calls = getCachedCalls(index, filePath) || [];
        if (calls.some(c => (PY_APP_FACTORIES.has(c.name) && c.assignedTo) ||
            PY_INCLUDE_METHODS.has(c.name) || (c.name === 'mount' && c.isMethod))) {
            relevant.push([filePath, entry]);
        }
    }
    return relevant;
}

function collectPythonRouterMounts(index, sess, routeLists = null, relevant = pythonMountFiles(index)) {
    const listEdges = routeLists ? routeLists.edges : [];
    if (relevant.length === 0 && listEdges.length === 0) return new Map();

    const state = { ctorPrefixes: new Map(), edges: new Map(), routerVars: new Set(), mounts: [] };
    for (const [filePath, entry] of relevant) {
        const root = sess.root(filePath);
        if (!root) continue;
        const stack = [root];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node.type === 'call') visitPyRouterCall(sess, node, filePath, entry, index, state);
            for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push(node.namedChild(i));
        }
    }
    // `app.mount(prefix, sub)` mounts arbitrary ASGI apps; only a mounted
    // project router/app carries routes worth prefixing.
    for (const m of state.mounts) {
        if (!state.routerVars.has(m.targetKey)) continue;
        const list = state.edges.get(m.targetKey) || [];
        list.push({ mounterKey: m.mounterKey, prefix: m.prefix });
        state.edges.set(m.targetKey, list);
    }
    // fix #373: include()/Mount/Host/add_subapp edges of route lists; a
    // ROOT_URLCONF module is served at the root even when also included.
    for (const e of listEdges) {
        const list = state.edges.get(e.targetKey) || [];
        list.push({ mounterKey: e.mounterKey, prefix: e.prefix, ...(e.join && e.join !== 'path' && { join: e.join }) });
        state.edges.set(e.targetKey, list);
    }
    if (routeLists && listEdges.length > 0) {
        for (const key of [...routeLists.roots].sort(codeUnitCompare)) {
            const list = state.edges.get(key);
            if (list) list.push({ mounterKey: null, prefix: '' });
        }
    }
    const prefixes = rootPrefixes(composeMountPrefixes(state.edges, state.ctorPrefixes));
    // The mount edges also name the apps each router is served from (fix
    // #392: an in-process test client reaches only its own app's routes).
    Object.defineProperty(prefixes, 'edges', { value: state.edges, enumerable: false });
    return prefixes;
}

/**
 * The container keys a route of container `key` is served from (fix #392):
 * the container itself and every app/router that mounts it, transitively.
 */
function servingAppKeys(edges, key, memo) {
    if (!key) return null;
    if (memo.has(key)) return memo.get(key);
    const keys = new Set([key]);
    const queue = [key];
    while (queue.length > 0 && keys.size < 256) {
        const current = queue.shift();
        for (const edge of (edges ? edges.get(current) : null) || []) {
            if (edge.mounterKey && !keys.has(edge.mounterKey)) {
                keys.add(edge.mounterKey);
                queue.push(edge.mounterKey);
            }
        }
    }
    memo.set(key, keys);
    return keys;
}

/**
 * Container key of a Python route decorator's receiver (`@app.get(...)` on
 * `sym`), resolved where the decorator is written (fix #392): a function-local
 * app is its own container, not the module's namesake.
 */
function pythonDecoratorReceiverKey(index, sess, sym, receiver) {
    const root = sess.root(sym.file);
    if (!root) return null;
    const first = (sym.startLine || 1) - 1;
    const last = (sym.nameLine || sym.startLine || 1) - 1;
    for (const ident of root.descendantsOfType('identifier', { row: first, column: 0 }, { row: last, column: 1 << 20 })) {
        if (ident.text !== receiver || ident.parent?.type !== 'attribute') continue;
        let inDecorator = false;
        for (let n = ident.parent; n && !inDecorator; n = n.parent) {
            if (n.type === 'decorator') inDecorator = true;
            if (n.type === 'function_definition' || n.type === 'module') break;
        }
        if (inDecorator) return pythonContainerKey(index, sess, sym.file, ident);
    }
    return null;
}

/** Attach the serving app keys to a route record (internal, not output). */
function withAppKeys(route, keys) {
    if (keys) Object.defineProperty(route, 'appKeys', { value: keys, enumerable: false });
    return route;
}

/** Mount prefixes are rooted paths (gin `Group("v1")` serves `/v1`). */
function rootPrefixes(map) {
    for (const [key, list] of map) {
        map.set(key, [...new Set(list.map(p => (p && !p.startsWith('/') ? '/' + p : p)))].sort(codeUnitCompare));
    }
    return map;
}

function pyCalleeName(fn) {
    if (!fn) return null;
    if (fn.type === 'identifier') return fn.text;
    if (fn.type === 'attribute') return fn.childForFieldName('attribute')?.text || null;
    return null;
}

/** Name-keyed router reference in `file`: a module-level router variable, or
 *  one re-exported through import bindings (chased across modules). */
function pyChaseRouterKey(sess, index, file, name, depth = 0) {
    if (depth > 6) return `${file}:${name}`;
    const root = sess.root(file);
    const decl = root && routeGraph.scopeDecls(sess, file, 'python', root).get(name);
    if (decl) return `${file}:${name}`;
    const entry = index.files.get(file);
    const bindings = entry?.importBindings || [];
    const binding = bindings.find(b => (b.alias || b.name) === name) ||
        (() => {
            const alias = (entry?.importAliases || []).find(a => a.local === name);
            return alias ? bindings.find(b => b.name === alias.original) : null;
        })();
    if (binding && binding.kind === 'from') {
        const mod = String(binding.module || '');
        const subSpec = mod.endsWith('.') ? mod + binding.name : `${mod}.${binding.name}`;
        if (!entry.moduleResolved?.[subSpec]) {
            const rel = entry.moduleResolved?.[mod];
            if (rel) return pyChaseRouterKey(sess, index, path.join(index.root, rel), binding.name, depth + 1);
        }
    }
    return `${file}:${name}`;
}

function pyRouterRefKey(sess, index, filePath, entry, refNode) {
    if (!refNode) return null;
    if (refNode.type === 'attribute') {
        // `app.include_router(mod.router)` - module attribute (plain or
        // from-imported submodule).
        const obj = refNode.childForFieldName('object');
        const attr = refNode.childForFieldName('attribute');
        if (!obj || !attr) return null;
        const v = routeGraph.lookupValue(sess, filePath, obj, 0);
        if (v && v.kind === 'module') return pyChaseRouterKey(sess, index, v.file, attr.text);
        return null;
    }
    if (refNode.type === 'identifier') {
        // Bare name: a local router variable, else an imported one.
        const decl = routeGraph.findDecl(sess, filePath, refNode.text, refNode);
        if (decl) return `${filePath}:${refNode.text}`;
        return pyChaseRouterKey(sess, index, filePath, refNode.text);
    }
    return null;
}

function visitPyRouterCall(sess, callNode, filePath, entry, index, state) {
    const fn = callNode.childForFieldName('function');
    if (!fn) return;
    const calleeName = pyCalleeName(fn);

    // `<var> = APIRouter(prefix=...)` / `<var> = FastAPI()` - router value,
    // with its constructor prefix.
    if (calleeName && PY_APP_FACTORIES.has(calleeName)) {
        const parent = callNode.parent;
        if (!parent || parent.type !== 'assignment') return;
        const left = parent.childForFieldName('left');
        if (!left || left.type !== 'identifier') return;
        const key = `${filePath}:${left.text}`;
        state.routerVars.add(key);
        if (PY_ROUTER_FACTORIES.has(calleeName)) {
            const prefix = pyPrefixKwarg(sess, filePath, callNode.childForFieldName('arguments'));
            if (prefix) state.ctorPrefixes.set(key, prefix);
        }
        return;
    }

    if (fn.type !== 'attribute') return;
    const attrNode = fn.childForFieldName('attribute');
    if (!attrNode) return;
    const method = attrNode.text;
    if (!PY_INCLUDE_METHODS.has(method) && method !== 'mount') return;
    const recvNode = fn.childForFieldName('object');
    // Non-identifier receivers (self.app, factories) can't be keyed — treat
    // as a root mounter so the edge prefix still applies.
    const mounterKey = recvNode && recvNode.type === 'identifier'
        ? `${filePath}:${recvNode.text}` : null;
    const argsNode = callNode.childForFieldName('arguments');
    if (!argsNode) return;
    const positional = [];
    for (let i = 0; i < argsNode.namedChildCount; i++) {
        const arg = argsNode.namedChild(i);
        if (arg.type === 'keyword_argument' || arg.type.includes('comment')) continue;
        positional.push(arg);
    }

    if (method === 'mount') {
        // `app.mount("/v2", sub_app)` - Starlette/FastAPI sub-application.
        if (positional.length < 2) return;
        const targetKey = pyRouterRefKey(sess, index, filePath, entry, positional[1]);
        if (!targetKey) return;
        state.mounts.push({ targetKey, mounterKey,
            prefix: routeGraph.evalString(sess, filePath, positional[0]) });
        return;
    }

    // `<recv>.include_router(<ref>, prefix=...)` - mount edge.
    const refNode = positional[0];
    if (!refNode) return;
    const explicitPrefix = pyPrefixKwarg(sess, filePath, argsNode);
    const prefix = explicitPrefix || '';
    // Flask: register_blueprint's url_prefix REPLACES the blueprint's own
    // url_prefix; FastAPI's include_router prefix composes with it.
    const overridesCtor = explicitPrefix != null && method === 'register_blueprint';
    const targetKey = pyRouterRefKey(sess, index, filePath, entry, refNode);
    if (!targetKey) return;
    const list = state.edges.get(targetKey) || [];
    list.push({ mounterKey, prefix, ...(overridesCtor && { overridesCtor }) });
    state.edges.set(targetKey, list);
}

/** Map exported router receiver variables to their literal project mounts.
 *  fix #282: same-file mounts (`app.use('/api', localRouter)`), NAMED-export
 *  routers, and transitive composition (`app.use('/api', parent)` +
 *  `parent.use('/sub', child)` → child serves under /api/sub). */
function collectProjectRouterMounts(index) {
    const edges = new Map();
    for (const [filePath, fileEntry] of index.files) {
        if (!['javascript', 'typescript', 'tsx'].includes(fileEntry.language)) continue;
        const calls = getCachedCalls(index, filePath) || [];
        const localRouters = collectRouterReceivers(calls, fileEntry.language);
        const ambiguous = ambiguousRouterNames(calls, fileEntry.language);
        for (const call of calls) {
            if ((call.name !== 'use' && call.name !== 'route') || !call.receiver || !call.firstStringArg ||
                (call.argCount != null && call.argCount < 2)) continue;
            const mounterKey = `${filePath}:${call.receiver}`;
            // fix #366: the mount's identifier arguments (parse-time
            // `mountArgs`); names declared more than once in the file are
            // left to the scope-aware router graph.
            const refs = call.mountArgs
                ? call.mountArgs.slice(1).filter(n => /^[A-Za-z_$][\w$]*$/.test(n) && !ambiguous.has(n))
                    .map(name => ({ name }))
                : calls.filter(candidate => candidate.line === call.line &&
                    candidate !== call && (candidate.isFunctionReference || candidate.isPotentialCallback));
            for (const ref of refs) {
                const targetKeys = [];
                const binding = (fileEntry.importBindings || []).find(item => item.name === ref.name);
                const rel = binding && fileEntry.moduleResolved?.[binding.module];
                if (rel) {
                    const targetFile = path.join(index.root, rel);
                    const targetEntry = index.files.get(targetFile);
                    if (targetEntry) {
                        const exportedReceivers = (targetEntry.exportDetails || [])
                            .filter(exp => (exp.type === 'module.exports' && exp.defaultLike) ||
                                exp.isDefault ||
                                exp.kind === 'default' || exp.type === 'export-default' ||
                                exp.name === ref.name)
                            .map(exp => exp.localName || exp.name).filter(Boolean);
                        for (const receiver of exportedReceivers) {
                            targetKeys.push(`${targetFile}:${receiver}`);
                        }
                    }
                } else if (localRouters.has(ref.name)) {
                    targetKeys.push(`${filePath}:${ref.name}`);
                }
                const join = joinRuleOf(routeFrameworkOfFile(index, filePath));
                for (const key of targetKeys) {
                    const list = edges.get(key) || [];
                    list.push({ mounterKey, prefix: call.firstStringArg, ...(join !== 'path' && { join }) });
                    edges.set(key, list);
                }
            }
        }
    }
    return composeMountPrefixes(edges, new Map());
}

/**
 * Spring @RequestMapping(method = RequestMethod.GET) — extract method.
 * Returns 'GET' / 'POST' / etc. or null.
 */
function parseSpringRequestMappingMethod(argsRaw) {
    if (typeof argsRaw !== 'string') return null;
    const m = argsRaw.match(/method\s*=\s*RequestMethod\.([A-Z]+)/);
    return m ? m[1] : null;
}

/** Infer router values from AST call/assignment evidence, independent of the
 * variable's spelling. Legacy receiver-name patterns remain seeds for code
 * where the factory assignment is outside the indexed file. */
// Per-call-array memo: route extraction, mount collection and client
// classification all ask for the same file's router receivers.
const routerReceiverMemo = new WeakMap();

function collectRouterReceivers(calls, lang) {
    let byLang = routerReceiverMemo.get(calls);
    if (!byLang) {
        byLang = new Map();
        routerReceiverMemo.set(calls, byLang);
    }
    let receivers = byLang.get(lang);
    if (!receivers) {
        receivers = computeRouterReceivers(calls, lang);
        byLang.set(lang, receivers);
    }
    return receivers;
}

function computeRouterReceivers(calls, lang) {
    const receivers = new Set();
    const patterns = SERVER_RECEIVER_PATTERNS[lang] || [];
    for (const call of calls) {
        if (call.receiver && (patterns.some(pattern =>
            pattern.receiverPattern.test(call.receiver)) || routerTypedReceiver(call, lang))) {
            receivers.add(call.receiver);
        }
        if (!call.assignedTo) continue;
        const receiver = String(call.receiver || '');
        const factory = (
            (['javascript', 'typescript', 'tsx'].includes(lang) &&
                /^(Router|express|fastify|Fastify|Koa|Hono)$/.test(call.name)) ||
            (lang === 'go' && (
                /^(NewRouter|NewServeMux|Default)$/.test(call.name) ||
                (call.name === 'New' && /^(gin|echo|chi|fiber|mux|http)$/i.test(receiver)))) ||
            (lang === 'rust' && call.name === 'new' && /Router$/.test(receiver)) ||
            (lang === 'csharp' && call.name === 'Build')
        );
        if (factory) receivers.add(call.assignedTo);
    }

    // Router groups/nests produce another router. Iterate because nested
    // groups are common (`admin := api.Group(...); v2 := admin.Group(...)`).
    let changed = true;
    while (changed) {
        changed = false;
        for (const call of calls) {
            if (!call.assignedTo || !call.receiver ||
                !/^(Group|group|nest|NewGroup|MapGroup)$/.test(call.name) ||
                !receivers.has(call.receiver) || receivers.has(call.assignedTo)) continue;
            receivers.add(call.assignedTo);
            changed = true;
        }
    }
    return receivers;
}

/**
 * Match a call against server route patterns. Returns {method, path, framework} or null.
 */
function matchCallPatternRoute(call, lang, routerReceivers = null) {
    if (!call.firstStringArg) return null;

    // Path-call patterns (Rust): handled outside (router.route, router.nest captured below)
    const patterns = SERVER_RECEIVER_PATTERNS[lang];
    if (!patterns || patterns.length === 0) return null;

    // For Express/Gin/etc, the call is method-call: app.get('/path', handler)
    for (const p of patterns) {
        if (!call.receiver) continue;
        if (!routerReceivers?.has(call.receiver) &&
            !p.receiverPattern.test(call.receiver)) continue;
        if (!p.methodPattern.test(call.name)) continue;

        // BUG M5: Express has dual-purpose APIs where 1-arg .get/.set are config
        // getters/setters, not route registrations. A real route registration has
        // path + at least one handler (≥2 args).
        //   app.get('/users', handler)  → 2+ args → route
        //   app.get('env')              → 1 arg  → config getter, skip
        // Only apply when argCount is known (parser provided it).
        if (p.framework === 'express' && typeof call.argCount === 'number' && call.argCount < 2) {
            continue;
        }

        // axum router.route('/path', get(handler)) — method comes from the *second* arg's verb,
        // which we don't have direct access to here. Fall back to ALL.
        let method = call.name.toUpperCase();
        if (p.framework === 'aspnet-minimal') {
            const mapped = call.name.match(/^Map(Get|Post|Put|Delete|Patch)$/);
            method = mapped ? mapped[1].toUpperCase() : 'ALL';
        }
        if (method === 'ROUTE' || method === 'HANDLE' || method === 'HANDLEFUNC' || method === 'USE' || method === 'ANY') {
            method = 'ALL';
        }
        // axum-style nest('/prefix', inner) is a prefix mount, not a route — skip when not handled
        return { method, path: call.firstStringArg, framework: p.framework };
    }
    return null;
}

/**
 * Find a handler-callback identifier on the same line as a route registration call.
 * Looks for callback-marker calls (isPotentialCallback / isFunctionReference) on that line.
 */
function findHandlerCallback(calls, line, exclude) {
    // A record inside an inline handler (a function literal argument) has
    // that function as its enclosing scope; only records in the
    // registration's own scope can name its handler (fix #383).
    const scopeOf = c => (c.enclosingFunction ? `${c.enclosingFunction.name}:${c.enclosingFunction.startLine}` : '');
    const scope = exclude ? scopeOf(exclude) : null;
    const inScope = c => c !== exclude && c.line === line && (scope === null || scopeOf(c) === scope) &&
        (exclude?.callStart == null || c.callStart == null ||
            (c.callStart >= exclude.callStart && c.callEnd <= exclude.callEnd));
    for (const c of calls) {
        if (!inScope(c)) continue;
        if (c.isPotentialCallback || c.isFunctionReference) {
            return c.name;
        }
    }
    // Fallback: any non-method call on the same line
    for (const c of calls) {
        if (!inScope(c)) continue;
        if (!c.isMethod) return c.name;
    }
    return null;
}

// ============================================================================
// NEXT.JS FILE-BASED ROUTES
// ============================================================================

/**
 * Detect Next.js routes by scanning files under pages/ or app/.
 * Each matching file becomes a route; method comes from exported function name.
 *   pages/users/[id].ts                → GET /users/:id  (default export)
 *   app/users/[id]/route.ts (export GET) → GET /users/:id
 */
function extractNextjsRoutes(index) {
    const root = index.root;
    if (!root) return [];

    // Cheap existence check before scanning
    const hasPages = fs.existsSync(path.join(root, 'pages'));
    const hasApp = fs.existsSync(path.join(root, 'app'));
    if (!hasPages && !hasApp) return [];

    const out = [];
    for (const [filePath, fileEntry] of index.files) {
        const rel = (fileEntry.relativePath || filePath).split(path.sep).join('/');
        const isPages = /(^|\/)pages\/.*\.(js|ts|jsx|tsx|mjs|cjs)$/.test(rel);
        const isApp = /(^|\/)app\/.*\/route\.(js|ts|jsx|tsx|mjs|cjs)$/.test(rel);
        if (!isPages && !isApp) continue;

        // Convert file path to route
        let routePath = rel;
        if (isPages) {
            routePath = routePath.replace(/^.*?\/?pages\//, '/');
            routePath = routePath.replace(/\.(js|ts|jsx|tsx|mjs|cjs)$/, '');
            // index → /
            routePath = routePath.replace(/\/index$/, '');
            if (!routePath) routePath = '/';
        } else {
            routePath = routePath.replace(/^.*?\/?app\//, '/');
            routePath = routePath.replace(/\/route\.(js|ts|jsx|tsx|mjs|cjs)$/, '');
            if (!routePath) routePath = '/';
        }
        // Convert [param] → :param
        routePath = routePath.replace(/\[\.\.\.([^\]]+)\]/g, '*');
        routePath = routePath.replace(/\[([^\]]+)\]/g, ':$1');

        if (isPages) {
            // Default export = GET (page render)
            out.push({
                method: 'GET',
                path: routePath,
                normalizedPath: normalizePath(routePath, 'router'),
                handler: 'default',
                file: fileEntry.relativePath || filePath,
                absoluteFile: filePath,
                line: 1,
                framework: 'nextjs',
                raw: `GET ${routePath} (next page)`,
            });
        } else {
            // App router: each named export GET/POST/etc. is a method handler
            const exports = fileEntry.exports || [];
            const methodsFound = new Set();
            for (const e of exports) {
                if (HTTP_METHODS.has(String(e.name).toUpperCase())) {
                    methodsFound.add(String(e.name).toUpperCase());
                }
            }
            // If none detected (e.g., exports not parsed), default to GET
            if (methodsFound.size === 0) methodsFound.add('GET');
            for (const m of methodsFound) {
                out.push({
                    method: m,
                    path: routePath,
                    normalizedPath: normalizePath(routePath, 'router'),
                    handler: m,
                    file: fileEntry.relativePath || filePath,
                    absoluteFile: filePath,
                    line: 1,
                    framework: 'nextjs',
                    raw: `${m} ${routePath} (next route)`,
                });
            }
        }
    }
    return out;
}

// ============================================================================
// EXTRACT CLIENT REQUESTS
// ============================================================================

/**
 * Detect HTTP client requests across the project.
 * Cached on `index._endpointsCache.clientRequests`.
 */
// Python HTTP client types whose instances are receivers of request calls.
// A receiver typed to one of these (with-binding, constructor assignment) or
// bound to a pytest fixture that constructs one is a client by evidence, not
// by name (fix #349: 145 of 625 real `tc.get("/api/...")` sites on one repo
// were invisible because the receiver was not literally named `client`).
const PY_CLIENT_TYPES = new Set([
    'TestClient', 'Client', 'AsyncClient', 'Session', 'FlaskClient',
    'ClientSession', 'AsyncSession', 'HTTPConnection', 'HTTPSConnection',
]);
const PY_CLIENT_FACTORIES = new Set(['test_client', 'Session', 'Client', 'AsyncClient']);
const PY_REQUEST_METHODS = /^(get|post|put|delete|patch|options|head|request)$/;

function _pythonClientFixtures(index) {
    if (index._endpointsCache?.pyClientFixtures) return index._endpointsCache.pyClientFixtures;
    const fixtures = new Set();
    for (const [filePath, fileEntry] of index.files) {
        if (fileEntry.language !== 'python') continue;
        const fixtureDefs = (fileEntry.symbols || []).filter(s =>
            (s.decorators || []).some(d => /(^|\.)fixture$/.test(String(d))));
        if (fixtureDefs.length === 0) continue;
        const calls = getCachedCalls(index, filePath) || [];
        for (const def of fixtureDefs) {
            const constructsClient = calls.some(c =>
                c.enclosingFunction?.name === def.name &&
                c.enclosingFunction?.startLine === def.startLine &&
                (PY_CLIENT_TYPES.has(c.name) || (c.isMethod && PY_CLIENT_FACTORIES.has(c.name))));
            if (constructsClient) fixtures.add(def.name);
        }
    }
    if (!index._endpointsCache) index._endpointsCache = {};
    index._endpointsCache.pyClientFixtures = fixtures;
    return fixtures;
}

function _pythonClientReceiver(index, fileEntry, call, fixtures) {
    if (!call.isMethod || !call.receiver || !PY_REQUEST_METHODS.test(call.name)) return null;
    if (call.receiverType && PY_CLIENT_TYPES.has(String(call.receiverType).split('.').pop())) {
        return 'python-client';
    }
    if (fixtures.size === 0 || !fixtures.has(call.receiver)) return null;
    const fn = call.enclosingFunction;
    if (!fn) return null;
    const sym = (fileEntry.symbols || []).find(s => s.name === fn.name && s.startLine === fn.startLine);
    const params = String(sym?.params || '').split(',').map(p => p.trim().split(/[:=]/)[0].trim());
    return params.includes(call.receiver) ? 'pytest-client-fixture' : null;
}

// `fastify().route({...})` - a route declared on a freshly built server.
const JS_SERVER_FACTORY_CALL = /^(fastify|Fastify|express|Hono|Koa)$/;

// Call names that read as issuing a request (uncertain band for unproven
// request-configuration calls; configuration objects are common elsewhere).
const REQUEST_SHAPED_NAME = /^(get|post|put|delete|patch|options|head|fetch|send|inject)$|request/i;

function isPathShaped(p) {
    return typeof p === 'string' && (p.startsWith('/') || p.includes('://'));
}

function isAbsoluteUrl(p) {
    return typeof p === 'string' && p.includes('://');
}

function extractClientRequests(index) {
    if (index._endpointsCache && index._endpointsCache.clientRequests) {
        return index._endpointsCache.clientRequests;
    }
    const requests = [];
    const uncertain = [];
    const pyFixtures = _pythonClientFixtures(index);
    let helperProof = null;

    for (const [filePath, fileEntry] of index.files) {
        const lang = fileEntry.language;
        const calls = getCachedCalls(index, filePath);
        if (!calls || calls.length === 0) continue;

        let serverReceivers = null;
        // In-process supertest clients (fix #397): the names this file binds
        // to the `supertest` module (by module identity, whatever the local
        // name), and the call records that build a client from one.
        const supertestLocals = JS_LANGS.has(lang) ? supertestLocalNames(fileEntry) : null;
        let supertestProducers = null;
        for (const call of calls) {
            if (supertestLocals && call.isMethod && SUPERTEST_VERBS.has(call.name) &&
                call.firstStringArg && isPathShaped(call.firstStringArg) &&
                !isAbsoluteUrl(call.firstStringArg)) {
                if (!supertestProducers) supertestProducers = supertestClientProducers(calls, supertestLocals);
                const producer = supertestProducerOf(call, calls, supertestProducers, supertestLocals);
                if (producer) {
                    const request = {
                        method: call.name === 'del' ? 'DELETE' : call.name.toUpperCase(),
                        path: call.firstStringArg,
                        normalizedPath: normalizePath(call.firstStringArg, 'client'),
                        interp: !!call.firstStringArgInterp,
                        file: fileEntry.relativePath || filePath,
                        absoluteFile: filePath,
                        line: call.line,
                        callerName: call.enclosingFunction?.name || '<top-level>',
                        callerStartLine: call.enclosingFunction?.startLine,
                        framework: 'supertest',
                        methodInferred: false,
                    };
                    // The app the client was built from serves the request
                    // in process; bridging resolves it.
                    Object.defineProperty(request, 'jsClientApp', {
                        value: { start: producer.callStart, end: producer.callEnd }, enumerable: false,
                    });
                    requests.push(request);
                    continue;
                }
            }
            // fix #366: request configuration objects/keywords
            // (`__request(OpenAPI, { method, url })`, `client.post({ url })`,
            // `session.request(method=..., url=...)`). A path-shaped first
            // string argument keeps the positional client path below.
            // `fetch(input, init)`: the URL is always `input`; a `url` key in
            // the init object is not the request target.
            const cfg = call.requestConfig && !(call.name === 'fetch' && !call.isMethod)
                ? call.requestConfig : null;
            if (cfg && !(call.firstStringArg && isPathShaped(call.firstStringArg))) {
                // `server.route({ method, url })` declares a route (server
                // side); `server.inject({ method, url })` is an in-process
                // request against the server (Fastify/light-my-request).
                const onServer = call.isMethod && (call.name === 'route' || call.name === 'inject') &&
                    (call.receiver
                        ? (serverReceivers || (serverReceivers = collectRouterReceivers(calls, lang))).has(call.receiver)
                        : JS_SERVER_FACTORY_CALL.test(call.receiverCall || ''));
                if (onServer && call.name === 'route') continue;
                if (onServer && call.name === 'inject') {
                    requests.push({
                        method: cfg.method || 'ALL',
                        path: cfg.url,
                        normalizedPath: normalizePath(cfg.url, 'client'),
                        interp: !!cfg.interp,
                        file: fileEntry.relativePath || filePath,
                        absoluteFile: filePath,
                        line: call.line,
                        callerName: call.enclosingFunction?.name || '<top-level>',
                        callerStartLine: call.enclosingFunction?.startLine,
                        framework: 'inject',
                        methodInferred: !cfg.method,
                        // An in-process injection targets the instance its
                        // own test built: routes registered inside the same
                        // enclosing function (or file, at top level).
                        sameFileOnly: true,
                        ...(call.enclosingFunction?.endLine && {
                            scopeLines: [call.enclosingFunction.startLine, call.enclosingFunction.endLine],
                        }),
                    });
                    continue;
                }
                if (!helperProof) helperProof = new RequestHelperProof(index, endpointsSession(index));
                const proof = helperProof.classify(filePath, call);
                const verb = call.isMethod && /^(get|post|put|delete|patch|options|head)$/i.test(call.name)
                    ? call.name.toUpperCase() : null;
                const method = cfg.method || verb || 'ALL';
                if (proof.proven) {
                    requests.push({
                        method,
                        path: cfg.url,
                        normalizedPath: normalizePath(cfg.url, 'client'),
                        interp: !!cfg.interp,
                        file: fileEntry.relativePath || filePath,
                        absoluteFile: filePath,
                        line: call.line,
                        callerName: call.enclosingFunction?.name || '<top-level>',
                        callerStartLine: call.enclosingFunction?.startLine,
                        framework: 'request-helper',
                        methodInferred: !cfg.method && !verb,
                    });
                } else if (isPathShaped(cfg.url) && REQUEST_SHAPED_NAME.test(call.name)) {
                    uncertain.push({
                        receiver: call.receiver || '', method: call.name, path: cfg.url,
                        file: fileEntry.relativePath || filePath, absoluteFile: filePath, line: call.line,
                        callerName: call.enclosingFunction?.name || '<top-level>',
                        reason: `request-helper-unproven:${proof.reason}`,
                    });
                }
                continue;
            }
            // fix #383: Go request constructors read their method and URL
            // from their own argument positions.
            if (call.requestTarget && lang === 'go' && call.receiver && !call.isPathCall &&
                matchClientRequest({ ...call, firstStringArg: call.requestTarget.url }, lang, calls)) {
                const target = call.requestTarget;
                if (isPathShaped(target.url)) {
                    // A request with a path but no scheme and host cannot be
                    // sent by a client: it is served in process
                    // (`handler.ServeHTTP(w, req)`), by the routes its own
                    // test registers, like an injected request.
                    const inProcess = !target.url.includes('://');
                    requests.push({
                        method: target.method || 'ALL',
                        path: target.url,
                        normalizedPath: normalizePath(target.url, 'client'),
                        interp: !!target.interp,
                        file: fileEntry.relativePath || filePath,
                        absoluteFile: filePath,
                        line: call.line,
                        callerName: call.enclosingFunction?.name || '<top-level>',
                        callerStartLine: call.enclosingFunction?.startLine,
                        framework: inProcess ? 'go-inprocess' : 'go-http',
                        methodInferred: !target.method,
                        // Only the routes its own function registers can
                        // serve it (a request built to feed a context in a
                        // test with no router bridges nowhere).
                        ...(inProcess && {
                            sameFileOnly: true,
                            scopeOnly: true,
                            scopeLines: call.enclosingFunction?.endLine
                                ? [call.enclosingFunction.startLine, call.enclosingFunction.endLine] : [0, 0],
                        }),
                    });
                }
                continue;
            }
            if (!call.firstStringArg) continue;
            let r = matchClientRequest(call, lang, calls);
            if (!r && lang === 'python') {
                const framework = _pythonClientReceiver(index, fileEntry, call, pyFixtures);
                if (framework) {
                    r = { method: call.name.toUpperCase() === 'REQUEST' ? 'ALL' : call.name.toUpperCase(),
                        framework, methodInferred: call.name === 'request' };
                }
            }
            if (!r) {
                // Visible uncertainty: request-shaped call on an unrecognized
                // receiver with a path-shaped literal. Listed, never counted.
                const conf = CLIENT_PATTERNS[lang];
                const pathShaped = call.firstStringArg.startsWith('/') || call.firstStringArg.includes('://');
                if (conf && call.isMethod && call.receiver && pathShaped &&
                    conf.receivers.some(p => p.methodPattern.test(call.name))) {
                    uncertain.push({
                        receiver: call.receiver, method: call.name, path: call.firstStringArg,
                        file: fileEntry.relativePath || filePath, absoluteFile: filePath, line: call.line,
                        callerName: call.enclosingFunction?.name || '<top-level>',
                        reason: 'receiver-unrecognized',
                    });
                }
                continue;
            }

            // Python's common `session.get("key")` / `s.get("key")`
            // dictionary and ORM idioms are not HTTP requests.  Without
            // receiver-type evidence, require the string to have a URL/path
            // shape before claiming an outbound request.  This deliberately
            // keeps absolute URLs and normal relative API paths while
            // rejecting cache/session keys (UCN5-162).
            // Go (fix #383): `c.Get("key")` on a request context is a
            // key lookup; net/http clients take absolute URLs. A request
            // constructor's first argument is its method, never its URL.
            if ((lang === 'python' || lang === 'go') && !isPathShaped(call.firstStringArg)) {
                continue;
            }
            if (lang === 'go' && (call.name === 'NewRequest' || call.name === 'NewRequestWithContext')) {
                continue;
            }

            const callerName = call.enclosingFunction?.name || '<top-level>';
            const callerStartLine = call.enclosingFunction?.startLine;
            const request = {
                method: r.method,
                path: call.firstStringArg,
                normalizedPath: normalizePath(call.firstStringArg, 'client'),
                interp: !!call.firstStringArgInterp,
                file: fileEntry.relativePath || filePath,
                absoluteFile: filePath,
                line: call.line,
                callerName,
                callerStartLine,
                framework: r.framework,
                methodInferred: r.methodInferred,
            };
            // A request through a client built from an app is served by that
            // app in process (fix #392); bridging resolves the client's app.
            if (lang === 'python' && call.isMethod && call.receiver && !isAbsoluteUrl(call.firstStringArg)) {
                Object.defineProperty(request, 'clientCall', {
                    value: { receiver: call.receiver, name: call.name }, enumerable: false,
                });
            }
            requests.push(request);
        }
    }

    // Stable sort
    uncertain.sort((a, b) => a.file !== b.file ? codeUnitCompare(a.file, b.file) : a.line - b.line);
    if (!index._endpointsCache) index._endpointsCache = {};
    index._endpointsCache.uncertainRequests = uncertain;
    requests.sort((a, b) => {
        if (a.file !== b.file) return codeUnitCompare(a.file, b.file);
        if (a.line !== b.line) return a.line - b.line;
        if (a.method !== b.method) return codeUnitCompare(a.method, b.method);
        return codeUnitCompare(a.path, b.path);
    });

    if (!index._endpointsCache) index._endpointsCache = {};
    index._endpointsCache.clientRequests = requests;
    return requests;
}

// supertest (fix #397): `request(app).get('/x')`, `request.agent(app)`,
// and a client bound to a local (`const agent = request(app)`).
const JS_LANGS = new Set(['javascript', 'typescript', 'tsx']);
const SUPERTEST_VERBS = new Set(['get', 'post', 'put', 'delete', 'del', 'patch', 'head', 'options']);

/** Local names a file binds to the `supertest` module's export. */
function supertestLocalNames(fileEntry) {
    let names = null;
    for (const binding of fileEntry.importBindings || []) {
        if (binding?.module !== 'supertest') continue;
        const local = binding.alias || binding.name;
        if (!local || local === '*') continue;
        (names || (names = new Set())).add(local);
    }
    return names;
}

/** A call record that builds a supertest client: `request(app)` or `request.agent(app)`. */
function isSupertestProducer(record, locals) {
    if (!record || record.localShadow) return false;
    if (!record.isMethod && !record.receiver) return locals.has(record.name);
    return record.isMethod && record.name === 'agent' && locals.has(record.receiver) &&
        !record.receiverLocalBinding;
}

/** Client producers of a file by call start, and locals bound to one. */
function supertestClientProducers(calls, locals) {
    const byStart = new Map();
    const byLocal = new Map();
    for (const record of calls) {
        if (!isSupertestProducer(record, locals) || record.callStart == null) continue;
        byStart.set(record.callStart, record);
        if (record.assignedTo) {
            const list = byLocal.get(record.assignedTo) || [];
            list.push(record);
            byLocal.set(record.assignedTo, list);
        }
    }
    return { byStart, byLocal };
}

/**
 * The client-building call a request call is made through: its chained
 * producer (`request(app).get(..)`), or the one producer assigned to its
 * receiver in the same function (`const agent = request.agent(app)`).
 */
function supertestProducerOf(call, calls, producers, locals) {
    if (call.receiverCall && call.receiverCallStart != null && !call.receiver) {
        return producers.byStart.get(call.receiverCallStart) || null;
    }
    if (!call.receiver || locals.has(call.receiver)) return null;
    const scoped = (producers.byLocal.get(call.receiver) || []).filter(record =>
        (record.enclosingFunction?.startLine || 0) === (call.enclosingFunction?.startLine || 0) &&
        record.line <= call.line);
    return scoped.length === 1 ? scoped[0] : null;
}

/**
 * Match a call against client request patterns.
 * Returns { method, framework, methodInferred } or null.
 */
function matchClientRequest(call, lang, allCallsInFile) {
    const conf = CLIENT_PATTERNS[lang];
    if (!conf) return null;

    // 1) Bare-call patterns: fetch('/path') or fetch('/path', { method: 'POST' })
    if (!call.isMethod && conf.bareCalls.has(call.name)) {
        // MEDIUM-5: parse-time captured `optionsMethod` from
        // fetch(url, { method: 'POST' }) wins over default GET.
        const explicitMethod = call.optionsMethod || inferMethodFromFetchOptions(call);
        const inferredMethod = explicitMethod || 'GET';
        // Method is "inferred" only when we fell through to the default GET;
        // an explicit options.method is exact knowledge from the source.
        const methodInferred = !explicitMethod;
        return { method: inferredMethod, framework: 'fetch', methodInferred };
    }

    // 2) Receiver.method patterns. For Go, package-qualified calls have
    // `isMethod: false` (e.g., `http.Get(...)`) when the receiver matches an
    // import alias; treat those as method-like for routing purposes.
    const isMethodLike = call.isMethod || (lang === 'go' && !!call.receiver && !call.isPathCall);
    if (isMethodLike && call.receiver) {
        for (const p of conf.receivers) {
            if (!p.receiverPattern.test(call.receiver)) continue;
            if (!p.methodPattern.test(call.name)) continue;

            // Determine method
            const methodName = call.name.toLowerCase();
            // Java webClient.get().uri('/path') — `uri` is the actual path-bearing call,
            // but the HTTP method must be inferred from the chained .get() — too complex,
            // we tag as ALL.
            let method;
            let inferred = false;
            if (lang === 'csharp' && methodName.endsWith('async')) {
                const verb = methodName.slice(0, -'async'.length);
                if (verb === 'send') {
                    method = 'ALL';
                    inferred = true;
                } else {
                    method = verb.toUpperCase();
                }
            } else if (methodName === 'uri') {
                // Java pattern: rest of the chain — we can't easily extract method, use ALL
                method = 'ALL';
                inferred = true;
            } else if (methodName === 'do' || methodName === 'newrequest' || methodName === 'send' || methodName === 'exchange' || methodName === 'request') {
                // Generic — can't determine method
                method = 'ALL';
                inferred = true;
            } else if (methodName === 'getforobject' || methodName === 'getforentity') {
                method = 'GET';
            } else if (methodName === 'postforobject' || methodName === 'postforentity' || methodName === 'postform') {
                method = 'POST';
            } else if (methodName === 'putforobject') {
                method = 'PUT';
            } else {
                method = methodName.toUpperCase();
            }
            return { method, framework: p.framework, methodInferred: inferred };
        }
    }

    // 3) Path-call (Rust): scoped_identifier reqwest::get('/path')
    if (lang === 'rust' && call.isPathCall && call.receiver) {
        // call.receiver = 'reqwest' or similar; call.name = 'get'/'post'/etc.
        const verb = call.name.toLowerCase();
        if (['get','post','put','delete','patch','head','options'].includes(verb)) {
            return { method: verb.toUpperCase(), framework: 'reqwest', methodInferred: false };
        }
    }

    return null;
}

/**
 * Best-effort detection of fetch('/p', { method: 'POST' }) by looking at the
 * surrounding raw call. Without full AST access here, we read the call line
 * from the cached calls array (no I/O). Only returns explicit method or null.
 */
function inferMethodFromFetchOptions(_call) {
    // We don't have the args AST in the call cache; bail and let caller default to GET.
    // A future enhancement could capture a `optionsMethod` field at parse time.
    return null;
}

// ============================================================================
// PATH MATCHING
// ============================================================================

/**
 * Match each client request against server routes.
 * Returns array of { route, request, confidence, matchType, methodInferred }.
 *
 * Match types:
 *   exact   — same canonical path, exact method match
 *   partial — server has wildcards, client supplies literal that the wildcard
 *             form matches; OR client has wildcards, server has literal/wildcard
 *   uncertain — interpolated client path partially overlaps server's literal prefix
 */
function bridgeEndpoints(index) {
    if (index._endpointsCache && index._endpointsCache.bridges) {
        return index._endpointsCache.bridges;
    }
    const routes = extractServerRoutes(index);
    const requests = extractClientRequests(index);

    // Bucket routes by HTTP method for cheap pruning
    const routesByMethod = new Map();
    for (const r of routes) {
        const list = routesByMethod.get(r.method) || [];
        list.push(r);
        routesByMethod.set(r.method, list);
        // ALL routes match every method
    }
    const allRoutes = routesByMethod.get('ALL') || [];
    // Same-file-only requests (in-process injection) consult only their own
    // file's routes: the same bucket order, pre-split by file.
    let routesByMethodFile = null;
    const fileBucket = (method, file) => {
        if (!routesByMethodFile) {
            routesByMethodFile = new Map();
            for (const [method, list] of routesByMethod) {
                const byFile = new Map();
                for (const r of list) {
                    const bucket = byFile.get(r.absoluteFile);
                    if (bucket) bucket.push(r);
                    else byFile.set(r.absoluteFile, [r]);
                }
                routesByMethodFile.set(method, byFile);
            }
        }
        return routesByMethodFile.get(method)?.get(file) || [];
    };

    const bridges = [];
    // Every container key some route is served from (fix #392).
    let servedAppKeys = null;
    const servedApps = () => {
        if (!servedAppKeys) {
            servedAppKeys = new Set();
            for (const r of routes) for (const key of r.appKeys || []) servedAppKeys.add(key);
            for (const key of index._endpointsCache?.routeContainers || []) servedAppKeys.add(key);
        }
        return servedAppKeys;
    };
    // The app an in-process client request is served by (fix #392).
    let pyClients = null;
    let jsClients = null;
    const servedBy = (req) => {
        if (req.jsClientApp) {
            if (!jsClients) {
                jsClients = new (require('./inprocess-clients').JsClientResolver)(
                    index, endpointsSession(index), index._endpointsCache?.jsRouteGraph || null);
            }
            return jsClients.resolve(req.absoluteFile, req.jsClientApp.start, req.jsClientApp.end);
        }
        if (!req.clientCall) return null;
        if (!pyClients) {
            pyClients = new (require('./inprocess-clients').PythonClientResolver)(
                index, endpointsSession(index), servedApps);
        }
        return pyClients.resolve(req.absoluteFile, req.line, req.clientCall.receiver, req.clientCall.name);
    };

    for (const req of requests) {
        const candidates = [];
        // Pull buckets compatible with the request's method (or ALL when inferred)
        const methodKey = req.method;
        if (req.sameFileOnly) {
            const methods = req.methodInferred ? [...routesByMethod.keys()]
                : methodKey === 'HEAD' ? [methodKey, 'ALL', 'GET'] : [methodKey, 'ALL'];
            for (const method of methods) {
                for (const r of fileBucket(method, req.absoluteFile)) candidates.push(r);
            }
        } else if (req.methodInferred) {
            // Could match any method-bucket; but typical: try GET, then ALL
            for (const list of routesByMethod.values()) {
                for (const r of list) candidates.push(r);
            }
        } else {
            const list = routesByMethod.get(methodKey) || [];
            for (const r of list) candidates.push(r);
            for (const r of allRoutes) candidates.push(r);
            if (methodKey === 'HEAD') {
                for (const r of routesByMethod.get('GET') || []) {
                    if (HEAD_SERVED_BY_GET.has(r.framework)) candidates.push(r);
                }
            }
        }

        const found = [];
        for (const route of candidates) {
            if (req.sameFileOnly && route.absoluteFile !== req.absoluteFile) continue;
            const match = matchPath(route, req);
            if (!match) continue;

            // Method matching contributes to confidence
            const methodMatches = methodMatch(route.method, req.method, route.framework);
            if (!methodMatches.ok) continue;

            const confidence = scoreMatch(match.matchType, methodMatches);
            found.push({
                route,
                request: req,
                matchType: match.matchType,
                methodInferred: methodMatches.inferred,
                confidence,
            });
        }
        // An in-process injection hits the instance its own test built:
        // prefer routes registered inside the request's enclosing function,
        // else any route of the file.
        const inScope = req.scopeLines
            ? found.filter(b => b.route.line >= req.scopeLines[0] && b.route.line <= req.scopeLines[1])
            : [];
        // A client built from an app reaches only that app's routes (fix
        // #392); an app whose routes the model does not hold, or a client
        // whose app did not resolve, keeps every path match, marked unscoped.
        const served = found.length > 0 ? servedBy(req) : null;
        // An app declared as a function or class serves the request itself.
        if (served?.noRoutes) continue;
        // A JS client's app (fix #397): the routes whose router is the app
        // or is mounted under it; a route whose router the graph did not
        // key stays a possible match, marked unscoped.
        if (served?.jsAppKey) {
            // The app's keyed routes are its routes when the app is a proven
            // router value (an `express()` / `new Koa()` binding) or some
            // matching route is keyed to it; an app serving only middleware
            // then bridges nowhere. A route the graph cannot key stays a
            // possible match, marked unscoped.
            const verdicts = found.map(b => jsClients.routeServedBy(b.route, served.jsAppKey));
            const servesApp = jsClients.isRouterValue(served.jsAppKey) || verdicts.includes(true);
            found.forEach((b, i) => {
                if (verdicts[i] === null || !servesApp) bridges.push({ ...b, unscoped: true });
                else if (verdicts[i]) bridges.push(b);
            });
            continue;
        }
        if (served?.appKey && servedApps().has(served.appKey)) {
            for (const b of found) if (b.route.appKeys?.has(served.appKey)) bridges.push(b);
            continue;
        }
        if (served?.appKey || served?.inProcess) {
            for (const b of found) bridges.push({ ...b, unscoped: true });
            continue;
        }
        for (const b of (inScope.length > 0 || req.scopeOnly ? inScope : found)) bridges.push(b);
    }

    // For each (request) keep all matches but sort with best first
    bridges.sort((a, b) => {
        // Group by request first
        const reqCmpFile = codeUnitCompare(a.request.file, b.request.file);
        if (reqCmpFile !== 0) return reqCmpFile;
        if (a.request.line !== b.request.line) return a.request.line - b.request.line;
        // Then by confidence desc
        if (a.confidence !== b.confidence) return b.confidence - a.confidence;
        // Then by route file/line
        if (a.route.file !== b.route.file) return codeUnitCompare(a.route.file, b.route.file);
        return a.route.line - b.route.line;
    });

    if (!index._endpointsCache) index._endpointsCache = {};
    index._endpointsCache.bridges = bridges;
    return bridges;
}

/** True iff route method and client method are compatible. */
// Frameworks that answer HEAD with a GET route's handler (Starlette `Route`
// adds HEAD to GET, Flask/werkzeug and Express route HEAD to GET).
const HEAD_SERVED_BY_GET = new Set(['starlette', 'flask', 'express']);

function methodMatch(routeMethod, clientMethod, framework = null) {
    if (routeMethod === 'ALL' || clientMethod === 'ALL') {
        return { ok: true, inferred: true };
    }
    // 'USE' covers all methods
    if (routeMethod === 'USE') return { ok: true, inferred: true };
    if (clientMethod === 'HEAD' && routeMethod === 'GET' && HEAD_SERVED_BY_GET.has(framework)) {
        return { ok: true, inferred: false };
    }
    return { ok: routeMethod === clientMethod, inferred: false };
}

// Per-route facts of its raw path, computed once per route object: an
// unresolved part (`{?expr}`, not the proven any-text `{?*}`) and a trailing
// any-text part.
const routeShapeMemo = new WeakMap();
function routeShape(route) {
    let shape = routeShapeMemo.get(route);
    if (!shape) {
        const raw = typeof route.path === 'string' ? route.path : '';
        shape = {
            unresolved: raw.includes('{?') && raw.split(ANY_TEXT).join('').includes('{?'),
            anyTail: raw.endsWith(ANY_TEXT),
        };
        routeShapeMemo.set(route, shape);
    }
    return shape;
}

/**
 * Determine match type between server route and client request.
 * Returns {matchType: 'exact'|'partial'|'uncertain'} or null.
 */
function matchPath(route, req) {
    // ASP.NET routing is case-insensitive (fix #366).
    const sNorm = route.caseInsensitive ? route.normalizedPath.toLowerCase() : route.normalizedPath;
    const cNorm = route.caseInsensitive ? req.normalizedPath.toLowerCase() : req.normalizedPath;
    if (sNorm === '' || cNorm === '') return null;
    // A route behind an unresolved part (`{?expr}` -> '**') matches only as
    // uncertain: the value is not proven. A proven catch-all ('**' from a
    // path converter or `*name`) matches like any other parameter.
    // Unresolved parts and any-text parts both normalize to '**'.
    const shape = sNorm.includes('**') ? routeShape(route) : null;
    if (shape && shape.unresolved) {
        return wildcardMatches(sNorm, cNorm) ? { matchType: 'uncertain' } : null;
    }

    // Exact: both canonical paths identical AND neither has wildcards.
    if (sNorm === cNorm) {
        const hasWild = sNorm.includes('*');
        if (hasWild) {
            // A client path TEMPLATE (`/users/{id}`, generated SDKs) whose
            // parameters sit exactly where the route's do is the same
            // endpoint (fix #366); a literal/interpolated client value that
            // only fits the wildcard stays partial.
            const template = !req.interp && /\{[A-Za-z_][^}?]*\}|:[A-Za-z_]/.test(req.path || '');
            return { matchType: template ? 'exact' : 'partial' };
        }
        return { matchType: 'exact' };
    }

    // Wildcard match: server has wildcards; client has literal. A Django
    // regex view without `$` (a trailing `{?*}`) also serves its bare prefix.
    if (sNorm.includes('*') && wildcardMatches(sNorm, cNorm, !!shape && shape.anyTail)) {
        return { matchType: 'partial' };
    }

    // Reverse: client wildcard against server literal/wildcard.
    if (cNorm.includes('*') && req.interp) {
        // Treat the client wildcard like a single path segment (`*` ≡ `[^/]+`).
        // The client's `/users/*` should match the server's `/users/:id`
        // (also normalized to `/users/*`) but NOT `/users/create` because that's
        // a fixed literal segment, not a parameter slot.
        if (wildcardMatches(cNorm, sNorm)) {
            return { matchType: 'uncertain' };
        }
        // Looser fallback: if both share a literal prefix and the server has
        // a wildcard at the position the client truncated to, accept partial.
        const cPrefix = cNorm.replace(/\*+$/g, '');
        if (sNorm.startsWith(cPrefix) && sNorm.includes('*')) {
            return { matchType: 'uncertain' };
        }
    }

    return null;
}

/*
 * Check if a wildcard-bearing pattern matches a literal path.
 * Each '*' in the pattern matches a single non-empty path segment.
 *   /users/(*)           vs /users/123          → true
 *   /users/(*)/posts/(*) vs /users/1/posts/2    → true
 *   /users/(*)           vs /users/1/2          → false  (single segment)
 *   /users/(*)           vs /users              → false
 */
const wildcardRegexCache = new Map();

function wildcardMatches(pattern, literal, optionalTail = false) {
    // The anchored regex starts with the pattern's literal text up to the
    // first wildcard: a literal that does not start with it cannot match.
    // An optional trailing '/**' does not require its '/'.
    const tail = optionalTail && pattern.endsWith('/**');
    const star = pattern.indexOf('*');
    const prefixEnd = tail && star === pattern.length - 2 ? star - 1 : star;
    if (prefixEnd > 0 && !literal.startsWith(pattern.slice(0, prefixEnd))) return false;
    const key = tail ? `${pattern}\0tail` : pattern;
    let re = wildcardRegexCache.get(key);
    if (!re) {
        re = wildcardRegex(pattern, tail);
        // Patterns come from one project's routes; bound the memo anyway.
        if (wildcardRegexCache.size > 20000) wildcardRegexCache.clear();
        wildcardRegexCache.set(key, re);
    }
    return re.test(literal);
}

function wildcardRegex(pattern, optionalTail = false) {
    // Build a regex from the pattern: '*' → one segment's text ('[^/]+');
    // '**' (a catch-all or an unresolved part, fix #366/#383) → non-empty
    // text that may span segments. With `optionalTail`, a trailing '/**'
    // (text that may also be empty) may be absent: a canonical path has no
    // trailing slash.
    const trailing = optionalTail && pattern.endsWith('/**');
    const body = trailing ? pattern.slice(0, -3) : pattern;
    const escaped = body
        .split('**')
        .map(part => part
            .split('*')
            .map(seg => seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
            .join('[^/]+'))
        .join('.+');
    return new RegExp('^' + escaped + (trailing ? '(?:/.+)?' : '') + '$');
}

/** Numeric confidence based on match type and method certainty. */
function scoreMatch(matchType, methodCheck) {
    let base;
    if (matchType === 'exact') base = 1.0;
    else if (matchType === 'partial') base = 0.85;
    else base = 0.6; // uncertain
    if (methodCheck.inferred) base -= 0.1;
    return Math.max(0, Math.min(1, base));
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Reset the endpoints cache. Called by index rebuild paths.
 */
function clearEndpointsCache(index) {
    index._endpointsCache = null;
}

/**
 * Top-level entry: detect endpoints, optionally bridge clients to servers.
 *
 * @param {object} index - ProjectIndex
 * @param {object} [options]
 * @param {boolean} [options.bridge=false]      - Compute server↔client bridges
 * @param {boolean} [options.serverOnly=false]
 * @param {boolean} [options.clientOnly=false]
 * @param {boolean} [options.unmatched=false]   - Only return unmatched routes/requests
 * @param {string}  [options.method]            - Filter by HTTP method
 * @param {string}  [options.prefix]            - Filter by path prefix (literal)
 * @param {boolean} [options.showUncertain=true]
 * @returns {object} { routes, requests, bridges, unmatchedRoutes, unmatchedRequests, meta }
 */
function endpoints(index, options = {}) {
    const opts = {
        bridge: !!options.bridge,
        serverOnly: !!options.serverOnly,
        clientOnly: !!options.clientOnly,
        unmatched: !!options.unmatched,
        method: options.method ? String(options.method).toUpperCase() : null,
        prefix: options.prefix || null,
        showUncertain: options.showUncertain !== false,
    };

    const testByFile = new Map();
    const label = r => {
        let isTest = testByFile.get(r.file);
        if (isTest === undefined) {
            isTest = isTestPath(r.file);
            testByFile.set(r.file, isTest);
        }
        return { ...r, isTest };
    };
    const inScope = r => (!options.in || index.matchesFilters(r.file, { in: options.in })) &&
        !(options.excludeTests && r.isTest);
    let routes = (opts.clientOnly ? [] : extractServerRoutes(index)).map(label).filter(inScope);
    let requests = (opts.serverOnly ? [] : extractClientRequests(index)).map(label).filter(inScope);
    let uncertainRequests = (opts.serverOnly ? [] : (index._endpointsCache?.uncertainRequests || [])).map(label).filter(inScope);
    if (uncertainRequests.length > 0) {
        // A server route registration (`@app.get("/x")`, `router.get("/x", h)`)
        // is request-shaped too; the route inventory already owns those lines.
        const routeLines = new Set(extractServerRoutes(index).map(r => `${r.absoluteFile}:${r.line}`));
        uncertainRequests = uncertainRequests.filter(r => !routeLines.has(`${r.absoluteFile}:${r.line}`));
    }

    // Apply filters
    if (opts.method) {
        routes = routes.filter(r => r.method === opts.method || r.method === 'ALL' || r.method === 'USE');
        requests = requests.filter(r => r.method === opts.method || r.method === 'ALL');
    }
    if (opts.prefix) {
        routes = routes.filter(r => r.path.startsWith(opts.prefix) || r.normalizedPath.startsWith(opts.prefix));
        requests = requests.filter(r => r.path.startsWith(opts.prefix) || r.normalizedPath.startsWith(opts.prefix));
        uncertainRequests = uncertainRequests.filter(r => r.path.startsWith(opts.prefix));
    }
    if (opts.method) {
        uncertainRequests = uncertainRequests.filter(r => r.method.toUpperCase() === opts.method || r.method === 'request');
    }

    let bridges = opts.bridge ? bridgeEndpoints(index).map(b => ({
        ...b, route: label(b.route), request: label(b.request),
    })) : [];
    if (!opts.showUncertain) {
        bridges = bridges.filter(b => b.matchType !== 'uncertain');
    }
    // If user filtered routes/requests, also constrain bridges
    if (opts.method || opts.prefix || options.in || options.excludeTests) {
        const routeKeys = new Set(routes.map(r => `${r.absoluteFile}:${r.line}:${r.method}:${r.path}`));
        const reqKeys = new Set(requests.map(r => `${r.absoluteFile}:${r.line}:${r.method}:${r.path}`));
        bridges = bridges.filter(b =>
            routeKeys.has(`${b.route.absoluteFile}:${b.route.line}:${b.route.method}:${b.route.path}`) &&
            reqKeys.has(`${b.request.absoluteFile}:${b.request.line}:${b.request.method}:${b.request.path}`)
        );
    }

    // Compute unmatched
    let unmatchedRoutes = [];
    let unmatchedRequests = [];
    if (opts.bridge || opts.unmatched) {
        const matchedRouteKeys = new Set();
        const matchedRequestKeys = new Set();
        for (const b of bridges) {
            matchedRouteKeys.add(`${b.route.absoluteFile}:${b.route.line}:${b.route.method}:${b.route.path}`);
            matchedRequestKeys.add(`${b.request.absoluteFile}:${b.request.line}:${b.request.method}:${b.request.path}`);
        }
        unmatchedRoutes = routes.filter(r => !matchedRouteKeys.has(`${r.absoluteFile}:${r.line}:${r.method}:${r.path}`));
        unmatchedRequests = requests.filter(r => !matchedRequestKeys.has(`${r.absoluteFile}:${r.line}:${r.method}:${r.path}`));
    }

    // Group counts
    const byFramework = {};
    for (const r of routes) {
        byFramework[r.framework] = (byFramework[r.framework] || 0) + 1;
    }

    return {
        // Endpoint extraction is AST-based but bounded to known framework
        // patterns; a missing route is never proof that no endpoint exists.
        // Bridge matching adds a second heuristic layer.
        advisory: opts.bridge
            ? 'heuristic-route-matching-and-incomplete-inventory'
            : 'incomplete-endpoint-inventory',
        routes,
        requests,
        uncertainRequests,
        bridges,
        unmatchedRoutes,
        unmatchedRequests,
        meta: {
            totalRoutes: routes.length,
            totalRequests: requests.length,
            uncertainRequests: uncertainRequests.length,
            totalBridges: bridges.length,
            unmatchedRoutes: unmatchedRoutes.length,
            unmatchedRequests: unmatchedRequests.length,
            byFramework,
        },
    };
}

module.exports = {
    endpoints,
    extractServerRoutes,
    extractClientRequests,
    bridgeEndpoints,
    clearEndpointsCache,
    normalizePath,
    joinRoutePath,
    wildcardMatches,
};
