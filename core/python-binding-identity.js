'use strict';

// Resolve only identities written in Python syntax. Multiple writes, parameters,
// conditional bindings and unknown expressions have no proven identity.
const { referenceScopeNode, pythonScopeBindingKinds } = require('../languages/lexical-scope');
const { sameNode } = require('../languages/utils');
const BUILTINS = new Set(['object', 'property', 'classmethod', 'staticmethod',
    'getattr', 'setattr', 'hasattr', 'delattr', 'eval', 'exec', 'globals', 'locals', 'vars', '__import__']);
const UNBOUND_BUILTINS = new Set(['object', 'property', 'classmethod', 'staticmethod']);
const EFFECTS = new WeakMap();
const SPELLINGS = new WeakMap();
const OP_NORMALIZED_NAMES = new WeakMap();
const OP_NAMESPACE_EFFECTS = new WeakMap();
const SEQUENCES = new Set(['tuple_pattern', 'list_pattern', 'pattern_list', 'tuple', 'list', 'expression_list']);
const TARGET_WRAPPERS = new Set([...SEQUENCES, 'parenthesized_expression', 'list_splat_pattern', 'as_pattern_target']);
const LOCAL_NAMESPACE = '<local-namespace>';
const UNKNOWN_NAMESPACE = '<unknown-namespace>';
const NAMESPACE_ATTRIBUTES = new Set(['__dict__', '__self__', '__globals__', '__builtins__']);
const STANDARD_NAMESPACES = new Set(['builtins', 'typing']);
const NAMESPACE_READS = new Set(['get', 'keys', 'values', 'items', 'copy', '__getitem__', '__contains__', '__iter__', '__len__']);
const UNKNOWN_ORIGIN = '<unresolved-origin>';
const POSSIBLE_RUNTIME_APIS = [...BUILTINS].map(name => `builtins.${name}`).concat([
    'unittest.mock.patch', 'unittest.mock.patch.object', 'pytest.MonkeyPatch.instance.setattr',
    'setuptools.setup', 'distutils.core.setup',
]);

// Python normalizes identifiers, not string values. Keep original spellings
// on declarations/handles; use normalized identity only at this boundary.
const pythonSourceName = name => String(name || '').normalize('NFKC');

function sourceSpellings(tree, name) {
    let spellings = SPELLINGS.get(tree);
    if (!spellings) {
        spellings = new Map();
        for (const node of tree.rootNode.descendantsOfType('identifier')) {
            const normalized = pythonSourceName(node.text);
            if (normalized === node.text) continue;
            if (!spellings.has(normalized)) spellings.set(normalized, new Set([normalized]));
            spellings.get(normalized).add(node.text);
        }
        SPELLINGS.set(tree, spellings);
    }
    return spellings.get(pythonSourceName(name)) || [name];
}

/** Only source identifiers enter this capability inventory, never strings. */
function pythonNormalizedNames(index) {
    const operation = index._opTreeCache;
    if (operation && OP_NORMALIZED_NAMES.has(operation)) return OP_NORMALIZED_NAMES.get(operation);
    const names = new Set();
    const { langTraits } = require('../languages');
    for (const [file, entry] of index.files) {
        if (!langTraits(entry.language)?.reflectionApi?.pythonBindingIdentity) continue;
        let source, tree;
        try {
            source = index._readFile(file);
            // This is only a parse precheck. Runtime strings are never added.
            if (source.normalize('NFKC') === source) continue;
            tree = index._getParsedTree(file, source, entry.language);
        } catch { continue; }
        if (!tree) continue;
        for (const identifier of tree.rootNode.descendantsOfType('identifier')) {
            const normalized = pythonSourceName(identifier.text);
            if (normalized !== identifier.text) names.add(normalized);
        }
    }
    if (operation) OP_NORMALIZED_NAMES.set(operation, names);
    return names;
}

/** Explicit project source can mutate otherwise-known standard identities. */
function projectNamespaceEffects(index) {
    const operation = index._opTreeCache;
    if (operation && OP_NAMESPACE_EFFECTS.has(operation)) return OP_NAMESPACE_EFFECTS.get(operation);
    const affected = new Set();
    const { langTraits } = require('../languages');
    for (const [file, entry] of index.files) {
        // The sole consumer treats '*' as affecting every identity. Later
        // files cannot change that answer; this inventory is operation-local.
        if (affected.has('*')) break;
        if (!langTraits(entry.language)?.reflectionApi?.pythonBindingIdentity) continue;
        let source, tree;
        try {
            source = index._readFile(file);
            // A text precheck only. Identities/effects come from the AST.
            if (!/\b(?:builtins|typing|__builtins__|__dict__|__self__|__globals__|__import__|import_module|getattr|vars|globals)\b/.test(source.normalize('NFKC'))) continue;
            tree = index._getParsedTree(file, source, entry.language);
        } catch { affected.add('*'); continue; }
        if (!tree) { affected.add('*'); continue; }
        const node = tree.rootNode;
        const effects = effectsOf(node);
        const memo = new Map();
        for (const effect of namespaceEffects(node, memo)) {
            if (effect.owner === UNKNOWN_NAMESPACE) affected.add('*');
            else if (STANDARD_NAMESPACES.has(effect.owner)) affected.add(`${effect.owner}.${effect.key ?? '*'}`);
        }
        for (const write of effects.writes) {
            if (write.type !== 'attribute') continue;
            for (const origin of resolveIdentity(write, memo, 0, true).origins) {
                if (origin.startsWith(UNKNOWN_ORIGIN)) affected.add('*');
                else if ([...STANDARD_NAMESPACES].some(namespace => origin.startsWith(`${namespace}.`))) affected.add(origin);
            }
        }
    }
    if (operation) OP_NAMESPACE_EFFECTS.set(operation, affected);
    return affected;
}

