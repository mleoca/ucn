/**
 * languages/utils.js - Shared tree-sitter AST utilities
 */

/**
 * Traverse tree-sitter AST depth-first
 * @param {object} node - Tree-sitter node
 * @param {function} callback - Called with each node, return false to stop traversal of children
 * @param {object} [options] - Optional traversal options
 * @param {function} [options.onLeave] - Called when leaving each node (after children processed)
 */
function traverseTree(node, callback, options) {
    if (callback(node) === false) return;
    // Single batched native call per node — namedChildCount + N × namedChild(i)
    // costs N+1 native round-trips for the same children.
    const children = node.namedChildren;
    for (let i = 0; i < children.length; i++) {
        traverseTree(children[i], callback, options);
    }
    if (options?.onLeave) {
        options.onLeave(node);
    }
}

/**
 * Get line locations from tree-sitter node
 * Returns 1-indexed lines to match UCN output format
 * @param {object} node - Tree-sitter node
 * @param {string} code - Original source code
 * @returns {{ startLine: number, endLine: number, indent: number }}
 */
function nodeToLocation(node, codeOrLines) {
    const startLine = node.startPosition.row + 1;  // tree-sitter is 0-indexed
    const endLine = node.endPosition.row + 1;

    // Calculate indent from start of line
    // Accept pre-split lines array to avoid repeated code.split('\n')
    const lines = Array.isArray(codeOrLines) ? codeOrLines : codeOrLines.split('\n');
    const firstLine = lines[node.startPosition.row] || '';
    const indentMatch = firstLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;

    return { startLine, endLine, indent };
}

/**
 * Extract parameter string from parameters node
 * @param {object} paramsNode - Tree-sitter parameters node
 * @returns {string}
 */
function extractParams(paramsNode) {
    // Distinguish "we have no node" (genuinely unknown) from "node is empty".
    // Returning '...' for empty parens caused signatures like `main(...)` for
    // functions that actually take zero arguments. Empty → '' so callers can
    // render `main()` cleanly.
    if (!paramsNode) return '...';
    const text = paramsNode.text;
    const stripped = text.replace(/^\(|\)$/g, '').trim();
    return stripped;  // '' for empty params, '...' only when paramsNode missing
}

/**
 * Parse parameters into structured format
 * @param {object} paramsNode - Tree-sitter parameters node
 * @param {string} language - Language name
 * @returns {Array<{name: string, type?: string, optional?: boolean, default?: string, rest?: boolean}>}
 */
function parseStructuredParams(paramsNode, language) {
    if (!paramsNode) return [];

    const params = [];

    for (let i = 0; i < paramsNode.namedChildCount; i++) {
        const param = paramsNode.namedChild(i);
        const paramInfo = {};

        // Different handling per language
        if (language === 'javascript' || language === 'typescript' || language === 'tsx') {
            parseJSParam(param, paramInfo);
        } else if (language === 'python') {
            parsePythonParam(param, paramInfo);
        } else if (language === 'go') {
            parseGoParam(param, paramInfo);
        } else if (language === 'rust') {
            parseRustParam(param, paramInfo);
        } else if (language === 'java') {
            parseJavaParam(param, paramInfo);
        }

        if (paramInfo.name) {
            params.push(paramInfo);
            // Go multi-name declarations: `a, b int` → expand additional params
            if (paramInfo._additionalNames) {
                for (const extraName of paramInfo._additionalNames) {
                    params.push({ name: extraName, type: paramInfo.type });
                }
                delete paramInfo._additionalNames;
            }
        }
    }

    return params;
}

