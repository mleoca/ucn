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
const { findProjectRoot, isTestFile } = require('../core/discovery');
const { detectLanguage } = require('../core/parser');
const output = require('../core/output');

// ============================================================================
// INDEX CACHE
// ============================================================================

const indexCache = new Map(); // projectDir → { index, checkedAt }
const expandCache = new Map(); // projectDir:symbolName → { items, root, symbolName, usedAt }
const lastContextKey = new Map(); // projectRoot → expandCache key
const MAX_CACHE_SIZE = 10;
const MAX_EXPAND_CACHE_SIZE = 50;

function getIndex(projectDir) {
    const absDir = path.resolve(projectDir);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        throw new Error(`Project directory not found: ${absDir}`);
    }
    const root = findProjectRoot(absDir);
    const cached = indexCache.get(root);

    // Always check staleness — isCacheStale() is cheap (mtime/size checks)
    if (cached && !cached.index.isCacheStale()) {
        cached.checkedAt = Date.now(); // True LRU: refresh on access
        return cached.index;
    }

    // Build new index (or rebuild stale one)
    const index = new ProjectIndex(root);
    const loaded = index.loadCache();
    if (loaded && !index.isCacheStale()) {
        // Disk cache is fresh
    } else {
        index.build(null, { quiet: true, forceRebuild: loaded });
        index.saveCache();
    }

    // LRU eviction
    if (indexCache.size >= MAX_CACHE_SIZE) {
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
            // Clean up associated expandCache and lastContextKey entries
            for (const [key, val] of expandCache) {
                if (val.root === oldestKey) expandCache.delete(key);
            }
            lastContextKey.delete(oldestKey);
        }
    }

    indexCache.set(root, { index, checkedAt: Date.now() });
    return index;
}

