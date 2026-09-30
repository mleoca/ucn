/**
 * languages/lexical-scope.js - Where a bare name reference resolves (fix #392).
 *
 * A bare identifier in expression position names the innermost binding the
 * language's own scoping rules make visible there. `referenceScope` walks from
 * the identifier to the file root and answers:
 *
 *   'none'     the identifier is not a variable reference (a keyword-argument
 *              name, an object key, a struct field key)
 *   'module'   no enclosing function or block binds the name: it resolves at
 *              file / module / package scope
 *   { local: true, defRows }  an enclosing scope binds it; `defRows` lists the
 *              0-based rows of the declared names when every binding of the
 *              name in that scope is a function declaration (else null)
 *   'unknown'  the rules cannot settle it here (a local import, a `with`
 *              statement, a class body read, a macro token tree, ...)
 *
 * Rules per language family:
 * - Python: function scopes bind every assignment target, parameter, import,
 *   def/class, loop/with/except/match capture and walrus target of the whole
 *   body (position does not matter); `global` resolves at module scope and
 *   `nonlocal` in an enclosing function; class bodies are visible only to code
 *   directly in them; comprehensions and lambdas bind their own targets;
 *   decorators, defaults and annotations evaluate in the enclosing scope.
 * - JS/TS: blocks bind let/const/class/function declarations, functions bind
 *   parameters and every `var` of the body; named function/class expressions
 *   bind their own name; `with` and direct `eval` make the answer unknown.
 * - Go: a local declaration is visible from the end of its declaration to
 *   the end of its block; statement headers (if/for/switch/select) and case
 *   clauses are blocks; parameters, results and receivers bind the body.
 * - Rust: block items are visible in the whole block, `let` bindings after
 *   their statement; closures, fn parameters, match arms, `if let`/`while let`
 *   and `for` patterns bind their bodies; an inline module sees only its own
 *   items and what it imports (`use super::*` reaches the parent).
 * - C (fix #396): a block binds the declarations and typedefs before the
 *   reference, a `for` initializer its statement, parameters the function
 *   body; everything else resolves at file scope. A block-scope function
 *   declaration (`void f(int);`) names the file's function: unknown.
 */

'use strict';

const { sameNode, traverseTree } = require('./utils');

const FAMILY = {
    python: 'python',
    javascript: 'js', typescript: 'js', tsx: 'js',
    go: 'go',
    rust: 'rust',
    c: 'c',
};

function familyOf(language) {
    return FAMILY[language] || null;
}

function namedChildrenOf(node) {
    return node ? node.namedChildren || [] : [];
}

function within(node, outer) {
    return !!(node && outer && node.startIndex >= outer.startIndex && node.endIndex <= outer.endIndex);
}

function memoGet(memo, scope, name, compute) {
    const key = `${scope.startIndex}:${scope.endIndex}:${scope.type}:${name}`;
    if (memo.has(key)) return memo.get(key);
    const value = compute();
    memo.set(key, value);
    return value;
}

// ── Python ──────────────────────────────────────────────────────────────

/** Identifiers a Python assignment/loop/with target binds. */
function pyTargetNames(target, out) {
    if (!target) return;
    switch (target.type) {
        case 'identifier':
            out.push(target);
            return;
        case 'attribute': case 'subscript':
            return;
        case 'tuple_pattern': case 'list_pattern': case 'pattern_list':
        case 'tuple': case 'list': case 'expression_list':
        case 'parenthesized_expression': case 'list_splat_pattern':
        case 'list_splat': case 'as_pattern_target':
            for (const child of namedChildrenOf(target)) pyTargetNames(child, out);
            return;
        default:
            return;
    }
}

function pyParameterNames(params, out) {
    for (const param of namedChildrenOf(params)) {
        switch (param.type) {
            case 'identifier':
                out.push(param);
                break;
            case 'default_parameter': case 'typed_default_parameter': {
                const name = param.childForFieldName('name');
                if (name?.type === 'identifier') out.push(name);
                else pyTargetNames(name, out);
                break;
            }
            case 'typed_parameter': {
                const first = param.namedChild(0);
                if (first?.type === 'identifier') out.push(first);
                else if (first?.type === 'list_splat_pattern' || first?.type === 'dictionary_splat_pattern') {
                    pyTargetNames(first.namedChild(0), out);
                }
                break;
            }
            case 'list_splat_pattern': case 'dictionary_splat_pattern':
            case 'tuple_pattern':
                pyTargetNames(param.type === 'tuple_pattern' ? param : param.namedChild(0), out);
                break;
            default:
                break;
        }
    }
}

/** Capture names of a `case` pattern (not class names, not keyword keys). */
function pyCaptureNames(pattern, out) {
    traverseTree(pattern, node => {
        if (node.type === 'class_pattern') {
            // The class spelled first is a reference; its arguments capture.
            const children = namedChildrenOf(node);
            for (let i = 1; i < children.length; i++) pyCaptureNames(children[i], out);
            return false;
        }
        if (node.type === 'keyword_pattern') {
            const children = namedChildrenOf(node);
            for (let i = 1; i < children.length; i++) pyCaptureNames(children[i], out);
            return false;
        }
        if (node.type === 'dotted_name') {
            // A single name captures; a dotted value pattern reads.
            if (node.namedChildCount === 1) out.push(node.namedChild(0));
            return false;
        }
        if (node.type === 'identifier') out.push(node);
        return true;
    });
}

/**
 * Bindings of `name` in one Python function/class body (not nested scopes,
 * but walrus targets inside comprehensions bind here).
 */
