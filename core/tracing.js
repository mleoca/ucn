/**
 * core/tracing.js — Call chain tracing (trace, blast, reverseTrace, affectedTests)
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 *
 * Tiered tree contract (v4): every command here runs findCallers/findCallees
 * in collectAccount mode. Confirmed-tier edges form the tree trunk; unverified
 * candidates are VISIBLE — caller-direction edges collect into a global
 * `unverifiedFrontier` (with parent-node attribution and a reason), callee
 * unknowns attach to their node as `unverifiedCallees`. Unverified edges are
 * not expanded by default (expanding a possible-dispatch edge would assert
 * transitive reach the evidence doesn't support); `expandUnverified` follows
 * them, marking every downstream node `chainUnverified`. The root hop carries
 * the same text-ground account as context/impact (composeAccount); interior
 * hops conserve over the engine-candidate set, rolled up in `treeAccount`.
 * `includeUncertain` is an implied no-op (the caller-contract precedent).
 */

'use strict';

const path = require('path');
const { escapeRegExp, codeUnitCompare, inlineTestRanges, lineInRanges, classDispatchNames } = require('./shared');
const { isTestFile } = require('./discovery');
const { getCachedCalls } = require('./callers');
const { detectLanguage, getLanguageModule } = require('../languages');

/**
 * Contract-mode caller expansion for the tree commands. Memoizes the full
 * findCallers(collectAccount) result per node and returns the tier partition.
 * Unverified entries are fully enriched (content + enclosing caller): the
 * frontier display and the affected-tests possible closure need them all.
 */
function _contractCallers(index, funcDef, { includeMethods, callerCache, pin }) {
    const nodeKey = `${funcDef.file}:${funcDef.startLine}`;
    const cacheKey = funcDef.bindingId
        ? `${funcDef.name}:${funcDef.bindingId}`
        : `${funcDef.name}:${nodeKey}`;
    let res = callerCache.get(cacheKey);
    if (!res) {
        const raw = index.findCallers(funcDef.name, {
            includeMethods,
            collectAccount: true,
            unverifiedEnrichLimit: Infinity,
            targetDefinitions: (funcDef.bindingId || pin) ? [funcDef] : undefined,
        });
        res = {
            confirmed: raw.filter(c => c.tier !== 'unverified'),
            unverified: [
                ...raw.filter(c => c.tier === 'unverified'),
                ...(raw.unverifiedEntries || []),
            ],
            raw,
        };
        callerCache.set(cacheKey, res);
    }
    return res;
}

/** Stable frontier ordering: hop, then parent node, then call site. */
function _sortFrontier(frontier) {
    frontier.sort((a, b) =>
        (a.hop - b.hop) ||
        codeUnitCompare((a.atNode.file || ''), b.atNode.file || '') ||
        ((a.atNode.line || 0) - (b.atNode.line || 0)) ||
        codeUnitCompare((a.relativePath || ''), b.relativePath || '') ||
        ((a.line || 0) - (b.line || 0)));
    return frontier;
}

/** Aggregate one node's excluded-with-reason candidates into the tree account. */
function _aggregateExcluded(treeAccount, raw) {
    const entries = (raw.accountRaw && raw.accountRaw.excludedEntries) || [];
    for (const e of entries) {
        const r = e.reason || 'excluded';
        treeAccount.excludedTotal++;
        treeAccount.excludedByReason[r] = (treeAccount.excludedByReason[r] || 0) + 1;
    }
}

/**
 * Dedupe caller call-sites into enclosing-function entries and resolve each
 * to its symbol-table definition (pseudo-definition when absent). Shared by
 * the confirmed trunk and the expand-unverified path.
 */
function _resolveCallerEntries(index, callers, exclude) {
    const uniqueCallers = new Map();
    for (const c of callers) {
        if (!c.callerName) continue; // skip module-level code
        if (exclude.length > 0 && !index.matchesFilters(c.relativePath, { exclude })) continue;
        const callerKey = c.callerStartLine
            ? `${c.callerFile}:${c.callerStartLine}`
            : `${c.callerFile}:${c.callerName}`;
        if (!uniqueCallers.has(callerKey)) {
            uniqueCallers.set(callerKey, {
                name: c.callerName,
                file: c.callerFile,
                relativePath: c.relativePath,
                startLine: c.callerStartLine,
                endLine: c.callerEndLine,
                callSites: 1,
                reason: c.reason,
            });
        } else {
            uniqueCallers.get(callerKey).callSites++;
        }
    }

    const callerEntries = [];
    for (const [, caller] of uniqueCallers) {
        const defs = index.symbols.get(caller.name);
        let callerDef = defs?.find(d => d.file === caller.file && d.startLine === caller.startLine);
        if (!callerDef) {
            // Pseudo-definition for callers not in symbol table
            callerDef = {
                name: caller.name,
                file: caller.file,
                relativePath: caller.relativePath,
                startLine: caller.startLine,
                endLine: caller.endLine,
                type: 'function'
            };
        }
        callerEntries.push({ def: callerDef, callSites: caller.callSites, reason: caller.reason });
    }

    // Stable sort by file + line
    callerEntries.sort((a, b) =>
        codeUnitCompare(a.def.file, b.def.file) || a.def.startLine - b.def.startLine
    );
    return callerEntries;
}

/**
 * Trace execution flow — build a tree of callees (down), callers (up), or both.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @param {object} options - { depth, direction, file, className, all, includeMethods, expandUnverified }
 * @returns {object|null} Trace tree with callers/callees
 */
