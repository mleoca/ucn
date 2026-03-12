/**
 * core/project.js - Project symbol table and cross-file analysis
 *
 * Builds an in-memory index of all symbols in a project for fast queries.
 * Includes dependency weighting and disambiguation support.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, execFileSync } = require('child_process');
const { expandGlob, findProjectRoot, detectProjectPattern, isTestFile, parseGitignore, DEFAULT_IGNORES } = require('./discovery');
const { extractImports, extractExports, resolveImport } = require('./imports');
const { parse, parseFile, cleanHtmlScriptTags } = require('./parser');
const { detectLanguage, getParser, getLanguageModule, safeParse } = require('../languages');
const { getTokenTypeAtPosition } = require('../languages/utils');
const { escapeRegExp, NON_CALLABLE_TYPES, addTestExclusions } = require('./shared');
const stacktrace = require('./stacktrace');
const indexCache = require('./cache');
const deadcodeModule = require('./deadcode');
const verifyModule = require('./verify');
const callersModule = require('./callers');

// Lazy-initialized per-language keyword sets (populated on first isKeyword call)
let LANGUAGE_KEYWORDS = null;

/**
 * Build a glob-style matcher: * matches any sequence, ? matches one char.
 * Case-insensitive by default. Returns a function (string) => boolean.
 */
function buildGlobMatcher(pattern, caseSensitive) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    const regex = new RegExp('^' + escaped + '$', caseSensitive ? '' : 'i');
    return (name) => regex.test(name);
}

const STRUCTURAL_TYPES = new Set(['function', 'class', 'call', 'method', 'type']);

/**
 * Substring match. Case-insensitive by default.
 */
