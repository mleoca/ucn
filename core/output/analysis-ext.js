/**
 * core/output/analysis-ext.js - Extended analysis formatters (related, smart, diffImpact)
 */

const { dynamicImportsNote, formatLineRanges, unverifiedReasonLabel, advisoryLine } = require('./shared');
const { formatAccountLines, formatCalleeAccountLine, unverifiedCalleeLines } = require('./analysis');

/**
 * Format related command output - text
 */
function formatRelated(related, options = {}) {
    if (!related) {
        return 'Function not found.';
    }

    const lines = [];

    // Header
    lines.push(`Related to ${related.target.name}`);
    lines.push('═'.repeat(60));
    lines.push(`${related.target.file}:${related.target.line}`);
    const relAdvisory = advisoryLine(related.advisory);
    if (relAdvisory) lines.push(relAdvisory);
    lines.push('');

    // Same file (result is already capped by --top at the source; total in
    // sameFileTotal — fix #230)
    let relatedTruncated = false;
    if (related.sameFile.length > 0) {
        const maxSameFile = options.top || (options.all ? Infinity : 8);
        const sameFileTotal = related.sameFileTotal || related.sameFile.length;
        lines.push(`SAME FILE (${sameFileTotal}):`);
        for (const f of related.sameFile.slice(0, maxSameFile)) {
            const params = f.params ? `(${f.params})` : '';
            lines.push(`  :${f.line} ${f.name}${params}`);
        }
        const shown = Math.min(related.sameFile.length, maxSameFile);
        if (sameFileTotal > shown) {
            relatedTruncated = true;
            lines.push(`  ... and ${sameFileTotal - shown} more`);
        }
        lines.push('');
    }

    // Similar names
    if (related.similarNames.length > 0) {
        const similarTotal = related.similarNamesTotal || related.similarNames.length;
        const similarLabel = similarTotal > related.similarNames.length
            ? `${related.similarNames.length} of ${similarTotal}` : `${related.similarNames.length}`;
        lines.push(`SIMILAR NAMES (${similarLabel}):`);
        for (const s of related.similarNames) {
            lines.push(`  ${s.name} - ${s.file}:${s.line}`);
            lines.push(`    shared: ${s.sharedParts.join(', ')}`);
        }
        if (similarTotal > related.similarNames.length) relatedTruncated = true;
        lines.push('');
    }

    // Shared callers
    if (related.sharedCallers.length > 0) {
        const callersTotal = related.sharedCallersTotal || related.sharedCallers.length;
        const callersLabel = callersTotal > related.sharedCallers.length
            ? `${related.sharedCallers.length} of ${callersTotal}` : `${related.sharedCallers.length}`;
        lines.push(`CALLED BY SAME FUNCTIONS (${callersLabel}):`);
        for (const s of related.sharedCallers) {
            lines.push(`  ${s.name} - ${s.file}:${s.line} (${s.sharedCallerCount} shared callers)`);
        }
        if (callersTotal > related.sharedCallers.length) relatedTruncated = true;
        lines.push('');
    }

    // Shared callees
    if (related.sharedCallees.length > 0) {
        const calleesTotal = related.sharedCalleesTotal || related.sharedCallees.length;
        const calleesLabel = calleesTotal > related.sharedCallees.length
            ? `${related.sharedCallees.length} of ${calleesTotal}` : `${related.sharedCallees.length}`;
        lines.push(`CALLS SAME FUNCTIONS (${calleesLabel}):`);
        for (const s of related.sharedCallees) {
            lines.push(`  ${s.name} - ${s.file}:${s.line} (${s.sharedCalleeCount} shared callees)`);
        }
        if (calleesTotal > related.sharedCallees.length) relatedTruncated = true;
    }

    if (relatedTruncated) {
        const allHint = options.allHint || 'Use --all to show all.';
        lines.push(`\nSome sections truncated. ${allHint}`);
    }

    return lines.join('\n');
}

/**
 * Format related command output - JSON
 */
function formatRelatedJson(related) {
    if (!related) {
        return JSON.stringify({ found: false, error: 'Function not found' }, null, 2);
    }
    return JSON.stringify(related, null, 2);
}

