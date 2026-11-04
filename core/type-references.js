/**
 * core/type-references.js - Every reference to a renamed type (fix #386).
 *
 * Renaming a class, struct, interface, trait, enum, record, union or type
 * alias changes every token that NAMES that type: base and implements
 * clauses, field/parameter/return/local and generic-argument types, casts
 * and type tests, static member qualifiers (`Widget.CONST`, `Widget::f`),
 * constructor and destructor names, member initializers, construction
 * expressions, imports and re-exports, qualified spellings (`pkg.Widget`,
 * `app::Widget`, `crate::m::Widget`). Call-shaped constructor sites are only
 * a fraction of them.
 *
 * For one pinned type definition this module walks the ground lines of the
 * name (the literal-name text set), finds every identifier token spelling
 * the name in the parsed tree, classifies its syntactic position per
 * language and decides what the token denotes:
 *
 *   'edit'   the token names the pinned type (or a declaration that is the
 *            same entity: TS class/interface merging, C# partial parts,
 *            configuration alternatives, Go build variants)
 *   'review' it may name it and UCN cannot prove which declaration it
 *            names (the reason travels with it)
 *   'skip'   it provably names something else: another type of that name
 *            in another module/package/namespace, a member, a local
 *            binding, a type parameter, a declaration of another entity
 *
 * Resolution follows each language's own name lookup, conservatively:
 * lexical bindings and type parameters shadow; a same-file declaration in
 * scope wins; then imports (JS/TS, Python, Rust `use`, Java single-type and
 * on-demand imports, C# usings), packages (Go directories, Java packages),
 * namespaces (C#, C++ via cpp-scope), include closures (C/C++). Anything the
 * model cannot settle is a review item, never a silent edit and never a
 * silent omission. A ground line that holds the name outside any parsed
 * token and outside comments/strings (macro bodies, unparsed regions) is a
 * review item too.
 */

'use strict';

const path = require('path');
const { getParser, safeParse, langTraits, LANGUAGES } = require('../languages');
const { sameNode } = require('../languages/utils');
const { jsPatternTarget } = require('../languages/lexical-scope');
const { classKeyOf } = require('./class-identity');
const { projectHas, sharedRead } = require('./provenance-overload');
const { indexedContent } = require('./source-memo');

// Modules read lazily (load cycles), each resolved once: a require() per
// call in hot paths was measurable (fix #436).
let lazyCppScopeModuleCache = null;
const lazyCppScopeModule = () => lazyCppScopeModuleCache || (lazyCppScopeModuleCache = require('./cpp-scope'));

/** The namespaces (packages) a language's files declare, with each dotted prefix. */
function declaredNamespacePrefixes(index, language) {
    return require('./type-denotation').memoizedDerivation(index, `\x01ns-prefixes\x00${language}`, () => {
        const namespaces = new Set();
        for (const entry of index.files.values()) {
            if (entry.language !== language) continue;
            for (const s of entry.symbols || []) {
                if (!s.namespace) continue;
                const parts = s.namespace.split('.');
                for (let i = 1; i <= parts.length; i++) namespaces.add(parts.slice(0, i).join('.'));
            }
        }
        return namespaces;
    });
}
const csharpNamespacePrefixes = index => declaredNamespacePrefixes(index, 'csharp');
const javaPackagePrefixes = index => declaredNamespacePrefixes(index, 'java');

const TYPE_RENAME_KINDS = new Set([
    'class', 'struct', 'interface', 'trait', 'enum', 'record', 'union', 'type',
    // TypeScript namespaces (fix #389): a container name used in type and
    // value positions (`Geometry.Point`, `Geometry.origin()`), renamed with
    // the same lookup.
    'namespace',
]);
// Declarations a type NAME can resolve to (type namespace).
const TYPE_DECL_KINDS = TYPE_RENAME_KINDS;
const TOKEN_TYPES = new Set([
    'identifier', 'type_identifier', 'field_identifier', 'property_identifier',
    'shorthand_property_identifier', 'shorthand_property_identifier_pattern',
    'namespace_identifier', 'package_identifier', 'statement_identifier',
    'shorthand_field_identifier', 'private_property_identifier', 'label_name',
]);
const MAX_QUALIFIER_HOPS = 6;

function familyOf(language) {
    if (language === 'javascript' || language === 'typescript' || language === 'tsx') return 'js';
    if (language === 'c' || language === 'cpp') return 'c';
    return language;
}

/** Is `def` a declaration whose rename is a type rename? */
function isTypeRenamePin(def) {
    return !!def && TYPE_RENAME_KINDS.has(def.type) && !def.isMethod;
}

// ── AST helpers ──────────────────────────────────────────────────────────

function fieldOf(node) {
    const parent = node.parent;
    if (!parent) return null;
    for (let i = 0; i < parent.childCount; i++) {
        const child = parent.child(i);
        if (child.startIndex === node.startIndex && child.endIndex === node.endIndex &&
            child.type === node.type) {
            return parent.fieldNameForChild(i) || null;
        }
    }
    return null;
}

function isField(node, field) {
    const child = node.parent?.childForFieldName(field);
    return !!child && sameNode(child, node);
}

function ancestor(node, types, stopTypes = null) {
    for (let current = node.parent; current; current = current.parent) {
        if (types.has(current.type)) return current;
        if (stopTypes && stopTypes.has(current.type)) return null;
    }
    return null;
}

function contains(outer, inner) {
    return outer.startIndex <= inner.startIndex && outer.endIndex >= inner.endIndex;
}

function textOf(node) {
    return node ? node.text.replace(/\s+/g, '') : '';
}

// ── Token classification per language ───────────────────────────────────
//
// A role says where a token stands:
//   decl      the name of a type-like declaration (declNode)
//   ctor      a constructor/destructor name inside a class body (classNode)
//   type      a type position, optionally qualified (qualifier node/text)
//   value     an expression position, optionally qualified
//   member    a member access name (receiver node): a member unless the
//             receiver is a module/package/namespace/type
//   import    the source-side name of an import/re-export (module text)
//   meminit   a C++ member-initializer name (base, delegating or member)
//   macro     a Rust macro-invocation token
//   template  a token of a macro definition body (binds at expansion)
//   gofield   a Go selector/key that may be an embedded field
//   shorthand a JS shorthand property (key and value at once)
//   skip      not a reference (binding: true when it declares a local
//             value that can shadow; typeParam: true for a type parameter)
//   unknown   an unmodelled position

const skip = (why, extra = {}) => ({ role: 'skip', why, ...extra });

function classifyJava(node) {
    const parent = node.parent;
    const field = fieldOf(node);
    switch (parent.type) {
        case 'class_declaration': case 'interface_declaration': case 'enum_declaration':
        case 'record_declaration': case 'annotation_type_declaration':
            if (field === 'name') return { role: 'decl', declNode: parent };
            break;
        case 'constructor_declaration': case 'compact_constructor_declaration':
            if (field === 'name') return { role: 'ctor', classNode: ancestor(node, JAVA_CLASS_NODES) };
            break;
        case 'method_declaration': case 'annotation_type_element_declaration':
            if (field === 'name') return skip('method-name');
            break;
        case 'variable_declarator':
            if (field === 'name') return skip('variable', { binding: true });
            break;
        case 'formal_parameter': case 'catch_formal_parameter': case 'spread_parameter':
        case 'enhanced_for_statement': case 'resource':
            if (field === 'name') return skip('parameter', { binding: true });
            break;
        // Pattern variables (fix #420): `o instanceof T v`, `case T v`,
        // `case R(int v, ..)` declare locals whose scope follows the
        // pattern's flow (JLS 6.3.1).
        case 'instanceof_expression':
            if (field === 'name') return skip('pattern', { binding: true });
            break;
        case 'type_pattern': case 'record_pattern_component':
            if (node.type === 'identifier') return skip('pattern', { binding: true });
            break;
        case 'lambda_expression':
            if (field === 'parameters') return skip('parameter', { binding: true });
            break;
        case 'inferred_parameters':
            return skip('parameter', { binding: true });
        case 'type_parameter':
            return skip('type-parameter', { typeParam: true });
        case 'enum_constant':
            if (field === 'name') return skip('enum-constant');
            break;
        case 'scoped_type_identifier': {
            const qualifier = parent.namedChild(0);
            if (qualifier && !sameNode(qualifier, node)) return { role: 'type', qualifier };
            return { role: 'type' };
        }
        case 'scoped_identifier': {
            if (ancestor(node, new Set(['package_declaration']))) return skip('package');
            const scope = parent.childForFieldName('scope');
            if (field === 'name' && scope) {
                return ancestor(node, new Set(['import_declaration']))
                    ? { role: 'import', qualifierText: textOf(scope) }
                    : { role: 'value', qualifier: scope };
            }
            return { role: 'value' };
        }
        case 'field_access':
            if (field === 'field') return { role: 'member', receiver: parent.childForFieldName('object') };
            return { role: 'value' };
        case 'method_invocation':
            if (field === 'name') return skip('method-call');
            return { role: 'value' };
        case 'marker_annotation': case 'annotation':
            if (field === 'name') return { role: 'type' };
            break;
        case 'element_value_pair':
            if (field === 'key') return skip('annotation-element');
            break;
        case 'labeled_statement': case 'break_statement': case 'continue_statement':
            return skip('label');
        case 'object_creation_expression': {
            // A qualified instance creation `outer.new Inner()` names a
            // member class of the outer expression's type (JLS 15.9.1), not a
            // type in scope at the site (fix #426).
            const outer = parent.namedChild(0);
            if (outer && field === 'type' && !sameNode(outer, node) &&
                outer.endIndex <= node.startIndex) return { role: 'qualified-creation', outer };
            break;
        }
        default:
            break;
    }
    if (node.type === 'type_identifier') return { role: 'type' };
    if (node.type === 'identifier') return { role: 'value' };
    return { role: 'unknown', why: `java:${parent.type}` };
}

/**
 * The declared type of a Java expression naming a value, read from its
 * declaration in scope (fix #426): `this` is the enclosing class, a simple
 * name the nearest local, parameter or field declaring it. null otherwise.
 */
function javaExpressionTypeName(expression) {
    const head = typeNode => {
        if (!typeNode) return null;
        if (typeNode.type === 'generic_type') {
            return head(typeNode.namedChildren.find(child =>
                child.type === 'type_identifier' || child.type === 'scoped_type_identifier'));
        }
        if (typeNode.type === 'scoped_type_identifier') return typeNode.namedChildren.at(-1)?.text || null;
        return typeNode.type === 'type_identifier' ? typeNode.text : null;
    };
    if (expression.type === 'this') {
        const owner = ancestor(expression, JAVA_CLASS_NODES);
        return owner?.childForFieldName('name')?.text || null;
    }
    if (expression.type !== 'identifier') return null;
    const name = expression.text;
    const declares = (declaration) => (declaration.namedChildren || []).some(child =>
        child.type === 'variable_declarator' && child.childForFieldName('name')?.text === name);
    for (let scope = expression.parent; scope; scope = scope.parent) {
        if (scope.type === 'block' || scope.type === 'constructor_body' || scope.type === 'class_body') {
            for (const child of scope.namedChildren || []) {
                if (child.startIndex >= expression.startIndex && scope.type !== 'class_body') break;
                if ((child.type === 'local_variable_declaration' || child.type === 'field_declaration') &&
                    declares(child)) return head(child.childForFieldName('type'));
            }
        }
        if (['method_declaration', 'constructor_declaration', 'lambda_expression'].includes(scope.type)) {
            const params = scope.childForFieldName('parameters');
            for (const param of params?.namedChildren || []) {
                if ((param.type === 'formal_parameter' || param.type === 'spread_parameter') &&
                    param.childForFieldName('name')?.text === name) return head(param.childForFieldName('type'));
            }
        }
        if (JAVA_CLASS_NODES.has(scope.type)) {
            // Fields of an enclosing class are in scope through its body.
            continue;
        }
    }
    return null;
}
const JAVA_CLASS_NODES = new Set(['class_declaration', 'enum_declaration', 'record_declaration',
    'interface_declaration']);

const CSHARP_TYPE_DECLS = new Set(['class_declaration', 'struct_declaration', 'interface_declaration',
    'enum_declaration', 'record_declaration', 'record_struct_declaration', 'delegate_declaration']);
const CSHARP_TYPE_PARENTS = new Set(['base_list', 'type_argument_list', 'array_type', 'nullable_type',
    'pointer_type', 'ref_type', 'tuple_element', 'type_parameter_constraint', 'type_constraint',
    'typeof_expression', 'sizeof_expression', 'default_expression', 'as_expression',
    'is_expression', 'function_pointer_type', 'scoped_type', 'primary_constructor_base_type']);

// Expressions whose `{ Member = value }` initializer assigns members of
// the object they create (fix #395); array initializers assign variables.
const CSHARP_OBJECT_INITIALIZER_OWNERS = new Set(['object_creation_expression',
    'implicit_object_creation_expression', 'assignment_expression']);

function classifyCSharp(node) {
    let current = node;
    let parent = node.parent;
    // `Widget<T>`: the generic name stands where the identifier would.
    if (parent.type === 'generic_name' && sameNode(parent.namedChild(0), node)) {
        current = parent;
        parent = parent.parent;
    }
    const field = fieldOf(current);
    if (CSHARP_TYPE_DECLS.has(parent.type) && field === 'name') return { role: 'decl', declNode: parent };
    switch (parent.type) {
        case 'constructor_declaration': case 'destructor_declaration':
            if (field === 'name') return { role: 'ctor', classNode: ancestor(node, CSHARP_TYPE_DECLS) };
            break;
        case 'method_declaration': case 'local_function_statement': case 'property_declaration':
        case 'event_declaration': case 'enum_member_declaration': case 'operator_declaration':
            if (field === 'name') return skip('member-name');
            break;
        case 'variable_declarator':
            if (field === 'name' || sameNode(parent.namedChild(0), current)) return skip('variable', { binding: true });
            break;
        case 'parameter':
            if (field === 'name') return skip('parameter', { binding: true });
            break;
        case 'catch_declaration': case 'foreach_statement': case 'single_variable_designation':
            if (field === 'name' || parent.type === 'single_variable_designation') {
                return skip('variable', { binding: true });
            }
            break;
        case 'type_parameter':
            return skip('type-parameter', { typeParam: true });
        case 'qualified_name': {
            const qualifier = parent.childForFieldName('qualifier');
            if (field === 'name' && qualifier) return { role: 'type', qualifier };
            return { role: 'type' };
        }
        case 'alias_qualified_name':
            if (field === 'name') return { role: 'type', qualifier: parent.childForFieldName('alias'), aliasQualified: true };
            return skip('extern-alias');
        case 'invocation_expression':
            if (field === 'function') return skip('method-call');
            break;
        case 'member_access_expression':
            if (field === 'name') return { role: 'member', receiver: parent.childForFieldName('expression') };
            return { role: 'value' };
        case 'using_directive':
            // `using W = X.Y;` names the alias W here.
            return skip('using-alias');
        case 'name_equals': case 'name_colon': case 'argument_name':
            return skip('named-argument');
        case 'assignment_expression':
            // `new Address { Country = new Country() }`: the left side of an
            // object initializer names a member of the created type, never
            // a type (fix #395); a nested `Home = { Country = .. }` too.
            if (field === 'left' && current.type === 'identifier' &&
                parent.parent?.type === 'initializer_expression' &&
                CSHARP_OBJECT_INITIALIZER_OWNERS.has(parent.parent.parent?.type)) {
                return skip('initializer-member');
            }
            break;
        case 'attribute':
            if (field === 'name') return { role: 'type', attribute: true };
            break;
        case 'labeled_statement': case 'goto_statement':
            return skip('label');
        default:
            break;
    }
    if (field === 'type' || field === 'returns' || CSHARP_TYPE_PARENTS.has(parent.type)) {
        return { role: 'type' };
    }
    return { role: 'value' };
}

const JS_TYPE_DECLS = new Set(['class_declaration', 'class', 'abstract_class_declaration',
    'interface_declaration', 'type_alias_declaration', 'enum_declaration']);

function classifyJs(node) {
    const parent = node.parent;
    const field = fieldOf(node);
    if (JS_TYPE_DECLS.has(parent.type) && field === 'name') return { role: 'decl', declNode: parent };
    switch (parent.type) {
        case 'import_specifier':
            if (field === 'alias' && parent.childForFieldName('name')?.text !== node.text) return skip('import-alias');
            if (parent.childForFieldName('alias')) {
                return { role: 'import', importNode: parent, aliased: true };
            }
            return { role: 'import', importNode: parent };
        case 'import_clause': case 'namespace_import':
            return skip('import-local');
        case 'export_specifier': {
            if (field === 'alias' && parent.childForFieldName('name')?.text !== node.text) return skip('export-alias');
            const statement = ancestor(node, new Set(['export_statement']));
            if (statement?.childForFieldName('source')) return { role: 'import', importNode: parent, reexport: true };
            return { role: 'value', exportLocal: true };
        }
        case 'nested_type_identifier':
            if (field === 'name') return { role: 'type', qualifier: parent.childForFieldName('module') };
            return { role: 'value' };
        case 'member_expression':
            if (field === 'property') return { role: 'member', receiver: parent.childForFieldName('object') };
            return { role: 'value' };
        case 'required_parameter': case 'optional_parameter':
            // The parameter's pattern binds; its default value and type are
            // read (fix #431: `x: number = LIMIT` reads LIMIT).
            if (node.type === 'identifier' && field === 'pattern') return skip('parameter', { binding: true });
            break;
        case 'formal_parameters':
            if (node.type === 'identifier') return skip('parameter', { binding: true });
            break;
        case 'rest_pattern': case 'array_pattern': case 'assignment_pattern':
        case 'object_assignment_pattern': {
            if (node.type !== 'identifier') break;
            // A destructuring target declares a name, or (an assignment
            // pattern, `[a, b] = f()`) writes the binding in scope (fix #431).
            const target = jsPatternTarget(node);
            if (target === 'declaration') return skip('parameter', { binding: true });
            if (target === 'assignment') return { role: 'value', patternWrite: true };
            break;
        }
        case 'variable_declarator':
            if (field === 'name') return skip('variable', { binding: true });
            break;
        case 'catch_clause':
            if (field === 'parameter') return skip('variable', { binding: true });
            break;
        case 'arrow_function':
            if (field === 'parameter') return skip('parameter', { binding: true });
            break;
        case 'function_declaration': case 'generator_function_declaration':
            if (field === 'name') return skip('function', { binding: true });
            break;
        case 'function_expression': case 'function': case 'generator_function':
            if (field === 'name') return skip('function-expression-name');
            break;
        case 'method_definition': case 'method_signature': case 'abstract_method_signature':
        case 'public_field_definition': case 'property_signature': case 'field_definition':
            if (field === 'name') return skip('member-name');
            break;
        case 'pair': case 'pair_pattern':
            if (field === 'key') {
                // `const { Widget: W } = require('./w')` imports Widget.
                const required = parent.type === 'pair_pattern' ? requireSourceOf(parent) : null;
                if (required) return { role: 'import', requireSource: required, aliased: true };
                return skip('property-key');
            }
            if (parent.type === 'pair_pattern' && field === 'value' && node.type === 'identifier') {
                const target = jsPatternTarget(node);
                if (target === 'declaration') return skip('destructured', { binding: true });
                if (target === 'assignment') return { role: 'value', patternWrite: true };
            }
            break;
        case 'type_parameter':
            if (field === 'name') return skip('type-parameter', { typeParam: true });
            break;
        case 'enum_assignment': case 'enum_body':
            return skip('enum-member');
        case 'labeled_statement': case 'break_statement': case 'continue_statement':
            return skip('label');
        default:
            break;
    }
    if (node.type === 'shorthand_property_identifier') return { role: 'shorthand' };
    if (node.type === 'shorthand_property_identifier_pattern') {
        // `const { Widget } = require('./w')` is an import of Widget.
        const required = requireSourceOf(node);
        if (required) return { role: 'import', requireSource: required };
        // `({ a } = obj)` writes the binding in scope (fix #431).
        if (jsPatternTarget(node) === 'assignment') return { role: 'value', patternWrite: true };
        return skip('destructured', { binding: true });
    }
    if (node.type === 'type_identifier') return { role: 'type' };
    if (node.type === 'identifier') return { role: 'value' };
    if (node.type === 'property_identifier' || node.type === 'private_property_identifier') {
        return skip('property-name');
    }
    if (node.type === 'statement_identifier') return skip('label');
    return { role: 'unknown', why: `js:${parent.type}` };
}

