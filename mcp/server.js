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
const { getParser, PARSE_OPTIONS } = require('../languages');
const output = require('../core/output');

// ============================================================================
// INDEX CACHE
// ============================================================================

const indexCache = new Map(); // projectDir → { index, checkedAt }
const expandCache = new Map(); // projectDir → { items, root }
const MAX_CACHE_SIZE = 10;
const STALE_CHECK_INTERVAL = 30000; // 30s

function getIndex(projectDir) {
    const absDir = path.resolve(projectDir);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        throw new Error(`Project directory not found: ${absDir}`);
    }
    const root = findProjectRoot(absDir);
    const cached = indexCache.get(root);

    if (cached && (Date.now() - cached.checkedAt < STALE_CHECK_INTERVAL)) {
        return cached.index;
    }

    if (cached) {
        if (!cached.index.isCacheStale()) {
            cached.checkedAt = Date.now();
            return cached.index;
        }
    }

    // Build new index
    const index = new ProjectIndex(root);
    const loaded = index.loadCache();
    if (loaded && !index.isCacheStale()) {
        // Cache is fresh
    } else {
        index.build(null, { quiet: true });
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
        if (oldestKey) indexCache.delete(oldestKey);
    }

    indexCache.set(root, { index, checkedAt: Date.now() });
    return index;
}

// ============================================================================
// TEXT FORMATTERS (for commands not in core/output.js)
// ============================================================================

function formatTocText(toc) {
    const lines = [];
    const t = toc.totals;
    lines.push(`PROJECT: ${t.files} files, ${t.lines} lines`);
    lines.push(`  ${t.functions} functions, ${t.classes} classes, ${t.state} state objects`);

    const meta = toc.meta || {};
    const warnings = [];
    if (meta.dynamicImports) warnings.push(`${meta.dynamicImports} dynamic import(s)`);
    if (meta.uncertain) warnings.push(`${meta.uncertain} uncertain reference(s)`);
    if (warnings.length) {
        lines.push(`  Note: ${warnings.join(', ')}`);
    }

    if (toc.summary) {
        if (toc.summary.topFunctionFiles?.length) {
            const hint = toc.summary.topFunctionFiles.map(f => `${f.file} (${f.functions})`).join(', ');
            lines.push(`  Most functions: ${hint}`);
        }
        if (toc.summary.topLineFiles?.length) {
            const hint = toc.summary.topLineFiles.map(f => `${f.file} (${f.lines})`).join(', ');
            lines.push(`  Largest files: ${hint}`);
        }
        if (toc.summary.entryFiles?.length) {
            lines.push(`  Entry points: ${toc.summary.entryFiles.join(', ')}`);
        }
    }

    lines.push('═'.repeat(60));
    const hasDetail = toc.files.some(f => f.symbols);
    for (const file of toc.files) {
        const parts = [`${file.lines} lines`];
        if (file.functions) parts.push(`${file.functions} fn`);
        if (file.classes) parts.push(`${file.classes} cls`);
        if (file.state) parts.push(`${file.state} state`);

        if (hasDetail) {
            lines.push(`\n${file.file} (${parts.join(', ')})`);
            if (file.symbols) {
                for (const fn of file.symbols.functions) {
                    lines.push(`  ${output.lineRange(fn.startLine, fn.endLine)} ${output.formatFunctionSignature(fn)}`);
                }
                for (const cls of file.symbols.classes) {
                    lines.push(`  ${output.lineRange(cls.startLine, cls.endLine)} ${output.formatClassSignature(cls)}`);
                }
            }
        } else {
            lines.push(`  ${file.file} — ${parts.join(', ')}`);
        }
    }

    if (!hasDetail) {
        lines.push(`\nUse detailed=true to list all functions and classes.`);
    }

    return lines.join('\n');
}

