'use strict';

const crypto = require('crypto');

const {
    traverseTree,
    nodeTextWithoutComments,
    traverseTreeCached,
    nodeToLocation,
    extractJSDocstring,
    extractStringArg,
    visitNameNodes,
    sameNode,
    containsOwnNode,
    parseErrorRegions,
    genericArityOf,
} = require('./utils');

// An iterator method (`yield return` in its OWN body) returns an enumerable /
// async enumerable, never a Task: `async IAsyncEnumerable<T>` is consumed by
// `await foreach`, not awaited.
const CS_YIELD_TYPES = new Set(['yield_statement']);
const CS_SCOPE_BOUNDARIES = new Set(['local_function_statement', 'lambda_expression',
    'anonymous_method_expression', 'class_declaration', 'struct_declaration', 'record_declaration']);
function isCSharpIterator(fnNode) {
    const body = fnNode.childForFieldName('body');
    return !!body && body.text.includes('yield') &&
        containsOwnNode(body, CS_YIELD_TYPES, CS_SCOPE_BOUNDARIES);
}
const { PARSE_OPTIONS, safeParse } = require('./index');

const TYPE_DECLARATIONS = new Map([
    ['class_declaration', 'class'],
    ['interface_declaration', 'interface'],
    ['struct_declaration', 'struct'],
    ['record_declaration', 'record'],
    ['enum_declaration', 'enum'],
]);
const IDENTIFIER_NODES = new Set(['identifier', 'generic_name']);
const METHOD_LIKE_NODES = new Set([
    'method_declaration', 'constructor_declaration',
    'destructor_declaration', 'operator_declaration',
    'conversion_operator_declaration',
]);
const CONTROL_FLOW_KEYWORDS = new Set([
    'if', 'for', 'foreach', 'while', 'switch', 'catch',
    'using', 'lock', 'fixed',
]);
const CONVERT_RETURN_TYPES = new Map([
    ['ToBoolean', 'bool'],
    ['ToByte', 'byte'],
    ['ToSByte', 'sbyte'],
    ['ToInt16', 'short'],
    ['ToUInt16', 'ushort'],
    ['ToInt32', 'int'],
    ['ToUInt32', 'uint'],
    ['ToInt64', 'long'],
    ['ToUInt64', 'ulong'],
    ['ToSingle', 'float'],
    ['ToDouble', 'double'],
    ['ToDecimal', 'decimal'],
    ['ToChar', 'char'],
    ['ToDateTime', 'DateTime'],
    ['ToString', 'string'],
]);

function isControlFlowLocalArtifact(node) {
    return node?.type === 'local_function_statement' &&
        CONTROL_FLOW_KEYWORDS.has(node.childForFieldName('name')?.text);
}

function parseTree(parser, code) {
    const views = csharpViews(parser, code);
    return views ? views.primary.tree : safeParse(parser, code, undefined, PARSE_OPTIONS);
}

/*
 * Conditional compilation (fix #391). tree-sitter-c-sharp models `#if` as a
 * node wrapping whole declarations or statements. A conditional that splits
 * one (`ILogger F(..)` then `#if X => body #endif ;`, `#if X , IFoo #endif`
 * in a base list, `else` before `#endif`, alternative method heads or
 * parameters) leaves its directive tokens inside ERROR nodes and derails the
 * parse, often of the rest of the file: serilog's ILogger.cs parsed as one
 * ERROR, with no interface and no members. The C# preprocessor is line based
 * and has no macros, so each conditional the damage touches is read in one
 * configuration,
 * keeping every row and column: its directive lines are blanked and one
 * branch stays (a lone `#if` branch always; among alternatives the one with
 * the most call sites, the first on ties). That is the primary view, kept
 * when it has fewer syntax errors than the literal parse. The rows of the
 * other alternatives are read from secondary views that keep those branches
 * instead. Conditionals the grammar placed stay as they are (both branches
 * of a structured `#if` are already in the tree), and a file whose literal
 * parse is clean is read as before.
 */
const CS_CONDITIONAL_LINE = /^[ \t]*#[ \t]*(if|elif|else|endif)\b/;
const CS_HAS_CONDITIONAL = /^[ \t]*#[ \t]*if\b/m;
const CS_DIRECTIVE_TOKENS = new Set(['#if', '#elif', '#else', '#endif']);
const CS_CALL_SHAPE = /[A-Za-z_]\w*\s*[<(]/g;
const CS_VIEW_MEMO_MAX = 8;
const csViewMemo = new Map();
const csViewsByTree = new WeakMap();
let csLastConditionalCode = null;
let csLastConditional = false;

function csHasConditional(code) {
    if (code !== csLastConditionalCode) {
        csLastConditionalCode = code;
        csLastConditional = CS_HAS_CONDITIONAL.test(code);
    }
    return csLastConditional;
}

function csCountErrors(node) {
    let count = node.type === 'ERROR' ? 1 : 0;
    for (const child of node.children) {
        if (child.isMissing) count++;
        else if (child.hasError) count += csCountErrors(child);
    }
    return count;
}

function csBlankLine(line) {
    return line.replace(/[^\r\n]/g, ' ');
}

/**
 * 0-based rows where the literal parse is damaged: directive tokens left in
 * ERROR nodes, the first and last rows of ERROR nodes, and MISSING tokens
 * (a declaration head the grammar closed before a conditional body).
 */
function csDamagedRows(root) {
    const rows = new Set();
    // The syntax errors counted as csCountErrors counts them.
    rows.errors = 0;
    const visit = node => {
        const error = node.type === 'ERROR';
        if (error) {
            rows.errors++;
            rows.add(node.startPosition.row);
            rows.add(node.endPosition.row);
        }
        for (const child of node.children) {
            if (child.isMissing) {
                rows.errors++;
                rows.add(child.startPosition.row);
            } else if (error && CS_DIRECTIVE_TOKENS.has(child.type)) {
                rows.add(child.startPosition.row);
            }
            if (!child.isMissing && child.hasError) visit(child);
        }
    };
    if (root.hasError) visit(root);
    return rows;
}

/**
 * The views of a C# file whose literal parse misplaces conditional
 * directives (see above), memoized per content; null when the literal tree
 * is the file's view. { primary: { tree }, secondary: [{ tree, owns }] }
 * with `owns` the 0-based rows a secondary view supplies.
 */
function csharpViews(parser, code) {
    if (!csHasConditional(code)) return null;
    if (csViewMemo.has(code)) return csViewMemo.get(code);
    const views = csBuildViews(parser, code);
    csViewMemo.set(code, views);
    if (views) csViewsByTree.set(views.primary.tree, { code, views });
    if (csViewMemo.size > CS_VIEW_MEMO_MAX) csViewMemo.delete(csViewMemo.keys().next().value);
    return views;
}

function csBuildViews(parser, code) {
    const literal = safeParse(parser, code, undefined, PARSE_OPTIONS);
    if (!literal.rootNode.hasError) return null;
    const damaged = csDamagedRows(literal.rootNode);
    const lines = code.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) || [];
    // Conditional groups: directive rows of each branch, in nesting order.
    const groups = [];
    const stack = [];
    for (let row = 0; row < lines.length; row++) {
        const match = lines[row].match(CS_CONDITIONAL_LINE);
        if (!match) continue;
        if (match[1] === 'if') stack.push({ branches: [row] });
        else if (match[1] === 'elif' || match[1] === 'else') {
            if (!stack.length) return null;
            stack[stack.length - 1].branches.push(row);
        } else {
            const group = stack.pop();
            if (!group) return null;
            group.end = row;
            groups.push(group);
        }
    }
    if (stack.length > 0) return null;
    // Conditionals the damage touches, from the row before `#if` (a head
    // left open for the conditional body) to the `#endif`.
    const resolved = groups.filter(group => {
        for (let row = group.branches[0] - 1; row <= group.end; row++) {
            if (damaged.has(row)) return true;
        }
        return false;
    });
    if (resolved.length === 0) return null;
    for (const group of resolved) group.primary = csPrimaryBranch(group, lines);
    return csViewsFromGroups(parser, code, lines, resolved, damaged.errors);
}

// Rows of branch b of a group (between its directive and the next).
function csBranchRows(group, b) {
    const bounds = [...group.branches, group.end];
    const rows = [];
    for (let row = bounds[b] + 1; row < bounds[b + 1]; row++) rows.push(row);
    return rows;
}

// The branch a view keeps by default: the one with the most call shapes,
// the first on ties.
function csPrimaryBranch(group, lines) {
    let keep = 0;
    let keepCalls = -1;
    for (let b = 0; b < group.branches.length; b++) {
        let calls = 0;
        for (const row of csBranchRows(group, b)) calls += (lines[row].match(CS_CALL_SHAPE) || []).length;
        if (calls > keepCalls) {
            keep = b;
            keepCalls = calls;
        }
    }
    return keep;
}

/**
 * The views of `code` for its resolved conditional groups, one parse each.
 * With the literal parse's error count (build) the views are kept only when
 * the primary view has fewer syntax errors; a query rebuilds the views the
 * index recorded for this content from `groups` (persisted per file as
 * [branch rows..., end row, primary branch]) without the literal parse.
 */
function csViewsFromGroups(parser, code, lines, resolved, literalErrors = null) {
    // One view per alternative position: view 0 keeps each group's primary
    // branch, view k its k-th other branch (the primary one when it has no
    // more). A lone `#if` branch is kept in every view.
    const alternatives = Math.max(...resolved.map(group => group.branches.length));
    const viewSource = k => {
        const blank = new Set();
        const kept = new Set();
        for (const group of resolved) {
            for (const row of [...group.branches, group.end]) blank.add(row);
            const others = group.branches.map((_, b) => b).filter(b => b !== group.primary);
            const chosen = k === 0 || others.length === 0 ? group.primary : others[(k - 1) % others.length];
            for (let b = 0; b < group.branches.length; b++) {
                for (const row of csBranchRows(group, b)) {
                    if (b === chosen) {
                        if (k > 0 && b !== group.primary) kept.add(row);
                    } else {
                        blank.add(row);
                    }
                }
            }
        }
        return {
            source: lines.map((line, row) => (blank.has(row) ? csBlankLine(line) : line)).join(''),
            owns: kept,
        };
    };
    const reparse = source => safeParse(parser, source, undefined, PARSE_OPTIONS);
    const primaryTree = reparse(viewSource(0).source);
    if (literalErrors != null && primaryTree.rootNode.hasError &&
        csCountErrors(primaryTree.rootNode) >= literalErrors) return null;
    const secondary = [];
    for (let k = 1; k < alternatives; k++) {
        const view = viewSource(k);
        // Only rows that hold code are worth a parse.
        const owns = new Set([...view.owns].filter(row => /\w/.test(lines[row])));
        if (owns.size === 0) continue;
        secondary.push({ tree: reparse(view.source), owns, reaches: csRowReach(owns) });
    }
    return {
        primary: { tree: primaryTree },
        secondary,
        groups: resolved.map(group => [...group.branches, group.end, group.primary]),
    };
}

/**
 * Items of every view: the primary view's, then each secondary view's
 * items on the rows it owns. `rowOf` gives an item's 1-based row.
 */
function csMergeViewItems(views, extract, rowOf) {
    const merged = extract(views.primary.tree, null);
    for (const view of views.secondary) {
        for (const item of extract(view.tree, view.reaches)) {
            if (view.owns.has(rowOf(item) - 1)) merged.push(item);
        }
    }
    return merged;
}

/**
 * Whether a node's rows reach a secondary view's owned rows: extractors
 * skip every other subtree of that view, since only items on owned rows are
 * taken from it (the primary view supplies the rest).
 */
function csRowReach(owns) {
    const rows = [...owns].sort((a, b) => a - b);
    return node => {
        const start = node.startPosition.row;
        const end = node.endPosition.row;
        let lo = 0;
        let hi = rows.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (rows[mid] < start) lo = mid + 1;
            else hi = mid;
        }
        return lo < rows.length && rows[lo] <= end;
    };
}

/**
 * The tree queries read for a C# file: its primary view (fix #391). With the
 * file's index entry for this content, the views are rebuilt from the groups
 * the index recorded (`conditionalViews`) and a file the index read literally
 * is parsed once, without repeating the damage analysis.
 */
function queryTree(code, parser, entry = null) {
    if (!entry?.hash || !csHasConditional(code) ||
        crypto.createHash('md5').update(code).digest('hex') !== entry.hash) {
        return parseTree(parser, code);
    }
    if (!Array.isArray(entry.conditionalViews)) {
        const tree = safeParse(parser, code, undefined, PARSE_OPTIONS);
        csViewsByTree.set(tree, { code, views: null });
        return tree;
    }
    let views = csViewMemo.get(code);
    if (!views) {
        const lines = code.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) || [];
        const resolved = entry.conditionalViews.map(group => ({
            branches: group.slice(0, -2),
            end: group[group.length - 2],
            primary: group[group.length - 1],
        }));
        views = csViewsFromGroups(parser, code, lines, resolved);
        csViewMemo.set(code, views);
        if (csViewMemo.size > CS_VIEW_MEMO_MAX) csViewMemo.delete(csViewMemo.keys().next().value);
    }
    csViewsByTree.set(views.primary.tree, { code, views });
    return views.primary.tree;
}