function pyScopeBindings(scopeNode, body, name, isFunction) {
    const info = { bound: false, defRows: [], other: false, import: false,
        global: false, nonlocal: false, starImport: false };
    const note = (node, kind) => {
        if (!node || node.text !== name) return;
        info.bound = true;
        if (kind === 'def') info.defRows.push(node.startPosition.row);
        else if (kind === 'import') info.import = true;
        else info.other = true;
    };
    if (isFunction) {
        const params = scopeNode.childForFieldName('parameters');
        const names = [];
        pyParameterNames(params, names);
        for (const node of names) note(node, 'binding');
    }
    if (!body) return info;
    traverseTree(body, node => {
        if (sameNode(node, body)) return true;
        switch (node.type) {
            case 'function_definition':
                note(node.childForFieldName('name'), 'def');
                // Defaults and annotations evaluate here; walrus targets in
                // them bind here too, but the body is its own scope.
                for (const field of ['parameters', 'return_type']) {
                    const part = node.childForFieldName(field);
                    if (part) scanWalrus(part);
                }
                return false;
            case 'class_definition':
                note(node.childForFieldName('name'), 'binding');
                return false;
            case 'lambda':
                scanWalrus(node.childForFieldName('parameters'));
                return false;
            case 'list_comprehension': case 'set_comprehension':
            case 'dictionary_comprehension': case 'generator_expression':
                scanWalrus(node);
                return false;
            case 'assignment': case 'augmented_assignment': {
                const names = [];
                pyTargetNames(node.childForFieldName('left'), names);
                for (const target of names) note(target, 'binding');
                return true;
            }
            case 'named_expression':
                note(node.childForFieldName('name'), 'binding');
                return true;
            case 'for_statement': {
                const names = [];
                pyTargetNames(node.childForFieldName('left'), names);
                for (const target of names) note(target, 'binding');
                return true;
            }
            case 'as_pattern': {
                const alias = node.childForFieldName('alias');
                if (alias) {
                    const names = [];
                    pyTargetNames(alias, names);
                    for (const target of names) note(target, 'binding');
                    // A match-statement `as` capture is a bare identifier.
                    if (alias.type === 'identifier') note(alias, 'binding');
                } else {
                    const last = node.namedChild(node.namedChildCount - 1);
                    if (last?.type === 'identifier' && node.parent?.type === 'case_pattern') {
                        note(last, 'binding');
                    }
                }
                return true;
            }
            case 'delete_statement': {
                const names = [];
                for (const child of namedChildrenOf(node)) pyTargetNames(child, names);
                for (const target of names) note(target, 'binding');
                return false;
            }
            case 'import_statement':
                for (const part of namedChildrenOf(node)) {
                    if (part.type === 'aliased_import') note(part.childForFieldName('alias'), 'import');
                    else if (part.type === 'dotted_name') note(part.namedChild(0), 'import');
                }
                return false;
            case 'import_from_statement': {
                for (const part of namedChildrenOf(node)) {
                    if (part.type === 'wildcard_import') info.starImport = true;
                    if (sameNode(part, node.childForFieldName('module_name'))) continue;
                    if (part.type === 'aliased_import') note(part.childForFieldName('alias'), 'import');
                    else if (part.type === 'dotted_name') {
                        note(part.namedChild(part.namedChildCount - 1), 'import');
                    }
                }
                return false;
            }
            case 'future_import_statement':
                return false;
            case 'global_statement':
                for (const part of namedChildrenOf(node)) if (part.text === name) info.global = true;
                return false;
            case 'nonlocal_statement':
                for (const part of namedChildrenOf(node)) if (part.text === name) info.nonlocal = true;
                return false;
            case 'case_clause': {
                for (const part of namedChildrenOf(node)) {
                    if (part.type !== 'case_pattern') continue;
                    const names = [];
                    pyCaptureNames(part, names);
                    for (const target of names) note(target, 'binding');
                }
                return true;
            }
            case 'type_alias_statement': {
                const first = node.namedChild(0);
                note(first?.type === 'type' ? first.namedChild(0) : first, 'binding');
                return false;
            }
            case 'call': case 'attribute': case 'subscript':
            case 'binary_operator': case 'boolean_operator': case 'comparison_operator':
            case 'unary_operator': case 'not_operator': case 'conditional_expression':
            case 'list': case 'set': case 'dictionary':
            case 'string': case 'concatenated_string':
                // Expressions bind in this scope only through a walrus.
                // Skip their often-large value trees; the text check is only
                // a prefilter, and the AST walk still decides every binding.
                return node.text.includes(':=');
            default:
                return true;
        }
    });
    return info;

    function scanWalrus(root) {
        if (!root || !root.text.includes(':=')) return;
        traverseTree(root, inner => {
            if (inner.type === 'function_definition' || inner.type === 'class_definition') return false;
            if (inner.type === 'named_expression') note(inner.childForFieldName('name'), 'binding');
            return true;
        });
    }
}

function pyVerdict(info) {
    if (info.import || info.starImport) return 'unknown';
    if (info.other) return { local: true, defRows: null };
    return { local: true, defRows: info.defRows.slice() };
}

