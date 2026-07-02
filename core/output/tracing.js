/**
 * core/output/tracing.js - Trace/blast/reverse tree formatters
 *
 * Tree contract rendering: the trunk is confirmed-tier; unverified caller
 * edges render in an UNVERIFIED EDGES section with parent attribution and a
 * reason; unresolved callee calls render as [unverified] leaves under their
 * node; ACCOUNT (root text-ground) and TREE ACCOUNT (interior candidate
 * conservation) lines close the arithmetic.
 */

const { unverifiedReasonLabel } = require('./shared');
const { formatAccountLines } = require('./analysis');

/**
 * Render the caller-direction unverified frontier. Returns true if anything
 * was rendered.
 */
function renderFrontier(lines, frontier, options = {}, expanded = false) {
    if (!frontier || frontier.length === 0) return false;
    lines.push('');
    const suffix = expanded
        ? 'followed (--expand-unverified); downstream nodes are possible impact'
        : 'not expanded; possible additional impact';
    lines.push(`UNVERIFIED EDGES (${frontier.length}) — call syntax, no binding/receiver evidence; ${suffix}:`);
    const cap = options.all ? Infinity : 20;
    let shown = 0;
    for (const f of frontier) {
        if (shown >= cap) break;
        const callerName = f.callerName ? ` [${f.callerName}]` : '';
        const expr = f.content ? `: ${f.content.trim().replace(/\s+/g, ' ').slice(0, 100)}` : '';
        const reason = f.reason ? ` (${unverifiedReasonLabel(f)})` : '';
        lines.push(`  at ${f.atNode.name} (hop ${f.hop}): ${f.relativePath}:${f.line}${callerName}${expr}${reason}`);
        shown++;
    }
    if (frontier.length > shown) {
        lines.push(`  (+${frontier.length - shown} more unverified — use --all)`);
    }
    return true;
}

/** Render a node's unresolved callee calls as [unverified] leaves. */
function renderUnverifiedCallees(lines, node, prefix, isParentLast) {
    if (!node.unverifiedCallees || node.unverifiedCallees.length === 0) return;
    const extension = isParentLast ? '    ' : '│   ';
    for (let i = 0; i < node.unverifiedCallees.length; i++) {
        const u = node.unverifiedCallees[i];
        const isLast = i === node.unverifiedCallees.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const owners = u.ownerCount > 1 ? ` (${u.ownerCount} owners)` : '';
        const linesPart = u.sites && u.sites.length > 0 ? ` L${u.sites.join(',L')}` : '';
        lines.push(`${prefix}${extension}${connector}[unverified] ${u.name} — ${u.reason}${owners}${linesPart}`);
    }
}

/** TREE ACCOUNT line for caller-direction trees. */
function treeAccountLine(ta) {
    if (!ta) return null;
    const reasons = Object.entries(ta.unverifiedByReason || {})
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([r, n]) => `${n} ${r}`).join(', ');
    const excludedReasons = Object.entries(ta.excludedByReason || {})
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([r, n]) => `${n} ${r}`).join(', ');
    let line = `TREE ACCOUNT: ${ta.nodesExpanded} node${ta.nodesExpanded === 1 ? '' : 's'} expanded · ` +
        `${ta.confirmedEdges} confirmed edge${ta.confirmedEdges === 1 ? '' : 's'} · ` +
        `${ta.unverifiedEdges} unverified${reasons ? ` (${reasons})` : ''} · ` +
        `${ta.excludedTotal} excluded${excludedReasons ? ` (${excludedReasons})` : ''}`;
    if (ta.filteredEdges > 0) line += ` · ${ta.filteredEdges} hidden by --exclude`;
    if (ta.depthLimitNodes > 0) line += ` · ${ta.depthLimitNodes} node${ta.depthLimitNodes === 1 ? '' : 's'} at depth limit (callers not searched)`;
    return line;
}

