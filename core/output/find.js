/**
 * core/output/find.js - Find/usages/symbol lookup formatters
 */

const fs = require('fs');
const {
    formatFunctionSignature,
    formatClassSignature,
    computeConfidence,
} = require('./shared');

const { formatSymbolHandle } = require('../shared');

/**
 * Trim a docstring to a single short sentence (max 80 chars) for inline display.
 */
function firstSentenceShort(text) {
    if (!text) return null;
    const trimmed = text.trim();
    const m = trimmed.match(/^(.+?[.!?])(?:\s|$)/);
    let s = m ? m[1] : trimmed;
    if (s.length > 80) s = s.slice(0, 77) + '...';
    return s;
}

/**
 * Format find command output
 */
function formatFind(symbols, query, top) {
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
            ? formatFunctionSignature(s)
            : formatClassSignature(s);
        lines.push(`${s.relativePath}:${s.startLine}  ${sig}`);
        if (s.docstring) {
            const snip = firstSentenceShort(s.docstring);
            if (snip) lines.push(`  "${snip}"`);
        }
        if (s.usageCounts !== undefined) {
            const c = s.usageCounts;
            const parts = [];
            if (c.calls > 0) parts.push(`${c.calls} calls`);
            if (c.definitions > 0) parts.push(`${c.definitions} def`);
            if (c.imports > 0) parts.push(`${c.imports} imports`);
            if (c.references > 0) parts.push(`${c.references} refs`);
            lines.push(parts.length > 0
                ? `  (${c.total} usages: ${parts.join(', ')})`
                : `  (${c.total} usages)`);
        } else if (s.usageCount !== undefined) {
            lines.push(`  (${s.usageCount} usages)`);
        }
    }

    if (hidden > 0) {
        lines.push(`... ${hidden} more result(s).`);
    }

    return lines.join('\n');
}

function formatFindJson(items) {
    const { formatSymbolHandle } = require('../shared');
    return JSON.stringify({
        meta: { command: 'find', count: items.length },
        data: items.map(m => ({
            name: m.name,
            type: m.type,
            file: m.relativePath || m.file,
            line: m.startLine,
            endLine: m.endLine,
            handle: formatSymbolHandle(m),
            ...(m.className && { className: m.className }),
            ...(m.receiver && { receiver: m.receiver }),
        })),
    }, null, 2);
}

/**
 * Format find results with depth/confidence features (detailed view).
 * Returns a string. Used by CLI and interactive mode.
 *
 * @param {Array} symbols - Find result array
 * @param {string} query - Original search query
 * @param {object} options - { depth, top, all }
 */
function formatFindDetailed(symbols, query, options = {}) {
    const { top, all, compact } = options;
    // Surfaces pass validated NUMBERS; the string comparisons below made
    // --depth 0/2 dead code everywhere (fix #250). Normalize once.
    const depth = options.depth != null ? String(options.depth) : undefined;
    const DEFAULT_LIMIT = 5;

    if (symbols.length === 0) {
        return `No symbols found for "${query}"`;
    }

    const lines = [];
    const limit = all ? symbols.length : (top > 0 ? top : DEFAULT_LIMIT);
    const showing = Math.min(limit, symbols.length);
    const hidden = symbols.length - showing;

    if (hidden > 0) {
        lines.push(`Found ${symbols.length} match(es) for "${query}" (showing top ${showing}):`);
    } else {
        lines.push(`Found ${symbols.length} match(es) for "${query}":`);
    }
    if (!compact) lines.push('─'.repeat(60));

    for (let i = 0; i < showing; i++) {
        const s = symbols[i];
        // Depth 0: just location
        if (depth === '0') {
            lines.push(`${s.relativePath}:${s.startLine}`);
            continue;
        }

        // Depth 1 (default): location + signature
        const sig = s.params !== undefined
            ? formatFunctionSignature(s)
            : formatClassSignature(s);

        const confidence = computeConfidence(s);
        const confStr = confidence.level !== 'high' ? ` [${confidence.level}]` : '';
        const handle = formatSymbolHandle(s);
        const loc = handle || (s.relativePath + ':' + s.startLine);

        if (compact) {
            // One line per result: "<handle>  <sig>  <usages?>  <doc snippet?>"
            const parts = [`${loc}  ${sig}${confStr}`];
            if (s.usageCounts !== undefined && s.usageCounts.total > 0) {
                parts.push(`(${s.usageCounts.total} usages)`);
            } else if (s.usageCount !== undefined) {
                parts.push(`(${s.usageCount} usages)`);
            }
            if (s.docstring) {
                const snip = firstSentenceShort(s.docstring);
                if (snip) parts.push(`— ${snip}`);
            }
            lines.push(parts.join('  '));
            continue;
        }

        lines.push(`${loc}  ${sig}${confStr}`);
        if (s.docstring) {
            const snip = firstSentenceShort(s.docstring);
            if (snip) lines.push(`  "${snip}"`);
        }
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

        if (confidence.level !== 'high' && confidence.reasons.length > 0) {
            lines.push(`  ⚠ ${confidence.reasons.join(', ')}`);
        }

        // Depth 2: + first 10 lines of code
        if (depth === '2' || depth === 'full') {
            try {
                const content = fs.readFileSync(s.file, 'utf-8');
                const fileLines = content.split('\n');
                const maxLines = depth === 'full' ? (s.endLine - s.startLine + 1) : 10;
                const endLine = Math.min(s.startLine + maxLines - 1, s.endLine);
                lines.push('  ───');
                for (let j = s.startLine - 1; j < endLine; j++) {
                    lines.push(`  ${fileLines[j]}`);
                }
                if (depth === '2' && s.endLine > endLine) {
                    lines.push(`  ... (${s.endLine - endLine} more lines)`);
                }
            } catch (e) {
                // Skip code extraction on error
            }
        }
        if (!compact) lines.push('');
    }

    if (hidden > 0) {
        lines.push(`... ${hidden} more result(s). Use --all to see all, or --top=N to see more.`);
    }

    return lines.join('\n');
}

