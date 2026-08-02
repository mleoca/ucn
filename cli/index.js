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
const {
    getCliCommandSet,
    resolveCommand,
    suggestCommand,
    FLAG_APPLICABILITY,
    toCliName,
    FILE_LOCAL_COMMANDS,
    formatSurfaceMessage,
    getCliFlagsForCommand,
    getCliAcceptedFlags,
} = require('../core/registry');
const { buildPublicParams, isPublicCommand } = require('../core/public-command');
const { execute } = require('../core/execute');
const { applyOutputBudget, MAX_OUTPUT_CHARS } = require('../core/output-budget');

let activeCanonicalCommand = null;

// Sentinel error for command failures that have already printed their message.
// Thrown instead of process.exit(1) so finally blocks can run (cache save).
class CommandError extends Error { constructor() { super(); } }

// Thrown by validateNumericFlags when a numeric flag has a bad value.
// The CLI top-level catches this, prints the message, and exits 1. Interactive
// mode catches it inside its REPL try/catch and continues the session.
class FlagValidationError extends Error {
    constructor(msg) { super(msg); this.name = 'FlagValidationError'; }
}

function unknownCommandMessage(command, { interactive = false } = {}) {
    const suggestion = suggestCommand(command, 'cli');
    const correction = suggestion ? ` Did you mean "${suggestion}"?` : '';
    const help = interactive && !suggestion ? ' Type "help" for available commands.' : '';
    return `Unknown command: ${command}.${correction}${help}`;
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
    // --top: positive integer, no zero. Used by show/find/repo/etc.
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
    // --max-lines: positive integer, no zero. Used by source.
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
    if (flags.maxCharsRaw != null) {
        flags.maxChars = validatePositiveInt(flags.maxCharsRaw, '--max-chars', {
            cap: MAX_OUTPUT_CHARS,
        });
    }
    // --min-confidence: number in [0,1] (ordinal evidence weight). Anything
    // else used to coerce to 0 silently — "abc" behaved like no filter.
    if (flags.minConfidenceRaw != null) {
        const value = Number(flags.minConfidenceRaw);
        if (flags.minConfidenceRaw === '' || !Number.isFinite(value) ||
            value < 0 || value > 1) {
            throw new FlagValidationError(
                `Invalid --min-confidence value: "${flags.minConfidenceRaw}" — must be a number between 0 and 1.`);
        }
        flags.minConfidence = value;
    }
}

/** Emit the one CLI error contract, including failures before main dispatch. */
function emitCliError(msg, command = activeCanonicalCommand) {
    const wantsJson = process.argv.includes('--json');
    const error = typeof msg === 'string' ? msg : String(msg);
    if (wantsJson) {
        const canonical = command && isPublicCommand(command)
            ? command
            : resolveCommand(command, 'cli');
        const surfaceCommand = canonical
            ? toCliName(canonical)
            : (command ? String(command) : null);
        const env = {
            meta: {
                ok: false,
                ...(surfaceCommand && {
                    command: surfaceCommand,
                    ...(canonical && surfaceCommand !== canonical && {
                        canonicalCommand: canonical,
                    }),
                    ...(canonical && {
                        contract: output.contractMeta(canonical),
                    }),
                }),
            },
            data: null,
            error,
        };
        try { process.stdout.write(JSON.stringify(env) + '\n'); } catch (_) { /* stdout may be closed */ }
    }
    console.error(error);
}

/**
 * Print an error message and abort command execution. Throw instead of calling
 * process.exit so index/cache finally blocks still run.
 */
