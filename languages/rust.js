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
            const docstring = extractRustDocstring(lines, startLine);
            const generics = extractGenerics(node);
            const attributes = extractAttributes(node, lines);
            const attributesWithArgs = extractAttributesWithArgs(node, lines);
            const inCfgTest = _isInsideCfgTestModule(node, lines);

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
                startLine,
                endLine,
                indent,
                modifiers,
                ...(returnType && { returnType }),
                ...(docstring && { docstring }),
                ...(generics && { generics }),
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
                        const modifiers = ['extern'];
                        if (visibility) modifiers.push(visibility);

                        functions.push({
                            name: fName.text,
                            params: extractRustParams(fParams),
                            paramsStructured: parseStructuredParams(fParams, 'rust'),
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

        types.push({
            name: implInfo.name,
            startLine,
            endLine,
            type: 'impl',
            traitName: implInfo.traitName,
            typeName: implInfo.typeName,
            members: extractImplMembers(node, lines, implInfo.typeName),
            modifiers: [],
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

            types.push({
                name: nameNode.text,
                startLine,
                endLine,
                type: 'macro',
                members: [],
                modifiers: [],
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
    for (const t of types) {
        if (t.type === 'impl' && t.traitName && t.typeName) {
            if (!implTraits.has(t.typeName)) implTraits.set(t.typeName, []);
            implTraits.get(t.typeName).push(t.traitName);
        }
    }
    for (const t of types) {
        if ((t.type === 'struct' || t.type === 'enum') && implTraits.has(t.name)) {
            t.implements = implTraits.get(t.name);
        }
    }
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
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const functions = [];
    const processedRanges = new Set();
    traverseTreeCached(tree.rootNode, (node) => {
        _processFunction(node, functions, processedRanges, lines, code);
        return true;
    });
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
 * Find all types (structs, enums, traits, impls) in Rust code
 */
function findClasses(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const types = [];
    const processedRanges = new Set();
    traverseTreeCached(tree.rootNode, (node) => {
        const matched = _processClass(node, types, processedRanges, lines, code);
        // For impl_item, don't traverse into impl body (original behavior)
        if (matched && node.type === 'impl_item') return false;
        return true;
    });
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

    // Strip generic type arguments from typeName and traitName for lookup
    // e.g., "CacheService<T>" → "CacheService", "Entity" stays "Entity"
    const stripGenerics = (s) => s ? s.replace(/<[^>]*>/g, '').trim() : s;
    const bareTypeName = stripGenerics(typeName);
    const bareTraitName = stripGenerics(traitName);

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
                const hasSelf = paramsNode && paramsNode.text.includes('self');

                members.push({
                    name: nameNode.text,
                    startLine,
                    endLine,
                    memberType: 'method',
                    isMethod: true,
                    modifiers: ['public'], // Trait methods are implicitly public
                    ...(paramsNode && { params: extractRustParams(paramsNode) }),
                    ...(paramsNode && { paramsStructured: parseStructuredParams(paramsNode, 'rust') }),
                    ...(returnType && { returnType }),
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
                const docstring = extractRustDocstring(code, startLine);
                const visibility = extractVisibility(text);

                // Check if this is a method (has self parameter) or associated function
                const hasSelf = paramsNode && paramsNode.text.includes('self');

                // Extract attributes (#[test], #[inline], etc.) for impl members
                const attributes = extractAttributes(child, codeOrLines);
                const inCfgTest = _isInsideCfgTestModule(child, Array.isArray(codeOrLines) ? codeOrLines : codeOrLines.split('\n'));
                const modifiers = [];
                if (visibility) modifiers.push(visibility);
                for (const attr of attributes) modifiers.push(attr);
                if (inCfgTest) modifiers.push('cfg_test_module');

                const memberGenerics = extractGenerics(child);
                members.push({
                    name: nameNode.text,
                    params: extractRustParams(paramsNode),
                    paramsStructured: parseStructuredParams(paramsNode, 'rust'),
                    startLine,
                    endLine,
                    memberType: 'method',
                    isAsync: firstLine.includes('async '),
                    isMethod: hasSelf,  // Only true methods (with self) — associated functions are false
                    modifiers,
                    ...(typeName && { receiver: typeName }),  // All impl members get receiver for findMethodsForType
                    ...(returnType && { returnType }),
                    ...(docstring && { docstring }),
                    // Method-level type params (fix #229): generic-param receiver
                    // types inside the method resolve against this declaration.
                    ...(memberGenerics && { generics: memberGenerics })
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
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const objects = [];
    traverseTreeCached(tree.rootNode, (node) => {
        _processState(node, objects, lines);
        return true;
    });
    objects.sort((a, b) => a.startLine - b.startLine);
    return objects;
}

/**
 * Parse a Rust file completely
 */
function parse(code, parser) {
    const tree = parseTree(parser, code);
    const lines = code.split('\n');
    const functions = [], classes = [], stateObjects = [];
    const processedFn = new Set(), processedCls = new Set();

    traverseTreeCached(tree.rootNode, (node) => {
        _processFunction(node, functions, processedFn, lines, code);
        _processClass(node, classes, processedCls, lines, code);
        _processState(node, stateObjects, lines);
        return true;  // always continue, never skip subtrees
    });

    _postProcessTraitImpls(classes);

    functions.sort((a, b) => a.startLine - b.startLine);
    classes.sort((a, b) => a.startLine - b.startLine);
    stateObjects.sort((a, b) => a.startLine - b.startLine);

    return { language: 'rust', totalLines: lines.length, functions, classes, stateObjects, imports: [], exports: [] };
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
function extractCallsFromTokenTree(tree, enclosingFunction, calls, getReceiverType) {
    const children = [];
    for (let i = 0; i < tree.childCount; i++) children.push(tree.child(i));
    for (let i = 0; i < children.length; i++) {
        const tok = children[i];
        if (tok.type === 'token_tree') {
            extractCallsFromTokenTree(tok, enclosingFunction, calls, getReceiverType);
            continue;
        }
        if (tok.type !== 'identifier') continue;
        const next = children[i + 1];
        const prev = children[i - 1];
        // $metavariable(...) — a macro fragment, not a named call
        if (prev && prev.type === '$') continue;
        // Nested macro invocation: name!(...)
        if (next && next.type === '!' &&
            children[i + 2] && children[i + 2].type === 'token_tree') {
            calls.push({
                name: tok.text,
                line: tok.startPosition.row + 1,
                isMethod: false,
                isMacro: true,
                inMacro: true,
                enclosingFunction
            });
            continue;
        }
        if (!next || next.type !== 'token_tree' || !next.text.startsWith('(')) continue;
        if (prev && prev.type === '::') {
            // Path call: Type::func(...) / module::sub::func(...) — segments
            // can be identifiers, primitives (char::from), or path keywords
            const isSegment = (n) => n && ['identifier', 'primitive_type', 'self', 'super', 'crate'].includes(n.type);
            const segments = [];
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
                segments.unshift(children[k].text);
                j = k - 1;
            }
            calls.push({
                name: tok.text,
                line: tok.startPosition.row + 1,
                isMethod: segments.length > 0,
                isPathCall: true,
                receiver: segments.length > 0 ? segments.join('::') : undefined,
                inMacro: true,
                enclosingFunction
            });
        } else if (prev && prev.type === '.') {
            // Method call: recv.method(...)
            const recvTok = children[i - 2];
            const receiver = recvTok && (recvTok.type === 'identifier' || recvTok.type === 'self')
                ? recvTok.text : undefined;
            // Literal receivers type as builtins inside macros too (fix #220,
            // ripgrep-measured: assert_eq!(.., vec!["match:fg".parse()...]))
            const litType = recvTok
                ? ({ string_literal: 'str', raw_string_literal: 'str',
                    char_literal: 'char', boolean_literal: 'bool' })[recvTok.type]
                : undefined;
            const receiverType = (receiver && receiver !== 'self' && getReceiverType)
                ? getReceiverType(receiver) : litType;
            calls.push({
                name: tok.text,
                line: tok.startPosition.row + 1,
                isMethod: true,
                receiver,
                ...(receiverType && { receiverType }),
                inMacro: true,
                enclosingFunction
            });
        } else {
            // Plain call: func(...) — includes enum-variant constructors
            calls.push({
                name: tok.text,
                line: tok.startPosition.row + 1,
                isMethod: false,
                inMacro: true,
                enclosingFunction
            });
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
    if (p.type === 'let_declaration') {
        const value = p.childForFieldName('value');
        const pattern = p.childForFieldName('pattern');
        if (value && value.id === n.id && pattern?.type === 'identifier') {
            return { assignedTo: pattern.text, ...(unwrapped && { unwrapped: true }) };
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

function findCallsInCode(code, parser) {
    const tree = parseTree(parser, code);
    const calls = [];
    const functionStack = [];  // Stack of { name, startLine, endLine }
    // Track variable -> type mappings per function scope (scopeStartLine -> Map<varName, typeName>)
    const scopeTypes = new Map();

    // Helper: extract first string-arg literal from a call_expression node.
    // Used by route extraction to capture path arg of client.get("/users") and
    // detect format!() macro interpolation: format!("/users/{}", id).
    const { extractStringArg: _extractStringArg } = require('./utils');
    const getFirstStringArg = (callNode) => {
        const argsNode = callNode.childForFieldName('arguments');
        if (!argsNode) return null;
        for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg.type === 'comment') continue;
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
        if (typeNode.type === 'type_identifier') return typeNode.text;
        if (typeNode.type === 'reference_type') {
            // &Filter or &mut Filter -> Filter
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

    // Build type map from function parameters (including self receiver for impl methods)
    const buildScopeTypeMap = (node) => {
        const typeMap = new Map();
        const paramsNode = node.childForFieldName('parameters');
        if (paramsNode) {
            for (let i = 0; i < paramsNode.namedChildCount; i++) {
                const param = paramsNode.namedChild(i);
                if (param.type === 'parameter') {
                    const patternNode = param.childForFieldName('pattern');
                    const typeNode = param.childForFieldName('type');
                    const typeName = extractTypeName(typeNode);
                    if (patternNode && typeName) {
                        // Pattern can be identifier or _
                        const name = patternNode.type === 'identifier' ? patternNode.text : null;
                        if (name) typeMap.set(name, typeName);
                    }
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
            ? { ...functionStack[functionStack.length - 1] }
            : null;
    };

    // Look up variable type from scope chain
    const getReceiverType = (varName) => {
        for (let i = functionStack.length - 1; i >= 0; i--) {
            const typeMap = scopeTypes.get(functionStack[i].startLine);
            if (typeMap?.has(varName)) return typeMap.get(varName);
        }
        return undefined;
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

    traverseTree(tree.rootNode, (node) => {
        // Track function entry
        if (isFunctionNode(node)) {
            const entry = {
                name: extractFunctionName(node),
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1
            };
            functionStack.push(entry);
            scopeTypes.set(entry.startLine, buildScopeTypeMap(node));
        }

        // Handle function calls: foo(), obj.method(), Type::func(), foo::<T>()
        if (node.type === 'call_expression') {
            let funcNode = node.childForFieldName('function');
            if (!funcNode) return true;

            // Unwrap turbofish: parse::<i32>() has generic_function wrapping the actual function
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
                    if (argsNode.namedChild(i).type === 'comment') continue;
                    argCount++;
                }
            }

            if (funcNode.type === 'identifier') {
                // Direct call: foo()
                const firstArg = getFirstStringArg(node);
                calls.push({
                    name: funcNode.text,
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    argCount,
                    ...(assigned && { assignedTo: assigned.assignedTo }),
                    ...(assigned?.unwrapped && { assignedUnwrap: true }),
                    enclosingFunction,
                    ...(firstArg && { firstStringArg: firstArg.value, firstStringArgInterp: firstArg.interp })
                });
            } else if (funcNode.type === 'field_expression') {
                // Method call: obj.method()
                const fieldNode = funcNode.childForFieldName('field');
                const valueNode = funcNode.childForFieldName('value');

                if (fieldNode) {
                    let receiver = (valueNode?.type === 'identifier' || valueNode?.type === 'self') ? valueNode.text : undefined;
                    // Detect chained Router::new()-rooted method calls. axum's canonical
                    // idiom is `Router::new().route("/p", get(h)).route(...)` where the
                    // receiver of `.route(...)` is itself a call_expression. Walk the
                    // chain to its root: if the chain originates at Router::new() or
                    // any Router-typed call, set a synthetic receiver string so the
                    // bridge layer can recognize this as a Router method invocation.
                    if (!receiver && valueNode?.type === 'call_expression') {
                        const rootType = _findRustChainRootType(valueNode);
                        if (rootType) {
                            // Synthetic marker — ROUTER_CHAIN:<RootTypeName>. The
                            // <RootTypeName> portion lets the bridge match
                            // /^router/i case-insensitively.
                            receiver = rootType;
                        }
                    }
                    // fix #202: one-hop declared-field receivers — self.dent.path(),
                    // low.sep.into_bytes() — with .clone() transparency (clone()
                    // returns Self by stdlib convention). receiverRoot/Field/RootType
                    // let findCallers hop to the field's declared type cross-file.
                    let receiverRoot, receiverField, receiverRootType;
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
                            const rootNode = obj.childForFieldName('value');
                            const fldNode = obj.childForFieldName('field');
                            if (fldNode?.type === 'field_identifier' && rootNode &&
                                (rootNode.type === 'identifier' || rootNode.type === 'self')) {
                                receiverRoot = rootNode.text;
                                receiverField = fldNode.text;
                                receiverRootType = rootNode.type === 'self'
                                    ? findEnclosingImplType(node)
                                    : getReceiverType(rootNode.text);
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
                    // Path producers (Config::load().x()) stay uncaptured
                    // until a measured family justifies the path branch.
                    let receiverCall, receiverCallIsMethod;
                    if (!receiver && !receiverField && valueNode?.type === 'call_expression') {
                        const prodFunc = valueNode.childForFieldName('function');
                        if (prodFunc?.type === 'identifier') {
                            receiverCall = prodFunc.text;
                        } else if (prodFunc?.type === 'field_expression') {
                            const pf = prodFunc.childForFieldName('field');
                            if (pf) { receiverCall = pf.text; receiverCallIsMethod = true; }
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
                    const receiverType = (receiver && receiver !== 'self')
                        ? getReceiverType(receiver)
                        : literalReceiverType;
                    const firstArg = getFirstStringArg(node);
                    // RUST-2: For chained calls like `a().b().parse::<T>().ok()`,
                    // each method should report the line where its OWN identifier
                    // appears, not the line where the outer expression begins.
                    // Tree-sitter gives us fieldNode (the identifier) — use its
                    // startPosition.row instead of the wrapping call_expression's.
                    calls.push({
                        name: fieldNode.text,
                        line: fieldNode.startPosition.row + 1,
                        isMethod: true,
                        receiver,
                        ...(receiverType && { receiverType }),
                        ...(receiverField && { receiverRoot, receiverField }),
                        ...(receiverField && receiverRootType && { receiverRootType }),
                        ...(receiverCall && { receiverCall }),
                        ...(receiverCallIsMethod && { receiverCallIsMethod: true }),
                        argCount,
                        ...(assigned && { assignedTo: assigned.assignedTo }),
                        ...(assigned?.unwrapped && { assignedUnwrap: true }),
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
                    isMethod: segments.length > 1,
                    isPathCall: true,  // Distinguishes Type::func()/module::func() from obj.method()
                    receiver: recvSegments.length > 0 ? recvSegments.join('::') : undefined,
                    argCount,
                    ...(assigned && { assignedTo: assigned.assignedTo }),
                    ...(assigned?.unwrapped && { assignedUnwrap: true }),
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
            if (macroNode) {
                let macroName = macroNode.text;
                // Remove the trailing ! if present in the name
                if (macroName.endsWith('!')) {
                    macroName = macroName.slice(0, -1);
                }
                calls.push({
                    name: macroName,
                    line: node.startPosition.row + 1,
                    isMethod: false,
                    isMacro: true,
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
                    extractCallsFromTokenTree(child, enclosingFunction, calls, getReceiverType);
                }
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
                        extractCallsFromTokenTree(part, enclosingFunction, calls, getReceiverType);
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
                    const receiverType = (receiver && receiver !== 'self') ? getReceiverType(receiver) : undefined;
                    const enclosingFunction = getCurrentEnclosingFunction();
                    // RUST-2: use the field identifier's line, not the wrapping field_expression's
                    calls.push({
                        name: fieldNode.text,
                        line: fieldNode.startPosition.row + 1,
                        isMethod: true,
                        receiver,
                        ...(receiverType && { receiverType }),
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
                    // Pattern 3: explicit type annotation — let s: Server = ...
                    if (typeAnnotation) {
                        typeName = extractTypeName(typeAnnotation);
                    }
                    if (!typeName && valueNode) {
                        // Pattern 1: struct expression — let s = Server { ... }
                        if (valueNode.type === 'struct_expression') {
                            const nameNode = valueNode.childForFieldName('name');
                            typeName = nameNode?.text || null;
                            // Strip path prefix: module::Server → Server
                            if (typeName && typeName.includes('::')) {
                                const parts = typeName.split('::');
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
                                        if (!typeName || !/^[A-Z]/.test(typeName)) typeName = null;
                                    }
                                }
                            }
                        }
                    }
                    if (typeName) typeMap.set(varName, typeName);
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
                }
            }
        }
    });

    return calls;
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

    traverseTreeCached(tree.rootNode, (node) => {
        // use declarations
        if (node.type === 'use_declaration') {
            const line = node.startPosition.row + 1;

            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);

                if (child.type === 'use_as_clause') {
                    // use foo::bar as baz
                    const pathNode = child.namedChild(0); // the original path
                    const aliasNode = child.childForFieldName('alias');
                    if (pathNode) {
                        const originalPath = pathNode.text;
                        const alias = aliasNode ? aliasNode.text : originalPath.split('::').pop();
                        imports.push({
                            module: originalPath,
                            names: [alias],
                            type: 'use',
                            dynamic: false,
                            line
                        });
                    }
                } else if (child.type === 'scoped_identifier' || child.type === 'identifier') {
                    // use std::io or use foo
                    const path = child.text;
                    const segments = path.split('::');
                    imports.push({
                        module: path,
                        names: [segments[segments.length - 1]],
                        type: 'use',
                        dynamic: false,
                        line
                    });
                } else if (child.type === 'use_wildcard') {
                    // use std::collections::*
                    const scopedId = child.namedChild(0);
                    if (scopedId) {
                        imports.push({
                            module: scopedId.text,
                            names: ['*'],
                            type: 'use-glob',
                            dynamic: true,
                            line
                        });
                    }
                } else if (child.type === 'use_list' || child.type === 'scoped_use_list') {
                    // use std::{io, fs} or use foo::{bar, baz}
                    // Extract the base path and names
                    const pathNode = child.childForFieldName('path');
                    const listNode = child.childForFieldName('list');

                    if (pathNode && listNode) {
                        const basePath = pathNode.text;
                        const names = [];
                        for (let j = 0; j < listNode.namedChildCount; j++) {
                            const item = listNode.namedChild(j);
                            if (item.type === 'identifier') {
                                names.push(item.text);
                            } else if (item.type === 'use_as_clause') {
                                const aliasNode = item.childForFieldName('alias');
                                const pathItem = item.namedChild(0);
                                names.push(aliasNode ? aliasNode.text : (pathItem ? pathItem.text : item.text));
                            } else if (item.type === 'scoped_identifier') {
                                names.push(item.text);
                            }
                        }
                        imports.push({
                            module: basePath,
                            names,
                            type: 'use',
                            dynamic: false,
                            line
                        });
                    }
                }
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
    const tree = parseTree(parser, code);
    const exports = [];

    function hasVisibility(node) {
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child.type === 'visibility_modifier') {
                return true;
            }
        }
        return false;
    }

    traverseTreeCached(tree.rootNode, (node) => {
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
                        exports.push({
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
                exports.push({
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
                exports.push({
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
                exports.push({
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
                exports.push({
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
                exports.push({
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
                exports.push({
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
                exports.push({
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
                exports.push({
                    name: nameNode.text,
                    type: 'static',
                    line: node.startPosition.row + 1
                });
            }
            return true;
        }

        return true;
    });

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
            // not a call of Type
            else if (parent.type === 'scoped_identifier') {
                const grandparent = parent.parent;
                if (grandparent && grandparent.type === 'call_expression' &&
                    sameNode(grandparent.childForFieldName('function'), parent) &&
                    sameNode(parent.childForFieldName('name'), node)) {
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
                // Method call pattern: [obj] [.] [name] [()] inside macro
                if (idx >= 2) {
                    const dot = parent.child(idx - 1);
                    const obj = parent.child(idx - 2);
                    const next = parent.child(idx + 1);
                    if (dot && dot.text === '.' && obj &&
                        (obj.type === 'identifier' || obj.type === 'self')) {
                        if (next && next.type === 'token_tree' &&
                            next.childCount > 0 && next.child(0).text === '(') {
                            usageType = 'call';
                        }
                        usages.push({ line, column, usageType, receiver: obj.text });
                        return true;
                    }
                }
                // Bare function call pattern: [name] [()] inside macro
                if (idx >= 0) {
                    const next = parent.child(idx + 1);
                    // Check no preceding dot (would be method call handled above)
                    const prev = idx > 0 ? parent.child(idx - 1) : null;
                    if ((!prev || prev.text !== '.') &&
                        next && next.type === 'token_tree' &&
                        next.childCount > 0 && next.child(0).text === '(') {
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

        usages.push({ line, column, usageType });
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
    if (symbol.name === 'main') return 'main';
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
