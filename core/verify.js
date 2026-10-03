/**
 * core/verify.js - Signature verification, refactoring planning, call site analysis
 *
 * Extracted from project.js. All functions take an `index` (ProjectIndex)
 * as the first argument instead of using `this`.
 */

const { detectLanguage, getParser, getLanguageAdapter, safeParse, langTraits } = require('../languages');
const { sameNode } = require('../languages/utils');
const { escapeRegExp, codeUnitCompare, NON_CALLABLE_TYPES, isOverrideMarked, isMacroNamespaceDefinition } = require('./shared');
const { classDefsNamed, distinctOwnerDefinitions } = require('./class-identity');
const { isTypeRenamePin } = require('./type-references');
const { findAccessorReferences, isAccessorDefinition } = require('./accessors');
const { validateCallMismatch, declarationIdentity } = require('./provenance');
const { UcnError } = require('./errors');
const { execFileSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * The string index of a token that a parser column points at. The
 * tree-sitter binding reports columns of string input in UTF-16 code units;
 * a column that does not spell the token there is read as a UTF-8 byte
 * column (fix #386: tokens after a non-ASCII character on the same line
 * were skipped).
 */
function tokenColumn(line, column, token) {
    if (!Number.isInteger(column) || column < 0) return null;
    if (token && line.slice(column, column + token.length) === token) return column;
    return codeUnitColumnForByteColumn(line, column);
}

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

/**
 * Choose the declaration's own name token among name-field identifiers on a
 * definition line (fix #359). Candidates carry `{column, decl}` where decl is
 * the node whose name/declarator field the identifier is.
 *   1. The declaration must end where the indexed definition ends (when the
 *      definition's endLine is known): a multi-line body's nested parameter
 *      or type declarations end earlier.
 *   2. A member definition (className set) whose class lexically encloses it
 *      binds the candidate INSIDE that class (a one-line `class A { A() {} }`
 *      or `type T struct { T int }` pins the member, not the container).
 *   3. Otherwise the outermost declaration wins: parameters, named results
 *      and qualified type names are always nested inside the declaration
 *      they belong to.
 */
function pickDeclarationNameToken(candidates, definition) {
    if (!candidates || candidates.length === 0) return null;
    let pool = candidates;
    if (definition && Number.isInteger(definition.endLine)) {
        const spanMatch = pool.filter(c => c.decl.endPosition.row + 1 === definition.endLine);
        if (spanMatch.length > 0) pool = spanMatch;
    }
    const className = definition && definition.className;
    if (className) {
        const inside = pool.filter(c => {
            for (let anc = c.decl.parent, depth = 0; anc && depth < 12;
                anc = anc.parent, depth++) {
                const ancName = anc.childForFieldName?.('name');
                if (ancName && ancName.text === className &&
                    !sameNode(anc, c.decl)) return true;
            }
            return false;
        });
        if (inside.length > 0) pool = inside;
    }
    let best = null;
    for (const c of pool) {
        if (!best) { best = c; continue; }
        const a = c.decl, b = best.decl;
        if (a.startIndex <= b.startIndex && a.endIndex >= b.endIndex &&
            (a.startIndex < b.startIndex || a.endIndex > b.endIndex)) {
            best = c;
        } else if (!(b.startIndex <= a.startIndex && b.endIndex >= a.endIndex) &&
            c.column < best.column) {
            // Disjoint declarations: earliest on the line.
            best = c;
        }
    }
    return best ? best.column : null;
}

/**
 * Byte columns of `NAME` tokens on one line that are member accesses on the
 * enclosing instance or class receiver (`this.NAME`, `self.NAME`,
 * `cls.NAME`, `Self::NAME`), by AST: the token is the member part of its
 * parent node and the parent's receiver part is a receiver keyword of the
 * language (traits.selfParam) or a `this`/`self` node (fix #376).
 */
function selfMemberTokenColumns(index, filePath, lineNumber, name) {
    const path = require('path');
    const absolute = path.isAbsolute(filePath) ? filePath : path.join(index.root, filePath);
    const language = index.files.get(absolute)?.language;
    const parser = language && getParser(language);
    if (!parser) return [];
    let content;
    try { content = index._readFile(absolute); } catch { return []; }
    const tree = index._getParsedTree?.(absolute, content, language) || safeParse(parser, content);
    if (!tree) return [];
    const receivers = new Set([...(langTraits(language)?.selfParam || []), 'this', 'self', 'Self']);
    const row = lineNumber - 1;
    const out = [];
    const stack = [tree.rootNode];
    while (stack.length > 0) {
        const node = stack.pop();
        if (node.endPosition.row < row || node.startPosition.row > row) continue;
        if (node.startPosition.row === row && node.text === name &&
            /identifier$/.test(node.type) && node.parent) {
            const parent = node.parent;
            const receiver = parent.namedChild(0);
            if (receiver && !sameNode(receiver, node) &&
                parent.namedChildCount === 2 && sameNode(parent.namedChild(1), node) &&
                receivers.has(receiver.text.replace(/\s+/g, ''))) {
                out.push(node.startPosition.column);
            } else if (parent.type === 'member_access_expression' &&
                sameNode(parent.childForFieldName('name'), node) &&
                receivers.has(String(parent.childForFieldName('expression')?.text || '').replace(/\s+/g, ''))) {
                // C# `this.m`: the keyword receiver is an anonymous node.
                out.push(node.startPosition.column);
            }
            continue;
        }
        for (let i = 0; i < node.namedChildCount; i++) stack.push(node.namedChild(i));
    }
    return out;
}

/** Replace only AST identifier tokens on one source line. */
function renameIdentifierTokens(index, filePath, lineNumber, oldName, newName,
    preferredByteColumns = null, expectedCallCount = null, tokenOptions = {}) {
    const absolute = filePath && require('path').isAbsolute(filePath)
        ? filePath : require('path').join(index.root, filePath || '');
    const content = index._readFile(absolute);
    const sourceLine = content.split('\n')[lineNumber - 1] || '';
    let byteColumns = Array.isArray(preferredByteColumns)
        ? preferredByteColumns.filter(Number.isInteger) : [];
    const defNameByteColumns = [];

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
                    if (eligible) {
                        byteColumns.push(node.startPosition.column);
                        // Definition-name token: the identifier that IS its
                        // parent's `name` field (method_declaration name,
                        // function_definition name, variable_declarator name).
                        // Wrapper identity via sameNode (#233 — wrappers are
                        // not reference-stable across walks).
                        if (tokenOptions.definitionNameOnly && node.parent) {
                            const decl = node.parent;
                            const nameChild = decl.childForFieldName?.('name');
                            const declaratorChild = decl.childForFieldName?.('declarator');
                            if ((nameChild && sameNode(nameChild, node)) ||
                                (declaratorChild && sameNode(declaratorChild, node))) {
                                defNameByteColumns.push({
                                    column: node.startPosition.column,
                                    decl,
                                });
                            }
                        }
                    }
                    continue;
                }
                stack.push(...(node.namedChildren || []));
            }
        }
    }

    // Definition-line discipline (fix #300, mux-measured): a def line can
    // repeat the symbol as a parameter TYPE (`func (r *Route) BuildVarsFunc(f
    // BuildVarsFunc) *Route`) — renaming every token breaks the type
    // reference. Rename only the definition's own NAME token (AST name field;
    // first occurrence as fallback) — javac/gopls rename semantics.
    //
    // Declaration identity (fix #359, gin-measured): several identifiers on
    // a definition line can be their parent's name field (a Go named result
    // `(head string)`, a qualified return type `http.Pusher`, a Java/C
    // parameter declarator). The definition token is the name of the
    // symbol's OWN declaration node, never a nested declaration's name.
    if (tokenOptions.definitionNameOnly && byteColumns.length > 1) {
        const chosen = pickDeclarationNameToken(defNameByteColumns,
            tokenOptions.definition || null);
        byteColumns = chosen != null ? [chosen] : [Math.min(...byteColumns)];
    }

    const columns = [...new Set(byteColumns
        .map(column => tokenColumn(sourceLine, column, oldName))
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
    return {
        source: sourceLine.trim(), renamed: renamed.trim(), count: columns.length,
        columns, rawSource: sourceLine, oldName, newName,
    };
}

/**
 * The column of the called name inside one call's source range (fix #392):
 * two same-name calls on a line (`a.run(b.run())`) are two tokens, and the
 * record of each call spans its own call node. Returns null when the range
 * does not resolve to one name token on the line.
 */
function callTokenColumn(index, filePath, range, name, line) {
    if (!range || !filePath) return null;
    const absolute = require('path').isAbsolute(filePath)
        ? filePath : require('path').join(index.root, filePath);
    const language = index.files.get(absolute)?.language;
    const parser = language && getParser(language);
    if (!parser) return null;
    let content;
    try { content = index._readFile(absolute); } catch { return null; }
    const tree = index._getParsedTree?.(absolute, content, language) || safeParse(parser, content);
    if (!tree) return null;
    let node = tree.rootNode.descendantForIndex(range.start, Math.max(range.start, range.end - 1));
    while (node && !(node.startIndex <= range.start && node.endIndex >= range.end)) node = node.parent;
    if (!node) return null;
    const isName = n => n && n.text === name && /identifier$/.test(n.type) &&
        n.startPosition.row === line - 1;
    if (isName(node)) return node.startPosition.column;
    // The callee part of the call node: its last same-name token outside
    // the argument list names the call (`x.run(y.run())` -> the outer run).
    const callee = node.childForFieldName?.('function') || node.childForFieldName?.('name') ||
        node.childForFieldName?.('method') || node.childForFieldName?.('constructor') ||
        node.childForFieldName?.('macro') || null;
    if (!callee) return null;
    if (isName(callee)) return callee.startPosition.column;
    const named = ['property', 'attribute', 'field', 'name'];
    for (const field of named) {
        const part = callee.childForFieldName?.(field);
        if (isName(part)) return part.startPosition.column;
    }
    return null;
}

/**
 * Merge a second token edit into an existing change on the same line
 * (fix #376): a one-line method whose body calls a same-named slot member
 * (`@Override public String m() { return delegate.m(); }`) needs its
 * declaration token and its call token renamed in ONE line edit. Changes
 * carry their token edit as a non-enumerable `_edit`.
 */
function mergeTokenEdit(change, edit) {
    const prior = change?._edit;
    if (!prior || !edit || prior.rawSource !== edit.rawSource ||
        prior.oldName !== edit.oldName || prior.newName !== edit.newName) return false;
    const columns = [...new Set([...prior.columns, ...edit.columns])].sort((a, b) => b - a);
    if (columns.length === prior.columns.length) return true;
    let renamed = prior.rawSource;
    for (const column of columns) {
        if (renamed.slice(column, column + prior.oldName.length) !== prior.oldName) continue;
        renamed = renamed.slice(0, column) + prior.newName + renamed.slice(column + prior.oldName.length);
    }
    const previous = change.newExpression;
    change.newExpression = renamed.trim();
    if (typeof change.suggestion === 'string' && previous) {
        change.suggestion = change.suggestion.replace(previous, change.newExpression);
    }
    tagTokenEdit(change, { ...prior, columns, renamed: change.newExpression });
    return true;
}

/**
 * Mark a change whose tokens a dedicated pass proved (a macro argument that
 * declares the renamed class, an exactly resolved using-declaration): the
 * type-reference pass keeps them even where its own lookup is unsure.
 */
function markEvidence(change) {
    Object.defineProperty(change, '_evidence', {
        value: true, enumerable: false, writable: true, configurable: true,
    });
    return change;
}

function tagTokenEdit(change, edit) {
    if (!change || !edit || !Array.isArray(edit.columns)) return change;
    Object.defineProperty(change, '_edit', {
        value: edit, enumerable: false, writable: true, configurable: true,
    });
    return change;
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
function findCallNode(node, callTypes, targetRow, funcName, occurrence = 0, site = null) {
    // Several same-name calls can share one line (`greet("a") + greet("b")`,
    // f-strings) — fix #231: callers pass the site's per-line ordinal so each
    // record is arg-checked against ITS OWN node, not the line's first.
    // Records and this walk are both pre-order, so ordinals align; an
    // out-of-range ordinal falls back to the first match (never worse than
    // the pre-fix behavior when a parse shape hides a node).
    const matches = _collectCallNodes(node, callTypes, targetRow, funcName, site ? Infinity : occurrence + 1);
    if (Number.isInteger(site?.start)) {
        // The resolver already identified the callee token. Preserve that
        // identity through argument extraction, including aliases and several
        // calls on one line (some of which may target another declaration).
        const exact = matches.filter(candidate => {
            const callee = candidate.childForFieldName('function') ||
                candidate.childForFieldName('name') ||
                candidate.childForFieldName('constructor') || candidate.childForFieldName('type');
            return callee && callee.startIndex <= site.start && callee.endIndex >= site.end;
        });
        if (exact.length === 1) return exact[0];
    }
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
    // Children are in source order: binary-search the first one that can
    // reach the target row instead of visiting every earlier sibling.
    const count = node.childCount;
    let lo = 0;
    let hi = count;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (node.child(mid).endPosition.row < targetRow) lo = mid + 1;
        else hi = mid;
    }
    for (let i = lo; i < count; i++) {
        const child = node.child(i);
        if (child.startPosition.row > targetRow) break;
        _collectCallNodes(child, callTypes, targetRow, funcName, limit, out);
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
function contractedCallerSweep(index, name, def, options = {}) {
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
    // Call sites that bound the definition's base declaration and that the
    // sweep of the changed declaration excludes (fix #394): they leave the
    // excluded bucket and join the unverified band, to be checked against
    // the new signature.
    const rebound = options.baseChanges
        ? sitesReboundByChange(index, name, def, rawCallers, confirmed, unverified, options.baseChanges)
        : [];
    if (rebound.length > 0 && rawCallers.accountRaw) {
        const moved = new Set(rebound.filter(site => !site.stillUnverified)
            .map(site => `${site.file}\0${site.line}`));
        rawCallers.accountRaw = {
            ...rawCallers.accountRaw,
            excludedEntries: rawCallers.accountRaw.excludedEntries.filter(entry =>
                !moved.has(`${entry.file}\0${entry.line}`)),
        };
        for (const site of rebound) {
            // A site already in the band is replaced by its checked record.
            const at = site.stillUnverified ? unverified.findIndex(u => u.file === site.file &&
                u.line === site.line && !u.rebind && (site.column == null || u.column == null || u.column === site.column)) : -1;
            if (at >= 0) unverified[at] = site;
            else unverified.push(site);
        }
    }

    // Conservation account from the sweep's claims (impact's manual
    // composition).
    const { computeGroundSet, buildAccount } = require('./account');
    let groundSet = index._opGroundSetCache?.get(name);
    if (!groundSet) {
        groundSet = computeGroundSet(index, name);
        index._opGroundSetCache?.set(name, groundSet);
    }
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

    return {
        confirmed, unverified, account, groundSet, rebound, baseChanges: rebound.baseChanges || null,
        accountParts: { confirmedEntries, unverifiedEntries, excludedEntries: accountRaw.excludedEntries },
    };
}

// ── Signature changes against a base revision (fix #394) ─────────────────
//
// The caller engine binds call sites the way the compiler does for code
// that compiles: after `isEmpty(String)` became `isEmpty(String, boolean)`,
// `Util.isEmpty(s)` fits no parameter list of the pin and the sibling
// `isEmpty(Object[])` takes one argument, so the site is excluded as an
// arity/overload mismatch - exactly the site `check` exists to report. The
// base declaration decides which sites bound the definition before the
// change; each is then judged against the new signature and the remaining
// overloads.

// Exclusions whose verdict depends on the pin's declared parameters.
const SIGNATURE_DEPENDENT_EXCLUSIONS = new Set(['arity-mismatch', 'overload-mismatch', 'generic-arity-mismatch']);

/** Declared parameter shape (types, optional/default/rest, method type parameters); names ignored. */
function declaredSignatureKey(symbol) {
    const ps = symbol?.paramsStructured;
    const params = Array.isArray(ps)
        ? ps.map(p => [String(p?.type ?? '').replace(/\s+/g, ''), p?.optional ? 'o' : '',
            p?.default !== undefined ? 'd' : '', p?.rest ? 'r' : '', p?.type ? '' : String(p?.name ?? '')].join(':')).join(',')
        : `raw:${String(symbol?.params ?? '').replace(/\s+/g, '')}`;
    return `${params}|${String(symbol?.generics ?? '').replace(/\s+/g, '')}`;
}

/**
 * The definition (and, for C/C++, its declarations elsewhere) whose declared
 * parameters differ at `base`: [{ def, before }] with `before` the base
 * declaration of the same name and owner, or [] (no git, untracked, file
 * unchanged, parameters unchanged, or a new overload).
 */
const GIT_REF_FORMAT = /^[a-zA-Z0-9._\-~\/^@{}:]+$/;  // eslint-disable-line no-useless-escape

/**
 * Start reading `file` at `base` in the background (a shell running `git
 * show` into a temporary file), so the read overlaps the caller sweep of the
 * current declaration; null where that is not available.
 */
let baseReadSerial = 0;

function startBaseRead(file, base) {
    if (process.platform === 'win32' || !file || !GIT_REF_FORMAT.test(base)) return null;
    const out = path.join(os.tmpdir(),
        `ucn-base-${process.pid}-${++baseReadSerial}-${Math.random().toString(36).slice(2, 10)}`);
    let child;
    try {
        // The content appears under `out` only once complete; `out.none`
        // marks a revision that does not hold the file.
        child = spawn('/bin/sh', ['-c',
            'git show "$1" > "$2.part" 2>/dev/null && mv "$2.part" "$2" || { rm -f "$2.part"; : > "$2.none"; }',
            'ucn-base', `${base}:./${path.basename(file)}`, out],
        { cwd: path.dirname(file), stdio: 'ignore' });
    } catch {
        child = null;
    }
    if (!child?.pid) return null;
    child.on('error', () => {});
    child.unref();
    return { file, out };
}

/** The content a background read produced: a string, null (not at base), or undefined (no answer in time). */
function finishBaseRead(handle, timeoutMs = 15000) {
    const cell = new Int32Array(new SharedArrayBuffer(4));
    const started = Date.now();
    const none = `${handle.out}.none`;
    try {
        for (;;) {
            if (fs.existsSync(handle.out)) return fs.readFileSync(handle.out, 'utf-8');
            if (fs.existsSync(none)) return null;
            if (Date.now() - started > timeoutMs) return undefined;
            Atomics.wait(cell, 0, 0, 1);
        }
    } catch {
        return undefined;
    } finally {
        handle.done = true;
        for (const leftover of [handle.out, none]) {
            try { fs.unlinkSync(leftover); } catch { /* not created */ }
        }
    }
}

function baseDeclarationChanges(index, name, def, base = 'HEAD', baseRead = null) {
    if (!GIT_REF_FORMAT.test(base)) {
        throw new UcnError(`Invalid git ref format: ${base}`);
    }
    const language = index.files.get(def.file)?.language;
    let members = [def];
    if (language === 'c' || language === 'cpp') {
        const { _closeCallableIdentityGroup } = require('./callers');
        members = _closeCallableIdentityGroup(index, [def], index.symbols.get(name) || [def]);
    }
    const byFile = new Map();
    for (const member of members) {
        if (!member.file || !index.files.has(member.file)) continue;
        if (!byFile.has(member.file)) byFile.set(member.file, []);
        byFile.get(member.file).push(member);
    }
    const { extractCallableSymbols } = require('./analysis');
    const changes = [];
    for (const [file, defs] of [...byFile].sort(([a], [b]) => codeUnitCompare(a, b))) {
        let baseContent = baseRead && !baseRead.done && baseRead.file === file ? finishBaseRead(baseRead) : undefined;
        if (baseContent === null) continue;
        if (baseContent === undefined) {
            try {
                baseContent = execFileSync('git', ['show', `${base}:./${path.basename(file)}`], {
                    cwd: path.dirname(file), encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024,
                    stdio: ['ignore', 'pipe', 'ignore'],
                });
            } catch {
                continue;
            }
        }
        // Unchanged since base: the index's content hash of the file says so
        // without reading it again.
        const indexedHash = index.files.get(file)?.hash;
        if (indexedHash && require('crypto').createHash('md5').update(baseContent).digest('hex') === indexedHash) continue;
        if (!indexedHash) {
            let current;
            try { current = index._readFile(file); } catch { continue; }
            if (baseContent === current) continue;
        }
        const entry = index.files.get(file);
        let baseSymbols;
        try {
            baseSymbols = extractCallableSymbols(require('./parser').parse(baseContent, entry.language));
        } catch {
            continue;
        }
        for (const d of defs) {
            const before = baseCounterpartOf(entry.symbols, baseSymbols, d);
            if (before) changes.push({ def: d, before });
        }
    }
    return changes;
}

/**
 * The base declaration of `d` (same name and owner) when its declared
 * parameters changed, else null: base overloads a current sibling still
 * declares are that sibling; among the rest the nearest line wins.
 */
function baseCounterpartOf(currentSymbols, baseSymbols, d) {
    const identity = symbol => `${symbol.name}\0${symbol.className || ''}`;
    const callable = symbol => {
        const type = symbol.type || symbol.memberType || 'method';
        return !NON_CALLABLE_TYPES.has(type) || (type === 'field' && symbol.isMethod);
    };
    const same = baseSymbols.filter(symbol => identity(symbol) === identity(d));
    const key = declaredSignatureKey(d);
    if (same.length === 0 || same.some(symbol => declaredSignatureKey(symbol) === key)) return null;
    const siblings = new Set((currentSymbols || []).filter(symbol => symbol !== d && callable(symbol) &&
        identity(symbol) === identity(d)).map(declaredSignatureKey));
    const changed = same.filter(symbol => !siblings.has(declaredSignatureKey(symbol)));
    if (changed.length === 0) return null;
    changed.sort((a, b) => Math.abs(a.startLine - d.startLine) - Math.abs(b.startLine - d.startLine) ||
        a.startLine - b.startLine);
    return changed[0];
}

const DECLARED_SIGNATURE_FIELDS = ['params', 'paramsStructured', 'generics'];

/** Callers of `def` as the index binds them with each changed declaration's base parameters. */
function callersBeforeChange(index, name, def, changes) {
    return index._isolatedOperation(() => {
        const saved = changes.map(change => [change.def, DECLARED_SIGNATURE_FIELDS.map(field =>
            [field, Object.prototype.hasOwnProperty.call(change.def, field), change.def[field]])]);
        try {
            for (const change of changes) {
                for (const field of DECLARED_SIGNATURE_FIELDS) {
                    if (change.before[field] === undefined) delete change.def[field];
                    else change.def[field] = change.before[field];
                }
            }
            const raw = index.findCallers(name, { includeMethods: true, targetDefinitions: [def], collectAccount: true });
            return [
                ...raw.filter(c => c.tier !== 'unverified').map(c => ({ site: c, boundBefore: 'confirmed' })),
                ...raw.filter(c => c.tier === 'unverified').concat(raw.unverifiedEntries || [])
                    .map(c => ({ site: c, boundBefore: 'unverified' })),
            ];
        } finally {
            for (const [definition, fields] of saved) {
                for (const [field, own, value] of fields) {
                    if (own) definition[field] = value;
                    else delete definition[field];
                }
            }
        }
    });
}

/**
 * Sites the base declaration bound that the current sweep excludes, each
 * with its verdict against the new signature: `rebind.kind` is
 * 'no-overload' (fits no parameter list: a compile error), 'other-overload'
 * (another overload may take it now), 'count' (the argument count decides)
 * or 'unread' (the call record could not be re-read).
 */
function sitesReboundByChange(index, name, def, rawCallers, confirmed, unverified, changes) {
    const excluded = rawCallers.accountRaw?.excludedEntries || [];
    // Only an exclusion by parameter fit, or a site left unverified, can hide
    // a call of the old declaration; otherwise the base is not read.
    const dependent = excluded.filter(entry => SIGNATURE_DEPENDENT_EXCLUSIONS.has(entry.reason));
    if (dependent.length === 0 && unverified.length === 0) return [];
    const baseChanges = typeof changes === 'function' ? changes() : changes;
    if (!baseChanges || baseChanges.length === 0) return [];
    const siteKey = site => `${site.file}\0${site.line}`;
    const confirmedKeys = new Set(confirmed.map(siteKey));
    const unverifiedKeys = new Set(unverified.map(siteKey));
    const reasonAt = new Map(excluded.map(entry => [siteKey(entry), entry.reason]));
    const before = callersBeforeChange(index, name, def, baseChanges);
    const { getCachedCalls, _overloadDiscipline, _overloadApplicable } = require('./callers');
    const pins = [...new Set([def, ...baseChanges.map(change => change.def)])];
    const definitions = index.symbols.get(name) || [];
    const out = [];
    const seen = new Set();
    for (const { site, boundBefore } of before) {
        const key = siteKey(site);
        // A site still confirmed is arg-checked as usual. A site the old
        // declaration confirmed and the new one leaves unverified or
        // excludes is checked against the new declaration here.
        if (confirmedKeys.has(key) || seen.has(key)) continue;
        if (unverifiedKeys.has(key) ? boundBefore !== 'confirmed' : !reasonAt.has(key)) continue;
        seen.add(key);
        const calls = (getCachedCalls(index, site.file) || []).filter(call =>
            call.line === site.line && (call.name === name || call.resolvedName === name));
        const call = calls.find(c => site.column == null || c.column === site.column) || calls[0];
        const language = index.files.get(site.file)?.language;
        let rebind = { kind: call ? 'count' : 'unread' };
        if (call && langTraits(language)?.hasArityOverloads && call.argCount != null && !call.argSpread) {
            const verdict = _overloadDiscipline(index, call, pins, definitions, site.file);
            if (verdict === 'other-overload') {
                const { ownerRefOf } = require('./class-identity');
                const ownerKey = ownerRefOf(index, def)?.key;
                const others = definitions.filter(d => !pins.includes(d) && !NON_CALLABLE_TYPES.has(d.type) &&
                    d.className === def.className && ownerKey && ownerRefOf(index, d)?.key === ownerKey &&
                    _overloadApplicable(index, call, d));
                rebind = { kind: 'other-overload', overloads: others.map(d => formatTypedSignature(d)) };
            } else if (verdict?.ambiguous) {
                rebind = verdict.candidates === 0 ? { kind: 'no-overload' }
                    : { kind: 'other-overload', candidates: verdict.candidates };
            }
        }
        let content = site.content;
        if (content == null) {
            try { content = index._getFileLines(site.file)[site.line - 1] ?? ''; } catch { content = ''; }
        }
        const prior = unverifiedKeys.has(key)
            ? unverified.find(u => siteKey(u) === key && (site.column == null || u.column == null || u.column === site.column))
            : null;
        out.push({
            ...site,
            content,
            tier: 'unverified',
            reason: 'bound-before-change',
            ...(prior?.reason && { priorReason: prior.reason }),
            boundBefore,
            excludedAs: reasonAt.get(key) || null,
            ...(unverifiedKeys.has(key) && { stillUnverified: true }),
            rebind,
        });
    }
    out.sort((a, b) => codeUnitCompare(a.relativePath || '', b.relativePath || '') || a.line - b.line);
    out.baseChanges = baseChanges;
    return out;
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
        ...(u.annotationShorthand && { annotationShorthand: u.annotationShorthand }),
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
function computePlanCallSites(index, name, def, options = {}) {
    // A plan holds one call-site tree per file across its sweeps (fix #395).
    const ownsTreeCache = !index._treeCache;
    // A rename edits name tokens only; argument analysis (a parse of every
    // caller file) serves signature changes (fix #396).
    const analyzeArgs = options.analyzeArgs !== false;
    const { confirmed, unverified, account, groundSet, accountParts } =
        contractedCallerSweep(index, name, def);

    const sites = [];
    const planLineSeen = new Map(); // 'file:line' -> per-line ordinal (fix #231)
    for (const c of confirmed) {
        // A call a macro template generated is spelled in the macro
        // definition (fix #374): the template pass edits or lists it there;
        // the invocation line has no token to rename.
        if (c.macroExpansion?.origin === 'template') continue;
        const call = {
            file: c.file,
            relativePath: c.relativePath,
            line: c.line,
            content: c.content,
            usageType: 'call',
            receiver: c.receiver,
            calledAs: c.calledAs,
            callSite: c.provenance?.facts?.site,
        };
        const siteKey = `${c.file}:${c.line}:${c.calledAs || name}`;
        const occurrence = planLineSeen.get(siteKey) || 0;
        planLineSeen.set(siteKey, occurrence + 1);
        const analysis = analyzeArgs ? analyzeCallSite(index, call, name, occurrence) : { args: null, argCount: 0 };
        // The call's source range (provenance site) lets the rename find
        // its own name token when the record carries no column (fix #392).
        const siteFacts = c.provenance?.facts?.site;
        const siteRange = !Number.isInteger(c.column) && siteFacts &&
            siteFacts.line === c.line && Number.isInteger(siteFacts.start) &&
            Number.isInteger(siteFacts.end) ? { start: siteFacts.start, end: siteFacts.end } : null;
        sites.push({
            file: call.relativePath,
            absoluteFile: call.file,
            line: call.line,
            ...(Number.isInteger(c.column) && { column: c.column }),
            ...(siteRange && { siteRange }),
            expression: (call.content || '').trim(),
            args: analysis.args,
            argCount: analysis.argCount,
            ...(analysis.keywordArgNames && { keywordArgNames: analysis.keywordArgNames }),
            ...(analysis.positionalCount != null && { positionalCount: analysis.positionalCount }),
            ...(c.calledAs && { calledAs: c.calledAs }),
            ...(c.macroExpansion && { macroExpansion: c.macroExpansion }),
            ...(c.targetTyped && { targetTyped: true }),
            ...(c.destructured && { destructured: c.destructured }),
            ...(c.importAliasSpelling && { importAliasSpelling: true }),
        });
    }
    if (ownsTreeCache) clearTreeCache(index);
    // Stable ordering contract: files alphabetical, sites by line ascending.
    sites.sort((a, b) => {
        const fc = codeUnitCompare(String(a.file), String(b.file));
        if (fc !== 0) return fc;
        return (a.line || 0) - (b.line || 0);
    });
    return {
        sites,
        unverifiedSites: unverified.filter(u => u.macroExpansion?.origin !== 'template')
            .map(unverifiedSiteShape),
        // Plan-only evidence used to promote calls through a compiler-proven
        // Go interface slot. Kept out of the public JSON surface.
        rawUnverified: unverified.filter(u => u.macroExpansion?.origin !== 'template'),
        account,
        groundSet,
        accountParts,
    };
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
/**
 * The operation's parsed tree of a file (the one the ground-set
 * classification already parsed) when the language's query tree for this
 * content is the plain parse; null otherwise (a C# file with conditional
 * directives reads a configuration view).
 */
function sharedParsedTree(index, file, content, language) {
    if (typeof index._getParsedTree !== 'function') return null;
    // A language that queries its own view of a file (C# conditional
    // compilation) shares the tree only where that view is the plain parse
    // (fix #395).
    const adapter = getLanguageAdapter(language);
    if (adapter?.queryTree && !adapter.queryTreeIsPlain?.(content, index.files?.get(file))) return null;
    return index._getParsedTree(file, content, language);
}

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
                tree = sharedParsedTree(index, call.file, content, language);
                if (!tree) {
                    const parser = getParser(language);
                    if (!parser) return { args: null, argCount: 0 };
                    tree = safeParse(parser, content);
                }
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
        const spelling = call.calledAs && call.calledAs !== 'bound' ? call.calledAs : funcName;
        const callNode = findCallNode(tree.rootNode, callTypes, targetRow, spelling, occurrence,
            call.callSite || call.provenance?.facts?.site);
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
                tree = sharedParsedTree(index, filePath, content, language);
                if (!tree) {
                    const parser = getParser(language);
                    if (!parser) return null;
                    tree = safeParse(parser, content);
                }
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
    // `&'a mut self` names the receiver too (fix #369): lifetimes are not
    // part of the receiver spelling.
    const selfSpelling = name => String(name || '').replace(/'[A-Za-z_]\w*\s*/g, '').trim();
    const stripSelf = (list) => (selfParams && list.length > 0 && list[0] &&
        selfParams.includes(selfSpelling(list[0].name)))
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
    // A declaration changed since the base revision is checked on the call
    // sites its base declaration bound (fix #394); the base file is read in
    // the background while the current declaration is swept, and used only
    // when the sweep excludes a site by parameter fit or leaves one unverified.
    const baseRef = options.base || 'HEAD';
    if (!GIT_REF_FORMAT.test(baseRef)) throw new UcnError(`Invalid git ref format: ${baseRef}`);
    const baseRead = startBaseRead(def.file, baseRef);
    let sweep;
    try {
        sweep = contractedCallerSweep(index, name, def, {
            baseChanges: () => baseDeclarationChanges(index, name, def, baseRef, baseRead),
        });
    } finally {
        if (baseRead && !baseRead.done) finishBaseRead(baseRead);
    }
    const { confirmed: callerResults, unverified: sweepUnverified, account, rebound, baseChanges } = sweep;

    // Convert caller results to usage-like objects for analyzeCallSite.
    // Carry callerFile/callerStartLine through so we can compute inTestCase.
    const invalidFamilyCalls = sweepUnverified.filter(c =>
        !c.rebind && validateCallMismatch(c.provenance, declarationIdentity(def)));
    const siteContent = c => {
        if (c.content != null) return c.content;
        try { return index._getFileLines(c.file)[c.line - 1] ?? ''; } catch { return ''; }
    };
    const pinBaseChange = (baseChanges || []).find(change => change.def === def) || null;
    const calls = [...callerResults, ...invalidFamilyCalls, ...rebound].map(c => ({
        invalidOverload: invalidFamilyCalls.includes(c) || c.rebind?.kind === 'no-overload',
        ...(c.rebind && { rebind: c.rebind, excludedAs: c.excludedAs, boundBefore: c.boundBefore,
            unverifiedReason: c.priorReason }),
        file: c.file,
        relativePath: c.relativePath,
        line: c.line,
        content: siteContent(c),
        usageType: 'call',
        receiver: c.receiver,
        isMethod: c.isMethod,
        calledAs: c.calledAs,
        callSite: c.provenance?.facts?.site,
        // Preserve receiver identity through the usage-shaped adapter. Go
        // permits a local value to have the same spelling as its type; only
        // a type-qualified call is a method expression with an explicit
        // receiver argument.
        receiverType: c.receiverType,
        callerFile: c.callerFile,
        callerStartLine: c.callerStartLine,
        ...(c.macroExpansion && { macroExpansion: c.macroExpansion }),
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
        const siteKey = `${call.file}:${call.line}:${call.calledAs || name}`;
        const occurrence = verifyLineSeen.get(siteKey) || 0;
        verifyLineSeen.set(siteKey, occurrence + 1);
        const analysis = analyzeCallSite(index, call, name, occurrence);

        // Carry callerFile/callerStartLine so tagInTestCase can resolve the
        // enclosing function in a later pass.
        const carry = {
            callerFile: call.callerFile,
            callerStartLine: call.callerStartLine,
        };

        if (analysis.args === null || call.macroExpansion) {
            // Couldn't parse arguments, or the call exists only in the
            // expansion of a macro invocation on this line (fix #362): its
            // arguments are the macro's, not text on the line.
            uncertain.push({
                file: call.relativePath,
                line: call.line,
                expression: call.content.trim(),
                reason: call.macroExpansion
                    ? `Call produced by expanding macro ${call.macroExpansion.macro}; check the macro's argument list`
                    : analysis.uncertainReason || 'Could not parse call arguments',
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
        // A C# extension method called on its receiver (`b.Length(1, 2)`)
        // receives that receiver as its `this` parameter (fix #394).
        if (def.isExtensionMethod && call.isMethod && call.receiver !== def.className) argCount += 1;
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
        if (call.rebind && call.rebind.kind !== 'no-overload' && (countOk || call.rebind.kind !== 'count')) {
            // Bound the base declaration; the new one may still take it, or
            // another overload may: the compiler decides (fix #394).
            const target = call.rebind.overloads?.length > 0
                ? `it may now bind ${call.rebind.overloads.join(' or ')}`
                : call.rebind.candidates > 0 ? `it may now bind one of ${call.rebind.candidates} overloads`
                    : call.rebind.kind === 'unread' ? 'its call could not be re-read'
                        : call.excludedAs ? `the index excludes it now (${call.excludedAs})`
                            : `its binding to the new declaration is unverified (${call.unverifiedReason || 'no evidence'})`;
            uncertain.push({
                file: call.relativePath,
                line: call.line,
                expression: call.content.trim(),
                reason: `Called the declaration before the change; ${target}`,
                boundBeforeChange: true,
                patterns: patternFlagsFrom(analysis),
                ...carry,
            });
            continue;
        }
        if (!countOk || call.invalidOverload) {
            mismatches.push({
                file: call.relativePath,
                line: call.line,
                expression: call.content.trim(),
                ...(call.rebind && { boundBeforeChange: true }),
                expected: call.invalidOverload && countOk ? 'a compatible overload signature' : hasRest
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
        // The base declaration whose call sites were checked (fix #394).
        ...(pinBaseChange && {
            changedSince: {
                base: options.base || 'HEAD',
                signature: formatTypedSignature({ ...def, ...pinBaseChange.before,
                    ...(pinBaseChange.before.generics === undefined && { generics: undefined }) }),
                callSites: rebound.length,
            },
        }),
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

const {
    goContractClosure,
    externalContractOf,
    hierarchySlotClosure,
    anonymousSlotMembers,
    typedLiteralContract,
    typedLiteralMembers,
    rustProjectTraits,
    rustMacroTemplateSites,
    splitGoSignatureList,
    goDeclarationType,
} = require('./contract-membership');

/**
 * Plan verdict of a C++ qualified reference `Q::name` to the renamed
 * callable (fix #393): Q resolved from the reference's scope (macro-opened
 * namespaces, usings, aliases) names the pin's namespace (a namespace-scope
 * pin) or its class (a member): 'edit'; another namespace or class: null;
 * unresolvable: 'review'.
 */
function cppQualifiedReferenceVerdict(index, ref, def) {
    const { resolveQualifier, effectiveNamespace, macroPrefixAt, includeClosure } = require('./cpp-scope');
    // Inside an indexed declaration the reference's scope is that
    // declaration's (as for calls); at namespace scope (an explicit
    // instantiation is no indexed symbol) it is read from the AST under the
    // macro-opened prefix.
    const enclosing = index.findEnclosingFunction(ref.file, ref.line, true);
    let namespace;
    if (enclosing) {
        namespace = effectiveNamespace(index, enclosing) || '';
    } else {
        let astNamespace = '';
        try {
            const content = index._readFile(ref.file);
            const tree = index._getParsedTree?.(ref.file, content, 'cpp') || safeParse(getParser('cpp'), content);
            const row = ref.line - 1;
            const text = (index._getFileLines?.(ref.file) || content.split('\n'))[row] || '';
            const column = Number.isInteger(ref.column) ? ref.column : Math.max(0, text.search(/\S/));
            const parts = [];
            for (let node = tree?.rootNode.descendantForPosition({ row, column }); node; node = node.parent) {
                if (node.type !== 'namespace_definition') continue;
                const nameNode = node.childForFieldName('name');
                if (nameNode?.text) parts.unshift(nameNode.text.replace(/\s+/g, ''));
            }
            astNamespace = parts.join('::');
        } catch { /* unparsed: the prefix alone */ }
        const prefix = macroPrefixAt(index, ref.file, ref.line) || '';
        namespace = prefix && astNamespace ? `${prefix}::${astNamespace}` : prefix || astNamespace;
    }
    const context = {
        file: ref.file,
        line: ref.line,
        namespace,
        className: enclosing?.className || null,
    };
    let resolved;
    try {
        resolved = resolveQualifier(index, context, String(ref.receiver), includeClosure(index, ref.file));
    } catch {
        return 'review';
    }
    if (!resolved || resolved.kind === 'unknown') return 'review';
    const owner = def.className || (def.receiver ? String(def.receiver).replace(/^\*/, '') : null);
    if (resolved.kind === 'namespace') {
        if (owner) return null;
        return (resolved.resolvedNamespace || resolved.namespace) === effectiveNamespace(index, def) ? 'edit' : null;
    }
    if (resolved.kind === 'type') {
        if (!owner) return null;
        const classes = resolved.classes || [];
        if (classes.length === 0) return 'review';
        return classes.some(cls => cls.name === String(owner).replace(/<.*$/, '')) ? 'edit' : null;
    }
    return 'review';
}

function goMethodArityCompatible(def, argCount) {
    if (!Number.isInteger(argCount)) return true;
    let params;
    if (Array.isArray(def.paramsStructured) && def.paramsStructured.length > 0) {
        params = def.paramsStructured.map(param =>
            param.type || (param.unnamed ? param.name : null));
    } else if (def.params === '' || def.params == null) {
        params = [];
    } else {
        params = splitGoSignatureList(def.params);
    }
    if (params.some(param => !param)) return true;
    const variadic = params.length > 0 &&
        goDeclarationType(params[params.length - 1])?.startsWith('...');
    return variadic ? argCount >= params.length - 1 : argCount === params.length;
}

function goSlotCoversMethodAmbiguity(index, name, slot, raw) {
    if (!slot || raw.reason !== 'method-ambiguous') return false;
    const candidates = (index.symbols.get(name) || []).filter(definition =>
        definition.className && !NON_CALLABLE_TYPES.has(definition.type) &&
        goMethodArityCompatible(definition, raw.argCount));
    return candidates.length > 0 && candidates.every(definition =>
        slot.memberIdentity.has(`${require('path').resolve(definition.file)}\0${definition.startLine}`));
}

/**
 * fix #396: other external-linkage definitions of a C/C++ free function
 * `def` in other files (same C++ namespace and parameter types, same
 * language branch). `defines`: a declaration in the pin's identity group is
 * in the definition's include closure (both define the declared function);
 * `unrelated`: none is.
 */
function cLinkAlternatives(index, def, definitions) {
    const none = { defines: [], unrelated: [] };
    const language = index.files.get(def.file)?.language;
    if (!langTraits(language)?.textualIncludes || def.className || def.receiver || def.isSignature ||
        def.type !== 'function' || def.modifiers?.includes('static') || def.friendOf) return none;
    const { _closeCallableIdentityGroup, _cFamilySignatureKey, _textualIncludeClosures } = require('./callers');
    const { effectiveNamespace } = require('./cpp-scope');
    const group = new Set(_closeCallableIdentityGroup(index, [def], definitions));
    const prototypes = [...group].filter(member => member.isSignature);
    const overloads = langTraits(language)?.hasArityOverloads;
    const key = d => `${overloads ? effectiveNamespace(index, d) : ''}\0${overloads ? _cFamilySignatureKey(d) : ''}\0${d.languageBranch || ''}`;
    const pinKey = key(def);
    const out = { defines: [], unrelated: [] };
    for (const other of definitions) {
        if (other === def || group.has(other) || other.file === def.file || other.type !== 'function' ||
            other.isSignature || other.className || other.receiver || other.friendOf ||
            other.modifiers?.includes('static') || other.generatedByMacro ||
            !langTraits(index.files.get(other.file)?.language)?.textualIncludes || key(other) !== pinKey) continue;
        const closure = _textualIncludeClosures(index, other.file).all;
        const declared = prototypes.some(prototype => prototype.file === other.file || closure.has(prototype.file));
        (declared ? out.defines : out.unrelated).push(other);
    }
    return out;
}

// C: plain identifiers of one spelling at file scope name one entity
// (no overloading, no namespaces).
function cExternalReferenceLanguage(index, file) {
    const traits = langTraits(index.files.get(file)?.language);
    return !!traits?.textualIncludes && !traits.hasArityOverloads;
}

/**
 * fix #396: where a file-scope C reference to NAME in another file than the
 * pin resolves. The file's own definitions or declarations of the name that
 * are not the pin decide first (a static function or object of its own);
 * otherwise the external-linkage function the unit links is the pin when the
 * link verdict keeps it and a declaration of it is visible ('edit'), several
 * link candidates or no visible declaration review, another definition is
 * not the pin.
 */
function cExternalReferenceVerdict(index, ref, def, pinIdentity, definitions) {
    if (def.className || def.receiver || def.modifiers?.includes('static')) return null;
    const own = (index.files.get(ref.file)?.symbols || []).filter(symbol => symbol.name === def.name);
    if (own.some(symbol => !pinIdentity.has(symbol))) return null;
    const { _textualLinkVerdict, _textualIncludeClosures } = require('./callers');
    const verdict = _textualLinkVerdict(index, ref.file, [...pinIdentity], definitions, ref.line);
    if (verdict === 'other') return null;
    if (verdict && verdict.ambiguous) return 'review';
    const { strong } = _textualIncludeClosures(index, ref.file);
    const declared = own.length > 0 || [...pinIdentity].some(member => strong.has(member.file));
    return declared ? 'edit' : 'review';
}

/**
 * Type-reference completion of a type rename (fix #386). Every name token on
 * the ground lines is decided by core/type-references.js; this merges the
 * decisions into the plan's changes:
 *   - edits join an existing token edit on the line, replace a manual
 *     review item another pass left on a line whose tokens are all decided,
 *     or become new reference edits;
 *   - tokens the lookup cannot settle make the line a review item with
 *     their reason (a mixed line keeps its certain edits and is flagged);
 *   - a line holding the name outside every parsed token and outside
 *     comments/strings (macro bodies, unparsed regions) is a review item;
 *   - reference-review items of other passes on lines whose tokens provably
 *     name something else are dropped, and unverified call candidates on
 *     decided lines leave the band (claimed by the account instead).
 */
function applyTypeReferencePass(index, ctx) {
    const { def, name, renameTo, changes, reviewItems, planUnverified } = ctx;
    const { typeReferenceSites } = require('./type-references');
    const { files } = typeReferenceSites(index, def, name, ctx.groundSet);
    const decided = new Map(); // rel:line -> { abs, edited }
    const reviewed = new Map(); // rel:line -> { abs, reason }
    const stringEdited = new Set();
    const target = `${def.relativePath || def.file}:${def.nameLine || def.startLine}`;
    const reasonText = reason => String(reason || 'unresolved').replace(/-/g, ' ');
    const special = change => change.contractDependency || change.templateDependency ||
        change.editKind === 'example' || change.editKind === 'macro-expansion';
    // Rebuild a line edit from code-unit token columns.
    const lineEdit = (raw, columns) => {
        const sorted = [...columns].sort((a, b) => b - a);
        let renamed = raw;
        for (const column of sorted) {
            if (renamed.slice(column, column + name.length) !== name) continue;
            renamed = renamed.slice(0, column) + renameTo + renamed.slice(column + name.length);
        }
        return {
            source: raw.trim(), renamed: renamed.trim(), count: sorted.length,
            columns: sorted, rawSource: raw, oldName: name, newName: renameTo,
        };
    };
    for (const [abs, info] of files) {
        const rel = info.relativePath;
        const fileLines = index._getFileLines(abs);
        for (const [line, slot] of [...info.lines].sort((a, b) => a[0] - b[0])) {
            const key = `${rel}:${line}`;
            const at = changes.findIndex(change => change.file === rel && change.line === line);
            const existing = at >= 0 ? changes[at] : null;
            const raw = fileLines[line - 1] || '';
            const source = raw.trim();
            if (slot.tokens === 0 && slot.reviews.length === 0) {
                if (slot.text && !slot.macroBody) continue;
                if (existing) continue;
                const reason = slot.unparsedReason || (slot.macroBody ? 'macro-body' : 'unparsed-occurrence');
                reviewed.set(key, { abs, reason });
                changes.push({
                    file: rel,
                    line,
                    expression: source,
                    suggestion: `"${name}" appears here outside the parsed code (${reasonText(reason)}); ` +
                        `rename it if it names ${name} at ${target}`,
                    needsReview: true,
                    reviewReason: reason,
                    editKind: 'reference',
                });
                continue;
            }
            const units = columns => columns.map(column => tokenColumn(raw, column, name))
                .filter(Number.isInteger);
            const editUnits = units(slot.edits);
            const skipUnits = new Set(units(slot.skipColumns || []));
            const reviewList = slot.reviews.map(review => ({
                ...review,
                unit: Number.isInteger(review.column) ? tokenColumn(raw, review.column, name) : null,
            }));
            // An existing edit of this line: the type lookup decides every
            // token spelling the name. A token the other pass edits and the
            // lookup cannot settle stays edited and is flagged; one the
            // lookup proves to name another declaration (or a macro argument
            // its replacement list uses in another role) leaves the edit,
            // unless the edit is the pin's own declaration or one a
            // dedicated pass proved.
            if (existing && existing.newExpression !== undefined && !special(existing)) {
                const prior = existing._edit && existing._edit.rawSource === raw ? existing._edit.columns
                    : renameIdentifierTokens(index, abs, line, name, renameTo).columns || [];
                const trusted = (existing.isDefinition || existing._evidence) &&
                    !reviewList.some(review => review.reason === 'macro-argument-other-use');
                const hardUnits = new Set(reviewList.filter(review => review.reason === 'macro-argument-other-use')
                    .map(review => review.unit).filter(Number.isInteger));
                const keep = trusted ? prior
                    : prior.filter(column => !skipUnits.has(column) && !hardUnits.has(column));
                const final = new Set([...keep, ...editUnits]);
                const open = reviewList.filter(review => review.unit == null || !(trusted && final.has(review.unit)));
                if (final.size === 0) {
                    if (open.length === 0) {
                        changes.splice(at, 1);
                        decided.set(key, { abs, edited: false });
                        continue;
                    }
                    delete existing.newExpression;
                    existing.needsReview = true;
                    existing.reviewReason = open[0].reason;
                    existing.suggestion = `Verify whether "${name}" here names ${name} at ${target} ` +
                        `(${reasonText(open[0].reason)}) and rename it if it does`;
                    reviewed.set(key, { abs, reason: open[0].reason });
                    continue;
                }
                const edit = lineEdit(raw, final);
                const previous = existing.newExpression;
                existing.expression = edit.source;
                existing.newExpression = edit.renamed;
                if (typeof existing.suggestion === 'string' && previous && existing.suggestion.includes(previous)) {
                    existing.suggestion = existing.suggestion.replace(previous, edit.renamed);
                }
                tagTokenEdit(existing, edit);
                if (open.length > 0) {
                    existing.needsReview = true;
                    existing.reviewReason = existing.reviewReason || open[0].reason;
                    existing.suggestion += `; verify the "${name}" token(s) UCN could not resolve ` +
                        `(${reasonText(open[0].reason)})`;
                    reviewed.set(key, { abs, reason: open[0].reason });
                } else {
                    // A manual flag another pass left because it could not
                    // place a token is settled once every token is decided.
                    if (existing.needsReview && !existing.reviewReason &&
                        final.size + skipUnits.size >= slot.tokens) delete existing.needsReview;
                    decided.set(key, { abs, edited: true });
                    if (slot.stringAnnotation) stringEdited.add(key);
                }
                continue;
            }
            const certain = reviewList.length === 0;
            const edit = editUnits.length > 0 ? lineEdit(raw, editUnits) : null;
            const hasEdit = !!edit && edit.renamed !== edit.source;
            if (certain) {
                decided.set(key, { abs, edited: hasEdit });
                if (slot.stringAnnotation && hasEdit) stringEdited.add(key);
            } else {
                reviewed.set(key, { abs, reason: reviewList[0].reason });
            }
            const reviewNote = certain ? '' : `; verify the "${name}" token(s) UCN could not resolve ` +
                `(${reasonText(reviewList[0].reason)})`;
            if (existing) {
                // A manual review item another pass left on this line.
                if (existing.newExpression === undefined && existing.needsReview && !special(existing)) {
                    if (certain && hasEdit) {
                        const kind = existing.editKind === 'call' ? 'call' : 'reference';
                        for (const field of Object.keys(existing)) delete existing[field];
                        Object.assign(existing, {
                            file: rel,
                            line,
                            expression: edit.source,
                            suggestion: `${kind === 'call' ? 'Rename to' : 'Update type reference'}: ${edit.renamed}`,
                            newExpression: edit.renamed,
                            editKind: kind,
                        });
                        tagTokenEdit(existing, edit);
                    } else if (certain) {
                        // Every token here provably names another declaration.
                        changes.splice(at, 1);
                    } else if (typeof existing.suggestion === 'string' && !existing.suggestion.includes(reviewNote)) {
                        existing.reviewReason = existing.reviewReason || reviewList[0].reason;
                        existing.suggestion += reviewNote;
                    }
                }
                continue;
            }
            if (hasEdit) {
                changes.push(tagTokenEdit({
                    file: rel,
                    line,
                    expression: edit.source,
                    suggestion: `Update type reference: ${edit.renamed}${reviewNote}`,
                    newExpression: edit.renamed,
                    editKind: 'reference',
                    ...(!certain && { needsReview: true, reviewReason: reviewList[0].reason }),
                }, edit));
            } else if (!certain) {
                changes.push({
                    file: rel,
                    line,
                    expression: source,
                    suggestion: `Verify whether "${name}" here names ${name} at ${target} ` +
                        `(${reasonText(reviewList[0].reason)}) and rename it if it does`,
                    needsReview: true,
                    reviewReason: reviewList[0].reason,
                    editKind: 'reference',
                });
            }
        }
    }
    // C# applies `XAttribute` as `[X]` (fix #386).
    const { csharpAttributeShortSites } = require('./type-references');
    const suffix = 'Attribute';
    for (const site of csharpAttributeShortSites(index, def, name)) {
        if (site.verdict === 'no') continue;
        const short = name.slice(0, -suffix.length);
        const newShort = renameTo.endsWith(suffix) && renameTo.length > suffix.length
            ? renameTo.slice(0, -suffix.length) : renameTo;
        const raw = index._getFileLines(site.file)[site.line - 1] || '';
        const column = tokenColumn(raw, site.column, short);
        const existing = changes.find(change => change.file === site.relativePath && change.line === site.line);
        if (site.verdict === 'yes' && Number.isInteger(column) && !existing) {
            const renamed = raw.slice(0, column) + newShort + raw.slice(column + short.length);
            changes.push({
                file: site.relativePath,
                line: site.line,
                expression: raw.trim(),
                suggestion: `Update attribute usage: ${renamed.trim()}`,
                newExpression: renamed.trim(),
                editKind: 'reference',
            });
            continue;
        }
        const reason = site.verdict === 'yes' ? 'attribute-short-name' : site.reason || 'attribute-short-name';
        if (existing) {
            existing.needsReview = true;
            existing.reviewReason = existing.reviewReason || reason;
            continue;
        }
        changes.push({
            file: site.relativePath,
            line: site.line,
            expression: raw.trim(),
            suggestion: `Verify whether [${short}] applies ${name} at ${target} and rename it to [${newShort}] if it does`,
            needsReview: true,
            reviewReason: reason,
            editKind: 'reference',
        });
    }
    // String annotations the pass edited are no longer text-only review.
    if (stringEdited.size > 0) {
        for (let i = reviewItems.length - 1; i >= 0; i--) {
            const item = reviewItems[i];
            if (item.textDependency && stringEdited.has(`${item.file}:${item.line}`)) reviewItems.splice(i, 1);
        }
    }
    // Unverified call candidates on decided lines are settled.
    const removed = [];
    const kept = [];
    for (const site of planUnverified) {
        const key = `${site.file}:${site.line}`;
        if (decided.has(key)) removed.push(site);
        else kept.push(site);
    }
    if (removed.length > 0) {
        planUnverified.length = 0;
        planUnverified.push(...kept);
    }
    return { decided, reviewed, removed };
}

/**
 * Object identity of a one-hop member-assignment definition (fix #359, ky-
 * measured): `response.json = async () => {...}` patches a property of the
 * object `response` names. It is a project declaration only when that object
 * is itself a project binding: a module-scope declaration or import of the
 * file (`const api = {}; api.get = ...`, `exports.h = ...`). A receiver bound
 * inside an enclosing function (parameter or local) or not declared at all
 * (a runtime global) names an object whose property contract belongs to its
 * own type, typically external (a Fetch `Response`); renaming it is not a
 * mechanical project rename. Returns 'module' | 'local' | 'external', or null
 * when the definition is not a receiver-named member assignment.
 */
const FUNCTION_SCOPE_TYPES = new Set([
    'function_declaration', 'function_expression', 'function', 'arrow_function',
    'method_definition', 'generator_function', 'generator_function_declaration',
]);
function memberAssignmentOwnerScope(index, def) {
    if (!def || !def.memberAssigned || def.className || !def.assignedReceiver) return null;
    const receiver = def.assignedReceiver;
    if (receiver === 'exports' || receiver === 'module') return 'module';
    const language = index.files.get(def.file)?.language;
    const parser = language && getParser(language);
    if (!parser) return null;
    const content = index._readFile(def.file);
    const tree = index._getParsedTree?.(def.file, content, language) || safeParse(parser, content);
    if (!tree) return null;
    const row = def.startLine - 1;
    // The assignment node at the definition line.
    let assignment = null;
    const stack = [tree.rootNode];
    while (stack.length > 0 && !assignment) {
        const node = stack.pop();
        if (node.endPosition.row < row || node.startPosition.row > row) continue;
        if (node.type === 'assignment_expression' && node.startPosition.row === row) {
            const left = node.childForFieldName('left');
            const obj = left && left.type === 'member_expression'
                ? left.childForFieldName('object') : null;
            const prop = left && left.childForFieldName('property');
            if (obj && obj.type === 'identifier' && obj.text === receiver &&
                prop && prop.text === def.name) {
                assignment = node;
                break;
            }
        }
        stack.push(...(node.namedChildren || []));
    }
    if (!assignment) return null;
    const declaresName = (node) => {
        // Binding identifiers introduced by a pattern / declarator subtree.
        const out = [];
        const walk = (n) => {
            if (!n) return;
            if ((n.type === 'identifier' || n.type === 'shorthand_property_identifier_pattern') &&
                n.text === receiver) { out.push(n); return; }
            if (n.type === 'default_value' || n.type === 'assignment_pattern') {
                walk(n.childForFieldName('left'));
                return;
            }
            for (const c of n.namedChildren || []) {
                if (c.type === 'type_annotation') continue;
                walk(c);
            }
        };
        walk(node);
        return out.length > 0;
    };
    const scopeDeclares = (scope) => {
        if (FUNCTION_SCOPE_TYPES.has(scope.type)) {
            const params = scope.childForFieldName('parameters') ||
                scope.childForFieldName('parameter');
            if (params && declaresName(params)) return true;
        }
        const body = FUNCTION_SCOPE_TYPES.has(scope.type)
            ? scope.childForFieldName('body') : scope;
        if (!body) return false;
        const stmts = [body];
        while (stmts.length > 0) {
            const n = stmts.pop();
            for (const c of n.namedChildren || []) {
                if (FUNCTION_SCOPE_TYPES.has(c.type) || c.type === 'class_declaration' ||
                    c.type === 'class') {
                    const nm = c.childForFieldName('name');
                    if (nm && nm.text === receiver && c.type !== 'function_expression' &&
                        c.type !== 'arrow_function' && c.type !== 'class') return true;
                    continue;
                }
                if (c.type === 'variable_declarator') {
                    if (declaresName(c.childForFieldName('name'))) return true;
                    continue;
                }
                if (c.type === 'import_statement') {
                    if (declaresName(c.namedChildren.find(x => x.type === 'import_clause'))) return true;
                    continue;
                }
                if (c.type === 'catch_clause') {
                    if (declaresName(c.childForFieldName('parameter'))) return true;
                }
                if (c.type === 'for_in_statement') {
                    if (declaresName(c.childForFieldName('left'))) return true;
                }
                stmts.push(c);
            }
        }
        return false;
    };
    for (let scope = assignment.parent; scope; scope = scope.parent) {
        if (FUNCTION_SCOPE_TYPES.has(scope.type)) {
            if (scopeDeclares(scope)) return 'local';
        } else if (scope.type === 'program') {
            return scopeDeclares(scope) ? 'module' : 'external';
        }
    }
    return 'external';
}

function plan(index, name, options = {}) {
    index._beginOp();
    // Every slot member of a rename is swept over the same files: their call
    // sites are analyzed on one tree per file for the whole plan (fix #395).
    const ownsTreeCache = !index._treeCache;
    if (ownsTreeCache) index._treeCache = new Map();
    try {
    const definitions = index.symbols.get(name);
    if (!definitions || definitions.length === 0) {
        return { found: false, function: name };
    }

    const resolved = index.resolveSymbol(name, { file: options.file, className: options.className, line: options.line });
    let def = resolved.def || definitions[0];
    // A constructor or destructor carries its class's name (Java, C#, C++):
    // renaming it is renaming the class (fix #386).
    // (A C# member can never carry its type's name except the finalizer.)
    if (options.renameTo && def.className === def.name && !isTypeRenamePin(def) &&
        (def.type === 'constructor' || def.memberType === 'constructor' ||
            (def.type === 'method' && index.files.get(def.file)?.language === 'csharp'))) {
        const owner = definitions.find(d => isTypeRenamePin(d) && d.file === def.file &&
            d.startLine <= def.startLine && d.endLine >= def.endLine);
        if (owner) def = owner;
    }
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
    const { sites: planCallSites, unverifiedSites: planUnverified, account: pinAccount,
        groundSet: planGroundSet, accountParts: planAccountParts } = computePlanCallSites(index, name, def,
        { analyzeArgs: !options.renameTo });
    let planAccount = pinAccount;
    // Call sites a slot member's sweep contributed to this plan (fix #376):
    // the plan's ACCOUNT is rebuilt over the same sites it lists.
    const slotAccountSites = [];
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
    const reviewItems = [];
    // Contract membership (fix #360): project slot roots the rename closed
    // over, and Go satisfaction sites the closure could not complete.
    const contractRootDefs = [];
    const goContractReviews = [];
    // Hierarchy slot closure of a rename (fix #376), for the contract check.
    let hierarchySlot = null;
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
                const keywordCall = langTraits(planLang)?.keywordArguments && site.keywordArgNames?.length > 0;
                suggestion = keywordCall
                    ? `Add keyword argument: ${options.addParam}=${options.addParam} (replace the right-hand value with the intended expression; keep existing keyword arguments)`
                    : `Add argument: ${options.addParam}`;
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
        if (planSelfParams && currentParams.length > 0 && planSelfParams.includes(
            String(currentParams[0].name || '').replace(/'[A-Za-z_]\w*\s*/g, '').trim())) {
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

    // The rename's usage records, shared with the method-group pass below.
    let planUsages = null;
    if (options.renameTo) {
        operation = 'rename';
        newSignature = currentSignature.replace(new RegExp('\\b' + escapeRegExp(name) + '\\b'), options.renameTo);

        // All call sites need renaming. Global replace: a line with several
        // calls (`compute(compute(1))`) renames every occurrence, and the
        // line appears ONCE however many call records it holds (fix #230 —
        // the non-global regex left the inner call behind and emitted a
        // duplicate entry per record).
        // Slot closure is discovered after the pin's own caller sweep. Keep a
        // cumulative per-line record so later member sweeps can add a second
        // exact token on the SAME line (`a.Run() || b.Run() || other.Run()`)
        // and update one edit instead of losing it to line-level deduplication.
        const emittedRenameCalls = new Map();
        // A definition edit on a line another change already edits joins
        // that change's token edit instead of being dropped (fix #376).
        const lineTaken = (member, rel, line) => {
            const existing = changes.find(change => change.file === rel && change.line === line);
            if (!existing) return false;
            if (existing.newExpression !== undefined && existing._edit) {
                const edit = renameIdentifierTokens(index, member.file, line, name,
                    options.renameTo, null, null, { definitionNameOnly: true, definition: member });
                if (edit.renamed !== edit.source && mergeTokenEdit(existing, edit)) {
                    existing.isDefinition = true;
                    existing.editKind = 'definition';
                    existing.suggestion = `Update definition: ${existing.newExpression}`;
                }
            }
            return true;
        };
        const emittedPatternKeys = new Set();
        const emitPatternKeyEdit = (absoluteFile, relativeFile, pattern) => {
            const key = `${relativeFile}:${pattern.line}:${pattern.column}`;
            if (emittedPatternKeys.has(key)) return;
            emittedPatternKeys.add(key);
            const replacement = pattern.shorthand
                ? `${options.renameTo}: ${pattern.local}` : options.renameTo;
            const edit = renameIdentifierTokens(index, absoluteFile, pattern.line, name,
                replacement, [pattern.column], 1);
            if (edit.renamed === edit.source) {
                if (!reviewItems.some(item => item.file === relativeFile && item.line === pattern.line)) {
                    reviewItems.push({
                        file: relativeFile,
                        line: pattern.line,
                        expression: edit.source,
                        suggestion: `Rename the destructured property "${name}" to "${options.renameTo}" ` +
                            'manually, keeping the local binding',
                        needsReview: true,
                        editKind: 'reference',
                    });
                }
                return;
            }
            const concrete = tagTokenEdit({
                file: relativeFile,
                line: pattern.line,
                expression: edit.source,
                suggestion: `Rename the destructured property: ${edit.renamed}`,
                newExpression: edit.renamed,
                editKind: 'reference',
            }, edit);
            const lineOwner = changes.find(change => change.file === relativeFile &&
                change.line === pattern.line && change.newExpression !== undefined && change._edit);
            if (!lineOwner || !mergeTokenEdit(lineOwner, edit)) changes.push(concrete);
        };
        const emitRenameCallSites = (siteList) => {
        const touched = new Set();
        for (const incoming of siteList) {
            // A target-typed `new(..)` spells no name: the type written at
            // its declaration site is what the rename edits (fix #393).
            if (incoming.targetTyped) continue;
            // A call of a name destructured from the member (`const { run }
            // = make(); run()`) spells the member at the pattern key (fix
            // #397): the key is renamed and the local binding kept
            // (`{ run }` -> `{ runZ: run }`), so the call line is unchanged.
            if (incoming.destructured) {
                emitPatternKeyEdit(incoming.absoluteFile || incoming.file, incoming.file, incoming.destructured);
                continue;
            }
            // A call spelled by an aliased import's local name keeps it; the
            // import's source side and the export chain carry the rename.
            if (incoming.importAliasSpelling) continue;
            // A pasted call target (`fs__##lc` with `XX(STAT, stat)`) is
            // not spelled on the invocation line: no token edit exists here,
            // and the rename is incomplete until the macro's arguments or
            // replacement list change with it (fix #362).
            if (incoming.macroExpansion?.origin === 'paste') {
                if (!reviewItems.some(item => item.file === incoming.file && item.line === incoming.line)) {
                    reviewItems.push({
                        file: incoming.file,
                        line: incoming.line,
                        expression: incoming.expression,
                        suggestion: `Macro ${incoming.macroExpansion.macro} builds "${name}" by token pasting at this ` +
                            'invocation; change the macro arguments or definition so the expansion spells ' +
                            `"${options.renameTo}"`,
                        needsReview: true,
                        templateDependency: true,
                        reviewReason: 'macro-expansion',
                        editKind: 'macro-expansion',
                    });
                }
                continue;
            }
            const lineKey = `${incoming.file}:${incoming.line}`;
            const site = emittedRenameCalls.get(lineKey) || {
                file: incoming.file,
                absoluteFile: incoming.absoluteFile,
                line: incoming.line,
                expression: incoming.expression,
                columns: [],
                missingColumn: false,
                callCount: 0,
                calledAs: incoming.calledAs,
                change: null,
            };
            if (site.calledAs !== incoming.calledAs) site.calledAs = null;
            site.callCount++;
            const column = Number.isInteger(incoming.column) ? incoming.column
                : callTokenColumn(index, incoming.absoluteFile || incoming.file, incoming.siteRange,
                    name, incoming.line);
            if (Number.isInteger(column)) site.columns.push(column);
            else site.missingColumn = true;
            emittedRenameCalls.set(lineKey, site);
            touched.add(lineKey);
        }
        for (const lineKey of touched) {
            const site = emittedRenameCalls.get(lineKey);
            // A renamed import preserves its local alias (`old as local` /
            // `{ old: local }`). The caller engine carries the authored name
            // in calledAs; that token must remain unchanged while the import's
            // source-side identifier is edited below.
            // `calledAs: 'bound'` labels a bind/call/apply site
            // (`obj.m.bind(obj)`), which spells the name (fix #397).
            if (site.calledAs && site.calledAs !== name && site.calledAs !== 'bound') continue;
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
                if (site.missingColumn && site.calledAs !== 'bound') {
                    const manual = {
                        file: site.file,
                        line: site.line,
                        expression: edit.source,
                        suggestion: `Rename call identifier "${name}" to "${options.renameTo}" manually`,
                        needsReview: true,
                        editKind: 'call',
                    };
                    if (site.change) {
                        for (const key of Object.keys(site.change)) delete site.change[key];
                        Object.assign(site.change, manual);
                    } else {
                        site.change = manual;
                        changes.push(manual);
                    }
                }
                continue;
            }
            const concrete = tagTokenEdit({
                file: site.file,
                line: site.line,
                expression: edit.source,
                suggestion: `Rename to: ${newExpression}`,
                newExpression,
                editKind: 'call',
            }, edit);
            // Another pass already edits this line (a slot member's
            // one-line declaration): add the call tokens to that edit.
            const lineOwner = site.mergedInto || (!site.change && changes.find(change =>
                change.file === site.file && change.line === site.line &&
                change.newExpression !== undefined && change._edit));
            if (lineOwner && mergeTokenEdit(lineOwner, edit)) {
                site.mergedInto = lineOwner;
            } else if (site.change) {
                for (const key of Object.keys(site.change)) delete site.change[key];
                Object.assign(site.change, concrete);
                tagTokenEdit(site.change, edit);
            } else {
                site.change = concrete;
                changes.push(concrete);
            }
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
        const {
            _nameBindingReaches,
            _moduleAttributeBindingReaches,
        } = require('./callers');
        const renameTargetFiles = new Set([def.file]);
        // A rename plan is repository-wide. The caller sweep already includes
        // tests; the import/reference sweep must not silently hide them via
        // usages()' navigation-oriented default test exclusion.
        const usages = index.usages(name, {
            codeOnly: false,
            includeTests: true,
            internalEvidence: true,
        });
        planUsages = usages;
        const importUsages = usages.filter(u => u.usageType === 'import' && !u.isDefinition);
        // Import identity (fix #359, starlette-measured): an import binds a
        // module-level name. A MEMBER pin (method/field of a class, struct,
        // trait or impl) is never what `import json` binds, so renaming
        // Request.json must not rewrite the stdlib `import json` in its own
        // file. Languages whose bare names can denote members through a
        // member import (Java `import static a.D.head`) keep the edit only
        // when the binding provably reaches the pinned file.
        const pinIsMember = !!def.className && !!(def.isMethod || def.memberType);
        const memberImportable = pinIsMember &&
            !!langTraits(planLang)?.bareCallReachesMethods;
        const importMayBindPin = (file) => {
            // A source-side import token need not be exposed by its importing
            // file: `from core import transform as xf` binds only `xf` there.
            // The statement's source module decides ownership below.
            if (!pinIsMember) return true;
            return memberImportable &&
                _nameBindingReaches(index, file, name, renameTargetFiles) === 'yes';
        };
        // Import SOURCE identity (fix #376): an import statement's source-side
        // name is edited only when the module it imports from binds the
        // renamed definition. `import { flag as baseFlag } from './utils'`
        // inside the pin's own file imports ANOTHER module's flag; a module
        // never imports its own definition, so in the pin's file an import of
        // the name from any other (or unresolvable) module is never this
        // rename's import.
        const importSourceBindsPin = (filePath, line) => {
            const fileEntry = index.files.get(filePath);
            const bindings = (fileEntry?.importBindings || []).filter(binding =>
                binding.line === line && binding.name === name && binding.module);
            // The name is only the LOCAL alias of another imported name on
            // this line (`import { g as f }`, `const f = require('m').g`,
            // fix #397): an import alias keeps its local name, and the
            // source-side name is not the renamed definition's.
            if (bindings.length === 0 && (fileEntry?.importBindings || []).some(binding =>
                binding.line === line && binding.alias === name && binding.name !== name)) return false;
            if (bindings.length === 0) return true;
            return bindings.some(binding => {
                const rel = fileEntry.moduleResolved?.[binding.module];
                const abs = rel ? (require('path').isAbsolute(rel) ? rel
                    : require('path').join(index.root, rel)) : null;
                // An import from a module outside the project (`const parse =
                // require('parseurl')`, fix #397) binds that module's value,
                // never the renamed definition; a resolver gap keeps the edit.
                if (!abs && !require('./callers')._unresolvedModuleIsGap(index, binding.module, binding)) return false;
                if (!abs) return filePath !== def.file;
                if (abs === filePath) return false;
                return _nameBindingReaches(index, abs, name, renameTargetFiles) !== 'no';
            });
        };
        for (const imp of importUsages) {
            // Skip if already covered by a call site change in the same file:line
            const alreadyCovered = changes.some(c =>
                c.file === (imp.relativePath || imp.file) && c.line === imp.line
            );
            if (alreadyCovered) continue;
            // The token is the importer's own local alias (fix #397): an
            // import alias keeps its local name.
            if (imp.importAlias) continue;
            if (imp.file && def.file && !importMayBindPin(imp.file)) continue;
            if (imp.file && !importSourceBindsPin(imp.file, imp.line)) continue;
            const edit = renameIdentifierTokens(index, imp.file,
                imp.line, name, options.renameTo);
            const newImport = edit.renamed;
            if (newImport === edit.source) continue;
            changes.push(tagTokenEdit({
                file: imp.relativePath || imp.file,
                line: imp.line,
                expression: edit.source,
                suggestion: `Update import: ${newImport}`,
                newExpression: newImport,
                isImport: true,
                editKind: 'import',
            }, edit));
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
                if (!importMayBindPin(filePath)) continue;
                if (!importSourceBindsPin(filePath, binding.line)) continue;
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
                // Symbol identity (fix #300, mux-measured): a name-keyed
                // export list records one entry per same-named symbol — under
                // the METHOD pin (r *Route) BuildVarsFunc, the entry anchored
                // at the same-named TYPE's definition line (`type
                // BuildVarsFunc func(...)`) is the type's export surface, not
                // the method's; renaming it silently renames the type and
                // breaks every type reference. Skip entries whose line hosts
                // a different same-named definition. CJS surfaces
                // (`module.exports = { helper }`) have no def at their line
                // and keep flowing.
                const defsAtExportLine = (index.symbols.get(name) || []).filter(d =>
                    d.file === exportPath &&
                    (d.startLine === exported.line ||
                        (d.nameLine ?? d.startLine) === exported.line));
                const pinnedAtExportLine = defsAtExportLine.some(d =>
                    d.file === def.file && d.startLine === def.startLine);
                if (defsAtExportLine.length > 0 && !pinnedAtExportLine) continue;
                // A member pin's export surface is its own declaration line
                // only; a same-named module-level export belongs to another
                // binding (fix #359).
                if (pinIsMember && !pinnedAtExportLine) continue;
                const exportFile = targetEntry.relativePath || exportPath;
                if (changes.some(change =>
                    change.file === exportFile && change.line === exported.line)) {
                    continue;
                }
                // The pinned definition's own line is an export surface of
                // THAT declaration (`export function head(head: string)`):
                // rename only the declaration's name token (fix #359).
                const edit = renameIdentifierTokens(index, exportPath,
                    exported.line, name, options.renameTo, null, null,
                    pinnedAtExportLine
                        ? { definitionNameOnly: true, definition: def } : {});
                const sourceLine = edit.source;
                const occurrences = edit.count;
                const newExpression = edit.renamed;
                if (newExpression === sourceLine) continue;
                changes.push(tagTokenEdit({
                    file: exportFile,
                    line: exported.line,
                    expression: sourceLine,
                    suggestion: `Update export: ${newExpression}`,
                    newExpression,
                    isExport: true,
                    editKind: 'export',
                    ...(occurrences > 1 && { needsReview: true }),
                }, edit));
            }
        }

        // Python __all__ string entries are rename edits (fix #300,
        // requests-measured): `__all__ = (..., "put", ...)` names the
        // module-level binding by STRING — after the def and the import that
        // binds it are renamed, the dangling entry is a compiler-checked
        // break (pyright reportUnsupportedDunderAll). grep sees inside
        // strings; the plan must too. Scan exactly the files whose
        // module-level binding of the name this plan renames: the pin's own
        // module (module-level pins only) and every file receiving an
        // [import] edit. AST-detected: string elements of an __all__
        // assignment matching the name exactly; dynamic __all__ manipulation
        // stays out of scope.
        if (!def.className) {
            const pathMod = require('path');
            const dunderFiles = new Set([def.file]);
            for (const change of changes) {
                if (change.editKind !== 'import') continue;
                const abs = pathMod.isAbsolute(change.file)
                    ? change.file : pathMod.join(index.root, change.file);
                dunderFiles.add(abs);
            }
            for (const abs of dunderFiles) {
                const fe = index.files.get(abs);
                if (!fe || fe.language !== 'python') continue;
                let content;
                try { content = index._readFile(abs); } catch { continue; }
                if (!content.includes('__all__')) continue;
                const parser = getParser('python');
                const tree = parser && (index._getParsedTree?.(abs, content, 'python') ||
                    safeParse(parser, content));
                if (!tree) continue;
                const lines = content.split('\n');
                const rel = fe.relativePath || abs;
                const stack = [tree.rootNode];
                while (stack.length > 0) {
                    const node = stack.pop();
                    if (node.type === 'assignment' || node.type === 'augmented_assignment') {
                        const left = node.childForFieldName('left');
                        if (left?.text !== '__all__') continue;
                        const right = node.childForFieldName('right');
                        if (!right) continue;
                        const strStack = [right];
                        while (strStack.length > 0) {
                            const s = strStack.pop();
                            if (s.type === 'string') {
                                const inner = s.text.replace(/^[rbuf]*["']/i, '').replace(/["']$/, '');
                                if (inner !== name) continue;
                                const lineNo = s.startPosition.row + 1;
                                if (changes.some(c => c.file === rel && c.line === lineNo)) continue;
                                const sourceLine = lines[lineNo - 1] || '';
                                const quoteRe = new RegExp(`(["'])${escapeRegExp(name)}\\1`, 'g');
                                const newLine = sourceLine.replace(quoteRe, `$1${options.renameTo}$1`);
                                if (newLine === sourceLine) continue;
                                changes.push({
                                    file: rel,
                                    line: lineNo,
                                    expression: sourceLine.trim(),
                                    suggestion: `Update __all__ entry: ${newLine.trim()}`,
                                    newExpression: newLine.trim(),
                                    editKind: 'reference',
                                });
                            } else {
                                for (let i = 0; i < s.namedChildCount; i++) strStack.push(s.namedChild(i));
                            }
                        }
                        continue;
                    }
                    for (let i = 0; i < node.namedChildCount; i++) stack.push(node.namedChild(i));
                }
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
                if (lineTaken(member, rel, line)) continue;
                const edit = renameIdentifierTokens(index, member.file,
                    line, name, options.renameTo,
                    null, null, { definitionNameOnly: true, definition: member });
                if (edit.renamed === edit.source) continue;
                changes.push(tagTokenEdit({
                    file: rel,
                    line,
                    expression: edit.source,
                    suggestion: langTraits(index.files.get(member.file)?.language)?.textualIncludes
                        ? `Update declaration: ${edit.renamed}`
                        : isAccessorDefinition(member) && isAccessorDefinition(def)
                        ? `Update accessor: ${edit.renamed}`
                        : `Update overload signature: ${edit.renamed}`,
                    newExpression: edit.renamed,
                    isDefinition: true,
                    editKind: 'definition',
                }, edit));
            }
        }

        // Configuration alternatives (fix #376): in a language where a
        // definition cannot be repeated in one scope except under
        // conditional compilation (traits.conditionalDefinitions: Rust
        // `#[cfg]`, C/C++/C# `#if`), a same-file definition of the same name,
        // owner and signature is the SAME item in another build
        // configuration. Only one is compiled at a time, so the caller engine
        // binds calls to one of them; the rename must change every
        // alternative and every alternative's call sites.
        const conditionalStyle = langTraits(planLang)?.conditionalDefinitions;
        // Other external definitions of a C/C++ free function in other files
        // (fix #396: platform variants `net_open` in net.c and net_win.c):
        // each defines the function its shared declaration declares, so the
        // rename changes them all; one no shared declaration ties to the pin
        // (a separate program's own definition) is a review item.
        const linkAlternatives = cLinkAlternatives(index, def, definitions);
        for (const other of linkAlternatives.unrelated) {
            reviewItems.push({
                file: other.relativePath || path.relative(index.root, other.file),
                line: other.nameLine || other.startLine,
                expression: (index.getLineContent(other.file, other.nameLine || other.startLine) || '').trim(),
                suggestion: `Another external definition of "${name}" that no declaration of the renamed ` +
                    'function reaches (a separate program or platform build); rename it too if it is the same function',
                needsReview: true,
                editKind: 'definition',
            });
        }
        if (conditionalStyle && !def.isSignature) {
            const { _cFamilySignatureKey, _isCrossFileConfigurationMember, _sameOwnerPath } = require('./callers');
            const hasCfg = d => (d.attributesWithArgs || []).some(a => a.name === 'cfg') ||
                (d.modifiers || []).includes('cfg');
            const alternatives = definitions.filter(other => other !== def && ((
                other.file === def.file && !other.isSignature &&
                !NON_CALLABLE_TYPES.has(other.type) &&
                (other.className || null) === (def.className || null) &&
                (other.traitName || null) === (def.traitName || null) &&
                (other.namespace || null) === (def.namespace || null) &&
                (other.explicitInterface || null) === (def.explicitInterface || null) &&
                !(other.startLine === def.startLine && other.endLine === def.endLine) &&
                // Members of two same-name classes declared in different
                // scopes (a function-local class) are two items (fix #389).
                !distinctOwnerDefinitions(index, other, def) &&
                // One full owner path (fix #395): same-name nested types of
                // two outer classes are two items.
                _sameOwnerPath(index, other, def) &&
                _cFamilySignatureKey(other) === _cFamilySignatureKey(def) &&
                (conditionalStyle !== 'attribute' || hasCfg(def) || hasCfg(other))) ||
                // The same class defined again in a file no translation unit
                // includes beside this one (fix #385: `#ifdef _WIN32
                // #include "client-windows.h" #else #include "client.h"`).
                (!other.isSignature && _isCrossFileConfigurationMember(index, def, other)) ||
                linkAlternatives.defines.includes(other)));
            const alternativeSites = [];
            for (const other of alternatives) {
                const line = other.nameLine || other.startLine;
                const rel = other.relativePath || other.file;
                if (!lineTaken(other, rel, line)) {
                    const edit = renameIdentifierTokens(index, other.file, line, name,
                        options.renameTo, null, null, { definitionNameOnly: true, definition: other });
                    if (edit.renamed !== edit.source) {
                        changes.push(tagTokenEdit({
                            file: rel,
                            line,
                            expression: edit.source,
                            suggestion: linkAlternatives.defines.includes(other)
                                ? `Update another definition of the declared function: ${edit.renamed}`
                                : `Update configuration alternative: ${edit.renamed}`,
                            newExpression: edit.renamed,
                            isDefinition: true,
                            editKind: 'definition',
                        }, edit));
                    }
                }
                const sweep = computePlanCallSites(index, name, other, { analyzeArgs: !options.renameTo });
                const seen = new Set([...planCallSites, ...alternativeSites].map(site =>
                    `${site.file}:${site.line}:${site.column ?? '*'}`));
                const lines = new Set([...planCallSites, ...alternativeSites].map(site =>
                    `${site.file}:${site.line}`));
                for (const site of sweep.sites) {
                    const key = `${site.file}:${site.line}:${site.column ?? '*'}`;
                    if (seen.has(key)) continue;
                    // One call reached through two alternatives' sweeps, once
                    // without its column (fix #385: a macro alternative's
                    // invocation beside the function's own call record).
                    if (site.column == null && lines.has(`${site.file}:${site.line}`)) continue;
                    const lineless = alternativeSites.findIndex(existing => existing.column == null &&
                        existing.file === site.file && existing.line === site.line);
                    if (lineless >= 0) alternativeSites.splice(lineless, 1);
                    seen.add(key);
                    lines.add(`${site.file}:${site.line}`);
                    alternativeSites.push(site);
                }
                for (const site of sweep.unverifiedSites) {
                    if (planUnverified.some(existing => existing.file === site.file &&
                        existing.line === site.line)) continue;
                    // A call another alternative's sweep already edits is that
                    // edit, not a second (column-less) site of review.
                    if (lines.has(`${site.file}:${site.line}`)) continue;
                    planUnverified.push(site);
                }
            }
            // A call the engine left ambiguous only between configuration
            // alternatives binds one of them whichever configuration builds:
            // when the rename covers every project body of the name, it is
            // an edit.
            if (alternatives.length > 0) {
                const renamed = new Set([def, ...alternatives]);
                const coversAll = definitions.every(d => renamed.has(d) || d.isSignature ||
                    NON_CALLABLE_TYPES.has(d.type) ||
                    (d.className || null) !== (def.className || null));
                if (coversAll) {
                    const promoted = planUnverified.filter(site =>
                        site.reason === 'link-ambiguous' || site.reason === 'macro-definition-ambiguous' ||
                        site.reason === 'overload-ambiguous' || site.reason === 'configuration-alternative');
                    const editedLines = new Set([...planCallSites, ...alternativeSites]
                        .map(site => `${site.file}:${site.line}`));
                    for (const site of promoted) {
                        // Already an edit through an alternative's own sweep.
                        if (editedLines.has(`${site.file}:${site.line}`)) continue;
                        alternativeSites.push({
                            file: site.file,
                            absoluteFile: require('path').join(index.root, site.file),
                            line: site.line,
                            expression: site.expression,
                        });
                    }
                }
            }
            if (alternativeSites.length > 0) {
                emitRenameCallSites(alternativeSites);
                slotAccountSites.push(...alternativeSites);
                const changedLines = new Set(changes.map(change => `${change.file}:${change.line}`));
                const kept = planUnverified.filter(site => !changedLines.has(`${site.file}:${site.line}`));
                planUnverified.length = 0;
                planUnverified.push(...kept);
                planUnverified.sort((a, b) => codeUnitCompare(a.file, b.file) || a.line - b.line);
            }
        }

        // Run-time alternative bindings of the same scope variable (fix
        // #376): a language whose adapter reports them (Python) binds a name
        // per executed statement, so `if ...: f = lib.f` / `else: def f()`,
        // try/except import fallbacks and a class body's `close = release`
        // are one variable with the pin. Definitions and assignment targets
        // are renamed with it, an unaliased import alternative gains an
        // alias, and class-body reads of a member are references.
        {
            let adapter = null;
            try { adapter = getLanguageAdapter(planLang); } catch { adapter = null; }
            if (typeof adapter?.findScopeAlternativeBindings === 'function') {
                let tree = null;
                try {
                    const content = index._readFile(def.file);
                    const parser = getParser(planLang);
                    tree = parser && (index._getParsedTree?.(def.file, content, planLang) ||
                        safeParse(parser, content));
                } catch { tree = null; }
                const bindings = tree
                    ? adapter.findScopeAlternativeBindings(tree, def.nameLine || def.startLine, name)
                    : [];
                const rel = def.relativePath || def.file;
                for (const binding of bindings) {
                    if (changes.some(change => change.file === rel && change.line === binding.line)) continue;
                    const replacement = binding.kind === 'import-name'
                        ? `${name} as ${options.renameTo}` : options.renameTo;
                    const edit = renameIdentifierTokens(index, def.file, binding.line, name,
                        replacement, [binding.column]);
                    if (edit.renamed === edit.source) continue;
                    const isReference = binding.kind === 'reference';
                    changes.push(tagTokenEdit({
                        file: rel,
                        line: binding.line,
                        expression: edit.source,
                        suggestion: isReference
                            ? `Update class-scope reference: ${edit.renamed}`
                            : `Update alternative binding: ${edit.renamed}`,
                        newExpression: edit.renamed,
                        ...(!isReference && { isDefinition: true }),
                        editKind: isReference ? 'reference' : 'definition',
                    }, edit));
                }
            }
        }

        // Renaming a virtual/overridden member is one hierarchy-wide change.
        // Leaving descendant declarations behind either fails compilation
        // (Java/C#/TS override) or silently changes dispatch (Python/JS).
        // A typed object-literal member (`const h: Handler = { handle() {} }`)
        // fills the slot of its declared interface the same way (fix #360).
        const literalContract = typedLiteralContract(index, def);
        if (def.className || literalContract?.projectInterface) {
            // Slot closure by class DEFINITION identity (fix #376): the
            // renamed member's slot spans every transitive ancestor that
            // declares it - including through intermediate classes that do
            // not redeclare it (jackson WriterBasedJsonGenerator.writeName
            // -> JsonGeneratorBase -> GeneratorBase -> JsonGenerator) - and
            // every transitive descendant of those declaring classes that
            // overrides it. Parents resolve from the declaring file
            // (qualified and nested spellings included), children only when
            // their own base resolves back to the same definition; languages
            // with overloads by parameter list keep only the same-signature
            // slot. Declared `implements` clauses are slot edges for members
            // declared in the class body.
            let slotStartRef = null;
            if (!def.className && literalContract?.projectInterface) {
                const iface = literalContract.projectInterface;
                const entry = classDefsNamed(index, iface.name).entries
                    .find(e => e.def.file === iface.file);
                if (entry) slotStartRef = { name: iface.name, key: entry.key, def: entry.def };
            }
            const hierarchy = (def.className || slotStartRef)
                ? hierarchySlotClosure(index, def, slotStartRef) : null;
            const slotAncestors = [];
            for (const ancestor of hierarchy?.ancestors || []) {
                for (const member of ancestor.members) {
                    if (member.file === def.file && member.startLine === def.startLine) continue;
                    slotAncestors.push({ className: ancestor.ref.name, file: member.file, def: member });
                }
            }
            hierarchySlot = hierarchy;
            const slotMemberDefs = [];
            // fix #379: a C/C++ slot member declared in its class and
            // defined out of line (`void Derived::f() {}` in another file)
            // is one callable; renaming the declaration alone leaves a
            // definition that matches nothing.
            const { _closeCallableIdentityGroup: closeIdentity } = require('./callers');
            const renameSlotPartners = (member, suggestion) => {
                for (const partner of closeIdentity(index, [member], definitions)) {
                    if (partner === member ||
                        (partner.file === def.file && partner.startLine === def.startLine)) continue;
                    const line = partner.nameLine || partner.startLine;
                    const rel = partner.relativePath || partner.file;
                    if (lineTaken(partner, rel, line)) continue;
                    const edit = renameIdentifierTokens(index, partner.file,
                        line, name, options.renameTo,
                        null, null, { definitionNameOnly: true, definition: partner });
                    if (edit.renamed === edit.source) continue;
                    changes.push(tagTokenEdit({
                        file: rel,
                        line,
                        expression: edit.source,
                        suggestion: `${suggestion}: ${edit.renamed}`,
                        newExpression: edit.renamed,
                        isDefinition: true,
                        editKind: 'definition',
                    }, edit));
                    slotMemberDefs.push(partner);
                }
            };
            for (const ancestor of slotAncestors) {
                slotMemberDefs.push(ancestor.def);
                const line = ancestor.def.nameLine || ancestor.def.startLine;
                const rel = ancestor.def.relativePath || ancestor.def.file;
                if (lineTaken(ancestor.def, rel, line)) continue;
                const edit = renameIdentifierTokens(index, ancestor.def.file,
                    line, name, options.renameTo,
                    null, null, { definitionNameOnly: true, definition: ancestor.def });
                if (edit.renamed === edit.source) continue;
                changes.push(tagTokenEdit({
                    file: rel,
                    line,
                    expression: edit.source,
                    suggestion: `Update base definition: ${edit.renamed}`,
                    newExpression: edit.renamed,
                    isDefinition: true,
                    editKind: 'definition',
                }, edit));
            }
            for (const ancestor of slotAncestors) renameSlotPartners(ancestor.def, 'Update base definition');

            const pinOwnerKey = hierarchy?.pinRef?.key || null;
            for (const descendant of hierarchy?.descendants || []) {
                for (const override of descendant.members) {
                    // The pin handles itself; same-class siblings (Java
                    // arity overloads, TS/Python signature stubs) belong to
                    // the identity-group pass, never the hierarchy walk.
                    if (pinOwnerKey && descendant.ref.key === pinOwnerKey) continue;
                    if (override.file === def.file && override.startLine === def.startLine) continue;
                    const line = override.nameLine || override.startLine;
                    const rel = override.relativePath || override.file;
                    if (lineTaken(override, rel, line)) continue;
                    const edit = renameIdentifierTokens(index, override.file,
                        line, name, options.renameTo,
                        null, null, { definitionNameOnly: true, definition: override });
                    const sourceLine = edit.source;
                    const newExpression = edit.renamed;
                    if (newExpression === sourceLine) continue;
                    changes.push(tagTokenEdit({
                        file: rel,
                        line,
                        expression: sourceLine,
                        suggestion: `Update overriding definition: ${newExpression}`,
                        newExpression,
                        isDefinition: true,
                        editKind: 'definition',
                    }, edit));
                    slotMemberDefs.push(override);
                }
            }
            for (const descendant of hierarchy?.descendants || []) {
                if (pinOwnerKey && descendant.ref.key === pinOwnerKey) continue;
                for (const override of descendant.members) {
                    renameSlotPartners(override, 'Update overriding definition');
                }
            }
            const slotOwners = [
                ...(hierarchy ? [hierarchy.pinRef, ...hierarchy.ancestors.map(a => a.ref),
                    ...hierarchy.descendants.map(d => d.ref)] : []),
            ].filter(ref => ref?.def?.file).map(ref => ({ name: ref.name, file: ref.def.file }));
            // Typed object literals declared against the root or any
            // descendant interface fill the same slot.
            for (const owner of slotOwners) {
                for (const member of typedLiteralMembers(index, name, owner.name, owner.file)) {
                    if (member.file === def.file && member.startLine === def.startLine) continue;
                    const line = member.nameLine || member.startLine;
                    const rel = member.relativePath || member.file;
                    if (lineTaken(member, rel, line)) continue;
                    const edit = renameIdentifierTokens(index, member.file,
                        line, name, options.renameTo,
                        null, null, { definitionNameOnly: true, definition: member });
                    if (edit.renamed === edit.source) continue;
                    changes.push(tagTokenEdit({
                        file: rel,
                        line,
                        expression: edit.source,
                        suggestion: `Update typed object-literal member: ${edit.renamed}`,
                        newExpression: edit.renamed,
                        isDefinition: true,
                        editKind: 'definition',
                    }, edit));
                    slotMemberDefs.push(member);
                }
            }
            // Anonymous subclasses (fix #390): a Java `new Listener() {
            // @Override void run() {} }` or a JS/TS class expression that
            // extends a slot owner overrides the member without being an
            // indexed class.
            for (const site of anonymousSlotMembers(index, name, planGroundSet?.perFile, hierarchy, def)) {
                const rel = require('path').relative(index.root, site.file);
                if (site.verdict === 'review') {
                    if (!changes.some(change => change.file === rel && change.line === site.line)) {
                        changes.push({
                            file: rel,
                            line: site.line,
                            expression: (index._getFileLines(site.file)[site.line - 1] || '').trim(),
                            suggestion: `Verify whether this anonymous class member overrides ${name} and rename it to ${options.renameTo} if it does`,
                            needsReview: true,
                            reviewReason: site.reason,
                            editKind: 'definition',
                        });
                    }
                    continue;
                }
                const existing = changes.find(change => change.file === rel && change.line === site.line);
                const edit = renameIdentifierTokens(index, site.file, site.line, name, options.renameTo,
                    [site.column]);
                if (edit.renamed === edit.source) continue;
                if (existing) {
                    if (existing.newExpression !== undefined && existing._edit) mergeTokenEdit(existing, edit);
                    continue;
                }
                changes.push(tagTokenEdit({
                    file: rel,
                    line: site.line,
                    expression: edit.source,
                    suggestion: `Update anonymous class override: ${edit.renamed}`,
                    newExpression: edit.renamed,
                    isDefinition: true,
                    editKind: 'definition',
                }, edit));
            }
            contractRootDefs.push(...slotAncestors.map(ancestor => ancestor.def));

            // Go interface slots are implicit (fix #302, mux Match): there is
            // no implements edge for the hierarchy walk above. Compute the
            // compiler-shaped satisfaction component from complete project
            // method sets, then rename every declaration in that component.
            // Open method sets (external/qualified embeds, generics, unknown
            // signatures) abstain in goInterfaceRenameClosure — absence is
            // never treated as proof.
            const goInterfaceSlot = planLang === 'go'
                ? goContractClosure(index, def)
                : null;
            if (goInterfaceSlot) goContractReviews.push(...goInterfaceSlot.reviews);
            if (goInterfaceSlot) {
                for (const member of goInterfaceSlot.memberDefs) {
                    if (member.file === def.file && member.startLine === def.startLine) continue;
                    const line = member.nameLine || member.startLine;
                    const rel = member.relativePath || member.file;
                    if (!lineTaken(member, rel, line)) {
                        const edit = renameIdentifierTokens(index, member.file,
                            line, name, options.renameTo,
                            null, null, { definitionNameOnly: true, definition: member });
                        if (edit.renamed !== edit.source) {
                            changes.push(tagTokenEdit({
                                file: rel,
                                line,
                                expression: edit.source,
                                suggestion: `Update Go interface-slot definition: ${edit.renamed}`,
                                newExpression: edit.renamed,
                                isDefinition: true,
                                editKind: 'definition',
                            }, edit));
                        }
                    }
                    slotMemberDefs.push(member);
                }
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
            // Trait identity is the trait DEFINITION (fix #376): impl
            // headers spell generic traits with arguments (`impl<T> Ctx<T>
            // for Option<T>`) and paths (`crate::Ctx`), so a member joins
            // when its impl's trait resolves to the pin's trait definition.
            const traitKey = d => `${d.file}\0${d.startLine}`;
            let pinTraitDefs = [];
            if (def.traitName) {
                pinTraitDefs = rustProjectTraits(index, def.traitName, def.file, def.startLine);
            } else if ((index.symbols.get(def.className) || []).some(d =>
                d.type === 'trait' && d.file === def.file)) {
                pinTraitDefs = (index.symbols.get(def.className) || []).filter(d =>
                    d.type === 'trait' && d.file === def.file &&
                    d.startLine <= def.startLine && (d.endLine || d.startLine) >= def.startLine);
            }
            if (pinTraitDefs.length === 1) {
                const pinTrait = pinTraitDefs[0];
                for (const member of index.symbols.get(name) || []) {
                    if (member.file === def.file && member.startLine === def.startLine) continue;
                    if (NON_CALLABLE_TYPES.has(member.type)) continue;
                    let inSlot = false;
                    if (member.traitName) {
                        const traits = rustProjectTraits(index, member.traitName, member.file,
                            member.startLine);
                        inSlot = traits.length === 1 && traitKey(traits[0]) === traitKey(pinTrait);
                    } else if (member.className === pinTrait.name && member.file === pinTrait.file &&
                        member.startLine >= pinTrait.startLine &&
                        member.startLine <= (pinTrait.endLine || pinTrait.startLine)) {
                        inSlot = true; // the trait's own declaration member
                    }
                    if (!inSlot) continue;
                    const line = member.nameLine || member.startLine;
                    const rel = member.relativePath || member.file;
                    if (!lineTaken(member, rel, line)) {
                        const edit = renameIdentifierTokens(index, member.file,
                            line, name, options.renameTo,
                            null, null, { definitionNameOnly: true, definition: member });
                        if (edit.renamed !== edit.source) {
                            changes.push(tagTokenEdit({
                                file: rel,
                                line,
                                expression: edit.source,
                                suggestion: `Update trait-slot definition: ${edit.renamed}`,
                                newExpression: edit.renamed,
                                isDefinition: true,
                                editKind: 'definition',
                            }, edit));
                        }
                    }
                    slotMemberDefs.push(member);
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
            const siteTokenKey = site =>
                `${site.file}:${site.line}:${Number.isInteger(site.column) ? site.column : '*'}`;
            const seenSiteTokens = new Set(planCallSites.map(site => siteTokenKey(site)));
            const slotMemberSites = [];
            // Members a macro generated (fix #374) are swept after, and
            // capped apart from, the written ones: a macro instantiated for
            // many types must not crowd written members out of the sweep.
            const writtenMembers = slotMemberDefs.filter(member => !member.macroExpansion);
            const generatedMembers = slotMemberDefs.filter(member => member.macroExpansion);
            const sweptMembers = [...writtenMembers.slice(0, SLOT_SWEEP_CAP),
                ...generatedMembers.slice(0, SLOT_SWEEP_CAP)];
            for (const memberDef of sweptMembers) {
                const memberSweep = computePlanCallSites(index, name, memberDef, { analyzeArgs: !options.renameTo });
                for (const site of memberSweep.sites) {
                    const key = siteTokenKey(site);
                    if (seenSiteTokens.has(key)) continue;
                    seenSiteTokens.add(key);
                    slotMemberSites.push(site);
                }
                // A call through a joined Go interface receiver is bound to
                // this exact METHOD SLOT even though runtime dispatch cannot
                // select one concrete body. Promote it for rename purposes
                // only; caller/context evidence stays honestly unverified.
                for (const raw of memberSweep.rawUnverified || []) {
                    const exactInterfaceReceiver = goInterfaceSlot &&
                        raw.reason === 'possible-dispatch' &&
                        goInterfaceSlot.interfaceNames.has(
                            String(raw.dispatchVia || '').split('.').pop());
                    const closedAmbiguity = goSlotCoversMethodAmbiguity(
                        index, name, goInterfaceSlot, raw);
                    if ((!exactInterfaceReceiver && !closedAmbiguity) ||
                        raw.externalContract) continue;
                    const relativePath = raw.relativePath ||
                        index.files.get(raw.file)?.relativePath || raw.file;
                    const key = siteTokenKey({
                        file: relativePath, line: raw.line, column: raw.column,
                    });
                    if (seenSiteTokens.has(key)) continue;
                    let content = raw.content || '';
                    if (!content && raw.file) {
                        try { content = index._getFileLines(raw.file)[raw.line - 1] || ''; }
                        catch { /* unreadable is already disclosed by the account */ }
                    }
                    const analysis = analyzeCallSite(index, {
                        file: raw.file,
                        relativePath,
                        line: raw.line,
                        content,
                        usageType: 'call',
                        receiver: raw.receiver,
                    }, name, 0);
                    seenSiteTokens.add(key);
                    slotMemberSites.push({
                        file: relativePath,
                        absoluteFile: raw.file,
                        line: raw.line,
                        ...(Number.isInteger(raw.column) && { column: raw.column }),
                        expression: content.trim(),
                        args: analysis.args,
                        argCount: analysis.argCount,
                        ...(raw.calledAs && { calledAs: raw.calledAs }),
                    });
                }
                for (const site of memberSweep.unverifiedSites) {
                    if (planUnverified.some(existing =>
                        existing.file === site.file &&
                        existing.line === site.line)) continue;
                    planUnverified.push({
                        ...site,
                        slotMember: memberDef.className,
                    });
                }
            }
            if (writtenMembers.length > SLOT_SWEEP_CAP || generatedMembers.length > SLOT_SWEEP_CAP) {
                resolved.warnings.push({
                    message: `Dispatch slot has ${slotMemberDefs.length} member ` +
                        `definitions; call sites were swept for the first ` +
                        `${SLOT_SWEEP_CAP}${generatedMembers.length > 0
                            ? ' written and first ' + SLOT_SWEEP_CAP + ' macro-generated' : ''} — review the rest manually.`,
                });
            }
            emitRenameCallSites(slotMemberSites);
            slotAccountSites.push(...slotMemberSites);
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
                if (lineTaken(sibling, rel, line)) continue;
                const edit = renameIdentifierTokens(index, sibling.file,
                    line, name, options.renameTo,
                    null, null, { definitionNameOnly: true, definition: sibling });
                if (edit.renamed === edit.source) continue;
                changes.push(tagTokenEdit({
                    file: rel,
                    line,
                    expression: edit.source,
                    suggestion: `Update paired declaration: ${edit.renamed}`,
                    newExpression: edit.renamed,
                    isDefinition: true,
                    editKind: 'definition',
                }, edit));
            }
        }

        // Macro templates (fix #360, bytes-measured): identifiers inside a
        // macro_rules! transcriber bind at every expansion site, so the
        // AST never shows them as definitions or calls of the pin - and a
        // rename that leaves them behind breaks every expansion. Each token
        // spelling the name is classified by its token shape; a site is
        // edited only when its identity is proven from the pin:
        //   `fn NAME` whose every owner (an `impl Trait for ..` header inside
        //     the template, or the impl blocks that invoke the macro) is the
        //     pin's own trait slot;
        //   `.NAME(` / `Self::NAME(` forwarding inside such a template fn;
        //   `NAME(` for a free-function pin whose binding reaches the pin in
        //     the macro's file.
        // Every other token that can denote the pin is listed for review,
        // never omitted; tokens that provably denote another item (a `fn`
        // under a different trait, a dot-call against a free function) are
        // skipped.
        // A renamed TYPE's template tokens are decided by the type-reference
        // pass (fix #386).
        if (langTraits(planLang)?.macroTemplateBodies && planGroundSet?.perFile && !isTypeRenamePin(def)) {
            const pinTraitDefs = def.traitName
                ? rustProjectTraits(index, def.traitName, def.file, def.startLine)
                : (def.className ? (index.symbols.get(def.className) || []).filter(d =>
                    d.type === 'trait' && d.file === def.file) : []);
            const pinTraitKeys = new Set(pinTraitDefs.map(d => `${d.file}\0${d.startLine}`));
            const ownerIsPinTrait = (owner, macroFile) => owner.kind === 'impl' && owner.trait &&
                rustProjectTraits(index, owner.trait, macroFile)
                    .some(d => pinTraitKeys.has(`${d.file}\0${d.startLine}`));
            // Files that can hold template tokens of this name: a ground
            // line inside an indexed macro definition's range. The AST pass
            // decides every token; this only avoids parsing other files.
            const templateFiles = [...planGroundSet.perFile.entries()].filter(([file, lineNos]) => {
                const entry = index.files.get(file);
                if (entry?.language !== planLang) return false;
                const macros = (entry.symbols || []).filter(symbol => symbol.type === 'macro');
                return macros.length > 0 && [...lineNos].some(lineNo => macros.some(macro =>
                    macro.startLine <= lineNo && (macro.endLine || macro.startLine) >= lineNo));
            }).map(([file]) => file);
            const sites = rustMacroTemplateSites(index, name, templateFiles);
            const decisions = new Map(); // site -> 'edit' | 'review' | 'skip'
            const editedTemplateFns = new Set(); // file\0macro
            for (const site of sites.filter(item => item.shape === 'definition')) {
                let decision;
                if (pinTraitKeys.size > 0) {
                    const matches = site.owners.filter(owner => ownerIsPinTrait(owner, site.file));
                    if (site.owners.length > 0 && matches.length === site.owners.length) decision = 'edit';
                    else if (matches.length === 0 && site.owners.length > 0 &&
                        site.owners.every(owner => owner.kind === 'impl' && owner.trait)) decision = 'skip';
                    else decision = 'review';
                } else if (def.className) {
                    decision = site.owners.length > 0 && site.owners.every(owner =>
                        owner.kind === 'impl' && owner.trait) ? 'skip' : 'review';
                } else {
                    decision = site.owners.length > 0 && site.owners.every(owner =>
                        owner.kind === 'impl') ? 'skip' : 'review';
                }
                decisions.set(site, decision);
                if (decision === 'edit') editedTemplateFns.add(`${site.file}\0${site.macroName}`);
            }
            for (const site of sites.filter(item => item.shape !== 'definition')) {
                let decision = 'review';
                const forwarding = site.enclosingFn === name &&
                    editedTemplateFns.has(`${site.file}\0${site.macroName}`);
                if (site.shape === 'method-call') {
                    decision = !def.className ? 'skip' : forwarding ? 'edit' : 'review';
                } else if (site.shape === 'path-call') {
                    decision = forwarding && site.pathQualifier === 'Self' ? 'edit' : 'review';
                } else if (site.shape === 'call') {
                    if (def.className) decision = 'skip'; // bare calls never denote methods
                    else {
                        decision = _nameBindingReaches(index, site.file, name, renameTargetFiles) === 'yes'
                            ? 'edit' : 'review';
                    }
                }
                decisions.set(site, decision);
            }
            const editsByLine = new Map();
            const unverifiedTemplateLines = new Set(planUnverified.map(site =>
                `${site.file}:${site.line}`));
            for (const [site, decision] of decisions) {
                if (decision === 'skip') continue;
                const key = `${site.file}\0${site.line}`;
                if (decision === 'edit') {
                    if (!editsByLine.has(key)) editsByLine.set(key, { site, columns: [], definition: false });
                    const entry = editsByLine.get(key);
                    entry.columns.push(site.column);
                    if (site.shape === 'definition') entry.definition = true;
                    continue;
                }
                if (unverifiedTemplateLines.has(`${site.relativePath}:${site.line}`)) continue;
                if (reviewItems.some(item => item.file === site.relativePath &&
                    item.line === site.line && item.templateDependency)) continue;
                reviewItems.push({
                    file: site.relativePath,
                    line: site.line,
                    expression: (index.getLineContent(site.file, site.line) || '').trim(),
                    suggestion: `Macro ${site.macroName || 'template'} spells "${name}" as a ` +
                        `${site.shape.replace('-', ' ')} token; it binds at each expansion - ` +
                        'rename it with the pin if the expansions reach it',
                    needsReview: true,
                    templateDependency: true,
                    reviewReason: 'macro-template',
                    editKind: 'macro-template',
                });
            }
            for (const { site, columns, definition } of editsByLine.values()) {
                if (changes.some(change => change.file === site.relativePath &&
                    change.line === site.line)) continue;
                const edit = renameIdentifierTokens(index, site.file, site.line, name,
                    options.renameTo, columns.sort((a, b) => a - b));
                if (edit.renamed === edit.source) continue;
                changes.push(tagTokenEdit({
                    file: site.relativePath,
                    line: site.line,
                    expression: edit.source,
                    suggestion: `Update macro template ${site.macroName || ''}: ${edit.renamed}`.replace('  ', ' '),
                    newExpression: edit.renamed,
                    ...(definition && { isDefinition: true }),
                    editKind: definition ? 'definition' : 'call',
                }, edit));
            }
            if (editsByLine.size > 0) {
                const changedLines = new Set(changes.map(change => `${change.file}:${change.line}`));
                const kept = planUnverified.filter(site => !changedLines.has(`${site.file}:${site.line}`));
                planUnverified.length = 0;
                planUnverified.push(...kept);
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
            // A prototype and its definition (C/C++ forward declarations,
            // overload signatures) are one callable (fix #396): each binds
            // the name as the pin.
            const pinIdentity = new Set(require('./callers')._closeCallableIdentityGroup(
                index, [def], definitions));
            const binders = definitions
                .filter(candidate => candidate.file === def.file &&
                    !NON_CALLABLE_TYPES.has(candidate.type))
                .map(candidate => ({
                    def: pinIdentity.has(candidate) ? def : candidate,
                    container: containerOf(candidate),
                }));
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
            const methodGroupPin = !!langTraits(planLang)?.methodGroupReferences &&
                (def.type === 'method' || def.memberType === 'method' || !!def.isMethod);
            // Where each bare reference resolves (fix #392): the parser
            // records the language's own lexical scoping on the usage
            // (`scopeBinding`), so a reference inside a function body or on a
            // decorator line is decided instead of reviewed. The pin must be
            // declared at file scope for a file-scope resolution to reach it
            // (a Rust inline module is its own scope).
            const pinNameLine = def.nameLine || def.startLine;
            const pinAtFileScope = !pinContainer && !fileSymbols.some(symbol =>
                symbol.type === 'module' && symbol !== def &&
                symbol.startLine <= pinNameLine &&
                (symbol.endLine || symbol.startLine) >= pinNameLine &&
                !(symbol.startLine === def.startLine && symbol.name === def.name));
            const fileScopeBinders = binders.filter(binder => !binder.container);
            const pinIsFileBinding = pinAtFileScope && fileScopeBinders.length >= 1 &&
                fileScopeBinders.every(binder => binder.def === def);
            // One record's verdict: 'edit', 'review' or null (not the pin).
            const verdictFor = (ref) => {
                // A C++ qualified reference (`template auto ns::f(float)
                // -> R;`, `&Cls::m`, fix #393) names what its qualifier
                // resolves to from the reference's own scope.
                if (ref.receiver && index.files.get(ref.file)?.language === 'cpp') {
                    return cppQualifiedReferenceVerdict(index, ref, def);
                }
                // A function declared in a function body (a C# local
                // function, a nested def) is in scope only in its block:
                // never from another file, and never as the member of an
                // object (`profile.Items`, fix #395).
                if (pinContainer && !def.className && (ref.file !== def.file || ref.receiver)) return null;
                // A property of an object (an object-literal member, `obj.f =
                // fn`) is reached through a receiver, never as a bare
                // binding: member accesses are decided by the call-site and
                // accessor passes (fix #397).
                if (ref.receiver && def.memberAssigned && !def.className) return null;
                if (ref.file === def.file) {
                    // C# method groups are decided by the language's lookup
                    // in their own pass (fix #395).
                    if (def.className && methodGroupPin) return null;
                    if (def.className) {
                        const lineText = ref.content ||
                            index.getLineContent(def.file, ref.line) || '';
                        // `this` names the innermost enclosing class (fix
                        // #390: `this.size = size` in a nested class's
                        // constructor is its own field), and where fields
                        // and methods are separate namespaces a paren-less
                        // `this.m` is never the method (Java, Rust).
                        const innermostClass = fileSymbols.filter(symbol =>
                            classKinds.has(symbol.type) && symbol.startLine <= ref.line &&
                            (symbol.endLine || symbol.startLine) >= ref.line)
                            .sort((a, b) => ((a.endLine || a.startLine) - a.startLine) -
                                ((b.endLine || b.startLine) - b.startLine))[0] || null;
                        if (pinClassRange && innermostClass === pinClassRange &&
                            !langTraits(planLang)?.fieldsAndMethodsSeparate &&
                            selfReceived.test(lineText)) {
                            return 'edit';
                        }
                        return null;
                    }
                    if (!ref.receiver && ref.scopeBinding === 'module') {
                        // Resolves at file scope: the pin when it is the
                        // file's only binding of the name there (a nested pin
                        // is not visible there).
                        if (pinIsFileBinding) return 'edit';
                        if (!pinAtFileScope) return null;
                    } else if (!ref.receiver && ref.scopeBinding === 'local') {
                        // An enclosing function or block binds the name: the
                        // pin only when that binding is the pin's own def.
                        return Array.isArray(ref.scopeDefLines) &&
                            ref.scopeDefLines.includes(pinNameLine) ? 'edit' : null;
                    }
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
                        if (pinContainer) return 'edit'; // nested pin binds its container
                        if (!insideFunctionLike(def.file, ref.line)) return 'edit'; // module-scope row
                        return 'review'; // possible local shadow
                    }
                    return null;
                }
                if (def.className) return null;
                // Module-attribute references carry stronger evidence
                // than a bare name: `import requests; requests.put` binds
                // through requests' export chain even inside a function.
                // Parser-side local-shadow evidence is a hard guard — a
                // parameter/assignment named requests defeats the import.
                const moduleOwnership = ref.receiver &&
                    !ref.receiverLocalBinding
                    ? _moduleAttributeBindingReaches(
                        index, ref.file, ref.receiver, name,
                        renameTargetFiles)
                    : null;
                if (moduleOwnership === 'yes') return 'edit';
                if (moduleOwnership === 'unknown') return 'review';
                if (ref.receiver) return null;
                // A local binding of the name is never the pin (fix #392); a
                // file-scope resolution follows the file's binding of the name.
                if (ref.scopeBinding === 'local') return null;
                // C (fix #396): a file-scope reference names the file's own
                // function of that name, else the external-linkage function
                // its translation unit links, as a call does.
                if (ref.scopeBinding === 'module' && cExternalReferenceLanguage(index, ref.file)) {
                    return cExternalReferenceVerdict(index, ref, def, pinIdentity, definitions);
                }
                const ownership = _nameBindingReaches(
                    index, ref.file, name, renameTargetFiles);
                if (ownership === 'yes' &&
                    (ref.scopeBinding === 'module' ||
                        !insideFunctionLike(ref.file, ref.line))) {
                    return 'edit';
                }
                return ownership !== 'no' ? 'review' : null;
            };
            const eligible = (ref) => {
                if (ref.usageType !== 'reference' || ref.isDefinition) return false;
                // Keyword-argument names, object keys and struct field keys
                // are not references to a non-member binding (a member pin
                // reads its receiver tokens from the line below).
                if (!def.className && !ref.receiver && ref.scopeBinding === 'none') return false;
                // An attribute path or derive entry names a macro (fix #377):
                // never a reference to a same-named fn or value.
                if (ref.namespace === 'macro' && !isMacroNamespaceDefinition(def)) return false;
                return true;
            };
            for (const first of usages) {
                if (first.usageType !== 'reference' || first.isDefinition) continue;
                // Every record of the line is decided (fix #392): two
                // references on one line are two tokens.
                const records = [first, ...(first.sameLine || [])].filter(eligible);
                if (records.length === 0) continue;
                const ref = records[0];
                const rel = ref.relativePath || ref.file;
                if (unverifiedLines.has(`${rel}:${ref.line}`)) continue;
                const existing = changes.find(change =>
                    change.file === rel && change.line === ref.line);
                const verdicts = records.map(verdictFor);
                let verdict = verdicts.includes('review') ? 'review'
                    : verdicts.includes('edit') ? 'edit' : null;
                if (!verdict) continue;
                // A same-file member pin is referenced through its receiver
                // (fix #376): edit exactly the `this.NAME` / `self.NAME`
                // member tokens on the line (both in `this.m =
                // this.m.bind(this)`), never an object-literal key or other
                // same-spelled property (`{ m: this.m }` keeps its key).
                let refColumns = records.filter((record, i) => verdicts[i] === 'edit')
                    .map(record => record.column);
                if (!refColumns.every(Number.isInteger)) refColumns = null;
                if (verdict === 'edit' && ref.file === def.file && def.className) {
                    const selfColumns = selfMemberTokenColumns(index, def.file, ref.line, name);
                    if (selfColumns.length === 0) verdict = 'review';
                    else refColumns = selfColumns;
                }
                // An object-literal shorthand `{ name }` keeps its key (fix
                // #397, immer-measured: `{ applyPatches_ }` passed where a
                // Plugin object is expected): the value is spelled out,
                // `{ name: renamed }`.
                const shorthandEdits = verdict === 'edit' ? records.filter((record, i) =>
                    verdicts[i] === 'edit' && record.shorthandProperty) : [];
                if (shorthandEdits.length > 0) {
                    const mixed = shorthandEdits.length !== records.filter((record, i) =>
                        verdicts[i] === 'edit').length;
                    if (existing || mixed || !refColumns) {
                        if (!existing?.needsReview) {
                            reviewItems.push({
                                file: rel,
                                line: ref.line,
                                expression: (ref.content || '').trim(),
                                suggestion: `Shorthand property "${name}" names the renamed binding: ` +
                                    `write it as "${name}: ${options.renameTo}" (the key stays)`,
                                needsReview: true,
                                editKind: 'reference',
                            });
                        }
                        continue;
                    }
                    const edit = renameIdentifierTokens(index, ref.file, ref.line, name,
                        `${name}: ${options.renameTo}`, refColumns);
                    if (edit.renamed === edit.source) continue;
                    changes.push(tagTokenEdit({
                        file: rel,
                        line: ref.line,
                        expression: edit.source,
                        suggestion: `Update reference: ${edit.renamed}`,
                        newExpression: edit.renamed,
                        editKind: 'reference',
                    }, edit));
                    continue;
                }
                if (existing) {
                    // A line another pass already edits (a call beside the
                    // reference) gains the reference tokens.
                    // A member pin's own `this.m` tokens join a bound call's
                    // edit on the line (`this.m = this.m.bind(this)`, fix #397).
                    if (verdict === 'edit' && (!def.className || ref.file === def.file) &&
                        existing.newExpression !== undefined &&
                        !existing.needsReview && refColumns) {
                        const edit = renameIdentifierTokens(index, ref.file,
                            ref.line, name, options.renameTo, refColumns);
                        mergeTokenEdit(existing, edit);
                    }
                    continue;
                }
                if (verdict === 'edit') {
                    const edit = renameIdentifierTokens(index, ref.file,
                        ref.line, name, options.renameTo, refColumns);
                    if (edit.renamed === edit.source) continue;
                    changes.push(tagTokenEdit({
                        file: rel,
                        line: ref.line,
                        expression: edit.source,
                        suggestion: `Update reference: ${edit.renamed}`,
                        newExpression: edit.renamed,
                        editKind: 'reference',
                    }, edit));
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

        // Property/getter/setter renames must cover their normal consumption
        // form: attribute reads and writes. Reuse impact's receiver-evidence
        // query so a typed field is edited mechanically and an unresolved
        // receiver is surfaced for review instead of silently omitted.
        const accessorReferences = findAccessorReferences(index, name, def, {
            includeTests: true,
        });
        if (accessorReferences) {
            const confirmedByLine = new Map();
            for (const ref of accessorReferences.confirmed) {
                const key = `${ref.absoluteFile}\0${ref.line}`;
                if (!confirmedByLine.has(key)) confirmedByLine.set(key, []);
                confirmedByLine.get(key).push(ref);
            }
            for (const refs of confirmedByLine.values()) {
                const ref = refs[0];
                const columns = refs.map(item => item.column)
                    .filter(Number.isInteger);
                // A shorthand destructuring key (`const { body } = this`)
                // reads the property into a local of the same name: the key
                // is renamed and the local kept (`{ bodyZ: body }`, fix #397).
                const shorthandKeys = refs.filter(item => item.patternKey?.shorthand);
                if (shorthandKeys.length > 0 && (shorthandKeys.length !== refs.length ||
                    columns.length !== refs.length)) {
                    changes.push({
                        file: ref.file,
                        line: ref.line,
                        expression: ref.expression,
                        suggestion: `Rename the destructured property "${name}" to "${options.renameTo}" ` +
                            'manually, keeping the local binding',
                        needsReview: true,
                        editKind: 'reference',
                    });
                    continue;
                }
                const edit = renameIdentifierTokens(index, ref.absoluteFile,
                    ref.line, name, shorthandKeys.length > 0
                        ? `${options.renameTo}: ${name}` : options.renameTo,
                    columns.length === refs.length ? columns : null);
                if (edit.renamed === edit.source) continue;
                const concrete = {
                    file: ref.file,
                    line: ref.line,
                    expression: edit.source,
                    suggestion: `Update property access: ${edit.renamed}`,
                    newExpression: edit.renamed,
                    editKind: 'reference',
                };
                const existing = changes.find(change =>
                    change.file === ref.file && change.line === ref.line &&
                    !change.needsReview);
                if (existing) Object.assign(existing, concrete);
                else changes.push(concrete);
            }
            const listedAccess = new Set();
            for (const ref of accessorReferences.unverified) {
                const lineKey = `${ref.file}:${ref.line}`;
                if (listedAccess.has(lineKey)) continue;
                listedAccess.add(lineKey);
                changes.push({
                    file: ref.file,
                    line: ref.line,
                    expression: ref.expression,
                    suggestion: `Verify this property access resolves to ${name} on ` +
                        `${accessorReferences.owner} before renaming`,
                    needsReview: true,
                    editKind: 'reference',
                });
            }
        }

        // String/comment occurrences in indexed source can encode guards,
        // reflection keys, protocol names, snapshots, or documentation. AST
        // identifier replacement must never rewrite them automatically, but a
        // complete plan must list them as explicit review work.
        for (const textRef of usages.filter(usage => usage.usageType === 'text')) {
            const rel = textRef.relativePath || textRef.file;
            if (reviewItems.some(item =>
                item.file === rel && item.line === textRef.line)) continue;
            reviewItems.push({
                file: rel,
                line: textRef.line,
                expression: (textRef.content || '').trim(),
                suggestion: `Review comment/string dependency on "${name}"; ` +
                    'rename manually only if its contract changes',
                needsReview: true,
                textDependency: true,
                editKind: 'text-reference',
            });
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
    // A definition a macro_rules! transcriber generated (fix #374) is
    // spelled in the macro's template, never at the invocation: the
    // template pass below edits or lists it; the invocation line is only
    // pointed at for review.
    if (def.macroExpansion?.origin === 'template') {
        reviewItems.push({
            file: definitionFile,
            line: definitionLine,
            expression: definitionSource,
            suggestion: `Generated by macro ${def.macroExpansion.macro} (${def.macroExpansion.definition}); ` +
                'the declaration is written in the macro template',
            needsReview: true,
            templateDependency: true,
            editKind: 'macro-generated-definition',
        });
    } else if (existingDefinitionLine) {
        existingDefinitionLine.isDefinition = true;
        existingDefinitionLine.editKind = 'definition';
        if (options.renameTo) {
            const defEdit = renameIdentifierTokens(index, def.file,
                definitionLine, name, options.renameTo,
                null, null, { definitionNameOnly: true, definition: def });
            // Keep the tokens the line's other edit renames (a recursive or
            // delegating call on the declaration line) (fix #376).
            if (!(existingDefinitionLine.newExpression !== undefined &&
                mergeTokenEdit(existingDefinitionLine, defEdit))) {
                existingDefinitionLine.newExpression = defEdit.renamed;
                tagTokenEdit(existingDefinitionLine, defEdit);
            }
            existingDefinitionLine.suggestion = `Update definition: ${existingDefinitionLine.newExpression}`;
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
            const defEdit = renameIdentifierTokens(index, def.file,
                definitionLine, name, options.renameTo,
                null, null, { definitionNameOnly: true, definition: def });
            const renamed = defEdit.renamed;
            definitionChange.newExpression = renamed;
            definitionChange.suggestion = `Update definition: ${renamed}`;
            tagTokenEdit(definitionChange, defEdit);
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

    // Members a macro invocation declares (fix #385: `ERROR_DEF(Base, Name)`
    // in the class body expands to Name's constructors) are spelled by the
    // invocation's argument: renaming the class renames that token too, or
    // the expansion declares members of the old name.
    if (options.renameTo && ['class', 'struct', 'union'].includes(def.type) &&
        langTraits(planLang)?.textualIncludes) {
        const invocationLines = new Set();
        for (const member of index.files.get(def.file)?.symbols || []) {
            if (!member.generatedByMacro || member.className !== def.name || member.name !== name ||
                member.startLine < def.startLine || member.endLine > def.endLine) continue;
            invocationLines.add(member.startLine);
        }
        for (const line of [...invocationLines].sort((a, b) => a - b)) {
            if (changes.some(change => change.file === definitionFile && change.line === line)) continue;
            const edit = renameIdentifierTokens(index, def.file, line, name, options.renameTo);
            if (edit.renamed === edit.source) continue;
            changes.push(markEvidence(tagTokenEdit({
                file: definitionFile,
                line,
                expression: edit.source,
                suggestion: `Rename the macro argument that declares members of ${name}: ${edit.renamed}`,
                newExpression: edit.renamed,
                editKind: 'reference',
            }, edit)));
        }
    }

    // C++ using-declarations that name the renamed entity (fix #385, the
    // spdlog rename harness's silent breaks: `using details::os::
    // filename_to_str;` before bare calls the plan already edits). The
    // written qualifier resolves from the declaration's enclosing
    // namespaces (macro-opened ones included); one that names the pin's
    // namespace (or its class, for `using Base::m;`) is edited, one that
    // only ends like it is listed for review.
    if (options.renameTo && langTraits(planLang)?.textualIncludes) {
        const { effectiveNamespace } = require('./cpp-scope');
        const pinNamespace = def.className ? null : effectiveNamespace(index, def);
        for (const [file, entry] of index.files) {
            for (const fact of entry.cppUsings || []) {
                if (fact.kind !== 'declaration' || fact.name !== name) continue;
                const rel = entry.relativePath;
                if (changes.some(change => change.file === rel && change.line === fact.line)) continue;
                const absolute = fact.target.startsWith('::');
                const qualifier = fact.target.replace(/^::/, '').split('::').slice(0, -1).join('::');
                let exact = false;
                let near = false;
                if (def.className) {
                    const owner = qualifier.split('::').pop();
                    exact = owner === def.className;
                } else {
                    const site = effectiveNamespace(index, { file, startLine: fact.line, namespace: fact.namespace });
                    const scopes = [];
                    if (!absolute) {
                        const parts = site ? site.split('::') : [];
                        for (let i = parts.length; i > 0; i--) scopes.push(parts.slice(0, i).join('::'));
                    }
                    scopes.push('');
                    exact = scopes.some(scope => (scope && qualifier ? `${scope}::${qualifier}` : scope || qualifier) === pinNamespace);
                    near = !exact && (pinNamespace === qualifier || pinNamespace.endsWith(`::${qualifier}`));
                }
                if (!exact && !near) continue;
                const edit = renameIdentifierTokens(index, file, fact.line, name, options.renameTo);
                if (exact && edit.renamed !== edit.source) {
                    changes.push(markEvidence(tagTokenEdit({
                        file: rel,
                        line: fact.line,
                        expression: edit.source,
                        suggestion: `Rename the using-declaration: ${edit.renamed}`,
                        newExpression: edit.renamed,
                        editKind: 'reference',
                    }, edit)));
                } else {
                    reviewItems.push({
                        file: rel,
                        line: fact.line,
                        expression: index.getLineContent(file, fact.line).trim(),
                        suggestion: `A using-declaration names "${name}" through a qualifier UCN cannot resolve to the renamed declaration; rename it with the declaration if it names it`,
                        needsReview: true,
                        editKind: 'reference',
                    });
                }
            }
        }
    }

    // Every token that names a renamed TYPE (fix #386): base clauses,
    // field/parameter/return/local and generic-argument types, casts and
    // type tests, static member qualifiers, constructor and destructor
    // names, member initializers, qualified spellings and imports. Tokens
    // are resolved by the language's own name lookup; a token UCN cannot
    // resolve to exactly the renamed declaration is a review item.
    let typePass = null;
    const fileRenames = [];
    if (options.renameTo && isTypeRenamePin(def) && planGroundSet &&
        !def.macroExpansion) {
        typePass = applyTypeReferencePass(index, {
            def, name, renameTo: options.renameTo, changes, reviewItems,
            planUnverified, groundSet: planGroundSet,
        });
        // javac requires a public top-level type in a file named after it:
        // the file is renamed with the type.
        const pathMod = require('path');
        const extension = pathMod.extname(def.file);
        if (langTraits(planLang)?.typeNamedSourceFile && !def.enclosingType && !def.isNested &&
            pathMod.basename(def.file, extension) === name) {
            const from = def.relativePath || pathMod.relative(index.root, def.file);
            fileRenames.push({
                from,
                to: pathMod.join(pathMod.dirname(from), `${options.renameTo}${extension}`),
            });
        }
    }

    // Token pasting can spell the renamed name without writing it (fix
    // #396: `struct sdshdr##T` in SDS_HDR_VAR, invoked as SDS_HDR_VAR(8, s)):
    // the pasting macro and each invocation that produces the name are
    // review items; nothing there spells the name to edit.
    if (options.renameTo && langTraits(planLang)?.macroInvocationSyntax === 'call' && !def.macroExpansion) {
        const { pastedNameSites } = require('./macro-expansion');
        const pasted = pastedNameSites(index, name);
        const taken = new Set([...changes, ...reviewItems].map(change => `${change.file}:${change.line}`));
        const push = (file, line, suggestion) => {
            const rel = path.relative(index.root, file);
            if (taken.has(`${rel}:${line}`)) return;
            taken.add(`${rel}:${line}`);
            reviewItems.push({
                file: rel,
                line,
                expression: (index.getLineContent(file, line) || '').trim(),
                suggestion,
                needsReview: true,
                templateDependency: true,
                reviewReason: 'macro-paste',
                editKind: 'macro-expansion',
            });
        };
        // A paste of parameters only (`a ## b`) can spell any name: its
        // invocations decide, not its definition.
        for (const macro of pasted.macros.filter(item =>
            item.chains.some(chain => chain.some(op => op.literal != null)))) {
            push(macro.symbol.file, macro.symbol.startLine,
                `Macro ${macro.symbol.name} pastes \`${macro.spelling}\`, which can spell "${name}" at its ` +
                'invocations; review the macro and its invocations');
        }
        for (const site of pasted.sites) {
            push(site.file, site.line,
                `Macro ${site.macro} pastes "${name}" at this invocation; change the macro arguments or ` +
                `definition so the expansion spells "${options.renameTo}"`);
        }
    }

    // A call site excluded inside a region the parser could not read (fix
    // #396: a decoration macro defined in another header broke the member
    // around it) was decided from a partial tree: listed for review, never
    // dropped silently.
    if (options.renameTo && planAccountParts?.excludedEntries?.length > 0) {
        const taken = new Set([...changes, ...reviewItems].map(change => `${change.file}:${change.line}`));
        const seen = new Set();
        for (const entry of planAccountParts.excludedEntries) {
            const regions = index.files.get(entry.file)?.parseErrorRegions;
            if (!Array.isArray(regions) || !regions.some(([start, end]) => start <= entry.line && entry.line <= end)) continue;
            const rel = path.relative(index.root, entry.file);
            const key = `${rel}:${entry.line}`;
            if (taken.has(key) || seen.has(key)) continue;
            seen.add(key);
            reviewItems.push({
                file: rel,
                line: entry.line,
                expression: (index.getLineContent(entry.file, entry.line) || '').trim(),
                suggestion: `This line sits in a region the parser could not fully read, where the call was ` +
                    `excluded (${entry.reason}) from a partial tree; rename it too if it names this "${name}"`,
                needsReview: true,
                reviewReason: 'parse-recovery',
                editKind: 'call',
            });
        }
    }

    // Documentation references the compiler resolves (fix #390): C# `cref`
    // attributes naming the renamed member are edited (CS1574 fails the
    // build once the member is gone); ones the lookup cannot settle are
    // listed for review, not left as comment text.
    if (options.renameTo && langTraits(planLang)?.docCrefReferences) {
        const renamedDefs = [];
        const sameNameDefs = index.symbols.get(name) || [];
        for (const change of changes) {
            if (change.editKind !== 'definition' || change.newExpression === undefined) continue;
            for (const candidate of sameNameDefs) {
                if ((candidate.relativePath || candidate.file) === change.file &&
                    (candidate.nameLine || candidate.startLine) === change.line &&
                    !renamedDefs.includes(candidate)) renamedDefs.push(candidate);
            }
        }
        if (!renamedDefs.includes(def)) renamedDefs.push(def);
        _docCrefMemberPass(index, name, options.renameTo, renamedDefs, changes, reviewItems);
    }

    // Method groups (fix #395): C# simple names and `this.`/`base.`/type
    // accesses in value position that the language's lookup resolves to the
    // renamed method (delegates, events, LINQ arguments, `nameof`).
    if (options.renameTo && def.className && langTraits(planLang)?.methodGroupReferences &&
        (def.type === 'method' || def.memberType === 'method' || def.isMethod)) {
        const renamedDefs = [];
        const sameNameDefs = index.symbols.get(name) || [];
        for (const change of changes) {
            if (change.editKind !== 'definition' || change.newExpression === undefined) continue;
            for (const candidate of sameNameDefs) {
                if ((candidate.relativePath || candidate.file) === change.file &&
                    (candidate.nameLine || candidate.startLine) === change.line &&
                    !renamedDefs.includes(candidate)) renamedDefs.push(candidate);
            }
        }
        if (!renamedDefs.includes(def)) renamedDefs.push(def);
        _methodGroupPass(index, name, options.renameTo, renamedDefs, changes,
            planUsages || index.usages(name, { codeOnly: false, includeTests: true, internalEvidence: true }));
    }

    // Test functions the toolchain binds to a renamed declaration by NAME
    // (fix #383): Go examples `Example<Type>_<Method>` fail go vet once the
    // method is renamed alone. They are renamed with it (their definition
    // token), or listed for review when the binding is ambiguous.
    if (options.renameTo && langTraits(planLang)?.nameBoundTestFunctions) {
        const renamedDefs = [];
        const sameNameDefs = index.symbols.get(name) || [];
        for (const change of changes) {
            if (change.editKind !== 'definition' || change.newExpression === undefined) continue;
            for (const candidate of sameNameDefs) {
                if ((candidate.relativePath || candidate.file) === change.file &&
                    (candidate.nameLine || candidate.startLine) === change.line &&
                    !renamedDefs.includes(candidate)) renamedDefs.push(candidate);
            }
        }
        const { nameBoundTestFunctions } = require('./test-name-bindings');
        for (const bound of nameBoundTestFunctions(index, renamedDefs, name, options.renameTo)) {
            const example = bound.def;
            const rel = example.relativePath || example.file;
            const line = example.nameLine || example.startLine;
            if (changes.some(change => change.file === rel && change.line === line)) continue;
            const edit = renameIdentifierTokens(index, example.file, line, example.name, bound.newName,
                null, null, { definitionNameOnly: true, definition: example });
            const reason = bound.binding === 'member'
                ? `go vet binds ${example.name} to the renamed member`
                : `go vet binds ${example.name} to the renamed identifier`;
            if (bound.status === 'edit' && edit.renamed !== edit.source) {
                // Keep the file's changes in line order.
                const sameFile = changes.map((change, at) => ({ change, at }))
                    .filter(item => item.change.file === rel);
                const after = sameFile.find(item => item.change.line > line);
                const at = after ? after.at
                    : (sameFile.length > 0 ? sameFile[sameFile.length - 1].at + 1 : changes.length);
                changes.splice(at, 0, tagTokenEdit({
                    file: rel,
                    line,
                    expression: edit.source,
                    newExpression: edit.renamed,
                    suggestion: `Rename example (${reason}): ${edit.renamed}`,
                    editKind: 'example',
                }, edit));
            } else {
                reviewItems.push({
                    file: rel,
                    line,
                    expression: edit.source,
                    suggestion: bound.reason === 'example-referenced'
                        ? `${reason}; it is also referenced as a function, so rename it to ${bound.newName} with its references`
                        : `${example.name} may name the renamed declaration or a same-name declaration of another imported package; rename it to ${bound.newName} if it names this one`,
                    needsReview: true,
                    testBinding: true,
                    reviewReason: bound.reason,
                    editKind: 'example',
                });
            }
        }
    }

    // A member assignment onto a function-local or undeclared object is not
    // a project declaration (fix #359): its property name belongs to that
    // object's own type, so the edit is withheld and routed to review.
    if (options.renameTo) {
        const ownerScope = memberAssignmentOwnerScope(index, def);
        if (ownerScope === 'local' || ownerScope === 'external') {
            const defChange = changes.find(change =>
                change.file === definitionFile && change.line === definitionLine &&
                change.editKind === 'definition');
            if (defChange) {
                delete defChange.newExpression;
                defChange.needsReview = true;
                defChange.reviewReason = ownerScope === 'local'
                    ? 'member-assignment-local-object' : 'member-assignment-external-object';
                defChange.suggestion = `Property assignment on ${ownerScope === 'local'
                    ? 'function-local' : 'undeclared (runtime/global)'} object ` +
                    `"${def.assignedReceiver}": "${name}" is that object's property, ` +
                    'not a project declaration; rename only if you own its type';
            }
        }
    }

    // Contract membership (fix #360). A member that fills the slot of a
    // contract outside the project cannot be renamed by editing project code:
    // a definite membership (external trait impl, marked override with no
    // project definer, language protocol or universal-supertype member)
    // withholds every edit; a possible one (the owner declares out-of-project
    // supertypes) keeps the edits and requires review at the definition and
    // the declaration a compiler would reject. Go satisfaction sites the
    // structural closure could not complete are listed where Go reports them.
    // Single-element annotations (fix #389): `@Marker(x)` sets the element
    // `value` without naming it. When the site's annotation type is the
    // renamed element's owner, the rename names the element there
    // (`@Marker(renamed = x)`); an undecided owner stays listed for review.
    if (options.renameTo && planUnverified.some(site => site.annotationShorthand?.certain)) {
        const pathMod = require('path');
        const kept = [];
        for (const site of planUnverified) {
            const shorthand = site.annotationShorthand;
            const abs = pathMod.isAbsolute(site.file) ? site.file : pathMod.join(index.root, site.file);
            const text = shorthand?.certain && Number.isInteger(shorthand.column)
                ? (index._getFileLines(abs)[site.line - 1] || '') : '';
            if (!text || shorthand.column > text.length ||
                changes.some(change => change.file === site.file && change.line === site.line)) {
                kept.push(site);
                continue;
            }
            const renamed = `${text.slice(0, shorthand.column)}${options.renameTo} = ${text.slice(shorthand.column)}`;
            changes.push({
                file: site.file,
                line: site.line,
                expression: text.trim(),
                newExpression: renamed.trim(),
                suggestion: `Name the element in the single-element annotation: ${renamed.trim()}`,
                editKind: 'reference',
            });
        }
        planUnverified.length = 0;
        planUnverified.push(...kept);
    }

    // One source of truth for the plan's ACCOUNT (fix #376): a line the plan
    // edits as a call is confirmed and a line it lists as unverified is
    // unverified, whichever slot member's sweep contributed it; the pin's own
    // exclusions only keep the lines no listed site claims.
    if (options.renameTo && planAccountParts && planGroundSet &&
        (slotAccountSites.length > 0 || planUnverified.length > 0 || typePass)) {
        const pathMod = require('path');
        const absoluteOf = file => (pathMod.isAbsolute(file) ? file : pathMod.join(index.root, file));
        const editedCallLines = new Set(changes.filter(change =>
            change.editKind === 'call').map(change => `${change.file}:${change.line}`));
        const { buildAccount } = require('./account');
        // A type rename decides the call-shaped lines of its references too
        // (fix #386): edited ones are confirmed, the ones that provably name
        // another declaration are excluded, and the ones left for review are
        // listed with the unverified sites.
        const typeDecided = typePass?.decided || new Map();
        const relOf = file => pathMod.relative(index.root, file);
        const typeClaims = (keys) => {
            const confirmed = [];
            const excluded = [];
            for (const key of keys) {
                const hit = typeDecided.get(key);
                if (!hit) continue;
                const line = Number(key.slice(key.lastIndexOf(':') + 1));
                if (hit.edited) confirmed.push({ file: hit.abs, line });
                else excluded.push({ file: hit.abs, line, reason: 'other-declaration' });
            }
            return { confirmed, excluded };
        };
        const build = (extra) => buildAccount(index, name, {
            groundSet: planGroundSet,
            confirmedEntries: [
                ...planAccountParts.confirmedEntries,
                ...slotAccountSites.filter(site => editedCallLines.has(`${site.file}:${site.line}`))
                    .map(site => ({ file: site.absoluteFile || absoluteOf(site.file), line: site.line })),
                ...extra.confirmed,
            ],
            unverifiedEntries: [
                ...planAccountParts.unverifiedEntries.filter(entry =>
                    !typeDecided.has(`${relOf(entry.file)}:${entry.line}`)),
                ...planUnverified.map(site => ({ file: absoluteOf(site.file), line: site.line })),
            ],
            excludedEntries: [...extra.excluded, ...planAccountParts.excludedEntries],
        });
        let extra = typeClaims((typePass?.removed || []).map(site => `${site.file}:${site.line}`));
        planAccount = build(extra);
        if (typePass && planAccount.callNotResolved?.length > 0) {
            // Call-shaped lines no engine candidate claimed: settled by the
            // type pass, or listed with the unverified sites for review.
            const keys = planAccount.callNotResolved.map(site =>
                `${site.relativePath || relOf(site.file)}:${site.line}`);
            const more = typeClaims(keys);
            let listedMore = false;
            for (const key of keys) {
                const review = typePass.reviewed.get(key);
                if (!review || planUnverified.some(site => `${site.file}:${site.line}` === key)) continue;
                const line = Number(key.slice(key.lastIndexOf(':') + 1));
                planUnverified.push({
                    file: key.slice(0, key.lastIndexOf(':')),
                    line,
                    expression: (index._getFileLines(review.abs)[line - 1] || '').trim(),
                    reason: `type-reference-${review.reason}`,
                });
                listedMore = true;
            }
            if (listedMore) {
                planUnverified.sort((a, b) => codeUnitCompare(a.file, b.file) || a.line - b.line);
            }
            if (more.confirmed.length > 0 || more.excluded.length > 0 || listedMore) {
                extra = { confirmed: [...extra.confirmed, ...more.confirmed],
                    excluded: [...extra.excluded, ...more.excluded] };
                planAccount = build(extra);
            }
        }
    }
    let contract = null;
    if (options.renameTo) {
        const findings = [];
        const seenMembers = new Set();
        for (const member of [def, ...contractRootDefs]) {
            const key = `${member.file}\0${member.startLine}`;
            if (seenMembers.has(key)) continue;
            seenMembers.add(key);
            const finding = externalContractOf(index, member) ||
                typedLiteralContract(index, member)?.external || null;
            if (finding) findings.push({ member, ...finding });
        }
        // Hierarchy slot the closure could not complete (fix #376): a member
        // marked as an override whose declaring ancestor was not located in
        // the project cannot be renamed alone (the compiler rejects the
        // marker, or dispatch silently changes); an ancestor spelling that
        // resolves to no single project class may declare the slot too.
        if (options.renameTo && def.className && !def.traitName &&
            !findings.some(finding => finding.member === def)) {
            const defSite = {
                file: def.file,
                relativePath: def.relativePath,
                line: def.nameLine || def.startLine,
            };
            const ownerDecl = hierarchySlot?.pinRef?.def;
            const classSites = ownerDecl && ownerDecl.file === def.file ? [{
                file: ownerDecl.file,
                relativePath: ownerDecl.relativePath || def.relativePath,
                line: ownerDecl.startLine,
            }] : [];
            const unresolvedDeclaring = (hierarchySlot?.unresolved || []).filter(owner =>
                (index.symbols.get(name) || []).some(member => member.className === owner));
            if (isOverrideMarked(def) && !(hierarchySlot?.ancestors.length > 0)) {
                findings.push({
                    member: def,
                    certainty: 'definite',
                    via: unresolvedDeclaring.length > 0 ? unresolvedDeclaring
                        : (hierarchySlot?.external.length > 0 ? hierarchySlot.external
                            : [langTraits(planLang)?.universalSupertype || 'supertype']),
                    reason: 'overrides-unlocated-member',
                    sites: [defSite, ...classSites],
                });
            } else if (unresolvedDeclaring.length > 0) {
                findings.push({
                    member: def,
                    certainty: 'possible',
                    via: unresolvedDeclaring,
                    reason: 'ancestor-unresolved',
                    sites: [defSite, ...classSites],
                });
            }
        }
        // A decorator that replaces the callable receives its name too
        // (fix #392): pytest fixtures, CLI commands, endpoints and registries
        // bind the function by it. Decorators proven to keep the name out
        // (standard ones, property accessors, project decorators that only
        // call/return/wrap it) need nothing more.
        {
            const { nameBindingDecorators } = require('./decorator-binding');
            const decoratorMemo = new Map();
            const decorated = new Set();
            for (const member of [def, ...contractRootDefs]) {
                const key = `${member.file}\0${member.startLine}`;
                if (decorated.has(key)) continue;
                decorated.add(key);
                const unproven = nameBindingDecorators(index, member, decoratorMemo);
                if (unproven.length === 0) continue;
                // Point at each decorator line the declaration spans.
                const nameLine = member.nameLine || member.startLine;
                const lines = index._getFileLines(member.file) || [];
                const sites = [];
                for (let line = Math.max(1, member.startLine); line < nameLine; line++) {
                    const text = (lines[line - 1] || '').trim();
                    if (unproven.some(deco => text.startsWith(`@${deco.split('(')[0]}`))) {
                        sites.push({ file: member.file, relativePath: member.relativePath, line });
                    }
                }
                if (sites.length === 0) {
                    sites.push({ file: member.file, relativePath: member.relativePath, line: nameLine });
                }
                findings.push({
                    member,
                    certainty: 'possible',
                    via: unproven.map(text => `@${text}`),
                    reason: 'decorator-name-binding',
                    sites,
                });
            }
        }
        const definite = findings.find(finding => finding.certainty === 'definite');
        const defChange = changes.find(change =>
            change.file === definitionFile && change.line === definitionLine &&
            change.editKind === 'definition');
        const describe = finding => {
            const owner = finding.member.className || finding.member.registryContainer || finding.member.name;
            const via = finding.via.join(', ');
            switch (finding.reason) {
                case 'implements-external-trait':
                    return `${owner}.${name} implements external trait ${via}; the trait fixes the name`;
                case 'language-protocol-member':
                    return `${name} is a ${via} protocol member dispatched by name`;
                case 'possible-protocol-member':
                    return `${owner} derives from ${via} (outside the project), which may carry a runtime protocol that uses ${name} by name`;
                case 'overrides-universal-supertype':
                    return `${owner}.${name} overrides ${via}.${name}`;
                case 'overrides-external-member':
                    return `${owner}.${name} overrides a member of ${via} (outside the project)`;
                case 'overrides-unlocated-member':
                    return `${owner}.${name} is marked as an override, but the member it overrides (via ${via}) was not located in the project`;
                case 'ancestor-unresolved':
                    return `${owner} extends ${via}, which does not resolve to one project class; it may declare ${name} too`;
                case 'implements-cfg-external-trait':
                    return `${owner}.${name} implements ${via}, which is an external trait under some build configurations; the external trait fixes the name`;
                case 'compiler-protocol-type':
                    return `${via} is a type the compiler references by its full name for a language feature the project uses`;
                case 'macro-generated-name':
                    return `${name} is the callable the ${via} invocation defines; its name is generated by the macro, not written in the source`;
                case 'standard-namespace-declaration':
                    return `${name} is declared in the standard-library namespace ${via}; where the platform declares it, references bind the platform's`;
                case 'typed-literal-external-member':
                    return `${owner}.${name} is a member of an object typed ${via} (outside the project)`;
                case 'decorator-name-binding':
                    return `${via} receives ${name} and may bind it by its name (fixtures, commands, endpoints, registries); check what uses that name`;
                default:
                    return `${owner} declares ${via} (outside the project); ${name} may implement or override a member of it`;
            }
        };
        const pushContractItem = (site, suggestion, reason) => {
            const rel = site.relativePath || site.file;
            if (reviewItems.some(item => item.file === rel && item.line === site.line &&
                item.contractDependency)) return;
            reviewItems.push({
                file: rel,
                line: site.line,
                expression: (index.getLineContent(site.file, site.line) || '').trim(),
                suggestion,
                needsReview: true,
                contractDependency: true,
                reviewReason: reason,
                editKind: 'contract',
            });
        };
        if (definite) {
            for (const change of changes) {
                if (change.newExpression === undefined) continue;
                delete change.newExpression;
                change.needsReview = true;
                change.reviewReason = change.reviewReason || 'contract-blocked';
            }
            if (defChange) {
                defChange.needsReview = true;
                defChange.reviewReason = definite.reason;
                defChange.suggestion = `Rename blocked: ${describe(definite)}. ` +
                    (definite.reason === 'macro-generated-name'
                        ? 'Change the invocation that generates it instead'
                        : 'Renaming it here breaks the implementation; change the contract, not this member');
            }
        } else if (findings.length > 0 && defChange) {
            defChange.needsReview = true;
            defChange.reviewReason = findings[0].reason;
            defChange.suggestion = `${defChange.suggestion}. Review: ${describe(findings[0])}`;
        }
        for (const finding of findings) {
            for (const site of finding.sites) {
                const siteRel = site.relativePath || site.file;
                if (siteRel === definitionFile && site.line === definitionLine) continue;
                pushContractItem(site, describe(finding), finding.reason);
            }
        }
        for (const review of goContractReviews) {
            pushContractItem(review, review.message, review.reason);
        }
        if (goContractReviews.length > 0 && defChange && !definite) {
            defChange.needsReview = true;
            defChange.reviewReason = defChange.reviewReason || 'contract-incomplete';
        }
        if (findings.length > 0 || goContractReviews.length > 0) {
            contract = {
                blocked: !!definite,
                external: findings.map(finding => ({
                    member: `${finding.member.relativePath || finding.member.file}:` +
                        `${finding.member.nameLine || finding.member.startLine}`,
                    certainty: finding.certainty,
                    reason: finding.reason,
                    via: finding.via,
                })),
                incomplete: goContractReviews.map(review => ({
                    file: review.relativePath,
                    line: review.line,
                    reason: review.reason,
                })),
            };
        }
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
        examples: changes.filter(change => change.editKind === 'example').length,
        textReferences: reviewItems.filter(item =>
            !item.contractDependency && !item.templateDependency && !item.testBinding).length,
        contracts: reviewItems.filter(item => item.contractDependency).length,
        templates: reviewItems.filter(item => item.templateDependency).length,
        reviewRequired: changes.filter(change => change.needsReview).length +
            reviewItems.length,
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
        filesAffected: new Set([...changes, ...reviewItems].map(c => c.file)).size,
        ...(fileRenames.length > 0 && { fileRenames }),
        changeSummary,
        changes,
        reviewItems,
        totalReviewItems: reviewItems.length,
        ...(unchangedSites > 0 && { unchangedSites }),
        ...(contract && { contract }),
        // v4 tiered contract: sites that MAY also need this change but lack
        // binding/receiver evidence — review manually before refactoring.
        unverifiedCount: planUnverified.length,
        unverifiedSites: planUnverified,
        account: planAccount,
        scopeWarning: impactScopeWarning,
        ...(options.renameTo && {
            outsideIndexedSource: {
                scope: 'indexed-source-files',
                excluded: ['documentation', 'configuration', 'generated files', 'unsupported languages'],
                action: `Search non-source project files for the exact spelling "${name}" before applying the rename.`,
            },
        }),
        ...(resolved.warnings.length > 0 && { warnings: resolved.warnings }),
    };
    } finally {
        if (ownsTreeCache) clearTreeCache(index);
        index._endOp();
    }
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

/**
 * C# XML documentation `cref` references to a renamed MEMBER (fix #390).
 * Each `cref` spelling of the name is resolved the way the compiler resolves
 * it: unqualified in the scope of the documented declaration (its type, the
 * type's ancestors, then enclosing types), qualified through the named type.
 * A cref reaching a renamed member is edited; one reaching another member,
 * or naming a type or namespace, stays a comment-text item; one the lookup
 * cannot settle (an unresolved type, part of an overload group without a
 * parameter list) is a review item.
 */
function _docCrefMemberPass(index, name, renameTo, renamedDefs, changes, reviewItems) {
    const pathMod = require('path');
    const { ownerRefOf, resolveClassRef, findDeclaringClass } = require('./class-identity');
    const renamed = new Set(renamedDefs);
    const members = (index.symbols.get(name) || []).filter(d => d.className &&
        !IDENTITY_TYPE_KINDS_FOR_CREF.has(d.type));
    if (members.length === 0) return;
    const classRefOf = (fileEntry, cls) => {
        const entry = classDefsNamed(index, cls.name).entries.find(e => e.def === cls);
        return entry ? { name: cls.name, key: entry.key, def: cls } : null;
    };
    const scopeOf = (abs, fileEntry, line) => {
        // The documented declaration: the first one after the comment.
        let next = null;
        for (const symbol of fileEntry.symbols || []) {
            if (symbol.startLine <= line) continue;
            if (!next || symbol.startLine < next.startLine) next = symbol;
        }
        if (!next) return [];
        const chain = [];
        let ref = IDENTITY_TYPE_KINDS_FOR_CREF.has(next.type)
            ? classRefOf(fileEntry, next) : ownerRefOf(index, next);
        const seen = new Set();
        while (ref && !seen.has(ref.key || ref.name)) {
            seen.add(ref.key || ref.name);
            chain.push(ref);
            const outer = ref.def?.enclosingType;
            ref = outer ? resolveClassRef(index, outer, abs, { namespace: ref.def.namespace || null }) : null;
        }
        return chain;
    };
    const paramKey = text => String(text || '').replace(/\b(?:ref|out|in|params|this)\b/g, '')
        .replace(/[{<].*$/s, '').replace(/\s+/g, '').split('.').pop();
    // 'edit' | 'skip' | 'review' for a member found through `declaring`.
    const verdictFor = (declaring, paramsText) => {
        if (!declaring) return 'skip';
        if (declaring.uncertain) return 'review';
        const found = declaring.members;
        const hit = found.filter(member => renamed.has(member));
        if (hit.length === 0) return 'skip';
        if (hit.length === found.length) return 'edit';
        if (paramsText == null) return 'review';
        const wanted = paramsText.split(',').map(paramKey).filter(Boolean);
        const selected = found.filter(member => {
            const params = (member.paramsStructured || []).map(p => paramKey(p?.type));
            return params.length === wanted.length && params.every((p, i) => p === wanted[i]);
        });
        if (selected.length !== 1) return 'review';
        return renamed.has(selected[0]) ? 'edit' : 'skip';
    };
    const crefRe = /\bcref\s*=\s*"([^"]*)"/g;
    const idRe = new RegExp(`(^|[^A-Za-z0-9_])(${escapeRegExp(name)})(?![A-Za-z0-9_])`, 'g');
    for (let i = reviewItems.length - 1; i >= 0; i--) {
        const item = reviewItems[i];
        if (!item.textDependency) continue;
        const abs = pathMod.join(index.root, item.file);
        const fileEntry = index.files.get(abs);
        if (!fileEntry || !langTraits(fileEntry.language)?.docCrefReferences) continue;
        const text = index._getFileLines(abs)[item.line - 1] || '';
        if (!/^\s*\/\/\//.test(text)) continue;
        const edits = [];
        let review = false;
        let scope = null;
        crefRe.lastIndex = 0;
        let match;
        while ((match = crefRe.exec(text)) !== null) {
            const value = match[1];
            const valueStart = match.index + match[0].indexOf('"') + 1;
            const body = value.replace(/^[A-Za-z]:/, '  ');
            idRe.lastIndex = 0;
            let id;
            while ((id = idRe.exec(body)) !== null) {
                const start = id.index + id[1].length;
                const after = body.slice(start + name.length);
                // A qualifier segment (`Name.Member`) or generic type name.
                if (/^\s*[.{<]/.test(after)) continue;
                const paramsMatch = /^\s*\(([^)]*)\)/.exec(after);
                const paramsText = paramsMatch ? paramsMatch[1] : null;
                const qualifierText = body.slice(0, start).replace(/\.\s*$/, '');
                const qualified = /\.\s*$/.test(body.slice(0, start));
                let verdict;
                if (qualified) {
                    const segment = qualifierText.split('.').pop().trim();
                    const generic = /\{([^}]*)\}\s*$/.exec(segment);
                    const typeName = segment.replace(/\{.*$/, '').trim();
                    const arity = generic ? generic[1].split(',').length : 0;
                    const traits = langTraits(fileEntry.language);
                    const ref = resolveClassRef(index, typeName, abs, {
                        ...(traits?.genericArityIsIdentity && { arity }),
                    });
                    if (ref.external) verdict = 'skip';
                    else if (!ref.key) verdict = 'review';
                    else verdict = verdictFor(findDeclaringClass(index, ref, members), paramsText);
                } else {
                    if (!scope) scope = scopeOf(abs, fileEntry, item.line);
                    if (scope.length === 0) verdict = 'review';
                    else {
                        verdict = 'skip';
                        for (const ref of scope) {
                            const declaring = findDeclaringClass(index, ref, members);
                            if (!declaring) continue;
                            verdict = verdictFor(declaring, paramsText);
                            break;
                        }
                    }
                }
                if (verdict === 'edit') edits.push(valueStart + start);
                else if (verdict === 'review') review = true;
            }
        }
        if (review) {
            item.textDependency = false;
            item.reviewReason = 'doc-cref';
            item.suggestion = `Verify whether this documentation reference names the renamed ${name} ` +
                `and rename it to ${renameTo} if it does (the compiler resolves cref attributes)`;
            continue;
        }
        if (edits.length === 0) continue;
        let renamedText = text;
        for (const column of edits.sort((a, b) => b - a)) {
            renamedText = renamedText.slice(0, column) + renameTo + renamedText.slice(column + name.length);
        }
        reviewItems.splice(i, 1);
        const change = tagTokenEdit({
            file: item.file,
            line: item.line,
            expression: text.trim(),
            newExpression: renamedText.trim(),
            suggestion: `Update documentation reference: ${renamedText.trim()}`,
            editKind: 'reference',
        }, { columns: edits, rawSource: text, oldName: name, newName: renameTo, renamed: renamedText.trim() });
        // Keep the file's changes in line order.
        const sameFile = changes.map((other, at) => ({ other, at }))
            .filter(entry => entry.other.file === item.file);
        const after = sameFile.find(entry => entry.other.line > item.line);
        const at = after ? after.at
            : (sameFile.length > 0 ? sameFile[sameFile.length - 1].at + 1 : changes.length);
        changes.splice(at, 0, change);
    }
}

const CSHARP_TYPE_DECLARATION_NODES = new Set(['class_declaration', 'struct_declaration',
    'record_declaration', 'record_struct_declaration', 'interface_declaration']);
// Declarations whose `name` field binds a local of the member body.
const CSHARP_LOCAL_DECLARATION_NODES = new Set(['parameter', 'catch_declaration', 'declaration_pattern',
    'declaration_expression', 'variable_declarator', 'local_function_statement', 'from_clause',
    'join_clause', 'query_continuation', 'recursive_pattern', 'var_pattern']);

const CSHARP_BLOCK_SCOPES = new Set(['block', 'switch_section', 'for_statement', 'using_statement',
    'fixed_statement', 'lambda_expression', 'anonymous_method_expression', 'arrow_expression_clause']);

/**
 * Where C# scopes a local named like the reference (spec 7.7): 'local' when
 * a parameter, local variable, local function, pattern, lambda, foreach,
 * catch or range variable of that name is in scope at `node`, 'none' when
 * no declaration of the member reaches it, 'unknown' for an unmodelled
 * declaration shape.
 */
function csharpLocalBinding(memberNode, node, name) {
    const contains = (scope, target) => scope && scope.startIndex <= target.startIndex &&
        target.endIndex <= scope.endIndex;
    const nearest = (from, kinds) => {
        for (let current = from.parent; current && !sameNode(current, memberNode); current = current.parent) {
            if (kinds.has(current.type)) return current;
        }
        return memberNode;
    };
    let verdict = 'none';
    const scopeOf = (declared) => {
        const parent = declared.parent;
        switch (parent.type) {
            case 'parameter': {
                const owner = parent.parent?.parent;
                return owner || memberNode;
            }
            case 'variable_declarator': case 'local_function_statement':
            case 'declaration_pattern': case 'declaration_expression': case 'single_variable_designation':
            case 'recursive_pattern': case 'var_pattern':
                return nearest(parent, CSHARP_BLOCK_SCOPES);
            case 'catch_declaration':
                return parent.parent;
            case 'foreach_statement':
                return parent;
            case 'from_clause': case 'join_clause': case 'let_clause': case 'query_continuation':
                return nearest(parent, new Set(['query_expression']));
            default:
                return null;
        }
    };
    const visit = current => {
        if (verdict === 'local') return;
        if ((current.type === 'implicit_parameter' || current.type === 'identifier') && current.text === name &&
            !sameNode(current, node)) {
            const parent = current.parent;
            let declares = current.type === 'implicit_parameter';
            if (!declares && parent) {
                declares = (CSHARP_LOCAL_DECLARATION_NODES.has(parent.type) &&
                    sameNode(parent.childForFieldName('name'), current) && !sameNode(parent, memberNode)) ||
                    (parent.type === 'foreach_statement' && sameNode(parent.childForFieldName('left'), current)) ||
                    parent.type === 'single_variable_designation' ||
                    (parent.type === 'let_clause' && sameNode(parent.namedChild(0), current));
            }
            if (declares) {
                const scope = current.type === 'implicit_parameter' ? parent : scopeOf(current);
                if (!scope) verdict = 'unknown';
                else if (contains(scope, node)) verdict = 'local';
            }
            return;
        }
        for (const child of current.namedChildren || []) visit(child);
    };
    for (const child of memberNode.namedChildren || []) visit(child);
    return verdict;
}

/**
 * Method groups in a C# member rename (fix #395): a simple name in value
 * position (`new(Build, 4)`, `Changed += OnChanged`, `.Select(Build)`,
 * `Func<int> f = Build`, `nameof(Build)`), a `this.`/`base.` access or a
 * type-qualified `Host.Build` names a method group, found by C# simple-name
 * lookup (spec 12.8.4): a local of that name in the enclosing member hides
 * it (review); then the enclosing class and its ancestry, then each
 * enclosing class outward. The first class that declares the name decides:
 * its members of that name are the renamed ones - an edit; the renamed ones
 * beside others (an overload chosen by the delegate's signature) or an
 * unresolved ancestry - a review item; none - not the pin.
 */
function _methodGroupPass(index, name, renameTo, renamedDefs, changes, usages) {
    const pathMod = require('path');
    const { resolveClassRef, findDeclaringClass, parentRefsOf } = require('./class-identity');
    const renamed = new Set(renamedDefs);
    const members = (index.symbols.get(name) || []).filter(d => d.className &&
        !IDENTITY_TYPE_KINDS_FOR_CREF.has(d.type));
    if (!members.some(member => renamed.has(member))) return;
    const verdictOf = declaring => {
        if (!declaring) return null;
        if (declaring.uncertain) return 'review';
        const hit = declaring.members.filter(member => renamed.has(member));
        if (hit.length === 0) return 'skip';
        return hit.length === declaring.members.length ? 'edit' : 'review';
    };
    const classRefAt = (file, declNode) => {
        const nameNode = declNode.childForFieldName('name');
        if (!nameNode) return null;
        const line = nameNode.startPosition.row + 1;
        const entry = classDefsNamed(index, nameNode.text).entries.find(e => e.def.file === file &&
            (e.def.nameLine || e.def.startLine) <= line && e.def.endLine >= line &&
            e.def.startLine <= line);
        return entry ? { name: nameNode.text, key: entry.key, def: entry.def } : null;
    };
    const openAncestry = ref => parentRefsOf(index, ref).some(parent => parent.external || !parent.key);
    const verdictFor = (ref, tree) => {
        const row = ref.line - 1;
        const column = Number.isInteger(ref.column) ? ref.column : null;
        if (column == null || !tree) return 'review';
        const node = tree.rootNode.descendantForPosition({ row, column });
        if (!node || node.type !== 'identifier' || node.text !== name) return 'review';
        const types = [];
        let member = null;
        for (let current = node.parent; current; current = current.parent) {
            if (CSHARP_TYPE_DECLARATION_NODES.has(current.type)) types.push(current);
            else if (types.length === 0 && current.parent?.type === 'declaration_list') member = current;
        }
        if (types.length === 0) return 'review';
        const receiver = ref.receiver || null;
        if (receiver && receiver !== 'this' && receiver !== 'base') {
            // `Host.Build`: a static method group of the named class.
            if (!/^[A-Z]/.test(receiver)) return null;
            const typeRef = resolveClassRef(index, receiver, ref.file, { line: ref.line });
            if (!typeRef?.key) return typeRef?.external ? null : 'review';
            return verdictOf(findDeclaringClass(index, typeRef, members)) === 'edit' ? 'edit'
                : verdictOf(findDeclaringClass(index, typeRef, members)) === 'review' ? 'review' : null;
        }
        if (!receiver && member) {
            const local = csharpLocalBinding(member, node, name);
            if (local === 'local') return null;
            if (local === 'unknown') return 'review';
        }
        for (let i = 0; i < types.length; i++) {
            const classRef = classRefAt(ref.file, types[i]);
            if (!classRef) return 'review';
            const declaring = findDeclaringClass(index, classRef, members,
                receiver === 'base' ? { parentsOnly: true } : {});
            const verdict = verdictOf(declaring);
            if (verdict === 'skip') return null;
            if (verdict) return verdict;
            // `this.`/`base.` name the innermost class only; a simple name
            // continues outward unless an unmodelled base could declare it.
            if (receiver || openAncestry(classRef)) return receiver ? null : 'review';
        }
        return null;
    };
    const trees = new Map();
    const treeOf = file => {
        if (trees.has(file)) return trees.get(file);
        let tree;
        try {
            const content = index._readFile(file);
            tree = index._getParsedTree?.(file, content, 'csharp') || safeParse(getParser('csharp'), content);
        } catch { tree = null; }
        trees.set(file, tree);
        return tree;
    };
    // Only simple names and `this.`/`base.`/type-qualified accesses can name
    // the method group; other member accesses are never parsed for.
    const candidateRecord = record => record.usageType === 'reference' && !record.isDefinition &&
        (!record.receiver || record.receiver === 'this' || record.receiver === 'base' ||
            /^[A-Z]/.test(String(record.receiver)));
    for (const first of usages) {
        if (first.usageType !== 'reference' || first.isDefinition) continue;
        const abs = first.file;
        if (!langTraits(index.files.get(abs)?.language)?.methodGroupReferences) continue;
        const records = [first, ...(first.sameLine || [])].filter(candidateRecord);
        if (records.length === 0) continue;
        const rel = first.relativePath || pathMod.relative(index.root, abs);
        const edits = [];
        let review = false;
        for (const record of records) {
            const verdict = verdictFor({ ...record, file: abs }, treeOf(abs));
            if (verdict === 'edit') edits.push(record.column);
            else if (verdict === 'review') review = true;
        }
        if (edits.length === 0 && !review) continue;
        const existing = changes.find(change => change.file === rel && change.line === first.line);
        if (existing) {
            if (edits.length > 0 && existing.newExpression !== undefined && !existing.needsReview) {
                mergeTokenEdit(existing, renameIdentifierTokens(index, abs, first.line, name, renameTo, edits));
            }
            if (review && !existing.needsReview) {
                existing.needsReview = true;
                existing.reviewReason = existing.reviewReason || 'method-group';
            }
            continue;
        }
        let change;
        if (edits.length > 0 && !review) {
            const edit = renameIdentifierTokens(index, abs, first.line, name, renameTo, edits);
            if (edit.renamed === edit.source) continue;
            change = tagTokenEdit({
                file: rel,
                line: first.line,
                expression: edit.source,
                suggestion: `Update method group reference: ${edit.renamed}`,
                newExpression: edit.renamed,
                editKind: 'reference',
            }, edit);
        } else {
            change = {
                file: rel,
                line: first.line,
                expression: (first.content || index.getLineContent(abs, first.line) || '').trim(),
                suggestion: `Verify whether this method group names the renamed ${name} ` +
                    `(an overload chosen by the delegate type, or a local of that name) and rename it to ${renameTo} if it does`,
                needsReview: true,
                reviewReason: 'method-group',
                editKind: 'reference',
            };
        }
        // Keep the file's changes in line order.
        const sameFile = changes.map((other, at) => ({ other, at }))
            .filter(entry => entry.other.file === rel);
        const after = sameFile.find(entry => entry.other.line > first.line);
        const at = after ? after.at
            : (sameFile.length > 0 ? sameFile[sameFile.length - 1].at + 1 : changes.length);
        changes.splice(at, 0, change);
    }
}

const IDENTITY_TYPE_KINDS_FOR_CREF = new Set(['class', 'struct', 'interface', 'record', 'enum', 'trait', 'type']);

module.exports = { verify, plan, baseCounterpartOf, sitesReboundByChange, computePlanCallSites, analyzeCallSite, analyzeCallSiteAST, analyzeCallShape, classifyArgNode, findCallNode, clearTreeCache, identifyCallPatterns };
