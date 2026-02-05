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
 * Import patterns by language
 * @deprecated Use AST-based findImportsInCode() from language modules instead.
 * Kept only as fallback for unsupported languages or when AST parsing fails.
 */
const IMPORT_PATTERNS = {
    javascript: {
        importDefault: /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
        importNamed: /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g,
        importNamespace: /import\s*\*\s*as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
        require: /(?:const|let|var)\s+(?:\{[^}]+\}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        exportNamed: /^\s*export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type)\s+(\w+)/gm,
        exportDefault: /^\s*export\s+default\s+(?:(?:async\s+)?(?:function|class)\s+)?(\w+)?/gm,
        exportList: /^\s*export\s*\{([^}]+)\}/gm,
        moduleExports: /^module\.exports\s*=\s*(?:\{([^}]+)\}|(\w+))/gm,
        exportsNamed: /^exports\.(\w+)\s*=[^=]/gm,
        importType: /import\s+type\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g,
        importSideEffect: /import\s+['"]([^'"]+)['"]/g,
        importDynamic: /(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        reExportNamed: /^\s*export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gm,
        reExportAll: /^\s*export\s*\*\s*from\s*['"]([^'"]+)['"]/gm
    },
    python: {
        importModule: /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm,
        fromImport: /^from\s+([.\w]+)\s+import\s+(.+)/gm,
        exportAll: /__all__\s*=\s*\[([^\]]+)\]/g
    },
    go: {
        importSingle: /import\s+"([^"]+)"/g,
        importBlock: /import\s*\(\s*([\s\S]*?)\s*\)/g,
        exportedFunc: /^func\s+(?:\([^)]+\)\s+)?([A-Z]\w*)\s*\(/gm,
        exportedType: /^type\s+([A-Z]\w*)\s+/gm
    },
    java: {
        importStatement: /import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/g,
        exportedClass: /public\s+(?:abstract\s+)?(?:final\s+)?(?:class|interface|enum)\s+(\w+)/g
    },
    rust: {
        useStatement: /^use\s+([^;]+);/gm,
        modDecl: /^\s*mod\s+(\w+)\s*;/gm
    }
};

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

    // Try AST-based extraction first
    const langModule = getLanguageModule(normalizedLang);
    if (langModule && typeof langModule.findImportsInCode === 'function') {
        try {
            const parser = getParser(normalizedLang);
            if (parser) {
                const imports = langModule.findImportsInCode(content, parser);
                return { imports };
            }
        } catch (e) {
            // Fall through to regex-based extraction
        }
    }

    // Fallback to regex-based extraction (deprecated)
    const imports = [];
    if (language === 'javascript' || language === 'typescript' || language === 'tsx') {
        extractJSImports(content, imports);
    } else if (language === 'python') {
        extractPythonImports(content, imports);
    } else if (language === 'go') {
        extractGoImports(content, imports);
    } else if (language === 'java') {
        extractJavaImports(content, imports);
    } else if (language === 'rust') {
        extractRustImports(content, imports);
    }

    return { imports };
}

/**
 * @deprecated Use AST-based findImportsInCode() from language modules.
 */
function extractJSImports(content, imports) {
    const patterns = IMPORT_PATTERNS.javascript;
    let match;

    // Default imports
    let regex = new RegExp(patterns.importDefault.source, 'g');
    while ((match = regex.exec(content)) !== null) {
        imports.push({ module: match[2], names: [match[1]], type: 'default' });
    }

    // Named imports
    regex = new RegExp(patterns.importNamed.source, 'g');
    while ((match = regex.exec(content)) !== null) {
        const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(n => n);
        imports.push({ module: match[2], names, type: 'named' });
    }

    // Namespace imports
    regex = new RegExp(patterns.importNamespace.source, 'g');
    while ((match = regex.exec(content)) !== null) {
        imports.push({ module: match[2], names: [match[1]], type: 'namespace' });
    }

    // Require
    regex = new RegExp(patterns.require.source, 'g');
    while ((match = regex.exec(content)) !== null) {
        imports.push({ module: match[2], names: match[1] ? [match[1]] : [], type: 'require' });
    }

    // Type imports
    regex = new RegExp(patterns.importType.source, 'g');
    while ((match = regex.exec(content)) !== null) {
        const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(n => n);
        imports.push({ module: match[2], names, type: 'type' });
    }

    // Side-effect imports
    regex = new RegExp(patterns.importSideEffect.source, 'g');
    while ((match = regex.exec(content)) !== null) {
        const module = match[1];
        if (!imports.some(i => i.module === module)) {
            imports.push({ module, names: [], type: 'side-effect' });
        }
    }

    // Dynamic imports
    regex = new RegExp(patterns.importDynamic.source, 'g');
    while ((match = regex.exec(content)) !== null) {
        const module = match[1];
        if (!imports.some(i => i.module === module)) {
            imports.push({ module, names: [], type: 'dynamic' });
        }
    }

    // Re-exports
    regex = new RegExp(patterns.reExportNamed.source, 'gm');
    while ((match = regex.exec(content)) !== null) {
        const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(n => n);
        imports.push({ module: match[2], names, type: 're-export' });
    }

    regex = new RegExp(patterns.reExportAll.source, 'gm');
    while ((match = regex.exec(content)) !== null) {
        imports.push({ module: match[1], names: ['*'], type: 're-export-all' });
    }
}

