#!/usr/bin/env node

/**
 * Universal Code Navigator (UCN) - MCP Server
 *
 * Stdio-based MCP server that wraps ProjectIndex methods.
 * Keeps a per-project index cache for fast repeat queries.
 */

// Reuse V8 code caches across processes (Node >= 22.1; fix #365): compiling
// the engine's modules is a fixed cost of every command. Node validates each
// entry against the source, and NODE_DISABLE_COMPILE_CACHE turns it off.
try { require('module').enableCompileCache?.(); } catch (_) { /* optional */ }

const fs = require('fs');
const path = require('path');
const { StdioMcpServer } = require('./stdio-server');

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
    mcpParamProperties,
    paramValues,
    GLOBAL_PARAMS,
    resolveCommand,
    suggestCommand,
    v4MigrationHint,
    formatSurfaceMessage,
} = require('../core/registry');
const { execute } = require('../core/execute');
const { sourceRangeTarget, noOpNotes } = require('../core/public-command');
const { describeError, UcnError } = require('../core/errors');
const { applyOutputBudget, MAX_OUTPUT_CHARS } = require('../core/output-budget');

// ============================================================================
// INDEX CACHE
// ============================================================================

const indexCache = new Map(); // projectDir → { index, checkedAt }
const MAX_CACHE_SIZE = 10;