function pythonProjectIdentityAffected(index, identity) {
    const effects = projectNamespaceEffects(index);
    if (effects.has('*')) return true;
    const namespace = identity.split('.')[0];
    if (effects.has(`${namespace}.*`)) return true;
    if (identity.endsWith('.*')) return [...effects].some(effect => effect.startsWith(identity.slice(0, -1)));
    return effects.has(identity) || [...effects].some(effect => effect.startsWith(`${identity}.`));
}

function bindingSites(scope, name) {
    const found = [];
    for (const spelling of sourceSpellings(scope.tree, name)) {
        for (const binding of pythonScopeBindingKinds(scope, spelling)) {
            if (!found.some(other => sameNode(other.node, binding.node))) found.push(binding);
        }
    }
    return found.sort((a, b) => a.node.startIndex - b.node.startIndex);
}

function sourceScope(node, memo) {
    const candidates = [];
    for (const spelling of sourceSpellings(node.tree, node.text)) {
        const scope = referenceScopeNode(node, spelling, memo);
        if (!scope) return null;
        candidates.push(scope);
    }
    // A normalized spelling can bind in a nearer scope than the written one.
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (candidates.some(scope => sameNode(parent, scope))) return parent;
    }
    return null;
}

function deferredBoundary(node, scope) {
    let boundary = null;
    for (let child = node, parent = node.parent; parent && !sameNode(parent, scope); child = parent, parent = parent.parent) {
        if (['function_definition', 'lambda'].includes(parent.type) && sameNode(parent.childForFieldName('body'), child)) boundary = parent.startIndex;
        if (parent.type === 'generator_expression') boundary = parent.startIndex;
    }
    return boundary;
}
const deferredRead = (node, scope) => deferredBoundary(node, scope) !== null;

function inImport(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (['import_statement', 'import_from_statement'].includes(parent.type)) return true;
        if (['expression_statement', 'block', 'module'].includes(parent.type)) break;
    }
    return false;
}

/** Every assignable leaf, without confusing the receiver/key with a target. */
function writeTargets(target, out) {
    if (!target) return false;
    if (['identifier', 'attribute', 'subscript'].includes(target.type)) { out.push(target); return true; }
    if (!TARGET_WRAPPERS.has(target.type)) return false;
    let complete = true;
    for (const child of target.namedChildren) complete = writeTargets(child, out) && complete;
    return complete;
}

function effectsOf(node) {
    const tree = node.tree;
    if (EFFECTS.has(tree)) return EFFECTS.get(tree);
    const escaped = new Set();
    const escapedSites = new Map();
    for (const declaration of tree.rootNode.descendantsOfType(['global_statement', 'nonlocal_statement'])) {
        for (const name of declaration.namedChildren) if (name.type === 'identifier') {
            const identity = pythonSourceName(name.text);
            escaped.add(identity);
            if (!escapedSites.has(identity)) escapedSites.set(identity, []);
            escapedSites.get(identity).push(...bindingSites(declaration, name.text));
        }
    }
    const writes = [];
    let unknownWrites = false;
    for (const statement of tree.rootNode.descendantsOfType(['assignment', 'augmented_assignment', 'delete_statement',
        'for_statement', 'for_in_clause', 'as_pattern', 'named_expression'])) {
        const targets = statement.type === 'delete_statement' ? statement.namedChildren
            : [statement.childForFieldName(statement.type === 'as_pattern' ? 'alias'
                : statement.type === 'named_expression' ? 'name' : 'left')].filter(Boolean);
        for (const target of targets) if (!writeTargets(target, writes)) unknownWrites = true;
    }
    const wildcards = tree.rootNode.descendantsOfType('wildcard_import').map(imported => pythonSourceName(imported.parent.childForFieldName('module_name')?.text)).filter(Boolean);
    const identifiers = tree.rootNode.descendantsOfType('identifier');
    const moduleNames = new Set([...BUILTINS, '__builtins__']);
    for (const identifier of identifiers) {
        for (let parent = identifier.parent; parent; parent = parent.parent) {
            if (['import_statement', 'import_from_statement'].includes(parent.type)) {
                const origin = importedIdentity(identifier);
                if ([...STANDARD_NAMESPACES].some(namespace => origin === namespace || origin?.startsWith(`${namespace}.`))) moduleNames.add(pythonSourceName(identifier.text));
                break;
            }
            if (['expression_statement', 'block', 'module'].includes(parent.type)) break;
        }
    }
    const value = { escaped, escapedSites, writes, unknownWrites, identifiers, moduleNames, calls: tree.rootNode.descendantsOfType('call'),
        attributes: tree.rootNode.descendantsOfType('attribute'),
        wildcard: wildcards.length > 0, wildcards,
        namespaceWrites: new Map(), writtenOrigins: new Map() };
    EFFECTS.set(tree, value);
    return value;
}

