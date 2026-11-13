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
// PARAMETER TABLE
// ============================================================================

// Project/change-wide sweep commands with no required symbol argument:
// truncation means you need a filter, not more text. Their default output
// budget is the smaller one in the parameter table (`maxChars`).
const BROAD_COMMANDS = new Set([
    'repo', 'entrypoints', 'endpoints', 'deadcode',
    'deps', 'check', 'auditAsync',
]);
const BROAD_OUTPUT_CHARS = 3000;

// Structural search kinds. `find` takes the same kinds except `call`, which
// is a call site rather than a definition.
const SEARCH_TYPES = Object.freeze([
    'function', 'class', 'call', 'method', 'type', 'constructor',
    'state', 'field', 'constant', 'macro', 'variable',
    'interface', 'enum', 'struct', 'trait', 'record', 'namespace',
]);
const FIND_TYPES = Object.freeze([
    'type', 'function', 'class', 'variable', 'state', 'constant',
    'field', 'macro', 'method', 'constructor', 'interface', 'enum',
    'struct', 'trait', 'record', 'namespace',
]);

// Every public parameter, declared once. A surface states nothing about a
// parameter that is not here: the MCP input schema, the CLI flag parser with
// its bounds, the help reference and the engine's own validation read this
// table.
//
//   type      string | boolean | integer | number
//   min, max  inclusive bounds of a numeric parameter
//   values    the closed set of accepted values: an array, or an object
//             keyed by command where commands differ. A function is called on
//             first use (a set its owning module derives from its own tables).
//   list      the value is a comma-separated list of `values`
//   fold      'upper' | 'lower': a value is matched after case folding
//   defaults  what the engine uses when the parameter is omitted, keyed by
//             command, `command:mode`, or '*' for every command
//   facts     other numbers the description states
//   examples  sample values of an open set; every command that takes the
//             parameter accepts each one
//   global    accepted by every command (build and transport control)
//   repeat    a CLI value flag that may be given several times
//   cli       flag spellings where they are not `--<kebab-case name>`:
//             an array for a value, { on, off } for a boolean
//   text      the description. {placeholders} are filled from the fields
//             above, so the text itself states no value list and no number.
//
// Key order is the property order of the MCP input schema.
const PARAMS = {
    // `name` and `term` are the positional argument on the CLI: no flag.
    name: { type: 'string', cli: [], text: 'Symbol name or stable path:line:name handle. Used by {commands}.' },
    file: { type: 'string', text: 'File target for source/deps/api or a symbol-disambiguation filter.' },
    sections: {
        type: 'string',
        list: true,
        fold: 'lower',
        values: {
            show: ['summary', 'callers', 'callees', 'source', 'dependencies', 'tests', 'types', 'example', 'related'],
            'show:lines': ['callers', 'callees'],
            repo: ['summary', 'files', 'stats', 'health'],
        },
        defaults: {
            show: ['summary', 'callers', 'callees'],
            'show:lines': ['callers'],
            repo: ['summary'],
            'repo:deep': ['summary', 'health'],
        },
        text: 'Comma-separated projection. {valueSets}. Omitted: {defaults}.',
    },
    exclude: { type: 'string', cli: ['--exclude', '--not'], repeat: true, text: 'Comma-separated patterns to exclude (e.g. "test,mock,vendor")' },
    includeTests: { type: 'boolean', text: 'Include test files in results (excluded when omitted)' },
    excludeTests: { type: 'boolean', text: 'Exclude test files: the default for entrypoints (include_tests=true lists them); usages and endpoints list test files unless exclude_tests=true.' },
    includeMethods: {
        type: 'boolean',
        cli: { on: ['--include-methods'], off: ['--no-include-methods'] },
        text: 'Include method callees where receiver evidence permits. Caller-bearing views always tier method sites.',
    },
    expandUnverified: { type: 'boolean', text: 'trace callers: follow unverified edges; downstream nodes remain marked possible, never confirmed.' },
    minConfidence: {
        type: 'number',
        min: 0,
        max: 1,
        defaults: { '*': 0 },
        text: 'Minimum ordinal evidence weight (legacy name; not a probability) for caller/callee edges, from {min} to {max} (omitted: {default}).',
    },
    showConfidence: {
        type: 'boolean',
        cli: { on: ['--show-confidence'], off: ['--hide-confidence', '--no-confidence'] },
        defaults: { '*': true },
        text: 'show: resolution-evidence labels default to visible (omitted: {default}); set false to hide them. Numeric weights are ordinal, not probabilities.',
    },
    unreachableOnly: { type: 'boolean', text: 'show/impact: retain only relationships unreachable from detected entry points.' },
    withTypes: { type: 'boolean', text: 'show: include related type definitions.' },
    withSource: { type: 'boolean', text: 'Attach exact source to find results.' },
    detailed: { type: 'boolean', text: 'repo files: show symbols per file; deps: include import declarations and importers.' },
    exact: { type: 'boolean', text: 'Exact name match only (no substring matching)' },
    in: { type: 'string', text: 'Only search in this directory path (e.g. "src/core")' },
    top: {
        type: 'integer',
        min: 1,
        max: 10000,
        facts: { unverifiedRows: 10, hot: 10 },
        text: 'Rows per list: a positive integer up to {max}. Omitted, confirmed caller and callee lists are complete, each unverified list prints {fact:unverifiedRows} rows and repo stats lists {fact:hot} hot functions. On search it bounds matches as limit does.',
    },
    depth: {
        type: 'integer',
        min: 0,
        max: 100,
        defaults: { trace: 3, 'trace:entrypoints': 5, deps: 2, tests: 0 },
        text: 'Levels to follow: an integer from {min} to {max}. Omitted: {defaults}. tests at depth {default:tests} lists direct links only.',
    },
    codeOnly: { type: 'boolean', text: 'Exclude matches in comments and strings' },
    context: {
        type: 'integer',
        min: 0,
        max: 1000,
        defaults: { '*': 0 },
        text: 'Lines of context around each match: an integer from {min} to {max} (omitted: {default}).',
    },
    includeExported: { type: 'boolean', text: 'Include exported symbols in deadcode results' },
    includeDecorated: { type: 'boolean', text: 'Include decorated/annotated symbols in deadcode results' },
    callsOnly: { type: 'boolean', text: 'tests: retain direct calls and test-case matches only.' },
    maxLines: {
        type: 'integer',
        min: 1,
        max: 1000000,
        text: 'source: maximum lines per declaration, a positive integer up to {max}; raw mode discloses any truncation.',
    },
    direction: {
        type: 'string',
        values: { trace: ['callees', 'callers'], deps: ['imports', 'importers', 'both'] },
        defaults: { trace: 'callees', deps: 'both' },
        text: '{valueSets}. Omitted: {defaults}.',
    },
    to: {
        type: 'string',
        values: { trace: ['entrypoints'] },
        text: 'trace with direction=callers: continue toward entry points. {valueSets}.',
    },
    cycles: { type: 'boolean', text: 'deps: report circular imports instead of a file graph.' },
    term: { type: 'string', cli: [], text: 'Literal search term by default. Set regex=true only for regular-expression syntax.' },
    regex: {
        type: 'boolean',
        cli: { on: ['--regex'], off: ['--no-regex'] },
        text: 'Treat search term as a regular expression; omitted, the term is literal. Ordinary patterns run in an RE2-compatible linear-time engine; unsafe nested repetition is rejected.',
    },
    functions: { type: 'boolean', text: 'repo stats: include per-function line counts sorted by size.' },
    hot: { type: 'boolean', text: 'repo stats: include the top N most-called functions.' },
    diverse: { type: 'boolean', text: 'show example: return representatives from distinct argument shapes.' },
    lines: { type: 'boolean', text: '{commands}: path:line:text listings without default row caps; explicit top/limit still apply. show lists the sections its sections parameter names. Tier tags follow a tab; accounting and notes follow as "# " lines. Under an output budget the rows that fit are printed and one "# truncated" line counts the rest.' },
    raw: { type: 'boolean', text: 'source: code text without a header or line-number gutter, including full large classes. Notes follow as "# " lines; MCP transport budgets still apply.' },
    git: { type: 'boolean', text: 'show summary: attach last-modified, author, and recent-change metadata.' },
    addParam: { type: 'string', text: 'Parameter name to add (plan command)' },
    removeParam: { type: 'string', text: 'Parameter name to remove (plan command)' },
    renameTo: { type: 'string', text: 'New name for the function, method, or type (plan command)' },
    defaultValue: { type: 'string', cli: ['--default-value', '--default'], text: 'Default value for added parameter (plan command)' },
    delete: { type: 'boolean', text: 'plan: assess deleting the declaration. Returns no-static-dependents, has-static-dependents or review with its basis; static evidence, never a deletion guarantee.' },
    stack: { type: 'string', text: 'The stack trace text to parse (stacktrace command)' },
    range: { type: 'string', text: 'source line range, e.g. "10-20" or "15", of the file given as file or name.' },
    base: {
        type: 'string',
        defaults: { '*': 'HEAD' },
        text: 'Git ref (omitted: {default}). impact/check without a symbol: diff against it; check with a symbol: compare the declaration with its version there. E.g. "HEAD~3", "main", a commit SHA',
    },
    staged: { type: 'boolean', text: 'impact/check without a symbol: analyze staged changes.' },
    strict: { type: 'boolean', text: 'check without a symbol: REVIEW_REQUIRED fails too (trust.passes=false), not only BLOCKED.' },
    deep: { type: 'boolean', text: 'repo: include health and sample the ordinal resolution-evidence profile, not accuracy.' },
    compact: {
        type: 'boolean',
        cli: { on: ['--compact'], off: ['--no-compact'] },
        defaults: { show: true, impact: true, find: false, usages: false },
        text: 'Compact output. Omitted: {defaults}; set the opposite value to change that command\'s presentation.',
    },
    caseSensitive: { type: 'boolean', text: 'Case-sensitive search; omitted, the search ignores case.' },
    all: { type: 'boolean', text: 'Lift formatter and result caps where supported.' },
    topLevel: { type: 'boolean', text: 'repo files: show only top-level functions.' },
    className: { type: 'string', text: 'Class name to scope method analysis (e.g. "MarketDataFetcher" for close)' },
    line: {
        type: 'integer',
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
        text: 'Definition line pin. Resolves the symbol defined at this exact line (the middle component of a file:line:name handle). Disambiguates same-file same-name definitions.',
    },
    limit: {
        type: 'integer',
        min: 1,
        max: 1000000,
        defaults: { find: 500, search: 500, 'search:structural': 50, api: 500, repo: 500, deadcode: 500 },
        facts: { findDetail: 5 },
        text: 'Max results: a positive integer up to {max}. Omitted: {defaults}; other commands and lines listings have no cap. For repo it bounds the files section. find text shows the top {fact:findDetail} in detail and counts the rest; limit raises both.',
    },
    maxFiles: {
        type: 'integer',
        min: 1,
        max: 10000000,
        global: true,
        defaults: { '*': 50000 },
        text: 'Max files to index: a positive integer up to {max} (omitted: {default}). Use for very large codebases.',
    },
    maxChars: {
        type: 'integer',
        min: 1,
        max: 100000,
        global: true,
        defaults: {
            ...Object.fromEntries(CANONICAL_COMMANDS.filter(command => BROAD_COMMANDS.has(command))
                .map(command => [command, BROAD_OUTPUT_CHARS])),
            '*': 10000,
        },
        text: 'Max output characters, not UTF-8 bytes, including notes and preserved metadata: a positive integer up to {max}. Omitted: {defaults}. all=true lifts formatter caps but keeps the {max} transport ceiling.',
    },
    type: {
        type: 'string',
        values: {
            search: SEARCH_TYPES,
            find: FIND_TYPES,
            entrypoints: () => require('./entrypoints').ENTRYPOINT_TYPES,
        },
        text: 'Kind filter. {valueSets}. On search it selects structural, index-based search.',
    },
    param: { type: 'string', text: 'Filter by parameter name or type (structural search). E.g. "Request", "ctx".' },
    receiver: { type: 'string', text: 'Filter calls by receiver (structural search, type=call). E.g. "db", "http".' },
    returns: { type: 'string', text: 'Filter by return type (structural search). E.g. "Promise", "error".' },
    decorator: { type: 'string', text: 'Filter by decorator/annotation (structural search). E.g. "Route", "Test".' },
    exported: { type: 'boolean', text: 'Only exported/public symbols (structural search).' },
    unused: { type: 'boolean', text: 'Only symbols with zero callers (structural search).' },
    framework: {
        type: 'string',
        list: true,
        fold: 'lower',
        // entrypoints takes the labels of its patterns. endpoints takes a
        // label its detectors declare or one a row of the answer carries,
        // which its handler decides. The sets are long and every row prints
        // its label: the description names examples, a refusal lists the set.
        values: { entrypoints: () => require('./entrypoints').ENTRYPOINT_FRAMEWORKS },
        examples: ['express', 'spring', 'flask'],
        text: 'Framework label filter for entrypoints (comma-separated for several) and endpoints, e.g. {examples}. An unknown label is refused with the labels the command knows.',
    },
    followSymlinks: {
        type: 'boolean',
        global: true,
        cli: { on: [], off: ['--no-follow-symlinks'] },
        defaults: { '*': true },
        text: 'Follow symlinks during file discovery (omitted: {default}).',
    },
    includeBundled: {
        type: 'boolean',
        global: true,
        text: 'Index *.min.js and *.bundle.js files, which are left out when omitted. Source maps remain disclosed but unindexed. Bypasses the shared cache.',
    },
    bridge: { type: 'boolean', text: 'Match server routes to client requests (endpoints command).' },
    serverOnly: { type: 'boolean', text: 'Only list server routes (endpoints command).' },
    clientOnly: { type: 'boolean', text: 'Only list client requests (endpoints command).' },
    unmatched: { type: 'boolean', text: 'Only show unmatched routes/requests (endpoints command).' },
    method: {
        type: 'string',
        fold: 'upper',
        values: { endpoints: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'ALL', 'USE'] },
        text: 'Filter by HTTP method, in any letter case. {valueSets}.',
    },
    prefix: { type: 'string', text: 'Filter routes/requests by path prefix (endpoints command).' },
    hideUncertain: {
        type: 'boolean',
        cli: { on: ['--hide-uncertain', '--no-uncertain'], off: [] },
        text: 'Hide uncertain (interpolated-path) bridges (endpoints command).',
    },
};