function getIndex(projectDir, options) {
    if (typeof projectDir !== 'string' || projectDir.trim().length === 0) {
        throw new UcnError('project_dir is required and must be a non-empty path.');
    }
    const maxFiles = options && options.maxFiles;
    const followSymlinks = options && options.followSymlinks;
    const includeBundled = options?.includeBundled === true;
    const absDir = path.resolve(projectDir);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        throw new UcnError(`Project directory not found: ${absDir}`);
    }
    const root = findProjectRoot(absDir);
    const cached = indexCache.get(root);

    // Always check staleness — MCP is used in iterative agent loops where
    // files change between requests, so a throttle causes stale results.
    if (cached && !maxFiles && !includeBundled) {
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
    buildOpts.includeBundled = includeBundled;
    const loaded = !includeBundled && index.loadCache();
    if (loaded && !index.includeBundled && !maxFiles && !index.isCacheStale()) {
        // Disk cache is fresh (skip when maxFiles is set — cached index may have different file count)
    } else {
        buildOpts.forceRebuild = !!loaded;
        if (maxFiles || includeBundled) {
            index.build(null, buildOpts); // Don't pollute disk cache with partial indexes
        } else {
            // Cross-process build lock (fix #354): a CLI or another MCP
            // server building the same repo at the same moment shares one build
            index.buildCached(buildOpts);
        }
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
    if (!maxFiles && !includeBundled) {
        indexCache.set(root, { index, checkedAt: Date.now() });
    }
    return index;
}

// ============================================================================
// SERVER SETUP
// ============================================================================

const server = new StdioMcpServer({
    name: 'ucn',
    version: require('../package.json').version
});

// ============================================================================
// TOOL HELPERS
// ============================================================================

function toolResult(text, command, maxChars, suffixNote, params = {}, peerText) {
    const suffix = suffixNote || '';
    const budget = applyOutputBudget(text + suffix, {
        command,
        maxChars,
        surface: 'mcp',
        params,
        ...(typeof peerText === 'string' && { peerText: peerText + suffix }),
    });
    // The text block is the ONLY payload channel. Truncation facts live in the
    // text itself (the OUTPUT TRUNCATED notice carries full size, limit, and
    // narrowing hints; preserved contract lines follow). A structuredContent
    // side-channel is rendered INSTEAD of content by MCP clients that prefer
    // structured results, which discards the entire answer (fix #284).
    return { content: [{ type: 'text', text: budget.text }] };
}

function toolError(message) {
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** An exception inside UCN: marked internal, never rendered as a refusal (fix #394). */
function internalToolError(message) {
    return { content: [{ type: 'text', text: message }], isError: true };
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
- repo: repository overview; sections=${paramValues('sections', 'repo').join(',')} selects detail. Reports skipped unsupported source explicitly and hands it to grep/language-native tooling.
- show: one symbol; sections=${paramValues('sections', 'show').join(',')}.
- find/usages/search/source: locate definitions, literal-name occurrences, literal text (regex=true selects the linear-time RE2-compatible engine), AST structure, or exact source. Find activity is pinned confirmed + visible-unverified candidates; proved other-target calls are separate.
- trace: direction=${paramValues('direction', 'trace').join(' or ')}; to=${paramValues('to', 'trace').join('|')} follows callers to roots.
- impact: symbol impact when name is set; Git-diff impact when it is omitted.
- tests: static direct links by default; depth>0 includes transitive affected links. Empty results are not runtime coverage proof.
- deps/api/entrypoints/endpoints: architecture and public surfaces.
- check: symbol signature check when name is set; precommit check when omitted (per changed symbol: BLOCKED = a break was observed, REVIEW = can reach existing code, READY = nothing existing depends on it; staged=true reads the git index, not the worktree). plan previews the selected declaration plus indexed call/import/export edits; with delete=true it assesses deleting the declaration (no-static-dependents, has-static-dependents, or review with the reason), by the rule deadcode applies to every name. A .ucn.json "kind": "application" lets exported symbols be assessed.
- deadcode/audit_async/stacktrace: focused audits and runtime evidence. Computed dispatch is reported as a health/deletion blind spot; unknown decorators and member-assigned handlers are withheld from default dead-code claims.

CONFIRMED carries target-identity evidence. UNVERIFIED is possible and requires review; when same-name definitions compete, show returns their stable handles once above the sites. ACCOUNT conserves observed literal-name lines; an observed-text zero never claims semantic completeness or safe deletion. CONTRACT is a state: text-complete means every literal-name line of project source was classified, never that aliases, indirect calls, generated code or runtime dispatch are absent. Source UCN reads without analyzing (bundles, paths excluded in .ucn.json, oversized files, unsupported languages) is searched for each name and listed only when the name occurs there; a path that cannot be read degrades every account. repo health states the scope once. Evidence weights are ordinal, not probabilities. Warnings, excluded reasons, and contract metadata remain visible when caller evidence is returned. Releases are gated on pinned real repositories: sampled callers, callees, value references, and dead-code claims are compared with ts-morph, Pyright, gopls, rust-analyzer, JDT LS, Roslyn, and clangd, and one handle's claims must agree across find, show, source, impact, tests, check, and caller trace.` + generateMcpParamSection();

// The default description is the only public contract. The former verbose
// description is intentionally not selectable: it documented retired commands
// and made the single MCP tool difficult for agents to parse.
const TOOL_DESCRIPTION = CONCISE_TOOL_DESCRIPTION;

// The public JSON Schema and the runtime validation rules are one object,
// written from the registry's parameter table: a type, a bound, a value list
// or a default stated here is the one the engine uses. Unknown keys remain
// allowed so the handler can return typo and applicability guidance instead
// of silently changing the requested answer.
const INPUT_SHAPE = {
    command: {
        type: 'string',
        description: `UCN task command. One of: ${getMcpCommandEnum().join(', ')}.`,
        enum: getMcpCommandEnum(),
    },
    project_dir: {
        type: 'string',
        description: 'Non-empty absolute path, or a path relative to the MCP server process working directory, identifying the project to analyze.',
        minLength: 1,
    },
    ...mcpParamProperties(),
};

const INPUT_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: INPUT_SHAPE,
    required: ['command', 'project_dir'],
    additionalProperties: {},
};

server.registerTool(
    'ucn',
    {
        description: TOOL_DESCRIPTION,
        inputSchema: INPUT_SCHEMA,
        annotations: {
            title: 'Universal Code Navigator',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
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
            const coreParams = new Set(GLOBAL_PARAMS);
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
        for (const note of noOpNotes(canonicalCommand, ep)) noteParts.push(formatSurfaceMessage(note, 'mcp'));
        if (projectScopeNote) noteParts.push(projectScopeNote);
        noteParts.push(...unknownParamNotes);
        const strippedNote = noteParts.length > 0
            ? '\n\n' + noteParts.map(part => `Note: ${part}`).join('\n')
            : '';
        // In a line listing everything that is not a record is a "# " line.
        const listingNote = noteParts.length > 0
            ? '\n' + noteParts.map(part => `# Note: ${part}`).join('\n')
            : '';

        // Wrap toolResult to auto-inject command + maxChars + stripping note
        const tr = (text, peerText) => toolResult(text, command, maxChars, ep.lines ? listingNote : strippedNote, ep, peerText);
        // Wrap toolError to include stripping note on error paths too
        const te = strippedNote
            ? (msg) => toolError(msg + strippedNote)
            : toolError;
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
            // `name` is the file of a range request (name=<file>, range="N-M").
            if (canonicalCommand === 'source') {
                const target = sourceRangeTarget(ep);
                if (target !== ep) { delete ep.name; ep.file = target.file; }
            }
            if (canonicalCommand === 'source' && ep.file) {
                const sourcePath = resolveAndValidatePath(index, ep.file);
                if (typeof sourcePath !== 'string') return sourcePath;
                ep.file = path.relative(index.root, sourcePath);
            }
            const execution = execute(index, canonicalCommand, ep);
            if (!execution.ok) {
                if (execution.internalError) return internalToolError(execution.error + strippedNote);
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
                surface: 'mcp',
            };
            return tr(output.formatPublicText(
                canonicalCommand,
                execution.result,
                ep,
                presentationExecution,
            ), ep.lines || ep.raw ? undefined : output.formatPublicText(
                canonicalCommand,
                execution.result,
                ep,
                { ...execution, surface: 'cli' },
            ));

        } catch (e) {
            const described = describeError(e);
            if (described.internalError) return internalToolError(described.error + strippedNote);
            return te(described.error);
        } finally {
            // Persist calls cache after command execution.
            // getIndex() only saves after build (when callsCache is empty).
            // Commands like show/impact/trace populate callsCache lazily,
            // so we save here to avoid re-parsing all files on every MCP session.
            // MED-1: also persist when reachability was computed in-process so
            // long-lived MCP servers carry the BFS result forward to disk.
            if (index && !ep.includeBundled && !ep.maxFiles &&
                (index.callsCacheDirty || index.reachabilityDirty || index.computedDispatchDirty || index.macroExpansionDirty)) {
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
    server.connect();
    // Print the running version so MCP-vs-CLI drift is visible (field-report #3:
    // a stale `npx -y ucn` cache can silently run an older engine than the CLI).
    console.error(`UCN MCP server v${require('../package.json').version} running on stdio`);
}

main().catch(e => {
    console.error('UCN MCP server failed to start:', e);
    process.exit(1);
});