/**
 * Whether queryTree for this source is its plain parse (fix #395): a file
 * without a conditional directive, or one its index entry (same content)
 * read literally, has one view.
 */
function queryTreeIsPlain(code, entry = null) {
    if (!csHasConditional(code)) return true;
    return !!entry?.hash && !Array.isArray(entry.conditionalViews) &&
        crypto.createHash('md5').update(code).digest('hex') === entry.hash;
}

function namespaceDeclarationName(declaration) {
    const nameNode = declaration.childForFieldName('name') ||
        declaration.namedChildren.find(child =>
            child.type === 'identifier' || child.type === 'qualified_name');
    return nameNode ? nameNode.text.replace(/\s+/g, '') : null;
}

// The full namespace a node is declared in (fix #395): every enclosing
// `namespace A { namespace B { .. } }` block contributes its name, outermost
// first, under the file-scoped `namespace X;` that precedes the node. C#
// names a nested block's members A.B, never B. Per tree, the file-scoped
// declaration and each block's full path are computed once.
const namespaceMemo = new WeakMap();
function namespaceOf(node, tree) {
    let memo = tree ? namespaceMemo.get(tree) : null;
    if (tree && !memo) {
        const fileScoped = fileScopedNamespace(tree.rootNode);
        memo = {
            fileScoped: fileScoped ? { name: namespaceDeclarationName(fileScoped), start: fileScoped.startIndex } : null,
            blocks: new Map(),
        };
        namespaceMemo.set(tree, memo);
    }
    let block = null;
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (parent.type === 'namespace_declaration') { block = parent; break; }
    }
    let blockPath = null;
    if (block) {
        blockPath = memo?.blocks.get(block.id);
        if (blockPath === undefined) {
            const parts = [];
            for (let current = block; current; current = current.parent) {
                if (current.type !== 'namespace_declaration') continue;
                const name = namespaceDeclarationName(current);
                if (name) parts.unshift(name);
            }
            blockPath = parts.length > 0 ? parts.join('.') : null;
            memo?.blocks.set(block.id, blockPath);
        }
    }
    const fileScoped = memo ? memo.fileScoped : (() => {
        const declaration = fileScopedNamespace(tree?.rootNode);
        return declaration ? { name: namespaceDeclarationName(declaration), start: declaration.startIndex } : null;
    })();
    const scopedName = fileScoped?.name && (!node || fileScoped.start <= node.startIndex) ? fileScoped.name : null;
    if (scopedName && blockPath) return `${scopedName}.${blockPath}`;
    return scopedName || blockPath || null;
}

// The file-scoped namespace declaration of a compilation unit, also when a
// conditional wraps the whole file (`#if X` ... `namespace N;` ... `#endif`,
// fix #391).
function fileScopedNamespace(root) {
    for (const child of root?.namedChildren || []) {
        if (child.type === 'file_scoped_namespace_declaration') return child;
        if (child.type.startsWith('preproc_')) {
            const nested = fileScopedNamespace(child);
            if (nested) return nested;
        }
    }
    return null;
}

function modifiersOf(node) {
    return (node.namedChildren || [])
        .filter(child => child.type === 'modifier')
        .map(child => child.text);
}

function attributeData(node) {
    const attributes = [];
    for (const list of (node.namedChildren || []).filter(child => child.type === 'attribute_list')) {
        for (const attribute of list.namedChildren || []) {
            if (attribute.type !== 'attribute') continue;
            const nameNode = attribute.childForFieldName('name') || attribute.namedChild(0);
            if (!nameNode) continue;
            const args = attribute.namedChildren.find(child => child.type === 'attribute_argument_list');
            const firstArg = args?.namedChildren.find(child => child.type === 'attribute_argument')
                ?.namedChild(0);
            const stringArg = extractStringArg(firstArg);
            attributes.push({
                name: nameNode.text.replace(/Attribute$/, ''),
                ...(stringArg && {
                    arg: stringArg.value,
                    interp: stringArg.interp,
                }),
                // fix #366: non-literal arguments (constants, concatenation,
                // nameof) keep their source so route extraction can fold them.
                ...(!stringArg && args && args.namedChildCount > 0 && {
                    args: args.text.replace(/^\(|\)$/g, '').trim(),
                }),
            });
        }
    }
    return attributes;
}

function structuredParams(paramsNode) {
    if (!paramsNode) return [];
    const params = [];
    const recoveredParams = [];
    // tree-sitter-c-sharp 0.23 exposes `params T[] name` as three siblings
    // (`params` token, type node, identifier) rather than a named
    // parameter_array node. Recover that compiler-significant shape before
    // processing ordinary parameter nodes; losing it makes overload arity
    // and normal-vs-expanded params resolution unsound.
    for (let i = 0; i < paramsNode.childCount; i++) {
        if (paramsNode.child(i).type !== 'params') continue;
        let typeNode = null;
        let nameNode = null;
        for (let j = i + 1; j < paramsNode.childCount; j++) {
            const child = paramsNode.child(j);
            if (child.type === ',' || child.type === ')') break;
            if (!child.isNamed) continue;
            if (!typeNode) typeNode = child;
            else {
                nameNode = child;
                break;
            }
        }
        if (nameNode) {
            recoveredParams.push({
                name: nameNode.text,
                ...(typeNode && { type: nodeTextWithoutComments(typeNode) }),
                rest: true,
            });
        }
    }
    for (const param of paramsNode.namedChildren || []) {
        if (param.type !== 'parameter' && param.type !== 'parameter_array') continue;
        const nameNode = param.childForFieldName('name');
        const typeNode = param.childForFieldName('type');
        if (!nameNode) continue;
        const info = { name: nameNode.text };
        if (typeNode) info.type = nodeTextWithoutComments(typeNode);
        if (modifiersOf(param).includes('this')) info.extensionReceiver = true;
        if (param.type === 'parameter_array') info.rest = true;
        const value = param.childForFieldName('value') ||
            param.namedChildren.find(child => !sameNode(child, nameNode) && !sameNode(child, typeNode) &&
                !['attribute_list', 'modifier', 'comment'].includes(child.type));
        if (value) {
            info.default = nodeTextWithoutComments(value);
            info.optional = true;
        }
        params.push(info);
    }
    // A params array is required to be the final declaration parameter.
    params.push(...recoveredParams);
    return params;
}

// `operator +` / `operator ==` name from the token following the anonymous
// `operator` keyword; conversion operators name their target type
// (`implicit operator int` → `operator int`), matching the C++ operator_name
// convention.
function operatorName(node) {
    if (node.type === 'operator_declaration') {
        for (let i = 0; i < node.childCount - 1; i++) {
            if (node.child(i).type === 'operator') {
                return `operator${node.child(i + 1).text}`;
            }
        }
        return null;
    }
    if (node.type === 'conversion_operator_declaration') {
        const target = node.childForFieldName('type');
        return target ? `operator ${target.text}` : null;
    }
    return null;
}

function conversionKind(node) {
    if (node.type !== 'conversion_operator_declaration') return null;
    for (let i = 0; i < node.childCount; i++) {
        const type = node.child(i).type;
        if (type === 'implicit' || type === 'explicit') return type;
    }
    return null;
}

function memberFromNode(node, className, lines) {
    if (!METHOD_LIKE_NODES.has(node.type)) return null;
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text ||
        operatorName(node) ||
        (node.type === 'constructor_declaration' ? className : null);
    if (!name) return null;
    const paramsNode = node.childForFieldName('parameters');
    const returnNode = node.childForFieldName('returns') || node.childForFieldName('type');
    const { startLine, endLine, indent } = nodeToLocation(node, lines);
    const attrs = attributeData(node);
    const modifiers = modifiersOf(node);
    const isConstructor = node.type === 'constructor_declaration';
    if (isConstructor) modifiers.push('constructor');
    if (node.type === 'destructor_declaration') modifiers.push('destructor');
    const conversion = conversionKind(node);
    if (conversion) modifiers.push(conversion);
    const explicitInterface = explicitInterfaceOf(node);
    const paramsStructured = structuredParams(paramsNode);
    const generics = typeParameterNames(node);
    // fix #380: an extension receiver typed by a METHOD type parameter
    // (`static T Ext<T>(this T e) where T : Exception`) accepts any type
    // satisfying the parameter's constraints.
    const receiverParam = paramsStructured[0];
    if (receiverParam?.extensionReceiver && receiverParam.type) {
        const typeParams = node.childForFieldName('type_parameters');
        const isTypeParam = (typeParams?.namedChildren || []).some(child =>
            child.type === 'type_parameter' && child.childForFieldName('name')?.text === receiverParam.type);
        if (isTypeParam) {
            const constraints = [];
            for (const clause of node.namedChildren) {
                if (clause.type !== 'type_parameter_constraints_clause') continue;
                if (clause.namedChild(0)?.text !== receiverParam.type) continue;
                for (const constraint of clause.namedChildren.slice(1)) {
                    const typeNode = constraint.childForFieldName('type');
                    if (typeNode) constraints.push(nodeTextWithoutComments(typeNode));
                }
            }
            paramsStructured[0] = { ...receiverParam, typeParameter: true,
                ...(constraints.length > 0 && { constraints }) };
        }
    }
    return {
        name,
        params: paramsNode ? nodeTextWithoutComments(paramsNode).replace(/^\(|\)$/g, '').trim() : '...',
        paramsStructured,
        returnType: isConstructor ? null : nodeTextWithoutComments(returnNode).trim() || null,
        startLine,
        endLine,
        ...nameLineOf(nameNode, startLine),
        indent,
        modifiers,
        ...(generics && { generics }),
        memberType: isConstructor ? 'constructor' : 'method',
        isMethod: true,
        isConstructor,
        className,
        ...(explicitInterface && { explicitInterface }),
        isAsync: modifiers.includes('async'),
        ...(isCSharpIterator(node) && { isGenerator: true }),
        ...(modifiers.includes('static') &&
            paramsStructured[0]?.extensionReceiver && {
                isExtensionMethod: true,
            }),
        docstring: extractJSDocstring(lines, startLine),
        ...(attrs.length > 0 && {
            decorators: attrs.map(attr => attr.name),
            attributesWithArgs: attrs,
        }),
    };
}

function fieldMembers(node, lines) {
    if (node.type !== 'field_declaration' && node.type !== 'event_field_declaration') return [];
    const declaration = node.namedChildren.find(child => child.type === 'variable_declaration');
    const typeNode = declaration?.childForFieldName('type');
    const members = [];
    for (const declarator of declaration?.namedChildren || []) {
        if (declarator.type !== 'variable_declarator') continue;
        const nameNode = declarator.childForFieldName('name');
        if (!nameNode?.text) continue;
        const { startLine, endLine, indent } = nodeToLocation(declarator, lines);
        members.push({
            name: nameNode.text,
            startLine,
            endLine,
            indent,
            modifiers: modifiersOf(node),
            memberType: 'field',
            fieldType: typeNode?.text || null,
        });
    }
    return members;
}

// The interface an explicit implementation names (`void IDisposable.Dispose()`,
// `object ICollection.SyncRoot`, `int IList<int>.this[int i]`, events):
// such a member is reached only through that interface (fix #391 extends it
// from methods to properties, indexers and events).
function explicitInterfaceOf(node) {
    const specifier = node.namedChildren.find(child =>
        child.type === 'explicit_interface_specifier');
    return specifier?.text.replace(/\.$/, '').trim() || null;
}

function indexerMember(node, className, lines) {
    if (node.type !== 'indexer_declaration') return null;
    const paramsNode = node.childForFieldName('parameters');
    const typeNode = node.childForFieldName('type');
    const { startLine, endLine, indent } = nodeToLocation(node, lines);
    const explicitInterface = explicitInterfaceOf(node);
    return {
        name: 'this[]',
        params: paramsNode ? nodeTextWithoutComments(paramsNode).replace(/^\[|\]$/g, '').trim() : '...',
        paramsStructured: structuredParams(paramsNode),
        returnType: nodeTextWithoutComments(typeNode).trim() || null,
        startLine,
        endLine,
        ...nameLineOf((node.children || []).find(child => child.type === 'this') || null, startLine),
        indent,
        modifiers: modifiersOf(node),
        memberType: 'property',
        isMethod: true,
        className,
        ...(explicitInterface && { explicitInterface }),
        docstring: extractJSDocstring(lines, startLine),
    };
}

function propertyMember(node, lines) {
    if (node.type !== 'property_declaration' && node.type !== 'event_declaration') return null;
    const nameNode = node.childForFieldName('name');
    const typeNode = node.childForFieldName('type');
    // Conditional attributes inside a property can make tree-sitter recover a
    // second, zero-width property fragment (`get { ... }` with a missing name).
    // The real declaration is already indexed; reject the missing-node
    // artifact instead of letting one invalid symbol discard the whole file.
    if (!nameNode?.text) return null;
    const { startLine, endLine, indent } = nodeToLocation(node, lines);
    const explicitInterface = explicitInterfaceOf(node);
    return {
        name: nameNode.text,
        startLine,
        endLine,
        ...nameLineOf(nameNode, startLine),
        indent,
        modifiers: modifiersOf(node),
        memberType: 'property',
        fieldType: typeNode?.text || null,
        ...(explicitInterface && { explicitInterface }),
    };
}