function formatFindText(symbols, query, top) {
    if (symbols.length === 0) {
        return `No symbols found for "${query}"`;
    }

    const lines = [];
    const limit = (top && top > 0) ? Math.min(symbols.length, top) : Math.min(symbols.length, 10);
    const hidden = symbols.length - limit;

    if (hidden > 0) {
        lines.push(`Found ${symbols.length} match(es) for "${query}" (showing top ${limit}):`);
    } else {
        lines.push(`Found ${symbols.length} match(es) for "${query}":`);
    }
    lines.push('─'.repeat(60));

    for (let i = 0; i < limit; i++) {
        const s = symbols[i];
        const sig = s.params !== undefined
            ? output.formatFunctionSignature(s)
            : output.formatClassSignature(s);
        lines.push(`${s.relativePath}:${s.startLine}  ${sig}`);
        if (s.usageCounts !== undefined) {
            const c = s.usageCounts;
            const parts = [];
            if (c.calls > 0) parts.push(`${c.calls} calls`);
            if (c.definitions > 0) parts.push(`${c.definitions} def`);
            if (c.imports > 0) parts.push(`${c.imports} imports`);
            if (c.references > 0) parts.push(`${c.references} refs`);
            lines.push(`  (${c.total} usages: ${parts.join(', ')})`);
        } else if (s.usageCount !== undefined) {
            lines.push(`  (${s.usageCount} usages)`);
        }
    }

    if (hidden > 0) {
        lines.push(`... ${hidden} more result(s).`);
    }

    return lines.join('\n');
}

function formatUsagesText(usages, name) {
    const defs = usages.filter(u => u.isDefinition);
    const calls = usages.filter(u => u.usageType === 'call');
    const imports = usages.filter(u => u.usageType === 'import');
    const refs = usages.filter(u => !u.isDefinition && u.usageType === 'reference');

    const lines = [];
    lines.push(`Usages of "${name}": ${defs.length} definitions, ${calls.length} calls, ${imports.length} imports, ${refs.length} references`);
    lines.push('═'.repeat(60));

    if (defs.length > 0) {
        lines.push('\nDEFINITIONS:');
        for (const d of defs) {
            lines.push(`  ${d.relativePath}:${d.line || d.startLine}`);
            if (d.signature) lines.push(`    ${d.signature}`);
        }
    }

    if (calls.length > 0) {
        lines.push('\nCALLS:');
        for (const c of calls) {
            lines.push(`  ${c.relativePath}:${c.line}`);
            lines.push(`    ${c.content.trim()}`);
        }
    }

    if (imports.length > 0) {
        lines.push('\nIMPORTS:');
        for (const i of imports) {
            lines.push(`  ${i.relativePath}:${i.line}`);
            lines.push(`    ${i.content.trim()}`);
        }
    }

    if (refs.length > 0) {
        lines.push('\nREFERENCES:');
        for (const r of refs) {
            lines.push(`  ${r.relativePath}:${r.line}`);
            lines.push(`    ${r.content.trim()}`);
        }
    }

    return lines.join('\n');
}

