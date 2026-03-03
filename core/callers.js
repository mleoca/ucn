/**
 * core/callers.js - Call graph resolution (callers, callees, callbacks)
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { detectLanguage, getParser, getLanguageModule } = require('../languages');
const { isTestFile } = require('./discovery');
const { NON_CALLABLE_TYPES } = require('./shared');

/**
 * Get cached call sites for a file, with mtime/hash validation
 * Uses mtime for fast cache validation, falls back to hash if mtime matches but content changed
 * @param {object} index - ProjectIndex instance
 * @param {string} filePath - Path to the file
 * @param {object} [options] - Options
 * @param {boolean} [options.includeContent] - Also return file content (avoids double read)
 * @returns {Array|null|{calls: Array, content: string}} Array of calls, or object with content if requested
 */
function getCachedCalls(index, filePath, options = {}) {
    try {
        const cached = index.callsCache.get(filePath);

        // Fast path: check mtime first (stat is much faster than read+hash)
        const stat = fs.statSync(filePath);
        const mtime = stat.mtimeMs;

        if (cached && cached.mtime === mtime) {
            // mtime matches - cache is likely valid
            if (options.includeContent) {
                // Need content, read if not cached
                const content = cached.content || index._readFile(filePath);
                return { calls: cached.calls, content };
            }
            return cached.calls;
        }

        // mtime changed or no cache - need to read and possibly reparse
        const content = index._readFile(filePath);
        const hash = crypto.createHash('md5').update(content).digest('hex');

        // Check if content actually changed (mtime can change without content change)
        if (cached && cached.hash === hash) {
            // Content unchanged, just update mtime
            cached.mtime = mtime;
            cached.content = options.includeContent ? content : undefined;
            index.callsCacheDirty = true;
            if (options.includeContent) {
                return { calls: cached.calls, content };
            }
            return cached.calls;
        }

        // Content changed - need to reparse
        const language = detectLanguage(filePath);
        if (!language) return null;

        const langModule = getLanguageModule(language);
        if (!langModule.findCallsInCode) return null;

        const parser = getParser(language);
        const calls = langModule.findCallsInCode(content, parser);

        index.callsCache.set(filePath, {
            mtime,
            hash,
            calls,
            content: options.includeContent ? content : undefined
        });
        index.callsCacheDirty = true;

        if (options.includeContent) {
            return { calls, content };
        }
        return calls;
    } catch (e) {
        return null;
    }
}

/**
 * Find all callers of a function using AST-based detection
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name to find callers for
 * @param {object} [options] - Options
 * @param {boolean} [options.includeMethods] - Include method calls (default: false)
 */
