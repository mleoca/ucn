/**
 * languages/rust.js - Tree-sitter based Rust parsing
 *
 * Handles: function definitions, struct/enum/trait/impl blocks,
 * modules, macros, and const/static declarations.
 */

const { ReceiverTypeMap, typeOrigin } = require('./type-evidence');
const { referenceScope, scopeFields, rustSelfFieldBinding } = require('./lexical-scope');


const {
    traverseTree,
    nodeTextWithoutComments,
    traverseTreeCached,
    nodeToLocation,
    parseStructuredParams,
    extractRustDocstring,
    visitNameNodes,
    sameNode,
    parseErrorRegions,
    cachedNodeRange,
} = require('./utils');
const { PARSE_OPTIONS, safeParse } = require('./index');
const { rustValueFacts } = require('./rust-value-flow');

function parseTree(parser, code) {
    return safeParse(parser, code, undefined, PARSE_OPTIONS);
}

const MACRO_ITEM_TOKENS = new Set([
    'fn', 'struct', 'enum', 'union', 'trait', 'impl', 'type', 'const',
    'static', 'mod', 'use', 'extern',
]);
const MACRO_ITEM_NODES = new Set([
    'function_item', 'struct_item', 'enum_item', 'union_item', 'trait_item',
    'impl_item', 'type_item', 'const_item', 'static_item', 'mod_item',
    'use_declaration', 'foreign_mod_item',
]);

let lastDeclarationParser = null;
let lastDeclarationCode = null;
let lastDeclarationTrees = null;

function macroInvocationIsItemPosition(node) {
    if (node.parent?.type === 'source_file') return true;
    if (node.parent?.type !== 'declaration_list') return false;
    // A macro directly inside a module can emit items. An invocation inside
    // an impl/trait body emits associated items and must not be reinterpreted
    // as free functions or top-level types.
    return node.parent.parent?.type === 'mod_item';
}

function tokenTreeMayDeclareItem(tokenTree) {
    const pending = [tokenTree];
    while (pending.length > 0) {
        const current = pending.pop();
        for (let index = 0; index < current.childCount; index++) {
            const child = current.child(index);
            if (MACRO_ITEM_TOKENS.has(child.type)) return true;
            if (child.type === 'token_tree') pending.push(child);
        }
    }
    return false;
}

/**
 * Item bodies of item-position macro invocations that declare functions
 * (fix #401): the byte- and line-preserving recovery parse and the token
 * tree content ranges whose parse holds at least one `fn` with a body. Calls
 * in those ranges are read from the recovered items. null when none.
 */
function rustMacroItemCallRecovery(code, parser) {
    // The declaration trees are memoized on the code: the call extractor and
    // the declaration extractors share one recovery parse.
    const declaration = declarationTrees(code, parser);
    if (declaration.macroCallRecovery === undefined) {
        declaration.macroCallRecovery = buildMacroItemRecoveryTree(code, parser, declaration.primary)?.callRecovery || null;
    }
    return declaration.macroCallRecovery;
}

function buildMacroItemRecoveryTree(code, parser, tree) {
    const ranges = [];
    traverseTreeCached(tree.rootNode, node => {
        if (node.type !== 'macro_invocation' ||
            !macroInvocationIsItemPosition(node)) return true;
        const tokenTree = node.namedChildren.find(child => child.type === 'token_tree');
        if (tokenTree && tokenTreeMayDeclareItem(tokenTree) &&
            tokenTree.endIndex - tokenTree.startIndex > 2) {
            ranges.push([tokenTree.startIndex + 1, tokenTree.endIndex - 1]);
        }
        // Its contents are opaque tokens in the primary tree; no nested AST
        // invocation can be discovered by descending here.
        return false;
    });
    if (ranges.length === 0) return null;

    const masked = code.replace(/[^\r\n]/g, ' ').split('');
    for (const [start, end] of ranges) {
        for (let index = start; index < end; index++) masked[index] = code[index];
        // Bound malformed macro DSL so it cannot absorb the next invocation.
        if (end < masked.length && masked[end] !== '\n' && masked[end] !== '\r') {
            masked[end] = ';';
        }
    }
    const recovered = parseTree(parser, masked.join(''));
    let itemCount = 0;
    const declarationNameStarts = new Set();
    const callRanges = new Set();
    traverseTreeCached(recovered.rootNode, node => {
        if (MACRO_ITEM_NODES.has(node.type)) {
            itemCount++;
            const name = node.childForFieldName('name');
            if (name) declarationNameStarts.add(name.startIndex);
            if (node.type === 'function_item' && node.childForFieldName('body')) {
                const range = ranges.find(([start, end]) => node.startIndex >= start && node.endIndex <= end);
                if (range) callRanges.add(range);
            }
        }
        return true;
    });
    if (itemCount === 0) return null;
    const callRecovery = callRanges.size > 0
        ? { tree: recovered, ranges: [...callRanges].sort((a, b) => a[0] - b[0]) } : null;
    return { tree: recovered, itemCount, declarationNameStarts, callRecovery };
}

/**
 * Rust macro invocation bodies are token trees, even when they contain item
 * declarations verbatim. Reparse only item-position bodies in a byte- and
 * line-preserving synthetic source. The primary AST remains authoritative;
 * the recovery tree contributes declarations the grammar otherwise hides.
 */
function declarationTrees(code, parser) {
    if (parser === lastDeclarationParser && code === lastDeclarationCode &&
        lastDeclarationTrees) return lastDeclarationTrees;
    const primary = parseTree(parser, code);
    const macro = buildMacroItemRecoveryTree(code, parser, primary);
    const result = {
        primary,
        trees: macro ? [primary, macro.tree] : [primary],
        macroItemRecovery: !!macro,
        macroItemCount: macro?.itemCount || 0,
        macroDeclarationNameStarts: macro?.declarationNameStarts || new Set(),
        macroCallRecovery: macro?.callRecovery || null,
    };
    lastDeclarationParser = parser;
    lastDeclarationCode = code;
    lastDeclarationTrees = result;
    return result;
}

/** Names of the outer attributes preceding an item (`#[cfg(..)]` -> cfg). */
function rustAttributeNames(node) {
    const names = [];
    for (let sibling = node.previousNamedSibling; sibling; sibling = sibling.previousNamedSibling) {
        if (sibling.type === 'line_comment' || sibling.type === 'block_comment') continue;
        if (sibling.type !== 'attribute_item') break;
        const head = sibling.namedChildren.find(child => child.type === 'attribute')
            ?.namedChildren.find(child => child.type === 'identifier' || child.type === 'scoped_identifier');
        if (head) names.unshift(head.text);
    }
    return names;
}

/**
 * Declaration trees for a source the caller already parsed and knows holds
 * no macro item bodies to recover (fix #374: an expanded file, whose project
 * invocations are already replaced by their expansions). Primes the memo
 * the extractors below read, so they share that tree.
 */
function primeDeclarationTrees(code, parser, tree) {
    lastDeclarationParser = parser;
    lastDeclarationCode = code;
    lastDeclarationTrees = {
        primary: tree,
        trees: [tree],
        macroItemRecovery: false,
        macroItemCount: 0,
        macroDeclarationNameStarts: new Set(),
        // An expansion may hand items to an outside macro (`quickcheck! {
        // fn .. }`, fix #401): their calls are read from the item parse,
        // computed when calls are extracted.
        macroCallRecovery: undefined,
    };
}

/**
 * Function qualifiers from the AST `function_modifiers` node (fix #370): a
 * first-line text probe misread `fn f() -> impl Future { async { .. } }` as
 * an async fn and missed qualifiers written on a later line.
 */
function rustFunctionQualifiers(node) {
    const out = { async: false, unsafe: false, const: false, extern: false };
    const mods = node?.namedChildren?.find(child => child.type === 'function_modifiers');
    if (!mods) return out;
    for (let i = 0; i < mods.childCount; i++) {
        const type = mods.child(i).type;
        if (type === 'async') out.async = true;
        else if (type === 'unsafe') out.unsafe = true;
        else if (type === 'const') out.const = true;
        else if (type === 'extern_modifier' || type === 'extern') out.extern = true;
    }
    return out;
}

// Future vocabulary (fix #370): the std/core Future trait, the smart-pointer
// wrappers that keep a future a future, and the futures-crate boxed aliases.
const RUST_FUTURE_TRAITS = new Set(['Future']);
const RUST_FUTURE_WRAPPERS = new Set(['Pin', 'Box']);
const RUST_FUTURE_ALIASES = new Set(['BoxFuture', 'LocalBoxFuture']);

function rustTypeLastName(typeNode) {
    if (!typeNode) return null;
    if (typeNode.type === 'type_identifier') return typeNode.text;
    if (typeNode.type === 'scoped_type_identifier') return typeNode.childForFieldName('name')?.text || null;
    if (typeNode.type === 'generic_type') return rustTypeLastName(typeNode.childForFieldName('type'));
    return null;
}

function rustTypeArguments(typeNode) {
    const args = typeNode?.type === 'generic_type' ? typeNode.childForFieldName('type_arguments') : null;
    return (args?.namedChildren || []).filter(arg => arg.type !== 'lifetime');
}

/**
 * Whether a type node denotes a future, and its Output type text:
 * `impl Future<Output = T> (+ Send)`, `dyn Future<..>` behind `Pin`/`Box`/
 * references, `BoxFuture<'a, T>`. Returns { output } or null.
 */
function rustFutureShape(typeNode, depth = 0) {
    if (!typeNode || depth > 8) return null;
    switch (typeNode.type) {
        case 'bounded_type':
            for (const child of typeNode.namedChildren) {
                const shape = rustFutureShape(child, depth + 1);
                if (shape) return shape;
            }
            return null;
        case 'abstract_type':
        case 'dynamic_type': {
            const bound = typeNode.childForFieldName('trait') || typeNode.namedChild(0);
            if (bound?.type === 'bounded_type') return rustFutureShape(bound, depth + 1);
            if (!RUST_FUTURE_TRAITS.has(rustTypeLastName(bound))) return null;
            const args = bound.type === 'generic_type' ? bound.childForFieldName('type_arguments') : null;
            const output = (args?.namedChildren || []).find(arg =>
                arg.type === 'type_binding' && arg.childForFieldName('name')?.text === 'Output');
            return { output: output?.childForFieldName('type')?.text || null };
        }
        case 'reference_type':
            return rustFutureShape(typeNode.childForFieldName('type'), depth + 1);
        case 'generic_type': {
            const name = rustTypeLastName(typeNode);
            const args = rustTypeArguments(typeNode);
            if (RUST_FUTURE_WRAPPERS.has(name) && args.length === 1) return rustFutureShape(args[0], depth + 1);
            if (RUST_FUTURE_ALIASES.has(name)) return { output: args.length > 0 ? args[args.length - 1].text : null };
            return null;
        }
        case 'type_identifier':
        case 'scoped_type_identifier':
            return RUST_FUTURE_ALIASES.has(rustTypeLastName(typeNode)) ? { output: null } : null;
        default:
            return null;
    }
}

// Attributes that never replace a function's body or signature: the
// language's built-in lint/doc/codegen attributes and `tracing::instrument`
// (which preserves the async signature). Any other attribute may be a
// proc macro that rewrites the function (`#[tokio::main]` turns an async fn
// into a blocking sync fn), so its call result is not known.
const RUST_TRANSPARENT_FN_ATTRIBUTES = new Set([
    'inline', 'cold', 'must_use', 'allow', 'warn', 'deny', 'forbid', 'expect',
    'deprecated', 'doc', 'cfg', 'track_caller', 'target_feature', 'rustfmt::skip',
    'instrument', 'tracing::instrument',
]);

function rustAttributePath(node) {
    return node && ['identifier', 'scoped_identifier'].includes(node.type) ? node.text.replace(/\s+/g, '') : null;
}

/** Outer attribute paths of an item; `cfg_attr(pred, a, b)` yields a, b. */
function rustOuterAttributePaths(itemNode) {
    const paths = [];
    for (let sibling = itemNode.previousNamedSibling; sibling; sibling = sibling.previousNamedSibling) {
        if (sibling.type === 'line_comment' || sibling.type === 'block_comment') continue;
        if (sibling.type !== 'attribute_item') break;
        const attribute = sibling.namedChildren.find(child => child.type === 'attribute');
        const path = rustAttributePath(attribute?.namedChild(0));
        if (!path) { paths.push('?'); continue; }
        if (path !== 'cfg_attr') { paths.push(path); continue; }
        const args = attribute.childForFieldName('arguments');
        let group = 0;
        let expectPath = false;
        let current = '';
        for (let i = 0; args && i < args.childCount; i++) {
            const token = args.child(i);
            if (token.type === ',') {
                if (current) paths.push(current);
                current = '';
                group++;
                expectPath = true;
                continue;
            }
            if (group === 0 || !expectPath) continue;
            if (token.type === 'identifier' || token.type === '::') current += token.text;
            else { if (current) paths.push(current); current = ''; expectPath = false; }
        }
        if (current) paths.push(current);
    }
    return paths;
}

/**
 * What calling a function returns when that is a future (fix #370):
 * `async fn` -> { kind: 'async', output }, a future-shaped return type ->
 * { kind: 'future', output }. Null otherwise (named return types are
 * resolved against project `impl Future` types and aliases at query time).
 */
function rustFutureReturn(fnNode, qualifiers) {
    const returnNode = fnNode.childForFieldName('return_type');
    let result = null;
    if (qualifiers.async) {
        result = { kind: 'async', output: returnNode ? nodeTextWithoutComments(returnNode).trim() : '()' };
    } else {
        const shape = rustFutureShape(returnNode);
        if (shape) result = { kind: 'future', output: shape.output };
    }
    if (result) {
        const wrapping = rustOuterAttributePaths(fnNode).find(path => !RUST_TRANSPARENT_FN_ATTRIBUTES.has(path));
        if (wrapping) result = { kind: 'wrapped', output: result.output, attribute: wrapping };
    }
    return result;
}

/**
 * Extract return type from Rust function
 */
function extractReturnType(node) {
    const returnTypeNode = node.childForFieldName('return_type');
    if (returnTypeNode) {
        let text = nodeTextWithoutComments(returnTypeNode).trim();
        if (text.startsWith('->')) {
            text = text.slice(2).trim();
        }
        return text || null;
    }
    return null;
}

/**
 * Extract the compiler-declared associated item of an iterator return:
 * `impl Iterator<Item = &Arg>` → `Arg`. Tuple/dyn/opaque item shapes abstain.
 */
function extractRustIteratorItemTypeFromTypeNode(typeNode) {
    if (!typeNode) return null;
    const pending = [typeNode];
    while (pending.length > 0) {
        const current = pending.pop();
        if (current.type === 'type_binding') {
            const nameNode = current.namedChild(0);
            const valueNode = current.childForFieldName('type') || current.namedChild(1);
            if (nameNode?.text === 'Item') return aliasBaseTypeName(valueNode);
        }
        for (let i = current.namedChildCount - 1; i >= 0; i--) {
            pending.push(current.namedChild(i));
        }
    }
    return null;
}

function extractRustIteratorItemType(node) {
    return extractRustIteratorItemTypeFromTypeNode(
        node.childForFieldName('return_type'));
}

/**
 * A turbofish on `Iterator::collect` fixes both the concrete collection and
 * its item type at the call site: `collect::<Vec<Haystack>>()`. Keep that
 * compiler-declared result shape so a later collection callback
 * (`sort_by(|a, b| ...)`) can type its closure parameters without guessing.
 */
function extractCollectResultContract(genericFunctionNode) {
    if (genericFunctionNode?.type !== 'generic_function') return null;
    const functionNode = genericFunctionNode.childForFieldName('function');
    if (functionNode?.type !== 'field_expression' ||
        functionNode.childForFieldName('field')?.text !== 'collect') {
        return null;
    }
    const args = genericFunctionNode.namedChildren
        .find(child => child.type === 'type_arguments');
    if (!args || args.namedChildCount !== 1) return null;
    const result = args.namedChild(0);
    if (result.type !== 'generic_type') return null;
    const outer = aliasBaseTypeName(result.childForFieldName('type') || result.namedChild(0));
    const resultArgs = result.namedChildren
        .find(child => child.type === 'type_arguments');
    if (!outer || !resultArgs || resultArgs.namedChildCount !== 1) return null;
    const item = aliasBaseTypeName(resultArgs.namedChild(0));
    return item ? { type: outer, itemType: item } : null;
}

/**
 * Extract Rust parameters
 */
function extractRustParams(paramsNode) {
    // Distinguish "we have no node" (genuinely unknown) from "node is empty".
    // Returning '...' for empty parens conflated zero-param functions with
    // unknown signatures in JSON output (fix #238; the shared
    // utils.extractParams already had this fix).
    if (!paramsNode) return '...';
    const text = nodeTextWithoutComments(paramsNode);
    return text.replace(/^\(|\)$/g, '').trim();
}

/**
 * Generic parameters bounded by a closure trait (fix #368):
 * `fn join<A: FnOnce(FnContext) -> R>(a: A)` and `where A: FnOnce(...)`.
 * Returns name -> function_type node, plus every declared type-parameter
 * name (a closure argument typed by a generic parameter has no concrete
 * identity, so such slots stay unknown).
 */
function rustGenericClosureBounds(ownerNode) {
    const bounds = new Map();
    const declared = new Set();
    if (!ownerNode) return { bounds, declared };
    const functionTypeIn = (boundsNode) => {
        const pending = boundsNode ? [boundsNode] : [];
        while (pending.length > 0) {
            const current = pending.pop();
            if (current.type === 'function_type' &&
                ['Fn', 'FnMut', 'FnOnce'].includes(current.childForFieldName('trait')?.text)) {
                return current;
            }
            for (let j = 0; j < current.namedChildCount; j++) pending.push(current.namedChild(j));
        }
        return null;
    };
    const record = (nameNode, boundsNode) => {
        if (nameNode?.type !== 'type_identifier') return;
        const functionType = functionTypeIn(boundsNode);
        if (!functionType) return;
        if (bounds.has(nameNode.text) && bounds.get(nameNode.text) !== functionType) {
            bounds.set(nameNode.text, null); // two closure bounds: ambiguous
        } else {
            bounds.set(nameNode.text, functionType);
        }
    };
    const owners = [ownerNode];
    for (let a = ownerNode.parent; a; a = a.parent) {
        if (a.type === 'impl_item' || a.type === 'trait_item') {
            owners.push(a);
            break;
        }
        if (a.type === 'function_item') break;
    }
    for (const owner of owners) {
        const typeParameters = owner.childForFieldName('type_parameters');
        for (const child of typeParameters?.namedChildren || []) {
            if (child.type === 'type_identifier') declared.add(child.text);
            else if (child.type === 'constrained_type_parameter') {
                const left = child.childForFieldName('left');
                if (left?.type === 'type_identifier') declared.add(left.text);
                if (owner === ownerNode) record(left, child.childForFieldName('bounds'));
            } else if (child.type === 'optional_type_parameter') {
                const name = child.childForFieldName('name');
                if (name?.type === 'type_identifier') declared.add(name.text);
            }
        }
        if (owner !== ownerNode) continue;
        const whereClause = owner.namedChildren.find(child => child.type === 'where_clause');
        for (const predicate of whereClause?.namedChildren || []) {
            if (predicate.type !== 'where_predicate') continue;
            record(predicate.childForFieldName('left'), predicate.childForFieldName('bounds'));
        }
    }
    return { bounds, declared };
}

function extractRustCallbackParamTypes(paramsNode, ownerNode = null) {
    if (!paramsNode) return undefined;
    const callbacks = {};
    let callArgumentIndex = 0;
    let generic = null;
    for (let i = 0; i < paramsNode.namedChildCount; i++) {
        const parameter = paramsNode.namedChild(i);
        if (parameter.type === 'self_parameter') continue;
        if (parameter.type !== 'parameter') continue;
        const typeNode = parameter.childForFieldName('type');
        let functionType = null;
        let viaBound = false;
        const pending = typeNode ? [typeNode] : [];
        while (pending.length > 0 && !functionType) {
            const current = pending.pop();
            if (current.type === 'function_type') {
                functionType = current;
                break;
            }
            for (let j = 0; j < current.namedChildCount; j++) {
                pending.push(current.namedChild(j));
            }
        }
        if (!functionType && ownerNode) {
            // `op: OP` / `op: &OP` / `op: &mut OP` with OP bounded by a
            // closure trait on this function (fix #368).
            let head = typeNode;
            while (head?.type === 'reference_type') {
                head = head.childForFieldName('type');
            }
            if (head?.type === 'type_identifier') {
                generic = generic || rustGenericClosureBounds(ownerNode);
                const bound = generic.bounds.get(head.text);
                if (bound) {
                    functionType = bound;
                    viaBound = true;
                }
            }
        }
        const callbackParams = functionType?.childForFieldName('parameters');
        if (callbackParams) {
            if (viaBound || ownerNode) {
                generic = generic || rustGenericClosureBounds(ownerNode);
            }
            const types = [];
            let complete = true;
            let known = 0;
            for (let j = 0; j < callbackParams.namedChildCount; j++) {
                const slot = callbackParams.namedChild(j);
                if (slot.type.endsWith('comment')) continue;
                const name = aliasBaseTypeName(slot);
                if (!name) {
                    if (!ownerNode) {
                        complete = false;
                        break;
                    }
                    types.push(null);
                    continue;
                }
                // A slot naming a declared type parameter is not a concrete
                // type; keep its position, never its spelling.
                if (generic && generic.declared.has(name)) {
                    types.push(null);
                    continue;
                }
                types.push(name);
                known++;
            }
            if (complete && known > 0) callbacks[callArgumentIndex] = types;
        }
        callArgumentIndex++;
    }
    return Object.keys(callbacks).length > 0 ? callbacks : undefined;
}

/**
 * Base type name from a type-alias target (fix #208): SpannedString<Style>
 * → SpannedString, module::Type → Type, &T → T. dyn/impl/tuple/fn shapes
 * return null — not nominal method receivers.
 */
function aliasBaseTypeName(typeNode) {
    if (!typeNode) return null;
    if (typeNode.type === 'type_identifier') return typeNode.text;
    if (typeNode.type === 'reference_type') {
        for (let i = 0; i < typeNode.namedChildCount; i++) {
            const r = aliasBaseTypeName(typeNode.namedChild(i));
            if (r) return r;
        }
        return null;
    }
    if (typeNode.type === 'generic_type') {
        return aliasBaseTypeName(typeNode.namedChild(0));
    }
    if (typeNode.type === 'scoped_type_identifier') {
        return typeNode.childForFieldName('name')?.text || null;
    }
    return null;
}

/**
 * Extract visibility modifier
 */
function extractVisibility(text) {
    const firstLine = text.split('\n')[0];
    if (firstLine.includes('pub(crate)')) return 'pub(crate)';
    if (firstLine.includes('pub(self)')) return 'pub(self)';
    if (firstLine.includes('pub(super)')) return 'pub(super)';
    if (firstLine.includes('pub ')) return 'pub';
    return null;
}

/**
 * Extract attributes from a function node (e.g., #[test], #[tokio::main])
 * @param {Node} node - AST node
 * @param {string} code - Source code
 * @returns {string[]} Array of attribute names
 */
