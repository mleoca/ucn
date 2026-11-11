/**
 * core/change-kinds.js - What did a change do to a callable's contract?
 *
 * A caller relies on three things, and a diff can touch each of them
 * without touching the others:
 *
 *   header      every token of the declaration outside its body: name,
 *               parameters, return annotation, modifiers, decorators and
 *               attributes, template head. Compared token by token, so a
 *               reformatted header is the same header.
 *   kind        what the BODY makes of the callable where the language lets
 *               it (trait `callableKindFromBody`): a Python `def` becomes a
 *               generator when its own body yields.
 *   return      where the language takes the return contract from the body
 *               (trait `inferredReturnForms`: no annotation, a placeholder
 *               type, an opaque type, a body instantiated per caller), the
 *               expressions that produce the result and every statement
 *               connected to them through a variable name.
 *   members     where a member's type is whatever the class's methods
 *               assign to it (trait `memberTypesFromAssignments`), the
 *               assignments the body makes to members of its receiver.
 *
 * A change that leaves all three alone is INERT: no caller can observe it
 * through the contract, however many callers there are. Anything else is a
 * CONTRACT change, named by what moved.
 *
 * Everything here is read from the syntax tree. A declaration the tree
 * cannot place answers `unknown`, which callers treat as a contract change:
 * a failed projection is never a clean one.
 */

'use strict';

const { getParser, safeParse, langTraits } = require('../languages');
const { CALLABLE_NODES, COMMENT_NODES } = require('./ast-analysis');

// Statements that end the callable with a value.
const RESULT_NODES = new Set(['return_statement', 'return_expression']);
const YIELD_NODES = new Set(['yield', 'yield_expression', 'yield_statement']);

// Statements that end a path of the callable without a value.
const EXIT_NODES = new Map([
    ['throw_statement', 'throw'], ['raise_statement', 'throw'],
    ['break_statement', 'break'], ['continue_statement', 'continue'],
]);
const ASSERT_NODES = new Set(['assert_statement']);
// Statements a condition decides: with one that names nothing (`while
// True`, `for (;;)`, `if False`) the checker knows which way it goes.
const CONDITION_NODES = new Set(['while_statement', 'do_statement', 'for_statement', 'if_statement', 'elif_clause']);
const LOOP_NODES = new Set(['while_statement', 'do_statement', 'for_statement']);
const SWITCH_NODES = new Set(['switch_statement']);
const CASE_NODES = new Set(['switch_case', 'switch_default']);
// A context manager can swallow what its block raises: whether the code
// after the block is reached is a property of the manager.
const MANAGER_NODES = new Set(['with_statement', 'with_clause']);
const CALL_NODES = new Set(['call_expression', 'call']);
const AWAIT_NODES = new Set(['await_expression', 'await']);

// Nodes that hold declarations rather than being one: a callable's
// declaration never grows past them.
const CONTAINER_NODES = new Set([
    'program', 'module', 'source_file', 'translation_unit', 'compilation_unit',
    'class_body', 'interface_body', 'enum_body', 'declaration_list', 'field_declaration_list',
    'block', 'statement_block', 'compound_statement', 'object', 'object_type',
    'class_declaration', 'class_definition', 'class_specifier', 'struct_specifier',
    'impl_item', 'trait_item', 'namespace_definition', 'namespace_declaration',
    'arguments', 'argument_list', 'array', 'list', 'tuple', 'dictionary',
]);

// Written before the declaration, not inside it.
const LEADING_NODES = new Set([
    'decorator', 'attribute_item', 'annotation', 'marker_annotation', 'attribute_list',
]);

// Nodes that bind a name, and the field that holds what they bind. Only the
// languages whose return contract is read expression by expression need a
// row; the others compare the whole body.
const BINDING_FIELDS = Object.freeze({
    // Python
    assignment: ['left'],
    augmented_assignment: ['left'],
    for_statement: ['left'],
    for_in_clause: ['left'],
    as_pattern: ['alias'],
    named_expression: ['name'],
    function_definition: ['name'],
    class_definition: ['name'],
    // JavaScript / TypeScript
    variable_declarator: ['name'],
    assignment_expression: ['left'],
    augmented_assignment_expression: ['left'],
    update_expression: ['argument'],
    for_in_statement: ['left'],
    function_declaration: ['name'],
    generator_function_declaration: ['name'],
    class_declaration: ['name'],
    catch_clause: ['parameter'],
});
// Statements that bind every name they list.
const BINDING_LISTS = new Set([
    'global_statement', 'nonlocal_statement', 'delete_statement',
    'import_statement', 'import_from_statement', 'except_clause',
]);
// A binding form with no row above still binds: its type says so.
const BINDING_SHAPE = /assignment|declarator|pattern|binding/;
const BINDING_SHAPE_FIELDS = ['left', 'name', 'pattern', 'declarator', 'alias', 'argument'];

function sameNode(a, b) {
    return !!a && !!b && a.id === b.id;
}