function parseJSParam(param, info) {
    if (param.type === 'identifier') {
        info.name = param.text;
    } else if (param.type === 'required_parameter' || param.type === 'optional_parameter') {
        const patternNode = param.childForFieldName('pattern');
        const typeNode = param.childForFieldName('type');
        if (patternNode) {
            // Check if pattern is a rest_pattern (e.g., ...args inside required_parameter)
            if (patternNode.type === 'rest_pattern') {
                const innerName = patternNode.namedChild(0);
                info.name = innerName ? innerName.text : patternNode.text.replace(/^\.\.\./, '');
                info.rest = true;
            } else {
                info.name = patternNode.text;
            }
        }
        if (typeNode) info.type = typeNode.text.replace(/^:\s*/, '');
        if (param.type === 'optional_parameter') info.optional = true;
        // Check for default value (e.g., priority: number = 1)
        const valueNode = param.childForFieldName('value');
        if (valueNode) {
            info.default = valueNode.text;
            info.optional = true;
        } else if (!info.rest) {
            // Also check for bare number/string/etc. children as defaults.
            // TS parameter-property modifiers (private/protected/public/
            // readonly/override) and parameter decorators (@Inject()) are
            // NOT defaults (fix #230 — `constructor(protected config:
            // Config)` used to report default 'protected', optional true,
            // wrecking expectedArgs.min and the signature display).
            const NON_DEFAULT_PARAM_CHILDREN = new Set([
                'identifier', 'type_annotation', 'rest_pattern',
                'accessibility_modifier', 'override_modifier', 'readonly', 'decorator',
            ]);
            for (let i = 0; i < param.namedChildCount; i++) {
                const child = param.namedChild(i);
                if (child !== patternNode && child !== (typeNode && typeNode.parent === param ? typeNode : null) &&
                    !NON_DEFAULT_PARAM_CHILDREN.has(child.type)) {
                    // This is likely a default value node
                    info.default = child.text;
                    info.optional = true;
                    break;
                }
            }
        }
    } else if (param.type === 'rest_parameter' || param.type === 'rest_pattern') {
        // rest_parameter = TypeScript, rest_pattern = JavaScript
        const patternNode = param.childForFieldName('pattern') || param.namedChild(0);
        if (patternNode) info.name = patternNode.text;
        info.rest = true;
    } else if (param.type === 'assignment_pattern') {
        const leftNode = param.childForFieldName('left');
        const rightNode = param.childForFieldName('right');
        if (leftNode) info.name = leftNode.text;
        if (rightNode) info.default = rightNode.text;
    } else if (param.type === 'object_pattern' || param.type === 'array_pattern') {
        // Destructured params: { name, value } or [a, b]
        info.name = param.text;
    }
}

function parsePythonParam(param, info) {
    if (param.type === 'identifier') {
        info.name = param.text;
    } else if (param.type === 'typed_parameter') {
        const nameNode = param.namedChild(0);
        const typeNode = param.childForFieldName('type');
        if (nameNode) info.name = nameNode.text;
        if (typeNode) info.type = typeNode.text;
    } else if (param.type === 'default_parameter' || param.type === 'typed_default_parameter') {
        const nameNode = param.childForFieldName('name');
        const valueNode = param.childForFieldName('value');
        const typeNode = param.childForFieldName('type');
        if (nameNode) info.name = nameNode.text;
        if (valueNode) info.default = valueNode.text;
        if (typeNode) info.type = typeNode.text;
        info.optional = true;
    } else if (param.type === 'list_splat_pattern' || param.type === 'dictionary_splat_pattern') {
        info.name = param.text;
        info.rest = true;
    }
}

function parseGoParam(param, info) {
    if (param.type === 'parameter_declaration') {
        const typeNode = param.childForFieldName('type');
        // Go allows multiple names per declaration: `a, b int`
        // Collect all identifier children (names come before the type)
        const names = [];
        for (let i = 0; i < param.namedChildCount; i++) {
            const child = param.namedChild(i);
            if (child && child.type === 'identifier') {
                names.push(child.text);
            }
        }
        if (names.length > 0) info.name = names[0];
        if (typeNode) info.type = typeNode.text;
        // Store additional names for multi-param declarations (handled by parseStructuredParams)
        if (names.length > 1) {
            info._additionalNames = names.slice(1);
        }
    } else if (param.type === 'variadic_parameter_declaration') {
        // Go variadic: `args ...int`
        const nameNode = param.childForFieldName('name');
        const typeNode = param.childForFieldName('type');
        if (nameNode) info.name = nameNode.text;
        else info.name = '...';
        if (typeNode) info.type = '...' + typeNode.text;
        info.rest = true;
    }
}

function parseRustParam(param, info) {
    if (param.type === 'parameter') {
        const patternNode = param.childForFieldName('pattern');
        const typeNode = param.childForFieldName('type');
        if (patternNode) info.name = patternNode.text;
        if (typeNode) info.type = typeNode.text;
    } else if (param.type === 'self_parameter') {
        info.name = param.text;
    }
}

