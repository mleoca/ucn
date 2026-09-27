/**
 * core/discovery.js - File discovery and glob pattern expansion
 *
 * Pure Node.js implementation (no external dependencies)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { langTraits } = require('../languages');
const { IgnoreRules } = require('./ignore-rules');

// Always ignore - unambiguous, never user code
const DEFAULT_IGNORES = [
    // Package managers (unambiguous names)
    'node_modules',
    'bower_components',
    '.bundle',

    // Version control
    '.git',
    '.svn',
    '.hg',

    // Python
    '__pycache__',
    '.venv',
    'venv',
    '.env',
    '.tox',
    '.eggs',
    '*.egg-info',

    // Framework-owned build outputs with unambiguous names. Generic names
    // such as build/dist/out/coverage are intentionally NOT here: real,
    // git-tracked source trees use them at arbitrary depths.
    '*-dist',
    '.next',
    'next.lock',
    '.nuxt',
    '.output',
    '.vercel',
    '.netlify',
    '.turbo',
    '.parcel-cache',
    '.svelte-kit',
    '.docusaurus',
    'storybook-static',
    '_site',

    // Test/coverage tool metadata
    '.nyc_output',
    '.pytest_cache',
    '.mypy_cache',

    // System
    '.DS_Store',
    '.ucn-cache'
];

// These can contain user code: disclose their exclusion, unlike dependency
// and VCS directories. Source maps are data and cannot be parsed as code.
const BUNDLED_PATTERNS = ['*.min.js', '*.bundle.js', '*.map'];
let _bundledList = null;
function bundledList() {
    if (!_bundledList) _bundledList = compileIgnoreList(BUNDLED_PATTERNS);
    return _bundledList;
}

// Conditional ignores - only ignore when marker file exists in same directory
// Maps directory name -> array of marker files that indicate it's a vendor dir
const CONDITIONAL_IGNORES = {
    'vendor':      ['go.mod', 'composer.json', 'Gemfile'],  // Go, PHP, Ruby
    'Pods':        ['Podfile'],                              // iOS CocoaPods
    'Carthage':    ['Cartfile'],                             // iOS Carthage
    'deps':        ['mix.exs', 'rebar.config'],              // Elixir, Erlang
    'target':      ['Cargo.toml', 'pom.xml', 'build.gradle'], // Rust, Maven, Gradle
    'env':         ['requirements.txt', 'pyproject.toml'],   // Python virtualenv
};

// Project root markers
const PROJECT_MARKERS = [
    '.git',
    '.ucn.json',
    'package.json',
    'pyproject.toml',
    'setup.py',
    'go.mod',
    'Cargo.toml',
    'pom.xml',
    'build.gradle',
    'Makefile',
    'CMakeLists.txt',
    'compile_commands.json',
    'meson.build'
];

// Test file patterns by language
const TEST_PATTERNS = {
    javascript: [
        /\.test\.(js|jsx|ts|tsx|mjs|cjs)$/,
        /\.spec\.(js|jsx|ts|tsx|mjs|cjs)$/,
        /(^|\/)(test|spec)\.(js|jsx|ts|tsx|mjs|cjs)$/,
        /__tests__\//,
        /(^|\/)tests?\//,
        /\.test$/
    ],
    typescript: [
        /\.test\.(ts|tsx)$/,
        /\.spec\.(ts|tsx)$/,
        /(^|\/)(test|spec)\.(ts|tsx)$/,
        /__tests__\//,
        /(^|\/)tests?\//
    ],
    python: [
        /^test_.*\.py$/,
        /.*_test\.py$/,
        /(^|\/)tests?\//
    ],
    go: [
        /.*_test\.go$/
    ],
    java: [
        /.*Test\.java$/,
        /.*TestCase\.java$/,
        /.*Tests\.java$/,
        /(^|\/)src\/test\//
    ],
    rust: [
        /.*_test\.rs$/,
        /(^|\/)tests\//
    ],
    c: [
        /(^|\/)tests?\//,
        /(^|\/)test_.*\.(c|h)$/,
        /.*(_test|\.test)\.(c|h)$/
    ],
    cpp: [
        /(^|\/)tests?\//,
        /(^|\/)test_.*\.(cc|cpp|cxx|c\+\+|hpp|hh|hxx|h\+\+)$/,
        /.*(_test|\.test)\.(cc|cpp|cxx|c\+\+|hpp|hh|hxx|h\+\+)$/
    ],
    csharp: [
        /(^|\/)tests?\//,
        /.*Tests?\.cs$/,
        /.*\.Tests\.cs$/
    ]
};

function fallbackGitignoreFiles(projectRoot) {
    const found = [];
    const visit = dir => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && entry.name === '.gitignore') found.push(fullPath);
            if (!entry.isDirectory() || shouldIgnore(entry.name, DEFAULT_IGNORES, dir)) continue;
            visit(fullPath);
        }
    };
    visit(projectRoot);
    return found;
}

function hasGitMetadata(projectRoot) {
    let dir = path.resolve(projectRoot);
    const filesystemRoot = path.parse(dir).root;
    while (true) {
        if (fs.existsSync(path.join(dir, '.git'))) return true;
        if (dir === filesystemRoot) return false;
        dir = path.dirname(dir);
    }
}

/** First line of a failed git invocation, for disclosure. */
function describeGitFailure(error) {
    if (error && error.code === 'ENOENT') return 'git is not installed or not on PATH';
    if (error && error.code === 'ENOBUFS') return 'git ls-files output exceeded the process output limit';
    const stderr = error && error.stderr ? String(error.stderr).trim().split('\n')[0] : '';
    if (stderr) return stderr;
    if (error && typeof error.status === 'number') return `git ls-files exited with status ${error.status}`;
    return (error && error.message) ? error.message.split('\n')[0] : 'git ls-files failed';
}