/**
 * Format symbol search results as JSON
 */
function formatSymbolJson(symbols, query) {
    const { formatSymbolHandle } = require('../shared');
    return JSON.stringify({
        meta: { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0 },
        data: {
            query,
            count: symbols.length,
            results: symbols.map(s => ({
                name: s.name,
                type: s.type,
                file: s.relativePath || s.file,
                startLine: s.startLine,
                endLine: s.endLine,
                handle: formatSymbolHandle(s),
                ...(s.params && { params: s.params }),  // FULL params
                ...(s.paramsStructured && { paramsStructured: s.paramsStructured }),
                ...(s.returnType && { returnType: s.returnType }),
                ...(s.paramTypes && { paramTypes: s.paramTypes }),
                ...(s.docstring && { docstring: s.docstring }),
                ...(s.modifiers && { modifiers: s.modifiers }),
                ...(s.usageCount !== undefined && { usageCount: s.usageCount }),
                ...(s.usageCounts !== undefined && { usageCounts: s.usageCounts })
            }))
        }
    });
}

/**
 * Format usages as JSON - FULL expressions, never truncated
 */
function formatUsagesJson(usages, name) {
    const { formatSymbolHandle } = require('../shared');
    const definitions = usages.filter(u => u.isDefinition);
    const refs = usages.filter(u => !u.isDefinition);

    const calls = refs.filter(u => u.usageType === 'call');
    const imports = refs.filter(u => u.usageType === 'import');
    // Exhaustive complement (fix #241): a non-definition record that is
    // neither call nor import lands in references — same-name definer sites
    // (usageType 'definition', isDefinition false: shadowing locals, other
    // defs of the name) used to inflate totals while rendering in NO band.
    const references = refs.filter(u => u.usageType !== 'call' && u.usageType !== 'import');

    // Each usage record points at a call site. We emit a per-occurrence handle
    // pointing at the SITE itself in the form "relativePath:line:callerName"
    // (or "relativePath:line:_topLevel" when the call is at module scope and has
    // no enclosing function). When the enclosing function position is known, we
    // also emit `enclosingHandle` as a jump-back target to the function head.
    const formatUsage = (u) => {
        const file = u.relativePath || u.file;
        const callerToken = u.callerName || '_topLevel';
        const handle = `${file}:${u.line}:${callerToken}`;
        const enclosingHandle = (u.callerStartLine && u.callerName)
            ? `${file}:${u.callerStartLine}:${u.callerName}`
            : undefined;
        return {
            file,
            line: u.line,
            handle,
            ...(enclosingHandle && { enclosingHandle }),
            expression: u.content,  // FULL expression - key improvement
            ...(u.args && { args: u.args }),  // Parsed arguments
            ...(u.before && u.before.length > 0 && { before: u.before }),
            ...(u.after && u.after.length > 0 && { after: u.after })
        };
    };

    // Full-set counts under --limit (fix #237) — listed entries stay truncated.
    const sc = usages.summaryCounts;
    return JSON.stringify({
        meta: { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0 },
        data: {
            symbol: name,
            definitionCount: sc ? sc.definitions : definitions.length,
            callCount: sc ? sc.calls : calls.length,
            importCount: sc ? sc.imports : imports.length,
            referenceCount: sc ? sc.references : references.length,
            totalUsages: sc ? (sc.calls + sc.imports + sc.references) : refs.length,
            definitions: definitions.map(d => {
                const handle = formatSymbolHandle({ ...d, name: d.name || name });
                return {
                    file: d.relativePath || d.file,
                    line: d.line,
                    ...(handle && { handle }),
                    signature: d.signature || null,  // FULL signature
                    type: d.type || null,
                    ...(d.returnType && { returnType: d.returnType }),
                    ...(d.docstring && { docstring: d.docstring }),
                    ...(d.before && d.before.length > 0 && { before: d.before }),
                    ...(d.after && d.after.length > 0 && { after: d.after })
                };
            }),
            calls: calls.map(formatUsage),
            imports: imports.map(formatUsage),
            references: references.map(formatUsage)
        }
    });
}

