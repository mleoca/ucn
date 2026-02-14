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
    // Use JS language module for TS/TSX (same import syntax), but the actual language's parser
    const moduleLang = (language === 'typescript' || language === 'tsx') ? 'javascript' : language;

    const langModule = getLanguageModule(moduleLang);
    if (langModule && typeof langModule.findImportsInCode === 'function') {
        try {
            const parser = getParser(language);
            if (parser) {
                const imports = langModule.findImportsInCode(content, parser);
                const dynamicCount = imports.filter(i => i.dynamic).length;
                const importAliases = imports.aliases || null;
                return { imports, dynamicCount, importAliases };
            }
        } catch (e) {
            // AST parsing failed
        }
    }

    return { imports: [], dynamicCount: 0 };
}

/**
 * Extract exports from file content using AST
 */
function extractExports(content, language) {
    // Use JS language module for TS/TSX (same export syntax), but the actual language's parser
    const moduleLang = (language === 'typescript' || language === 'tsx') ? 'javascript' : language;

    const langModule = getLanguageModule(moduleLang);
    if (langModule && typeof langModule.findExportsInCode === 'function') {
        try {
            const parser = getParser(language);
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
            if (tsconfig) {
                if (tsconfig.compiledPaths) {
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
                // Fallback: resolve non-relative import directly from baseUrl
                // e.g., import 'services/user' with baseUrl='src' -> src/services/user
                if (tsconfig.baseUrl) {
                    const fullPath = path.join(tsconfig.baseUrl, importPath);
                    const result = resolveFilePath(fullPath, config.extensions || getExtensions(config.language));
                    if (result) return result;
                }
            }
        }

        // Check Go module imports
        if (config.language === 'go') {
            const resolved = resolveGoImport(importPath, fromFile, config.root);
            if (resolved) return resolved;
        }

        // Rust: crate::, super::, self:: paths and mod declarations
        if (config.language === 'rust') {
            const resolved = resolveRustImport(importPath, fromFile, config.root);
            if (resolved) return resolved;
        }

        // Python: non-relative package imports (e.g., "tools.analyzer" -> "tools/analyzer.py")
        // Try resolving dotted module path from the project root
        if (config.language === 'python' && config.root) {
            const modulePath = importPath.replace(/\./g, '/');
            const fullPath = path.join(config.root, modulePath);
            const resolved = resolveFilePath(fullPath, getExtensions('python'));
            if (resolved) return resolved;
        }

        return null;  // External package
    }

    // Python relative imports: translate dot-prefix notation to file paths
    // e.g., ".models" -> "./models", "..utils" -> "../utils", "." -> "."
    let normalizedPath = importPath;
    if (config.language === 'python') {
        // Count leading dots and convert to filesystem relative path
        const dotMatch = importPath.match(/^(\.+)(.*)/);
        if (dotMatch) {
            const dots = dotMatch[1];
            const rest = dotMatch[2];
            if (dots.length === 1) {
                // ".models" -> "./models", "." -> "."
                normalizedPath = rest ? './' + rest.replace(/\./g, '/') : '.';
            } else {
                // "..models" -> "../models", "...models" -> "../../models"
                const upDirs = '../'.repeat(dots.length - 1);
                normalizedPath = rest ? upDirs + rest.replace(/\./g, '/') : upDirs.slice(0, -1);
            }
        }
    }

    // Relative imports
    const resolved = path.resolve(fromDir, normalizedPath);
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

// Cache for Rust crate roots (Cargo.toml locations)
const cargoCache = new Map();

/**
 * Find the nearest Cargo.toml and return the crate's source root
 * @param {string} startDir - Directory to start searching from
 * @returns {{root: string, srcDir: string}|null}
 */
function findCargoRoot(startDir) {
    if (cargoCache.has(startDir)) {
        return cargoCache.get(startDir);
    }

    let dir = startDir;
    while (dir !== path.dirname(dir)) {
        const cargoPath = path.join(dir, 'Cargo.toml');
        if (fs.existsSync(cargoPath)) {
            const srcDir = path.join(dir, 'src');
            const result = fs.existsSync(srcDir) ? { root: dir, srcDir } : null;
            cargoCache.set(startDir, result);
            return result;
        }
        dir = path.dirname(dir);
    }

    cargoCache.set(startDir, null);
    return null;
}

/**
 * Try to resolve a Rust module path to a file
 * Checks both <path>.rs and <path>/mod.rs
 * @param {string} dir - Base directory
 * @param {string[]} segments - Path segments to resolve
 * @returns {string|null}
 */
function resolveRustModulePath(dir, segments) {
    // Try progressively shorter paths (items at the end may be types, not modules)
    for (let len = segments.length; len >= 1; len--) {
        const modPath = path.join(dir, ...segments.slice(0, len));
        // Try <path>.rs
        const rsFile = modPath + '.rs';
        if (fs.existsSync(rsFile) && fs.statSync(rsFile).isFile()) {
            return rsFile;
        }
        // Try <path>/mod.rs
        const modFile = path.join(modPath, 'mod.rs');
        if (fs.existsSync(modFile) && fs.statSync(modFile).isFile()) {
            return modFile;
        }
    }
    return null;
}

/**
 * Resolve Rust import paths to local files
 * Handles: crate::, super::, self::, and mod declarations
 * @param {string} importPath - Rust import path (e.g., "crate::display::Display" or "display")
 * @param {string} fromFile - File containing the import
 * @param {string} projectRoot - Project root directory
 * @returns {string|null}
 */
function resolveRustImport(importPath, fromFile, projectRoot) {
    const fromDir = path.dirname(fromFile);

    // crate:: paths - resolve from the crate's src/ directory
    if (importPath.startsWith('crate::')) {
        const cargo = findCargoRoot(fromDir);
        if (!cargo) return null;

        const rest = importPath.slice('crate::'.length);
        const segments = rest.split('::');
        return resolveRustModulePath(cargo.srcDir, segments);
    }

    // super:: paths - resolve relative to parent directory
    if (importPath.startsWith('super::')) {
        let dir = fromDir;
        let rest = importPath;
        while (rest.startsWith('super::')) {
            // If current file is mod.rs, go up one more directory
            const basename = path.basename(fromFile);
            if (basename === 'mod.rs' && dir === fromDir) {
                dir = path.dirname(dir);
            }
            dir = path.dirname(dir);
            rest = rest.slice('super::'.length);
        }
        const segments = rest.split('::');
        return resolveRustModulePath(dir, segments);
    }

    // self:: paths - resolve within current module directory
    if (importPath.startsWith('self::')) {
        const rest = importPath.slice('self::'.length);
        const segments = rest.split('::');
        // If current file is mod.rs, resolve relative to its directory
        const basename = path.basename(fromFile);
        const dir = basename === 'mod.rs' ? fromDir : path.dirname(fromDir);
        return resolveRustModulePath(dir, segments);
    }

    // Plain module name without :: (potential mod declaration)
    // e.g., "display" from `mod display;` - resolve relative to declaring file
    if (!importPath.includes('::')) {
        // For mod declarations: <dir>/<name>.rs or <dir>/<name>/mod.rs
        const rsFile = path.join(fromDir, importPath + '.rs');
        if (fs.existsSync(rsFile) && fs.statSync(rsFile).isFile()) {
            return rsFile;
        }
        const modFile = path.join(fromDir, importPath, 'mod.rs');
        if (fs.existsSync(modFile) && fs.statSync(modFile).isFile()) {
            return modFile;
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

    // Try index files (index.js for JS/TS, __init__.py for Python)
    for (const ext of extensions) {
        const indexPath = path.join(basePath, 'index' + ext);
        if (fs.existsSync(indexPath)) return indexPath;
    }
    // Python __init__.py
    const initPath = path.join(basePath, '__init__.py');
    if (fs.existsSync(initPath)) return initPath;

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
                const result = loadTsConfig(tsconfigPath);
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
 * Load and parse a tsconfig.json, following "extends" chains
 */
function loadTsConfig(tsconfigPath, visited) {
    if (!visited) visited = new Set();
    if (visited.has(tsconfigPath)) return null; // prevent circular extends
    visited.add(tsconfigPath);

    const content = fs.readFileSync(tsconfigPath, 'utf-8');
    const cleanJson = stripJsonComments(content);
    const config = JSON.parse(cleanJson);
    const configDir = path.dirname(tsconfigPath);

    // Merge with base config if "extends" is present
    let basePaths = {};
    let baseUrl = null;
    if (config.extends) {
        const extendsList = Array.isArray(config.extends) ? config.extends : [config.extends];
        for (const ext of extendsList) {
            let basePath;
            if (ext.startsWith('.')) {
                basePath = path.resolve(configDir, ext);
            } else {
                // node_modules package (e.g., "@tsconfig/node20/tsconfig.json")
                try {
                    basePath = require.resolve(ext, { paths: [configDir] });
                } catch {
                    continue;
                }
            }
            // Add .json extension if not present
            if (!basePath.endsWith('.json')) basePath += '.json';
            if (fs.existsSync(basePath)) {
                try {
                    const baseResult = loadTsConfig(basePath, visited);
                    if (baseResult) {
                        basePaths = { ...basePaths, ...baseResult.paths };
                        if (baseResult.baseUrl) baseUrl = baseResult.baseUrl;
                    }
                } catch {
                    // Skip malformed base config
                }
            }
        }
    }

    // Child config values override base config
    const mergedPaths = { ...basePaths, ...(config.compilerOptions?.paths || {}) };
    const compiledPaths = Object.entries(mergedPaths).map(([pattern, targets]) => ({
        pattern,
        regex: new RegExp('^' + pattern.replace('*', '(.*)') + '$'),
        targets
    }));

    return {
        configPath: tsconfigPath,
        baseUrl: config.compilerOptions?.baseUrl
            ? path.resolve(configDir, config.compilerOptions.baseUrl)
            : baseUrl,
        paths: mergedPaths,
        compiledPaths
    };
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