/**
 * One `git ls-files` for everything discovery asks git (fix #375): the
 * tracked paths (which .gitignore rules never exclude) and the .gitignore
 * files git honors, tracked or untracked-and-not-ignored. Tags tell tracked
 * entries (`H`, `S`, `M`...) from untracked ones (`?`).
 *
 * Returns null when the project is not inside a git work tree. Otherwise the
 * listing is complete whatever its size (fix #382: the output is read as a
 * buffer with no size cap; a 1MB cap used to empty the tracked set on large
 * repositories, silently dropping tracked files that match a .gitignore
 * rule). When git itself fails, `failure` says why: the tracked set is then
 * unknown, discovery falls back to the rules alone, and the caller records a
 * `git-listing-failed` discovery issue, so the index is disclosed as
 * possibly partial instead of silently changing its file set.
 */
function gitListing(projectRoot) {
    const root = path.resolve(projectRoot);
    if (!hasGitMetadata(root)) return null;
    let output;
    try {
        output = execFileSync('git', [
            '-C', root, 'ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard',
        ], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity, windowsHide: true });
    } catch (error) {
        return {
            tracked: { files: new Set(), directories: new Set() },
            gitignores: null,
            failure: { detail: describeGitFailure(error) },
        };
    }
    const files = new Set();
    const directories = new Set();
    const gitignores = [];
    let start = 0;
    const length = output.length;
    while (start < length) {
        let end = output.indexOf(0, start);
        if (end < 0) end = length;
        // `<tag> <path>`: at least one tag byte, a space, one path byte.
        if (end - start >= 3 && output[start + 1] === 0x20) {
            const untracked = output[start] === 0x3f; // '?'
            const raw = output.toString('utf8', start + 2, end);
            // gitignoreFiles' pathspecs `.gitignore` (literal: the file, or a
            // directory of that name) and `**/.gitignore`.
            if (raw === '.gitignore' || raw.startsWith('.gitignore/') || raw.endsWith('/.gitignore')) {
                const file = path.resolve(root, raw);
                if (file === root || file.startsWith(root + path.sep)) gitignores.push(file);
            }
            if (!untracked) {
                // git prints '/'-separated paths on every platform.
                const relative = path.posix.normalize(raw);
                if (relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative)) {
                    files.add(relative);
                    let slash = relative.lastIndexOf('/');
                    while (slash > 0) {
                        const parent = relative.slice(0, slash);
                        if (directories.has(parent)) break;
                        directories.add(parent);
                        slash = parent.lastIndexOf('/');
                    }
                }
            }
        }
        start = end + 1;
    }
    return { tracked: { files, directories }, gitignores, failure: null };
}

/**
 * The project's .gitignore rules, compiled (core/ignore-rules.js): the root
 * file and every applicable nested one, parent before child. `listing`
 * (gitListing) supplies the .gitignore files when the caller already asked
 * git; without git metadata (or when git failed) the tree is walked for them.
 * @returns {IgnoreRules}
 */
