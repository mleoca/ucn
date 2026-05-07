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

// All commands using camelCase canonical IDs.
// Order: understanding, finding, extracting, file-deps, refactoring, other.
const CANONICAL_COMMANDS = [
    // Understanding code
    'about', 'context', 'impact', 'blast', 'smart', 'trace', 'reverseTrace', 'example', 'related', 'brief',
    // Finding code
    'find', 'usages', 'toc', 'search', 'tests', 'affectedTests', 'deadcode', 'entrypoints', 'endpoints',
    // Extracting code
    'fn', 'class', 'lines', 'expand',
    // File dependencies
    'imports', 'exporters', 'fileExports', 'graph', 'circularDeps',
    // Refactoring
    'verify', 'plan', 'diffImpact', 'check',
    // Other
    'typedef', 'stacktrace', 'api', 'stats', 'doctor', 'auditAsync',
];

// ============================================================================
// COMMAND ALIASES (surface-specific → canonical)
// ============================================================================

// CLI uses hyphenated multi-word names plus legacy aliases.
const CLI_ALIASES = {
    'file-exports': 'fileExports',
    'what-exports': 'fileExports',
    'diff-impact':  'diffImpact',
    'what-imports': 'imports',
    'who-imports':  'exporters',
    'stack':           'stacktrace',
    'affected':        'affectedTests',
    'affected-tests':  'affectedTests',
    'reverse-trace':   'reverseTrace',
    'rtrace':          'reverseTrace',
    'circular-deps':   'circularDeps',
    'circular':        'circularDeps',
    'cycles':          'circularDeps',
    'audit-async':     'auditAsync',
    // BUG-3: parity with other multi-word commands (circular-deps, reverse-trace, ...)
    'entry-points':    'entrypoints',
};

// MCP uses snake_case for multi-word names.
const MCP_ALIASES = {
    'file_exports':   'fileExports',
    'diff_impact':    'diffImpact',
    'affected_tests': 'affectedTests',
    'reverse_trace':  'reverseTrace',
    'circular_deps':  'circularDeps',
    'audit_async':    'auditAsync',
};

// ============================================================================
// PARAM NORMALIZATION (snake_case → camelCase)
// ============================================================================

const PARAM_MAP = {
    project_dir:       'projectDir',
    include_tests:     'includeTests',
    include_methods:   'includeMethods',
    include_uncertain: 'includeUncertain',
    with_types:        'withTypes',
    code_only:         'codeOnly',
    case_sensitive:    'caseSensitive',
    include_exported:  'includeExported',
    include_decorated: 'includeDecorated',
    min_confidence:    'minConfidence',
    show_confidence:   'showConfidence',
    hide_confidence:   'hideConfidence',
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
};

// ============================================================================
// FLAG APPLICABILITY MATRIX
// ============================================================================

