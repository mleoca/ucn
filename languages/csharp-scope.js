'use strict';

// C# lexical binding facts shared by member reference lookups.
const { sameNode } = require('./utils');

// Declarations whose `name` field binds a local of the member body.
const CSHARP_LOCAL_DECLARATION_NODES = new Set(['parameter', 'catch_declaration', 'declaration_pattern',
    'declaration_expression', 'variable_declarator', 'local_function_statement', 'from_clause',
    'join_clause', 'query_continuation', 'recursive_pattern', 'var_pattern']);

// A switch expression arm scopes its pattern variables; a while
// condition's variables are scoped to the statement (fix #419).
const CSHARP_BLOCK_SCOPES = new Set(['block', 'switch_section', 'for_statement', 'using_statement',
    'fixed_statement', 'lambda_expression', 'anonymous_method_expression', 'arrow_expression_clause',
    'switch_expression_arm', 'while_statement']);

/**
 * The outermost node of a deconstruction designation holding `node`
 * (fix #419): `var (a, (b, c))` in a declarator, foreach or pattern. The
 * grammar reads `x is var (a, b)` as an invocation of `x is var`, whose
 * arguments are then the designations. Null when `node` is no such name.
 */
function deconstructionRoot(node) {
    let current = node, root = null;
    while (current.parent && (current.parent.type === 'tuple_pattern' ||
        current.parent.type === 'parenthesized_variable_designation')) {
        current = current.parent;
        root = current;
    }
    if (root) return root;
    // `x is var (a, (b, c))`: argument / tuple_expression nesting under the
    // misread invocation's argument list.
    current = node;
    while (current.parent?.type === 'argument' && current.type !== 'argument' &&
        (current.type === 'identifier' || current.type === 'tuple_expression')) {
        const argument = current.parent, list = argument.parent;
        if (list?.type === 'tuple_expression') { current = list; continue; }
        const call = list?.type === 'argument_list' ? list.parent : null;
        const callee = call?.type === 'invocation_expression' ? call.childForFieldName('function') : null;
        if (callee?.type === 'is_expression' && callee.namedChildren.at(-1)?.type === 'implicit_type' &&
            sameNode(call.childForFieldName('arguments'), list)) return call;
        return null;
    }
    return null;
}

/**
 * Where C# scopes a local named like the reference (spec 7.6.1): 'local' when
 * a parameter, local variable, local function, pattern, lambda, foreach,
 * catch or range variable of that name is in scope at `node`, 'none' when
 * no declaration of the member reaches it, 'unknown' for an unmodelled
 * declaration shape.
 */
const localBindingsByTree = new WeakMap();
function bindingVerdict(facts, node) {
    const contains = scope => scope && (scope.ranges ? scope.ranges.some(contains)
        : scope.startIndex <= node.startIndex && node.endIndex <= scope.endIndex);
    let unknown = false;
    for (const fact of facts) {
        if (sameNode(fact.node, node)) continue;
        if (!fact.scope) unknown = true;
        else if (contains(fact.scope)) return 'local';
    }
    return unknown ? 'unknown' : 'none';
}

