/**
 * core/imports.js - Import/export parsing for dependency tracking
 *
 * Extracts import and export statements from source files
 * to build dependency graphs.
 */

const fs = require('fs');
const path = require('path');
const { getParser, getLanguageModule } = require('../languages');

/**
 * Extract imports from file content using AST
 *
 * @param {string} content - File content
 * @param {string} language - Language name
 * @returns {{ imports: Array<{ module: string, names: string[], type: string, line: number }> }}
 */
function extractImports(content, language) {
    // Normalize language name for parser
    const normalizedLang = (language === 'typescript' || language === 'tsx') ? 'javascript' : language;

    const langModule = getLanguageModule(normalizedLang);
    if (langModule && typeof langModule.findImportsInCode === 'function') {
        try {
            const parser = getParser(normalizedLang);
            if (parser) {
                const imports = langModule.findImportsInCode(content, parser);
                return { imports };
            }
        } catch (e) {
            // AST parsing failed
        }
    }

    return { imports: [] };
}

/**
 * Extract exports from file content using AST
 */
function extractExports(content, language) {
    // Normalize language name for parser
    const normalizedLang = (language === 'typescript' || language === 'tsx') ? 'javascript' : language;

    const langModule = getLanguageModule(normalizedLang);
    if (langModule && typeof langModule.findExportsInCode === 'function') {
        try {
            const parser = getParser(normalizedLang);
            if (parser) {
                const foundExports = langModule.findExportsInCode(content, parser);
                return { exports: foundExports };
            }
        } catch (e) {
            // AST parsing failed
        }
    }

    return { exports: [] };
}

// Cache for tsconfig lookups
const tsconfigCache = new Map();

/**
 * Resolve an import path to an actual file path
 *
 * @param {string} importPath - Import string
 * @param {string} fromFile - File containing the import
 * @param {object} config - Configuration { aliases, extensions, language, root }
 * @returns {string|null} - Resolved absolute path or null if external
 */
function resolveImport(importPath, fromFile, config = {}) {
    const fromDir = path.dirname(fromFile);

    // Strip query strings (e.g., ?raw, ?url)
    importPath = importPath.split('?')[0];

    // External packages (not relative or alias)
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
        // Check aliases
        if (config.aliases) {
            for (const [alias, target] of Object.entries(config.aliases)) {
                if (importPath.startsWith(alias)) {
                    const relativePath = importPath.slice(alias.length);
                    const targetPath = path.join(config.root || fromDir, target, relativePath);
                    return resolveFilePath(targetPath, config.extensions || getExtensions(config.language));
                }
            }
        }

        // Check tsconfig paths (JS/TS only)
        if (config.language === 'javascript' || config.language === 'typescript' || config.language === 'tsx') {
            const tsconfig = findTsConfig(fromDir, config.root);
            if (tsconfig && tsconfig.compiledPaths) {
                // Use pre-compiled regex patterns from cache
                for (const { regex, targets } of tsconfig.compiledPaths) {
                    const match = importPath.match(regex);
                    if (match) {
                        for (const target of targets) {
                            const resolved = target.replace('*', match[1] || '');
                            const basePath = tsconfig.baseUrl || path.dirname(tsconfig.configPath);
                            const fullPath = path.join(basePath, resolved);
                            const result = resolveFilePath(fullPath, config.extensions || getExtensions(config.language));
                            if (result) return result;
                        }
                    }
                }
            }
        }

        // Check Go module imports
        if (config.language === 'go') {
            const resolved = resolveGoImport(importPath, fromFile, config.root);
            if (resolved) return resolved;
        }

        return null;  // External package
    }

    // Relative imports
    const resolved = path.resolve(fromDir, importPath);
    return resolveFilePath(resolved, config.extensions || getExtensions(config.language));
}

// Cache for Go module paths
const goModuleCache = new Map();

/**
 * Find and parse go.mod to get the module path
 * @param {string} startDir - Directory to start searching from
 * @returns {{modulePath: string, root: string}|null}
 */
function findGoModule(startDir) {
    // Check cache first
    if (goModuleCache.has(startDir)) {
        return goModuleCache.get(startDir);
    }

    let dir = startDir;
    while (dir !== path.dirname(dir)) {
        const goModPath = path.join(dir, 'go.mod');
        if (fs.existsSync(goModPath)) {
            try {
                const content = fs.readFileSync(goModPath, 'utf-8');
                // Parse module line: module github.com/user/project
                const match = content.match(/^module\s+(\S+)/m);
                if (match) {
                    const result = { modulePath: match[1], root: dir };
                    goModuleCache.set(startDir, result);
                    return result;
                }
            } catch (e) {
                // Ignore read errors
            }
        }
        dir = path.dirname(dir);
    }

    goModuleCache.set(startDir, null);
    return null;
}