/** CALLEE ACCOUNT rollup line for down-direction trees. */
function calleeAccountLine(ta) {
    if (!ta || !ta.callSites) return null;
    const cs = ta.callSites;
    const reasons = Object.entries(ta.unverifiedByReason || {})
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([r, n]) => `${n} ${r}`).join(', ');
    let line = `CALLEE ACCOUNT: ${ta.nodesExpanded} node${ta.nodesExpanded === 1 ? '' : 's'} expanded · ` +
        `${cs.total} call site${cs.total === 1 ? '' : 's'} = ${cs.confirmed} confirmed + ` +
        `${cs.unverified} unverified${reasons ? ` (${reasons})` : ''} + ` +
        `${cs.external} external/builtin + ${cs.excluded} excluded`;
    if (cs.filtered > 0) line += ` + ${cs.filtered} filtered`;
    return line;
}

/**
 * Format trace command output - text
 * Shows call tree visualization
 */
function formatTrace(trace, options = {}) {
    if (!trace) {
        return 'Function not found.';
    }

    const lines = [];

    // Header
    lines.push(`Call tree for ${trace.root}`);
    lines.push('═'.repeat(60));
    lines.push(`${trace.file}:${trace.line}`);
    lines.push(`Direction: ${trace.direction}, Max depth: ${trace.maxDepth}`);

    if (trace.warnings && trace.warnings.length > 0) {
        for (const w of trace.warnings) {
            lines.push(`Note: ${w.message}`);
        }
    }

    lines.push('');

    // Render tree
    let hasTruncation = false;
    const renderNode = (node, prefix = '', isLast = true) => {
        const connector = isLast ? '└── ' : '├── ';
        const extension = isLast ? '    ' : '│   ';

        let label = node.name;
        if (node.external) {
            label += ' [external]';
        } else if (node.file) {
            label += ` (${node.file}:${node.line})`;
        }
        if (node.weight && node.weight !== 'normal') {
            label += ` [${node.weight}]`;
        }
        if (node.callCount) {
            label += ` ${node.callCount}x`;
        }
        if (node.alreadyShown) {
            label += ' (see above)';
        }

        lines.push(prefix + connector + label);

        if (node.children && !node.alreadyShown) {
            const hasMore = node.truncatedChildren > 0;
            const hasUnverified = node.unverifiedCallees && node.unverifiedCallees.length > 0;
            for (let i = 0; i < node.children.length; i++) {
                const isChildLast = !hasMore && !hasUnverified && i === node.children.length - 1;
                renderNode(node.children[i], prefix + extension, isChildLast);
            }
            if (hasMore) {
                hasTruncation = true;
                lines.push(prefix + extension + (hasUnverified ? '├── ' : '└── ') + `... and ${node.truncatedChildren} more callees`);
            }
            renderUnverifiedCallees(lines, node, prefix, isLast);
        }
    };

    // Root node
    lines.push(trace.root);
    if (trace.tree && trace.tree.children) {
        const rootHasMore = trace.tree.truncatedChildren > 0;
        const rootHasUnverified = trace.tree.unverifiedCallees && trace.tree.unverifiedCallees.length > 0;
        for (let i = 0; i < trace.tree.children.length; i++) {
            const isLast = !rootHasMore && !rootHasUnverified && i === trace.tree.children.length - 1;
            renderNode(trace.tree.children[i], '', isLast);
        }
        if (rootHasMore) {
            hasTruncation = true;
            lines.push((rootHasUnverified ? '├── ' : '└── ') + `... and ${trace.tree.truncatedChildren} more callees`);
        }
        if (rootHasUnverified) {
            // Root-level unverified callees: render with no prefix
            for (let i = 0; i < trace.tree.unverifiedCallees.length; i++) {
                const u = trace.tree.unverifiedCallees[i];
                const isLast = i === trace.tree.unverifiedCallees.length - 1;
                const connector = isLast ? '└── ' : '├── ';
                const owners = u.ownerCount > 1 ? ` (${u.ownerCount} owners)` : '';
                const linesPart = u.sites && u.sites.length > 0 ? ` L${u.sites.join(',L')}` : '';
                lines.push(`${connector}[unverified] ${u.name} — ${u.reason}${owners}${linesPart}`);
            }
        }
    }

    // Callers section
    if (trace.callers && trace.callers.length > 0) {
        lines.push('');
        lines.push('CALLED BY:');
        for (const c of trace.callers) {
            lines.push(`  ${c.name} - ${c.file}:${c.line}`);
            lines.push(`    ${c.expression}`);
        }
        if (trace.truncatedCallers) {
            hasTruncation = true;
            lines.push(`  ... and ${trace.truncatedCallers} more callers`);
        }
    }

    // Caller-direction unverified frontier (up/both)
    renderFrontier(lines, trace.unverifiedFrontier, options);

    // Conservation lines: callee rollup (down/both), root account (up/both)
    const accountParts = [];
    const downLine = calleeAccountLine(trace.treeAccount);
    if (downLine) accountParts.push(downLine);
    accountParts.push(...formatAccountLines(trace.account));
    if (accountParts.length > 0) {
        lines.push('');
        lines.push(...accountParts);
    }

    if (hasTruncation) {
        const allHint = options.allHint || 'Use --all to show all.';
        lines.push(`\nSome results truncated. ${allHint}`);
    }

    // Only claim filtering when the account actually filtered edges — the
    // flag is a no-op for languages where method callees are always analyzed.
    const traceFiltered = (trace.treeAccount?.callSites?.filtered ?? trace.treeAccount?.filteredEdges ?? 0);
    if (trace.includeMethods === false && traceFiltered > 0) {
        const methodsHint = options.methodsHint || `Note: ${traceFiltered} obj.method() callee edge(s) hidden (counted as filtered in the account). Use --include-methods to show them.`;
        lines.push(`\n${methodsHint}`);
    }

    return lines.join('\n');
}

