/**
 * languages/rust.js - Tree-sitter based Rust parsing
 *
 * Handles: function definitions, struct/enum/trait/impl blocks,
 * modules, macros, and const/static declarations.
 */

const {
    traverseTree,
    traverseTreeCached,
    nodeToLocation,
    parseStructuredParams,
    extractRustDocstring,
    visitNameNodes,
    sameNode,
} = require('./utils');
const { PARSE_OPTIONS, safeParse } = require('./index');

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
    traverseTreeCached(recovered.rootNode, node => {
        if (MACRO_ITEM_NODES.has(node.type)) {
            itemCount++;
            const name = node.childForFieldName('name');
            if (name) declarationNameStarts.add(name.startIndex);
        }
        return true;
    });
    if (itemCount === 0) return null;
    return { tree: recovered, itemCount, declarationNameStarts };
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
    };
    lastDeclarationParser = parser;
    lastDeclarationCode = code;
    lastDeclarationTrees = result;
    return result;
}

/**
 * Extract return type from Rust function
 */
function extractReturnType(node) {
    const returnTypeNode = node.childForFieldName('return_type');
    if (returnTypeNode) {
        let text = returnTypeNode.text.trim();
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
    const text = paramsNode.text;
    return text.replace(/^\(|\)$/g, '').trim();
}

function extractRustCallbackParamTypes(paramsNode) {
    if (!paramsNode) return undefined;
    const callbacks = {};
    let callArgumentIndex = 0;
    for (let i = 0; i < paramsNode.namedChildCount; i++) {
        const parameter = paramsNode.namedChild(i);
        if (parameter.type === 'self_parameter') continue;
        if (parameter.type !== 'parameter') continue;
        const typeNode = parameter.childForFieldName('type');
        let functionType = null;
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
        const callbackParams = functionType?.childForFieldName('parameters');
        if (callbackParams) {
            const types = [];
            let complete = true;
            for (let j = 0; j < callbackParams.namedChildCount; j++) {
                const name = aliasBaseTypeName(callbackParams.namedChild(j));
                if (!name) {
                    complete = false;
                    break;
                }
                types.push(name);
            }
            if (complete && types.length > 0) callbacks[callArgumentIndex] = types;
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
            const m = line.match(/^#\[(.+)\]\s*$/);
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
            const firstLine = text.split('\n')[0];

            const isAsync = firstLine.includes('async ');
            const isUnsafe = firstLine.includes('unsafe ');
            const isConst = firstLine.includes('const fn');
            const isExtern = firstLine.includes('extern ');
            const visibility = extractVisibility(text);
            const returnType = extractReturnType(node);
            const iteratorItemType = extractRustIteratorItemType(node);
            const docstring = extractRustDocstring(lines, startLine);
            const generics = extractGenerics(node);
            const genericBounds = extractGenericBounds(node);
            const attributes = extractAttributes(node, lines);
            const attributesWithArgs = extractAttributesWithArgs(node, lines);
            const inCfgTest = _isInsideCfgTestModule(node, lines);
            const callbackParamTypes = extractRustCallbackParamTypes(paramsNode);

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
                        const callbackParamTypes = extractRustCallbackParamTypes(fParams);
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
function _processClass(node, types, processedRanges, lines, code) {
    // Struct items
    if (node.type === 'struct_item') {
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

            types.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'struct',
                members,
                modifiers,
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

            types.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'trait',
                members: extractTraitMembers(node, lines),
                modifiers: visibility ? [visibility] : [],
                ...(docstring && { docstring }),
                ...(generics && { generics })
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

        types.push({
            name: implInfo.name,
            startLine,
            endLine,
            type: 'impl',
            traitName: implInfo.traitName,
            typeName: implInfo.typeName,
            members: extractImplMembers(node, lines, implInfo.typeName),
            modifiers: [],
            ...(implInfo.generics && { generics: implInfo.generics }),
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

            types.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'macro',
                members: [],
                modifiers: [],
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

            types.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'type',
                members: [],
                modifiers: visibility ? [visibility] : [],
                ...(aliasOf && { aliasOf }),
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
    // Handle const items (only top-level)
    if (node.type === 'const_item') {
        if (!node.parent || node.parent.type !== 'source_file') return false;
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const name = nameNode.text;
            if (_STATE_PATTERN.test(name)) {
                const { startLine, endLine } = nodeToLocation(node, lines);
                objects.push({ name, startLine, endLine });
            }
        }
        return true;
    }

    // Handle static items (only top-level)
    if (node.type === 'static_item') {
        if (!node.parent || node.parent.type !== 'source_file') return false;
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            const name = nameNode.text;
            if (_STATE_PATTERN.test(name)) {
                const { startLine, endLine } = nodeToLocation(node, lines);
                objects.push({ name, startLine, endLine });
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
        const parameter = children.find(child => child.type === 'type_identifier');
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
                for (let j = 0; j < child.namedChildCount; j++) {
                    const variantChild = child.namedChild(j);
                    if (variantChild.type === 'field_declaration_list' || variantChild.type === 'ordered_field_declaration_list') {
                        params = variantChild.text.slice(1, -1);
                    }
                }
                variants.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    memberType: 'variant',
                    ...(params !== undefined && { params })
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
                const callbackParamTypes = extractRustCallbackParamTypes(paramsNode);

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
                    modifiers: traitVisibility ? [traitVisibility] : [],
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
function extractImplMembers(implNode, codeOrLines, typeName) {
    const code = codeOrLines;
    const members = [];
    const bodyNode = implNode.childForFieldName('body');
    if (!bodyNode) return members;
    const implAttributes = extractAttributes(implNode, codeOrLines);

    for (let i = 0; i < bodyNode.namedChildCount; i++) {
        const child = bodyNode.namedChild(i);

        if (child.type === 'function_item') {
            const nameNode = child.childForFieldName('name');
            const paramsNode = child.childForFieldName('parameters');

            if (nameNode) {
                const { startLine, endLine } = nodeToLocation(child, code);
                const text = child.text;
                const firstLine = text.split('\n')[0];
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
                if (firstLine.includes('async ')) modifiers.push('async');
                if (firstLine.includes('unsafe ')) modifiers.push('unsafe');
                if (firstLine.includes('const fn')) modifiers.push('const');
                if (firstLine.includes('extern ')) modifiers.push('extern');
                for (const attr of attributes) modifiers.push(attr);
                for (const attr of implAttributes) {
                    if (!modifiers.includes(attr)) modifiers.push(attr);
                }
                if (inCfgTest) modifiers.push('cfg_test_module');

                const memberGenerics = extractGenerics(child);
                const genericBounds = extractGenericBounds(child);
                const callbackParamTypes = extractRustCallbackParamTypes(paramsNode);
                members.push({
                    name: nameNode.text,
                    params: extractRustParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'rust'),
                    ...(callbackParamTypes && { callbackParamTypes }),
                    startLine,
                    endLine,
                    memberType: 'method',
                    isAsync: firstLine.includes('async '),
                    isMethod: hasSelf,  // Only true methods (with self) — associated functions are false
                    modifiers,
                    ...(typeName && { receiver: typeName }),  // All impl members get receiver for findMethodsForType
                    ...(returnType && { returnType }),
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
        imports: [], exports: [],
    };
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

function extractCallsFromTokenTree(tree, enclosingFunction, calls, getReceiverType,
    isPatternShadow, isFlowInvalidated, context = 'invocation') {
    const contextKind = typeof context === 'string' ? context : context.kind;
    const containerMacro = typeof context === 'object' ? context.containerMacro : undefined;
    const inheritedTokenTypes = typeof context === 'object' && context.tokenTypes
        ? context.tokenTypes : new Map();
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
        const bindings = new Map(inheritedTokenTypes);
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
                    bindings.set(nameNode.text, identifiers[identifiers.length - 1].text);
                }
            }
            cursor = end + 1;
        }
        const body = children[close + 1];
        if (body?.type === 'token_tree') closureBodyTypes.set(body.id, bindings);
        i = close;
    }
    let lastProducer = null;
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
            const record = {
                name: tok.text,
                line: tok.startPosition.row + 1,
                callStart: startNode.startIndex,
                callEnd: callArgs.endIndex,
                isMethod: segments.length > 0,
                isPathCall: true,
                receiver: segments.length > 0 ? segments.join('::') : undefined,
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
            const litType = recvTok
                ? ({ string_literal: 'str', raw_string_literal: 'str',
                    char_literal: 'char', boolean_literal: 'bool' })[recvTok.type]
                : undefined;
            const receiverType = (receiver && receiver !== 'self')
                ? (getReceiverType?.(receiver, tok) || inheritedTokenTypes.get(receiver))
                : litType;
            const receiverPatternShadow = !!(receiver && isPatternShadow?.(tok, receiver));
            const receiverFlowInvalidated = !!(receiver && isFlowInvalidated?.(tok, receiver));
            const iterationSource = rustIterationSourceOf(tok, receiver);
            const producer = !receiver && lastProducer &&
                lastProducer.callEnd === recvTok?.endIndex ? lastProducer : null;
            const record = {
                name: tok.text,
                line: tok.startPosition.row + 1,
                callStart: producer?.callStart ?? recvTok?.startIndex ?? tok.startIndex,
                callEnd: callArgs.endIndex,
                isMethod: true,
                receiver: receiverField ? undefined : receiver,
                ...(receiverField && { receiverRoot, receiverField }),
                ...(receiverType && { receiverType }),
                ...(receiverPatternShadow && { receiverPatternShadow: true }),
                ...(receiverFlowInvalidated && { receiverFlowInvalidated: true }),
                ...(iterationSource || {}),
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
            if (bindings.length === pattern.namedChildCount && bindings.length > 0) {
                return {
                    assignedTo: bindings[0],
                    tuple: true,
                    ...(bindings.length > 1 && { tupleRest: bindings.slice(1) }),
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

    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
        if (ancestor.type === 'function_item') break;
        if (ancestor.type === 'closure_expression') {
            const params = ancestor.childForFieldName('parameters');
            if (params && patternContainsIdentifier(params, receiver)) break;
            continue; // captured binding from an outer match arm
        }
        if (ancestor.type !== 'match_arm') continue;
        let matchExpression = ancestor.parent;
        while (matchExpression && matchExpression.type !== 'match_expression' &&
            matchExpression.type !== 'function_item') {
            matchExpression = matchExpression.parent;
        }
        const matchValue = matchExpression?.type === 'match_expression'
            ? matchExpression.childForFieldName('value')
            : null;
        const source = matchValue?.type === 'identifier'
            ? { receiverPatternSourceVariable: matchValue.text }
            : {};
        const root = ancestor.childForFieldName('pattern');
        const pending = root ? [root] : [];
        while (pending.length > 0) {
            const pattern = pending.pop();
            if (pattern.type === 'tuple_struct_pattern') {
                const typeNode = pattern.childForFieldName('type');
                const positional = pattern.namedChildren
                    .filter(child => !typeNode || child.id !== typeNode.id);
                for (let i = 0; i < positional.length; i++) {
                    if (directBindingName(positional[i]) !== receiver) continue;
                    const pathText = typeNode?.text;
                    if (!pathText) return null;
                    const segments = pathText.split('::').filter(Boolean);
                    const variant = segments.pop();
                    if (!variant) return null;
                    return {
                        receiverPatternVariant: variant,
                        receiverPatternIndex: i,
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

function findCallsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const calls = [];
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

    // Extract the base type name from a Rust type node (strips &, &mut, Box<>, etc.)
    const extractTypeName = (typeNode) => {
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

    // Build type map from function parameters (including self receiver for impl methods)
    const buildScopeTypeMap = (node) => {
        const typeMap = new Map();
        typeMap.qualifiers = new Map();
        typeMap.iteratorItems = new Map();
        typeMap.annotationTexts = new Map();
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
                    const typeNode = param.childForFieldName('type');
                    const typeName = extractTypeName(typeNode);
                    const qualifier = extractTypeQualifier(typeNode);
                    const iteratorItem = extractRustIteratorItemTypeFromTypeNode(typeNode);
                    if (patternNode && typeName) {
                        // Pattern can be identifier or _
                        const name = patternNode.type === 'identifier' ? patternNode.text : null;
                        if (name) {
                            typeMap.set(name, typeName);
                            typeMap.annotationTexts.set(name, typeNode.text);
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
    const getReceiverType = (varName, atNode) => {
        if (atNode && patternShadowsAt(atNode, varName)) return undefined;
        const flow = flowEventAt(atNode, varName);
        if (flow?.type) return flow.type;
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const typeMap = scopeTypes.get(functionStack[i].startLine);
            if (typeMap?.has(varName)) return typeMap.get(varName);
            if (typeMap?.boundNames?.has(varName)) return undefined;
        }
        return undefined;
    };

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

    // Walk up to the enclosing impl block's target type (impl<T> Foo<T> → Foo).
    const findEnclosingImplType = (n) => {
        for (let p = n.parent; p; p = p.parent) {
            if (p.type === 'impl_item') {
                const t = p.childForFieldName('type');
                return (t && extractTypeName(t)) || undefined;
            }
        }
        return undefined;
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
            for (let i = 0; i < parameters.namedChildCount; i++) {
                const parameter = parameters.namedChild(i);
                if (parameter.type === 'identifier') {
                    parameterNames.push(parameter.text);
                    continue;
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
        if (!parametersComplete || parameterNames.length === 0) return null;
        return {
            closureSourceCall: callName,
            closureSourceCallStart: outerCall.startIndex,
            closureSourceCallEnd: outerCall.endIndex,
            closureSourceCallIsMethod: callIsMethod,
            closureArgumentIndex: argumentIndex,
            closureParameterNames: parameterNames,
        };
    };

    traverseTree(tree.rootNode, (node) => {
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
                        ...(() => {
                            const inferred = matchBindingType(value, node);
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

            // Assignment target for return-type flow (fix #207): let args =
            // parse_low_raw(...)? lets findCallers type args from the
            // producer's declared return type at query time.
            const assigned = rustAssignmentTargetOf(node);

            // Call-site arg count for arity pruning (no spread syntax in Rust;
            // UFCS `Type::method(&x, ...)` counts the explicit self — the
            // pruning range accounts for the shift).
            const argsNode = node.childForFieldName('arguments');
            let argCount = 0;
            if (argsNode) {
                for (let i = 0; i < argsNode.namedChildCount; i++) {
                    if (argsNode.namedChild(i).type.endsWith('comment')) continue;
                    argCount++;
                }
            }

            if (funcNode.type === 'identifier') {
                // Direct call: foo()
                const firstArg = getFirstStringArg(node);
                calls.push({
                    name: funcNode.text,
                    line: node.startPosition.row + 1,
                    callStart: node.startIndex,
                    callEnd: node.endIndex,
                    isMethod: false,
                    argCount,
                    ...(assigned && { assignedTo: assigned.assignedTo }),
                    ...(assigned?.unwrapped && { assignedUnwrap: true }),
                    ...(assigned?.tuple && { assignedTuple: true }),
                    ...(assigned?.tupleRest && { assignedTupleRest: assigned.tupleRest }),
                    enclosingFunction,
                    ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp })
                });
            } else if (funcNode.type === 'field_expression') {
                // Method call: obj.method()
                const fieldNode = funcNode.childForFieldName('field');
                const valueNode = funcNode.childForFieldName('value');

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
                    const literalReceiverType = (!receiver && valueNode)
                        ? ({ string_literal: 'str', raw_string_literal: 'str',
                            char_literal: 'char', boolean_literal: 'bool' })[valueNode.type]
                        : undefined;
                    const receiverType = (receiver && receiver !== 'self' && !receiverIsChainRoot)
                        ? getReceiverType(receiver, node)
                        : literalReceiverType;
                    const receiverTypeQualifier = receiver && receiverType
                        ? getReceiverTypeQualifier(receiver, node)
                        : undefined;
                    const receiverIteratorItemType = receiver
                        ? getReceiverIteratorItemType(receiver, node)
                        : undefined;
                    const receiverPatternShadow = !!(receiver && patternShadowsAt(node, receiver));
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
                        isMethod: true,
                        receiver,
                        ...(receiverType && { receiverType }),
                        ...(receiverTypeQualifier && { receiverTypeQualifier }),
                        ...(receiverIteratorItemType && { receiverIteratorItemType }),
                        ...(receiverPatternShadow && { receiverPatternShadow: true }),
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
                        ...(assigned && { assignedTo: assigned.assignedTo }),
                        ...(assigned?.unwrapped && { assignedUnwrap: true }),
                        ...(assigned?.tuple && { assignedTuple: true }),
                        ...(assigned?.tupleRest && { assignedTupleRest: assigned.tupleRest }),
                        ...(collectResult && {
                            explicitResultType: collectResult.type,
                            explicitResultItemType: collectResult.itemType,
                        }),
                        enclosingFunction,
                        ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp })
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
                    isMethod: segments.length > 1,
                    isPathCall: true,  // Distinguishes Type::func()/module::func() from obj.method()
                    receiver: recvSegments.length > 0 ? recvSegments.join('::') : undefined,
                    argCount,
                    ...(assigned && { assignedTo: assigned.assignedTo }),
                    ...(assigned?.unwrapped && { assignedUnwrap: true }),
                    ...(assigned?.tuple && { assignedTuple: true }),
                    ...(assigned?.tupleRest && { assignedTupleRest: assigned.tupleRest }),
                    enclosingFunction,
                    ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp })
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
                    enclosingFunction
                });
            }
            // Calls INSIDE the macro body: tree-sitter parses macro arguments
            // as an unstructured token_tree, which hid every call written
            // inside assert_eq!/format!/vec!/write! (measured: 175 unclaimed
            // call lines on ripgrep — test assertions live in macros).
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child.type === 'token_tree') {
                    extractCallsFromTokenTree(
                        child, enclosingFunction, calls, getReceiverType,
                        patternShadowsAt, flowInvalidatedAt, {
                            kind: 'invocation',
                            containerMacro: macro?.name,
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
                        ...(receiverType && { receiverType }),
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
            if (patternNode && patternNode.type === 'identifier') {
                const varName = patternNode.text;
                const scopeKey = functionStack[functionStack.length - 1].startLine;
                const typeMap = scopeTypes.get(scopeKey);
                if (typeMap) {
                    let typeName = null;
                    let typeQualifier = null;
                    // Pattern 3: explicit type annotation — let s: Server = ...
                    if (typeAnnotation) {
                        typeName = extractTypeName(typeAnnotation);
                        typeQualifier = extractTypeQualifier(typeAnnotation);
                    }
                    if (!typeName && valueNode) {
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
                            if (funcNode?.type === 'scoped_identifier') {
                                const pathText = funcNode.text;
                                const segments = pathText.split('::');
                                if (segments.length >= 2) {
                                    const methodName = segments[segments.length - 1];
                                    if (/^(new|from|default|with_|create|build|open|connect|init)/.test(methodName)) {
                                        typeName = segments[segments.length - 2];
                                        typeQualifier = segments.slice(0, -2).join('::') || null;
                                        if (!typeName || !/^[A-Z]/.test(typeName)) typeName = null;
                                    }
                                }
                            }
                        }
                    }
                    if (typeName) {
                        typeMap.set(varName, typeName);
                        if (typeQualifier) typeMap.qualifiers.set(varName, typeQualifier);
                    }
                }
            }
        }

        return true;
    }, {
        onLeave: (node) => {
            if (isFunctionNode(node)) {
                const leaving = functionStack.pop();
                if (leaving) {
                    scopeTypes.delete(leaving.startLine);
                    scopeFlowEvents.delete(leaving.startLine);
                }
            }
        }
    });

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
    const addLeaf = (module, localName, type = 'use', dynamic = false, line) => {
        if (!module || !localName) return;
        imports.push({
            module,
            names: [localName],
            type,
            dynamic,
            line,
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
                addLeaf(joinUsePath(prefix, pathNode.text), aliasNode.text,
                    'use', false, line);
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

        // Public structs
        if (node.type === 'struct_item' && hasVisibility(node)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                append({
                    name: nameNode.text,
                    type: 'struct',
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

function findUsagesInCode(code, name, parser, tree) {
    tree = tree || parseTree(parser, code);
    const usages = [];
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
            // Definition: struct name
            else if (parent.type === 'struct_item' &&
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
                    if ((!prev || prev.text !== '.') && callArgs) {
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
        for (let a = parent; a; a = a.parent) {
            if (a.type === 'attribute' || a.type === 'attribute_item') {
                inAttribute = true;
                break;
            }
            if (a.type === 'function_item' || a.type === 'impl_item' ||
                a.type === 'struct_item') break;
        }
        usages.push({ line, column, usageType, ...(inAttribute && { inAttribute: true }) });
        return true;
    });

    return usages;
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
