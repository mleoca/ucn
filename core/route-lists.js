/**
 * core/route-lists.js - Declarative Python route tables for `endpoints`
 * (fix #373).
 *
 * Django, Starlette, aiohttp and Django REST framework declare routes as
 * DATA: `urlpatterns = [path(...), re_path(...), path("x/", include(...))]`,
 * `routes = [Route(...), Mount("/api", routes=[...])]`,
 * `app.add_routes([web.get(...)])`, `router.register("users", ViewSet)`.
 * Flask `add_url_rule`, Starlette/FastAPI `add_route` / `add_api_route` and
 * aiohttp `router.add_get` register imperatively on a proven app. None of
 * these are decorators, so the symbol-driven extraction never saw them.
 *
 * Model (all AST, over the files that import a routing constructor):
 *
 *   - A CONTAINER is a route list: a variable (`urlpatterns`, `routes`,
 *     `app = Starlette(routes=...)`, a DRF router, an aiohttp app), keyed by
 *     its declaring binding (`file:name` at module level, `file@scope:name`
 *     in a function), or an inline list / constructor call (`file#offset`).
 *   - A route constructor contributes a route to the container its value
 *     flows into (list elements, `+`, `*splat`, `urlpatterns += ...`,
 *     `.append/.extend`, `routes=` keyword arguments).
 *   - `include()`, `Mount`, `Host`, `add_subapp` and container references in
 *     a list are EDGES (target container served under the mounting
 *     container's prefixes + the edge prefix). Composition reuses the mount
 *     composition of core/bridge.js, so a Starlette/FastAPI app mounted
 *     inside a route list also composes with decorator routes.
 *   - `include("pkg.urls")` resolves the dotted module like an import (from
 *     the including file); the module's `urlpatterns` is the container.
 *     A module named by a `ROOT_URLCONF` setting is also a root.
 *
 * Route paths fold through core/route-graph.js constant evaluation; an
 * unprovable part is a disclosed `{?expr}` segment. An include/mount target
 * that cannot be resolved (external module, dynamic value) is never dropped:
 * it becomes a disclosed `prefix/{?target}` route (derived 'include' /
 * 'mount'). Regex routes (`re_path`, `url`) are normalized: named groups
 * become `<name>` parameters, unnamed groups `<argN>`, an optional trailing
 * slash is dropped, and the first construct with no path equivalent turns
 * the remainder into `{?regex}` (derived 'regex').
 *
 * Methods come from the view's own definition: Django `require_*` / DRF
 * `api_view` decorators, class-based view handlers (`get`/`post`/...,
 * inherited through project classes; framework base classes contribute
 * their documented handlers), Starlette `methods=` / function default GET,
 * DRF viewset actions. A view that cannot be resolved serves 'ALL'.
 */

'use strict';

const path = require('path');
const routeGraph = require('./route-graph');
const { resolveImport } = require('./imports');
const { splitParentList } = require('./graph-build');
const { getCachedCalls } = require('./callers');
const { getParser } = require('../languages');

const { field, namedChildren, unwrap, evalString, findDecl } = routeGraph;

// ============================================================================
// FRAMEWORK API ROLES (by defining module + exported name)
// ============================================================================

const ROLES = new Map([
    ['django.urls', { path: 'dj-path', re_path: 'dj-re-path', include: 'dj-include' }],
    ['django.conf.urls', { url: 'dj-re-path', re_path: 'dj-re-path', include: 'dj-include' }],
    ['django.conf.urls.i18n', { i18n_patterns: 'dj-i18n' }],
    ['django.conf.urls.static', { static: 'dj-static' }],
    ['starlette.routing', {
        Route: 'st-route', WebSocketRoute: 'st-ws', Mount: 'st-mount', Host: 'st-host', Router: 'st-router',
    }],
    ['fastapi.routing', {
        Route: 'st-route', WebSocketRoute: 'st-ws', Mount: 'st-mount', Host: 'st-host', APIRouter: 'st-router',
    }],
    ['starlette.applications', { Starlette: 'st-app' }],
    ['starlette.staticfiles', { StaticFiles: 'st-static' }],
    ['fastapi.staticfiles', { StaticFiles: 'st-static' }],
    ['fastapi', { FastAPI: 'st-app', APIRouter: 'st-router' }],
    ['rest_framework.routers', { DefaultRouter: 'drf-router', SimpleRouter: 'drf-router' }],
    ['aiohttp.web', {
        get: 'aio-verb', post: 'aio-verb', put: 'aio-verb', patch: 'aio-verb', delete: 'aio-verb',
        head: 'aio-verb', options: 'aio-verb', route: 'aio-route', view: 'aio-view', static: 'aio-static',
        Application: 'aio-app', RouteTableDef: 'aio-table',
    }],
]);

// Roles whose presence makes a file worth parsing (constructors that hold or
// declare routes; container-only roles such as FastAPI() do not).
const ANCHOR_ROLES = new Set([
    'dj-path', 'dj-re-path', 'dj-include', 'dj-i18n', 'dj-static',
    'st-route', 'st-ws', 'st-mount', 'st-host', 'st-router', 'st-app',
    'drf-router', 'aio-verb', 'aio-route', 'aio-view', 'aio-static', 'aio-app',
]);

// Imperative registration methods, proven by the receiver's framework.
const METHOD_REGISTRATIONS = new Map([
    ['add_url_rule', 'flask'],
    ['add_route', 'starlette'],
    ['add_websocket_route', 'starlette'],
    ['add_api_route', 'starlette'],
    ['add_api_websocket_route', 'starlette'],
]);
const AIO_ROUTER_METHODS = {
    add_get: 'GET', add_post: 'POST', add_put: 'PUT', add_patch: 'PATCH', add_delete: 'DELETE',
    add_head: 'HEAD', add_options: 'OPTIONS', add_route: null, add_view: 'VIEW', add_static: 'STATIC',
};

// Modules whose import proves a receiver-registered framework in the file.
const FRAMEWORK_MODULES = {
    flask: /^flask(\.|$)/,
    starlette: /^(starlette|fastapi)(\.|$)/,
};

const REGISTRATION_NAMES = new Set([
    ...METHOD_REGISTRATIONS.keys(), ...Object.keys(AIO_ROUTER_METHODS),
    'mount', 'add_routes', 'add_subapp', 'append', 'extend', 'insert', 'add', 'register',
]);

const HTTP_VERB_HANDLERS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

// Framework base classes: the handlers they define (a class-based view's
// methods = its own handlers + those of its ancestors). `null` = serves
// every method. Keyed by defining-module prefix, then class name.
const FRAMEWORK_VIEW_BASES = [
    [/^django\.views(\.generic(\.base|\.edit|\.list|\.detail|\.dates)?)?$/, {
        View: [], TemplateView: ['get'], RedirectView: null,
        ListView: ['get'], DetailView: ['get'], ArchiveIndexView: ['get'], YearArchiveView: ['get'],
        MonthArchiveView: ['get'], WeekArchiveView: ['get'], DayArchiveView: ['get'],
        TodayArchiveView: ['get'], DateDetailView: ['get'],
        FormView: ['get', 'post', 'put'], CreateView: ['get', 'post', 'put'],
        UpdateView: ['get', 'post', 'put'], DeleteView: ['get', 'post', 'delete'],
    }],
    [/^rest_framework\.views$/, { APIView: [] }],
    [/^rest_framework\.generics$/, {
        GenericAPIView: [], ListAPIView: ['get'], CreateAPIView: ['post'], RetrieveAPIView: ['get'],
        DestroyAPIView: ['delete'], UpdateAPIView: ['put', 'patch'], ListCreateAPIView: ['get', 'post'],
        RetrieveUpdateAPIView: ['get', 'put', 'patch'], RetrieveDestroyAPIView: ['get', 'delete'],
        RetrieveUpdateDestroyAPIView: ['get', 'put', 'patch', 'delete'],
    }],
    [/^starlette\.endpoints$/, { HTTPEndpoint: [], WebSocketEndpoint: ['websocket'] }],
    [/^flask\.views$/, { MethodView: [], View: [] }],
    [/^aiohttp\.web(_urldispatcher)?$/, { View: [] }],
];

// DRF viewset actions provided by framework bases.
const DRF_ACTION_BASES = [
    [/^rest_framework\.viewsets$/, {
        ViewSet: [], GenericViewSet: [], ViewSetMixin: [],
        ModelViewSet: ['list', 'create', 'retrieve', 'update', 'partial_update', 'destroy'],
        ReadOnlyModelViewSet: ['list', 'retrieve'],
    }],
    [/^rest_framework\.mixins$/, {
        ListModelMixin: ['list'], CreateModelMixin: ['create'], RetrieveModelMixin: ['retrieve'],
        UpdateModelMixin: ['update', 'partial_update'], DestroyModelMixin: ['destroy'],
    }],
    [/^rest_framework\.generics$/, { GenericAPIView: [] }],
];
const DRF_LIST_ACTIONS = [['list', 'GET'], ['create', 'POST']];
const DRF_DETAIL_ACTIONS = [['retrieve', 'GET'], ['update', 'PUT'], ['partial_update', 'PATCH'], ['destroy', 'DELETE']];

const DECORATOR_METHODS = {
    require_GET: ['GET'], require_POST: ['POST'], require_safe: ['GET', 'HEAD'],
};
const DECORATOR_MODULES = /^(django\.views\.decorators|rest_framework\.decorators)/;

// Roles that are route-list elements (a list holding one is a route list).
const ROUTE_ELEMENT_ROLES = new Set([
    'dj-path', 'dj-re-path', 'dj-static', 'st-route', 'st-ws', 'st-mount', 'st-host',
    'aio-verb', 'aio-route', 'aio-view', 'aio-static',
]);

// Constructor roles whose value is a route list/app (include protocol).
const CONTAINER_ROLES = new Set(['dj-include', 'dj-i18n', 'st-router', 'st-app', 'drf-router', 'aio-app', 'aio-table']);

// Python nodes that hold statements (a function's return statements are
// found without visiting expressions).
const STATEMENT_CONTAINERS = new Set([
    'block', 'if_statement', 'elif_clause', 'else_clause', 'for_statement', 'while_statement',
    'try_statement', 'except_clause', 'except_group_clause', 'finally_clause', 'with_statement',
    'match_statement', 'case_clause',
]);

const TRANSLATION_CALLS = new Set(['gettext', 'gettext_lazy', 'pgettext', 'pgettext_lazy', 'ugettext', 'ugettext_lazy']);

const MAX_DEPTH = 8;

// ============================================================================
// SMALL HELPERS
// ============================================================================

function positionalArgs(argsNode) {
    return namedChildren(argsNode).filter(a => a.type !== 'keyword_argument' &&
        a.type !== 'dictionary_splat' && a.type !== 'list_splat' && !a.type.includes('comment'));
}

function keywordArg(argsNode, name) {
    for (const a of namedChildren(argsNode)) {
        if (a.type !== 'keyword_argument') continue;
        if ((field(a, 'name') || a.namedChild(0))?.text === name) return field(a, 'value') || a.namedChild(1);
    }
    return null;
}

function callArgs(callNode) {
    return field(callNode, 'arguments');
}

/** Argument by position, else by keyword. */
function argAt(callNode, index, name) {
    const args = callArgs(callNode);
    if (!args) return null;
    const pos = positionalArgs(args);
    return pos[index] || (name ? keywordArg(args, name) : null);
}

function lineOf(node) {
    return node.startPosition.row + 1;
}

function stringList(sess, file, node) {
    const n = unwrap(node);
    if (!n) return null;
    if (n.type === 'list' || n.type === 'tuple' || n.type === 'set') {
        const out = [];
        for (const el of namedChildren(n)) {
            if (el.type.includes('comment')) continue;
            const v = evalString(sess, file, el);
            if (routeGraph.hasUnresolved(v)) return null;
            out.push(v);
        }
        return out;
    }
    return null;
}

/** Path-shaped folded route string: '' or starting with '/'. */
function rootedPath(value) {
    return typeof value === 'string' && (value === '' || value.startsWith('/'));
}

/** Local binding of `name` in a Python file: { module, name } of the imported
 *  thing, `moduleBinding` when it binds a module. */
function importedAs(entry, local) {
    const bindings = entry?.importBindings || [];
    let binding = bindings.find(b => (b.alias || b.name) === local);
    let original = binding ? binding.name : local;
    if (!binding) {
        const alias = (entry?.importAliases || []).find(a => a.local === local);
        if (alias) {
            original = alias.original;
            binding = bindings.find(b => b.name === original);
        }
    }
    if (!binding) return null;
    return { binding, original, module: String(binding.module || '') };
}

// ============================================================================
// REGEX ROUTES
// ============================================================================