/**
 * Format smart command output
 * @param {object} smart - Smart extraction result
 * @param {object} [options] - Formatting options
 * @param {string} [options.uncertainHint] - Custom hint for uncertain calls
 */
function formatSmart(smart, options = {}) {
    if (!smart) return 'Function not found.';

    const lines = [];
    // Project-relative path in the header, like every other command (fix #230
    // — the absolute def.file leaked here).
    lines.push(`${smart.target.name} (${smart.target.relativePath || smart.target.file}:${smart.target.startLine})`);
    lines.push('═'.repeat(60));

    if (smart.meta) {
        const notes = [];
        if (smart.meta.dynamicImports) { const dn = dynamicImportsNote(smart.meta.dynamicImports, smart.meta); if (dn) notes.push(dn); }
        if (smart.meta.uncertain) notes.push(`${smart.meta.uncertain} uncertain call(s) skipped`);
        if (notes.length) {
            const uncertainSuffix = smart.meta.uncertain && options.uncertainHint ? ` — ${options.uncertainHint}` : '';
            lines.push(`  Note: ${notes.join(', ')}${uncertainSuffix}`);
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

    // v4 callee contract: unresolved calls inside the target — visible with
    // reasons (they may be dependencies smart could not inline).
    lines.push(...unverifiedCalleeLines(smart.unverifiedCallees, false));
    const smartCalleeAcct = formatCalleeAccountLine(smart.meta && smart.meta.calleeAccount);
    if (smartCalleeAcct) lines.push(`\n${smartCalleeAcct}`);

    return lines.join('\n');
}

/**
 * Format smart extraction result as JSON
 * Includes function + all dependencies
 */
function formatSmartJson(result) {
    if (!result) return JSON.stringify({ found: false, error: 'Function not found' }, null, 2);
    const meta = result.meta || { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0 };
    return JSON.stringify({
        meta,
        data: {
            target: {
                name: result.target.name,
                file: result.target.file,
                startLine: result.target.startLine,
                endLine: result.target.endLine,
                params: result.target.params,
                returnType: result.target.returnType,
                code: result.target.code
            },
            dependencies: result.dependencies.map(d => ({
                name: d.name,
                type: d.type,
                file: d.file,
                startLine: d.startLine,
                endLine: d.endLine,
                params: d.params,
                weight: d.weight,  // core, setup, utility
                callCount: d.callCount,
                code: d.code
            })),
            types: result.types || [],
            // v4 callee contract: visible unresolved-call entries, reconciled
            // by meta.calleeAccount.
            unverifiedCallees: result.unverifiedCallees || []
        }
    });
}

/**
 * Format diff impact command output - text
 */
function formatDiffImpact(result, options = {}) {
    if (!result) return 'No diff data.';

    const lines = [];
    const MAX_CALLERS_PER_FN = options.all ? Infinity : 30;

    lines.push(`Diff Impact Analysis (vs ${result.base})`);
    lines.push('═'.repeat(60));

    const s = result.summary || {};
    const parts = [];
    if (s.modifiedFunctions > 0) parts.push(`${s.modifiedFunctions} modified`);
    if (s.deletedFunctions > 0) parts.push(`${s.deletedFunctions} deleted`);
    if (s.newFunctions > 0) parts.push(`${s.newFunctions} new`);
    parts.push(`${s.totalCallSites || 0} call sites across ${s.affectedFiles || 0} files`);
    if (s.unverifiedCallSites > 0) parts.push(`${s.unverifiedCallSites} unverified`);
    lines.push(parts.join(', '));
    lines.push('');

    // Modified functions
    if (result.functions.length > 0) {
        lines.push('MODIFIED FUNCTIONS:');
        for (const fn of result.functions) {
            lines.push(`\n  ${fn.name}`);
            lines.push(`  ${fn.relativePath}:${fn.startLine}`);
            lines.push(`  ${fn.signature}`);
            if (fn.addedLines.length > 0) {
                lines.push(`  Lines added: ${formatLineRanges(fn.addedLines)}`);
            }
            if (fn.deletedLines.length > 0) {
                lines.push(`  Lines deleted: ${formatLineRanges(fn.deletedLines)}`);
            }

            if (fn.callers.length > 0) {
                const displayCallers = fn.callers.slice(0, MAX_CALLERS_PER_FN);
                const truncated = fn.callers.length - displayCallers.length;
                lines.push(`  Callers (${fn.callers.length}):`);
                for (const c of displayCallers) {
                    const caller = c.callerName ? `[${c.callerName}]` : '';
                    lines.push(`    ${c.relativePath}:${c.line} ${caller}`);
                    lines.push(`      ${c.content}`);
                }
                if (truncated > 0) {
                    lines.push(`    ... ${truncated} more callers (use file= to scope diff to specific files, or use impact with class_name= for type-filtered results)`);
                }
            } else {
                lines.push('  Callers: none confirmed');
            }

            // Unverified tier: visible one-liners with reasons (never silently dropped)
            const unverified = fn.unverifiedCallers || [];
            if (unverified.length > 0) {
                const cap = options.all ? Infinity : 10;
                lines.push(`  Unverified call sites (${unverified.length}) — call syntax, no binding/receiver evidence:`);
                for (const u of unverified.slice(0, cap)) {
                    const caller = u.callerName ? ` [${u.callerName}]` : '';
                    const reason = u.reason ? ` (${unverifiedReasonLabel(u)})` : '';
                    const expr = u.content ? `: ${u.content.replace(/\s+/g, ' ').slice(0, 100)}` : '';
                    lines.push(`    ${u.relativePath}:${u.line}${caller}${expr}${reason}`);
                }
                if (unverified.length > cap) {
                    lines.push(`    (+${unverified.length - cap} more unverified)`);
                }
            }

            // Conservation contract lines, indented inside the function block
            for (const al of formatAccountLines(fn.account)) {
                lines.push(`  ${al}`);
            }
        }
    }

    // New functions
    if (result.newFunctions.length > 0) {
        lines.push('\nNEW FUNCTIONS:');
        for (const fn of result.newFunctions) {
            lines.push(`  ${fn.name} — ${fn.relativePath}:${fn.startLine}`);
            lines.push(`  ${fn.signature}`);
        }
    }

    // Deleted functions — with any call sites that still reference the name
    // (likely breaks; name-level candidates, the definition is gone)
    if (result.deletedFunctions.length > 0) {
        lines.push('\nDELETED FUNCTIONS:');
        for (const fn of result.deletedFunctions) {
            lines.push(`  ${fn.name} — ${fn.relativePath}:${fn.startLine}`);
            const remaining = fn.remainingCallSites || [];
            if (remaining.length > 0) {
                lines.push(`  ⚠ still called from ${remaining.length} site(s) — name-level matches:`);
                for (const site of remaining.slice(0, 10)) {
                    lines.push(`    ${site.relativePath}:${site.line}  ${site.content}`);
                }
                if (remaining.length > 10) {
                    lines.push(`    ... and ${remaining.length - 10} more`);
                }
            }
        }
    }

    // Module-level changes
    if (result.moduleLevelChanges.length > 0) {
        lines.push('\nMODULE-LEVEL CHANGES:');
        for (const m of result.moduleLevelChanges) {
            const changeParts = [];
            if (m.addedLines.length > 0) changeParts.push(`+${m.addedLines.length} lines`);
            if (m.deletedLines.length > 0) changeParts.push(`-${m.deletedLines.length} lines`);
            lines.push(`  ${m.relativePath}: ${changeParts.join(', ')}`);
        }
    }

    return lines.join('\n');
}

function formatDiffImpactJson(result) {
    // Standard {meta, data} envelope (fix #230 — diff-impact was one of
    // three commands still emitting a bare result object). Per-symbol
    // accounts stay on each entry inside data; meta carries the aggregate
    // completeness signal.
    return JSON.stringify({
        meta: {
            complete: (result?.summary?.unverifiedCallSites || 0) === 0,
            unverified: result?.summary?.unverifiedCallSites || 0,
        },
        data: result,
    }, null, 2);
}

module.exports = {
    formatRelated,
    formatRelatedJson,
    formatSmart,
    formatSmartJson,
    formatDiffImpact,
    formatDiffImpactJson,
};