function matchesSubstring(text, pattern, caseSensitive) {
    if (!text) return false;
    if (caseSensitive) return text.includes(pattern);
    return text.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * ProjectIndex - Manages symbol table for a project
 */
class ProjectIndex {
    /**
     * Create a new ProjectIndex
     * @param {string} rootDir - Project root directory
     */
    constructor(rootDir) {
        this.root = findProjectRoot(rootDir);
        this.files = new Map();           // path -> FileEntry
        this.symbols = new Map();         // name -> SymbolEntry[]
        this.importGraph = new Map();     // file -> [imported files]
        this.exportGraph = new Map();     // file -> [files that import it]
        this.extendsGraph = new Map();    // className -> [parentName, ...] (array of parents)
        this.extendedByGraph = new Map(); // parentName -> [childInfo]
        this.config = this.loadConfig();
        this.buildTime = null;
        this.callsCache = new Map();     // filePath -> { mtime, hash, calls, content }
        this.callsCacheDirty = false;    // set by getCachedCalls when entries are added or mutated
        this.failedFiles = new Set();    // files that failed to index (e.g. large minified bundles)
        this._opContentCache = null;     // per-operation file content cache (Map<filePath, string>)
        this._opUsagesCache = null;      // per-operation findUsagesInCode cache (Map<"file:name", usages[]>)
        this.calleeIndex = null;         // name -> Set<filePath> — inverted call index (built lazily)
    }

    /**
     * Read file content with per-operation caching.
     * When an operation cache is active (_opContentCache is set), reads are
     * cached for the duration of the operation to avoid redundant disk I/O.
     */
    _readFile(filePath) {
        if (this._opContentCache) {
            const cached = this._opContentCache.get(filePath);
            if (cached !== undefined) return cached;
            const content = fs.readFileSync(filePath, 'utf-8');
            this._opContentCache.set(filePath, content);
            return content;
        }
        return fs.readFileSync(filePath, 'utf-8');
    }

    /** Start a per-operation content cache scope (supports nesting) */
    _beginOp() {
        if (!this._opContentCache) {
            this._opContentCache = new Map();
            this._opUsagesCache = new Map();
            this._opDepth = 0;
        }
        this._opDepth++;
    }

    /** End a per-operation content cache scope (only clears when outermost scope ends) */
    _endOp() {
        if (--this._opDepth <= 0) {
            this._opContentCache = null;
            this._opUsagesCache = null;
            this._opDepth = 0;
        }
    }

    /**
     * Get findUsagesInCode results with per-operation caching.
     * Avoids redundant tree-sitter parsing when the same (file, name) is queried
     * multiple times within one operation (e.g., about() calls both countSymbolUsages and usages).
     * @param {string} filePath - File to scan
     * @param {string} name - Symbol name to find
     * @returns {Array|null} Array of usage objects or null if parsing failed
     */
    _getCachedUsages(filePath, name) {
        const cacheKey = `${filePath}\0${name}`;
        if (this._opUsagesCache) {
            const cached = this._opUsagesCache.get(cacheKey);
            if (cached !== undefined) return cached;
        }

        const lang = detectLanguage(filePath);
        const langModule = getLanguageModule(lang);
        if (!langModule || typeof langModule.findUsagesInCode !== 'function') return null;

        try {
            // Fast pre-check: skip tree-sitter parsing if name doesn't appear in file
            const content = this._readFile(filePath);
            if (!content.includes(name)) {
                const empty = [];
                if (this._opUsagesCache) {
                    this._opUsagesCache.set(cacheKey, empty);
                }
                return empty;
            }

            const parser = getParser(lang);
            if (!parser) return null;
            const usages = langModule.findUsagesInCode(content, name, parser);
            if (this._opUsagesCache) {
                this._opUsagesCache.set(cacheKey, usages);
            }
            return usages;
        } catch (e) {
            return null;
        }
    }

    /**
     * Load .ucn.json config if present (data-only, no code execution)
     */
    loadConfig() {
        const jsonPath = path.join(this.root, '.ucn.json');
        if (fs.existsSync(jsonPath)) {
            try {
                return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
            } catch (e) {
                // Config load failed, use defaults
            }
        }
        return {};
    }

    /**
     * Build index for files matching pattern
     *
     * @param {string} pattern - Glob pattern (e.g., "**\/*.js")
     * @param {object} options - { forceRebuild, maxFiles, quiet }
     */
    build(pattern, options = {}) {
        const startTime = Date.now();
        const quiet = options.quiet !== false;

        if (!pattern) {
            pattern = detectProjectPattern(this.root);
        }

        const globOpts = {
            root: this.root,
            maxFiles: options.maxFiles || this.config.maxFiles || 50000,
            followSymlinks: options.followSymlinks
        };

        // Merge .gitignore and .ucn.json exclude into file discovery
        const gitignorePatterns = parseGitignore(this.root);
        const configExclude = this.config.exclude || [];
        if (gitignorePatterns.length > 0 || configExclude.length > 0) {
            globOpts.ignores = [...DEFAULT_IGNORES, ...gitignorePatterns, ...configExclude];
        }

        const files = expandGlob(pattern, globOpts);

        // Track if files were truncated by maxFiles limit
        if (files.length >= globOpts.maxFiles) {
            this.truncated = { indexed: files.length, maxFiles: globOpts.maxFiles };
        } else {
            this.truncated = null;
        }

        if (!quiet) {
            console.error(`Indexing ${files.length} files in ${this.root}...`);
        }

        let deletedInRebuild = 0;
        if (options.forceRebuild) {
            // Incremental rebuild: only remove files that no longer exist on disk.
            // indexFile() already skips unchanged files and calls removeFileSymbols()
            // for changed files, so we don't need to clear everything.
            const currentFileSet = new Set(files);
            for (const cachedPath of this.files.keys()) {
                if (!currentFileSet.has(cachedPath)) {
                    this.removeFileSymbols(cachedPath);
                    this.files.delete(cachedPath);
                    this.callsCache.delete(cachedPath);
                    deletedInRebuild++;
                }
            }
        }

        // Always invalidate caches on rebuild
        this._completenessCache = null;
        this._attrTypeCache = null;

        let indexed = 0;
        let changed = 0;
        if (!this.failedFiles) this.failedFiles = new Set();
        for (const file of files) {
            try {
                if (this.indexFile(file)) changed++;
                indexed++;
                this.failedFiles.delete(file); // Succeeded now, remove from failed
            } catch (e) {
                this.failedFiles.add(file); // Track files that fail to index
                if (!quiet) {
                    console.error(`  Warning: Could not index ${file}: ${e.message}`);
                }
            }
        }

        // Skip graph rebuild when incremental rebuild found no changes
        if (changed > 0 || deletedInRebuild > 0 || !options.forceRebuild) {
            this.buildImportGraph();
            this.buildInheritanceGraph();
        }

        this.buildTime = Date.now() - startTime;

        if (!quiet) {
            console.error(`Index complete: ${this.symbols.size} symbols in ${indexed} files (${this.buildTime}ms)`);
        }
    }

    /**
     * Build a minimal index for a single file (no glob, no cache, no import graph).
     * Used by CLI file mode to route through execute().
     */
    buildSingleFile(filePath) {
        const absPath = path.resolve(filePath);
        if (!fs.existsSync(absPath)) {
            throw new Error(`File not found: ${filePath}`);
        }
        this.indexFile(absPath);
        this.buildTime = 0;
    }

    /**
     * Index a single file
     */
    indexFile(filePath) {
        const stat = fs.statSync(filePath);
        const existing = this.files.get(filePath);

        // Fast path: skip read entirely when mtime+size both match
        if (existing && existing.mtime === stat.mtimeMs && existing.size === stat.size) {
            return false;
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const hash = crypto.createHash('md5').update(content).digest('hex');

        // Content-based skip: mtime changed but content didn't (touch, git checkout)
        if (existing && existing.hash === hash) {
            existing.mtime = stat.mtimeMs;
            existing.size = stat.size;
            return false;
        }

        if (existing) {
            this.removeFileSymbols(filePath);
        }

        const language = detectLanguage(filePath);
        if (!language) return;

        // Parse content once — the tree-sitter cache in safeParse ensures the tree
        // is shared across parse()/extractImports()/extractExports() (5→1 parse per file)
        const parsed = parse(content, language);
        parsed.filePath = filePath;
        parsed.relativePath = filePath;
        const { imports, dynamicCount, importAliases } = extractImports(content, language);
        const { exports } = extractExports(content, language);

        // Detect bundled/minified files (webpack bundles, minified code)
        // These are build artifacts, not user-written source code
        const contentLines = content.split('\n');
        const isBundled = (() => {
            // Webpack bundles contain __webpack_require__ or __webpack_modules__
            if (content.includes('__webpack_require__') || content.includes('__webpack_modules__')) return true;
            // Minified files: very few lines but large content (avg > 500 chars/line)
            if (contentLines.length > 0 && contentLines.length < 50 && content.length / contentLines.length > 500) return true;
            // Very long single lines (> 1000 chars) in most of the file suggest minification
            if (contentLines.length > 0) {
                const longLines = contentLines.filter(l => l.length > 1000).length;
                if (longLines > 0 && longLines / contentLines.length > 0.3) return true;
            }
            return false;
        })();

        const fileEntry = {
            path: filePath,
            relativePath: path.relative(this.root, filePath),
            language,
            lines: contentLines.length,
            hash,
            mtime: stat.mtimeMs,
            size: stat.size,
            imports: imports.map(i => i.module),
            importNames: imports.flatMap(i => i.names || []),
            exports: exports.map(e => e.name),
            exportDetails: exports,
            symbols: [],
            bindings: [],
            ...(importAliases && { importAliases }),
            ...(isBundled && { isBundled: true })
        };
        fileEntry.dynamicImports = dynamicCount || 0;

        // Add symbols
        const addSymbol = (item, type) => {
            const symbol = {
                name: item.name,
                type,
                file: filePath,
                relativePath: fileEntry.relativePath,
                startLine: item.startLine,
                endLine: item.endLine,
                params: item.params,
                paramsStructured: item.paramsStructured,
                returnType: item.returnType,
                modifiers: item.modifiers,
                docstring: item.docstring,
                bindingId: `${fileEntry.relativePath}:${type}:${item.startLine}`,
                ...(item.generics && { generics: item.generics }),
                ...(item.extends && { extends: item.extends }),
                ...(item.implements && { implements: item.implements }),
                ...(item.indent !== undefined && { indent: item.indent }),
                ...(item.isNested && { isNested: item.isNested }),
                ...(item.isMethod && { isMethod: item.isMethod }),
                ...(item.receiver && { receiver: item.receiver }),
                ...(item.className && { className: item.className }),
                ...(item.memberType && { memberType: item.memberType }),
                ...(item.fieldType && { fieldType: item.fieldType }),
                ...(item.decorators && item.decorators.length > 0 && { decorators: item.decorators }),
                ...(item.nameLine && { nameLine: item.nameLine })
            };
            fileEntry.symbols.push(symbol);
            fileEntry.bindings.push({
                id: symbol.bindingId,
                name: symbol.name,
                type: symbol.type,
                startLine: symbol.startLine
            });

            if (!this.symbols.has(item.name)) {
                this.symbols.set(item.name, []);
            }
            this.symbols.get(item.name).push(symbol);
        };

        for (const fn of parsed.functions) {
            // Go/Rust methods: set className from receiver for consistent method resolution.
            // Go/Rust methods are standalone functions with receiver, not class members,
            // so className is never set by the class member loop below.
            if (fn.receiver && !fn.className) {
                fn.className = fn.receiver.replace(/^\*/, '');
            }
            addSymbol(fn, fn.isConstructor ? 'constructor' : 'function');
        }

        for (const cls of parsed.classes) {
            addSymbol(cls, cls.type || 'class');
            if (cls.members) {
                for (const m of cls.members) {
                    const memberType = m.memberType || 'method';
                    addSymbol({ ...m, className: cls.name }, memberType);
                }
            }
        }

        for (const state of parsed.stateObjects) {
            addSymbol(state, 'state');
        }

        this.files.set(filePath, fileEntry);
        return true;
    }

    /**
     * Remove a file's symbols from the global map
     */
    removeFileSymbols(filePath) {
        const existing = this.files.get(filePath);
        if (!existing) return;

        for (const symbol of existing.symbols) {
            const entries = this.symbols.get(symbol.name);
            if (entries) {
                const filtered = entries.filter(e => e.file !== filePath);
                if (filtered.length > 0) {
                    this.symbols.set(symbol.name, filtered);
                } else {
                    this.symbols.delete(symbol.name);
                }
            }
        }

        // Invalidate cached call data for this file
        this.callsCache.delete(filePath);

        // Invalidate callee index (will be rebuilt lazily)
        this.calleeIndex = null;

        // Invalidate attribute type cache for this file
        if (this._attrTypeCache) this._attrTypeCache.delete(filePath);
    }

    /**
     * Build inverted call index: callee name -> Set<filePath>.
     * Built lazily on first findCallers call, from the calls cache.
     * Enables O(relevant files) lookup instead of O(all files) scan.
     */
    buildCalleeIndex() {
        const { getCachedCalls } = require('./callers');
        this.calleeIndex = new Map();

        for (const [filePath] of this.files) {
            const calls = getCachedCalls(this, filePath);
            if (!calls) continue;
            for (const call of calls) {
                const name = call.name;
                if (!this.calleeIndex.has(name)) {
                    this.calleeIndex.set(name, new Set());
                }
                this.calleeIndex.get(name).add(filePath);
                // Also index resolvedName and resolvedNames for alias resolution
                if (call.resolvedName && call.resolvedName !== name) {
                    if (!this.calleeIndex.has(call.resolvedName)) {
                        this.calleeIndex.set(call.resolvedName, new Set());
                    }
                    this.calleeIndex.get(call.resolvedName).add(filePath);
                }
                if (call.resolvedNames) {
                    for (const rn of call.resolvedNames) {
                        if (rn !== name) {
                            if (!this.calleeIndex.has(rn)) {
                                this.calleeIndex.set(rn, new Set());
                            }
                            this.calleeIndex.get(rn).add(filePath);
                        }
                    }
                }
            }
        }
    }

    /**
     * Get the set of files that contain calls to a given name.
     * Returns null if callee index is not available (falls back to full scan).
     */
    getCalleeFiles(name) {
        if (!this.calleeIndex) {
            this.buildCalleeIndex();
        }
        return this.calleeIndex.get(name) || null;
    }

    /**
     * Resolve a Java package import to a project file.
     * Handles regular imports, static imports (strips member name), and wildcards (strips .*).
     * Progressively strips trailing segments to find the class file.
     */
    _resolveJavaPackageImport(importModule, javaFileIndex) {
        const isWildcard = importModule.endsWith('.*');
        // Strip wildcard suffix (e.g., "com.pkg.Class.*" -> "com.pkg.Class")
        const mod = isWildcard ? importModule.slice(0, -2) : importModule;
        const segments = mod.split('.');

        // Try progressively shorter paths: full path, then strip last segment, etc.
        // This handles static imports where path includes member name after class
        if (javaFileIndex) {
            // Fast path: use pre-built filename→files index (O(candidates) vs O(all files))
            for (let i = segments.length; i > 0; i--) {
                const className = segments[i - 1];
                const candidates = javaFileIndex.get(className);
                if (candidates) {
                    const fileSuffix = '/' + segments.slice(0, i).join('/') + '.java';
                    for (const absPath of candidates) {
                        if (absPath.endsWith(fileSuffix)) {
                            return absPath;
                        }
                    }
                }
            }
        } else {
            // Fallback: scan all files (used by imports() method outside buildImportGraph)
            for (let i = segments.length; i > 0; i--) {
                const fileSuffix = '/' + segments.slice(0, i).join('/') + '.java';
                for (const absPath of this.files.keys()) {
                    if (absPath.endsWith(fileSuffix)) {
                        return absPath;
                    }
                }
            }
        }

        // For wildcard imports (com.pkg.model.*), the package may be a directory
        // containing .java files. Check if any file lives under this package path.
        if (isWildcard) {
            const dirSuffix = '/' + segments.join('/') + '/';
            for (const absPath of this.files.keys()) {
                if (absPath.includes(dirSuffix)) {
                    return absPath;
                }
            }
        }

        return null;
    }

    /**
     * Build import/export relationship graphs
     */
    buildImportGraph() {
        this.importGraph.clear();
        this.exportGraph.clear();

        // Pre-build directory→files map for Go package linking (O(1) lookup vs O(n) scan)
        const dirToGoFiles = new Map();
        // Pre-build filename→files map for Java import resolution (O(1) vs O(n) scan)
        const javaFileIndex = new Map();
        for (const [fp, fe] of this.files) {
            if (fe.language === 'go') {
                const dir = path.dirname(fp);
                if (!dirToGoFiles.has(dir)) dirToGoFiles.set(dir, []);
                dirToGoFiles.get(dir).push(fp);
            } else if (fe.language === 'java') {
                const name = path.basename(fp, '.java');
                if (!javaFileIndex.has(name)) javaFileIndex.set(name, []);
                javaFileIndex.get(name).push(fp);
            }
        }

        for (const [filePath, fileEntry] of this.files) {
            const importedFiles = [];
            const seenModules = new Set();

            for (const importModule of fileEntry.imports) {
                // Skip null modules (e.g., dynamic include! macros in Rust)
                if (!importModule) continue;

                // Deduplicate: same module imported multiple times in one file
                // (e.g., lazy imports inside different functions)
                if (seenModules.has(importModule)) continue;
                seenModules.add(importModule);

                let resolved = resolveImport(importModule, filePath, {
                    aliases: this.config.aliases,
                    language: fileEntry.language,
                    root: this.root
                });

                // Java package imports: resolve by progressive suffix matching
                // Handles regular, static (com.pkg.Class.method), and wildcard (com.pkg.Class.*) imports
                if (!resolved && fileEntry.language === 'java' && !importModule.startsWith('.')) {
                    resolved = this._resolveJavaPackageImport(importModule, javaFileIndex);
                }

                if (resolved && this.files.has(resolved)) {
                    // For Go, a package import means all files in that directory are dependencies
                    // (Go packages span multiple files in the same directory)
                    const filesToLink = [resolved];
                    if (fileEntry.language === 'go') {
                        const pkgDir = path.dirname(resolved);
                        const dirFiles = dirToGoFiles.get(pkgDir) || [];
                        const importerIsTest = filePath.endsWith('_test.go');
                        for (const fp of dirFiles) {
                            if (fp !== resolved) {
                                if (!importerIsTest && fp.endsWith('_test.go')) continue;
                                filesToLink.push(fp);
                            }
                        }
                    }

                    for (const linkedFile of filesToLink) {
                        importedFiles.push(linkedFile);
                        if (!this.exportGraph.has(linkedFile)) {
                            this.exportGraph.set(linkedFile, []);
                        }
                        this.exportGraph.get(linkedFile).push(filePath);
                    }
                }
            }

            this.importGraph.set(filePath, importedFiles);
        }
    }

    /**
     * Build inheritance relationship graphs
     */
    buildInheritanceGraph() {
        this.extendsGraph.clear();
        this.extendedByGraph.clear();

        // Collect all class/interface/struct names for alias resolution
        const classNames = new Set();
        for (const [, fileEntry] of this.files) {
            for (const symbol of fileEntry.symbols) {
                if (['class', 'interface', 'struct', 'trait', 'record'].includes(symbol.type)) {
                    classNames.add(symbol.name);
                }
            }
        }

        for (const [filePath, fileEntry] of this.files) {
            for (const symbol of fileEntry.symbols) {
                if (!['class', 'interface', 'struct', 'trait', 'record'].includes(symbol.type)) {
                    continue;
                }

                if (symbol.extends) {
                    // Parse comma-separated parents (Python MRO: "Flyable, Swimmable")
                    const parents = symbol.extends.split(',').map(s => s.trim()).filter(Boolean);

                    // Resolve aliased parent names via import aliases
                    // e.g., const { BaseHandler: Handler } = require('./base')
                    //        class Child extends Handler → resolve Handler to BaseHandler
                    const resolvedParents = parents.map(parent => {
                        if (classNames.has(parent)) return parent;
                        if (fileEntry.importAliases) {
                            const alias = fileEntry.importAliases.find(a => a.local === parent);
                            if (alias && classNames.has(alias.original)) return alias.original;
                        }
                        return parent;
                    });

                    // Store with file scope to avoid collisions when same class name
                    // appears in multiple files (F-002 fix)
                    if (!this.extendsGraph.has(symbol.name)) {
                        this.extendsGraph.set(symbol.name, []);
                    }
                    this.extendsGraph.get(symbol.name).push({
                        file: filePath,
                        parents: resolvedParents
                    });

                    for (const parent of resolvedParents) {
                        if (!this.extendedByGraph.has(parent)) {
                            this.extendedByGraph.set(parent, []);
                        }
                        this.extendedByGraph.get(parent).push({
                            name: symbol.name,
                            type: symbol.type,
                            file: filePath
                        });
                    }
                }
            }
        }
    }

    /**
     * Get inheritance parents for a class, scoped by file to handle
     * duplicate class names across files.
     * @param {string} className - Class name to look up
     * @param {string} contextFile - File path for scoping (prefer same-file match)
     * @returns {string[]|null} Parent class names, or null if none
     */
    _getInheritanceParents(className, contextFile) {
        const entries = this.extendsGraph.get(className);
        if (!entries || entries.length === 0) return null;

        // New format: array of {file, parents}
        if (typeof entries[0] === 'object' && entries[0].file !== undefined) {
            // Prefer same-file match
            const match = entries.find(e => e.file === contextFile);
            if (match) return match.parents;

            // Try imported file
            if (contextFile) {
                const imports = this.importGraph.get(contextFile);
                if (imports) {
                    const imported = entries.find(e => imports.includes(e.file));
                    if (imported) return imported.parents;
                }
            }

            // Fallback to first entry
            return entries[0].parents;
        }

        // Old format (cache compat): plain array of parent names
        return entries;
    }

    /**
     * Resolve which file a class is defined in, preferring contextFile.
     * Used during inheritance BFS to find grandparent chains.
     * @param {string} className - Class name to resolve
     * @param {string} contextFile - Preferred file (e.g., child's file)
     * @returns {string|null} Resolved file path
     */
    _resolveClassFile(className, contextFile) {
        const symbols = this.symbols.get(className);
        if (!symbols) return contextFile;
        const classSymbols = symbols.filter(s =>
            ['class', 'interface', 'struct', 'trait'].includes(s.type));
        if (classSymbols.length === 0) return contextFile;
        // Prefer same file as context
        if (classSymbols.some(s => s.file === contextFile)) return contextFile;
        // Prefer imported
        if (contextFile) {
            const imports = this.importGraph.get(contextFile);
            if (imports) {
                const imported = classSymbols.find(s => imports.includes(s.file));
                if (imported) return imported.file;
            }
        }
        return classSymbols[0].file;
    }


    // ========================================================================
    // QUERY METHODS
    // ========================================================================

    /**
     * Check if a file path matches filter criteria
     * @param {string} filePath - File path to check
     * @param {object} filters - { exclude: string[], in: string }
     * @returns {boolean} True if file passes filters
     */
    matchesFilters(filePath, filters = {}) {
        // Check exclusions (patterns like 'test', 'mock', 'spec')
        // Requires the pattern to be bounded on BOTH sides by path separators (/, ., _, -)
        // or start/end of string, with optional plural 's' suffix.
        // e.g. 'test' matches 'tests/', 'test_foo', '_test.', but NOT 'backtester' or 'contest'
        // e.g. 'spec' matches 'spec/', 'file.spec.js', but NOT 'spectrum' or 'inspector'
        if (filters.exclude && filters.exclude.length > 0) {
            const lowerPath = filePath.toLowerCase();
            for (const pattern of filters.exclude) {
                const lowerPattern = pattern.toLowerCase();
                let regex = this._excludeRegexCache?.get(lowerPattern);
                if (!regex) {
                    const escaped = lowerPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    regex = new RegExp(`(^|[/._\\-])${escaped}s?([/._\\-]|$)`);
                    if (!this._excludeRegexCache) this._excludeRegexCache = new Map();
                    this._excludeRegexCache.set(lowerPattern, regex);
                }
                if (regex.test(lowerPath)) {
                    return false;
                }
            }
        }

        // Check inclusion (directory or file path)
        if (filters.in) {
            const inPattern = filters.in.replace(/\/$/, ''); // strip trailing slash
            // Detect if pattern looks like a file path (has an extension)
            const looksLikeFile = /\.\w+$/.test(inPattern);
            if (looksLikeFile) {
                // File path matching: exact match or suffix match
                // e.g. --in=tools/analyzer.py matches "tools/analyzer.py"
                // e.g. --in=analyzer.py matches "tools/analyzer.py"
                if (!(filePath === inPattern || filePath.endsWith('/' + inPattern))) {
                    return false;
                }
            } else {
                // Directory matching: path-boundary-aware
                // e.g. --in=src matches "src/foo.js" and "lib/src/foo.js" but NOT "my-src-backup/foo.js"
                if (!(filePath.startsWith(inPattern + '/') || filePath.includes('/' + inPattern + '/'))) {
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * Calculate fuzzy match score (higher = better match)
     * Prefers: exact match > prefix match > camelCase match > substring match
     */
    fuzzyScore(query, target) {
        const lowerQuery = query.toLowerCase();
        const lowerTarget = target.toLowerCase();

        // Exact match
        if (target === query) return 1000;
        if (lowerTarget === lowerQuery) return 900;

        // Prefix match (handleReq -> handleRequest)
        if (lowerTarget.startsWith(lowerQuery)) return 800 + (query.length / target.length) * 100;

        // CamelCase match (hR -> handleRequest)
        const camelParts = target.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ');
        const queryParts = query.toLowerCase();
        let camelMatch = true;
        let partIndex = 0;
        for (const char of queryParts) {
            while (partIndex < camelParts.length && !camelParts[partIndex].startsWith(char)) {
                partIndex++;
            }
            if (partIndex >= camelParts.length) {
                camelMatch = false;
                break;
            }
            partIndex++;
        }
        if (camelMatch && query.length >= 2) return 600;

        // Substring match
        if (lowerTarget.includes(lowerQuery)) return 400 + (query.length / target.length) * 100;

        // Word boundary match (parse -> parseFile, fileParse)
        const words = target.split(/(?=[A-Z])|_|-/).map(w => w.toLowerCase());
        if (words.some(w => w.startsWith(lowerQuery))) return 300;

        return 0;
    }

    /**
     * Find symbol by name with disambiguation
     *
     * @param {string} name - Symbol name to find
     * @param {object} options - { file, prefer, exact, exclude, in }
     * @returns {Array} Matching symbols with usage counts
     */

    /**
     * Resolve a symbol name to the best matching definition.
     * Centralized selection logic used by all commands for consistency.
     *
     * Priority order:
     * 1. Filter by --file if specified
     * 2. Prefer class/struct/interface/type over functions/constructors
     * 3. Prefer non-test file definitions over test files
     * 4. Prefer higher usage count
     *
     * @param {string} name - Symbol name
     * @param {object} [options] - { file }
     * @returns {{ def: object|null, definitions: Array, warnings: Array }}
     */
    resolveSymbol(name, options = {}) {
        let definitions = this.symbols.get(name) || [];
        if (definitions.length === 0) {
            return { def: null, definitions: [], warnings: [] };
        }

        // Filter by class name (Class.method syntax)
        if (options.className) {
            const filtered = definitions.filter(d => d.className === options.className);
            if (filtered.length > 0) {
                definitions = filtered;
            }
        }

        // Filter by file if specified
        if (options.file) {
            const filtered = definitions.filter(d =>
                d.relativePath && d.relativePath.includes(options.file)
            );
            if (filtered.length > 0) {
                definitions = filtered;
            }
        }

        // Score each definition for selection
        const typeOrder = new Set(['class', 'struct', 'interface', 'type', 'impl']);
        const scored = definitions.map(d => {
            let score = 0;
            const rp = d.relativePath || '';
            // Prefer class/struct/interface types (+1000)
            if (typeOrder.has(d.type)) score += 1000;
            // Deprioritize test files (-500)
            if (isTestFile(rp, detectLanguage(d.file))) {
                score -= 500;
            }
            // Deprioritize examples/docs/vendor directories (-300)
            if (/^(examples?|docs?|vendor|third[_-]?party|benchmarks?|samples?)\//i.test(rp)) {
                score -= 300;
            }
            // Boost lib/src/core/internal directories (+200)
            if (/^(lib|src|core|internal|pkg|crates)\//i.test(rp)) {
                score += 200;
            }
            return { def: d, score };
        });

        // Sort by score descending, then by index order for stability
        scored.sort((a, b) => b.score - a.score);

        // Tiebreaker: when top candidates have equal score, prefer by import popularity
        // (how many files import the candidate's file), then by usage count
        if (scored.length > 1 && scored[0].score === scored[1].score) {
            const tiedScore = scored[0].score;
            const tiedCandidates = scored.filter(s => s.score === tiedScore);

            // Count how many files import each candidate's file (import popularity)
            // For Go, count importers of any file in the same directory (same package)
            for (const candidate of tiedCandidates) {
                let importerCount = 0;
                for (const [, importedFiles] of this.importGraph) {
                    if (importedFiles.includes(candidate.def.file)) {
                        importerCount++;
                    }
                }
                // For Go, also count importers of sibling files (same package)
                const candidateEntry = this.files.get(candidate.def.file);
                if (candidateEntry?.language === 'go') {
                    const candidateDir = path.dirname(candidate.def.file);
                    for (const [, importedFiles] of this.importGraph) {
                        for (const imp of importedFiles) {
                            if (imp !== candidate.def.file && path.dirname(imp) === candidateDir) {
                                importerCount++;
                                break; // count each importer once
                            }
                        }
                    }
                }
                candidate.importerCount = importerCount;
            }
            // Sort by import popularity (cheap — no file reads needed)
            // Skip usage count (expensive) — import popularity is a strong enough signal
            tiedCandidates.sort((a, b) => b.importerCount - a.importerCount);
            // Rebuild scored array: sorted tied candidates first, then rest
            const rest = scored.filter(s => s.score !== tiedScore);
            scored.length = 0;
            scored.push(...tiedCandidates, ...rest);
        }

        const def = scored[0].def;

        // Build warnings
        const warnings = [];
        if (definitions.length > 1) {
            warnings.push({
                type: 'ambiguous',
                message: `Found ${definitions.length} definitions for "${name}". Using ${def.relativePath}:${def.startLine}. Also in: ${definitions.filter(d => d !== def).map(d => `${d.relativePath}:${d.startLine}`).join(', ')}. Specify a file to disambiguate.`,
                alternatives: definitions.filter(d => d !== def).map(d => ({
                    file: d.relativePath,
                    line: d.startLine
                }))
            });
        }

        return { def, definitions, warnings };
    }

    find(name, options = {}) {
        this._beginOp();
        try {
        // Glob pattern matching (e.g., _update*, handle*Request, get?ata)
        const isGlob = name.includes('*') || name.includes('?');
        if (isGlob && !options.exact) {
            // Bare wildcard: return all symbols
            const stripped = name.replace(/[*?]/g, '');
            if (stripped.length === 0) {
                const all = [];
                for (const [, symbols] of this.symbols) {
                    for (const sym of symbols) {
                        all.push({ ...sym, _fuzzyScore: 800 });
                    }
                }
                all.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
                return this._applyFindFilters(all, options);
            }
            const globRegex = new RegExp('^' + name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
            const matches = [];
            for (const [symName, symbols] of this.symbols) {
                if (globRegex.test(symName)) {
                    for (const sym of symbols) {
                        matches.push({ ...sym, _fuzzyScore: 800 });
                    }
                }
            }
            matches.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            return this._applyFindFilters(matches, options);
        }

        const matches = this.symbols.get(name) || [];

        if (matches.length === 0 && !options.exact) {
            // Smart fuzzy search with scoring
            const candidates = [];
            for (const [symName, symbols] of this.symbols) {
                const score = this.fuzzyScore(name, symName);
                if (score > 0) {
                    for (const sym of symbols) {
                        candidates.push({ ...sym, _fuzzyScore: score });
                    }
                }
            }
            // Sort by fuzzy score descending
            candidates.sort((a, b) => b._fuzzyScore - a._fuzzyScore);
            matches.push(...candidates);
        }

        return this._applyFindFilters(matches, options);
        } finally { this._endOp(); }
    }

    /**
     * Apply file/exclude/in filters and usage counts to find results
     */
    _applyFindFilters(matches, options) {
        let filtered = matches;

        // Filter by class name (Class.method syntax)
        if (options.className) {
            filtered = filtered.filter(m => m.className === options.className);
        }

        // Filter by file pattern
        if (options.file) {
            filtered = filtered.filter(m =>
                m.relativePath && m.relativePath.includes(options.file)
            );
        }

        // Apply semantic filters (--exclude, --in)
        if (options.exclude || options.in) {
            filtered = filtered.filter(m =>
                this.matchesFilters(m.relativePath, { exclude: options.exclude, in: options.in })
            );
        }

        // Skip expensive usage counting when caller doesn't need it
        if (options.skipCounts) {
            return filtered;
        }

        // Add per-symbol usage counts for disambiguation
        const withCounts = filtered.map(m => {
            const counts = this.countSymbolUsages(m);
            return {
                ...m,
                usageCount: counts.total,
                usageCounts: counts  // { total, calls, definitions, imports, references }
            };
        });

        // Sort by usage count (most-used first)
        withCounts.sort((a, b) => b.usageCount - a.usageCount);

        return withCounts;
    }


    /**
     * Count usages of a specific symbol (not just by name)
     * Only counts usages in files that could reference this specific definition
     * @param {object} symbol - Symbol with file, name, etc.
     * @returns {object} { total, calls, definitions, imports, references }
     */
    countSymbolUsages(symbol, options = {}) {
        const name = symbol.name;
        const defFile = symbol.file;

        // Fast path: use callee index + import graph for counting (no file reads)
        // This is an approximation — counts files containing calls, not individual call sites.
        // Use options.detailed = true for exact per-call-site counting via AST.
        if (!options.detailed) {
            // Ensure callee index is built (lazy, reused across operations)
            if (!this.calleeIndex) this.buildCalleeIndex();
            const hasFilters = options.exclude && options.exclude.length > 0;

            // Count calls from callee index (files containing calls to this name)
            const calleeFiles = this.calleeIndex.get(name);
            let calls = 0;
            if (calleeFiles) {
                // Count actual call entries from calls cache for accuracy
                const { getCachedCalls } = require('./callers');
                for (const fp of calleeFiles) {
                    // Apply exclude filters
                    if (hasFilters) {
                        const fe = this.files.get(fp);
                        if (fe && !this.matchesFilters(fe.relativePath, { exclude: options.exclude })) continue;
                    }
                    const fileCalls = getCachedCalls(this, fp);
                    if (!fileCalls) continue;
                    for (const c of fileCalls) {
                        if (c.name === name || c.resolvedName === name ||
                            (c.resolvedNames && c.resolvedNames.includes(name))) {
                            calls++;
                        }
                    }
                }
            }

            // Count definitions from symbol table
            const defs = this.symbols.get(name) || [];
            let definitions = defs.length;
            if (hasFilters) {
                definitions = defs.filter(d =>
                    this.matchesFilters(d.relativePath, { exclude: options.exclude })
                ).length;
            }

            // Count imports from import graph (files that import from defFile and use this name)
            let imports = 0;
            const importers = this.exportGraph.get(defFile) || [];
            for (const importer of importers) {
                const fe = this.files.get(importer);
                if (!fe) continue;
                if (hasFilters && !this.matchesFilters(fe.relativePath, { exclude: options.exclude })) continue;
                // Check if this file's importNames reference our symbol
                if (fe.importNames && fe.importNames.includes(name)) {
                    imports++;
                }
            }

            const total = calls + definitions + imports;
            return { total, calls, definitions, imports, references: 0 };
        }

        // Detailed path: full AST-based counting (original algorithm)
        // Note: no 'g' flag - we only need to test for presence per line
        const regex = new RegExp('\\b' + escapeRegExp(name) + '\\b');

        // Get files that could reference this symbol:
        // 1. The file where it's defined
        // 2. Files that import from the definition file
        // 3. Transitively: files that import from re-exporters of this symbol
        // 4. Go: all files in the same package directory (same-package references need no import)
        const relevantFiles = new Set([defFile]);
        const queue = [defFile];

        // Go same-package: add all .go files in the same directory
        const defEntry = this.files.get(defFile);
        if (defEntry?.language === 'go') {
            const pkgDir = path.dirname(defFile);
            for (const fp of this.files.keys()) {
                if (fp !== defFile && fp.endsWith('.go') && path.dirname(fp) === pkgDir) {
                    relevantFiles.add(fp);
                }
            }
        }

        while (queue.length > 0) {
            const file = queue.pop();
            const importersArr = this.exportGraph.get(file) || [];
            for (const importer of importersArr) {
                if (!relevantFiles.has(importer)) {
                    relevantFiles.add(importer);
                    // If this importer re-exports the symbol, follow its importers too
                    const importerEntry = this.files.get(importer);
                    if (importerEntry && importerEntry.exports && importerEntry.exports.includes(name)) {
                        queue.push(importer);
                    }
                }
            }
        }

        // For methods (symbols with className), objects can be passed as parameters
        // to files with no import relationship to the definition file.
        // Expand to all project files that mention the name (fast text pre-check).
        if (symbol.className) {
            for (const filePath of this.files.keys()) {
                if (relevantFiles.has(filePath)) continue;
                try {
                    const content = this._readFile(filePath);
                    if (content.includes(name)) {
                        relevantFiles.add(filePath);
                    }
                } catch (e) { /* skip unreadable */ }
            }
        }

        let calls = 0;
        let definitions = 0;
        let imports = 0;
        let references = 0;

        const hasExclude = options.exclude && options.exclude.length > 0;
        for (const filePath of relevantFiles) {
            const fileEntry = this.files.get(filePath);
            if (!fileEntry) continue;
            // Apply exclude filters (e.g., test file exclusion)
            if (hasExclude && !this.matchesFilters(fileEntry.relativePath, { exclude: options.exclude })) continue;

            try {
                // Try AST-based counting first (with per-operation cache)
                const astUsages = this._getCachedUsages(filePath, name);
                if (astUsages !== null) {
                    // Deduplicate same-line same-type entries (e.g., `name: obj.name` has two AST nodes)
                    const seen = new Set();
                    for (const u of astUsages) {
                        const key = `${filePath}:${u.line}:${u.usageType}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        switch (u.usageType) {
                            case 'call': calls++; break;
                            case 'definition': definitions++; break;
                            case 'import': imports++; break;
                            default: references++; break;
                        }
                    }
                    continue; // Skip to next file
                }

                // Fallback: count regex matches as references (unsupported language)
                const content = this._readFile(filePath);
                const lines = content.split('\n');
                lines.forEach((line) => {
                    if (regex.test(line)) {
                        references++;
                    }
                });
            } catch (e) {
                // Skip unreadable files
            }
        }

        return {
            total: calls + definitions + imports + references,
            calls,
            definitions,
            imports,
            references
        };
    }

    /**
     * Find all usages of a symbol grouped by type
     *
     * @param {string} name - Symbol name
     * @param {object} options - { codeOnly, context, exclude, in }
     * @returns {Array} Usages grouped as definitions, calls, imports, references
     */
    usages(name, options = {}) {
        this._beginOp();
        try {
        const usages = [];

        // Get definitions (filtered)
        let allDefinitions = this.symbols.get(name) || [];
        if (options.className) {
            allDefinitions = allDefinitions.filter(d => d.className === options.className);
        }
        const definitions = options.exclude || options.in
            ? allDefinitions.filter(d => this.matchesFilters(d.relativePath, options))
            : allDefinitions;

        for (const def of definitions) {
            usages.push({
                ...def,
                isDefinition: true,
                line: def.startLine,
                content: this.getLineContent(def.file, def.startLine),
                signature: this.formatSignature(def)
            });
        }

        // Scan all files for usages
        for (const [filePath, fileEntry] of this.files) {
            // Apply filters
            if (!this.matchesFilters(fileEntry.relativePath, options)) {
                continue;
            }

            try {
                const content = this._readFile(filePath);

                // Fast pre-check: skip if name doesn't appear in file at all
                if (!content.includes(name)) continue;

                const lines = content.split('\n');

                // Try AST-based detection first (with per-operation cache)
                const astUsages = this._getCachedUsages(filePath, name);
                if (astUsages !== null) {
                    // Pre-compute: does any imported project file define this name?
                    // Used to filter namespace member expressions (e.g., DropdownMenuPrimitive.Separator)
                    // while keeping module access patterns (e.g., output.formatExample())
                    let _importedHasDef = null;
                    const importedFileHasDef = () => {
                        if (_importedHasDef !== null) return _importedHasDef;
                        const importedFiles = this.importGraph.get(filePath) || [];
                        _importedHasDef = importedFiles.some(imp => {
                            const impEntry = this.files.get(imp);
                            return impEntry?.symbols?.some(s => s.name === name);
                        });
                        return _importedHasDef;
                    };

                    for (const u of astUsages) {
                        // Skip if this is a definition line (already added above)
                        if (definitions.some(d => d.file === filePath && d.startLine === u.line)) {
                            continue;
                        }

                        // Filter member expressions with unrelated receivers in JS/TS/Python.
                        // Keeps: standalone usages, self/this/cls/super, method calls on known types,
                        //        and module access (output.fn()) when the imported file defines the name.
                        // Filters: namespace access to external packages (DropdownMenuPrimitive.Separator).
                        if (u.receiver && !['self', 'this', 'cls', 'super'].includes(u.receiver) &&
                            fileEntry.language !== 'go' && fileEntry.language !== 'java' && fileEntry.language !== 'rust') {
                            const hasMethodDef = definitions.some(d => d.className);
                            if (!hasMethodDef && !importedFileHasDef()) {
                                continue;
                            }
                        }

                        const lineContent = lines[u.line - 1] || '';

                        const usage = {
                            file: filePath,
                            relativePath: fileEntry.relativePath,
                            line: u.line,
                            content: lineContent,
                            usageType: u.usageType,
                            isDefinition: false,
                            ...(u.receiver && { receiver: u.receiver })
                        };

                        // Add context lines if requested
                        if (options.context && options.context > 0) {
                            const idx = u.line - 1;
                            const before = [];
                            const after = [];
                            for (let i = 1; i <= options.context; i++) {
                                if (idx - i >= 0) before.unshift(lines[idx - i]);
                                if (idx + i < lines.length) after.push(lines[idx + i]);
                            }
                            usage.before = before;
                            usage.after = after;
                        }

                        usages.push(usage);
                    }
                    continue; // Skip to next file
                }

                // Fallback to regex-based detection
                const regex = new RegExp('\\b' + escapeRegExp(name) + '\\b');
                lines.forEach((line, idx) => {
                    const lineNum = idx + 1;

                    // Skip if this is a definition line
                    if (definitions.some(d => d.file === filePath && d.startLine === lineNum)) {
                        return;
                    }

                    if (regex.test(line)) {
                        // Skip if codeOnly and line is comment/string
                        if (options.codeOnly && this.isCommentOrStringAtPosition(content, lineNum, 0, filePath)) {
                            return;
                        }

                        // Skip if the match is inside a string literal
                        if (this.isInsideStringAST(content, lineNum, line, name, filePath)) {
                            return;
                        }

                        // Classify usage type (AST-based, defaults to 'reference' for unsupported languages)
                        const usageType = this.classifyUsageAST(content, lineNum, name, filePath) ?? 'reference';

                        const usage = {
                            file: filePath,
                            relativePath: fileEntry.relativePath,
                            line: lineNum,
                            content: line,
                            usageType,
                            isDefinition: false
                        };

                        // Add context lines if requested
                        if (options.context && options.context > 0) {
                            const before = [];
                            const after = [];
                            for (let i = 1; i <= options.context; i++) {
                                if (idx - i >= 0) before.unshift(lines[idx - i]);
                                if (idx + i < lines.length) after.push(lines[idx + i]);
                            }
                            usage.before = before;
                            usage.after = after;
                        }

                        usages.push(usage);
                    }
                });
            } catch (e) {
                // Skip unreadable files
            }
        }

        // Deduplicate same-file, same-line, same-usageType entries
        // (e.g., `detectLanguage: parser.detectLanguage` has the name twice on one line)
        const seen = new Set();
        const deduped = [];
        for (const u of usages) {
            const key = `${u.file}:${u.line}:${u.usageType}:${u.isDefinition}`;
            if (!seen.has(key)) {
                seen.add(key);
                deduped.push(u);
            }
        }
        return deduped;
        } finally { this._endOp(); }
    }

    /**
     * Find methods that belong to a class/struct/type
     * Works for:
     * - Go: methods with receiver field (e.g., receiver: "*TypeName")
     * - Python/Java: methods with className field
     * - Rust: impl methods with receiver field
     * @param {string} typeName - The class/struct/interface name
     * @returns {Array} Methods belonging to this type
     */
    findMethodsForType(typeName) {
        const methods = [];
        // Match both "TypeName" and "*TypeName" receivers (for Go/Rust pointer receivers)
        const baseTypeName = typeName.replace(/^\*/, '');

        for (const [name, symbols] of this.symbols) {
            for (const symbol of symbols) {
                // Skip non-method types (fields, properties, etc.)
                if (symbol.type === 'field' || symbol.type === 'property') {
                    continue;
                }

                // Check Go/Rust-style receiver (e.g., func (r *Router) Method())
                // Also matches Rust associated functions (have receiver but isMethod=false)
                if (symbol.receiver) {
                    const receiverBase = symbol.receiver.replace(/^\*/, '');
                    if (receiverBase === baseTypeName) {
                        methods.push(symbol);
                        continue;
                    }
                }

                // Check Python/Java/JS-style className (class members)
                // Must be a method type, not just any symbol with className
                if (symbol.className === baseTypeName &&
                    (symbol.isMethod || symbol.type === 'method' || symbol.type === 'constructor')) {
                    methods.push(symbol);
                    continue;
                }
            }
        }

        // Sort by file then line
        methods.sort((a, b) => {
            if (a.relativePath !== b.relativePath) return a.relativePath.localeCompare(b.relativePath);
            return a.startLine - b.startLine;
        });

        return methods;
    }

    /**
     * Get context for a symbol (callers + callees)
     */
    context(name, options = {}) {
        this._beginOp();
        try {
        const resolved = this.resolveSymbol(name, { file: options.file, className: options.className });
        let { def, definitions, warnings } = resolved;
        if (!def) {
            return null;
        }

        // Special handling for class/struct/interface types
        if (['class', 'struct', 'interface', 'type'].includes(def.type)) {
            const methods = this.findMethodsForType(name);

            let typeCallers = this.findCallers(name, { includeMethods: options.includeMethods, includeUncertain: options.includeUncertain });
            // Apply exclude filter
            if (options.exclude && options.exclude.length > 0) {
                typeCallers = typeCallers.filter(c => this.matchesFilters(c.relativePath, { exclude: options.exclude }));
            }

            const result = {
                type: def.type,
                name: name,
                file: def.relativePath,
                startLine: def.startLine,
                endLine: def.endLine,
                methods: methods.map(m => ({
                    name: m.name,
                    file: m.relativePath,
                    line: m.startLine,
                    params: m.params,
                    returnType: m.returnType,
                    receiver: m.receiver
                })),
                // Also include places where the type is used in function parameters/returns
                callers: typeCallers
            };

            if (warnings.length > 0) {
                result.warnings = warnings;
            }

            return result;
        }

        const stats = { uncertain: 0 };
        let callers = this.findCallers(name, { includeMethods: options.includeMethods, includeUncertain: options.includeUncertain, stats, targetDefinitions: [def] });
        let callees = this.findCallees(def, { includeMethods: options.includeMethods, includeUncertain: options.includeUncertain, stats });

        // Apply exclude filter
        if (options.exclude && options.exclude.length > 0) {
            callers = callers.filter(c => this.matchesFilters(c.relativePath, { exclude: options.exclude }));
            callees = callees.filter(c => this.matchesFilters(c.relativePath, { exclude: options.exclude }));
        }

        // Apply confidence filtering
        let confidenceFiltered = 0;
        if (options.minConfidence > 0) {
            const { filterByConfidence } = require('./confidence');
            const callerResult = filterByConfidence(callers, options.minConfidence);
            const calleeResult = filterByConfidence(callees, options.minConfidence);
            callers = callerResult.kept;
            callees = calleeResult.kept;
            confidenceFiltered = callerResult.filtered + calleeResult.filtered;
        }

        const filesInScope = new Set([def.file]);
        callers.forEach(c => filesInScope.add(c.file));
        callees.forEach(c => filesInScope.add(c.file));
        let dynamicImports = 0;
        for (const f of filesInScope) {
            const fe = this.files.get(f);
            if (fe?.dynamicImports) dynamicImports += fe.dynamicImports;
        }

        const result = {
            function: name,
            file: def.relativePath,
            startLine: def.startLine,
            endLine: def.endLine,
            params: def.params,
            returnType: def.returnType,
            callers,
            callees,
            meta: {
                complete: stats.uncertain === 0 && dynamicImports === 0 && confidenceFiltered === 0,
                skipped: 0,
                dynamicImports,
                uncertain: stats.uncertain,
                confidenceFiltered,
                includeMethods: !!options.includeMethods,
                projectLanguage: this._getPredominantLanguage(),
                // Structural facts for reliability hints
                ...(def.isMethod && { isMethod: true }),
                ...(def.className && { className: def.className }),
                ...(def.receiver && { receiver: def.receiver })
            }
        };

        if (warnings.length > 0) {
            result.warnings = warnings;
        }

        return result;
        } finally { this._endOp(); }
    }

    /** Get cached call sites for a file, with mtime/hash validation */
    getCachedCalls(filePath, options) { return callersModule.getCachedCalls(this, filePath, options); }

    /** Find all callers of a function using AST-based detection */
    findCallers(name, options) { return callersModule.findCallers(this, name, options); }

    /**
     * Check if a name appears inside a string literal using AST
     * @param {string} content - Full file content
     * @param {number} lineNum - 1-indexed line number
     * @param {string} line - Line content
     * @param {string} name - Name to check
     * @param {string} filePath - File path for language detection
     * @returns {boolean} true if ALL occurrences of name are inside strings
     */
    isInsideStringAST(content, lineNum, line, name, filePath) {
        const language = detectLanguage(filePath);
        if (!language) {
            return false; // Unsupported language - assume not inside string
        }

        try {
            const parser = getParser(language);
            if (!parser) {
                return false;
            }

            const tree = safeParse(parser, content);
            if (!tree) return false;

            // Find all occurrences of name in the line
            const nameRegex = new RegExp('(?<![a-zA-Z0-9_$])' + escapeRegExp(name) + '(?![a-zA-Z0-9_$])', 'g');
            let match;

            while ((match = nameRegex.exec(line)) !== null) {
                const column = match.index;
                const tokenType = getTokenTypeAtPosition(tree.rootNode, lineNum, column);

                // If this occurrence is NOT in a string, the name appears in code
                if (tokenType !== 'string') {
                    return false;
                }
            }

            // All occurrences were inside strings (or no occurrences found)
            return true;
        } catch (e) {
            return false; // On error, assume not inside string
        }
    }

    /** Find all functions called by a function using AST-based detection */
    findCallees(def, options) { return callersModule.findCallees(this, def, options); }

    /**
     * Calculate dependency weight based on usage
     */
    calculateWeight(callCount) {
        if (callCount >= 10) return 'core';
        if (callCount >= 3) return 'regular';
        if (callCount === 1) return 'utility';
        return 'normal';
    }

    /**
     * Smart extraction: function + dependencies
     */
    smart(name, options = {}) {
        this._beginOp();
        try {
        const { def } = this.resolveSymbol(name, { file: options.file, className: options.className });
        if (!def) {
            return null;
        }
        const code = this.extractCode(def);
        const stats = { uncertain: 0 };
        const callees = this.findCallees(def, { includeMethods: options.includeMethods, includeUncertain: options.includeUncertain, stats });

        const filesInScope = new Set([def.file]);
        callees.forEach(c => filesInScope.add(c.file));
        let dynamicImports = 0;
        for (const f of filesInScope) {
            const fe = this.files.get(f);
            if (fe?.dynamicImports) dynamicImports += fe.dynamicImports;
        }

        // Extract code for each dependency, excluding the exact same function
        // (but keeping same-name overloads, e.g. Java toJson(Object) vs toJson(Object, Class))
        const defBindingId = def.bindingId;
        const dependencies = callees
            .filter(callee => callee.bindingId !== defBindingId)
            .map(callee => ({
                ...callee,
                code: this.extractCode(callee)
            }));

        // Find type definitions if requested
        const types = [];
        if (options.withTypes) {
            // Look for type annotations in params/return type
            const typeNames = this.extractTypeNames(def);
            for (const typeName of typeNames) {
                const typeSymbols = this.symbols.get(typeName);
                if (typeSymbols) {
                    for (const sym of typeSymbols) {
                        if (['type', 'interface', 'class', 'struct'].includes(sym.type)) {
                            types.push({
                                ...sym,
                                code: this.extractCode(sym)
                            });
                        }
                    }
                }
            }
        }

        return {
            target: {
                ...def,
                code
            },
            dependencies,
            types,
            meta: {
                complete: stats.uncertain === 0 && dynamicImports === 0,
                skipped: 0,
                dynamicImports,
                uncertain: stats.uncertain,
                projectLanguage: this._getPredominantLanguage()
            }
        };
        } finally { this._endOp(); }
    }

    // ========================================================================
    // HELPER METHODS
    // ========================================================================

    /**
     * Get the predominant language of the project (cached).
     * Returns 'go', 'javascript', etc. if >80% of files are that language.
     */
    _getPredominantLanguage() {
        if (this._predominantLang !== undefined) return this._predominantLang;
        const counts = {};
        for (const [, fe] of this.files) {
            counts[fe.language] = (counts[fe.language] || 0) + 1;
        }
        const total = this.files.size;
        for (const [lang, count] of Object.entries(counts)) {
            if (count / total > 0.8) {
                this._predominantLang = lang;
                return lang;
            }
        }
        this._predominantLang = null;
        return null;
    }

    /**
     * Get line content from a file
     */
    getLineContent(filePath, lineNum) {
        try {
            const content = this._readFile(filePath);
            const lines = content.split('\n');
            return lines[lineNum - 1] || '';
        } catch (e) {
            return '';
        }
    }

    /**
     * Extract code for a symbol
     */
    extractCode(symbol) {
        try {
            const content = this._readFile(symbol.file);
            const lines = content.split('\n');
            const extracted = lines.slice(symbol.startLine - 1, symbol.endLine);
            cleanHtmlScriptTags(extracted, detectLanguage(symbol.file));
            return extracted.join('\n');
        } catch (e) {
            // Expected: file may have been deleted or become unreadable since indexing.
            // Return empty string rather than crashing.
            return '';
        }
    }

    /**
     * Format a signature for display
     */
    formatSignature(def) {
        const parts = [];
        if (def.modifiers && def.modifiers.length) {
            parts.push(def.modifiers.join(' '));
        }
        parts.push(def.name);
        if (def.params !== undefined) {
            parts.push(`(${def.params})`);
        }
        if (def.returnType) {
            parts.push(`: ${def.returnType}`);
        }
        return parts.join(' ');
    }

    /**
     * Classify a usage as call, import, definition, or reference using AST
     * @param {string} content - File content
     * @param {number} lineNum - 1-indexed line number
     * @param {string} name - Symbol name
     * @param {string} filePath - File path for language detection
     * @returns {string} 'call', 'import', 'definition', or 'reference'
     */
    classifyUsageAST(content, lineNum, name, filePath) {
        const language = detectLanguage(filePath);
        if (!language) {
            return null; // Signal to use fallback
        }

        const langModule = getLanguageModule(language);
        if (!langModule || typeof langModule.findUsagesInCode !== 'function') {
            return null;
        }

        try {
            const parser = getParser(language);
            if (!parser) {
                return null;
            }

            const usages = langModule.findUsagesInCode(content, name, parser);

            // Find usage at this line
            const usage = usages.find(u => u.line === lineNum);
            if (usage) {
                return usage.usageType;
            }

            return 'reference'; // Default if not found
        } catch (e) {
            return null;
        }
    }

    /**
     * Check if a position in code is inside a comment or string using AST
     * @param {string} content - File content
     * @param {number} lineNum - 1-indexed line number
     * @param {number} column - 0-indexed column
     * @param {string} filePath - File path (for language detection)
     * @returns {boolean}
     */
    isCommentOrStringAtPosition(content, lineNum, column, filePath) {
        const language = detectLanguage(filePath);
        if (!language) {
            return false; // Can't determine, assume code
        }

        try {
            const parser = getParser(language);
            if (!parser) {
                return false;
            }

            const tree = safeParse(parser, content);
            if (!tree) return false;
            const tokenType = getTokenTypeAtPosition(tree.rootNode, lineNum, column);
            return tokenType === 'comment' || tokenType === 'string';
        } catch (e) {
            return false; // On error, assume code
        }
    }

    /**
     * Check if a name is a language keyword
     */
    isKeyword(name, language) {
        if (!LANGUAGE_KEYWORDS) {
            // Initialize on first use — includes both keywords AND builtins
            // to prevent cross-language false positives (e.g. Python set() → JS bundle)
            LANGUAGE_KEYWORDS = {
                javascript: new Set([
                    // Keywords
                    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
                    'continue', 'return', 'function', 'class', 'const', 'let', 'var',
                    'new', 'this', 'super', 'import', 'export', 'default', 'from',
                    'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
                    'typeof', 'instanceof', 'in', 'of', 'delete', 'void', 'with',
                    // Global builtins
                    'undefined', 'NaN', 'Infinity', 'globalThis',
                    'parseInt', 'parseFloat', 'isNaN', 'isFinite',
                    'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
                    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
                    'console', 'JSON', 'Math', 'Date', 'RegExp',
                    'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
                    'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
                    'Promise', 'Proxy', 'Reflect',
                    'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
                    'URIError', 'EvalError', 'AggregateError',
                    'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
                    'Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array',
                    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
                    'BigInt64Array', 'BigUint64Array',
                    'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams',
                    'fetch', 'Request', 'Response', 'Headers',
                    'atob', 'btoa', 'structuredClone', 'queueMicrotask',
                    'require'
                ]),
                python: new Set([
                    // Keywords
                    'if', 'else', 'elif', 'for', 'while', 'def', 'class', 'return',
                    'import', 'from', 'try', 'except', 'finally', 'raise', 'async',
                    'await', 'yield', 'with', 'as', 'lambda', 'pass', 'break',
                    'continue', 'del', 'global', 'nonlocal', 'assert', 'is', 'not',
                    'and', 'or', 'in', 'True', 'False', 'None', 'self', 'cls',
                    // Type constructors
                    'int', 'float', 'str', 'bool', 'list', 'dict', 'set', 'tuple',
                    'bytes', 'bytearray', 'frozenset', 'complex', 'memoryview',
                    'object', 'type',
                    // Common builtins
                    'print', 'len', 'range', 'abs', 'round', 'min', 'max', 'sum',
                    'sorted', 'reversed', 'enumerate', 'zip', 'map', 'filter',
                    'any', 'all', 'iter', 'next', 'hash', 'id', 'repr', 'format',
                    'chr', 'ord', 'hex', 'oct', 'bin', 'pow', 'divmod',
                    'input', 'open', 'super',
                    // Introspection
                    'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr',
                    'delattr', 'callable', 'dir', 'vars', 'globals', 'locals', 'help',
                    // Decorators / descriptors
                    'property', 'staticmethod', 'classmethod',
                    // Exception types
                    'Exception', 'BaseException', 'ValueError', 'TypeError',
                    'KeyError', 'IndexError', 'AttributeError', 'RuntimeError',
                    'NotImplementedError', 'StopIteration', 'StopAsyncIteration',
                    'GeneratorExit', 'OSError', 'IOError', 'FileNotFoundError',
                    'FileExistsError', 'PermissionError', 'IsADirectoryError',
                    'ImportError', 'ModuleNotFoundError', 'NameError',
                    'UnboundLocalError', 'ZeroDivisionError', 'OverflowError',
                    'FloatingPointError', 'ArithmeticError', 'LookupError',
                    'RecursionError', 'MemoryError', 'SystemExit',
                    'KeyboardInterrupt', 'AssertionError',
                    'UnicodeError', 'UnicodeDecodeError', 'UnicodeEncodeError',
                    'Warning', 'DeprecationWarning', 'FutureWarning',
                    'UserWarning', 'SyntaxWarning', 'RuntimeWarning',
                    'ConnectionError', 'TimeoutError', 'BrokenPipeError',
                    // Other builtins
                    'NotImplemented', 'Ellipsis', '__import__', '__name__',
                    '__file__', '__doc__', '__all__', '__init__', '__new__',
                    '__del__', '__repr__', '__str__', '__len__', '__iter__'
                ]),
                go: new Set([
                    // Keywords
                    'if', 'else', 'for', 'switch', 'case', 'break', 'continue',
                    'return', 'func', 'type', 'struct', 'interface', 'package',
                    'import', 'go', 'defer', 'select', 'chan', 'map', 'range',
                    'fallthrough', 'goto', 'var', 'const', 'default',
                    // Builtins
                    'append', 'cap', 'close', 'copy', 'delete', 'len', 'make',
                    'new', 'panic', 'recover', 'print', 'println', 'complex',
                    'real', 'imag', 'clear', 'min', 'max',
                    // Builtin types (prevent cross-language matches)
                    'error', 'string', 'bool', 'byte', 'rune',
                    'int', 'int8', 'int16', 'int32', 'int64',
                    'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
                    'float32', 'float64', 'complex64', 'complex128',
                    'nil', 'true', 'false', 'iota'
                ]),
                rust: new Set([
                    // Keywords
                    'if', 'else', 'for', 'while', 'loop', 'fn', 'impl', 'pub',
                    'mod', 'use', 'crate', 'self', 'super', 'match', 'unsafe',
                    'move', 'ref', 'mut', 'where', 'let', 'const', 'struct',
                    'enum', 'trait', 'async', 'await', 'return', 'break',
                    'continue', 'type', 'as', 'in', 'dyn', 'static',
                    // Macros (common calls that aren't project functions)
                    'println', 'print', 'eprintln', 'eprint', 'format',
                    'vec', 'panic', 'assert', 'assert_eq', 'assert_ne',
                    'debug_assert', 'debug_assert_eq', 'debug_assert_ne',
                    'todo', 'unimplemented', 'unreachable',
                    'cfg', 'derive', 'include', 'include_str', 'include_bytes',
                    'env', 'concat', 'stringify', 'file', 'line', 'column',
                    // Std prelude types/traits
                    'Some', 'None', 'Ok', 'Err', 'Box', 'Vec', 'String',
                    'Option', 'Result', 'Clone', 'Copy', 'Drop',
                    'Default', 'Debug', 'Display', 'Iterator',
                    'From', 'Into', 'TryFrom', 'TryInto',
                    'AsRef', 'AsMut', 'Deref', 'DerefMut',
                    'Send', 'Sync', 'Sized', 'Unpin',
                    'Fn', 'FnMut', 'FnOnce',
                    'PartialEq', 'Eq', 'PartialOrd', 'Ord', 'Hash'
                ]),
                java: new Set([
                    // Keywords
                    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
                    'continue', 'return', 'class', 'interface', 'enum', 'extends',
                    'implements', 'new', 'this', 'super', 'import', 'package',
                    'try', 'catch', 'finally', 'throw', 'throws', 'abstract',
                    'static', 'final', 'synchronized', 'volatile', 'transient',
                    'native', 'void', 'instanceof', 'default',
                    // Primitive types
                    'boolean', 'byte', 'char', 'short', 'int', 'long',
                    'float', 'double', 'null', 'true', 'false',
                    // java.lang builtins (auto-imported)
                    'System', 'String', 'Object', 'Class', 'Integer', 'Long',
                    'Double', 'Float', 'Boolean', 'Character', 'Byte', 'Short',
                    'Math', 'StringBuilder', 'StringBuffer',
                    'Thread', 'Runnable', 'Throwable',
                    'Exception', 'RuntimeException', 'Error',
                    'NullPointerException', 'IllegalArgumentException',
                    'IllegalStateException', 'IndexOutOfBoundsException',
                    'ClassCastException', 'UnsupportedOperationException',
                    'ArithmeticException', 'SecurityException',
                    'StackOverflowError', 'OutOfMemoryError',
                    'Override', 'Deprecated', 'SuppressWarnings',
                    'FunctionalInterface', 'SafeVarargs',
                    'Iterable', 'Comparable', 'AutoCloseable', 'Cloneable',
                    'Enum', 'Record', 'Void'
                ])
            };
            // TypeScript/TSX share JavaScript keywords
            LANGUAGE_KEYWORDS.typescript = LANGUAGE_KEYWORDS.javascript;
            LANGUAGE_KEYWORDS.tsx = LANGUAGE_KEYWORDS.javascript;
        }

        const keywords = LANGUAGE_KEYWORDS[language];
        return keywords ? keywords.has(name) : false;
    }

    /**
     * Find the enclosing function at a line
     * @param {string} filePath - File path
     * @param {number} lineNum - Line number
     * @param {boolean} returnSymbol - If true, return full symbol info instead of just name
     * @returns {string|object|null} Function name, symbol object, or null
     */
    findEnclosingFunction(filePath, lineNum, returnSymbol = false) {
        const fileEntry = this.files.get(filePath);
        if (!fileEntry) return null;

        let best = null;
        for (const symbol of fileEntry.symbols) {
            if (!NON_CALLABLE_TYPES.has(symbol.type) &&
                symbol.startLine <= lineNum &&
                symbol.endLine >= lineNum) {
                if (!best || (symbol.endLine - symbol.startLine) < (best.endLine - best.startLine)) {
                    best = symbol;
                }
            }
        }
        if (!best) return null;
        return returnSymbol ? best : best.name;
    }

    /** Get instance attribute types for a class in a file */
    getInstanceAttributeTypes(filePath, className) { return callersModule.getInstanceAttributeTypes(this, filePath, className); }

    /**
     * Extract type names from a function definition
     * Finds all word-like type identifiers from param types, return type,
     * class membership, and function body — filters to project-defined types only.
     */
    extractTypeNames(def) {
        const TYPE_KINDS = ['type', 'interface', 'class', 'struct'];
        const types = new Set();

        const addIfType = (name) => {
            const syms = this.symbols.get(name);
            if (syms && syms.some(s => TYPE_KINDS.includes(s.type))) {
                types.add(name);
            }
        };

        // 1. From param and return type annotations
        const typeStrings = [];
        if (def.paramsStructured) {
            for (const param of def.paramsStructured) {
                if (param.type) typeStrings.push(param.type);
            }
        }
        if (def.returnType) typeStrings.push(def.returnType);
        for (const ts of typeStrings) {
            const matches = ts.match(/\b([A-Za-z_]\w*)\b/g);
            if (matches) {
                for (const m of matches) addIfType(m);
            }
        }

        // 2. From the class the method belongs to
        if (def.className) addIfType(def.className);

        // 3. From function body — always scan for project-defined type references
        //    (constructors, type annotations, isinstance checks)
        //    Not just a fallback — methods may reference types beyond their own class
        const code = this.extractCode(def);
        if (code) {
            // Find capitalized identifiers that match project types
            const bodyMatches = code.match(/\b([A-Z][A-Za-z0-9_]*)\b/g);
            if (bodyMatches) {
                const seen = new Set();
                for (const m of bodyMatches) {
                    if (!seen.has(m)) {
                        seen.add(m);
                        addIfType(m);
                    }
                }
            }
        }

        return types;
    }

    // ========================================================================
    // NEW COMMANDS (v2 Migration)
    // ========================================================================

    /**
     * Get imports for a file
     * @param {string} filePath - File to get imports for
     * @returns {Array} Imports with resolved paths
     */
    imports(filePath) {
        const resolved = this.resolveFilePathForQuery(filePath);
        if (typeof resolved !== 'string') return resolved;

        const normalizedPath = resolved;
        const fileEntry = this.files.get(normalizedPath);
        if (!fileEntry) {
            return { error: 'file-not-found', filePath };
        }

        try {
            const content = this._readFile(normalizedPath);
            const { imports: rawImports } = extractImports(content, fileEntry.language);

            const contentLines = content.split('\n');

            return rawImports.map(imp => {
                // Skip imports with null module (e.g. Rust include! with dynamic path)
                if (!imp.module) {
                    return {
                        module: null,
                        names: imp.names,
                        type: imp.type,
                        resolved: null,
                        isExternal: false,
                        isDynamic: true,
                        line: null
                    };
                }

                // Dynamic imports with variable path (e.g. require(varName), import(varExpr)) can't be resolved.
                // Only JS/TS require()/import() with dynamic=true has unresolvable paths.
                // Go side-effect/dot imports and Rust glob uses also set dynamic=true but have valid module paths.
                const isUnresolvableDynamic = imp.dynamic && (imp.type === 'require' || imp.type === 'dynamic');
                if (isUnresolvableDynamic) {
                    let line = null;
                    for (let i = 0; i < contentLines.length; i++) {
                        if (contentLines[i].includes(imp.module || 'require')) {
                            line = i + 1;
                            break;
                        }
                    }
                    return {
                        module: imp.module,
                        names: imp.names,
                        type: imp.type,
                        resolved: null,
                        isExternal: false,
                        isDynamic: true,
                        line
                    };
                }

                let resolved = resolveImport(imp.module, normalizedPath, {
                    aliases: this.config.aliases,
                    language: fileEntry.language,
                    root: this.root
                });

                // Java package imports: resolve by progressive suffix matching
                // Handles regular, static (com.pkg.Class.method), and wildcard (com.pkg.Class.*) imports
                if (!resolved && fileEntry.language === 'java' && !imp.module.startsWith('.')) {
                    resolved = this._resolveJavaPackageImport(imp.module);
                }

                // Find line number of import
                let line = null;
                for (let i = 0; i < contentLines.length; i++) {
                    if (contentLines[i].includes(imp.module)) {
                        line = i + 1;
                        break;
                    }
                }

                return {
                    module: imp.module,
                    names: imp.names,
                    type: imp.type,
                    resolved: resolved ? path.relative(this.root, resolved) : null,
                    isExternal: !resolved,
                    isDynamic: false,
                    line
                };
            });
        } catch (e) {
            return [];
        }
    }

    /**
     * Get files that import a given file
     * @param {string} filePath - File to check
     * @returns {Array} Files that import this file
     */
    exporters(filePath) {
        const resolved = this.resolveFilePathForQuery(filePath);
        if (typeof resolved !== 'string') return resolved;

        const targetPath = resolved;

        const importers = this.exportGraph.get(targetPath) || [];

        return importers.map(importerPath => {
            const fileEntry = this.files.get(importerPath);

            // Find the import line
            let importLine = null;
            try {
                const content = this._readFile(importerPath);
                const lines = content.split('\n');
                let targetBasename = path.basename(targetPath, path.extname(targetPath));

                // For __init__.py, search for the package name (parent dir)
                // e.g., "from tools import X" → search for "tools" not "__init__"
                if (targetBasename === '__init__') {
                    targetBasename = path.basename(path.dirname(targetPath));
                }

                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes(targetBasename) &&
                        (lines[i].includes('import') || lines[i].includes('require') || lines[i].includes('from'))) {
                        importLine = i + 1;
                        break;
                    }
                }
            } catch (e) {
                // Skip
            }

            return {
                file: fileEntry ? fileEntry.relativePath : path.relative(this.root, importerPath),
                importLine
            };
        });
    }

    /**
     * Find type definitions
     * @param {string} name - Type name to find
     * @returns {Array} Matching type definitions
     */
    typedef(name, options = {}) {
        const typeKinds = ['type', 'interface', 'enum', 'struct', 'trait', 'class'];
        const matches = this.find(name, options);

        return matches.filter(m => typeKinds.includes(m.type)).map(m => ({
            ...m,
            code: this.extractCode(m)
        }));
    }

    /**
     * Find tests for a function or file
     * @param {string} nameOrFile - Function name or file path
     * @returns {Array} Test files and matches
     */
    tests(nameOrFile, options = {}) {
        this._beginOp();
        try {
        const results = [];

        // Check if it's a file path
        const isFilePath = nameOrFile.includes('/') || nameOrFile.includes('\\') ||
            nameOrFile.endsWith('.js') || nameOrFile.endsWith('.ts') ||
            nameOrFile.endsWith('.py') || nameOrFile.endsWith('.go') ||
            nameOrFile.endsWith('.java') || nameOrFile.endsWith('.rs');

        // Find all test files
        const testFiles = [];
        for (const [filePath, fileEntry] of this.files) {
            if (isTestFile(fileEntry.relativePath, fileEntry.language)) {
                testFiles.push({ path: filePath, entry: fileEntry });
            }
        }

        const searchTerm = isFilePath
            ? path.basename(nameOrFile, path.extname(nameOrFile))
            : nameOrFile;

        // Note: no 'g' flag - we only need to test for presence per line
        // The 'i' flag is kept for case-insensitive matching
        const regex = new RegExp('\\b' + escapeRegExp(searchTerm) + '\\b', 'i');
        // Pre-compile patterns used inside per-line loop
        const callPattern = new RegExp(escapeRegExp(searchTerm) + '\\s*\\(');
        const strPattern = new RegExp("['\"`]" + escapeRegExp(searchTerm) + "['\"`]");

        for (const { path: testPath, entry } of testFiles) {
            try {
                const content = this._readFile(testPath);
                const lines = content.split('\n');
                const matches = [];

                lines.forEach((line, idx) => {
                    if (regex.test(line)) {
                        let matchType = 'reference';
                        if (/\b(describe|it|test|spec)\s*\(/.test(line)) {
                            matchType = 'test-case';
                        } else if (/\b(import|require|from)\b/.test(line)) {
                            matchType = 'import';
                        } else if (callPattern.test(line)) {
                            matchType = 'call';
                        }
                        // Detect if the match is inside a string literal (e.g., 'parseFile' or "parseFile")
                        if (matchType === 'reference' || matchType === 'call') {
                            if (strPattern.test(line)) {
                                matchType = 'string-ref';
                            }
                        }

                        matches.push({
                            line: idx + 1,
                            content: line.trim(),
                            matchType
                        });
                    }
                });

                const filtered = options.callsOnly
                    ? matches.filter(m => m.matchType === 'call' || m.matchType === 'test-case')
                    : matches;
                if (filtered.length > 0) {
                    results.push({
                        file: entry.relativePath,
                        matches: filtered
                    });
                }
            } catch (e) {
                // Skip unreadable files
            }
        }

        return results;
        } finally { this._endOp(); }
    }

    /**
     * Get all exported/public symbols
     * @param {string} [filePath] - Optional file to limit to
     * @returns {Array} Exported symbols
     */
    api(filePath, options = {}) {
        const results = [];

        let fileIterator;
        if (filePath) {
            // Try exact resolution first
            const resolved = this.resolveFilePathForQuery(filePath);
            if (typeof resolved === 'string') {
                const fileEntry = this.files.get(resolved);
                if (!fileEntry) return { error: 'file-not-found', filePath };
                fileIterator = [[resolved, fileEntry]];
            } else {
                // Fall back to pattern filter (substring match on relative path)
                const matches = [];
                for (const [absPath, fe] of this.files) {
                    if (fe.relativePath.includes(filePath)) {
                        matches.push([absPath, fe]);
                    }
                }
                if (matches.length === 0) return { error: 'file-not-found', filePath };
                fileIterator = matches;
            }
        } else {
            fileIterator = this.files.entries();
        }

        for (const [absPath, fileEntry] of fileIterator) {
            if (!fileEntry) continue;

            // Skip test files by default (test classes aren't part of public API)
            if (!options.includeTests && isTestFile(fileEntry.relativePath, fileEntry.language)) {
                continue;
            }

            const exportedNames = new Set(fileEntry.exports);

            for (const symbol of fileEntry.symbols) {
                const isExported = exportedNames.has(symbol.name) ||
                    (symbol.modifiers && symbol.modifiers.includes('export')) ||
                    (symbol.modifiers && symbol.modifiers.includes('public')) ||
                    (fileEntry.language === 'go' && /^[A-Z]/.test(symbol.name));

                if (isExported) {
                    results.push({
                        name: symbol.name,
                        type: symbol.type,
                        file: fileEntry.relativePath,
                        startLine: symbol.startLine,
                        endLine: symbol.endLine,
                        params: symbol.params,
                        returnType: symbol.returnType,
                        signature: this.formatSignature(symbol)
                    });
                }
            }

            // Add variable exports (export const/let/var) not matched to symbols
            if (fileEntry.exportDetails) {
                const matchedNames = new Set(results.filter(r => r.file === fileEntry.relativePath).map(r => r.name));
                for (const exp of fileEntry.exportDetails) {
                    if (exp.isVariable && !matchedNames.has(exp.name)) {
                        const sig = `${exp.declKind} ${exp.name}${exp.typeAnnotation ? ': ' + exp.typeAnnotation : ''}`;
                        results.push({
                            name: exp.name,
                            type: 'variable',
                            file: fileEntry.relativePath,
                            startLine: exp.line,
                            endLine: exp.line,
                            params: undefined,
                            returnType: exp.typeAnnotation || null,
                            signature: sig
                        });
                    }
                }
            }
        }

        return results;
    }

    /**
     * Resolve a file path query to an indexed file (with ambiguity detection)
     * @param {string} filePath - File path to resolve
     * @returns {string|{error: string, filePath: string, candidates?: string[]}}
     */
    resolveFilePathForQuery(filePath) {
        // 1. Exact absolute/relative path match
        const normalizedPath = path.isAbsolute(filePath)
            ? filePath
            : path.join(this.root, filePath);

        if (this.files.has(normalizedPath)) {
            return normalizedPath;
        }

        // 2. Collect ALL suffix/partial candidates
        const candidates = [];
        for (const [absPath, entry] of this.files) {
            if (entry.relativePath === filePath || absPath.endsWith('/' + filePath)) {
                candidates.push(absPath);
            }
        }

        if (candidates.length === 0) {
            return { error: 'file-not-found', filePath };
        }
        if (candidates.length === 1) {
            return candidates[0];
        }
        return {
            error: 'file-ambiguous',
            filePath,
            candidates: candidates.map(c => this.files.get(c)?.relativePath || path.relative(this.root, c))
        };
    }

    /**
     * Find a file by path (supports partial paths)
     * Backward-compatible wrapper — returns null on error.
     */
    findFile(filePath) {
        const result = this.resolveFilePathForQuery(filePath);
        if (typeof result === 'string') return result;
        return null;
    }

    /**
     * Get exports for a specific file
     * @param {string} filePath - File path
     * @returns {Array} Exported symbols from that file
     */
    fileExports(filePath, _visited) {
        const resolved = this.resolveFilePathForQuery(filePath);
        if (typeof resolved !== 'string') return resolved;

        const absPath = resolved;
        const visited = _visited || new Set();
        if (visited.has(absPath)) return [];
        visited.add(absPath);

        const fileEntry = this.files.get(absPath);
        if (!fileEntry) {
            return [];
        }

        const results = [];
        const exportedNames = new Set(fileEntry.exports);

        for (const symbol of fileEntry.symbols) {
            const isExported = exportedNames.has(symbol.name) ||
                (symbol.modifiers && symbol.modifiers.includes('export')) ||
                (symbol.modifiers && symbol.modifiers.includes('public')) ||
                (fileEntry.language === 'go' && /^[A-Z]/.test(symbol.name));

            if (isExported) {
                results.push({
                    name: symbol.name,
                    type: symbol.type,
                    file: fileEntry.relativePath,
                    startLine: symbol.startLine,
                    endLine: symbol.endLine,
                    params: symbol.params,
                    returnType: symbol.returnType,
                    signature: this.formatSignature(symbol)
                });
            }
        }

        // Add variable exports (export const/let/var) not matched to symbols
        if (fileEntry.exportDetails) {
            const matchedNames = new Set(results.map(r => r.name));
            for (const exp of fileEntry.exportDetails) {
                if (exp.isVariable && !matchedNames.has(exp.name)) {
                    const sig = `${exp.declKind} ${exp.name}${exp.typeAnnotation ? ': ' + exp.typeAnnotation : ''}`;
                    results.push({
                        name: exp.name,
                        type: 'variable',
                        file: fileEntry.relativePath,
                        startLine: exp.line,
                        endLine: exp.line,
                        params: undefined,
                        returnType: exp.typeAnnotation || null,
                        signature: sig
                    });
                }
            }

            // Add re-exports: export { X } from './module'
            // Resolve to the source file and look up the symbol there
            for (const exp of fileEntry.exportDetails) {
                if ((exp.type === 're-export' || exp.type === 're-export-all') && exp.source && !matchedNames.has(exp.name)) {
                    const { resolveImport } = require('./imports');
                    const resolved = resolveImport(exp.source, absPath, {
                        language: fileEntry.language,
                        root: this.root,
                        extensions: this.extensions
                    });
                    if (resolved) {
                        const sourceEntry = this.files.get(resolved);
                        if (sourceEntry) {
                            // For star re-exports, include all exported symbols from source
                            if (exp.type === 're-export-all') {
                                const sourceExports = this.fileExports(resolved, visited);
                                for (const srcExp of sourceExports) {
                                    if (!matchedNames.has(srcExp.name)) {
                                        matchedNames.add(srcExp.name);
                                        results.push({ ...srcExp, file: fileEntry.relativePath, reExportedFrom: srcExp.file });
                                    }
                                }
                            } else {
                                // Named re-export: find the specific symbol
                                const srcSymbol = sourceEntry.symbols.find(s => s.name === exp.name);
                                if (srcSymbol) {
                                    matchedNames.add(exp.name);
                                    results.push({
                                        name: exp.name,
                                        type: srcSymbol.type,
                                        file: fileEntry.relativePath,
                                        startLine: exp.line,
                                        endLine: exp.line,
                                        params: srcSymbol.params,
                                        returnType: srcSymbol.returnType,
                                        signature: this.formatSignature(srcSymbol),
                                        reExportedFrom: sourceEntry.relativePath
                                    });
                                } else {
                                    // Symbol not found in source — still list it as a re-export
                                    matchedNames.add(exp.name);
                                    results.push({
                                        name: exp.name,
                                        type: 're-export',
                                        file: fileEntry.relativePath,
                                        startLine: exp.line,
                                        endLine: exp.line,
                                        params: undefined,
                                        returnType: null,
                                        signature: `re-export ${exp.name} from '${exp.source}'`,
                                        reExportedFrom: sourceEntry.relativePath
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        return results;
    }

    /** Check if a function is used as a callback anywhere in the codebase */
    findCallbackUsages(name) { return callersModule.findCallbackUsages(this, name); }


    /** Build a usage index for all identifiers in the codebase (optimized for deadcode) */
    buildUsageIndex() { return deadcodeModule.buildUsageIndex(this); }

    /** Find dead code (unused functions/classes) */
    deadcode(options) { return deadcodeModule.deadcode(this, options); }

    /**
     * Get dependency graph for a file
     * @param {string} filePath - Starting file
     * @param {object} options - { direction: 'imports' | 'importers' | 'both', maxDepth }
     * @returns {object} - Graph structure with root, nodes, edges
     */
    graph(filePath, options = {}) {
        const direction = options.direction || 'both';
        // Sanitize depth: use default for null/undefined, clamp negative to 0
        const rawDepth = options.maxDepth ?? 5;
        const maxDepth = Math.max(0, rawDepth);

        const resolved = this.resolveFilePathForQuery(filePath);
        if (typeof resolved !== 'string') return resolved;

        const targetPath = resolved;

        const buildSubgraph = (dir) => {
            const visited = new Set();
            const nodes = [];
            const edges = [];

            const traverse = (file, depth) => {
                if (visited.has(file)) return;
                visited.add(file);

                const fileEntry = this.files.get(file);
                const relPath = fileEntry ? fileEntry.relativePath : path.relative(this.root, file);
                nodes.push({ file, relativePath: relPath, depth });

                // Stop traversal at max depth but still register the node above
                if (depth >= maxDepth) return;

                let neighbors = [];
                if (dir === 'imports') {
                    neighbors = this.importGraph.get(file) || [];
                } else {
                    neighbors = this.exportGraph.get(file) || [];
                }

                // Deduplicate neighbors (same file may be imported multiple times, e.g. Java inner classes)
                const uniqueNeighbors = [...new Set(neighbors)];

                for (const neighbor of uniqueNeighbors) {
                    edges.push({ from: file, to: neighbor });
                    traverse(neighbor, depth + 1);
                }
            };

            traverse(targetPath, 0);
            return { nodes, edges };
        };

        if (direction === 'both') {
            // Build separate sub-graphs for imports and importers
            const importsGraph = buildSubgraph('imports');
            const importersGraph = buildSubgraph('importers');

            return {
                root: targetPath,
                direction: 'both',
                imports: { nodes: importsGraph.nodes, edges: importsGraph.edges },
                importers: { nodes: importersGraph.nodes, edges: importersGraph.edges },
                // Keep combined for backward compat
                nodes: [...importsGraph.nodes, ...importersGraph.nodes.filter(n =>
                    !importsGraph.nodes.some(in_ => in_.file === n.file))],
                edges: [...importsGraph.edges, ...importersGraph.edges]
            };
        }

        const subgraph = buildSubgraph(direction);
        return {
            root: targetPath,
            direction,
            nodes: subgraph.nodes,
            edges: subgraph.edges
        };
    }

    /**
     * Detect circular dependencies in the import graph.
     * Uses DFS with 3-color marking to find all cycles.
     * @param {object} options - { file, exclude }
     * @returns {object} - { cycles, totalFiles, summary }
     */
    circularDeps(options = {}) {
        this._beginOp();
        try {
            const exclude = options.exclude || [];
            const fileFilter = options.file || null;

            const WHITE = 0, GRAY = 1, BLACK = 2;
            const color = new Map();
            const cycles = [];
            const stack = [];

            const shouldSkip = (file) => {
                if (!this.files.has(file)) return true;
                if (exclude.length > 0) {
                    const entry = this.files.get(file);
                    if (entry && !this.matchesFilters(entry.relativePath, { exclude })) return true;
                }
                return false;
            };

            const dfs = (file) => {
                color.set(file, GRAY);
                stack.push(file);

                const neighbors = [...new Set(this.importGraph.get(file) || [])];

                for (const neighbor of neighbors) {
                    if (shouldSkip(neighbor)) continue;
                    const nc = color.get(neighbor) || WHITE;
                    if (nc === GRAY) {
                        const idx = stack.indexOf(neighbor);
                        cycles.push(stack.slice(idx));
                    } else if (nc === WHITE) {
                        dfs(neighbor);
                    }
                }

                stack.pop();
                color.set(file, BLACK);
            };

            for (const file of this.files.keys()) {
                if ((color.get(file) || WHITE) === WHITE && !shouldSkip(file)) {
                    dfs(file);
                }
            }

            // Convert to relative paths and deduplicate
            const seen = new Set();
            const uniqueCycles = [];
            for (const cycle of cycles) {
                const relCycle = cycle.map(f => this.files.get(f)?.relativePath || path.relative(this.root, f));
                // Normalize: rotate so lexicographically smallest file is first
                const sorted = relCycle.slice().sort();
                const minIdx = relCycle.indexOf(sorted[0]);
                const rotated = [...relCycle.slice(minIdx), ...relCycle.slice(0, minIdx)];
                const key = rotated.join('\0');
                if (!seen.has(key)) {
                    seen.add(key);
                    uniqueCycles.push({ files: rotated, length: rotated.length });
                }
            }

            // Filter by file pattern
            let result = uniqueCycles;
            if (fileFilter) {
                result = uniqueCycles.filter(c => c.files.some(f => f.includes(fileFilter)));
            }

            result.sort((a, b) => a.length - b.length || a.files[0].localeCompare(b.files[0]));

            // Count files that participate in import graph (have edges)
            let filesWithImports = 0;
            for (const [, targets] of this.importGraph) {
                if (targets && targets.length > 0) filesWithImports++;
            }

            return {
                cycles: result,
                totalFiles: this.files.size,
                filesWithImports,
                fileFilter: fileFilter || undefined,
                summary: {
                    totalCycles: result.length,
                    filesInCycles: new Set(result.flatMap(c => c.files)).size,
                }
            };
        } finally {
            this._endOp();
        }
    }

    /**
     * Detect patterns that may cause incomplete results
     * Returns warnings about dynamic code patterns
     * Cached to avoid rescanning on every query
     */
    detectCompleteness() {
        // Return cached result if available
        if (this._completenessCache) {
            return this._completenessCache;
        }

        const warnings = [];
        let dynamicImports = 0;
        let evalUsage = 0;
        let reflectionUsage = 0;

        const predominantLang = this._getPredominantLanguage();

        for (const [filePath, fileEntry] of this.files) {
            // Skip node_modules - we don't care about their patterns
            if (filePath.includes('node_modules')) continue;

            try {
                const content = this._readFile(filePath);

                if (fileEntry.language !== 'go') {
                    // Dynamic imports: import(), require(variable), __import__
                    dynamicImports += (content.match(/import\s*\([^'"]/g) || []).length;
                    dynamicImports += (content.match(/require\s*\([^'"]/g) || []).length;
                    dynamicImports += (content.match(/__import__\s*\(/g) || []).length;

                    // eval, Function constructor
                    evalUsage += (content.match(/(^|[^a-zA-Z_])eval\s*\(/gm) || []).length;
                    evalUsage += (content.match(/new\s+Function\s*\(/g) || []).length;
                }

                // Reflection: getattr, hasattr, Reflect
                reflectionUsage += (content.match(/\bgetattr\s*\(/g) || []).length;
                reflectionUsage += (content.match(/\bhasattr\s*\(/g) || []).length;
                reflectionUsage += (content.match(/\bReflect\./g) || []).length;
            } catch (e) {
                // Skip unreadable files
            }
        }

        if (dynamicImports > 0) {
            warnings.push({
                type: 'dynamic_imports',
                count: dynamicImports,
                message: `${dynamicImports} dynamic import(s) detected - some dependencies may be missed`
            });
        }

        if (evalUsage > 0) {
            warnings.push({
                type: 'eval',
                count: evalUsage,
                message: `${evalUsage} eval/exec usage(s) detected - dynamically generated code not analyzed`
            });
        }

        if (reflectionUsage > 0) {
            warnings.push({
                type: 'reflection',
                count: reflectionUsage,
                message: `${reflectionUsage} reflection usage(s) detected - dynamic attribute access not tracked`
            });
        }

        this._completenessCache = {
            complete: warnings.length === 0,
            warnings
        };

        return this._completenessCache;
    }


    /**
     * Find related functions - same file, similar names, shared dependencies
     * This is the "what else should I look at" command
     *
     * @param {string} name - Function name
     * @returns {object} Related functions grouped by relationship type
     */
    related(name, options = {}) {
        this._beginOp();
        try {
        const { def } = this.resolveSymbol(name, { file: options.file, className: options.className });
        if (!def) {
            return null;
        }
        const related = {
            target: {
                name: def.name,
                file: def.relativePath,
                line: def.startLine,
                type: def.type
            },
            sameFile: [],
            similarNames: [],
            sharedCallers: [],
            sharedCallees: []
        };

        // 1. Same file functions (sorted by proximity to target)
        const fileEntry = this.files.get(def.file);
        if (fileEntry) {
            for (const sym of fileEntry.symbols) {
                if (sym.name !== name && !NON_CALLABLE_TYPES.has(sym.type)) {
                    related.sameFile.push({
                        name: sym.name,
                        line: sym.startLine,
                        params: sym.params
                    });
                }
            }
            // Sort by distance from target function (nearest first)
            related.sameFile.sort((a, b) =>
                Math.abs(a.line - def.startLine) - Math.abs(b.line - def.startLine)
            );
        }

        // 2. Similar names (shared prefix/suffix, camelCase similarity)
        const nameParts = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split('_');
        for (const [symName, symbols] of this.symbols) {
            if (symName === name) continue;
            const symParts = symName.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split('_');

            // Check for shared parts (require ≥50% of the longer name to match)
            const sharedParts = nameParts.filter(p => symParts.includes(p) && p.length > 3);
            const maxParts = Math.max(nameParts.length, symParts.length);
            if (sharedParts.length > 0 && sharedParts.length / maxParts >= 0.5) {
                const sym = symbols[0];
                related.similarNames.push({
                    name: symName,
                    file: sym.relativePath,
                    line: sym.startLine,
                    sharedParts,
                    type: sym.type
                });
            }
        }
        // Sort by number of shared parts
        related.similarNames.sort((a, b) => b.sharedParts.length - a.sharedParts.length);
        const similarLimit = options.top || (options.all ? Infinity : 10);
        if (related.similarNames.length > similarLimit) related.similarNames = related.similarNames.slice(0, similarLimit);

        // 3. Shared callers - functions called by the same callers
        const myCallers = new Set(this.findCallers(name).map(c => c.callerName).filter(Boolean));
        if (myCallers.size > 0) {
            const callerCounts = new Map();
            for (const callerName of myCallers) {
                const callerDef = this.symbols.get(callerName)?.[0];
                if (callerDef) {
                    const callees = this.findCallees(callerDef);
                    for (const callee of callees) {
                        if (callee.name !== name) {
                            callerCounts.set(callee.name, (callerCounts.get(callee.name) || 0) + 1);
                        }
                    }
                }
            }
            // Sort by shared caller count
            const maxShared = options.top || (options.all ? Infinity : 5);
            const sorted = Array.from(callerCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, maxShared);
            for (const [symName, count] of sorted) {
                const sym = this.symbols.get(symName)?.[0];
                if (sym) {
                    related.sharedCallers.push({
                        name: symName,
                        file: sym.relativePath,
                        line: sym.startLine,
                        sharedCallerCount: count
                    });
                }
            }
        }

        // 4. Shared callees - functions that call the same things
        // Optimized: instead of computing callees for every symbol (O(N*M)),
        // find who else calls each of our callees (O(K) where K = our callee count)
        if (def.type === 'function' || def.params !== undefined) {
            const myCallees = this.findCallees(def);
            const myCalleeNames = new Set(myCallees.map(c => c.name));
            if (myCalleeNames.size > 0) {
                const calleeCounts = new Map();
                for (const calleeName of myCalleeNames) {
                    // Find other functions that also call this callee
                    const callers = this.findCallers(calleeName);
                    for (const caller of callers) {
                        if (caller.callerName && caller.callerName !== name) {
                            calleeCounts.set(caller.callerName, (calleeCounts.get(caller.callerName) || 0) + 1);
                        }
                    }
                }
                // Sort by shared callee count
                const sorted = Array.from(calleeCounts.entries())
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, options.top || (options.all ? Infinity : 5));
                for (const [symName, count] of sorted) {
                    const sym = this.symbols.get(symName)?.[0];
                    if (sym) {
                        related.sharedCallees.push({
                            name: symName,
                            file: sym.relativePath,
                            line: sym.startLine,
                            sharedCalleeCount: count
                        });
                    }
                }
            }
        }

        return related;
        } finally { this._endOp(); }
    }

    /**
     * Trace call flow - show call tree visualization
     * This is the "what calls what" command
     *
     * @param {string} name - Function name to trace from
     * @param {object} options - { depth, direction }
     * @returns {object} Call tree structure
     */
    trace(name, options = {}) {
        this._beginOp();
        try {
        // Sanitize depth: use default for null/undefined, clamp negative to 0
        const rawDepth = options.depth ?? 3;
        const maxDepth = Math.max(0, rawDepth);
        const direction = options.direction || 'down';  // 'down' = callees, 'up' = callers, 'both'
        const maxChildren = options.all ? Infinity : 10;
        // trace defaults to includeMethods=true (execution flow should show method calls)
        const includeMethods = options.includeMethods ?? true;

        const { def, definitions, warnings } = this.resolveSymbol(name, { file: options.file, className: options.className });
        if (!def) {
            return null;
        }
        const visited = new Set();
        const defDir = path.dirname(def.file);

        const buildTree = (funcDef, currentDepth, dir) => {
            const funcName = funcDef.name;
            const key = `${funcDef.file}:${funcDef.startLine}`;
            if (currentDepth > maxDepth) {
                return null;
            }
            if (visited.has(key)) {
                // Already explored — show as leaf node without recursing (prevents infinite loops)
                return {
                    name: funcName,
                    file: funcDef.relativePath,
                    line: funcDef.startLine,
                    type: funcDef.type,
                    children: [],
                    alreadyShown: true
                };
            }
            visited.add(key);

            const node = {
                name: funcName,
                file: funcDef.relativePath,
                line: funcDef.startLine,
                type: funcDef.type,
                children: []
            };

            if (dir === 'down' || dir === 'both') {
                const callees = this.findCallees(funcDef, { includeMethods, includeUncertain: options.includeUncertain });
                for (const callee of callees.slice(0, maxChildren)) {
                    // callee already has the best-matched definition from findCallees
                    const childTree = buildTree(callee, currentDepth + 1, 'down');
                    if (childTree) {
                        node.children.push({
                            ...childTree,
                            callCount: callee.callCount,
                            weight: callee.weight
                        });
                    }
                }
                if (callees.length > maxChildren) {
                    node.truncatedChildren = callees.length - maxChildren;
                }
            }

            return node;
        };

        const tree = buildTree(def, 0, direction);

        // Also get callers if direction is 'up' or 'both'
        let callers = [];
        let truncatedCallers = 0;
        if (direction === 'up' || direction === 'both') {
            const allCallers = this.findCallers(name, { includeMethods, includeUncertain: options.includeUncertain, targetDefinitions: [def] });
            callers = allCallers.slice(0, maxChildren).map(c => ({
                name: c.callerName || '(anonymous)',
                file: c.relativePath,
                line: c.line,
                expression: c.content.trim()
            }));
            if (allCallers.length > maxChildren) {
                truncatedCallers = allCallers.length - maxChildren;
            }
        }

        // Add smart hint when resolved function has zero callees
        if (tree && tree.children && tree.children.length === 0) {
            if (maxDepth === 0) {
                warnings.push({
                    message: `depth=0: showing root function only. Increase depth to see callees.`
                });
            } else if (definitions.length > 1 && !options.file) {
                warnings.push({
                    message: `Resolved to ${def.relativePath}:${def.startLine} which has no callees. ${definitions.length - 1} other definition(s) exist — specify a file to pick a different one.`
                });
            }
        }

        return {
            root: name,
            file: def.relativePath,
            line: def.startLine,
            direction,
            maxDepth,
            includeMethods,
            tree,
            callers: direction !== 'down' ? callers : undefined,
            truncatedCallers: truncatedCallers > 0 ? truncatedCallers : undefined,
            warnings: warnings.length > 0 ? warnings : undefined
        };
        } finally { this._endOp(); }
    }

    /**
     * Analyze impact of changing a function - what call sites would need updating
     * This is the "what breaks if I change this" command
     *
     * @param {string} name - Function name
     * @param {object} options - { groupByFile }
     * @returns {object} Impact analysis
     */
    impact(name, options = {}) {
        this._beginOp();
        try {
        const { def } = this.resolveSymbol(name, { file: options.file, className: options.className });
        if (!def) {
            return null;
        }
        const defIsMethod = def.isMethod || def.type === 'method' || def.className || def.receiver;

        // Use findCallers for className-scoped or method queries (sophisticated binding resolution)
        // Fall back to usages-based approach for simple function queries (backward compatible)
        let callSites;
        if (options.className || defIsMethod) {
            // findCallers has proper method call resolution (self/this, binding IDs, receiver checks)
            let callerResults = this.findCallers(name, {
                includeMethods: true,
                includeUncertain: false,
                targetDefinitions: [def],
            });

            // When the target definition has a className (including Go/Rust methods which
            // now get className from receiver), filter out method calls whose receiver
            // clearly belongs to a different type. This helps with common method names
            // like .close(), .get() etc. where many types have the same method.
            if (def.className) {
                const targetClassName = def.className;
                callerResults = callerResults.filter(c => {
                    // Keep non-method calls and self/this/cls calls (already resolved by findCallers)
                    if (!c.isMethod) return true;
                    const r = c.receiver;
                    if (!r || ['self', 'cls', 'this', 'super'].includes(r)) return true;
                    // Check if receiver matches the target class name (case-insensitive camelCase convention)
                    if (r.toLowerCase().includes(targetClassName.toLowerCase())) return true;
                    // Check if receiver is an instance of the target class using local variable type inference
                    if (c.callerFile) {
                        const callerDef = c.callerStartLine ? { file: c.callerFile, startLine: c.callerStartLine, endLine: c.callerEndLine } : null;
                        if (callerDef) {
                            const callerCalls = this.getCachedCalls(c.callerFile);
                            if (callerCalls && Array.isArray(callerCalls)) {
                                const localTypes = new Map();
                                for (const call of callerCalls) {
                                    if (call.line >= callerDef.startLine && call.line <= callerDef.endLine) {
                                        if (!call.isMethod && !call.receiver) {
                                            const syms = this.symbols.get(call.name);
                                            if (syms && syms.some(s => s.type === 'class')) {
                                                // Found a constructor call — check for assignment pattern
                                                const fileEntry = this.files.get(c.callerFile);
                                                if (fileEntry) {
                                                    const content = this._readFile(c.callerFile);
                                                    const lines = content.split('\n');
                                                    const line = lines[call.line - 1] || '';
                                                    // Match "var = ClassName(...)"
                                                    const m = line.match(/^\s*(\w+)\s*=\s*(?:await\s+)?(\w+)\s*\(/);
                                                    if (m && m[2] === call.name) {
                                                        localTypes.set(m[1], call.name);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                const receiverType = localTypes.get(r);
                                if (receiverType) {
                                    return receiverType === targetClassName;
                                }
                            }
                        }
                    }
                    // Check parameter type annotations: def foo(tracker: SourceTracker) → tracker.record()
                    if (c.callerFile && c.callerStartLine) {
                        const callerSymbol = this.findEnclosingFunction(c.callerFile, c.line, true);
                        if (callerSymbol && callerSymbol.paramsStructured) {
                            for (const param of callerSymbol.paramsStructured) {
                                if (param.name === r && param.type) {
                                    // Check if the type annotation contains the target class name
                                    const typeMatches = param.type.match(/\b([A-Za-z_]\w*)\b/g);
                                    if (typeMatches && typeMatches.some(t => t === targetClassName)) {
                                        return true;
                                    }
                                    // Type annotation exists but doesn't match target class — filter out
                                    return false;
                                }
                            }
                        }
                    }
                    // Unique method heuristic: if the called method exists on exactly one class/type
                    // and it matches the target, include the call (no other class could match)
                    const methodDefs = this.symbols.get(name);
                    if (methodDefs) {
                        const classNames = new Set();
                        for (const d of methodDefs) {
                            if (d.className) classNames.add(d.className);
                            // Go/Rust: use receiver type as className equivalent
                            else if (d.receiver) classNames.add(d.receiver.replace(/^\*/, ''));
                        }
                        if (classNames.size === 1 && classNames.has(targetClassName)) {
                            return true;
                        }
                    }
                    // Type-scoped query but receiver type unknown — filter it out.
                    // Unknown receivers are likely unrelated.
                    return false;
                });
            }

            callSites = [];
            for (const c of callerResults) {
                const analysis = this.analyzeCallSite(
                    { file: c.file, relativePath: c.relativePath, line: c.line, content: c.content },
                    name
                );
                callSites.push({
                    file: c.relativePath,
                    line: c.line,
                    expression: c.content.trim(),
                    callerName: c.callerName,
                    ...analysis
                });
            }
            this._clearTreeCache();
        } else {
            // Use findCallers (benefits from callee index) instead of usages() for speed
            const callerResults = this.findCallers(name, {
                includeMethods: false,
                includeUncertain: false,
                targetDefinitions: [def],
            });
            const targetBindingId = def.bindingId;
            // Convert findCallers results to the format expected by analyzeCallSite
            const calls = callerResults.map(c => ({
                file: c.file,
                relativePath: c.relativePath,
                line: c.line,
                content: c.content,
                usageType: 'call',
                callerName: c.callerName,
            }));
            // Keep the same binding filter for backward compat (findCallers already handles this,
            // but cross-check with usages-based binding filter for safety)
            const filteredCalls = calls.filter(u => {
                const fileEntry = this.files.get(u.file);
                if (fileEntry && targetBindingId) {
                    let localBindings = (fileEntry.bindings || []).filter(b => b.name === name);
                    if (localBindings.length === 0 && fileEntry.language === 'go') {
                        const dir = path.dirname(u.file);
                        for (const [fp, fe] of this.files) {
                            if (fp !== u.file && path.dirname(fp) === dir) {
                                const sibling = (fe.bindings || []).filter(b => b.name === name);
                                localBindings = localBindings.concat(sibling);
                            }
                        }
                    }
                    if (localBindings.length > 0 && !localBindings.some(b => b.id === targetBindingId)) {
                        return false;
                    }
                }
                return true;
            });
            // (findCallers already handles binding resolution and scope-aware filtering)

            // Analyze each call site, filtering out method calls for non-method definitions
            callSites = [];
            const defFileEntry = this.files.get(def.file);
            const defLang = defFileEntry?.language;
            const targetDir = defLang === 'go' ? path.basename(path.dirname(def.file)) : null;
            for (const call of filteredCalls) {
                const analysis = this.analyzeCallSite(call, name);
                // Skip method calls (obj.parse()) when target is a standalone function (parse())
                // For Go, allow calls where receiver matches the package directory name
                // (e.g., controller.FilterActive() where file is in pkg/controller/)
                if (analysis.isMethodCall && !defIsMethod) {
                    if (targetDir) {
                        // Get receiver from parsed calls cache
                        const parsedCalls = this.getCachedCalls(call.file);
                        const matchedCall = parsedCalls?.find(c => c.name === name && c.line === call.line);
                        if (matchedCall?.receiver === targetDir) {
                            // Receiver matches package directory — keep it
                        } else {
                            continue;
                        }
                    } else {
                        continue;
                    }
                }
                callSites.push({
                    file: call.relativePath,
                    line: call.line,
                    expression: call.content.trim(),
                    callerName: call.callerName || this.findEnclosingFunction(call.file, call.line),
                    ...analysis
                });
            }
            this._clearTreeCache();
        }

        // Apply exclude filter
        let filteredSites = callSites;
        if (options.exclude && options.exclude.length > 0) {
            filteredSites = callSites.filter(s => this.matchesFilters(s.file, { exclude: options.exclude }));
        }

        // Apply top limit if specified (limits total call sites shown)
        const totalBeforeLimit = filteredSites.length;
        if (options.top && options.top > 0 && filteredSites.length > options.top) {
            filteredSites = filteredSites.slice(0, options.top);
        }

        // Group by file
        const byFile = new Map();
        for (const site of filteredSites) {
            if (!byFile.has(site.file)) {
                byFile.set(site.file, []);
            }
            byFile.get(site.file).push(site);
        }

        // Identify patterns
        const patterns = this.identifyCallPatterns(filteredSites, name);

        // Detect scope pollution: multiple class definitions for the same method name
        let scopeWarning = null;
        if (defIsMethod) {
            const allDefs = this.symbols.get(name);
            if (allDefs && allDefs.length > 1) {
                const classNames = [...new Set(allDefs
                    .filter(d => d.className && d.className !== def.className)
                    .map(d => d.className))];
                if (classNames.length > 0) {
                    scopeWarning = {
                        targetClass: def.className || '(unknown)',
                        otherClasses: classNames,
                        hint: `Results may include calls to ${classNames.join(', ')}.${name}(). Use file= or className= to narrow scope.`
                    };
                }
            }
        }

        return {
            function: name,
            file: def.relativePath,
            startLine: def.startLine,
            signature: this.formatSignature(def),
            params: def.params,
            paramsStructured: def.paramsStructured,
            totalCallSites: totalBeforeLimit,
            shownCallSites: filteredSites.length,
            byFile: Array.from(byFile.entries()).map(([file, sites]) => ({
                file,
                count: sites.length,
                sites
            })),
            patterns,
            scopeWarning
        };
        } finally { this._endOp(); }
    }

    /**
     * Transitive blast radius — walk UP the caller chain recursively.
     * Answers: "What breaks transitively if I change this function?"
     *
     * @param {string} name - Function name
     * @param {object} options - { depth, file, className, all, exclude, includeMethods, includeUncertain }
     * @returns {object|null} Blast radius tree with summary
     */
    blast(name, options = {}) {
        this._beginOp();
        try {
            const maxDepth = Math.max(0, options.depth ?? 3);
            const maxChildren = options.all ? Infinity : 10;
            const includeMethods = options.includeMethods ?? true;
            const includeUncertain = options.includeUncertain || false;
            const exclude = options.exclude || [];

            const { def, definitions, warnings } = this.resolveSymbol(name, { file: options.file, className: options.className });
            if (!def) return null;

            const visited = new Set();
            const affectedFunctions = new Set();
            const affectedFiles = new Set();
            let maxDepthReached = 0;

            const buildCallerTree = (funcDef, currentDepth) => {
                const key = `${funcDef.file}:${funcDef.startLine}`;
                if (currentDepth > maxDepth) return null;
                if (visited.has(key)) {
                    return {
                        name: funcDef.name,
                        file: funcDef.relativePath,
                        line: funcDef.startLine,
                        type: funcDef.type || 'function',
                        children: [],
                        alreadyShown: true
                    };
                }
                visited.add(key);

                if (currentDepth > maxDepthReached) maxDepthReached = currentDepth;
                if (currentDepth > 0) {
                    affectedFunctions.add(key);
                    affectedFiles.add(funcDef.file);
                }

                const node = {
                    name: funcDef.name,
                    file: funcDef.relativePath,
                    line: funcDef.startLine,
                    type: funcDef.type || 'function',
                    children: []
                };

                if (currentDepth < maxDepth) {
                    const callers = this.findCallers(funcDef.name, {
                        includeMethods,
                        includeUncertain,
                        targetDefinitions: funcDef.bindingId ? [funcDef] : undefined,
                    });

                    // Deduplicate callers by enclosing function (multiple call sites → one tree node)
                    const uniqueCallers = new Map();
                    for (const c of callers) {
                        if (!c.callerName) continue; // skip module-level code
                        // Apply exclude filter
                        if (exclude.length > 0 && !this.matchesFilters(c.relativePath, { exclude })) continue;
                        const callerKey = c.callerStartLine
                            ? `${c.callerFile}:${c.callerStartLine}`
                            : `${c.callerFile}:${c.callerName}`;
                        if (!uniqueCallers.has(callerKey)) {
                            uniqueCallers.set(callerKey, {
                                name: c.callerName,
                                file: c.callerFile,
                                relativePath: c.relativePath,
                                startLine: c.callerStartLine,
                                endLine: c.callerEndLine,
                                callSites: 1
                            });
                        } else {
                            uniqueCallers.get(callerKey).callSites++;
                        }
                    }

                    // Resolve definitions and build child nodes
                    const callerEntries = [];
                    for (const [, caller] of uniqueCallers) {
                        // Look up actual definition from symbol table
                        const defs = this.symbols.get(caller.name);
                        let callerDef = defs?.find(d => d.file === caller.file && d.startLine === caller.startLine);

                        if (!callerDef) {
                            // Pseudo-definition for callers not in symbol table
                            callerDef = {
                                name: caller.name,
                                file: caller.file,
                                relativePath: caller.relativePath,
                                startLine: caller.startLine,
                                endLine: caller.endLine,
                                type: 'function'
                            };
                        }

                        callerEntries.push({ def: callerDef, callSites: caller.callSites });
                    }

                    // Stable sort by file + line
                    callerEntries.sort((a, b) =>
                        a.def.file.localeCompare(b.def.file) || a.def.startLine - b.def.startLine
                    );

                    for (const { def: cDef, callSites } of callerEntries.slice(0, maxChildren)) {
                        const childTree = buildCallerTree(cDef, currentDepth + 1);
                        if (childTree) {
                            childTree.callSites = callSites;
                            node.children.push(childTree);
                        }
                    }

                    if (callerEntries.length > maxChildren) {
                        node.truncatedChildren = callerEntries.length - maxChildren;
                        // Count truncated callers in summary
                        for (const { def: cDef } of callerEntries.slice(maxChildren)) {
                            const key = `${cDef.file}:${cDef.startLine}`;
                            if (!visited.has(key)) {
                                affectedFunctions.add(key);
                                affectedFiles.add(cDef.file);
                            }
                        }
                    }
                }

                return node;
            };

            const tree = buildCallerTree(def, 0);

            // Smart hints
            if (tree && tree.children.length === 0) {
                if (maxDepth === 0) {
                    warnings.push({ message: 'depth=0: showing root function only. Increase depth to see callers.' });
                } else if (definitions.length > 1 && !options.file) {
                    warnings.push({
                        message: `Resolved to ${def.relativePath}:${def.startLine} which has no callers. ${definitions.length - 1} other definition(s) exist — specify a file to pick a different one.`
                    });
                }
            }

            return {
                root: name,
                file: def.relativePath,
                line: def.startLine,
                maxDepth,
                includeMethods,
                tree,
                summary: {
                    totalAffected: affectedFunctions.size,
                    totalFiles: affectedFiles.size,
                    maxDepthReached
                },
                warnings: warnings.length > 0 ? warnings : undefined
            };
        } finally { this._endOp(); }
    }

    /**
     * Reverse trace: walk UP the caller chain to entry points.
     * Like blast but focused on "how does execution reach this function?"
     * Marks leaf nodes (functions with no callers) as entry points.
     */
    reverseTrace(name, options = {}) {
        this._beginOp();
        try {
            const maxDepth = Math.max(0, options.depth ?? 5);
            const maxChildren = options.all ? Infinity : 10;
            const includeMethods = options.includeMethods ?? true;
            const includeUncertain = options.includeUncertain || false;
            const exclude = options.exclude || [];

            const { def, definitions, warnings } = this.resolveSymbol(name, { file: options.file, className: options.className });
            if (!def) return null;

            const visited = new Set();
            const entryPoints = [];
            let maxDepthReached = 0;

            const buildCallerTree = (funcDef, currentDepth) => {
                const key = `${funcDef.file}:${funcDef.startLine}`;
                if (currentDepth > maxDepth) return null;
                if (visited.has(key)) {
                    return {
                        name: funcDef.name,
                        file: funcDef.relativePath,
                        line: funcDef.startLine,
                        type: funcDef.type || 'function',
                        children: [],
                        alreadyShown: true
                    };
                }
                visited.add(key);
                if (currentDepth > maxDepthReached) maxDepthReached = currentDepth;

                const node = {
                    name: funcDef.name,
                    file: funcDef.relativePath,
                    line: funcDef.startLine,
                    type: funcDef.type || 'function',
                    children: []
                };

                if (currentDepth < maxDepth) {
                    const callers = this.findCallers(funcDef.name, {
                        includeMethods,
                        includeUncertain,
                        targetDefinitions: funcDef.bindingId ? [funcDef] : undefined,
                    });

                    // Deduplicate callers by enclosing function
                    const uniqueCallers = new Map();
                    for (const c of callers) {
                        if (!c.callerName) continue;
                        if (exclude.length > 0 && !this.matchesFilters(c.relativePath, { exclude })) continue;
                        const callerKey = c.callerStartLine
                            ? `${c.callerFile}:${c.callerStartLine}`
                            : `${c.callerFile}:${c.callerName}`;
                        if (!uniqueCallers.has(callerKey)) {
                            uniqueCallers.set(callerKey, {
                                name: c.callerName,
                                file: c.callerFile,
                                relativePath: c.relativePath,
                                startLine: c.callerStartLine,
                                endLine: c.callerEndLine,
                                callSites: 1
                            });
                        } else {
                            uniqueCallers.get(callerKey).callSites++;
                        }
                    }

                    // Resolve definitions and build child nodes
                    const callerEntries = [];
                    for (const [, caller] of uniqueCallers) {
                        const defs = this.symbols.get(caller.name);
                        let callerDef = defs?.find(d => d.file === caller.file && d.startLine === caller.startLine);
                        if (!callerDef) {
                            callerDef = {
                                name: caller.name,
                                file: caller.file,
                                relativePath: caller.relativePath,
                                startLine: caller.startLine,
                                endLine: caller.endLine,
                                type: 'function'
                            };
                        }
                        callerEntries.push({ def: callerDef, callSites: caller.callSites });
                    }

                    callerEntries.sort((a, b) =>
                        a.def.file.localeCompare(b.def.file) || a.def.startLine - b.def.startLine
                    );

                    for (const { def: cDef, callSites } of callerEntries.slice(0, maxChildren)) {
                        const childTree = buildCallerTree(cDef, currentDepth + 1);
                        if (childTree) {
                            childTree.callSites = callSites;
                            node.children.push(childTree);
                        }
                    }

                    if (callerEntries.length > maxChildren) {
                        node.truncatedChildren = callerEntries.length - maxChildren;
                        // Count entry points in truncated branches so summary is accurate
                        for (const { def: cDef } of callerEntries.slice(maxChildren)) {
                            const key = `${cDef.file}:${cDef.startLine}`;
                            if (!visited.has(key)) {
                                const cCallers = this.findCallers(cDef.name, {
                                    includeMethods, includeUncertain,
                                    targetDefinitions: cDef.bindingId ? [cDef] : undefined,
                                });
                                if (cCallers.length === 0) {
                                    entryPoints.push({ name: cDef.name, file: cDef.relativePath || path.relative(this.root, cDef.file), line: cDef.startLine });
                                }
                            }
                        }
                    }

                    // Mark as entry point if no callers found (and not at depth limit)
                    if (uniqueCallers.size === 0 && currentDepth > 0) {
                        node.entryPoint = true;
                        entryPoints.push({ name: funcDef.name, file: funcDef.relativePath, line: funcDef.startLine });
                    }
                }

                return node;
            };

            const tree = buildCallerTree(def, 0);

            // Also mark root as entry point if it has no callers
            if (tree && tree.children.length === 0 && maxDepth > 0) {
                tree.entryPoint = true;
                entryPoints.push({ name: def.name, file: def.relativePath, line: def.startLine });
            }

            // Smart hints
            if (tree && tree.children.length === 0) {
                if (maxDepth === 0) {
                    warnings.push({ message: 'depth=0: showing root function only. Increase depth to see callers.' });
                } else if (definitions.length > 1 && !options.file) {
                    warnings.push({
                        message: `Resolved to ${def.relativePath}:${def.startLine} which has no callers. ${definitions.length - 1} other definition(s) exist — specify a file to pick a different one.`
                    });
                }
            }

            return {
                root: name,
                file: def.relativePath,
                line: def.startLine,
                maxDepth,
                includeMethods,
                tree,
                entryPoints,
                summary: {
                    totalEntryPoints: entryPoints.length,
                    totalFunctions: visited.size - 1, // exclude root
                    maxDepthReached
                },
                warnings: warnings.length > 0 ? warnings : undefined
            };
        } finally { this._endOp(); }
    }

    /**
     * Find tests affected by a change to the given function.
     * Composes blast() (transitive callers) with test file scanning.
     */
    affectedTests(name, options = {}) {
        this._beginOp();
        try {
            // Step 1: Get all transitively affected functions via blast
            const blastResult = this.blast(name, {
                depth: options.depth ?? 3,
                file: options.file,
                className: options.className,
                all: true,
                exclude: options.exclude,
                includeMethods: options.includeMethods,
                includeUncertain: options.includeUncertain,
            });
            if (!blastResult) return null;

            // Step 2: Collect all affected function names from the tree
            const affectedNames = new Set();
            affectedNames.add(name);
            const collectNames = (node) => {
                if (!node) return;
                affectedNames.add(node.name);
                for (const child of node.children || []) collectNames(child);
            };
            collectNames(blastResult.tree);

            // Step 3: Build regex patterns for all names
            const namePatterns = new Map();
            for (const n of affectedNames) {
                const escaped = escapeRegExp(n);
                namePatterns.set(n, {
                    regex: new RegExp('\\b' + escaped + '\\b'),
                    callPattern: new RegExp(escaped + '\\s*\\('),
                });
            }

            // Step 4: Scan test files once for all affected names
            const exclude = options.exclude;
            const excludeArr = exclude ? (Array.isArray(exclude) ? exclude : [exclude]) : [];
            const results = [];
            for (const [filePath, fileEntry] of this.files) {
                if (!isTestFile(fileEntry.relativePath, fileEntry.language)) continue;
                if (excludeArr.length > 0 && !this.matchesFilters(fileEntry.relativePath, { exclude: excludeArr })) continue;
                try {
                    const content = this._readFile(filePath);
                    const lines = content.split('\n');
                    const fileMatches = new Map();

                    lines.forEach((line, idx) => {
                        for (const [funcName, patterns] of namePatterns) {
                            if (patterns.regex.test(line)) {
                                let matchType = 'reference';
                                if (/\b(describe|it|test|spec)\s*\(/.test(line)) {
                                    matchType = 'test-case';
                                } else if (/\b(import|require|from)\b/.test(line)) {
                                    matchType = 'import';
                                } else if (patterns.callPattern.test(line)) {
                                    matchType = 'call';
                                }
                                if (!fileMatches.has(funcName)) fileMatches.set(funcName, []);
                                fileMatches.get(funcName).push({
                                    line: idx + 1, content: line.trim(),
                                    matchType, functionName: funcName
                                });
                            }
                        }
                    });

                    if (fileMatches.size > 0) {
                        const coveredFunctions = [...fileMatches.keys()];
                        const allMatches = [];
                        for (const matches of fileMatches.values()) allMatches.push(...matches);
                        allMatches.sort((a, b) => a.line - b.line);
                        results.push({
                            file: fileEntry.relativePath,
                            coveredFunctions,
                            matchCount: allMatches.length,
                            matches: allMatches
                        });
                    }
                } catch (e) { /* skip unreadable */ }
            }

            // Sort by coverage breadth then alphabetically
            results.sort((a, b) => b.coveredFunctions.length - a.coveredFunctions.length || a.file.localeCompare(b.file));

            // Compute coverage stats
            const coveredSet = new Set();
            for (const r of results) for (const f of r.coveredFunctions) coveredSet.add(f);
            const uncovered = [...affectedNames].filter(n => !coveredSet.has(n));

            return {
                root: blastResult.root, file: blastResult.file, line: blastResult.line,
                depth: blastResult.maxDepth,
                affectedFunctions: [...affectedNames],
                testFiles: results,
                summary: {
                    totalAffected: affectedNames.size,
                    totalTestFiles: results.length,
                    coveredFunctions: coveredSet.size,
                    uncoveredCount: uncovered.length,
                },
                uncovered,
                warnings: blastResult.warnings,
            };
        } finally { this._endOp(); }
    }

    /** Plan a refactoring operation */
    plan(name, options) { return verifyModule.plan(this, name, options); }

    /** Parse a stack trace and show code for each frame */
    parseStackTrace(stackText) {
        return stacktrace.parseStackTrace(this, stackText);
    }

    /** Calculate path similarity score between two file paths */
    calculatePathSimilarity(query, candidate) {
        return stacktrace.calculatePathSimilarity(query, candidate);
    }

    /** Find the best matching file for a stack trace path */
    findBestMatchingFile(filePath, funcName, lineNum) {
        return stacktrace.findBestMatchingFile(this, filePath, funcName, lineNum);
    }

    /** Create a stack frame with code context */
    createStackFrame(filePath, lineNum, funcName, col, rawLine) {
        return stacktrace.createStackFrame(this, filePath, lineNum, funcName, col, rawLine);
    }

    /** Verify that all call sites match a function's signature */
    verify(name, options) { return verifyModule.verify(this, name, options); }

    /** Analyze a call site to understand how it's being called (AST-based) */
    analyzeCallSite(call, funcName) { return verifyModule.analyzeCallSite(this, call, funcName); }

    /** Find a call expression node at the target line matching funcName */
    _findCallNode(node, callTypes, targetRow, funcName) { return verifyModule.findCallNode(node, callTypes, targetRow, funcName); }

    /** Clear the AST tree cache (call after batch operations) */
    _clearTreeCache() { verifyModule.clearTreeCache(this); }

    /** Identify common calling patterns */
    identifyCallPatterns(callSites, funcName) { return verifyModule.identifyCallPatterns(callSites, funcName); }

    /**
     * Get complete information about a symbol - definition, usages, callers, callees, tests, code
     * This is the "tell me everything" command for AI agents
     *
     * @param {string} name - Symbol name
     * @param {object} options - { maxCallers, maxCallees, withCode, withTypes }
     * @returns {object} Complete symbol info
     */
    about(name, options = {}) {
        this._beginOp();
        try {
        const maxCallers = options.all ? Infinity : (options.maxCallers || 10);
        const maxCallees = options.all ? Infinity : (options.maxCallees || 10);

        // Find symbol definition(s) — skip counts since about() computes its own via usages()
        const definitions = this.find(name, { exact: true, file: options.file, className: options.className, skipCounts: true });
        if (definitions.length === 0) {
            // Try fuzzy match (needs counts for suggestion ranking)
            const fuzzy = this.find(name, { file: options.file, className: options.className });
            if (fuzzy.length === 0) {
                return null;
            }
            // Return suggestion
            return {
                found: false,
                suggestions: (options.all ? fuzzy : fuzzy.slice(0, 5)).map(s => ({
                    name: s.name,
                    file: s.relativePath,
                    line: s.startLine,
                    type: s.type,
                    usageCount: s.usageCount
                }))
            };
        }

        // Use resolveSymbol for consistent primary selection (prefers non-test files)
        const { def: resolved } = this.resolveSymbol(name, { file: options.file, className: options.className });
        const primary = resolved || definitions[0];
        const others = definitions.filter(d =>
            d.relativePath !== primary.relativePath || d.startLine !== primary.startLine
        );

        // Use the actual symbol name (may differ from query if fuzzy matched)
        const symbolName = primary.name;

        // Default includeMethods: true when target is a class method (method calls are the primary way
        // class methods are invoked), false for standalone functions (reduces noise from unrelated obj.fn() calls)
        const isMethod = !!(primary.isMethod || primary.type === 'method' || primary.className);
        const includeMethods = options.includeMethods ?? isMethod;

        // Get usage counts by type (fast path uses callee index, no file reads)
        // Exclude test files by default (matching usages command behavior)
        const countExclude = !options.includeTests ? addTestExclusions(options.exclude) : options.exclude;
        const usagesByType = this.countSymbolUsages(primary, { exclude: countExclude });

        // Get callers and callees (only for functions)
        let callers = [];
        let callees = [];
        let allCallers = null;
        let allCallees = null;
        let aboutConfFiltered = 0;
        if (primary.type === 'function' || primary.params !== undefined) {
            // Use maxResults to limit file iteration (with buffer for exclude filtering)
            const callerCap = maxCallers === Infinity ? undefined : maxCallers * 3;
            allCallers = this.findCallers(symbolName, { includeMethods, includeUncertain: options.includeUncertain, targetDefinitions: [primary], maxResults: callerCap });
            // Apply exclude filter before slicing
            if (options.exclude && options.exclude.length > 0) {
                allCallers = allCallers.filter(c => this.matchesFilters(c.relativePath, { exclude: options.exclude }));
            }
            // Apply confidence filtering before slicing
            if (options.minConfidence > 0) {
                const { filterByConfidence } = require('./confidence');
                const callerResult = filterByConfidence(allCallers, options.minConfidence);
                allCallers = callerResult.kept;
                aboutConfFiltered += callerResult.filtered;
            }
            callers = allCallers.slice(0, maxCallers).map(c => ({
                file: c.relativePath,
                line: c.line,
                expression: c.content.trim(),
                callerName: c.callerName,
                confidence: c.confidence,
                resolution: c.resolution,
            }));

            allCallees = this.findCallees(primary, { includeMethods, includeUncertain: options.includeUncertain });
            // Apply exclude filter before slicing
            if (options.exclude && options.exclude.length > 0) {
                allCallees = allCallees.filter(c => this.matchesFilters(c.relativePath, { exclude: options.exclude }));
            }
            // Apply confidence filtering before slicing
            if (options.minConfidence > 0) {
                const { filterByConfidence } = require('./confidence');
                const calleeResult = filterByConfidence(allCallees, options.minConfidence);
                allCallees = calleeResult.kept;
                aboutConfFiltered += calleeResult.filtered;
            }
            callees = allCallees.slice(0, maxCallees).map(c => ({
                name: c.name,
                file: c.relativePath,
                line: c.startLine,
                startLine: c.startLine,
                endLine: c.endLine,
                weight: c.weight,
                callCount: c.callCount,
                confidence: c.confidence,
                resolution: c.resolution,
            }));
        }

        // Find tests
        const tests = this.tests(symbolName);
        const testSummary = {
            fileCount: tests.length,
            totalMatches: tests.reduce((sum, t) => sum + t.matches.length, 0),
            files: (options.all ? tests : tests.slice(0, 3)).map(t => t.file)
        };

        // Extract code if requested (default: true)
        let code = null;
        if (options.withCode !== false) {
            code = this.extractCode(primary);
        }

        // Get type definitions if requested
        let types = [];
        if (options.withTypes) {
            const TYPE_KINDS = ['type', 'interface', 'class', 'struct'];
            const seen = new Set();

            const addType = (typeName) => {
                if (seen.has(typeName)) return;
                seen.add(typeName);
                const typeSymbols = this.symbols.get(typeName);
                if (typeSymbols) {
                    for (const sym of typeSymbols) {
                        if (TYPE_KINDS.includes(sym.type)) {
                            types.push({
                                name: sym.name,
                                type: sym.type,
                                file: sym.relativePath,
                                line: sym.startLine
                            });
                        }
                    }
                }
            };

            // From signature annotations
            const typeNames = this.extractTypeNames(primary);
            for (const typeName of typeNames) addType(typeName);

            // From callee signatures — types used by functions this function calls
            if (allCallees) {
                for (const callee of allCallees) {
                    const calleeTypeNames = this.extractTypeNames(callee);
                    for (const tn of calleeTypeNames) addType(tn);
                }
            }
        }

        const result = {
            found: true,
            symbol: {
                name: primary.name,
                type: primary.type,
                file: primary.relativePath,
                startLine: primary.startLine,
                endLine: primary.endLine,
                params: primary.params,
                returnType: primary.returnType,
                modifiers: primary.modifiers,
                docstring: primary.docstring,
                signature: this.formatSignature(primary)
            },
            usages: usagesByType,
            totalUsages: usagesByType.calls + usagesByType.imports + usagesByType.references,
            callers: {
                total: allCallers?.length ?? 0,
                top: callers
            },
            callees: {
                total: allCallees?.length ?? 0,
                top: callees
            },
            tests: testSummary,
            otherDefinitions: (options.all ? others : others.slice(0, 3)).map(d => ({
                file: d.relativePath,
                line: d.startLine,
                usageCount: d.usageCount ?? this.countSymbolUsages(d).total
            })),
            types,
            code,
            includeMethods,
            ...(aboutConfFiltered > 0 && { confidenceFiltered: aboutConfFiltered }),
            completeness: this.detectCompleteness()
        };

        return result;
        } finally { this._endOp(); }
    }

    /**
     * Search for text across the project
     * @param {string} term - Search term
     * @param {object} options - { codeOnly, context, caseSensitive, exclude, in }
     */
    search(term, options = {}) {
        this._beginOp();
        try {
        const results = [];
        let filesScanned = 0;
        let filesSkipped = 0;
        const regexFlags = options.caseSensitive ? 'g' : 'gi';
        const useRegex = options.regex !== false; // Default: regex ON
        let regex;
        let regexFallback = false;
        if (useRegex) {
            try {
                regex = new RegExp(term, regexFlags);
            } catch (e) {
                // Invalid regex — fall back to plain text
                regex = new RegExp(escapeRegExp(term), regexFlags);
                regexFallback = e.message;
            }
        } else {
            regex = new RegExp(escapeRegExp(term), regexFlags);
        }

        for (const [filePath, fileEntry] of this.files) {
            // Apply --file filter
            if (options.file) {
                const fp = fileEntry.relativePath;
                if (!fp.includes(options.file) && !fp.endsWith(options.file)) {
                    filesSkipped++;
                    continue;
                }
            }
            // Apply exclude/in filters
            if ((options.exclude && options.exclude.length > 0) || options.in) {
                if (!this.matchesFilters(fileEntry.relativePath, { exclude: options.exclude, in: options.in })) {
                    filesSkipped++;
                    continue;
                }
            }
            filesScanned++;
            try {
                const content = this._readFile(filePath);
                const lines = content.split('\n');
                const matches = [];

                // Use AST-based filtering for codeOnly mode when language is supported
                if (options.codeOnly) {
                    const language = detectLanguage(filePath);
                    if (language) {
                        try {
                            const parser = getParser(language);
                            const { findMatchesWithASTFilter } = require('../languages/utils');
                            const astMatches = findMatchesWithASTFilter(content, term, parser, { codeOnly: true, regex: useRegex });

                            for (const m of astMatches) {
                                const match = {
                                    line: m.line,
                                    content: m.content
                                };

                                // Add context lines if requested
                                if (options.context && options.context > 0) {
                                    const idx = m.line - 1;
                                    const before = [];
                                    const after = [];
                                    for (let i = 1; i <= options.context; i++) {
                                        if (idx - i >= 0) before.unshift(lines[idx - i]);
                                        if (idx + i < lines.length) after.push(lines[idx + i]);
                                    }
                                    match.before = before;
                                    match.after = after;
                                }

                                matches.push(match);
                            }

                            if (matches.length > 0) {
                                results.push({
                                    file: fileEntry.relativePath,
                                    matches
                                });
                            }
                            continue; // Skip to next file
                        } catch (e) {
                            // Fall through to regex-based search
                        }
                    }
                }

                // Fallback to regex-based search (non-codeOnly or unsupported language)
                lines.forEach((line, idx) => {
                    regex.lastIndex = 0; // Reset regex state
                    if (regex.test(line)) {
                        const lineNum = idx + 1;
                        // Skip if codeOnly and line is comment/string
                        if (options.codeOnly && this.isCommentOrStringAtPosition(content, lineNum, 0, filePath)) {
                            return;
                        }

                        const match = {
                            line: idx + 1,
                            content: line
                        };

                        // Add context lines if requested
                        if (options.context && options.context > 0) {
                            const before = [];
                            const after = [];
                            for (let i = 1; i <= options.context; i++) {
                                if (idx - i >= 0) before.unshift(lines[idx - i]);
                                if (idx + i < lines.length) after.push(lines[idx + i]);
                            }
                            match.before = before;
                            match.after = after;
                        }

                        matches.push(match);
                    }
                });

                if (matches.length > 0) {
                    results.push({
                        file: fileEntry.relativePath,
                        matches
                    });
                }
            } catch (e) {
                // Expected: binary/minified files fail to read or parse.
                // These are not actionable errors — silently skip.
            }
        }

        // Apply top limit (limits total matches across all files)
        const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
        let truncatedMatches = 0;
        if (options.top && options.top > 0 && totalMatches > options.top) {
            let remaining = options.top;
            const truncated = [];
            for (const r of results) {
                if (remaining <= 0) break;
                if (r.matches.length <= remaining) {
                    truncated.push(r);
                    remaining -= r.matches.length;
                } else {
                    truncated.push({ ...r, matches: r.matches.slice(0, remaining) });
                    remaining = 0;
                }
            }
            truncatedMatches = totalMatches - options.top;
            results.length = 0;
            results.push(...truncated);
        }

        results.meta = { filesScanned, filesSkipped, totalFiles: this.files.size, regexFallback, totalMatches, truncatedMatches };
        return results;
        } finally { this._endOp(); }
    }

    /**
     * Structural search — query the symbol table and call index, not raw text.
     * Answers questions like "functions taking Request param", "all db.* calls",
     * "exported async functions", "decorated route handlers".
     *
     * @param {object} options
     * @param {string} [options.term] - Name filter (glob: * and ? supported)
     * @param {string} [options.type] - Symbol kind: function, class, call, method, type
     * @param {string} [options.param] - Parameter name or type substring
     * @param {string} [options.receiver] - Call receiver pattern (for type=call)
     * @param {string} [options.returns] - Return type substring
     * @param {string} [options.decorator] - Decorator/annotation name substring
     * @param {boolean} [options.exported] - Only exported symbols
     * @param {boolean} [options.unused] - Only symbols with zero callers
     * @param {string[]} [options.exclude] - Exclude file patterns
     * @param {string} [options.in] - Restrict to subdirectory
     * @param {string} [options.file] - File pattern filter
     * @param {number} [options.top] - Limit results
     * @returns {{ results: Array, meta: object }}
     */
    structuralSearch(options = {}) {
        this._beginOp();
        try {
            const { term, param, receiver, returns: returnType, decorator, exported, unused } = options;
            // Auto-infer type: --receiver implies type=call
            const type = options.type || (receiver ? 'call' : undefined);
            const results = [];

            // Validate type if provided
            if (type && !STRUCTURAL_TYPES.has(type)) {
                return {
                    results: [],
                    meta: {
                        mode: 'structural',
                        query: { type },
                        totalMatched: 0,
                        shown: 0,
                        error: `Invalid type "${type}". Valid types: ${[...STRUCTURAL_TYPES].join(', ')}`,
                    }
                };
            }

            // Build glob-style name matcher from term
            const nameMatcher = term ? buildGlobMatcher(term, options.caseSensitive) : null;

            // Helper: check if file passes filters
            const passesFileFilter = (fileEntry) => {
                if (!fileEntry) return false;
                if (options.file) {
                    const rp = fileEntry.relativePath;
                    if (!rp.includes(options.file) && !rp.endsWith(options.file)) return false;
                }
                if ((options.exclude && options.exclude.length > 0) || options.in) {
                    if (!this.matchesFilters(fileEntry.relativePath, { exclude: options.exclude, in: options.in })) return false;
                }
                return true;
            };

            if (type === 'call') {
                // Search call sites from callee index
                const { getCachedCalls } = require('./callers');
                const seenFiles = new Set();

                // If term is given, only scan files that might contain that call
                if (term && !term.includes('*') && !term.includes('?')) {
                    // Exact or substring — use callee index for fast lookup
                    this.buildCalleeIndex();
                    const files = this.calleeIndex.get(term);
                    if (files) for (const f of files) seenFiles.add(f);
                } else {
                    // Scan all files
                    for (const fp of this.files.keys()) seenFiles.add(fp);
                }

                for (const filePath of seenFiles) {
                    const fileEntry = this.files.get(filePath);
                    if (!passesFileFilter(fileEntry)) continue;
                    const calls = getCachedCalls(this, filePath);
                    if (!calls) continue;
                    for (const call of calls) {
                        if (nameMatcher && !nameMatcher(call.name)) continue;
                        if (receiver) {
                            if (!call.receiver) continue;
                            if (!matchesSubstring(call.receiver, receiver, options.caseSensitive)) continue;
                        }
                        results.push({
                            kind: 'call',
                            name: call.receiver ? `${call.receiver}.${call.name}` : call.name,
                            file: fileEntry.relativePath,
                            line: call.line,
                            receiver: call.receiver || null,
                            isMethod: call.isMethod || false,
                        });
                    }
                }
            } else {
                // Search symbols (functions, classes, methods, types)
                const functionTypes = new Set(['function', 'constructor', 'method', 'arrow', 'static', 'classmethod']);
                const classTypes = new Set(['class', 'struct', 'interface', 'impl', 'trait']);
                const typeTypes = new Set(['type', 'enum', 'interface', 'trait']);
                const methodTypes = new Set(['method', 'constructor']);

                for (const [symbolName, definitions] of this.symbols) {
                    if (nameMatcher && !nameMatcher(symbolName)) continue;

                    for (const def of definitions) {
                        // Type filter
                        if (type === 'function' && !functionTypes.has(def.type)) continue;
                        if (type === 'class' && !classTypes.has(def.type)) continue;
                        if (type === 'method' && !methodTypes.has(def.type) && !def.isMethod) continue;
                        if (type === 'type' && !typeTypes.has(def.type)) continue;

                        // File filters
                        const fileEntry = this.files.get(def.file);
                        if (!passesFileFilter(fileEntry)) continue;

                        // Param filter: match param name or type
                        if (param) {
                            const cs = options.caseSensitive;
                            const ps = def.paramsStructured || [];
                            const paramStr = def.params || '';
                            const hasMatch = ps.some(p =>
                                matchesSubstring(p.name, param, cs) ||
                                (p.type && matchesSubstring(p.type, param, cs))
                            ) || matchesSubstring(paramStr, param, cs);
                            if (!hasMatch) continue;
                        }

                        // Return type filter
                        if (returnType) {
                            if (!def.returnType || !matchesSubstring(def.returnType, returnType, options.caseSensitive)) continue;
                        }

                        // Decorator filter: checks decorators (Python), modifiers (Java annotations stored lowercase)
                        if (decorator) {
                            const cs = options.caseSensitive;
                            const hasDecorator = (def.decorators && def.decorators.some(d => matchesSubstring(d, decorator, cs))) ||
                                (def.modifiers && def.modifiers.some(m => matchesSubstring(m, decorator, cs)));
                            if (!hasDecorator) continue;
                        }

                        // Exported filter
                        if (exported) {
                            const mods = def.modifiers || [];
                            const isExp = (fileEntry && fileEntry.exports.includes(symbolName)) ||
                                mods.includes('export') || mods.includes('public') ||
                                mods.some(m => m.startsWith('pub')) ||
                                (fileEntry && fileEntry.language === 'go' && /^[A-Z]/.test(symbolName));
                            if (!isExp) continue;
                        }

                        // Unused filter (expensive — last check)
                        if (unused) {
                            this.buildCalleeIndex();
                            if (this.calleeIndex.has(symbolName)) continue;
                        }

                        // Merge decorators from both Python-style decorators and Java-style modifiers
                        const allDecorators = def.decorators || null;

                        results.push({
                            kind: def.type,
                            name: symbolName,
                            file: def.relativePath,
                            line: def.startLine,
                            params: def.params || null,
                            returnType: def.returnType || null,
                            decorators: allDecorators,
                            className: def.className || null,
                            exported: exported ? true : undefined,
                        });
                    }
                }
            }

            // Sort by file, then line
            results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

            // Apply top limit
            const total = results.length;
            const top = options.top;
            if (top && top > 0 && results.length > top) {
                results.length = top;
            }

            return {
                results,
                meta: {
                    mode: 'structural',
                    query: Object.fromEntries(Object.entries({
                        type: type || 'any', term, param, receiver, returns: returnType,
                        decorator, exported: exported || undefined, unused: unused || undefined,
                    }).filter(([, v]) => v !== undefined && v !== null)),
                    totalMatched: total,
                    shown: results.length,
                }
            };
        } finally { this._endOp(); }
    }

    // ========================================================================
    // PROJECT INFO
    // ========================================================================

    /**
     * Get project statistics
     */
    getStats(options = {}) {
        // Count total symbols (not just unique names)
        let totalSymbols = 0;
        for (const [name, symbols] of this.symbols) {
            totalSymbols += symbols.length;
        }

        const stats = {
            root: this.root,
            files: this.files.size,
            symbols: totalSymbols,  // Total symbol count, not unique names
            buildTime: this.buildTime,
            byLanguage: {},
            byType: {},
            ...(this.truncated && { truncated: this.truncated })
        };

        for (const [filePath, fileEntry] of this.files) {
            const lang = fileEntry.language;
            if (!stats.byLanguage[lang]) {
                stats.byLanguage[lang] = { files: 0, lines: 0, symbols: 0 };
            }
            stats.byLanguage[lang].files++;
            stats.byLanguage[lang].lines += fileEntry.lines;
            stats.byLanguage[lang].symbols += fileEntry.symbols.length;
        }

        for (const [name, symbols] of this.symbols) {
            for (const sym of symbols) {
                if (!Object.hasOwn(stats.byType, sym.type)) {
                    stats.byType[sym.type] = 0;
                }
                stats.byType[sym.type]++;
            }
        }

        // Per-function line counts for complexity audits
        if (options.functions) {
            const functions = [];
            for (const [name, symbols] of this.symbols) {
                for (const sym of symbols) {
                    if (sym.type === 'function' || sym.type === 'method' || sym.type === 'static' ||
                        sym.type === 'constructor' || sym.type === 'public' || sym.type === 'abstract' ||
                        sym.type === 'classmethod') {
                        const lineCount = sym.endLine - sym.startLine + 1;
                        const relativePath = sym.relativePath || (sym.file ? path.relative(this.root, sym.file) : '');
                        functions.push({
                            name: sym.className ? `${sym.className}.${sym.name}` : sym.name,
                            file: relativePath,
                            startLine: sym.startLine,
                            lines: lineCount
                        });
                    }
                }
            }
            functions.sort((a, b) => b.lines - a.lines);
            stats.functions = functions;
        }

        return stats;
    }

    /**
     * Get TOC for all files
     */
    getToc(options = {}) {
        const files = [];
        let totalFunctions = 0;
        let totalClasses = 0;
        let totalState = 0;
        let totalLines = 0;
        let totalDynamic = 0;
        let totalTests = 0;

        // When file= is specified, scope to matching files only
        let fileFilter = null;
        if (options.file) {
            const resolved = this.findFile(options.file);
            if (resolved) {
                fileFilter = new Set([resolved]);
            } else {
                // Try substring match for partial paths
                const matching = [];
                for (const fp of this.files.keys()) {
                    const rp = path.relative(this.root, fp);
                    if (rp.includes(options.file) || fp.includes(options.file)) {
                        matching.push(fp);
                    }
                }
                if (matching.length > 0) {
                    fileFilter = new Set(matching);
                } else {
                    return {
                        meta: { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0 },
                        totals: { files: 0, lines: 0, functions: 0, classes: 0, state: 0, testFiles: 0 },
                        summary: { topFunctionFiles: [], topLineFiles: [], entryFiles: [] },
                        files: [],
                        hiddenFiles: 0,
                        error: `File not found in project: ${options.file}`
                    };
                }
            }
        }

        for (const [filePath, fileEntry] of this.files) {
            if (fileFilter && !fileFilter.has(filePath)) continue;
            let functions = fileEntry.symbols.filter(s =>
                s.type === 'function' || s.type === 'method' || s.type === 'static' ||
                s.type === 'constructor' || s.type === 'public' || s.type === 'abstract' ||
                s.type === 'classmethod'
            );
            const classes = fileEntry.symbols.filter(s =>
                ['class', 'interface', 'type', 'enum', 'struct', 'trait', 'impl', 'record', 'namespace'].includes(s.type)
            );
            const state = fileEntry.symbols.filter(s => s.type === 'state');

            if (options.topLevel) {
                functions = functions.filter(fn => !fn.isNested && (!fn.indent || fn.indent === 0));
            }

            totalFunctions += functions.length;
            totalClasses += classes.length;
            totalState += state.length;
            totalLines += fileEntry.lines;
            totalDynamic += fileEntry.dynamicImports || 0;
            if (isTestFile(fileEntry.relativePath, fileEntry.language)) totalTests += 1;

            const entry = {
                file: fileEntry.relativePath,
                language: fileEntry.language,
                lines: fileEntry.lines,
                functions: functions.length,
                classes: classes.length,
                state: state.length
            };

            if (options.detailed) {
                entry.symbols = { functions, classes, state };
            }

            files.push(entry);
        }

        // Hints: top files by function count and lines
        const hintLimit = options.all ? Infinity : 3;
        const topFunctionFiles = [...files]
            .sort((a, b) => b.functions - a.functions || b.lines - a.lines)
            .filter(f => f.functions > 0)
            .slice(0, hintLimit)
            .map(f => ({ file: f.file, functions: f.functions }));

        const topLineFiles = [...files]
            .sort((a, b) => b.lines - a.lines)
            .slice(0, hintLimit)
            .map(f => ({ file: f.file, lines: f.lines }));

        // Entry point candidates
        const entryPattern = /(main|index|server|app)\.(js|jsx|ts|tsx|py|go|rs|java)$/i;
        const entryFiles = files
            .filter(f => entryPattern.test(f.file))
            .slice(0, options.all ? Infinity : 5)
            .map(f => f.file);

        // Also detect entry points from package.json main/exports fields
        const pkgJsonPath = path.join(this.root, 'package.json');
        try {
            const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
            const mainField = pkgJson.main || pkgJson.module;
            if (mainField) {
                const mainFile = path.relative(this.root, path.resolve(this.root, mainField));
                if (files.some(f => f.file === mainFile) && !entryFiles.includes(mainFile)) {
                    entryFiles.unshift(mainFile);
                }
            }
        } catch {
            // No package.json or invalid JSON — skip
        }

        // Apply top limit for detailed mode to avoid massive output
        const top = options.top > 0 ? options.top : (options.detailed && !options.all ? 50 : Infinity);
        let hiddenFiles = 0;
        let displayFiles = files;
        if (top < files.length) {
            hiddenFiles = files.length - top;
            displayFiles = files.slice(0, top);
        }

        // Count files with no symbols (generated/empty files)
        const emptyFiles = files.filter(f => f.functions === 0 && f.classes === 0 && f.state === 0).length;

        return {
            meta: {
                complete: totalDynamic === 0,
                skipped: 0,
                dynamicImports: totalDynamic,
                uncertain: 0,
                projectLanguage: this._getPredominantLanguage(),
                ...(fileFilter && { filteredBy: options.file, matchedFiles: files.length }),
                ...(emptyFiles > 0 && fileFilter && { emptyFiles })
            },
            totals: {
                files: files.length,
                lines: totalLines,
                functions: totalFunctions,
                classes: totalClasses,
                state: totalState,
                testFiles: totalTests
            },
            summary: {
                topFunctionFiles,
                topLineFiles,
                entryFiles
            },
            files: displayFiles,
            hiddenFiles
        };
    }

    // ========================================================================
    // CACHE METHODS
    // ========================================================================

    /** Save index to cache file */
    saveCache(cachePath) { return indexCache.saveCache(this, cachePath); }

    /** Load index from cache file */
    loadCache(cachePath) { return indexCache.loadCache(this, cachePath); }

    /** Load callsCache from separate file on demand (called by findCallers/findCallees) */
    loadCallsCache() { return indexCache.loadCallsCache(this); }

    /** Check if cache is stale (any files changed or new files added) */
    isCacheStale() { return indexCache.isCacheStale(this); }

    /**
     * Find the best usage example of a function.
     * Scores call sites using AST analysis (await, destructuring, typed assignment, etc.)
     * @param {string} name - Symbol name
     * @returns {{ best: object, totalCalls: number } | null}
     */
    example(name, options = {}) {
        this._beginOp();
        try {
        const usages = this.usages(name, {
            codeOnly: true,
            className: options.className,
            exclude: ['test', 'spec', '__tests__', '__mocks__', 'fixture', 'mock'],
            context: 5
        });

        const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);
        if (calls.length === 0) return null;

        const scored = calls.map(call => {
            let score = 0;
            const reasons = [];
            const line = call.content.trim();

            const astInfo = this._analyzeCallSiteAST(call.file, call.line, name);

            if (astInfo.isTypedAssignment) { score += 15; reasons.push('typed assignment'); }
            if (astInfo.isInReturn) { score += 10; reasons.push('in return'); }
            if (astInfo.isAwait) { score += 10; reasons.push('async usage'); }
            if (astInfo.isDestructured) { score += 8; reasons.push('destructured'); }
            if (astInfo.isStandalone) { score += 5; reasons.push('standalone'); }
            if (astInfo.hasComment) { score += 3; reasons.push('documented'); }
            if (astInfo.isInCatch) { score -= 5; reasons.push('in catch block'); }
            if (astInfo.isInConditional) { score -= 3; reasons.push('in conditional'); }

            if (score === 0) {
                if (/^(const|let|var|return)\s/.test(line) || /^\w+\s*=/.test(line)) {
                    score += 10; reasons.push('return value used');
                }
                if (line.startsWith(name + '(') || /^(const|let|var)\s+\w+\s*=\s*\w*$/.test(line.split(name)[0])) {
                    score += 5; reasons.push('clear usage');
                }
            }

            if (call.before && call.before.length > 0) score += 3;
            if (call.after && call.after.length > 0) score += 3;
            if (call.before?.length > 0 && call.after?.length > 0) reasons.push('has context');

            const beforeCall = line.split(name + '(')[0];
            if (!beforeCall.includes('(') || /^\s*(const|let|var|return)?\s*\w+\s*=\s*$/.test(beforeCall)) {
                score += 2;
            }
            if (call.line < 100) score += 1;

            return { ...call, score, reasons };
        });

        scored.sort((a, b) => b.score - a.score);
        return { best: scored[0], totalCalls: calls.length };
        } finally { this._endOp(); }
    }

    /** Analyze a call site using AST for example scoring */
    _analyzeCallSiteAST(filePath, lineNum, funcName) { return verifyModule.analyzeCallSiteAST(this, filePath, lineNum, funcName); }

    /**
     * Diff-based impact analysis: find which functions changed and who calls them
     *
     * @param {object} options - { base, staged, file }
     * @returns {object} - { base, functions, moduleLevelChanges, newFunctions, deletedFunctions, summary }
     */
    diffImpact(options = {}) {
        this._beginOp();
        try {
        const { base = 'HEAD', staged = false, file } = options;

        // Validate base ref format to prevent argument injection
        if (base && !/^[a-zA-Z0-9._\-~\/^@{}:]+$/.test(base)) {
            throw new Error(`Invalid git ref format: ${base}`);
        }

        // Verify git repo
        let gitRoot;
        try {
            gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: this.root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch (e) {
            throw new Error('Not a git repository. diff-impact requires git.');
        }

        // Build git diff command (use execFileSync to avoid shell expansion)
        const diffArgs = ['diff', '--unified=0'];
        if (staged) {
            diffArgs.push('--staged');
        } else {
            diffArgs.push(base);
        }
        if (file) {
            diffArgs.push('--', file);
        }

        let diffText;
        try {
            diffText = execFileSync('git', diffArgs, { cwd: this.root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
        } catch (e) {
            // git diff exits non-zero when there are diff errors, but also for invalid refs
            if (e.stdout) {
                diffText = e.stdout;
            } else {
                throw new Error(`git diff failed: ${e.message}`);
            }
        }

        if (!diffText || !diffText.trim()) {
            return {
                base: staged ? '(staged)' : base,
                functions: [],
                moduleLevelChanges: [],
                newFunctions: [],
                deletedFunctions: [],
                summary: { modifiedFunctions: 0, deletedFunctions: 0, newFunctions: 0, totalCallSites: 0, affectedFiles: 0 }
            };
        }

        // Diff paths are git-root-relative. Resolve to this.root for file lookup.
        // Normalize both through realpath to handle macOS /var → /private/var symlinks.
        let realGitRoot, realProjectRoot;
        try { realGitRoot = fs.realpathSync(gitRoot); } catch (_) { realGitRoot = gitRoot; }
        try { realProjectRoot = fs.realpathSync(this.root); } catch (_) { realProjectRoot = this.root; }
        const projectPrefix = realGitRoot === realProjectRoot
            ? ''
            : path.relative(realGitRoot, realProjectRoot);

        const rawChanges = parseDiff(diffText, gitRoot);
        // Filter to files under this.root and remap paths.
        // Preserve gitRelativePath (repo-relative) for git show commands.
        const changes = [];
        for (const c of rawChanges) {
            if (projectPrefix && !c.relativePath.startsWith(projectPrefix + '/')) continue;
            const localRel = projectPrefix ? c.relativePath.slice(projectPrefix.length + 1) : c.relativePath;
            changes.push({ ...c, gitRelativePath: c.relativePath, filePath: path.join(this.root, localRel), relativePath: localRel });
        }

        const functions = [];
        const moduleLevelChanges = [];
        const newFunctions = [];
        const deletedFunctions = [];
        const callerFileSet = new Set();
        let totalCallSites = 0;

        for (const change of changes) {
            const lang = detectLanguage(change.filePath);
            if (!lang) continue;

            const fileEntry = this.files.get(change.filePath);

            // Handle deleted files: entire file was removed, all functions are deleted
            if (!fileEntry) {
                if (change.isDeleted && change.deletedLines.length > 0) {
                    const ref = staged ? 'HEAD' : base;
                    try {
                        const oldContent = execFileSync(
                            'git', ['show', `${ref}:${change.gitRelativePath}`],
                            { cwd: this.root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
                        );
                        const oldParsed = parse(oldContent, lang);
                        for (const oldFn of extractCallableSymbols(oldParsed)) {
                            deletedFunctions.push({
                                name: oldFn.name,
                                filePath: change.filePath,
                                relativePath: change.relativePath,
                                startLine: oldFn.startLine
                            });
                        }
                    } catch (e) {
                        // git show failed — skip
                    }
                }
                continue;
            }

            // Track which functions are affected by added/modified lines
            const affectedSymbols = new Map(); // symbolName -> { symbol, addedLines, deletedLines }

            for (const line of change.addedLines) {
                const symbol = this.findEnclosingFunction(change.filePath, line, true);
                if (symbol) {
                    const key = `${symbol.name}:${symbol.startLine}`;
                    if (!affectedSymbols.has(key)) {
                        affectedSymbols.set(key, { symbol, addedLines: [], deletedLines: [] });
                    }
                    affectedSymbols.get(key).addedLines.push(line);
                } else {
                    // Module-level change
                    const existing = moduleLevelChanges.find(m => m.filePath === change.filePath);
                    if (existing) {
                        existing.addedLines.push(line);
                    } else {
                        moduleLevelChanges.push({
                            filePath: change.filePath,
                            relativePath: change.relativePath,
                            addedLines: [line],
                            deletedLines: []
                        });
                    }
                }
            }

            for (const line of change.deletedLines) {
                // For deleted lines, we can't use findEnclosingFunction on the current file
                // since those lines no longer exist. Track as module-level unless they map
                // to a function that still exists (the function was modified, not deleted).
                // We approximate: if a deleted line is within the range of a known symbol, it's a modification.
                let matched = false;
                for (const symbol of fileEntry.symbols) {
                    if (NON_CALLABLE_TYPES.has(symbol.type)) continue;
                    // Use a generous range — deleted lines near a function likely belong to it
                    if (line >= symbol.startLine - 2 && line <= symbol.endLine + 2) {
                        const key = `${symbol.name}:${symbol.startLine}`;
                        if (!affectedSymbols.has(key)) {
                            affectedSymbols.set(key, { symbol, addedLines: [], deletedLines: [] });
                        }
                        affectedSymbols.get(key).deletedLines.push(line);
                        matched = true;
                        break;
                    }
                }
                if (!matched) {
                    const existing = moduleLevelChanges.find(m => m.filePath === change.filePath);
                    if (existing) {
                        existing.deletedLines.push(line);
                    } else {
                        moduleLevelChanges.push({
                            filePath: change.filePath,
                            relativePath: change.relativePath,
                            addedLines: [],
                            deletedLines: [line]
                        });
                    }
                }
            }

            // Detect new functions: all added lines are within a single function range
            // and the function didn't exist before (approximation: all lines in the function are added)
            for (const [key, data] of affectedSymbols) {
                const { symbol, addedLines } = data;
                const fnLineCount = symbol.endLine - symbol.startLine + 1;
                if (addedLines.length >= fnLineCount * 0.8 && data.deletedLines.length === 0) {
                    newFunctions.push({
                        name: symbol.name,
                        filePath: change.filePath,
                        relativePath: change.relativePath,
                        startLine: symbol.startLine,
                        endLine: symbol.endLine,
                        signature: this.formatSignature(symbol)
                    });
                    affectedSymbols.delete(key);
                }
            }

            // Detect deleted functions: compare old file symbols with current by identity.
            // Uses name+className counts to handle overloads (e.g. Java method overloading).
            if (change.deletedLines.length > 0) {
                const ref = staged ? 'HEAD' : base;
                try {
                    const oldContent = execFileSync(
                        'git', ['show', `${ref}:${change.gitRelativePath}`],
                        { cwd: this.root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
                    );
                    const fileLang = detectLanguage(change.filePath);
                    if (fileLang) {
                        const oldParsed = parse(oldContent, fileLang);
                        // Count current symbols by identity (name + className)
                        const currentCounts = new Map();
                        for (const s of fileEntry.symbols) {
                            if (NON_CALLABLE_TYPES.has(s.type)) continue;
                            const key = `${s.name}\0${s.className || ''}`;
                            currentCounts.set(key, (currentCounts.get(key) || 0) + 1);
                        }
                        // Count old symbols by identity and detect deletions
                        const oldCounts = new Map();
                        const oldSymbols = extractCallableSymbols(oldParsed);
                        for (const oldFn of oldSymbols) {
                            const key = `${oldFn.name}\0${oldFn.className || ''}`;
                            oldCounts.set(key, (oldCounts.get(key) || 0) + 1);
                        }
                        // For each identity, if old count > current count, the difference are deletions
                        for (const [key, oldCount] of oldCounts) {
                            const curCount = currentCounts.get(key) || 0;
                            if (oldCount > curCount) {
                                // Find the specific old symbols with this identity that were deleted
                                const matching = oldSymbols.filter(s => `${s.name}\0${s.className || ''}` === key);
                                // Report the extra ones (by startLine descending — later ones more likely deleted)
                                const toReport = matching.slice(curCount);
                                for (const oldFn of toReport) {
                                    deletedFunctions.push({
                                        name: oldFn.name,
                                        filePath: change.filePath,
                                        relativePath: change.relativePath,
                                        startLine: oldFn.startLine
                                    });
                                }
                            }
                        }
                    }
                } catch (e) {
                    // File didn't exist in base, or git error — skip
                }
            }

            // For each affected function, find callers
            for (const [, data] of affectedSymbols) {
                const { symbol, addedLines: aLines, deletedLines: dLines } = data;

                // Get the specific definitions matching this symbol
                const allDefs = this.symbols.get(symbol.name) || [];
                const targetDefs = allDefs.filter(d => d.file === change.filePath && d.startLine === symbol.startLine);

                let callers = this.findCallers(symbol.name, {
                    targetDefinitions: targetDefs.length > 0 ? targetDefs : undefined,
                    includeMethods: true,
                    includeUncertain: false,
                });

                // For Go/Java/Rust methods with a className, filter callers whose
                // receiver clearly belongs to a different type (same logic as impact()).
                const targetDef = targetDefs[0] || symbol;
                if (targetDef.className && (lang === 'go' || lang === 'java' || lang === 'rust')) {
                    const targetClassName = targetDef.className;
                    callers = callers.filter(c => {
                        if (!c.isMethod) return true;
                        const r = c.receiver;
                        if (!r || ['self', 'cls', 'this', 'super'].includes(r)) return true;
                        // Use receiverType from findCallers when available
                        if (c.receiverType) {
                            return c.receiverType === targetClassName ||
                                   c.receiverType === targetDef.receiver?.replace(/^\*/, '');
                        }
                        // Unique method heuristic: if the method exists on exactly one class/type, include
                        const methodDefs = this.symbols.get(symbol.name);
                        if (methodDefs) {
                            const classNames = new Set();
                            for (const d of methodDefs) {
                                if (d.className) classNames.add(d.className);
                                else if (d.receiver) classNames.add(d.receiver.replace(/^\*/, ''));
                            }
                            if (classNames.size === 1 && classNames.has(targetClassName)) return true;
                        }
                        // Unknown receiver + multiple classes with this method → filter out
                        return false;
                    });
                }

                for (const c of callers) {
                    callerFileSet.add(c.file);
                }
                totalCallSites += callers.length;

                functions.push({
                    name: symbol.name,
                    filePath: change.filePath,
                    relativePath: change.relativePath,
                    startLine: symbol.startLine,
                    endLine: symbol.endLine,
                    signature: this.formatSignature(symbol),
                    addedLines: aLines,
                    deletedLines: dLines,
                    callers: callers.map(c => ({
                        file: c.file,
                        relativePath: c.relativePath,
                        line: c.line,
                        callerName: c.callerName,
                        content: c.content.trim()
                    }))
                });
            }
        }

        return {
            base: staged ? '(staged)' : base,
            functions,
            moduleLevelChanges,
            newFunctions,
            deletedFunctions,
            summary: {
                modifiedFunctions: functions.length,
                deletedFunctions: deletedFunctions.length,
                newFunctions: newFunctions.length,
                totalCallSites,
                affectedFiles: callerFileSet.size
            }
        };
        } finally { this._endOp(); }
    }
}

/**
 * Extract all callable symbols (functions + class methods) from a parse result,
 * matching how indexFile builds the symbol list. Methods get className added.
 * @param {object} parsed - Result from parse()
 * @returns {Array<{name, className, startLine}>}
 */
function extractCallableSymbols(parsed) {
    const symbols = [];
    for (const fn of parsed.functions) {
        symbols.push({ name: fn.name, className: fn.className || '', startLine: fn.startLine });
    }
    for (const cls of parsed.classes) {
        if (cls.members) {
            for (const m of cls.members) {
                symbols.push({ name: m.name, className: cls.name, startLine: m.startLine });
            }
        }
    }
    return symbols;
}

/**
 * Unquote a git diff path: unescape C-style backslash sequences and strip tab metadata.
 * Git quotes paths containing special chars as "a/path\"with\"quotes".
 * @param {string} raw - Raw path string (may contain backslash escapes)
 * @returns {string} Unquoted path
 */
function unquoteDiffPath(raw) {
    const ESCAPES = { '\\\\': '\\', '\\"': '"', '\\n': '\n', '\\t': '\t' };
    return raw
        .split('\t')[0]
        .replace(/\\[\\"nt]/g, m => ESCAPES[m]);
}

/**
 * Parse unified diff output into structured change data
 * @param {string} diffText - Output from `git diff --unified=0`
 * @param {string} root - Project root directory
 * @returns {Array<{ filePath, relativePath, addedLines, deletedLines }>}
 */
function parseDiff(diffText, root) {
    const changes = [];
    let currentFile = null;
    let pendingOldPath = null; // Track --- a/ path for deleted files

    for (const line of diffText.split('\n')) {
        // Track old file path from --- header for deleted-file detection
        // Handles both unquoted (--- a/path) and quoted (--- "a/path") formats
        const oldMatch = line.match(/^--- (?:"a\/((?:[^"\\]|\\.)*)"|a\/(.+?))\s*$/);
        if (oldMatch) {
            const raw = oldMatch[1] !== undefined ? oldMatch[1] : oldMatch[2];
            pendingOldPath = unquoteDiffPath(raw);
            continue;
        }

        // Match file header: +++ b/path or +++ "b/path" or +++ /dev/null
        if (line.startsWith('+++ ')) {
            let relativePath;
            const isDevNull = line.startsWith('+++ /dev/null');
            if (isDevNull) {
                // File was deleted — use the --- a/ path
                if (!pendingOldPath) continue;
                relativePath = pendingOldPath;
            } else {
                const newMatch = line.match(/^\+\+\+ (?:"b\/((?:[^"\\]|\\.)*)"|b\/(.+?))\s*$/);
                if (!newMatch) continue;
                const raw = newMatch[1] !== undefined ? newMatch[1] : newMatch[2];
                relativePath = unquoteDiffPath(raw);
            }
            pendingOldPath = null;
            currentFile = {
                filePath: path.join(root, relativePath),
                relativePath,
                addedLines: [],
                deletedLines: [],
                ...(isDevNull && { isDeleted: true })
            };
            changes.push(currentFile);
            continue;
        }

        // Match hunk header: @@ -old,count +new,count @@
        if (line.startsWith('@@') && currentFile) {
            const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (match) {
                const oldStart = parseInt(match[1], 10);
                const oldCount = parseInt(match[2] || '1', 10);
                const newStart = parseInt(match[3], 10);
                const newCount = parseInt(match[4] || '1', 10);

                // Deleted lines (from old file)
                if (oldCount > 0) {
                    for (let i = 0; i < oldCount; i++) {
                        currentFile.deletedLines.push(oldStart + i);
                    }
                }

                // Added lines (in new file)
                if (newCount > 0) {
                    for (let i = 0; i < newCount; i++) {
                        currentFile.addedLines.push(newStart + i);
                    }
                }
            }
        }
    }

    return changes;
}

module.exports = { ProjectIndex, parseDiff };