function pythonReferenceScope(node, name, memo) {
    const parent = node.parent;
    if (!parent) return 'unknown';
    if (parent.type === 'keyword_argument' && sameNode(parent.childForFieldName('name'), node)) return 'none';
    if (parent.type === 'attribute' && sameNode(parent.childForFieldName('attribute'), node)) return 'none';
    if (parent.type === 'keyword_pattern' && sameNode(parent.namedChild(0), node)) return 'none';
    let child = node;
    let crossedFunction = false;
    let viaNonlocal = false;
    for (let scope = parent; scope; child = scope, scope = scope.parent) {
        switch (scope.type) {
            case 'function_definition': {
                const body = scope.childForFieldName('body');
                if (!sameNode(body, child)) continue; // defaults, annotations: enclosing scope
                const info = memoGet(memo, scope, name, () => pyScopeBindings(scope, body, name, true));
                if (info.starImport) return 'unknown';
                if (info.global) {
                    // A function that assigns a `global` name rebinds the module
                    // binding at run time.
                    return info.other || info.defRows.length > 0 || info.import ? 'unknown' : 'module';
                }
                if (info.nonlocal) {
                    viaNonlocal = true;
                    crossedFunction = true;
                    continue;
                }
                if (info.bound) return pyVerdict(info);
                crossedFunction = true;
                continue;
            }
            case 'lambda': {
                if (!sameNode(scope.childForFieldName('body'), child)) continue;
                const names = [];
                pyParameterNames(scope.childForFieldName('parameters'), names);
                if (names.some(n => n.text === name)) return { local: true, defRows: null };
                crossedFunction = true;
                continue;
            }
            case 'class_definition': {
                const body = scope.childForFieldName('body');
                if (!sameNode(body, child)) continue; // bases, keywords: enclosing scope
                if (crossedFunction) continue; // methods do not see the class body
                const info = memoGet(memo, scope, name, () => pyScopeBindings(scope, body, name, false));
                // A class body reads its own dict first and falls back to
                // globals, in statement order: a name it also binds is unknown.
                if (info.bound || info.starImport) return 'unknown';
                continue;
            }
            case 'list_comprehension': case 'set_comprehension':
            case 'dictionary_comprehension': case 'generator_expression': {
                const clauses = namedChildrenOf(scope).filter(c => c.type === 'for_in_clause');
                // The first iterable evaluates in the enclosing scope.
                const firstIterable = clauses[0]?.childForFieldName('right');
                if (within(node, firstIterable)) continue;
                for (const clause of clauses) {
                    const names = [];
                    pyTargetNames(clause.childForFieldName('left'), names);
                    if (names.some(n => n.text === name)) return { local: true, defRows: null };
                }
                crossedFunction = true;
                continue;
            }
            case 'module':
                return viaNonlocal ? 'unknown' : 'module';
            default:
                continue;
        }
    }
    return viaNonlocal ? 'unknown' : 'module';
}

// ── JavaScript / TypeScript ─────────────────────────────────────────────

const JS_FUNCTIONS = new Set(['function_declaration', 'function_expression', 'function',
    'arrow_function', 'method_definition', 'generator_function',
    'generator_function_declaration']);
const JS_BLOCKS = new Set(['statement_block', 'switch_body', 'class_static_block', 'program']);

function jsPatternNames(pattern, out) {
    if (!pattern) return;
    switch (pattern.type) {
        case 'identifier': case 'shorthand_property_identifier_pattern':
            out.push(pattern);
            return;
        case 'assignment_pattern':
            jsPatternNames(pattern.childForFieldName('left'), out);
            return;
        case 'pair_pattern':
            jsPatternNames(pattern.childForFieldName('value'), out);
            return;
        case 'object_pattern': case 'array_pattern': case 'rest_pattern':
            for (const child of namedChildrenOf(pattern)) jsPatternNames(child, out);
            return;
        case 'required_parameter': case 'optional_parameter':
            jsPatternNames(pattern.childForFieldName('pattern'), out);
            return;
        case 'formal_parameters':
            for (const child of namedChildrenOf(pattern)) jsPatternNames(child, out);
            return;
        default:
            return;
    }
}

function jsDeclarationNames(statement, name, note) {
    let decl = statement;
    if (decl.type === 'export_statement') decl = decl.childForFieldName('declaration') || decl;
    switch (decl.type) {
        case 'function_declaration': case 'generator_function_declaration':
            if (decl.childForFieldName('name')?.text === name) note(decl.childForFieldName('name'), 'def');
            return;
        case 'class_declaration': case 'abstract_class_declaration':
        case 'enum_declaration': case 'internal_module': case 'module':
            if (decl.childForFieldName('name')?.text === name) note(decl.childForFieldName('name'), 'binding');
            return;
        case 'lexical_declaration': case 'variable_declaration': {
            // `var` also binds the enclosing function; counting it for the
            // block too is harmless (the function scan sees it first or not).
            for (const d of namedChildrenOf(decl)) {
                if (d.type !== 'variable_declarator') continue;
                const nameNode = d.childForFieldName('name');
                const value = d.childForFieldName('value');
                const names = [];
                jsPatternNames(nameNode, names);
                for (const n of names) {
                    if (n.text !== name) continue;
                    const fnValue = nameNode?.type === 'identifier' && value &&
                        (value.type === 'arrow_function' || value.type === 'function_expression' ||
                            value.type === 'function');
                    note(n, fnValue ? 'def' : 'binding');
                }
            }
            return;
        }
        case 'import_statement':
            traverseTree(decl, inner => {
                if ((inner.type === 'identifier') && inner.text === name &&
                    inner.parent?.type !== 'string') note(inner, 'import');
                return true;
            });
            return;
        default:
            return;
    }
}

function jsBlockBindings(block, name) {
    const info = { bound: false, defRows: [], other: false, import: false };
    const note = (node, kind) => {
        if (!node || node.text !== name) return;
        info.bound = true;
        if (kind === 'def') info.defRows.push(node.startPosition.row);
        else if (kind === 'import') info.import = true;
        else info.other = true;
    };
    const statements = block.type === 'switch_body'
        ? namedChildrenOf(block).flatMap(c => namedChildrenOf(c))
        : namedChildrenOf(block);
    for (const statement of statements) jsDeclarationNames(statement, name, note);
    return info;
}