function trace(index, name, options = {}) {
    index._beginOp();
    try {
    // Sanitize depth: use default for null/undefined, clamp negative to 0
    const rawDepth = options.depth ?? 3;
    const maxDepth = Math.max(0, rawDepth);
    const direction = options.direction || 'down';  // 'down' = callees, 'up' = callers, 'both'
    const maxChildren = options.all ? Infinity : 10;
    // trace defaults to includeMethods=true (execution flow should show method calls)
    const includeMethods = options.includeMethods ?? true;

    const { def, definitions, warnings } = index.resolveSymbol(name, { file: options.file, className: options.className, line: options.line });
    if (!def) {
        return null;
    }
    const visited = new Set();
    // Memoize findCallees results within this trace operation.
    // At depth 5, the same function appears at multiple tree positions — without
    // caching, findCallees is called redundantly (O(10^depth) → O(unique functions)).
    const calleeCache = new Map();

    // Down-direction conservation rollup: every call site at every expanded
    // node lands in exactly one bucket (per-node calleeAccount, summed here).
    const downAccount = (direction === 'down' || direction === 'both') ? {
        nodesExpanded: 0,
        callSites: { total: 0, confirmed: 0, unverified: 0, external: 0, excluded: 0, filtered: 0 },
        unverifiedByReason: {},
    } : null;

    const buildTree = (funcDef, currentDepth, dir) => {
        const funcName = funcDef.name;
        const key = `${funcDef.file}:${funcDef.startLine}`;
        if (currentDepth > maxDepth) {
            return null;
        }
        if (visited.has(key)) {
            // Already explored — show as leaf node without recursing (prevents infinite loops)
            return {
                name: funcName,
                file: funcDef.relativePath,
                line: funcDef.startLine,
                type: funcDef.type,
                children: [],
                alreadyShown: true
            };
        }
        visited.add(key);

        const node = {
            name: funcName,
            file: funcDef.relativePath,
            line: funcDef.startLine,
            type: funcDef.type,
            children: []
        };

        if (dir === 'down' || dir === 'both') {
            let callees = calleeCache.get(key);
            if (!callees) {
                callees = index.findCallees(funcDef, { includeMethods, collectAccount: true });
                calleeCache.set(key, callees);
            }
            // Callee contract: per-node account + visible unverified entries.
            const acct = callees.calleeAccount;
            if (acct && downAccount) {
                node.calleeAccount = acct;
                downAccount.nodesExpanded++;
                downAccount.callSites.total += acct.totalSites;
                downAccount.callSites.confirmed += acct.confirmed;
                downAccount.callSites.unverified += acct.unverified;
                downAccount.callSites.external += acct.external.count;
                downAccount.callSites.excluded += acct.excluded.total;
                downAccount.callSites.filtered += acct.filtered.count;
            }
            if (callees.unverifiedCallees && callees.unverifiedCallees.length > 0) {
                node.unverifiedCallees = callees.unverifiedCallees;
                if (downAccount) {
                    for (const u of node.unverifiedCallees) {
                        downAccount.unverifiedByReason[u.reason] =
                            (downAccount.unverifiedByReason[u.reason] || 0) + u.callCount;
                    }
                }
            }
            for (const callee of callees.slice(0, maxChildren)) {
                // callee already has the best-matched definition from findCallees
                const childTree = buildTree(callee, currentDepth + 1, 'down');
                if (childTree) {
                    node.children.push({
                        ...childTree,
                        callCount: callee.callCount,
                        weight: callee.weight
                    });
                }
            }
            if (callees.length > maxChildren) {
                node.truncatedChildren = callees.length - maxChildren;
            }
        }

        return node;
    };

    const tree = buildTree(def, 0, direction);

    // Also get callers if direction is 'up' or 'both' — one contract hop:
    // confirmed callers render in CALLED BY, unverified candidates in the
    // frontier, reconciled by the root text-ground account.
    let callers = [];
    let truncatedCallers = 0;
    let unverifiedFrontier;
    let account;
    if (direction === 'up' || direction === 'both') {
        const rawCallers = index.findCallers(name, {
            includeMethods,
            collectAccount: true,
            unverifiedEnrichLimit: Infinity,
            targetDefinitions: [def],
        });
        const confirmed = rawCallers.filter(c => c.tier !== 'unverified');
        let unverified = [
            ...rawCallers.filter(c => c.tier === 'unverified'),
            ...(rawCallers.unverifiedEntries || []),
        ];
        const { composeAccount, callNotResolvedEntries } = require('./analysis');
        account = composeAccount(index, name, rawCallers);
        unverified = [...unverified, ...callNotResolvedEntries(index, account, options)];
        const rootRef = { name: def.name, file: def.relativePath, line: def.startLine };
        unverifiedFrontier = _sortFrontier(unverified.map(u => ({
            atNode: rootRef,
            hop: 1,
            ...u,
        })));
        callers = confirmed.slice(0, maxChildren).map(c => ({
            name: c.callerName || '(anonymous)',
            file: c.relativePath,
            line: c.line,
            expression: (c.content || '').trim()
        }));
        if (confirmed.length > maxChildren) {
            truncatedCallers = confirmed.length - maxChildren;
        }
    }

    // Add smart hint when resolved function has zero callees
    if (tree && tree.children && tree.children.length === 0) {
        if (maxDepth === 0) {
            warnings.push({
                message: `depth=0: showing root function only. Increase depth to see callees.`
            });
        } else if (definitions.length > 1 && !options.file) {
            warnings.push({
                message: `Resolved to ${def.relativePath}:${def.startLine} which has no callees. ${definitions.length - 1} other definition(s) exist — specify a file to pick a different one.`
            });
        }
    }

    return {
        root: name,
        file: def.relativePath,
        line: def.startLine,
        direction,
        maxDepth,
        includeMethods,
        tree,
        callers: direction !== 'down' ? callers : undefined,
        truncatedCallers: truncatedCallers > 0 ? truncatedCallers : undefined,
        ...(unverifiedFrontier && unverifiedFrontier.length > 0 && { unverifiedFrontier }),
        ...(downAccount && { treeAccount: downAccount }),
        ...(account && { account }),
        warnings: warnings.length > 0 ? warnings : undefined
    };
    } finally { index._endOp(); }
}

/**
 * Blast radius — transitive caller tree.
 * Answers: "What breaks transitively if I change this function?"
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @param {object} options - { depth, file, className, all, exclude, includeMethods, expandUnverified }
 * @returns {object|null} Blast radius tree with summary
 */
