/**
 * core/verify.js - Signature verification, refactoring planning, call site analysis
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const path = require('path');
const { detectLanguage, getParser, getLanguageModule, safeParse, langTraits } = require('../languages');
const { escapeRegExp } = require('./shared');

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
        } else if (node.type === 'new_expression') {
            // JS/TS constructor: new ClassName(args) — class is in 'constructor'
            // field (fix #230: these sites used to fall out as "Could not
            // parse call arguments" and every class verify went uncertain).
            const ctorNode = node.childForFieldName('constructor');
            if (ctorNode) {
                const typeName = ctorNode.text.replace(/<.*>$/, '').split('.').pop();
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
    if (!def || def.type !== 'class' || !def.file) return null;
    const lists = [];
    const endLine = def.endLine != null ? def.endLine : Infinity;
    for (const ctorName of ['constructor', '__init__']) {
        for (const d of (index.symbols.get(ctorName) || [])) {
            if (d.className === def.name && d.file === def.file &&
                d.startLine >= def.startLine && d.startLine <= endLine &&
                Array.isArray(d.paramsStructured)) {
                lists.push(d.paramsStructured);
            }
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
 *
 * One verify-local promotion survives as positive evidence the engine does
 * not yet model: a receiver naming a namespace/class/module CONTAINER whose
 * body defines the target (BUG-BX `Utils.helper()`) confirms — containment
 * is identity evidence, not a naming heuristic.
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

    const promotes = (c) => c.isMethod && c.receiver &&
        isNamespaceContainerFor(index, c.receiver, name, def.file);

    const confirmed = [];
    const unverified = [];
    for (const c of rawCallers) {
        if (c.tier !== 'unverified') { confirmed.push(c); continue; }
        if (promotes(c)) { confirmed.push({ ...c, tier: 'confirmed', resolution: 'receiver-hint' }); continue; }
        unverified.push(c);
    }
    for (const u of rawCallers.unverifiedEntries || []) {
        if (promotes(u)) confirmed.push({ ...u, tier: 'confirmed', resolution: 'receiver-hint' });
        else unverified.push(u);
    }

    // Conservation account from the POST-promotion claims (impact's manual
    // composition — composeAccount would count promoted entries unverified).
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
        if (ap !== bp) return ap.localeCompare(bp);
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
    for (const c of confirmed) {
        const call = {
            file: c.file,
            relativePath: c.relativePath,
            line: c.line,
            content: c.content,
            usageType: 'call',
            receiver: c.receiver,
        };
        const analysis = analyzeCallSite(index, call, name);
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
        const callTypes = new Set(['call_expression', 'call', 'method_invocation',
            'object_creation_expression', 'new_expression']);
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

        const args = [];
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            args.push(argsNode.namedChild(i).text.trim());
        }

        return {
            args,
            argCount: args.length,
            hasSpread: args.some(a => a.startsWith('...')),
            hasVariable: args.some(a => /^[a-zA-Z_]\w*$/.test(a)),
            isMethodCall,
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
    const rawParamLists = ctorParamLists ||
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
        callerFile: c.callerFile,
        callerStartLine: c.callerStartLine,
    }));

    const valid = [];
    const mismatches = [];
    const uncertain = [];

    const defIsMethod = !!(def.isMethod || def.type === 'method' || def.className);

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

    for (const call of calls) {
        const analysis = analyzeCallSite(index, call, name);

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
                reason: 'Could not parse call arguments',
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
                reason: 'Uses spread operator',
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
            if ((qualStyle === 'method-expr' && def.receiver) ||
                (qualStyle === 'path' && def.isMethod)) {
                argCount -= 1;
            }
        }

        // Check if arg count is valid
        if (hasRest) {
            // With rest param, need at least minArgs
            if (argCount >= minArgs) {
                valid.push({
                    file: call.relativePath,
                    line: call.line,
                    patterns: patternFlagsFrom(analysis),
                    ...carry,
                });
            } else {
                mismatches.push({
                    file: call.relativePath,
                    line: call.line,
                    expression: call.content.trim(),
                    expected: `at least ${minArgs} arg(s)`,
                    actual: argCount,
                    args: analysis.args,
                    patterns: patternFlagsFrom(analysis),
                    ...carry,
                });
            }
        } else {
            // Without rest, need between minArgs and expectedParamCount
            if (argCount >= minArgs && argCount <= expectedParamCount) {
                valid.push({
                    file: call.relativePath,
                    line: call.line,
                    patterns: patternFlagsFrom(analysis),
                    ...carry,
                });
            } else {
                mismatches.push({
                    file: call.relativePath,
                    line: call.line,
                    expression: call.content.trim(),
                    expected: minArgs === expectedParamCount
                        ? `${expectedParamCount} arg(s)`
                        : `${minArgs}-${expectedParamCount} arg(s)`,
                    actual: argCount,
                    args: analysis.args,
                    patterns: patternFlagsFrom(analysis),
                    ...carry,
                });
            }
        }
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
            hasDefault: p.default !== undefined
        })),
        expectedArgs: { min: minArgs, max: hasRest ? '∞' : expectedParamCount },
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
                suggestion = `No change needed (has default value)`;
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
                        args: site.args
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
                        needsReview: true
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
        const renamedLines = new Set();
        for (const site of planCallSites) {
            const lineKey = `${site.file}:${site.line}`;
            if (renamedLines.has(lineKey)) continue;
            renamedLines.add(lineKey);
            const newExpression = site.expression.replace(
                new RegExp('\\b' + escapeRegExp(name) + '\\b', 'g'),
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
        // v4 tiered contract: sites that MAY also need this change but lack
        // binding/receiver evidence — review manually before refactoring.
        unverifiedCount: planUnverified.length,
        unverifiedSites: planUnverified,
        account: planAccount,
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