/** @deprecated Use AST-based findImportsInCode() from language modules. */
function extractPythonImports(content, imports) {
    const patterns = IMPORT_PATTERNS.python;
    let match;

    let regex = new RegExp(patterns.importModule.source, 'gm');
    while ((match = regex.exec(content)) !== null) {
        const moduleName = match[1];
        const alias = match[2] || moduleName.split('.').pop();
        imports.push({ module: moduleName, names: [alias], type: 'module' });
    }

    regex = new RegExp(patterns.fromImport.source, 'gm');
    while ((match = regex.exec(content)) !== null) {
        const moduleName = match[1];
        const importList = match[2].trim();

        if (importList === '*') {
            imports.push({ module: moduleName, names: ['*'], type: 'star' });
        } else {
            const names = importList.split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(n => n && n !== '(');
            imports.push({ module: moduleName, names, type: 'from' });
        }
    }
}

/** @deprecated Use AST-based findImportsInCode() from language modules. */
function extractGoImports(content, imports) {
    const patterns = IMPORT_PATTERNS.go;
    let match;

    let regex = new RegExp(patterns.importSingle.source, 'g');
    while ((match = regex.exec(content)) !== null) {
        const pkg = match[1];
        imports.push({ module: pkg, names: [path.basename(pkg)], type: 'single' });
    }

    regex = new RegExp(patterns.importBlock.source, 'g');
    while ((match = regex.exec(content)) !== null) {
        const block = match[1];
        const pkgMatches = block.matchAll(/"([^"]+)"/g);
        for (const pkgMatch of pkgMatches) {
            const pkg = pkgMatch[1];
            imports.push({ module: pkg, names: [path.basename(pkg)], type: 'block' });
        }
    }
}

/** @deprecated Use AST-based findImportsInCode() from language modules. */
function extractJavaImports(content, imports) {
    const patterns = IMPORT_PATTERNS.java;
    let match;

    let regex = new RegExp(patterns.importStatement.source, 'g');
    while ((match = regex.exec(content)) !== null) {
        const fullImport = match[1];
        const parts = fullImport.split('.');
        const name = parts[parts.length - 1];
        imports.push({ module: fullImport, names: name === '*' ? ['*'] : [name], type: 'import' });
    }
}

/** @deprecated Use AST-based findImportsInCode() from language modules. */
function extractRustImports(content, imports) {
    const patterns = IMPORT_PATTERNS.rust;
    let match;

    let regex = new RegExp(patterns.useStatement.source, 'gm');
    while ((match = regex.exec(content)) !== null) {
        let raw = match[1].trim().split('{')[0].trim().split(' as ')[0].trim().replace(/::$/, '');
        if (raw) {
            imports.push({ module: raw, names: [], type: 'use' });
        }
    }

    regex = new RegExp(patterns.modDecl.source, 'gm');
    while ((match = regex.exec(content)) !== null) {
        imports.push({ module: `self::${match[1]}`, names: [match[1]], type: 'mod' });
    }
}

/**
 * Extract exports from file content using AST
 */
