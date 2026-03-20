/**
 * core/tracing.js — Call chain tracing (trace, blast, reverseTrace, affectedTests)
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

'use strict';

const path = require('path');
const { escapeRegExp } = require('./shared');
const { isTestFile } = require('./discovery');
const { getCachedCalls } = require('./callers');
const { detectLanguage, getLanguageModule } = require('../languages');

/**
 * Trace execution flow — build a tree of callees (down), callers (up), or both.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @param {object} options - { depth, direction, file, className, all, includeMethods, includeUncertain }
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

    const { def, definitions, warnings } = index.resolveSymbol(name, { file: options.file, className: options.className });
    if (!def) {
        return null;
    }
    const visited = new Set();
    // Memoize findCallees/findCallers results within this trace operation.
    // At depth 5, the same function appears at multiple tree positions — without
    // caching, findCallees is called redundantly (O(10^depth) → O(unique functions)).
    const calleeCache = new Map();
    const callerCache = new Map();

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
                callees = index.findCallees(funcDef, { includeMethods, includeUncertain: options.includeUncertain });
                calleeCache.set(key, callees);
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

    // Also get callers if direction is 'up' or 'both'
    let callers = [];
    let truncatedCallers = 0;
    if (direction === 'up' || direction === 'both') {
        const allCallers = index.findCallers(name, { includeMethods, includeUncertain: options.includeUncertain, targetDefinitions: [def] });
        callers = allCallers.slice(0, maxChildren).map(c => ({
            name: c.callerName || '(anonymous)',
            file: c.relativePath,
            line: c.line,
            expression: c.content.trim()
        }));
        if (allCallers.length > maxChildren) {
            truncatedCallers = allCallers.length - maxChildren;
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
 * @param {object} options - { depth, file, className, all, exclude, includeMethods, includeUncertain }
 * @returns {object|null} Blast radius tree with summary
 */
