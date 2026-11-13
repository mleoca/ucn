#!/usr/bin/env node

/**
 * UCN CLI - Universal Code Navigator
 *
 * Unified command model: commands work consistently across file and project modes.
 * Auto-detects mode from target (file path → file mode, directory → project mode).
 */

// Reuse V8 code caches across processes (Node >= 22.1; fix #365): compiling
// the engine's modules is a fixed cost of every command. Node validates each
// entry against the source, and NODE_DISABLE_COMPILE_CACHE turns it off.
try { require('module').enableCompileCache?.(); } catch (_) { /* optional */ }

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
    v4MigrationHint,
    FLAG_APPLICABILITY,
    toCliName,
    FILE_LOCAL_COMMANDS,
    formatSurfaceMessage,
    getCliFlagsForCommand,
    getCliAcceptedFlags,
    getCliValueFlags,
    generateCliParamReference,
    commandMode,
    paramDefault,
    paramFact,
    paramRange,
    paramValues,
    GLOBAL_PARAMS,
} = require('../core/registry');
const { FlagValidationError, parseFlags, parseProcessFlags, validateFlags, processInteger } = require('./flags');
const { buildPublicParams, isPublicCommand, noOpNotes } = require('../core/public-command');
const { execute } = require('../core/execute');
const { describeError } = require('../core/errors');
const { applyOutputBudget } = require('../core/output-budget');
const { clearAllCaches } = require('../core/cache');
const { commentLines, budgetLineListing } = require('../core/output/lines');

// A downstream consumer such as head may finish before our write drains.
// Handle the pipe closure without an unhandled Node error or bypassing cache
// cleanup. Other write failures are real command errors.
process.stdout.on('error', error => {
    if (error.code === 'EPIPE') return;
    process.stderr.write(`Error writing stdout: ${error.message}\n`);
    process.exitCode = 2;
});

let activeCanonicalCommand = null;

// Sentinel error for command failures that have already printed their message.
// Thrown instead of process.exit(1) so finally blocks can run (cache save).
class CommandError extends Error { constructor() { super(); } }

function unknownCommandMessage(command, { interactive = false } = {}) {
    const migration = v4MigrationHint(command, 'cli');
    if (migration) return `Unknown command: ${command}. ${migration}`;
    const suggestion = suggestCommand(command, 'cli');
    const correction = suggestion ? ` Did you mean "${suggestion}"?` : '';
    const help = !suggestion
        ? (interactive
            ? ' Type "help" for available commands.'
            : ' Run "ucn --help" for available commands.')
        : '';
    return `Unknown command: ${command}.${correction}${help}`;
}

function resultExitCode(command, result) {
    if (result && result.ok === false) return 2;
    if (command !== 'check' || !result) return 0;
    if (result.trust) {
        // Target-less pre-commit check: a definite break fails, something
        // to look at does not, unless the caller asked for --strict.
        return result.trust.passes === false ? 1 : 0;
    }
    // Symbol-mode check (verify): a mismatch or unresolved call-site tier is
    // review-required and must fail a CI gate.
    return (Number(result.mismatches || 0) > 0 ||
        Number(result.unverifiedCount || 0) > 0) ? 1 : 0;
}

