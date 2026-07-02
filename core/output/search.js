/**
 * core/output/search.js - Text search, structural search, example, typedef, tests formatters
 */

const { detectDoubleEscaping, advisoryLine } = require('./shared');

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
    // MEDIUM-8: when only test-file callers exist and the user didn't ask
    // for them, surface that fact explicitly instead of saying nothing was
    // found.
    if (result && !result.best && result.excludedTestCalls > 0) {
        const n = result.excludedTestCalls;
        return `No call examples found for "${name}" (excluded ${n} test-file usage${n === 1 ? '' : 's'} — pass --include-tests to include them)`;
    }
    if (!result || !result.best) return `No call examples found for "${name}"`;

    // Diverse mode: render one block per cluster representative.
    if (result.clusters && result.clusters.length > 0) {
        return formatExampleDiverse(result, name);
    }

    const best = result.best;
    const lines = [];
    lines.push(`Best example of "${name}":`);
    lines.push('═'.repeat(60));
    lines.push(`${best.relativePath}:${best.line}`);
    const exAdvisory = advisoryLine(result.advisory);
    if (exAdvisory) lines.push(exAdvisory);
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
 * Render `example --diverse` output: one representative per call-shape cluster.
 * Each block shows the shape signature, cluster size, and the representative
 * with code context — so an agent can see "calls fall into N distinct shapes,
 * here's an example of each".
 */
function formatExampleDiverse(result, name) {
    const lines = [];
    const total = result.totalClusters || result.clusters.length;
    lines.push(`Diverse examples of "${name}" — ${result.clusters.length} of ${total} cluster(s), ${result.totalCalls} total calls:`);
    lines.push('═'.repeat(60));
    const divAdvisory = advisoryLine(result.advisory);
    if (divAdvisory) lines.push(divAdvisory);

    for (let i = 0; i < result.clusters.length; i++) {
        const c = result.clusters[i];
        const rep = c.representative;
        const shape = c.argKinds == null
            ? 'unknown shape'
            : c.argKinds.length === 0
                ? 'no arguments'
                : `args: (${c.argKinds.join(', ')})`;

        lines.push('');
        lines.push(`[${i + 1}] ${shape}  — ${c.count} call${c.count === 1 ? '' : 's'} in this cluster`);
        if (!rep) continue;
        lines.push(`    ${rep.relativePath || rep.file}:${rep.line}`);

        if (rep.before) {
            for (let j = 0; j < rep.before.length; j++) {
                const ln = rep.line - rep.before.length + j;
                lines.push(`    ${ln.toString().padStart(4)}| ${rep.before[j]}`);
            }
        }
        lines.push(`    ${rep.line.toString().padStart(4)}| ${rep.content}  <--`);
        if (rep.after) {
            for (let j = 0; j < rep.after.length; j++) {
                const ln = rep.line + j + 1;
                lines.push(`    ${ln.toString().padStart(4)}| ${rep.after[j]}`);
            }
        }
    }

    if (total > result.clusters.length) {
        lines.push('');
        lines.push(`... ${total - result.clusters.length} more cluster(s) (use --top=N to show more)`);
    }

    return lines.join('\n');
}

/**
 * Format example command output - JSON
 */
function formatExampleJson(result, name) {
    if (!result || !result.best) {
        // Surface the excluded-test-usages count in JSON too (fix #237 — the
        // handler note that used to carry it duplicated the text body).
        const excluded = result?.excludedTestCalls || 0;
        return JSON.stringify({
            found: false, query: name,
            ...(excluded > 0 && { excludedTestCalls: excluded }),
            error: excluded > 0
                ? `No call examples found for "${name}" (excluded ${excluded} test-file usage${excluded === 1 ? '' : 's'} — pass --include-tests to include them)`
                : `No call examples found for "${name}"`,
        }, null, 2);
    }

    const best = result.best;
    const env = {
        found: true,
        query: name,
        ...(result.advisory && { advisory: result.advisory }),
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
    };

    if (result.clusters && result.clusters.length > 0) {
        env.totalClusters = result.totalClusters;
        env.clusters = result.clusters.map(c => ({
            shapeKey: c.shapeKey,
            argCount: c.argCount,
            argKinds: c.argKinds,
            count: c.count,
            representative: c.representative ? {
                file: c.representative.relativePath || c.representative.file,
                line: c.representative.line,
                content: c.representative.content,
                score: c.representative.score,
                reasons: c.representative.reasons || [],
                ...(c.representative._argTexts && { argTexts: c.representative._argTexts }),
                ...(c.representative.before && c.representative.before.length > 0 && { before: c.representative.before }),
                ...(c.representative.after && c.representative.after.length > 0 && { after: c.representative.after }),
            } : null,
        }));
    }

    return JSON.stringify(env, null, 2);
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
    const { formatSymbolHandle } = require('../shared');
    return JSON.stringify({
        meta: { command: 'typedef', count: types.length },
        data: {
            query: name,
            count: types.length,
            types: types.map(t => {
                const handle = formatSymbolHandle(t);
                return {
                    name: t.name,
                    type: t.type,
                    file: t.relativePath || t.file,
                    startLine: t.startLine,
                    endLine: t.endLine,
                    ...(handle && { handle }),
                    ...(t.docstring && { docstring: t.docstring }),
                    ...(t.usageCount !== undefined && { usageCount: t.usageCount }),
                    ...(t.code && { code: t.code }),
                };
            }),
        },
    }, null, 2);
}

/**
 * Format tests command output - text
 */
function formatTests(tests, name) {
    const lines = [`Tests for "${name}":\n`];

    if (!tests || !Array.isArray(tests) || tests.length === 0) {
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
    const safe = Array.isArray(tests) ? tests : [];
    return JSON.stringify({
        query: name,
        testFileCount: safe.length,
        totalMatches: safe.reduce((sum, t) => sum + (t.matches?.length || 0), 0),
        testFiles: safe
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