// fix #380: a C# type's generic arity is part of its identity (`Outcome`,
// `Outcome<T>` and `Outcome<T1, T2>` are three types).
function typeParameterCount(node) {
    const list = node?.namedChildren?.find(child => child.type === 'type_parameter_list');
    if (!list) return 0;
    return list.namedChildren.filter(child => child.type === 'type_parameter').length;
}

// fix #390: the declared type parameter NAMES, in order (`<TState, TResult>`;
// variance and attributes dropped), so a base clause `: Visitor<TextWriter,
// bool>` can be read as a substitution of those names.
function typeParameterNames(node) {
    const list = node?.childForFieldName?.('type_parameters') ||
        node?.namedChildren?.find(child => child.type === 'type_parameter_list');
    if (!list) return null;
    const names = [];
    for (const child of list.namedChildren) {
        if (child.type !== 'type_parameter') continue;
        const name = child.childForFieldName('name') ||
            child.namedChildren.find(part => part.type === 'identifier');
        if (name?.text) names.push(name.text);
    }
    return names.length > 0 ? `<${names.join(', ')}>` : null;
}

// fix #390: the line of the declared name when attributes on their own lines
// start the declaration (`[Obsolete]` above `void M()`): definition edits and
// definition-line classification use it.
function nameLineOf(nameNode, startLine) {
    const line = nameNode ? nameNode.startPosition.row + 1 : null;
    return line != null && line !== startLine ? { nameLine: line } : {};
}

function baseHeadName(text) {
    return text.replace(/<.*$/, '').split('.').pop().trim();
}

// Classify the base list into extends/implements. The C# grammar guarantees a
// class base precedes the interfaces, so only position 0 needs deciding:
// same-file declarations are ground truth, and the BCL-wide I-prefix
// convention (IDisposable, IList<T>) covers external names. Interfaces only
// ever extend; structs only ever implement.
function classifyBases(bases, type, fileTypeKinds) {
    if (bases.length === 0) return {};
    if (type === 'interface') return { extends: bases.join(', ') };
    if (type === 'enum') return { extends: bases[0] };
    let extendsBase = null;
    let implementsList = bases;
    if (type !== 'struct') {
        const head = baseHeadName(bases[0]);
        const declaredKind = fileTypeKinds.get(head);
        const isInterface = declaredKind === 'interface' ||
            (!declaredKind && /^I[A-Z]/.test(head));
        if (!isInterface) {
            extendsBase = bases[0];
            implementsList = bases.slice(1);
        }
    }
    return {
        ...(extendsBase && { extends: extendsBase }),
        ...(implementsList.length > 0 && { implements: implementsList }),
    };
}

function findClasses(code, parser) {
    const views = csharpViews(parser, code);
    if (!views) return findClassesInTree(code, safeParse(parser, code, undefined, PARSE_OPTIONS));
    const classes = findClassesInTree(code, views.primary.tree);
    for (const view of views.secondary) {
        csMergeSecondaryClasses(classes, findClassesInTree(code, view.tree), view.owns);
    }
    return classes;
}

/**
 * Declarations a secondary view owns (fix #391): a type whose head it owns
 * joins whole; members it owns join the primary view's type of the same
 * name and head row.
 */
function csMergeSecondaryClasses(classes, secondary, owns) {
    for (const cls of secondary) {
        if (owns.has(cls.startLine - 1)) {
            if (!classes.some(existing => existing.name === cls.name && existing.startLine === cls.startLine)) {
                classes.push(cls);
            }
            continue;
        }
        const target = classes.find(existing => existing.name === cls.name && existing.startLine === cls.startLine);
        if (!target) continue;
        for (const member of cls.members || []) {
            if (!owns.has(member.startLine - 1)) continue;
            if (target.members.some(existing => existing.name === member.name &&
                existing.startLine === member.startLine)) continue;
            target.members.push(member);
            target.endLine = Math.max(target.endLine, member.endLine);
        }
        target.members.sort((a, b) => a.startLine - b.startLine);
    }
    classes.sort((a, b) => a.startLine - b.startLine);
}

function findClassesInTree(code, tree) {
    const lines = code.split('\n');
    const classes = [];
    // Same-file type kinds override the I-prefix convention when classifying
    // base lists (a project class legitimately named IFoo stays `extends`).
    const fileTypeKinds = new Map();
    traverseTreeCached(tree.rootNode, node => {
        const kind = TYPE_DECLARATIONS.get(node.type);
        if (!kind) return true;
        const kindName = node.childForFieldName('name')?.text;
        if (kindName && !fileTypeKinds.has(kindName)) fileTypeKinds.set(kindName, kind);
        return true;
    });
    traverseTreeCached(tree.rootNode, node => {
        if (node.type === 'delegate_declaration') {
            // A delegate declares an importable callable type, like a C
            // function-pointer typedef.
            const delegateName = node.childForFieldName('name');
            if (delegateName) {
                const { startLine, endLine, indent } = nodeToLocation(node, lines);
                const delegateArity = typeParameterCount(node);
                const delegateGenerics = typeParameterNames(node);
                // fix #393: the delegate's parameter count, the count a
                // lambda converting to it must have (C# 10.7.1).
                const delegateParamList = node.childForFieldName('parameters') ||
                    node.namedChildren.find(child => child.type === 'parameter_list');
                const delegateParams = delegateParamList
                    ? delegateParamList.namedChildren.filter(child => child.type === 'parameter').length
                    : null;
                classes.push({
                    name: delegateName.text,
                    type: 'type',
                    ...(delegateArity > 0 && { typeArity: delegateArity }),
                    ...(delegateGenerics && { generics: delegateGenerics }),
                    ...(Number.isInteger(delegateParams) && { delegateParams }),
                    startLine,
                    endLine,
                    ...nameLineOf(delegateName, startLine),
                    indent,
                    modifiers: modifiersOf(node),
                    ...(namespaceOf(node, tree) && { namespace: namespaceOf(node, tree) }),
                    members: [],
                    docstring: extractJSDocstring(lines, startLine),
                });
            }
            return true;
        }
        const type = TYPE_DECLARATIONS.get(node.type);
        if (!type) return true;
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return true;
        const body = node.childForFieldName('body') ||
            node.namedChildren.find(child => child.type === 'declaration_list');
        const members = [];
        const memberNodes = [];
        const collectMemberNodes = (container) => {
            for (const child of container?.namedChildren || []) {
                if (TYPE_DECLARATIONS.has(child.type)) continue;
                if (child.type.startsWith('preproc_')) {
                    collectMemberNodes(child);
                } else {
                    memberNodes.push(child);
                }
            }
        };
        collectMemberNodes(body);
        for (const child of memberNodes) {
            if (TYPE_DECLARATIONS.has(child.type)) continue;
            if (type === 'enum' && child.type === 'enum_member_declaration') {
                const enumName = child.childForFieldName('name') ||
                    child.namedChildren.find(item => item.type === 'identifier');
                if (enumName) {
                    const { startLine, endLine, indent } = nodeToLocation(child, lines);
                    members.push({
                        name: enumName.text,
                        startLine,
                        endLine,
                        ...nameLineOf(enumName, startLine),
                        indent,
                        modifiers: ['public', 'static'],
                        memberType: 'field',
                        fieldType: nameNode.text,
                    });
                }
                continue;
            }
            const method = memberFromNode(child, nameNode.text, lines);
            if (method) members.push(method);
            else {
                const property = propertyMember(child, lines) ||
                    indexerMember(child, nameNode.text, lines);
                if (property) members.push(property);
                members.push(...fieldMembers(child, lines));
            }
        }
        const baseList = node.namedChildren.find(child => child.type === 'base_list');
        const bases = baseList?.namedChildren.map(child => child.text) || [];
        const { startLine, endLine, indent } = nodeToLocation(node, lines);
        const attrs = attributeData(node);
        let enclosingType;
        for (let parent = node.parent; parent; parent = parent.parent) {
            if (!TYPE_DECLARATIONS.has(parent.type)) continue;
            enclosingType = parent.childForFieldName('name')?.text;
            if (enclosingType) break;
        }
        const typeArity = typeParameterCount(node);
        if (typeArity > 0) {
            for (const member of members) member.ownerTypeArity = typeArity;
        }
        const generics = typeParameterNames(node);
        classes.push({
            name: nameNode.text,
            type,
            startLine,
            endLine,
            ...nameLineOf(nameNode, startLine),
            indent,
            modifiers: modifiersOf(node),
            ...(typeArity > 0 && { typeArity }),
            ...(generics && { generics }),
            ...(enclosingType && { enclosingType }),
            ...(namespaceOf(node, tree) && { namespace: namespaceOf(node, tree) }),
            members,
            ...classifyBases(bases, type, fileTypeKinds),
            docstring: extractJSDocstring(lines, startLine),
            ...(attrs.length > 0 && {
                decorators: attrs.map(attr => attr.name),
                attributesWithArgs: attrs,
            }),
        });
        return true;
    });

    // tree-sitter-c-sharp can end a class node early after a malformed
    // preprocessor branch while still recovering all following methods as
    // method_declaration siblings under the namespace. Preserve those AST
    // declarations by attaching an orphan to the nearest preceding type in
    // the same namespace and at a shallower indentation. This is declaration
    // recovery only—call extraction remains AST-derived.
    traverseTreeCached(tree.rootNode, node => {
        if (!METHOD_LIKE_NODES.has(node.type)) return true;
        for (let parent = node.parent; parent; parent = parent.parent) {
            if (TYPE_DECLARATIONS.has(parent.type)) return false;
        }
        const startLine = node.startPosition.row + 1;
        const nodeNamespace = namespaceOf(node, tree);
        const candidate = classes
            .filter(type => type.startLine < startLine &&
                (type.namespace || null) === (nodeNamespace || null) &&
                type.indent < node.startPosition.column &&
                type.type !== 'enum')
            .sort((a, b) => b.startLine - a.startLine)[0];
        if (!candidate) return false;
        const member = memberFromNode(node, candidate.name, lines);
        if (member && candidate.typeArity) member.ownerTypeArity = candidate.typeArity;
        if (member && !candidate.members.some(existing =>
            existing.startLine === member.startLine &&
            existing.name === member.name)) {
            candidate.members.push(member);
            candidate.endLine = Math.max(candidate.endLine, member.endLine);
        }
        return false;
    });
    return classes;
}

function findFunctions(code, parser) {
    const views = csharpViews(parser, code);
    if (!views) return findFunctionsInTree(code, safeParse(parser, code, undefined, PARSE_OPTIONS));
    return csMergeViewItems(views, (tree, reaches) => findFunctionsInTree(code, tree, reaches), fn => fn.startLine)
        .sort((a, b) => a.startLine - b.startLine);
}

function findFunctionsInTree(code, tree, reaches = null) {
    const lines = code.split('\n');
    const functions = [];
    traverseTreeCached(tree.rootNode, node => {
        if (reaches && !reaches(node)) return false;
        if (node.type !== 'local_function_statement') return true;
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return true;
        // Conditional-compilation recovery can make `else if (...)` look
        // like a local function whose return type is `else` and name is
        // `if`. C# keywords cannot be ordinary local-function identifiers;
        // rejecting this parser artifact keeps enclosing-function ownership
        // on the real constructor/method.
        if (isControlFlowLocalArtifact(node)) {
            return false;
        }
        const paramsNode = node.childForFieldName('parameters');
        const returnNode = node.childForFieldName('returns') || node.childForFieldName('type');
        const { startLine, endLine, indent } = nodeToLocation(node, lines);
        const modifiers = modifiersOf(node);
        const localGenerics = typeParameterNames(node);
        functions.push({
            name: nameNode.text,
            params: paramsNode ? nodeTextWithoutComments(paramsNode).replace(/^\(|\)$/g, '').trim() : '...',
            paramsStructured: structuredParams(paramsNode),
            returnType: nodeTextWithoutComments(returnNode).trim() || null,
            startLine,
            endLine,
            ...nameLineOf(nameNode, startLine),
            indent,
            modifiers,
            ...(localGenerics && { generics: localGenerics }),
            isAsync: modifiers.includes('async'),
            ...(isCSharpIterator(node) && { isGenerator: true }),
            isNested: true,
            docstring: extractJSDocstring(lines, startLine),
        });
        // A local function may declare local functions of its own (fix
        // #395: AutoMapper's `MapCollectionCore` holds `GetDestinationType`).
        return true;
    });
    const topLevel = (tree.rootNode.namedChildren || []).filter(child =>
        child.type === 'global_statement');
    if (topLevel.length > 0) {
        functions.push({
            name: 'Main',
            params: '',
            paramsStructured: [],
            returnType: null,
            startLine: topLevel[0].startPosition.row + 1,
            endLine: topLevel[topLevel.length - 1].endPosition.row + 1,
            indent: topLevel[0].startPosition.column,
            modifiers: ['static', 'top-level'],
            namespace: namespaceOf(topLevel[0], tree) || undefined,
        });
    }
    return functions;
}