function parseJavaParam(param, info) {
    if (param.type === 'formal_parameter' || param.type === 'spread_parameter') {
        let nameNode = param.childForFieldName('name');
        const typeNode = param.childForFieldName('type');
        // Java varargs: spread_parameter wraps name in variable_declarator
        // e.g., `String... args` → spread_parameter > variable_declarator > identifier
        if (!nameNode && param.type === 'spread_parameter') {
            for (let i = 0; i < param.namedChildCount; i++) {
                const child = param.namedChild(i);
                if (child.type === 'variable_declarator') {
                    nameNode = child.childForFieldName('name');
                    break;
                }
            }
        }
        if (nameNode) info.name = nameNode.text;
        if (typeNode) info.type = typeNode.text;
        if (param.type === 'spread_parameter') info.rest = true;
    }
}

/**
 * Extract JSDoc docstring from JavaScript/TypeScript code
 * Looks for /** ... *\/ comment block above the given line
 * @param {string} code - Source code
 * @param {number} startLine - 1-indexed line number of the function/class
 * @returns {string|null} First line of docstring or null
 */
function extractJSDocstring(codeOrLines, startLine) {
    const lines = Array.isArray(codeOrLines) ? codeOrLines : codeOrLines.split('\n');
    const lineIndex = startLine - 1;
    if (lineIndex <= 0) return null;

    // Scan upward, skipping empty lines and decorators
    let i = lineIndex - 1;
    while (i >= 0 && (lines[i].trim() === '' || lines[i].trim().startsWith('@'))) {
        i--;
    }
    if (i < 0) return null;

    // Check if this line ends with */ (end of JSDoc)
    const trimmed = lines[i].trim();
    if (trimmed.endsWith('*/')) {
        // Find the start of the JSDoc block
        let docEnd = i;
        while (i >= 0 && !lines[i].includes('/**')) {
            i--;
        }
        if (i < 0 || !lines[i].includes('/**')) return null;

        // Extract the first meaningful line from the JSDoc
        for (let j = i; j <= docEnd; j++) {
            const line = lines[j]
                .replace(/^\s*\/\*\*\s*/, '')  // Remove /** at start
                .replace(/\s*\*\/\s*$/, '')    // Remove */ at end
                .replace(/^\s*\*\s?/, '')      // Remove leading *
                .trim();
            // Skip empty lines and @param/@returns tags
            if (line && !line.startsWith('@')) {
                return line;
            }
        }
    }
    return null;
}

/**
 * Extract Python docstring from code
 * Looks for """...""" or '''...''' as first statement after def/class
 * @param {string} code - Source code
 * @param {number} defLine - 1-indexed line number of the def/class (not decorator)
 * @returns {string|null} First line of docstring or null
 */
function extractPythonDocstring(codeOrLines, defLine) {
    const lines = Array.isArray(codeOrLines) ? codeOrLines : codeOrLines.split('\n');
    // Python docstring is INSIDE the function, on lines after the def:
    let i = defLine; // Start after the def line (defLine is 1-indexed)
    // Skip to find the first non-empty line inside the function
    while (i < lines.length && lines[i].trim() === '') {
        i++;
    }
    if (i >= lines.length) return null;

    const trimmed = lines[i].trim();
    // Check for triple-quoted string
    if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
        const quote = trimmed.startsWith('"""') ? '"""' : "'''";
        // Single-line docstring
        if (trimmed.endsWith(quote) && trimmed.length > 6) {
            return trimmed.slice(3, -3).trim();
        }
        // Multi-line docstring: return first line
        const firstLine = trimmed.slice(3).trim();
        if (firstLine) return firstLine;
        // First line was just quotes, get next line
        if (i + 1 < lines.length) {
            return lines[i + 1].trim();
        }
    }
    return null;
}

/**
 * Extract Go documentation comment from code
 * Looks for // comments directly above the func
 * @param {string} code - Source code
 * @param {number} startLine - 1-indexed line number of the function
 * @returns {string|null} First line of doc comment or null
 */
function extractGoDocstring(codeOrLines, startLine) {
    const lines = Array.isArray(codeOrLines) ? codeOrLines : codeOrLines.split('\n');
    const lineIndex = startLine - 1;
    if (lineIndex <= 0) return null;

    // Scan upward, skipping empty lines
    let i = lineIndex - 1;
    while (i >= 0 && lines[i].trim() === '') {
        i--;
    }
    if (i < 0) return null;

    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//')) {
        // Find the start of the comment block
        let commentStart = i;
        while (commentStart > 0 && lines[commentStart - 1].trim().startsWith('//')) {
            commentStart--;
        }
        // Return first line of comment block
        const firstLine = lines[commentStart].trim().replace(/^\/\/\s?/, '');
        if (firstLine) return firstLine;
    }
    return null;
}