// Every character but the regex metacharacters matches itself (non-ASCII
// letters included, fix #383).
const REGEX_LITERAL = /[^\\^$.|?*+()[\]{}]/;
const NO_SLASH_ESCAPES = new Set(['d', 'w', 'D', 'W', 's']);

/**
 * Whether a regular expression can match a '/' character (fix #383): a
 * route parameter constrained by such a pattern (`(?P<url>.*)`,
 * `{tail:.*}`) spans segments. Walks the pattern's atoms: `.`, `/`, the
 * negated shorthands `\S` `\W` `\D`, and character classes whose set
 * admits '/'.
 */
function regexCanMatchSlash(src) {
    const s = String(src || '');
    const slashInClass = (body) => {
        // body: class contents without brackets and negation.
        for (let i = 0; i < body.length; i++) {
            const c = body[i];
            if (c === '\\') {
                const n = body[i + 1];
                i++;
                if (n === '/' || n === 'S' || n === 'W' || n === 'D') return true;
                continue;
            }
            if (c === '/') return true;
            if (body[i + 1] === '-' && i + 2 < body.length && body[i + 2] !== ']') {
                const lo = c.charCodeAt(0);
                let hiChar = body[i + 2];
                if (hiChar === '\\') hiChar = body[i + 3] || '';
                const hi = hiChar.charCodeAt(0);
                if (lo <= 0x2f && hi >= 0x2f) return true;
                i += 2;
            }
        }
        return false;
    };
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '\\') {
            const n = s[i + 1];
            i++;
            if (n === '/' || n === 'S' || n === 'W' || n === 'D') return true;
            continue;
        }
        if (c === '.' || c === '/') return true;
        if (c === '[') {
            let j = i + 1;
            const negated = s[j] === '^';
            if (negated) j++;
            const start = j;
            if (s[j] === ']') j++;
            while (j < s.length && s[j] !== ']') { if (s[j] === '\\') j++; j++; }
            const hasSlash = slashInClass(s.slice(start, j));
            if (negated ? !hasSlash : hasSlash) return true;
            i = j;
        }
    }
    return false;
}

// Text a Django regex route matches without spelling it (an unanchored
// start or end, fix #383). Spelled like an unresolved part, but proven: the
// matcher treats it as a catch-all, not as an unknown value (no expression
// text can produce it: unresolved parts never hold a bare `*`).
const ANY_TEXT = '{?*}';

/**
 * Normalize a Django regex route into path form. Returns { path, exact,
 * anchored, startAnchored }: `exact` false when part of the regex has no
 * path equivalent (the rest is a `{?regex}` segment); `startAnchored` /
 * `anchored` whether the regex is anchored at its start (`^`) / end (`$`,
 * `\Z`). A group whose pattern can match '/' spans segments and is written
 * `<path:name>` (Django's own spelling for such a parameter, fix #383).
 */
function regexToPath(regex) {
    let src = String(regex);
    let startAnchored = false;
    if (src.startsWith('^')) { src = src.slice(1); startAnchored = true; }
    else if (src.startsWith('\\A')) { src = src.slice(2); startAnchored = true; }
    let anchored = false;
    if (src.endsWith('\\Z')) { src = src.slice(0, -2); anchored = true; }
    else if (src.endsWith('$') && !src.endsWith('\\$')) { src = src.slice(0, -1); anchored = true; }
    let out = '';
    let argIndex = 0;
    let i = 0;
    // The unconverted remainder keeps its literal '/' separators (fix #383):
    // each top-level piece between them is literal text or a disclosed
    // unresolved part, so a concatenating resolver joins the right text.
    const rest = () => {
        const remainder = src.slice(i);
        if (!remainder) return routeGraph.unresolved('regex');
        const pieces = splitTopLevelSlashes(remainder);
        if (pieces.length === 1) return routeGraph.unresolved(remainder);
        return pieces.map(piece => {
            if (!piece) return '';
            const sub = regexToPath(piece);
            return sub.exact && sub.startAnchored === false && !sub.anchored ? sub.path : routeGraph.unresolved(piece);
        }).join('/');
    };
    const quantifierAt = (j) => j < src.length && /[?*+{]/.test(src[j]);
    while (i < src.length) {
        const ch = src[i];
        // A disclosed unresolved part of the folded regex string.
        if (ch === '{' && src[i + 1] === '?') {
            const close = src.indexOf('}', i);
            if (close < 0) return { path: out + rest(), exact: false, startAnchored };
            out += src.slice(i, close + 1);
            i = close + 1;
            continue;
        }
        if (ch === '(') {
            const close = matchParen(src, i);
            if (close < 0) return { path: out + rest(), exact: false, startAnchored };
            const inner = src.slice(i + 1, close);
            if (quantifierAt(close + 1)) return { path: out + rest(), exact: false, startAnchored };
            const named = inner.match(/^\?P<([A-Za-z_][A-Za-z0-9_]*)>([\s\S]*)$/);
            if (named) {
                out += regexCanMatchSlash(named[2]) ? `<path:${named[1]}>` : `<${named[1]}>`;
            } else if (inner.startsWith('?')) {
                return { path: out + rest(), exact: false, startAnchored };
            } else {
                argIndex++;
                out += regexCanMatchSlash(inner) ? `<path:arg${argIndex}>` : `<arg${argIndex}>`;
            }
            i = close + 1;
            continue;
        }
        if (ch === '\\' && i + 1 < src.length) {
            const next = src[i + 1];
            if (NO_SLASH_ESCAPES.has(next) || /[A-Za-z0-9]/.test(next)) {
                return { path: out + rest(), exact: false, startAnchored };
            }
            if (quantifierAt(i + 2)) return { path: out + rest(), exact: false, startAnchored };
            out += next;
            i += 2;
            continue;
        }
        if (ch === '/' || REGEX_LITERAL.test(ch)) {
            if (quantifierAt(i + 1)) {
                // `/?` closing the pattern: the trailing slash is optional.
                if (ch === '/' && src[i + 1] === '?' && i + 2 === src.length) { i += 2; continue; }
                return { path: out + rest(), exact: false, startAnchored };
            }
            out += ch;
            i++;
            continue;
        }
        return { path: out + rest(), exact: false, startAnchored };
    }
    return { path: out, exact: true, anchored, startAnchored };
}

/** Split a regex at the '/' characters outside classes and groups. */
function splitTopLevelSlashes(src) {
    const pieces = [];
    let depth = 0;
    let inClass = false;
    let start = 0;
    for (let j = 0; j < src.length; j++) {
        const c = src[j];
        if (c === '\\') { j++; continue; }
        if (inClass) { if (c === ']') inClass = false; continue; }
        if (c === '[') { inClass = true; continue; }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === '/' && depth === 0) {
            pieces.push(src.slice(start, j));
            start = j + 1;
        }
    }
    pieces.push(src.slice(start));
    return pieces;
}

function matchParen(src, open) {
    let depth = 0;
    let inClass = false;
    for (let j = open; j < src.length; j++) {
        const c = src[j];
        if (c === '\\') { j++; continue; }
        if (inClass) { if (c === ']') inClass = false; continue; }
        if (c === '[') { inClass = true; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) return j; }
    }
    return -1;
}

// ============================================================================
// SESSION
// ============================================================================

// Candidate files smaller than this parse fully (a partial parse only pays
// off on large modules holding a few route lists, e.g. test modules).
const PARTIAL_PARSE_MIN_CHARS = 16384;

/**
 * The route-list pass's AST session. While the pass processes a large
 * candidate file (the ACTIVE file), that file is parsed over the ranges the
 * pass reads (tree positions stay file positions) and its scope
 * declarations are cached apart; every other lookup - including lookups
 * into that file from other files - sees the shared endpoints session's full
 * trees. Partial trees never enter the shared session or the parser's
 * content cache.
 */
class ListSession extends routeGraph.AstSession {
    constructor(index, main, rangesFor) {
        super(index);
        this.main = main;
        this.rangesFor = rangesFor;
        this.activeFile = null;
        this.activePartial = false;
        const shared = new Map();
        const partial = new Map();
        const route = key => (this.activePartial && key.startsWith(`${this.activeFile}#`) ? partial : shared);
        this.partialScopes = partial;
        this.scopeDecls = {
            get: key => route(key).get(key),
            set: (key, value) => route(key).set(key, value),
            has: key => route(key).has(key),
        };
    }

    /** Process `file` with its partial tree (if any) until `leave()`. */
    enter(file) {
        this.activeFile = file;
        this.partialScopes.clear();
        this.activePartial = !!this.partialTree(file);
    }

    leave() {
        this.activeFile = null;
        this.activePartial = false;
        this.partialScopes.clear();
    }

    root(file) {
        if (file === this.activeFile && this.activePartial) return this.partialTree(file).rootNode;
        return this.main.root(file);
    }

    partialTree(file) {
        if (this.trees.has(file)) return this.trees.get(file);
        const ranges = this.rangesFor(file);
        let tree = null;
        if (ranges) {
            const parser = getParser('python');
            const text = this.text(file);
            for (const size of [1 << 20, text.length * 2, text.length * 4, 64 << 20]) {
                try {
                    tree = parser.parse(text, undefined, { includedRanges: ranges, bufferSize: Math.max(size, 1 << 20) });
                    break;
                } catch (e) { tree = null; }
            }
        }
        this.trees.set(file, tree);
        return tree;
    }

    text(file) { return this.main.text(file); }

    snippet(lang, code) { return this.main.snippet(lang, code); }
}

// ============================================================================
// COLLECTOR
// ============================================================================

class RouteListCollector {
    constructor(index, sess, sharedFiles = new Set()) {
        this.index = index;
        this.plans = new Map();
        this.sess = new ListSession(index, sess, file => this.partialRanges(file, sharedFiles));
        this.routes = [];      // { containerKey, method, path, handler, file, line, framework, derived, raw }
        this.edges = [];       // { targetKey, mounterKey, prefix }
        this.roots = new Set(); // container keys served at '/' in addition to their mounts
        this.containers = new Set(); // app/router constructor keys (fix #392)
        this.processed = new Set();
        this.moduleFileMemo = new Map();
        this.defMemo = new Map();
        this.methodMemo = new Map();
        this.deferred = [];
        this.roleMemo = new Map();
        this.returnsDone = new Set();
    }

    // ── candidates ───────────────────────────────────────────────────────

    /**
     * Per candidate file, the call records worth locating: calls of a
     * route-table constructor bound by import, calls on an imported routing
     * module (`web.get`), and registration methods in files that import the
     * registering framework. Settings modules naming ROOT_URLCONF are listed
     * separately. Files without such records are never parsed.
     */
    candidates() {
        const files = [];
        const settings = [];
        for (const [file, entry] of this.index.files) {
            if (entry.language !== 'python') continue;
            if ((entry.moduleAssignedNames || []).includes('ROOT_URLCONF')) settings.push(file);
            const plan = this.filePlan(file, entry);
            if (plan) files.push([file, plan]);
        }
        return { files, settings };
    }

    filePlan(file, entry) {
        const bindings = entry.importBindings || [];
        if (bindings.length === 0) return null;
        const roleNames = new Set();      // bare-call names bound to an anchor role
        const moduleNames = new Set();    // module bindings holding anchor roles
        let drf = false;
        const frameworks = new Set();
        for (const b of bindings) {
            const module = String(b.module || '');
            const local = b.alias || b.name;
            const roles = ROLES.get(module);
            if (roles && ANCHOR_ROLES.has(roles[b.name])) {
                roleNames.add(local);
                if (roles[b.name] === 'drf-router') drf = true;
            }
            const sub = ROLES.get(`${module}.${b.name}`);
            if (sub && Object.values(sub).some(r => ANCHOR_ROLES.has(r))) {
                moduleNames.add(local);
                if (Object.values(sub).includes('drf-router')) drf = true;
            }
            if (module.startsWith('flask') || module.startsWith('starlette') || module.startsWith('fastapi')) {
                for (const [fw, re] of Object.entries(FRAMEWORK_MODULES)) if (re.test(module)) frameworks.add(fw);
            }
        }
        for (const a of entry.importAliases || []) {
            const b = bindings.find(x => x.name === a.original);
            const roles = b && ROLES.get(String(b.module || ''));
            if (roles && ANCHOR_ROLES.has(roles[a.original])) {
                roleNames.add(a.local);
                if (roles[a.original] === 'drf-router') drf = true;
            }
        }
        const anchored = roleNames.size > 0 || moduleNames.size > 0;
        if (!anchored && frameworks.size === 0) return null;
        const calls = getCachedCalls(this.index, file) || [];
        const pointed = [];
        for (const c of calls) {
            if (!c.callSite || c.callSite.start == null) continue;
            if (!c.isMethod) {
                if (roleNames.has(c.name)) pointed.push(c);
                continue;
            }
            const recv = c.receiver || c.receiverRoot;
            if (moduleNames.has(recv)) { pointed.push(c); continue; }
            if (frameworks.has(METHOD_REGISTRATIONS.get(c.name)) ||
                (frameworks.has('starlette') && c.name === 'mount') ||
                (anchored && (AIO_ROUTER_METHODS[c.name] !== undefined || c.name === 'add_routes' ||
                    c.name === 'add_subapp')) ||
                (drf && c.name === 'register')) {
                pointed.push(c);
            }
        }
        const urlconf = anchored && (entry.moduleAssignedNames || []).includes('urlpatterns');
        if (pointed.length === 0 && !urlconf) return null;
        return { pointed, urlconf };
    }

