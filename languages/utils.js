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
function nodeToLocation(node, code) {
    const startLine = node.startPosition.row + 1;  // tree-sitter is 0-indexed
    const endLine = node.endPosition.row + 1;

    // Calculate indent from start of line
    const lines = code.split('\n');
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
        if (patternNode) info.name = patternNode.text;
        if (typeNode) info.type = typeNode.text.replace(/^:\s*/, '');
        if (param.type === 'optional_parameter') info.optional = true;
    } else if (param.type === 'rest_parameter') {
        const patternNode = param.childForFieldName('pattern');
        if (patternNode) info.name = patternNode.text;
        info.rest = true;
    } else if (param.type === 'assignment_pattern') {
        const leftNode = param.childForFieldName('left');
        const rightNode = param.childForFieldName('right');
        if (leftNode) info.name = leftNode.text;
        if (rightNode) info.default = rightNode.text;
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
        const nameNode = param.childForFieldName('name');
        const typeNode = param.childForFieldName('type');
        if (nameNode) info.name = nameNode.text;
        if (typeNode) info.type = typeNode.text;
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
function extractJSDocstring(code, startLine) {
    const lines = code.split('\n');
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
function extractPythonDocstring(code, defLine) {
    const lines = code.split('\n');
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
function extractGoDocstring(code, startLine) {
    const lines = code.split('\n');
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
function extractRustDocstring(code, startLine) {
    const lines = code.split('\n');
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
    const { PARSE_OPTIONS } = require('./index');
    const tree = parser.parse(content, undefined, PARSE_OPTIONS);
    const lines = content.split('\n');
    const matches = [];

    // Escape special regex characters and create pattern
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedTerm, 'gi');

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

module.exports = {
    traverseTree,
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