function parseGitignore(projectRoot, listing) {
    const root = path.resolve(projectRoot);
    if (listing === undefined) listing = gitListing(root);
    const files = (listing?.gitignores ? [...listing.gitignores] : fallbackGitignoreFiles(root))
        .map(file => ({ file, base: path.relative(root, path.dirname(file)).split(path.sep).join('/') }))
        .sort((a, b) => {
            const depthA = a.base ? a.base.split('/').length : 0;
            const depthB = b.base ? b.base.split('/').length : 0;
            return depthA - depthB || compareNames(a.file, b.file);
        });
    const sources = [];
    for (const { file, base } of files) {
        let content;
        try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
        sources.push({ base, content });
    }
    return new IgnoreRules(sources);
}

/**
 * Return tracked files and their ancestor directories, relative to root
 * (from `listing`, a gitListing result, when given).
 */
function gitTrackedPaths(projectRoot, listing) {
    if (listing === undefined) listing = gitListing(projectRoot);
    return listing ? listing.tracked : { files: new Set(), directories: new Set() };
}

function compareNames(a, b) {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    if (aLower < bLower) return -1;
    if (aLower > bLower) return 1;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/**
 * Expand a glob pattern to matching file paths
 *
 * @param {string} pattern - Glob pattern (e.g., "src/**\/*.py", "*.js")
 * @param {object} options - Configuration options
 * @param {string} options.root - Root directory (defaults to cwd)
 * @param {string[]} options.ignores - Patterns to ignore
 * @param {number} options.maxDepth - Maximum directory depth (default: 20)
 * @param {number} options.maxFiles - Maximum files to return (default: 10000)
 * @returns {string[]} - Array of absolute file paths
 */
function expandGlob(pattern, options = {}) {
    const root = path.resolve(options.root || process.cwd());
    const ignores = options.ignores || DEFAULT_IGNORES;
    const maxDepth = options.maxDepth ?? 1000;
    const maxFiles = options.maxFiles ?? 50000;
    const maxFileSize = options.maxFileSize ?? (8 * 1024 * 1024);
    const followSymlinks = options.followSymlinks !== false; // default true
    const gitignoreRules = options.gitignoreRules || null;
    const trackedPaths = options.trackedPaths || { files: new Set(), directories: new Set() };

    // Handle home directory expansion
    if (pattern.startsWith('~/')) {
        pattern = pattern.replace('~', require('os').homedir());
    }

    // Parse the pattern
    const { baseDir, filePattern, recursive } = parseGlobPattern(pattern, root);

    // Collect matching files
    const files = [];
    walkDir(baseDir, {
        filePattern,
        recursive,
        ignores,
        policy: compileIgnoreList(ignores),
        gitignoreRules,
        trackedPaths,
        maxDepth,
        maxFileSize,
        followSymlinks,
        includeBundled: options.includeBundled === true,
        // Anchored gitignore patterns ('/name') apply only to entries directly
        // under the project root — the .gitignore's own directory (fix #226).
        anchorRoot: root,
        onSkippedFile: options.onSkippedFile,
        onDiscoveryIssue: options.onDiscoveryIssue,
        disclosureIgnores: options.disclosureIgnores,
        disclosure: options.disclosureIgnores?.length ? compileIgnoreList(options.disclosureIgnores) : null,
        onFile: (filePath) => {
            if (files.length < maxFiles) {
                files.push(filePath);
            } else if (options.onDiscoveryIssue) {
                options.onDiscoveryIssue({
                    path: filePath,
                    kind: 'file',
                    reason: 'max-files',
                    detail: `discovery exceeded maxFiles=${maxFiles}`,
                });
            }
        }
    }, 0, new Set(), null, walkContext(root, baseDir, gitignoreRules));

    return files.sort(compareNames);
}

/**
 * Where a walk starts, relative to the project root: the '/'-separated path
 * every entry's root-relative path extends (computed once per directory, never
 * per rule), the .gitignore scope chain in effect, and whether a parent
 * directory is already excluded.
 */
function walkContext(root, baseDir, gitignoreRules) {
    const relative = path.relative(root, path.resolve(baseDir)).split(path.sep).join('/');
    const inside = relative === '' ||
        (relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative));
    if (!inside) return { rel: relative, inside: false, segments: 0, scopes: [], excluded: false };
    return {
        rel: relative,
        inside: true,
        segments: relative ? relative.split('/').length : 0,
        scopes: gitignoreRules ? gitignoreRules.chainFor(relative) : [],
        excluded: !!(relative && gitignoreRules && gitignoreRules.isIgnored(relative, true)),
    };
}

const LITERAL_NAME = 0;
const GLOB_NAME = 1;
const PATH_GLOB = 2;