function blast(index, name, options = {}) {
    index._beginOp();
    try {
        const maxDepth = Math.max(0, options.depth ?? 3);
        const maxChildren = options.all ? Infinity : 10;
        const includeMethods = options.includeMethods ?? true;
        const exclude = options.exclude || [];
        const expandUnverified = !!options.expandUnverified;
        // Internal (affectedTests): observe which names had their callers
        // searched and where the confirmed trunk edges sit, without changing
        // the blast result shape (fix #246).
        const collect = options._collect || null;

        const { def, definitions, warnings } = index.resolveSymbol(name, { file: options.file, className: options.className, line: options.line });
        if (!def) return null;

        const visited = new Set();
        const callerCache = new Map();
        const affectedFunctions = new Set();
        const possiblyAffectedSet = new Set();
        const affectedFiles = new Set();
        const frontier = [];
        let maxDepthReached = 0;
        let rootRaw = null;
        let rootFiltered = 0;
        const treeAccount = {
            nodesExpanded: 0,
            confirmedEdges: 0,
            unverifiedEdges: 0,
            unverifiedByReason: {},
            excludedTotal: 0,
            excludedByReason: {},
            filteredEdges: 0,
            depthLimitNodes: 0,
        };

        const buildCallerTree = (funcDef, currentDepth, chainUnverified) => {
            const key = `${funcDef.file}:${funcDef.startLine}`;
            if (currentDepth > maxDepth) return null;
            if (visited.has(key)) {
                return {
                    name: funcDef.name,
                    file: funcDef.relativePath,
                    line: funcDef.startLine,
                    type: funcDef.type || 'function',
                    children: [],
                    alreadyShown: true
                };
            }
            visited.add(key);

            if (currentDepth > maxDepthReached) maxDepthReached = currentDepth;
            if (currentDepth > 0) {
                if (chainUnverified) {
                    possiblyAffectedSet.add(key);
                } else {
                    affectedFunctions.add(key);
                    affectedFiles.add(funcDef.file);
                }
            }

            const node = {
                name: funcDef.name,
                file: funcDef.relativePath,
                line: funcDef.startLine,
                type: funcDef.type || 'function',
                ...(chainUnverified && { chainUnverified: true }),
                children: []
            };

            if (currentDepth < maxDepth) {
                const { confirmed, unverified, raw } = _contractCallers(index, funcDef, { includeMethods, callerCache });
                treeAccount.nodesExpanded++;
                _aggregateExcluded(treeAccount, raw);
                if (currentDepth === 0) rootRaw = raw;
                if (collect && !chainUnverified) collect.onExpand?.(funcDef);

                // Confirmed-tier call sites form the trunk
                let callers = confirmed;
                if (exclude.length > 0) {
                    const before = callers.length;
                    callers = callers.filter(c => index.matchesFilters(c.relativePath, { exclude }));
                    treeAccount.filteredEdges += before - callers.length;
                    if (currentDepth === 0) rootFiltered += before - callers.length;
                }
                treeAccount.confirmedEdges += callers.length;
                if (collect && !chainUnverified) {
                    for (const c of callers) collect.onConfirmed?.(funcDef, c);
                }

                // Unverified-tier candidates: visible frontier entries,
                // expanded only under expandUnverified.
                let nodeUnverified = unverified;
                if (exclude.length > 0) {
                    const before = nodeUnverified.length;
                    nodeUnverified = nodeUnverified.filter(c => index.matchesFilters(c.relativePath, { exclude }));
                    treeAccount.filteredEdges += before - nodeUnverified.length;
                    if (currentDepth === 0) rootFiltered += before - nodeUnverified.length;
                }
                for (const u of nodeUnverified) {
                    treeAccount.unverifiedEdges++;
                    const r = u.reason || 'unverified';
                    treeAccount.unverifiedByReason[r] = (treeAccount.unverifiedByReason[r] || 0) + 1;
                    frontier.push({
                        atNode: { name: node.name, file: node.file, line: node.line },
                        hop: currentDepth + 1,
                        ...u,
                        ...(expandUnverified && u.callerName ? { expanded: true } : {}),
                    });
                }

                const callerEntries = _resolveCallerEntries(index, callers, []);

                for (const { def: cDef, callSites } of callerEntries.slice(0, maxChildren)) {
                    const childTree = buildCallerTree(cDef, currentDepth + 1, chainUnverified);
                    if (childTree) {
                        childTree.callSites = callSites;
                        node.children.push(childTree);
                    }
                }

                if (callerEntries.length > maxChildren) {
                    node.truncatedChildren = callerEntries.length - maxChildren;
                    // Count truncated callers in summary
                    for (const { def: cDef } of callerEntries.slice(maxChildren)) {
                        const tKey = `${cDef.file}:${cDef.startLine}`;
                        if (!visited.has(tKey)) {
                            if (chainUnverified) {
                                possiblyAffectedSet.add(tKey);
                            } else {
                                affectedFunctions.add(tKey);
                                affectedFiles.add(cDef.file);
                            }
                        }
                    }
                }

                // Follow unverified edges on request: every downstream node is
                // marked chainUnverified — reach asserted by an unverified hop
                // is possible impact, never confirmed impact.
                if (expandUnverified && nodeUnverified.length > 0) {
                    const unvEntries = _resolveCallerEntries(index, nodeUnverified, []);
                    for (const { def: cDef, callSites, reason } of unvEntries.slice(0, maxChildren)) {
                        const childTree = buildCallerTree(cDef, currentDepth + 1, true);
                        if (childTree) {
                            childTree.callSites = callSites;
                            childTree.viaUnverified = reason || 'unverified';
                            node.children.push(childTree);
                        }
                    }
                    for (const { def: cDef } of unvEntries.slice(maxChildren)) {
                        const tKey = `${cDef.file}:${cDef.startLine}`;
                        if (!visited.has(tKey)) possiblyAffectedSet.add(tKey);
                    }
                }
            } else {
                // Depth limit: this node's callers were not searched.
                treeAccount.depthLimitNodes++;
            }

            return node;
        };

        const tree = buildCallerTree(def, 0, false);

        // Root text-ground account (the context/impact contract at hop 1).
        // Ground call-lines no candidate claimed are frontier entries too —
        // counted in the account's unverified total, listed here.
        let account;
        if (rootRaw) {
            const { composeAccount, callNotResolvedEntries } = require('./analysis');
            account = composeAccount(index, name, rootRaw,
                rootFiltered > 0 ? { total: rootFiltered, byFlag: { exclude: rootFiltered } } : undefined);
            for (const e of callNotResolvedEntries(index, account, options)) {
                treeAccount.unverifiedEdges++;
                treeAccount.unverifiedByReason['call-not-resolved'] =
                    (treeAccount.unverifiedByReason['call-not-resolved'] || 0) + 1;
                frontier.push({
                    atNode: { name: def.name, file: def.relativePath, line: def.startLine },
                    hop: 1,
                    ...e,
                });
            }
        }
        _sortFrontier(frontier);

        // Smart hints
        if (tree && tree.children.length === 0) {
            if (maxDepth === 0) {
                warnings.push({ message: 'depth=0: showing root function only. Increase depth to see callers.' });
            } else if (definitions.length > 1 && !options.file) {
                warnings.push({
                    message: `Resolved to ${def.relativePath}:${def.startLine} which has no callers. ${definitions.length - 1} other definition(s) exist — specify a file to pick a different one.`
                });
            }
        }

        return {
            root: name,
            file: def.relativePath,
            line: def.startLine,
            maxDepth,
            includeMethods,
            expandUnverified: expandUnverified || undefined,
            tree,
            unverifiedFrontier: frontier,
            treeAccount,
            ...(account && { account }),
            summary: {
                totalAffected: affectedFunctions.size,
                totalFiles: affectedFiles.size,
                maxDepthReached,
                unverifiedEdges: treeAccount.unverifiedEdges,
                ...(expandUnverified && { possiblyAffected: possiblyAffectedSet.size }),
            },
            warnings: warnings.length > 0 ? warnings : undefined
        };
    } finally { index._endOp(); }
}

/**
 * Reverse trace: walk UP the caller chain to entry points.
 * Like blast but focused on "how does execution reach this function?"
 * Marks leaf nodes (functions with no callers) as entry points.
 *
 * Entry-point soundness (tree contract): a node is an entry point only when
 * it has zero confirmed AND zero unverified caller candidates. Zero confirmed
 * with unverified candidates renders `unverifiedCallerCount` instead — the
 * legacy behavior marked such nodes "entry point" after silently dropping
 * possible-dispatch callers.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @param {object} options - { depth, file, className, all, exclude, includeMethods, expandUnverified }
 * @returns {object|null} Reverse trace tree with entry points
 */