function importedIdentity(site) {
    let part = site;
    while (part.parent && !['import_statement', 'import_from_statement'].includes(part.parent.type)) part = part.parent;
    const statement = part.parent;
    const imported = pythonSourceName(part.type === 'aliased_import' ? part.childForFieldName('name')?.text : part.text);
    if (!imported || !statement) return null;
    if (statement.type === 'import_from_statement') {
        const module = pythonSourceName(statement.childForFieldName('module_name')?.text);
        return module ? `${module}.${imported}` : null;
    }
    return part.type === 'aliased_import' ? imported : imported.split('.')[0];
}

const UNKNOWN = Object.freeze({ origins: [], certain: false });
const BUDGET_UNKNOWN = Object.freeze({ origins: [UNKNOWN_ORIGIN], certain: false });

function projectValue(pattern, expression, site) {
    while (expression?.type === 'assignment' || expression?.type === 'parenthesized_expression') {
        expression = expression.type === 'assignment' ? expression.childForFieldName('right') : expression.namedChild(0);
    }
    if (sameNode(pattern, site)) return expression;
    if (pattern.type === 'parenthesized_expression') return projectValue(pattern.namedChild(0), expression, site);
    if (!SEQUENCES.has(pattern.type) || !SEQUENCES.has(expression?.type)) return null;
    const children = pattern.namedChildren;
    const position = children.findIndex(child => child.startIndex <= site.startIndex && child.endIndex >= site.endIndex);
    const star = children.findIndex(child => ['list_splat', 'list_splat_pattern'].includes(child.type));
    if (position < 0 || position === star) return null;
    if (star < 0 && children.length !== expression.namedChildCount) return null;
    if (star >= 0 && expression.namedChildCount < children.length - 1) return null;
    const valuePosition = star >= 0 && position > star ? expression.namedChildCount - (children.length - position) : position;
    return projectValue(children[position], expression.namedChild(valuePosition), site);
}

/** One written assignment value, including fixed-size unpacking and chains. */
function bindingValue(site, before) {
    if (['default_parameter', 'typed_default_parameter'].includes(site.parent?.type)) {
        return site.parent.childForFieldName('value');
    }
    if (site.parent?.type === 'named_expression') {
        return site.parent.endIndex <= before ? site.parent.childForFieldName('value') : null;
    }
    let target = site;
    while (SEQUENCES.has(target.parent?.type) || target.parent?.type === 'parenthesized_expression') target = target.parent;
    const assignment = target.parent;
    if (assignment?.type !== 'assignment' || !sameNode(assignment.childForFieldName('left'), target) || assignment.endIndex > before) return null;
    return projectValue(target, assignment.childForFieldName('right'), site);
}

/** Iteration retains possible written values; it never proves a binding exact. */
function iterationValues(site) {
    let target = site;
    while (TARGET_WRAPPERS.has(target.parent?.type)) target = target.parent;
    const loop = target.parent;
    if (!['for_statement', 'for_in_clause'].includes(loop?.type) || !sameNode(loop.childForFieldName('left'), target)) return [];
    const values = [];
    const pending = [loop.childForFieldName('right')];
    const seen = new Set();
    const memo = new Map();
    let budget = 256;
    while (pending.length) {
        if (--budget < 0) { values.unresolved = true; break; }
        let iterable = pending.pop();
        if (!iterable) continue;
        while (iterable.type === 'parenthesized_expression') iterable = iterable.namedChild(0);
        if (seen.has(iterable.id)) continue;
        seen.add(iterable.id);
        if (['list', 'tuple', 'set'].includes(iterable.type)) {
            for (const value of iterable.namedChildren) {
                if (value.type === 'list_splat') pending.push(value.namedChild(0));
                else {
                    const projected = projectValue(target, value, site);
                    if (projected) values.push(projected);
                }
            }
        } else if (iterable.type === 'identifier') {
            const scope = sourceScope(iterable, memo);
            if (!scope) continue;
            const before = deferredRead(iterable, scope) ? Infinity : iterable.startIndex;
            for (const binding of bindingSites(scope, iterable.text)) {
                const value = bindingValue(binding.node, before);
                if (value) pending.push(value);
            }
        }
    }
    return values;
}