function pickBestDefinition(matches) {
    const typeOrder = new Set(['class', 'struct', 'interface', 'type', 'impl']);
    const scored = matches.map(m => {
        let score = 0;
        const rp = m.relativePath || '';
        if (typeOrder.has(m.type)) score += 1000;
        if (isTestFile(rp, detectLanguage(m.file))) score -= 500;
        if (/^(examples?|docs?|vendor|third[_-]?party|benchmarks?|samples?)\//i.test(rp)) score -= 300;
        if (/^(lib|src|core|internal|pkg|crates)\//i.test(rp)) score += 200;
        if (m.startLine && m.endLine) {
            score += Math.min(m.endLine - m.startLine, 100);
        }
        return { match: m, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].match;
}

// ============================================================================
// SHARED SCHEMA DEFINITIONS
// ============================================================================

const projectDirParam = z.string().describe('Absolute or relative path to the project root directory');
const nameParam = z.string().describe('Symbol name to analyze (function, class, method, etc.)');
const fileParam = z.string().optional().describe('Filter by file path pattern for disambiguation (e.g. "parser", "src/core")');
const excludeParam = z.string().optional().describe('Comma-separated patterns to exclude (e.g. "test,mock,vendor")');
const includeTestsParam = z.boolean().optional().describe('Include test files in results (excluded by default)');
const includeMethodsParam = z.boolean().optional().describe('Include obj.method() calls in caller/callee analysis');
const includeUncertainParam = z.boolean().optional().describe('Include uncertain/ambiguous matches');

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

function addTestExclusions(exclude) {
    const testPatterns = ['test', 'spec', '__tests__', '__mocks__', 'fixture', 'mock'];
    const existing = new Set((exclude || []).map(e => e.toLowerCase()));
    const additions = testPatterns.filter(p => !existing.has(p));
    return [...(exclude || []), ...additions];
}

function parseExclude(excludeStr) {
    if (!excludeStr) return [];
    return excludeStr.split(',').map(s => s.trim()).filter(Boolean);
}

const MAX_OUTPUT_CHARS = 100000; // ~100KB, safe for all MCP clients

function toolResult(text) {
    if (text.length > MAX_OUTPUT_CHARS) {
        const truncated = text.substring(0, MAX_OUTPUT_CHARS);
        // Cut at last newline to avoid breaking mid-line
        const lastNewline = truncated.lastIndexOf('\n');
        const cleanCut = lastNewline > MAX_OUTPUT_CHARS * 0.8 ? truncated.substring(0, lastNewline) : truncated;
        return { content: [{ type: 'text', text: cleanCut + '\n\n... (output truncated — refine query or use --file/--in to narrow scope)' }] };
    }
    return { content: [{ type: 'text', text }] };
}

function toolError(message) {
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function requireName(name) {
    if (!name || !name.trim()) {
        return toolError('Symbol name is required.');
    }
    return null;
}

// ============================================================================
// TOOL REGISTRATIONS
// ============================================================================

// --- ucn_toc ---
server.registerTool(
    'ucn_toc',
    {
        description: 'Get a quick overview of a project you haven\'t seen before. Shows file counts, line counts, function/class counts per file, largest files, and entry points. Use detailed=true to list every function and class. Start here when orienting in a new codebase, then use ucn_about or ucn_find to dive into specific symbols.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            detailed: z.boolean().optional().describe('Show full symbol listing per file')
        })
    },
    async ({ project_dir, detailed }) => {
        try {
            const index = getIndex(project_dir);
            const toc = index.getToc({ detailed: detailed || false });
            return toolResult(output.formatToc(toc));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_find ---
server.registerTool(
    'ucn_find',
    {
        description: 'Locate where a function, class, or method is defined. Use when you know the name but not the file. Returns top matches ranked by usage count with full signatures. Use file parameter to narrow results in large projects with common names.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            name: nameParam,
            file: fileParam,
            exclude: excludeParam,
            include_tests: includeTestsParam,
            exact: z.boolean().optional().describe('Exact name match only (no substring matching)'),
            in: z.string().optional().describe('Only search in this directory path (e.g. "src/core")'),
            top: z.number().optional().describe('Maximum number of results to show (default: 10)')
        })
    },
    async ({ project_dir, name, file, exclude, include_tests, exact, in: inPath, top }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const excludeArr = include_tests ? parseExclude(exclude) : addTestExclusions(parseExclude(exclude));
            const found = index.find(name, { file, exclude: excludeArr, exact: exact || false, in: inPath });
            return toolResult(output.formatFind(found, name, top));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_about ---
server.registerTool(
    'ucn_about',
    {
        description: 'Your first stop when investigating any function or class. Returns everything in one call: definition with source code, who calls it, what it calls, and related tests. Replaces 3-4 grep+read cycles. Use this instead of reading files and grepping for callers manually. For narrower views: ucn_context (just callers/callees, no code), ucn_smart (code + dependencies inline), or ucn_impact (call sites with arguments, for refactoring).',
        inputSchema: z.object({
            project_dir: projectDirParam,
            name: nameParam,
            file: fileParam,
            with_types: z.boolean().optional().describe('Include related type definitions in output'),
            include_methods: z.boolean().optional().describe('Include obj.method() calls in caller/callee analysis (default: true)')
        })
    },
    async ({ project_dir, name, file, with_types, include_methods }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const result = index.about(name, { file, withTypes: with_types || false, includeMethods: include_methods ?? undefined });
            return toolResult(output.formatAbout(result));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_context ---
server.registerTool(
    'ucn_context',
    {
        description: 'Quick answer to "who calls this function and what does it call?" without pulling source code. Lighter than ucn_about when you don\'t need the full picture. Results are numbered — drill into any item with ucn_expand to see its code. For classes/structs, shows all methods instead of callers/callees.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            name: nameParam,
            file: fileParam,
            include_methods: includeMethodsParam,
            include_uncertain: includeUncertainParam
        })
    },
    async ({ project_dir, name, file, include_methods, include_uncertain }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const ctx = index.context(name, {
                includeMethods: include_methods,
                includeUncertain: include_uncertain || false,
                file
            });
            const { text, expandable } = output.formatContext(ctx);
            if (expandable.length > 0) {
                const cacheKey = `${index.root}:${name}:${file || ''}`;
                // LRU eviction for expandCache
                if (expandCache.size >= MAX_EXPAND_CACHE_SIZE && !expandCache.has(cacheKey)) {
                    let oldestKey = null;
                    let oldestTime = Infinity;
                    for (const [key, val] of expandCache) {
                        if ((val.usedAt || 0) < oldestTime) {
                            oldestTime = val.usedAt || 0;
                            oldestKey = key;
                        }
                    }
                    if (oldestKey) expandCache.delete(oldestKey);
                }
                expandCache.set(cacheKey, { items: expandable, root: index.root, symbolName: name, usedAt: Date.now() });
                lastContextKey.set(index.root, cacheKey);
            }
            return toolResult(text);
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_impact ---
server.registerTool(
    'ucn_impact',
    {
        description: 'Shows every place a function is called, with the actual arguments passed at each call site. Essential before changing a function signature — tells you exactly what will break and what needs updating. Grouped by file for easy navigation. For a lighter caller overview without arguments, use ucn_context instead.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            name: nameParam,
            file: fileParam
        })
    },
    async ({ project_dir, name, file }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const result = index.impact(name, { file });
            return toolResult(output.formatImpact(result));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_smart ---
server.registerTool(
    'ucn_smart',
    {
        description: 'Get a function\'s source code with all its helper functions expanded inline. Use when you need to understand or modify a function and its dependencies in one read — saves opening multiple files. Better than reading whole files when you only need one function and its callees. For just the caller/callee list without code, use ucn_context.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            name: nameParam,
            file: fileParam,
            include_methods: includeMethodsParam,
            include_uncertain: includeUncertainParam,
            with_types: z.boolean().optional().describe('Include related type definitions in output')
        })
    },
    async ({ project_dir, name, file, include_methods, include_uncertain, with_types }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const result = index.smart(name, {
                file,
                withTypes: with_types || false,
                includeMethods: include_methods,
                includeUncertain: include_uncertain || false
            });
            return toolResult(output.formatSmart(result));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_trace ---
server.registerTool(
    'ucn_trace',
    {
        description: 'Visualize the execution flow from a function downward as a call tree. Use when you need to understand "what happens when X runs" — maps which modules and functions a pipeline touches without reading any files. Set depth to control how deep to trace (default: 3); setting depth also expands all children at each level. For file-level import/export dependencies, use ucn_graph instead.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            name: nameParam,
            file: fileParam,
            depth: z.number().optional().describe('Maximum call tree depth (default: 3)'),
            include_methods: z.boolean().optional().describe('Include obj.method() calls in caller/callee analysis (default: true for trace)'),
            include_uncertain: z.boolean().optional().describe('Include uncertain/ambiguous matches')
        })
    },
    async ({ project_dir, name, file, depth, include_methods, include_uncertain }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const result = index.trace(name, { depth: depth ?? 3, file, all: depth !== undefined, includeMethods: include_methods, includeUncertain: include_uncertain });
            return toolResult(output.formatTrace(result));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_usages ---
server.registerTool(
    'ucn_usages',
    {
        description: 'See every usage of a symbol across the project, organized by type: definitions, calls, imports, and references. Use when you need the complete picture of how something is used — not just callers (ucn_context) or call sites (ucn_impact), but also imports and non-call references. Use code_only=true to skip matches in comments and strings.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            name: nameParam,
            exclude: excludeParam,
            include_tests: includeTestsParam,
            code_only: z.boolean().optional().describe('Exclude matches in comments and strings'),
            context: z.number().optional().describe('Lines of context around each match'),
            in: z.string().optional().describe('Only search in this directory path (e.g. "src/core")')
        })
    },
    async ({ project_dir, name, exclude, include_tests, code_only, context, in: inPath }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const excludeArr = include_tests ? parseExclude(exclude) : addTestExclusions(parseExclude(exclude));
            const result = index.usages(name, {
                exclude: excludeArr,
                codeOnly: code_only || false,
                context: context || 0,
                in: inPath
            });
            return toolResult(output.formatUsages(result, name));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_deadcode ---
server.registerTool(
    'ucn_deadcode',
    {
        description: 'Find dead code: functions and classes with zero callers anywhere in the project. Use during cleanup to identify code that can be safely deleted. By default excludes exported symbols (they may be used externally), decorated/annotated symbols (likely framework-registered), and test files. Use include flags to expand results.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            include_exported: z.boolean().optional().describe('Include exported symbols (excluded by default)'),
            include_decorated: z.boolean().optional().describe('Include decorated/annotated symbols like @router.get, @Bean (excluded by default as they are typically framework-registered)'),
            include_tests: includeTestsParam
        })
    },
    async ({ project_dir, include_exported, include_decorated, include_tests }) => {
        try {
            const index = getIndex(project_dir);
            const result = index.deadcode({
                includeExported: include_exported || false,
                includeDecorated: include_decorated || false,
                includeTests: include_tests || false
            });
            return toolResult(output.formatDeadcode(result, {
                decoratedHint: !include_decorated && result.excludedDecorated > 0 ? `${result.excludedDecorated} decorated/annotated symbol(s) hidden (framework-registered). Use include_decorated=true to include them.` : undefined,
                exportedHint: !include_exported && result.excludedExported > 0 ? `${result.excludedExported} exported symbol(s) hidden. Use include_exported=true to include them.` : undefined
            }));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_fn ---
server.registerTool(
    'ucn_fn',
    {
        description: "Extract just one function's source code. Use instead of reading an entire file when you only need a specific function — avoids pulling thousands of irrelevant lines. Use file parameter to disambiguate when multiple functions share the same name (e.g. file='parser' to get the one in parser.js).",
        inputSchema: z.object({
            project_dir: projectDirParam,
            name: nameParam,
            file: fileParam
        })
    },
    async ({ project_dir, name, file }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const matches = index.find(name, { file }).filter(m => m.type === 'function' || m.params !== undefined);

            if (matches.length === 0) {
                return toolResult(`Function "${name}" not found.`);
            }

            const match = matches.length > 1 ? pickBestDefinition(matches) : matches[0];
            const code = fs.readFileSync(match.file, 'utf-8');
            const codeLines = code.split('\n');
            const fnCode = codeLines.slice(match.startLine - 1, match.endLine).join('\n');

            let note = '';
            if (matches.length > 1 && !file) {
                note = `Note: Found ${matches.length} definitions for "${name}". Showing ${match.relativePath}:${match.startLine}. Use file parameter to disambiguate.\n\n`;
            }

            return toolResult(note + output.formatFn(match, fnCode));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_class ---
server.registerTool(
    'ucn_class',
    {
        description: 'Extract a single class, struct, or interface with all its methods. Use instead of reading an entire file when you only need one class definition. Handles all supported types: JS/TS classes, Python classes, Go structs, Rust structs/traits, Java classes/interfaces.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            name: nameParam,
            file: fileParam,
            max_lines: z.number().optional().describe('Maximum lines of source to show. If omitted, large classes (>200 lines) show a summary instead of full source.')
        })
    },
    async ({ project_dir, name, file, max_lines }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const matches = index.find(name, { file }).filter(m =>
                ['class', 'interface', 'type', 'enum', 'struct', 'trait'].includes(m.type)
            );

            if (matches.length === 0) {
                return toolResult(`Class "${name}" not found.`);
            }

            const match = matches.length > 1 ? pickBestDefinition(matches) : matches[0];

            // Use index data directly instead of re-parsing the file
            const code = fs.readFileSync(match.file, 'utf-8');
            const codeLines = code.split('\n');
            const clsCode = codeLines.slice(match.startLine - 1, match.endLine).join('\n');

            let note = '';
            if (matches.length > 1 && !file) {
                note = `Note: Found ${matches.length} definitions for "${name}". Showing ${match.relativePath}:${match.startLine}. Use file parameter to disambiguate.\n\n`;
            }

            const classLineCount = match.endLine - match.startLine + 1;

            // Large class: show summary by default, truncated source with max_lines
            if (classLineCount > 200 && max_lines === undefined) {
                const lines = [];
                lines.push(`${match.relativePath}:${match.startLine}`);
                lines.push(`${output.lineRange(match.startLine, match.endLine)} ${output.formatClassSignature(match)}`);
                lines.push('─'.repeat(60));

                // Show method list from index
                const methods = index.findMethodsForType(match.name);
                if (methods.length > 0) {
                    lines.push(`\nMethods (${methods.length}):`);
                    for (const m of methods) {
                        lines.push(`  ${output.formatFunctionSignature(m)}  [line ${m.startLine}]`);
                    }
                }

                lines.push(`\nClass is ${classLineCount} lines. Use max_lines param to see source, or ucn_fn for individual methods.`);
                return toolResult(note + lines.join('\n'));
            }

            if (max_lines !== undefined && classLineCount > max_lines) {
                const truncatedCode = codeLines.slice(match.startLine - 1, match.startLine - 1 + max_lines).join('\n');
                const result = output.formatClass(match, truncatedCode);
                return toolResult(note + result + `\n\n... showing ${max_lines} of ${classLineCount} lines`);
            }

            return toolResult(note + output.formatClass(match, clsCode));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_verify ---
server.registerTool(
    'ucn_verify',
    {
        description: "Safety check before changing a function signature. Verifies that every call site passes the right number of arguments. Shows valid calls, mismatches, and uncertain cases. Run this before adding/removing parameters to catch breakage early — pair with ucn_plan to preview the refactoring.",
        inputSchema: z.object({
            project_dir: projectDirParam,
            name: nameParam,
            file: fileParam
        })
    },
    async ({ project_dir, name, file }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const result = index.verify(name, { file });
            return toolResult(output.formatVerify(result));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_imports ---
server.registerTool(
    'ucn_imports',
    {
        description: 'List all imports in a file with resolved file paths. Use to understand what a module depends on before modifying or moving it. Resolves relative imports, package imports, and language-specific patterns (Go modules, Rust crate paths, Java packages).',
        inputSchema: z.object({
            project_dir: projectDirParam,
            file: z.string().describe('File path (relative to project root or absolute) to analyze imports for')
        })
    },
    async ({ project_dir, file }) => {
        try {
            const index = getIndex(project_dir);
            const result = index.imports(file);
            return toolResult(output.formatImports(result, file));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_exporters ---
server.registerTool(
    'ucn_exporters',
    {
        description: 'Find every file that imports/depends on a given file. Use before moving, renaming, or deleting a file to see what would break. The reverse of ucn_imports — shows dependents rather than dependencies.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            file: z.string().describe('File path (relative to project root or absolute) to find importers of')
        })
    },
    async ({ project_dir, file }) => {
        try {
            const index = getIndex(project_dir);
            const result = index.exporters(file);
            return toolResult(output.formatExporters(result, file));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_tests ---
server.registerTool(
    'ucn_tests',
    {
        description: 'Find existing tests for a function. Shows which test files cover it, matching test case names, and how the function is called in tests. Use to check test coverage before modifying a function, or to find example test patterns to follow when writing new tests.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            name: nameParam,
            calls_only: z.boolean().optional().describe('Only show direct call and test-case matches, filtering out string references, imports, and other non-invocation mentions')
        })
    },
    async ({ project_dir, name, calls_only }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const result = index.tests(name, { callsOnly: calls_only });
            return toolResult(output.formatTests(result, name));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_related ---
server.registerTool(
    'ucn_related',
    {
        description: 'Find sibling functions that are structurally related: same file, similar names, or shared callers/callees. Use to discover companion functions you might need to update together (e.g., finding serialize when you\'re changing deserialize, or findAll when modifying findOne). Name-based and structural, not semantic.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            name: nameParam,
            file: fileParam
        })
    },
    async ({ project_dir, name, file }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const result = index.related(name, { file });
            return toolResult(output.formatRelated(result));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_graph ---
server.registerTool(
    'ucn_graph',
    {
        description: 'Visualize how files depend on each other through imports/exports. Use to understand module architecture — which files form a cluster, what the dependency chain looks like. Set direction to "imports" (what this file uses), "importers" (who uses this file), or "both". Can be noisy — use depth=1 for large codebases; setting depth also expands all children at each level. For function-level execution flow, use ucn_trace instead.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            file: z.string().describe('File path (relative to project root or absolute) to graph dependencies for'),
            depth: z.number().optional().describe('Maximum graph depth (default: 2)'),
            direction: z.enum(['imports', 'importers', 'both']).optional().describe('Graph direction: imports (what this file uses), importers (who uses this file), both (default: both)')
        })
    },
    async ({ project_dir, file, depth, direction }) => {
        try {
            const index = getIndex(project_dir);
            const result = index.graph(file, { direction: direction || 'both', maxDepth: depth ?? 2 });
            return toolResult(output.formatGraph(result, { showAll: depth !== undefined, file }));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_file_exports ---
server.registerTool(
    'ucn_file_exports',
    {
        description: "Show a file's public API: all exported functions, classes, and variables with their signatures. Use to understand what a module offers before importing from it, or to review the surface area of a file you're about to refactor.",
        inputSchema: z.object({
            project_dir: projectDirParam,
            file: z.string().describe('File path (relative to project root or absolute) to list exports for')
        })
    },
    async ({ project_dir, file }) => {
        try {
            const index = getIndex(project_dir);
            const result = index.fileExports(file);
            return toolResult(output.formatFileExports(result, file));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_search ---
server.registerTool(
    'ucn_search',
    {
        description: 'Plain text search across all project files (like grep, but respects .gitignore and project excludes). Use for non-semantic searches: TODOs, error messages, config keys, string literals. For semantic code queries (callers, usages, definitions), prefer ucn_context/ucn_usages/ucn_find. Set code_only=true to skip matches in comments and strings. Search is case-insensitive by default; set case_sensitive=true for exact case matching.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            term: z.string().describe('Search term (plain text, not regex)'),
            code_only: z.boolean().optional().describe('Exclude matches in comments and strings'),
            context: z.number().optional().describe('Lines of context around each match'),
            case_sensitive: z.boolean().optional().describe('Case-sensitive search (default: false, case-insensitive)')
        })
    },
    async ({ project_dir, term, code_only, context, case_sensitive }) => {
        if (!term || !term.trim()) {
            return toolError('Search term is required.');
        }
        try {
            const index = getIndex(project_dir);
            const result = index.search(term, {
                codeOnly: code_only || false,
                context: context || 0,
                caseSensitive: case_sensitive || false
            });
            return toolResult(output.formatSearch(result, term));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_plan ---
server.registerTool(
    'ucn_plan',
    {
        description: 'Preview a refactoring before doing it. Shows before/after signatures and every call site that needs updating. Supports three operations: add a parameter (with optional default value for backward compatibility), remove a parameter, or rename the function. Pair with ucn_verify to check current state first.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            name: nameParam,
            file: fileParam,
            add_param: z.string().optional().describe('Parameter name to add'),
            remove_param: z.string().optional().describe('Parameter name to remove'),
            rename_to: z.string().optional().describe('New function name'),
            default_value: z.string().optional().describe('Default value for added parameter (makes change backward-compatible)')
        })
    },
    async ({ project_dir, name, file, add_param, remove_param, rename_to, default_value }) => {
        const err = requireName(name);
        if (err) return err;
        if (!add_param && !remove_param && !rename_to) {
            return toolError('Plan requires an operation: add_param, remove_param, or rename_to');
        }
        try {
            const index = getIndex(project_dir);
            const result = index.plan(name, {
                addParam: add_param,
                removeParam: remove_param,
                renameTo: rename_to,
                defaultValue: default_value,
                file
            });
            return toolResult(output.formatPlan(result));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_typedef ---
server.registerTool(
    'ucn_typedef',
    {
        description: 'Find type definitions: interfaces, enums, structs, traits, or type aliases matching a name. Use when you need to see the shape of a type — what fields a struct has, what methods an interface requires, or what values an enum contains.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            name: nameParam
        })
    },
    async ({ project_dir, name }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const result = index.typedef(name);
            return toolResult(output.formatTypedef(result, name));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_stacktrace ---
server.registerTool(
    'ucn_stacktrace',
    {
        description: 'Paste a stack trace and get source code context for each frame. Automatically parses JS, Python, Go, Rust, and Java stack trace formats. Use when debugging an error — shows the relevant code at each level of the call stack without manually opening files.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            stack: z.string().describe('The stack trace text to parse')
        })
    },
    async ({ project_dir, stack }) => {
        if (!stack || !stack.trim()) {
            return toolError('Stack trace text is required.');
        }
        try {
            const index = getIndex(project_dir);
            const result = index.parseStackTrace(stack);
            return toolResult(output.formatStackTrace(result));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_example ---
server.registerTool(
    'ucn_example',
    {
        description: 'Find the best real-world example of how a function is used. Automatically scores all call sites by quality (typed assignments, destructured results, documented calls rank highest) and returns the top one with surrounding code for context. Use when you need to understand the expected calling pattern before using a function yourself.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            name: nameParam
        })
    },
    async ({ project_dir, name }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            return toolResult(output.formatExample(index.example(name), name));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_expand ---
server.registerTool(
    'ucn_expand',
    {
        description: 'Drill into a numbered item from the last ucn_context result. Context returns numbered callers/callees — use this to see the full source code of any one of them without a separate find+read cycle. Must run ucn_context first.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            item: z.number().describe('Item number from ucn_context output (e.g. 1, 2, 3)')
        })
    },
    async ({ project_dir, item }) => {
        try {
            const index = getIndex(project_dir);
            // Look up from the most recent context call for this project
            const recentKey = lastContextKey.get(index.root);
            const recentCache = recentKey ? expandCache.get(recentKey) : null;

            let match = null;
            let cachedItemCount = 0;

            if (recentCache && recentCache.items) {
                // Strict: only expand from the most recent context call
                recentCache.usedAt = Date.now(); // LRU: refresh on access
                cachedItemCount = recentCache.items.length;
                match = recentCache.items.find(i => i.num === item);
            } else {
                // No recent context — fallback to any cached context for this project
                for (const [key, cached] of expandCache) {
                    if (cached.root === index.root && cached.items) {
                        cached.usedAt = Date.now(); // LRU: refresh on access
                        cachedItemCount = Math.max(cachedItemCount, cached.items.length);
                        const found = cached.items.find(i => i.num === item);
                        if (found) { match = found; break; }
                    }
                }
            }

            if (!match && cachedItemCount === 0) {
                return toolError('No expandable items found. Run ucn_context first to get numbered items.');
            }
            if (!match) {
                const scopeHint = recentCache ? ` (from last ucn_context for "${recentCache.symbolName}")` : '';
                return toolError(`Item ${item} not found${scopeHint}. Available items: 1-${cachedItemCount}`);
            }

            const filePath = match.file || (index.root && match.relativePath ? path.join(index.root, match.relativePath) : null);
            if (!filePath || !fs.existsSync(filePath)) {
                return toolError(`Cannot locate file for ${match.name}`);
            }

            const content = fs.readFileSync(filePath, 'utf-8');
            const fileLines = content.split('\n');
            const startLine = match.startLine || match.line || 1;
            const endLine = match.endLine || startLine + 20;

            const lines = [];
            lines.push(`[${match.num}] ${match.name} (${match.type})`);
            lines.push(`${match.relativePath}:${startLine}-${endLine}`);
            lines.push('═'.repeat(60));

            for (let i = startLine - 1; i < Math.min(endLine, fileLines.length); i++) {
                lines.push(fileLines[i]);
            }

            return toolResult(lines.join('\n'));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_lines ---
server.registerTool(
    'ucn_lines',
    {
        description: 'Extract specific lines from a file (e.g., "10-20" or just "15"). Use when you know the exact line range you need — more precise than reading an entire file. File paths can be relative to the project root.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            file: z.string().describe('File path (relative to project root or absolute)'),
            range: z.string().describe('Line range, e.g. "10-20" or "15"')
        })
    },
    async ({ project_dir, file, range }) => {
        if (!range || !range.trim()) {
            return toolError('Line range is required (e.g. "10-20" or "15").');
        }
        try {
            const index = getIndex(project_dir);
            const filePath = index.findFile(file);
            if (!filePath) {
                return toolError(`File not found: ${file}`);
            }

            const parts = range.split('-');
            const start = parseInt(parts[0], 10);
            const end = parts.length > 1 ? parseInt(parts[1], 10) : start;

            if (isNaN(start) || isNaN(end)) {
                return toolError(`Invalid line range: "${range}". Expected format: <start>-<end> or <line>`);
            }
            if (start < 1) {
                return toolError(`Invalid start line: ${start}. Line numbers must be >= 1`);
            }

            const content = fs.readFileSync(filePath, 'utf-8');
            const fileLines = content.split('\n');

            const startLine = Math.min(start, end);
            const endLine = Math.max(start, end);

            if (startLine > fileLines.length) {
                return toolError(`Line ${startLine} is out of bounds. File has ${fileLines.length} lines.`);
            }

            const actualEnd = Math.min(endLine, fileLines.length);
            const lines = [];
            const relPath = path.relative(index.root, filePath);
            lines.push(`${relPath}:${startLine}-${actualEnd}`);
            lines.push('─'.repeat(60));
            for (let i = startLine - 1; i < actualEnd; i++) {
                lines.push(`${output.lineNum(i + 1)} | ${fileLines[i]}`);
            }

            return toolResult(lines.join('\n'));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// ── ucn_api ──────────────────────────────────────────────────────────────────

server.registerTool(
    'ucn_api',
    {
        description: 'List the public API surface of a project or file: all exported/public symbols with signatures. Use to understand what a library exposes before using it. Works best with JS/TS (export), Go (capitalized names), Rust (pub), Java (public). Python requires __all__ — use ucn_toc instead for Python projects without it.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            file: z.string().optional().describe('Optional file path to show exports for (relative to project root)')
        })
    },
    async ({ project_dir, file }) => {
        try {
            const index = getIndex(project_dir);
            const symbols = index.api(file || undefined);
            return toolResult(output.formatApi(symbols, file || '.'));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// ── ucn_stats ────────────────────────────────────────────────────────────────

server.registerTool(
    'ucn_stats',
    {
        description: 'Quick project stats: file counts, symbol counts, lines of code, broken down by language and symbol type. Use for a high-level size check — how big is this codebase, what languages does it use, how many functions/classes exist.',
        inputSchema: z.object({
            project_dir: projectDirParam
        })
    },
    async ({ project_dir }) => {
        try {
            const index = getIndex(project_dir);
            const stats = index.getStats();
            return toolResult(output.formatStats(stats));
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
