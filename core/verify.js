/**
 * core/verify.js - Signature verification, refactoring planning, call site analysis
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const { detectLanguage, getParser, getLanguageModule, safeParse } = require('../languages');
const { escapeRegExp } = require('./shared');

/**
 * Find a call expression node at the target line matching funcName
 */
function findCallNode(node, callTypes, targetRow, funcName) {
    if (node.startPosition.row > targetRow || node.endPosition.row < targetRow) {
        return null; // Skip nodes that don't contain the target line
    }

    if (callTypes.has(node.type) && node.startPosition.row <= targetRow && node.endPosition.row >= targetRow) {
        // Java constructor: new ClassName(args) — name is in 'type' field
        if (node.type === 'object_creation_expression') {
            const typeNode = node.childForFieldName('type');
            if (typeNode) {
                // Strip generics and package qualifiers: com.foo.Bar<T> -> Bar
                const typeName = typeNode.text.replace(/<.*>$/, '').split('.').pop();
                if (typeName === funcName) return node;
            }
        } else {
            // Check if this call is for our target function
            const funcNode = node.childForFieldName('function') ||
                             node.childForFieldName('name'); // Java method_invocation uses 'name'
            if (funcNode) {
                const funcText = funcNode.type === 'member_expression' || funcNode.type === 'selector_expression' || funcNode.type === 'field_expression' || funcNode.type === 'attribute'
                    ? (funcNode.childForFieldName('property') || funcNode.childForFieldName('field') || funcNode.childForFieldName('attribute') || funcNode.namedChild(funcNode.namedChildCount - 1))?.text
                    : funcNode.text;
                if (funcText === funcName) return node;
            }
        }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
        const result = findCallNode(node.child(i), callTypes, targetRow, funcName);
        if (result) return result;
    }
    return null;
}

/**
 * Clear the AST tree cache (call after batch operations)
 * @param {object} index - ProjectIndex instance
 */
function clearTreeCache(index) {
    index._treeCache = null;
}

/**
 * Analyze a call site to understand how it's being called (AST-based)
 * @param {object} index - ProjectIndex instance
 * @param {object} call - Usage object with file, line, content
 * @param {string} funcName - Function name to find
 * @returns {object} { args, argCount, hasSpread, hasVariable }
 */
function analyzeCallSite(index, call, funcName) {
    try {
        const language = detectLanguage(call.file);
        if (!language) return { args: null, argCount: 0 };

        // Use tree cache to avoid re-parsing the same file in batch operations
        let tree = index._treeCache?.get(call.file);
        if (!tree) {
            const content = index._readFile(call.file);
            // HTML files need special handling: parse script blocks as JS
            if (language === 'html') {
                const htmlModule = getLanguageModule('html');
                const htmlParser = getParser('html');
                const jsParser = getParser('javascript');
                if (!htmlParser || !jsParser) return { args: null, argCount: 0 };
                const blocks = htmlModule.extractScriptBlocks(content, htmlParser);
                if (blocks.length === 0) return { args: null, argCount: 0 };
                const virtualJS = htmlModule.buildVirtualJSContent(content, blocks);
                tree = safeParse(jsParser, virtualJS);
            } else {
                const parser = getParser(language);
                if (!parser) return { args: null, argCount: 0 };
                tree = safeParse(parser, content);
            }
            if (!tree) return { args: null, argCount: 0 };
            if (!index._treeCache) index._treeCache = new Map();
            index._treeCache.set(call.file, tree);
        }

        // Call node types vary by language
        const callTypes = new Set(['call_expression', 'call', 'method_invocation', 'object_creation_expression']);
        const targetRow = call.line - 1; // tree-sitter is 0-indexed

        // Find the call expression at the target line matching funcName
        const callNode = findCallNode(tree.rootNode, callTypes, targetRow, funcName);
        if (!callNode) return { args: null, argCount: 0 };

        // Check if this is a method call (obj.func()) vs a direct call (func())
        const funcNode = callNode.childForFieldName('function') ||
                         callNode.childForFieldName('name');
        let isMethodCall = false;
        if (funcNode) {
            // member_expression (JS), attribute (Python), selector_expression (Go), field_expression (Rust)
            if (['member_expression', 'attribute', 'selector_expression', 'field_expression'].includes(funcNode.type)) {
                isMethodCall = true;
            }
            // Java method_invocation with object
            if (callNode.type === 'method_invocation' && callNode.childForFieldName('object')) {
                isMethodCall = true;
            }
        }

        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return { args: [], argCount: 0, isMethodCall };

        const args = [];
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            args.push(argsNode.namedChild(i).text.trim());
        }

        return {
            args,
            argCount: args.length,
            hasSpread: args.some(a => a.startsWith('...')),
            hasVariable: args.some(a => /^[a-zA-Z_]\w*$/.test(a)),
            isMethodCall
        };
    } catch (e) {
        return { args: null, argCount: 0 };
    }
}

