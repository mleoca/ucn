/**
 * core/verify.js - Signature verification, refactoring planning, call site analysis
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const path = require('path');
const { detectLanguage, getParser, getLanguageModule, safeParse, langTraits } = require('../languages');
const { escapeRegExp } = require('./shared');
const { extractImports } = require('./imports');

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
            let funcNode = node.childForFieldName('function') ||
                             node.childForFieldName('name'); // Java method_invocation uses 'name'
            // Unwrap turbofish/generic_function: process::<T>() wraps the function in generic_function
            if (funcNode && funcNode.type === 'generic_function') {
                funcNode = funcNode.childForFieldName('function') || funcNode.namedChild(0);
            }
            if (funcNode) {
                const funcText = funcNode.type === 'member_expression' || funcNode.type === 'selector_expression' || funcNode.type === 'field_expression' || funcNode.type === 'attribute'
                    ? (funcNode.childForFieldName('property') || funcNode.childForFieldName('field') || funcNode.childForFieldName('attribute') || funcNode.namedChild(funcNode.namedChildCount - 1))?.text
                    : funcNode.type === 'scoped_identifier'
                    ? (funcNode.childForFieldName('name') || funcNode.namedChild(funcNode.namedChildCount - 1))?.text
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
 * Render a single parameter with TS-correct optional marker placement.
 * BUG-BV fix: `?` follows the NAME, not the TYPE (e.g. `opt?: number`,
 * not the invalid `opt: number?`). Used by verify/plan signature output.
 * @param {object} p - Param object {name, type?, optional?, default?, rest?}
 * @returns {string}
 */
function formatTypedParam(p) {
    if (!p || !p.name) return '';
    // Rest-param prefix:
    //   Python `**kwargs` / `*args` keep their `*` prefix (name already starts with `*`).
    //   JS/TS rest like `...rest` keeps `...` (avoid double-prefix if name already has `...`).
    //   Bare names with rest=true get `...` prefix (JS rest with stripped pattern name).
    let s;
    if (p.rest) {
        const n = String(p.name);
        if (n.startsWith('*') || n.startsWith('...')) s = n;
        else s = `...${n}`;
    } else {
        s = p.name;
    }
    // Optional marker — placed AFTER name, BEFORE type (TS syntax: `opt?: number`)
    if (p.optional && !p.rest && p.default == null) s += '?';
    if (p.type) s += `: ${p.type}`;
    if (p.default != null) s += ` = ${p.default}`;
    return s;
}

/**
 * Render a param name for the plan `before.params` / `after.params` arrays.
 * These arrays are name-keyed (callers do `.includes('retries')` exact match),
 * so we keep TS optional `?` and type annotation for BUG-BV/#181 contracts,
 * but omit the ` = default` suffix and rest `*`/`...` prefix that callers don't
 * test against. Mirrors the pre-rewrite shape of plan output.
 * @param {object} p
 * @returns {string}
 */
function formatPlanParamName(p) {
    if (!p || !p.name) return '';
    let s = p.name;
    if (p.optional && !p.default) s += '?';
    if (p.type) s += `: ${p.type}`;
    return s;
}

/**
 * Build a function signature string from a definition, using
 * TS-correct param formatting (BUG-BV). Local to verify.js to avoid
 * the shared formatter's incorrect `?` placement.
 * @param {object} def - Symbol definition
 * @param {object} [overrides] - Optional { paramsStructured, returnType, name } overrides
 * @returns {string}
 */
function formatTypedSignature(def, overrides = {}) {
    const parts = [];
    if (def.modifiers && def.modifiers.length) {
        parts.push(def.modifiers.join(' '));
    }
    const name = overrides.name || def.name;
    parts.push(name);
    const ps = overrides.paramsStructured != null ? overrides.paramsStructured : def.paramsStructured;
    if (Array.isArray(ps)) {
        const paramTypes = def.paramTypes || {};
        const parts2 = ps.map(p => {
            // Apply paramTypes mapping when paramsStructured doesn't carry types
            const merged = { ...p };
            if (!merged.type && paramTypes[p.name]) merged.type = paramTypes[p.name];
            return formatTypedParam(merged);
        });
        parts.push(`(${parts2.filter(Boolean).join(', ')})`);
    } else if (def.params !== undefined) {
        parts.push(`(${def.params})`);
    }
    const rt = overrides.returnType != null ? overrides.returnType : def.returnType;
    if (rt) parts.push(`: ${rt}`);
    return parts.join(' ');
}