function csharpLocalBinding(memberNode, node, name) {
    let bindings = localBindingsByTree.get(memberNode.tree);
    if (!bindings) {
        bindings = new (require('../core/source-memo').BoundedMap)({ maxEntries: 512 });
        localBindingsByTree.set(memberNode.tree, bindings);
    }
    const cacheKey = `${memberNode.id}\0${name}`;
    if (bindings.has(cacheKey)) return bindingVerdict(bindings.get(cacheKey), node);
    const contains = (scope, target) => scope && (scope.ranges
        ? scope.ranges.some(range => contains(range, target))
        : scope.startIndex <= target.startIndex && target.endIndex <= scope.endIndex);
    const nearest = (from, kinds) => {
        for (let current = from.parent; current && !sameNode(current, memberNode); current = current.parent) {
            if (kinds.has(current.type)) return current;
        }
        return memberNode;
    };
    const facts = [];
    const snapshot = scope => !scope ? null : scope.ranges
        ? { ranges: scope.ranges.map(snapshot) }
        : { startIndex: scope.startIndex, endIndex: scope.endIndex };
    const queryRange = (from, start, end = null) => {
        const query = nearest(from, new Set(['query_expression']));
        const continuation = query.children?.find(child => child.type === 'into' && child.startIndex > start);
        return { startIndex: start, endIndex: end ?? continuation?.startIndex ?? query.endIndex };
    };
    const scopeOf = (declared) => {
        const parent = declared.parent;
        switch (parent.type) {
            case 'parameter': {
                const owner = parent.parent?.parent;
                return owner || memberNode;
            }
            case 'variable_declarator': case 'local_function_statement':
            case 'declaration_pattern': case 'declaration_expression': case 'single_variable_designation':
            case 'recursive_pattern': case 'var_pattern':
                return nearest(parent, CSHARP_BLOCK_SCOPES);
            case 'catch_declaration':
                return parent.parent;
            case 'foreach_statement':
                return parent.childForFieldName('body');
            case 'tuple_pattern': case 'parenthesized_variable_designation': case 'argument': {
                // A deconstruction: the foreach body for its iteration
                // variables, else the scope of the declaration or pattern
                // that holds it (fix #419).
                const root = deconstructionRoot(declared);
                if (!root) return null;
                const owner = root.parent;
                if (owner?.type === 'foreach_statement' && contains(owner.childForFieldName('left'), declared)) {
                    return owner.childForFieldName('body');
                }
                return nearest(root, CSHARP_BLOCK_SCOPES);
            }
            case 'from_clause': case 'let_clause': case 'query_continuation':
                return queryRange(parent, parent.endIndex);
            case 'query_expression':
                return queryRange(declared, declared.endIndex);
            case 'join_into_clause':
                return queryRange(parent, parent.parent.endIndex);
            case 'join_clause': {
                const equals = parent.children.find(child => child.type === 'equals');
                const key = equals && parent.namedChildren.find(child => child.startIndex >= equals.endIndex);
                const ranges = key ? [{ startIndex: key.startIndex, endIndex: key.endIndex }] : [];
                if (!parent.namedChildren.some(child => child.type === 'join_into_clause')) {
                    ranges.push(queryRange(parent, parent.endIndex));
                }
                return { ranges };
            }
            default:
                return null;
        }
    };
    const visit = current => {
        if (TYPE_SCOPES.has(current.type)) return;
        if ((current.type === 'implicit_parameter' || current.type === 'identifier') && current.text === name) {
            const parent = current.parent;
            let declares = current.type === 'implicit_parameter';
            if (!declares && parent) {
                declares = (CSHARP_LOCAL_DECLARATION_NODES.has(parent.type) &&
                    sameNode(parent.childForFieldName('name'), current) && !sameNode(parent, memberNode)) ||
                    (parent.type === 'foreach_statement' && sameNode(parent.childForFieldName('left'), current)) ||
                    parent.type === 'single_variable_designation' ||
                    (parent.type === 'let_clause' && sameNode(parent.namedChild(0), current)) ||
                    rangeBindingToken(current) || !!deconstructionRoot(current);
            }
            if (declares) {
                const scope = current.type === 'implicit_parameter' ? parent : scopeOf(current);
                facts.push({ node: current, scope: snapshot(scope) });
            } else if (parent && UNMODELED_DESIGNATION.test(parent.type)) {
                // A same-name token in a pattern shape this lookup does not
                // model may declare a local: every reference of the member
                // is then undecided (fix #419).
                facts.push({ node: current, scope: null });
            }
            return;
        }
        for (const child of current.namedChildren || []) visit(child);
    };
    // Name lookup needs only this member's occurrences of the identifier.
    // The AST still decides the token's role and scope; nested types keep
    // their own bindings, just as in the member walk above.
    const source = memberNode.text;
    for (let at = name ? source.indexOf(name) : -1; at >= 0; at = source.indexOf(name, at + name.length)) {
        let token = memberNode.descendantForIndex(memberNode.startIndex + at,
            memberNode.startIndex + at + name.length);
        if (token?.parent?.type === 'implicit_parameter' && token.parent.text === name) token = token.parent;
        if (!token || !['identifier', 'implicit_parameter'].includes(token.type) || token.text !== name) continue;
        let nestedType = false;
        for (let parent = token.parent; parent && !sameNode(parent, memberNode); parent = parent.parent) {
            if (TYPE_SCOPES.has(parent.type)) { nestedType = true; break; }
        }
        if (!nestedType) visit(token);
    }
    bindings.set(cacheKey, facts);
    return bindingVerdict(facts, node);
}

