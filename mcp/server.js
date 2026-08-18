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
const {
    getMcpCommandEnum,
    normalizeParams,
    FLAG_APPLICABILITY,
    REVERSE_PARAM_MAP,
    generateMcpParamSection,
    resolveCommand,
    suggestCommand,
    v4MigrationHint,
    formatSurfaceMessage,
} = require('../core/registry');
const { execute } = require('../core/execute');
const { applyOutputBudget, MAX_OUTPUT_CHARS } = require('../core/output-budget');

// ============================================================================
// INDEX CACHE
// ============================================================================

const indexCache = new Map(); // projectDir → { index, checkedAt }
const MAX_CACHE_SIZE = 10;

function getIndex(projectDir, options) {
    if (typeof projectDir !== 'string' || projectDir.trim().length === 0) {
        throw new Error('project_dir is required and must be a non-empty path.');
    }
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

function toolResult(text, command, maxChars, suffixNote, params = {}) {
    const suffix = suffixNote || '';
    const budget = applyOutputBudget(text, {
        command,
        maxChars,
        surface: 'mcp',
        params,
    });
    // The text block is the ONLY payload channel. Truncation facts live in the
    // text itself (the OUTPUT TRUNCATED notice carries full size, limit, and
    // narrowing hints; preserved contract lines follow). A structuredContent
    // side-channel is rendered INSTEAD of content by MCP clients that prefer
    // structured results, which discards the entire answer (fix #284).
    return { content: [{ type: 'text', text: budget.text + suffix }] };
}

function toolError(message) {
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function paramEditDistance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    const prev = new Array(b.length + 1);
    const curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
            curr[j] = Math.min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
        for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
    }
    return prev[b.length];
}

/**
 * Detect parameters the schema does not define, DELETE them from rawParams,
 * and return one human-readable note per dropped key. Three cases:
 * canonical camelCase spelling of a known param (includeTests), a close typo
 * (include_test), and an entirely unknown key (zzz).
 */
function collectUnknownParamNotes(rawParams) {
    const knownKeys = Object.keys(INPUT_SHAPE).filter(key => key !== 'command' && key !== 'project_dir');
    const knownSet = new Set(knownKeys);
    const notes = [];
    for (const key of Object.keys(rawParams)) {
        if (knownSet.has(key)) continue;
        delete rawParams[key];
        const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
        if (knownSet.has(snake)) {
            notes.push(`${key} is not an accepted parameter — use ${snake}.`);
            continue;
        }
        let best = null;
        let bestDistance = 3;
        for (const candidate of knownKeys) {
            const distance = paramEditDistance(key.toLowerCase(), candidate);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = candidate;
            }
        }
        notes.push(best
            ? `unknown parameter ${key} ignored — did you mean ${best}?`
            : `unknown parameter ${key} ignored.`);
    }
    return notes;
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

const CONCISE_TOOL_DESCRIPTION = `Auditable AST code intelligence for JavaScript/TypeScript, Python, Go, Rust, Java, C, C++, C#, and HTML.

Use UCN for semantic questions: exact definitions, symbol-aware callers/callees, change impact, test selection, dependencies, APIs, entry points, and focused audits. Use grep/ripgrep for simple literals, error messages, configuration, filenames, Markdown, and unsupported languages. UCN search is worthwhile when AST structure, code-only filtering, or the shared agent contract matters.

18 task-oriented commands:
- repo: repository overview; sections=files,stats,health adds detail. Reports skipped unsupported source explicitly and hands it to grep/language-native tooling.
- show: one symbol; sections=summary,callers,callees,source,dependencies,tests,types,example,related.
- find/usages/search/source: locate definitions, literal-name occurrences, literal text (regex=true selects the linear-time RE2-compatible engine), AST structure, or exact source. Find activity is pinned confirmed + visible-unverified candidates; proved other-target calls are separate.
- trace: direction=callees or callers; to=entrypoints follows callers to roots.
- impact: symbol impact when name is set; Git-diff impact when it is omitted.
- tests: static direct links by default; depth>0 includes transitive affected links. Empty results are not runtime coverage proof.
- deps/api/entrypoints/endpoints: architecture and public surfaces.
- check: symbol signature check when name is set; precommit check when omitted. plan previews the selected declaration plus indexed call/import/export edits.
- deadcode/audit_async/stacktrace: focused audits and runtime evidence. Computed dispatch is reported as a health/deletion blind spot; unknown decorators and member-assigned handlers are withheld from default dead-code claims.

CONFIRMED carries target-identity evidence. UNVERIFIED is possible and requires review; when same-name definitions compete, show returns their stable handles once above the sites. ACCOUNT conserves observed literal-name lines; an observed-text zero never claims semantic completeness or safe deletion. Evidence weights are ordinal, not probabilities. Warnings, excluded reasons, and contract metadata remain visible when caller evidence is returned. Release evaluation cross-checks overlapping stable-handle claims across find, show, source, impact, tests, check, and caller trace, and compares pinned real-repository samples with ts-morph, Pyright, gopls, rust-analyzer, JDT LS, clangd, and Roslyn.` + generateMcpParamSection();