/** The module a destructuring pattern takes from `require('m')`, or null. */
function requireSourceOf(node) {
    let current = node.parent;
    while (current && (current.type === 'object_pattern' || current.type === 'pair_pattern')) current = current.parent;
    if (current?.type !== 'variable_declarator') return null;
    let value = current.childForFieldName('value');
    if (value?.type === 'await_expression') value = value.namedChild(0);
    if (value?.type !== 'call_expression') return null;
    const callee = value.childForFieldName('function');
    if (!callee || (callee.text !== 'require' && callee.type !== 'import')) return null;
    const arg = value.childForFieldName('arguments')?.namedChild(0);
    if (arg?.type !== 'string') return null;
    return arg.text.replace(/^['"`]|['"`]$/g, '');
}

function classifyPython(node) {
    const parent = node.parent;
    const field = fieldOf(node);
    switch (parent.type) {
        case 'class_definition':
            if (field === 'name') return { role: 'decl', declNode: parent };
            break;
        case 'function_definition':
            if (field === 'name') return skip('function', { binding: true });
            break;
        case 'attribute':
            if (field === 'attribute') return { role: 'member', receiver: parent.childForFieldName('object') };
            return { role: 'value' };
        case 'keyword_argument':
            if (field === 'name') return skip('keyword-argument');
            break;
        case 'parameters': case 'lambda_parameters': case 'list_splat_pattern':
        case 'dictionary_splat_pattern':
            return skip('parameter', { binding: true });
        case 'typed_parameter':
            if (sameNode(parent.namedChild(0), node)) return skip('parameter', { binding: true });
            break;
        case 'default_parameter': case 'typed_default_parameter':
            if (field === 'name') return skip('parameter', { binding: true });
            break;
        case 'global_statement': case 'nonlocal_statement':
            return skip('scope-declaration', { scopeDeclaration: parent.type });
        case 'dotted_name': {
            const from = ancestor(node, new Set(['import_from_statement']));
            if (from) {
                const moduleName = from.childForFieldName('module_name');
                if (moduleName && contains(moduleName, node)) return skip('module-path');
                if (parent.namedChildCount > 1) return { role: 'unknown', why: 'dotted-import-name' };
                const aliased = parent.parent?.type === 'aliased_import';
                return { role: 'import', moduleText: moduleName ? moduleName.text : '', aliased };
            }
            if (ancestor(node, new Set(['import_statement']))) return skip('module-path');
            return { role: 'value' };
        }
        case 'aliased_import':
            if (field === 'alias') {
                // `from m import X as X` explicitly re-exports X. Both
                // spellings follow the declaration; a distinct local alias
                // remains the caller's binding.
                const from = parent.parent;
                if (from?.type === 'import_from_statement' &&
                    parent.childForFieldName('name')?.text === node.text) {
                    return { role: 'import', moduleText: from.childForFieldName('module_name')?.text || '' };
                }
                return skip('import-alias');
            }
            break;
        case 'as_pattern_target': case 'named_expression':
            if (parent.type === 'as_pattern_target' || field === 'name') return skip('variable', { binding: true });
            break;
        default:
            break;
    }
    if (isPythonAssignmentTarget(node)) return skip('assignment', { binding: true });
    if (node.type === 'identifier') return { role: 'value' };
    return { role: 'unknown', why: `python:${parent.type}` };
}

function isPythonAssignmentTarget(node) {
    let current = node;
    for (let parent = node.parent; parent; current = parent, parent = parent.parent) {
        if (parent.type === 'pattern_list' || parent.type === 'tuple_pattern' ||
            parent.type === 'list_pattern' || parent.type === 'list_splat_pattern') continue;
        if ((parent.type === 'assignment' || parent.type === 'augmented_assignment' ||
            parent.type === 'for_statement' || parent.type === 'for_in_clause') &&
            isField(current, 'left')) return true;
        return false;
    }
    return false;
}

function classifyGo(node) {
    const parent = node.parent;
    const field = fieldOf(node);
    switch (parent.type) {
        case 'type_spec': case 'type_alias':
            if (field === 'name') return { role: 'decl', declNode: parent };
            break;
        case 'qualified_type':
            if (field === 'name') {
                // In an expression the grammar reads the index of `x[a.b]`
                // as a type argument `a.b` (fix #431): a selector on a value
                // `a` unless `a` names an imported package.
                return { role: 'type', qualifier: parent.childForFieldName('package'),
                    ...(require('../languages/lexical-scope').goExpressionTypeArgument(parent) && { selectorOperand: true }) };
            }
            return skip('package');
        case 'field_declaration':
            if (node.type === 'field_identifier') return skip('field-name');
            if (field === 'type' && !parent.childForFieldName('name')) return { role: 'type', embedded: true };
            break;
        case 'selector_expression':
            if (field === 'field') return { role: 'member', receiver: parent.childForFieldName('operand') };
            return { role: 'value' };
        case 'method_declaration': case 'method_elem': case 'method_spec':
            if (field === 'name') return skip('method-name');
            break;
        case 'function_declaration':
            if (field === 'name') return skip('function', { binding: true });
            break;
        case 'parameter_declaration': case 'variadic_parameter_declaration':
            if (field === 'name') return skip('parameter', { binding: true });
            break;
        case 'var_spec': case 'const_spec':
            if (field === 'name') return skip('variable', { binding: true });
            break;
        case 'type_parameter_declaration':
            if (field === 'name') return skip('type-parameter', { typeParam: true });
            break;
        case 'literal_element': {
            const keyed = parent.parent;
            if (keyed?.type === 'keyed_element' && sameNode(keyed.namedChild(0), parent)) {
                return { role: 'gofield', keyed: true };
            }
            break;
        }
        case 'labeled_statement': case 'break_statement': case 'continue_statement': case 'goto_statement':
            return skip('label');
        default:
            break;
    }
    if (node.type === 'identifier' && parent.type === 'expression_list') {
        const statement = parent.parent;
        if ((statement?.type === 'short_var_declaration' || statement?.type === 'range_clause') &&
            isField(parent, 'left')) return skip('variable', { binding: true });
    }
    if (node.type === 'type_identifier') return { role: 'type' };
    if (node.type === 'identifier') return { role: 'value' };
    if (node.type === 'field_identifier') return skip('field-name');
    if (node.type === 'package_identifier') return skip('package');
    if (node.type === 'label_name') return skip('label');
    return { role: 'unknown', why: `go:${parent.type}` };
}

const RUST_TYPE_DECLS = new Set(['struct_item', 'enum_item', 'union_item', 'trait_item', 'type_item']);

function classifyRust(node) {
    const parent = node.parent;
    const field = fieldOf(node);
    if (RUST_TYPE_DECLS.has(parent.type) && field === 'name') return { role: 'decl', declNode: parent };
    if (ancestor(node, new Set(['macro_definition']))) return { role: 'template' };
    if (parent.type === 'token_tree' || ancestor(node, new Set(['token_tree']), new Set(['macro_invocation', 'source_file']))) {
        if (ancestor(node, new Set(['attribute_item', 'inner_attribute_item']))) return { role: 'unknown', why: 'attribute-token' };
        return { role: 'macro' };
    }
    const inUse = !!ancestor(node, new Set(['use_declaration']));
    switch (parent.type) {
        case 'scoped_type_identifier':
            if (field === 'name') return { role: 'type', qualifier: parent.childForFieldName('path') };
            break;
        case 'scoped_identifier': {
            if (field === 'name') {
                const qualifier = parent.childForFieldName('path');
                return inUse ? { role: 'import', qualifier } : { role: 'value', qualifier };
            }
            return inUse ? { role: 'import', useHead: true } : { role: 'value' };
        }
        case 'use_as_clause': {
            if (field === 'alias') {
                const path = parent.childForFieldName('path');
                const original = path?.type === 'scoped_identifier' ? path.childForFieldName('name') : path;
                return original?.text === node.text ? { role: 'import', original } : skip('import-alias');
            }
            return { role: 'import' };
        }
        case 'use_list': {
            const scoped = parent.parent?.type === 'scoped_use_list' ? parent.parent : null;
            return { role: 'import', qualifier: scoped?.childForFieldName('path') || null, inList: true };
        }
        case 'use_declaration':
            return { role: 'import' };
        case 'function_item': case 'function_signature_item':
            if (field === 'name') return skip('function', { binding: true });
            break;
        case 'field_expression':
            if (field === 'field') return skip('member');
            break;
        case 'field_declaration': case 'field_initializer': case 'shorthand_field_initializer':
        case 'field_pattern':
            if (node.type === 'field_identifier' || node.type === 'shorthand_field_identifier') return skip('field-name');
            break;
        case 'enum_variant':
            if (field === 'name') return skip('variant');
            break;
        case 'type_parameters': case 'constrained_type_parameter': case 'type_parameter':
            if (node.type === 'type_identifier' && (parent.type !== 'constrained_type_parameter' || field === 'left')) {
                return skip('type-parameter', { typeParam: true });
            }
            break;
        case 'macro_invocation':
            if (field === 'macro') return skip('macro-name');
            break;
        case 'const_item': case 'static_item':
            if (field === 'name') return skip('constant', { binding: true });
            break;
        case 'const_parameter':
            if (field === 'name') return skip('parameter', { binding: true, genericParameter: true });
            break;
        case 'mod_item':
            return skip('module-name');
        case 'label': case 'loop_label': case 'lifetime':
            return skip('label');
        default:
            break;
    }
    if (node.type === 'identifier' && isRustPatternBinding(node)) return skip('pattern', { binding: true, patternBinding: true });
    if (node.type === 'type_identifier') return { role: 'type' };
    if (node.type === 'identifier') return { role: 'value' };
    if (node.type === 'field_identifier' || node.type === 'shorthand_field_identifier') return skip('field-name');
    return { role: 'unknown', why: `rust:${parent.type}` };
}

const RUST_PATTERN_OWNERS = new Set(['let_declaration', 'parameter', 'closure_parameters',
    'for_expression', 'match_arm', 'let_condition', 'if_let_expression', 'while_let_expression']);
const RUST_PATTERN_NODES = new Set(['tuple_pattern', 'tuple_struct_pattern', 'struct_pattern',
    'field_pattern', 'ref_pattern', 'mut_pattern', 'captured_pattern', 'slice_pattern', 'or_pattern',
    'reference_pattern', 'match_pattern', 'remaining_field_pattern']);

function isRustPatternBinding(node) {
    let current = node;
    for (let parent = node.parent; parent; current = parent, parent = parent.parent) {
        if (RUST_PATTERN_NODES.has(parent.type)) {
            // The path of a tuple-struct pattern names a type, not a binding.
            if ((parent.type === 'tuple_struct_pattern' || parent.type === 'struct_pattern') &&
                isField(current, 'type')) return false;
            continue;
        }
        if (parent.type === 'closure_parameters') return true;
        if (RUST_PATTERN_OWNERS.has(parent.type)) return isField(current, 'pattern') || parent.type === 'match_arm';
        return false;
    }
    return false;
}

const C_TYPE_SPECIFIERS = new Set(['class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier']);

function classifyC(node, language) {
    const parent = node.parent;
    const field = fieldOf(node);
    if (C_TYPE_SPECIFIERS.has(parent.type) && field === 'name') {
        return parent.childForFieldName('body')
            ? { role: 'decl', declNode: parent, tag: parent.type }
            : { role: 'type', tag: parent.type, elaborated: true };
    }
    switch (parent.type) {
        case 'qualified_identifier': {
            const scope = parent.childForFieldName('scope');
            if (field === 'name') {
                let qualified = parent;
                while (qualified.parent?.type === 'qualified_identifier' && isField(qualified, 'name')) {
                    qualified = qualified.parent;
                }
                const declarator = qualified.parent?.type === 'function_declarator' &&
                    isField(qualified, 'declarator') ? qualified.parent : null;
                let declaration = declarator;
                while (declaration?.parent && (isField(declaration, 'declarator') ||
                    ['reference_declarator', 'parenthesized_declarator', 'attributed_declarator'].includes(declaration.parent.type))) {
                    declaration = declaration.parent;
                }
                if (declarator && !declaration.childForFieldName('type') && scope) {
                    return { role: 'ctor-qualified', qualifier: scope, qualifiedNode: parent };
                }
                return { role: 'type', cppQualified: true };
            }
            // A qualifier segment names a namespace or a class.
            return { role: 'type', qualifierSegment: true, qualifiedNode: parent };
        }
        case 'destructor_name': {
            const qualified = parent.parent?.type === 'qualified_identifier' ? parent.parent : null;
            if (qualified) return { role: 'ctor-qualified', qualifier: qualified.childForFieldName('scope'), qualifiedNode: qualified };
            // `obj.~Widget()` / `p->~Widget()`: an explicit destructor call
            // names a type looked up at the call site, not the enclosing
            // class.
            if (parent.parent?.type === 'field_expression') return { role: 'type' };
            return { role: 'ctor', classNode: ancestor(node, C_TYPE_SPECIFIERS) };
        }
        case 'function_declarator': {
            if (field !== 'declarator') break;
            // `typedef int F(void *data);` names a function type (fix #427).
            if (parent.parent?.type === 'type_definition' && isField(parent, 'declarator')) {
                return { role: 'decl', declNode: parent.parent, typedef: true };
            }
            const classNode = ancestor(node, C_TYPE_SPECIFIERS, new Set(['compound_statement']));
            const body = classNode?.childForFieldName('body');
            // `struct List<K>::Node { Node(..) }` names its class by the
            // qualified name's last segment (fix #396).
            let className = classNode?.childForFieldName('name');
            while (className && (className.type === 'qualified_identifier' || className.type === 'template_type')) {
                className = className.childForFieldName('name') || className.namedChild(0);
            }
            const classBase = className?.text;
            if (classNode && body && contains(body, node) && classBase === node.text) {
                return { role: 'ctor', classNode };
            }
            // A deduction guide's name is the class template's (fix #427).
            if (language === 'cpp' && require('../languages/c-family').deductionGuideOf(parent.parent)) {
                return { role: 'type' };
            }
            return skip('function', { binding: true });
        }
        case 'field_initializer':
            if (sameNode(parent.namedChild(0), node)) return { role: 'meminit' };
            break;
        case 'template_type':
            if (field === 'name') return { role: 'type', cppQualified: true };
            break;
        case 'template_function': case 'template_method':
            if (field === 'name') return { role: 'value', cppQualified: true };
            break;
        case 'type_definition':
            if (field === 'declarator') return { role: 'decl', declNode: parent, typedef: true };
            break;
        case 'alias_declaration':
            if (field === 'name') return { role: 'decl', declNode: parent, typedef: true };
            break;
        case 'namespace_definition':
            return skip('namespace-name');
        case 'field_expression':
            if (field === 'field') return skip('member');
            break;
        case 'field_declaration':
            if (node.type === 'field_identifier') return skip('field-name');
            break;
        case 'enumerator':
            if (field === 'name') return skip('enumerator');
            break;
        case 'type_parameter_declaration': case 'optional_type_parameter_declaration':
        case 'variadic_type_parameter_declaration':
            // `template <typename T = Widget>`: the default is a reference.
            if (field === 'default_type') return { role: 'type' };
            return skip('type-parameter', { typeParam: true });
        case 'preproc_def': case 'preproc_function_def': case 'preproc_params':
            return skip('macro-name');
        case 'structured_binding_declarator':
            // `auto [a, b] = p;` declares each name (fix #420).
            if (node.type === 'identifier') return skip('variable', { binding: true });
            break;
        case 'reference_declarator':
            // The C++ grammar gives the referenced declarator no field name.
            if (sameNode(parent.namedChild(0), node)) {
                if (node.type === 'identifier') return skip('variable', { binding: true });
                if (node.type === 'field_identifier') return skip('field-name');
            }
            break;
        case 'init_declarator': case 'parameter_declaration': case 'optional_parameter_declaration':
        case 'pointer_declarator': case 'array_declarator':
        case 'declaration':
            if (['identifier', 'field_identifier'].includes(node.type) && field === 'declarator') {
                return skip('variable', { binding: true });
            }
            break;
        case 'labeled_statement': case 'goto_statement':
            return skip('label');
        default:
            break;
    }
    if (node.type === 'type_identifier') return { role: 'type' };
    if (node.type === 'namespace_identifier') return { role: 'type', qualifierSegment: true };
    if (node.type === 'identifier') return { role: 'value' };
    if (node.type === 'field_identifier') return skip('member');
    if (node.type === 'statement_identifier') return skip('label');
    return { role: 'unknown', why: `${language}:${parent.type}` };
}

function classify(node, language) {
    if (node.parent?.type === 'ERROR' || node.parent?.type === 'MISSING') {
        return { role: 'unknown', why: 'parse-error' };
    }
    switch (familyOf(language)) {
        case 'java': return classifyJava(node);
        case 'csharp': return classifyCSharp(node);
        case 'js': return classifyJs(node);
        case 'python': return classifyPython(node);
        case 'go': return classifyGo(node);
        case 'rust': return classifyRust(node);
        case 'c': return classifyC(node, language);
        default: return { role: 'unknown', why: `language:${language}` };
    }
}

// ── Scopes (bindings and type parameters that shadow the name) ───────────

const FUNCTION_SCOPES = {
    js: new Set(['function_declaration', 'function_expression', 'function', 'arrow_function',
        'method_definition', 'generator_function', 'generator_function_declaration', 'program']),
    python: new Set(['function_definition', 'lambda', 'module', 'list_comprehension',
        'set_comprehension', 'dictionary_comprehension', 'generator_expression']),
    go: new Set(['function_declaration', 'method_declaration', 'func_literal', 'source_file']),
    rust: new Set(['function_item', 'closure_expression', 'source_file']),
    java: new Set(['method_declaration', 'constructor_declaration', 'lambda_expression', 'program']),
    csharp: new Set(['method_declaration', 'constructor_declaration', 'local_function_statement',
        'lambda_expression', 'anonymous_method_expression', 'compilation_unit']),
    c: new Set(['function_definition', 'lambda_expression', 'translation_unit']),
};
const BLOCK_SCOPES = {
    js: new Set(['statement_block', 'for_statement', 'for_in_statement', 'catch_clause', 'class_body']),
    python: new Set(['class_definition']),
    go: new Set(['block', 'for_statement', 'if_statement', 'switch_statement', 'type_switch_statement',
        'select_statement', 'communication_case', 'expression_case', 'type_case', 'default_case']),
    rust: new Set(['block', 'match_arm', 'for_expression', 'if_expression', 'while_expression']),
    java: new Set(['block', 'for_statement', 'enhanced_for_statement', 'catch_clause', 'class_body',
        'switch_block_statement_group', 'try_with_resources_statement']),
    csharp: new Set(['block', 'for_statement', 'foreach_statement', 'catch_clause', 'declaration_list',
        'switch_section', 'using_statement']),
    c: new Set(['compound_statement', 'for_statement', 'for_range_loop', 'field_declaration_list',
        'catch_clause', 'if_statement', 'while_statement']),
};
const TYPE_PARAM_OWNERS = new Set(['class_declaration', 'interface_declaration', 'method_declaration',
    'constructor_declaration', 'record_declaration', 'function_declaration', 'type_alias_declaration',
    'function_item', 'struct_item', 'enum_item', 'trait_item', 'impl_item', 'type_item', 'union_item',
    'type_spec', 'template_declaration', 'struct_declaration', 'delegate_declaration',
    'local_function_statement', 'method_definition', 'method_signature', 'function_signature',
    'class', 'abstract_class_declaration', 'arrow_function', 'function_expression',
    'generic_function', 'call_signature', 'construct_signature', 'function_type']);

function bindingScope(node, family, token) {
    const functions = FUNCTION_SCOPES[family] || new Set();
    const blocks = BLOCK_SCOPES[family] || new Set();
    // JS `var` and function declarations are function-scoped; everything
    // else (let/const/class, catch, parameters via their function) is
    // block-scoped. Python binds per function (class bodies bind for the
    // class body only).
    const functionScoped = family === 'python' || (family === 'js' &&
        (ancestor(node, new Set(['variable_declaration']), new Set(['statement_block', 'program'])) ||
            token.why === 'function'));
    for (let current = node.parent; current; current = current.parent) {
        if (functions.has(current.type)) return current;
        if (!functionScoped && blocks.has(current.type)) return current;
        if (family === 'python' && current.type === 'class_definition') return current;
    }
    return null;
}

function typeParamScope(node) {
    for (let current = node.parent; current; current = current.parent) {
        if (TYPE_PARAM_OWNERS.has(current.type)) return current;
    }
    return null;
}

// ── Identity of the pinned type ──────────────────────────────────────────

function pinGroupOf(index, def, name) {
    // Several construction witnesses may ask about the same type. Share
    // the pure grouping calculation and all its reads, but give each
    // resolver its own collections: value resolvers extend these groups.
    const key = JSON.stringify(['type-pin-group', name, def]);
    const saved = sharedRead(index, key, view => pinGroupFacts(view, def, name));
    return { ...saved, group: new Set([def, ...saved.group]), all: [...saved.all] };
}

function pinGroupFacts(index, def, name) {
    const language = index.files.get(def.file)?.language;
    const family = familyOf(language);
    // Different pins of one name inspect the same declarations. Their
    // definition identities depend on the index, not on the selected pin.
    const candidates = sharedRead(index, JSON.stringify(['type-pin-candidates', name, family]), view =>
        (view.symbols.get(name) || []).filter(d => TYPE_DECL_KINDS.has(d.type) &&
            familyOf(view.files.get(d.file)?.language) === family)
            .map(d => ({ def: d, key: classKeyOf(view, d) })));
    const all = candidates.map(candidate => candidate.def);
    const pinKey = classKeyOf(index, def);
    const group = new Set();
    let crossConfig = null;
    for (const candidate of candidates) {
        const other = candidate.def;
        if (candidate.key === pinKey) {
            group.add(other);
            continue;
        }
        if (family === 'rust' && other.file === def.file && other.type === def.type &&
            other.lexicalScopeStartLine == null && def.lexicalScopeStartLine == null &&
            rustModulePath(index, other) === rustModulePath(index, def)) {
            group.add(other); // `#[cfg]` alternatives of one module path
            continue;
        }
        if (family === 'go' && path.dirname(other.file) === path.dirname(def.file) &&
            index.files.get(other.file)?.packageName === index.files.get(def.file)?.packageName &&
            !other.lexicalScopeStartLine && !def.lexicalScopeStartLine && other.type === def.type) {
            group.add(other); // build-constrained variants of one package type
            continue;
        }
        if (family === 'c' && other.file !== def.file &&
            (other.type === def.type || (CLASS_KEYWORD_KINDS.has(other.type) && CLASS_KEYWORD_KINDS.has(def.type))) &&
            effectiveNs(index, other) === effectiveNs(index, def) &&
            (other.enclosingType || '') === (def.enclosingType || '') && !other.lexicalScopeStartLine) {
            // One namespace-scope class name is one entity in a program: its
            // forward declarations and its definition in headers (and the
            // headers a translation unit includes) are the same class; a
            // same-name class local to another source file is not.
            if (isHeader(def.file) && isHeader(other.file)) {
                group.add(other);
                continue;
            }
            const { includeClosure } = lazyCppScopeModule();
            if (includeClosure(index, def.file).has(other.file) || includeClosure(index, other.file).has(def.file)) {
                group.add(other);
                continue;
            }
            if (!crossConfig) crossConfig = require('./callers')._configurationAlternativeFiles;
            if (crossConfig(index, def.file, other.file)) group.add(other);
        }
    }
    return { group: [...group], all, family, language };
}

const CLASS_KEYWORD_KINDS = new Set(['class', 'struct']);
const SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.c++', '.m', '.mm', '.cu']);

function isHeader(file) {
    return !SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function effectiveNs(index, d) {
    const { effectiveNamespace } = lazyCppScopeModule();
    return effectiveNamespace(index, d) || '';
}

function rustModulePath(index, d) {
    const { rustInlineModules, rustInlineChainAt } = require('./imports');
    return rustInlineChainAt(rustInlineModules(index.files.get(d.file) || {}), d.startLine).join('::');
}

// ── Resolution ───────────────────────────────────────────────────────────

// Whether a word occurrence of `name` in Rust source is followed, past
// whitespace and comments, by `!`: what an invocation's path needs before
// its token tree in a source that parses without error.
function spelledBeforeBang(source, name) {
    // ASCII word characters only: anything else around the name (Unicode
    // identifiers, Unicode whitespace) keeps the file.
    const word = c => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
    for (let at = source.indexOf(name); at >= 0; at = source.indexOf(name, at + 1)) {
        if (at > 0 && word(source.charCodeAt(at - 1)) || word(source.charCodeAt(at + name.length))) continue;
        let i = at + name.length;
        for (;;) {
            const c = source.charCodeAt(i);
            if (c > 127) return true;
            if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) { i++; continue; }
            if (c === 47 && source.charCodeAt(i + 1) === 47) {
                const end = source.indexOf('\n', i);
                if (end < 0) { i = source.length; break; }
                i = end + 1;
                continue;
            }
            if (c === 47 && source.charCodeAt(i + 1) === 42) {
                let depth = 1;
                i += 2;
                while (i < source.length && depth > 0) {
                    if (source.charCodeAt(i) === 47 && source.charCodeAt(i + 1) === 42) { depth++; i += 2; }
                    else if (source.charCodeAt(i) === 42 && source.charCodeAt(i + 1) === 47) { depth--; i += 2; }
                    else i++;
                }
                continue;
            }
            break;
        }
        if (source.charCodeAt(i) === 33) return true;
    }
    return false;
}

// The innermost class around a line by the index's declarations.
function enclosingClassIn(index, file, line) {
    const entry = index.files.get(file);
    let best = null;
    for (const s of entry?.symbols || []) {
        if (s.startLine > line || s.endLine < line) continue;
        const isClass = TYPE_DECL_KINDS.has(s.type) && s.type !== 'type';
        const candidate = isClass ? s.name : (s.className || null);
        if (!candidate) continue;
        if (!best || (s.endLine - s.startLine) < (best.span)) {
            best = { name: candidate, span: s.endLine - s.startLine };
        }
    }
    return best?.name || null;
}

// The namespace and class a C/C++ site's lookup starts in: from the site's
// own tree node when it has one (no pinned type takes part).
function cppSiteContextOf(index, siteNode, siteFile, file, line) {
    const node = siteNode && siteFile === file && siteNode.startPosition.row + 1 === line
        ? siteNode : null;
    const { macroNamespacePrefixAt, namespaceAt } = lazyCppScopeModule();
    if (!node) return { namespace: namespaceAt(index, file, line), className: enclosingClassIn(index, file, line) };
    const namespaces = [];
    const classes = [];
    let memberOf = null;
    let recovered = false;
    for (let current = node.parent; current; current = current.parent) {
        if (current.type === 'ERROR') recovered = true;
        if (current.type === 'namespace_definition') {
            const nameNode = current.childForFieldName('name');
            if (nameNode) namespaces.unshift(textOf(nameNode));
        } else if (C_TYPE_SPECIFIERS.has(current.type)) {
            const body = current.childForFieldName('body');
            const nameNode = current.childForFieldName('name');
            if (body && contains(body, node) && nameNode) {
                // Specializations keep their arguments (`Acc<double>`), as
                // the index names them; an out-of-class nested definition
                // (`struct List<K>::Node`) is in its owner's scope too
                // (fix #396).
                const segments = textOf(nameNode).split('::');
                classes.unshift(segments.slice(-2).join('::'));
            }
        } else if (current.type === 'function_definition' && !memberOf && classes.length === 0) {
            let declarator = current.childForFieldName('declarator');
            while (declarator && declarator.type !== 'function_declarator' && declarator.childForFieldName?.('declarator')) {
                declarator = declarator.childForFieldName('declarator');
            }
            const qualified = declarator?.childForFieldName?.('declarator');
            if (qualified?.type === 'qualified_identifier') {
                const scope = qualified.childForFieldName('scope');
                // `List<K>::Node::f`: Node's scope, then List's (fix #396).
                if (scope) memberOf = qualifiedScopeText(qualified) || textOf(scope).split('::').pop();
            }
        }
    }
    // A class body the raw tree lost (macro-heavy headers, conditional
    // members): the indexed nested classes around the line (parsed from
    // the recovered source) still name their owners (fix #396: `union
    // Data` inside `GenericValue`).
    if (classes.length > 0) {
        const symbols = index.files.get(file)?.symbols || [];
        const around = name => symbols.find(s => s.name === name && TYPE_DECL_KINDS.has(s.type) &&
            s.startLine <= line && line <= s.endLine);
        for (let owner = around(classes[0].split('::').pop())?.enclosingType, depth = 0;
            owner && depth < 8 && !classes.includes(owner); depth++) {
            classes.unshift(owner);
            owner = around(owner)?.enclosingType;
        }
    }
    const prefix = macroNamespacePrefixAt(index, file, line);
    const own = namespaces.join('::');
    let namespace = prefix && own ? `${prefix}::${own}` : prefix || own;
    let className = classes.length > 0 ? classes.join('::') : memberOf;
    // Macro-heavy code can break the raw tree so that an enclosing
    // namespace block closes early; the indexed declarations around the
    // line (parsed from the recovered source) still carry it.
    const indexed = namespaceAt(index, file, line);
    if (indexed && indexed !== namespace && (namespace === '' || own === '' ||
        indexed.endsWith(`::${own}`) || indexed.startsWith(`${namespace}::`) ||
        (recovered && indexed.startsWith(namespace)))) namespace = indexed;
    // Out-of-line member bodies: the index (parsed from the recovered
    // source) knows their class even when a macro before the return type
    // broke the literal head; the head's own qualifier is the fallback.
    if (classes.length === 0) className = enclosingClassIn(index, file, line) || memberOf;
    return { namespace, className };
}

class TypeReferenceResolver {
    constructor(index, def, name) {
        this.index = index;
        this.def = def;
        this.name = name;
        const { group, all, family, language } = pinGroupOf(index, def, name);
        this.group = group;
        this.all = all;
        this.family = family;
        this.language = language;
        this.declarationKinds = TYPE_DECL_KINDS;
        this.pinFiles = new Set([...group].map(d => d.file));
        this.memo = new Map();
        this._embedders = undefined;
    }

    inGroup(d) { return this.group.has(d); }

    /**
     * The Python function scope the pinned class statement binds its name
     * in (fix #424), when that scope binds the name by other statements
     * too: one variable, renamed whole (its other bindings are the plan's
     * alternative bindings), so a reference resolving to that scope names
     * the pin's variable. Null for module and class-body scopes, which the
     * module lookup and class-body order decide.
     */
    pythonPinScope(tree) {
        if (this.family !== 'python' || !tree) return null;
        if (this._pythonPinScope && this._pythonPinScope.tree === tree) return this._pythonPinScope.scope;
        let scope = null;
        const row = (this.def.nameLine || this.def.startLine) - 1;
        const stack = [tree.rootNode];
        let classNode = null;
        while (stack.length > 0 && !classNode) {
            const node = stack.pop();
            if (node.startPosition.row > row || node.endPosition.row < row) continue;
            if (node.type === 'class_definition' && node.childForFieldName('name')?.text === this.name &&
                node.childForFieldName('name').startPosition.row === row) {
                classNode = node;
                break;
            }
            for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push(node.namedChild(i));
        }
        const owner = classNode && bindingScope(classNode, 'python', {});
        if (owner?.type === 'function_definition') {
            const { pythonScopeBindingKinds } = require('../languages/lexical-scope');
            const sites = pythonScopeBindingKinds(classNode.parent, this.name);
            if (sites.some(site => !sameNode(site.node, classNode.childForFieldName('name')))) scope = owner;
        }
        this._pythonPinScope = { tree, scope };
        return scope;
    }

    /**
     * Generic arity written at the token being decided, where arity is part
     * of a type's identity (trait genericArityIsIdentity, fix #389): `X` is
     * 0, `X<int>` 1, the open generic `X<>` 1 and `X<,>` 2. null when the
     * site is not an identifier token (doc comments).
     */
    siteArity() {
        if (this.siteSyntax && Number.isInteger(this.siteSyntax.arity)) return this.siteSyntax.arity;
        const node = this.siteNode;
        if (!node || node.type !== 'identifier' || !langTraits(this.language)?.genericArityIsIdentity) return null;
        const parent = node.parent;
        if (CSHARP_TYPE_DECLS.has(parent?.type) && sameNode(parent.childForFieldName('name'), node)) {
            const list = parent.namedChildren.find(child => child.type === 'type_parameter_list');
            return list ? list.namedChildren.filter(child => child.type === 'type_parameter').length : 0;
        }
        // A constructor or finalizer is named after its class without type
        // arguments (fix #390: `Strategy(..)` inside `class Strategy<T>`):
        // its arity is the enclosing declaration's.
        if ((parent?.type === 'constructor_declaration' || parent?.type === 'destructor_declaration') &&
            parent.childForFieldName('name') && sameNode(parent.childForFieldName('name'), node)) {
            let owner = parent.parent;
            while (owner && owner.type === 'declaration_list') owner = owner.parent;
            const list = owner?.namedChildren?.find(child => child.type === 'type_parameter_list');
            return list ? list.namedChildren.filter(child => child.type === 'type_parameter').length : 0;
        }
        if (parent?.type !== 'generic_name' || !sameNode(parent.namedChild(0), node)) return 0;
        const list = parent.namedChildren.find(child => child.type === 'type_argument_list');
        if (!list) return 0;
        const args = list.namedChildren.filter(child => !child.type.includes('comment'));
        if (args.length > 0) return args.length;
        return list.children.filter(child => child.type === ',').length + 1;
    }

    /** Verdict over a set of declarations the lookup found. */
    judge(defs, reason) {
        const arity = this.siteArity();
        if (arity != null) defs = defs.filter(d => (d.typeArity || 0) === arity);
        if (defs.length === 0) return { verdict: 'no', reason: reason || 'other-type' };
        const inside = defs.filter(d => this.inGroup(d));
        if (inside.length === defs.length) return { verdict: 'yes' };
        if (inside.length === 0) return { verdict: 'no', reason: reason || 'other-type' };
        return { verdict: 'unknown', reason: 'ambiguous-type' };
    }

    /** Type-like definitions of NAME declared in `file`. */
    fileTypes(file, name = this.name) {
        return (this.index.symbols.get(name) || []).filter(d => d.file === file &&
            this.declarationKinds.has(d.type));
    }

    /** Container range of a definition inside its own file (innermost
     * enclosing symbol), or null at file scope. */
    containerOf(d) {
        if (!this._containers) this._containers = new Map();
        if (this._containers.has(d)) return this._containers.get(d);
        const best = this._containerOf(d);
        this._containers.set(d, best);
        return best;
    }

    _containerOf(d) {
        const entry = this.index.files.get(d.file);
        let best = null;
        for (const s of entry?.symbols || []) {
            if (s === d || s.startLine == null || s.endLine == null) continue;
            if (s.sourceSpan && d.sourceSpan &&
                (s.sourceSpan.start > d.sourceSpan.start ||
                 s.sourceSpan.end < d.sourceSpan.end)) continue;
            if (s.startLine > d.startLine || s.endLine < d.endLine) continue;
            if (s.startLine === d.startLine && s.endLine === d.endLine) continue;
            if (s.type === 'impl' || s.type === 'field') continue;
            if (!best || (s.endLine - s.startLine) < (best.endLine - best.startLine)) best = s;
        }
        return best;
    }

    /** Same-file declarations of `name` visible at `line` (innermost). */
    visibleInFile(file, line, name = this.name) {
        const defs = this.fileTypes(file, name);
        if (defs.length === 0) return [];
        const entry = this.index.files.get(file);
        const scored = [];
        for (const d of defs) {
            if (d.lexicalScopeStartLine != null && d.lexicalScopeEndLine != null) {
                if (line < d.lexicalScopeStartLine || line > d.lexicalScopeEndLine) continue;
                scored.push({ d, span: d.lexicalScopeEndLine - d.lexicalScopeStartLine });
                continue;
            }
            const container = this.containerOf(d);
            if (!container) {
                scored.push({ d, span: Infinity });
                continue;
            }
            if (line < container.startLine || line > container.endLine) continue;
            if (this.family === 'python' && TYPE_DECL_KINDS.has(container.type)) {
                // A class body's names are not visible inside its methods.
                const inMethod = (entry?.symbols || []).some(s => (s.type === 'method' ||
                    s.type === 'function' || s.type === 'constructor') &&
                    s.startLine >= container.startLine && s.endLine <= container.endLine &&
                    s.startLine <= line && s.endLine >= line);
                if (inMethod) continue;
            }
            scored.push({ d, span: container.endLine - container.startLine });
        }
        if (scored.length === 0) return [];
        const best = Math.min(...scored.map(s => s.span));
        return scored.filter(s => s.span === best).map(s => s.d);
    }

    // ── Unqualified name lookup (after local shadowing) ──

    resolveName(file, line, name = this.name) {
        const site = (this.family === 'c' || this.family === 'csharp') && this.siteNode ? `\0${this.siteNode.startIndex}` : '';
        const key = `u\0${file}\0${line}\0${name}${site}`;
        if (this.memo.has(key)) return this.memo.get(key);
        let result;
        try {
            result = this._resolveName(file, line, name);
        } catch {
            result = { verdict: 'unknown', reason: 'resolution-error' };
        }
        this.memo.set(key, result);
        return result;
    }

    _resolveName(file, line, name) {
        const entry = this.index.files.get(file);
        if (!entry) return { verdict: 'unknown', reason: 'unindexed-file' };
        if (this.family === 'c') return this.resolveCFamily(file, line, name, null);
        if (this.family === 'rust') return this.resolveRustName(file, line, name);
        // A C# compilation unit can hold several namespace bodies. A type
        // declared somewhere in the file is not automatically in scope.
        const local = this.family === 'csharp' ? [] : this.visibleInFile(file, line, name);
        if (local.length > 0) {
            // A module-scope assignment of the name rebinds it, unless that
            // assignment is the type's own declaration (a type alias).
            const aliasDeclared = local.some(d => d.type === 'type' && this.inGroup(d));
            if (this.family === 'python' && !aliasDeclared && (entry.moduleAssignedNames || []).includes(name)) {
                return { verdict: 'unknown', reason: 'module-rebinding' };
            }
            return this.judge(local);
        }
        switch (this.family) {
            case 'js': return this.resolveJsName(file, line, name);
            case 'python': return this.resolvePythonName(file, line, name);
            case 'go': return this.resolveGoName(file, line, name);
            case 'java': return this.resolveJavaName(file, line, name);
            case 'csharp': return this.resolveCSharpName(file, line, name);
            default: return { verdict: 'unknown', reason: 'unsupported-language' };
        }
    }

    chase(startFile, name) {
        const { _nameBindingReaches } = require('./callers');
        const reach = _nameBindingReaches(this.index, startFile, name, this.pinFiles, 8,
            { exactName: true, configurationVerdict: true });
        // A module binding the name through one alternative of a
        // configuration item keeps the item's name (fix #424, the #398F
        // import rule): its importers' and attribute readers' tokens name
        // the item, never the renamed pin.
        // Value dependencies still reach the chosen alternative at runtime.
        // Its importers keep the chooser's name, so they are review sites,
        // never automatic edits of one alternative's declaration.
        return reach === 'configuration' ? (this.valueReferences ? 'unknown' : 'no') : reach;
    }

    moduleFile(entry, module) {
        const rel = entry.moduleResolved?.[module];
        if (!rel) return null;
        return path.isAbsolute(rel) ? rel : path.join(this.index.root, rel);
    }

    combine(verdicts) {
        if (verdicts.length === 0) return { verdict: 'no', reason: 'not-in-scope' };
        if (verdicts.every(v => v.verdict === 'yes')) return { verdict: 'yes' };
        if (verdicts.every(v => v.verdict === 'no')) return verdicts[0];
        const unknown = verdicts.find(v => v.verdict === 'unknown');
        return { verdict: 'unknown', reason: unknown?.reason || 'ambiguous-binding' };
    }

    /** An import binding's verdict: its module binds the pin by name. */
    importBindingVerdict(file, entry, binding, name) {
        const original = binding.name;
        if (binding.alias && binding.alias !== original) return { verdict: 'no', reason: 'import-alias' };
        if (original !== name) return { verdict: 'no', reason: 'import-alias' };
        if (['default', 'namespace'].includes(binding.kind)) return { verdict: 'no', reason: 'import-alias' };
        const moduleFile = this.moduleFile(entry, binding.module);
        if (!moduleFile) {
            const { bindingIsExternal } = require('./type-denotation');
            const external = bindingIsExternal(this.index, entry, file, binding);
            return external === true ? { verdict: 'no', reason: 'external-import' }
                : { verdict: 'unknown', reason: 'unresolved-import' };
        }
        const reach = this.chase(moduleFile, name);
        return reach === 'yes' ? { verdict: 'yes' }
            : reach === 'no' ? { verdict: 'no', reason: 'other-module' }
                : { verdict: 'unknown', reason: 'import-chain' };
    }

    resolveJsName(file, line, name) {
        const entry = this.index.files.get(file);
        const bindings = (entry.importBindings || []).filter(b => (b.alias || b.name) === name &&
            b.module != null);
        if (bindings.length > 0) {
            return this.combine(bindings.map(b => this.importBindingVerdict(file, entry, b, name)));
        }
        // No binding: a global. Declarations in files without imports or
        // exports are scripts whose top level is shared.
        const isScript = fe => (fe.importBindings || []).length === 0 && (fe.exportDetails || []).length === 0;
        if ([...this.group].some(d => isScript(this.index.files.get(d.file) || {}))) {
            return { verdict: 'unknown', reason: 'global-script' };
        }
        return { verdict: 'no', reason: 'not-imported' };
    }

    /** Does an import or class statement of this Python module bind the
     * renamed type under its name (fix #393)? */
    pythonModuleBindsPin(file, line, name = this.name) {
        const key = `pm\0${file}\0${name}`;
        if (this.memo.has(key)) return this.memo.get(key);
        const entry = this.index.files.get(file);
        let result = this.fileTypes(file, name).some(d => this.inGroup(d));
        if (!result && entry) {
            const bindings = (entry.importBindings || []).filter(b => (b.alias || b.name) === name &&
                b.module != null && b.name !== '*' && b.kind !== 'import');
            result = bindings.some(b => this.importBindingVerdict(file, entry, b, name).verdict !== 'no');
        }
        this.memo.set(key, result);
        return result;
    }

    resolvePythonName(file, line, name) {
        const entry = this.index.files.get(file);
        const bindings = (entry.importBindings || []).filter(b => (b.alias || b.name) === name &&
            b.module != null && b.name !== '*');
        if ((entry.moduleAssignedNames || []).includes(name)) {
            return { verdict: 'unknown', reason: 'module-rebinding' };
        }
        if (bindings.length > 0) {
            return this.combine(bindings.map(b => {
                if (b.kind === 'import') return { verdict: 'no', reason: 'module-binding' };
                return this.importBindingVerdict(file, entry, b, name);
            }));
        }
        // Star imports (or anything else the name chase cannot model).
        const reach = this.chase(file, name);
        if (reach === 'yes') return { verdict: 'yes' };
        if (reach === 'unknown') return { verdict: 'unknown', reason: 'star-import' };
        return { verdict: 'no', reason: 'not-imported' };
    }

    goPackageKey(file) {
        const entry = this.index.files.get(file);
        return `${path.dirname(file)}\0${entry?.packageName || ''}`;
    }

    resolveGoName(file, line, name) {
        const key = this.goPackageKey(file);
        const packageTypes = this.all.filter(d => this.goPackageKey(d.file) === key &&
            d.lexicalScopeStartLine == null && d.name === name);
        if (packageTypes.length > 0) return this.judge(packageTypes);
        return this.resolveGoDotImports(file, name);
    }

    /**
     * A name the file's package does not declare, looked up in the file
     * block: `import . "p"` declares there every EXPORTED package-level
     * identifier of p (Go spec, Import declarations). Each dot-imported
     * project package is searched by its directory (its `_test` files are
     * never part of the imported package); an out-of-project package cannot
     * declare a project type; an import path the index could not resolve
     * that may still be a project package leaves the token undecided.
     */
    resolveGoDotImports(file, name) {
        const entry = this.index.files.get(file);
        const dots = (entry?.importDetails || []).filter(detail => detail.type === 'dot-import' && detail.module);
        if (dots.length === 0 || !/^\p{Lu}/u.test(name)) return { verdict: 'no', reason: 'other-package' };
        const { bindingIsExternal } = require('./type-denotation');
        const verdicts = [];
        for (const detail of dots) {
            const moduleFile = this.moduleFile(entry, detail.module);
            if (!moduleFile) {
                if (bindingIsExternal(this.index, entry, file, { module: detail.module }) !== true) {
                    verdicts.push({ verdict: 'unknown', reason: 'dot-import' });
                }
                continue;
            }
            const dir = path.dirname(moduleFile);
            const types = this.all.filter(d => path.dirname(d.file) === dir && d.lexicalScopeStartLine == null &&
                !d.file.endsWith('_test.go') &&
                !String(this.index.files.get(d.file)?.packageName || '').endsWith('_test'));
            if (types.length > 0) verdicts.push(this.judge(types, 'other-package'));
        }
        if (verdicts.length === 0) return { verdict: 'no', reason: 'other-package' };
        return this.combine(verdicts);
    }

    javaFqn(d) {
        const outer = d.enclosingType ? `${d.enclosingType}.` : '';
        return `${d.namespace ? d.namespace + '.' : ''}${outer}${d.name}`;
    }

    resolveJavaName(file, line, name) {
        const entry = this.index.files.get(file);
        const candidates = this.all.filter(d => d.name === name);
        const single = (entry.importBindings || []).filter(b => b.name === name && b.module &&
            b.kind !== 'static');
        if (single.length > 0) {
            const hits = candidates.filter(d => single.some(b => b.module === this.javaFqn(d)));
            if (hits.length > 0) return this.judge(hits);
            return { verdict: 'no', reason: 'imports-other-type' };
        }
        const sitePackage = javaPackageOf(entry, line);
        if (sitePackage === undefined) return { verdict: 'unknown', reason: 'unknown-package' };
        const samePackage = candidates.filter(d => !d.enclosingType && (d.namespace || '') === sitePackage);
        if (samePackage.length > 0) return this.judge(samePackage);
        const onDemand = (entry.importDetails || []).filter(detail => detail.module &&
            (detail.names || []).includes('*')).map(detail => String(detail.module).replace(/\.\*$/, ''));
        const viaDemand = candidates.filter(d => onDemand.some(module =>
            (!d.enclosingType && (d.namespace || '') === module) ||
            (d.enclosingType && `${d.namespace ? d.namespace + '.' : ''}${d.enclosingType}` === module)));
        if (viaDemand.length > 0) return this.judge(viaDemand);
        // A member type inherited from a supertype stays visible by simple
        // name in subclasses.
        if ([...this.group].some(d => d.enclosingType) && this.inheritsFromPinOwner(file)) {
            return { verdict: 'unknown', reason: 'inherited-member-type' };
        }
        return { verdict: 'no', reason: 'not-in-scope' };
    }

    /**
     * The namespace enclosing the token being decided (C#): its
     * `namespace` blocks and a file-scoped `namespace X;` read from the AST
     * (a file whose later declarations fail to parse still has them), else
     * the namespace of the indexed types around the line.
     */
    csharpSiteNamespace(file, line) {
        if (this.siteSyntax?.file === file && this.siteSyntax.line === line) {
            return this.siteSyntax.context.scopes.at(-1)?.namespace || '';
        }
        const node = this.siteNode && this.siteFile === file && this.siteNode.startPosition.row + 1 === line
            ? this.siteNode : null;
        if (node) return require('../languages/csharp-scope').usingScopesOf(node).at(-1)?.namespace || '';
        const { siteNamespaceOf } = require('./type-denotation');
        return siteNamespaceOf(this.index.files.get(file), line);
    }

    inheritsFromPinOwner(file) {
        const owners = new Set([...this.group].map(d => d.enclosingType).filter(Boolean));
        const entry = this.index.files.get(file);
        return (entry?.symbols || []).some(s => TYPE_DECL_KINDS.has(s.type) &&
            [s.extends, ...(s.implements || [])].filter(Boolean).some(parent =>
                owners.has(String(parent).replace(/<.*$/, '').split('.').pop())));
    }

    resolveCSharpName(file, line, name) {
        const entry = this.index.files.get(file);
        const { csharpUsings } = require('./type-denotation');
        const candidates = this.all.filter(d => d.name === name && !d.enclosingType);
        const site = this.csharpSiteNamespace(file, line);
        if (site === undefined) return { verdict: 'unknown', reason: 'unknown-namespace' };
        const localNested = this.visibleInFile(file, line, name).filter(d => d.enclosingType);
        if (localNested.length) return this.judge(localNested);
        // Member types of an enclosing class come first, declared in any
        // `partial` part of it (fix #395: `readonly DepthLimiter _d;` in one
        // part of `partial class PropertyValueConverter`, the nested class
        // in another file).
        const nestedNamed = this.all.filter(d => d.name === name && d.enclosingType && d.file !== file);
        if (nestedNamed.length > 0) {
            const around = (entry.symbols || []).filter(s => TYPE_DECL_KINDS.has(s.type) &&
                s.startLine <= line && s.endLine >= line)
                .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));
            for (const owner of around) {
                if (!(owner.modifiers || []).includes('partial')) continue;
                const members = nestedNamed.filter(d => d.enclosingType === owner.name &&
                    (d.namespace || '') === (owner.namespace || '') &&
                    (this.index.files.get(d.file)?.symbols || []).some(part => part.name === owner.name &&
                        TYPE_DECL_KINDS.has(part.type) && (part.modifiers || []).includes('partial') &&
                        (part.namespace || '') === (owner.namespace || '') &&
                        part.startLine <= d.startLine && part.endLine >= d.endLine));
                if (members.length > 0) return this.judge(members);
            }
        }
        const scope = csharpUsings(this.index, file, site, this.siteNode, this.siteSyntax?.context);
        const chain = [];
        for (let parts = site ? site.split('.') : []; parts.length > 0; parts = parts.slice(0, -1)) {
            chain.push(parts.join('.'));
        }
        chain.push('');
        for (const ns of chain) {
            const here = candidates.filter(d => (d.namespace || '') === ns);
            const alias = scope.aliases.has(name) && scope.aliasScopes?.get(name) === ns;
            if (alias && (here.length || scope.ambiguousAliases.has(name))) {
                return { verdict: 'unknown', reason: 'ambiguous-type' };
            }
            if (here.length > 0) return this.judge(here);
            if (alias) return { verdict: 'no', reason: 'using-alias' };
            // This namespace's imports are considered before its parent's
            // declarations; using-static directives can provide nested types.
            const usings = new Set([...scope.namespaces, ...scope.statics].filter(module =>
                scope.namespaceScopes.get(module)?.has(ns) || scope.staticScopes.get(module)?.has(ns)));
            const viaUsing = candidates.filter(d => usings.has(d.namespace || '') ||
                (d.enclosingType && usings.has(`${d.namespace ? d.namespace + '.' : ''}${d.enclosingType}`)));
            if (viaUsing.length > 0) return this.judge(viaUsing);
        }
        if ([...this.group].some(d => d.enclosingType) && this.inheritsFromPinOwner(file)) {
            return { verdict: 'unknown', reason: 'inherited-member-type' };
        }
        return { verdict: 'no', reason: 'not-in-scope' };
    }

    // ── Rust ──

    rustChainAt(file, line) {
        const { rustInlineModules, rustInlineChainAt } = require('./imports');
        const entry = this.index.files.get(file);
        const memoKey = `rinline\0${file}`;
        let inline = this.memo.get(memoKey);
        if (!inline) {
            inline = rustInlineModules(entry || {});
            this.memo.set(memoKey, inline);
        }
        return rustInlineChainAt(inline, line).join('::');
    }

    resolveRustName(file, line, name) {
        const entry = this.index.files.get(file);
        const { rustBindingsInScope } = require('./type-denotation');
        // Function-local items first (lexically scoped).
        const siteChain = this.rustChainAt(file, line);
        const local = this.fileTypes(file, name).filter(d => d.lexicalScopeStartLine != null &&
            line >= d.lexicalScopeStartLine && line <= d.lexicalScopeEndLine);
        if (local.length > 0) {
            const width = d => d.lexicalScopeEndLine - d.lexicalScopeStartLine;
            const narrowest = Math.min(...local.map(width));
            return this.judge(local.filter(d => width(d) === narrowest));
        }
        const bindings = rustBindingsInScope(entry, (entry.importBindings || []).filter(b =>
            (b.alias || b.name) === name && b.module && b.name !== '*'), line);
        const sameModule = this.fileTypes(file, name).filter(d => d.lexicalScopeStartLine == null &&
            this.rustChainAt(file, d.startLine) === siteChain);
        if (sameModule.length > 0 && bindings.length === 0) return this.judge(sameModule);
        if (bindings.length > 0) {
            // A module that declares the name and also imports it holds the
            // two under different `#[cfg]`s.
            return this.combine([...(sameModule.length > 0 ? [this.judge(sameModule)] : []), ...bindings.map(b => {
                if (b.alias && b.alias !== b.name) return { verdict: 'no', reason: 'import-alias' };
                const segments = String(b.module).split('::');
                const last = segments.pop();
                if (last !== name) return { verdict: 'no', reason: 'import-alias' };
                return this.resolveRustPath(file, b.line || line, this.rustUseQualifier(file, b.line || line, segments), name, 0);
            })]);
        }
        // Globs in scope (`use super::*`, `use crate::m::*`).
        const globs = (entry.importDetails || []).filter(detail => detail.type === 'use-glob' && detail.module);
        const visibleGlobs = rustBindingsInScope(entry, globs.map(g => ({ ...g, name: '*' })), line);
        const verdicts = visibleGlobs.map(glob => this.resolveRustPath(file, glob.line || line, glob.module, name, 0));
        const yes = verdicts.filter(v => v.verdict === 'yes');
        if (yes.length > 0 && yes.length === verdicts.filter(v => v.verdict !== 'no').length) return { verdict: 'yes' };
        if (verdicts.some(v => v.verdict !== 'no')) return { verdict: 'unknown', reason: 'glob-import' };
        // Nothing written binds the name here: it is a prelude name, or a
        // macro expansion in scope brought it in (a macro can expand to
        // `use` items, visible in its whole module).
        if (langTraits(entry.language)?.implicitPreludeNames?.has(name)) {
            return { verdict: 'no', reason: 'prelude' };
        }
        return { verdict: 'unknown', reason: 'macro-expanded-scope' };
    }

    resolveRustPath(file, line, qualifier, name, depth) {
        if (depth > MAX_QUALIFIER_HOPS) return { verdict: 'unknown', reason: 'path-depth' };
        const key = `rp\0${file}\0${this.rustChainAt(file, line)}\0${qualifier}\0${name}`;
        if (this.memo.has(key)) return this.memo.get(key);
        const result = this._resolveRustPath(file, line, qualifier, name, depth);
        this.memo.set(key, result);
        return result;
    }

    _resolveRustPath(file, line, qualifier, name, depth) {
        const entry = this.index.files.get(file);
        const { externalTypeDenotation, rustBindingsInScope } = require('./type-denotation');
        const { rustPathModule } = require('./rust-modules');
        if (!qualifier) return this.resolveRustName(file, line, name);
        // `::krate::..` names an extern crate, never a local module.
        const global = qualifier.startsWith('::');
        if (global) qualifier = qualifier.slice(2);
        const resolved = global ? null : rustPathModule(this.index, file, line, qualifier);
        if (resolved) return this.rustModuleVerdict(resolved, name, depth);
        // A qualifier whose first segment is a `use` binding (a module alias,
        // `use crate::widget;`, `use crate::widget::{self}`): rewrite it. A
        // binding whose own path starts with that segment (`use anyhow::
        // anyhow;` imports a macro) never names the module.
        const segments = qualifier.split('::');
        const head = segments[0];
        const bindings = global ? [] : rustBindingsInScope(entry, (entry.importBindings || []).filter(b =>
            (b.alias || b.name) === head && b.module && String(b.module).split('::')[0] !== head), line);
        if (bindings.length > 0) {
            return this.combine(bindings.map(b => this.resolveRustPath(file, b.line || line,
                [b.module, ...segments.slice(1)].join('::'), name, depth + 1)));
        }
        // A crate of this workspace named by its library name (integration
        // tests, examples and sibling crates use the package by name).
        const root = this.rustCrateRoots().get(head);
        if (root) {
            const inCrate = rustPathModule(this.index, root, 1, ['crate', ...segments.slice(1)].join('::'));
            if (inCrate) return this.rustModuleVerdict(inCrate, name, depth);
            return { verdict: 'unknown', reason: 'unresolved-path' };
        }
        if (externalTypeDenotation(this.index, file, name, qualifier, line)) {
            return { verdict: 'no', reason: 'external-type' };
        }
        // A qualifier naming a type (an associated item or enum variant).
        const typeHead = (this.index.symbols.get(segments[segments.length - 1]) || [])
            .some(d => TYPE_DECL_KINDS.has(d.type));
        if (typeHead) return { verdict: 'no', reason: 'associated-item' };
        return { verdict: 'unknown', reason: 'unresolved-path' };
    }

    /** Project invocation sites `{file, line}` of a Rust macro by name. */
    rustMacroInvocations(macroName) {
        const key = `rmacro\0${macroName}`;
        if (this.memo.has(key)) return this.memo.get(key);
        const { computeGroundSet } = require('./account');
        const ground = computeGroundSet(this.index, macroName);
        const sites = [];
        for (const [file, lineNumbers] of ground.perFile) {
            const entry = this.index.files.get(file);
            if (entry?.language !== 'rust') continue;
            let content;
            try { content = this.index._readFile(file); } catch { continue; }
            // A cleanly parsed file holds an invocation of the macro only
            // where its name token is followed by `!` (fix #435: every file
            // spelling a type-like macro name was parsed and walked).
            if (!entry.parseErrorRegions && indexedContent(this.index, file, entry, content) &&
                !spelledBeforeBang(content, macroName)) continue;
            const tree = this.index._getParsedTree?.(file, content, 'rust') || safeParse(getParser('rust'), content);
            if (!tree) continue;
            const rows = new Set(lineNumbers.map(n => n - 1));
            for (const current of tree.rootNode.descendantsOfType('macro_invocation')) {
                if (!rows.has(current.startPosition.row)) continue;
                const macro = current.childForFieldName('macro');
                if (macro && macro.text.split('::').pop() === macroName) {
                    sites.push({ file, line: current.startPosition.row + 1 });
                }
            }
        }
        this.memo.set(key, sites);
        return sites;
    }

    /**
     * The qualifier of a `use` binding's path. The parser records `use
     * ::krate::X` without its leading `::`; a `use` path whose first segment
     * names both a local module and a workspace crate would not compile
     * unqualified, so such a path names the crate.
     */
    rustUseQualifier(file, line, segments) {
        const head = segments[0];
        if (!head || ['crate', 'self', 'super', ''].includes(head) || !this.rustCrateRoots().has(head)) {
            return segments.join('::');
        }
        const { rustPathModule } = require('./rust-modules');
        return rustPathModule(this.index, file, line, head) ? `::${segments.join('::')}` : segments.join('::');
    }

    /** What NAME denotes in a resolved Rust module: its items, and the
     * names its `use` declarations re-export (a module can hold both under
     * different `#[cfg]`s). */
    rustModuleVerdict(resolved, name, depth) {
        const { rustModuleItems } = require('./rust-modules');
        const verdicts = [];
        const items = rustModuleItems(this.index, resolved, name).filter(d => this.declarationKinds.has(d.type));
        if (items.length > 0) verdicts.push(this.judge(items));
        for (const moduleEntry of resolved.entries) {
            const target = this.index.files.get(moduleEntry.file);
            const chain = moduleEntry.chain.join('::');
            const inFunction = line => (target?.symbols || []).some(symbol =>
                (symbol.type === 'function' || symbol.type === 'method' || symbol.type === 'constructor') &&
                symbol.startLine <= line && symbol.endLine >= line);
            const reexports = (target?.importBindings || []).filter(b => (b.alias || b.name) === name &&
                b.module && this.rustChainAt(moduleEntry.file, b.line || 0) === chain && !inFunction(b.line || 0));
            for (const b of reexports) {
                if (b.alias && b.alias !== b.name) {
                    verdicts.push({ verdict: 'no', reason: 'import-alias' });
                    continue;
                }
                const segments = String(b.module).split('::');
                segments.pop();
                verdicts.push(this.resolveRustPath(moduleEntry.file, b.line, segments.join('::'), name, depth + 1));
            }
            if (items.length > 0) continue;
            const globs = (target?.importDetails || []).filter(detail => detail.type === 'use-glob' &&
                detail.module && this.rustChainAt(moduleEntry.file, detail.line || 0) === chain);
            for (const glob of globs) {
                const verdict = this.resolveRustPath(moduleEntry.file, glob.line, glob.module, name, depth + 1);
                if (verdict.verdict !== 'no') {
                    verdicts.push(verdict.verdict === 'yes' ? verdict : { verdict: 'unknown', reason: 'glob-import' });
                }
            }
        }
        if (verdicts.length === 0) return { verdict: 'no', reason: 'not-in-module' };
        return this.combine(verdicts);
    }

    /** Library crate roots of the workspace by crate name ([lib] name, else
     * the package name with `-` as `_`). */
    rustCrateRoots() {
        const key = 'rust-crate-roots';
        if (this.memo.has(key)) return this.memo.get(key);
        const fs = require('fs');
        const roots = new Map();
        const manifests = new Set();
        for (const [file, entry] of this.index.files) {
            if (entry.language !== 'rust') continue;
            for (let dir = path.dirname(file); dir.startsWith(this.index.root) && dir !== path.dirname(dir);
                dir = path.dirname(dir)) {
                if (manifests.has(dir)) break;
                if (fs.existsSync(path.join(dir, 'Cargo.toml'))) {
                    manifests.add(dir);
                    break;
                }
            }
        }
        for (const dir of manifests) {
            let text;
            try { text = fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf-8'); } catch { continue; }
            const sections = text.split(/^\s*\[/m);
            const lib = sections.find(part => /^lib\]/.test(part));
            const pkg = sections.find(part => /^package\]/.test(part));
            const nameOf = part => part?.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
            const crate = (nameOf(lib) || nameOf(pkg) || '').replace(/-/g, '_');
            const libPath = lib?.match(/^\s*path\s*=\s*"([^"]+)"/m)?.[1] || 'src/lib.rs';
            const root = path.join(dir, libPath);
            if (crate && this.index.files.has(root) && !roots.has(crate)) roots.set(crate, root);
        }
        this.memo.set(key, roots);
        return roots;
    }

    // ── C / C++ ──

    enclosingClassAt(file, line) { return enclosingClassIn(this.index, file, line); }

    resolveCFamily(file, line, name, qualifierText, options = {}) {
        const entry = this.index.files.get(file);
        const { includeClosure, resolveQualifier } = lazyCppScopeModule();
        const visible = includeClosure(this.index, file);
        if (entry.language === 'c') {
            // C tags (struct/union/enum) live in their own namespace; typedef
            // names in the ordinary one.
            const tagSite = options.tag != null;
            const candidates = this.all.filter(d => d.name === name &&
                (this.valueReferences || (tagSite ? !cOrdinaryName(d) : cOrdinaryName(d))));
            const seen = candidates.filter(d => d.file === file || visible.has(d.file));
            if (seen.length > 0) return this.judge(seen);
            return { verdict: 'unknown', reason: 'not-in-include-closure' };
        }
        const spelling = qualifierText ? `${qualifierText}${qualifierText.endsWith('::') ? '' : '::'}${name}` : name;
        if (qualifierText && this.def.enclosingType) {
            // `Acc<T>::Member` / `Acc<double>::Member` against a member of a
            // specialization: the template arguments pick the class.
            const last = String(qualifierText).split('::').pop();
            const base = s => String(s).replace(/<.*$/, '');
            const owners = [...this.group].map(d => d.enclosingType).filter(Boolean);
            if (owners.some(owner => base(owner) === base(last))) {
                if (owners.includes(last)) return { verdict: 'yes' };
                // A member of the primary template, spelled with arguments
                // (`SkipList<K, C>::Node`), while the project declares no
                // specialization of that template: every argument list
                // names the primary (fix #396).
                // Explicit specializations are indexed as further same-name
                // class definitions (`template <> struct Acc<float> {..}`):
                // one definition is the primary alone.
                const classDefinitions = (this.index.symbols.get(base(last)) || [])
                    .filter(d => TYPE_DECL_KINDS.has(d.type) && d.type !== 'type');
                const specialized = classDefinitions.length !== 1 ||
                    classDefinitions.some(d => d.specialization || d.isSpecialization);
                if (!specialized && owners.every(owner => !owner.includes('<')) && last.includes('<')) {
                    return { verdict: 'yes' };
                }
                if (last.includes('<') || owners.some(owner => owner.includes('<'))) {
                    return { verdict: 'unknown', reason: 'specialization-member' };
                }
            }
        }
        // A class declared in a function body is visible from its
        // declaration to the end of its block and shadows every outer
        // declaration of the name there (fix #389).
        const functionLocal = d => !d.enclosingType && d.lexicalScopeStartLine != null;
        const localInScope = d => d.file === file && d.lexicalScopeStartLine <= line && line <= d.lexicalScopeEndLine;
        if (!qualifierText) {
            const locals = this.all.filter(d => d.name === name && functionLocal(d) && localInScope(d));
            if (locals.length > 0) {
                const innermost = Math.max(...locals.map(d => d.lexicalScopeStartLine));
                return this.judge(locals.filter(d => d.lexicalScopeStartLine === innermost));
            }
        }
        const site = this.cppSiteContext(file, line);
        const context = { file, line, namespace: site.namespace,
            className: qualifierText && qualifierText.startsWith('::') ? null : site.className };
        const found = resolveQualifier(this.index, context, spelling, visible, 0,
            { declarations: true, values: this.valueReferences === true,
                ...(this.valueReferences && this.siteNode && { valueSite: {
                    file: this.siteFile || file, index: this.siteNode.startIndex } }) });
        if (found.kind === 'namespace') return { verdict: 'no', reason: 'namespace' };
        if (found.kind === 'type' || found.kind === 'value') {
            const declarations = (found.declarations || []).filter(d => !functionLocal(d) || localInScope(d));
            const siblings = this.cppSiblingMembers(declarations);
            if (siblings) {
                // Members of same-name classes (specializations of one
                // template, configuration alternatives): the class body the
                // site sits in decides; elsewhere it is not decidable here.
                const inside = d => d && d.file === file && d.startLine <= line && d.endLine >= line;
                if (siblings.pinOwners.some(inside)) return { verdict: 'yes' };
                if (siblings.otherOwners.some(inside)) return { verdict: 'no', reason: 'other-type' };
                return { verdict: 'unknown', reason: 'specialization-member' };
            }
            const verdict = this.judge(declarations);
            if (verdict.verdict === 'yes' && !found.visible) {
                return { verdict: 'unknown', reason: 'not-in-include-closure' };
            }
            // Only declarations the site cannot see answered the lookup
            // (fix #393): the site's scope was not read right (a namespace
            // a damaged parse or a macro-opened inline namespace hid), so a
            // renamed declaration the site does see may be the one named.
            if (verdict.verdict === 'no' && !found.visible &&
                [...this.group].some(d => d.file === file || visible.has(d.file))) {
                return { verdict: 'unknown', reason: 'scope-unresolved' };
            }
            return verdict;
        }
        if ((found.why === 'no-declaration' || found.why === 'not-visible') && !qualifierText) {
            // A member type (alias, nested class) of the class whose body
            // holds the site: class scope is searched before the enclosing
            // namespaces, innermost class first (fix #387: `using range_type
            // = ...` in one of two `formatter` specializations).
            const members = this.all.filter(d => d.name === name && d.file === file && d.enclosingType &&
                TYPE_DECL_KINDS.has(d.type) && d.lexicalScopeStartLine != null &&
                d.lexicalScopeStartLine <= line && line <= d.lexicalScopeEndLine);
            if (members.length > 0) {
                const innermost = Math.max(...members.map(d => d.lexicalScopeStartLine));
                return this.judge(members.filter(d => d.lexicalScopeStartLine === innermost));
            }
        }
        if ((found.why === 'no-declaration' || found.why === 'not-visible') && !qualifierText && site.className) {
            // Class scope sees the injected class names of its bases
            // (`Derived() : Base() {}`, `Base::f()` inside a member).
            const viaBase = this.cppBaseNamed(file, line, site.className, name, 0);
            if (viaBase) return viaBase;
        }
        if (found.why === 'no-declaration') {
            // A qualifier that names nothing the project declares (a macro
            // the parse kept, a namespace outside the project) decides
            // nothing about the name, unless it is the standard library.
            if (qualifierText && !qualifierText.startsWith('::')) {
                const root = qualifierText.split('::')[0];
                const outer = resolveQualifier(this.index, context, qualifierText, visible, 0, { declarations: true });
                if (outer.kind === 'unknown' && !(langTraits(entry.language)?.standardPathRoots || []).includes(root)) {
                    return { verdict: 'unknown', reason: 'unresolved-qualifier' };
                }
            }
            // An unqualified name the lookup finds nowhere, while the renamed
            // type is the project's only declaration of it: the site's scope
            // was not read right (code that compiles names something), so
            // it is left for review rather than dropped.
            if (!qualifierText && this.all.filter(d => d.name === name).every(d => this.inGroup(d))) {
                return { verdict: 'unknown', reason: 'scope-unresolved' };
            }
            // No project declaration of that spelling is in scope.
            return { verdict: 'no', reason: 'not-in-scope' };
        }
        if (found.why === 'not-visible') {
            const candidates = this.all.filter(d => d.name === name);
            if (candidates.every(d => !this.inGroup(d))) return { verdict: 'no', reason: 'other-type' };
            return { verdict: 'unknown', reason: 'not-in-include-closure' };
        }
        return { verdict: 'unknown', reason: found.why || 'unresolved-qualifier' };
    }

    pinIsTag() {
        return !cOrdinaryName(this.def);
    }

    /** The class defining a member type (lexical container of its name). */
    ownerClassOf(d) {
        if (!d.enclosingType) return null;
        const entry = this.index.files.get(d.file);
        let best = null;
        for (const s of entry?.symbols || []) {
            if (s.name !== d.enclosingType || !TYPE_DECL_KINDS.has(s.type) || s.type === 'type') continue;
            if (s.startLine > d.startLine || s.endLine < d.endLine) continue;
            if (!best || (s.endLine - s.startLine) < (best.endLine - best.startLine)) best = s;
        }
        return best;
    }

    /**
     * When the pin is a member type and the lookup lands on member types of
     * same-name classes (template specializations, configuration
     * alternatives) whose owners the index cannot tell apart by name: the
     * pin's owners and the other owners. Null otherwise.
     */
    cppSiblingMembers(declarations) {
        if (!this.def.enclosingType) return null;
        const pinOwners = [...this.group].map(d => this.ownerClassOf(d)).filter(Boolean);
        if (pinOwners.length === 0) return null;
        const scopeOf = d => `${effectiveNs(this.index, d)}|${d.enclosingType || ''}`;
        const pinScope = scopeOf(this.def);
        const same = this.all.filter(d => d.name === this.name && scopeOf(d) === pinScope && !this.inGroup(d));
        if (same.length === 0) return null;
        if (!declarations.some(d => scopeOf(d) === pinScope)) return null;
        const otherOwners = same.map(d => this.ownerClassOf(d)).filter(Boolean);
        return { pinOwners, otherOwners };
    }

    /** The verdict for NAME as a base class of the class `className` seen
     * from file:line (its injected class name), or null. */
    cppBaseNamed(file, line, className, name, depth) {
        if (depth > 3) return null;
        const { includeClosure, resolveQualifier, effectiveNamespace } = lazyCppScopeModule();
        const { splitParentList } = require('./graph-build');
        const visible = includeClosure(this.index, file);
        const simple = String(className).split('::').pop();
        const classes = (this.index.symbols.get(simple) || []).filter(d => TYPE_DECL_KINDS.has(d.type) &&
            d.type !== 'type' && d.extends && (d.file === file || visible.has(d.file)) &&
            familyOf(this.index.files.get(d.file)?.language) === 'c');
        const verdicts = [];
        for (const cls of classes) {
            for (const raw of splitParentList(cls.extends)) {
                const spelled = raw.replace(/\b(public|protected|private|virtual)\b/g, '').replace(/\s+/g, '');
                const plain = spelled.replace(/<.*$/, '');
                const last = plain.split('::').pop();
                const context = { file: cls.file, line: cls.startLine, namespace: effectiveNamespace(this.index, cls),
                    className: cls.enclosingType || null };
                if (last === name) {
                    const found = resolveQualifier(this.index, context, plain, includeClosure(this.index, cls.file), 0,
                        { declarations: true });
                    if (found.kind === 'type') verdicts.push(this.judge(found.declarations || []));
                    else verdicts.push({ verdict: 'unknown', reason: 'base-class' });
                } else {
                    const deeper = this.cppBaseNamed(cls.file, cls.startLine, last, name, depth + 1);
                    if (deeper) verdicts.push(deeper);
                }
            }
        }
        return verdicts.length > 0 ? this.combine(verdicts) : null;
    }

    /**
     * Namespace and class scope of the token being decided (C++), read from
     * the AST: enclosing `namespace` blocks (after a macro-opened prefix)
     * and enclosing class bodies, or the class an out-of-line member
     * definition qualifies (`void Widget::f() {}`). Template headers and
     * other lines outside every indexed symbol keep their real scope.
     */
    cppSiteContext(file, line) { return cppSiteContextOf(this.index, this.siteNode, this.siteFile, file, line); }

    // ── Qualified names ──

    resolveQualified(file, line, qualifierNode, qualifierText, tok) {
        const text = qualifierText != null ? qualifierText : textOf(qualifierNode);
        const site = (this.family === 'c' || this.family === 'csharp' || this.family === 'python') && this.siteNode
            ? `\0${this.siteNode.startIndex}` : '';
        const key = `q\0${file}\0${line}\0${text}\0${tok.role}${site}`;
        if (this.memo.has(key)) return this.memo.get(key);
        let result;
        try {
            result = this._resolveQualified(file, line, qualifierNode, text, tok);
        } catch {
            result = { verdict: 'unknown', reason: 'resolution-error' };
        }
        this.memo.set(key, result);
        return result;
    }

    _resolveQualified(file, line, qualifierNode, text, tok) {
        const entry = this.index.files.get(file);
        const name = this.name;
        switch (this.family) {
            case 'js': case 'python': {
                const { _moduleAttributeBindingReaches } = require('./callers');
                let receiver = text;
                if (this.family === 'python') {
                    const verdict = this.pythonModuleAttribute(file, receiver, qualifierNode);
                    if (verdict) return verdict;
                }
                if (!/^[A-Za-z_$][\w$]*$/.test(receiver)) {
                    return tok.role === 'member' ? { verdict: 'no', reason: 'member' }
                        : { verdict: 'unknown', reason: 'qualified-name' };
                }
                const reach = _moduleAttributeBindingReaches(this.index, file, receiver, name, this.pinFiles);
                if (reach === 'yes') {
                    // The module exposes the name; it must be the pin, not a
                    // same-name export the file-level chase cannot tell apart.
                    return this.moduleExposesPin(file, entry, receiver);
                }
                if (reach === 'no') return { verdict: 'no', reason: 'other-module' };
                if (reach === 'unknown') return { verdict: 'unknown', reason: 'module-attribute' };
                // Not a module: a class (nested type) or an ordinary value.
                const owner = [...this.group].find(d => this.ownerNameOf(d) === receiver);
                if (owner) {
                    const outer = this.resolveTypeNamed(file, line, receiver);
                    return outer === 'owner' ? { verdict: 'yes' }
                        : outer === 'other' ? { verdict: 'no', reason: 'other-type' }
                            : { verdict: 'unknown', reason: 'nested-type' };
                }
                return { verdict: 'no', reason: 'member' };
            }
            case 'go': {
                // A local declared before the selector hides the package
                // name in its block (fix #420: `conf := conf.Default` then
                // `conf.Limit` reads a field of the local).
                if (qualifierNode?.type === 'identifier') {
                    if (!this._goScopes) this._goScopes = new WeakMap();
                    let memo = this._goScopes.get(qualifierNode.tree);
                    if (!memo) { memo = new Map(); this._goScopes.set(qualifierNode.tree, memo); }
                    const { referenceScope } = require('../languages/lexical-scope');
                    const scope = referenceScope(qualifierNode, 'go', memo, text);
                    if (scope === 'unknown') return { verdict: 'unknown', reason: 'qualifier-scope' };
                    if (scope && scope !== 'module' && scope !== 'none') {
                        if (tok.role === 'member') return this.goFieldVerdict(this.siteNode, file);
                        return { verdict: 'no', reason: 'local-binding' };
                    }
                }
                const binding = (entry.importBindings || []).find(b => (b.alias || b.name) === text && b.module);
                if (!binding) {
                    if (tok.role === 'member') return this.goFieldVerdict(this.siteNode, file);
                    return { verdict: 'unknown', reason: 'qualified-name' };
                }
                const moduleFile = this.moduleFile(entry, binding.module);
                if (!moduleFile) return { verdict: 'no', reason: 'external-package' };
                const dir = path.dirname(moduleFile);
                const types = this.all.filter(d => path.dirname(d.file) === dir && d.lexicalScopeStartLine == null &&
                    !String(this.index.files.get(d.file)?.packageName || '').endsWith('_test'));
                return this.judge(types, 'other-package');
            }
            case 'rust':
                return this.resolveRustPath(file, line, text.replace(/<[^<>]*>/g, ''), name, 0);
            case 'java': return this.resolveJavaQualified(file, line, text, tok);
            case 'csharp': return this.resolveCSharpQualified(file, line, text, tok);
            case 'c': return this.resolveCFamily(file, line, name, text);
            default:
                return { verdict: 'unknown', reason: 'qualified-name' };
        }
    }

    ownerNameOf(d) {
        if (d.enclosingType) return d.enclosingType;
        const container = this.containerOf(d);
        return container && TYPE_DECL_KINDS.has(container.type) ? container.name : null;
    }

    /** Does `receiver` (a type name at file:line) name the pin's owner? */
    resolveTypeNamed(file, line, receiver) {
        const owners = [...this.group].map(d => {
            const entry = this.index.files.get(d.file);
            return (entry?.symbols || []).find(s => s.name === this.ownerNameOf(d) &&
                TYPE_DECL_KINDS.has(s.type) && s.startLine <= d.startLine && s.endLine >= d.endLine);
        }).filter(Boolean);
        if (owners.length === 0) return 'unknown';
        const sub = new TypeReferenceResolver(this.index, owners[0], receiver);
        const verdict = sub.resolveName(file, line, receiver);
        return verdict.verdict === 'yes' ? 'owner' : verdict.verdict === 'no' ? 'other' : 'unknown';
    }

    moduleExposesPin(file, entry, receiver) {
        // `_moduleAttributeBindingReaches` is file-level; re-ask exactly.
        const starts = [];
        for (const b of entry.importBindings || []) {
            if ((b.alias || b.name) !== receiver || !b.module) continue;
            let moduleFile;
            if (this.family === 'python' && b.kind !== 'import') {
                // `from pkg import sub`: the receiver is the submodule.
                const module = String(b.module);
                moduleFile = this.moduleFile(entry, module.endsWith('.') ? module + b.name : `${module}.${b.name}`);
            } else {
                moduleFile = this.moduleFile(entry, b.module);
            }
            if (moduleFile) starts.push(moduleFile);
        }
        if (starts.length === 0) return { verdict: 'unknown', reason: 'module-attribute' };
        const verdicts = starts.map(start => this.chase(start, this.name));
        if (verdicts.every(v => v === 'yes')) return { verdict: 'yes' };
        if (verdicts.every(v => v === 'no')) return { verdict: 'no', reason: 'other-module' };
        return { verdict: 'unknown', reason: 'module-attribute' };
    }

    pythonModuleAttribute(file, receiver, node) {
        const modules = this.pythonModulePath(file, receiver);
        if (!modules) return null; // An ordinary value or nested class.
        if (node) {
            let head = node;
            while (head?.type === 'attribute') head = head.childForFieldName('object');
            if (head?.type !== 'identifier') return { verdict: 'unknown', reason: 'module-attribute' };
            if (!this._pythonScopes) this._pythonScopes = new Map();
            if (!this._pythonScopes.has(file)) this._pythonScopes.set(file, new Map());
            const { referenceScope } = require('../languages/lexical-scope');
            // A local may hold the imported module, but its spelling alone
            // cannot prove that. Never reuse a module import through a shadow.
            if (referenceScope(head, 'python', this._pythonScopes.get(file)) !== 'module') {
                return { verdict: 'unknown', reason: 'module-receiver-shadow' };
            }
        }
        if (modules.unknown) return { verdict: 'unknown', reason: 'module-attribute' };
        if (modules.files.length === 0) return { verdict: 'no', reason: 'external-module' };
        return this.combine(modules.files.map(start => {
            const reach = this.chase(start, this.name);
            return reach === 'yes' ? { verdict: 'yes' }
                : reach === 'no' ? { verdict: 'no', reason: 'other-module' }
                    : { verdict: 'unknown', reason: 'module-attribute' };
        }));
    }

    pythonModulePath(file, receiver) {
        const { pythonModulePath } = require('./python-modules');
        return pythonModulePath(this.index, file, receiver, this.memo);
    }

    /** Does the project declare Java package `name` or one below it? */
    javaPackageDeclared(name) {
        return projectHas(this.index, 'java-package-prefixes', name, javaPackagePrefixes);
    }

    resolveJavaQualified(file, line, text, tok) {
        const qualifier = text.replace(/<.*?>/g, '');
        const candidates = this.all.filter(d => d.name === this.name);
        const byFqnPrefix = candidates.filter(d => {
            const prefix = this.javaFqn(d).slice(0, -(d.name.length + 1));
            return prefix === qualifier;
        });
        if (byFqnPrefix.length > 0) return this.judge(byFqnPrefix);
        if (this.javaPackageDeclared(qualifier)) return { verdict: 'no', reason: 'other-package' };
        const last = qualifier.split('.').pop();
        const nested = candidates.filter(d => d.enclosingType === last);
        if (nested.length > 0) {
            if (!qualifier.includes('.')) {
                const outer = this.resolveTypeNamed(file, line, last);
                if (outer === 'owner') return { verdict: 'yes' };
                if (outer === 'other') return { verdict: 'no', reason: 'other-type' };
            }
            return { verdict: 'unknown', reason: 'nested-type' };
        }
        if (tok.role === 'member') return { verdict: 'no', reason: 'member' };
        if (/^[a-z]/.test(qualifier) && !qualifier.includes('(')) {
            return { verdict: 'no', reason: 'external-package' };
        }
        return { verdict: 'unknown', reason: 'qualified-name' };
    }

    /** Does the project declare C# namespace `name` or one below it? */
    csharpNamespaceDeclared(name) {
        return projectHas(this.index, 'cs-namespace-prefixes', name, csharpNamespacePrefixes);
    }

    resolveCSharpQualified(file, line, text, tok) {
        // A constructed containing type has an arity at every owner
        // segment. Erasing those arguments would merge Outer.Inner with
        // Outer<T>.Inner. Until that owner chain is proven, keep the site
        // visible without supplying a type-identity witness.
        if (text.includes('<')) return { verdict: 'unknown', reason: 'generic-containing-type' };
        // An `extern alias` qualifier (`Old::Lib.Core.Widget`, fix #401)
        // names an assembly reference: a project namespace of that spelling
        // may or may not be the assembly's.
        const externAlias = /^([A-Za-z_]\w*)::/.exec(text);
        if (externAlias && externAlias[1] !== 'global') {
            const rest = text.slice(externAlias[0].length).replace(/<.*?>/g, '');
            const spelled = this.all.some(d => d.name === this.name &&
                `${d.namespace || ''}${d.enclosingType ? (d.namespace ? '.' : '') + d.enclosingType : ''}` === rest);
            return spelled ? { verdict: 'unknown', reason: 'extern-alias' } : { verdict: 'no', reason: 'external-namespace' };
        }
        let qualifier = text.replace(/<.*?>/g, '').replace(/^global::/, '');
        // A using alias names the qualifier's head in this namespace body.
        const head = qualifier.split('.')[0];
        const { csharpUsings } = require('./type-denotation');
        const namespace = this.csharpSiteNamespace(file, line);
        if (namespace === undefined) return { verdict: 'unknown', reason: 'unknown-namespace' };
        const scope = csharpUsings(this.index, file, namespace, this.siteNode);
        const global = text.startsWith('global::');
        const chain = [];
        for (let parts = !global && namespace ? namespace.split('.') : []; parts.length > 0; parts = parts.slice(0, -1)) {
            chain.push(parts.join('.'));
        }
        chain.push('');
        const candidates = this.all.filter(d => d.name === this.name);
        for (const ns of chain) {
            const full = ns ? `${ns}.${qualifier}` : qualifier;
            const hits = candidates.filter(d => {
                const prefix = `${d.namespace || ''}${d.enclosingType ? (d.namespace ? '.' : '') + d.enclosingType : ''}`;
                return prefix === full;
            });
            const alias = !global && scope.aliasScopes?.get(head) === ns && scope.aliases.get(head);
            if (alias && (hits.length || scope.ambiguousAliases.has(head))) {
                return { verdict: 'unknown', reason: 'ambiguous-type' };
            }
            if (hits.length > 0) return this.judge(hits);
            if (this.csharpNamespaceDeclared(full)) return { verdict: 'no', reason: 'other-namespace' };
            if (alias) {
                if (scope.aliasSyntax.get(head)?.includes('<')) {
                    return { verdict: 'unknown', reason: 'generic-alias-owner' };
                }
                const expanded = [alias, ...qualifier.split('.').slice(1)].join('.');
                return this.resolveCSharpQualified(file, line, 'global::' + expanded, tok);
            }
            if (this.csharpNamespaceDeclared(ns ? `${ns}.${head}` : head)) return { verdict: 'no', reason: 'other-namespace' };
        }
        const last = qualifier.split('.').pop();
        if (candidates.some(d => d.enclosingType === last)) {
            if (!qualifier.includes('.')) {
                const outer = this.resolveTypeNamed(file, line, last);
                if (outer === 'owner') return { verdict: 'yes' };
                if (outer === 'other') return { verdict: 'no', reason: 'other-type' };
            }
            return { verdict: 'unknown', reason: 'nested-type' };
        }
        if (tok.role === 'member') return { verdict: 'no', reason: 'member' };
        return { verdict: 'no', reason: 'external-namespace' };
    }

    // ── Go embedded fields ──

    embedders() {
        if (this._embedders !== undefined) return this._embedders;
        const out = [];
        for (const d of this.index.symbols.get(this.name) || []) {
            if (d.type !== 'field' || !d.embedded) continue;
            if (familyOf(this.index.files.get(d.file)?.language) !== 'go') continue;
            const spelled = String(d.fieldType || '').replace(/^\*/, '');
            const qualifier = spelled.includes('.') ? spelled.split('.').slice(0, -1).join('.') : null;
            const verdict = qualifier
                ? this.resolveQualified(d.file, d.startLine, null, qualifier, { role: 'type' })
                : this.resolveName(d.file, d.startLine);
            if (verdict.verdict !== 'no') out.push(d);
        }
        this._embedders = out;
        return out;
    }

    /**
     * `x.Widget` or `S{Widget: v}`: when the pin is embedded somewhere, the
     * embedded field is named Widget. The struct the selector or key applies
     * to is read from the AST (a parameter, receiver, typed variable or
     * composite-literal local, or the literal's own type); its field named
     * like the type decides: the embedded pin -> edit, a named field -> not
     * a reference; anything else -> review.
     */
    goFieldVerdict(node = null, file = null) {
        const embedders = this.embedders();
        if (embedders.length === 0) return { verdict: 'no', reason: 'member' };
        const unknown = { verdict: 'unknown', reason: 'go-embedded-field' };
        if (!node || !file) return unknown;
        const typeNode = goStructTypeOf(node);
        if (!typeNode) return unknown;
        let typeName = null;
        let dir = null;
        const entry = this.index.files.get(file);
        if (typeNode.type === 'type_identifier') {
            typeName = typeNode.text;
            dir = path.dirname(file);
        } else if (typeNode.type === 'qualified_type') {
            typeName = typeNode.childForFieldName('name')?.text;
            const pkg = typeNode.childForFieldName('package')?.text;
            const binding = (entry?.importBindings || []).find(b => (b.alias || b.name) === pkg && b.module);
            const moduleFile = binding ? this.moduleFile(entry, binding.module) : null;
            dir = moduleFile ? path.dirname(moduleFile) : null;
        }
        if (!typeName || !dir) return unknown;
        const fields = (this.index.symbols.get(this.name) || []).filter(d => d.type === 'field' &&
            d.className === typeName && path.dirname(d.file) === dir);
        if (fields.length === 0) return unknown;
        if (fields.every(d => embedders.includes(d))) return { verdict: 'yes' };
        if (fields.every(d => !d.embedded)) return { verdict: 'no', reason: 'member' };
        return unknown;
    }
}