// Literal runtime names are not source identifiers. A bound/computed name that
// cannot be read here stays unknown; it cannot prove a namespace inaccessible.
function namespaceMember(node, depth = 0) {
    if (!node || depth > 8) return null;
    while (node.type === 'parenthesized_expression') node = node.namedChild(0);
    if (node.type === 'string') return require('./runtime-entrypoints').pythonStringLiteral(node);
    if (node.type === 'concatenated_string') {
        const parts = node.namedChildren.map(child => namespaceMember(child, depth + 1));
        return parts.every(part => part !== null) ? parts.join('') : null;
    }
    if (node.type === 'binary_operator' && node.childForFieldName('operator')?.text === '+') {
        const left = namespaceMember(node.childForFieldName('left'), depth + 1);
        const right = namespaceMember(node.childForFieldName('right'), depth + 1);
        return left !== null && right !== null ? left + right : null;
    }
    return null;
}

function namespaceAttributeOwners(receiver, member, memo, depth) {
    if (member === null) return [UNKNOWN_NAMESPACE];
    if (!NAMESPACE_ATTRIBUTES.has(member)) return [];
    if (member === '__builtins__') return ['builtins'];
    if (member === '__globals__') return [UNKNOWN_NAMESPACE];
    // Unknown bound receivers can be module objects. Losing the callable's
    // identity cannot prove that its explicit namespace carrier is inert.
    const origins = resolveIdentity(receiver, memo, depth + 1, true).origins.map(origin =>
        member === '__self__' ? origin.startsWith('builtins.') ? 'builtins' : UNKNOWN_ORIGIN : origin);
    return standardNamespaceOwners(origins);
}

function standardNamespaceOwners(origins) {
    // A qualified imported value names a binding, not the object returned by
    // its namespace carrier. Only established standard module identities can
    // retain their owner; every other explicit carrier remains unknown.
    return origins.length && origins.every(origin => STANDARD_NAMESPACES.has(origin)) ? origins : [UNKNOWN_NAMESPACE];
}

function readonlyNamespaceInput(expression, memo) {
    const argumentsNode = expression.parent;
    const call = argumentsNode?.parent;
    if (argumentsNode?.type !== 'argument_list' || call?.type !== 'call' ||
        !sameNode(argumentsNode.namedChild(0), expression)) return false;
    const fn = resolveIdentity(call.childForFieldName('function'), memo, 0, true);
    return fn.certain && fn.origins.length === 1 && ['builtins.getattr', 'builtins.vars'].includes(fn.origins[0]);
}

/** Possible namespace mappings, separate from callable/builtin identity proof. */
function namespaceOwners(expression, memo, depth = 0) {
    let node = expression;
    if (!node) return [];
    if (depth > 8) return [UNKNOWN_NAMESPACE];
    while (node.type === 'parenthesized_expression') node = node.namedChild(0);
    if (node.type === 'attribute' && NAMESPACE_ATTRIBUTES.has(pythonSourceName(node.childForFieldName('attribute')?.text))) {
        const member = pythonSourceName(node.childForFieldName('attribute')?.text);
        return namespaceAttributeOwners(node.childForFieldName('object'), member, memo, depth);
    }
    if (node.type === 'call') {
        const fn = resolveIdentity(node.childForFieldName('function'), memo, depth + 1, true).origins;
        const args = node.childForFieldName('arguments')?.namedChildren || [];
        if (fn.some(origin => origin.startsWith(UNKNOWN_ORIGIN))) return [UNKNOWN_NAMESPACE];
        if (fn.includes('builtins.getattr') && args.length >= 2) {
            return namespaceAttributeOwners(args[0], namespaceMember(args[1]), memo, depth);
        }
        if (fn.some(origin => ['builtins.__import__', 'importlib.import_module'].includes(origin))) {
            const origins = resolveIdentity(node, memo, depth + 1, true).origins;
            return origins.includes('builtins') ? ['builtins'] : origins.some(origin => origin.startsWith(UNKNOWN_ORIGIN)) ? [UNKNOWN_NAMESPACE] : [];
        }
        if (!args.length && fn.some(origin => ['builtins.globals', 'builtins.locals', 'builtins.vars'].includes(origin))) return [LOCAL_NAMESPACE];
        if (args.length === 1 && fn.includes('builtins.vars')) {
            const origins = resolveIdentity(args[0], memo, depth + 1, true).origins;
            return standardNamespaceOwners(origins);
        }
    }
    if (node.type === 'identifier') {
        if (pythonSourceName(node.text) === '__builtins__' && resolveIdentity(node, memo, depth + 1, true).origins.includes('builtins')) return ['builtins'];
        const scope = sourceScope(node, memo);
        const key = scope && `identity-sites:${scope.startIndex}:${scope.endIndex}:${pythonSourceName(node.text)}`;
        let bindings = key && memo.get(key);
        if (key && !bindings) { bindings = bindingSites(scope, node.text); memo.set(key, bindings); }
        const sites = bindings ? bindings.map(binding => binding.node)
            : effectsOf(node).writes.filter(target => target.type === 'identifier' && pythonSourceName(target.text) === pythonSourceName(node.text));
        const importedDictionaries = (bindings || []).filter(binding => binding.kind === 'import')
            .map(binding => importedIdentity(binding.node)).filter(origin => origin?.endsWith('.__dict__')).map(origin => origin.slice(0, -9));
        const before = scope && deferredRead(node, scope) ? Infinity : node.startIndex;
        return [...new Set([...importedDictionaries, ...sites.flatMap(site => {
            const value = bindingValue(site, before);
            const values = value ? [value] : iterationValues(site);
            return values.unresolved ? [UNKNOWN_NAMESPACE] : values.flatMap(candidate => namespaceOwners(candidate, memo, depth + 1));
        })])];
    }
    if (['conditional_expression', 'boolean_operator'].includes(node.type)) {
        const arms = node.type === 'boolean_operator' ? [node.childForFieldName('left'), node.childForFieldName('right')]
            : [node.namedChild(0), node.namedChild(node.namedChildCount - 1)];
        return [...new Set(arms.flatMap(arm => namespaceOwners(arm, memo, depth + 1)))];
    }
    return [];
}