// Designation nodes: a token directly under one is either a modelled
// declaration or an undecided one. (A name directly under a subpattern is
// a member key or a constant, never a declaration.)
const UNMODELED_DESIGNATION = /_designation$/;

const TYPE_SCOPES = new Set(['class_declaration', 'struct_declaration', 'record_declaration',
    'record_struct_declaration', 'interface_declaration']);
const NON_VALUE_PARENTS = new Set(['using_directive', 'qualified_name', 'alias_qualified_name',
    'generic_name', 'type_argument_list', 'type_parameter', 'type_parameter_list', 'type_parameter_constraints_clause',
    'attribute', 'name_equals', 'name_colon', 'argument_name', 'labeled_statement', 'goto_statement']);
const VALUE_PARENTS = new Set(['binary_expression', 'return_statement', 'arrow_expression_clause', 'argument',
    'assignment_expression', 'initializer_expression', 'parenthesized_expression', 'conditional_expression',
    'prefix_unary_expression', 'postfix_unary_expression', 'checked_expression', 'unchecked_expression',
    'throw_expression', 'await_expression', 'interpolation', 'interpolation_alignment_clause',
    'expression_statement', 'yield_statement', 'equals_value_clause', 'variable_declarator',
    'anonymous_object_creation_expression', 'invocation_expression', 'member_access_expression',
    'conditional_access_expression', 'element_access_expression', 'select_clause', 'where_clause',
    'order_by_clause', 'group_clause', 'when_clause', 'switch_expression_arm',
    'from_clause', 'let_clause', 'join_clause', 'foreach_statement', 'lambda_expression']);

const usingScopesByTree = new WeakMap();
// A conditional can wrap an otherwise ordinary file-scoped namespace.
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

/** The physical namespace bodies that supply this token's local usings. */
function usingScopesOf(node) {
    if (!node?.tree) return [];
    let state = usingScopesByTree.get(node.tree);
    if (!state) { state = { nodes: new Map() }; usingScopesByTree.set(node.tree, state); }
    const namespaces = [];
    const types = [];
    let scopes = [];
    for (let current = node; current; current = current.parent) {
        if (state.nodes.has(current.id)) { scopes = state.nodes.get(current.id); break; }
        if (TYPE_SCOPES.has(current.type)) types.push(current);
        if (current.type === 'namespace_declaration') namespaces.push(current);
        if (current.type === 'compilation_unit') {
            if (!Object.hasOwn(state, 'fileScoped')) {
                const decl = fileScopedNamespace(current);
                state.fileScoped = decl ? { namespace: decl.childForFieldName('name')?.text || '',
                    startIndex: decl.startIndex, endIndex: current.endIndex } : null;
            }
            if (state.fileScoped && node.startIndex >= state.fileScoped.startIndex) scopes = [state.fileScoped];
            break;
        }
    }
    for (const declaration of namespaces.reverse()) {
        const name = declaration.childForFieldName('name')?.text;
        if (!name) continue;
        const outer = scopes.at(-1)?.namespace;
        scopes = [...scopes, { namespace: outer ? outer + '.' + name : name,
            startIndex: declaration.startIndex, endIndex: declaration.endIndex }];
        state.nodes.set(declaration.id, scopes);
    }
    for (const type of types) state.nodes.set(type.id, scopes);
    return scopes;
}

function namespaceOf(node) {
    return usingScopesOf(node).at(-1)?.namespace || '';
}

const typeScopesByTree = new WeakMap();
function typeScope(node) {
    let scopes = typeScopesByTree.get(node.tree);
    if (!scopes) { scopes = new Map(); typeScopesByTree.set(node.tree, scopes); }
    if (scopes.has(node.id)) return scopes.get(node.id);
    const name = node.childForFieldName('name');
    if (!name) return null;
    const parents = [];
    for (let p = node.parent; p; p = p.parent) {
        if (TYPE_SCOPES.has(p.type)) parents.unshift(p.childForFieldName('name')?.text || '');
    }
    const list = node.namedChildren.find(child => child.type === 'type_parameter_list');
    const scope = { name: name.text, line: name.startPosition.row + 1,
        namespace: namespaceOf(node), enclosingType: parents.join('.'),
        typeArity: list?.namedChildren.filter(child => child.type === 'type_parameter').length || 0 };
    scopes.set(node.id, scope);
    return scope;
}