const GO_FUNCTIONS = new Set(['function_declaration', 'method_declaration', 'func_literal']);

/** The Go type node a declaration gives an identifier in scope at `site`. */
function goDeclaredTypeOf(site, identifier) {
    const unwrap = type => {
        while (type && (type.type === 'pointer_type' || type.type === 'parenthesized_type')) {
            type = type.namedChild(0);
        }
        if (type?.type === 'generic_type') type = type.childForFieldName('type');
        return type && (type.type === 'type_identifier' || type.type === 'qualified_type') ? type : null;
    };
    const literalType = value => {
        if (value?.type === 'unary_expression') value = value.childForFieldName('operand');
        return value?.type === 'composite_literal' ? unwrap(value.childForFieldName('type')) : null;
    };
    for (let scope = site.parent; scope; scope = scope.parent) {
        if (GO_FUNCTIONS.has(scope.type)) {
            for (const field of ['receiver', 'parameters']) {
                const list = scope.childForFieldName(field);
                for (let i = 0; i < (list?.namedChildCount || 0); i++) {
                    const param = list.namedChild(i);
                    const names = (param.namedChildren || []).filter(child => child.type === 'identifier');
                    if (names.some(n => n.text === identifier)) return unwrap(param.childForFieldName('type'));
                }
            }
        }
        if (scope.type !== 'block' && scope.type !== 'source_file') continue;
        let found = null;
        for (let i = 0; i < scope.namedChildCount; i++) {
            const statement = scope.namedChild(i);
            if (statement.startIndex >= site.startIndex) break;
            if (statement.type === 'var_declaration') {
                for (const spec of statement.namedChildren || []) {
                    if (spec.type !== 'var_spec') continue;
                    const names = (spec.namedChildren || []).filter(child => child.type === 'identifier');
                    const index = names.findIndex(n => n.text === identifier);
                    if (index < 0) continue;
                    const values = spec.childForFieldName('value');
                    found = unwrap(spec.childForFieldName('type')) ||
                        literalType(values?.namedChild ? values.namedChild(index) : null);
                }
            } else if (statement.type === 'short_var_declaration') {
                const left = statement.childForFieldName('left');
                const right = statement.childForFieldName('right');
                const index = (left?.namedChildren || []).findIndex(n => n.text === identifier);
                if (index >= 0) found = literalType(right?.namedChild(index));
            }
        }
        if (found) return found;
    }
    return null;
}

