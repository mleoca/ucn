/**
 * core/analysis.js — Analysis commands (context, smart, related, impact, about, diffImpact, detectCompleteness)
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parse } = require('./parser');
const { detectLanguage, langTraits } = require('../languages');
const { NON_CALLABLE_TYPES, addTestExclusions } = require('./shared');

/**
 * Context: quick caller/callee view for a symbol.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Symbol name
 * @param {object} options - { file, className, includeMethods, includeUncertain, exclude, minConfidence }
 * @returns {object|null}
 */
function context(index, name, options = {}) {
    index._beginOp();
    try {
    const resolved = index.resolveSymbol(name, { file: options.file, className: options.className });
    let { def, warnings } = resolved;
    if (!def) {
        return null;
    }

    // Special handling for class/struct/interface types
    if (['class', 'struct', 'interface', 'type'].includes(def.type)) {
        const methods = index.findMethodsForType(name);

        let typeCallers = index.findCallers(name, { includeMethods: options.includeMethods, includeUncertain: options.includeUncertain });
        // Apply exclude filter
        if (options.exclude && options.exclude.length > 0) {
            typeCallers = typeCallers.filter(c => index.matchesFilters(c.relativePath, { exclude: options.exclude }));
        }

        const result = {
            type: def.type,
            name: name,
            file: def.relativePath,
            startLine: def.startLine,
            endLine: def.endLine,
            methods: methods.map(m => ({
                name: m.name,
                file: m.relativePath,
                line: m.startLine,
                params: m.params,
                returnType: m.returnType,
                receiver: m.receiver
            })),
            // Also include places where the type is used in function parameters/returns
            callers: typeCallers
        };

        if (warnings.length > 0) {
            result.warnings = warnings;
        }

        return result;
    }

    const stats = { uncertain: 0 };
    let callers = index.findCallers(name, { includeMethods: options.includeMethods, includeUncertain: options.includeUncertain, stats, targetDefinitions: [def] });
    let callees = index.findCallees(def, { includeMethods: options.includeMethods, includeUncertain: options.includeUncertain, stats });

    // Apply exclude filter
    if (options.exclude && options.exclude.length > 0) {
        callers = callers.filter(c => index.matchesFilters(c.relativePath, { exclude: options.exclude }));
        callees = callees.filter(c => index.matchesFilters(c.relativePath, { exclude: options.exclude }));
    }

    // Apply confidence filtering
    let confidenceFiltered = 0;
    if (options.minConfidence > 0) {
        const { filterByConfidence } = require('./confidence');
        const callerResult = filterByConfidence(callers, options.minConfidence);
        const calleeResult = filterByConfidence(callees, options.minConfidence);
        callers = callerResult.kept;
        callees = calleeResult.kept;
        confidenceFiltered = callerResult.filtered + calleeResult.filtered;
    }

    const filesInScope = new Set([def.file]);
    callers.forEach(c => filesInScope.add(c.file));
    callees.forEach(c => filesInScope.add(c.file));
    let dynamicImports = 0;
    for (const f of filesInScope) {
        const fe = index.files.get(f);
        if (fe?.dynamicImports) dynamicImports += fe.dynamicImports;
    }

    const result = {
        function: name,
        file: def.relativePath,
        startLine: def.startLine,
        endLine: def.endLine,
        params: def.params,
        returnType: def.returnType,
        callers,
        callees,
        meta: {
            complete: stats.uncertain === 0 && dynamicImports === 0 && confidenceFiltered === 0,
            skipped: 0,
            dynamicImports,
            uncertain: stats.uncertain,
            confidenceFiltered,
            includeMethods: !!options.includeMethods,
            projectLanguage: index._getPredominantLanguage(),
            // Structural facts for reliability hints
            ...(def.isMethod && { isMethod: true }),
            ...(def.className && { className: def.className }),
            ...(def.receiver && { receiver: def.receiver })
        }
    };

    if (warnings.length > 0) {
        result.warnings = warnings;
    }

    return result;
    } finally { index._endOp(); }
}

/**
 * Smart extraction: function + dependencies inline.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Symbol name
 * @param {object} options - { file, className, includeMethods, includeUncertain, withTypes }
 * @returns {object|null}
 */
function smart(index, name, options = {}) {
    index._beginOp();
    try {
    const { def } = index.resolveSymbol(name, { file: options.file, className: options.className });
    if (!def) {
        return null;
    }
    const code = index.extractCode(def);
    const stats = { uncertain: 0 };
    const callees = index.findCallees(def, { includeMethods: options.includeMethods, includeUncertain: options.includeUncertain, stats });

    const filesInScope = new Set([def.file]);
    callees.forEach(c => filesInScope.add(c.file));
    let dynamicImports = 0;
    for (const f of filesInScope) {
        const fe = index.files.get(f);
        if (fe?.dynamicImports) dynamicImports += fe.dynamicImports;
    }

    // Extract code for each dependency, excluding the exact same function
    // (but keeping same-name overloads, e.g. Java toJson(Object) vs toJson(Object, Class))
    const defBindingId = def.bindingId;
    const dependencies = callees
        .filter(callee => callee.bindingId !== defBindingId)
        .map(callee => ({
            ...callee,
            code: index.extractCode(callee)
        }));

    // Find type definitions if requested
    const types = [];
    if (options.withTypes) {
        // Look for type annotations in params/return type
        const typeNames = index.extractTypeNames(def);
        for (const typeName of typeNames) {
            const typeSymbols = index.symbols.get(typeName);
            if (typeSymbols) {
                for (const sym of typeSymbols) {
                    if (['type', 'interface', 'class', 'struct'].includes(sym.type)) {
                        types.push({
                            ...sym,
                            code: index.extractCode(sym)
                        });
                    }
                }
            }
        }
    }

    return {
        target: {
            ...def,
            code
        },
        dependencies,
        types,
        meta: {
            complete: stats.uncertain === 0 && dynamicImports === 0,
            skipped: 0,
            dynamicImports,
            uncertain: stats.uncertain,
            projectLanguage: index._getPredominantLanguage()
        }
    };
    } finally { index._endOp(); }
}