function fail(msg, command = activeCanonicalCommand) {
    emitCliError(msg, command);
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
        withSource: tokens.includes('--with-source') || undefined,
        cycles: tokens.includes('--cycles') || undefined,
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
        to: getValueFlag('--to'),
        sections: getValueFlag('--sections'),
        range: getValueFlag('--range'),
        addParam: getValueFlag('--add-param'),
        removeParam: getValueFlag('--remove-param'),
        renameTo: getValueFlag('--rename-to'),
        defaultValue: getValueFlag('--default-value') ?? getValueFlag('--default'),
        base: getValueFlag('--base'),
        staged: tokens.includes('--staged') || undefined,
        deep: tokens.includes('--deep') || undefined,
        compact: tokens.includes('--no-compact')
            ? false
            : (tokens.includes('--compact') ? true : undefined),
        maxLines: getValueFlag('--max-lines') || null,
        maxLinesRaw: getValueFlag('--max-lines'),
        regex: tokens.includes('--regex')
            ? true
            : (tokens.includes('--no-regex') ? false : undefined),
        functions: tokens.includes('--functions') || undefined,
        hot: tokens.includes('--hot') || undefined,
        diverse: tokens.includes('--diverse') || undefined,
        git: tokens.includes('--git') || undefined,
        className: getValueFlag('--class-name'),
        // Explicit line pin (fix #249: our own disambiguation notes advertise
        // line= but no surface accepted it).
        line: parseInt(getValueFlag('--line') || '0', 10) || undefined,
        limit: parseInt(getValueFlag('--limit') || '0') || undefined,
        limitRaw: getValueFlag('--limit'),
        maxFiles: parseInt(getValueFlag('--max-files') || '0') || undefined,
        maxFilesRaw: getValueFlag('--max-files'),
        maxChars: parseInt(getValueFlag('--max-chars') || '0') || undefined,
        maxCharsRaw: getValueFlag('--max-chars'),
        // Structural search flags
        type: getValueFlag('--type'),
        param: getValueFlag('--param'),
        receiver: getValueFlag('--receiver'),
        returns: getValueFlag('--returns'),
        decorator: getValueFlag('--decorator'),
        exported: tokens.includes('--exported') || undefined,
        unused: tokens.includes('--unused') || undefined,
        showConfidence: (tokens.includes('--hide-confidence') || tokens.includes('--no-confidence')) ? false
            : tokens.includes('--show-confidence') ? true : undefined,
        minConfidence: 0,
        minConfidenceRaw: getValueFlag('--min-confidence'),
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
const knownFlags = getCliAcceptedFlags();

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
    emitCliError(
        `Unknown flag(s): ${unknownFlags.join(', ')}. Use --help to see available flags.`,
    );
    process.exit(1);
}

// Validate numeric flag values up front so bad input fails before we build
// any indexes. Applies to --top, --limit, --max-files, --max-lines, --depth,
// --context, --workers. Throws FlagValidationError with a helpful message.
try {
    validateNumericFlags(flags);
} catch (e) {
    if (e instanceof FlagValidationError) {
        emitCliError(e.message);
        process.exit(1);
    }
    throw e;
}