/** The struct type a Go field selector or composite-literal key applies to. */
function goStructTypeOf(node) {
    const parent = node.parent;
    if (parent?.type === 'selector_expression') {
        const operand = parent.childForFieldName('operand');
        if (operand?.type === 'identifier') return goDeclaredTypeOf(parent, operand.text);
        return null;
    }
    for (let current = parent; current; current = current.parent) {
        if (current.type === 'composite_literal') {
            let type = current.childForFieldName('type');
            if (type?.type === 'generic_type') type = type.childForFieldName('type');
            return type && (type.type === 'type_identifier' || type.type === 'qualified_type') ? type : null;
        }
        if (current.type !== 'literal_element' && current.type !== 'keyed_element' && current.type !== 'literal_value') {
            return null;
        }
    }
    return null;
}

function javaPackageOf(entry, line) {
    const { siteNamespaceOf } = require('./type-denotation');
    const ns = siteNamespaceOf(entry, line);
    if (ns !== undefined) return ns;
    const withNs = (entry.symbols || []).find(s => s.namespace);
    return withNs ? withNs.namespace : ((entry.symbols || []).length > 0 ? '' : undefined);
}

// ── The pass ─────────────────────────────────────────────────────────────

const TEXT_NODE = /comment|string|char_literal|heredoc|raw_string|template_string/;
const PY_ANNOTATION = new Set(['type']);
const PY_ANNOTATION_STOP = new Set(['block', 'module', 'class_definition', 'function_definition',
    'call', 'argument_list']);

