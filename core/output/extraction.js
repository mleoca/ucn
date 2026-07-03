/**
 * core/output/extraction.js - Code extraction formatters (fn, class, lines)
 */

const {
    lineNum,
    lineRange,
    formatFunctionSignature,
    formatClassSignature,
} = require('./shared');

/**
 * Format fn command output
 */
function formatFn(match, fnCode) {
    const lines = [];
    lines.push(`${match.relativePath}:${match.startLine}`);
    // Class attribution: three same-name `clear` methods under --all were
    // indistinguishable without their owning class (fix #248).
    const sig = formatFunctionSignature(match);
    const attributed = match.className && !sig.includes(`${match.className}.`)
        ? `${match.className}.${sig}`
        : sig;
    lines.push(`${lineRange(match.startLine, match.endLine)} ${attributed}`);
    lines.push('─'.repeat(60));
    lines.push(fnCode);
    return lines.join('\n');
}

/**
 * Format class command output
 */
function formatClass(cls, clsCode) {
    const lines = [];
    lines.push(`${cls.relativePath || cls.file}:${cls.startLine}`);
    lines.push(`${lineRange(cls.startLine, cls.endLine)} ${formatClassSignature(cls)}`);
    lines.push('─'.repeat(60));
    lines.push(clsCode);
    return lines.join('\n');
}

/**
 * Format extracted function as JSON
 */
function formatFunctionJson(fn, code) {
    return JSON.stringify({
        name: fn.name,
        params: fn.params,  // FULL params
        paramsStructured: fn.paramsStructured || [],
        startLine: fn.startLine,
        endLine: fn.endLine,
        // Location + class attribution (fix #248: single-entry fn --json
        // said neither WHERE the function lives nor WHOSE method it is).
        file: fn.relativePath || fn.file,
        ...(fn.className && { className: fn.className }),
        modifiers: fn.modifiers || [],
        ...(fn.returnType && { returnType: fn.returnType }),
        ...(fn.paramTypes && { paramTypes: fn.paramTypes }),
        ...(fn.generics && { generics: fn.generics }),
        ...(fn.docstring && { docstring: fn.docstring }),
        ...(fn.isArrow && { isArrow: true }),
        ...(fn.isGenerator && { isGenerator: true }),
        code  // FULL code
    }, null, 2);
}

/**
 * Format fn handler result (from execute.js).
 * Notes are NOT included — surfaces render those separately (e.g. stderr for CLI).
 * @param {{ entries: Array<{match, code}>, notes: string[] }} result
 */
function formatFnResult(result) {
    const parts = [];
    for (const { match, code } of result.entries) {
        parts.push(formatFn(match, code));
    }
    const separator = result.entries.length > 1 ? '\n\n' + '═'.repeat(60) + '\n\n' : '';
    return parts.join(separator);
}

/**
 * Format fn handler result as JSON.
 */
function formatFnResultJson(result) {
    if (result.entries.length === 1) {
        return formatFunctionJson(result.entries[0].match, result.entries[0].code);
    }
    const arr = result.entries.map(({ match, code }) => ({
        name: match.name,
        params: match.params,
        paramsStructured: match.paramsStructured || [],
        startLine: match.startLine,
        endLine: match.endLine,
        ...(match.className && { className: match.className }),
        modifiers: match.modifiers || [],
        ...(match.returnType && { returnType: match.returnType }),
        ...(match.paramTypes && { paramTypes: match.paramTypes }),
        ...(match.generics && { generics: match.generics }),
        ...(match.docstring && { docstring: match.docstring }),
        ...(match.isArrow && { isArrow: true }),
        ...(match.isGenerator && { isGenerator: true }),
        file: match.relativePath || match.file,
        code,
    }));
    return JSON.stringify(arr, null, 2);
}

/**
 * Format class handler result (from execute.js).
 * @param {{ entries: Array<{match, code, methods?, summaryMode, truncated, totalLines, maxLines?}>, notes: string[] }} result
 */
function formatClassResult(result) {
    const parts = [];
    for (const entry of result.entries) {
        if (entry.summaryMode) {
            // Large class summary
            const lines = [];
            lines.push(`${entry.match.relativePath}:${entry.match.startLine}`);
            lines.push(`${lineRange(entry.match.startLine, entry.match.endLine)} ${formatClassSignature(entry.match)}`);
            lines.push('\u2500'.repeat(60));
            if (entry.methods && entry.methods.length > 0) {
                lines.push(`\nMethods (${entry.methods.length}):`);
                for (const m of entry.methods) {
                    lines.push(`  ${formatFunctionSignature(m)}  [line ${m.startLine}]`);
                }
            }
            lines.push(`\nClass is ${entry.totalLines} lines. Use --max-lines=N to see source, or "fn <method>" for individual methods.`);
            parts.push(lines.join('\n'));
        } else if (entry.truncated) {
            parts.push(formatClass(entry.match, entry.code) + `\n\n... showing ${entry.maxLines} of ${entry.totalLines} lines`);
        } else {
            parts.push(formatClass(entry.match, entry.code));
        }
    }

    return parts.join('\n\n');
}

/**
 * Format class handler result as JSON.
 */
function formatClassResultJson(result) {
    if (result.entries.length === 1) {
        const entry = result.entries[0];
        return JSON.stringify({
            ...entry.match,
            code: entry.code,
            ...(entry.summaryMode && { summaryMode: true }),
            ...(entry.methods && { methods: entry.methods }),
            ...(entry.truncated && { truncated: true }),
            totalLines: entry.totalLines,
        }, null, 2);
    }
    const arr = result.entries.map(entry => ({
        ...entry.match,
        code: entry.code,
        ...(entry.summaryMode && { summaryMode: true }),
        ...(entry.methods && { methods: entry.methods }),
        ...(entry.truncated && { truncated: true }),
        totalLines: entry.totalLines,
    }));
    return JSON.stringify(arr, null, 2);
}

/**
 * Format lines handler result (from execute.js).
 * @param {{ relativePath: string, lines: string[], startLine: number, endLine: number }} result
 */
function formatLines(result) {
    const lines = [];
    lines.push(`${result.relativePath}:${result.startLine}-${result.endLine}`);
    lines.push('\u2500'.repeat(60));
    for (let i = 0; i < result.lines.length; i++) {
        lines.push(`${lineNum(result.startLine + i)} \u2502 ${result.lines[i]}`);
    }
    return lines.join('\n');
}

/**
 * Format lines handler result as JSON.
 */
function formatLinesJson(result) {
    return JSON.stringify({
        file: result.relativePath,
        startLine: result.startLine,
        endLine: result.endLine,
        lines: result.lines,
    }, null, 2);
}

module.exports = {
    formatFn,
    formatClass,
    formatFunctionJson,
    formatFnResult,
    formatFnResultJson,
    formatClassResult,
    formatClassResultJson,
    formatLines,
    formatLinesJson,
};
