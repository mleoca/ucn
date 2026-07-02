/**
 * core/entrypoints.js - Framework entry point detection
 *
 * Detects functions registered as framework handlers (HTTP routes, DI beans,
 * job schedulers, etc.) that are invoked by the framework at runtime, not by
 * user code. These functions should never be flagged as dead code.
 *
 * Two detection methods:
 * 1. Decorator/modifier matching (Python, Java, Rust, JS/TS decorators)
 * 2. Call-pattern matching (Express routes, Gin handlers, Go http.HandleFunc)
 */

'use strict';

const fs = require('fs');
const { codeUnitCompare } = require('./shared');
const path = require('path');
const { getCachedCalls } = require('./callers');
const { getLanguageModule } = require('../languages');

// ============================================================================
// FRAMEWORK PATTERNS
// ============================================================================

const JS_LANGS = new Set(['javascript', 'typescript', 'tsx']);

const FRAMEWORK_PATTERNS = [
    // ── HTTP Routes ─────────────────────────────────────────────────────

    // Express — call-pattern: app.get('/path', handler), router.get(...), etc.
    {
        id: 'express-route',
        languages: JS_LANGS,
        type: 'http',
        framework: 'express',
        detection: 'callPattern',
        receiverPattern: /^(app|router|server)$/i,
        methodPattern: /^(get|post|put|delete|patch|all|use|options|head)$/,
    },

    // Fastify — call-pattern: fastify.get('/path', handler)
    {
        id: 'fastify-route',
        languages: JS_LANGS,
        type: 'http',
        framework: 'fastify',
        detection: 'callPattern',
        receiverPattern: /^fastify$/i,
        methodPattern: /^(get|post|put|delete|patch|all|use|options|head|route)$/,
    },

    // Koa-router — call-pattern: koaRouter.get('/path', handler)
    {
        id: 'koa-route',
        languages: JS_LANGS,
        type: 'http',
        framework: 'koa',
        detection: 'callPattern',
        receiverPattern: /^(koaRouter|koa)$/i,
        methodPattern: /^(get|post|put|delete|patch|all|use|options|head)$/,
    },

    // NestJS (JS/TS) — decorators: @Get(), @Post(), @Controller(), etc.
    {
        id: 'nestjs-handler',
        languages: JS_LANGS,
        type: 'http',
        framework: 'nestjs',
        detection: 'decorator',
        pattern: /^(Get|Post|Put|Delete|Patch|Options|Head|All|Controller|Injectable|Module)$/,
    },

    // FastAPI (Python) — decorators: @app.get('/path'), @router.post('/path')
    {
        id: 'fastapi-route',
        languages: new Set(['python']),
        type: 'http',
        framework: 'fastapi',
        detection: 'decorator',
        pattern: /^(app|router)\.(get|post|put|delete|patch|options|head)/,
    },

    // Flask (Python) — decorators: @app.route('/path'), @bp.get('/path')
    {
        id: 'flask-route',
        languages: new Set(['python']),
        type: 'http',
        framework: 'flask',
        detection: 'decorator',
        pattern: /^(app|bp|blueprint)\.(route|get|post|put|delete|patch)/,
    },

    // Django (Python) — decorators: @api_view, @action, @permission_classes
    {
        id: 'django-view',
        languages: new Set(['python']),
        type: 'http',
        framework: 'django',
        detection: 'decorator',
        pattern: /^(api_view|action|permission_classes|login_required|csrf_exempt)/,
    },

    // Spring HTTP (Java) — modifiers (lowercased annotations)
    {
        id: 'spring-mapping',
        languages: new Set(['java']),
        type: 'http',
        framework: 'spring',
        detection: 'modifier',
        pattern: /^(getmapping|postmapping|putmapping|deletemapping|patchmapping|requestmapping)$/,
    },

    // Gin (Go) — call-pattern: router.GET('/path', handler)
    {
        id: 'gin-route',
        languages: new Set(['go']),
        type: 'http',
        framework: 'gin',
        detection: 'callPattern',
        receiverPattern: /^(router|r|g|group|engine|api|v\d+)$/i,
        methodPattern: /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Handle)$/,
    },

    // Go net/http — call-pattern: http.HandleFunc('/path', handler)
    {
        id: 'go-http',
        languages: new Set(['go']),
        type: 'http',
        framework: 'net/http',
        detection: 'callPattern',
        receiverPattern: /^(http|mux|serveMux)$/i,
        methodPattern: /^(HandleFunc|Handle)$/,
    },

    // Actix (Rust) — the runtime/test macros are NOT routes (fix #243:
    // #[actix_web::main] was typed http, so --type runtime missed main on
    // actix apps and --type http listed it as a route).
    {
        id: 'actix-main',
        languages: new Set(['rust']),
        type: 'runtime',
        framework: 'actix',
        detection: 'modifier',
        pattern: /^actix_web::main$/,
    },
    {
        id: 'actix-test',
        languages: new Set(['rust']),
        type: 'test',
        framework: 'actix',
        detection: 'modifier',
        pattern: /^actix_web::test$/,
    },
    // Actix (Rust) — modifiers from #[get("/path")], #[post("/path")]
    {
        id: 'actix-route',
        languages: new Set(['rust']),
        type: 'http',
        framework: 'actix',
        detection: 'modifier',
        pattern: /^(get|post|put|delete|patch)$/,
    },

    // ── Dependency Injection ────────────────────────────────────────────

    // Spring DI (Java)
    {
        id: 'spring-di',
        languages: new Set(['java']),
        type: 'di',
        framework: 'spring',
        detection: 'modifier',
        // JAVA-4: Spring DI / IoC core annotations
        pattern: /^(bean|component|service|controller|repository|configuration|restcontroller|restcontrolleradvice|controlleradvice|springbootapplication|springbootconfiguration|enableautoconfiguration|componentscan|conditional(on\w+)?|profile|primary|qualifier|autowired|inject|value|scope|lazy|order|dependson|import|importresource|propertysource)$/,
    },

    // JAVA-4: Spring MVC binding/validation annotations on handler-method
    // parameters/methods. Treated as entry points because Spring's
    // DispatcherServlet calls these methods reflectively.
    {
        id: 'spring-mvc-method',
        languages: new Set(['java']),
        type: 'http',
        framework: 'spring-mvc',
        detection: 'modifier',
        pattern: /^(initbinder|modelattribute|exceptionhandler|sessionattributes|requestbody|responsebody|responsestatus|crossorigin|pathvariable|requestparam|requestheader|requestattribute|cookievalue|matrixvariable|validated|valid|validator)$/,
    },

    // JAVA-4: JPA / Hibernate persistence annotations. The persistence
    // provider instantiates and reads these via reflection.
    {
        id: 'jpa-entity',
        languages: new Set(['java']),
        type: 'di',
        framework: 'jpa',
        detection: 'modifier',
        pattern: /^(entity|mappedsuperclass|embeddable|embedded|table|secondarytable|column|id|generatedvalue|sequencegenerator|tablegenerator|version|enumerated|temporal|lob|basic|transient|access|onetomany|manytoone|onetoone|manytomany|joincolumn|joincolumns|jointable|orderby|orderColumn|inheritance|discriminatorcolumn|discriminatorvalue|namedquery|namedqueries|namednativequery|sqlresultsetmapping|fieldresultsetmapping|attributeoverride|attributeoverrides|associationoverride|cacheable|maptkey|mapkeyenumerated|mapkeycolumn|maptemporal|elementcollection|collectiontable|converter|convert|cascade)$/,
    },

    // JAVA-4: JPA / Spring Data query annotation.
    {
        id: 'spring-data-query',
        languages: new Set(['java']),
        type: 'di',
        framework: 'spring-data',
        detection: 'modifier',
        pattern: /^(query|modifying|procedure|namedquery|param|lock|querytype|entitygraph|projection)$/,
    },

    // JAVA-4: Transactional / caching / async / scheduling cross-cutting
    // annotations (Spring AOP / Spring tx).
    {
        id: 'spring-tx',
        languages: new Set(['java']),
        type: 'di',
        framework: 'spring',
        detection: 'modifier',
        pattern: /^(transactional|cacheable|cacheevict|cacheput|caching|enabletransactionmanagement|enablecaching|enableasync|enablescheduling|enableaspectjautoproxy)$/,
    },

    // JAVA-4: JAX-RS / JAX-B / XML binding annotations. Frameworks
    // (Jersey, JAXB, etc.) instantiate and serialize via reflection.
    {
        id: 'jax-binding',
        languages: new Set(['java']),
        type: 'http',
        framework: 'jax-rs',
        detection: 'modifier',
        pattern: /^(path|produces|consumes|provider|webservice|webmethod|webparam|webresult|xmlrootelement|xmlelement|xmlattribute|xmlaccessortype|xmltype|xmltransient|xmlid|xmlidref|xmlschematype|xmlseealso|xmlanyelement|xmlanyattribute)$/,
    },

    // ── Job Schedulers ──────────────────────────────────────────────────

    // Spring Scheduled (Java)
    {
        id: 'spring-jobs',
        languages: new Set(['java']),
        type: 'jobs',
        framework: 'spring',
        detection: 'modifier',
        pattern: /^(scheduled|eventlistener|async)$/,
    },

    // Celery (Python)
    {
        id: 'celery-task',
        languages: new Set(['python']),
        type: 'jobs',
        framework: 'celery',
        detection: 'decorator',
        pattern: /^(app\.task|shared_task|celery\.task)/,
    },

    // ── Test Frameworks ─────────────────────────────────────────────────

    // pytest fixtures (Python)
    {
        id: 'pytest-fixture',
        languages: new Set(['python']),
        type: 'test',
        framework: 'pytest',
        detection: 'decorator',
        pattern: /^pytest\.fixture/,
    },

    // ── Runtime ─────────────────────────────────────────────────────────

    // Tokio (Rust)
    {
        id: 'tokio-main',
        languages: new Set(['rust']),
        type: 'runtime',
        framework: 'tokio',
        detection: 'modifier',
        pattern: /^tokio::main$/,
    },

    // ── Go Runtime Entry Points ─────────────────────────────────────────

    // Go main function (program entry). symbolFilter: only FREE functions —
    // a method named main on a receiver is an ordinary method (fix #243).
    {
        id: 'go-main',
        languages: new Set(['go']),
        type: 'runtime',
        framework: 'go',
        detection: 'namePattern',
        pattern: /^main$/,
        symbolFilter: (s) => !s.className && !s.receiver,
    },

    // Go init functions (package initialization, called by runtime)
    {
        id: 'go-init',
        languages: new Set(['go']),
        type: 'runtime',
        framework: 'go',
        detection: 'namePattern',
        pattern: /^init$/,
        symbolFilter: (s) => !s.className && !s.receiver,
    },

    // Go test functions (called by go test)
    {
        id: 'go-test',
        languages: new Set(['go']),
        type: 'test',
        framework: 'go',
        detection: 'namePattern',
        pattern: /^(Test|Benchmark|Example|Fuzz)[A-Z_]/,
    },

    // ── Java entry points ─────────────────────────────────────────────

    // Java main(String[] args) — JVM entry point. Java main IS a method, but
    // only a STATIC one is JVM-invocable (fix #243).
    {
        id: 'java-main',
        languages: new Set(['java']),
        type: 'runtime',
        framework: 'java',
        detection: 'namePattern',
        pattern: /^main$/,
        symbolFilter: (s) => (s.modifiers || []).includes('static'),
    },

    // JUnit @Test family — Java parser lowercases annotations into `modifiers`,
    // not `decorators`, so detection must run against modifiers.
    // JAVA-4: also include lifecycle (BeforeEach/AfterEach/etc.), nested test
    // classes, extension wiring, and SpringBoot/MVC/Data test slices.
    {
        id: 'java-junit-test',
        languages: new Set(['java']),
        type: 'test',
        framework: 'junit',
        detection: 'modifier',
        pattern: /^(test|parameterizedtest|repeatedtest|testfactory|testtemplate|beforeall|beforeeach|afterall|aftereach|nested|disabled|enabled|enabledon\w*|disabledon\w*|tag|displayname|extendwith|registerextension|testmethodorder|testinstance|timeout|csvsource|valuesource|methodsource|enumsource|argumentssource|csvfilesource)$/,
    },

    // JAVA-4: Spring Boot test slices and integration test annotations.
    {
        id: 'spring-boot-test',
        languages: new Set(['java']),
        type: 'test',
        framework: 'spring-boot-test',
        detection: 'modifier',
        pattern: /^(springboottest|webmvctest|datajpatest|datamongotest|dataredistest|datacassandratest|jsontest|jdbctest|jooqtest|webfluxtest|restclienttest|graphqltest|autoconfiguremockmvc|autoconfiguredatajpa|autoconfigurewebmvc|mockbean|spybean|mockitobean|spymockitobean|sqlgroup|sql|testpropertysource|activeprofiles|dirtiescontext|recordapplicationevents|contextconfiguration|webappconfiguration|importautoconfiguration|bootstrapwith|testexecutionlisteners|transactionalconfiguration|repeatedtests)$/,
    },

    // Spring HTTP route annotations — same lowercase-modifier rule
    {
        id: 'spring-http-mapping',
        languages: new Set(['java']),
        type: 'http',
        framework: 'spring',
        detection: 'modifier',
        pattern: /^(getmapping|postmapping|putmapping|deletemapping|patchmapping|requestmapping)$/,
    },

    // ── Rust entry points ─────────────────────────────────────────────

    // Rust main() — the FREE function fn main() is the binary entry point;
    // an impl method named main is an ordinary method (fix #243)
    {
        id: 'rust-main',
        languages: new Set(['rust']),
        type: 'runtime',
        framework: 'rust',
        detection: 'namePattern',
        pattern: /^main$/,
        symbolFilter: (s) => !s.className && !s.receiver,
    },

    // Rust #[test] attribute — Rust parser stores attributes as `modifiers`,
    // not `decorators`, so detection has to run against modifiers.
    // (The older tokio-main pattern at line 169 already uses 'modifier' correctly.)
    {
        id: 'rust-test-attr',
        languages: new Set(['rust']),
        type: 'test',
        framework: 'rust',
        detection: 'modifier',
        pattern: /^(test|tokio::test|cfg\(test\))$/,
    },

    // ── Go Framework Patterns ─────────────────────────────────────────

    // Cobra CLI framework — RunE, Run, PreRunE etc. assigned to cobra.Command struct fields
    // Detected via composite literal: &cobra.Command{RunE: handler}
    {
        id: 'cobra-command',
        languages: new Set(['go']),
        type: 'cli',
        framework: 'cobra',
        detection: 'compositePattern',
        typePattern: /^cobra\.Command$/,
        fieldPattern: /^(Run|RunE|PreRun|PreRunE|PostRun|PostRunE|PersistentPreRun|PersistentPreRunE|PersistentPostRun|PersistentPostRunE)$/,
    },

    // Go goroutine launch — go func() or go handler()
    // (detected separately in namePattern since it's a language feature)

    // ── JS/TS Runtime Entry Points ────────────────────────────────────

    // Node CLI / app main: symbols defined in conventionally-named entry files.
    // - bin/* (npm "bin" entries)
    // - index.{js,ts,mjs,cjs} (package main convention)
    // - main.{js,ts,mjs,cjs} (electron main, etc.)
    // - cli.{js,ts,mjs,cjs}
    // - server.{js,ts,mjs,cjs}
    {
        id: 'js-cli-main',
        languages: JS_LANGS,
        type: 'runtime',
        framework: 'node',
        detection: 'filePath',
        // Match files under bin/ (any depth), or top-level index/main/cli/server in any directory.
        // The matcher is run against the project-relative path with forward slashes.
        pathPattern: /(^|\/)bin\/[^/]+\.(js|ts|mjs|cjs)$|(^|\/)(index|main|cli|server)\.(js|ts|mjs|cjs)$/,
    },

    // Node shebang entry: any file whose first bytes are `#!/usr/bin/env node`
    // or `#!/path/to/node`. These are runnable scripts, not libraries.
    {
        id: 'js-shebang-main',
        languages: JS_LANGS,
        type: 'runtime',
        framework: 'node',
        detection: 'shebang',
        shebangPattern: /^#![^\n]*\bnode\b/,
    },

    // Jest/Mocha/Vitest test files: any function defined in a *.test.* /
    // *.spec.* file or under __tests__/, test/, tests/.
    {
        id: 'js-test-file',
        languages: JS_LANGS,
        type: 'test',
        framework: 'jest',
        detection: 'filePath',
        pathPattern: /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.(js|ts|jsx|tsx|mjs|cjs)$/,
    },

    // Next.js pages/routes: default-exported functions from files under
    // pages/ or app/ are runtime entry points (rendered/served by Next.js).
    {
        id: 'next-page',
        languages: JS_LANGS,
        type: 'runtime',
        framework: 'next',
        detection: 'filePath',
        pathPattern: /(^|\/)(pages|app)\/.*\.(js|ts|jsx|tsx|mjs|cjs)$/,
    },

    // ── Python Runtime Entry Points ────────────────────────────────────

    // __main__.py — package executable entry (python -m pkg).
    // The `if __name__ == '__main__':` guard wraps statements not functions,
    // so we treat any function in __main__.py as runtime-reachable.
    {
        id: 'python-main-module',
        languages: new Set(['python']),
        type: 'runtime',
        framework: 'python',
        detection: 'filePath',
        pathPattern: /(^|\/)__main__\.py$/,
    },

    // ── Catch-all fallbacks ─────────────────────────────────────────────

    // Python: any decorator with '.' (attribute access) — framework registration heuristic
    // Catches @app.route, @router.get, @celery.task, @something.hook, etc.
    // Placed last so specific patterns match first (for better type/framework labeling).
    {
        id: 'python-dotted-decorator',
        languages: new Set(['python']),
        type: 'events',
        framework: 'unknown',
        detection: 'decorator',
        pattern: /\./,
    },

    // Java: any non-standard annotation (not a keyword modifier or standard JDK annotation)
    // Catches @Bean, @Scheduled, @EventListener, @Transactional, etc.
    // Placed last so specific patterns match first.
    {
        id: 'java-custom-annotation',
        languages: new Set(['java']),
        type: 'di',
        framework: 'unknown',
        detection: 'modifier',
        pattern: /^(?!public$|private$|protected$|static$|final$|abstract$|synchronized$|native$|default$|override$|deprecated$|suppresswarnings$|functionalinterface$|safevarargs$)/,
    },
];