/**
 * Decide every name token on the ground lines of a type rename.
 * @returns {{ files: Map<string, {relativePath, lines: Map<number, {edits: number[], reviews: Array<{column, reason}>, skips: number, text: boolean, tokens: number}>}> }}
 */
function typeReferenceSites(index, def, name, groundSet, resolver = new TypeReferenceResolver(index, def, name)) {
    const files = new Map();
    const perFile = groundSet?.perFile || new Map();
    const sortedFiles = [...perFile.keys()].sort();
    for (const file of sortedFiles) {
        const entry = index.files.get(file);
        if (!entry) continue;
        const language = entry.language;
        const htmlScripts = language === 'html' && resolver.family === 'js';
        if (familyOf(language) !== resolver.family && !htmlScripts) continue;
        const lineNumbers = [...perFile.get(file)].sort((a, b) => a - b);
        const result = scanFile(index, resolver, file, entry, language, lineNumbers);
        if (result) files.set(file, { relativePath: entry.relativePath, lines: result });
    }
    return { files, resolver };
}

/**
 * An HTML page's inline scripts as JavaScript at their own lines and
 * columns (the rest blank), and the rows of `on*` handler attributes that
 * spell the name (code UCN does not parse: review).
 */
function htmlScriptView(content, name) {
    const html = require('../languages/html');
    const htmlParser = getParser('html');
    const blocks = html.extractScriptBlocks(content, htmlParser);
    const handlerRows = new Set();
    const tree = safeParse(htmlParser, content);
    const stack = tree ? [tree.rootNode] : [];
    while (stack.length > 0) {
        const node = stack.pop();
        if (node.type === 'attribute') {
            const attrName = node.namedChild(0)?.text || '';
            if (/^on/i.test(attrName) && node.text.includes(name)) {
                for (let row = node.startPosition.row; row <= node.endPosition.row; row++) handlerRows.add(row);
            }
            continue;
        }
        for (let i = 0; i < node.namedChildCount; i++) stack.push(node.namedChild(i));
    }
    return { script: html.buildVirtualJSContent(content, blocks), handlerRows };
}

