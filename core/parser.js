/**
 * core/parser.js - Unified parsing interface
 *
 * Provides a single entry point for parsing any supported language.
 * AST-only, no regex fallback.
 */

const fs = require('fs');
const path = require('path');
const { detectLanguage, getParser, getLanguageModule, isSupported, PARSE_OPTIONS } = require('../languages');

/**
 * @typedef {Object} FunctionDef
 * @property {string} name - Function name
 * @property {string} params - Normalized parameters string
 * @property {Array<{name: string, type?: string, optional?: boolean, default?: string, rest?: boolean}>} paramsStructured
 * @property {string|null} returnType - Return type annotation
 * @property {number} startLine - 1-indexed start line
 * @property {number} endLine - 1-indexed end line
 * @property {number} indent - Indentation level
 * @property {string|null} docstring - First line of documentation
 * @property {string[]} modifiers - ['async', 'static', 'export', etc.]
 * @property {boolean} [isArrow] - Is arrow function (JS/TS)
 * @property {boolean} [isGenerator] - Is generator function
 * @property {boolean} [isMethod] - Is method with receiver (Go)
 * @property {string} [receiver] - Receiver type (Go)
 * @property {string} [generics] - Generic type parameters
 * @property {boolean} [isConstructor] - Is constructor
 */

/**
 * @typedef {Object} ClassDef
 * @property {string} name - Class/type name
 * @property {number} startLine - 1-indexed start line
 * @property {number} endLine - 1-indexed end line
 * @property {string} type - 'class', 'interface', 'type', 'enum', 'struct', 'trait', 'impl', 'module', 'macro', 'record'
 * @property {Array} members - Class members (methods, fields)
 * @property {string|null} [docstring] - First line of documentation
 * @property {string} [extends] - Parent class/type
 * @property {string[]} [implements] - Implemented interfaces
 * @property {string[]} modifiers - ['public', 'abstract', etc.]
 * @property {string} [generics] - Generic type parameters
 */

/**
 * @typedef {Object} StateDef
 * @property {string} name - Constant/state object name
 * @property {number} startLine - 1-indexed start line
 * @property {number} endLine - 1-indexed end line
 */

/**
 * @typedef {Object} ParseResult
 * @property {string} language - Detected language
 * @property {number} totalLines - Total lines in file
 * @property {FunctionDef[]} functions - All functions
 * @property {ClassDef[]} classes - All classes/types
 * @property {StateDef[]} stateObjects - All state objects
 * @property {Array} imports - Import statements (from imports.js)
 * @property {Array} exports - Export statements (from imports.js)
 */

/**
 * Parse source code and return structured result
 * @param {string} code - Source code
 * @param {string} language - Language name or file path for detection
 * @returns {ParseResult}
 */
function parse(code, language) {
    // Detect language if file path provided
    if (language.includes('.') || language.includes('/')) {
        language = detectLanguage(language);
    }

    if (!language || !isSupported(language)) {
        throw new Error(`Unsupported language: ${language}`);
    }

    const parser = getParser(language);
    const langModule = getLanguageModule(language);

    return langModule.parse(code, parser);
}

/**
 * Parse a file from disk
 * @param {string} filePath - Path to file
 * @returns {ParseResult}
 */
function parseFile(filePath) {
    const code = fs.readFileSync(filePath, 'utf-8');
    const language = detectLanguage(filePath);

    if (!language) {
        throw new Error(`Cannot detect language for: ${filePath}`);
    }

    const result = parse(code, language);
    result.filePath = filePath;
    result.relativePath = filePath;  // Will be updated by caller if needed
    return result;
}

/**
 * Extract a specific function by name
 * @param {string} code - Source code
 * @param {string} language - Language name
 * @param {string} name - Function name (supports fuzzy matching)
 * @returns {{fn: FunctionDef|null, code: string}}
 */
function extractFunction(code, language, name) {
    const result = parse(code, language);
    const lines = code.split('\n');

    // Exact match first
    let fn = result.functions.find(f => f.name === name);

    // Fuzzy match if not found
    if (!fn) {
        const lowerName = name.toLowerCase();
        fn = result.functions.find(f =>
            f.name.toLowerCase().includes(lowerName) ||
            lowerName.includes(f.name.toLowerCase())
        );
    }

    if (!fn) {
        return { fn: null, code: '' };
    }

    const extracted = lines.slice(fn.startLine - 1, fn.endLine);
    const fnCode = cleanHtmlScriptTags(extracted, language).join('\n');
    return { fn, code: fnCode };
}