const toSnakeCase = name => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const toKebabCase = name => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

// ============================================================================
// PARAM NORMALIZATION (snake_case → camelCase)
// ============================================================================

// MCP spells a parameter in snake_case. Derived from the table; `project_dir`
// is the one transport field that is not a parameter of a command.
const PARAM_MAP = { project_dir: 'projectDir' };
for (const param of Object.keys(PARAMS)) {
    const snake = toSnakeCase(param);
    if (snake !== param) PARAM_MAP[snake] = param;
}

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
    show:         ['name', 'file', 'exclude', 'className', 'line', 'sections', 'includeMethods', 'includeTests', 'top', 'all', 'withTypes', 'minConfidence', 'showConfidence', 'unreachableOnly', 'compact', 'git', 'diverse', 'lines'],
    find:         ['name', 'file', 'exclude', 'className', 'includeTests', 'limit', 'exact', 'in', 'compact', 'type', 'withSource', 'lines'],
    usages:       ['name', 'file', 'exclude', 'className', 'excludeTests', 'limit', 'codeOnly', 'context', 'in', 'compact', 'all', 'lines'],
    search:       ['term', 'file', 'exclude', 'includeTests', 'top', 'limit', 'codeOnly', 'caseSensitive', 'context', 'regex', 'in', 'type', 'param', 'receiver', 'returns', 'decorator', 'exported', 'unused', 'lines'],
    source:       ['name', 'file', 'className', 'line', 'range', 'all', 'maxLines', 'raw'],
    trace:        ['name', 'file', 'exclude', 'className', 'line', 'direction', 'to', 'includeMethods', 'depth', 'all', 'expandUnverified'],
    impact:       ['name', 'file', 'exclude', 'className', 'line', 'includeMethods', 'top', 'unreachableOnly', 'compact', 'base', 'staged', 'limit', 'all', 'lines'],
    tests:        ['name', 'file', 'exclude', 'className', 'line', 'callsOnly', 'depth', 'includeMethods', 'all'],
    deps:         ['file', 'exclude', 'depth', 'direction', 'all', 'detailed', 'cycles'],
    api:          ['file', 'in', 'limit', 'includeTests'],
    check:        ['name', 'file', 'className', 'line', 'includeMethods', 'base', 'staged', 'limit', 'strict'],
    plan:         ['name', 'file', 'className', 'line', 'addParam', 'removeParam', 'renameTo', 'defaultValue', 'delete'],
    repo:         ['file', 'exclude', 'top', 'limit', 'all', 'detailed', 'topLevel', 'in', 'functions', 'hot', 'deep', 'sections'],
    deadcode:     ['file', 'exclude', 'includeTests', 'includeExported', 'includeDecorated', 'limit', 'in'],
    entrypoints:  ['file', 'exclude', 'includeTests', 'excludeTests', 'limit', 'type', 'framework'],
    endpoints:    ['file', 'in', 'exclude', 'excludeTests', 'limit', 'framework', 'bridge', 'serverOnly', 'clientOnly', 'unmatched', 'method', 'prefix', 'hideUncertain'],
    stacktrace:   ['stack'],
    auditAsync:   ['file', 'exclude', 'limit'],
};

