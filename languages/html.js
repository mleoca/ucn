/**
 * languages/html.js - HTML file support via inline <script> extraction
 *
 * Parses HTML with tree-sitter-html, extracts inline JavaScript from <script> blocks,
 * builds a line-preserving virtual JS string, and delegates to javascript.js for analysis.
 * Line numbers are automatically correct because the virtual JS has the same line count
 * as the original HTML file, with empty lines for non-script content.
 */

const { getParser, getLanguageModule } = require('./index');

// Script type values that indicate JavaScript content
const JS_TYPES = new Set([
    'text/javascript',
    'application/javascript',
    'module',
    ''
]);

/**
 * Extract inline script blocks from HTML using tree-sitter-html AST.
 * Skips external scripts (src=...) and non-JS types (application/json, importmap, etc.).
 *
 * @param {string} htmlContent - Raw HTML source
 * @param {object} htmlParser - tree-sitter parser configured for HTML
 * @returns {Array<{text: string, startRow: number, startCol: number}>}
 */
function extractScriptBlocks(htmlContent, htmlParser) {
    const { safeParse, getParseOptions } = require('./index');
    const tree = safeParse(htmlParser, htmlContent, undefined, getParseOptions(htmlContent.length));
    const blocks = [];

    // Walk the AST looking for script_element nodes
    const visit = (node) => {
        if (node.type === 'script_element') {
            const startTag = node.childForFieldName('start_tag') ||
                node.children.find(c => c.type === 'start_tag');
            const rawText = node.children.find(c => c.type === 'raw_text');

            if (!startTag || !rawText || !rawText.text) return;

            // Check attributes on start_tag
            let hasSrc = false;
            let typeValue = null;

            for (let i = 0; i < startTag.childCount; i++) {
                const attr = startTag.child(i);
                if (attr.type !== 'attribute') continue;

                const nameNode = attr.children.find(c => c.type === 'attribute_name');
                if (!nameNode) continue;
                const attrName = nameNode.text.toLowerCase();

                if (attrName === 'src') {
                    hasSrc = true;
                    break;
                }

                if (attrName === 'type') {
                    const valueNode = attr.children.find(c =>
                        c.type === 'quoted_attribute_value' || c.type === 'attribute_value'
                    );
                    if (valueNode) {
                        // Extract value text - strip quotes if quoted_attribute_value
                        const innerValue = valueNode.type === 'quoted_attribute_value'
                            ? valueNode.children.find(c => c.type === 'attribute_value')
                            : valueNode;
                        typeValue = innerValue ? innerValue.text.toLowerCase().trim() : '';
                    } else {
                        typeValue = '';
                    }
                }
            }

            // Skip external scripts
            if (hasSrc) return;

            // Skip non-JS types
            if (typeValue !== null && !JS_TYPES.has(typeValue)) return;

            blocks.push({
                text: rawText.text,
                startRow: rawText.startPosition.row,
                startCol: rawText.startPosition.column
            });
            return; // Don't recurse into script_element children
        }

        for (let i = 0; i < node.childCount; i++) {
            visit(node.child(i));
        }
    };

    visit(tree.rootNode);
    return blocks;
}

/**
 * Build a virtual JS string with the same line count as the HTML file.
 * Script block lines are placed at their original positions; everything else is empty.
 * The first line of each block is padded with spaces to match its column offset.
 *
 * @param {string} htmlContent - Raw HTML source
 * @param {Array<{text: string, startRow: number, startCol: number}>} blocks
 * @returns {string}
 */
function buildVirtualJSContent(htmlContent, blocks) {
    const totalLines = htmlContent.split('\n').length;
    const lines = new Array(totalLines).fill('');

    for (const block of blocks) {
        const blockLines = block.text.split('\n');
        for (let i = 0; i < blockLines.length; i++) {
            const row = block.startRow + i;
            if (row >= totalLines) break;
            if (i === 0 && block.startCol > 0) {
                // Pad first line to match column offset
                lines[row] = ' '.repeat(block.startCol) + blockLines[i];
            } else {
                lines[row] = blockLines[i];
            }
        }
    }

    return lines.join('\n');
}

/**
 * Extract JavaScript from HTML and prepare for JS parsing.
 * Returns null if no inline scripts found.
 *
 * @param {string} htmlContent - Raw HTML source
 * @param {object} htmlParser - tree-sitter parser configured for HTML
 * @returns {{virtualJS: string, jsParser: object, jsModule: object}|null}
 */
function extractJS(htmlContent, htmlParser) {
    const blocks = extractScriptBlocks(htmlContent, htmlParser);
    if (blocks.length === 0) return null;

    const virtualJS = buildVirtualJSContent(htmlContent, blocks);
    const jsParser = getParser('javascript');
    const jsModule = getLanguageModule('javascript');

    return { virtualJS, jsParser, jsModule };
}

// ── Exported language module interface ──────────────────────────────────────

function parse(code, parser) {
    const result = extractJS(code, parser);
    if (!result) {
        return {
            language: 'html',
            totalLines: code.split('\n').length,
            functions: [],
            classes: [],
            stateObjects: [],
            imports: [],
            exports: []
        };
    }

    const jsResult = result.jsModule.parse(result.virtualJS, result.jsParser);
    jsResult.language = 'html';
    jsResult.totalLines = code.split('\n').length;
    return jsResult;
}

function findFunctions(code, parser) {
    const result = extractJS(code, parser);
    if (!result) return [];
    return result.jsModule.findFunctions(result.virtualJS, result.jsParser);
}

function findClasses(code, parser) {
    const result = extractJS(code, parser);
    if (!result) return [];
    return result.jsModule.findClasses(result.virtualJS, result.jsParser);
}

function findStateObjects(code, parser) {
    const result = extractJS(code, parser);
    if (!result) return [];
    return result.jsModule.findStateObjects(result.virtualJS, result.jsParser);
}

function findCallsInCode(code, parser) {
    const result = extractJS(code, parser);
    if (!result) return [];
    return result.jsModule.findCallsInCode(result.virtualJS, result.jsParser);
}

function findCallbackUsages(code, name, parser) {
    const result = extractJS(code, parser);
    if (!result) return [];
    return result.jsModule.findCallbackUsages(result.virtualJS, name, result.jsParser);
}

function findReExports(code, parser) {
    const result = extractJS(code, parser);
    if (!result) return [];
    return result.jsModule.findReExports(result.virtualJS, result.jsParser);
}

function findImportsInCode(code, parser) {
    const result = extractJS(code, parser);
    if (!result) return [];
    return result.jsModule.findImportsInCode(result.virtualJS, result.jsParser);
}

function findExportsInCode(code, parser) {
    const result = extractJS(code, parser);
    if (!result) return [];
    return result.jsModule.findExportsInCode(result.virtualJS, result.jsParser);
}

function findUsagesInCode(code, name, parser) {
    const result = extractJS(code, parser);
    if (!result) return [];
    return result.jsModule.findUsagesInCode(result.virtualJS, name, result.jsParser);
}

module.exports = {
    parse,
    findFunctions,
    findClasses,
    findStateObjects,
    findCallsInCode,
    findCallbackUsages,
    findReExports,
    findImportsInCode,
    findExportsInCode,
    findUsagesInCode,
    // Exported for testing
    extractScriptBlocks,
    buildVirtualJSContent
};
