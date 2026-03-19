/**
 * core/output/tracing.js - Trace/blast/reverse tree formatters
 */

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
            for (let i = 0; i < node.children.length; i++) {
                const isChildLast = !hasMore && i === node.children.length - 1;
                renderNode(node.children[i], prefix + extension, isChildLast);
            }
            if (hasMore) {
                hasTruncation = true;
                lines.push(prefix + extension + `└── ... and ${node.truncatedChildren} more callees`);
            }
        }
    };

    // Root node
    lines.push(trace.root);
    if (trace.tree && trace.tree.children) {
        const rootHasMore = trace.tree.truncatedChildren > 0;
        for (let i = 0; i < trace.tree.children.length; i++) {
            const isLast = !rootHasMore && i === trace.tree.children.length - 1;
            renderNode(trace.tree.children[i], '', isLast);
        }
        if (rootHasMore) {
            hasTruncation = true;
            lines.push(`└── ... and ${trace.tree.truncatedChildren} more callees`);
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

    if (hasTruncation) {
        const allHint = options.allHint || 'Use --all to show all.';
        lines.push(`\nSome results truncated. ${allHint}`);
    }

    if (trace.includeMethods === false) {
        const methodsHint = options.methodsHint || 'Note: obj.method() calls excluded — use --include-methods to include them';
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

    // Summary
    if (blast.summary) {
        lines.push('');
        const { totalAffected, totalFiles } = blast.summary;
        if (totalAffected > 0) {
            lines.push(`Summary: 1 function changed → ${totalAffected} function${totalAffected !== 1 ? 's' : ''} affected across ${totalFiles} file${totalFiles !== 1 ? 's' : ''}`);
        } else {
            lines.push('Summary: No callers found — this function is a root/entry point.');
        }
    }

    if (hasTruncation) {
        const allHint = options.allHint || 'Use --all to show all.';
        lines.push(`\nSome results truncated. ${allHint}`);
    }

    if (blast.includeMethods === false) {
        lines.push('\nNote: obj.method() calls excluded. Use --include-methods to include them.');
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
        if (node.entryPoint) {
            label += ' ★ entry point';
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
        const { totalEntryPoints, totalFunctions } = result.summary;
        if (totalFunctions > 0) {
            lines.push(`Summary: ${totalEntryPoints} entry point${totalEntryPoints !== 1 ? 's' : ''} reach${totalEntryPoints === 1 ? 'es' : ''} ${result.root} through ${totalFunctions} intermediate function${totalFunctions !== 1 ? 's' : ''}`);
        } else {
            lines.push('Summary: No callers found — this function is itself an entry point.');
        }
    }

    if (hasTruncation) {
        const allHint = options.allHint || 'Use --all to show all.';
        lines.push(`\nSome results truncated. ${allHint}`);
    }

    if (result.includeMethods === false) {
        lines.push('\nNote: obj.method() calls excluded. Use --include-methods to include them.');
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

    if (result.uncovered.length > 0) {
        lines.push('');
        lines.push(`Uncovered (${result.uncovered.length}): ${result.uncovered.join(', ')}`);
        lines.push('  ⚠ These affected functions have no test references');
    }

    lines.push('');
    const pct = summary.totalAffected > 0
        ? Math.round(summary.coveredFunctions / summary.totalAffected * 100)
        : 0;
    lines.push(`Summary: ${summary.totalAffected} affected → ${summary.totalTestFiles} test files, ${summary.coveredFunctions}/${summary.totalAffected} functions covered (${pct}%)`);

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
