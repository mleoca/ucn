'use strict';

const { createFileIR, validateFileIR } = require('../core/ir');

const REQUIRED_ADAPTER_OPERATIONS = Object.freeze([
    'parse',
    'findCallsInCode',
    'findImportsInCode',
    'findExportsInCode',
    'findUsagesInCode',
    'isEntryPoint',
    'getEntryPointKind',
]);

const OPTIONAL_HELPERS = Object.freeze([
    'findFunctions',
    'findClasses',
    'findStateObjects',
    'findMacros',
    'findCallbackUsages',
    'findInstanceAttributeTypes',
    'findReExports',
    'extractScriptBlocks',
    'buildVirtualJSContent',
    'extractEventHandlerCalls',
    'findTestCallRanges',
    'getBuiltinCallReturnType',
    'getBuiltinFieldType',
    'isPlatformConcreteCall',
    'isPlatformConcreteType',
]);

function adapterCapabilities(languageModule) {
    return Object.freeze({
        symbols: typeof languageModule.parse === 'function',
        calls: typeof languageModule.findCallsInCode === 'function',
        imports: typeof languageModule.findImportsInCode === 'function',
        exports: typeof languageModule.findExportsInCode === 'function',
        usages: typeof languageModule.findUsagesInCode === 'function',
        callbacks: typeof languageModule.findCallbackUsages === 'function',
        reExports: typeof languageModule.findReExports === 'function',
        entrypoints: typeof languageModule.getEntryPointKind === 'function',
        semanticProvider: false,
    });
}

/**
 * Wrap one parser implementation in the v5 language-adapter contract.
 * Generic code receives normalized methods and capabilities. Optional
 * grammar-specific helpers are explicitly named on the adapter; the raw
 * parser module is never exposed.
 */
function createLanguageAdapter(config) {
    if (!config || !config.name) throw new Error('Language adapter name is required');
    if (typeof config.module !== 'function') {
        throw new Error(`${config.name}: language module factory is required`);
    }
    const languageModule = config.module();
    const capabilities = adapterCapabilities(languageModule);
    const adapter = {
        id: config.name,
        extensions: Object.freeze([...(config.extensions || [])]),
        grammar: config.treeSitterLang || config.name,
        traits: Object.freeze({ ...(config.traits || {}) }),
        capabilities,
        managesOwnParseTree: !!languageModule.managesOwnParseTree,
        loadGrammar: config.treeSitterModule,
        parse(code, parser) {
            return languageModule.parse(code, parser);
        },
        findCalls(code, parser) {
            return languageModule.findCallsInCode(code, parser);
        },
        findImports(code, parser) {
            return languageModule.findImportsInCode(code, parser);
        },
        findExports(code, parser) {
            return languageModule.findExportsInCode(code, parser);
        },
        findUsages(code, name, parser, tree) {
            return languageModule.findUsagesInCode(code, name, parser, tree);
        },
        getEntryPointKind(symbol) {
            return languageModule.getEntryPointKind(symbol);
        },
        isEntryPoint(symbol) {
            return languageModule.isEntryPoint(symbol);
        },
        analyze(code, parser, file = null) {
            // Full-file indexing consumes immutable records, not native ASTs.
            // Parsers with a heavier internal recovery cache (notably C/C++)
            // may release analysis-only trees as soon as those records have
            // been extracted. Direct parser/query calls omit this option and
            // retain their bounded cross-operation cache.
            const parsed = languageModule.parse(code, parser, {
                releaseAnalysisTree: true,
            });
            const parseProvidesFacts = !!languageModule.parseProvidesAnalysisFacts;
            const imports = parseProvidesFacts
                ? (parsed.imports || [])
                : languageModule.findImportsInCode(code, parser);
            const exports = parseProvidesFacts
                ? (parsed.exports || [])
                : languageModule.findExportsInCode(code, parser);
            if (!parseProvidesFacts) {
                parsed.imports = imports;
                parsed.exports = exports;
            }
            const callOptions = {};
            if (config.traits?.hasReceiverPackageCalls) {
                callOptions.imports = imports.flatMap(item => item.names || []);
            }
            const calls = parseProvidesFacts && Array.isArray(parsed.calls)
                ? parsed.calls
                : languageModule.findCallsInCode(code, parser, callOptions);
            return createFileIR({
                language: config.name,
                file,
                parsed,
                calls,
                capabilities,
            });
        },
    };

    // AST implementation aliases retained inside the adapter contract so
    // focused parser tests and HTML delegation exercise the same object as
    // production. These are not a second module surface.
    adapter.findCallsInCode = adapter.findCalls;
    adapter.findImportsInCode = adapter.findImports;
    adapter.findExportsInCode = adapter.findExports;
    adapter.findUsagesInCode = adapter.findUsages;
    for (const helper of OPTIONAL_HELPERS) {
        if (typeof languageModule[helper] === 'function') {
            adapter[helper] = languageModule[helper].bind(languageModule);
        }
    }
    return Object.freeze(adapter);
}

