/**
 * core/project.js - Project symbol table and cross-file analysis
 *
 * Builds an in-memory index of all symbols in a project for fast queries.
 * Includes dependency weighting and disambiguation support.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { expandGlob, findProjectRoot, detectProjectPattern, isTestFile } = require('./discovery');
const { extractImports, extractExports, resolveImport } = require('./imports');
const { parseFile } = require('./parser');
const { detectLanguage, getParser, getLanguageModule, PARSE_OPTIONS } = require('../languages');
const { getTokenTypeAtPosition } = require('../languages/utils');

/**
 * Escape special regex characters
 */
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        this.extendsGraph = new Map();    // className -> parentName
        this.extendedByGraph = new Map(); // parentName -> [childInfo]
        this.config = this.loadConfig();
        this.buildTime = null;
        this.callsCache = new Map();     // filePath -> { mtime, hash, calls, content }
    }

    /**
     * Load .ucn.js config if present
     */
    loadConfig() {
        const configPath = path.join(this.root, '.ucn.js');
        if (fs.existsSync(configPath)) {
            try {
                delete require.cache[require.resolve(configPath)];
                return require(configPath);
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

        const files = expandGlob(pattern, {
            root: this.root,
            maxFiles: options.maxFiles || 10000,
            followSymlinks: options.followSymlinks
        });

        if (!quiet) {
            console.error(`Indexing ${files.length} files in ${this.root}...`);
        }

        if (options.forceRebuild) {
            this.files.clear();
            this.symbols.clear();
            this.importGraph.clear();
            this.exportGraph.clear();
        }

        let indexed = 0;
        for (const file of files) {
            try {
                this.indexFile(file);
                indexed++;
            } catch (e) {
                if (!quiet) {
                    console.error(`  Warning: Could not index ${file}: ${e.message}`);
                }
            }
        }

        this.buildImportGraph();
        this.buildInheritanceGraph();

        this.buildTime = Date.now() - startTime;

        if (!quiet) {
            console.error(`Index complete: ${this.symbols.size} symbols in ${indexed} files (${this.buildTime}ms)`);
        }
    }

    /**
     * Index a single file
     */
    indexFile(filePath) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const hash = crypto.createHash('md5').update(content).digest('hex');
        const stat = fs.statSync(filePath);

        // Check if already indexed and unchanged
        const existing = this.files.get(filePath);
        if (existing && existing.hash === hash && existing.mtime === stat.mtimeMs) {
            return;
        }

        if (existing) {
            this.removeFileSymbols(filePath);
        }

        const language = detectLanguage(filePath);
        if (!language) return;

        const parsed = parseFile(filePath);
        const { imports } = extractImports(content, language);
        const { exports } = extractExports(content, language);

        const fileEntry = {
            path: filePath,
            relativePath: path.relative(this.root, filePath),
            language,
            lines: content.split('\n').length,
            hash,
            mtime: stat.mtimeMs,
            size: stat.size,
            imports: imports.map(i => i.module),
            exports: exports.map(e => e.name),
            symbols: []
        };

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
                ...(item.extends && { extends: item.extends }),
                ...(item.implements && { implements: item.implements }),
                ...(item.indent !== undefined && { indent: item.indent }),
                ...(item.isNested && { isNested: item.isNested }),
                ...(item.isMethod && { isMethod: item.isMethod }),
                ...(item.receiver && { receiver: item.receiver }),
                ...(item.className && { className: item.className }),
                ...(item.memberType && { memberType: item.memberType })
            };
            fileEntry.symbols.push(symbol);

            if (!this.symbols.has(item.name)) {
                this.symbols.set(item.name, []);
            }
            this.symbols.get(item.name).push(symbol);
        };

        for (const fn of parsed.functions) {
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
    }

    /**
     * Build import/export relationship graphs
     */
    buildImportGraph() {
        this.importGraph.clear();
        this.exportGraph.clear();

        for (const [filePath, fileEntry] of this.files) {
            const importedFiles = [];

            for (const importModule of fileEntry.imports) {
                const resolved = resolveImport(importModule, filePath, {
                    aliases: this.config.aliases,
                    language: fileEntry.language,
                    root: this.root
                });

                if (resolved && this.files.has(resolved)) {
                    importedFiles.push(resolved);

                    if (!this.exportGraph.has(resolved)) {
                        this.exportGraph.set(resolved, []);
                    }
                    this.exportGraph.get(resolved).push(filePath);
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

        for (const [filePath, fileEntry] of this.files) {
            for (const symbol of fileEntry.symbols) {
                if (!['class', 'interface', 'struct', 'trait'].includes(symbol.type)) {
                    continue;
                }

                if (symbol.extends) {
                    this.extendsGraph.set(symbol.name, symbol.extends);

                    if (!this.extendedByGraph.has(symbol.extends)) {
                        this.extendedByGraph.set(symbol.extends, []);
                    }
                    this.extendedByGraph.get(symbol.extends).push({
                        name: symbol.name,
                        type: symbol.type,
                        file: filePath
                    });
                }
            }
        }
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
        if (filters.exclude && filters.exclude.length > 0) {
            const lowerPath = filePath.toLowerCase();
            for (const pattern of filters.exclude) {
                if (lowerPath.includes(pattern.toLowerCase())) {
                    return false;
                }
            }
        }

        // Check inclusion (must be within specified directory)
        if (filters.in) {
            if (!filePath.includes(filters.in)) {
                return false;
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
        const words = lowerTarget.split(/(?=[A-Z])|_|-/);
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
    find(name, options = {}) {
        const matches = this.symbols.get(name) || [];

        if (matches.length === 0) {
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

        // Apply filters
        let filtered = matches;

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
     * Count usages of a symbol across the codebase
     */
    countUsages(name) {
        let count = 0;
        const regex = new RegExp('\\b' + escapeRegExp(name) + '\\b', 'g');

        for (const [filePath, fileEntry] of this.files) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const matches = content.match(regex);
                if (matches) count += matches.length;
            } catch (e) {
                // Skip unreadable files
            }
        }

        return count;
    }

    /**
     * Count usages of a specific symbol (not just by name)
     * Only counts usages in files that could reference this specific definition
     * @param {object} symbol - Symbol with file, name, etc.
     * @returns {object} { total, calls, definitions, imports, references }
     */
    countSymbolUsages(symbol) {
        const name = symbol.name;
        const defFile = symbol.file;
        // Note: no 'g' flag - we only need to test for presence per line
        const regex = new RegExp('\\b' + escapeRegExp(name) + '\\b');

        // Get files that could reference this symbol:
        // 1. The file where it's defined
        // 2. Files that import from the definition file
        const relevantFiles = new Set([defFile]);
        const importers = this.exportGraph.get(defFile) || [];
        for (const importer of importers) {
            relevantFiles.add(importer);
        }

        let calls = 0;
        let definitions = 0;
        let imports = 0;
        let references = 0;

        for (const filePath of relevantFiles) {
            if (!this.files.has(filePath)) continue;

            try {
                const content = fs.readFileSync(filePath, 'utf-8');

                // Try AST-based counting first
                const language = detectLanguage(filePath);
                const langModule = getLanguageModule(language);

                if (langModule && typeof langModule.findUsagesInCode === 'function') {
                    try {
                        const parser = getParser(language);
                        if (parser) {
                            const usages = langModule.findUsagesInCode(content, name, parser);
                            for (const u of usages) {
                                switch (u.usageType) {
                                    case 'call': calls++; break;
                                    case 'definition': definitions++; break;
                                    case 'import': imports++; break;
                                    default: references++; break;
                                }
                            }
                            continue; // Skip to next file
                        }
                    } catch (e) {
                        // Fall through to regex-based counting
                    }
                }

                // Fallback: count regex matches as references (unsupported language)
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
        const usages = [];

        // Get definitions (filtered)
        const allDefinitions = this.symbols.get(name) || [];
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
                const content = fs.readFileSync(filePath, 'utf-8');
                const lines = content.split('\n');

                // Try AST-based detection first
                const lang = detectLanguage(filePath);
                const langModule = getLanguageModule(lang);

                if (langModule && typeof langModule.findUsagesInCode === 'function') {
                    // AST-based detection
                    try {
                        const parser = getParser(lang);
                        if (parser) {
                            const astUsages = langModule.findUsagesInCode(content, name, parser);

                            for (const u of astUsages) {
                                // Skip if this is a definition line (already added above)
                                if (definitions.some(d => d.file === filePath && d.startLine === u.line)) {
                                    continue;
                                }

                                const lineContent = lines[u.line - 1] || '';

                                const usage = {
                                    file: filePath,
                                    relativePath: fileEntry.relativePath,
                                    line: u.line,
                                    content: lineContent,
                                    usageType: u.usageType,
                                    isDefinition: false
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
                    } catch (e) {
                        // Fall through to regex-based detection
                    }
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

        return usages;
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
                if (symbol.isMethod && symbol.receiver) {
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
        const definitions = this.symbols.get(name) || [];
        if (definitions.length === 0) {
            return { function: name, file: null, callers: [], callees: [] };
        }

        // Prefer class/struct/interface definitions over functions/methods/constructors
        // This ensures context('ClassName') finds the class, not a constructor with same name
        const typeOrder = ['class', 'struct', 'interface', 'type', 'impl'];
        let def = definitions[0];
        for (const d of definitions) {
            if (typeOrder.includes(d.type)) {
                def = d;
                break;
            }
        }

        // Special handling for class/struct/interface types
        if (['class', 'struct', 'interface', 'type'].includes(def.type)) {
            const methods = this.findMethodsForType(name);

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
                callers: this.findCallers(name, { includeMethods: options.includeMethods })
            };

            if (definitions.length > 1) {
                result.warnings = [{
                    type: 'ambiguous',
                    message: `Found ${definitions.length} definitions for "${name}". Using ${def.relativePath}:${def.startLine}. Use --file to disambiguate.`,
                    alternatives: definitions.slice(1).map(d => ({
                        file: d.relativePath,
                        line: d.startLine
                    }))
                }];
            }

            return result;
        }

        const callers = this.findCallers(name, { includeMethods: options.includeMethods });
        const callees = this.findCallees(def, { includeMethods: options.includeMethods });

        const result = {
            function: name,
            file: def.relativePath,
            startLine: def.startLine,
            endLine: def.endLine,
            params: def.params,
            returnType: def.returnType,
            callers,
            callees
        };

        // Add disambiguation warning if multiple definitions exist
        if (definitions.length > 1) {
            result.warnings = [{
                type: 'ambiguous',
                message: `Found ${definitions.length} definitions for "${name}". Using ${def.relativePath}:${def.startLine}. Use --file to disambiguate.`,
                alternatives: definitions.slice(1).map(d => ({
                    file: d.relativePath,
                    line: d.startLine
                }))
            }];
        }

        return result;
    }

    /**
     * Get cached calls for a file, parsing if necessary
     * Uses mtime for fast cache validation, falls back to hash if mtime matches but content changed
     * @param {string} filePath - Path to the file
     * @param {object} [options] - Options
     * @param {boolean} [options.includeContent] - Also return file content (avoids double read)
     * @returns {Array|null|{calls: Array, content: string}} Array of calls, or object with content if requested
     */
    getCachedCalls(filePath, options = {}) {
        try {
            const cached = this.callsCache.get(filePath);

            // Fast path: check mtime first (stat is much faster than read+hash)
            const stat = fs.statSync(filePath);
            const mtime = stat.mtimeMs;

            if (cached && cached.mtime === mtime) {
                // mtime matches - cache is likely valid
                if (options.includeContent) {
                    // Need content, read if not cached
                    const content = cached.content || fs.readFileSync(filePath, 'utf-8');
                    return { calls: cached.calls, content };
                }
                return cached.calls;
            }

            // mtime changed or no cache - need to read and possibly reparse
            const content = fs.readFileSync(filePath, 'utf-8');
            const hash = crypto.createHash('md5').update(content).digest('hex');

            // Check if content actually changed (mtime can change without content change)
            if (cached && cached.hash === hash) {
                // Content unchanged, just update mtime
                cached.mtime = mtime;
                cached.content = options.includeContent ? content : undefined;
                if (options.includeContent) {
                    return { calls: cached.calls, content };
                }
                return cached.calls;
            }

            // Content changed - need to reparse
            const language = detectLanguage(filePath);
            if (!language) return null;

            const langModule = getLanguageModule(language);
            if (!langModule.findCallsInCode) return null;

            const parser = getParser(language);
            const calls = langModule.findCallsInCode(content, parser);

            this.callsCache.set(filePath, {
                mtime,
                hash,
                calls,
                content: options.includeContent ? content : undefined
            });

            if (options.includeContent) {
                return { calls, content };
            }
            return calls;
        } catch (e) {
            return null;
        }
    }

    /**
     * Find all callers of a function using AST-based detection
     * @param {string} name - Function name to find callers for
     * @param {object} [options] - Options
     * @param {boolean} [options.includeMethods] - Include method calls (default: false)
     */
    findCallers(name, options = {}) {
        const callers = [];

        // Get definition lines to exclude them
        const definitions = this.symbols.get(name) || [];
        const definitionLines = new Set();
        for (const def of definitions) {
            definitionLines.add(`${def.file}:${def.startLine}`);
        }

        for (const [filePath, fileEntry] of this.files) {
            try {
                const result = this.getCachedCalls(filePath, { includeContent: true });
                if (!result) continue;

                const { calls, content } = result;
                const lines = content.split('\n');

                for (const call of calls) {
                    // Skip if not matching our target name
                    if (call.name !== name) continue;

                    // Smart method call handling
                    if (call.isMethod) {
                        // Always skip this/self/cls calls (internal state access, not function calls)
                        if (['this', 'self', 'cls'].includes(call.receiver)) continue;
                        // Go doesn't use this/self/cls - always include Go method calls
                        // For other languages, skip method calls unless explicitly requested
                        if (fileEntry.language !== 'go' && !options.includeMethods) continue;
                    }

                    // Skip definition lines
                    if (definitionLines.has(`${filePath}:${call.line}`)) continue;

                    // Find the enclosing function (get full symbol info)
                    const callerSymbol = this.findEnclosingFunction(filePath, call.line, true);

                    callers.push({
                        file: filePath,
                        relativePath: fileEntry.relativePath,
                        line: call.line,
                        content: lines[call.line - 1] || '',
                        callerName: callerSymbol ? callerSymbol.name : null,
                        callerFile: callerSymbol ? filePath : null,
                        callerStartLine: callerSymbol ? callerSymbol.startLine : null,
                        callerEndLine: callerSymbol ? callerSymbol.endLine : null,
                        isMethod: call.isMethod || false,
                        receiver: call.receiver
                    });
                }
            } catch (e) {
                // Skip files that can't be processed
            }
        }

        return callers;
    }

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

            const tree = parser.parse(content, undefined, PARSE_OPTIONS);

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

    /**
     * Find all functions called by a function using AST-based detection
     * @param {object} def - Symbol definition with file, name, startLine, endLine
     * @param {object} [options] - Options
     * @param {boolean} [options.includeMethods] - Include method calls (default: false)
     */
    findCallees(def, options = {}) {
        try {
            // Get all calls from the file's cache (now includes enclosingFunction)
            const calls = this.getCachedCalls(def.file);
            if (!calls) return [];

            const callees = new Map();  // name -> count

            for (const call of calls) {
                // Filter to calls within this function's scope using enclosingFunction
                if (!call.enclosingFunction) continue;
                if (call.enclosingFunction.name !== def.name) continue;
                if (call.enclosingFunction.startLine !== def.startLine) continue;

                // Skip method calls unless explicitly requested
                if (call.isMethod && !options.includeMethods) continue;

                // Skip keywords and built-ins
                if (this.isKeyword(call.name)) continue;

                callees.set(call.name, (callees.get(call.name) || 0) + 1);
            }

            // Look up each callee in the symbol table
            const result = [];
            for (const [calleeName, count] of callees) {
                const symbols = this.symbols.get(calleeName);
                if (symbols && symbols.length > 0) {
                    const callee = symbols[0];
                    result.push({
                        ...callee,
                        callCount: count,
                        weight: this.calculateWeight(count)
                    });
                }
            }

            // Sort by call count (core dependencies first)
            result.sort((a, b) => b.callCount - a.callCount);

            return result;
        } catch (e) {
            return [];
        }
    }

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
        const definitions = this.symbols.get(name) || [];
        if (definitions.length === 0) {
            return null;
        }

        const def = definitions[0];
        const code = this.extractCode(def);
        const callees = this.findCallees(def, { includeMethods: options.includeMethods });

        // Extract code for each dependency, excluding the main function itself
        const dependencies = callees
            .filter(callee => callee.name !== name)  // Don't include self
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
            types
        };
    }

    // ========================================================================
    // HELPER METHODS
    // ========================================================================

    /**
     * Get line content from a file
     */
    getLineContent(filePath, lineNum) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
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
            const content = fs.readFileSync(symbol.file, 'utf-8');
            const lines = content.split('\n');
            return lines.slice(symbol.startLine - 1, symbol.endLine).join('\n');
        } catch (e) {
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

            const tree = parser.parse(content, undefined, PARSE_OPTIONS);
            const tokenType = getTokenTypeAtPosition(tree.rootNode, lineNum, column);
            return tokenType === 'comment' || tokenType === 'string';
        } catch (e) {
            return false; // On error, assume code
        }
    }

    /**
     * Check if a name is a language keyword
     */
    isKeyword(name) {
        const keywords = new Set([
            'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
            'continue', 'return', 'function', 'class', 'const', 'let', 'var',
            'new', 'this', 'super', 'import', 'export', 'default', 'from',
            'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
            'typeof', 'instanceof', 'in', 'of', 'delete', 'void', 'with',
            'def', 'print', 'range', 'len', 'str', 'int', 'float', 'list',
            'dict', 'set', 'tuple', 'True', 'False', 'None', 'self', 'cls',
            'func', 'type', 'struct', 'interface', 'package', 'make', 'append',
            'fn', 'impl', 'pub', 'mod', 'use', 'crate', 'self', 'super',
            'match', 'loop', 'unsafe', 'move', 'ref', 'mut', 'where'
        ]);
        return keywords.has(name);
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

        for (const symbol of fileEntry.symbols) {
            if (symbol.type === 'function' &&
                symbol.startLine <= lineNum &&
                symbol.endLine >= lineNum) {
                if (returnSymbol) {
                    return symbol;
                }
                return symbol.name;
            }
        }
        return null;
    }

    /**
     * Extract type names from a function definition
     */
    extractTypeNames(def) {
        const types = new Set();

        // From params
        if (def.paramsStructured) {
            for (const param of def.paramsStructured) {
                if (param.type) {
                    // Extract base type name (before < or [)
                    const match = param.type.match(/^([A-Z]\w*)/);
                    if (match) types.add(match[1]);
                }
            }
        }

        // From return type
        if (def.returnType) {
            const match = def.returnType.match(/^([A-Z]\w*)/);
            if (match) types.add(match[1]);
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
        const normalizedPath = path.isAbsolute(filePath)
            ? filePath
            : path.join(this.root, filePath);

        const fileEntry = this.files.get(normalizedPath);
        if (!fileEntry) {
            // Try to find by relative path
            for (const [absPath, entry] of this.files) {
                if (entry.relativePath === filePath || absPath.endsWith(filePath)) {
                    return this.imports(absPath);
                }
            }
            return [];
        }

        try {
            const content = fs.readFileSync(normalizedPath, 'utf-8');
            const { imports: rawImports } = extractImports(content, fileEntry.language);

            return rawImports.map(imp => {
                const resolved = resolveImport(imp.module, normalizedPath, {
                    aliases: this.config.aliases,
                    language: fileEntry.language,
                    root: this.root
                });

                // Find line number of import
                const lines = content.split('\n');
                let line = null;
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes(imp.module)) {
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
        const normalizedPath = path.isAbsolute(filePath)
            ? filePath
            : path.join(this.root, filePath);

        // Try to find the file
        let targetPath = normalizedPath;
        if (!this.files.has(normalizedPath)) {
            for (const [absPath, entry] of this.files) {
                if (entry.relativePath === filePath || absPath.endsWith(filePath)) {
                    targetPath = absPath;
                    break;
                }
            }
        }

        const importers = this.exportGraph.get(targetPath) || [];

        return importers.map(importerPath => {
            const fileEntry = this.files.get(importerPath);

            // Find the import line
            let importLine = null;
            try {
                const content = fs.readFileSync(importerPath, 'utf-8');
                const lines = content.split('\n');
                const targetRelative = path.relative(this.root, targetPath);
                const targetBasename = path.basename(targetPath, path.extname(targetPath));

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
    typedef(name) {
        const typeKinds = ['type', 'interface', 'enum', 'struct', 'trait', 'class'];
        const matches = this.find(name);

        return matches.filter(m => typeKinds.includes(m.type));
    }

    /**
     * Find tests for a function or file
     * @param {string} nameOrFile - Function name or file path
     * @returns {Array} Test files and matches
     */
    tests(nameOrFile) {
        const results = [];

        // Check if it's a file path
        const isFilePath = nameOrFile.includes('/') || nameOrFile.includes('\\') ||
            nameOrFile.endsWith('.js') || nameOrFile.endsWith('.ts') ||
            nameOrFile.endsWith('.py') || nameOrFile.endsWith('.go') ||
            nameOrFile.endsWith('.java') || nameOrFile.endsWith('.rs');

        // Find all test files
        const testFiles = [];
        for (const [filePath, fileEntry] of this.files) {
            if (isTestFile(filePath, fileEntry.language)) {
                testFiles.push({ path: filePath, entry: fileEntry });
            }
        }

        const searchTerm = isFilePath
            ? path.basename(nameOrFile, path.extname(nameOrFile))
            : nameOrFile;

        // Note: no 'g' flag - we only need to test for presence per line
        // The 'i' flag is kept for case-insensitive matching
        const regex = new RegExp('\\b' + escapeRegExp(searchTerm) + '\\b', 'i');

        for (const { path: testPath, entry } of testFiles) {
            try {
                const content = fs.readFileSync(testPath, 'utf-8');
                const lines = content.split('\n');
                const matches = [];

                lines.forEach((line, idx) => {
                    if (regex.test(line)) {
                        let matchType = 'reference';
                        if (/\b(describe|it|test|spec)\s*\(/.test(line)) {
                            matchType = 'test-case';
                        } else if (/\b(import|require|from)\b/.test(line)) {
                            matchType = 'import';
                        } else if (new RegExp(searchTerm + '\\s*\\(').test(line)) {
                            matchType = 'call';
                        }

                        matches.push({
                            line: idx + 1,
                            content: line.trim(),
                            matchType
                        });
                    }
                });

                if (matches.length > 0) {
                    results.push({
                        file: entry.relativePath,
                        matches
                    });
                }
            } catch (e) {
                // Skip unreadable files
            }
        }

        return results;
    }

    /**
     * Get all exported/public symbols
     * @param {string} [filePath] - Optional file to limit to
     * @returns {Array} Exported symbols
     */
    api(filePath) {
        const results = [];

        const filesToCheck = filePath
            ? [this.findFile(filePath)].filter(Boolean)
            : Array.from(this.files.entries());

        for (const [absPath, fileEntry] of (filePath ? [[this.findFile(filePath), this.files.get(this.findFile(filePath))]] : this.files.entries())) {
            if (!fileEntry) continue;

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
        }

        return results;
    }

    /**
     * Find a file by path (supports partial paths)
     */
    findFile(filePath) {
        const normalizedPath = path.isAbsolute(filePath)
            ? filePath
            : path.join(this.root, filePath);

        if (this.files.has(normalizedPath)) {
            return normalizedPath;
        }

        // Try partial match
        for (const [absPath, entry] of this.files) {
            if (entry.relativePath === filePath || absPath.endsWith(filePath)) {
                return absPath;
            }
        }

        return null;
    }

    /**
     * Get exports for a specific file
     * @param {string} filePath - File path
     * @returns {Array} Exported symbols from that file
     */
    fileExports(filePath) {
        const absPath = this.findFile(filePath);
        if (!absPath) {
            return [];
        }

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

        return results;
    }

    /**
     * Check if a function is used as a callback anywhere in the codebase
     * @param {string} name - Function name
     * @returns {Array} Callback usages
     */
    findCallbackUsages(name) {
        const usages = [];

        for (const [filePath, fileEntry] of this.files) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const language = detectLanguage(filePath);
                if (!language) continue;

                const langModule = getLanguageModule(language);
                if (!langModule.findCallbackUsages) continue;

                const parser = getParser(language);
                const callbacks = langModule.findCallbackUsages(content, name, parser);

                for (const cb of callbacks) {
                    usages.push({
                        file: filePath,
                        relativePath: fileEntry.relativePath,
                        ...cb
                    });
                }
            } catch (e) {
                // Skip files that can't be processed
            }
        }

        return usages;
    }

    /**
     * Find re-exports of a symbol across the codebase
     * @param {string} name - Symbol name
     * @returns {Array} Re-export locations
     */
    findReExportsOf(name) {
        const reExports = [];

        for (const [filePath, fileEntry] of this.files) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const language = detectLanguage(filePath);
                if (!language) continue;

                const langModule = getLanguageModule(language);
                if (!langModule.findReExports) continue;

                const parser = getParser(language);
                const exports = langModule.findReExports(content, parser);

                for (const exp of exports) {
                    if (exp.name === name) {
                        reExports.push({
                            file: filePath,
                            relativePath: fileEntry.relativePath,
                            ...exp
                        });
                    }
                }
            } catch (e) {
                // Skip files that can't be processed
            }
        }

        return reExports;
    }

    /**
     * Build a usage index for all identifiers in the codebase (optimized for deadcode)
     * Scans all files ONCE and builds a reverse index: name -> [usages]
     * @returns {Map<string, Array>} Usage index
     */
    buildUsageIndex() {
        const usageIndex = new Map(); // name -> [{file, line}]

        for (const [filePath, fileEntry] of this.files) {
            try {
                const language = detectLanguage(filePath);
                if (!language) continue;

                const parser = getParser(language);
                if (!parser) continue;

                const content = fs.readFileSync(filePath, 'utf-8');
                const tree = parser.parse(content, undefined, PARSE_OPTIONS);

                // Collect all identifiers from this file in one pass
                const traverse = (node) => {
                    // Match all identifier-like nodes across languages
                    if (node.type === 'identifier' ||
                        node.type === 'property_identifier' ||
                        node.type === 'type_identifier' ||
                        node.type === 'shorthand_property_identifier' ||
                        node.type === 'shorthand_property_identifier_pattern' ||
                        node.type === 'field_identifier') {
                        const name = node.text;
                        if (!usageIndex.has(name)) {
                            usageIndex.set(name, []);
                        }
                        usageIndex.get(name).push({
                            file: filePath,
                            line: node.startPosition.row + 1,
                            relativePath: fileEntry.relativePath
                        });
                    }
                    for (let i = 0; i < node.childCount; i++) {
                        traverse(node.child(i));
                    }
                };
                traverse(tree.rootNode);
            } catch (e) {
                // Skip files that can't be processed
            }
        }

        return usageIndex;
    }

    /**
     * Find dead code (unused functions/classes)
     * @param {object} options - { includeExported, includeTests }
     * @returns {Array} Unused symbols
     */
    deadcode(options = {}) {
        const results = [];

        // Build usage index once (instead of per-symbol)
        const usageIndex = this.buildUsageIndex();

        for (const [name, symbols] of this.symbols) {
            for (const symbol of symbols) {
                // Skip non-function/class types
                // Include various method types from different languages:
                // - function: standalone functions
                // - class, struct, interface: type definitions (skip them in deadcode)
                // - method: class methods
                // - static, public, abstract: Java method modifiers used as types
                // - constructor: constructors
                const callableTypes = ['function', 'method', 'static', 'public', 'abstract', 'constructor'];
                if (!callableTypes.includes(symbol.type)) {
                    continue;
                }

                // Skip test files unless requested
                if (!options.includeTests && isTestFile(symbol.file, symbol.language)) {
                    continue;
                }

                // Check if exported
                const fileEntry = this.files.get(symbol.file);
                const lang = fileEntry?.language;
                const mods = symbol.modifiers || [];

                // Language-specific entry points (called by runtime, no AST-visible callers)
                // Go: main() and init() are called by runtime
                const isGoEntryPoint = lang === 'go' && (name === 'main' || name === 'init');

                // Java: public static void main(String[] args) is the entry point
                const isJavaEntryPoint = lang === 'java' && name === 'main' &&
                    mods.includes('public') && mods.includes('static');

                // Python: Magic/dunder methods are called by the interpreter, not user code
                const isPythonMagicMethod = lang === 'python' && /^__\w+__$/.test(name);

                // Rust: main() is entry point, #[test] functions are called by test runner
                const isRustEntryPoint = lang === 'rust' &&
                    (name === 'main' || mods.includes('test'));

                const isEntryPoint = isGoEntryPoint || isJavaEntryPoint ||
                    isPythonMagicMethod || isRustEntryPoint;

                const isExported = fileEntry && (
                    fileEntry.exports.includes(name) ||
                    mods.includes('export') ||
                    mods.includes('public') ||
                    (lang === 'go' && /^[A-Z]/.test(name)) ||
                    isEntryPoint
                );

                // Skip exported unless requested
                if (isExported && !options.includeExported) {
                    continue;
                }

                // Use pre-built index for O(1) lookup instead of O(files) scan
                const allUsages = usageIndex.get(name) || [];

                // Filter out usages that are at the definition location
                const nonDefUsages = allUsages.filter(u =>
                    !(u.file === symbol.file && u.line === symbol.startLine)
                );

                // Total includes all usage types (calls, references, callbacks, re-exports)
                const totalUsages = nonDefUsages.length;

                if (totalUsages === 0) {
                    results.push({
                        name: symbol.name,
                        type: symbol.type,
                        file: symbol.relativePath,
                        startLine: symbol.startLine,
                        endLine: symbol.endLine,
                        isExported,
                        usageCount: 0
                    });
                }
            }
        }

        // Sort by file then line
        results.sort((a, b) => {
            if (a.file !== b.file) return a.file.localeCompare(b.file);
            return a.startLine - b.startLine;
        });

        return results;
    }

    /**
     * Get dependency graph for a file
     * @param {string} filePath - Starting file
     * @param {object} options - { direction: 'imports' | 'importers' | 'both', maxDepth }
     * @returns {object} - Graph structure with root, nodes, edges
     */
    graph(filePath, options = {}) {
        const direction = options.direction || 'imports';
        // Sanitize depth: use default for null/undefined, clamp negative to 0
        const rawDepth = options.maxDepth ?? 5;
        const maxDepth = Math.max(0, rawDepth);

        const absPath = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(this.root, filePath);

        // Try to find file if not exact match
        let targetPath = absPath;
        if (!this.files.has(absPath)) {
            for (const [p, entry] of this.files) {
                if (entry.relativePath === filePath || p.endsWith(filePath)) {
                    targetPath = p;
                    break;
                }
            }
        }

        if (!this.files.has(targetPath)) {
            return { root: filePath, nodes: [], edges: [] };
        }

        const visited = new Set();
        const graph = {
            root: targetPath,
            nodes: [],
            edges: []
        };

        const traverse = (file, depth) => {
            if (depth > maxDepth || visited.has(file)) return;
            visited.add(file);

            const fileEntry = this.files.get(file);
            const relPath = fileEntry ? fileEntry.relativePath : path.relative(this.root, file);
            graph.nodes.push({ file, relativePath: relPath, depth });

            let neighbors = [];
            if (direction === 'imports' || direction === 'both') {
                const imports = this.importGraph.get(file) || [];
                neighbors = neighbors.concat(imports);
            }
            if (direction === 'importers' || direction === 'both') {
                const importers = this.exportGraph.get(file) || [];
                neighbors = neighbors.concat(importers);
            }

            for (const neighbor of neighbors) {
                graph.edges.push({ from: file, to: neighbor });
                traverse(neighbor, depth + 1);
            }
        };

        traverse(targetPath, 0);
        return graph;
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

        for (const [filePath, fileEntry] of this.files) {
            // Skip node_modules - we don't care about their patterns
            if (filePath.includes('node_modules')) continue;

            try {
                const content = fs.readFileSync(filePath, 'utf-8');

                // Dynamic imports: import(), require(variable), __import__
                const dynamicMatches = content.match(/import\s*\([^'"]/g) ||
                    content.match(/require\s*\([^'"]/g) ||
                    content.match(/__import__\s*\(/g);
                if (dynamicMatches) {
                    dynamicImports += dynamicMatches.length;
                }

                // eval, Function constructor, exec (but not exec in comments/strings context)
                const evalMatches = content.match(/[^a-zA-Z_]eval\s*\(/g) ||
                    content.match(/new\s+Function\s*\(/g);
                if (evalMatches) {
                    evalUsage += evalMatches.length;
                }

                // Reflection: getattr, hasattr, Reflect
                const reflectMatches = content.match(/\bgetattr\s*\(/g) ||
                    content.match(/\bhasattr\s*\(/g) ||
                    content.match(/\bReflect\./g);
                if (reflectMatches) {
                    reflectionUsage += reflectMatches.length;
                }
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
     * Add completeness info to a result
     */
    withCompleteness(result, totalResults, maxResults = 100) {
        const completeness = {
            warnings: []
        };

        if (totalResults > maxResults) {
            completeness.warnings.push({
                type: 'truncated',
                message: `Showing ${maxResults} of ${totalResults} results`
            });
        }

        // Get project-wide completeness
        const projectCompleteness = this.detectCompleteness();
        completeness.warnings.push(...projectCompleteness.warnings);

        completeness.complete = completeness.warnings.length === 0;

        return {
            ...result,
            completeness
        };
    }

    /**
     * Find related functions - same file, similar names, shared dependencies
     * This is the "what else should I look at" command
     *
     * @param {string} name - Function name
     * @returns {object} Related functions grouped by relationship type
     */
    related(name) {
        const definitions = this.symbols.get(name);
        if (!definitions || definitions.length === 0) {
            return null;
        }

        const def = definitions[0];
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

        // 1. Same file functions
        const fileEntry = this.files.get(def.file);
        if (fileEntry) {
            for (const sym of fileEntry.symbols) {
                if (sym.name !== name && sym.type === 'function') {
                    related.sameFile.push({
                        name: sym.name,
                        line: sym.startLine,
                        params: sym.params
                    });
                }
            }
        }

        // 2. Similar names (shared prefix/suffix, camelCase similarity)
        const nameParts = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split('_');
        for (const [symName, symbols] of this.symbols) {
            if (symName === name) continue;
            const symParts = symName.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split('_');

            // Check for shared parts
            const sharedParts = nameParts.filter(p => symParts.includes(p) && p.length > 2);
            if (sharedParts.length > 0) {
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
        related.similarNames = related.similarNames.slice(0, 10);

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
            const sorted = Array.from(callerCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5);
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
        if (def.type === 'function' || def.params !== undefined) {
            const myCallees = new Set(this.findCallees(def).map(c => c.name));
            if (myCallees.size > 0) {
                const calleeCounts = new Map();
                for (const [symName, symbols] of this.symbols) {
                    if (symName === name) continue;
                    const sym = symbols[0];
                    if (sym.type !== 'function' && sym.params === undefined) continue;

                    const theirCallees = this.findCallees(sym);
                    const shared = theirCallees.filter(c => myCallees.has(c.name));
                    if (shared.length > 0) {
                        calleeCounts.set(symName, shared.length);
                    }
                }
                // Sort by shared callee count
                const sorted = Array.from(calleeCounts.entries())
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5);
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
        // Sanitize depth: use default for null/undefined, clamp negative to 0
        const rawDepth = options.depth ?? 3;
        const maxDepth = Math.max(0, rawDepth);
        const direction = options.direction || 'down';  // 'down' = callees, 'up' = callers, 'both'

        const definitions = this.symbols.get(name);
        if (!definitions || definitions.length === 0) {
            return null;
        }

        const def = definitions[0];
        const visited = new Set();

        const buildTree = (funcName, currentDepth, dir) => {
            if (currentDepth > maxDepth || visited.has(funcName)) {
                return null;
            }
            visited.add(funcName);

            const funcDefs = this.symbols.get(funcName);
            if (!funcDefs || funcDefs.length === 0) {
                return {
                    name: funcName,
                    external: true,
                    children: []
                };
            }

            const funcDef = funcDefs[0];
            const node = {
                name: funcName,
                file: funcDef.relativePath,
                line: funcDef.startLine,
                type: funcDef.type,
                children: []
            };

            if (dir === 'down' || dir === 'both') {
                const callees = this.findCallees(funcDef);
                for (const callee of callees.slice(0, 10)) {  // Limit children
                    const childTree = buildTree(callee.name, currentDepth + 1, 'down');
                    if (childTree) {
                        node.children.push({
                            ...childTree,
                            callCount: callee.callCount,
                            weight: callee.weight
                        });
                    }
                }
            }

            return node;
        };

        const tree = buildTree(name, 0, direction);

        // Also get callers if direction is 'up' or 'both'
        let callers = [];
        if (direction === 'up' || direction === 'both') {
            callers = this.findCallers(name).slice(0, 10).map(c => ({
                name: c.callerName || '(anonymous)',
                file: c.relativePath,
                line: c.line,
                expression: c.content.trim()
            }));
        }

        return {
            root: name,
            file: def.relativePath,
            line: def.startLine,
            direction,
            maxDepth,
            tree,
            callers: direction !== 'down' ? callers : undefined
        };
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
        const definitions = this.symbols.get(name);
        if (!definitions || definitions.length === 0) {
            return null;
        }

        const def = definitions[0];
        const usages = this.usages(name, { codeOnly: true });
        const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

        // Analyze each call site
        const callSites = calls.map(call => {
            const analysis = this.analyzeCallSite(call, name);
            return {
                file: call.relativePath,
                line: call.line,
                expression: call.content.trim(),
                callerName: this.findEnclosingFunction(call.file, call.line),
                ...analysis
            };
        });

        // Group by file if requested
        const byFile = new Map();
        for (const site of callSites) {
            if (!byFile.has(site.file)) {
                byFile.set(site.file, []);
            }
            byFile.get(site.file).push(site);
        }

        // Identify patterns
        const patterns = this.identifyCallPatterns(callSites, name);

        return {
            function: name,
            file: def.relativePath,
            startLine: def.startLine,
            signature: this.formatSignature(def),
            params: def.params,
            paramsStructured: def.paramsStructured,
            totalCallSites: calls.length,
            byFile: Array.from(byFile.entries()).map(([file, sites]) => ({
                file,
                count: sites.length,
                sites
            })),
            patterns
        };
    }

    /**
     * Plan a refactoring operation
     * @param {string} name - Function name
     * @param {object} options - { addParam, removeParam, renameTo, defaultValue }
     * @returns {object} Plan with before/after signatures and affected call sites
     */
    plan(name, options = {}) {
        const definitions = this.symbols.get(name);
        if (!definitions || definitions.length === 0) {
            return { found: false, function: name };
        }

        const def = definitions[0];
        const impact = this.impact(name);
        const currentParams = def.paramsStructured || [];
        const currentSignature = this.formatSignature(def);

        let newParams = [...currentParams];
        let newSignature = currentSignature;
        let operation = null;
        let changes = [];

        if (options.addParam) {
            operation = 'add-param';
            const newParam = {
                name: options.addParam,
                ...(options.defaultValue && { default: options.defaultValue })
            };
            newParams.push(newParam);

            // Generate new signature
            const paramsList = newParams.map(p => {
                let str = p.name;
                if (p.type) str += `: ${p.type}`;
                if (p.default) str += ` = ${p.default}`;
                return str;
            }).join(', ');
            newSignature = `${name}(${paramsList})`;
            if (def.returnType) newSignature += `: ${def.returnType}`;

            // Describe changes needed at each call site
            for (const fileGroup of impact.byFile) {
                for (const site of fileGroup.sites) {
                    const suggestion = options.defaultValue
                        ? `No change needed (has default value)`
                        : `Add argument: ${options.addParam}`;
                    changes.push({
                        file: site.file,
                        line: site.line,
                        expression: site.expression,
                        suggestion,
                        args: site.args
                    });
                }
            }
        }

        if (options.removeParam) {
            operation = 'remove-param';
            const paramIndex = currentParams.findIndex(p => p.name === options.removeParam);
            if (paramIndex === -1) {
                return {
                    found: true,
                    error: `Parameter "${options.removeParam}" not found in ${name}`,
                    currentParams: currentParams.map(p => p.name)
                };
            }

            newParams = currentParams.filter(p => p.name !== options.removeParam);

            // Generate new signature
            const paramsList = newParams.map(p => {
                let str = p.name;
                if (p.type) str += `: ${p.type}`;
                if (p.default) str += ` = ${p.default}`;
                return str;
            }).join(', ');
            newSignature = `${name}(${paramsList})`;
            if (def.returnType) newSignature += `: ${def.returnType}`;

            // Describe changes at each call site
            for (const fileGroup of impact.byFile) {
                for (const site of fileGroup.sites) {
                    if (site.args && site.argCount > paramIndex) {
                        changes.push({
                            file: site.file,
                            line: site.line,
                            expression: site.expression,
                            suggestion: `Remove argument ${paramIndex + 1}: ${site.args[paramIndex] || '?'}`,
                            args: site.args
                        });
                    }
                }
            }
        }

        if (options.renameTo) {
            operation = 'rename';
            newSignature = currentSignature.replace(name, options.renameTo);

            // All call sites need renaming
            for (const fileGroup of impact.byFile) {
                for (const site of fileGroup.sites) {
                    const newExpression = site.expression.replace(
                        new RegExp('\\b' + escapeRegExp(name) + '\\b'),
                        options.renameTo
                    );
                    changes.push({
                        file: site.file,
                        line: site.line,
                        expression: site.expression,
                        suggestion: `Rename to: ${newExpression}`,
                        newExpression
                    });
                }
            }
        }

        return {
            found: true,
            function: name,
            file: def.relativePath,
            startLine: def.startLine,
            operation,
            before: {
                signature: currentSignature,
                params: currentParams.map(p => p.name)
            },
            after: {
                signature: newSignature,
                params: newParams.map(p => p.name)
            },
            totalChanges: changes.length,
            filesAffected: new Set(changes.map(c => c.file)).size,
            changes
        };
    }

    /**
     * Parse a stack trace and show code for each frame
     * @param {string} stackText - Stack trace text
     * @returns {object} Parsed frames with code context
     */
    parseStackTrace(stackText) {
        const frames = [];
        const lines = stackText.split(/\\n|\n/);

        // Stack trace patterns for different languages/runtimes
        // Order matters - more specific patterns first
        const patterns = [
            // JavaScript Node.js: "at functionName (file.js:line:col)" or "at file.js:line:col"
            { regex: /at\s+(?:async\s+)?(?:(.+?)\s+\()?([^():]+):(\d+)(?::(\d+))?\)?/, extract: (m) => ({ funcName: m[1] || null, file: m[2], line: parseInt(m[3]), col: m[4] ? parseInt(m[4]) : null }) },
            // Deno: "at functionName (file:///path/to/file.ts:line:col)"
            { regex: /at\s+(?:async\s+)?(?:(.+?)\s+\()?file:\/\/([^:]+):(\d+)(?::(\d+))?\)?/, extract: (m) => ({ funcName: m[1] || null, file: m[2], line: parseInt(m[3]), col: m[4] ? parseInt(m[4]) : null }) },
            // Bun: "at functionName (file.js:line:col)" - similar to Node but may have different formatting
            { regex: /^\s+at\s+(.+?)\s+\[as\s+\w+\]\s+\(([^:]+):(\d+):(\d+)\)/, extract: (m) => ({ funcName: m[1], file: m[2], line: parseInt(m[3]), col: parseInt(m[4]) }) },
            // Browser Chrome/V8: "at functionName (http://... or file:// ...)"
            { regex: /at\s+(?:async\s+)?(?:(.+?)\s+\()?(?:https?:\/\/[^/]+)?([^():]+):(\d+)(?::(\d+))?\)?/, extract: (m) => ({ funcName: m[1] || null, file: m[2], line: parseInt(m[3]), col: m[4] ? parseInt(m[4]) : null }) },
            // Firefox: "functionName@file:line:col"
            { regex: /^(.+)@(.+):(\d+):(\d+)$/, extract: (m) => ({ funcName: m[1] || null, file: m[2], line: parseInt(m[3]), col: parseInt(m[4]) }) },
            // Safari: "functionName@file:line:col" (similar to Firefox)
            { regex: /^(.+)@(?:https?:\/\/[^/]+)?([^:]+):(\d+)(?::(\d+))?$/, extract: (m) => ({ funcName: m[1] || null, file: m[2], line: parseInt(m[3]), col: m[4] ? parseInt(m[4]) : null }) },
            // Python: "File \"file.py\", line N, in function"
            { regex: /File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?/, extract: (m) => ({ file: m[1], line: parseInt(m[2]), funcName: m[3] || null, col: null }) },
            // Go: "file.go:line" or "package/file.go:line +0x..."
            { regex: /^\s*([^\s:]+\.go):(\d+)(?:\s|$)/, extract: (m) => ({ file: m[1], line: parseInt(m[2]), funcName: null, col: null }) },
            // Go with function: "package.FunctionName()\n\tfile.go:line"
            { regex: /^\s*([^\s(]+)\(\)$/, extract: null }, // Skip function-only lines
            // Java: "at package.Class.method(File.java:line)"
            { regex: /at\s+([^\(]+)\(([^:]+):(\d+)\)/, extract: (m) => ({ funcName: m[1].split('.').pop(), file: m[2], line: parseInt(m[3]), col: null }) },
            // Rust: "at src/main.rs:line:col" or panic location
            { regex: /(?:at\s+)?([^\s:]+\.rs):(\d+)(?::(\d+))?/, extract: (m) => ({ file: m[1], line: parseInt(m[2]), col: m[3] ? parseInt(m[3]) : null, funcName: null }) },
            // Generic: "file:line" as last resort
            { regex: /([^\s:]+\.\w+):(\d+)(?::(\d+))?/, extract: (m) => ({ file: m[1], line: parseInt(m[2]), col: m[3] ? parseInt(m[3]) : null, funcName: null }) }
        ];

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Try each pattern until one matches
            for (const pattern of patterns) {
                const match = pattern.regex.exec(trimmed);
                if (match && pattern.extract) {
                    const extracted = pattern.extract(match);
                    if (extracted && extracted.file && extracted.line) {
                        frames.push(this.createStackFrame(
                            extracted.file,
                            extracted.line,
                            extracted.funcName,
                            extracted.col,
                            trimmed
                        ));
                        break; // Move to next line
                    }
                }
            }
        }

        return {
            frameCount: frames.length,
            frames
        };
    }

    /**
     * Calculate path similarity score between two file paths
     * Higher score = better match
     * @param {string} query - The path from stack trace
     * @param {string} candidate - The candidate file path
     * @returns {number} Similarity score
     */
    calculatePathSimilarity(query, candidate) {
        // Normalize paths for comparison
        const queryParts = query.replace(/\\/g, '/').split('/').filter(Boolean);
        const candidateParts = candidate.replace(/\\/g, '/').split('/').filter(Boolean);

        let score = 0;

        // Exact match on full path
        if (candidate.endsWith(query)) {
            score += 100;
        }

        // Compare from the end (most important part)
        let matches = 0;
        const minLen = Math.min(queryParts.length, candidateParts.length);
        for (let i = 0; i < minLen; i++) {
            const queryPart = queryParts[queryParts.length - 1 - i];
            const candPart = candidateParts[candidateParts.length - 1 - i];
            if (queryPart === candPart) {
                matches++;
                // Earlier parts (closer to filename) score more
                score += (10 - i) * 5;
            } else {
                break; // Stop at first mismatch
            }
        }

        // Bonus for matching most of the query path
        if (matches === queryParts.length) {
            score += 50;
        }

        // Filename match is essential
        const queryFile = queryParts[queryParts.length - 1];
        const candFile = candidateParts[candidateParts.length - 1];
        if (queryFile !== candFile) {
            score = 0; // No match if filename doesn't match
        }

        return score;
    }

    /**
     * Find the best matching file for a stack trace path
     * @param {string} filePath - Path from stack trace
     * @param {string|null} funcName - Function name for verification
     * @param {number} lineNum - Line number for verification
     * @returns {{path: string, relativePath: string, confidence: number}|null}
     */
    findBestMatchingFile(filePath, funcName, lineNum) {
        const candidates = [];

        // Collect all potential matches with scores
        for (const [absPath, fileEntry] of this.files) {
            const score = this.calculatePathSimilarity(filePath, absPath);
            const relScore = this.calculatePathSimilarity(filePath, fileEntry.relativePath);
            const bestScore = Math.max(score, relScore);

            if (bestScore > 0) {
                candidates.push({
                    absPath,
                    relativePath: fileEntry.relativePath,
                    score: bestScore,
                    fileEntry
                });
            }
        }

        if (candidates.length === 0) {
            // Try absolute path
            const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.root, filePath);
            if (fs.existsSync(absPath)) {
                return {
                    path: absPath,
                    relativePath: path.relative(this.root, absPath),
                    confidence: 0.5 // Low confidence for unindexed files
                };
            }
            return null;
        }

        // Sort by score descending
        candidates.sort((a, b) => b.score - a.score);

        // If there's a function name, verify it exists at the line
        if (funcName && candidates.length > 1) {
            for (const cand of candidates) {
                const symbols = this.symbols.get(funcName);
                if (symbols) {
                    const match = symbols.find(s =>
                        s.file === cand.absPath &&
                        s.startLine <= lineNum && s.endLine >= lineNum
                    );
                    if (match) {
                        // This candidate has the function at the right line - strong match
                        return {
                            path: cand.absPath,
                            relativePath: cand.relativePath,
                            confidence: 1.0,
                            verifiedFunction: true
                        };
                    }
                }
            }
        }

        // Return best scoring candidate
        const best = candidates[0];
        const confidence = candidates.length === 1 ? 0.9 :
                          (best.score > 100 ? 0.8 : 0.6);

        return {
            path: best.absPath,
            relativePath: best.relativePath,
            confidence
        };
    }

    /**
     * Create a stack frame with code context
     */
    createStackFrame(filePath, lineNum, funcName, col, rawLine) {
        const frame = {
            file: filePath,
            line: lineNum,
            function: funcName,
            column: col,
            raw: rawLine,
            found: false,
            code: null,
            context: null,
            confidence: 0
        };

        // Find the best matching file using improved algorithm
        const match = this.findBestMatchingFile(filePath, funcName, lineNum);

        if (match) {
            const resolvedPath = match.path;
            frame.found = true;
            frame.resolvedFile = match.relativePath;
            frame.confidence = match.confidence;
            if (match.verifiedFunction) {
                frame.verifiedFunction = true;
            }

            try {
                const content = fs.readFileSync(resolvedPath, 'utf-8');
                const lines = content.split('\n');

                // Get the exact line
                if (lineNum > 0 && lineNum <= lines.length) {
                    frame.code = lines[lineNum - 1];

                    // Get context (2 lines before, 2 after)
                    const contextLines = [];
                    for (let i = Math.max(0, lineNum - 3); i < Math.min(lines.length, lineNum + 2); i++) {
                        contextLines.push({
                            line: i + 1,
                            code: lines[i],
                            isCurrent: i + 1 === lineNum
                        });
                    }
                    frame.context = contextLines;
                }

                // Try to find function info (verify it contains the line)
                if (funcName) {
                    const symbols = this.symbols.get(funcName);
                    if (symbols) {
                        const funcMatch = symbols.find(s =>
                            s.file === resolvedPath &&
                            s.startLine <= lineNum && s.endLine >= lineNum
                        );
                        if (funcMatch) {
                            frame.functionInfo = {
                                name: funcMatch.name,
                                startLine: funcMatch.startLine,
                                endLine: funcMatch.endLine,
                                params: funcMatch.params
                            };
                            frame.confidence = 1.0; // High confidence when function verified
                        } else {
                            // Function exists but line doesn't match - lower confidence
                            const anyMatch = symbols.find(s => s.file === resolvedPath);
                            if (anyMatch) {
                                frame.functionInfo = {
                                    name: anyMatch.name,
                                    startLine: anyMatch.startLine,
                                    endLine: anyMatch.endLine,
                                    params: anyMatch.params,
                                    lineMismatch: true
                                };
                                frame.confidence = Math.min(frame.confidence, 0.5);
                            }
                        }
                    }
                } else {
                    // No function name in stack - find enclosing function
                    const enclosing = this.findEnclosingFunction(resolvedPath, lineNum, true);
                    if (enclosing) {
                        frame.functionInfo = {
                            name: enclosing.name,
                            startLine: enclosing.startLine,
                            endLine: enclosing.endLine,
                            params: enclosing.params,
                            inferred: true
                        };
                    }
                }
            } catch (e) {
                frame.error = e.message;
            }
        }

        return frame;
    }

    /**
     * Verify that all call sites match a function's signature
     * @param {string} name - Function name
     * @returns {object} Verification results with mismatches
     */
    verify(name) {
        const definitions = this.symbols.get(name);
        if (!definitions || definitions.length === 0) {
            return { found: false, function: name };
        }

        const def = definitions[0];
        const expectedParamCount = def.paramsStructured?.length || 0;
        const optionalCount = (def.paramsStructured || []).filter(p => p.optional || p.default !== undefined).length;
        const minArgs = expectedParamCount - optionalCount;
        const hasRest = (def.paramsStructured || []).some(p => p.rest);

        // Get all call sites
        const usages = this.usages(name, { codeOnly: true });
        const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

        const valid = [];
        const mismatches = [];
        const uncertain = [];

        for (const call of calls) {
            const analysis = this.analyzeCallSite(call, name);

            if (analysis.args === null) {
                // Couldn't parse arguments
                uncertain.push({
                    file: call.relativePath,
                    line: call.line,
                    expression: call.content.trim(),
                    reason: 'Could not parse call arguments'
                });
                continue;
            }

            if (analysis.hasSpread) {
                // Spread args - can't verify count
                uncertain.push({
                    file: call.relativePath,
                    line: call.line,
                    expression: call.content.trim(),
                    reason: 'Uses spread operator'
                });
                continue;
            }

            const argCount = analysis.argCount;

            // Check if arg count is valid
            if (hasRest) {
                // With rest param, need at least minArgs
                if (argCount >= minArgs) {
                    valid.push({ file: call.relativePath, line: call.line });
                } else {
                    mismatches.push({
                        file: call.relativePath,
                        line: call.line,
                        expression: call.content.trim(),
                        expected: `at least ${minArgs} arg(s)`,
                        actual: argCount,
                        args: analysis.args
                    });
                }
            } else {
                // Without rest, need between minArgs and expectedParamCount
                if (argCount >= minArgs && argCount <= expectedParamCount) {
                    valid.push({ file: call.relativePath, line: call.line });
                } else {
                    mismatches.push({
                        file: call.relativePath,
                        line: call.line,
                        expression: call.content.trim(),
                        expected: minArgs === expectedParamCount
                            ? `${expectedParamCount} arg(s)`
                            : `${minArgs}-${expectedParamCount} arg(s)`,
                        actual: argCount,
                        args: analysis.args
                    });
                }
            }
        }

        return {
            found: true,
            function: name,
            file: def.relativePath,
            startLine: def.startLine,
            signature: this.formatSignature(def),
            params: def.paramsStructured?.map(p => ({
                name: p.name,
                optional: p.optional || p.default !== undefined,
                hasDefault: p.default !== undefined
            })) || [],
            expectedArgs: { min: minArgs, max: hasRest ? '∞' : expectedParamCount },
            totalCalls: calls.length,
            valid: valid.length,
            mismatches: mismatches.length,
            uncertain: uncertain.length,
            mismatchDetails: mismatches,
            uncertainDetails: uncertain
        };
    }

    /**
     * Analyze a call site to understand how it's being called
     */
    analyzeCallSite(call, funcName) {
        const content = call.content;

        // Extract arguments from the call
        const callMatch = new RegExp('\\b' + escapeRegExp(funcName) + '\\s*\\(([^)]*)\\)').exec(content);
        if (!callMatch) {
            return { args: null, argCount: 0 };
        }

        const argsStr = callMatch[1].trim();
        if (!argsStr) {
            return { args: [], argCount: 0 };
        }

        // Simple arg parsing (doesn't handle nested parens/strings perfectly but good enough)
        const args = this.parseArguments(argsStr);

        return {
            args,
            argCount: args.length,
            hasSpread: args.some(a => a.startsWith('...')),
            hasVariable: args.some(a => /^[a-zA-Z_]\w*$/.test(a))
        };
    }

    /**
     * Parse function call arguments (simple version)
     */
    parseArguments(argsStr) {
        const args = [];
        let current = '';
        let depth = 0;
        let inString = false;
        let stringChar = '';

        for (let i = 0; i < argsStr.length; i++) {
            const ch = argsStr[i];

            if (inString) {
                current += ch;
                if (ch === stringChar && argsStr[i - 1] !== '\\') {
                    inString = false;
                }
                continue;
            }

            if (ch === '"' || ch === "'" || ch === '`') {
                inString = true;
                stringChar = ch;
                current += ch;
                continue;
            }

            if (ch === '(' || ch === '[' || ch === '{') {
                depth++;
                current += ch;
                continue;
            }

            if (ch === ')' || ch === ']' || ch === '}') {
                depth--;
                current += ch;
                continue;
            }

            if (ch === ',' && depth === 0) {
                args.push(current.trim());
                current = '';
                continue;
            }

            current += ch;
        }

        if (current.trim()) {
            args.push(current.trim());
        }

        return args;
    }

    /**
     * Identify common calling patterns
     */
    identifyCallPatterns(callSites, funcName) {
        const patterns = {
            constantArgs: 0,    // Call sites with literal/constant arguments
            variableArgs: 0,    // Call sites passing variables
            chainedCalls: 0,    // Calls that are part of method chains
            awaitedCalls: 0,    // Async calls with await
            spreadCalls: 0      // Calls using spread operator
        };

        for (const site of callSites) {
            const expr = site.expression;

            if (site.hasSpread) patterns.spreadCalls++;
            if (/await\s/.test(expr)) patterns.awaitedCalls++;
            if (new RegExp('\\.' + escapeRegExp(funcName) + '\\s*\\(').test(expr)) patterns.chainedCalls++;

            if (site.args && site.args.length > 0) {
                const hasLiteral = site.args.some(a =>
                    /^[\d'"{\[]/.test(a) || a === 'true' || a === 'false' || a === 'null'
                );
                if (hasLiteral) patterns.constantArgs++;
                if (site.hasVariable) patterns.variableArgs++;
            }
        }

        return patterns;
    }

    /**
     * Get complete information about a symbol - definition, usages, callers, callees, tests, code
     * This is the "tell me everything" command for AI agents
     *
     * @param {string} name - Symbol name
     * @param {object} options - { maxCallers, maxCallees, withCode, withTypes }
     * @returns {object} Complete symbol info
     */
    about(name, options = {}) {
        const maxCallers = options.maxCallers || 5;
        const maxCallees = options.maxCallees || 5;

        // Find symbol definition(s)
        const definitions = this.find(name, { exact: true });
        if (definitions.length === 0) {
            // Try fuzzy match
            const fuzzy = this.find(name);
            if (fuzzy.length === 0) {
                return null;
            }
            // Return suggestion
            return {
                found: false,
                suggestions: fuzzy.slice(0, 5).map(s => ({
                    name: s.name,
                    file: s.relativePath,
                    line: s.startLine,
                    type: s.type,
                    usageCount: s.usageCount
                }))
            };
        }

        // Use the definition with highest usage count (primary implementation)
        const primary = definitions[0];
        const others = definitions.slice(1);

        // Use the actual symbol name (may differ from query if fuzzy matched)
        const symbolName = primary.name;

        // Get usage counts by type
        const usages = this.usages(symbolName, { codeOnly: true });
        const usagesByType = {
            definitions: usages.filter(u => u.isDefinition).length,
            calls: usages.filter(u => u.usageType === 'call').length,
            imports: usages.filter(u => u.usageType === 'import').length,
            references: usages.filter(u => u.usageType === 'reference').length
        };

        // Get callers and callees (only for functions)
        let callers = [];
        let callees = [];
        let allCallers = null;
        let allCallees = null;
        if (primary.type === 'function' || primary.params !== undefined) {
            allCallers = this.findCallers(symbolName);
            callers = allCallers.slice(0, maxCallers).map(c => ({
                file: c.relativePath,
                line: c.line,
                expression: c.content.trim(),
                callerName: c.callerName
            }));

            allCallees = this.findCallees(primary);
            callees = allCallees.slice(0, maxCallees).map(c => ({
                name: c.name,
                file: c.relativePath,
                line: c.startLine,
                startLine: c.startLine,
                endLine: c.endLine,
                weight: c.weight,
                callCount: c.callCount
            }));
        }

        // Find tests
        const tests = this.tests(symbolName);
        const testSummary = {
            fileCount: tests.length,
            totalMatches: tests.reduce((sum, t) => sum + t.matches.length, 0),
            files: tests.slice(0, 3).map(t => t.file)
        };

        // Extract code if requested (default: true)
        let code = null;
        if (options.withCode !== false) {
            code = this.extractCode(primary);
        }

        // Get type definitions if requested
        let types = [];
        if (options.withTypes && (primary.params !== undefined || primary.returnType)) {
            const typeNames = this.extractTypeNames(primary);
            for (const typeName of typeNames) {
                const typeSymbols = this.symbols.get(typeName);
                if (typeSymbols) {
                    for (const sym of typeSymbols) {
                        if (['type', 'interface', 'class', 'struct'].includes(sym.type)) {
                            types.push({
                                name: sym.name,
                                type: sym.type,
                                file: sym.relativePath,
                                line: sym.startLine
                            });
                        }
                    }
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
            otherDefinitions: others.slice(0, 3).map(d => ({
                file: d.relativePath,
                line: d.startLine,
                usageCount: d.usageCount
            })),
            types,
            code,
            completeness: this.detectCompleteness()
        };

        return result;
    }

    /**
     * Search for text across the project
     * @param {string} term - Search term
     * @param {object} options - { codeOnly, context }
     */
    search(term, options = {}) {
        const results = [];
        // Escape the term to handle special regex characters
        const regex = new RegExp(escapeRegExp(term), 'gi');

        for (const [filePath, fileEntry] of this.files) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const lines = content.split('\n');
                const matches = [];

                // Use AST-based filtering for codeOnly mode when language is supported
                if (options.codeOnly) {
                    const language = detectLanguage(filePath);
                    if (language) {
                        try {
                            const parser = getParser(language);
                            const { findMatchesWithASTFilter } = require('../languages/utils');
                            const astMatches = findMatchesWithASTFilter(content, term, parser, { codeOnly: true });

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
                // Skip unreadable files
            }
        }

        return results;
    }

    // ========================================================================
    // PROJECT INFO
    // ========================================================================

    /**
     * Get project statistics
     */
    getStats() {
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
            byType: {}
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

        return stats;
    }

    /**
     * Get TOC for all files
     */
    getToc() {
        const files = [];
        let totalFunctions = 0;
        let totalClasses = 0;
        let totalState = 0;
        let totalLines = 0;

        for (const [filePath, fileEntry] of this.files) {
            const functions = fileEntry.symbols.filter(s => s.type === 'function');
            const classes = fileEntry.symbols.filter(s =>
                ['class', 'interface', 'type', 'enum', 'struct', 'trait', 'impl'].includes(s.type)
            );
            const state = fileEntry.symbols.filter(s => s.type === 'state');

            totalFunctions += functions.length;
            totalClasses += classes.length;
            totalState += state.length;
            totalLines += fileEntry.lines;

            files.push({
                file: fileEntry.relativePath,
                language: fileEntry.language,
                lines: fileEntry.lines,
                functions,
                classes,
                state
            });
        }

        return {
            totalFiles: files.length,
            totalLines,
            totalFunctions,
            totalClasses,
            totalState,
            byFile: files
        };
    }

    // ========================================================================
    // CACHE METHODS
    // ========================================================================

    /**
     * Save index to cache file
     *
     * @param {string} [cachePath] - Optional custom cache path
     * @returns {string} - Path to cache file
     */
    saveCache(cachePath) {
        const cacheDir = cachePath
            ? path.dirname(cachePath)
            : path.join(this.root, '.ucn-cache');

        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }

        const cacheFile = cachePath || path.join(cacheDir, 'index.json');

        // Prepare callsCache for serialization (exclude content to save space)
        const callsCacheData = [];
        for (const [filePath, entry] of this.callsCache) {
            callsCacheData.push([filePath, {
                mtime: entry.mtime,
                hash: entry.hash,
                calls: entry.calls
                // content is not persisted - will be read on demand
            }]);
        }

        const cacheData = {
            version: 4,  // v4: className, memberType, isMethod for all languages
            root: this.root,
            buildTime: this.buildTime,
            timestamp: Date.now(),
            files: Array.from(this.files.entries()),
            symbols: Array.from(this.symbols.entries()),
            importGraph: Array.from(this.importGraph.entries()),
            exportGraph: Array.from(this.exportGraph.entries()),
            extendsGraph: Array.from(this.extendsGraph.entries()),
            extendedByGraph: Array.from(this.extendedByGraph.entries()),
            callsCache: callsCacheData
        };

        fs.writeFileSync(cacheFile, JSON.stringify(cacheData));
        return cacheFile;
    }

    /**
     * Load index from cache file
     *
     * @param {string} [cachePath] - Optional custom cache path
     * @returns {boolean} - True if loaded successfully
     */
    loadCache(cachePath) {
        const cacheFile = cachePath || path.join(this.root, '.ucn-cache', 'index.json');

        if (!fs.existsSync(cacheFile)) {
            return false;
        }

        try {
            const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

            // Check version compatibility
            // v4 adds className, memberType, isMethod for all languages
            // Only accept exactly version 4 (or future versions handled explicitly)
            if (cacheData.version !== 4) {
                return false;
            }

            // Validate cache structure has required fields
            if (!Array.isArray(cacheData.files) ||
                !Array.isArray(cacheData.symbols) ||
                !Array.isArray(cacheData.importGraph) ||
                !Array.isArray(cacheData.exportGraph)) {
                return false;
            }

            this.files = new Map(cacheData.files);
            this.symbols = new Map(cacheData.symbols);
            this.importGraph = new Map(cacheData.importGraph);
            this.exportGraph = new Map(cacheData.exportGraph);
            this.buildTime = cacheData.buildTime;

            // Restore optional graphs if present
            if (Array.isArray(cacheData.extendsGraph)) {
                this.extendsGraph = new Map(cacheData.extendsGraph);
            }
            if (Array.isArray(cacheData.extendedByGraph)) {
                this.extendedByGraph = new Map(cacheData.extendedByGraph);
            }

            // Restore callsCache if present (v2+)
            if (Array.isArray(cacheData.callsCache)) {
                this.callsCache = new Map(cacheData.callsCache);
            }

            // Rebuild derived graphs to ensure consistency with current config
            this.buildImportGraph();
            this.buildInheritanceGraph();

            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Check if cache is stale (any files changed or new files added)
     *
     * @returns {boolean} - True if cache needs rebuilding
     */
    isCacheStale() {
        // Check for new files added to project
        const pattern = detectProjectPattern(this.root);
        const currentFiles = expandGlob(pattern, { root: this.root });
        const cachedPaths = new Set(this.files.keys());

        for (const file of currentFiles) {
            if (!cachedPaths.has(file)) {
                return true; // New file found
            }
        }

        // Check existing cached files for modifications/deletions
        for (const [filePath, fileEntry] of this.files) {
            // File deleted
            if (!fs.existsSync(filePath)) {
                return true;
            }

            // File modified - check size first, then mtime, then hash
            try {
                const stat = fs.statSync(filePath);

                // If size changed, file changed
                if (fileEntry.size !== undefined && stat.size !== fileEntry.size) {
                    return true;
                }

                // If mtime matches, file hasn't changed
                if (fileEntry.mtime && stat.mtimeMs === fileEntry.mtime) {
                    continue;
                }

                // mtime changed or not stored - verify with hash
                const content = fs.readFileSync(filePath, 'utf-8');
                const hash = crypto.createHash('md5').update(content).digest('hex');
                if (hash !== fileEntry.hash) {
                    return true;
                }
            } catch (e) {
                return true;
            }
        }

        return false;
    }
}

module.exports = { ProjectIndex };