function findStateObjects(code, parser) {
    const views = csharpViews(parser, code);
    if (!views) return findStateObjectsInTree(code, safeParse(parser, code, undefined, PARSE_OPTIONS));
    return csMergeViewItems(views, (tree, reaches) => findStateObjectsInTree(code, tree, reaches), state => state.startLine)
        .sort((a, b) => a.startLine - b.startLine);
}

function findStateObjectsInTree(code, tree, reaches = null) {
    const lines = code.split('\n');
    const states = [];
    traverseTreeCached(tree.rootNode, node => {
        if (reaches && !reaches(node)) return false;
        if (node.type !== 'global_statement') return true;
        const declaration = node.namedChildren.find(child =>
            child.type === 'local_declaration_statement')?.namedChild(0);
        for (const declarator of declaration?.namedChildren || []) {
            if (declarator.type !== 'variable_declarator') continue;
            const nameNode = declarator.childForFieldName('name');
            if (!nameNode) continue;
            const { startLine, endLine, indent } = nodeToLocation(node, lines);
            states.push({
                name: nameNode.text,
                startLine,
                endLine,
                indent,
                modifiers: [],
            });
        }
        return false;
    });
    return states;
}

const TASK_WRAPPERS = new Set(['Task', 'ValueTask']);

/** The written type a target-typed `new(...)` constructs, or null (fix #393). */
function implicitCreationTarget(node) {
    const typeOf = typeNode => {
        if (!typeNode) return null;
        let current = typeNode;
        if (current.type === 'nullable_type') current = current.namedChild(0);
        if (!current || !['identifier', 'qualified_name', 'generic_name'].includes(current.type)) return null;
        if (current.text === 'var' || current.text === 'dynamic') return null;
        return current;
    };
    const parent = node.parent;
    if (!parent) return null;
    if (parent.type === 'variable_declarator') {
        const declaration = parent.parent;
        return declaration?.type === 'variable_declaration' ? typeOf(declaration.childForFieldName('type')) : null;
    }
    if (parent.type === 'equals_value_clause' && parent.parent?.type === 'property_declaration') {
        return typeOf(parent.parent.childForFieldName('type'));
    }
    // An auto-property initializer (`List<T> Items { get; } = new();`, fix #395).
    if (parent.type === 'property_declaration' && sameNode(parent.childForFieldName('value'), node)) {
        return typeOf(parent.childForFieldName('type'));
    }
    if (parent.type !== 'return_statement' && parent.type !== 'arrow_expression_clause') return null;
    for (let owner = parent.parent; owner; owner = owner.parent) {
        if (owner.type === 'lambda_expression' || owner.type === 'anonymous_method_expression') return null;
        if (owner.type === 'accessor_declaration') {
            const keyword = owner.childForFieldName('name')?.text || owner.child(0)?.text;
            if (keyword !== 'get') return null;
            continue;
        }
        if (owner.type === 'property_declaration' || owner.type === 'indexer_declaration') {
            return typeOf(owner.childForFieldName('type'));
        }
        if (owner.type === 'method_declaration' || owner.type === 'local_function_statement') {
            const returns = owner.childForFieldName('returns') || owner.childForFieldName('type');
            const isAsync = (owner.children || []).some(child => child.type === 'modifier' && child.text === 'async');
            if (isAsync) {
                const generic = returns?.type === 'generic_name' ? returns
                    : returns?.type === 'qualified_name' && returns.namedChildren.at(-1)?.type === 'generic_name'
                        ? returns.namedChildren.at(-1) : null;
                const wrapper = generic?.namedChild(0)?.text;
                const args = generic?.namedChildren.find(child => child.type === 'type_argument_list');
                if (!TASK_WRAPPERS.has(wrapper) || args?.namedChildCount !== 1) return null;
                return typeOf(args.namedChild(0));
            }
            return typeOf(returns);
        }
        if (owner.type === 'constructor_declaration' || TYPE_DECLARATIONS.has(owner.type)) return null;
    }
    return null;
}

function enclosingFunctionOf(node) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (parent.type === 'method_declaration' ||
            parent.type === 'constructor_declaration' ||
            parent.type === 'local_function_statement') {
            if (isControlFlowLocalArtifact(parent)) continue;
            const nameNode = parent.childForFieldName('name');
            if (!nameNode) return null;
            return {
                name: nameNode.text,
                startLine: parent.startPosition.row + 1,
                endLine: parent.endPosition.row + 1,
            };
        }
        if (parent.type === 'global_statement') {
            return {
                name: 'Main',
                startLine: parent.startPosition.row + 1,
                endLine: parent.endPosition.row + 1,
            };
        }
    }
    return null;
}

function enclosingClassName(node) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (TYPE_DECLARATIONS.has(parent.type)) {
            return parent.childForFieldName('name')?.text || null;
        }
    }
    return null;
}

/** Whether a bare identifier is a field/property/event of the enclosing type. */

const { ReceiverTypeMap, typeOrigin } = require('./type-evidence');

function enclosingTypeDeclaresMember(node, memberName) {
    let typeNode = null;
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (TYPE_DECLARATIONS.has(parent.type)) {
            typeNode = parent;
            break;
        }
    }
    const body = typeNode?.childForFieldName('body') ||
        typeNode?.namedChildren.find(child => child.type === 'declaration_list');
    if (!body) return false;
    const stack = [...(body.namedChildren || [])];
    while (stack.length > 0) {
        const current = stack.pop();
        if (TYPE_DECLARATIONS.has(current.type)) continue;
        if (current.type === 'property_declaration' ||
            current.type === 'event_declaration') {
            if (current.childForFieldName('name')?.text === memberName) return true;
            continue;
        }
        if (current.type === 'field_declaration' ||
            current.type === 'event_field_declaration') {
            for (const child of current.namedChildren || []) {
                const variables = child.type === 'variable_declaration'
                    ? child.namedChildren : [child];
                if (variables.some(variable =>
                    variable.type === 'variable_declarator' &&
                    variable.childForFieldName('name')?.text === memberName)) {
                    return true;
                }
            }
            continue;
        }
        // Preprocessor containers can wrap real declarations. Descend through
        // those and the type body, but never into methods/accessors where a
        // same-named local would not make the receiver a class member.
        if (current.type.startsWith('preproc_') || current.type === 'declaration_list') {
            stack.push(...(current.namedChildren || []));
        }
    }
    return false;
}

const _memberTypesByType = new WeakMap();

/**
 * fix #391: the declared type of a bare identifier that names a field or
 * property of its enclosing type (`Write(level, NoPropertyValues)`), or
 * null. A name any local, parameter or pattern variable of the enclosing
 * member binds is never read as the member; a name the type declares more
 * than once (or only through a nested type) has no single type.
 */
function enclosingMemberValueType(identifier) {
    const name = identifier.text;
    let typeNode = null;
    let callable = null;
    for (let parent = identifier.parent; parent; parent = parent.parent) {
        if (!callable && CALLABLE_SCOPE_NODES.has(parent.type)) callable = parent;
        if (TYPE_DECLARATIONS.has(parent.type)) {
            typeNode = parent;
            break;
        }
    }
    if (!typeNode) return null;
    let members = _memberTypesByType.get(typeNode);
    if (!members) {
        members = new Map();
        const record = (memberName, typeText) => {
            if (!memberName || !typeText) return;
            members.set(memberName, members.has(memberName) ? null : typeText);
        };
        const body = typeNode.childForFieldName('body') ||
            typeNode.namedChildren.find(child => child.type === 'declaration_list');
        const stack = [...(body?.namedChildren || [])];
        while (stack.length > 0) {
            const current = stack.pop();
            if (current.type === 'property_declaration') {
                record(current.childForFieldName('name')?.text, current.childForFieldName('type')?.text);
            } else if (current.type === 'field_declaration') {
                const declaration = current.namedChildren.find(child => child.type === 'variable_declaration');
                const typeText = declaration?.childForFieldName('type')?.text;
                for (const variable of declaration?.namedChildren || []) {
                    if (variable.type !== 'variable_declarator') continue;
                    record((variable.childForFieldName('name') || variable.namedChild(0))?.text, typeText);
                }
            } else if (current.type.startsWith('preproc_') || current.type === 'declaration_list') {
                stack.push(...(current.namedChildren || []));
            }
        }
        _memberTypesByType.set(typeNode, members);
    }
    const typeText = members.get(name);
    if (!typeText || typeText === 'var') return null;
    if (callable && _localNamesOfCallable(callable).has(name)) return null;
    return typeText;
}

const _localNamesByCallable = new WeakMap();

// Every name a member binds locally (parameters, locals, lambda and pattern
// variables, foreach and catch variables), one native walk per member.
function _localNamesOfCallable(callable) {
    let names = _localNamesByCallable.get(callable);
    if (names) return names;
    names = new Set();
    for (const node of callable.descendantsOfType(['variable_declarator', 'parameter', 'implicit_parameter',
        'declaration_expression', 'declaration_pattern', 'foreach_statement', 'catch_declaration'])) {
        const bound = node.type === 'implicit_parameter' ? node
            : node.type === 'foreach_statement' ? node.childForFieldName('left')
                : node.childForFieldName('name') || node.namedChildren.at(-1);
        if (bound?.text) names.add(bound.text);
    }
    // `params T[] name` parameters are siblings of the list (structuredParams).
    const list = callable.childForFieldName('parameters');
    for (let i = 0; list && i < list.childCount; i++) {
        const child = list.child(i);
        if (child.type === 'identifier') names.add(child.text);
    }
    _localNamesByCallable.set(callable, names);
    return names;
}

const CALLABLE_SCOPE_NODES = new Set([
    'method_declaration', 'constructor_declaration', 'destructor_declaration',
    'operator_declaration', 'conversion_operator_declaration',
    'local_function_statement', 'accessor_declaration',
]);

function variableScopeKey(node) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (CALLABLE_SCOPE_NODES.has(parent.type)) {
            if (isControlFlowLocalArtifact(parent)) continue;
            return parent.startPosition.row + 1;
        }
        if (parent.type === 'global_statement') return 'global';
    }
    return 'global';
}

const localBindingFactsByTree = new WeakMap();

/**
 * Local binding facts of one callable (fix #381): how many times each name
 * is declared (locals, parameters, pattern/out variables, foreach and catch
 * variables, lambda parameters) and which names are assigned after their
 * declaration. A one-hop `var` alias needs one declaration and no
 * assignment.
 */
function csharpLocalBindingFacts(fnNode) {
    let byId = localBindingFactsByTree.get(fnNode.tree);
    if (!byId) { byId = new Map(); localBindingFactsByTree.set(fnNode.tree, byId); }
    let facts = byId.get(fnNode.id);
    if (facts) return facts;
    facts = { declared: new Map(), assigned: new Set(), shapes: new Map() };
    const declare = name => { if (name) facts.declared.set(name, (facts.declared.get(name) || 0) + 1); };
    const walk = (node) => {
        for (const child of node.namedChildren || []) {
            if (child.type === 'variable_declarator' || child.type === 'parameter' ||
                child.type === 'foreach_statement' || child.type === 'catch_declaration') {
                const name = child.childForFieldName('name')?.text;
                declare(name);
                // Each declaration's `Declared x = new Constructed(..)` shape
                // (fix #394): several declarations of one name in separate
                // blocks hold the same exact type only when every shape agrees.
                if (name) {
                    if (!facts.shapes.has(name)) facts.shapes.set(name, new Set());
                    facts.shapes.get(name).add(csharpDeclarationShape(child));
                }
            } else if (child.type === 'declaration_pattern' || child.type === 'declaration_expression') {
                declare(child.childForFieldName('name')?.text || child.namedChildren.at(-1)?.text);
            } else if (child.type === 'assignment_expression') {
                const left = child.childForFieldName('left');
                if (left?.type === 'identifier') facts.assigned.add(left.text);
            } else if (child.type === 'prefix_unary_expression' || child.type === 'postfix_unary_expression') {
                const operand = child.namedChildren.find(c => c.type === 'identifier');
                if (operand) facts.assigned.add(operand.text);
            } else if (child.type === 'argument' &&
                (child.child(0)?.type === 'ref' || child.child(0)?.type === 'out')) {
                const operand = child.namedChildren.find(c => c.type === 'identifier');
                if (operand) facts.assigned.add(operand.text);
            }
            walk(child);
        }
    };
    walk(fnNode);
    byId.set(fnNode.id, facts);
    return facts;
}

/** `Declared|Constructed` text of a variable declarator, or '?' for any other shape. */
function csharpDeclarationShape(declarator) {
    if (declarator.type !== 'variable_declarator') return '?';
    const declaration = declarator.parent;
    const typeText = declaration?.type === 'variable_declaration'
        ? declaration.childForFieldName('type')?.text : null;
    const value = csharpDeclaratorValue(declarator);
    const constructed = value?.type === 'object_creation_expression' ? value.childForFieldName('type')?.text : null;
    return typeText && constructed ? `${typeText.replace(/\s+/g, '')}|${constructed.replace(/\s+/g, '')}` : '?';
}