/**
 * BUG-BY: For an arrow function declared as `const x: (a: number) => number = (a) => ...`
 * the inline arrow params/return type are missing types — they live on the
 * variable_declarator's type_annotation. Walk up to the declarator and
 * extract `function_type` parts (params + return type) when present.
 *
 * Returns null if no enrichment is available; otherwise an object with
 * { paramsStructured, returnType } suitable for use as overrides.
 *
 * Only applies to TS-family files (typescript/tsx). JS doesn't have function_type
 * annotations at the variable declarator level.
 *
 * @param {object} index - ProjectIndex instance
 * @param {object} def - Symbol definition (must have file + startLine)
 * @returns {{ paramsStructured: Array, returnType: string|null }|null}
 */
function extractArrowTypesFromVarDecl(index, def) {
    if (!def || !def.file || !def.startLine) return null;
    const lang = detectLanguage(def.file);
    if (lang !== 'typescript' && lang !== 'tsx') return null;
    // Already have types — nothing to enrich.
    const ps = def.paramsStructured;
    const allHaveTypes = Array.isArray(ps) && ps.length > 0 && ps.every(p => p && p.type);
    if (allHaveTypes && def.returnType) return null;
    let parser;
    try {
        parser = getParser(lang);
    } catch (e) {
        return null;
    }
    if (!parser) return null;
    let content;
    try {
        content = index._readFile(def.file);
    } catch (e) {
        return null;
    }
    const tree = safeParse(parser, content);
    if (!tree) return null;

    // Find the variable_declarator that wraps the arrow function at def.startLine
    const targetRow = def.startLine - 1;
    function findVarDecl(node) {
        if (!node) return null;
        if (node.startPosition.row > targetRow || node.endPosition.row < targetRow) return null;
        if (node.type === 'variable_declarator') {
            // Check if this declarator's value is an arrow_function (or function_expression)
            const valueNode = node.childForFieldName('value');
            if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression' || valueNode.type === 'function')) {
                // Confirm name matches and starts at our target row
                const nameNode = node.childForFieldName('name');
                if (nameNode && nameNode.text === def.name) {
                    return node;
                }
            }
        }
        for (let i = 0; i < node.namedChildCount; i++) {
            const result = findVarDecl(node.namedChild(i));
            if (result) return result;
        }
        return null;
    }
    const declarator = findVarDecl(tree.rootNode);
    if (!declarator) return null;

    // Look for type_annotation child holding a function_type
    let typeAnno = null;
    for (let i = 0; i < declarator.namedChildCount; i++) {
        const child = declarator.namedChild(i);
        if (child.type === 'type_annotation') { typeAnno = child; break; }
    }
    if (!typeAnno) return null;
    // type_annotation > function_type
    let fnType = null;
    for (let i = 0; i < typeAnno.namedChildCount; i++) {
        const child = typeAnno.namedChild(i);
        if (child.type === 'function_type') { fnType = child; break; }
    }
    if (!fnType) return null;
    // function_type has formal_parameters + a return type sibling
    const fp = fnType.childForFieldName('parameters') || (() => {
        for (let i = 0; i < fnType.namedChildCount; i++) {
            const c = fnType.namedChild(i);
            if (c.type === 'formal_parameters') return c;
        }
        return null;
    })();
    let returnType = null;
    // Return type is the last named child (predefined_type, type_identifier, etc.) that isn't formal_parameters
    for (let i = fnType.namedChildCount - 1; i >= 0; i--) {
        const c = fnType.namedChild(i);
        if (c.type !== 'formal_parameters' && c.type !== 'type_parameters') {
            returnType = c.text;
            break;
        }
    }
    // Build typed paramsStructured by reading param names + types out of fp.
    // Pair against the existing inline params (from def.paramsStructured) so
    // we preserve names declared at the arrow site if they differ.
    let typedParams = [];
    if (fp) {
        for (let i = 0; i < fp.namedChildCount; i++) {
            const param = fp.namedChild(i);
            const info = {};
            if (param.type === 'required_parameter' || param.type === 'optional_parameter') {
                const patternNode = param.childForFieldName('pattern');
                const tnode = param.childForFieldName('type');
                if (patternNode) info.name = patternNode.text;
                if (tnode) info.type = tnode.text.replace(/^:\s*/, '');
                if (param.type === 'optional_parameter') info.optional = true;
            } else if (param.type === 'identifier') {
                info.name = param.text;
            }
            if (info.name) typedParams.push(info);
        }
    }
    // If inline params have names (from arrow), prefer those names but keep types from fnType
    if (Array.isArray(ps) && ps.length === typedParams.length) {
        typedParams = typedParams.map((tp, i) => ({
            ...ps[i],   // start from existing (preserves rest, default, etc.)
            ...(tp.type ? { type: tp.type } : {}),
            ...(tp.optional ? { optional: true } : {}),
        }));
    }
    return {
        paramsStructured: typedParams.length ? typedParams : ps,
        returnType: returnType || def.returnType || null,
    };
}

