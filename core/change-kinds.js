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
 *               expressions that produce the result and everything that
 *               binds a name they use.
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

/**
 * The return derivation of a body: each result expression with the control
 * nesting it sits under (wrapping a `return` in an `if` lets the callable
 * fall off its end), then every node that binds a name those expressions
 * use, closed over the names the bindings use in turn.
 */
function returnDerivation(body) {
    const parts = [];
    const names = new Set();
    // An expression body is the result.
    if (!body.namedChildren.some(child => child.type.endsWith('statement') || child.type.endsWith('declaration')) &&
        !['block', 'statement_block', 'compound_statement'].includes(body.type)) {
        parts.push({ at: body.startIndex, text: JSON.stringify([[], tokensOf(body)]) });
        identifiersOf(body, names);
    }
    const bindings = [];
    walkOwn(body, (node, path) => {
        if (RESULT_NODES.has(node.type) || YIELD_NODES.has(node.type)) {
            parts.push({ at: node.startIndex, text: JSON.stringify([path, tokensOf(node)]) });
            identifiersOf(node, names);
            return false;
        }
        if (bindingTargets(node).length > 0) bindings.push(node);
        return true;
    });
    const taken = new Set();
    for (let changed = true; changed;) {
        changed = false;
        for (const node of bindings) {
            if (taken.has(node.id)) continue;
            const bound = new Set();
            for (const target of bindingTargets(node)) identifiersOf(target, bound);
            if (![...bound].some(name => names.has(name))) continue;
            taken.add(node.id);
            parts.push({ at: node.startIndex, text: JSON.stringify(tokensOf(node)) });
            identifiersOf(node, names);
            changed = true;
        }
    }
    return JSON.stringify(parts.sort((a, b) => a.at - b.at).map(part => part.text));
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
 * @param {object} symbol - { startLine, endLine, sourceSpan? } in that revision
 * @returns {{header, generator, returnForm, inferred, derivation}|null}
 */
function callableContract(root, language, symbol) {
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
        derivation = returnForm === 'unannotated' ? returnDerivation(body) : JSON.stringify(tokensOf(body));
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
 *   importsAdded, addedBindings, removedBindings, codeChanged}}
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
    moduleStatements, providedNames, moduleChange,
};