function scanFile(index, resolver, file, entry, language, lineNumbers) {
    const name = resolver.name;
    let content;
    try { content = index._readFile(file); } catch { return null; }
    const local = resolver.readLocalFile?.(file, entry, language, lineNumbers, content);
    if (local) return local;
    let htmlView = null;
    if (language === 'html') {
        htmlView = htmlScriptView(content, name);
        language = 'javascript';
    }
    const parser = getParser(language);
    if (!parser) return null;
    const tree = htmlView ? safeParse(parser, htmlView.script)
        : (resolver.valueReferences && require('./query-bodies').localQueryTree(index, file, entry, language, name, content)) ||
            index._getParsedTree?.(file, content, language) || safeParse(parser, content);
    const lines = new Map();
    const lineOf = row => {
        let slot = lines.get(row + 1);
        if (!slot) {
            slot = { edits: [], reviews: [], skips: 0, skipColumns: [], text: false, tokens: 0, macroBody: false };
            lines.set(row + 1, slot);
        }
        return slot;
    };
    for (const lineNo of lineNumbers) lineOf(lineNo - 1);
    if (!tree) {
        for (const slot of lines.values()) slot.reviews.push({ column: null, reason: 'unparsed-file' });
        return lines;
    }
    const nameBytes = Buffer.byteLength(name);
    const docComments = [];
    // The nodes holding each occurrence of the name's text (one native
    // lookup per occurrence, document order): name tokens on the ground rows,
    // and the text, macro-body and opaque-error leaves overlapping them.
    const source = htmlView ? htmlView.script : content;
    const occurrences = [];
    for (let at = source.indexOf(name); at >= 0; at = source.indexOf(name, at + 1)) occurrences.push(at);
    const collect = (root, rowList, marks) => {
        const found = [];
        const seen = new Set();
        const overlaps = node => {
            const start = node.startPosition.row;
            const end = node.endPosition.row;
            let lo = 0;
            let hi = rowList.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (rowList[mid] < start) lo = mid + 1; else hi = mid;
            }
            return lo < rowList.length && rowList[lo] <= end;
        };
        const mark = (node, field) => {
            if (!marks) return;
            for (let row = node.startPosition.row; row <= node.endPosition.row; row++) {
                if (lines.has(row + 1)) lines.get(row + 1)[field] = true;
            }
        };
        for (const at of occurrences) {
            let node = root.descendantForIndex(at, at + name.length);
            // An extra (a comment) inside an aliased rule can carry the
            // alias as its type, depending on which traversal first wrapped
            // the node (fix #420: `{ // x }` read as `interface_body` after a
            // children walk, as `comment` otherwise): its grammar type is
            // the stable one.
            const type = node && (node.isExtra ? node.grammarType || node.type : node.type);
            // The smallest node holding the text: a token, a text or macro
            // leaf, or (between tokens) a container the walk would not read.
            if (node && !TOKEN_TYPES.has(type) && !TEXT_NODE.test(type) &&
                type !== 'preproc_arg' && !(type === 'ERROR' && node.namedChildCount === 0)) {
                node = null;
            }
            if (!node || seen.has(node.id) || !overlaps(node)) continue;
            seen.add(node.id);
            if (TOKEN_TYPES.has(type)) {
                const length = node.endIndex - node.startIndex;
                if ((length === name.length || length === nameBytes) && node.text === name) found.push(node);
                continue;
            }
            if (type === 'preproc_arg' || type === 'ERROR') {
                mark(node, 'macroBody');
                continue;
            }
            // Text: leaves only (a template string's substitutions are
            // code, read as tokens of their own).
            if (node.namedChildCount !== 0 && !type.includes('comment')) continue;
            mark(node, 'text');
            if (!resolver.valueReferences && resolver.family === 'csharp' && type === 'comment' && marks) docComments.push(node);
            if (resolver.family === 'python' && type === 'string_content' &&
                ((!resolver.valueReferences && pythonTypeExpressionString(node, entry)) ||
                    pythonDunderAllEntry(node, name))) found.push(node);
        }
        return found;
    };
    // C/C++: read the tree the index reads (macro recoveries applied), and
    // fall back to the literal parse for lines a recovery blanked.
    const rows = lineNumbers.map(n => n - 1);
    let tokens = collect(tree.rootNode, rows, true);
    // A clean literal parse can still be a misreading the recovery
    // corrected (`API T (name)(..)`, fix #396): a token whose statement holds
    // a persisted blank reads through the recovered tree too.
    const persistedBlanks = resolver.family === 'c' && Array.isArray(entry.recoveryBlanks) &&
        entry.recoveryBlanks.length > 0 ? entry.recoveryBlanks : null;
    // A decoration can make a record look like a clean function whose
    // fields look like local declarations. Recover the pinned value's
    // enclosing header too, using the same blanks the index verified.
    const valueDeclarationHeader = resolver.valueReferences && persistedBlanks && resolver.def.file === file &&
        tokens.some(node => node.startPosition.row + 1 === (resolver.def.nameLine || resolver.def.startLine) &&
            enclosingHeaderHoldsBlank(node, persistedBlanks));
    if (resolver.family === 'c' && ((tree.rootNode.hasError && tokens.some(statementHasError)) ||
        (persistedBlanks && tokens.some(node => statementHoldsBlank(node, persistedBlanks))) || valueDeclarationHeader)) {
        // Only when the literal parse breaks around a token: the recovery
        // re-parses the file.
        let module;
        try { module = LANGUAGES[language]?.module(); } catch { module = null; }
        // The blank ranges the index persisted for this content rebuild the
        // recovered tree with one parse (fix #387); stale or missing ones
        // replay the recovery.
        const blanks = Array.isArray(entry.recoveryBlanks) && entry.hash &&
            require('crypto').createHash('md5').update(content).digest('hex') === entry.hash
            ? entry.recoveryBlanks : null;
        const recoveredTree = typeof module?.recoveredTree === 'function'
            ? module.recoveredTree(content, parser, blanks) : null;
        if (recoveredTree) {
            const literal = tokens;
            tokens = collect(recoveredTree.rootNode, rows, false);
            // A recovery blanks text it reads as macros; a token it blanked
            // is still a token of the source: keep the literal one.
            const seen = new Set(tokens.map(node => `${node.startPosition.row}:${node.startPosition.column}`));
            for (const node of literal) {
                if (!seen.has(`${node.startPosition.row}:${node.startPosition.column}`)) tokens.push(node);
            }
        }
    }
    if (htmlView) {
        // Page text outside scripts is not code; handler attributes are code
        // UCN does not parse.
        const scriptRows = new Set(tokens.map(node => node.startPosition.row));
        for (const row of rows) {
            if (scriptRows.has(row)) continue;
            const slot = lines.get(row + 1);
            if (htmlView.handlerRows.has(row)) {
                slot.macroBody = true;
                slot.unparsedReason = 'html-event-handler';
            }
            else slot.text = true;
        }
    }
    // A type the language declares by binding a name (a Python `Alias =
    // ...` / `Alias: TypeAlias = ...`, a JS/TS variable holding a class) is
    // declared by that binding token, not shadowed by it.
    const pinLines = new Set([...resolver.group].filter(d => d.file === file && d.type === 'type')
        .map(d => (d.nameLine || d.startLine) - 1));
    const classified = tokens.map(node => {
        let role = node.type !== 'string_content' ? classify(node, language)
            : pythonDunderAllEntry(node, name) ? { role: 'dunder-all' } : { role: 'string-annotation' };
        if (role.role === 'skip' && (role.why === 'assignment' || role.why === 'variable') &&
            (resolver.family === 'python' || resolver.family === 'js') && pinLines.has(node.startPosition.row)) {
            role = { role: 'pin-binding' };
        }
        return { node, role };
    });
    const bindings = classified.filter(t => t.role.role === 'skip' && t.role.binding)
        .map(t => ({ node: t.node, scope: bindingScope(t.node, resolver.family, t.role), role: t.role }));
    const typeParams = classified.filter(t => t.role.role === 'skip' && t.role.typeParam)
        .map(t => ({ node: t.node, scope: typeParamScope(t.node) }));
    let fileLocalOnly = true;
    for (const token of classified) {
        const row = token.node.startPosition.row;
        const slot = lineOf(row);
        if (token.role.role === 'string-annotation') {
            decideStringAnnotation(resolver, file, entry, token.node, slot);
            continue;
        }
        slot.tokens++;
        resolver.siteNode = token.node;
        resolver.siteFile = file;
        // A position no rule decides is a review item, never an edit or a skip.
        const decision = (resolver.decideToken
            ? resolver.decideToken(file, entry, token, bindings, typeParams)
            : decide(resolver, file, entry, token, bindings, typeParams)) ||
            { verdict: 'unknown', reason: 'unmodelled-position' };
        if (!decision.fileLocalOnly) fileLocalOnly = false;
        resolver.siteNode = null;
        // An `__all__` entry is a code reference: once edited it is no
        // longer a text-only review item.
        if (token.role.role === 'dunder-all') slot.stringAnnotation = true;
        // The impact band (fix #428) reads each token's syntactic role and
        // why a token names something else; a rename reads only verdicts.
        if (resolver.collectRoles) {
            // A Python annotation is an expression in a type position.
            const role = token.role.role === 'value' && resolver.family === 'python' &&
                ancestor(token.node, PY_ANNOTATION, PY_ANNOTATION_STOP) ? 'type' : token.role.role;
            (slot.roles ||= new Map()).set(token.node.startPosition.column, role);
            if (constructionHead(token.node)) (slot.constructionColumns ||= []).push(token.node.startPosition.column);
        }
        if (decision.verdict === 'yes') {
            slot.edits.push(token.node.startPosition.column);
            // A binding renamed by aliasing its import (`import x as y`).
            if (decision.importAlias) (slot.importAliases ||= []).push(token.node.startPosition.column);
        }
        else if (decision.verdict === 'unknown') {
            slot.reviews.push({ column: token.node.startPosition.column, reason: decision.reason || 'unresolved' });
        } else {
            skipToken(resolver, slot, token.node.startPosition.column, decision.reason);
        }
    }
    for (const comment of docComments) decideDocCrefs(resolver, file, comment, lineOf(comment.startPosition.row));
    if (resolver.family === 'c' && !resolver.valueReferences) decideReplacementListCasts(resolver, file, lines);
    resolver.rememberLocalFile?.(file, lines, fileLocalOnly);
    return lines;
}

/** A token that names something else: counted, and why when asked. */
function skipToken(resolver, slot, column, reason) {
    slot.skips++;
    slot.skipColumns.push(column);
    if (resolver.collectRoles) (slot.skipReasons ||= new Map()).set(column, reason || 'other-declaration');
}

// Expressions whose head names the constructed type (fix #428): `S { .. }`
// (Rust struct expressions) and `S(..)` (tuple structs, functional casts).
const CONSTRUCTION_HEADS = new Map([
    ['struct_expression', 'name'], ['call_expression', 'function'],
]);
const HEAD_WRAPPERS = new Set(['scoped_type_identifier', 'scoped_identifier', 'generic_type', 'generic_function']);

