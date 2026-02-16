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
        // Clear expandCache entries for this project — stale after rebuild
        for (const [key, val] of expandCache) {
            if (val.root === root) expandCache.delete(key);
        }
        lastContextKey.delete(root);
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
        return { content: [{ type: 'text', text: cleanCut + '\n\n... (output truncated — refine query or use file/in/exclude parameters to narrow scope)' }] };
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
// CONSOLIDATED TOOL REGISTRATION
// ============================================================================

const TOOL_DESCRIPTION = `Universal Code Navigator powered by tree-sitter ASTs. Analyzes code structure — functions, callers, callees, dependencies — across JavaScript/TypeScript, Python, Go, Rust, and Java. Use instead of grep/read for code relationships.

QUICK GUIDE — choosing the right command:
  Understand a symbol → about (everything), context (callers/callees only), smart (code + deps inline)
  Before modifying    → impact (all call sites with args), verify (signature check), plan (preview refactor)
  Execution flow      → trace (function call tree) or graph (file imports/exports)
  Find code           → find (by name), search (by text), toc (project overview)
  Extract code        → fn, class, lines (avoid reading whole files)

Commands:

UNDERSTANDING CODE:
- about <name>: Definition, source, callers, callees, and tests — everything in one call. Replaces 3-4 grep+read cycles. Your first stop for any function or class.
- context <name>: Who calls it and what does it call, without source code. Results are numbered for use with expand. For classes/structs, shows all methods instead.
- impact <name>: Every call site with actual arguments passed, grouped by file. Essential before changing a function signature — shows exactly what breaks.
- smart <name>: Get a function's source with all helper functions expanded inline. Use to understand or modify a function and its dependencies in one read.
- trace <name>: Call tree from a function downward. Use to understand "what happens when X runs" — maps which modules a pipeline touches without reading files. Set depth (default: 3); setting depth expands all children.
- example <name>: Best real-world usage example. Automatically scores call sites by quality and returns the top one with context. Use to understand expected calling patterns.
- related <name>: Sibling functions: same file, similar names, or shared callers/callees. Find companions to update together (e.g., serialize when you're changing deserialize). Name-based, not semantic.

FINDING CODE:
- find <name>: Locate definitions ranked by usage count. Use when you know the name but not the file.
- usages <name>: See every usage organized by type: definitions, calls, imports, references. Complete picture of how something is used. Use code_only=true to skip comments/strings.
- toc: Get a quick overview of a project you haven't seen before — file counts, line counts, function/class counts, entry points. Use detailed=true for full symbol listing.
- search <term>: Plain text search (like grep, respects .gitignore). For TODOs, error messages, config keys. Search is case-insensitive by default; set case_sensitive=true for exact case.
- tests <name>: Find test files covering a function, test case names, and how it's called in tests. Use before modifying or to find test patterns to follow.
- deadcode: Find dead code: functions/classes with zero callers. Use during cleanup to identify safely deletable code. Excludes exported, decorated, and test symbols by default — use include_exported/include_decorated/include_tests to expand.

EXTRACTING CODE (use instead of reading entire files):
- fn <name>: Extract one function's source. Use file to disambiguate (e.g. file="parser" for parser.js).
- class <name>: Extract a class/struct/interface with all its methods. Handles all supported types: JS/TS, Python, Go, Rust, Java. Large classes (>200 lines) show summary; use max_lines for truncated source.
- lines: Extract specific lines (e.g. range="10-20" or just "15"). Requires file and range. Use when you know the exact line range you need.
- expand <item>: Drill into a numbered item from the last context result. Context returns numbered callers/callees — use this to see their full source code.

FILE DEPENDENCIES (require file param):
- imports: All imports with resolved file paths. Use to understand dependencies before modifying or moving a file. Resolves relative, package, and language-specific patterns.
- exporters: Every file that imports/depends on this file — shows dependents rather than dependencies. Use before moving, renaming, or deleting.
- file_exports: File's public API: all exported functions, classes, variables with signatures. Use to understand what a module offers before importing.
- graph: File-level dependency tree. Use to understand module architecture — which files form a cluster, what the dependency chain looks like. Set direction ("imports"/"importers"/"both"). Can be noisy — use depth=1 for large codebases.

REFACTORING:
- verify <name>: Check all call sites match function signature (argument count). Run before adding/removing parameters to catch breakage early.
- plan <name>: Preview refactoring: before/after signatures and call sites needing updates. Use add_param (with optional default_value), remove_param, or rename_to. Pair with verify.
- diff_impact: Which functions changed in git diff and who calls them. Use to understand impact of recent changes before committing or reviewing. Use base, staged, or file params to scope.

OTHER:
- typedef <name>: Find type definitions matching a name: interfaces, enums, structs, traits, type aliases. See field shapes, required methods, or enum values.
- stacktrace: Parse a stack trace, show source context per frame. Requires stack param. Handles JS, Python, Go, Rust, Java formats.
- api: Public API surface of project or file: all exported/public symbols with signatures. Use to understand what a library exposes. Pass file to scope to one file. Python needs __all__; use toc instead.
- stats: Quick project stats: file counts, symbol counts, lines of code by language and symbol type.`;