// Commands that can operate on a single file without a project index.
// Used by CLI to decide whether to build a file-local or project-wide index.
const FILE_LOCAL_COMMANDS = new Set(['find', 'usages', 'search', 'source', 'api']);

// Parameters whose presence selects structural (index-based) search.
const STRUCTURAL_SEARCH_PARAMS = Object.freeze(['type', 'param', 'receiver', 'returns', 'decorator', 'exported', 'unused']);

// ============================================================================
// PARAMETER TABLE ACCESS
// ============================================================================

const GLOBAL_PARAMS = Object.freeze(Object.keys(PARAMS).filter(param => PARAMS[param].global));
const BOOLEAN_PARAMS = Object.freeze(Object.keys(PARAMS).filter(param => PARAMS[param].type === 'boolean'));

/**
 * The mode of a command that changes a value set or a default: `show` with
 * lines, `repo` with deep, `trace` toward entry points, structural `search`.
 */
function commandMode(command, params = {}) {
    if (command === 'show' && params.lines) return 'lines';
    if (command === 'repo' && params.deep) return 'deep';
    if (command === 'trace' && params.to === 'entrypoints') return 'entrypoints';
    if (command === 'search' && STRUCTURAL_SEARCH_PARAMS.some(key => params[key])) return 'structural';
    return null;
}