function extractExports(content, language) {
    // Normalize language name for parser
    const normalizedLang = (language === 'typescript' || language === 'tsx') ? 'javascript' : language;

    // Try AST-based extraction first
    const langModule = getLanguageModule(normalizedLang);
    if (langModule && typeof langModule.findExportsInCode === 'function') {
        try {
            const parser = getParser(normalizedLang);
            if (parser) {
                const foundExports = langModule.findExportsInCode(content, parser);
                return { exports: foundExports };
            }
        } catch (e) {
            // Fall through to regex-based extraction
        }
    }

    // Fallback to regex-based extraction (deprecated)
    const foundExports = [];
    if (language === 'javascript' || language === 'typescript' || language === 'tsx') {
        extractJSExports(content, foundExports);
    } else if (language === 'python') {
        extractPythonExports(content, foundExports);
    } else if (language === 'go') {
        extractGoExports(content, foundExports);
    } else if (language === 'java') {
        extractJavaExports(content, foundExports);
    }

    return { exports: foundExports };
}

/** @deprecated Use AST-based findExportsInCode() from language modules. */
function extractJSExports(content, exports) {
    const patterns = IMPORT_PATTERNS.javascript;
    let match;

    let regex = new RegExp(patterns.exportNamed.source, 'gm');
    while ((match = regex.exec(content)) !== null) {
        exports.push({ name: match[1], type: 'named' });
    }

    regex = new RegExp(patterns.exportDefault.source, 'gm');
    while ((match = regex.exec(content)) !== null) {
        exports.push({ name: match[1] || 'default', type: 'default' });
    }

    regex = new RegExp(patterns.exportList.source, 'gm');
    while ((match = regex.exec(content)) !== null) {
        const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(n => n);
        for (const name of names) {
            exports.push({ name, type: 'list' });
        }
    }

    regex = new RegExp(patterns.exportsNamed.source, 'gm');
    while ((match = regex.exec(content)) !== null) {
        exports.push({ name: match[1], type: 'commonjs-named' });
    }

    // module.exports = { a, b, c } or module.exports = identifier
    regex = new RegExp(patterns.moduleExports.source, 'gm');
    while ((match = regex.exec(content)) !== null) {
        if (match[1]) {
            // Object literal: module.exports = { a, b, c }
            const names = match[1].split(',').map(n => n.trim().split(/\s*:\s*/)[0].trim()).filter(n => n && !n.includes('('));
            for (const name of names) {
                exports.push({ name, type: 'commonjs-object' });
            }
        } else if (match[2]) {
            // Single identifier: module.exports = SomeClass
            exports.push({ name: match[2], type: 'commonjs-default' });
        }
    }
}

/** @deprecated Use AST-based findExportsInCode() from language modules. */
function extractPythonExports(content, exports) {
    let match;

    // Check for __all__
    let regex = new RegExp(IMPORT_PATTERNS.python.exportAll.source, 'g');
    while ((match = regex.exec(content)) !== null) {
        const names = match[1].split(',').map(n => n.trim().replace(/['"]/g, '')).filter(n => n);
        for (const name of names) {
            exports.push({ name, type: 'explicit' });
        }
    }

    // If no __all__, look for public names
    if (exports.length === 0) {
        const funcRegex = /^def\s+([a-zA-Z]\w*)\s*\(/gm;
        while ((match = funcRegex.exec(content)) !== null) {
            if (!match[1].startsWith('_')) {
                exports.push({ name: match[1], type: 'function' });
            }
        }

        const classRegex = /^class\s+([a-zA-Z]\w*)/gm;
        while ((match = classRegex.exec(content)) !== null) {
            if (!match[1].startsWith('_')) {
                exports.push({ name: match[1], type: 'class' });
            }
        }
    }
}

/** @deprecated Use AST-based findExportsInCode() from language modules. */
function extractGoExports(content, exports) {
    const patterns = IMPORT_PATTERNS.go;
    let match;

    let regex = new RegExp(patterns.exportedFunc.source, 'gm');
    while ((match = regex.exec(content)) !== null) {
        exports.push({ name: match[1], type: 'function' });
    }

    regex = new RegExp(patterns.exportedType.source, 'gm');
    while ((match = regex.exec(content)) !== null) {
        exports.push({ name: match[1], type: 'type' });
    }
}

/** @deprecated Use AST-based findExportsInCode() from language modules. */
function extractJavaExports(content, exports) {
    let match;
    let regex = new RegExp(IMPORT_PATTERNS.java.exportedClass.source, 'g');
    while ((match = regex.exec(content)) !== null) {
        exports.push({ name: match[1], type: 'class' });
    }
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
    resolveImport,
    IMPORT_PATTERNS
};
