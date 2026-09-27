/**
 * core/imports.js - Import/export parsing for dependency tracking
 *
 * Extracts import and export statements from source files
 * to build dependency graphs.
 */

const fs = require('fs');
const path = require('path');
const { getParser, getLanguageAdapter } = require('../languages');

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

    const langModule = getLanguageAdapter(moduleLang);
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

    return { imports: [], dynamicCount: 0, importAliases: null };
}

/**
 * Extract exports from file content using AST
 */
function extractExports(content, language) {
    // Use JS language module for TS/TSX (same export syntax), but the actual language's parser
    const moduleLang = (language === 'typescript' || language === 'tsx') ? 'javascript' : language;

    const langModule = getLanguageAdapter(moduleLang);
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

    // C/C++ angle-bracket includes search the -I directories (never the
    // including file's directory); a project header found there is part of
    // the translation unit exactly like a quoted include.
    if ((config.language === 'c' || config.language === 'cpp') &&
        !importPath.startsWith('.') && !importPath.startsWith('/')) {
        return resolveCIncludeFromDirectories(importPath, fromFile, config);
    }

    // External packages (not relative or alias)
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
        // Check aliases
        if (config.aliases) {
            for (const [alias, target] of Object.entries(config.aliases)) {
                if (importPath === alias || importPath.startsWith(alias + '/')) {
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
                                let resolved = target;
                            let groupIdx = 1;
                            resolved = resolved.replace(/\*/g, () => match[groupIdx++] || '');
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

            // Package self-reference (import own package by name)
            const selfResolved = resolveSelfReference(importPath, fromDir, config);
            if (selfResolved) return selfResolved;
            // Another package of the same repository (fix #397).
            const workspaceResolved = resolveWorkspacePackage(importPath, config);
            if (workspaceResolved) return workspaceResolved;
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
            // PEP-517 src layout (fix #269, click-measured): the installed
            // package lives under src/ — `import click` from tests/ resolves
            // to src/click/__init__.py. Without this, the module-ownership
            // discipline judged the project's OWN package provably external
            // (excluded every `click.get_binary_stream(...)` test caller —
            // a false zero-caller answer).
            const srcPath = path.join(config.root, 'src', modulePath);
            const srcResolved = resolveFilePath(srcPath, getExtensions('python'));
            if (srcResolved) return srcResolved;
            // Nested source root (fix #366): an application under a
            // subdirectory (`backend/app/...`) runs with that subdirectory on
            // sys.path, so `from app.core import x` means backend/app/core.
            // The nearest ancestor of the importing file that is NOT itself a
            // package and directly contains the module's first segment is
            // the source root the interpreter would use. Package directories
            // are skipped so a sibling module never answers an absolute import.
            const nested = _resolvePythonNestedRoot(importPath, fromDir, config);
            if (nested) return nested;
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
    const extensions = config.extensions || getExtensions(config.language);
    const resolved = path.resolve(fromDir, normalizedPath);
    const direct = resolveFilePath(resolved, extensions);
    if (direct) return direct;

    // C/C++ quoted includes may be rooted at compiler -I/-iquote paths rather
    // than the importing file.
    if (config.language === 'c' || config.language === 'cpp') {
        return resolveCIncludeFromDirectories(normalizedPath.replace(/^\.\//, ''), fromFile, config);
    }
    return null;
}

/**
 * Search the compiler include directories for a C/C++ include name.
 * compile_commands.json is the authoritative build metadata when present;
 * configured include paths follow, then the deterministic project roots.
 * Unresolved system includes remain external.
 */
function resolveCIncludeFromDirectories(includeName, fromFile, config) {
    const { includeDirectoriesForFile } = require('./compilation-database');
    const extensions = config.extensions || getExtensions(config.language);
    const includeDirs = includeDirectoriesForFile(fromFile, config.root);
    for (const configured of config.includePaths || []) {
        if (typeof configured !== 'string' || !configured.trim()) continue;
        includeDirs.push(path.isAbsolute(configured)
            ? configured
            : path.resolve(config.root || path.dirname(fromFile), configured));
    }
    // Header-only/source-distribution projects commonly omit a generated
    // compile_commands.json but still use the conventional public
    // `include/` root (`#include "fmt/format.h"`). These are project-owned
    // files, not external packages. Try explicit compiler metadata first,
    // then deterministic project roots; never search arbitrary parents.
    if (config.root) {
        includeDirs.push(config.root, path.join(config.root, 'include'));
    }
    // One import-graph build probes the same few directories for the same
    // system headers from every file (`<stdio.h>`); the filesystem does not
    // change within it, so a caller-owned memo answers repeats (fix #365).
    const dirs = [...new Set(includeDirs)];
    const memo = config.probeCache;
    const memoKey = memo ? `${includeName}\0${extensions.join(',')}\0${dirs.join('\0')}` : null;
    if (memo && memo.has(memoKey)) return memo.get(memoKey);
    let found = null;
    for (const includeDir of dirs) {
        const candidate = resolveFilePath(path.resolve(includeDir, includeName), extensions);
        if (candidate) { found = candidate; break; }
    }
    if (memo) memo.set(memoKey, found);
    return found;
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
                    // Parse replace directives for local module redirects
                    // e.g., k8s.io/api => ./staging/src/k8s.io/api
                    const replaces = [];
                    // Block form: replace ( ... )
                    const replaceBlock = content.match(/^replace\s*\(([\s\S]*?)\)/m);
                    if (replaceBlock) {
                        for (const line of replaceBlock[1].split('\n')) {
                            const rm = line.match(/^\s*(\S+)\s.*?=>\s*(\S+)/);
                            if (rm && rm[2].startsWith('.')) {
                                replaces.push({ from: rm[1], to: path.resolve(dir, rm[2]) });
                            }
                        }
                    }
                    // Single-line form: replace k8s.io/foo => ./bar
                    for (const rm of content.matchAll(/^replace\s+(\S+)\s.*?=>\s*(\S+)/gm)) {
                        if (rm[2].startsWith('.')) {
                            replaces.push({ from: rm[1], to: path.resolve(dir, rm[2]) });
                        }
                    }
                    const result = { modulePath: match[1], root: dir, replaces };
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
 * Find the first non-test .go file in a directory (Go packages are directories).
 * @param {string} pkgDir - Absolute path to the package directory
 * @returns {string|null}
 */
function findFirstGoFile(pkgDir) {
    try {
        if (fs.existsSync(pkgDir) && fs.statSync(pkgDir).isDirectory()) {
            const files = fs.readdirSync(pkgDir).sort();
            for (const file of files) {
                if (file.endsWith('.go') && !file.endsWith('_test.go')) {
                    return path.join(pkgDir, file);
                }
            }
        }
    } catch (e) { /* ignore */ }
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
    if (importPath === modulePath || importPath.startsWith(modulePath + '/')) {
        const relativePath = importPath.slice(modulePath.length).replace(/^\//, '');
        const resolved = findFirstGoFile(path.join(root, relativePath));
        if (resolved) return resolved;
    }

    // Check replace directives (e.g., k8s.io/api => ./staging/src/k8s.io/api)
    if (goMod.replaces) {
        for (const { from, to } of goMod.replaces) {
            if (importPath === from || importPath.startsWith(from + '/')) {
                const relativePath = importPath.slice(from.length).replace(/^\//, '');
                const resolved = findFirstGoFile(path.join(to, relativePath));
                if (resolved) return resolved;
                break;
            }
        }
    }

    return null;
}

// Cache for Rust crate roots (Cargo.toml locations)
const cargoCache = new Map();

// Workspace crate registry (fix #258): Cargo [package] name → crate source
// root for EVERY crate in the project tree, so cross-crate workspace imports
// (`use clap::Command` from clap_bench/) resolve like own-package imports.
// One bounded scan per project root. The scan runs at build time and its
// manifests are persisted in the index cache (fix #372): a cache-loaded index
// seeds the registry instead of walking the tree on the first query.
const workspaceCrateCache = new Map();
const _WORKSPACE_SCAN_PRUNE = new Set([
    'node_modules', '.git', 'target', 'vendor', 'dist', 'build', '.ucn-cache',
]);
const _WORKSPACE_SCAN_MAX_DEPTH = 6;

/**
 * Directories holding a Cargo.toml, in the registry scan's order (depth-first,
 * directory-entry order). Bounded by depth and the prune set.
 * @param {string} projectRoot
 * @returns {string[]} absolute directories
 */
function scanWorkspaceManifestDirs(projectRoot) {
    const dirs = [];
    const walk = (dir, depth) => {
        if (depth > _WORKSPACE_SCAN_MAX_DEPTH) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (_WORKSPACE_SCAN_PRUNE.has(e.name) || e.name.startsWith('.')) continue;
                walk(path.join(dir, e.name), depth + 1);
            } else if (e.name === 'Cargo.toml') {
                dirs.push(dir);
            }
        }
    };
    walk(projectRoot, 0);
    return dirs;
}

/**
 * Order-free fingerprint of the Cargo.toml paths file discovery reports, so
 * a staleness check (which walks the tree for new files anyway) sees a
 * manifest appear or disappear without a second walk.
 * @param {string[]} relativeManifestPaths
 */
function manifestSetFingerprint(relativeManifestPaths) {
    const sorted = [...relativeManifestPaths].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    return require('crypto').createHash('md5').update(sorted.join('\0')).digest('hex');
}

function _registryFromManifestDirs(dirs) {
    const registry = new Map();
    for (const dir of dirs) {
        const info = findCargoRoot(dir);
        if (info && info.packageName && !registry.has(info.packageName)) {
            registry.set(info.packageName, info);
        }
    }
    return registry;
}

function workspaceCrateRegistry(projectRoot) {
    if (workspaceCrateCache.has(projectRoot)) {
        return workspaceCrateCache.get(projectRoot);
    }
    const registry = _registryFromManifestDirs(scanWorkspaceManifestDirs(projectRoot));
    workspaceCrateCache.set(projectRoot, registry);
    return registry;
}

/**
 * Snapshot of the project's Cargo manifests for the index cache: every
 * manifest the registry scan reaches, with its stat identity and the parsed
 * crate facts findCargoRoot derives from it. Also (re)seeds the in-process
 * caches from a fresh read.
 * @param {string} projectRoot
 * @returns {Array<{dir, mtime, size, packageName, srcDir, targetDirs}>} project-relative
 */
function snapshotWorkspaceManifests(projectRoot) {
    resetCargoCaches(projectRoot);
    const dirs = scanWorkspaceManifestDirs(projectRoot);
    const rel = p => path.relative(projectRoot, p);
    const out = [];
    for (const dir of dirs) {
        let stat;
        try { stat = fs.statSync(path.join(dir, 'Cargo.toml')); } catch { continue; }
        const info = findCargoRoot(dir);
        if (!info || info.root !== dir) continue;
        out.push({
            dir: rel(dir), mtime: stat.mtimeMs, size: stat.size,
            packageName: info.packageName,
            srcDir: rel(info.srcDir),
            targetDirs: info.targetDirs.map(rel),
        });
    }
    workspaceCrateCache.set(projectRoot, _registryFromManifestDirs(dirs));
    return out;
}

/**
 * Seed the in-process manifest caches from a persisted snapshot, so a
 * cache-loaded index resolves workspace crates without reading the tree.
 */
function seedWorkspaceManifests(projectRoot, manifests) {
    if (!Array.isArray(manifests)) return;
    const dirs = [];
    for (const m of manifests) {
        const dir = path.join(projectRoot, m.dir);
        dirs.push(dir);
        cargoCache.set(dir, {
            root: dir,
            srcDir: path.join(projectRoot, m.srcDir),
            packageName: m.packageName,
            targetDirs: m.targetDirs.map(t => path.join(projectRoot, t)),
        });
    }
    workspaceCrateCache.set(projectRoot, _registryFromManifestDirs(dirs));
}

/**
 * Whether a persisted manifest snapshot still describes the tree: every
 * manifest keeps its size and mtime, and (when discovery results are given)
 * discovery reports the same set of Cargo.toml paths as when it was taken.
 * @param {string} projectRoot
 * @param {Array} manifests - persisted snapshot
 * @param {string[]|null} [discovered] - project-relative Cargo.toml paths discovery saw now
 * @param {string|null} [seenFingerprint] - manifestSetFingerprint at snapshot time
 */
function workspaceManifestsCurrent(projectRoot, manifests, discovered = null, seenFingerprint = null) {
    if (!Array.isArray(manifests)) return false;
    for (const m of manifests) {
        let stat;
        try { stat = fs.statSync(path.join(projectRoot, m.dir, 'Cargo.toml')); } catch { return false; }
        if (stat.size !== m.size || stat.mtimeMs !== m.mtime) return false;
    }
    if (discovered && seenFingerprint &&
        manifestSetFingerprint(discovered) !== seenFingerprint) return false;
    return true;
}

/** Drop in-process manifest facts below a project root (a manifest changed). */
function resetCargoCaches(projectRoot) {
    workspaceCrateCache.delete(projectRoot);
    rustImportMemo.clear();
    const prefix = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
    for (const key of [...cargoCache.keys()]) {
        if (key === projectRoot || key.startsWith(prefix)) cargoCache.delete(key);
    }
}

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
            // Flat-layout crates (lib.rs/main.rs next to Cargo.toml, no src/)
            // root their module tree at the Cargo.toml directory — requiring
            // src/ left every crate:: path in such crates unresolved.
            const srcDir = path.join(dir, 'src');
            // The [package] name is the crate's import identity for its OWN
            // integration tests/benches/examples (`use mypkg::...` in
            // tests/*.rs — fix #246); `-` normalizes to `_` in code.
            let packageName = null;
            const targetDirs = [];
            try {
                const toml = fs.readFileSync(cargoPath, 'utf-8');
                const pkgSection = toml.split(/^\s*\[/m).find(s => s.startsWith('package]'));
                const m = pkgSection && pkgSection.match(/^\s*name\s*=\s*"([^"]+)"/m);
                if (m) packageName = m[1].replace(/-/g, '_');
                // Explicit target roots (fix #260b, ripgrep-measured): a
                // manifest may root its targets OUTSIDE src/ — ripgrep's
                // `[[bin]] path = "crates/core/main.rs"` puts the whole bin
                // module tree under crates/core, so `crate::messages` from
                // crates/core/flags/parse.rs resolves THERE, never at src/.
                // Collect every declared .rs target path's directory.
                for (const tm of toml.matchAll(/^\s*path\s*=\s*"([^"]+\.rs)"/gm)) {
                    const tDir = path.dirname(path.resolve(dir, tm[1]));
                    if (!targetDirs.includes(tDir)) targetDirs.push(tDir);
                }
            } catch { /* unreadable Cargo.toml — no package identity */ }
            const result = { root: dir, srcDir: fs.existsSync(srcDir) ? srcDir : dir, packageName, targetDirs };
            cargoCache.set(startDir, result);
            return result;
        }
        dir = path.dirname(dir);
    }

    cargoCache.set(startDir, null);
    return null;
}

/**
 * Resolve the FILE that owns the module rooted at `dir`: dir/mod.rs (2015
 * layout), <dir>.rs (2018 layout — the module file sits beside its directory),
 * or the crate root lib.rs/main.rs. Used when a use-path names an ITEM
 * declared directly in that module file (e.g. `use super::CONFIG`) — there is
 * no <item>.rs to find, the import points at the module file itself.
 * @param {string} dir - Module directory
 * @param {string} [fromFile] - Importing file, never returned as its own target
 * @returns {string|null}
 */
function rustModuleOwnFile(dir, fromFile) {
    const candidates = [
        path.join(dir, 'mod.rs'),
        dir + '.rs',
        path.join(dir, 'lib.rs'),
        path.join(dir, 'main.rs'),
    ];
    for (const c of candidates) {
        if (c !== fromFile && fs.existsSync(c) && fs.statSync(c).isFile()) {
            return c;
        }
    }
    return null;
}

/**
 * Try to resolve a Rust module path to a file
 * Checks both <path>.rs and <path>/mod.rs
 * @param {string} dir - Base directory
 * @param {string[]} segments - Path segments to resolve
 * @returns {string|null}
 */
function rustPathHasExactCase(base, file) {
    // Rust names remain case-sensitive on case-insensitive filesystems.
    // Check directory entries, rather than realpath, so legitimate symlinked
    // modules keep their declared spelling and remain resolvable.
    let current = base;
    for (const part of path.relative(base, file).split(path.sep)) {
        const entries = rustDirEntries(current);
        if (!entries || !entries.has(part)) return false;
        current = path.join(current, part);
    }
    return true;
}

// Directory listings the case check reads, memoized with the resolution memo
// below (fix #375: every module probe re-read its directories; ~40% of a
// large workspace's import graph build).
const rustDirEntriesMemo = new Map();

function rustDirEntries(dir) {
    let entries = rustDirEntriesMemo.get(dir);
    if (entries === undefined) {
        try {
            entries = new Set(fs.readdirSync(dir));
        } catch {
            entries = null;
        }
        rustDirEntriesMemo.set(dir, entries);
    }
    return entries;
}

function resolveRustModulePath(dir, segments) {
    // Try progressively shorter paths (items at the end may be types, not modules)
    for (let len = segments.length; len >= 1; len--) {
        const modPath = path.join(dir, ...segments.slice(0, len));
        // Try <path>.rs
        const rsFile = modPath + '.rs';
        if (fs.existsSync(rsFile) && fs.statSync(rsFile).isFile() && rustPathHasExactCase(dir, rsFile)) {
            return rsFile;
        }
        // Try <path>/mod.rs
        const modFile = path.join(modPath, 'mod.rs');
        if (fs.existsSync(modFile) && fs.statSync(modFile).isFile() && rustPathHasExactCase(dir, modFile)) {
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
// Resolution memo (fix #372): a query resolves the same use paths from the
// same files many times (receiver typing, module producers, glob walks), each
// probing the filesystem. Answers depend only on the tree, so they are
// memoized until the next build (resetRustResolveMemo).
const rustImportMemo = new Map();

function resolveRustImport(importPath, fromFile, projectRoot) {
    const key = `${projectRoot}\0${fromFile}\0${importPath}`;
    if (rustImportMemo.has(key)) return rustImportMemo.get(key);
    const resolved = resolveRustImportUncached(importPath, fromFile, projectRoot);
    rustImportMemo.set(key, resolved);
    return resolved;
}

/** Forget memoized Rust import resolutions (the tree may have changed). */
function resetRustResolveMemo() {
    rustImportMemo.clear();
    rustDirEntriesMemo.clear();
}

function resolveRustImportUncached(importPath, fromFile, projectRoot) {
    const fromDir = path.dirname(fromFile);

    // crate:: paths - resolve from the crate's src/ directory, or from a
    // manifest-declared target root (fix #260b): a `[[bin]] path =
    // "crates/core/main.rs"` roots the module tree at crates/core — the
    // importing file's crate root dir is the DEEPEST declared target dir
    // that is an ancestor of the file (module files live under their crate
    // root; integration tests are separate crates and can't use crate::).
    if (importPath.startsWith('crate::')) {
        const cargo = findCargoRoot(fromDir);
        if (!cargo) return null;

        const rest = importPath.slice('crate::'.length);
        const segments = rest.split('::');
        const candidates = [cargo.srcDir, ...(cargo.targetDirs || [])]
            .filter(d => fromDir === d || fromDir.startsWith(d + path.sep))
            .sort((a, b) => b.length - a.length);
        if (candidates.length === 0) candidates.push(cargo.srcDir);
        for (const cand of candidates) {
            // `use crate::ITEM` where ITEM is declared in the crate root file
            // has no ITEM.rs — the import points at lib.rs/main.rs itself.
            const hit = resolveRustModulePath(cand, segments) ||
                rustModuleOwnFile(cand, fromFile);
            if (hit) return hit;
        }
        return null;
    }

    // Own-package-name paths (fix #246): integration tests, benches, and
    // examples are separate crates that import the lib target by its Cargo
    // [package] name — `use mypkg::helper;` in tests/*.rs is the crate under
    // test, resolved exactly like crate:: into the package's source tree.
    // Only fires for files OUTSIDE the package's own module tree (inside
    // src/, a path starting with the package name is a 2015-edition CHILD
    // module, never the crate itself). Cross-crate workspace imports keep
    // their own package names and never match this file's Cargo.toml.
    {
        const firstSeg = importPath.split('::')[0].replace(/-/g, '_');
        const cargo = findCargoRoot(fromDir);
        if (cargo && cargo.packageName && firstSeg === cargo.packageName) {
            const topDir = path.relative(cargo.root, fromFile).split(path.sep)[0];
            const sourceRelative = path.relative(cargo.srcDir, fromFile);
            const sourceHead = sourceRelative.split(path.sep)[0];
            // A package's binaries are separate crates from its library even
            // though both live below src/. `use package_name::Type` in
            // src/main.rs or src/bin/** therefore names the lib target, not a
            // child module of the binary. Treat these like examples/tests so
            // the import graph can pin re-exported library types exactly.
            const separateBinary = sourceRelative === 'main.rs' ||
                sourceHead === 'bin';
            const externalTarget = topDir === 'tests' || topDir === 'benches' || topDir === 'examples' ||
                separateBinary || !fromFile.startsWith(cargo.srcDir + path.sep);
            if (externalTarget) {
                const restSegs = importPath.split('::').slice(1);
                const resolved = restSegs.length > 0 ? resolveRustModulePath(cargo.srcDir, restSegs) : null;
                const fallback = resolved || rustModuleOwnFile(cargo.srcDir, fromFile);
                if (fallback) return fallback;
            }
        }
        // Cross-crate WORKSPACE imports (fix #258, clap-measured): a sibling
        // workspace member's [package] name resolves into that crate's source
        // tree (`use clap::Command` from clap_bench/, ripgrep's grep-* crates
        // importing each other). Own-package and 2015-edition child-module
        // cases are handled above; a name matching this crate's own package
        // inside src/ never reaches here as a workspace lookup.
        if (firstSeg && (!cargo || firstSeg !== cargo.packageName)) {
            // A local child module of the same name wins over a workspace
            // crate (mod declarations resolve in the plain branch below).
            const localChild = fs.existsSync(path.join(fromDir, firstSeg + '.rs')) ||
                fs.existsSync(path.join(fromDir, firstSeg, 'mod.rs'));
            if (!localChild) {
                const registry = workspaceCrateRegistry(projectRoot);
                const member = registry.get(firstSeg);
                if (member && (!cargo || member.root !== cargo.root)) {
                    const restSegs = importPath.split('::').slice(1);
                    const resolved = restSegs.length > 0 ? resolveRustModulePath(member.srcDir, restSegs) : null;
                    const fallback = resolved || rustModuleOwnFile(member.srcDir, fromFile);
                    if (fallback) return fallback;
                }
            }
        }
    }

    // super:: paths - resolve relative to parent module
    if (importPath.startsWith('super::')) {
        let dir = fromDir;
        let rest = importPath;
        // Count super:: prefixes
        let superCount = 0;
        while (rest.startsWith('super::')) {
            superCount++;
            rest = rest.slice('super::'.length);
        }
        // For mod.rs/lib.rs/main.rs: module IS the directory, so super:: goes up N levels
        // For regular .rs: file is a submodule of the directory, so super:: goes up (N-1) levels
        const basename = path.basename(fromFile);
        const isMod = basename === 'mod.rs' || basename === 'lib.rs' || basename === 'main.rs';
        const ups = isMod ? superCount : superCount - 1;
        for (let i = 0; i < ups; i++) {
            dir = path.dirname(dir);
        }
        const segments = rest.split('::');
        // `use super::ITEM` where ITEM is declared in the parent module FILE
        // (mod.rs / <dir>.rs / crate root) — or in an inline `mod {}` there —
        // has no ITEM.rs to find; the import points at the parent file itself.
        return resolveRustModulePath(dir, segments) ||
            rustModuleOwnFile(dir, fromFile);
    }

    // self:: paths - resolve within current module directory
    if (importPath.startsWith('self::')) {
        const rest = importPath.slice('self::'.length);
        const segments = rest.split('::');
        const basename = path.basename(fromFile);
        // For mod.rs/lib.rs/main.rs: self:: resolves within the directory containing the file
        // For regular .rs: self:: resolves within a subdirectory named after the file stem
        const dir = (basename === 'mod.rs' || basename === 'lib.rs' || basename === 'main.rs')
            ? fromDir
            : path.join(fromDir, path.basename(fromFile, '.rs'));
        return resolveRustModulePath(dir, segments);
    }

    // Plain module name without :: (potential mod declaration)
    // e.g., "display" from `mod display;` - resolve relative to declaring file
    if (!importPath.includes('::')) {
        // For mod declarations: <dir>/<name>.rs or <dir>/<name>/mod.rs
        const rsFile = path.join(fromDir, importPath + '.rs');
        if (fs.existsSync(rsFile) && fs.statSync(rsFile).isFile() && rustPathHasExactCase(fromDir, rsFile)) {
            return rsFile;
        }
        const modFile = path.join(fromDir, importPath, 'mod.rs');
        if (fs.existsSync(modFile) && fs.statSync(modFile).isFile() && rustPathHasExactCase(fromDir, modFile)) {
            return modFile;
        }
    }

    return null;
}

/**
 * The file that holds a Rust module's own items (fix #368): `self` is the
 * current file, `super` (repeatable) the parent module's file, `crate` the
 * crate root, and any other path the module file resolveRustImport finds.
 * Used to anchor glob imports (`use super::*`) and module-qualified calls
 * (`crate::f()`), whose items live IN the module file, not in a child file.
 * @returns {string|null}
 */
function resolveRustModuleFile(modulePath, fromFile, projectRoot, inlineDepth = 0) {
    let spec = String(modulePath || '');
    if (!spec) return null;
    if (spec === 'self') return fromFile;
    // Inside `mod tests { use super::*; }` the first `super` hops out of the
    // inline module, which still lives in this file.
    let depth = inlineDepth;
    while (depth > 0 && (spec === 'super' || spec.startsWith('super::'))) {
        spec = spec === 'super' ? 'self' : spec.slice('super::'.length);
        depth--;
    }
    if (spec === 'self') return fromFile;
    if (depth > 0) return null; // crate/self paths from inside an inline module
    if (spec.startsWith('self::')) return resolveRustImport(spec, fromFile, projectRoot);
    const fromDir = path.dirname(fromFile);
    if (spec === 'crate') {
        const cargo = findCargoRoot(fromDir);
        if (!cargo) return null;
        const candidates = [cargo.srcDir, ...(cargo.targetDirs || [])]
            .filter(d => fromDir === d || fromDir.startsWith(d + path.sep))
            .sort((a, b) => b.length - a.length);
        if (candidates.length === 0) candidates.push(cargo.srcDir);
        for (const cand of candidates) {
            for (const root of ['lib.rs', 'main.rs']) {
                const file = path.join(cand, root);
                if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
            }
        }
        return null;
    }
    if (/^super(::super)*$/.test(spec)) {
        const superCount = spec.split('::').length;
        const basename = path.basename(fromFile);
        const isMod = basename === 'mod.rs' || basename === 'lib.rs' || basename === 'main.rs';
        let dir = fromDir;
        for (let i = 0; i < (isMod ? superCount : superCount - 1); i++) dir = path.dirname(dir);
        return rustModuleOwnFile(dir, fromFile);
    }
    return resolveRustImport(spec, fromFile, projectRoot);
}

/**
 * Try to resolve a path with various extensions
 */
// package.json lookup cache for self-reference resolution (dir -> info|null).
// Process-lifetime cache: package.json name/exports churn is rare enough that
// long-lived servers (MCP) tolerate it.
const _pkgCache = new Map();

function _findPackageJson(fromDir, stopDir) {
    let current = fromDir;
    for (let i = 0; i < 8; i++) {
        let info;
        if (_pkgCache.has(current)) {
            info = _pkgCache.get(current);
        } else {
            info = null;
            const candidate = path.join(current, 'package.json');
            try {
                if (fs.existsSync(candidate)) {
                    const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
                    info = {
                        dir: current,
                        name: pkg.name,
                        exports: pkg.exports,
                        main: pkg.main,
                        source: pkg.source,
                        module: pkg.module,
                        types: pkg.types,
                    };
                }
            } catch { /* unreadable or invalid JSON */ }
            _pkgCache.set(current, info);
        }
        if (info) return info;
        if (stopDir && current === stopDir) break;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return null;
}

/** Flatten an exports-map entry to candidate targets (condition objects in
 *  insertion order, arrays in order). 'types' conditions are skipped — they
 *  name declaration files, not runtime sources. */
function _collectExportTargets(entry, out = []) {
    if (typeof entry === 'string') {
        out.push(entry);
    } else if (Array.isArray(entry)) {
        for (const e of entry) _collectExportTargets(e, out);
    } else if (entry && typeof entry === 'object') {
        for (const [cond, v] of Object.entries(entry)) {
            if (cond === 'types') continue;
            _collectExportTargets(v, out);
        }
    }
    return out;
}

/**
 * Package self-reference: a file importing its own package by name
 * (`import * as z from "zod/v3"` inside the zod repo) — standard in monorepo
 * tests and benchmarks. Resolves through package.json "exports" (conditional
 * objects, arrays, '*' wildcards), accepting the first condition target that
 * lands on a real file.
 */
function resolveSelfReference(importPath, fromDir, config) {
    const pkg = _findPackageJson(fromDir, config.root ? path.dirname(config.root) : null);
    if (!pkg || !pkg.name) return null;
    if (importPath !== pkg.name && !importPath.startsWith(pkg.name + '/')) return null;
    return _resolvePackageSpecifier(pkg, importPath, config);
}

/**
 * In-repository workspace packages (fix #397, TanStack-query-measured: a
 * subclass in packages/solid-query extending `QueryClient` imported from
 * '@tanstack/query-core' left every inherited call unresolved): a bare
 * specifier naming a package whose package.json sits inside the project
 * resolves to that package's source, the way the workspace links it.
 * `packages` maps each package name declared exactly once in the project to
 * its manifest facts (a name declared by two manifests stays unresolved).
 */
function resolveWorkspacePackage(importPath, config) {
    const packages = config.workspacePackages;
    if (!packages || packages.size === 0) return null;
    let name = importPath;
    for (;;) {
        let pkg = packages.get(name);
        if (pkg?.manifestPending) {
            // Restored from a cache: the manifest is read on first use.
            const manifest = _findPackageJson(pkg.dir, pkg.dir);
            pkg = manifest ? { ...manifest, workspace: true } : { ambiguous: true };
            packages.set(name, pkg);
        }
        if (pkg) return pkg.ambiguous ? null : _resolvePackageSpecifier(pkg, importPath, config);
        const slash = name.lastIndexOf('/');
        if (slash <= 0) return null;
        name = name.slice(0, slash);
    }
}

/**
 * The package manifests of a project's JS/TS directories: the nearest
 * package.json of every directory holding a JS/TS source file, inside the
 * project root. Returns Map name -> manifest facts ({ ambiguous: true } for a
 * name two manifests declare).
 * @param {string} root - project root
 * @param {Iterable<string>} dirs - directories of the project's JS/TS files
 */
function jsWorkspacePackages(root, dirs) {
    const packages = new Map();
    const seenDirs = new Set();
    const seenManifests = new Set();
    for (const dir of dirs) {
        if (seenDirs.has(dir)) continue;
        seenDirs.add(dir);
        const pkg = _findPackageJson(dir, root);
        if (!pkg || !pkg.name || seenManifests.has(pkg.dir)) continue;
        seenManifests.add(pkg.dir);
        if (pkg.dir !== root && !pkg.dir.startsWith(root + path.sep)) continue;
        const existing = packages.get(pkg.name);
        packages.set(pkg.name, existing ? { ambiguous: true } : { ...pkg, workspace: true });
    }
    return packages;
}

function _resolvePackageSpecifier(pkg, importPath, config) {
    const subpath = importPath === pkg.name ? '.' : './' + importPath.slice(pkg.name.length + 1);
    const extensions = config.extensions || getExtensions(config.language);
    const tryTargets = (entry, wildcard) => {
        for (const target of _collectExportTargets(entry)) {
            const concrete = wildcard != null ? target.replace(/\*/g, wildcard) : target;
            const resolved = resolveFilePath(path.resolve(pkg.dir, concrete), extensions);
            if (resolved) return resolved;
        }
        return null;
    };
    const exp = pkg.exports;
    if (typeof exp === 'string') {
        return subpath === '.' ? tryTargets(exp, null) : null;
    }
    if (exp && typeof exp === 'object') {
        if (exp[subpath] !== undefined) {
            const hit = tryTargets(exp[subpath], null);
            if (hit) return hit;
        }
        for (const [key, val] of Object.entries(exp)) {
            const star = key.indexOf('*');
            if (star === -1) continue;
            const pre = key.slice(0, star);
            const post = key.slice(star + 1);
            if (subpath.length > pre.length + post.length &&
                subpath.startsWith(pre) && subpath.endsWith(post)) {
                const wild = subpath.slice(pre.length, subpath.length - post.length);
                const hit = tryTargets(val, wild);
                if (hit) return hit;
            }
        }
        // Monorepo packages commonly export build artifacts that do not
        // exist in a source checkout while declaring the development entry
        // explicitly (`"source": "src/index.ts"`). For a package's own bare
        // import, that source field is the authoritative local module.
        if (subpath === '.' && typeof pkg.source === 'string') {
            const source = resolveFilePath(path.resolve(pkg.dir, pkg.source), extensions);
            if (source) return source;
        }
        if (subpath === '.' && pkg.workspace) return _workspaceSourceEntry(pkg, extensions);
        return null;
    }
    // No exports map: bare name -> main/index; subpath -> direct file
    if (subpath === '.') {
        return (pkg.main && resolveFilePath(path.resolve(pkg.dir, pkg.main), extensions)) ||
            (pkg.workspace && _workspaceSourceEntry(pkg, extensions)) ||
            resolveFilePath(path.resolve(pkg.dir, 'index'), extensions);
    }
    return resolveFilePath(path.resolve(pkg.dir, subpath), extensions);
}

// A workspace package whose `main` names a build artifact absent from the
// source checkout: its declared source/module/types entries, else src/index.
function _workspaceSourceEntry(pkg, extensions) {
    for (const entry of [pkg.source, pkg.module, pkg.types]) {
        if (typeof entry !== 'string') continue;
        const hit = resolveFilePath(path.resolve(pkg.dir, entry), extensions);
        if (hit && !hit.endsWith('.d.ts')) return hit;
    }
    return resolveFilePath(path.resolve(pkg.dir, 'src', 'index'), extensions);
}

function resolveFilePath(basePath, extensions) {
    // Check exact path
    if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
        return basePath;
    }

    // TS-ESM: explicit '.js'/'.mjs' specifiers refer to '.ts'/'.mts' sources
    // (import specifiers name the compiled output). Remap before probing.
    const esmRemap = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
    const explicitExt = path.extname(basePath);
    if (esmRemap[explicitExt]) {
        const stem = basePath.slice(0, -explicitExt.length);
        for (const tsExt of esmRemap[explicitExt]) {
            const candidate = stem + tsExt;
            try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch { /* skip */ }
        }
    }

    // Try adding extensions
    for (const ext of extensions) {
        const withExt = basePath + ext;
        try { if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) return withExt; } catch { /* skip */ }
    }

    // Try index files (index.js for JS/TS, __init__.py for Python)
    for (const ext of extensions) {
        const indexPath = path.join(basePath, 'index' + ext);
        try { if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) return indexPath; } catch { /* skip */ }
    }
    // Python __init__.py
    const initPath = path.join(basePath, '__init__.py');
    try { if (fs.existsSync(initPath) && fs.statSync(initPath).isFile()) return initPath; } catch { /* skip */ }

    return null;
}

function _probeCached(cache, key, probe) {
    if (!cache) return probe();
    if (cache.has(key)) return cache.get(key);
    const value = probe();
    cache.set(key, value);
    return value;
}

function _isFile(p) {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

function _isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Resolve an absolute Python module against the nearest non-package ancestor
 * of the importing file (fix #366). Walks from the importing directory up to
 * (excluding) the project root, which the caller already tried.
 */
function _resolvePythonNestedRoot(importPath, fromDir, config) {
    const root = path.resolve(config.root);
    const first = importPath.split('.')[0];
    if (!first) return null;
    const cache = config.probeCache;
    const modulePath = importPath.replace(/\./g, '/');
    let dir = path.resolve(fromDir);
    while (dir.length > root.length && dir.startsWith(root + path.sep)) {
        const isPackage = _probeCached(cache, `pyinit\0${dir}`,
            () => _isFile(path.join(dir, '__init__.py')));
        if (!isPackage) {
            const hasFirst = _probeCached(cache, `pyfirst\0${dir}\0${first}`,
                () => _isDir(path.join(dir, first)) || _isFile(path.join(dir, first + '.py')) ||
                    _isFile(path.join(dir, first + '.pyi')));
            if (hasFirst) {
                const resolved = resolveFilePath(path.join(dir, modulePath), getExtensions('python'));
                if (resolved) return resolved;
            }
        }
        dir = path.dirname(dir);
    }
    return null;
}

/**
 * Get file extensions for a language
 */
function getExtensions(language) {
    switch (language) {
        case 'javascript':
            // A JS file's extensionless specifier names a TS source when that
            // is the only file there (JS tests of a TS package run through a
            // TS-aware loader, fix #397); JS files win when both exist.
            return ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];
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
        case 'c':
            return ['.c', '.h'];
        case 'cpp':
            return ['.cc', '.cpp', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++', '.h'];
        case 'csharp':
            return ['.cs', '.csx'];
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
        // Check boundary BEFORE loading — don't escape the project root
        if (normalizedRoot && !currentDir.startsWith(normalizedRoot + path.sep) && currentDir !== normalizedRoot) break;

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

    // Follow project references to collect paths from referenced configs
    // (tsconfig.json with "references" pointing to tsconfig.app.json, tsconfig.node.json, etc.)
    if (config.references && Array.isArray(config.references)) {
        for (const ref of config.references) {
            if (!ref.path) continue;
            let refPath = path.resolve(configDir, ref.path);
            // If reference points to a directory, look for tsconfig.json inside it
            if (fs.existsSync(refPath) && fs.statSync(refPath).isDirectory()) {
                refPath = path.join(refPath, 'tsconfig.json');
            }
            // Add .json extension if not present
            if (!refPath.endsWith('.json')) refPath += '.json';
            if (fs.existsSync(refPath)) {
                try {
                    const refResult = loadTsConfig(refPath, visited);
                    if (refResult) {
                        basePaths = { ...basePaths, ...refResult.paths };
                        if (refResult.baseUrl && !baseUrl) baseUrl = refResult.baseUrl;
                    }
                } catch {
                    // Skip malformed reference config
                }
            }
        }
    }

    // Child config values override base config
    const mergedPaths = { ...basePaths, ...(config.compilerOptions?.paths || {}) };
    const compiledPaths = Object.entries(mergedPaths).map(([pattern, targets]) => ({
        pattern,
        regex: new RegExp('^' + pattern.replace(/[.+^$[\]\\{}()|]/g, '\\$&').replace(/\*/g, '(.*)') + '$'),
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
    let result = '';
    let i = 0;
    while (i < content.length) {
        // Skip strings (preserve their content)
        if (content[i] === '"') {
            result += '"';
            i++;
            while (i < content.length && content[i] !== '"') {
                if (content[i] === '\\') {
                    result += content[i] + (content[i + 1] || '');
                    i += 2;
                } else {
                    result += content[i];
                    i++;
                }
            }
            if (i < content.length) {
                result += '"';
                i++;
            }
        }
        // Strip line comments
        else if (content[i] === '/' && content[i + 1] === '/') {
            while (i < content.length && content[i] !== '\n') i++;
        }
        // Strip block comments
        else if (content[i] === '/' && content[i + 1] === '*') {
            i += 2;
            while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
            i += 2;
        }
        else {
            result += content[i];
            i++;
        }
    }
    // Strip trailing commas
    return result.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * The inline `mod NAME { ... }` blocks of a Rust file (module symbols that
 * are not `mod NAME;` declarations), as { name, startLine, endLine }.
 */
function rustInlineModules(fileEntry) {
    const declared = new Set();
    for (const detail of fileEntry.importDetails || []) {
        if (detail.type === 'mod' && detail.module) declared.add(`${detail.module}\0${detail.line}`);
    }
    const inline = [];
    for (const symbol of fileEntry.symbols || []) {
        if (symbol.type !== 'module' || declared.has(`${symbol.name}\0${symbol.startLine}`)) continue;
        inline.push({ name: symbol.name, startLine: symbol.startLine, endLine: symbol.endLine });
    }
    inline.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
    return inline;
}

/** Names of the inline modules enclosing `line`, outermost first. */
function rustInlineChainAt(inlineModules, line) {
    const chain = [];
    for (const mod of inlineModules) {
        if (mod.startLine <= line && mod.endLine >= line) chain.push(mod.name);
    }
    return chain;
}

/**
 * Files a Rust `mod NAME;` declaration loads (fix #377), per the Rust
 * reference: in a mod-rs file (lib.rs, main.rs, mod.rs) the module directory
 * is the file's directory, in any other file `foo.rs` it is `foo/`; enclosing
 * inline modules add their names; `#[path = "p"]` is relative to the file's
 * directory outside inline modules and to the module directory inside them.
 * A non-mod-rs file can itself be a crate root (src/bin/x.rs, tests/x.rs,
 * build.rs), whose module directory is the file's directory: that layout is
 * the fallback when the first one names no indexed file. `exists(path)`
 * decides which candidate is loaded. Returns Map name -> [files] (several
 * files for cfg-selected alternatives of one name).
 */
function rustModDeclarationFiles(filePath, fileEntry, exists, inlineModules = null) {
    const out = new Map();
    const details = (fileEntry.importDetails || []).filter(detail => detail.type === 'mod' && detail.module);
    if (details.length === 0) return out;
    const inline = inlineModules || rustInlineModules(fileEntry);
    const moduleSymbols = new Map();
    for (const symbol of fileEntry.symbols || []) {
        if (symbol.type === 'module') moduleSymbols.set(`${symbol.name}\0${symbol.startLine}`, symbol);
    }
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const modRs = base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs';
    const layouts = modRs ? [dir] : [path.join(dir, path.basename(filePath, '.rs')), dir];
    for (const detail of details) {
        const decl = moduleSymbols.get(`${detail.module}\0${detail.line}`);
        let pathAttr = null;
        for (const modifier of decl?.modifiers || []) {
            const match = /^path\s*=\s*"([^"]*)"$/.exec(String(modifier).trim());
            if (match) pathAttr = match[1];
        }
        const chain = rustInlineChainAt(inline, detail.line);
        let hit = null;
        for (const layout of layouts) {
            const moduleDir = path.join(layout, ...chain);
            const candidates = pathAttr != null
                ? [chain.length === 0 ? path.join(dir, pathAttr) : path.join(moduleDir, pathAttr)]
                : [path.join(moduleDir, detail.module + '.rs'), path.join(moduleDir, detail.module, 'mod.rs')];
            hit = candidates.find(candidate => candidate !== filePath && exists(candidate));
            if (hit) break;
        }
        if (!hit) continue;
        if (!out.has(detail.module)) out.set(detail.module, []);
        if (!out.get(detail.module).includes(hit)) out.get(detail.module).push(hit);
    }
    return out;
}

/**
 * `moduleResolved` entries of a Rust file's `mod` declarations, resolved as
 * the import graph build resolves them (rustModDeclarationFiles against the
 * indexed files). `index` needs root and files (fix #375: macro expansion
 * workers derive module ancestry while the main thread builds the import
 * graph).
 */
function rustModuleDeclarationsResolved(index, filePath, fileEntry) {
    const out = {};
    const declared = rustModDeclarationFiles(filePath, fileEntry, candidate => index.files.has(candidate));
    for (const [name, files] of declared) out[name] = path.relative(index.root, files[0]);
    return out;
}

module.exports = {
    extractImports,
    jsWorkspacePackages,
    rustModuleDeclarationsResolved,
    rustModDeclarationFiles,
    rustInlineModules,
    rustInlineChainAt,
    extractExports,
    resolveImport,
    resolveFilePath,
    resolveRustImport,
    resolveRustModuleFile,
    findGoModule,
    findCargoRoot,
    workspaceCrateRegistry,
    snapshotWorkspaceManifests,
    seedWorkspaceManifests,
    workspaceManifestsCurrent,
    manifestSetFingerprint,
    resetCargoCaches,
    resetRustResolveMemo,
};