function findCallers(index, name, options = {}) {
    index._beginOp();
    try {
    const callers = [];
    const stats = options.stats;

    // Get definition lines to exclude them
    const definitions = index.symbols.get(name) || [];
    const definitionLines = new Set();
    for (const def of definitions) {
        definitionLines.add(`${def.file}:${def.startLine}`);
    }

    for (const [filePath, fileEntry] of index.files) {
        try {
            const result = getCachedCalls(index, filePath, { includeContent: true });
            if (!result) continue;

            const { calls, content } = result;
            const lines = content.split('\n');

            for (const call of calls) {
                // Skip if not matching our target name (also check alias resolution)
                if (call.name !== name && call.resolvedName !== name &&
                    !(call.resolvedNames && call.resolvedNames.includes(name))) continue;

                // For potential callbacks (function passed as arg), validate against symbol table
                // and skip complex binding resolution — just check the name exists
                if (call.isPotentialCallback) {
                    const syms = definitions;
                    if (!syms || syms.length === 0) continue;
                    // Find the enclosing function
                    const callerSymbol = index.findEnclosingFunction(filePath, call.line, true);
                    callers.push({
                        file: filePath,
                        relativePath: fileEntry.relativePath,
                        line: call.line,
                        content: lines[call.line - 1] || '',
                        callerName: callerSymbol ? callerSymbol.name : null,
                        callerFile: callerSymbol ? filePath : null,
                        callerStartLine: callerSymbol ? callerSymbol.startLine : null,
                        callerEndLine: callerSymbol ? callerSymbol.endLine : null,
                        isMethod: false,
                        isFunctionReference: true
                    });
                    continue;
                }

                // Resolve binding within this file (without mutating cached call objects)
                let bindingId = call.bindingId;
                let isUncertain = call.uncertain;
                if (!bindingId) {
                    let bindings = (fileEntry.bindings || []).filter(b => b.name === call.name);
                    // For Go, also check sibling files in same directory (same package scope)
                    if (bindings.length === 0 && fileEntry.language === 'go') {
                        const dir = path.dirname(filePath);
                        for (const [fp, fe] of index.files) {
                            if (fp !== filePath && path.dirname(fp) === dir) {
                                const sibling = (fe.bindings || []).filter(b => b.name === call.name);
                                bindings = bindings.concat(sibling);
                            }
                        }
                    }
                    if (bindings.length === 1) {
                        bindingId = bindings[0].id;
                    } else if (bindings.length > 1 && !call.isMethod) {
                        // For implicit same-class calls (Java: execute() means this.execute()),
                        // try to resolve via caller's className before marking uncertain
                        const callerSym = index.findEnclosingFunction(filePath, call.line, true);
                        if (callerSym?.className) {
                            const callSymbols = index.symbols.get(call.name);
                            const sameClassSym = callSymbols?.find(s => s.className === callerSym.className);
                            if (sameClassSym) {
                                const matchingBinding = bindings.find(b => b.startLine === sameClassSym.startLine);
                                bindingId = matchingBinding?.id || sameClassSym.bindingId;
                            } else {
                                isUncertain = true;
                            }
                        } else {
                            // Scope-based disambiguation for shadowed functions:
                            // When multiple bindings exist, use indent level to determine
                            // which binding is in scope at the call site
                            const defs = index.symbols.get(call.name);
                            let resolved = false;
                            if (defs) {
                                // Sort bindings by indent desc (most nested first)
                                const scopedBindings = bindings.map(b => {
                                    const sym = defs.find(s => s.startLine === b.startLine && s.file === filePath);
                                    return { ...b, indent: sym?.indent ?? 0, endLine: sym?.endLine ?? b.startLine };
                                }).sort((a, b) => b.indent - a.indent);

                                for (const sb of scopedBindings) {
                                    if (sb.indent === 0) {
                                        // Module-level binding — always in scope, use as fallback
                                        bindingId = sb.id;
                                        resolved = true;
                                        break;
                                    }
                                    // Nested binding — check if call is inside its enclosing function
                                    const enclosing = index.findEnclosingFunction(filePath, sb.startLine, true);
                                    if (enclosing && call.line >= enclosing.startLine && call.line <= enclosing.endLine) {
                                        // Call is inside the same function as this binding
                                        bindingId = sb.id;
                                        resolved = true;
                                        break;
                                    }
                                }
                            }
                            if (!resolved) isUncertain = true;
                        }
                    } else if (bindings.length > 1 && call.isMethod) {
                        // Multiple method bindings (e.g. Go String() on Reader vs Writer):
                        // Don't mark uncertain — include them even if conflated.
                        // Better to over-report than lose all callers.
                    }
                    // Method call with no binding for the method name (JS/TS/Python only):
                    // Mark uncertain unless receiver has binding evidence in file scope.
                    // Go/Java/Rust excluded: callers are used for impact analysis where
                    // over-reporting is preferred to losing callers. These languages' nominal
                    // type systems also make method links more reliable.
                    if (bindings.length === 0 && call.isMethod &&
                        fileEntry.language !== 'go' && fileEntry.language !== 'java' && fileEntry.language !== 'rust') {
                        const hasReceiverEvidence = call.receiver &&
                            (fileEntry.bindings || []).some(b => b.name === call.receiver);
                        if (!hasReceiverEvidence) {
                            isUncertain = true;
                        }
                    }
                }

                // Smart method call handling — do this BEFORE uncertain check so
                // self/this.method() calls can be resolved by same-class matching
                // even when binding is ambiguous (e.g. method exists in multiple classes)
                let resolvedBySameClass = false;
                if (call.isMethod) {
                    if (call.selfAttribute && fileEntry.language === 'python') {
                        // self.attr.method() — resolve via attribute type inference
                        const callerSymbol = index.findEnclosingFunction(filePath, call.line, true);
                        if (!callerSymbol?.className) continue;
                        const attrTypes = getInstanceAttributeTypes(index, filePath, callerSymbol.className);
                        if (!attrTypes) continue;
                        const targetClass = attrTypes.get(call.selfAttribute);
                        if (!targetClass) continue;
                        // Check if any definition of searched function belongs to targetClass
                        const matchesDef = definitions.some(d => d.className === targetClass);
                        if (!matchesDef) continue;
                        resolvedBySameClass = true;
                        // Falls through to add as caller
                    } else if (['self', 'cls', 'this', 'super'].includes(call.receiver)) {
                        // self/this/super.method() — resolve to same-class or parent method
                        const callerSymbol = index.findEnclosingFunction(filePath, call.line, true);
                        if (!callerSymbol?.className) continue;
                        // For super(), skip same-class — only check parent chain
                        let matchesDef = call.receiver === 'super'
                            ? false
                            : definitions.some(d => d.className === callerSymbol.className);
                        // Walk inheritance chain using BFS if not found in same class
                        if (!matchesDef) {
                            const visited = new Set([callerSymbol.className]);
                            const callerFile = callerSymbol.file || filePath;
                            const startParents = index._getInheritanceParents(callerSymbol.className, callerFile) || [];
                            const queue = startParents.map(p => ({ name: p, contextFile: callerFile }));
                            while (queue.length > 0 && !matchesDef) {
                                const { name: current, contextFile } = queue.shift();
                                if (visited.has(current)) continue;
                                visited.add(current);
                                matchesDef = definitions.some(d => d.className === current);
                                if (!matchesDef) {
                                    const resolvedFile = index._resolveClassFile(current, contextFile);
                                    const grandparents = index._getInheritanceParents(current, resolvedFile) || [];
                                    for (const gp of grandparents) {
                                        if (!visited.has(gp)) queue.push({ name: gp, contextFile: resolvedFile });
                                    }
                                }
                            }
                        }
                        if (!matchesDef) continue;
                        resolvedBySameClass = true;
                        // Falls through to add as caller
                    } else {
                        // Go doesn't use this/self/cls - always include Go method calls
                        // Java method calls are always obj.method() - include by default
                        // Rust Type::method() calls - include by default (associated functions)
                        // For other languages, skip method calls unless explicitly requested
                        if (fileEntry.language !== 'go' && fileEntry.language !== 'java' && fileEntry.language !== 'rust' && !options.includeMethods) continue;
                    }
                }

                // Skip uncertain calls unless resolved by same-class matching or explicitly requested
                if (isUncertain && !resolvedBySameClass && !options.includeUncertain) {
                    if (stats) stats.uncertain = (stats.uncertain || 0) + 1;
                    continue;
                }

                // Skip definition lines
                if (definitionLines.has(`${filePath}:${call.line}`)) continue;

                // If we have a binding id on definition, require match when available
                // When targetDefinitions is provided, only those definitions' bindings are valid targets
                const targetDefs = options.targetDefinitions || definitions;
                const targetBindingIds = new Set(targetDefs.map(d => d.bindingId).filter(Boolean));
                if (targetBindingIds.size > 0 && bindingId && !targetBindingIds.has(bindingId)) {
                    continue;
                }

                // Java/Go/Rust receiver-class disambiguation:
                // When targetDefinitions narrows to specific class(es) and the call has a
                // receiver (e.g. javascriptFileService.createDataFile()), check if the
                // receiver name better matches a non-target class definition.
                // This prevents false positives like reporting obj.save() as a caller of
                // TargetClass.save() when obj is clearly a different type.
                if (call.isMethod && call.receiver && !resolvedBySameClass && !bindingId &&
                    options.targetDefinitions && definitions.length > 1 &&
                    (fileEntry.language === 'java' || fileEntry.language === 'go' || fileEntry.language === 'rust')) {
                    const targetClassNames = new Set(targetDefs.map(d => d.className).filter(Boolean));
                    if (targetClassNames.size > 0) {
                        const receiverLower = call.receiver.toLowerCase();
                        // Check if receiver matches any target class (camelCase convention)
                        const matchesTarget = [...targetClassNames].some(cn => cn.toLowerCase() === receiverLower);
                        if (!matchesTarget) {
                            // Check if receiver matches a non-target class instead
                            const nonTargetClasses = definitions
                                .filter(d => d.className && !targetClassNames.has(d.className))
                                .map(d => d.className);
                            const matchesOther = nonTargetClasses.some(cn => cn.toLowerCase() === receiverLower);
                            if (matchesOther) {
                                // Receiver clearly belongs to a different class
                                isUncertain = true;
                                if (!options.includeUncertain) {
                                    if (stats) stats.uncertain = (stats.uncertain || 0) + 1;
                                    continue;
                                }
                            }
                        }
                    }
                }

                // Find the enclosing function (get full symbol info)
                const callerSymbol = index.findEnclosingFunction(filePath, call.line, true);

                callers.push({
                    file: filePath,
                    relativePath: fileEntry.relativePath,
                    line: call.line,
                    content: lines[call.line - 1] || '',
                    callerName: callerSymbol ? callerSymbol.name : null,
                    callerFile: callerSymbol ? filePath : null,
                    callerStartLine: callerSymbol ? callerSymbol.startLine : null,
                    callerEndLine: callerSymbol ? callerSymbol.endLine : null,
                    isMethod: call.isMethod || false,
                    receiver: call.receiver
                });
            }
        } catch (e) {
            // Expected: minified files exceed tree-sitter buffer, binary files fail to parse.
            // These are not actionable errors — silently skip.
        }
    }

    return callers;
    } finally { index._endOp(); }
}