function formatContextText(ctx) {
    if (!ctx) return { text: 'Symbol not found.', expandable: [] };

    const lines = [];
    const expandable = [];
    let itemNum = 1;

    // Handle struct/interface types
    if (ctx.type && ['class', 'struct', 'interface', 'type'].includes(ctx.type)) {
        lines.push(`Context for ${ctx.type} ${ctx.name}:`);
        lines.push('═'.repeat(60));

        if (ctx.warnings && ctx.warnings.length > 0) {
            for (const w of ctx.warnings) {
                lines.push(`  Note: ${w.message}`);
            }
        }

        const methods = ctx.methods || [];
        lines.push(`\nMETHODS (${methods.length}):`);
        for (const m of methods) {
            const receiver = m.receiver ? `(${m.receiver}) ` : '';
            const params = m.params || '...';
            const returnType = m.returnType ? `: ${m.returnType}` : '';
            lines.push(`  [${itemNum}] ${receiver}${m.name}(${params})${returnType}`);
            lines.push(`    ${m.file}:${m.line}`);
            expandable.push({
                num: itemNum++,
                type: 'method',
                name: m.name,
                file: m.file,
                relativePath: m.file,
                startLine: m.line,
                endLine: m.endLine || m.line
            });
        }

        const callers = ctx.callers || [];
        lines.push(`\nUSAGES (${callers.length}):`);
        for (const c of callers) {
            const callerName = c.callerName ? ` [${c.callerName}]` : '';
            lines.push(`  [${itemNum}] ${c.relativePath}:${c.line}${callerName}`);
            lines.push(`    ${c.content.trim()}`);
            expandable.push({
                num: itemNum++,
                type: 'caller',
                name: c.callerName || '(module level)',
                file: c.callerFile || c.file,
                relativePath: c.relativePath,
                line: c.line,
                startLine: c.callerStartLine || c.line,
                endLine: c.callerEndLine || c.line
            });
        }

        if (expandable.length > 0) {
            lines.push(`\nUse ucn_expand with item number to see code for any item.`);
        }

        return { text: lines.join('\n'), expandable };
    }

    // Standard function/method context
    lines.push(`Context for ${ctx.function}:`);
    lines.push('═'.repeat(60));

    if (ctx.meta) {
        const notes = [];
        if (ctx.meta.dynamicImports) notes.push(`${ctx.meta.dynamicImports} dynamic import(s)`);
        if (ctx.meta.uncertain) notes.push(`${ctx.meta.uncertain} uncertain call(s) skipped`);
        if (notes.length) {
            lines.push(`  Note: ${notes.join(', ')}`);
        }
    }

    if (ctx.warnings && ctx.warnings.length > 0) {
        for (const w of ctx.warnings) {
            lines.push(`  Note: ${w.message}`);
        }
    }

    const callers = ctx.callers || [];
    lines.push(`\nCALLERS (${callers.length}):`);
    for (const c of callers) {
        const callerName = c.callerName ? ` [${c.callerName}]` : '';
        lines.push(`  [${itemNum}] ${c.relativePath}:${c.line}${callerName}`);
        lines.push(`    ${c.content.trim()}`);
        expandable.push({
            num: itemNum++,
            type: 'caller',
            name: c.callerName || '(module level)',
            file: c.callerFile || c.file,
            relativePath: c.relativePath,
            line: c.line,
            startLine: c.callerStartLine || c.line,
            endLine: c.callerEndLine || c.line
        });
    }

    const callees = ctx.callees || [];
    lines.push(`\nCALLEES (${callees.length}):`);
    for (const c of callees) {
        const weight = c.weight && c.weight !== 'normal' ? ` [${c.weight}]` : '';
        lines.push(`  [${itemNum}] ${c.name}${weight} - ${c.relativePath}:${c.startLine}`);
        expandable.push({
            num: itemNum++,
            type: 'callee',
            name: c.name,
            file: c.file,
            relativePath: c.relativePath,
            startLine: c.startLine,
            endLine: c.endLine
        });
    }

    if (expandable.length > 0) {
        lines.push(`\nUse ucn_expand with item number to see code for any item.`);
    }

    return { text: lines.join('\n'), expandable };
}

function formatSmartText(smart) {
    if (!smart) return 'Function not found.';

    const lines = [];
    lines.push(`${smart.target.name} (${smart.target.file}:${smart.target.startLine})`);
    lines.push('═'.repeat(60));

    if (smart.meta) {
        const notes = [];
        if (smart.meta.dynamicImports) notes.push(`${smart.meta.dynamicImports} dynamic import(s)`);
        if (smart.meta.uncertain) notes.push(`${smart.meta.uncertain} uncertain call(s) skipped`);
        if (notes.length) {
            lines.push(`  Note: ${notes.join(', ')}`);
        }
    }

    lines.push(smart.target.code);

    if (smart.dependencies.length > 0) {
        lines.push('\n─── DEPENDENCIES ───');
        for (const dep of smart.dependencies) {
            const weight = dep.weight && dep.weight !== 'normal' ? ` [${dep.weight}]` : '';
            lines.push(`\n// ${dep.name}${weight} (${dep.relativePath}:${dep.startLine})`);
            lines.push(dep.code);
        }
    }

    if (smart.types && smart.types.length > 0) {
        lines.push('\n─── TYPES ───');
        for (const t of smart.types) {
            lines.push(`\n// ${t.name} (${t.relativePath}:${t.startLine})`);
            lines.push(t.code);
        }
    }

    return lines.join('\n');
}

