/**
 * languages/index.js - Language registry and detection
 *
 * Manages language parsers and provides extension-based detection.
 */

const path = require('path');

// Lazy-loaded tree-sitter
let TreeSitter = null;

// Cached parser instances
const parsers = {};

// Shared trait presets for languages with the same type-system characteristics
const STRUCTURAL_TRAITS = {
    typeSystem: 'structural',
    methodCallInclusion: 'explicit',
    packageScope: 'file',
    hasReceiverPackageCalls: false,
    exportVisibility: 'keyword',
    hasDynamicImports: true,
    testDirs: [],
    allMethodsVirtual: false,
    hasArityOverloads: false,
    // Whether `from pkg import name` can bind a SUBMODULE file as a plain
    // name (fix #224). Python sets true: graph-build resolves the composed
    // dotted specifier and records it in moduleResolved, making the receiver
    // a module receiver at query time. JS from-imports bind values only.
    submoduleImports: false,
    // Class members are public unless marked otherwise (#name, _name,
    // `private`). An exported class therefore exposes its non-private methods
    // as public API — deadcode treats them as exported (fix #211). Languages
    // with explicit member visibility (Rust `pub`, Java `public` — already
    // captured as modifiers) or capitalization rules (Go) set false: there
    // the member's own marker decides.
    implicitlyPublicMembers: true,
    // A bare (receiver-less) name can never denote a METHOD here — JS/Python
    // methods are reached through their receiver; only a rebound alias could,
    // which is separate name-level evidence. Java sets true: `execute()`
    // inside a class means this.execute(), and static imports bind foreign
    // class methods to bare names (fix #220).
    bareCallReachesMethods: false,
    // A method-shaped call CAN reach a standalone function here: attribute
    // assignment rebinds functions onto objects (obj.print = print), so the
    // #218b gate routes such calls visible instead of excluding (fix #220).
    methodCallReachesFunctions: true,
};
const NOMINAL_TRAITS = {
    typeSystem: 'nominal',
    methodCallInclusion: 'auto',
    packageScope: 'file',
    hasReceiverPackageCalls: false,
    exportVisibility: 'keyword',
    hasDynamicImports: true,
    testDirs: [],
    // Whether ANY instance method call can dynamically dispatch to a subtype
    // override (Java: all instance methods are virtual). Go struct method
    // sets and Rust inherent methods bind statically — only interface/trait
    // receivers dispatch there, which is detected per-type, not per-language.
    allMethodsVirtual: false,
    // Whether one class can define several same-name methods differing only
    // in parameters (Java overloading). Drives the overload discipline in
    // the caller contract: a pinned overload is only confirmed when the call
    // site provably binds it.
    hasArityOverloads: false,
    // What a TYPE-QUALIFIED method call looks like, so a receiver that merely
    // shares the target type's NAME isn't mistaken for the type itself:
    //   'static'      — Type.method() static form, any arity (Java).
    //   'method-expr' — Go method expressions T.M(recv, ...): the receiver
    //                   instance is the FIRST argument, so a zero-arg call on
    //                   a type-named receiver must be a variable (grpc-go
    //                   names builder structs and Builder locals both `bb`).
    //   'path'        — Rust Type::method (isPathCall); a DOT-call receiver
    //                   matching a type name is a variable, never the type.
    typeQualifiedCallStyle: 'static',
    implicitlyPublicMembers: false,
    // The implicit root supertype every class extends without declaring it
    // (Java `Object`). A receiver declared with this type can hold ANY project
    // instance, so it is dispatch-capable toward every override — but the
    // edge is invisible to declared-ancestry walks (fix #212). Routing only,
    // never exclusion evidence. Go/Rust: null — Go's interface{}/any cannot
    // receive method calls without an assertion, Rust has no universal
    // supertype. Structural languages: null — any/object/unknown receivers
    // are already refused as exclusion evidence by the trust gate.
    universalSupertype: null,
    // A bare (receiver-less) call or reference can never denote a METHOD:
    // Go method values/expressions require an explicit receiver or type
    // qualifier (m.Helper(), T.Helper); Rust requires self./Type:: and `use`
    // cannot import associated functions. A bare MarkFlagDirname(...) inside
    // Command.MarkFlagDirname denotes the package FUNCTION (fix #220,
    // cobra/grpc-go-measured). Java overrides true (implicit this-calls,
    // static imports).
    bareCallReachesMethods: false,
    // Whether a method-shaped call (x.f()) can reach a standalone FUNCTION:
    // Go func-typed fields are name-callable (s.Run() may invoke a stored
    // function), so exclusion needs !bindingId there; Rust requires (s.f)()
    // parens and Java requires .apply() — a dot-call provably never binds a
    // free function (fix #220, ripgrep-measured).
    methodCallReachesFunctions: false,
    // Whether a paren-less member access (x.name) can denote a METHOD. Rust
    // sets true for the inverse — `x.name` is ALWAYS a field there (method
    // values are path-only: Type::method), so a member-access reference
    // against a method target is excluded (fix #220, ripgrep-measured:
    // `self.paths.has_implicit_path` is the bool FIELD, not the method).
    // Go method values (obj.Method) and Java `::` references DO denote
    // methods — false. Per-language override, not preset-wide.
    memberAccessNeverMethod: false,
};