/**
 * Find all functions called by a function using AST-based detection
 * @param {object} index - ProjectIndex instance
 * @param {object} def - Symbol definition with file, name, startLine, endLine
 * @param {object} [options] - Options
 * @param {boolean} [options.includeMethods] - Include method calls (default: false)
 */
function findCallees(index, def, options = {}) {
    index._beginOp();
    try {
    try {
        // Get all calls from the file's cache (now includes enclosingFunction)
        const calls = getCachedCalls(index, def.file);
        if (!calls) return [];

        // Get file language for smart method call handling
        const fileEntry = index.files.get(def.file);
        const language = fileEntry?.language;

        // Build list of inner class/struct method ranges to exclude from callee detection.
        // Only class methods are excluded — they are independently addressable symbols.
        // Calls within closures (named functions without className) ARE included as
        // callees of the parent function, since closures are part of the parent's behavior.
        const innerSymbolRanges = fileEntry ? fileEntry.symbols
            .filter(s => !NON_CALLABLE_TYPES.has(s.type) &&
                    s.className &&  // Only exclude class methods, not closures
                    s.startLine > def.startLine && s.endLine <= def.endLine &&
                    s.startLine !== def.startLine)
            .map(s => [s.startLine, s.endLine]) : [];

        const callees = new Map();  // key -> { name, bindingId, count }
        let selfAttrCalls = null;   // collected for Python self.attr.method() resolution
        let selfMethodCalls = null; // collected for Python self.method() resolution

        // Build local variable type map for receiver resolution
        // Scans for patterns like: bt = Backtester(...) → bt maps to Backtester
        let localTypes = null;
        if (language === 'python' || language === 'javascript') {
            localTypes = _buildLocalTypeMap(index, def, calls);
        }

        for (const call of calls) {
            // Filter to calls within this function's scope
            // Method 1: Direct match via enclosingFunction (fast path for direct calls)
            const isDirectMatch = call.enclosingFunction &&
                call.enclosingFunction.startLine === def.startLine;
            // Method 2: Line-range containment (catches calls inside nested callbacks/closures)
            // A call is in our scope if it's within our line range AND not inside a named inner symbol
            const isInRange = call.line >= def.startLine && call.line <= def.endLine;
            const isInInnerSymbol = isInRange && innerSymbolRanges.some(
                ([start, end]) => call.line >= start && call.line <= end);
            const isNestedCallback = isInRange && !isInInnerSymbol && !isDirectMatch;

            if (!isDirectMatch && !isNestedCallback) continue;

            // Smart method call handling:
            // - Go: include all method calls (Go doesn't use this/self/cls)
            // - self/this.method(): resolve to same-class method (handled below)
            // - Python self.attr.method(): resolve via selfAttribute (handled below)
            // - Other languages: skip method calls unless explicitly requested
            if (call.isMethod) {
                if (call.selfAttribute && language === 'python') {
                    // Will be resolved in second pass below
                } else if (['self', 'cls', 'this'].includes(call.receiver)) {
                    // self.method() / cls.method() / this.method() — resolve to same-class method below
                } else if (call.receiver === 'super') {
                    // super().method() — resolve to parent class method below
                } else if (localTypes && localTypes.has(call.receiver)) {
                    // Resolve method calls on locally-constructed objects:
                    // bt = Backtester(...); bt.run_backtest() → Backtester.run_backtest
                    const className = localTypes.get(call.receiver);
                    const symbols = index.symbols.get(call.name);
                    const match = symbols?.find(s => s.className === className);
                    if (match) {
                        const key = match.bindingId || `${className}.${call.name}`;
                        const existing = callees.get(key);
                        if (existing) {
                            existing.count += 1;
                        } else {
                            callees.set(key, { name: call.name, bindingId: match.bindingId, count: 1 });
                        }
                    }
                    continue;
                } else if (language !== 'go' && language !== 'java' && language !== 'rust' && !options.includeMethods) {
                    continue;
                }
            }

            // Skip keywords and built-ins
            if (index.isKeyword(call.name, language)) continue;

            // Use resolved name (from alias tracking) if available
            // For multi-target aliases (ternary), pick the first that exists in symbol table
            let effectiveName = call.resolvedName || call.name;
            if (call.resolvedNames) {
                for (const rn of call.resolvedNames) {
                    if (index.symbols.has(rn)) { effectiveName = rn; break; }
                }
            }

            // For potential callbacks (identifier args to non-HOF calls),
            // only include if name exists as a function in symbol table
            // AND has binding/import evidence or same-file definition.
            // Prevents local variables (request, context) from matching
            // unrelated functions defined elsewhere (especially test files).
            if (call.isPotentialCallback) {
                const syms = index.symbols.get(effectiveName);
                if (!syms || !syms.some(s =>
                    ['function', 'method', 'constructor', 'static', 'public', 'abstract'].includes(s.type))) {
                    continue;
                }
                const hasBinding = fileEntry?.bindings?.some(b => b.name === call.name);
                const inSameFile = syms.some(s => s.file === def.file);
                if (!hasBinding && !inSameFile) {
                    continue;
                }
            }

            // Collect selfAttribute calls for second-pass resolution
            if (call.selfAttribute && language === 'python') {
                if (!selfAttrCalls) selfAttrCalls = [];
                selfAttrCalls.push(call);
                continue;
            }

            // Collect self/this.method() calls for same-class resolution
            if (call.isMethod && ['self', 'cls', 'this'].includes(call.receiver)) {
                if (!selfMethodCalls) selfMethodCalls = [];
                selfMethodCalls.push(call);
                continue;
            }

            // Collect super().method() calls for parent-class resolution
            if (call.isMethod && call.receiver === 'super') {
                if (!selfMethodCalls) selfMethodCalls = [];
                selfMethodCalls.push(call);
                continue;
            }

            // Resolve binding within this file (without mutating cached call objects)
            let calleeKey = call.bindingId || effectiveName;
            let bindingResolved = call.bindingId;
            let isUncertain = call.uncertain;
            if (!call.bindingId && fileEntry?.bindings) {
                let bindings = fileEntry.bindings.filter(b => b.name === call.name);
                // For Go, also check sibling files in same directory (same package scope)
                if (bindings.length === 0 && language === 'go') {
                    const dir = path.dirname(def.file);
                    for (const [fp, fe] of index.files) {
                        if (fp !== def.file && path.dirname(fp) === dir) {
                            const sibling = (fe.bindings || []).filter(b => b.name === call.name);
                            bindings = bindings.concat(sibling);
                        }
                    }
                }
                // Method call with no binding for the method name:
                // Different strategies by language family:
                if (bindings.length === 0 && call.isMethod) {
                    if (language !== 'go' && language !== 'java' && language !== 'rust') {
                        // JS/TS/Python: mark uncertain unless receiver has import/binding
                        // evidence in file scope. Prevents false positives like m.get() →
                        // repository.get() when m is just a parameter with no type info.
                        const hasReceiverEvidence = call.receiver &&
                            fileEntry?.bindings?.some(b => b.name === call.receiver);
                        if (!hasReceiverEvidence) {
                            isUncertain = true;
                        }
                    } else {
                        // Go/Java/Rust: nominal type systems make single-def method links
                        // reliable. Only mark uncertain when multiple definitions exist
                        // (cross-type ambiguity, e.g. TypeA.Length vs TypeB.Length).
                        const defs = index.symbols.get(call.name);
                        if (defs && defs.length > 1) {
                            isUncertain = true;
                        }
                    }
                }
                if (bindings.length === 1) {
                    bindingResolved = bindings[0].id;
                    calleeKey = bindingResolved;
                } else if (bindings.length > 1) {
                    if (call.name === def.name) {
                        // Calling same-name function (e.g., Java overloads)
                        // Add ALL other overloads as potential callees
                        const otherBindings = bindings.filter(b =>
                            b.startLine !== def.startLine
                        );
                        for (const ob of otherBindings) {
                            const existing = callees.get(ob.id);
                            if (existing) {
                                existing.count += 1;
                            } else {
                                callees.set(ob.id, {
                                    name: effectiveName,
                                    bindingId: ob.id,
                                    count: 1
                                });
                            }
                        }
                        continue; // Already added all overloads, skip normal add
                    } else if (def.className && !call.isMethod) {
                        // Implicit same-class call (Java: execute() means this.execute())
                        // Try to resolve to a binding in the same class via symbol lookup
                        const callSymbols = index.symbols.get(call.name);
                        if (callSymbols) {
                            const sameClassSym = callSymbols.find(s => s.className === def.className);
                            if (sameClassSym) {
                                // Find the binding that matches this symbol's line
                                const matchingBinding = bindings.find(b => b.startLine === sameClassSym.startLine);
                                if (matchingBinding) {
                                    bindingResolved = matchingBinding.id;
                                    calleeKey = bindingResolved;
                                } else {
                                    bindingResolved = sameClassSym.bindingId;
                                    calleeKey = bindingResolved || `${def.className}.${call.name}`;
                                }
                            } else {
                                isUncertain = true;
                            }
                        } else {
                            isUncertain = true;
                        }
                    } else {
                        // Try to resolve to a binding defined within the parent function's
                        // scope (inner closure). E.g., hookRunnerApplication defines next()
                        // internally — prefer that over other next() in the same file.
                        const innerBinding = bindings.find(b =>
                            b.startLine > def.startLine && b.startLine <= def.endLine);
                        if (innerBinding) {
                            bindingResolved = innerBinding.id;
                            calleeKey = bindingResolved;
                        } else {
                            isUncertain = true;
                        }
                    }
                }
            }

            if (isUncertain && !options.includeUncertain) {
                if (options.stats) options.stats.uncertain = (options.stats.uncertain || 0) + 1;
                continue;
            }

            const existing = callees.get(calleeKey);
            if (existing) {
                existing.count += 1;
            } else {
                callees.set(calleeKey, {
                    name: effectiveName,
                    bindingId: bindingResolved,
                    count: 1
                });
            }
        }

        // Second pass: resolve Python self.attr.method() calls
        if (selfAttrCalls && def.className) {
            const attrTypes = getInstanceAttributeTypes(index, def.file, def.className);
            if (attrTypes) {
                for (const call of selfAttrCalls) {
                    const targetClass = attrTypes.get(call.selfAttribute);
                    if (!targetClass) continue;

                    // Find method in symbol table where className matches
                    const symbols = index.symbols.get(call.name);
                    if (!symbols) continue;

                    const match = symbols.find(s => s.className === targetClass);
                    if (!match) continue;

                    const key = match.bindingId || `${targetClass}.${call.name}`;
                    const existing = callees.get(key);
                    if (existing) {
                        existing.count += 1;
                    } else {
                        callees.set(key, {
                            name: call.name,
                            bindingId: match.bindingId,
                            count: 1
                        });
                    }
                }
            }
        }

        // Third pass: resolve self/this/super.method() calls to same-class or parent methods
        // Falls back to walking the inheritance chain if not found in same class
        if (selfMethodCalls && def.className) {
            for (const call of selfMethodCalls) {
                const symbols = index.symbols.get(call.name);
                if (!symbols) continue;

                // For super().method(), skip same-class — start from parent
                let match = call.receiver === 'super'
                    ? null
                    : symbols.find(s => s.className === def.className);

                // Walk inheritance chain using BFS if not found in same class
                if (!match) {
                    const visited = new Set([def.className]);
                    const defFile = def.file;
                    const startParents = index._getInheritanceParents(def.className, defFile) || [];
                    const queue = startParents.map(p => ({ name: p, contextFile: defFile }));
                    while (queue.length > 0 && !match) {
                        const { name: current, contextFile } = queue.shift();
                        if (visited.has(current)) continue;
                        visited.add(current);
                        match = symbols.find(s => s.className === current);
                        if (!match) {
                            const resolvedFile = index._resolveClassFile(current, contextFile);
                            const grandparents = index._getInheritanceParents(current, resolvedFile) || [];
                            for (const gp of grandparents) {
                                if (!visited.has(gp)) queue.push({ name: gp, contextFile: resolvedFile });
                            }
                        }
                    }
                }

                if (!match) continue;

                const key = match.bindingId || `${match.className}.${call.name}`;
                const existing = callees.get(key);
                if (existing) {
                    existing.count += 1;
                } else {
                    callees.set(key, {
                        name: call.name,
                        bindingId: match.bindingId,
                        count: 1
                    });
                }
            }
        }

        // Look up each callee in the symbol table
        // For methods, prefer callees from: 1) same file, 2) same package, 3) same receiver type
        // Also deprioritize test-file definitions when caller is in production code
        const result = [];
        const defDir = path.dirname(def.file);
        const defReceiver = def.receiver;
        const defFileEntry = fileEntry;
        const callerIsTest = defFileEntry && isTestFile(defFileEntry.relativePath, defFileEntry.language);

        for (const { name: calleeName, bindingId, count } of callees.values()) {
            const symbols = index.symbols.get(calleeName);
            if (symbols && symbols.length > 0) {
                let callee = symbols[0];

                // If we have a binding ID, find the exact matching symbol
                if (bindingId && symbols.length > 1) {
                    const exactMatch = symbols.find(s => s.bindingId === bindingId);
                    if (exactMatch) {
                        callee = exactMatch;
                    }
                } else if (symbols.length > 1) {
                    // Priority 1: Same file, but different definition (for overloads)
                    const sameFileDifferent = symbols.find(s => s.file === def.file && s.startLine !== def.startLine);
                    const sameFile = symbols.find(s => s.file === def.file);
                    if (sameFileDifferent && calleeName === def.name) {
                        callee = sameFileDifferent;
                    } else if (sameFile) {
                        callee = sameFile;
                    } else {
                        // Priority 2: Same directory (package)
                        const sameDir = symbols.find(s => path.dirname(s.file) === defDir);
                        if (sameDir) {
                            callee = sameDir;
                        } else {
                            // Priority 2.5: Imported file — check if the caller's file imports
                            // from any of the candidate callee files
                            const callerImports = fileEntry?.imports || [];
                            const importedFiles = new Set(callerImports.map(imp => imp.resolvedPath).filter(Boolean));
                            const importedCallee = symbols.find(s => importedFiles.has(s.file));
                            if (importedCallee) {
                                callee = importedCallee;
                            } else if (defReceiver) {
                                // Priority 3: Same receiver type (for methods)
                                const sameReceiver = symbols.find(s => s.receiver === defReceiver);
                                if (sameReceiver) {
                                    callee = sameReceiver;
                                }
                            }
                        }
                    }
                    // Priority 4: If default is from a bundled/minified file, prefer non-bundled
                    if (!bindingId) {
                        const calleeFileEntry = index.files.get(callee.file);
                        if (calleeFileEntry && calleeFileEntry.isBundled) {
                            const nonBundled = symbols.find(s => {
                                const fe = index.files.get(s.file);
                                return fe && !fe.isBundled;
                            });
                            if (nonBundled) callee = nonBundled;
                        }
                    }
                    // Priority 5: If default is a test file, prefer non-test
                    if (!bindingId) {
                        const calleeFileEntry = index.files.get(callee.file);
                        if (calleeFileEntry && isTestFile(calleeFileEntry.relativePath, calleeFileEntry.language)) {
                            const nonTest = symbols.find(s => {
                                const fe = index.files.get(s.file);
                                return fe && !isTestFile(fe.relativePath, fe.language);
                            });
                            if (nonTest) callee = nonTest;
                        }
                    }
                }

                // Skip test-file callees when caller is production code and
                // there's no binding (import) evidence linking them
                if (!callerIsTest && !bindingId) {
                    const calleeFileEntry = index.files.get(callee.file);
                    if (calleeFileEntry && isTestFile(calleeFileEntry.relativePath, calleeFileEntry.language)) {
                        continue;
                    }
                }

                result.push({
                    ...callee,
                    callCount: count,
                    weight: index.calculateWeight(count)
                });
            }
        }

        // Sort by call count (core dependencies first)
        result.sort((a, b) => b.callCount - a.callCount);

        return result;
    } catch (e) {
        // Expected: file read/parse failures (minified, binary, buffer exceeded).
        // Return empty callees rather than crashing the entire query.
        return [];
    }
    } finally { index._endOp(); }
}