/** Leaf tokens of a subtree, comments left out, `skip` not entered. */
function tokensOf(node, skip, out = []) {
    if (!node || COMMENT_NODES.has(node.type) || (skip && sameNode(node, skip))) return out;
    if (node.childCount === 0) {
        out.push([node.type, node.text]);
        return out;
    }
    for (const child of node.children) tokensOf(child, skip, out);
    return out;
}

function identifiersOf(node, out = new Set()) {
    if (!node) return out;
    if (node.childCount === 0) {
        if (node.type.includes('identifier')) out.add(node.text);
        return out;
    }
    for (const child of node.children) identifiersOf(child, out);
    return out;
}

function within(node, range) {
    const startRow = node.startPosition.row + 1;
    const endRow = node.endPosition.row + 1;
    if (startRow < range.startLine || endRow > range.endLine) return false;
    if (range.startColumn != null && startRow === range.startLine &&
        node.startPosition.column < range.startColumn) return false;
    if (range.endColumn != null && endRow === range.endLine &&
        node.endPosition.column > range.endColumn) return false;
    return true;
}

/** The rows, and where the parser recorded them the columns, of a symbol. */
function rangeOf(symbol) {
    const span = symbol.sourceSpan;
    // A span is trusted only when it has all four coordinates: a decorated
    // definition's span and its symbol's lines can disagree on where the
    // declaration starts, and the wider of the two is the declaration.
    const exact = span && [span.startLine, span.endLine, span.startColumn, span.endColumn]
        .every(Number.isInteger);
    return {
        startLine: exact ? Math.min(symbol.startLine, span.startLine) : symbol.startLine,
        endLine: exact ? Math.max(symbol.endLine || symbol.startLine, span.endLine)
            : symbol.endLine || symbol.startLine,
        ...(exact && span.startLine <= symbol.startLine && { startColumn: span.startColumn }),
        ...(exact && span.endLine >= (symbol.endLine || symbol.startLine) && { endColumn: span.endColumn }),
    };
}

/** The callable node a symbol's range holds: the outermost one in it. */
function callableNodeOf(root, range) {
    let found = null;
    const visit = node => {
        const startRow = node.startPosition.row + 1;
        const endRow = node.endPosition.row + 1;
        if (endRow < range.startLine || startRow > range.endLine) return;
        if (CALLABLE_NODES.has(node.type) && within(node, range)) {
            if (!found || (node.endIndex - node.startIndex) > (found.endIndex - found.startIndex)) found = node;
            return; // nested callables are inside this one
        }
        for (const child of node.namedChildren) visit(child);
    };
    visit(root);
    return found;
}

/**
 * The whole declaration a callable node belongs to: the node, grown through
 * every wrapper that is part of the same declaration (a decorated or
 * exported definition, a template head, the field or variable a function
 * value is assigned to) and never into what merely contains it.
 */
function declarationOf(node, range) {
    let declaration = node;
    while (declaration.parent && !CONTAINER_NODES.has(declaration.parent.type) &&
        within(declaration.parent, range)) declaration = declaration.parent;
    return declaration;
}

/** Own nodes of a body: nested callables are seen and not entered. */
function walkOwn(node, visit, path = []) {
    for (const child of node.namedChildren) {
        if (visit(child, path) === false) continue;
        if (CALLABLE_NODES.has(child.type)) continue;
        path.push(child.type);
        walkOwn(child, visit, path);
        path.pop();
    }
}

function bindingTargets(node) {
    const fields = BINDING_FIELDS[node.type] ||
        (BINDING_SHAPE.test(node.type) ? BINDING_SHAPE_FIELDS : null);
    if (!fields) return BINDING_LISTS.has(node.type) ? [node] : [];
    return fields.map(field => node.childForFieldName(field)).filter(Boolean);
}

// Statement-level nodes: the units a body is made of. A compound statement
// is the unit of its own header (a condition, a loop target, an `except`
// pattern); the statements it holds are units of their own.
const STATEMENT_SHAPE = /(?:_statement|_declaration|_definition|_clause|^switch_case|^switch_default)$/;
const VARIABLE_LEAVES = new Set([
    'identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern',
]);

/** A member or keyword name: spelled like a variable, naming none. */
function namesNoVariable(node) {
    const parent = node.parent;
    if (!parent) return false;
    const member = parent.childForFieldName('attribute') || parent.childForFieldName('property') ||
        (parent.type === 'keyword_argument' ? parent.childForFieldName('name') : null);
    return !!member && member.id === node.id;
}

// A member access, and the field that holds the member's name.
const MEMBER_NODES = new Map([['member_expression', 'property'], ['attribute', 'attribute']]);

/** `this.a.b` as ['this', 'a', 'b'], or null when it is not a plain chain. */
function chainOf(node) {
    if (node.type === 'this' || VARIABLE_LEAVES.has(node.type)) return [node.text];
    const field = MEMBER_NODES.get(node.type);
    if (!field) return null;
    const object = node.childForFieldName('object');
    const member = node.childForFieldName(field);
    if (!object || !member || member.childCount > 0) return null;
    const head = chainOf(object);
    return head ? [...head, member.text] : null;
}