function csharpEnclosingCallable(node) {
    for (let parent = node?.parent; parent; parent = parent.parent) {
        if (CALLABLE_SCOPE_NODES.has(parent.type) && !isControlFlowLocalArtifact(parent)) return parent;
    }
    return null;
}

/** Initializer of a variable declarator (the node after its name). */
function csharpDeclaratorValue(declarator) {
    const named = declarator.namedChildren || [];
    return declarator.childForFieldName('value') ||
        (named.length === 2 && named[0].type === 'identifier' ? named[1] : null);
}

/** A `var` local declared once and never assigned in its callable. */
function csharpSingleVarLocal(declarator, name) {
    const declaration = declarator.parent;
    if (declaration?.type !== 'variable_declaration' ||
        declaration.childForFieldName('type')?.text !== 'var') return false;
    const fnNode = csharpEnclosingCallable(declarator);
    if (!fnNode) return false;
    const facts = csharpLocalBindingFacts(fnNode);
    return facts.declared.get(name) === 1 && !facts.assigned.has(name);
}

/**
 * The member access a one-hop `var` alias stands for (fix #381): `var c =
 * this.config;` or `var c = config;` (a field or property of the enclosing
 * type), when `c` is declared once and never assigned. Null otherwise.
 */
function csharpFieldAliasOf(identNode) {
    const fnNode = csharpEnclosingCallable(identNode);
    if (!fnNode) return null;
    const name = identNode.text;
    const facts = csharpLocalBindingFacts(fnNode);
    if (facts.declared.get(name) !== 1 || facts.assigned.has(name)) return null;
    let found = null;
    const stack = [fnNode];
    while (stack.length > 0 && !found) {
        const current = stack.pop();
        for (const child of current.namedChildren || []) {
            if (child.type === 'variable_declarator' &&
                child.childForFieldName('name')?.text === name) {
                found = child;
                break;
            }
            stack.push(child);
        }
    }
    if (!found || found.endIndex > identNode.startIndex || !csharpSingleVarLocal(found, name)) return null;
    const value = csharpDeclaratorValue(found);
    if (!value) return null;
    if (value.type === 'member_access_expression' && value.namedChildCount === 1 &&
        ['this', 'this_expression'].includes(value.child(0)?.type)) {
        return value;
    }
    if (value.type === 'identifier' && value.text !== name && !facts.declared.has(value.text) &&
        enclosingTypeDeclaresMember(identNode, value.text)) {
        return value;
    }
    return null;
}

function buildVariableTypes(tree, parser) {
    const byScope = new Map([['global', new ReceiverTypeMap()]]);
    const conflictsByScope = new Map([['global', new Set()]]);
    const scopeStack = [];
    const setType = (scope, name, type, source = 'unknown', node = null) => {
        if (!name || !type) return;
        if (!conflictsByScope.has(scope)) conflictsByScope.set(scope, new Set());
        const conflicts = conflictsByScope.get(scope);
        if (conflicts.has(name)) return;
        const types = byScope.get(scope);
        const previous = types.get(name);
        if (previous && previous !== type) {
            types.delete(name);
            conflicts.add(name);
            return;
        }
        types.set(name, type, source, node);
    };
    traverseTree(tree.rootNode, node => {
        if (CALLABLE_SCOPE_NODES.has(node.type) &&
            !isControlFlowLocalArtifact(node)) {
            const key = node.startPosition.row + 1;
            scopeStack.push(key);
            if (!byScope.has(key)) byScope.set(key, new ReceiverTypeMap());
            if (!conflictsByScope.has(key)) conflictsByScope.set(key, new Set());
        }
        const currentKey = scopeStack[scopeStack.length - 1] || 'global';
        if (isControlFlowLocalArtifact(node)) {
            const paramsNode = node.childForFieldName('parameters');
            const raw = paramsNode?.text;
            if (raw?.startsWith('(') && raw.endsWith(')')) {
                const expression = raw.slice(1, -1);
                const synthetic =
                    `class __UcnRecovery { bool __Call() => ${expression}; }`;
                const recovered = safeParse(
                    parser, synthetic, undefined, PARSE_OPTIONS);
                traverseTree(recovered.rootNode, recoveredNode => {
                    if (recoveredNode.type !== 'declaration_pattern' &&
                        recoveredNode.type !== 'declaration_expression') {
                        return true;
                    }
                    const name =
                        recoveredNode.childForFieldName('name')?.text ||
                        recoveredNode.namedChildren.at(-1)?.text;
                    const type =
                        recoveredNode.childForFieldName('type')?.text ||
                        recoveredNode.namedChild(0)?.text;
                    setType(currentKey, name, type, 'annotation', node);
                    return true;
                });
            }
        }
        if (node.type === 'parameter_list') {
            // `params T[] name` is three siblings of the list (see
            // structuredParams): its name is a typed parameter too (fix #391).
            for (let i = 0; i < node.childCount; i++) {
                if (node.child(i).type !== 'params') continue;
                const named = [];
                for (let j = i + 1; j < node.childCount && named.length < 2; j++) {
                    const child = node.child(j);
                    if (child.type === ',' || child.type === ')') break;
                    if (child.isNamed) named.push(child);
                }
                if (named.length === 2 && named[1].type === 'identifier') {
                    setType(currentKey, named[1].text, named[0].text, 'annotation', node);
                }
            }
        }
        if (node.type === 'parameter') {
            let artifactParameter = false;
            for (let parent = node.parent; parent; parent = parent.parent) {
                if (isControlFlowLocalArtifact(parent)) {
                    artifactParameter = true;
                    break;
                }
                if (CALLABLE_SCOPE_NODES.has(parent.type)) break;
            }
            if (artifactParameter) return true;
            const name = node.childForFieldName('name')?.text;
            const type = node.childForFieldName('type')?.text;
            setType(currentKey, name, type, 'annotation', node);
        } else if (node.type === 'declaration_pattern' ||
            node.type === 'declaration_expression') {
            const name = node.childForFieldName('name')?.text ||
                node.namedChildren.at(-1)?.text;
            const type = node.childForFieldName('type')?.text ||
                node.namedChild(0)?.text;
            setType(currentKey, name, type, 'annotation', node);
        } else if (node.type === 'variable_declaration') {
            // Class fields have their own declared-field receiver path; do not
            // leak them into the top-level-program local scope.
            if (scopeStack.length === 0) {
                let inGlobal = false;
                for (let parent = node.parent; parent; parent = parent.parent) {
                    if (parent.type === 'global_statement') {
                        inGlobal = true;
                        break;
                    }
                    if (TYPE_DECLARATIONS.has(parent.type)) break;
                }
                if (!inGlobal) return true;
            }
            const typeNode = node.childForFieldName('type');
            // A disabled preprocessor branch can make a switch label plus
            // following invocation look like `case <declarator>`. `case` is
            // not a type, so it must never overwrite a real parameter/local
            // receiver type (for example `JsonWriter writer`).
            if (typeNode?.text === 'case') return true;
            for (const declarator of node.namedChildren || []) {
                if (declarator.type !== 'variable_declarator') continue;
                const name = declarator.childForFieldName('name')?.text;
                const value = declarator.childForFieldName('value') ||
                    declarator.namedChildren.find(child => child.type === 'object_creation_expression');
                const dynamicType = value?.type === 'object_creation_expression'
                    ? value.childForFieldName('type')?.text : null;
                // `var c = items[i]` takes the declared element (fix #359).
                let elementType = null;
                const indexedValue = value ||
                    declarator.namedChildren.find(child => child.type === 'element_access_expression');
                if (!dynamicType && typeNode?.text === 'var' &&
                    indexedValue?.type === 'element_access_expression') {
                    const indexed = indexedReceiverType(indexedValue, byScope.get(currentKey));
                    if (indexed) {
                        elementType = indexed.namespace
                            ? `${indexed.namespace}.${indexed.name}` : indexed.name;
                    }
                }
                // The declared type is the receiver's static type (fix
                // #394): `IShape s = new Square(); s.Area()` binds
                // IShape.Area. `var` takes the constructed type; a
                // declaration of the constructed type keeps the exact
                // constructor evidence.
                const declared = typeNode?.text && typeNode.text !== 'var' ? typeNode.text : null;
                const constructorTyped = !!dynamicType && (!declared ||
                    declared.replace(/\s+/g, '') === dynamicType.replace(/\s+/g, ''));
                const type = declared || dynamicType || elementType;
                // A local declared once and never assigned holds exactly the
                // constructed value: dispatch reaches that type's member,
                // never an unrelated implementation of the declared type.
                const fnOfLocal = dynamicType && declared && !constructorTyped
                    ? csharpEnclosingCallable(declarator) : null;
                const facts = fnOfLocal ? csharpLocalBindingFacts(fnOfLocal) : null;
                const shapes = facts?.shapes.get(name);
                const exactOrigin = facts && !facts.assigned.has(name) && shapes?.size === 1 && !shapes.has('?')
                    ? { ...typeOrigin('annotation', typeNode), constructedType: dynamicType } : null;
                setType(currentKey, name, type, exactOrigin || (constructorTyped ? 'constructor' : 'annotation'),
                    constructorTyped ? value : (declared ? typeNode : (value || typeNode)));
                // fix #381: `var c = cfg;` carries cfg's type when c is a
                // single, never-assigned local.
                const aliasValue = csharpDeclaratorValue(declarator);
                if (!type && aliasValue?.type === 'identifier' && aliasValue.text !== name &&
                    byScope.get(currentKey)?.has(aliasValue.text) && csharpSingleVarLocal(declarator, name)) {
                    const types = byScope.get(currentKey);
                    setType(currentKey, name, types.get(aliasValue.text),
                        types.origins.get(aliasValue.text) || 'flow');
                }
            }
        }
        return true;
    }, {
        onLeave(node) {
            if (CALLABLE_SCOPE_NODES.has(node.type) &&
                !isControlFlowLocalArtifact(node)) {
                scopeStack.pop();
            }
        },
    });
    return byScope;
}

function normalizeReceiverType(raw) {
    if (!raw) return null;
    let value = String(raw).trim().replace(/\?$/, '');
    if (value.endsWith('[]')) return { name: 'Array', namespace: 'System' };
    value = value.replace(/^global::/, '').replace(/::/g, '.');
    const match = value.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:<.*>)?$/s);
    if (!match) return null;
    const parts = match[1].split('.');
    const typeArgs = genericArityOf(value);
    return {
        name: parts.pop(),
        ...(parts.length > 0 && { namespace: parts.join('.') }),
        ...(typeArgs > 0 && { typeArgs }),
    };
}

// Indexer contracts of BCL collections (fix #359): `Conv[] a` / `List<Conv>`
// index to Conv, `Dictionary<K, Conv>` keys to Conv. The declared element slot
// is read from the declaration's type text; anything else abstains.
const CSHARP_LIST_INDEXERS = new Set(['List', 'IList', 'IReadOnlyList', 'Collection', 'ReadOnlyCollection']);
const CSHARP_MAP_INDEXERS = new Set([
    'Dictionary', 'IDictionary', 'IReadOnlyDictionary', 'SortedDictionary',
    'SortedList', 'ConcurrentDictionary',
]);
function csharpIndexerElementText(raw) {
    if (!raw) return null;
    const value = String(raw).trim().replace(/\?$/, '');
    if (value.endsWith('[]')) {
        const inner = value.slice(0, -2).trim();
        return inner && !inner.includes('[') ? inner : null;
    }
    const open = value.indexOf('<');
    if (open <= 0 || !value.endsWith('>')) return null;
    const base = value.slice(0, open).trim().split('.').pop();
    const args = [];
    let depth = 0;
    let start = open + 1;
    for (let i = open + 1; i < value.length - 1; i++) {
        const ch = value[i];
        if (ch === '<' || ch === '[' || ch === '(') depth++;
        else if (ch === '>' || ch === ']' || ch === ')') depth--;
        else if (ch === ',' && depth === 0) {
            args.push(value.slice(start, i).trim());
            start = i + 1;
        }
    }
    args.push(value.slice(start, value.length - 1).trim());
    if (CSHARP_LIST_INDEXERS.has(base) && args.length === 1) return args[0];
    if (CSHARP_MAP_INDEXERS.has(base) && args.length === 2) return args[1];
    return null;
}

function indexedReceiverType(node, variableTypes) {
    if (node?.type !== 'element_access_expression') return null;
    const expression = node.childForFieldName('expression') || node.namedChild(0);
    if (expression?.type !== 'identifier') return null;
    const element = csharpIndexerElementText(variableTypes?.get(expression.text));
    const normalized = normalizeReceiverType(element);
    if (!normalized || /^[A-Z][A-Z0-9]?$/.test(normalized.name) ||
        normalized.name === 'Array') return null;
    return normalized;
}