/**
 * Extract Rust documentation comment from code
 * Looks for /// or //! comments directly above the item
 * @param {string} code - Source code
 * @param {number} startLine - 1-indexed line number of the item
 * @returns {string|null} First line of doc comment or null
 */
function extractRustDocstring(codeOrLines, startLine) {
    const lines = Array.isArray(codeOrLines) ? codeOrLines : codeOrLines.split('\n');
    const lineIndex = startLine - 1;
    if (lineIndex <= 0) return null;

    // Scan upward, skipping empty lines and attributes (#[...])
    let i = lineIndex - 1;
    while (i >= 0 && (lines[i].trim() === '' || lines[i].trim().startsWith('#['))) {
        i--;
    }
    if (i < 0) return null;

    const trimmed = lines[i].trim();
    if (trimmed.startsWith('///') || trimmed.startsWith('//!')) {
        // Find the start of the doc comment block
        let commentStart = i;
        while (commentStart > 0 &&
               (lines[commentStart - 1].trim().startsWith('///') ||
                lines[commentStart - 1].trim().startsWith('//!'))) {
            commentStart--;
        }
        // Return first line of comment block
        const firstLine = lines[commentStart].trim().replace(/^\/\/[/!]\s?/, '');
        if (firstLine) return firstLine;
    }
    return null;
}

/**
 * Extract Java Javadoc comment from code
 * Looks for /** ... *\/ comment block above the method/class
 * @param {string} code - Source code
 * @param {number} startLine - 1-indexed line number of the method/class
 * @returns {string|null} First line of docstring or null
 */
function extractJavaDocstring(code, startLine) {
    // Java uses same format as JS - /** ... */
    return extractJSDocstring(code, startLine);
}

/**
 * Build a paramTypes map from a structured-params array.
 * Skips entries without a `type`. Preserves the structured order via plain object.
 * @param {Array<{name: string, type?: string}>} paramsStructured
 * @returns {Object<string,string>|null} map { paramName: typeString } or null if empty
 */
function paramTypesFromStructured(paramsStructured) {
    if (!Array.isArray(paramsStructured) || paramsStructured.length === 0) return null;
    const map = {};
    let any = false;
    for (const p of paramsStructured) {
        if (p && p.name && p.type) {
            map[p.name] = p.type;
            any = true;
        }
    }
    return any ? map : null;
}

/**
 * Parse @param and @returns/@return tags from a JSDoc block above the given line.
 * Returns { paramTypes, returnType } where paramTypes is { name: type } and
 * returnType is a string, both possibly omitted if not present.
 *
 * Tag forms supported:
 *   @param {Type} name           - typed param
 *   @param {Type} name - desc    - typed param with description
 *   @returns {Type} desc         - return type (also @return)
 * Untyped @param tags are ignored.
 *
 * @param {string|string[]} codeOrLines
 * @param {number} startLine - 1-indexed line of the function/method declaration
 * @returns {{ paramTypes?: Object, returnType?: string }}
 */
function parseJSDocTags(codeOrLines, startLine) {
    const lines = Array.isArray(codeOrLines) ? codeOrLines : codeOrLines.split('\n');
    const lineIndex = startLine - 1;
    if (lineIndex <= 0) return {};

    // Walk up past blank lines and decorators to find a JSDoc end line `*/`
    let i = lineIndex - 1;
    while (i >= 0 && (lines[i].trim() === '' || lines[i].trim().startsWith('@'))) {
        i--;
    }
    if (i < 0) return {};
    if (!lines[i].trim().endsWith('*/')) return {};

    const docEnd = i;
    while (i >= 0 && !lines[i].includes('/**')) {
        i--;
    }
    if (i < 0) return {};

    // Collect block text lines, stripping leading `*` and surrounding whitespace
    const blockLines = [];
    for (let j = i; j <= docEnd; j++) {
        const line = lines[j]
            .replace(/^\s*\/\*\*\s?/, '')
            .replace(/\s*\*\/\s*$/, '')
            .replace(/^\s*\*\s?/, '');
        blockLines.push(line);
    }
    const block = blockLines.join('\n');

    // @param {Type} name — balanced-brace scan so nested types survive
    // (e.g. `{{ ok: boolean, error?: string }}` or `{Object<string, {x: number}>}`)
    const paramTypes = {};
    let any = false;
    const paramTagRegex = /@param\s+/g;
    let m;
    while ((m = paramTagRegex.exec(block)) !== null) {
        const braced = extractBracedType(block, m.index + m[0].length);
        if (!braced) continue;
        // Name follows the closing brace: plain `name` or optional `[name]` / `[name=default]`
        const rest = block.slice(braced.endIdx);
        const nameMatch = rest.match(/^\s+(?:\[([A-Za-z_$][\w$]*)(?:\s*=[^\]]*)?\]|([A-Za-z_$][\w$]*))/);
        if (!nameMatch) continue;
        const name = nameMatch[1] || nameMatch[2];
        paramTypes[name] = braced.type.trim().replace(/\s+/g, ' ');
        any = true;
    }

    // @returns {Type} or @return {Type}
    const retTag = block.match(/@returns?\s+/);
    const retBraced = retTag ? extractBracedType(block, retTag.index + retTag[0].length) : null;
    const result = {};
    if (any) result.paramTypes = paramTypes;
    if (retBraced) result.returnType = retBraced.type.trim().replace(/\s+/g, ' ');
    return result;
}