function reverseTrace(index, name, options = {}) {
    index._beginOp();
    try {
        const maxDepth = Math.max(0, options.depth ?? 5);
        const maxChildren = options.all ? Infinity : 10;
        const includeMethods = options.includeMethods ?? true;
        const exclude = options.exclude || [];
        const expandUnverified = !!options.expandUnverified;

        const { def, definitions, warnings } = index.resolveSymbol(name, { file: options.file, className: options.className, line: options.line });
        if (!def) return null;

        const visited = new Set();
        const callerCache = new Map();
        const entryPoints = [];
        const frontier = [];
        let maxDepthReached = 0;
        let rootRaw = null;
        let rootFiltered = 0;
        let rootUnverifiedCount = 0;
        const treeAccount = {
            nodesExpanded: 0,
            confirmedEdges: 0,
            unverifiedEdges: 0,
            unverifiedByReason: {},
            excludedTotal: 0,
            excludedByReason: {},
            filteredEdges: 0,
            depthLimitNodes: 0,
        };

        // Tier-partitioned, exclude-filtered callers of a node (memoized).
        const nodeCallers = (funcDef, isExpansion) => {
            const { confirmed, unverified, raw } = _contractCallers(index, funcDef, { includeMethods, callerCache });
            let conf = confirmed;
            let unv = unverified;
            if (exclude.length > 0) {
                const before = conf.length + unv.length;
                conf = conf.filter(c => index.matchesFilters(c.relativePath, { exclude }));
                unv = unv.filter(c => index.matchesFilters(c.relativePath, { exclude }));
                if (isExpansion) treeAccount.filteredEdges += before - conf.length - unv.length;
            }
            return { confirmed: conf, unverified: unv, raw };
        };

        const buildCallerTree = (funcDef, currentDepth, chainUnverified) => {
            const key = `${funcDef.file}:${funcDef.startLine}`;
            if (currentDepth > maxDepth) return null;
            if (visited.has(key)) {
                return {
                    name: funcDef.name,
                    file: funcDef.relativePath,
                    line: funcDef.startLine,
                    type: funcDef.type || 'function',
                    children: [],
                    alreadyShown: true
                };
            }
            visited.add(key);
            if (currentDepth > maxDepthReached) maxDepthReached = currentDepth;

            const node = {
                name: funcDef.name,
                file: funcDef.relativePath,
                line: funcDef.startLine,
                type: funcDef.type || 'function',
                ...(chainUnverified && { chainUnverified: true }),
                children: []
            };

            if (currentDepth < maxDepth) {
                const { confirmed, unverified, raw } = nodeCallers(funcDef, true);
                treeAccount.nodesExpanded++;
                _aggregateExcluded(treeAccount, raw);
                if (currentDepth === 0) {
                    rootRaw = raw;
                    rootUnverifiedCount = unverified.length;
                }
                treeAccount.confirmedEdges += confirmed.length;
                for (const u of unverified) {
                    treeAccount.unverifiedEdges++;
                    const r = u.reason || 'unverified';
                    treeAccount.unverifiedByReason[r] = (treeAccount.unverifiedByReason[r] || 0) + 1;
                    frontier.push({
                        atNode: { name: node.name, file: node.file, line: node.line },
                        hop: currentDepth + 1,
                        ...u,
                        ...(expandUnverified && u.callerName ? { expanded: true } : {}),
                    });
                }

                const callerEntries = _resolveCallerEntries(index, confirmed, []);

                for (const { def: cDef, callSites } of callerEntries.slice(0, maxChildren)) {
                    const childTree = buildCallerTree(cDef, currentDepth + 1, chainUnverified);
                    if (childTree) {
                        childTree.callSites = callSites;
                        node.children.push(childTree);
                    }
                }

                if (callerEntries.length > maxChildren) {
                    node.truncatedChildren = callerEntries.length - maxChildren;
                    // Count entry points in truncated branches so summary is accurate
                    for (const { def: cDef } of callerEntries.slice(maxChildren)) {
                        const cKey = `${cDef.file}:${cDef.startLine}`;
                        if (!visited.has(cKey)) {
                            const tiers = nodeCallers(cDef, false);
                            if (tiers.confirmed.length === 0 && tiers.unverified.length === 0) {
                                entryPoints.push({ name: cDef.name, file: cDef.relativePath || path.relative(index.root, cDef.file), line: cDef.startLine });
                            }
                        }
                    }
                }

                if (expandUnverified && unverified.length > 0) {
                    const unvEntries = _resolveCallerEntries(index, unverified, []);
                    for (const { def: cDef, callSites, reason } of unvEntries.slice(0, maxChildren)) {
                        const childTree = buildCallerTree(cDef, currentDepth + 1, true);
                        if (childTree) {
                            childTree.callSites = callSites;
                            childTree.viaUnverified = reason || 'unverified';
                            node.children.push(childTree);
                        }
                    }
                }

                // Entry point only when BOTH tiers are empty; unverified-only
                // nodes are visibly not-confirmed instead.
                if (callerEntries.length === 0 && currentDepth > 0) {
                    if (unverified.length === 0) {
                        node.entryPoint = true;
                        entryPoints.push({ name: funcDef.name, file: funcDef.relativePath, line: funcDef.startLine });
                    } else {
                        node.unverifiedCallerCount = unverified.length;
                    }
                }
            } else if (currentDepth > 0) {
                // At depth limit: check if this node is an entry point
                treeAccount.depthLimitNodes++;
                const tiers = nodeCallers(funcDef, false);
                if (tiers.confirmed.filter(c => c.callerName).length === 0) {
                    if (tiers.unverified.length === 0) {
                        node.entryPoint = true;
                        entryPoints.push({ name: funcDef.name, file: funcDef.relativePath, line: funcDef.startLine });
                    } else {
                        node.unverifiedCallerCount = tiers.unverified.length;
                    }
                }
            }

            return node;
        };

        const tree = buildCallerTree(def, 0, false);

        // Also mark root as entry point if it has no callers in either tier
        if (tree && tree.children.length === 0 && maxDepth > 0) {
            if (rootUnverifiedCount === 0) {
                tree.entryPoint = true;
                entryPoints.push({ name: def.name, file: def.relativePath, line: def.startLine });
            } else {
                tree.unverifiedCallerCount = rootUnverifiedCount;
            }
        }

        // Root text-ground account + unclaimed ground call-lines
        let account;
        if (rootRaw) {
            const { composeAccount, callNotResolvedEntries } = require('./analysis');
            account = composeAccount(index, name, rootRaw,
                rootFiltered > 0 ? { total: rootFiltered, byFlag: { exclude: rootFiltered } } : undefined);
            for (const e of callNotResolvedEntries(index, account, options)) {
                treeAccount.unverifiedEdges++;
                treeAccount.unverifiedByReason['call-not-resolved'] =
                    (treeAccount.unverifiedByReason['call-not-resolved'] || 0) + 1;
                frontier.push({
                    atNode: { name: def.name, file: def.relativePath, line: def.startLine },
                    hop: 1,
                    ...e,
                });
            }
        }
        _sortFrontier(frontier);

        // Smart hints
        if (tree && tree.children.length === 0) {
            if (maxDepth === 0) {
                warnings.push({ message: 'depth=0: showing root function only. Increase depth to see callers.' });
            } else if (definitions.length > 1 && !options.file) {
                warnings.push({
                    message: `Resolved to ${def.relativePath}:${def.startLine} which has no callers. ${definitions.length - 1} other definition(s) exist — specify a file to pick a different one.`
                });
            }
        }

        return {
            root: name,
            file: def.relativePath,
            line: def.startLine,
            maxDepth,
            includeMethods,
            expandUnverified: expandUnverified || undefined,
            tree,
            entryPoints,
            unverifiedFrontier: frontier,
            treeAccount,
            ...(account && { account }),
            summary: {
                totalEntryPoints: entryPoints.length,
                totalFunctions: visited.size - 1, // exclude root
                maxDepthReached,
                unverifiedEdges: treeAccount.unverifiedEdges,
            },
            warnings: warnings.length > 0 ? warnings : undefined
        };
    } finally { index._endOp(); }
}

