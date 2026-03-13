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
const { getMcpCommandEnum, normalizeParams } = require('../core/registry');
const { execute } = require('../core/execute');
const { ExpandCache } = require('../core/expand-cache');

// ============================================================================
// INDEX CACHE
// ============================================================================

const indexCache = new Map(); // projectDir → { index, checkedAt }
const MAX_CACHE_SIZE = 10;
const expandCacheInstance = new ExpandCache();

function getIndex(projectDir) {
    const absDir = path.resolve(projectDir);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        throw new Error(`Project directory not found: ${absDir}`);
    }
    const root = findProjectRoot(absDir);
    const cached = indexCache.get(root);
    const STALE_CHECK_INTERVAL_MS = 2000;

    // Throttle staleness checks — isCacheStale() re-globs and stats all files
    if (cached) {
        if (Date.now() - cached.checkedAt < STALE_CHECK_INTERVAL_MS) {
            return cached.index; // Recently verified fresh
        }
        if (!cached.index.isCacheStale()) {
            cached.checkedAt = Date.now();
            return cached.index;
        }
    }

    // Build new index (or rebuild stale one)
    const index = new ProjectIndex(root);
    const loaded = index.loadCache();
    if (loaded && !index.isCacheStale()) {
        // Disk cache is fresh
    } else {
        index.build(null, { quiet: true, forceRebuild: loaded });
        index.saveCache();
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

    indexCache.set(root, { index, checkedAt: Date.now() });
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

const MAX_OUTPUT_CHARS = 100000; // ~100KB, safe for all MCP clients

function toolResult(text) {
    if (!text) return { content: [{ type: 'text', text: '(no output)' }] };
    if (text.length > MAX_OUTPUT_CHARS) {
        const truncated = text.substring(0, MAX_OUTPUT_CHARS);
        // Cut at last newline to avoid breaking mid-line
        const lastNewline = truncated.lastIndexOf('\n');
        const cleanCut = lastNewline > MAX_OUTPUT_CHARS * 0.8 ? truncated.substring(0, lastNewline) : truncated;
        return { content: [{ type: 'text', text: cleanCut + '\n\n... (output truncated — refine query or use file/in/exclude parameters to narrow scope)' }] };
    }
    return { content: [{ type: 'text', text }] };
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

function requireName(name) {
    if (!name || !name.trim()) {
        return toolError('Symbol name is required.');
    }
    return null;
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
- about <name>: Definition, source, callers, callees, and tests — everything in one call. Replaces 3-4 grep+read cycles. Your first stop for any function or class.
- context <name>: Who calls it and what does it call, without source code. Results are numbered for use with expand. For classes/structs, shows all methods instead.
- impact <name>: Every call site with actual arguments passed, grouped by file. Essential before changing a function signature — shows exactly what breaks.
- blast <name>: Transitive blast radius — callers of callers. Shows the full chain of functions affected if you change something. Like impact but recursive. Use depth (default: 3) to control how far up the chain to walk.
- smart <name>: Get a function's source with all called functions expanded inline (not constants/variables). Use to understand or modify a function and its dependencies in one read.
- trace <name>: Call tree from a function downward. Use to understand "what happens when X runs" — maps which modules a pipeline touches without reading files. Set depth (default: 3); setting depth expands all children.
- example <name>: Best real-world usage example. Automatically scores call sites by quality and returns the top one with context. Use to understand expected calling patterns.
- reverse_trace <name>: Upward call chain to entry points — who calls this, who calls those callers, etc. Use to find all paths that lead to a function. Set depth (default: 5) to control how far up. Complement to trace (which goes downward).
- related <name>: Sibling functions: same file, similar names, or shared callers/callees. Find companions to update together (e.g., serialize when you're changing deserialize). Name-based, not semantic.

FINDING CODE:
- find <name>: Locate definitions ranked by usage count. Supports glob patterns (e.g. find "handle*" or "_update*"). Use when you know the name but not the file.
- usages <name>: See every usage organized by type: definitions, calls, imports, references. Complete picture of how something is used. Use code_only=true to skip comments/strings.
- toc: Get a quick overview of a project you haven't seen before — file counts, line counts, function/class counts, entry points. Use detailed=true for full symbol listing.
- search <term>: Text search (like grep, respects .gitignore). Supports regex by default (e.g. "\\d+" or "foo|bar"). Supports context=N for surrounding lines, exclude/in for file filtering. Case-insensitive by default; set case_sensitive=true for exact case. Invalid regex auto-falls back to plain text. STRUCTURAL MODE: Add type=function|class|call|method|type to query the symbol index instead of text. Combine with param=, returns=, decorator=, receiver= (for calls), exported=true, unused=true. Term becomes optional name filter (glob). Example: type=function, param=Request → all functions taking Request.
- tests <name>: Find test files covering a function, test case names, and how it's called in tests. Use before modifying or to find test patterns to follow.
- affected_tests <name>: Which tests to run after changing a function. Combines blast (transitive callers) with test detection. Shows test files, coverage %, and uncovered functions. Use depth= to control depth.
- deadcode: Find dead code: functions/classes with zero callers. Use during cleanup to identify safely deletable code. Excludes exported, decorated, and test symbols by default — use include_exported/include_decorated/include_tests to expand.
- entrypoints: Detect framework entry points: routes, handlers, DI providers, tasks. Auto-detects Express, Flask, Spring, Gin, Actix, and more. Use framework= to filter by specific framework.

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

OTHER:
- typedef <name>: Find type definitions matching a name: interfaces, enums, structs, traits, type aliases. See field shapes, required methods, or enum values.
- stacktrace: Parse a stack trace, show source context per frame. Requires stack param. Handles JS, Python, Go, Rust, Java formats.
- api: Public API surface of project or file: all exported/public symbols with signatures. Use to understand what a library exposes. Pass file to scope to one file. Python needs __all__; use toc instead.
- stats: Quick project stats: file counts, symbol counts, lines of code by language and symbol type. Use functions=true for per-function line counts sorted by size (complexity audit).`;

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
            include_methods: z.boolean().optional().describe('Include obj.method() calls (default: true for about/trace)'),
            include_uncertain: z.boolean().optional().describe('Include uncertain/ambiguous matches'),
            min_confidence: z.number().optional().describe('Minimum confidence threshold (0.0-1.0) to filter caller/callee edges'),
            show_confidence: z.boolean().optional().describe('Show confidence scores and resolution evidence per edge'),
            with_types: z.boolean().optional().describe('Include related type definitions in output'),
            detailed: z.boolean().optional().describe('Show full symbol listing per file'),
            exact: z.boolean().optional().describe('Exact name match only (no substring matching)'),
            in: z.string().optional().describe('Only search in this directory path (e.g. "src/core")'),
            top: z.number().optional().describe('Max results to show (default: 10)'),
            depth: z.number().optional().describe('Max depth (default: 3 for trace, 2 for graph); expands all children'),
            code_only: z.boolean().optional().describe('Exclude matches in comments and strings'),
            context: z.number().optional().describe('Lines of context around each match'),
            include_exported: z.boolean().optional().describe('Include exported symbols in deadcode results'),
            include_decorated: z.boolean().optional().describe('Include decorated/annotated symbols in deadcode results'),
            calls_only: z.boolean().optional().describe('Only direct calls and test-case matches (tests command)'),
            max_lines: z.number().optional().describe('Max source lines for class (large classes show summary by default)'),
            direction: z.enum(['imports', 'importers', 'both']).optional().describe('Graph direction: imports (what this file uses), importers (who uses this file), both (default: both)'),
            term: z.string().optional().describe('Search term (regex by default; set regex=false to force plain text)'),
            regex: z.boolean().optional().describe('Treat search term as a regex pattern (default: true). Set false to force plain text escaping.'),
            functions: z.boolean().optional().describe('Include per-function line counts in stats output, sorted by size (complexity audit)'),
            add_param: z.string().optional().describe('Parameter name to add (plan command)'),
            remove_param: z.string().optional().describe('Parameter name to remove (plan command)'),
            rename_to: z.string().optional().describe('New function name (plan command)'),
            default_value: z.string().optional().describe('Default value for added parameter (plan command)'),
            stack: z.string().optional().describe('The stack trace text to parse (stacktrace command)'),
            item: z.number().optional().describe('Item number from context output to expand (e.g. 1, 2, 3)'),
            range: z.string().optional().describe('Line range to extract, e.g. "10-20" or "15" (lines command)'),
            base: z.string().optional().describe('Git ref to diff against (default: HEAD). E.g. "HEAD~3", "main", a commit SHA'),
            staged: z.boolean().optional().describe('Analyze staged changes (diff_impact command)'),
            case_sensitive: z.boolean().optional().describe('Case-sensitive search (default: false, case-insensitive)'),
            all: z.boolean().optional().describe('Show all results (expand truncated sections). Applies to about, toc, related, trace, and others.'),
            top_level: z.boolean().optional().describe('Show only top-level functions in toc (exclude nested/indented)'),
            class_name: z.string().optional().describe('Class name to scope method analysis (e.g. "MarketDataFetcher" for close)'),
            limit: z.number().optional().describe('Max results to return (default: 500). Caps find, usages, search, deadcode, api, toc --detailed.'),
            max_files: z.number().optional().describe('Max files to index (default: 10000). Use for very large codebases.'),
            // Structural search flags (search command)
            type: z.string().optional().describe('Symbol type filter for structural search: function, class, call, method, type. Triggers index-based search.'),
            param: z.string().optional().describe('Filter by parameter name or type (structural search). E.g. "Request", "ctx".'),
            receiver: z.string().optional().describe('Filter calls by receiver (structural search, type=call). E.g. "db", "http".'),
            returns: z.string().optional().describe('Filter by return type (structural search). E.g. "Promise", "error".'),
            decorator: z.string().optional().describe('Filter by decorator/annotation (structural search). E.g. "Route", "Test".'),
            exported: z.boolean().optional().describe('Only exported/public symbols (structural search).'),
            unused: z.boolean().optional().describe('Only symbols with zero callers (structural search).'),
            framework: z.string().optional().describe('Filter entrypoints by framework (e.g. "express", "spring", "flask"). Comma-separated for multiple.')

        })
    },
    async (args) => {
        const { command, project_dir } = args;

        // Normalize ALL params once — execute() handlers pick what they need.
        // This eliminates per-case param selection and prevents CLI/MCP drift.
        const { command: _c, project_dir: _p, ...rawParams } = args;
        const ep = normalizeParams(rawParams);

        try {
            switch (command) {

            // ==================================================================
            // UNDERSTANDING CODE
            // ==================================================================

            // ── Commands using shared executor ─────────────────────────

            case 'about': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'about', ep);
                if (!ok) return toolResult(error); // soft error — won't kill sibling calls
                return toolResult(output.formatAbout(result, {
                    allHint: 'Repeat with all=true to show all.',
                    methodsHint: 'Note: obj.method() callers/callees excluded. Use include_methods=true to include them.',
                    showConfidence: ep.showConfidence,
                }));
            }

            case 'context': {
                const index = getIndex(project_dir);
                const { ok, result: ctx, error } = execute(index, 'context', ep);
                if (!ok) return toolResult(error); // context uses soft error (not toolError)
                const { text, expandable } = output.formatContext(ctx, {
                    expandHint: 'Use expand command with item number to see code for any item.',
                    showConfidence: ep.showConfidence,
                });
                expandCacheInstance.save(index.root, ep.name, ep.file, expandable);
                return toolResult(text);
            }

            case 'impact': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'impact', ep);
                if (!ok) return toolResult(error); // soft error
                return toolResult(output.formatImpact(result));
            }

            case 'blast': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'blast', ep);
                if (!ok) return toolResult(error); // soft error
                return toolResult(output.formatBlast(result, {
                    allHint: 'Set depth to expand all children.',
                }));
            }

            case 'smart': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'smart', ep);
                if (!ok) return toolResult(error); // soft error
                return toolResult(output.formatSmart(result));
            }

            case 'trace': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'trace', ep);
                if (!ok) return toolResult(error); // soft error
                return toolResult(output.formatTrace(result, {
                    allHint: 'Set depth to expand all children.',
                    methodsHint: 'Note: obj.method() calls excluded. Use include_methods=true to include them.'
                }));
            }

            case 'reverse_trace': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'reverseTrace', ep);
                if (!ok) return toolResult(error);
                return toolResult(output.formatReverseTrace(result, {
                    allHint: 'Set depth to expand all children.',
                }));
            }

            case 'example': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'example', ep);
                if (!ok) return toolResult(error);
                if (!result) return toolResult(`No usage examples found for "${ep.name}".`);
                return toolResult(output.formatExample(result, ep.name));
            }

            case 'related': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'related', ep);
                if (!ok) return toolResult(error);
                if (!result) return toolResult(`Symbol "${ep.name}" not found.`);
                return toolResult(output.formatRelated(result, {
                    all: ep.all || false, top: ep.top,
                    allHint: 'Repeat with all=true to show all.'
                }));
            }

            // ── Finding Code ────────────────────────────────────────────

            case 'find': {
                const index = getIndex(project_dir);
                const { ok, result, error, note } = execute(index, 'find', ep);
                if (!ok) return toolResult(error); // soft error
                let text = output.formatFind(result, ep.name, ep.top);
                if (note) text += '\n\n' + note;
                return toolResult(text);
            }

            case 'usages': {
                const index = getIndex(project_dir);
                const { ok, result, error, note } = execute(index, 'usages', ep);
                if (!ok) return toolResult(error); // soft error
                let text = output.formatUsages(result, ep.name);
                if (note) text += '\n\n' + note;
                return toolResult(text);
            }

            case 'toc': {
                const index = getIndex(project_dir);
                const { ok, result, error, note } = execute(index, 'toc', ep);
                if (!ok) return toolResult(error); // soft error
                let text = output.formatToc(result, {
                    topHint: 'Set top=N or use detailed=false for compact view.'
                });
                if (note) text += '\n\n' + note;
                return toolResult(text);
            }

            case 'search': {
                const index = getIndex(project_dir);
                const { ok, result, error, structural } = execute(index, 'search', ep);
                if (!ok) return toolResult(error); // soft error
                if (structural) {
                    return toolResult(output.formatStructuralSearch(result));
                }
                return toolResult(output.formatSearch(result, ep.term));
            }

            case 'tests': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'tests', ep);
                if (!ok) return toolResult(error); // soft error
                return toolResult(output.formatTests(result, ep.name));
            }

            case 'affected_tests': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'affectedTests', ep);
                if (!ok) return toolResult(error);
                return toolResult(output.formatAffectedTests(result));
            }

            case 'deadcode': {
                const index = getIndex(project_dir);
                const { ok, result, error, note } = execute(index, 'deadcode', ep);
                if (!ok) return toolResult(error); // soft error
                const dcNote = note;
                let dcText = output.formatDeadcode(result, {
                    top: ep.top || 0,
                    decoratedHint: !ep.includeDecorated && result.excludedDecorated > 0 ? `${result.excludedDecorated} decorated/annotated symbol(s) hidden (framework-registered). Use include_decorated=true to include them.` : undefined,
                    exportedHint: !ep.includeExported && result.excludedExported > 0 ? `${result.excludedExported} exported symbol(s) excluded (all have callers). Use include_exported=true to audit them.` : undefined
                });
                if (dcNote) dcText += '\n\n' + dcNote;
                return toolResult(dcText);
            }

            case 'entrypoints': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'entrypoints', ep);
                if (!ok) return toolResult(error);
                return toolResult(output.formatEntrypoints(result));
            }

            // ── File Dependencies ───────────────────────────────────────

            case 'imports': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'imports', ep);
                if (!ok) return toolResult(error); // soft error
                return toolResult(output.formatImports(result, ep.file));
            }

            case 'exporters': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'exporters', ep);
                if (!ok) return toolResult(error); // soft error
                return toolResult(output.formatExporters(result, ep.file));
            }

            case 'file_exports': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'fileExports', ep);
                if (!ok) return toolResult(error); // soft error
                return toolResult(output.formatFileExports(result, ep.file));
            }

            case 'graph': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'graph', ep);
                if (!ok) return toolResult(error); // soft error
                return toolResult(output.formatGraph(result, {
                    showAll: ep.all || ep.depth !== undefined,
                    maxDepth: ep.depth ?? 2, file: ep.file,
                    depthHint: 'Set depth parameter for deeper graph.',
                    allHint: 'Set depth to expand all children.'
                }));
            }

            case 'circular_deps': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'circularDeps', ep);
                if (!ok) return toolResult(error);
                return toolResult(output.formatCircularDeps(result));
            }

            // ── Refactoring ─────────────────────────────────────────────

            case 'verify': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'verify', ep);
                if (!ok) return toolResult(error); // soft error
                return toolResult(output.formatVerify(result));
            }

            case 'plan': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'plan', ep);
                if (!ok) return toolResult(error); // soft error
                return toolResult(output.formatPlan(result));
            }

            case 'diff_impact': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'diffImpact', ep);
                if (!ok) return toolResult(error); // soft error — e.g. "not a git repo"
                return toolResult(output.formatDiffImpact(result));
            }

            // ── Other ───────────────────────────────────────────────────

            case 'typedef': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'typedef', ep);
                if (!ok) return toolResult(error); // soft error
                return toolResult(output.formatTypedef(result, ep.name));
            }

            case 'stacktrace': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'stacktrace', ep);
                if (!ok) return toolResult(error); // soft error
                return toolResult(output.formatStackTrace(result));
            }

            case 'api': {
                const index = getIndex(project_dir);
                const { ok, result, error, note } = execute(index, 'api', ep);
                if (!ok) return toolResult(error); // soft error
                let apiText = output.formatApi(result, ep.file || '.');
                if (note) apiText += '\n\n' + note;
                return toolResult(apiText);
            }

            case 'stats': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'stats', ep);
                if (!ok) return toolResult(error); // soft error
                return toolResult(output.formatStats(result, { top: ep.top || 0 }));
            }

            // ── Extracting Code (via execute) ────────────────────────────

            case 'fn': {
                const err = requireName(ep.name);
                if (err) return err;
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'fn', ep);
                if (!ok) return toolResult(error); // soft error
                // MCP path security: validate all result files are within project root
                for (const entry of result.entries) {
                    const check = resolveAndValidatePath(index, entry.match.relativePath || path.relative(index.root, entry.match.file));
                    if (typeof check !== 'string') return check;
                }
                const notes = result.notes.length ? result.notes.map(n => 'Note: ' + n).join('\n') + '\n\n' : '';
                return toolResult(notes + output.formatFnResult(result));
            }

            case 'class': {
                const err = requireName(ep.name);
                if (err) return err;
                if (ep.maxLines !== undefined && (!Number.isInteger(ep.maxLines) || ep.maxLines < 1)) {
                    return toolError(`Invalid max_lines: ${ep.maxLines}. Must be a positive integer.`);
                }
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'class', ep);
                if (!ok) return toolResult(error);  // soft error (class not found)
                // MCP path security: validate all result files are within project root
                for (const entry of result.entries) {
                    const check = resolveAndValidatePath(index, entry.match.relativePath || path.relative(index.root, entry.match.file));
                    if (typeof check !== 'string') return check;
                }
                const notes = result.notes.length ? result.notes.map(n => 'Note: ' + n).join('\n') + '\n\n' : '';
                return toolResult(notes + output.formatClassResult(result));
            }

            case 'lines': {
                const index = getIndex(project_dir);
                const { ok, result, error } = execute(index, 'lines', ep);
                if (!ok) return toolResult(error); // soft error
                // MCP path security: validate file is within project root
                const check = resolveAndValidatePath(index, result.relativePath);
                if (typeof check !== 'string') return check;
                return toolResult(output.formatLines(result));
            }

            case 'expand': {
                if (ep.item === undefined || ep.item === null) {
                    return toolError('Item number is required (e.g. item=1).');
                }
                const index = getIndex(project_dir);
                const lookup = expandCacheInstance.lookup(index.root, ep.item);
                const { ok, result, error } = execute(index, 'expand', {
                    match: lookup.match, itemNum: ep.item,
                    itemCount: lookup.itemCount, symbolName: lookup.symbolName,
                    validateRoot: true
                });
                if (!ok) return toolResult(error); // soft error
                return toolResult(result.text);
            }

            default:
                return toolError(`Unknown command: ${command}`);
            }
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// ============================================================================
// START SERVER
// ============================================================================

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('UCN MCP server running on stdio');
}

main().catch(e => {
    console.error('UCN MCP server failed to start:', e);
    process.exit(1);
});
