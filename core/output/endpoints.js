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
    return formatBridges(bridges, unmatchedRoutes, unmatchedRequests, meta, options);
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

function formatBridges(bridges, unmatchedRoutes, unmatchedRequests, meta, _options) {
    const lines = [];
    const matched = bridges.length;
    const unmatched = unmatchedRoutes.length + unmatchedRequests.length;

    lines.push(`Endpoint Bridges`);
    lines.push(`================`);
    lines.push(`Server routes: ${meta.totalRoutes}    Client requests: ${meta.totalRequests}`);
    lines.push(`Matched: ${matched} (${(matched / Math.max(1, meta.totalRequests) * 100).toFixed(0)}%)    Unmatched routes: ${unmatchedRoutes.length}    Unmatched requests: ${unmatchedRequests.length}`);
    lines.push('');

    if (matched > 0) {
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

function formatEndpointsJson(result, _options = {}) {
    if (!result) return JSON.stringify({ meta: {}, data: {} }, null, 2);
    const { routes, requests, bridges, unmatchedRoutes, unmatchedRequests, meta } = result;

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
        },
        data: {
            routes: routes.map(trimRoute),
            requests: requests.map(trimReq),
            bridges: bridges.map(trimBridge),
            unmatchedRoutes: unmatchedRoutes.map(trimRoute),
            unmatchedRequests: unmatchedRequests.map(trimReq),
        },
    }, null, 2);
}

module.exports = {
    formatEndpoints,
    formatEndpointsJson,
};