/**
 * Format trace command output - JSON
 */
function formatTraceJson(trace) {
    if (!trace) {
        return JSON.stringify({ found: false, error: 'Function not found' }, null, 2);
    }
    return JSON.stringify(trace, null, 2);
}

/**
 * Format blast command output - text
 * Shows transitive blast radius (callers of callers)
 */
function formatBlast(blast, options = {}) {
    if (!blast) {
        return 'Function not found.';
    }

    const lines = [];

    // Header
    lines.push(`Blast radius for ${blast.root}`);
    lines.push('═'.repeat(60));
    lines.push(`${blast.file}:${blast.line}`);
    lines.push(`Depth: ${blast.maxDepth}`);

    if (blast.warnings && blast.warnings.length > 0) {
        for (const w of blast.warnings) {
            lines.push(`Note: ${w.message}`);
        }
    }

    lines.push('');

    // Render tree (same structure as trace but showing callers)
    let hasTruncation = false;
    const renderNode = (node, prefix = '', isLast = true) => {
        const connector = isLast ? '└── ' : '├── ';
        const extension = isLast ? '    ' : '│   ';

        let label = node.name;
        if (node.file) {
            label += ` (${node.file}:${node.line})`;
        }
        if (node.callSites && node.callSites > 1) {
            label += ` ${node.callSites}x`;
        }
        if (node.viaUnverified) {
            label += ` [⚠ via ${node.viaUnverified}]`;
        } else if (node.chainUnverified) {
            label += ' [⚠ unverified chain]';
        }
        if (node.alreadyShown) {
            label += ' (see above)';
        }

        lines.push(prefix + connector + label);

        if (node.children && !node.alreadyShown) {
            const hasMore = node.truncatedChildren > 0;
            for (let i = 0; i < node.children.length; i++) {
                const isChildLast = !hasMore && i === node.children.length - 1;
                renderNode(node.children[i], prefix + extension, isChildLast);
            }
            if (hasMore) {
                hasTruncation = true;
                lines.push(prefix + extension + `└── ... and ${node.truncatedChildren} more callers`);
            }
        }
    };

    // Root node
    lines.push(blast.root);
    if (blast.tree && blast.tree.children) {
        const rootHasMore = blast.tree.truncatedChildren > 0;
        for (let i = 0; i < blast.tree.children.length; i++) {
            const isLast = !rootHasMore && i === blast.tree.children.length - 1;
            renderNode(blast.tree.children[i], '', isLast);
        }
        if (rootHasMore) {
            hasTruncation = true;
            lines.push(`└── ... and ${blast.tree.truncatedChildren} more callers`);
        }
    }

    // Unverified frontier
    renderFrontier(lines, blast.unverifiedFrontier, options, !!blast.expandUnverified);

    // Summary
    if (blast.summary) {
        lines.push('');
        const { totalAffected, totalFiles, unverifiedEdges, possiblyAffected } = blast.summary;
        if (totalAffected > 0) {
            let s = `Summary: 1 function changed → ${totalAffected} function${totalAffected !== 1 ? 's' : ''} affected across ${totalFiles} file${totalFiles !== 1 ? 's' : ''}`;
            if (unverifiedEdges > 0) {
                s += blast.expandUnverified
                    ? ` · ${unverifiedEdges} unverified edge${unverifiedEdges !== 1 ? 's' : ''} followed (${possiblyAffected || 0} possibly affected)`
                    : ` · ${unverifiedEdges} unverified edge${unverifiedEdges !== 1 ? 's' : ''} (--expand-unverified to follow them)`;
            }
            lines.push(s);
        } else if (unverifiedEdges > 0) {
            lines.push(blast.expandUnverified
                ? `Summary: no confirmed callers · ${unverifiedEdges} unverified edge${unverifiedEdges !== 1 ? 's' : ''} followed (${possiblyAffected || 0} possibly affected)`
                : `Summary: no confirmed callers · ${unverifiedEdges} unverified edge${unverifiedEdges !== 1 ? 's' : ''} (--expand-unverified to follow them)`);
        } else {
            lines.push('Summary: No callers found — this function is a root/entry point.');
        }
    }

    // Conservation lines
    const taLine = treeAccountLine(blast.treeAccount);
    const accountLines = formatAccountLines(blast.account);
    if (taLine || accountLines.length > 0) {
        lines.push('');
        if (accountLines.length > 0) lines.push(...accountLines);
        if (taLine) lines.push(taLine);
    }

    if (hasTruncation) {
        const allHint = options.allHint || 'Use --all to show all.';
        lines.push(`\nSome results truncated. ${allHint}`);
    }

    const blastFiltered = (blast.treeAccount?.filteredEdges ?? 0);
    if (blast.includeMethods === false && blastFiltered > 0) {
        lines.push(`\nNote: ${blastFiltered} obj.method() caller edge(s) hidden (counted as filtered in the account). Use --include-methods to show them.`);
    }

    return lines.join('\n');
}

