/**
 * core/graph-build.js - Import/export and inheritance graph construction
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const path = require('path');
const { resolveImport, resolveRustModuleFile, rustModDeclarationFiles, jsWorkspacePackages } = require('./imports');

const JS_WORKSPACE_LANGUAGES = new Set(['javascript', 'typescript', 'tsx']);

/**
 * The project's in-repository JS/TS packages by name (fix #397), computed
 * once per build and on first use after a cache load.
 */
function jsWorkspacePackagesOf(index, refresh = false) {
    if (!refresh && index._jsWorkspacePackages !== undefined) return index._jsWorkspacePackages;
    const dirs = new Set();
    for (const [fp, fe] of index.files) {
        if (JS_WORKSPACE_LANGUAGES.has(fe.language)) dirs.add(path.dirname(fp));
    }
    index._jsWorkspacePackages = dirs.size > 0 ? jsWorkspacePackages(index.root, dirs) : null;
    return index._jsWorkspacePackages;
}
const { langTraits, getParser, safeParse } = require('../languages');

function _javaPackageTypes(index) {
    const packages = new Map();
    for (const [filePath, fileEntry] of index.files) {
        if (fileEntry.language !== 'java') continue;
        for (const symbol of fileEntry.symbols || []) {
            if (!symbol.namespace || !['class', 'interface', 'record', 'enum'].includes(symbol.type)) continue;
            let names = packages.get(symbol.namespace);
            if (!names) { names = new Map(); packages.set(symbol.namespace, names); }
            let files = names.get(symbol.name);
            if (!files) { files = new Set(); names.set(symbol.name, files); }
            files.add(filePath);
        }
    }
    return packages;
}

/** Collect same-package Java type references from AST roles that denote types. */
function _javaSamePackageDependencies(index, filePath, fileEntry, packageTypes) {
    const packageName = (fileEntry.symbols || []).find(symbol => symbol.namespace)?.namespace;
    const candidates = packageTypes.get(packageName);
    if (!packageName || !candidates || candidates.size === 0) return [];
    let tree;
    try {
        tree = safeParse(getParser('java'), index._readFile(filePath));
    } catch (_) {
        return [];
    }
    const referenced = new Set();
    const walk = node => {
        if (node.type === 'type_identifier' && candidates.has(node.text)) {
            referenced.add(node.text);
        } else if (node.type === 'identifier' && candidates.has(node.text)) {
            const parent = node.parent;
            if (parent && ((parent.type === 'method_invocation' &&
                parent.childForFieldName('object')?.id === node.id) ||
                (parent.type === 'field_access' &&
                parent.childForFieldName('object')?.id === node.id))) {
                referenced.add(node.text);
            }
        }
        for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i));
    };
    walk(tree.rootNode);
    const out = new Set();
    for (const name of referenced) {
        for (const target of candidates.get(name) || []) {
            if (target !== filePath) out.add(target);
        }
    }
    return [...out];
}

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

function _buildCSharpNamespaceIndex(index) {
    const namespaces = new Map();
    const add = (key, file) => {
        if (!key) return;
        if (!namespaces.has(key)) namespaces.set(key, []);
        if (!namespaces.get(key).includes(file)) namespaces.get(key).push(file);
    };
    for (const [filePath, fileEntry] of index.files) {
        if (fileEntry.language !== 'csharp') continue;
        for (const symbol of fileEntry.symbols || []) {
            if (!['class', 'interface', 'struct', 'record', 'enum'].includes(symbol.type)) {
                continue;
            }
            add(symbol.namespace, filePath);
            if (symbol.namespace) add(`${symbol.namespace}.${symbol.name}`, filePath);
        }
    }
    return namespaces;
}

/**
 * A C# file's using directives by the names C# resolves them to (fix #395):
 * each written name resolved from the namespace its directive sits in,
 * generic arguments of `using static T<X>` dropped. `written` collects the
 * written spellings of names that resolved to something else.
 */
function _csharpResolvedImports(index, fileEntry, written) {
    const { csharpResolveUsingName } = require('./type-denotation');
    const details = (fileEntry.importDetails || []).filter(detail => detail.module);
    if (details.length === 0) return fileEntry.imports || [];
    const out = [];
    for (const detail of details) {
        if (!detail.namespace) {
            out.push(String(detail.module).replace(/<.*$/s, ''));
            continue;
        }
        const resolved = csharpResolveUsingName(index, detail.module, detail.namespace).replace(/<.*$/s, '');
        out.push(resolved);
        if (resolved !== detail.module) {
            if (!written.has(resolved)) written.set(resolved, []);
            written.get(resolved).push(detail.module);
        }
    }
    return out;
}

