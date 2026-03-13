#!/usr/bin/env node

/**
 * UCN CLI - Universal Code Navigator
 *
 * Unified command model: commands work consistently across file and project modes.
 * Auto-detects mode from target (file path → file mode, directory → project mode).
 */

const fs = require('fs');
const path = require('path');

const { parseFile, detectLanguage } = require('../core/parser');
const { ProjectIndex } = require('../core/project');
const { expandGlob, findProjectRoot } = require('../core/discovery');
const output = require('../core/output');
// pickBestDefinition moved to execute.js — no longer needed here
const { getCliCommandSet, resolveCommand } = require('../core/registry');
const { execute } = require('../core/execute');
const { ExpandCache } = require('../core/expand-cache');

// Sentinel error for command failures that have already printed their message.
// Thrown instead of process.exit(1) so finally blocks can run (cache save).
class CommandError extends Error { constructor() { super(); } }
function fail(msg) { console.error(msg); throw new CommandError(); }

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
/**
 * Parse flags from an array of tokens. Supports both --flag=value and --flag value forms.
 * Shared between global CLI mode and interactive mode.
 */
function parseFlags(tokens) {
    function getValueFlag(flagName) {
        const eqForm = tokens.find(a => a.startsWith(flagName + '='));
        if (eqForm) return eqForm.split('=').slice(1).join('=');
        const idx = tokens.indexOf(flagName);
        if (idx !== -1 && idx + 1 < tokens.length && !tokens[idx + 1].startsWith('-')) {
            return tokens[idx + 1];
        }
        return null;
    }
    function parseExclude() {
        const result = [];
        for (const a of tokens) {
            if (a.startsWith('--exclude=') || a.startsWith('--not=')) {
                result.push(...a.split('=').slice(1).join('=').split(','));
            }
        }
        for (const flag of ['--exclude', '--not']) {
            for (let i = 0; i < tokens.length; i++) {
                if (tokens[i] === flag && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
                    result.push(...tokens[i + 1].split(','));
                }
            }
        }
        return result;
    }
    return {
        file: getValueFlag('--file'),
        exclude: parseExclude(),
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
        maxLines: getValueFlag('--max-lines') || null,
        regex: tokens.includes('--no-regex') ? false : undefined,
        functions: tokens.includes('--functions'),
        className: getValueFlag('--class-name'),
        limit: parseInt(getValueFlag('--limit') || '0') || undefined,
        maxFiles: parseInt(getValueFlag('--max-files') || '0') || undefined,
        // Structural search flags
        type: getValueFlag('--type'),
        param: getValueFlag('--param'),
        receiver: getValueFlag('--receiver'),
        returns: getValueFlag('--returns'),
        decorator: getValueFlag('--decorator'),
        exported: tokens.includes('--exported'),
        unused: tokens.includes('--unused'),
        showConfidence: tokens.includes('--show-confidence'),
        minConfidence: parseFloat(getValueFlag('--min-confidence') || '0') || 0,
        framework: getValueFlag('--framework'),
    };
}

// Parse shared flags from CLI args, then add global-only flags
const flags = parseFlags(args);
flags.json = args.includes('--json');
flags.quiet = !args.includes('--verbose') && !args.includes('--no-quiet');
flags.cache = !args.includes('--no-cache');
flags.clearCache = args.includes('--clear-cache');
flags.interactive = args.includes('--interactive') || args.includes('-i');
flags.followSymlinks = !args.includes('--no-follow-symlinks');

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
    '--max-lines', '--class-name', '--limit', '--max-files',
    '--type', '--param', '--receiver', '--returns', '--decorator', '--exported', '--unused',
    '--show-confidence', '--min-confidence',
    '--framework'
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

// Value flags that consume the next token (space form: --flag value)
const VALUE_FLAGS = new Set([
    '--file', '--depth', '--top', '--context', '--direction',
    '--add-param', '--remove-param', '--rename-to', '--default',
    '--base', '--exclude', '--not', '--in', '--max-lines', '--class-name',
    '--type', '--param', '--receiver', '--returns', '--decorator',
    '--limit', '--max-files', '--min-confidence', '--stack', '--framework'
]);