/**
 * Find tests affected by a change to the given function.
 * Composes blast() (transitive callers) with test file scanning.
 *
 * Two bands (tree contract): `affectedFunctions`/`testFiles` come from the
 * confirmed-chain closure; names reachable only through >= 1 unverified hop
 * land in `possiblyAffected`, their additional test files in
 * `possiblyAffectedTests`. Coverage/uncovered claims are confirmed-band only.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @param {object} options - { depth, file, className, exclude, includeMethods }
 * @returns {object|null} Affected test files with coverage stats
 */
function affectedTests(index, name, options = {}) {
    index._beginOp();
    try {
        const maxDepth = Math.max(0, options.depth ?? 3);
        // Step 1: confirmed closure via blast (contract mode, no truncation).
        // The collector records, per trunk name, (a) whether the engine
        // searched its callers and (b) where the confirmed edges sit — the
        // coverage bands below must agree with that answer instead of
        // re-deciding it with a text scan (fix #246: the scan credited call
        // sites the same payload's account excluded, and missed confirmed
        // edges text can't see — renamed destructure aliases, callback refs).
        const expandedNames = new Set();
        const confirmedSitesByName = new Map(); // name → Map(relPath → Set(line))
        const blastResult = index.blast(name, {
            depth: maxDepth,
            file: options.file,
            className: options.className,
            all: true,
            exclude: options.exclude,
            includeMethods: options.includeMethods,
            _collect: {
                onExpand: (funcDef) => expandedNames.add(funcDef.name),
                onConfirmed: (funcDef, c) => {
                    let byFile = confirmedSitesByName.get(funcDef.name);
                    if (!byFile) { byFile = new Map(); confirmedSitesByName.set(funcDef.name, byFile); }
                    let lines = byFile.get(c.relativePath);
                    if (!lines) { lines = new Set(); byFile.set(c.relativePath, lines); }
                    lines.add(c.line);
                },
            },
        });
        if (!blastResult) return null;

        // Step 2: Collect confirmed-affected function names (and node keys).
        // Also record each name's CLASS identity from the tree — interior
        // names were scanned bare (post-#239), so a test of a DIFFERENT
        // class's same-named method got credited as coverage (fix #244:
        // `asyncio.run(...)` credited as covering Mgr.run).
        const affectedNames = new Set();
        const confirmedKeys = new Set();
        const nameToClasses = new Map(); // name → Set(className|null)
        affectedNames.add(name);
        const collectNames = (node) => {
            if (!node) return;
            affectedNames.add(node.name);
            confirmedKeys.add(`${node.file}:${node.line}`);
            const defs = index.symbols.get(node.name);
            const d = defs?.find(x => x.relativePath === node.file && x.startLine === node.line);
            let set = nameToClasses.get(node.name);
            if (!set) { set = new Set(); nameToClasses.set(node.name, set); }
            set.add(d?.className || null);
            for (const child of node.children || []) collectNames(child);
        };
        collectNames(blastResult.tree);

        // Step 2b: possible closure — BFS seeded by the frontier's enclosing
        // functions, following both edge tiers, bounded by the same depth.
        // Names reached only this way are possibly affected, never confirmed.
        const exclude = options.exclude;
        const excludeArr = exclude ? (Array.isArray(exclude) ? exclude : [exclude]) : [];
        const includeMethods = options.includeMethods ?? true;
        const possiblyNames = new Set();
        // Test FILES containing an unverified call site of an affected name
        // (relativePath → funcName → Set(lines)) — merged into
        // possiblyAffectedTests after the scan (fix #244).
        const frontierTestHits = new Map();
        {
            const callerCache = new Map();
            const possibleVisited = new Set();
            const queue = [];
            const enqueueCaller = (c, depth) => {
                if (!c.callerName || !c.callerFile) return;
                if (excludeArr.length > 0 && !index.matchesFilters(c.relativePath, { exclude: excludeArr })) return;
                const defs = index.symbols.get(c.callerName);
                let cDef = defs?.find(d => d.file === c.callerFile && d.startLine === c.callerStartLine);
                if (!cDef) {
                    cDef = {
                        name: c.callerName,
                        file: c.callerFile,
                        relativePath: c.relativePath,
                        startLine: c.callerStartLine,
                        endLine: c.callerEndLine,
                        type: 'function'
                    };
                }
                queue.push({ def: cDef, depth });
            };
            for (const fe of blastResult.unverifiedFrontier || []) {
                enqueueCaller(fe, fe.hop);
                // A frontier caller that is ITSELF a test function landed in
                // neither band (fix #244, the unittest setUp idiom):
                // isProductionName filters it from possiblyAffected, and the
                // test scan greps for calls OF it — tests are never called.
                // Route its FILE into possiblyAffectedTests directly.
                // Anonymous test callbacks (`it('...', () => { x.save() })`)
                // have no enclosing NAMED caller at all — the site's file is
                // still test evidence, so route by the site file whenever it
                // is a test file (fix #246; the caller-file and site file are
                // the same file by construction when both exist).
                const siteFile = fe.callerFile || fe.file;
                if (siteFile) {
                    const cfe = index.files.get(siteFile);
                    if (cfe) {
                        let isTestCaller = isTestFile(cfe.relativePath, cfe.language);
                        if (!isTestCaller && fe.callerName) {
                            const defs = index.symbols.get(fe.callerName);
                            const d = defs?.find(x => x.file === fe.callerFile && x.startLine === fe.callerStartLine);
                            const kindOf = getLanguageModule(cfe.language)?.getEntryPointKind;
                            if (d && kindOf && kindOf(d) === 'test') isTestCaller = true;
                        }
                        if (!isTestCaller && fe.line != null) {
                            // Inline #[cfg(test)] regions of production files
                            // are test code too — but only within the ranges.
                            const ranges = inlineTestRanges(cfe);
                            if (ranges.length > 0 && lineInRanges(fe.line, ranges)) isTestCaller = true;
                        }
                        if (isTestCaller &&
                            (excludeArr.length === 0 || index.matchesFilters(cfe.relativePath, { exclude: excludeArr }))) {
                            const affName = fe.atNode?.name || name;
                            let entry = frontierTestHits.get(siteFile);
                            if (!entry) {
                                entry = { rel: cfe.relativePath, byName: new Map() };
                                frontierTestHits.set(siteFile, entry);
                            }
                            let hitLines = entry.byName.get(affName);
                            if (!hitLines) { hitLines = new Set(); entry.byName.set(affName, hitLines); }
                            if (fe.line != null) hitLines.add(fe.line);
                        }
                    }
                }
            }
            while (queue.length > 0) {
                const { def: d, depth } = queue.shift();
                if (depth > maxDepth) continue;
                const k = `${d.relativePath || path.relative(index.root, d.file)}:${d.startLine}`;
                if (possibleVisited.has(k)) continue;
                possibleVisited.add(k);
                if (!confirmedKeys.has(k) && !affectedNames.has(d.name)) {
                    possiblyNames.add(d.name);
                }
                if (depth < maxDepth) {
                    const { confirmed, unverified } = _contractCallers(index, d, { includeMethods, callerCache });
                    for (const c of confirmed) enqueueCaller(c, depth + 1);
                    for (const c of unverified) enqueueCaller(c, depth + 1);
                }
            }
            // A name in both bands is confirmed — the possible band only adds.
            for (const n of affectedNames) possiblyNames.delete(n);
        }

        // Step 3: Scan test files for all affected names using AST
        // Only count call and test-case matches as real coverage — not imports or bare references.
        const className = options.className || null;
        const results = [];
        const possibleResults = [];
        const scanNames = [...affectedNames, ...possiblyNames];
        const dispatchNamesCache = new Map(); // `${class}:${name}` → Set(classNames)
        for (const [filePath, fileEntry] of index.files) {
            let isTest = isTestFile(fileEntry.relativePath, fileEntry.language);
            // Rust inline #[cfg(test)] modules: source files with #[test]-marked symbols
            // or symbols inside a #[cfg(test)] mod block (BUG-CY). Such files
            // are test code ONLY within the inline test ranges — production
            // lines were counted as test matches (fix #244, false coverage).
            let testRanges = null;
            if (!isTest && fileEntry.language === 'rust') {
                const ranges = inlineTestRanges(fileEntry);
                if (ranges.length > 0) {
                    isTest = true;
                    testRanges = ranges;
                }
            }
            if (!isTest) continue;
            if (excludeArr.length > 0 && !index.matchesFilters(fileEntry.relativePath, { exclude: excludeArr })) continue;
            try {
                const content = index._readFile(filePath);
                const fileMatches = new Map();

                for (const funcName of scanNames) {
                    // Confirmed trunk edges of this name in THIS file — the
                    // engine's answer for the sites the text scan is about
                    // to re-derive (fix #246).
                    const engineFileSites = confirmedSitesByName.get(funcName)?.get(fileEntry.relativePath) || null;
                    // Whether the engine searched this name's callers at all
                    // (depth-limit nodes were never adjudicated — the text
                    // scan remains their best-effort fallback).
                    const engineAdjudicated = expandedNames.has(funcName);

                    // Fast pre-check
                    if (!content.includes(funcName) && !engineFileSites) continue;

                    // AST-based usage detection
                    const astUsages = index._getCachedUsages(filePath, funcName) || [];
                    if (astUsages.length === 0 && !engineFileSites) continue;

                    // className scoping: the user's pin applies to the ROOT
                    // symbol's own name only (fix #239, G3-go-measured) — a
                    // bare call to a standalone wrapper (SaveAll) can never
                    // carry the root's class receiver. INTERIOR names with a
                    // single unambiguous class identity in the blast tree
                    // scope to it (fix #244): a test of a different class's
                    // same-named method is not coverage of THIS closure.
                    // Standalone/mixed-identity names keep the bare scan.
                    let scopeToClass = null;
                    if (funcName === name) {
                        scopeToClass = className || null;
                    } else {
                        const classes = nameToClasses.get(funcName);
                        if (classes && classes.size === 1) {
                            const only = classes.values().next().value;
                            if (only) scopeToClass = only;
                        }
                    }

                    // A test file that DEFINES funcName itself owns bare-name
                    // calls of it (#215/#222(3) scope physics — fix #244: a
                    // private same-name helper let the coverage band claim
                    // 100% while the same payload's account excluded the
                    // site as other-definition). Exception: when the local
                    // def IS part of the blast closure (Rust inline-test
                    // files define the symbol AND test it), bare calls bind
                    // the affected symbol — genuine coverage.
                    const localDefs = (fileEntry.symbols || []).filter(s => s.name === funcName);
                    const localShadow = localDefs.length > 0 &&
                        localDefs.every(s => !confirmedKeys.has(`${fileEntry.relativePath}:${s.startLine}`)) &&
                        !(fileEntry.importBindings || []).some(b => b.name === funcName);

                    // Build instance type map for className scoping (if applicable).
                    // Scoping accepts the class plus its non-overriding
                    // descendants — instances of a subclass that doesn't
                    // override funcName dispatch to the target (fix #246).
                    let instanceTypeMap = null;
                    let dispatchNames = null;
                    if (scopeToClass) {
                        const dnKey = `${scopeToClass}:${funcName}`;
                        dispatchNames = dispatchNamesCache.get(dnKey);
                        if (!dispatchNames) {
                            dispatchNames = classDispatchNames(index, scopeToClass, funcName);
                            dispatchNamesCache.set(dnKey, dispatchNames);
                        }
                        instanceTypeMap = new Map();
                        for (const dn of dispatchNames) {
                            for (const [recv, cls] of _buildInstanceTypeMapForTracing(index, filePath, content, dn)) {
                                if (!instanceTypeMap.has(recv)) instanceTypeMap.set(recv, cls);
                            }
                        }
                    }

                    const seenLines = new Set();
                    for (const usage of astUsages) {
                        if (usage.usageType === 'definition') continue;
                        // Inline-test-promoted file: only lines inside the
                        // test ranges are test code (fix #244).
                        if (testRanges && !lineInRanges(usage.line, testRanges)) continue;
                        // The engine confirmed this exact site as a caller
                        // edge — its receiver physics subsume every text
                        // heuristic below (fix #246: exact-class scoping
                        // rejected a non-overriding subclass receiver the
                        // engine had confirmed).
                        const engineConfirmedHere = engineFileSites ? engineFileSites.has(usage.line) : false;
                        // Local same-name shadow: bare calls bind the test
                        // file's OWN definition, never the affected symbol.
                        if (localShadow && !engineConfirmedHere && !usage.receiver && usage.usageType !== 'import') continue;
                        const lineKey = `${usage.line}:${usage.usageType}`;
                        if (seenLines.has(lineKey)) continue;
                        seenLines.add(lineKey);

                        let matchType;
                        if (usage.usageType === 'import') {
                            matchType = 'import';
                        } else if (usage.usageType === 'call') {
                            matchType = 'call';
                        } else {
                            matchType = 'reference';
                        }
                        // A confirmed usage-style edge (callback reference,
                        // method value — fix #221) IS coverage: the test
                        // executes the symbol through the reference.
                        if (engineConfirmedHere && matchType === 'reference') matchType = 'call';

                        if (matchType === 'call' && !engineConfirmedHere && engineAdjudicated) {
                            // The engine searched this name's callers and did
                            // NOT confirm this site — the same payload's
                            // account holds it excluded-with-reason or
                            // unverified. Crediting it as confirmed coverage
                            // would contradict the account (fix #246);
                            // unverified sites surface in
                            // possiblyAffectedTests via the frontier.
                            continue;
                        }

                        // className scoping for calls (text physics — only
                        // depth-limit names reach this un-adjudicated)
                        if (scopeToClass && matchType === 'call' && !engineConfirmedHere) {
                            if (!_receiverMatchesClassTracing(usage, dispatchNames, instanceTypeMap,
                                index.getLineContent(filePath, usage.line), funcName)) continue;
                        }

                        // className scoping for references: require class-associated receiver
                        if (scopeToClass && matchType === 'reference') {
                            if (!usage.receiver) continue;
                            if (!dispatchNames.has(usage.receiver) &&
                                !(instanceTypeMap && dispatchNames.has(instanceTypeMap.get(usage.receiver)))) {
                                continue;
                            }
                        }

                        const lineContent = index.getLineContent(filePath, usage.line);
                        if (!fileMatches.has(funcName)) fileMatches.set(funcName, []);
                        fileMatches.get(funcName).push({
                            line: usage.line, content: lineContent.trim(),
                            matchType, functionName: funcName
                        });
                    }

                    // Confirmed engine sites the text scan could not see —
                    // renamed destructure aliases (`{ save: persist }`),
                    // beyondText lines — are coverage too (fix #246). The
                    // dedup map below collapses any line the loop already
                    // matched (call outranks reference).
                    if (engineFileSites) {
                        for (const ln of [...engineFileSites].sort((a, b) => a - b)) {
                            if (testRanges && !lineInRanges(ln, testRanges)) continue;
                            const lineKey = `${ln}:call`;
                            if (seenLines.has(lineKey)) continue;
                            seenLines.add(lineKey);
                            if (!fileMatches.has(funcName)) fileMatches.set(funcName, []);
                            fileMatches.get(funcName).push({
                                line: ln,
                                content: (index.getLineContent(filePath, ln) || '').trim(),
                                matchType: 'call', functionName: funcName
                            });
                        }
                    }

                    // Language-aware test-case detection
                    _addAffectedTestCases(index, filePath, fileEntry, funcName, fileMatches);
                }

                if (fileMatches.size > 0) {
                    const coveredFunctions = [...fileMatches.keys()];
                    const allMatches = [];
                    for (const matches of fileMatches.values()) allMatches.push(...matches);
                    // Deduplicate same line+function (test-case line might overlap with call line)
                    const dedupMap = new Map();
                    for (const m of allMatches) {
                        const key = `${m.line}:${m.functionName}`;
                        const existing = dedupMap.get(key);
                        if (!existing || _matchPriority(m.matchType) > _matchPriority(existing.matchType)) {
                            dedupMap.set(key, m);
                        }
                    }
                    const deduped = [...dedupMap.values()].sort((a, b) => a.line - b.line);

                    // Only count functions with call or test-case matches as covered.
                    // Import-only or reference-only functions are not real coverage.
                    const realCoveredAll = coveredFunctions.filter(fn => {
                        const fnMatches = deduped.filter(m => m.functionName === fn);
                        return fnMatches.some(m => m.matchType === 'call' || m.matchType === 'test-case');
                    });
                    const realCoveredFunctions = realCoveredAll.filter(fn => affectedNames.has(fn));
                    const possiblyCovered = realCoveredAll.filter(fn => possiblyNames.has(fn));

                    if (realCoveredFunctions.length > 0) {
                        // Confirmed band: matches for confirmed-covered names
                        const realMatches = deduped.filter(m =>
                            affectedNames.has(m.functionName) &&
                            (m.matchType === 'call' || m.matchType === 'test-case' ||
                             realCoveredFunctions.includes(m.functionName))
                        );
                        results.push({
                            file: fileEntry.relativePath,
                            coveredFunctions: realCoveredFunctions,
                            ...(possiblyCovered.length > 0 && { possiblyCovered }),
                            matchCount: realMatches.length,
                            matches: realMatches
                        });
                    } else if (possiblyCovered.length > 0) {
                        // Possible band: file reaches the change only through
                        // unverified chains.
                        const possibleMatches = deduped.filter(m =>
                            possiblyNames.has(m.functionName) &&
                            (m.matchType === 'call' || m.matchType === 'test-case' ||
                             possiblyCovered.includes(m.functionName))
                        );
                        possibleResults.push({
                            file: fileEntry.relativePath,
                            coveredFunctions: possiblyCovered,
                            matchCount: possibleMatches.length,
                            matches: possibleMatches
                        });
                    }
                }
            } catch (e) { /* skip unreadable */ }
        }

        // Merge frontier test hits: a test file whose own test function IS
        // the unverified caller never surfaces via the scan (the scan greps
        // for calls of scanNames; the test's name is not among them) — add
        // it to the possible band with its unverified call sites (fix #244).
        // A file already present for OTHER names still gets this name listed
        // as possibly covered (fix #246 — the file-level dedup silently
        // dropped per-name possible coverage).
        for (const [absFile, entry] of frontierTestHits) {
            const inResults = results.find(r => r.file === entry.rel);
            const inPossible = possibleResults.find(r => r.file === entry.rel);
            if (inResults || inPossible) {
                const existing = inResults || inPossible;
                const have = new Set([
                    ...existing.coveredFunctions,
                    ...(existing.possiblyCovered || []),
                ]);
                const extra = [...entry.byName.keys()].filter(n => !have.has(n)).sort(codeUnitCompare);
                if (extra.length > 0) {
                    if (inResults) {
                        existing.possiblyCovered = [...(existing.possiblyCovered || []), ...extra].sort(codeUnitCompare);
                    } else {
                        existing.coveredFunctions = [...existing.coveredFunctions, ...extra].sort(codeUnitCompare);
                    }
                }
                continue;
            }
            const covered = [...entry.byName.keys()].sort(codeUnitCompare);
            const matches = [];
            for (const fn of covered) {
                for (const ln of [...entry.byName.get(fn)].sort((a, b) => a - b)) {
                    matches.push({
                        line: ln,
                        content: (index.getLineContent(absFile, ln) || '').trim(),
                        matchType: 'call',
                        functionName: fn,
                    });
                }
            }
            possibleResults.push({
                file: entry.rel,
                coveredFunctions: covered,
                matchCount: matches.length,
                matches,
            });
        }

        // Sort by coverage breadth then alphabetically
        results.sort((a, b) => b.coveredFunctions.length - a.coveredFunctions.length || codeUnitCompare(a.file, b.file));
        possibleResults.sort((a, b) => b.coveredFunctions.length - a.coveredFunctions.length || codeUnitCompare(a.file, b.file));

        // Compute coverage stats.
        // Filter out test function names from affectedNames — they are callers,
        // not production symbols that need test coverage.
        const isProductionName = (n) => {
            // Check if this name is only found in test files. Inline test
            // functions (#[test] fns in Rust's #[cfg(test)] mods, Go Test*)
            // live in production-path FILES but are tests themselves — the
            // language's getEntryPointKind says so; they need no coverage.
            for (const [fp, fe] of index.files) {
                if (isTestFile(fe.relativePath, fe.language)) continue;
                const langModule = getLanguageModule(fe.language);
                const kindOf = langModule?.getEntryPointKind;
                if (fe.symbols?.some(s => s.name === n && (!kindOf || kindOf(s) !== 'test'))) {
                    return true;
                }
            }
            return false;
        };
        const productionNames = new Set();
        for (const n of affectedNames) {
            if (isProductionName(n)) productionNames.add(n);
        }
        // Fall back to full set if filtering removed everything (e.g., test-only project)
        const namesForCoverage = productionNames.size > 0 ? productionNames : affectedNames;
        const possiblyProduction = [...possiblyNames].filter(isProductionName);

        const coveredSet = new Set();
        for (const r of results) for (const f of r.coveredFunctions) {
            if (namesForCoverage.has(f)) coveredSet.add(f);
        }
        const uncovered = [...namesForCoverage].filter(n => !coveredSet.has(n));

        return {
            root: blastResult.root, file: blastResult.file, line: blastResult.line,
            depth: blastResult.maxDepth,
            affectedFunctions: [...namesForCoverage],
            possiblyAffected: possiblyProduction,
            testFiles: results,
            possiblyAffectedTests: possibleResults,
            ...(blastResult.account && { account: blastResult.account }),
            treeAccount: blastResult.treeAccount,
            summary: {
                totalAffected: namesForCoverage.size,
                totalTestFiles: results.length,
                coveredFunctions: coveredSet.size,
                uncoveredCount: uncovered.length,
                possiblyAffected: possiblyProduction.length,
                possiblyAffectedTests: possibleResults.length,
                unverifiedEdges: blastResult.summary ? blastResult.summary.unverifiedEdges : 0,
            },
            uncovered,
            warnings: blastResult.warnings,
        };
    } finally { index._endOp(); }
}

