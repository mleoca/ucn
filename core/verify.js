/**
 * core/verify.js - Signature verification, refactoring planning, call site analysis
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const { detectLanguage, getParser, getLanguageAdapter, safeParse, langTraits } = require('../languages');
const { escapeRegExp, codeUnitCompare, NON_CALLABLE_TYPES } = require('./shared');

function codeUnitColumnForByteColumn(line, byteColumn) {
    if (!Number.isInteger(byteColumn) || byteColumn < 0) return null;
    let bytes = 0;
    for (let i = 0; i <= line.length; i++) {
        if (bytes === byteColumn) return i;
        if (i === line.length) break;
        const cp = line.codePointAt(i);
        const ch = String.fromCodePoint(cp);
        bytes += Buffer.byteLength(ch);
        if (ch.length === 2) i++;
    }
    return null;
}

/** Replace only AST identifier tokens on one source line. */
function renameIdentifierTokens(index, filePath, lineNumber, oldName, newName,
    preferredByteColumns = null, expectedCallCount = null) {
    const absolute = filePath && require('path').isAbsolute(filePath)
        ? filePath : require('path').join(index.root, filePath || '');
    const content = index._readFile(absolute);
    const sourceLine = content.split('\n')[lineNumber - 1] || '';
    let byteColumns = Array.isArray(preferredByteColumns)
        ? preferredByteColumns.filter(Number.isInteger) : [];

    if (byteColumns.length === 0) {
        const language = index.files.get(absolute)?.language ||
            detectLanguage(absolute, index.root);
        const parser = language && getParser(language);
        const tree = parser && (index._getParsedTree?.(absolute, content, language) ||
            safeParse(parser, content));
        if (tree) {
            const targetRow = lineNumber - 1;
            const stack = [tree.rootNode];
            while (stack.length > 0) {
                const node = stack.pop();
                if (node.endPosition.row < targetRow ||
                    node.startPosition.row > targetRow) continue;
                if (node.startPosition.row === targetRow && node.text === oldName &&
                    /identifier(?:_pattern)?$/.test(node.type)) {
                    let eligible = preferredByteColumns == null;
                    if (!eligible) {
                        const callTypes = new Set([
                            'call', 'call_expression', 'method_invocation',
                            'invocation_expression', 'method_call_expression',
                        ]);
                        for (let parent = node.parent, depth = 0;
                            parent && depth < 5; parent = parent.parent, depth++) {
                            if (!callTypes.has(parent.type)) continue;
                            const target = parent.childForFieldName('function') ||
                                parent.childForFieldName('name') ||
                                parent.childForFieldName('method') ||
                                parent.namedChild(0);
                            if (target && node.startIndex >= target.startIndex &&
                                node.endIndex <= target.endIndex) eligible = true;
                            break;
                        }
                    }
                    if (eligible) byteColumns.push(node.startPosition.column);
                    continue;
                }
                stack.push(...(node.namedChildren || []));
            }
        }
    }

    const columns = [...new Set(byteColumns
        .map(column => codeUnitColumnForByteColumn(sourceLine, column))
        .filter(Number.isInteger))].sort((a, b) => b - a);
    if (expectedCallCount != null && columns.length !== expectedCallCount) {
        return { source: sourceLine.trim(), renamed: sourceLine.trim(), count: 0 };
    }
    let renamed = sourceLine;
    for (const column of columns) {
        if (renamed.slice(column, column + oldName.length) !== oldName) continue;
        renamed = renamed.slice(0, column) + newName +
            renamed.slice(column + oldName.length);
    }
    return { source: sourceLine.trim(), renamed: renamed.trim(), count: columns.length };
}

// ============================================================================
// CALL-SITE CLASSIFICATION (Feature A)
// ============================================================================
// AST node-type sets per language for walk-up classification of call sites.
// Detection is structural — we walk parents from the call node and stop at
// function boundaries to keep the classification scoped to the enclosing fn.

// Loop nodes — call sites inside these are "hot path" (likely repeated).
const LOOP_NODE_TYPES = {
    javascript: new Set(['for_statement', 'while_statement', 'do_statement', 'for_in_statement', 'for_of_statement']),
    typescript: new Set(['for_statement', 'while_statement', 'do_statement', 'for_in_statement', 'for_of_statement']),
    tsx:        new Set(['for_statement', 'while_statement', 'do_statement', 'for_in_statement', 'for_of_statement']),
    html:       new Set(['for_statement', 'while_statement', 'do_statement', 'for_in_statement', 'for_of_statement']),
    python:     new Set(['for_statement', 'while_statement']),
    go:         new Set(['for_statement']),
    rust:       new Set(['for_expression', 'while_expression', 'loop_expression']),
    java:       new Set(['for_statement', 'while_statement', 'do_statement', 'enhanced_for_statement']),
};

// Try nodes — call sites inside these are "guarded" (errors are caught).
// Go uses defer/recover (skipped). Rust uses Result-based error handling (skipped).
const TRY_NODE_TYPES = {
    javascript: new Set(['try_statement']),
    typescript: new Set(['try_statement']),
    tsx:        new Set(['try_statement']),
    html:       new Set(['try_statement']),
    python:     new Set(['try_statement']),
    go:         new Set(),
    rust:       new Set(),
    java:       new Set(['try_statement', 'try_with_resources_statement']),
};

// Function boundary nodes — walk-up stops at these (we don't classify across
// inner function definitions). These also identify "callback wrappers" when
// they're the value of an argument to another call_expression.
const FN_NODE_TYPES = {
    javascript: new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'generator_function', 'generator_function_declaration']),
    typescript: new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'generator_function', 'generator_function_declaration', 'function_signature']),
    tsx:        new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'generator_function', 'generator_function_declaration', 'function_signature']),
    html:       new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'generator_function', 'generator_function_declaration']),
    python:     new Set(['function_definition', 'async_function_definition', 'lambda']),
    go:         new Set(['function_declaration', 'method_declaration', 'func_literal']),
    rust:       new Set(['function_item', 'closure_expression']),
    java:       new Set(['method_declaration', 'constructor_declaration', 'lambda_expression']),
};

// Await-expression node types per language with async/await support.
// JS/TS: await is a unary expression `await call()`.
// Python: await is `await call()`.
// Go/Java/Rust currently have no await keyword tracked here.
const AWAIT_NODE_TYPES = {
    javascript: new Set(['await_expression']),
    typescript: new Set(['await_expression']),
    tsx:        new Set(['await_expression']),
    html:       new Set(['await_expression']),
    python:     new Set(['await']),
    go:         new Set(),
    rust:       new Set(),
    java:       new Set(),
};

// Argument-list node types — used to detect callback context. When walking up,
// if a function/lambda we cross has a parent of these types (which is itself
// inside a call_expression), the inner call is in a callback.
const ARGUMENTS_NODE_TYPES = new Set(['arguments', 'argument_list']);

/**
 * Classify a call site by walking up its ancestors.
 *
 * Returns flags describing the structural context: `inLoop`, `inTry`,
 * `inCallback`, `awaited`. Walks from the call node up to the enclosing
 * function boundary (so an outer try wrapping an inner function does NOT
 * leak `inTry: true` into a call inside the inner function).
 *
 * `inCallback` is set when, while walking up to the boundary, we cross an
 * inner function/lambda that is itself an argument of another call.
 *
 * `awaited` is set when the call expression's immediate parent is an
 * await-style node. Non-async languages always return `awaited: false`.
 *
 * @param {object} callNode - tree-sitter node for the call
 * @param {string} language - canonical language name
 * @returns {{inLoop:boolean, inTry:boolean, inCallback:boolean, awaited:boolean}}
 */
function classifyCallContext(callNode, language) {
    const result = { inLoop: false, inTry: false, inCallback: false, awaited: false };
    if (!callNode) return result;

    const loopTypes = LOOP_NODE_TYPES[language] || new Set();
    const tryTypes = TRY_NODE_TYPES[language] || new Set();
    const fnTypes = FN_NODE_TYPES[language] || new Set();
    const awaitTypes = AWAIT_NODE_TYPES[language] || new Set();

    // awaited: parent of the call must be an await-style node.
    // Some grammars (Python) wrap the call in `await { call }`; others
    // (JS/TS) use `await_expression > call_expression`. Both are detected by
    // checking the immediate parent.
    if (callNode.parent && awaitTypes.has(callNode.parent.type)) {
        result.awaited = true;
    }

    // Walk up to classify loop/try/callback. Stop when we cross a function
    // boundary — an inner closure isolates the inner call from outer context.
    let current = callNode.parent;
    while (current) {
        const t = current.type;
        if (loopTypes.has(t)) result.inLoop = true;
        if (tryTypes.has(t)) result.inTry = true;
        // Function boundary — stop, but first check if THIS function is an
        // argument to another call (callback context). The ancestor chain is:
        //   outer_call > arguments > arrow_function/lambda > … > inner call
        if (fnTypes.has(t)) {
            const parent = current.parent;
            if (parent && ARGUMENTS_NODE_TYPES.has(parent.type)) {
                const grand = parent.parent;
                if (grand && (grand.type === 'call_expression' || grand.type === 'call' ||
                    grand.type === 'method_invocation' || grand.type === 'object_creation_expression' ||
                    grand.type === 'macro_invocation')) {
                    result.inCallback = true;
                }
            }
            break;
        }
        current = current.parent;
    }
    return result;
}

/**
 * Find a call expression node at the target line matching funcName
 */
function findCallNode(node, callTypes, targetRow, funcName, occurrence = 0) {
    // Several same-name calls can share one line (`greet("a") + greet("b")`,
    // f-strings) — fix #231: callers pass the site's per-line ordinal so each
    // record is arg-checked against ITS OWN node, not the line's first.
    // Records and this walk are both pre-order, so ordinals align; an
    // out-of-range ordinal falls back to the first match (never worse than
    // the pre-fix behavior when a parse shape hides a node).
    const matches = _collectCallNodes(node, callTypes, targetRow, funcName, occurrence + 1);
    return matches[occurrence] || matches[0] || null;
}