/** Emit the one CLI error contract, including failures before main dispatch. */
function emitCliError(msg, command = activeCanonicalCommand, { internal = false } = {}) {
    const argv = process.argv.slice(2);
    const end = argv.indexOf('--');
    const wantsJson = parseProcessFlags(end === -1 ? argv : argv.slice(0, end)).json;
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
                // An exception inside UCN, not a refusal (fix #394).
                ...(internal && { internalError: true }),
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
function fail(msg, command = activeCanonicalCommand, options = {}) {
    emitCliError(msg, command, options);
    throw new CommandError();
}

/** Fail with an execute() error: refusals are rendered for the CLI, internal errors kept verbatim. */
function failExecution(execution) {
    if (execution.internalError) fail(execution.error, activeCanonicalCommand, { internal: true });
    fail(formatSurfaceMessage(execution.error, 'cli'));
}

/** Report an exception caught outside execute(). */
function emitCaughtError(e) {
    const described = describeError(e);
    emitCliError(described.internalError ? described.error : `Error: ${described.error}`,
        activeCanonicalCommand, { internal: !!described.internalError });
}

// ============================================================================
// ARGUMENT PARSING
// ============================================================================

const rawArgs = process.argv.slice(2);
const processArgs = rawArgs.includes('--') ? rawArgs.slice(0, rawArgs.indexOf('--')) : rawArgs;
const processFlags = parseProcessFlags(processArgs);
try {
    validateFlags(processFlags);
} catch (e) {
    emitCliError(e.message);
    process.exit(processFlags.json ? 1 : 2);
}

// MCP server mode — launch server and skip CLI
if (processFlags.mcp) {
    require('../mcp/server.js');
} else {
// Support -- to separate flags from positional arguments
const doubleDashIdx = rawArgs.indexOf('--');
const args = doubleDashIdx === -1 ? rawArgs : rawArgs.slice(0, doubleDashIdx);
const argsAfterDoubleDash = doubleDashIdx === -1 ? [] : rawArgs.slice(doubleDashIdx + 1);

// Parse shared flags from CLI args, then add global-only flags
// Parameters come from the registry's table (cli/flags.js); the flags of the
// CLI process itself are read here.
const flags = parseFlags(args);
flags.json = processFlags.json ?? false;
flags.quiet = processFlags.quiet ?? true;
flags.cache = (processFlags.cache ?? true) && !flags.includeBundled;
flags.clearCache = processFlags.clearCache ?? false;
flags.interactive = processFlags.interactive ?? false;
flags.followSymlinks = flags.followSymlinks ?? paramDefault('followSymlinks');

// Known flags for validation
const knownFlags = getCliAcceptedFlags();

// Handle help flag
if (processFlags.help) {
    printUsage();
    process.exit(0);
}

// Handle version flag — read from package.json (single source of truth, shared with MCP serverInfo)
if (processFlags.version) {
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
    process.exit(flags.json ? 1 : 2);
}

// Refuse a flag value the parameter table does not take before any index is
// built: a number outside its bounds, a flag written without its value.
try {
    validateFlags(flags);
    flags.workers = processInteger(args, '--workers');
} catch (e) {
    if (e instanceof FlagValidationError) {
        emitCliError(e.message);
        process.exit(flags.json ? 1 : 2);
    }
    throw e;
}

// Value flags that consume the next token (space form: --flag value)
const VALUE_FLAGS = getCliValueFlags();

// Remove flags from args, then add args after -- (which are all positional)
const positionalArgs = [
    ...args.filter((a, idx) =>
        !a.startsWith('-') &&
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

/** Exact raw source and mandatory note bytes, shared by budgets and emitters. */
function rawCliOutput(text, note, interactive = false) {
    const body = String(text);
    return {
        source: body + (interactive || !body.endsWith('\n') ? '\n' : ''),
        note: note ? commentLines(formatSurfaceMessage(note, 'cli')).join('\n') + '\n' : '',
    };
}

function formatCliText(command, result, params, execution, displayFlags) {
    const text = output.formatPublicText(command, result, params, {
        ...execution,
        surface: 'cli',
    });
    // --lines / --raw are pipe surfaces with no default budget, and an empty
    // answer must stay empty (grep prints nothing and exits 1). Under an
    // explicit --max-chars a line listing prints the rows that fit and one
    // line counting the rest, as `| head` would; a record is never cut. Raw
    // source is never cut either, since a truncated function body is worse
    // than a long one: there the budget is a fail-before-output guard.
    if (params?.lines || params?.raw) {
        const rawOutput = params.raw ? rawCliOutput(text, execution?.note, displayFlags?.interactive) : null;
        const emittedChars = params.lines
            ? (text.split('\n').filter(Boolean).join('\n').length + (text ? 1 : 0))
            : rawOutput.source.length + rawOutput.note.length;
        if (displayFlags?.maxChars && emittedChars > displayFlags.maxChars) {
            const listing = params.lines ? budgetLineListing(text, displayFlags.maxChars - 1, 'cli') : null;
            if (listing) return listing.text;
            fail(params.lines
                ? `Output exceeds --max-chars=${displayFlags.maxChars} and not one row fits beside the accounting lines. Raise --max-chars or omit it.`
                : `Output exceeds --max-chars=${displayFlags.maxChars}; shell output cannot be truncated. Narrow the query, use --limit/--max-lines, or omit --max-chars.`);
        }
        return text;
    }
    return applyOutputBudget(text, {
        command,
        maxChars: displayFlags?.maxChars,
        all: !!displayFlags?.all,
        surface: 'cli',
        params,
        trailingChars: 1, // emitCliText appends the terminal newline.
        peerText: output.formatPublicText(command, result, params, { ...execution, surface: 'mcp' }),
    }).text;
}

/**
 * Print a formatted answer the way the mode asks for it (fix #341).
 * --lines: `path:line:text` records on stdout, `# ` comment lines (ACCOUNT,
 * notes) on stderr, exit 1 when nothing matched — grep's own contract.
 * --raw: the text verbatim with exactly one trailing newline.
 */
function emitCliText(text, params, json, note) {
    if (!json && params?.lines) {
        const records = [];
        const comments = [];
        for (const line of String(text).split('\n')) {
            if (line === '') continue;
            (line.startsWith('# ') ? comments : records).push(line);
        }
        if (records.length > 0) process.stdout.write(records.join('\n') + '\n');
        if (comments.length > 0) process.stderr.write(comments.join('\n') + '\n');
        if (records.length === 0) process.exitCode = Math.max(process.exitCode || 0, 1);
        return;
    }
    if (!json && params?.raw) {
        const rawOutput = rawCliOutput(text, note);
        process.stdout.write(rawOutput.source);
        // Code lines are never reinterpreted (a Python comment starts with
        // "# " too), so the note travels on its own channel.
        if (rawOutput.note) process.stderr.write(rawOutput.note);
        return;
    }
    console.log(text);
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
            if (flags.all) {
                const removed = clearAllCaches();
                console.log(removed.length > 0
                    ? 'All UCN user caches cleared'
                    : 'No UCN user caches to clear');
                process.exit(0);
            }
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
            emitCaughtError(e);
        }
        process.exitCode = flags.json ? 1 : 2;
    }
}

/**
 * Tiered-output contract notes shared by one-shot and interactive mode.
 */
function printTieredNoOpNotes(canonical, flags, print) {
    for (const note of noOpNotes(canonical, flags)) print(`Note: ${formatSurfaceMessage(note, 'cli')}`);
}

// Keys of a parsed flag object that no command's applicability decides: the
// CLI process flags and the parameters every command accepts.
const GLOBAL_FLAG_KEYS = new Set([
    'json', 'quiet', 'cache', 'clearCache', 'verbose', 'interactive', 'workers',
    '_fileFromFileMode', ...GLOBAL_PARAMS,
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
    const isStructural = commandMode('search', flags) === 'structural';
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
    const { ok, result } = execution;
    if (!ok) failExecution(execution);
    emitCliText(flags.json
        ? output.formatPublicJson(canonical, result, params, {
            ...execution, surface: 'cli',
        })
        : formatCliText(canonical, result, params, execution, scopedFlags), params, flags.json, execution.note);
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
        cacheWasLoaded = !!loaded;
        if (loaded && !index.includeBundled && !flags.maxFiles) {
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
        const buildOpts = { quiet: flags.quiet, forceRebuild: cacheWasLoaded, followSymlinks: flags.followSymlinks, includeBundled: flags.includeBundled, maxFiles: flags.maxFiles, workers: flags.workers };
        if (flags.cache && !flags.maxFiles) {
            // Cross-process build lock (fix #354): concurrent cold-cache
            // invocations share one build instead of each rebuilding.
            index.buildCached(buildOpts, {
                onWait: () => { if (!flags.quiet) console.error('Waiting for another ucn process building the index...'); },
            });
            needsCacheSave = false; // buildCached saved (or loaded the other process's cache)
        } else {
            index.build(null, buildOpts);
            needsCacheSave = flags.cache;
        }
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
        failExecution(publicExecution);
    }
    emitCliText(flags.json
        ? output.formatPublicJson(canonical, publicExecution.result, publicParams, {
            ...publicExecution, surface: 'cli',
        })
        : formatCliText(canonical, publicExecution.result, publicParams, publicExecution, flags),
    publicParams, flags.json, publicExecution.note);
    // A gate that could not run (check outside git / bad base ref) must not
    // exit 0 — CI gating on the exit code would read "could not run" as "passed".
    process.exitCode = Math.max(process.exitCode || 0,
        resultExitCode(canonical, publicExecution.result));
    } catch (e) {
        if (!(e instanceof CommandError)) {
            emitCaughtError(e);
        }
        process.exitCode = flags.json ? 1 : 2;
    } finally {
        // Save cache after command execution so callsCache populated
        // by findCallers/findCallees gets persisted to disk.
        // On cache-hit runs, only re-save if callsCache was mutated OR
        // reachability was computed (MED-1: persists the BFS result so
        // subsequent cold invocations don't repeat the 7-11s tax).
        // Files whose macro-expansion calls the command derived in part are
        // derived whole first, so the next invocation reads them persisted.
        if (flags.cache) {
            try { index.completeMacroCallDerivations(); } catch (e) { /* best-effort */ }
        }
        if (flags.cache && (needsCacheSave || index.callsCacheDirty || index.reachabilityDirty || index.computedDispatchDirty || index.macroExpansionDirty)) {
            try { index.saveCache(); } catch (e) { /* best-effort */ }
        }
        if (flags.cache && index.usageCacheDirty) {
            try { index.saveUsageCache(); } catch (e) { /* best-effort */ }
        }
        // A HOT ranking computed by this command, for the next one.
        if (flags.cache && index.hotSummaryDirty) {
            try { index.saveHotSummaries(); } catch (e) { /* best-effort */ }
        }
    }
}

// ============================================================================
// GLOB MODE
// ============================================================================

function runGlobCommand(pattern, command, arg) {
    const discoveryIssues = [];
    const files = expandGlob(pattern, {
        includeBundled: flags.includeBundled,
        onDiscoveryIssue: issue => discoveryIssues.push(issue),
    });

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
    index.discoveryIssues.push(...discoveryIssues.map(issue => ({
        ...issue, relativePath: path.relative(index.root, issue.path), path: undefined,
    })));
    index._sourceUniverse = null; // classify with the glob walk's facts included

    if (!isPublicCommand(canonical)) {
        fail(unknownCommandMessage(command));
    }
    warnInapplicableFlags(canonical, flags, (message) => console.error(message));
    const publicParams = buildPublicParams(canonical, arg, flags);
    const publicExecution = execute(index, canonical, publicParams);
    if (!publicExecution.ok) {
        failExecution(publicExecution);
    }
    emitCliText(flags.json
        ? output.formatPublicJson(canonical, publicExecution.result, publicParams, {
            ...publicExecution, surface: 'cli',
        })
        : formatCliText(canonical, publicExecution.result, publicParams, publicExecution, flags),
    publicParams, flags.json, publicExecution.note);
    process.exitCode = Math.max(process.exitCode || 0,
        resultExitCode(canonical, publicExecution.result));
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
    // Value lists, defaults and bounds are the registry's parameter table.
    const values = (param, command, separator = '|') => paramValues(param, command).join(separator);
    const budget = {
        max: paramRange('maxChars').max,
        targeted: paramDefault('maxChars', 'show'),
        broad: paramDefault('maxChars', 'repo'),
    };
    console.log(`UCN - Universal Code Navigator

Supported: JavaScript/TypeScript, Python, Go, Rust, Java, C, C++, C#, HTML

Usage:
  ucn [command] [args]            Current project
  ucn <file|dir|glob> <command>   Explicit target
  Add --json for a stable { meta, data } envelope.

Commands:
  repo                            Repository overview
    --sections=${values('sections', 'repo', ',')}  Select repository sections
    --deep                         Include deep readiness evidence
  show <symbol>                   Symbol summary and relationships
    --sections=${values('sections', 'show', ',')}
  find <name>                     Definitions; --type=type, --with-source
    text: top ${paramFact('limit', 'findDetail')} in detail + a count of the rest; --json: up to ${paramDefault('limit', 'find')};
    --limit=N raises both
  usages <name>                   Calls, imports, definitions, references (test files
                                  included; --exclude-tests hides them with a count)
  search [term]                   Text or structural search
    literal text by default; --regex enables regular-expression syntax
  source <symbol|file:range>      Exact function, class, or line extraction
  trace <symbol>                  Call graph
    --direction=${values('direction', 'trace')}   Downstream or upstream (default: ${paramDefault('direction', 'trace')})
    --to=${values('to', 'trace')}              Follow callers toward entry points
  impact [symbol]                 Symbol impact; without symbol, Git-diff impact
  tests <symbol>                  Direct tests; --depth=N adds transitive impact
  deps <file>                     File graph; --direction=${values('direction', 'deps')}
    --detailed                     Include import declarations
  deps --cycles                   Report circular dependencies (no file target)
  api [file]                      Project or file public API (exact files include tests;
                                  broader scans exclude tests unless --include-tests)
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
  --range=N-M (source <file> --range=N-M, or --file=PATH)
  --base=REF --staged --strict --no-cache --clear-cache [--all] --max-files=N --workers=N
  --max-chars=N (text characters, not UTF-8 bytes; default ${budget.targeted} targeted / ${budget.broad} broad, ceiling ${budget.max})
           JSON is uncapped; meta.maxChars is "not-applied", even with an explicit budget.
  --lines  find/usages/search/show/impact: grep -n shape, one path:line:text
           record per output line; usages combines occurrences on each source line
           (tags after a tab: # unverified: <reason>, # import,
           # callee); accounting and notes go to stderr as "# " lines; exit 1
           when nothing matched; exit 2 on errors. No default result cap.
           Under an explicit --max-chars the rows that fit are printed whole
           and one "# truncated: X of Y rows omitted" line counts the rest.
           show defaults to ${paramDefault('sections', 'show', 'lines').join(',')}; --sections=${paramValues('sections', 'show', 'lines').join(',')} selects bands.
  --raw    source: full code, no header or gutter (including large classes).
           Never cut: an explicit --max-chars it exceeds fails before output.
  Cache: per-user by default; set UCN_CACHE_DIR to override the cache root.

Accepted flags by command:
${perCommandFlags}

Values, bounds and defaults:
${generateCliParamReference()}

Global/build/output flags:
  --help -h --version -v --mcp --json --verbose --no-quiet --quiet
  --interactive -i --no-cache --clear-cache --no-follow-symlinks --include-bundled
  --max-files=N --max-chars=N --workers=N
  --clear-cache --all clears every bounded per-user UCN project cache.

Exit codes:
  0  Command completed successfully; check found no blocking issues.
  1  Empty --lines listing, blocking check findings, or JSON command error.
  2  Text/shell command error, or a check that could not run.

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
        iCacheFresh = loaded && !index.includeBundled && !index.isCacheStale();
        if (!iCacheFresh) {
            index.buildCached({ quiet: true, forceRebuild: !!loaded, workers: flags.workers }, {
                onWait: () => console.log('Waiting for another ucn process building the index...'),
            });
        }
    } else {
        index.build(null, { quiet: true, workers: flags.workers, includeBundled: flags.includeBundled });
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
  repo                   Repository overview (--sections=${paramValues('sections', 'repo').join(',')})
  show <name>            Symbol summary + relationships (--sections=...)
  find <name>            Find definitions (--type=type, --with-source; top ${paramFact('limit', 'findDetail')} shown, --limit=N)
  usages <name>          All usages grouped by type
  source <target>        Extract a symbol or file:line-range
  trace <name>           Call tree (--direction=${paramValues('direction', 'trace').join('|')}, --to=${paramValues('to', 'trace').join('|')})
  impact [name]          Symbol impact, or Git diff impact without a name
  tests <name>           Direct tests; --depth=N includes transitive impact
  deps <file>            File graph (--direction=, --depth=, --detailed, --cycles)
  search <term>          Text search (--context=N, --exclude=, --in=)
                         Structural: --type= --param= --returns= --decorator= --exported --unused
  deadcode               Unreferenced-symbol candidates (review before deletion)
  entrypoints            Detect runtime, framework, task, and test entry points
  endpoints              List server/client HTTP endpoints (--bridge to match)
  check [name]           Symbol signature check, or pre-commit check without a name
  plan <name>            Preview refactoring (--add-param=, --remove-param=, --rename-to=, --default-value=, --delete)
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
        const valueFlagNames = VALUE_FLAGS;
        const flagTokens = [];
        const argTokens = [];
        const skipNext = new Set();
        for (let i = 1; i < tokens.length; i++) {
            if (skipNext.has(i)) { continue; }
            if (tokens[i].startsWith('-')) {
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
            t.startsWith('-') && !knownFlags.has(t.split('=')[0]));
        if (unknown.length > 0) {
            console.log(`Unknown flag(s): ${unknown.join(', ')}`);
            rl.prompt();
            return;
        }
        const iflags = parseFlags(flagTokens);
        const iprocess = parseProcessFlags(flagTokens);

        try {
            // The same value rules as one-shot mode: a bad value is refused
            // with a message, never silently coerced.
            validateFlags(iflags);
            validateFlags(iprocess);
            if (iprocess.json) {
                console.log('Note: interactive mode prints text output — run `ucn . <command> --json` one-shot for JSON.');
            }
            const startupOnly = Object.keys(iprocess).filter(key => key !== 'json');
            if (startupOnly.length > 0 || flagTokens.some(token => token === '--workers' || token.startsWith('--workers='))) {
                processInteger(flagTokens, '--workers');
                console.log('Note: CLI process controls apply when starting UCN; they do not change an active interactive session.');
            }
            // The REPL is an edit/query loop, not a frozen snapshot. Keep the
            // symbol table and call cache on the same generation by checking
            // source staleness before every command. getCachedCalls already
            // refreshes individual call records lazily; without this matching
            // rebuild a newly added definition was invisible while its calls
            // appeared in neighbouring answers (UCN5-044).
            const includeBundled = !!(iflags.includeBundled || flags.includeBundled);
            if (!!index.includeBundled !== includeBundled || index.isCacheStale()) {
                console.log('Source changed; rebuilding index...');
                const rebuildOpts = {
                    quiet: true,
                    forceRebuild: true,
                    followSymlinks: flags.followSymlinks,
                    includeBundled,
                    maxFiles: flags.maxFiles,
                    workers: flags.workers,
                };
                if (flags.cache && !flags.maxFiles && !includeBundled) {
                    index.buildCached(rebuildOpts, {
                        onWait: () => console.log('Waiting for another ucn process building the index...'),
                    });
                } else {
                    index.build(null, rebuildOpts);
                }
                console.log(`Index ready: ${index.files.size} files, ${index.symbols.size} unique symbol names`);
            }
            const iCanonical = resolveCommand(command, 'cli') || command;
            executeInteractiveCommand(index, iCanonical, arg, iflags);
        } catch (e) {
            if (e instanceof FlagValidationError) {
                console.log(e.message);
            } else if (!(e instanceof CommandError)) {
                const described = describeError(e);
                console.error(described.internalError ? described.error : `Error: ${described.error}`);
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
        console.log(publicExecution.internalError ? publicExecution.error
            : formatSurfaceMessage(publicExecution.error, 'cli'));
        return;
    }
    const text = formatCliText(
        command,
        publicExecution.result,
        publicParams,
        publicExecution,
        { ...iflags, interactive: true },
    );
    if (publicParams.raw) {
        // Keep the REPL's existing source/newline and prompt layout; the
        // mandatory disclosure follows it in the same text stream.
        const rawOutput = rawCliOutput(text, publicExecution.note, true);
        process.stdout.write(rawOutput.source + rawOutput.note);
    } else {
        console.log(text);
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