/** Parameters, every `var` of the body and block-nested function declarations. */
function jsFunctionBindings(fn, name) {
    const info = { bound: false, defRows: [], other: false, import: false, unknown: false };
    const note = (node, kind) => {
        if (!node || node.text !== name) return;
        info.bound = true;
        if (kind === 'def') info.defRows.push(node.startPosition.row);
        else info.other = true;
    };
    const params = fn.childForFieldName('parameters') || fn.childForFieldName('parameter');
    const names = [];
    if (params?.type === 'identifier') names.push(params);
    else jsPatternNames(params, names);
    for (const n of names) note(n, 'binding');
    if (fn.type === 'function_expression' || fn.type === 'function' || fn.type === 'generator_function') {
        const own = fn.childForFieldName('name');
        if (own?.text === name) note(own, 'binding');
    }
    const body = fn.childForFieldName('body');
    if (!body || body.type !== 'statement_block') return info;
    traverseTree(body, node => {
        if (sameNode(node, body)) return true;
        if (JS_FUNCTIONS.has(node.type) || node.type === 'class_body' || node.type === 'class_static_block') {
            // A function declaration nested in a block is also hoisted to the
            // function in sloppy mode (Annex B): the answer is unknown.
            if ((node.type === 'function_declaration' || node.type === 'generator_function_declaration') &&
                !sameNode(node.parent, body) && node.childForFieldName('name')?.text === name) {
                info.unknown = true;
            }
            return false;
        }
        if (node.type === 'variable_declaration') {
            for (const d of namedChildrenOf(node)) {
                if (d.type !== 'variable_declarator') continue;
                const found = [];
                jsPatternNames(d.childForFieldName('name'), found);
                for (const n of found) note(n, 'binding');
            }
            return true;
        }
        if (node.type === 'call_expression') {
            const callee = node.childForFieldName('function');
            if (callee?.type === 'identifier' && callee.text === 'eval') info.unknown = true;
        }
        return true;
    });
    return info;
}

function jsVerdict(info) {
    if (info.import || info.unknown) return 'unknown';
    if (info.other) return { local: true, defRows: null };
    return { local: true, defRows: info.defRows.slice() };
}

function jsReferenceScope(node, name, memo) {
    if (node.type !== 'identifier' && node.type !== 'shorthand_property_identifier') {
        // Keys, member properties and type names are not variable
        // references. Object shorthand `{ name }` is both key and value:
        // its value resolves like an identifier (fix #397; the rename keeps
        // the key).
        return 'none';
    }
    const parent = node.parent;
    if (!parent) return 'unknown';
    if ((parent.type === 'labeled_statement' || parent.type === 'break_statement' ||
        parent.type === 'continue_statement')) return 'none';
    if (parent.type === 'export_specifier' || parent.type === 'import_specifier') return 'unknown';
    // The name of a function or class expression declares it.
    if ((JS_FUNCTIONS.has(parent.type) || parent.type === 'class' ||
        parent.type === 'class_declaration') && sameNode(parent.childForFieldName('name'), node)) return 'none';
    let child = node;
    for (let scope = parent; scope; child = scope, scope = scope.parent) {
        if (scope.type === 'with_statement' && sameNode(scope.childForFieldName('body'), child)) return 'unknown';
        if (JS_FUNCTIONS.has(scope.type)) {
            const body = scope.childForFieldName('body');
            if (sameNode(body, child)) {
                const info = memoGet(memo, scope, name, () => jsFunctionBindings(scope, name));
                if (info.bound || info.unknown) return jsVerdict(info);
            } else {
                // Parameter defaults see the parameters, not the body.
                const params = scope.childForFieldName('parameters') || scope.childForFieldName('parameter');
                const names = [];
                if (params?.type === 'identifier') names.push(params);
                else jsPatternNames(params, names);
                if (names.some(n => n.text === name)) return { local: true, defRows: null };
            }
            continue;
        }
        if (scope.type === 'class_declaration' || scope.type === 'class' ||
            scope.type === 'abstract_class_declaration') {
            // The class name is bound inside its own body.
            const own = scope.childForFieldName('name');
            if (own?.text === name && sameNode(scope.childForFieldName('body'), child)) {
                return { local: true, defRows: null };
            }
            continue;
        }
        if (scope.type === 'catch_clause') {
            const names = [];
            jsPatternNames(scope.childForFieldName('parameter'), names);
            if (names.some(n => n.text === name)) return { local: true, defRows: null };
            continue;
        }
        if (scope.type === 'for_statement' || scope.type === 'for_in_statement') {
            const head = scope.childForFieldName('initializer') || scope.childForFieldName('left');
            const names = [];
            if (head?.type === 'lexical_declaration') {
                for (const d of namedChildrenOf(head)) jsPatternNames(d.childForFieldName('name'), names);
            } else if (scope.type === 'for_in_statement' && head &&
                /^(let|const)$/.test(scope.childForFieldName('kind')?.text || '')) {
                jsPatternNames(head, names);
            }
            if (names.some(n => n.text === name)) return { local: true, defRows: null };
            continue;
        }
        if (scope.type === 'program') return 'module';
        if (JS_BLOCKS.has(scope.type)) {
            const info = memoGet(memo, scope, name, () => jsBlockBindings(scope, name));
            if (info.bound) return jsVerdict(info);
            continue;
        }
    }
    return 'module';
}

// ── Go ──────────────────────────────────────────────────────────────────

function goSpecNames(spec, out) {
    for (let i = 0; i < spec.childCount; i++) {
        const child = spec.child(i);
        if (child.type === 'identifier' && spec.fieldNameForChild(i) === 'name') out.push(child);
    }
}