function _collectCallNodes(node, callTypes, targetRow, funcName, limit, out = []) {
    if (out.length >= limit) return out;
    if (node.startPosition.row > targetRow || node.endPosition.row < targetRow) {
        return out; // Skip nodes that don't contain the target line
    }

    if (callTypes.has(node.type) && node.startPosition.row <= targetRow && node.endPosition.row >= targetRow) {
        // Java constructor: new ClassName(args) — name is in 'type' field
        if (node.type === 'object_creation_expression') {
            const typeNode = node.childForFieldName('type');
            if (typeNode) {
                // Strip generics and package qualifiers: com.foo.Bar<T> -> Bar
                const typeName = typeNode.text.replace(/<.*>$/, '').split('.').pop();
                if (typeName === funcName) out.push(node);
            }
        } else if (node.type === 'new_expression') {
            // JS/TS constructor: new ClassName(args) — class is in 'constructor'
            // field (fix #230: these sites used to fall out as "Could not
            // parse call arguments" and every class verify went uncertain).
            const ctorNode = node.childForFieldName('constructor') ||
                node.childForFieldName('type');
            if (ctorNode) {
                const typeName = ctorNode.text.replace(/<.*>$/, '').split('.').pop();
                if (typeName === funcName) out.push(node);
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
                const memberProperty = funcNode.type === 'member_expression'
                    ? funcNode.childForFieldName('property')
                    : null;
                const indirectKind = memberProperty &&
                    ['call', 'apply', 'bind'].includes(memberProperty.text)
                    ? memberProperty.text
                    : null;
                const indirectObject = indirectKind
                    ? funcNode.childForFieldName('object')
                    : null;
                const indirectTarget = indirectObject?.type === 'member_expression'
                    ? indirectObject.childForFieldName('property')?.text
                    : indirectObject?.text;
                const funcText = funcNode.type === 'member_expression' ||
                    funcNode.type === 'member_access_expression' ||
                    funcNode.type === 'selector_expression' ||
                    funcNode.type === 'field_expression' || funcNode.type === 'attribute'
                    ? (funcNode.childForFieldName('property') || funcNode.childForFieldName('name') ||
                        funcNode.childForFieldName('field') || funcNode.childForFieldName('attribute') ||
                        funcNode.namedChild(funcNode.namedChildCount - 1))?.text
                    : funcNode.type === 'scoped_identifier' || funcNode.type === 'qualified_identifier'
                    ? (funcNode.childForFieldName('name') || funcNode.namedChild(funcNode.namedChildCount - 1))?.text
                    : funcNode.text;
                if (funcText === funcName || indirectTarget === funcName) out.push(node);
            }
        }
        if (out.length >= limit) return out;
    }

    // Recurse into children — nested same-name calls (`greet(greet(x))`)
    // are separate records, so a match's children are still scanned.
    for (let i = 0; i < node.childCount; i++) {
        _collectCallNodes(node.child(i), callTypes, targetRow, funcName, limit, out);
        if (out.length >= limit) return out;
    }
    return out;
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
 * Compute the modifier-prefix tokens for a function/method definition.
 * Returns an array of tokens (e.g. ['static', 'async']) drawn from:
 *   - def.modifiers          (Java, Python async, Rust pub/async, ...)
 *   - def.isAsync / def.async (JS/TS class methods)
 *   - def.memberType         (JS/TS: 'static', 'static get', 'static override', ...)
 *
 * BUG-5: rename and add-param signature reconstruction must preserve modifier
 * prefixes (async/static/public/...) — JS class methods don't populate
 * def.modifiers, so we synthesise tokens from isAsync + memberType.
 * @param {object} def
 * @returns {string[]} ordered modifier tokens (no trailing space)
 */
function computeModifierTokens(def) {
    if (!def) return [];
    const tokens = [];
    // Pull declared modifiers first (Java public/static/final, Python ['async'], Rust pub/async).
    if (Array.isArray(def.modifiers) && def.modifiers.length) {
        for (const m of def.modifiers) {
            if (typeof m === 'string' && m.length && !tokens.includes(m)) tokens.push(m);
        }
    }
    // JS/TS class methods: memberType encodes static/get/set/override/private.
    // Examples: 'static', 'static get', 'static override', 'static override get',
    //           'override', 'override get', 'get', 'set', 'private', 'method',
    //           'abstract', 'constructor'. Only structural prefixes are added.
    const memberType = def.memberType;
    if (typeof memberType === 'string' && memberType.length) {
        const STRUCTURAL_PREFIXES = new Set(['static', 'override', 'abstract', 'public', 'private', 'protected', 'readonly', 'get', 'set']);
        for (const tok of memberType.split(/\s+/)) {
            if (STRUCTURAL_PREFIXES.has(tok) && !tokens.includes(tok)) tokens.push(tok);
        }
    }
    // Async (JS/TS isAsync, fallback for languages that set def.async).
    const asyncFlag = def.isAsync || def.async || (Array.isArray(def.modifiers) && def.modifiers.includes('async'));
    if (asyncFlag && !tokens.includes('async')) tokens.push('async');
    return tokens;
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
    const modTokens = computeModifierTokens(def);
    if (modTokens.length) {
        parts.push(modTokens.join(' '));
    }
    const name = overrides.name || def.name;
    parts.push(name);
    const ps = overrides.paramsStructured != null ? overrides.paramsStructured : def.paramsStructured;
    if (Array.isArray(ps)) {
        const paramTypes = def.paramTypes || {};
        // Python binding-position markers (fix #281): re-render the bare `*`
        // before the first keyword-only param (unless `*args` already plays
        // that role) and the `/` after the last positional-only param, so the
        // displayed signature matches the source contract.
        const lastPosOnly = ps.reduce(
            (acc, p, i) => (p && p.positionalOnly ? i : acc), -1);
        let starShown = false;
        const parts2 = [];
        ps.forEach((p, i) => {
            // Apply paramTypes mapping when paramsStructured doesn't carry types
            const merged = { ...p };
            if (!merged.type && paramTypes[p.name]) merged.type = paramTypes[p.name];
            if (p && p.rest && /^\*(?!\*)/.test(String(p.name))) starShown = true;
            if (!starShown && p && p.keywordOnly) {
                parts2.push('*');
                starShown = true;
            }
            const tok = formatTypedParam(merged);
            if (tok) parts2.push(tok);
            if (i === lastPosOnly) parts2.push('/');
        });
        parts.push(`(${parts2.join(', ')})`);
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
 * Constructor parameter lists for a CLASS verify/plan target (fix #230): a
 * class def carries no paramsStructured, so `verify Task` used to arg-check
 * `new Task(id, name)` against 0..0 — a false red on every parameterized
 * constructor, in every language. Sources: indexed constructor members
 * (JS/TS `constructor`, Python `__init__` — emitted with type
 * 'constructor'), or a Java AST walk (constructors are deliberately not
 * indexed as members there). Returns an array of paramsStructured lists —
 * one per constructor overload — or null when the class declares none.
 * @param {object} index - ProjectIndex instance
 * @param {object} def - Resolved definition (any type; non-class returns null)
 * @param {string} lang - The definition file's language
 * @returns {Array<Array<object>>|null}
 */
function _constructorParamLists(index, def, lang) {
    if (!def || !def.file || !['class', 'struct', 'enum', 'record'].includes(def.type)) return null;
    const lists = [];
    const endLine = def.endLine != null ? def.endLine : Infinity;
    const inRange = (d) => d.file === def.file &&
        d.startLine >= def.startLine && d.startLine <= endLine &&
        Array.isArray(d.paramsStructured);
    for (const ctorName of ['constructor', '__init__']) {
        for (const d of (index.symbols.get(ctorName) || [])) {
            if (d.className === def.name && inRange(d)) lists.push(d.paramsStructured);
        }
    }
    // Java constructor members are named after the CLASS (enum-body
    // constructors carry paramsStructured since fix #230).
    for (const d of (index.symbols.get(def.name) || [])) {
        if (d.type === 'constructor' && d.className === def.name && inRange(d)) {
            lists.push(d.paramsStructured);
        }
    }
    if (lists.length > 0) return lists;
    if (lang !== 'java') return null;
    let parser, content;
    try {
        parser = getParser('java');
        content = index._readFile(def.file);
    } catch (e) {
        return null;
    }
    if (!parser || content == null) return null;
    const tree = safeParse(parser, content);
    if (!tree) return null;
    const { parseStructuredParams } = require('../languages/utils');
    const targetRow = def.startLine - 1;
    let classNode = null;
    (function findClass(node) {
        if (classNode || !node) return;
        if ((node.type === 'class_declaration' || node.type === 'enum_declaration' ||
             node.type === 'record_declaration') &&
            node.startPosition.row <= targetRow && node.endPosition.row >= targetRow) {
            const nameNode = node.childForFieldName('name');
            if (nameNode && nameNode.text === def.name) {
                classNode = node;
                return;
            }
        }
        for (let i = 0; i < node.namedChildCount; i++) findClass(node.namedChild(i));
    })(tree.rootNode);
    if (!classNode) return null;
    // Records declare their canonical constructor's params on the header.
    if (classNode.type === 'record_declaration') {
        const recParams = classNode.childForFieldName('parameters');
        if (recParams) lists.push(parseStructuredParams(recParams, 'java') || []);
    }
    const collectCtors = (body) => {
        if (!body) return;
        for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i);
            if (child.type === 'constructor_declaration') {
                const paramsNode = child.childForFieldName('parameters');
                lists.push(parseStructuredParams(paramsNode, 'java') || []);
            } else if (child.type === 'enum_body_declarations') {
                collectCtors(child);
            }
        }
    };
    collectCtors(classNode.childForFieldName('body'));
    return lists.length > 0 ? lists : null;
}

/**
 * v4 tiered caller sweep shared by verify and plan (BUG-BW lockstep): run
 * findCallers in collectAccount mode and partition candidates into the
 * confirmed band (arg-checked / planned) and the VISIBLE unverified band
 * (rendered with reasons, never silently dropped). The pre-v4 className and
 * receiver heuristics are gone — engine receiver physics decide tier and
 * exclusion, and their fallback branches could silently drop true callers.
 * Namespace-container receivers (BUG-BX `Utils.helper()`) confirm in the
 * ENGINE since fix #254 (range-based containment + scope evidence), so no
 * verify-local promotion remains — the bands are the sweep's verbatim.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Symbol name
 * @param {object} def - Resolved definition (pinned target)
 * @returns {{ confirmed: Array, unverified: Array, account: object }}
 */
function contractedCallerSweep(index, name, def) {
    const rawCallers = index.findCallers(name, {
        includeMethods: true,
        targetDefinitions: [def],
        collectAccount: true,
    });

    const confirmed = [];
    const unverified = [];
    for (const c of rawCallers) {
        if (c.tier !== 'unverified') confirmed.push(c);
        else unverified.push(c);
    }
    for (const u of rawCallers.unverifiedEntries || []) {
        unverified.push(u);
    }

    // Conservation account from the sweep's claims (impact's manual
    // composition).
    const { computeGroundSet, buildAccount } = require('./account');
    const groundSet = computeGroundSet(index, name);
    const accountRaw = rawCallers.accountRaw || { unverifiedLines: [], excludedEntries: [] };
    const confirmedEntries = confirmed.map(c => ({ file: c.file, line: c.line }));
    const unverifiedEntries = [
        ...accountRaw.unverifiedLines,
        ...unverified.map(u => ({ file: u.file, line: u.line })),
    ];
    for (const s of rawCallers.shadowEntries || []) {
        (s.tier === 'unverified' ? unverifiedEntries : confirmedEntries).push({ file: s.file, line: s.line });
    }
    const account = buildAccount(index, name, {
        groundSet,
        confirmedEntries,
        unverifiedEntries,
        excludedEntries: accountRaw.excludedEntries,
    });

    // Ground call-lines no engine candidate claimed: visible one-liners
    // (already counted unverified in the account arithmetic).
    const { callNotResolvedEntries } = require('./analysis');
    for (const e of callNotResolvedEntries(index, account)) unverified.push(e);
    unverified.sort((a, b) => {
        const ap = a.relativePath || '';
        const bp = b.relativePath || '';
        if (ap !== bp) return codeUnitCompare(ap, bp);
        return (a.line || 0) - (b.line || 0);
    });

    return { confirmed, unverified, account };
}

/** Map an unverified sweep entry to the public site shape (relative `file`). */
function unverifiedSiteShape(u) {
    return {
        file: u.relativePath,
        line: u.line,
        expression: (u.content || '').trim(),
        callerName: u.callerName ?? null,
        tier: 'unverified',
        ...(u.reason && { reason: u.reason }),
        ...(u.dispatchVia && { dispatchVia: u.dispatchVia }),
        ...(u.dispatchCandidates != null && { dispatchCandidates: u.dispatchCandidates }),
        // External attribution (fixes #210/#220(6)/#265D): the engine already
        // labels these routes; the JSON site must carry the flag so consumers
        // can tell "satisfied by a contract outside the project" from
        // project-attributed dispatch (the text band renders it already).
        ...(u.externalContract && { externalContract: true }),
        // Module-attribute attribution (fix #294): the name binds the module's
        // export surface — a non-slot surface for rename purposes.
        ...(u.moduleAttribute && { moduleAttribute: true }),
    };
}

/**
 * BUG-BW: Build the list of call sites for `plan` using the SAME sweep verify
 * uses. This guarantees plan and verify agree on which sites need updating.
 *
 * @param {object} index - ProjectIndex instance
 * @param {string} name - Function name being refactored
 * @param {object} def - Resolved definition
 * @returns {{ sites: Array, unverifiedSites: Array, account: object }}
 */
function computePlanCallSites(index, name, def) {
    const { confirmed, unverified, account } = contractedCallerSweep(index, name, def);

    const sites = [];
    const planLineSeen = new Map(); // 'file:line' -> per-line ordinal (fix #231)
    for (const c of confirmed) {
        const call = {
            file: c.file,
            relativePath: c.relativePath,
            line: c.line,
            content: c.content,
            usageType: 'call',
            receiver: c.receiver,
        };
        const siteKey = `${c.file}:${c.line}`;
        const occurrence = planLineSeen.get(siteKey) || 0;
        planLineSeen.set(siteKey, occurrence + 1);
        const analysis = analyzeCallSite(index, call, name, occurrence);
        sites.push({
            file: call.relativePath,
            absoluteFile: call.file,
            line: call.line,
            ...(Number.isInteger(c.column) && { column: c.column }),
            expression: (call.content || '').trim(),
            args: analysis.args,
            argCount: analysis.argCount,
            ...(c.calledAs && { calledAs: c.calledAs }),
        });
    }
    clearTreeCache(index);
    // Stable ordering (matches CLAUDE.md rule #11): files alphabetical, sites by line ascending.
    sites.sort((a, b) => {
        const fc = codeUnitCompare(String(a.file), String(b.file));
        if (fc !== 0) return fc;
        return (a.line || 0) - (b.line || 0);
    });
    return { sites, unverifiedSites: unverified.map(unverifiedSiteShape), account };
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
function analyzeCallSite(index, call, funcName, occurrence = 0) {
    try {
        const language = detectLanguage(call.file);
        if (!language) return { args: null, argCount: 0 };

        // Use tree cache to avoid re-parsing the same file in batch operations
        let tree = index._treeCache?.get(call.file);
        if (!tree) {
            const content = index._readFile(call.file);
            // HTML files need special handling: parse script blocks as JS
            if (language === 'html') {
                const htmlModule = getLanguageAdapter('html');
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
        const callTypes = new Set(['call_expression', 'call', 'method_invocation',
            'invocation_expression', 'object_creation_expression', 'new_expression']);
        const targetRow = call.line - 1; // tree-sitter is 0-indexed

        // Find the call expression at the target line matching funcName
        const callNode = findCallNode(tree.rootNode, callTypes, targetRow, funcName, occurrence);
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

        // Feature A/B: classify the call site by structural context.
        // inLoop/inTry/inCallback come from walking up to the fn boundary.
        // awaited comes from the immediate parent (await_expression).
        // inTestCase is computed by the caller via the enclosing function's
        // entry-point kind — analyzeCallSite doesn't have that info here, so
        // it's left to be filled in by impact()/about() etc. that have
        // access to the enclosing-function symbol.
        const ctx = classifyCallContext(callNode, language);

        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return { args: [], argCount: 0, isMethodCall, ...ctx };

        let args = [];
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const argNode = argsNode.namedChild(i);
            if (argNode.type.includes('comment')) continue;
            args.push(argNode.text.trim());
        }

        // Python argument structure (fix #281): keyword arguments bind by
        // NAME, and `*seq` / `**map` unpacking makes the argument count
        // non-static. Both were invisible before — keyword args counted as
        // positional slots and unpacking fell through to a hard mismatch.
        const keywordArgNames = [];
        let unpackingArgs = 0;
        let pyPositional = 0;
        if (language === 'python') {
            for (let i = 0; i < argsNode.namedChildCount; i++) {
                const argNode = argsNode.namedChild(i);
                if (argNode.type.includes('comment')) continue;
                if (argNode.type === 'keyword_argument') {
                    const nameNode = argNode.childForFieldName('name') || argNode.namedChild(0);
                    if (nameNode) keywordArgNames.push(nameNode.text);
                } else if (argNode.type === 'list_splat' || argNode.type === 'dictionary_splat') {
                    unpackingArgs++;
                } else {
                    pyPositional++;
                }
            }
        }

        // Function.prototype indirection has a precise, AST-visible argument
        // mapping. `fn.call(thisArg, a, b)` invokes fn(a, b). `fn.apply`
        // is countable only when its argument array is a literal. `bind`
        // creates a partially applied function rather than invoking it, so it
        // remains explicitly uncertain instead of looking like a parser bug.
        let indirectKind = null;
        if (language === 'javascript' || language === 'typescript' ||
            language === 'tsx' || language === 'html') {
            const property = funcNode?.type === 'member_expression'
                ? funcNode.childForFieldName('property')?.text
                : null;
            if (['call', 'apply', 'bind'].includes(property)) indirectKind = property;
        }
        if (indirectKind === 'bind') {
            return {
                args: null,
                argCount: 0,
                indirectKind,
                uncertainReason: 'Function.bind creates a partial application; final invocation arguments are not known here',
                isMethodCall,
                ...ctx,
            };
        }
        if (indirectKind === 'call') {
            args = args.slice(1);
        } else if (indirectKind === 'apply') {
            const arrayArg = argsNode.namedChild(1);
            if (!arrayArg || arrayArg.type !== 'array') {
                return {
                    args: null,
                    argCount: 0,
                    indirectKind,
                    uncertainReason: 'Function.apply argument list is not a static array literal',
                    isMethodCall,
                    ...ctx,
                };
            }
            args = [];
            for (let i = 0; i < arrayArg.namedChildCount; i++) {
                const argNode = arrayArg.namedChild(i);
                if (argNode.type.includes('comment')) continue;
                args.push(argNode.text.trim());
            }
        }

        return {
            args,
            argCount: args.length,
            hasSpread: args.some(a => a.startsWith('...')) || unpackingArgs > 0,
            ...(unpackingArgs > 0 && { unpackingSpread: true }),
            ...(language === 'python' && { positionalCount: pyPositional, keywordArgNames }),
            hasVariable: args.some(a => /^[a-zA-Z_]\w*$/.test(a)),
            isMethodCall,
            ...(indirectKind && { indirectKind }),
            ...ctx,
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
                const htmlModule = getLanguageAdapter('html');
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

        const callTypes = new Set(['call_expression', 'call', 'method_invocation',
            'invocation_expression', 'object_creation_expression', 'new_expression']);
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
            if (argNode.type.includes('comment')) continue;
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
        awaitedCalls: 0,    // Async calls with await (AST-derived from site.awaited)
        spreadCalls: 0,     // Calls using spread operator
        // Feature A: structural classification counts.
        inLoop: 0,          // Call sites inside a loop construct
        inTry: 0,           // Call sites inside a try block
        inCallback: 0,      // Call sites inside a callback fn passed as an argument
        inTestCase: 0       // Call sites whose enclosing function is a test entry
    };

    for (const site of callSites) {
        const expr = site.expression;

        if (site.hasSpread) patterns.spreadCalls++;
        // Feature B: prefer the AST-derived `awaited` signal (set by
        // analyzeCallSite's classifyCallContext walk). Fall back to a text
        // check on the expression for callers that still pass legacy sites.
        if (site.awaited === true || (site.awaited !== false && /\bawait\s/.test(expr))) {
            patterns.awaitedCalls++;
        }
        if (new RegExp('\\.' + escapeRegExp(funcName) + '\\s*\\(').test(expr)) patterns.chainedCalls++;

        if (site.args && site.args.length > 0) {
            const literalPattern = /^[\d'"{\[]/; // eslint-disable-line no-useless-escape
            const hasLiteral = site.args.some(a =>
                literalPattern.test(a) || a === 'true' || a === 'false' || a === 'null'
            );
            if (hasLiteral) patterns.constantArgs++;
            if (site.hasVariable) patterns.variableArgs++;
        }

        // Feature A counters — these flags are set on each site by
        // analyzeCallSite (inLoop/inTry/inCallback) or by the caller after
        // looking up the enclosing function (inTestCase).
        if (site.inLoop) patterns.inLoop++;
        if (site.inTry) patterns.inTry++;
        if (site.inCallback) patterns.inCallback++;
        if (site.inTestCase) patterns.inTestCase++;
    }

    return patterns;
}

// Decorators that provably keep the declared call interface. Any OTHER
// decorator may reshape the signature (click/celery/functools partials), so
// keyword-binding violations against the declared parameters route to the
// UNCERTAIN band instead of hard mismatches (fix #281 — the #205 "decorators
// reshape signatures" rule applied to verify's claim).
const SIGNATURE_PRESERVING_DECORATORS = new Set([
    'staticmethod', 'classmethod', 'abstractmethod', 'override', 'final',
]);

/**
 * Bind a keyword-argument call against structured parameters (fix #281).
 * Mirrors the interpreter's rules: positional args fill non-keyword-only
 * slots in order, each keyword arg must name a known non-positional-only
 * parameter (unless `**kwargs` absorbs it), and every required parameter
 * must end up bound. Returns problem strings (empty = binds cleanly).
 * Callers gate on the `keywordArguments` trait — languages without named
 * arguments allow short calls, so required-coverage would false-flag.
 */
function bindKeywordCall(params, analysis) {
    const problems = [];
    const isListRest = p => p.rest && /^\*(?!\*)/.test(String(p.name));
    const isDictRest = p => p.rest && /^\*\*/.test(String(p.name));
    const slots = params.filter(p => !p.rest && !p.keywordOnly);
    const hasListRest = params.some(isListRest);
    const hasDictRest = params.some(isDictRest);
    const positional = analysis.positionalCount != null
        ? analysis.positionalCount : analysis.argCount;
    const tooManyPositional = positional > slots.length && !hasListRest;
    if (tooManyPositional) {
        problems.push(`takes ${slots.length} positional argument(s) but ` +
            `${positional} ${positional === 1 ? 'was' : 'were'} given`);
    }
    const bound = new Set(
        slots.slice(0, Math.min(positional, slots.length)).map(p => p.name));
    for (const kw of analysis.keywordArgNames || []) {
        const param = params.find(p => !p.rest && p.name === kw);
        if (!param) {
            if (!hasDictRest) problems.push(`unexpected keyword argument '${kw}'`);
        } else if (param.positionalOnly) {
            // With **kwargs the name is absorbed there — but then the
            // positional-only parameter itself stays unbound (missing check).
            if (!hasDictRest) {
                problems.push(`'${kw}' is positional-only and cannot be passed by keyword`);
            }
        } else if (bound.has(kw)) {
            problems.push(`got multiple values for argument '${kw}'`);
        } else {
            bound.add(kw);
        }
    }
    // Skip required-coverage when positionals already overflowed — the extra
    // positionals were almost certainly aimed at the unbound keyword-only
    // params, and the interpreter reports only the positional error too.
    if (!tooManyPositional) {
        const missing = params
            .filter(p => !p.rest && !p.optional && p.default === undefined && !bound.has(p.name))
            .map(p => `'${p.name}'`);
        if (missing.length > 0) {
            problems.push(`missing required argument(s): ${missing.join(', ')}`);
        }
    }
    return problems;
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
    const { def, warnings } = index.resolveSymbol(name, { file: options.file, className: options.className, line: options.line });
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
    // Class target: arg-check against CONSTRUCTOR parameters (fix #230).
    // Multiple lists = constructor overloads (Java): a call is valid when it
    // fits the combined range; a class with only an inherited constructor
    // (extends, no own ctor) has an arity UCN can't see — accept any count
    // rather than false-flag every call against the implicit 0-arg default.
    const ctorParamLists = _constructorParamLists(index, def, lang);
    const inheritedCtorOnly = !ctorParamLists && def.type === 'class' && !!def.extends;
    const selfParams = langTraits(lang)?.selfParam;
    const stripSelf = (list) => (selfParams && list.length > 0 && list[0] && selfParams.includes(list[0].name))
        ? list.slice(1) : list;
    let callableIdentityParams = null;
    if (!ctorParamLists && ['c', 'cpp'].includes(lang)) {
        const { _closeCallableIdentityGroup } = require('./callers');
        const family = _closeCallableIdentityGroup(
            index, [def], index.symbols.get(name) || [def]);
        callableIdentityParams = family
            .filter(member => Array.isArray(member.paramsStructured))
            .map(member => member.paramsStructured);
    }
    const rawParamLists = ctorParamLists ||
        (callableIdentityParams?.length ? callableIdentityParams : null) ||
        [(arrowTypes?.paramsStructured) || def.paramsStructured || []];
    const params = stripSelf(rawParamLists[0]);
    const arities = rawParamLists.map(l => {
        const list = stripSelf(l);
        const nonRest = list.filter(p => !p.rest);
        const optional = nonRest.filter(p => p.optional || p.default !== undefined).length;
        return { hasRest: list.some(p => p.rest), max: nonRest.length, min: nonRest.length - optional };
    });
    const hasRest = inheritedCtorOnly || arities.some(a => a.hasRest);
    // Rest params don't count toward expected/min — they accept 0+ extra args
    const expectedParamCount = Math.max(...arities.map(a => a.max));
    const minArgs = inheritedCtorOnly ? 0 : Math.min(...arities.map(a => a.min));

    // v4 tiered contract: the confirmed band is arg-checked below; unverified
    // candidates stay VISIBLE in their own band with reasons (never silently
    // dropped). Engine receiver physics replace the pre-v4 className filter
    // and the isMethodCall secondary filter — --include-methods and
    // --include-uncertain are implied no-ops for verify.
    const { confirmed: callerResults, unverified: sweepUnverified, account } =
        contractedCallerSweep(index, name, def);

    // Convert caller results to usage-like objects for analyzeCallSite.
    // Carry callerFile/callerStartLine through so we can compute inTestCase.
    const calls = callerResults.map(c => ({
        file: c.file,
        relativePath: c.relativePath,
        line: c.line,
        content: c.content,
        usageType: 'call',
        receiver: c.receiver,
        // Preserve receiver identity through the usage-shaped adapter. Go
        // permits a local value to have the same spelling as its type; only
        // a type-qualified call is a method expression with an explicit
        // receiver argument.
        receiverType: c.receiverType,
        callerFile: c.callerFile,
        callerStartLine: c.callerStartLine,
    }));

    const valid = [];
    const mismatches = [];
    const uncertain = [];

    const defIsMethod = !!(def.isMethod || def.type === 'method' || def.className);

    // fix #281: keyword-argument binding validation. Applies only where the
    // language binds by name (Python), the target has ONE parameter list
    // (overload groups keep the count-range check), and the arity isn't an
    // inherited-constructor unknown.
    const keywordBindable = langTraits(lang)?.keywordArguments === true &&
        rawParamLists.length === 1 && !inheritedCtorOnly;
    const decoratorReshapes = keywordBindable && Array.isArray(def.decorators) &&
        def.decorators.some(d => {
            const dName = String(d).replace(/^@/, '').split('(')[0].trim();
            return !SIGNATURE_PRESERVING_DECORATORS.has(dName.split('.').pop());
        });

    // Helper: extract pattern flags (Feature A/B) from analyzeCallSite result.
    // Reused so each valid/mismatch/uncertain entry carries the same shape.
    function patternFlagsFrom(a) {
        return {
            inLoop: !!a.inLoop,
            inTry: !!a.inTry,
            inCallback: !!a.inCallback,
            awaited: !!a.awaited,
            // inTestCase filled in below via tagInTestCase
        };
    }

    const verifyLineSeen = new Map(); // 'file:line' -> per-line ordinal (fix #231)
    for (const call of calls) {
        const siteKey = `${call.file}:${call.line}`;
        const occurrence = verifyLineSeen.get(siteKey) || 0;
        verifyLineSeen.set(siteKey, occurrence + 1);
        const analysis = analyzeCallSite(index, call, name, occurrence);

        // Carry callerFile/callerStartLine so tagInTestCase can resolve the
        // enclosing function in a later pass.
        const carry = {
            callerFile: call.callerFile,
            callerStartLine: call.callerStartLine,
        };

        if (analysis.args === null) {
            // Couldn't parse arguments
            uncertain.push({
                file: call.relativePath,
                line: call.line,
                expression: call.content.trim(),
                reason: analysis.uncertainReason || 'Could not parse call arguments',
                patterns: patternFlagsFrom(analysis),
                ...carry,
            });
            continue;
        }

        if (analysis.hasSpread) {
            // Spread args - can't verify count
            uncertain.push({
                file: call.relativePath,
                line: call.line,
                expression: call.content.trim(),
                reason: analysis.unpackingSpread
                    ? 'Uses argument unpacking (*/**) — argument count is not static'
                    : 'Uses spread operator',
                patterns: patternFlagsFrom(analysis),
                ...carry,
            });
            continue;
        }

        let argCount = analysis.argCount;
        // Method-expression / UFCS receiver shift (fix #230): Go
        // `M.Add(*m, 2)` and Rust `Engine::run(&e, 1)` pass the receiver as
        // the FIRST argument — the same +1 shift the #205 arity discipline
        // already applies when confirming these sites. Without it the
        // arg-check false-flagged every confirmed method-expression call.
        const targetTypeName = def.className || (def.receiver || '').replace(/^\*/, '');
        if (targetTypeName && call.receiver === targetTypeName && argCount > 0) {
            const qualStyle = langTraits(lang)?.typeQualifiedCallStyle;
            if ((qualStyle === 'method-expr' && def.receiver &&
                !call.receiverType) ||
                (qualStyle === 'path' && def.isMethod)) {
                argCount -= 1;
            }
        }

        // Check if arg count is valid
        const countOk = hasRest
            ? argCount >= minArgs
            : (argCount >= minArgs && argCount <= expectedParamCount);
        if (!countOk) {
            mismatches.push({
                file: call.relativePath,
                line: call.line,
                expression: call.content.trim(),
                expected: hasRest
                    ? `at least ${minArgs} arg(s)`
                    : (minArgs === expectedParamCount
                        ? `${expectedParamCount} arg(s)`
                        : `${minArgs}-${expectedParamCount} arg(s)`),
                actual: argCount,
                args: analysis.args,
                patterns: patternFlagsFrom(analysis),
                ...carry,
            });
            continue;
        }

        // fix #281: the count fits — for keyword-binding languages, check the
        // NAME-level contract too (keyword-only slots, unknown keyword names,
        // required coverage). A reshaping decorator demotes violations to
        // UNCERTAIN: the declared parameters may not be the call interface.
        const bindingProblems = keywordBindable ? bindKeywordCall(params, analysis) : [];
        if (bindingProblems.length > 0) {
            if (decoratorReshapes) {
                uncertain.push({
                    file: call.relativePath,
                    line: call.line,
                    expression: call.content.trim(),
                    reason: `Against the declared parameters: ${bindingProblems.join('; ')}. ` +
                        'The definition is decorated, and the decorator may reshape the call interface.',
                    patterns: patternFlagsFrom(analysis),
                    ...carry,
                });
            } else {
                mismatches.push({
                    file: call.relativePath,
                    line: call.line,
                    expression: call.content.trim(),
                    expected: hasRest
                        ? `at least ${minArgs} arg(s)`
                        : (minArgs === expectedParamCount
                            ? `${expectedParamCount} arg(s)`
                            : `${minArgs}-${expectedParamCount} arg(s)`),
                    actual: argCount,
                    args: analysis.args,
                    problem: bindingProblems.join('; '),
                    patterns: patternFlagsFrom(analysis),
                    ...carry,
                });
            }
            continue;
        }

        valid.push({
            file: call.relativePath,
            line: call.line,
            patterns: patternFlagsFrom(analysis),
            ...carry,
        });
    }
    clearTreeCache(index);

    // Feature A: tag each entry with `inTestCase` based on its enclosing function.
    // Done after the per-call loop because tagInTestCase prefers a single pass
    // through file metadata to avoid repeated lookups.
    {
        const { tagInTestCase } = require('./analysis');
        // Build a flat list of entries that need tagging — each carries
        // callerFile + callerStartLine + line. tagInTestCase mutates in place.
        const allSites = [...valid, ...mismatches, ...uncertain].map(s => ({
            ...s,
            // Mirror inputs tagInTestCase expects
            line: s.line,
            callerFile: s.callerFile,
            callerStartLine: s.callerStartLine,
        }));
        // Use a parallel array so we can write back patterns.inTestCase.
        tagInTestCase(index, allSites);
        let i = 0;
        for (const s of valid) { s.patterns.inTestCase = !!allSites[i++].inTestCase; }
        for (const s of mismatches) { s.patterns.inTestCase = !!allSites[i++].inTestCase; }
        for (const s of uncertain) { s.patterns.inTestCase = !!allSites[i++].inTestCase; }
    }

    // Strip carry fields — they were internal scaffolding for tagInTestCase
    // and shouldn't appear in the public result.
    function strip(arr) {
        for (const s of arr) {
            delete s.callerFile;
            delete s.callerStartLine;
        }
    }
    strip(valid); strip(mismatches); strip(uncertain);

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

    // Feature A/B: build a top-level patterns aggregate across all call
    // sites verify saw (valid + mismatches + uncertain). Mirrors the shape
    // identifyCallPatterns returns in impact() so consumers can compare.
    const allSitesForAgg = [...valid, ...mismatches, ...uncertain].map(s => ({
        // identifyCallPatterns reads site.expression / site.args / site.hasSpread /
        // site.hasVariable and the boolean pattern flags.
        expression: s.expression || '',
        args: s.args || null,
        hasSpread: false,    // already filtered out into uncertain
        hasVariable: false,  // not propagated from analyzeCallSite here; harmless
        awaited: !!(s.patterns && s.patterns.awaited),
        inLoop: !!(s.patterns && s.patterns.inLoop),
        inTry: !!(s.patterns && s.patterns.inTry),
        inCallback: !!(s.patterns && s.patterns.inCallback),
        inTestCase: !!(s.patterns && s.patterns.inTestCase),
    }));
    const patternsAgg = identifyCallPatterns(allSitesForAgg, name);

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
            hasDefault: p.default !== undefined,
            // fix #281: binding-position markers (Python `*` / `/`)
            ...(p.keywordOnly && { keywordOnly: true }),
            ...(p.positionalOnly && { positionalOnly: true }),
        })),
        // max: null = unbounded (rest param) — typed for JSON consumers;
        // the text formatter renders it as `${min}+` (fix #230, was the
        // string '∞' leaking into JSON output).
        expectedArgs: { min: minArgs, max: hasRest ? null : expectedParamCount },
        totalCalls: valid.length + mismatches.length + uncertain.length,
        valid: valid.length,
        mismatches: mismatches.length,
        uncertain: uncertain.length,
        validDetails: valid,
        mismatchDetails: mismatches,
        uncertainDetails: uncertain,
        // v4 tiered contract: candidates without binding/receiver evidence are
        // NOT arg-checked (they may target another symbol) but stay visible.
        unverifiedCount: sweepUnverified.length,
        unverifiedSites: sweepUnverified.map(unverifiedSiteShape),
        account,
        patterns: patternsAgg,
        scopeWarning,
        ...(warnings.length > 0 && { warnings }),
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
// Strict reserved words per language — names that can never be identifiers.
// Contextual/soft keywords (TS `interface`, Python `match`, C# `var`) are
// deliberately absent: they are legal identifiers, and over-blocking a rename
// is worse than trusting the compiler for the soft cases. Fail-open for
// languages without an entry.
const JS_RESERVED = new Set(('break case catch class const continue debugger default delete do else enum export ' +
    'extends false finally for function if import in instanceof new null return super switch this throw true try ' +
    'typeof var void while with yield let static await').split(' '));
const C_RESERVED = new Set(('auto break case char const continue default do double else enum extern float for goto ' +
    'if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned ' +
    'void volatile while _Bool').split(' '));
const RESERVED_WORDS_BY_LANGUAGE = {
    javascript: JS_RESERVED,
    typescript: JS_RESERVED,
    tsx: JS_RESERVED,
    python: new Set(('False None True and as assert async await break class continue def del elif else except ' +
        'finally for from global if import in is lambda nonlocal not or pass raise return try while with yield').split(' ')),
    go: new Set(('break case chan const continue default defer else fallthrough for func go goto if import ' +
        'interface map package range return select struct switch type var').split(' ')),
    rust: new Set(('as async await break const continue crate dyn else enum extern false fn for if impl in let ' +
        'loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where ' +
        'while').split(' ')),
    java: new Set(('abstract assert boolean break byte case catch char class const continue default do double ' +
        'else enum extends final finally float for goto if implements import instanceof int interface long native ' +
        'new package private protected public return short static strictfp super switch synchronized this throw ' +
        'throws transient try void volatile while true false null').split(' ')),
    c: C_RESERVED,
    cpp: new Set([...C_RESERVED, ...('bool catch class constexpr delete explicit false friend mutable namespace ' +
        'new noexcept nullptr operator private protected public template this throw true try typename using ' +
        'virtual wchar_t').split(' ')]),
    csharp: new Set(('abstract as base bool break byte case catch char checked class const continue decimal ' +
        'default delegate do double else enum event explicit extern false finally fixed float for foreach goto if ' +
        'implicit in int interface internal is lock long namespace new null object operator out override params ' +
        'private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct ' +
        'switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile ' +
        'while').split(' ')),
};

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
    // Class target: the signature being planned is the CONSTRUCTOR's
    // (fix #230, same rule as verify) — single-ctor classes only; with
    // overloads the class def's own (empty) list stays, since plan cannot
    // know which overload the user means.
    const planLang = index.files.get(def.file)?.language;
    const planCtorLists = _constructorParamLists(index, def, planLang);
    const currentParams = (planCtorLists && planCtorLists.length === 1 && planCtorLists[0]) ||
        (arrowTypes?.paramsStructured) || def.paramsStructured || [];
    // BUG-BV: render with TS-correct param formatting (`opt?: number`).
    const currentSignature = formatTypedSignature(def,
        (planCtorLists && planCtorLists.length === 1)
            ? { paramsStructured: currentParams }
            : arrowTypes ? {
                paramsStructured: arrowTypes.paramsStructured,
                returnType: arrowTypes.returnType
            } : {});

    // BUG-BW: plan must discover call sites the same way verify does — both
    // run contractedCallerSweep (v4 tiered contract), so plan and verify stay
    // in lock-step by construction. Unverified candidates are NOT planned
    // (they may target another symbol) but stay visible with reasons.
    const { sites: planCallSites, unverifiedSites: planUnverified, account: planAccount } =
        computePlanCallSites(index, name, def);
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

    // Rename-target sanity: a same-name rename is a 0-change request, and a
    // reserved word in the target's language would write syntax errors into
    // the declaration and every call site. (Identifier SHAPE is validated at
    // the execute layer; keywords need the resolved symbol's language.)
    if (options.renameTo) {
        if (options.renameTo === def.name || options.renameTo === name) {
            return {
                found: true,
                function: name,
                error: `renameTo "${options.renameTo}" matches the current name — nothing to rename.`,
            };
        }
        const reserved = RESERVED_WORDS_BY_LANGUAGE[planLang === 'html' ? 'javascript' : planLang];
        if (reserved && reserved.has(options.renameTo)) {
            return {
                found: true,
                function: name,
                error: `renameTo "${options.renameTo}" is a reserved word in ${planLang === 'html' ? 'javascript' : planLang} and cannot be used as an identifier.`,
            };
        }
    }

    let newParams = [...currentParams];
    let newSignature = currentSignature;
    let operation = null;
    let changes = [];
    let unchangedSites = 0;

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
        // Default parameter values only exist in some languages (trait).
        // For Go/Java/Rust a --default value is a suggested ARGUMENT for the
        // call sites, never signature syntax — `opt = null` is not valid Go.
        const planFileEntry = index.files.get(def.file);
        const langHasDefaults = langTraits(planFileEntry?.language)?.hasDefaultParams !== false;
        const newParam = {
            name: options.addParam,
            ...(options.defaultValue && langHasDefaults && { default: options.defaultValue })
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
        // BUG-5: preserve all modifier tokens (async/static/public/...).
        const paramsList = newParams.map(formatTypedParam).filter(Boolean).join(', ');
        const modTokens = computeModifierTokens(def);
        const modPrefix = modTokens.length ? modTokens.join(' ') + ' ' : '';
        newSignature = `${modPrefix}${name}(${paramsList})`;
        const newRet = arrowTypes?.returnType || def.returnType;
        if (newRet) newSignature += `: ${newRet}`;

        // Describe changes needed at each call site. Without language support
        // for default values, every call site must pass the new argument.
        for (const site of planCallSites) {
            let suggestion;
            if (options.defaultValue && langHasDefaults) {
                // The default makes the existing call valid. Keep the fact in
                // metadata, but do not inflate the concrete edit plan with a
                // no-op entry (UCN5-166).
                unchangedSites++;
                continue;
            } else if (options.defaultValue) {
                suggestion = `Add argument: ${options.defaultValue} (no default parameter values in ${planFileEntry?.language || 'this language'})`;
            } else {
                suggestion = `Add argument: ${options.addParam}`;
            }
            changes.push({
                file: site.file,
                line: site.line,
                expression: site.expression,
                suggestion,
                args: site.args,
                editKind: 'call',
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
        // BUG-5: preserve all modifier tokens (async/static/public/...).
        const paramsList = newParams.map(formatTypedParam).filter(Boolean).join(', ');
        const modTokens = computeModifierTokens(def);
        const modPrefix = modTokens.length ? modTokens.join(' ') + ' ' : '';
        newSignature = `${modPrefix}${name}(${paramsList})`;
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

        // Removing the receiver param itself (self/cls/&self): bound calls
        // pass it implicitly — no caller-side change exists (fix #230; used
        // to emit "Remove argument 0: ?" at every site).
        if (callerArgIndex >= 0) {
            // Describe changes at each call site
            for (const site of planCallSites) {
                if (site.args && site.argCount > callerArgIndex) {
                    changes.push({
                        file: site.file,
                        line: site.line,
                        expression: site.expression,
                        suggestion: `Remove argument ${callerArgIndex + 1}: ${site.args[callerArgIndex] || '?'}`,
                        args: site.args,
                        editKind: 'call',
                    });
                } else if (!site.args) {
                    // Arguments unparseable (macro bodies, generated code) —
                    // surface for manual review instead of dropping silently
                    // (fix #230).
                    changes.push({
                        file: site.file,
                        line: site.line,
                        expression: site.expression,
                        suggestion: 'Could not parse arguments — review this call site manually',
                        needsReview: true,
                        editKind: 'call',
                    });
                }
            }
        }
    }

    if (options.renameTo) {
        operation = 'rename';
        newSignature = currentSignature.replace(new RegExp('\\b' + escapeRegExp(name) + '\\b'), options.renameTo);

        // All call sites need renaming. Global replace: a line with several
        // calls (`compute(compute(1))`) renames every occurrence, and the
        // line appears ONCE however many call records it holds (fix #230 —
        // the non-global regex left the inner call behind and emitted a
        // duplicate entry per record).
        const emitRenameCallSites = (siteList) => {
        const callLines = new Map();
        for (const site of siteList) {
            const lineKey = `${site.file}:${site.line}`;
            const group = callLines.get(lineKey) || {
                file: site.file,
                absoluteFile: site.absoluteFile,
                line: site.line,
                expression: site.expression,
                columns: [],
                missingColumn: false,
                callCount: 0,
                calledAs: site.calledAs,
            };
            if (group.calledAs !== site.calledAs) group.calledAs = null;
            group.callCount++;
            if (Number.isInteger(site.column)) group.columns.push(site.column);
            else group.missingColumn = true;
            callLines.set(lineKey, group);
        }
        for (const site of callLines.values()) {
            // A renamed import preserves its local alias (`old as local` /
            // `{ old: local }`). The caller engine carries the authored name
            // in calledAs; that token must remain unchanged while the import's
            // source-side identifier is edited below.
            if (site.calledAs && site.calledAs !== name) continue;
            let edit = renameIdentifierTokens(index,
                site.absoluteFile || site.file, site.line, name,
                options.renameTo, site.missingColumn ? [] : site.columns,
                site.callCount);
            // Column-less records restrict token eligibility to
            // call-expression targets — which finds nothing for confirmed
            // function-REFERENCE sites (`handler = serveWs`, macro-interior
            // calls whose records carry no column). Retry in all-identifier
            // mode: still AST tokens only, still refused unless the row's
            // token count equals the engine's record count, so a line mixing
            // the target with an unrelated same-name token stays manual.
            if (edit.renamed === edit.source && site.missingColumn) {
                edit = renameIdentifierTokens(index,
                    site.absoluteFile || site.file, site.line, name,
                    options.renameTo, null, site.callCount);
            }
            const newExpression = edit.renamed;
            // A confirmed call through an import alias (`xf()`) is a real
            // caller but the alias spelling does not change. The required
            // edit is the import's source-side name; never emit a byte-for-
            // byte no-op that makes the plan look complete.
            if (newExpression === edit.source) {
                // Missing parser columns mean UCN can prove the edit is
                // required but cannot safely synthesize it. Never fall back
                // to whole-line regex replacement.
                if (site.missingColumn) {
                    changes.push({
                        file: site.file,
                        line: site.line,
                        expression: edit.source,
                        suggestion: `Rename call identifier "${name}" to "${options.renameTo}" manually`,
                        needsReview: true,
                        editKind: 'call',
                    });
                }
                continue;
            }
            changes.push({
                file: site.file,
                line: site.line,
                expression: edit.source,
                suggestion: `Rename to: ${newExpression}`,
                newExpression,
                editKind: 'call',
            });
        }
        };
        emitRenameCallSites(planCallSites);

        // Also include import statements that reference the renamed function.
        // Name ownership (fix #230, the #217 rule): an import of the same
        // NAME from an unrelated module is not this rename's import —
        // renaming alpha.compute must not rewrite `from beta import compute`
        // (the plan's own call-site sweep already excludes caller_b's calls
        // as other-definition-import; the import pass has to agree).
        // 'no' (the binding provably resolves elsewhere) skips; 'unknown'
        // (CJS surfaces, star imports, resolver gaps) keeps the import —
        // a missed import breaks the rename just as surely.
        const { _nameBindingReaches } = require('./callers');
        const renameTargetFiles = new Set([def.file]);
        const usages = index.usages(name, { codeOnly: true });
        const importUsages = usages.filter(u => u.usageType === 'import' && !u.isDefinition);
        for (const imp of importUsages) {
            // Skip if already covered by a call site change in the same file:line
            const alreadyCovered = changes.some(c =>
                c.file === (imp.relativePath || imp.file) && c.line === imp.line
            );
            if (alreadyCovered) continue;
            if (imp.file && def.file &&
                _nameBindingReaches(index, imp.file, name, renameTargetFiles) === 'no') {
                continue;
            }
            const edit = renameIdentifierTokens(index, imp.file,
                imp.line, name, options.renameTo);
            const newImport = edit.renamed;
            if (newImport === edit.source) continue;
            changes.push({
                file: imp.relativePath || imp.file,
                line: imp.line,
                expression: edit.source,
                suggestion: `Update import: ${newImport}`,
                newExpression: newImport,
                isImport: true,
                editKind: 'import',
            });
        }

        // Renamed CJS/Python imports are intentionally surfaced as reference
        // usages by their parsers, so usageType alone cannot find the import
        // line. importBindings retains the original/local pair and line.
        for (const [filePath, fileEntry] of index.files) {
            for (const binding of fileEntry.importBindings || []) {
                const localAlias = binding.alias || (fileEntry.importAliases || [])
                    .find(alias => alias.original === binding.name)?.local;
                if (binding.name !== name || !localAlias ||
                    localAlias === name || !binding.line) continue;
                if (_nameBindingReaches(index, filePath, name,
                    renameTargetFiles) === 'no') continue;
                const rel = fileEntry.relativePath || filePath;
                if (changes.some(change =>
                    change.file === rel && change.line === binding.line)) continue;
                const edit = renameIdentifierTokens(index, filePath,
                    binding.line, name, options.renameTo);
                const sourceLine = edit.source;
                const newImport = edit.renamed;
                if (newImport === sourceLine) continue;
                changes.push({
                    file: rel,
                    line: binding.line,
                    expression: sourceLine,
                    suggestion: `Update import: ${newImport}`,
                    newExpression: newImport,
                    isImport: true,
                    editKind: 'import',
                });
            }
        }

        // Export surfaces owned by the selected definition are declaration
        // references too. In particular, CommonJS shorthand
        // `module.exports = { helper }` must be renamed or the otherwise
        // complete caller/import edit set breaks the module API.
        for (const [exportPath, targetEntry] of index.files) {
            for (const exported of targetEntry.exportDetails || []) {
                if ((exported.name !== name && exported.alias !== name) ||
                    !exported.line) continue;
                const ownership = _nameBindingReaches(
                    index, exportPath, name, renameTargetFiles, 8);
                // Transitive file reachability is not name ownership. A file
                // can import the target somewhere in its dependency closure
                // while exporting its own same-spelled local declaration.
                // Edit the target's own export, or a positively-resolved
                // re-export chain; unknown CJS/dynamic surfaces are unsafe to
                // rewrite mechanically.
                if (exportPath !== def.file && ownership !== 'yes') continue;
                const exportFile = targetEntry.relativePath || exportPath;
                if (changes.some(change =>
                    change.file === exportFile && change.line === exported.line)) {
                    continue;
                }
                const edit = renameIdentifierTokens(index, exportPath,
                    exported.line, name, options.renameTo);
                const sourceLine = edit.source;
                const occurrences = edit.count;
                const newExpression = edit.renamed;
                if (newExpression === sourceLine) continue;
                changes.push({
                    file: exportFile,
                    line: exported.line,
                    expression: sourceLine,
                    suggestion: `Update export: ${newExpression}`,
                    newExpression,
                    isExport: true,
                    editKind: 'export',
                    ...(occurrences > 1 && { needsReview: true }),
                });
            }
        }

        // Overload signatures and their implementation are ONE callable
        // (fix #265A, def side): renaming any member must rename the whole
        // group, or the survivors keep the old name and the compiler rejects
        // the group (TS 2394 / pyright reportInconsistentOverload). Same
        // closure the caller engine uses (isSignature-gated, so Java arity
        // overloads — separate bindable methods — never close).
        {
            const { _closeCallableIdentityGroup } = require('./callers');
            const identityGroup = _closeCallableIdentityGroup(
                index, [def], definitions);
            for (const member of identityGroup) {
                if (member === def) continue;
                const line = member.nameLine || member.startLine;
                const rel = member.relativePath || member.file;
                if (changes.some(change =>
                    change.file === rel && change.line === line)) continue;
                const edit = renameIdentifierTokens(index, member.file,
                    line, name, options.renameTo);
                if (edit.renamed === edit.source) continue;
                changes.push({
                    file: rel,
                    line,
                    expression: edit.source,
                    suggestion: `Update overload signature: ${edit.renamed}`,
                    newExpression: edit.renamed,
                    isDefinition: true,
                    editKind: 'definition',
                });
            }
        }

        // Renaming a virtual/overridden member is one hierarchy-wide change.
        // Leaving descendant declarations behind either fails compilation
        // (Java/C#/TS override) or silently changes dispatch (Python/JS).
        if (def.className) {
            // Inheritance identity is (class name, defining file), not just
            // the spelling. Repositories routinely contain two Handler/Base
            // classes in unrelated packages. Follow only children whose base
            // resolves from the child's scope to this exact parent file.
            const identityKey = (className, file) => `${file || ''}\0${className}`;

            // The pinned member may itself be an override: the dispatch slot
            // is rooted at the TOPMOST project ancestor defining the name
            // (flask PassList.check → JSONTag.check → every sibling
            // override; outcome-eval 2026-08-18). Climb the extends chain
            // with the same identity discipline, emit each ancestor definer,
            // then walk DOWN from the root so sibling overrides join too.
            // Arity-overload languages require the ancestor's signature to
            // be the same virtual slot (a same-name different-arity Java
            // method is a sibling, never the root).
            let slotRoot = { name: def.className, file: def.file };
            const slotAncestors = [];
            const climbed = new Set([identityKey(slotRoot.name, slotRoot.file)]);
            for (let hop = 0; hop < 8; hop++) {
                const parents = index._getInheritanceParents(
                    slotRoot.name, slotRoot.file) || [];
                let moved = false;
                for (const parentName of parents) {
                    const parentFile = index._resolveClassFile(parentName, slotRoot.file);
                    if (!parentFile) continue;
                    const parentDef = (index.symbols.get(name) || []).find(symbol =>
                        symbol.className === parentName && symbol.file === parentFile &&
                        !NON_CALLABLE_TYPES.has(symbol.type));
                    if (!parentDef) continue;
                    if (langTraits(planLang)?.hasArityOverloads &&
                        (parentDef.paramsStructured || []).length !==
                        (def.paramsStructured || []).length) continue;
                    const key = identityKey(parentName, parentFile);
                    if (climbed.has(key)) break;
                    climbed.add(key);
                    slotRoot = { name: parentName, file: parentFile };
                    slotAncestors.push({ className: parentName, file: parentFile, def: parentDef });
                    moved = true;
                    break;
                }
                if (!moved) break;
            }
            const slotMemberDefs = [];
            for (const ancestor of slotAncestors) {
                slotMemberDefs.push(ancestor.def);
                const line = ancestor.def.nameLine || ancestor.def.startLine;
                const rel = ancestor.def.relativePath || ancestor.def.file;
                if (changes.some(change =>
                    change.file === rel && change.line === line)) continue;
                const edit = renameIdentifierTokens(index, ancestor.def.file,
                    line, name, options.renameTo);
                if (edit.renamed === edit.source) continue;
                changes.push({
                    file: rel,
                    line,
                    expression: edit.source,
                    suggestion: `Update base definition: ${edit.renamed}`,
                    newExpression: edit.renamed,
                    isDefinition: true,
                    editKind: 'definition',
                });
            }

            const descendants = new Map();
            const queue = [{ name: slotRoot.name, file: slotRoot.file }];
            const visited = new Set([identityKey(slotRoot.name, slotRoot.file)]);
            while (queue.length > 0 && descendants.size < 5000) {
                const parent = queue.shift();
                for (const child of index.extendedByGraph.get(parent.name) || []) {
                    const childName = typeof child === 'string' ? child : child.name;
                    const childFile = typeof child === 'string'
                        ? index._resolveClassFile(childName, parent.file)
                        : child.file;
                    if (!childName || !childFile) continue;
                    const parentFile = index._resolveClassFile(parent.name, childFile);
                    if (parentFile !== parent.file) continue;
                    const key = identityKey(childName, childFile);
                    if (visited.has(key)) continue;
                    visited.add(key);
                    descendants.set(key, { name: childName, file: childFile });
                    queue.push({ name: childName, file: childFile });
                }
            }
            for (const override of index.symbols.get(name) || []) {
                if (!override.className ||
                    !descendants.has(identityKey(override.className, override.file))) continue;
                // Slot-rooting can put the pin's OWN class in the descendant
                // set. The pin handles itself; same-class siblings (Java
                // arity overloads, TS/Python signature stubs) belong to the
                // identity-group pass, never the hierarchy walk.
                if (override.className === def.className &&
                    override.file === def.file &&
                    override.startLine !== def.startLine) continue;
                const line = override.nameLine || override.startLine;
                const rel = override.relativePath || override.file;
                if (changes.some(change => change.file === rel && change.line === line)) continue;
                const edit = renameIdentifierTokens(index, override.file,
                    line, name, options.renameTo);
                const sourceLine = edit.source;
                const newExpression = edit.renamed;
                if (newExpression === sourceLine) continue;
                changes.push({
                    file: rel,
                    line,
                    expression: sourceLine,
                    suggestion: `Update overriding definition: ${newExpression}`,
                    newExpression,
                    isDefinition: true,
                    editKind: 'definition',
                });
                slotMemberDefs.push(override);
            }

            // Rust trait slots (fix #296, serde-as_cast-measured): trait
            // impls carry `traitName` markers, not extends edges — the climb
            // and descendant walk above cannot see them, so renaming a trait
            // method left every impl (and the trait declaration, under an
            // impl pin) behind. Close the slot over the trait's own
            // declaration member and every indexed impl member implementing
            // it, with file-identity discipline (two crates may define
            // same-named traits — a member joins only when its trait
            // resolves to the pin's trait FILE).
            const slotTraitNames = new Set();
            let pinTraitFile = null;
            if (def.traitName) {
                slotTraitNames.add(def.traitName);
                pinTraitFile = index._resolveClassFile(def.traitName, def.file) || null;
            } else if ((index.symbols.get(def.className) || []).some(d =>
                d.type === 'trait' && d.file === def.file)) {
                slotTraitNames.add(def.className);
                pinTraitFile = def.file;
            }
            if (slotTraitNames.size > 0 && pinTraitFile) {
                const traitName = [...slotTraitNames][0];
                for (const member of index.symbols.get(name) || []) {
                    if (member.file === def.file && member.startLine === def.startLine) continue;
                    if (NON_CALLABLE_TYPES.has(member.type)) continue;
                    let inSlot = false;
                    if (member.traitName === traitName) {
                        inSlot = index._resolveClassFile(traitName, member.file) === pinTraitFile;
                    } else if (member.className === traitName && member.file === pinTraitFile &&
                        (index.symbols.get(traitName) || []).some(d =>
                            d.type === 'trait' && d.file === member.file)) {
                        inSlot = true; // the trait's own declaration member
                    }
                    if (!inSlot) continue;
                    const line = member.nameLine || member.startLine;
                    const rel = member.relativePath || member.file;
                    if (!changes.some(change => change.file === rel && change.line === line)) {
                        const edit = renameIdentifierTokens(index, member.file,
                            line, name, options.renameTo);
                        if (edit.renamed !== edit.source) {
                            changes.push({
                                file: rel,
                                line,
                                expression: edit.source,
                                suggestion: `Update trait-slot definition: ${edit.renamed}`,
                                newExpression: edit.renamed,
                                isDefinition: true,
                                editKind: 'definition',
                            });
                        }
                    }
                    slotMemberDefs.push(member);
                }
                // Macro-generated impls are invisible to the index (the
                // as_cast_impl! family: the `fn` lives in a macro_rules body,
                // no impl_item node exists). A definition-shaped ground line
                // no indexed def claims, sitting inside a macro_rules body
                // whose token tree names `impl … <Trait>`, implements the
                // renamed slot — compiler-connected via the impl header, so
                // the edit is synthesized mechanically.
                const { computeGroundSet } = require('./account');
                const macroGround = computeGroundSet(index, name);
                const fnRe = new RegExp(`\\bfn\\s+${escapeRegExp(name)}\\b`);
                const implRe = new RegExp(
                    `\\bimpl\\b[^;{}]{0,160}\\b${escapeRegExp(traitName)}\\b`);
                for (const [macroFile, lineNos] of macroGround.perFile) {
                    const macroEntry = index.files.get(macroFile);
                    if (!macroEntry || macroEntry.language !== 'rust') continue;
                    const claimed = new Set((index.symbols.get(name) || [])
                        .filter(d => d.file === macroFile)
                        .map(d => d.nameLine || d.startLine));
                    let macroTree = null;
                    let macroNodes = null;
                    for (const lineNo of lineNos) {
                        if (claimed.has(lineNo)) continue;
                        const rel = macroEntry.relativePath || macroFile;
                        if (changes.some(change =>
                            change.file === rel && change.line === lineNo)) continue;
                        const content = index._readFile(macroFile);
                        if (!fnRe.test(content.split('\n')[lineNo - 1] || '')) continue;
                        if (macroTree === null) {
                            const parser = getParser('rust');
                            macroTree = (parser &&
                                (index._getParsedTree?.(macroFile, content, 'rust') ||
                                    safeParse(parser, content))) || false;
                            macroNodes = [];
                            if (macroTree) {
                                const stack = [macroTree.rootNode];
                                while (stack.length > 0) {
                                    const node = stack.pop();
                                    if (node.type === 'macro_definition') {
                                        macroNodes.push(node);
                                        continue;
                                    }
                                    for (let i = 0; i < node.namedChildCount; i++) {
                                        stack.push(node.namedChild(i));
                                    }
                                }
                            }
                        }
                        if (!macroTree || !macroNodes) continue;
                        const mac = macroNodes.find(m =>
                            m.startPosition.row + 1 <= lineNo &&
                            m.endPosition.row + 1 >= lineNo);
                        if (!mac || !implRe.test(mac.text)) continue;
                        const edit = renameIdentifierTokens(index, macroFile,
                            lineNo, name, options.renameTo);
                        if (edit.renamed === edit.source) continue;
                        changes.push({
                            file: rel,
                            line: lineNo,
                            expression: edit.source,
                            suggestion: `Update macro-generated trait implementation: ${edit.renamed}`,
                            newExpression: edit.renamed,
                            isDefinition: true,
                            editKind: 'definition',
                        });
                    }
                }
            }

            // A slot rename must also carry every member's CALL sites — the
            // pin's sweep answers for the pin only (a TagDict-typed caller
            // of TagDict.check is a confirmed caller of the SLOT being
            // renamed, absent from PassList.check's answer). Union the
            // members' sweeps; their unverified candidates join the visible
            // band with slot attribution. Bounded — a pathological slot
            // discloses the cut instead of sweeping forever.
            const SLOT_SWEEP_CAP = 25;
            const seenSiteLines = new Set([
                ...planCallSites.map(site => `${site.file}:${site.line}`),
                ...changes.map(change => `${change.file}:${change.line}`),
            ]);
            const slotMemberSites = [];
            for (const memberDef of slotMemberDefs.slice(0, SLOT_SWEEP_CAP)) {
                const memberSweep = computePlanCallSites(index, name, memberDef);
                for (const site of memberSweep.sites) {
                    const key = `${site.file}:${site.line}`;
                    if (seenSiteLines.has(key)) continue;
                    seenSiteLines.add(key);
                    slotMemberSites.push(site);
                }
                for (const site of memberSweep.unverifiedSites) {
                    if (planUnverified.some(existing =>
                        existing.file === site.file &&
                        existing.line === site.line)) continue;
                    if (seenSiteLines.has(`${site.file}:${site.line}`)) continue;
                    planUnverified.push({
                        ...site,
                        slotMember: memberDef.className,
                    });
                }
            }
            if (slotMemberDefs.length > SLOT_SWEEP_CAP) {
                resolved.warnings.push({
                    message: `Dispatch slot has ${slotMemberDefs.length} member ` +
                        `definitions; call sites were swept for the first ` +
                        `${SLOT_SWEEP_CAP} — review the rest manually.`,
                });
            }
            emitRenameCallSites(slotMemberSites);
            // A site a slot member's sweep CONFIRMED is a planned edit now —
            // it no longer belongs in the pin's "may need this change" band.
            const changedLines = new Set(changes.map(change =>
                `${change.file}:${change.line}`));
            const keptUnverified = planUnverified.filter(site =>
                !changedLines.has(`${site.file}:${site.line}`));
            planUnverified.length = 0;
            planUnverified.push(...keptUnverified);
            planUnverified.sort((a, b) => codeUnitCompare(a.file, b.file) ||
                a.line - b.line);
        }

        // C/C++ declarations and definitions are one compiler symbol. A
        // selected implementation must carry its matching header prototype,
        // and selecting the prototype must carry the implementation.
        if (planLang === 'c' || planLang === 'cpp') {
            const ownerOf = symbol => symbol.className ||
                (symbol.receiver || '').replace(/^\*/, '') || null;
            const signatureOf = symbol => (symbol.paramsStructured || []).map(param =>
                String(param.type || param.name || '').replace(/\s+/g, '')).join(',');
            const linked = candidate => candidate.file === def.file ||
                index.importGraph.get(def.file)?.has(candidate.file) ||
                index.importGraph.get(candidate.file)?.has(def.file);
            for (const sibling of index.symbols.get(name) || []) {
                if (sibling === def || ownerOf(sibling) !== ownerOf(def) ||
                    signatureOf(sibling) !== signatureOf(def) ||
                    !(sibling.isSignature || def.isSignature) || !linked(sibling)) continue;
                const siblingLang = index.files.get(sibling.file)?.language;
                if (siblingLang !== planLang &&
                    !new Set(['c', 'cpp']).has(siblingLang)) continue;
                const line = sibling.nameLine || sibling.startLine;
                const rel = sibling.relativePath || sibling.file;
                if (changes.some(change => change.file === rel && change.line === line)) continue;
                const edit = renameIdentifierTokens(index, sibling.file,
                    line, name, options.renameTo);
                if (edit.renamed === edit.source) continue;
                changes.push({
                    file: rel,
                    line,
                    expression: edit.source,
                    suggestion: `Update paired declaration: ${edit.renamed}`,
                    newExpression: edit.renamed,
                    isDefinition: true,
                    editKind: 'definition',
                });
            }
        }

        // Reference-position usages are rename edits too (outcome-eval
        // flask, 2026-08-18): `return decorator`, `callback=handler`,
        // `cls.method` values. Call syntax flows through the tiered sweep;
        // references never did — a plan-following rename left them on the
        // old name and the toolchain rejected the result. Evidence
        // discipline mirrors the caller engine:
        //   - same-file, non-method pin: nearest-binder containment — the
        //     innermost same-name def whose scope container holds the line
        //     must be the pin (a sibling nested `decorator` keeps its own
        //     references; ties bind nothing);
        //   - same-file, method pin: self/cls/this-received inside the
        //     pin's class range (receiver evidence read from the line);
        //   - cross-file, non-method pin: the #217 import-ownership chase —
        //     'yes' edits, 'unknown' surfaces needsReview (no synthesized
        //     edit), 'no' skips;
        //   - cross-file method references are receiver-blind here:
        //     call-shaped sites already flow through the sweep and the
        //     unverified band.
        // Shadow discipline (the #215/#203 concern — text rows carry no
        // localShadow flag): a module-scope pin auto-edits only rows that
        // sit at MODULE scope themselves (`TABLE = {"h": helper}`,
        // `module.exports = { helper }`, decorator argument lists). A row
        // inside some function body may reference a shadowing local
        // (`const job = job2`), and argument-position references inside
        // functions are the parser's #221 records — the sweep's domain —
        // so those rows surface needsReview instead of a synthesized edit.
        // A NESTED pin's own container is exempt: inside it the pin IS the
        // binder (`return decorator`).
        {
            const fileSymbols = index.files.get(def.file)?.symbols || [];
            const scopeKinds = new Set(['function', 'method', 'constructor',
                'private', 'get', 'set', 'property', 'classmethod', 'special']);
            const rangeOf = symbol => ({
                start: symbol.startLine,
                end: symbol.endLine || symbol.startLine,
            });
            const containerOf = (symbol) => {
                const target = rangeOf(symbol);
                let best = null;
                for (const candidate of fileSymbols) {
                    if (candidate === symbol || !scopeKinds.has(candidate.type)) continue;
                    const range = rangeOf(candidate);
                    if (!(range.start <= target.start && range.end >= target.end)) continue;
                    if (range.start === target.start && range.end === target.end) continue;
                    if (!best || (range.end - range.start) < (best.end - best.start)) {
                        best = range;
                    }
                }
                return best; // null = module scope
            };
            const binders = definitions
                .filter(candidate => candidate.file === def.file &&
                    !NON_CALLABLE_TYPES.has(candidate.type))
                .map(candidate => ({ def: candidate, container: containerOf(candidate) }));
            const classKinds = new Set(['class', 'struct', 'interface', 'trait',
                'record', 'enum', 'namespace']);
            const pinClassRange = def.className
                ? fileSymbols.find(symbol => symbol.name === def.className &&
                    classKinds.has(symbol.type) &&
                    symbol.startLine <= def.startLine &&
                    (symbol.endLine || symbol.startLine) >= (def.endLine || def.startLine))
                : null;
            const selfReceived = new RegExp(
                `(?:^|[^A-Za-z0-9_$.])(?:self|cls|this)\\s*\\.\\s*` +
                `${escapeRegExp(name)}(?![A-Za-z0-9_$])`);
            const unverifiedLines = new Set(planUnverified.map(site =>
                `${site.file}:${site.line}`));
            const insideFunctionLike = (filePath, line) => {
                const symbols = index.files.get(filePath)?.symbols || [];
                return symbols.some(symbol => scopeKinds.has(symbol.type) &&
                    symbol.startLine <= line &&
                    (symbol.endLine || symbol.startLine) >= line);
            };
            const pinContainer = containerOf(def);
            for (const ref of usages) {
                if (ref.usageType !== 'reference' || ref.isDefinition) continue;
                const rel = ref.relativePath || ref.file;
                if (changes.some(change =>
                    change.file === rel && change.line === ref.line)) continue;
                if (unverifiedLines.has(`${rel}:${ref.line}`)) continue;
                let verdict = null;
                if (ref.file === def.file) {
                    if (def.className) {
                        const lineText = ref.content ||
                            index.getLineContent(def.file, ref.line) || '';
                        if (pinClassRange && ref.line >= pinClassRange.startLine &&
                            ref.line <= (pinClassRange.endLine || Infinity) &&
                            selfReceived.test(lineText)) {
                            verdict = 'edit';
                        }
                    } else {
                        let winner = null;
                        let ambiguous = false;
                        for (const binder of binders) {
                            const contains = !binder.container ||
                                (binder.container.start <= ref.line &&
                                    binder.container.end >= ref.line);
                            if (!contains) continue;
                            const size = binder.container
                                ? binder.container.end - binder.container.start
                                : Infinity;
                            if (!winner || size < winner.size) {
                                winner = { def: binder.def, size };
                                ambiguous = false;
                            } else if (size === winner.size &&
                                binder.def !== winner.def) {
                                ambiguous = true;
                            }
                        }
                        if (winner && !ambiguous && winner.def === def) {
                            if (pinContainer) {
                                verdict = 'edit'; // nested pin binds its container
                            } else if (!insideFunctionLike(def.file, ref.line)) {
                                verdict = 'edit'; // module-scope row, module pin
                            } else {
                                verdict = 'review'; // possible local shadow
                            }
                        }
                    }
                } else if (!def.className) {
                    const ownership = _nameBindingReaches(
                        index, ref.file, name, renameTargetFiles);
                    if (ownership === 'yes' &&
                        !insideFunctionLike(ref.file, ref.line)) {
                        verdict = 'edit';
                    } else if (ownership !== 'no') {
                        verdict = 'review';
                    }
                }
                if (!verdict) continue;
                if (verdict === 'edit') {
                    const edit = renameIdentifierTokens(index, ref.file,
                        ref.line, name, options.renameTo);
                    if (edit.renamed === edit.source) continue;
                    changes.push({
                        file: rel,
                        line: ref.line,
                        expression: edit.source,
                        suggestion: `Update reference: ${edit.renamed}`,
                        newExpression: edit.renamed,
                        editKind: 'reference',
                    });
                } else {
                    changes.push({
                        file: rel,
                        line: ref.line,
                        expression: (ref.content || '').trim(),
                        suggestion: `Verify this reference resolves to ` +
                            `${name} at ${def.relativePath || def.file}:` +
                            `${def.startLine} before renaming`,
                        needsReview: true,
                        editKind: 'reference',
                    });
                }
            }
        }
    }

    // Every operation changes the selected declaration. Historically `plan`
    // only listed callers/imports in changes[], while rendering the new
    // signature separately. An agent applying the advertised edit array
    // therefore produced uncompilable code. Keep the declaration in the same
    // concrete list and count as every other required edit.
    const definitionLine = def.nameLine || def.startLine;
    const definitionFile = def.relativePath || def.file;
    const definitionSource = index.getLineContent(def.file, definitionLine).trim();
    const existingDefinitionLine = changes.find(change =>
        change.file === definitionFile && change.line === definitionLine);
    if (existingDefinitionLine) {
        existingDefinitionLine.isDefinition = true;
        existingDefinitionLine.editKind = 'definition';
        if (options.renameTo) {
            const renamed = renameIdentifierTokens(index, def.file,
                definitionLine, name, options.renameTo).renamed;
            existingDefinitionLine.newExpression = renamed;
            existingDefinitionLine.suggestion = `Update definition: ${renamed}`;
        }
    } else {
        const definitionChange = {
            file: definitionFile,
            line: definitionLine,
            expression: definitionSource,
            isDefinition: true,
            editKind: 'definition',
        };
        if (options.renameTo) {
            const renamed = renameIdentifierTokens(index, def.file,
                definitionLine, name, options.renameTo).renamed;
            definitionChange.newExpression = renamed;
            definitionChange.suggestion = `Update definition: ${renamed}`;
        } else {
            definitionChange.suggestion =
                `Update declaration signature to: ${newSignature}`;
            // Signature layouts can span multiple lines and differ by
            // language. The AST proves this edit is required, while the
            // preview explicitly withholds a fake one-line replacement.
            definitionChange.needsReview = true;
        }
        changes.unshift(definitionChange);
    }

    const changeSummary = {
        // editKind is a partition: a public declaration that is also an
        // export remains one definition edit, never two summary buckets.
        definitions: changes.filter(change => change.editKind === 'definition').length,
        calls: changes.filter(change => change.editKind === 'call' ||
            !change.editKind).length,
        imports: changes.filter(change => change.editKind === 'import').length,
        exports: changes.filter(change => change.editKind === 'export').length,
        references: changes.filter(change => change.editKind === 'reference').length,
        reviewRequired: changes.filter(change => change.needsReview).length,
    };

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
        changeSummary,
        changes,
        ...(unchangedSites > 0 && { unchangedSites }),
        // v4 tiered contract: sites that MAY also need this change but lack
        // binding/receiver evidence — review manually before refactoring.
        unverifiedCount: planUnverified.length,
        unverifiedSites: planUnverified,
        account: planAccount,
        scopeWarning: impactScopeWarning,
        ...(resolved.warnings.length > 0 && { warnings: resolved.warnings }),
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
