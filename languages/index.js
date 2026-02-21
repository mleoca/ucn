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

// Language configurations
const LANGUAGES = {
    javascript: {
        name: 'javascript',
        extensions: ['.js', '.jsx', '.mjs', '.cjs'],
        treeSitterLang: 'javascript',
        module: () => require('./javascript')
    },
    typescript: {
        name: 'typescript',
        extensions: ['.ts'],
        treeSitterLang: 'typescript',
        module: () => require('./javascript')  // Same module, different parser
    },
    tsx: {
        name: 'tsx',
        extensions: ['.tsx'],
        treeSitterLang: 'tsx',
        module: () => require('./javascript')
    },
    python: {
        name: 'python',
        extensions: ['.py', '.pyi'],
        treeSitterLang: 'python',
        module: () => require('./python')
    },
    go: {
        name: 'go',
        extensions: ['.go'],
        treeSitterLang: 'go',
        module: () => require('./go')
    },
    rust: {
        name: 'rust',
        extensions: ['.rs'],
        treeSitterLang: 'rust',
        module: () => require('./rust')
    },
    java: {
        name: 'java',
        extensions: ['.java'],
        treeSitterLang: 'java',
        module: () => require('./java')
    },
    html: {
        name: 'html',
        extensions: ['.html', '.htm'],
        treeSitterLang: 'html',
        module: () => require('./html')
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
                'Install with: npm install'
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
        let lang;
        switch (language) {
            case 'javascript':
                lang = require('tree-sitter-javascript');
                break;
            case 'typescript':
                lang = require('tree-sitter-typescript').typescript;
                break;
            case 'tsx':
                lang = require('tree-sitter-typescript').tsx;
                break;
            case 'python':
                lang = require('tree-sitter-python');
                break;
            case 'go':
                lang = require('tree-sitter-go');
                break;
            case 'java':
                lang = require('tree-sitter-java');
                break;
            case 'rust':
                lang = require('tree-sitter-rust');
                break;
            case 'html':
                lang = require('tree-sitter-html');
                break;
            default:
                throw new Error(`No tree-sitter grammar for: ${language}`);
        }
        parser.setLanguage(lang);
    } catch (e) {
        throw new Error(
            `Failed to load tree-sitter-${language}.\n` +
            `Install with: npm install tree-sitter-${language}\n` +
            `Original error: ${e.message}`
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
function safeParse(parser, content, oldTree = undefined, options = {}) {
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
            return parser.parse(content, oldTree, { ...options, bufferSize });
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
    DEFAULT_BUFFER_SIZE,
    MAX_BUFFER_SIZE
};
