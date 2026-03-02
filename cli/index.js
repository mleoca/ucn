#!/usr/bin/env node

/**
 * UCN CLI - Universal Code Navigator
 *
 * Unified command model: commands work consistently across file and project modes.
 * Auto-detects mode from target (file path → file mode, directory → project mode).
 */

const fs = require('fs');
const path = require('path');

const { parse, parseFile, extractFunction, extractClass, cleanHtmlScriptTags, detectLanguage, isSupported } = require('../core/parser');
const { getParser, getLanguageModule } = require('../languages');
const { ProjectIndex } = require('../core/project');
const { expandGlob, findProjectRoot } = require('../core/discovery');
const output = require('../core/output');
const { pickBestDefinition } = require('../core/shared');
const { getCliCommandSet, resolveCommand } = require('../core/registry');
const { execute } = require('../core/execute');
const { ExpandCache, renderExpandItem } = require('../core/expand-cache');

// ============================================================================
// ARGUMENT PARSING
// ============================================================================

const rawArgs = process.argv.slice(2);

// MCP server mode — launch server and skip CLI
if (rawArgs.includes('--mcp')) {
    require('../mcp/server.js');
} else {
// Support -- to separate flags from positional arguments
const doubleDashIdx = rawArgs.indexOf('--');
const args = doubleDashIdx === -1 ? rawArgs : rawArgs.slice(0, doubleDashIdx);
const argsAfterDoubleDash = doubleDashIdx === -1 ? [] : rawArgs.slice(doubleDashIdx + 1);

// Parse flags
const flags = {
    json: args.includes('--json'),
    quiet: !args.includes('--verbose') && !args.includes('--no-quiet'),
    codeOnly: args.includes('--code-only'),
    caseSensitive: args.includes('--case-sensitive'),
    withTypes: args.includes('--with-types'),
    topLevel: args.includes('--top-level'),
    exact: args.includes('--exact'),
    cache: !args.includes('--no-cache'),
    clearCache: args.includes('--clear-cache'),
    context: parseInt(args.find(a => a.startsWith('--context='))?.split('=').slice(1).join('=') || '0'),
    file: args.find(a => a.startsWith('--file='))?.split('=').slice(1).join('=') || null,
    // Semantic filters (--not is alias for --exclude)
    exclude: args.filter(a => a.startsWith('--exclude=') || a.startsWith('--not=')).flatMap(a => a.split('=').slice(1).join('=').split(','))  || [],
    in: args.find(a => a.startsWith('--in='))?.split('=').slice(1).join('=') || null,
    // Test file inclusion (by default, tests are excluded from usages/find)
    includeTests: args.includes('--include-tests'),
    // Deadcode options
    includeExported: args.includes('--include-exported'),
    includeDecorated: args.includes('--include-decorated'),
    // Uncertain matches (off by default)
    includeUncertain: args.includes('--include-uncertain'),
    // Detailed listing (e.g. toc with all symbols)
    detailed: args.includes('--detailed'),
    // Output depth
    depth: args.find(a => a.startsWith('--depth='))?.split('=').slice(1).join('=') || null,
    // Inline expansion for callees
    expand: args.includes('--expand'),
    // Interactive REPL mode
    interactive: args.includes('--interactive') || args.includes('-i'),
    // Plan command options
    addParam: args.find(a => a.startsWith('--add-param='))?.split('=').slice(1).join('=') || null,
    removeParam: args.find(a => a.startsWith('--remove-param='))?.split('=').slice(1).join('=') || null,
    renameTo: args.find(a => a.startsWith('--rename-to='))?.split('=').slice(1).join('=') || null,
    defaultValue: args.find(a => a.startsWith('--default='))?.split('=').slice(1).join('=') || null,
    // Smart filtering for find results
    top: parseInt(args.find(a => a.startsWith('--top='))?.split('=').slice(1).join('=') || '0'),
    all: args.includes('--all'),
    // Include method calls in caller/callee analysis
    // Tri-state: true (--include-methods), false (--include-methods=false), undefined (let command decide default)
    includeMethods: args.some(a => a === '--include-methods=false') ? false : args.some(a => a === '--include-methods' || (a.startsWith('--include-methods=') && a !== '--include-methods=false')) ? true : undefined,
    // Tests: only show call/test-case matches
    callsOnly: args.includes('--calls-only'),
    // Graph direction (imports/importers/both)
    direction: args.find(a => a.startsWith('--direction='))?.split('=').slice(1).join('=') || null,
    // Symlink handling (follow by default)
    followSymlinks: !args.includes('--no-follow-symlinks'),
    // Diff-impact options
    base: args.find(a => a.startsWith('--base='))?.split('=').slice(1).join('=') || null,
    staged: args.includes('--staged'),
    // Regex search mode (default: ON; --no-regex to force plain text)
    regex: args.includes('--no-regex') ? false : undefined,
    // Stats: per-function line counts
    functions: args.includes('--functions'),
    // Class: max lines to show (0 = no limit)
    maxLines: parseInt(args.find(a => a.startsWith('--max-lines='))?.split('=').slice(1).join('=') || '0') || null
};

// Handle --file flag with space
const fileArgIdx = args.indexOf('--file');
if (fileArgIdx !== -1 && args[fileArgIdx + 1] && !args[fileArgIdx + 1].startsWith('-')) {
    flags.file = args[fileArgIdx + 1];
}

// Known flags for validation
const knownFlags = new Set([
    '--help', '-h', '--mcp',
    '--json', '--verbose', '--no-quiet', '--quiet',
    '--code-only', '--with-types', '--top-level', '--exact', '--case-sensitive',
    '--no-cache', '--clear-cache', '--include-tests',
    '--include-exported', '--include-decorated', '--expand', '--interactive', '-i', '--all', '--include-methods', '--include-uncertain', '--detailed', '--calls-only',
    '--file', '--context', '--exclude', '--not', '--in',
    '--depth', '--direction', '--add-param', '--remove-param', '--rename-to',
    '--default', '--top', '--no-follow-symlinks',
    '--base', '--staged', '--stack',
    '--regex', '--no-regex', '--functions',
    '--max-lines'
]);

// Handle help flag
if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
}

// Validate flags
const unknownFlags = args.filter(a => {
    if (!a.startsWith('-')) return false;
    // Handle --flag=value format
    const flagName = a.includes('=') ? a.split('=')[0] : a;
    return !knownFlags.has(flagName);
});

if (unknownFlags.length > 0) {
    console.error(`Unknown flag(s): ${unknownFlags.join(', ')}`);
    console.error('Use --help to see available flags');
    process.exit(1);
}

// Remove flags from args, then add args after -- (which are all positional)
const positionalArgs = [
    ...args.filter((a, idx) =>
        !a.startsWith('--') &&
        a !== '-i' &&
        !(idx > 0 && args[idx - 1] === '--file')
    ),
    ...argsAfterDoubleDash
];

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Add test file patterns to exclusion list
 * Used by find/usages when --include-tests is not specified
 */
/**
 * Validate required argument and exit with usage if missing
 * @param {string} arg - The argument to validate
 * @param {string} usage - Usage message to show on error
 */
function requireArg(arg, usage) {
    if (!arg) {
        console.error(usage);
        process.exit(1);
    }
}

/**
 * Print result in JSON or text format based on --json flag
 * @param {*} result - The result data
 * @param {Function} jsonFn - Function to format as JSON (receives result)
 * @param {Function} textFn - Function to format as text (receives result)
 */
function printOutput(result, jsonFn, textFn) {
    if (flags.json) {
        console.log(jsonFn(result));
    } else {
        const text = textFn(result);
        if (text !== undefined) {
            console.log(text);
        }
    }
}

// ============================================================================
// MAIN
// ============================================================================

// All valid commands - derived from canonical registry
const COMMANDS = getCliCommandSet();

function main() {
    // Determine target and command based on positional args
    let target, command, arg;

    if (positionalArgs.length === 0) {
        // No args: show help
        printUsage();
        process.exit(0);
    } else if (positionalArgs.length === 1) {
        // One arg: could be a command (use . as target) or a target (use toc as command)
        if (COMMANDS.has(positionalArgs[0])) {
            target = '.';
            command = positionalArgs[0];
            arg = undefined;
        } else {
            target = positionalArgs[0];
            command = 'toc';
            arg = undefined;
        }
    } else if (COMMANDS.has(positionalArgs[0])) {
        // First arg is a command, so target defaults to .
        target = '.';
        command = positionalArgs[0];
        arg = positionalArgs[1];
    } else {
        // First arg is a target (path/glob)
        target = positionalArgs[0];
        command = positionalArgs[1] || 'toc';
        arg = positionalArgs[2];
    }

    // Determine mode: single file, glob pattern, or project
    if (target === '.' || (fs.existsSync(target) && fs.statSync(target).isDirectory())) {
        // Project mode
        runProjectCommand(target, command, arg);
    } else if (target.includes('*') || target.includes('{')) {
        // Glob pattern mode
        runGlobCommand(target, command, arg);
    } else if (fs.existsSync(target)) {
        // Single file mode
        runFileCommand(target, command, arg);
    } else {
        console.error(`Error: "${target}" not found`);
        process.exit(1);
    }
}