/** Names a Go statement declares in its block. */
function goStatementNames(statement) {
    const out = [];
    switch (statement.type) {
        case 'short_var_declaration':
            for (const n of namedChildrenOf(statement.childForFieldName('left'))) {
                if (n.type === 'identifier') out.push(n);
            }
            break;
        case 'var_declaration': case 'const_declaration':
            traverseTree(statement, node => {
                if (node.type === 'var_spec' || node.type === 'const_spec') {
                    goSpecNames(node, out);
                    return false;
                }
                return true;
            });
            break;
        case 'type_declaration':
            traverseTree(statement, node => {
                if (node.type === 'type_spec' || node.type === 'type_alias') {
                    const n = node.childForFieldName('name');
                    if (n) out.push(n);
                    return false;
                }
                return true;
            });
            break;
        case 'receive_statement':
            if (/:=/.test(statement.text.split('<-')[0] || '')) {
                for (const n of namedChildrenOf(statement.childForFieldName('left'))) {
                    if (n.type === 'identifier') out.push(n);
                }
            }
            break;
        default:
            break;
    }
    return out;
}

function goParamNames(list, out) {
    for (const decl of namedChildrenOf(list)) {
        if (decl.type !== 'parameter_declaration' && decl.type !== 'variadic_parameter_declaration') continue;
        for (let i = 0; i < decl.childCount; i++) {
            const child = decl.child(i);
            if (child.type === 'identifier' && decl.fieldNameForChild(i) === 'name') out.push(child);
        }
    }
}

function goReferenceScope(node, name) {
    if (node.type !== 'identifier') return 'none';
    const parent = node.parent;
    if (!parent) return 'unknown';
    // `T{field: v}`: a struct field name or a map key, undecidable here.
    if (parent.type === 'literal_element' && parent.parent?.type === 'keyed_element' &&
        sameNode(parent.parent.childForFieldName('key'), parent)) return 'unknown';
    const start = node.startIndex;
    let child = node;
    for (let scope = parent; scope; child = scope, scope = scope.parent) {
        switch (scope.type) {
            case 'block': case 'expression_case': case 'default_case': case 'type_case':
            case 'communication_case': {
                for (const statement of namedChildrenOf(scope)) {
                    if (statement.endIndex > start) break;
                    if (statement.type === 'communication' || sameNode(statement, child)) continue;
                    const names = goStatementNames(statement);
                    if (names.some(n => n.text === name)) return { local: true, defRows: null };
                }
                if (scope.type === 'communication_case') {
                    const comm = scope.childForFieldName('communication');
                    if (comm && comm.endIndex <= start &&
                        goStatementNames(comm).some(n => n.text === name)) {
                        return { local: true, defRows: null };
                    }
                }
                if (scope.type === 'type_case' || scope.type === 'default_case' || scope.type === 'expression_case') {
                    const sw = scope.parent;
                    if (sw?.type === 'type_switch_statement') {
                        const alias = sw.childForFieldName('alias');
                        if (namedChildrenOf(alias).some(n => n.text === name)) return { local: true, defRows: null };
                    }
                }
                continue;
            }
            case 'if_statement': case 'expression_switch_statement': case 'type_switch_statement': {
                const init = scope.childForFieldName('initializer');
                if (init && init.endIndex <= start) {
                    const names = goStatementNames(init);
                    if (names.some(n => n.text === name)) return { local: true, defRows: null };
                }
                continue;
            }
            case 'for_statement': {
                const clause = namedChildrenOf(scope).find(c => c.type === 'for_clause' || c.type === 'range_clause');
                if (clause?.type === 'for_clause') {
                    const init = clause.childForFieldName('initializer');
                    if (init && init.endIndex <= start) {
                        const names = goStatementNames(init);
                        if (names.some(n => n.text === name)) return { local: true, defRows: null };
                    }
                } else if (clause?.type === 'range_clause' && clause.text.includes(':=') &&
                    sameNode(scope.childForFieldName('body'), child)) {
                    if (namedChildrenOf(clause.childForFieldName('left')).some(n => n.text === name)) {
                        return { local: true, defRows: null };
                    }
                }
                continue;
            }
            case 'function_declaration': case 'method_declaration': case 'func_literal': {
                if (!sameNode(scope.childForFieldName('body'), child)) continue;
                const names = [];
                goParamNames(scope.childForFieldName('parameters'), names);
                const result = scope.childForFieldName('result');
                if (result?.type === 'parameter_list') goParamNames(result, names);
                if (scope.type === 'method_declaration') goParamNames(scope.childForFieldName('receiver'), names);
                if (names.some(n => n.text === name)) return { local: true, defRows: null };
                continue;
            }
            case 'source_file':
                return 'module';
            default:
                continue;
        }
    }
    return 'module';
}

// ── Rust ────────────────────────────────────────────────────────────────

function rustPatternNames(pattern, out) {
    if (!pattern) return;
    traverseTree(pattern, node => {
        // `S { a, mut b }` binds a and b (shorthand field patterns).
        if (node.type === 'shorthand_field_identifier') {
            out.push(node);
            return false;
        }
        if (node.type === 'identifier') {
            const parent = node.parent;
            // `Some(x)`: the path is a type/variant, not a binding.
            if (parent && (parent.type === 'tuple_struct_pattern' || parent.type === 'struct_pattern') &&
                sameNode(parent.childForFieldName('type'), node)) return false;
            if (parent?.type === 'scoped_identifier') return false;
            // `S { field: pat }`: the field name is not a binding.
            if (parent?.type === 'field_pattern' && parent.childForFieldName('pattern') &&
                sameNode(parent.childForFieldName('name'), node)) return false;
            out.push(node);
            return false;
        }
        if (node.type === 'scoped_identifier' || node.type === 'type_identifier' ||
            node.type === 'generic_type') return false;
        return true;
    });
}