function blast(index, name, options = {}) {
    index._beginOp();
    try {
        const maxDepth = Math.max(0, options.depth ?? 3);
        const maxChildren = options.all ? Infinity : 10;
        const includeMethods = options.includeMethods ?? true;
        const includeUncertain = options.includeUncertain || false;
        const exclude = options.exclude || [];

        const { def, definitions, warnings } = index.resolveSymbol(name, { file: options.file, className: options.className });
        if (!def) return null;

        const visited = new Set();
        const callerCache = new Map();
        const affectedFunctions = new Set();
        const affectedFiles = new Set();
        let maxDepthReached = 0;

        const buildCallerTree = (funcDef, currentDepth) => {
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
                affectedFunctions.add(key);
                affectedFiles.add(funcDef.file);
            }

            const node = {
                name: funcDef.name,
                file: funcDef.relativePath,
                line: funcDef.startLine,
                type: funcDef.type || 'function',
                children: []
            };

            if (currentDepth < maxDepth) {
                const callerCacheKey = funcDef.bindingId
                    ? `${funcDef.name}:${funcDef.bindingId}`
                    : `${funcDef.name}:${key}`;
                let callers = callerCache.get(callerCacheKey);
                if (!callers) {
                    callers = index.findCallers(funcDef.name, {
                        includeMethods,
                        includeUncertain,
                        targetDefinitions: funcDef.bindingId ? [funcDef] : undefined,
                    });
                    callerCache.set(callerCacheKey, callers);
                }

                // Deduplicate callers by enclosing function (multiple call sites → one tree node)
                const uniqueCallers = new Map();
                for (const c of callers) {
                    if (!c.callerName) continue; // skip module-level code
                    // Apply exclude filter
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
                            callSites: 1
                        });
                    } else {
                        uniqueCallers.get(callerKey).callSites++;
                    }
                }

                // Resolve definitions and build child nodes
                const callerEntries = [];
                for (const [, caller] of uniqueCallers) {
                    // Look up actual definition from symbol table
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

                    callerEntries.push({ def: callerDef, callSites: caller.callSites });
                }

                // Stable sort by file + line
                callerEntries.sort((a, b) =>
                    a.def.file.localeCompare(b.def.file) || a.def.startLine - b.def.startLine
                );

                for (const { def: cDef, callSites } of callerEntries.slice(0, maxChildren)) {
                    const childTree = buildCallerTree(cDef, currentDepth + 1);
                    if (childTree) {
                        childTree.callSites = callSites;
                        node.children.push(childTree);
                    }
                }

                if (callerEntries.length > maxChildren) {
                    node.truncatedChildren = callerEntries.length - maxChildren;
                    // Count truncated callers in summary
                    for (const { def: cDef } of callerEntries.slice(maxChildren)) {
                        const key = `${cDef.file}:${cDef.startLine}`;
                        if (!visited.has(key)) {
                            affectedFunctions.add(key);
                            affectedFiles.add(cDef.file);
                        }
                    }
                }
            }

            return node;
        };

        const tree = buildCallerTree(def, 0);

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
            tree,
            summary: {
                totalAffected: affectedFunctions.size,
                totalFiles: affectedFiles.size,
                maxDepthReached
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
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @param {object} options - { depth, file, className, all, exclude, includeMethods, includeUncertain }
 * @returns {object|null} Reverse trace tree with entry points
 */
function reverseTrace(index, name, options = {}) {
    index._beginOp();
    try {
        const maxDepth = Math.max(0, options.depth ?? 5);
        const maxChildren = options.all ? Infinity : 10;
        const includeMethods = options.includeMethods ?? true;
        const includeUncertain = options.includeUncertain || false;
        const exclude = options.exclude || [];

        const { def, definitions, warnings } = index.resolveSymbol(name, { file: options.file, className: options.className });
        if (!def) return null;

        const visited = new Set();
        const callerCache = new Map();
        const entryPoints = [];
        let maxDepthReached = 0;

        const buildCallerTree = (funcDef, currentDepth) => {
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
                children: []
            };

            if (currentDepth < maxDepth) {
                const callerCacheKey = funcDef.bindingId
                    ? `${funcDef.name}:${funcDef.bindingId}`
                    : `${funcDef.name}:${key}`;
                let callers = callerCache.get(callerCacheKey);
                if (!callers) {
                    callers = index.findCallers(funcDef.name, {
                        includeMethods,
                        includeUncertain,
                        targetDefinitions: funcDef.bindingId ? [funcDef] : undefined,
                    });
                    callerCache.set(callerCacheKey, callers);
                }

                // Deduplicate callers by enclosing function
                const uniqueCallers = new Map();
                for (const c of callers) {
                    if (!c.callerName) continue;
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
                            callSites: 1
                        });
                    } else {
                        uniqueCallers.get(callerKey).callSites++;
                    }
                }

                // Resolve definitions and build child nodes
                const callerEntries = [];
                for (const [, caller] of uniqueCallers) {
                    const defs = index.symbols.get(caller.name);
                    let callerDef = defs?.find(d => d.file === caller.file && d.startLine === caller.startLine);
                    if (!callerDef) {
                        callerDef = {
                            name: caller.name,
                            file: caller.file,
                            relativePath: caller.relativePath,
                            startLine: caller.startLine,
                            endLine: caller.endLine,
                            type: 'function'
                        };
                    }
                    callerEntries.push({ def: callerDef, callSites: caller.callSites });
                }

                callerEntries.sort((a, b) =>
                    a.def.file.localeCompare(b.def.file) || a.def.startLine - b.def.startLine
                );

                for (const { def: cDef, callSites } of callerEntries.slice(0, maxChildren)) {
                    const childTree = buildCallerTree(cDef, currentDepth + 1);
                    if (childTree) {
                        childTree.callSites = callSites;
                        node.children.push(childTree);
                    }
                }

                if (callerEntries.length > maxChildren) {
                    node.truncatedChildren = callerEntries.length - maxChildren;
                    // Count entry points in truncated branches so summary is accurate
                    for (const { def: cDef } of callerEntries.slice(maxChildren)) {
                        const key = `${cDef.file}:${cDef.startLine}`;
                        if (!visited.has(key)) {
                            const cCallers = index.findCallers(cDef.name, {
                                includeMethods, includeUncertain,
                                targetDefinitions: cDef.bindingId ? [cDef] : undefined,
                            });
                            if (cCallers.length === 0) {
                                entryPoints.push({ name: cDef.name, file: cDef.relativePath || path.relative(index.root, cDef.file), line: cDef.startLine });
                            }
                        }
                    }
                }

                // Mark as entry point if no callers found (and not at depth limit)
                if (uniqueCallers.size === 0 && currentDepth > 0) {
                    node.entryPoint = true;
                    entryPoints.push({ name: funcDef.name, file: funcDef.relativePath, line: funcDef.startLine });
                }
            } else if (currentDepth > 0) {
                // At depth limit: check if this node is an entry point
                const callers = index.findCallers(funcDef.name, {
                    includeMethods,
                    includeUncertain,
                    targetDefinitions: funcDef.bindingId ? [funcDef] : undefined,
                });
                const hasCallers = callers.some(c => c.callerName &&
                    (exclude.length === 0 || index.matchesFilters(c.relativePath, { exclude })));
                if (!hasCallers) {
                    node.entryPoint = true;
                    entryPoints.push({ name: funcDef.name, file: funcDef.relativePath, line: funcDef.startLine });
                }
            }

            return node;
        };

        const tree = buildCallerTree(def, 0);

        // Also mark root as entry point if it has no callers
        if (tree && tree.children.length === 0 && maxDepth > 0) {
            tree.entryPoint = true;
            entryPoints.push({ name: def.name, file: def.relativePath, line: def.startLine });
        }

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
            tree,
            entryPoints,
            summary: {
                totalEntryPoints: entryPoints.length,
                totalFunctions: visited.size - 1, // exclude root
                maxDepthReached
            },
            warnings: warnings.length > 0 ? warnings : undefined
        };
    } finally { index._endOp(); }
}