// ============================================================================
// FILE MODE
// ============================================================================

function runFileCommand(filePath, command, arg) {
    const code = fs.readFileSync(filePath, 'utf-8');
    const lines = code.split('\n');
    const language = detectLanguage(filePath);

    if (!language) {
        console.error(`Unsupported file type: ${filePath}`);
        process.exit(1);
    }

    const result = parse(code, language);

    switch (command) {
        case 'toc':
            printFileToc(result, filePath);
            break;

        case 'fn': {
            requireArg(arg, 'Usage: ucn <file> fn <name>');
            const { fn, code: fnCode } = extractFunction(code, language, arg);
            if (fn) {
                printOutput({ fn, fnCode },
                    r => output.formatFunctionJson(r.fn, r.fnCode),
                    r => {
                        console.log(`${output.lineRange(r.fn.startLine, r.fn.endLine)} ${output.formatFunctionSignature(r.fn)}`);
                        console.log('─'.repeat(60));
                        console.log(r.fnCode);
                    }
                );
            } else {
                console.error(`Function "${arg}" not found`);
                suggestSimilar(arg, result.functions.map(f => f.name));
            }
            break;
        }

        case 'class': {
            requireArg(arg, 'Usage: ucn <file> class <name>');
            const { cls, code: clsCode } = extractClass(code, language, arg);
            if (cls) {
                printOutput({ cls, clsCode },
                    r => JSON.stringify({ ...r.cls, code: r.clsCode }, null, 2),
                    r => {
                        console.log(`${output.lineRange(r.cls.startLine, r.cls.endLine)} ${output.formatClassSignature(r.cls)}`);
                        console.log('─'.repeat(60));
                        console.log(r.clsCode);
                    }
                );
            } else {
                console.error(`Class "${arg}" not found`);
                suggestSimilar(arg, result.classes.map(c => c.name));
            }
            break;
        }

        case 'find': {
            requireArg(arg, 'Usage: ucn <file> find <name>');
            findInFile(result, arg, filePath);
            break;
        }

        case 'usages': {
            requireArg(arg, 'Usage: ucn <file> usages <name>');
            usagesInFile(code, lines, arg, filePath, result);
            break;
        }

        case 'search': {
            requireArg(arg, 'Usage: ucn <file> search <term>');
            searchFile(filePath, lines, arg);
            break;
        }

        case 'lines': {
            requireArg(arg, 'Usage: ucn <file> lines <start-end>');
            printLines(lines, arg);
            break;
        }

        case 'typedef': {
            requireArg(arg, 'Usage: ucn <file> typedef <name>');
            typedefInFile(result, arg, filePath);
            break;
        }

        case 'api':
            apiInFile(result, filePath);
            break;

        // Project commands - auto-route to project mode
        case 'smart':
        case 'context':
        case 'tests':
        case 'about':
        case 'impact':
        case 'trace':
        case 'related':
        case 'example':
        case 'graph':
        case 'stats':
        case 'deadcode':
        case 'imports':
        case 'what-imports':
        case 'exporters':
        case 'who-imports':
        case 'verify':
        case 'plan':
        case 'expand':
        case 'stacktrace':
        case 'stack':
        case 'diff-impact':
        case 'file-exports':
        case 'what-exports': {
            // Auto-detect project root and route to project mode
            const projectRoot = findProjectRoot(path.dirname(filePath));

            // For file-specific commands (imports/exporters/graph), use the target file as arg if no arg given
            const fileCanonical = resolveCommand(command, 'cli') || command;
            let effectiveArg = arg;
            if ((fileCanonical === 'imports' || fileCanonical === 'exporters' ||
                 fileCanonical === 'fileExports' || fileCanonical === 'graph') && !arg) {
                effectiveArg = filePath;
            }

            // For stats/deadcode, no arg needed
            if (fileCanonical === 'stats' || fileCanonical === 'deadcode') {
                effectiveArg = arg;  // may be undefined, that's ok
            }

            runProjectCommand(projectRoot, command, effectiveArg);
            break;
        }

        default:
            console.error(`Unknown command: ${command}`);
            printUsage();
            process.exit(1);
    }
}

function printFileToc(result, filePath) {
    // Filter for top-level only if flag is set
    let functions = result.functions;
    if (flags.topLevel) {
        functions = functions.filter(fn => !fn.isNested && (!fn.indent || fn.indent === 0));
    }

    if (flags.json) {
        console.log(output.formatTocJson({
            totalFiles: 1,
            totalLines: result.totalLines,
            totalFunctions: functions.length,
            totalClasses: result.classes.length,
            totalState: result.stateObjects.length,
            byFile: [{
                file: filePath,
                language: result.language,
                lines: result.totalLines,
                functions,
                classes: result.classes,
                state: result.stateObjects
            }]
        }));
        return;
    }

    console.log(`FILE: ${filePath} (${result.totalLines} lines)`);
    console.log('═'.repeat(60));

    if (functions.length > 0) {
        console.log('\nFUNCTIONS:');
        for (const fn of functions) {
            const sig = output.formatFunctionSignature(fn);
            console.log(`  ${output.lineRange(fn.startLine, fn.endLine)} ${sig}`);
            if (fn.docstring) {
                console.log(`      ${fn.docstring}`);
            }
        }
    }

    if (result.classes.length > 0) {
        console.log('\nCLASSES:');
        for (const cls of result.classes) {
            console.log(`  ${output.lineRange(cls.startLine, cls.endLine)} ${output.formatClassSignature(cls)}`);
            if (cls.docstring) {
                console.log(`      ${cls.docstring}`);
            }
            if (cls.members && cls.members.length > 0) {
                for (const m of cls.members) {
                    console.log(`    ${output.lineLoc(m.startLine)} ${output.formatMemberSignature(m)}`);
                }
            }
        }
    }

    if (result.stateObjects.length > 0) {
        console.log('\nSTATE:');
        for (const s of result.stateObjects) {
            console.log(`  ${output.lineRange(s.startLine, s.endLine)} ${s.name}`);
        }
    }
}

function findInFile(result, name, filePath) {
    const matches = [];
    const lowerName = name.toLowerCase();

    for (const fn of result.functions) {
        if (flags.exact ? fn.name === name : fn.name.toLowerCase().includes(lowerName)) {
            matches.push({ ...fn, type: 'function' });
        }
    }

    for (const cls of result.classes) {
        if (flags.exact ? cls.name === name : cls.name.toLowerCase().includes(lowerName)) {
            matches.push({ ...cls });
        }
    }

    if (flags.json) {
        console.log(output.formatSymbolJson(matches.map(m => ({ ...m, relativePath: filePath })), name));
    } else {
        if (matches.length === 0) {
            console.log(`No symbols found for "${name}" in ${filePath}`);
        } else {
            console.log(`Found ${matches.length} match(es) for "${name}" in ${filePath}:`);
            console.log('─'.repeat(60));
            for (const m of matches) {
                const sig = m.params !== undefined
                    ? output.formatFunctionSignature(m)
                    : output.formatClassSignature(m);
                console.log(`${filePath}:${m.startLine}  ${sig}`);
            }
        }
    }
}

function usagesInFile(code, lines, name, filePath, result) {
    const usages = [];

    // Get definitions
    const defs = [];
    for (const fn of result.functions) {
        if (fn.name === name) {
            defs.push({ ...fn, type: 'function', isDefinition: true, line: fn.startLine });
        }
    }
    for (const cls of result.classes) {
        if (cls.name === name) {
            defs.push({ ...cls, isDefinition: true, line: cls.startLine });
        }
    }

    // Try AST-based detection first
    const lang = detectLanguage(filePath);
    const langModule = getLanguageModule(lang);

    if (langModule && typeof langModule.findUsagesInCode === 'function') {
        try {
            const parser = getParser(lang);
            if (parser) {
                const astUsages = langModule.findUsagesInCode(code, name, parser);

                for (const u of astUsages) {
                    // Skip definition lines
                    if (defs.some(d => d.startLine === u.line)) {
                        continue;
                    }

                    const lineContent = lines[u.line - 1] || '';
                    const usage = {
                        file: filePath,
                        relativePath: filePath,
                        line: u.line,
                        content: lineContent,
                        usageType: u.usageType,
                        isDefinition: false
                    };

                    // Add context
                    if (flags.context > 0) {
                        const idx = u.line - 1;
                        const before = [];
                        const after = [];
                        for (let i = 1; i <= flags.context; i++) {
                            if (idx - i >= 0) before.unshift(lines[idx - i]);
                            if (idx + i < lines.length) after.push(lines[idx + i]);
                        }
                        usage.before = before;
                        usage.after = after;
                    }

                    usages.push(usage);
                }

                // Add definitions to result and output
                const allUsages = [
                    ...defs.map(d => ({
                        ...d,
                        relativePath: filePath,
                        content: lines[d.startLine - 1],
                        signature: d.params !== undefined
                            ? output.formatFunctionSignature(d)
                            : output.formatClassSignature(d)
                    })),
                    ...usages
                ];

                if (flags.json) {
                    console.log(output.formatUsagesJson(allUsages, name));
                } else {
                    console.log(output.formatUsages(allUsages, name));
                }
                return;
            }
        } catch (e) {
            // AST parsing failed — usages will be empty, only definitions shown
        }
    }

    // Output definitions + any usages found via AST
    const allUsages = [
        ...defs.map(d => ({
            ...d,
            relativePath: filePath,
            content: lines[d.startLine - 1],
            signature: d.params !== undefined
                ? output.formatFunctionSignature(d)
                : output.formatClassSignature(d)
        })),
        ...usages
    ];

    if (flags.json) {
        console.log(output.formatUsagesJson(allUsages, name));
    } else {
        console.log(output.formatUsages(allUsages, name));
    }
}

