/**
 * core/output/brief.js — Formatter for `brief`.
 */

'use strict';

const { renderTypedParams } = require('./shared');

/**
 * Build a typed signature line for a callable symbol.
 * Falls back to the raw `params` string when no type info is available.
 */
function signatureLine(sym) {
    const parts = [];
    if (sym.modifiers && sym.modifiers.length) parts.push(sym.modifiers.join(' '));
    let sig = sym.name;
    const typed = renderTypedParams(sym);
    // If we have a structured-params array of length 0, the function has no params.
    // Render `()` rather than the legacy `(...)` placeholder.
    const noParams = Array.isArray(sym.paramsStructured) && sym.paramsStructured.length === 0;
    let paramText;
    if (typed != null) paramText = typed;
    else if (noParams) paramText = '';
    else if (sym.params != null && sym.params !== '...') paramText = sym.params;
    else paramText = '...';
    sig += `(${paramText})`;
    if (sym.returnType) sig += `: ${sym.returnType}`;
    parts.push(sig);
    return parts.join(' ');
}

/**
 * Format a brief result for human/agent consumption.
 *
 * Example output:
 *   resolveSymbol(name: string, options: object = {}): {def, definitions, warnings}
 *     core/project.js:808-936  (129 lines)
 *     "Resolve a symbol name to the best matching definition."
 *     async: no, side_effects: [fs], complexity: branches=12, depth=3
 */
function formatBrief(result) {
    if (!result) return 'Symbol not found.';
    const lines = [];
    const sym = result.symbol || {};

    if (result.kind === 'type') {
        lines.push(`${sym.type} ${sym.name}`);
        const lineLabel = `${result.lineCount} line${result.lineCount === 1 ? '' : 's'}`;
        const memberPart = result.memberCount > 0
            ? `, ${result.memberCount} member${result.memberCount === 1 ? '' : 's'}`
            : '';
        lines.push(`  ${sym.file}:${sym.startLine}-${sym.endLine}  (${lineLabel}${memberPart})`);
        if (sym.handle) lines.push(`  handle: ${sym.handle}`);
        if (sym.docstring) lines.push(`  "${sym.docstring}"`);
        return lines.join('\n');
    }

    // Header line: signature
    lines.push(signatureLine(sym));
    // Location + line count
    lines.push(`  ${sym.file}:${sym.startLine}-${sym.endLine}  (${result.lineCount || 0} line${result.lineCount === 1 ? '' : 's'})`);
    if (sym.handle) lines.push(`  handle: ${sym.handle}`);
    if (sym.docstring) lines.push(`  "${sym.docstring}"`);
    if (sym.className) lines.push(`  in class ${sym.className}`);

    // Async/generator/decorators
    const flags = [];
    flags.push(`async: ${result.isAsync ? 'yes' : 'no'}`);
    if (result.isGenerator) flags.push('generator: yes');
    if (sym.decorators && sym.decorators.length) flags.push(`decorators: [${sym.decorators.join(', ')}]`);

    // Side effects
    const se = (result.sideEffects && result.sideEffects.length) ? result.sideEffects : ['none'];
    flags.push(`side_effects: [${se.join(', ')}]`);

    // Complexity
    const c = result.complexity || {};
    const cParts = [];
    if (c.branches != null) cParts.push(`branches=${c.branches}`);
    if (c.maxDepth != null) cParts.push(`depth=${c.maxDepth}`);
    flags.push(`complexity: ${cParts.join(', ')}`);

    lines.push('  ' + flags.join('  |  '));
    if (result.error) lines.push(`  Note: ${result.error}`);
    return lines.join('\n');
}

function formatBriefJson(result) {
    if (!result) return JSON.stringify({ found: false, error: 'Symbol not found' }, null, 2);
    return JSON.stringify({ found: true, ...result }, null, 2);
}

module.exports = {
    formatBrief,
    formatBriefJson,
};