server.registerTool(
    'ucn',
    {
        description: TOOL_DESCRIPTION,
        inputSchema: z.object({
            command: z.enum([
                'about', 'context', 'impact', 'smart', 'trace',
                'find', 'usages', 'fn', 'class', 'example',
                'related', 'tests', 'verify', 'plan', 'typedef',
                'expand', 'toc', 'search', 'deadcode',
                'imports', 'exporters', 'file_exports', 'graph', 'lines',
                'api', 'stats', 'diff_impact', 'stacktrace'
            ]),
            project_dir: z.string().describe('Absolute or relative path to the project root directory'),
            name: z.string().optional().describe('Symbol name to analyze (function, class, method, etc.)'),
            file: z.string().optional().describe('File path (imports/exporters/graph/file_exports/lines/api/diff_impact) or filter pattern for disambiguation (e.g. "parser", "src/core")'),
            exclude: z.string().optional().describe('Comma-separated patterns to exclude (e.g. "test,mock,vendor")'),
            include_tests: z.boolean().optional().describe('Include test files in results (excluded by default)'),
            include_methods: z.boolean().optional().describe('Include obj.method() calls (default: true for about/trace)'),
            include_uncertain: z.boolean().optional().describe('Include uncertain/ambiguous matches'),
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
            term: z.string().optional().describe('Search term (plain text, not regex)'),
            add_param: z.string().optional().describe('Parameter name to add (plan command)'),
            remove_param: z.string().optional().describe('Parameter name to remove (plan command)'),
            rename_to: z.string().optional().describe('New function name (plan command)'),
            default_value: z.string().optional().describe('Default value for added parameter (plan command)'),
            stack: z.string().optional().describe('The stack trace text to parse (stacktrace command)'),
            item: z.number().optional().describe('Item number from context output to expand (e.g. 1, 2, 3)'),
            range: z.string().optional().describe('Line range to extract, e.g. "10-20" or "15" (lines command)'),
            base: z.string().optional().describe('Git ref to diff against (default: HEAD). E.g. "HEAD~3", "main", a commit SHA'),
            staged: z.boolean().optional().describe('Analyze staged changes (diff_impact command)'),
            case_sensitive: z.boolean().optional().describe('Case-sensitive search (default: false, case-insensitive)')
        })
    },
    async (args) => {
        const { command, project_dir, name, file, exclude, include_tests,
                include_methods, include_uncertain, with_types, detailed,
                exact, in: inPath, top, depth, code_only, context: ctxLines,
                include_exported, include_decorated, calls_only, max_lines,
                direction, term, add_param, remove_param, rename_to,
                default_value, stack, item, range, base, staged,
                case_sensitive } = args;

        try {
            switch (command) {

            // ==================================================================
            // UNDERSTANDING CODE
            // ==================================================================

            case 'about': {
                const err = requireName(name);
                if (err) return err;
                const index = getIndex(project_dir);
                const result = index.about(name, { file, exclude: parseExclude(exclude), withTypes: with_types || false, includeMethods: include_methods ?? undefined, maxCallers: top, maxCallees: top });
                return toolResult(output.formatAbout(result, {
                    allHint: 'Repeat with top set higher to show all.',
                    methodsHint: 'Note: obj.method() callers/callees excluded. Use include_methods=true to include them.'
                }));
            }

            case 'context': {
                const err = requireName(name);
                if (err) return err;
                const index = getIndex(project_dir);
                const ctx = index.context(name, {
                    includeMethods: include_methods,
                    includeUncertain: include_uncertain || false,
                    file,
                    exclude: parseExclude(exclude)
                });
                const { text, expandable } = output.formatContext(ctx, {
                    expandHint: 'Use expand command with item number to see code for any item.'
                });
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
            }

            case 'impact': {
                const err = requireName(name);
                if (err) return err;
                const index = getIndex(project_dir);
                const result = index.impact(name, { file, exclude: parseExclude(exclude) });
                return toolResult(output.formatImpact(result));
            }

            case 'smart': {
                const err = requireName(name);
                if (err) return err;
                const index = getIndex(project_dir);
                const result = index.smart(name, {
                    file,
                    withTypes: with_types || false,
                    includeMethods: include_methods,
                    includeUncertain: include_uncertain || false
                });
                return toolResult(output.formatSmart(result));
            }

            case 'trace': {
                const err = requireName(name);
                if (err) return err;
                const index = getIndex(project_dir);
                const result = index.trace(name, { depth: depth ?? 3, file, all: depth !== undefined, includeMethods: include_methods, includeUncertain: include_uncertain || false });
                return toolResult(output.formatTrace(result, {
                    allHint: 'Set depth to expand all children.',
                    methodsHint: 'Note: obj.method() calls excluded. Use include_methods=true to include them.'
                }));
            }

            case 'example': {
                const err = requireName(name);
                if (err) return err;
                const index = getIndex(project_dir);
                return toolResult(output.formatExample(index.example(name), name));
            }

            case 'related': {
                const err = requireName(name);
                if (err) return err;
                const index = getIndex(project_dir);
                const result = index.related(name, { file, all: top !== undefined });
                return toolResult(output.formatRelated(result, {
                    showAll: top !== undefined,
                    allHint: 'Repeat with top set higher to show all.'
                }));
            }

            // ==================================================================
            // FINDING CODE
            // ==================================================================

            case 'find': {
                const err = requireName(name);
                if (err) return err;
                const index = getIndex(project_dir);
                const excludeArr = include_tests ? parseExclude(exclude) : addTestExclusions(parseExclude(exclude));
                const found = index.find(name, { file, exclude: excludeArr, exact: exact || false, in: inPath });
                return toolResult(output.formatFind(found, name, top));
            }

            case 'usages': {
                const err = requireName(name);
                if (err) return err;
                const index = getIndex(project_dir);
                const excludeArr = include_tests ? parseExclude(exclude) : addTestExclusions(parseExclude(exclude));
                const result = index.usages(name, {
                    exclude: excludeArr,
                    codeOnly: code_only || false,
                    context: ctxLines || 0,
                    in: inPath
                });
                return toolResult(output.formatUsages(result, name));
            }

            case 'toc': {
                const index = getIndex(project_dir);
                const toc = index.getToc({ detailed: detailed || false });
                return toolResult(output.formatToc(toc));
            }

            case 'search': {
                if (!term || !term.trim()) {
                    return toolError('Search term is required.');
                }
                const index = getIndex(project_dir);
                const result = index.search(term, {
                    codeOnly: code_only || false,
                    context: ctxLines || 0,
                    caseSensitive: case_sensitive || false
                });
                return toolResult(output.formatSearch(result, term));
            }

            case 'tests': {
                const err = requireName(name);
                if (err) return err;
                const index = getIndex(project_dir);
                const result = index.tests(name, { callsOnly: calls_only });
                return toolResult(output.formatTests(result, name));
            }

            case 'deadcode': {
                const index = getIndex(project_dir);
                const result = index.deadcode({
                    exclude: parseExclude(exclude),
                    in: inPath || undefined,
                    includeExported: include_exported || false,
                    includeDecorated: include_decorated || false,
                    includeTests: include_tests || false
                });
                return toolResult(output.formatDeadcode(result, {
                    decoratedHint: !include_decorated && result.excludedDecorated > 0 ? `${result.excludedDecorated} decorated/annotated symbol(s) hidden (framework-registered). Use include_decorated=true to include them.` : undefined,
                    exportedHint: !include_exported && result.excludedExported > 0 ? `${result.excludedExported} exported symbol(s) hidden. Use include_exported=true to include them.` : undefined
                }));
            }

            // ==================================================================
            // EXTRACTING CODE
            // ==================================================================

            case 'fn': {
                const err = requireName(name);
                if (err) return err;
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
            }

            case 'class': {
                const err = requireName(name);
                if (err) return err;
                const index = getIndex(project_dir);
                const matches = index.find(name, { file }).filter(m =>
                    ['class', 'interface', 'type', 'enum', 'struct', 'trait'].includes(m.type)
                );

                if (matches.length === 0) {
                    return toolResult(`Class "${name}" not found.`);
                }

                const match = matches.length > 1 ? pickBestDefinition(matches) : matches[0];

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
                    lines.push('\u2500'.repeat(60));

                    const methods = index.findMethodsForType(match.name);
                    if (methods.length > 0) {
                        lines.push(`\nMethods (${methods.length}):`);
                        for (const m of methods) {
                            lines.push(`  ${output.formatFunctionSignature(m)}  [line ${m.startLine}]`);
                        }
                    }

                    lines.push(`\nClass is ${classLineCount} lines. Use max_lines param to see source, or fn command for individual methods.`);
                    return toolResult(note + lines.join('\n'));
                }

                if (max_lines !== undefined && classLineCount > max_lines) {
                    const truncatedCode = codeLines.slice(match.startLine - 1, match.startLine - 1 + max_lines).join('\n');
                    const result = output.formatClass(match, truncatedCode);
                    return toolResult(note + result + `\n\n... showing ${max_lines} of ${classLineCount} lines`);
                }

                return toolResult(note + output.formatClass(match, clsCode));
            }

            case 'lines': {
                if (!file) {
                    return toolError('File parameter is required for lines command.');
                }
                if (!range || !range.trim()) {
                    return toolError('Line range is required (e.g. "10-20" or "15").');
                }
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
                lines.push('\u2500'.repeat(60));
                for (let i = startLine - 1; i < actualEnd; i++) {
                    lines.push(`${output.lineNum(i + 1)} | ${fileLines[i]}`);
                }

                return toolResult(lines.join('\n'));
            }

            case 'expand': {
                if (item === undefined || item === null) {
                    return toolError('Item number is required (e.g. item=1).');
                }
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
                    return toolError('No expandable items found. Run context command first to get numbered items.');
                }
                if (!match) {
                    const scopeHint = recentCache ? ` (from last context for "${recentCache.symbolName}")` : '';
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
                lines.push('\u2550'.repeat(60));

                for (let i = startLine - 1; i < Math.min(endLine, fileLines.length); i++) {
                    lines.push(fileLines[i]);
                }

                return toolResult(lines.join('\n'));
            }

            // ==================================================================
            // FILE DEPENDENCIES
            // ==================================================================

            case 'imports': {
                if (!file) {
                    return toolError('File parameter is required for imports command.');
                }
                const index = getIndex(project_dir);
                const result = index.imports(file);
                return toolResult(output.formatImports(result, file));
            }

            case 'exporters': {
                if (!file) {
                    return toolError('File parameter is required for exporters command.');
                }
                const index = getIndex(project_dir);
                const result = index.exporters(file);
                return toolResult(output.formatExporters(result, file));
            }

            case 'file_exports': {
                if (!file) {
                    return toolError('File parameter is required for file_exports command.');
                }
                const index = getIndex(project_dir);
                const result = index.fileExports(file);
                return toolResult(output.formatFileExports(result, file));
            }

            case 'graph': {
                if (!file) {
                    return toolError('File parameter is required for graph command.');
                }
                const index = getIndex(project_dir);
                const result = index.graph(file, { direction: direction || 'both', maxDepth: depth ?? 2 });
                return toolResult(output.formatGraph(result, {
                    showAll: depth !== undefined,
                    file,
                    depthHint: 'Set depth parameter for deeper graph.',
                    allHint: 'Set depth to expand all children.'
                }));
            }

            // ==================================================================
            // REFACTORING
            // ==================================================================

            case 'verify': {
                const err = requireName(name);
                if (err) return err;
                const index = getIndex(project_dir);
                const result = index.verify(name, { file });
                return toolResult(output.formatVerify(result));
            }

            case 'plan': {
                const err = requireName(name);
                if (err) return err;
                if (!add_param && !remove_param && !rename_to) {
                    return toolError('Plan requires an operation: add_param, remove_param, or rename_to');
                }
                const index = getIndex(project_dir);
                const result = index.plan(name, {
                    addParam: add_param,
                    removeParam: remove_param,
                    renameTo: rename_to,
                    defaultValue: default_value,
                    file
                });
                return toolResult(output.formatPlan(result));
            }

            case 'diff_impact': {
                const index = getIndex(project_dir);
                const result = index.diffImpact({
                    base: base || 'HEAD',
                    staged: staged || false,
                    file: file || undefined
                });
                return toolResult(output.formatDiffImpact(result));
            }

            // ==================================================================
            // OTHER
            // ==================================================================

            case 'typedef': {
                const err = requireName(name);
                if (err) return err;
                const index = getIndex(project_dir);
                const result = index.typedef(name);
                return toolResult(output.formatTypedef(result, name));
            }

            case 'stacktrace': {
                if (!stack || !stack.trim()) {
                    return toolError('Stack trace text is required.');
                }
                const index = getIndex(project_dir);
                const result = index.parseStackTrace(stack);
                return toolResult(output.formatStackTrace(result));
            }

            case 'api': {
                const index = getIndex(project_dir);
                const symbols = index.api(file || undefined);
                return toolResult(output.formatApi(symbols, file || '.'));
            }

            case 'stats': {
                const index = getIndex(project_dir);
                const stats = index.getStats();
                return toolResult(output.formatStats(stats));
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
