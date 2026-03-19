/**
 * core/output/search.js - Text search, structural search, example, typedef, tests formatters
 */

const { detectDoubleEscaping } = require('./shared');

/**
 * Format search command output
 */
function formatSearch(results, term) {
    const meta = results.meta;
    const fallbackNote = meta && meta.regexFallback
        ? `\nNote: Invalid regex (${meta.regexFallback}). Fell back to plain text search.`
        : '';

    const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
    if (totalMatches === 0) {
        if (meta) {
            const scope = meta.filesSkipped > 0
                ? `Searched ${meta.filesScanned} of ${meta.totalFiles} file${meta.totalFiles === 1 ? '' : 's'} (${meta.filesSkipped} excluded by filters).`
                : `Searched ${meta.filesScanned} file${meta.filesScanned === 1 ? '' : 's'}.`;
            const escapingHint = detectDoubleEscaping(term);
            return `No matches found for "${term}". ${scope}${fallbackNote}${escapingHint}`;
        }
        return `No matches found for "${term}"${fallbackNote}`;
    }

    const lines = [];
    const fileWord = results.length === 1 ? 'file' : 'files';
    lines.push(`Found ${totalMatches} match${totalMatches === 1 ? '' : 'es'} for "${term}" in ${results.length} ${fileWord}:`);
    if (fallbackNote) lines.push(fallbackNote.trim());
    lines.push('═'.repeat(60));

    for (const result of results) {
        lines.push(`\n${result.file}`);
        for (const m of result.matches) {
            if (m.before && m.before.length > 0) {
                for (const line of m.before) {
                    lines.push(`      ... ${line.trim()}`);
                }
            }
            lines.push(`  ${m.line}: ${m.content.trim()}`);
            if (m.after && m.after.length > 0) {
                for (const line of m.after) {
                    lines.push(`      ... ${line.trim()}`);
                }
            }
        }
    }

    if (meta && meta.truncatedMatches > 0) {
        lines.push(`\n${results.reduce((s, r) => s + r.matches.length, 0)} shown of ${meta.totalMatches} total matches. Use top= to see more.`);
    }

    if (meta && meta.testsExcluded && meta.filesSkipped > 0) {
        lines.push(`\nNote: ${meta.filesSkipped} test file${meta.filesSkipped === 1 ? '' : 's'} hidden by default (use include_tests=true to include).`);
    }

    return lines.join('\n');
}

/**
 * Format search results as JSON
 */
function formatSearchJson(results, term) {
    const meta = results.meta;
    const obj = {
        term,
        totalMatches: (meta && meta.totalMatches != null) ? meta.totalMatches : results.reduce((sum, r) => sum + r.matches.length, 0),
        files: results.map(r => ({
            file: r.file,
            matchCount: r.matches.length,
            matches: r.matches.map(m => ({
                line: m.line,
                content: m.content  // FULL content
            }))
        }))
    };
    if (meta) {
        obj.filesScanned = meta.filesScanned;
        obj.filesSkipped = meta.filesSkipped;
        obj.totalFiles = meta.totalFiles;
        if (meta.regexFallback) obj.regexFallback = meta.regexFallback;
        if (meta.truncatedMatches > 0) obj.truncatedMatches = meta.truncatedMatches;
    }
    return JSON.stringify(obj, null, 2);
}

/**
 * Format structural search results (index-based queries)
 */
function formatStructuralSearch(result) {
    const { results, meta } = result;
    const lines = [];

    // Build query description
    const parts = [];
    if (meta.query.type) parts.push(`type=${meta.query.type}`);
    if (meta.query.term) parts.push(`name="${meta.query.term}"`);
    if (meta.query.param) parts.push(`param="${meta.query.param}"`);
    if (meta.query.receiver) parts.push(`receiver="${meta.query.receiver}"`);
    if (meta.query.returns) parts.push(`returns="${meta.query.returns}"`);
    if (meta.query.decorator) parts.push(`decorator="${meta.query.decorator}"`);
    if (meta.query.exported) parts.push('exported');
    if (meta.query.unused) parts.push('unused');
    const queryStr = parts.join(', ');

    lines.push(`Structural search: ${queryStr}`);
    lines.push('═'.repeat(60));

    if (results.length === 0) {
        lines.push('No matches found.');
        return lines.join('\n');
    }

    lines.push(`Found ${meta.totalMatched} match${meta.totalMatched === 1 ? '' : 'es'}${meta.shown < meta.totalMatched ? ` (showing ${meta.shown})` : ''}:`);
    lines.push('');

    // Group by file
    let currentFile = null;
    for (const r of results) {
        if (r.file !== currentFile) {
            currentFile = r.file;
            lines.push(`${r.file}`);
        }

        if (r.kind === 'call') {
            lines.push(`  ${r.line}: ${r.name}()${r.isMethod ? ' [method]' : ''}`);
        } else {
            let sig = `  ${r.line}: ${r.kind} ${r.name}`;
            if (r.params) sig += `(${r.params})`;
            if (r.returnType) sig += ` → ${r.returnType}`;
            if (r.className) sig += ` [${r.className}]`;
            if (r.decorators) sig += ` @${r.decorators.join(', @')}`;
            lines.push(sig);
        }
    }

    if (meta.shown < meta.totalMatched) {
        lines.push(`\n${meta.shown} of ${meta.totalMatched} shown. Use top= to see more.`);
    }

    return lines.join('\n');
}