/**
 * Add test-case matches for a function name in a test file (language-aware).
 * Only adds test-case when the test body has a call match (not just import/reference).
 */
function _addAffectedTestCases(index, filePath, fileEntry, funcName, fileMatches) {
    const lang = fileEntry.language;
    const existingMatches = fileMatches.get(funcName) || [];
    const existingLines = new Set(existingMatches.map(m => m.line));

    if (lang === 'javascript' || lang === 'typescript' || lang === 'tsx') {
        const calls = getCachedCalls(index, filePath);
        if (!calls) return;
        const testFrameworkCalls = new Set(['describe', 'it', 'test', 'spec']);
        // Word-boundary match (fix #246): substring matched mid-word titles.
        const termPattern = new RegExp('(^|[^\\w$])' + escapeRegExp(funcName) + '([^\\w$]|$)');
        for (const call of calls) {
            if (!testFrameworkCalls.has(call.name)) continue;
            const lineContent = index.getLineContent(filePath, call.line);
            if (termPattern.test(lineContent) && !existingLines.has(call.line)) {
                // Only add test-case if a call match exists in the test body
                const endLine = _estimateTestBlockEndTracing(index, filePath, call.line);
                const hasCallMatch = existingMatches.some(m =>
                    m.line >= call.line && m.line <= endLine &&
                    m.matchType === 'call'
                );
                if (!hasCallMatch) continue;
                if (!fileMatches.has(funcName)) fileMatches.set(funcName, []);
                fileMatches.get(funcName).push({
                    line: call.line, content: lineContent.trim(),
                    matchType: 'test-case', functionName: funcName
                });
                existingLines.add(call.line);
            }
        }
    } else {
        if (!fileEntry.symbols) return;
        try {
            const langModule = getLanguageModule(lang);
            if (!langModule) return;
            // Prefer the kinded predicate so we don't mis-tag fn main() / fn init()
            // (runtime entries) as test cases (BUG-CX). Fall back to isEntryPoint
            // for backward compat with language modules that haven't been migrated.
            const classify = langModule.getEntryPointKind
                ? (s) => langModule.getEntryPointKind(s) === 'test'
                : langModule.isEntryPoint;
            if (!classify) return;
            for (const symbol of fileEntry.symbols) {
                if (!classify(symbol)) continue;
                // Only add test-case if a call match exists in the test body
                const hasCallInRange = existingMatches.some(m =>
                    m.line >= symbol.startLine && m.line <= symbol.endLine &&
                    m.matchType === 'call'
                );
                if (hasCallInRange && !existingLines.has(symbol.startLine)) {
                    const lineContent = index.getLineContent(filePath, symbol.startLine);
                    if (!fileMatches.has(funcName)) fileMatches.set(funcName, []);
                    fileMatches.get(funcName).push({
                        line: symbol.startLine, content: lineContent.trim(),
                        matchType: 'test-case', functionName: funcName
                    });
                    existingLines.add(symbol.startLine);
                }
            }
        } catch (e) { /* skip */ }
    }
}