/** The entry of a per-command map for `command` in `mode`: `command:mode`, then `command`, then '*'. */
function commandEntry(map, command, mode) {
    if (!map) return undefined;
    if (mode && Object.hasOwn(map, `${command}:${mode}`)) return map[`${command}:${mode}`];
    if (Object.hasOwn(map, command)) return map[command];
    return map['*'];
}

const resolvedValueSets = new Map();
/** A value set, calling a deferred one once. */
function resolveValueSet(param, key, set) {
    if (typeof set !== 'function') return set;
    const cacheKey = `${param}\u0000${key}`;
    if (!resolvedValueSets.has(cacheKey)) resolvedValueSets.set(cacheKey, Object.freeze([...set()]));
    return resolvedValueSets.get(cacheKey);
}

/**
 * The closed set of values `param` accepts on `command`, or null when the
 * parameter is free-form there. `mode` selects a narrower set where the
 * table has one (`show` with lines).
 */
function paramValues(param, command, mode = null) {
    const values = PARAMS[param]?.values;
    if (!values) return null;
    if (Array.isArray(values)) return values;
    if (typeof values === 'function') return resolveValueSet(param, '*', values);
    const key = mode && Object.hasOwn(values, `${command}:${mode}`) ? `${command}:${mode}`
        : Object.hasOwn(values, command) ? command
            : Object.hasOwn(values, '*') ? '*' : null;
    return key === null ? null : resolveValueSet(param, key, values[key]);
}