/**
 * Resolve Go package import to local files
 * @param {string} importPath - Go import path (e.g., "github.com/user/proj/pkg/util")
 * @param {string} fromFile - File containing the import
 * @param {string} projectRoot - Project root directory
 * @returns {string|null} - Directory path containing the package, or null if external
 */
function resolveGoImport(importPath, fromFile, projectRoot) {
    const goMod = findGoModule(path.dirname(fromFile));
    if (!goMod) return null;

    const { modulePath, root } = goMod;

    // Check if the import is within this module
    if (importPath.startsWith(modulePath)) {
        // Convert module path to relative path
        // e.g., "github.com/user/proj/pkg/util" -> "pkg/util"
        const relativePath = importPath.slice(modulePath.length).replace(/^\//, '');
        const pkgDir = path.join(root, relativePath);

        // Go imports are directories, find a .go file in the directory
        if (fs.existsSync(pkgDir) && fs.statSync(pkgDir).isDirectory()) {
            // Return the first .go file in the directory (not _test.go)
            try {
                const files = fs.readdirSync(pkgDir);
                for (const file of files) {
                    if (file.endsWith('.go') && !file.endsWith('_test.go')) {
                        return path.join(pkgDir, file);
                    }
                }
            } catch (e) {
                // Ignore read errors
            }
        }
    }

    return null;
}

/**
 * Try to resolve a path with various extensions
 */
function resolveFilePath(basePath, extensions) {
    // Check exact path
    if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
        return basePath;
    }

    // Try adding extensions
    for (const ext of extensions) {
        const withExt = basePath + ext;
        if (fs.existsSync(withExt)) return withExt;
    }

    // Try index files
    for (const ext of extensions) {
        const indexPath = path.join(basePath, 'index' + ext);
        if (fs.existsSync(indexPath)) return indexPath;
    }

    return null;
}

/**
 * Get file extensions for a language
 */
function getExtensions(language) {
    switch (language) {
        case 'javascript':
            return ['.js', '.jsx', '.mjs', '.cjs'];
        case 'typescript':
        case 'tsx':
            return ['.ts', '.tsx', '.js', '.jsx'];
        case 'python':
            return ['.py'];
        case 'go':
            return ['.go'];
        case 'java':
            return ['.java'];
        case 'rust':
            return ['.rs'];
        default:
            return ['.js', '.ts'];
    }
}

/**
 * Find and load tsconfig.json
 */
function findTsConfig(fromDir, rootDir) {
    const cacheKey = fromDir;
    if (tsconfigCache.has(cacheKey)) {
        return tsconfigCache.get(cacheKey);
    }

    let currentDir = fromDir;
    const normalizedRoot = rootDir ? path.resolve(rootDir) : null;

    while (true) {
        const tsconfigPath = path.join(currentDir, 'tsconfig.json');
        if (fs.existsSync(tsconfigPath)) {
            try {
                const content = fs.readFileSync(tsconfigPath, 'utf-8');
                const cleanJson = stripJsonComments(content);
                const config = JSON.parse(cleanJson);

                const paths = config.compilerOptions?.paths || {};
                // Pre-compile regex patterns for path aliases to avoid repeated compilation
                const compiledPaths = Object.entries(paths).map(([pattern, targets]) => ({
                    pattern,
                    regex: new RegExp('^' + pattern.replace('*', '(.*)') + '$'),
                    targets
                }));

                const result = {
                    configPath: tsconfigPath,
                    baseUrl: config.compilerOptions?.baseUrl
                        ? path.resolve(path.dirname(tsconfigPath), config.compilerOptions.baseUrl)
                        : null,
                    paths,
                    compiledPaths
                };

                tsconfigCache.set(cacheKey, result);
                return result;
            } catch (e) {
                // Skip malformed tsconfig
            }
        }

        const parent = path.dirname(currentDir);
        if (parent === currentDir) break;
        if (normalizedRoot && !currentDir.startsWith(normalizedRoot)) break;
        currentDir = parent;
    }

    tsconfigCache.set(cacheKey, null);
    return null;
}

/**
 * Strip JSON comments
 */
function stripJsonComments(content) {
    return content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*/g, '')
        .replace(/,(\s*[}\]])/g, '$1');
}

module.exports = {
    extractImports,
    extractExports,
    resolveImport
};