/**
 * Build instance type map for className scoping in affectedTests.
 * Same logic as _buildInstanceTypeMap in search.js.
 */
function _buildInstanceTypeMapForTracing(index, filePath, content, targetClassName) {
    const typeMap = new Map();
    const calls = getCachedCalls(index, filePath);
    if (calls) {
        for (const call of calls) {
            if (call.isMethod && call.receiver && call.receiverType === targetClassName) {
                typeMap.set(call.receiver, targetClassName);
            }
            if (call.name === targetClassName && !call.isMethod) {
                const lineContent = index.getLineContent(filePath, call.line);
                const assignMatch = lineContent.match(/(?:const|let|var|)\s*(\w+)\s*:?=\s/);
                if (assignMatch) typeMap.set(assignMatch[1], targetClassName);
            }
            if (call.isMethod && call.receiver === targetClassName) {
                const lineContent = index.getLineContent(filePath, call.line);
                const assignMatch = lineContent.match(/(?:const|let|var|)\s*(\w+)\s*:?=\s/);
                if (assignMatch) typeMap.set(assignMatch[1], targetClassName);
            }
        }
    }
    const classUsages = index._getCachedUsages(filePath, targetClassName);
    if (classUsages) {
        for (const u of classUsages) {
            if (u.usageType === 'import' || u.usageType === 'definition') continue;
            const lineContent = index.getLineContent(filePath, u.line);
            const assignMatch = lineContent.match(/(?:const|let|var|)\s*(\w+)\s*:?=\s/);
            if (assignMatch && assignMatch[1] !== targetClassName) {
                typeMap.set(assignMatch[1], targetClassName);
            }
        }
    }
    return typeMap;
}

