/**
 * core/output/shared.js - Shared utility functions used by other formatters
 *
 * KEY PRINCIPLE: Never truncate critical information.
 * Full expressions, full signatures, full context.
 */

const fs = require('fs');
const { langTraits } = require('../../languages');

/**
 * Format dynamic imports note with language-appropriate terminology.
 * Go doesn't have "dynamic imports" — uses "blank/dot imports" instead.
 */
function dynamicImportsNote(count, meta) {
    if (!count) return null;
    if (meta?.projectLanguage && !langTraits(meta.projectLanguage)?.hasDynamicImports) {
        return `${count} blank/dot import(s)`;
    }
    return `${count} dynamic import(s)`;
}

const FILE_ERROR_MESSAGES = {
    'file-not-found': 'File not found in project',
    'file-ambiguous': 'Ambiguous file match'
};

function formatFileError(errorObj, fallbackPath) {
    const msg = FILE_ERROR_MESSAGES[errorObj.error] || errorObj.error;
    const file = errorObj.filePath || fallbackPath || '';
    return `Error: ${msg}: ${file}`;
}

/**
 * Normalize parameters for display
 * Collapses multiline params to single line
 * @param {string} params - Raw params string
 * @returns {string} - Normalized params (NO truncation)
 */
function normalizeParams(params) {
    if (!params || params === '...') return params || '...';
    // Collapse whitespace (newlines, tabs, multiple spaces) to single space
    return params.replace(/\s+/g, ' ').trim();
}

/**
 * Format a line number for display
 * @param {number} line - 1-indexed line number
 * @param {number} width - Padding width
 * @returns {string}
 */
function lineNum(line, width = 4) {
    return String(line).padStart(width);
}

/**
 * Format a line range
 * @param {number} start - 1-indexed start line
 * @param {number} end - 1-indexed end line
 * @returns {string}
 */
function lineRange(start, end) {
    return `[${lineNum(start)}-${lineNum(end)}]`;
}

/**
 * Format a single line location
 * @param {number} line - 1-indexed line number
 * @returns {string}
 */
function lineLoc(line) {
    return `[${lineNum(line)}]`;
}

/**
 * Format function signature for TOC display
 * @param {object} fn - Function definition
 * @returns {string}
 */
function formatFunctionSignature(fn) {
    const prefix = [];

    // Modifiers
    if (fn.modifiers && fn.modifiers.length > 0) {
        prefix.push(fn.modifiers.join(' '));
    }

    // Generator marker
    if (fn.isGenerator) prefix.push('*');

    // Name + generics + params (concatenated without spaces)
    let sig = fn.name;
    if (fn.generics) sig += fn.generics;
    // If paramsStructured + paramTypes are available, render typed params
    const typed = renderTypedParams(fn);
    // When paramsStructured is an empty array, the function has zero params —
    // render `()` rather than the legacy `(...)` placeholder.
    const noParams = Array.isArray(fn.paramsStructured) && fn.paramsStructured.length === 0;
    let paramText;
    if (typed != null) paramText = typed;
    else if (noParams) paramText = '';
    else if (fn.params != null && fn.params !== '...') paramText = normalizeParams(fn.params);
    else paramText = '...';
    sig += `(${paramText})`;

    // Return type (collapse whitespace — multi-line annotations must not break the one-line signature)
    if (fn.returnType) sig += `: ${String(fn.returnType).replace(/\s+/g, ' ').trim()}`;

    // Arrow indicator
    if (fn.isArrow) sig += ' =>';

    if (prefix.length > 0) {
        return prefix.join(' ') + ' ' + sig;
    }
    return sig;
}

/**
 * Render parameters with type annotations when available.
 * Returns null if not enough info — caller falls back to raw params string.
 */
function renderTypedParams(fn) {
    const ps = fn.paramsStructured;
    if (!Array.isArray(ps) || ps.length === 0) return null;
    const paramTypes = fn.paramTypes;
    const hasStructuredTypes = ps.some(p => p && p.type);
    const hasMappedTypes = paramTypes && Object.keys(paramTypes).length > 0;
    if (!hasStructuredTypes && !hasMappedTypes) return null;
    const parts = ps.map(p => {
        if (!p || !p.name) return '';
        let s = p.rest ? `...${p.name.replace(/^\.\.\./, '')}` : p.name;
        const t = p.type || (paramTypes && paramTypes[p.name]);
        if (t) s += `: ${t}`;
        if (p.optional && !p.rest && p.default == null) s += '?';
        if (p.default != null) s += ` = ${p.default}`;
        return s;
    });
    return parts.filter(Boolean).join(', ');
}

/**
 * Format class/type signature for TOC display
 */
function formatClassSignature(cls) {
    const parts = [cls.type, cls.name];

    if (cls.generics) parts.push(cls.generics);
    if (cls.extends) parts.push(`extends ${cls.extends}`);
    if (cls.implements && cls.implements.length > 0) {
        parts.push(`implements ${cls.implements.join(', ')}`);
    }

    return parts.join(' ');
}

/**
 * Format class member for TOC display
 */
function formatMemberSignature(member) {
    const parts = [];

    // Member type (static, get, set, private, etc.)
    if (member.memberType && member.memberType !== 'method') {
        parts.push(member.memberType);
    }

    // Async
    if (member.isAsync) parts.push('async');

    // Generator
    if (member.isGenerator) parts.push('*');

    // Name + Parameters (no space between name and parens)
    if (member.params !== undefined) {
        const params = normalizeParams(member.params);
        parts.push(`${member.name}(${params})`);
    } else {
        parts.push(member.name);
    }

    // Return type
    if (member.returnType) parts.push(`: ${member.returnType}`);

    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Compact display of line numbers, collapsing consecutive ranges
 */
function formatLineRanges(lineNums) {
    if (lineNums.length === 0) return '';
    const sorted = [...lineNums].sort((a, b) => a - b);
    const ranges = [];
    let start = sorted[0], end = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === end + 1) {
            end = sorted[i];
        } else {
            ranges.push(start === end ? `${start}` : `${start}-${end}`);
            start = end = sorted[i];
        }
    }
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
    return ranges.join(', ');
}

