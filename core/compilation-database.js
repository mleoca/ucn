'use strict';

/**
 * Read-only compile_commands.json support for C/C++ language and include-path
 * resolution. This module interprets build metadata only; source analysis
 * remains tree-sitter AST based.
 */

const fs = require('fs');
const path = require('path');

const CPP_EXTENSIONS = new Set(['.cc', '.cpp', '.cxx', '.c++', '.cp', '.mm']);
const C_EXTENSIONS = new Set(['.c', '.m']);
const cache = new Map();
const conventionCache = new Map();
const CONVENTION_IGNORES = new Set([
    '.git', '.svn', 'node_modules', 'vendor', 'third_party',
    'build', 'dist', 'out', 'target',
]);

function splitCommandLine(command) {
    const args = [];
    let current = '';
    let quote = null;
    let escaped = false;
    for (const char of String(command || '')) {
        if (escaped) {
            current += char;
            escaped = false;
        } else if (char === '\\' && quote !== "'") {
            escaped = true;
        } else if (quote) {
            if (char === quote) quote = null;
            else current += char;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (/\s/.test(char)) {
            if (current) {
                args.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }
    if (escaped) current += '\\';
    if (current) args.push(current);
    return args;
}

function findCompilationDatabase(startDir, stopDir = null) {
    let dir = path.resolve(startDir);
    const boundary = stopDir ? path.resolve(stopDir) : null;
    while (true) {
        const candidate = path.join(dir, 'compile_commands.json');
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch { /* keep walking */ }
        if (boundary && dir === boundary) break;
        const parent = path.dirname(dir);
        if (parent === dir || (boundary && !parent.startsWith(boundary))) break;
        dir = parent;
    }
    return null;
}

function languageFromArgs(file, args) {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-x' && args[i + 1]) {
            const value = args[i + 1].toLowerCase();
            if (value.includes('c++') || value.includes('objective-c++')) return 'cpp';
            if (value === 'c' || value.includes('objective-c')) return 'c';
        }
        if (args[i].startsWith('-x')) {
            const value = args[i].slice(2).toLowerCase();
            if (value.includes('c++') || value.includes('objective-c++')) return 'cpp';
            if (value === 'c' || value.includes('objective-c')) return 'c';
        }
    }
    const ext = path.extname(file).toLowerCase();
    if (CPP_EXTENSIONS.has(ext)) return 'cpp';
    if (C_EXTENSIONS.has(ext)) return 'c';
    const compiler = path.basename(args[0] || '').toLowerCase();
    if (/(^|-)c\+\+/.test(compiler) || /g\+\+|clang\+\+/.test(compiler)) return 'cpp';
    return 'c';
}

function includeDirectories(directory, args) {
    const result = [];
    const add = value => {
        if (!value) return;
        const absolute = path.isAbsolute(value) ? value : path.resolve(directory, value);
        if (!result.includes(absolute)) result.push(absolute);
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-I' || arg === '-isystem' || arg === '-iquote') {
            add(args[++i]);
        } else if (arg.startsWith('-I') && arg.length > 2) {
            add(arg.slice(2));
        } else if (arg.startsWith('-isystem') && arg.length > 8) {
            add(arg.slice(8));
        } else if (arg.startsWith('-iquote') && arg.length > 7) {
            add(arg.slice(7));
        }
    }
    return result;
}

function loadCompilationDatabase(databasePath) {
    if (!databasePath) return null;
    let stat;
    try { stat = fs.statSync(databasePath); }
    catch { return null; }
    const previous = cache.get(databasePath);
    if (previous && previous.mtime === stat.mtimeMs && previous.size === stat.size) {
        return previous.value;
    }
    try {
        const rows = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
        if (!Array.isArray(rows)) return null;
        const entries = [];
        for (const row of rows) {
            if (!row || typeof row.file !== 'string') continue;
            const directory = path.resolve(row.directory || path.dirname(databasePath));
            const file = path.isAbsolute(row.file) ? row.file : path.resolve(directory, row.file);
            const args = Array.isArray(row.arguments)
                ? row.arguments.map(String)
                : splitCommandLine(row.command);
            entries.push({
                file,
                directory,
                language: languageFromArgs(file, args),
                includeDirs: includeDirectories(directory, args),
            });
        }
        const value = { path: databasePath, root: path.dirname(databasePath), entries };
        cache.set(databasePath, { mtime: stat.mtimeMs, size: stat.size, value });
        return value;
    } catch {
        return null;
    }
}

function directoryDistance(fromDir, candidateDir) {
    const relative = path.relative(candidateDir, fromDir);
    if (relative === '') return 0;
    return relative.split(path.sep).filter(part => part && part !== '.').length;
}