function literalReceiverType(node) {
    if (!node) return null;
    if (node.type === 'string_literal' ||
        node.type === 'verbatim_string_literal' ||
        node.type === 'interpolated_string_expression') {
        return { name: 'string', namespace: 'System' };
    }
    if (node.type === 'character_literal') {
        return { name: 'char', namespace: 'System' };
    }
    return null;
}

function unwrapReceiverNode(node) {
    let current = node;
    while (current && current.namedChildCount === 1 &&
        (current.type === 'parenthesized_expression' ||
         current.type === 'postfix_unary_expression')) {
        current = current.namedChild(0);
    }
    return current;
}

/**
 * Preserve compiler-visible receiver types which do not come from a local
 * declaration. Casts are especially important in C#: `((IList)value).Add()`
 * performs lookup on IList, not on every project method named Add.
 */
function receiverTypeFromNode(node, variableTypes) {
    const current = unwrapReceiverNode(node);
    if (!current) return null;
    const literal = literalReceiverType(current);
    if (literal) return literal;
    if (current.type === 'cast_expression') {
        return normalizeReceiverType(current.childForFieldName('type')?.text);
    }
    if (current.type === 'object_creation_expression') {
        return normalizeReceiverType(current.childForFieldName('type')?.text);
    }
    if (current.type === 'identifier') {
        return normalizeReceiverType(variableTypes?.get(current.text));
    }
    return indexedReceiverType(current, variableTypes);
}

function receiverCastIsThis(node) {
    const current = unwrapReceiverNode(node);
    if (current?.type !== 'cast_expression') return false;
    const value = unwrapReceiverNode(current.childForFieldName('value') ||
        current.namedChildren[current.namedChildCount - 1]);
    return value?.text === 'this' || value?.text === 'base';
}

/**
 * Decompose a receiver into a declared root plus a member path. Query-time
 * resolution walks the indexed field/property types one hop at a time. This
 * covers `_list!.CopyTo()`, `_resolver.LoadedSchemas.Add()`, and conditional
 * access without guessing a final runtime type in the parser.
 */
function receiverFieldPath(node, variableTypes, enclosingClass) {
    const current = unwrapReceiverNode(node);
    if (!current) return null;
    if (current.type === 'this_expression' || current.type === 'base_expression' ||
        current.text === 'this' || current.text === 'base') {
        return enclosingClass
            ? { root: current.text, fields: [], rootType: enclosingClass }
            : null;
    }
    if (current.type === 'identifier') {
        const declared = normalizeReceiverType(variableTypes?.get(current.text));
        if (declared) {
            return {
                root: current.text,
                fields: [],
                rootType: declared.name,
                ...(declared.namespace && { rootNamespace: declared.namespace }),
                ...(declared.typeArgs && { rootTypeArgs: declared.typeArgs }),
            };
        }
        return {
            root: 'this',
            fields: [current.text],
            ...(enclosingClass && { rootType: enclosingClass }),
        };
    }
    if (current.type === 'member_access_expression') {
        const expression = current.childForFieldName('expression') || current.namedChild(0);
        const member = current.childForFieldName('name') ||
            current.namedChildren[current.namedChildCount - 1];
        const path = receiverFieldPath(expression, variableTypes, enclosingClass);
        return path && member
            ? { ...path, fields: [...path.fields, member.text] }
            : null;
    }
    if (current.type === 'conditional_access_expression') {
        const expression = current.childForFieldName('condition') || current.namedChild(0);
        const binding = current.namedChildren.find(child =>
            child.type === 'member_binding_expression');
        const member = binding?.childForFieldName('name') || binding?.namedChild(0);
        const path = receiverFieldPath(expression, variableTypes, enclosingClass);
        return path && member
            ? { ...path, fields: [...path.fields, member.text] }
            : null;
    }
    return null;
}

function invocationIdentity(node) {
    if (!node) return {};
    if (node.type === 'identifier' || node.type === 'generic_name') {
        return { name: node.type === 'generic_name' ? node.namedChild(0)?.text : node.text,
            nameNode: node, isMethod: false };
    }
    if (node.type === 'member_access_expression' || node.type === 'member_binding_expression') {
        const nameNode = node.childForFieldName('name') ||
            node.namedChildren[node.namedChildCount - 1];
        const expression = node.childForFieldName('expression') || node.namedChild(0);
        return {
            name: nameNode?.type === 'generic_name' ? nameNode.namedChild(0)?.text : nameNode?.text,
            nameNode,
            receiver: expression?.text,
            isMethod: true,
        };
    }
    if (node.type === 'conditional_access_expression') {
        const expression = node.childForFieldName('condition') ||
            node.namedChild(0);
        const binding = node.namedChildren.find(child =>
            child.type === 'member_binding_expression');
        const nameNode = binding?.childForFieldName('name') ||
            binding?.namedChild(0);
        return {
            name: nameNode?.type === 'generic_name'
                ? nameNode.namedChild(0)?.text : nameNode?.text,
            nameNode,
            receiver: expression?.text,
            isMethod: true,
        };
    }
    return {};
}

function staticMemberPath(node, variableTypes) {
    if (!node) return null;
    if (node.type === 'identifier') {
        const type = variableTypes?.get(node.text);
        if (type) return [type];
        return /^[A-Z]/.test(node.text) ? [node.text] : null;
    }
    if (node.type === 'member_access_expression') {
        const expression = node.childForFieldName('expression') ||
            node.namedChild(0);
        const member = node.childForFieldName('name') ||
            node.namedChildren[node.namedChildCount - 1];
        const path = staticMemberPath(expression, variableTypes);
        return path && member ? [...path, member.text] : null;
    }
    if (node.type === 'element_access_expression') {
        const expression = node.childForFieldName('expression') ||
            node.namedChild(0);
        const path = staticMemberPath(expression, variableTypes);
        return path ? [...path, '[]'] : null;
    }
    if (node.type === 'conditional_access_expression') {
        const expression = node.childForFieldName('condition') ||
            node.namedChild(0);
        const binding = node.namedChildren.find(child =>
            child.type === 'member_binding_expression');
        const member = binding?.childForFieldName('name') ||
            binding?.namedChild(0);
        const path = staticMemberPath(expression, variableTypes);
        return path && member ? [...path, member.text] : null;
    }
    if (node.type === 'parenthesized_expression' &&
        node.namedChildCount === 1) {
        return staticMemberPath(node.namedChild(0), variableTypes);
    }
    return null;
}

function staticArgKind(node, variableTypes) {
    if (!node) return 'expr';
    switch (node.type) {
        case 'string_literal':
        case 'verbatim_string_literal':
        case 'interpolated_string_expression':
            return 'string';
        case 'character_literal':
            return 'char';
        case 'integer_literal':
            return /[lL]$/.test(node.text) ? 'long' : 'int';
        case 'real_literal':
            return /[fF]$/.test(node.text) ? 'float' : 'double';
        case 'boolean_literal':
            return 'boolean';
        case 'null_literal':
            return 'null';
        case 'object_creation_expression': {
            const type = node.childForFieldName('type');
            return type ? `new:${type.text}` : 'expr';
        }
        case 'array_creation_expression': {
            const type = node.childForFieldName('type');
            // `new object[0]` is an object[]: the rank's sizes are not part
            // of the type (fix #391).
            return type ? `type:${type.text.replace(/\[([^\]]*)\]/g, (_, inner) =>
                `[${','.repeat((inner.match(/,/g) || []).length)}]`)}` : 'expr';
        }
        case 'cast_expression': {
            const type = node.childForFieldName('type');
            return type ? `cast:${type.text}` : 'expr';
        }
        case 'identifier': {
            const type = variableTypes?.get(node.text) || enclosingMemberValueType(node);
            return type ? `type:${type}` : 'expr';
        }
        case 'member_access_expression': {
            const path = staticMemberPath(node, variableTypes);
            if (path?.length > 1) {
                return `fieldpath:${path.map(encodeURIComponent).join('|')}`;
            }
            const owner = node.childForFieldName('expression') || node.namedChild(0);
            const member = node.childForFieldName('name') ||
                node.namedChildren[node.namedChildCount - 1];
            if (!owner || !member) return 'expr';
            const ownerType = owner.type === 'identifier'
                ? variableTypes?.get(owner.text)
                : null;
            return `field:${ownerType || owner.text}:${member.text}`;
        }
        case 'invocation_expression': {
            const identity = invocationIdentity(node.childForFieldName('function'));
            if (identity.name === 'GetValueOrDefault' && identity.receiver) {
                const rawType = variableTypes?.get(identity.receiver);
                if (rawType?.trim().endsWith('?')) {
                    return `type:${rawType.trim().slice(0, -1)}`;
                }
            }
            if (identity.name === 'ToString') return 'type:string';
            if (identity.receiver === 'Convert' &&
                CONVERT_RETURN_TYPES.has(identity.name)) {
                return `type:${CONVERT_RETURN_TYPES.get(identity.name)}`;
            }
            if (identity.receiver) {
                const receiverType = variableTypes?.get(identity.receiver) ||
                    identity.receiver;
                const argsNode = node.childForFieldName('arguments') ||
                    node.namedChildren.find(child =>
                        child.type === 'argument_list');
                const kinds = (argsNode?.namedChildren || [])
                    .filter(child => child.type === 'argument')
                    .map(argument =>
                        staticArgKind(argument.namedChild(0), variableTypes));
                return `callshape:${encodeURIComponent(receiverType)}|` +
                    `${encodeURIComponent(identity.name)}|` +
                    kinds.map(encodeURIComponent).join(',');
            }
            return 'expr';
        }
        case 'conditional_access_expression': {
            const path = staticMemberPath(node, variableTypes);
            if (path?.length > 1) {
                return `fieldpath:${path.map(encodeURIComponent).join('|')}`;
            }
            const owner = node.namedChild(0);
            const binding = node.namedChildren.find(child =>
                child.type === 'member_binding_expression');
            const member = binding?.childForFieldName('name') ||
                binding?.namedChild(0);
            if (!owner || !member) return 'expr';
            const ownerType = owner.type === 'identifier'
                ? variableTypes?.get(owner.text)
                : null;
            return `field:${ownerType || owner.text}:${member.text}`;
        }
        case 'conditional_expression': {
            const consequence = node.childForFieldName('consequence');
            const alternative = node.childForFieldName('alternative');
            const left = staticArgKind(consequence, variableTypes);
            const right = staticArgKind(alternative, variableTypes);
            if (left === right) return left;
            const typed = kind => /^(?:new|cast|type):(.+)$/.exec(kind)?.[1] || null;
            const leftType = typed(left);
            const rightType = typed(right);
            if (left === 'null' && rightType) return `type:${rightType}`;
            if (right === 'null' && leftType) return `type:${leftType}`;
            if (leftType && rightType &&
                leftType.replace(/\?$/, '') === rightType.replace(/\?$/, '')) {
                const nullable = leftType.endsWith('?') ? leftType : rightType;
                return `type:${nullable}`;
            }
            return 'expr';
        }
        case 'parenthesized_expression':
            return node.namedChildCount === 1
                ? staticArgKind(node.namedChild(0), variableTypes)
                : 'expr';
        case 'prefix_unary_expression':
            return node.namedChildCount === 1
                ? staticArgKind(node.namedChild(0), variableTypes)
                : 'expr';
        case 'lambda_expression':
        case 'anonymous_method_expression': {
            // Its parameter count selects among delegate overloads (fix
            // #391); `delegate { }` without a list converts to any count.
            const params = node.childForFieldName('parameters');
            if (!params) return 'lambda';
            return params.type === 'parameter_list'
                ? `lambda:${params.namedChildren.filter(child => child.type === 'parameter').length}`
                : 'lambda:1';
        }
        case 'binary_expression': {
            // String concatenation: `+` with a string operand is a string
            // (fix #390).
            if (node.childForFieldName('operator')?.text !== '+') return 'expr';
            const left = node.childForFieldName('left');
            const right = node.childForFieldName('right');
            return staticArgKind(left, variableTypes) === 'string' ||
                staticArgKind(right, variableTypes) === 'string' ? 'string' : 'expr';
        }
        default:
            return 'expr';
    }
}

function callArgs(node, variableTypes) {
    const argsNode = node.childForFieldName('arguments') ||
        node.namedChildren.find(child => child.type === 'argument_list');
    const args = (argsNode?.namedChildren || []).filter(child => child.type === 'argument');
    const argKinds = args.map(argument =>
        staticArgKind(argument.namedChild(0), variableTypes));
    return {
        argCount: args.length,
        ...(argKinds.some(kind => kind !== 'expr') && { argKinds }),
        firstArg: args[0]?.namedChild(0),
        args,
    };
}

function assignmentTargetOf(callNode) {
    let value = callNode;
    let assignedUnwrap = false;
    while (value.parent && (value.parent.type === 'await_expression' ||
        value.parent.type === 'parenthesized_expression')) {
        if (value.parent.type === 'await_expression') assignedUnwrap = true;
        value = value.parent;
    }
    const parent = value.parent;
    if (parent?.type === 'variable_declarator') {
        const name = parent.childForFieldName('name');
        return name ? { assignedTo: name.text, assignedUnwrap } : null;
    }
    if (parent?.type === 'assignment_expression') {
        const left = parent.childForFieldName('left') || parent.namedChild(0);
        return left?.type === 'identifier'
            ? { assignedTo: left.text, assignedUnwrap }
            : null;
    }
    return null;
}

