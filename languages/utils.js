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
    for (let i = 0; i < node.namedChildCount; i++) {
        traverseTree(node.namedChild(i), callback, options);
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
    if (!paramsNode) return '...';
    const text = paramsNode.text;
    // Remove outer parens and trim
    return text.replace(/^\(|\)$/g, '').trim() || '...';
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
            // Also check for bare number/string/etc. children as defaults
            for (let i = 0; i < param.namedChildCount; i++) {
                const child = param.namedChild(i);
                if (child !== patternNode && child !== (typeNode && typeNode.parent === param ? typeNode : null) &&
                    child.type !== 'type_annotation' && child.type !== 'rest_pattern' &&
                    !['identifier', 'type_annotation'].includes(child.type)) {
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
        if (nameNode) info.name = nameNode.text;
        if (valueNode) info.default = valueNode.text;
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
        const firstLine = lines[commentStart].trim().replace(/^\/\/[\/!]\s?/, '');
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
        for (let i = 0; i < node.namedChildCount; i++) {
            collect(node.namedChild(i));
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
 * Clear the cached node list (call when the tree changes).
 */
function clearNodeListCache() {
    _cachedRootNode = null;
    _cachedNodeList = null;
    _cachedSubtreeEnds = null;
}

module.exports = {
    traverseTree,
    traverseTreeCached,
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
    getTokenTypeAtPosition,
    isMatchInCommentOrString,
    findMatchesWithASTFilter
};