/**
 * Extract a specific class by name
 * @param {string} code - Source code
 * @param {string} language - Language name
 * @param {string} name - Class name
 * @returns {{cls: ClassDef|null, code: string}}
 */
function extractClass(code, language, name) {
    const result = parse(code, language);
    const lines = code.split('\n');

    const cls = result.classes.find(c => c.name === name);
    if (!cls) {
        return { cls: null, code: '' };
    }

    const extracted = lines.slice(cls.startLine - 1, cls.endLine);
    const clsCode = cleanHtmlScriptTags(extracted, language).join('\n');
    return { cls, code: clsCode };
}

/**
 * Get table of contents for source code
 * @param {string} code - Source code
 * @param {string} language - Language name
 * @returns {ParseResult}
 */
function getToc(code, language) {
    return parse(code, language);
}

/**
 * Find all symbols matching a name
 * @param {ParseResult} result - Parse result
 * @param {string} name - Symbol name to find
 * @returns {Array<{name: string, type: string, startLine: number, endLine: number, params?: string}>}
 */
function findSymbol(result, name) {
    const symbols = [];
    const lowerName = name.toLowerCase();

    // Search functions
    for (const fn of result.functions) {
        if (fn.name.toLowerCase().includes(lowerName)) {
            symbols.push({
                name: fn.name,
                type: 'function',
                startLine: fn.startLine,
                endLine: fn.endLine,
                params: fn.params,
                returnType: fn.returnType,
                modifiers: fn.modifiers
            });
        }
    }

    // Search classes
    for (const cls of result.classes) {
        if (cls.name.toLowerCase().includes(lowerName)) {
            symbols.push({
                name: cls.name,
                type: cls.type,
                startLine: cls.startLine,
                endLine: cls.endLine,
                modifiers: cls.modifiers
            });
        }

        // Search class members
        if (cls.members) {
            for (const member of cls.members) {
                if (member.name.toLowerCase().includes(lowerName)) {
                    symbols.push({
                        name: member.name,
                        type: member.memberType || 'member',
                        startLine: member.startLine,
                        endLine: member.endLine,
                        params: member.params,
                        className: cls.name
                    });
                }
            }
        }
    }

    // Search state objects
    for (const state of result.stateObjects) {
        if (state.name.toLowerCase().includes(lowerName)) {
            symbols.push({
                name: state.name,
                type: 'state',
                startLine: state.startLine,
                endLine: state.endLine
            });
        }
    }

    return symbols;
}

/**
 * Get all exported/public symbols
 * @param {ParseResult} result - Parse result
 * @returns {Array}
 */
function getExportedSymbols(result) {
    const exported = [];

    for (const fn of result.functions) {
        if (fn.modifiers && fn.modifiers.includes('export')) {
            exported.push({
                name: fn.name,
                type: 'function',
                startLine: fn.startLine,
                endLine: fn.endLine,
                params: fn.params,
                returnType: fn.returnType
            });
        }
    }

    for (const cls of result.classes) {
        if (cls.modifiers && (cls.modifiers.includes('export') || cls.modifiers.includes('public'))) {
            exported.push({
                name: cls.name,
                type: cls.type,
                startLine: cls.startLine,
                endLine: cls.endLine
            });
        }
    }

    return exported;
}

/**
 * Strip <script> and </script> tags from extracted code lines for HTML files.
 * Only affects the first and last lines when they contain script tags alongside JS code.
 * @param {string[]} lines - Extracted lines
 * @param {string} language - Language name
 * @returns {string[]} Cleaned lines (same array mutated)
 */
function cleanHtmlScriptTags(lines, language) {
    if (language === 'html' && lines.length > 0) {
        lines[0] = lines[0].replace(/^(\s*)<script[^>]*>/i, '$1');
        const last = lines.length - 1;
        lines[last] = lines[last].replace(/<\/script>\s*$/i, '');
    }
    return lines;
}

module.exports = {
    parse,
    parseFile,
    extractFunction,
    extractClass,
    getToc,
    findSymbol,
    getExportedSymbols,
    cleanHtmlScriptTags,
    detectLanguage,
    isSupported
};