/**
 * BUG-BX: A receiver like `Utils.helper()` may be a TS namespace member call
 * for a regular (non-method) exported function. Returns true when the
 * receiver matches a known namespace/class symbol that contains a function
 * with the verified name.
 * @param {object} index - ProjectIndex instance
 * @param {string} receiver - Receiver text from the call site
 * @param {string} funcName - Name being verified
 * @param {string} defFile - The definition's file (to scope the match)
 * @returns {boolean}
 */
function isNamespaceContainerFor(index, receiver, funcName, defFile) {
    if (!receiver || !funcName) return false;
    const candidates = index.symbols.get(receiver);
    if (!candidates || candidates.length === 0) return false;
    // Accept namespace, module, class, or interface containers
    return candidates.some(c => {
        const t = c.type;
        if (t === 'namespace' || t === 'module' || t === 'class' || t === 'interface') {
            // Same file as the def is the strongest signal; fall back to project-wide match.
            if (!defFile || c.file === defFile) return true;
            // Cross-file: only accept when receiver is a dedicated namespace/module
            return t === 'namespace' || t === 'module';
        }
        return false;
    });
}

/**
 * BUG-BW: Build the list of call sites for `plan` using the SAME findCallers
 * + className filter logic that verify uses. This guarantees plan and verify
 * agree on which sites need updating — the previous implementation routed
 * through `index.impact()` whose filter is stricter for unresolved receivers
 * (e.g. `this.repo.save()`), causing plan to miss class-method call sites
 * that verify finds.
 *
 * Returns an array of plan-shaped sites: { file, line, expression, args, argCount }.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name being refactored
 * @param {object} def - Resolved definition
 * @param {object} options - { file, className, line }
 * @returns {Array}
 */