// ============================================================================
// DETECTION
// ============================================================================

/**
 * Check if a symbol matches any decorator/modifier-based framework pattern.
 * @param {object} symbol - Symbol from the symbol table
 * @param {string} language - File language
 * @returns {{ pattern: object, matchedOn: string }|null}
 */
function matchDecoratorOrModifier(symbol, language) {
    const decorators = symbol.decorators || [];
    const modifiers = symbol.modifiers || [];

    for (const fp of FRAMEWORK_PATTERNS) {
        if (!fp.languages.has(language)) continue;

        if (fp.detection === 'decorator') {
            const matched = decorators.find(d => fp.pattern.test(d));
            if (matched) return { pattern: fp, matchedOn: `@${matched}` };
        }

        if (fp.detection === 'modifier') {
            const matched = modifiers.find(m => fp.pattern.test(m));
            if (matched) return { pattern: fp, matchedOn: `@${matched}` };
        }
    }

    return null;
}

/**
 * Build a map of symbol names used as callbacks in framework route-registration calls.
 * Scans the calls cache for call-pattern-based framework detection.
 *
 * BUG M2: only treat a call as a route registration when its first argument is a
 * literal string path. Library implementations such as gin's
 * `group.GET(relativePath, handler)` (where `relativePath` is a parameter, not a
 * literal) would otherwise capture local variable names (`relativePath`,
 * `handler`, `urlPattern`) as if they were handler functions. The string-literal
 * check aligns this with bridge.js's `extractServerRoutes` so the route count in
 * `entrypoints` matches the route count in `endpoints`.
 *
 * For HTTP route patterns we additionally apply Express's dual-purpose API check
 * (1-arg `app.get('env')` is a config getter, not a route registration).
 *
 * @param {object} index - ProjectIndex
 * @returns {Map<string, { framework, type, patternId, method, file, line }>}
 */