/** What the engine uses when `param` is omitted on `command` (in `mode`); undefined when it has no default there. */
function paramDefault(param, command = '*', mode = null) {
    return commandEntry(PARAMS[param]?.defaults, command, mode);
}

/** A number the description of `param` states. */
function paramFact(param, name) {
    return PARAMS[param]?.facts?.[name];
}

/** Inclusive bounds of a numeric parameter. */
function paramRange(param) {
    const spec = PARAMS[param] || {};
    return { min: spec.min, max: spec.max };
}

function integerLabel(min) {
    return min === 0 ? 'non-negative integer' : 'positive integer';
}

/**
 * Why `value` is outside the bounds of numeric `param`, or null. `label` is
 * the spelling the message uses for the parameter.
 */
function paramRangeError(param, value, label = param) {
    const spec = PARAMS[param];
    if (!spec || (spec.type !== 'integer' && spec.type !== 'number')) return null;
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (spec.type === 'integer') {
        if (String(value).trim() === '' || !Number.isInteger(n) || n < spec.min) {
            return `Invalid ${label} value: must be a ${integerLabel(spec.min)} (got ${typeof value === 'number' ? value : `"${value}"`})`;
        }
        if (n > spec.max) return `Invalid ${label} value: ${n} exceeds maximum (${spec.max})`;
        return null;
    }
    if (String(value).trim() === '' || !Number.isFinite(n) || n < spec.min || n > spec.max) {
        return `Invalid ${label} value: "${value}" — must be a number between ${spec.min} and ${spec.max}.`;
    }
    return null;
}