// Remove flags from args, then add args after -- (which are all positional)
const positionalArgs = [
    ...args.filter((a, idx) =>
        !a.startsWith('--') &&
        a !== '-i' &&
        !(idx > 0 && VALUE_FLAGS.has(args[idx - 1]) && !args[idx - 1].includes('='))
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
        fail(usage);
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
    const language = detectLanguage(filePath);
    if (!language) {
        console.error(`Unsupported file type: ${filePath}`);
        process.exit(1);
    }

    const canonical = resolveCommand(command, 'cli') || command;

    // Commands that need full project index — auto-route to project mode
    const fileLocalCommands = new Set(['toc', 'fn', 'class', 'find', 'usages', 'search', 'lines', 'typedef', 'api']);

    if (!fileLocalCommands.has(canonical)) {
        // Auto-detect project root and route to project mode
        const projectRoot = findProjectRoot(path.dirname(filePath));
        let effectiveArg = arg;
        if (['imports', 'exporters', 'fileExports', 'graph'].includes(canonical) && !arg) {
            effectiveArg = filePath;
        }
        runProjectCommand(projectRoot, command, effectiveArg);
        return;
    }

    // Require arg for commands that need it
    const needsArg = { fn: 'fn <name>', class: 'class <name>', find: 'find <name>', usages: 'usages <name>', search: 'search <term>', lines: 'lines <start-end>', typedef: 'typedef <name>' };
    // Structural search doesn't require term
    const isStructural = flags.type || flags.param || flags.receiver || flags.returns || flags.decorator || flags.exported || flags.unused;
    if (needsArg[canonical] && !(canonical === 'search' && isStructural)) {
        requireArg(arg, `Usage: ucn <file> ${needsArg[canonical]}`);
    }

    // Build single-file index and route through execute()
    const index = new ProjectIndex(path.dirname(filePath));
    index.buildSingleFile(filePath);
    const relativePath = path.relative(index.root, path.resolve(filePath));

    // Map command args to execute() params
    const paramsByCommand = {
        toc:     { ...flags },
        fn:      { name: arg, file: relativePath, ...flags },
        class:   { name: arg, file: relativePath, ...flags },
        find:    { name: arg, file: relativePath, ...flags },
        usages:  { name: arg, ...flags },
        search:  { term: arg, ...flags },
        lines:   { file: relativePath, range: arg },
        typedef: { name: arg, ...flags },
        api:     { file: relativePath },
    };

    const { ok, result, error, note } = execute(index, canonical, paramsByCommand[canonical]);
    if (!ok) fail(error);
    if (note) console.error(note);

    // Format output using same formatters as project mode
    switch (canonical) {
        case 'toc':
            printOutput(result, output.formatTocJson, r => output.formatToc(r, {
                detailedHint: 'Add --detailed to list all functions, or "ucn . about <name>" for full details on a symbol',
                uncertainHint: 'use --include-uncertain to include all'
            }));
            break;
        case 'find':
            printOutput(result,
                r => output.formatSymbolJson(r, arg),
                r => output.formatFindDetailed(r, arg, { depth: flags.depth, top: flags.top, all: flags.all })
            );
            break;
        case 'fn':
            if (result.notes.length) result.notes.forEach(n => console.error('Note: ' + n));
            printOutput(result, output.formatFnResultJson, output.formatFnResult);
            break;
        case 'class':
            if (result.notes.length) result.notes.forEach(n => console.error('Note: ' + n));
            printOutput(result, output.formatClassResultJson, output.formatClassResult);
            break;
        case 'lines':
            printOutput(result, output.formatLinesJson, r => output.formatLines(r));
            break;
        case 'usages':
            printOutput(result, r => output.formatUsagesJson(r, arg), r => output.formatUsages(r, arg));
            break;
        case 'search':
            if (result && result.meta && result.meta.mode === 'structural') {
                printOutput(result, output.formatStructuralSearchJson, output.formatStructuralSearch);
            } else {
                printOutput(result, r => output.formatSearchJson(r, arg), r => output.formatSearch(r, arg));
            }
            break;
        case 'typedef':
            printOutput(result, r => output.formatTypedefJson(r, arg), r => output.formatTypedef(r, arg));
            break;
        case 'api':
            printOutput(result, r => output.formatApiJson(r, arg), r => output.formatApi(r, arg));
            break;
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
    let needsCacheSave = false;
    if (!usedCache) {
        index.build(null, { quiet: flags.quiet, forceRebuild: cacheWasLoaded, followSymlinks: flags.followSymlinks, maxFiles: flags.maxFiles });
        needsCacheSave = flags.cache;
    }

    try {
    // Resolve CLI aliases to canonical command names — dispatch on canonical
    const canonical = resolveCommand(command, 'cli') || command;

    switch (canonical) {
        // ── Commands using shared executor ───────────────────────────────

        case 'toc': {
            const { ok, result, error, note } = execute(index, 'toc', flags);
            if (!ok) fail(error);
            if (note) console.error(note);
            printOutput(result, output.formatTocJson, r => output.formatToc(r, {
                detailedHint: 'Add --detailed to list all functions, or "ucn . about <name>" for full details on a symbol',
                uncertainHint: 'use --include-uncertain to include all'
            }));
            break;
        }

        case 'find': {
            const { ok, result, error, note } = execute(index, 'find', { name: arg, ...flags });
            if (!ok) fail(error);
            if (note) console.error(note);
            printOutput(result,
                r => output.formatSymbolJson(r, arg),
                r => output.formatFindDetailed(r, arg, { depth: flags.depth, top: flags.top, all: flags.all })
            );
            break;
        }

        case 'usages': {
            const { ok, result, error, note } = execute(index, 'usages', { name: arg, ...flags });
            if (!ok) fail(error);
            if (note) console.error(note);
            printOutput(result,
                r => output.formatUsagesJson(r, arg),
                r => output.formatUsages(r, arg)
            );
            break;
        }

        case 'example': {
            const { ok, result, error } = execute(index, 'example', { name: arg });
            if (!ok) fail(error);
            printOutput(result,
                r => output.formatExampleJson(r, arg),
                r => output.formatExample(r, arg)
            );
            break;
        }

        case 'context': {
            const { ok, result: ctx, error } = execute(index, 'context', { name: arg, ...flags });
            if (!ok) fail(error);
            if (flags.json) {
                console.log(output.formatContextJson(ctx));
            } else {
                const { text, expandable } = output.formatContext(ctx, {
                    methodsHint: 'Note: obj.method() calls excluded — use --include-methods to include them',
                    expandHint: 'Use "ucn . expand <N>" to see code for item N',
                    uncertainHint: 'use --include-uncertain to include all',
                    showConfidence: flags.showConfidence,
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
                fail(`Invalid item number: "${arg}"`);
            }
            const cached = loadExpandableItems(index.root);
            const items = cached?.items || [];
            const match = items.find(i => i.num === expandNum);
            const { ok, result, error } = execute(index, 'expand', {
                match, itemNum: expandNum, itemCount: items.length
            });
            if (!ok) fail(error);
            console.log(result.text);
            break;
        }

        case 'smart': {
            const { ok, result, error } = execute(index, 'smart', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatSmartJson, r => output.formatSmart(r, {
                uncertainHint: 'use --include-uncertain to include all'
            }));
            break;
        }

        case 'about': {
            const { ok, result, error } = execute(index, 'about', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result,
                output.formatAboutJson,
                r => output.formatAbout(r, { expand: flags.expand, root: index.root, depth: flags.depth, showConfidence: flags.showConfidence })
            );
            break;
        }

        case 'impact': {
            const { ok, result, error } = execute(index, 'impact', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatImpactJson, output.formatImpact);
            break;
        }

        case 'blast': {
            const { ok, result, error } = execute(index, 'blast', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatBlastJson, output.formatBlast);
            break;
        }

        case 'plan': {
            const { ok, result, error } = execute(index, 'plan', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatPlanJson, output.formatPlan);
            break;
        }

        case 'trace': {
            const { ok, result, error } = execute(index, 'trace', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatTraceJson, output.formatTrace);
            break;
        }

        case 'reverseTrace': {
            const { ok, result, error } = execute(index, 'reverseTrace', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatReverseTraceJson, output.formatReverseTrace);
            break;
        }

        case 'stacktrace': {
            const { ok, result, error } = execute(index, 'stacktrace', { stack: arg });
            if (!ok) fail(error);
            printOutput(result, output.formatStackTraceJson, output.formatStackTrace);
            break;
        }

        case 'verify': {
            const { ok, result, error } = execute(index, 'verify', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatVerifyJson, output.formatVerify);
            break;
        }

        case 'related': {
            const { ok, result, error } = execute(index, 'related', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatRelatedJson, r => output.formatRelated(r, { all: flags.all, top: flags.top }));
            break;
        }

        // ── Extraction commands (via execute) ────────────────────────────

        case 'fn': {
            requireArg(arg, 'Usage: ucn . fn <name>');
            const { ok, result, error } = execute(index, 'fn', { name: arg, file: flags.file, all: flags.all });
            if (!ok) fail(error);
            if (result.notes.length) result.notes.forEach(n => console.error('Note: ' + n));
            printOutput(result, output.formatFnResultJson, output.formatFnResult);
            break;
        }

        case 'class': {
            requireArg(arg, 'Usage: ucn . class <name>');
            const { ok, result, error } = execute(index, 'class', { name: arg, file: flags.file, all: flags.all, maxLines: flags.maxLines });
            if (!ok) fail(error);
            if (result.notes.length) result.notes.forEach(n => console.error('Note: ' + n));
            printOutput(result, output.formatClassResultJson, output.formatClassResult);
            break;
        }

        case 'lines': {
            requireArg(arg, 'Usage: ucn . lines <range> --file <path>');
            const { ok, result, error } = execute(index, 'lines', { file: flags.file, range: arg });
            if (!ok) fail(error);
            printOutput(result, output.formatLinesJson, r => output.formatLines(r));
            break;
        }

        // ── File dependency commands ────────────────────────────────────

        case 'imports': {
            const { ok, result, error } = execute(index, 'imports', { file: arg });
            if (!ok) fail(error);
            printOutput(result,
                r => output.formatImportsJson(r, arg),
                r => output.formatImports(r, arg)
            );
            break;
        }

        case 'exporters': {
            const { ok, result, error } = execute(index, 'exporters', { file: arg });
            if (!ok) fail(error);
            printOutput(result,
                r => output.formatExportersJson(r, arg),
                r => output.formatExporters(r, arg)
            );
            break;
        }

        case 'fileExports': {
            const { ok, result, error } = execute(index, 'fileExports', { file: arg });
            if (!ok) fail(error);
            printOutput(result,
                r => JSON.stringify({ file: arg, exports: r }, null, 2),
                r => output.formatFileExports(r, arg)
            );
            break;
        }

        case 'graph': {
            const { ok, result, error } = execute(index, 'graph', { file: arg, direction: flags.direction, depth: flags.depth, all: flags.all });
            if (!ok) fail(error);
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

        case 'circularDeps': {
            const { ok, result, error } = execute(index, 'circularDeps', { file: flags.file, exclude: flags.exclude });
            if (!ok) fail(error);
            printOutput(result, output.formatCircularDepsJson, output.formatCircularDeps);
            break;
        }

        // ── Remaining commands ──────────────────────────────────────────

        case 'typedef': {
            const { ok, result, error } = execute(index, 'typedef', { name: arg, exact: flags.exact });
            if (!ok) fail(error);
            printOutput(result,
                r => output.formatTypedefJson(r, arg),
                r => output.formatTypedef(r, arg)
            );
            break;
        }

        case 'tests': {
            const { ok, result, error } = execute(index, 'tests', { name: arg, callsOnly: flags.callsOnly });
            if (!ok) fail(error);
            printOutput(result,
                r => output.formatTestsJson(r, arg),
                r => output.formatTests(r, arg)
            );
            break;
        }

        case 'affectedTests': {
            const { ok, result, error } = execute(index, 'affectedTests', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatAffectedTestsJson, output.formatAffectedTests);
            break;
        }

        case 'api': {
            const { ok, result, error, note } = execute(index, 'api', { file: arg || flags.file, limit: flags.limit });
            if (!ok) fail(error);
            if (note) console.error(note);
            printOutput(result,
                r => output.formatApiJson(r, arg),
                r => output.formatApi(r, arg)
            );
            break;
        }

        case 'search': {
            const { ok, result, error, structural } = execute(index, 'search', { term: arg, ...flags });
            if (!ok) fail(error);
            if (structural) {
                printOutput(result, output.formatStructuralSearchJson, output.formatStructuralSearch);
            } else {
                printOutput(result,
                    r => output.formatSearchJson(r, arg),
                    r => output.formatSearch(r, arg)
                );
            }
            break;
        }

        case 'deadcode': {
            const { ok, result, error, note } = execute(index, 'deadcode', { ...flags, in: flags.in || subdirScope });
            if (!ok) fail(error);
            if (note) console.error(note);
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

        case 'entrypoints': {
            const { ok, result, error } = execute(index, 'entrypoints', { type: flags.type, framework: flags.framework, file: flags.file });
            if (!ok) fail(error);
            printOutput(result,
                output.formatEntrypointsJson,
                r => output.formatEntrypoints(r)
            );
            break;
        }

        case 'stats': {
            const { ok, result, error } = execute(index, 'stats', { functions: flags.functions });
            if (!ok) fail(error);
            printOutput(result,
                output.formatStatsJson,
                r => output.formatStats(r, { top: flags.top })
            );
            break;
        }

        case 'diffImpact': {
            const { ok, result, error } = execute(index, 'diffImpact', { base: flags.base, staged: flags.staged, file: flags.file });
            if (!ok) fail(error);
            printOutput(result, output.formatDiffImpactJson, output.formatDiffImpact);
            break;
        }

        default:
            console.error(`Unknown command: ${canonical}`);
            printUsage();
            throw new CommandError();
    }
    } catch (e) {
        if (!(e instanceof CommandError)) {
            console.error(`Error: ${e.message}`);
        }
        process.exitCode = 1;
    } finally {
        // Save cache after command execution so callsCache populated
        // by findCallers/findCallees gets persisted to disk.
        // On cache-hit runs, only re-save if callsCache was mutated.
        if (flags.cache && (needsCacheSave || index.callsCacheDirty)) {
            try { index.saveCache(); } catch (e) { /* best-effort */ }
        }
    }
}

// extractFunctionFromProject and extractClassFromProject removed —
// all surfaces now use execute(index, 'fn'/'class', params) from core/execute.js


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
// printExpandedItem removed — all surfaces now use execute(index, 'expand', ...)




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
        console.log(output.formatFindDetailed(allMatches, name, { depth: flags.depth, top: flags.top, all: flags.all }));
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
UNDERSTAND CODE
═══════════════════════════════════════════════════════════════════════════════
  about <name>        Full picture (definition, callers, callees, tests, code)
  context <name>      Who calls this + what it calls (numbered for expand)
  smart <name>        Function + all dependencies inline
  impact <name>       What breaks if changed (call sites grouped by file)
  blast <name>        Transitive blast radius (callers of callers, --depth=N)
  trace <name>        Call tree visualization (--depth=N expands all children)
  reverse-trace <name> Upward call chain to entry points (--depth=N, default 5)
  related <name>      Find similar functions (same file, shared deps)
  example <name>      Best usage example with context

═══════════════════════════════════════════════════════════════════════════════
FIND CODE
═══════════════════════════════════════════════════════════════════════════════
  find <name>         Find symbol definitions (supports glob: find "handle*")
  usages <name>       All usages grouped: definitions, calls, imports, references
  toc                 Table of contents (compact; --detailed lists all symbols)
  search <term>       Text search (regex default, --context=N, --exclude=, --in=)
                      Structural: --type=function|class|call --param= --returns= --decorator= --exported --unused
  tests <name>        Find test files for a function
  affected-tests <n>  Tests affected by a change (blast + test detection, --depth=N)

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
  circular-deps       Detect circular import chains (--file=, --exclude=)

═══════════════════════════════════════════════════════════════════════════════
REFACTORING HELPERS
═══════════════════════════════════════════════════════════════════════════════
  plan <name>         Preview refactoring (--add-param, --remove-param, --rename-to)
  verify <name>       Check all call sites match signature
  diff-impact         What changed in git diff and who calls it (--base, --staged)
  deadcode            Find unused functions/classes
  entrypoints         Detect framework entry points (routes, DI, tasks)

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
  --limit=N           Limit result count (find, usages, search, deadcode, api, toc)
  --max-files=N       Max files to index (large projects)
  --context=N         Lines of context around matches
  --json              Machine-readable output
  --code-only         Filter out comments and strings
  --with-types        Include type definitions
  --include-tests     Include test files
  --class-name=X      Scope to specific class (e.g., --class-name=Repository)
  --include-methods   Include method calls (obj.fn) in caller/callee analysis
  --include-uncertain Include ambiguous/uncertain matches
  --show-confidence   Show confidence scores per caller/callee edge
  --min-confidence=N  Filter edges below confidence threshold (0.0-1.0)
  --include-exported  Include exported symbols in deadcode
  --no-regex          Force plain text search (regex is default)
  --functions         Show per-function line counts (stats command)
  --include-decorated Include decorated/annotated symbols in deadcode
  --framework=X       Filter entrypoints by framework (e.g., --framework=express,spring)
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
  blast <name>           Transitive blast radius (--depth=N)
  trace <name>           Call tree (--depth=N)
  reverse-trace <name>   Upward to entry points (--depth=N)
  example <name>         Best usage example
  related <name>         Sibling functions
  fn <name>[,n2,...]     Extract function(s) (--file=)
  class <name>           Extract class code (--file=)
  lines <range>          Extract lines (--file= required)
  graph <file>           File dependency tree (--direction=, --depth=)
  circular-deps          Circular import chains (--file=, --exclude=)
  file-exports <file>    File's exported symbols
  imports <file>         What file imports
  exporters <file>       Who imports file
  tests <name>           Find tests (--calls-only)
  affected-tests <n>     Tests affected by a change (--depth=N)
  search <term>          Text search (--context=N, --exclude=, --in=)
                         Structural: --type= --param= --returns= --decorator= --exported --unused
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
        const valueFlagNames = new Set(['--file', '--in', '--base', '--add-param', '--remove-param', '--rename-to', '--default', '--depth', '--top', '--context', '--max-lines', '--direction', '--exclude', '--not', '--stack', '--type', '--param', '--receiver', '--returns', '--decorator', '--limit', '--max-files', '--min-confidence', '--class-name', '--framework']);
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
        const iflags = parseFlags(flagTokens);

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

// parseInteractiveFlags removed — both global and interactive mode now use parseFlags()

function executeInteractiveCommand(index, command, arg, iflags = {}, cache = null) {
    switch (command) {

        // ── Extraction commands (via execute) ────────────────────────────

        case 'fn': {
            if (!arg) { console.log('Usage: fn <name>[,name2,...] [--file=<pattern>]'); return; }
            const { ok, result, error } = execute(index, 'fn', { name: arg, file: iflags.file, all: iflags.all });
            if (!ok) { console.log(error); return; }
            if (result.notes.length) result.notes.forEach(n => console.log('Note: ' + n));
            console.log(output.formatFnResult(result));
            break;
        }

        case 'class': {
            if (!arg) { console.log('Usage: class <name> [--file=<pattern>]'); return; }
            const { ok, result, error } = execute(index, 'class', { name: arg, file: iflags.file, all: iflags.all, maxLines: iflags.maxLines });
            if (!ok) { console.log(error); return; }
            if (result.notes.length) result.notes.forEach(n => console.log('Note: ' + n));
            console.log(output.formatClassResult(result));
            break;
        }

        case 'lines': {
            if (!arg) { console.log('Usage: lines <range> --file=<file>'); return; }
            const { ok, result, error } = execute(index, 'lines', { file: iflags.file, range: arg });
            if (!ok) { console.log(error); return; }
            console.log(output.formatLines(result));
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
            let match, itemCount, symbolName;
            if (cache) {
                const lookup = cache.lookup(index.root, expandNum);
                match = lookup.match;
                itemCount = lookup.itemCount;
                symbolName = lookup.symbolName;
            } else {
                const cached = loadExpandableItems(index.root);
                const items = cached?.items || [];
                match = items.find(i => i.num === expandNum);
                itemCount = items.length;
            }
            const { ok, result, error } = execute(index, 'expand', {
                match, itemNum: expandNum, itemCount, symbolName
            });
            if (!ok) { console.log(error); return; }
            console.log(result.text);
            break;
        }

        case 'find': {
            const { ok, result, error, note } = execute(index, 'find', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            if (note) console.log(note);
            console.log(output.formatFindDetailed(result, arg, { depth: iflags.depth, top: iflags.top, all: iflags.all }));
            break;
        }

        // ── context: needs expandable items cache ────────────────────────

        case 'context': {
            const { ok, result, error } = execute(index, 'context', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            const { text, expandable } = output.formatContext(result, {
                methodsHint: 'Note: obj.method() calls excluded — use --include-methods to include them',
                expandHint: 'Use "expand <N>" to see code for item N',
                uncertainHint: 'use --include-uncertain to include all',
                showConfidence: iflags.showConfidence,
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

        case 'entrypoints': {
            const { ok, result, error } = execute(index, 'entrypoints', { type: iflags.type, framework: iflags.framework, file: iflags.file });
            if (!ok) { console.log(error); return; }
            console.log(output.formatEntrypoints(result));
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
            console.log(output.formatAbout(result, { expand: iflags.expand, root: index.root, showAll: iflags.all, depth: iflags.depth, showConfidence: iflags.showConfidence }));
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

        case 'blast': {
            const { ok, result, error } = execute(index, 'blast', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            console.log(output.formatBlast(result));
            break;
        }

        case 'trace': {
            const { ok, result, error } = execute(index, 'trace', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            console.log(output.formatTrace(result));
            break;
        }

        case 'reverseTrace': {
            const { ok, result, error } = execute(index, 'reverseTrace', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            console.log(output.formatReverseTrace(result));
            break;
        }

        case 'graph': {
            const { ok, result, error } = execute(index, 'graph', { file: arg || iflags.file, direction: iflags.direction, depth: iflags.depth, all: iflags.all });
            if (!ok) { console.log(error); return; }
            const graphDepth = iflags.depth ? parseInt(iflags.depth) : 2;
            console.log(output.formatGraph(result, { showAll: iflags.all || !!iflags.depth, maxDepth: graphDepth, file: arg }));
            break;
        }

        case 'circularDeps': {
            const { ok, result, error } = execute(index, 'circularDeps', { file: iflags.file, exclude: iflags.exclude });
            if (!ok) { console.log(error); return; }
            console.log(output.formatCircularDeps(result));
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

        case 'affectedTests': {
            const { ok, result, error } = execute(index, 'affectedTests', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            console.log(output.formatAffectedTests(result));
            break;
        }

        case 'search': {
            const { ok, result, error, structural } = execute(index, 'search', { term: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            if (structural) {
                console.log(output.formatStructuralSearch(result));
            } else {
                console.log(output.formatSearch(result, arg));
            }
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
            console.log(output.formatRelated(result, { all: iflags.all, top: iflags.top }));
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