// Per-command list of accepted flag names (camelCase). Source of truth for help text,
// MCP param stripping, CLI inapplicable-flag warnings, and architecture guards.
// file* = file is the command subject (required), not a filter pattern.
const FLAG_APPLICABILITY = {
    // Understanding code
    about:        ['name', 'file', 'exclude', 'className', 'includeMethods', 'includeUncertain', 'includeTests', 'top', 'all', 'withTypes', 'minConfidence', 'showConfidence', 'unreachableOnly', 'compact', 'git'],
    context:      ['name', 'file', 'exclude', 'className', 'includeMethods', 'includeUncertain', 'minConfidence', 'showConfidence', 'unreachableOnly', 'compact'],
    impact:       ['name', 'file', 'exclude', 'className', 'top', 'unreachableOnly', 'compact'],
    blast:        ['name', 'file', 'exclude', 'className', 'includeMethods', 'includeUncertain', 'depth', 'all', 'minConfidence'],
    reverseTrace: ['name', 'file', 'exclude', 'className', 'includeMethods', 'includeUncertain', 'depth', 'all', 'minConfidence'],
    smart:        ['name', 'file', 'exclude', 'className', 'includeMethods', 'includeUncertain', 'withTypes', 'minConfidence'],
    trace:        ['name', 'file', 'exclude', 'className', 'includeMethods', 'includeUncertain', 'depth', 'all', 'minConfidence'],
    example:      ['name', 'file', 'className', 'diverse', 'top', 'includeTests'],
    related:      ['name', 'file', 'className', 'top', 'all'],
    brief:        ['name', 'file', 'className', 'git'],
    // Finding code
    find:         ['name', 'file', 'exclude', 'className', 'includeTests', 'top', 'limit', 'exact', 'in', 'all', 'depth', 'compact'],
    usages:       ['name', 'file', 'exclude', 'className', 'includeTests', 'limit', 'codeOnly', 'context', 'in', 'compact'],
    toc:          ['file', 'exclude', 'top', 'limit', 'all', 'detailed', 'topLevel', 'in'],
    search:       ['term', 'file', 'exclude', 'includeTests', 'top', 'limit', 'codeOnly', 'caseSensitive', 'context', 'regex', 'in', 'type', 'param', 'receiver', 'returns', 'decorator', 'exported', 'unused'],
    tests:        ['name', 'file', 'exclude', 'className', 'callsOnly'],
    affectedTests:['name', 'file', 'exclude', 'className', 'includeMethods', 'includeUncertain', 'depth', 'minConfidence'],
    deadcode:     ['file', 'exclude', 'includeTests', 'includeExported', 'includeDecorated', 'limit', 'in'],
    entrypoints:  ['file', 'exclude', 'includeTests', 'limit', 'type', 'framework'],
    endpoints:    ['file', 'exclude', 'limit', 'framework', 'bridge', 'serverOnly', 'clientOnly', 'unmatched', 'method', 'prefix', 'hideUncertain'],
    // Extracting code
    fn:           ['name', 'file', 'className', 'all'],
    class:        ['name', 'file', 'all', 'maxLines'],
    lines:        ['file', 'range'],
    expand:       ['item'],
    // File dependencies
    imports:      ['file'],
    exporters:    ['file'],
    fileExports:  ['file'],
    graph:        ['file', 'depth', 'direction', 'all'],
    circularDeps: ['file', 'exclude'],
    // Refactoring
    verify:       ['name', 'file', 'className'],
    plan:         ['name', 'file', 'className', 'addParam', 'removeParam', 'renameTo', 'defaultValue'],
    diffImpact:   ['file', 'limit', 'base', 'staged', 'all'],
    check:        ['file', 'base', 'staged', 'limit'],
    // Other
    typedef:      ['name', 'file', 'className', 'exact'],
    stacktrace:   ['stack'],
    api:          ['file', 'limit'],
    stats:        ['functions', 'hot', 'top'],
    doctor:       ['file', 'in', 'limit', 'deep'],
    auditAsync:   ['file', 'exclude', 'limit'],
};

// Commands whose output is project-wide — truncation means you need a filter, not more text.
// Used by MCP server for tighter default output limits.
const BROAD_COMMANDS = new Set([
    'toc', 'entrypoints', 'endpoints', 'diffImpact', 'affectedTests',
    'deadcode', 'usages', 'reverseTrace', 'circularDeps',
    'doctor', 'check', 'auditAsync',
]);

// Commands that can operate on a single file without a project index.
// Used by CLI to decide whether to build a file-local or project-wide index.
const FILE_LOCAL_COMMANDS = new Set(['toc', 'fn', 'class', 'find', 'usages', 'search', 'lines', 'typedef', 'api']);

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Resolve a surface-specific command name to its canonical ID.
 *
 * @param {string} name  - Command name as used by the surface (e.g. 'diff-impact', 'diff_impact')
 * @param {'cli'|'mcp'} [surface='cli'] - Which surface's aliases to check first
 * @returns {string|null} Canonical command ID, or null if unknown
 */
function resolveCommand(name, surface) {
    if (CANONICAL_COMMANDS.includes(name)) return name;
    if (surface === 'mcp') {
        return MCP_ALIASES[name] || CLI_ALIASES[name] || null;
    }
    return CLI_ALIASES[name] || null;
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
 * Generate the CLI COMMANDS set (canonical names + all CLI aliases).
 * Includes hyphenated forms and legacy aliases.
 */
function getCliCommandSet() {
    const set = new Set();

    for (const cmd of CANONICAL_COMMANDS) {
        // Add hyphenated form for CLI (single-word commands stay as-is)
        const hyphenated = cmd.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
        set.add(hyphenated);
    }

    // Add legacy aliases
    for (const alias of Object.keys(CLI_ALIASES)) {
        set.add(alias);
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

/**
 * Generate per-command parameter listing for the MCP tool description.
 * Maps camelCase flags back to snake_case for MCP clients.
 * One line per command: `about: file, exclude, class_name, ...`
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
    CLI_ALIASES,
    MCP_ALIASES,
    PARAM_MAP,
    REVERSE_PARAM_MAP,
    FLAG_APPLICABILITY,
    BROAD_COMMANDS,
    FILE_LOCAL_COMMANDS,
    resolveCommand,
    normalizeParams,
    getCliCommandSet,
    getMcpCommandEnum,
    toMcpName,
    toCliName,
    generateMcpParamSection,
};
