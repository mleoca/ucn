#!/usr/bin/env node

/**
 * Universal Code Navigator (UCN) - MCP Server
 *
 * Stdio-based MCP server that wraps ProjectIndex methods.
 * Keeps a per-project index cache for fast repeat queries.
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// MCP SDK IMPORTS (dynamic, to handle missing dependency gracefully)
// ============================================================================

let McpServer, StdioServerTransport, z;

try {
    ({ McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js'));
    ({ StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js'));
    z = require('zod');
} catch (e) {
    console.error('Missing dependencies. Install with:');
    console.error('  npm install @modelcontextprotocol/sdk zod');
    process.exit(1);
}

// ============================================================================
// UCN CORE IMPORTS
// ============================================================================

const { ProjectIndex } = require('../core/project');
const { findProjectRoot } = require('../core/discovery');
const output = require('../core/output');
const { getMcpCommandEnum, normalizeParams, BROAD_COMMANDS: BROAD_CANONICAL, toMcpName, FLAG_APPLICABILITY, REVERSE_PARAM_MAP, generateMcpParamSection, resolveCommand } = require('../core/registry');
const { execute } = require('../core/execute');
const { ExpandCache } = require('../core/expand-cache');

// ============================================================================
// INDEX CACHE
// ============================================================================

const indexCache = new Map(); // projectDir → { index, checkedAt }
const MAX_CACHE_SIZE = 10;
const expandCacheInstance = new ExpandCache();

function getIndex(projectDir, options) {
    const maxFiles = options && options.maxFiles;
    const followSymlinks = options && options.followSymlinks;
    const absDir = path.resolve(projectDir);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        throw new Error(`Project directory not found: ${absDir}`);
    }
    const root = findProjectRoot(absDir);
    const cached = indexCache.get(root);

    // Always check staleness — MCP is used in iterative agent loops where
    // files change between requests, so a throttle causes stale results.
    if (cached && !maxFiles) {
        if (!cached.index.isCacheStale()) {
            cached.checkedAt = Date.now();
            return cached.index;
        }
    }

    // Build new index (or rebuild stale one)
    const index = new ProjectIndex(root);
    const buildOpts = { quiet: true, forceRebuild: false };
    if (maxFiles) buildOpts.maxFiles = maxFiles;
    if (followSymlinks === false) buildOpts.followSymlinks = false;
    const loaded = index.loadCache();
    if (loaded && !maxFiles && !index.isCacheStale()) {
        // Disk cache is fresh (skip when maxFiles is set — cached index may have different file count)
    } else {
        buildOpts.forceRebuild = !!loaded;
        index.build(null, buildOpts);
        if (!maxFiles) index.saveCache(); // Don't pollute disk cache with partial indexes
        // Clear expand cache entries for this project — stale after rebuild
        expandCacheInstance.clearForRoot(root);
    }

    // LRU eviction
    if (indexCache.size >= MAX_CACHE_SIZE && !indexCache.has(root)) {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [key, val] of indexCache) {
            if (val.checkedAt < oldestTime) {
                oldestTime = val.checkedAt;
                oldestKey = key;
            }
        }
        if (oldestKey) {
            indexCache.delete(oldestKey);
            expandCacheInstance.clearForRoot(oldestKey);
        }
    }

    // Don't cache partial indexes (maxFiles) — they'd serve wrong results for full queries
    if (!maxFiles) {
        indexCache.set(root, { index, checkedAt: Date.now() });
    }
    return index;
}

// ============================================================================
// SERVER SETUP
// ============================================================================

const server = new McpServer({
    name: 'ucn',
    version: require('../package.json').version
});

// ============================================================================
// TOOL HELPERS
// ============================================================================

const DEFAULT_OUTPUT_CHARS = 10000;  // ~2.5K tokens — targeted commands (about, context, smart, etc.)
const BROAD_OUTPUT_CHARS = 3000;     // ~750 tokens — broad commands where truncated listings are useless
const MAX_OUTPUT_CHARS = 100000;     // hard ceiling even with max_chars override

// Broad commands (derived from registry): output is project-wide, truncation means you need a filter
const BROAD_COMMANDS = new Set([...BROAD_CANONICAL].map(toMcpName));

function toolResult(text, command, maxChars, suffixNote) {
    const suffix = suffixNote || '';
    if (!text) return { content: [{ type: 'text', text: '(no output)' + suffix }] };
    const defaultLimit = BROAD_COMMANDS.has(command) ? BROAD_OUTPUT_CHARS : DEFAULT_OUTPUT_CHARS;
    const limit = Math.min(maxChars || defaultLimit, MAX_OUTPUT_CHARS);
    if (text.length > limit) {
        const fullSize = text.length;
        const fullTokens = Math.round(fullSize / 4);
        const truncated = text.substring(0, limit);
        // Cut at last newline to avoid breaking mid-line
        const lastNewline = truncated.lastIndexOf('\n');
        const cleanCut = lastNewline > limit * 0.8 ? truncated.substring(0, lastNewline) : truncated;
        // Command-specific narrowing hints
        const hints = {
            toc: 'Use in= to scope to a subdirectory, or detailed=false for compact view.',
            entrypoints: 'Use framework= to filter by framework, exclude= to skip patterns.',
            endpoints: 'Use prefix= to filter by URL prefix, method= to filter by HTTP method, server_only/client_only to halve output.',
            diff_impact: 'Use file= to scope to specific files/directories.',
            affected_tests: 'Use file= to scope, exclude= to skip patterns.',
            deadcode: 'Use file= to scope, exclude= to skip patterns.',
            usages: 'Use file= to scope to specific files.',
        };
        const narrow = hints[command] || 'Use file=/in=/exclude= to narrow scope.';
        return { content: [{ type: 'text', text: cleanCut + `\n\n... OUTPUT TRUNCATED: showing ${limit} of ${fullSize} chars. Full output would be ~${fullTokens} tokens. ${narrow} Or use all=true to see everything (warning: ~${fullTokens} tokens).` + suffix }] };
    }
    return { content: [{ type: 'text', text: text + suffix }] };
}

function toolError(message) {
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/**
 * Resolve a file path via index and validate it's within the project root.
 * Returns the resolved absolute path string, or a toolError response.
 */