    // ── roles ────────────────────────────────────────────────────────────

    /** Framework role of a callee expression in `file`, or null. */
    roleOf(file, calleeNode) {
        const fn = unwrap(calleeNode);
        if (!fn) return null;
        const key = `${file}#${fn.startIndex}:${fn.endIndex}`;
        let role = this.roleMemo.get(key);
        if (role === undefined) {
            role = this.computeRole(file, fn);
            this.roleMemo.set(key, role);
        }
        return role;
    }

    computeRole(file, fn) {
        const entry = this.index.files.get(file);
        if (fn.type === 'identifier') {
            const imp = importedAs(entry, fn.text);
            if (!imp || imp.binding.kind === 'import') return null;
            // A local redefinition shadows the import.
            const decl = findDecl(this.sess, file, fn.text, fn);
            if (decl && decl.kind !== 'param') return null;
            const roles = ROLES.get(imp.module);
            return (roles && roles[imp.original]) || null;
        }
        if (fn.type === 'attribute') {
            const obj = unwrap(field(fn, 'object'));
            const attr = field(fn, 'attribute')?.text;
            if (!obj || obj.type !== 'identifier' || !attr) return null;
            const imp = importedAs(entry, obj.text);
            if (!imp) return null;
            const module = imp.binding.kind === 'import' ? imp.module : `${imp.module}.${imp.original}`;
            const roles = ROLES.get(module);
            return (roles && roles[attr]) || null;
        }
        return null;
    }

    // ── keys ─────────────────────────────────────────────────────────────

    inlineKey(file, node) {
        return `${file}#${node.startIndex}`;
    }

    /** Container key of a variable reference (declaring binding). */
    varKey(file, identNode, depth = 0) {
        const name = identNode.text;
        // A class attribute (`urlpatterns = [...]` in a class used as a
        // URLconf) belongs to its class, not to the module.
        for (let n = identNode.parent; n; n = n.parent) {
            if (n.type === 'function_definition' || n.type === 'lambda' || n.type === 'module') break;
            if (n.type === 'class_definition') return `${file}@${n.startIndex}:${name}`;
        }
        const decl = findDecl(this.sess, file, name, identNode);
        if (decl) {
            if (decl.scope.parent === null) return `${file}:${name}`;
            return `${file}@${decl.scope.startIndex}:${name}`;
        }
        const entry = this.index.files.get(file);
        const imp = importedAs(entry, name);
        const target = imp && this.importTarget(entry, imp);
        if (target && !target.module) return `${target.file}:${target.name}`;
        return `${file}:${name}`;
    }

    /** Key of a module-level VARIABLE imported into `file` (chased through
     *  re-exports); a module binding answers the module's `urlpatterns`.
     *  Functions, classes and unknown names answer null. */
    importedKey(file, name, depth = 0) {
        if (depth > MAX_DEPTH) return null;
        const entry = this.index.files.get(file);
        const imp = importedAs(entry, name);
        if (!imp) return null;
        const target = this.importTarget(entry, imp);
        if (!target) return null;
        if (target.module) return `${target.file}:urlpatterns`;
        return this.moduleVarKey(target.file, target.name, depth + 1);
    }

    /** `file:name` when `name` is assigned at module level of `file`. */
    moduleVarKey(file, name, depth = 0) {
        const entry = this.index.files.get(file);
        if (!entry || depth > MAX_DEPTH) return null;
        if ((entry.moduleAssignedNames || []).includes(name)) return `${file}:${name}`;
        return this.importedKey(file, name, depth + 1);
    }

    /** What an import binding denotes: { file, module: true } for a module,
     *  { file, name } for a module-level name. */
    importTarget(entry, imp) {
        const resolved = spec => entry.moduleResolved?.[spec];
        const abs = rel => path.join(this.index.root, rel);
        const { binding, original, module } = imp;
        if (binding.kind === 'import') {
            const rel = resolved(module);
            return rel ? { file: abs(rel), module: true } : null;
        }
        const subSpec = module.endsWith('.') ? module + original : `${module}.${original}`;
        const subRel = resolved(subSpec);
        if (subRel) return { file: abs(subRel), module: true };
        const rel = resolved(module);
        return rel ? { file: abs(rel), name: original } : null;
    }

    /** Dotted module path (`include("blog.urls")`) -> indexed file. */
    moduleFile(file, spec) {
        const key = `${path.dirname(file)}\0${spec}`;
        if (this.moduleFileMemo.has(key)) return this.moduleFileMemo.get(key);
        let out = null;
        if (/^\.?[A-Za-z_][\w.]*$/.test(spec)) {
            try {
                const abs = resolveImport(spec, file, { language: 'python', root: this.index.root });
                if (abs && this.index.files.has(abs)) out = abs;
            } catch (e) { out = null; }
        }
        this.moduleFileMemo.set(key, out);
        return out;
    }

    /** Container key a reference expression denotes, or null. */
    refKey(file, node) {
        const n = unwrap(node);
        if (!n) return null;
        if (n.type === 'identifier') {
            const decl = findDecl(this.sess, file, n.text, n);
            if (decl) {
                if (decl.kind !== 'var') return null;
                return this.varKey(file, n);
            }
            return this.importedKey(file, n.text) ||
                ((this.index.files.get(file)?.moduleAssignedNames || []).includes(n.text) ? `${file}:${n.text}` : null);
        }
        if (n.type === 'attribute') {
            const obj = unwrap(field(n, 'object'));
            const attr = field(n, 'attribute')?.text;
            if (!obj || !attr || obj.type !== 'identifier') return null;
            // `router.urls` (DRF router), `app.routes` (Starlette app).
            const valueRole = this.valueRole(file, obj);
            if (valueRole === 'drf-router' && attr === 'urls') return this.varKey(file, obj);
            if ((valueRole === 'st-app' || valueRole === 'st-router') && attr === 'routes') return this.varKey(file, obj);
            // `module.urlpatterns` / `module.name`.
            const decl = findDecl(this.sess, file, obj.text, obj);
            if (decl) return null;
            const entry = this.index.files.get(file);
            const imp = importedAs(entry, obj.text);
            const target = imp && this.importTarget(entry, imp);
            if (target && target.module) return this.moduleVarKey(target.file, attr);
        }
        return null;
    }

    /** Role of the constructor call a variable was assigned from. */
    valueRole(file, identNode, depth = 0) {
        if (depth > MAX_DEPTH) return null;
        const decl = findDecl(this.sess, file, identNode.text, identNode);
        if (decl) {
            const v = unwrap(decl.valueNode);
            if (decl.count === 1 && v && v.type === 'call') return this.roleOf(file, field(v, 'function'));
            return null;
        }
        const entry = this.index.files.get(file);
        const imp = importedAs(entry, identNode.text);
        const target = imp && this.importTarget(entry, imp);
        if (!target || target.module) return null;
        const root = this.sess.root(target.file);
        const tdecl = root && routeGraph.scopeDecls(this.sess, target.file, 'python', root).get(target.name);
        const v = tdecl && unwrap(tdecl.valueNode);
        if (tdecl && tdecl.count === 1 && v && v.type === 'call') return this.roleOf(target.file, field(v, 'function'));
        return null;
    }

    // ── emission ─────────────────────────────────────────────────────────

    addRoute(containerKey, rec) {
        this.routes.push({ containerKey, ...rec });
    }

    /** A mount/include edge. `framework` decides how the prefix joins what
     *  it mounts (fix #383): Django concatenates the pattern strings. */
    addEdge(targetKey, mounterKey, prefix, framework = null) {
        if (!targetKey || (targetKey === mounterKey && !prefix)) return;
        this.edges.push({ targetKey, mounterKey, prefix: prefix || '',
            ...(framework === 'django' && { join: 'concat' }) });
    }

    /** An include/mount whose target cannot be resolved: disclosed wildcard. */
    addUnresolvedMount(file, containerKey, node, prefix, framework, derived, handler) {
        const literal = routeGraph.isStringLiteral(unwrap(node)) ? evalString(this.sess, file, node) : null;
        const segment = literal && !routeGraph.hasUnresolved(literal) ? routeGraph.unresolved(literal)
            : routeGraph.unresolved(node);
        const own = joinSegment(prefix, segment, framework);
        this.addRoute(containerKey, {
            method: 'ALL', path: own, handler: handler || (unwrap(node)?.type === 'call' ? shortText(node) : exprText(node)), file, line: lineOf(node),
            framework, derived,
        });
    }

    // ── walk ─────────────────────────────────────────────────────────────

    collectFile(file, plan) {
        this.sess.enter(file);
        try {
            this.collectActiveFile(file, plan);
        } finally {
            this.sess.leave();
        }
    }

    collectActiveFile(file, plan) {
        const root = this.sess.root(file);
        if (!root) return;
        // Module-level `urlpatterns` statements (Django's URLconf protocol),
        // including those under module-level if/try blocks.
        if (plan.urlconf) {
            const visit = (container) => {
                for (const stmt of namedChildren(container)) {
                    if (stmt.type === 'expression_statement') {
                        const e = stmt.namedChild(0);
                        if (e && (e.type === 'assignment' || e.type === 'augmented_assignment')) this.visitAssignment(file, e);
                    } else if (stmt.type === 'if_statement' || stmt.type === 'try_statement' ||
                        stmt.type === 'else_clause' || stmt.type === 'elif_clause' || stmt.type === 'except_clause' ||
                        stmt.type === 'finally_clause' || stmt.type === 'block' || stmt.type === 'with_statement') {
                        visit(stmt);
                    }
                }
            };
            visit(root);
        }
        for (const rec of plan.pointed) {
            const call = this.locateCall(root, rec);
            if (!call || this.isDone(file, call)) continue;
            this.visitContext(file, call);
        }
    }

    /** The call node a record points at (its callee name span). */
    locateCall(root, rec) {
        let n = root.descendantForIndex(rec.callSite.start, rec.callSite.end);
        if (!n) return null;
        if (n.parent && n.parent.type === 'attribute' && field(n.parent, 'attribute') &&
            field(n.parent, 'attribute').startIndex === n.startIndex) {
            n = n.parent;
        }
        const call = n.parent;
        if (!call || call.type !== 'call') return null;
        const fn = field(call, 'function');
        return fn && fn.startIndex === n.startIndex && fn.endIndex === n.endIndex ? call : null;
    }

    /** Process the statement a pointed call belongs to, top-down, so the
     *  call lands in the container its value flows into. */
    visitContext(file, call) {
        for (let n = call.parent; n; n = n.parent) {
            if (n.type === 'function_definition') { this.processReturns(file, n); break; }
            if (n.type === 'lambda' || n.type === 'class_definition') break;
        }
        if (this.isDone(file, call)) return;
        let top = call;
        while (top.parent) {
            const p = top.parent;
            if (p.type === 'expression_statement' || p.type === 'return_statement' || p.type === 'block' ||
                p.type === 'module' || p.type === 'lambda' || p.type === 'decorator') break;
            top = p;
        }
        if (top.type === 'assignment' || top.type === 'augmented_assignment') {
            // The pointed call sits in the assigned value when it is a role call.
            const right = field(top, 'right');
            const inRight = right && call.startIndex >= right.startIndex && call.endIndex <= right.endIndex;
            this.visitAssignment(file, top, inRight && !!this.roleOf(file, field(call, 'function')));
        } else if (top.type === 'call' && !this.isDone(file, top)) {
            this.visitCall(file, top, null);
        }
        if (this.isDone(file, call)) return;
        // Outermost role/registration call between the statement and the
        // pointed call (route lists passed to a helper, returned, ...).
        const chain = [];
        for (let n = call; n; n = n.parent) {
            if (n.type === 'call') chain.push(n);
            if (n.startIndex === top.startIndex && n.endIndex === top.endIndex) break;
        }
        for (let i = chain.length - 1; i >= 0; i--) {
            const c = chain[i];
            if (this.isDone(file, c)) continue;
            if (this.roleOf(file, field(c, 'function')) || this.methodRegistration(file, c)) {
                this.visitCall(file, c, null);
                if (this.isDone(file, call)) return;
            }
        }
        if (!this.isDone(file, call)) this.visitCall(file, call, null);
    }

