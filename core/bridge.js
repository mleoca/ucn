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
 * (decoratorsWithArgs/annotationsWithArgs/attributesWithArgs). The only file
 * I/O is index-driven; we never re-parse files. Extraction results are cached
 * lazily on `index._endpointsCache` and invalidated on rebuild via the same
 * mechanism as `_reachableSymbols`.
 *
 * Output shape:
 *   serverRoutes: [{ method, path, normalizedPath, handler, file, line, framework, raw }]
 *   clientRequests: [{ method, path, normalizedPath, file, line, callerName, callerStartLine,
 *                       framework, interp }]
 *   bridges: [{ route, request, confidence, methodInferred, matchType }]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getCachedCalls } = require('./callers');
const { langTraits } = require('../languages');

// ============================================================================
// HTTP METHOD CONSTANTS
// ============================================================================

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'ALL', 'USE']);

// ============================================================================
// PATH NORMALIZATION
// ============================================================================

/**
 * Canonicalize a route path: strip query string, trailing slash, normalize
 * all parameter syntaxes to a single token (`*`).
 *
 * Examples:
 *   /users/:id            → /users/*
 *   /users/{id}           → /users/*
 *   /users/<int:user_id>  → /users/*
 *   /users/<id>/          → /users/*
 *   /users?q=foo          → /users
 *
 * @param {string} p - Raw path
 * @returns {string} Canonical path
 */
function normalizePath(p) {
    if (typeof p !== 'string' || !p) return '';
    let s = p;
    // Strip query string and fragment
    const q = s.indexOf('?');
    if (q !== -1) s = s.slice(0, q);
    const h = s.indexOf('#');
    if (h !== -1) s = s.slice(0, h);
    // Strip trailing slash (but keep "/")
    if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
    // Normalize all parameter forms to '*'
    //   :param            → Express/Koa/Rails/fastify
    //   {param}           → Spring/OpenAPI
    //   <param>           → Flask
    //   <converter:param> → Flask typed
    // Flask <converter:name> or <name> — replace BEFORE colon-prefix params so we don't
    // see e.g. `<int:user>` as an unmatched colon-form first.
    s = s.replace(/<[^>]+>/g, '*');
    // Spring/OpenAPI {param}
    s = s.replace(/\{[^}]+\}/g, '*');
    // Express/Koa/Rails :param
    s = s.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '*');
    return s;
}

/** Join a class-level prefix with a method-level path. */
function joinRoutePath(prefix, sub) {
    const p = (prefix || '').replace(/\/+$/, '');
    const s = (sub || '').replace(/^\/+/, '');
    if (!p && !s) return '/';
    if (!s) return p || '/';
    if (!p) return '/' + s;
    return p + '/' + s;
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
              methodPattern: /^(Get|Post|PostForm|Head|Do|NewRequest)$/,
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
};

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

