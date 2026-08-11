/**
 * Canonical Command Registry — single source of truth for all UCN surfaces.
 *
 * Every command and parameter is defined here. CLI, MCP, and interactive mode
 * derive their command lists, enum values, and param normalization from this.
 */

'use strict';

// ============================================================================
// CANONICAL COMMANDS
// ============================================================================

// Public v5 commands using camelCase canonical IDs.
//
// The engine still exposes narrower internal operations (about/context/blast,
// etc.) through execute.js so their well-tested analysis primitives can be
// composed.  CLI and MCP are derived exclusively from this list: the public
// surface is intentionally small and has no legacy command aliases.
const CANONICAL_COMMANDS = [
    // Understand and navigate
    'show', 'find', 'usages', 'search', 'source', 'trace',
    // Change and validation
    'impact', 'tests', 'check', 'plan',
    // Repository and architecture
    'repo', 'deps', 'api', 'entrypoints', 'endpoints',
    // Focused audits / runtime evidence
    'deadcode', 'auditAsync', 'stacktrace',
];

// Directive guidance for retired v4 commands. These names remain invalid —
// this is not a compatibility execution layer — but agents receive the exact
// v5 command that answers the old intent instead of a dead end.
const V4_COMMAND_MIGRATIONS = {
    about:         { purpose: 'For a symbol summary', cli: 'ucn show <name>', mcp: 'command "show" with name' },
    context:       { purpose: 'For callers and callees', cli: 'ucn show <name>', mcp: 'command "show" with name' },
    smart:         { purpose: 'For source plus callees', cli: 'ucn show <name> --sections=source,callees', mcp: 'command "show" with name, sections="source,callees"' },
    related:       { purpose: 'For related symbols', cli: 'ucn show <name> --sections=related', mcp: 'command "show" with name, sections="related"' },
    example:       { purpose: 'For a call-site example', cli: 'ucn show <name> --sections=example', mcp: 'command "show" with name, sections="example"' },
    brief:         { purpose: 'For a compact symbol summary', cli: 'ucn show <name> --compact', mcp: 'command "show" with name, compact=true' },
    callers:       { purpose: 'For who calls a symbol', cli: 'ucn show <name> --sections=callers', mcp: 'command "show" with name, sections="callers"' },
    callees:       { purpose: 'For what a symbol calls', cli: 'ucn show <name> --sections=callees', mcp: 'command "show" with name, sections="callees"' },
    typedef:       { purpose: 'For a type definition', cli: 'ucn find <name> --type=type', mcp: 'command "find" with name, type="type"' },
    blast:         { purpose: 'For the transitive caller tree', cli: 'ucn trace <name> --direction=callers', mcp: 'command "trace" with name, direction="callers"' },
    reverseTrace:  { purpose: 'For entry-point paths', cli: 'ucn trace <name> --direction=callers --to=entrypoints', mcp: 'command "trace" with name, direction="callers", to="entrypoints"' },
    toc:           { purpose: 'For the per-file symbol listing', cli: 'ucn repo --sections=files', mcp: 'command "repo" with sections="files"' },
    stats:         { purpose: 'For project statistics', cli: 'ucn repo --sections=stats', mcp: 'command "repo" with sections="stats"' },
    doctor:        { purpose: 'For index health and trust', cli: 'ucn repo --sections=health --deep', mcp: 'command "repo" with sections="health", deep=true' },
    orient:        { purpose: 'For repository orientation', cli: 'ucn repo', mcp: 'command "repo"' },
    affectedTests: { purpose: 'For transitively affected tests', cli: 'ucn tests <name> --depth=<n>', mcp: 'command "tests" with name, depth=<n>' },
    fn:            { purpose: 'To extract a function', cli: 'ucn source <name>', mcp: 'command "source" with name' },
    class:         { purpose: 'To extract a class', cli: 'ucn source <name>', mcp: 'command "source" with name' },
    lines:         { purpose: 'To extract a line range', cli: 'ucn source <file> --range=<start-end>', mcp: 'command "source" with name=<file>, range="<start-end>"' },
    expand:        { purpose: 'To expand a listed item', cli: 'ucn source <handle>', mcp: 'command "source" with name=<handle>' },
    imports:       { purpose: 'For what a file imports', cli: 'ucn deps <file> --direction=imports', mcp: 'command "deps" with file, direction="imports"' },
    exporters:     { purpose: 'For who imports a file', cli: 'ucn deps <file> --direction=importers', mcp: 'command "deps" with file, direction="importers"' },
    graph:         { purpose: 'For a dependency graph', cli: 'ucn deps <file> --depth=<n>', mcp: 'command "deps" with file, depth=<n>' },
    circularDeps:  { purpose: 'For circular dependencies', cli: 'ucn deps --cycles', mcp: 'command "deps" with cycles=true' },
    fileExports:   { purpose: 'For a file public surface', cli: 'ucn api <file>', mcp: 'command "api" with file' },
    verify:        { purpose: 'To validate call sites', cli: 'ucn check <name>', mcp: 'command "check" with name' },
    diffImpact:    { purpose: 'For Git-diff impact', cli: 'ucn impact --base <ref>', mcp: 'command "impact" with base' },
    stack:         { purpose: 'To analyze a stack trace', cli: 'ucn stacktrace "<paste>"', mcp: 'command "stacktrace" with stack' },
};

