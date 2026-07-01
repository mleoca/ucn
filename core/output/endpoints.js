/**
 * core/output/endpoints.js — Formatters for the `endpoints` command.
 *
 * Two surfaces: text (human) and JSON (machine).
 *
 * Layout principles:
 *   - Routes grouped by file when no --bridge flag.
 *   - With --bridge: routes listed individually, each followed by matched clients
 *     and a confidence tag, then unmatched routes/requests.
 *   - Counts at the top so the user knows the size up front.
 */

'use strict';

const { advisoryLine } = require('./shared');

const SEP_TIER = { exact: 'EXACT', partial: 'PARTIAL', uncertain: 'UNCERTAIN' };

function pad(s, n) {
    if (typeof s !== 'string') s = String(s);
    return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function formatEndpoints(result, options = {}) {
    if (!result) return 'No endpoints data.';
    const { routes, requests, bridges, unmatchedRoutes, unmatchedRequests, meta } = result;
    const showBridge = options.bridge;

    if (!showBridge) {
        return formatRoutesAndRequests(routes, requests, meta, options);
    }
    return formatBridges(bridges, unmatchedRoutes, unmatchedRequests, meta, options, result.advisory);
}

/**
 * Compute the unique-request match percentage. A single client request that
 * matches multiple server routes (e.g., trailing-slash dups) must count once,
 * not once per bridge — otherwise "Matched: N (200%)" shows up. Returns an
 * integer percentage clamped to [0, 100].
 */
function uniqueMatchPercent(bridges, totalRequests) {
    if (!totalRequests || totalRequests <= 0) return 0;
    const matchedRequestKeys = new Set();
    for (const b of bridges) {
        const r = b.request;
        matchedRequestKeys.add(`${r.absoluteFile || r.file}:${r.line}:${r.method}:${r.path}`);
    }
    const pct = Math.round((matchedRequestKeys.size / totalRequests) * 100);
    return Math.min(100, Math.max(0, pct));
}

function formatRoutesAndRequests(routes, requests, meta, options) {
    const lines = [];
    const showServer = !options.clientOnly;
    const showClient = !options.serverOnly;

    if (showServer) {
        if (routes.length === 0) {
            lines.push('No server routes detected.');
        } else {
            lines.push(`Server Routes: ${routes.length}`);
            const fwSummary = Object.entries(meta.byFramework || {})
                .map(([k, v]) => `${k}=${v}`)
                .join(', ');
            if (fwSummary) lines.push(`Frameworks: ${fwSummary}`);
            lines.push('');

            const byFile = new Map();
            for (const r of routes) {
                const list = byFile.get(r.file) || [];
                list.push(r);
                byFile.set(r.file, list);
            }
            for (const [file, list] of byFile) {
                lines.push(`${file}`);
                for (const r of list) {
                    const handler = r.handler || '<anonymous>';
                    const fw = r.framework ? `[${r.framework}]` : '';
                    lines.push(`  ${pad(r.method, 7)} ${pad(r.path, 40)} → ${handler} ${fw} :${r.line}`);
                }
                lines.push('');
            }
        }
    }

    if (showClient) {
        if (requests.length === 0) {
            if (showServer) lines.push('No client requests detected.');
        } else {
            if (showServer) lines.push('');
            lines.push(`Client Requests: ${requests.length}`);
            lines.push('');

            const byFile = new Map();
            for (const r of requests) {
                const list = byFile.get(r.file) || [];
                list.push(r);
                byFile.set(r.file, list);
            }
            for (const [file, list] of byFile) {
                lines.push(`${file}`);
                for (const r of list) {
                    const inferred = r.methodInferred ? '?' : '';
                    const interp = r.interp ? ' (interp)' : '';
                    const fw = r.framework ? `[${r.framework}]` : '';
                    lines.push(`  ${pad(r.method + inferred, 7)} ${pad(r.path + interp, 40)} from ${r.callerName} ${fw} :${r.line}`);
                }
                lines.push('');
            }
        }
    }

    return lines.join('\n').trimEnd();
}

function formatBridges(bridges, unmatchedRoutes, unmatchedRequests, meta, options = {}, advisory = null) {
    const lines = [];
    const matched = bridges.length;
    const unmatchedOnly = !!options.unmatched;

    lines.push(`Endpoint Bridges`);
    lines.push(`================`);
    const brAdvisory = advisoryLine(advisory);
    if (brAdvisory) lines.push(brAdvisory);
    lines.push(`Server routes: ${meta.totalRoutes}    Client requests: ${meta.totalRequests}`);
    // HIGH-3: percentage = unique matched client requests / total client
    // requests. Counting bridges directly inflates >100% on many-to-many
    // matches (trailing-slash dups, wildcard overlap, etc.).
    const pct = uniqueMatchPercent(bridges, meta.totalRequests);
    lines.push(`Matched: ${matched} (${pct}%)    Unmatched routes: ${unmatchedRoutes.length}    Unmatched requests: ${unmatchedRequests.length}`);
    lines.push('');

    // HIGH-2: in --unmatched mode, suppress the Matched section entirely.
    if (matched > 0 && !unmatchedOnly) {
        // Group bridges by route for display
        const byRoute = new Map();
        for (const b of bridges) {
            const key = `${b.route.absoluteFile}:${b.route.line}:${b.route.method}:${b.route.path}`;
            const list = byRoute.get(key) || { route: b.route, clients: [] };
            list.clients.push(b);
            byRoute.set(key, list);
        }
        // Sort routes alphabetically
        const sorted = [...byRoute.values()].sort((a, b) => {
            if (a.route.file !== b.route.file) return a.route.file.localeCompare(b.route.file);
            return a.route.line - b.route.line;
        });

        lines.push(`Matched (${sorted.length} routes):`);
        for (const { route, clients } of sorted) {
            lines.push(`  ${pad(route.method, 7)} ${route.path}  [${route.framework}]  ${route.file}:${route.line}`);
            for (const b of clients) {
                const conf = b.confidence.toFixed(2);
                const tier = b.matchType.toUpperCase();
                const inf = b.methodInferred ? ' method?' : '';
                lines.push(`    ↔ ${pad(b.request.method + inf, 9)} ${pad(b.request.path, 30)}  ${tier} (${conf})  from ${b.request.callerName}  ${b.request.file}:${b.request.line}`);
            }
            lines.push('');
        }
    }

    if (unmatchedRoutes.length > 0) {
        lines.push(`Unmatched server routes (${unmatchedRoutes.length}):`);
        for (const r of unmatchedRoutes) {
            lines.push(`  ${pad(r.method, 7)} ${pad(r.path, 40)} → ${r.handler}  [${r.framework}]  ${r.file}:${r.line}`);
        }
        lines.push('');
    }

    if (unmatchedRequests.length > 0) {
        lines.push(`Unmatched client requests (${unmatchedRequests.length}):`);
        for (const r of unmatchedRequests) {
            const inferred = r.methodInferred ? '?' : '';
            const interp = r.interp ? ' (interp)' : '';
            lines.push(`  ${pad(r.method + inferred, 7)} ${pad(r.path + interp, 40)} from ${r.callerName}  [${r.framework}]  ${r.file}:${r.line}`);
        }
    }

    return lines.join('\n').trimEnd();
}

function formatEndpointsJson(result, options = {}) {
    if (!result) return JSON.stringify({ meta: {}, data: {} }, null, 2);
    const { routes, requests, bridges, unmatchedRoutes, unmatchedRequests, meta } = result;
    // Read `unmatched` from explicit options OR sticky result property (set by
    // execute.js when the user passed --unmatched). The CLI/MCP wrappers may
    // not pass options through to JSON output, so we use both as fallbacks.
    const unmatchedOnly = !!(options.unmatched || result._unmatched);

    const trimRoute = (r) => ({
        method: r.method,
        path: r.path,
        normalizedPath: r.normalizedPath,
        handler: r.handler,
        file: r.file,
        line: r.line,
        framework: r.framework,
        ...(r.classPrefix && { classPrefix: r.classPrefix }),
    });
    const trimReq = (r) => ({
        method: r.method,
        path: r.path,
        normalizedPath: r.normalizedPath,
        ...(r.interp && { interp: true }),
        file: r.file,
        line: r.line,
        callerName: r.callerName,
        ...(r.callerStartLine && { callerStartLine: r.callerStartLine }),
        framework: r.framework,
        ...(r.methodInferred && { methodInferred: true }),
    });
    const trimBridge = (b) => ({
        route: trimRoute(b.route),
        request: trimReq(b.request),
        matchType: b.matchType,
        confidence: b.confidence,
        ...(b.methodInferred && { methodInferred: true }),
    });

    return JSON.stringify({
        meta: {
            ok: true,
            ...meta,
            // HIGH-2: signal to consumers that bridges array was suppressed
            // because the user filtered to unmatched-only.
            ...(unmatchedOnly && { filterMode: 'unmatched' }),
        },
        data: {
            routes: routes.map(trimRoute),
            requests: requests.map(trimReq),
            // In unmatched-only mode, the matched bridges array is suppressed
            // — consumers that want both should not pass --unmatched.
            bridges: unmatchedOnly ? [] : bridges.map(trimBridge),
            unmatchedRoutes: unmatchedRoutes.map(trimRoute),
            unmatchedRequests: unmatchedRequests.map(trimReq),
        },
    }, null, 2);
}

module.exports = {
    formatEndpoints,
    formatEndpointsJson,
};