    visitAssignment(file, node, holdsRoleCall = false) {
        const left = field(node, 'left');
        const right = field(node, 'right');
        if (!left || !right || left.type !== 'identifier') return;
        const moduleLevel = isModuleLevel(node);
        // Django's URLconf protocol: a module's `urlpatterns` is its route list.
        const isUrlconf = moduleLevel && left.text === 'urlpatterns';
        if (!isUrlconf && !holdsRoleCall && !this.containsRoleCall(file, right)) return;
        const key = this.varKey(file, left);
        this.evalContainer(file, right, key, 0, isUrlconf);
    }

    containsRoleCall(file, node, budget = { n: 200 }) {
        const stack = [node];
        while (stack.length > 0) {
            const n = stack.pop();
            if (--budget.n < 0) return false;
            if (n.type === 'call') {
                if (this.roleOf(file, field(n, 'function'))) return true;
            }
            if (n.type === 'lambda' || n.type === 'function_definition') continue;
            for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
        }
        return false;
    }

    /**
     * Evaluate a route-list expression into `containerKey`. `proven`: the
     * value is known to be a route list (a URLconf's `urlpatterns`, an
     * include()/`routes=` argument, a list with a route-constructor
     * element), so an element that is not a route constructor is an
     * include-like entry (linked or disclosed); in any other list it is
     * ignored.
     */
    evalContainer(file, node, containerKey, depth = 0, proven = true) {
        const n = unwrap(node);
        if (!n || depth > 40) return;
        switch (n.type) {
            case 'list':
            case 'tuple':
            case 'expression_list':
            case 'set': {
                const elements = namedChildren(n).filter(el => !el.type.includes('comment'));
                const listProven = proven || elements.some(el => this.isRouteElement(file, el));
                for (const el of elements) this.evalContainer(file, el, containerKey, depth + 1, listProven);
                return;
            }
            case 'list_splat':
            case 'parenthesized_expression':
                for (const el of namedChildren(n)) this.evalContainer(file, el, containerKey, depth + 1, proven);
                return;
            case 'binary_operator':
                this.evalContainer(file, field(n, 'left'), containerKey, depth + 1, proven);
                this.evalContainer(file, field(n, 'right'), containerKey, depth + 1, proven);
                return;
            case 'conditional_expression':
                for (const el of namedChildren(n).slice(0, 1).concat(namedChildren(n).slice(2))) {
                    this.evalContainer(file, el, containerKey, depth + 1, proven);
                }
                return;
            case 'call': {
                if (this.isDone(file, n)) return;
                const role = this.roleOf(file, field(n, 'function'));
                if (role || this.methodRegistration(file, n)) {
                    this.visitCall(file, n, containerKey);
                    return;
                }
                // A transform of route lists (`format_suffix_patterns([...])`,
                // `list(...)`): the routes it wraps flow into the container.
                if (this.containsRoleCall(file, n)) {
                    this.markDone(file, n);
                    for (const a of namedChildren(callArgs(n))) {
                        const v = a.type === 'keyword_argument' ? field(a, 'value') : a;
                        if (v) this.evalContainer(file, v, containerKey, depth + 1, false);
                    }
                    return;
                }
                if (!proven) return;
                this.markDone(file, n);
                this.linkTarget(file, n, containerKey, '', this.frameworkOfContainerFile(file), 'include');
                return;
            }
            case 'identifier':
            case 'attribute':
                if (proven) this.linkTarget(file, n, containerKey, '', this.frameworkOfContainerFile(file), 'include');
                return;
            case 'list_comprehension':
            case 'generator_expression': {
                const body = field(n, 'body');
                if (body) this.evalContainer(file, body, containerKey, depth + 1, proven);
                return;
            }
            default:
                return;
        }
    }

    /** A direct route-constructor element of a list. */
    isRouteElement(file, el) {
        const n = unwrap(el);
        if (!n || n.type !== 'call') return false;
        const role = this.roleOf(file, field(n, 'function'));
        return !!role && ROUTE_ELEMENT_ROLES.has(role);
    }

    frameworkOfContainerFile(file) {
        const entry = this.index.files.get(file);
        const modules = (entry?.importBindings || []).map(b => String(b.module || ''));
        if (modules.some(m => /^django\.(urls|conf\.urls)/.test(m))) return 'django';
        if (modules.some(m => /^aiohttp/.test(m))) return 'aiohttp';
        return 'starlette';
    }

    /** Method registrations on a proven app (`app.add_url_rule`, ...). */
    methodRegistration(file, callNode) {
        const fn = unwrap(field(callNode, 'function'));
        if (!fn || fn.type !== 'attribute') return null;
        const method = field(fn, 'attribute')?.text;
        const recv = unwrap(field(fn, 'object'));
        if (!method || !recv || !REGISTRATION_NAMES.has(method)) return null;
        const fw = METHOD_REGISTRATIONS.get(method);
        if (fw && recv.type === 'identifier' && recv.text !== 'self' && recv.text !== 'cls' &&
            this.fileFrameworks(file).has(fw)) {
            return { kind: fw, method, recv };
        }
        if (method === 'mount' && recv.type === 'identifier' && this.fileFrameworks(file).has('starlette')) {
            return { kind: 'mount', method, recv };
        }
        // aiohttp: `app.router.add_get(...)`, `app.add_routes([...])`,
        // `app.add_subapp(prefix, sub)` on a web.Application() value.
        if (recv.type === 'attribute' && field(recv, 'attribute')?.text === 'router' &&
            Object.prototype.hasOwnProperty.call(AIO_ROUTER_METHODS, method)) {
            const app = unwrap(field(recv, 'object'));
            if (app && app.type === 'identifier' && this.valueRole(file, app) === 'aio-app') {
                return { kind: 'aiohttp', method, recv: app };
            }
        }
        if ((method === 'add_routes' || method === 'add_subapp') && recv.type === 'identifier' &&
            this.valueRole(file, recv) === 'aio-app') {
            return { kind: 'aiohttp', method, recv };
        }
        if (method === 'add_routes' && recv.type === 'attribute' && field(recv, 'attribute')?.text === 'router') {
            const app = unwrap(field(recv, 'object'));
            if (app && app.type === 'identifier' && this.valueRole(file, app) === 'aio-app') {
                return { kind: 'aiohttp', method, recv: app };
            }
        }
        // `urlpatterns.append(path(...))`, `routes.extend([...])`
        if ((method === 'append' || method === 'extend' || method === 'insert' || method === 'add') &&
            recv.type === 'identifier' && this.containsRoleCall(file, callArgs(callNode) || callNode)) {
            return { kind: 'list-mutation', method, recv };
        }
        // `router.register(...)` on a DRF router value.
        if (method === 'register' && recv.type === 'identifier' && this.valueRole(file, recv) === 'drf-router') {
            return { kind: 'drf', method, recv };
        }
        return null;
    }

    markDone(file, node) {
        this.processed.add(`${file}#${node.startIndex}:${node.endIndex}`);
    }

    isDone(file, node) {
        return this.processed.has(`${file}#${node.startIndex}:${node.endIndex}`);
    }

    fileFrameworks(file) {
        if (!this.frameworksMemo) this.frameworksMemo = new Map();
        let set = this.frameworksMemo.get(file);
        if (!set) {
            set = new Set();
            for (const b of this.index.files.get(file)?.importBindings || []) {
                const module = String(b.module || '');
                for (const [fw, re] of Object.entries(FRAMEWORK_MODULES)) if (re.test(module)) set.add(fw);
            }
            this.frameworksMemo.set(file, set);
        }
        return set;
    }

    visitCall(file, callNode, containerKey) {
        const role = this.roleOf(file, field(callNode, 'function'));
        if (role) {
            this.markDone(file, callNode);
            this.visitRoleCall(file, callNode, role, containerKey);
            return;
        }
        const reg = this.methodRegistration(file, callNode);
        if (!reg) return;
        this.markDone(file, callNode);
        this.visitRegistration(file, callNode, reg);
    }

    /** Own container of a constructor call (assigned variable or inline). */
    ctorKey(file, callNode) {
        const parent = callNode.parent;
        if (parent && (parent.type === 'assignment') && field(parent, 'right') &&
            field(parent, 'right').startIndex === callNode.startIndex) {
            const left = field(parent, 'left');
            if (left && left.type === 'identifier') return this.varKey(file, left);
        }
        return this.inlineKey(file, callNode);
    }

    visitRoleCall(file, callNode, role, containerKey) {
        switch (role) {
            case 'dj-path':
            case 'dj-re-path':
                this.visitDjangoPath(file, callNode, role, containerKey);
                return;
            case 'dj-include': {
                // A bare include() outside path(): its target joins the container.
                this.linkTarget(file, callNode, containerKey, '', 'django', 'include');
                return;
            }
            case 'dj-i18n': {
                // LocalePrefixPattern matches `<language_code>/` (and
                // nothing for the default language when
                // prefix_default_language=False), concatenated with the
                // patterns it holds.
                const key = this.inlineKey(file, callNode);
                const prefixDefault = keywordArg(callArgs(callNode), 'prefix_default_language');
                this.addEdge(key, containerKey, '{?language_code}/', 'django');
                if (prefixDefault && prefixDefault.text === 'False') this.addEdge(key, containerKey, '', 'django');
                for (const a of positionalArgs(callArgs(callNode))) this.evalContainer(file, a, key);
                return;
            }
            case 'dj-static': {
                const prefix = argAt(callNode, 0, 'prefix');
                const value = prefix ? evalString(this.sess, file, prefix) : '{?prefix}';
                this.addRoute(containerKey, {
                    method: 'GET', path: joinSegment(stripLeading(value), '<path:path>', 'django'), handler: 'serve',
                    file, line: lineOf(callNode), framework: 'django', derived: 'static',
                });
                return;
            }
            case 'st-route':
            case 'st-ws':
                this.visitStarletteRoute(file, callNode, role, containerKey);
                return;
            case 'st-mount':
            case 'st-host':
                this.visitStarletteMount(file, callNode, role, containerKey);
                return;
            case 'st-router':
            case 'st-app': {
                const key = this.ctorKey(file, callNode);
                // Every app/router constructed, routes or not (fix #392: an
                // in-process client of an app with no routes reaches none).
                this.containers.add(key);
                if (containerKey && key !== containerKey) this.addEdge(key, containerKey, '');
                const routes = keywordArg(callArgs(callNode), 'routes') ||
                    (role === 'st-router' ? argAt(callNode, 0, null) : null);
                if (routes) this.evalContainer(file, routes, key);
                return;
            }
            case 'st-static':
                if (containerKey) {
                    this.addRoute(containerKey, {
                        method: 'GET', path: '/{path:path}', handler: 'StaticFiles', file,
                        line: lineOf(callNode), framework: 'starlette', derived: 'static',
                    });
                }
                return;
            case 'aio-verb':
            case 'aio-route':
            case 'aio-view':
            case 'aio-static':
                this.visitAiohttpDef(file, callNode, role, containerKey);
                return;
            case 'aio-app':
            case 'aio-table':
            case 'drf-router':
                return;
            default:
                return;
        }
    }

    // ── Django ───────────────────────────────────────────────────────────

    visitDjangoPath(file, callNode, role, containerKey) {
        const routeNode = argAt(callNode, 0, role === 'dj-path' ? 'route' : 'regex') ||
            argAt(callNode, 0, 'route');
        const viewNode = unwrap(argAt(callNode, 1, 'view'));
        if (!routeNode) return;
        const raw = this.routeString(file, routeNode);
        let own = raw;
        let derived = null;
        const isInclude = !!viewNode && this.isIncludeView(file, viewNode);
        if (role === 'dj-re-path') {
            const r = regexToPath(raw);
            own = r.path;
            derived = 'regex';
            // Django matches a regex route with `search` (fix #383): without
            // `^` it matches after any leading text, and an endpoint without
            // `$` also serves any trailing text. A part that already spans
            // segments absorbs it.
            const resolved = r.exact && !routeGraph.hasUnresolved(raw);
            if (resolved && !r.startAnchored && !own.startsWith('<path:')) own = `${ANY_TEXT}${own}`;
            if (resolved && !isInclude && !r.anchored && !/<path:[A-Za-z0-9_]+>$/.test(own)) own = `${own}${ANY_TEXT}`;
        }
        const line = lineOf(callNode);
        if (!viewNode) {
            this.addRoute(containerKey, { method: 'ALL', path: own, handler: '<anonymous>', file, line,
                framework: 'django', derived, raw: `path ${raw}` });
            return;
        }
        // include(...) / a URL list / `x.urls`: an edge.
        if (isInclude) {
            this.linkTarget(file, viewNode, containerKey, own, 'django', 'include');
            return;
        }
        const view = this.viewMethods(file, viewNode, 'django');
        for (const method of view.methods) {
            this.addRoute(containerKey, {
                method, path: own, handler: view.handler, file, line, framework: 'django',
                derived, raw: `${method} ${raw}`,
            });
        }
    }