const V4_SPELLING_ALIASES = {
    rtrace: 'reverseTrace', affected: 'affectedTests',
    circular: 'circularDeps', cycles: 'circularDeps',
    'what-exports': 'fileExports', 'what-imports': 'imports',
    'who-imports': 'exporters',
};
const V4_MIGRATION_LOOKUP = new Map();
{
    const normalize = value => String(value).toLowerCase().replace(/[-_]/g, '');
    for (const [name, entry] of Object.entries(V4_COMMAND_MIGRATIONS)) {
        V4_MIGRATION_LOOKUP.set(normalize(name), entry);
    }
    for (const [alias, name] of Object.entries(V4_SPELLING_ALIASES)) {
        V4_MIGRATION_LOOKUP.set(normalize(alias), V4_COMMAND_MIGRATIONS[name]);
    }
}

function v4MigrationHint(name, surface = 'cli') {
    if (!name || resolveCommand(String(name), surface)) return null;
    const entry = V4_MIGRATION_LOOKUP.get(
        String(name).toLowerCase().replace(/[-_]/g, ''));
    if (!entry) return null;
    return `${entry.purpose}, use: ${surface === 'mcp' ? entry.mcp : entry.cli}.`;
}

// ============================================================================
// PARAM NORMALIZATION (snake_case → camelCase)
// ============================================================================

const PARAM_MAP = {
    project_dir:       'projectDir',
    include_tests:     'includeTests',
    exclude_tests:     'excludeTests',
    include_methods:   'includeMethods',
    with_types:        'withTypes',
    code_only:         'codeOnly',
    case_sensitive:    'caseSensitive',
    include_exported:  'includeExported',
    include_decorated: 'includeDecorated',
    min_confidence:    'minConfidence',
    show_confidence:   'showConfidence',
    calls_only:        'callsOnly',
    class_name:        'className',
    max_lines:         'maxLines',
    add_param:         'addParam',
    remove_param:      'removeParam',
    rename_to:         'renameTo',
    default_value:     'defaultValue',
    top_level:         'topLevel',
    max_files:         'maxFiles',
    max_chars:         'maxChars',
    follow_symlinks:   'followSymlinks',
    unreachable_only:  'unreachableOnly',
    server_only:       'serverOnly',
    client_only:       'clientOnly',
    hide_uncertain:    'hideUncertain',
    expand_unverified: 'expandUnverified',
    with_source:       'withSource',
};

// ============================================================================
// FLAG APPLICABILITY MATRIX
// ============================================================================