/**
 * A UCN ignore list (DEFAULT_IGNORES, .ucn.json `exclude`, bundled names)
 * compiled once with shouldIgnore()'s semantics minus the conditional vendor
 * checks: a pattern with '/' is a glob over the root-relative path (leading
 * slashes dropped, `dir/**` also naming `dir`), others match the basename
 * (literal or glob); the last match wins and a later `!pattern` re-includes.
 */
function compileIgnoreList(patterns) {
    const rules = [];
    const literals = new Set();
    const globs = [];
    const paths = [];
    const reincludes = [];
    let hasNegation = false;
    for (const raw of patterns || []) {
        const negated = raw.charCodeAt(0) === 33 /* ! */;
        const pattern = negated ? raw.slice(1) : raw;
        let rule;
        if (pattern.includes('/')) {
            const normalized = pattern.replace(/^\/+/, '').replaceAll('\\', '/');
            rule = {
                negated, kind: PATH_GLOB, regex: cachedGlobRegex(`path:${normalized}`, normalized),
                dirPrefix: normalized.endsWith('/**') ? normalized.slice(0, -3).replace(/\/+$/, '') : null,
            };
            if (!negated) paths.push(rule);
        } else if (pattern.includes('*')) {
            rule = { negated, kind: GLOB_NAME, regex: cachedGlobRegex(pattern, pattern) };
            if (!negated) globs.push(rule);
        } else {
            rule = { negated, kind: LITERAL_NAME, name: pattern };
            if (!negated) literals.add(pattern);
        }
        if (negated) {
            hasNegation = true;
            const reinclude = pattern.replace(/^\/+/, '');
            if (reinclude.includes('/')) reincludes.push(reinclude);
        }
        rules.push(rule);
    }
    const ruleMatches = (rule, name, rel) => {
        if (rule.kind === LITERAL_NAME) return rule.name === name;
        if (rule.kind === GLOB_NAME) return rule.regex.test(name);
        return rel !== null && (rule.regex.test(rel) || (rule.dirPrefix !== null && rel === rule.dirPrefix));
    };
    return {
        size: rules.length,
        /** @param {string|null} rel - root-relative path ('..'-prefixed outside the root) */
        matches(name, rel, isDirectory) {
            if (!hasNegation) {
                if (literals.has(name)) return true;
                for (const rule of globs) if (rule.regex.test(name)) return true;
                for (const rule of paths) if (ruleMatches(rule, name, rel)) return true;
                return false;
            }
            let ignored = false;
            for (const rule of rules) {
                if (ruleMatches(rule, name, rel)) ignored = !rule.negated;
            }
            // A later negation can re-include a descendant: keep walking a
            // matched directory whenever such a rule might apply below it.
            if (ignored && isDirectory && rel !== null &&
                reincludes.some(p => p.startsWith(rel + '/') || p.includes('**'))) {
                ignored = false;
            }
            return ignored;
        },
    };
}

function cachedGlobRegex(key, glob) {
    let regex = _globRegexCache.get(key);
    if (!regex) {
        regex = globToRegex(glob);
        _globRegexCache.set(key, regex);
    }
    return regex;
}

/** Conditional vendor-style ignores: the name plus a marker file beside it. */
function conditionallyIgnored(name, parentDir) {
    if (!Array.isArray(CONDITIONAL_IGNORES[name])) return false;
    for (const marker of CONDITIONAL_IGNORES[name]) {
        if (fs.existsSync(path.join(parentDir, marker))) return true;
    }
    return false;
}

/**
 * Parse a glob pattern into components
 */
function parseGlobPattern(pattern, root) {
    const recursive = pattern.includes('**');
    const parts = pattern.split(/[/\\]/);

    let dirParts = [];
    let wildcardStart = -1;

    for (let i = 0; i < parts.length; i++) {
        if (parts[i].includes('*') || parts[i].includes('?')) {
            wildcardStart = i;
            break;
        }
        dirParts.push(parts[i]);
    }

    let baseDir;
    if (dirParts.length === 0) {
        baseDir = root;
    } else if (path.isAbsolute(dirParts.join('/'))) {
        baseDir = dirParts.join('/');
    } else {
        baseDir = path.join(root, ...dirParts);
    }

    let filePatternStr = wildcardStart >= 0
        ? parts.slice(wildcardStart).join('/')
        : '*';

    filePatternStr = filePatternStr.replace(/^\*\*[/\\]?/, '');
    const filePattern = globToRegex(filePatternStr || '*');

    return { baseDir, filePattern, recursive };
}