/**
 * Format blast command output - JSON
 */
function formatBlastJson(blast) {
    if (!blast) {
        return JSON.stringify({ found: false, error: 'Function not found' }, null, 2);
    }
    return JSON.stringify(blast, null, 2);
}

/**
 * Format reverse-trace command output - text
 * Shows upward call chain to entry points
 */
function formatReverseTrace(result, options = {}) {
    if (!result) {
        return 'Function not found.';
    }

    const lines = [];

    // Header
    lines.push(`Reverse trace for ${result.root}`);
    lines.push('═'.repeat(60));
    lines.push(`${result.file}:${result.line}`);
    lines.push(`Depth: ${result.maxDepth}`);

    if (result.warnings && result.warnings.length > 0) {
        for (const w of result.warnings) {
            lines.push(`Note: ${w.message}`);
        }
    }

    lines.push('');

    // Render tree
    let hasTruncation = false;
    const renderNode = (node, prefix = '', isLast = true) => {
        const connector = isLast ? '└── ' : '├── ';
        const extension = isLast ? '    ' : '│   ';

        let label = node.name;
        if (node.file) {
            label += ` (${node.file}:${node.line})`;
        }
        if (node.callSites && node.callSites > 1) {
            label += ` ${node.callSites}x`;
        }
        if (node.viaUnverified) {
            label += ` [⚠ via ${node.viaUnverified}]`;
        } else if (node.chainUnverified) {
            label += ' [⚠ unverified chain]';
        }
        if (node.entryPoint) {
            label += ' ★ entry point';
        } else if (node.unverifiedCallerCount > 0 && (!node.children || node.children.length === 0)) {
            label += ` ⚠ no confirmed callers — ${node.unverifiedCallerCount} unverified`;
        }
        if (node.alreadyShown) {
            label += ' (see above)';
        }

        lines.push(prefix + connector + label);

        if (node.children && !node.alreadyShown) {
            const hasMore = node.truncatedChildren > 0;
            for (let i = 0; i < node.children.length; i++) {
                const isChildLast = !hasMore && i === node.children.length - 1;
                renderNode(node.children[i], prefix + extension, isChildLast);
            }
            if (hasMore) {
                hasTruncation = true;
                lines.push(prefix + extension + `└── ... and ${node.truncatedChildren} more callers`);
            }
        }
    };

    // Root node
    let rootLabel = result.root;
    if (result.tree && result.tree.entryPoint) {
        rootLabel += ' ★ entry point (no callers)';
    } else if (result.tree && result.tree.unverifiedCallerCount > 0 && result.tree.children.length === 0) {
        rootLabel += ` ⚠ no confirmed callers — ${result.tree.unverifiedCallerCount} unverified`;
    }
    lines.push(rootLabel);
    if (result.tree && result.tree.children) {
        const rootHasMore = result.tree.truncatedChildren > 0;
        for (let i = 0; i < result.tree.children.length; i++) {
            const isLast = !rootHasMore && i === result.tree.children.length - 1;
            renderNode(result.tree.children[i], '', isLast);
        }
        if (rootHasMore) {
            hasTruncation = true;
            lines.push(`└── ... and ${result.tree.truncatedChildren} more callers`);
        }
    }

    // Unverified frontier
    renderFrontier(lines, result.unverifiedFrontier, options, !!result.expandUnverified);

    // Entry points summary
    if (result.entryPoints && result.entryPoints.length > 0) {
        lines.push('');
        lines.push(`Entry points (${result.entryPoints.length}):`);
        for (const ep of result.entryPoints) {
            lines.push(`  ★ ${ep.name} (${ep.file}:${ep.line})`);
        }
    }

    // Summary
    if (result.summary) {
        lines.push('');
        const { totalEntryPoints, totalFunctions, unverifiedEdges } = result.summary;
        let s;
        if (totalFunctions > 0) {
            s = `Summary: ${totalEntryPoints} entry point${totalEntryPoints !== 1 ? 's' : ''} reach${totalEntryPoints === 1 ? 'es' : ''} ${result.root} through ${totalFunctions} intermediate function${totalFunctions !== 1 ? 's' : ''}`;
        } else if (unverifiedEdges > 0) {
            s = `Summary: no confirmed callers — ${unverifiedEdges} unverified edge${unverifiedEdges !== 1 ? 's' : ''} (not an entry-point claim)`;
        } else {
            s = 'Summary: No callers found — this function is itself an entry point.';
        }
        if (totalFunctions > 0 && unverifiedEdges > 0) {
            s += ` · ${unverifiedEdges} unverified edge${unverifiedEdges !== 1 ? 's' : ''}`;
        }
        lines.push(s);
    }

    // Conservation lines
    const taLine = treeAccountLine(result.treeAccount);
    const accountLines = formatAccountLines(result.account);
    if (taLine || accountLines.length > 0) {
        lines.push('');
        if (accountLines.length > 0) lines.push(...accountLines);
        if (taLine) lines.push(taLine);
    }

    if (hasTruncation) {
        const allHint = options.allHint || 'Use --all to show all.';
        lines.push(`\nSome results truncated. ${allHint}`);
    }

    const rtFiltered = (result.treeAccount?.filteredEdges ?? 0);
    if (result.includeMethods === false && rtFiltered > 0) {
        lines.push(`\nNote: ${rtFiltered} obj.method() caller edge(s) hidden (counted as filtered in the account). Use --include-methods to show them.`);
    }

    return lines.join('\n');
}

