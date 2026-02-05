/**
 * UCN - Universal Code Navigator
 *
 * Code navigation built by AI, for AI.
 * Reduces context usage by 90%+ when working with large codebases.
 */

const parser = require('./core/parser');
const { ProjectIndex } = require('./core/project');
const discovery = require('./core/discovery');
const imports = require('./core/imports');
const output = require('./core/output');
const languages = require('./languages');

/**
 * Main API
 */
module.exports = {
    // Core parser functions
    parse: parser.parse,
    parseFile: parser.parseFile,
    extractFunction: parser.extractFunction,
    extractClass: parser.extractClass,
    getToc: parser.getToc,
    findSymbol: parser.findSymbol,
    getExportedSymbols: parser.getExportedSymbols,

    // Language detection
    detectLanguage: parser.detectLanguage,
    isSupported: parser.isSupported,

    // Project-level operations
    ProjectIndex,

    // File discovery
    expandGlob: discovery.expandGlob,
    findProjectRoot: discovery.findProjectRoot,
    detectProjectPattern: discovery.detectProjectPattern,
    isTestFile: discovery.isTestFile,
    findTestFileFor: discovery.findTestFileFor,

    // Import/export analysis
    extractImports: imports.extractImports,
    extractExports: imports.extractExports,
    resolveImport: imports.resolveImport,

    // Output formatting
    output,

    // Language modules (for advanced use)
    languages
};