// Per-command list of accepted flag names (camelCase). Source of truth for help text,
// MCP param stripping, CLI inapplicable-flag warnings, and architecture guards.
// file* = file is the command subject (required), not a filter pattern.
const FLAG_APPLICABILITY = {
    // Understand one symbol. `sections` is a comma-separated projection:
    // summary, callers, callees, source, dependencies, tests, types, example,
    // related. Caller-bearing projections always preserve ACCOUNT/CONTRACT.
    show:         ['name', 'file', 'exclude', 'className', 'line', 'sections', 'includeMethods', 'includeTests', 'top', 'all', 'withTypes', 'minConfidence', 'showConfidence', 'unreachableOnly', 'compact', 'git', 'diverse'],
    find:         ['name', 'file', 'exclude', 'className', 'includeTests', 'limit', 'exact', 'in', 'compact', 'type', 'withSource'],
    usages:       ['name', 'file', 'exclude', 'className', 'includeTests', 'limit', 'codeOnly', 'context', 'in', 'compact', 'all'],
    search:       ['term', 'file', 'exclude', 'includeTests', 'top', 'limit', 'codeOnly', 'caseSensitive', 'context', 'regex', 'in', 'type', 'param', 'receiver', 'returns', 'decorator', 'exported', 'unused'],
    source:       ['name', 'file', 'className', 'line', 'range', 'all', 'maxLines'],
    trace:        ['name', 'file', 'exclude', 'className', 'line', 'direction', 'to', 'includeMethods', 'depth', 'all', 'expandUnverified'],
    impact:       ['name', 'file', 'exclude', 'className', 'line', 'includeMethods', 'top', 'unreachableOnly', 'compact', 'base', 'staged', 'limit', 'all'],
    tests:        ['name', 'file', 'exclude', 'className', 'line', 'callsOnly', 'depth', 'includeMethods', 'all'],
    deps:         ['file', 'exclude', 'depth', 'direction', 'all', 'detailed', 'cycles'],
    api:          ['file', 'in', 'limit'],
    check:        ['name', 'file', 'className', 'line', 'includeMethods', 'base', 'staged', 'limit'],
    plan:         ['name', 'file', 'className', 'line', 'addParam', 'removeParam', 'renameTo', 'defaultValue'],
    repo:         ['file', 'exclude', 'top', 'limit', 'all', 'detailed', 'topLevel', 'in', 'functions', 'hot', 'deep', 'sections'],
    deadcode:     ['file', 'exclude', 'includeTests', 'includeExported', 'includeDecorated', 'limit', 'in'],
    entrypoints:  ['file', 'exclude', 'includeTests', 'excludeTests', 'limit', 'type', 'framework'],
    endpoints:    ['file', 'exclude', 'limit', 'framework', 'bridge', 'serverOnly', 'clientOnly', 'unmatched', 'method', 'prefix', 'hideUncertain'],
    stacktrace:   ['stack'],
    auditAsync:   ['file', 'exclude', 'limit'],
};

// Commands whose output is project-wide — truncation means you need a filter, not more text.
// Used by MCP server for tighter default output limits.
const BROAD_COMMANDS = new Set([
    'repo', 'entrypoints', 'endpoints', 'tests', 'deadcode', 'usages',
    'deps', 'check', 'auditAsync',
]);

// Commands that can operate on a single file without a project index.
// Used by CLI to decide whether to build a file-local or project-wide index.
const FILE_LOCAL_COMMANDS = new Set(['find', 'usages', 'search', 'source', 'api']);

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Resolve a surface-specific command name to its canonical ID.
 *
 * @param {string} name  - Command name as used by the surface (e.g. 'audit-async', 'audit_async')
 * @param {'cli'|'mcp'} [surface='cli'] - Surface spelling to resolve
 * @returns {string|null} Canonical command ID, or null if unknown
 */
function resolveCommand(name, surface) {
    if (CANONICAL_COMMANDS.includes(name)) return name;
    if (surface === 'mcp') {
        return CANONICAL_COMMANDS.find(cmd => toMcpName(cmd) === name) || null;
    }
    return CANONICAL_COMMANDS.find(cmd => toCliName(cmd) === name) || null;
}

function editDistance(left, right) {
    const a = String(left || '').toLowerCase();
    const b = String(right || '').toLowerCase();
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const above = row[j];
            row[j] = Math.min(
                row[j] + 1,
                row[j - 1] + 1,
                diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
            diagonal = above;
        }
    }
    return row[b.length];
}

/**
 * Return a single high-confidence correction for a misspelled public command.
 * The threshold is deliberately strict because the CLI's first positional can
 * also be a project path; an unrelated missing path must not become a command.
 */
