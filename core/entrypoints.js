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

const { getCachedCalls } = require('./callers');

// ============================================================================
// FRAMEWORK PATTERNS
// ============================================================================

const JS_LANGS = new Set(['javascript', 'typescript', 'tsx']);

const FRAMEWORK_PATTERNS = [
    // ── HTTP Routes ─────────────────────────────────────────────────────

    // Express / Fastify / Koa (JS/TS) — call-pattern: app.get('/path', handler)
    {
        id: 'express-route',
        languages: JS_LANGS,
        type: 'http',
        framework: 'express',
        detection: 'callPattern',
        receiverPattern: /^(app|router|server|fastify)$/i,
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

    // Actix (Rust) — modifiers from #[get("/path")], #[post("/path")]
    {
        id: 'actix-route',
        languages: new Set(['rust']),
        type: 'http',
        framework: 'actix',
        detection: 'modifier',
        pattern: /^(get|post|put|delete|patch|actix_web::main|actix_web::test)$/,
    },

    // ── Dependency Injection ────────────────────────────────────────────

    // Spring DI (Java)
    {
        id: 'spring-di',
        languages: new Set(['java']),
        type: 'di',
        framework: 'spring',
        detection: 'modifier',
        pattern: /^(bean|component|service|controller|repository|configuration|restcontroller)$/,
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

    // Go main function (program entry)
    {
        id: 'go-main',
        languages: new Set(['go']),
        type: 'runtime',
        framework: 'go',
        detection: 'namePattern',
        pattern: /^main$/,
    },

    // Go init functions (package initialization, called by runtime)
    {
        id: 'go-init',
        languages: new Set(['go']),
        type: 'runtime',
        framework: 'go',
        detection: 'namePattern',
        pattern: /^init$/,
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
 * @param {object} index - ProjectIndex
 * @returns {Map<string, { framework, type, patternId, method, file, line }>}
 */
function buildCallbackEntrypointMap(index) {
    const callPatterns = FRAMEWORK_PATTERNS.filter(p => p.detection === 'callPattern');
    const compositePatterns = FRAMEWORK_PATTERNS.filter(p => p.detection === 'compositePattern');
    if (callPatterns.length === 0 && compositePatterns.length === 0) return new Map();

    const result = new Map(); // name -> info

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

                    if (!result.has(call.name)) {
                        result.set(call.name, {
                            framework: route.pattern.framework,
                            type: route.pattern.type,
                            patternId: route.pattern.id,
                            method: route.call.name.toUpperCase(),
                            file: filePath,
                            line: call.line,
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
                            result.set(call.name, {
                                framework: pattern.framework,
                                type: pattern.type,
                                patternId: pattern.id,
                                method: call.fieldName,
                                file: filePath,
                                line: call.line,
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
    // Build callback entrypoint map (call-pattern detection)
    const callbackMap = buildCallbackEntrypointMap(index);

    const results = [];
    const seen = new Set(); // file:line:name dedup key

    // Collect name-based patterns for efficient matching
    const namePatterns = FRAMEWORK_PATTERNS.filter(p => p.detection === 'namePattern');

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

    // 2. Add call-pattern-based entry points (route handlers)
    for (const [name, info] of callbackMap) {
        const fileEntry = index.files.get(info.file);
        const relPath = fileEntry?.relativePath || info.file;
        const key = `${info.file}:${info.line}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
            name,
            file: relPath,
            absoluteFile: info.file,
            line: info.line,
            type: info.type,
            framework: info.framework,
            patternId: info.patternId,
            evidence: [`${info.method} route handler`],
            confidence: 0.90,
        });
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
        if (a.file !== b.file) return a.file.localeCompare(b.file);
        return a.line - b.line;
    });

    return filtered;
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
};