function typedefInFile(result, name, filePath) {
    const typeKinds = ['type', 'interface', 'enum', 'struct', 'trait', 'class'];
    const matches = result.classes.filter(c =>
        typeKinds.includes(c.type) &&
        (flags.exact ? c.name === name : c.name.toLowerCase().includes(name.toLowerCase()))
    );

    // Extract source code for each match
    const absPath = path.resolve(filePath);
    let fileLines = null;
    try { fileLines = fs.readFileSync(absPath, 'utf-8').split('\n'); } catch (e) { /* ignore */ }
    const enriched = matches.map(m => {
        const obj = { ...m, relativePath: filePath };
        if (fileLines && m.startLine && m.endLine) {
            obj.code = fileLines.slice(m.startLine - 1, m.endLine).join('\n');
        }
        return obj;
    });

    if (flags.json) {
        console.log(output.formatTypedefJson(enriched, name));
    } else {
        console.log(output.formatTypedef(enriched, name));
    }
}

function apiInFile(result, filePath) {
    const exported = [];

    for (const fn of result.functions) {
        if (fn.modifiers && (fn.modifiers.includes('export') || fn.modifiers.includes('public'))) {
            exported.push({
                name: fn.name,
                type: 'function',
                file: filePath,
                startLine: fn.startLine,
                endLine: fn.endLine,
                params: fn.params,
                returnType: fn.returnType,
                signature: output.formatFunctionSignature(fn)
            });
        }
    }

    for (const cls of result.classes) {
        if (cls.modifiers && (cls.modifiers.includes('export') || cls.modifiers.includes('public'))) {
            exported.push({
                name: cls.name,
                type: cls.type,
                file: filePath,
                startLine: cls.startLine,
                endLine: cls.endLine,
                signature: output.formatClassSignature(cls)
            });
        }
    }

    if (flags.json) {
        console.log(output.formatApiJson(exported, filePath));
    } else {
        console.log(output.formatApi(exported, filePath));
    }
}

// ============================================================================
// PROJECT MODE
// ============================================================================

function runProjectCommand(rootDir, command, arg) {
    const index = new ProjectIndex(rootDir);

    // Detect subdirectory scope: if rootDir resolves to a subdirectory of the project root,
    // use it as an implicit scope filter (e.g., "ucn src deadcode" → scope to src/)
    const resolvedTarget = path.resolve(rootDir);
    const subdirScope = resolvedTarget !== index.root && resolvedTarget.startsWith(index.root + path.sep)
        ? path.relative(index.root, resolvedTarget)
        : null;

    // Clear cache if requested
    if (flags.clearCache) {
        const cacheDir = path.join(index.root, '.ucn-cache');
        if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, { recursive: true, force: true });
            if (!flags.quiet) {
                console.error('Cache cleared');
            }
        }
    }

    // Try to load cache if enabled
    let usedCache = false;
    let cacheWasLoaded = false;
    if (flags.cache && !flags.clearCache) {
        const loaded = index.loadCache();
        if (loaded) {
            cacheWasLoaded = true;
            if (!index.isCacheStale()) {
                usedCache = true;
                if (!flags.quiet) {
                    console.error('Using cached index');
                }
            }
        }
    }

    // Build/rebuild if cache not used
    // If cache was loaded but stale, force rebuild to avoid duplicates
    if (!usedCache) {
        index.build(null, { quiet: flags.quiet, forceRebuild: cacheWasLoaded, followSymlinks: flags.followSymlinks });

        // Save cache if enabled
        if (flags.cache) {
            index.saveCache();
        }
    }

    try {
    // Resolve CLI aliases to canonical command names — dispatch on canonical
    const canonical = resolveCommand(command, 'cli') || command;

    switch (canonical) {
        // ── Commands using shared executor ───────────────────────────────

        case 'toc': {
            const { ok, result, error } = execute(index, 'toc', flags);
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result, output.formatTocJson, r => output.formatToc(r, {
                detailedHint: 'Add --detailed to list all functions, or "ucn . about <name>" for full details on a symbol',
                uncertainHint: 'use --include-uncertain to include all'
            }));
            break;
        }

        case 'find': {
            const { ok, result, error } = execute(index, 'find', { name: arg, ...flags });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result,
                r => output.formatSymbolJson(r, arg),
                r => { printSymbols(r, arg, { depth: flags.depth, top: flags.top, all: flags.all }); }
            );
            break;
        }

        case 'usages': {
            const { ok, result, error } = execute(index, 'usages', { name: arg, ...flags });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result,
                r => output.formatUsagesJson(r, arg),
                r => output.formatUsages(r, arg)
            );
            break;
        }

        case 'example': {
            const { ok, result, error } = execute(index, 'example', { name: arg });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result,
                r => output.formatExampleJson(r, arg),
                r => output.formatExample(r, arg)
            );
            break;
        }

        case 'context': {
            const { ok, result: ctx, error } = execute(index, 'context', { name: arg, ...flags });
            if (!ok) { console.error(error); process.exit(1); }
            if (flags.json) {
                console.log(output.formatContextJson(ctx));
            } else {
                const { text, expandable } = output.formatContext(ctx, {
                    methodsHint: 'Note: obj.method() calls excluded — use --include-methods to include them',
                    expandHint: 'Use "ucn . expand <N>" to see code for item N',
                    uncertainHint: 'use --include-uncertain to include all'
                });
                console.log(text);

                // Inline expansion of callees when --expand flag is set
                if (flags.expand && index.root && ctx.callees) {
                    for (const c of ctx.callees) {
                        if (c.relativePath && c.startLine) {
                            try {
                                const filePath = path.join(index.root, c.relativePath);
                                const content = fs.readFileSync(filePath, 'utf-8');
                                const codeLines = content.split('\n');
                                const endLine = c.endLine || c.startLine + 5;
                                const previewLines = Math.min(3, endLine - c.startLine + 1);
                                for (let i = 0; i < previewLines && c.startLine - 1 + i < codeLines.length; i++) {
                                    console.log(`      │ ${codeLines[c.startLine - 1 + i]}`);
                                }
                                if (endLine - c.startLine + 1 > 3) {
                                    console.log(`      │ ... (${endLine - c.startLine - 2} more lines)`);
                                }
                            } catch (e) {
                                // Skip on error
                            }
                        }
                    }
                }

                // Save expandable items to cache for 'expand' command
                saveExpandableItems(expandable, index.root);
            }
            break;
        }

        case 'expand': {
            requireArg(arg, 'Usage: ucn . expand <N>\nFirst run "ucn . context <name>" to get numbered items');
            const expandNum = parseInt(arg);
            if (isNaN(expandNum)) {
                console.error(`Invalid item number: "${arg}"`);
                process.exit(1);
            }
            const cached = loadExpandableItems(index.root);
            if (!cached || !cached.items || cached.items.length === 0) {
                console.error('No expandable items found. Run "ucn . context <name>" first.');
                process.exit(1);
            }
            const item = cached.items.find(i => i.num === expandNum);
            if (!item) {
                console.error(`Item ${expandNum} not found. Available: ${cached.items.map(i => i.num).join(', ')}`);
                process.exit(1);
            }
            printExpandedItem(item, cached.root || index.root);
            break;
        }

        case 'smart': {
            const { ok, result, error } = execute(index, 'smart', { name: arg, ...flags });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result, output.formatSmartJson, r => output.formatSmart(r, {
                uncertainHint: 'use --include-uncertain to include all'
            }));
            break;
        }

        case 'about': {
            const { ok, result, error } = execute(index, 'about', { name: arg, ...flags });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result,
                output.formatAboutJson,
                r => output.formatAbout(r, { expand: flags.expand, root: index.root, depth: flags.depth })
            );
            break;
        }

        case 'impact': {
            const { ok, result, error } = execute(index, 'impact', { name: arg, ...flags });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result, output.formatImpactJson, output.formatImpact);
            break;
        }

        case 'plan': {
            const { ok, result, error } = execute(index, 'plan', { name: arg, ...flags });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result, output.formatPlanJson, output.formatPlan);
            break;
        }

        case 'trace': {
            const { ok, result, error } = execute(index, 'trace', { name: arg, ...flags });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result, output.formatTraceJson, output.formatTrace);
            break;
        }

        case 'stacktrace': {
            const { ok, result, error } = execute(index, 'stacktrace', { stack: arg });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result, output.formatStackTraceJson, output.formatStackTrace);
            break;
        }

        case 'verify': {
            const { ok, result, error } = execute(index, 'verify', { name: arg, file: flags.file });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result, output.formatVerifyJson, output.formatVerify);
            break;
        }

        case 'related': {
            const { ok, result, error } = execute(index, 'related', { name: arg, ...flags });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result, output.formatRelatedJson, r => output.formatRelated(r, { showAll: flags.all, top: flags.top }));
            break;
        }

        // ── Commands staying in adapter (complex I/O) ───────────────────

        case 'fn': {
            requireArg(arg, 'Usage: ucn . fn <name>');
            if (arg.includes(',')) {
                const fnNames = arg.split(',').map(n => n.trim()).filter(Boolean);
                let anyNotFound = false;
                for (let i = 0; i < fnNames.length; i++) {
                    if (i > 0) console.log('\n' + '═'.repeat(60) + '\n');
                    if (extractFunctionFromProject(index, fnNames[i]) === false) anyNotFound = true;
                }
                if (anyNotFound) process.exit(1);
            } else {
                if (extractFunctionFromProject(index, arg) === false) process.exit(1);
            }
            break;
        }

        case 'class': {
            requireArg(arg, 'Usage: ucn . class <name>');
            if (extractClassFromProject(index, arg) === false) process.exit(1);
            break;
        }

        case 'lines': {
            if (!arg || !flags.file) {
                console.error('Usage: ucn . lines <range> --file <path>');
                process.exit(1);
            }
            const filePath = index.findFile(flags.file);
            if (!filePath) {
                console.error(`File not found: ${flags.file}`);
                process.exit(1);
            }
            const fileContent = fs.readFileSync(filePath, 'utf-8');
            printLines(fileContent.split('\n'), arg);
            break;
        }

        // ── File dependency commands ────────────────────────────────────

        case 'imports': {
            const { ok, result, error } = execute(index, 'imports', { file: arg });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result,
                r => output.formatImportsJson(r, arg),
                r => output.formatImports(r, arg)
            );
            break;
        }

        case 'exporters': {
            const { ok, result, error } = execute(index, 'exporters', { file: arg });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result,
                r => output.formatExportersJson(r, arg),
                r => output.formatExporters(r, arg)
            );
            break;
        }

        case 'fileExports': {
            const { ok, result, error } = execute(index, 'fileExports', { file: arg });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result,
                r => JSON.stringify({ file: arg, exports: r }, null, 2),
                r => output.formatFileExports(r, arg)
            );
            break;
        }

        case 'graph': {
            const { ok, result, error } = execute(index, 'graph', { file: arg, direction: flags.direction, depth: flags.depth, all: flags.all });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result,
                r => JSON.stringify({
                    root: path.relative(index.root, r.root),
                    nodes: r.nodes.map(n => ({ file: n.relativePath, depth: n.depth })),
                    edges: r.edges.map(e => ({ from: path.relative(index.root, e.from), to: path.relative(index.root, e.to) }))
                }, null, 2),
                r => output.formatGraph(r, { showAll: flags.all || flags.depth != null, maxDepth: flags.depth != null ? parseInt(flags.depth, 10) : 2, file: arg })
            );
            break;
        }

        // ── Remaining commands ──────────────────────────────────────────

        case 'typedef': {
            const { ok, result, error } = execute(index, 'typedef', { name: arg, exact: flags.exact });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result,
                r => output.formatTypedefJson(r, arg),
                r => output.formatTypedef(r, arg)
            );
            break;
        }

        case 'tests': {
            const { ok, result, error } = execute(index, 'tests', { name: arg, callsOnly: flags.callsOnly });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result,
                r => output.formatTestsJson(r, arg),
                r => output.formatTests(r, arg)
            );
            break;
        }

        case 'api': {
            const { ok, result, error } = execute(index, 'api', { file: arg });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result,
                r => output.formatApiJson(r, arg),
                r => output.formatApi(r, arg)
            );
            break;
        }

        case 'search': {
            const { ok, result, error } = execute(index, 'search', { term: arg, ...flags });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result,
                r => output.formatSearchJson(r, arg),
                r => output.formatSearch(r, arg)
            );
            break;
        }

        case 'deadcode': {
            const { ok, result, error } = execute(index, 'deadcode', { ...flags, in: flags.in || subdirScope });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result,
                output.formatDeadcodeJson,
                r => output.formatDeadcode(r, {
                    top: flags.top,
                    decoratedHint: !flags.includeDecorated && result.excludedDecorated > 0 ? `${result.excludedDecorated} decorated/annotated symbol(s) hidden (framework-registered). Use --include-decorated to include them.` : undefined,
                    exportedHint: !flags.includeExported && result.excludedExported > 0 ? `${result.excludedExported} exported symbol(s) excluded (all have callers). Use --include-exported to audit them.` : undefined
                })
            );
            break;
        }

        case 'stats': {
            const { ok, result, error } = execute(index, 'stats', { functions: flags.functions });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result,
                output.formatStatsJson,
                r => output.formatStats(r, { top: flags.top })
            );
            break;
        }

        case 'diffImpact': {
            const { ok, result, error } = execute(index, 'diffImpact', { base: flags.base, staged: flags.staged, file: flags.file });
            if (!ok) { console.error(error); process.exit(1); }
            printOutput(result, output.formatDiffImpactJson, output.formatDiffImpact);
            break;
        }

        default:
            console.error(`Unknown command: ${canonical}`);
            printUsage();
            process.exit(1);
    }
    } catch (e) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    }
}