function suggestCommand(name, surface = 'cli') {
    if (!name) return null;
    const spellings = CANONICAL_COMMANDS.map(command => ({
        command,
        spelling: surface === 'mcp' ? toMcpName(command) : toCliName(command),
    }));
    const ranked = spellings
        .map(row => ({ ...row, distance: editDistance(name, row.spelling) }))
        // Code-unit tiebreak (rule 11) — registry stays require-free, so the
        // comparison is inlined instead of importing shared.codeUnitCompare.
        .sort((a, b) => a.distance - b.distance ||
            (a.spelling < b.spelling ? -1 : a.spelling > b.spelling ? 1 : 0));
    const best = ranked[0];
    const threshold = String(name).length <= 4 ? 2 : Math.min(3, Math.floor(String(name).length / 3));
    if (!best || best.distance > threshold) return null;
    if (ranked[1] && ranked[1].distance === best.distance) return null;
    return best.spelling;
}

/**
 * Convert snake_case params to camelCase.
 * Passes through params not in PARAM_MAP unchanged.
 */
function normalizeParams(params) {
    const result = {};
    for (const [key, value] of Object.entries(params)) {
        result[PARAM_MAP[key] || key] = value;
    }
    return result;
}

// ============================================================================
// SURFACE-SPECIFIC GENERATORS
// ============================================================================

/**
 * Generate the exact CLI command set using hyphenated surface spelling.
 */
function getCliCommandSet() {
    const set = new Set();

    for (const cmd of CANONICAL_COMMANDS) {
        // Add hyphenated form for CLI (single-word commands stay as-is)
        const hyphenated = cmd.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
        set.add(hyphenated);
    }

    return set;
}

/**
 * Generate the MCP z.enum array.
 * Uses snake_case for multi-word commands.
 */
function getMcpCommandEnum() {
    return CANONICAL_COMMANDS.map(cmd => {
        // Convert camelCase → snake_case for multi-word
        return cmd.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    });
}

/**
 * Convert a canonical command ID to its MCP surface name.
 */
