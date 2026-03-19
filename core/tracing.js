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
            const callees = index.findCallees(funcDef, { includeMethods, includeUncertain: options.includeUncertain });
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
                const callers = index.findCallers(funcDef.name, {
                    includeMethods,
                    includeUncertain,
                    targetDefinitions: funcDef.bindingId ? [funcDef] : undefined,
                });

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
                const callers = index.findCallers(funcDef.name, {
                    includeMethods,
                    includeUncertain,
                    targetDefinitions: funcDef.bindingId ? [funcDef] : undefined,
                });

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

        // Step 3: Build regex patterns for all names
        const namePatterns = new Map();
        for (const n of affectedNames) {
            const escaped = escapeRegExp(n);
            namePatterns.set(n, {
                regex: new RegExp('\\b' + escaped + '\\b'),
                callPattern: new RegExp(escaped + '\\s*\\('),
            });
        }

        // Step 4: Scan test files once for all affected names
        const exclude = options.exclude;
        const excludeArr = exclude ? (Array.isArray(exclude) ? exclude : [exclude]) : [];
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
                const lines = content.split('\n');
                const fileMatches = new Map();

                lines.forEach((line, idx) => {
                    for (const [funcName, patterns] of namePatterns) {
                        if (patterns.regex.test(line)) {
                            let matchType = 'reference';
                            if (/\b(describe|it|test|spec)\s*\(/.test(line)) {
                                matchType = 'test-case';
                            } else if (/\b(import|require|from)\b/.test(line)) {
                                matchType = 'import';
                            } else if (patterns.callPattern.test(line)) {
                                matchType = 'call';
                            }
                            if (!fileMatches.has(funcName)) fileMatches.set(funcName, []);
                            fileMatches.get(funcName).push({
                                line: idx + 1, content: line.trim(),
                                matchType, functionName: funcName
                            });
                        }
                    }
                });

                if (fileMatches.size > 0) {
                    const coveredFunctions = [...fileMatches.keys()];
                    const allMatches = [];
                    for (const matches of fileMatches.values()) allMatches.push(...matches);
                    allMatches.sort((a, b) => a.line - b.line);
                    results.push({
                        file: fileEntry.relativePath,
                        coveredFunctions,
                        matchCount: allMatches.length,
                        matches: allMatches
                    });
                }
            } catch (e) { /* skip unreadable */ }
        }

        // Sort by coverage breadth then alphabetically
        results.sort((a, b) => b.coveredFunctions.length - a.coveredFunctions.length || a.file.localeCompare(b.file));

        // Compute coverage stats
        const coveredSet = new Set();
        for (const r of results) for (const f of r.coveredFunctions) coveredSet.add(f);
        const uncovered = [...affectedNames].filter(n => !coveredSet.has(n));

        return {
            root: blastResult.root, file: blastResult.file, line: blastResult.line,
            depth: blastResult.maxDepth,
            affectedFunctions: [...affectedNames],
            testFiles: results,
            summary: {
                totalAffected: affectedNames.size,
                totalTestFiles: results.length,
                coveredFunctions: coveredSet.size,
                uncoveredCount: uncovered.length,
            },
            uncovered,
            warnings: blastResult.warnings,
        };
    } finally { index._endOp(); }
}

module.exports = { trace, blast, reverseTrace, affectedTests };