function extractFunctionFromProject(index, name, overrideFlags) {
    const f = overrideFlags || flags;
    const matches = index.find(name, { file: f.file }).filter(m => m.type === 'function' || m.params !== undefined);

    if (matches.length === 0) {
        console.error(`Function "${name}" not found`);
        return false;
    }

    if (matches.length > 1 && !f.file && f.all) {
        // Show all definitions
        for (let i = 0; i < matches.length; i++) {
            const m = matches[i];
            const code = fs.readFileSync(m.file, 'utf-8');
            const lines = code.split('\n');
            const extracted = lines.slice(m.startLine - 1, m.endLine);
            const fnCode = cleanHtmlScriptTags(extracted, detectLanguage(m.file)).join('\n');
            if (i > 0) console.log('');
            if (f.json) {
                console.log(output.formatFunctionJson(m, fnCode));
            } else {
                console.log(output.formatFn(m, fnCode));
            }
        }
        return;
    }

    let match;
    if (matches.length > 1 && !f.file) {
        // Auto-select best match using same scoring as resolveSymbol
        match = pickBestDefinition(matches);
        const others = matches.filter(m => m !== match).map(m => `${m.relativePath}:${m.startLine}`).join(', ');
        console.error(`Note: Found ${matches.length} definitions for "${name}". Using ${match.relativePath}:${match.startLine}. Also in: ${others}. Use --file to disambiguate or --all to show all.`);
    } else {
        match = matches[0];
    }

    // Extract code directly using symbol index location (works for class methods and overloads)
    const code = fs.readFileSync(match.file, 'utf-8');
    const lines = code.split('\n');
    const extracted = lines.slice(match.startLine - 1, match.endLine);
    const fnCode = cleanHtmlScriptTags(extracted, detectLanguage(match.file)).join('\n');

    if (f.json) {
        console.log(output.formatFunctionJson(match, fnCode));
    } else {
        console.log(output.formatFn(match, fnCode));
    }
}

