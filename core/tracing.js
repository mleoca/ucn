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
const { codeUnitCompare, lineInRanges } = require('./shared');
const { paramDefault } = require('./registry');
const { isTestFile } = require('./discovery');
const { getLanguageAdapter } = require('../languages');
const { createTestModel, addTestCaseRows, linkFiles, commandsFor, testSite, testSiteKey } = require('./test-units');

/**
 * Contract-mode caller expansion for the tree commands. Memoizes the full
 * findCallers(collectAccount) result per node and returns the tier partition.
 * Unverified entries are fully enriched (content + enclosing caller): the
 * frontier display and the affected-tests possible closure need them all.
 */
function _contractCallers(index, funcDef, { includeMethods, callerCache, pin }) {
    if (funcDef.syntheticScope) return { confirmed: [], unverified: [], raw: [] };
    const nodeKey = declarationKey(funcDef);
    const definitionKey = `${funcDef.name}:${nodeKey}`;
    const cacheKey = `${pin ? 'pinned:' : ''}${definitionKey}`;
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
function declarationKey(def) {
    return [def.file, def.name, def.type || '', def.className || '', def.namespace || '',
        def.sourceSpan?.start ?? def.startLine, def.sourceSpan?.end ?? def.endLine].join(':');
}

function callerDefinition(index, site) {
    const candidates = (index.symbols.get(site.callerName) || []).filter(def =>
        def.file === site.callerFile && def.startLine === site.callerStartLine);
    const { containsCall } = require('./callable-scope');
    const exact = candidates.filter(def => containsCall(def, testSite(site)) === true)
        .sort((a, b) => (a.sourceSpan.end - a.sourceSpan.start) - (b.sourceSpan.end - b.sourceSpan.start));
    if (exact.length > 0) return exact[0];
    return candidates.length === 1 ? candidates[0] : null;
}

function _resolveCallerEntries(index, callers, exclude) {
    const uniqueCallers = new Map();
    for (const site of callers) {
        if (exclude.length > 0 && !index.matchesFilters(site.relativePath, { exclude })) continue;
        const named = callerDefinition(index, site);
        const def = named || {
            name: site.callerName || '(module/anonymous scope)',
            file: site.callerFile || site.file, relativePath: site.relativePath,
            startLine: site.callerStartLine || site.line, endLine: site.callerEndLine || site.line,
            type: 'function', syntheticScope: true,
        };
        const key = named ? declarationKey(named) : `${declarationKey(def)}:${testSiteKey(site)}`;
        if (uniqueCallers.has(key)) uniqueCallers.get(key).callSites++;
        else uniqueCallers.set(key, { def, callSites: 1, reason: site.reason });
    }
    return [...uniqueCallers.values()].sort((a, b) =>
        codeUnitCompare(a.def.file, b.def.file) || a.def.startLine - b.def.startLine ||
        (a.def.sourceSpan?.start || 0) - (b.def.sourceSpan?.start || 0) ||
        codeUnitCompare(declarationKey(a.def), declarationKey(b.def)));
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
    const rawDepth = options.depth ?? paramDefault('depth', 'trace');
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
        const key = declarationKey(funcDef);
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

        // A depth frontier is a node label, not a partially analyzed node.
        // Do not expose only its unverified callee band while suppressing its
        // confirmed children; both evidence tiers expand at the same depth.
        if (currentDepth >= maxDepth) return node;

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
            // A construction whose constructor body is undecided (fix #421):
            // its class edge is a child, the review a leaf beside it.
            if (callees.initializerReviews && callees.initializerReviews.length > 0) {
                node.initializerReviews = callees.initializerReviews;
            }
            for (const callee of callees.slice(0, maxChildren)) {
                // callee already has the best-matched definition from findCallees
                const childTree = buildTree(callee, currentDepth + 1, 'down');
                if (childTree) {
                    node.children.push({
                        ...childTree,
                        callCount: callee.callCount,
                        weight: callee.weight,
                        ...(callee.initializerOf && { constructs: callee.initializerOf }),
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
        const maxDepth = Math.max(0, options.depth ?? paramDefault('depth', 'trace'));
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
        // A caller's answer about one definition is the same whichever
        // root the walk started from: a selection over many roots shares it.
        const callerCache = options._callerCache || new Map();
        const affectedFunctions = new Set();
        const possiblyAffectedSet = new Set();
        const affectedFiles = new Set();
        const frontier = [];
        let maxDepthReached = 0;
        let rootRaw = null;
        let rootFiltered = 0;
        let rootSelfRecursive = false;
        const treeAccount = {
            nodesExpanded: 0,
            confirmedEdges: 0,
            recursiveEdges: 0,
            unverifiedEdges: 0,
            unverifiedByReason: {},
            excludedTotal: 0,
            excludedByReason: {},
            filteredEdges: 0,
            depthLimitNodes: 0,
            truncatedChildren: 0,
        };

        const buildCallerTree = (funcDef, currentDepth, chainUnverified) => {
            const key = declarationKey(funcDef);
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
            if (collect && !chainUnverified) collect.onNode?.(funcDef);

            if (currentDepth < maxDepth) {
                const { confirmed, unverified, raw } = _contractCallers(index, funcDef, {
                    includeMethods, callerCache, pin: options._pinDefinitions,
                });
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
                const recursiveCallers = callers.filter(c =>
                    declarationKey(callerDefinition(index, c) || {}) === declarationKey(funcDef));
                if (recursiveCallers.length > 0) {
                    callers = callers.filter(c => !recursiveCallers.includes(c));
                    node.selfRecursive = true;
                    treeAccount.recursiveEdges += recursiveCallers.length;
                    if (currentDepth === 0) rootSelfRecursive = true;
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
                    treeAccount.truncatedChildren += node.truncatedChildren;
                    // Count truncated callers in summary
                    for (const { def: cDef } of callerEntries.slice(maxChildren)) {
                        const tKey = declarationKey(cDef);
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
                        const tKey = declarationKey(cDef);
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

        if (options._testSitesOnly) {
            // Internal check selection needs only the declarations observed
            // by _collect. Caller tiering above still uses collectAccount;
            // the root account/frontier below are public presentation, not
            // evidence that can change the confirmed traversal.
            return { root: name, file: def.relativePath, line: def.startLine, maxDepth };
        }

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
                ...(rootSelfRecursive && { selfRecursive: true }),
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
        const maxDepth = Math.max(0, options.depth ?? paramDefault('depth', 'trace', 'entrypoints'));
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
            recursiveEdges: 0,
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
            const recursive = conf.filter(c =>
                declarationKey(callerDefinition(index, c) || {}) === declarationKey(funcDef));
            if (recursive.length > 0) {
                conf = conf.filter(c => !recursive.includes(c));
                if (isExpansion) treeAccount.recursiveEdges += recursive.length;
            }
            return { confirmed: conf, unverified: unv, recursive, raw };
        };

        const buildCallerTree = (funcDef, currentDepth, chainUnverified) => {
            const key = declarationKey(funcDef);
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
                const { confirmed, unverified, recursive, raw } = nodeCallers(funcDef, true);
                if (recursive.length > 0) node.selfRecursive = true;
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
                        const cKey = declarationKey(cDef);
                        if (!visited.has(cKey)) {
                            const tiers = nodeCallers(cDef, false);
                            if (tiers.confirmed.length === 0 && tiers.unverified.length === 0 &&
                                tiers.recursive.length === 0) {
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
                    if (unverified.length === 0 && recursive.length === 0) {
                        node.entryPoint = true;
                        entryPoints.push({ name: funcDef.name, file: funcDef.relativePath, line: funcDef.startLine });
                    } else if (recursive.length > 0) {
                        node.selfRecursive = true;
                    } else {
                        node.unverifiedCallerCount = unverified.length;
                    }
                }
            } else if (currentDepth > 0) {
                // At depth limit: check if this node is an entry point
                treeAccount.depthLimitNodes++;
                const tiers = nodeCallers(funcDef, false);
                if (tiers.confirmed.length === 0) {
                    if (tiers.unverified.length === 0 && tiers.recursive.length === 0) {
                        node.entryPoint = true;
                        entryPoints.push({ name: funcDef.name, file: funcDef.relativePath, line: funcDef.startLine });
                    } else if (tiers.recursive.length > 0) {
                        node.selfRecursive = true;
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
            const rootConfirmedCount = rootRaw
                ? rootRaw.filter(c => c.tier !== 'unverified').length
                : 0;
            if (rootConfirmedCount === 0 && rootUnverifiedCount === 0 && !tree.selfRecursive) {
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
                ...(tree?.selfRecursive && { selfRecursive: true }),
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
 * `possiblyAffectedTests`. Static-linkage claims are confirmed-band only.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @param {object} options - { depth, file, className, exclude, includeMethods }
 * @returns {object|null} Affected test files with static-linkage stats
 */
function affectedTests(index, name, options = {}) {
    index._beginOp();
    try {
        const maxDepth = Math.max(0, options.depth ?? 3);
        // Traverse production callers only to the requested depth. Every
        // declaration reached, including a boundary declaration, then has
        // its immediate test sites adjudicated against its own identity.
        // Inspecting those sites never extends the production closure.
        const callerCache = options._callerCache || new Map();
        const definitions = new Map();
        const keyOf = declarationKey;
        const blastResult = index.blast(name, {
            depth: maxDepth, file: options.file, className: options.className,
            line: options.line, _callerCache: callerCache, _pinDefinitions: true,
            all: true, exclude: options.exclude, includeMethods: options.includeMethods,
            _collect: { onNode: def => definitions.set(keyOf(def), def) },
            _testSitesOnly: options._testSitesOnly,
        });
        if (!blastResult) return null;
        const affectedNames = new Set([...definitions.values()].map(def => def.name));
        const possiblyNames = new Set();
        const exclude = options.exclude;
        const excludeArr = exclude ? (Array.isArray(exclude) ? exclude : [exclude]) : [];
        const includeMethods = options.includeMethods ?? true;
        const model = options._testModel || createTestModel(index);
        // The same multi-symbol operation reuses path classification. No
        // source/configuration fact survives the outermost operation.
        let testPaths = index._opMemos.get('affected-test-paths');
        if (!testPaths) {
            testPaths = new Map();
            index._opMemos.set('affected-test-paths', testPaths);
        }
        const testInfo = filePath => {
            const entry = index.files.get(filePath);
            if (!entry) return null;
            if (!testPaths.has(filePath)) {
                testPaths.set(filePath, isTestFile(entry.relativePath, entry.language));
            }
            if (testPaths.get(filePath)) return { entry, ranges: null };
            const ranges = model.testRangesOf(filePath);
            return ranges.length ? { entry, ranges } : null;
        };
        const absoluteOf = new Map();
        const confirmedRows = new Map();
        const possibleRows = new Map();
        const addSite = (site, functionName, confirmed) => {
            const filePath = site.file || site.callerFile;
            const info = testInfo(filePath);
            if (!info || (info.ranges && !lineInRanges(site.line, info.ranges)) ||
                (excludeArr.length && !index.matchesFilters(info.entry.relativePath, { exclude: excludeArr }))) return;
            absoluteOf.set(info.entry.relativePath, filePath);
            const rows = confirmed ? confirmedRows : possibleRows;
            let row = rows.get(info.entry.relativePath);
            if (!row) {
                row = { file: info.entry.relativePath, linkedFunctions: [], matches: [] };
                rows.set(row.file, row);
            }
            if (!row.linkedFunctions.includes(functionName)) row.linkedFunctions.push(functionName);
            if (!row.matches.some(match => testSiteKey(match) === testSiteKey(site) && match.functionName === functionName)) {
                row.matches.push({
                    ...testSite(site),
                    content: (site.content || index.getLineContent(filePath, site.line) || '').trim(),
                    matchType: 'call', functionName,
                    ...(!confirmed && { evidenceTier: 'unverified', reason: site.reason || 'unverified-chain' }),
                });
            }
        };
        const finishRows = rows => [...rows.values()].map(row => {
            const filePath = absoluteOf.get(row.file);
            const matches = [];
            for (const functionName of row.linkedFunctions.sort(codeUnitCompare)) {
                const own = row.matches.filter(match => match.functionName === functionName);
                // Imports remain useful context once an actual test site
                // links this file. They never create a link or select units.
                const ranges = testInfo(filePath)?.ranges;
                for (const usage of index._getCachedUsages(filePath, functionName) || []) {
                    if (usage.usageType !== 'import' ||
                        (ranges && !lineInRanges(usage.line, ranges)) ||
                        own.some(match => match.line === usage.line)) continue;
                    own.push({ line: usage.line,
                        content: (index.getLineContent(filePath, usage.line) || '').trim(),
                        matchType: 'import', functionName });
                }
                addTestCaseRows(model, index, filePath, functionName, own, {
                    counts: match => match.matchType === 'call', titleNeedsMatch: true,
                    extra: { functionName },
                });
                matches.push(...own);
            }
            row.matches = matches.sort((a, b) => a.line - b.line ||
                codeUnitCompare(a.functionName, b.functionName) || codeUnitCompare(a.matchType, b.matchType));
            row.matchCount = row.matches.length;
            return row;
        });
        const queue = [];
        const enqueue = (site, depth) => {
            if (!site.callerName || !site.callerFile || depth > maxDepth) return;
            if (excludeArr.length && !index.matchesFilters(site.relativePath, { exclude: excludeArr })) return;
            const def = callerDefinition(index, site);
            // Anonymous/module sites are test evidence but not declarations
            // whose spelling can seed another production traversal.
            if (def) queue.push({ def, depth });
        };
        for (const def of definitions.values()) {
            const { confirmed, unverified } = _contractCallers(index, def, { includeMethods, callerCache, pin: true });
            for (const site of confirmed) addSite(site, def.name, true);
            if (!options._testSitesOnly) {
                for (const site of unverified) addSite(site, def.name, false);
            }
            // Possible descendants are seeded by blast's bounded frontier
            // below, never by the extra boundary site inspection.
        }
        if (options._testSitesOnly) {
            // check unions the confirmed physical sites of every changed
            // declaration, then links their test units once. Preserve the
            // synthetic case-header sites used by that final link, but do
            // not traverse the unused possible band or project per-root
            // units, inherited rows and commands that check discards.
            return { testFiles: finishRows(confirmedRows) };
        }
        for (const site of blastResult.unverifiedFrontier || []) {
            addSite(site, site.atNode?.name || name, false);
            enqueue(site, site.hop);
        }
        const visited = new Set();
        for (let next = 0; next < queue.length; next++) {
            const { def, depth } = queue[next];
            const key = keyOf(def);
            if (visited.has(key) || definitions.has(key)) continue;
            visited.add(key);
            possiblyNames.add(def.name);
            const { confirmed, unverified } = _contractCallers(index, def, { includeMethods, callerCache, pin: true });
            for (const site of [...confirmed, ...unverified]) {
                addSite(site, def.name, false);
                if (depth < maxDepth) enqueue(site, depth + 1);
            }
        }
        for (const n of affectedNames) possiblyNames.delete(n);
        const results = finishRows(confirmedRows);
        // Keep uncertainty even when the same file also has a confirmed
        // link: its possible sites may belong to other test units.
        const possibleResults = finishRows(possibleRows);
        for (const row of results) {
            const possible = possibleRows.get(row.file);
            if (possible) row.possiblyLinkedFunctions = [...possible.linkedFunctions];
        }

        // What each file is to its runner, which tests hold the links, and
        // how many tests that is.
        const confirmedTests = new Set();
        const conditionalTests = new Set();
        const describeBand = (rows, confirmed) => {
            const linesByFile = new Map();
            for (const row of rows) {
                const absFile = absoluteOf.get(row.file);
                if (!absFile) continue;
                linesByFile.set(absFile, row.matches
                    .filter(match => match.matchType === 'call' || match.matchType === 'test-case'));
            }
            const byFile = new Map(rows.map(row => [row.file, row]));
            for (const [absFile, linked] of linkFiles(model, index, linesByFile)) {
                const relativePath = index.files.get(absFile).relativePath;
                let row = byFile.get(relativePath);
                if (!row) {
                    // The file of a class that inherits a linked test: the
                    // test runs there, whatever file its body stands in.
                    const sources = (linked.from || []).map(from => byFile.get(from)).filter(Boolean);
                    row = {
                        file: relativePath,
                        linkedFunctions: [...new Set(sources.flatMap(source => source.linkedFunctions))]
                            .sort(codeUnitCompare),
                        matchCount: 0,
                        matches: [],
                    };
                    byFile.set(relativePath, row);
                    absoluteOf.set(relativePath, absFile);
                    rows.push(row);
                }
                for (const unit of linked.units) {
                    if (!unit.inheritedFrom) continue;
                    row.matches.push({
                        line: unit.line,
                        content: (index.getLineContent(absFile, unit.line) || '').trim(),
                        matchType: 'inherited-test',
                        functionName: row.linkedFunctions[0] || name,
                        name: unit.name,
                        from: unit.inheritedFrom,
                    });
                    row.matchCount = row.matches.length;
                }
                row.role = linked.role;
                if (linked.runner) row.runner = linked.runner;
                row.testCount = linked.tests;
                if (linked.moreTests) row.moreTests = true;
                if (linked.conditionalTests) row.conditionalTests = linked.conditionalTests;
                if (linked.units.length > 0) row.units = linked.units;
                if (linked.run) row.run = linked.run;
                else if (linked.runWithheld) row.runWithheld = linked.runWithheld;
                if (confirmed) {
                    for (const key of linked.testKeys) confirmedTests.add(key);
                    for (const key of linked.conditionalKeys) conditionalTests.add(key);
                }
            }
        };
        describeBand(results, true);
        describeBand(possibleResults, false);

        // Sort by linkage breadth then alphabetically
        results.sort((a, b) => b.linkedFunctions.length - a.linkedFunctions.length || codeUnitCompare(a.file, b.file));
        possibleResults.sort((a, b) => b.linkedFunctions.length - a.linkedFunctions.length || codeUnitCompare(a.file, b.file));

        // Compute static-linkage stats.
        // Filter out test function names from affectedNames — they are callers,
        // not production symbols that need test coverage.
        const isProductionName = n => (index.symbols.get(n) || []).some(symbol => {
            const fe = index.files.get(symbol.file);
            if (!fe) return false;
            if (!testPaths.has(symbol.file)) {
                testPaths.set(symbol.file, isTestFile(fe.relativePath, fe.language));
            }
            if (testPaths.get(symbol.file)) return false;
            const kindOf = getLanguageAdapter(fe.language)?.getEntryPointKind;
            if (kindOf && kindOf(symbol) === 'test') return false;
            const ranges = model.ranges.get(symbol.file) || [];
            return !lineInRanges(symbol.startLine, ranges);
        });
        const productionNames = new Set();
        for (const n of affectedNames) {
            if (isProductionName(n)) productionNames.add(n);
        }
        // Fall back to full set if filtering removed everything (e.g., test-only project)
        const namesForCoverage = productionNames.size > 0 ? productionNames : affectedNames;
        const possiblyProduction = [...possiblyNames].filter(isProductionName);

        const linkedSet = new Set();
        for (const r of results) for (const f of r.linkedFunctions) {
            if (namesForCoverage.has(f)) linkedSet.add(f);
        }
        const notStaticallyLinked = [...namesForCoverage].filter(n => !linkedSet.has(n));

        return {
            root: blastResult.root, file: blastResult.file, line: blastResult.line,
            depth: blastResult.maxDepth,
            selection: {
                basis: 'static-call-and-reference-links',
                runtimeCoverage: false,
                absenceProvesUntested: false,
            },
            affectedFunctions: [...namesForCoverage],
            possiblyAffected: possiblyProduction,
            testFiles: results,
            possiblyAffectedTests: possibleResults,
            // The commands that run the confirmed files, where a runner is
            // proven and its command is known.
            commands: commandsFor(model, results.filter(row => row.role === 'tests')
                .map(row => absoluteOf.get(row.file)).filter(Boolean)),
            ...(blastResult.account && { account: blastResult.account }),
            treeAccount: blastResult.treeAccount,
            summary: {
                totalAffected: namesForCoverage.size,
                totalTestFiles: results.length,
                totalTests: confirmedTests.size,
                // A file among them holds tests that are not listed: the
                // total is a lower bound.
                ...(results.some(row => row.moreTests) && { moreTests: true }),
                ...(conditionalTests.size > 0 && { conditionalTests: conditionalTests.size }),
                supportFiles: results.filter(row => row.role === 'support').length,
                staticallyLinkedFunctions: linkedSet.size,
                notStaticallyLinkedCount: notStaticallyLinked.length,
                possiblyAffected: possiblyProduction.length,
                possiblyAffectedTests: possibleResults.length,
                unverifiedEdges: blastResult.summary ? blastResult.summary.unverifiedEdges : 0,
            },
            notStaticallyLinked,
            warnings: blastResult.warnings,
        };
    } finally { index._endOp(); }
}

module.exports = { trace, blast, reverseTrace, affectedTests };