// ============================================================================
// EXTRACT SERVER ROUTES
// ============================================================================

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

    // 1) Decorator/annotation/attribute-based routes (NestJS, Flask/FastAPI, Spring, JAX-RS, Actix).
    //    Iterate symbols once and look at their decoratorsWithArgs/annotationsWithArgs/attributesWithArgs.
    //    Class-level prefixes are captured first then applied to methods inside the same class.
    const classPrefixByFileClass = new Map(); // `${file}:${className}` -> prefix string
    for (const [, syms] of index.symbols) {
        for (const sym of syms) {
            const fileEntry = index.files.get(sym.file);
            if (!fileEntry) continue;

            // CLASS-LEVEL prefix capture
            if (sym.type === 'class' || sym.type === 'interface') {
                const prefixes = collectClassPrefixes(sym, fileEntry.language);
                if (prefixes.length > 0) {
                    classPrefixByFileClass.set(`${sym.file}:${sym.name}`, prefixes[0]);
                }
            }
        }
    }

    for (const [, syms] of index.symbols) {
        for (const sym of syms) {
            const fileEntry = index.files.get(sym.file);
            if (!fileEntry) continue;
            const lang = fileEntry.language;
            // Only methods/functions are HTTP handlers; classes already produced prefixes above.
            if (sym.type !== 'function' && sym.type !== 'method' && !sym.isMethod) continue;

            // Resolve class prefix if this is a method on a controller class
            let classPrefix = '';
            if (sym.className) {
                classPrefix = classPrefixByFileClass.get(`${sym.file}:${sym.className}`) || '';
            }

            const declRoutes = collectMethodRoutes(sym, lang, classPrefix);
            for (const r of declRoutes) {
                routes.push({
                    method: r.method,
                    path: r.path,
                    normalizedPath: normalizePath(r.path),
                    handler: sym.name,
                    file: sym.relativePath || sym.file,
                    absoluteFile: sym.file,
                    line: sym.startLine,
                    framework: r.framework,
                    classPrefix: classPrefix || undefined,
                    raw: r.raw || `${r.method} ${r.path}`,
                });
            }
        }
    }

    // 2) Call-pattern routes (Express/Fastify/Koa/Gin/Echo/Chi/Fiber, axum, http).
    //    Iterate calls once per file via the call cache.
    for (const [filePath, fileEntry] of index.files) {
        const lang = fileEntry.language;
        const calls = getCachedCalls(index, filePath);
        if (!calls || calls.length === 0) continue;

        for (const call of calls) {
            const r = matchCallPatternRoute(call, lang);
            if (!r) continue;

            // Resolve handler name from arg position 1 if call.firstStringArg is set.
            // The handler reference is captured as a separate `isPotentialCallback`
            // call on the same line — we look for it.
            const handlerName = findHandlerCallback(calls, call.line, call) || '<anonymous>';

            routes.push({
                method: r.method,
                path: r.path,
                normalizedPath: normalizePath(r.path),
                handler: handlerName,
                file: fileEntry.relativePath || filePath,
                absoluteFile: filePath,
                line: call.line,
                framework: r.framework,
                raw: `${r.method} ${r.path}`,
            });
        }
    }

    // 3) Next.js file-based routes — only scan if `pages/` or `app/` exists at root.
    const nextRoutes = extractNextjsRoutes(index);
    for (const r of nextRoutes) routes.push(r);

    // Sort deterministically (file, line, method, path)
    routes.sort((a, b) => {
        if (a.file !== b.file) return a.file.localeCompare(b.file);
        if (a.line !== b.line) return a.line - b.line;
        if (a.method !== b.method) return a.method.localeCompare(b.method);
        return a.path.localeCompare(b.path);
    });

    // Cache it
    if (!index._endpointsCache) index._endpointsCache = {};
    index._endpointsCache.serverRoutes = routes;

    return routes;
}

/** Return the list of class-level path prefixes for a class symbol. */
function collectClassPrefixes(sym, lang) {
    const prefixes = [];
    // JS/TS decorators
    if ((lang === 'javascript' || lang === 'typescript' || lang === 'tsx') && sym.decoratorsWithArgs) {
        for (const d of sym.decoratorsWithArgs) {
            if (PREFIX_DECORATORS.has(d.name) && d.firstStringArg != null) {
                prefixes.push(d.firstStringArg);
            }
        }
    }
    // Java annotations: @RequestMapping("/api"), @Path("/api")
    if (lang === 'java' && sym.annotationsWithArgs) {
        for (const a of sym.annotationsWithArgs) {
            if (PREFIX_ANNOTATIONS.has(a.name) && a.firstStringArg != null) {
                prefixes.push(a.firstStringArg);
            }
        }
    }
    return prefixes;
}

/**
 * Return zero or more route objects {method, path, framework, raw} for a method/function symbol.
 */