/**
 * Get instance attribute types for a class in a file.
 * Returns Map<attrName, typeName> for a given className.
 * Caches results per file.
 * @param {object} index - ProjectIndex instance
 * @param {string} filePath - File path
 * @param {string} className - Class name
 */
function getInstanceAttributeTypes(index, filePath, className) {
    if (!index._attrTypeCache) index._attrTypeCache = new Map();

    let fileCache = index._attrTypeCache.get(filePath);
    if (!fileCache) {
        const fileEntry = index.files.get(filePath);
        if (!fileEntry || fileEntry.language !== 'python') return null;

        const langModule = getLanguageModule('python');
        if (!langModule?.findInstanceAttributeTypes) return null;

        try {
            const content = index._readFile(filePath);
            const parser = getParser('python');
            fileCache = langModule.findInstanceAttributeTypes(content, parser);
            index._attrTypeCache.set(filePath, fileCache);
        } catch {
            return null;
        }
    }

    return fileCache.get(className) || null;
}

/**
 * Build a local variable type map for a function body.
 * Scans for constructor-call assignments: var = ClassName(...)
 * Returns Map<varName, className> or null if none found.
 * @param {object} index - ProjectIndex instance
 * @param {object} def - Function definition with file, startLine, endLine
 * @param {Array} calls - Cached call sites for the file
 */