/**
 * Convert a glob pattern to a regular expression
 */
function globToRegex(glob) {
    let regex = glob.replace(/[.+^$[\]\\()|]/g, '\\$&');

    // Handle brace expansion: {js,ts} -> (js|ts)
    regex = regex.replace(/\{([^}]+)\}/g, (_, group) => {
        const alternatives = group.split(',').map(s => s.trim());
        return '(' + alternatives.join('|') + ')';
    });

    regex = regex.replace(/\*\*/g, '\0GLOBSTAR\0');
    regex = regex.replace(/\*/g, '[^/]*');
    regex = regex.replace(/\0GLOBSTAR\0/g, '.*');
    regex = regex.replace(/\?/g, '.');

    return new RegExp('^' + regex + '$');
}

/**
 * Walk a directory tree, calling onFile for each matching file
 */
function walkDir(dir, options, depth = 0, visited = new Set(), knownRealDir = null, context = null) {
    if (depth > options.maxDepth) {
        options.onDiscoveryIssue?.({
            path: dir, kind: 'directory', reason: 'max-depth',
            detail: `discovery exceeded maxDepth=${options.maxDepth}`,
        });
        return;
    }
    // A plain (non-symlink) subdirectory of a resolved directory is its own
    // real path: only the root and symlinked entries need realpath (fix #372,
    // one lstat per path component per directory on every staleness walk).
    if (!knownRealDir && !fs.existsSync(dir)) return;

    // Track visited directories to avoid circular symlinks
    let realDir = knownRealDir;
    if (!realDir) {
        try {
            realDir = fs.realpathSync(dir);
        } catch (e) {
            options.onDiscoveryIssue?.({
                path: dir, kind: 'directory', reason: 'unreadable-directory',
                detail: e.message,
            });
            return; // broken symlink
        }
    }
    if (visited.has(realDir)) return;
    visited.add(realDir);

    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        options.onDiscoveryIssue?.({
            path: dir, kind: 'directory', reason: 'unreadable-directory',
            detail: e.message,
        });
        return;
    }

    entries.sort((a, b) => compareNames(a.name, b.name));

    const followSymlinks = options.followSymlinks !== false; // default true
    if (!context) {
        context = walkContext(options.anchorRoot || dir, dir, options.gitignoreRules || null);
    }
    const policy = options.policy || (options.policy = compileIgnoreList(options.ignores || DEFAULT_IGNORES));
    const rules = context.inside ? options.gitignoreRules || null : null;
    const trackedFiles = options.trackedPaths?.files;
    const trackedDirectories = options.trackedPaths?.directories;

    for (const entry of entries) {
        const name = entry.name;
        const fullPath = path.join(dir, name);
        const entryIsDirectory = entry.isDirectory();
        // Root-relative path, extended once per entry (never per rule).
        const relative = context.rel ? `${context.rel}/${name}` : name;
        const policyIgnored = policy.matches(name, relative, entryIsDirectory) ||
            conditionallyIgnored(name, dir);
        // .gitignore verdict for the untracked view of this entry. Tracked
        // paths are never excluded by rules (git keeps tracking them), but a
        // tracked DIRECTORY still needs the verdict: its untracked contents
        // inherit an exclusion (git cannot re-include below an excluded
        // directory).
        let tracked = false;
        let excluded = false;
        if (!policyIgnored && context.inside) {
            tracked = entryIsDirectory
                ? !!trackedDirectories?.has(relative)
                : !!trackedFiles?.has(relative);
            if (context.excluded) excluded = true;
            else if (rules && (!tracked || entryIsDirectory)) {
                excluded = rules.decide(context.scopes, relative, context.segments, name, entryIsDirectory);
            }
        }
        if (policyIgnored || (excluded && !tracked)) {
            if (options.disclosure && options.disclosure.matches(name, relative, entryIsDirectory)) {
                options.onDiscoveryIssue?.({
                    path: fullPath,
                    kind: entryIsDirectory ? 'directory' : 'file',
                    reason: 'config-exclude',
                    detail: 'excluded by .ucn.json',
                });
            }
            continue;
        }

        let isDir = entry.isDirectory();
        let isFile = entry.isFile();

        // Follow symlinks if enabled
        if (followSymlinks && entry.isSymbolicLink()) {
            try {
                const stat = fs.statSync(fullPath);
                isDir = stat.isDirectory();
                isFile = stat.isFile();
            } catch (e) {
                continue; // broken symlink
            }
        }

        if (isDir) {
            if (options.recursive) {
                walkDir(fullPath, options, depth + 1, visited,
                    entry.isSymbolicLink() ? null : path.join(realDir, entry.name), {
                        rel: relative,
                        inside: context.inside,
                        segments: context.segments + 1,
                        scopes: rules && !excluded ? rules.scopesFor(context.scopes, relative) : context.scopes,
                        excluded,
                    });
            }
        } else if (isFile) {
            if (bundledList().matches(entry.name, null, false) &&
                (!options.includeBundled || entry.name.endsWith('.map'))) {
                options.onDiscoveryIssue?.({
                    path: fullPath, kind: 'file', reason: 'bundled',
                    detail: entry.name.endsWith('.map')
                        ? 'source maps are not supported source files'
                        : 'bundled/minified filename; use --include-bundled to index',
                });
                continue;
            }
            if (options.filePattern.test(entry.name)) {
                let size;
                try { size = fs.statSync(fullPath).size; } catch (e) {
                    options.onDiscoveryIssue?.({
                        path: fullPath, kind: 'file', reason: 'unreadable-file',
                        detail: e.message,
                    });
                    continue;
                }
                if (size > options.maxFileSize) {
                    options.onDiscoveryIssue?.({
                        path: fullPath, kind: 'file', reason: 'max-file-size',
                        detail: `${size} bytes exceeds maxFileSize=${options.maxFileSize}`,
                        size,
                    });
                    continue;
                }
                options.onFile(fullPath);
            } else if (options.onSkippedFile) {
                options.onSkippedFile(fullPath);
            }
        }
    }
}