function _resolveCSharpUsing(index, importModule, namespaceIndex = null, opts = {}) {
    const map = namespaceIndex || _buildCSharpNamespaceIndex(index);
    const matches = map.get(importModule) || [];
    if (opts.all) return [...matches];
    return matches[0] || null;
}

/**
 * Build import/export relationship graphs
 */
/** basename -> C/C++ project files carrying it (for include suffix matching). */
function _buildCIncludeSuffixIndex(index) {
    const byBasename = new Map();
    for (const [filePath, fileEntry] of index.files) {
        if (fileEntry.language !== 'c' && fileEntry.language !== 'cpp') continue;
        const base = path.basename(filePath);
        if (!byBasename.has(base)) byBasename.set(base, []);
        byBasename.get(base).push(filePath);
    }
    return byBasename;
}

function _resolveCIncludeBySuffix(byBasename, includeName, fromFile) {
    const normalized = String(includeName || '').replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) return null;
    const candidates = (byBasename.get(path.posix.basename(normalized)) || [])
        .filter(file => file !== fromFile &&
            file.split(path.sep).join('/').endsWith(`/${normalized}`));
    return candidates.length === 1 ? candidates[0] : null;
}

function _isRustCrateRootFile(file) {
    const base = path.basename(file);
    return base === 'lib.rs' || base === 'main.rs';
}

/**
 * Rust module files a `use` path names when a segment is reached through a
 * glob re-export or a module re-export binding rather than a `mod` file
 * (fix #369). Walks the module segments from the path root, at each module
 * trying its child module file, then its `pub use m as seg` / `use x::seg`
 * bindings, then its top-level glob imports (bounded depth). Returns the one
 * module file that holds the final item (declared or re-exported), or null
 * when the walk is ambiguous or leaves the project.
 */
function _rustWalkUsePath(index, fromFile, spec) {
    const segments = String(spec).split('::').filter(Boolean);
    if (segments.length < 2) return null;
    const root = segments[0];
    let start;
    try {
        start = resolveRustModuleFile(root, fromFile, index.root);
    } catch { start = null; }
    if (!start || !index.files.has(start)) return null;
    const childModule = (file, name) => {
        const base = path.basename(file);
        const dir = base === 'lib.rs' || base === 'main.rs' || base === 'mod.rs'
            ? path.dirname(file) : path.join(path.dirname(file), path.basename(file, '.rs'));
        for (const candidate of [path.join(dir, `${name}.rs`), path.join(dir, name, 'mod.rs')]) {
            if (index.files.has(candidate)) {
                const declares = (index.files.get(file)?.symbols || []).some(symbol =>
                    symbol.type === 'module' && symbol.name === name);
                if (declares) return candidate;
            }
        }
        return null;
    };
    const topLevel = (entry, line) => line == null || !(entry.symbols || []).some(symbol =>
        symbol.type === 'module' && symbol.startLine < line && symbol.endLine >= line);
    // Module files reachable as `name` inside module file `file`.
    const lookup = (file, name, seen, depth) => {
        const key = `${file}\0${name}`;
        if (seen.has(key) || depth > 6) return [];
        seen.add(key);
        const entry = index.files.get(file);
        if (!entry) return [];
        const child = childModule(file, name);
        if (child) return [child];
        const out = [];
        for (const binding of entry.importBindings || []) {
            if ((binding.alias || binding.name) !== name || binding.name === '*') continue;
            try {
                const target = resolveRustModuleFile(binding.module, file, index.root);
                if (target && index.files.has(target) && target !== file) out.push(target);
            } catch { /* resolver gap */ }
        }
        if (out.length > 0) return out;
        for (const detail of entry.importDetails || []) {
            if (detail.type !== 'use-glob' || !detail.module || !topLevel(entry, detail.line)) continue;
            let target;
            try { target = resolveRustModuleFile(detail.module, file, index.root); } catch { target = null; }
            if (!target || !index.files.has(target) || target === file) continue;
            out.push(...lookup(target, name, seen, depth + 1));
        }
        return out;
    };
    let current = [start];
    for (let i = 1; i < segments.length - 1; i++) {
        const next = new Set();
        for (const file of current) {
            for (const hit of lookup(file, segments[i], new Set(), 0)) next.add(hit);
        }
        if (next.size !== 1) return null;
        current = [...next];
    }
    const result = current[0];
    return result && result !== fromFile ? result : null;
}