function buildCallbackEntrypointMap(index) {
    const callPatterns = FRAMEWORK_PATTERNS.filter(p => p.detection === 'callPattern');
    const compositePatterns = FRAMEWORK_PATTERNS.filter(p => p.detection === 'compositePattern');
    if (callPatterns.length === 0 && compositePatterns.length === 0) return new Map();

    const result = new Map(); // name -> info

    // Attribute the entry point to the handler's DEFINITION, not the
    // registration call site: `about handler --file X --line N` handles must
    // resolve, and reachability seeding matches (absoluteFile, line) against
    // symbol defs — a handler defined in a different file than its
    // registration was never seeded. The registration site is kept as
    // evidence (registrationFile/registrationLine).
    const resolveHandlerDef = (name, registrationFile) => {
        const defs = index.symbols.get(name);
        if (!defs || defs.length === 0) return null;
        // Prefer a def in the registration file; defs are canonical-sorted,
        // so falling back to the first is deterministic.
        return defs.find(d => d.file === registrationFile) || defs[0];
    };

    for (const [filePath, fileEntry] of index.files) {
        const lang = fileEntry.language;

        const calls = getCachedCalls(index, filePath);
        if (!calls) continue;

        // Pass 1+2: call-pattern detection (e.g., app.GET("/", handler))
        const relevantCallPatterns = callPatterns.filter(p => p.languages.has(lang));
        if (relevantCallPatterns.length > 0) {
            // Pass 1: find route-registration calls, index by line
            const routeLines = new Map(); // line -> { pattern, call }
            for (const call of calls) {
                if (!call.receiver) continue;
                for (const pattern of relevantCallPatterns) {
                    if (pattern.receiverPattern.test(call.receiver) &&
                        pattern.methodPattern.test(call.name)) {
                        // BUG M2 (interpolated paths): align with bridge.js's
                        // extractServerRoutes — skip routes whose path is interpolated.
                        if (pattern.type === 'http' && call.firstStringArg && call.firstStringArgInterp) continue;
                        // BUG M5: Express dual-purpose APIs — 1-arg .get('env') is a
                        // config getter, not a route registration.
                        if (pattern.framework === 'express' &&
                            typeof call.argCount === 'number' && call.argCount < 2) continue;
                        routeLines.set(call.line, { pattern, call });
                        break;
                    }
                }
            }

            if (routeLines.size > 0) {
                // Pass 2: find callbacks on route-registration lines
                for (const call of calls) {
                    if (!call.isFunctionReference && !call.isPotentialCallback) continue;
                    const route = routeLines.get(call.line);
                    if (!route) continue;

                    // BUG M2: only treat as a handler if the name resolves to a
                    // project-defined symbol. Library code like gin's
                    //   `group.GET(relativePath, handler)`
                    // (routergroup.go:185) has identifiers that are local parameters,
                    // not exported handler functions — they must not be marked as
                    // entry points. This aligns the HTTP Routes section with
                    // bridge.js's extractServerRoutes.
                    if (!index.symbols.has(call.name)) continue;

                    if (!result.has(call.name)) {
                        const def = resolveHandlerDef(call.name, filePath);
                        result.set(call.name, {
                            framework: route.pattern.framework,
                            type: route.pattern.type,
                            patternId: route.pattern.id,
                            method: route.call.name.toUpperCase(),
                            file: def ? def.file : filePath,
                            line: def ? def.startLine : call.line,
                            registrationFile: filePath,
                            registrationLine: call.line,
                        });
                    }
                }
            }
        }

        // Pass 3: composite literal patterns (e.g., &cobra.Command{RunE: handler})
        const relevantCompositePatterns = compositePatterns.filter(p => p.languages.has(lang));
        if (relevantCompositePatterns.length > 0) {
            for (const call of calls) {
                if (!call.compositeType) continue;
                if (!call.isPotentialCallback && !call.isFunctionReference) continue;

                for (const pattern of relevantCompositePatterns) {
                    if (pattern.typePattern.test(call.compositeType) &&
                        pattern.fieldPattern.test(call.fieldName)) {
                        if (!result.has(call.name)) {
                            const def = resolveHandlerDef(call.name, filePath);
                            result.set(call.name, {
                                framework: pattern.framework,
                                type: pattern.type,
                                patternId: pattern.id,
                                method: call.fieldName,
                                file: def ? def.file : filePath,
                                line: def ? def.startLine : call.line,
                                registrationFile: filePath,
                                registrationLine: call.line,
                            });
                        }
                        break;
                    }
                }
            }
        }
    }

    return result;
}