/**
 * Check if a file/directory name should be ignored
 * @param {string} name - File/directory name
 * @param {string[]} ignores - Patterns to always ignore. Patterns with a
 *   leading '/' are ANCHORED (git semantics, fix #226): they match only when
 *   `atAnchorRoot` is true — i.e. the entry sits directly in the directory
 *   the .gitignore belongs to. Default false errs toward KEEPING files.
 * @param {string} [parentDir] - Parent directory path (for conditional checks)
 * @param {boolean} [atAnchorRoot] - Whether parentDir IS the anchor root
 * @param {string} [anchorRoot] - Discovery root for path-aware config ignores
 * @param {string} [fullPath] - Candidate path for root-relative matching
 */
const _globRegexCache = new Map();

function shouldIgnore(
    name,
    ignores,
    parentDir = null,
    atAnchorRoot = false,
    anchorRoot = null,
    fullPath = null,
    isDirectory = false,
    includeConditional = true,
) {
    let ignored = false;
    for (const rawPattern of ignores) {
        const negated = rawPattern.charCodeAt(0) === 33 /* ! */;
        let pattern = negated ? rawPattern.slice(1) : rawPattern;
        let matched = false;
        if (pattern.includes('/') && anchorRoot && fullPath) {
            const normalizedPattern = pattern.replace(/^\/+/, '')
                .replaceAll('\\', '/');
            const relative = path.relative(anchorRoot, fullPath)
                .replaceAll(path.sep, '/');
            let regex = _globRegexCache.get(`path:${normalizedPattern}`);
            if (!regex) {
                regex = globToRegex(normalizedPattern);
                _globRegexCache.set(`path:${normalizedPattern}`, regex);
            }
            const directoryPrefix = normalizedPattern.endsWith('/**')
                ? normalizedPattern.slice(0, -3).replace(/\/+$/, '')
                : null;
            if (regex.test(relative) ||
                (directoryPrefix && relative === directoryPrefix)) {
                matched = true;
            }
        } else if (pattern.charCodeAt(0) === 47 /* '/' */) {
            if (!atAnchorRoot) continue;
            pattern = pattern.slice(1);
            matched = pattern.includes('*')
                ? globToRegex(pattern).test(name)
                : name === pattern;
        } else if (pattern.includes('*')) {
            let regex = _globRegexCache.get(pattern);
            if (!regex) {
                regex = globToRegex(pattern);
                _globRegexCache.set(pattern, regex);
            }
            if (regex.test(name)) matched = true;
        } else if (name === pattern) {
            matched = true;
        }
        if (matched) ignored = !negated;
    }

    // A later negation can re-include a descendant. Keep walking a currently
    // ignored directory whenever such a rule might apply below it.
    if (ignored && isDirectory && anchorRoot && fullPath) {
        const relative = path.relative(anchorRoot, fullPath).replaceAll(path.sep, '/');
        const mayReincludeDescendant = ignores.some(raw => {
            if (!raw.startsWith('!')) return false;
            const pattern = raw.slice(1).replace(/^\/+/, '');
            return pattern.includes('/') &&
                (pattern.startsWith(relative + '/') || pattern.includes('**'));
        });
        if (mayReincludeDescendant) ignored = false;
    }
    if (ignored) {
        return true;
    }

    // A negated rule is only meaningful after a positive rule matched.
    if (ignores.some(pattern => pattern.startsWith('!'))) {
        // Fall through to conditional ignores.
    }

    // Check conditional ignores (only if parentDir provided)
    // Use Array.isArray to avoid matching Object.prototype properties (e.g. dir named "constructor")
    if (includeConditional && parentDir && Array.isArray(CONDITIONAL_IGNORES[name])) {
        const markers = CONDITIONAL_IGNORES[name];
        for (const marker of markers) {
            if (fs.existsSync(path.join(parentDir, marker))) {
                return true; // Marker found, this is a real vendor dir
            }
        }
    }

    return false;
}