// Language configurations
const LANGUAGES = {
    javascript: {
        name: 'javascript',
        extensions: ['.js', '.jsx', '.mjs', '.cjs'],
        treeSitterLang: 'javascript',
        module: () => require('./javascript'),
        treeSitterModule: () => require('tree-sitter-javascript'),
        traits: {
            ...STRUCTURAL_TRAITS,
            selfParam: ['this'],
            testFileCandidates: (base, ext) => [`${base}.test${ext}`, `${base}.spec${ext}`, `${base}.test.ts`, `${base}.test.js`, `${base}.spec.ts`, `${base}.spec.js`],
            testDirs: ['__tests__'],
        },
    },
    typescript: {
        name: 'typescript',
        extensions: ['.ts'],
        treeSitterLang: 'typescript',
        module: () => require('./javascript'),  // Same module, different parser
        treeSitterModule: () => require('tree-sitter-typescript').typescript,
        traits: {
            ...STRUCTURAL_TRAITS,
            selfParam: ['this'],
            testFileCandidates: (base, ext) => [`${base}.test${ext}`, `${base}.spec${ext}`, `${base}.test.ts`, `${base}.test.js`, `${base}.spec.ts`, `${base}.spec.js`],
            testDirs: ['__tests__'],
        },
    },
    tsx: {
        name: 'tsx',
        extensions: ['.tsx'],
        treeSitterLang: 'tsx',
        module: () => require('./javascript'),
        treeSitterModule: () => require('tree-sitter-typescript').tsx,
        traits: {
            ...STRUCTURAL_TRAITS,
            selfParam: ['this'],
            testFileCandidates: (base, ext) => [`${base}.test${ext}`, `${base}.spec${ext}`, `${base}.test.ts`, `${base}.test.js`, `${base}.spec.ts`, `${base}.spec.js`],
            testDirs: ['__tests__'],
        },
    },
    python: {
        name: 'python',
        extensions: ['.py', '.pyi'],
        treeSitterLang: 'python',
        module: () => require('./python'),
        treeSitterModule: () => require('tree-sitter-python'),
        traits: {
            ...STRUCTURAL_TRAITS,
            selfParam: ['self', 'cls'],
            // fix #224: `from pkg import name` may bind a SUBMODULE file, not
            // a symbol — graph-build resolves the composed dotted specifier
            // and query code treats such receivers as module receivers. JS
            // from-imports bind values only (`import * as ns` is parser-marked).
            submoduleImports: true,
            testFileCandidates: (base, ext) => [`test_${base}.py`, `${base}_test.py`],
            testDirs: ['tests'],
        },
    },
    go: {
        name: 'go',
        extensions: ['.go'],
        treeSitterLang: 'go',
        module: () => require('./go'),
        treeSitterModule: () => require('tree-sitter-go'),
        traits: {
            ...NOMINAL_TRAITS,
            selfParam: null,
            packageScope: 'directory',
            hasReceiverPackageCalls: true,
            exportVisibility: 'capitalization',
            hasDynamicImports: false,
            typeQualifiedCallStyle: 'method-expr',
            methodCallReachesFunctions: true,
            testFileCandidates: (base, ext) => [`${base}_test.go`],
        },
    },
    rust: {
        name: 'rust',
        extensions: ['.rs'],
        treeSitterLang: 'rust',
        module: () => require('./rust'),
        treeSitterModule: () => require('tree-sitter-rust'),
        traits: {
            ...NOMINAL_TRAITS,
            selfParam: ['self', '&self', '&mut self', 'mut self'],
            hasDynamicImports: false,
            typeQualifiedCallStyle: 'path',
            memberAccessNeverMethod: true,
            testFileCandidates: (base, ext) => [`${base}_test.rs`],
            testDirs: ['tests'],
        },
    },
    java: {
        name: 'java',
        extensions: ['.java'],
        treeSitterLang: 'java',
        module: () => require('./java'),
        treeSitterModule: () => require('tree-sitter-java'),
        traits: {
            ...NOMINAL_TRAITS,
            selfParam: ['this'],
            allMethodsVirtual: true,
            hasArityOverloads: true,
            universalSupertype: 'Object',
            bareCallReachesMethods: true,
            testFileCandidates: (base, ext) => [`${base}Test.java`, `${base}Tests.java`, `${base}TestCase.java`],
        },
    },
    html: {
        name: 'html',
        extensions: ['.html', '.htm'],
        treeSitterLang: 'html',
        module: () => require('./html'),
        treeSitterModule: () => require('tree-sitter-html'),
        traits: {
            ...STRUCTURAL_TRAITS,
            selfParam: ['this'],
            testFileCandidates: (base, ext) => [`${base}.test${ext}`, `${base}.spec${ext}`],
        },
    }
};