/** Written named type at a construction, kept as AST facts for core lookup. */
function namedType(node, site) {
    let current = node;
    if (current?.type === 'nullable_type') current = current.namedChild(0);
    if (!current) return null;
    let qualifier = null;
    if (current.type === 'qualified_name') {
        qualifier = current.childForFieldName('qualifier');
        current = current.childForFieldName('name');
    } else if (current.type === 'alias_qualified_name') {
        qualifier = current.childForFieldName('alias');
        current = current.childForFieldName('name');
    }
    if (qualifier?.type === 'generic_name' || qualifier?.descendantsOfType('generic_name').length) return null;
    if (current?.type === 'generic_name') current = current.namedChild(0);
    if (current?.type !== 'identifier' || ['var', 'dynamic'].includes(current.text)) return null;
    if (!qualifier) {
        for (let scope = node.parent; scope; scope = scope.parent) {
            const parameters = scope.namedChildren.find(child => child.type === 'type_parameter_list');
            if (parameters?.namedChildren.some(parameter =>
                parameter.childForFieldName('name')?.text === current.text || parameter.text === current.text)) return null;
        }
    }
    return { name: current.text, node: current, text: node.text, qualifier,
        qualifierText: qualifier?.text || null, namespace: namespaceOf(site) };
}

function rangeBindingToken(node) {
    const parent = node.parent;
    if (!parent) return false;
    if (parent.type === 'query_expression' && node.previousSibling?.type === 'into') return true;
    if (parent.type === 'join_into_clause') return sameNode(parent.namedChild(0), node);
    if (parent.type === 'join_clause') {
        const type = parent.childForFieldName('type');
        return sameNode(parent.namedChildren.find(child => !sameNode(child, type)), node);
    }
    if (parent.type === 'tuple_pattern') {
        for (let owner = parent.parent; owner; owner = owner.parent) {
            if (owner.type === 'foreach_statement') {
                const left = owner.childForFieldName('left');
                return left && left.startIndex <= node.startIndex && node.endIndex <= left.endIndex;
            }
        }
    }
    return false;
}

function declaresToken(node) {
    const parent = node.parent;
    if (!parent) return false;
    if (rangeBindingToken(node)) return true;
    if (sameNode(parent.childForFieldName('type'), node) ||
        sameNode(parent.childForFieldName('returns'), node)) return true;
    if (sameNode(parent.childForFieldName('name'), node) &&
        (parent.type.endsWith('_declaration') || CSHARP_LOCAL_DECLARATION_NODES.has(parent.type))) return true;
    return parent.type === 'implicit_parameter' || parent.type === 'single_variable_designation' ||
        (parent.type === 'foreach_statement' && sameNode(parent.childForFieldName('left'), node)) ||
        (parent.type === 'let_clause' && sameNode(parent.namedChild(0), node)) ||
        // Deconstruction designations declare locals (fix #419).
        !!deconstructionRoot(node);
}

// A primary-constructor parameter supplies instance initializers and base
// arguments. Inside ordinary member bodies, the member lookup comes first.
function primaryParameterInInitializer(node, type, name) {
    const list = type?.namedChildren.find(child => child.type === 'parameter_list');
    if (!list?.namedChildren.some(parameter => parameter.childForFieldName('name')?.text === name)) return false;
    for (let current = node; current?.parent && !sameNode(current.parent, type); current = current.parent) {
        const parent = current.parent;
        if (parent.type === 'base_list' || parent.type === 'primary_constructor_base_type') return true;
        if (parent.type === 'property_declaration' &&
            sameNode(parent.childForFieldName('value'), current) && current.type !== 'arrow_expression_clause') return true;
        if (parent.type === 'variable_declarator' && parent.parent?.parent?.type === 'field_declaration' &&
            !sameNode(parent.childForFieldName('name'), current)) return true;
    }
    return false;
}

// C# 14 makes a bare `field` in a property body a backing-field keyword.
// Earlier versions can bind the same AST identifier to an ordinary member.
function possibleBackingField(node) {
    if (node.text !== 'field') return false;
    let accessor = false;
    for (let current = node.parent; current; current = current.parent) {
        if (current.type === 'accessor_declaration') {
            accessor = ['get', 'set', 'init'].includes(current.childForFieldName('name')?.text);
        }
        if (current.type === 'property_declaration') {
            const value = current.childForFieldName('value');
            return accessor || (value?.type === 'arrow_expression_clause' &&
                value.startIndex <= node.startIndex && node.endIndex <= value.endIndex);
        }
        if (current.type === 'indexer_declaration' || TYPE_SCOPES.has(current.type)) return false;
    }
    return false;
}