/**
 * Extract a balanced-brace type expression starting at an opening `{`.
 * Returns the inner text (without the outer braces) and the index just past
 * the matching closing brace, or null when text[openIdx] is not `{` or the
 * braces never balance.
 * @param {string} text
 * @param {number} openIdx - index expected to hold the opening `{`
 * @returns {{ type: string, endIdx: number }|null}
 */
function extractBracedType(text, openIdx) {
    if (text[openIdx] !== '{') return null;
    let depth = 0;
    for (let k = openIdx; k < text.length; k++) {
        const ch = text[k];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return { type: text.slice(openIdx + 1, k), endIdx: k + 1 };
        }
    }
    return null;
}

/**
 * Compute the final paramTypes/returnType for a function symbol.
 * Native AST types take precedence; JSDoc fills gaps.
 * @param {Array} paramsStructured - parser output
 * @param {string|null} nativeReturnType - return type extracted from AST (TS/Py)
 * @param {string|string[]} codeOrLines - source for JSDoc lookup
 * @param {number} startLine - function start line
 * @param {boolean} useJSDoc - whether to consult JSDoc (true for JS/TS, false for Py)
 * @returns {{ paramTypes?: Object, returnType?: string }}
 */
function buildTypeAnnotations(paramsStructured, nativeReturnType, codeOrLines, startLine, useJSDoc) {
    const native = paramTypesFromStructured(paramsStructured);
    let jsdoc = {};
    if (useJSDoc) jsdoc = parseJSDocTags(codeOrLines, startLine);

    const out = {};
    // Merge: JSDoc first, native overrides
    if (jsdoc.paramTypes || native) {
        const merged = { ...(jsdoc.paramTypes || {}), ...(native || {}) };
        if (Object.keys(merged).length > 0) out.paramTypes = merged;
    }
    const rt = nativeReturnType || jsdoc.returnType;
    if (rt) out.returnType = rt;
    return out;
}

/**
 * Get the token type at a specific position using AST
 * @param {object} rootNode - Tree-sitter root node
 * @param {number} line - 1-indexed line number
 * @param {number} column - 0-indexed column number
 * @returns {string} Token type: 'comment', 'string', or 'code'
 */
function getTokenTypeAtPosition(rootNode, line, column) {
    // Convert to 0-indexed row for tree-sitter
    const row = line - 1;

    // Find the smallest node at this position
    const node = rootNode.descendantForPosition({ row, column });
    if (!node) return 'code';

    // Walk up the tree to check if we're in a comment or string
    let current = node;
    while (current) {
        const type = current.type;

        // Comment types across languages
        if (type === 'comment' ||
            type === 'line_comment' ||
            type === 'block_comment' ||
            type === 'doc_comment' ||
            type === 'documentation_comment') {
            return 'comment';
        }

        // String types across languages
        if (type === 'string' ||
            type === 'string_literal' ||
            type === 'template_string' ||
            type === 'template_literal' ||
            type === 'raw_string_literal' ||
            type === 'interpreted_string_literal' ||
            type === 'concatenated_string') {
            return 'string';
        }

        // For template strings, check if we're in the literal part vs expression
        if (type === 'template_substitution' || type === 'interpolation') {
            // Inside ${...}, this is code
            return 'code';
        }

        current = current.parent;
    }

    return 'code';
}