function _buildLocalTypeMap(index, def, calls) {
    let content;
    try {
        content = index._readFile(def.file);
    } catch {
        return null;
    }
    const lines = content.split('\n');
    const localTypes = new Map();

    for (const call of calls) {
        // Only look at calls within this function's scope
        if (call.line < def.startLine || call.line > def.endLine) continue;
        // Only direct calls (not method calls) — these are potential constructors
        if (call.isMethod || call.isPotentialCallback) continue;

        // Check if this call's name corresponds to a class in the symbol table
        const symbols = index.symbols.get(call.name);
        if (!symbols) continue;
        const isClass = symbols.some(s => NON_CALLABLE_TYPES.has(s.type));
        if (!isClass) continue;

        // Check the source line for assignment pattern: var = ClassName(...)
        const sourceLine = lines[call.line - 1];
        if (!sourceLine) continue;

        // Match: identifier = ClassName(...) or identifier: Type = ClassName(...)
        const escapedName = call.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const assignMatch = sourceLine.match(
            new RegExp(`(\\w+)\\s*(?::\\s*\\w+)?\\s*=\\s*${escapedName}\\s*\\(`)
        );
        if (assignMatch) {
            localTypes.set(assignMatch[1], call.name);
        }
        // Match: with ClassName(...) as identifier:
        const withMatch = sourceLine.match(
            new RegExp(`with\\s+${escapedName}\\s*\\([^)]*\\)\\s+as\\s+(\\w+)`)
        );
        if (withMatch) {
            localTypes.set(withMatch[1], call.name);
        }
    }

    return localTypes.size > 0 ? localTypes : null;
}

/**
 * Check if a function is used as a callback anywhere in the codebase
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @returns {Array} Callback usages
 */
function findCallbackUsages(index, name) {
    const usages = [];

    for (const [filePath, fileEntry] of index.files) {
        try {
            const content = index._readFile(filePath);
            const language = detectLanguage(filePath);
            if (!language) continue;

            const langModule = getLanguageModule(language);
            if (!langModule.findCallbackUsages) continue;

            const parser = getParser(language);
            const callbacks = langModule.findCallbackUsages(content, name, parser);

            for (const cb of callbacks) {
                usages.push({
                    file: filePath,
                    relativePath: fileEntry.relativePath,
                    ...cb
                });
            }
        } catch (e) {
            // Skip files that can't be processed
        }
    }

    return usages;
}

module.exports = { getCachedCalls, findCallers, findCallees, getInstanceAttributeTypes, findCallbackUsages };