// Value flags that consume the next token (space form: --flag value)
const VALUE_FLAGS = new Set([
    '--file', '--depth', '--top', '--context', '--direction', '--to', '--sections', '--range',
    '--add-param', '--remove-param', '--rename-to', '--default', '--default-value',
    '--base', '--exclude', '--not', '--in', '--max-lines', '--class-name', '--line',
    '--type', '--param', '--receiver', '--returns', '--decorator',
    '--limit', '--max-files', '--max-chars', '--min-confidence', '--stack', '--framework',
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

function formatCliText(command, result, params, execution, displayFlags) {
    const text = output.formatPublicText(command, result, params, {
        ...execution,
        surface: 'cli',
    });
    return applyOutputBudget(text, {
        command,
        maxChars: displayFlags?.maxChars,
        all: !!displayFlags?.all,
        surface: 'cli',
    }).text;
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
        // Standalone `ucn --clear-cache` (the form SKILL.md and README
        // document) clears the current project's cache — falling through to
        // the help banner made it a silent no-op.
        if (flags.clearCache) {
            const index = new ProjectIndex('.');
            const removed = index.clearCache();
            console.log(removed.length > 0
                ? `Cache cleared (${index.root})`
                : `No cache to clear (${index.root})`);
            process.exit(0);
        }
        // No args: show help
        printUsage();
        process.exit(0);
    } else if (positionalArgs.length === 1) {
        // One arg: could be a command (use . as target) or a target (use repo as command)
        if (COMMANDS.has(positionalArgs[0])) {
            target = '.';
            command = positionalArgs[0];
            arg = undefined;
        } else {
            target = positionalArgs[0];
            command = 'repo';
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
        command = positionalArgs[1] || 'repo';
        arg = positionalArgs[2];
        // source accepts `<file> <range>` as two positionals.
        if (command === 'source' && positionalArgs.length > 3) {
            arg = positionalArgs.slice(2).join(' ');
        }
    }

    // Determine mode: single file, glob pattern, or project.
    // CommandError is the fail() control-flow signal — project mode catches
    // it internally, but file/glob mode errors used to escape main() and
    // dump a raw stack trace after the message (fix #249).
    try {
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
            // `ucn missing-dir repo` is a target error. Any other two-token
            // form whose first token is not a path is an unknown command.
            const targetInvocation = positionalArgs.length > 1 &&
                COMMANDS.has(positionalArgs[1]);
            fail(
                targetInvocation
                    ? `Error: "${target}" not found`
                    : unknownCommandMessage(target),
                targetInvocation ? null : target,
            );
        }
    } catch (e) {
        if (!(e instanceof CommandError)) {
            emitCliError(`Error: ${e.message}`);
        }
        process.exitCode = 1;
    }
}

/**
 * Tiered-output contract notes shared by one-shot and interactive mode.
 */
function printTieredNoOpNotes(canonical, flags, print) {
    if (!['show', 'impact', 'trace', 'tests', 'check'].includes(canonical)) return;
    if (['impact', 'trace', 'tests', 'check'].includes(canonical) && flags.includeMethods) {
        print(`Note: --include-methods has no effect on '${toCliName(canonical)}' — method calls are always tiered by receiver evidence.`);
    }
    if (canonical === 'show' && flags.includeMethods) {
        print(`Note: --include-methods on '${toCliName(canonical)}' affects only method-callee display for standalone-function targets — caller tiers are always evidence-based, and method targets analyze method calls by default.`);
    }
}

const GLOBAL_FLAG_KEYS = new Set([
    'json', 'quiet', 'cache', 'clearCache', 'followSymlinks', 'maxFiles',
    'verbose', 'interactive', '_fileFromFileMode', 'topRaw',
    'limitRaw', 'maxFilesRaw', 'maxLinesRaw', 'depthRaw', 'contextRaw',
    'workersRaw', 'maxChars', 'maxCharsRaw', 'minConfidenceRaw',
]);

/** Apply one command/flag policy across project, file, glob, and REPL modes. */
function warnInapplicableFlags(canonical, parsedFlags, print) {
    const applicableFlags = FLAG_APPLICABILITY[canonical];
    if (!applicableFlags) return;
    const flagToCli = (flag) => '--' + flag.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    for (const [key, value] of Object.entries(parsedFlags)) {
        if (GLOBAL_FLAG_KEYS.has(key)) continue;
        if (value === undefined || value === null || value === 0 ||
            (Array.isArray(value) && value.length === 0)) continue;
        if (key === 'file' && parsedFlags._fileFromFileMode) continue;
        if (!applicableFlags.includes(key)) {
            print(`Warning: ${flagToCli(key)} has no effect on '${toCliName(canonical)}'.`);
        }
    }
    printTieredNoOpNotes(canonical, parsedFlags, print);
}

// ============================================================================
// FILE MODE
// ============================================================================

function runFileCommand(filePath, command, arg) {
    const language = detectLanguage(filePath);
    if (!language) {
        fail(`Unsupported file type: ${filePath}`, command);
    }

    const canonical = resolveCommand(command, 'cli') || command;
    activeCanonicalCommand = canonical;

    // Commands that need full project index — auto-route to project mode
    const fileLocalCommands = FILE_LOCAL_COMMANDS;

    if (!fileLocalCommands.has(canonical)) {
        // Auto-detect project root and route to project mode
        const projectRoot = findProjectRoot(path.dirname(filePath));
        let effectiveArg = arg;
        if (canonical === 'deps' && !arg) {
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

    if (!isPublicCommand(canonical)) {
        fail(unknownCommandMessage(command));
    }

    // Require arg for commands that need it.
    const needsArg = {
        show: 'show <name>', find: 'find <name>', usages: 'usages <name>',
        search: 'search <term>', source: 'source <name|range>', trace: 'trace <name>',
        tests: 'tests <name>', plan: 'plan <name>',
    };
    // Structural search doesn't require term
    const isStructural = flags.type || flags.param || flags.receiver || flags.returns || flags.decorator || flags.exported || flags.unused;
    const hasFlagTarget = canonical === 'source' && flags.range;
    if (needsArg[canonical] && !(canonical === 'search' && isStructural) && !hasFlagTarget) {
        requireArg(arg, `Usage: ucn <file> ${needsArg[canonical]}`);
    }

    // Build single-file index and route through the same public executor and
    // formatter used by project/glob/MCP modes.
    const index = new ProjectIndex(path.dirname(filePath));
    index.buildSingleFile(filePath);
    const relativePath = path.relative(index.root, path.resolve(filePath));

    const scopedFlags = { ...flags };
    if (['show', 'find', 'usages', 'source', 'api'].includes(canonical) && !scopedFlags.file) {
        scopedFlags.file = relativePath;
    }
    if (canonical === 'source' && /^\d+(?:-\d+)?$/.test(String(arg || ''))) {
        scopedFlags.range = arg;
        arg = undefined;
    }
    warnInapplicableFlags(canonical, scopedFlags, (message) => console.error(message));
    const params = buildPublicParams(canonical, arg, scopedFlags);
    const execution = execute(index, canonical, params);
    const { ok, result, error } = execution;
    if (!ok) fail(formatSurfaceMessage(error, 'cli'));
    console.log(flags.json
        ? output.formatPublicJson(canonical, result, params, {
            ...execution, surface: 'cli',
        })
        : formatCliText(canonical, result, params, execution, scopedFlags));
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
        const removed = index.clearCache();
        if (removed.length > 0 && !flags.quiet) {
            console.error('Cache cleared');
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
    }

    try {
    // Resolve CLI spelling to the canonical command ID.
    const canonical = resolveCommand(command, 'cli') || command;
    activeCanonicalCommand = canonical;

    if (!isPublicCommand(canonical)) {
        fail(unknownCommandMessage(command));
    }
    warnInapplicableFlags(canonical, flags, (message) => console.error(message));

    // Public commands share one argument builder, executor, and formatter.
    const publicParams = buildPublicParams(canonical, arg, {
        ...flags,
        ...(subdirScope && !flags.in ? { in: subdirScope } : {}),
    });
    const publicExecution = execute(index, canonical, publicParams);
    if (!publicExecution.ok) {
        fail(formatSurfaceMessage(publicExecution.error, 'cli'));
    }
    console.log(flags.json
        ? output.formatPublicJson(canonical, publicExecution.result, publicParams, {
            ...publicExecution, surface: 'cli',
        })
        : formatCliText(canonical, publicExecution.result, publicParams, publicExecution, flags));
    // A gate that could not run (check outside git / bad base ref) must not
    // exit 0 — CI gating on the exit code would read "could not run" as "passed".
    if (publicExecution.result && publicExecution.result.ok === false) {
        process.exitCode = 2;
    }
    } catch (e) {
        if (!(e instanceof CommandError)) {
            emitCliError(`Error: ${e.message}`);
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

// ============================================================================
// GLOB MODE
// ============================================================================

function runGlobCommand(pattern, command, arg) {
    const files = expandGlob(pattern);

    if (files.length === 0) {
        fail(`No files match pattern: ${pattern}`, command);
    }

    const canonical = resolveCommand(command, 'cli') || command;
    activeCanonicalCommand = canonical;

    // Build a temporary index over the matched files and route through execute().
    // This gives glob mode the same semantics as project mode: test exclusions,
    // limit, all flags — no bespoke logic, no parity drift.
    const rootDir = findProjectRoot(path.dirname(files[0]));
    const index = new ProjectIndex(rootDir);
    index.build(files, { quiet: true });

    if (!isPublicCommand(canonical)) {
        fail(unknownCommandMessage(command));
    }
    warnInapplicableFlags(canonical, flags, (message) => console.error(message));
    const publicParams = buildPublicParams(canonical, arg, flags);
    const publicExecution = execute(index, canonical, publicParams);
    if (!publicExecution.ok) {
        fail(formatSurfaceMessage(publicExecution.error, 'cli'));
    }
    console.log(flags.json
        ? output.formatPublicJson(canonical, publicExecution.result, publicParams, {
            ...publicExecution, surface: 'cli',
        })
        : formatCliText(canonical, publicExecution.result, publicParams, publicExecution, flags));
    if (publicExecution.result && publicExecution.result.ok === false) {
        process.exitCode = 2;
    }
}

// ============================================================================
// HELPERS
// ============================================================================


// Single source of truth for the public CLI help. README points here ("Run `ucn --help`")
// rather than carrying a copy — keep it that way.
function printUsage() {
    const perCommandFlags = [...getCliCommandSet()].map(command => {
        const flags = getCliFlagsForCommand(command);
        return `  ${command.padEnd(14)} ${flags.join(' ')}`;
    }).join('\n');
    console.log(`UCN - Universal Code Navigator

Supported: JavaScript/TypeScript, Python, Go, Rust, Java, C, C++, C#, HTML

Usage:
  ucn [command] [args]            Current project
  ucn <file|dir|glob> <command>   Explicit target
  Add --json for a stable { meta, data } envelope.

Commands:
  repo                            Repository overview
    --sections=summary,files,stats,health  Select repository sections
    --deep                         Include deep readiness evidence
  show <symbol>                   Symbol summary and relationships
    --sections=summary,callers,callees,source,dependencies,tests,types,example,related
  find <name>                     Definitions; --type=type, --with-source
  usages <name>                   Calls, imports, definitions, references
  search [term]                   Text or structural search
    literal text by default; --regex enables regular-expression syntax
  source <symbol|file:range>      Exact function, class, or line extraction
  trace <symbol>                  Call graph
    --direction=callees|callers   Downstream or upstream (default: callees)
    --to=entrypoints              Follow callers toward entry points
  impact [symbol]                 Symbol impact; without symbol, Git-diff impact
  tests <symbol>                  Direct tests; --depth=N adds transitive impact
  deps <file>                     File graph; --direction=imports|importers|both
    --detailed                     Include import declarations
  deps --cycles                   Report circular dependencies (no file target)
  api [file]                      Project or file public API
  check [symbol]                  Signature check; without symbol, precommit check
  plan <symbol>                   Preview rename or parameter edits
  entrypoints                     Runtime and framework entry points
  endpoints                       Server/client HTTP surface
  deadcode                        Conservative unreachable-symbol candidates
  audit-async                     Likely missing-await sites
  stacktrace <text>               Resolve runtime frames to source

Common flags:
  --file=PATH --exclude=a,b --in=PATH --depth=N --top=N --limit=N
  --all --compact --no-compact --json --include-tests --class-name=X --line=N
  --range=N-M (source with --file=PATH)
  --base=REF --staged --no-cache --clear-cache --max-files=N --workers=N
  --max-chars=N (text output; default 10K targeted / 3K broad, ceiling 100K)
  Cache: per-user by default; set UCN_CACHE_DIR to override the cache root.

Accepted flags by command:
${perCommandFlags}

Global/build/output flags:
  --help -h --version -v --mcp --json --verbose --no-quiet --quiet
  --interactive -i --no-cache --clear-cache --no-follow-symlinks
  --max-files=N --max-chars=N --workers=N

Boolean aliases:
  --no-include-methods --no-regex --show-confidence --hide-confidence
  --no-confidence --hide-uncertain --no-uncertain --compact --no-compact

Value aliases:
  --not=PATTERN (alias of --exclude) --default=VALUE (alias of --default-value)

Trust:
  CONFIRMED means target-identity evidence exists. UNVERIFIED means possible and
  requires review. ACCOUNT conserves observed text lines; it never proves full
  runtime semantics or safe deletion.

UCN vs grep:
  Use UCN for definitions, callers/callees, impact, tests, dependencies, APIs,
  entry points, and audits. Use grep/ripgrep for simple literals, messages,
  configuration, filenames, Markdown, and unsupported languages.

Quick start:
  ucn repo
  ucn show handleRequest
  ucn trace handleRequest --direction=callers
  ucn impact handleRequest
  ucn tests handleRequest --depth=3
  ucn source handleRequest`);
}

// ============================================================================
// INTERACTIVE MODE
// ============================================================================

function runInteractive(rootDir) {
    const readline = require('readline');
    // ProjectIndex already required at top of file

    console.log('Building index...');
    const index = new ProjectIndex(rootDir);
    if (flags.clearCache) {
        const removed = index.clearCache();
        if (removed.length > 0 && !flags.quiet) {
            console.error('Cache cleared');
        }
    }
    // Same cache discipline as one-shot mode (fix #250: the REPL fully
    // re-parsed every session and never consumed cache-persisted state —
    // the divergence mechanism behind the relocation P1).
    let iCacheFresh;
    if (flags.cache) {
        const loaded = !flags.clearCache && index.loadCache();
        iCacheFresh = loaded && !index.isCacheStale();
        if (!iCacheFresh && loaded) {
            index.build(null, { quiet: true, forceRebuild: true, workers: flags.workers });
        } else if (!iCacheFresh) {
            index.build(null, { quiet: true, workers: flags.workers });
        }
        if (!iCacheFresh) {
            try { index.saveCache(); } catch (_) { /* best-effort */ }
        }
    } else {
        index.build(null, { quiet: true, workers: flags.workers });
    }
    console.log(`Index ready: ${index.files.size} files, ${index.symbols.size} unique symbol names`);
    console.log('Type commands (e.g., "find parseFile", "show main", "repo")');
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
  repo                   Repository overview (--sections=files,stats,health)
  show <name>            Symbol summary + relationships (--sections=...)
  find <name>            Find definitions (--type=type, --with-source)
  usages <name>          All usages grouped by type
  source <target>        Extract a symbol or file:line-range
  trace <name>           Call tree (--direction=callees|callers, --to=entrypoints)
  impact [name]          Symbol impact, or Git diff impact without a name
  tests <name>           Direct tests; --depth=N includes transitive impact
  deps <file>            File graph (--direction=, --depth=, --detailed, --cycles)
  search <term>          Text search (--context=N, --exclude=, --in=)
                         Structural: --type= --param= --returns= --decorator= --exported --unused
  deadcode               Unreferenced-symbol candidates (review before deletion)
  entrypoints            Detect runtime, framework, task, and test entry points
  endpoints              List server/client HTTP endpoints (--bridge to match)
  check [name]           Symbol signature check, or pre-commit check without a name
  plan <name>            Preview refactoring (--add-param=, --remove-param=, --rename-to=, --default-value=)
  stacktrace <text>      Parse a stack trace
  api                    Show public symbols
  audit-async            Find likely missing-await calls (JS/TS/Python/C#)
  rebuild                Rebuild index
  quit                   Exit

Flags can be added per-command: show myFunc --sections=source,callers
`);
            rl.prompt();
            return;
        }

        if (input === 'rebuild') {
            console.log('Rebuilding index...');
            index.build(null, { quiet: true, forceRebuild: true, workers: flags.workers });
            console.log(`Index ready: ${index.files.size} files, ${index.symbols.size} unique symbol names`);
            rl.prompt();
            return;
        }

        // Parse command, flags, and arg from interactive input
        const tokens = input.split(/\s+/);
        const command = tokens[0];
        // Flags that take a space-separated value (--flag value)
        const valueFlagNames = new Set(['--file', '--in', '--base', '--add-param', '--remove-param', '--rename-to', '--default', '--depth', '--top', '--context', '--max-lines', '--direction', '--to', '--sections', '--range', '--exclude', '--not', '--stack', '--type', '--param', '--receiver', '--returns', '--decorator', '--limit', '--max-files', '--max-chars', '--min-confidence', '--class-name', '--line', '--framework', '--method', '--prefix']);
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

        // Unknown flags error instead of folding their value into the symbol
        // name. Same vocabulary as one-shot mode.
        const unknown = flagTokens.filter(t =>
            t.startsWith('--') && !knownFlags.has(t.split('=')[0]));
        if (unknown.length > 0) {
            console.log(`Unknown flag(s): ${unknown.join(', ')}`);
            rl.prompt();
            return;
        }
        const iflags = parseFlags(flagTokens);
        // parseFlags never extracts --json (it is a global-argv flag), so
        // check the raw tokens.
        if (flagTokens.includes('--json')) {
            console.log('Note: interactive mode prints text output — run `ucn . <command> --json` one-shot for JSON.');
        }

        try {
            // Validate numeric flags (--top, --limit, etc) — same rules as
            // global CLI mode. MED-2/MED-3/MED-5: bad values are rejected with
            // a helpful message instead of being silently coerced.
            validateNumericFlags(iflags);
            const iCanonical = resolveCommand(command, 'cli') || command;
            executeInteractiveCommand(index, iCanonical, arg, iflags);
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

function executeInteractiveCommand(index, command, arg, iflags = {}) {
    warnInapplicableFlags(command, iflags, (message) => console.log(message));

    if (!isPublicCommand(command)) {
        console.log(unknownCommandMessage(command, { interactive: true }));
        return;
    }
    const publicParams = buildPublicParams(command, arg, iflags);
    const publicExecution = execute(index, command, publicParams);
    if (!publicExecution.ok) {
        console.log(formatSurfaceMessage(publicExecution.error, 'cli'));
        return;
    }
    console.log(formatCliText(
        command,
        publicExecution.result,
        publicParams,
        publicExecution,
        iflags,
    ));
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