/**
 * Detect common double-escaping patterns in regex search terms.
 * When MCP/JSON transport is involved, agents often write \\.  when they mean \. (literal dot).
 * Returns a hint string if double-escaping is suspected, empty string otherwise.
 */
function detectDoubleEscaping(term) {
    // Look for \\. \\d \\w \\s \\b \\D \\W \\S \\B \\( \\) \\[ \\] — common double-escaped sequences
    const doubleEscaped = term.match(/\\\\[.dDwWsSbB()\[\]*+?^${}|]/g);  // eslint-disable-line no-useless-escape
    if (!doubleEscaped) return '';
    const examples = [...new Set(doubleEscaped)].slice(0, 3);
    const fixed = examples.map(e => e.slice(1)); // remove one backslash
    return `\nHint: Pattern contains ${examples.join(', ')} which matches literal backslash(es). If you meant ${fixed.join(', ')}, use a single backslash (MCP/JSON parameters are already raw strings).`;
}

/**
 * Count depth of nested generic brackets.
 */
function countNestedGenerics(str) {
    let maxDepth = 0;
    let depth = 0;
    for (const char of str) {
        if (char === '<') {
            depth++;
            maxDepth = Math.max(maxDepth, depth);
        } else if (char === '>') {
            depth--;
        }
    }
    return maxDepth;
}

/**
 * Compute confidence level for a symbol match.
 * @returns {{ level: 'high'|'medium'|'low', reasons: string[] }}
 */
function computeConfidence(symbol) {
    const reasons = [];
    let score = 100;

    const span = (symbol.endLine || symbol.startLine) - symbol.startLine;
    if (span > 500) {
        score -= 30;
        reasons.push('very long function (>500 lines)');
    } else if (span > 200) {
        score -= 15;
        reasons.push('long function (>200 lines)');
    }

    const params = Array.isArray(symbol.params) ? symbol.params : [];
    const signature = params.map(p => p.type || '').join(' ') + (symbol.returnType || '');
    const genericDepth = countNestedGenerics(signature);
    if (genericDepth > 3) {
        score -= 20;
        reasons.push('complex nested generics');
    } else if (genericDepth > 2) {
        score -= 10;
        reasons.push('nested generics');
    }

    if (symbol.file) {
        try {
            const stats = fs.statSync(symbol.file);
            const sizeKB = stats.size / 1024;
            if (sizeKB > 500) {
                score -= 20;
                reasons.push('very large file (>500KB)');
            } else if (sizeKB > 200) {
                score -= 10;
                reasons.push('large file (>200KB)');
            }
        } catch (e) {
            // Skip file size check on error
        }
    }

    let level = 'high';
    if (score < 50) level = 'low';
    else if (score < 80) level = 'medium';

    return { level, reasons };
}

/**
 * Render a single human-readable line for git enrichment data.
 * Format: `Last modified: <ISO> by <author> · <N> commits in last 30d`
 *
 * Returns null when input is missing or unavailable so callers can decide
 * whether to push it. Used by `about` and `brief` formatters.
 */
function formatGitLine(git) {
    if (!git || !git.available) return null;
    const parts = [];
    if (git.lastModified) parts.push(`Last modified: ${git.lastModified}`);
    if (git.author) parts.push(`by ${git.author}`);
    let line = parts.join(' ');
    if (git.recentChanges != null) {
        const tail = `${git.recentChanges} commit${git.recentChanges === 1 ? '' : 's'} in last 30d`;
        line = line ? `${line} · ${tail}` : tail;
    }
    return line;
}

/**
 * Display label for an unverified-tier entry's reason. Dispatch-tiered
 * entries (nominal languages) carry attribution metadata: the declared
 * supertype the call dispatches through (dispatchVia) and how many
 * same-name definitions the dispatch could land on (dispatchCandidates).
 */
function unverifiedReasonLabel(entry) {
    if (!entry || !entry.reason) return '';
    if (entry.reason === 'possible-dispatch' && entry.externalContract) {
        // External contract (fix #210): the candidate set is open — any
        // external subtype of the contract — so no implementation count.
        return entry.dispatchVia
            ? `possible-dispatch via ${entry.dispatchVia} — external contract`
            : 'possible-dispatch — external contract';
    }
    if (entry.reason === 'possible-dispatch' && entry.dispatchVia) {
        const n = entry.dispatchCandidates;
        return n > 1
            ? `possible-dispatch via ${entry.dispatchVia} — 1 of ${n} implementations`
            : `possible-dispatch via ${entry.dispatchVia}`;
    }
    if (entry.reason === 'method-ambiguous' && entry.dispatchCandidates > 1) {
        return `method-ambiguous — ${entry.dispatchCandidates} same-name definitions`;
    }
    if (entry.reason === 'overload-ambiguous' && entry.dispatchCandidates > 1) {
        return `overload-ambiguous — 1 of ${entry.dispatchCandidates} applicable overloads`;
    }
    return entry.reason;
}

module.exports = {
    dynamicImportsNote,
    formatFileError,
    unverifiedReasonLabel,
    normalizeParams,
    lineNum,
    lineRange,
    lineLoc,
    formatFunctionSignature,
    renderTypedParams,
    formatClassSignature,
    formatMemberSignature,
    formatLineRanges,
    detectDoubleEscaping,
    countNestedGenerics,
    computeConfidence,
    formatGitLine,
};