/**
 * Find the project root directory by looking for marker files
 */
function findProjectRoot(startDir) {
    let dir = path.resolve(startDir);
    const root = path.parse(dir).root;

    while (dir !== root) {
        for (const marker of PROJECT_MARKERS) {
            if (fs.existsSync(path.join(dir, marker))) {
                return dir;
            }
        }
        try {
            const entries = fs.readdirSync(dir);
            if (entries.some(name => /\.(csproj|sln|vcxproj)$/i.test(name))) {
                return dir;
            }
        } catch (_) {
            // Keep walking toward the filesystem root.
        }
        dir = path.dirname(dir);
    }

    return path.resolve(startDir);
}

// All file extensions UCN analyzes. When manifests cannot identify the
// project, extension-based discovery remains the source of truth.
const ALL_SUPPORTED_EXTENSIONS = [
    'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'pyi', 'go', 'java', 'rs',
    'c', 'h', 'cc', 'cpp', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h++',
    'cs', 'csx', 'html', 'htm',
];

// Source-like extensions that UCN deliberately does not parse. This is not an
// attempt to recognize every file in existence: it is the honest handoff set
// used by project-wide discovery so `repo`/`doctor` cannot report a clean,
// complete index while silently omitting a common programming language.
const UNSUPPORTED_SOURCE_EXTENSIONS = {
    rb: 'Ruby', rake: 'Ruby',
    php: 'PHP',
    swift: 'Swift',
    kt: 'Kotlin', kts: 'Kotlin',
    scala: 'Scala', sc: 'Scala',
    lua: 'Lua',
    dart: 'Dart',
    ex: 'Elixir', exs: 'Elixir',
    erl: 'Erlang', hrl: 'Erlang',
    clj: 'Clojure', cljs: 'ClojureScript', cljc: 'Clojure',
    groovy: 'Groovy',
    vb: 'Visual Basic', vbs: 'Visual Basic',
    fs: 'F#', fsx: 'F#', fsi: 'F#',
    hs: 'Haskell', lhs: 'Haskell',
    zig: 'Zig',
    sol: 'Solidity',
    vue: 'Vue', svelte: 'Svelte',
    sh: 'Shell', bash: 'Shell', zsh: 'Shell', fish: 'Shell',
    ps1: 'PowerShell',
    sql: 'SQL',
};

function classifyUnsupportedSourceFile(filePath) {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const language = UNSUPPORTED_SOURCE_EXTENSIONS[extension];
    return language ? { extension, language } : null;
}

// Build-manifest hints: when present, we know the project has files of that language
// regardless of whether sources are visible at the time of scan. Used as hints, not gates —
// any source file extension is included whether or not its manifest is present.
const MANIFEST_HINTS = {
    'package.json':      ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'html', 'htm'],
    'pyproject.toml':    ['py'],
    'setup.py':          ['py'],
    'requirements.txt':  ['py'],
    'go.mod':            ['go'],
    'Cargo.toml':        ['rs'],
    'pom.xml':           ['java'],
    'build.gradle':      ['java'],
    'build.gradle.kts':  ['java'],
    'Makefile':          ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp'],
    'CMakeLists.txt':    ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp'],
    'compile_commands.json': ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp'],
    'meson.build':       ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp'],
};

