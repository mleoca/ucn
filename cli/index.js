#!/usr/bin/env node

/**
 * UCN CLI - Universal Code Navigator
 *
 * Unified command model: commands work consistently across file and project modes.
 * Auto-detects mode from target (file path → file mode, directory → project mode).
 */

const fs = require('fs');
const path = require('path');

const { detectLanguage } = require('../core/parser');
const { ProjectIndex } = require('../core/project');
const { expandGlob, findProjectRoot } = require('../core/discovery');
const output = require('../core/output');
const { getCliCommandSet, resolveCommand, FLAG_APPLICABILITY, toCliName, FILE_LOCAL_COMMANDS } = require('../core/registry');
const { looksLikeHandle, parseSymbolHandle } = require('../core/shared');

/**
 * Convert a CLI argument that may be a stable handle into the symbol name
 * that's appropriate for headers / "Usages of X" / "find Y" displays.
 * Plain names pass through unchanged.
 */
function nameForDisplay(arg) {
    if (typeof arg !== 'string') return arg;
    if (!looksLikeHandle(arg)) return arg;
    const h = parseSymbolHandle(arg);
    return h && h.name ? h.name : arg;
}
const { execute } = require('../core/execute');
const { ExpandCache } = require('../core/expand-cache');

// Sentinel error for command failures that have already printed their message.
// Thrown instead of process.exit(1) so finally blocks can run (cache save).
class CommandError extends Error { constructor() { super(); } }

// Thrown by validateNumericFlags when a numeric flag has a bad value.
// The CLI top-level catches this, prints the message, and exits 1. Interactive
// mode catches it inside its REPL try/catch and continues the session.
class FlagValidationError extends Error {
    constructor(msg) { super(msg); this.name = 'FlagValidationError'; }
}

/**
 * Validate that a raw flag value is a positive integer. Returns the parsed
 * number when valid, or throws FlagValidationError. Callers pass `null`/`undefined`
 * raw values through unchanged (no flag → no validation).
 *
 * @param {string|null|undefined} raw - The raw string captured from the CLI/interactive token.
 * @param {string} flagName - The CLI flag name including dashes (e.g. "--top") for error messages.
 * @param {object} [opts]
 * @param {boolean} [opts.allowZero=false] - Whether 0 is a valid value (e.g. depth=0 may be meaningful).
 * @param {number} [opts.cap=10000000] - Maximum accepted value (rejects 1e100 etc).
 * @returns {number|undefined} The validated integer, or undefined when raw is null/undefined.
 */
function validatePositiveInt(raw, flagName, { allowZero = false, cap = 10000000 } = {}) {
    if (raw == null) return undefined;
    const label = allowZero ? 'non-negative integer' : 'positive integer';
    const trimmed = String(raw).trim();
    if (trimmed === '') {
        throw new FlagValidationError(`Invalid ${flagName} value: must be a ${label} (got "${raw}")`);
    }
    const n = Number(trimmed);
    if (!isFinite(n) || isNaN(n)) {
        throw new FlagValidationError(`Invalid ${flagName} value: must be a ${label} (got "${raw}")`);
    }
    if (!Number.isInteger(n)) {
        throw new FlagValidationError(`Invalid ${flagName} value: must be a ${label} (got ${n})`);
    }
    if (allowZero) {
        if (n < 0) {
            throw new FlagValidationError(`Invalid ${flagName} value: must be a ${label} (got ${n})`);
        }
    } else if (n <= 0) {
        throw new FlagValidationError(`Invalid ${flagName} value: must be a ${label} (got ${n})`);
    }
    if (n > cap) {
        throw new FlagValidationError(`Invalid ${flagName} value: ${n} exceeds maximum (${cap})`);
    }
    return n;
}

/**
 * Validate all numeric flags on a parsed flags object. Looks at the *Raw
 * companion strings preserved by parseFlags so we catch user-supplied bad
 * values regardless of whether the parsed numeric form happened to be falsy.
 * Mutates `flags` to hold the validated numeric values.
 *
 * Throws FlagValidationError on the first invalid flag.
 */
function validateNumericFlags(flags) {
    // --top: positive integer, no zero. Used by stats/find/context/etc.
    if (flags.topRaw != null) {
        flags.top = validatePositiveInt(flags.topRaw, '--top');
    }
    // --limit: positive integer, no zero. Reject "0 = no limit" silent coercion.
    if (flags.limitRaw != null) {
        flags.limit = validatePositiveInt(flags.limitRaw, '--limit');
    }
    // --max-files: positive integer, no zero.
    if (flags.maxFilesRaw != null) {
        flags.maxFiles = validatePositiveInt(flags.maxFilesRaw, '--max-files');
    }
    // --max-lines: positive integer, no zero. Used by class command.
    if (flags.maxLinesRaw != null) {
        flags.maxLines = validatePositiveInt(flags.maxLinesRaw, '--max-lines');
    }
    // --depth: non-negative integer (0 is meaningful: "this symbol only").
    if (flags.depthRaw != null) {
        flags.depth = validatePositiveInt(flags.depthRaw, '--depth', { allowZero: true });
    }
    // --context: non-negative integer (0 = no surrounding lines).
    if (flags.contextRaw != null) {
        flags.context = validatePositiveInt(flags.contextRaw, '--context', { allowZero: true });
    }
    // --workers: non-negative integer (0 disables parallel build).
    if (flags.workersRaw != null) {
        flags.workers = validatePositiveInt(flags.workersRaw, '--workers', { allowZero: true });
    }
}

/**
 * Print an error message and abort. When `--json` is in effect, write a JSON
 * error envelope to stdout (so JSON-consuming pipelines see structured output)
 * and write the same plain message to stderr (for humans piping to a TTY).
 */