/** Unknown operations on an exposed namespace cannot preserve an exemption. */
function namespaceEffects(node, memo) {
    const effects = effectsOf(node);
    if (effects.namespaceEffects) return effects.namespaceEffects;
    const mutations = [];
    // A module object is itself its writable namespace. Capture exposure at
    // the known import/builtin value, before aliases or containers hide it.
    // Builtin function values can carry that module through __self__ too.
    for (const expression of [...effects.identifiers, ...effects.attributes, ...effects.calls]) {
        let root = expression;
        while (root?.type === 'attribute' || root?.type === 'parenthesized_expression') {
            root = root.type === 'attribute' ? root.childForFieldName('object') : root.namedChild(0);
        }
        if (expression.type !== 'call' && (root?.type !== 'identifier' || !effects.moduleNames.has(pythonSourceName(root.text)))) continue;
        if (inImport(expression)) continue;
        const origins = resolveIdentity(expression, memo, 0, true).origins;
        const modules = origins.filter(origin => STANDARD_NAMESPACES.has(origin));
        const boundFunction = origins.some(origin => origin.startsWith('builtins.') && origin !== 'builtins.__dict__' &&
            !UNBOUND_BUILTINS.has(origin.slice(9)));
        if (!modules.length && !boundFunction) continue;
        let value = expression;
        while (value.parent?.type === 'parenthesized_expression') value = value.parent;
        const parent = value.parent;
        if (parent?.type === 'attribute' && sameNode(parent.childForFieldName('object'), value)) continue;
        if (!modules.length && parent?.type === 'call' && sameNode(parent.childForFieldName('function'), value)) continue;
        if (modules.length && readonlyNamespaceInput(value, memo)) continue;
        for (const owner of modules.length ? modules : ['builtins']) mutations.push({ owner, key: null });
    }
    // Record exposure where the namespace is created, before a container,
    // spread or deferred alias can hide it. Only a direct read-only operation
    // on a known builtin/local dictionary proves the mapping unexposed.
    for (const producer of [...effects.calls, ...effects.attributes,
        ...effects.identifiers.filter(identifier => effects.moduleNames.has(pythonSourceName(identifier.text)))]) {
        if (inImport(producer)) continue;
        if (producer.type === 'attribute' && !NAMESPACE_ATTRIBUTES.has(pythonSourceName(producer.childForFieldName('attribute')?.text))) continue;
        const owners = namespaceOwners(producer, memo);
        if (!owners.length) continue;
        let expression = producer;
        while (expression.parent?.type === 'parenthesized_expression') expression = expression.parent;
        const parent = expression.parent;
        const readonly = parent?.type === 'attribute' && sameNode(parent.childForFieldName('object'), expression) &&
            NAMESPACE_READS.has(pythonSourceName(parent.childForFieldName('attribute')?.text)) &&
            parent.parent?.type === 'call' && sameNode(parent.parent.childForFieldName('function'), parent) &&
            owners.every(owner => owner === LOCAL_NAMESPACE || STANDARD_NAMESPACES.has(owner));
        if (!readonly) for (const owner of owners) mutations.push({ owner, key: null });
    }
    for (const write of effects.writes) if (write.type === 'subscript') {
        const keyNode = write.childForFieldName('subscript');
        // A bound key may itself need namespace-effect checking. Keeping it
        // unknown here avoids circular proof and conservatively revokes it.
        const key = keyNode?.type === 'string' ? require('./runtime-entrypoints').pythonStringLiteral(keyNode) : null;
        for (const owner of namespaceOwners(write.childForFieldName('value'), memo)) mutations.push({ owner, key });
    }
    // A method value can be called through an alias. Only known read-only dict
    // operations retain exactness; every other operation may write any key.
    for (const attribute of effects.attributes) {
        if (NAMESPACE_READS.has(pythonSourceName(attribute.childForFieldName('attribute')?.text))) continue;
        for (const owner of namespaceOwners(attribute.childForFieldName('object'), memo)) mutations.push({ owner, key: null });
    }
    // Passing the mapping to unknown code exposes it to writes, even when the
    // call's implementation is not read. This does not execute that code.
    for (const call of effects.calls) for (const argument of call.childForFieldName('arguments')?.namedChildren || []) {
        const value = argument.type === 'keyword_argument' ? argument.childForFieldName('value') : argument;
        for (const owner of namespaceOwners(value, memo)) mutations.push({ owner, key: null });
    }
    effects.namespaceEffects = mutations;
    return mutations;
}