/**
 * Detect completeness signal metadata for the project.
 *
 * @param {object} index - ProjectIndex instance
 * @returns {object} { complete, warnings, projectLanguage }
 */
function detectCompleteness(index) {
    // Return cached result if available
    if (index._completenessCache) {
        return index._completenessCache;
    }

    const warnings = [];
    let dynamicImports = 0;
    let evalUsage = 0;
    let reflectionUsage = 0;

    for (const [filePath, fileEntry] of index.files) {
        // Skip node_modules - we don't care about their patterns
        if (filePath.includes('node_modules')) continue;

        try {
            const content = index._readFile(filePath);

            if (langTraits(fileEntry.language)?.hasDynamicImports) {
                // Dynamic imports: import(), require(variable), __import__
                dynamicImports += (content.match(/import\s*\([^'"]/g) || []).length;
                dynamicImports += (content.match(/require\s*\([^'"]/g) || []).length;
                dynamicImports += (content.match(/__import__\s*\(/g) || []).length;

                // eval, Function constructor
                evalUsage += (content.match(/(^|[^a-zA-Z_])eval\s*\(/gm) || []).length;
                evalUsage += (content.match(/new\s+Function\s*\(/g) || []).length;
            }

            // Reflection: getattr, hasattr, Reflect
            reflectionUsage += (content.match(/\bgetattr\s*\(/g) || []).length;
            reflectionUsage += (content.match(/\bhasattr\s*\(/g) || []).length;
            reflectionUsage += (content.match(/\bReflect\./g) || []).length;
        } catch (e) {
            // Skip unreadable files
        }
    }

    if (dynamicImports > 0) {
        warnings.push({
            type: 'dynamic_imports',
            count: dynamicImports,
            message: `${dynamicImports} dynamic import(s) detected - some dependencies may be missed`
        });
    }

    if (evalUsage > 0) {
        warnings.push({
            type: 'eval',
            count: evalUsage,
            message: `${evalUsage} eval/exec usage(s) detected - dynamically generated code not analyzed`
        });
    }

    if (reflectionUsage > 0) {
        warnings.push({
            type: 'reflection',
            count: reflectionUsage,
            message: `${reflectionUsage} reflection usage(s) detected - dynamic attribute access not tracked`
        });
    }

    index._completenessCache = {
        complete: warnings.length === 0,
        warnings,
        projectLanguage: index._getPredominantLanguage()
    };

    return index._completenessCache;
}

/**
 * Find related functions — same file, similar names, shared dependencies.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @param {object} options - { file, className, top, all }
 * @returns {object|null}
 */
function related(index, name, options = {}) {
    index._beginOp();
    try {
    const { def } = index.resolveSymbol(name, { file: options.file, className: options.className });
    if (!def) {
        return null;
    }
    const related = {
        target: {
            name: def.name,
            file: def.relativePath,
            line: def.startLine,
            type: def.type
        },
        sameFile: [],
        similarNames: [],
        sharedCallers: [],
        sharedCallees: []
    };

    // 1. Same file functions (sorted by proximity to target)
    const fileEntry = index.files.get(def.file);
    if (fileEntry) {
        for (const sym of fileEntry.symbols) {
            if (sym.name !== name && !NON_CALLABLE_TYPES.has(sym.type)) {
                related.sameFile.push({
                    name: sym.name,
                    line: sym.startLine,
                    params: sym.params
                });
            }
        }
        // Sort by distance from target function (nearest first)
        related.sameFile.sort((a, b) =>
            Math.abs(a.line - def.startLine) - Math.abs(b.line - def.startLine)
        );
    }

    // 2. Similar names (shared prefix/suffix, camelCase similarity)
    const nameParts = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split('_');
    for (const [symName, symbols] of index.symbols) {
        if (symName === name) continue;
        const symParts = symName.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split('_');

        // Check for shared parts (require >=50% of the longer name to match)
        const sharedParts = nameParts.filter(p => symParts.includes(p) && p.length > 3);
        const maxParts = Math.max(nameParts.length, symParts.length);
        if (sharedParts.length > 0 && sharedParts.length / maxParts >= 0.5) {
            const sym = symbols[0];
            related.similarNames.push({
                name: symName,
                file: sym.relativePath,
                line: sym.startLine,
                sharedParts,
                type: sym.type
            });
        }
    }
    // Sort by number of shared parts
    related.similarNames.sort((a, b) => b.sharedParts.length - a.sharedParts.length);
    const similarLimit = options.top || (options.all ? Infinity : 10);
    related.similarNamesTotal = related.similarNames.length;
    if (related.similarNames.length > similarLimit) related.similarNames = related.similarNames.slice(0, similarLimit);

    // 3. Shared callers - functions called by the same callers
    const myCallers = new Set(index.findCallers(name).map(c => c.callerName).filter(Boolean));
    if (myCallers.size > 0) {
        const callerCounts = new Map();
        for (const callerName of myCallers) {
            const callerDef = index.symbols.get(callerName)?.[0];
            if (callerDef) {
                const callees = index.findCallees(callerDef);
                for (const callee of callees) {
                    if (callee.name !== name) {
                        callerCounts.set(callee.name, (callerCounts.get(callee.name) || 0) + 1);
                    }
                }
            }
        }
        // Sort by shared caller count
        const maxShared = options.top || (options.all ? Infinity : 5);
        const allSorted = Array.from(callerCounts.entries())
            .sort((a, b) => b[1] - a[1]);
        related.sharedCallersTotal = allSorted.length;
        const sorted = allSorted.slice(0, maxShared);
        for (const [symName, count] of sorted) {
            const sym = index.symbols.get(symName)?.[0];
            if (sym) {
                related.sharedCallers.push({
                    name: symName,
                    file: sym.relativePath,
                    line: sym.startLine,
                    sharedCallerCount: count
                });
            }
        }
    }

    // 4. Shared callees - functions that call the same things
    // Optimized: instead of computing callees for every symbol (O(N*M)),
    // find who else calls each of our callees (O(K) where K = our callee count)
    if (def.type === 'function' || def.params !== undefined) {
        const myCallees = index.findCallees(def);
        const myCalleeNames = new Set(myCallees.map(c => c.name));
        if (myCalleeNames.size > 0) {
            const calleeCounts = new Map();
            for (const calleeName of myCalleeNames) {
                // Find other functions that also call this callee
                const callers = index.findCallers(calleeName);
                for (const caller of callers) {
                    if (caller.callerName && caller.callerName !== name) {
                        calleeCounts.set(caller.callerName, (calleeCounts.get(caller.callerName) || 0) + 1);
                    }
                }
            }
            // Sort by shared callee count
            const allSorted = Array.from(calleeCounts.entries())
                .sort((a, b) => b[1] - a[1]);
            related.sharedCalleesTotal = allSorted.length;
            const sorted = allSorted.slice(0, options.top || (options.all ? Infinity : 5));
            for (const [symName, count] of sorted) {
                const sym = index.symbols.get(symName)?.[0];
                if (sym) {
                    related.sharedCallees.push({
                        name: symName,
                        file: sym.relativePath,
                        line: sym.startLine,
                        sharedCalleeCount: count
                    });
                }
            }
        }
    }

    return related;
    } finally { index._endOp(); }
}

/**
 * Impact analysis — what call sites need updating if a function changes.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @param {object} options - { file, className, exclude, top }
 * @returns {object|null}
 */
function impact(index, name, options = {}) {
    index._beginOp();
    try {
    const { def } = index.resolveSymbol(name, { file: options.file, className: options.className });
    if (!def) {
        return null;
    }
    const defIsMethod = def.isMethod || def.type === 'method' || def.className || def.receiver;

    // Use findCallers for className-scoped or method queries (sophisticated binding resolution)
    // Fall back to usages-based approach for simple function queries (backward compatible)
    let callSites;
    if (options.className || defIsMethod) {
        // findCallers has proper method call resolution (self/this, binding IDs, receiver checks)
        let callerResults = index.findCallers(name, {
            includeMethods: true,
            includeUncertain: false,
            targetDefinitions: [def],
        });

        // When the target definition has a className (including Go/Rust methods which
        // now get className from receiver), filter out method calls whose receiver
        // clearly belongs to a different type. This helps with common method names
        // like .close(), .get() etc. where many types have the same method.
        if (def.className) {
            const targetClassName = def.className;
            // Pre-compute how many types share this method name
            const _impMethodDefs = index.symbols.get(name);
            const _impClassNames = new Set();
            if (_impMethodDefs) {
                for (const d of _impMethodDefs) {
                    if (d.className) _impClassNames.add(d.className);
                    else if (d.receiver) _impClassNames.add(d.receiver.replace(/^\*/, ''));
                }
            }
            callerResults = callerResults.filter(c => {
                // Keep non-method calls and self/this/cls calls (already resolved by findCallers)
                if (!c.isMethod) return true;
                const r = c.receiver;
                if (r && ['self', 'cls', 'this', 'super'].includes(r)) return true;
                // Use receiverType from findCallers when available (Go/Java/Rust type inference)
                if (c.receiverType) {
                    return c.receiverType === targetClassName;
                }
                // No receiver (chained/complex expression): only include if method is
                // unique or rare across types — otherwise too many false positives
                if (!r) {
                    return _impClassNames.size <= 1;
                }
                // Check if receiver matches the target class name (case-insensitive camelCase convention)
                if (r.toLowerCase().includes(targetClassName.toLowerCase())) return true;
                // Check if receiver is an instance of the target class using local variable type inference
                if (c.callerFile) {
                    const callerDef = c.callerStartLine ? { file: c.callerFile, startLine: c.callerStartLine, endLine: c.callerEndLine } : null;
                    if (callerDef) {
                        const callerCalls = index.getCachedCalls(c.callerFile);
                        if (callerCalls && Array.isArray(callerCalls)) {
                            const localTypes = new Map();
                            for (const call of callerCalls) {
                                if (call.line >= callerDef.startLine && call.line <= callerDef.endLine) {
                                    if (!call.isMethod && !call.receiver) {
                                        const syms = index.symbols.get(call.name);
                                        if (syms && syms.some(s => s.type === 'class')) {
                                            // Found a constructor call — check for assignment pattern
                                            const fileEntry = index.files.get(c.callerFile);
                                            if (fileEntry) {
                                                const content = index._readFile(c.callerFile);
                                                const lines = content.split('\n');
                                                const line = lines[call.line - 1] || '';
                                                // Match "var = ClassName(...)" or "var = new ClassName(...)" or "Type var = new ClassName<>(...)"
                                                const m = line.match(/(\w+)\s*=\s*(?:await\s+)?(?:new\s+)?(\w+)\s*(?:<[^>]*>)?\s*\(/);
                                                if (m && m[2] === call.name) {
                                                    localTypes.set(m[1], call.name);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            const receiverType = localTypes.get(r);
                            if (receiverType) {
                                return receiverType === targetClassName;
                            }
                        }
                    }
                }
                // Check class field declarations for receiver type: private DataService service
                if (c.callerFile) {
                    const callerEnclosing = index.findEnclosingFunction(c.callerFile, c.line, true);
                    if (callerEnclosing?.className) {
                        const classSyms = index.symbols.get(callerEnclosing.className);
                        if (classSyms) {
                            const classDef = classSyms.find(s => s.type === 'class' || s.type === 'struct' || s.type === 'interface');
                            if (classDef) {
                                const content = index._readFile(c.callerFile);
                                const lines = content.split('\n');
                                // Scan class body for field declarations matching the receiver
                                for (let li = classDef.startLine - 1; li < (classDef.endLine || classDef.startLine + 50) && li < lines.length; li++) {
                                    const line = lines[li];
                                    // Match Java/TS field: [modifiers] TypeName<...> receiverName [= ...]
                                    const fieldMatch = line.match(new RegExp(`\\b(\\w+)(?:<[^>]*>)?\\s+${r.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&')}\\s*[;=]`));
                                    if (fieldMatch) {
                                        const fieldType = fieldMatch[1];
                                        if (fieldType === targetClassName) return true;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                // Check parameter type annotations: def foo(tracker: SourceTracker) → tracker.record()
                if (c.callerFile && c.callerStartLine) {
                    const callerSymbol = index.findEnclosingFunction(c.callerFile, c.line, true);
                    if (callerSymbol && callerSymbol.paramsStructured) {
                        for (const param of callerSymbol.paramsStructured) {
                            if (param.name === r && param.type) {
                                // Check if the type annotation contains the target class name
                                const typeMatches = param.type.match(/\b([A-Za-z_]\w*)\b/g);
                                if (typeMatches && typeMatches.some(t => t === targetClassName)) {
                                    return true;
                                }
                                // Type annotation exists but doesn't match target class — filter out
                                return false;
                            }
                        }
                    }
                }
                // Unique method heuristic: if the called method exists on exactly one class/type
                // and it matches the target, include the call (no other class could match)
                if (_impClassNames.size === 1 && _impClassNames.has(targetClassName)) {
                    return true;
                }
                // Type-scoped query but receiver type unknown — filter it out.
                // Unknown receivers are likely unrelated.
                return false;
            });
        }

        callSites = [];
        for (const c of callerResults) {
            const analysis = index.analyzeCallSite(
                { file: c.file, relativePath: c.relativePath, line: c.line, content: c.content },
                name
            );
            callSites.push({
                file: c.relativePath,
                line: c.line,
                expression: c.content.trim(),
                callerName: c.callerName,
                ...analysis
            });
        }
        index._clearTreeCache();
    } else {
        // Use findCallers (benefits from callee index) instead of usages() for speed
        const callerResults = index.findCallers(name, {
            includeMethods: false,
            includeUncertain: false,
            targetDefinitions: [def],
        });
        const targetBindingId = def.bindingId;
        // Convert findCallers results to the format expected by analyzeCallSite
        const calls = callerResults.map(c => ({
            file: c.file,
            relativePath: c.relativePath,
            line: c.line,
            content: c.content,
            usageType: 'call',
            callerName: c.callerName,
        }));
        // Keep the same binding filter for backward compat (findCallers already handles this,
        // but cross-check with usages-based binding filter for safety)
        const filteredCalls = calls.filter(u => {
            const fileEntry = index.files.get(u.file);
            if (fileEntry && targetBindingId) {
                let localBindings = (fileEntry.bindings || []).filter(b => b.name === name);
                if (localBindings.length === 0 && langTraits(fileEntry.language)?.packageScope === 'directory') {
                    const dir = path.dirname(u.file);
                    for (const [fp, fe] of index.files) {
                        if (fp !== u.file && path.dirname(fp) === dir) {
                            const sibling = (fe.bindings || []).filter(b => b.name === name);
                            localBindings = localBindings.concat(sibling);
                        }
                    }
                }
                if (localBindings.length > 0 && !localBindings.some(b => b.id === targetBindingId)) {
                    return false;
                }
            }
            return true;
        });
        // (findCallers already handles binding resolution and scope-aware filtering)

        // Analyze each call site, filtering out method calls for non-method definitions
        callSites = [];
        const defFileEntry = index.files.get(def.file);
        const defLang = defFileEntry?.language;
        const targetDir = defLang === 'go' ? path.basename(path.dirname(def.file)) : null;
        for (const call of filteredCalls) {
            const analysis = index.analyzeCallSite(call, name);
            // Skip method calls (obj.parse()) when target is a standalone function (parse())
            // For Go, allow calls where receiver matches the package directory name
            // (e.g., controller.FilterActive() where file is in pkg/controller/)
            if (analysis.isMethodCall && !defIsMethod) {
                if (targetDir) {
                    // Get receiver from parsed calls cache
                    const parsedCalls = index.getCachedCalls(call.file);
                    const matchedCall = parsedCalls?.find(c => c.name === name && c.line === call.line);
                    if (matchedCall?.receiver === targetDir) {
                        // Receiver matches package directory — keep it
                    } else {
                        continue;
                    }
                } else {
                    continue;
                }
            }
            callSites.push({
                file: call.relativePath,
                line: call.line,
                expression: call.content.trim(),
                callerName: call.callerName || index.findEnclosingFunction(call.file, call.line),
                ...analysis
            });
        }
        index._clearTreeCache();
    }

    // Apply exclude filter
    let filteredSites = callSites;
    if (options.exclude && options.exclude.length > 0) {
        filteredSites = callSites.filter(s => index.matchesFilters(s.file, { exclude: options.exclude }));
    }

    // Apply top limit if specified (limits total call sites shown)
    const totalBeforeLimit = filteredSites.length;
    if (options.top && options.top > 0 && filteredSites.length > options.top) {
        filteredSites = filteredSites.slice(0, options.top);
    }

    // Group by file
    const byFile = new Map();
    for (const site of filteredSites) {
        if (!byFile.has(site.file)) {
            byFile.set(site.file, []);
        }
        byFile.get(site.file).push(site);
    }

    // Identify patterns
    const patterns = index.identifyCallPatterns(filteredSites, name);

    // Detect scope pollution: multiple class definitions for the same method name
    let scopeWarning = null;
    if (defIsMethod) {
        const allDefs = index.symbols.get(name);
        if (allDefs && allDefs.length > 1) {
            const classNames = [...new Set(allDefs
                .filter(d => d.className && d.className !== def.className)
                .map(d => d.className))];
            if (classNames.length > 0 && !options.className && !options.file) {
                scopeWarning = {
                    targetClass: def.className || '(unknown)',
                    otherClasses: classNames,
                    hint: `Results may include calls to ${classNames.join(', ')}.${name}(). Use file= or className= to narrow scope.`
                };
            }
        }
    }

    return {
        function: name,
        file: def.relativePath,
        startLine: def.startLine,
        signature: index.formatSignature(def),
        params: def.params,
        paramsStructured: def.paramsStructured,
        totalCallSites: totalBeforeLimit,
        shownCallSites: filteredSites.length,
        byFile: Array.from(byFile.entries()).map(([file, sites]) => ({
            file,
            count: sites.length,
            sites
        })),
        patterns,
        scopeWarning
    };
    } finally { index._endOp(); }
}

/**
 * About: comprehensive symbol metadata — definition, usages, callers, callees, tests, code.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Symbol name
 * @param {object} options - { file, className, all, maxCallers, maxCallees, withCode, withTypes,
 *                             includeMethods, includeUncertain, includeTests, exclude, minConfidence }
 * @returns {object|null}
 */
function about(index, name, options = {}) {
    index._beginOp();
    try {
    const maxCallers = options.all ? Infinity : (options.maxCallers || 10);
    const maxCallees = options.all ? Infinity : (options.maxCallees || 10);

    // Find symbol definition(s) — skip counts since about() computes its own via usages()
    const definitions = index.find(name, { exact: true, file: options.file, className: options.className, skipCounts: true });
    if (definitions.length === 0) {
        // Try fuzzy match (needs counts for suggestion ranking)
        const fuzzy = index.find(name, { file: options.file, className: options.className });
        if (fuzzy.length === 0) {
            return null;
        }
        // Return suggestion
        return {
            found: false,
            suggestions: (options.all ? fuzzy : fuzzy.slice(0, 5)).map(s => ({
                name: s.name,
                file: s.relativePath,
                line: s.startLine,
                type: s.type,
                usageCount: s.usageCount
            }))
        };
    }

    // Use resolveSymbol for consistent primary selection (prefers non-test files)
    const { def: resolved } = index.resolveSymbol(name, { file: options.file, className: options.className });
    const primary = resolved || definitions[0];
    const others = definitions.filter(d =>
        d.relativePath !== primary.relativePath || d.startLine !== primary.startLine
    );

    // Use the actual symbol name (may differ from query if fuzzy matched)
    const symbolName = primary.name;

    // Default includeMethods: true when target is a class method (method calls are the primary way
    // class methods are invoked), false for standalone functions (reduces noise from unrelated obj.fn() calls)
    const isMethod = !!(primary.isMethod || primary.type === 'method' || primary.className);
    const includeMethods = options.includeMethods ?? isMethod;

    // Get usage counts by type (fast path uses callee index, no file reads)
    // Exclude test files by default (matching usages command behavior)
    const countExclude = !options.includeTests ? addTestExclusions(options.exclude) : options.exclude;
    const usagesByType = index.countSymbolUsages(primary, { exclude: countExclude });

    // Get callers and callees (only for functions)
    let callers = [];
    let callees = [];
    let allCallers = null;
    let allCallees = null;
    let aboutConfFiltered = 0;
    if (primary.type === 'function' || primary.params !== undefined) {
        // Use maxResults to limit file iteration (with buffer for exclude filtering)
        const callerCap = maxCallers === Infinity ? undefined : maxCallers * 3;
        allCallers = index.findCallers(symbolName, { includeMethods, includeUncertain: options.includeUncertain, targetDefinitions: [primary], maxResults: callerCap });
        // Apply exclude filter before slicing
        if (options.exclude && options.exclude.length > 0) {
            allCallers = allCallers.filter(c => index.matchesFilters(c.relativePath, { exclude: options.exclude }));
        }
        // Apply confidence filtering before slicing
        if (options.minConfidence > 0) {
            const { filterByConfidence } = require('./confidence');
            const callerResult = filterByConfidence(allCallers, options.minConfidence);
            allCallers = callerResult.kept;
            aboutConfFiltered += callerResult.filtered;
        }
        callers = allCallers.slice(0, maxCallers).map(c => ({
            file: c.relativePath,
            line: c.line,
            expression: c.content.trim(),
            callerName: c.callerName,
            confidence: c.confidence,
            resolution: c.resolution,
        }));

        allCallees = index.findCallees(primary, { includeMethods, includeUncertain: options.includeUncertain });
        // Apply exclude filter before slicing
        if (options.exclude && options.exclude.length > 0) {
            allCallees = allCallees.filter(c => index.matchesFilters(c.relativePath, { exclude: options.exclude }));
        }
        // Apply confidence filtering before slicing
        if (options.minConfidence > 0) {
            const { filterByConfidence } = require('./confidence');
            const calleeResult = filterByConfidence(allCallees, options.minConfidence);
            allCallees = calleeResult.kept;
            aboutConfFiltered += calleeResult.filtered;
        }
        callees = allCallees.slice(0, maxCallees).map(c => ({
            name: c.name,
            file: c.relativePath,
            line: c.startLine,
            startLine: c.startLine,
            endLine: c.endLine,
            weight: c.weight,
            callCount: c.callCount,
            confidence: c.confidence,
            resolution: c.resolution,
        }));
    }

    // Find tests — scope to the same file/class as the primary definition
    const tests = index.tests(symbolName, {
        file: options.file,
        className: options.className || primary.className,
        exclude: options.exclude,
    });
    const testSummary = {
        fileCount: tests.length,
        totalMatches: tests.reduce((sum, t) => sum + t.matches.length, 0),
        files: (options.all ? tests : tests.slice(0, 3)).map(t => t.file)
    };

    // Extract code if requested (default: true)
    let code = null;
    if (options.withCode !== false) {
        code = index.extractCode(primary);
    }

    // Get type definitions if requested
    let types = [];
    if (options.withTypes) {
        const TYPE_KINDS = ['type', 'interface', 'class', 'struct'];
        const seen = new Set();

        const addType = (typeName) => {
            if (seen.has(typeName)) return;
            seen.add(typeName);
            const typeSymbols = index.symbols.get(typeName);
            if (typeSymbols) {
                for (const sym of typeSymbols) {
                    if (TYPE_KINDS.includes(sym.type)) {
                        types.push({
                            name: sym.name,
                            type: sym.type,
                            file: sym.relativePath,
                            line: sym.startLine
                        });
                    }
                }
            }
        };

        // From signature annotations
        const typeNames = index.extractTypeNames(primary);
        for (const typeName of typeNames) addType(typeName);

        // From callee signatures — types used by functions this function calls
        if (allCallees) {
            for (const callee of allCallees) {
                const calleeTypeNames = index.extractTypeNames(callee);
                for (const tn of calleeTypeNames) addType(tn);
            }
        }
    }

    const result = {
        found: true,
        symbol: {
            name: primary.name,
            type: primary.type,
            file: primary.relativePath,
            startLine: primary.startLine,
            endLine: primary.endLine,
            params: primary.params,
            returnType: primary.returnType,
            modifiers: primary.modifiers,
            docstring: primary.docstring,
            signature: index.formatSignature(primary)
        },
        usages: usagesByType,
        totalUsages: usagesByType.calls + usagesByType.imports + usagesByType.references,
        callers: {
            total: allCallers?.length ?? 0,
            top: callers
        },
        callees: {
            total: allCallees?.length ?? 0,
            top: callees
        },
        tests: testSummary,
        otherDefinitions: (options.all ? others : others.slice(0, 3)).map(d => ({
            file: d.relativePath,
            line: d.startLine,
            usageCount: d.usageCount ?? index.countSymbolUsages(d).total
        })),
        types,
        code,
        includeMethods,
        ...(aboutConfFiltered > 0 && { confidenceFiltered: aboutConfFiltered }),
        completeness: detectCompleteness(index)
    };

    return result;
    } finally { index._endOp(); }
}

/**
 * Diff-based impact analysis: find which functions changed and who calls them.
 *
 * @param {object} index - ProjectIndex instance
 * @param {object} options - { base, staged, file }
 * @returns {object}
 */
function diffImpact(index, options = {}) {
    index._beginOp();
    try {
    const { base = 'HEAD', staged = false, file } = options;

    // Validate base ref format to prevent argument injection
    if (base && !/^[a-zA-Z0-9._\-~\/^@{}:]+$/.test(base)) {  // eslint-disable-line no-useless-escape
        throw new Error(`Invalid git ref format: ${base}`);
    }

    // Verify git repo
    let gitRoot;
    try {
        gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: index.root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) {
        throw new Error('Not a git repository. diff-impact requires git.', { cause: e });
    }

    // Build git diff command (use execFileSync to avoid shell expansion)
    const diffArgs = ['diff', '--unified=0'];
    if (staged) {
        diffArgs.push('--staged');
    } else {
        diffArgs.push(base);
    }
    if (file) {
        diffArgs.push('--', file);
    }

    let diffText;
    try {
        diffText = execFileSync('git', diffArgs, { cwd: index.root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    } catch (e) {
        // git diff exits non-zero when there are diff errors, but also for invalid refs
        if (e.stdout) {
            diffText = e.stdout;
        } else {
            throw new Error(`git diff failed: ${e.message}`, { cause: e });
        }
    }

    if (!diffText || !diffText.trim()) {
        return {
            base: staged ? '(staged)' : base,
            functions: [],
            moduleLevelChanges: [],
            newFunctions: [],
            deletedFunctions: [],
            summary: { modifiedFunctions: 0, deletedFunctions: 0, newFunctions: 0, totalCallSites: 0, affectedFiles: 0 }
        };
    }

    // Diff paths are git-root-relative. Resolve to index.root for file lookup.
    // Normalize both through realpath to handle macOS /var → /private/var symlinks.
    let realGitRoot, realProjectRoot;
    try { realGitRoot = fs.realpathSync(gitRoot); } catch (_) { realGitRoot = gitRoot; }
    try { realProjectRoot = fs.realpathSync(index.root); } catch (_) { realProjectRoot = index.root; }
    const projectPrefix = realGitRoot === realProjectRoot
        ? ''
        : path.relative(realGitRoot, realProjectRoot);

    const rawChanges = parseDiff(diffText, gitRoot);
    // Filter to files under index.root and remap paths.
    // Preserve gitRelativePath (repo-relative) for git show commands.
    const changes = [];
    for (const c of rawChanges) {
        if (projectPrefix && !c.relativePath.startsWith(projectPrefix + '/')) continue;
        const localRel = projectPrefix ? c.relativePath.slice(projectPrefix.length + 1) : c.relativePath;
        changes.push({ ...c, gitRelativePath: c.relativePath, filePath: path.join(index.root, localRel), relativePath: localRel });
    }

    const functions = [];
    const moduleLevelChanges = [];
    const newFunctions = [];
    const deletedFunctions = [];
    const callerFileSet = new Set();
    let totalCallSites = 0;

    for (const change of changes) {
        const lang = detectLanguage(change.filePath);
        if (!lang) continue;

        const fileEntry = index.files.get(change.filePath);

        // Handle deleted files: entire file was removed, all functions are deleted
        if (!fileEntry) {
            if (change.isDeleted && change.deletedLines.length > 0) {
                const ref = staged ? 'HEAD' : base;
                try {
                    const oldContent = execFileSync(
                        'git', ['show', `${ref}:${change.gitRelativePath}`],
                        { cwd: index.root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
                    );
                    const oldParsed = parse(oldContent, lang);
                    for (const oldFn of extractCallableSymbols(oldParsed)) {
                        deletedFunctions.push({
                            name: oldFn.name,
                            filePath: change.filePath,
                            relativePath: change.relativePath,
                            startLine: oldFn.startLine
                        });
                    }
                } catch (e) {
                    // git show failed — skip
                }
            }
            continue;
        }

        // Track which functions are affected by added/modified lines
        const affectedSymbols = new Map(); // symbolName -> { symbol, addedLines, deletedLines }

        for (const line of change.addedLines) {
            const symbol = index.findEnclosingFunction(change.filePath, line, true);
            if (symbol) {
                const key = `${symbol.name}:${symbol.startLine}`;
                if (!affectedSymbols.has(key)) {
                    affectedSymbols.set(key, { symbol, addedLines: [], deletedLines: [] });
                }
                affectedSymbols.get(key).addedLines.push(line);
            } else {
                // Module-level change
                const existing = moduleLevelChanges.find(m => m.filePath === change.filePath);
                if (existing) {
                    existing.addedLines.push(line);
                } else {
                    moduleLevelChanges.push({
                        filePath: change.filePath,
                        relativePath: change.relativePath,
                        addedLines: [line],
                        deletedLines: []
                    });
                }
            }
        }

        for (const line of change.deletedLines) {
            // For deleted lines, we can't use findEnclosingFunction on the current file
            // since those lines no longer exist. Track as module-level unless they map
            // to a function that still exists (the function was modified, not deleted).
            // We approximate: if a deleted line is within the range of a known symbol, it's a modification.
            let matched = false;
            for (const symbol of fileEntry.symbols) {
                if (NON_CALLABLE_TYPES.has(symbol.type)) continue;
                // Use a generous range — deleted lines near a function likely belong to it
                if (line >= symbol.startLine - 2 && line <= symbol.endLine + 2) {
                    const key = `${symbol.name}:${symbol.startLine}`;
                    if (!affectedSymbols.has(key)) {
                        affectedSymbols.set(key, { symbol, addedLines: [], deletedLines: [] });
                    }
                    affectedSymbols.get(key).deletedLines.push(line);
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                const existing = moduleLevelChanges.find(m => m.filePath === change.filePath);
                if (existing) {
                    existing.deletedLines.push(line);
                } else {
                    moduleLevelChanges.push({
                        filePath: change.filePath,
                        relativePath: change.relativePath,
                        addedLines: [],
                        deletedLines: [line]
                    });
                }
            }
        }

        // Detect new functions: all added lines are within a single function range
        // and the function didn't exist before (approximation: all lines in the function are added)
        for (const [key, data] of affectedSymbols) {
            const { symbol, addedLines } = data;
            const fnLineCount = symbol.endLine - symbol.startLine + 1;
            if (addedLines.length >= fnLineCount * 0.8 && data.deletedLines.length === 0) {
                newFunctions.push({
                    name: symbol.name,
                    filePath: change.filePath,
                    relativePath: change.relativePath,
                    startLine: symbol.startLine,
                    endLine: symbol.endLine,
                    signature: index.formatSignature(symbol)
                });
                affectedSymbols.delete(key);
            }
        }

        // Detect deleted functions: compare old file symbols with current by identity.
        // Uses name+className counts to handle overloads (e.g. Java method overloading).
        if (change.deletedLines.length > 0) {
            const ref = staged ? 'HEAD' : base;
            try {
                const oldContent = execFileSync(
                    'git', ['show', `${ref}:${change.gitRelativePath}`],
                    { cwd: index.root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
                );
                const fileLang = detectLanguage(change.filePath);
                if (fileLang) {
                    const oldParsed = parse(oldContent, fileLang);
                    // Count current symbols by identity (name + className)
                    const currentCounts = new Map();
                    for (const s of fileEntry.symbols) {
                        if (NON_CALLABLE_TYPES.has(s.type)) continue;
                        const key = `${s.name}\0${s.className || ''}`;
                        currentCounts.set(key, (currentCounts.get(key) || 0) + 1);
                    }
                    // Count old symbols by identity and detect deletions
                    const oldCounts = new Map();
                    const oldSymbols = extractCallableSymbols(oldParsed);
                    for (const oldFn of oldSymbols) {
                        const key = `${oldFn.name}\0${oldFn.className || ''}`;
                        oldCounts.set(key, (oldCounts.get(key) || 0) + 1);
                    }
                    // For each identity, if old count > current count, the difference are deletions
                    for (const [key, oldCount] of oldCounts) {
                        const curCount = currentCounts.get(key) || 0;
                        if (oldCount > curCount) {
                            // Find the specific old symbols with this identity that were deleted
                            const matching = oldSymbols.filter(s => `${s.name}\0${s.className || ''}` === key);
                            // Report the extra ones (by startLine descending — later ones more likely deleted)
                            const toReport = matching.slice(curCount);
                            for (const oldFn of toReport) {
                                deletedFunctions.push({
                                    name: oldFn.name,
                                    filePath: change.filePath,
                                    relativePath: change.relativePath,
                                    startLine: oldFn.startLine
                                });
                            }
                        }
                    }
                }
            } catch (e) {
                // File didn't exist in base, or git error — skip
            }
        }

        // For each affected function, find callers
        for (const [, data] of affectedSymbols) {
            const { symbol, addedLines: aLines, deletedLines: dLines } = data;

            // Get the specific definitions matching this symbol
            const allDefs = index.symbols.get(symbol.name) || [];
            const targetDefs = allDefs.filter(d => d.file === change.filePath && d.startLine === symbol.startLine);

            let callers = index.findCallers(symbol.name, {
                targetDefinitions: targetDefs.length > 0 ? targetDefs : undefined,
                includeMethods: true,
                includeUncertain: false,
            });

            // For Go/Java/Rust methods with a className, filter callers whose
            // receiver clearly belongs to a different type (same logic as impact()).
            const targetDef = targetDefs[0] || symbol;
            if (targetDef.className && langTraits(lang)?.typeSystem === 'nominal') {
                const targetClassName = targetDef.className;
                // Pre-compute how many types share this method name
                const methodDefs = index.symbols.get(symbol.name);
                const classNames = new Set();
                if (methodDefs) {
                    for (const d of methodDefs) {
                        if (d.className) classNames.add(d.className);
                        else if (d.receiver) classNames.add(d.receiver.replace(/^\*/, ''));
                    }
                }
                const isWidelyShared = classNames.size > 3;
                callers = callers.filter(c => {
                    if (!c.isMethod) return true;
                    const r = c.receiver;
                    if (r && ['self', 'cls', 'this', 'super'].includes(r)) return true;
                    // No receiver (chained/complex expression): only include if method is
                    // unique or rare across types — otherwise too many false positives
                    if (!r) {
                        return classNames.size <= 1;
                    }
                    // Use receiverType from findCallers when available
                    if (c.receiverType) {
                        return c.receiverType === targetClassName ||
                               c.receiverType === targetDef.receiver?.replace(/^\*/, '');
                    }
                    // Unique method heuristic: if the method exists on exactly one class/type, include
                    if (classNames.size === 1 && classNames.has(targetClassName)) return true;
                    // For widely shared method names (Get, Set, Run, etc.), require same-package
                    // evidence when receiver type is unknown
                    if (isWidelyShared) {
                        const callerFile = c.file || '';
                        const targetDir = path.dirname(change.filePath);
                        return path.dirname(callerFile) === targetDir;
                    }
                    // Unknown receiver + multiple classes with this method → filter out
                    return false;
                });
            }

            for (const c of callers) {
                callerFileSet.add(c.file);
            }
            totalCallSites += callers.length;

            functions.push({
                name: symbol.name,
                filePath: change.filePath,
                relativePath: change.relativePath,
                startLine: symbol.startLine,
                endLine: symbol.endLine,
                signature: index.formatSignature(symbol),
                addedLines: aLines,
                deletedLines: dLines,
                callers: callers.map(c => ({
                    file: c.file,
                    relativePath: c.relativePath,
                    line: c.line,
                    callerName: c.callerName,
                    content: c.content.trim()
                }))
            });
        }
    }

    return {
        base: staged ? '(staged)' : base,
        functions,
        moduleLevelChanges,
        newFunctions,
        deletedFunctions,
        summary: {
            modifiedFunctions: functions.length,
            deletedFunctions: deletedFunctions.length,
            newFunctions: newFunctions.length,
            totalCallSites,
            affectedFiles: callerFileSet.size
        }
    };
    } finally { index._endOp(); }
}

// ========================================================================
// STANDALONE HELPERS (used by diffImpact and parseDiff)
// ========================================================================

/**
 * Extract all callable symbols (functions + class methods) from a parse result,
 * matching how indexFile builds the symbol list. Methods get className added.
 * @param {object} parsed - Result from parse()
 * @returns {Array<{name, className, startLine}>}
 */
function extractCallableSymbols(parsed) {
    const symbols = [];
    for (const fn of parsed.functions) {
        symbols.push({ name: fn.name, className: fn.className || '', startLine: fn.startLine });
    }
    for (const cls of parsed.classes) {
        if (cls.members) {
            for (const m of cls.members) {
                symbols.push({ name: m.name, className: cls.name, startLine: m.startLine });
            }
        }
    }
    return symbols;
}

/**
 * Unquote a git diff path: unescape C-style backslash sequences and strip tab metadata.
 * Git quotes paths containing special chars as "a/path\"with\"quotes".
 * @param {string} raw - Raw path string (may contain backslash escapes)
 * @returns {string} Unquoted path
 */
function unquoteDiffPath(raw) {
    const ESCAPES = { '\\\\': '\\', '\\"': '"', '\\n': '\n', '\\t': '\t' };
    return raw
        .split('\t')[0]
        .replace(/\\[\\"nt]/g, m => ESCAPES[m]);
}

/**
 * Parse unified diff output into structured change data
 * @param {string} diffText - Output from `git diff --unified=0`
 * @param {string} root - Project root directory
 * @returns {Array<{ filePath, relativePath, addedLines, deletedLines }>}
 */
function parseDiff(diffText, root) {
    const changes = [];
    let currentFile = null;
    let pendingOldPath = null; // Track --- a/ path for deleted files

    for (const line of diffText.split('\n')) {
        // Track old file path from --- header for deleted-file detection
        // Handles both unquoted (--- a/path) and quoted (--- "a/path") formats
        const oldMatch = line.match(/^--- (?:"a\/((?:[^"\\]|\\.)*)"|a\/(.+?))\s*$/);
        if (oldMatch) {
            const raw = oldMatch[1] !== undefined ? oldMatch[1] : oldMatch[2];
            pendingOldPath = unquoteDiffPath(raw);
            continue;
        }

        // Match file header: +++ b/path or +++ "b/path" or +++ /dev/null
        if (line.startsWith('+++ ')) {
            let relativePath;
            const isDevNull = line.startsWith('+++ /dev/null');
            if (isDevNull) {
                // File was deleted — use the --- a/ path
                if (!pendingOldPath) continue;
                relativePath = pendingOldPath;
            } else {
                const newMatch = line.match(/^\+\+\+ (?:"b\/((?:[^"\\]|\\.)*)"|b\/(.+?))\s*$/);
                if (!newMatch) continue;
                const raw = newMatch[1] !== undefined ? newMatch[1] : newMatch[2];
                relativePath = unquoteDiffPath(raw);
            }
            pendingOldPath = null;
            currentFile = {
                filePath: path.join(root, relativePath),
                relativePath,
                addedLines: [],
                deletedLines: [],
                ...(isDevNull && { isDeleted: true })
            };
            changes.push(currentFile);
            continue;
        }

        // Match hunk header: @@ -old,count +new,count @@
        if (line.startsWith('@@') && currentFile) {
            const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (match) {
                const oldStart = parseInt(match[1], 10);
                const oldCount = parseInt(match[2] || '1', 10);
                const newStart = parseInt(match[3], 10);
                const newCount = parseInt(match[4] || '1', 10);

                // Deleted lines (from old file)
                if (oldCount > 0) {
                    for (let i = 0; i < oldCount; i++) {
                        currentFile.deletedLines.push(oldStart + i);
                    }
                }

                // Added lines (in new file)
                if (newCount > 0) {
                    for (let i = 0; i < newCount; i++) {
                        currentFile.addedLines.push(newStart + i);
                    }
                }
            }
        }
    }

    return changes;
}

module.exports = {
    context,
    smart,
    detectCompleteness,
    related,
    impact,
    about,
    diffImpact,
    parseDiff,
    extractCallableSymbols,
    unquoteDiffPath,
};