/**
 * Identify common calling patterns
 * @param {Array} callSites - Array of call site objects
 * @param {string} funcName - Function name
 * @returns {object} Pattern counts
 */
function identifyCallPatterns(callSites, funcName) {
    const patterns = {
        constantArgs: 0,    // Call sites with literal/constant arguments
        variableArgs: 0,    // Call sites passing variables
        chainedCalls: 0,    // Calls that are part of method chains
        awaitedCalls: 0,    // Async calls with await
        spreadCalls: 0      // Calls using spread operator
    };

    for (const site of callSites) {
        const expr = site.expression;

        if (site.hasSpread) patterns.spreadCalls++;
        if (/await\s/.test(expr)) patterns.awaitedCalls++;
        if (new RegExp('\\.' + escapeRegExp(funcName) + '\\s*\\(').test(expr)) patterns.chainedCalls++;

        if (site.args && site.args.length > 0) {
            const hasLiteral = site.args.some(a =>
                /^[\d'"{\[]/.test(a) || a === 'true' || a === 'false' || a === 'null'
            );
            if (hasLiteral) patterns.constantArgs++;
            if (site.hasVariable) patterns.variableArgs++;
        }
    }

    return patterns;
}

/**
 * Verify that all call sites match a function's signature
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @param {object} options - { file }
 * @returns {object} Verification results with mismatches
 */
function verify(index, name, options = {}) {
    index._beginOp();
    try {
    const { def } = index.resolveSymbol(name, { file: options.file, className: options.className });
    if (!def) {
        return { found: false, function: name };
    }
    // For Python/Rust methods, exclude self/cls from parameter count
    // (callers don't pass self/cls explicitly: obj.method(a, b) not obj.method(obj, a, b))
    const fileEntry = index.files.get(def.file);
    const lang = fileEntry?.language;
    let params = def.paramsStructured || [];
    if ((lang === 'python' || lang === 'rust') && params.length > 0) {
        const firstName = params[0].name;
        if (firstName === 'self' || firstName === 'cls' || firstName === '&self' || firstName === '&mut self') {
            params = params.slice(1);
        }
    }
    const hasRest = params.some(p => p.rest);
    // Rest params don't count toward expected/min — they accept 0+ extra args
    const nonRestParams = params.filter(p => !p.rest);
    const expectedParamCount = nonRestParams.length;
    const optionalCount = nonRestParams.filter(p => p.optional || p.default !== undefined).length;
    const minArgs = expectedParamCount - optionalCount;

    // Get all call sites
    const usages = index.usages(name, { codeOnly: true });
    const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

    const valid = [];
    const mismatches = [];
    const uncertain = [];

    // If the definition is NOT a method, filter out method calls (e.g., dict.get() vs get())
    // This prevents false positives where a standalone function name matches method calls
    const defIsMethod = def.isMethod || def.type === 'method' || def.className;

    for (const call of calls) {
        const analysis = analyzeCallSite(index, call, name);

        // Skip method calls when verifying a non-method definition
        if (analysis.isMethodCall && !defIsMethod) {
            continue;
        }

        if (analysis.args === null) {
            // Couldn't parse arguments
            uncertain.push({
                file: call.relativePath,
                line: call.line,
                expression: call.content.trim(),
                reason: 'Could not parse call arguments'
            });
            continue;
        }

        if (analysis.hasSpread) {
            // Spread args - can't verify count
            uncertain.push({
                file: call.relativePath,
                line: call.line,
                expression: call.content.trim(),
                reason: 'Uses spread operator'
            });
            continue;
        }

        const argCount = analysis.argCount;

        // Check if arg count is valid
        if (hasRest) {
            // With rest param, need at least minArgs
            if (argCount >= minArgs) {
                valid.push({ file: call.relativePath, line: call.line });
            } else {
                mismatches.push({
                    file: call.relativePath,
                    line: call.line,
                    expression: call.content.trim(),
                    expected: `at least ${minArgs} arg(s)`,
                    actual: argCount,
                    args: analysis.args
                });
            }
        } else {
            // Without rest, need between minArgs and expectedParamCount
            if (argCount >= minArgs && argCount <= expectedParamCount) {
                valid.push({ file: call.relativePath, line: call.line });
            } else {
                mismatches.push({
                    file: call.relativePath,
                    line: call.line,
                    expression: call.content.trim(),
                    expected: minArgs === expectedParamCount
                        ? `${expectedParamCount} arg(s)`
                        : `${minArgs}-${expectedParamCount} arg(s)`,
                    actual: argCount,
                    args: analysis.args
                });
            }
        }
    }
    clearTreeCache(index);

    // Detect scope pollution for methods
    let scopeWarning = null;
    if (defIsMethod) {
        const allDefs = index.symbols.get(name);
        if (allDefs && allDefs.length > 1) {
            const classNames = [...new Set(allDefs
                .filter(d => d.className && d.className !== def.className)
                .map(d => d.className))];
            if (classNames.length > 0) {
                scopeWarning = {
                    targetClass: def.className || '(unknown)',
                    otherClasses: classNames,
                    hint: `Results may include calls to ${classNames.join(', ')}.${name}(). Use file= or className= to narrow scope.`
                };
            }
        }
    }

    return {
        found: true,
        function: name,
        file: def.relativePath,
        startLine: def.startLine,
        signature: index.formatSignature(def),
        params: params.map(p => ({
            name: p.name,
            optional: p.optional || p.default !== undefined,
            hasDefault: p.default !== undefined
        })),
        expectedArgs: { min: minArgs, max: hasRest ? '∞' : expectedParamCount },
        totalCalls: valid.length + mismatches.length + uncertain.length,
        valid: valid.length,
        mismatches: mismatches.length,
        uncertain: uncertain.length,
        mismatchDetails: mismatches,
        uncertainDetails: uncertain,
        scopeWarning
    };
    } finally { index._endOp(); }
}

/**
 * Plan a refactoring operation
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @param {object} options - { addParam, removeParam, renameTo, defaultValue }
 * @returns {object} Plan with before/after signatures and affected call sites
 */
function plan(index, name, options = {}) {
    index._beginOp();
    try {
    const definitions = index.symbols.get(name);
    if (!definitions || definitions.length === 0) {
        return { found: false, function: name };
    }

    const resolved = index.resolveSymbol(name, { file: options.file, className: options.className });
    const def = resolved.def || definitions[0];
    const impact = index.impact(name, { file: options.file, className: options.className });
    const currentParams = def.paramsStructured || [];
    const currentSignature = index.formatSignature(def);

    let newParams = [...currentParams];
    let newSignature = currentSignature;
    let operation = null;
    let changes = [];

    if (options.addParam) {
        // Check if parameter already exists
        if (currentParams.some(p => p.name === options.addParam)) {
            return {
                found: true,
                error: `Parameter "${options.addParam}" already exists in ${name}`,
                currentParams: currentParams.map(p => p.name)
            };
        }
        operation = 'add-param';
        const newParam = {
            name: options.addParam,
            ...(options.defaultValue && { default: options.defaultValue })
        };
        newParams.push(newParam);

        // Generate new signature
        const paramsList = newParams.map(p => {
            let str = p.name;
            if (p.type) str += `: ${p.type}`;
            if (p.default) str += ` = ${p.default}`;
            return str;
        }).join(', ');
        newSignature = `${name}(${paramsList})`;
        if (def.returnType) newSignature += `: ${def.returnType}`;

        // Describe changes needed at each call site
        for (const fileGroup of impact.byFile) {
            for (const site of fileGroup.sites) {
                const suggestion = options.defaultValue
                    ? `No change needed (has default value)`
                    : `Add argument: ${options.addParam}`;
                changes.push({
                    file: site.file,
                    line: site.line,
                    expression: site.expression,
                    suggestion,
                    args: site.args
                });
            }
        }
    }

    if (options.removeParam) {
        operation = 'remove-param';
        const paramIndex = currentParams.findIndex(p => p.name === options.removeParam);
        if (paramIndex === -1) {
            return {
                found: true,
                error: `Parameter "${options.removeParam}" not found in ${name}`,
                currentParams: currentParams.map(p => p.name)
            };
        }

        newParams = currentParams.filter(p => p.name !== options.removeParam);

        // Generate new signature
        const paramsList = newParams.map(p => {
            let str = p.name;
            if (p.type) str += `: ${p.type}`;
            if (p.default) str += ` = ${p.default}`;
            return str;
        }).join(', ');
        newSignature = `${name}(${paramsList})`;
        if (def.returnType) newSignature += `: ${def.returnType}`;

        // For Python/Rust methods, self/cls/&self/&mut self is in paramsStructured
        // but callers don't pass it. Adjust paramIndex to caller-side position.
        const fileEntry = index.files.get(def.file);
        const lang = fileEntry?.language;
        let selfOffset = 0;
        if ((lang === 'python' || lang === 'rust') && currentParams.length > 0) {
            const firstName = currentParams[0].name;
            if (firstName === 'self' || firstName === 'cls' || firstName === '&self' || firstName === '&mut self') {
                selfOffset = 1;
            }
        }
        const callerArgIndex = paramIndex - selfOffset;

        // Describe changes at each call site
        for (const fileGroup of impact.byFile) {
            for (const site of fileGroup.sites) {
                if (site.args && site.argCount > callerArgIndex) {
                    changes.push({
                        file: site.file,
                        line: site.line,
                        expression: site.expression,
                        suggestion: `Remove argument ${callerArgIndex + 1}: ${site.args[callerArgIndex] || '?'}`,
                        args: site.args
                    });
                }
            }
        }
    }

    if (options.renameTo) {
        operation = 'rename';
        newSignature = currentSignature.replace(new RegExp('\\b' + escapeRegExp(name) + '\\b'), options.renameTo);

        // All call sites need renaming
        for (const fileGroup of impact.byFile) {
            for (const site of fileGroup.sites) {
                const newExpression = site.expression.replace(
                    new RegExp('\\b' + escapeRegExp(name) + '\\b'),
                    options.renameTo
                );
                changes.push({
                    file: site.file,
                    line: site.line,
                    expression: site.expression,
                    suggestion: `Rename to: ${newExpression}`,
                    newExpression
                });
            }
        }

        // Also include import statements that reference the renamed function
        const usages = index.usages(name, { codeOnly: true });
        const importUsages = usages.filter(u => u.usageType === 'import' && !u.isDefinition);
        for (const imp of importUsages) {
            // Skip if already covered by a call site change in the same file:line
            const alreadyCovered = changes.some(c =>
                c.file === (imp.relativePath || imp.file) && c.line === imp.line
            );
            if (alreadyCovered) continue;
            const newImport = imp.content.trim().replace(
                new RegExp('\\b' + escapeRegExp(name) + '\\b'),
                options.renameTo
            );
            changes.push({
                file: imp.relativePath || imp.file,
                line: imp.line,
                expression: imp.content.trim(),
                suggestion: `Update import: ${newImport}`,
                newExpression: newImport,
                isImport: true
            });
        }
    }

    return {
        found: true,
        function: name,
        file: def.relativePath,
        startLine: def.startLine,
        operation,
        before: {
            signature: currentSignature,
            params: currentParams.map(p => p.name)
        },
        after: {
            signature: newSignature,
            params: newParams.map(p => p.name)
        },
        totalChanges: changes.length,
        filesAffected: new Set(changes.map(c => c.file)).size,
        changes,
        scopeWarning: impact?.scopeWarning || null
    };
    } finally { index._endOp(); }
}

/**
 * Analyze a call site using AST for example scoring.
 * @param {object} index - ProjectIndex instance
 * @param {string} filePath - File path
 * @param {number} lineNum - Line number
 * @param {string} funcName - Function name
 * @returns {object} Analysis results
 * @private
 */
function analyzeCallSiteAST(index, filePath, lineNum, funcName) {
    const result = {
        isAwait: false, isDestructured: false, isTypedAssignment: false,
        isInReturn: false, isInCatch: false, isInConditional: false,
        hasComment: false, isStandalone: false
    };

    try {
        const language = detectLanguage(filePath);
        if (!language) return result;

        const parser = getParser(language);
        const content = index._readFile(filePath);
        const tree = safeParse(parser, content);
        if (!tree) return result;

        const row = lineNum - 1;
        const node = tree.rootNode.descendantForPosition({ row, column: 0 });
        if (!node) return result;

        let current = node;
        let foundCall = false;

        while (current) {
            const type = current.type;

            if (!foundCall && (type === 'call_expression' || type === 'call')) {
                const calleeNode = current.childForFieldName('function') || current.namedChild(0);
                if (calleeNode && calleeNode.text === funcName) {
                    foundCall = true;
                }
            }

            if (foundCall) {
                if (type === 'await_expression') result.isAwait = true;
                if (type === 'variable_declarator' || type === 'assignment_expression') {
                    const parent = current.parent;
                    if (parent && (parent.type === 'lexical_declaration' || parent.type === 'variable_declaration')) {
                        result.isTypedAssignment = true;
                    }
                }
                if (type === 'array_pattern' || type === 'object_pattern') result.isDestructured = true;
                if (type === 'return_statement') result.isInReturn = true;
                if (type === 'catch_clause' || type === 'except_clause') result.isInCatch = true;
                if (type === 'if_statement' || type === 'conditional_expression' || type === 'ternary_expression') result.isInConditional = true;
                if (type === 'expression_statement') result.isStandalone = true;
            }

            current = current.parent;
        }

        const contentLines = content.split('\n');
        if (lineNum > 1) {
            const prevLine = contentLines[lineNum - 2].trim();
            if (prevLine.startsWith('//') || prevLine.startsWith('#') || prevLine.endsWith('*/')) {
                result.hasComment = true;
            }
        }
    } catch (e) {
        // Return default result on error
    }

    return result;
}

module.exports = { verify, plan, analyzeCallSite, analyzeCallSiteAST, findCallNode, clearTreeCache, identifyCallPatterns };