const foldValue = (fold, value) => (fold === 'upper' ? value.toUpperCase() : fold === 'lower' ? value.toLowerCase() : value);

/** The values a caller wrote for a closed-set parameter: each as written and as the table folds it. */
function writtenValues(param, value) {
    const spec = PARAMS[param];
    const parts = spec.list
        ? (Array.isArray(value) ? value : String(value).split(','))
        : [value];
    return parts.map(part => String(part).trim()).filter(Boolean)
        .map(written => ({ written, folded: foldValue(spec.fold, written) }));
}

/**
 * Why a parameter of `command` holds a value the table does not allow, or
 * null: a number outside its bounds, a value outside a closed set. One rule
 * and one wording for every surface and every programmatic caller.
 */
function paramTableError(command, params = {}) {
    const applicable = FLAG_APPLICABILITY[command] || [];
    const mode = commandMode(command, params);
    for (const [param, spec] of Object.entries(PARAMS)) {
        const value = params[param];
        if (value === undefined || value === null) continue;
        if (!spec.global && !applicable.includes(param)) continue;
        const rangeError = paramRangeError(param, value);
        if (rangeError) return rangeError;
        const allowed = paramValues(param, command, mode);
        if (!allowed || value === '' || (Array.isArray(value) && value.length === 0)) continue;
        const written = writtenValues(param, value);
        const subject = `${toMcpName(command)}${mode === 'lines' ? ' lines' : ''} ${param}`;
        if (written.length === 0) return `No ${subject} given. Valid: ${allowed.join(', ')}.`;
        const unknown = written.filter(part => !allowed.includes(part.folded)).map(part => part.written);
        if (unknown.length > 0) {
            return `Invalid ${subject} "${unknown.join(', ')}". Valid: ${allowed.join(', ')}.`;
        }
    }
    return null;
}

// How each surface names a command mode.
const MODE_LABELS = Object.freeze({
    mcp: {
        'show:lines': 'show with lines',
        'repo:deep': 'repo with deep',
        'trace:entrypoints': 'trace with to=entrypoints',
        'search:structural': 'structural search',
    },
    cli: {
        'show:lines': 'show --lines',
        'repo:deep': 'repo --deep',
        'trace:entrypoints': 'trace --to=entrypoints',
        'search:structural': 'structural search',
    },
});

function tableKeyLabel(key, surface) {
    if (key === '*') return 'other commands';
    if (MODE_LABELS[surface][key]) return MODE_LABELS[surface][key];
    return surface === 'mcp' ? toMcpName(key) : toCliName(key);
}