function extractClassFromProject(index, name, overrideFlags) {
    const f = overrideFlags || flags;
    const matches = index.find(name, { file: f.file }).filter(m =>
        ['class', 'interface', 'type', 'enum', 'struct', 'trait'].includes(m.type)
    );

    if (matches.length === 0) {
        console.error(`Class "${name}" not found`);
        return false;
    }

    if (matches.length > 1 && !f.file && f.all) {
        // Show all definitions using index data (no re-parsing)
        for (let i = 0; i < matches.length; i++) {
            const m = matches[i];
            const code = fs.readFileSync(m.file, 'utf-8');
            const codeLines = code.split('\n');
            const extracted = codeLines.slice(m.startLine - 1, m.endLine);
            const clsCode = cleanHtmlScriptTags(extracted, detectLanguage(m.file)).join('\n');
            if (i > 0) console.log('');
            if (f.json) {
                console.log(JSON.stringify({ ...m, code: clsCode }, null, 2));
            } else {
                console.log(output.formatClass(m, clsCode));
            }
        }
        return;
    }

    let match;
    if (matches.length > 1 && !f.file) {
        // Auto-select best match using same scoring as resolveSymbol
        match = pickBestDefinition(matches);
        const others = matches.filter(m => m !== match).map(m => `${m.relativePath}:${m.startLine}`).join(', ');
        console.error(`Note: Found ${matches.length} definitions for "${name}". Using ${match.relativePath}:${match.startLine}. Also in: ${others}. Use --file to disambiguate or --all to show all.`);
    } else {
        match = matches[0];
    }

    // Use index data directly instead of re-parsing the file
    const code = fs.readFileSync(match.file, 'utf-8');
    const codeLines = code.split('\n');
    const classLineCount = match.endLine - match.startLine + 1;

    // Large class summary (>200 lines) when no --max-lines specified
    if (classLineCount > 200 && !f.maxLines) {
        if (f.json) {
            const extracted = codeLines.slice(match.startLine - 1, match.endLine);
            const clsCode = cleanHtmlScriptTags(extracted, detectLanguage(match.file)).join('\n');
            console.log(JSON.stringify({ ...match, code: clsCode }, null, 2));
        } else {
            const lines = [];
            lines.push(`${match.relativePath}:${match.startLine}`);
            lines.push(`${output.lineRange(match.startLine, match.endLine)} ${output.formatClassSignature(match)}`);
            lines.push('\u2500'.repeat(60));
            const methods = index.findMethodsForType(match.name);
            if (methods.length > 0) {
                lines.push(`\nMethods (${methods.length}):`);
                for (const m of methods) {
                    lines.push(`  ${output.formatFunctionSignature(m)}  [line ${m.startLine}]`);
                }
            }
            lines.push(`\nClass is ${classLineCount} lines. Use --max-lines=N to see source, or "fn <method>" for individual methods.`);
            console.log(lines.join('\n'));
        }
        return;
    }

    // Truncated source with --max-lines
    if (f.maxLines && classLineCount > f.maxLines) {
        const truncated = codeLines.slice(match.startLine - 1, match.startLine - 1 + f.maxLines);
        const truncatedCode = cleanHtmlScriptTags(truncated, detectLanguage(match.file)).join('\n');
        if (f.json) {
            console.log(JSON.stringify({ ...match, code: truncatedCode, truncated: true, totalLines: classLineCount }, null, 2));
        } else {
            console.log(output.formatClass(match, truncatedCode));
            console.log(`\n... showing ${f.maxLines} of ${classLineCount} lines`);
        }
        return;
    }

    const extracted = codeLines.slice(match.startLine - 1, match.endLine);
    const clsCode = cleanHtmlScriptTags(extracted, detectLanguage(match.file)).join('\n');

    if (f.json) {
        console.log(JSON.stringify({ ...match, code: clsCode }, null, 2));
    } else {
        console.log(output.formatClass(match, clsCode));
    }
}


function printSymbols(symbols, query, options = {}) {
    const { depth, top, all } = options;
    const DEFAULT_LIMIT = 5;

    if (symbols.length === 0) {
        console.log(`No symbols found for "${query}"`);
        return;
    }

    // Determine how many to show
    const limit = all ? symbols.length : (top > 0 ? top : DEFAULT_LIMIT);
    const showing = Math.min(limit, symbols.length);
    const hidden = symbols.length - showing;

    if (hidden > 0) {
        console.log(`Found ${symbols.length} match(es) for "${query}" (showing top ${showing}):`);
    } else {
        console.log(`Found ${symbols.length} match(es) for "${query}":`);
    }
    console.log('─'.repeat(60));

    for (let i = 0; i < showing; i++) {
        const s = symbols[i];
        // Depth 0: just location
        if (depth === '0') {
            console.log(`${s.relativePath}:${s.startLine}`);
            continue;
        }

        // Depth 1 (default): location + signature
        const sig = s.params !== undefined
            ? output.formatFunctionSignature(s)
            : output.formatClassSignature(s);

        // Compute and display confidence indicator
        const confidence = computeConfidence(s);
        const confStr = confidence.level !== 'high' ? ` [${confidence.level}]` : '';

        console.log(`${s.relativePath}:${s.startLine}  ${sig}${confStr}`);
        if (s.usageCounts !== undefined) {
            const c = s.usageCounts;
            const parts = [];
            if (c.calls > 0) parts.push(`${c.calls} calls`);
            if (c.definitions > 0) parts.push(`${c.definitions} def`);
            if (c.imports > 0) parts.push(`${c.imports} imports`);
            if (c.references > 0) parts.push(`${c.references} refs`);
            console.log(`  (${c.total} usages: ${parts.join(', ')})`);
        } else if (s.usageCount !== undefined) {
            console.log(`  (${s.usageCount} usages)`);
        }

        // Show confidence reason if not high
        if (confidence.level !== 'high' && confidence.reasons.length > 0) {
            console.log(`  ⚠ ${confidence.reasons.join(', ')}`);
        }

        // Depth 2: + first 10 lines of code
        if (depth === '2' || depth === 'full') {
            try {
                const content = fs.readFileSync(s.file, 'utf-8');
                const lines = content.split('\n');
                const maxLines = depth === 'full' ? (s.endLine - s.startLine + 1) : 10;
                const endLine = Math.min(s.startLine + maxLines - 1, s.endLine);
                console.log('  ───');
                for (let i = s.startLine - 1; i < endLine; i++) {
                    console.log(`  ${lines[i]}`);
                }
                if (depth === '2' && s.endLine > endLine) {
                    console.log(`  ... (${s.endLine - endLine} more lines)`);
                }
            } catch (e) {
                // Skip code extraction on error
            }
        }
        console.log('');
    }

    // Show hint about hidden results
    if (hidden > 0) {
        console.log(`... ${hidden} more result(s). Use --all to see all, or --top=N to see more.`);
    }
}

/**
 * Compute confidence level for a symbol match
 * @returns {{ level: 'high'|'medium'|'low', reasons: string[] }}
 */
function computeConfidence(symbol) {
    const reasons = [];
    let score = 100;

    // Check function span (very long functions may have incorrect boundaries)
    const span = (symbol.endLine || symbol.startLine) - symbol.startLine;
    if (span > 500) {
        score -= 30;
        reasons.push('very long function (>500 lines)');
    } else if (span > 200) {
        score -= 15;
        reasons.push('long function (>200 lines)');
    }

    // Check for complex type annotations (nested generics)
    const params = Array.isArray(symbol.params) ? symbol.params : [];
    const signature = params.map(p => p.type || '').join(' ') + (symbol.returnType || '');
    const genericDepth = countNestedGenerics(signature);
    if (genericDepth > 3) {
        score -= 20;
        reasons.push('complex nested generics');
    } else if (genericDepth > 2) {
        score -= 10;
        reasons.push('nested generics');
    }

    // Check file size by checking if file property exists and getting line count
    if (symbol.file) {
        try {
            const stats = fs.statSync(symbol.file);
            const sizeKB = stats.size / 1024;
            if (sizeKB > 500) {
                score -= 20;
                reasons.push('very large file (>500KB)');
            } else if (sizeKB > 200) {
                score -= 10;
                reasons.push('large file (>200KB)');
            }
        } catch (e) {
            // Skip file size check on error
        }
    }

    // Determine level
    let level = 'high';
    if (score < 50) level = 'low';
    else if (score < 80) level = 'medium';

    return { level, reasons };
}

/**
 * Count depth of nested generic brackets
 */
function countNestedGenerics(str) {
    let maxDepth = 0;
    let depth = 0;
    for (const char of str) {
        if (char === '<') {
            depth++;
            maxDepth = Math.max(maxDepth, depth);
        } else if (char === '>') {
            depth--;
        }
    }
    return maxDepth;
}


/**
 * Save expandable items to cache file
 */
function saveExpandableItems(items, root) {
    try {
        const cacheDir = path.join(root || '.', '.ucn-cache');
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        fs.writeFileSync(
            path.join(cacheDir, 'expandable.json'),
            JSON.stringify({ items, root, timestamp: Date.now() }, null, 2)
        );
    } catch (e) {
        // Silently fail - expand feature is optional
    }
}

/**
 * Load expandable items from cache
 */
function loadExpandableItems(root) {
    try {
        const cachePath = path.join(root || '.', '.ucn-cache', 'expandable.json');
        if (fs.existsSync(cachePath)) {
            return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        }
    } catch (e) {
        // Return null on error
    }
    return null;
}

/**
 * Print expanded code for a cached item
 */
function printExpandedItem(item, root) {
    const filePath = item.file || (root && item.relativePath ? path.join(root, item.relativePath) : null);
    if (!filePath) {
        console.error(`Cannot locate file for ${item.name}`);
        return;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const startLine = item.startLine || item.line || 1;
        const endLine = item.endLine || startLine + 20;

        console.log(`[${item.num}] ${item.name} (${item.type})`);
        console.log(`${item.relativePath}:${startLine}-${endLine}`);
        console.log('═'.repeat(60));

        for (let i = startLine - 1; i < Math.min(endLine, lines.length); i++) {
            console.log(lines[i]);
        }
    } catch (e) {
        console.error(`Error reading ${filePath}: ${e.message}`);
    }
}




// ============================================================================
// GLOB MODE
// ============================================================================