/**
 * Check if a match at a specific position is inside a comment or string
 * @param {object} rootNode - Tree-sitter root node
 * @param {number} line - 1-indexed line number
 * @param {string} lineContent - The line content
 * @param {string} term - The search term
 * @returns {boolean} True if the match is in a comment or string
 */
function isMatchInCommentOrString(rootNode, line, lineContent, term) {
    // Find where the term appears in the line
    const termLower = term.toLowerCase();
    const lineLower = lineContent.toLowerCase();
    const index = lineLower.indexOf(termLower);

    if (index === -1) return false;

    // Check the token type at the match position
    const tokenType = getTokenTypeAtPosition(rootNode, line, index);
    return tokenType === 'comment' || tokenType === 'string';
}

/**
 * Find all matches of a term in a file, filtering by token type
 * @param {string} content - File content
 * @param {string} term - Search term
 * @param {object} parser - Tree-sitter parser
 * @param {object} options - { codeOnly: boolean }
 * @returns {Array<{line: number, content: string, column: number}>}
 */
function findMatchesWithASTFilter(content, term, parser, options = {}) {
    const { safeParse } = require('./index');
    const tree = safeParse(parser, content);
    const lines = content.split('\n');
    const matches = [];

    // Default: regex mode ON. Use raw pattern unless regex=false.
    let regex;
    if (options.regex !== false) {
        try { regex = new RegExp(term, 'gi'); } catch (e) { regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); }
    } else {
        regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    }

    lines.forEach((line, idx) => {
        const lineNum = idx + 1;
        let match;

        // Reset regex for each line
        regex.lastIndex = 0;

        while ((match = regex.exec(line)) !== null) {
            const column = match.index;

            if (options.codeOnly) {
                const tokenType = getTokenTypeAtPosition(tree.rootNode, lineNum, column);
                if (tokenType !== 'code') {
                    continue; // Skip comments and strings
                }
            }

            // Check if we already added this line (avoid duplicates)
            if (!matches.some(m => m.line === lineNum)) {
                matches.push({
                    line: lineNum,
                    content: line,
                    column
                });
            }
        }
    });

    return matches;
}

/**
 * Single-entry cache for flat node lists.
 * During indexFile(), the same tree is traversed 5+ times (findFunctions,
 * findClasses, findStateObjects, findImports, findExports). Building a flat
 * list once and iterating it for each pass eliminates repeated recursive
 * traversal overhead (namedChild object creation, function call overhead).
 */
let _cachedRootNode = null;
let _cachedNodeList = null;
let _cachedSubtreeEnds = null;

function _buildNodeList(rootNode) {
    const nodes = [];
    const subtreeEnds = [];
    const stack = [rootNode];
    // Iterative DFS with subtreeEnd tracking
    // We use a post-processing step to fill subtreeEnds
    function collect(node) {
        const idx = nodes.length;
        nodes.push(node);
        subtreeEnds.push(0);
        // Batched children read — one native call instead of N+1 (see traverseTree)
        const children = node.namedChildren;
        for (let i = 0; i < children.length; i++) {
            collect(children[i]);
        }
        subtreeEnds[idx] = nodes.length;
    }
    collect(rootNode);
    return { nodes, subtreeEnds };
}

/**
 * Get or build a cached flat node list for the given tree.
 * Returns { nodes: SyntaxNode[], subtreeEnds: number[] }.
 * subtreeEnds[i] is the index past the last descendant of nodes[i],
 * enabling O(1) subtree skipping (for 'return false' semantics).
 */
function getCachedNodeList(rootNode) {
    if (rootNode === _cachedRootNode && _cachedNodeList) {
        return { nodes: _cachedNodeList, subtreeEnds: _cachedSubtreeEnds };
    }
    const { nodes, subtreeEnds } = _buildNodeList(rootNode);
    _cachedRootNode = rootNode;
    _cachedNodeList = nodes;
    _cachedSubtreeEnds = subtreeEnds;
    return { nodes, subtreeEnds };
}

/**
 * Traverse a tree-sitter AST using a cached flat node list.
 * Semantically equivalent to traverseTree() but ~3x faster when the same
 * tree is traversed multiple times (which happens 5+ times per file during build).
 * Supports 'return false' to skip a node's entire subtree.
 *
 * NOTE: Does not support onLeave callbacks. Use traverseTree() for those.
 */
function traverseTreeCached(rootNode, callback) {
    const { nodes, subtreeEnds } = getCachedNodeList(rootNode);
    for (let i = 0; i < nodes.length; ) {
        if (callback(nodes[i]) === false) {
            i = subtreeEnds[i];
        } else {
            i++;
        }
    }
}