/** Every value set of a parameter as `command: values`, one entry per command or mode. */
function valueSetsText(param, surface = 'mcp') {
    const spec = PARAMS[param];
    const join = values => values.join(spec.list ? ',' : ', ');
    if (Array.isArray(spec.values) || typeof spec.values === 'function') return [join(paramValues(param, '*'))];
    return Object.keys(spec.values).map(key => {
        const [command, mode] = key.split(':');
        return `${tableKeyLabel(key, surface)}: ${join(paramValues(param, command, mode || null))}`;
    });
}

/**
 * Every default of a parameter as `commands value`: commands that share a
 * value are named together, in the table's order. A lone '*' entry is the
 * bare value.
 */
function defaultsText(param, surface = 'mcp') {
    const spec = PARAMS[param];
    const text = value => (Array.isArray(value) ? value.join(',') : String(value));
    const entries = Object.entries(spec.defaults);
    if (entries.length === 1 && entries[0][0] === '*') return [text(entries[0][1])];
    const groups = new Map();
    for (const [key, value] of entries) {
        const rendered = text(value);
        if (!groups.has(rendered)) groups.set(rendered, []);
        groups.get(rendered).push(tableKeyLabel(key, surface));
    }
    return [...groups].map(([rendered, keys]) => `${keys.join(', ')} ${rendered}`);
}

/** The description of a parameter with every {placeholder} filled from the table. */
function describeParam(param) {
    const spec = PARAMS[param];
    const join = values => (Array.isArray(values) ? values.join(spec.list ? ',' : ', ') : String(values));
    return spec.text.replace(/\{([a-z]+)(?::([^}]+))?\}/gi, (whole, kind, key) => {
        if (kind === 'values') {
            const [command, mode] = String(key || '*').split(':');
            return join(paramValues(param, command, mode || null));
        }
        if (kind === 'default') {
            const [command, mode] = String(key || '*').split(':');
            return join(paramDefault(param, command, mode || null));
        }
        if (kind === 'valueSets') return valueSetsText(param).join('. ');
        if (kind === 'defaults') return defaultsText(param).join('; ');
        if (kind === 'min') return String(spec.min);
        if (kind === 'max') return String(spec.max);
        if (kind === 'fact') return String(spec.facts[key]);
        if (kind === 'examples') return spec.examples.map(example => `"${example}"`).join(', ');
        if (kind === 'commands') {
            return CANONICAL_COMMANDS.filter(command => FLAG_APPLICABILITY[command].includes(param))
                .map(toMcpName).join('/');
        }
        throw new Error(`registry: unknown placeholder ${whole} in the description of ${param}`);
    });
}

/**
 * The values a JSON schema can enumerate for `param`: the union over
 * commands, when every value is written exactly as listed. A list-valued or
 * case-folded parameter has no schema enumeration; its description states
 * the values and the engine checks them.
 */
function paramSchemaEnum(param) {
    const spec = PARAMS[param];
    if (!spec.values || spec.list || spec.fold) return null;
    if (Array.isArray(spec.values) || typeof spec.values === 'function') return [...paramValues(param, '*')];
    const union = [];
    for (const key of Object.keys(spec.values)) {
        for (const value of resolveValueSet(param, key, spec.values[key])) {
            if (!union.includes(value)) union.push(value);
        }
    }
    return union;
}