function runGlobCommand(pattern, command, arg) {
    const files = expandGlob(pattern);

    if (files.length === 0) {
        console.error(`No files match pattern: ${pattern}`);
        process.exit(1);
    }

    switch (command) {
        case 'toc':
            let totalFunctions = 0;
            let totalClasses = 0;
            let totalState = 0;
            let totalLines = 0;
            const byFile = [];

            for (const file of files) {
                try {
                    const result = parseFile(file);
                    let functions = result.functions;
                    if (flags.topLevel) {
                        functions = functions.filter(fn => !fn.isNested && (!fn.indent || fn.indent === 0));
                    }
                    totalFunctions += functions.length;
                    totalClasses += result.classes.length;
                    totalState += result.stateObjects.length;
                    totalLines += result.totalLines;
                    byFile.push({
                        file,
                        language: result.language,
                        lines: result.totalLines,
                        functions,
                        classes: result.classes,
                        state: result.stateObjects
                    });
                } catch (e) {
                    // Skip unparseable files
                }
            }

            // Convert glob toc to shared formatter format
            const toc = {
                totals: { files: files.length, lines: totalLines, functions: totalFunctions, classes: totalClasses, state: totalState },
                files: byFile.map(f => ({
                    file: f.file,
                    lines: f.lines,
                    functions: f.functions.length,
                    classes: f.classes.length,
                    state: f.stateObjects ? f.stateObjects.length : (f.state ? f.state.length : 0)
                })),
                meta: {}
            };
            if (flags.json) {
                console.log(output.formatTocJson(toc));
            } else {
                console.log(output.formatToc(toc, {
                    detailedHint: 'Add --detailed to list all functions, or "ucn . about <name>" for full details on a symbol'
                }));
            }
            break;

        case 'find':
            if (!arg) {
                console.error('Usage: ucn "pattern" find <name>');
                process.exit(1);
            }
            findInGlobFiles(files, arg);
            break;

        case 'search':
            if (!arg) {
                console.error('Usage: ucn "pattern" search <term>');
                process.exit(1);
            }
            searchGlobFiles(files, arg);
            break;

        default:
            console.error(`Command "${command}" not supported in glob mode`);
            process.exit(1);
    }
}

function findInGlobFiles(files, name) {
    const allMatches = [];
    const lowerName = name.toLowerCase();

    for (const file of files) {
        try {
            const result = parseFile(file);

            for (const fn of result.functions) {
                if (flags.exact ? fn.name === name : fn.name.toLowerCase().includes(lowerName)) {
                    allMatches.push({ ...fn, type: 'function', relativePath: file });
                }
            }

            for (const cls of result.classes) {
                if (flags.exact ? cls.name === name : cls.name.toLowerCase().includes(lowerName)) {
                    allMatches.push({ ...cls, relativePath: file });
                }
            }
        } catch (e) {
            // Skip
        }
    }

    if (flags.json) {
        console.log(output.formatSymbolJson(allMatches, name));
    } else {
        printSymbols(allMatches, name, { depth: flags.depth, top: flags.top, all: flags.all });
    }
}

