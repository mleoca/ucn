/**
 * core/discovery.js - File discovery and glob pattern expansion
 *
 * Pure Node.js implementation (no external dependencies)
 */

const fs = require('fs');
const path = require('path');

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

    // Build outputs
    'dist',
    'build',
    'out',
    '.next',
    'next.lock',
    '.nuxt',
    '.output',
    '.vercel',
    '.netlify',

    // Test/coverage
    'coverage',
    '.nyc_output',
    '.pytest_cache',
    '.mypy_cache',

    // Bundled/minified
    '*.min.js',
    '*.bundle.js',
    '*.map',

    // System
    '.DS_Store',
    '.ucn-cache'
];

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
    'Makefile'
];

// Test file patterns by language
const TEST_PATTERNS = {
    javascript: [
        /\.test\.(js|jsx|ts|tsx|mjs|cjs)$/,
        /\.spec\.(js|jsx|ts|tsx|mjs|cjs)$/,
        /__tests__\//,
        /\.test$/
    ],
    typescript: [
        /\.test\.(ts|tsx)$/,
        /\.spec\.(ts|tsx)$/,
        /__tests__\//
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
    ]
};

/**
 * Parse .gitignore file and return patterns compatible with shouldIgnore().
 * Handles simple directory/file patterns. Skips negation patterns and comments.
 *
 * @param {string} projectRoot - Project root directory
 * @returns {string[]} - Array of ignore patterns (directory/file names and globs)
 */
function parseGitignore(projectRoot) {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return [];

    let content;
    try {
        content = fs.readFileSync(gitignorePath, 'utf-8');
    } catch (e) {
        return [];
    }

    const patterns = [];
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        // Skip empty lines, comments, negation patterns
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;

        // Strip trailing slash (directory indicator) — shouldIgnore checks names, not types
        let pattern = line.endsWith('/') ? line.slice(0, -1) : line;

        // Strip leading slash (root-relative indicator) — we only match by name
        if (pattern.startsWith('/')) pattern = pattern.slice(1);

        // Skip patterns with path separators — shouldIgnore matches single name segments,
        // not full paths. Patterns like "foo/bar" would need walkDir-level support.
        if (pattern.includes('/')) continue;

        // Skip empty after stripping
        if (!pattern) continue;

        // Avoid duplicating built-in ignores
        if (DEFAULT_IGNORES.includes(pattern)) continue;

        patterns.push(pattern);
    }

    return patterns;
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
    const maxDepth = options.maxDepth || 20;
    const maxFiles = options.maxFiles || 10000;
    const followSymlinks = options.followSymlinks !== false; // default true

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
        maxDepth,
        followSymlinks,
        onFile: (filePath) => {
            if (files.length < maxFiles) {
                files.push(filePath);
            }
        }
    });

    return files.sort(compareNames);
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
    let regex = glob.replace(/[.+^$[\]\\]/g, '\\$&');

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
function walkDir(dir, options, depth = 0, visited = new Set()) {
    if (depth > options.maxDepth) return;
    if (!fs.existsSync(dir)) return;

    // Track visited directories to avoid circular symlinks
    let realDir;
    try {
        realDir = fs.realpathSync(dir);
    } catch (e) {
        return; // broken symlink
    }
    if (visited.has(realDir)) return;
    visited.add(realDir);

    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return;
    }

    entries.sort((a, b) => compareNames(a.name, b.name));

    const followSymlinks = options.followSymlinks !== false; // default true

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (shouldIgnore(entry.name, options.ignores, dir)) continue;

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
                walkDir(fullPath, options, depth + 1, visited);
            }
        } else if (isFile) {
            if (options.filePattern.test(entry.name)) {
                options.onFile(fullPath);
            }
        }
    }
}

/**
 * Check if a file/directory name should be ignored
 * @param {string} name - File/directory name
 * @param {string[]} ignores - Patterns to always ignore
 * @param {string} [parentDir] - Parent directory path (for conditional checks)
 */
function shouldIgnore(name, ignores, parentDir) {
    // Check unconditional ignores
    for (const pattern of ignores) {
        if (pattern.includes('*')) {
            const regex = globToRegex(pattern);
            if (regex.test(name)) return true;
        } else if (name === pattern) {
            return true;
        }
    }

    // Check conditional ignores (only if parentDir provided)
    // Use Array.isArray to avoid matching Object.prototype properties (e.g. dir named "constructor")
    if (parentDir && Array.isArray(CONDITIONAL_IGNORES[name])) {
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
        dir = path.dirname(dir);
    }

    return path.resolve(startDir);
}

/**
 * Auto-detect the glob pattern for a project based on its type
 * Checks both project root and immediate subdirectories for config files
 */
function detectProjectPattern(projectRoot) {
    const extensions = [];

    // Helper to check for config files in a directory
    const checkDir = (dir) => {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            extensions.push('js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs');
        }

        if (fs.existsSync(path.join(dir, 'pyproject.toml')) ||
            fs.existsSync(path.join(dir, 'setup.py')) ||
            fs.existsSync(path.join(dir, 'requirements.txt'))) {
            extensions.push('py');
        }

        if (fs.existsSync(path.join(dir, 'go.mod'))) {
            extensions.push('go');
        }

        if (fs.existsSync(path.join(dir, 'Cargo.toml'))) {
            extensions.push('rs');
        }

        if (fs.existsSync(path.join(dir, 'pom.xml')) ||
            fs.existsSync(path.join(dir, 'build.gradle'))) {
            extensions.push('java', 'kt');
        }
    };

    // Check project root
    checkDir(projectRoot);

    // Also check immediate subdirectories for multi-language projects (e.g., web/, frontend/, server/)
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

    if (extensions.length > 0) {
        const unique = [...new Set(extensions)];
        return `**/*.{${unique.join(',')}}`;
    }

    return '**/*.{js,jsx,ts,tsx,py,go,java,rs,rb,php,c,cpp,h,hpp}';
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

    const candidates = [];

    switch (language) {
        case 'javascript':
        case 'typescript':
        case 'tsx':
            candidates.push(
                `${base}.test${ext}`,
                `${base}.spec${ext}`,
                `${base}.test.ts`,
                `${base}.test.js`,
                `${base}.spec.ts`,
                `${base}.spec.js`
            );
            break;
        case 'python':
            candidates.push(
                `test_${base}.py`,
                `${base}_test.py`
            );
            break;
        case 'go':
            candidates.push(`${base}_test.go`);
            break;
        case 'java':
            candidates.push(
                `${base}Test.java`,
                `${base}Tests.java`,
                `${base}TestCase.java`
            );
            break;
        case 'rust':
            candidates.push(`${base}_test.rs`);
            break;
        default:
            candidates.push(
                `${base}.test${ext}`,
                `${base}.spec${ext}`
            );
    }

    // Check in same directory
    for (const candidate of candidates) {
        const testPath = path.join(dir, candidate);
        if (fs.existsSync(testPath)) {
            return testPath;
        }
    }

    // Check in __tests__ subdirectory
    if (language === 'javascript' || language === 'typescript' || language === 'tsx') {
        const testsDir = path.join(dir, '__tests__');
        for (const candidate of candidates) {
            const testPath = path.join(testsDir, candidate);
            if (fs.existsSync(testPath)) {
                return testPath;
            }
        }
    }

    // Check in tests subdirectory
    if (language === 'python' || language === 'rust') {
        const testsDir = path.join(dir, 'tests');
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
    getFileStats,
    isTestFile,
    findTestFileFor,
    parseGitignore,
    DEFAULT_IGNORES,
    PROJECT_MARKERS,
    TEST_PATTERNS
};