/**
 * Auto-detect the glob pattern for a project.
 *
 * Discovery rule: build manifests are HINTS, not gates. We always scan ALL supported
 * language extensions (JS/TS/Python/Go/Rust/Java/HTML). Manifests only inform metadata
 * (e.g., flagging a project as "has Go") and never exclude files.
 *
 * This means a polyglot project with only `package.json` still discovers .py/.go/.rs
 * files — language is determined by extension, not by manifest presence.
 *
 * Manifests are still useful for:
 *   - Project root detection (see findProjectRoot / PROJECT_MARKERS)
 *   - Conditional ignores (vendor/target/Pods/etc. — see CONDITIONAL_IGNORES)
 *   - Language hints in stats output
 */
function detectProjectPattern(projectRoot) {
    // Always scan all supported language extensions. Build manifests no longer gate
    // language inclusion — file extension alone determines what gets analyzed.
    return `**/*.{${ALL_SUPPORTED_EXTENSIONS.join(',')}}`;
}

/**
 * Detect which manifest hints are present in a project root or immediate subdirectories.
 * Returns array of detected language extension hints. Used purely informationally —
 * not as a gate on which files get scanned.
 *
 * @param {string} projectRoot - Project root directory
 * @returns {string[]} Array of language extension strings (e.g., ['js', 'py', 'go'])
 */
function detectManifestHints(projectRoot) {
    const hints = new Set();

    const checkDir = (dir) => {
        for (const [marker, exts] of Object.entries(MANIFEST_HINTS)) {
            if (fs.existsSync(path.join(dir, marker))) {
                for (const ext of exts) hints.add(ext);
            }
        }
    };

    checkDir(projectRoot);

    try {
        const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.') &&
                !shouldIgnore(entry.name, DEFAULT_IGNORES)) {
                checkDir(path.join(projectRoot, entry.name));
            }
        }
    } catch (e) {
        // Ignore errors reading directory
    }

    return [...hints];
}

/**
 * Get file statistics for a set of files
 */
function getFileStats(files) {
    const stats = {
        totalFiles: files.length,
        totalLines: 0,
        byExtension: {}
    };

    for (const file of files) {
        const ext = path.extname(file).toLowerCase() || '(none)';

        if (!stats.byExtension[ext]) {
            stats.byExtension[ext] = { count: 0, lines: 0 };
        }

        try {
            const content = fs.readFileSync(file, 'utf-8');
            const lines = content.split('\n').length;
            stats.totalLines += lines;
            stats.byExtension[ext].count++;
            stats.byExtension[ext].lines += lines;
        } catch (e) {
            // Skip files that can't be read
        }
    }

    return stats;
}

/**
 * Check if a file is a test file based on its path and language
 */
function isTestFile(filePath, language) {
    const patterns = TEST_PATTERNS[language] || TEST_PATTERNS.javascript;
    const normalizedPath = filePath.replace(/\\/g, '/');
    const basename = path.basename(filePath);

    for (const pattern of patterns) {
        if (pattern.test(normalizedPath) || pattern.test(basename)) {
            return true;
        }
    }
    return false;
}

/**
 * Find the test file for a given source file
 */
function findTestFileFor(sourceFile, language) {
    const dir = path.dirname(sourceFile);
    const ext = path.extname(sourceFile);
    const base = path.basename(sourceFile, ext);

    const traits = langTraits(language);
    const candidates = traits?.testFileCandidates
        ? traits.testFileCandidates(base, ext)
        : [`${base}.test${ext}`, `${base}.spec${ext}`];

    // Check in same directory
    for (const candidate of candidates) {
        const testPath = path.join(dir, candidate);
        if (fs.existsSync(testPath)) {
            return testPath;
        }
    }

    // Check in language-specific test directories
    const testDirs = traits?.testDirs || [];
    for (const testDir of testDirs) {
        const testsDir = path.join(dir, testDir);
        for (const candidate of candidates) {
            const testPath = path.join(testsDir, candidate);
            if (fs.existsSync(testPath)) {
                return testPath;
            }
        }
    }

    return null;
}

module.exports = {
    expandGlob,
    parseGlobPattern,
    globToRegex,
    walkDir,
    shouldIgnore,
    findProjectRoot,
    detectProjectPattern,
    detectManifestHints,
    getFileStats,
    isTestFile,
    findTestFileFor,
    parseGitignore,
    gitTrackedPaths,
    gitListing,
    DEFAULT_IGNORES,
    PROJECT_MARKERS,
    TEST_PATTERNS,
    ALL_SUPPORTED_EXTENSIONS,
    UNSUPPORTED_SOURCE_EXTENSIONS,
    classifyUnsupportedSourceFile,
    MANIFEST_HINTS,
    compareNames
};