function namespaceWritten(node, memo) {
    const effects = effectsOf(node);
    const name = pythonSourceName(node.text);
    let written = effects.namespaceWrites.get(name);
    if (written !== undefined) return written;
    written = namespaceEffects(node, memo).some(effect => [LOCAL_NAMESPACE, UNKNOWN_NAMESPACE].includes(effect.owner) &&
        (effect.key == null || effect.key === name));
    effects.namespaceWrites.set(name, written);
    return written;
}

/** Possible origins survive uncertainty; only a single unwritten origin is an exemption. */
function resolveIdentity(expression, memo, depth = 0, ignoreEffects = false) {
    let node = expression;
    if (!node) return UNKNOWN;
    if (depth > 8) return BUDGET_UNKNOWN;
    while (node.type === 'parenthesized_expression') node = node.namedChild(0);
    let result;
    if (['named_expression', 'assignment'].includes(node.type)) {
        result = resolveIdentity(node.childForFieldName(node.type === 'assignment' ? 'right' : 'value'), memo, depth + 1, ignoreEffects);
    } else if (['conditional_expression', 'boolean_operator'].includes(node.type)) {
        // The condition is not a candidate value. Both value arms remain
        // possible without interpreting truthiness or executing the program.
        const arms = node.type === 'boolean_operator'
            ? [node.childForFieldName('left'), node.childForFieldName('right')]
            : [node.namedChild(0), node.namedChild(node.namedChildCount - 1)];
        result = { origins: [...new Set(arms.flatMap(arm => resolveIdentity(arm, memo, depth + 1, ignoreEffects).origins))], certain: false };
    } else if (node.type === 'attribute') {
        const owner = resolveIdentity(node.childForFieldName('object'), memo, depth + 1, ignoreEffects);
        const member = pythonSourceName(node.childForFieldName('attribute')?.text);
        result = member ? { origins: owner.origins.map(origin => member === '__self__' && origin.startsWith('builtins.')
            ? 'builtins' : `${origin}.${member}`), certain: owner.certain && member !== '__self__' } : UNKNOWN;
    } else if (node.type === 'call') {
        const called = resolveIdentity(node.childForFieldName('function'), memo, depth + 1, ignoreEffects);
        const argument = node.childForFieldName('arguments')?.namedChild(0);
        const importsModule = called.origins.some(origin => ['builtins.__import__', 'importlib.import_module'].includes(origin));
        const moduleName = argument?.type === 'string' ? require('./runtime-entrypoints').pythonStringLiteral(argument) : null;
        result = { origins: called.origins.flatMap(origin => origin.startsWith(UNKNOWN_ORIGIN) ? [UNKNOWN_ORIGIN]
            : ['pytest.MonkeyPatch', 'pytest.MonkeyPatch.context'].includes(origin) ? ['pytest.MonkeyPatch.instance'] : []), certain: called.certain };
        if (importsModule && (moduleName === 'builtins' || moduleName == null)) result = {
            origins: [...result.origins, moduleName === 'builtins' ? 'builtins' : UNKNOWN_ORIGIN], certain: false,
        };
    } else if (node.type === 'identifier') {
        const name = pythonSourceName(node.text);
        let scope = sourceScope(node, memo);
        const effects = effectsOf(node);
        // global/nonlocal prevent exact lexical proof, but the original import
        // or stable alias is still a possible reflective origin.
        if (!scope && effects.escaped.has(name)) {
            for (let parent = node.parent; parent; parent = parent.parent) {
                if (!['function_definition', 'module'].includes(parent.type)) continue;
                if (parent.type === 'function_definition' && parent.descendantsOfType('global_statement')
                    .some(statement => statement.namedChildren.some(identifier => pythonSourceName(identifier.text) === name))) {
                    scope = node.tree.rootNode; break;
                }
                if (bindingSites(parent, node.text).length) { scope = parent; break; }
                if (parent.type === 'module') scope = parent;
            }
        }
        if (!scope) return UNKNOWN;
        const deferred = deferredRead(node, scope);
        const key = `identity-sites:${scope.startIndex}:${scope.endIndex}:${name}`;
        let sites = memo.get(key);
        if (!sites) { sites = bindingSites(scope, node.text); memo.set(key, sites); }
        // The right side reads the old value, before this assignment binds.
        // This also applies to an unpacking target and to a walrus expression.
        sites = sites.filter(binding => {
            let assignment = binding.node.parent;
            while (assignment && (SEQUENCES.has(assignment.type) || assignment.type === 'parenthesized_expression')) assignment = assignment.parent;
            const value = assignment?.type === 'assignment' ? assignment.childForFieldName('right')
                : assignment?.type === 'named_expression' ? assignment.childForFieldName('value') : null;
            return !value || node.startIndex < value.startIndex || node.endIndex > value.endIndex;
        });
        if (effects.escaped.has(name)) {
            const combined = [...sites, ...(effects.escapedSites.get(name) || [])];
            sites = combined.filter((binding, position) => combined.findIndex(other => sameNode(other.node, binding.node)) === position);
        } else if (sites.length > 1) {
            // An unconditional write before the enclosing function was even
            // created replaces earlier values. Writes after its creation are
            // still possible when the deferred body eventually executes.
            const limit = deferred ? deferredBoundary(node, scope) : node.startIndex;
            let lastCertain = -1;
            for (let position = 0; position < sites.length; position++) {
                const binding = sites[position];
                let unconditional = binding.node.startIndex < limit;
                for (let parent = binding.node.parent; parent && !sameNode(parent, scope); parent = parent.parent) {
                    if (['if_statement', 'for_statement', 'while_statement', 'try_statement', 'match_statement'].includes(parent.type)) unconditional = false;
                }
                if (unconditional) lastCertain = position;
            }
            if (lastCertain >= 0) sites = sites.slice(lastCertain);
        }
        if (sites.length === 0) result = { origins: [...new Set([
            ...(BUILTINS.has(name) ? [`builtins.${name}`] : []),
            ...(name === '__builtins__' ? ['builtins'] : []),
            ...effects.wildcards.map(module => `${module}.${name}`),
        ])], certain: !effects.wildcard && name !== '__builtins__' };
        else {
            let certain = sites.length === 1 && !deferred;
            const origins = [];
            for (const binding of sites) {
                const site = binding.node;
                for (let parent = site.parent; parent && !sameNode(parent, scope); parent = parent.parent) {
                    if (['if_statement', 'for_statement', 'while_statement', 'try_statement', 'match_statement'].includes(parent.type)) certain = false;
                }
                if (binding.kind === 'import') {
                    const imported = importedIdentity(site);
                    if (imported) origins.push(imported); else certain = false;
                    continue;
                }
                const parent = site.parent;
                let value = bindingValue(site, deferred ? Infinity : node.startIndex);
                if (['default_parameter', 'typed_default_parameter'].includes(parent?.type)) certain = false;
                if (parent?.type === 'as_pattern_target' && parent.parent?.type === 'as_pattern') value = parent.parent.namedChild(0);
                else if (parent?.type === 'as_pattern') value = parent.namedChild(0);
                const iterated = value ? [] : iterationValues(site);
                const resolved = value ? resolveIdentity(value, memo, depth + 1, ignoreEffects)
                    : { origins: iterated.unresolved ? [UNKNOWN_ORIGIN]
                        : [...new Set(iterated.flatMap(candidate => resolveIdentity(candidate, memo, depth + 1, ignoreEffects).origins))], certain: false };
                origins.push(...resolved.origins);
                certain &&= resolved.certain;
            }
            result = { origins: [...new Set(origins)], certain };
        }
        if (!ignoreEffects) {
            if (effects.unknownWrites || effects.escaped.has(name) || effects.wildcard || namespaceWritten(node, memo)) result = { ...result, certain: false };
        }
    } else return UNKNOWN;
    if (!ignoreEffects && result.certain && result.origins.length) {
        const effects = effectsOf(node);
        const effectKey = result.origins.join('\0');
        let written = effects.writtenOrigins.get(effectKey);
        if (written === undefined) written = effects.unknownWrites || effects.writes.some(write => {
            if (write.type === 'attribute') return resolveIdentity(write, memo, 0, true).origins
                .some(origin => origin.startsWith(UNKNOWN_ORIGIN) || result.origins.includes(origin));
            return false;
        }) || namespaceEffects(node, memo).some(effect => effect.owner === UNKNOWN_NAMESPACE || (effect.owner !== LOCAL_NAMESPACE &&
            result.origins.some(origin => effect.key == null ? origin.startsWith(`${effect.owner}.`) : origin === `${effect.owner}.${effect.key}`))) || effects.calls.some(call => {
            const fn = resolveIdentity(call.childForFieldName('function'), memo, 0, true);
            if (!fn.origins.some(origin => origin === 'builtins.setattr' || origin === 'builtins.delattr')) return false;
            const args = call.childForFieldName('arguments')?.namedChildren || [];
            const owner = resolveIdentity(args[0], memo, 0, true);
            const member = require('./runtime-entrypoints').pythonStringLiteral(args[1]);
            return owner.origins.some(origin => member ? result.origins.includes(`${origin}.${member}`)
                : result.origins.some(candidate => candidate.startsWith(`${origin}.`)));
        });
        effects.writtenOrigins.set(effectKey, written);
        if (written) result = { ...result, certain: false };
    }
    return result;
}

