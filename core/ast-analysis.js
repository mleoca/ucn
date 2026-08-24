'use strict';

/**
 * Small AST-derived analyses shared by the public trust surface.
 *
 * Keep these queries syntax-only. They deliberately do not attempt compiler
 * binding or runtime prediction; their job is to replace source-text guesses
 * with stable tree-sitter facts.
 */

const { getParser, safeParse } = require('../languages');

const CALLABLE_NODES = new Set([
    // JavaScript / TypeScript
    'function_declaration', 'generator_function_declaration',
    'function_expression', 'generator_function', 'arrow_function',
    'method_definition',
    // Python
    'function_definition', 'lambda',
    // Go
    'method_declaration', 'func_literal',
    // Rust
    'function_item', 'closure_expression',
    // Java / C / C++ / C#
    'method_declaration', 'constructor_declaration', 'lambda_expression',
    'function_definition',
    'local_function_statement', 'anonymous_method_expression',
    'operator_declaration', 'conversion_operator_declaration',
]);

const BRANCH_NODES = new Set([
    'if_statement', 'if_expression', 'elif_clause',
    'for_statement', 'for_in_statement', 'for_expression',
    'foreach_statement', 'for_range_loop',
    'while_statement', 'while_expression', 'do_statement',
    'catch_clause', 'except_clause',
    'conditional_expression', 'ternary_expression',
    'switch_case', 'case_clause', 'case_statement',
    'switch_label', 'switch_section', 'expression_case',
    'communication_case', 'match_arm',
]);

const NESTING_NODES = new Set([
    'if_statement', 'if_expression', 'elif_clause',
    'for_statement', 'for_in_statement', 'for_expression',
    'foreach_statement', 'for_range_loop',
    'while_statement', 'while_expression', 'do_statement',
    'try_statement', 'catch_clause', 'except_clause',
    'switch_statement', 'switch_expression', 'expression_switch_statement',
    'type_switch_statement', 'select_statement', 'match_expression',
]);

const LITERAL_INDEX_NODES = new Set([
    'string', 'string_literal', 'raw_string_literal', 'interpreted_string_literal',
    'character', 'char_literal',
    'number', 'integer', 'integer_literal', 'int_literal',
    'number_literal', 'decimal_integer_literal', 'float', 'float_literal',
    'true', 'false', 'null', 'none',
]);

function walkNamed(node, visit) {
    if (!node) return;
    if (visit(node) === false) return;
    for (const child of node.namedChildren || []) walkNamed(child, visit);
}

function isDefaultBranch(node) {
    const text = String(node.text || '').trimStart();
    return text.startsWith('default') || text.startsWith('case _');
}

function findCallableForRange(root, startLine, endLine) {
    const candidates = [];
    walkNamed(root, node => {
        if (!CALLABLE_NODES.has(node.type)) return true;
        const start = node.startPosition.row + 1;
        const end = node.endPosition.row + 1;
        if (start < startLine || end > endLine) return true;
        candidates.push({
            node,
            exactEnd: end === endLine ? 1 : 0,
            exactStart: start === startLine ? 1 : 0,
            span: end - start,
            startDistance: Math.abs(start - startLine),
        });
        return true;
    });
    candidates.sort((a, b) =>
        b.exactEnd - a.exactEnd ||
        b.exactStart - a.exactStart ||
        b.span - a.span ||
        a.startDistance - b.startDistance);
    return candidates[0]?.node || null;
}

/**
 * Return AST structural branch count and control-flow nesting depth for one
 * indexed callable. Formatting, comments, strings, optional chaining, and
 * nullish coalescing cannot affect these values.
 */
function computeAstComplexity(content, language, {
    startLine = 1,
    endLine = startLine,
} = {}) {
    const lineCount = Math.max(0, endLine - startLine + 1);
    try {
        const parser = getParser(language);
        if (!parser) {
            return {
                branches: null,
                maxDepth: null,
                lineCount,
                measuredBy: 'unavailable-no-parser',
            };
        }
        const tree = safeParse(parser, content);
        const callable = findCallableForRange(tree.rootNode, startLine, endLine);
        if (!callable) {
            return {
                branches: null,
                maxDepth: null,
                lineCount,
                measuredBy: 'unavailable-no-callable-node',
            };
        }

        let branches = 0;
        let maxDepth = 0;
        const visit = (node, depth) => {
            if (node !== callable && CALLABLE_NODES.has(node.type)) return;

            if (BRANCH_NODES.has(node.type) && !isDefaultBranch(node)) branches++;
            const nextDepth = depth + (NESTING_NODES.has(node.type) ? 1 : 0);
            if (nextDepth > maxDepth) maxDepth = nextDepth;
            for (const child of node.namedChildren || []) visit(child, nextDepth);
        };
        visit(callable, 0);
        return {
            branches,
            maxDepth,
            lineCount,
            measuredBy: 'tree-sitter-ast',
        };
    } catch (error) {
        return {
            branches: null,
            maxDepth: null,
            lineCount,
            measuredBy: 'unavailable-parse-error',
        };
    }
}

