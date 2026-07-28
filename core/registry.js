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
    usages:       ['name', 'file', 'exclude', 'className', 'includeTests', 'limit', 'codeOnly', 'context', 'in', 'compact'],
    search:       ['term', 'file', 'exclude', 'includeTests', 'top', 'limit', 'codeOnly', 'caseSensitive', 'context', 'regex', 'in', 'type', 'param', 'receiver', 'returns', 'decorator', 'exported', 'unused'],
    source:       ['name', 'file', 'line', 'range', 'all', 'maxLines'],
    trace:        ['name', 'file', 'exclude', 'className', 'line', 'direction', 'to', 'includeMethods', 'depth', 'all', 'minConfidence', 'expandUnverified'],
    impact:       ['name', 'file', 'exclude', 'className', 'line', 'includeMethods', 'top', 'unreachableOnly', 'compact', 'base', 'staged', 'limit', 'all'],
    tests:        ['name', 'file', 'exclude', 'className', 'line', 'callsOnly', 'depth', 'includeMethods', 'minConfidence', 'all'],
    deps:         ['file', 'exclude', 'depth', 'direction', 'all', 'detailed', 'cycles'],
    api:          ['file', 'limit'],
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
        .sort((a, b) => a.distance - b.distance || a.spelling.localeCompare(b.spelling));
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
    generateMcpParamSection,
};