/**
 * A local variable, parameter or lambda parameter named like a bare
 * invocation (`Action Run = ..; Run();`) is the invoked delegate, never a
 * same-named method (fix #369). Walks enclosing blocks (declarations before
 * the call), foreach/catch/using variables, lambda and callable parameters,
 * stopping at the enclosing member. Local functions are methods, not values.
 */
const _csharpLocalNamesByTree = new WeakMap();
/** Every local/parameter/lambda-parameter name the file declares (fix #369). */
function csharpLocalBindingNames(tree) {
    let names = _csharpLocalNamesByTree.get(tree);
    if (names) return names;
    names = new Set();
    for (const node of tree.rootNode.descendantsOfType([
        'variable_declarator', 'parameter', 'implicit_parameter', 'foreach_statement', 'catch_declaration'])) {
        const nameNode = node.type === 'implicit_parameter' ? node
            : node.type === 'foreach_statement' ? node.childForFieldName('left')
                : node.childForFieldName('name') ||
                    (node.type === 'variable_declarator' ? node.namedChild(0) : node.namedChildren.at(-1));
        if (nameNode?.type === 'identifier' || nameNode?.type === 'implicit_parameter') names.add(nameNode.text);
    }
    _csharpLocalNamesByTree.set(tree, names);
    return names;
}

function csharpBareNameShadowedByLocal(callNode, name) {
    const declares = declaration => (declaration?.namedChildren || []).some(child =>
        child.type === 'variable_declarator' &&
        (child.childForFieldName('name') || child.namedChild(0))?.text === name);
    const paramsDeclare = list => (list?.namedChildren || []).some(param =>
        param.type === 'parameter' &&
        (param.childForFieldName('name') || param.namedChildren.at(-1))?.text === name);
    let child = callNode;
    for (let p = callNode.parent; p; child = p, p = p.parent) {
        switch (p.type) {
            case 'block':
            case 'switch_section':
                for (let i = 0; i < p.namedChildCount; i++) {
                    const statement = p.namedChild(i);
                    if (statement.startIndex >= child.startIndex) break;
                    if (statement.type === 'local_declaration_statement' &&
                        declares(statement.namedChildren.find(c => c.type === 'variable_declaration'))) {
                        return true;
                    }
                }
                break;
            case 'foreach_statement': {
                const left = p.childForFieldName('left');
                if (left?.type === 'identifier' && left.text === name) return true;
                break;
            }
            case 'using_statement':
            case 'for_statement':
            case 'fixed_statement': {
                const declaration = p.namedChildren.find(c => c.type === 'variable_declaration');
                if (declaration && !sameNode(declaration, child) && declares(declaration)) return true;
                break;
            }
            case 'catch_clause': {
                const declaration = p.namedChildren.find(c => c.type === 'catch_declaration');
                if ((declaration?.childForFieldName('name') || null)?.text === name) return true;
                break;
            }
            case 'lambda_expression':
            case 'anonymous_method_expression': {
                const implicit = p.namedChildren.find(c => c.type === 'implicit_parameter');
                if (implicit?.text === name) return true;
                if (paramsDeclare(p.childForFieldName('parameters') ||
                    p.namedChildren.find(c => c.type === 'parameter_list'))) return true;
                break;
            }
            case 'local_function_statement':
                // A local function sees its own parameters and the
                // enclosing member's locals declared before it.
                if (paramsDeclare(p.childForFieldName('parameters') ||
                    p.namedChildren.find(c => c.type === 'parameter_list'))) return true;
                break;
            case 'method_declaration':
            case 'constructor_declaration':
            case 'operator_declaration':
            case 'conversion_operator_declaration':
            case 'destructor_declaration':
                return paramsDeclare(p.childForFieldName('parameters') ||
                    p.namedChildren.find(c => c.type === 'parameter_list'));
            case 'accessor_declaration':
            case 'property_declaration':
            case 'indexer_declaration':
            case 'class_declaration':
            case 'struct_declaration':
            case 'record_declaration':
            case 'interface_declaration':
                return false;
            default:
                break;
        }
    }
    return false;
}

function findCallsInCode(code, parser) {
    const views = csharpViews(parser, code);
    if (!views) return findCallsInTree(code, parser, safeParse(parser, code, undefined, PARSE_OPTIONS));
    return csMergeViewItems(views, (tree, reaches) => findCallsInTree(code, parser, tree, reaches), call => call.line)
        .sort((a, b) => a.line - b.line ||
            (a.callSite?.column ?? 0) - (b.callSite?.column ?? 0));
}

function findCallsInTree(code, parser, tree, reaches = null) {
    const variableTypesByScope = buildVariableTypes(tree, parser);
    const calls = [];
    // The variable types in scope at a call (only call nodes ask: the scope
    // walk climbs parents).
    const typesAt = node => variableTypesByScope.get(variableScopeKey(node)) ||
        variableTypesByScope.get('global');
    traverseTree(tree.rootNode, node => {
        if (reaches && !reaches(node)) return false;
        if (isControlFlowLocalArtifact(node)) {
            const paramsNode = node.childForFieldName('parameters');
            const raw = paramsNode?.text;
            if (raw?.startsWith('(') && raw.endsWith(')')) {
                const expression = raw.slice(1, -1);
                const synthetic = `class __UcnRecovery { bool __Call() => ${expression}; }`;
                const recovered = findCallsInCode(synthetic, parser);
                for (const call of recovered) {
                    calls.push({
                        ...call,
                        line: node.startPosition.row + call.line,
                        enclosingFunction: enclosingFunctionOf(node),
                    });
                }
            }
            // Keep traversing the artifact's real block; its body still
            // contains valid invocation AST nodes.
            return true;
        }
        if (node.type === 'invocation_expression') {
            const identity = invocationIdentity(node.childForFieldName('function'));
            if (!identity.name) return true;
            const variableTypes = typesAt(node);
            const args = callArgs(node, variableTypes);
            const first = extractStringArg(args.firstArg);
            let receiverRoot = identity.receiver?.split('.')[0];
            const functionNode = node.childForFieldName('function');
            let receiverNode = functionNode?.type === 'member_access_expression'
                ? functionNode.childForFieldName('expression') || functionNode.namedChild(0)
                : functionNode?.type === 'conditional_access_expression'
                    ? functionNode.childForFieldName('condition') || functionNode.namedChild(0)
                    : null;
            // fix #381: `c.Load()` after `var c = this.config;` receives
            // exactly like `this.config.Load()`.
            if (receiverNode?.type === 'identifier' && !variableTypes.has(receiverNode.text)) {
                const aliased = csharpFieldAliasOf(receiverNode);
                if (aliased) {
                    receiverNode = aliased;
                    identity.receiver = aliased.text;
                    receiverRoot = aliased.text.split('.')[0];
                }
            }
            const unwrappedReceiverNode = unwrapReceiverNode(receiverNode);
            // A root variable's type is the receiver type only for a direct
            // `value.Method()` call. For `value.Property.Method()` the static
            // receiver type is the property's declared type, not `value`'s
            // type. Preserve that shape as a field path for query-time
            // declaration walking; collapsing it to the root class falsely
            // confirms sibling overrides (Newtonsoft JProperty.Value is a
            // JToken, not a JProperty).
            const receiverTypeInfo = receiverTypeFromNode(
                receiverNode, variableTypes) ||
                (unwrappedReceiverNode?.type === 'identifier'
                    ? normalizeReceiverType(
                        receiverRoot && variableTypes.get(receiverRoot))
                    : null);
            const receiverType = receiverTypeInfo?.name;
            const receiverCastThis = receiverCastIsThis(receiverNode);
            // `Outcome<int>.Create()`: a generic type name is only ever a
            // type (fix #380); its arity is part of the type's identity.
            const genericTypeReceiver = identity.isMethod &&
                unwrappedReceiverNode?.type === 'generic_name' &&
                /^[A-Z]/.test(unwrappedReceiverNode.namedChild(0)?.text || '')
                ? unwrappedReceiverNode : null;
            if (genericTypeReceiver) identity.receiver = genericTypeReceiver.namedChild(0).text;
            const receiverIsTypeQualified = !!(identity.isMethod &&
                (genericTypeReceiver || (unwrappedReceiverNode?.type === 'identifier' &&
                /^[A-Z]/.test(identity.receiver || '') &&
                !variableTypes.has(identity.receiver) &&
                !enclosingTypeDeclaresMember(node, identity.receiver))));
            const receiverTypeArgs = genericTypeReceiver
                ? genericArityOf(genericTypeReceiver.text) : 0;
            const currentNamespace = namespaceOf(node, tree);
            let receiverCall = null;
            let receiverCallIsMethod = false;
            let receiverCallLine = null;
            let receiverCallReceiver = null;
            if (receiverNode?.type === 'invocation_expression') {
                const producer = invocationIdentity(receiverNode.childForFieldName('function'));
                if (producer.name) {
                    receiverCall = producer.name;
                    receiverCallIsMethod = producer.isMethod;
                    receiverCallLine = producer.nameNode?.startPosition.row + 1 ||
                        receiverNode.startPosition.row + 1;
                    receiverCallReceiver = producer.receiver;
                }
            }
            const assignment = assignmentTargetOf(node);
            let fieldRoot, fieldName, fieldNames, fieldRootType, fieldRootNamespace, fieldRootTypeArgs;
            if (identity.isMethod && !receiverType && identity.receiver &&
                !receiverIsTypeQualified) {
                const fieldPath = receiverFieldPath(
                    receiverNode, variableTypes, enclosingClassName(node));
                if (fieldPath?.fields.length) {
                    fieldRoot = fieldPath.root;
                    fieldNames = fieldPath.fields;
                    fieldName = fieldNames[fieldNames.length - 1];
                    fieldRootType = fieldPath.rootType;
                    fieldRootNamespace = fieldPath.rootNamespace || currentNamespace;
                    fieldRootTypeArgs = fieldPath.rootTypeArgs;
                }
            }
            const functionIsBareName = functionNode?.type === 'identifier' &&
                csharpLocalBindingNames(tree).has(identity.name);
            // `M<string>(..)`: explicit method type arguments (fix #391).
            const methodTypeArgs = identity.nameNode?.type === 'generic_name'
                ? genericArityOf(identity.nameNode.text) : 0;
            calls.push({
                callSite: typeOrigin('call', identity.nameNode || node),
                name: identity.name,
                line: identity.nameNode?.startPosition.row + 1 || node.startPosition.row + 1,
                isMethod: identity.isMethod,
                ...(methodTypeArgs > 0 && { methodTypeArgs }),
                ...(functionIsBareName && csharpBareNameShadowedByLocal(node, identity.name) &&
                    { localShadow: true }),
                ...(identity.receiver && { receiver: identity.receiver }),
                ...(receiverIsTypeQualified && { receiverIsTypeQualified: true }),
                ...(receiverTypeArgs > 0 && { receiverTypeArgs }),
                ...(receiverType && receiverTypeInfo.typeArgs && { receiverTypeArgs: receiverTypeInfo.typeArgs }),
                ...(receiverType && { receiverType, ...(unwrappedReceiverNode?.type === 'cast_expression' ? {
                    receiverTypeSource: 'cast', receiverTypeEvidence: typeOrigin('cast', unwrappedReceiverNode),
                } : unwrappedReceiverNode?.type === 'object_creation_expression' ? {
                    receiverTypeSource: 'constructor', receiverTypeEvidence: typeOrigin('constructor', unwrappedReceiverNode),
                } : literalReceiverType(unwrappedReceiverNode) ? {
                    receiverTypeSource: 'literal', receiverTypeEvidence: typeOrigin('literal', unwrappedReceiverNode),
                } : unwrappedReceiverNode?.type === 'element_access_expression' ? {
                    receiverTypeSource: 'annotation', receiverTypeEvidence: typeOrigin('annotation', unwrappedReceiverNode),
                } : variableTypes.fields(identity.receiver)) }),
                ...(receiverCastThis && { receiverCastThis: true }),
                ...(receiverType && receiverTypeInfo.namespace && {
                    receiverTypeNamespace: receiverTypeInfo.namespace,
                }),
                ...(fieldName && {
                    receiverRoot: fieldRoot,
                    receiverField: fieldName,
                    receiverFields: fieldNames,
                    ...(fieldRootType && { receiverRootType: fieldRootType }),
                    ...(fieldRootNamespace && { receiverRootNamespace: fieldRootNamespace }),
                    ...(fieldRootTypeArgs && { receiverRootTypeArgs: fieldRootTypeArgs }),
                }),
                ...(receiverCall && { receiverCall }),
                // The receiver IS the producer call (fix #395): chained
                // consumers are typed from their producer, never read as a
                // type name spelled like the receiver text.
                ...(receiverCall && { receiverIsChainRoot: true }),
                ...(receiverCallIsMethod && { receiverCallIsMethod: true }),
                ...(receiverCallLine && { receiverCallLine }),
                ...(receiverCallReceiver && { receiverCallReceiver }),
                ...(assignment?.assignedTo && { assignedTo: assignment.assignedTo }),
                ...(assignment?.assignedUnwrap && { assignedUnwrap: true }),
                argCount: args.argCount,
                ...(args.argKinds && { argKinds: args.argKinds }),
                enclosingFunction: enclosingFunctionOf(node),
                ...(first && {
                    firstStringArg: first.value,
                    firstStringArgInterp: first.interp,
                }),
            });
            // Minimal API registrations and other framework callbacks pass
            // method groups as arguments (`app.MapGet("/x", Handle)`). Keep
            // those references in the same call cache so entrypoint detection
            // and ordinary caller analysis share one AST-derived record.
            for (const argument of args.args.slice(1)) {
                const value = argument.namedChild(0);
                if (!value) continue;
                let callbackName = null;
                let callbackReceiver = null;
                if (value.type === 'identifier') {
                    callbackName = value.text;
                } else if (value.type === 'member_access_expression') {
                    const callback = invocationIdentity(value);
                    callbackName = callback.name;
                    callbackReceiver = callback.receiver;
                }
                if (!callbackName) continue;
                calls.push({
                    callSite: typeOrigin('call', value),
                    name: callbackName,
                    line: value.startPosition.row + 1,
                    isMethod: !!callbackReceiver,
                    ...(callbackReceiver && { receiver: callbackReceiver }),
                    isFunctionReference: true,
                    isPotentialCallback: true,
                    enclosingFunction: enclosingFunctionOf(node),
                });
            }
            return true;
        }
        if (node.type === 'object_creation_expression' ||
            node.type === 'implicit_object_creation_expression') {
            // A target-typed `new(...)` constructs the type its position
            // declares (fix #393): a typed local or field, a property, or
            // the return type of the enclosing member.
            const typeNode = node.childForFieldName('type') ||
                (node.type === 'implicit_object_creation_expression' ? implicitCreationTarget(node) : null);
            if (!typeNode) return true;
            const args = callArgs(node, typesAt(node));
            const raw = typeNode.text.replace(/<.*>$/, '');
            const name = raw.split('.').pop();
            const typeArgs = genericArityOf(typeNode.text);
            // A target-typed site is the `new` token; its type is written
            // elsewhere.
            const targetTyped = !node.childForFieldName('type');
            const siteNode = targetTyped ? (node.child(0) || node) : typeNode;
            calls.push({
                callSite: typeOrigin('call', siteNode),
                name,
                line: siteNode.startPosition.row + 1,
                ...(targetTyped && { targetTyped: true }),
                isMethod: false,
                isConstructor: true,
                ...(typeArgs > 0 && { typeArgs }),
                argCount: args.argCount,
                ...(args.argKinds && { argKinds: args.argKinds }),
                enclosingFunction: enclosingFunctionOf(node),
            });
        }
        return true;
    });
    return calls;
}