/** Is this token the head of a construction expression? */
function constructionHead(node) {
    let current = node;
    for (let depth = 0; depth < 4 && current.parent; depth++) {
        const parent = current.parent;
        const field = CONSTRUCTION_HEADS.get(parent.type);
        if (field) return sameNode(parent.childForFieldName(field), current);
        if (!HEAD_WRAPPERS.has(parent.type)) return false;
        // A path's last segment names the type; a qualifier does not.
        const name = parent.childForFieldName('name') || parent.childForFieldName('type');
        if (name && !sameNode(name, current)) return false;
        current = parent;
    }
    return false;
}

/**
 * A cast spelled in a C/C++ replacement list (`#define D(t, p) t[(U16)(p)]`,
 * fix #427): the name is the type its file's lookup finds where the macro is
 * defined, so a line whose every occurrence of the name is such a cast to
 * the renamed type is an edit; any other replacement-list text stays a
 * review item.
 */
function decideReplacementListCasts(resolver, file, lines) {
    const { getCachedCalls, _recordIsNoCall } = require('./callers');
    let records = null;
    const fileLines = resolver.index._getFileLines(file);
    const word = new RegExp(`(?<![A-Za-z0-9_$])${resolver.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_$])`, 'g');
    for (const [line, slot] of lines) {
        if (!slot.macroBody || slot.tokens > 0 || slot.reviews.length > 0) continue;
        records ||= getCachedCalls(resolver.index, file) || [];
        const casts = records.filter(call => call.line === line && call.name === resolver.name &&
            call.parenthesizedCallee && call.inMacroBody && Number.isInteger(call.column));
        if (casts.length === 0) continue;
        const occurrences = (String(fileLines[line - 1] || '').match(word) || []).length;
        if (occurrences !== casts.length || !casts.every(call => _recordIsNoCall(resolver.index, file, call))) continue;
        if (resolver.resolveName(file, line)?.verdict !== 'yes') continue;
        slot.tokens += casts.length;
        slot.edits.push(...casts.map(call => call.column));
    }
}

/**
 * C# XML documentation `cref` attributes are references the compiler
 * resolves (CS1574 when documentation is generated): each spelling of the
 * name in a cref is decided like the code reference it stands for, in the
 * scope of the documented member.
 */
function decideDocCrefs(resolver, file, comment, slot) {
    if (comment.startPosition.row !== comment.endPosition.row) return;
    const text = comment.text;
    if (!/^\/\/\//.test(text)) return;
    const line = comment.startPosition.row + 1;
    const crefRe = /\bcref\s*=\s*"([^"]*)"/g;
    let match;
    let handled = false;
    while ((match = crefRe.exec(text)) !== null) {
        const value = match[1];
        const valueStart = match.index + match[0].indexOf('"') + 1;
        const idRe = /[A-Za-z_][A-Za-z0-9_]*/g;
        let id;
        const body = value.replace(/^[A-Z]:/, ch => ' '.repeat(ch.length));
        while ((id = idRe.exec(body)) !== null) {
            if (id[0] !== resolver.name) continue;
            // The dotted path written before the name, at the same level.
            let start = id.index;
            while (start > 1 && body[start - 1] === '.' && /[A-Za-z0-9_]/.test(body[start - 2])) {
                let s2 = start - 1;
                while (s2 > 0 && /[A-Za-z0-9_]/.test(body[s2 - 1])) s2--;
                start = s2;
            }
            const qualifier = body.slice(start, id.index).replace(/\.$/, '');
            resolver.siteNode = comment;
            resolver.siteFile = file;
            const verdict = qualifier
                ? resolver.resolveCSharpQualified(file, line, qualifier, { role: 'type' })
                : resolver.resolveName(file, line);
            resolver.siteNode = null;
            const column = comment.startPosition.column + valueStart + id.index;
            slot.tokens++;
            handled = true;
            if (verdict.verdict === 'yes') slot.edits.push(column);
            else if (verdict.verdict === 'unknown') slot.reviews.push({ column, reason: 'doc-cref' });
            else skipToken(resolver, slot, column, verdict.reason);
            if (resolver.collectRoles) (slot.roles ||= new Map()).set(column, 'doc-cref');
        }
    }
    if (handled) slot.stringAnnotation = true;
}

function shadowOf(token, bindings, space, family, pinScope = null) {
    let verdict = null;
    for (const binding of bindings) {
        if (sameNode(binding.node, token.node)) continue;
        if (!binding.scope || !contains(binding.scope, token.node)) continue;
        // Another binding of the pinned class's own variable (fix #424).
        if (pinScope && sameNode(binding.scope, pinScope)) continue;
        // Type positions are a separate namespace outside Python/JS values.
        if (space === 'type' && family !== 'python') continue;
        if (binding.role.patternBinding) return 'unknown';
        // A Python module-scope binding is the module variable itself, the
        // one its imports and class statements bind too (fix #393): the
        // module's name lookup decides, not the binding alone.
        if (family === 'python' && binding.scope.type === 'module') {
            verdict = verdict || 'module';
            continue;
        }
        const before = binding.node.startIndex < token.node.startIndex;
        if (family === 'python' && binding.scope.type === 'class_definition') {
            // A class attribute is visible in the class body only (never in
            // its methods), from its assignment on: `Entry = Entry` reads
            // the module's Entry.
            const method = ancestor(token.node, new Set(['function_definition', 'lambda']));
            if (method && contains(binding.scope, method)) continue;
            const statement = ancestor(binding.node, new Set(['expression_statement']));
            if (!before || (statement && contains(statement, token.node))) continue;
            return 'no';
        }
        if (before || family === 'python' || family === 'csharp') return 'no';
        verdict = 'unknown';
    }
    return verdict;
}

/** Does the literal parse break inside the declaration or statement
 * holding this token? */
function statementHasError(node) {
    for (let current = node.parent; current; current = current.parent) {
        if (current.type === 'ERROR') return true;
        if (/(declaration|definition|statement|specifier|_list|declarator)$/.test(current.type)) {
            if (current.hasError) return true;
            if (/(declaration|definition|statement)$/.test(current.type)) return false;
        }
    }
    return false;
}

/** The class path a qualified declarator's scope names, without its
 * leading namespace-looking segments: `ns::List<K>::Node::f` -> the scope
 * segments `List<K>::Node` (the last two at most). */
function qualifiedScopeText(qualified) {
    const scopes = [];
    let current = qualified;
    while (current?.type === 'qualified_identifier') {
        const scope = current.childForFieldName('scope');
        if (scope) scopes.push(textOf(scope));
        current = current.childForFieldName('name');
    }
    return scopes.length > 0 ? scopes.slice(-2).join('::') : null;
}

/** Does a persisted recovery blank fall inside the declaration or
 * statement holding this token? (`blanks`: sorted [start, end] ranges) */
function statementHoldsBlank(node, blanks) {
    let statement = null;
    for (let current = node.parent; current; current = current.parent) {
        if (/(declaration|definition|statement)$/.test(current.type)) { statement = current; break; }
    }
    if (!statement) return false;
    return rangeHoldsBlank(statement.startIndex, statement.endIndex, blanks);
}

function enclosingHeaderHoldsBlank(node, blanks) {
    for (let owner = node.parent; owner; owner = owner.parent) {
        const body = owner.childForFieldName('body');
        if (body && body.startIndex <= node.startIndex &&
            rangeHoldsBlank(owner.startIndex, body.startIndex, blanks)) return true;
    }
    return false;
}

function rangeHoldsBlank(start, end, blanks) {
    let lo = 0;
    let hi = blanks.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (blanks[mid][1] <= start) lo = mid + 1; else hi = mid;
    }
    return lo < blanks.length && blanks[lo][0] < end;
}

function hasErrorNeighbor(node) {
    for (let current = node, depth = 0; current && depth < 2; current = current.parent, depth++) {
        const parent = current.parent;
        if (!parent) break;
        for (let i = 0; i < parent.childCount; i++) {
            if (parent.child(i).type === 'ERROR') return true;
        }
    }
    return false;
}

/**
 * A token that is a whole argument of an invocation of a project
 * function-like macro whose replacement list also uses that parameter as a
 * member of another scope (`ExitCodes::name`): the argument names that
 * member too, so renaming it with the type breaks the expansion.
 */
function macroArgumentOtherUse(resolver, file, node) {
    if (resolver.family !== 'c') return null;
    // `M(Widget)` as a call, or read as a declarator `M(Widget)` whose
    // parameter list holds the argument (a class-body invocation).
    let argument = node;
    let list = node.parent;
    const lists = new Set(['argument_list', 'parameter_list', 'parenthesized_declarator']);
    for (let hops = 0; list && hops < 2 && !lists.has(list.type); hops++) {
        argument = list;
        list = list.parent;
    }
    if (!list || !lists.has(list.type)) return null;
    const owner = list.parent;
    const callee = owner?.type === 'call_expression' ? owner.childForFieldName('function')
        : owner?.type === 'function_declarator' ? owner.childForFieldName('declarator')
            // `M(Widget);` in a class body: type `M`, declarator `(Widget)`.
            : list.type === 'parenthesized_declarator' ? owner?.childForFieldName('type') : null;
    if (!callee || !/identifier$/.test(callee.type)) return null;
    const args = list.type === 'parenthesized_declarator' ? [argument]
        : (list.namedChildren || []).filter(child => !child.type.endsWith('comment'));
    const index = args.findIndex(arg => sameNode(arg, argument));
    if (index < 0 || argument.text !== node.text) return null;
    const { includeClosure } = lazyCppScopeModule();
    const visible = includeClosure(resolver.index, file);
    const macros = (resolver.index.symbols.get(callee.text) || []).filter(d => d.type === 'macro' &&
        d.functionLike && (d.file === file || visible.has(d.file)));
    const effects = macros.flatMap(d => (d.macroParamEffects || []).filter(e => e.paramIndex === index));
    const other = effects.find(e => e.kind === 'qualified' && e.qualifier !== resolver.name);
    return other ? { verdict: 'unknown', reason: 'macro-argument-other-use' } : null;
}

function decide(resolver, file, entry, token, bindings, typeParams) {
    const { node, role } = token;
    const line = node.startPosition.row + 1;
    const family = resolver.family;
    const macroUse = macroArgumentOtherUse(resolver, file, node);
    if (macroUse) return macroUse;
    switch (role.role) {
        case 'pin-binding':
            return { verdict: 'yes' };
        case 'dunder-all':
            // A Python `__all__` entry names the module's own binding of the
            // name: renamed exactly when that binding is the renamed type.
            return resolver.resolveName(file, line);
        case 'skip':
            // A declarator the grammar read next to a parse error may be
            // the type itself (`MACRO Widget value` with MACRO taken for
            // the type): unknown. The C/C++ recovery blanks such
            // declaration-specifier macros before the tokens are read.
            if (role.binding && hasErrorNeighbor(node)) {
                return { verdict: 'unknown', reason: 'parse-error' };
            }
            // A Python module-scope assignment rebinding a module variable
            // an import of the renamed type also binds (`except
            // ImportError: X = None`, fix #393) is part of that variable.
            if (family === 'python' && role.binding && (role.why === 'assignment' || role.why === 'variable') &&
                bindingScope(node, family, role)?.type === 'module' &&
                resolver.pythonModuleBindsPin(file, line)) {
                return { verdict: 'unknown', reason: 'module-rebinding' };
            }
            return { verdict: 'no', reason: role.why };
        case 'unknown':
            return { verdict: 'unknown', reason: role.why || 'unmodelled-position' };
        case 'template': return decideTemplateToken(resolver, file, token);
        case 'shorthand': {
            const verdict = resolveUnqualifiedToken(resolver, file, token, bindings, typeParams, 'value');
            return verdict.verdict === 'no' ? verdict : { verdict: 'unknown', reason: 'shorthand-property' };
        }
        case 'decl': return decideDecl(resolver, file, entry, token, bindings, typeParams);
        case 'ctor': {
            // A constructor or destructor repeats the name of the class that
            // declares it: its verdict is the verdict of that class's own
            // name token (fix #394).
            const classNode = role.classNode;
            let classNameNode = classNode?.childForFieldName('name');
            // `template <> struct Box<int>`, `struct Outer::Inner`: the
            // class name is the last plain segment.
            while (classNameNode && (classNameNode.type === 'template_type' ||
                classNameNode.type === 'qualified_identifier' || classNameNode.type === 'generic_name')) {
                classNameNode = classNameNode.childForFieldName('name') || classNameNode.namedChild(0);
            }
            if (!classNameNode || textOf(classNameNode) !== node.text) {
                // No enclosing class of that name (a member the parse left
                // outside its class): the owner is not known.
                return { verdict: 'unknown', reason: 'constructor-owner' };
            }
            return decideDecl(resolver, file, entry, { node: classNameNode, role: { role: 'decl', declNode: classNode } },
                bindings, typeParams);
        }
        case 'ctor-qualified': {
            // `Widget::Widget()` / `app::Widget::~Widget()`: the member names
            // the class its qualifier spells.
            const spelled = cppPrefix(node);
            if (spelled == null) return { verdict: 'unknown', reason: 'constructor-owner' };
            const { resolveQualifier, includeClosure } = lazyCppScopeModule();
            const site = resolver.cppSiteContext(file, line);
            // The qualifier may be an alias of the declaring class. Resolve
            // its type identity, rather than renaming the alias declaration.
            const owner = resolveQualifier(resolver.index, { file, line,
                namespace: site.namespace, className: site.className }, spelled,
            includeClosure(resolver.index, file));
            if (owner.kind !== 'type') return { verdict: 'unknown', reason: 'constructor-owner' };
            const verdict = resolver.judge(owner.classes);
            return verdict.verdict === 'yes' && !owner.visible
                ? { verdict: 'unknown', reason: 'not-in-include-closure' } : verdict;
        }
        case 'meminit': {
            // A member named like the type is initialized as a member.
            const owner = resolver.enclosingClassAt(file, line);
            const members = (resolver.index.symbols.get(resolver.name) || []).some(d =>
                d.file && d.className === owner && (d.type === 'field' || d.memberType === 'field'));
            if (members) return { verdict: 'no', reason: 'member' };
            return resolveUnqualifiedToken(resolver, file, token, bindings, typeParams, 'type');
        }
        case 'import': return decideImport(resolver, file, entry, token);
        case 'qualified-creation': {
            // Only a member class is created through an outer instance.
            const members = resolver.all.filter(d => d.name === resolver.name && d.enclosingType);
            if (members.length === 0) return { verdict: 'no', reason: 'not-member-type' };
            const outerType = javaExpressionTypeName(role.outer);
            const owner = outerType ? resolver.resolveTypeNamed(file, line, outerType) : 'unknown';
            if (owner === 'owner') return { verdict: 'yes' };
            // Another outer type may inherit the member class; only one that
            // declares its own member class of the name settles it.
            if (owner === 'other' && members.some(d => !resolver.inGroup(d) && d.enclosingType === outerType)) {
                return { verdict: 'no', reason: 'other-type' };
            }
            return { verdict: 'unknown', reason: 'qualified-creation' };
        }
        case 'member':
            return decideMember(resolver, file, token, bindings);
        case 'gofield':
            return resolver.goFieldVerdict(node, file);
        case 'macro': return decideMacroToken(resolver, file, token, bindings, typeParams);
        case 'type': case 'value': {
            if (role.qualifierSegment) return decideQualifierSegment(resolver, file, token, bindings, typeParams);
            if (role.cppQualified) {
                const prefix = cppPrefix(node);
                if (prefix) return resolver.resolveCFamily(file, line, resolver.name, prefix);
            }
            if (role.qualifier) {
                return resolver.resolveQualified(file, line, role.qualifier,
                    role.aliasQualified ? textOf(role.qualifier) + '::' : null, { role: role.role });
            }
            if (role.aliasQualified) return { verdict: 'unknown', reason: 'extern-alias' };
            if (role.elaborated && family === 'c') {
                return resolver.resolveCFamily(file, line, resolver.name, null, { tag: role.tag });
            }
            return resolveUnqualifiedToken(resolver, file, token, bindings, typeParams, role.role);
        }
        default:
            return { verdict: 'unknown', reason: 'unmodelled-position' };
    }
}

const MEMBER_SHADOW_FAMILIES = new Set(['java', 'csharp', 'c']);
const CLASS_BODY_OWNERS = new Set(['class_declaration', 'struct_declaration', 'record_declaration',
    'interface_declaration', 'enum_declaration', 'record_struct_declaration', 'class_specifier',
    'struct_specifier', 'union_specifier']);
const VALUE_MEMBER_KINDS = new Set(['field', 'property', 'event', 'constant', 'state']);

/**
 * A field, property or event of the enclosing class named like the type
 * hides the type in an expression (Java obscuring, C# and C++ member
 * lookup): `Alignment = value;` in a class with an `Alignment` property.
 * When the member's own type is the renamed type, `Alignment.X` may still
 * denote the type (C# "Color Color"): review. Null when no member hides it.
 */
function memberShadowOf(resolver, file, node) {
    if (!MEMBER_SHADOW_FAMILIES.has(resolver.family)) return null;
    const owners = [];
    for (let current = node.parent; current; current = current.parent) {
        if (!CLASS_BODY_OWNERS.has(current.type)) continue;
        const nameNode = current.childForFieldName('name');
        if (nameNode) owners.push(textOf(nameNode));
    }
    if (owners.length === 0) {
        // Out-of-line C++ member definitions name their class.
        const site = resolver.family === 'c' ? resolver.cppSiteContext(file, node.startPosition.row + 1) : null;
        if (site?.className) owners.push(site.className.split('::').pop());
    }
    if (owners.length === 0) return null;
    // An invoked simple name (`LogEvent(ts, level)`) is looked up among the
    // members of the enclosing classes first: a method of that name (C#
    // `static LogEvent LogEvent(..)`, a C++ member function) hides the
    // type there (fix #393). A constructor is the class's own name.
    const invokedName = langTraits(resolver.index.files.get(file)?.language)?.isInvokedName;
    const invokedAt = invokedName ? invokedName(node, { unqualified: true }) : node.parent &&
        ((node.parent.type === 'invocation_expression' || node.parent.type === 'call_expression') &&
            isField(node, 'function'));
    if (invokedAt) {
        const scopeNames = new Set(owners);
        let level = [...owners];
        for (let hop = 0; hop < 8 && level.length > 0; hop++) {
            level = [...new Set(level.flatMap(owner => resolver.index._getInheritanceParents?.(owner, file) || []))]
                .filter(owner => owner && !scopeNames.has(owner));
            for (const owner of level) scopeNames.add(owner);
        }
        const methods = (resolver.index.symbols.get(resolver.name) || []).filter(d =>
            scopeNames.has(d.className) && d.className !== resolver.name && !d.isConstructor &&
            (d.type === 'method' || d.memberType === 'method') &&
            familyOf(resolver.index.files.get(d.file)?.language) === resolver.family);
        if (methods.length > 0) return { verdict: 'no', reason: 'member' };
    }
    const members = (resolver.index.symbols.get(resolver.name) || []).filter(d =>
        owners.includes(d.className) && (VALUE_MEMBER_KINDS.has(d.type) || VALUE_MEMBER_KINDS.has(d.memberType)) &&
        familyOf(resolver.index.files.get(d.file)?.language) === resolver.family);
    if (members.length === 0) return null;
    const accessed = node.parent && ((node.parent.type === 'member_access_expression' &&
        isField(node, 'expression')) || (node.parent.type === 'field_access' && isField(node, 'object')) ||
        (node.parent.type === 'method_invocation' && isField(node, 'object')));
    const typedAsPin = members.some(d => String(d.fieldType || d.returnType || '').replace(/[?*&\s]/g, '')
        .replace(/<.*$/, '').split(/[.:]/).pop() === resolver.name);
    if (accessed && typedAsPin) return { verdict: 'unknown', reason: 'member-named-like-type' };
    return { verdict: 'no', reason: 'member' };
}

function resolveUnqualifiedToken(resolver, file, token, bindings, typeParams, space) {
    const family = resolver.family;
    if (space === 'value' || family === 'python' || family === 'js') {
        const shadow = shadowOf(token, bindings, space, family,
            file === resolver.def.file ? resolver.pythonPinScope(token.node.tree) : null);
        if (shadow === 'no') return { verdict: 'no', reason: 'local-binding' };
        if (shadow === 'unknown') return { verdict: 'unknown', reason: 'local-binding' };
        if (shadow === 'module') {
            // The module variable holds the renamed type only when an
            // import or class statement of this module binds it too; the
            // assignments alone name another value.
            if (!resolver.pythonModuleBindsPin(file, token.node.startPosition.row + 1)) {
                return { verdict: 'no', reason: 'local-binding' };
            }
            return { verdict: 'unknown', reason: 'module-rebinding' };
        }
    }
    // C and C++ name lookup finds a variable or parameter declared before
    // the name in an enclosing block before any type (C: one ordinary
    // namespace; C++: the variable hides the class or alias): `ctx(out,
    // vargs)` after `auto& vargs = ..` passes the variable (fix #427).
    if (space === 'type' && family === 'c' && bindings.some(binding =>
        ['variable', 'parameter'].includes(binding.role.why) && !sameNode(binding.node, token.node) &&
        binding.scope && binding.scope.type !== 'translation_unit' && contains(binding.scope, token.node) &&
        binding.node.startIndex < token.node.startIndex)) {
        return { verdict: 'no', reason: 'local-binding' };
    }
    if (space === 'value') {
        const member = memberShadowOf(resolver, file, token.node);
        if (member) return member;
    }
    if (typeParams.some(p => p.scope && contains(p.scope, token.node) && !sameNode(p.node, token.node))) {
        return { verdict: 'no', reason: 'type-parameter' };
    }
    const line = token.node.startPosition.row + 1;
    if (family === 'c' && resolver.index.files.get(file)?.language === 'c' && resolver.pinIsTag()) {
        // Plain identifiers name typedefs and objects in C, never tags.
        return { verdict: 'no', reason: 'ordinary-namespace' };
    }
    return resolver.resolveName(file, line);
}