function fail(msg) {
    // Honor --json by writing a structured envelope to stdout for pipelines.
    // We use try/catch around symbol lookups because `flags` may not be initialized
    // yet when fail() is called from the early arg-parsing path (TDZ).
    let wantsJson = false;
    try { if (typeof flags !== 'undefined' && flags && flags.json) wantsJson = true; } catch (_) {}
    if (!wantsJson) {
        try { if (Array.isArray(process.argv) && process.argv.includes('--json')) wantsJson = true; } catch (_) {}
    }
    if (wantsJson) {
        const env = { meta: { ok: false }, error: typeof msg === 'string' ? msg : String(msg) };
        try { process.stdout.write(JSON.stringify(env) + '\n'); } catch (_) {}
    }
    console.error(msg);
    throw new CommandError();
}

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
        includeTests: tokens.includes('--include-tests') ? true : undefined,
        excludeTests: tokens.includes('--exclude-tests') ? true : undefined,
        includeExported: tokens.includes('--include-exported') || undefined,
        includeDecorated: tokens.includes('--include-decorated') || undefined,
        includeUncertain: tokens.includes('--include-uncertain') || undefined,
        expandUnverified: tokens.includes('--expand-unverified') || undefined,
        includeMethods: tokens.some(a => a === '--include-methods=false' || a === '--no-include-methods') ? false : tokens.some(a => a === '--include-methods' || (a.startsWith('--include-methods=') && a !== '--include-methods=false')) ? true : undefined,
        detailed: tokens.includes('--detailed') || undefined,
        topLevel: tokens.includes('--top-level') || undefined,
        all: tokens.includes('--all') || undefined,
        exact: tokens.includes('--exact') || undefined,
        callsOnly: tokens.includes('--calls-only') || undefined,
        codeOnly: tokens.includes('--code-only') || undefined,
        caseSensitive: tokens.includes('--case-sensitive') || undefined,
        withTypes: tokens.includes('--with-types') || undefined,
        expand: tokens.includes('--expand') || undefined,
        depth: getValueFlag('--depth'),
        depthRaw: getValueFlag('--depth'),
        // `top` is the parsed numeric value (NaN/0 default → falsy). `topRaw`
        // preserves the original string so downstream validators can produce
        // helpful errors for "abc"/"-1"/"0" instead of silently defaulting.
        top: parseInt(getValueFlag('--top') || '0'),
        topRaw: getValueFlag('--top'),
        context: parseInt(getValueFlag('--context') || '0'),
        contextRaw: getValueFlag('--context'),
        direction: getValueFlag('--direction'),
        addParam: getValueFlag('--add-param'),
        removeParam: getValueFlag('--remove-param'),
        renameTo: getValueFlag('--rename-to'),
        defaultValue: getValueFlag('--default'),
        base: getValueFlag('--base'),
        staged: tokens.includes('--staged') || undefined,
        deep: tokens.includes('--deep') || undefined,
        compact: tokens.includes('--compact') || undefined,
        maxLines: getValueFlag('--max-lines') || null,
        maxLinesRaw: getValueFlag('--max-lines'),
        regex: tokens.includes('--no-regex') ? false : undefined,
        functions: tokens.includes('--functions') || undefined,
        hot: tokens.includes('--hot') || undefined,
        diverse: tokens.includes('--diverse') || undefined,
        git: tokens.includes('--git') || undefined,
        className: getValueFlag('--class-name'),
        limit: parseInt(getValueFlag('--limit') || '0') || undefined,
        limitRaw: getValueFlag('--limit'),
        maxFiles: parseInt(getValueFlag('--max-files') || '0') || undefined,
        maxFilesRaw: getValueFlag('--max-files'),
        // Structural search flags
        type: getValueFlag('--type'),
        param: getValueFlag('--param'),
        receiver: getValueFlag('--receiver'),
        returns: getValueFlag('--returns'),
        decorator: getValueFlag('--decorator'),
        exported: tokens.includes('--exported') || undefined,
        unused: tokens.includes('--unused') || undefined,
        showConfidence: (tokens.includes('--hide-confidence') || tokens.includes('--no-confidence')) ? false : undefined,
        minConfidence: parseFloat(getValueFlag('--min-confidence') || '0') || 0,
        unreachableOnly: tokens.includes('--unreachable-only') || undefined,
        framework: getValueFlag('--framework'),
        // endpoints command flags
        bridge: tokens.includes('--bridge') || undefined,
        serverOnly: tokens.includes('--server-only') || undefined,
        clientOnly: tokens.includes('--client-only') || undefined,
        unmatched: tokens.includes('--unmatched') || undefined,
        method: getValueFlag('--method'),
        prefix: getValueFlag('--prefix'),
        hideUncertain: tokens.includes('--hide-uncertain') || tokens.includes('--no-uncertain') || undefined,
        stack: getValueFlag('--stack'),
        workersRaw: getValueFlag('--workers'),
        workers: (() => {
            const v = getValueFlag('--workers');
            if (v === null) return undefined;
            const n = parseInt(v, 10);
            return isNaN(n) ? undefined : n;
        })(),
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
    '--help', '-h', '--version', '-v', '--mcp',
    '--json', '--verbose', '--no-quiet', '--quiet',
    '--code-only', '--with-types', '--top-level', '--exact', '--case-sensitive',
    '--no-cache', '--clear-cache', '--include-tests', '--exclude-tests',
    '--include-exported', '--include-decorated', '--expand', '--interactive', '-i', '--all', '--include-methods', '--no-include-methods', '--include-uncertain', '--expand-unverified', '--detailed', '--calls-only',
    '--file', '--context', '--exclude', '--not', '--in',
    '--depth', '--direction', '--add-param', '--remove-param', '--rename-to',
    '--default', '--top', '--no-follow-symlinks',
    '--base', '--staged', '--stack',
    '--regex', '--no-regex', '--functions', '--hot', '--diverse', '--git',
    '--max-lines', '--class-name', '--limit', '--max-files',
    '--type', '--param', '--receiver', '--returns', '--decorator', '--exported', '--unused',
    '--hide-confidence', '--no-confidence', '--min-confidence', '--unreachable-only',
    '--framework', '--workers', '--deep', '--compact',
    '--bridge', '--server-only', '--client-only', '--unmatched',
    '--method', '--prefix', '--hide-uncertain', '--no-uncertain'
]);

// Handle help flag
if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
}