/**
 * Check if a usage's receiver matches any of the target dispatch class names
 * (the class + its non-overriding descendants — fix #246) for affectedTests.
 * Same logic as _receiverMatchesClass in search.js.
 */
function _receiverMatchesClassTracing(usage, dispatchNames, instanceTypeMap, lineContent, searchTerm) {
    if (usage.receiver && dispatchNames.has(usage.receiver)) return true;
    if (usage.receiver && instanceTypeMap && dispatchNames.has(instanceTypeMap.get(usage.receiver))) return true;
    if (usage.receiver) return false;
    if (lineContent && searchTerm) {
        for (const className of dispatchNames) {
            const pat = new RegExp(
                '\\b' + escapeRegExp(className) + '\\s*(?:(?:\\([^)]*\\)|\\{[^}]*\\})\\s*\\.\\s*' +
                escapeRegExp(searchTerm) + '\\s*\\(|' +
                'new\\s+' + escapeRegExp(className) + '\\s*\\([^)]*\\)\\s*\\.\\s*' +
                escapeRegExp(searchTerm) + '\\s*\\()'
            );
            if (pat.test(lineContent)) return true;
        }
    }
    return false;
}

/**
 * Estimate the end line of a test block by tracking brace/paren nesting.
 */
function _estimateTestBlockEndTracing(index, filePath, startLine) {
    const content = index._readFile(filePath);
    if (!content) return startLine + 5;
    const lines = content.split('\n');
    let depth = 0;
    let started = false;
    for (let i = startLine - 1; i < lines.length; i++) {
        const line = lines[i];
        for (const ch of line) {
            if (ch === '{' || ch === '(') { depth++; started = true; }
            else if (ch === '}' || ch === ')') { depth--; }
        }
        if (started && depth <= 0) return i + 1;
    }
    return Math.min(startLine + 10, lines.length);
}

function _matchPriority(matchType) {
    const p = { 'test-case': 5, 'call': 4, 'import': 3, 'string-ref': 2, 'reference': 1 };
    return p[matchType] || 0;
}

module.exports = { trace, blast, reverseTrace, affectedTests };