    /** Whether a path() view argument is an include (Django: a list/tuple
     *  of patterns, include(), or an object's `urls` include tuple) rather
     *  than a callable view. */
    isIncludeView(file, viewNode) {
        const n = unwrap(viewNode);
        if (n.type === 'call') return this.roleOf(file, field(n, 'function')) === 'dj-include';
        if (n.type === 'list' || n.type === 'tuple') return true;
        if (n.type !== 'identifier' && n.type !== 'attribute') return false;
        if (n.type === 'attribute' && field(n, 'attribute')?.text === 'urls') return true;
        const v = this.refValue(file, n);
        if (v) return this.isContainerValue(v.file, v.node);
        return (n.type === 'identifier' ? n.text : field(n, 'attribute')?.text) === 'urlpatterns';
    }

    isContainerValue(file, node) {
        const n = unwrap(node);
        if (!n) return false;
        if (n.type === 'list' || n.type === 'tuple' || n.type === 'list_comprehension' ||
            n.type === 'binary_operator') return true;
        if (n.type === 'call') return CONTAINER_ROLES.has(this.roleOf(file, field(n, 'function')));
        if (n.type === 'attribute' && field(n, 'attribute')?.text === 'urls') return true;
        return false;
    }

    inlineList(file, listNode) {
        const key = this.inlineKey(file, listNode);
        this.evalContainer(file, listNode, key);
        return key;
    }

    /**
     * Link what an include/mount/list reference denotes into `mounterKey`
     * under `prefix`: a dotted module path, a URL list (inline or by
     * reference), an inline router/app, a project function that builds and
     * returns a URL list (decided once every file is collected), else a
     * disclosed `prefix/{?target}` route.
     */
    linkTarget(file, node, mounterKey, prefix, framework, derived) {
        const n = unwrap(node);
        if (!n) return;
        if (routeGraph.isStringLiteral(n)) {
            const spec = evalString(this.sess, file, n);
            const modFile = routeGraph.hasUnresolved(spec) ? null : this.moduleFile(file, spec);
            if (modFile) this.addEdge(`${modFile}:urlpatterns`, mounterKey, prefix, framework);
            else this.addUnresolvedMount(file, mounterKey, n, prefix, framework, derived);
            return;
        }
        if (n.type === 'tuple') {
            const first = namedChildren(n).find(c => !c.type.includes('comment'));
            if (first) this.linkTarget(file, first, mounterKey, prefix, framework, derived);
            return;
        }
        if (n.type === 'list') {
            this.addEdge(this.inlineList(file, n), mounterKey, prefix, framework);
            return;
        }
        if (n.type === 'call') {
            const role = this.roleOf(file, field(n, 'function'));
            if (role === 'dj-include') {
                this.markDone(file, n);
                const arg = argAt(n, 0, 'arg');
                if (arg) this.linkTarget(file, arg, mounterKey, prefix, framework, derived);
                return;
            }
            if (role === 'st-router' || role === 'st-app') {
                this.markDone(file, n);
                const inner = this.inlineKey(file, n);
                this.addEdge(inner, mounterKey, prefix, framework);
                const r = keywordArg(callArgs(n), 'routes') || (role === 'st-router' ? argAt(n, 0, null) : null);
                if (r) this.evalContainer(file, r, inner);
                return;
            }
            const def = role ? null : this.resolveDef(file, field(n, 'function'));
            if (def && def.kind === 'function') {
                this.deferred.push({ file, retKey: this.retKeyOfDef(def), mounterKey, prefix, node: n, framework, derived });
                return;
            }
        }
        if (n.type === 'identifier' || n.type === 'attribute') {
            const key = this.refKey(file, n);
            if (key && this.refIsContainer(file, n)) { this.addEdge(key, mounterKey, prefix, framework); return; }
            // A parameter: the routes are declared (and listed) at the caller.
            if (n.type === 'identifier' && findDecl(this.sess, file, n.text, n)?.kind === 'param') return;
        }
        this.addUnresolvedMount(file, mounterKey, n, prefix, framework, derived);
    }

    /** A reference whose single assigned value is a route list or app (an
     *  unknown value is trusted: the reference sits where routes go). */
    refIsContainer(file, n) {
        if (n.type === 'attribute' && field(n, 'attribute')?.text === 'urls') return true;
        const v = this.refValue(file, n);
        return !v || this.isContainerValue(v.file, v.node);
    }

    /** Value node of a variable reference: { file, node } or null. */
    refValue(file, node, depth = 0) {
        const n = unwrap(node);
        if (!n || depth > MAX_DEPTH) return null;
        if (n.type === 'identifier') {
            const decl = findDecl(this.sess, file, n.text, n);
            if (decl) {
                return decl.kind === 'var' && decl.count === 1 && decl.valueNode
                    ? { file, node: decl.valueNode } : null;
            }
            const entry = this.index.files.get(file);
            const imp = importedAs(entry, n.text);
            const target = imp && this.importTarget(entry, imp);
            return target && !target.module ? this.moduleVarValue(target.file, target.name, depth + 1) : null;
        }
        if (n.type === 'attribute') {
            const obj = unwrap(field(n, 'object'));
            const attr = field(n, 'attribute')?.text;
            if (!obj || !attr || obj.type !== 'identifier' || findDecl(this.sess, file, obj.text, obj)) return null;
            const entry = this.index.files.get(file);
            const imp = importedAs(entry, obj.text);
            const target = imp && this.importTarget(entry, imp);
            return target && target.module ? this.moduleVarValue(target.file, attr, depth + 1) : null;
        }
        return null;
    }

    moduleVarValue(file, name, depth = 0) {
        const entry = this.index.files.get(file);
        if (!entry || depth > MAX_DEPTH) return null;
        if ((entry.moduleAssignedNames || []).includes(name)) {
            const root = this.sess.root(file);
            const decl = root && routeGraph.scopeDecls(this.sess, file, 'python', root).get(name);
            return decl && decl.count === 1 && decl.valueNode ? { file, node: decl.valueNode } : null;
        }
        const imp = importedAs(entry, name);
        const target = imp && this.importTarget(entry, imp);
        return target && !target.module ? this.moduleVarValue(target.file, target.name, depth + 1) : null;
    }

    // ── function-built URL lists ─────────────────────────────────────────

    retKeyOfDef(def) {
        const line = def.node ? field(def.node, 'name').startPosition.row + 1
            : (def.sym.nameLine || def.sym.startLine);
        return `${def.file}#ret:${def.name}:${line}`;
    }

    /** Route lists a function returns become its return container. */
    processReturns(file, fnNode) {
        if (this.returnsDone.has(`${file}#${fnNode.startIndex}`)) return;
        this.returnsDone.add(`${file}#${fnNode.startIndex}`);
        const nameNode = field(fnNode, 'name');
        if (!nameNode) return;
        const key = this.retKeyOfDef({ file, name: nameNode.text, node: fnNode });
        // Statements only: return statements live in blocks and compound
        // statement clauses, never inside expressions.
        const stack = [field(fnNode, 'body')];
        while (stack.length > 0) {
            const n = stack.pop();
            if (!n) continue;
            if (n.type === 'return_statement') {
                const expr = n.namedChild(0);
                if (expr && this.isReturnedList(file, expr)) this.evalContainer(file, expr, key);
                continue;
            }
            if (!STATEMENT_CONTAINERS.has(n.type)) continue;
            for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
        }
    }

    isReturnedList(file, expr) {
        const n = unwrap(expr);
        if (!n) return false;
        if (this.isContainerValue(file, n)) return true;
        if (n.type === 'call') return !!this.roleOf(file, field(n, 'function'));
        if (n.type === 'identifier') {
            const decl = findDecl(this.sess, file, n.text, n);
            return !!(decl && decl.kind === 'var' && decl.valueNode && this.isContainerValue(file, decl.valueNode));
        }
        return false;
    }

    finalizeDeferred() {
        const filled = new Set();
        for (const r of this.routes) if (r.containerKey) filled.add(r.containerKey);
        for (const e of this.edges) if (e.mounterKey) filled.add(e.mounterKey);
        for (const d of this.deferred) {
            if (filled.has(d.retKey)) this.addEdge(d.retKey, d.mounterKey, d.prefix, d.framework);
            else this.addUnresolvedMount(d.file, d.mounterKey, d.node, d.prefix, d.framework, d.derived);
        }
    }

    /** A Django route string: a lazily translated route (`_("users/")`,
     *  gettext_lazy) is declared by its untranslated text. */
    routeString(file, node) {
        const n = unwrap(node);
        if (n && n.type === 'call') {
            const fn = unwrap(field(n, 'function'));
            const imp = fn && fn.type === 'identifier' ? importedAs(this.index.files.get(file), fn.text) : null;
            if (imp && imp.module === 'django.utils.translation' && TRANSLATION_CALLS.has(imp.original)) {
                const arg = argAt(n, /^p/.test(imp.original) ? 1 : 0, 'message');
                if (arg) return evalString(this.sess, file, arg);
            }
        }
        return evalString(this.sess, file, node);
    }

    // ── Starlette ────────────────────────────────────────────────────────

    visitStarletteRoute(file, callNode, role, containerKey) {
        const pathNode = argAt(callNode, 0, 'path');
        const endpoint = unwrap(argAt(callNode, 1, 'endpoint'));
        if (!pathNode) return;
        const own = evalString(this.sess, file, pathNode);
        const line = lineOf(callNode);
        let methods;
        let handler;
        if (role === 'st-ws') {
            methods = ['WS'];
            handler = endpoint ? (endpoint.type === 'call' ? exprText(field(endpoint, 'function')) : shortText(endpoint)) : '<anonymous>';
        } else {
            const explicit = keywordArg(callArgs(callNode), 'methods');
            const list = explicit && stringList(this.sess, file, explicit);
            const view = endpoint ? this.viewMethods(file, endpoint, 'starlette') : { methods: ['ALL'], handler: '<anonymous>' };
            methods = list && list.length > 0 ? [...new Set(list.map(m => m.toUpperCase()))] : view.methods;
            handler = view.handler;
        }
        for (const method of methods) {
            this.addRoute(containerKey, { method, path: own, handler, file, line, framework: 'starlette',
                raw: `${method} ${own}` });
        }
    }

    visitStarletteMount(file, callNode, role, containerKey) {
        const args = callArgs(callNode);
        const prefixNode = role === 'st-mount' ? argAt(callNode, 0, 'path') : null;
        const prefix = prefixNode ? evalString(this.sess, file, prefixNode) : '';
        const routes = keywordArg(args, 'routes');
        const app = unwrap(keywordArg(args, 'app') || positionalArgs(args)[1] || null);
        const key = this.inlineKey(file, callNode);
        if (routes) {
            this.addEdge(key, containerKey, prefix);
            this.evalContainer(file, routes, key);
            return;
        }
        if (!app) return;
        if (app.type === 'call') {
            const appRole = this.roleOf(file, field(app, 'function'));
            if (appRole === 'st-router' || appRole === 'st-app') {
                this.markDone(file, app);
                const inner = this.inlineKey(file, app);
                this.addEdge(inner, containerKey, prefix);
                const r = keywordArg(callArgs(app), 'routes') || (appRole === 'st-router' ? argAt(app, 0, null) : null);
                if (r) this.evalContainer(file, r, inner);
                return;
            }
            if (appRole === 'st-static') {
                this.markDone(file, app);
                this.addRoute(containerKey, { method: 'GET', path: joinSegment(prefix, '{path:path}'),
                    handler: 'StaticFiles', file, line: lineOf(callNode), framework: 'starlette', derived: 'static' });
                return;
            }
        }
        this.linkTarget(file, app, containerKey, prefix, 'starlette', 'mount');
    }

    // ── aiohttp ──────────────────────────────────────────────────────────

