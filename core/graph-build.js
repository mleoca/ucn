/**
 * core/graph-build.js - Import/export and inheritance graph construction
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const path = require('path');
const { resolveImport } = require('./imports');
const { langTraits } = require('../languages');

/**
 * Build directory→files index for O(1) same-package lookups.
 * Replaces O(N) full-index scans in findCallers and countSymbolUsages.
 */
function buildDirIndex(index) {
    index.dirToFiles = new Map();
    for (const filePath of index.files.keys()) {
        const dir = path.dirname(filePath);
        let list = index.dirToFiles.get(dir);
        if (!list) {
            list = [];
            index.dirToFiles.set(dir, list);
        }
        list.push(filePath);
    }
}

/**
 * Resolve a Java package import to a project file.
 * Handles regular imports, static imports (strips member name), and wildcards (strips .*).
 * Progressively strips trailing segments to find the class file.
 * With `opts.all`, returns an ARRAY of files: for a package wildcard
 * (com.pkg.*) that's every file directly in the package — Java wildcard
 * imports pull in the whole package, and they are NOT recursive.
 */
function _resolveJavaPackageImport(index, importModule, javaFileIndex, opts = {}) {
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
                        return opts.all ? [absPath] : absPath;
                    }
                }
            }
        }
    } else {
        // Fallback: scan all files (used by imports() method outside buildImportGraph)
        for (let i = segments.length; i > 0; i--) {
            const fileSuffix = '/' + segments.slice(0, i).join('/') + '.java';
            for (const absPath of index.files.keys()) {
                if (absPath.endsWith(fileSuffix)) {
                    return opts.all ? [absPath] : absPath;
                }
            }
        }
    }

    // For wildcard imports (com.pkg.model.*), the package may be a directory
    // containing .java files. Match files DIRECTLY in the package directory —
    // a bare `includes()` also matched subpackage files, but Java wildcards
    // are not recursive.
    if (isWildcard) {
        const dirSuffix = '/' + segments.join('/');
        const matches = [];
        for (const absPath of index.files.keys()) {
            if (absPath.endsWith('.java') && path.dirname(absPath).endsWith(dirSuffix)) {
                matches.push(absPath);
                if (!opts.all) break;
            }
        }
        if (matches.length > 0) {
            return opts.all ? matches : matches[0];
        }
    }

    return opts.all ? [] : null;
}

/**
 * Build import/export relationship graphs
 */
function buildImportGraph(index) {
    index.importGraph.clear();
    index.exportGraph.clear();

    // Pre-build directory→files map for Go package linking (O(1) lookup vs O(n) scan)
    const dirToGoFiles = new Map();
    // Pre-build filename→files map for Java import resolution (O(1) vs O(n) scan)
    const javaFileIndex = new Map();
    for (const [fp, fe] of index.files) {
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

    for (const [filePath, fileEntry] of index.files) {
        const importedFiles = new Set();
        const seenModules = new Set();
        // Per-module resolution map (fix #209): module string → resolved
        // project file (ROOT-RELATIVE — fileEntry persists in the cache, so
        // paths must stay portable). Lets query-time code answer "which FILE
        // does the module behind this import binding live in" — file-level
        // importGraph edges can't (a file importing the target for OTHER
        // names is not evidence about THIS name's module).
        const moduleResolved = {};

        for (const importModule of fileEntry.imports) {
            // Skip null modules (e.g., dynamic include! macros in Rust)
            if (!importModule) continue;

            // Deduplicate: same module imported multiple times in one file
            // (e.g., lazy imports inside different functions)
            if (seenModules.has(importModule)) continue;
            seenModules.add(importModule);

            let resolved = resolveImport(importModule, filePath, {
                aliases: index.config.aliases,
                language: fileEntry.language,
                root: index.root
            });

            // Java package imports: resolve by progressive suffix matching
            // Handles regular, static (com.pkg.Class.method), and wildcard (com.pkg.Class.*) imports
            let javaWildcardFiles = null;
            if (!resolved && fileEntry.language === 'java' && !importModule.startsWith('.')) {
                if (importModule.endsWith('.*')) {
                    // A package wildcard depends on EVERY file in the package
                    // (the Go filesToLink analog) — linking only the first
                    // dropped dependency edges for the rest of the package.
                    const all = _resolveJavaPackageImport(index, importModule, javaFileIndex, { all: true });
                    if (all.length > 0) {
                        resolved = all[0];
                        if (all.length > 1) javaWildcardFiles = all;
                    }
                } else {
                    resolved = _resolveJavaPackageImport(index, importModule, javaFileIndex);
                }
            }

            if (resolved && index.files.has(resolved)) {
                moduleResolved[importModule] = path.relative(index.root, resolved);
                // For Go, a package import means all files in that directory are dependencies
                // (Go packages span multiple files in the same directory)
                const filesToLink = javaWildcardFiles ? [...javaWildcardFiles] : [resolved];
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
                    importedFiles.add(linkedFile);
                    if (!index.exportGraph.has(linkedFile)) {
                        index.exportGraph.set(linkedFile, new Set());
                    }
                    index.exportGraph.get(linkedFile).add(filePath);
                }
            }
        }

        // From-import submodules (fix #224): `from . import jobs` binds
        // jobs.py as a plain NAME — the parser can't know (a from-import name
        // may be a symbol), the resolver can. Resolve the composed dotted
        // specifier; a project-file hit records it in moduleResolved AND adds
        // the import edge, so scope resolution and module-receiver ownership
        // see the submodule exactly like `import jobs`.
        if (langTraits(fileEntry.language)?.submoduleImports) {
            for (const b of (fileEntry.importBindings || [])) {
                if (!b || !b.name || b.module == null) continue;
                const mod = String(b.module);
                const spec = mod.endsWith('.') ? mod + b.name : mod + '.' + b.name;
                if (moduleResolved[spec] || seenModules.has(spec)) continue;
                seenModules.add(spec);
                const resolved = resolveImport(spec, filePath, {
                    aliases: index.config.aliases,
                    language: fileEntry.language,
                    root: index.root
                });
                if (resolved && index.files.has(resolved)) {
                    moduleResolved[spec] = path.relative(index.root, resolved);
                    importedFiles.add(resolved);
                    if (!index.exportGraph.has(resolved)) {
                        index.exportGraph.set(resolved, new Set());
                    }
                    index.exportGraph.get(resolved).add(filePath);
                }
            }
        }

        index.importGraph.set(filePath, importedFiles);
        fileEntry.moduleResolved = moduleResolved;
    }
}