function formatStructuralSearchJson(result) {
    return JSON.stringify(result, null, 2);
}

/**
 * Format example result as text
 */
function formatExample(result, name) {
    if (!result || !result.best) return `No call examples found for "${name}"`;

    const best = result.best;
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
    lines.push(`Score: ${best.score} (${result.totalCalls} total calls)`);
    lines.push(`Why: ${best.reasons.length > 0 ? best.reasons.join(', ') : 'first available call'}`);

    return lines.join('\n');
}

/**
 * Format example command output - JSON
 */
function formatExampleJson(result, name) {
    if (!result || !result.best) {
        return JSON.stringify({ found: false, query: name, error: `No call examples found for "${name}"` }, null, 2);
    }

    const best = result.best;
    return JSON.stringify({
        found: true,
        query: name,
        totalCalls: result.totalCalls,
        best: {
            file: best.relativePath || best.file,
            line: best.line,
            content: best.content,
            score: best.score,
            reasons: best.reasons || [],
            ...(best.before && best.before.length > 0 && { before: best.before }),
            ...(best.after && best.after.length > 0 && { after: best.after })
        }
    }, null, 2);
}

/**
 * Format typedef command output - text
 */
function formatTypedef(types, name) {
    const lines = [`Type definitions for "${name}":\n`];

    if (types.length === 0) {
        lines.push('  (none found)');
    } else {
        for (const t of types) {
            lines.push(`${t.relativePath}:${t.startLine}  ${t.type} ${t.name}`);
            if (t.usageCount !== undefined) {
                lines.push(`  (${t.usageCount} usages)`);
            }
            if (t.code) {
                lines.push('');
                lines.push('─── CODE ───');
                lines.push(t.code);
                lines.push('');
            }
        }
    }

    return lines.join('\n');
}

/**
 * Format typedef as JSON
 */
function formatTypedefJson(types, name) {
    return JSON.stringify({
        query: name,
        count: types.length,
        types: types.map(t => ({
            name: t.name,
            type: t.type,
            file: t.relativePath || t.file,
            startLine: t.startLine,
            endLine: t.endLine,
            ...(t.usageCount !== undefined && { usageCount: t.usageCount }),
            ...(t.code && { code: t.code })
        }))
    }, null, 2);
}

/**
 * Format tests command output - text
 */
function formatTests(tests, name) {
    const lines = [`Tests for "${name}":\n`];

    if (tests.length === 0) {
        lines.push('  (no tests found)');
    } else {
        const totalMatches = tests.reduce((sum, t) => sum + t.matches.length, 0);
        lines.push(`Found ${totalMatches} matches in ${tests.length} test file(s):\n`);

        for (const testFile of tests) {
            lines.push(testFile.file);
            for (const match of testFile.matches) {
                const typeLabel = match.matchType === 'test-case' ? '[test]' :
                    match.matchType === 'import' ? '[import]' :
                    match.matchType === 'call' ? '[call]' :
                    match.matchType === 'string-ref' ? '[string]' : '[ref]';
                lines.push(`  ${match.line}: ${typeLabel} ${match.content}`);
            }
            lines.push('');
        }
    }

    return lines.join('\n');
}

/**
 * Format tests as JSON
 */
function formatTestsJson(tests, name) {
    return JSON.stringify({
        query: name,
        testFileCount: tests.length,
        totalMatches: tests.reduce((sum, t) => sum + t.matches.length, 0),
        testFiles: tests
    }, null, 2);
}

module.exports = {
    formatSearch,
    formatSearchJson,
    formatStructuralSearch,
    formatStructuralSearchJson,
    formatExample,
    formatExampleJson,
    formatTypedef,
    formatTypedefJson,
    formatTests,
    formatTestsJson,
};