/**
 * Visit the AST node covering each whole-word text occurrence of `name`.
 *
 * Equivalent to a full-tree walk whose callback filters on
 * `node.text === name` token types — but O(occurrences) instead of
 * O(nodes): the source string locates candidate offsets (indexOf + ASCII
 * word-boundary pre-check), and descendantForIndex jumps straight to the
 * deepest node spanning each. The callback receives the identifier-style
 * token when the occurrence is code, or a string/comment/longer-identifier
 * token otherwise — callers' existing type/text guards skip those, so
 * false-positive candidates are safe and false negatives are impossible
 * (a token equal to `name` cannot have identifier characters adjacent,
 * or the token would extend past the name).
 *
 * node-tree-sitter indexes are UTF-16 code units, same as JS string
 * offsets — unicode content needs no special handling.
 */
function visitNameNodes(tree, code, name, callback) {
    const isWordCode = (c) =>
        (c >= 48 && c <= 57) || (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) || c === 95 || c === 36; // [0-9A-Za-z_$]
    const len = name.length;
    let idx = code.indexOf(name);
    while (idx !== -1) {
        if ((idx === 0 || !isWordCode(code.charCodeAt(idx - 1))) &&
            (idx + len >= code.length || !isWordCode(code.charCodeAt(idx + len)))) {
            const node = tree.rootNode.descendantForIndex(idx);
            if (node) callback(node);
        }
        idx = code.indexOf(name, idx + len);
    }
}

/**
 * Clear the cached node list (call when the tree changes).
 */
function clearNodeListCache() {
    _cachedRootNode = null;
    _cachedNodeList = null;
    _cachedSubtreeEnds = null;
}

/**
 * Extract a string value from a tree-sitter argument node, returning
 * `{ value, interp }` where:
 *   - value is the literal portion (with quotes stripped)
 *   - interp is true when the argument is interpolated (template literal,
 *     f-string, format!() macro, fmt.Sprintf), in which case `value` is the
 *     literal *prefix* before the first interpolation, suffixed with '*'.
 *
 * Returns null when the node isn't a string-like value.
 *
 * Used by route extraction: server `app.get('/users/:id')` → '/users/:id';
 * client `fetch(\`/users/${id}\`)` → '/users/*' (interp).
 *
 * @param {object} node - Tree-sitter node (any language)
 * @returns {{ value: string, interp: boolean }|null}
 */
function extractStringArg(node) {
    if (!node) return null;
    const t = node.type;

    // JS/TS string literals
    if (t === 'string') {
        const text = node.text;
        return { value: stripQuotes(text), interp: false };
    }

    // JS/TS template literal: `/users/${id}` or plain `/users/all`
    if (t === 'template_string' || t === 'template_literal') {
        return parseTemplateLiteral(node);
    }

    // Python string
    if (t === 'string') {
        return { value: stripQuotes(node.text), interp: false };
    }

    // Python concatenated strings: 'a' 'b' → 'ab'
    if (t === 'concatenated_string') {
        let acc = '';
        let interp = false;
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            const r = extractStringArg(child);
            if (r) {
                acc += r.value;
                if (r.interp) { interp = true; break; }
            } else {
                interp = true;
                break;
            }
        }
        return { value: acc, interp };
    }

    // Go interpreted/raw string
    if (t === 'interpreted_string_literal' || t === 'raw_string_literal') {
        return { value: stripQuotes(node.text), interp: false };
    }

    // Java string literal / text block
    if (t === 'string_literal' || t === 'text_block') {
        return { value: stripQuotes(node.text), interp: false };
    }

    // Rust string literal: "..." or raw r"..." / r#"..."#
    if (t === 'string_literal') {
        return { value: stripRustString(node.text), interp: false };
    }
    if (t === 'raw_string_literal') {
        return { value: stripRustString(node.text), interp: false };
    }

    // Rust macro_invocation: format!("/users/{}", id), format!("/path") → extract first string arg
    if (t === 'macro_invocation') {
        const argsNode = node.childForFieldName('arguments');
        if (!argsNode) return null;
        // Find first string-like child of token_tree
        const first = findFirstStringInRustMacro(argsNode);
        if (first == null) return null;
        // Detect interpolation by presence of `{}` or `{...}` placeholders or extra args
        const hasPlaceholder = /\{[^}]*\}/.test(first);
        // Truncate at first placeholder
        const m = first.match(/^([^{]*)/);
        return { value: (m ? m[1] : first), interp: hasPlaceholder };
    }

    return null;
}