function findImportsInCode(code, parser) {
    const views = csharpViews(parser, code);
    if (!views) return findImportsInTree(safeParse(parser, code, undefined, PARSE_OPTIONS));
    return csMergeViewItems(views, findImportsInTree, item => item.line)
        .sort((a, b) => a.line - b.line);
}

function findImportsInTree(tree) {
    const imports = [];
    traverseTreeCached(tree.rootNode, node => {
        if (node.type !== 'using_directive') return true;
        const nameNode = node.childForFieldName('name');
        const named = node.namedChildren || [];
        const moduleNode = named[named.length - 1];
        if (!moduleNode) return false;
        // `global::N.M` names N.M from the global namespace; any other
        // spelling is resolved from the namespace the directive sits in
        // (fix #395), which the directive records.
        const written = moduleNode.text.replace(/\s+/g, '');
        const rooted = written.startsWith('global::');
        const head = node.text.trimStart();
        const isGlobal = /^global\s+using\b/.test(head);
        const enclosing = isGlobal ? null : namespaceOf(node, tree);
        const isStatic = /^(?:global\s+)?using\s+static\b/.test(head);
        imports.push({
            module: rooted ? written.slice('global::'.length) : moduleNode.text,
            names: nameNode ? [nameNode.text] : ['*'],
            type: 'using',
            line: node.startPosition.row + 1,
            ...(isGlobal && { global: true }),
            ...(isStatic && { static: true }),
            ...(enclosing && !rooted && { namespace: enclosing }),
        });
        return false;
    });
    return imports;
}

function findUsagesInCode(code, name, parser, existingTree) {
    // A query tree of a file with conditional directives is its primary
    // view; the rows other views own are read from them (fix #391).
    const known = existingTree && csViewsByTree.get(existingTree);
    const views = known?.code === code ? known.views
        : (!existingTree || existingTree.rootNode.hasError ? csharpViews(parser, code) : null);
    if (views) {
        return csMergeViewItems(views, tree => usagesInTree(code, name, parser, tree), usage => usage.line)
            .sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0));
    }
    return usagesInTree(code, name, parser, existingTree || safeParse(parser, code, undefined, PARSE_OPTIONS));
}

function usagesInTree(code, name, parser, tree) {
    const usages = [];
    const variableTypesByScope = buildVariableTypes(tree, parser);
    visitNameNodes(tree, code, name, node => {
        if (!IDENTIFIER_NODES.has(node.type) || node.text !== name) return;
        let usageType = 'reference';
        const parent = node.parent;
        if (parent) {
            if ((parent.type === 'method_declaration' ||
                parent.type === 'constructor_declaration' ||
                TYPE_DECLARATIONS.has(parent.type) ||
                parent.type === 'property_declaration' ||
                parent.type === 'event_declaration' ||
                parent.type === 'parameter' ||
                parent.type === 'variable_declarator') &&
                (sameNode(parent.childForFieldName('name'), node))) {
                usageType = 'definition';
            } else if (parent.type === 'invocation_expression' ||
                parent.parent?.type === 'invocation_expression') {
                usageType = 'call';
            } else if (parent.type === 'using_directive') {
                usageType = 'import';
            }
            if (parent.type === 'member_access_expression' &&
                sameNode(parent.childForFieldName('name'), node)) {
                const receiverNode = parent.childForFieldName('expression') ||
                    parent.namedChild(0);
                const receiver = receiverNode?.text;
                const scopeTypes = variableTypesByScope.get(variableScopeKey(node)) ||
                    variableTypesByScope.get('global');
                const declared = receiverNode?.type === 'identifier'
                    ? normalizeReceiverType(scopeTypes?.get(receiver)) : null;
                const sameClass = ['this', 'base'].includes(receiver)
                    ? enclosingClassName(node) : null;
                usages.push({
                    line: node.startPosition.row + 1,
                    column: node.startPosition.column,
                    usageType,
                    ...(receiver && { receiver }),
                    ...((declared?.name || sameClass) && {
                        receiverType: declared?.name || sameClass,
                    }),
                });
                return true;
            }
        }
        usages.push({
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
            usageType,
        });
    });
    return usages;
}

function getEntryPointKind(symbol) {
    const decorators = new Set(symbol.decorators || []);
    if (symbol.name === 'Main' && symbol.modifiers?.includes('static')) return 'main';
    if (decorators.has('Fact') || decorators.has('Theory') ||
        decorators.has('Test') || decorators.has('TestMethod')) return 'test';
    if ([...decorators].some(name => /^(Http(Get|Post|Put|Delete|Patch)|Route|ApiController)$/.test(name))) {
        return 'framework';
    }
    return null;
}

function isEntryPoint(symbol) {
    return getEntryPointKind(symbol) !== null;
}

// Stable BCL receiver identities used only after AST/declaration typing has
// proved the static receiver type. Interfaces are included intentionally:
// core still checks whether the pinned project type implements the interface
// before excluding, so virtual dispatch remains visible when it is possible.
const CSHARP_PLATFORM_RECEIVER_TYPES = new Set([
    'List', 'Dictionary', 'HashSet', 'Queue', 'Stack',
    'IEnumerable', 'ICollection', 'IList', 'IDictionary',
    'IReadOnlyCollection', 'IReadOnlyList', 'IReadOnlyDictionary',
    'BinaryReader', 'BinaryWriter', 'TextReader', 'TextWriter',
    'StringReader', 'StringWriter',
    'Type', 'MemberInfo', 'FieldInfo', 'PropertyInfo', 'MethodInfo',
]);

function isPlatformConcreteCall(receiverType, _methodName) {
    const normalized = normalizeReceiverType(receiverType);
    return !!normalized && CSHARP_PLATFORM_RECEIVER_TYPES.has(normalized.name);
}

// fix #380: language features whose lowering references a compiler-required
// type by its full name (IsExternalInit for `init` accessors and positional
// records, RequiredMemberAttribute for `required`, System.Index/Range for
// `^i`/`a..b`, ...). A project declaration of such a type is used by the
// compiler exactly when the feature appears (trait languageProtocolType).
function languageFeatures(tree) {
    const features = new Set();
    const root = tree.rootNode;
    const hasToken = (node, token) => {
        for (let i = 0; i < node.childCount; i++) {
            if (node.child(i).type === token || node.child(i).text === token) return true;
        }
        return false;
    };
    const nodes = root.descendantsOfType([
        'accessor_declaration', 'record_declaration', 'modifier', 'prefix_unary_expression',
        'range_expression', 'nullable_type', 'nullable_directive', 'struct_declaration',
        'type_parameter_constraint', 'tuple_element', 'parameter',
    ]);
    for (const node of nodes) {
        switch (node.type) {
            case 'accessor_declaration':
                if (hasToken(node, 'init')) features.add('init');
                break;
            case 'record_declaration':
                if (node.namedChildren.some(child => child.type === 'parameter_list')) features.add('init');
                break;
            case 'modifier':
                if (node.text === 'required') features.add('required');
                else if (node.text === 'this' && node.parent?.type === 'parameter') features.add('extension-method');
                else if (node.text === 'in' && node.parent?.type === 'parameter') features.add('readonly');
                break;
            case 'prefix_unary_expression':
                if (node.child(0)?.type === '^') features.add('index-range');
                break;
            case 'range_expression':
                features.add('index-range');
                break;
            case 'nullable_type':
            case 'nullable_directive':
                features.add('nullable');
                break;
            case 'struct_declaration':
                for (const child of node.namedChildren) {
                    if (child.type !== 'modifier') continue;
                    if (child.text === 'ref') features.add('ref-struct');
                    if (child.text === 'readonly') features.add('readonly');
                }
                break;
            case 'type_parameter_constraint':
                if (node.text === 'unmanaged') features.add('unmanaged');
                break;
            case 'tuple_element':
                if (node.childForFieldName('name')) features.add('tuple-names');
                break;
            default:
                break;
        }
    }
    return [...features].sort();
}

function parse(code, parser) {
    const views = csharpViews(parser, code);
    const tree = views ? views.primary.tree : safeParse(parser, code, undefined, PARSE_OPTIONS);
    const featureSet = new Set(languageFeatures(tree));
    let errorRegions = tree.rootNode.hasError ? parseErrorRegions(tree.rootNode) : [];
    for (const view of views?.secondary || []) {
        for (const feature of languageFeatures(view.tree)) featureSet.add(feature);
        if (!view.tree.rootNode.hasError) continue;
        // A secondary view's damage counts where it supplies the rows.
        const owned = parseErrorRegions(view.tree.rootNode).filter(([start, end]) => {
            for (let row = start - 1; row < end; row++) if (view.owns.has(row)) return true;
            return false;
        });
        errorRegions = [...errorRegions, ...owned].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    }
    const features = [...featureSet].sort();
    const classes = findClasses(code, parser);
    return {
        language: 'csharp',
        totalLines: code.length === 0 ? 0 : code.split('\n').length,
        functions: findFunctions(code, parser),
        classes,
        stateObjects: findStateObjects(code, parser),
        imports: findImportsInCode(code, parser),
        exports: exportsOfClasses(classes),
        ...((tree.rootNode.hasError || errorRegions.length > 0) && {
            parseRecovery: true, parseErrorRegions: errorRegions,
        }),
        ...(features.length > 0 && { languageFeatures: features }),
        ...(views && { conditionalViews: views.groups.map(group => [...group]) }),
    };
}

function findExportsInCodeShallow(code, parser) {
    return exportsOfClasses(findClasses(code, parser));
}

// Public top-level types are the file's exports (read from the classes
// parse() already extracted, instead of extracting them again).
function exportsOfClasses(classes) {
    const exports = [];
    for (const cls of classes) {
        if (cls.modifiers.includes('public')) {
            exports.push({ name: cls.name, type: 'export', line: cls.startLine });
        }
    }
    return exports;
}

module.exports = {
    queryTree,
    queryTreeIsPlain,
    analysisTree: queryTree,
    findFunctions,
    findClasses,
    findStateObjects,
    findCallsInCode,
    findImportsInCode,
    findExportsInCode: findExportsInCodeShallow,
    findUsagesInCode,
    isPlatformConcreteCall,
    isEntryPoint,
    getEntryPointKind,
    parse,
};