// Extension to language mapping
const EXT_MAP = {};
for (const [langName, config] of Object.entries(LANGUAGES)) {
    for (const ext of config.extensions) {
        EXT_MAP[ext] = langName;
    }
}

/**
 * Load tree-sitter module (lazy)
 * @returns {object} TreeSitter class
 */
function loadTreeSitter() {
    if (!TreeSitter) {
        try {
            TreeSitter = require('tree-sitter');
        } catch (e) {
            throw new Error(
                'tree-sitter is required but not installed.\n' +
                'Install with: npm install',
                { cause: e }
            );
        }
    }
    return TreeSitter;
}

/**
 * Get or create parser for a language
 * @param {string} language - Language name
 * @returns {object} Tree-sitter parser instance
 */
function getParser(language) {
    if (parsers[language]) return parsers[language];

    const TS = loadTreeSitter();
    const parser = new TS();
    const config = LANGUAGES[language];

    if (!config) {
        throw new Error(`Unsupported language: ${language}`);
    }

    try {
        const lang = config.treeSitterModule();
        parser.setLanguage(lang);
    } catch (e) {
        throw new Error(
            `Failed to load tree-sitter grammar for ${language}.\n` +
            `Install with: npm install tree-sitter-${language}\n` +
            `Original error: ${e.message}`,
            { cause: e }
        );
    }

    parsers[language] = parser;
    return parser;
}

/**
 * Detect language from file path
 * @param {string} filePath - File path
 * @returns {string|null} Language name or null if unsupported
 */
function detectLanguage(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return EXT_MAP[ext] || null;
}

/**
 * Get language module for a language
 * @param {string} language - Language name
 * @returns {object} Language module with parse functions
 */
function getLanguageModule(language) {
    const config = LANGUAGES[language];
    if (!config) {
        throw new Error(`Unsupported language: ${language}`);
    }
    return config.module();
}

/**
 * Check if a language is supported
 * @param {string} language - Language name
 * @returns {boolean}
 */
function isSupported(language) {
    return language in LANGUAGES;
}

/**
 * Get all supported extensions
 * @returns {string[]}
 */
function getSupportedExtensions() {
    return Object.keys(EXT_MAP);
}

/**
 * Get all supported languages
 * @returns {string[]}
 */
function getSupportedLanguages() {
    return Object.keys(LANGUAGES);
}