/** Strip surrounding quotes (' " `) from a literal, leaving the inner content. */
function stripQuotes(text) {
    if (typeof text !== 'string' || text.length < 2) return text;
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' || first === "'" || first === '`') && first === last) {
        return text.slice(1, -1);
    }
    return text;
}

/** Strip Rust string literal quoting: "..." or r"..." or r#"..."# etc. */
function stripRustString(text) {
    if (typeof text !== 'string') return text;
    // r#"..."# (any number of #)
    const rawHash = text.match(/^r(#+)"([\s\S]*)"\1$/);
    if (rawHash) return rawHash[2];
    // r"..."
    const raw = text.match(/^r"([\s\S]*)"$/);
    if (raw) return raw[1];
    // "..."
    if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
    return text;
}

/**
 * Parse a JS template literal AST node and return literal prefix + interp flag.
 * `/users/all` → { value: '/users/all', interp: false }
 * `/users/${id}` → { value: '/users/*', interp: true }
 */
function parseTemplateLiteral(node) {
    let prefix = '';
    let interp = false;
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        // template_substitution = ${...}
        if (child.type === 'template_substitution') {
            interp = true;
            break;
        }
        // string_fragment / template_chars: literal segment
        if (child.type === 'string_fragment' || child.type === 'template_chars') {
            prefix += child.text;
        }
    }
    if (interp && !prefix.endsWith('*')) prefix += '*';
    return { value: prefix, interp };
}

/** Find the first quoted string inside a Rust macro_invocation token_tree. */
function findFirstStringInRustMacro(tokenTree) {
    if (!tokenTree) return null;
    for (let i = 0; i < tokenTree.namedChildCount; i++) {
        const child = tokenTree.namedChild(i);
        if (child.type === 'string_literal' || child.type === 'raw_string_literal') {
            return stripRustString(child.text);
        }
        // Recurse into nested token_trees (rare)
        if (child.namedChildCount > 0) {
            const r = findFirstStringInRustMacro(child);
            if (r != null) return r;
        }
    }
    // Fallback: scan raw text for first quoted string
    const m = tokenTree.text.match(/"([^"\\]|\\.)*"/);
    if (m) {
        const raw = m[0];
        return raw.slice(1, -1);
    }
    return null;
}

/**
 * Extract path/method from a fmt.Sprintf("...", args) call inside Go.
 * Returns the literal prefix before the first %v/%s/%d etc. with '*' suffix.
 */
function extractSprintfPrefix(callNode) {
    // call_expression with function = selector_expression "fmt.Sprintf"
    const argsNode = callNode.childForFieldName('arguments');
    if (!argsNode) return null;
    const first = argsNode.namedChildCount > 0 ? argsNode.namedChild(0) : null;
    if (!first) return null;
    const r = extractStringArg(first);
    if (!r) return null;
    // Find first format directive %x and truncate
    const m = r.value.match(/^([^%]*)/);
    const literal = m ? m[1] : r.value;
    const hasFmt = /%/.test(r.value);
    return { value: hasFmt ? (literal + '*') : literal, interp: hasFmt };
}


/**
 * Stable node equality (fix #233): tree-sitter node WRAPPERS are not
 * reference-stable — `parent.child(i) === node` can return false for the
 * same underlying node once a tree has been walked by an earlier operation
 * (the CI macro-flake root cause: assert_eq!-wrapped calls flipped
 * 'call'→'reference' on the second index build in a process because
 * _indexInParent returned -1). `.id` is node-tree-sitter's stable native
 * node identity — compare that, never the wrapper reference.
 */
function sameNode(a, b) {
    return !!a && !!b && (a === b || a.id === b.id);
}

module.exports = {
    sameNode,
    traverseTree,
    traverseTreeCached,
    visitNameNodes,
    getCachedNodeList,
    clearNodeListCache,
    nodeToLocation,
    extractParams,
    parseStructuredParams,
    extractJSDocstring,
    extractPythonDocstring,
    extractGoDocstring,
    extractRustDocstring,
    extractJavaDocstring,
    paramTypesFromStructured,
    parseJSDocTags,
    buildTypeAnnotations,
    getTokenTypeAtPosition,
    isMatchInCommentOrString,
    findMatchesWithASTFilter,
    extractStringArg,
    stripQuotes,
    extractSprintfPrefix,
};