/**
 * Build inheritance relationship graphs
 */
function buildInheritanceGraph(index) {
    index.extendsGraph.clear();
    index.extendedByGraph.clear();

    // Collect all class/interface/struct names for alias resolution
    const classNames = new Set();
    for (const [, fileEntry] of index.files) {
        for (const symbol of fileEntry.symbols) {
            if (['class', 'interface', 'struct', 'trait', 'record'].includes(symbol.type)) {
                classNames.add(symbol.name);
            }
        }
    }

    for (const [filePath, fileEntry] of index.files) {
        for (const symbol of fileEntry.symbols) {
            if (!['class', 'interface', 'struct', 'trait', 'record'].includes(symbol.type)) {
                continue;
            }

            if (symbol.extends) {
                // Parse comma-separated parents (Python MRO: "Flyable, Swimmable").
                // Commas inside type arguments do NOT separate parents:
                // `extends Base<string, object>` is ONE parent `Base`, and
                // `class C(Mapping[str, int], Base)` is `Mapping` + `Base`.
                // The naive split made every generically-extended class
                // parentless (fix #214 — zod's whole ZodType hierarchy had no
                // ancestor edges, measured: 12 true base-class dispatch edges
                // demoted because `Base<string` never equals `Base`).
                const parents = splitParentList(symbol.extends);

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
                if (!index.extendsGraph.has(symbol.name)) {
                    index.extendsGraph.set(symbol.name, []);
                }
                index.extendsGraph.get(symbol.name).push({
                    file: filePath,
                    parents: resolvedParents
                });

                for (const parent of resolvedParents) {
                    if (!index.extendedByGraph.has(parent)) {
                        index.extendedByGraph.set(parent, []);
                    }
                    index.extendedByGraph.get(parent).push({
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
 * Split an extends/bases clause on TOP-LEVEL commas only and strip each
 * parent's trailing type-argument suffix: `Base<string, object>` → `Base`,
 * `Mapping[str, int], Flyable` → `Mapping`, `Flyable`. Depth-tracks <>, [],
 * and () so argument commas never split (fix #214).
 */
function splitParentList(clause) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of String(clause)) {
        if (ch === '<' || ch === '[' || ch === '(') depth++;
        else if (ch === '>' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    parts.push(current);
    return parts
        .map(s => s.trim().replace(/[<[(].*$/s, '').trim())
        .filter(Boolean);
}

module.exports = { buildDirIndex, buildImportGraph, buildInheritanceGraph, splitParentList, _resolveJavaPackageImport };