    visitAiohttpDef(file, callNode, role, containerKey) {
        const fn = unwrap(field(callNode, 'function'));
        const verb = field(fn, 'attribute')?.text || fn.text;
        const line = lineOf(callNode);
        if (role === 'aio-static') {
            const prefix = evalString(this.sess, file, argAt(callNode, 0, 'prefix'));
            this.addRoute(containerKey, { method: 'GET', path: joinSegment(prefix, '{filename:.*}'),
                handler: 'static', file, line, framework: 'aiohttp', derived: 'static' });
            return;
        }
        let method;
        let pathNode;
        let handlerNode;
        if (role === 'aio-route') {
            const m = evalString(this.sess, file, argAt(callNode, 0, 'method'));
            method = routeGraph.hasUnresolved(m) ? 'ALL' : (m === '*' ? 'ALL' : m.toUpperCase());
            pathNode = argAt(callNode, 1, 'path');
            handlerNode = argAt(callNode, 2, 'handler');
        } else {
            pathNode = argAt(callNode, 0, 'path');
            handlerNode = argAt(callNode, 1, 'handler');
            method = role === 'aio-view' ? null : verb.toUpperCase();
        }
        if (!pathNode) return;
        const own = evalString(this.sess, file, pathNode);
        const view = handlerNode ? this.viewMethods(file, unwrap(handlerNode), 'aiohttp') : { methods: ['ALL'], handler: '<anonymous>' };
        const methods = method ? [method] : view.methods;
        for (const m of methods) {
            this.addRoute(containerKey, { method: m, path: own, handler: view.handler, file, line,
                framework: 'aiohttp', raw: `${m} ${own}` });
        }
    }

    // ── imperative registrations ────────────────────────────────────────

    visitRegistration(file, callNode, reg) {
        const line = lineOf(callNode);
        if (reg.kind === 'list-mutation') {
            const key = this.varKey(file, reg.recv);
            const args = positionalArgs(callArgs(callNode));
            const values = reg.method === 'insert' ? args.slice(1) : args;
            for (const v of values) this.evalContainer(file, v, key);
            return;
        }
        if (reg.kind === 'drf') {
            this.visitDrfRegister(file, callNode, this.varKey(file, reg.recv), reg.recv);
            return;
        }
        const appKey = this.varKey(file, reg.recv);
        if (reg.kind === 'mount') {
            this.visitAppMount(file, callNode, appKey);
            return;
        }
        if (reg.kind === 'aiohttp') {
            if (reg.method === 'add_routes') {
                for (const v of positionalArgs(callArgs(callNode))) this.evalContainer(file, v, appKey);
                return;
            }
            if (reg.method === 'add_subapp') {
                const prefix = evalString(this.sess, file, argAt(callNode, 0, 'prefix'));
                const sub = argAt(callNode, 1, 'subapp');
                if (sub) this.linkTarget(file, sub, appKey, prefix, 'aiohttp', 'mount');
                return;
            }
            const fixed = AIO_ROUTER_METHODS[reg.method];
            if (fixed === 'STATIC') {
                const prefix = evalString(this.sess, file, argAt(callNode, 0, 'prefix'));
                this.addRoute(appKey, { method: 'GET', path: joinSegment(prefix, '{filename:.*}'), handler: 'static',
                    file, line, framework: 'aiohttp', derived: 'static' });
                return;
            }
            let method = fixed;
            let offset = 0;
            if (fixed === null) {
                const m = evalString(this.sess, file, argAt(callNode, 0, 'method'));
                method = routeGraph.hasUnresolved(m) || m === '*' ? 'ALL' : m.toUpperCase();
                offset = 1;
            }
            const pathNode = argAt(callNode, offset, 'path');
            if (!pathNode) return;
            const own = evalString(this.sess, file, pathNode);
            const handlerNode = argAt(callNode, offset + 1, 'handler');
            const view = handlerNode ? this.viewMethods(file, unwrap(handlerNode), 'aiohttp') : { methods: ['ALL'], handler: '<anonymous>' };
            const methods = method === 'VIEW' ? view.methods : [method];
            for (const m of methods) {
                this.addRoute(appKey, { method: m, path: own, handler: view.handler, file, line, framework: 'aiohttp',
                    raw: `${m} ${own}` });
            }
            return;
        }
        // Flask add_url_rule / Starlette add_route family.
        const pathNode = argAt(callNode, 0, reg.kind === 'flask' ? 'rule' : 'path');
        if (!pathNode) return;
        const own = evalString(this.sess, file, pathNode);
        if (!rootedPath(own)) return;
        const args = callArgs(callNode);
        const explicit = keywordArg(args, 'methods');
        const list = explicit && stringList(this.sess, file, explicit);
        let endpoint;
        let framework;
        let methods;
        if (reg.kind === 'flask') {
            framework = 'flask';
            endpoint = unwrap(keywordArg(args, 'view_func') || positionalArgs(args)[2] || null);
        } else {
            framework = reg.method.startsWith('add_api') ? 'fastapi' : 'starlette';
            // Starlette's add_route/add_websocket_route name the endpoint
            // `route`; FastAPI's add_api_route names it `endpoint`.
            endpoint = unwrap(argAt(callNode, 1, framework === 'fastapi' ? 'endpoint' : 'route'));
        }
        if (reg.method.includes('websocket')) methods = ['WS'];
        // FastAPI API routes default to GET.
        else if (framework === 'fastapi' && !(list && list.length > 0)) methods = ['GET'];
        // Flask: a rule with no view function serves GET (the endpoint's view
        // is bound later); Starlette requires an endpoint.
        const view = endpoint ? this.viewMethods(file, endpoint, reg.kind)
            : { methods: reg.kind === 'flask' ? ['GET'] : ['ALL'], handler: '<anonymous>' };
        if (!methods) methods = list && list.length > 0 ? [...new Set(list.map(m => m.toUpperCase()))] : view.methods;
        for (const method of methods) {
            this.addRoute(appKey, { method, path: own, handler: view.handler, file, line, framework,
                raw: `${method} ${own}` });
        }
    }

    /** `app.mount(path, <app>)` with an inline app value: static files,
     *  an inline Starlette/Router, or a disclosed unresolved mount. Named
     *  project routers are composed by the Python router mounts. */
    visitAppMount(file, callNode, appKey) {
        const prefixNode = argAt(callNode, 0, 'path');
        const app = unwrap(argAt(callNode, 1, 'app'));
        if (!prefixNode || !app) return;
        const prefix = evalString(this.sess, file, prefixNode);
        if (!rootedPath(prefix)) return;
        if (app.type === 'identifier' || app.type === 'attribute') return;
        if (app.type === 'call') {
            const appRole = this.roleOf(file, field(app, 'function'));
            if (appRole === 'st-static') {
                this.markDone(file, app);
                this.addRoute(appKey, { method: 'GET', path: joinSegment(prefix, '{path:path}'), handler: 'StaticFiles',
                    file, line: lineOf(callNode), framework: 'starlette', derived: 'static' });
                return;
            }
            if (appRole === 'st-router' || appRole === 'st-app') {
                this.markDone(file, app);
                const inner = this.inlineKey(file, app);
                this.addEdge(inner, appKey, prefix);
                const r = keywordArg(callArgs(app), 'routes') || (appRole === 'st-router' ? argAt(app, 0, null) : null);
                if (r) this.evalContainer(file, r, inner);
                return;
            }
        }
        this.addUnresolvedMount(file, appKey, app, prefix, 'starlette', 'mount');
    }

    // ── DRF routers ──────────────────────────────────────────────────────

    visitDrfRegister(file, callNode, routerKey, routerIdent) {
        const prefixNode = argAt(callNode, 0, 'prefix');
        const viewsetNode = unwrap(argAt(callNode, 1, 'viewset'));
        if (!prefixNode || !viewsetNode) return;
        const prefixRaw = evalString(this.sess, file, prefixNode);
        const prefix = regexToPath(prefixRaw).path;
        const line = lineOf(callNode);
        const trailing = this.drfTrailingSlash(file, routerIdent);
        const cls = this.resolveDef(file, viewsetNode);
        const handler = shortText(viewsetNode);
        const info = cls && cls.kind === 'class' ? this.viewsetInfo(cls) : null;
        const emit = (method, p, derivedHandler) => this.addRoute(routerKey, {
            method, path: p, handler: derivedHandler || handler, file, line,
            framework: 'django', derived: 'drf-router', raw: `${method} ${p}`,
        });
        const listPath = prefix + trailing;
        const lookup = info?.lookup || 'pk';
        const detailPath = `${prefix}/<${lookup}>${trailing}`;
        if (!info || info.actions == null) {
            emit('ALL', listPath);
            emit('ALL', detailPath);
        } else {
            for (const [action, method] of DRF_LIST_ACTIONS) if (info.actions.has(action)) emit(method, listPath);
            for (const [action, method] of DRF_DETAIL_ACTIONS) if (info.actions.has(action)) emit(method, detailPath);
        }
        for (const extra of info?.extraActions || []) {
            const base = extra.detail ? `${prefix}/<${lookup}>` : prefix;
            for (const m of extra.methods) emit(m, `${base}/${extra.urlPath}${trailing}`, `${handler}.${extra.name}`);
        }
        // DefaultRouter serves an API root view at the router's mount point.
        if (!this.drfRootEmitted) this.drfRootEmitted = new Set();
        if (!this.drfRootEmitted.has(routerKey) && this.isDefaultRouter(file, routerIdent)) {
            this.drfRootEmitted.add(routerKey);
            emit('GET', '', 'api-root');
        }
    }

    routerCtor(file, routerIdent) {
        const decl = findDecl(this.sess, file, routerIdent.text, routerIdent);
        const v = decl && unwrap(decl.valueNode);
        return v && v.type === 'call' ? v : null;
    }

    isDefaultRouter(file, routerIdent) {
        const call = this.routerCtor(file, routerIdent);
        const fn = call && unwrap(field(call, 'function'));
        const name = fn && (fn.type === 'attribute' ? field(fn, 'attribute')?.text : fn.text);
        return name === 'DefaultRouter';
    }

    drfTrailingSlash(file, routerIdent) {
        const call = this.routerCtor(file, routerIdent);
        const arg = call && keywordArg(callArgs(call), 'trailing_slash');
        if (!arg) return '/';
        if (arg.type === 'false') return '';
        if (arg.type === 'true') return '/';
        const v = evalString(this.sess, file, arg);
        return routeGraph.hasUnresolved(v) ? '/' : (v === '/?' ? '' : v);
    }

    // ── view resolution ──────────────────────────────────────────────────

    /** { methods: [...], handler } for a view/endpoint expression. */
    viewMethods(file, viewNode, framework, depth = 0) {
        const n = unwrap(viewNode);
        let handler = shortText(n);
        if (!n) return { methods: ['ALL'], handler: '<anonymous>' };
        // `View.as_view(...)` (Django / Flask class-based views).
        if (n.type === 'call') {
            const fn = unwrap(field(n, 'function'));
            if (fn && fn.type === 'attribute' && field(fn, 'attribute')?.text === 'as_view') {
                const clsNode = unwrap(field(fn, 'object'));
                handler = shortText(clsNode);
                const cls = this.resolveDef(file, clsNode);
                if (cls && cls.kind === 'class') {
                    const methods = this.classViewMethods(cls, framework);
                    return { methods: methods || ['ALL'], handler };
                }
                // A framework view class used directly (`TemplateView.as_view()`).
                if (clsNode && (clsNode.type === 'identifier' || clsNode.type === 'attribute')) {
                    const r = this.resolveBase(file, clsNode.text);
                    const provided = r.external ? frameworkProvided(FRAMEWORK_VIEW_BASES, r.external) : undefined;
                    if (provided && provided.length > 0) {
                        return { methods: [...new Set(provided.map(m => (m === 'websocket' ? 'WS' : m.toUpperCase())))], handler };
                    }
                }
                return { methods: ['ALL'], handler };
            }
            // `functools.partial(view, ...)`: the framework unwraps partials.
            if (fn && this.isFunctoolsPartial(file, fn) && argAt(n, 0, null) && depth < 4) {
                return this.viewMethods(file, argAt(n, 0, null), framework, depth + 1);
            }
            return { methods: ['ALL'], handler: fn ? exprText(fn) : handler };
        }
        if (n.type === 'lambda') {
            return { methods: framework === 'starlette' || framework === 'flask' ? ['GET'] : ['ALL'], handler: '<lambda>' };
        }
        if (n.type !== 'identifier' && n.type !== 'attribute') return { methods: ['ALL'], handler };
        const def = this.resolveDef(file, n);
        if (!def) {
            // A variable holding a view (`login = LoginView.as_view()`).
            const v = depth < 4 ? this.refValue(file, n) : null;
            if (v) {
                const inner = this.viewMethods(v.file, v.node, framework, depth + 1);
                return { methods: inner.methods, handler };
            }
            return { methods: ['ALL'], handler };
        }
        if (def.kind === 'class') {
            const methods = this.classViewMethods(def, framework);
            return { methods: methods || ['ALL'], handler };
        }
        // Function views.
        const fromDecorators = this.decoratorMethods(def);
        if (fromDecorators) return { methods: fromDecorators, handler };
        if (framework === 'starlette' || framework === 'flask') return { methods: ['GET'], handler };
        return { methods: ['ALL'], handler };
    }