function indexNodeForComputedCallee(callee) {
    if (!callee) return null;
    switch (callee.type) {
        case 'subscript_expression':
            return callee.childForFieldName('index') || callee.namedChild(1);
        case 'index_expression':
            return callee.childForFieldName('index') || callee.namedChild(1);
        case 'subscript':
            return callee.childForFieldName('subscript') || callee.namedChild(1);
        case 'element_access_expression': {
            const list = callee.childForFieldName('subscript') ||
                (callee.namedChildren || []).find(child =>
                    child.type === 'bracketed_argument_list');
            return list?.namedChild(0)?.namedChild(0) || list?.namedChild(0) || null;
        }
        default:
            return null;
    }
}

function computedReceiver(callee) {
    if (!callee) return null;
    const node = callee.childForFieldName('object') ||
        callee.childForFieldName('operand') ||
        callee.childForFieldName('value') ||
        callee.childForFieldName('expression') ||
        callee.namedChild(0);
    return node?.type === 'identifier' ? node.text : null;
}

const STRING_LITERAL_NODES = new Set([
    'string', 'string_literal', 'raw_string_literal',
    'interpreted_string_literal', 'verbatim_string_literal',
]);

function literalStringValue(node) {
    if (!node || !STRING_LITERAL_NODES.has(node.type)) return null;
    const content = (node.namedChildren || []).find(child =>
        child.type === 'string_content' || child.type === 'interpreted_string_literal_content');
    if (content) return content.text;
    const raw = String(node.text || '');
    const first = raw.search(/["']/);
    if (first < 0) return null;
    const quote = raw[first];
    const triple = raw.slice(first, first + 3) === quote.repeat(3);
    const width = triple ? 3 : 1;
    if (!raw.endsWith(quote.repeat(width))) return null;
    const value = raw.slice(first + width, -width);
    // Escaped/interpolated member names are not a stable static spelling.
    if (value.includes('\\') || value.includes('{') || value.includes('$')) return null;
    return value;
}

function callShape(node) {
    if (!['call', 'call_expression', 'invocation_expression',
        'method_invocation'].includes(node.type)) return null;
    const callee = node.childForFieldName('function') ||
        node.childForFieldName('name') || node.namedChild(0);
    const args = node.childForFieldName('arguments') ||
        (node.namedChildren || []).find(child =>
            ['argument_list', 'arguments', 'bracketed_argument_list'].includes(child.type));
    return callee && args ? { callee, args: args.namedChildren || [] } : null;
}

/**
 * Extract recognized reflection operations and classify whether their member
 * target is a stable literal. Literal targets are positive liveness evidence;
 * dynamic targets cannot identify one member but must still be disclosed by
 * deletion-oriented commands.
 */
function reflectionSites(content, language) {
    try {
        const syntaxHints = {
            python: ['getattr', 'setattr', 'hasattr', 'delattr'],
            javascript: ['Reflect.'],
            typescript: ['Reflect.'],
            tsx: ['Reflect.'],
            go: ['MethodByName', 'FieldByName'],
            java: ['getMethod', 'getDeclaredMethod', 'getField', 'getDeclaredField'],
            csharp: ['GetMethod', 'GetProperty', 'GetField'],
        }[language];
        if (!syntaxHints || !syntaxHints.some(hint => content.includes(hint))) {
            return [];
        }
        const parser = getParser(language);
        if (!parser) return [];
        const tree = safeParse(parser, content);
        const sites = [];
        walkNamed(tree.rootNode, node => {
            const call = callShape(node);
            if (!call) return true;
            const callee = String(call.callee.text || '');
            let argIndex = null;
            let kind = null;
            if (language === 'python' &&
                ['getattr', 'setattr', 'hasattr', 'delattr'].includes(callee)) {
                argIndex = 1;
                kind = callee;
            } else if (['javascript', 'typescript', 'tsx'].includes(language) &&
                /^(?:globalThis\.)?Reflect\.(?:get|set|has|deleteProperty)$/.test(callee)) {
                argIndex = 1;
                kind = callee.split('.').pop();
            } else if (language === 'go' &&
                /\.(?:MethodByName|FieldByName)$/.test(callee)) {
                argIndex = 0;
                kind = callee.split('.').pop();
            } else if (['java', 'csharp'].includes(language) &&
                /(?:^|\.)(?:getMethod|getDeclaredMethod|getField|getDeclaredField|GetMethod|GetProperty|GetField)$/.test(callee)) {
                argIndex = 0;
                kind = callee.split('.').pop();
            }
            if (argIndex == null || !call.args[argIndex]) return true;
            const name = literalStringValue(call.args[argIndex]);
            sites.push({
                ...(name && /^[A-Za-z_$][\w$]*$/.test(name) && { name }),
                kind,
                line: node.startPosition.row + 1,
                expression: node.text,
                dynamic: !name || !/^[A-Za-z_$][\w$]*$/.test(name),
            });
            return true;
        });
        return sites;
    } catch (_) {
        return [];
    }
}

function literalReflectionSites(content, language) {
    return reflectionSites(content, language).filter(site => !site.dynamic);
}

/**
 * Find direct computed dispatch calls such as handlers[name](). Literal keys
 * are excluded because they retain a statically visible member name.
 */
function computedDispatchSites(content, language) {
    try {
        const parser = getParser(language);
        if (!parser) return [];
        const tree = safeParse(parser, content);
        const sites = [];
        const seen = new Set();
        const selectedByLocal = new Map();
        const calledLocals = new Set();
        const scopeKey = node => {
            let current = node?.parent;
            while (current && !CALLABLE_NODES.has(current.type)) current = current.parent;
            return current ? `${current.startIndex}:${current.endIndex}` : 'module';
        };
        const record = (node, callee, expression) => {
            const indexNode = indexNodeForComputedCallee(callee);
            if (!indexNode || LITERAL_INDEX_NODES.has(indexNode.type)) return;
            const receiver = computedReceiver(callee);
            if (!receiver) return;
            const key = `${callee.startIndex}:${callee.endIndex}`;
            if (seen.has(key)) return;
            seen.add(key);
            sites.push({
                line: node.startPosition.row + 1,
                receiver,
                expression: expression || node.text,
            });
        };
        walkNamed(tree.rootNode, node => {
            let callee = null;
            if (node.type === 'call_expression' || node.type === 'call' ||
                node.type === 'invocation_expression') {
                callee = node.childForFieldName('function');
            }
            record(node, callee);

            if (callee?.type === 'identifier') {
                calledLocals.add(`${scopeKey(node)}\0${callee.text}`);
            }

            // Two-step dispatch: `const h = handlers[key]; h()`. Record the
            // dynamic access only when its bound local is actually invoked in
            // the same callable scope. Ordinary indexing (`xs[i]`) is a value
            // read and says nothing about runtime-selected call targets.
            if (node.type === 'variable_declarator' ||
                node.type === 'assignment_expression' ||
                node.type === 'assignment') {
                const left = node.childForFieldName('name') ||
                    node.childForFieldName('left');
                const right = node.childForFieldName('value') ||
                    node.childForFieldName('right');
                if (left?.type === 'identifier' && indexNodeForComputedCallee(right)) {
                    selectedByLocal.set(`${scopeKey(node)}\0${left.text}`, { node, right });
                }
            }
            return true;
        });
        for (const [key, selection] of selectedByLocal) {
            if (calledLocals.has(key)) record(selection.node, selection.right);
        }
        return sites;
    } catch (error) {
        return [];
    }
}

/**
 * Project-level cached computed-dispatch inventory. ProjectIndex invalidates
 * this memo on rebuilds and file removal so long-lived MCP sessions see edits.
 */
function projectComputedDispatch(index) {
    if (index._computedDispatchBlindspots) return index._computedDispatchBlindspots;
    const byFile = new Map();
    for (const [filePath, fileEntry] of index.files) {
        try {
            const sites = computedDispatchSites(index._readFile(filePath), fileEntry.language);
            if (sites.length > 0) byFile.set(filePath, sites);
        } catch (_) {
            // Unreadable files are reported through the existing parse/read
            // diagnostics; do not turn this optional scan into a query crash.
        }
    }
    index._computedDispatchBlindspots = byFile;
    index.computedDispatchDirty = true;
    return byFile;
}

module.exports = {
    computeAstComplexity,
    computedDispatchSites,
    projectComputedDispatch,
    reflectionSites,
    literalReflectionSites,
};