function extractAttributes(node, codeOrLines) {
    const attributes = [];
    const lines = Array.isArray(codeOrLines) ? codeOrLines : codeOrLines.split('\n');

    // Look at lines before the function for attributes
    const startLine = node.startPosition.row;
    for (let i = startLine - 1; i >= 0 && i >= startLine - 5; i--) {
        const line = lines[i]?.trim();
        if (!line) break;
        if (line.startsWith('#[')) {
            // Extract attribute name (e.g., #[test] -> test, #[tokio::main] -> tokio::main)
            const match = line.match(/#\[([^\]]+)\]/);
            if (match) {
                const attrContent = match[1];
                // Get just the attribute name (without arguments)
                const attrName = attrContent.split('(')[0].trim();
                // Skip compiler hint attributes that aren't semantically meaningful for display
                const SKIP_ATTRS = new Set(['allow', 'deny', 'warn', 'forbid', 'cfg_attr', 'doc']);
                if (!SKIP_ATTRS.has(attrName)) {
                    attributes.push(attrName);
                }
            }
        } else if (!line.startsWith('//')) {
            // Stop at non-comment, non-attribute lines
            break;
        }
    }

    return attributes;
}

/**
 * Extract attributes WITH their argument tokens (for routing decorator detection).
 * Returns array of { name, args: rawArgString } objects.
 *   #[get("/users")] → [{ name: 'get', args: '"/users"' }]
 *   #[tokio::main] → [{ name: 'tokio::main', args: null }]
 *
 * @param {Node} node - Function AST node
 * @param {string|string[]} codeOrLines - Source code or pre-split lines
 * @returns {Array<{name: string, args: string|null}>}
 */
function extractAttributesWithArgs(node, codeOrLines) {
    const result = [];
    const lines = Array.isArray(codeOrLines) ? codeOrLines : codeOrLines.split('\n');

    const startLine = node.startPosition.row;
    for (let i = startLine - 1; i >= 0 && i >= startLine - 5; i--) {
        const line = lines[i]?.trim();
        if (!line) break;
        if (line.startsWith('#[')) {
            // Match #[name(...args...)] or #[name]
            // Need to handle nested parens; use a simple bracket-matching approach.
            // (The line is trimmed: only a line ending in ']' can match; a
            // macro expansion's generated line can be very long.)
            const m = line.charCodeAt(line.length - 1) === 93 ? line.match(/^#\[(.+)\]\s*$/) : null;
            if (m) {
                const attrContent = m[1];
                const parenIdx = attrContent.indexOf('(');
                if (parenIdx === -1) {
                    result.unshift({ name: attrContent.trim(), args: null });
                } else {
                    const name = attrContent.slice(0, parenIdx).trim();
                    // Extract content within outer parens (find matching close)
                    let depth = 0;
                    let endIdx = -1;
                    for (let k = parenIdx; k < attrContent.length; k++) {
                        const ch = attrContent[k];
                        if (ch === '(') depth++;
                        else if (ch === ')') {
                            depth--;
                            if (depth === 0) { endIdx = k; break; }
                        }
                    }
                    const args = endIdx > parenIdx
                        ? attrContent.slice(parenIdx + 1, endIdx).trim()
                        : attrContent.slice(parenIdx + 1).trim();
                    result.unshift({ name, args });
                }
            }
        } else if (!line.startsWith('//')) {
            break;
        }
    }
    return result;
}

// --- Module-scope constants for state object detection ---
const _STATE_PATTERN = /^([A-Z][A-Z0-9_]+|DEFAULT_[A-Z_]+)$/;

// --- Single-pass helpers: extracted from find* callbacks ---

/**
 * Walk up AST ancestors to detect whether `node` is enclosed in a
 * `#[cfg(test)]` (or `#[cfg(any(test, ...))]`) module. Used to flag
 * functions inside a `mod tests` block as test entry points even when
 * they don't carry a direct `#[test]` attribute (BUG-CY).
 */
function _isInsideCfgTestModule(node, lines) {
    let parent = node.parent;
    while (parent) {
        if (parent.type === 'mod_item') {
            const startRow = parent.startPosition.row;
            // Look at preceding lines for #[cfg(test)] or #[cfg(any(test,...))] / #[cfg(all(...,test,...))]
            for (let i = startRow - 1; i >= 0 && i >= startRow - 5; i--) {
                const line = lines[i]?.trim();
                if (!line) break;
                if (line.startsWith('#[')) {
                    // Match #[cfg(...)] forms that include a `test` predicate.
                    // Conservatively look for the literal token `test` inside the cfg(...) args.
                    const m = line.match(/#\[\s*cfg\s*\(([^\]]*)\)\s*\]/);
                    if (m) {
                        const args = m[1];
                        // Word-boundary match for `test` to avoid matching e.g. `testing_module`.
                        if (/\btest\b/.test(args)) return true;
                    }
                } else if (!line.startsWith('//')) {
                    break;
                }
            }
        }
        parent = parent.parent;
    }
    return false;
}

/**
 * Process a node for function extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 */
function _processFunction(node, functions, processedRanges, lines, code) {
    if (node.type === 'function_item') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;
        processedRanges.add(rangeKey);

        // Skip functions inside impl/trait blocks (they're extracted as members)
        let parent = node.parent;
        if (parent && (parent.type === 'impl_item' || parent.type === 'trait_item' || parent.type === 'declaration_list')) {
            // declaration_list is the body of an impl/trait block
            const grandparent = parent.parent;
            if (grandparent && (grandparent.type === 'impl_item' || grandparent.type === 'trait_item')) {
                return true;  // Skip - this is an impl/trait method
            }
            if (parent.type === 'impl_item' || parent.type === 'trait_item') {
                return true;  // Skip - this is an impl/trait method
            }
        }

        const nameNode = node.childForFieldName('name');
        const paramsNode = node.childForFieldName('parameters');

        if (nameNode) {
            const { startLine, endLine, indent } = nodeToLocation(node, lines);
            const text = node.text;

            const qualifiers = rustFunctionQualifiers(node);
            const isAsync = qualifiers.async;
            const isUnsafe = qualifiers.unsafe;
            const isConst = qualifiers.const;
            const isExtern = qualifiers.extern;
            const futureReturn = rustFutureReturn(node, qualifiers);
            const visibility = extractVisibility(text);
            const returnType = extractReturnType(node);
            const iteratorItemType = extractRustIteratorItemType(node);
            const docstring = extractRustDocstring(lines, startLine);
            const generics = extractGenerics(node);
            const genericBounds = extractGenericBounds(node);
            const attributes = extractAttributes(node, lines);
            const attributesWithArgs = extractAttributesWithArgs(node, lines);
            const inCfgTest = _isInsideCfgTestModule(node, lines);
            const callbackParamTypes = extractRustCallbackParamTypes(paramsNode, node);

            const modifiers = [];
            if (visibility) modifiers.push(visibility);
            if (isAsync) modifiers.push('async');
            if (isUnsafe) modifiers.push('unsafe');
            if (isConst) modifiers.push('const');
            if (isExtern) modifiers.push('extern');
            // Add attributes like #[test] to modifiers
            for (const attr of attributes) {
                modifiers.push(attr);
            }
            // Mark functions inside #[cfg(test)] modules — they are test-only code
            // even if they lack a direct #[test] attribute (helpers used by tests).
            if (inCfgTest) modifiers.push('cfg_test_module');

            functions.push({
                name: nameNode.text,
                params: extractRustParams(paramsNode),
                paramsStructured: parseStructuredParams(paramsNode, 'rust'),
                ...(callbackParamTypes && { callbackParamTypes }),
                startLine,
                endLine,
                indent,
                modifiers,
                ...(returnType && { returnType }),
                ...(futureReturn && { futureReturn }),
                ...(iteratorItemType && { iteratorItemType }),
                ...(docstring && { docstring }),
                ...(generics && { generics }),
                ...(genericBounds && { genericBounds }),
                ...(attributesWithArgs.length > 0 && { attributesWithArgs })
            });
        }
        return true;
    }

    // Extern block declarations: extern "C" { fn foreign_func(); }
    if (node.type === 'foreign_mod_item') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;
        processedRanges.add(rangeKey);

        const declList = node.childForFieldName('body');
        if (declList) {
            for (let i = 0; i < declList.namedChildCount; i++) {
                const child = declList.namedChild(i);
                if (child.type === 'function_signature_item') {
                    const fName = child.childForFieldName('name');
                    const fParams = child.childForFieldName('parameters');
                    if (fName) {
                        const { startLine, endLine, indent } = nodeToLocation(child, lines);
                        const visibility = extractVisibility(child.text);
                        const returnType = extractReturnType(child);
                        const docstring = extractRustDocstring(lines, startLine);
                        const callbackParamTypes = extractRustCallbackParamTypes(fParams, child);
                        const iteratorItemType = extractRustIteratorItemType(child);
                        const modifiers = ['extern'];
                        if (visibility) modifiers.push(visibility);

                        functions.push({
                            name: fName.text,
                            params: extractRustParams(fParams),
                            paramsStructured: parseStructuredParams(fParams, 'rust'),
                            ...(callbackParamTypes && { callbackParamTypes }),
                            ...(iteratorItemType && { iteratorItemType }),
                            startLine,
                            endLine,
                            indent,
                            modifiers,
                            ...(returnType && { returnType }),
                            ...(docstring && { docstring })
                        });
                    }
                }
            }
        }
        return true;
    }

    return false;
}

function _macroBodyTree(tree) {
    let current = tree;
    for (;;) {
        const named = [];
        for (let i = 0; i < current.namedChildCount; i++) {
            named.push(current.namedChild(i));
        }
        if (named.length !== 1 || named[0].type !== 'token_tree') return current;
        current = named[0];
    }
}

function _macroTreeChildren(tree) {
    const children = [];
    for (let i = 0; i < tree.childCount; i++) {
        const child = tree.child(i);
        if (['{', '}', '(', ')', '[', ']'].includes(child.type)) continue;
        children.push(child);
    }
    return children;
}

function _macroPathConstruction(children, methodIndex) {
    const method = children[methodIndex];
    if (!method || !['new', 'default'].includes(method.text) ||
        children[methodIndex - 1]?.type !== '::' ||
        children[methodIndex + 1]?.type !== 'token_tree') {
        return null;
    }
    const typeNode = children[methodIndex - 2];
    if (!typeNode || !['identifier', 'type_identifier'].includes(typeNode.type) ||
        !/^[A-Z]/.test(typeNode.text)) {
        return null;
    }
    const path = [typeNode.text];
    let start = methodIndex - 2;
    while (start >= 2 && children[start - 1]?.type === '::') {
        const segment = children[start - 2];
        if (!segment || ![
            'identifier', 'type_identifier', 'metavariable', 'crate', 'self', 'super',
        ].includes(segment.type)) {
            break;
        }
        path.unshift(segment.text === '$crate' ? 'crate' : segment.text);
        start -= 2;
    }
    let end = methodIndex + 1;
    while (children[end + 1]?.type === '.' &&
        children[end + 2]?.type === 'identifier' &&
        children[end + 3]?.type === 'token_tree') {
        end += 3;
    }
    return {
        type: typeNode.text,
        qualifier: path.length > 1 ? path.slice(0, -1).join('::') : undefined,
        start,
        end,
    };
}

/**
 * Infer a macro's value type only from its transcriber's final expression.
 * This remains AST/token-tree driven: a constructor used merely as a temporary
 * is not enough. Supported compiler-stable shapes are:
 *   Type::new(...).builder_chain()
 *   let value = Type::new(...); ...; value
 * Recursive same-name rules delegate to the constructive rule, while a rule
 * ending in compile_error! is divergent and cannot introduce another value.
 */
function _inferMacroReturn(node, macroName) {
    const results = [];
    let sawRule = false;
    for (let i = 0; i < node.namedChildCount; i++) {
        const rule = node.namedChild(i);
        if (rule.type !== 'macro_rule') continue;
        sawRule = true;
        const right = rule.childForFieldName('right');
        if (!right) return {};
        const body = _macroBodyTree(right);
        const children = _macroTreeChildren(body);
        if (children.length === 0) {
            results.push({ kind: 'unknown' });
            continue;
        }

        const bindings = new Map();
        for (let j = 0; j < children.length; j++) {
            if (children[j].type !== 'let') continue;
            let nameIndex = j + 1;
            if (children[nameIndex]?.type === 'mutable_specifier') nameIndex++;
            const nameNode = children[nameIndex];
            if (nameNode?.type !== 'identifier') continue;
            let eq = nameIndex + 1;
            while (eq < children.length && children[eq].type !== '=' &&
                children[eq].type !== ';') eq++;
            if (children[eq]?.type !== '=') continue;
            let construction = null;
            let semi = eq + 1;
            for (; semi < children.length && children[semi].type !== ';'; semi++) {
                const candidate = _macroPathConstruction(children, semi);
                if (candidate && candidate.start === eq + 1) {
                    construction = candidate;
                    break;
                }
            }
            if (!construction) continue;
            const prior = bindings.get(nameNode.text);
            const identity = `${construction.qualifier || ''}\0${construction.type}`;
            if (prior && prior.identity !== identity) {
                bindings.set(nameNode.text, { ambiguous: true });
            } else if (!prior) {
                bindings.set(nameNode.text, { ...construction, identity });
            }
        }

        const tail = children[children.length - 1];
        if (tail.type === 'identifier' && bindings.has(tail.text) &&
            !bindings.get(tail.text).ambiguous) {
            const binding = bindings.get(tail.text);
            results.push({ kind: 'return', type: binding.type, qualifier: binding.qualifier });
            continue;
        }

        let direct = null;
        for (let j = 0; j < children.length; j++) {
            const candidate = _macroPathConstruction(children, j);
            if (candidate && candidate.end === children.length - 1) {
                direct = candidate;
                break;
            }
        }
        if (direct) {
            results.push({ kind: 'return', type: direct.type, qualifier: direct.qualifier });
            continue;
        }

        // Diverging compile_error!(...); commonly carries a trailing
        // semicolon. A recursive value-delegating rule may not: `foo!();`
        // returns unit, so only compile_error receives this allowance.
        const effectiveTailIndex = tail.type === ';'
            ? children.length - 2 : children.length - 1;
        const effectiveTail = children[effectiveTailIndex];
        const bang = children[effectiveTailIndex - 1];
        const macro = children[effectiveTailIndex - 2];
        if (bang?.type === '!' && effectiveTail?.type === 'token_tree' &&
            macro?.type === 'identifier') {
            if (macro.text === macroName && tail.type !== ';') {
                results.push({ kind: 'delegate' });
            } else if (macro.text === 'compile_error') results.push({ kind: 'never' });
            else results.push({ kind: 'unknown' });
            continue;
        }
        results.push({ kind: 'unknown' });
    }

    if (!sawRule) return {};
    const returns = results.filter(result => result.kind === 'return');
    const blockers = results.filter(result => !['return', 'delegate', 'never'].includes(result.kind));
    if (returns.length > 0 && blockers.length === 0) {
        const identities = new Set(returns.map(result =>
            `${result.qualifier || ''}\0${result.type}`));
        if (identities.size === 1) {
            return {
                returnType: returns[0].type,
                ...(returns[0].qualifier && {
                    returnTypeQualifier: returns[0].qualifier,
                }),
            };
        }
    }
    if (results.every(result => result.kind === 'never')) {
        return { macroNeverReturns: true };
    }
    return {};
}

/**
 * Process a node for type/class extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 * Note: for impl_item, caller should NOT skip subtrees (parse() always returns true)
 */
/**
 * Lexical scope of an item declared in a function body (fix #381): Rust
 * items in a block are visible throughout that block and nowhere else.
 */
function rustBlockItemScope(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.type === 'declaration_list' || parent.type === 'source_file') return {};
        if (parent.type === 'block') {
            return {
                lexicalScopeStartLine: parent.startPosition.row + 1,
                lexicalScopeEndLine: parent.endPosition.row + 1,
            };
        }
    }
    return {};
}

/**
 * How a struct's name works as a VALUE (fix #389): a unit struct (`struct
 * S;`) names its only value, a tuple struct (`struct T(u8);`) names its
 * constructor function; a braced struct's name is a type only.
 */
function rustStructValueShape(node) {
    const body = node.childForFieldName('body');
    if (!body) return 'unit';
    if (body.type === 'ordered_field_declaration_list') return 'tuple';
    return null;
}

function _processClass(node, types, processedRanges, lines, code) {
    // Struct and union items (a union is declared like a braced struct;
    // its fields are its members, fix #389)
    if (node.type === 'struct_item' || node.type === 'union_item') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;
        processedRanges.add(rangeKey);

        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const { startLine, endLine } = nodeToLocation(node, lines);
            const docstring = extractRustDocstring(lines, startLine);
            const visibility = extractVisibility(node.text);
            const generics = extractGenerics(node);
            const members = extractStructFields(node, lines);
            const attributes = extractAttributes(node, lines);
            const modifiers = visibility ? [visibility] : [];
            for (const attr of attributes) modifiers.push(attr);
            const valueShape = node.type === 'struct_item' ? rustStructValueShape(node) : null;

            types.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: node.type === 'union_item' ? 'union' : 'struct',
                members,
                modifiers,
                ...(valueShape && { valueShape }),
                ...rustBlockItemScope(node),
                ...(docstring && { docstring }),
                ...(generics && { generics })
            });
        }
        return true;
    }

    // Enum items
    if (node.type === 'enum_item') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;
        processedRanges.add(rangeKey);

        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const { startLine, endLine } = nodeToLocation(node, lines);
            const docstring = extractRustDocstring(lines, startLine);
            const visibility = extractVisibility(node.text);
            const generics = extractGenerics(node);
            const attributes = extractAttributes(node, lines);
            const modifiers = visibility ? [visibility] : [];
            for (const attr of attributes) modifiers.push(attr);

            types.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'enum',
                members: extractEnumVariants(node, lines),
                modifiers,
                ...rustBlockItemScope(node),
                ...(docstring && { docstring }),
                ...(generics && { generics })
            });
        }
        return true;
    }

    // Trait items
    if (node.type === 'trait_item') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;
        processedRanges.add(rangeKey);

        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const { startLine, endLine } = nodeToLocation(node, lines);
            const docstring = extractRustDocstring(lines, startLine);
            const visibility = extractVisibility(node.text);
            const generics = extractGenerics(node);
            const supertraits = extractRustSupertraits(node);

            types.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'trait',
                members: extractTraitMembers(node, lines),
                modifiers: visibility ? [visibility] : [],
                ...rustBlockItemScope(node),
                ...(docstring && { docstring }),
                ...(generics && { generics }),
                ...(supertraits && { supertraits }),
            });
        }
        return true;
    }

    // Impl items
    if (node.type === 'impl_item') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;
        processedRanges.add(rangeKey);

        const { startLine, endLine } = nodeToLocation(node, lines);
        const implInfo = extractImplInfo(node);
        const docstring = extractRustDocstring(lines, startLine);
        const derefTarget = extractDerefTarget(node, implInfo.traitName);
        const implSelfTypeNode = node.childForFieldName('type');
        const implSelfRef = implSelfTypeNode?.type === 'reference_type'
            ? (implSelfTypeNode.namedChildren.some(child => child.type === 'mutable_specifier')
                ? '&mut' : '&')
            : null;
        const blanketSelfBounds = implInfo.traitName
            ? extractRustBlanketSelfBounds(node, implSelfTypeNode) : null;

        types.push({
            name: implInfo.name,
            startLine,
            endLine,
            type: 'impl',
            traitName: implInfo.traitName,
                ...rustBlockItemScope(node),
            typeName: implInfo.typeName,
            members: extractImplMembers(node, lines, implInfo.typeName),
            modifiers: [],
            ...(implInfo.generics && { generics: implInfo.generics }),
            ...(implSelfRef && { implSelfRef }),
            ...(blanketSelfBounds && { blanketSelfBounds }),
            ...(derefTarget && { derefTarget }),
            ...(docstring && { docstring })
        });
        return true;  // matched
    }

    // Module items
    if (node.type === 'mod_item') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;
        processedRanges.add(rangeKey);

        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const { startLine, endLine } = nodeToLocation(node, lines);
            const docstring = extractRustDocstring(lines, startLine);
            const visibility = extractVisibility(node.text);
            const attributes = extractAttributes(node, lines);
            const modifiers = visibility ? [visibility] : [];
            for (const attr of attributes) modifiers.push(attr);

            types.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'module',
                members: [],
                modifiers,
                ...(docstring && { docstring })
            });
        }
        return true;
    }

    // Macro definitions
    if (node.type === 'macro_definition') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;
        processedRanges.add(rangeKey);

        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const { startLine, endLine } = nodeToLocation(node, lines);
            const docstring = extractRustDocstring(lines, startLine);
            const inferred = _inferMacroReturn(node, nameNode.text);

            // Attributes and the textual scope a macro_rules! definition is
            // visible in (fix #374: macro expansion resolves invocations by
            // Rust's textual scoping without re-parsing the defining file).
            const modifiers = rustAttributeNames(node).filter(name => name === 'macro_export' || name === 'cfg');
            let macroScope = null;
            for (let parent = node.parent; parent && parent.type !== 'source_file'; parent = parent.parent) {
                if (parent.type === 'block' ||
                    (parent.type === 'declaration_list' && parent.parent?.type === 'mod_item')) {
                    const mod = parent.type === 'declaration_list';
                    const macroUse = mod && rustAttributeNames(parent.parent).includes('macro_use');
                    macroScope = {
                        kind: mod ? 'mod' : 'block',
                        startLine: parent.startPosition.row + 1, endLine: parent.endPosition.row + 1,
                        ...(macroUse && { macroUse: true }),
                    };
                    break;
                }
            }

            types.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'macro',
                members: [],
                modifiers,
                ...(macroScope && { macroScope }),
                ...inferred,
                ...(docstring && { docstring })
            });
        }
        return true;
    }

    // Type aliases (only top-level, not inside traits/impls)
    if (node.type === 'type_item') {
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (processedRanges.has(rangeKey)) return true;

        // Skip if inside trait or impl
        let parent = node.parent;
        while (parent) {
            if (parent.type === 'trait_item' || parent.type === 'impl_item') {
                return true;  // Skip this one
            }
            parent = parent.parent;
        }

        processedRanges.add(rangeKey);

        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const { startLine, endLine } = nodeToLocation(node, lines);
            const docstring = extractRustDocstring(lines, startLine);
            const visibility = extractVisibility(node.text);
            // `pub type StyledString = SpannedString<Style>;` — the alias IS
            // the aliased type (compiler identity). Record the base name so
            // callers can treat alias-qualified receivers as the base type
            // (fix #208 — cursive StyledString::plain).
            const aliasOf = aliasBaseTypeName(node.childForFieldName('type'));
            // An alias of a future type (`type Fut = Pin<Box<dyn Future..>>`)
            // makes functions returning it future producers (fix #370).
            const futureShape = rustFutureShape(node.childForFieldName('type'));

            types.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'type',
                members: [],
                modifiers: visibility ? [visibility] : [],
                ...(aliasOf && { aliasOf }),
                ...(futureShape && { futureReturn: { kind: 'future', output: futureShape.output } }),
                aliasTypeText: node.childForFieldName('type')?.text,
                aliasTypeParameters: (node.childForFieldName('type_parameters')?.namedChildren || [])
                    .map(parameter => parameter.type === 'type_identifier' ? parameter.text
                        : parameter.childForFieldName('name')?.text ||
                            parameter.namedChildren.find(child => child.type === 'type_identifier')?.text)
                    .map(name => name || null),
                aliasTypeDefaults: (node.childForFieldName('type_parameters')?.namedChildren || [])
                    .map(parameter => parameter.childForFieldName('default_type')?.text || null),
                ...(docstring && { docstring })
            });
        }
        return true;
    }

    return false;
}

/**
 * Post-process types: surface trait impls as 'implements' on the corresponding struct/enum
 */
function _postProcessTraitImpls(types) {
    const implTraits = new Map(); // typeName → [traitName, ...]
    const derefTargets = new Map(); // typeName -> Set<Target>
    for (const t of types) {
        if (t.type === 'impl' && t.traitName && t.typeName) {
            if (!implTraits.has(t.typeName)) implTraits.set(t.typeName, []);
            implTraits.get(t.typeName).push(t.traitName);
            if (t.derefTarget) {
                if (!derefTargets.has(t.typeName)) derefTargets.set(t.typeName, new Set());
                derefTargets.get(t.typeName).add(t.derefTarget);
            }
        }
    }
    for (const t of types) {
        if ((t.type === 'struct' || t.type === 'enum') && implTraits.has(t.name)) {
            t.implements = implTraits.get(t.name);
            const targets = derefTargets.get(t.name);
            if (targets?.size === 1) t.derefTarget = [...targets][0];
        }
    }
}

function extractDerefTarget(implNode, traitName) {
    if (!traitName || !/(^|::)Deref(?:Mut)?$/.test(traitName)) return null;
    let found = null;
    const walk = node => {
        if (found) return;
        if (node.type === 'type_item' && node.childForFieldName('name')?.text === 'Target') {
            found = aliasBaseTypeName(node.childForFieldName('type'));
            return;
        }
        for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i));
    };
    walk(implNode);
    return found;
}

/**
 * Process a node for state object extraction (single-pass helper)
 * Returns true if node was matched, false otherwise
 */
function _processState(node, objects, lines) {
    // Handle const and static items (only top-level). The declared type
    // (fix #392) types the item when it is a method receiver (`FLAGS.iter()`).
    if (node.type === 'const_item' || node.type === 'static_item') {
        if (!node.parent || node.parent.type !== 'source_file') return false;
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const name = nameNode.text;
            if (_STATE_PATTERN.test(name)) {
                const { startLine, endLine } = nodeToLocation(node, lines);
                // Only a plain type path (behind any references) is recorded:
                // a generic wrapper (`Lazy<T>`, `Mutex<T>`) owns the methods
                // or derefs to its argument. A `static mut` is never typed.
                let typeNode = node.childForFieldName('type');
                // A std deref wrapper (`LazyLock<Store>`, fix #401) receives
                // as its target; the chain is recorded for the query.
                const deref = rustStdDerefChain(typeNode);
                if (deref) typeNode = deref.inner;
                while (typeNode?.type === 'reference_type') typeNode = typeNode.childForFieldName('type');
                const mutable = node.type === 'static_item' &&
                    node.children.some(child => child.type === 'mutable_specifier');
                const plain = typeNode && (typeNode.type === 'type_identifier' ||
                    typeNode.type === 'scoped_type_identifier');
                objects.push({ name, startLine, endLine,
                    ...(plain && !mutable && { valueType: typeNode.text,
                        ...(deref && { valueDerefVia: deref.via }) }) });
            }
        }
        return true;
    }

    return false;
}

// --- End single-pass helpers ---

/**
 * Find all functions in Rust code using tree-sitter
 */
function findFunctions(code, parser) {
    const { trees } = declarationTrees(code, parser);
    const lines = code.split('\n');
    const functions = [];
    const processedRanges = new Set();
    for (const tree of trees) {
        traverseTreeCached(tree.rootNode, (node) => {
            _processFunction(node, functions, processedRanges, lines, code);
            return true;
        });
    }
    functions.sort((a, b) => a.startLine - b.startLine);
    return functions;
}

/**
 * Extract generics from a node
 */
function extractGenerics(node) {
    const typeParamsNode = node.childForFieldName('type_parameters');
    if (typeParamsNode) {
        return typeParamsNode.text;
    }
    return null;
}

/**
 * Compiler-declared Rust type-parameter bounds from both `<T: Trait>` and
 * `where T: Trait`. Keep only nominal trait heads from AST type nodes;
 * lifetimes and unparseable shapes add no evidence.
 */
function extractGenericBounds(node) {
    const result = new Map();
    const record = declaration => {
        if (!declaration) return;
        const children = declaration.namedChildren || [];
        // `where for<'a> C: Trait<'a>` bounds C itself (fix #368).
        const higherRanked = children.find(child => child.type === 'higher_ranked_trait_bound');
        const parameter = children.find(child => child.type === 'type_identifier') ||
            (higherRanked?.namedChildren || []).find(child => child.type === 'type_identifier');
        const bounds = children.find(child => child.type === 'trait_bounds');
        if (!parameter || !bounds) return;
        const names = bounds.namedChildren
            .map(bound => aliasBaseTypeName(bound))
            .filter(Boolean);
        if (names.length === 0) return;
        if (!result.has(parameter.text)) result.set(parameter.text, new Set());
        for (const name of names) result.get(parameter.text).add(name);
    };
    const typeParameters = node.childForFieldName('type_parameters');
    for (const child of typeParameters?.namedChildren || []) {
        if (child.type === 'constrained_type_parameter') record(child);
    }
    const whereClause = node.namedChildren.find(child => child.type === 'where_clause');
    for (const child of whereClause?.namedChildren || []) {
        if (child.type === 'where_predicate') record(child);
    }
    if (result.size === 0) return null;
    return Object.fromEntries([...result].map(([name, bounds]) =>
        [name, [...bounds].sort()]));
}

/**
 * Declared supertraits of a trait (fix #368): `trait C<I>: Send + Sized`
 * and `where Self: P`. Nominal trait heads only (paths keep their terminal
 * name, `?Sized` and lifetimes add nothing).
 */
function extractRustSupertraits(traitNode) {
    const names = new Set();
    const addBounds = (boundsNode) => {
        for (const bound of boundsNode?.namedChildren || []) {
            if (bound.type === 'removed_trait_bound' || bound.type === 'lifetime') continue;
            const name = aliasBaseTypeName(bound.type === 'higher_ranked_trait_bound'
                ? bound.childForFieldName('type') || bound.namedChildren.at(-1) : bound);
            if (name) names.add(name);
        }
    };
    addBounds(traitNode.childForFieldName('bounds'));
    const whereClause = traitNode.namedChildren.find(child => child.type === 'where_clause');
    for (const predicate of whereClause?.namedChildren || []) {
        if (predicate.type !== 'where_predicate') continue;
        if (predicate.childForFieldName('left')?.text !== 'Self') continue;
        addBounds(predicate.childForFieldName('bounds'));
    }
    return names.size > 0 ? [...names].sort() : null;
}

/**
 * `[T]` behind any reference layers (`&[T]`, `&mut [T]`) is the primitive
 * slice type (fix #368). Its methods are the slice's inherent methods and
 * trait impls written `for [T]`; the canonical receiver name is 'slice'.
 * Arrays (`[T; N]`) unsize to slices during method probing and abstain.
 */
function rustSliceTypeOf(typeNode) {
    let current = typeNode;
    while (current?.type === 'reference_type') current = current.childForFieldName('type');
    return current?.type === 'array_type' && !current.childForFieldName('length') ? 'slice' : null;
}

/**
 * A raw pointer type behind any reference layers (`*const T`, `*mut T`) is a
 * primitive type (fix #399): its methods are the pointer's inherent methods
 * and trait impls written `for *const T` / `for *mut T`. Canonical receiver
 * names '*const' and '*mut'; raw pointers never auto-deref.
 */
function rustRawPointerTypeOf(typeNode) {
    let current = typeNode;
    while (current?.type === 'reference_type') current = current.childForFieldName('type');
    if (current?.type !== 'pointer_type') return null;
    return current.children.some(child => child.type === 'mutable_specifier') ? '*mut' : '*const';
}

/**
 * Standard-library wrappers whose `Deref::Target` is their (first) type
 * argument (fix #401): smart pointers, `ManuallyDrop`, lazy cells, `RefCell`
 * borrow guards, lock guards, `AssertUnwindSafe`, `Cow` (Target = its
 * borrowed form) and `Pin<P>` (Target = P's own target). Method probing
 * visits the wrapper first, then its target. Only the written name is
 * recorded here; the query checks that it denotes the std type.
 */
const RUST_STD_DEREF_WRAPPERS = new Set(['Box', 'Rc', 'Arc', 'ManuallyDrop', 'LazyLock',
    'LazyCell', 'Ref', 'RefMut', 'MutexGuard', 'RwLockReadGuard', 'RwLockWriteGuard',
    'ReentrantLockGuard', 'AssertUnwindSafe', 'Cow', 'Pin']);

/**
 * The std deref wrappers a declared type is written with, outermost first,
 * and the type they deref to: `&Arc<Store>` -> { via: ['Arc'], inner:
 * Store }, `Pin<Box<T>>` -> via ['Pin', 'Box']. null when the outermost
 * named type is not such a wrapper.
 */
function rustStdDerefChain(typeNode) {
    let current = typeNode;
    const via = [];
    for (let hop = 0; hop < 6; hop++) {
        while (current?.type === 'reference_type') current = current.childForFieldName('type');
        if (current?.type !== 'generic_type') break;
        const head = current.childForFieldName('type') || current.namedChild(0);
        const name = head?.type === 'type_identifier' ? head.text
            : head?.type === 'scoped_type_identifier' ? head.childForFieldName('name')?.text : null;
        if (!name || !RUST_STD_DEREF_WRAPPERS.has(name)) break;
        const argsNode = current.childForFieldName('type_arguments') ||
            current.namedChildren.find(child => child.type === 'type_arguments');
        const args = (argsNode?.namedChildren || []).filter(child =>
            child.type !== 'lifetime' && !child.type.endsWith('comment'));
        if (args.length === 0) break;
        via.push(head.text.replace(/\s+/g, ''));
        current = args[0];
    }
    return via.length > 0 ? { via, inner: current } : null;
}

/** Is `name` a type parameter declared by an item enclosing `node`? */
function rustTypeParamInScope(node, name) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (!['function_item', 'impl_item', 'trait_item', 'struct_item', 'enum_item',
            'function_signature_item'].includes(parent.type)) continue;
        const params = parent.childForFieldName('type_parameters');
        for (const param of params?.namedChildren || []) {
            const nameNode = param.type === 'type_identifier' ? param
                : param.childForFieldName('name') || param.namedChildren.find(child => child.type === 'type_identifier');
            if (nameNode?.text === name) return true;
        }
    }
    return false;
}

/**
 * A declared type behind std deref wrappers (fix #401): the target's type
 * name and the wrapper chain, or null. A target that is a type parameter
 * of an enclosing item (`Box<T>`) has no name: { via, typeName: null }.
 */
function rustDerefTypedName(typeNode) {
    const chain = rustStdDerefChain(typeNode);
    if (!chain) return null;
    const written = extractTypeName(chain.inner);
    // A slice or raw pointer target (`Box<[u8]>`) has its canonical name.
    const primitive = !written ? rustSliceTypeOf(chain.inner) || rustRawPointerTypeOf(chain.inner) : null;
    const typeName = primitive || (written === 'Self' ? findEnclosingImplType(chain.inner) || null
        : written && !rustTypeParamInScope(chain.inner, written) ? written : null);
    return { via: chain.via, typeName, inner: chain.inner, ...(primitive && { std: true }),
        outerRef: rustTypeRefKind(typeNode) };
}

/** Reference layer of a declared type node: 'owned', '&' or '&mut'. */
function rustTypeRefKind(typeNode) {
    if (typeNode?.type !== 'reference_type') return 'owned';
    return typeNode.namedChildren.some(child => child.type === 'mutable_specifier') ? '&mut' : '&';
}

/**
 * How a method takes `self`: 'value' (`self`, `mut self`), '&' (`&self`),
 * '&mut' (`&mut self`); null for associated functions or typed self
 * (`self: Box<Self>`), which method probing here does not model.
 */
function rustSelfParamKind(paramsNode) {
    const selfParameter = paramsNode?.namedChildren?.find(child => child.type === 'self_parameter');
    if (!selfParameter) return null;
    let reference = false;
    let mutable = false;
    for (let i = 0; i < selfParameter.childCount; i++) {
        const child = selfParameter.child(i);
        if (child.type === '&') reference = true;
        else if (child.type === 'mutable_specifier' && reference) mutable = true;
    }
    if (!reference) return 'value';
    return mutable ? '&mut' : '&';
}