/**
 * Skeleton adapter used by conformance tests and new-language scaffolding.
 * It proves a language can join the registry with navigation-safe empty
 * results before grammar-specific extraction is implemented. It is never
 * advertised as a supported language.
 */
function createNoopLanguageAdapter({
    id = 'noop',
    extensions = ['.noop'],
    traits = {},
} = {}) {
    const emptyParse = code => ({
        language: id,
        totalLines: code ? code.split('\n').length : 0,
        functions: [],
        classes: [],
        stateObjects: [],
        imports: [],
        exports: [],
    });
    const languageModule = {
        parse: emptyParse,
        findCallsInCode: () => [],
        findImportsInCode: () => [],
        findExportsInCode: () => [],
        findUsagesInCode: () => [],
        isEntryPoint: () => false,
        getEntryPointKind: () => null,
    };
    return createLanguageAdapter({
        name: id,
        extensions,
        treeSitterLang: id,
        module: () => languageModule,
        treeSitterModule: () => null,
        traits,
    });
}

function validateLanguageAdapter(adapter, { analyzeSample = false } = {}) {
    const failures = [];
    if (!adapter || typeof adapter !== 'object') return ['adapter must be an object'];
    if (!adapter.id) failures.push('id is required');
    if (!Array.isArray(adapter.extensions) || adapter.extensions.length === 0) {
        failures.push(`${adapter.id || 'adapter'}: at least one extension is required`);
    }
    for (const method of ['parse', 'findCalls', 'findImports', 'findExports',
        'findUsages', 'getEntryPointKind', 'isEntryPoint', 'analyze']) {
        if (typeof adapter[method] !== 'function') {
            failures.push(`${adapter.id || 'adapter'}: missing ${method}()`);
        }
    }
    for (const method of REQUIRED_ADAPTER_OPERATIONS) {
        if (typeof adapter[method] !== 'function') {
            failures.push(`${adapter.id || 'adapter'}: missing parser operation ${method}()`);
        }
    }
    if (!adapter.capabilities || typeof adapter.capabilities !== 'object') {
        failures.push(`${adapter.id || 'adapter'}: capabilities are required`);
    }
    if (analyzeSample && failures.length === 0) {
        try {
            const ir = adapter.analyze('', null, 'empty' + adapter.extensions[0]);
            failures.push(...validateFileIR(ir).map(failure => `${adapter.id}: ${failure}`));
        } catch (error) {
            failures.push(`${adapter.id}: sample analysis failed: ${error.message}`);
        }
    }
    return failures;
}

module.exports = {
    REQUIRED_ADAPTER_OPERATIONS,
    OPTIONAL_HELPERS,
    createLanguageAdapter,
    createNoopLanguageAdapter,
    validateLanguageAdapter,
};