/**
 * Detect all framework entry points in the project.
 *
 * @param {object} index - ProjectIndex
 * @param {object} [options]
 * @param {string} [options.type] - Filter by type (http, jobs, di, test, runtime)
 * @param {string} [options.framework] - Filter by framework name(s), comma-separated
 * @param {string} [options.file] - Filter by file path pattern
 * @returns {Array<{ name, file, line, type, framework, patternId, evidence, confidence }>}
 */
function detectEntrypoints(index, options = {}) {
    // Validate --type against the pattern registry up front — an unknown
    // value used to fall through to the filter and silently return nothing.
    if (options.type) {
        const validTypes = new Set(FRAMEWORK_PATTERNS.map(p => p.type));
        if (!validTypes.has(options.type)) {
            return {
                error: 'invalid-type',
                message: `Unknown type "${options.type}". Valid: ${[...validTypes].sort().join(', ')}.`,
            };
        }
    }

    // Same discipline for --framework (fix #243) — a typo like 'flsk'
    // silently filtered everything to an empty result.
    if (options.framework) {
        const validFrameworks = new Set(FRAMEWORK_PATTERNS.map(p => p.framework.toLowerCase()));
        const wanted = String(options.framework).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const unknown = wanted.filter(f => !validFrameworks.has(f));
        if (unknown.length > 0) {
            return {
                error: 'invalid-framework',
                message: `Unknown framework "${unknown.join('", "')}". Valid: ${[...validFrameworks].sort().join(', ')}.`,
            };
        }
    }

    // Build callback entrypoint map (call-pattern detection)
    const callbackMap = buildCallbackEntrypointMap(index);

    const results = [];
    const seen = new Set(); // file:line:name dedup key

    // Collect name-based patterns for efficient matching
    const namePatterns = FRAMEWORK_PATTERNS.filter(p => p.detection === 'namePattern');
    const filePathPatterns = FRAMEWORK_PATTERNS.filter(p => p.detection === 'filePath');
    const shebangPatterns = FRAMEWORK_PATTERNS.filter(p => p.detection === 'shebang');

    // 0. Pre-compute per-file pattern matches for filePath and shebang detection.
    //    These mark every symbol in a file as an entry point.
    const fileMatches = new Map(); // absolutePath -> { pattern, evidence }[]
    for (const [filePath, fileEntry] of index.files) {
        const lang = fileEntry.language;
        const relPath = (fileEntry.relativePath || filePath).split(path.sep).join('/');

        // filePath patterns match against the project-relative path
        for (const fp of filePathPatterns) {
            if (!fp.languages.has(lang)) continue;
            if (!fp.pathPattern.test(relPath)) continue;
            if (!fileMatches.has(filePath)) fileMatches.set(filePath, []);
            fileMatches.get(filePath).push({
                pattern: fp,
                evidence: `entry-file: ${relPath}`,
            });
        }

        // shebang patterns: read the first ~128 bytes safely.
        if (shebangPatterns.length > 0) {
            const relevant = shebangPatterns.filter(p => p.languages.has(lang));
            if (relevant.length > 0) {
                let head = '';
                try {
                    const fd = fs.openSync(filePath, 'r');
                    try {
                        const buf = Buffer.alloc(128);
                        const n = fs.readSync(fd, buf, 0, 128, 0);
                        head = buf.slice(0, n).toString('utf8');
                    } finally {
                        fs.closeSync(fd);
                    }
                } catch (_e) { /* unreadable — skip */ }
                if (head) {
                    for (const sp of relevant) {
                        if (sp.shebangPattern.test(head)) {
                            if (!fileMatches.has(filePath)) fileMatches.set(filePath, []);
                            fileMatches.get(filePath).push({
                                pattern: sp,
                                evidence: 'shebang #!node',
                            });
                        }
                    }
                }
            }
        }
    }

    // 1. Scan all symbols for decorator/modifier/name-based patterns
    for (const [name, symbols] of index.symbols) {
        for (const symbol of symbols) {
            const fileEntry = index.files.get(symbol.file);
            if (!fileEntry) continue;

            // Check decorator/modifier-based patterns
            const match = matchDecoratorOrModifier(symbol, fileEntry.language);
            if (match) {
                const key = `${symbol.file}:${symbol.startLine}:${name}`;
                if (seen.has(key)) continue;
                seen.add(key);

                results.push({
                    name,
                    file: symbol.relativePath || symbol.file,
                    absoluteFile: symbol.file,
                    line: symbol.startLine,
                    type: match.pattern.type,
                    framework: match.pattern.framework,
                    patternId: match.pattern.id,
                    evidence: [match.matchedOn],
                    confidence: 0.95,
                });
                continue;
            }

            // Check name-based patterns (main, init, TestXxx, etc.)
            for (const np of namePatterns) {
                if (!np.languages.has(fileEntry.language)) continue;
                // Per-pattern symbol predicate (fix #243) — e.g. main must be
                // a free function (Rust/Go) or a static method (Java)
                if (np.symbolFilter && !np.symbolFilter(symbol)) continue;
                if (np.pattern.test(name)) {
                    const key = `${symbol.file}:${symbol.startLine}:${name}`;
                    if (seen.has(key)) continue;
                    seen.add(key);

                    results.push({
                        name,
                        file: symbol.relativePath || symbol.file,
                        absoluteFile: symbol.file,
                        line: symbol.startLine,
                        type: np.type,
                        framework: np.framework,
                        patternId: np.id,
                        evidence: [`${name}() convention`],
                        confidence: 1.0,
                    });
                    break;
                }
            }
        }
    }

    // 2. Add call-pattern-based entry points (route handlers).
    // Run BEFORE file-level patterns so framework labels (express, gin, etc.) win
    // over generic file-level labels (e.g. server.js / index.js js-cli-main).
    for (const [name, info] of callbackMap) {
        const fileEntry = index.files.get(info.file);
        const relPath = fileEntry?.relativePath || info.file;
        const key = `${info.file}:${info.line}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let evidence = `${info.method} route handler`;
        let registeredAt;
        if (info.registrationFile) {
            const regEntry = index.files.get(info.registrationFile);
            const regRel = regEntry?.relativePath || info.registrationFile;
            registeredAt = { file: regRel, line: info.registrationLine };
            if (info.registrationFile !== info.file || info.registrationLine !== info.line) {
                evidence += ` — registered at ${regRel}:${info.registrationLine}`;
            }
        }

        results.push({
            name,
            file: relPath,
            absoluteFile: info.file,
            line: info.line,
            type: info.type,
            framework: info.framework,
            patternId: info.patternId,
            evidence: [evidence],
            ...(registeredAt && { registeredAt }),
            confidence: 0.90,
        });
    }

    // 3. Add file-level entry points (filePath / shebang).
    //
    // BUG M6: previously this marked EVERY top-level symbol in a matched file
    // as an entry point — way too broad for shebang/CLI files (where only the
    // main entry function is the real runtime entry; helpers are just helpers).
    //
    // Tightened rule for `js-cli-main` and `js-shebang-main` patterns:
    //   Only mark as entry points:
    //     - Function whose name is `main` (case-sensitive — Node CLI idiom)
    //     - The default export of the file (if present)
    //     - Any function targeted by a top-level invocation (e.g. file calls
    //       `main()` at module scope → main is the entry)
    //     - Any function that contains a top-level `if (require.main === module)
    //       { ... }` block (Node CLI idiom)
    //
    // For all other file-level patterns (js-test-file, next-page, python-main-module),
    // continue using the broad behavior of marking every symbol as an entry.
    //
    // These run last so any more-specific framework label registered above wins;
    // here we only catch symbols not already seen. Dedup by (file, name) — not
    // (file, line, name) — so a generic file-level entry doesn't add a duplicate
    // entry alongside a specific framework callback registered at a different line.
    const NARROW_FILE_PATTERNS = new Set(['js-cli-main', 'js-shebang-main']);

    // For each "narrow" matched file, compute the allowed entry symbol names.
    // Falls back to permissive when nothing identifies a specific entry, to avoid
    // hiding the entire file from reachability seeding.
    const narrowAllowedByFile = new Map(); // absoluteFile -> Set<name> | null (null = allow all)
    if (fileMatches.size > 0) {
        for (const [filePath, fmatches] of fileMatches) {
            const isNarrow = fmatches.every(fm => NARROW_FILE_PATTERNS.has(fm.pattern.id));
            if (!isNarrow) continue;

            const fileEntry = index.files.get(filePath);
            if (!fileEntry) continue;

            const allowed = new Set();

            // (1) Function literally named 'main' is conventional for Node CLI idiom.
            if (index.symbols.has('main')) {
                for (const sym of index.symbols.get('main')) {
                    if (sym.file === filePath) allowed.add('main');
                }
            }

            // (2) Default export of the file, if any. Across language exporters
            // we look at several shapes:
            //   - `module.exports = X`         → type 'module.exports', name = X
            //   - `export default X`           → isDefault / kind === 'default'
            //   - Python __all__ single entry  → captured per-language
            const exportDetails = fileEntry.exportDetails || [];
            for (const e of exportDetails) {
                if (!e) continue;
                if (e.isDefault === true || e.kind === 'default' || e.name === 'default' ||
                    e.type === 'module.exports' || e.type === 'export-default') {
                    if (e.localName) allowed.add(e.localName);
                    else if (e.name && e.name !== 'default') allowed.add(e.name);
                }
            }

            // (3) Top-level invocation targets: any non-method call with no
            //     enclosingFunction is module-load-time, so its callee is reachable.
            //     We treat the callee as an entry point (the function being kicked off).
            try {
                const calls = getCachedCalls(index, filePath);
                if (calls && calls.length > 0) {
                    for (const c of calls) {
                        if (c.enclosingFunction != null) continue;
                        if (c.isMethod) continue;
                        // Resolve callee names (handles aliased imports)
                        const names = c.resolvedNames || (c.resolvedName ? [c.resolvedName] : [c.name]);
                        for (const n of names) {
                            if (index.symbols.has(n)) allowed.add(n);
                        }
                    }

                    // (4) Function containing a top-level `if (require.main === module) { ... }`
                    //     wrapping calls — captured by treating any non-method call whose
                    //     enclosingFunction body is at top level. The simplest detection:
                    //     scan calls inside any function whose body contains the require.main
                    //     guard. We approximate via the same `enclosingFunction` data: if a
                    //     function contains top-level invocation-style entries, it's typically
                    //     identified by the (3) check above. Skip explicit (4) detection here —
                    //     (3) already covers `if (require.main === module) { main(); }`.
                }
            } catch (_e) { /* best-effort */ }

            // If we identified at least one specific entry, use that set.
            // Otherwise fall back to permissive (null) so a CLI file with neither
            // `main()` nor a clear default-export is still seeded somehow.
            narrowAllowedByFile.set(filePath, allowed.size > 0 ? allowed : null);
        }
    }

    if (fileMatches.size > 0) {
        const seenByFileName = new Set();
        for (const r of results) {
            seenByFileName.add(`${r.absoluteFile}:${r.name}`);
        }
        for (const [name, symbols] of index.symbols) {
            for (const symbol of symbols) {
                const fmatches = fileMatches.get(symbol.file);
                if (!fmatches || fmatches.length === 0) continue;

                // Apply narrow filter: for shebang/cli-main files, only allow
                // identified entry symbols.
                if (narrowAllowedByFile.has(symbol.file)) {
                    const allowed = narrowAllowedByFile.get(symbol.file);
                    if (allowed && !allowed.has(name)) continue;
                }

                const fileNameKey = `${symbol.file}:${name}`;
                if (seenByFileName.has(fileNameKey)) continue;
                const key = `${symbol.file}:${symbol.startLine}:${name}`;
                if (seen.has(key)) continue;
                seen.add(key);
                seenByFileName.add(fileNameKey);
                const first = fmatches[0];
                results.push({
                    name,
                    file: symbol.relativePath || symbol.file,
                    absoluteFile: symbol.file,
                    line: symbol.startLine,
                    type: first.pattern.type,
                    framework: first.pattern.framework,
                    patternId: first.pattern.id,
                    evidence: [first.evidence],
                    confidence: 0.85,
                });
            }
        }
    }

    // Apply filters
    let filtered = results;

    if (options.type) {
        filtered = filtered.filter(e => e.type === options.type);
    }

    if (options.framework) {
        const frameworks = new Set(options.framework.split(',').map(s => s.trim().toLowerCase()));
        filtered = filtered.filter(e => frameworks.has(e.framework.toLowerCase()));
    }

    if (options.file) {
        filtered = filtered.filter(e => e.file.includes(options.file));
    }

    if (options.exclude) {
        const raw = Array.isArray(options.exclude) ? options.exclude : options.exclude.split(',');
        const patterns = raw.map(s => s.trim()).filter(Boolean);
        if (patterns.length > 0) {
            const regexes = patterns.map(p => new RegExp(`(^|[/._-])${p}s?([/._-]|$)`, 'i'));
            filtered = filtered.filter(e => !regexes.some(r => r.test(e.file)));
        }
    }

    // Sort by file, then line
    filtered.sort((a, b) => {
        if (a.file !== b.file) return codeUnitCompare(a.file, b.file);
        return a.line - b.line;
    });

    return filtered;
}

// ============================================================================
// REACHABILITY
// ============================================================================

/**
 * Build a stable key for a symbol-like object based on its file path and start line.
 * Two functions cannot start at the same line in the same file, so this is unique.
 *
 * @param {string} file - Absolute file path
 * @param {number} line - Start line of the symbol
 * @returns {string} Symbol key (e.g. "/abs/path/file.js:42")
 */
function symbolKey(file, line) {
    return `${file}:${line}`;
}

/**
 * Compute the set of symbols transitively reachable from any detected entry point.
 *
 * Performs BFS through the call graph starting from every entry point (framework
 * handlers, main/init, test functions, etc.) and following findCallees recursively.
 *
 * Result is cached on the index instance as `index._reachableSymbols` to avoid
 * recomputation. Subsequent calls return the cached Set.
 *
 * @param {object} index - ProjectIndex instance
 * @returns {Set<string>} Set of symbol keys (file:startLine) reachable from entry points
 */
function computeReachability(index) {
    // PERF-1: when _reachableSymbols was loaded from the disk cache, verify
    // the index hasn't drifted (e.g. because the cache was stale and a partial
    // rebuild ran after load). If the fingerprint doesn't match, drop the
    // cached set and recompute.
    if (index._reachableSymbols) {
        if (index._reachableFingerprint) {
            const { _computeReachabilityFingerprint } = require('./cache');
            const currentFingerprint = _computeReachabilityFingerprint(index);
            if (currentFingerprint === index._reachableFingerprint) {
                return index._reachableSymbols;
            }
            // Drift: drop stale set, recompute below.
            index._reachableSymbols = null;
            index._reachableFingerprint = null;
        } else {
            // Computed in-process this run (no fingerprint) — already trustworthy.
            return index._reachableSymbols;
        }
    }

    const reachable = new Set();
    const entryPoints = detectEntrypoints(index);

    // Seed BFS queue from every entry point's matching symbol(s) in the symbol table.
    // detectEntrypoints returns entry-point hits with absoluteFile + line + name; we resolve
    // each to a real symbol object by matching name and (absoluteFile, line).
    const queue = [];
    for (const ep of entryPoints) {
        const symbols = index.symbols.get(ep.name);
        if (!symbols) continue;
        // Match by absoluteFile + line (entry-point line should match symbol startLine).
        // Fall back to file-only match if line shifted (e.g. file edited after detection).
        const match = symbols.find(s =>
            s.file === ep.absoluteFile && s.startLine === ep.line
        ) || symbols.find(s => s.file === ep.absoluteFile);
        if (match) {
            const key = symbolKey(match.file, match.startLine);
            if (!reachable.has(key)) {
                reachable.add(key);
                queue.push(match);
            }
        }
    }

    // BUG-BE root cause 1: also seed from per-language getEntryPointKind() predicates.
    // detectEntrypoints() above only knows about FRAMEWORK_PATTERNS; it does not consult
    // each language module's getEntryPointKind() (which classifies React lifecycle methods,
    // @Test annotations, Rust #[cfg(test)] modules, Go Test*/main, etc.). Without this
    // pass those entries are never seeded, so anything reachable only via them is reported
    // as unreachable. The reachable Set already dedupes against the framework-pattern pass.
    const langModuleCache = new Map();
    for (const [, symbols] of index.symbols) {
        for (const symbol of symbols) {
            const fileEntry = index.files.get(symbol.file);
            if (!fileEntry) continue;
            const lang = fileEntry.language;
            let langModule;
            if (langModuleCache.has(lang)) {
                langModule = langModuleCache.get(lang);
            } else {
                try {
                    langModule = getLanguageModule(lang);
                } catch (_e) {
                    langModule = null;
                }
                langModuleCache.set(lang, langModule);
            }
            if (!langModule || !langModule.getEntryPointKind) continue;
            let kind;
            try {
                kind = langModule.getEntryPointKind(symbol);
            } catch (_e) {
                continue;
            }
            if (kind == null) continue;
            const key = symbolKey(symbol.file, symbol.startLine);
            if (!reachable.has(key)) {
                reachable.add(key);
                queue.push(symbol);
            }
        }
    }

    // BUG-BE root cause 3: top-level executable code in JS/TS files is a reachability
    // source. A call expression at module scope (no enclosing function) is invoked
    // when the module is loaded; treat its callee as reachable. Walk getCachedCalls
    // (already AST-derived) and seed callees of enclosingFunction === null calls
    // for files in JS/TS-language. Resolution mirrors findCallees: name lookup +
    // disambiguation by import bindings is not necessary here — we just need to seed
    // the callee symbol(s); the BFS below propagates further reachability.
    for (const [filePath, fileEntry] of index.files) {
        const lang = fileEntry.language;
        if (lang !== 'javascript' && lang !== 'typescript' && lang !== 'tsx') continue;
        let calls;
        try {
            calls = getCachedCalls(index, filePath);
        } catch (_e) {
            continue;
        }
        if (!calls || calls.length === 0) continue;
        for (const call of calls) {
            // Top-level call: AST recorded enclosingFunction === null/undefined.
            if (call.enclosingFunction != null) continue;
            // Method calls at top-level (e.g. a.b()) are typically library calls;
            // we keep the simple identifier case where the callee name is a project symbol.
            if (call.isMethod) continue;
            // Resolve possible callee names — supports aliased imports.
            const names = call.resolvedNames || (call.resolvedName ? [call.resolvedName] : [call.name]);
            for (const cname of names) {
                const symbols = index.symbols.get(cname);
                if (!symbols) continue;
                for (const sym of symbols) {
                    const key = symbolKey(sym.file, sym.startLine);
                    if (!reachable.has(key)) {
                        reachable.add(key);
                        queue.push(sym);
                    }
                }
            }
        }
    }

    // BFS: walk callees of every reachable symbol.
    // findCallees returns full symbol objects for every callee with file/startLine.
    while (queue.length > 0) {
        const sym = queue.shift();
        if (!sym.file || sym.startLine == null) continue;

        let callees;
        try {
            callees = index.findCallees(sym, { includeMethods: true });
        } catch (_e) {
            continue;
        }
        if (!callees || callees.length === 0) continue;

        for (const c of callees) {
            if (!c.file || c.startLine == null) continue;
            const key = symbolKey(c.file, c.startLine);
            if (!reachable.has(key)) {
                reachable.add(key);
                queue.push(c);
            }
        }
    }

    index._reachableSymbols = reachable;
    // Clear any stale fingerprint — this set was computed in-process and is
    // authoritative for the rest of the process lifetime. (saveCache will
    // re-fingerprint when persisting.)
    index._reachableFingerprint = null;
    // MED-1 (Round 5): mark the set dirty so the surface knows to persist it.
    // Without this flag, a cache-hit run that triggers reachability (about,
    // context, deadcode, etc.) would compute the BFS in-memory but not save
    // it, forcing every subsequent cold invocation to repeat the 7-11s tax.
    // Cleared in saveCache after a successful write.
    index.reachabilityDirty = true;
    return reachable;
}

/**
 * Check if a symbol (identified by file + startLine) is reachable from any entry point.
 * Lazily computes the reachable set on first call.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} symbolKeyStr - Key of form "file:startLine"
 * @returns {boolean}
 */
function isReachable(index, symbolKeyStr) {
    const reachable = computeReachability(index);
    return reachable.has(symbolKeyStr);
}

/**
 * Check if a specific symbol is a framework entry point.
 * Used by deadcode to exclude framework-registered functions.
 *
 * @param {object} symbol - Symbol from the symbol table
 * @param {object} index - ProjectIndex
 * @returns {boolean}
 */
function isFrameworkEntrypoint(symbol, index) {
    const fileEntry = index.files.get(symbol.file);
    if (!fileEntry) return false;

    // Fast path: check decorator/modifier patterns (no index scan needed)
    if (matchDecoratorOrModifier(symbol, fileEntry.language)) {
        return true;
    }

    // Slow path: check call-pattern patterns (needs callback map)
    // Build and cache on first use
    if (!index._callbackEntrypointMap) {
        index._callbackEntrypointMap = buildCallbackEntrypointMap(index);
    }

    return index._callbackEntrypointMap.has(symbol.name);
}

module.exports = {
    FRAMEWORK_PATTERNS,
    detectEntrypoints,
    isFrameworkEntrypoint,
    matchDecoratorOrModifier,
    buildCallbackEntrypointMap,
    computeReachability,
    isReachable,
    symbolKey,
};