function buildImportGraph(index) {
    index.importGraph.clear();
    index.exportGraph.clear();

    // Pre-build directory→files map for Go package linking (O(1) lookup vs O(n) scan)
    const dirToGoFiles = new Map();
    // Pre-build filename→files map for Java import resolution (O(1) vs O(n) scan)
    const javaFileIndex = new Map();
    const javaPackageTypes = _javaPackageTypes(index);
    const csharpNamespaceIndex = _buildCSharpNamespaceIndex(index);
    const csharpGlobalImports = new Set();
    for (const [fp, fe] of index.files) {
        if (langTraits(fe.language)?.packageScope === 'directory') {
            const dir = path.dirname(fp);
            if (!dirToGoFiles.has(dir)) dirToGoFiles.set(dir, []);
            dirToGoFiles.get(dir).push(fp);
        } else if (fe.language === 'java') {
            const name = path.basename(fp, '.java');
            if (!javaFileIndex.has(name)) javaFileIndex.set(name, []);
            javaFileIndex.get(name).push(fp);
        } else if (fe.language === 'csharp') {
            for (const moduleName of (fe.globalImports || [])) {
                if (moduleName) csharpGlobalImports.add(moduleName);
            }
        }
    }

    let cIncludeSuffixIndex = null;
    const includeProbeCache = new Map(); // include search results for this build (fix #365)
    const workspacePackages = jsWorkspacePackagesOf(index, true);
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
        const includeFallback = {};

        // C# using directives name what C# resolves them to from the
        // namespace each is written in (fix #395): `using Internal;` inside
        // `namespace Acme.Tests` imports Acme.Internal.
        const csharpWritten = fileEntry.language === 'csharp' ? new Map() : null;
        const effectiveImports = csharpWritten
            ? [..._csharpResolvedImports(index, fileEntry, csharpWritten), ...csharpGlobalImports]
            : (fileEntry.imports || []);
        // Rust `mod NAME;` declarations load files by the module layout
        // rules (fix #377: foo.rs + foo/ children, #[path], inline-module
        // nesting), never by a plain name lookup from the declaring directory.
        const rustModFiles = fileEntry.language === 'rust'
            ? rustModDeclarationFiles(filePath, fileEntry, candidate => index.files.has(candidate))
            : null;
        for (const importModule of effectiveImports) {
            // Skip null modules (e.g., dynamic include! macros in Rust)
            if (!importModule) continue;

            // Deduplicate: same module imported multiple times in one file
            // (e.g., lazy imports inside different functions)
            if (seenModules.has(importModule)) continue;
            seenModules.add(importModule);

            const rustModTargets = rustModFiles &&
                (fileEntry.importDetails || []).some(detail => detail.type === 'mod' && detail.module === importModule)
                ? (rustModFiles.get(importModule) || []) : null;
            let resolved = rustModTargets ? (rustModTargets[0] || null) : resolveImport(importModule, filePath, {
                aliases: index.config.aliases,
                includePaths: index.config.includePaths,
                language: fileEntry.language,
                root: index.root,
                probeCache: includeProbeCache,
                workspacePackages,
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

            // C/C++ quoted include that neither the including file's
            // directory nor any known include directory resolves: the build
            // adds an -I path the index cannot see (no compile database). A
            // project header whose path ends with the include name, when
            // exactly one such header exists, is the only file a compiler
            // search could find inside the project. The edge is recorded as
            // basename-resolved so consumers can weigh it below edges the
            // resolver proved (fix #361).
            if (!resolved && (fileEntry.language === 'c' || fileEntry.language === 'cpp') &&
                importModule.startsWith('./')) {
                if (!cIncludeSuffixIndex) cIncludeSuffixIndex = _buildCIncludeSuffixIndex(index);
                resolved = _resolveCIncludeBySuffix(
                    cIncludeSuffixIndex, importModule.slice(2), filePath);
                if (resolved) includeFallback[importModule] = true;
            }

            let csharpFiles = null;
            if (!resolved && fileEntry.language === 'csharp') {
                const all = _resolveCSharpUsing(
                    index, importModule, csharpNamespaceIndex, { all: true });
                if (all.length > 0) {
                    resolved = all[0];
                    csharpFiles = all;
                }
            }

            // Rust module paths through glob re-exports (fix #369): `use
            // cursive::views::LinearLayout` where cursive's root is `pub use
            // cursive_core::*` resolves past the facade crate root instead
            // of stopping at it.
            if (fileEntry.language === 'rust' && importModule.includes('::') &&
                (!resolved || _isRustCrateRootFile(resolved))) {
                const walked = _rustWalkUsePath(index, filePath, importModule);
                if (walked) resolved = walked;
            }

            if (resolved && index.files.has(resolved)) {
                moduleResolved[importModule] = path.relative(index.root, resolved);
                // For Go, a package import means all files in that directory are dependencies
                // (Go packages span multiple files in the same directory)
                const filesToLink = javaWildcardFiles
                    ? [...javaWildcardFiles]
                    : csharpFiles ? [...csharpFiles]
                    : rustModTargets?.length > 1 ? [...rustModTargets] : [resolved];
                if (langTraits(fileEntry.language)?.packageScope === 'directory') {
                    const pkgDir = path.dirname(resolved);
                    const dirFiles = dirToGoFiles.get(pkgDir) || [];
                    for (const fp of dirFiles) {
                        if (fp !== resolved && fp !== filePath) {
                            // Test files are compilation inputs, never part of
                            // an importable Go package surface.
                            if (fp.endsWith('_test.go')) continue;
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

        // The written spelling of a relative C# directive maps to the file
        // its resolved name reaches (alias bindings keep the written text).
        if (csharpWritten) {
            for (const [resolvedName, writtens] of csharpWritten) {
                const rel = moduleResolved[resolvedName];
                if (!rel) continue;
                for (const written of writtens) {
                    if (!moduleResolved[written]) moduleResolved[written] = rel;
                }
            }
        }

        // Java same-package visibility needs no import declaration. Add only
        // AST-proven type/static-qualifier references, not a package clique.
        if (fileEntry.language === 'java') {
            for (const linkedFile of _javaSamePackageDependencies(
                index, filePath, fileEntry, javaPackageTypes)) {
                importedFiles.add(linkedFile);
                if (!index.exportGraph.has(linkedFile)) {
                    index.exportGraph.set(linkedFile, new Set());
                }
                index.exportGraph.get(linkedFile).add(filePath);
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
                    root: index.root,
                    probeCache: includeProbeCache,
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
        if (langTraits(fileEntry.language)?.hasReceiverPackageCalls) {
            _applyGoImportNames(index, filePath, fileEntry, moduleResolved, dirToGoFiles);
        }
        if (Object.keys(includeFallback).length > 0) {
            fileEntry.includeFallback = includeFallback;
        } else {
            delete fileEntry.includeFallback;
        }
    }
}

/**
 * The local name of a Go import that writes none is the package clause of
 * the package it imports, which its path only suggests (fix #400):
 * `example.com/m/internal/go-utils` may declare `package utils`. For a
 * project package that clause is known; an outside package keeps the
 * parser's path-derived name, which no query treats as proof (an
 * identifier the file does not otherwise bind may name such an import).
 * The file's call records were read with the parser's names: when the
 * resolved names differ they are read again on first use (a build's callee
 * index reads them). The parser's suggestion follows the Go tools'
 * convention (goPathPackageName), so few project packages need this.
 */
function _applyGoImportNames(index, filePath, fileEntry, moduleResolved, dirToGoFiles) {
    const details = fileEntry.importDetails || [];
    const names = fileEntry.importNames || [];
    if (details.length === 0 || names.length !== details.length) return;
    let next = null;
    for (let i = 0; i < details.length; i++) {
        const detail = details[i];
        let name = detail.names?.[0];
        if (detail.implicitName && moduleResolved[detail.module]) {
            const rel = moduleResolved[detail.module];
            const dir = path.dirname(path.isAbsolute(rel) ? rel : path.join(index.root, rel));
            const clause = (dirToGoFiles.get(dir) || []).map(file => index.files.get(file))
                .find(entry => entry?.packageName && !entry.relativePath?.endsWith('_test.go') &&
                    !entry.packageName.endsWith('_test'))?.packageName;
            if (clause) name = clause;
        }
        if (name && names[i] !== name) {
            if (!next) next = names.slice();
            next[i] = name;
        }
    }
    if (!next) return;
    const changed = new Set();
    for (let i = 0; i < next.length; i++) {
        if (next[i] !== names[i]) {
            if (names[i]) changed.add(names[i]);
            changed.add(next[i]);
        }
    }
    fileEntry.importNames = next;
    for (const binding of fileEntry.importBindings || []) {
        const at = details.findIndex(detail => detail.module === binding.module && detail.line === binding.line);
        if (at >= 0 && details[at].implicitName) binding.name = next[at];
    }
    // An import name is only ever written as a qualifier (`name.X`): records
    // of a file that never writes one of the changed names are unchanged.
    let content = '';
    try { content = index._readFile(filePath); } catch { content = null; }
    if (content != null && ![...changed].some(name => content.includes(`${name}.`))) return;
    // Drop the records read with the old names (loading this file's shard
    // first, so a later shard load cannot bring them back).
    if (index._callsCachePrepared && !index._callsCacheLoaded) {
        require('./cache').ensureCallsShardForFile(index, filePath);
    }
    if (index.callsCache.delete(filePath)) index.callsCacheDirty = true;
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
                    // Nominal languages commonly spell a project base with a
                    // namespace/package qualifier (`detail::buffer<T>`,
                    // `demo.Base`). The symbol table is keyed by the terminal
                    // type name, so retaining the qualifier disconnects the
                    // inheritance graph and can turn an inherited method call
                    // into a false receiver mismatch. Strip it only when an
                    // indexed type has the matching compiler owner; suffix
                    // matching accommodates parsers which retain either the
                    // full namespace or only its innermost component.
                    if (langTraits(fileEntry.language)?.typeSystem === 'nominal' &&
                        (parent.includes('::') || parent.includes('.'))) {
                        const separator = parent.includes('::') ? '::' : '.';
                        const pieces = parent.split(separator).filter(Boolean);
                        const terminal = pieces.pop();
                        const qualifier = pieces.join(separator);
                        const typeKinds = new Set([
                            'class', 'interface', 'struct', 'trait', 'record',
                        ]);
                        const matches = (index.symbols.get(terminal) || [])
                            .filter(definition => {
                                if (!typeKinds.has(definition.type)) return false;
                                const owner = String(definition.namespace || '');
                                return owner === qualifier ||
                                    owner.endsWith(`${separator}${qualifier}`) ||
                                    qualifier.endsWith(`${separator}${owner}`);
                            });
                        if (matches.length > 0 &&
                            new Set(matches.map(definition =>
                                definition.namespace || '')).size === 1) {
                            return terminal;
                        }
                    }
                    // Qualified structural parent: `class CustomCommand(
                    // click.Command)`. The symbol table owns bare class names,
                    // so keeping `click.Command` makes the subclass invisible
                    // to dispatch/reachability. Normalize only when the
                    // qualifier is an actual project module import and its
                    // bounded import graph reaches exactly one matching class
                    // definition—never by suffix alone.
                    if (langTraits(fileEntry.language)?.typeSystem === 'structural' && parent.includes('.')) {
                        const pieces = parent.split('.');
                        const localModule = pieces[0];
                        const className = pieces[pieces.length - 1];
                        const binding = (fileEntry.importBindings || []).find(b => b.name === localModule);
                        const rel = binding && fileEntry.moduleResolved?.[binding.module];
                        if (rel && classNames.has(className)) {
                            const moduleFile = path.join(index.root, rel);
                            const candidateFiles = new Set((index.symbols.get(className) || [])
                                .filter(d => ['class', 'interface', 'struct', 'trait', 'record'].includes(d.type))
                                .map(d => d.file).filter(Boolean));
                            const reached = new Set();
                            const queue = [{ file: moduleFile, depth: 0 }];
                            const seen = new Set();
                            while (queue.length > 0) {
                                const cur = queue.shift();
                                if (!cur.file || seen.has(cur.file) || cur.depth > 4) continue;
                                seen.add(cur.file);
                                if (candidateFiles.has(cur.file)) reached.add(cur.file);
                                for (const next of index.importGraph.get(cur.file) || []) {
                                    queue.push({ file: next, depth: cur.depth + 1 });
                                }
                            }
                            if (reached.size === 1) return className;
                        }
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
                    // Per-def anchor (fix #300, attrs-measured): five
                    // function-local `class C2Slots(...)` defs in one file
                    // carry DIFFERENT parents — file-granular lookup returned
                    // the first entry for all of them. startLine lets scope-
                    // aware consumers pick the def the call site actually sees.
                    startLine: symbol.startLine,
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

module.exports = {
    buildDirIndex,
    buildImportGraph,
    jsWorkspacePackagesOf,
    buildInheritanceGraph,
    splitParentList,
    _resolveJavaPackageImport,
    _resolveCSharpUsing,
    _rustWalkUsePath,
};