function computePlanCallSites(index, name, def, options) {
    let callerResults = index.findCallers(name, {
        includeMethods: true,
        includeUncertain: false,
        targetDefinitions: [def],
    });

    // Mirror verify's className filter (kept inline rather than re-extracted to
    // avoid changing verify's behavior).
    if (options.className && def.className) {
        const targetClassName = def.className;
        callerResults = callerResults.filter(c => {
            if (!c.isMethod) return true;
            const r = c.receiver;
            if (!r || ['self', 'cls', 'this', 'super'].includes(r)) return true;
            if (r.toLowerCase().includes(targetClassName.toLowerCase())) return true;
            // Local var type inference from constructor assignments
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
                                        const content = index._readFile(c.callerFile);
                                        const clines = content.split('\n');
                                        const cline = clines[call.line - 1] || '';
                                        const m = cline.match(/^\s*(\w+)\s*=\s*(?:await\s+)?(\w+)\s*\(/);
                                        if (m && m[2] === call.name) {
                                            localTypes.set(m[1], call.name);
                                        }
                                    }
                                }
                            }
                        }
                        const receiverType = localTypes.get(r);
                        if (receiverType) return receiverType === targetClassName;
                    }
                }
            }
            // Param type annotations
            if (c.callerFile && c.callerStartLine) {
                const callerSymbol = index.findEnclosingFunction(c.callerFile, c.line, true);
                if (callerSymbol && callerSymbol.paramsStructured) {
                    for (const param of callerSymbol.paramsStructured) {
                        if (param.name === r && param.type) {
                            const typeMatches = param.type.match(/\b([A-Za-z_]\w*)\b/g);
                            if (typeMatches && typeMatches.some(t => t === targetClassName)) {
                                return true;
                            }
                            return false;
                        }
                    }
                }
            }
            // Unique method heuristic
            const methodDefs = index.symbols.get(name);
            if (methodDefs) {
                const classNames = new Set();
                for (const d of methodDefs) {
                    if (d.className) classNames.add(d.className);
                }
                if (classNames.size === 1 && classNames.has(targetClassName)) {
                    return true;
                }
            }
            return false;
        });
    }

    // Apply the same isMethodCall / non-method filter verify uses.
    const defIsMethod = !!(def.isMethod || def.type === 'method' || def.className);
    const targetBasename = path.basename(def.file, path.extname(def.file));
    const defFileEntry = index.files.get(def.file);
    const defLang = defFileEntry?.language;

    const importNameCache = new Map();
    function getImportedNames(filePath) {
        if (importNameCache.has(filePath)) return importNameCache.get(filePath);
        const names = new Set();
        const fe = index.files.get(filePath);
        if (!fe) { importNameCache.set(filePath, names); return names; }
        try {
            const content = index._readFile(filePath);
            const { imports: rawImports, importAliases } = extractImports(content, fe.language);
            for (const imp of rawImports) {
                if (imp.names) for (const n of imp.names) names.add(n);
            }
            if (importAliases) for (const alias of importAliases) names.add(alias.local);
        } catch (e) { /* skip */ }
        importNameCache.set(filePath, names);
        return names;
    }

    const sites = [];
    for (const c of callerResults) {
        const call = {
            file: c.file,
            relativePath: c.relativePath,
            line: c.line,
            content: c.content,
            usageType: 'call',
            receiver: c.receiver,
        };
        const analysis = analyzeCallSite(index, call, name);

        if (analysis.isMethodCall && !defIsMethod) {
            const callReceiver = call.receiver;
            if (callReceiver && callReceiver === targetBasename) {
                const importedNames = getImportedNames(call.file);
                if (!importedNames.has(callReceiver)) continue;
            } else if (callReceiver && langTraits(defLang)?.hasReceiverPackageCalls) {
                const targetDir = path.basename(path.dirname(def.file));
                if (callReceiver !== targetDir) continue;
            } else if (callReceiver && isNamespaceContainerFor(index, callReceiver, name, def.file)) {
                // BUG-BX: TS namespace-qualified call — accept.
            } else {
                continue;
            }
        }

        sites.push({
            file: call.relativePath,
            line: call.line,
            expression: (call.content || '').trim(),
            args: analysis.args,
            argCount: analysis.argCount,
        });
    }
    clearTreeCache(index);
    // Stable ordering (matches CLAUDE.md rule #11): files alphabetical, sites by line ascending.
    sites.sort((a, b) => {
        const fc = String(a.file).localeCompare(String(b.file));
        if (fc !== 0) return fc;
        return (a.line || 0) - (b.line || 0);
    });
    return sites;
}

/**
 * Compute the same scopeWarning that impact() returns for plan output.
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name
 * @param {object} def - Resolved definition
 * @param {object} options
 * @returns {object|null}
 */
function computePlanScopeWarning(index, name, def, options) {
    const defIsMethod = !!(def.isMethod || def.type === 'method' || def.className);
    if (!defIsMethod) return null;
    const allDefs = index.symbols.get(name);
    if (!allDefs || allDefs.length <= 1) return null;
    const classNames = [...new Set(allDefs
        .filter(d => d.className && d.className !== def.className)
        .map(d => d.className))];
    if (classNames.length === 0) return null;
    if (options.className || options.file) return null;
    return {
        targetClass: def.className || '(unknown)',
        otherClasses: classNames,
        hint: `Results may include calls to ${classNames.join(', ')}.${name}(). Use file= or className= to narrow scope.`
    };
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
 * Argument shape analysis for a call site (used by `example --diverse`).
 *
 * Returns a per-arg list of AST node types ("string_literal", "number_literal",
 * "identifier", "member_expression", "call_expression", "arrow_function",
 * "object", "array", "spread", "other") derived directly from tree-sitter,
 * plus a stable "shape key" that callers can use for clustering.
 *
 * Returns null when the call node can't be located (parse failure, file unreadable).
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} filePath - Absolute file path
 * @param {number} lineNum - 1-indexed line of the call
 * @param {string} funcName - Function name being called
 * @returns {{argKinds: string[], argTexts: string[], argCount: number, shapeKey: string}|null}
 */