/**
 * Generic arguments of an impl's self type, in declaration order, lifetimes
 * excluded: `impl<'f, T, C> Consumer<T> for MapWith<'f, C, U>` -> ['C', 'U'].
 * Maps a struct's positional type parameters to the impl's own names.
 */
function extractRustImplSelfArgs(implNode) {
    let typeNode = implNode.childForFieldName('type');
    while (typeNode?.type === 'reference_type') typeNode = typeNode.childForFieldName('type');
    if (typeNode?.type !== 'generic_type') return null;
    const argsNode = typeNode.childForFieldName('type_arguments');
    const args = [];
    for (const arg of argsNode?.namedChildren || []) {
        if (arg.type === 'lifetime' || arg.type.endsWith('comment')) continue;
        args.push(arg.text);
    }
    return args.length > 0 ? args : null;
}

/**
 * Find all types (structs, enums, traits, impls) in Rust code
 */
function findClasses(code, parser) {
    const { trees } = declarationTrees(code, parser);
    const lines = code.split('\n');
    const types = [];
    const processedRanges = new Set();
    for (const tree of trees) {
        traverseTreeCached(tree.rootNode, (node) => {
            const matched = _processClass(node, types, processedRanges, lines, code);
            // For impl_item, don't traverse into impl body (original behavior)
            if (matched && node.type === 'impl_item') return false;
            return true;
        });
    }
    _postProcessTraitImpls(types);
    types.sort((a, b) => a.startLine - b.startLine);
    return types;
}

/**
 * Extract struct fields
 */
function extractStructFields(structNode, codeOrLines) {
    const code = codeOrLines;
    const fields = [];
    const bodyNode = structNode.childForFieldName('body');
    if (!bodyNode) return fields;

    if (bodyNode.type === 'ordered_field_declaration_list') {
        let position = 0;
        for (let i = 0; i < bodyNode.namedChildCount; i++) {
            const field = bodyNode.namedChild(i);
            // Visibility modifiers and field attributes (`#[serde(..)] u32`)
            // are separate children; the type node owns the tuple position.
            // Numeric member names let the shared declared-field hop resolve
            // `self.0.method()` exactly.
            if (field.type === 'visibility_modifier' ||
                field.type === 'attribute_item') continue;
            const { startLine, endLine } = nodeToLocation(field, code);
            fields.push({
                name: String(position++),
                startLine,
                endLine,
                memberType: 'field',
                fieldType: field.text,
            });
        }
        return fields;
    }

    for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const field = bodyNode.namedChild(i);
        if (field.type === 'field_declaration') {
            const { startLine, endLine } = nodeToLocation(field, code);
            const nameNode = field.childForFieldName('name');
            const typeNode = field.childForFieldName('type');

            if (nameNode) {
                // Record the field's own visibility (pub / pub(crate) / ...) so
                // export listings can judge members per-symbol (fix #241 —
                // pub fields were invisible to fileExports, and private fields
                // used to leak in via name collision with file-level exports).
                const visibility = extractVisibility(field.text);
                fields.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    memberType: 'field',
                    ...(visibility && { modifiers: [visibility] }),
                    ...(typeNode && { fieldType: typeNode.text })
                });
            }
        }
    }

    return fields;
}

/**
 * Extract impl block info
 */
/**
 * Bounds of a blanket impl's self parameter (fix #369): for `impl<I: A>
 * Trait for I where &'a mut I: B, I: C`, one entry per subject reference
 * layer: [{ ref: 'owned', traits: ['A', 'C'] }, { ref: '&mut', traits:
 * ['B'] }]. `?Sized` and lifetimes add nothing. null when the impl's self
 * type is not one of its own type parameters.
 */
function extractRustBlanketSelfBounds(implNode, selfTypeNode) {
    if (!selfTypeNode || selfTypeNode.type !== 'type_identifier') return null;
    const param = selfTypeNode.text;
    const typeParameters = implNode.childForFieldName('type_parameters');
    const declared = (typeParameters?.namedChildren || []).some(child =>
        (child.type === 'constrained_type_parameter' &&
            child.namedChildren.some(n => n.type === 'type_identifier' && n.text === param)) ||
        (child.type === 'type_identifier' && child.text === param) ||
        (child.type === 'type_parameter' && child.text.split(/[\s:=]/)[0] === param));
    if (!declared) return null;
    const layers = new Map();
    const add = (layer, boundsNode) => {
        for (const bound of boundsNode?.namedChildren || []) {
            if (bound.type === 'removed_trait_bound' || bound.type === 'lifetime') continue;
            const name = aliasBaseTypeName(bound.type === 'higher_ranked_trait_bound'
                ? bound.childForFieldName('type') || bound.namedChildren.at(-1) : bound);
            if (!name) continue;
            if (!layers.has(layer)) layers.set(layer, new Set());
            layers.get(layer).add(name);
        }
    };
    for (const child of typeParameters?.namedChildren || []) {
        if (child.type !== 'constrained_type_parameter') continue;
        if (!child.namedChildren.some(n => n.type === 'type_identifier' && n.text === param)) continue;
        add('owned', child.namedChildren.find(n => n.type === 'trait_bounds'));
    }
    const whereClause = implNode.namedChildren.find(child => child.type === 'where_clause');
    for (const predicate of whereClause?.namedChildren || []) {
        if (predicate.type !== 'where_predicate') continue;
        const left = predicate.childForFieldName('left') || predicate.namedChild(0);
        const bounds = predicate.childForFieldName('bounds') ||
            predicate.namedChildren.find(n => n.type === 'trait_bounds');
        if (!left) continue;
        if (left.type === 'type_identifier' && left.text === param) {
            add('owned', bounds);
        } else if (left.type === 'reference_type') {
            const inner = left.namedChildren.find(n => n.type === 'type_identifier');
            if (inner?.text !== param) continue;
            add(left.namedChildren.some(n => n.type === 'mutable_specifier') ? '&mut' : '&', bounds);
        }
    }
    return [...layers].map(([ref, traits]) => ({ ref, traits: [...traits].sort() }))
        .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

function extractImplInfo(implNode) {
    let traitName = null;
    let typeName = null;
    const typeParamsNode = implNode.childForFieldName('type_parameters');
    const typeParams = typeParamsNode ? typeParamsNode.text.trim() : '';

    const traitNode = implNode.childForFieldName('trait');
    const typeNode = implNode.childForFieldName('type');

    if (traitNode) {
        traitName = traitNode.text;
    }

    if (typeNode) {
        typeName = typeNode.text;
    }

    // Resolve the AST head instead of stripping generic text with a regex.
    // Nested type arguments (`Deserializer<read::StrRead<'a>>`) defeated the
    // old `<[^>]*>` expression and left the impossible owner
    // `Deserializer>`. Reference impls (`impl Trait for &'a mut Writer<T>`)
    // likewise need the referent owner so declared-field receiver evidence
    // and method definitions use the same identity.
    const stripGenerics = (s) => s ? s.replace(/<.*$/s, '').trim() : s;
    const bareTypeName = extractImplTypeHead(typeNode) || stripGenerics(typeName);
    const bareTraitName = extractImplTypeHead(traitNode) || stripGenerics(traitName);

    let name;
    if (bareTraitName && bareTypeName) {
        // Use the concrete type as className so Task.get_id works for `impl Entity for Task`
        name = bareTypeName;
    } else if (bareTypeName) {
        name = bareTypeName;
    } else {
        const text = implNode.text;
        const match = text.match(/impl\s*(?:<[^>]+>\s*)?(\w+(?:\s+for\s+\w+)?)/);
        name = match ? match[1] : 'impl';
    }

    return { name, traitName, typeName: bareTypeName, generics: typeParams || undefined };
}

/**
 * Concrete lookup head of a Rust impl type.
 *
 * Generic wrappers remain their outer owner (`Box<Foo>` → `Box`), while
 * transparent references unwrap (`&mut Foo` → `Foo`). Scoped types use their
 * terminal name. Returning null for shapes without a named owner preserves
 * the conservative text fallback in extractImplInfo.
 */
function extractImplTypeHead(typeNode) {
    if (!typeNode) return null;
    if (typeNode.type === 'type_identifier' ||
        typeNode.type === 'primitive_type') {
        return typeNode.text;
    }
    if (typeNode.type === 'scoped_type_identifier') {
        return typeNode.childForFieldName('name')?.text || null;
    }
    if (typeNode.type === 'reference_type' ||
        typeNode.type === 'parenthesized_type') {
        const inner = typeNode.childForFieldName('type') ||
            typeNode.namedChildren?.find(child =>
                !['lifetime', 'mutable_specifier'].includes(child.type));
        return extractImplTypeHead(inner);
    }
    if (typeNode.type === 'generic_type') {
        return extractImplTypeHead(typeNode.childForFieldName('type') ||
            typeNode.namedChild(0));
    }
    return null;
}

/**
 * Extract enum variants
 */
function extractEnumVariants(enumNode, codeOrLines) {
    const code = codeOrLines;
    const variants = [];
    const bodyNode = enumNode.childForFieldName('body');
    if (!bodyNode) return variants;

    for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const child = bodyNode.namedChild(i);
        if (child.type === 'enum_variant') {
            const nameNode = child.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(child, code);
                // Check for tuple/struct variant data
                let params = undefined;
                // A unit variant names its value, a tuple variant its
                // constructor (fix #389); a struct variant only a path.
                let valueShape = 'unit';
                for (let j = 0; j < child.namedChildCount; j++) {
                    const variantChild = child.namedChild(j);
                    if (variantChild.type === 'field_declaration_list' || variantChild.type === 'ordered_field_declaration_list') {
                        params = variantChild.text.slice(1, -1);
                        valueShape = variantChild.type === 'ordered_field_declaration_list' ? 'tuple' : null;
                    }
                }
                variants.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    memberType: 'variant',
                    ...(params !== undefined && { params }),
                    ...(valueShape && { valueShape }),
                });
            }
        }
    }
    return variants;
}

/**
 * Extract trait method signatures
 */
function extractTraitMembers(traitNode, codeOrLines) {
    const code = codeOrLines;
    const members = [];
    const bodyNode = traitNode.childForFieldName('body');
    if (!bodyNode) return members;

    for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const child = bodyNode.namedChild(i);
        if (child.type === 'function_item' || child.type === 'function_signature_item') {
            const nameNode = child.childForFieldName('name');
            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(child, code);
                const paramsNode = child.childForFieldName('parameters');
                const returnType = extractReturnType(child);
                const iteratorItemType = extractRustIteratorItemType(child);
                const hasSelf = paramsNode && paramsNode.text.includes('self');
                const callbackParamTypes = extractRustCallbackParamTypes(paramsNode, child);
                const qualifiers = rustFunctionQualifiers(child);
                const futureReturn = rustFutureReturn(child, qualifiers);

                // Rust vocabulary (fix #248): trait members carry the trait's
                // OWN visibility — a method of a private trait is not `pub`,
                // and 'public' is not a Rust modifier ('pub'/'pub(crate)'/...).
                const traitVisibility = extractVisibility(traitNode.text);
                members.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    memberType: 'method',
                    isMethod: true,
                    ...(qualifiers.async && { isAsync: true }),
                    modifiers: [...(traitVisibility ? [traitVisibility] : []), ...(qualifiers.async ? ['async'] : [])],
                    ...(futureReturn && { futureReturn }),
                    ...(paramsNode && { params: extractRustParams(paramsNode) }),
                    ...(paramsNode && { paramsStructured: parseStructuredParams(paramsNode, 'rust') }),
                    ...(callbackParamTypes && { callbackParamTypes }),
                    ...(returnType && { returnType }),
                    ...(iteratorItemType && { iteratorItemType }),
                    ...(hasSelf && { receiver: 'self' })
                });
            }
        }
    }
    return members;
}

/**
 * Extract impl block members (functions)
 * @param {Node} implNode - The impl block AST node
 * @param {string} code - Source code
 * @param {string} [typeName] - The type this impl is for (e.g., "MyStruct")
 */
/**
 * `Self::Assoc` projections in an impl member's return type, resolved
 * through the SAME impl block's `type Assoc = T;` items (fix #368):
 * `type Folder = CollectResult<'c, T>; fn into_folder(self) -> Self::Folder`
 * declares the concrete `CollectResult<'c, T>`. Returns the substituted
 * return-type text, or null when nothing (or not everything) resolves.
 */
function rustResolveSelfProjections(functionNode, associatedTypes) {
    const returnTypeNode = functionNode.childForFieldName('return_type');
    if (!returnTypeNode || associatedTypes.size === 0) return null;
    const replacements = [];
    let unresolved = false;
    const pending = [returnTypeNode];
    while (pending.length > 0) {
        const current = pending.pop();
        if (current.type.endsWith('comment')) return null;
        if (current.type === 'scoped_type_identifier' &&
            current.childForFieldName('path')?.text === 'Self') {
            const assoc = associatedTypes.get(current.childForFieldName('name')?.text);
            if (!assoc) unresolved = true;
            else replacements.push({ start: current.startIndex, end: current.endIndex, text: assoc });
            continue;
        }
        for (let i = 0; i < current.namedChildCount; i++) pending.push(current.namedChild(i));
    }
    if (unresolved || replacements.length === 0) return null;
    replacements.sort((a, b) => b.start - a.start);
    const base = returnTypeNode.startIndex;
    let text = returnTypeNode.text;
    for (const replacement of replacements) {
        text = text.slice(0, replacement.start - base) + replacement.text +
            text.slice(replacement.end - base);
    }
    return text.trim() || null;
}

/**
 * Associated types visible as `Self::X` inside an impl: its own items plus
 * those of sibling impl blocks for the same self type in the same module
 * scope (supertrait associated types). A name defined with different values
 * by two sibling impls is ambiguous and dropped.
 */