    isFunctoolsPartial(file, fn) {
        const entry = this.index.files.get(file);
        if (fn.type === 'identifier') {
            const imp = importedAs(entry, fn.text);
            return !!imp && imp.module === 'functools' && imp.original === 'partial';
        }
        if (fn.type === 'attribute' && field(fn, 'attribute')?.text === 'partial') {
            const obj = unwrap(field(fn, 'object'));
            const imp = obj && obj.type === 'identifier' ? importedAs(entry, obj.text) : null;
            return !!imp && imp.binding.kind === 'import' && imp.module === 'functools';
        }
        return false;
    }

    /**
     * Resolve a name/attribute to a function or class definition:
     * { kind, file, name, sym|null, node|null }.
     */
    resolveDef(file, node, depth = 0) {
        const n = unwrap(node);
        if (!n || depth > MAX_DEPTH) return null;
        const memoKey = `${file}#${n.startIndex}:${n.endIndex}`;
        if (depth === 0 && this.defMemo.has(memoKey)) return this.defMemo.get(memoKey);
        let out = null;
        if (n.type === 'identifier') {
            const decl = findDecl(this.sess, file, n.text, n);
            if (decl) {
                if (decl.kind === 'function' || decl.kind === 'class') {
                    out = { kind: decl.kind, file, name: n.text, node: decl.valueNode, sym: null };
                } else if (decl.kind === 'var' && decl.count === 1 && decl.valueNode) {
                    const v = unwrap(decl.valueNode);
                    if (v.type === 'identifier' || v.type === 'attribute') out = this.resolveDef(file, v, depth + 1);
                }
            } else {
                const entry = this.index.files.get(file);
                const imp = importedAs(entry, n.text);
                const target = imp && this.importTarget(entry, imp);
                if (target && !target.module) out = this.topLevelDef(target.file, target.name, depth + 1);
            }
        } else if (n.type === 'attribute') {
            const obj = unwrap(field(n, 'object'));
            const attr = field(n, 'attribute')?.text;
            if (obj && attr && obj.type === 'identifier' && !findDecl(this.sess, file, obj.text, obj)) {
                const entry = this.index.files.get(file);
                const imp = importedAs(entry, obj.text);
                const target = imp && this.importTarget(entry, imp);
                if (target && target.module) out = this.topLevelDef(target.file, attr, depth + 1);
            }
            // `Class.method` (a class's function member).
            if (!out && obj && attr && (obj.type === 'identifier' || obj.type === 'attribute')) {
                const cls = this.resolveDef(file, obj, depth + 1);
                if (cls && cls.kind === 'class') {
                    const member = this.classShape(cls).members.get(attr);
                    if (member) out = member;
                }
            }
        }
        if (depth === 0) this.defMemo.set(memoKey, out);
        return out;
    }

    /** A module-level def of `name` in `file` from the index symbols, chased
     *  through the module's own from-imports. */
    topLevelDef(file, name, depth) {
        if (depth > MAX_DEPTH) return null;
        const entry = this.index.files.get(file);
        if (!entry) return null;
        const sym = (entry.symbols || []).find(s => s.name === name && !s.className &&
            (s.type === 'function' || s.type === 'class'));
        if (sym) return { kind: sym.type, file, name, sym, node: null };
        const imp = importedAs(entry, name);
        const target = imp && this.importTarget(entry, imp);
        if (target && !target.module) return this.topLevelDef(target.file, target.name, depth + 1);
        return null;
    }

    /** Decorator expressions of a def: AST nodes (local def) or snippet
     *  parses of the recorded decorator text (indexed def). */
    decoratorsOf(def) {
        if (def.node) {
            const parent = def.node.parent;
            if (!parent || parent.type !== 'decorated_definition') return [];
            return namedChildren(parent).filter(c => c.type === 'decorator')
                .map(d => namedChildren(d).find(c => !c.type.includes('comment'))).filter(Boolean);
        }
        const out = [];
        for (const text of def.sym?.decorators || []) {
            const root = this.sess.snippet('python', String(text));
            const stmt = root && root.namedChild(0);
            const expr = stmt && (stmt.type === 'expression_statement' ? stmt.namedChild(0) : stmt);
            if (expr) out.push(expr);
        }
        return out;
    }

    decoratorMethods(def) {
        const key = `dm\0${this.defKey(def)}`;
        if (this.methodMemo.has(key)) return this.methodMemo.get(key);
        const out = this.computeDecoratorMethods(def);
        this.methodMemo.set(key, out);
        return out;
    }

    computeDecoratorMethods(def) {
        const entry = this.index.files.get(def.file);
        for (const expr of this.decoratorsOf(def)) {
            const call = expr.type === 'call' ? expr : null;
            const fn = unwrap(call ? field(call, 'function') : expr);
            if (!fn || fn.type !== 'identifier') continue;
            const imp = importedAs(entry, fn.text);
            if (!imp || !DECORATOR_MODULES.test(imp.module)) continue;
            if (DECORATOR_METHODS[imp.original]) return DECORATOR_METHODS[imp.original];
            if ((imp.original === 'require_http_methods' || imp.original === 'api_view') ) {
                if (!call) return imp.original === 'api_view' ? ['GET'] : null;
                const first = argAt(call, 0, imp.original === 'api_view' ? 'http_method_names' : 'request_method_list');
                if (!first) return imp.original === 'api_view' ? ['GET'] : null;
                const list = this.literalList(first);
                if (list && list.length > 0) return [...new Set(list.map(m => m.toUpperCase()))];
                return null;
            }
        }
        return null;
    }

    /** String list of a literal node (snippet-safe: literals only). */
    literalList(node) {
        const n = unwrap(node);
        if (!n || !(n.type === 'list' || n.type === 'tuple' || n.type === 'set')) return null;
        const out = [];
        for (const el of namedChildren(n)) {
            if (el.type.includes('comment')) continue;
            if (!routeGraph.isStringLiteral(el)) return null;
            const v = routeGraph.readLiteral(el, () => null);
            if (v == null) return null;
            out.push(v);
        }
        return out;
    }

    // ── class-based views ────────────────────────────────────────────────

    /** Method names and base-class spellings of a class def. */
    classShape(def) {
        const key = `shape\0${this.defKey(def)}`;
        const cached = this.methodMemo.get(key);
        if (cached) return cached;
        const methods = [];
        let bases;
        const decorators = new Map();
        if (def.node) {
            for (const stmt of namedChildren(field(def.node, 'body'))) {
                const fnNode = stmt.type === 'decorated_definition' ? field(stmt, 'definition') : stmt;
                if (fnNode && fnNode.type === 'function_definition') {
                    const nm = field(fnNode, 'name')?.text;
                    if (nm) {
                        methods.push(nm);
                        decorators.set(nm, { kind: 'function', file: def.file, name: nm, node: fnNode, sym: null });
                    }
                }
            }
            const supers = field(def.node, 'superclasses');
            bases = namedChildren(supers).filter(c => c.type !== 'keyword_argument' && !c.type.includes('comment'))
                .map(c => c.text);
        } else {
            const entry = this.index.files.get(def.file);
            const sym = def.sym;
            for (const s of entry?.symbols || []) {
                if (s.className === def.name && s.startLine >= sym.startLine && s.endLine <= sym.endLine &&
                    (s.type === 'method' || s.isMethod)) {
                    methods.push(s.name);
                    decorators.set(s.name, { kind: 'function', file: def.file, name: s.name, node: null, sym: s });
                }
            }
            bases = sym.extends ? splitParentList(sym.extends).filter(b => !b.includes('=')) : [];
        }
        const shape = { methods, bases, members: decorators };
        this.methodMemo.set(key, shape);
        return shape;
    }

    /** Resolve a base-class spelling from the class's file. */
    resolveBase(file, spelled) {
        const parts = spelled.split('.');
        const entry = this.index.files.get(file);
        if (parts.length === 1) {
            const local = (entry?.symbols || []).find(s => s.name === spelled && s.type === 'class' && !s.className);
            if (local) return { def: { kind: 'class', file, name: spelled, sym: local, node: null } };
            const imp = importedAs(entry, spelled);
            if (!imp) return { unknown: true };
            const target = this.importTarget(entry, imp);
            if (target && !target.module) {
                const d = this.topLevelDef(target.file, target.name, 1);
                if (d && d.kind === 'class') return { def: d };
            }
            return { external: { module: imp.module, name: imp.original } };
        }
        const head = parts[0];
        const imp = importedAs(entry, head);
        if (!imp) return { unknown: true };
        const module = imp.binding.kind === 'import' ? imp.module
            : `${imp.module}.${imp.original}`;
        const fullModule = [module, ...parts.slice(1, -1)].join('.');
        const target = this.importTarget(entry, imp);
        if (target && target.module && parts.length === 2) {
            const d = this.topLevelDef(target.file, parts[1], 1);
            if (d && d.kind === 'class') return { def: d };
        }
        return { external: { module: fullModule, name: parts[parts.length - 1] } };
    }

    /** Walk a class and its ancestors: handler names defined, whether any
     *  ancestor is unknown. `table` maps framework bases to handlers. */
    walkClass(def, table, collect, depth = 0, seen = new Set()) {
        const key = `${def.file}\0${def.name}`;
        if (depth > MAX_DEPTH || seen.has(key)) return { unknown: false };
        seen.add(key);
        const shape = this.classShape(def);
        collect(shape, def, depth);
        let unknown = false;
        for (const base of shape.bases) {
            if (base === 'object') continue;
            const r = this.resolveBase(def.file, base);
            if (r.def) {
                if (this.walkClass(r.def, table, collect, depth + 1, seen).unknown) unknown = true;
                continue;
            }
            if (r.external) {
                const provided = frameworkProvided(table, r.external);
                if (provided === undefined) { unknown = true; continue; }
                if (provided === null) { unknown = true; continue; }
                collect({ methods: provided, bases: [], members: new Map() }, null, depth + 1);
                continue;
            }
            unknown = true;
        }
        return { unknown };
    }

    defKey(def) {
        return `${def.file}\0${def.name}\0${def.sym ? def.sym.startLine : def.node.startIndex}`;
    }

    /** HTTP methods a class-based view serves, or null (every method). */
    classViewMethods(def, framework) {
        const key = `cv\0${framework}\0${this.defKey(def)}`;
        if (this.methodMemo.has(key)) return this.methodMemo.get(key);
        const out = this.computeClassViewMethods(def, framework);
        this.methodMemo.set(key, out);
        return out;
    }

    computeClassViewMethods(def, framework) {
        const found = new Set();
        const { unknown } = this.walkClass(def, FRAMEWORK_VIEW_BASES, (shape, owner, depth) => {
            for (const m of shape.methods) {
                if (m === 'websocket') { found.add('WS'); continue; }
                if (!HTTP_VERB_HANDLERS.includes(m)) continue;
                // OPTIONS is answered by every framework base view; it is
                // listed only when the view class itself defines it.
                if (m === 'options' && depth > 0) continue;
                found.add(m.toUpperCase());
            }
        });
        if (framework === 'flask' && found.size === 0 && !unknown) {
            const methods = this.classAttrList(def, 'methods');
            if (methods) return methods.map(m => m.toUpperCase());
            return ['GET'];
        }
        if (unknown || found.size === 0) return null;
        return [...found].sort(verbOrder);
    }

    /** DRF viewset: available actions (null = unknown), lookup kwarg, @action extras. */
    viewsetInfo(def) {
        const actions = new Set();
        const extraActions = [];
        const allActions = new Set([...DRF_LIST_ACTIONS, ...DRF_DETAIL_ACTIONS].map(a => a[0]));
        const { unknown } = this.walkClass(def, DRF_ACTION_BASES, (shape) => {
            for (const m of shape.methods) {
                if (allActions.has(m)) actions.add(m);
                const member = shape.members.get(m);
                if (!member) continue;
                const extra = this.drfAction(member);
                if (extra && !extraActions.some(e => e.name === extra.name)) extraActions.push(extra);
            }
        });
        const lookup = this.classAttrString(def, 'lookup_url_kwarg') || this.classAttrString(def, 'lookup_field');
        return { actions: unknown ? null : actions, extraActions, lookup };
    }