// Handle version flag — read from package.json (single source of truth, shared with MCP serverInfo)
if (args.includes('--version') || args.includes('-v')) {
    console.log(require('../package.json').version);
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

// Validate numeric flag values up front so bad input fails before we build
// any indexes. Applies to --top, --limit, --max-files, --max-lines, --depth,
// --context, --workers. Throws FlagValidationError with a helpful message.
try {
    validateNumericFlags(flags);
} catch (e) {
    if (e instanceof FlagValidationError) {
        if (flags.json) {
            const env = { meta: { ok: false }, error: e.message };
            try { process.stdout.write(JSON.stringify(env) + '\n'); } catch (_) {}
        }
        console.error(e.message);
        process.exit(1);
    }
    throw e;
}

// Value flags that consume the next token (space form: --flag value)
const VALUE_FLAGS = new Set([
    '--file', '--depth', '--top', '--context', '--direction',
    '--add-param', '--remove-param', '--rename-to', '--default',
    '--base', '--exclude', '--not', '--in', '--max-lines', '--class-name',
    '--type', '--param', '--receiver', '--returns', '--decorator',
    '--limit', '--max-files', '--min-confidence', '--stack', '--framework',
    '--workers', '--method', '--prefix'
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

/**
 * Print inline 3-line code previews for each callee (--expand support).
 * Used by context in project, interactive, and glob modes.
 */
function printInlineExpand(ctx, root) {
    if (!root || !ctx || !ctx.callees) return;
    for (const c of ctx.callees) {
        if (c.relativePath && c.startLine) {
            try {
                const filePath = path.join(root, c.relativePath);
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
    const fileLocalCommands = FILE_LOCAL_COMMANDS;

    if (!fileLocalCommands.has(canonical)) {
        // Auto-detect project root and route to project mode
        const projectRoot = findProjectRoot(path.dirname(filePath));
        let effectiveArg = arg;
        if (['imports', 'exporters', 'fileExports', 'graph'].includes(canonical) && !arg) {
            effectiveArg = filePath;
        }
        // Scope to the target file unless an explicit --file was provided
        if (!flags.file) {
            const relPath = path.relative(projectRoot, path.resolve(filePath));
            flags.file = relPath;
            flags._fileFromFileMode = true; // suppress inapplicable-flag warning
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
        usages:  { name: arg, file: relativePath, ...flags },
        search:  { term: arg, ...flags },
        lines:   { file: relativePath, range: arg },
        typedef: { name: arg, file: relativePath, ...flags },
        api:     { file: relativePath, limit: flags.limit },
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
            printOutput(result, output.formatFnResultJson, output.formatFnResult);
            break;
        case 'class':
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
        case 'api': {
            const apiFile = relativePath;
            printOutput(result, r => output.formatApiJson(r, apiFile), r => output.formatApi(r, apiFile));
            break;
        }
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
        index.build(null, { quiet: flags.quiet, forceRebuild: cacheWasLoaded, followSymlinks: flags.followSymlinks, maxFiles: flags.maxFiles, workers: flags.workers });
        needsCacheSave = flags.cache;
        // Clear stale expand cache — line ranges may have shifted after rebuild
        try {
            const expandPath = path.join(index.root, '.ucn-cache', 'expandable.json');
            if (fs.existsSync(expandPath)) fs.unlinkSync(expandPath);
        } catch (_) { /* best-effort */ }
    }

    try {
    // Resolve CLI aliases to canonical command names — dispatch on canonical
    const canonical = resolveCommand(command, 'cli') || command;

    // Warn about flags that don't apply to this command
    const applicableFlags = FLAG_APPLICABILITY[canonical];
    if (applicableFlags) {
        // Map from camelCase flag name to CLI flag string
        const flagToCli = (f) => '--' + f.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
        // Flags that are global (not command-specific) — skip warning for these
        const globalFlags = new Set(['json', 'quiet', 'cache', 'clearCache', 'followSymlinks', 'maxFiles', 'verbose', 'expand', 'interactive', '_fileFromFileMode', 'topRaw', 'limitRaw', 'maxFilesRaw', 'maxLinesRaw', 'depthRaw', 'contextRaw', 'workersRaw']);
        for (const [key, value] of Object.entries(flags)) {
            if (globalFlags.has(key)) continue;
            // Skip unset values (undefined, null, 0, empty array) — but NOT false (explicit negation)
            if (value === undefined || value === null || value === 0 || (Array.isArray(value) && value.length === 0)) continue;
            // Skip --file when it was injected by file-mode routing, not user input
            if (key === 'file' && flags._fileFromFileMode) continue;
            if (!applicableFlags.includes(key)) {
                console.error(`Warning: ${flagToCli(key)} has no effect on '${toCliName(canonical)}'.`);
            }
        }
        // Tiered-output contract: unverified callers are always shown for
        // these commands, so the legacy reveal flags are implied no-ops.
        if (['about', 'context', 'impact', 'trace', 'blast', 'reverseTrace', 'affectedTests'].includes(canonical)) {
            if (flags.includeUncertain) {
                console.error(`Note: --include-uncertain is implied for '${toCliName(canonical)}' — unverified candidates are always shown (tiered).`);
            }
            if (['about', 'context', 'impact'].includes(canonical) && flags.includeMethods) {
                console.error(`Note: --include-methods is implied for '${toCliName(canonical)}' — method calls are tiered by receiver evidence.`);
            }
        }
    }

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
                r => output.formatFindDetailed(r, arg, { depth: flags.depth, top: flags.top, all: flags.all, compact: flags.compact })
            );
            break;
        }

        case 'usages': {
            const { ok, result, error, note } = execute(index, 'usages', { name: arg, ...flags });
            if (!ok) fail(error);
            if (note) console.error(note);
            const displayName = nameForDisplay(arg);
            printOutput(result,
                r => output.formatUsagesJson(r, displayName),
                r => output.formatUsages(r, displayName, { compact: flags.compact })
            );
            break;
        }

        case 'example': {
            const { ok, result, error, note } = execute(index, 'example', {
                name: arg,
                file: flags.file,
                className: flags.className,
                diverse: flags.diverse,
                top: flags.top || undefined,
                includeTests: flags.includeTests,
            });
            if (!ok) fail(error);
            if (note) console.error(note);
            const displayName = nameForDisplay(arg);
            printOutput(result,
                r => output.formatExampleJson(r, displayName),
                r => output.formatExample(r, displayName)
            );
            break;
        }

        case 'context': {
            const { ok, result: ctx, error, note } = execute(index, 'context', { name: arg, ...flags });
            if (!ok) fail(error);
            if (flags.json) {
                console.log(output.formatContextJson(ctx));
            } else {
                const { text, expandable } = output.formatContext(ctx, {
                    methodsHint: 'Note: obj.method() calls excluded — use --include-methods to include them',
                    expandHint: 'Use "expand <N>" or --expand to see code for items',
                    uncertainHint: 'use --include-uncertain to include all',
                    showConfidence: flags.showConfidence !== false,
                    compact: !!flags.compact,
                });
                console.log(text);

                // Inline expansion of callees when --expand flag is set
                if (flags.expand) {
                    printInlineExpand(ctx, index.root);
                }

                // Save expandable items to cache for 'expand' command
                saveExpandableItems(expandable, index.root);
                if (note) console.error(note);
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
                match, itemNum: expandNum, itemCount: items.length, validateRoot: true
            });
            if (!ok) fail(error);
            if (flags.json) {
                // Honor --json: structured output with the expanded code + metadata.
                const env = {
                    meta: { command: 'expand', item: expandNum },
                    data: {
                        item: expandNum,
                        ...(match && {
                            name: match.name,
                            type: match.type,
                            file: match.relativePath || match.file,
                            startLine: match.startLine,
                            endLine: match.endLine,
                            handle: match.relativePath && match.startLine && match.name
                                ? `${match.relativePath}:${match.startLine}:${match.name}`
                                : null,
                        }),
                        text: result.text,
                    },
                };
                console.log(JSON.stringify(env, null, 2));
            } else {
                console.log(result.text);
            }
            break;
        }

        case 'smart': {
            const { ok, result, error, note } = execute(index, 'smart', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatSmartJson, r => output.formatSmart(r, {
                uncertainHint: 'use --include-uncertain to include all'
            }));
            if (note) console.error(note);
            break;
        }

        case 'about': {
            const { ok, result, error, note } = execute(index, 'about', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result,
                output.formatAboutJson,
                r => output.formatAbout(r, { expand: flags.expand, root: index.root, depth: flags.depth, showConfidence: flags.showConfidence !== false, compact: !!flags.compact, git: !!flags.git })
            );
            if (note) console.error(note);
            break;
        }

        case 'impact': {
            const { ok, result, error, note } = execute(index, 'impact', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatImpactJson, r => output.formatImpact(r, { compact: flags.compact }));
            if (note) console.error(note);
            break;
        }

        case 'blast': {
            const { ok, result, error, note } = execute(index, 'blast', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatBlastJson, output.formatBlast);
            if (note) console.error(note);
            break;
        }

        case 'plan': {
            const { ok, result, error } = execute(index, 'plan', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatPlanJson, output.formatPlan);
            break;
        }

        case 'trace': {
            const { ok, result, error, note } = execute(index, 'trace', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatTraceJson, output.formatTrace);
            if (note) console.error(note);
            break;
        }

        case 'reverseTrace': {
            const { ok, result, error, note } = execute(index, 'reverseTrace', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatReverseTraceJson, output.formatReverseTrace);
            if (note) console.error(note);
            break;
        }

        case 'stacktrace': {
            const { ok, result, error } = execute(index, 'stacktrace', { stack: flags.stack || arg });
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
            const { ok, result, error, note } = execute(index, 'related', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatRelatedJson, r => output.formatRelated(r, { all: flags.all, top: flags.top }));
            if (note) console.error(note);
            break;
        }

        case 'brief': {
            requireArg(arg, 'Usage: ucn . brief <name>');
            const { ok, result, error } = execute(index, 'brief', { name: arg, file: flags.file, className: flags.className, git: flags.git });
            if (!ok) fail(error);
            printOutput(result, output.formatBriefJson, output.formatBrief);
            break;
        }

        case 'doctor': {
            const { ok, result, error } = execute(index, 'doctor', {
                file: flags.file, in: flags.in,
                limit: flags.limit, deep: flags.deep,
            });
            if (!ok) fail(error);
            printOutput(result, output.formatDoctorJson, output.formatDoctor);
            break;
        }

        case 'check': {
            const { ok, result, error } = execute(index, 'check', {
                base: flags.base, staged: flags.staged,
                file: flags.file, limit: flags.limit,
            });
            if (!ok) fail(error);
            printOutput(result, output.formatCheckJson, output.formatCheck);
            break;
        }

        // ── Extraction commands (via execute) ────────────────────────────

        case 'fn': {
            requireArg(arg, 'Usage: ucn . fn <name>');
            const { ok, result, error, note } = execute(index, 'fn', { name: arg, file: flags.file, all: flags.all, className: flags.className });
            if (!ok) fail(error);
            if (note) console.error(note);
            printOutput(result, output.formatFnResultJson, output.formatFnResult);
            break;
        }

        case 'class': {
            requireArg(arg, 'Usage: ucn . class <name>');
            const { ok, result, error, note } = execute(index, 'class', { name: arg, file: flags.file, all: flags.all, maxLines: flags.maxLines });
            if (!ok) fail(error);
            if (note) console.error(note);
            printOutput(result, output.formatClassResultJson, output.formatClassResult);
            break;
        }

        case 'lines': {
            requireArg(arg, 'Usage: ucn . lines <range> --file <path>');
            const { ok, result, error, note } = execute(index, 'lines', { file: flags.file, range: arg });
            if (!ok) fail(error);
            if (note) console.error(note);
            printOutput(result, output.formatLinesJson, r => output.formatLines(r));
            break;
        }

        // ── File dependency commands ────────────────────────────────────

        case 'imports': {
            const filePath = arg || flags.file;
            const { ok, result, error } = execute(index, 'imports', { file: filePath });
            if (!ok) fail(error);
            printOutput(result,
                r => output.formatImportsJson(r, filePath),
                r => output.formatImports(r, filePath)
            );
            break;
        }

        case 'exporters': {
            const filePath = arg || flags.file;
            const { ok, result, error } = execute(index, 'exporters', { file: filePath });
            if (!ok) fail(error);
            printOutput(result,
                r => output.formatExportersJson(r, filePath),
                r => output.formatExporters(r, filePath)
            );
            break;
        }

        case 'fileExports': {
            const filePath = arg || flags.file;
            const { ok, result, error } = execute(index, 'fileExports', { file: filePath });
            if (!ok) fail(error);
            printOutput(result,
                r => output.formatFileExportsJson(r, filePath),
                r => output.formatFileExports(r, filePath)
            );
            break;
        }

        case 'graph': {
            const filePath = arg || flags.file;
            const { ok, result, error } = execute(index, 'graph', { file: filePath, direction: flags.direction, depth: flags.depth, all: flags.all });
            if (!ok) fail(error);
            printOutput(result,
                output.formatGraphJson,
                r => output.formatGraph(r, { showAll: flags.all || flags.depth != null, maxDepth: flags.depth != null ? parseInt(flags.depth, 10) : 2, file: filePath })
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
            const { ok, result, error } = execute(index, 'typedef', { name: arg, exact: flags.exact, file: flags.file, className: flags.className });
            if (!ok) fail(error);
            printOutput(result,
                r => output.formatTypedefJson(r, arg),
                r => output.formatTypedef(r, arg)
            );
            break;
        }

        case 'tests': {
            const { ok, result, error } = execute(index, 'tests', { name: arg, callsOnly: flags.callsOnly, className: flags.className, file: flags.file, exclude: flags.exclude });
            if (!ok) fail(error);
            const displayName = nameForDisplay(arg);
            printOutput(result,
                r => output.formatTestsJson(r, displayName),
                r => output.formatTests(r, displayName)
            );
            break;
        }

        case 'affectedTests': {
            const { ok, result, error, note } = execute(index, 'affectedTests', { name: arg, ...flags });
            if (!ok) fail(error);
            printOutput(result, output.formatAffectedTestsJson, r => output.formatAffectedTests(r, { all: flags.all }));
            if (note) console.error(note);
            break;
        }

        case 'api': {
            const filePath = arg || flags.file;
            const { ok, result, error, note } = execute(index, 'api', { file: filePath, limit: flags.limit });
            if (!ok) fail(error);
            if (note) console.error(note);
            printOutput(result,
                r => output.formatApiJson(r, filePath),
                r => output.formatApi(r, filePath)
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
                    exportedHint: !flags.includeExported && result.excludedExported > 0 ? `${result.excludedExported} exported symbol(s) excluded (all have callers). Use --include-exported to audit them.` : undefined,
                    externalContractHint: !flags.includeExported && result.excludedExternalContract > 0 ? `${result.excludedExternalContract} symbol(s) hidden (override an out-of-tree base class — reachable via external contract, not dead). Use --include-exported to include them.` : undefined
                })
            );
            break;
        }

        case 'entrypoints': {
            const { ok, result, error, note } = execute(index, 'entrypoints', { type: flags.type, framework: flags.framework, file: flags.file, exclude: flags.exclude, includeTests: flags.includeTests, excludeTests: flags.excludeTests, limit: flags.limit });
            if (!ok) fail(error);
            if (note) console.error(note);
            printOutput(result,
                output.formatEntrypointsJson,
                r => output.formatEntrypoints(r)
            );
            break;
        }

        case 'endpoints': {
            const { ok, result, error, note } = execute(index, 'endpoints', {
                file: flags.file,
                exclude: flags.exclude,
                limit: flags.limit,
                framework: flags.framework,
                bridge: flags.bridge,
                serverOnly: flags.serverOnly,
                clientOnly: flags.clientOnly,
                unmatched: flags.unmatched,
                method: flags.method,
                prefix: flags.prefix,
                hideUncertain: flags.hideUncertain,
            });
            if (!ok) fail(error);
            if (note) console.error(note);
            printOutput(result,
                output.formatEndpointsJson,
                r => output.formatEndpoints(r, { bridge: r._bridge, unmatched: r._unmatched })
            );
            break;
        }

        case 'stats': {
            // MEDIUM-7: pass the raw --top value when present so the executor
            // can validate it and surface "Invalid --top" errors. Without
            // this, --top=abc is silently coerced to NaN → undefined and
            // the user gets the default (10) with no warning.
            const topVal = flags.topRaw != null ? flags.topRaw : (flags.top || undefined);
            const { ok, result, error, note } = execute(index, 'stats', {
                functions: flags.functions,
                hot: flags.hot,
                top: topVal,
            });
            if (!ok) fail(error);
            if (note) console.error(note);
            printOutput(result,
                output.formatStatsJson,
                r => output.formatStats(r, { top: flags.top })
            );
            break;
        }

        case 'diffImpact': {
            const { ok, result, error, note } = execute(index, 'diffImpact', { base: flags.base, staged: flags.staged, file: flags.file, limit: flags.limit, all: flags.all });
            if (!ok) fail(error);
            if (note) console.error(note);
            printOutput(result, output.formatDiffImpactJson, r => output.formatDiffImpact(r, { all: flags.all }));
            break;
        }

        case 'auditAsync': {
            const { ok, result, error, note } = execute(index, 'auditAsync', {
                file: flags.file,
                exclude: flags.exclude,
                limit: flags.limit,
            });
            if (!ok) fail(error);
            if (note) console.error(note);
            printOutput(result, output.formatAuditAsyncJson, output.formatAuditAsync);
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
        // On cache-hit runs, only re-save if callsCache was mutated OR
        // reachability was computed (MED-1: persists the BFS result so
        // subsequent cold invocations don't repeat the 7-11s tax).
        if (flags.cache && (needsCacheSave || index.callsCacheDirty || index.reachabilityDirty)) {
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

    const canonical = resolveCommand(command, 'cli') || command;

    // Build a temporary index over the matched files and route through execute().
    // This gives glob mode the same semantics as project mode: test exclusions,
    // limit, all flags — no bespoke logic, no parity drift.
    const rootDir = findProjectRoot(path.dirname(files[0]));
    const index = new ProjectIndex(rootDir);
    index.build(files, { quiet: true });

    // Supported commands — anything that works with an index.
    // All execute() commands are supported; only expand (requires cached state)
    // and interactive-only commands are excluded.
    const unsupportedGlobCommands = new Set(['expand']);
    if (unsupportedGlobCommands.has(canonical)) {
        console.error(`Command "${command}" not supported in glob mode.`);
        process.exit(1);
    }

    // Build params — same as project mode
    const params = {};
    const needsName = new Set(['find', 'usages', 'fn', 'class', 'typedef', 'about', 'context',
        'smart', 'impact', 'trace', 'blast', 'reverseTrace', 'tests', 'affectedTests',
        'example', 'verify', 'plan', 'related']);
    if (needsName.has(canonical)) {
        if (!arg) {
            console.error(`Usage: ucn "pattern" ${command} <name>`);
            process.exit(1);
        }
        params.name = arg;
    }
    if (canonical === 'search' || canonical === 'structuralSearch') {
        if (!arg && !flags.type) {
            console.error('Usage: ucn "pattern" search <term>');
            process.exit(1);
        }
        params.term = arg;
    }
    // Merge flags first, then set positional overrides so they aren't wiped
    Object.assign(params, flags);

    // Warn about inapplicable flags (same check as project/interactive mode)
    const applicableFlags = FLAG_APPLICABILITY[canonical];
    if (applicableFlags) {
        const flagToCli = (f) => '--' + f.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
        const globalFlags = new Set(['json', 'quiet', 'cache', 'clearCache', 'followSymlinks', 'maxFiles', 'verbose', 'expand', 'interactive', '_fileFromFileMode', 'topRaw', 'limitRaw', 'maxFilesRaw', 'maxLinesRaw', 'depthRaw', 'contextRaw', 'workersRaw']);
        for (const [key, value] of Object.entries(flags)) {
            if (globalFlags.has(key)) continue;
            if (value === undefined || value === null || value === 0 || (Array.isArray(value) && value.length === 0)) continue;
            if (!applicableFlags.includes(key)) {
                console.error(`Warning: ${flagToCli(key)} has no effect on '${toCliName(canonical)}'.`);
            }
        }
    }
    if (canonical === 'stacktrace' && arg) {
        params.stack = arg;
    }
    if (canonical === 'lines' && arg) {
        params.range = arg;
    }
    if (['imports', 'exporters', 'fileExports', 'graph', 'api'].includes(canonical)) {
        if (arg) params.file = arg;
    }

    const { ok, result, error, note, structural } = execute(index, canonical, params);
    if (!ok) fail(error);
    if (note) console.error(note);

    // Format output — same formatters as project mode
    switch (canonical) {
        case 'toc':
            printOutput(result, output.formatTocJson, r => output.formatToc(r, {
                detailedHint: 'Add --detailed to list all functions, or "ucn . about <name>" for full details on a symbol'
            }));
            break;
        case 'find':
            printOutput(result,
                r => output.formatSymbolJson(r, arg),
                r => output.formatFindDetailed(r, arg, { depth: flags.depth, top: flags.top, all: flags.all })
            );
            break;
        case 'search':
            if (structural) {
                printOutput(result, output.formatStructuralSearchJson, output.formatStructuralSearch);
            } else {
                printOutput(result,
                    r => output.formatSearchJson(r, arg),
                    r => output.formatSearch(r, arg)
                );
            }
            break;
        case 'fn':
            printOutput(result, output.formatFnResultJson, output.formatFnResult);
            break;
        case 'class':
            printOutput(result, output.formatClassResultJson, output.formatClassResult);
            break;
        case 'usages':
            printOutput(result, r => output.formatUsagesJson(r, arg), r => output.formatUsages(r, arg));
            break;
        case 'deadcode':
            printOutput(result, output.formatDeadcodeJson, r => output.formatDeadcode(r, { top: flags.top }));
            break;
        case 'typedef':
            printOutput(result, r => output.formatTypedefJson(r, arg), r => output.formatTypedef(r, arg));
            break;
        case 'stats':
            printOutput(result, output.formatStatsJson, r => output.formatStats(r, { top: flags.top }));
            break;
        case 'about':
            printOutput(result, output.formatAboutJson,
                r => output.formatAbout(r, { expand: flags.expand, root: index.root, depth: flags.depth, showConfidence: flags.showConfidence !== false, compact: !!flags.compact }));
            break;
        case 'context':
            if (flags.json) {
                console.log(output.formatContextJson(result));
            } else {
                const { text } = output.formatContext(result, {
                    methodsHint: 'Note: obj.method() calls excluded — use --include-methods to include them',
                    uncertainHint: 'use --include-uncertain to include all',
                    expandHint: 'Use --expand to see inline callee previews',
                    showConfidence: flags.showConfidence !== false,
                    compact: !!flags.compact,
                });
                console.log(text);
                if (flags.expand) {
                    printInlineExpand(result, index.root);
                }
            }
            break;
        case 'smart':
            printOutput(result, output.formatSmartJson, output.formatSmart);
            break;
        case 'impact':
            printOutput(result, output.formatImpactJson, output.formatImpact);
            break;
        case 'related':
            printOutput(result, output.formatRelatedJson,
                r => output.formatRelated(r, { all: flags.all, top: flags.top }));
            break;
        case 'brief':
            printOutput(result, output.formatBriefJson, output.formatBrief);
            break;
        case 'doctor':
            printOutput(result, output.formatDoctorJson, output.formatDoctor);
            break;
        case 'check':
            printOutput(result, output.formatCheckJson, output.formatCheck);
            break;
        case 'trace':
            printOutput(result, output.formatTraceJson, output.formatTrace);
            break;
        case 'blast':
            printOutput(result, output.formatBlastJson, output.formatBlast);
            break;
        case 'reverseTrace':
            printOutput(result, output.formatReverseTraceJson, output.formatReverseTrace);
            break;
        case 'tests':
            printOutput(result, r => output.formatTestsJson(r, arg), r => output.formatTests(r, arg));
            break;
        case 'affectedTests':
            printOutput(result, output.formatAffectedTestsJson,
                r => output.formatAffectedTests(r, { all: flags.all }));
            break;
        case 'example':
            printOutput(result, r => output.formatExampleJson(r, arg), r => output.formatExample(r, arg));
            break;
        case 'verify':
            printOutput(result, output.formatVerifyJson, output.formatVerify);
            break;
        case 'plan':
            printOutput(result, output.formatPlanJson, output.formatPlan);
            break;
        case 'imports': {
            const filePath = params.file;
            printOutput(result, r => output.formatImportsJson(r, filePath), r => output.formatImports(r, filePath));
            break;
        }
        case 'exporters': {
            const filePath = params.file;
            printOutput(result, r => output.formatExportersJson(r, filePath), r => output.formatExporters(r, filePath));
            break;
        }
        case 'fileExports': {
            const filePath = params.file;
            printOutput(result, r => output.formatFileExportsJson(r, filePath), r => output.formatFileExports(r, filePath));
            break;
        }
        case 'api': {
            const filePath = params.file;
            printOutput(result, r => output.formatApiJson(r, filePath), r => output.formatApi(r, filePath));
            break;
        }
        case 'graph':
            printOutput(result, output.formatGraphJson,
                r => output.formatGraph(r, { showAll: flags.all || flags.depth != null, maxDepth: flags.depth }));
            break;
        case 'circularDeps':
            printOutput(result, output.formatCircularDepsJson, output.formatCircularDeps);
            break;
        case 'entrypoints':
            printOutput(result, output.formatEntrypointsJson, output.formatEntrypoints);
            break;
        case 'endpoints':
            printOutput(result, output.formatEndpointsJson, r => output.formatEndpoints(r, { bridge: r._bridge, unmatched: r._unmatched }));
            break;
        case 'diffImpact':
            printOutput(result, output.formatDiffImpactJson, output.formatDiffImpact);
            break;
        case 'auditAsync':
            printOutput(result, output.formatAuditAsyncJson, output.formatAuditAsync);
            break;
        case 'stacktrace':
            printOutput(result, output.formatStackTraceJson, output.formatStackTrace);
            break;
        case 'lines':
            printOutput(result, output.formatLinesJson, output.formatLines);
            break;
        default: {
            // Fallback: output JSON for any command without a dedicated formatter
            if (flags.json) {
                console.log(JSON.stringify({ meta: {}, data: result }, null, 2));
            } else {
                console.log(JSON.stringify(result, null, 2));
            }
            break;
        }
    }
}

// ============================================================================
// HELPERS
// ============================================================================


// Single source of truth for the public CLI help. README points here ("Run `ucn --help`")
// rather than carrying a copy — keep it that way.
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
  brief <name>        One-screen summary (signature, docstring, side effects, complexity)
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
  tests <name>        Find test files for a function (--file, --class-name, --exclude, --calls-only)
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
  check               Pre-commit summary: diff-impact + verify + affected-tests in one shot
  deadcode            Find unused functions/classes
  entrypoints         Detect framework entry points (routes, DI, tasks)
  endpoints           HTTP API: list server routes + client requests; --bridge to match
                        --bridge --server-only --client-only --unmatched
                        --method=GET --prefix=/api --hide-uncertain

═══════════════════════════════════════════════════════════════════════════════
OTHER
═══════════════════════════════════════════════════════════════════════════════
  api                 Show exported/public symbols
  typedef <name>      Find type definitions
  stats               Project statistics (--functions for per-function line counts, --hot for top callers)
  doctor              Project trust report (counts, blind spots, parse failures, verdict; --deep for resolution coverage)
  stacktrace <text>   Parse stack trace, show code at each frame (alias: stack)
  audit-async         Find calls in async functions that are likely missing await (JS/TS/Python)

Common Flags:
  --file <pattern>    Filter by file path (e.g., --file=routes)
  --exclude=a,b       Exclude patterns (e.g., --exclude=test,mock)
  --in=<path>         Only in path (e.g., --in=src/core)
  --depth=N           Max depth: blast=3, trace=3, reverse-trace=5, graph=2, affected-tests=3
  --direction=X       Graph direction: imports, importers, or both (default: both)
  --all               Show full results: all callers/callees + unverified (about/context), full tree (trace/blast),
                        all names (related/find/fn/class/toc), all changed (diff-impact)
  --top=N             Limit callers/callees (about), similar functions (related), search results
  --limit=N           Limit result count (find, usages, search, deadcode, api, toc, entrypoints, diff-impact)
  --max-files=N       Max files to index (large projects)
  --context=N         Lines of context around matches (search, usages)
  --json              Machine-readable output
  --code-only         Filter out comments/strings (search, usages)
  --with-types        Include type definitions (about, smart)
  --detailed          Show all symbols in toc (not just counts)
  --include-tests     Include test files in usage counts (about) and results (find, usages, deadcode)
  --exclude-tests     Exclude test files (entrypoints — tests are included by default)
  --class-name=X      Scope to specific class (e.g., --class-name=Repository)
  --include-methods   Include method calls (obj.fn) in trace/blast/smart/verify analysis
                        (implied for about/context/impact — method calls are tiered by evidence)
  --include-uncertain Include ambiguous/uncertain matches in smart/verify
                        (implied for about/context/impact/trace/blast/reverse-trace/affected-tests —
                        unverified candidates always shown, tiered)
  --expand-unverified Follow unverified caller edges in blast/reverse-trace trees
                        (downstream nodes marked as unverified chains — possible, not confirmed, impact)
  --hide-confidence   Hide confidence scores (shown by default in about, context)
  --min-confidence=N  Filter low-confidence edges (about, context, blast, trace,
                        reverse-trace, smart, affected-tests)
  --unreachable-only  Show only callers/callees that are unreachable from entry points (about, context, impact)
  --include-exported  Include exported symbols in deadcode
  --no-regex          Force plain text search (regex is default)
  --functions         Show per-function line counts (stats command)
  --hot               Show top N most-called functions (stats command, pair with --top=N)
  --diverse           Cluster call sites by argument shape (example command, pair with --top=N)
  --git               Attach git enrichment (last modified, author, recent commits) to about/brief
  --include-decorated Include decorated/annotated symbols in deadcode
  --framework=X       Filter entrypoints by framework (e.g., --framework=express,spring)
  --bridge            Match server routes to client requests (endpoints command).
                        Confidence tiers: EXACT, PARTIAL, UNCERTAIN
  --server-only       Only list server routes (endpoints command)
  --client-only       Only list client requests (endpoints command)
  --unmatched         Only show routes/requests with no match (endpoints, pair with --bridge)
  --method=X          Filter by HTTP method (endpoints, e.g., --method=POST)
  --prefix=X          Filter routes/requests by path prefix (endpoints, e.g., --prefix=/api)
  --hide-uncertain    Hide UNCERTAIN-confidence bridges (endpoints command)
  --exact             Exact name match only (find, typedef)
  --calls-only        Only show call/test-case matches (tests)
  --case-sensitive    Case-sensitive text search (search)
  --top-level         Show only top-level functions in toc
  --max-lines=N       Max source lines for class (large classes show summary)
  --workers=N         Parallel build workers (auto-detect; 0 to disable, env: UCN_WORKERS)
  --no-cache          Disable caching
  --clear-cache       Clear cache before running
  --base=<ref>        Git ref for diff-impact (default: HEAD)
  --staged            Analyze staged changes (diff-impact)
  --no-follow-symlinks  Don't follow symbolic links
  -i, --interactive   Keep index in memory for multiple queries
  -v, --version       Print the UCN version and exit

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
    index.build(null, { quiet: true, workers: flags.workers });
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
  tests <name>           Find tests (--file, --class-name, --exclude, --calls-only)
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
            index.build(null, { quiet: true, forceRebuild: true, workers: flags.workers });
            // Clear expand cache — stale line ranges after rebuild
            if (iExpandCache) iExpandCache.clearForRoot(index.root);
            console.log(`Index ready: ${index.files.size} files, ${index.symbols.size} symbols`);
            rl.prompt();
            return;
        }

        // Parse command, flags, and arg from interactive input
        const tokens = input.split(/\s+/);
        const command = tokens[0];
        // Flags that take a space-separated value (--flag value)
        const valueFlagNames = new Set(['--file', '--in', '--base', '--add-param', '--remove-param', '--rename-to', '--default', '--depth', '--top', '--context', '--max-lines', '--direction', '--exclude', '--not', '--stack', '--type', '--param', '--receiver', '--returns', '--decorator', '--limit', '--max-files', '--min-confidence', '--class-name', '--framework', '--method', '--prefix']);
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
            // Validate numeric flags (--top, --limit, etc) — same rules as
            // global CLI mode. MED-2/MED-3/MED-5: bad values are rejected with
            // a helpful message instead of being silently coerced.
            validateNumericFlags(iflags);
            const iCanonical = resolveCommand(command, 'cli') || command;
            executeInteractiveCommand(index, iCanonical, arg, iflags, iExpandCache);
        } catch (e) {
            if (e instanceof FlagValidationError) {
                console.log(e.message);
            } else {
                console.error(`Error: ${e.message}`);
            }
        }

        rl.prompt();
    });

    rl.on('close', () => {
        process.exit(0);
    });
}

// parseInteractiveFlags removed — both global and interactive mode now use parseFlags()

// ── Data-driven interactive command dispatch ─────────────────────────────
//
// Each entry maps a canonical command name to:
//   params: (arg, iflags) => execute() params object
//   format: (result, arg, iflags, index) => formatted string
//
// The generic handler calls execute(), checks errors, prints notes, and
// formats the result. Only commands with truly unique behavior (expand
// cache save, file writing, conditional formatters) keep explicit cases.

const INTERACTIVE_DISPATCH = {
    // ── Understanding Code ───────────────────────────────────────────
    about:        { params: 'name', format: (r, _a, f, idx) => output.formatAbout(r, { expand: f.expand, root: idx.root, showAll: f.all, depth: f.depth, showConfidence: f.showConfidence !== false, git: !!f.git }) },
    smart:        { params: 'name', format: (r) => output.formatSmart(r, { uncertainHint: 'use --include-uncertain to include all' }) },
    impact:       { params: 'name', format: (r) => output.formatImpact(r) },
    blast:        { params: 'name', format: (r) => output.formatBlast(r) },
    trace:        { params: 'name', format: (r) => output.formatTrace(r) },
    reverseTrace: { params: 'name', format: (r) => output.formatReverseTrace(r) },
    related:      { params: 'name', format: (r, _a, f) => output.formatRelated(r, { all: f.all, top: f.top }) },
    example:      { params: (a, f) => ({ name: a, file: f.file, className: f.className, diverse: f.diverse, top: f.top || undefined, includeTests: f.includeTests }), format: (r, a) => output.formatExample(r, a) },
    brief:        { params: 'name', format: (r) => output.formatBrief(r) },

    // ── Finding Code ─────────────────────────────────────────────────
    find:          { params: 'name', format: (r, a, f) => output.formatFindDetailed(r, a, { depth: f.depth, top: f.top, all: f.all }) },
    usages:        { params: 'name', format: (r, a) => output.formatUsages(r, a) },
    toc:           { params: 'flags', format: (r) => output.formatToc(r, { detailedHint: 'Add --detailed to list all functions, or "about <name>" for full details on a symbol', uncertainHint: 'use --include-uncertain to include all' }) },
    tests:         { params: 'name', format: (r, a) => output.formatTests(r, a) },
    affectedTests: { params: 'name', format: (r, _a, f) => output.formatAffectedTests(r, { all: f.all }) },
    typedef:       { params: 'name', format: (r, a) => output.formatTypedef(r, a) },

    // ── File Dependencies ────────────────────────────────────────────
    imports:      { params: 'file', format: (r, a, f) => output.formatImports(r, a || f.file) },
    exporters:    { params: 'file', format: (r, a, f) => output.formatExporters(r, a || f.file) },
    fileExports:  { params: 'file', format: (r, a, f) => output.formatFileExports(r, a || f.file) },
    graph:        { params: (a, f) => ({ file: a || f.file, direction: f.direction, depth: f.depth, all: f.all }), format: (r, a, f) => { const d = f.depth ? parseInt(f.depth) : 2; return output.formatGraph(r, { showAll: f.all || !!f.depth, maxDepth: d, file: a || f.file }); } },
    circularDeps: { params: (a, f) => ({ file: f.file, exclude: f.exclude }), format: (r) => output.formatCircularDeps(r) },

    // ── Refactoring Helpers ──────────────────────────────────────────
    plan:         { params: 'name', format: (r) => output.formatPlan(r) },
    verify:       { params: 'name', format: (r) => output.formatVerify(r) },
    diffImpact:   { params: (a, f) => ({ base: f.base, staged: f.staged, file: f.file, limit: f.limit, all: f.all }), format: (r, _a, f) => output.formatDiffImpact(r, { all: f.all }) },
    check:        { params: (a, f) => ({ base: f.base, staged: f.staged, file: f.file, limit: f.limit }), format: (r) => output.formatCheck(r) },
    entrypoints:  { params: (a, f) => ({ type: f.type, framework: f.framework, file: f.file, exclude: f.exclude, includeTests: f.includeTests, excludeTests: f.excludeTests, limit: f.limit }), format: (r) => output.formatEntrypoints(r) },
    endpoints:    { params: (a, f) => ({ file: f.file, exclude: f.exclude, limit: f.limit, framework: f.framework, bridge: f.bridge, serverOnly: f.serverOnly, clientOnly: f.clientOnly, unmatched: f.unmatched, method: f.method, prefix: f.prefix, hideUncertain: f.hideUncertain }), format: (r) => output.formatEndpoints(r, { bridge: r._bridge, unmatched: r._unmatched }) },

    // ── Other ────────────────────────────────────────────────────────
    api:          { params: (a, f) => ({ file: a || f.file, limit: f.limit }), format: (r, a, f) => output.formatApi(r, a || f.file || '.') },
    stacktrace:   { params: (a, f) => ({ stack: f.stack || a }), format: (r) => output.formatStackTrace(r) },
    doctor:       { params: (a, f) => ({ file: f.file, in: f.in, limit: f.limit, deep: f.deep }), format: (r) => output.formatDoctor(r) },
    // MED-2: stats handler in execute.js rejects top<=0; without explicit
    // coercion, parseFlags's `top: 0` default would surface as
    // "Invalid --top value" on bare `stats`. Mirror the project-mode top
    // coercion (topRaw when present, else undefined for default-10).
    stats:        { params: (a, f) => ({ functions: f.functions, hot: f.hot, top: f.topRaw != null ? f.topRaw : (f.top || undefined) }), format: (r, _a, f) => output.formatStats(r, { top: f.top }) },
    auditAsync:   { params: (a, f) => ({ file: f.file, exclude: f.exclude, limit: f.limit }), format: (r) => output.formatAuditAsync(r) },
};

/**
 * Build execute() params from a dispatch entry's params descriptor.
 *   'name'  → { name: arg, ...iflags }
 *   'file'  → { file: arg }
 *   'flags' → iflags (no arg)
 *   function → custom builder
 */
function buildInteractiveParams(descriptor, arg, iflags) {
    if (typeof descriptor === 'function') return descriptor(arg, iflags);
    switch (descriptor) {
        case 'name':  return { name: arg, ...iflags };
        case 'file':  return { file: arg || iflags.file };
        case 'flags': return iflags;
        default:      return { name: arg, ...iflags };
    }
}

function executeInteractiveCommand(index, command, arg, iflags = {}, cache = null) {
    // Warn about inapplicable flags (same check as project mode)
    const applicableFlags = FLAG_APPLICABILITY[command];
    if (applicableFlags) {
        const flagToCli = (f) => '--' + f.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
        const globalFlags = new Set(['json', 'quiet', 'cache', 'clearCache', 'followSymlinks', 'maxFiles', 'verbose', 'expand', 'interactive', '_fileFromFileMode', 'topRaw', 'limitRaw', 'maxFilesRaw', 'maxLinesRaw', 'depthRaw', 'contextRaw', 'workersRaw']);
        for (const [key, value] of Object.entries(iflags)) {
            if (globalFlags.has(key)) continue;
            if (value === undefined || value === null || value === 0 || (Array.isArray(value) && value.length === 0)) continue;
            if (!applicableFlags.includes(key)) {
                console.log(`Warning: ${flagToCli(key)} has no effect on '${command}'.`);
            }
        }
    }

    // ── Commands with unique behavior (not data-driven) ──────────────
    switch (command) {

        case 'fn': {
            if (!arg) { console.log('Usage: fn <name>[,name2,...] [--file=<pattern>] [--class-name=<class>]'); return; }
            const { ok, result, error, note } = execute(index, 'fn', { name: arg, file: iflags.file, all: iflags.all, className: iflags.className });
            if (!ok) { console.log(error); return; }
            if (note) console.log(note);
            console.log(output.formatFnResult(result));
            break;
        }

        case 'class': {
            if (!arg) { console.log('Usage: class <name> [--file=<pattern>]'); return; }
            const { ok, result, error, note } = execute(index, 'class', { name: arg, file: iflags.file, all: iflags.all, maxLines: iflags.maxLines });
            if (!ok) { console.log(error); return; }
            if (note) console.log(note);
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
                match, itemNum: expandNum, itemCount, symbolName, validateRoot: true
            });
            if (!ok) { console.log(error); return; }
            console.log(result.text);
            break;
        }

        case 'context': {
            const { ok, result, error, note } = execute(index, 'context', { name: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            const { text, expandable } = output.formatContext(result, {
                methodsHint: 'Note: obj.method() calls excluded — use --include-methods to include them',
                expandHint: 'Use "expand <N>" to see code for item N',
                uncertainHint: 'use --include-uncertain to include all',
                showConfidence: iflags.showConfidence !== false,
            });
            console.log(text);
            if (iflags.expand) {
                printInlineExpand(result, index.root);
            }
            if (note) console.log(note);
            if (cache) {
                cache.save(index.root, arg, iflags.file, expandable);
            } else {
                saveExpandableItems(expandable, index.root);
            }
            break;
        }

        case 'deadcode': {
            const { ok, result, error, note } = execute(index, 'deadcode', iflags);
            if (!ok) { console.log(error); return; }
            if (note) console.log(note);
            console.log(output.formatDeadcode(result, {
                top: iflags.top,
                decoratedHint: !iflags.includeDecorated && result.excludedDecorated > 0 ? `${result.excludedDecorated} decorated/annotated symbol(s) hidden (framework-registered). Use --include-decorated to include them.` : undefined,
                exportedHint: !iflags.includeExported && result.excludedExported > 0 ? `${result.excludedExported} exported symbol(s) excluded (all have callers). Use --include-exported to audit them.` : undefined,
                externalContractHint: !iflags.includeExported && result.excludedExternalContract > 0 ? `${result.excludedExternalContract} symbol(s) hidden (override an out-of-tree base class — reachable via external contract, not dead). Use --include-exported to include them.` : undefined
            }));
            break;
        }

        case 'search': {
            const { ok, result, error, structural, note } = execute(index, 'search', { term: arg, ...iflags });
            if (!ok) { console.log(error); return; }
            if (note) console.log(note);
            if (structural) {
                console.log(output.formatStructuralSearch(result));
            } else {
                console.log(output.formatSearch(result, arg));
            }
            break;
        }

        default: {
            // ── Data-driven dispatch for standard commands ────────────
            const entry = INTERACTIVE_DISPATCH[command];
            if (!entry) {
                console.log(`Unknown command: ${command}. Type "help" for available commands.`);
                return;
            }
            const params = buildInteractiveParams(entry.params, arg, iflags);
            const { ok, result, error, note } = execute(index, command, params);
            if (!ok) { console.log(error); return; }
            if (note) console.log(note);
            console.log(entry.format(result, arg, iflags, index));
        }
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