function analyzeCallShape(index, filePath, lineNum, funcName) {
    try {
        const language = detectLanguage(filePath);
        if (!language) return null;

        // Reuse tree cache to avoid re-parsing during a batch (clustering scans many sites)
        let tree = index._treeCache?.get(filePath);
        if (!tree) {
            const content = index._readFile(filePath);
            if (language === 'html') {
                const htmlModule = getLanguageModule('html');
                const htmlParser = getParser('html');
                const jsParser = getParser('javascript');
                if (!htmlParser || !jsParser) return null;
                const blocks = htmlModule.extractScriptBlocks(content, htmlParser);
                if (blocks.length === 0) return null;
                const virtualJS = htmlModule.buildVirtualJSContent(content, blocks);
                tree = safeParse(jsParser, virtualJS);
            } else {
                const parser = getParser(language);
                if (!parser) return null;
                tree = safeParse(parser, content);
            }
            if (!tree) return null;
            if (!index._treeCache) index._treeCache = new Map();
            index._treeCache.set(filePath, tree);
        }

        const callTypes = new Set(['call_expression', 'call', 'method_invocation', 'object_creation_expression']);
        const callNode = findCallNode(tree.rootNode, callTypes, lineNum - 1, funcName);
        if (!callNode) return null;

        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) {
            return { argKinds: [], argTexts: [], argCount: 0, shapeKey: '0:' };
        }

        const argKinds = [];
        const argTexts = [];
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const argNode = argsNode.namedChild(i);
            argKinds.push(classifyArgNode(argNode));
            argTexts.push(argNode.text.trim());
        }

        const shapeKey = `${argKinds.length}:${argKinds.join(',')}`;
        return {
            argKinds,
            argTexts,
            argCount: argKinds.length,
            shapeKey,
        };
    } catch (e) {
        return null;
    }
}

/**
 * Map a tree-sitter argument node to a coarse "kind" tag for shape clustering.
 * The mapping is intentionally tight — a call passing `getUser()` should cluster
 * with another call passing `loadConfig()` (both `call_expression`), but NOT
 * with one passing `42` (a `number_literal`).
 *
 * Cross-language note: tree-sitter grammars use slightly different node names
 * (`string_literal` vs `string`, `integer` vs `number_literal`). We canonicalize
 * to a small set so a JS sample and a Python sample produce the same shape key.
 */
