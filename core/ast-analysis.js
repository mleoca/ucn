'use strict';

/**
 * Small AST-derived analyses shared by the public trust surface.
 *
 * Keep these queries syntax-only. They deliberately do not attempt compiler
 * binding or runtime prediction; their job is to replace source-text guesses
 * with stable tree-sitter facts.
 */

const { getParser, safeParse, langTraits } = require('../languages');

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

const DECLARATION_NODES = {
    class: new Set(['class_declaration', 'abstract_class_declaration', 'class_definition', 'class_specifier', 'class']),
    struct: new Set(['struct_item', 'struct_specifier', 'struct_declaration', 'type_spec']),
    interface: new Set(['interface_declaration', 'type_spec']),
    type: new Set(['type_alias_declaration', 'type_definition', 'type_spec', 'type_alias', 'type_item', 'associated_type']),
    enum: new Set(['enum_declaration', 'enum_item', 'enum_specifier']),
    trait: new Set(['trait_item']),
    impl: new Set(['impl_item']),
    record: new Set(['record_declaration']),
    field: new Set(['field_definition', 'public_field_definition', 'property_signature', 'field_declaration', 'variable_declarator']),
    state: new Set(['variable_declarator', 'assignment', 'init_declarator', 'const_item', 'static_item', 'const_spec', 'var_spec']),
};
const FUNCTION_EXPRESSIONS = new Set([
    'function_expression', 'generator_function', 'arrow_function', 'lambda',
    'func_literal', 'closure_expression', 'lambda_expression', 'anonymous_method_expression',
]);
const COMMENT_NODES = new Set(['comment', 'line_comment', 'block_comment']);

/**
 * Compare declarations by AST tokens, not lines: a class header and its first
 * method can share a line. Concrete methods belong to the callable diff;
 * bodyless signatures, fields (including unindexed Python assignments), and
 * nested types belong to the declaration. Function-valued fields retain their
 * signature but not their executable body. Nothing here is persisted in the
 * index, so old and current source use the same projection without a cache bump.
 * Missing AST mappings return no snapshot; callers keep conservative reporting.
 */
