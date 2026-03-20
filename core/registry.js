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
    'about', 'context', 'impact', 'blast', 'smart', 'trace', 'reverseTrace', 'example', 'related',
    // Finding code
    'find', 'usages', 'toc', 'search', 'tests', 'affectedTests', 'deadcode', 'entrypoints',
    // Extracting code
    'fn', 'class', 'lines', 'expand',
    // File dependencies
    'imports', 'exporters', 'fileExports', 'graph', 'circularDeps',
    // Refactoring
    'verify', 'plan', 'diffImpact',
    // Other
    'typedef', 'stacktrace', 'api', 'stats',
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
};

// MCP uses snake_case for multi-word names.
const MCP_ALIASES = {
    'file_exports':   'fileExports',
    'diff_impact':    'diffImpact',
    'affected_tests': 'affectedTests',
    'reverse_trace':  'reverseTrace',
    'circular_deps':  'circularDeps',
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
};

// ============================================================================
// FLAG APPLICABILITY MATRIX
// ============================================================================

// Per-command list of accepted flag names (camelCase). Source of truth for help text,
// MCP param stripping, CLI inapplicable-flag warnings, and architecture guards.
// file* = file is the command subject (required), not a filter pattern.
const FLAG_APPLICABILITY = {
    // Understanding code
    about:        ['file', 'exclude', 'className', 'includeMethods', 'includeUncertain', 'includeTests', 'top', 'all', 'withTypes', 'minConfidence', 'showConfidence'],
    context:      ['file', 'exclude', 'className', 'includeMethods', 'includeUncertain', 'minConfidence', 'showConfidence'],
    impact:       ['file', 'exclude', 'className', 'top'],
    blast:        ['file', 'exclude', 'className', 'includeMethods', 'includeUncertain', 'depth', 'all', 'minConfidence'],
    reverseTrace: ['file', 'exclude', 'className', 'includeMethods', 'includeUncertain', 'depth', 'all', 'minConfidence'],
    smart:        ['file', 'exclude', 'className', 'includeMethods', 'includeUncertain', 'withTypes', 'minConfidence'],
    trace:        ['file', 'exclude', 'className', 'includeMethods', 'includeUncertain', 'depth', 'all', 'minConfidence'],
    example:      ['file', 'className'],
    related:      ['file', 'className', 'top', 'all'],
    // Finding code
    find:         ['file', 'exclude', 'className', 'includeTests', 'top', 'limit', 'exact', 'in', 'all', 'depth'],
    usages:       ['file', 'exclude', 'className', 'includeTests', 'limit', 'codeOnly', 'context', 'in'],
    toc:          ['file', 'exclude', 'top', 'limit', 'all', 'detailed', 'topLevel', 'in'],
    search:       ['file', 'exclude', 'includeTests', 'top', 'limit', 'codeOnly', 'caseSensitive', 'context', 'regex', 'in', 'type', 'param', 'receiver', 'returns', 'decorator', 'exported', 'unused'],
    tests:        ['file', 'exclude', 'className', 'callsOnly'],
    affectedTests:['file', 'exclude', 'className', 'includeMethods', 'includeUncertain', 'depth', 'minConfidence'],
    deadcode:     ['file', 'exclude', 'includeTests', 'includeExported', 'includeDecorated', 'limit', 'in'],
    entrypoints:  ['file', 'exclude', 'includeTests', 'limit', 'type', 'framework'],
    // Extracting code
    fn:           ['file', 'className', 'all'],
    class:        ['file', 'all', 'maxLines'],
    lines:        ['file', 'range'],
    expand:       [],
    // File dependencies
    imports:      ['file'],
    exporters:    ['file'],
    fileExports:  ['file'],
    graph:        ['file', 'depth', 'direction', 'all'],
    circularDeps: ['file', 'exclude'],
    // Refactoring
    verify:       ['file', 'className'],
    plan:         ['file', 'className', 'addParam', 'removeParam', 'renameTo', 'defaultValue'],
    diffImpact:   ['file', 'limit', 'base', 'staged', 'all'],
    // Other
    typedef:      ['file', 'className', 'exact'],
    stacktrace:   ['stack'],
    api:          ['file', 'limit'],
    stats:        ['functions', 'top'],
};

// Commands whose output is project-wide — truncation means you need a filter, not more text.
// Used by MCP server for tighter default output limits.
const BROAD_COMMANDS = new Set([
    'toc', 'entrypoints', 'diffImpact', 'affectedTests',
    'deadcode', 'usages', 'reverseTrace', 'circularDeps',
]);

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
    const lines = ['', 'ACCEPTED FLAGS PER COMMAND (name, term, stack, range, base, staged, max_chars always accepted; flags not listed below are ignored):'];
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
    resolveCommand,
    normalizeParams,
    getCliCommandSet,
    getMcpCommandEnum,
    toMcpName,
    toCliName,
    generateMcpParamSection,
};