/**
 * Format reverse-trace command output - JSON
 */
function formatReverseTraceJson(result) {
    if (!result) {
        return JSON.stringify({ found: false, error: 'Function not found' }, null, 2);
    }
    return JSON.stringify(result, null, 2);
}

/**
 * Format affected-tests command output - text
 */
function formatAffectedTests(result, options = {}) {
    if (!result) return 'Function not found.';

    const lines = [];
    const { summary } = result;

    lines.push(`affected-tests: ${result.root}`);
    lines.push('═'.repeat(60));
    lines.push(`${result.file}:${result.line}`);
    lines.push(`1 function changed → ${summary.totalAffected} functions affected (depth ${result.depth})`);
    lines.push('');

    if (result.testFiles.length === 0) {
        lines.push('No test files found for any affected function.');
    } else {
        const MAX_TEST_FILES = options.all ? Infinity : 30;
        const displayFiles = result.testFiles.slice(0, MAX_TEST_FILES);
        const truncatedFiles = result.testFiles.length - displayFiles.length;
        lines.push(`Test files to run (${summary.totalTestFiles}):`);
        lines.push('');
        for (const tf of displayFiles) {
            lines.push(`  ${tf.file} (covers: ${tf.coveredFunctions.join(', ')})`);
            // Show up to 5 key matches per file
            const keyMatches = tf.matches
                .filter(m => m.matchType === 'call' || m.matchType === 'test-case')
                .slice(0, 5);
            for (const m of keyMatches) {
                lines.push(`    L${m.line}: ${m.content}  [${m.matchType}]`);
            }
        }
        if (truncatedFiles > 0) {
            lines.push(`\n  ... ${truncatedFiles} more test files (use file= and exclude= to narrow scope)`);
        }
    }

    // Possible band: functions reachable only through unverified chains.
    if ((result.possiblyAffected && result.possiblyAffected.length > 0) ||
        (result.possiblyAffectedTests && result.possiblyAffectedTests.length > 0)) {
        lines.push('');
        const pa = result.possiblyAffected || [];
        lines.push(`POSSIBLY AFFECTED (${pa.length}) — reachable only through unverified call edges:`);
        if (pa.length > 0) {
            lines.push(`  ${pa.join(', ')}`);
        }
        const pat = result.possiblyAffectedTests || [];
        if (pat.length > 0) {
            lines.push(`  Additional test files (${pat.length}):`);
            const MAX_POSSIBLE = options.all ? Infinity : 10;
            for (const tf of pat.slice(0, MAX_POSSIBLE)) {
                lines.push(`    ${tf.file} (covers: ${tf.coveredFunctions.join(', ')})`);
            }
            if (pat.length > MAX_POSSIBLE) {
                lines.push(`    ... ${pat.length - MAX_POSSIBLE} more (use --all)`);
            }
        }
    }

    if (result.uncovered.length > 0) {
        lines.push('');
        lines.push(`Uncovered (${result.uncovered.length}): ${result.uncovered.join(', ')}`);
        lines.push('  ⚠ These affected functions have no test references');
    }

    lines.push('');
    const pct = summary.totalAffected > 0
        ? Math.round(summary.coveredFunctions / summary.totalAffected * 100)
        : 0;
    let summaryLine = `Summary: ${summary.totalAffected} affected → ${summary.totalTestFiles} test files, ${summary.coveredFunctions}/${summary.totalAffected} functions covered (${pct}%)`;
    if (summary.possiblyAffected > 0) {
        summaryLine += ` · ${summary.possiblyAffected} possibly affected (unverified chains)`;
    }
    lines.push(summaryLine);

    // Conservation lines (root hop)
    const accountLines = formatAccountLines(result.account);
    if (accountLines.length > 0) {
        lines.push('');
        lines.push(...accountLines);
    }

    if (result.warnings?.length > 0) {
        lines.push('');
        for (const w of result.warnings) lines.push(`Note: ${w.message}`);
    }

    return lines.join('\n');
}

function formatAffectedTestsJson(result) {
    if (!result) {
        return JSON.stringify({ found: false, error: 'Function not found' }, null, 2);
    }
    return JSON.stringify(result, null, 2);
}

module.exports = {
    formatTrace,
    formatTraceJson,
    formatBlast,
    formatBlastJson,
    formatReverseTrace,
    formatReverseTraceJson,
    formatAffectedTests,
    formatAffectedTestsJson,
};