function declarationSnapshots(content, language, symbols) {
    const snapshots = new Map();
    if (content == null || symbols.length === 0) return snapshots;
    const parser = getParser(language);
    if (!parser) return snapshots;
    const root = safeParse(parser, content).rootNode;
    const wantedKinds = new Set(symbols.flatMap(s => [...(DECLARATION_NODES[s.type] || [])]));
    const candidates = new Map();
    walkNamed(root, node => {
        if (!wantedKinds.has(node.type)) return;
        if (!candidates.has(node.type)) candidates.set(node.type, []);
        candidates.get(node.type).push(node);
    });
    const hasName = (node, name) => {
        if (!node) return false;
        if (node.text === name) return true;
        return hasName(node.childForFieldName('name') || node.childForFieldName('declarator') ||
            (node.type === 'generic_type' && node.childForFieldName('type')), name);
    };
    for (const symbol of symbols) {
        const kinds = DECLARATION_NODES[symbol.type];
        if (!kinds) continue;
        let declaration = null;
        for (const kind of kinds) {
            for (const node of candidates.get(kind) || []) {
                if (node.startPosition.row + 1 < symbol.startLine ||
                    node.endPosition.row + 1 > (symbol.endLine || symbol.startLine)) continue;
                const name = node.childForFieldName('name') || node.childForFieldName('declarator') ||
                    node.childForFieldName('left') || (symbol.type === 'impl' && node.childForFieldName('type'));
                if (!hasName(name, symbol.typeName || symbol.name)) continue;
                if (!declaration || node.endIndex - node.startIndex > declaration.endIndex - declaration.startIndex) {
                    declaration = node;
                }
            }
        }
        if (!declaration || declaration.hasError) continue;
        // Export modifiers and Python decorators live outside the declaration.
        while (['export_statement', 'decorated_definition'].includes(declaration.parent?.type) &&
            declaration.parent.startPosition.row + 1 >= symbol.startLine) declaration = declaration.parent;
        const tokens = [];
        const lines = new Set();
        const visit = node => {
            if (COMMENT_NODES.has(node.type) || node.type === 'pass_statement') return;
            if (node.type === 'decorated_definition' &&
                CALLABLE_NODES.has(node.childForFieldName('definition')?.type)) return;
            // Class docstrings are documentation, not fields or inheritance.
            if (language === 'python' && node.type === 'expression_statement' &&
                node.namedChildCount === 1 && ['string', 'concatenated_string'].includes(node.namedChild(0).type)) return;
            const body = CALLABLE_NODES.has(node.type) ? node.childForFieldName('body') : null;
            if (body && !FUNCTION_EXPRESSIONS.has(node.type)) return;
            if (node.childCount === 0) {
                // Empty anonymous semicolons between members are separators.
                if (node.type === ';' && ['class_body', 'interface_body', 'declaration_list'].includes(node.parent?.type)) return;
                tokens.push([node.type, node.text]);
                for (let line = node.startPosition.row + 1; line <= node.endPosition.row + 1; line++) lines.add(line);
                return;
            }
            for (const child of node.children) {
                if (body && child.id === body.id) continue;
                visit(child);
            }
        };
        visit(declaration);
        snapshots.set(symbol, { signature: JSON.stringify(tokens), lines });
    }
    return snapshots;
}

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
        const start = node.startPosition.row + 1;
        const end = node.endPosition.row + 1;
        // A subtree lies within its root's rows: one disjoint from the
        // range holds no candidate (fix #365 - the walk used to visit every
        // node of the file for each measured callable).
        if (end < startLine || start > endLine) return false;
        if (!CALLABLE_NODES.has(node.type)) return true;
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
function computeAstComplexity(content, language, options = {}) {
    const { startLine = 1, endLine = startLine } = options;
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
        const tree = options.tree || safeParse(parser, content);
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

/**
 * Extract recognized reflection operations and classify their member target:
 * a stable literal (`name`), literal fragments around a runtime part
 * (`patterns`, fix #363), or dynamic. Literal targets and specific patterns
 * are positive liveness evidence; dynamic targets cannot identify a member
 * but must still be disclosed by deletion-oriented commands.
 */
function reflectionSites(content, language, tree = null) {
    try {
        if (!langTraits(language)?.reflectionApi) return [];
        if (!tree) {
            const parser = getParser(language);
            if (!parser) return [];
            tree = safeParse(parser, content);
        }
        return require('./reflection').reflectionSitesInTree(tree, language, content);
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
const CALL_NODE_TYPES = new Set(['call_expression', 'call', 'invocation_expression']);
const BINDING_NODE_TYPES = new Set(['variable_declarator', 'assignment_expression', 'assignment']);
const COMPUTED_INDEX_NODE_TYPES = [
    'subscript_expression', 'index_expression', 'subscript', 'element_access_expression',
];

function computedDispatchSites(content, language, tree = null) {
    try {
        if (!tree) {
            const parser = getParser(language);
            if (!parser) return [];
            tree = safeParse(parser, content);
        }
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
        // Every site's callee (or bound value) is an index expression, so
        // the native query starts from those (fix #365: the named-node walk
        // touched every node of every file). A callee is its call's first
        // child, so index-expression order is the calls' document order.
        const sameRange = (a, b) => !!a && !!b &&
            a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
        for (const indexExpr of tree.rootNode.descendantsOfType(COMPUTED_INDEX_NODE_TYPES)) {
            if (!indexExpr.isNamed) continue;
            const node = indexExpr.parent;
            if (!node || !node.isNamed) continue;
            if (CALL_NODE_TYPES.has(node.type)) {
                const callee = node.childForFieldName('function');
                if (sameRange(callee, indexExpr)) record(node, callee);
                continue;
            }
            // Two-step dispatch: `const h = handlers[key]; h()`. Record the
            // dynamic access only when its bound local is actually invoked in
            // the same callable scope. Ordinary indexing (`xs[i]`) is a value
            // read and says nothing about runtime-selected call targets.
            if (BINDING_NODE_TYPES.has(node.type)) {
                const left = node.childForFieldName('name') ||
                    node.childForFieldName('left');
                const right = node.childForFieldName('value') ||
                    node.childForFieldName('right');
                if (sameRange(right, indexExpr) && left?.type === 'identifier' &&
                    indexNodeForComputedCallee(right)) {
                    selectedByLocal.set(`${scopeKey(node)}\0${left.text}`, { node, right });
                }
            }
        }
        if (selectedByLocal.size > 0) {
            for (const node of tree.rootNode.descendantsOfType([...CALL_NODE_TYPES])) {
                if (!node.isNamed) continue;
                const callee = node.childForFieldName('function');
                if (callee?.type === 'identifier') {
                    calledLocals.add(`${scopeKey(node)}\0${callee.text}`);
                }
            }
        }
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

/**
 * Project reflection inventory (fix #363): per-file sites are extracted at
 * index time from the file's own parse (fileEntry.reflectionSites), so this
 * is a view, never a re-parse.
 */
function projectReflectionSites(index) {
    const byFile = new Map();
    for (const [filePath, fileEntry] of index.files) {
        if (Array.isArray(fileEntry.reflectionSites) && fileEntry.reflectionSites.length > 0) {
            byFile.set(filePath, fileEntry.reflectionSites);
        }
    }
    return byFile;
}

module.exports = {
    declarationSnapshots,
    computeAstComplexity,
    computedDispatchSites,
    projectComputedDispatch,
    projectReflectionSites,
    reflectionSites,
    literalReflectionSites,
};