/** Do two references name the same thing, or one a part of the other? */
function overlaps(a, b) {
    return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/**
 * A unit's own tokens and what it refers to: everything in the node except
 * the statements it holds.
 *
 * A reference is a variable name, with one refinement. A member of the
 * receiver (`this.count`, `self.count`) is its own reference: a type
 * checker narrows and assigns `this.count` apart from `this.total`, and
 * the receiver is no union a test of one member could narrow as a whole.
 * Members of anything else stay under the variable (a test of `shape.kind`
 * narrows `shape`, and with it `shape.radius`). A call on the receiver
 * refers to the receiver itself: what it asserts about `this` is in its
 * declaration.
 *
 * @param {object} [options] - { receiverMembers: the callable is a class
 *   member whose receiver is an instance of the class, selfName: the
 *   receiver parameter's name where the receiver is one, omit: a node
 *   whose references are not collected (the callee of a call shown to do
 *   nothing but return) }
 */
function unitOf(node, options = {}) {
    const { receiverMembers = false, selfName = null, omit = null } = options;
    const tokens = [];
    const names = new Set();
    let yields = false;
    const isReceiver = text => receiverMembers && (text === 'this' || (selfName !== null && text === selfName));
    const visit = (candidate, top, quiet) => {
        if (COMMENT_NODES.has(candidate.type)) return;
        if (!top && candidate.isNamed && STATEMENT_SHAPE.test(candidate.type)) return;
        if (YIELD_NODES.has(candidate.type)) yields = true;
        if (!quiet && omit && sameNode(candidate, omit)) quiet = true;
        if (!quiet && MEMBER_NODES.has(candidate.type)) {
            const chain = chainOf(candidate);
            if (chain && isReceiver(chain[0])) {
                const parent = candidate.parent;
                const called = !!parent && CALL_NODES.has(parent.type) &&
                    sameNode(parent.childForFieldName('function'), candidate);
                const reach = called ? chain.slice(0, -1) : chain;
                names.add(reach.slice(0, 2).join('.'));
                quiet = true;
            }
        }
        if (candidate.childCount === 0) {
            tokens.push([candidate.type, candidate.text]);
            if (!quiet && (candidate.type === 'this' ||
                (VARIABLE_LEAVES.has(candidate.type) && !namesNoVariable(candidate)))) names.add(candidate.text);
            return;
        }
        for (const child of candidate.children) visit(child, false, quiet);
    };
    visit(node, true, false);
    return { tokens, names, yields };
}

/** The callee of a statement that is nothing but a call, or null. */
function bareCallee(statement) {
    if (statement.type !== 'expression_statement' || statement.namedChildCount !== 1) return null;
    let expression = statement.namedChildren[0];
    if (AWAIT_NODES.has(expression.type)) expression = expression.namedChildren[0];
    if (!expression || !CALL_NODES.has(expression.type)) return null;
    return expression.childForFieldName('function');
}

/**
 * Can a statement that only calls `callee` be shown to return to the next
 * statement? A type checker ends the path at a call it is TOLD never
 * returns (a declared `never` / `NoReturn`), so the question is what the
 * callee is declared as:
 *   - a name the callable binds itself (a parameter, a local): unknown;
 *   - a function or an own method of the project whose every declaration
 *     says nothing of the kind (`facts.context.returning`);
 *   - a builtin of the language that returns (traits `ambientCallables`
 *     minus `ambientNeverCallables`; members of
 *     `ambientReturningNamespaces`), unless the file gives the name
 *     another meaning;
 *   - anything else (a member of a value, an import from outside the
 *     project): unknown, which is no.
 */
function provablyReturns(callee, facts) {
    const { traits, context, locals, ownerClass, selfName } = facts;
    const shadowed = name => locals.has(name) || !!(context && context.fileNames && context.fileNames.has(name));
    if (callee.type === 'identifier') {
        const name = callee.text;
        if (locals.has(name)) return false;
        if (context && context.returning && context.returning(name, null)) return true;
        return !!traits.ambientCallables && traits.ambientCallables.has(name) && !shadowed(name) &&
            !(traits.ambientNeverCallables && traits.ambientNeverCallables.has(name));
    }
    const object = callee.childForFieldName('object');
    const member = callee.childForFieldName('property') || callee.childForFieldName('attribute');
    if (!object || !member) return false;
    if (object.type === 'this' || (selfName && object.type === 'identifier' && object.text === selfName)) {
        return !!(ownerClass && context && context.returning && context.returning(member.text, ownerClass));
    }
    let root = object;
    while (root.childForFieldName('object')) root = root.childForFieldName('object');
    return root.type === 'identifier' && !!traits.ambientReturningNamespaces &&
        traits.ambientReturningNamespaces.has(root.text) && !shadowed(root.text);
}

/**
 * Does this declaration say nothing that could make a call of it end the
 * caller's path? Yes for a function or method with a body and either no
 * return annotation or one made of keywords only (`void`, `None`) that is
 * not a never type. No (unknown) for everything a checker could read a
 * never type from: an annotation that names a type (it may be an alias of
 * one), a decorator (it can replace the callable), a function held by a
 * typed variable or field (it has that type), a declaration with no body
 * (an overload signature).
 *
 * @param {string[]} neverTypes - trait `neverReturnTypes`
 */
function declaresPlainReturn(root, symbol, neverTypes) {
    if (!root || !symbol) return false;
    const range = rangeOf(symbol);
    const node = callableNodeOf(root, range);
    if (!node || node.hasError || !node.childForFieldName('body')) return false;
    // Everything the callable is written inside, up to the block or body
    // that holds its declaration (a symbol's range can be the function
    // value alone, without the variable it is assigned to).
    for (let up = node; up && !CONTAINER_NODES.has(up.type); up = up.parent) {
        if (up.type === 'decorated_definition' || up.namedChildren.some(child => child.type === 'decorator')) return false;
        if (up.previousNamedSibling && LEADING_NODES.has(up.previousNamedSibling.type)) return false;
        if (!sameNode(up, node) && up.childForFieldName('type')) return false;
    }
    const written = node.childForFieldName('return_type');
    if (!written) return true;
    return !tokensOf(written).some(([type, text]) =>
        /identifier|string/.test(type) || (neverTypes || []).includes(text));
}

/**
 * The return derivation of a body: what the type of its result can depend
 * on, read conservatively from syntax.
 *
 * The result expressions come first, each with the control nesting it sits
 * under (wrapping a `return` in an `if` lets the callable fall off its
 * end). Then every statement connected to them through a variable name, in
 * any position and transitively: a binding of a returned name, a call that
 * mutates the object it names (`xs.push("text")` before `return xs`), a
 * condition that narrows it (`typeof x === 'number'` before `return x`), a
 * closure that assigns it, and whatever those statements name in turn;
 * and every statement that sits under a condition of the slice. A type
 * checker follows fewer of these; which ones is its business, and every
 * one it does follow is here.
 *
 * Last, the statements that END a path, whatever they name: the result is
 * the union of the ends that can be reached, so removing the `throw` at
 * the end of a function gives it one more (falling off the end). These are
 * `throw` / `raise`, `break` / `continue`, an assertion, a context
 * manager, a condition that names nothing (`while True`, `if False`), and
 * a statement that only calls something not shown to return
 * (`provablyReturns`). Each is kept by kind and nesting, in source order
 * with the slice: what is thrown, or what a call is passed, changes no
 * type.
 *
 * Where a checker decides conditions from the names in them (trait
 * `namedConditionsDecidable`: an interpreter version or platform test,
 * `TYPE_CHECKING`, a constant its configuration defines), a condition is
 * not opaque: the branch it rules out contributes nothing. There, every
 * statement that holds a statement of the derivation is part of it, and so
 * is every loop condition.
 *
 * A statement that shares no name with the slice and ends no path cannot
 * reach the result.
 *
 * @param {object} [facts] - what `provablyReturns` asks; without it every
 *   bare call is one that may not return
 */
function returnDerivation(body, facts = null) {
    const units = [];
    const decidable = !!(facts && facts.traits && facts.traits.namedConditionsDecidable);
    const receiver = { receiverMembers: !!(facts && facts.receiverMembers), selfName: facts ? facts.selfName : null };
    // An expression body is the result.
    if (!body.namedChildren.some(child => STATEMENT_SHAPE.test(child.type)) &&
        !['block', 'statement_block', 'compound_statement'].includes(body.type)) {
        units.push({ at: body.startIndex, result: true, path: [], ...unitOf(body, receiver) });
    }
    const collect = (container, path, nested, holder) => {
        for (const child of container.namedChildren) {
            if (COMMENT_NODES.has(child.type)) continue;
            const inner = nested || CALLABLE_NODES.has(child.type);
            if (STATEMENT_SHAPE.test(child.type)) {
                // A statement that only calls something shown to return:
                // the call itself narrows nothing and ends nothing.
                const callee = nested ? null : bareCallee(child);
                const plainCall = !!(callee && facts && provablyReturns(callee, facts));
                const unit = {
                    at: child.startIndex,
                    type: child.type,
                    path,
                    // The compound statement this one sits under.
                    holder,
                    ...unitOf(child, { ...receiver, omit: plainCall ? callee : null }),
                };
                // A `return` inside a closure is the closure's result, and
                // what ends the closure's path ends only that.
                unit.result = !nested && (RESULT_NODES.has(child.type) || unit.yields);
                if (!nested && !unit.result) {
                    if (EXIT_NODES.has(child.type)) unit.exit = [EXIT_NODES.get(child.type)];
                    else if (ASSERT_NODES.has(child.type) || MANAGER_NODES.has(child.type)) unit.exit = [child.type, unit.tokens];
                    else if (CONDITION_NODES.has(child.type) && (unit.names.size === 0 ||
                        (decidable && LOOP_NODES.has(child.type) && child.childForFieldName('condition')))) {
                        unit.exit = ['static', unit.tokens];
                    }
                    else if (callee && !plainCall) unit.exit = ['call', callee.text];
                }
                units.push(unit);
                collect(child, [...path, child.type], inner, unit);
            } else {
                collect(child, path, inner, holder);
            }
        }
    };
    collect(body, [], false, null);
    const slice = new Set(units.filter(unit => unit.result));
    const names = new Set();
    for (const unit of slice) for (const name of unit.names) names.add(name);
    const shares = unit => {
        for (const mine of unit.names) for (const name of names) if (overlaps(mine, name)) return true;
        return false;
    };
    // Data dependence: a shared variable name. Control dependence: a
    // statement under a condition that is in the slice decides what that
    // condition lets through (`if x is None: fail()` narrows `x` after it
    // only while `fail()` never returns).
    const held = unit => { for (let up = unit.holder; up; up = up.holder) if (slice.has(up)) return true; return false; };
    for (let grew = slice.size > 0; grew;) {
        grew = false;
        for (const unit of units) {
            if (slice.has(unit)) continue;
            if (!held(unit) && !shares(unit)) continue;
            slice.add(unit);
            for (const name of unit.names) names.add(name);
            grew = true;
        }
    }
    const kept = new Set(units.filter(unit => slice.has(unit) || unit.exit));
    // A `switch` that covers every value of its subject leaves no way past
    // it, and a label narrows the subject inside its case: the subject and
    // the labels of a switch that holds part of the derivation are part of
    // it. Leaving the switch (`break`) is not such a part.
    const switches = new Set();
    for (const unit of kept) {
        if (!slice.has(unit) && unit.exit && (unit.exit[0] === 'break' || unit.exit[0] === 'continue')) continue;
        for (let up = unit.holder; up; up = up.holder) if (SWITCH_NODES.has(up.type)) switches.add(up);
    }
    for (const unit of units) {
        if (switches.has(unit) || (CASE_NODES.has(unit.type) && switches.has(unit.holder))) kept.add(unit);
    }
    // Where a checker can decide a condition from the names in it, every
    // statement that holds one of these decides whether it counts.
    if (decidable) {
        for (const unit of [...kept]) {
            for (let up = unit.holder; up && !kept.has(up); up = up.holder) kept.add(up);
        }
    }
    return JSON.stringify([...kept].sort((a, b) => a.at - b.at).map(unit => {
        if (slice.has(unit)) return [unit.path, unit.tokens];
        return unit.exit ? ['exit', unit.path, ...unit.exit] : ['guard', unit.path, unit.tokens];
    }));
}

/**
 * How the declaration states its return contract: 'declared' (a written
 * type that is the contract), 'unannotated', 'placeholder' (a written type
 * the compiler replaces with the body's), 'opaque' (a written type that
 * still exposes the concrete value's properties).
 */
function returnFormOf(node, declaration, symbol, traits) {
    // A callable instantiated per use (a template, a member of a class
    // template) is type-checked against each caller's arguments: its body
    // is part of what a caller relies on.
    if (symbol && (symbol.templateDependent || symbol.templateParams) &&
        (traits.inferredReturnForms || []).includes('instantiated')) return 'instantiated';
    // An async function returns an anonymous future built from its body,
    // and where that future's properties leak to callers (auto traits),
    // the body is part of the contract.
    if (traits.asyncReturnIsOpaque && tokensOf(declaration, node.childForFieldName('body'))
        .some(([type, text]) => type === 'async' || text === 'async')) return 'opaque';
    // A callable the compiler may run (a constant-evaluated function) hands
    // callers its value, not only its type: its body is the contract. The
    // marker is one of the modifiers written before the name.
    const markers = traits.compileTimeCallableMarkers;
    if (markers && markers.length > 0) {
        const name = node.childForFieldName('name') || node.childForFieldName('declarator');
        const limit = name ? name.startIndex : node.startIndex;
        const modifiers = [];
        const collect = candidate => {
            if (candidate.startIndex >= limit) return;
            if (candidate.childCount === 0) { modifiers.push(candidate.text); return; }
            for (const child of candidate.children) collect(child);
        };
        collect(declaration);
        if (modifiers.some(text => markers.includes(text))) return 'evaluated';
    }
    const written = node.childForFieldName('return_type') || node.childForFieldName('result') ||
        node.childForFieldName('type');
    if (!written) return 'unannotated';
    const text = written.text;
    if (/\b(?:auto|decltype\s*\(\s*auto\s*\))(?![\w:])/.test(text) &&
        !node.descendantsOfType('trailing_return_type').length) return 'placeholder';
    if (/(?:^|[\s(<&])impl\s/.test(text)) return 'opaque';
    return 'declared';
}

/**
 * The contract of one callable in one revision of its file.
 *
 * @param {object} root - syntax tree root of that revision
 * @param {string} language
 * @param {object} symbol - { startLine, endLine, sourceSpan?, className? } in that revision
 * @param {object} [context] - what the revision's file and the project say
 *   about callees: { fileNames: Set of names the file declares or imports,
 *   returning(name, ownerClass): every project declaration of the name
 *   (of the class's own method) is one a call of which returns }
 * @returns {{header, generator, returnForm, inferred, derivation}|null}
 */
function callableContract(root, language, symbol, context = null) {
    if (!root || !symbol) return null;
    const range = rangeOf(symbol);
    const node = callableNodeOf(root, range);
    if (!node) {
        // A declaration with no body (a prototype, an interface method, an
        // overload signature) is all header: every token in its range.
        const header = [];
        const collect = candidate => {
            const startRow = candidate.startPosition.row + 1;
            const endRow = candidate.endPosition.row + 1;
            if (endRow < range.startLine || startRow > range.endLine) return;
            if (candidate.childCount === 0) {
                if (within(candidate, range) && !COMMENT_NODES.has(candidate.type)) header.push([candidate.type, candidate.text]);
                return;
            }
            for (const child of candidate.children) collect(child);
        };
        collect(root);
        if (header.length === 0) return null;
        return {
            header: JSON.stringify(header), generator: false, returnForm: 'declared', inferred: false,
            derivation: null, memberBindings: null,
        };
    }
    if (node.hasError) return null;
    const body = node.childForFieldName('body');
    const declaration = declarationOf(node, range);
    const header = [];
    // Decorators and attributes written before the declaration.
    const leading = [];
    for (let sibling = declaration.previousNamedSibling; sibling && LEADING_NODES.has(sibling.type);
        sibling = sibling.previousNamedSibling) leading.unshift(sibling);
    for (const item of leading) tokensOf(item, null, header);
    tokensOf(declaration, body, header);

    const traits = langTraits(language) || {};
    const returnForm = returnFormOf(node, declaration, symbol, traits);
    const inferred = (traits.inferredReturnForms || []).includes(returnForm);
    let generator = false;
    if (body) {
        walkOwn(body, candidate => {
            if (YIELD_NODES.has(candidate.type)) generator = true;
            return true;
        });
    }
    let derivation = null;
    if (inferred && body) {
        // Expression by expression where the form is "no annotation"; the
        // whole body where the compiler deduces the type from all of it.
        if (returnForm === 'unannotated') {
            // Names the callable binds itself: its parameters and whatever
            // its own statements assign.
            const locals = new Set();
            const parameters = node.childForFieldName('parameters') || node.childForFieldName('parameter');
            if (parameters) identifiersOf(parameters, locals);
            walkOwn(body, candidate => {
                for (const target of bindingTargets(candidate)) identifiersOf(target, locals);
                return true;
            });
            const leading = parameters ? parameters.namedChildren[0] : null;
            const first = leading ? [...identifiersOf(leading)][0] : null;
            const selfName = symbol.className && first && (traits.selfParam || []).includes(first) ? first : null;
            // The receiver of a class member is an instance of the class.
            // One whose type is WRITTEN (`this: A | B`, `self: Shape`) is
            // whatever that says, a union included: a variable like any.
            const typedReceiver = !!leading && (leading.descendantsOfType('this').length > 0 ||
                (selfName !== null && leading.type !== 'identifier'));
            derivation = returnDerivation(body, {
                traits, context, locals, ownerClass: symbol.className || null, selfName,
                receiverMembers: !!symbol.className && !typedReceiver,
            });
        } else {
            derivation = JSON.stringify(tokensOf(body));
        }
    }
    // Where a member's type is whatever the class's methods assign to it
    // (trait `memberTypesFromAssignments`), every assignment to a member of
    // the receiver is part of the class's contract, in whichever method it
    // is written.
    let memberBindings = null;
    if (traits.memberTypesFromAssignments && body) {
        const receiver = node.childForFieldName('parameters')?.namedChildren[0];
        const receiverName = receiver ? [...identifiersOf(receiver)][0] : null;
        const parts = [];
        if (receiverName) {
            walkOwn(body, candidate => {
                for (const target of bindingTargets(candidate)) {
                    const members = target.type === 'attribute' ? [target] : target.descendantsOfType('attribute');
                    if (members.some(member => member.childForFieldName('object')?.text === receiverName)) {
                        parts.push(JSON.stringify(tokensOf(candidate)));
                        break;
                    }
                }
                return true;
            });
        }
        memberBindings = JSON.stringify(parts.sort());
    }
    return { header: JSON.stringify(header), generator, returnForm, inferred, derivation, memberBindings };
}

/**
 * Compare a callable's contract before and after a change.
 *
 * @returns {{kind: 'inert'|'contract'|'unknown', reasons: string[]}}
 *   reasons: 'header', 'callable-kind', 'inferred-return-contract',
 *   'inferred-member-type', or 'contract-unreadable' for `unknown`.
 */
function classifyChange(before, after, language) {
    if (!before || !after) return { kind: 'unknown', reasons: ['contract-unreadable'] };
    const traits = langTraits(language) || {};
    const reasons = [];
    if (before.header !== after.header) reasons.push('header');
    if ((traits.callableKindFromBody || []).includes('generator') &&
        before.generator !== after.generator) reasons.push('callable-kind');
    if ((before.inferred || after.inferred) && before.derivation !== after.derivation) {
        reasons.push('inferred-return-contract');
    }
    if ((before.memberBindings || null) !== (after.memberBindings || null)) reasons.push('inferred-member-type');
    return { kind: reasons.length > 0 ? 'contract' : 'inert', reasons };
}

/** The declaration in the base revision that a changed one continues. */
function baseCounterpart(baseSymbols, symbol, isCallable) {
    const identity = candidate => `${candidate.name}\0${candidate.className || ''}`;
    const same = (baseSymbols || []).filter(candidate => isCallable(candidate) &&
        identity(candidate) === identity(symbol));
    if (same.length <= 1) return same[0] || null;
    // Overloads: the one with the same written parameters, else the nearest.
    const exact = same.filter(candidate => (candidate.params || '') === (symbol.params || ''));
    const pool = exact.length > 0 ? exact : same;
    return pool.reduce((best, candidate) =>
        (Math.abs(candidate.startLine - symbol.startLine) < Math.abs(best.startLine - symbol.startLine) ? candidate : best));
}

// Top-level statements that bind or pass on names rather than run code.
const IMPORT_SHAPE = /import|export|^use_declaration$|^extern_crate|^preproc_include$|^package_clause$|^package_declaration$|^using_directive$|^mod_item$/;
const PREPROC_CONDITIONAL = /^preproc_(?:if|ifdef|elif|else)/;

/**
 * The module-level statements of one revision that are not declarations:
 * what binds or runs when the module loads. Declarations are compared as
 * symbols; these are what a symbol diff never sees.
 *
 * @param {object} root - syntax tree root
 * @param {object[]} symbols - the revision's indexed symbols (their ranges
 *   are the declarations)
 * @param {object[]} [exportDetails] - the revision's export records: a
 *   statement on a line one of them names is an export, whatever its
 *   syntax (`module.exports = {...}` is an assignment)
 * @param {object[]} [importDetails] - its import records, likewise
 *   (`const x = require('m')` is a declaration)
 * @returns {{imports: string[], exports: string[], code: string[]}} one
 *   token signature per statement, sorted. What an export statement
 *   provides is compared by name (providedNames); what an import binds, by
 *   binding; `imports` and `code` are compared as written.
 */
function moduleStatements(root, symbols, exportDetails, importDetails) {
    const exportLines = new Set((exportDetails || []).map(detail => detail && detail.line).filter(Boolean));
    // An import written as a call (`const x = require('m')`) is an import.
    const importLines = new Set((importDetails || []).map(detail => detail && detail.line).filter(Boolean));
    const importsHere = node => {
        for (let line = node.startPosition.row + 1; line <= node.endPosition.row + 1; line++) {
            if (importLines.has(line)) return true;
        }
        return false;
    };
    const exportsHere = node => {
        for (let line = node.startPosition.row + 1; line <= node.endPosition.row + 1; line++) {
            if (exportLines.has(line)) return true;
        }
        return false;
    };
    // Members count: a block that only holds members (an impl block, an
    // extension) is not a symbol itself, and is still all declarations.
    const declared = (symbols || []).map(symbol => [symbol.startLine, symbol.endLine || symbol.startLine]);
    const overlapsDeclaration = node => {
        const start = node.startPosition.row + 1;
        const end = node.endPosition.row + 1;
        return declared.some(([from, to]) => from <= end && to >= start);
    };
    const imports = [];
    const exports = [];
    const code = [];
    const visit = container => {
        for (const node of container.namedChildren) {
            if (COMMENT_NODES.has(node.type)) continue;
            if (PREPROC_CONDITIONAL.test(node.type)) {
                // The condition decides what the build holds; the body is
                // more module-level statements.
                const first = node.namedChildren[0];
                code.push(JSON.stringify([node.type, first ? tokensOf(first) : []]));
                visit(node);
                continue;
            }
            if (overlapsDeclaration(node)) continue;
            const bucket = node.type.includes('export') || exportsHere(node) ? exports
                : IMPORT_SHAPE.test(node.type) || importsHere(node) ? imports : code;
            bucket.push(JSON.stringify(tokensOf(node)));
        }
    };
    if (root) visit(root);
    return { imports: imports.sort(), exports: exports.sort(), code: code.sort() };
}

/**
 * Names a module lets another file import from it: what its exports name
 * (the name an importer writes: the alias of a renamed export) and, where
 * any module-level name can be imported (trait `moduleNamesImportable`),
 * every module-level declaration and every name the module itself imports.
 * `open` when the module passes on everything another module exports: the
 * names it provides are not all written in it.
 */
function providedNames(fileEntry, traits) {
    const names = new Set();
    let open = false;
    for (const detail of (fileEntry && fileEntry.exportDetails) || []) {
        if (!detail || !detail.name) continue;
        if (detail.name === '*' || detail.type === 're-export-all') { open = true; continue; }
        // The default export is imported under whatever name the importer
        // picks: it is one provided thing, named `default` here.
        if (detail.type === 'default') { names.add('default'); continue; }
        names.add(detail.alias || detail.name);
    }
    if (traits && traits.moduleNamesImportable) {
        for (const symbol of (fileEntry && fileEntry.symbols) || []) {
            if (!symbol.className && symbol.lexicalScopeStartLine == null) names.add(symbol.name);
        }
        for (const binding of (fileEntry && fileEntry.importBindings) || []) {
            if (binding.lexicalScopeStartLine == null) names.add(binding.alias || binding.name);
        }
    }
    return { names, open };
}

/** Where each module-level import binding of a file comes from, by local name. */
function sourcesOf(fileEntry) {
    const sources = new Map();
    for (const binding of (fileEntry && fileEntry.importBindings) || []) {
        if (binding.lexicalScopeStartLine != null) continue;
        const local = binding.alias || binding.name;
        const source = `${binding.module}\0${binding.name}\0${binding.kind || ''}`;
        sources.set(local, sources.has(local) ? `${sources.get(local)}\n${source}` : source);
    }
    return sources;
}

/** Multiset difference: entries of `before` that `after` does not have. */
function removedFrom(before, after) {
    const remaining = new Map();
    for (const item of after) remaining.set(item, (remaining.get(item) || 0) + 1);
    const removed = [];
    for (const item of before) {
        const count = remaining.get(item) || 0;
        if (count > 0) remaining.set(item, count - 1);
        else removed.push(item);
    }
    return removed;
}

/**
 * What a change did to a module outside its declarations.
 *
 * @returns {{removedNames, removedExports, starExportRemoved, importsRemoved,
 *   importsAdded, addedBindings, removedBindings, reboundBindings, codeChanged}}
 *   removedNames: names importers could take from the module and no longer
 *   can; removedExports: those of them the module exported explicitly;
 *   removedBindings / addedBindings: local names its imports no longer /
 *   newly bind; removedBareImports: modules it imported without binding
 *   a name and no longer imports;
 *   importsRemoved / importsAdded: import statements that disappeared /
 *   appeared as written; codeChanged: loose module-level code differs.
 */
function moduleChange(before, after, traits) {
    const was = providedNames(before.fileEntry, traits);
    const is = providedNames(after.fileEntry, traits);
    const removedNames = is.open ? [] : [...was.names].filter(name => !is.names.has(name)).sort();
    const statementsOf = side => moduleStatements(side.root, side.fileEntry && side.fileEntry.symbols,
        side.fileEntry && side.fileEntry.exportDetails, side.fileEntry && side.fileEntry.importDetails);
    const beforeStatements = statementsOf(before);
    const afterStatements = statementsOf(after);
    const locals = entry => new Set(((entry && entry.importBindings) || [])
        .filter(binding => binding.lexicalScopeStartLine == null).map(binding => binding.alias || binding.name));
    const hadLocals = locals(before.fileEntry);
    const hasLocals = locals(after.fileEntry);
    const explicit = entry => new Set(((entry && entry.exportDetails) || [])
        .filter(detail => detail && detail.name && detail.name !== '*')
        .map(detail => (detail.type === 'default' ? 'default' : detail.alias || detail.name)));
    const exported = explicit(before.fileEntry);
    return {
        removedNames,
        removedExports: removedNames.filter(name => exported.has(name)),
        // The module passed on everything another module exports, and no
        // longer does: which names that took away is not written here.
        starExportRemoved: was.open && !is.open,
        removedBindings: [...hadLocals].filter(name => !hasLocals.has(name)).sort(),
        // Local names that are still imported, from somewhere else or as
        // something else: every use of the name in the file now means it.
        reboundBindings: [...hasLocals].filter(name => hadLocals.has(name) &&
            sourcesOf(before.fileEntry).get(name) !== sourcesOf(after.fileEntry).get(name)).sort(),
        // Modules the file imported or included, binding no name, and no
        // longer does: they were there for what importing them does.
        removedBareImports: removedFrom(
            [...new Set((before.fileEntry && before.fileEntry.imports) || [])],
            [...new Set((after.fileEntry && after.fileEntry.imports) || [])])
            .filter(module => !((before.fileEntry && before.fileEntry.importBindings) || [])
                .some(binding => binding.module === module)).sort(),
        importsRemoved: removedFrom(beforeStatements.imports, afterStatements.imports).length,
        importsAdded: removedFrom(afterStatements.imports, beforeStatements.imports).length,
        addedBindings: [...hasLocals].filter(name => !hadLocals.has(name)).sort(),
        codeChanged: removedFrom(beforeStatements.code, afterStatements.code).length > 0 ||
            removedFrom(afterStatements.code, beforeStatements.code).length > 0,
    };
}

function parseRevision(content, language) {
    const parser = getParser(language);
    if (!parser || content == null) return null;
    try { return safeParse(parser, content).rootNode; } catch { return null; }
}

module.exports = {
    callableContract, classifyChange, baseCounterpart, parseRevision,
    declaresPlainReturn, moduleStatements, providedNames, moduleChange,
};