function rustSiblingAssociatedTypes(implNode, own) {
    const selfText = implNode.childForFieldName('type')?.text;
    const merged = new Map(own);
    const scope = implNode.parent;
    if (!selfText || !scope) return merged;
    const conflicting = new Set();
    for (let i = 0; i < scope.namedChildCount; i++) {
        const sibling = scope.namedChild(i);
        if (sibling.type !== 'impl_item' || sibling.id === implNode.id ||
            sibling.childForFieldName('type')?.text !== selfText) continue;
        const body = sibling.childForFieldName('body');
        for (let j = 0; j < (body?.namedChildCount || 0); j++) {
            const item = body.namedChild(j);
            if (item.type !== 'type_item') continue;
            const name = item.childForFieldName('name')?.text;
            const value = item.childForFieldName('type')?.text;
            if (!name || !value || own.has(name) || /\/[/*]/.test(value)) continue;
            if (merged.has(name) && merged.get(name) !== value) conflicting.add(name);
            else merged.set(name, value);
        }
    }
    for (const name of conflicting) merged.delete(name);
    return merged;
}

/**
 * The module path an impl's self type is written under (fix #371):
 * `impl Ext for std::fs::File` -> 'std::fs', through `&`/`&mut` and generic
 * arguments. null for an unqualified self type.
 */
function rustImplSelfQualifier(implSelfTypeNode) {
    let node = implSelfTypeNode;
    while (node?.type === 'reference_type') node = node.childForFieldName('type');
    if (node?.type === 'generic_type') node = node.childForFieldName('type');
    if (node?.type !== 'scoped_type_identifier') return null;
    return node.childForFieldName('path')?.text || null;
}

function extractImplMembers(implNode, codeOrLines, typeName) {
    const code = codeOrLines;
    const members = [];
    const bodyNode = implNode.childForFieldName('body');
    if (!bodyNode) return members;
    const implAttributes = extractAttributes(implNode, codeOrLines);
    const ownerGenericBounds = extractGenericBounds(implNode);
    const ownerSelfArgs = extractRustImplSelfArgs(implNode);
    // Reference impls (`impl Trait for &'a Vec<T>`) share the owner name with
    // the owned impl; the reference layer decides method probing (fix #368).
    const implSelfTypeNode = implNode.childForFieldName('type');
    const implSelfRef = implSelfTypeNode?.type === 'reference_type'
        ? (implSelfTypeNode.namedChildren.some(child => child.type === 'mutable_specifier')
            ? '&mut' : '&')
        : null;
    const implSelfQualifier = rustImplSelfQualifier(implSelfTypeNode);
    const associatedTypes = new Map();
    for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const item = bodyNode.namedChild(i);
        if (item.type !== 'type_item') continue;
        const nameNode = item.childForFieldName('name');
        const valueNode = item.childForFieldName('type');
        if (nameNode && valueNode && !/\/[/*]/.test(valueNode.text)) {
            associatedTypes.set(nameNode.text, valueNode.text);
        }
    }

    for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const child = bodyNode.namedChild(i);

        if (child.type === 'function_item') {
            const nameNode = child.childForFieldName('name');
            const paramsNode = child.childForFieldName('parameters');

            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(child, code);
                const text = child.text;
                const returnType = extractReturnType(child);
                const iteratorItemType = extractRustIteratorItemType(child);
                const docstring = extractRustDocstring(code, startLine);
                const visibility = extractVisibility(text);

                // Check if this is a method (has self parameter) or associated function
                const hasSelf = paramsNode && paramsNode.text.includes('self');

                // Extract attributes (#[test], #[inline], etc.) for impl members
                const attributes = extractAttributes(child, codeOrLines);
                const inCfgTest = _isInsideCfgTestModule(child, Array.isArray(codeOrLines) ? codeOrLines : codeOrLines.split('\n'));
                const modifiers = [];
                if (visibility) modifiers.push(visibility);
                // Function qualifiers, same vocabulary as free functions
                // (fix #248: `pub async fn get` rendered as `pub get(...)`;
                // const/unsafe methods had no machine-readable qualifier).
                const qualifiers = rustFunctionQualifiers(child);
                const futureReturn = rustFutureReturn(child, qualifiers);
                if (qualifiers.async) modifiers.push('async');
                if (qualifiers.unsafe) modifiers.push('unsafe');
                if (qualifiers.const) modifiers.push('const');
                if (qualifiers.extern) modifiers.push('extern');
                for (const attr of attributes) modifiers.push(attr);
                for (const attr of implAttributes) {
                    if (!modifiers.includes(attr)) modifiers.push(attr);
                }
                if (inCfgTest) modifiers.push('cfg_test_module');

                const memberGenerics = extractGenerics(child);
                const genericBounds = extractGenericBounds(child);
                const callbackParamTypes = extractRustCallbackParamTypes(paramsNode, child);
                let returnTypeResolved = returnType
                    ? rustResolveSelfProjections(child, associatedTypes) : null;
                if (returnType && !returnTypeResolved && /\bSelf\s*::/.test(returnType)) {
                    // A supertrait's associated type is defined by a sibling
                    // impl block for the same self type (`impl Consumer for C
                    // { type Reducer = R; }` + `impl UnindexedConsumer for C
                    // { fn to_reducer(&self) -> Self::Reducer }`).
                    returnTypeResolved = rustResolveSelfProjections(child,
                        rustSiblingAssociatedTypes(implNode, associatedTypes));
                }
                members.push({
                    name: nameNode.text,
                    params: extractRustParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'rust'),
                    ...(callbackParamTypes && { callbackParamTypes }),
                    startLine,
                    endLine,
                    memberType: 'method',
                    isAsync: qualifiers.async,
                    isMethod: hasSelf,  // Only true methods (with self) — associated functions are false
                    modifiers,
                    ...(typeName && { receiver: typeName }),  // All impl members get receiver for findMethodsForType
                    ...(returnType && { returnType }),
                    ...(returnTypeResolved && { returnTypeResolved }),
                    ...(futureReturn && { futureReturn }),
                    ...(ownerGenericBounds && { ownerGenericBounds }),
                    ...(ownerSelfArgs && { ownerSelfArgs }),
                    ...(implSelfRef && { implSelfRef }),
                    ...(implSelfQualifier && { implSelfQualifier }),
                    ...(rustSelfParamKind(paramsNode) && { selfParamKind: rustSelfParamKind(paramsNode) }),
                    ...(iteratorItemType && { iteratorItemType }),
                    ...(docstring && { docstring }),
                    // Method-level type params (fix #229): generic-param receiver
                    // types inside the method resolve against this declaration.
                    ...(memberGenerics && { generics: memberGenerics }),
                    ...(genericBounds && { genericBounds })
                });
            }
        }
    }

    return members;
}

/**
 * Find state objects (const/static) in Rust code
 */
function findStateObjects(code, parser) {
    const { trees } = declarationTrees(code, parser);
    const lines = code.split('\n');
    const objects = [];
    for (const tree of trees) {
        traverseTreeCached(tree.rootNode, (node) => {
            _processState(node, objects, lines);
            return true;
        });
    }
    objects.sort((a, b) => a.startLine - b.startLine);
    return objects;
}

/**
 * Parse a Rust file completely
 */
function parse(code, parser) {
    const declaration = declarationTrees(code, parser);
    const tree = declaration.primary;
    const lines = code.split('\n');
    const functions = [], classes = [], stateObjects = [];
    const processedFn = new Set(), processedCls = new Set();

    for (const declarationTree of declaration.trees) {
        traverseTreeCached(declarationTree.rootNode, (node) => {
            _processFunction(node, functions, processedFn, lines, code);
            _processClass(node, classes, processedCls, lines, code);
            _processState(node, stateObjects, lines);
            return true;  // always continue, never skip subtrees
        });
    }

    _postProcessTraitImpls(classes);

    functions.sort((a, b) => a.startLine - b.startLine);
    classes.sort((a, b) => a.startLine - b.startLine);
    stateObjects.sort((a, b) => a.startLine - b.startLine);

    return {
        language: 'rust', totalLines: lines.length, functions, classes, stateObjects,
        ...((tree.rootNode.hasError || declaration.macroItemRecovery) && {
            parseRecovery: true,
        }),
        ...(tree.rootNode.hasError && { parseErrorRegions: parseErrorRegions(tree.rootNode) }),
        ...(() => {
            const names = rustAsyncClosureNames(tree);
            return names.length > 0 ? { asyncClosureNames: names } : {};
        })(),
        imports: [], exports: [],
    };
}

const DECLARATION_NODE_TYPES = [
    'function_item', 'foreign_mod_item', 'struct_item', 'union_item', 'enum_item', 'trait_item', 'impl_item',
    'mod_item', 'macro_definition', 'type_item', 'const_item', 'static_item',
];

/**
 * Declarations of the given subtrees only, extracted exactly as parse()
 * extracts them (fix #374: the declarations a macro expansion generates,
 * without walking the rest of the expanded file).
 */
function parseDeclarationsIn(code, roots) {
    const lines = code.split('\n');
    const functions = [], classes = [], stateObjects = [];
    const processedFn = new Set(), processedCls = new Set();
    for (const root of roots) {
        const nodes = DECLARATION_NODE_TYPES.includes(root.type) ? [root] : [];
        for (const node of nodes.concat(root.descendantsOfType(DECLARATION_NODE_TYPES))) {
            _processFunction(node, functions, processedFn, lines, code);
            _processClass(node, classes, processedCls, lines, code);
            _processState(node, stateObjects, lines);
        }
    }
    _postProcessTraitImpls(classes);
    functions.sort((a, b) => a.startLine - b.startLine);
    classes.sort((a, b) => a.startLine - b.startLine);
    stateObjects.sort((a, b) => a.startLine - b.startLine);
    return { language: 'rust', totalLines: lines.length, functions, classes, stateObjects, imports: [], exports: [] };
}

/**
 * Local names bound to closures whose body is an async block
 * (`let f = || async { .. }`, fix #370): calling one creates a future.
 */
function rustAsyncClosureNames(tree) {
    const names = new Set();
    // The flat node list the declaration pass built for this tree holds the
    // same nodes in document order (fix #388: no second native walk).
    const range = cachedNodeRange(tree.rootNode);
    let blocks;
    if (range) {
        blocks = [];
        const { nodes, subtreeEnds, index } = range;
        for (let i = index, end = subtreeEnds[index]; i < end; i++) {
            if (nodes[i].type === 'async_block') blocks.push(nodes[i]);
        }
    } else {
        blocks = tree.rootNode.descendantsOfType('async_block');
    }
    for (const block of blocks) {
        const closure = block.parent;
        if (closure?.type !== 'closure_expression' || !sameNode(closure.childForFieldName('body'), block)) continue;
        const binding = closure.parent;
        if (binding?.type !== 'let_declaration') continue;
        const pattern = binding.childForFieldName('pattern');
        if (pattern?.type === 'identifier') names.add(pattern.text);
    }
    return [...names].sort();
}

/**
 * Walk a Rust call chain to find its root constructor type.
 *
 * Examples:
 *   Router::new()                         → 'Router'
 *   Router::new().route(...)              → 'Router'
 *   Router::new().nest(...).route(...)    → 'Router' (recursively unwraps method chain)
 *   axum::Router::new().route(...)        → 'Router'
 *   foo()                                 → null (not a constructor pattern)
 *
 * Returns the root type name when the chain begins with `<Type>::new()` or
 * `<Type>::*` (associated function call). Returns null otherwise.
 *
 * Used to detect axum's chained Router pattern where `.route(...)` is called on
 * the result of `Router::new()` rather than a named variable.
 *
 * @param {Node} callNode - call_expression node
 * @returns {string|null} root type name, or null
 */
function _findRustChainRootType(callNode) {
    if (!callNode || callNode.type !== 'call_expression') return null;
    const funcNode = callNode.childForFieldName('function');
    if (!funcNode) return null;

    // Base case: scoped path like Router::new or axum::Router::new
    if (funcNode.type === 'scoped_identifier') {
        const segments = funcNode.text.split('::');
        // Need at least Type::method (associated function call)
        if (segments.length < 2) return null;
        // The type is the second-to-last segment (last is the method)
        const typeName = segments[segments.length - 2];
        // Must be a Capitalized type name (filter out module::func calls)
        if (!/^[A-Z]/.test(typeName)) return null;
        return typeName;
    }

    // Recursive case: chained method call on prior call result
    //   Router::new().route(...)  →  unwrap .route(...) and recurse on Router::new()
    if (funcNode.type === 'field_expression') {
        const valueNode = funcNode.childForFieldName('value');
        if (valueNode?.type === 'call_expression') {
            return _findRustChainRootType(valueNode);
        }
        // Chain rooted at a named identifier: skip — we detect this elsewhere
        // via the existing receiver-name path in bridge.js.
        return null;
    }

    return null;
}

/**
 * Find all function calls in Rust code using tree-sitter AST
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{name: string, line: number, isMethod: boolean, receiver?: string, isMacro?: boolean}>}
 */
/**
 * Extract call-shaped token sequences from a macro body. Macro arguments are
 * almost always ordinary expressions (assert_eq!, format!, vec!, write!), but
 * tree-sitter parses them as a flat token_tree, so the regular call_expression
 * handler never sees them. Recognized shapes (still AST token nodes, no text
 * regex):  ident (…)  ·  recv . ident (…)  ·  Path :: ident (…)
 * Emitted calls mirror the regular handlers' field contract and carry
 * inMacro: true.
 */
function _tokenTreeCallArgsAfter(children, nameIndex) {
    let nextIndex = nameIndex + 1;
    // Rust turbofish: method::<T>(...) / collect::<Vec<_>>(). Token trees
    // expose the generic tokens as flat siblings between the name and the
    // argument token_tree, so a direct-next check misclassified the method as
    // a reference and omitted it from the call graph. Count angle tokens by
    // text because nested generic closers may arrive as one `>>` token.
    if (children[nextIndex]?.type === '::' && children[nextIndex + 1]?.type === '<') {
        let depth = 0;
        nextIndex++;
        for (; nextIndex < children.length; nextIndex++) {
            const text = children[nextIndex]?.text || '';
            for (const ch of text) {
                if (ch === '<') depth++;
                else if (ch === '>') depth--;
            }
            if (depth === 0) {
                nextIndex++;
                break;
            }
        }
    }
    const args = children[nextIndex];
    return args?.type === 'token_tree' && args.text.startsWith('(') ? args : null;
}

// Extract the base type name from a Rust type node (strips &, &mut, Box<>, etc.)
function extractTypeName(typeNode) {
    if (!typeNode) return null;
    if (typeNode.type === 'type_identifier' ||
        typeNode.type === 'primitive_type') {
        return typeNode.text;
    }
    if (typeNode.type === 'reference_type') {
        // &Filter or &mut Filter -> Filter
        for (let i = 0; i < typeNode.namedChildCount; i++) {
            const r = extractTypeName(typeNode.namedChild(i));
            if (r) return r;
        }
    }
    if (typeNode.type === 'abstract_type' || typeNode.type === 'dynamic_type') {
        for (let i = 0; i < typeNode.namedChildCount; i++) {
            const r = extractTypeName(typeNode.namedChild(i));
            if (r) return r;
        }
    }
    if (typeNode.type === 'generic_type') {
        // Box<Filter> -> Filter (or get the outer type)
        return extractTypeName(typeNode.namedChild(0));
    }
    if (typeNode.type === 'scoped_type_identifier') {
        // module::Type -> Type
        const nameNode = typeNode.childForFieldName('name');
        return nameNode?.text || null;
    }
    return null;
}


// Argument type descriptors (fix #384): impls of one generic trait for one
// self type (`impl From<Bytes> for Vec<u8>`, `impl From<BytesMut> for
// Vec<u8>`) are selected by argument type, so method and path calls record
// what each argument's type is known to be: '<refs><base>' where refs is a
// run of '&' / '&mut ' and base a type name the site proves (a declared
// parameter or local, a struct literal), '?<start>' for a local bound from
// the path call starting at byte <start> (its declared return type decides
// at query time), 'str'/'char'/'bool'/a suffixed numeric type for literals,
// '#int'/'#float' for unsuffixed numeric literals, '#array' for a byte
// string's array, '#slice' for a range-indexed slice; null when unknown.
const RUST_NUMERIC_TYPES = ['i8', 'i16', 'i32', 'i64', 'i128', 'isize',
    'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'f32', 'f64'];

function rustLiteralArgType(node) {
    switch (node.type) {
        case 'string_literal':
        case 'raw_string_literal':
            return node.text.startsWith('b') ? '&#array:u8' : node.text.startsWith('c') ? null : '&str';
        case 'char_literal':
            return node.text.startsWith('b') ? 'u8' : 'char';
        case 'boolean_literal':
            return 'bool';
        case 'integer_literal':
        case 'float_literal': {
            const text = node.text.replace(/_/g, '');
            if (!/^[0-9]/.test(text) || /^0[xob]/i.test(text)) {
                return node.type === 'integer_literal' ? '#int' : '#float';
            }
            const suffix = RUST_NUMERIC_TYPES.find(type => text.endsWith(type) &&
                /[0-9.]$/.test(text.slice(0, -type.length)));
            return suffix || (node.type === 'integer_literal' ? '#int' : '#float');
        }
        default:
            return null;
    }
}

/**
 * Base of a range index (`&s[..]`, `&v[1..]`): 'str', '#slice:u8' for a
 * byte string, '#slice' when the element type is unknown.
 */
function rustRangeIndexBase(container, typeOfName) {
    if (!container) return null;
    if (container.type === 'string_literal' || container.type === 'raw_string_literal') {
        return container.text.startsWith('b') ? '#slice:u8' : 'str';
    }
    if (container.type !== 'identifier') return null;
    const known = typeOfName(container.text, container);
    const base = known ? known.replace(/^(?:&mut |&)+/, '') : null;
    if (base === 'String' || base === 'str') return 'str';
    if (base === 'Vec' || base?.startsWith('#slice') || base?.startsWith('#array')) {
        return base?.includes(':') ? `#slice:${base.split(':')[1]}` : '#slice';
    }
    return null;
}

/**
 * A local's type as an argument descriptor: declared (parameter, annotated
 * `let`), constructed (struct literal) or literal types with their
 * reference layer; a local bound from a path call as '?<start>'.
 */
function rustKnownArgNameType(name, atNode, getReceiverType, isPatternShadow, tokenTypes) {
    // One evidence lookup (it checks pattern shadows itself); a declared or
    // constructed type carries its name in the evidence.
    let fields = getReceiverType?.(name, atNode, true);
    let type = fields?.receiverTypeEvidence?.type;
    if (!fields && tokenTypes?.has(name) && !isPatternShadow?.(atNode, name)) {
        type = tokenTypes.get(name);
        fields = tokenTypes.fields(name, type);
    }
    if (!type || !fields) return null;
    const source = fields.receiverTypeSource;
    const evidence = fields.receiverTypeEvidence;
    // A value behind a std wrapper is passed as the wrapper itself (fix #401).
    if (Array.isArray(evidence?.derefVia) && evidence.derefVia.length > 0) {
        const wrapper = String(evidence.derefVia[0]).replace(/^=/, '').split('::').pop();
        const outer = evidence.derefOuterRef || 'owned';
        return (outer === '&' ? '&' : outer === '&mut' ? '&mut ' : '') + wrapper;
    }
    if (source === 'guess') {
        return evidence?.nodeType === 'call_expression' && Number.isInteger(evidence.start)
            ? `?${evidence.start}` : null;
    }
    if (source !== 'annotation' && source !== 'constructor' && source !== 'literal') return null;
    const ref = fields.receiverTypeRef;
    if (!ref) return null;
    const base = type === 'slice' ? '#slice' : type;
    return (ref === '&' ? '&' : ref === '&mut' ? '&mut ' : '') + base;
}

function rustArgTypeOfNode(argNode, typeOfName) {
    let node = argNode;
    let refs = '';
    let type = node?.type;
    while (node) {
        if (type === 'parenthesized_expression') {
            node = node.namedChild(0);
        } else if (type === 'reference_expression') {
            refs += node.namedChildren.some(child => child.type === 'mutable_specifier') ? '&mut ' : '&';
            node = node.childForFieldName('value');
        } else {
            break;
        }
        type = node?.type;
    }
    if (!node) return null;
    if (type === 'identifier') {
        const known = typeOfName(node.text, node);
        return known ? refs + known : null;
    }
    const literal = rustLiteralArgType(node);
    if (literal) return refs + literal;
    if (type === 'identifier') {
        const known = typeOfName(node.text, node);
        return known ? refs + known : null;
    }
    if (node.type === 'struct_expression') {
        const nameNode = node.childForFieldName('name');
        let name = nameNode?.type === 'scoped_type_identifier'
            ? nameNode.childForFieldName('name')?.text
            : nameNode?.type === 'type_identifier' ? nameNode.text : null;
        if (name === 'Self') name = findEnclosingImplType(node) || null;
        return name ? refs + name : null;
    }
    if (node.type === 'index_expression' && node.namedChild(1)?.type === 'range_expression') {
        const base = rustRangeIndexBase(node.namedChild(0), typeOfName);
        return base ? refs + base : null;
    }
    // A value produced by a macro or a path call (`vec![..]`,
    // `Bytes::from(v)`): its record at this byte decides at query time.
    if (node.type === 'macro_invocation' ||
        (node.type === 'call_expression' && node.childForFieldName('function')?.type === 'scoped_identifier')) {
        return `${refs}?${node.startIndex}`;
    }
    // `x.clone()` of an owned local has the local's type.
    if (node.type === 'call_expression' && node.childForFieldName('arguments')?.namedChildCount === 0) {
        const callee = node.childForFieldName('function');
        const object = callee?.type === 'field_expression' ? callee.childForFieldName('value') : null;
        if (callee?.childForFieldName('field')?.text === 'clone' && object?.type === 'identifier') {
            const known = typeOfName(object.text, object);
            return known && !known.startsWith('&') ? refs + known : null;
        }
    }
    return null;
}

function rustArgTypesOfNode(argNodes, typeOfName) {
    if (argNodes.length === 0) return null;
    let types = null;
    for (let i = 0; i < argNodes.length; i++) {
        const descriptor = rustArgTypeOfNode(argNodes[i], typeOfName);
        if (descriptor) {
            if (!types) types = new Array(argNodes.length).fill(null);
            types[i] = descriptor;
        }
    }
    return types;
}

/** The same descriptors read from a macro argument token tree. */
function rustArgTypesOfTokens(argsTree, typeOfName) {
    if (!argsTree) return null;
    const children = argsTree.children;
    let types = null;
    let index = 0;
    let start = 1; // skip `(`
    for (let i = 1; i <= children.length - 1; i++) {
        if (i < children.length - 1 && children[i].type !== ',') continue;
        if (i > start) {
            const descriptor = rustTokenSegmentType(children, start, i, typeOfName);
            if (descriptor) {
                if (!types) types = [];
                types[index] = descriptor;
            }
        }
        index++;
        start = i + 1;
    }
    if (!types) return null;
    for (let i = 0; i < index; i++) if (types[i] === undefined) types[i] = null;
    types.length = Math.min(types.length, index);
    return types;
}

/** Descriptor of one macro argument: the tokens children[from..to). */
function rustTokenSegmentType(children, from, to, typeOfName) {
    let refs = '';
    let at = from;
    while (at < to && (children[at].type === '&' || children[at].type === '&&')) {
        const layers = children[at].type === '&&' ? 2 : 1;
        const mutable = at + 1 < to && children[at + 1].type === 'mutable_specifier';
        refs += '&'.repeat(layers - 1) + (mutable ? '&mut ' : '&');
        at += mutable ? 2 : 1;
    }
    const count = to - at;
    const first = children[at];
    if (count === 1) {
        if (first.type === 'identifier') {
            const known = typeOfName(first.text, first);
            return known ? refs + known : null;
        }
        const literal = rustLiteralArgType(first);
        return literal ? refs + literal : null;
    }
    if (count === 2 && children[at + 1].type === 'token_tree') {
        const group = children[at + 1];
        const text = group.text;
        if (text.startsWith('[')) {
            let ranged = false;
            for (const token of group.children) if (token.type === '..') { ranged = true; break; }
            if (!ranged) return null;
            const base = rustRangeIndexBase(first, typeOfName);
            return base ? refs + base : null;
        }
        if (text.startsWith('{') && first.type === 'identifier') {
            const name = first.text === 'Self' ? findEnclosingImplType(first) : first.text;
            return name ? refs + name : null;
        }
        return null;
    }
    // `vec![..]` / `name!(..)`: the nested macro's own record.
    if (count === 3 && first.type === 'identifier' && children[at + 1].type === '!' &&
        children[at + 2].type === 'token_tree') {
        return `${refs}?${first.startIndex}`;
    }
    // `x.clone()` of an owned local.
    if (count === 4 && first.type === 'identifier' && children[at + 1].type === '.' &&
        children[at + 2].text === 'clone' && children[at + 3].type === 'token_tree' &&
        children[at + 3].text.replace(/\s+/g, '') === '()') {
        const known = typeOfName(first.text, first);
        return known && !known.startsWith('&') ? refs + known : null;
    }
    return null;
}

// Shared by ordinary AST calls and macro token-tree calls. Both carry the
// same self-field owner identity; a field spelling is never a local receiver.
function findEnclosingImplType(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.type === 'impl_item') {
            const type = parent.childForFieldName('type');
            return (type && extractTypeName(type)) || undefined;
        }
    }
    return undefined;
}

function extractCallsFromTokenTree(tree, enclosingFunction, calls, getReceiverType,
    isPatternShadow, isFlowInvalidated, context = 'invocation') {
    const contextKind = typeof context === 'string' ? context : context.kind;
    const containerMacro = typeof context === 'object' ? context.containerMacro : undefined;
    const inheritedTokenTypes = typeof context === 'object' && context.tokenTypes
        ? context.tokenTypes : new ReceiverTypeMap();
    const children = [];
    for (let i = 0; i < tree.childCount; i++) children.push(tree.child(i));
    // Macro arguments are token trees, so a typed closure parameter is not a
    // normal closure_parameters AST node. Recover only the compiler-explicit
    // simple/path type shape from AST tokens and pass it into that closure's
    // body token tree. This keeps the evidence lexical: sibling macro
    // arguments and token trees before the closure never inherit the name.
    const closureBodyTypes = new Map();
    for (let i = 0; i < children.length; i++) {
        if (children[i].type !== '|') continue;
        let close = i + 1;
        while (close < children.length && children[close].type !== '|') close++;
        if (close >= children.length) break;
        const bindings = new ReceiverTypeMap(inheritedTokenTypes);
        let cursor = i + 1;
        while (cursor < close) {
            const nameNode = children[cursor];
            if (nameNode?.type !== 'identifier' || children[cursor + 1]?.type !== ':') {
                cursor++;
                continue;
            }
            let end = cursor + 2;
            while (end < close && children[end].type !== ',') end++;
            const typeTokens = children.slice(cursor + 2, end).filter(token =>
                !['&', 'mutable_specifier', 'lifetime'].includes(token.type));
            const simplePath = typeTokens.length > 0 && typeTokens.every((token, index) =>
                token.type === 'identifier' ||
                (token.type === '::' && index > 0 && index < typeTokens.length - 1));
            if (simplePath) {
                const identifiers = typeTokens.filter(token => token.type === 'identifier');
                if (identifiers.length > 0) {
                    bindings.set(nameNode.text, identifiers[identifiers.length - 1].text, 'annotation', nameNode);
                }
            }
            cursor = end + 1;
        }
        const body = children[close + 1];
        if (body?.type === 'token_tree') closureBodyTypes.set(body.id, bindings);
        i = close;
    }
    let lastProducer = null;
    const scopedName = typeof context === 'object' ? context.scopeTypesName : null;
    const argTypeOfName = (name, atNode) => (!scopedName || scopedName(name) || inheritedTokenTypes.has(name))
        ? rustKnownArgNameType(name, atNode, getReceiverType, isPatternShadow, inheritedTokenTypes) : null;
    const macroFields = {
        inMacro: true,
        ...(contextKind === 'definition' && { inMacroDefinition: true }),
        ...(containerMacro && { macroContainer: containerMacro }),
    };
    for (let i = 0; i < children.length; i++) {
        const tok = children[i];
        if (tok.type === 'token_tree') {
            const tokenTypes = closureBodyTypes.get(tok.id) || inheritedTokenTypes;
            extractCallsFromTokenTree(tok, enclosingFunction, calls, getReceiverType,
                isPatternShadow, isFlowInvalidated, {
                    kind: contextKind,
                    ...(containerMacro && { containerMacro }),
                    tokenTypes,
                    ...(scopedName && { scopeTypesName: scopedName }),
                });
            continue;
        }
        // `default` is tokenized as the Rust keyword even in the valid
        // associated-call shape `Type::default()`. It is still an AST token,
        // so admitting it here preserves the AST-first rule while recovering
        // calls nested inside macro token trees (assert_eq!, matches!, ...).
        if (tok.type !== 'identifier' && tok.type !== 'default') continue;
        const next = children[i + 1];
        const prev = children[i - 1];
        // $metavariable(...) — a macro fragment, not a named call
        if (prev && prev.type === '$') continue;
        // Nested macro invocation: name!(...)
        if (next && next.type === '!' &&
            children[i + 2] && children[i + 2].type === 'token_tree') {
            const segments = [];
            let startNode = tok;
            let j = i - 1;
            while (j >= 1 && children[j].type === '::') {
                const segment = children[j - 1];
                if (!segment || ![
                    'identifier', 'metavariable', 'crate', 'self', 'super',
                ].includes(segment.type)) break;
                segments.unshift(segment.text === '$crate' ? 'crate' : segment.text);
                startNode = segment;
                j -= 2;
            }
            const record = {
                name: tok.text,
                line: tok.startPosition.row + 1,
                callStart: startNode.startIndex,
                callEnd: children[i + 2].endIndex,
                isMethod: false,
                isMacro: true,
                ...(segments.length > 0 && {
                    receiver: segments.join('::'),
                    isPathMacro: true,
                }),
                ...macroFields,
                enclosingFunction
            };
            calls.push(record);
            lastProducer = record;
            continue;
        }
        const callArgs = _tokenTreeCallArgsAfter(children, i);
        if (!callArgs) continue;
        if (prev && prev.type === '::') {
            // Path call: Type::func(...) / module::sub::func(...) — segments
            // can be identifiers, primitives (char::from), or path keywords
            const isSegment = (n) => n && [
                'identifier', 'primitive_type', 'metavariable', 'self', 'super', 'crate',
            ].includes(n.type);
            const segments = [];
            let startNode = tok;
            let j = i - 1;
            while (j >= 1 && children[j].type === '::') {
                let k = j - 1;
                if (children[k] && children[k].type === '>') {
                    // Turbofish: `Vec::<PatternSource>::new(...)` — angle
                    // brackets do NOT group into token_trees, so skip the
                    // <...> token run (nesting-aware) back to the matching
                    // `<`, which the turbofish form introduces with `::`.
                    // Without this the walk stopped at `>`, emitted a
                    // receiver-less path call, and `Vec::<T>::new()` inside
                    // assert_eq! scope-confirmed against every project `new`
                    // (fix #222, ripgrep-seed-C-measured).
                    let depth = 1;
                    k--;
                    while (k >= 0 && depth > 0) {
                        if (children[k].type === '>') depth++;
                        else if (children[k].type === '<') depth--;
                        if (depth > 0) k--;
                    }
                    if (k < 1 || children[k - 1].type !== '::') break;
                    k -= 2;
                }
                if (!isSegment(children[k])) break;
                segments.unshift(children[k].text === '$crate' ? 'crate' : children[k].text);
                startNode = children[k];
                j = k - 1;
            }
            const tokenArgTypes = segments.length > 0 ? rustArgTypesOfTokens(callArgs, argTypeOfName) : null;
            const record = {
                name: tok.text,
                line: tok.startPosition.row + 1,
                callStart: startNode.startIndex,
                callEnd: callArgs.endIndex,
                isMethod: segments.length > 0,
                isPathCall: true,
                receiver: segments.length > 0 ? segments.join('::') : undefined,
                ...(tokenArgTypes && { argTypes: tokenArgTypes }),
                ...macroFields,
                enclosingFunction
            };
            calls.push(record);
            lastProducer = record;
        } else if (prev && prev.type === '.') {
            // Method call: recv.method(...)
            const recvTok = children[i - 2];
            const receiver = recvTok && (recvTok.type === 'identifier' || recvTok.type === 'self')
                ? recvTok.text : undefined;
            // Token trees flatten `root.field.method(...)`. Retain the same
            // one-hop field contract as the regular AST path so query-time
            // analysis can type `args.separator.into_bytes()` from the
            // declared type of `LowArgs.separator`.
            let receiverRoot, receiverField;
            if (receiver && children[i - 3]?.type === '.' &&
                (children[i - 4]?.type === 'identifier' ||
                 children[i - 4]?.type === 'self')) {
                receiverRoot = children[i - 4].text;
                receiverField = receiver;
            }
            // Literal receivers type as builtins inside macros too (fix #220,
            // ripgrep-measured: assert_eq!(.., vec!["match:fg".parse()...]))
            const groupedReceiver = recvTok?.type === 'token_tree' &&
                rustTokenTreeIsGroupedExpression(children, i - 2);
            const rangeType = groupedReceiver
                ? (rustTokenTreeRangeType(recvTok) || rustTokenTreeTupleType(recvTok)) : null;
            const litType = recvTok
                ? (({ string_literal: 'str', raw_string_literal: 'str',
                    char_literal: 'char', boolean_literal: 'bool' })[recvTok.type] ||
                    rangeType || undefined)
                : undefined;
            const receiverRootType = receiverRoot === 'self'
                ? findEnclosingImplType(tok) : getReceiverType?.(receiverRoot, tok);
            const receiverType = receiverField ? undefined : (receiver && receiver !== 'self')
                ? (getReceiverType?.(receiver, tok) || inheritedTokenTypes.get(receiver))
                : litType;
            const receiverPatternShadow = !!(receiver && isPatternShadow?.(tok, receiver));
            const receiverFlowInvalidated = !!(receiver && isFlowInvalidated?.(tok, receiver));
            const iterationSource = rustIterationSourceOf(tok, receiver);
            const patternSource = rustPatternBindingOf(tok, receiver);
            const producer = !receiver && lastProducer &&
                lastProducer.callEnd === recvTok?.endIndex ? lastProducer : null;
            const tokenArgTypes = rustArgTypesOfTokens(callArgs, argTypeOfName);
            const record = {
                name: tok.text,
                line: tok.startPosition.row + 1,
                callStart: producer?.callStart ?? recvTok?.startIndex ?? tok.startIndex,
                callEnd: callArgs.endIndex,
                isMethod: true,
                ...(tokenArgTypes && { argTypes: tokenArgTypes }),
                receiver: receiverField ? undefined : receiver,
                ...(receiverField && { receiverRoot, receiverField }),
                ...(receiverRootType && { receiverRootType }),
                ...(receiverType && { receiverType, ...((rangeType && receiverType === rangeType && !receiver)
                    ? { receiverTypeSource: 'literal', receiverTypeEvidence: typeOrigin('literal', recvTok),
                        receiverTypeStd: true, receiverTypeRef: 'owned' }
                    : (getReceiverType?.(receiver, tok, true) || inheritedTokenTypes.fields(receiver, receiverType))) }),
                ...(receiverPatternShadow && { receiverPatternShadow: true }),
                ...(receiverFlowInvalidated && { receiverFlowInvalidated: true }),
                ...(iterationSource || {}),
                ...(patternSource || {}),
                ...(producer && {
                    receiverCall: producer.name,
                    ...(producer.isMethod && { receiverCallIsMethod: true }),
                    ...(producer.isMacro && { receiverCallIsMacro: true }),
                    receiverCallLine: producer.line,
                    receiverCallStart: producer.callStart,
                    receiverCallEnd: producer.callEnd,
                }),
                ...macroFields,
                enclosingFunction
            };
            calls.push(record);
            lastProducer = record;
        } else {
            // `fn name(...)` inside a macro token tree is a DEFINITION
            // template (deref-forwarding / impl-generating macros), not a
            // call (fix #360): recording it as a call listed the definition
            // line as a caller of every same-name function.
            if (prev && prev.type === 'fn') continue;
            // Plain call: func(...) — includes enum-variant constructors
            const record = {
                name: tok.text,
                line: tok.startPosition.row + 1,
                callStart: tok.startIndex,
                callEnd: callArgs.endIndex,
                isMethod: false,
                ...macroFields,
                enclosingFunction
            };
            calls.push(record);
            lastProducer = record;
        }
    }
}

/**
 * Variable receiving this call's result (fix #207 return-type flow):
 *   let x = f(...);          → { assignedTo: 'x' }
 *   let x = f(...)?;         → { assignedTo: 'x', unwrapped: true }
 *   let x = f(...).unwrap(); → { assignedTo: 'x', unwrapped: true } (also .expect(...))
 *   x = f(...);              → { assignedTo: 'x' }
 * Value-transparent wrappers (`?`, .unwrap(), .expect(), .await) are walked
 * through so the INNER call carries the target; the flow map then unwraps
 * Result<T, _>/Option<T> from the producer's return annotation. `let mut x`
 * works too — the pattern field is the plain identifier.
 */
function rustDivergingExpression(node) {
    if (!node) return false;
    if (['return_expression', 'break_expression', 'continue_expression']
        .includes(node.type)) return true;
    if (node.type === 'expression_statement' && node.namedChildCount === 1) {
        return rustDivergingExpression(node.namedChild(0));
    }
    if (node.type !== 'block') return false;
    const last = node.namedChildCount > 0
        ? node.namedChild(node.namedChildCount - 1) : null;
    return rustDivergingExpression(last);
}

function rustMatchCallProducer(matchExpression) {
    if (matchExpression?.type !== 'match_expression') return null;
    const body = matchExpression.childForFieldName('body');
    if (!body) return null;
    const calls = [];
    for (let i = 0; i < body.namedChildCount; i++) {
        const arm = body.namedChild(i);
        if (arm.type !== 'match_arm') continue;
        const value = arm.childForFieldName('value');
        if (rustDivergingExpression(value)) continue;
        if (value?.type !== 'call_expression') return null;
        calls.push(value);
    }
    if (calls.length === 0) return null;
    const identities = new Set(calls.map(call =>
        call.childForFieldName('function')?.text || ''));
    return identities.size === 1 ? calls : null;
}

function rustAssignmentTargetOf(callNode) {
    let n = callNode;
    let p = n.parent;
    let unwrapped = false;
    for (;;) {
        if (!p) return undefined;
        if (p.type === 'try_expression') { unwrapped = true; n = p; p = n.parent; continue; }
        if (p.type === 'await_expression') { n = p; p = n.parent; continue; }
        if (p.type === 'field_expression' &&
            p.childForFieldName('value')?.id === n.id &&
            ['unwrap', 'expect'].includes(p.childForFieldName('field')?.text) &&
            p.parent?.type === 'call_expression' &&
            p.parent.childForFieldName('function')?.id === p.id) {
            unwrapped = true; n = p.parent; p = n.parent; continue;
        }
        break;
    }
    if (p?.type === 'match_arm' &&
        p.childForFieldName('value')?.id === n.id) {
        let matchExpression = p.parent;
        while (matchExpression && matchExpression.type !== 'match_expression') {
            matchExpression = matchExpression.parent;
        }
        const producers = rustMatchCallProducer(matchExpression);
        if (producers?.some(producer => producer.id === callNode.id)) {
            const declaration = matchExpression.parent;
            if (declaration?.type === 'let_declaration' &&
                declaration.childForFieldName('value')?.id === matchExpression.id) {
                const pattern = declaration.childForFieldName('pattern');
                if (pattern?.type === 'identifier') {
                    return { assignedTo: pattern.text };
                }
            }
        }
    }
    if (p.type === 'let_declaration') {
        const value = p.childForFieldName('value');
        const pattern = p.childForFieldName('pattern');
        if (value && value.id === n.id && pattern?.type === 'identifier') {
            return { assignedTo: pattern.text, ...(unwrapped && { unwrapped: true }) };
        }
        if (value && value.id === n.id && pattern?.type === 'tuple_pattern') {
            const bindings = pattern.namedChildren
                .filter(child => child.type === 'identifier')
                .map(child => child.text);
            // Positional targets (fix #368): `let (left, right, _) = c.split_at(i)`
            // binds element i of the declared tuple return to each name.
            // `_` and non-identifier sub-patterns keep their position but
            // bind nothing typed.
            const tupleTargets = [];
            let position = 0;
            let positional = true;
            for (let i = 0; i < pattern.childCount; i++) {
                const child = pattern.child(i);
                if (['(', ')', ','].includes(child.type)) continue;
                if (child.type.endsWith('comment')) continue;
                if (child.type === 'remaining_field_pattern' || child.text === '..') {
                    positional = false;
                    break;
                }
                let binding = child;
                // `mut x`: the pattern's named children are the
                // `mutable_specifier` and then the identifier (fix #369).
                if (binding.type === 'mut_pattern') {
                    binding = binding.namedChildren.find(c => c.type === 'identifier') || null;
                }
                if (binding?.type === 'identifier') {
                    tupleTargets.push({ name: binding.text, index: position });
                }
                position++;
            }
            if (bindings.length === pattern.namedChildCount && bindings.length > 0) {
                return {
                    assignedTo: bindings[0],
                    tuple: true,
                    ...(bindings.length > 1 && { tupleRest: bindings.slice(1) }),
                    ...(positional && tupleTargets.length > 0 && { tupleTargets }),
                    ...(unwrapped && { unwrapped: true }),
                };
            }
            if (positional && tupleTargets.length > 0) {
                return {
                    assignedTo: tupleTargets[0].name,
                    tuple: true,
                    ...(tupleTargets.length > 1 && {
                        tupleRest: tupleTargets.slice(1).map(target => target.name),
                    }),
                    tupleTargets,
                    ...(unwrapped && { unwrapped: true }),
                };
            }
        }
        return undefined;
    }
    if (p.type === 'assignment_expression') {
        const right = p.childForFieldName('right');
        const left = p.childForFieldName('left');
        if (right && right.id === n.id && left?.type === 'identifier') {
            return { assignedTo: left.text, ...(unwrapped && { unwrapped: true }) };
        }
    }
    return undefined;
}

/**
 * Range expressions have a language-fixed type (fix #368): `a..b` is
 * `std::ops::Range`, `a..=b` is `RangeInclusive`, `a..` / `..b` / `..=b` /
 * `..` are RangeFrom / RangeTo / RangeToInclusive / RangeFull. A method call
 * on a parenthesized range therefore dispatches on that std type exactly
 * like a string literal dispatches on `str`.
 */
function rustRangeTypeName(operator, hasStart, hasEnd) {
    if (operator === '..=' || operator === '...') {
        if (!hasEnd) return null;
        return hasStart ? 'RangeInclusive' : 'RangeToInclusive';
    }
    if (operator !== '..') return null;
    if (hasStart && hasEnd) return 'Range';
    if (hasStart) return 'RangeFrom';
    if (hasEnd) return 'RangeTo';
    return 'RangeFull';
}

function rustRangeLiteralType(node, allowBare = false) {
    let current = node;
    while (current?.type === 'parenthesized_expression' && current.namedChildCount === 1) {
        current = current.namedChild(0);
    }
    // `0..8.len()` parses as a range whose END is the call; only a
    // parenthesized range is a method receiver. A `let` value may be bare.
    if (current?.type !== 'range_expression' || (current === node && !allowBare)) return null;
    let operator = null;
    let operatorIndex = -1;
    for (let i = 0; i < current.childCount; i++) {
        const child = current.child(i);
        if (!child.isNamed && ['..', '..=', '...'].includes(child.type)) {
            operator = child.type;
            operatorIndex = child.startIndex;
            break;
        }
    }
    if (!operator) return null;
    let hasStart = false;
    let hasEnd = false;
    for (let i = 0; i < current.namedChildCount; i++) {
        const operand = current.namedChild(i);
        if (operand.type.endsWith('comment')) continue;
        if (operand.startIndex < operatorIndex) hasStart = true;
        else hasEnd = true;
    }
    return rustRangeTypeName(operator, hasStart, hasEnd);
}

/**
 * Token-tree twin of rustRangeLiteralType for macro arguments
 * (`assert_eq!(4, (0..8).len())`): a parenthesized token tree holding exactly
 * one top-level range operator and nothing that binds looser than a range
 * (comma, assignment, closure bars, statement or control keywords).
 */
/**
 * A parenthesized token tree is a grouped EXPRESSION only when nothing that
 * makes it an argument list precedes it (`f(0..8)`, `m!(..)`, `x[..](..)`).
 */
const RUST_TOKEN_EXPRESSION_PRECEDERS = new Set(['(', '[', '{', ',', ';', '=', '=>', '&',
    '&&', '||', '+', '-', '*', '/', '%', '==', '!=', '<', '<=', '>=', 'return', 'in', 'move', '|']);
function rustTokenTreeIsGroupedExpression(children, index) {
    const previous = children[index - 1];
    return !previous || RUST_TOKEN_EXPRESSION_PRECEDERS.has(previous.type);
}

/**
 * Tuple expressions have the language's tuple type (fix #368): `(a, b)` and
 * `(a,)`. The canonical receiver name is 'tuple'.
 */
function rustTokenTreeTupleType(tokenTree) {
    if (tokenTree?.type !== 'token_tree' || tokenTree.child(0)?.type !== '(' ||
        tokenTree.child(tokenTree.childCount - 1)?.type !== ')') return null;
    let commas = 0;
    let values = 0;
    for (let i = 1; i < tokenTree.childCount - 1; i++) {
        const token = tokenTree.child(i);
        if (token.type.endsWith('comment')) continue;
        if (['..', '..=', '...', ';', '=', '|', '||'].includes(token.type)) return null;
        if (token.type === ',') commas++;
        else values++;
    }
    return commas > 0 && values > 0 ? 'tuple' : null;
}

function rustTokenTreeRangeType(tokenTree) {
    if (tokenTree?.type !== 'token_tree' || tokenTree.child(0)?.type !== '(') return null;
    const inner = [];
    for (let i = 1; i < tokenTree.childCount - 1; i++) inner.push(tokenTree.child(i));
    if (tokenTree.child(tokenTree.childCount - 1)?.type !== ')') return null;
    const LOOSER = new Set([',', ';', '=', '|', '||', '+=', '-=', '*=', '/=', '%=',
        '^=', '&=', '|=', '<<=', '>>=', 'return', 'break', 'continue', 'let', 'move']);
    let operatorIndex = -1;
    for (let i = 0; i < inner.length; i++) {
        const token = inner[i];
        if (LOOSER.has(token.type)) return null;
        if (['..', '..=', '...'].includes(token.type)) {
            if (operatorIndex >= 0) return null;
            operatorIndex = i;
        }
    }
    if (operatorIndex < 0) return null;
    const isComment = token => token.type.endsWith('comment');
    const hasStart = inner.slice(0, operatorIndex).some(token => !isComment(token));
    const hasEnd = inner.slice(operatorIndex + 1).some(token => !isComment(token));
    return rustRangeTypeName(inner[operatorIndex].type, hasStart, hasEnd);
}

function rustCallIdentity(callNode) {
    if (!callNode || callNode.type !== 'call_expression') return null;
    const fn = callNode.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') {
        return { name: fn.text, isMethod: false };
    }
    if (fn.type === 'scoped_identifier' || fn.type === 'generic_function') {
        const parts = fn.text.split('::').filter(Boolean);
        const name = parts.pop()?.replace(/::<.*$/, '');
        return name ? { name, isMethod: false } : null;
    }
    if (fn.type === 'field_expression') {
        const field = fn.childForFieldName('field');
        return field ? { name: field.text, isMethod: true } : null;
    }
    return null;
}

/**
 * If this receiver is a for-loop binding, retain the exact iterator-source
 * call so query-time analysis can apply its declared Item contract.
 */
function rustIterationSourceOf(node, receiver) {
    if (!receiver) return null;
    let current = node.parent;
    while (current) {
        if (current.type === 'for_expression') {
            const pattern = current.childForFieldName('pattern');
            const value = current.childForFieldName('value');
            if (pattern?.type === 'identifier' && pattern.text === receiver) {
                if (value?.type === 'identifier') {
                    return { receiverIterationVariable: value.text };
                }
                if (value?.type === 'call_expression') {
                    const identity = rustCallIdentity(value);
                    if (!identity) return null;
                    return {
                        receiverIterationCall: identity.name,
                        ...(identity.isMethod && { receiverIterationCallIsMethod: true }),
                        receiverIterationCallLine: value.startPosition.row + 1,
                        receiverIterationCallStart: value.startIndex,
                        receiverIterationCallEnd: value.endIndex,
                    };
                }
            }
        }
        current = current.parent;
    }
    return null;
}

/**
 * Retain the enum-variant contract that binds a match-arm receiver:
 * `DirEntryInner::Raw(ref entry) => entry.path()`. The variant's indexed
 * payload type is resolved query-time, where cross-file identity is known.
 * Destructured/nested payloads abstain unless the receiver is the whole
 * positional field.
 */
function rustPatternBindingOf(node, receiver) {
    if (!receiver) return null;
    const directBindingName = pattern => {
        if (!pattern) return null;
        if (pattern.type === 'identifier') return pattern.text;
        if (!['ref_pattern', 'mut_pattern', 'reference_pattern']
            .includes(pattern.type)) return null;
        const identifiers = [];
        const pending = [pattern];
        while (pending.length > 0) {
            const current = pending.pop();
            if (current.type === 'identifier') {
                identifiers.push(current.text);
                continue;
            }
            if (current !== pattern &&
                ['tuple_pattern', 'tuple_struct_pattern', 'struct_pattern']
                    .includes(current.type)) {
                return null;
            }
            for (let i = 0; i < current.namedChildCount; i++) {
                pending.push(current.namedChild(i));
            }
        }
        return identifiers.length === 1 ? identifiers[0] : null;
    };

    const readPattern = (root, matchValue) => {
        const source = matchValue?.type === 'identifier'
            ? { receiverPatternSourceVariable: matchValue.text }
            : matchValue?.type === 'call_expression'
            ? { receiverPatternSourceCallStart: matchValue.startIndex,
                receiverPatternSourceCallEnd: matchValue.endIndex }
            : {};
        const pending = root ? [root] : [];
        while (pending.length > 0) {
            const pattern = pending.pop();
            if (pattern.type === 'tuple_struct_pattern') {
                const typeNode = pattern.childForFieldName('type');
                const positional = pattern.namedChildren
                    .filter(child => !typeNode || child.id !== typeNode.id);
                for (let i = 0; i < positional.length; i++) {
                    const tupleProjection = (part, steps = []) => {
                        if (directBindingName(part) === receiver) return steps;
                        if (part.type !== 'tuple_pattern') return null;
                        // Unnamed `_` nodes still occupy a tuple position.
                        const elements = part.children.filter(child => !['(', ')', ','].includes(child.type));
                        for (const [position, child] of elements.entries()) {
                            const found = tupleProjection(child, [...steps, position]);
                            if (found) return found;
                        }
                        return null;
                    };
                    const projection = tupleProjection(positional[i]);
                    if (!projection) continue;
                    const pathText = typeNode?.text;
                    if (!pathText) return null;
                    const segments = pathText.split('::').filter(Boolean);
                    const variant = segments.pop();
                    if (!variant) return null;
                    return {
                        receiverPatternVariant: variant,
                        receiverPatternIndex: i,
                        ...(projection.length && { receiverPatternProjection: projection }),
                        ...source,
                        ...(segments.length > 0 && {
                            receiverPatternOwner: segments.join('::'),
                        }),
                    };
                }
            }
            for (let i = 0; i < pattern.namedChildCount; i++) {
                pending.push(pattern.namedChild(i));
            }
        }
        return null;
    };

    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
        if (ancestor.type === 'function_item') break;
        if (ancestor.type === 'block') {
            for (const child of [...ancestor.namedChildren].reverse()) {
                if (child.endIndex > node.startIndex) continue;
                const declaration = child.type === 'expression_statement' ? child.namedChild(0) : child;
                const pattern = declaration?.type === 'let_declaration'
                    ? declaration.childForFieldName('pattern')
                    : declaration?.type === 'assignment_expression'
                    ? declaration.childForFieldName('left') : null;
                if (patternContainsIdentifier(pattern, receiver)) {
                    return declaration.type === 'let_declaration' && declaration.childForFieldName('alternative')
                        ? readPattern(pattern, declaration.childForFieldName('value')) : null;
                }
            }
        }
        if (ancestor.type === 'for_expression' &&
            patternContainsIdentifier(ancestor.childForFieldName('pattern'), receiver)) return null;
        if (ancestor.type === 'closure_expression') {
            const params = ancestor.childForFieldName('parameters');
            if (params && patternContainsIdentifier(params, receiver)) break;
            continue; // captured binding from an outer match arm
        }
        let matchValue, root;
        if (ancestor.type === 'match_arm') {
            let matchExpression = ancestor.parent;
            while (matchExpression && matchExpression.type !== 'match_expression' &&
                matchExpression.type !== 'function_item') matchExpression = matchExpression.parent;
            matchValue = matchExpression?.type === 'match_expression'
                ? matchExpression.childForFieldName('value') : null;
            root = ancestor.childForFieldName('pattern');
        } else if (['if_expression', 'while_expression'].includes(ancestor.type)) {
            const body = ancestor.childForFieldName(ancestor.type === 'if_expression' ? 'consequence' : 'body');
            const condition = ancestor.childForFieldName('condition');
            if (!body || node.startIndex < body.startIndex || node.endIndex > body.endIndex ||
                condition?.type !== 'let_condition') continue;
            matchValue = condition.childForFieldName('value');
            root = condition.childForFieldName('pattern');
        } else continue;
        if (!patternContainsIdentifier(root, receiver)) continue;
        return readPattern(root, matchValue);
    }
    return null;
}

function patternContainsIdentifier(pattern, name) {
    const pending = pattern ? [pattern] : [];
    while (pending.length > 0) {
        const current = pending.pop();
        if (current.type === 'identifier' && current.text === name) return true;
        for (let i = 0; i < current.namedChildCount; i++) {
            pending.push(current.namedChild(i));
        }
    }
    return false;
}

/**
 * Syntactic context a macro invocation's expansion is parsed in: 'items'
 * (module or impl/trait body), 'stmts' (statement or block tail), 'expr', or
 * null where no expansion can stand (patterns, types).
 */
function rustMacroInvocationContext(node) {
    const parent = node.parent;
    if (!parent) return null;
    switch (parent.type) {
        case 'source_file':
            return 'items';
        case 'declaration_list':
            return 'items';
        case 'expression_statement':
        case 'block':
            return 'stmts';
        default:
            break;
    }
    if (/pattern/.test(parent.type)) return null;
    for (const field of ['type', 'return_type', 'trait']) {
        const typed = parent.childForFieldName(field);
        if (typed && typed.startIndex === node.startIndex && typed.endIndex === node.endIndex) return null;
    }
    if (parent.type === 'type_arguments') return null;
    if (parent.type === 'match_arm') {
        const value = parent.childForFieldName('value');
        return value && value.startIndex === node.startIndex && value.endIndex === node.endIndex ? 'expr' : null;
    }
    return 'expr';
}

function rustMacroCallIdentity(macroNode) {
    if (!macroNode) return null;
    const parts = macroNode.text.replace(/!$/, '').split('::').filter(Boolean);
    const name = parts.pop();
    if (!name) return null;
    return {
        name,
        ...(parts.length > 0 && {
            receiver: parts.map(part => part === '$crate' ? 'crate' : part).join('::'),
        }),
    };
}

/**
 * Is this expression the value the enclosing fn item returns (fix #369)?
 * The fn body's tail expression, or the operand of a `return` whose nearest
 * function-like ancestor is that fn item (a closure boundary stops it). The
 * value then has the fn's declared return type, which lets a trait path call
 * (`Trait::assoc(..)`) infer its Self from the declaration.
 */
function rustFunctionReturnPosition(node) {
    const parent = node.parent;
    if (!parent) return false;
    if (parent.type === 'return_expression') {
        for (let p = parent.parent; p; p = p.parent) {
            if (p.type === 'closure_expression') return false;
            if (p.type === 'function_item') return true;
        }
        return false;
    }
    if (parent.type !== 'block' || parent.parent?.type !== 'function_item') return false;
    const last = parent.namedChild(parent.namedChildCount - 1);
    return !!last && sameNode(last, node);
}

/**
 * Does a local value binding shadow a bare callee name at this call (fix
 * #369)? `let bridge = bridge_impl; join(|c| bridge(c))` calls the local
 * function value, never the module item `bridge`. Walks the lexical scopes
 * outward to the enclosing fn item: `let` patterns of earlier statements in
 * each block, closure / fn parameters, `for` patterns, `if let` / `while let`
 * conditions and match-arm patterns that enclose the call. Items (`fn`
 * declared in a block) are not value bindings and do not count.
 */
function rustPatternBindsName(pattern, name) {
    if (!pattern) return false;
    const pending = [pattern];
    while (pending.length > 0) {
        const current = pending.pop();
        if (current.type === 'identifier') {
            if (current.text === name) return true;
            continue;
        }
        // Type annotations, paths and literals inside a pattern bind nothing.
        if (/type|scoped_identifier|field_identifier|literal/.test(current.type) &&
            current.type !== 'tuple_struct_pattern') continue;
        if (current.type === 'tuple_struct_pattern' || current.type === 'struct_pattern') {
            // The first child is the constructor path, never a binding.
            for (let i = 1; i < current.namedChildCount; i++) pending.push(current.namedChild(i));
            continue;
        }
        if (current.type === 'field_pattern') {
            const shorthand = current.namedChildren.find(c => c.type === 'shorthand_field_identifier');
            if (shorthand?.text === name) return true;
            const inner = current.childForFieldName('pattern');
            if (inner) pending.push(inner);
            continue;
        }
        if (current.type === 'shorthand_field_identifier') {
            if (current.text === name) return true;
            continue;
        }
        for (let i = 0; i < current.namedChildCount; i++) pending.push(current.namedChild(i));
    }
    return false;
}

function rustBareNameShadowedByLocal(callNode, name) {
    let child = callNode;
    for (let p = callNode.parent; p; child = p, p = p.parent) {
        if (p.type === 'block') {
            for (let i = 0; i < p.namedChildCount; i++) {
                const statement = p.namedChild(i);
                if (statement.startIndex >= child.startIndex) break;
                if (statement.type === 'let_declaration' &&
                    rustPatternBindsName(statement.childForFieldName('pattern'), name)) return true;
            }
        } else if (p.type === 'closure_expression') {
            if (rustPatternBindsName(p.childForFieldName('parameters'), name)) return true;
        } else if (p.type === 'function_item') {
            const params = p.childForFieldName('parameters');
            for (const param of params?.namedChildren || []) {
                if (param.type === 'parameter' &&
                    rustPatternBindsName(param.childForFieldName('pattern'), name)) return true;
            }
            return false;
        } else if (p.type === 'for_expression') {
            const body = p.childForFieldName('body');
            if (body && sameNode(body, child) &&
                rustPatternBindsName(p.childForFieldName('pattern'), name)) return true;
        } else if (p.type === 'match_arm') {
            const value = p.childForFieldName('value');
            if (value && sameNode(value, child) &&
                rustPatternBindsName(p.childForFieldName('pattern'), name)) return true;
        } else if (p.type === 'if_expression' || p.type === 'while_expression') {
            const condition = p.childForFieldName('condition');
            const consequence = p.childForFieldName('consequence') || p.childForFieldName('body');
            if (consequence && sameNode(consequence, child) && condition) {
                const lets = [condition];
                while (lets.length > 0) {
                    const current = lets.pop();
                    if (current.type === 'let_condition' &&
                        rustPatternBindsName(current.childForFieldName('pattern'), name)) return true;
                    if (current.type === 'let_chain') {
                        for (let i = 0; i < current.namedChildCount; i++) lets.push(current.namedChild(i));
                    }
                }
            }
        }
    }
    return false;
}

const rustBindingFactsByTree = new WeakMap();
const RUST_BINDING_HOLDERS = new Set(['let_declaration', 'parameter', 'closure_parameters',
    'for_expression', 'let_condition', 'match_pattern', 'self_parameter']);

/**
 * Is `child` the binding of its holder rather than an expression inside it
 * (fix #389): the value of `let x = v;`, a parameter's type, a loop's
 * iterator or a match guard are not bindings.
 */
function rustBindingPosition(parent, child) {
    const field = {
        let_declaration: 'pattern', parameter: 'pattern', for_expression: 'pattern',
        let_condition: 'pattern',
    }[parent.type];
    if (field) return sameNode(parent.childForFieldName(field), child);
    if (parent.type === 'match_pattern') return !sameNode(parent.childForFieldName('condition'), child);
    return true;
}

/**
 * How many bindings of each name one function introduces (let patterns,
 * parameters, closure parameters, loop/match/if-let patterns; shadowing
 * `let` counts again) and which names are assigned (fix #381).
 */
function rustBindingFacts(fnNode) {
    let byId = rustBindingFactsByTree.get(fnNode.tree);
    if (!byId) { byId = new Map(); rustBindingFactsByTree.set(fnNode.tree, byId); }
    let facts = byId.get(fnNode.id);
    if (facts) return facts;
    facts = { declared: new Map(), assigned: new Set() };
    const record = (child) => {
        if (child.type === 'identifier' || child.type === 'shorthand_field_identifier') {
            const parent = child.parent;
            if (parent && (RUST_BINDING_HOLDERS.has(parent.type) || parent.type.endsWith('pattern')) &&
                rustBindingPosition(parent, child)) {
                facts.declared.set(child.text, (facts.declared.get(child.text) || 0) + 1);
            }
        } else if (child.type === 'assignment_expression' || child.type === 'compound_assignment_expr') {
            const left = child.childForFieldName('left');
            if (left?.type === 'identifier') facts.assigned.add(left.text);
        }
    };
    // Every named descendant, from the flat node list when one is cached
    // (fix #388); the facts are counts and sets, so visit order is free.
    const range = cachedNodeRange(fnNode);
    if (range) {
        const { nodes, subtreeEnds, index } = range;
        for (let i = index + 1, end = subtreeEnds[index]; i < end; i++) record(nodes[i]);
    } else {
        const walk = (node) => {
            for (const child of node.namedChildren) {
                record(child);
                walk(child);
            }
        };
        walk(fnNode);
    }
    byId.set(fnNode.id, facts);
    return facts;
}

// axum method routers (fix #383): `get(h)`, `post_service(svc)`, `any(h)`,
// `on(MethodFilter::GET.or(MethodFilter::POST), h)`, chained with
// `.post(h2)` and wrapped by combinators that return the same router.
const RUST_METHOD_ROUTER_VERBS = {
    get: 'GET', post: 'POST', put: 'PUT', delete: 'DELETE', patch: 'PATCH', head: 'HEAD',
    options: 'OPTIONS', trace: 'TRACE', connect: 'CONNECT', any: 'ALL',
};
const RUST_METHOD_ROUTER_PASSTHROUGH = new Set(['layer', 'route_layer', 'with_state', 'handle_error']);

function rustRouteArgs(callNode) {
    const argsNode = callNode.childForFieldName('arguments');
    const args = [];
    for (let i = 0; argsNode && i < argsNode.namedChildCount; i++) {
        const arg = argsNode.namedChild(i);
        if (!arg.type.includes('comment') && arg.type !== 'attribute_item') args.push(arg);
    }
    return args;
}

function rustHandlerName(node) {
    if (!node) return '<anonymous>';
    if (node.type === 'identifier') return node.text;
    if (node.type === 'scoped_identifier') return node.childForFieldName('name')?.text || node.text;
    if (node.type === 'generic_function') return rustHandlerName(node.childForFieldName('function'));
    if (node.type === 'field_expression') return node.childForFieldName('field')?.text || '<anonymous>';
    if (node.type === 'call_expression') return rustHandlerName(node.childForFieldName('function'));
    return '<anonymous>';
}

/** Methods a `MethodFilter` expression selects, or null. */
function rustMethodFilter(node) {
    if (!node) return null;
    if (node.type === 'scoped_identifier') {
        const name = node.childForFieldName('name')?.text;
        return name && /^[A-Z]+$/.test(name) ? [name] : null;
    }
    if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function');
        if (fn?.type === 'field_expression' && fn.childForFieldName('field')?.text === 'or') {
            const left = rustMethodFilter(fn.childForFieldName('value'));
            const right = rustMethodFilter(rustRouteArgs(node)[0]);
            return left && right ? [...left, ...right] : null;
        }
    }
    return null;
}

/** [{ method, handler }] a method-router expression serves, or null. */
function rustMethodRouterEntries(node, depth = 0) {
    if (!node || depth > 32) return null;
    if (node.type === 'parenthesized_expression') return rustMethodRouterEntries(node.namedChild(0), depth + 1);
    if (node.type !== 'call_expression') return null;
    const fn = node.childForFieldName('function');
    const args = rustRouteArgs(node);
    const entriesFor = (name) => {
        const base = name.replace(/_service$/, '');
        if (RUST_METHOD_ROUTER_VERBS[base]) {
            return [{ method: RUST_METHOD_ROUTER_VERBS[base], handler: rustHandlerName(args[0]) }];
        }
        if (base === 'on') {
            const methods = rustMethodFilter(args[0]);
            return methods ? methods.map(method => ({ method, handler: rustHandlerName(args[1]) })) : null;
        }
        return null;
    };
    if (fn?.type === 'identifier' || fn?.type === 'scoped_identifier') {
        const name = fn.type === 'identifier' ? fn.text : fn.childForFieldName('name')?.text;
        return name ? entriesFor(name) : null;
    }
    if (fn?.type === 'field_expression') {
        const inner = rustMethodRouterEntries(fn.childForFieldName('value'), depth + 1);
        if (!inner) return null;
        const name = fn.childForFieldName('field')?.text || '';
        if (RUST_METHOD_ROUTER_PASSTHROUGH.has(name)) return inner;
        const added = entriesFor(name);
        return added ? [...inner, ...added] : null;
    }
    return null;
}

/** axum `.route(path, <method router>)` / `.route_service(path, svc)`. */
function rustMethodRouterOf(callNode, name) {
    const args = rustRouteArgs(callNode);
    if (args.length !== 2) return null;
    if (name === 'route_service') return [{ method: 'ALL', handler: rustHandlerName(args[1]) }];
    const entries = rustMethodRouterEntries(args[1]);
    if (!entries || entries.length === 0) return null;
    const seen = new Set();
    return entries.filter(entry => {
        const key = `${entry.method}\0${entry.handler}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Is a bare identifier in expression position an item path rather than a
 * local (fix #389)? A name no binding of the enclosing fn declares (let
 * patterns, parameters, closure parameters, match/for/if-let patterns) is
 * resolved in the item namespaces: a unit struct, a const, a variant... The
 * per-fn binding facts are a superset, so any binding of the name anywhere
 * in the fn keeps it a possible local.
 */
function rustIdentifierIsItemPath(identNode) {
    let fnNode = null;
    for (let parent = identNode.parent; parent; parent = parent.parent) {
        if (parent.type === 'function_item') { fnNode = parent; break; }
        if (parent.type === 'token_tree' || parent.type === 'macro_invocation') return false;
    }
    if (!fnNode) return !rustBareNameShadowedByLocal(identNode, identNode.text);
    return !rustBindingFacts(fnNode).declared.has(identNode.text);
}

/**
 * The item path a value receiver names (fix #389): a bare identifier that is
 * no local (`S.plain()`), a path (`E::Unit.m()`, `m::S.m()`), a struct
 * expression (`P { x }.m()`), or a once-bound immutable local holding one of
 * those (`let w = S; w.m()`). Returns { path, kind } or null.
 */
function rustReceiverValuePath(valueNode) {
    if (!valueNode) return null;
    if (valueNode.type === 'scoped_identifier') {
        return /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)+$/.test(valueNode.text)
            ? { path: valueNode.text, kind: 'value' } : null;
    }
    if (valueNode.type === 'struct_expression') {
        let nameNode = valueNode.childForFieldName('name');
        if (nameNode?.type === 'generic_type' || nameNode?.type === 'generic_type_with_turbofish') {
            nameNode = nameNode.childForFieldName('type');
        }
        const text = nameNode?.text?.replace(/\s+/g, '');
        return text && /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*$/.test(text)
            ? { path: text, kind: 'struct' } : null;
    }
    if (valueNode.type !== 'identifier') return null;
    if (rustIdentifierIsItemPath(valueNode)) return { path: valueNode.text, kind: 'value' };
    // `let w = S;` (bound once, never assigned, not `mut`): w holds S.
    let fnNode = null;
    for (let parent = valueNode.parent; parent; parent = parent.parent) {
        if (parent.type === 'function_item') { fnNode = parent; break; }
    }
    if (!fnNode) return null;
    const name = valueNode.text;
    const facts = rustBindingFacts(fnNode);
    if (facts.declared.get(name) !== 1 || facts.assigned.has(name)) return null;
    for (let block = valueNode.parent; block && block.id !== fnNode.id; block = block.parent) {
        if (block.type !== 'block') continue;
        for (const stmt of block.namedChildren) {
            if (stmt.startIndex >= valueNode.startIndex) break;
            if (stmt.type !== 'let_declaration') continue;
            const pattern = stmt.childForFieldName('pattern');
            if (pattern?.type !== 'identifier' || pattern.text !== name) continue;
            const value = stmt.childForFieldName('value');
            if (!value || value.type === 'identifier' && value.text === name) return null;
            if (value.type === 'identifier' || value.type === 'scoped_identifier' ||
                value.type === 'struct_expression') {
                return rustReceiverValuePath(value);
            }
            return null;
        }
    }
    return null;
}

/**
 * The field path an immutable one-hop `let` alias stands for (fix #381):
 * `let c = &self.config; c.load()` receives like `self.config.load()`. The
 * name is bound once in the function (no shadowing `let`), not `mut`, and
 * the path's root is `self` or a once-bound local.
 */
function rustFieldAliasOf(identNode) {
    let fnNode = null;
    for (let parent = identNode.parent; parent; parent = parent.parent) {
        if (parent.type === 'function_item') { fnNode = parent; break; }
    }
    if (!fnNode) return null;
    const name = identNode.text;
    const facts = rustBindingFacts(fnNode);
    if (facts.declared.get(name) !== 1 || facts.assigned.has(name)) return null;
    for (let block = identNode.parent; block && block.id !== fnNode.id; block = block.parent) {
        if (block.type !== 'block') continue;
        for (const stmt of block.namedChildren) {
            if (stmt.startIndex >= identNode.startIndex) break;
            if (stmt.type !== 'let_declaration') continue;
            const pattern = stmt.childForFieldName('pattern');
            if (pattern?.type !== 'identifier' || pattern.text !== name) continue;
            let value = stmt.childForFieldName('value');
            if (value?.type === 'reference_expression') value = value.childForFieldName('value');
            if (value?.type !== 'field_expression') return null;
            let root = value;
            while (root?.type === 'field_expression') {
                if (root.childForFieldName('field')?.type !== 'field_identifier') return null;
                root = root.childForFieldName('value');
            }
            if (root?.type === 'self') return value;
            if (root?.type === 'identifier' && root.text !== name &&
                facts.declared.get(root.text) === 1 && !facts.assigned.has(root.text)) return value;
            return null;
        }
    }
    return null;
}

function findCallsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const calls = [];
    // Words of every value-binding pattern seen so far in document order
    // (fix #369). A binding shadows a bare call only if it precedes the call,
    // so this superset gates the exact ancestor walk below.
    const bindingWords = new Set();
    const BINDING_HOLDERS = new Set(['let_declaration', 'parameter', 'closure_parameters',
        'for_expression', 'match_arm', 'let_condition']);
    const mayBeLocallyBound = name => bindingWords.has(name);
    const functionStack = [];  // Stack of { name, startLine, endLine }
    // Track variable -> type mappings per function scope (scopeStartLine -> Map<varName, typeName>)
    const scopeTypes = new Map();
    // Lexical rebindings that do not have a call producer (`let m = match m
    // { ... }`) invalidate query-time return flow. Without a tombstone, the
    // previous `m = make_result()` annotation survives and can positively
    // exclude true calls on the rebound value. Events are range-aware so a
    // nested-block shadow does not leak after the block.
    const scopeFlowEvents = new Map();

    // Helper: extract first string-arg literal from a call_expression node.
    // Used by route extraction to capture path arg of client.get("/users") and
    // detect format!() macro interpolation: format!("/users/{}", id).
    const { extractStringArg: _extractStringArg } = require('./utils');
    const getFirstStringArg = (callNode) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return null;
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type.endsWith('comment')) continue;
            // format!() macro inside an arg: client.get(format!("/users/{}", id))
            if (arg.type === 'macro_invocation') {
                const macroNode = arg.childForFieldName('macro');
                const macroName = macroNode ? macroNode.text.replace(/!$/, '') : '';
                if (macroName === 'format') {
                    return _extractStringArg(arg);
                }
            }
            return _extractStringArg(arg);
        }
        return null;
    };

    // Helper to check if a node creates a function scope
    const isFunctionNode = (node) => {
        return ['function_item', 'closure_expression'].includes(node.type);
    };

    const extractTypeQualifier = (typeNode) => {
        if (!typeNode) return null;
        if (typeNode.type === 'reference_type') {
            for (let i = 0; i < typeNode.namedChildCount; i++) {
                const qualifier = extractTypeQualifier(typeNode.namedChild(i));
                if (qualifier) return qualifier;
            }
            return null;
        }
        if (typeNode.type === 'scoped_type_identifier') {
            const nameNode = typeNode.childForFieldName('name');
            const text = typeNode.text;
            const suffix = nameNode ? `::${nameNode.text}` : '';
            return suffix && text.endsWith(suffix)
                ? text.slice(0, -suffix.length) : null;
        }
        return null;
    };

    // Index contracts of std containers (fix #359): `items: &Vec<Conv>` makes
    // `items[i]` a Conv, `m: HashMap<K, Conv>` makes `m[&k]` a Conv, and
    // `[Conv; N]` / `&[Conv]` index to Conv. Only the declared slot is used;
    // generic parameters and unknown containers abstain.
    const RUST_SEQUENCE_CONTAINERS = new Set(['Vec', 'VecDeque']);
    const RUST_MAP_CONTAINERS = new Set(['HashMap', 'BTreeMap']);
    const rustIndexElement = (typeNode) => {
        let current = typeNode;
        while (current?.type === 'reference_type') {
            current = current.childForFieldName('type') ||
                current.namedChildren.find(c => c.type !== 'lifetime' && c.type !== 'mutable_specifier');
        }
        if (!current) return null;
        let element = null;
        if (current.type === 'array_type') {
            element = current.childForFieldName('element');
        } else if (current.type === 'generic_type') {
            const base = extractTypeName(current.childForFieldName('type') || current.namedChild(0));
            const argsNode = current.childForFieldName('type_arguments') ||
                current.namedChildren.find(c => c.type === 'type_arguments');
            const args = (argsNode?.namedChildren || []).filter(c =>
                c.type !== 'lifetime' && !c.type.endsWith('comment'));
            if (RUST_SEQUENCE_CONTAINERS.has(base) && args.length === 1) element = args[0];
            else if (RUST_MAP_CONTAINERS.has(base) && args.length === 2) element = args[1];
        }
        if (!element) return null;
        const type = extractTypeName(element);
        if (!type || /^[A-Z][A-Z0-9]?$/.test(type)) return null;
        const qualifier = extractTypeQualifier(element);
        return { type, ...(qualifier && { qualifier }) };
    };
    const isElementIndex = (indexNode) => indexNode?.type === 'index_expression' &&
        indexNode.namedChild(1)?.type !== 'range_expression';

    // Build type map from function parameters (including self receiver for impl methods)
    const buildScopeTypeMap = (node) => {
        const typeMap = new ReceiverTypeMap();
        typeMap.qualifiers = new Map();
        typeMap.iteratorItems = new Map();
        typeMap.annotationTexts = new Map();
        typeMap.indexElements = new Map();
        typeMap.refKinds = new Map();
        typeMap.stdTypes = new Set();
        typeMap.boundNames = new Set();
        const retainBoundNames = (pattern) => {
            if (!pattern) return;
            const pending = [pattern];
            while (pending.length > 0) {
                const current = pending.pop();
                if (current.type === 'identifier') {
                    typeMap.boundNames.add(current.text);
                    continue;
                }
                for (let i = 0; i < current.namedChildCount; i++) {
                    pending.push(current.namedChild(i));
                }
            }
        };
        const paramsNode = node.childForFieldName('parameters');
        if (paramsNode) {
            for (let i = 0; i < paramsNode.namedChildCount; i++) {
                const param = paramsNode.namedChild(i);
                if (param.type === 'parameter') {
                    const patternNode = param.childForFieldName('pattern');
                    retainBoundNames(patternNode);
                    const declaredType = param.childForFieldName('type');
                    // `p: Arc<Store>` receives as its Deref target (fix
                    // #401); the wrapper chain rides on the evidence.
                    const deref = rustDerefTypedName(declaredType);
                    if (deref && !deref.typeName) continue;
                    const typeNode = deref ? deref.inner : declaredType;
                    const sliceType = rustSliceTypeOf(typeNode) || rustRawPointerTypeOf(typeNode);
                    // `other: &Self` is the enclosing impl's self type (fix
                    // #399); in a trait's own methods it is the implementor,
                    // which no annotation names.
                    const written = deref ? deref.typeName : extractTypeName(typeNode);
                    const typeName = (written === 'Self' ? findEnclosingImplType(param) : written) || sliceType;
                    const qualifier = extractTypeQualifier(typeNode);
                    const iteratorItem = extractRustIteratorItemTypeFromTypeNode(typeNode);
                    const indexElement = patternNode?.type === 'identifier'
                        ? rustIndexElement(typeNode) : null;
                    if (indexElement) typeMap.indexElements.set(patternNode.text, indexElement);
                    if (patternNode && typeName) {
                        // Pattern can be identifier or _
                        const name = patternNode.type === 'identifier' ? patternNode.text : null;
                        if (name) {
                            typeMap.set(name, typeName, deref
                                ? { ...typeOrigin('annotation', param), derefVia: deref.via, derefOuterRef: deref.outerRef }
                                : 'annotation', param);
                            typeMap.annotationTexts.set(name, typeNode.text);
                            typeMap.refKinds.set(name, rustTypeRefKind(typeNode));
                            if ((sliceType && typeName === sliceType) || deref?.std) typeMap.stdTypes.add(name);
                            if (qualifier) typeMap.qualifiers.set(name, qualifier);
                            if (iteratorItem) typeMap.iteratorItems.set(name, iteratorItem);
                        }
                    }
                } else {
                    // Closure parameters normally have no annotation. They
                    // still bind the name and must stop lookup before an
                    // identically-named outer parameter (`arg: &str`;
                    // `.any(|arg| arg.method())`) leaks its unrelated type
                    // into the closure call record.
                    retainBoundNames(param);
                }
            }
        }
        return typeMap;
    };

    // Helper to extract function name from a function node
    const extractFunctionName = (node) => {
        if (node.type === 'function_item') {
            const nameNode = node.childForFieldName('name');
            return nameNode?.text || '<anonymous>';
        }
        if (node.type === 'closure_expression') {
            return '<closure>';
        }
        return '<anonymous>';
    };

    // Helper to get current enclosing function
    const getCurrentEnclosingFunction = () => {
        return functionStack.length > 0
            ? {
                ...functionStack[functionStack.length - 1],
                scopeChain: functionStack.map(scope => scope.startLine),
            }
            : null;
    };

    const patternContainsName = (pattern, varName) => {
        if (!pattern) return false;
        const stack = [pattern];
        while (stack.length > 0) {
            const n = stack.pop();
            if (n.type === 'identifier' && n.text === varName) return true;
            for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
        }
        return false;
    };

    // Rust pattern bindings are block-scoped and may shadow a typed outer
    // variable (`if let Some(v) = v.downcast_mut::<T>() { v.m() }`). The
    // function-wide type map intentionally does not guess the pattern's type,
    // but it must also never smear the OUTER type onto the inner binding.
    const patternShadowsAt = (node, varName) => {
        for (let a = node?.parent; a && !isFunctionNode(a); a = a.parent) {
            if (a.type !== 'if_expression' && a.type !== 'while_expression') continue;
            const cond = a.namedChildren.find(c => c.type === 'let_condition');
            if (!cond) continue;
            const body = a.namedChildren.find(c =>
                c.type === 'block' && c.startIndex >= cond.endIndex);
            if (!body || node.startIndex < body.startIndex || node.endIndex > body.endIndex) continue;
            const pattern = cond.namedChild(0);
            if (patternContainsName(pattern, varName)) return true;
        }
        return false;
    };

    const valueHasFlowProducer = (value) => {
        let n = value;
        while (n && ['try_expression', 'await_expression', 'parenthesized_expression'].includes(n.type)) {
            n = n.namedChildCount === 1 ? n.namedChild(0) : null;
        }
        return n?.type === 'call_expression' || n?.type === 'macro_invocation' ||
            !!rustMatchCallProducer(n);
    };

    const flowEventAt = (node, varName) => {
        const pos = node?.startIndex ?? -1;
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const byName = scopeFlowEvents.get(functionStack[i].startLine);
            const events = byName?.get(varName);
            if (!events) continue;
            let latest = null;
            for (const event of events) {
                if (event.at <= pos && pos <= event.until &&
                    (!latest || event.at > latest.at)) latest = event;
            }
            if (latest) return latest;
        }
        return null;
    };

    const flowInvalidatedAt = (node, varName) =>
        !!flowEventAt(node, varName)?.invalidated;

    // Look up variable type from scope chain
    const getReceiverType = (varName, atNode, evidence = false) => {
        if (atNode && patternShadowsAt(atNode, varName)) return undefined;
        const flow = flowEventAt(atNode, varName);
        if (flow?.type) {
            const { until, letStart, ...origin } = flow;
            return evidence ? { receiverTypeSource: 'flow',
                receiverTypeEvidence: { ...typeOrigin('flow', atNode), ...origin,
                    ...(Number.isFinite(until) && { until }) },
                ...(flow.qualifier && { receiverTypeQualifier: flow.qualifier }) } : flow.type;
        }
        // An untyped `let` in scope hides the outer binding's type.
        const shadowedBy = flow && flow.letStart != null ? flow : null;
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const typeMap = scopeTypes.get(functionStack[i].startLine);
            if (typeMap?.has(varName) && shadowedBy) {
                const start = typeMap.origins.get(varName)?.start;
                if (!(start >= shadowedBy.letStart && start <= shadowedBy.at)) return undefined;
            }
            if (typeMap?.has(varName)) return evidence ? { ...typeMap.fields(varName),
                ...(typeMap.qualifiers?.has(varName) && { receiverTypeQualifier: typeMap.qualifiers.get(varName) }),
                ...(typeMap.refKinds?.has(varName) && { receiverTypeRef: typeMap.refKinds.get(varName) }),
                ...(typeMap.stdTypes?.has(varName) && { receiverTypeStd: true }) }
                : typeMap.get(varName);
            if (typeMap?.boundNames?.has(varName)) return undefined;
        }
        return undefined;
    };

    // Argument type descriptors for trait-impl selection (fix #384). Only
    // names some enclosing scope types can have one (flow-typed locals are
    // not argument evidence), so untyped names skip the positional lookup.
    const scopeTypesName = (name) => {
        for (let i = functionStack.length - 1; i >= 0; i--) {
            if (scopeTypes.get(functionStack[i].startLine)?.has(name)) return true;
        }
        return false;
    };
    const astArgTypeOfName = (name, atNode) => scopeTypesName(name)
        ? rustKnownArgNameType(name, atNode, getReceiverType, patternShadowsAt, null) : null;

    const getReceiverTypeQualifier = (varName, atNode) => {
        if (atNode && patternShadowsAt(atNode, varName)) return undefined;
        const flow = flowEventAt(atNode, varName);
        if (flow?.qualifier) return flow.qualifier;
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const typeMap = scopeTypes.get(functionStack[i].startLine);
            if (typeMap?.qualifiers?.has(varName)) {
                return typeMap.qualifiers.get(varName);
            }
            if (typeMap?.boundNames?.has(varName)) return undefined;
        }
        return undefined;
    };

    // A std deref wrapper constructed around a typed value (fix #401):
    // `ManuallyDrop::new(self)`, `Box::new(Store::new())`, `Arc::new(x)`,
    // `Rc::clone(&rc)`, `Box::pin(f)`, `Pin::new(&mut x)`,
    // `AssertUnwindSafe(x)`. Returns { via, typeName, qualifier, source }
    // (typeName null when the wrapped value's type is unknown), or null
    // when the value is no such construction.
    const rustStdDerefConstruction = (valueNode, atNode, depth = 0) => {
        if (depth > 4 || valueNode?.type !== 'call_expression') return null;
        let fn = valueNode.childForFieldName('function');
        if (fn?.type === 'generic_function') fn = fn.childForFieldName('function');
        let wrapper;
        let method = null;
        if (fn?.type === 'identifier' && fn.text === 'AssertUnwindSafe') {
            wrapper = 'AssertUnwindSafe';
        } else if (fn?.type === 'scoped_identifier') {
            const pathNode = fn.childForFieldName('path');
            method = fn.childForFieldName('name')?.text;
            const head = pathNode?.type === 'generic_type'
                ? pathNode.childForFieldName('type') || pathNode.namedChild(0) : pathNode;
            const headName = head?.type === 'identifier' || head?.type === 'type_identifier' ? head.text
                : head?.type === 'scoped_identifier' || head?.type === 'scoped_type_identifier'
                    ? head.childForFieldName('name')?.text : null;
            if (!headName || !RUST_STD_DEREF_WRAPPERS.has(headName)) return null;
            const constructs = method === 'new' && ['Box', 'Rc', 'Arc', 'ManuallyDrop', 'Pin'].includes(headName);
            const pins = method === 'pin' && ['Box', 'Rc', 'Arc'].includes(headName);
            const clones = method === 'clone' && ['Rc', 'Arc'].includes(headName);
            if (!constructs && !pins && !clones) return null;
            wrapper = head.text.replace(/\s+/g, '');
        } else {
            return null;
        }
        const argsNode = valueNode.childForFieldName('arguments');
        const args = (argsNode?.namedChildren || []).filter(child => !child.type.endsWith('comment'));
        if (args.length !== 1) return { via: [wrapper], typeName: null };
        // `Box::pin(x)` makes a `Pin<Box<_>>`: Pin is implied, not written.
        const outer = method === 'pin' ? ['=Pin', wrapper] : [wrapper];
        let arg = args[0];
        let derefArg = false;
        while (arg?.type === 'reference_expression' || arg?.type === 'parenthesized_expression') {
            if (arg.type === 'reference_expression') derefArg = true;
            arg = arg.childForFieldName('value') || arg.namedChild(arg.namedChildCount - 1);
        }
        // `Pin::new(&mut x)` and `Rc::clone(&rc)` take a reference: the
        // result derefs to what the referent derefs to.
        if ((wrapper.endsWith('Pin') || method === 'clone') && !derefArg) return { via: outer, typeName: null };
        if (arg?.type === 'self') {
            const typeName = findEnclosingImplType(arg);
            return { via: outer, typeName: typeName || null, source: 'constructor' };
        }
        if (arg?.type === 'identifier') {
            const typed = getReceiverType(arg.text, atNode, true);
            const typeName = getReceiverType(arg.text, atNode);
            if (!typeName) return { via: outer, typeName: null };
            const inner = typed?.receiverTypeEvidence?.derefVia || [];
            // `Rc::clone(&rc)` is the same Rc: its own chain, not one more layer.
            const via = method === 'clone' ? inner : [...outer, ...inner];
            if (via.length === 0) return { via: outer, typeName: null };
            const source = typed?.receiverTypeSource === 'guess' ? 'guess' : 'constructor';
            const qualifier = getReceiverTypeQualifier(arg.text, atNode);
            return { via, typeName, ...(qualifier && { qualifier }), source };
        }
        if (method === 'clone') return { via: outer, typeName: null };
        if (arg?.type === 'struct_expression') {
            const pathText = arg.childForFieldName('name')?.text || '';
            const segments = pathText.split('::');
            const typeName = segments.pop();
            return { via: outer, typeName: /^[A-Z]/.test(typeName || '') ? typeName : null,
                ...(segments.length > 0 && { qualifier: segments.join('::') }), source: 'constructor' };
        }
        if (arg?.type === 'call_expression') {
            const nested = rustStdDerefConstruction(arg, atNode, depth + 1);
            if (nested) return { ...nested, via: [...outer, ...nested.via] };
            const callee = arg.childForFieldName('function');
            if (callee?.type === 'scoped_identifier') {
                const segments = callee.text.split('::');
                const ctor = segments[segments.length - 1];
                const typeName = segments[segments.length - 2];
                if (segments.length >= 2 && /^(new|from|default|with_|create|build|open|connect|init)/.test(ctor) &&
                    /^[A-Z]/.test(typeName || '') && !RUST_STD_DEREF_WRAPPERS.has(typeName)) {
                    // The prelude's `Vec`/`String` constructors make that
                    // std type (a project namesake is checked at query time).
                    const prelude = segments.length === 2 && (typeName === 'Vec' || typeName === 'String');
                    return { via: outer, typeName,
                        ...(segments.length > 2 && { qualifier: segments.slice(0, -2).join('::') }),
                        source: prelude ? 'literal' : 'guess', ...(prelude && { std: true }) };
                }
            }
        }
        return { via: outer, typeName: null };
    };

    const getReceiverIteratorItemType = (varName, atNode) => {
        if (atNode && patternShadowsAt(atNode, varName)) return undefined;
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const typeMap = scopeTypes.get(functionStack[i].startLine);
            if (typeMap?.iteratorItems?.has(varName)) {
                return typeMap.iteratorItems.get(varName);
            }
            if (typeMap?.boundNames?.has(varName)) return undefined;
        }
        return undefined;
    };

    const getReceiverIndexElement = (varName, atNode) => {
        if (atNode && patternShadowsAt(atNode, varName)) return undefined;
        if (flowEventAt(atNode, varName)) return undefined;
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const typeMap = scopeTypes.get(functionStack[i].startLine);
            if (typeMap?.indexElements?.has(varName)) return typeMap.indexElements.get(varName);
            if (typeMap?.has(varName) || typeMap?.boundNames?.has(varName)) return undefined;
        }
        return undefined;
    };

    // Reference layer of a variable's declared type (fix #368): 'owned',
    // '&' or '&mut'. Unknown after a flow rebinding or for untyped names.
    const getReceiverRefKind = (varName, atNode) => {
        if (atNode && patternShadowsAt(atNode, varName)) return undefined;
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const typeMap = scopeTypes.get(functionStack[i].startLine);
            if (typeMap?.has(varName)) return typeMap.refKinds?.get(varName);
            if (typeMap?.boundNames?.has(varName)) return undefined;
        }
        return undefined;
    };

    const getReceiverAnnotationText = (varName, atNode) => {
        if (atNode && patternShadowsAt(atNode, varName)) return undefined;
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const typeMap = scopeTypes.get(functionStack[i].startLine);
            if (typeMap?.annotationTexts?.has(varName)) {
                return typeMap.annotationTexts.get(varName);
            }
            if (typeMap?.boundNames?.has(varName)) return undefined;
        }
        return undefined;
    };

    const matchBindingType = (value, atNode) => {
        if (value?.type !== 'match_expression') return null;
        const source = value.childForFieldName('value');
        if (source?.type !== 'identifier') return null;
        const sourceType = getReceiverAnnotationText(source.text, atNode);
        if (!sourceType) return null;
        const body = value.childForFieldName('body');
        if (!body) return null;
        let variant = null;
        let binding = null;
        for (let i = 0; i < body.namedChildCount; i++) {
            const arm = body.namedChild(i);
            if (arm.type !== 'match_arm') continue;
            const armValue = arm.childForFieldName('value');
            if (['return_expression', 'break_expression', 'continue_expression']
                .includes(armValue?.type)) {
                continue;
            }
            if (armValue?.type !== 'identifier') return null;
            const pattern = arm.childForFieldName('pattern');
            const tuples = [];
            const pending = pattern ? [pattern] : [];
            while (pending.length > 0) {
                const current = pending.pop();
                if (current.type === 'tuple_struct_pattern') tuples.push(current);
                for (let j = 0; j < current.namedChildCount; j++) {
                    pending.push(current.namedChild(j));
                }
            }
            const tuple = tuples.find(candidate =>
                candidate.namedChildren.some(child =>
                    child.type === 'identifier' && child.text === armValue.text));
            const typeNode = tuple?.childForFieldName('type');
            if (!tuple || !typeNode) return null;
            const parts = typeNode.text.split('::').filter(Boolean);
            const currentVariant = parts.pop();
            if (!currentVariant || (variant && variant !== currentVariant) ||
                (binding && binding !== armValue.text)) {
                return null;
            }
            variant = currentVariant;
            binding = armValue.text;
        }
        if (!variant || !binding) return null;
        const wrapper = sourceType.trim().match(
            /^(?:[A-Za-z_][A-Za-z0-9_]*\s*::\s*)*(Option|Result)\s*<(.*)>$/s);
        if (!wrapper) return null;
        const args = wrapper[2].split(',');
        const raw = args[variant === 'Err' ? 1 : 0]?.trim();
        if (!raw || [...'<>()[]'].some(character => raw.includes(character))) {
            return null;
        }
        const match = raw.match(/^(?:(.*)::)?([A-Za-z_][A-Za-z0-9_]*)$/);
        if (!match) return null;
        return {
            type: match[2],
            ...(match[1] && { qualifier: match[1] }),
        };
    };

    const copiedBindingType = (value, assignment, retainedName = null) => {
        let expression = value;
        while (expression && ['reference_expression', 'parenthesized_expression'].includes(expression.type)) {
            expression = expression.childForFieldName('value') || expression.namedChildren.at(-1);
        }
        const dereferenced = !retainedName && expression?.type === 'unary_expression' && expression.child(0)?.text === '*';
        if (dereferenced) expression = expression.namedChild(0);
        const name = retainedName || (expression?.type === 'identifier' ? expression.text : null);
        if (!name) return null;
        const type = getReceiverType(name, assignment);
        const facts = type && getReceiverType(name, assignment, true);
        if (!facts?.receiverTypeEvidence || ['unknown', 'guess'].includes(facts.receiverTypeSource)) return null;
        const annotation = dereferenced && getReceiverAnnotationText(name, assignment);
        // Deref on a custom owner can change the type. Only an actual
        // reference annotation proves the built-in `&*reference` reborrow.
        if (dereferenced && (facts.receiverTypeSource !== 'annotation' || !annotation?.trim().startsWith('&'))) return null;
        const qualifier = getReceiverTypeQualifier(name, assignment);
        return { type, ...(qualifier && { qualifier }), aliasBinding: {
            variable: name, target: assignment.childForFieldName(
                assignment.type === 'let_declaration' ? 'pattern' : 'left')?.text,
            type, origin: facts.receiverTypeEvidence,
            assignment: typeOrigin('flow', assignment),
            ...(dereferenced && { referenceAnnotation: annotation }),
            kind: retainedName ? 'reassignment' : value.type === 'identifier' ? 'copy' : 'borrow',
        } };
    };

    const closureContractSource = (node) => {
        if (node.type !== 'closure_expression') return null;
        const argumentsNode = node.parent;
        const outerCall = argumentsNode?.type === 'arguments'
            ? argumentsNode.parent : null;
        if (outerCall?.type !== 'call_expression') return null;
        let argumentIndex = 0;
        let found = false;
        for (let i = 0; i < argumentsNode.namedChildCount; i++) {
            const argument = argumentsNode.namedChild(i);
            if (argument.type.endsWith('comment')) continue;
            if (argument.id === node.id) {
                found = true;
                break;
            }
            argumentIndex++;
        }
        if (!found) return null;
        let functionNode = outerCall.childForFieldName('function');
        if (functionNode?.type === 'generic_function') {
            functionNode = functionNode.childForFieldName('function') || functionNode;
        }
        let callName;
        let callIsMethod = false;
        if (functionNode?.type === 'field_expression') {
            callName = functionNode.childForFieldName('field')?.text;
            callIsMethod = true;
        } else if (functionNode?.type === 'identifier') {
            callName = functionNode.text;
        } else if (functionNode?.type === 'scoped_identifier') {
            callName = functionNode.childForFieldName('name')?.text;
            callIsMethod = true;
        }
        if (!callName) return null;
        const parameters = node.childForFieldName('parameters');
        const parameterNames = [];
        let parametersComplete = true;
        if (parameters) {
            // Positions are the callback's argument slots (fix #368): the
            // wildcard `_` is an anonymous token but still occupies a slot,
            // so `|_, ctx|` binds ctx to slot 1, not slot 0. Unbound slots
            // are recorded as null.
            for (let i = 0; i < parameters.childCount; i++) {
                const parameter = parameters.child(i);
                if (parameter.type === '|' || parameter.type === ',' ||
                    parameter.type.endsWith('comment')) continue;
                if (!parameter.isNamed) {
                    if (parameter.type === '_') {
                        parameterNames.push(null);
                        continue;
                    }
                    parametersComplete = false;
                    break;
                }
                if (parameter.type === 'identifier') {
                    parameterNames.push(parameter.text);
                    continue;
                }
                if (parameter.type === 'parameter') {
                    const pattern = parameter.childForFieldName('pattern');
                    if (pattern?.type === 'identifier') {
                        parameterNames.push(pattern.text);
                        continue;
                    }
                }
                // `|ref a, ref b|` and `|mut value|` bind the same callback
                // parameter as their identifier child. Destructuring patterns
                // intentionally abstain: a tuple member is not the callback's
                // whole declared type.
                if (['ref_pattern', 'mut_pattern', 'reference_pattern']
                    .includes(parameter.type)) {
                    const identifiers = [];
                    const pending = [parameter];
                    while (pending.length > 0) {
                        const current = pending.pop();
                        if (current.type === 'identifier') {
                            identifiers.push(current.text);
                            continue;
                        }
                        for (let j = 0; j < current.namedChildCount; j++) {
                            pending.push(current.namedChild(j));
                        }
                    }
                    if (identifiers.length === 1) {
                        parameterNames.push(identifiers[0]);
                        continue;
                    }
                }
                parametersComplete = false;
                break;
            }
        }
        if (!parametersComplete || !parameterNames.some(Boolean)) return null;
        return {
            closureSourceCall: callName,
            closureSourceCallStart: outerCall.startIndex,
            closureSourceCallEnd: outerCall.endIndex,
            closureSourceCallIsMethod: callIsMethod,
            closureArgumentIndex: argumentIndex,
            closureParameterNames: parameterNames,
        };
    };

    // Item bodies of item-position macros (`quickcheck! { fn p(..) { .. } }`,
    // fix #401) are parsed as items: their calls are read from that parse,
    // with their functions' scopes and local types, instead of as tokens.
    const itemRecovery = rustMacroItemCallRecovery(code, parser);
    const recoveredTokenTrees = new Set((itemRecovery?.ranges || []).map(([start]) => start - 1));

    const visitNode = (node) => {
        if (BINDING_HOLDERS.has(node.type)) {
            const pattern = node.type === 'closure_parameters' ? node : node.childForFieldName('pattern');
            if (pattern) {
                for (const word of pattern.text.split(/[^A-Za-z0-9_]+/)) {
                    if (word) bindingWords.add(word);
                }
            }
        }
        // Track function entry
        if (isFunctionNode(node)) {
            const entry = {
                name: extractFunctionName(node),
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                ...closureContractSource(node),
            };
            functionStack.push(entry);
            scopeTypes.set(entry.startLine, buildScopeTypeMap(node));
            scopeFlowEvents.set(entry.startLine, new Map());
        }

        // Record binding state before visiting the initializer's children;
        // `at=node.endIndex` means the new binding takes effect only after
        // the RHS, matching Rust's shadowing semantics.
        if (functionStack.length > 0 &&
            (node.type === 'let_declaration' || node.type === 'assignment_expression')) {
            const pattern = node.type === 'let_declaration'
                ? node.childForFieldName('pattern') : node.childForFieldName('left');
            const value = node.type === 'let_declaration'
                ? node.childForFieldName('value') : node.childForFieldName('right');
            if (pattern?.type === 'identifier' && value) {
                const scopeKey = functionStack[functionStack.length - 1].startLine;
                const byName = scopeFlowEvents.get(scopeKey);
                if (byName) {
                    if (!byName.has(pattern.text)) byName.set(pattern.text, []);
                    let until = functionStack[functionStack.length - 1].endIndex ?? Infinity;
                    if (node.type === 'let_declaration') {
                        for (let p = node.parent; p; p = p.parent) {
                            if (p.type === 'block') { until = p.endIndex; break; }
                            if (isFunctionNode(p)) break;
                        }
                    }
                    byName.get(pattern.text).push({
                        at: node.endIndex,
                        until,
                        // A `let` shadows every earlier binding of the name
                        // (fix #401); only a type this statement sets survives.
                        ...(node.type === 'let_declaration' && { letStart: node.startIndex }),
                        ...(() => {
                            // Rust assignment preserves a variable's static
                            // type; a fresh `let` may shadow it with another.
                            const inferred = copiedBindingType(value, node,
                                node.type === 'assignment_expression' ? pattern.text : null) ||
                                matchBindingType(value, node);
                            return inferred
                                ? { invalidated: false, ...inferred }
                                : { invalidated: !valueHasFlowProducer(value) };
                        })(),
                    });
                }
            }
        }

        // Handle function calls: foo(), obj.method(), Type::func(), foo::<T>()
        if (node.type === 'call_expression') {
            let funcNode = node.childForFieldName('function');
            if (!funcNode) return true;

            // Unwrap turbofish: parse::<i32>() has generic_function wrapping the actual function
            const collectResult = extractCollectResultContract(funcNode);
            if (funcNode.type === 'generic_function') {
                funcNode = funcNode.childForFieldName('function') || funcNode;
            }

            const enclosingFunction = getCurrentEnclosingFunction();
            // Where the value goes (fix #371/#372): audit-async reads only
            // records whose value can be lost or used as a resolved value.
            const { valueConsumed: consumedValue, consumingMethod } = rustValueFacts(node);

            // Assignment target for return-type flow (fix #207): let args =
            // parse_low_raw(...)? lets findCallers type args from the
            // producer's declared return type at query time.
            const assigned = rustAssignmentTargetOf(node);

            // Call-site arg count for arity pruning (no spread syntax in Rust;
            // UFCS `Type::method(&x, ...)` counts the explicit self — the
            // pruning range accounts for the shift).
            const argsNode = node.childForFieldName('arguments');
            const argNodes = [];
            if (argsNode) {
                for (let i = 0; i < argsNode.namedChildCount; i++) {
                    const arg = argsNode.namedChild(i);
                    if (arg.type.endsWith('comment')) continue;
                    argNodes.push(arg);
                }
            }
            const argCount = argNodes.length;

            if (funcNode.type === 'identifier') {
                // Direct call: foo()
                const firstArg = getFirstStringArg(node);
                calls.push({
                    name: funcNode.text,
                    line: node.startPosition.row + 1,
                    callStart: node.startIndex,
                    callEnd: node.endIndex,
                    ...(consumedValue && { valueConsumed: consumedValue }),
                    ...(consumingMethod && { consumingMethod }),
                    isMethod: false,
                    argCount,
                    ...(assigned && { assignedTo: assigned.assignedTo }),
                    ...(assigned?.unwrapped && { assignedUnwrap: true }),
                    ...(assigned?.tuple && { assignedTuple: true }),
                    ...(assigned?.tupleRest && { assignedTupleRest: assigned.tupleRest }),
                    ...(assigned?.tupleTargets && { assignedTupleTargets: assigned.tupleTargets }),
                    enclosingFunction,
                    ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp }),
                    ...(mayBeLocallyBound(funcNode.text) &&
                        rustBareNameShadowedByLocal(node, funcNode.text) && { localShadow: true }),
                });
            } else if (funcNode.type === 'field_expression') {
                // Method call: obj.method()
                const fieldNode = funcNode.childForFieldName('field');
                let valueNode = funcNode.childForFieldName('value');
                // fix #381: `c.load()` after `let c = &self.config;`
                // receives like `self.config.load()`.
                if (valueNode?.type === 'identifier' && !getReceiverType(valueNode.text, node)) {
                    const aliased = rustFieldAliasOf(valueNode);
                    if (aliased) valueNode = aliased;
                }

                if (fieldNode) {
                    let receiver = (valueNode?.type === 'identifier' || valueNode?.type === 'self') ? valueNode.text : undefined;
                    // A range index preserves the receiver's collection/slice
                    // type (`doc[start..].find(...)` still dispatches on
                    // `str`). A single-element index does NOT: `items[i]`
                    // dispatches on the element type, so only the
                    // range-expression shape may reuse the root binding.
                    if (!receiver && valueNode?.type === 'index_expression' &&
                        valueNode.namedChild(1)?.type === 'range_expression') {
                        const indexed = valueNode.namedChild(0);
                        if (indexed?.type === 'identifier' || indexed?.type === 'self') {
                            receiver = indexed.text;
                        }
                    }
                    // Detect chained Router::new()-rooted method calls. axum's canonical
                    // idiom is `Router::new().route("/p", get(h)).route(...)` where the
                    // receiver of `.route(...)` is itself a call_expression. Walk the
                    // chain to its root: if the chain originates at Router::new() or
                    // any Router-typed call, set a synthetic receiver string so the
                    // bridge layer can recognize this as a Router method invocation.
                    let receiverIsChainRoot;
                    if (!receiver && valueNode?.type === 'call_expression') {
                        const rootType = _findRustChainRootType(valueNode);
                        if (rootType) {
                            // Synthetic marker — ROUTER_CHAIN:<RootTypeName>. The
                            // <RootTypeName> portion lets the bridge match
                            // /^router/i case-insensitively. receiverIsChainRoot
                            // tells caller physics this is NOT an identifier in
                            // the code (fix #258) — the chain fold types it from
                            // the producer link instead.
                            receiver = rootType;
                            receiverIsChainRoot = true;
                        }
                    }
                    // fix #202: one-hop declared-field receivers — self.dent.path(),
                    // low.sep.into_bytes() — with .clone() transparency (clone()
                    // returns Self by stdlib convention). receiverRoot/Field/RootType
                    // let findCallers hop to the field's declared type cross-file.
                    let receiverRoot, receiverField, receiverFields, receiverRootType;
                    let receiverFieldCallRoot;
                    let receiverViaClone = false;
                    if (!receiver) {
                        let obj = valueNode;
                        while (obj?.type === 'call_expression') {
                            const innerFn = obj.childForFieldName('function');
                            if (innerFn?.type === 'field_expression' &&
                                innerFn.childForFieldName('field')?.text === 'clone') {
                                obj = innerFn.childForFieldName('value');
                            } else break;
                        }
                        if (obj?.type === 'field_expression') {
                            const fields = [];
                            let rootNode = obj;
                            while (rootNode?.type === 'field_expression') {
                                const fldNode = rootNode.childForFieldName('field');
                                if (!fldNode || ![
                                    'field_identifier', 'integer_literal',
                                ].includes(fldNode.type)) {
                                    fields.length = 0;
                                    break;
                                }
                                fields.unshift(fldNode.text);
                                rootNode = rootNode.childForFieldName('value');
                            }
                            if (fields.length > 0 && rootNode &&
                                (rootNode.type === 'identifier' || rootNode.type === 'self')) {
                                receiverRoot = rootNode.text;
                                receiverFields = fields;
                                receiverField = fields[fields.length - 1];
                                receiverRootType = rootNode.type === 'self'
                                    ? findEnclosingImplType(node)
                                    : getReceiverType(rootNode.text, node);
                            } else if (fields.length > 0 &&
                                rootNode?.type === 'call_expression') {
                                receiverFields = fields;
                                receiverField = fields[fields.length - 1];
                                receiverFieldCallRoot = rootNode;
                            }
                        } else if (obj && obj !== valueNode &&
                            (obj.type === 'identifier' || obj.type === 'self')) {
                            // x.clone().m() — the receiver is effectively x
                            receiver = obj.text;
                            receiverViaClone = true;
                        }
                    } else if (valueNode?.type === 'identifier' && !getReceiverType(receiver, node)) {
                        // fix #392: a local destructured from `self`
                        // (`let Self { iter, .. } = self;`) holds that field's
                        // value: the receiver is the field, like `self.iter`.
                        const field = rustSelfFieldBinding(valueNode);
                        if (field) {
                            receiverRoot = 'self';
                            receiverFields = [field];
                            receiverField = field;
                            receiverRootType = findEnclosingImplType(node);
                            receiver = undefined;
                        }
                    }
                    // Chained receiver (fix #220): the receiver IS a call —
                    // self.as_u8().as_color() — record the producer so
                    // findCallers can type it from the declared return.
                    // Fix #258 (clap-measured): receiverCallLine links to the
                    // producer's OWN record (per-record line convention:
                    // field identifier for method producers, call-node start
                    // for plain/path producers) so the chain fold can walk
                    // Command::new("x").a(...).b(...) hop by hop; path
                    // producers (Config::load().x()) are captured now, and
                    // rooted chains keep their synthetic receiver marker for
                    // the bridge but get the link too.
                    let receiverCall, receiverCallIsMethod, receiverCallLine;
                    let receiverCallStart, receiverCallEnd;
                    if ((!receiver || receiverIsChainRoot) && !receiverField &&
                        valueNode?.type === 'call_expression') {
                        let prodFunc = valueNode.childForFieldName('function');
                        if (prodFunc?.type === 'generic_function') {
                            prodFunc = prodFunc.childForFieldName('function') || prodFunc;
                        }
                        if (prodFunc?.type === 'identifier') {
                            receiverCall = prodFunc.text;
                            receiverCallLine = valueNode.startPosition.row + 1;
                            receiverCallStart = valueNode.startIndex;
                            receiverCallEnd = valueNode.endIndex;
                        } else if (prodFunc?.type === 'field_expression') {
                            const pf = prodFunc.childForFieldName('field');
                            if (pf) {
                                receiverCall = pf.text;
                                receiverCallIsMethod = true;
                                receiverCallLine = pf.startPosition.row + 1;
                                receiverCallStart = valueNode.startIndex;
                                receiverCallEnd = valueNode.endIndex;
                            }
                        } else if (prodFunc?.type === 'scoped_identifier') {
                            // Path producer: Command::new(...).arg(...) — the
                            // producer record's name is the last path segment
                            // (turbofish segments dropped, matching the path
                            // record's own derivation) at the call node's line.
                            const segs = prodFunc.text.split('::');
                            const prodName = segs[segs.length - 1];
                            if (prodName && !prodName.startsWith('<')) {
                                receiverCall = prodName;
                                receiverCallIsMethod = true;
                                receiverCallLine = valueNode.startPosition.row + 1;
                                receiverCallStart = valueNode.startIndex;
                                receiverCallEnd = valueNode.endIndex;
                            }
                        }
                    } else if ((!receiver || receiverIsChainRoot) && !receiverField &&
                        valueNode?.type === 'macro_invocation') {
                        const macro = rustMacroCallIdentity(
                            valueNode.childForFieldName('macro'));
                        if (macro) {
                            receiverCall = macro.name;
                            receiverCallLine = valueNode.startPosition.row + 1;
                            receiverCallStart = valueNode.startIndex;
                            receiverCallEnd = valueNode.endIndex;
                        }
                    }
                    if (!receiverCall && receiverFieldCallRoot) {
                        let prodFunc = receiverFieldCallRoot.childForFieldName('function');
                        if (prodFunc?.type === 'generic_function') {
                            prodFunc = prodFunc.childForFieldName('function') || prodFunc;
                        }
                        if (prodFunc?.type === 'identifier') {
                            receiverCall = prodFunc.text;
                        } else if (prodFunc?.type === 'field_expression') {
                            receiverCall = prodFunc.childForFieldName('field')?.text;
                            receiverCallIsMethod = !!receiverCall;
                        } else if (prodFunc?.type === 'scoped_identifier') {
                            const segments = prodFunc.text.split('::');
                            receiverCall = segments[segments.length - 1];
                            receiverCallIsMethod = !!receiverCall;
                        }
                        if (receiverCall) {
                            receiverCallLine = receiverFieldCallRoot.startPosition.row + 1;
                            receiverCallStart = receiverFieldCallRoot.startIndex;
                            receiverCallEnd = receiverFieldCallRoot.endIndex;
                        }
                    }
                    // Literal receivers carry their builtin type (fix #220,
                    // ripgrep-measured): "match:fg:magenta".parse() is
                    // str::parse, never a project method. Numeric literals
                    // stay untyped (i32/u64/f64 ambiguity).
                    // An array literal (fix #401) is the primitive array
                    // type 'array': it unsizes to a slice, never derefs.
                    const rangeReceiverType = (!receiver && valueNode)
                        ? (rustRangeLiteralType(valueNode) ||
                            (valueNode.type === 'tuple_expression' ? 'tuple' : null) ||
                            (valueNode.type === 'array_expression' ? 'array' : null)) : null;
                    // A cast receiver (fix #399): `(p as *const T).m()` has
                    // exactly the cast's type (a primitive or raw pointer).
                    let castNode = !receiver ? valueNode : null;
                    while (castNode?.type === 'parenthesized_expression') castNode = castNode.namedChild(0);
                    const castTypeNode = castNode?.type === 'type_cast_expression'
                        ? castNode.childForFieldName('type') : null;
                    const castReceiverType = castTypeNode
                        ? (rustRawPointerTypeOf(castTypeNode) ||
                            (castTypeNode.type === 'primitive_type' ? castTypeNode.text : null))
                        : null;
                    const literalReceiverType = (!receiver && valueNode)
                        ? (({ string_literal: 'str', raw_string_literal: 'str',
                            char_literal: 'char', boolean_literal: 'bool' })[valueNode.type] ||
                            rangeReceiverType || castReceiverType || undefined)
                        : undefined;
                    // Element receiver (fix #359): `items[i].m()` on a
                    // declared std container dispatches on its element.
                    const indexRoot = !receiver && isElementIndex(valueNode)
                        ? valueNode.namedChild(0) : null;
                    const indexElement = indexRoot?.type === 'identifier'
                        ? getReceiverIndexElement(indexRoot.text, node) : undefined;
                    const receiverType = (receiver && receiver !== 'self' && !receiverIsChainRoot)
                        ? getReceiverType(receiver, node)
                        : (literalReceiverType || indexElement?.type);
                    const receiverTypeQualifier = receiver && receiverType
                        ? getReceiverTypeQualifier(receiver, node)
                        : indexElement?.qualifier;
                    const receiverIteratorItemType = receiver
                        ? getReceiverIteratorItemType(receiver, node)
                        : undefined;
                    const receiverPatternShadow = !!(receiver && patternShadowsAt(node, receiver));
                    const receiverValuePath = !receiverType && !receiverIsChainRoot && !receiverField &&
                        (!receiver || receiver === valueNode?.text) && receiver !== 'self'
                        ? rustReceiverValuePath(valueNode) : null;
                    const receiverPatternBinding = rustPatternBindingOf(node, receiver);
                    if (receiverPatternBinding?.receiverPatternSourceVariable) {
                        const sourceType = getReceiverAnnotationText(
                            receiverPatternBinding.receiverPatternSourceVariable, node);
                        if (sourceType) {
                            receiverPatternBinding.receiverPatternSourceType = sourceType;
                        }
                    }
                    const receiverFlowInvalidated = !!(receiver && flowInvalidatedAt(node, receiver));
                    const iterationSource = rustIterationSourceOf(node, receiver);
                    const firstArg = getFirstStringArg(node);
                    // fix #383: axum `.route(path, get(h).post(h2))` - the
                    // methods and handlers its method router serves.
                    const methodRouter = fieldNode.text === 'route' || fieldNode.text === 'route_service'
                        ? rustMethodRouterOf(node, fieldNode.text) : null;
                    // fix #366: actix `.service(handler)` - the registered
                    // handler function's name (route prefixes compose from the
                    // `web::scope("/api")` chain it is registered on).
                    let serviceArg = null;
                    if (fieldNode.text === 'service') {
                        const a = node.childForFieldName('arguments');
                        const first = a && a.namedChildCount === 1 ? a.namedChild(0) : null;
                        if (first && first.type === 'identifier') serviceArg = first.text;
                    }
                    // RUST-2: For chained calls like `a().b().parse::<T>().ok()`,
                    // each method should report the line where its OWN identifier
                    // appears, not the line where the outer expression begins.
                    // Tree-sitter gives us fieldNode (the identifier) — use its
                    // startPosition.row instead of the wrapping call_expression's.
                    calls.push({
                        name: fieldNode.text,
                        line: fieldNode.startPosition.row + 1,
                        callStart: node.startIndex,
                        callEnd: node.endIndex,
                        ...(consumedValue && { valueConsumed: consumedValue }),
                        ...(consumingMethod && { consumingMethod }),
                        isMethod: true,
                        receiver,
                        ...(receiverType && { receiverType, ...(getReceiverType(receiver, node, true) ||
                            (indexElement ? { receiverTypeSource: 'annotation',
                                receiverTypeEvidence: typeOrigin('annotation', valueNode) } : null) ||
                            (rangeReceiverType && receiverType === rangeReceiverType
                                ? { receiverTypeSource: 'literal',
                                    receiverTypeEvidence: typeOrigin('literal', valueNode),
                                    receiverTypeStd: true } : null) ||
                            (castReceiverType && receiverType === castReceiverType
                                ? { receiverTypeSource: 'annotation',
                                    receiverTypeEvidence: typeOrigin('annotation', castTypeNode),
                                    receiverTypeStd: true } : null) ||
                            { receiverTypeSource: 'unknown' }) }),
                        ...(receiverTypeQualifier && { receiverTypeQualifier }),
                        ...(receiverType && (() => {
                            // `x.clone()` and range literals are owned values.
                            const kind = receiverViaClone || (rangeReceiverType && receiverType === rangeReceiverType) ||
                                (castReceiverType && receiverType === castReceiverType)
                                ? 'owned'
                                : (receiver && receiver !== 'self' ? getReceiverRefKind(receiver, node) : undefined);
                            return kind ? { receiverTypeRef: kind } : {};
                        })()),
                        ...(receiverIteratorItemType && { receiverIteratorItemType }),
                        ...(receiverPatternShadow && { receiverPatternShadow: true }),
                        // A path value receiver: `HAlign::Center.get_offset(..)`
                        // (unit variant or associated const, fix #369), a unit
                        // struct `S.plain()` or struct expression, directly or
                        // through a once-bound local (fix #389); query time
                        // decides what the path names.
                        ...(receiverValuePath && { receiverValuePath: receiverValuePath.path,
                            ...(receiverValuePath.kind !== 'value' && { receiverValueKind: receiverValuePath.kind }) }),
                        ...(receiverPatternBinding || {}),
                        ...(receiverFlowInvalidated && { receiverFlowInvalidated: true }),
                        ...(iterationSource || {}),
                        ...(receiverIsChainRoot && { receiverIsChainRoot: true }),
                        ...(receiverField && { receiverRoot, receiverField }),
                        ...(receiverFields?.length > 1 && { receiverFields }),
                        ...(receiverField && receiverRootType && { receiverRootType }),
                        ...(receiverCall && { receiverCall }),
                        ...(receiverCallIsMethod && { receiverCallIsMethod: true }),
                        ...(valueNode?.type === 'macro_invocation' && receiverCall && {
                            receiverCallIsMacro: true,
                        }),
                        ...(receiverCallLine && { receiverCallLine }),
                        ...(receiverCallStart != null && { receiverCallStart }),
                        ...(receiverCallEnd != null && { receiverCallEnd }),
                        argCount,
                        ...(() => {
                            const argTypes = rustArgTypesOfNode(argNodes, astArgTypeOfName);
                            return argTypes ? { argTypes } : {};
                        })(),
                        ...(assigned && { assignedTo: assigned.assignedTo }),
                        ...(assigned?.unwrapped && { assignedUnwrap: true }),
                        ...(assigned?.tuple && { assignedTuple: true }),
                        ...(assigned?.tupleRest && { assignedTupleRest: assigned.tupleRest }),
                    ...(assigned?.tupleTargets && { assignedTupleTargets: assigned.tupleTargets }),
                        ...(collectResult && {
                            explicitResultType: collectResult.type,
                            explicitResultItemType: collectResult.itemType,
                        }),
                        enclosingFunction,
                        ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp }),
                        ...(serviceArg && { serviceArg }),
                        ...(methodRouter && { methodRouter })
                    });
                }
            } else if (funcNode.type === 'scoped_identifier') {
                // Path call: Type::func() or module::func()
                // Get the last segment of the path
                const pathText = funcNode.text;
                const segments = pathText.split('::');
                const name = segments[segments.length - 1];
                const firstArg = getFirstStringArg(node);
                // Turbofish receivers (`Vec::<String>::new`) carry the type
                // arguments as their own `::`-split segments — drop them so
                // the receiver is the plain type/module path (fix #222).
                const recvSegments = segments.slice(0, -1)
                    .filter(s => !s.startsWith('<') && !s.endsWith('>'));
                calls.push({
                    name: name,
                    line: node.startPosition.row + 1,
                    callStart: node.startIndex,
                    callEnd: node.endIndex,
                    ...(consumedValue && { valueConsumed: consumedValue }),
                    ...(consumingMethod && { consumingMethod }),
                    isMethod: segments.length > 1,
                    isPathCall: true,  // Distinguishes Type::func()/module::func() from obj.method()
                    receiver: recvSegments.length > 0 ? recvSegments.join('::') : undefined,
                    argCount,
                    ...(segments.length > 1 && (() => {
                        const argTypes = rustArgTypesOfNode(argNodes, astArgTypeOfName);
                        return argTypes ? { argTypes } : {};
                    })()),
                    ...(assigned && { assignedTo: assigned.assignedTo }),
                    ...(assigned?.unwrapped && { assignedUnwrap: true }),
                    ...(assigned?.tuple && { assignedTuple: true }),
                    ...(assigned?.tupleRest && { assignedTupleRest: assigned.tupleRest }),
                    ...(assigned?.tupleTargets && { assignedTupleTargets: assigned.tupleTargets }),
                    enclosingFunction,
                    ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp }),
                    ...(rustFunctionReturnPosition(node) && { returnPosition: true }),
                });
            }
            return true;
        }

        // R3-NEW-3: Detect Rust struct expressions as constructor calls.
        //   Foo { x: 1 }      → call(name='Foo', isConstructor:true)
        //   path::Foo { ... } → call(name='Foo', isConstructor:true) — strip path
        //   Foo::Variant { } (enum struct variant) → name=Variant, receiver=Foo
        //
        // Detection happens as a separate AST node visit, so it doesn't conflict
        // with existing call/method handlers.
        if (node.type === 'struct_expression') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                let typeName = null;
                let pathQualifier = null;
                if (nameNode.type === 'type_identifier') {
                    typeName = nameNode.text;
                } else if (nameNode.type === 'scoped_type_identifier') {
                    // path::Foo or Enum::Variant — emit as the rightmost name,
                    // keeping the qualifier as receiver (fix #206): a
                    // path-qualified type must not resolve to a same-file
                    // binding of an unrelated same-name symbol.
                    const innerNameNode = nameNode.childForFieldName('name');
                    if (innerNameNode) {
                        typeName = innerNameNode.text;
                        const pathNode = nameNode.childForFieldName('path');
                        if (pathNode) {
                            const segs = pathNode.text.split('::');
                            pathQualifier = segs[segs.length - 1] || null;
                        }
                    } else {
                        // Fallback: split by ::
                        const parts = nameNode.text.split('::');
                        typeName = parts[parts.length - 1];
                        if (parts.length > 1) pathQualifier = parts[parts.length - 2] || null;
                    }
                }
                // `Self { ... }` is a constructor for the enclosing impl
                // target, not a project type literally named Self. Preserve
                // the concrete identity in the call record so callers and
                // callees can reconcile it with the struct symbol.
                if (typeName === 'Self') {
                    typeName = findEnclosingImplType(node) || typeName;
                }
                if (typeName) {
                    const enclosingFunction = getCurrentEnclosingFunction();
                    calls.push({
                        name: typeName,
                        line: node.startPosition.row + 1,
                        isMethod: false,
                        isConstructor: true,
                        ...(pathQualifier && { receiver: pathQualifier }),
                        enclosingFunction
                    });
                }
            }
        }

        // Handle macro invocations: println!(), vec![]
        if (node.type === 'macro_invocation') {
            const macroNode = node.childForFieldName('macro');
            const enclosingFunction = getCurrentEnclosingFunction();
            let macro = null;
            if (macroNode) {
                macro = rustMacroCallIdentity(macroNode);
                const assigned = rustAssignmentTargetOf(node);
                calls.push({
                    name: macro?.name || macroNode.text.replace(/!$/, ''),
                    line: node.startPosition.row + 1,
                    callStart: node.startIndex,
                    callEnd: node.endIndex,
                    isMethod: false,
                    isMacro: true,
                    ...(macro?.receiver && {
                        receiver: macro.receiver,
                        isPathMacro: true,
                    }),
                    ...(assigned && { assignedTo: assigned.assignedTo }),
                    ...(assigned?.unwrapped && { assignedUnwrap: true }),
                    ...(assigned?.tuple && { assignedTuple: true }),
                    ...(assigned?.tupleRest && { assignedTupleRest: assigned.tupleRest }),
                    ...(assigned?.tupleTargets && { assignedTupleTargets: assigned.tupleTargets }),
                    // Expression position (fix #375): lets the macro_rules!
                    // expansion pass skip files whose value-forwarding
                    // invocations all sit where no value is taken.
                    ...(rustMacroInvocationContext(node) === 'expr' && { macroExpr: true }),
                    enclosingFunction
                });
            }
            // Calls INSIDE the macro body: tree-sitter parses macro arguments
            // as an unstructured token_tree, which hid every call written
            // inside assert_eq!/format!/vec!/write! (measured: 175 unclaimed
            // call lines on ripgrep — test assertions live in macros).
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child.type === 'token_tree' && !recoveredTokenTrees.has(child.startIndex)) {
                    extractCallsFromTokenTree(
                        child, enclosingFunction, calls, getReceiverType,
                        patternShadowsAt, flowInvalidatedAt, {
                            kind: 'invocation',
                            containerMacro: macro?.name,
                            scopeTypesName,
                        });
                }
            }
            return true;
        }

        // Attribute arguments are token trees, but they contain ordinary
        // Rust paths and builder expressions that proc macros resolve at
        // compile time (`#[arg(value_parser = BoolishValueParser::new())]`).
        // Recover those calls with the same AST-token reconstruction used for
        // macro invocation arguments. The attribute name itself is metadata,
        // not a direct call site, so only its argument token tree is scanned.
        if (node.type === 'attribute_item') {
            const attribute = node.namedChildren.find(child => child.type === 'attribute');
            const attributeName = attribute?.namedChildren.find(child =>
                child.type === 'identifier' || child.type === 'scoped_identifier')?.text;
            const enclosingFunction = getCurrentEnclosingFunction();
            for (const child of attribute?.namedChildren || []) {
                if (child.type !== 'token_tree') continue;
                extractCallsFromTokenTree(
                    child, enclosingFunction, calls, getReceiverType,
                    patternShadowsAt, flowInvalidatedAt, {
                        kind: 'attribute',
                        containerMacro: attributeName,
                        scopeTypesName,
                    });
            }
            return true;
        }

        // macro_rules! definitions: the transcriber token_tree holds concrete
        // call templates (write!(stderr, $($tt)*) in messages.rs) — real call
        // sites in every expansion. The matcher (token_tree_pattern) holds
        // fragment specifiers, never calls — skipped.
        if (node.type === 'macro_definition') {
            const enclosingFunction = getCurrentEnclosingFunction();
            for (let i = 0; i < node.namedChildCount; i++) {
                const rule = node.namedChild(i);
                if (rule.type !== 'macro_rule') continue;
                for (let j = 0; j < rule.childCount; j++) {
                    const part = rule.child(j);
                    if (part.type === 'token_tree') {
                        extractCallsFromTokenTree(
                            part, enclosingFunction, calls, getReceiverType,
                            patternShadowsAt, flowInvalidatedAt, 'definition');
                    }
                }
            }
            return true;
        }

        // Detect function/method references passed as arguments:
        // field_expression inside arguments (obj.method as callback)
        if (node.type === 'field_expression' && node.parent?.type === 'arguments') {
            const grandparent = node.parent?.parent;
            if (!grandparent || grandparent.type !== 'call_expression' || grandparent.childForFieldName('function') !== node) {
                const fieldNode = node.childForFieldName('field');
                const valueNode = node.childForFieldName('value');
                if (fieldNode) {
                    const receiver = (valueNode?.type === 'identifier' || valueNode?.type === 'self') ? valueNode.text : undefined;
                    const receiverType = (receiver && receiver !== 'self') ? getReceiverType(receiver, node) : undefined;
                    const receiverPatternShadow = !!(receiver && patternShadowsAt(node, receiver));
                    const receiverFlowInvalidated = !!(receiver && flowInvalidatedAt(node, receiver));
                    const enclosingFunction = getCurrentEnclosingFunction();
                    // RUST-2: use the field identifier's line, not the wrapping field_expression's
                    calls.push({
                        name: fieldNode.text,
                        line: fieldNode.startPosition.row + 1,
                        isMethod: true,
                        receiver,
                        ...(receiverType && { receiverType, ...(getReceiverType(receiver, node, true) || { receiverTypeSource: 'unknown' }) }),
                        ...(receiverPatternShadow && { receiverPatternShadow: true }),
                        ...(receiverFlowInvalidated && { receiverFlowInvalidated: true }),
                        isFunctionReference: true,
                        isPotentialCallback: true,
                        enclosingFunction
                    });
                }
            }
        }

        // Track local variable types from let declarations
        // Pattern 1: let s = Server { ... } (struct expression)
        // Pattern 2: let s = Server::new() / ::from() / ::default() (scoped constructor)
        // Pattern 3: let s: Server = ... (explicit type annotation)
        if (node.type === 'let_declaration' && functionStack.length > 0) {
            const patternNode = node.childForFieldName('pattern');
            const valueNode = node.childForFieldName('value');
            const typeAnnotation = node.childForFieldName('type');
            if (patternNode && patternNode.type !== 'identifier') {
                // A destructuring `let` shadows every name it binds; their
                // earlier declared reference layers no longer apply.
                const refKinds = scopeTypes.get(functionStack[functionStack.length - 1].startLine)?.refKinds;
                if (refKinds) {
                    const pending = [patternNode];
                    while (pending.length > 0) {
                        const current = pending.pop();
                        if (current.type === 'identifier') refKinds.delete(current.text);
                        for (let i = 0; i < current.namedChildCount; i++) pending.push(current.namedChild(i));
                    }
                }
            }
            if (patternNode && patternNode.type === 'identifier') {
                const varName = patternNode.text;
                const scopeKey = functionStack[functionStack.length - 1].startLine;
                const typeMap = scopeTypes.get(scopeKey);
                if (typeMap) {
                    let typeName = null;
                    let typeQualifier = null;
                    let stdLiteral = false;
                    // Std deref wrappers (fix #401): `let a: Arc<Store>`,
                    // `let m = ManuallyDrop::new(self)` receive as the target.
                    let derefVia = null;
                    let derefSource = null;
                    let derefInnerRef = 'owned';
                    let derefOuterRef = 'owned';
                    let derefStd = false;
                    // Pattern 3: explicit type annotation — let s: Server = ...
                    if (typeAnnotation) {
                        const deref = rustDerefTypedName(typeAnnotation);
                        const declared = deref ? deref.inner : typeAnnotation;
                        if (deref) {
                            derefVia = deref.via;
                            derefInnerRef = rustTypeRefKind(declared);
                            derefOuterRef = deref.outerRef;
                            derefStd = !!deref.std;
                        }
                        typeName = deref ? deref.typeName : extractTypeName(declared);
                        if (typeName === 'Self') typeName = findEnclosingImplType(typeAnnotation) || null;
                        if (!typeName && !deref && (rustSliceTypeOf(declared) || rustRawPointerTypeOf(declared))) {
                            typeName = rustSliceTypeOf(declared) || rustRawPointerTypeOf(declared);
                            stdLiteral = true;
                        }
                        typeQualifier = extractTypeQualifier(declared);
                        const indexElement = rustIndexElement(declared);
                        if (indexElement) typeMap.indexElements.set(varName, indexElement);
                        else typeMap.indexElements.delete(varName);
                    } else {
                        typeMap.indexElements.delete(varName);
                    }
                    let indexedValue = valueNode;
                    while (indexedValue && (indexedValue.type === 'reference_expression' ||
                        indexedValue.type === 'parenthesized_expression')) {
                        indexedValue = indexedValue.childForFieldName('value') || indexedValue.namedChild(0);
                    }
                    if (!typeName && isElementIndex(indexedValue) &&
                        indexedValue.namedChild(0)?.type === 'identifier') {
                        const element = getReceiverIndexElement(indexedValue.namedChild(0).text, node);
                        if (element) {
                            typeName = element.type;
                            typeQualifier = element.qualifier || null;
                        }
                    }
                    if (!typeName && valueNode && !derefVia) {
                        const rangeType = rustRangeLiteralType(valueNode, true);
                        if (rangeType) {
                            typeName = rangeType;
                            stdLiteral = true;
                        }
                    }
                    if (!typeName && valueNode && !(typeAnnotation && derefVia)) {
                        // Pattern 1: struct expression — let s = Server { ... }
                        if (valueNode.type === 'struct_expression') {
                            const nameNode = valueNode.childForFieldName('name');
                            typeName = nameNode?.text || null;
                            // Strip path prefix: module::Server → Server
                            if (typeName && typeName.includes('::')) {
                                const parts = typeName.split('::');
                                typeQualifier = parts.slice(0, -1).join('::');
                                typeName = parts[parts.length - 1];
                            }
                        }
                        // &Server { ... } (reference to struct expression)
                        else if (valueNode.type === 'reference_expression') {
                            const inner = valueNode.childForFieldName('value');
                            if (inner?.type === 'struct_expression') {
                                const nameNode = inner.childForFieldName('name');
                                typeName = nameNode?.text || null;
                                if (typeName && typeName.includes('::')) {
                                    const parts = typeName.split('::');
                                    typeQualifier = parts.slice(0, -1).join('::');
                                    typeName = parts[parts.length - 1];
                                }
                            }
                        }
                        // Pattern 2: constructor call — let s = Server::new()
                        else if (valueNode.type === 'call_expression') {
                            const funcNode = valueNode.childForFieldName('function');
                            const wrapped = rustStdDerefConstruction(valueNode, node);
                            if (wrapped) {
                                if (wrapped.typeName) {
                                    typeName = wrapped.typeName;
                                    typeQualifier = wrapped.qualifier || null;
                                    derefVia = wrapped.via;
                                    derefSource = wrapped.source;
                                    derefStd = !!wrapped.std;
                                }
                            } else if (funcNode?.type === 'scoped_identifier') {
                                const pathText = funcNode.text;
                                const segments = pathText.split('::');
                                if (segments.length >= 2) {
                                    const methodName = segments[segments.length - 1];
                                    if (/^(new|from|default|with_|create|build|open|connect|init)/.test(methodName)) {
                                        typeName = segments[segments.length - 2];
                                        typeQualifier = segments.slice(0, -2).join('::') || null;
                                        if (!typeName || !/^[A-Z]/.test(typeName)) typeName = null;
                                        // `Self::with_capacity(..)` names the impl's
                                        // self type (fix #401), never a type `Self`.
                                        if (typeName === 'Self' && segments.length === 2) {
                                            typeName = findEnclosingImplType(valueNode) || null;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    typeMap.refKinds.delete(varName);
                    typeMap.stdTypes.delete(varName);
                    if (typeName) {
                        const source = stdLiteral && !typeAnnotation ? 'literal'
                            : typeAnnotation || isElementIndex(indexedValue) ? 'annotation'
                                : derefSource || (valueNode?.type === 'call_expression' ? 'guess' : 'constructor');
                        typeMap.set(varName, typeName, derefVia
                            ? { ...typeOrigin(source, typeAnnotation || valueNode), derefVia, derefOuterRef }
                            : source, typeAnnotation || valueNode);
                        if (typeQualifier) typeMap.qualifiers.set(varName, typeQualifier);
                        if (derefVia) {
                            // The wrapper's target is a place of the inner type.
                            typeMap.refKinds.set(varName, derefInnerRef);
                        } else if (typeAnnotation) {
                            typeMap.refKinds.set(varName, rustTypeRefKind(typeAnnotation));
                        } else if (valueNode?.type === 'struct_expression' || stdLiteral) {
                            typeMap.refKinds.set(varName, 'owned');
                        }
                        if (stdLiteral || derefStd) typeMap.stdTypes.add(varName);
                    }
                }
            }
        }

        return true;
    };
    const leaveNode = (node) => {
        if (isFunctionNode(node)) {
            const leaving = functionStack.pop();
            if (leaving) {
                scopeTypes.delete(leaving.startLine);
                scopeFlowEvents.delete(leaving.startLine);
            }
        }
    };
    traverseTree(tree.rootNode, visitNode, { onLeave: leaveNode });
    if (itemRecovery) {
        const ranges = itemRecovery.ranges;
        const inside = node => ranges.some(([start, end]) => node.startIndex >= start && node.endIndex <= end);
        const overlaps = node => ranges.some(([start, end]) => node.startIndex < end && node.endIndex > start);
        traverseTree(itemRecovery.tree.rootNode, node => {
            if (inside(node)) return visitNode(node);
            return overlaps(node);
        }, { onLeave: node => { if (inside(node)) leaveNode(node); } });
    }

    const declaration = declarationTrees(code, parser);
    if (!declaration.macroItemRecovery) return calls;
    const functions = findFunctions(code, parser);
    return calls
        .filter(call => !(call.inMacro &&
            declaration.macroDeclarationNameStarts.has(call.callStart)))
        .map(call => {
            if (!call.inMacro || call.enclosingFunction) return call;
            const owner = functions
                .filter(fn => fn.startLine <= call.line && fn.endLine >= call.line)
                .sort((left, right) =>
                    (left.endLine - left.startLine) -
                    (right.endLine - right.startLine))[0];
            if (!owner) return call;
            return {
                ...call,
                enclosingFunction: {
                    name: owner.name,
                    startLine: owner.startLine,
                    endLine: owner.endLine,
                },
            };
        });
}

/**
 * Find all imports in Rust code using tree-sitter AST
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{module: string, names: string[], type: string, line: number}>}
 */
function findImportsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const imports = [];

    const joinUsePath = (prefix, suffix) => {
        const left = String(prefix || '').replace(/::$/, '');
        const right = String(suffix || '').replace(/^::/, '');
        return left && right ? `${left}::${right}` : left || right;
    };
    const addLeaf = (module, localName, type = 'use', dynamic = false, line, rename = null) => {
        if (!module || !localName) return;
        imports.push({
            module,
            names: [localName],
            type,
            dynamic,
            line,
            ...(rename && { renames: [rename] }),
        });
    };
    const collectUseTree = (node, prefix, line) => {
        if (!node || node.type === 'visibility_modifier') return;
        if (node.type === 'scoped_use_list') {
            const pathNode = node.childForFieldName('path');
            const listNode = node.childForFieldName('list');
            const nextPrefix = joinUsePath(prefix, pathNode?.text);
            if (listNode) collectUseTree(listNode, nextPrefix, line);
            return;
        }
        if (node.type === 'use_list') {
            for (let i = 0; i < node.namedChildCount; i++) {
                collectUseTree(node.namedChild(i), prefix, line);
            }
            return;
        }
        if (node.type === 'use_as_clause') {
            const pathNode = node.namedChild(0);
            const aliasNode = node.childForFieldName('alias') || node.namedChild(1);
            if (pathNode && aliasNode) {
                // fix #353: `use alpha::widget as renamed; renamed()` — the
                // alias pairing feeds findCallers' import-rename surface
                // (calledAs), exactly like Python/JS `import x as y`.
                // fix #357: `renames` pairs the alias with ITS record so
                // createImportBindings emits {name: original, alias: local}
                // (the #348 Python shape); two renames of one source name
                // from different modules each pair with their own module
                // instead of both bindings matching both calls. `names`
                // keeps the local spelling (parser contract, imports command).
                const original = String(pathNode.text).split('::').pop();
                const renamed = original && original !== aliasNode.text && original !== 'self';
                addLeaf(joinUsePath(prefix, pathNode.text), aliasNode.text,
                    'use', false, line, renamed ? { original, local: aliasNode.text } : null);
                if (renamed) {
                    if (!imports.aliases) imports.aliases = [];
                    imports.aliases.push({ original, local: aliasNode.text });
                }
            }
            return;
        }
        if (node.type === 'use_wildcard') {
            const pathNode = node.namedChild(0);
            addLeaf(joinUsePath(prefix, pathNode?.text), '*',
                'use-glob', true, line);
            return;
        }
        if (node.type === 'identifier' || node.type === 'scoped_identifier' ||
            node.type === 'crate' || node.type === 'self' || node.type === 'super') {
            if (node.text === 'self' && prefix) {
                addLeaf(prefix, prefix.split('::').pop(), 'use', false, line);
                return;
            }
            const module = joinUsePath(prefix, node.text);
            addLeaf(module, node.text.split('::').pop(), 'use', false, line);
        }
    };

    traverseTreeCached(tree.rootNode, (node) => {
        // use declarations
        if (node.type === 'use_declaration') {
            const line = node.startPosition.row + 1;
            // A use declaration has one semantic tree below optional
            // visibility. Recursively flatten every leaf while retaining its
            // full module path. In particular,
            // `use crate::{haystack::{Haystack, Builder}}` becomes the exact
            // bindings `crate::haystack::Haystack` and
            // `crate::haystack::Builder`, rather than the lossy old
            // `{ module: "crate", name: "haystack" }` approximation.
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                collectUseTree(child, '', line);
            }
            return true;
        }

        // `extern crate itertools as it;` binds the crate under a local
        // name exactly like `use itertools as it;` (fix #369). A plain
        // `extern crate x;` adds no name beyond the extern prelude.
        if (node.type === 'extern_crate_declaration') {
            const nameNode = node.childForFieldName('name');
            const aliasNode = node.childForFieldName('alias');
            if (nameNode && aliasNode && aliasNode.text !== nameNode.text) {
                const local = aliasNode.text;
                addLeaf(nameNode.text, local, 'use', false, node.startPosition.row + 1,
                    { original: nameNode.text, local });
                if (!imports.aliases) imports.aliases = [];
                imports.aliases.push({ original: nameNode.text, local });
            }
            return true;
        }

        // mod declarations (external module imports)
        if (node.type === 'mod_item') {
            const line = node.startPosition.row + 1;
            const nameNode = node.childForFieldName('name');

            // Only count mod declarations without body (file-based modules)
            const hasBody = node.namedChildren.some(c => c.type === 'declaration_list');

            if (nameNode && !hasBody) {
                imports.push({
                    module: nameNode.text,
                    names: [nameNode.text],
                    type: 'mod',
                    dynamic: false,
                    line
                });
            }
            return true;
        }

        return true;
    });

    // include! macros with non-literal paths
    traverseTreeCached(tree.rootNode, (node) => {
        if (node.type === 'macro_invocation') {
            const nameNode = node.childForFieldName('macro');
            if (nameNode && /^include(_str|_bytes)?$/.test(nameNode.text)) {
                const argsNode = node.namedChildren.find(c => c.type === 'token_tree');
                const arg = argsNode?.namedChild(0);
                const dynamic = !arg || arg.type !== 'string_literal';
                const modulePath = arg ? arg.text.replace(/^["']|["']$/g, '') : null;
                if (modulePath) {
                    imports.push({
                        module: modulePath,
                        names: [],
                        type: 'include',
                        dynamic,
                        line: node.startPosition.row + 1
                    });
                }
            }
        }
        return true;
    });

    return imports;
}

/**
 * Find all exports in Rust code using tree-sitter AST
 * In Rust, exports are pub items
 * @param {string} code - Source code to analyze
 * @param {object} parser - Tree-sitter parser instance
 * @returns {Array<{name: string, type: string, line: number}>}
 */
function findExportsInCode(code, parser) {
    const { trees } = declarationTrees(code, parser);
    const exports = [];
    const seen = new Set();

    function hasVisibility(node) {
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child.type === 'visibility_modifier') {
                return true;
            }
        }
        return false;
    }

    const append = entry => {
        const key = `${entry.name}\0${entry.type}\0${entry.line}\0${entry.alias || ''}`;
        if (!seen.has(key)) {
            seen.add(key);
            exports.push(entry);
        }
    };

    const collect = tree => traverseTreeCached(tree.rootNode, (node) => {
        // Public renamed re-exports: `pub use foo::bar as baz;` (also nested in
        // use lists: `pub use m::{a as b}`). name keeps the source symbol; alias
        // carries the external name callers use. Plain (un-renamed) `pub use`
        // re-exports are intentionally not emitted here — only renames feed the
        // export-alias caller resolution.
        if (node.type === 'use_declaration' && hasVisibility(node)) {
            const line = node.startPosition.row + 1;
            const collectAsClauses = (n) => {
                if (n.type === 'use_as_clause') {
                    const srcNode = n.namedChild(0);
                    const aliasNode = n.namedChild(1);
                    // Last path segment is the source symbol name (foo::bar -> bar)
                    let local = null;
                    if (srcNode) {
                        if (srcNode.type === 'identifier' || srcNode.type === 'type_identifier') {
                            local = srcNode.text;
                        } else if (srcNode.type === 'scoped_identifier') {
                            const nameField = srcNode.childForFieldName('name');
                            local = nameField ? nameField.text : null;
                        }
                    }
                    if (local && aliasNode && aliasNode.text !== local) {
                        append({
                            name: local, type: 're-export', line,
                            source: srcNode.text, alias: aliasNode.text,
                        });
                    }
                    return;
                }
                for (let i = 0; i < n.namedChildCount; i++) collectAsClauses(n.namedChild(i));
            };
            collectAsClauses(node);
            return true;
        }

        // Public functions
        if (node.type === 'function_item' && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                append({
                    name: nameNode.text,
                    type: 'function',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        // Public structs and unions
        if ((node.type === 'struct_item' || node.type === 'union_item') && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                append({
                    name: nameNode.text,
                    type: node.type === 'union_item' ? 'union' : 'struct',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        // Public enums
        if (node.type === 'enum_item' && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                append({
                    name: nameNode.text,
                    type: 'enum',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        // Public traits
        if (node.type === 'trait_item' && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                append({
                    name: nameNode.text,
                    type: 'trait',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        // Public modules
        if (node.type === 'mod_item' && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                append({
                    name: nameNode.text,
                    type: 'module',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        // Public type aliases
        if (node.type === 'type_item' && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                append({
                    name: nameNode.text,
                    type: 'type',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        // Public const
        if (node.type === 'const_item' && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                append({
                    name: nameNode.text,
                    type: 'const',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        // Public static
        if (node.type === 'static_item' && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                append({
                    name: nameNode.text,
                    type: 'static',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        return true;
    });
    for (const tree of trees) collect(tree);

    return exports;
}

/**
 * Find all usages of a name in code using AST
 * @param {string} code - Source code
 * @param {string} name - Symbol name to find
 * @param {object} parser - Tree-sitter parser instance
 * @param {object} [tree] - Pre-parsed tree (per-operation cache); parsed here when absent
 * @returns {Array<{line: number, column: number, usageType: string}>}
 */
function _indexInParent(node, parent) {
    for (let i = 0; i < parent.childCount; i++) {
        if (sameNode(parent.child(i), node)) return i;
    }
    return -1;
}

function findUsagesInCode(code, name, parser, tree, options = {}) {
    tree = tree || parseTree(parser, code);
    const usages = [];
    // Lexical scope verdicts (fix #392) only for refactoring internals.
    const scopeMemo = options.lexicalScopes ? new Map() : null;
    // Lazy same-file enum→variants map: built only when a paren-less
    // `Type::name` reference needs the enum-variant check.
    let _enumVariants = null;
    const sameFileEnumVariant = (enumName, variantName) => {
        if (_enumVariants === null) {
            _enumVariants = new Map();
            traverseTreeCached(tree.rootNode, (n) => {
                if (n.type !== 'enum_item') return;
                const enName = n.childForFieldName('name')?.text;
                const body = n.childForFieldName('body');
                if (!enName || !body) return;
                let set = _enumVariants.get(enName);
                if (!set) { set = new Set(); _enumVariants.set(enName, set); }
                for (let i = 0; i < body.namedChildCount; i++) {
                    const child = body.namedChild(i);
                    if (child.type === 'enum_variant') {
                        const vn = child.childForFieldName('name')?.text;
                        if (vn) set.add(vn);
                    }
                }
            });
        }
        return _enumVariants.get(enumName)?.has(variantName) || false;
    };

    visitNameNodes(tree, code, name, (node) => {
        // Look for identifier, field_identifier (method names in obj.method() calls),
        // and type_identifier (type references in params, return types, struct expressions, etc.)
        const isIdentifier = node.type === 'identifier' || node.type === 'field_identifier' || node.type === 'type_identifier';
        if (!isIdentifier || node.text !== name) {
            return true;
        }

        const line = node.startPosition.row + 1;
        const column = node.startPosition.column;
        const parent = node.parent;

        let usageType = 'reference';

        if (parent) {
            // Import: use path::name (walk up scoped_identifier chain for deeply nested paths)
            if (parent.type === 'use_declaration' ||
                parent.type === 'use_as_clause' ||
                parent.type === 'use_list' ||
                (parent.type === 'scoped_identifier' && (() => {
                    let p = parent;
                    while (p) {
                        if (p.type === 'use_declaration' || p.type === 'use_as_clause') return true;
                        if (p.type !== 'scoped_identifier' && p.type !== 'scoped_use_list' && p.type !== 'use_list') return false;
                        p = p.parent;
                    }
                    return false;
                })())) {
                usageType = 'import';
            }
            // Call: name()
            else if (parent.type === 'call_expression' &&
                     sameNode(parent.childForFieldName('function'), node)) {
                usageType = 'call';
            }
            // Scoped call: Type::method() — only the LAST segment is the callee;
            // the path qualifier (Type in Type::method()) is a type reference,
            // not a call of Type. The qualifier IS the receiver — without it,
            // --class-name scoping could never match associated-function calls
            // (fix #244: `Kit::make()` invisible to `tests make --class-name Kit`).
            else if (parent.type === 'scoped_identifier') {
                const grandparent = parent.parent;
                const isDirectCall = grandparent && grandparent.type === 'call_expression' &&
                    sameNode(grandparent.childForFieldName('function'), parent);
                // Turbofish on a scoped path: Type::<T>::m() wraps the path in
                // generic_function before the call_expression.
                const isTurbofishCall = grandparent && grandparent.type === 'generic_function' &&
                    grandparent.parent && grandparent.parent.type === 'call_expression' &&
                    sameNode(grandparent.parent.childForFieldName('function'), grandparent);
                if ((isDirectCall || isTurbofishCall) &&
                    sameNode(parent.childForFieldName('name'), node)) {
                    usageType = 'call';
                    const pathNode = parent.childForFieldName('path');
                    if (pathNode) {
                        const segs = pathNode.text.split('::');
                        const receiver = segs[segs.length - 1];
                        if (receiver) {
                            usages.push({ line, column, usageType, receiver });
                            return true;
                        }
                    }
                } else if (sameNode(parent.childForFieldName('name'), node)) {
                    // Associated method value: `Cursive::quit` is a reference
                    // to the method even though no call_expression wraps it.
                    // Preserve its type receiver so the project-aware usage
                    // layer can distinguish it from `Enum::Variant`.
                    const pathNode = parent.childForFieldName('path');
                    if (pathNode) {
                        const segs = pathNode.text.split('::');
                        const receiver = segs[segs.length - 1];
                        // A same-file `enum Receiver { Name }` proves this is
                        // the variant, not an associated item of the queried
                        // symbol — provable without the index, so filtered
                        // here; cross-file receivers stay for the project
                        // layer's owner check.
                        if (receiver && sameFileEnumVariant(receiver, name)) {
                            return true;
                        }
                        if (receiver) {
                            usages.push({
                                line,
                                column,
                                usageType: 'reference',
                                receiver,
                                scopedReference: true,
                            });
                            return true;
                        }
                    }
                }
            }
            // Turbofish call on a bare name: f::<T>() — the identifier's parent
            // is generic_function, the call wraps that (fix #244: classified
            // 'reference', so the account confirmed the edge while the
            // coverage scan reported the function uncovered).
            else if (parent.type === 'generic_function' &&
                     sameNode(parent.childForFieldName('function'), node)) {
                const gp = parent.parent;
                if (gp && gp.type === 'call_expression' &&
                    sameNode(gp.childForFieldName('function'), parent)) {
                    usageType = 'call';
                }
            }
            // Macro invocation: name!
            else if (parent.type === 'macro_invocation') {
                const macroNode = parent.childForFieldName('macro');
                if (sameNode(macroNode, node)) {
                    usageType = 'call';
                }
            }
            // Definition: fn name
            else if (parent.type === 'function_item' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: struct / union name
            else if ((parent.type === 'struct_item' || parent.type === 'union_item') &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: enum name
            else if (parent.type === 'enum_item' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: impl for Type
            else if (parent.type === 'impl_item') {
                usageType = 'definition';
            }
            // Definition: type alias
            else if (parent.type === 'type_item' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: let binding
            else if (parent.type === 'let_declaration' &&
                     parent.childForFieldName('pattern')?.text === name) {
                usageType = 'definition';
            }
            // Definition: const/static
            else if ((parent.type === 'const_item' || parent.type === 'static_item') &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'definition';
            }
            // Definition: parameter name (not the type)
            else if (parent.type === 'parameter' &&
                     sameNode(parent.childForFieldName('pattern'), node)) {
                usageType = 'definition';
            }
            // Struct expression: Type { field: value }
            else if (parent.type === 'struct_expression' &&
                     sameNode(parent.childForFieldName('name'), node)) {
                usageType = 'call';
            }
            // Method call: obj.name()
            else if (parent.type === 'field_expression' &&
                     sameNode(parent.childForFieldName('field'), node)) {
                const grandparent = parent.parent;
                if (grandparent && grandparent.type === 'call_expression') {
                    usageType = 'call';
                } else {
                    usageType = 'reference';
                }
                // Track receiver for field expressions (obj.name → receiver = 'obj')
                const value = parent.childForFieldName('value');
                if (value && value.type === 'identifier') {
                    usages.push({ line, column, usageType, receiver: value.text });
                    return true;
                }
            }
            // Macro body: tree-sitter parses macro arguments as flat token_tree
            // nodes, so `svc.save()` inside `assert_eq!(svc.save(), 1)` appears
            // as sibling identifiers: [svc] [.] [save] [()] rather than a
            // field_expression. Detect the `obj.name(` pattern via siblings.
            else if (parent.type === 'token_tree') {
                const idx = _indexInParent(node, parent);
                const siblings = Array.from({ length: parent.childCount }, (_, i) => parent.child(i));
                const callArgs = _tokenTreeCallArgsAfter(siblings, idx);
                // Method call pattern: [obj] [.] [name] [()] inside macro
                if (idx >= 2) {
                    const dot = parent.child(idx - 1);
                    const obj = parent.child(idx - 2);
                    if (dot && dot.text === '.' && obj &&
                        (obj.type === 'identifier' || obj.type === 'self')) {
                        if (callArgs) {
                            usageType = 'call';
                        }
                        usages.push({ line, column, usageType, receiver: obj.text });
                        return true;
                    }
                }
                // Bare function call pattern: [name] [()] inside macro
                if (idx >= 0) {
                    // Check no preceding dot (would be method call handled above)
                    const prev = idx > 0 ? parent.child(idx - 1) : null;
                    if (prev?.type === 'fn') {
                        // `fn name(...)` in a token tree is a definition
                        // template, not a call (fix #360).
                        usageType = 'definition';
                    } else if ((!prev || prev.text !== '.') && callArgs) {
                        usageType = 'call';
                    }
                }
            }
        }

        // Filter out enum variant references: Boundary::Grid is NOT a usage of Grid struct
        // If our node is the NAME (right side) of a scoped_identifier/scoped_type_identifier,
        // and the PATH (left side) is a different Capitalized type, it's likely an enum variant.
        // Never a CALL site (fix #234, campaign G2-rust BUG-1): the scoped-call
        // branch classified `DataService::with_defaults()` as a call, and this
        // filter then swallowed it — usages reported '0 calls' for every
        // path-qualified Type::method() invocation, the exact answer that
        // invites deleting a live function.
        if (usageType !== 'call' &&
            parent && (parent.type === 'scoped_identifier' || parent.type === 'scoped_type_identifier')) {
            const nameField = parent.childForFieldName('name');
            const pathField = parent.childForFieldName('path');
            if (sameNode(nameField, node) && pathField) {
                const pathText = pathField.text;
                // If path is a Capitalized identifier different from our target, it's Type::Variant
                // Skip module paths (lowercase), self/Self/super/crate keywords
                if (/^[A-Z]/.test(pathText) && pathText !== name &&
                    !['Self'].includes(pathText)) {
                    return true; // Skip — this is EnumType::Variant, not our type
                }
            }
        }

        let inAttribute = false;
        let attributeNode = null;
        for (let a = parent; a; a = a.parent) {
            if (a.type === 'attribute' || a.type === 'attribute_item') {
                inAttribute = true;
                attributeNode = a.type === 'attribute' ? a
                    : a.namedChildren.find(child => child.type === 'attribute') || null;
                break;
            }
            if (a.type === 'function_item' || a.type === 'impl_item' ||
                a.type === 'struct_item') break;
        }
        // Macro namespace (fix #377): a macro invocation's name, an
        // attribute's path (`#[must_use]`, `#[tokio::main]`) and a derive
        // list entry (`#[derive(Debug)]`) name macros or built-in
        // attributes, never a same-named fn, const or local.
        const macroNamespace = rustMacroNamespaceName(node, parent, attributeNode);
        // Where a bare reference resolves (fix #392).
        const scope = scopeMemo && usageType === 'reference' && !macroNamespace
            ? scopeFields(inAttribute ? 'unknown' : referenceScope(node, 'rust', scopeMemo)) : null;
        // `S { name }` names the field too: a rename keeps the key (fix #397).
        const shorthandProperty = scopeMemo && parent?.type === 'shorthand_field_initializer';
        usages.push({ line, column, usageType, ...(inAttribute && { inAttribute: true }),
            ...(macroNamespace && { namespace: 'macro' }), ...scope,
            ...(shorthandProperty && { shorthandProperty: true }) });
        return true;
    });

    return usages;
}

/**
 * Is this identifier a name in the macro namespace (fix #377)? The name of a
 * macro invocation, the path of an attribute, or an entry of a derive list
 * (also inside `cfg_attr(..., derive(...))`).
 */
function rustMacroNamespaceName(node, parent, attributeNode) {
    if (!parent) return false;
    if (parent.type === 'macro_invocation') return sameNode(parent.childForFieldName('macro'), node);
    if (parent.type === 'scoped_identifier' && sameNode(parent.childForFieldName('name'), node)) {
        const up = parent.parent;
        if (up?.type === 'macro_invocation') return sameNode(up.childForFieldName('macro'), parent);
        if (up?.type === 'attribute') return sameNode(up.namedChild(0), parent);
    }
    if (!attributeNode) return false;
    if (parent.type === 'attribute') return sameNode(parent.namedChild(0), node);
    if (parent.type !== 'token_tree') return false;
    // derive(A, path::B): the token tree follows the `derive` path (the
    // attribute's own path, or an identifier token inside cfg_attr).
    const opener = parent.parent?.type === 'attribute' && sameNode(parent.parent.childForFieldName('arguments'), parent)
        ? parent.parent.namedChild(0)
        : parent.previousSibling;
    if (!opener || opener.text !== 'derive') return false;
    const next = node.nextSibling;
    return !next || next.type !== '::';
}

/**
 * Classify a Rust symbol as a runtime entry point of a specific kind.
 * Returns 'test' | 'main' | 'framework' | null.
 *
 * - 'test': harness-invoked — #[test], #[bench], or anything inside a
 *           #[cfg(test)] module (which only compiles for `cargo test`).
 * - 'main': program entry — fn main()
 * - 'framework': trait-impl methods (invoked by the trait contract holder)
 *
 * Used by tracing/search to distinguish test-coverage producers from runtime
 * entry points so `affectedTests` doesn't mis-tag fn main() as a test case.
 */
function getEntryPointKind(symbol) {
    const m = symbol.modifiers || [];
    // Test entries first — #[test]/#[bench] take precedence even over fn main().
    if (m.includes('test') || m.includes('bench')) return 'test';
    // Functions inside #[cfg(test)] mod blocks — test-only code, even if they
    // lack a direct #[test] attribute (e.g. shared helpers in `mod tests`).
    if (m.includes('cfg_test_module')) return 'test';
    // Only the FREE function fn main() is the binary entry — an impl method
    // named `main` is an ordinary method (fix #243; it was never audited by
    // deadcode and entrypoints listed it as runtime).
    if (symbol.name === 'main' && !symbol.className && !symbol.receiver) return 'main';
    // Trait-impl methods are framework entry points (invoked by trait holder).
    if (symbol.isMethod && symbol.className && symbol.traitImpl) return 'framework';
    return null;
}

/**
 * Check if a symbol is a Rust-convention entry point.
 * These are invoked by the Rust runtime, test harness, or required by trait contracts.
 */
function isEntryPoint(symbol) {
    return getEntryPointKind(symbol) !== null;
}

module.exports = {
    primeDeclarationTrees,
    parseDeclarationsIn,
    rustMacroInvocationContext,
    findFunctions,
    findClasses,
    findStateObjects,
    findCallsInCode,
    findImportsInCode,
    findExportsInCode,
    findUsagesInCode,
    isEntryPoint,
    getEntryPointKind,
    parse
};
