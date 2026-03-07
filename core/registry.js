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

// All 28 commands using camelCase canonical IDs.
// Order: understanding, finding, extracting, file-deps, refactoring, other.
const CANONICAL_COMMANDS = [
    // Understanding code
    'about', 'context', 'impact', 'smart', 'trace', 'example', 'related',
    // Finding code
    'find', 'usages', 'toc', 'search', 'tests', 'deadcode',
    // Extracting code
    'fn', 'class', 'lines', 'expand',
    // File dependencies
    'imports', 'exporters', 'fileExports', 'graph',
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
    'stack':        'stacktrace',
};

// MCP uses snake_case for multi-word names.
const MCP_ALIASES = {
    'file_exports': 'fileExports',
    'diff_impact':  'diffImpact',
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
    calls_only:        'callsOnly',
    class_name:        'className',
    max_lines:         'maxLines',
    add_param:         'addParam',
    remove_param:      'removeParam',
    rename_to:         'renameTo',
    default_value:     'defaultValue',
    top_level:         'topLevel',
    max_files:         'maxFiles',
};

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

module.exports = {
    CANONICAL_COMMANDS,
    CLI_ALIASES,
    MCP_ALIASES,
    PARAM_MAP,
    resolveCommand,
    normalizeParams,
    getCliCommandSet,
    getMcpCommandEnum,
    toMcpName,
    toCliName,
};