const RUST_VALUE_ITEMS = new Set(['function_item', 'const_item', 'static_item', 'struct_item',
    'enum_item', 'union_item', 'mod_item', 'extern_crate_declaration', 'macro_definition',
    'function_signature_item']);

function rustItemBindings(container, name) {
    const info = { bound: false, defRows: [], other: false, use: false, superGlob: false,
        otherGlob: false, superNamed: false };
    for (const item of namedChildrenOf(container)) {
        if (RUST_VALUE_ITEMS.has(item.type)) {
            const n = item.childForFieldName('name');
            if (n?.text === name) {
                info.bound = true;
                if (item.type === 'function_item') info.defRows.push(n.startPosition.row);
                else info.other = true;
            }
            continue;
        }
        if (item.type === 'use_declaration') {
            const arg = item.childForFieldName('argument');
            if (!arg) continue;
            if (arg.type === 'use_wildcard') {
                const path = arg.namedChild(0);
                if (path?.type === 'super' && arg.namedChildCount === 1) info.superGlob = true;
                else info.otherGlob = true;
                continue;
            }
            let hit = false;
            traverseTree(arg, inner => {
                if (inner.type === 'identifier' && inner.text === name) hit = true;
                return !hit;
            });
            if (hit) {
                info.bound = true;
                // `use super::name;` re-binds the parent's item under its own name.
                if (arg.type === 'scoped_identifier' && arg.childForFieldName('path')?.type === 'super' &&
                    arg.childForFieldName('name')?.text === name) info.superNamed = true;
                else info.use = true;
            }
        }
    }
    return info;
}

// ── C ───────────────────────────────────────────────────────────────────

const C_DECLARATOR_WRAPPERS = new Set(['init_declarator', 'pointer_declarator', 'array_declarator',
    'parenthesized_declarator', 'attributed_declarator']);

/** The identifier a C declarator declares, and whether it declares a function. */
function cDeclaratorName(declarator) {
    let current = declarator;
    let isFunction = false;
    for (let depth = 0; current && depth < 16; depth++) {
        if (current.type === 'identifier') return { node: current, isFunction };
        if (current.type === 'function_declarator') isFunction = true;
        else if (!C_DECLARATOR_WRAPPERS.has(current.type)) return null;
        current = current.childForFieldName('declarator') ||
            namedChildrenOf(current).find(child => child.type === 'identifier' ||
                child.type.endsWith('_declarator'));
    }
    return null;
}

/** 'local' / 'function' / null: how a declaration binds `name`. */
function cDeclarationBinds(statement, name) {
    if (statement.type !== 'declaration' && statement.type !== 'type_definition') return null;
    let verdict = null;
    for (const child of namedChildrenOf(statement)) {
        if (!child.type.endsWith('declarator') && child.type !== 'identifier' &&
            child.type !== 'type_identifier') continue;
        if (sameNode(child, statement.childForFieldName('type'))) continue;
        const declared = child.type === 'type_identifier' ? { node: child, isFunction: false }
            : cDeclaratorName(child);
        if (!declared || declared.node.text !== name) continue;
        if (declared.isFunction) return 'function';
        verdict = 'local';
    }
    return verdict;
}

function cReferenceScope(node, name) {
    if (node.type !== 'identifier') return 'none';
    const parent = node.parent;
    if (!parent) return 'unknown';
    // The declared name of a variable or parameter is a binding, never a
    // reference to a function of the same spelling.
    for (let up = parent, child = node; up && C_DECLARATOR_WRAPPERS.has(up.type); child = up, up = up.parent) {
        if (up.type === 'init_declarator' && !sameNode(up.childForFieldName('declarator'), child)) break;
        const owner = up.parent;
        if (owner && (owner.type === 'declaration' || owner.type === 'parameter_declaration' ||
            owner.type === 'field_declaration')) return 'none';
    }
    if (parent.type === 'declaration' || parent.type === 'parameter_declaration') {
        if (sameNode(parent.childForFieldName('declarator'), node)) return 'none';
    }
    const start = node.startIndex;
    let child = node;
    for (let scope = parent; scope; child = scope, scope = scope.parent) {
        switch (scope.type) {
            case 'ERROR':
                return 'unknown';
            case 'compound_statement': {
                let bound = null;
                for (const statement of namedChildrenOf(scope)) {
                    if (statement.startIndex >= start) break;
                    const verdict = cDeclarationBinds(statement, name);
                    if (verdict) bound = verdict;
                }
                if (bound === 'function') return 'unknown';
                if (bound) return { local: true, defRows: null };
                continue;
            }
            case 'for_statement': {
                const init = scope.childForFieldName('initializer');
                if (init && init.endIndex <= start) {
                    const verdict = cDeclarationBinds(init, name);
                    if (verdict === 'function') return 'unknown';
                    if (verdict) return { local: true, defRows: null };
                }
                continue;
            }
            case 'function_definition': {
                if (!sameNode(scope.childForFieldName('body'), child)) continue;
                const declarator = cDeclaratorOfFunction(scope);
                const params = declarator?.childForFieldName('parameters');
                for (const param of namedChildrenOf(params)) {
                    const declared = param.childForFieldName('declarator');
                    const identity = declared ? cDeclaratorName(declared) : null;
                    if (identity?.node.text === name) return { local: true, defRows: null };
                }
                continue;
            }
            case 'translation_unit':
                return 'module';
            default:
                continue;
        }
    }
    return 'unknown';
}