function resolveAndValidatePath(index, file) {
    const resolved = index.resolveFilePathForQuery(file);
    if (typeof resolved !== 'string') {
        if (resolved.error === 'file-ambiguous') {
            return toolError(`Ambiguous file "${file}". Candidates:\n${resolved.candidates.map(c => '  ' + c).join('\n')}`);
        }
        return toolError(`File not found: ${file}`);
    }
    // Path boundary check: ensure resolved path is within the project root
    try {
        const realPath = fs.realpathSync(resolved);
        const realRoot = fs.realpathSync(index.root);
        if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
            return toolError(`File is outside project root: ${file}`);
        }
    } catch (e) {
        return toolError(`Cannot resolve file path: ${file}`);
    }
    return resolved;
}

// ============================================================================
// CONSOLIDATED TOOL REGISTRATION
// ============================================================================

const TOOL_DESCRIPTION = `Code intelligence toolkit for AI agents. Extract specific functions, trace call chains, find all callers, and detect dead code — without reading entire files or scanning full projects. Use instead of grep/read for code relationships. Supports JavaScript/TypeScript, Python, Go, Rust, Java, and HTML.

TOP 5 (covers 90% of tasks): about, impact, trace, find, deadcode

QUICK GUIDE — choosing the right command:
  Understand a symbol → about (everything), context (callers/callees only), smart (code + called functions inline)
  Before modifying    → impact (all call sites with args), verify (signature check), plan (preview refactor)
  Execution flow      → trace (function call tree) or graph (file imports/exports)
  Find code           → find (by name), search (by text), toc (project overview)
  Extract code        → fn, class, lines (avoid reading whole files)

Commands:

UNDERSTANDING CODE:
- about <name>: Definition, source, callers, callees, and tests — everything in one call. Replaces 3-4 grep+read cycles. Your first stop for any function or class. Pass git=true for last-modified, author, and recent-changes (last 30d).
- context <name>: Who calls it and what does it call, without source code. Results are numbered for use with expand. For classes/structs, shows all methods instead.
- impact <name>: Every call site with actual arguments passed, grouped by file. Essential before changing a function signature — shows exactly what breaks.
- blast <name>: Transitive blast radius — callers of callers. Shows the full chain of functions affected if you change something. Like impact but recursive. Use depth (default: 3) to control how far up the chain to walk.
- smart <name>: Get a function's source with all called functions expanded inline (not constants/variables). Use to understand or modify a function and its dependencies in one read.
- trace <name>: Call tree from a function downward. Use to understand "what happens when X runs" — maps which modules a pipeline touches without reading files. Set depth (default: 3); setting depth expands all children.
- example <name>: Best real-world usage example. Automatically scores call sites by quality and returns the top one with context. Use to understand expected calling patterns. Set diverse=true to cluster call sites by argument shape and return one representative per cluster (pair with top=N, default 3).
- reverse_trace <name>: Upward call chain to entry points — who calls this, who calls those callers, etc. Use to find all paths that lead to a function. Set depth (default: 5) to control how far up. Complement to trace (which goes downward).
- related <name>: Sibling functions: same file, similar names, or shared callers/callees. Find companions to update together (e.g., serialize when you're changing deserialize). Name-based, not semantic.
- brief <name>: Compact summary of a function: typed signature, first sentence of docstring, side-effect classification (fs/network/process/global_mutation), complexity (branches, depth, lines). Cheaper than about; more useful than fn when you don't need the body. Pass git=true for last-modified info.

FINDING CODE:
- find <name>: Locate definitions ranked by usage count. Supports glob patterns (e.g. find "handle*" or "_update*"). Use when you know the name but not the file.
- usages <name>: See every usage organized by type: definitions, calls, imports, references. Complete picture of how something is used. Use code_only=true to skip comments/strings.
- toc: Get a quick overview of a project you haven't seen before — file counts, line counts, function/class counts, entry points. Use detailed=true for full symbol listing.
- search <term>: Text search (like grep, respects .gitignore). Supports regex by default (e.g. "\\d+" or "foo|bar"). Supports context=N for surrounding lines, exclude/in for file filtering. Case-insensitive by default; set case_sensitive=true for exact case. Invalid regex auto-falls back to plain text. STRUCTURAL MODE: Add type=function|class|call|method|type to query the symbol index instead of text. Combine with param=, returns=, decorator=, receiver= (for calls), exported=true, unused=true. Term becomes optional name filter (glob). Example: type=function, param=Request → all functions taking Request.
- tests <name>: Find test files covering a function, test case names, and how it's called in tests. Use before modifying or to find test patterns to follow.
- affected_tests <name>: Which tests to run after changing a function. Combines blast (transitive callers) with test detection. Shows test files, coverage %, and uncovered functions. Use depth= to control depth.
- deadcode: Find dead code: functions/classes with zero callers. Use during cleanup to identify safely deletable code. Excludes exported, decorated, and test symbols by default — use include_exported/include_decorated/include_tests to expand.
- entrypoints: Detect framework entry points: routes, handlers, DI providers, tasks. Auto-detects Express, Flask, Spring, Gin, Actix, and more. Use framework= to filter by specific framework.
- endpoints: HTTP API surface — list server routes (Express/Fastify/Koa/NestJS/Flask/FastAPI/Spring/JAX-RS/Gin/Echo/Chi/Fiber/axum/actix/Next.js) and client requests (fetch/axios/requests/httpx/http/restTemplate/webClient/reqwest). Use bridge=true to match clients to servers across language boundaries; method=/prefix= to filter; server_only/client_only to halve output.

EXTRACTING CODE (use instead of reading entire files):
- fn <name>: Extract one or more functions. Comma-separated for bulk extraction (e.g. "parse,format,validate"). Use file to disambiguate.
- class <name>: Extract a class/struct/interface with all its methods. Handles all supported types: JS/TS, Python, Go, Rust, Java. Large classes (>200 lines) show summary; use max_lines for truncated source.
- lines: Extract specific lines (e.g. range="10-20" or just "15"). Requires file and range. Use when you know the exact line range you need.
- expand <item>: Drill into a numbered item from the last context result (requires running context first in the same session). Context returns numbered callers/callees — use this to see their full source code.

FILE DEPENDENCIES (require file param):
- imports: All imports with resolved file paths. Use to understand dependencies before modifying or moving a file. Resolves relative, package, and language-specific patterns.
- exporters: Every file that imports/depends on this file — shows dependents rather than dependencies. Use before moving, renaming, or deleting.
- file_exports: File's public API: all exported functions, classes, variables with signatures. Use to understand what a module offers before importing. Requires explicit export markers; use toc --detailed as fallback.
- graph: File-level dependency tree. Use to understand module architecture — which files form a cluster, what the dependency chain looks like. Set direction ("imports"/"importers"/"both"). Can be noisy — use depth=1 for large codebases.
- circular_deps: Detect circular import chains. Shows cycle paths and involved files. Use file= to check a specific file, exclude= to ignore paths.

REFACTORING:
- verify <name>: Check all call sites match function signature (argument count). Run before adding/removing parameters to catch breakage early.
- plan <name>: Preview refactoring: before/after signatures and call sites needing updates. Use add_param (with optional default_value), remove_param, or rename_to. Pair with verify.
- diff_impact: Which functions changed in git diff and who calls them. Use to understand impact of recent changes before committing or reviewing. Use base, staged, or file params to scope.
- check: Pre-commit lint of pending changes against the index. Composes diff_impact + verify + affected_tests; flags ADDED functions with zero callers (ORPHAN), BROKEN_IMPORT, signature drift across call sites, and recommends which tests to run. Use base= to compare against a branch, staged=true for staged changes only.

DIAGNOSTICS:
- doctor: Index health/coverage report — file/symbol counts, language breakdown, dynamic-import / eval / reflection blind spots, parse failures, and a verdict (HIGH/MEDIUM/LOW trust). Use deep=true to also sample resolution coverage and bucket edges by confidence. Use in= to scope to a subtree.

OTHER:
- typedef <name>: Find type definitions matching a name: interfaces, enums, structs, traits, type aliases. See field shapes, required methods, or enum values.
- stacktrace: Parse a stack trace, show source context per frame. Requires stack param. Handles JS, Python, Go, Rust, Java formats.
- api: Public API surface of project or file: all exported/public symbols with signatures. Use to understand what a library exposes. Pass file to scope to one file. Python needs __all__; use toc instead.
- stats: Quick project stats: file counts, symbol counts, lines of code by language and symbol type. Use functions=true for per-function line counts sorted by size (complexity audit). Set hot=true with top=N for the most-called functions (project orientation primitive).
- audit_async: Find async calls inside async functions that are likely missing await (probable bugs). JS/TS/Python only. Filter with file/exclude/limit.` + generateMcpParamSection();