// The default description is the only public contract. The former verbose
// description is intentionally not selectable: it documented retired commands
// and made the single MCP tool difficult for agents to parse.
const TOOL_DESCRIPTION = CONCISE_TOOL_DESCRIPTION;

// The schema shape is named so the handler can distinguish known keys from
// unknown/typo'd/camelCase ones — z.object() would otherwise strip them
// silently, and a silently ignored parameter changes the answer with no
// signal (e.g. include_test:true returning untested-filtered results).
const INPUT_SHAPE = {
    command: null, // assigned below (needs z at load time)
};

server.registerTool(
    'ucn',
    {
        description: TOOL_DESCRIPTION,
        inputSchema: z.object(Object.assign(INPUT_SHAPE, {
            // Runtime validation stays string-based so retired v4 names reach
            // directive migration guidance. Zod metadata publishes the strict
            // v5 enum to MCP clients without making retired names aliases.
            command: z.string()
                .meta({ enum: getMcpCommandEnum() })
                .describe(`UCN task command. One of: ${getMcpCommandEnum().join(', ')}.`),
            project_dir: z.string().trim().min(1, 'project_dir is required and must be a non-empty path.').describe('Non-empty absolute path, or a path relative to the MCP server process working directory, identifying the project to analyze.'),
            name: z.string().optional().describe('Symbol name or stable path:line:name handle. Used by show/find/usages/source/trace/impact/tests/check/plan.'),
            file: z.string().optional().describe('File target for source/deps/api or a symbol-disambiguation filter.'),
            sections: z.string().optional().describe('Comma-separated projection. show: summary,callers,callees,source,dependencies,tests,types,example,related. repo: summary,files,stats,health.'),
            exclude: z.string().optional().describe('Comma-separated patterns to exclude (e.g. "test,mock,vendor")'),
            include_tests: z.boolean().optional().describe('Include test files in results (excluded by default)'),
            exclude_tests: z.boolean().optional().describe('Explicit spelling of the default test-file exclusion (entrypoints). Use include_tests=true to include test files.'),
            include_methods: z.boolean().optional().describe('Include method callees where receiver evidence permits. Caller-bearing views always tier method sites.'),
            expand_unverified: z.boolean().optional().describe('trace callers: follow unverified edges; downstream nodes remain marked possible, never confirmed.'),
            min_confidence: z.number().min(0).max(1).optional().describe('Minimum ordinal evidence weight (legacy name; not a probability) for caller/callee edges'),
            show_confidence: z.boolean().optional().describe('show: resolution-evidence labels default to visible; set false to hide them. Numeric weights are ordinal, not probabilities.'),
            unreachable_only: z.boolean().optional().describe('show/impact: retain only relationships unreachable from detected entry points.'),
            with_types: z.boolean().optional().describe('show: include related type definitions.'),
            with_source: z.boolean().optional().describe('Attach exact source to find results.'),
            detailed: z.boolean().optional().describe('repo files: show symbols per file; deps: include import declarations and importers.'),
            exact: z.boolean().optional().describe('Exact name match only (no substring matching)'),
            in: z.string().optional().describe('Only search in this directory path (e.g. "src/core")'),
            top: z.number().int().positive().max(10000).optional().describe('Max results to show (default: 10). Must be a positive integer.'),
            depth: z.number().int().nonnegative().max(100).optional().describe('Max depth (default: 3 for trace, 2 for deps); expands all children. Non-negative integer.'),
            code_only: z.boolean().optional().describe('Exclude matches in comments and strings'),
            context: z.number().int().nonnegative().max(1000).optional().describe('Lines of context around each match. Non-negative integer.'),
            include_exported: z.boolean().optional().describe('Include exported symbols in deadcode results'),
            include_decorated: z.boolean().optional().describe('Include decorated/annotated symbols in deadcode results'),
            calls_only: z.boolean().optional().describe('tests: retain direct calls and test-case matches only.'),
            max_lines: z.number().int().positive().max(1000000).optional().describe('source: maximum lines for large class-like declarations.'),
            direction: z.enum(['callees', 'callers', 'imports', 'importers', 'both']).optional().describe('trace: callees/callers. deps: imports/importers/both.'),
            to: z.enum(['entrypoints']).optional().describe('trace with direction=callers: continue toward entry points.'),
            cycles: z.boolean().optional().describe('deps: report circular imports instead of a file graph.'),
            term: z.string().optional().describe('Literal search term by default. Set regex=true only for regular-expression syntax.'),
            regex: z.boolean().optional().describe('Treat search term as a regular expression (default: false/literal). Ordinary patterns run in an RE2-compatible linear-time engine; unsafe nested repetition is rejected.'),
            functions: z.boolean().optional().describe('repo stats: include per-function line counts sorted by size.'),
            hot: z.boolean().optional().describe('repo stats: include the top N most-called functions.'),
            diverse: z.boolean().optional().describe('show example: return representatives from distinct argument shapes.'),
            git: z.boolean().optional().describe('show summary: attach last-modified, author, and recent-change metadata.'),
            add_param: z.string().optional().describe('Parameter name to add (plan command)'),
            remove_param: z.string().optional().describe('Parameter name to remove (plan command)'),
            rename_to: z.string().optional().describe('New function name (plan command)'),
            default_value: z.string().optional().describe('Default value for added parameter (plan command)'),
            stack: z.string().optional().describe('The stack trace text to parse (stacktrace command)'),
            range: z.string().optional().describe('source line range, e.g. "10-20" or "15"; requires file.'),
            base: z.string().optional().describe('Git ref to diff against (default: HEAD). E.g. "HEAD~3", "main", a commit SHA'),
            staged: z.boolean().optional().describe('impact/check without a symbol: analyze staged changes.'),
            deep: z.boolean().optional().describe('repo: include health and sample the ordinal resolution-evidence profile, not accuracy.'),
            compact: z.boolean().optional().describe('Compact output defaults to true for show/impact and false for usages; set the opposite value to change that command\'s presentation.'),
            case_sensitive: z.boolean().optional().describe('Case-sensitive search (default: false, case-insensitive)'),
            all: z.boolean().optional().describe('Lift formatter and result caps where supported.'),
            top_level: z.boolean().optional().describe('repo files: show only top-level functions.'),
            class_name: z.string().optional().describe('Class name to scope method analysis (e.g. "MarketDataFetcher" for close)'),
            line: z.number().int().positive().optional().describe('Definition line pin. Resolves the symbol defined at this exact line (the middle component of a file:line:name handle). Disambiguates same-file same-name definitions.'),
            limit: z.number().int().positive().max(1000000).optional().describe('Max results to return (default: 500). Caps find, usages, search, deadcode, api, and repo files. Must be a positive integer.'),
            max_files: z.number().int().positive().max(10000000).optional().describe('Max files to index (default: 10000). Use for very large codebases. Must be a positive integer.'),
            max_chars: z.number().int().positive().max(100000).optional().describe('Max output chars before truncation. Broad sweep commands (repo, entrypoints, endpoints, deadcode, deps, check, audit_async) default to 3K; all other commands default to 10K. Maximum: 100K. all=true lifts formatter caps but keeps the 100K transport ceiling.'),
            // Structural search flags (search command)
            type: z.string().optional().describe('Symbol type filter for structural search: function, class, call, method, type, state, field, constant, macro. Triggers index-based search.'),
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
            method: z.string().optional().describe('Filter by HTTP method (e.g. "GET", "POST") for endpoints.'),
            prefix: z.string().optional().describe('Filter routes/requests by path prefix (endpoints command).'),
            hide_uncertain: z.boolean().optional().describe('Hide uncertain (interpolated-path) bridges (endpoints command).')

        })).passthrough()
    },
    async (args) => {
        const { command, project_dir, ...rawParams } = args;

        // Defensive validation for direct/internal handler calls. MCP clients
        // normally fail at the strict command enum before reaching this path.
        if (!resolveCommand(command, 'mcp')) {
            const migration = v4MigrationHint(command, 'mcp');
            if (migration) return toolError(`Unknown command: ${command}. ${migration}`);
            const suggestion = suggestCommand(command, 'mcp');
            return toolError(`Unknown command: ${command}.` +
                (suggestion ? ` Did you mean "${suggestion}"?` : '') +
                ` Valid commands: ${getMcpCommandEnum().join(', ')}.`);
        }

        // Unknown, typo'd, or camelCase-spelled parameters must never
        // silently no-op. They are dropped, and each one gets a Note.
        const unknownParamNotes = collectUnknownParamNotes(rawParams);

        // Normalize ALL params once — execute() handlers pick what they need.
        // This eliminates per-case param selection and prevents CLI/MCP drift.
        const ep = normalizeParams(rawParams);

        // Strip params not applicable to this command (prevents silent no-ops).
        // Global/core params are always allowed — only optional flags are filtered.
        // FLAG_APPLICABILITY is keyed by canonical (camelCase) names, but `command`
        // is the MCP (snake_case) name — resolve to canonical first to avoid
        // silently skipping multi-word commands such as audit_async.
        const strippedParams = [];
        const canonicalCommand = resolveCommand(command, 'mcp') || command;
        const applicable = FLAG_APPLICABILITY[canonicalCommand];
        let projectScopeNote = null;
        // Match the CLI's directory-target convenience. The index still lives
        // at the repository root for cross-file resolution, while commands
        // supporting `in` receive the requested subdirectory as an implicit
        // result scope. Commands without such a scope disclose the widening.
        try {
            const requestedDir = path.resolve(project_dir);
            if (fs.existsSync(requestedDir) && fs.statSync(requestedDir).isDirectory()) {
                const projectRoot = findProjectRoot(requestedDir);
                if (requestedDir !== projectRoot && requestedDir.startsWith(projectRoot + path.sep)) {
                    const relativeScope = path.relative(projectRoot, requestedDir);
                    if (applicable?.includes('in')) {
                        if (!ep.in) ep.in = relativeScope;
                        projectScopeNote = `project_dir resolved to repository root; results scoped with in=${ep.in}.`;
                    } else {
                        projectScopeNote = `project_dir resolved to repository root ${projectRoot}; '${command}' has no in parameter, so results cover the repository root.`;
                    }
                }
            }
        } catch (_) {
            // getIndex below owns the authoritative path error.
        }
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

        // all=true lifts formatter caps and raises MCP output to its hard ceiling.
        // `all` lifts formatter caps; an explicit transport budget remains a
        // hard caller-controlled ceiling.
        const maxChars = ep.maxChars ?? (ep.all ? MAX_OUTPUT_CHARS : undefined);

        // Build stripping note (appended inside truncation boundary on success paths)
        const noteParts = [];
        if (strippedParams.length > 0) {
            noteParts.push(`${strippedParams.join(', ')} ignored (not applicable to ${command}).`);
        }
        if (ep.includeMethods && ['impact', 'trace', 'tests', 'check'].includes(canonicalCommand)) {
            noteParts.push(`include_methods=true has no effect on '${command}' — method calls are always tiered by receiver evidence.`);
        }
        if (projectScopeNote) noteParts.push(projectScopeNote);
        noteParts.push(...unknownParamNotes);
        const strippedNote = noteParts.length > 0
            ? '\n\n' + noteParts.map(part => `Note: ${part}`).join('\n')
            : '';

        // Wrap toolResult to auto-inject command + maxChars + stripping note
        const tr = (text) => toolResult(text, command, maxChars, strippedNote, ep);
        // Wrap toolError to include stripping note on error paths too
        const te = strippedNote
            ? (msg) => toolError(msg + strippedNote)
            : toolError;
        // Translate CLI flag syntax in execute-layer notes to MCP param
        // syntax — the deadcode exported/decorated hints were already
        // param-styled, but limit/depth/truncation notes leaked
        // '--limit N' / '--max-files N' / '--all' at this surface.
        const mn = (note) => note && note
            .replace(/--limit N\b/g, 'limit=<n>')
            .replace(/--max-files N\b/g, 'max_files=<n>')
            .replace(/--depth=N\b/g, 'depth=<n>')
            .replace(/--detailed\b/g, 'detailed=true')
            .replace(/--all\b/g, 'all=true')
            .replace(/--expand-unverified\b/g, 'expand_unverified=true')
            .replace(/--(\w[\w-]*)/g, (_m, f) => f.replace(/-/g, '_'));

        let index = null; // Track for post-command cache save
        try {
            // Public v5 has one MCP dispatch path. The canonical registry,
            // execute() handler, and public formatter are shared with CLI;
            // command-specific switches are no longer part of the contract.
            index = getIndex(project_dir, ep);
            // Validate an explicit source file before execute() can read it.
            // Post-result checks are still retained below for symbol-derived
            // paths, but a range request may point at a real file outside the
            // project and must fail before any content leaves the process.
            if (canonicalCommand === 'source' && ep.file) {
                const sourcePath = resolveAndValidatePath(index, ep.file);
                if (typeof sourcePath !== 'string') return sourcePath;
                ep.file = path.relative(index.root, sourcePath);
            }
            const execution = execute(index, canonicalCommand, ep);
            if (!execution.ok) {
                return te(formatSurfaceMessage(execution.error, 'mcp'));
            }

            // Preserve MCP's path-boundary guarantee for source-bearing
            // results after consolidating fn/class/lines into source/show.
            const validateSource = (sourceResult) => {
                if (!sourceResult) return null;
                if (Array.isArray(sourceResult.entries)) {
                    for (const entry of sourceResult.entries) {
                        const file = entry.match?.relativePath || (entry.match?.file && path.relative(index.root, entry.match.file));
                        if (!file) continue;
                        const check = resolveAndValidatePath(index, file);
                        if (typeof check !== 'string') return check;
                    }
                } else if (sourceResult.relativePath) {
                    const check = resolveAndValidatePath(index, sourceResult.relativePath);
                    if (typeof check !== 'string') return check;
                }
                return null;
            };
            const sourceError = canonicalCommand === 'source'
                ? validateSource(execution.result)
                : (canonicalCommand === 'show' ? validateSource(execution.result.source) : null);
            if (sourceError) return sourceError;

            const presentationExecution = {
                ...execution,
                note: mn(execution.note),
                surface: 'mcp',
            };
            return tr(output.formatPublicText(
                canonicalCommand,
                execution.result,
                ep,
                presentationExecution,
            ));

        } catch (e) {
            return te(e.message);
        } finally {
            // Persist calls cache after command execution.
            // getIndex() only saves after build (when callsCache is empty).
            // Commands like show/impact/trace populate callsCache lazily,
            // so we save here to avoid re-parsing all files on every MCP session.
            // MED-1: also persist when reachability was computed in-process so
            // long-lived MCP servers carry the BFS result forward to disk.
            if (index && (index.callsCacheDirty || index.reachabilityDirty || index.computedDispatchDirty)) {
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