function cDeclaratorOfFunction(definition) {
    let current = definition.childForFieldName('declarator');
    for (let depth = 0; current && depth < 16; depth++) {
        if (current.type === 'function_declarator') return current;
        current = current.childForFieldName('declarator');
    }
    return null;
}

function rustReferenceScope(node, name, memo) {
    if (node.type !== 'identifier') return 'none';
    const parent = node.parent;
    if (!parent) return 'unknown';
    // A field init shorthand `S { name }` is the field key and a reference
    // to the binding: its value resolves like any identifier (fix #397; a
    // rename keeps the key).
    // A path segment (`name::X`) names a module or type.
    if ((parent.type === 'scoped_identifier' || parent.type === 'scoped_type_identifier') &&
        !sameNode(parent.childForFieldName('name'), node)) return 'none';
    if (parent.type === 'field_initializer' && sameNode(parent.childForFieldName('field'), node)) return 'none';
    const start = node.startIndex;
    let child = node;
    for (let scope = parent; scope; child = scope, scope = scope.parent) {
        switch (scope.type) {
            case 'token_tree':
                // A macro decides what its tokens mean.
                return 'unknown';
            case 'block': {
                const items = memoGet(memo, scope, name, () => rustItemBindings(scope, name));
                if (items.use || items.superNamed) return 'unknown';
                // `let` bindings visible here: statements that end before us.
                for (const statement of namedChildrenOf(scope)) {
                    if (statement.startIndex >= start) break;
                    if (statement.type !== 'let_declaration' || statement.endIndex > start) continue;
                    const names = [];
                    rustPatternNames(statement.childForFieldName('pattern'), names);
                    if (names.some(n => n.text === name)) return { local: true, defRows: null };
                }
                if (items.bound) {
                    return items.other ? { local: true, defRows: null } : { local: true, defRows: items.defRows.slice() };
                }
                if (items.otherGlob) return 'unknown';
                continue;
            }
            case 'closure_expression': {
                if (!sameNode(scope.childForFieldName('body'), child)) continue;
                const names = [];
                for (const p of namedChildrenOf(scope.childForFieldName('parameters'))) {
                    rustPatternNames(p.type === 'parameter' ? p.childForFieldName('pattern') : p, names);
                }
                if (names.some(n => n.text === name)) return { local: true, defRows: null };
                continue;
            }
            case 'function_item': {
                if (!sameNode(scope.childForFieldName('body'), child)) continue;
                const names = [];
                for (const p of namedChildrenOf(scope.childForFieldName('parameters'))) {
                    if (p.type === 'parameter') rustPatternNames(p.childForFieldName('pattern'), names);
                }
                if (names.some(n => n.text === name)) return { local: true, defRows: null };
                continue;
            }
            case 'match_arm': {
                if (sameNode(scope.childForFieldName('pattern'), child)) continue;
                const names = [];
                rustPatternNames(scope.childForFieldName('pattern'), names);
                if (names.some(n => n.text === name)) return { local: true, defRows: null };
                continue;
            }
            case 'if_expression': case 'while_expression': {
                if (!sameNode(scope.childForFieldName('consequence') || scope.childForFieldName('body'), child)) continue;
                const names = [];
                const condition = scope.childForFieldName('condition');
                if (condition) traverseTree(condition, inner => {
                    if (inner.type === 'let_condition') {
                        rustPatternNames(inner.childForFieldName('pattern'), names);
                        return false;
                    }
                    return inner.type === 'let_chain';
                });
                if (names.some(n => n.text === name)) return { local: true, defRows: null };
                continue;
            }
            case 'for_expression': {
                if (!sameNode(scope.childForFieldName('body'), child)) continue;
                const names = [];
                rustPatternNames(scope.childForFieldName('pattern'), names);
                if (names.some(n => n.text === name)) return { local: true, defRows: null };
                continue;
            }
            case 'mod_item': {
                const body = scope.childForFieldName('body');
                if (!sameNode(body, child)) continue;
                const items = memoGet(memo, body, name, () => rustItemBindings(body, name));
                if (items.use || items.otherGlob) return 'unknown';
                if (items.bound && !items.superNamed) {
                    return items.other ? { local: true, defRows: null } : { local: true, defRows: items.defRows.slice() };
                }
                // Only a parent re-exported into this module reaches the file scope.
                if (items.superNamed || items.superGlob) continue;
                return 'unknown';
            }
            case 'source_file':
                return 'module';
            default:
                continue;
        }
    }
    return 'module';
}

/**
 * The `let` statement a Rust identifier reference binds to (fix #392), or
 * null when the nearest binding is anything else (a parameter, a closure or
 * match-arm pattern, an item) or none. Shadowing: the last `let` before the
 * reference in the innermost block that binds the name wins.
 */