function formatDeadcodeText(results) {
    if (results.length === 0) return 'No dead code found.';

    const lines = [];
    lines.push(`Dead code: ${results.length} unused symbol(s)\n`);

    let currentFile = null;
    for (const item of results) {
        if (item.file !== currentFile) {
            currentFile = item.file;
            lines.push(item.file);
        }
        const exported = item.isExported ? ' [exported]' : '';
        lines.push(`  ${output.lineRange(item.startLine, item.endLine)} ${item.name} (${item.type})${exported}`);
    }

    return lines.join('\n');
}

function formatFnText(match, fnCode) {
    const lines = [];
    lines.push(`${match.relativePath}:${match.startLine}`);
    lines.push(`${output.lineRange(match.startLine, match.endLine)} ${output.formatFunctionSignature(match)}`);
    lines.push('─'.repeat(60));
    lines.push(fnCode);
    return lines.join('\n');
}

function formatClassText(cls, clsCode) {
    const lines = [];
    lines.push(`${cls.relativePath || cls.file}:${cls.startLine}`);
    lines.push(`${output.lineRange(cls.startLine, cls.endLine)} ${output.formatClassSignature(cls)}`);
    lines.push('─'.repeat(60));
    lines.push(clsCode);
    return lines.join('\n');
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

function formatGraphText(graph, showAll = false) {
    if (graph.nodes.length === 0) return 'File not found.';

    const rootEntry = graph.nodes.find(n => n.file === graph.root);
    const rootRelPath = rootEntry ? rootEntry.relativePath : graph.root;
    const lines = [];
    lines.push(`Dependency graph for ${rootRelPath}`);
    lines.push('═'.repeat(60));

    const printed = new Set();
    const maxChildren = showAll ? Infinity : 8;

    function printNode(file, indent) {
        const fileEntry = graph.nodes.find(n => n.file === file);
        const relPath = fileEntry ? fileEntry.relativePath : file;
        const prefix = indent === 0 ? '' : '  '.repeat(indent - 1) + '├── ';

        if (printed.has(file)) {
            lines.push(`${prefix}${relPath} (circular)`);
            return;
        }
        printed.add(file);
        lines.push(`${prefix}${relPath}`);

        const edges = graph.edges.filter(e => e.from === file);
        const displayEdges = edges.slice(0, maxChildren);
        const hiddenCount = edges.length - displayEdges.length;

        for (const edge of displayEdges) {
            printNode(edge.to, indent + 1);
        }

        if (hiddenCount > 0) {
            lines.push(`${'  '.repeat(indent)}└── ... and ${hiddenCount} more`);
        }
    }

    printNode(graph.root, 0);
    return lines.join('\n');
}

function formatSearchText(results, term) {
    const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
    if (totalMatches === 0) return `No matches found for "${term}"`;

    const lines = [];
    lines.push(`Found ${totalMatches} matches for "${term}" in ${results.length} files:`);
    lines.push('═'.repeat(60));

    for (const result of results) {
        lines.push(`\n${result.file}`);
        for (const m of result.matches) {
            lines.push(`  ${m.line}: ${m.content.trim()}`);
            if (m.before && m.before.length > 0) {
                for (const line of m.before) {
                    lines.push(`      ... ${line.trim()}`);
                }
            }
            if (m.after && m.after.length > 0) {
                for (const line of m.after) {
                    lines.push(`      ... ${line.trim()}`);
                }
            }
        }
    }

    return lines.join('\n');
}

function formatFileExportsText(exports, filePath) {
    if (exports.length === 0) return `No exports found in ${filePath}`;

    const lines = [];
    lines.push(`Exports from ${filePath}:\n`);
    for (const exp of exports) {
        lines.push(`  ${output.lineRange(exp.startLine, exp.endLine)} ${exp.signature || exp.name}`);
    }
    return lines.join('\n');
}

function analyzeCallSiteAST(filePath, lineNum, funcName) {
    const result = {
        isAwait: false,
        isDestructured: false,
        isTypedAssignment: false,
        isInReturn: false,
        isInCatch: false,
        isInConditional: false,
        hasComment: false,
        isStandalone: false
    };

    try {
        const language = detectLanguage(filePath);
        if (!language) return result;

        const parser = getParser(language);
        const content = fs.readFileSync(filePath, 'utf-8');
        const tree = parser.parse(content, undefined, PARSE_OPTIONS);

        const row = lineNum - 1;
        const node = tree.rootNode.descendantForPosition({ row, column: 0 });
        if (!node) return result;

        let current = node;
        let foundCall = false;

        while (current) {
            const type = current.type;

            if (!foundCall && (type === 'call_expression' || type === 'call')) {
                const calleeNode = current.childForFieldName('function') || current.namedChild(0);
                if (calleeNode && calleeNode.text === funcName) {
                    foundCall = true;
                }
            }

            if (foundCall) {
                if (type === 'await_expression') result.isAwait = true;
                if (type === 'variable_declarator' || type === 'assignment_expression') {
                    const parent = current.parent;
                    if (parent && (parent.type === 'lexical_declaration' || parent.type === 'variable_declaration')) {
                        result.isTypedAssignment = true;
                    }
                }
                if (type === 'array_pattern' || type === 'object_pattern') result.isDestructured = true;
                if (type === 'return_statement') result.isInReturn = true;
                if (type === 'catch_clause' || type === 'except_clause') result.isInCatch = true;
                if (type === 'if_statement' || type === 'conditional_expression' || type === 'ternary_expression') result.isInConditional = true;
                if (type === 'expression_statement') result.isStandalone = true;
            }

            current = current.parent;
        }

        const contentLines = content.split('\n');
        if (lineNum > 1) {
            const prevLine = contentLines[lineNum - 2].trim();
            if (prevLine.startsWith('//') || prevLine.startsWith('#') || prevLine.endsWith('*/')) {
                result.hasComment = true;
            }
        }
    } catch (e) {
        // Return default result on error
    }

    return result;
}

function findBestExample(index, name) {
    const usages = index.usages(name, {
        codeOnly: true,
        exclude: ['test', 'spec', '__tests__', '__mocks__', 'fixture', 'mock'],
        context: 5
    });

    const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

    if (calls.length === 0) {
        return `No call examples found for "${name}"`;
    }

    const scored = calls.map(call => {
        let score = 0;
        const reasons = [];
        const line = call.content.trim();

        const astInfo = analyzeCallSiteAST(call.file, call.line, name);

        if (astInfo.isTypedAssignment) { score += 15; reasons.push('typed assignment'); }
        if (astInfo.isInReturn) { score += 10; reasons.push('in return'); }
        if (astInfo.isAwait) { score += 10; reasons.push('async usage'); }
        if (astInfo.isDestructured) { score += 8; reasons.push('destructured'); }
        if (astInfo.isStandalone) { score += 5; reasons.push('standalone'); }
        if (astInfo.hasComment) { score += 3; reasons.push('documented'); }
        if (astInfo.isInCatch) { score -= 5; reasons.push('in catch block'); }
        if (astInfo.isInConditional) { score -= 3; reasons.push('in conditional'); }

        if (score === 0) {
            if (/^(const|let|var|return)\s/.test(line) || /^\w+\s*=/.test(line)) {
                score += 10; reasons.push('return value used');
            }
            if (line.startsWith(name + '(') || /^(const|let|var)\s+\w+\s*=\s*\w*$/.test(line.split(name)[0])) {
                score += 5; reasons.push('clear usage');
            }
        }

        if (call.before && call.before.length > 0) score += 3;
        if (call.after && call.after.length > 0) score += 3;
        if (call.before?.length > 0 && call.after?.length > 0) reasons.push('has context');

        const beforeCall = line.split(name + '(')[0];
        if (!beforeCall.includes('(') || /^\s*(const|let|var|return)?\s*\w+\s*=\s*$/.test(beforeCall)) {
            score += 2;
        }
        if (call.line < 100) score += 1;

        return { ...call, score, reasons };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    const lines = [];
    lines.push(`Best example of "${name}":`);
    lines.push('═'.repeat(60));
    lines.push(`${best.relativePath}:${best.line}`);
    lines.push('');

    if (best.before) {
        for (let i = 0; i < best.before.length; i++) {
            const ln = best.line - best.before.length + i;
            lines.push(`${ln.toString().padStart(4)}| ${best.before[i]}`);
        }
    }

    lines.push(`${best.line.toString().padStart(4)}| ${best.content}  <--`);

    if (best.after) {
        for (let i = 0; i < best.after.length; i++) {
            const ln = best.line + i + 1;
            lines.push(`${ln.toString().padStart(4)}| ${best.after[i]}`);
        }
    }

    lines.push('');
    lines.push(`Score: ${best.score} (${calls.length} total calls)`);
    lines.push(`Why: ${best.reasons.length > 0 ? best.reasons.join(', ') : 'first available call'}`);

    return lines.join('\n');
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
            return toolResult(formatTocText(toc));
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
            return toolResult(formatFindText(found, name, top));
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
            with_types: z.boolean().optional().describe('Include related type definitions in output')
        })
    },
    async ({ project_dir, name, file, with_types }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const result = index.about(name, { file, withTypes: with_types || false });
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
                includeMethods: include_methods || false,
                includeUncertain: include_uncertain || false,
                file
            });
            const { text, expandable } = formatContextText(ctx);
            if (expandable.length > 0) {
                expandCache.set(index.root, { items: expandable, root: index.root });
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
                includeMethods: include_methods || false,
                includeUncertain: include_uncertain || false
            });
            return toolResult(formatSmartText(result));
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
            depth: z.number().optional().describe('Maximum call tree depth (default: 3)')
        })
    },
    async ({ project_dir, name, file, depth }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const result = index.trace(name, { depth: depth ?? 3, file, all: depth !== undefined });
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
            return toolResult(formatUsagesText(result, name));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_deadcode ---
server.registerTool(
    'ucn_deadcode',
    {
        description: 'Find dead code: functions and classes with zero callers anywhere in the project. Use during cleanup to identify code that can be safely deleted. By default excludes exported symbols (they may be used externally) and test files — set include_exported=true to audit everything, or include_tests=true to check test helpers too.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            include_exported: z.boolean().optional().describe('Include exported symbols (excluded by default)'),
            include_tests: includeTestsParam
        })
    },
    async ({ project_dir, include_exported, include_tests }) => {
        try {
            const index = getIndex(project_dir);
            const result = index.deadcode({
                includeExported: include_exported || false,
                includeTests: include_tests || false
            });
            return toolResult(formatDeadcodeText(result));
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

            return toolResult(note + formatFnText(match, fnCode));
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
            file: fileParam
        })
    },
    async ({ project_dir, name, file }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const { extractClass } = require('../core/parser');
            const matches = index.find(name, { file }).filter(m =>
                ['class', 'interface', 'type', 'enum', 'struct', 'trait'].includes(m.type)
            );

            if (matches.length === 0) {
                return toolResult(`Class "${name}" not found.`);
            }

            const match = matches.length > 1 ? pickBestDefinition(matches) : matches[0];
            const code = fs.readFileSync(match.file, 'utf-8');
            const language = detectLanguage(match.file);
            const { cls, code: clsCode } = extractClass(code, language, match.name);

            if (!cls) {
                return toolResult(`Class "${name}" could not be extracted.`);
            }

            let note = '';
            if (matches.length > 1 && !file) {
                note = `Note: Found ${matches.length} definitions for "${name}". Showing ${match.relativePath}:${match.startLine}. Use file parameter to disambiguate.\n\n`;
            }

            return toolResult(note + formatClassText(cls, clsCode));
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
            name: nameParam
        })
    },
    async ({ project_dir, name }) => {
        const err = requireName(name);
        if (err) return err;
        try {
            const index = getIndex(project_dir);
            const result = index.tests(name);
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
            return toolResult(formatGraphText(result, depth !== undefined));
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
            return toolResult(formatFileExportsText(result, file));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

// --- ucn_search ---
server.registerTool(
    'ucn_search',
    {
        description: 'Plain text search across all project files (like grep, but respects .gitignore and project excludes). Use for non-semantic searches: TODOs, error messages, config keys, string literals. For semantic code queries (callers, usages, definitions), prefer ucn_context/ucn_usages/ucn_find. Set code_only=true to skip matches in comments and strings.',
        inputSchema: z.object({
            project_dir: projectDirParam,
            term: z.string().describe('Search term (plain text, not regex)'),
            code_only: z.boolean().optional().describe('Exclude matches in comments and strings'),
            context: z.number().optional().describe('Lines of context around each match')
        })
    },
    async ({ project_dir, term, code_only, context }) => {
        if (!term || !term.trim()) {
            return toolError('Search term is required.');
        }
        try {
            const index = getIndex(project_dir);
            const result = index.search(term, {
                codeOnly: code_only || false,
                context: context || 0
            });
            return toolResult(formatSearchText(result, term));
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
            add_param: z.string().optional().describe('Parameter name to add'),
            remove_param: z.string().optional().describe('Parameter name to remove'),
            rename_to: z.string().optional().describe('New function name'),
            default_value: z.string().optional().describe('Default value for added parameter (makes change backward-compatible)')
        })
    },
    async ({ project_dir, name, add_param, remove_param, rename_to, default_value }) => {
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
                defaultValue: default_value
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
            return toolResult(findBestExample(index, name));
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
            const cached = expandCache.get(index.root);
            if (!cached || !cached.items || cached.items.length === 0) {
                return toolError('No expandable items found. Run ucn_context first to get numbered items.');
            }

            const match = cached.items.find(i => i.num === item);
            if (!match) {
                return toolError(`Item ${item} not found. Available: 1-${cached.items.length}`);
            }

            const filePath = match.file || (cached.root && match.relativePath ? path.join(cached.root, match.relativePath) : null);
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
            return toolResult(formatStatsText(stats));
        } catch (e) {
            return toolError(e.message);
        }
    }
);

function formatStatsText(stats) {
    const lines = [];
    lines.push('PROJECT STATISTICS');
    lines.push('═'.repeat(60));
    lines.push(`Root: ${stats.root}`);
    lines.push(`Files: ${stats.files}`);
    lines.push(`Symbols: ${stats.symbols}`);
    lines.push(`Build time: ${stats.buildTime}ms`);

    lines.push('\nBy Language:');
    for (const [lang, info] of Object.entries(stats.byLanguage)) {
        lines.push(`  ${lang}: ${info.files} files, ${info.lines} lines, ${info.symbols} symbols`);
    }

    lines.push('\nBy Type:');
    for (const [type, count] of Object.entries(stats.byType)) {
        lines.push(`  ${type}: ${count}`);
    }

    return lines.join('\n');
}

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