function pythonIdentity(expression, memo = new Map(), depth = 0) {
    const resolved = resolveIdentity(expression, memo, depth);
    return resolved.certain && resolved.origins.length === 1 ? resolved.origins[0] : null;
}

function pythonPossibleIdentities(expression, memo = new Map()) {
    // This reader consumes only possible origins. Namespace effects can
    // revoke certainty, but cannot erase an origin; exact identity and
    // registration readers still evaluate those effects independently.
    const origins = resolveIdentity(expression, memo, 0, true).origins;
    // Exhaustion means an unresolved runtime API, never absence of runtime
    // use. This conservative vocabulary is consumed only by liveness readers;
    // it cannot grant an exact identity or a confirmed call edge.
    return origins.some(origin => origin.startsWith(UNKNOWN_ORIGIN))
        ? [...new Set([...origins.filter(origin => !origin.startsWith(UNKNOWN_ORIGIN)), ...POSSIBLE_RUNTIME_APIS])]
        : origins;
}

/** Written nesting is retained on saved declarations for runtime module paths. */
function pythonRuntimeOwners(declaration) {
    const names = [];
    for (let parent = declaration.parent; parent; parent = parent.parent) {
        if (parent.type === 'class_definition') {
            const name = parent.childForFieldName('name')?.text;
            if (name) names.push(name);
        }
    }
    return names.reverse();
}