/**
 * Property-bearing expression shapes whose syntax has no simple receiver.
 * The core resolves owners; this adapter reports only grammar and scopes.
 */
function accessorReferenceShape(tree, usage, implicitCreationTarget) {
    if (!tree || !Number.isInteger(usage.column)) return null;
    const node = tree.rootNode.descendantForPosition({ row: usage.line - 1, column: usage.column });
    if (!node || node.type !== 'identifier') return null;
    const parent = node.parent;
    if (!parent) return 'none';
    if (parent.type === 'name_equals' || parent.type === 'attribute_argument' && node.nextSibling?.type === '=' ||
        parent.type === 'assignment_expression' && sameNode(parent.childForFieldName('left'), node) &&
        parent.parent?.type === 'attribute_argument') {
        let owner = parent;
        while (owner && owner.type !== 'attribute' && !TYPE_SCOPES.has(owner.type)) owner = owner.parent;
        // An attribute's named field/property belongs to the attribute,
        // never to the class carrying it. Its abbreviated type name and
        // constructor binding need a separate ownership proof.
        if (owner?.type === 'attribute') return { kind: 'unresolved', node, uncertainRole: true };
    }
    let pattern = parent;
    while (pattern?.type === 'member_access_expression') pattern = pattern.parent;
    if (pattern?.type === 'subpattern' && pattern.children.some(child => child.type === ':')) {
        return { kind: 'pattern', accessKind: 'read', node };
    }
    if (parent.type === 'member_access_expression' && sameNode(parent.childForFieldName('name'), node)) {
        return { kind: 'member', node };
    }
    if (parent.type === 'assignment_expression' && sameNode(parent.childForFieldName('left'), node) &&
        parent.parent?.type === 'initializer_expression') {
        const holder = parent.parent.parent;
        const type = holder?.type === 'object_creation_expression' ? holder.childForFieldName('type')
            : holder?.type === 'implicit_object_creation_expression' ? implicitCreationTarget(holder) : null;
        const value = parent.childForFieldName('right');
        return { kind: 'initializer', node, type: namedType(type, node),
            accessKind: value?.type === 'initializer_expression' ? 'read' : 'write' };
    }
    if (parent.type === 'with_initializer' && node.nextSibling?.type === '=') {
        return { kind: 'initializer', node, type: null, accessKind: 'write' };
    }
    if (parent.type === 'subpattern' && node.nextSibling?.type === ':') {
        return { kind: 'pattern', node, accessKind: 'read' };
    }
    if (NON_VALUE_PARENTS.has(parent.type) || declaresToken(node)) return 'none';
    if (possibleBackingField(node)) return { kind: 'unresolved', node, uncertainRole: true };
    // Unknown member syntax carries no implicit-receiver evidence. In
    // particular, a conditional member name cannot bind a local or `value`.
    if (!VALUE_PARENTS.has(parent.type)) return { kind: 'unresolved', node, uncertainRole: true };
    const types = [];
    let member = null;
    for (let current = parent; current; current = current.parent) {
        if (TYPE_SCOPES.has(current.type)) types.push(current);
        else if (types.length === 0 && current.parent?.type === 'declaration_list') member = current;
        // Setter/init and event accessor parameters are implicit in the AST.
        if (current.type === 'accessor_declaration' && node.text === 'value' &&
            ['set', 'init', 'add', 'remove'].includes(current.childForFieldName('name')?.text)) return 'none';
    }
    if (types.length === 0 && node.text === 'args') return 'none';
    const local = csharpLocalBinding(member || (types.length === 0 ? tree.rootNode : parent), node, node.text);
    if (local === 'local' || primaryParameterInInitializer(node, types[0], node.text)) return 'none';
    const projection = parent.type === 'anonymous_object_creation_expression';
    if (projection && node.nextSibling?.type === '=') return 'none';
    const scopes = types.map(typeScope).filter(Boolean);
    return { kind: 'implicit', scopes, node, namespace: scopes[0]?.namespace ?? namespaceOf(node),
        uncertainRole: local === 'unknown' || parent.type === 'member_access_expression',
        inferredName: projection };
}

module.exports = { csharpLocalBinding, accessorReferenceShape, namedType, usingScopesOf, fileScopedNamespace, deconstructionRoot };