function rustLetBindingOf(node) {
    if (!node || node.type !== 'identifier') return null;
    const name = node.text;
    const start = node.startIndex;
    for (let scope = node.parent; scope; scope = scope.parent) {
        switch (scope.type) {
            case 'token_tree':
                return null;
            case 'block': {
                let found = null;
                for (const statement of namedChildrenOf(scope)) {
                    if (statement.startIndex >= start) break;
                    if (statement.type === 'let_declaration' && statement.endIndex <= start) {
                        const names = [];
                        rustPatternNames(statement.childForFieldName('pattern'), names);
                        if (names.some(n => n.text === name)) found = statement;
                    } else if (RUST_VALUE_ITEMS.has(statement.type) &&
                        statement.childForFieldName('name')?.text === name) {
                        return null;
                    }
                }
                if (found) return found;
                continue;
            }
            case 'closure_expression': case 'function_item': case 'match_arm':
            case 'if_expression': case 'while_expression': case 'for_expression': {
                const verdict = rustReferenceScope(node, name, new Map());
                // Only a `let` of an enclosing block may bind it past here.
                if (typeof verdict === 'object' && scope.type !== 'function_item') {
                    const inner = [];
                    const pattern = scope.type === 'match_arm' ? scope.childForFieldName('pattern')
                        : scope.type === 'for_expression' ? scope.childForFieldName('pattern') : null;
                    if (pattern) rustPatternNames(pattern, inner);
                    if (inner.some(n => n.text === name)) return null;
                    if (scope.type === 'closure_expression') {
                        for (const p of namedChildrenOf(scope.childForFieldName('parameters'))) {
                            rustPatternNames(p.type === 'parameter' ? p.childForFieldName('pattern') : p, inner);
                        }
                        if (inner.some(n => n.text === name)) return null;
                    }
                    if (scope.type === 'if_expression' || scope.type === 'while_expression') {
                        const condition = scope.childForFieldName('condition');
                        if (condition) traverseTree(condition, n => {
                            if (n.type === 'let_condition') {
                                rustPatternNames(n.childForFieldName('pattern'), inner);
                                return false;
                            }
                            return true;
                        });
                        if (inner.some(n => n.text === name)) return null;
                    }
                }
                if (scope.type === 'function_item') {
                    for (const p of namedChildrenOf(scope.childForFieldName('parameters'))) {
                        const names = [];
                        if (p.type === 'parameter') rustPatternNames(p.childForFieldName('pattern'), names);
                        if (names.some(n => n.text === name)) return null;
                    }
                    return null;
                }
                continue;
            }
            default:
                continue;
        }
    }
    return null;
}

/**
 * The struct field a Rust local is destructured from (fix #392): `let Self
 * { a, mut b, c: x } = self;` binds `a`/`b`/`x` to fields `a`/`b`/`c` of
 * `self`. Returns the field name, or null.
 */
const selfDestructuringMemo = new WeakMap();

/** Names bound by `let <struct pattern> = self` in a fn body (memoized). */
function selfDestructuredNames(fnNode) {
    const tree = fnNode.tree;
    let perTree = tree ? selfDestructuringMemo.get(tree) : null;
    if (tree && !perTree) {
        perTree = new Map();
        selfDestructuringMemo.set(tree, perTree);
    }
    const key = `${fnNode.startIndex}:${fnNode.endIndex}`;
    if (perTree?.has(key)) return perTree.get(key);
    const names = new Set();
    const body = fnNode.childForFieldName('body');
    if (body) {
        for (const statement of body.descendantsOfType('let_declaration')) {
            if (statement.childForFieldName('pattern')?.type !== 'struct_pattern') continue;
            const found = [];
            rustPatternNames(statement.childForFieldName('pattern'), found);
            for (const n of found) names.add(n.text);
        }
    }
    perTree?.set(key, names);
    return names;
}

function rustSelfFieldBinding(identNode) {
    let fnNode = identNode.parent;
    while (fnNode && fnNode.type !== 'function_item') fnNode = fnNode.parent;
    if (!fnNode || !selfDestructuredNames(fnNode).has(identNode.text)) return null;
    const statement = rustLetBindingOf(identNode);
    if (!statement) return null;
    let value = statement.childForFieldName('value');
    while (value && (value.type === 'reference_expression' || value.type === 'unary_expression' ||
        value.type === 'parenthesized_expression')) value = value.namedChild(value.namedChildCount - 1);
    if (value?.type !== 'self') return null;
    const pattern = statement.childForFieldName('pattern');
    if (pattern?.type !== 'struct_pattern') return null;
    const typeNode = pattern.childForFieldName('type');
    if (!typeNode || (typeNode.type !== 'type_identifier' && typeNode.text !== 'Self')) return null;
    const name = identNode.text;
    for (const field of namedChildrenOf(pattern)) {
        if (field.type !== 'field_pattern') continue;
        const fieldName = field.childForFieldName('name');
        const sub = field.childForFieldName('pattern');
        if (!sub) {
            // Shorthand `a` / `mut a` / `ref a`: the binding is the field name.
            if (fieldName?.text === name) return name;
            continue;
        }
        const bound = sub.type === 'identifier' ? sub
            : sub.type === 'mut_pattern' ? sub.namedChild(0) : null;
        if (bound?.type === 'identifier' && bound.text === name && fieldName) return fieldName.text;
    }
    return null;
}

/**
 * Where a bare name reference resolves (see the file header).
 * `memo` is a Map shared by the references of one name in one tree.
 */
function referenceScope(node, language, memo = new Map()) {
    const family = familyOf(language);
    if (!family || !node) return null;
    const name = node.text;
    try {
        switch (family) {
            case 'python': return pythonReferenceScope(node, name, memo);
            case 'js': return jsReferenceScope(node, name, memo);
            case 'go': return goReferenceScope(node, name, memo);
            case 'rust': return rustReferenceScope(node, name, memo);
            case 'c': return cReferenceScope(node, name);
            default: return null;
        }
    } catch {
        return 'unknown';
    }
}

/** Usage-record fields for a scope verdict. */
function scopeFields(verdict) {
    if (!verdict) return null;
    if (typeof verdict === 'string') return { scopeBinding: verdict };
    return {
        scopeBinding: 'local',
        ...(Array.isArray(verdict.defRows) && { scopeDefLines: verdict.defRows.map(r => r + 1) }),
    };
}

module.exports = { referenceScope, scopeFields, familyOf, rustLetBindingOf, rustSelfFieldBinding };