function pythonBoundValue(node, depth = 0) {
    if (!node || depth > 8 || node.type !== 'identifier') return node;
    const scope = sourceScope(node);
    if (!scope) return null;
    const effects = effectsOf(node);
    if (effects.unknownWrites || effects.escaped.has(pythonSourceName(node.text)) || effects.wildcard || deferredRead(node, scope) || namespaceWritten(node, new Map())) return null;
    const sites = bindingSites(scope, node.text);
    if (sites.length !== 1) return null;
    const site = sites[0].node;
    const assignment = site.parent;
    if (assignment?.type !== 'assignment' || !sameNode(assignment.childForFieldName('left'), site) ||
        assignment.endIndex > node.startIndex) return null;
    for (let parent = assignment.parent; parent && !sameNode(parent, scope); parent = parent.parent) {
        if (['if_statement', 'for_statement', 'while_statement', 'try_statement', 'match_statement'].includes(parent.type)) return null;
    }
    const value = pythonBoundValue(assignment.childForFieldName('right'), depth + 1);
    if (['dictionary', 'list', 'set'].includes(value?.type) &&
        scope.descendantsOfType('identifier').some(reference => pythonSourceName(reference.text) === pythonSourceName(node.text) &&
            !sameNode(reference, node) && !sameNode(reference, site))) return null;
    return value;
}

function registrationUnknown(declaration) {
    const decorated = declaration?.parent;
    if (decorated?.type !== 'decorated_definition') return false;
    const memo = new Map();
    const descriptors = new Set(['builtins.property', 'builtins.classmethod', 'builtins.staticmethod']);
    const accessors = new Set(['getter', 'setter', 'deleter']);
    const propertyBefore = (owner, here) => {
        owner = pythonSourceName(owner);
        let property = false;
        for (const statement of here.parent?.namedChildren || []) {
            if (statement.startIndex >= here.startIndex) break;
            const definition = statement.type === 'decorated_definition'
                ? statement.namedChildren.find(n => n.type === 'function_definition') : statement;
            if (definition?.type === 'function_definition' && pythonSourceName(definition.childForFieldName('name')?.text) === owner) {
                const decorators = statement.type === 'decorated_definition'
                    ? statement.namedChildren.filter(n => n.type === 'decorator').map(n => n.namedChild(0)) : [];
                property = decorators.length === 1 && (pythonIdentity(decorators[0], memo) === 'builtins.property' ||
                    (property && decorators[0]?.type === 'attribute' && pythonSourceName(decorators[0].childForFieldName('object')?.text) === owner &&
                        accessors.has(pythonSourceName(decorators[0].childForFieldName('attribute')?.text))));
            } else if (statement.descendantsOfType('identifier').some(n => pythonSourceName(n.text) === owner)) {
                // A write, callback, or opaque statement may replace the descriptor.
                property = false;
            }
        }
        return property;
    };
    return decorated.namedChildren.filter(node => node.type === 'decorator').some(decorator => {
        const expression = decorator.namedChild(0);
        if (descriptors.has(pythonIdentity(expression, memo))) return false;
        if (expression?.type !== 'attribute' || !accessors.has(pythonSourceName(expression.childForFieldName('attribute')?.text))) return true;
        const owner = expression.childForFieldName('object');
        return owner?.type !== 'identifier' || !propertyBefore(owner.text, decorated);
    });
}

module.exports = { pythonIdentity, pythonPossibleIdentities, pythonRuntimeOwners, pythonBoundValue,
    pythonSourceName, pythonNormalizedNames, pythonProjectIdentityAffected, registrationUnknown };