/** The MCP input schema property of every parameter, keyed by its snake_case name. */
function mcpParamProperties() {
    const properties = {};
    for (const [param, spec] of Object.entries(PARAMS)) {
        const rule = { type: spec.type, description: describeParam(param) };
        if (spec.type === 'integer' || spec.type === 'number') {
            if (spec.type === 'integer' && spec.min === 1) rule.exclusiveMinimum = 0;
            else if (spec.min !== undefined) rule.minimum = spec.min;
            if (spec.max !== undefined) rule.maximum = spec.max;
        }
        const enumeration = paramSchemaEnum(param);
        if (enumeration) rule.enum = enumeration;
        properties[toSnakeCase(param)] = rule;
    }
    return properties;
}

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
    const booleanParams = new Set(BOOLEAN_PARAMS);
    if (surface === 'mcp') {
        rendered = rendered.replace(/--([a-z][a-z0-9-]*)(?:=([^\s,.)]+))?/g,
            (whole, flag, rawValue) => {
                const camel = flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                if (!knownParams.has(camel) && !GLOBAL_PARAMS.includes(camel)) {
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

/** The CLI spellings of a parameter: { on, off } for a boolean, { value } otherwise. */
function cliSpellings(param) {
    const spec = PARAMS[param];
    const plain = `--${toKebabCase(param)}`;
    if (spec && spec.type === 'boolean') {
        return { on: spec.cli ? spec.cli.on : [plain], off: spec.cli ? spec.cli.off : [] };
    }
    return { value: spec && spec.cli ? spec.cli : [plain] };
}

/** Every CLI flag that sets a parameter, the affirmative spellings first. */
function cliFlagsForParam(param) {
    const spellings = cliSpellings(param);
    return spellings.value || [...spellings.on, ...spellings.off];
}

// Flags of the CLI process itself: none is a parameter of a command.
const CLI_PROCESS_FLAGS = Object.freeze([
    '--help', '-h', '--version', '-v', '--mcp',
    '--json', '--verbose', '--no-quiet', '--quiet',
    '--interactive', '-i',
    '--no-cache', '--clear-cache', '--workers',
]);
// Process flags that take a value.
const CLI_PROCESS_VALUE_FLAGS = Object.freeze(['--workers']);

const CLI_GLOBAL_FLAGS = Object.freeze([
    ...CLI_PROCESS_FLAGS,
    ...GLOBAL_PARAMS.flatMap(cliFlagsForParam),
]);

/** Every CLI flag that consumes a value (`--flag value` or `--flag=value`). */
function getCliValueFlags() {
    const flags = new Set(CLI_PROCESS_VALUE_FLAGS);
    for (const param of Object.keys(PARAMS)) {
        const spellings = cliSpellings(param);
        if (spellings.value) for (const flag of spellings.value) flags.add(flag);
    }
    return flags;
}

function getCliFlagsForCommand(command) {
    const canonical = resolveCommand(command, 'cli') || command;
    return [...new Set((FLAG_APPLICABILITY[canonical] || [])
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
 * The value lists, bounds and defaults of the CLI help: one entry per
 * parameter that has any, written from the table.
 */
function generateCliParamReference() {
    const lines = [];
    for (const [param, spec] of Object.entries(PARAMS)) {
        const parts = [];
        if (spec.type === 'integer' || spec.type === 'number') {
            parts.push(spec.max >= Number.MAX_SAFE_INTEGER ? `${spec.min} or more` : `${spec.min} to ${spec.max}`);
        }
        if (spec.examples) {
            parts.push(`e.g. ${spec.examples.join(', ')}; an unknown value is refused with the known ones`);
        } else if (spec.values) {
            parts.push(...valueSetsText(param, 'cli'));
        }
        if (spec.defaults) parts.push(`default: ${defaultsText(param, 'cli').join('; ')}`);
        if (parts.length === 0) continue;
        const head = `  ${cliFlagsForParam(param)[0]}`.padEnd(19);
        lines.push(`${head}${parts[0]}`);
        for (const part of parts.slice(1)) lines.push(`${' '.repeat(19)}${part}`);
    }
    return lines.join('\n');
}

/**
 * Generate per-command parameter listing for the MCP tool description.
 * Maps camelCase flags back to snake_case for MCP clients.
 * One line per command: `show: file, exclude, class_name, ...`
 */
function generateMcpParamSection() {
    const lines = ['', `ACCEPTED FLAGS PER COMMAND (${GLOBAL_PARAMS.map(toSnakeCase).sort().join(', ')} always accepted; flags not listed below are ignored):`];
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
    cliSpellings,
    getCliFlagsForCommand,
    getCliAcceptedFlags,
    getCliValueFlags,
    generateMcpParamSection,
    generateCliParamReference,
    PARAMS,
    GLOBAL_PARAMS,
    BOOLEAN_PARAMS,
    STRUCTURAL_SEARCH_PARAMS,
    CLI_PROCESS_FLAGS,
    commandMode,
    paramValues,
    paramDefault,
    paramFact,
    paramRange,
    paramRangeError,
    paramTableError,
    describeParam,
    paramSchemaEnum,
    mcpParamProperties,
    toSnakeCase,
    toKebabCase,
};