/**
 * Format usages command output
 */
function formatUsages(usages, name, options = {}) {
    const compact = !!options.compact;
    const defs = usages.filter(u => u.isDefinition);
    const calls = usages.filter(u => u.usageType === 'call');
    const imports = usages.filter(u => u.usageType === 'import');
    // Exhaustive complement (fix #241) — see formatUsagesJson.
    const refs = usages.filter(u => !u.isDefinition && u.usageType !== 'call' && u.usageType !== 'import');

    // Under --limit the listed entries are truncated but the summary must
    // describe the FULL result set (fix #237) — the handler attaches the
    // full counts as a non-enumerable property.
    const sc = usages.summaryCounts;
    const lines = [];
    lines.push(`Usages of "${name}": ${sc ? sc.definitions : defs.length} definitions, ${sc ? sc.calls : calls.length} calls, ${sc ? sc.imports : imports.length} imports, ${sc ? sc.references : refs.length} references`);
    if (!compact) lines.push('═'.repeat(60));

    function renderContextLines(usage) {
        if (usage.before && usage.before.length > 0) {
            for (const line of usage.before) {
                lines.push(`      ${line}`);
            }
        }
    }

    function renderAfterLines(usage) {
        if (usage.after && usage.after.length > 0) {
            for (const line of usage.after) {
                lines.push(`      ${line}`);
            }
        }
    }

    if (defs.length > 0) {
        lines.push(`${compact ? '' : '\n'}DEFINITIONS:`);
        for (const d of defs) {
            if (compact) {
                lines.push(`  ${d.relativePath}:${d.line || d.startLine}${d.signature ? '  ' + d.signature : ''}`);
            } else {
                lines.push(`  ${d.relativePath}:${d.line || d.startLine}`);
                if (d.signature) lines.push(`    ${d.signature}`);
            }
        }
    }

    if (calls.length > 0) {
        lines.push(`${compact ? '' : '\n'}CALLS:`);
        for (const c of calls) {
            if (compact) {
                const expr = c.content ? c.content.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
                lines.push(`  ${c.relativePath}:${c.line}: ${expr}`);
            } else {
                lines.push(`  ${c.relativePath}:${c.line}`);
                renderContextLines(c);
                lines.push(`    ${c.content.trim()}`);
                renderAfterLines(c);
            }
        }
    }

    if (imports.length > 0) {
        lines.push(`${compact ? '' : '\n'}IMPORTS:`);
        for (const i of imports) {
            if (compact) {
                const expr = i.content ? i.content.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
                lines.push(`  ${i.relativePath}:${i.line}: ${expr}`);
            } else {
                lines.push(`  ${i.relativePath}:${i.line}`);
                lines.push(`    ${i.content.trim()}`);
            }
        }
    }

    if (refs.length > 0) {
        lines.push(`${compact ? '' : '\n'}REFERENCES:`);
        for (const r of refs) {
            if (compact) {
                const expr = r.content ? r.content.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
                lines.push(`  ${r.relativePath}:${r.line}: ${expr}`);
            } else {
                lines.push(`  ${r.relativePath}:${r.line}`);
                renderContextLines(r);
                lines.push(`    ${r.content.trim()}`);
                renderAfterLines(r);
            }
        }
    }

    return lines.join('\n');
}

/**
 * Format disambiguation prompt - text
 */
function formatDisambiguation(matches, name, command) {
    const lines = [`Multiple matches for "${name}":\n`];

    for (const m of matches) {
        const sig = m.params !== undefined
            ? formatFunctionSignature(m)
            : formatClassSignature(m);
        lines.push(`  ${m.relativePath}:${m.startLine}  ${sig}`);
        if (m.usageCount !== undefined) {
            lines.push(`    (${m.usageCount} usages)`);
        }
    }

    lines.push('');
    lines.push(`Use: ucn . ${command} ${name} --file <pattern>`);

    return lines.join('\n');
}

/**
 * Format disambiguation prompt - JSON
 */
function formatDisambiguationJson(matches, name, command) {
    return JSON.stringify({
        query: name,
        command,
        count: matches.length,
        matches: matches.map(m => ({
            name: m.name,
            type: m.type,
            file: m.relativePath,
            startLine: m.startLine,
            endLine: m.endLine,
            ...(m.params !== undefined && { params: m.params }),
            ...(m.className && { className: m.className }),
            ...(m.usageCount !== undefined && { usageCount: m.usageCount }),
        })),
        hint: `Use: ucn . ${command} ${name} --file <pattern>`
    }, null, 2);
}

module.exports = {
    formatFind,
    formatFindJson,
    formatFindDetailed,
    formatSymbolJson,
    formatUsages,
    formatUsagesJson,
    formatDisambiguation,
    formatDisambiguationJson,
};
