/**
 * core/project.js - Project symbol table and cross-file analysis
 *
 * Builds an in-memory index of all symbols in a project for fast queries.
 * Includes dependency weighting and disambiguation support.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { expandGlob, findProjectRoot, detectProjectPattern, isTestFile, parseGitignore, DEFAULT_IGNORES } = require('./discovery');
const { extractImports, extractExports, resolveImport } = require('./imports');
const { parse, cleanHtmlScriptTags } = require('./parser');
const { detectLanguage, getParser, getLanguageModule, safeParse, langTraits } = require('../languages');
const { getTokenTypeAtPosition } = require('../languages/utils');
const { escapeRegExp, NON_CALLABLE_TYPES } = require('./shared');
const stacktrace = require('./stacktrace');
const indexCache = require('./cache');
const deadcodeModule = require('./deadcode');
const verifyModule = require('./verify');
const callersModule = require('./callers');
const tracingModule = require('./tracing');
const searchModule = require('./search');
const analysisModule = require('./analysis');
const graphModule = require('./graph');
const reportingModule = require('./reporting');

// Lazy-initialized per-language keyword sets (populated on first isKeyword call)
let LANGUAGE_KEYWORDS = null;

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
            this._opCallsCountCache = new Map();
            this._opDepth = 0;
        }
        this._opDepth++;
    }

    /** End a per-operation content cache scope (only clears when outermost scope ends) */
    _endOp() {
        if (--this._opDepth <= 0) {
            this._opContentCache = null;
            this._opUsagesCache = null;
            this._opCallsCountCache = null;
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

        // Try parallel build for large projects
        const workersSetting = options.workers;
        const envWorkers = parseInt(process.env.UCN_WORKERS, 10);
        const disableParallel = workersSetting === 0 || envWorkers === 0;
        let usedParallel = false;

        if (!disableParallel && files.length > 500) {
            try {
                const { parallelBuild } = require('./parallel-build');
                const result = parallelBuild(this, files, {
                    workerCount: workersSetting > 0 ? workersSetting : (envWorkers > 0 ? envWorkers : undefined),
                    quiet,
                });
                if (result !== false) {
                    changed = result;
                    indexed = files.length;
                    usedParallel = true;
                }
            } catch (e) {
                if (!quiet) {
                    console.error(`Parallel build failed, falling back to sequential: ${e.message}`);
                }
            }
        }

        if (!usedParallel) {
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
        }

        // Skip graph rebuild when incremental rebuild found no changes
        if (changed > 0 || deletedInRebuild > 0 || !options.forceRebuild) {
            this.buildImportGraph();
            this.buildInheritanceGraph();
        }

        // Build directory→files index for O(1) same-package lookups
        this._buildDirIndex();

        // Build callee index eagerly: leverages warm parse cache from indexFile() above,
        // avoiding the 2+ minute deferred cost when the first analysis command runs later.
        this.buildCalleeIndex();

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
        // Count lines without splitting: count newlines + 1 (avoids allocating array)
        let lineCount = 1;
        let longLineCount = 0;
        let lineStart = 0;
        for (let ci = 0; ci < content.length; ci++) {
            if (content.charCodeAt(ci) === 10) { // '\n'
                if (ci - lineStart > 1000) longLineCount++;
                lineStart = ci + 1;
                lineCount++;
            }
        }
        // Handle last line (no trailing newline)
        if (content.length - lineStart > 1000) longLineCount++;

        const isBundled = (() => {
            // Webpack bundles contain __webpack_require__ or __webpack_modules__
            if (content.includes('__webpack_require__') || content.includes('__webpack_modules__')) return true;
            // Minified files: very few lines but large content (avg > 500 chars/line)
            if (lineCount > 0 && lineCount < 50 && content.length / lineCount > 500) return true;
            // Very long single lines (> 1000 chars) in most of the file suggest minification
            if (lineCount > 0 && longLineCount > 0 && longLineCount / lineCount > 0.3) return true;
            return false;
        })();

        // Detect auto-generated files (e.g., Go client-gen, protobuf, code generators).
        // Check first ~500 chars for common markers. These files are indexed but
        // deprioritized in resolveSymbol() scoring.
        const isGenerated = /^\/\/\s*Code generated\b|^\/\/\s*DO NOT EDIT|^\/\/ @generated|^# Generated by/m.test(
            content.slice(0, 500)
        );

        const fileEntry = {
            path: filePath,
            relativePath: path.relative(this.root, filePath),
            language,
            lines: lineCount,
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
            ...(isBundled && { isBundled: true }),
            ...(isGenerated && { isGenerated: true })
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
                ...(item.nameLine && { nameLine: item.nameLine }),
                ...(item.traitImpl && { traitImpl: true }),
                ...(item.isSignature && { isSignature: true })
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
                    addSymbol({ ...m, className: cls.name, ...(cls.traitName && { traitImpl: true }) }, memberType);
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
     * Build directory→files index for O(1) same-package lookups.
     * Replaces O(N) full-index scans in findCallers and countSymbolUsages.
     */
    _buildDirIndex() {
        this.dirToFiles = new Map();
        for (const filePath of this.files.keys()) {
            const dir = path.dirname(filePath);
            let list = this.dirToFiles.get(dir);
            if (!list) {
                list = [];
                this.dirToFiles.set(dir, list);
            }
            list.push(filePath);
        }
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
            // Fast path: use pre-populated callsCache (avoids stat per file)
            const cached = this.callsCache.get(filePath);
            const calls = cached ? cached.calls : getCachedCalls(this, filePath);
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
            if (langTraits(fe.language)?.packageScope === 'directory') {
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
                    if (langTraits(fileEntry.language)?.packageScope === 'directory') {
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
            // '.' means current directory = entire project, always matches
            if (inPattern === '.') return true;
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
            // Deprioritize auto-generated files (client-gen, protobuf, etc.)
            // Light penalty (-100): generated code checked into the repo is often
            // first-class API surface (Go client-gen, Java GRPC stubs), so prefer
            // hand-written code but don't bury generated definitions.
            const fileEntry = this.files.get(d.file);
            if (fileEntry?.isGenerated) {
                score -= 100;
            }
            // Boost lib/src/core/internal directories (+200)
            if (/^(lib|src|core|internal|pkg|crates)\//i.test(rp)) {
                score += 200;
            }
            // Deprioritize type-only overload signatures (TypeScript function_signature)
            if (d.isSignature) score -= 200;
            // Prefer larger function bodies (implementation over overload signature)
            // Only for functions/methods — not for class-level types (struct vs impl)
            if (d.startLine && d.endLine && d.type === 'function') {
                score += Math.min(d.endLine - d.startLine, 100);
            }
            // Prefer shallower paths (fewer directory levels = more central to project)
            // Max bonus 50 for root-level files, decreasing with depth
            const depth = (rp.match(/\//g) || []).length;
            score += Math.max(0, 50 - depth * 10);
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
                if (langTraits(candidateEntry?.language)?.packageScope === 'directory') {
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
            const others = definitions.filter(d => d !== def);
            const shown = others.slice(0, 5);
            const extra = others.length - shown.length;
            const alsoIn = shown.map(d => `${d.relativePath}:${d.startLine}`).join(', ');
            const suffix = extra > 0 ? `, and ${extra} more` : '';
            warnings.push({
                type: 'ambiguous',
                message: `Found ${definitions.length} definitions for "${name}". Using ${def.relativePath}:${def.startLine}. Also in: ${alsoIn}${suffix}. Use file= to disambiguate.`,
                alternatives: others.map(d => ({
                    file: d.relativePath,
                    line: d.startLine
                }))
            });
        }

        return { def, definitions, warnings };
    }

    find(name, options) { return searchModule.find(this, name, options); }

    _applyFindFilters(matches, options) { return searchModule._applyFindFilters(this, matches, options); }


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

            // Pre-compute which files can reference THIS specific definition
            const importers = this.exportGraph.get(defFile) || [];
            const importersSet = new Set(importers);
            const defEntry = this.files.get(defFile);
            const isDirectoryScope = langTraits(defEntry?.language)?.packageScope === 'directory';
            const defDir = isDirectoryScope ? path.dirname(defFile) : null;

            // Count calls from callee index, filtered per-definition.
            // Use per-operation cache to avoid re-iterating getCachedCalls for the same name
            // (e.g., `find Run` with 268 definitions sharing the name "Run").
            let perFileCallCounts;
            if (this._opCallsCountCache && this._opCallsCountCache.has(name)) {
                perFileCallCounts = this._opCallsCountCache.get(name);
            } else {
                perFileCallCounts = new Map();
                const calleeFiles = this.calleeIndex.get(name);
                if (calleeFiles) {
                    const { getCachedCalls } = require('./callers');
                    for (const fp of calleeFiles) {
                        const fileCalls = getCachedCalls(this, fp);
                        if (!fileCalls) continue;
                        let fileCount = 0;
                        for (const c of fileCalls) {
                            if (c.name === name || c.resolvedName === name ||
                                (c.resolvedNames && c.resolvedNames.includes(name))) {
                                fileCount++;
                            }
                        }
                        if (fileCount > 0) perFileCallCounts.set(fp, fileCount);
                    }
                }
                if (this._opCallsCountCache) {
                    this._opCallsCountCache.set(name, perFileCallCounts);
                }
            }

            // Sum calls only from files that can reference THIS definition
            let calls = 0;
            for (const [fp, count] of perFileCallCounts) {
                if (hasFilters) {
                    const fe = this.files.get(fp);
                    if (fe && !this.matchesFilters(fe.relativePath, { exclude: options.exclude })) continue;
                }
                // Per-definition filtering for directory-scoped languages (Go/Java/Rust):
                // only count calls from files that import from defFile, are in the same
                // package, or are the definition file itself. For structural type systems
                // (JS/TS/Python), skip this filter — method calls can come from files
                // without import relationships (objects passed as parameters, etc.)
                if (isDirectoryScope && fp !== defFile && !importersSet.has(fp)) {
                    if (path.dirname(fp) !== defDir) continue;
                }
                calls += count;
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
            for (const importer of importers) {
                const fe = this.files.get(importer);
                if (!fe) continue;
                if (hasFilters && !this.matchesFilters(fe.relativePath, { exclude: options.exclude })) continue;
                // Check if this file's importNames reference our symbol
                if (fe.importNames && fe.importNames.includes(name)) {
                    imports++;
                }
            }
            // Same-package: files in same directory don't need imports to reference symbols
            if (isDirectoryScope) {
                const pkgDir = defDir;
                for (const [fp, fe] of this.files) {
                    if (fp === defFile || !fp.endsWith('.go') || path.dirname(fp) !== pkgDir) continue;
                    if (hasFilters && !this.matchesFilters(fe.relativePath, { exclude: options.exclude })) continue;
                    // Check if already counted as importer
                    if (importersSet.has(fp)) continue;
                    // Check callee index for actual calls from this file
                    if (perFileCallCounts.has(fp)) {
                        // Already counted in calls — don't double-count
                        continue;
                    }
                    // Check if this same-package file has text references to the symbol
                    if (fe.importNames && fe.importNames.includes(name)) {
                        imports++;
                    }
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

        // Same-package: add all files in the same directory (Go package scope)
        const defEntry = this.files.get(defFile);
        if (langTraits(defEntry?.language)?.packageScope === 'directory') {
            const pkgDir = path.dirname(defFile);
            const siblings = this.dirToFiles?.get(pkgDir) || [];
            for (const fp of siblings) {
                if (fp !== defFile) {
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
    usages(name, options) { return searchModule.usages(this, name, options); }

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
    context(name, options) { return analysisModule.context(this, name, options); }

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

    /** Smart extraction: function + dependencies */
    smart(name, options) { return analysisModule.smart(this, name, options); }

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
            // Find the Nth line without splitting the entire file
            let start = 0;
            for (let i = 1; i < lineNum; i++) {
                start = content.indexOf('\n', start) + 1;
                if (start === 0) return '';
            }
            const end = content.indexOf('\n', start);
            return end === -1 ? content.slice(start) : content.slice(start, end);
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
    imports(filePath) { return graphModule.imports(this, filePath); }

    /**
     * Get files that import a given file
     * @param {string} filePath - File to check
     * @returns {Array} Files that import this file
     */
    exporters(filePath) { return graphModule.exporters(this, filePath); }

    /**
     * Find type definitions
     * @param {string} name - Type name to find
     * @returns {Array} Matching type definitions
     */
    typedef(name, options) { return searchModule.typedef(this, name, options); }

    /**
     * Find tests for a function or file
     * @param {string} nameOrFile - Function name or file path
     * @returns {Array} Test files and matches
     */
    tests(nameOrFile, options) { return searchModule.tests(this, nameOrFile, options); }

    /**
     * Get all exported/public symbols
     * @param {string} [filePath] - Optional file to limit to
     * @returns {Array} Exported symbols
     */
    api(filePath, options = {}) { return graphModule.api(this, filePath, options); }

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
    fileExports(filePath, _visited) { return graphModule.fileExports(this, filePath, _visited); }

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
    graph(filePath, options = {}) { return graphModule.graph(this, filePath, options); }

    /**
     * Detect circular dependencies in the import graph.
     * Uses DFS with 3-color marking to find all cycles.
     * @param {object} options - { file, exclude }
     * @returns {object} - { cycles, totalFiles, summary }
     */
    circularDeps(options = {}) { return graphModule.circularDeps(this, options); }

    /**
     * Detect patterns that may cause incomplete results
     * Returns warnings about dynamic code patterns
     * Cached to avoid rescanning on every query
     */
    detectCompleteness() { return analysisModule.detectCompleteness(this); }


    /** Find related functions — same file, similar names, shared dependencies */
    related(name, options) { return analysisModule.related(this, name, options); }

    /**
     * Trace call flow - show call tree visualization
     * This is the "what calls what" command
     *
     * @param {string} name - Function name to trace from
     * @param {object} options - { depth, direction }
     * @returns {object} Call tree structure
     */
    trace(name, options) { return tracingModule.trace(this, name, options); }

    /** Impact analysis — what call sites need updating if a function changes */
    impact(name, options) { return analysisModule.impact(this, name, options); }

    /**
     * Transitive blast radius — walk UP the caller chain recursively.
     * Answers: "What breaks transitively if I change this function?"
     *
     * @param {string} name - Function name
     * @param {object} options - { depth, file, className, all, exclude, includeMethods, includeUncertain }
     * @returns {object|null} Blast radius tree with summary
     */
    blast(name, options) { return tracingModule.blast(this, name, options); }

    /**
     * Reverse trace: walk UP the caller chain to entry points.
     * Like blast but focused on "how does execution reach this function?"
     * Marks leaf nodes (functions with no callers) as entry points.
     */
    reverseTrace(name, options) { return tracingModule.reverseTrace(this, name, options); }

    /**
     * Find tests affected by a change to the given function.
     * Composes blast() (transitive callers) with test file scanning.
     */
    affectedTests(name, options) { return tracingModule.affectedTests(this, name, options); }

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

    /** About: comprehensive symbol metadata */
    about(name, options) { return analysisModule.about(this, name, options); }

    search(term, options) { return searchModule.search(this, term, options); }

    structuralSearch(options) { return searchModule.structuralSearch(this, options); }

    // ========================================================================
    // PROJECT INFO
    // ========================================================================

    /**
     * Get project statistics
     */
    getStats(options) { return reportingModule.getStats(this, options); }

    getToc(options) { return reportingModule.getToc(this, options); }

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
    example(name, options) { return searchModule.example(this, name, options); }

    /** Analyze a call site using AST for example scoring */
    _analyzeCallSiteAST(filePath, lineNum, funcName) { return verifyModule.analyzeCallSiteAST(this, filePath, lineNum, funcName); }

    /** Diff-based impact analysis: find which functions changed and who calls them */
    diffImpact(options) { return analysisModule.diffImpact(this, options); }
}

const { parseDiff } = require('./analysis');

module.exports = { ProjectIndex, parseDiff };