server.registerTool(
    'ucn',
    {
        description: TOOL_DESCRIPTION,
        inputSchema: z.object({
            command: z.enum(getMcpCommandEnum()),
            project_dir: z.string().describe('Absolute or relative path to the project root directory'),
            name: z.string().optional().describe('Symbol name to analyze. For fn: comma-separated for bulk (e.g. "parse,format"). For find: supports glob patterns (e.g. "handle*").'),
            file: z.string().optional().describe('File path (imports/exporters/graph/file_exports/lines/api/diff_impact) or filter pattern for disambiguation (e.g. "parser", "src/core")'),
            exclude: z.string().optional().describe('Comma-separated patterns to exclude (e.g. "test,mock,vendor")'),
            include_tests: z.boolean().optional().describe('Include test files in results (excluded by default)'),
            exclude_tests: z.boolean().optional().describe('Exclude test files from results. Used by entrypoints (where tests are included by default).'),
            include_methods: z.boolean().optional().describe('Include obj.method() calls in trace/blast/smart/verify (implied for about/context/impact — method calls tiered by receiver evidence)'),
            include_uncertain: z.boolean().optional().describe('Include uncertain matches in smart/verify (implied for about/context/impact/trace/blast/reverse_trace/affected_tests — unverified candidates always shown, tiered)'),
            expand_unverified: z.boolean().optional().describe('blast/reverse_trace: follow unverified caller edges in the tree — downstream nodes are marked as unverified chains (possible, not confirmed, impact)'),
            min_confidence: z.number().min(0).max(1).optional().describe('Minimum confidence threshold (0.0-1.0) to filter caller/callee edges'),
            show_confidence: z.boolean().optional().describe('Show confidence scores per edge (default: true). Set false to hide.'),
            hide_confidence: z.boolean().optional().describe('Hide confidence scores per edge (alias of show_confidence=false).'),
            unreachable_only: z.boolean().optional().describe('Show only callers/callees that are unreachable from any detected entry point (about, context, impact).'),
            with_types: z.boolean().optional().describe('Include related type definitions in output'),
            detailed: z.boolean().optional().describe('Show full symbol listing per file'),
            exact: z.boolean().optional().describe('Exact name match only (no substring matching)'),
            in: z.string().optional().describe('Only search in this directory path (e.g. "src/core")'),
            top: z.number().int().positive().max(10000).optional().describe('Max results to show (default: 10). Must be a positive integer.'),
            depth: z.number().int().nonnegative().max(100).optional().describe('Max depth (default: 3 for trace, 2 for graph); expands all children. Non-negative integer.'),
            code_only: z.boolean().optional().describe('Exclude matches in comments and strings'),
            context: z.number().int().nonnegative().max(1000).optional().describe('Lines of context around each match. Non-negative integer.'),
            include_exported: z.boolean().optional().describe('Include exported symbols in deadcode results'),
            include_decorated: z.boolean().optional().describe('Include decorated/annotated symbols in deadcode results'),
            calls_only: z.boolean().optional().describe('Only direct calls and test-case matches (tests command)'),
            max_lines: z.number().int().positive().max(1000000).optional().describe('Max source lines for class (large classes show summary by default). Must be a positive integer.'),
            direction: z.enum(['imports', 'importers', 'both']).optional().describe('Graph direction: imports (what this file uses), importers (who uses this file), both (default: both)'),
            term: z.string().optional().describe('Search term (regex by default; set regex=false to force plain text)'),
            regex: z.boolean().optional().describe('Treat search term as a regex pattern (default: true). Set false to force plain text escaping.'),
            functions: z.boolean().optional().describe('Include per-function line counts in stats output, sorted by size (complexity audit)'),
            hot: z.boolean().optional().describe('Include top N most-called functions in stats output (orientation primitive). Pair with top=N (default 10).'),
            diverse: z.boolean().optional().describe('For example: cluster call sites by argument shape and return one representative per cluster. Pair with top=N (default 3).'),
            git: z.boolean().optional().describe('Attach git enrichment (last modified, author, recent change count last 30d) to about/brief output. Returns gracefully when not a git repo.'),
            add_param: z.string().optional().describe('Parameter name to add (plan command)'),
            remove_param: z.string().optional().describe('Parameter name to remove (plan command)'),
            rename_to: z.string().optional().describe('New function name (plan command)'),
            default_value: z.string().optional().describe('Default value for added parameter (plan command)'),
            stack: z.string().optional().describe('The stack trace text to parse (stacktrace command)'),
            item: z.number().int().positive().max(1000000).optional().describe('Item number from context output to expand (e.g. 1, 2, 3). Must be a positive integer.'),
            range: z.string().optional().describe('Line range to extract, e.g. "10-20" or "15" (lines command)'),
            base: z.string().optional().describe('Git ref to diff against (default: HEAD). E.g. "HEAD~3", "main", a commit SHA'),
            staged: z.boolean().optional().describe('Analyze staged changes (diff_impact command)'),
            deep: z.boolean().optional().describe('Run a deeper analysis (doctor: sample resolution coverage)'),
            compact: z.boolean().optional().describe('Compact one-line-per-item output for about/context (saves tokens)'),
            case_sensitive: z.boolean().optional().describe('Case-sensitive search (default: false, case-insensitive)'),
            all: z.boolean().optional().describe('Show all results (expand truncated sections). Applies to about, toc, related, trace, and others.'),
            top_level: z.boolean().optional().describe('Show only top-level functions in toc (exclude nested/indented)'),
            class_name: z.string().optional().describe('Class name to scope method analysis (e.g. "MarketDataFetcher" for close)'),
            limit: z.number().int().positive().max(1000000).optional().describe('Max results to return (default: 500). Caps find, usages, search, deadcode, api, toc --detailed. Must be a positive integer.'),
            max_files: z.number().int().positive().max(10000000).optional().describe('Max files to index (default: 10000). Use for very large codebases. Must be a positive integer.'),
            max_chars: z.number().int().positive().max(10000000).optional().describe('Max output chars before truncation. Targeted commands (about, context, smart, etc.): 10K default. Broad commands (toc, entrypoints, deadcode, etc.): 3K default. Max: 100K. Use all=true to bypass all caps.'),
            // Structural search flags (search command)
            type: z.string().optional().describe('Symbol type filter for structural search: function, class, call, method, type. Triggers index-based search.'),
            param: z.string().optional().describe('Filter by parameter name or type (structural search). E.g. "Request", "ctx".'),
            receiver: z.string().optional().describe('Filter calls by receiver (structural search, type=call). E.g. "db", "http".'),
            returns: z.string().optional().describe('Filter by return type (structural search). E.g. "Promise", "error".'),
            decorator: z.string().optional().describe('Filter by decorator/annotation (structural search). E.g. "Route", "Test".'),
            exported: z.boolean().optional().describe('Only exported/public symbols (structural search).'),
            unused: z.boolean().optional().describe('Only symbols with zero callers (structural search).'),
            framework: z.string().optional().describe('Filter entrypoints by framework (e.g. "express", "spring", "flask"). Comma-separated for multiple.'),
            follow_symlinks: z.boolean().optional().describe('Follow symlinks during file discovery (default: true)'),
            // endpoints command
            bridge: z.boolean().optional().describe('Match server routes to client requests (endpoints command).'),
            server_only: z.boolean().optional().describe('Only list server routes (endpoints command).'),
            client_only: z.boolean().optional().describe('Only list client requests (endpoints command).'),
            unmatched: z.boolean().optional().describe('Only show unmatched routes/requests (endpoints command).'),
            method: z.string().optional().describe('Filter by HTTP method (e.g. "GET", "POST") — endpoints command.'),
            prefix: z.string().optional().describe('Filter routes/requests by path prefix (endpoints command).'),
            hide_uncertain: z.boolean().optional().describe('Hide uncertain (interpolated-path) bridges (endpoints command).')

        })
    },
    async (args) => {
        const { command, project_dir } = args;

        // Normalize ALL params once — execute() handlers pick what they need.
        // This eliminates per-case param selection and prevents CLI/MCP drift.
        const { command: _c, project_dir: _p, ...rawParams } = args;
        const ep = normalizeParams(rawParams);

        // Translate hide_confidence → showConfidence:false (canonical inverse).
        if (ep.hideConfidence === true && ep.showConfidence === undefined) {
            ep.showConfidence = false;
        }
        delete ep.hideConfidence;

        // Strip params not applicable to this command (prevents silent no-ops).
        // Global/core params are always allowed — only optional flags are filtered.
        // FLAG_APPLICABILITY is keyed by canonical (camelCase) names, but `command`
        // is the MCP (snake_case) name — resolve to canonical first to avoid
        // silently skipping multi-word commands (circular_deps, diff_impact, etc.).
        const strippedParams = [];
        const canonicalCommand = resolveCommand(command, 'mcp') || command;
        const applicable = FLAG_APPLICABILITY[canonicalCommand];
        if (applicable) {
            // Truly global options — apply to all commands (build/display control).
            // Command-specific params (name, term, stack, range, etc.) are in FLAG_APPLICABILITY.
            const coreParams = new Set(['maxChars', 'maxFiles', 'followSymlinks']);
            for (const key of Object.keys(ep)) {
                if (coreParams.has(key)) continue;
                if (!applicable.includes(key) && ep[key] !== undefined &&
                    !(Array.isArray(ep[key]) && ep[key].length === 0)) {
                    strippedParams.push(REVERSE_PARAM_MAP[key] || key);
                    delete ep[key];
                }
            }
        }

        // all=true bypasses both formatter caps AND char truncation (parity with CLI --all)
        const maxChars = ep.all ? MAX_OUTPUT_CHARS : ep.maxChars;

        // Build stripping note (appended inside truncation boundary on success paths)
        const strippedNote = strippedParams.length > 0
            ? `\n\nNote: ${strippedParams.join(', ')} ignored (not applicable to ${command}).`
            : '';

        // Wrap toolResult to auto-inject command + maxChars + stripping note
        const tr = (text) => toolResult(text, command, maxChars, strippedNote);
        // Wrap toolError to include stripping note on error paths too
        const te = strippedNote
            ? (msg) => toolError(msg + strippedNote)
            : toolError;

        let index = null; // Track for post-command cache save
        try {
            switch (command) {

            // ==================================================================
            // UNDERSTANDING CODE
            // ==================================================================

            // ── Commands using shared executor ─────────────────────────

            case 'about': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'about', ep);
                if (!ok) return te(error);
                let aboutText = output.formatAbout(result, {
                    allHint: 'Repeat with all=true to show all.',
                    showConfidence: ep.showConfidence !== false,
                });
                if (note) aboutText += '\n\n' + note;
                return tr(aboutText);
            }

            case 'context': {
                index = getIndex(project_dir, ep);
                const { ok, result: ctx, error, note } = execute(index, 'context', ep);
                if (!ok) return te(error);
                const { text, expandable } = output.formatContext(ctx, {
                    expandHint: 'Use expand command with item number to see code for any item.',
                    showConfidence: ep.showConfidence !== false,
                });
                expandCacheInstance.save(index.root, ep.name, ep.file, expandable);
                let ctxText = text;
                if (note) ctxText += '\n\n' + note;
                return tr(ctxText);
            }

            case 'impact': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'impact', ep);
                if (!ok) return te(error);
                let impactText = output.formatImpact(result);
                if (note) impactText += '\n\n' + note;
                return tr(impactText);
            }

            case 'blast': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'blast', ep);
                if (!ok) return te(error);
                let blastText = output.formatBlast(result, {
                    allHint: 'Set depth to expand all children.',
                });
                if (note) blastText += '\n\n' + note;
                return tr(blastText);
            }

            case 'smart': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'smart', ep);
                if (!ok) return te(error);
                let smartText = output.formatSmart(result);
                if (note) smartText += '\n\n' + note;
                return tr(smartText);
            }

            case 'trace': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'trace', ep);
                if (!ok) return te(error);
                let traceText = output.formatTrace(result, {
                    allHint: 'Set depth to expand all children.',
                    methodsHint: 'Note: obj.method() calls excluded. Use include_methods=true to include them.'
                });
                if (note) traceText += '\n\n' + note;
                return tr(traceText);
            }

            case 'reverse_trace': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'reverseTrace', ep);
                if (!ok) return te(error);
                let rtText = output.formatReverseTrace(result, {
                    allHint: 'Set depth to expand all children.',
                });
                if (note) rtText += '\n\n' + note;
                return tr(rtText);
            }

            case 'example': {
                index = getIndex(project_dir, ep);
                const { ok, result, error } = execute(index, 'example', ep);
                if (!ok) return te(error);
                return tr(output.formatExample(result, ep.name));
            }

            case 'related': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'related', ep);
                if (!ok) return te(error);
                let relText = output.formatRelated(result, {
                    all: ep.all || false, top: ep.top,
                    allHint: 'Repeat with all=true to show all.'
                });
                if (note) relText += '\n\n' + note;
                return tr(relText);
            }

            case 'brief': {
                index = getIndex(project_dir, ep);
                const { ok, result, error } = execute(index, 'brief', ep);
                if (!ok) return te(error);
                return tr(output.formatBrief(result));
            }

            case 'doctor': {
                index = getIndex(project_dir, ep);
                const { ok, result, error } = execute(index, 'doctor', ep);
                if (!ok) return te(error);
                return tr(output.formatDoctor(result));
            }

            case 'check': {
                index = getIndex(project_dir, ep);
                const { ok, result, error } = execute(index, 'check', ep);
                if (!ok) return te(error);
                return tr(output.formatCheck(result));
            }

            // ── Finding Code ────────────────────────────────────────────

            case 'find': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'find', ep);
                if (!ok) return te(error);
                let text = output.formatFind(result, ep.name, ep.top);
                if (note) text += '\n\n' + note;
                return tr(text);
            }

            case 'usages': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'usages', ep);
                if (!ok) return te(error);
                let text = output.formatUsages(result, ep.name);
                if (note) text += '\n\n' + note;
                return tr(text);
            }

            case 'toc': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'toc', ep);
                if (!ok) return te(error);
                let text = output.formatToc(result, {
                    topHint: 'Set top=N or use detailed=false for compact view.'
                });
                if (note) text += '\n\n' + note;
                return tr(text);
            }

            case 'search': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, structural, note } = execute(index, 'search', ep);
                if (!ok) return te(error);
                let searchText;
                if (structural) {
                    searchText = output.formatStructuralSearch(result);
                } else {
                    searchText = output.formatSearch(result, ep.term);
                }
                if (note) searchText += '\n\n' + note;
                return tr(searchText);
            }

            case 'tests': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'tests', ep);
                if (!ok) return te(error);
                let testsText = output.formatTests(result, ep.name);
                if (note) testsText += '\n\n' + note;
                return tr(testsText);
            }

            case 'affected_tests': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'affectedTests', ep);
                if (!ok) return te(error);
                let atText = output.formatAffectedTests(result, { all: ep.all });
                if (note) atText += '\n\n' + note;
                return tr(atText);
            }

            case 'deadcode': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'deadcode', ep);
                if (!ok) return te(error);
                const dcNote = note;
                let dcText = output.formatDeadcode(result, {
                    top: ep.top || 0,
                    decoratedHint: !ep.includeDecorated && result.excludedDecorated > 0 ? `${result.excludedDecorated} decorated/annotated symbol(s) hidden (framework-registered). Use include_decorated=true to include them.` : undefined,
                    exportedHint: !ep.includeExported && result.excludedExported > 0 ? `${result.excludedExported} exported symbol(s) excluded (all have callers). Use include_exported=true to audit them.` : undefined,
                    externalContractHint: !ep.includeExported && result.excludedExternalContract > 0 ? `${result.excludedExternalContract} symbol(s) hidden (override an out-of-tree base class — reachable via external contract, not dead). Use include_exported=true to include them.` : undefined
                });
                if (dcNote) dcText += '\n\n' + dcNote;
                return tr(dcText);
            }

            case 'entrypoints': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'entrypoints', ep);
                if (!ok) return te(error);
                let epText = output.formatEntrypoints(result);
                if (note) epText += '\n\n' + note;
                return tr(epText);
            }

            case 'endpoints': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'endpoints', ep);
                if (!ok) return te(error);
                let endText = output.formatEndpoints(result, { bridge: result._bridge, unmatched: result._unmatched });
                if (note) endText += '\n\n' + note;
                return tr(endText);
            }

            // ── File Dependencies ───────────────────────────────────────

            case 'imports': {
                index = getIndex(project_dir, ep);
                const { ok, result, error } = execute(index, 'imports', ep);
                if (!ok) return te(error);
                return tr(output.formatImports(result, ep.file));
            }

            case 'exporters': {
                index = getIndex(project_dir, ep);
                const { ok, result, error } = execute(index, 'exporters', ep);
                if (!ok) return te(error);
                return tr(output.formatExporters(result, ep.file));
            }

            case 'file_exports': {
                index = getIndex(project_dir, ep);
                const { ok, result, error } = execute(index, 'fileExports', ep);
                if (!ok) return te(error);
                return tr(output.formatFileExports(result, ep.file));
            }

            case 'graph': {
                index = getIndex(project_dir, ep);
                const { ok, result, error } = execute(index, 'graph', ep);
                if (!ok) return te(error);
                return tr(output.formatGraph(result, {
                    showAll: ep.all || ep.depth !== undefined,
                    maxDepth: ep.depth ?? 2, file: ep.file,
                    depthHint: 'Set depth parameter for deeper graph.',
                    allHint: 'Set depth to expand all children.'
                }));
            }

            case 'circular_deps': {
                index = getIndex(project_dir, ep);
                const { ok, result, error } = execute(index, 'circularDeps', ep);
                if (!ok) return te(error);
                return tr(output.formatCircularDeps(result));
            }

            // ── Refactoring ─────────────────────────────────────────────

            case 'verify': {
                index = getIndex(project_dir, ep);
                const { ok, result, error } = execute(index, 'verify', ep);
                if (!ok) return te(error);
                return tr(output.formatVerify(result));
            }

            case 'plan': {
                index = getIndex(project_dir, ep);
                const { ok, result, error } = execute(index, 'plan', ep);
                if (!ok) return te(error);
                return tr(output.formatPlan(result));
            }

            case 'diff_impact': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'diffImpact', ep);
                if (!ok) return te(error);
                let diText = output.formatDiffImpact(result, { all: ep.all });
                if (note) diText += '\n\n' + note;
                return tr(diText);
            }

            // ── Other ───────────────────────────────────────────────────

            case 'typedef': {
                index = getIndex(project_dir, ep);
                const { ok, result, error } = execute(index, 'typedef', ep);
                if (!ok) return te(error);
                return tr(output.formatTypedef(result, ep.name));
            }

            case 'stacktrace': {
                index = getIndex(project_dir, ep);
                const { ok, result, error } = execute(index, 'stacktrace', ep);
                if (!ok) return te(error);
                return tr(output.formatStackTrace(result));
            }

            case 'api': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'api', ep);
                if (!ok) return te(error);
                let apiText = output.formatApi(result, ep.file || '.');
                if (note) apiText += '\n\n' + note;
                return tr(apiText);
            }

            case 'stats': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'stats', ep);
                if (!ok) return te(error);
                let statsText = output.formatStats(result, { top: ep.top || 0 });
                if (note) statsText += '\n\n' + note;
                return tr(statsText);
            }

            case 'audit_async': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'auditAsync', ep);
                if (!ok) return te(error);
                let text = output.formatAuditAsync(result);
                if (note) text += '\n\n' + note;
                return tr(text);
            }

            // ── Extracting Code (via execute) ────────────────────────────

            case 'fn': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'fn', ep);
                if (!ok) return te(error);
                // MCP path security: validate all result files are within project root
                for (const entry of result.entries) {
                    const check = resolveAndValidatePath(index, entry.match.relativePath || path.relative(index.root, entry.match.file));
                    if (typeof check !== 'string') return check;
                }
                const fnText = (note ? note + '\n\n' : '') + output.formatFnResult(result);
                return tr(fnText);
            }

            case 'class': {
                index = getIndex(project_dir, ep);
                const { ok, result, error, note } = execute(index, 'class', ep);
                if (!ok) return te(error);  // soft error (class not found)
                // MCP path security: validate all result files are within project root
                for (const entry of result.entries) {
                    const check = resolveAndValidatePath(index, entry.match.relativePath || path.relative(index.root, entry.match.file));
                    if (typeof check !== 'string') return check;
                }
                const classText = (note ? note + '\n\n' : '') + output.formatClassResult(result);
                return tr(classText);
            }

            case 'lines': {
                index = getIndex(project_dir, ep);
                const { ok, result, error } = execute(index, 'lines', ep);
                if (!ok) return te(error);
                // MCP path security: validate file is within project root
                const check = resolveAndValidatePath(index, result.relativePath);
                if (typeof check !== 'string') return check;
                return tr(output.formatLines(result));
            }

            case 'expand': {
                if (ep.item === undefined || ep.item === null) {
                    return te('Item number is required (e.g. item=1).');
                }
                index = getIndex(project_dir, ep);
                const lookup = expandCacheInstance.lookup(index.root, ep.item);
                const { ok, result, error } = execute(index, 'expand', {
                    match: lookup.match, itemNum: ep.item,
                    itemCount: lookup.itemCount, symbolName: lookup.symbolName,
                    validateRoot: true
                });
                if (!ok) return te(error);
                return tr(result.text);
            }

            default:
                return te(`Unknown command: ${command}`);
            }
        } catch (e) {
            return te(e.message);
        } finally {
            // Persist calls cache after command execution.
            // getIndex() only saves after build (when callsCache is empty).
            // Commands like context/about/impact populate callsCache lazily,
            // so we save here to avoid re-parsing all files on every MCP session.
            // MED-1: also persist when reachability was computed in-process so
            // long-lived MCP servers carry the BFS result forward to disk.
            if (index && (index.callsCacheDirty || index.reachabilityDirty)) {
                try { index.saveCache(); } catch (_) { /* best-effort */ }
                index.callsCacheDirty = false;
            }
        }
    }
);

// ============================================================================
// START SERVER
// ============================================================================

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Print the running version so MCP-vs-CLI drift is visible (field-report #3:
    // a stale `npx -y ucn` cache can silently run an older engine than the CLI).
    console.error(`UCN MCP server v${require('../package.json').version} running on stdio`);
}

main().catch(e => {
    console.error('UCN MCP server failed to start:', e);
    process.exit(1);
});