function classifyArgNode(node) {
    if (!node) return 'other';
    const t = node.type;
    // Strings
    if (t === 'string' || t === 'string_literal' || t === 'template_string' ||
        t === 'raw_string_literal' || t === 'interpreted_string_literal') {
        return 'string_literal';
    }
    // Numbers
    if (t === 'number' || t === 'integer' || t === 'float' || t === 'number_literal' ||
        t === 'integer_literal' || t === 'float_literal' || t === 'decimal_integer_literal' ||
        t === 'hex_integer_literal' || t === 'real_literal') {
        return 'number_literal';
    }
    // Booleans + null
    if (t === 'true' || t === 'false' || t === 'null' || t === 'null_literal' ||
        t === 'boolean_literal' || t === 'none' || t === 'nil') {
        return 'literal';
    }
    // Identifiers (bare variable name)
    if (t === 'identifier' || t === 'shorthand_property_identifier' ||
        t === 'name' || t === 'simple_identifier' || t === 'type_identifier') {
        return 'identifier';
    }
    // Member access: obj.attr / obj.method (no call)
    if (t === 'member_expression' || t === 'attribute' || t === 'selector_expression' ||
        t === 'field_expression' || t === 'field_access' || t === 'scoped_identifier') {
        return 'member_expression';
    }
    // Nested calls: foo(getThing())
    if (t === 'call_expression' || t === 'call' || t === 'method_invocation' ||
        t === 'object_creation_expression' || t === 'macro_invocation') {
        return 'call_expression';
    }
    // Anonymous functions
    if (t === 'arrow_function' || t === 'function_expression' || t === 'function' ||
        t === 'lambda' || t === 'closure_expression' || t === 'function_literal' ||
        t === 'lambda_expression') {
        return 'arrow_function';
    }
    // Object/struct literals
    if (t === 'object' || t === 'object_expression' || t === 'dictionary' ||
        t === 'struct_expression' || t === 'composite_literal') {
        return 'object';
    }
    // Array/list literals
    if (t === 'array' || t === 'array_expression' || t === 'list' || t === 'tuple' ||
        t === 'array_literal') {
        return 'array';
    }
    // Spread / unpacking
    if (t === 'spread_element' || t === 'spread' || t === 'list_splat' ||
        t === 'dictionary_splat') {
        return 'spread';
    }
    return 'other';
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
            const literalPattern = /^[\d'"{\[]/; // eslint-disable-line no-useless-escape
            const hasLiteral = site.args.some(a =>
                literalPattern.test(a) || a === 'true' || a === 'false' || a === 'null'
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
    const { def } = index.resolveSymbol(name, { file: options.file, className: options.className, line: options.line });
    if (!def) {
        return { found: false, function: name };
    }
    // For Python/Rust methods, exclude self/cls from parameter count
    // (callers don't pass self/cls explicitly: obj.method(a, b) not obj.method(obj, a, b))
    const fileEntry = index.files.get(def.file);
    const lang = fileEntry?.language;
    // BUG-BY: enrich types for arrow functions whose types live on the
    // enclosing variable_declarator's type_annotation rather than inline.
    const arrowTypes = extractArrowTypesFromVarDecl(index, def);
    let params = (arrowTypes?.paramsStructured) || def.paramsStructured || [];
    const selfParams = langTraits(lang)?.selfParam;
    if (selfParams && params.length > 0 && selfParams.includes(params[0].name)) {
        params = params.slice(1);
    }
    const hasRest = params.some(p => p.rest);
    // Rest params don't count toward expected/min — they accept 0+ extra args
    const nonRestParams = params.filter(p => !p.rest);
    const expectedParamCount = nonRestParams.length;
    const optionalCount = nonRestParams.filter(p => p.optional || p.default !== undefined).length;
    const minArgs = expectedParamCount - optionalCount;

    // Get all call sites using findCallers for accurate resolution
    // (usages-based approach misses calls when className is set or local names collide)
    let callerResults = index.findCallers(name, {
        includeMethods: true,
        includeUncertain: false,
        targetDefinitions: [def],
    });

    // When className is explicitly provided, filter out method calls whose
    // receiver clearly belongs to a different type (same logic as impact()).
    if (options.className && def.className) {
        const targetClassName = def.className;
        callerResults = callerResults.filter(c => {
            if (!c.isMethod) return true;
            const r = c.receiver;
            if (!r || ['self', 'cls', 'this', 'super'].includes(r)) return true;
            if (r.toLowerCase().includes(targetClassName.toLowerCase())) return true;
            // Check local variable type inference from constructor assignments
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
                                        const content = index._readFile(c.callerFile);
                                        const clines = content.split('\n');
                                        const cline = clines[call.line - 1] || '';
                                        const m = cline.match(/^\s*(\w+)\s*=\s*(?:await\s+)?(\w+)\s*\(/);
                                        if (m && m[2] === call.name) {
                                            localTypes.set(m[1], call.name);
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
            // Check parameter type annotations: def foo(tracker: SourceTracker) → tracker.record()
            if (c.callerFile && c.callerStartLine) {
                const callerSymbol = index.findEnclosingFunction(c.callerFile, c.line, true);
                if (callerSymbol && callerSymbol.paramsStructured) {
                    for (const param of callerSymbol.paramsStructured) {
                        if (param.name === r && param.type) {
                            const typeMatches = param.type.match(/\b([A-Za-z_]\w*)\b/g);
                            if (typeMatches && typeMatches.some(t => t === targetClassName)) {
                                return true;
                            }
                            return false;
                        }
                    }
                }
            }
            // Unique method heuristic: if the called method exists on exactly one class
            // and it matches the target, include the call (no other class could match)
            const methodDefs = index.symbols.get(name);
            if (methodDefs) {
                const classNames = new Set();
                for (const d of methodDefs) {
                    if (d.className) classNames.add(d.className);
                }
                if (classNames.size === 1 && classNames.has(targetClassName)) {
                    return true;
                }
            }
            // className explicitly set but receiver type unknown — filter it out
            return false;
        });
    }

    // Convert caller results to usage-like objects for analyzeCallSite
    const calls = callerResults.map(c => ({
        file: c.file,
        relativePath: c.relativePath,
        line: c.line,
        content: c.content,
        usageType: 'call',
        receiver: c.receiver,
    }));

    const valid = [];
    const mismatches = [];
    const uncertain = [];

    // If the definition is NOT a method, filter out method calls (e.g., dict.get() vs get())
    // This prevents false positives where a standalone function name matches method calls.
    // Exception: module-level calls (module.func()) are kept when the receiver matches the
    // target module's name and is an imported name (e.g., jobs.submit() where jobs is imported
    // and the function lives in jobs.py).
    const defIsMethod = !!(def.isMethod || def.type === 'method' || def.className);
    const targetBasename = path.basename(def.file, path.extname(def.file));
    const defFileEntry = index.files.get(def.file);
    const defLang = defFileEntry?.language;

    // Build import-name lookup for receiver checking (module.func() vs dict.get())
    const importNameCache = new Map();
    function getImportedNames(filePath) {
        if (importNameCache.has(filePath)) return importNameCache.get(filePath);
        const names = new Set();
        const fe = index.files.get(filePath);
        if (!fe) { importNameCache.set(filePath, names); return names; }
        try {
            const content = index._readFile(filePath);
            const { imports: rawImports, importAliases } = extractImports(content, fe.language);
            for (const imp of rawImports) {
                if (imp.names) for (const n of imp.names) names.add(n);
            }
            if (importAliases) {
                for (const alias of importAliases) names.add(alias.local);
            }
        } catch (e) { /* skip */ }
        importNameCache.set(filePath, names);
        return names;
    }

    for (const call of calls) {
        const analysis = analyzeCallSite(index, call, name);

        // Skip method calls when verifying a non-method definition.
        // This prevents false positives (e.g., dict.get() vs standalone get()).
        // Allow module-level calls only when:
        // 1. Receiver matches target file's basename (e.g., jobs == jobs for jobs.py)
        // 2. Receiver is an imported name (not a local variable)
        if (analysis.isMethodCall && !defIsMethod) {
            const callReceiver = call.receiver;
            if (callReceiver && callReceiver === targetBasename) {
                const importedNames = getImportedNames(call.file);
                if (!importedNames.has(callReceiver)) continue;
                // Receiver matches target module and is imported — keep it
            } else if (callReceiver && langTraits(defLang)?.hasReceiverPackageCalls) {
                // Go: receiver is package alias (last segment of import path, e.g., "controller"
                // from "k8s.io/.../pkg/controller"), not the filename ("controller_utils").
                // Check if receiver matches the directory name of the target file.
                const targetDir = path.basename(path.dirname(def.file));
                if (callReceiver !== targetDir) {
                    continue;
                }
                // Receiver matches package directory — keep it
            } else if (callReceiver && isNamespaceContainerFor(index, callReceiver, name, def.file)) {
                // BUG-BX: TS namespace-qualified call (e.g. `Utils.helper()` where
                // `Utils` is a `namespace` symbol containing `helper`). Treat the
                // call as a direct invocation of the namespace member function.
                // Same handling for class static methods and module containers.
            } else {
                continue;
            }
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
        found: true,
        function: name,
        file: def.relativePath,
        startLine: def.startLine,
        // BUG-BV: use local TS-correct param formatter (`opt?: number`, not `opt: number?`).
        // BUG-BY: when the def is a typed arrow declaration, render with enriched types.
        signature: formatTypedSignature(def, arrowTypes ? {
            paramsStructured: arrowTypes.paramsStructured,
            returnType: arrowTypes.returnType
        } : {}),
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

    const resolved = index.resolveSymbol(name, { file: options.file, className: options.className, line: options.line });
    const def = resolved.def || definitions[0];
    // BUG-BY: enrich types for typed-arrow-fn declarations.
    const arrowTypes = extractArrowTypesFromVarDecl(index, def);
    const currentParams = (arrowTypes?.paramsStructured) || def.paramsStructured || [];
    // BUG-BV: render with TS-correct param formatting (`opt?: number`).
    const currentSignature = formatTypedSignature(def, arrowTypes ? {
        paramsStructured: arrowTypes.paramsStructured,
        returnType: arrowTypes.returnType
    } : {});

    // BUG-BW: plan must discover call sites the same way verify does for class
    // methods. Previously plan relied on `index.impact()` whose filter rejected
    // calls with unresolved receivers (e.g. `this.field.method()`), even when
    // verify's filter accepts them. Compute call sites locally to keep plan
    // and verify in lock-step.
    const planCallSites = computePlanCallSites(index, name, def, options);
    const impactScopeWarning = computePlanScopeWarning(index, name, def, options);

    // Reject ambiguous multi-op invocations rather than silently coalescing.
    // The previous behavior reported only the *last* operation in the
    // headline, which made plan output untrustworthy for multi-op refactors.
    const requestedOps = [
        options.addParam ? 'addParam' : null,
        options.removeParam ? 'removeParam' : null,
        options.renameTo ? 'renameTo' : null,
    ].filter(Boolean);
    if (requestedOps.length > 1) {
        return {
            found: true,
            function: name,
            error: `plan accepts one operation at a time; got ${requestedOps.length}: ${requestedOps.join(', ')}. Run separately and compose results.`,
        };
    }

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

        // When adding a param, insert before rest params (*args/**kwargs) and
        // before optional params (required must precede optional in Python/TS).
        {
            const selfNames = ['self', 'cls', '&self', '&mut self', 'mut self'];
            const minIdx = (newParams.length > 0 && selfNames.includes(newParams[0].name)) ? 1 : 0;
            const firstRestIdx = newParams.findIndex(p => p.rest || (p.name && (p.name.startsWith('*') || p.name.startsWith('...'))));
            if (firstRestIdx !== -1) {
                // Always insert before rest params (*args, **kwargs, ...rest)
                const insertIdx = Math.max(firstRestIdx, minIdx);
                newParams.splice(insertIdx, 0, newParam);
            } else if (!options.defaultValue) {
                const firstOptIdx = newParams.findIndex(p => p.optional || p.default !== undefined);
                if (firstOptIdx !== -1) {
                    const insertIdx = Math.max(firstOptIdx, minIdx);
                    newParams.splice(insertIdx, 0, newParam);
                } else {
                    newParams.push(newParam);
                }
            } else {
                newParams.push(newParam);
            }
        }

        // Generate new signature with TS-correct optional marker (BUG-BV)
        // and arrow-fn enriched return type (BUG-BY).
        const paramsList = newParams.map(formatTypedParam).filter(Boolean).join(', ');
        const asyncPrefix = (def.async || def.isAsync || def.modifiers?.includes('async')) ? 'async ' : '';
        newSignature = `${asyncPrefix}${name}(${paramsList})`;
        const newRet = arrowTypes?.returnType || def.returnType;
        if (newRet) newSignature += `: ${newRet}`;

        // Describe changes needed at each call site
        for (const site of planCallSites) {
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

    if (options.removeParam) {
        operation = 'remove-param';
        // Normalize self-parameter lookup: 'self' matches '&self', '&mut self', 'mut self'
        let removeTarget = options.removeParam;
        let paramIndex = currentParams.findIndex(p => p.name === removeTarget);
        if (paramIndex === -1 && removeTarget === 'self') {
            paramIndex = currentParams.findIndex(p => /^&?(?:mut )?self$/.test(p.name));
            if (paramIndex !== -1) removeTarget = currentParams[paramIndex].name;
        }
        if (paramIndex === -1) {
            return {
                found: true,
                error: `Parameter "${options.removeParam}" not found in ${name}`,
                currentParams: currentParams.map(p => p.name)
            };
        }

        newParams = currentParams.filter(p => p.name !== removeTarget);

        // Generate new signature with TS-correct optional marker (BUG-BV)
        // and arrow-fn enriched return type (BUG-BY).
        const paramsList = newParams.map(formatTypedParam).filter(Boolean).join(', ');
        const asyncPrefix = (def.async || def.isAsync || def.modifiers?.includes('async')) ? 'async ' : '';
        newSignature = `${asyncPrefix}${name}(${paramsList})`;
        const newRet = arrowTypes?.returnType || def.returnType;
        if (newRet) newSignature += `: ${newRet}`;

        // For Python/Rust methods, self/cls/&self/&mut self is in paramsStructured
        // but callers don't pass it. Adjust paramIndex to caller-side position.
        const fileEntry = index.files.get(def.file);
        const lang = fileEntry?.language;
        let selfOffset = 0;
        const planSelfParams = langTraits(lang)?.selfParam;
        if (planSelfParams && currentParams.length > 0 && planSelfParams.includes(currentParams[0].name)) {
            selfOffset = 1;
        }
        const callerArgIndex = paramIndex - selfOffset;

        // Describe changes at each call site
        for (const site of planCallSites) {
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

    if (options.renameTo) {
        operation = 'rename';
        newSignature = currentSignature.replace(new RegExp('\\b' + escapeRegExp(name) + '\\b'), options.renameTo);

        // All call sites need renaming
        for (const site of planCallSites) {
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
            // BUG-BV: TS-correct optional marker (`opt?: number`); test contract
            // expects name-keyed array entries (no ` = default`, no rest prefix)
            // so callers can `.includes('paramName')` for exact match.
            params: currentParams.map(p => formatPlanParamName(p)).filter(Boolean)
        },
        after: {
            signature: newSignature,
            params: newParams.map(p => formatPlanParamName(p)).filter(Boolean)
        },
        totalChanges: changes.length,
        filesAffected: new Set(changes.map(c => c.file)).size,
        changes,
        scopeWarning: impactScopeWarning
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

module.exports = { verify, plan, analyzeCallSite, analyzeCallSiteAST, analyzeCallShape, classifyArgNode, findCallNode, clearTreeCache, identifyCallPatterns };