// Buffer size for tree-sitter parser (workaround for default 32KB limit)
// Default 1MB handles most files; can be overridden via UCN_BUFFER_SIZE env var
const DEFAULT_BUFFER_SIZE = 1024 * 1024; // 1MB
const MAX_BUFFER_SIZE = 64 * 1024 * 1024; // 64MB cap

const PARSE_OPTIONS = {
    bufferSize: parseInt(process.env.UCN_BUFFER_SIZE, 10) || DEFAULT_BUFFER_SIZE
};

/**
 * Get parse options with dynamic buffer sizing based on content size
 * @param {number} contentLength - Length of content to parse
 * @returns {object} Parse options with appropriate buffer size
 */
function getParseOptions(contentLength = 0) {
    // Start with configured/default size, scale up for large files
    // Buffer needs room for syntax tree which can be 2-3x content size
    const minBuffer = parseInt(process.env.UCN_BUFFER_SIZE, 10) || DEFAULT_BUFFER_SIZE;
    const scaledBuffer = Math.max(minBuffer, contentLength * 3);
    const bufferSize = Math.min(scaledBuffer, MAX_BUFFER_SIZE);
    return { bufferSize };
}

/**
 * Safely parse content with automatic buffer retry on failure
 * @param {object} parser - tree-sitter parser instance
 * @param {string} content - Source code to parse
 * @param {object} oldTree - Previous tree for incremental parsing (optional)
 * @param {object} options - Additional parse options
 * @returns {object} Parsed tree
 */
// Single-entry parse cache: during indexFile(), the same (parser, content) is parsed
// 5 times (findFunctions + findClasses + findStateObjects + findImports + findExports).
// Caching the last result eliminates 4 out of 5 parses per file (80% reduction).
let _lastParseParser = null;
let _lastParseContent = null;
let _lastParseTree = null;

function safeParse(parser, content, oldTree = undefined, options = {}) {
    // Fast path: return cached tree if same parser and content (no oldTree override)
    if (!oldTree && parser === _lastParseParser && content === _lastParseContent && _lastParseTree) {
        return _lastParseTree;
    }

    const contentLength = content.length;

    // Try with escalating buffer sizes
    const bufferSizes = [
        parseInt(process.env.UCN_BUFFER_SIZE, 10) || DEFAULT_BUFFER_SIZE,
        Math.max(DEFAULT_BUFFER_SIZE, contentLength * 2),
        Math.max(4 * 1024 * 1024, contentLength * 3),
        Math.max(16 * 1024 * 1024, contentLength * 4),
        MAX_BUFFER_SIZE
    ].filter((size, i, arr) => i === 0 || size > arr[i - 1]); // Remove duplicates

    let lastError;
    for (const bufferSize of bufferSizes) {
        try {
            const tree = parser.parse(content, oldTree, { ...options, bufferSize });
            // Cache the result for same-(parser, content) reuse
            if (!oldTree) {
                _lastParseParser = parser;
                _lastParseContent = content;
                _lastParseTree = tree;
            }
            return tree;
        } catch (e) {
            lastError = e;
            // Only retry on buffer-related errors
            // tree-sitter throws "Invalid argument" when buffer is too small
            const msg = e.message?.toLowerCase() || '';
            if (!msg.includes('buffer') &&
                !msg.includes('memory') &&
                !msg.includes('alloc') &&
                !msg.includes('invalid argument')) {
                throw e; // Non-buffer error, don't retry
            }
            // Continue to next buffer size
        }
    }

    // All attempts failed
    throw lastError;
}

/**
 * Get trait object for a language.
 * @param {string} language - Language name (e.g. 'go', 'python')
 * @returns {object|undefined} Trait object or undefined if unknown language
 */
function langTraits(language) {
    return LANGUAGES[language]?.traits;
}

module.exports = {
    detectLanguage,
    getParser,
    getLanguageModule,
    isSupported,
    getSupportedExtensions,
    getSupportedLanguages,
    LANGUAGES,
    PARSE_OPTIONS,
    getParseOptions,
    safeParse,
    langTraits,
    DEFAULT_BUFFER_SIZE,
    MAX_BUFFER_SIZE
};