    drfAction(member) {
        const entry = this.index.files.get(member.file);
        for (const expr of this.decoratorsOf(member)) {
            const call = expr.type === 'call' ? expr : null;
            const fn = unwrap(call ? field(call, 'function') : expr);
            if (!fn || fn.type !== 'identifier') continue;
            const imp = importedAs(entry, fn.text);
            if (!imp || imp.original !== 'action' || !/^rest_framework\.decorators$/.test(imp.module)) continue;
            const args = call ? callArgs(call) : null;
            const detailNode = args && keywordArg(args, 'detail');
            const methodsNode = args && keywordArg(args, 'methods');
            const urlPathNode = args && keywordArg(args, 'url_path');
            const methods = methodsNode ? this.literalList(methodsNode) : ['get'];
            const urlPath = urlPathNode && routeGraph.isStringLiteral(urlPathNode)
                ? routeGraph.readLiteral(urlPathNode, () => null) : member.name;
            return {
                name: member.name,
                detail: detailNode ? detailNode.type === 'true' : false,
                methods: (methods || ['ALL']).map(m => m.toUpperCase()),
                urlPath: urlPath || member.name,
            };
        }
        return null;
    }

    /** A class attribute's literal string (own class, then project bases). */
    classAttrString(def, name, depth = 0) {
        if (depth > MAX_DEPTH) return null;
        const node = this.classNode(def);
        if (node) {
            for (const stmt of namedChildren(field(node, 'body'))) {
                const assign = stmt.type === 'expression_statement' ? stmt.namedChild(0) : null;
                if (!assign || assign.type !== 'assignment') continue;
                const left = field(assign, 'left');
                if (left && left.type === 'identifier' && left.text === name) {
                    const v = evalString(this.classSess(def), def.file, field(assign, 'right'));
                    return routeGraph.hasUnresolved(v) ? null : v;
                }
            }
        }
        for (const base of this.classShape(def).bases) {
            const r = this.resolveBase(def.file, base);
            if (r.def) {
                const v = this.classAttrString(r.def, name, depth + 1);
                if (v) return v;
            }
        }
        return null;
    }

    classAttrList(def, name) {
        const node = this.classNode(def);
        if (!node) return null;
        for (const stmt of namedChildren(field(node, 'body'))) {
            const assign = stmt.type === 'expression_statement' ? stmt.namedChild(0) : null;
            if (!assign || assign.type !== 'assignment') continue;
            const left = field(assign, 'left');
            if (left && left.type === 'identifier' && left.text === name) {
                return stringList(this.classSess(def), def.file, field(assign, 'right'));
            }
        }
        return null;
    }

    /** Session a class def's nodes belong to: its own tree when found in
     *  the active file, else the shared session's full tree. */
    classSess(def) {
        return def.node ? this.sess : this.sess.main;
    }

    /** AST class_definition node of a def (the shared session's full tree
     *  of its file). */
    classNode(def) {
        if (def.node) return def.node;
        if (!def.sym) return null;
        const root = this.sess.main.root(def.file);
        if (!root) return null;
        const row = (def.sym.nameLine || def.sym.startLine) - 1;
        const stack = [root];
        while (stack.length > 0) {
            const n = stack.pop();
            if (n.type === 'class_definition' && field(n, 'name')?.text === def.name &&
                n.startPosition.row <= row && n.endPosition.row >= row) {
                return n;
            }
            if (n.startPosition.row > row || n.endPosition.row < row) continue;
            for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
        }
        return null;
    }

    /**
     * Included ranges for parsing a large candidate file partially: every
     * module-level statement, the top-level definitions holding a located
     * record, and (to a fixpoint) the top-level definitions whose name the
     * included text spells, so every lookup this pass makes inside the file
     * sees the same declarations a full parse would. Null = parse fully
     * (small files, files the router-mount pass parses anyway).
     */
    partialRanges(file, sharedFiles) {
        const plan = this.plans.get(file);
        if (!plan || sharedFiles.has(file)) return null;
        const entry = this.index.files.get(file);
        const text = this.sess.text(file);
        if (!entry || text.length < PARTIAL_PARSE_MIN_CHARS) return null;
        const lineStarts = [0];
        for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
        const lineCount = lineStarts.length;
        const symbols = entry.symbols || [];
        // Outermost definitions among `list` (a definition nested in another
        // one belongs to it).
        const outermost = (list) => {
            const out = [];
            let lastEnd = 0;
            for (const s of [...list].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine)) {
                if (s.startLine <= lastEnd) continue;
                out.push({ name: s.name, startLine: s.startLine, endLine: s.endLine, type: s.type, members: null });
                lastEnd = s.endLine;
            }
            return out;
        };
        // Top-level units: column-0 definitions; a class's direct members are
        // sub-units, so a large class holding one route list parses only the
        // member that holds it.
        const units = outermost(symbols.filter(s => !s.className && (s.type === 'function' || s.type === 'class')))
            .filter(d => {
                const start = lineStarts[d.startLine - 1];
                return start != null && !/\s/.test(text[start] || ' ');
            });
        if (units.length === 0) return null;
        for (const u of units) {
            if (u.type !== 'class') continue;
            u.members = outermost(symbols.filter(s => s.className === u.name &&
                s.startLine > u.startLine && s.endLine <= u.endLine));
        }
        const lines = plan.pointed.map(r => r.line);
        const holds = d => lines.some(l => l >= d.startLine && l <= d.endLine);
        const keep = new Map(); // unit/member -> true
        for (const u of units) {
            if (!holds(u)) continue;
            keep.set(u, true);
            for (const m of u.members || []) if (holds(m)) keep.set(m, true);
        }
        const fullClass = new Set(); // classes kept whole (spelled by name)
        const rangeText = (a, b) => text.slice(lineStarts[a - 1], b < lineCount ? lineStarts[b] : text.length);
        // Included line spans in order.
        const spans = () => {
            const out = [];
            let cursor = 1;
            for (const u of units) {
                if (u.startLine > cursor) out.push([cursor, u.startLine - 1]);
                if (keep.has(u)) {
                    if (!u.members || fullClass.has(u)) out.push([u.startLine, u.endLine]);
                    else {
                        let c = u.startLine;
                        for (const m of u.members) {
                            if (m.startLine > c) out.push([c, m.startLine - 1]);
                            if (keep.has(m)) out.push([m.startLine, m.endLine]);
                            c = m.endLine + 1;
                        }
                        if (c <= u.endLine) out.push([c, u.endLine]);
                    }
                }
                cursor = u.endLine + 1;
            }
            if (cursor <= lineCount) out.push([cursor, lineCount]);
            return out;
        };
        // Fixpoint: a definition whose name the included text spells is
        // included whole, so every lookup sees what a full parse would.
        let included = '';
        for (let changed = true; changed;) {
            changed = false;
            included = spans().map(([a, b]) => rangeText(a, b)).join('\n');
            // A definition's own `def`/`class` header does not reference it.
            const words = new Set(included.replace(/\b(?:def|class)\s+[A-Za-z_][A-Za-z0-9_]*/g, ' ')
                .match(/[A-Za-z_][A-Za-z0-9_]*/g) || []);
            for (const u of units) {
                if (!words.has(u.name)) {
                    for (const m of (keep.has(u) && u.members) || []) {
                        if (!keep.has(m) && words.has(m.name)) { keep.set(m, true); changed = true; }
                    }
                    continue;
                }
                if (!keep.has(u)) { keep.set(u, true); changed = true; }
                if (u.members && !fullClass.has(u)) { fullClass.add(u); changed = true; }
            }
        }
        if (included.length > text.length * 0.7) return null;
        const ranges = [];
        for (const [a, b] of spans()) {
            const startIndex = lineStarts[a - 1];
            const endIndex = b < lineCount ? lineStarts[b] : text.length;
            if (endIndex <= startIndex) continue;
            const endPosition = b < lineCount ? { row: b, column: 0 }
                : { row: lineCount - 1, column: endIndex - lineStarts[lineCount - 1] };
            const last = ranges[ranges.length - 1];
            if (last && last.endIndex === startIndex) {
                last.endIndex = endIndex;
                last.endPosition = endPosition;
                continue;
            }
            ranges.push({ startIndex, endIndex, startPosition: { row: a - 1, column: 0 }, endPosition });
        }
        return ranges;
    }

    // ── settings ─────────────────────────────────────────────────────────

    /** `ROOT_URLCONF = "pkg.urls"` in a settings module: that URLconf is a root. */
    collectRootUrlconf(file) {
        const root = this.sess.root(file);
        if (!root) return;
        for (const stmt of namedChildren(root)) {
            const assign = stmt.type === 'expression_statement' ? stmt.namedChild(0) : null;
            if (!assign || assign.type !== 'assignment') continue;
            const left = field(assign, 'left');
            if (!left || left.text !== 'ROOT_URLCONF') continue;
            const spec = evalString(this.sess, file, field(assign, 'right'));
            if (routeGraph.hasUnresolved(spec)) continue;
            const modFile = this.moduleFile(file, spec) || this.moduleFileFromRoot(spec);
            if (modFile) this.roots.add(`${modFile}:urlpatterns`);
        }
    }

    moduleFileFromRoot(spec) {
        const rel = spec.replace(/\./g, '/');
        for (const cand of [`${rel}.py`, `${rel}/__init__.py`]) {
            const abs = path.join(this.index.root, cand);
            if (this.index.files.has(abs)) return abs;
        }
        return null;
    }

    run() {
        const { files, settings } = this.candidates();
        for (const [f, plan] of files) this.plans.set(f, plan);
        for (const [f, plan] of files) this.collectFile(f, plan);
        for (const f of settings) this.collectRootUrlconf(f);
        this.finalizeDeferred();
        return this;
    }
}

// ============================================================================
// PATH HELPERS
// ============================================================================

/** Handlers (or actions) a framework base class provides: an array, null
 *  (serves every method), or undefined (not a known framework class). */
function frameworkProvided(table, external) {
    const row = table.find(([re]) => re.test(external.module));
    if (!row || !Object.prototype.hasOwnProperty.call(row[1], external.name)) return undefined;
    return row[1][external.name];
}

function isModuleLevel(node) {
    let n = node.parent;
    while (n) {
        if (n.type === 'function_definition' || n.type === 'class_definition' || n.type === 'lambda') return false;
        if (n.type === 'module') return true;
        n = n.parent;
    }
    return false;
}

function shortText(node) {
    if (!node) return '<anonymous>';
    const n = unwrap(node);
    if (n.type === 'identifier') return n.text;
    if (n.type === 'attribute') return field(n, 'attribute')?.text || n.text;
    if (n.type === 'call') {
        const fn = unwrap(field(n, 'function'));
        return fn ? `${shortText(fn)}()` : '<anonymous>';
    }
    return String(n.text).replace(/\s+/g, ' ').slice(0, 40);
}

function exprText(node) {
    return String(node?.text || '<anonymous>').replace(/\s+/g, ' ').slice(0, 60);
}

function stripLeading(p) {
    return String(p || '').replace(/^\/+/, '');
}

/** Join a route fragment and a sub-segment the way the framework composes
 *  (fix #383): Django concatenates pattern strings; Starlette and aiohttp
 *  join path segments with one '/'. */
function joinSegment(prefix, segment, framework = null) {
    const p = String(prefix || '');
    if (!p) return segment;
    if (framework === 'django') return p + segment;
    return p.endsWith('/') ? p + segment : `${p}/${segment}`;
}

const VERB_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'WS'];
function verbOrder(a, b) {
    return VERB_ORDER.indexOf(a) - VERB_ORDER.indexOf(b);
}

/**
 * Collect declarative / imperatively registered Python routes.
 * @returns {{ routes, edges, roots }}
 */
function collectRouteLists(index, sess, sharedFiles = new Set()) {
    const collector = new RouteListCollector(index, sess, sharedFiles).run();
    return { routes: collector.routes, edges: collector.edges, roots: collector.roots,
        containers: collector.containers };
}

/**
 * Container key of a Python name reference, in the collector's key scheme
 * (fix #392): the declaring binding (`file:name` at module level,
 * `file@scope:name` in a function), else the module-level name an import
 * binds (`defining-file:name`).
 */
function pythonContainerKey(index, sess, file, identNode) {
    if (!identNode || identNode.type !== 'identifier') return null;
    const name = identNode.text;
    const decl = findDecl(sess, file, name, identNode);
    if (decl) {
        if (decl.kind !== 'var') return null;
        if (decl.scope.parent === null) return `${file}:${name}`;
        return `${file}@${decl.scope.startIndex}:${name}`;
    }
    const entry = index.files.get(file);
    const imp = importedAs(entry, name);
    if (imp) {
        const { binding, original, module } = imp;
        if (binding.kind === 'import') return null;
        const resolved = spec => entry.moduleResolved?.[spec];
        const subSpec = module.endsWith('.') ? module + original : `${module}.${original}`;
        if (resolved(subSpec)) return null;
        const rel = resolved(module);
        return rel ? `${path.join(index.root, rel)}:${original}` : null;
    }
    return (entry?.moduleAssignedNames || []).includes(name) ? `${file}:${name}` : null;
}

module.exports = {
    collectRouteLists,
    pythonContainerKey,
    regexToPath,
    regexCanMatchSlash,
    ANY_TEXT,
};