function nearestEntries(database, filePath) {
    if (!database) return [];
    const directory = path.dirname(path.resolve(filePath));
    return [...database.entries].sort((a, b) => {
        const distance = directoryDistance(directory, path.dirname(a.file)) -
            directoryDistance(directory, path.dirname(b.file));
        // Code-unit tiebreak (rule 11): localeCompare is ICU-locale-dependent.
        return distance || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
    });
}

function projectBoundary(startDir) {
    let directory = path.resolve(startDir);
    let fallback = directory;
    for (let depth = 0; depth < 8; depth++) {
        fallback = directory;
        if (fs.existsSync(path.join(directory, '.git')) ||
            fs.existsSync(path.join(directory, 'CMakeLists.txt')) ||
            fs.existsSync(path.join(directory, 'meson.build'))) {
            return directory;
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    return fallback;
}

function projectTranslationUnitConvention(filePath, projectRoot = null) {
    const root = projectRoot
        ? path.resolve(projectRoot)
        : projectBoundary(path.dirname(filePath));
    if (conventionCache.has(root)) return conventionCache.get(root);
    let cpp = 0;
    let c = 0;
    let visited = 0;
    const queue = [root];
    while (queue.length > 0 && visited < 5000) {
        const directory = queue.shift();
        let entries;
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            continue;
        }
        entries.sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        for (const entry of entries) {
            if (visited++ >= 5000) break;
            if (entry.isDirectory()) {
                if (!CONVENTION_IGNORES.has(entry.name) &&
                    !entry.name.startsWith('.')) {
                    queue.push(path.join(directory, entry.name));
                }
                continue;
            }
            const extension = path.extname(entry.name).toLowerCase();
            if (CPP_EXTENSIONS.has(extension)) cpp++;
            else if (C_EXTENSIONS.has(extension)) c++;
        }
    }
    const language = cpp === c ? null : cpp > c ? 'cpp' : 'c';
    conventionCache.set(root, language);
    return language;
}

function detectHeaderLanguage(filePath, projectRoot = null) {
    const originalExt = path.extname(filePath);
    if (originalExt === '.H' || originalExt === '.HPP') return 'cpp';
    const stem = filePath.slice(0, -originalExt.length);
    for (const ext of CPP_EXTENSIONS) {
        try { if (fs.statSync(stem + ext).isFile()) return 'cpp'; } catch { /* next */ }
    }
    for (const ext of C_EXTENSIONS) {
        try { if (fs.statSync(stem + ext).isFile()) return 'c'; } catch { /* next */ }
    }
    const dbPath = findCompilationDatabase(path.dirname(filePath), projectRoot);
    const database = loadCompilationDatabase(dbPath);
    const nearest = nearestEntries(database, filePath);
    if (nearest.length > 0) {
        const closestDistance = directoryDistance(
            path.dirname(filePath), path.dirname(nearest[0].file));
        const closest = nearest.filter(entry =>
            directoryDistance(path.dirname(filePath), path.dirname(entry.file)) === closestDistance);
        const cpp = closest.filter(entry => entry.language === 'cpp').length;
        const c = closest.filter(entry => entry.language === 'c').length;
        if (cpp !== c) return cpp > c ? 'cpp' : 'c';
    }
    // No database: use neighboring translation-unit extensions as a
    // deterministic project convention, without reading source text.
    try {
        const names = fs.readdirSync(path.dirname(filePath));
        const cpp = names.filter(name => CPP_EXTENSIONS.has(path.extname(name).toLowerCase())).length;
        const c = names.filter(name => C_EXTENSIONS.has(path.extname(name).toLowerCase())).length;
        if (cpp !== c) return cpp > c ? 'cpp' : 'c';
    } catch { /* default below */ }
    const projectConvention = projectTranslationUnitConvention(filePath, projectRoot);
    if (projectConvention) return projectConvention;
    return 'c';
}

function includeDirectoriesForFile(filePath, projectRoot = null) {
    const dbPath = findCompilationDatabase(path.dirname(filePath), projectRoot);
    const database = loadCompilationDatabase(dbPath);
    if (!database) return [];
    const exact = database.entries.find(entry => path.resolve(entry.file) === path.resolve(filePath));
    const candidates = exact ? [exact] : nearestEntries(database, filePath).slice(0, 8);
    const result = [];
    for (const entry of candidates) {
        for (const directory of entry.includeDirs) {
            if (!result.includes(directory)) result.push(directory);
        }
    }
    return result;
}

module.exports = {
    CPP_EXTENSIONS,
    C_EXTENSIONS,
    splitCommandLine,
    findCompilationDatabase,
    loadCompilationDatabase,
    detectHeaderLanguage,
    projectTranslationUnitConvention,
    includeDirectoriesForFile,
};