function searchGlobFiles(files, term) {
    const results = [];
    const useRegex = flags.regex !== false; // Default: regex ON
    let regex;
    if (useRegex) {
        try { regex = new RegExp(term, flags.caseSensitive ? '' : 'i'); } catch (e) { regex = new RegExp(escapeRegExp(term), flags.caseSensitive ? '' : 'i'); }
    } else {
        regex = new RegExp(escapeRegExp(term), flags.caseSensitive ? '' : 'i');
    }

    for (const file of files) {
        try {
            const content = fs.readFileSync(file, 'utf-8');
            const lines = content.split('\n');
            const matches = [];

            lines.forEach((line, idx) => {
                if (regex.test(line)) {
                    if (flags.codeOnly && isCommentOrString(line)) {
                        return;
                    }

                    const match = { line: idx + 1, content: line };

                    if (flags.context > 0) {
                        const before = [];
                        const after = [];
                        for (let i = 1; i <= flags.context; i++) {
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
                results.push({ file, matches });
            }
        } catch (e) {
            // Skip
        }
    }

    if (flags.json) {
        console.log(output.formatSearchJson(results, term));
    } else {
        console.log(output.formatSearch(results, term));
    }
}

// ============================================================================
// HELPERS
// ============================================================================

function searchFile(filePath, lines, term) {
    const useRegex = flags.regex !== false;
    let regex;
    if (useRegex) {
        try { regex = new RegExp(term, flags.caseSensitive ? '' : 'i'); } catch (e) { regex = new RegExp(escapeRegExp(term), flags.caseSensitive ? '' : 'i'); }
    } else {
        regex = new RegExp(escapeRegExp(term), flags.caseSensitive ? '' : 'i');
    }
    const matches = [];

    lines.forEach((line, idx) => {
        if (regex.test(line)) {
            if (flags.codeOnly && isCommentOrString(line)) {
                return;
            }

            const match = { line: idx + 1, content: line };

            if (flags.context > 0) {
                const before = [];
                const after = [];
                for (let i = 1; i <= flags.context; i++) {
                    if (idx - i >= 0) before.unshift(lines[idx - i]);
                    if (idx + i < lines.length) after.push(lines[idx + i]);
                }
                match.before = before;
                match.after = after;
            }

            matches.push(match);
        }
    });

    if (flags.json) {
        console.log(output.formatSearchJson([{ file: filePath, matches }], term));
    } else {
        console.log(`Found ${matches.length} matches for "${term}" in ${filePath}:`);
        for (const m of matches) {
            if (m.before && m.before.length > 0) {
                for (const line of m.before) {
                    console.log(`      ... ${line.trim()}`);
                }
            }
            console.log(`  ${m.line}: ${m.content.trim()}`);
            if (m.after && m.after.length > 0) {
                for (const line of m.after) {
                    console.log(`      ... ${line.trim()}`);
                }
            }
        }
    }
}

function printLines(lines, range) {
    const parts = range.split('-');
    const start = parseInt(parts[0], 10);
    const end = parts.length > 1 ? parseInt(parts[1], 10) : start;

    // Validate input
    if (isNaN(start) || isNaN(end)) {
        console.error(`Invalid line range: "${range}". Expected format: <start>-<end> or <line>`);
        process.exit(1);
    }

    if (start < 1 || end < 1) {
        console.error(`Invalid line range: line numbers must be >= 1`);
        process.exit(1);
    }

    // Handle reversed range by swapping
    const startLine = Math.min(start, end);
    const endLine = Math.max(start, end);

    // Check for out-of-bounds
    if (startLine > lines.length) {
        console.error(`Line ${startLine} is out of bounds. File has ${lines.length} lines.`);
        process.exit(1);
    }

    // Print lines (clamping end to file length)
    const actualEnd = Math.min(endLine, lines.length);
    for (let i = startLine - 1; i < actualEnd; i++) {
        console.log(`${output.lineNum(i + 1)} │ ${lines[i]}`);
    }
}

function suggestSimilar(query, names) {
    const lower = query.toLowerCase();
    const similar = names.filter(n => n.toLowerCase().includes(lower));
    if (similar.length > 0) {
        console.log('\nDid you mean:');
        for (const s of similar.slice(0, 5)) {
            console.log(`  - ${s}`);
        }
    }
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isCommentOrString(line) {
    const trimmed = line.trim();
    return trimmed.startsWith('//') ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*');
}

function printUsage() {
    console.log(`UCN - Universal Code Navigator

Supported: JavaScript, TypeScript, Python, Go, Rust, Java, HTML

Usage:
  ucn [command] [args]            Project mode (current directory)
  ucn <file> [command] [args]     Single file mode
  ucn <dir> [command] [args]      Project mode (specific directory)
  ucn "pattern" [command] [args]  Glob pattern mode
  (Default output is text; add --json for machine-readable JSON)

═══════════════════════════════════════════════════════════════════════════════
UNDERSTAND CODE (UCN's strength - semantic analysis)
═══════════════════════════════════════════════════════════════════════════════
  about <name>        RECOMMENDED: Full picture (definition, callers, callees, tests, code)
  context <name>      Who calls this + what it calls (numbered for expand)
  smart <name>        Function + all dependencies inline
  impact <name>       What breaks if changed (call sites grouped by file)
  trace <name>        Call tree visualization (--depth=N expands all children)
  related <name>      Find similar functions (same file, shared deps)
  example <name>      Best usage example with context

═══════════════════════════════════════════════════════════════════════════════
FIND CODE
═══════════════════════════════════════════════════════════════════════════════
  find <name>         Find symbol definitions (supports glob: find "handle*")
  usages <name>       All usages grouped: definitions, calls, imports, references
  toc                 Table of contents (compact; --detailed lists all symbols)
  search <term>       Text search (regex default, --context=N, --exclude=, --in=)
  tests <name>        Find test files for a function

═══════════════════════════════════════════════════════════════════════════════
EXTRACT CODE
═══════════════════════════════════════════════════════════════════════════════
  fn <name>[,n2,...]  Extract function(s) (comma-separated for bulk, --file)
  class <name>        Extract class
  lines <range>       Extract line range (e.g., lines 50-100)
  expand <N>          Show code for item N from context output

═══════════════════════════════════════════════════════════════════════════════
FILE DEPENDENCIES
═══════════════════════════════════════════════════════════════════════════════
  imports <file>      What does file import
  exporters <file>    Who imports this file
  file-exports <file> What does file export
  graph <file>        Full dependency tree (--depth=N, --direction=imports|importers|both)

═══════════════════════════════════════════════════════════════════════════════
REFACTORING HELPERS
═══════════════════════════════════════════════════════════════════════════════
  plan <name>         Preview refactoring (--add-param, --remove-param, --rename-to)
  verify <name>       Check all call sites match signature
  diff-impact         What changed in git diff and who calls it (--base, --staged)
  deadcode            Find unused functions/classes

═══════════════════════════════════════════════════════════════════════════════
OTHER
═══════════════════════════════════════════════════════════════════════════════
  api                 Show exported/public symbols
  typedef <name>      Find type definitions
  stats               Project statistics (--functions for per-function line counts)
  stacktrace <text>   Parse stack trace, show code at each frame (alias: stack)

Common Flags:
  --file <pattern>    Filter by file path (e.g., --file=routes)
  --exclude=a,b       Exclude patterns (e.g., --exclude=test,mock)
  --in=<path>         Only in path (e.g., --in=src/core)
  --depth=N           Trace/graph depth (default: 3, also expands all children)
  --direction=X       Graph direction: imports, importers, or both (default: both)
  --all               Expand truncated sections (about, trace, graph, related)
  --top=N             Limit results (find, deadcode)
  --context=N         Lines of context around matches
  --json              Machine-readable output
  --code-only         Filter out comments and strings
  --with-types        Include type definitions
  --include-tests     Include test files
  --include-methods   Include method calls (obj.fn) in caller/callee analysis
  --include-uncertain Include ambiguous/uncertain matches
  --include-exported  Include exported symbols in deadcode
  --no-regex          Force plain text search (regex is default)
  --functions         Show per-function line counts (stats command)
  --include-decorated Include decorated/annotated symbols in deadcode
  --exact             Exact name match only (find)
  --calls-only        Only show call/test-case matches (tests)
  --case-sensitive    Case-sensitive text search (search)
  --detailed          List all symbols in toc (compact by default)
  --top-level         Show only top-level functions in toc
  --max-lines=N       Max source lines for class (large classes show summary)
  --no-cache          Disable caching
  --clear-cache       Clear cache before running
  --base=<ref>        Git ref for diff-impact (default: HEAD)
  --staged            Analyze staged changes (diff-impact)
  --no-follow-symlinks  Don't follow symbolic links
  -i, --interactive   Keep index in memory for multiple queries

Quick Start:
  ucn toc                             # See project structure
  ucn about handleRequest             # Understand a function
  ucn impact handleRequest            # Before modifying
  ucn fn handleRequest --file api     # Extract specific function
  ucn --interactive                   # Multiple queries`);
}

// ============================================================================
// INTERACTIVE MODE
// ============================================================================

function runInteractive(rootDir) {
    const readline = require('readline');
    // ProjectIndex already required at top of file

    console.log('Building index...');
    const index = new ProjectIndex(rootDir);
    index.build(null, { quiet: true });
    const iExpandCache = new ExpandCache({ maxSize: 20 });
    console.log(`Index ready: ${index.files.size} files, ${index.symbols.size} symbols`);
    console.log('Type commands (e.g., "find parseFile", "about main", "toc")');
    console.log('Type "help" for commands, "quit" to exit\n');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'ucn> '
    });

    rl.prompt();

    rl.on('line', (line) => {
        const input = line.trim();
        if (!input) {
            rl.prompt();
            return;
        }

        if (input === 'quit' || input === 'exit' || input === 'q') {
            console.log('Goodbye!');
            rl.close();
            process.exit(0);
        }

        if (input === 'help') {
            console.log(`
Commands:
  toc                    Project overview (--detailed)
  find <name>            Find symbol (--exact, glob: "handle*")
  about <name>           Everything about a symbol
  usages <name>          All usages grouped by type
  context <name>         Callers + callees
  expand <N>             Show code for item N from context
  smart <name>           Function + dependencies
  impact <name>          What breaks if changed
  trace <name>           Call tree (--depth=N)
  example <name>         Best usage example
  related <name>         Sibling functions
  fn <name>[,n2,...]     Extract function(s) (--file=)
  class <name>           Extract class code (--file=)
  lines <range>          Extract lines (--file= required)
  graph <file>           File dependency tree (--direction=, --depth=)
  file-exports <file>    File's exported symbols
  imports <file>         What file imports
  exporters <file>       Who imports file
  tests <name>           Find tests (--calls-only)
  search <term>          Text search (--context=N, --exclude=, --in=)
  typedef <name>         Find type definitions
  deadcode               Find unused functions/classes
  verify <name>          Check call sites match signature
  plan <name>            Preview refactoring (--add-param=, --remove-param=, --rename-to=)
  stacktrace <text>      Parse a stack trace
  api                    Show public symbols
  diff-impact            What changed and who's affected
  stats                  Index statistics
  rebuild                Rebuild index
  quit                   Exit

Flags can be added per-command: context myFunc --include-methods
`);
            rl.prompt();
            return;
        }

        if (input === 'rebuild') {
            console.log('Rebuilding index...');
            index.build(null, { quiet: true, forceRebuild: true });
            console.log(`Index ready: ${index.files.size} files, ${index.symbols.size} symbols`);
            rl.prompt();
            return;
        }

        // Parse command, flags, and arg from interactive input
        const tokens = input.split(/\s+/);
        const command = tokens[0];
        // Flags that take a space-separated value (--flag value)
        const valueFlagNames = new Set(['--file', '--in', '--base', '--add-param', '--remove-param', '--rename-to', '--default', '--depth', '--top', '--context', '--max-lines', '--direction', '--exclude', '--not', '--stack']);
        const flagTokens = [];
        const argTokens = [];
        const skipNext = new Set();
        for (let i = 1; i < tokens.length; i++) {
            if (skipNext.has(i)) { continue; }
            if (tokens[i].startsWith('--')) {
                flagTokens.push(tokens[i]);
                // If it's a value-flag without = and next token exists and isn't a flag, consume it too
                if (valueFlagNames.has(tokens[i]) && !tokens[i].includes('=') && i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
                    flagTokens.push(tokens[i + 1]);
                    skipNext.add(i + 1);
                }
            } else {
                argTokens.push(tokens[i]);
            }
        }
        const arg = argTokens.join(' ');
        const iflags = parseInteractiveFlags(flagTokens);

        try {
            const iCanonical = resolveCommand(command, 'cli') || command;
            executeInteractiveCommand(index, iCanonical, arg, iflags, iExpandCache);
        } catch (e) {
            console.error(`Error: ${e.message}`);
        }

        rl.prompt();
    });

    rl.on('close', () => {
        process.exit(0);
    });
}

/**
 * Parse flags from interactive command tokens.
 * Returns a flags object similar to the global flags but scoped to this command.
 */
function parseInteractiveFlags(tokens) {
    // Helper: get value for a flag that supports both --flag=value and --flag value forms
    function getValueFlag(flagName) {
        const eqForm = tokens.find(a => a.startsWith(flagName + '='));
        if (eqForm) return eqForm.split('=').slice(1).join('=');
        const idx = tokens.indexOf(flagName);
        if (idx !== -1 && idx + 1 < tokens.length && !tokens[idx + 1].startsWith('-')) {
            return tokens[idx + 1];
        }
        return null;
    }
    return {
        file: getValueFlag('--file'),
        exclude: (() => {
            const result = [];
            // Handle --exclude=val and --not=val (equals form)
            for (const a of tokens) {
                if (a.startsWith('--exclude=') || a.startsWith('--not=')) {
                    result.push(...a.split('=').slice(1).join('=').split(','));
                }
            }
            // Handle --exclude val and --not val (space form)
            for (const flag of ['--exclude', '--not']) {
                const idx = tokens.indexOf(flag);
                if (idx !== -1 && idx + 1 < tokens.length && !tokens[idx + 1].startsWith('-')) {
                    result.push(...tokens[idx + 1].split(','));
                }
            }
            return result;
        })(),
        in: getValueFlag('--in'),
        includeTests: tokens.includes('--include-tests'),
        includeExported: tokens.includes('--include-exported'),
        includeDecorated: tokens.includes('--include-decorated'),
        includeUncertain: tokens.includes('--include-uncertain'),
        includeMethods: tokens.some(a => a === '--include-methods=false') ? false : tokens.some(a => a === '--include-methods' || (a.startsWith('--include-methods=') && a !== '--include-methods=false')) ? true : undefined,
        detailed: tokens.includes('--detailed'),
        topLevel: tokens.includes('--top-level'),
        all: tokens.includes('--all'),
        exact: tokens.includes('--exact'),
        callsOnly: tokens.includes('--calls-only'),
        codeOnly: tokens.includes('--code-only'),
        caseSensitive: tokens.includes('--case-sensitive'),
        withTypes: tokens.includes('--with-types'),
        expand: tokens.includes('--expand'),
        depth: getValueFlag('--depth'),
        top: parseInt(getValueFlag('--top') || '0'),
        context: parseInt(getValueFlag('--context') || '0'),
        direction: getValueFlag('--direction'),
        addParam: getValueFlag('--add-param'),
        removeParam: getValueFlag('--remove-param'),
        renameTo: getValueFlag('--rename-to'),
        defaultValue: getValueFlag('--default'),
        base: getValueFlag('--base'),
        staged: tokens.includes('--staged'),
        maxLines: parseInt(getValueFlag('--max-lines') || '0') || null,
        regex: tokens.includes('--no-regex') ? false : undefined,
        functions: tokens.includes('--functions'),
    };
}

function executeInteractiveCommand(index, command, arg, iflags = {}, cache = null) {
    switch (command) {

        // ── Special commands (complex I/O, stay in adapter) ──────────────

        case 'fn': {
            if (!arg) {
                console.log('Usage: fn <name>[,name2,...] [--file=<pattern>]');
                return;
            }
            // Support comma-separated names for bulk extraction
            if (arg.includes(',')) {
                const fnNames = arg.split(',').map(n => n.trim()).filter(Boolean);
                for (let i = 0; i < fnNames.length; i++) {
                    if (i > 0) console.log('\n' + '═'.repeat(60) + '\n');
                    extractFunctionFromProject(index, fnNames[i], iflags);
                }
            } else {
                extractFunctionFromProject(index, arg, iflags);
            }
            break;
        }

        case 'class': {
            if (!arg) {
                console.log('Usage: class <name> [--file=<pattern>]');
                return;
            }
            extractClassFromProject(index, arg, iflags);
            break;
        }

        case 'lines': {
            if (!arg || !iflags.file) {
                console.log('Usage: lines <range> --file=<file>');
                return;
            }
            const filePath = index.findFile(iflags.file);
            if (!filePath) {
                console.log(`File not found: ${iflags.file}`);
                return;
            }
            const fileContent = fs.readFileSync(filePath, 'utf-8');
            printLines(fileContent.split('\n'), arg);
            break;
        }

        case 'expand': {
            if (!arg) {
                console.log('Usage: expand <number>');
                return;
            }
            const expandNum = parseInt(arg, 10);
            if (isNaN(expandNum)) {
                console.log(`Invalid item number: "${arg}"`);
                return;
            }
            if (cache) {
                const { match, itemCount } = cache.lookup(index.root, expandNum);
                if (!match && itemCount === 0) {
                    console.log('No expandable items. Run context first.');
                    return;
                }
                if (!match) {
                    console.log(`Item ${expandNum} not found. Available: 1-${itemCount}`);
                    return;
                }
                const rendered = renderExpandItem(match, index.root);
                if (!rendered.ok) { console.log(rendered.error); return; }
                console.log(rendered.text);
            } else {
                // Fallback to file-based cache (CLI one-shot)
                const cached = loadExpandableItems(index.root);
                if (!cached || !cached.items || cached.items.length === 0) {
                    console.log('No expandable items. Run context first.');
                    return;
                }
                const expandMatch = cached.items.find(i => i.num === expandNum);
                if (!expandMatch) {
                    console.log(`Item ${expandNum} not found. Available: 1-${cached.items.length}`);
                    return;
                }
                printExpandedItem(expandMatch, cached.root || index.root);
            }
            break;
        }

        // ── find: uses printSymbols (interactive-only formatter) ─────────

        case 'find': {
            const { ok, result, error } = execute(index, 'find', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            if (result.length === 0) {
                console.log(`No symbols found for "${arg}"`);
            } else {
                printSymbols(result, arg, { depth: iflags.depth, top: iflags.top, all: iflags.all });
            }
            break;
        }

        // ── context: needs expandable items cache ────────────────────────

        case 'context': {
            const { ok, result, error } = execute(index, 'context', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            const { text, expandable } = output.formatContext(result, {
                methodsHint: 'Note: obj.method() calls excluded — use --include-methods to include them',
                expandHint: 'Use "expand <N>" to see code for item N',
                uncertainHint: 'use --include-uncertain to include all'
            });
            console.log(text);
            if (cache) {
                cache.save(index.root, arg, iflags.file, expandable);
            } else {
                saveExpandableItems(expandable, index.root);
            }
            break;
        }

        // ── deadcode: needs result fields for hint construction ──────────

        case 'deadcode': {
            const { ok, result, error } = execute(index, 'deadcode', iflags);
            if (!ok) { console.log(error); return; }
            console.log(output.formatDeadcode(result, {
                top: iflags.top,
                decoratedHint: !iflags.includeDecorated && result.excludedDecorated > 0 ? `${result.excludedDecorated} decorated/annotated symbol(s) hidden (framework-registered). Use --include-decorated to include them.` : undefined,
                exportedHint: !iflags.includeExported && result.excludedExported > 0 ? `${result.excludedExported} exported symbol(s) excluded (all have callers). Use --include-exported to audit them.` : undefined
            }));
            break;
        }

        // ── Standard commands routed through execute() ───────────────────

        case 'toc': {
            const { ok, result, error } = execute(index, 'toc', iflags);
            if (!ok) { console.log(error); return; }
            console.log(output.formatToc(result, {
                detailedHint: 'Add --detailed to list all functions, or "about <name>" for full details on a symbol',
                uncertainHint: 'use --include-uncertain to include all'
            }));
            break;
        }

        case 'about': {
            const { ok, result, error } = execute(index, 'about', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            console.log(output.formatAbout(result, { expand: iflags.expand, root: index.root, showAll: iflags.all, depth: iflags.depth }));
            break;
        }

        case 'usages': {
            const { ok, result, error } = execute(index, 'usages', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            console.log(output.formatUsages(result, arg));
            break;
        }

        case 'smart': {
            const { ok, result, error } = execute(index, 'smart', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            console.log(output.formatSmart(result, {
                uncertainHint: 'use --include-uncertain to include all'
            }));
            break;
        }

        case 'impact': {
            const { ok, result, error } = execute(index, 'impact', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            console.log(output.formatImpact(result));
            break;
        }

        case 'trace': {
            const { ok, result, error } = execute(index, 'trace', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            console.log(output.formatTrace(result));
            break;
        }

        case 'graph': {
            const { ok, result, error } = execute(index, 'graph', { file: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            const graphDepth = iflags.depth ? parseInt(iflags.depth) : 2;
            console.log(output.formatGraph(result, { showAll: iflags.all || !!iflags.depth, maxDepth: graphDepth, file: arg }));
            break;
        }

        case 'fileExports': {
            const { ok, result, error } = execute(index, 'fileExports', { file: arg });
            if (!ok) { console.log(error); return; }
            console.log(output.formatFileExports(result, arg));
            break;
        }

        case 'imports': {
            const { ok, result, error } = execute(index, 'imports', { file: arg });
            if (!ok) { console.log(error); return; }
            console.log(output.formatImports(result, arg));
            break;
        }

        case 'exporters': {
            const { ok, result, error } = execute(index, 'exporters', { file: arg });
            if (!ok) { console.log(error); return; }
            console.log(output.formatExporters(result, arg));
            break;
        }

        case 'tests': {
            const { ok, result, error } = execute(index, 'tests', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            console.log(output.formatTests(result, arg));
            break;
        }

        case 'search': {
            const { ok, result, error } = execute(index, 'search', { term: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            console.log(output.formatSearch(result, arg));
            break;
        }

        case 'typedef': {
            const { ok, result, error } = execute(index, 'typedef', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            console.log(output.formatTypedef(result, arg));
            break;
        }

        case 'api': {
            const { ok, result, error } = execute(index, 'api', { file: arg });
            if (!ok) { console.log(error); return; }
            console.log(output.formatApi(result, arg || '.'));
            break;
        }

        case 'diffImpact': {
            const { ok, result, error } = execute(index, 'diffImpact', iflags);
            if (!ok) { console.log(error); return; }
            console.log(output.formatDiffImpact(result));
            break;
        }

        case 'stats': {
            const { ok, result, error } = execute(index, 'stats', iflags);
            if (!ok) { console.log(error); return; }
            console.log(output.formatStats(result, { top: iflags.top }));
            break;
        }

        case 'related': {
            const { ok, result, error } = execute(index, 'related', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            console.log(output.formatRelated(result, { showAll: iflags.all, top: iflags.top }));
            break;
        }

        case 'example': {
            const { ok, result, error } = execute(index, 'example', { name: arg });
            if (!ok) { console.log(error); return; }
            console.log(output.formatExample(result, arg));
            break;
        }

        case 'plan': {
            const { ok, result, error } = execute(index, 'plan', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            console.log(output.formatPlan(result));
            break;
        }

        case 'verify': {
            const { ok, result, error } = execute(index, 'verify', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            console.log(output.formatVerify(result));
            break;
        }

        case 'stacktrace': {
            const { ok, result, error } = execute(index, 'stacktrace', { stack: arg });
            if (!ok) { console.log(error); return; }
            console.log(output.formatStackTrace(result));
            break;
        }

        default:
            console.log(`Unknown command: ${command}. Type "help" for available commands.`);
    }
}

// ============================================================================
// RUN
// ============================================================================

if (flags.interactive) {
    let target = positionalArgs[0] || '.';
    if (COMMANDS.has(target)) target = '.';
    runInteractive(target);
} else {
    main();
}

} // end of --mcp else block