function toMcpName(canonical) {
    return canonical.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Convert a canonical command ID to its CLI surface name (hyphenated).
 */
function toCliName(canonical) {
    return canonical.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function formatSurfaceMessage(message, surface = 'cli') {
    let rendered = String(message || '');
    for (const [snake, camel] of Object.entries(PARAM_MAP)) {
        const spellings = [snake, camel];
        const target = surface === 'mcp'
            ? snake
            : `--${snake.replace(/_/g, '-')}`;
        for (const spelling of spellings) {
            rendered = rendered.replace(
                new RegExp(`(?<![A-Za-z0-9_-])${spelling}(?![A-Za-z0-9_-])`, 'g'),
                target,
            );
        }
    }
    const knownParams = new Set(Object.values(FLAG_APPLICABILITY).flat());
    const booleanParams = new Set([
        'includeTests', 'excludeTests', 'includeMethods', 'withTypes',
        'codeOnly', 'caseSensitive', 'includeExported', 'includeDecorated',
        'showConfidence', 'callsOnly', 'topLevel', 'followSymlinks',
        'unreachableOnly', 'serverOnly', 'clientOnly', 'hideUncertain',
        'expandUnverified', 'withSource', 'all', 'compact', 'exact',
        'regex', 'exported', 'unused', 'staged', 'detailed', 'functions',
        'hot', 'deep', 'cycles', 'bridge', 'unmatched', 'diverse', 'git',
    ]);
    if (surface === 'mcp') {
        rendered = rendered.replace(/--([a-z][a-z0-9-]*)(?:=([^\s,.)]+))?/g,
            (whole, flag, rawValue) => {
                const camel = flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                if (!knownParams.has(camel) && !['maxChars', 'maxFiles'].includes(camel)) {
                    return whole;
                }
                const snake = REVERSE_PARAM_MAP[camel] || camel;
                if (rawValue != null) {
                    const value = rawValue === 'N' ? '<n>' : rawValue;
                    return `${snake}=${value}`;
                }
                return booleanParams.has(camel) ? `${snake}=true` : snake;
            });
        rendered = rendered
            .replace(/\b(line|top|limit|depth|max_lines|max_files|max_chars)=(?=\s|[,.]|$)/g, '$1=<n>')
            .replace(/\b(file|in|exclude)=(?=\s|[,.]|$)/g, '$1=<path>')
            .replace(/\bclass_name=(?=\s|[,.]|$)/g, 'class_name=<name>');
    } else {
        // Single-word parameters are intentionally absent from PARAM_MAP.
        // Translate them only in parameter syntax (`file=`, not prose "file").
        for (const param of knownParams) {
            if (REVERSE_PARAM_MAP[param] || Object.values(PARAM_MAP).includes(param)) continue;
            rendered = rendered.replace(
                new RegExp(`(?<![A-Za-z0-9_-])${param}(?=\\s*=)`, 'g'),
                `--${param.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
            );
        }
        rendered = rendered.replace(/(--[a-z][a-z0-9-]*)=true\b/g, '$1');
        rendered = rendered
            .replace(/--(line|top|limit|depth|max-lines|max-files|max-chars)=(?=\s|[,.]|$)/g, '--$1=N')
            .replace(/--(file|in|exclude)=(?=\s|[,.]|$)/g, '--$1=<path>')
            .replace(/--class-name=(?=\s|[,.]|$)/g, '--class-name=<name>');
    }
    return rendered;
}

/**
 * Build a reverse map: camelCase → snake_case from PARAM_MAP.
 * Flags not in PARAM_MAP are already snake_case-safe (single words).
 */
function buildReverseParamMap() {
    const rev = {};
    for (const [snake, camel] of Object.entries(PARAM_MAP)) {
        rev[camel] = snake;
    }
    return rev;
}

const REVERSE_PARAM_MAP = buildReverseParamMap();

const CLI_GLOBAL_FLAGS = Object.freeze([
    '--help', '-h', '--version', '-v', '--mcp',
    '--json', '--verbose', '--no-quiet', '--quiet',
    '--interactive', '-i',
    '--no-cache', '--clear-cache', '--no-follow-symlinks',
    '--max-files', '--max-chars', '--workers',
]);

const CLI_PARAM_FLAG_OVERRIDES = Object.freeze({
    exclude: ['--exclude', '--not'],
    includeMethods: ['--include-methods', '--no-include-methods'],
    regex: ['--regex', '--no-regex'],
    showConfidence: ['--show-confidence', '--hide-confidence', '--no-confidence'],
    hideUncertain: ['--hide-uncertain', '--no-uncertain'],
    compact: ['--compact', '--no-compact'],
    defaultValue: ['--default-value', '--default'],
});

function cliFlagsForParam(param) {
    if (CLI_PARAM_FLAG_OVERRIDES[param]) {
        return CLI_PARAM_FLAG_OVERRIDES[param];
    }
    const snake = REVERSE_PARAM_MAP[param] || param;
    return [`--${snake.replace(/_/g, '-')}`];
}

function getCliFlagsForCommand(command) {
    const canonical = resolveCommand(command, 'cli') || command;
    return [...new Set((FLAG_APPLICABILITY[canonical] || [])
        .filter(param => !['name', 'term'].includes(param))
        .flatMap(cliFlagsForParam))];
}

function getCliAcceptedFlags() {
    const accepted = new Set(CLI_GLOBAL_FLAGS);
    for (const command of CANONICAL_COMMANDS) {
        for (const flag of getCliFlagsForCommand(command)) accepted.add(flag);
    }
    return accepted;
}

/**
 * Generate per-command parameter listing for the MCP tool description.
 * Maps camelCase flags back to snake_case for MCP clients.
 * One line per command: `show: file, exclude, class_name, ...`
 */
function generateMcpParamSection() {
    const lines = ['', 'ACCEPTED FLAGS PER COMMAND (max_chars, max_files, follow_symlinks always accepted; flags not listed below are ignored):'];
    for (const cmd of CANONICAL_COMMANDS) {
        const flags = FLAG_APPLICABILITY[cmd];
        if (!flags || flags.length === 0) continue;
        const mcpCmd = toMcpName(cmd);
        const mcpFlags = flags.map(f => REVERSE_PARAM_MAP[f] || f);
        lines.push(`  ${mcpCmd}: ${mcpFlags.join(', ')}`);
    }
    return lines.join('\n');
}

module.exports = {
    CANONICAL_COMMANDS,
    V4_COMMAND_MIGRATIONS,
    v4MigrationHint,
    PARAM_MAP,
    REVERSE_PARAM_MAP,
    FLAG_APPLICABILITY,
    BROAD_COMMANDS,
    FILE_LOCAL_COMMANDS,
    resolveCommand,
    suggestCommand,
    normalizeParams,
    getCliCommandSet,
    getMcpCommandEnum,
    toMcpName,
    toCliName,
    formatSurfaceMessage,
    cliFlagsForParam,
    getCliFlagsForCommand,
    getCliAcceptedFlags,
    generateMcpParamSection,
};