function collectMethodRoutes(sym, lang, classPrefix) {
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
            const r = parsePythonDecoratorFull(decRaw);
            if (r) {
                out.push({
                    method: r.method,
                    path: r.path,
                    framework: r.framework,
                });
            }
        }
    }

    // ── Java annotations (Spring, JAX-RS) ────────────────────────────
    if (lang === 'java' && sym.annotationsWithArgs) {
        // Track JAX-RS @Path + @GET pattern: @Path supplies path, @GET supplies method.
        let jaxrsPath = null;
        const jaxrsMethods = [];
        for (const a of sym.annotationsWithArgs) {
            const meth = METHOD_DECORATORS[a.name];
            if (a.name === 'Path' && a.firstStringArg != null) {
                jaxrsPath = a.firstStringArg;
                continue;
            }
            if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(a.name) && a.firstStringArg == null) {
                jaxrsMethods.push(a.name);
                continue;
            }
            if (a.name === 'RequestMapping') {
                // Try to detect method= attribute in args
                const detectedMethod = parseSpringRequestMappingMethod(a.args) || 'ALL';
                const sub = a.firstStringArg || '';
                out.push({
                    method: detectedMethod,
                    path: joinRoutePath(classPrefix, sub) || '/',
                    framework: 'spring',
                });
                continue;
            }
            if (meth) {
                // Spring @GetMapping, @PostMapping, etc.
                const sub = a.firstStringArg || '';
                out.push({
                    method: meth,
                    path: joinRoutePath(classPrefix, sub) || '/',
                    framework: 'spring',
                });
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

    return out;
}

/**
 * Parse a Python decorator raw string like:
 *   "app.route('/users', methods=['GET'])"
 *   "app.get('/users/<int:user_id>')"
 *   "router.post('/items')"
 * Returns { method, path, framework } or null.
 */
function parsePythonDecoratorFull(raw) {
    if (typeof raw !== 'string') return null;
    // Match receiver.verb('path', ...)
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\.([a-z]+)\s*\(\s*(['"])([^'"]*)\3/);
    if (!m) return null;
    const verb = m[2];
    const pathStr = m[4];
    if (verb === 'route') {
        // Methods= attr
        const methodsMatch = raw.match(/methods\s*=\s*\[(.*?)\]/);
        if (methodsMatch) {
            const methods = methodsMatch[1].split(',').map(s => s.trim().replace(/['"]/g, '').toUpperCase()).filter(Boolean);
            // Caller will receive ONE entry; we return GET if methods empty, else first.
            if (methods.length > 0) {
                return { method: methods[0], path: pathStr, framework: 'flask' };
            }
        }
        return { method: 'GET', path: pathStr, framework: 'flask' };
    }
    if (['get','post','put','delete','patch','options','head'].includes(verb)) {
        return { method: verb.toUpperCase(), path: pathStr, framework: 'fastapi' };
    }
    return null;
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

/**
 * Match a call against server route patterns. Returns {method, path, framework} or null.
 */
function matchCallPatternRoute(call, lang) {
    if (!call.firstStringArg) return null;

    // Path-call patterns (Rust): handled outside (router.route, router.nest captured below)
    const patterns = SERVER_RECEIVER_PATTERNS[lang];
    if (!patterns || patterns.length === 0) return null;

    // For Express/Gin/etc, the call is method-call: app.get('/path', handler)
    for (const p of patterns) {
        if (!call.receiver) continue;
        if (!p.receiverPattern.test(call.receiver)) continue;
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
    for (const c of calls) {
        if (c === exclude) continue;
        if (c.line !== line) continue;
        if (c.isPotentialCallback || c.isFunctionReference) {
            return c.name;
        }
    }
    // Fallback: any non-method call on the same line
    for (const c of calls) {
        if (c === exclude) continue;
        if (c.line !== line) continue;
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
                normalizedPath: normalizePath(routePath),
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
                    normalizedPath: normalizePath(routePath),
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
function extractClientRequests(index) {
    if (index._endpointsCache && index._endpointsCache.clientRequests) {
        return index._endpointsCache.clientRequests;
    }
    const requests = [];

    for (const [filePath, fileEntry] of index.files) {
        const lang = fileEntry.language;
        const calls = getCachedCalls(index, filePath);
        if (!calls || calls.length === 0) continue;

        for (const call of calls) {
            if (!call.firstStringArg) continue;
            const r = matchClientRequest(call, lang, calls);
            if (!r) continue;

            const callerName = call.enclosingFunction?.name || '<top-level>';
            const callerStartLine = call.enclosingFunction?.startLine;

            requests.push({
                method: r.method,
                path: call.firstStringArg,
                normalizedPath: normalizePath(call.firstStringArg),
                interp: !!call.firstStringArgInterp,
                file: fileEntry.relativePath || filePath,
                absoluteFile: filePath,
                line: call.line,
                callerName,
                callerStartLine,
                framework: r.framework,
                methodInferred: r.methodInferred,
            });
        }
    }

    // Stable sort
    requests.sort((a, b) => {
        if (a.file !== b.file) return a.file.localeCompare(b.file);
        if (a.line !== b.line) return a.line - b.line;
        if (a.method !== b.method) return a.method.localeCompare(b.method);
        return a.path.localeCompare(b.path);
    });

    if (!index._endpointsCache) index._endpointsCache = {};
    index._endpointsCache.clientRequests = requests;
    return requests;
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
            if (methodName === 'uri') {
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

    const bridges = [];

    for (const req of requests) {
        const candidates = [];
        // Pull buckets compatible with the request's method (or ALL when inferred)
        const methodKey = req.method;
        if (req.methodInferred) {
            // Could match any method-bucket; but typical: try GET, then ALL
            for (const list of routesByMethod.values()) {
                for (const r of list) candidates.push(r);
            }
        } else {
            const list = routesByMethod.get(methodKey) || [];
            for (const r of list) candidates.push(r);
            for (const r of allRoutes) candidates.push(r);
        }

        for (const route of candidates) {
            const match = matchPath(route, req);
            if (!match) continue;

            // Method matching contributes to confidence
            const methodMatches = methodMatch(route.method, req.method);
            if (!methodMatches.ok) continue;

            const confidence = scoreMatch(match.matchType, methodMatches);
            bridges.push({
                route,
                request: req,
                matchType: match.matchType,
                methodInferred: methodMatches.inferred,
                confidence,
            });
        }
    }

    // For each (request) keep all matches but sort with best first
    bridges.sort((a, b) => {
        // Group by request first
        const reqCmpFile = a.request.file.localeCompare(b.request.file);
        if (reqCmpFile !== 0) return reqCmpFile;
        if (a.request.line !== b.request.line) return a.request.line - b.request.line;
        // Then by confidence desc
        if (a.confidence !== b.confidence) return b.confidence - a.confidence;
        // Then by route file/line
        if (a.route.file !== b.route.file) return a.route.file.localeCompare(b.route.file);
        return a.route.line - b.route.line;
    });

    if (!index._endpointsCache) index._endpointsCache = {};
    index._endpointsCache.bridges = bridges;
    return bridges;
}

/** True iff route method and client method are compatible. */
function methodMatch(routeMethod, clientMethod) {
    if (routeMethod === 'ALL' || clientMethod === 'ALL') {
        return { ok: true, inferred: true };
    }
    // 'USE' covers all methods
    if (routeMethod === 'USE') return { ok: true, inferred: true };
    return { ok: routeMethod === clientMethod, inferred: false };
}

/**
 * Determine match type between server route and client request.
 * Returns {matchType: 'exact'|'partial'|'uncertain'} or null.
 */
function matchPath(route, req) {
    const sNorm = route.normalizedPath;
    const cNorm = req.normalizedPath;
    if (sNorm === '' || cNorm === '') return null;

    // Exact: both canonical paths identical AND neither has wildcards.
    if (sNorm === cNorm) {
        const hasWild = sNorm.includes('*');
        if (hasWild) {
            return { matchType: 'partial' };
        }
        return { matchType: 'exact' };
    }

    // Wildcard match: server has wildcards; client has literal.
    if (sNorm.includes('*') && wildcardMatches(sNorm, cNorm)) {
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
function wildcardMatches(pattern, literal) {
    // Build a regex from the pattern: '*' → '[^/]+'
    const escaped = pattern
        .split('*')
        .map(seg => seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]+');
    const re = new RegExp('^' + escaped + '$');
    return re.test(literal);
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

    let routes = opts.clientOnly ? [] : extractServerRoutes(index);
    let requests = (opts.serverOnly ? [] : extractClientRequests(index));

    // Apply filters
    if (opts.method) {
        routes = routes.filter(r => r.method === opts.method || r.method === 'ALL' || r.method === 'USE');
        requests = requests.filter(r => r.method === opts.method || r.method === 'ALL');
    }
    if (opts.prefix) {
        routes = routes.filter(r => r.path.startsWith(opts.prefix) || r.normalizedPath.startsWith(opts.prefix));
        requests = requests.filter(r => r.path.startsWith(opts.prefix) || r.normalizedPath.startsWith(opts.prefix));
    }

    let bridges = opts.bridge ? bridgeEndpoints(index) : [];
    if (!opts.showUncertain) {
        bridges = bridges.filter(b => b.matchType !== 'uncertain');
    }
    // If user filtered routes/requests, also constrain bridges
    if (opts.method || opts.prefix) {
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
        // Advisory when bridging (v4 two-tier surface): route↔request
        // matching is heuristic (per-match tiers EXACT/PARTIAL/UNCERTAIN),
        // not a verified claim. Route/request EXTRACTION is AST-based.
        ...(opts.bridge && { advisory: 'heuristic-route-matching' }),
        routes,
        requests,
        bridges,
        unmatchedRoutes,
        unmatchedRequests,
        meta: {
            totalRoutes: routes.length,
            totalRequests: requests.length,
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