/**
 * Find tests affected by a change to the given function.
 * Composes blast() (transitive callers) with test file scanning.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @param {object} options - { depth, file, className, exclude, includeMethods, includeUncertain }
 * @returns {object|null} Affected test files with coverage stats
 */
function affectedTests(index, name, options = {}) {
    index._beginOp();
    try {
        // Step 1: Get all transitively affected functions via blast
        const blastResult = index.blast(name, {
            depth: options.depth ?? 3,
            file: options.file,
            className: options.className,
            all: true,
            exclude: options.exclude,
            includeMethods: options.includeMethods,
            includeUncertain: options.includeUncertain,
        });
        if (!blastResult) return null;

        // Step 2: Collect all affected function names from the tree
        const affectedNames = new Set();
        affectedNames.add(name);
        const collectNames = (node) => {
            if (!node) return;
            affectedNames.add(node.name);
            for (const child of node.children || []) collectNames(child);
        };
        collectNames(blastResult.tree);

        // Step 3: Scan test files for all affected names using AST
        // Only count call and test-case matches as real coverage — not imports or bare references.
        const exclude = options.exclude;
        const excludeArr = exclude ? (Array.isArray(exclude) ? exclude : [exclude]) : [];
        const className = options.className || null;
        const results = [];
        for (const [filePath, fileEntry] of index.files) {
            let isTest = isTestFile(fileEntry.relativePath, fileEntry.language);
            // Rust inline #[cfg(test)] modules: source files with #[test]-marked symbols
            if (!isTest && fileEntry.language === 'rust') {
                isTest = fileEntry.symbols?.some(s => s.modifiers?.includes('test'));
            }
            if (!isTest) continue;
            if (excludeArr.length > 0 && !index.matchesFilters(fileEntry.relativePath, { exclude: excludeArr })) continue;
            try {
                const content = index._readFile(filePath);
                const fileMatches = new Map();

                for (const funcName of affectedNames) {
                    // Fast pre-check
                    if (!content.includes(funcName)) continue;

                    // AST-based usage detection
                    const astUsages = index._getCachedUsages(filePath, funcName);
                    if (!astUsages || astUsages.length === 0) continue;

                    // Build instance type map for className scoping (if applicable)
                    let instanceTypeMap = null;
                    if (className) {
                        instanceTypeMap = _buildInstanceTypeMapForTracing(index, filePath, content, className);
                    }

                    const seenLines = new Set();
                    for (const usage of astUsages) {
                        if (usage.usageType === 'definition') continue;
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

                        // className scoping for calls: check receiver
                        if (className && matchType === 'call') {
                            if (!_receiverMatchesClassTracing(usage, className, instanceTypeMap,
                                index.getLineContent(filePath, usage.line), funcName)) continue;
                        }

                        // className scoping for references: require class-associated receiver
                        if (className && matchType === 'reference') {
                            if (!usage.receiver) continue;
                            if (usage.receiver !== className &&
                                !(instanceTypeMap && instanceTypeMap.get(usage.receiver) === className)) {
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
                    const realCoveredFunctions = coveredFunctions.filter(fn => {
                        const fnMatches = deduped.filter(m => m.functionName === fn);
                        return fnMatches.some(m => m.matchType === 'call' || m.matchType === 'test-case');
                    });

                    // Only include file if it has real coverage
                    const realMatches = deduped.filter(m =>
                        m.matchType === 'call' || m.matchType === 'test-case' ||
                        realCoveredFunctions.includes(m.functionName)
                    );
                    if (realCoveredFunctions.length > 0) {
                        results.push({
                            file: fileEntry.relativePath,
                            coveredFunctions: realCoveredFunctions,
                            matchCount: realMatches.length,
                            matches: realMatches
                        });
                    }
                }
            } catch (e) { /* skip unreadable */ }
        }

        // Sort by coverage breadth then alphabetically
        results.sort((a, b) => b.coveredFunctions.length - a.coveredFunctions.length || a.file.localeCompare(b.file));

        // Compute coverage stats.
        // Filter out test function names from affectedNames — they are callers,
        // not production symbols that need test coverage.
        const productionNames = new Set();
        for (const n of affectedNames) {
            // Check if this name is only found in test files
            let foundInSource = false;
            for (const [fp, fe] of index.files) {
                if (isTestFile(fe.relativePath, fe.language)) continue;
                if (fe.symbols?.some(s => s.name === n)) { foundInSource = true; break; }
            }
            if (foundInSource) productionNames.add(n);
        }
        // Fall back to full set if filtering removed everything (e.g., test-only project)
        const namesForCoverage = productionNames.size > 0 ? productionNames : affectedNames;

        const coveredSet = new Set();
        for (const r of results) for (const f of r.coveredFunctions) {
            if (namesForCoverage.has(f)) coveredSet.add(f);
        }
        const uncovered = [...namesForCoverage].filter(n => !coveredSet.has(n));

        return {
            root: blastResult.root, file: blastResult.file, line: blastResult.line,
            depth: blastResult.maxDepth,
            affectedFunctions: [...namesForCoverage],
            testFiles: results,
            summary: {
                totalAffected: namesForCoverage.size,
                totalTestFiles: results.length,
                coveredFunctions: coveredSet.size,
                uncoveredCount: uncovered.length,
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
        for (const call of calls) {
            if (!testFrameworkCalls.has(call.name)) continue;
            const lineContent = index.getLineContent(filePath, call.line);
            if (lineContent.includes(funcName) && !existingLines.has(call.line)) {
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
            if (!langModule || !langModule.isEntryPoint) return;
            for (const symbol of fileEntry.symbols) {
                if (!langModule.isEntryPoint(symbol)) continue;
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
 * Check if a usage's receiver matches the target className (for affectedTests).
 * Same logic as _receiverMatchesClass in search.js.
 */
function _receiverMatchesClassTracing(usage, className, instanceTypeMap, lineContent, searchTerm) {
    if (usage.receiver === className) return true;
    if (usage.receiver && instanceTypeMap && instanceTypeMap.get(usage.receiver) === className) return true;
    if (usage.receiver) return false;
    if (lineContent && searchTerm) {
        const pat = new RegExp(
            '\\b' + escapeRegExp(className) + '\\s*(?:(?:\\([^)]*\\)|\\{[^}]*\\})\\s*\\.\\s*' +
            escapeRegExp(searchTerm) + '\\s*\\(|' +
            'new\\s+' + escapeRegExp(className) + '\\s*\\([^)]*\\)\\s*\\.\\s*' +
            escapeRegExp(searchTerm) + '\\s*\\()'
        );
        if (pat.test(lineContent)) return true;
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