// A C declaration whose name lives in the ordinary identifier namespace: a
// typedef, or an anonymous struct/union/enum named by its typedef
// (`typedef struct { .. } T;` declares no tag, fix #396).
function cOrdinaryName(d) {
    return d.type === 'type' || !!d.typedefName;
}

function declVerdict(resolver, file, declNode, role = {}, nameLine = null) {
    const endLine = declNode.endPosition.row + 1;
    const startLine = declNode.startPosition.row + 1;
    const kindOk = d => (!role.typedef || cOrdinaryName(d)) && (!role.tag || !cOrdinaryName(d));
    // A definition that records the line of its name (grouped Go specs,
    // annotated or decorated declarations) is matched there first.
    const named = nameLine != null ? resolver.fileTypes(file).filter(d => d.nameLine === nameLine && kindOk(d)) : [];
    if (named.length > 0) return resolver.judge(named);
    const exact = resolver.fileTypes(file).filter(d => d.nameLine == null && kindOk(d) &&
        d.startLine === startLine && d.endLine === endLine);
    if (exact.length > 0) return resolver.judge(exact);
    const defs = resolver.fileTypes(file).filter(d => d.nameLine == null && (d.endLine === endLine ||
        (d.startLine <= startLine + 1 && d.startLine >= startLine - 3 &&
            d.endLine >= endLine - 1 && d.endLine <= endLine + 1)) &&
        // A C typedef name and a struct tag of one spelling are two entities.
        (!role.typedef || cOrdinaryName(d)) && (!role.tag || !cOrdinaryName(d)));
    if (defs.length === 0) return null;
    return resolver.judge(defs);
}

function decideDecl(resolver, file, entry, token, bindings, typeParams) {
    const verdict = declVerdict(resolver, file, token.role.declNode, token.role,
        token.node.startPosition.row + 1);
    if (verdict) {
        // The pin's own name token is the definition edit plan makes itself.
        return verdict;
    }
    // A declaration UCN did not index (forward declaration, ambient or
    // generated declaration): resolve it as a reference.
    const line = token.node.startPosition.row + 1;
    // A typedef name is its own declaration (`typedef struct W W;`), never
    // the struct tag it aliases.
    if (resolver.family === 'c' && token.role.typedef && resolver.pinIsTag()) {
        return { verdict: 'no', reason: 'typedef-name' };
    }
    if (resolver.family === 'c') {
        return resolver.resolveCFamily(file, line, resolver.name, null,
            token.role.tag ? { tag: token.role.tag } : {});
    }
    return { verdict: 'unknown', reason: 'unindexed-declaration' };
}

function decideImport(resolver, file, entry, token) {
    const { node, role } = token;
    const line = node.startPosition.row + 1;
    const name = resolver.name;
    switch (resolver.family) {
        case 'js': {
            const statement = ancestor(node, new Set(['import_statement', 'export_statement']));
            const source = statement?.childForFieldName('source');
            const module = role.requireSource || (source ? source.text.replace(/^['"`]|['"`]$/g, '') : null);
            if (!module) return { verdict: 'unknown', reason: 'import-source' };
            return resolver.importBindingVerdict(file, entry, { name, module, kind: 'named' }, name);
        }
        case 'python': {
            const module = role.moduleText;
            if (!module) return { verdict: 'unknown', reason: 'import-source' };
            const moduleFile = resolver.moduleFile(entry, module);
            if (!moduleFile) {
                const binding = (entry.importBindings || []).find(b => b.name === name && b.line === line) ||
                    { name, module, kind: 'from' };
                return resolver.importBindingVerdict(file, entry, { ...binding, alias: undefined }, name);
            }
            const reach = resolver.chase(moduleFile, name);
            return reach === 'yes' ? { verdict: 'yes' } : reach === 'no' ? { verdict: 'no', reason: 'other-module' }
                : { verdict: 'unknown', reason: 'import-chain' };
        }
        case 'rust': {
            if (role.useHead) return { verdict: 'unknown', reason: 'use-path-head' };
            const qualifier = rustUsePrefix(role.original || node);
            if (qualifier == null) return { verdict: 'unknown', reason: 'use-path' };
            if (!qualifier) return { verdict: 'unknown', reason: 'use-path-head' };
            return resolver.resolveRustPath(file, line, qualifier, name, 0);
        }
        case 'java':
            return resolver.resolveJavaQualified(file, line, role.qualifierText, { role: 'type' });
        default:
            return { verdict: 'unknown', reason: 'import' };
    }
}

/**
 * The module path a `use` tree puts before a token: `crate::widget` for the
 * `Widget` of `use crate::{widget::{self, Widget as W}}`. Null when the
 * token is not the last segment of a use path.
 */
function rustUsePrefix(node) {
    const parts = [];
    let current = node;
    if (current.parent?.type === 'scoped_identifier') {
        if (!isField(current, 'name')) return null;
        const path = current.parent.childForFieldName('path');
        if (path) parts.unshift(textOf(path));
        current = current.parent;
    }
    for (let a = current.parent; a && a.type !== 'use_declaration'; a = a.parent) {
        if (a.type === 'scoped_use_list') {
            const path = a.childForFieldName('path');
            if (path && !contains(path, node)) parts.unshift(textOf(path));
            else if (path) return null;
        }
    }
    return parts.join('::');
}

function decideMember(resolver, file, token, bindings) {
    const { node, role } = token;
    const receiver = role.receiver;
    const line = node.startPosition.row + 1;
    if (!receiver) return { verdict: 'unknown', reason: 'member' };
    const family = resolver.family;
    // Receivers that are values: never a namespace for the type name. The
    // keyword receivers (`this`, `super`, C# `base`, Rust `self`) are node
    // types of their own; an identifier spelled like one is an ordinary
    // name (`from . import base` then `base.Message`, a Go package `base`).
    // Python's `self`/`cls` parameters are values by convention.
    const valueReceiver = (family === 'python' && /^(self|cls)$/.test(receiver.text)) ||
        !/^(identifier|scoped_identifier|field_access|attribute|member_expression|package_identifier|member_access_expression|qualified_name|generic_name|scoped_type_identifier|type_identifier)$/.test(receiver.type);
    if (valueReceiver) {
        if (family === 'python' && /^(self|cls)$/.test(receiver.text)) {
            // `self.Inner` inside the class that nests Inner names it.
            const owners = [...resolver.group].map(d => resolver.containerOf(d))
                .filter(owner => owner && TYPE_DECL_KINDS.has(owner.type));
            if (owners.length > 0) {
                const inside = owners.some(owner => owner.file === file && owner.startLine <= line && owner.endLine >= line);
                return inside ? { verdict: 'yes' } : { verdict: 'unknown', reason: 'nested-type' };
            }
        }
        return family === 'go' ? resolver.goFieldVerdict(node, file) : { verdict: 'no', reason: 'member' };
    }
    const verdict = resolver.resolveQualified(file, line, receiver, null, { role: 'member' });
    if (family === 'go' && verdict.verdict === 'unknown' && verdict.reason === 'qualified-name') {
        return resolver.goFieldVerdict(node, file);
    }
    return verdict;
}

function decideQualifierSegment(resolver, file, token, bindings, typeParams) {
    // C++: `Widget::f` / `app::Widget::f`: the segment's own qualifier is
    // the scope of the enclosing qualified_identifier chain.
    const { node } = token;
    const line = node.startPosition.row + 1;
    const prefix = cppPrefix(node, true);
    if (prefix) return resolver.resolveCFamily(file, line, resolver.name, prefix);
    if (typeParams.some(p => p.scope && contains(p.scope, node) && !sameNode(p.node, node))) {
        return { verdict: 'no', reason: 'type-parameter' };
    }
    return resolver.resolveCFamily(file, line, resolver.name, null);
}

/**
 * The qualifier written before a C++ name token, e.g. `app` for the
 * `Widget` of `app::Widget::make()` (`asScope`: the token is itself a
 * scope segment), or the full spelling up to and including the token's
 * class for a constructor name `app::Widget::Widget` (default). Null when
 * the token is not inside a qualified name.
 */
function cppPrefix(node, asScope = false) {
    let wrapped = node;
    if ((wrapped.parent?.type === 'template_type' || wrapped.parent?.type === 'template_function') &&
        isField(wrapped, 'name')) wrapped = wrapped.parent;
    if (wrapped.parent?.type === 'destructor_name') wrapped = wrapped.parent;
    let qualified = wrapped.parent;
    if (qualified?.type !== 'qualified_identifier') return null;
    const parts = [];
    if (isField(wrapped, 'name')) {
        const scope = qualified.childForFieldName('scope');
        parts.unshift(textOf(scope));
    } else if (!isField(wrapped, 'scope')) {
        return null;
    }
    while (qualified.parent?.type === 'qualified_identifier' && isField(qualified, 'name')) {
        qualified = qualified.parent;
        parts.unshift(textOf(qualified.childForFieldName('scope')));
    }
    const spelled = parts.filter(Boolean).join('::');
    if (asScope) return spelled || null;
    return spelled || null;
}

/**
 * The path written before a token inside a Rust token tree
 * (`crate::a::Widget`, `$crate::m::Widget`, `::core::x::Widget`): '' when
 * the token has no qualifier, null when the tokens before it do not form
 * a plain path (generic arguments, expressions).
 */
function tokenTreePath(node) {
    const segments = [];
    let previous = node.previousSibling;
    while (previous && previous.type === '::') {
        const segment = previous.previousSibling;
        if (segment && (segment.type === 'identifier' || segment.type === 'crate' ||
            segment.type === 'self' || segment.type === 'super' ||
            (segment.type === 'metavariable' && segment.text === '$crate'))) {
            segments.unshift(segment.text);
            previous = segment.previousSibling;
            continue;
        }
        if (segment && (segment.text === '>' || segment.type === 'metavariable')) return null;
        segments.unshift('');
        break;
    }
    if (segments.length === 0 && node.parent?.type === 'token_tree' &&
        node.parent.child(0)?.text === '{' && node.parent.previousSibling?.type === '::') {
        // `a::b::{Widget, Other}`: the braced group's own path.
        const prior = node.previousSibling;
        if (prior && prior.type !== ',' && prior.text !== '{') return null;
        return tokenTreePath(node.parent);
    }
    return segments.join('::');
}

function decideTemplateToken(resolver, file, token) {
    // A macro_rules! body binds its paths where the macro expands; `$crate`
    // always names the defining crate.
    const { node } = token;
    const line = node.startPosition.row + 1;
    const next = node.nextSibling;
    if (next?.type === '!') return { verdict: 'no', reason: 'macro-name' };
    const previous = node.previousSibling;
    if (previous && previous.type === '.') return { verdict: 'no', reason: 'member' };
    const qualifier = tokenTreePath(node);
    if (qualifier === '') {
        // A bare name binds where the macro expands: decide it at every
        // project invocation of the macro.
        const definition = ancestor(node, new Set(['macro_definition']));
        const macroName = definition?.childForFieldName('name')?.text;
        const sites = macroName ? resolver.rustMacroInvocations(macroName) : [];
        if (sites.length === 0) return { verdict: 'unknown', reason: 'macro-template' };
        const verdicts = sites.map(site => resolver.resolveRustName(site.file, site.line, resolver.name));
        const combined = resolver.combine(verdicts);
        return combined.verdict === 'unknown' ? { verdict: 'unknown', reason: 'macro-template' } : combined;
    }
    if (qualifier == null) return { verdict: 'unknown', reason: 'macro-template' };
    const crateRooted = qualifier.startsWith('$crate') || qualifier.startsWith('crate') || qualifier.startsWith('::');
    const verdict = resolver.resolveRustPath(file, line, qualifier.replace(/^\$crate/, 'crate'), resolver.name, 0);
    if (verdict.verdict === 'no' || crateRooted) return verdict;
    return { verdict: 'unknown', reason: 'macro-template' };
}

function decideMacroToken(resolver, file, token, bindings, typeParams) {
    const { node } = token;
    const previous = node.previousSibling;
    const next = node.nextSibling;
    if (next?.type === '!') return { verdict: 'no', reason: 'macro-name' };
    if (previous && (previous.type === '.' || previous.text === '.')) return { verdict: 'no', reason: 'member' };
    if (previous && (previous.type === '::' || previous.text === '::')) {
        const qualifier = tokenTreePath(node);
        if (qualifier == null) return { verdict: 'unknown', reason: 'macro-path' };
        return resolver.resolveRustPath(file, node.startPosition.row + 1, qualifier, resolver.name, 0);
    }
    if (next && next.text === ':' ) return { verdict: 'unknown', reason: 'macro-argument' };
    if (bindings.some(b => b.scope && contains(b.scope, node))) {
        return { verdict: 'unknown', reason: 'local-binding' };
    }
    const verdict = resolveUnqualifiedToken(resolver, file, token, bindings, typeParams, 'value');
    return verdict;
}

// Generic types of `typing` / the builtins whose subscript arguments are
// type expressions (string arguments are forward references).
const PY_TYPING_MODULES = new Set(['typing', 'typing_extensions', 'collections.abc']);
const PY_BUILTIN_GENERICS = new Set(['list', 'dict', 'tuple', 'set', 'frozenset', 'type']);

/** Is this Python string a type expression (a forward reference)? In an
 * annotation, a subscript argument of a typing generic (`Union["Leaf"]`),
 * a TypeVar `bound=`, or the type argument of `cast`. */
function pythonTypeExpressionString(node, entry) {
    if (ancestor(node, PY_ANNOTATION, PY_ANNOTATION_STOP)) return true;
    const string = node.parent?.type === 'string' ? node.parent : null;
    if (!string) return false;
    const typingName = (value) => {
        if (!value) return false;
        if (value.type === 'attribute') {
            const object = value.childForFieldName('object');
            return !!object && (entry.importBindings || []).some(b => b.kind === 'import' &&
                (b.alias || b.name) === object.text && PY_TYPING_MODULES.has(String(b.module)));
        }
        if (value.type !== 'identifier') return false;
        if (PY_BUILTIN_GENERICS.has(value.text)) return true;
        return (entry.importBindings || []).some(b => (b.alias || b.name) === value.text &&
            PY_TYPING_MODULES.has(String(b.module)));
    };
    for (let current = string, parent = string.parent; parent; current = parent, parent = parent.parent) {
        if (parent.type === 'subscript') {
            return !sameNode(parent.childForFieldName('value'), current) &&
                typingName(parent.childForFieldName('value'));
        }
        if (parent.type === 'assignment') {
            // `X: TypeAlias = "A | B"` (PEP 613, fix #393): the value of an
            // explicit type alias is a type expression.
            if (!sameNode(parent.childForFieldName('right'), current)) return false;
            let annotation = parent.childForFieldName('type');
            if (annotation?.type === 'type') annotation = annotation.namedChild(0);
            if (!annotation) return false;
            const aliasName = annotation.type === 'attribute'
                ? annotation.childForFieldName('attribute')?.text : annotation.text;
            return aliasName === 'TypeAlias' && typingName(annotation);
        }
        if (parent.type === 'keyword_argument') {
            const call = parent.parent?.parent;
            return parent.childForFieldName('name')?.text === 'bound' && call?.type === 'call' &&
                typingName(call.childForFieldName('function'));
        }
        if (parent.type === 'argument_list') {
            const call = parent.parent;
            return call?.type === 'call' && sameNode(parent.namedChild(0), current) &&
                /(^|\.)cast$/.test(call.childForFieldName('function')?.text || '') &&
                typingName(call.childForFieldName('function'));
        }
        if (!['tuple', 'expression_list', 'list', 'binary_operator', 'parenthesized_expression'].includes(parent.type)) {
            return false;
        }
    }
    return false;
}

/** Is this Python string content an entry of the module's `__all__`
 * (`__all__ = ('A', 'B')`, `__all__ += ['C']`) spelling exactly `name`? */
function pythonDunderAllEntry(node, name) {
    const string = node.parent?.type === 'string' ? node.parent : null;
    if (!string || node.text !== name || string.namedChildCount !== 3) return false;
    for (let current = string, parent = string.parent; parent; current = parent, parent = parent.parent) {
        if (parent.type === 'assignment' || parent.type === 'augmented_assignment') {
            if (!sameNode(parent.childForFieldName('right'), current) ||
                parent.childForFieldName('left')?.text !== '__all__') return false;
            // Module scope only: a function's or class's `__all__` is a local.
            return !ancestor(parent, new Set(['function_definition', 'class_definition', 'lambda']));
        }
        if (!['tuple', 'list', 'parenthesized_expression', 'binary_operator', 'expression_list'].includes(parent.type)) {
            return false;
        }
    }
    return false;
}

function decideStringAnnotation(resolver, file, entry, node, slot) {
    // `"Widget"` / `"Widget | None"` forward references (Python): the
    // string's content is an expression evaluated in the module's scope.
    const annotation = pythonTypeExpressionString(node, entry);
    const re = new RegExp(`(^|[^A-Za-z0-9_.])(${resolver.name})(?![A-Za-z0-9_])`, 'g');
    const text = node.text;
    let match;
    const columns = [];
    while ((match = re.exec(text)) !== null) {
        columns.push(match.index + match[1].length);
    }
    if (columns.length === 0) return;
    slot.tokens += columns.length;
    const singleLine = node.startPosition.row === node.endPosition.row;
    if (!annotation || !singleLine) {
        for (const offset of columns) {
            slot.reviews.push({ column: node.startPosition.column + offset,
                reason: 'string-reference' });
        }
        return;
    }
    const line = node.startPosition.row + 1;
    const verdict = resolver.resolveName(file, line);
    for (const offset of columns) {
        const column = node.startPosition.column + offset;
        if (verdict.verdict === 'yes') slot.edits.push(column);
        else if (verdict.verdict === 'unknown') slot.reviews.push({ column, reason: verdict.reason || 'string-annotation' });
        else skipToken(resolver, slot, column, verdict.reason);
        if (resolver.collectRoles) (slot.roles ||= new Map()).set(column, 'string-annotation');
    }
    slot.stringAnnotation = true;
}

/**
 * C# applies an attribute class `XAttribute` as `[X]`: the short spelling
 * is outside the name's own ground lines. Each `[X]` attribute whose
 * lookup reaches the renamed class is an edit of the short token.
 * @returns {Array<{file, relativePath, line, column, verdict, reason}>}
 */
function csharpAttributeShortSites(index, def, name) {
    const suffix = 'Attribute';
    if (index.files.get(def.file)?.language !== 'csharp' || !name.endsWith(suffix) ||
        name.length <= suffix.length) return [];
    const short = name.slice(0, -suffix.length);
    const { computeGroundSet } = require('./account');
    const ground = computeGroundSet(index, short);
    const resolver = new TypeReferenceResolver(index, def, name);
    const out = [];
    for (const [file, lineNumbers] of [...ground.perFile].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
        const entry = index.files.get(file);
        if (entry?.language !== 'csharp') continue;
        let content;
        try { content = index._readFile(file); } catch { continue; }
        const tree = index._getParsedTree?.(file, content, 'csharp') || safeParse(getParser('csharp'), content);
        if (!tree) continue;
        const rows = new Set(lineNumbers.map(n => n - 1));
        const stack = [tree.rootNode];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node.endPosition.row < Math.min(...rows) || node.startPosition.row > Math.max(...rows)) continue;
            if (node.type === 'attribute') {
                let nameNode = node.childForFieldName('name');
                if (nameNode?.type === 'qualified_name') nameNode = nameNode.childForFieldName('name');
                if (nameNode?.text === short && rows.has(nameNode.startPosition.row)) {
                    const line = nameNode.startPosition.row + 1;
                    resolver.siteNode = nameNode;
                    resolver.siteFile = file;
                    const qualifier = node.childForFieldName('name')?.type === 'qualified_name'
                        ? node.childForFieldName('name').childForFieldName('qualifier') : null;
                    const verdict = qualifier
                        ? resolver.resolveCSharpQualified(file, line, textOf(qualifier), { role: 'type' })
                        : resolver.resolveName(file, line, name);
                    resolver.siteNode = null;
                    out.push({ file, relativePath: entry.relativePath, line, column: nameNode.startPosition.column,
                        verdict: verdict.verdict, reason: verdict.reason });
                }
                continue;
            }
            for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push(node.namedChild(i));
        }
    }
    return out;
}

module.exports = {
    cppSiteContextOf,
    csharpAttributeShortSites,
    TYPE_RENAME_KINDS,
    isTypeRenamePin,
    referenceRole: classify,
    referenceBindingScope: (node, language, role) => bindingScope(node, familyOf(language), role),
    referenceTypeParameterScope: typeParamScope,
    referenceImportVerdict: decideImport,
    typeReferenceSites,
    TypeReferenceResolver,
    familyOf,
};
